import type { AutoDocumentSpecGateRule, AutoDocumentSpecPackage, GateRuleEvaluator } from '../document-core/autoDocumentSpecTypes';
import { readEngineeringDocumentConfig } from '../document-validation/engineeringDocumentConfigService';
import { CHAPTER_HEADING_RE, EXPORT_BLOCKING_ISSUE_RE, EXPORT_GATE_PRECISION_ISSUE_RE, EXPORT_GATE_PROJECT_CONTAMINATION_RE, FALLBACK_GATE_EVALUATORS, FORMAL_PLACEHOLDER_PATTERNS, FORMAL_STYLE_FORBIDDEN_PHRASES, LINE_SPLIT_RE, MARKDOWN_IMAGE_RE, MARKDOWN_SECTION_HEADING_RE, MARKDOWN_TABLE_BLOCK_SPLIT_RE, MARKDOWN_TABLE_DIVIDER_RE, MARKDOWN_TABLE_ROW_RE, MARKDOWN_TOP_HEADING_RE, NON_BLANK_RE, PRECISE_FACT_MIN_TOKEN_COUNT, PRECISE_FACT_MIN_USAGE_RATE, PRECISE_FACT_SOURCE_RE, PRECISE_FACT_TOKEN_RE, DOCUMENT_BASIC_INFO_BLOCK_RE, DOCUMENT_BASIC_INFO_FIELDS, DOCUMENT_BASIC_INFO_TABLE_RE, PROMPT_EXAMPLE_BLOCK_RE, QUALITY_SEVERITY_RULES, SPEC_GATE_RULE_HANDLERS, SPECIFICATION_CONTENT_RE, STRUCTURED_DATA_CONTENT_RE, TOC_BLOCK_RE, TOC_INDENTED_SECTION_LINE_RE, TOC_SECTION_LINE_RE, WHITESPACE_RE } from '../constants';
import type { QualitySeverity, QualitySeveritySummary, SpecGateRuleContext } from '../types';
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel, DocumentTemplate, ExportGateResult, FileBinding, PromptBinding, ValidationIssue } from './types';
import { estimateDocumentPages } from './budget';
import { evidenceSatisfiesSpecField } from './factMatching';
import { readPromptContents } from './templateStore';

export function isExportBlockingIssue(issue: ValidationIssue) {
  return EXPORT_BLOCKING_ISSUE_RE.test(issue.message);
}

export function classifyQualitySeverity(issue: string | ValidationIssue): QualitySeverity {
  const message = typeof issue === 'string' ? issue : issue.message;
  const level = typeof issue === 'string' ? undefined : issue.level;
  if (level === 'error') return 'blocking';
  for (const rule of QUALITY_SEVERITY_RULES) {
    if (rule.pattern.test(message)) return rule.severity;
  }
  return 'minor';
}

export function qualitySeveritySummary(issues: Array<string | ValidationIssue>): QualitySeveritySummary {
  const summary: QualitySeveritySummary = { blocking: 0, important: 0, minor: 0 };
  for (const issue of issues) summary[classifyQualitySeverity(issue)] += 1;
  return summary;
}

function repeatedTokenIssue(text: string, scope: string): ValidationIssue | undefined {
  const normalized = text.replace(/[\][()`*_>#|{}，。、“”‘’：；！？,.!?:;-]+/gu, ' ').replace(WHITESPACE_RE, ' ').trim();
  if (normalized.length < 120) return undefined;
  const tokens = normalized.match(/[A-Za-z][A-Za-z-]{2,}|[\p{Script=Han}]{2,}/gu) || [];
  if (tokens.length < 30) return undefined;
  let repeatedRun = 1;
  const counts = new Map<string, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase();
    counts.set(token, (counts.get(token) || 0) + 1);
    if (index > 0 && token === tokens[index - 1].toLowerCase()) repeatedRun += 1;
    else repeatedRun = 1;
    if (repeatedRun >= 12) return { level: 'error', message: `${scope} 存在重复 token 退化输出`, suggestion: '请重新生成该小节，禁止保留连续重复的英文单词或无意义片段。' };
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] >= 25 && dominant[1] / tokens.length >= 0.42) return { level: 'error', message: `${scope} 存在重复 token 退化输出`, suggestion: `检测到“${dominant[0]}”异常高频重复，请重新生成该小节。` };
  return undefined;
}

export function degenerateContentIssues(markdown: string, chapters: DocumentDraftChapter[] = []): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const whole = repeatedTokenIssue(markdown, '全文');
  if (whole) issues.push(whole);
  for (const chapter of chapters) {
    const chapterIssue = repeatedTokenIssue(chapter.content, `章节“${chapter.title}”`);
    if (chapterIssue) issues.push(chapterIssue);
    for (const section of chapter.sections || []) {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const match = chapter.content.match(new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^#{3,4}\\s+|^##\\s+|$)`, 'mu'));
      if (!match) continue;
      const sectionIssue = repeatedTokenIssue(match[1], `小节“${section}”`);
      if (sectionIssue) issues.push(sectionIssue);
    }
  }
  return issues;
}

function isHardExportBlockingIssue(issue: ValidationIssue) {
  if (!isExportBlockingIssue(issue)) return false;
  if (/章节审查|最终质量审查|规划小节正文过短|正文存在空泛占位表达/u.test(issue.message)) return false;
  return true;
}

export function buildExportGate(issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[]): ExportGateResult {
  const checklist = [
    { key: 'no_errors', label: '无阻断级校验错误', passed: !issues.some(issue => issue.level === 'error' && isHardExportBlockingIssue(issue)) },
    { key: 'basic_facts', label: '基础事实齐全', passed: factsModel.project.length > 0 },
    { key: 'source_traceability', label: '事实具备来源追踪', passed: [...factsModel.project, ...factsModel.schedule, ...factsModel.quality, ...factsModel.safety].every(fact => Boolean(fact.sourceFile)) },
    { key: 'structured_precision', label: '结构化精确参数已使用', passed: factsModel.preciseFacts.length < PRECISE_FACT_MIN_TOKEN_COUNT || issues.every(issue => !EXPORT_GATE_PRECISION_ISSUE_RE.test(issue.message)) },
    { key: 'chapter_evidence', label: '章节均具备证据', passed: chapters.every(chapter => chapter.evidence.length > 0) },
    { key: 'no_missing_content', label: '无资料未提供章节', passed: chapters.every(chapter => !chapter.content.includes('资料未提供')) },
    { key: 'no_project_contamination', label: '无项目污染和事实一致性阻断', passed: !issues.some(issue => issue.level === 'error' && EXPORT_GATE_PROJECT_CONTAMINATION_RE.test(issue.message) && isHardExportBlockingIssue(issue)) },
  ];
  const blockingIssues = issues.filter(issue => issue.level === 'error' && isHardExportBlockingIssue(issue));
  return { passed: blockingIssues.length === 0 && checklist.every(item => item.passed), blockingIssues, checklist };
}

export function fallbackEvaluatorForRule(rule: AutoDocumentSpecGateRule): GateRuleEvaluator {
  if (rule.evaluator) return rule.evaluator;
  return FALLBACK_GATE_EVALUATORS[rule.type]?.(rule) ?? { subject: 'document', operator: 'contains', value: rule.value || rule.target };
}

export function markdownTables(markdown: string) {
  const tableBlocks: string[] = [];
  for (const block of markdown.split(MARKDOWN_TABLE_BLOCK_SPLIT_RE)) {
    if (MARKDOWN_TABLE_ROW_RE.test(block) && MARKDOWN_TABLE_DIVIDER_RE.test(block)) tableBlocks.push(block);
  }
  return tableBlocks;
}

export function markdownImages(markdown: string) {
  const images = [];
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
    images.push({ alt: match[1] || '', url: match[2] || '', index: match.index ?? 0 });
  }
  return images;
}

export function safeRegex(value: string) {
  try { return new RegExp(value, 'iu'); } catch { return undefined; }
}

export function issueMessage(rule: AutoDocumentSpecGateRule, detail: string) {
  return `${rule.name}：${detail}`;
}

export function duplicateBasicInfoIssues(markdown: string): ValidationIssue[] {
  const chapterMatches = [...markdown.matchAll(CHAPTER_HEADING_RE)];
  const issues: ValidationIssue[] = [];
  for (let index = 1; index < chapterMatches.length; index += 1) {
    const start = chapterMatches[index].index || 0;
    const end = chapterMatches[index + 1]?.index ?? markdown.length;
    const content = markdown.slice(start, end);
    if (DOCUMENT_BASIC_INFO_BLOCK_RE.test(content)) {
      issues.push({ level: 'warning', message: `第 ${index + 1} 章可能重复出现基础信息`, suggestion: '如该信息与本章主题无关，建议合并到更合适的概况类章节，避免重复铺陈。' });
    }
  }
  if (chapterMatches.length === 0) return issues;
  const firstStart = chapterMatches[0].index || 0;
  const firstEnd = chapterMatches[1]?.index ?? markdown.length;
  const firstChapter = markdown.slice(firstStart, firstEnd);
  const tableIndex = firstChapter.search(DOCUMENT_BASIC_INFO_TABLE_RE);
  if (tableIndex <= 0) return issues;
  const beforeTable = firstChapter.slice(0, tableIndex).replace(MARKDOWN_SECTION_HEADING_RE, '');
  const repeatedFields: string[] = [];
  for (const field of DOCUMENT_BASIC_INFO_FIELDS) {
    if (new RegExp(`${field}\\s*[：:]`, 'u').test(beforeTable)) repeatedFields.push(field);
  }
  if (repeatedFields.length >= 3) issues.push({ level: 'warning', message: `基础信息表前重复叙述字段：${repeatedFields.join('、')}`, suggestion: '基础信息已表格化时，表格前只保留一句引导语，不要重复逐项叙述名称、编号、范围、周期、质量等字段。' });
  return issues;
}

export function formalStyleIssues(markdown: string): ValidationIssue[] {
  const hit: string[] = [];
  for (const item of FORMAL_STYLE_FORBIDDEN_PHRASES) {
    if (markdown.includes(item)) hit.push(item);
  }
  if (hit.length === 0) return [];
  return [{ level: 'warning', message: `存在模板化前缀或套话：${hit.join('、')}`, suggestion: '请删除“本节/本章将/以下从”等前缀，标题后直接进入对象、动作、措施、检查和闭环。' }];
}

export function minChapterSectionIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const sections = (chapter.sections || []).filter(Boolean);
    const duplicates = sections.filter((section, index) => sections.indexOf(section) !== index);
    if (duplicates.length > 0) issues.push({ level: 'warning', message: `${chapter.title} 存在重复小节：${[...new Set(duplicates)].join('、')}`, suggestion: '请保留用户需求、模板或显式大纲中真实需要的小节，删除重复项。' });
  }
  return issues;
}

export function tocHierarchyIssues(markdown: string): ValidationIssue[] {
  const match = TOC_BLOCK_RE.exec(markdown);
  if (!match) return [{ level: 'error', message: '缺少目录页', suggestion: '请在封面后生成“## 目录”，并按一级章父级、二级小节子级组织。' }];
  let sectionCount = 0;
  let indentedSectionCount = 0;
  for (const line of match[1].split(LINE_SPLIT_RE)) {
    if (!NON_BLANK_RE.test(line) || !TOC_SECTION_LINE_RE.test(line)) continue;
    sectionCount += 1;
    if (TOC_INDENTED_SECTION_LINE_RE.test(line)) indentedSectionCount += 1;
  }
  if (sectionCount > 0 && indentedSectionCount === 0) {
    return [{ level: 'error', message: '目录二级小节未作为子级缩进', suggestion: '目录应为父子级导航：一级章单独成行，二级小节至少缩进两个空格列在所属章下方。' }];
  }
  return [];
}

function normalizeStructureTitle(title: string) {
  return title
    .replace(/^#+\s*/u, '')
    .replace(/^第[一二三四五六七八九十百千万\d]+章\s*/u, '')
    .replace(/^\d+(?:\.\d+)+[.．、]?\s*/u, '')
    .replace(/^\d+[.．、]\s*/u, '')
    .replace(/[\s:：.。]+$/gu, '')
    .trim();
}

function collectTocSectionTitles(markdown: string) {
  const match = TOC_BLOCK_RE.exec(markdown);
  if (!match) return [];
  return match[1].split(LINE_SPLIT_RE)
    .map(line => /^\s*\d+\.\d+\s+(.+)$/u.exec(line.trim()))
    .filter((matchItem): matchItem is RegExpExecArray => Boolean(matchItem))
    .map(matchItem => normalizeStructureTitle(matchItem[1] || ''))
    .filter(Boolean);
}

function collectBodySectionTitles(markdown: string) {
  return [...markdown.matchAll(/^###\s+(.+)$/gmu)]
    .map(match => normalizeStructureTitle(match[1] || ''))
    .filter(Boolean);
}

export function tocBodyConsistencyIssues(markdown: string): ValidationIssue[] {
  const tocSections = collectTocSectionTitles(markdown);
  const bodySections = collectBodySectionTitles(markdown);
  if (tocSections.length === 0 || bodySections.length === 0) return [];
  const bodySet = new Set(bodySections);
  const tocSet = new Set(tocSections);
  const missingInBody = tocSections.filter(title => !bodySet.has(title));
  const missingInToc = bodySections.filter(title => !tocSet.has(title));
  const issues: ValidationIssue[] = [];
  if (missingInBody.length > 0) issues.push({ level: 'warning', message: `目录小节未在正文中找到：${[...new Set(missingInBody)].join('、')}`, suggestion: '请以用户 outline 抽取出的章节为准，修正文目录与正文二级小节编号及标题。' });
  if (missingInToc.length > 0) issues.push({ level: 'warning', message: `正文小节未进入目录：${[...new Set(missingInToc)].join('、')}`, suggestion: '请重新生成目录，确保只收录正文二级小节，不收录三级小节。' });
  return issues;
}

export function formalContentIntegrityIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = markdown.split(LINE_SPLIT_RE)
    .map(line => line.trim())
    .filter(line => line && !/^#{1,6}\s+/u.test(line) && !/^\s*\|/u.test(line) && !/^<div\b/iu.test(line));
  const orphan = lines.find(line => normalizeStructureTitle(line).length <= 1);
  if (orphan) issues.push({ level: 'warning', message: `正文存在孤立字或残缺段落：${orphan}`, suggestion: '请删除残缺行或重新生成所在小节。' });
  const unfinished = lines.find(line => /[，、；：和与在为对将]$/u.test(line) || /(通过|包括|如下|主要包括)$/u.test(line));
  if (unfinished) issues.push({ level: 'warning', message: `正文存在疑似截断句：${unfinished}`, suggestion: '请补完整该段落，避免以连接词、逗号或冒号结尾。' });
  const longLine = lines.find(line => line.length > 380);
  if (longLine) issues.push({ level: 'warning', message: `正文存在过长段落：${longLine}`, suggestion: '请拆分为多段或表格，改善导出版式和可读性。' });
  return issues;
}

function sectionBodyTextLength(body: string) {
  const text = body.split(LINE_SPLIT_RE)
    .filter(line => !/^#{1,6}\s+/u.test(line.trim()))
    .filter(line => !/^\s*\|/u.test(line))
    .filter(line => !/^\s*:?-{3,}:?/u.test(line))
    .filter(line => !/^<\/?div\b/iu.test(line.trim()))
    .join('\n');
  return text.replace(/[|*_`<>-]/gu, '').replace(WHITESPACE_RE, '').length;
}

type MarkdownSectionGapReason = 'missing_planned_section' | 'empty' | 'table_only' | 'too_short';

export interface MarkdownSectionContentGap {
  chapterTitle: string;
  sectionTitle: string;
  level: 3 | 4;
  bodyLength: number;
  reason: MarkdownSectionGapReason;
  planned: boolean;
  message: string;
}

function normalizeSectionTitleForGap(title: string) {
  return normalizeStructureTitle(title);
}

function sameSectionTitle(left: string, right: string) {
  const leftKey = normalizeSectionTitleForGap(left);
  const rightKey = normalizeSectionTitleForGap(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function collectActualSections(source: string) {
  const matches = [...source.matchAll(/^(#{3,4})\s+(.+)$/gmu)];
  return matches.map((match, index) => {
    const level = match[1].length as 3 | 4;
    const start = (match.index || 0) + match[0].length;
    const nextMatch = matches.slice(index + 1).find(item => item[1].length <= level);
    const end = nextMatch?.index ?? source.length;
    const rawTitle = (match[2] || '').trim();
    return { rawTitle, title: normalizeSectionTitleForGap(rawTitle), level, body: source.slice(start, end) };
  }).filter(item => item.title && (item.level === 3 || item.level === 4));
}

function sectionBodyForTitle(markdown: string, section: string) {
  return collectActualSections(markdown).find(item => sameSectionTitle(item.rawTitle, section));
}

function gapForSection(chapterTitle: string, sectionTitle: string, level: 3 | 4, body: string, planned: boolean): MarkdownSectionContentGap | undefined {
  const bodyLength = sectionBodyTextLength(body);
  const hasTable = MARKDOWN_TABLE_ROW_RE.test(body) && MARKDOWN_TABLE_DIVIDER_RE.test(body);
  const bodyWithoutTables = body.split('\n').filter(line => !MARKDOWN_TABLE_ROW_RE.test(line) && !MARKDOWN_TABLE_DIVIDER_RE.test(line)).join('\n');
  const nonTableLength = sectionBodyTextLength(bodyWithoutTables);
  const hasOnlyHeadingsOrTable = bodyLength < 80 && /^####\s+/mu.test(bodyWithoutTables);
  if (hasOnlyHeadingsOrTable || (hasTable && nonTableLength < 20)) return { chapterTitle, sectionTitle, level, bodyLength, reason: 'table_only', planned, message: `${chapterTitle} 小节只有标题或表格无正文：${sectionTitle}` };
  if (bodyLength >= 80 && nonTableLength >= 20) return undefined;
  if (bodyLength === 0) return { chapterTitle, sectionTitle, level, bodyLength, reason: 'empty', planned, message: `${chapterTitle} 空小节：${sectionTitle}` };
  if (bodyLength < 180) return { chapterTitle, sectionTitle, level, bodyLength, reason: 'too_short', planned, message: `${chapterTitle} ${planned ? '规划小节' : '正文小节'}正文过短：${sectionTitle}` };
  return undefined;
}

export function collectSectionContentGaps(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content' | 'sections'>>): MarkdownSectionContentGap[] {
  const gaps: MarkdownSectionContentGap[] = [];
  const seen = new Set<string>();
  for (const chapter of chapters) {
    const source = chapter.content?.trim() ? chapter.content : markdown;
    for (const section of chapter.sections || []) {
      const normalized = normalizeSectionTitleForGap(section);
      const found = sectionBodyForTitle(source, section);
      const key = `${chapter.title}|${normalized}|planned`;
      if (!found) {
        gaps.push({ chapterTitle: chapter.title, sectionTitle: section, level: 3, bodyLength: 0, reason: 'missing_planned_section', planned: true, message: `${chapter.title} 缺少规划小节：${section}` });
        seen.add(key);
        continue;
      }
      const gap = gapForSection(chapter.title, normalized || section, found.level, found.body, true);
      if (gap) gaps.push(gap);
      seen.add(key);
    }
    for (const section of collectActualSections(source)) {
      const key = `${chapter.title}|${section.title}|actual`;
      const plannedKey = `${chapter.title}|${section.title}|planned`;
      if (seen.has(key) || seen.has(plannedKey)) continue;
      const gap = gapForSection(chapter.title, section.title, section.level, section.body, false);
      if (gap && (gap.reason === 'empty' || gap.reason === 'table_only')) gaps.push(gap);
      seen.add(key);
    }
  }
  return gaps;
}

export function sectionContentIntegrityIssues(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content' | 'sections'>>): ValidationIssue[] {
  return collectSectionContentGaps(markdown, chapters).map(gap => ({
    level: 'error' as const,
    message: gap.message,
    suggestion: gap.reason === 'missing_planned_section'
      ? '请补写该二级小节，不能只在目录中出现。'
      : gap.reason === 'table_only'
        ? '请在表格前后补充来源、适用范围、结论和执行要求。'
        : '请补充与该小节相关的材料事实、适用边界和必要说明。',
  }));
}

function collectPreciseFactTokens(factsModel: DocumentFactsModel) {
  const tokens = new Set<string>();
  for (const fact of factsModel.preciseFacts) {
    if (!PRECISE_FACT_SOURCE_RE.test(`${fact.processingType || ''} ${fact.roleId} ${fact.sourceFile}`)) continue;
    for (const match of `${fact.key} ${fact.value}`.matchAll(PRECISE_FACT_TOKEN_RE)) tokens.add(match[0]);
  }
  return [...tokens];
}

function countUsedPreciseTokens(tokens: string[], normalizedMarkdown: string) {
  let used = 0;
  for (const token of tokens) {
    if (normalizedMarkdown.includes(token.replace(WHITESPACE_RE, ''))) used += 1;
  }
  return used;
}

export function preciseFactUsageIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const normalized = markdown.replace(WHITESPACE_RE, '');
  const tokens = collectPreciseFactTokens(factsModel);
  const used = countUsedPreciseTokens(tokens, normalized);
  if (tokens.length >= PRECISE_FACT_MIN_TOKEN_COUNT && used / tokens.length < PRECISE_FACT_MIN_USAGE_RATE) issues.push({ level: 'error', message: `结构化精确参数使用不足：${used}/${tokens.length}`, suggestion: '请把资料中的规格、参数、数量、时间、资源、金额、比例和标准编号写入对应章节，禁止泛化概括。' });
  if (factsModel.bills.length > 0 && !STRUCTURED_DATA_CONTENT_RE.test(markdown)) issues.push({ level: 'error', message: '正文未体现结构化数据资料', suggestion: '请从表格、列表或明细中提取对象、单位、数量、规格和关键参数补入对应章节。' });
  if (factsModel.drawings.length > 0 && !SPECIFICATION_CONTENT_RE.test(markdown)) issues.push({ level: 'error', message: '正文未体现设计/方案/说明类资料', suggestion: '请从设计、方案或说明资料中提取对象、流程、节点、做法、配置、规则和标准要求。' });
  return issues;
}

export function formalPlaceholderIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const pattern of FORMAL_PLACEHOLDER_PATTERNS) {
    if (pattern.test(markdown)) issues.push({ level: 'warning', message: `存在占位式表达：${pattern.source}`, suggestion: '请改写为来自资料的准确事实；资料确实未提供时，改写为正式管理措施，不留空值或“见资料/按文件”。' });
  }
  return issues;
}

function templateMatchesAutoSpecGate(text: string, matchers: string[]) {
  for (const pattern of matchers) {
    try {
      if (new RegExp(pattern, 'iu').test(text)) return true;
    } catch {
      if (text.includes(pattern)) return true;
    }
  }
  return false;
}

export function plannedAutoSpecGateIssues(markdown: string, template: DocumentTemplate): ValidationIssue[] {
  const text = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  const gates = [];
  for (const gate of readEngineeringDocumentConfig().autoSpecGates) {
    if (templateMatchesAutoSpecGate(text, gate.templateMatchers)) gates.push(gate);
  }
  if (gates.length === 0) return [];
  const issues: ValidationIssue[] = [];
  const tableCount = markdownTables(markdown).length;
  let minTables = 0;
  for (const gate of gates) {
    minTables = Math.max(minTables, gate.minTables || 0);
    for (const item of gate.requiredTexts) if (!markdown.includes(item)) issues.push({ level: 'error', message: `配置要求缺少必要内容：${item}`, suggestion: '请按当前模板匹配的专业规则补齐必要内容。' });
    for (const item of gate.forbiddenTexts) if (markdown.includes(item)) issues.push({ level: 'error', message: `配置要求不得出现：${item}`, suggestion: '请根据当前模板匹配的专业规则清理正文污染内容。' });
  }
  if (MARKDOWN_TOP_HEADING_RE.test(markdown)) issues.push({ level: 'error', message: '正式正文存在 Markdown 标题符号 #', suggestion: '导出正文应去除 Markdown 标题符号，保留正式标题文字。' });
  if (minTables && tableCount < minTables) issues.push({ level: 'error', message: `配置要求正式表格不足：${tableCount}/${minTables}`, suggestion: '请按当前模板匹配的专业规则补充必要表格。' });
  return issues;
}

function collectAllFacts(factsModel: DocumentFactsModel) {
  const allFacts = [...factsModel.project, ...factsModel.schedule, ...factsModel.quality, ...factsModel.safety, ...factsModel.resources];
  for (const facts of Object.values(factsModel.schemaFacts)) allFacts.push(...facts);
  return allFacts;
}

function collectFactNames(factsModel: DocumentFactsModel, allFacts: DocumentFact[]) {
  const factNames = new Set<string>();
  for (const fact of allFacts) {
    factNames.add(fact.key);
    if (fact.fieldName) factNames.add(fact.fieldName);
  }
  for (const table of factsModel.tables) {
    for (const header of table.headers) factNames.add(header);
    for (const row of table.rows) for (const cell of row) factNames.add(cell);
  }
  return factNames;
}

function validateRequiredSpecFields(spec: AutoDocumentSpecPackage, chapters: DocumentDraftChapter[], factNames: Set<string>, factsModel: DocumentFactsModel, next: ValidationIssue[]) {
  for (const field of spec.factFields) {
    if (!field.required) continue;
    const schemaFacts = factsModel.schemaFacts[field.id] || [];
    let satisfiedByChapterEvidence = false;
    let satisfiedBySourceRole = !field.sourceRoleIds?.length || schemaFacts.some(fact => field.sourceRoleIds?.includes(fact.roleId));
    for (const chapter of chapters) {
      if (satisfiedByChapterEvidence && satisfiedBySourceRole) break;
      for (const item of chapter.evidence) {
        if (!satisfiedByChapterEvidence && !chapter.missingFacts.includes(field.name) && evidenceSatisfiesSpecField(item, field)) satisfiedByChapterEvidence = true;
        if (!satisfiedBySourceRole && evidenceSatisfiesSpecField(item, field)) satisfiedBySourceRole = true;
      }
    }
    if (schemaFacts.length === 0 && !factNames.has(field.name) && !satisfiedByChapterEvidence) next.push({ level: 'warning', message: `必需事实缺失：${field.name}`, suggestion: field.extractionHint || '请补充资料或调整事实字段配置。' });
    if (!satisfiedBySourceRole) next.push({ level: 'warning', message: `必需事实来源角色不匹配：${field.name}`, suggestion: `请确认该事实来自角色：${field.sourceRoleIds?.join('、')}` });
  }
}

function applySpecGateRule(context: SpecGateRuleContext): ValidationIssue | undefined {
  for (const handler of SPEC_GATE_RULE_HANDLERS) {
    const detail = handler(context);
    if (detail) return { level: context.rule.level, message: issueMessage(context.rule, detail) };
  }
  return undefined;
}

export function applySpecGateRules(spec: AutoDocumentSpecPackage | undefined, issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[], markdown: string, fileBindings: FileBinding[], promptBindings: PromptBinding[]) {
  if (!spec) return issues;
  const next = [...issues];
  const allFacts = collectAllFacts(factsModel);
  const factNames = collectFactNames(factsModel, allFacts);
  const chapterTitles = new Set(chapters.map(chapter => chapter.title));
  validateRequiredSpecFields(spec, chapters, factNames, factsModel, next);
  for (const chapter of spec.chapterRules) {
    const draft = chapters.find(item => item.title === chapter.title);
    if (draft && chapter.minWords && draft.content.length < chapter.minWords) next.push({ level: 'warning', message: `章节内容深度建议：${chapter.title}`, suggestion: `可扩展到约 ${chapter.minWords} 字，但不要改变模板章节结构。` });
  }
  const tableBlocks = markdownTables(markdown);
  const imageRefs = markdownImages(markdown);
  const estimatedPages = estimateDocumentPages(markdown);
  for (const rule of spec.gateRules) {
    const evaluator = fallbackEvaluatorForRule(rule);
    const target = evaluator.target || rule.target || '';
    const value = evaluator.value || rule.value || target;
    const chapter = chapters.find(item => item.title === target);
    const issue = applySpecGateRule({
      rule,
      evaluator,
      target,
      value,
      min: evaluator.min || Number(rule.value) || 1,
      markdown,
      textScope: evaluator.subject === 'chapter' && chapter ? chapter.content : markdown,
      regex: value ? safeRegex(value) : undefined,
      chapter,
      factNames,
      chapterTitles,
      tableBlocks,
      imageRefs,
      estimatedPages,
      allFacts,
      factsModel,
      fileBindings,
      promptBindings,
    });
    if (issue) next.push(issue);
  }
  return next;
}

function promptBindingContents(promptBindings: PromptBinding[]) {
  let content = '';
  for (const prompt of readPromptContents(promptBindings)) {
    if (prompt.content) content += `${prompt.content}\n\n`;
  }
  return content;
}

export function promptExampleLeakIssues(markdown: string, promptBindings: PromptBinding[]): ValidationIssue[] {
  const promptText = promptBindingContents(promptBindings);
  if (!promptText.trim()) return [];
  const normalizedMarkdown = markdown.replace(WHITESPACE_RE, ' ');
  for (const match of promptText.matchAll(PROMPT_EXAMPLE_BLOCK_RE)) {
    const block = (match[1] || '').replace(WHITESPACE_RE, ' ').trim();
    if (!block) continue;
    if (normalizedMarkdown.includes(block)) return [{ level: 'error', message: '正文疑似包含提示词示例内容', suggestion: '请删除提示词样例数据，仅保留基于当前绑定材料生成的正文。' }];
  }
  return [];
}
