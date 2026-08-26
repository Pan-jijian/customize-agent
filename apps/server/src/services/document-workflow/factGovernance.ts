import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanonicalFact as GovernedCanonicalFact, CanonicalFactModel, DocumentFact, NumericScopeConflict, ProjectGraph } from './types';
import { normalizeOcrFactText } from './factsModel';
import { stableHash, stringifyFactValue } from './utils';

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

function canonicalFactCacheKey(input: { facts: DocumentFact[]; markdown?: string; projectGraph?: ProjectGraph; requiredKeys?: string[]; requirement?: string; templateId?: string }) {
  return stableHash({
    // v4：裁决前置到事实主表构建入口（补疑优先 + “总”字可选正则），旧缓存结构不再适用
    version: 'canonical-facts-v4',
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
// 不同资料文件对同一总量口径（建设规模/估算价/工期）给出不同数值时，生成前必须先裁决出统一口径，
// 否则正文会混写两个数值（历史缺陷：招标文件正文 4645㎡ 与补疑/清单 4646㎡ 同时进入事实主表）

function scopeReForKind(kind: NumericScopeConflict['kind']) {
  // “总”字可选：招标文件常写“建筑面积约为4645㎡”（无“总”字），必须与“总建筑面积”同口径检出
  if (kind === 'area') return /总?建筑面积|建设规模|总?用地面积|总?占地面积/u;
  if (kind === 'cost') return /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价|工程总投资|总投资|工程造价/u;
  return /计划工期|合同工期|总工期|施工周期/u;
}

function unitReForKind(kind: NumericScopeConflict['kind']) {
  if (kind === 'area') return '(万?㎡|万?m²|万?m2|万?平方米)';
  if (kind === 'cost') return '(万元|亿元|万?元)';
  return '(日历天|天|个月|月)';
}

function extractNumericScopeEntries(text: string, kind: NumericScopeConflict['kind']) {
  const entries: Array<{ scope: string; value: string; unit: string; compareKey: string }> = [];
  const scopeRe = scopeReForKind(kind);
  const pattern = new RegExp(`(?:${scopeRe.source})(?:[^0-9\\n]{0,14}?)(\\d{2,}(?:[.,]\\d+)?)\\s*${unitReForKind(kind)}`, 'giu');
  for (const match of text.matchAll(pattern)) {
    const scope = match[0].match(scopeRe)?.[0] || '';
    const value = match[1].replace(/[,，]/gu, '').trim();
    const unit = (match[2] || '').trim();
    if (!scope || !value) continue;
    let compareKey: string;
    if (kind === 'duration') {
      // 工期天数与月数不可直接换算，按“数值+单位”原样比对
      compareKey = `${value}|${unit}`;
    } else {
      // 面积/金额归一化到基准单位（㎡/元），使“3.5万㎡”与“35000㎡”、“500万元”与“5000000元”可等价比较
      const wan = /万/u.test(unit) ? 1 : 0;
      const base = Number(value) * (wan ? 10000 : 1);
      if (!Number.isFinite(base)) continue;
      const normalized = /亿元/u.test(unit) ? base * 100000000 : /万元/u.test(unit) ? base * 10000 : base;
      compareKey = String(normalized);
    }
    entries.push({ scope, value, unit, compareKey });
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

export function detectNumericScopeConflicts(facts: DocumentFact[]): NumericScopeConflict[] {
  const conflicts: NumericScopeConflict[] = [];
  const kinds: NumericScopeConflict['kind'][] = ['area', 'cost', 'duration'];
  for (const kind of kinds) {
    type Entry = { scope: string; value: string; unit: string; compareKey: string; sourceFile?: string; priority: number };
    const seen = new Set<string>();
    const entries: Entry[] = [];
    for (const fact of facts) {
      const text = stringifyFactValue(fact.value);
      const priority = sourceFilePriority(fact.sourceFile, fact.roleId);
      for (const entry of extractNumericScopeEntries(text, kind)) {
        const key = `${fact.sourceFile || ''}|${entry.scope}|${entry.compareKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ ...entry, sourceFile: fact.sourceFile, priority });
      }
    }
    if (entries.length < 2) continue;
    // 按口径词分组：同一口径词（如“总建筑面积”）下出现不同取值且来自不同文件 → 冲突
    const byScope = entries.reduce((map, entry) => {
      const list = map.get(entry.scope) || [];
      list.push(entry);
      map.set(entry.scope, list);
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
      const bestKeys = new Set(bestEntries.map(entry => entry.compareKey));
      const winner = bestEntries[0];
      conflicts.push({
        kind,
        scope: `${scope}（${kind === 'area' ? '面积' : kind === 'cost' ? '金额' : '工期'}口径）`,
        values: [...new Map(scoped.map(entry => [`${entry.value}${entry.unit}|${entry.sourceFile || ''}`, { value: entry.value, unit: entry.unit, sourceFile: entry.sourceFile, priority: entry.priority }])).values()],
        resolution: bestKeys.size === 1 ? `${winner.value}${winner.unit}` : undefined,
      });
    }
  }
  return conflicts;
}

export function numericScopeResolutions(conflicts: NumericScopeConflict[]) {
  // 每个 kind 取第一条确定性裁决（resolution 唯一时才成立）
  const resolutions = new Map<NumericScopeConflict['kind'], { winnerNum: string; losers: Array<{ value: string; unit: string }> }>();
  for (const conflict of conflicts) {
    if (!conflict.resolution || resolutions.has(conflict.kind)) continue;
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
    lines.push(`${conflict.scope}必须统一为 ${conflict.resolution}（补疑/答疑/澄清类修正文件权威最高；${losers.map(loser => `${loser.value}${loser.unit}`).join('、')} 已被修正，正文禁止出现）`);
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
  const scopeConflicts = detectNumericScopeConflicts(rawFacts);
  const sourceFacts = applyScopeConflictResolutions(rawFacts, scopeConflicts);
  const canonicalMap = buildCanonicalFacts({ facts: sourceFacts, markdown: input.markdown });
  const byKey: Record<string, GovernedCanonicalFact> = {};
  for (const [key, fact] of canonicalMap.entries()) byKey[key] = governedFactFromCanonical(fact);

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
