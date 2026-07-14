import type { DocumentDraftChapter, DocumentEvidence, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from './documentWorkflowService';
import { readEngineeringDocumentConfig } from './engineeringDocumentConfigService';

export type EngineeringFactCategory = 'technical_parameter' | 'engineering_quantity' | 'schedule_milestone' | 'cost_commitment' | 'resource_allocation' | 'inspection_ratio' | 'management_frequency' | 'risk_response' | 'standard_requirement' | 'subdivision_work' | 'dangerous_work';

export interface EngineeringTechnicalFact {
  id: string;
  category: EngineeringFactCategory;
  discipline: string;
  workItem: string;
  location?: string;
  material?: string;
  equipment?: string;
  specification?: string;
  parameter?: string;
  quantities?: string[];
  scheduleValues?: string[];
  costValues?: string[];
  frequencyValues?: string[];
  resourceValues?: string[];
  commitmentValues?: string[];
  method?: string;
  process?: string[];
  qualityControl?: string[];
  inspection?: string[];
  standard?: string[];
  riskControl?: string[];
  sourceRole?: string;
  sourceFile?: string;
  text: string;
  confidence: number;
}

export interface TechnicalFactAssignment {
  chapterId: string;
  chapterTitle: string;
  facts: EngineeringTechnicalFact[];
}

const DISCIPLINE_PATTERNS: Array<[string, RegExp]> = [
  ['土建砌筑', /砌筑|砌块|构造柱|混凝土|砂浆|灰缝|钢筋|植筋|墙体|圈梁/u],
  ['防水工程', /防水|闭水|蓄水|JS|涂膜|卷材|阴阳角|管根|上翻/u],
  ['装饰装修', /地砖|墙砖|吊顶|铝扣板|涂料|腻子|乳胶漆|水磨石|面层|基层|抹灰/u],
  ['给排水', /给水|排水|PPR|PVC|管道|阀门|水压|通球|闭水|检查井|隔油池/u],
  ['电气工程', /电气|配电|电缆|桥架|线管|开关|插座|照明|绝缘|接地|通电/u],
  ['消防工程', /消防|消火栓|喷淋|报警|联动|防火|灭火器|水泵接合器/u],
  ['暖通排烟', /暖通|通风|排烟|风管|风机|风口|油烟|净化|排风|防火阀/u],
  ['厨房设备', /厨房|灶具|洗菜池|设备|明厨亮灶|食品|不锈钢|操作台/u],
  ['安全文明', /临时用电|动火|高处|扬尘|噪声|围挡|应急|文明施工|安全教育/u],
];

const PARAMETER_RE = /(?:[A-Z]{1,4}\d+(?:\.\d+)?|Ma?\d+(?:\.\d+)?|C\d{2,3}|DN\d+|φ\d+|Φ\d+|\d+(?:\.\d+)?\s*(?:mm|cm|m|㎡|m²|m3|MPa|kPa|℃|%|小时|h|日历天|天|台|套|个|根|遍|倍|分钟|min)|\d+\s*[×xX]\s*\d+(?:\s*[×xX]\s*\d+)?\s*mm|\d+\s*@\s*\d+)/giu;
const QUANTITY_RE = /\d+(?:\.\d+)?\s*(?:㎡|m²|m3|立方米|平方米|米|台|套|个|根|项|批|所|人|班组|工日|学校|校区|片区)/giu;
const SCHEDULE_RE = /\d+(?:\.\d+)?\s*(?:日历天|工作日|小时内|小时|h|分钟|min|日内|天内|个月|周|天)|(?:每日|每天|每周|每月|每班|日清|周结|旬考核)/giu;
const COST_RE = /\d+(?:\.\d+)?\s*(?:万元|元|%\/天|‰|%|违约金|处罚|合同价|中标价)/giu;
const FREQUENCY_RE = /(?:每日|每天|每周|每月|每班|每道工序|不少于\d+次|\d+次|\d+%|100%|全数|全部|一次性|每月不少于一次)/giu;
const RESOURCE_RE = /\d+(?:\.\d+)?\s*(?:人|班组|台|套|辆|名|个片区|片区)|(?:项目经理|安全员|质量员|施工员|材料员|资料员|专业工程师|专职巡查|应急小组)/giu;
const STANDARD_RE = /\b(?:GB|GB\/T|JGJ|JGJ\/T|CJJ|CJJ\/T|CECS|DB\d*|GA)\s*\d+(?:[-—]\d+)?\b/giu;
const PROCESS_WORDS = ['施工准备', '基层处理', '测量放线', '弹线', '样板', '复核', '安装', '连接', '热熔', '粘结', '涂刷', '附加层', '隐蔽验收', '调试', '联动', '养护', '成品保护'];
const INSPECTION_WORDS = ['验收', '检测', '试验', '复试', '闭水', '蓄水', '打压', '水压', '通球', '绝缘', '接地', '联动', '允许偏差', '合格'];
const QUALITY_WORDS = ['质量控制', '饱满度', '平整度', '垂直度', '偏差', '强度', '厚度', '间距', '标高', '坡度', '密封', '防渗', '防火'];
const RISK_WORDS = ['安全', '临电', '动火', '高处', '交叉作业', '防护', '扬尘', '噪声', '应急', '消防', '有限空间'];
const DANGEROUS_WORK_WORDS = ['危大工程', '危险性较大', '专项施工方案', '专家论证', '有限空间', '高处作业', '动火作业', '临时用电', '拆除工程', '起重吊装', '脚手架', '深基坑', '模板支撑'];
const SUBDIVISION_WORDS = ['分部分项', '分项工程', '拆除', '砌筑', '防水', '装饰', '吊顶', '涂料', '给排水', '电气', '消防', '暖通', '排烟', '厨房设备', '明厨亮灶', '隔油池'];
const DEFAULT_GENERIC_PHRASES = ['严格按照规范', '满足设计要求', '加强质量控制', '做好安全管理', '确保施工质量', '按要求验收', '结合现场情况', '加强协调', '做好成品保护', '相关要求', '规范要求'];

function cleanText(text: string) {
  return text.replace(/\s+/gu, ' ').trim();
}

function unique(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function sentenceChunks(text: string) {
  const normalized = cleanText(text);
  const chunks = normalized.split(/[。；;\n]/u).map(item => item.trim()).filter(item => item.length >= 12);
  return chunks.length ? chunks : normalized ? [normalized] : [];
}

function disciplineOf(text: string) {
  return DISCIPLINE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] || '通用工程';
}

function extractMatches(text: string, pattern: RegExp) {
  pattern.lastIndex = 0;
  const matches = [...text.matchAll(pattern)].map(match => match[0]);
  pattern.lastIndex = 0;
  return unique(matches);
}

function hasMatch(text: string, pattern: RegExp) {
  pattern.lastIndex = 0;
  const matched = pattern.test(text);
  pattern.lastIndex = 0;
  return matched;
}

function extractWords(text: string, words: string[]) {
  return words.filter(word => text.includes(word));
}

function workItemOf(text: string, discipline: string) {
  const candidates = ['砌筑', '构造柱', '防水', '闭水试验', '地砖', '墙砖', '吊顶', '涂料', '给水', '排水', '消防水', '消防电', '电气', '风管', '排烟', '油烟净化', '厨房设备', '明厨亮灶', '隔油池', '临时用电', '动火作业'];
  return candidates.find(item => text.includes(item)) || discipline;
}

function shouldKeepFact(text: string) {
  return [PARAMETER_RE, QUANTITY_RE, SCHEDULE_RE, COST_RE, FREQUENCY_RE, RESOURCE_RE, STANDARD_RE].some(pattern => hasMatch(text, pattern)) || [...PROCESS_WORDS, ...INSPECTION_WORDS, ...QUALITY_WORDS, ...RISK_WORDS, ...DANGEROUS_WORK_WORDS, ...SUBDIVISION_WORDS].some(word => text.includes(word));
}

function factCategory(input: { text: string; parameters: string[]; quantities: string[]; scheduleValues: string[]; costValues: string[]; frequencyValues: string[]; resourceValues: string[]; standards: string[]; inspection: string[]; riskControl: string[] }): EngineeringFactCategory {
  if (DANGEROUS_WORK_WORDS.some(word => input.text.includes(word))) return 'dangerous_work';
  if (SUBDIVISION_WORDS.some(word => input.text.includes(word))) return 'subdivision_work';
  if (input.costValues.length) return 'cost_commitment';
  if (input.scheduleValues.length) return input.riskControl.length ? 'risk_response' : 'schedule_milestone';
  if (input.frequencyValues.length) return input.inspection.length ? 'inspection_ratio' : 'management_frequency';
  if (input.resourceValues.length) return 'resource_allocation';
  if (input.quantities.length) return 'engineering_quantity';
  if (input.standards.length) return 'standard_requirement';
  return 'technical_parameter';
}

export function extractEngineeringTechnicalFacts(evidence: DocumentEvidence[], limit = 220): EngineeringTechnicalFact[] {
  const facts: EngineeringTechnicalFact[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    for (const chunk of sentenceChunks(item.content)) {
      if (!shouldKeepFact(chunk)) continue;
      const text = cleanText(chunk).slice(0, 420);
      const key = text.replace(/\d+/gu, '#').slice(0, 180);
      if (seen.has(key)) continue;
      seen.add(key);
      const discipline = disciplineOf(text);
      const parameters = extractMatches(text, PARAMETER_RE).slice(0, 8);
      const quantities = extractMatches(text, QUANTITY_RE).slice(0, 8);
      const scheduleValues = extractMatches(text, SCHEDULE_RE).slice(0, 8);
      const costValues = extractMatches(text, COST_RE).slice(0, 6);
      const frequencyValues = extractMatches(text, FREQUENCY_RE).slice(0, 8);
      const resourceValues = extractMatches(text, RESOURCE_RE).slice(0, 8);
      const standards = extractMatches(text, STANDARD_RE).slice(0, 5);
      const process = extractWords(text, PROCESS_WORDS);
      const inspection = extractWords(text, INSPECTION_WORDS);
      const qualityControl = extractWords(text, QUALITY_WORDS);
      const riskControl = extractWords(text, RISK_WORDS);
      const category = factCategory({ text, parameters, quantities, scheduleValues, costValues, frequencyValues, resourceValues, standards, inspection, riskControl });
      facts.push({
        id: `tech-${facts.length + 1}`,
        category,
        discipline,
        workItem: workItemOf(text, discipline),
        specification: parameters.join('、') || undefined,
        parameter: parameters.join('、') || undefined,
        quantities,
        scheduleValues,
        costValues,
        frequencyValues,
        resourceValues,
        commitmentValues: [...scheduleValues, ...costValues, ...frequencyValues].slice(0, 10),
        process,
        qualityControl,
        inspection,
        standard: standards,
        riskControl,
        sourceRole: item.roleId,
        sourceFile: item.filePath,
        text,
        confidence: Math.min(1, 0.42 + parameters.length * 0.06 + quantities.length * 0.05 + scheduleValues.length * 0.05 + costValues.length * 0.05 + frequencyValues.length * 0.05 + standards.length * 0.07 + process.length * 0.04 + inspection.length * 0.04),
      });
      if (facts.length >= limit) return facts;
    }
  }
  return facts;
}

function factMatchesChapter(fact: EngineeringTechnicalFact, chapter: DocumentTemplateChapter) {
  const haystack = `${chapter.title} ${chapter.purpose} ${(chapter.sections || []).join(' ')} ${(chapter.requiredFacts || []).join(' ')} ${(chapter.queries || []).join(' ')}`;
  if (/施工方法|主要.*方法|工艺|分项|分部分项/u.test(haystack)) return /土建|砌筑|防水|装饰|给排水|电气|消防|暖通|厨房|设备|排烟/u.test(fact.discipline + fact.workItem) || ['technical_parameter', 'subdivision_work', 'dangerous_work'].includes(fact.category);
  if (/质量|工期|进度/u.test(haystack)) return fact.qualityControl?.length || fact.inspection?.length || fact.standard?.length || ['schedule_milestone', 'inspection_ratio', 'management_frequency', 'cost_commitment'].includes(fact.category);
  if (/人.*材.*机|资源|材料|机械/u.test(haystack)) return ['resource_allocation', 'engineering_quantity'].includes(fact.category) || /材料|设备|机械|厨房设备|暖通|电气|给排水/u.test(fact.discipline + fact.workItem + fact.text);
  if (/安全|文明|应急|危大|危险性较大|专项/u.test(haystack)) return fact.riskControl?.length || ['risk_response', 'management_frequency', 'cost_commitment', 'dangerous_work'].includes(fact.category) || /临时用电|动火|高处|消防|应急|扬尘|有限空间|拆除/u.test(fact.text);
  if (/重点|难点/u.test(haystack)) return fact.confidence >= 0.65;
  return [fact.discipline, fact.workItem].some(value => haystack.includes(value));
}

export function assignTechnicalFactsToChapter(chapter: DocumentTemplateChapter, facts: EngineeringTechnicalFact[], limit = 24): TechnicalFactAssignment {
  const matched = facts
    .filter(fact => factMatchesChapter(fact, chapter))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
  return { chapterId: chapter.id, chapterTitle: chapter.title, facts: matched };
}

export function technicalFactsPrompt(assignment: TechnicalFactAssignment) {
  if (assignment.facts.length === 0) return '';
  const rows = assignment.facts.map((fact, index) => {
    const quantValues = [...(fact.quantities || []), ...(fact.scheduleValues || []), ...(fact.costValues || []), ...(fact.frequencyValues || []), ...(fact.resourceValues || [])].join('、');
    return `| ${index + 1} | ${fact.category} | ${fact.discipline} | ${fact.workItem} | ${fact.parameter || fact.specification || ''} | ${quantValues} | ${(fact.process || []).join('、')} | ${(fact.inspection || []).join('、')} | ${(fact.standard || []).join('、')} | ${fact.text.replace(/\|/gu, '，').slice(0, 220)} |`;
  });
  return [
    '本章必须优先落位以下工程量化事实和技术事实。不得用“按设计要求、按规范要求、加强管理”等空泛表述替代已列出的工程量、工期节点、频次、人员资源、金额承诺、参数、工艺、试验和验收指标。',
    '',
    '| 序号 | 类型 | 专业 | 分项 | 参数/规格 | 工程量/工期/频次/资源/金额 | 工艺动作 | 试验验收 | 规范标准 | 可写入正文的事实 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '强制写作要求：',
    '- 主要施工方法类章节按“适用部位/材料参数/工艺流程/操作要点/质量验收/安全与成品保护”展开。',
    '- 本章事实表中出现的工程数量、涉及学校数量、工期节点、检查频次、人员资源、设备数量、金额/违约承诺、数字、单位、强度、厚度、管径、试验时间、验收指标和规范编号，应自然写入正文。',
    '- 如果资料中已有具体参数，禁止只写“满足设计要求”“按规范施工”。',
    '- 每个主要分项至少写出施工动作、检查动作和验收动作。',
    '- 识别到分部分项、危大工程、危险性较大工程、有限空间、动火、高处、临电、拆除等风险线索时，必须写入对应章节的风险识别、专项方案、交底、旁站检查、验收放行和应急闭环。',
  ].join('\n');
}

function textTokens(text: string) {
  return unique([
    ...extractMatches(text, PARAMETER_RE),
    ...extractMatches(text, QUANTITY_RE),
    ...extractMatches(text, SCHEDULE_RE),
    ...extractMatches(text, COST_RE),
    ...extractMatches(text, FREQUENCY_RE),
    ...extractMatches(text, RESOURCE_RE),
    ...extractMatches(text, STANDARD_RE),
  ].map(item => item.replace(/\s+/gu, '')));
}

export function validateEngineeringDetailGate(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; assignments: TechnicalFactAssignment[]; finalMarkdown?: string }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const gate = readEngineeringDocumentConfig().technicalDetailGate;
  const matcherText = `${input.template.name} ${input.template.category} ${input.template.outputTitle}`;
  const matchers = gate?.templateMatchers?.length ? gate.templateMatchers : ['施工组织设计', '施工方案', '技术标.*施工', '施工.*技术标'];
  if (!matchers.some(pattern => new RegExp(pattern, 'iu').test(matcherText))) return issues;
  const markdown = input.finalMarkdown || input.chapters.map(chapter => `${chapter.title}\n${chapter.content}`).join('\n\n');
  const methodText = input.chapters.filter(chapter => /施工方法|主要.*方法|工艺/u.test(chapter.title)).map(chapter => chapter.content).join('\n');
  const targetText = methodText || markdown;
  const numericCount = extractMatches(targetText, PARAMETER_RE).length;
  const quantitativeCount = [QUANTITY_RE, SCHEDULE_RE, COST_RE, FREQUENCY_RE, RESOURCE_RE].reduce((sum, pattern) => sum + extractMatches(markdown, pattern).length, 0);
  const standardCount = extractMatches(markdown, STANDARD_RE).length;
  const processCount = PROCESS_WORDS.filter(word => markdown.includes(word)).length;
  const inspectionCount = INSPECTION_WORDS.filter(word => markdown.includes(word)).length;
  const genericPhrases = gate?.genericPhrases?.length ? gate.genericPhrases : DEFAULT_GENERIC_PHRASES;
  const genericCount = genericPhrases.reduce((sum, phrase) => sum + (markdown.match(new RegExp(phrase, 'gu'))?.length || 0), 0);
  const allAssignedFacts = input.assignments.flatMap(item => item.facts);
  const factTokens = unique(allAssignedFacts.flatMap(fact => textTokens(`${fact.parameter || ''} ${fact.specification || ''} ${fact.text}`))).slice(0, 120);
  const usedTokens = factTokens.filter(token => markdown.replace(/\s+/gu, '').includes(token));
  const usageRate = factTokens.length ? usedTokens.length / factTokens.length : 1;
  const minAssignedFactCount = gate?.minAssignedFactCountForBlocking ?? 12;
  if (allAssignedFacts.length >= minAssignedFactCount && usageRate < (gate?.minTechnicalFactUsageRate ?? 0.35)) issues.push({ level: 'error', message: `工程技术事实使用率不足：${Math.round(usageRate * 100)}%`, suggestion: '请把清单、图纸、设计说明中的材料规格、尺寸参数、试验验收和规范编号写入对应章节。' });
  if (numericCount < (gate?.minMethodParameterCount ?? 18) && allAssignedFacts.length >= minAssignedFactCount) issues.push({ level: 'error', message: `施工方法参数密度不足：仅识别 ${numericCount} 个数字/规格参数`, suggestion: '主要施工方法应补充材料强度、厚度、尺寸、管径、试验时间、压力、偏差和数量等可核查参数。' });
  if (quantitativeCount < (gate?.minQuantitativeFactCount ?? 20) && allAssignedFacts.length >= minAssignedFactCount) issues.push({ level: 'error', message: `工程量化事实密度不足：仅识别 ${quantitativeCount} 个工程量/工期/频次/资源/金额类数据`, suggestion: '请把工程数量、学校数量、工期节点、检查频次、人员驻场、机械设备、检测比例、响应时限和违约承诺写入对应章节。' });
  if (standardCount < (gate?.minStandardCount ?? 4)) issues.push({ level: 'warning', message: `规范标准引用不足：仅识别 ${standardCount} 个规范编号`, suggestion: '请结合图纸、设计说明和招标文件补充 GB/JGJ/CJJ 等规范或验收标准。' });
  if (processCount < (gate?.minProcessActionCount ?? 6)) issues.push({ level: 'warning', message: `工艺动作覆盖不足：仅识别 ${processCount} 类施工动作`, suggestion: '请补充基层处理、测量放线、样板、安装连接、隐蔽验收、调试和成品保护等工艺链。' });
  if (inspectionCount < (gate?.minInspectionActionCount ?? 6)) issues.push({ level: 'warning', message: `试验验收表达不足：仅识别 ${inspectionCount} 类试验/验收动作`, suggestion: '请补充闭水、打压、通球、绝缘、联动、复试、允许偏差等验收控制。' });
  if (genericCount > Math.max(gate?.maxGenericPhraseCountPer1800Chars ?? 10, Math.floor(markdown.length / 1800) * (gate?.maxGenericPhraseCountPer1800Chars ?? 10))) issues.push({ level: 'error', message: `空泛表达过多：识别 ${genericCount} 处泛化表述`, suggestion: '请减少“按规范要求、满足设计要求、加强管理”等空话，并用具体参数、流程和验收动作替代。' });
  return issues;
}
