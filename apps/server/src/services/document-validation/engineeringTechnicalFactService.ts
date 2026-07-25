import { CHAPTER_FACT_MATCHERS, COST_RE, COVERAGE_ISSUE_LIMIT, COVERAGE_LABEL_LIMIT, COVERAGE_LABEL_MIN_LENGTH, COVERAGE_VALUE_LIMIT, DEFAULT_CHAPTER_FACT_ASSIGNMENT_LIMIT, DEFAULT_ENGINEERING_TEMPLATE_MATCHERS, DEFAULT_GENERIC_PHRASES, DEFAULT_TECHNICAL_FACT_LIMIT, DISCIPLINE_PATTERNS, ENGINEERING_COVERAGE_MATRIX_LIMIT, FACT_CATEGORY_RULES, FACT_DEDUPE_NUMBER_RE, FACT_KEEP_PATTERNS, FACT_KEEP_WORD_GROUPS, FACT_SENTENCE_SPLIT_RE, FACT_WHITESPACE_RE, FREQUENCY_RE, INSPECTION_WORDS, MARKDOWN_TABLE_PIPE_RE, METHOD_CHAPTER_TITLE_RE, PARAMETER_RE, PROCESS_WORDS, QUALITY_WORDS, QUANTITY_RE, RESOURCE_RE, RISK_WORDS, SCHEDULE_RE, STANDARD_RE, TECHNICAL_FACT_DEDUPE_KEY_MAX_LENGTH, TECHNICAL_FACT_FIELD_LIMITS, TECHNICAL_FACT_TEXT_MAX_LENGTH, TECHNICAL_FACT_USAGE_TOKEN_LIMIT, WORK_ITEM_CANDIDATES } from '../constants';
import type { EngineeringFactCategory, EngineeringTechnicalFact, FactCategoryInput, TechnicalFactAssignment } from '../types';
import type { DocumentDraftChapter, DocumentEvidence, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from '../document-workflow/types';
import { readEngineeringDocumentConfig } from './engineeringDocumentConfigService';

export type { EngineeringFactCategory, EngineeringTechnicalFact, TechnicalFactAssignment } from '../types';

function cleanText(text: string) {
  return text.replace(FACT_WHITESPACE_RE, ' ').trim();
}

function unique(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function sentenceChunks(text: string) {
  const normalized = cleanText(text);
  if (!normalized) return [];
  const chunks: string[] = [];
  for (const raw of normalized.split(FACT_SENTENCE_SPLIT_RE)) {
    const chunk = raw.trim();
    if (chunk.length >= 12) chunks.push(chunk);
  }
  return chunks.length ? chunks : [normalized];
}

function disciplineOf(text: string) {
  for (const [name, pattern] of DISCIPLINE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return name;
  }
  return '通用领域';
}

function extractMatches(text: string, pattern: RegExp) {
  pattern.lastIndex = 0;
  const matches: string[] = [];
  for (const match of text.matchAll(pattern)) matches.push(match[0]);
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
  const result: string[] = [];
  for (const word of words) {
    if (text.includes(word)) result.push(word);
  }
  return result;
}

function includesAnyWord(text: string, words: string[]) {
  for (const word of words) {
    if (text.includes(word)) return true;
  }
  return false;
}

function workItemOf(text: string, discipline: string) {
  for (const item of WORK_ITEM_CANDIDATES) {
    if (text.includes(item)) return item;
  }
  return discipline;
}

function shouldKeepFact(text: string) {
  for (const pattern of FACT_KEEP_PATTERNS) {
    if (hasMatch(text, pattern)) return true;
  }
  for (const words of FACT_KEEP_WORD_GROUPS) {
    if (includesAnyWord(text, [...words])) return true;
  }
  return false;
}

function factCategory(input: FactCategoryInput): EngineeringFactCategory {
  for (const rule of FACT_CATEGORY_RULES) {
    if (rule.match(input)) return rule.category;
  }
  return 'technical_parameter';
}

export function extractEngineeringTechnicalFacts(evidence: DocumentEvidence[], limit = DEFAULT_TECHNICAL_FACT_LIMIT): EngineeringTechnicalFact[] {
  const facts: EngineeringTechnicalFact[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    for (const chunk of sentenceChunks(item.content)) {
      if (!shouldKeepFact(chunk)) continue;
      const text = cleanText(chunk).slice(0, TECHNICAL_FACT_TEXT_MAX_LENGTH);
      const key = text.replace(FACT_DEDUPE_NUMBER_RE, '#').slice(0, TECHNICAL_FACT_DEDUPE_KEY_MAX_LENGTH);
      if (seen.has(key)) continue;
      seen.add(key);
      const discipline = disciplineOf(text);
      const parameters = extractMatches(text, PARAMETER_RE).slice(0, TECHNICAL_FACT_FIELD_LIMITS.parameters);
      const quantities = extractMatches(text, QUANTITY_RE).slice(0, TECHNICAL_FACT_FIELD_LIMITS.quantities);
      const scheduleValues = extractMatches(text, SCHEDULE_RE).slice(0, TECHNICAL_FACT_FIELD_LIMITS.scheduleValues);
      const costValues = extractMatches(text, COST_RE).slice(0, TECHNICAL_FACT_FIELD_LIMITS.costValues);
      const frequencyValues = extractMatches(text, FREQUENCY_RE).slice(0, TECHNICAL_FACT_FIELD_LIMITS.frequencyValues);
      const resourceValues = extractMatches(text, RESOURCE_RE).slice(0, TECHNICAL_FACT_FIELD_LIMITS.resourceValues);
      const standards = extractMatches(text, STANDARD_RE).slice(0, TECHNICAL_FACT_FIELD_LIMITS.standards);
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
        commitmentValues: [...scheduleValues, ...costValues, ...frequencyValues].slice(0, TECHNICAL_FACT_FIELD_LIMITS.commitmentValues),
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

function chapterHaystack(chapter: DocumentTemplateChapter) {
  return `${chapter.title} ${chapter.purpose} ${(chapter.sections || []).join(' ')} ${(chapter.requiredFacts || []).join(' ')} ${(chapter.queries || []).join(' ')}`;
}

function factMatchesChapter(fact: EngineeringTechnicalFact, chapter: DocumentTemplateChapter) {
  const haystack = chapterHaystack(chapter);
  for (const matcher of CHAPTER_FACT_MATCHERS) {
    matcher.pattern.lastIndex = 0;
    if (matcher.pattern.test(haystack)) return matcher.match(fact);
  }
  return haystack.includes(fact.discipline) || haystack.includes(fact.workItem);
}

export function assignTechnicalFactsToChapter(chapter: DocumentTemplateChapter, facts: EngineeringTechnicalFact[], limit = DEFAULT_CHAPTER_FACT_ASSIGNMENT_LIMIT): TechnicalFactAssignment {
  const matched: EngineeringTechnicalFact[] = [];
  for (const fact of facts) {
    if (factMatchesChapter(fact, chapter)) matched.push(fact);
  }
  matched.sort((a, b) => b.confidence - a.confidence);
  return { chapterId: chapter.id, chapterTitle: chapter.title, facts: matched.slice(0, limit) };
}

export function technicalFactsPrompt(assignment: TechnicalFactAssignment) {
  if (assignment.facts.length === 0) return '';
  const rows = assignment.facts.map((fact, index) => {
    const quantValues = [...(fact.quantities || []), ...(fact.scheduleValues || []), ...(fact.costValues || []), ...(fact.frequencyValues || []), ...(fact.resourceValues || [])].join('、');
    return `| ${index + 1} | ${fact.category} | ${fact.discipline} | ${fact.workItem} | ${fact.parameter || fact.specification || ''} | ${quantValues} | ${(fact.process || []).join('、')} | ${(fact.inspection || []).join('、')} | ${(fact.standard || []).join('、')} | ${fact.text.replace(MARKDOWN_TABLE_PIPE_RE, '，').slice(0, DEFAULT_TECHNICAL_FACT_LIMIT)} |`;
  });
  return [
    '本章必须优先使用以下结构化事实。不得用空泛表述替代已列出的数量、时间、频次、资源、金额、参数、流程动作、检查验收和标准依据。',
    '',
    '| 序号 | 类型 | 领域 | 对象 | 参数/规格 | 数量/时间/频次/资源/金额 | 过程动作 | 检查验收 | 标准依据 | 可写入正文的事实 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '写作要求：',
    '- 围绕本章主题，将事实表中的对象、参数、数量、时间节点、频次、资源、金额和标准依据自然写入正文。',
    '- 有明确资料依据的事实必须保持原值，不得改写口径或编造缺失数据。',
    '- 对流程、方法或执行类章节，应说明适用对象、实施步骤、控制要点、检查方式和结果闭环。',
    '- 对存在风险、约束或合规要求的事实，应写清触发条件、控制措施、责任边界和复核方式。',
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
  ].map(item => item.replace(FACT_WHITESPACE_RE, '')));
}

function factCoverageLabel(fact: EngineeringTechnicalFact) {
  const parts = [fact.location, fact.workItem, fact.material, fact.equipment, fact.discipline];
  const result: string[] = [];
  for (const part of parts) if (part) result.push(part);
  return result.join(' / ');
}

function quantifiableFacts(facts: EngineeringTechnicalFact[]) {
  const result: EngineeringTechnicalFact[] = [];
  for (const fact of facts) {
    if ((fact.quantities?.length || 0) + (fact.scheduleValues?.length || 0) + (fact.frequencyValues?.length || 0) + (fact.resourceValues?.length || 0) + (fact.costValues?.length || 0) > 0) result.push(fact);
  }
  return result;
}

export function engineeringCoverageMatrixPrompt(assignment: TechnicalFactAssignment) {
  const facts = quantifiableFacts(assignment.facts).slice(0, ENGINEERING_COVERAGE_MATRIX_LIMIT);
  if (facts.length === 0) return '';
  const rows = facts.map((fact, index) => {
    const quantities = [...(fact.quantities || []), ...(fact.scheduleValues || []), ...(fact.frequencyValues || []), ...(fact.resourceValues || []), ...(fact.costValues || [])].join('、');
    return `| ${index + 1} | ${factCoverageLabel(fact)} | ${quantities} | ${fact.parameter || fact.specification || ''} | ${fact.sourceRole || ''} | ${fact.sourceFile || ''} | ${fact.text.replace(MARKDOWN_TABLE_PIPE_RE, '，').slice(0, TECHNICAL_FACT_DEDUPE_KEY_MAX_LENGTH)} |`;
  });
  return [
    '## 本章量化事实覆盖矩阵',
    '以下对象、数量、时间、频次、资源或金额来自项目资料。正文必须逐项覆盖；同一方案涉及多个对象时，不得只写其中一项或把多个量化事实合并成一个笼统数量。',
    '| 序号 | 对象/事项 | 量化值 | 参数/规格 | 来源角色 | 来源文件 | 原始事实 |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '覆盖要求：',
    '- 日期、数量、规格、资源数量和时间节点只能使用资料中的值或由资料明确推导的值；没有依据时不得编造。',
    '- 如果同一方案适用于多个对象、区域、阶段或类别，应使用表格或分项段落分别说明适用范围、量化事实和控制要点。',
    '- 资料中存在多个来源值或口径不一致时，应保持审慎表述并提示需按资料优先级复核，不得随意选择一个数值。',
  ].join('\n');
}

export function validateQuantifiedCoverage(input: { assignments: TechnicalFactAssignment[]; markdown: string }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const normalized = input.markdown.replace(FACT_WHITESPACE_RE, '');
  for (const assignment of input.assignments) {
    const facts = quantifiableFacts(assignment.facts);
    if (facts.length < 3) continue;
    const labels: string[] = [];
    const values: string[] = [];
    for (const fact of facts) {
      const label = factCoverageLabel(fact);
      if (label.length >= COVERAGE_LABEL_MIN_LENGTH) labels.push(label);
      for (const value of [...(fact.quantities || []), ...(fact.scheduleValues || []), ...(fact.frequencyValues || []), ...(fact.resourceValues || []), ...(fact.costValues || [])]) values.push(value.replace(FACT_WHITESPACE_RE, ''));
    }
    const uniqueLabels = unique(labels).slice(0, COVERAGE_LABEL_LIMIT);
    const uniqueValues = unique(values).slice(0, COVERAGE_VALUE_LIMIT);
    const usedLabels = uniqueLabels.filter(label => normalized.includes(label.replace(FACT_WHITESPACE_RE, '')));
    const usedValues = uniqueValues.filter(value => normalized.includes(value));
    if (uniqueLabels.length >= 3 && usedLabels.length / uniqueLabels.length < 0.45) {
      issues.push({ level: 'warning', message: `${assignment.chapterTitle} 量化对象覆盖不足：${usedLabels.length}/${uniqueLabels.length}`, suggestion: '请按对象、事项、区域、阶段或类别逐项补齐适用范围、数量、时间/资源和控制要点，避免只写一个笼统数量。' });
    }
    if (uniqueValues.length >= 5 && usedValues.length / uniqueValues.length < 0.35) {
      issues.push({ level: 'warning', message: `${assignment.chapterTitle} 量化数值使用不足：${usedValues.length}/${uniqueValues.length}`, suggestion: '请把资料中的日期、数量、单位、规格、工期节点、频次、资源数量写入对应章节；无依据不得编造。' });
    }
  }
  return issues.slice(0, COVERAGE_ISSUE_LIMIT);
}

export function validateEngineeringDetailGate(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; assignments: TechnicalFactAssignment[]; finalMarkdown?: string }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const gate = readEngineeringDocumentConfig().technicalDetailGate;
  const matcherText = `${input.template.name} ${input.template.category} ${input.template.outputTitle}`;
  const matchers = gate?.templateMatchers?.length ? gate.templateMatchers : [...DEFAULT_ENGINEERING_TEMPLATE_MATCHERS];
  if (!matchers.some(pattern => new RegExp(pattern, 'iu').test(matcherText))) return issues;
  const markdown = input.finalMarkdown || input.chapters.map(chapter => `${chapter.title}\n${chapter.content}`).join('\n\n');
  const methodContents: string[] = [];
  for (const chapter of input.chapters) {
    if (METHOD_CHAPTER_TITLE_RE.test(chapter.title)) methodContents.push(chapter.content);
  }
  const methodText = methodContents.join('\n');
  const targetText = methodText || markdown;
  const numericCount = extractMatches(targetText, PARAMETER_RE).length;
  let quantitativeCount = 0;
  for (const pattern of [QUANTITY_RE, SCHEDULE_RE, COST_RE, FREQUENCY_RE, RESOURCE_RE]) quantitativeCount += extractMatches(markdown, pattern).length;
  const standardCount = extractMatches(markdown, STANDARD_RE).length;
  const processCount = PROCESS_WORDS.filter(word => markdown.includes(word)).length;
  const inspectionCount = INSPECTION_WORDS.filter(word => markdown.includes(word)).length;
  const genericPhrases = gate?.genericPhrases?.length ? gate.genericPhrases : DEFAULT_GENERIC_PHRASES;
  const genericCount = genericPhrases.reduce((sum, phrase) => sum + (markdown.match(new RegExp(phrase, 'gu'))?.length || 0), 0);
  const allAssignedFacts: EngineeringTechnicalFact[] = [];
  const rawTokens: string[] = [];
  for (const assignment of input.assignments) {
    for (const fact of assignment.facts) {
      allAssignedFacts.push(fact);
      rawTokens.push(...textTokens(`${fact.parameter || ''} ${fact.specification || ''} ${fact.text}`));
    }
  }
  const factTokens = unique(rawTokens).slice(0, TECHNICAL_FACT_USAGE_TOKEN_LIMIT);
  const normalizedMarkdown = markdown.replace(FACT_WHITESPACE_RE, '');
  const usedTokens = factTokens.filter(token => normalizedMarkdown.includes(token));
  const usageRate = factTokens.length ? usedTokens.length / factTokens.length : 1;
  const minAssignedFactCount = gate?.minAssignedFactCountForBlocking ?? 12;
  if (allAssignedFacts.length >= minAssignedFactCount && usageRate < (gate?.minTechnicalFactUsageRate ?? 0.35)) issues.push({ level: 'error', message: `结构化事实使用率不足：${Math.round(usageRate * 100)}%`, suggestion: '请把资料中的规格参数、数量、时间、频次、资源、金额、检查结果和标准依据写入对应章节。' });
  if (numericCount < (gate?.minMethodParameterCount ?? 18) && allAssignedFacts.length >= minAssignedFactCount) issues.push({ level: 'error', message: `方法参数密度不足：仅识别 ${numericCount} 个数字/规格参数`, suggestion: '方法或流程类章节应补充对象、参数、时限、数量、阈值、偏差范围和结果指标等可核查事实。' });
  if (quantitativeCount < (gate?.minQuantitativeFactCount ?? 20) && allAssignedFacts.length >= minAssignedFactCount) issues.push({ level: 'error', message: `量化事实密度不足：仅识别 ${quantitativeCount} 个数量/时间/频次/资源/金额类数据`, suggestion: '请把数量、时间节点、检查频次、人员/资源配置、响应时限和费用/金额承诺写入对应章节。' });
  if (standardCount < (gate?.minStandardCount ?? 4)) issues.push({ level: 'warning', message: `标准依据引用不足：仅识别 ${standardCount} 个标准编号`, suggestion: '请结合资料补充适用的标准、规范、制度编号或验收依据。' });
  if (processCount < (gate?.minProcessActionCount ?? 6)) issues.push({ level: 'warning', message: `过程动作覆盖不足：仅识别 ${processCount} 类过程动作`, suggestion: '请补充准备、执行、检查、复核、调整、验收或归档等过程链条。' });
  if (inspectionCount < (gate?.minInspectionActionCount ?? 6)) issues.push({ level: 'warning', message: `检查验收表达不足：仅识别 ${inspectionCount} 类检查/验收动作`, suggestion: '请补充检查方式、复核节点、验证标准、结果记录和闭环处理。' });
  if (genericCount > Math.max(gate?.maxGenericPhraseCountPer1800Chars ?? 10, Math.floor(markdown.length / 1800) * (gate?.maxGenericPhraseCountPer1800Chars ?? 10))) issues.push({ level: 'error', message: `空泛表达过多：识别 ${genericCount} 处泛化表述`, suggestion: '请减少空话套话，并用具体对象、参数、流程、检查动作和结果依据替代。' });
  return issues;
}
