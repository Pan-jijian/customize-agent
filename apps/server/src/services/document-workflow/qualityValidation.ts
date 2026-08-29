import type { AutoDocumentSpecGateRule, AutoDocumentSpecPackage, GateRuleEvaluator } from '../document-core/autoDocumentSpecTypes';
import { readEngineeringDocumentConfig } from '../document-validation/engineeringDocumentConfigService';
import { CHAPTER_HEADING_RE, EXPORT_BLOCKING_ISSUE_RE, EXPORT_GATE_PRECISION_ISSUE_RE, EXPORT_GATE_PROJECT_CONTAMINATION_RE, FALLBACK_GATE_EVALUATORS, FORMAL_PLACEHOLDER_PATTERNS, LINE_SPLIT_RE, MARKDOWN_IMAGE_RE, MARKDOWN_SECTION_HEADING_RE, MARKDOWN_TABLE_BLOCK_SPLIT_RE, MARKDOWN_TABLE_DIVIDER_RE, MARKDOWN_TABLE_ROW_RE, MARKDOWN_TOP_HEADING_RE, NON_BLANK_RE, PRECISE_FACT_MIN_TOKEN_COUNT, PRECISE_FACT_MIN_USAGE_RATE, PRECISE_FACT_SOURCE_RE, PRECISE_FACT_TOKEN_RE, DOCUMENT_BASIC_INFO_BLOCK_RE, DOCUMENT_BASIC_INFO_FIELDS, DOCUMENT_BASIC_INFO_TABLE_RE, PROMPT_EXAMPLE_BLOCK_RE, QUALITY_SEVERITY_RULES, SPEC_GATE_RULE_HANDLERS, SPECIFICATION_CONTENT_RE, STRUCTURED_DATA_CONTENT_RE, TOC_BLOCK_RE, TOC_INDENTED_SECTION_LINE_RE, TOC_SECTION_LINE_RE, WHITESPACE_RE } from '../constants';
import type { QualitySeverity, QualitySeveritySummary, SpecGateRuleContext } from '../types';
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel, DocumentTemplate, ExportGateResult, NumericScopeConflict, ProjectBinding, PromptBinding, ValidationIssue } from './types';
import type { FactTokenScopeClassifier } from './factTokenClassifier';
import type { SemanticSimilarityFn } from './semanticSimilarity';
import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';
import type { DepthDimension, ProfessionalDepthAnalysis } from './professionalDepthClassifier';
import { documentTextLength, estimateDocumentPages } from './budget';
import { extractEngineeringMeasureTokens, normalizeEngineeringTextForFactMatch } from './engineeringUnits';
import { displayChapterTitle } from './outline';
import { evidenceSatisfiesSpecField } from './factMatching';
import { readPromptContents } from './templateStore';
import { extractSection, stringifyFactValue } from './utils';
import { fiveElementBlockStats } from './tenderBidChecks';

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
  if (/证据使用覆盖率偏低|BOQ|落位|高分模块|专业链|闭环/u.test(issue.message)) {
    // Q1/Q11 修复链：清单落位与关键参数抽查升级为 error 后必须进修复循环（原 not_repair_needed 导致检测到却永不修复）
    if (issue.level === 'error') return { ...issue, severity: 'blocker', repairability: 'llm_repairable', category: 'evidence_coverage', owner: 'llm' };
    return { ...issue, severity: 'warning', repairability: 'not_repair_needed', category: 'evidence_coverage', owner: 'system' };
  }
  if (issue.level === 'error') return { ...issue, severity: 'blocker', repairability: 'llm_repairable', category: 'structure', owner: 'system' };
  if (issue.level === 'warning') return { ...issue, severity: 'warning', repairability: 'not_repair_needed', category: 'style', owner: 'system' };
  return { ...issue, severity: 'suggestion', repairability: 'not_repair_needed', category: 'style', owner: 'system' };
}

function isHardExportBlockingIssue(issue: ValidationIssue) {
  const governedIssue = classifyValidationIssue(issue);
  if (governedIssue.severity !== 'blocker') return false;
  // round-20 S5/W8：评审轮问题按 category 直通硬阻断（复评残留的否决级/高风险），不再依赖消息正则
  if (governedIssue.category === 'qingtian_review') return true;
  if (governedIssue.level === 'error' && governedIssue.severity === 'blocker' && /placeholder|source|style|format|structure/u.test(String(governedIssue.category || ''))) return true;
  if (/提示词要求|疑似提示词指令标题|适用性自相矛盾|不得出现/u.test(issue.message)) return true;
  if (/目录与正文/u.test(issue.message)) return false;
  if (/配置要求缺少必要内容/u.test(issue.message)) return issue.level === 'error';
  if (/小节内容补写未完成|空小节|小节只有标题|生成未完成/u.test(issue.message)) return true;
  if (/生成后事实反查失败/u.test(issue.message)) return false;
  if (/工序规格冲突/u.test(issue.message)) return issue.level === 'error';
  if (/项目特点、重点、难点分析 正文不足|项目主要施工内容 正文不足/u.test(issue.message)) return true;
  if (/规划小节正文过短/u.test(issue.message)) return false;
  if (/事实一致性冲突：项目名称/u.test(issue.message)) return false;
  if (/跨章一致性|专业评分不足|专业缺口|泛化套话|缺少关键线路|缺少材料验收|缺少风险识别|缺少进场/u.test(issue.message)) return issue.level === 'error' && !/证据使用覆盖率偏低|章节逻辑依赖不足|文档交付评分报告/u.test(issue.message);
  if (!isExportBlockingIssue(issue)) return false;
  if (/章节审查|最终质量审查|正文篇幅明显低于目标|正文存在空泛占位表达|结构化事实读取不足|正文可能未显式覆盖|仅包含文件类型和占位符|不在本次招标范围内/u.test(issue.message)) return false;
  return true;
}

/**
 * 同章内同名三级小节重复检测：主题块/补写链路反复追加同名 H4 小节（真实生成缺陷：1.4 出现 4 个“工程难点分析”、2.14 出现 4 个隐蔽验收主题小节），
 * 归一化去编号/空白后同章重复 ≥2 次给出合并/重命名建议。
 * round-20 S6：level warning → error——目录重复堆叠是青天规范硬扣分点（首次徽光阁实测 7 组同名 H4 仅 warning 永不修复），
 * error 化后进入交付阻断修复链（duplicate-subsection 分支）自动合并。
 */
export function headingDuplicateIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const chapterParts = markdown.split(/^##\s+/gmu).slice(1);
  for (const part of chapterParts) {
    const lines = part.split(/\r?\n/u);
    const chapterTitle = (lines.shift() || '').trim();
    const counts = new Map<string, number>();
    for (const line of lines) {
      const headingMatch = /^####\s+(.+)$/u.exec(line.trim());
      if (!headingMatch) continue;
      const key = headingMatch[1].replace(/^\d+(?:\.\d+)*\s*/u, '').replace(/\s+/gu, '');
      if (key.length < 2) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [name, count] of counts) {
      if (count < 2) continue;
      issues.push({ level: 'error', message: `${chapterTitle || '某章'} 存在同名小节重复：“${name}”出现 ${count} 次`, suggestion: '同主题内容应合并为一个小节；若确为不同方面，请重命名标题以区分内容，避免目录重复堆叠。' });
      if (issues.length >= 6) return issues;
    }
  }
  return issues;
}

/** 评分条目标题的框架停用词（核心词提取时剔除，精确匹配整词） */
const CRITERIA_CORE_STOP_WORDS = new Set(['如有', '应用', '措施', '体系', '管理', '保障', '要求', '内容', '工程', '项目', '施工']);

/** 招标评分条目标题 → 核心关键词集：去框架前缀/括号/尾缀后按顿号及与切分，供正文命中检查 */
export function evaluationCriteriaCoreKeywords(title: string): string[] {
  const cleaned = title
    .replace(/^拟采用/u, '').replace(/^针对/u, '').replace(/^确保/u, '')
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/的保障体系与措施$|管理体系与措施$|保障体系与措施$/u, '')
    .trim();
  return cleaned.split(/[、，,；;及与和]+/u)
    .map(part => part.replace(/^[的了者]+/u, '').trim())
    .filter(part => part.length >= 2 && !CRITERIA_CORE_STOP_WORDS.has(part));
}

/**
 * 招标评分条目正文承接后置校验：已提取的评审条目若核心关键词在最终正文 0 次出现，报 warning。
 * 前置补小节只能保证大纲覆盖，主题块规划/成稿阶段仍可能把补入小节合并丢失（历史缺陷：
 * “拟采用的新技术、新工艺”整篇 0 次出现），后置命中检查是承接链的最后一道兑底。
 * round-14 零误伤：词面未命中时由 bge 语义相似度兑底（变体表述不误报）；调用方未提供相似度函数时
 * 仅词面命中判定，宁漏报不误报。
 */
export function evaluationCriteriaCoverageIssues(
  markdown: string,
  items: string[],
  options: { semanticSimilarity?: SemanticSimilarityFn } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const normalized = markdown.replace(/\s+/gu, '');
  const chapterLines = options.semanticSimilarity
    ? markdown.split(/\n/u).filter(line => /^#{2,4}\s/u.test(line.trim())).map(line => line.trim().replace(/^#{2,4}\s+/u, '').replace(/^\d+(?:\.\d+)*[\s、.]+/u, '').trim()).filter(Boolean).slice(0, 80)
    : [];
  for (const item of items.slice(0, 8)) {
    const keywords = evaluationCriteriaCoreKeywords(item);
    if (keywords.length === 0) continue;
    if (keywords.some(keyword => normalized.includes(keyword))) continue;
    // 语义兑底：核心词词面未命中时，条目标题与章节标题的 bge 余弦 ≥0.6 视为已承接（变体表述不误报）
    if (options.semanticSimilarity && chapterLines.length > 0) {
      const best = Math.max(...chapterLines.map(line => options.semanticSimilarity!(item, line)));
      if (best >= 0.6) continue;
    }
    issues.push({ level: 'warning', severity: 'warning', message: `招标文件评分条目“${item}”未在正文中出现（核心词：${keywords.join('/')}）`, suggestion: '评审条目必须逐条承接为正文小节；请补写对应内容并确保核心关键词落位，避免评标失分。' });
  }
  return issues;
}

/**
 * 内部术语泄漏保险丝（词面标记，不做替换）：后台概念流入正式正文属交付级低级错误，
 * 术语改写是语义动作必须由 Repairer 按上下文完成（如“工作包”按语境改写为“拆除工程/专业工程”），
 * 这里只做词面标记触发修复循环；若仍残留则硬阻断，绝不静默放行（真实生成缺陷：“拆除工程工作包”标题进入交付稿未被任何评分发现）。
 */
export function internalTerminologyIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (/工作包/u.test(markdown)) {
    issues.push({ level: 'error', severity: 'blocker', category: 'format', owner: 'system', message: '正式正文仍包含后台内部术语“工作包”，需要按上下文语义改写为正式术语', suggestion: '请结合语境改写：“拆除工程工作包”→“拆除工程”，“按工作包逐项说明”→“按专业工程逐项说明”；禁止出现生成系统后台概念。' });
  }
  return issues;
}

/**
 * 四新技术后置承接检查（小节成稿结构检查，不做关键词语义判断）：施工组织设计大纲通过标准模块挂靠
 * 承诺了四新小节（如“新技术、新工艺、新材料、新设备的应用”），最终正文必须有对应小节标题且正文成稿
 * （承诺小节在主题块合并/降级中丢失的真实缺陷）；大纲未承诺时不制造新义务（避免对未要求的文档类型误报）。
 * 成稿但内容空洞的风险由事实密度/闭环句式/Reviewer 维度覆盖，此处不越界做语义判断。
 */
export function innovationTechCoverageIssues(markdown: string, outlineChapters: Array<{ title?: string; sections?: string[] }>): ValidationIssue[] {
  const committedSections = (outlineChapters || []).flatMap(chapter => (chapter.sections || []).filter(section => /新技术|新工艺|新材料|新设备|四新/u.test(section)));
  if (committedSections.length === 0) return [];
  const issues: ValidationIssue[] = [];
  // 合并成稿兜底：正文常把承诺的多个四新细化小节（新技术/新工艺/新材料/新设备的应用）合并为
  // “四新技术应用管理”等单一成稿小节（主题块合并是合法设计），逐个小节标题 fuzzy 匹配必然失败，
  // 会误报“0 字”（十四度实测：正文 2.14.1 四新技术应用管理已成稿仍被报未成稿）。
  // 承诺仍未兑现的判定不受影响：正文无任何“四新”小节成稿时兜底不生效，照常报 warning。
  const mergedBody = extractSection(markdown, '四新', { fuzzy: true });
  const mergedLength = mergedBody ? documentTextLength(mergedBody) : 0;
  for (const sectionTitle of [...new Set(committedSections)]) {
    const body = extractSection(markdown, sectionTitle, { fuzzy: true });
    if (!body || documentTextLength(body) < 200) {
      if (mergedLength >= 200) continue;
      issues.push({ level: 'warning', severity: 'warning', message: `大纲承诺小节“${sectionTitle}”未在正文成稿（正文 ${body ? documentTextLength(body) : 0} 字，要求不少于 200 字）`, suggestion: '请补写四新技术应用小节成稿，落位本项目适用的创新工艺、新材料与新设备应用计划。' });
    }
  }
  return issues;
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
  // 人工兜底项豁免（F4）：封面/页眉/页脚/附图等后期人工完善的内容不作为导出门禁阻断项，
  // 修复循环同样不消费预算处理该类缺陷；仅在 checklist 中展示供人工跟进
  const MANUAL_POSTPROCESS_ISSUE_RE = /封面|页眉|页脚|附图|图片引用|CAD图|示意图|插图/u;
  const hardBlockingIssues = governedIssues.filter(issue => issue.level === 'error' && isHardExportBlockingIssue(issue) && !MANUAL_POSTPROCESS_ISSUE_RE.test(issue.message));
  const manualPostprocessIssues = governedIssues.filter(issue => issue.level === 'error' && MANUAL_POSTPROCESS_ISSUE_RE.test(issue.message));
  // 已生成实质正文时仍保留关键结构阻断（缺节、空小节、生成未达标、正文不足等），仅豁免其余软性门禁，避免质量门禁卡住交付。
  // 跨章一致性（含数值口径冲突与复核残留）是用户明确的低级错误红线，有正文时同样硬阻断。
  // round-20 S5/W8：消息正则白名单升级为 category 白名单判定（structure 结构完整/style 禁止话术/fact_consistency 数据一致性
  // /qingtian_review 评审轮残留），根治“新检测器上线不更新门禁”陷阱——新检测器只要正确标注 category 即自动纳入硬阻断，
  // 不再依赖手工维护消息正则清单。
  const CRITICAL_BLOCK_CATEGORIES = new Set(['structure', 'style', 'fact_consistency', 'qingtian_review']);
  const blockingIssues = hasBody ? hardBlockingIssues.filter(issue => CRITICAL_BLOCK_CATEGORIES.has(String(issue.category || ''))) : hardBlockingIssues;
  const checklist = [
    { key: 'no_errors', label: '无阻断级校验错误', passed: blockingIssues.length === 0 },
    { key: 'basic_facts', label: '基础事实齐全', passed: factsModel.project.length > 0 },
    { key: 'source_traceability', label: '事实具备来源追踪', passed: [...factsModel.project, ...factsModel.schedule, ...factsModel.quality, ...factsModel.safety].every(fact => Boolean(fact.sourceFile)) },
    { key: 'structured_precision', label: '结构化精确参数已使用', passed: factsModel.preciseFacts.length < PRECISE_FACT_MIN_TOKEN_COUNT || issues.every(issue => issue.level !== 'error' || !EXPORT_GATE_PRECISION_ISSUE_RE.test(issue.message)) },
    { key: 'chapter_evidence', label: '章节均具备证据', passed: chapters.every(chapter => chapter.evidence.length > 0) },
    { key: 'no_missing_content', label: '无资料未提供章节', passed: chapters.every(chapter => !chapter.content.includes('资料未提供')) },
    { key: 'no_project_contamination', label: '无项目污染和事实一致性阻断', passed: !issues.some(issue => issue.level === 'error' && EXPORT_GATE_PROJECT_CONTAMINATION_RE.test(issue.message) && isHardExportBlockingIssue(issue)) },
    // 数字级口径不一致（建设规模/估算价/工期与资料不符）属低级错误，导出门禁必须拦截
    { key: 'numeric_consistency', label: '跨章数值口径与资料一致', passed: !issues.some(issue => issue.level === 'error' && /跨章一致性冲突|跨章一致性缺口|跨章一致性复核/u.test(issue.message) && isHardExportBlockingIssue(issue)) },
    // 人工兜底项：封面/页眉/页脚/附图由后期人工完善，不阻断导出，仅展示跟进
    { key: 'manual_postprocess', label: `封面/页眉页脚/附图等 ${manualPostprocessIssues.length} 项由后期人工完善（不阻断导出）`, passed: true, message: manualPostprocessIssues.length ? manualPostprocessIssues.slice(0, 5).map(issue => issue.message).join('；') : undefined },
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

/** 模板化前缀/导语语义原型（章节开场白与总结语模板，bge 余弦 ≥ 阈值判定套话前缀句） */
const FORMAL_STYLE_SEMANTIC_QUERIES = [
  '本节将详细介绍以下内容',
  '本章将从以下几个方面进行阐述',
  '综上所述，通过以上分析得出结论',
  '以下内容将围绕该主题展开论述',
] as const;

export async function formalStyleIssues(markdown: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const sentences = markdown
    .split(/\n+/u)
    .filter(line => line.trim() && !/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(line))
    .flatMap(line => line.split(/[。；;]/u))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 8);
  const styleSimilarity = await buildSemanticSimilarity(sentences, [...FORMAL_STYLE_SEMANTIC_QUERIES]);
  const hit = sentences.filter(sentence =>
    FORMAL_STYLE_SEMANTIC_QUERIES.some(query => styleSimilarity(sentence, query) >= SEMANTIC_COVERAGE_THRESHOLD));
  if (hit.length > 0) issues.push({ level: 'warning', message: `存在模板化前缀或套话：${hit.slice(0, 3).join('、')}`, suggestion: '请删除“本节/本章将/以下从”等前缀，标题后直接进入对象、动作、措施、检查和闭环。' });
  // 后台话术为专有名词泄漏（OCR/提示词/后台等词字面出现即违规），保留词面精确召回
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
  if (missingInToc.length > 0) issues.push({ level: 'error', message: `目录与正文不一致，正文小节未进入目录：${[...new Set(missingInToc)].join('、')}`, suggestion: '建议重新生成目录，确保正文二级小节完整进入目录。' });
  return issues;
}

/** 目录三级小节完整性（h13d）：正文存在 #### X.Y.Z 三级小节时，目录必须在对应二级小节下
 * 以缩进行收录同编号三级条目。合肥师范实测：正文 3.1.1/3.1.2/3.1.3 三级小节目录全部缺收。 */
export function tocThirdLevelCompletenessIssues(markdown: string): ValidationIssue[] {
  const tocMatch = TOC_BLOCK_RE.exec(markdown);
  const tocBody = tocMatch?.[1] ?? '';
  const thirdLevel = [...markdown.matchAll(/^####\s+(\d+\.\d+\.\d+\s+.+)$/gmu)]
    .map(match => normalizeStructureTitle(match[1] || ''))
    .filter(Boolean);
  if (thirdLevel.length === 0) return [];
  const tocThird = [...tocBody.matchAll(/^\s{2,}(\d+\.\d+\.\d+\s+\S.+)$/gmu)]
    .map(match => normalizeStructureTitle(match[1] || ''))
    .filter(Boolean);
  const missing = [...new Set(thirdLevel.filter(title => !tocThird.includes(title)))];
  if (missing.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'structure',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `目录小节不完整：正文存在 ${thirdLevel.length} 个三级小节，目录仅收录 ${tocThird.length} 个，缺失【${missing.slice(0, 6).join('、')}】`,
    suggestion: '在目录对应二级小节下补齐三级小节条目（缩进的“X.Y.Z 标题”行），确保目录层级与正文标题完全一致。',
  }];
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
  // 截断句词表（合肥师范实测：复查合格后/设计风/验收三处行尾截断）：
  // 正常成稿不会以这些词收尾且无句号；连接词/动作词/名词三类截断形态全部收口
  const unfinished = lines.filter(line => /[，、；：和与在为对将]$/u.test(line) || /(通过|包括|如下|主要包括|验收|合格后|复查合格后|设计风|确认后|具体如下|应符合|不少于|以及|且应|不得少于)$/u.test(line)).slice(0, 3);
  for (const item of unfinished) {
    issues.push({ level: 'warning', message: `正文存在疑似截断句：${item}`, suggestion: '请补完整该段落，避免以连接词、逗号、冒号或无句号的动作词结尾。' });
  }
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
    // 只收集表格行：表格后紧跟标题/正文时不得并入（否则段落中的“计划工期”等词会误判为基础信息表重复）
    const tableLines: string[] = [];
    for (const line of rest.split(LINE_SPLIT_RE)) {
      if (tableLines.length > 0 && !MARKDOWN_TABLE_ROW_RE.test(line)) break;
      tableLines.push(line);
    }
    basicInfoTableBlocks.push(tableLines.join('\n'));
  }
  const duplicatedBasicInfoTableCount = basicInfoTableBlocks.filter(block => /项目名称|招标人|建设单位|发包人|建设地点|招标范围|计划工期|合同估算价|质量标准/u.test(block)).length;
  if (duplicatedBasicInfoTableCount > 1) issues.push({ level: 'error', message: `项目基础信息类表格重复：${duplicatedBasicInfoTableCount} 处`, suggestion: '项目名称、招标人、建设地点、工期、质量等基础信息只能集中输出一次。' });
  const repeatedDividerRows = markdown.match(/^\|\s*---\s*\|\s*---\s*\|\s*$/gmu) || [];
  if (repeatedDividerRows.length > 60) issues.push({ level: 'error', message: `表格分隔线异常重复：${repeatedDividerRows.length} 行`, suggestion: '请修复表格规范化逻辑，禁止把数据行拆成多个碎表。' });
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
    // 数据行空单元格/占位符检测（十度实测缺陷：竣工清理计划表末列为空、临时用电表“—/若干/约82kW”占位）：
    // 正式交付表格不得出现数据缺失；合计/小计/总计/累计行的“—”属“不适用”行业惯例，豁免
    const dataRows = cells.slice(2);
    const emptyCellRow = dataRows.find(row => row.some(cell => cell === ''));
    if (emptyCellRow) issues.push({ level: 'error', message: `表格存在空单元格：${header.join('、')}（“${emptyCellRow[0] || ''}”行）`, suggestion: '正式交付表格不得出现空单元格；缺失数据应从资料补齐或按业务口径填写具体值，不得留空。' });
    const placeholderCellRow = dataRows.find(row => row.some((cell, cellIndex) => {
      if (!/^(?:—+|-+|-|\/|N\/A|n\/a|待定|待补充|待确认|待查|待补|若干|暂无|无数据)$/u.test(cell) && !/^约\d/u.test(cell)) return false;
      // 合计/小计/总计/累计行的“—”为不适用语义，豁免；其余占位词（若干/约/待定等）任何行均不豁免
      return !(/^(?:合计|小计|总计|累计)/u.test(row[0] || '') && /^(?:—+|-+)$/u.test(cell) && cellIndex > 0);
    }));
    if (placeholderCellRow) {
      // 提取真正触发缺陷的单元格（与检测口径一致：合计行“—”豁免，不进入消息定位）
      const isTotalRow = /^(?:合计|小计|总计|累计)/u.test(placeholderCellRow[0] || '');
      const placeholderCell = placeholderCellRow.find((cell, cellIndex) => {
        if (!/^(?:—+|-+|-|\/|N\/A|n\/a|待定|待补充|待确认|待查|待补|若干|暂无|无数据)$/u.test(cell) && !/^约\d/u.test(cell)) return false;
        return !(isTotalRow && /^(?:—+|-+)$/u.test(cell) && cellIndex > 0);
      }) || '';
      issues.push({ level: 'error', message: `表格存在占位符单元格：${header.join('、')}（“${placeholderCellRow[0] || ''}”行“${placeholderCell}”）`, suggestion: '正式交付表格不得用“—/若干/约/待定”等占位或模糊表达代替具体数据；应从资料补齐具体数值。' });
    }
  }
  return issues;
}

/** 表格凑数治理：同主题重复堆叠 + 连续堆表（无正文分隔），是生成侧用表格凑字数的典型形态。
 * 与 markdownTableQualityIssues 的结构缺陷检测互补，本函数只针对“凑数”形态，warning 不阻断门禁。 */
export function tableSpamIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = markdown.split(LINE_SPLIT_RE);
  const blocks: Array<{ headerKey: string; headerText: string; start: number; end: number; dividerCount: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!MARKDOWN_TABLE_ROW_RE.test(lines[index])) continue;
    const start = index;
    const block: string[] = [];
    while (index < lines.length && MARKDOWN_TABLE_ROW_RE.test(lines[index])) {
      block.push(lines[index]);
      index += 1;
    }
    index -= 1;
    const dividerCount = block.filter(line => MARKDOWN_TABLE_DIVIDER_RE.test(line)).length;
    if (dividerCount === 0) continue;
    const rawHeader = (block[0] || '').trim();
    const body = rawHeader.startsWith('|') ? rawHeader.slice(1) : rawHeader;
    const core = body.endsWith('|') ? body.slice(0, -1) : body;
    const headerCells = core.split('|').map(cell => cell.split('**').join('').trim()).filter(cell => cell.length > 0);
    blocks.push({ headerKey: headerCells.join('|'), headerText: headerCells.join('、'), start, end: index, dividerCount });
  }
  const byHeader = new Map<string, number>();
  for (const block of blocks) byHeader.set(block.headerKey, (byHeader.get(block.headerKey) || 0) + 1);
  const duplicated = [...byHeader.entries()].filter(([, count]) => count >= 3);
  if (duplicated.length > 0) {
    const sample = blocks.find(block => byHeader.get(block.headerKey) === duplicated[0]?.[1])?.headerText || '';
    issues.push({ level: 'warning', message: `同主题表格重复堆叠：${duplicated.length} 组相同表头出现 3 次及以上（如：${sample}）`, suggestion: '同一主题表格全文只出现一次，禁止拆成多张碎表重复堆叠凑数；请合并同类表格或删除重复内容。' });
  }
  // 连续堆叠两类形态：表格块之间只有空行无正文分隔；单块内多条分隔线（多张表连写不换行）
  let stacked = 0;
  for (let blockIndex = 1; blockIndex < blocks.length; blockIndex += 1) {
    const previous = blocks[blockIndex - 1];
    const current = blocks[blockIndex];
    if (!previous || !current) continue;
    const between = lines.slice(previous.end + 1, current.start);
    if (between.every(line => line.trim() === '')) stacked += 1;
  }
  for (const block of blocks) if (block.dividerCount >= 2) stacked += block.dividerCount - 1;
  if (stacked >= 2) issues.push({ level: 'warning', message: `表格连续堆叠：${stacked} 处相邻表格无正文分隔`, suggestion: '表格之间应有正文引导叙述，禁止连续堆叠多张表格凑数。' });
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
  // 表格载体小节：清单/配置/汇总/一览/明细类本体即表格清单，计划/进度/节点/安排类核心交付物即计划编排表格
  // （如危大工程控制清单、主要周转材料配置、关键节点计划与责任分解、关键施工节点控制计划），
  // 表格数据行≥2 即视为有效交付，与“只有标题无正文”区分，避免表格治理要求输出表格后反被“无正文”门禁阻断
  const tableCarrierSection = /清单|配置|汇总|一览|明细|计划|进度|节点|安排/u.test(sectionTitle) || /表[^，。；：\s]{0,6}$/u.test(sectionTitle);
  if (hasTable && tableCarrierSection && tableDataRowCount(body) >= 2) return undefined;
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
    // 排除"XX日历天内"的时限表达（如"中标公示期结束后7日历天内编制施组计划"是计划编制时限，不是工期口径）
    /\d+\s*日历天(?!内)/gu,
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
// 供跨章一致性检测比对正文与资料口径是否一致（非 LLM 的确定性检查，零额外成本）。
// 子项/专项口径词防护（q1a）：口径词与数值之间（gap）或口径词紧前上下文（prefix）出现
// 子项/专项口径词时，该数值属专项口径（地下/办公区/占地面积等），不得与建筑总量混比、
// 不得确定性替换（历史缺陷：确定性修复器把正文正确的“地下建筑面积3786.97”“办公区240”
// “总占地面积10970”全部盲替换成建筑总量 28570.36）；此类数值不进确定性冲突列表，
// 由 LLM 规模口径复核（语义层）依据事实卡核对口径归属
const SCALE_GAP_WORDS_RE = /占地|用地|地下|地上|办公|生活|附属|辅助|绿化|道路|广场|门卫|配电|泵房|锅炉房|车库|车棚|岗亭|传达|警卫|样板房|售楼|门房|单栋|各栋|楼层|每层|单层|架空|雨棚|堆场/u;
// 口径词紧前上下文防护：只挡“XX区/XX室/XX房”式专项范围词（gap 防护已覆盖占地/地下等语义词），
// 避免“地上6层、总建筑面积28570.36”这类正确表述被误 skip（防错改优先于漏检）
const SCALE_PREFIX_WORDS_RE = /办公区|生活区|加工区|施工区|堆场|门卫|配电|泵房|锅炉房|车库|车棚|岗亭|传达|警卫|样板房|售楼|门房|地下室|楼层|单层|每层|架空|雨棚/u;
const COST_GAP_WORDS_RE = /暂列|暂估|费率|税率|利润|规费|安全文明|措施费|人工费|材料费|机械费|管理费|暂定/u;

function scopedNumericEntries(text: string, scopeRe: RegExp, unitRe: RegExp, gapWords?: RegExp, prefixWords?: RegExp) {
  const entries: Array<{ value: string; unit: string; scope: string }> = [];
  const skipped: Array<{ value: string; unit: string; scope: string; context: string }> = [];
  const seen = new Set<string>();
  const pattern = new RegExp(`(?:${scopeRe.source})(?:[^\\n。；;，,]{0,14}?)(\\d{2,}(?:[.,]\\d+)?\\s*万?)\\s*(${unitRe.source})`, 'giu');
  for (const match of text.matchAll(pattern)) {
    const value = match[1].replace(/[,，]/gu, '').replace(/\s+/gu, '');
    const unit = match[2];
    const gap = match[0].slice(0, match[0].indexOf(match[1]));
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
    if ((gapWords && gapWords.test(gap)) || (prefixWords && prefixWords.test(prefix))) {
      skipped.push({ value, unit, scope: match[0].slice(0, gap.length).replace(/\s+/gu, ''), context: `${prefix}${gap}`.replace(/\s+/gu, '').slice(-24) });
      continue;
    }
    const scope = match[0].match(scopeRe)?.[0] || '';
    const key = `${value}|${unit}`;
    if (!value || seen.has(key)) continue;
    seen.add(key);
    entries.push({ value, unit, scope });
  }
  return { entries, skipped };
}

// 建设规模期望口径解析：资料中“建设规模”字段值常混写占地与建筑两个口径
// （如“建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方米”），
// 首个匹配数值（10970）实为占地面积，不是建筑总量；若直接取第一个匹配作期望口径，
// 修复器会把正文正确的“单体建筑面积 28570.36㎡”反向改成占地面积值（round-21 S6 实测：
// 跨章一致性修复 18 处 28570.36→10970，正文 9 处“总建筑面积 10970㎡”均为反向改错产物）。
// 混合口径时必须取“建筑面积”口径词引导的数值；无“占地/用地”字样时保持原“首个匹配”语义。
function resolveScaleExpectation(text: string) {
  const { entries } = scopedNumericEntries(text, SCALE_SCOPE_RE, SCALE_UNIT_RE, SCALE_GAP_WORDS_RE, SCALE_PREFIX_WORDS_RE);
  // “总”字归一：scope 可能是“建筑面积”或“总建筑面积”，同口径
  const areaEntry = entries.find(entry => entry.scope.replace(/^总/u, '') === '建筑面积');
  // 占地/用地语境只认“建筑面积”词引导的数值：混合口径中占地数值是独立口径，不得作为建筑总量期望值；
  // 找不到建筑口径条目时返回 undefined（调用方跳过修复/比对），禁止回退首个数值（round-21 S6 实测：
  // 截断事实“建设规模：项目总占地面积约10970平方米”单条目被当作建筑总量期望，
  // 修复器把正文正确的 28570.36 反向改成 10970，共 16 处）
  if (/占地|用地/u.test(text)) return areaEntry;
  return entries[0];
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

// 总量口径词：只比对建筑总量口径（总建筑面积/建设规模），“总”字可选（基础口径词与 factGovernance.scopeReForKind('area') 同源单点，
// 此处是其带子项口径黑名单的增强版）；子项口径（地上/地下/单栋/门卫室等具体建筑物）数值不同属正常分层，不视为冲突；
// 用地面积/占地面积是独立字段（与建设规模不同口径），不得与建筑总量混比（历史缺陷：
// 正文正确转述资料“总用地面积 X㎡”被判为与建设规模冲突，导出门禁误阻断）
const SCALE_SCOPE_RE = /(?<![地上地下门卫室值班室配电室配电房泵房水泵房锅炉房公厕车库车棚岗亭传达室警卫室样板房售楼处门房])总?建筑面积|总?建设规模/u;
// 面积单位归一化：扫描文本先行归一，m2（ASCII 数字）与 ㎡/m²/平方米 同口径（历史漏报根因：正文混写 m2 与 ㎡）
const SCALE_UNIT_RE = /㎡|m²|m2|平方米/u;
const COST_SCOPE_RE = /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价|工程总投资|总投资|工程造价/u;
const COST_UNIT_RE = /万元|亿元/u;

export function crossChapterConsistencyIssues(markdown: string, factsModel: DocumentFactsModel, scopeConflicts?: NumericScopeConflict[], analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // 校验基准与生成裁决同源：源级同口径冲突的裁决值（补疑修正后的胜出数值）优先作为期望口径，
  // 避免事实主表候选排序差异导致检查基准与裁决基准不一致（历史缺陷：正文全用胜出值时因主表取出败选值而误报）；
  // low 置信度裁决锚定弱，不作校验基准（与生成侧“不参与确定性改写”同口径）
  const scopeWinner = (kind: NumericScopeConflict['kind']) => scopeConflicts?.find(conflict => conflict.kind === kind && conflict.resolution && conflict.confidence !== 'low')?.resolution;
  // 裁决值是“数值+单位”短串（如“4646m2”），不带口径词前缀，直接从裁决值提取数值条目用于同口径比对
  const numericEntryFromResolution = (resolution: string) => {
    const match = /(\d+(?:\.\d+)?)\s*(㎡|m²|m2|平方米|万元|亿元)/u.exec(resolution);
    return match ? { value: match[1], unit: match[2] } : undefined;
  };
  const expectedSchedule = scopeWinner('duration') ?? factsModel.schedule.map(normalizedFactValue).find(value => /\d+\s*(?:日历天|天|个月|月)|计划工期|合同工期/u.test(value));
  const expectedQuality = factsModel.quality.map(normalizedFactValue).find(value => /质量|合格|优良/u.test(value));
  if (expectedSchedule) {
    const expectedDuration = durationValues(expectedSchedule)[0];
    // 剥离表格行：进度计划表中的分项持续时间（"第1日~第7日 7日历天"）是计划分解数据，
    // 不是总工期口径表述，不得与资料工期比对
    const nonTableMarkdown = markdown.split('\n').filter(line => !/^\s*\|/u.test(line.trim())).join('\n');
    const durationMatches = durationValues(nonTableMarkdown);
    const conflicting = expectedDuration ? durationMatches.filter(item => item !== expectedDuration && /日历天/u.test(item)) : [];
    if (expectedDuration && conflicting.length >= 2) issues.push({ level: 'warning', message: `跨章一致性冲突：正文出现与资料工期不一致的表述 ${conflicting.slice(0, 6).join('、')}`, suggestion: `请统一使用资料中的工期口径：${expectedSchedule}` });
  }
  // round-14 零误伤：质量目标词面未命中时由 bge 语义兑底（质量章节覆盖验收闭环语义即视为质量体系已体现），
  // 调用方未提供语义分析时保留词面判定（质量目标章节为模板固定结构，四词词表命中率极高，残余风险由 warning 级事实值反查兑底）
  if (expectedQuality && !/质量标准|质量目标|合格|优良/u.test(markdown)) {
    const semanticQualityCovered = analyses && [...analyses.values()].some(analysis => analysis.contentNeeds.quality);
    if (!semanticQualityCovered) issues.push({ level: 'error', message: '跨章一致性缺口：正文未稳定体现资料中的质量目标', suggestion: `请在工程概况、质量保证和验收相关章节统一体现：${expectedQuality}` });
  }
  // 建设规模口径冲突：资料中的建筑总量面积与正文同口径数值比对；
  // 期望口径只取建筑总量口径（建设规模/建筑面积）——用地面积/占地面积是独立字段，不得作为期望值；
  // 与裁决口径不符的取值出现 1 次即判定冲突（数字级不一致是低级错误，不得以“表述误差”放过），error 级进入修复链
  const areaResolution = scopeWinner('area');
  // 期望口径事实须能解析出建筑总量数值才可作基准：截断/占地口径事实（“建设规模：项目总占地面积约10970平方米”）
  // 解析不出建筑总量（resolveScaleExpectation 返回 undefined），跳过继续找下一条（round-21 S6 反向改错兜底）
  const expectedScale = areaResolution ?? factsModel.project.map(normalizedFactValue).find(value => /建设规模|建筑面积/u.test(value) && resolveScaleExpectation(value));
  if (expectedScale) {
    const scaleMain = areaResolution ? numericEntryFromResolution(areaResolution) : resolveScaleExpectation(expectedScale);
    const { entries: scaleMatches, skipped: scaleSkipped } = scopedNumericEntries(markdown, SCALE_SCOPE_RE, SCALE_UNIT_RE, SCALE_GAP_WORDS_RE, SCALE_PREFIX_WORDS_RE);
    if (scaleMain) {
      const scaleConflicts = scaleMatches.filter(entry => scaledNumericValue(entry) !== scaledNumericValue(scaleMain));
      if (scaleConflicts.length >= 1) issues.push({ level: 'error', message: `跨章一致性冲突：正文出现与资料建设规模不一致的表述 ${scaleConflicts.slice(0, 6).map(entry => `${entry.value}${entry.unit}`).join('、')}`, suggestion: `请统一使用资料中的建设规模口径：${expectedScale.slice(0, 80)}` });
    }
    // 规模口径复核（语义层）：正文存在“口径词与数值之间混入子项/专项口径词”的形态
    // （如“建设规模：地下建筑面积3786.97㎡”“办公区总建筑面积240㎡”），确定性层不做替换
    // （防错改优先），交由 LLM 依据项目规模事实卡核对该数值口径归属：与事实卡对应口径一致则保留，
    // 口径错位或数值不一致则改正（历史缺陷：确定性修复器盲替换把正确的 3786.97/240/10970 改错）
    if (scaleSkipped.length > 0) {
      const cardParts = [
        areaResolution ? `建筑总量裁决值：${areaResolution}` : '',
        ...factsModel.project.map(normalizedFactValue).filter(value => /建设规模|建筑面积|占地/u.test(value)).slice(0, 3),
      ].filter(Boolean);
      issues.push({
        level: 'warning',
        severity: 'warning',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `规模口径复核：正文 ${scaleSkipped.slice(0, 3).map(item => `“${item.context.slice(-14)}${item.value}${item.unit}”`).join('、')} 等 ${scaleSkipped.length} 处数值与口径词之间混入子项/专项口径词，需核对口径归属`,
        suggestion: `依据项目规模事实卡逐处核对该数值的口径归属（${cardParts.join('；') || '无可用事实卡，以绑定资料原文为准'}）：与事实卡对应口径一致的数值保留原样，口径错位或数值不一致的数值改正为事实卡对应口径值，不得把子项/专项口径数值改成建筑总量数值。`,
      });
    }
  }
  // 合同估算价口径冲突：估算价/最高限价等金额口径在正文中不得出现多个互相矛盾的取值
  const costResolution = scopeWinner('cost');
  const expectedCost = costResolution ?? factsModel.project.map(normalizedFactValue).find(value => /合同估算|投资估算|最高投标限价|招标控制价|总投资|工程造价/u.test(value));
  if (expectedCost) {
    const costMain = costResolution ? numericEntryFromResolution(costResolution) : scopedNumericEntries(expectedCost, COST_SCOPE_RE, COST_UNIT_RE, COST_GAP_WORDS_RE).entries[0];
    const costMatches = scopedNumericEntries(markdown, COST_SCOPE_RE, COST_UNIT_RE, COST_GAP_WORDS_RE).entries;
    if (costMain) {
      const costConflicts = costMatches.filter(entry => scaledNumericValue(entry) !== scaledNumericValue(costMain));
      if (costConflicts.length >= 1) issues.push({ level: 'error', message: `跨章一致性冲突：正文出现与资料估算价不一致的表述 ${costConflicts.slice(0, 6).map(entry => `${entry.value}${entry.unit}`).join('、')}`, suggestion: `请统一使用资料中的估算价口径：${expectedCost.slice(0, 80)}` });
    }
  }
  return issues;
}

// ===== 工序规格冲突扫描 =====
// 资料中明确的结构层规格（找平层/防水层等配比与厚度）被正文改写为其他数值时，属低级错误，
// 必须确定性拦截（历史缺陷：屋面找平层资料 1:2.5+20mm 被正文写成 1:3+15mm）

const SPEC_LAYER_RE = /找平层|抹灰层|防水层|保温层|结合层|垫层|面层|粘结层|隔热层|隔离层/gu;
// 数值与层名之间出现施工动作动词，说明该数值描述的是施工过程/其他层（如“保温层施工完成后铺设
// 20mm 厚找平层”，20mm 属找平层不属保温层），当前层不得占用。注意“采用”不是排除词：
// 层名后“采用 1:3 水泥砂浆厚 20mm”是标准规格句式，数值仍属当前层
const SPEC_ACTION_RE = /铺设|施工|浇筑|粘贴|铺贴|涂抹|完成|进行|待|设置|铺装|挂网|喷涂|灌注/u;

/** 层名→归属数值（含位置）的收集：检测与确定性定点修复共用同一套归属规则，保证“检测定位=修复定位” */
function collectLayerNumbers(text: string): Array<{ layer: string; span: [number, number]; raw: string; kind: 'thickness' | 'ratio' }> {
  const claims: Array<{ layer: string; span: [number, number]; raw: string; kind: 'thickness' | 'ratio' }> = [];
  const matches = [...text.matchAll(SPEC_LAYER_RE)];
  const usedRanges: Array<[number, number]> = [];
  const isUsed = (start: number, end: number) => usedRanges.some(([s, e]) => start < e && end > s);
  // 在窗口内按方向取第一个/最后一个“未被占用且与层名之间无施工动作”的数值，命中即登记占用，
  // 保证一个数值只归属一个层（多层连续描述“找平层 20mm、防水层 2mm、保温层 130mm”各取各值）
  const claim = (window: string, offset: number, re: RegExp, direction: 'first' | 'last', layer: string, kind: 'thickness' | 'ratio') => {
    const found = [...window.matchAll(re)];
    const ordered = direction === 'first' ? found : [...found].reverse();
    for (const m of ordered) {
      const absStart = offset + (m.index ?? 0);
      const absEnd = absStart + m[0].length;
      if (isUsed(absStart, absEnd)) continue;
      const gap = direction === 'first' ? window.slice(0, m.index ?? 0) : window.slice((m.index ?? 0) + m[0].length);
      if (SPEC_ACTION_RE.test(gap)) continue;
      usedRanges.push([absStart, absEnd]);
      claims.push({ layer, span: [absStart, absEnd], raw: m[0], kind });
      return;
    }
  };
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const layer = match[0];
    // 规格数值关联：优先取当前层名之后、下一个层名之前的区间（“保温层厚130mm”“保温层（XPS）130mm”），
    // 该区间无数值时兜底取上一个层名之后、当前层名之前的区间（“130mm厚保温层”）。
    // 历史缺陷：旧实现用“层名前 60 字符”宽窗口取第一个数值，多层连续描述（如“找平层 20mm、防水层 2mm、
    // 结合层 30mm、保温层 130mm”）时把前层数值误归当前层——正文写对也会误报冲突（用户环境误报
    // 保温层 20/30/2mm），且修复器在正文找不到“保温层 20mm”无法定位，残留冲突被导出校验硬阻断形成死循环
    const layerStart = match.index ?? 0;
    const layerEnd = layerStart + layer.length;
    const nextLayerStart = matches[i + 1]?.index;
    const afterEnd = nextLayerStart === undefined ? Math.min(text.length, layerEnd + 90) : nextLayerStart;
    const after = text.slice(layerEnd, afterEnd);
    const prevLayerEnd = i > 0 ? (matches[i - 1].index ?? 0) + matches[i - 1][0].length : Math.max(0, layerStart - 40);
    const before = text.slice(prevLayerEnd, layerStart);
    claim(after, layerEnd, /(\d+:\d+(?:\.\d+)?)/gu, 'first', layer, 'ratio');
    claim(before, prevLayerEnd, /(\d+:\d+(?:\.\d+)?)/gu, 'last', layer, 'ratio');
    claim(after, layerEnd, /(\d+(?:\.\d+)?)\s*mm/gu, 'first', layer, 'thickness');
    claim(before, prevLayerEnd, /(\d+(?:\.\d+)?)\s*mm/gu, 'last', layer, 'thickness');
  }
  return claims;
}

function layeredSpecEntries(text: string) {
  const entries: Array<{ layer: string; ratio?: string; thickness?: number }> = [];
  const seen = new Set<string>();
  for (const claim of collectLayerNumbers(text)) {
    const ratio = claim.kind === 'ratio' ? claim.raw.match(/(\d+:\d+(?:\.\d+)?)/u)?.[1] : undefined;
    const thicknessMatch = claim.kind === 'thickness' ? claim.raw.match(/(\d+(?:\.\d+)?)/u)?.[1] : undefined;
    const thickness = thicknessMatch ? Number(thicknessMatch) : undefined;
    const key = `${claim.layer}|${ratio || ''}|${thickness ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ layer: claim.layer, ratio, thickness });
  }
  return entries;
}

export function processSpecConflictIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sourceText = [
    ...factsModel.specifications,
    ...factsModel.quality,
    ...factsModel.preciseFacts,
    ...factsModel.bills,
  ].map(normalizedFactValue).join('\n');
  const sourceEntries = layeredSpecEntries(sourceText);
  if (sourceEntries.length === 0) return issues;
  // 资料侧同一结构层出现多个不同规格时口径不唯一，跳过该层（无法确定性裁决）
  const sourceByLayer = new Map<string, typeof sourceEntries>();
  for (const entry of sourceEntries) {
    const list = sourceByLayer.get(entry.layer) || [];
    list.push(entry);
    sourceByLayer.set(entry.layer, list);
  }
  const bodyEntries = layeredSpecEntries(markdown);
  const reported = new Set<string>();
  for (const [layer, sources] of sourceByLayer) {
    const sourceRatios = [...new Set(sources.map(entry => entry.ratio).filter(Boolean))];
    const sourceThicknesses = [...new Set(sources.map(entry => entry.thickness).filter((value): value is number => Number.isFinite(value)))];
    for (const body of bodyEntries.filter(entry => entry.layer === layer)) {
      if (sourceRatios.length === 1 && body.ratio && body.ratio !== sourceRatios[0]) {
        const key = `ratio|${layer}|${body.ratio}`;
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({ level: 'error', message: `工序规格冲突：正文${layer}配比 ${body.ratio} 与资料口径 ${sourceRatios[0]} 不一致`, suggestion: `请将${layer}配比统一为资料口径 ${sourceRatios[0]}，禁止改写资料规格。` });
        }
      }
      if (sourceThicknesses.length === 1 && Number.isFinite(body.thickness) && Math.abs((body.thickness as number) - sourceThicknesses[0]) >= 1) {
        const key = `thickness|${layer}|${body.thickness}`;
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({ level: 'error', message: `工序规格冲突：正文${layer}厚度 ${body.thickness}mm 与资料口径 ${sourceThicknesses[0]}mm 不一致`, suggestion: `请将${layer}厚度统一为资料口径 ${sourceThicknesses[0]}mm。` });
        }
      }
    }
  }
  return issues;
}

// ===== 确定性定点修复 =====
// LLM 定向修复（fact_conflict）受“无法安全定位的问题不要生成 patch”约束，数值冲突经 2 轮修复仍可能
// 残留，残留会被导出门禁硬阻断形成“继续生成”死循环（历史缺陷：用户环境保温层 20/30/2mm、10970㎡
// 冲突修复器在正文无法定位 → 不产出 patch → 残留 → 阻断）。此处按检测同源归属规则
// （collectLayerNumbers / scopedNumericEntries）定位错误数值并确定性替换为资料口径，
// 保证“检测定位=修复定位”，不依赖 LLM 定位能力。

/** 与 processSpecConflictIssues / crossChapterConsistencyIssues 完全同源的修复目标口径 */
function deterministicFixTargets(factsModel: DocumentFactsModel, scopeConflicts?: NumericScopeConflict[]) {
  const sourceText = [
    ...factsModel.specifications,
    ...factsModel.quality,
    ...factsModel.preciseFacts,
    ...factsModel.bills,
  ].map(normalizedFactValue).join('\n');
  const sourceByLayer = new Map<string, { ratios: string[]; thicknesses: number[] }>();
  for (const entry of layeredSpecEntries(sourceText)) {
    const list = sourceByLayer.get(entry.layer) || { ratios: [], thicknesses: [] };
    if (entry.ratio && !list.ratios.includes(entry.ratio)) list.ratios.push(entry.ratio);
    if (Number.isFinite(entry.thickness) && !list.thicknesses.includes(entry.thickness as number)) list.thicknesses.push(entry.thickness as number);
    sourceByLayer.set(entry.layer, list);
  }
  // 资料同层多口径时无法确定性裁决，跳过该层（与检测侧“口径不唯一跳过”一致）
  const specTargets = new Map<string, { ratio?: string; thickness?: number }>();
  for (const [layer, list] of sourceByLayer) {
    if (list.ratios.length !== 1 && list.thicknesses.length !== 1) continue;
    specTargets.set(layer, { ratio: list.ratios.length === 1 ? list.ratios[0] : undefined, thickness: list.thicknesses.length === 1 ? list.thicknesses[0] : undefined });
  }
  const scopeWinner = (kind: NumericScopeConflict['kind']) => scopeConflicts?.find(conflict => conflict.kind === kind && conflict.resolution && conflict.confidence !== 'low')?.resolution;
  const numericEntryFromResolution = (resolution: string) => {
    const match = /(\d+(?:\.\d+)?)\s*(㎡|m²|m2|平方米|万元|亿元)/u.exec(resolution);
    return match ? { value: match[1], unit: match[2] } : undefined;
  };
  const areaResolution = scopeWinner('area');
  // 与检测侧同源校验：期望口径事实须可解析出建筑总量数值（截断占地事实跳过），保证“检测定位=修复定位”
  const expectedScale = areaResolution ?? factsModel.project.map(normalizedFactValue).find(value => /建设规模|建筑面积/u.test(value) && resolveScaleExpectation(value));
  const costResolution = scopeWinner('cost');
  const expectedCost = costResolution ?? factsModel.project.map(normalizedFactValue).find(value => /合同估算|投资估算|最高投标限价|招标控制价|总投资|工程造价/u.test(value));
  return {
    specTargets,
    scaleTarget: expectedScale ? (areaResolution ? numericEntryFromResolution(areaResolution) : resolveScaleExpectation(expectedScale)) : undefined,
    costTarget: expectedCost ? (costResolution ? numericEntryFromResolution(costResolution) : scopedNumericEntries(expectedCost, COST_SCOPE_RE, COST_UNIT_RE, COST_GAP_WORDS_RE).entries[0]) : undefined,
  };
}

/** 单章定点修复：span 基于原始 text 收集，替换从后往前执行避免偏移 */
function fixChapterDeterministic(text: string, targets: ReturnType<typeof deterministicFixTargets>): { content: string; fixedCount: number; details: string[] } {
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  // 结构层规格：collectLayerNumbers 与检测共用归属规则，定位到的错误数值必为检测所报冲突，直接替换为资料口径
  for (const claim of collectLayerNumbers(text)) {
    const target = targets.specTargets.get(claim.layer);
    if (!target) continue;
    if (claim.kind === 'ratio' && target.ratio) {
      const ratio = claim.raw.match(/(\d+:\d+(?:\.\d+)?)/u)?.[1];
      if (ratio && ratio !== target.ratio) replacements.push({ start: claim.span[0], end: claim.span[1], replacement: claim.raw.replace(/(\d+:\d+(?:\.\d+)?)/u, target.ratio), detail: `${claim.layer}配比 ${ratio}→${target.ratio}` });
    }
    if (claim.kind === 'thickness' && Number.isFinite(target.thickness)) {
      const thickness = Number(claim.raw.match(/(\d+(?:\.\d+)?)/u)?.[1]);
      if (Number.isFinite(thickness) && Math.abs(thickness - (target.thickness as number)) >= 1) replacements.push({ start: claim.span[0], end: claim.span[1], replacement: claim.raw.replace(/(\d+(?:\.\d+)?)/u, String(target.thickness)), detail: `${claim.layer}厚度 ${thickness}mm→${target.thickness}mm` });
    }
  }
  // 建设规模/估算价：与检测同源模式带 span 重新匹配，败选数值替换为期望口径（单位保留原样）。
  // 同源口径词防护（q1a）：口径词与数值之间（gap）或紧前上下文（prefix）混入子项/专项口径词时
  // 跳过替换——确定性只碰同词形紧邻数值，跨口径形态交 LLM 规模口径复核（防错改优先于盲修复）
  const collectScopeSpans = (target: { value: string; unit: string } | undefined, scopeRe: RegExp, unitRe: RegExp, kindLabel: string, gapWords?: RegExp, prefixWords?: RegExp) => {
    if (!target) return;
    const pattern = new RegExp(`(?:${scopeRe.source})(?:[^\\n。；;，,]{0,14}?)(\\d{2,}(?:[.,]\\d+)?\\s*万?)\\s*(${unitRe.source})`, 'giu');
    for (const match of text.matchAll(pattern)) {
      const gap = match[0].slice(0, match[0].indexOf(match[1]));
      const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
      if ((gapWords && gapWords.test(gap)) || (prefixWords && prefixWords.test(prefix))) continue;
      const entry = { value: match[1].replace(/[,，]/gu, '').replace(/\s+/gu, ''), unit: match[2] };
      if (scaledNumericValue(entry) === scaledNumericValue(target)) continue;
      const start = (match.index ?? 0) + match[0].indexOf(match[1]);
      const end = start + match[1].length;
      if (replacements.some(item => item.start < end && item.end > start)) continue;
      replacements.push({ start, end, replacement: target.value, detail: `${kindLabel} ${entry.value}${entry.unit}→${target.value}${entry.unit}` });
    }
  };
  collectScopeSpans(targets.scaleTarget, SCALE_SCOPE_RE, SCALE_UNIT_RE, '建设规模', SCALE_GAP_WORDS_RE, SCALE_PREFIX_WORDS_RE);
  collectScopeSpans(targets.costTarget, COST_SCOPE_RE, COST_UNIT_RE, '估算价', COST_GAP_WORDS_RE);
  if (replacements.length === 0) return { content: text, fixedCount: 0, details: [] };
  replacements.sort((a, b) => b.start - a.start);
  let content = text;
  for (const item of replacements) content = content.slice(0, item.start) + item.replacement + content.slice(item.end);
  return { content, fixedCount: replacements.length, details: replacements.map(item => item.detail) };
}

/** 确定性定点修复兜底：LLM 定向修复未消除的数值口径冲突，按检测同源归属规则直接替换为资料口径（原地修改 chapters 内容） */
export function applyDeterministicConsistencyFixes(chapters: Array<Pick<DocumentDraftChapter, 'id' | 'title' | 'content'>>, factsModel: DocumentFactsModel, scopeConflicts?: NumericScopeConflict[]): { fixedCount: number; details: string[] } {
  const targets = deterministicFixTargets(factsModel, scopeConflicts);
  if (targets.specTargets.size === 0 && !targets.scaleTarget && !targets.costTarget) return { fixedCount: 0, details: [] };
  let fixedCount = 0;
  const details: string[] = [];
  for (const chapter of chapters) {
    const fix = fixChapterDeterministic(chapter.content, targets);
    if (fix.fixedCount > 0) {
      chapter.content = fix.content;
      fixedCount += fix.fixedCount;
      details.push(...fix.details);
    }
  }
  return { fixedCount, details };
}

/** 全文级确定性定点修复：覆盖章节正文之外的合成区（封面信息块/基本信息表/附录）中的败选数值。
 * 章节级修复只改章节正文，合成区由 facts 生成，败选值残留时修复器在章节正文找不到目标、fixedCount=0，
 * 检测重跑仍报错，导出门禁永久阻断（历史缺陷：用户环境建设规模败选值 10970㎡ 进入封面合成区形成死循环） */
export function applyDeterministicConsistencyFixesToMarkdown(markdown: string, factsModel: DocumentFactsModel, scopeConflicts?: NumericScopeConflict[]): { markdown: string; fixedCount: number; details: string[] } {
  const targets = deterministicFixTargets(factsModel, scopeConflicts);
  if (targets.specTargets.size === 0 && !targets.scaleTarget && !targets.costTarget) return { markdown, fixedCount: 0, details: [] };
  const fix = fixChapterDeterministic(markdown, targets);
  return { markdown: fix.content, fixedCount: fix.fixedCount, details: fix.details };
}

/** 全文级闭环句式密度检测：与可落地性评分同口径（每 1500 字至少 1 段三要素齐全的闭环句式），
 * 密度不足时给 warning 指导修订（不阻断门禁，与评分口径同源避免双重标准） */
export async function closedLoopDensityIssues(markdown: string): Promise<ValidationIssue[]> {
  const { closedLoopBlocks } = await fiveElementBlockStats(markdown);
  const target = Math.max(6, Math.ceil(documentTextLength(markdown) / 1500));
  if (closedLoopBlocks >= target) return [];
  return [{ level: 'warning', message: `可落地性闭环句式密度不足：全文 ${closedLoopBlocks} 段完整闭环句式，未达每 1500 字 1 段（目标 ${target} 段）`, suggestion: '在措施类段落中补齐“责任岗位 + 检查频次 + 整改闭环”三要素齐全的闭环句式：同一自然段内同时出现岗位（如项目经理/质检员/安全员）、频次（每日/每周/不少于X次）与闭环（整改/复查/销项）。' }];
}

export function managementMeasureNumberIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>, analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const managementNumberPattern = /(?:三检制|三级教育|三级管理|5S|24\s*小时|每日|每周|每月|一次|两次)/gu;
  for (const chapter of chapters) {
    const matches = [...new Set(chapter.content.match(managementNumberPattern) || [])];
    if (matches.length < 3) continue;
    const analysis = analyses?.get(chapter.title);
    // 调用方未提供语义分析时跳过（生成中间阶段无章节内容可分析；最终校验恒提供）：
    // 执行闭环必须由 bge 嵌入判定，关键词闭环正则必然误伤（闭环词命中的模板段漏检、变体闭环表述误报）
    if (!analysis) continue;
    if (!analysis.closedLoop) {
      issues.push({ level: 'warning', message: `${chapter.title} 管理措施数字较多但缺少执行闭环：${matches.slice(0, 8).join('、')}`, suggestion: '这些管理数字可以保留，但需要补充责任主体、检查频次、记录台账、整改复查和闭环要求。' });
    }
  }
  return issues;
}

export function genericProfessionalContentIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>, analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const generic = /(?:加强组织领导|严格执行规范|落实责任制度|确保工程质量|强化过程管理|提高思想认识|完善管理体系|形成闭环管理)/gu;
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const matches = chapter.content.match(generic) || [];
    if (matches.length < 6) continue;
    const analysis = analyses?.get(chapter.title);
    // 调用方未提供语义分析时跳过（生成中间阶段无章节内容可分析；最终校验恒提供）：
    // 是否绑定项目事实必须由 bge 嵌入判定，具体词正则必然误伤（“材料”等词零命中但实质具体的章节被误判泛化）
    if (!analysis) continue;
    if (!analysis.concrete) issues.push({ level: 'error', message: `${chapter.title} 存在较多未绑定项目事实和工序控制点的泛化套话`, suggestion: '请替换为结合资料事实、施工对象、工序控制、验收资料和整改闭环的专业内容。' });
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

function generatedFactTokenClass(token: string, context: string, prefix?: string): 'scope' | 'spec' | 'soft' {
  const normalized = `${token} ${context}`;
  // 单位门控（十一度实测误伤）：token 自身单位决定口径类别，上下文关键词不得跨口径升级——
  // “4次”是专项应急演练频次计数，不能因 ±36 字上下文出现“日历天”而被判为工期总量口径编造
  if (/(?:工日|人日|次|台|套|个|人|层|间|批|项|处|座|栋|根|只|组|件|块|片|面|条|道|樘|扇|盏|节|段)$/u.test(token)) return 'soft';
  if (/三检制|三级|5S|24\s*小时|每日|每周|每月|一次|两次|责任制|制度/u.test(normalized)) return 'soft';
  // 商务金额类（暂列金额/暂估价/报价/单价/税率）：招标人给定或商务条款数字，事实提取侧本就不纳入主表，
  // 反查侧不得据此判为“编造总量口径”硬阻断——正文忠实引用暂列金额（如“暂列金额60万元”）是合规写法
  if (/暂列金额|暂估价|报价|单价|合价|综合单价|税率|增值税|预留金/u.test(normalized)) return 'soft';
  // 具体日期 token（"2026年8月8日"中的"2026年""8月"）属于日期表述，不是总量口径数字；
  // 编造日期由 Writer 规则约束与跨章检查处理，此处降级 soft 避免把日期误判为工期口径阻断导出
  if (/^\d+(?:\.\d+)?(?:月|年)$/u.test(token) && /开工|竣工|日期|计划|年|月/u.test(context)) return 'soft';
  // 项目总量口径（工期/金额/建设规模）：正文偏离资料口径属低级错误，升级为 error 走修复链。
  // token 必须携带对应口径单位才能升级，防止上下文关键词跨口径误伤（见上方单位门控说明）。
  // 上下文关键词只在 token 前导近邻窗口（prefix）内匹配：±36 字全窗口会把
  // “养护期30天，满足总工期要求”误判为工期总量口径编造（error 硬阻断误伤）；
  // 远距离口径由异步语义链路补升级（generatedFactVerificationIssuesAsync 的 bge 语义分类器），漏检由语义补足。
  const scopeContext = prefix ?? context;
  if (/(?:天|工作天|月|年)$/u.test(token) && /总工期|计划工期|合同工期|日历天|施工周期/u.test(scopeContext)) return 'scope';
  // 金额类不能裸匹配单字“元”：正文常见“结构单元/元件/元素/元器件”等词含“元”字，
  // 会把方法段工艺参数（如“拆除段单元划分”语境下的 200m2）误判为金额口径编造（十度实测误伤）
  if (/(?:万元|亿元|元)$/u.test(token) && /最高投标限价|招标控制价|合同估算价|投资估算|报价|金额|人民币/u.test(scopeContext)) return 'scope';
  if (/(?:m2|hm2|亩|㎡|m²|平方米)$/u.test(token) && /建设规模|总建筑面积|总用地面积|总占地面积/u.test(scopeContext)) return 'scope';
  // 工程量/材料/设备规格明细：与资料口径不符时提示复核（规格细节较多，warning 级避免误伤）
  if (/(?:工程量|清单|建设规模|建筑面积|长度|材料|设备|规格|型号).{0,24}(?:m²|㎡|m3|m³|米|吨|套|台|个|项|%)/u.test(normalized)) return 'spec';
  // 国家标准/行业标准/地方标准编号是通用引用，不是项目特有事实，降级为 soft
  if (/GB\s*\d|JGJ\s*\d|CJJ\s*\d|ISO\s*\d|GB\/T|CECS\s*\d|DL\s*\d|YB\s*\d|SH\s*\d|SJ\/T\s*\d|CJJ\/T\s*\d|DB\s*\d/u.test(normalized)) return 'soft';
  if (/标准|规范|编号/u.test(normalized)) return 'spec';
  return 'soft';
}

interface FactVerificationCandidate {
  token: string;
  normalizedToken: string;
  context: string;
  /** token 前导近邻窗口（16 字）：scope 升级的关键词封闭匹配限定在近邻，杜绝远距离上下文误升级 */
  prefix: string;
}

/** 收集待反查的工程度量 token（表格行排除、章节编号排除、上下文切片），与口径分类解耦 */
function collectFactVerificationCandidates(markdown: string): FactVerificationCandidate[] {
  const candidates: FactVerificationCandidate[] = [];
  for (const token of extractEngineeringMeasureTokens(markdown)) {
    // 章节编号（1.2、2.3 等无单位纯小数）是目录/标题编号，不是工程数字，不进反查池
    if (/^\d+\.\d+$/u.test(token)) continue;
    const normalizedToken = normalizeEngineeringTextForFactMatch(token);
    let tokenIndex = markdown.indexOf(token);
    if (tokenIndex < 0) {
      // 归一化单位还原（日历天→天、㎡→m2 等）后 token 与原文形态不一致：退化为按数值部分定位，
      // 保证工期/面积口径 token 不因归一化丢位而漏反查（“30日历天”提取为“30天”后原文找不到）
      const numericPart = /^\d+(?:\.\d+)?/u.exec(token)?.[0];
      tokenIndex = numericPart ? markdown.indexOf(numericPart) : -1;
    }
    if (tokenIndex < 0) continue;
    // 表格行中的数值（进度计划表分项持续时间"第24～34天"、机械配置表"第X天"等）
    // 属于计划排期分解数据，不属于总量口径，不做资料事实反查
    const lineStart = markdown.lastIndexOf('\n', tokenIndex - 1) + 1;
    const lineEnd = markdown.indexOf('\n', tokenIndex);
    const tokenLine = markdown.slice(lineStart, lineEnd < 0 ? markdown.length : lineEnd);
    if (/^\s*\|/u.test(tokenLine.trim())) continue;
    const context = markdown.slice(Math.max(0, tokenIndex - 36), Math.min(markdown.length, tokenIndex + token.length + 36));
    // token 前导近邻窗口（16 字）：scope 升级的关键词封闭匹配限定在近邻，杜绝远距离上下文误升级（round-14 零误伤）
    const prefix = markdown.slice(Math.max(0, tokenIndex - 16), tokenIndex);
    candidates.push({ token, normalizedToken, context, prefix });
  }
  return candidates;
}

/** 由三类可疑桶生成反查 issues（同步/异步分类链路共用，保证消息与阈值一致） */
function buildFactVerificationIssuesFromBuckets(input: {
  markdown: string;
  factsModel: DocumentFactsModel;
  scopeSuspicious: string[];
  specSuspicious: string[];
  softSuspicious: string[];
}): ValidationIssue[] {
  const { markdown, factsModel, scopeSuspicious, specSuspicious, softSuspicious } = input;
  const issues: ValidationIssue[] = [];
  const uniqueScopeSuspicious = [...new Set(scopeSuspicious)];
  const uniqueSpecSuspicious = [...new Set(specSuspicious)];
  const uniqueSoftSuspicious = [...new Set(softSuspicious)];
  // 总量口径类硬数字反查失败：error 级进入修复链（消息前缀匹配 REPAIRABLE_QUALITY_ISSUE_RE 的“生成后事实反查失败”）
  if (uniqueScopeSuspicious.length >= 1) issues.push({ level: 'error', message: `生成后事实反查失败：正文出现资料事实主表中未找到的总量口径数字 ${uniqueScopeSuspicious.slice(0, 8).join('、')}`, suggestion: '总量口径数字（工期/金额/建设规模）必须与资料一致；请删除或改写为资料确认的口径，禁止编造。' });
  if (uniqueSpecSuspicious.length >= 2) issues.push({ level: 'warning', message: `生成后事实反查提示：正文出现资料事实主表中未找到的规格明细数字 ${uniqueSpecSuspicious.slice(0, 8).join('、')}`, suggestion: '建议复核这些规格是否来自管理制度、规范要求或资料事实；如无依据，改为定性管理要求。' });
  if (uniqueSoftSuspicious.length >= 6) issues.push({ level: 'warning', message: `生成后事实反查提示：正文出现较多未在资料事实主表中反查到的管理数字 ${uniqueSoftSuspicious.slice(0, 10).join('、')}`, suggestion: '请确认这些管理数字属于通用制度、规范要求或项目资料事实；如无依据，建议改为定性管理要求。' });
  if (/质量目标|质量标准/u.test(markdown) && factsModel.quality.length > 0 && !factsModel.quality.some(fact => markdown.includes(stringifyFactValue(fact.value).slice(0, 18)))) issues.push({ level: 'warning', message: '生成后事实反查提示：正文质量目标表述未明显匹配质量事实主表', suggestion: '请使用资料中的质量目标原文或等价表述。' });
  return issues;
}

/** 模糊口径单位后缀：可被总量口径或明细口径解释的单位，其口径归属需语义分类复核 */
const AMBIGUOUS_SCOPE_UNIT_RE = /(?:天|工作天|日历天|月|年|万元|亿元|元|m2|hm2|亩|㎡|m²|平方米)$/u;

/** 同步反查校验（L2 正则门控分类口径：交付评分快评与中间校验使用；语义口径分类走 generatedFactVerificationIssuesAsync） */
export function generatedFactVerificationIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const corpus = trustedFactCorpus(factsModel);
  if (documentTextLength(corpus) < 80) return [];
  const compactCorpus = normalizeEngineeringTextForFactMatch(corpus);
  const scopeSuspicious: string[] = [];
  const specSuspicious: string[] = [];
  const softSuspicious: string[] = [];
  for (const candidate of collectFactVerificationCandidates(markdown)) {
    const { token, normalizedToken, context, prefix } = candidate;
    const tokenClass = generatedFactTokenClass(token, context, prefix);
    if (tokenClass === 'scope' && !compactCorpus.includes(normalizedToken)) scopeSuspicious.push(token);
    if (tokenClass === 'spec' && !compactCorpus.includes(normalizedToken)) specSuspicious.push(token);
    if (tokenClass === 'soft' && !compactCorpus.includes(normalizedToken)) softSuspicious.push(token);
  }
  return buildFactVerificationIssuesFromBuckets({ markdown, factsModel, scopeSuspicious, specSuspicious, softSuspicious });
}

/**
 * 反查校验（语义口径分类链路，round-13）：模糊单位 token 的 scope 升级/降级由总量口径语义分类器复核——
 * 正则升级 scope 需语义确认（根治跨口径误伤），正则漏判时语义可升级（补足变体表述漏检）。
 * 本地语义模型恒可用，scopeClassifier 由生成前预构建后必传。
 */
export async function generatedFactVerificationIssuesAsync(
  markdown: string,
  factsModel: DocumentFactsModel,
  options: { scopeClassifier: FactTokenScopeClassifier },
): Promise<ValidationIssue[]> {
  const corpus = trustedFactCorpus(factsModel);
  if (documentTextLength(corpus) < 80) return [];
  const compactCorpus = normalizeEngineeringTextForFactMatch(corpus);
  const candidates = collectFactVerificationCandidates(markdown);
  // 批量语义预分类：一次批量嵌入所有模糊单位候选查询，避免逐条 pipeline 调用开销
  let semanticMap: Map<string, 'scope' | 'other'> | undefined;
  const ambiguousCandidates = candidates.filter(candidate => AMBIGUOUS_SCOPE_UNIT_RE.test(candidate.token));
  if (ambiguousCandidates.length > 0) {
    const results = await options.scopeClassifier.batchClassify(ambiguousCandidates.map(candidate => `${candidate.token} ${candidate.context}`.slice(0, 160)));
    semanticMap = new Map();
    ambiguousCandidates.forEach((candidate, index) => semanticMap!.set(candidate.token, results[index] || 'other'));
  }
  const scopeSuspicious: string[] = [];
  const specSuspicious: string[] = [];
  const softSuspicious: string[] = [];
  for (const candidate of candidates) {
    const { token, normalizedToken, context, prefix } = candidate;
    let tokenClass = generatedFactTokenClass(token, context, prefix);
    if (semanticMap && AMBIGUOUS_SCOPE_UNIT_RE.test(token)) {
      const semantic = semanticMap.get(token) || 'other';
      if (tokenClass === 'scope') tokenClass = semantic === 'scope' ? 'scope' : 'soft';
      else if (semantic === 'scope') tokenClass = 'scope';
    }
    if (tokenClass === 'scope' && !compactCorpus.includes(normalizedToken)) scopeSuspicious.push(token);
    if (tokenClass === 'spec' && !compactCorpus.includes(normalizedToken)) specSuspicious.push(token);
    if (tokenClass === 'soft' && !compactCorpus.includes(normalizedToken)) softSuspicious.push(token);
  }
  return buildFactVerificationIssuesFromBuckets({ markdown, factsModel, scopeSuspicious, specSuspicious, softSuspicious });
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

export function professionalScoreIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>, analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const dimensionOrder: DepthDimension[] = ['factuality', 'structure', 'depth', 'executable', 'specificity', 'consistency'];
  for (const chapter of chapters) {
    const text = chapter.content;
    if (documentTextLength(text) < 800) continue;
    const threshold = professionalScoreThreshold(chapter.title);
    const analysis = analyses?.get(chapter.title);
    // 调用方未提供语义分析时跳过（生成中间阶段无章节内容可分析；最终校验恒提供）：
    // 六维覆盖必须由 bge 嵌入判定，关键词正则模拟语义打分必然误伤（变体表述零命中/仅罗列关键词的模板段拿满分）
    if (!analysis) continue;
    const total = dimensionOrder.filter(dimension => analysis.dimensions[dimension]).length * 2;
    if (total < threshold.min) {
      const weak = dimensionOrder.filter(dimension => !analysis.dimensions[dimension]).join('、') || threshold.focus;
      issues.push({ level: 'error', message: `${chapter.title} 专业评分不足：${total}/12，薄弱维度：${weak}`, suggestion: `请按章节任务卡补齐${threshold.focus}，并写出资料依据、实施流程、专业控制点和检查整改闭环。` });
    }
  }
  return issues;
}

export function professionalContentIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>, analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const rules = [
    { re: /进度|工期/u, needKey: 'schedule' as const, need: /关键线路|穿插|纠偏|资源保障|节点|动态调整/u, message: '进度工期章节缺少关键线路、穿插施工或纠偏保障内容' },
    { re: /质量/u, needKey: 'quality' as const, need: /材料.*验收|复验|隐蔽验收|整改.*复验|质量.*资料|检验批/u, message: '质量章节缺少材料验收复验、隐蔽验收或整改复验闭环' },
    { re: /安全|文明|危大|风险/u, needKey: 'safety' as const, need: /风险|临电|消防|应急|检查.*整改|文明施工|人员|设备/u, message: '安全文明章节缺少风险识别、现场控制或应急检查闭环' },
    { re: /资源|材料|设备|劳动力/u, needKey: 'resource' as const, need: /进场|验收|调配|保管|供应|投入计划/u, message: '资源章节缺少进场、验收、调配或保管计划' },
    { re: /施工|工艺|技术|方案/u, needKey: 'construction' as const, need: /准备|流程|工艺|控制点|验收|交底/u, message: '施工技术章节缺少施工准备、工艺流程、控制点或验收要求' },
  ];
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    if (documentTextLength(chapter.content) < 600) continue;
    const analysis = analyses?.get(chapter.title);
    // 调用方未提供语义分析时跳过（生成中间阶段无章节内容可分析；最终校验恒提供）：
    // 缺项判定必须由 bge 嵌入完成，关键词 need 正则必然误伤（“关键线路法（CPM）”等变体表述零命中即判缺项）
    if (!analysis) continue;
    for (const rule of rules) {
      if (!rule.re.test(chapter.title)) continue;
      if (!analysis.contentNeeds[rule.needKey]) issues.push({ level: 'error', message: `${chapter.title}：${rule.message}`, suggestion: '请按专业任务卡定向补写该章节，补齐可实施的控制措施、资料依据和闭环要求。' });
    }
  }
  return issues;
}

function shouldIgnorePreciseToken(token: string, context: string) {
  if (/万元|元|报价|单价|合价|综合单价|预留金|税率|增值税|利润|结算/u.test(`${token} ${context}`)) return true;
  if (/OCR|识别错误|乱码|无法确认|疑似|不确定|语义断裂|页码|目录/u.test(context)) return true;
  if (/^\d+$/.test(token) && Number(token) < 10) return true;
  // 合同条款义务类参数（如通用条款“之日起X天内发出开工通知”、“承包人应在X天内提交”）是法律条款表述，
  // 不是项目专属工程参数，不要求写入正文，也不进入抽查池；项目计划工期参数不受影响。
  // 违约金/保证金阶梯数字（“延期28天及以上”“竣工验收通过后28天”）：证据分块常截断“违约金”语境，
  // 必须按“天以上/‰/暂扣/履约保证金”等强信号独立识别，否则条款数字会被误当成工期参数强制写入正文
  if (/之日起.{0,8}天内|天内.{0,10}(?:发出|提交|通知|回复|答复|完成|开工|竣工|报送|支付|更换)|天以上|天及以上|‰|暂扣|履约保证金|通过后.{0,6}天|因发包人原因|因承包人原因|未能按时|逾期|违约金/u.test(context)) return true;
  return false;
}

function collectPreciseFactTokens(factsModel: DocumentFactsModel) {
  const tokens = new Set<string>();
  for (const fact of factsModel.preciseFacts) {
    // BOQ 清单参数（清单计价表中的设备技术参数、数量等）由“清单项落位”检查单独负责，
    // 不进入精确参数抽查池：清单随机参数（如智能化设备 15.50kPa）会挤占项目核心参数的抽查名额
    if (fact.roleId === 'bill_of_quantities') continue;
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
      // BOQ 清单表格证据（计价表/暂估单价表等）有独立的“清单项落位”检查，
      // 其行级参数（设备技术参数、数量、金额）不进入精确参数抽查池，避免清单随机参数挤占项目核心参数
      if (/bill_of_quantities|boq/u.test(`${item.roleId || ''}`)) continue;
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

export async function preciseFactUsageIssues(markdown: string, factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[] = []): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const normalized = markdown.replace(WHITESPACE_RE, '');
  // 抽查口径对齐：优先使用章节证据窗口内的精确参数（LLM 实际收到的证据），
  // 消除"全项目精确事实中从未进入证据窗口"参数的结构性假阳性；
  // 证据池过小（章节 evidence 缺失或参数过少）时回退全项目精确事实池，保持门禁兜底能力
  const evidenceTokens = collectEvidencePreciseTokens(chapters);
  const tokens = evidenceTokens.length >= PRECISE_FACT_MIN_TOKEN_COUNT ? evidenceTokens : collectPreciseFactTokens(factsModel);
  const used = countUsedPreciseTokens(tokens, normalized);
  if (tokens.length >= PRECISE_FACT_MIN_TOKEN_COUNT && used / tokens.length < PRECISE_FACT_MIN_USAGE_RATE) issues.push({ level: 'warning', message: `可靠精确参数使用不足：${used}/${tokens.length}`, suggestion: '请将资料中可靠的规格、参数、数量、时间、比例和标准编号写入对应章节；商务金额、单价、税率、预留金不得写入正文。' });
  // 关键参数抽查：对高价值精确参数单独抽查使用率，过低时升级为 error，
  // 使导出门禁的"结构化精确参数已使用"检查项显式失败（有正文时不硬阻断导出，避免卡死交付）
  const criticalTokens = criticalPreciseTokens(tokens);
  if (criticalTokens.length >= PRECISE_FACT_CRITICAL_SPOT_COUNT) {
    let criticalUsed = countUsedPreciseTokens(criticalTokens, normalized);
    let missingCritical = criticalTokens.filter(token => !normalized.includes(token.replace(WHITESPACE_RE, '')));
    // Q11 语义兜底：字面未命中的关键参数用本地 bge 对正文句语义判定（"建设规模4646㎡"≈"总建筑面积4646平方米"）
    if (missingCritical.length > 0 && criticalUsed / criticalTokens.length < PRECISE_FACT_CRITICAL_MIN_RATE) {
      const sentences = markdown
        .split(/[。；;|]/u)
        .map(sentence => sentence.trim())
        .filter(sentence => sentence.length >= 6 && sentence.length <= 160)
        .slice(0, 300);
      if (sentences.length > 0) {
        const similarity = await buildSemanticSimilarity(missingCritical.slice(0, 10), sentences);
        missingCritical = missingCritical.filter(token => !sentences.some(sentence => similarity(token, sentence) >= 0.6));
        criticalUsed = criticalTokens.length - missingCritical.length;
      }
    }
    if (criticalUsed / criticalTokens.length < PRECISE_FACT_CRITICAL_MIN_RATE) {
      const shownMissing = missingCritical.slice(0, 3);
      issues.push({ level: 'error', message: `可靠精确参数使用不足：关键参数抽查 ${criticalUsed}/${criticalTokens.length}${shownMissing.length ? `（缺失如 ${shownMissing.join('、')}）` : ''}`, suggestion: '请将资料中的关键工程参数（工期、面积、强度等级、材料规格、规范编号等）写入正文对应章节，不得因参数总量达标而遗漏核心参数。' });
    }
  }
  if (factsModel.bills.length > 0 && !STRUCTURED_DATA_CONTENT_RE.test(markdown)) issues.push({ level: 'error', message: '正文未体现结构化数据资料', suggestion: '请从表格、列表或明细中提取对象、单位、数量、规格和关键参数补入对应章节。' });
  if (factsModel.drawings.length > 0 && !SPECIFICATION_CONTENT_RE.test(markdown)) issues.push({ level: 'error', message: '正文未体现设计/方案/说明类资料', suggestion: '请从设计、方案或说明资料中提取对象、流程、节点、做法、配置、规则和标准要求。' });
  return issues;
}

/** 清单落位校验（Q1 修复链）：字面匹配 + 本地 bge 语义兜底，落位率 <60% 升级 error 进修复循环 */
export async function boqPlacementIssues(markdown: string, _chapters: DocumentDraftChapter[], factsModel: DocumentFactsModel): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const tables = factsModel.tables || [];
  if (tables.length === 0) return issues;

  const normalizedMarkdown = markdown.replace(/\s+/gu, '').toLowerCase();
  let totalRows = 0;
  let placedRows = 0;
  const unplaced: Array<{ name: string; quantity: string }> = [];

  for (const table of tables) {
    const headers = table.headers.map(h => h.replace(/\s+/gu, '').toLowerCase());
    // 列名标签必须整格锚定：旧实现用 `项目名称|…|分部分项|项目特征` 无锚定，会把表标题行
    // （“e.1分部分项工程量清单计价表”）误当名称列，itemName 取到序号（“8”）→ 永不落位
    const nameCol = headers.findIndex(h => /^(?:项目名称|名称|清单项名称|清单项|分部分项(?:工程)?名称|项目特征)/u.test(h));
    const codeCol = headers.findIndex(h => /^(?:项目编码|编码|编号)/u.test(h)); // 不含"序号"，避免序列号误匹配
    const qtyCol = headers.findIndex(h => /^工程量$|^数量$/u.test(h)); // 不含"单位"，避免单位列误读为数量

    for (const row of table.rows) {
      totalRows += 1;
      let itemName = nameCol >= 0 ? (row[nameCol] || '').replace(/\s+/gu, '') : '';
      let itemCode = codeCol >= 0 ? (row[codeCol] || '').replace(/\s+/gu, '') : '';
      const quantity = qtyCol >= 0 ? (row[qtyCol] || '').replace(/\s+/gu, '') : '';
      // 行内形状识别兜底（真实生成缺陷：清单表证据丢失表头行，headers 是首行数据或“表标题+COL 占位”，
      // 标签列识别全部落空 → 74 行 itemName 全空、落位率恒 0/74、unplaced 明细为空、修复轮空转）：
      // 清单编码形态（12 位数字如 030901010001，或字母前缀+8 位以上数字如 WB011701009001）定位编码列，
      // 编码后一格即项目名称列（清单表列序固定：序号|项目编码|项目名称|项目特征|单位|工程量）
      if (!itemName && !itemCode) {
        const codeIdx = row.findIndex(cell => /^\d{10,12}$/u.test(cell) || /^[A-Z]{1,3}\d{8,}$/u.test(cell));
        if (codeIdx >= 0) {
          itemCode = row[codeIdx].replace(/\s+/gu, '');
          itemName = (row[codeIdx + 1] || '').replace(/\s+/gu, '');
        }
      }

      // 检查清单项名称或编码是否在正文中出现（统一使用 16 字符前缀匹配）
      const namePrefix = itemName.length >= 3 ? itemName.slice(0, Math.min(itemName.length, 16)) : '';
      const codePrefix = itemCode.length >= 3 ? itemCode.slice(0, Math.min(itemCode.length, 12)) : '';
      const namePlaced = namePrefix && normalizedMarkdown.includes(namePrefix);
      const codePlaced = codePrefix && normalizedMarkdown.includes(codePrefix);

      if (namePlaced || codePlaced) {
        placedRows += 1;
      } else if (itemName.length >= 3) {
        unplaced.push({ name: itemName, quantity });
      }
    }
  }
  if (totalRows === 0) return issues;

  // Q1 语义兜底：字面未命中的清单项名 vs 正文句 bge 余弦 ≥0.6 视为落位（"立面块料拆除"与"拆除外立面幕墙"同义落位）
  const semanticPlacedNames = new Set<string>();
  if (unplaced.length > 0 && placedRows / totalRows < 0.6) {
    const sentences = markdown
      .split(/[。；;|]/u)
      .map(sentence => sentence.trim())
      .filter(sentence => sentence.length >= 6 && sentence.length <= 160)
      .slice(0, 300);
    const names = [...new Set(unplaced.map(item => item.name))].slice(0, 30);
    if (sentences.length > 0 && names.length > 0) {
      const similarity = await buildSemanticSimilarity(names, sentences);
      for (const name of names) {
        if (sentences.some(sentence => similarity(name, sentence) >= 0.6)) semanticPlacedNames.add(name);
      }
    }
  }
  const placedTotal = placedRows + unplaced.filter(item => semanticPlacedNames.has(item.name)).length;
  const remainingUnplaced = unplaced.filter(item => !semanticPlacedNames.has(item.name));
  const rate = placedTotal / totalRows;
  const unplacedSummary = remainingUnplaced.length > 0
    ? `未落位项（共${remainingUnplaced.length}项）：${remainingUnplaced.slice(0, 30).map(item => `${item.name.slice(0, 40)}${item.quantity ? ` ${item.quantity}` : ''}（未落位）`).join('；')}${remainingUnplaced.length > 30 ? ` 及其他${remainingUnplaced.length - 30}项（同类项按已列名称分组归并补写）` : ''}`
    : '';
  // 落位率 <60% 升 error 进修复循环（补写未落位项）；不命中 CRITICAL_BLOCK_RE 硬阻断清单，
  // 修复轮补写后仍不足时由导出门禁按软性项处理，不卡死交付
  if (rate < 0.6) {
    // 未落位明细必须并入 message：交付阻断修复链的 rechecker 只转发 message，明细留在 suggestion
    // 会丢失（真实生成缺陷：修复指令声称“缺陷描述中已列明细”但明细从未送达，LLM 无据可补写）
    issues.push({ level: 'error', message: `清单项落位不足：${placedTotal}/${totalRows} 项（${Math.round(rate * 100)}%）${unplacedSummary ? `。${unplacedSummary}` : ''}`, suggestion: `请将未落位清单项按专业工程分组补写进对应章节"主要施工内容"小节（施工概况/施工流程/施工方法），优先落位主要分部分项、关键规格与大额工程量。${unplacedSummary}` });
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

/** 模板命中的 autoSpecGates 必要术语列表：Final Gate 确定性补写用，保证施组标准术语（编制依据/主要施工材料等）一定出现在正文 */
export function autoSpecGateRequiredTexts(template: DocumentTemplate): string[] {
  const text = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  const required = new Set<string>();
  for (const gate of readEngineeringDocumentConfig().autoSpecGates) {
    if (templateMatchesAutoSpecGate(text, gate.templateMatchers)) {
      for (const item of gate.requiredTexts) if (item) required.add(item);
    }
  }
  return [...required];
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
