import type { AutoDocumentSpecGateRule, AutoDocumentSpecPackage, GateRuleEvaluator } from '../document-core/autoDocumentSpecTypes';
import { readEngineeringDocumentConfig } from '../document-validation/engineeringDocumentConfigService';
import { CHAPTER_HEADING_RE, EXPORT_BLOCKING_ISSUE_RE, EXPORT_GATE_PRECISION_ISSUE_RE, EXPORT_GATE_PROJECT_CONTAMINATION_RE, FALLBACK_GATE_EVALUATORS, FORMAL_PLACEHOLDER_PATTERNS, FORMAL_STYLE_FORBIDDEN_PHRASES, LINE_SPLIT_RE, MARKDOWN_IMAGE_RE, MARKDOWN_SECTION_HEADING_RE, MARKDOWN_TABLE_BLOCK_SPLIT_RE, MARKDOWN_TABLE_DIVIDER_RE, MARKDOWN_TABLE_ROW_RE, MARKDOWN_TOP_HEADING_RE, NON_BLANK_RE, PRECISE_FACT_MIN_TOKEN_COUNT, PRECISE_FACT_MIN_USAGE_RATE, PRECISE_FACT_SOURCE_RE, PRECISE_FACT_TOKEN_RE, DOCUMENT_BASIC_INFO_BLOCK_RE, DOCUMENT_BASIC_INFO_FIELDS, DOCUMENT_BASIC_INFO_TABLE_RE, PROMPT_EXAMPLE_BLOCK_RE, QUALITY_SEVERITY_RULES, SPEC_GATE_RULE_HANDLERS, SPECIFICATION_CONTENT_RE, STRUCTURED_DATA_CONTENT_RE, TOC_BLOCK_RE, TOC_INDENTED_SECTION_LINE_RE, TOC_SECTION_LINE_RE, WHITESPACE_RE } from '../constants';
import type { QualitySeverity, QualitySeveritySummary, SpecGateRuleContext } from '../types';
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel, DocumentTemplate, ExportGateResult, ProjectBinding, PromptBinding, ValidationIssue } from './types';
import { documentTextLength, estimateDocumentPages } from './budget';
import { extractEngineeringMeasureTokens, normalizeEngineeringTextForFactMatch } from './engineeringUnits';
import { displayChapterTitle } from './outline';
import { evidenceSatisfiesSpecField } from './factMatching';
import { readPromptContents } from './templateStore';
import { stringifyFactValue } from './utils';

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

function classifyValidationIssue(issue: ValidationIssue): ValidationIssue {
  if (issue.severity && issue.repairability) return issue;
  if (/小节只有标题|空小节|小节内容补写未完成/u.test(issue.message)) return { ...issue, severity: 'blocker', repairability: 'local_deterministic', category: 'structure', owner: 'system' };
  if (/不得出现|提示词要求|疑似提示词指令标题|项目污染|生成未完成/u.test(issue.message)) return { ...issue, severity: 'blocker', repairability: 'llm_repairable', category: 'structure', owner: 'system' };
  if (/事实一致性冲突|projectFactOnly|核心事实/u.test(issue.message)) return { ...issue, severity: issue.level === 'error' ? 'blocker' : 'warning', repairability: 'manual_review', category: 'fact_consistency', owner: 'user' };
  if (/证据使用覆盖率偏低|BOQ|落位|高分模块|专业链|闭环/u.test(issue.message)) return { ...issue, severity: 'warning', repairability: 'not_repair_needed', category: 'evidence_coverage', owner: 'system' };
  if (issue.level === 'error') return { ...issue, severity: 'blocker', repairability: 'llm_repairable', category: 'structure', owner: 'system' };
  if (issue.level === 'warning') return { ...issue, severity: 'warning', repairability: 'not_repair_needed', category: 'style', owner: 'system' };
  return { ...issue, severity: 'suggestion', repairability: 'not_repair_needed', category: 'style', owner: 'system' };
}

function isHardExportBlockingIssue(issue: ValidationIssue) {
  const governedIssue = classifyValidationIssue(issue);
  if (governedIssue.severity !== 'blocker') return false;
  if (governedIssue.level === 'error' && governedIssue.severity === 'blocker' && /placeholder|source|style|format|structure/u.test(String(governedIssue.category || ''))) return true;
  if (/提示词要求|疑似提示词指令标题|适用性自相矛盾|不得出现/u.test(issue.message)) return true;
  if (/目录与正文/u.test(issue.message)) return false;
  if (/配置要求缺少必要内容/u.test(issue.message)) return issue.level === 'error';
  if (/小节内容补写未完成|空小节|小节只有标题|生成未完成/u.test(issue.message)) return true;
  if (/生成后事实反查失败/u.test(issue.message)) return false;
  if (/项目特点、重点、难点分析 正文不足|项目主要施工内容 正文不足/u.test(issue.message)) return true;
  if (/规划小节正文过短/u.test(issue.message)) return false;
  if (/事实一致性冲突：项目名称/u.test(issue.message)) return false;
  if (/跨章一致性|专业评分不足|专业缺口|泛化套话|缺少关键线路|缺少材料验收|缺少风险识别|缺少进场/u.test(issue.message)) return issue.level === 'error' && !/证据使用覆盖率偏低|章节逻辑依赖不足|文档交付评分报告/u.test(issue.message);
  if (!isExportBlockingIssue(issue)) return false;
  if (/章节审查|最终质量审查|正文篇幅明显低于目标|正文存在空泛占位表达|结构化事实读取不足|正文可能未显式覆盖|仅包含文件类型和占位符|不在本次招标范围内/u.test(issue.message)) return false;
  return true;
}

export function buildExportGate(issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[]): ExportGateResult {
  const hasBody = chapters.some(chapter => {
    const body = (chapter.content || '')
      .split(LINE_SPLIT_RE)
      .filter(line => !/^#{1,6}\s+/u.test(line.trim()))
      .filter(line => !/^\s*\|/u.test(line))
      .filter(line => !/^\s*:?-{3,}:?/u.test(line))
      .join('\n')
      .replace(/[|*_`<>#\s]/gu, '');
    return body.length >= 30;
  });
  const governedIssues = issues.map(classifyValidationIssue);
  const hardBlockingIssues = governedIssues.filter(issue => issue.level === 'error' && isHardExportBlockingIssue(issue));
  // 已生成实质正文时仍保留关键结构阻断（缺节、空小节、生成未达标、正文不足等），仅豁免其余软性门禁，避免质量门禁卡住交付。
  const CRITICAL_BLOCK_RE = /缺少规划小节|小节生成未达标|小节内容补写未完成|空小节|小节只有标题|生成未完成|正文不足|主要施工内容小节缺失|部分章节生成失败|Writer 未完成|不得出现|疑似提示词指令标题|项目污染/u;
  const blockingIssues = hasBody ? hardBlockingIssues.filter(issue => CRITICAL_BLOCK_RE.test(issue.message)) : hardBlockingIssues;
  const checklist = [
    { key: 'no_errors', label: '无阻断级校验错误', passed: blockingIssues.length === 0 },
    { key: 'basic_facts', label: '基础事实齐全', passed: factsModel.project.length > 0 },
    { key: 'source_traceability', label: '事实具备来源追踪', passed: [...factsModel.project, ...factsModel.schedule, ...factsModel.quality, ...factsModel.safety].every(fact => Boolean(fact.sourceFile)) },
    { key: 'structured_precision', label: '结构化精确参数已使用', passed: factsModel.preciseFacts.length < PRECISE_FACT_MIN_TOKEN_COUNT || issues.every(issue => issue.level !== 'error' || !EXPORT_GATE_PRECISION_ISSUE_RE.test(issue.message)) },
    { key: 'chapter_evidence', label: '章节均具备证据', passed: chapters.every(chapter => chapter.evidence.length > 0) },
    { key: 'no_missing_content', label: '无资料未提供章节', passed: chapters.every(chapter => !chapter.content.includes('资料未提供')) },
    { key: 'no_project_contamination', label: '无项目污染和事实一致性阻断', passed: !issues.some(issue => issue.level === 'error' && EXPORT_GATE_PROJECT_CONTAMINATION_RE.test(issue.message) && isHardExportBlockingIssue(issue)) },
  ];
  return { passed: blockingIssues.length === 0, blockingIssues, checklist };
}

export function fallbackEvaluatorForRule(rule: AutoDocumentSpecGateRule): GateRuleEvaluator {
  if (rule.evaluator) return rule.evaluator;
  return FALLBACK_GATE_EVALUATORS[rule.type]?.(rule) ?? { subject: 'document', operator: 'contains', value: rule.value || rule.target };
}

export function markdownTables(markdown: string) {
  const tableBlocks: string[] = [];
  const lines = markdown.split(LINE_SPLIT_RE);
  for (let index = 0; index < lines.length; index += 1) {
    if (!MARKDOWN_TABLE_ROW_RE.test(lines[index])) continue;
    const block: string[] = [];
    while (index < lines.length && MARKDOWN_TABLE_ROW_RE.test(lines[index])) {
      block.push(lines[index]);
      index += 1;
    }
    index -= 1;
    if (block.some(line => MARKDOWN_TABLE_DIVIDER_RE.test(line))) tableBlocks.push(block.join('\n'));
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
  const issues: ValidationIssue[] = [];
  const hit: string[] = [];
  for (const item of FORMAL_STYLE_FORBIDDEN_PHRASES) {
    if (markdown.includes(item)) hit.push(item);
  }
  if (hit.length > 0) issues.push({ level: 'warning', message: `存在模板化前缀或套话：${hit.join('、')}`, suggestion: '请删除“本节/本章将/以下从”等前缀，标题后直接进入对象、动作、措施、检查和闭环。' });
  const backstage = markdown.match(/OCR|提示词|绑定片段|后台|文件路径|识别错误|知识库证据|知识库已确认事实|通用兜底段落|兜底占位|兜底模板/giu);
  if (backstage?.length) issues.push({ level: 'warning', message: `正文包含后台或资料处理话术：${[...new Set(backstage)].join('、')}`, suggestion: '建议改为正式文档语言，例如“资料文字不清”“资料口径不一致”“项目资料”，不得暴露后台处理过程。' });
  return issues;
}

export function minChapterSectionIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const sections = (chapter.sections || []).filter(Boolean);
    const duplicates = sections.filter((section, index) => sections.indexOf(section) !== index);
    if (duplicates.length > 0) issues.push({ level: 'warning', message: `${chapter.title} 存在重复小节：${[...new Set(duplicates)].join('、')}`, suggestion: '请保留用户需求、模板或显式大纲中真实需要的小节，删除重复项。' });
    const thematic = new Map<string, string[]>();
    for (const section of sections) {
      const key = /劳动力|人员|工种/u.test(section) ? '劳动力计划' : /机械|设备|机具/u.test(section) ? '机械设备计划' : /材料|物资/u.test(section) ? '材料物资计划' : /冬季|雨季|高温|台风|大风/u.test(section) ? '特殊气候措施' : '';
      if (key) thematic.set(key, [...(thematic.get(key) || []), section]);
    }
    for (const [key, values] of thematic) {
      if (values.length > 1) issues.push({ level: 'warning', message: `${chapter.title} 存在重复主题小节：${key}（${values.join('、')}）`, suggestion: '请合并同类小节，只保留一个主表或主方案，其他位置采用引用或执行说明。' });
    }
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
    .replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分]\s*/u, '')
    .replace(/^\d+(?:\.\d+)*(?:[.．、]|\s)+/u, '')
    .replace(/[（）]/gu, match => match === '（' ? '(' : ')')
    .replace(/[\s:：.。；;,，、]+$/gu, '')
    .replace(/的(?=保障体系|管理体系|控制体系|措施|方案|计划|要求)/gu, '')
    .replace(/[\s()（）:：.。；;,，、-]/gu, '')
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
  return [...markdown.matchAll(/^#{2,4}\s+(\d+\.\d+\s+.+)$/gmu)]
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
  if (missingInBody.length > 0) issues.push({ level: 'error', message: `目录与正文不一致，目录小节未在正文中找到：${[...new Set(missingInBody)].join('、')}`, suggestion: '建议以最终清洗后的正文二级标题为准重新生成目录。' });
  if (missingInToc.length > 0) issues.push({ level: 'error', message: `目录与正文不一致，正文小节未进入目录：${[...new Set(missingInToc)].join('、')}`, suggestion: '建议重新生成目录，确保只收录正文二级小节，不收录三级小节。' });
  return issues;
}

function isInstructionLikeStructureTitle(value: string) {
  const rawTitle = value
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^\s*\d+(?:\.\d+)*(?:[.．、]|\s)+/u, '')
    .replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分]\s*/u, '')
    .trim();
  const displayTitle = displayChapterTitle(rawTitle);
  const instructionTitleRe = /^(?:\d+(?:\.\d+)*\s*)?(?:[-—–]\s*)?(?:(?:判断|判定|识别|确认)?是否(?:涉及|涉|需要|适用).*|(?:如|若|如果)(?:涉及|不涉及|适用|不适用).*|.*(?:根据|结合).{0,12}(?:实际情况|项目情况|资料情况).{0,8}(?:判断|确定|编写|生成).*|.*(?:按需(?:生成|编写)|视情况|判断后|生成要求|编写要求|注意事项))\s*$/u;
  return instructionTitleRe.test(rawTitle) || instructionTitleRe.test(displayTitle);
}

export function instructionLikeHeadingIssues(markdown: string): ValidationIssue[] {
  const headings = [...markdown.matchAll(/^#{2,6}\s+(.+)$/gmu)]
    .map(match => displayChapterTitle(match[1] || ''))
    .filter(isInstructionLikeStructureTitle);
  return headings.length > 0 ? [{ level: 'error', message: `正文存在疑似提示词指令标题：${[...new Set(headings)].slice(0, 8).join('、')}`, suggestion: '请删除或改写为正式施工组织设计小节标题，目录也不得收录该类标题。' }] : [];
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
  const inlineList = lines.find(line => /\S.+(?:\s|[。；;])(?:\d+[.、](?=\s|\*\*)\s*|[（(]\d+[）)]\s*|[-*+]\s+)\S.+(?:\s|[。；;])(?:\d+[.、](?=\s|\*\*)\s*|[（(]\d+[）)]\s*|[-*+]\s+)\S/u.test(line) && !/\b\d+\.\d+\s*(?:mm|cm|m|㎡|m2|kg|t|MPa|kPa|V|KV|kV|A)\b/iu.test(line));
  if (inlineList) issues.push({ level: 'error', message: `正文存在列表项粘连同一行：${inlineList.slice(0, 120)}`, suggestion: '有序列表和无序列表必须逐项独占一行，确保 Markdown/PDF/DOCX 正确排版。' });
  const sourcePageRef = markdown.match(/(?:PDF\s*)?第\s*\d+\s*(?:[-—至到~～]\s*\d+)?\s*页|(?:图纸|清单|资料|文件|[\u4e00-\u9fa5A-Za-z0-9（）()、·-]{2,24}(?:工程)?)\s*(?:[（(]?\s*|(?:共|多达|约|合计)\s*)\d+\s*页|[\u4e00-\u9fa5A-Za-z0-9、及与和]{2,24}\s*(?:共|多达|约|合计)\s*\d+\s*页|\d+\s*页\s*(?:图纸|资料|文件|装饰|土建|加固|给排水|电气|智能化|消防)|\d+\s*页/iu)?.[0];
  if (sourcePageRef) issues.push({ level: 'error', message: `正文残留资料页码元信息：${sourcePageRef}`, suggestion: '正式投标正文应引用招标文件、施工图设计文件、工程量清单和相关专业图纸，不写 PDF 页码或资料页数。' });
  const internalTrace = lines.find(line => /仅作为内部事实提取依据|正式正文不得引用文件名|后台事实|内部事实/u.test(line));
  if (internalTrace) issues.push({ level: 'error', message: `正文残留内部处理说明：${internalTrace.slice(0, 120)}`, suggestion: '正式投标正文不得出现内部事实抽取、后台处理或文件名引用限制说明。' });
  return issues;
}

export function formalHeadingHierarchyIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const firstBodyChapter = markdown.search(/^##\s+第[一二三四五六七八九十百千万\d]+章\s+/mu);
  const bodyMarkdown = firstBodyChapter >= 0 ? markdown.slice(firstBodyChapter) : markdown.replace(/^##\s+目录[\s\S]*?(?=^##\s+第[一二三四五六七八九十百千万\d]+章\s+)/mu, '');
  const illegalH2 = [...bodyMarkdown.matchAll(/^##\s+(.+)$/gmu)]
    .map(match => (match[1] || '').trim())
    .filter(title => title !== '目录' && !/^第[一二三四五六七八九十百千万\d]+章\s+/u.test(title) && !/^附录/u.test(title))
    .map(title => displayChapterTitle(title));
  if (illegalH2.length > 0) issues.push({ level: 'error', message: `正文存在非正式章二级标题：${[...new Set(illegalH2)].slice(0, 8).join('、')}`, suggestion: '正文 ## 只允许用于“第X章”正式章标题；章内小节必须使用 ### X.Y。' });
  const chapterMatches = [...markdown.matchAll(/^##\s+(第[一二三四五六七八九十百千万\d]+章\s+.+)$/gmu)];
  for (let index = 0; index < chapterMatches.length; index += 1) {
    const start = chapterMatches[index].index || 0;
    const end = chapterMatches[index + 1]?.index ?? markdown.length;
    const block = markdown.slice(start, end);
    const sections = [...block.matchAll(/^###\s+\d+\.\d+\s+(.+)$/gmu)].map(match => displayChapterTitle(match[1] || ''));
    const chapterTitle = displayChapterTitle((chapterMatches[index][1] || '').replace(/^第[一二三四五六七八九十百千万\d]+章\s*/u, ''));
    if (sections.length === 1 && normalizeStructureTitle(sections[0]) === normalizeStructureTitle(chapterTitle)) {
      issues.push({ level: 'error', message: `章节只有一个且与章名同名的小节：${chapterMatches[index][1]}`, suggestion: '应拆分为多个业务小节，不能用章标题重复作为唯一二级小节。' });
    }
  }
  return issues;
}

export function markdownTableQualityIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (/按审批确认执行/u.test(markdown)) issues.push({ level: 'error', message: '表格存在自动兜底污染内容：按审批确认执行', suggestion: '正式投标表格不得使用通用兜底短语，应保留真实业务内容或删除该行。' });
  // “信息项|内容”表头也被 Writer 用于工程量/设备参数汇总表，只有内容含项目基础信息字段的表才算“基础信息表”；
  // 直接按表头计数会把第三章的工程量汇总表误判为“基础信息重复”。
  const basicInfoTableBlocks: string[] = [];
  for (const match of markdown.matchAll(/\|\s*信息项\s*\|\s*内容\s*\|/gu)) {
    const rest = markdown.slice(match.index || 0);
    const end = rest.indexOf('\n\n');
    basicInfoTableBlocks.push(end >= 0 ? rest.slice(0, end) : rest.slice(0, 800));
  }
  const duplicatedBasicInfoTableCount = basicInfoTableBlocks.filter(block => /项目名称|招标人|建设单位|发包人|建设地点|招标范围|计划工期|合同估算价|质量标准/u.test(block)).length;
  if (duplicatedBasicInfoTableCount > 1) issues.push({ level: 'error', message: `项目基础信息类表格重复：${duplicatedBasicInfoTableCount} 处`, suggestion: '项目名称、招标人、建设地点、工期、质量等基础信息只能集中输出一次。' });
  const repeatedDividerRows = markdown.match(/^\|\s*---\s*\|\s*---\s*\|\s*$/gmu) || [];
  if (repeatedDividerRows.length > 20) issues.push({ level: 'error', message: `表格分隔线异常重复：${repeatedDividerRows.length} 行`, suggestion: '请修复表格规范化逻辑，禁止把数据行拆成多个碎表。' });
  for (const block of markdownTables(markdown)) {
    const rows = block.split(LINE_SPLIT_RE).filter(line => MARKDOWN_TABLE_ROW_RE.test(line));
    if (rows.length < 2) continue;
    if (!MARKDOWN_TABLE_DIVIDER_RE.test(rows[1] || '')) {
      issues.push({ level: 'error', message: `表格分隔线位置不规范：${rows[0] || ''}`, suggestion: 'Markdown 表格必须紧跟表头输出分隔线，例如 |---|---|，中间不得插入正文或其他管道行。' });
      continue;
    }
    const cells = rows.map(line => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => cell.trim()));
    const header = cells[0] || [];
    const genericHeaders = header.filter(cell => /^(?:列|字段|内容|备注)\d+$/u.test(cell));
    if (genericHeaders.length > 0) issues.push({ level: 'error', message: `表格存在泛化表头：${genericHeaders.join('、')}`, suggestion: '正式投标表格必须使用业务字段表头，不得出现“列5/字段1/内容2”等临时表头。' });
    const expectedColumns = header.length;
    const badRow = cells.find((row, rowIndex) => rowIndex !== 1 && row.length !== expectedColumns);
    if (badRow) issues.push({ level: 'error', message: `表格列数不一致：${header.join('、')}`, suggestion: '请统一表头和数据行列数；不应通过自动填充兜底词修补表格。' });
  }
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

type MarkdownSectionGapReason = 'missing_planned_section' | 'empty' | 'too_short';

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
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey)) return true;
  const tokenRe = /项目概况|主要施工方案|新技术新材料|工程重点难点|重点难点|危大工程|保障体系|安全保障|工期|质量|安全生产|应急预案|资源|人材机|材料|机械|劳动力|进度|关键线路|交通疏导|成品保护|深化设计|验收/gu;
  const leftTokens = new Set(leftKey.match(tokenRe) || []);
  const rightTokens = new Set(rightKey.match(tokenRe) || []);
  const overlap = [...leftTokens].filter(token => rightTokens.has(token)).length;
  return overlap >= 2 || (Math.min(leftTokens.size, rightTokens.size) === 1 && overlap === 1 && Math.max(leftKey.length, rightKey.length) <= 16);
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
  const matches = collectActualSections(markdown).filter(item => sameSectionTitle(item.rawTitle, section));
  if (matches.length <= 1) return matches[0];
  return matches
    .map(item => ({ item, gap: gapForSection('', section, item.level, item.body, true), textLength: sectionBodyTextLength(item.body) }))
    .sort((left, right) => {
      const leftBad = left.gap && left.gap.reason === 'empty' ? 1 : 0;
      const rightBad = right.gap && right.gap.reason === 'empty' ? 1 : 0;
      if (leftBad !== rightBad) return leftBad - rightBad;
      return right.textLength - left.textLength;
    })[0]?.item;
}

function tableDataRowCount(body: string) {
  const rows = body.split(LINE_SPLIT_RE).filter(line => MARKDOWN_TABLE_ROW_RE.test(line) && !MARKDOWN_TABLE_DIVIDER_RE.test(line));
  return Math.max(0, rows.length - 1);
}

function gapForSection(chapterTitle: string, sectionTitle: string, level: 3 | 4, body: string, planned: boolean): MarkdownSectionContentGap | undefined {
  const bodyLength = sectionBodyTextLength(body);
  const hasTable = MARKDOWN_TABLE_ROW_RE.test(body) && body.split(LINE_SPLIT_RE).some(line => MARKDOWN_TABLE_DIVIDER_RE.test(line));
  const bodyWithoutTables = body.split('\n').filter(line => !MARKDOWN_TABLE_ROW_RE.test(line) && !MARKDOWN_TABLE_DIVIDER_RE.test(line)).join('\n');
  const nonTableBody = bodyWithoutTables.replace(/^#{1,6}\s+.+$/gmu, '');
  const nonTableLength = sectionBodyTextLength(nonTableBody);
  if (/\[WRITER_MISSING_SECTION\]|Writer 未完成/u.test(body)) return { chapterTitle, sectionTitle, level, bodyLength, reason: 'empty', planned, message: `${chapterTitle} 小节内容补写未完成：${sectionTitle}` };
  if (/【本小节生成未达标，需重新生成】/u.test(body)) return { chapterTitle, sectionTitle, level, bodyLength, reason: 'empty', planned, message: `${chapterTitle} 小节生成未达标：${sectionTitle}` };
  if (/项目基本信息|基本信息|工程概况|项目概况|工程概述|项目概述/u.test(sectionTitle) && (hasTable || bodyLength >= 40)) return undefined;
  // 附录A/B 由导出层按正文自动归集注入，不属于 Writer 成稿范围；只要带表格即视为有效，不参与正文完整度校验
  if (/^附录[一二三四五六七八九十A-Z\d]/u.test(sectionTitle) && hasTable) return undefined;
  // 清单/配置类小节本体即表格清单（如危大工程控制清单、主要周转材料配置），表格数据行≥2 视为有效正文，避免误报“只有标题或表格无正文”
  const listStyleSection = /清单|配置|汇总|一览|计划表|明细/u.test(sectionTitle);
  if (hasTable && listStyleSection && tableDataRowCount(body) >= 2) return undefined;
  if (hasTable && nonTableLength < 20) return { chapterTitle, sectionTitle, level, bodyLength, reason: 'empty', planned, message: planned ? `${chapterTitle} 只有标题或表格无正文：${sectionTitle}` : `${chapterTitle} 小节只有标题或表格无正文：${sectionTitle}` };
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
    // 附录小节由导出层自动归集注入 markdown 尾部，不进入章节草稿 content，也不应由 Writer 成稿，跳过规划小节校验
    const plannedSections = (chapter.sections || []).filter(section => !/^(?:施工概况|施工流程|施工方法)$/u.test(normalizeSectionTitleForGap(section)) && !/^附录/u.test(section.trim()));
    for (const section of plannedSections) {
      const normalized = normalizeSectionTitleForGap(section);
      const found = sectionBodyForTitle(source, section);
      const key = `${chapter.title}|${normalized}|planned`;
      if (!found) {
        gaps.push({ chapterTitle: chapter.title, sectionTitle: section, level: 3, bodyLength: 0, reason: 'missing_planned_section', planned: true, message: `${chapter.title} 缺少规划小节：${section}` });
        seen.add(key);
        continue;
      }
      const gap = gapForSection(chapter.title, section, found.level, found.body, true);
      if (gap) gaps.push(gap);
      seen.add(key);
    }
    for (const section of collectActualSections(source)) {
      const key = `${chapter.title}|${section.title}|actual`;
      const plannedKey = `${chapter.title}|${section.title}|planned`;
      if (seen.has(key) || seen.has(plannedKey)) continue;
      const gap = gapForSection(chapter.title, section.title, section.level, section.body, false);
      if (gap && gap.reason === 'empty') gaps.push(gap);
      seen.add(key);
    }
  }
  return gaps;
}

export function sectionContentIntegrityIssues(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content' | 'sections'>>): ValidationIssue[] {
  return collectSectionContentGaps(markdown, chapters)
    .filter(gap => gap.reason === 'empty' || gap.reason === 'missing_planned_section')
    .map(gap => ({
      level: 'error' as const,
      message: gap.message,
      suggestion: gap.reason === 'missing_planned_section' ? '必须补充该规划小节正式正文，不得缺节导出。' : '必须补充与该小节相关的材料事实和必要内容，达到正文完整度要求。',
    }));
}

function normalizedFactValue(fact: DocumentFact) {
  return `${fact.fieldName || fact.key} ${stringifyFactValue(fact.value)}`.replace(/\s+/gu, ' ').trim();
}

function durationValues(text: string) {
  const values = new Set<string>();
  const patterns = [
    /\d+\s*日历天/gu,
    /(?:计划工期|合同工期|总工期|工期|施工周期)[^\n。；;]{0,12}\d+\s*天/gu,
    /(?:计划工期|合同工期|总工期|工期|施工周期)[^\n。；;]{0,12}\d+\s*(?:个月|月)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].match(/\d+\s*(?:日历天|天|个月|月)/u)?.[0]?.replace(/\s+/gu, '');
      if (value) values.add(value);
    }
  }
  return [...values];
}

// 同口径数值扫描：按“总量口径词 + 数值（可含万/千分位）+ 单位”模式提取取值，
// 供跨章一致性检测比对正文与资料口径是否一致（非 LLM 的确定性检查，零额外成本）
function scopedNumericEntries(text: string, scopeRe: RegExp, unitRe: RegExp) {
  const entries: Array<{ value: string; unit: string }> = [];
  const seen = new Set<string>();
  const pattern = new RegExp(`(?:${scopeRe.source})(?:[^\\n。；;，,]{0,14}?)(\\d{2,}(?:[.,]\\d+)?\\s*万?)\\s*(${unitRe.source})`, 'giu');
  for (const match of text.matchAll(pattern)) {
    const value = match[1].replace(/[,，]/gu, '').replace(/\s+/gu, '');
    const unit = match[2];
    const key = `${value}|${unit}`;
    if (!value || seen.has(key)) continue;
    seen.add(key);
    entries.push({ value, unit });
  }
  return entries;
}

// 数值归一化到统一基准（元 / ㎡），使“35000㎡”与“3.5万㎡”、“35000万元”与“3.5亿元”可等价比较
function scaledNumericValue(entry: { value: string; unit: string }) {
  const normalized = entry.value.replace(/[,，]/gu, '').trim();
  const wan = /^([\d.]+)万/u.exec(normalized);
  const base = wan ? Number(wan[1]) * 10000 : Number(normalized);
  if (!Number.isFinite(base)) return Number.NaN;
  if (/亿元/u.test(entry.unit)) return base * 100000000;
  if (/万元/u.test(entry.unit)) return base * 10000;
  return base;
}

// 总量口径词：只比对总量口径（总建筑面积/建设规模/总用地面积），
// 子项口径（地上/地下/单栋）数值不同属正常分层，不视为冲突
const SCALE_SCOPE_RE = /总建筑面积|总建设规模|建设规模|总用地面积|总占地面积/u;
const SCALE_UNIT_RE = /㎡|m²|平方米/u;
const COST_SCOPE_RE = /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价|工程总投资|总投资|工程造价/u;
const COST_UNIT_RE = /万元|亿元/u;

export function crossChapterConsistencyIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const expectedSchedule = factsModel.schedule.map(normalizedFactValue).find(value => /\d+\s*(?:日历天|天|个月|月)|计划工期|合同工期/u.test(value));
  const expectedQuality = factsModel.quality.map(normalizedFactValue).find(value => /质量|合格|优良/u.test(value));
  if (expectedSchedule) {
    const expectedDuration = durationValues(expectedSchedule)[0];
    const durationMatches = durationValues(markdown);
    const conflicting = expectedDuration ? durationMatches.filter(item => item !== expectedDuration && /日历天/u.test(item)) : [];
    if (expectedDuration && conflicting.length >= 2) issues.push({ level: 'warning', message: `跨章一致性冲突：正文出现与资料工期不一致的表述 ${conflicting.slice(0, 6).join('、')}`, suggestion: `请统一使用资料中的工期口径：${expectedSchedule}` });
  }
  if (expectedQuality && !/质量标准|质量目标|合格|优良/u.test(markdown)) issues.push({ level: 'error', message: '跨章一致性缺口：正文未稳定体现资料中的质量目标', suggestion: `请在工程概况、质量保证和验收相关章节统一体现：${expectedQuality}` });
  // 建设规模口径冲突：资料中的总量面积与正文同口径数值比对，出现 2 个以上不同取值才报警（单一差异可能是表述误差）
  const expectedScale = factsModel.project.map(normalizedFactValue).find(value => /建设规模|建筑面积|占地面积|用地面积/u.test(value));
  if (expectedScale) {
    const scaleMain = scopedNumericEntries(expectedScale, SCALE_SCOPE_RE, SCALE_UNIT_RE)[0];
    const scaleMatches = scopedNumericEntries(markdown, SCALE_SCOPE_RE, SCALE_UNIT_RE);
    if (scaleMain) {
      const scaleConflicts = scaleMatches.filter(entry => scaledNumericValue(entry) !== scaledNumericValue(scaleMain));
      if (scaleConflicts.length >= 2) issues.push({ level: 'warning', message: `跨章一致性冲突：正文出现与资料建设规模不一致的表述 ${scaleConflicts.slice(0, 6).map(entry => `${entry.value}${entry.unit}`).join('、')}`, suggestion: `请统一使用资料中的建设规模口径：${expectedScale.slice(0, 80)}` });
    }
  }
  // 合同估算价口径冲突：估算价/最高限价等金额口径在正文中不得出现多个互相矛盾的取值
  const expectedCost = factsModel.project.map(normalizedFactValue).find(value => /合同估算|投资估算|最高投标限价|招标控制价|总投资|工程造价/u.test(value));
  if (expectedCost) {
    const costMain = scopedNumericEntries(expectedCost, COST_SCOPE_RE, COST_UNIT_RE)[0];
    const costMatches = scopedNumericEntries(markdown, COST_SCOPE_RE, COST_UNIT_RE);
    if (costMain) {
      const costConflicts = costMatches.filter(entry => scaledNumericValue(entry) !== scaledNumericValue(costMain));
      if (costConflicts.length >= 2) issues.push({ level: 'warning', message: `跨章一致性冲突：正文出现与资料估算价不一致的表述 ${costConflicts.slice(0, 6).map(entry => `${entry.value}${entry.unit}`).join('、')}`, suggestion: `请统一使用资料中的估算价口径：${expectedCost.slice(0, 80)}` });
    }
  }
  return issues;
}

export function managementMeasureNumberIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const managementNumberPattern = /(?:三检制|三级教育|三级管理|5S|24\s*小时|每日|每周|每月|一次|两次)/gu;
  for (const chapter of chapters) {
    const matches = [...new Set(chapter.content.match(managementNumberPattern) || [])];
    if (matches.length >= 3 && !/责任人|检查记录|整改|复查|验收|台账|交底|巡查|闭环/u.test(chapter.content)) {
      issues.push({ level: 'warning', message: `${chapter.title} 管理措施数字较多但缺少执行闭环：${matches.slice(0, 8).join('、')}`, suggestion: '这些管理数字可以保留，但需要补充责任主体、检查频次、记录台账、整改复查和闭环要求。' });
    }
  }
  return issues;
}

export function genericProfessionalContentIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>): ValidationIssue[] {
  const generic = /(?:加强组织领导|严格执行规范|落实责任制度|确保工程质量|强化过程管理|提高思想认识|完善管理体系|形成闭环管理)/gu;
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const matches = chapter.content.match(generic) || [];
    if (matches.length >= 6 && !/材料|工序|验收|复验|节点|风险|交底|隐蔽|检验批|进场/u.test(chapter.content)) issues.push({ level: 'error', message: `${chapter.title} 存在较多未绑定项目事实和工序控制点的泛化套话`, suggestion: '请替换为结合资料事实、施工对象、工序控制、验收资料和整改闭环的专业内容。' });
  }
  return issues;
}

function trustedFactCorpus(factsModel: DocumentFactsModel) {
  return [
    ...factsModel.project,
    ...factsModel.schedule,
    ...factsModel.quality,
    ...factsModel.safety,
    ...factsModel.resources,
    ...factsModel.preciseFacts,
    ...factsModel.bills,
    ...factsModel.drawings,
    ...factsModel.rules,
    ...factsModel.specifications,
  ].map(normalizedFactValue).join('\n');
}

function generatedFactTokenClass(token: string, context: string): 'hard' | 'soft' {
  const normalized = `${token} ${context}`;
  if (/三检制|三级|5S|24\s*小时|每日|每周|每月|一次|两次|责任制|制度/u.test(normalized)) return 'soft';
  if (/总工期|计划工期|合同工期|日历天/u.test(normalized)) return 'hard';
  if (/最高投标限价|招标控制价|合同估算价|投资估算|报价|金额|万元|元/u.test(normalized)) return 'hard';
  if (/(?:工程量|清单|建设规模|建筑面积|长度|材料|设备|规格|型号).{0,24}(?:m²|㎡|m3|m³|米|吨|套|台|个|项|%)/u.test(normalized)) return 'hard';
  // 国家标准/行业标准/地方标准编号是通用引用，不是项目特有事实，降级为 soft
  if (/GB\s*\d|JGJ\s*\d|CJJ\s*\d|ISO\s*\d|GB\/T|CECS\s*\d|DL\s*\d|YB\s*\d|SH\s*\d|SJ\/T\s*\d|CJJ\/T\s*\d|DB\s*\d/u.test(normalized)) return 'soft';
  if (/标准|规范|编号/u.test(normalized)) return 'hard';
  return 'soft';
}

export function generatedFactVerificationIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const corpus = trustedFactCorpus(factsModel);
  if (documentTextLength(corpus) < 80) return [];
  const issues: ValidationIssue[] = [];
  const compactCorpus = normalizeEngineeringTextForFactMatch(corpus);
  const hardSuspicious: string[] = [];
  const softSuspicious: string[] = [];
  for (const token of extractEngineeringMeasureTokens(markdown)) {
    const normalizedToken = normalizeEngineeringTextForFactMatch(token);
    const tokenIndex = markdown.indexOf(token);
    const context = tokenIndex >= 0 ? markdown.slice(Math.max(0, tokenIndex - 36), Math.min(markdown.length, tokenIndex + token.length + 36)) : markdown;
    const tokenClass = generatedFactTokenClass(token, context);
    if (tokenClass === 'hard' && !compactCorpus.includes(normalizedToken)) hardSuspicious.push(token);
    if (tokenClass === 'soft' && !compactCorpus.includes(normalizedToken)) softSuspicious.push(token);
  }
  const uniqueHardSuspicious = [...new Set(hardSuspicious)];
  const uniqueSoftSuspicious = [...new Set(softSuspicious)];
  if (uniqueHardSuspicious.length >= 2) issues.push({ level: 'warning', message: `生成后事实反查提示：正文出现资料事实主表中未找到的关键数字 ${uniqueHardSuspicious.slice(0, 8).join('、')}`, suggestion: '建议复核这些数字是否来自管理制度、规范要求或资料事实；如无依据，改为定性管理要求。' });
  if (uniqueSoftSuspicious.length >= 6) issues.push({ level: 'warning', message: `生成后事实反查提示：正文出现较多未在资料事实主表中反查到的管理数字 ${uniqueSoftSuspicious.slice(0, 10).join('、')}`, suggestion: '请确认这些管理数字属于通用制度、规范要求或项目资料事实；如无依据，建议改为定性管理要求。' });
  if (/质量目标|质量标准/u.test(markdown) && factsModel.quality.length > 0 && !factsModel.quality.some(fact => markdown.includes(stringifyFactValue(fact.value).slice(0, 18)))) issues.push({ level: 'warning', message: '生成后事实反查提示：正文质量目标表述未明显匹配质量事实主表', suggestion: '请使用资料中的质量目标原文或等价表述。' });
  return issues;
}

function professionalScoreThreshold(title: string) {
  if (/概况|工程|项目/u.test(title)) return { min: 5, focus: '事实依据、项目特异性' };
  if (/部署|总体|组织/u.test(title)) return { min: 6, focus: '组织结构、可执行闭环、跨章一致性' };
  if (/进度|工期/u.test(title)) return { min: 6, focus: '进度结构、工期一致性、纠偏机制' };
  if (/质量/u.test(title)) return { min: 6, focus: '质量深度、验收复验、资料闭环' };
  if (/安全|文明|危大|风险/u.test(title)) return { min: 6, focus: '风险覆盖、应急响应、检查整改' };
  if (/资源|材料|设备|劳动力/u.test(title)) return { min: 5, focus: '资源依据、进场调配、进度支撑' };
  return { min: 4, focus: '事实依据、专业深度、可执行性' };
}

export function professionalScoreIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const text = chapter.content;
    if (documentTextLength(text) < 800) continue;
    const factuality = /资料|招标|清单|图纸|标准|范围|工期|质量|验收/u.test(text) ? 2 : /项目|工程|要求/u.test(text) ? 1 : 0;
    const structure = /首先|其次|同时|最后|一是|二是|流程|步骤|阶段|组织顺序/u.test(text) ? 2 : /并且|同时|然后|因此/u.test(text) ? 1 : 0;
    const depth = /控制点|关键线路|复验|隐蔽验收|风险|交底|检验批|整改|闭环/u.test(text) ? 2 : /措施|要求|管理|检查/u.test(text) ? 1 : 0;
    const executable = /责任人|检查|记录|验收|整改|复查|进场|调配|应急/u.test(text) ? 2 : /落实|执行|安排|组织/u.test(text) ? 1 : 0;
    const specificity = /本项目|本工程|招标范围|工程量|建设地点|计划工期|质量目标/u.test(text) ? 2 : /项目|工程/u.test(text) ? 1 : 0;
    const consistency = /工期|质量|安全|资源|验收/u.test(text) ? 2 : /目标|要求/u.test(text) ? 1 : 0;
    const scores = { factuality, structure, depth, executable, specificity, consistency };
    const total = factuality + structure + depth + executable + specificity + consistency;
    const threshold = professionalScoreThreshold(chapter.title);
    if (total < threshold.min) {
      const weak = Object.entries(scores).filter(([, value]) => value < 1).map(([key]) => key).join('、') || threshold.focus;
      issues.push({ level: 'error', message: `${chapter.title} 专业评分不足：${total}/12，薄弱维度：${weak}`, suggestion: `请按章节任务卡补齐${threshold.focus}，并写出资料依据、实施流程、专业控制点和检查整改闭环。` });
    }
  }
  return issues;
}

export function professionalContentIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>): ValidationIssue[] {
  const rules = [
    { re: /进度|工期/u, need: /关键线路|穿插|纠偏|资源保障|节点|动态调整/u, message: '进度工期章节缺少关键线路、穿插施工或纠偏保障内容' },
    { re: /质量/u, need: /材料.*验收|复验|隐蔽验收|整改.*复验|质量.*资料|检验批/u, message: '质量章节缺少材料验收复验、隐蔽验收或整改复验闭环' },
    { re: /安全|文明|危大|风险/u, need: /风险|临电|消防|应急|检查.*整改|文明施工|人员|设备/u, message: '安全文明章节缺少风险识别、现场控制或应急检查闭环' },
    { re: /资源|材料|设备|劳动力/u, need: /进场|验收|调配|保管|供应|投入计划/u, message: '资源章节缺少进场、验收、调配或保管计划' },
    { re: /施工|工艺|技术|方案/u, need: /准备|流程|工艺|控制点|验收|交底/u, message: '施工技术章节缺少施工准备、工艺流程、控制点或验收要求' },
  ];
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const text = chapter.content;
    for (const rule of rules) {
      if (rule.re.test(chapter.title) && documentTextLength(text) >= 600 && !rule.need.test(text)) issues.push({ level: 'error', message: `${chapter.title}：${rule.message}`, suggestion: '请按专业任务卡定向补写该章节，补齐可实施的控制措施、资料依据和闭环要求。' });
    }
  }
  return issues;
}

function shouldIgnorePreciseToken(token: string, context: string) {
  if (/万元|元|报价|单价|合价|综合单价|预留金|税率|增值税|利润|结算/u.test(`${token} ${context}`)) return true;
  if (/OCR|识别错误|乱码|无法确认|疑似|不确定|语义断裂|页码|目录/u.test(context)) return true;
  if (/^\d+$/.test(token) && Number(token) < 10) return true;
  return false;
}

function collectPreciseFactTokens(factsModel: DocumentFactsModel) {
  const tokens = new Set<string>();
  for (const fact of factsModel.preciseFacts) {
    const source = `${fact.processingType || ''} ${fact.roleId} ${fact.sourceFile}`;
    if (!PRECISE_FACT_SOURCE_RE.test(source) && fact.roleId !== 'precise_fact') continue;
    const context = `${fact.key} ${fact.fieldName || ''} ${fact.value}`;
    for (const match of context.matchAll(PRECISE_FACT_TOKEN_RE)) {
      const token = match[0].trim();
      if (!shouldIgnorePreciseToken(token, context)) tokens.add(token);
    }
  }
  return [...tokens];
}

/** 日历日期噪声：年份（2024年）与月份（12月）不是工程参数，不计入抽查池 */
function isCalendarNoiseToken(token: string) {
  return /^\d{4}\s*年$/u.test(token) || /^\d{1,2}\s*月$/u.test(token);
}

/** 章节证据窗口内的精确参数 token 集合：抽查口径与 LLM 实际可见证据对齐 */
function collectEvidencePreciseTokens(chapters: DocumentDraftChapter[]) {
  const tokens = new Set<string>();
  for (const chapter of chapters) {
    for (const item of chapter.evidence || []) {
      const content = typeof item.content === "string" ? item.content : "";
      for (const match of content.matchAll(PRECISE_FACT_TOKEN_RE)) {
        const token = match[0].trim();
        if (!token || isCalendarNoiseToken(token)) continue;
        const index = match.index || 0;
        const context = content.slice(Math.max(0, index - 40), index + token.length + 40);
        if (!shouldIgnorePreciseToken(token, context)) tokens.add(token);
      }
    }
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

// 关键精确参数抽查：高价值单位（工期/面积/强度/规范编号等）优先进入抽查池，
// 这类参数是施组评审最关注的核心工程参数，比一般规格数字更需要保证写入正文
const PRECISE_FACT_CRITICAL_SPOT_COUNT = 6;
const PRECISE_FACT_CRITICAL_MIN_RATE = 0.5;
const CRITICAL_PRECISE_UNIT_RE = /日历天|个月|㎡|m²|m3|m³|MPa|kPa|kN|GB\/T|GB|JGJ|ISO|DN|φ|Φ|米\/秒|天$/u;

function criticalPreciseTokens(tokens: string[]) {
  // 先确定性排序（字典序）再分层抽样：消除上游 LLM 提取顺序对抽查池的随机影响，
  // 保证同一项目重跑时抽查池与判定结果可复现
  const sorted = [...tokens].sort((a, b) => a.localeCompare(b, "zh"));
  const critical = sorted.filter(token => CRITICAL_PRECISE_UNIT_RE.test(token));
  const rest = sorted.filter(token => !CRITICAL_PRECISE_UNIT_RE.test(token));
  // 分层抽样：关键单位优先进入抽查池，但保留少量常规规格 token，
  // 避免关键 token 过多时抽查池被单一单位类型（如大量面积值）占满而失去代表性
  return [...critical.slice(0, 8), ...rest.slice(0, 2)].slice(0, 10);
}

export function preciseFactUsageIssues(markdown: string, factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[] = []): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const normalized = markdown.replace(WHITESPACE_RE, '');
  // 抽查口径对齐：优先使用章节证据窗口内的精确参数（LLM 实际收到的证据），
  // 消除“全项目精确事实中从未进入证据窗口”参数的结构性假阳性；
  // 证据池过小（章节 evidence 缺失或参数过少）时回退全项目精确事实池，保持门禁兜底能力
  const evidenceTokens = collectEvidencePreciseTokens(chapters);
  const tokens = evidenceTokens.length >= PRECISE_FACT_MIN_TOKEN_COUNT ? evidenceTokens : collectPreciseFactTokens(factsModel);
  const used = countUsedPreciseTokens(tokens, normalized);
  if (tokens.length >= PRECISE_FACT_MIN_TOKEN_COUNT && used / tokens.length < PRECISE_FACT_MIN_USAGE_RATE) issues.push({ level: 'warning', message: `可靠精确参数使用不足：${used}/${tokens.length}`, suggestion: '请将资料中可靠的规格、参数、数量、时间、比例和标准编号写入对应章节；商务金额、单价、税率、预留金不得写入正文。' });
  // 关键参数抽查：对高价值精确参数单独抽查使用率，过低时升级为 error，
  // 使导出门禁的“结构化精确参数已使用”检查项显式失败（有正文时不硬阻断导出，避免卡死交付）
  const criticalTokens = criticalPreciseTokens(tokens);
  if (criticalTokens.length >= PRECISE_FACT_CRITICAL_SPOT_COUNT) {
    const criticalUsed = countUsedPreciseTokens(criticalTokens, normalized);
    if (criticalUsed / criticalTokens.length < PRECISE_FACT_CRITICAL_MIN_RATE) {
      const missingCritical = criticalTokens.filter(token => !normalized.includes(token.replace(WHITESPACE_RE, ''))).slice(0, 3);
      issues.push({ level: 'error', message: `可靠精确参数使用不足：关键参数抽查 ${criticalUsed}/${criticalTokens.length}${missingCritical.length ? `（缺失如 ${missingCritical.join('、')}）` : ''}`, suggestion: '请将资料中的关键工程参数（工期、面积、强度等级、材料规格、规范编号等）写入正文对应章节，不得因参数总量达标而遗漏核心参数。' });
    }
  }
  if (factsModel.bills.length > 0 && !STRUCTURED_DATA_CONTENT_RE.test(markdown)) issues.push({ level: 'error', message: '正文未体现结构化数据资料', suggestion: '请从表格、列表或明细中提取对象、单位、数量、规格和关键参数补入对应章节。' });
  if (factsModel.drawings.length > 0 && !SPECIFICATION_CONTENT_RE.test(markdown)) issues.push({ level: 'error', message: '正文未体现设计/方案/说明类资料', suggestion: '请从设计、方案或说明资料中提取对象、流程、节点、做法、配置、规则和标准要求。' });
  return issues;
}

/** 清单落位校验：逐行检查 BOQ 表格中的清单项是否在正文中落位 */
export function boqPlacementIssues(markdown: string, _chapters: DocumentDraftChapter[], factsModel: DocumentFactsModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tables = factsModel.tables || [];
  if (tables.length === 0) return issues;

  const normalizedMarkdown = markdown.replace(/\s+/gu, '').toLowerCase();
  let totalRows = 0;
  let placedRows = 0;
  const unplacedSamples: string[] = [];

  for (const table of tables) {
    const headers = table.headers.map(h => h.replace(/\s+/gu, '').toLowerCase());
    const nameCol = headers.findIndex(h => /项目名称|^名称$|清单项|分部分项|项目特征/u.test(h));
    const codeCol = headers.findIndex(h => /项目编码|编码|编号/u.test(h)); // 不含"序号"，避免序列号误匹配
    const qtyCol = headers.findIndex(h => /^工程量$|^数量$/u.test(h)); // 不含"单位"，避免单位列误读为数量

    for (const row of table.rows) {
      totalRows += 1;
      const itemName = nameCol >= 0 ? (row[nameCol] || '').replace(/\s+/gu, '') : '';
      const itemCode = codeCol >= 0 ? (row[codeCol] || '').replace(/\s+/gu, '') : '';
      const quantity = qtyCol >= 0 ? (row[qtyCol] || '').replace(/\s+/gu, '') : '';

      // 检查清单项名称或编码是否在正文中出现（统一使用 16 字符前缀匹配）
      const namePrefix = itemName.length >= 3 ? itemName.slice(0, Math.min(itemName.length, 16)) : '';
      const codePrefix = itemCode.length >= 3 ? itemCode.slice(0, Math.min(itemCode.length, 12)) : '';
      const namePlaced = namePrefix && normalizedMarkdown.includes(namePrefix);
      const codePlaced = codePrefix && normalizedMarkdown.includes(codePrefix);

      if (namePlaced || codePlaced) {
        placedRows += 1;
      } else if (itemName.length >= 3) {
        unplacedSamples.push(`${itemName.slice(0, 40)}${quantity ? ` ${quantity}` : ''}（未落位）`);
      }
    }
  }

  if (totalRows > 0) {
    const rate = placedRows / totalRows;
    const unplacedSummary = unplacedSamples.length > 0
      ? `未落位项（共${unplacedSamples.length}项）：${unplacedSamples.slice(0, 12).join('；')}${unplacedSamples.length > 12 ? ` 及其他${unplacedSamples.length - 12}项` : ''}`
      : '';
    if (rate < 0.3) {
      issues.push({ level: 'warning', message: `清单项落位严重不足：${placedRows}/${totalRows} 项（${Math.round(rate * 100)}%）`, suggestion: `清单明细数量较大，建议优先补充主要分部分项、关键规格和大额工程量。${unplacedSummary}` });
    } else if (rate < 0.6) {
      issues.push({ level: 'warning', message: `清单项落位不足：${placedRows}/${totalRows} 项（${Math.round(rate * 100)}%）`, suggestion: `建议补充落位以下清单项：${unplacedSummary}` });
    }
  }

  return issues;
}

/** 图纸引用校验：检查图纸/设计资料是否在正文中被引用 */
export function drawingReferenceIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const drawings = factsModel.drawings || [];
  if (drawings.length === 0) return issues;

  const normalizedMarkdown = markdown.replace(/\s+/gu, '').toLowerCase();
  const drawingSourceFiles = [...new Set(drawings.map(d => d.sourceFile || '').filter(Boolean))];
  let referencedFiles = 0;
  const unreferencedFiles: string[] = [];

  for (const file of drawingSourceFiles) {
    const baseName = file.replace(/\.[^.]+$/u, '').replace(/[/\\]/gu, '').toLowerCase();
    const displayName = file.split('/').pop() || file;
    // 短文件名（< 3 字符）不参与精确匹配，改为检查是否包含图纸关键词
    const matched = baseName.length >= 3
      ? normalizedMarkdown.includes(baseName.slice(0, Math.min(baseName.length, 12)))
      : /图纸|设计|说明|节点|做法|构造/u.test(normalizedMarkdown);
    if (matched) {
      referencedFiles += 1;
    } else {
      unreferencedFiles.push(displayName);
    }
  }

  if (drawingSourceFiles.length > 0) {
    const rate = referencedFiles / drawingSourceFiles.length;
    if (rate < 0.25) {
      issues.push({ level: 'warning', message: `图纸引用严重不足：${referencedFiles}/${drawingSourceFiles.length} 份图纸被正文引用（${Math.round(rate * 100)}%）`, suggestion: `建议将图纸中的设计说明、构造做法、材料规格和设备参数写入对应章节。未引用图纸：${unreferencedFiles.slice(0, 5).join('、')}` });
    } else if (rate < 0.5) {
      issues.push({ level: 'warning', message: `图纸引用不足：${referencedFiles}/${drawingSourceFiles.length} 份（${Math.round(rate * 100)}%）`, suggestion: `建议补充引用：${unreferencedFiles.slice(0, 5).join('、')}` });
    }
  }

  return issues;
}

export function formalPlaceholderIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (/【本小节生成未达标，需重新生成】/u.test(markdown)) issues.push({ level: 'error', message: '生成未完成：存在未达标小节，需要重新生成或补写后才能导出', suggestion: '请重新生成未达标小节，禁止将占位内容作为正式正文。' });
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

/** 判断禁用词是否真正命中：允许“见图纸/按图纸”后接“目录/清单/索引/汇总”表示引用正文中的正式目录章节，属于合法交叉引用。 */
function containsForbiddenText(markdown: string, item: string): boolean {
  const legitimateSuffixes = item === '见图纸' || item === '按图纸' ? ['目录', '清单', '索引', '汇总'] : [];
  let from = 0;
  for (;;) {
    const index = markdown.indexOf(item, from);
    if (index < 0) return false;
    const after = markdown.slice(index + item.length);
    if (legitimateSuffixes.some(suffix => after.startsWith(suffix))) {
      from = index + item.length;
      continue;
    }
    return true;
  }
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
    for (const item of gate.requiredTexts) if (!markdown.includes(item)) issues.push({ level: 'warning', message: `配置要求缺少必要内容：${item}`, suggestion: '请按当前模板匹配的专业规则补齐必要内容。' });
    for (const item of gate.forbiddenTexts) if (containsForbiddenText(markdown, item)) issues.push({ level: 'error', message: `配置要求不得出现：${item}`, suggestion: '请根据当前模板匹配的专业规则清理正文污染内容。' });
  }
  if (MARKDOWN_TOP_HEADING_RE.test(markdown)) issues.push({ level: 'error', message: '正式正文存在 Markdown 标题符号 #', suggestion: '导出正文应去除 Markdown 标题符号，保留正式标题文字。' });
  if (minTables && tableCount < minTables) issues.push({ level: 'warning', message: `配置要求正式表格不足：${tableCount}/${minTables}`, suggestion: '如用户提示词或章节内容要求表格，应按项目资料补充对应表格本体。' });
  return issues;
}

/** 模板命中的 autoSpecGates 禁止词列表：供确定性修复链在写入正文前过滤、并兜底清除残留出现 */
export function autoSpecGateForbiddenTexts(template: DocumentTemplate): string[] {
  const text = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  const forbidden = new Set<string>();
  for (const gate of readEngineeringDocumentConfig().autoSpecGates) {
    if (templateMatchesAutoSpecGate(text, gate.templateMatchers)) {
      for (const item of gate.forbiddenTexts) if (item) forbidden.add(item);
    }
  }
  return [...forbidden];
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

// 以下事实字段不属于“项目专属事实”，而是公共法规规范或通用施工组织推导内容，
// 应由 LLM 依据现行法规、行业规范与企业施工经验自行撰写，不要求从项目知识库逐条确认。
// 项目资料通常不包含法规原文、资源配置计划或通用工艺控制点，强校验会产生误导性告警。
function isLlmAuthoredFactName(name: string) {
  return /国家法律法规|地方法规|规章|规范标准|标准规范|行业标准|现行规范|法律法规|合规|施工方法|工艺流程|质量控制|安全文明|应急|劳动力|材料投入|机械设备|检测仪器|关键节点/u.test(name);
}

function validateRequiredSpecFields(spec: AutoDocumentSpecPackage, chapters: DocumentDraftChapter[], factNames: Set<string>, factsModel: DocumentFactsModel, next: ValidationIssue[]) {
  for (const field of spec.factFields) {
    if (!field.required || isLlmAuthoredFactName(field.name)) continue;
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
    if (schemaFacts.length === 0 && !factNames.has(field.name) && !satisfiedByChapterEvidence) next.push({ level: 'warning', message: `系统暂未从知识库确认必需事实：${field.name}`, suggestion: field.extractionHint || '请扩大本地知识库检索、执行事实补抽，或调整事实字段配置。' });
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

export function applySpecGateRules(spec: AutoDocumentSpecPackage | undefined, issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[], markdown: string, projectBindings: ProjectBinding[], promptBindings: PromptBinding[]) {
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
      projectBindings,
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
