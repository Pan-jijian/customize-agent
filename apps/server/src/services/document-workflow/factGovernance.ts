import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanonicalFact as GovernedCanonicalFact, CanonicalFactModel, DocumentFact, NumericScopeConflict, ProjectGraph } from './types';
import { cleanPdfHeadingNoise, normalizeOcrFactText } from './factsModel';
import { stableHash, stringifyFactValue } from './utils';
import { recordArbitrationCases } from './workflowCaseLog';
import { loadWorkflowRules, workflowRulesHash, type WorkflowRulesConfig } from './workflowRules';

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
      // 工期违约/处罚条款不是计划工期口径（历史缺陷：计划工期行被填“工期延误56天以上发包人可切除剩余工程量”）
      if (/延误|逾期|违约|赔偿|罚款|处罚|扣除|扣留|切除/u.test(value)) return { rejected: true, score: -90, reason: '命中工期违约条款而非计划工期' };
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
      if (/(?:㎡|m²|m2|m3|m³|平方米|米|万元|元|日历天|个月)/u.test(value)) return { rejected: true, score: -60, reason: '编号中混入量纲单位，疑似字段串位' };
      return { rejected: false, score: 35, reason: '符合编号格式' };
    case 'scale':
      if (/\d+(?:\.\d+)?\s*(?:㎡|平方米|m²|米|m|层|栋|座|万元|元)/iu.test(value)) return { rejected: false, score: 30, reason: '包含规模数值或单位' };
      return { rejected: false, score: 5, reason: '规模字段为文本描述' };
    default:
      if (spec.key === 'project_name') {
        if (/存在部位|风险等级|管控措施|监测频次|闭环要求|序号|内容|范围|不适用/u.test(value)) return { rejected: true, score: -90, reason: '项目名称字段串位或表头噪声' };
        if (!/项目|工程|学院|宿舍|楼|校区|施工总承包/u.test(value)) return { rejected: true, score: -70, reason: '项目名称缺少工程名称特征' };
        return { rejected: false, score: 35, reason: '符合项目名称特征' };
      }
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
  // 补疑/答疑/澄清/更正/修改类文件是招标文件的正式修正，权威最高，压过“招标文件正文”加成
  if (candidate.sourceName && /补疑|答疑|澄清|补充|更正|修改/u.test(candidate.sourceName)) {
    confidence += 35;
    reasons.push('补疑/澄清类修正文件，权威最高');
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

function factSourceType(fact: DocumentFact): GovernedCanonicalFact['sourceType'] {
  const source = `${fact.sourceFile || ''} ${fact.sourceRef?.sectionTitle || ''} ${fact.roleId || ''}`;
  // 补疑/答疑/澄清/更正/修改类文件是对招标文件的正式修正，权威高于招标文件本身
  if (/补疑|答疑|澄清|补充|更正|修改/u.test(source)) return 'addendum';
  if (/合同/u.test(source)) return 'contract';
  if (/招标|公告|前附表|需求书/u.test(source)) return 'tender';
  if (/清单|工程量|BOQ|报价/u.test(source)) return 'boq';
  if (/图纸|设计|CAD|DWG/u.test(source)) return 'drawing';
  if (/规范|标准/u.test(source)) return 'standard';
  return 'structured_fact';
}

function factPriority(sourceType: GovernedCanonicalFact['sourceType']) {
  const priorities: Record<GovernedCanonicalFact['sourceType'], number> = {
    user: 100,
    addendum: 96,
    contract: 90,
    tender: 85,
    boq: 75,
    drawing: 70,
    standard: 60,
    evidence: 55,
    structured_fact: 50,
    projectGraph: 40,
    generated_markdown: 30,
    derived: 20,
    unknown: 10,
  };
  return priorities[sourceType];
}

function governedFactFromCanonical(fact: CanonicalFact): GovernedCanonicalFact {
  const sourceType = fact.source.includes('generated_markdown') ? 'generated_markdown' : fact.source.includes('evidence') ? 'evidence' : 'structured_fact';
  return {
    key: fact.fieldKey,
    label: fact.label,
    value: fact.value,
    normalizedValue: normalizeOcrFactText(fact.value),
    sourceType,
    sourceFile: fact.source,
    confidence: fact.confidence,
    priority: factPriority(sourceType),
    locked: factPriority(sourceType) >= 80,
    selectedReason: fact.selectedReason,
  };
}

function governedFactFromDocumentFact(fact: DocumentFact, key: string, label: string): GovernedCanonicalFact {
  const value = stringifyFactValue(fact.value);
  const sourceType = factSourceType(fact);
  return {
    key,
    label,
    value,
    normalizedValue: normalizeOcrFactText(value),
    sourceType,
    sourceFile: fact.sourceFile,
    sourceRef: fact.sourceRef?.sectionTitle,
    confidence: Math.round((fact.confidence || 0.5) * 100),
    priority: factPriority(sourceType),
    locked: factPriority(sourceType) >= 80,
    selectedReason: '按资料来源优先级和字段置信度决策',
  };
}

function pickFactsByPattern(facts: DocumentFact[], key: string, label: string, pattern: RegExp, valueType?: FactValueType) {
  const spec = PROJECT_BASIC_FIELD_SPECS.find(item => item.key === key);
  return facts
    .filter(fact => pattern.test(`${fact.fieldId || ''}${fact.key || ''}${fact.fieldName || ''}`))
    .map(fact => governedFactFromDocumentFact(fact, key, label))
    .filter(fact => fact.value && !/资料未明确|系统暂未确认/u.test(fact.value))
    // 字段形态校验：与字段值类型不符的候选（编号串位成面积值、金额缺单位等）直接排除，
    // 避免解析错位值进入事实主表（历史缺陷：项目编号字段混入带量纲的错位值）
    .filter(fact => {
      const type = valueType ?? spec?.valueType;
      if (!type || type === 'text') return true;
      return !valueTypeScore(fact.value, { key, label, aliases: [], valueType: type }).rejected;
    })
    .sort((a, b) => b.priority - a.priority || b.confidence - a.confidence || a.value.length - b.value.length);
}

function chooseFact(candidates: GovernedCanonicalFact[]) {
  return candidates[0];
}

function conflictsFor(key: string, label: string, candidates: GovernedCanonicalFact[]) {
  const values = [...new Map(candidates.map(fact => [fact.normalizedValue, fact])).values()];
  if (values.length <= 1) return undefined;
  const topPriority = Math.max(...values.map(fact => fact.priority));
  const topValues = values.filter(fact => fact.priority === topPriority);
  return {
    key,
    label,
    values: values.map(fact => ({ value: fact.value, sourceFile: fact.sourceFile, priority: fact.priority, confidence: fact.confidence })),
    decision: topValues.length === 1 ? 'highest_priority_selected' as const : 'manual_review_required' as const,
  };
}

function graphFacts(graph?: ProjectGraph): GovernedCanonicalFact[] {
  if (!graph) return [];
  const resources = (graph.resources || []).map(resource => ({
    key: `resource_${resource.type}_${resource.name}`,
    label: resource.type === 'equipment' ? '机械设备' : resource.type === 'labor' ? '劳动力' : '材料资源',
    value: [resource.name, resource.spec, resource.quantity, resource.unit].filter(Boolean).join(' '),
    normalizedValue: normalizeOcrFactText([resource.name, resource.spec, resource.quantity, resource.unit].filter(Boolean).join(' ')),
    sourceType: 'projectGraph' as const,
    sourceFile: resource.sourceFiles?.[0],
    confidence: 55,
    priority: factPriority('projectGraph'),
    locked: false,
    selectedReason: '来自项目图谱资源节点',
  })).filter(fact => fact.value);
  const risks = (graph.risks || []).map(risk => ({
    key: `risk_${risk.risk}`,
    label: '风险源',
    value: [risk.risk, risk.level, risk.mitigation].filter(Boolean).join(' '),
    normalizedValue: normalizeOcrFactText([risk.risk, risk.level, risk.mitigation].filter(Boolean).join(' ')),
    sourceType: 'projectGraph' as const,
    sourceFile: risk.sourceFiles?.[0],
    confidence: 55,
    priority: factPriority('projectGraph'),
    locked: false,
    selectedReason: '来自项目图谱风险节点',
  })).filter(fact => fact.value);
  return [...resources, ...risks];
}

function factCacheRoot(projectRoot?: string) {
  const root = path.join(process.env.HOME || process.cwd(), '.customize-agent', 'cache', 'document-workflow', stableHash(projectRoot || 'default'));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function canonicalFactCacheKey(input: { facts: DocumentFact[]; markdown?: string; projectGraph?: ProjectGraph; requiredKeys?: string[]; requirement?: string; templateId?: string; projectRoot?: string }) {
  return stableHash({
    // v7：area 裁决池异口径隔离（“建设规模：项目总占地面积约10970…”中的占地数值
    // 不再作为建筑总量裁决候选，round-21 S6 反向改错根治），旧缓存按旧裁决口径产出，
    // 不再适用；
    // v6：建设规模混合口径净化（占地+建筑混合字段值只保留建筑面积段，round-21 S6），
    // 旧缓存按旧口径产出（scale 值含占地面积段），不再适用；
    // v5：数值语境四分类裁决（门槛型/目标型剔除、锚点评分决胜、置信度分级、层数/车位数新口径），
    // 旧缓存按旧裁决口径产出，不再适用；
    // rulesHash：workflowRules 配置哈希并入缓存键（F3），项目级规则覆盖变化自动失效旧裁决缓存，无需手动 bump
    version: 'canonical-facts-v7',
    rulesHash: workflowRulesHash(input.projectRoot),
    requirement: input.requirement || '',
    templateId: input.templateId || '',
    requiredKeys: input.requiredKeys || [],
    facts: input.facts.map(fact => ({ key: fact.key, fieldId: fact.fieldId, fieldName: fact.fieldName, value: fact.value, sourceFile: fact.sourceFile, roleId: fact.roleId, confidence: fact.confidence })).sort((a, b) => `${a.sourceFile}${a.key}${a.value}`.localeCompare(`${b.sourceFile}${b.key}${b.value}`)),
    graphHash: input.projectGraph ? stableHash(input.projectGraph) : '',
    markdownHash: input.markdown ? stableHash(input.markdown.slice(0, 20000)) : '',
  });
}

function readCachedCanonicalFacts(projectRoot: string | undefined, key: string): CanonicalFactModel | undefined {
  const root = factCacheRoot(projectRoot);
  if (!root) return undefined;
  try {
    const cached = JSON.parse(fs.readFileSync(path.join(root, `canonical-facts-${key}.json`), 'utf8')) as CanonicalFactModel;
    // 结构完整性校验：旧版本缓存缺少 scopeConflicts 字段时弃用，避免陈旧裁决复用
    return cached && cached.byKey && Array.isArray(cached.scopeConflicts) ? cached : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedCanonicalFacts(projectRoot: string | undefined, key: string, facts: CanonicalFactModel) {
  const root = factCacheRoot(projectRoot);
  if (!root) return;
  fs.writeFileSync(path.join(root, `canonical-facts-${key}.json`), JSON.stringify(facts, null, 2));
}

// ===== 源级同口径数值冲突裁决 =====
// 不同资料文件对同一总量口径（建设规模/估算价/工期/层数/车位数）给出不同数值时，生成前必须先裁决出统一口径，
// 否则正文会混写两个数值（历史缺陷：招标文件正文 4645㎡ 与补疑/清单 4646㎡ 同时进入事实主表）

// ===== 数值语境四分类（结构锚定 + 语义角色判别，取代纯词表枚举）=====
// 同一口径数值在不同语境中承担不同语义角色，不能一律参与裁决：
// - ontological 本体口径：资料对项目总量口径的直接表述，裁决池的主体；
// - amendment 修正型：补疑/答疑/澄清类文件中的正式修正表述（修正为/调整为/变更为），裁决最高可信；
// - aspirational 目标型：拟/规划/目标等愿景表述，不是确定口径，不参与裁决；
// - threshold 门槛型：不低于/不少于/不超过等资格或约束限定表述，描述的是门槛而非项目真实数值，
//   绝不能作为裁决候选覆盖本体口径（历史缺陷：补疑资格条款“项目经理业绩要求：建筑面积不低于19000㎡”
//   污染招标正文“建筑规模20000㎡”）。

export type NumericContextClass = 'ontological' | 'amendment' | 'aspirational' | 'threshold';

// 语境分类正则编译缓存（词表源字符串来自 workflowRules 配置，编译一次复用）
const ruleReCache = new Map<string, RegExp>();
function ruleRe(source: string) {
  let re = ruleReCache.get(source);
  if (!re) { re = new RegExp(source, 'u'); ruleReCache.set(source, re); }
  return re;
}

/**
 * 数值语境分类：取「口径词前 10 字符 + 口径词后到数值之间的宽窗口」为判别语境。
 * “计划工期/合同工期”中的“计划/合同”属于口径词自身，不落入窗口，避免误判目标型；
 * “拟建设总建筑面积约5000㎡”的“拟建设”落在口径词前窗口 → 目标型；
 * “建筑面积不低于19000㎡”的“不低于”落在口径词后窗口 → 门槛型。
 * 四分类词表由 workflowRules 配置驱动（项目级可覆盖，与缓存哈希联动）。
 */
function classifyNumericContext(text: string, scopeStart: number, scopeLength: number, valueStart: number, sourceFile: string | undefined, rules: WorkflowRulesConfig): NumericContextClass {
  const before = text.slice(Math.max(0, scopeStart - 10), scopeStart);
  const gap = text.slice(scopeStart + scopeLength, valueStart);
  const context = `${before}${gap}`;
  const { addendumSource, amendmentContext, thresholdComparison, aspirationalPrefix } = rules.factGovernance;
  if (ruleRe(addendumSource).test(sourceFile || '') && ruleRe(amendmentContext).test(context)) return 'amendment';
  if (ruleRe(thresholdComparison).test(context)) return 'threshold';
  if (ruleRe(aspirationalPrefix).test(before)) return 'aspirational';
  return 'ontological';
}

/** 数值与口径词的锚定强度：距离越近、语义角色越实，锚定越强（同优先级时作为裁决决胜键） */
function anchorScoreFor(contextClass: NumericContextClass, gapLength: number) {
  const distance = gapLength <= 3 ? 3 : gapLength <= 9 ? 2 : 1;
  return distance + (contextClass === 'ontological' || contextClass === 'amendment' ? 2 : 1);
}

function scopeKindLabel(kind: NumericScopeConflict['kind']) {
  if (kind === 'area') return '面积';
  if (kind === 'cost') return '金额';
  if (kind === 'floors') return '层数';
  if (kind === 'parkingSpaces') return '车位数';
  return '工期';
}

/**
 * 总量口径词基础表（同源单点）：qualityValidation 的 SCALE_SCOPE_RE/COST_SCOPE_RE 是此表带子项口径
 * 黑名单（地上/地下/门卫室等分层口径排除）的增强版——改基础口径词时两侧必须同步。
 */
export function scopeReForKind(kind: NumericScopeConflict['kind']) {
  // “总”字可选：招标文件常写“建筑面积约为4645㎡”（无“总”字），必须与“总建筑面积”同口径检出；
  // 口径限定为建筑总量（建设规模/建筑面积）：用地面积、占地面积是独立字段（不同口径），
  // 混入裁决会让用地数值污染“建设规模”期望口径（历史缺陷：正文正确转述资料用地面积被判为与建设规模冲突）；
  // 子项口径负向后顾与 qualityValidation.SCALE_SCOPE_RE 同源：地上/地下建筑面积等分层数值
  // （如地上24783.39、地下3786.97）与建筑总量不同口径，混入“建筑面积”裁决组会导致无法决出裁决值
  if (kind === 'area') return /(?<![地上地下门卫室值班室配电室配电房泵房水泵房锅炉房公厕车库车棚岗亭传达室警卫室样板房售楼处门房])总?建筑面积|建设规模/u;
  if (kind === 'cost') return /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价|工程总投资|总投资|工程造价/u;
  if (kind === 'floors') return /总?层数|建筑层数|地上层数|地下层数|楼层数/u;
  if (kind === 'parkingSpaces') return /总?车位|停车位|机动车位|车位数/u;
  return /计划工期|合同工期|总工期|施工周期/u;
}

/** 总量口径单位基础表（与 scopeReForKind 同源单点，qualityValidation 的 SCALE_UNIT_RE/COST_UNIT_RE 同源） */
export function unitReForKind(kind: NumericScopeConflict['kind']) {
  if (kind === 'area') return '(万?㎡|万?m²|万?m2|万?平方米)';
  if (kind === 'cost') return '(万元|亿元|万?元)';
  if (kind === 'floors') return '(层)';
  if (kind === 'parkingSpaces') return '(个|个车位|个停车位)';
  return '(日历天|天|个月|月)';
}

interface NumericScopeEntry {
  scope: string;
  value: string;
  unit: string;
  compareKey: string;
  contextClass: NumericContextClass;
  anchorScore: number;
  gapLength: number;
}

function extractNumericScopeEntries(text: string, kind: NumericScopeConflict['kind'], sourceFile: string | undefined, rules: WorkflowRulesConfig) {
  const entries: NumericScopeEntry[] = [];
  const scopeRe = scopeReForKind(kind);
  // 层数/车位数允许个位数（如“地上层数6层”），面积/金额/工期保持两位以上降噪
  const numberRe = kind === 'floors' || kind === 'parkingSpaces' ? '\\d+(?:[.,]\\d+)?' : '\\d{2,}(?:[.,]\\d+)?';
  const pattern = new RegExp(`(?:${scopeRe.source})(?:[^0-9\\n]{0,14}?)(${numberRe})\\s*${unitReForKind(kind)}`, 'giu');
  const numberPattern = new RegExp(numberRe, 'u');
  for (const match of text.matchAll(pattern)) {
    const scopeMatch = match[0].match(scopeRe);
    const scope = scopeMatch?.[0] || '';
    const value = match[1].replace(/[,，]/gu, '').trim();
    const unit = (match[2] || '').trim();
    if (!scope || !value || !numberPattern.test(value)) continue;
    const scopeStart = (match.index ?? 0) + (scopeMatch?.index ?? 0);
    const valueStart = (match.index ?? 0) + match[0].indexOf(match[1]);
    const gapLength = valueStart - (scopeStart + scope.length);
    // 异口径词隔离（area 专用）：口径词与数值之间的窗口若出现“占地/用地”字样
    // （如“建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方米”），
    // 该数值属占地面积/用地面积独立口径，不得作为建筑总量裁决候选
    // （历史缺陷：10970 被裁决为 area 胜出值进入 scopeConflicts，确定性修复器
    // 以裁决值优先于 resolveScaleExpectation，把正文正确的 28570.36 反向改成 10970）
    const gapText = text.slice(scopeStart + scope.length, valueStart);
    if (kind === 'area' && /占地|用地/u.test(gapText)) continue;
    const contextClass = classifyNumericContext(text, scopeStart, scope.length, valueStart, sourceFile, rules);
    // 门槛型/目标型数值是约束或愿景语义，不是项目真实口径，剔除出裁决池（19000 事故根治：
    // “业绩要求：建筑面积不低于19000㎡”不再作为裁决候选覆盖招标正文“建筑规模20000㎡”）
    if (contextClass === 'threshold' || contextClass === 'aspirational') continue;
    let compareKey: string;
    if (kind === 'duration' || kind === 'floors' || kind === 'parkingSpaces') {
      // 工期天数与月数不可直接换算，层数/车位数无“万”进制，按“数值+单位”原样比对
      compareKey = `${value}|${unit}`;
    } else {
      // 面积/金额归一化到基准单位（㎡/元），使“3.5万㎡”与“35000㎡”、“500万元”与“5000000元”可等价比较
      const wan = /万/u.test(unit) ? 1 : 0;
      const base = Number(value) * (wan ? 10000 : 1);
      if (!Number.isFinite(base)) continue;
      const normalized = /亿元/u.test(unit) ? base * 100000000 : /万元/u.test(unit) ? base * 10000 : base;
      compareKey = String(normalized);
    }
    entries.push({ scope, value, unit, compareKey, contextClass, anchorScore: anchorScoreFor(contextClass, gapLength), gapLength });
  }
  return entries;
}

function sourceFilePriority(sourceFile?: string, roleId?: string) {
  const source = `${sourceFile || ''} ${roleId || ''}`;
  // 补疑/答疑/澄清/更正类文件是对招标文件的正式修正，裁决优先级最高
  if (/补疑|答疑|澄清|补充|更正|修改/u.test(source)) return 95;
  if (/合同/u.test(source)) return 90;
  if (/招标文件|招标公告|前附表|投标人须知|需求书/u.test(source)) return 85;
  if (/清单|工程量|BOQ|编制说明/u.test(source)) return 75;
  if (/图纸|设计/u.test(source)) return 70;
  return 50;
}

export function detectNumericScopeConflicts(facts: DocumentFact[], rules: WorkflowRulesConfig = loadWorkflowRules()): NumericScopeConflict[] {
  const conflicts: NumericScopeConflict[] = [];
  const kinds: NumericScopeConflict['kind'][] = ['area', 'cost', 'duration', 'floors', 'parkingSpaces'];
  for (const kind of kinds) {
    type Entry = NumericScopeEntry & { sourceFile?: string; priority: number };
    const seen = new Set<string>();
    const entries: Entry[] = [];
    for (const fact of facts) {
      const text = stringifyFactValue(fact.value);
      const priority = sourceFilePriority(fact.sourceFile, fact.roleId);
      for (const entry of extractNumericScopeEntries(text, kind, fact.sourceFile, rules)) {
        const key = `${fact.sourceFile || ''}|${entry.scope}|${entry.compareKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ ...entry, sourceFile: fact.sourceFile, priority });
      }
    }
    if (entries.length < 2) continue;
    // 按口径词分组：同一口径词下出现不同取值且来自不同文件 → 冲突；
    // 「总」字归一：招标文件常写“建筑面积约为4645㎡”（无“总”字），补疑写“总建筑面积约4646㎡”，
    // 同一总量口径只是“总”字有无差异，必须归入同组检出（历史缺陷：分组按原文词隔离导致跨文件漏检）
    const byScope = entries.reduce((map, entry) => {
      const scopeKey = entry.scope.replace(/^总/u, '');
      const list = map.get(scopeKey) || [];
      list.push(entry);
      map.set(scopeKey, list);
      return map;
    }, new Map<string, Entry[]>());
    for (const [scope, scoped] of byScope) {
      const distinctKeys = new Set(scoped.map(entry => entry.compareKey));
      if (distinctKeys.size < 2) continue;
      // 同文件内分层口径（总建筑面积 vs 总用地面积等）已被 scope 词隔离；跨文件不同数值才判冲突
      const distinctFiles = new Set(scoped.map(entry => entry.sourceFile).filter(Boolean));
      if (distinctFiles.size < 2) continue;
      const bestPriority = Math.max(...scoped.map(entry => entry.priority));
      const bestEntries = scoped.filter(entry => entry.priority === bestPriority);
      // 同优先级下按锚点评分决胜：数值与口径词距离越近、语义角色越实（本体/修正型），锚定越强
      const bestAnchor = Math.max(...bestEntries.map(entry => entry.anchorScore));
      const anchoredEntries = bestEntries.filter(entry => entry.anchorScore === bestAnchor);
      const anchoredKeys = new Set(anchoredEntries.map(entry => entry.compareKey));
      const winner = anchoredKeys.size === 1 ? anchoredEntries[0] : undefined;
      // 置信度分级：修正型语境明确胜出=high；本体口径胜出=medium；
      // 数值距口径词超过 9 字符属锚定弱（弱关联），降一级——low 不参与确定性改写，仅作人工复核提示
      let confidence: NumericScopeConflict['confidence'];
      if (winner) {
        const weaklyAnchored = winner.gapLength > rules.factGovernance.weakAnchorGapThreshold;
        confidence = winner.contextClass === 'amendment' ? (weaklyAnchored ? 'medium' : 'high') : (weaklyAnchored ? 'low' : 'medium');
      }
      conflicts.push({
        kind,
        scope: `${scope}（${scopeKindLabel(kind)}口径）`,
        values: [...new Map(scoped.map(entry => [`${entry.value}${entry.unit}|${entry.sourceFile || ''}`, { value: entry.value, unit: entry.unit, sourceFile: entry.sourceFile, priority: entry.priority }])).values()],
        resolution: winner ? `${winner.value}${winner.unit}` : undefined,
        ...(confidence ? { confidence } : {}),
      });
    }
  }
  return conflicts;
}

export function numericScopeResolutions(conflicts: NumericScopeConflict[]) {
  // 每个 kind 取第一条确定性裁决（resolution 唯一时才成立）；
  // low 置信度的裁决锚定弱、语境模糊，不参与证据/正文的确定性改写，避免用弱裁决覆盖可能正确的原文
  const resolutions = new Map<NumericScopeConflict['kind'], { winnerNum: string; losers: Array<{ value: string; unit: string }> }>();
  for (const conflict of conflicts) {
    if (!conflict.resolution || conflict.confidence === 'low' || resolutions.has(conflict.kind)) continue;
    const winner = conflict.values.find(value => `${value.value}${value.unit}` === conflict.resolution);
    const winnerNum = winner ? winner.value.replace(/[,，]/gu, '') : '';
    const losers = conflict.values
      .filter(value => `${value.value}${value.unit}` !== conflict.resolution)
      .map(value => ({ value: value.value.replace(/[,，]/gu, ''), unit: value.unit }));
    if (!winnerNum || losers.length === 0) continue;
    resolutions.set(conflict.kind, { winnerNum, losers });
  }
  return resolutions;
}

/**
 * 文本级裁决改写：把任意文本（证据原文切片、事实值、提示词片段）中的败选数值替换为裁决胜出值。
 * 裁决必须在数据进入写作模型之前完成——检索原文切片含旧值时，模型会照抄旧值，事后修复是亡羊补牢；
 * 与 applyScopeConflictResolutions 共用同一套裁决解析，保证主表改写与上下文改写口径一致。
 */
export function applyScopeOverridesToText(text: string, conflicts: NumericScopeConflict[]): string {
  let result = text;
  for (const { winnerNum, losers } of numericScopeResolutions(conflicts).values()) {
    for (const loser of losers) {
      if (loser.unit && result.includes(`${loser.value}${loser.unit}`)) {
        result = result.split(`${loser.value}${loser.unit}`).join(`${winnerNum}${loser.unit}`);
      } else if (result.includes(loser.value)) {
        result = result.split(loser.value).join(winnerNum);
      }
    }
  }
  return result;
}

/** 证据切片数组裁决改写（原地无变化时返回原对象引用，避免无谓扩散） */
export function governEvidenceValues<T extends { content: string }>(evidence: T[], conflicts: NumericScopeConflict[]): T[] {
  if (!conflicts?.length) return evidence;
  return evidence.map(item => {
    const content = applyScopeOverridesToText(item.content, conflicts);
    return content === item.content ? item : { ...item, content };
  });
}

/**
 * 渲染章节写作强制约束锚点：裁决结果必须逐章注入写作 roleContext（全局蓝图长文本中易被淹没），
 * 写作模型在生成每个章节时都直接看到「败选值禁止出现」的硬约束，而不是靠事后审查修复
 */
export function renderScopeOverrideAnchors(conflicts: NumericScopeConflict[]): string[] {
  const lines: string[] = [];
  for (const conflict of conflicts) {
    if (!conflict.resolution) continue;
    const losers = conflict.values.filter(value => `${value.value}${value.unit}` !== conflict.resolution);
    if (losers.length === 0) continue;
    const loserText = losers.map(loser => `${loser.value}${loser.unit}`).join('、');
    // 分级锚点措辞：置信度决定约束强度；low 只提示人工复核，不注入强制改写约束
    if (conflict.confidence === 'high') {
      lines.push(`${conflict.scope}必须统一为 ${conflict.resolution}（补疑/答疑/澄清类修正文件权威最高；${loserText} 已被修正，正文禁止出现）`);
    } else if (conflict.confidence === 'medium') {
      lines.push(`${conflict.scope}应统一为 ${conflict.resolution}（按资料来源优先级裁决；${loserText} 为败选值，正文避免使用）`);
    } else {
      lines.push(`${conflict.scope}参考口径为 ${conflict.resolution}（锚定较弱，请人工复核；${loserText} 不参与自动改写）`);
    }
  }
  return lines;
}

export function applyScopeConflictResolutions(facts: DocumentFact[], conflicts: NumericScopeConflict[]): DocumentFact[] {
  const resolutions = numericScopeResolutions(conflicts);
  if (resolutions.size === 0) return facts;
  const kindRe: Record<NumericScopeConflict['kind'], RegExp> = {
    area: /建设规模|工程规模|建筑面积|用地面积|占地面积|project_scale|scale/u,
    cost: /合同估算|投资估算|最高投标限价|招标控制价|总投资|工程造价|project_cost|cost|price|amount/u,
    duration: /计划工期|合同工期|总工期|施工周期|duration|schedule/u,
    floors: /总层数|建筑层数|地上层数|地下层数|楼层数|project_floors|floors/u,
    parkingSpaces: /总车位|停车位|机动车位|车位数|project_parking|parking/u,
  };
  return facts.map(fact => {
    const kind = ([...resolutions.keys()] as NumericScopeConflict['kind'][]).find(item => kindRe[item].test(fact.key) || kindRe[item].test(fact.value));
    if (!kind) return fact;
    const { winnerNum, losers } = resolutions.get(kind)!;
    let value = fact.value;
    let changed = false;
    // 数值级替换并保留败选事实原有单位：“4645㎡”→“4646㎡”、“4645平方米”→“4646平方米”，避免裁决后单位混写
    for (const loser of losers) {
      if (loser.unit && value.includes(`${loser.value}${loser.unit}`)) {
        value = value.split(`${loser.value}${loser.unit}`).join(`${winnerNum}${loser.unit}`);
        changed = true;
      } else if (value.includes(loser.value)) {
        value = value.split(loser.value).join(winnerNum);
        changed = true;
      }
    }
    return changed ? { ...fact, value } : fact;
  });
}

export function buildCanonicalFactModel(input: { facts: DocumentFact[]; markdown?: string; projectGraph?: ProjectGraph; requiredKeys?: string[]; projectRoot?: string; requirement?: string; templateId?: string }): CanonicalFactModel {
  const cacheKey = canonicalFactCacheKey(input);
  const cached = readCachedCanonicalFacts(input.projectRoot, cacheKey);
  if (cached) return cached;
  // 源头裁决：先检测跨文件同口径数值冲突，按补疑优先原则改写败选事实值，
  // 之后 canonical 选择、Writer 输入、校验基准全部只见裁决后的统一口径（补疑值），
  // 文档中从源头就不会出现败选数值（如 4645），无需任何生成后“清除”逻辑
  const rawFacts = input.facts || [];
  // 裁决规则按项目加载（支持项目级 workflow-rules.json 覆盖，覆盖变化经 rulesHash 自动失效缓存）
  const scopeConflicts = detectNumericScopeConflicts(rawFacts, loadWorkflowRules(input.projectRoot));
  // 裁决案例落盘（数据而非代码）：把本次裁决决策（含置信度与转人工标记）追加进案例库，
  // 供事后复盘口径演化；只追加、不参与生成决策，失败静默不影响主链路
  recordArbitrationCases(scopeConflicts.map(conflict => ({
    caseType: 'scope_conflict_arbitration',
    recordedAt: Date.now(),
    kind: conflict.kind,
    scope: conflict.scope,
    values: conflict.values.map(value => ({ value: value.value, unit: value.unit, sourceFile: value.sourceFile, priority: value.priority })),
    winner: conflict.resolution,
    confidence: conflict.confidence,
    manualReviewRequired: !conflict.resolution,
  })));
  const sourceFacts = applyScopeConflictResolutions(rawFacts, scopeConflicts);
  const canonicalMap = buildCanonicalFacts({ facts: sourceFacts, markdown: input.markdown });
  const byKey: Record<string, GovernedCanonicalFact> = {};
  for (const [key, fact] of canonicalMap.entries()) byKey[key] = governedFactFromCanonical(fact);
  // round-21 S6：建设规模混合口径净化——资料“建设规模：项目总占地面积约10970平方米，
  // 单体建筑面积28570.36平方米”是占地+建筑两个口径的混合字段值，canonical 直接沿用会
  // 让蓝图写作约束携带混合口径，写作模型混淆数值（实测正文 9 处“总建筑面积 10970㎡”）。
  // canonical 的 scale 只保留“建筑面积”段（建筑总量口径）；占地数值不进 scale 字段。
  if (byKey.project_scale) {
    const scale = byKey.project_scale;
    if (/占地|用地/u.test(scale.value) && /建筑面积/u.test(scale.value)) {
      const buildStart = scale.value.search(/(?:单体)?总?建筑面积/u);
      if (buildStart > 0) {
        // round-23 P0-3 兜底：上游提取层已清 PDF 标题标记噪声，此处再清洗一次防
        // LLM 提取通道残留坏值（历史缺陷：“28570.36平方###米”→“28570.36平方2.8”）
        const buildValue = cleanPdfHeadingNoise(scale.value.slice(buildStart)).trim();
        byKey.project_scale = {
          ...scale,
          value: buildValue,
          normalizedValue: normalizeOcrFactText(buildValue),
          selectedReason: `${scale.selectedReason}；混合口径已净化，scale 只取建筑面积段`,
        };
      }
    }
  }

  const fieldPatterns: Array<{ key: string; label: string; pattern: RegExp; bucket: keyof CanonicalFactModel; valueType?: FactValueType }> = [
    { key: 'project_name', label: '项目名称', pattern: /项目名称|工程名称|招标项目名称|project_name/u, bucket: 'projectIdentity', valueType: 'text' },
    { key: 'project_code', label: '项目编号', pattern: /项目编号|招标项目编号|project_code/u, bucket: 'projectIdentity', valueType: 'identifier' },
    { key: 'owner', label: '招标人', pattern: /招标人|建设单位|发包人|owner/u, bucket: 'projectIdentity', valueType: 'organization' },
    { key: 'project_location', label: '建设地点', pattern: /建设地点|实施地点|project_location/u, bucket: 'projectIdentity', valueType: 'location' },
    { key: 'project_scale', label: '建设规模', pattern: /建设规模|工程规模|project_scale/u, bucket: 'projectScope', valueType: 'scale' },
    { key: 'construction_scope', label: '施工范围', pattern: /施工范围|招标范围|工程范围/u, bucket: 'projectScope', valueType: 'text' },
    { key: 'duration', label: '计划工期', pattern: /计划工期|合同工期|总工期|schedule_requirement|duration/u, bucket: 'schedule', valueType: 'duration' },
    { key: 'quality_target', label: '质量目标', pattern: /质量标准|质量目标|quality_standard/u, bucket: 'quality', valueType: 'standard' },
  ];
  const conflicts: CanonicalFactModel['conflicts'] = [];
  for (const item of fieldPatterns) {
    const candidates = pickFactsByPattern(sourceFacts, item.key, item.label, item.pattern, item.valueType);
    if (!byKey[item.key] && candidates.length > 0) byKey[item.key] = chooseFact(candidates)!;
    const conflict = conflictsFor(item.key, item.label, candidates);
    if (conflict) conflicts.push(conflict);
  }

  const graphFactList = graphFacts(input.projectGraph);
  const resources = graphFactList.filter(fact => /resource_/u.test(fact.key));
  const risks = graphFactList.filter(fact => /risk_/u.test(fact.key));
  for (const fact of graphFactList) if (!byKey[fact.key]) byKey[fact.key] = fact;

  const gaps = (input.requiredKeys || [])
    .filter(key => !byKey[key])
    .map(key => ({ key, label: PROJECT_BASIC_FIELD_SPECS.find(spec => spec.key === key)?.label || key, reason: '未从用户输入、招标资料、清单、图纸或项目图谱中确认该事实' }));

  const result: CanonicalFactModel = {
    projectIdentity: {
      projectName: byKey.project_name,
      projectCode: byKey.project_code,
      owner: byKey.owner,
      location: byKey.project_location,
    },
    projectScope: {
      scale: byKey.project_scale,
      constructionScope: byKey.construction_scope,
    },
    schedule: {
      duration: byKey.duration || byKey.schedule_requirement,
    },
    quality: {
      target: byKey.quality_target || byKey.quality_standard,
    },
    safety: {
      risks,
    },
    resources: {
      resources,
    },
    environment: {},
    constraints: {},
    byKey,
    conflicts,
    gaps,
    scopeConflicts,
  };
  writeCachedCanonicalFacts(input.projectRoot, cacheKey, result);
  return result;
}
