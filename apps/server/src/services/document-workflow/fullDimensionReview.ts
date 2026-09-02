/** 全维度评审轮（round-20 S4/W5）：青天规范内置，分块评审→问题清单→定向修复→复评
 * 设计目标：无论生成什么项目的文档，都收敛到专业级 4.5 分——评审轮不再依赖代码正则围栏，
 * 而是把青天大模型九维评审逻辑（合规红线/内容质量/数据逻辑/内容完整/本地适配/模板化/围串标残留）
 * 作为 LLM 评审提示词内置于本模块，对全文分块评审并定向修复，最后复评验证。
 * 调用预算（用户确认 8-12 次）：首评 ≤7 块 + 定向修复 ≤3 章 + 复评 ≤2 块，全轮 ≤12 次 LLM 调用。
 * 分块策略（round-20 S6 修复）：超长章节按小节/段落边界切段后再贪心入块，块数超上限时按比例放大单块字数重切（自适应），
 * 杜绝「单章 3.6 万字整体送审 → 注意力稀释 → 未检出问题」的假阴性缺陷。
 * 只检测不改写铁律：评审调用只产出问题清单，改写一律走 repairChapterByQuality 局部 patch。
 * 失败语义显式：单块评审失败写入 diagnostics.llm.lastError 并跳过（评审轮不因单块失败整体中断）。
 */

import type { DocumentDraftChapter, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from './types';
import type { DocumentJsonSchema } from './llmClient';
import { callDocumentLlmJson } from './llmClient';
import { documentTextLength } from './budget';
import { normalizeFactUsageText } from './chapterGeneration';
import { repairChapterByQuality } from './rolePipeline';
import { finalizeChapterContentQuality } from './documentGeneratorHelpers';
import { QINGTIAN_REVIEW_SYSTEM, qingtianBlockReviewPrompt, qingtianFixInstructionFor } from './qingtianReviewSpec';
import { docSystemPrefix } from './markdownComposer';
import { collectDocumentHeadings, formatKnownConflictLines, sanitizeIssueLocation, scanCrossChapterDataConflicts } from './crossChapterDataScan';

export interface QingtianReviewIssue {
  dimension: string;
  location: string;
  quote: string;
  riskLevel: '否决级' | '高风险' | '中风险' | '低风险';
  basis: string;
  description: string;
}

/** 评审轮残留问题 → 门禁校验问题（round-20 S5/W8）：
 * 复评后仍残留的否决级/高风险问题按 category 'qingtian_review' 硬阻断导出门禁（isHardExportBlockingIssue 直通），
 * 中低风险仅 warning 展示；消息携带维度/风险等级/原文片段供人工定位。 */
export function qingtianReviewValidationIssues(issues: QingtianReviewIssue[]): ValidationIssue[] {
  return issues.map(issue => {
    const hard = issue.riskLevel === '否决级' || issue.riskLevel === '高风险';
    return {
      level: hard ? 'error' : 'warning',
      severity: hard ? 'blocker' : 'warning',
      repairability: hard ? 'llm_repairable' : 'not_repair_needed',
      category: 'qingtian_review',
      owner: 'llm',
      message: `[全维度评审·${issue.dimension}·${issue.riskLevel}]${issue.location ? `${issue.location}：` : ''}${issue.description}${issue.quote ? `（原文：“${issue.quote.slice(0, 40)}”）` : ''}`,
      suggestion: issue.basis,
    };
  });
}

interface QingtianBlockReviewResult {
  issues?: QingtianReviewIssue[];
  templatingLevel?: string;
}

/** 分块评审预算：单块基础字数上限（超长文档按块数上限自适应放大）、最大块数、修复章数、复评块数 */
const REVIEW_BLOCK_MAX_CHARS = 9000;
const REVIEW_BLOCK_MAX = 7;
const REVIEW_REPAIR_CHAPTER_MAX = 3;
const REVIEW_REREVIEW_BLOCK_MAX = 2;
const REVIEW_ISSUES_PER_REPAIR = 3;
const REVIEW_RISK_ORDER: Record<QingtianReviewIssue['riskLevel'], number> = { '否决级': 0, '高风险': 1, '中风险': 2, '低风险': 3 };

const REVIEW_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      required: true,
      maxItems: 12,
      items: {
        type: 'object',
        required: true,
        properties: {
          dimension: { type: 'string', required: true },
          location: { type: 'string', required: true },
          quote: { type: 'string', required: true, minLength: 4 },
          riskLevel: { type: 'string', required: true },
          basis: { type: 'string', required: true },
          description: { type: 'string', required: true },
        },
      },
    },
    templatingLevel: { type: 'string' },
  },
};

/** 章节内切段：超长章节按小节标题边界切分，超长小节再按段落边界切，保证每段尽量 ≤ maxChars 且不截断句子。
 * 段复用章节 id（问题定位仍映射回原章节），title 追加分段序号供评审提示词区分。 */
export function splitChapterIntoSegments(chapter: DocumentDraftChapter, maxChars: number): DocumentDraftChapter[] {
  const content = chapter.content || '';
  if (documentTextLength(content) <= maxChars) return [chapter];
  const sectionChunks = content.split(/\n(?=#{2,4}\s+\S)/u).filter(text => text.trim().length > 0);
  const pieces: string[] = [];
  for (const sectionChunk of sectionChunks) {
    if (documentTextLength(sectionChunk) <= maxChars) {
      pieces.push(sectionChunk);
      continue;
    }
    // 超长小节按段落边界切分（保留表格/列表块整体性，段落不可再截断）
    const paragraphs = sectionChunk.split(/\n\n+/u).filter(text => text.trim().length > 0);
    let buffer = '';
    for (const paragraph of paragraphs) {
      if (buffer && documentTextLength(buffer) + documentTextLength(paragraph) > maxChars) {
        pieces.push(buffer);
        buffer = paragraph;
      } else {
        buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      }
    }
    if (buffer) pieces.push(buffer);
  }
  // 贪心合并小节/段落至 maxChars
  const segments: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && documentTextLength(current) + documentTextLength(piece) > maxChars) {
      segments.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) segments.push(current);
  if (segments.length <= 1) return [chapter];
  return segments.map((text, index) => ({
    ...chapter,
    title: `${chapter.title}（分段 ${index + 1}/${segments.length}）`,
    content: text,
  }));
}

/** 段贪心装箱：按段顺序累加字数入块，达到 maxChars 时切块；段不可分割（完整性优先） */
function packSegmentsIntoBlocks(segments: DocumentDraftChapter[], maxChars: number): DocumentDraftChapter[][] {
  const blocks: DocumentDraftChapter[][] = [];
  let current: DocumentDraftChapter[] = [];
  let currentLength = 0;
  for (const segment of segments) {
    const length = documentTextLength(segment.content);
    if (current.length > 0 && currentLength + length > maxChars) {
      blocks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(segment);
    currentLength += length;
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** 章节分块：先按单块字数上限切段（超长章按小节/段落边界分段），再贪心装箱入块；
 * 块数超过 maxBlocks 时按比例放大单块字数重切（自适应），保证块数尽量 ≤ maxBlocks 且全文无遗漏。 */
export function splitChaptersIntoReviewBlocks(chapters: DocumentDraftChapter[], maxChars: number = REVIEW_BLOCK_MAX_CHARS, maxBlocks: number = REVIEW_BLOCK_MAX): DocumentDraftChapter[][] {
  const segments: DocumentDraftChapter[] = [];
  for (const chapter of chapters) segments.push(...splitChapterIntoSegments(chapter, maxChars));
  let blocks = packSegmentsIntoBlocks(segments, maxChars);
  if (blocks.length > maxBlocks) {
    const totalChars = segments.reduce((sum, segment) => sum + documentTextLength(segment.content), 0);
    let effectiveMaxChars = Math.max(maxChars, Math.ceil(totalChars / Math.max(1, maxBlocks)));
    while (blocks.length > maxBlocks && effectiveMaxChars < totalChars) {
      effectiveMaxChars = Math.min(totalChars, Math.ceil(effectiveMaxChars * 1.3) + 1);
      blocks = packSegmentsIntoBlocks(segments, effectiveMaxChars);
    }
  }
  return blocks;
}

/** 风险等级归一化：LLM 输出非法值时收敛为中风险（非极值），保证排序与修复分流安全 */
function normalizeRiskLevel(value: string): QingtianReviewIssue['riskLevel'] {
  if (value === '否决级' || value === '高风险' || value === '低风险') return value;
  return '中风险';
}

/** 问题去重：同维度+同原文片段（归一化后前 24 字）只保留一条 */
function dedupeQingtianIssues(issues: QingtianReviewIssue[]): QingtianReviewIssue[] {
  const seen = new Set<string>();
  return issues.filter(issue => {
    const key = `${issue.dimension}|${(issue.quote || '').replace(/\s+/gu, '').slice(0, 24)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 问题 → 章节定位：先按 location 匹配章节标题，失败用 quote 归一化反查正文 */
function locateChapterByIssue(issue: QingtianReviewIssue, chapters: DocumentDraftChapter[]): number {
  if (issue.location) {
    const byLocation = chapters.findIndex(chapter => chapter.title === issue.location || chapter.title.includes(issue.location) || issue.location.includes(chapter.title));
    if (byLocation >= 0) return byLocation;
  }
  const normalizedQuote = (issue.quote || '').replace(/\s+/gu, '').slice(0, 20);
  if (normalizedQuote.length >= 8) {
    return chapters.findIndex(chapter => (chapter.content || '').replace(/[\s,，]/gu, '').includes(normalizedQuote));
  }
  return -1;
}

/** 单块评审：一次 LLM 调用产出结构化问题清单；失败显式记录并返回 undefined。
 * 输出后置校验：location 与全文标题集合比对（LLM 幻觉定位标注"待核"），阻断错误定位进入修复与评分报告。 */
async function reviewDocumentBlock(chapters: DocumentDraftChapter[], context: { projectName: string; requirement?: string; tenderContext?: string; knownConflictLines?: string; headings: string[]; blockIndex: number; blockTotal: number }, diagnostics?: DocumentGenerationDiagnostics, signal?: AbortSignal): Promise<QingtianBlockReviewResult | undefined> {
  const blockContent = chapters.map(chapter => `### ${chapter.title}\n${chapter.content}`).join('\n\n');
  const reviewed = await callDocumentLlmJson<QingtianBlockReviewResult>(docSystemPrefix(QINGTIAN_REVIEW_SYSTEM), qingtianBlockReviewPrompt({ ...context, chapterTitles: chapters.map(chapter => chapter.title), blockContent }), {
    maxTokens: 1800,
    temperature: 0.1,
    signal,
    diagnostics,
    schema: REVIEW_SCHEMA,
    taskKind: 'structuredGeneration',
    disableThinkingBoost: true,
    prefixKey: 'full-dimension-review',
  });
  if (!reviewed) return undefined;
  return {
    issues: (reviewed.issues || []).map(issue => ({ ...issue, location: sanitizeIssueLocation(issue.location, context.headings), riskLevel: normalizeRiskLevel(issue.riskLevel) })),
    templatingLevel: reviewed.templatingLevel,
  };
}

export interface FullDimensionReviewInput {
  template: DocumentTemplate;
  chapters: DocumentDraftChapter[];
  effectiveChapters: DocumentTemplateChapter[];
  requirement?: string;
  projectName?: string;
  /** 招标对标材料（工程概况事实/评标办法条目/评分项要求/清单特征摘要）：
   * 评审轮零检出根因修复（round-21 S6）——不注入对标材料时评审模型无招标依据可对照，
   * 只能按通用规范空评且“不确定的不报”，实测 5 块评审零检出而外部评分检出 207 条 */
  tenderContext?: string;
  /** 2.2 跨系统去重：blocker 修复循环已修复成功的缺陷签名（code+归一化原文），
   * 与评审 issue 原文比对命中时按 DOCUMENT_CROSS_SYSTEM_DEDUPE 跳过重复 LLM 修复 */
  resolvedBlockerSignatures?: Set<string>;
  diagnostics?: DocumentGenerationDiagnostics;
  signal?: AbortSignal;
  /** 心跳包装（与生成管线一致，长任务期间保持进度推送） */
  heartbeat?: <T>(task: () => Promise<T>) => Promise<T>;
  /** 阶段回调：pipeline 侧映射为 displayStage/upsertProgressStage */
  onStage?: (stage: { status: 'running' | 'success' | 'failed'; message: string; details: string[] }) => void;
}

export interface FullDimensionReviewResult {
  reviewed: boolean;
  reviewCalls: number;
  repairCalls: number;
  reReviewCalls: number;
  issuesFound: number;
  fixedCount: number;
  remainingIssues: QingtianReviewIssue[];
  templatingLevels: string[];
  repairedChapters: string[];
}

export async function runFullDimensionReview(input: FullDimensionReviewInput): Promise<FullDimensionReviewResult> {
  const { template, chapters, effectiveChapters, requirement, projectName, tenderContext, resolvedBlockerSignatures, diagnostics, signal, heartbeat, onStage } = input;
  const run = <T>(task: () => Promise<T>): Promise<T> => (heartbeat ? heartbeat(task) : task());
  const result: FullDimensionReviewResult = { reviewed: false, reviewCalls: 0, repairCalls: 0, reReviewCalls: 0, issuesFound: 0, fixedCount: 0, remainingIssues: [], templatingLevels: [], repairedChapters: [] };
  const blocks = splitChaptersIntoReviewBlocks(chapters);
  if (blocks.length === 0) return result;
  // ── 0. 确定性前置：跨章数据矛盾预扫描（分块盲区补足）+ 全文标题集合（输出定位后置校验基准）──
  const knownConflictLines = formatKnownConflictLines(scanCrossChapterDataConflicts(chapters));
  const headings = collectDocumentHeadings(chapters);
  // 2.1 patch 前置校验开关（两阶段灰度）：observe 只观测命中（默认）、enforce 拒绝坏 patch、0 关闭
  const patchGuardMode = process.env.DOCUMENT_QINGTIAN_PATCH_GUARD || 'observe';
  const patchGuard = patchGuardMode === '0' ? undefined : { observeOnly: patchGuardMode !== 'enforce', diagnostics };
  // 2.2 跨系统去重开关（两阶段灰度）：observe 只计数重复修复（默认）、enforce 跳过重复 LLM 修复、0 关闭
  const dedupeMode = process.env.DOCUMENT_CROSS_SYSTEM_DEDUPE || 'observe';
  const isResolvedByBlocker = (issue: QingtianReviewIssue): boolean => {
    if (dedupeMode === '0' || !resolvedBlockerSignatures || resolvedBlockerSignatures.size === 0) return false;
    const normalizedQuote = normalizeFactUsageText(issue.quote);
    for (const signature of resolvedBlockerSignatures) {
      if (signature.endsWith(`\u0000${normalizedQuote}`)) return true;
    }
    return false;
  };
  // enforce 模式跳过的 issue（已由确定性系统修复）降为中低风险清单进报告展示
  const dedupeSkippedIssues: QingtianReviewIssue[] = [];
  // ── 1. 分块评审（每块一次调用，单块失败显式记录并跳过，其余块继续）──
  const allIssues: QingtianReviewIssue[] = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    onStage?.({ status: 'running', message: `全维度评审：第 ${blockIndex + 1}/${blocks.length} 块（${block.map(chapter => chapter.title).join('、')}）`, details: [] });
    const reviewed = await run(() => reviewDocumentBlock(block, { projectName: projectName || '本项目', requirement, tenderContext, knownConflictLines, headings, blockIndex: blockIndex + 1, blockTotal: blocks.length }, diagnostics, signal));
    result.reviewCalls += 1;
    if (!reviewed) {
      if (diagnostics && !/qingtian-review/u.test(diagnostics.llm.lastError || '')) {
        diagnostics.llm.lastError = `qingtian-review: 第 ${blockIndex + 1}/${blocks.length} 块评审无响应，跳过（${diagnostics.llm.lastError || '无响应'}）`;
      }
      onStage?.({ status: 'failed', message: `全维度评审：第 ${blockIndex + 1}/${blocks.length} 块无响应，跳过`, details: [] });
      continue;
    }
    if (reviewed.templatingLevel && reviewed.templatingLevel !== '无') result.templatingLevels.push(reviewed.templatingLevel);
    allIssues.push(...reviewed.issues || []);
  }
  // ── 2. 问题排序去重：风险优先，同维度+同原文片段合并 ──
  const rankedIssues = dedupeQingtianIssues(allIssues).sort((left, right) => REVIEW_RISK_ORDER[left.riskLevel] - REVIEW_RISK_ORDER[right.riskLevel]);
  result.issuesFound = rankedIssues.length;
  if (rankedIssues.length === 0) {
    onStage?.({ status: 'success', message: `全维度评审完成：${blocks.length} 块评审未检出问题`, details: [] });
    result.reviewed = true;
    return result;
  }
  // ── 3. 定向修复：仅否决级/高风险进修复（中低风险只报告），每章一次调用合并至多 3 条问题 ──
  const chapterIssueGroups: Array<{ chapterIndex: number; issues: QingtianReviewIssue[] }> = [];
  for (const issue of rankedIssues) {
    if (issue.riskLevel !== '否决级' && issue.riskLevel !== '高风险') continue;
    // 2.2 跨系统去重：与 blocker 已修缺陷签名比对，observe 计数（照常修复）、enforce 跳过重复 LLM 修复
    if (isResolvedByBlocker(issue)) {
      if (dedupeMode === 'enforce') {
        if (diagnostics) diagnostics.llm.qingtianDedupeSkipped = (diagnostics.llm.qingtianDedupeSkipped ?? 0) + 1;
        dedupeSkippedIssues.push(issue);
        continue;
      }
      if (diagnostics) diagnostics.llm.qingtianDedupeHits = (diagnostics.llm.qingtianDedupeHits ?? 0) + 1;
    }
    const chapterIndex = locateChapterByIssue(issue, chapters);
    if (chapterIndex < 0) continue;
    const group = chapterIssueGroups.find(item => item.chapterIndex === chapterIndex);
    if (group) {
      if (group.issues.length < REVIEW_ISSUES_PER_REPAIR) group.issues.push(issue);
    } else if (chapterIssueGroups.length < REVIEW_REPAIR_CHAPTER_MAX) {
      chapterIssueGroups.push({ chapterIndex, issues: [issue] });
    }
  }
  for (const group of chapterIssueGroups) {
    const chapter = chapters[group.chapterIndex];
    const templateChapter = effectiveChapters.find(item => item.id === chapter.id || item.title === chapter.title);
    onStage?.({ status: 'running', message: `全维度评审修复：${chapter.title}（${group.issues.length} 处）`, details: group.issues.map(issue => `[${issue.riskLevel}]${issue.description.slice(0, 48)}`) });
    const repaired = await run(() => repairChapterByQuality({
      template,
      chapter: { id: chapter.id, title: chapter.title, content: chapter.content, evidence: chapter.evidence, missingFacts: chapter.missingFacts, sections: chapter.sections },
      issues: group.issues.map(issue => `[${issue.riskLevel}][${issue.dimension}] ${issue.description}（原文：${issue.quote}）`),
      promptTexts: qingtianFixInstructionFor(group.issues),
      requirement,
      forbidDrawingImages: false,
      diagnostics,
      signal,
      patchGuard,
    }));
    result.repairCalls += 1;
    const applied = Boolean(repaired.content && repaired.content !== chapter.content);
    if (applied) {
      chapters[group.chapterIndex] = { ...chapter, content: templateChapter ? finalizeChapterContentQuality(repaired.content, templateChapter) : repaired.content };
      result.fixedCount += repaired.appliedCount;
      result.repairedChapters.push(chapter.title);
    }
    onStage?.({ status: applied ? 'success' : 'failed', message: applied ? `全维度评审修复完成：${chapter.title}（${repaired.appliedCount} 处 patch）` : `全维度评审修复未生效：${chapter.title}`, details: group.issues.map(issue => `[${issue.riskLevel}]${issue.description.slice(0, 48)}`) });
  }
  // ── 4. 复评：修复章最新内容重新分段评审（≤2 块），确认否决级/高风险问题是否消除 ──
  const remainingIssues: QingtianReviewIssue[] = [];
  const repairedChapterIds = new Set<string>(chapterIssueGroups.map(group => chapters[group.chapterIndex].id));
  const reReviewBlocks = splitChaptersIntoReviewBlocks(chapters.filter(chapter => repairedChapterIds.has(chapter.id)), REVIEW_BLOCK_MAX_CHARS, REVIEW_REREVIEW_BLOCK_MAX);
  for (let blockIndex = 0; blockIndex < reReviewBlocks.length; blockIndex += 1) {
    const block = reReviewBlocks[blockIndex];
    onStage?.({ status: 'running', message: `全维度评审复评：第 ${blockIndex + 1}/${reReviewBlocks.length} 块（${block.map(chapter => chapter.title).join('、')}）`, details: [] });
    const reReviewed = await run(() => reviewDocumentBlock(block, { projectName: projectName || '本项目', requirement, knownConflictLines, headings, blockIndex: blockIndex + 1, blockTotal: reReviewBlocks.length }, diagnostics, signal));
    result.reReviewCalls += 1;
    if (!reReviewed) {
      onStage?.({ status: 'failed', message: `全维度评审复评：第 ${blockIndex + 1}/${reReviewBlocks.length} 块无响应，跳过`, details: [] });
      continue;
    }
    remainingIssues.push(...(reReviewed.issues || []).filter(issue => normalizeRiskLevel(issue.riskLevel) === '否决级' || normalizeRiskLevel(issue.riskLevel) === '高风险'));
  }
  // 中低风险问题不修复，直接进入剩余清单供交付报告展示
  remainingIssues.push(...rankedIssues.filter(issue => issue.riskLevel === '中风险' || issue.riskLevel === '低风险'));
  // 2.2 enforce 跳过的问题（已由确定性系统修复）降级并入剩余清单，供报告展示去重证据
  remainingIssues.push(...dedupeSkippedIssues);
  result.remainingIssues = dedupeQingtianIssues(remainingIssues);
  result.reviewed = true;
  onStage?.({ status: 'success', message: `全维度评审完成：${blocks.length} 块评审检出 ${result.issuesFound} 处问题，修复 ${result.fixedCount} 处 patch，剩余 ${result.remainingIssues.length} 处`, details: result.remainingIssues.slice(0, 6).map(issue => `[${issue.riskLevel}][${issue.dimension}]${issue.description.slice(0, 40)}`) });
  return result;
}
