import type { DocumentFact } from './types';
import { normalizeOcrFactText } from './factsModel';
import { stringifyFactValue } from './utils';

export type FactValueType = 'duration' | 'money' | 'location' | 'organization' | 'standard' | 'identifier' | 'scale' | 'text';

export interface FieldSpec {
  key: string;
  label: string;
  aliases: string[];
  valueType: FactValueType;
}

export interface FactCandidate {
  fieldKey: string;
  label: string;
  value: string;
  sourceType: 'structured_fact' | 'generated_markdown' | 'evidence' | 'unknown';
  sourceName?: string;
  confidence: number;
  rejected: boolean;
  reasons: string[];
}

export interface CanonicalFact {
  fieldKey: string;
  label: string;
  value: string;
  source: string;
  confidence: number;
  candidates: FactCandidate[];
  selectedReason: string;
}

export const PROJECT_BASIC_FIELD_SPECS: FieldSpec[] = [
  { key: 'project_name', label: '项目名称', aliases: ['项目名称', '工程名称', '招标项目名称'], valueType: 'text' },
  { key: 'project_code', label: '项目编号', aliases: ['项目编号', '招标项目编号', '工程编号'], valueType: 'identifier' },
  { key: 'owner', label: '招标人', aliases: ['招标人', '项目业主', '建设单位', '发包人', '采购人'], valueType: 'organization' },
  { key: 'project_location', label: '建设地点', aliases: ['建设地点', '实施地点', '服务地点', '交付地点'], valueType: 'location' },
  { key: 'project_scale', label: '建设规模', aliases: ['建设规模', '工程规模', '项目规模'], valueType: 'scale' },
  { key: 'schedule_requirement', label: '计划工期', aliases: ['计划工期', '合同工期', '总工期', '工期', '实施周期', '服务期限'], valueType: 'duration' },
  { key: 'quality_standard', label: '质量标准', aliases: ['质量标准', '质量目标', '验收标准', '服务标准'], valueType: 'standard' },
  { key: 'project_investment_estimate', label: '合同估算价', aliases: ['合同估算价', '合同估算价格', '投资估算', '估算价格', '最高投标限价', '招标控制价', '预算金额'], valueType: 'money' },
];

function isReferenceOnly(value: string) {
  return /^(见|详见|参见|按|以).{0,30}(招标公告|招标文件|投标人须知|前附表|合同|附件|图纸|清单|约定|规定|执行)/u.test(value) || /见招标公告|见投标人须知前附表|详见|按.*执行/u.test(value);
}

function hasClauseNoise(value: string) {
  return /###|投标文件的编制|备选投标方案|投标将被否决|投标人提供|投标有效期|电子交易系统|公共资源交易监督管理部门|中标候选|评标委员会|实质性内容作出响应|招标人有权核查/u.test(value);
}

function containsOtherField(value: string, spec: FieldSpec) {
  return PROJECT_BASIC_FIELD_SPECS.some(item => item.key !== spec.key && item.aliases.some(alias => value.includes(alias)));
}

function valueTypeScore(value: string, spec: FieldSpec) {
  switch (spec.valueType) {
    case 'duration':
      if (!/\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年)/u.test(value)) return { rejected: true, score: -80, reason: '缺少明确工期数值和时间单位' };
      return { rejected: false, score: 45, reason: '包含明确工期数值和时间单位' };
    case 'money':
      if (!/\d+(?:\.\d+)?\s*(?:万元|元|亿元)/u.test(value)) return { rejected: true, score: -80, reason: '缺少明确金额数值和单位' };
      if (/综合单价|税率|增值税|利润|报价明细/u.test(value)) return { rejected: true, score: -90, reason: '命中非目标商务明细' };
      return { rejected: false, score: 45, reason: '包含明确金额数值和单位' };
    case 'standard':
      if (!/合格|优良|一次性验收|达到|满足|符合/u.test(value)) return { rejected: true, score: -70, reason: '不符合标准类字段表达' };
      if (/工期|投标|技术标准|有效期/u.test(value)) return { rejected: true, score: -90, reason: '标准字段包含其他字段或投标条款' };
      return { rejected: false, score: 40, reason: '符合标准类字段表达' };
    case 'location':
      if (isReferenceOnly(value)) return { rejected: false, score: -40, reason: '引用型地点弱值' };
      if (!/(省|市|区|县|镇|街道|路|园区|大道|巷|内|号)/u.test(value)) return { rejected: false, score: -10, reason: '地点具体性不足' };
      return { rejected: false, score: 35, reason: '包含具体地址特征' };
    case 'organization':
      if (/监督管理部门|投标人|中标候选人|评标委员会/u.test(value)) return { rejected: true, score: -90, reason: '组织字段角色串位' };
      if (/(公司|集团|单位|委员会|机关|中心|局|院|所|政府|运营管理)/u.test(value)) return { rejected: false, score: 35, reason: '包含组织名称特征' };
      return { rejected: false, score: 5, reason: '组织名称特征较弱' };
    case 'identifier':
      if (!/^[A-Za-z0-9\-_.（）()]+$/u.test(value)) return { rejected: true, score: -70, reason: '编号格式不合法' };
      return { rejected: false, score: 35, reason: '符合编号格式' };
    case 'scale':
      if (/\d+(?:\.\d+)?\s*(?:㎡|平方米|m²|米|m|层|栋|座|万元|元)/iu.test(value)) return { rejected: false, score: 30, reason: '包含规模数值或单位' };
      return { rejected: false, score: 5, reason: '规模字段为文本描述' };
    default:
      return { rejected: false, score: value.length >= 2 ? 10 : -20, reason: '文本字段' };
  }
}

export function scoreFactCandidate(candidate: Omit<FactCandidate, 'confidence' | 'rejected' | 'reasons'>, spec: FieldSpec): FactCandidate {
  const value = normalizeOcrFactText(candidate.value);
  const reasons: string[] = [];
  let confidence = 30;
  let rejected = false;
  if (!value || value.length > 260) {
    rejected = true;
    confidence -= 100;
    reasons.push('空值或过长');
  }
  if (hasClauseNoise(value)) {
    rejected = true;
    confidence -= 100;
    reasons.push('大段条款或 Markdown 噪声');
  }
  if (containsOtherField(value, spec)) {
    confidence -= 45;
    reasons.push('包含其他字段名，疑似字段串位');
  }
  if (isReferenceOnly(value)) {
    confidence -= 35;
    reasons.push('引用型弱值');
  }
  const typeScore = valueTypeScore(value, spec);
  confidence += typeScore.score;
  reasons.push(typeScore.reason);
  if (typeScore.rejected) rejected = true;
  if (candidate.sourceType === 'evidence') {
    confidence += 20;
    reasons.push('来源为证据原文');
  }
  if (candidate.sourceName && /招标文件|招标公告|前附表|合同|需求书|正文/u.test(candidate.sourceName)) {
    confidence += 15;
    reasons.push('来源文件可信');
  }
  if (candidate.sourceType === 'generated_markdown') confidence -= 10;
  return { ...candidate, value, confidence, rejected, reasons };
}

export function fieldSpecForFact(fact: DocumentFact) {
  const text = `${fact.fieldId || ''}${fact.key || ''}${fact.fieldName || ''}`;
  return PROJECT_BASIC_FIELD_SPECS.find(spec => spec.key === fact.fieldId || spec.aliases.some(alias => text.includes(alias)));
}

export function collectStructuredFactCandidates(facts: DocumentFact[]) {
  const candidates: FactCandidate[] = [];
  for (const fact of facts) {
    const spec = fieldSpecForFact(fact);
    if (!spec) continue;
    const value = stringifyFactValue(fact.value);
    candidates.push(scoreFactCandidate({
      fieldKey: spec.key,
      label: spec.label,
      value,
      sourceType: 'structured_fact',
      sourceName: fact.sourceFile || fact.sourceRef?.sectionTitle || 'structured_fact',
    }, spec));
  }
  return candidates;
}

export function collectMarkdownTableCandidates(markdown: string, sourceName = 'generated_markdown') {
  const candidates: FactCandidate[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    if (!/^\|.*\|\s*$/u.test(line) || /^\|\s*:?-{3,}:?/u.test(line)) continue;
    const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.replace(/\*\*/gu, '').trim());
    if (cells.length < 2) continue;
    const label = cells[0] === '序号' && cells.length >= 3 ? cells[1] : cells[0];
    const value = cells[0] === '序号' && cells.length >= 3 ? cells[2] : cells[1];
    const rowSource = cells[0] === '序号' && cells.length >= 4 ? cells[3] : cells[2];
    const spec = PROJECT_BASIC_FIELD_SPECS.find(item => item.aliases.some(alias => label.includes(alias)) || item.label === label);
    if (!spec || !value || /内容|参数|资料未明确|系统暂未确认|暂未从知识库确认/u.test(value)) continue;
    candidates.push(scoreFactCandidate({
      fieldKey: spec.key,
      label: spec.label,
      value,
      sourceType: 'generated_markdown',
      sourceName: rowSource || sourceName,
    }, spec));
  }
  return candidates;
}

export function resolveCanonicalFacts(candidates: FactCandidate[], specs = PROJECT_BASIC_FIELD_SPECS) {
  const result = new Map<string, CanonicalFact>();
  for (const spec of specs) {
    const fieldCandidates = candidates.filter(item => item.fieldKey === spec.key).sort((a, b) => b.confidence - a.confidence);
    const selected = fieldCandidates.find(item => !item.rejected && item.confidence > 0);
    if (!selected) continue;
    result.set(spec.key, {
      fieldKey: spec.key,
      label: spec.label,
      value: selected.value,
      source: selected.sourceName || selected.sourceType,
      confidence: selected.confidence,
      candidates: fieldCandidates,
      selectedReason: selected.reasons.join('；'),
    });
  }
  return result;
}

export function buildCanonicalFacts(input: { facts: DocumentFact[]; markdown?: string }) {
  return resolveCanonicalFacts([
    ...collectStructuredFactCandidates(input.facts),
    ...collectMarkdownTableCandidates(input.markdown || ''),
  ]);
}
