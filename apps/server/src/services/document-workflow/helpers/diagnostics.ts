/**
 * helpers/diagnostics：诊断/健康/生成状态判定（P3 拆分，逐字机械搬移自 documentGeneratorHelpers.ts）。
 * 无域内跨依赖。
 */
import * as path from 'node:path';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from '../types';
import { documentTextLength } from '../budget';
import { templatePromptBindings, type ResolvedPromptContent } from '../templateStore';
import { criticalSectionBlockerMinChars } from '../chapterPostProcessing';

export function chapterGenerationTargets(input: { budgetTarget: number; sectionCount: number; title: string; longformStrict: boolean }) {
  const { budgetTarget, sectionCount, title, longformStrict } = input;
  const composite = /[、，,；;]/u.test(title);
  const isCritical = /工期|进度|质量|安全|危大|资源|人材机|保障|措施|重难点/u.test(title);
  const isLight = /概况|结语|附录|说明/u.test(title);
  const structureTarget = sectionCount > 0
    ? sectionCount * (composite ? 720 : isCritical ? 900 : 780)
    : isCritical ? 5200 : 3600;
  const lower = longformStrict ? (isLight ? 2600 : isCritical ? 5200 : 3600) : Math.min(1200, budgetTarget);
  const upper = longformStrict
    ? Math.min(Math.max(4200, budgetTarget), sectionCount >= 30 ? 9800 : composite ? 8800 : isCritical ? 9200 : 7200)
    : budgetTarget;
  // 长文模式（提示词有明确篇幅要求如「不少于5万字」）：提示词预算必须完整下达，不得被
  // upper 硬顶（7200~9800）与 structureTarget（节均 720~900 字的结构估算）双重压制，
  // 否则章预算 16667 字被压至 5200~9200 字，5 万字要求永远达不到（历史缺陷：字数卡 3.8 万）。
  // 单次 LLM 调用的输出安全由块/节级预算（写作任务拆分）独立保证，不在章级截断目标。
  const roundTarget = longformStrict
    ? Math.max(lower, budgetTarget)
    : Math.max(lower, Math.min(budgetTarget, structureTarget, upper));
  return {
    budgetTarget,
    roundTarget,
    structureTarget,
    maxWords: Math.ceil(roundTarget * (input.longformStrict ? 1.12 : 1.18)),
    label: `章节预算约 ${budgetTarget} 字，本轮生成约 ${roundTarget} 字，结构目标约 ${structureTarget} 字`,
  };
}

export function validateDraft(chapters: DocumentDraftChapter[], _structuredFacts: DocumentFact[] = [], template?: DocumentTemplate) {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const chapter of chapters) {
    if (chapter.evidence.length === 0) warnings.push(`${chapter.title} 未检索到资料证据`);
    if (chapter.content.length < 80) warnings.push(`${chapter.title} 内容较短，建议人工补充或重新生成`);
  }
  if (template && chapters.length < template.chapters.length) errors.push(`章节生成不完整：已生成 ${chapters.length}/${template.chapters.length} 章`);
  if (template && templatePromptBindings(template).length === 0) errors.push('模板未绑定任何提示词');
  return { passed: errors.length === 0, warnings, errors };
}

export function chapterCompletionStatus(chars: number, _targetWords: number, issues: string[] = []): DocumentExecutionStage['status'] {
  if (chars <= 0 || issues.some(issue => /未返回有效章节正文|生成失败/u.test(issue))) return 'failed';
  // 4.17.8 收紧写作结构门禁（章节成稿验收线）：空小节/缺少规划小节是结构完整性硬缺陷，
  // 写作侧产出该缺陷即如实标记 failed（不再对"结构不完整但正文非空"的章节标 success）——
  // 质量问题在写作阶段显性暴露，由单轮修复兜底后转导出门禁阻断，修复是辅助不是主力
  if (issues.some(issue => /空小节|缺少规划小节/u.test(issue))) return 'failed';
  return 'success';
}

/**
 * Repairer 补写目标字数：对齐 Reviewer 深度通过线（承接小节组内最大 minChars × 0.8）。
 * 目标 = ceil(anchorMinChars / 0.8)，使 Repairer 验收线 0.7×目标 ≈ 0.875×anchorMinChars ≥ Reviewer 0.8×anchorMinChars，
 * 一次补写即可复审通过；否则补写达标却被复审驳回，同一小节反复修（历史缺陷：补写 793 字过 Repairer 验收线仍被复审驳回）。
 */
export function repairTargetWordsForSection(sectionTitle: string, taskMinChars?: number, anchorMinChars?: number) {
  return Math.max(
    taskMinChars || 0,
    anchorMinChars && anchorMinChars > 0 ? Math.ceil(anchorMinChars / 0.8) : 0,
    /项目主要施工内容/u.test(sectionTitle) ? 2200
      : /主要分部分项工程施工方案|主要施工方法/u.test(sectionTitle) ? 1800
        : /项目特点.*重点.*难点|重点.*难点.*分析/u.test(sectionTitle) ? 1500
          : /原材料进场复试|见证取样|危大工程专项施工方案审批流程/u.test(sectionTitle) ? 900 : 760,
  );
}

/**
 * warning 级"正文不足"问题检测：Reviewer 只把关键小节的"正文不足"标为 blocker，普通小节是 warning 级；
 * 修复循环若不处理 warning 级深度缺口，修复多轮问题数纹丝不动（历史缺陷：47 个 warning 修复两轮后仍 49 个问题）。
 */
export function hasDepthWarningIssues(issues: Array<{ level?: string; severity?: string; message: string }>) {
  return issues.some(issue => issue.level !== 'error' && issue.severity !== 'blocker' && /正文不足，未达到任务最小深度/u.test(issue.message));
}

/**
 * Final Gate 关键小节深度阻断线：min(规则表 blocker 线, Writer/Repairer/Final Gate 修复验收线)。
 * 阻断线不得超过修复验收线（criticalSectionBlockerMinChars），否则补写达标替换后重算仍不足，同一小节永不自愈。
 * 历史缺陷："主要施工方法"修复验收线 1200 但阻断线 1760（规则表 2200×0.8），补写 1715 字达标替换后仍被判不足，整篇生成失败。
 */
export function criticalSectionBlockerLine(title: string) {
  const rules: Array<{ title: string; minChars: number; blockerMinChars?: number }> = [
    { title: '项目特点、重点、难点分析', minChars: 1800 },
    { title: '项目主要施工内容', minChars: 2200 },
    { title: '主要分部分项工程施工方案', minChars: 1200, blockerMinChars: 800 },
    { title: '主要施工方法', minChars: 2200 },
    { title: '危大工程专项施工方案审批流程', minChars: 500, blockerMinChars: 250 },
    { title: '原材料进场复试与见证取样', minChars: 600, blockerMinChars: 300 },
  ];
  const rule = rules.find(item => item.title === title);
  if (!rule) return 0;
  const ruleBlocker = rule.blockerMinChars || Math.floor(rule.minChars * 0.8);
  const repairAcceptLine = criticalSectionBlockerMinChars(title);
  return Math.min(ruleBlocker, repairAcceptLine > 0 ? repairAcceptLine : ruleBlocker);
}

/**
 * 小节标题 → 承接锚点标题：plannedCoverage 映射存在时用首个承接 H4 标题（标题可能被语义重写），
 * 否则用规划标题本身。Repairer 补写目标必须按锚点查深度表，按规划标题查会 miss（历史缺陷：1:1 标题重写小节查表得 0，补写达标仍被复审驳回）。
 */
export function anchorTitleForSection(plannedCoverage: Record<string, string[]> | undefined, sectionTitle: string) {
  const anchors = plannedCoverage?.[sectionTitle];
  return anchors && anchors.length > 0 ? anchors[0] : sectionTitle;
}

export function partialChapterStatus(chapter: DocumentDraftChapter, _targetWords?: number): 'completed' | 'failed' {
  const chars = documentTextLength(chapter.content);
  if (chars <= 0) return 'failed';
  return 'completed';
}

export function summarizeIssueList(prefix: string, filePaths: string[], limit = 12) {
  if (filePaths.length === 0) return [];
  const names = filePaths.slice(0, limit).map(filePath => path.basename(filePath));
  const suffix = filePaths.length > limit ? ` 等 ${filePaths.length} 个文件` : '';
  return [`${prefix}：${names.join('、')}${suffix}`];
}

export function kbIndexHealth(project: EvidenceLimitProject, scopedFilePaths: string[]) {
  const scoped = new Set(scopedFilePaths.filter(Boolean));
  const files = project.listFiles?.() || [];
  const scopedRecords = files.filter(record => scoped.size === 0 || scoped.has(record.relativePath));
  const indexedPaths = new Set(scopedRecords.map(record => record.relativePath));
  const missingFiles = [...scoped].filter(filePath => !indexedPaths.has(filePath));
  const emptyFiles = scopedRecords.filter(record => Math.max(0, Math.ceil(Number(record.chunkCount) || 0)) === 0).map(record => record.relativePath);
  const errorFiles = scopedRecords.filter(record => record.status === 'error').map(record => record.relativePath);
  const pendingJobs = typeof project.countPendingIndexJobs === 'function' ? project.countPendingIndexJobs() : 0;
  const vectorStatus = typeof project.getVectorStatus === 'function' ? project.getVectorStatus() : undefined;
  const usableRecords = scopedRecords.filter(record => record.status !== 'error' && Math.max(0, Math.ceil(Number(record.chunkCount) || 0)) > 0);
  const usablePaths = usableRecords.map(record => record.relativePath);
  const usableChunkCount = usableRecords.reduce((sum, record) => sum + Math.max(0, Math.ceil(Number(record.chunkCount) || 0)), 0);
  const unavailableWarnings = [
    ...summarizeIssueList('部分绑定文件未完成索引，已自动跳过', missingFiles),
    ...summarizeIssueList('部分绑定文件没有可用切片，已自动跳过', emptyFiles),
    ...summarizeIssueList('部分绑定文件索引失败，已自动跳过', errorFiles),
  ];
  const blockingIssues = scoped.size > 0 && usableChunkCount === 0 ? ['所有绑定文件均无可用切片'] : [];
  const warnings = [
    ...unavailableWarnings,
    ...(pendingJobs > 0 ? [`仍有 ${pendingJobs} 个待索引任务，建议等待索引完成后生成`] : []),
    ...(vectorStatus && vectorStatus.status !== 'ready' ? [`向量索引状态为 ${vectorStatus.status}，当前召回质量可能下降`] : []),
  ];
  return { scopedRecords, usablePaths, missingFiles, emptyFiles, errorFiles, pendingJobs, vectorStatus, usableChunkCount, blockingIssues, warnings };
}

export type EvidenceLimitProject = {
  listFiles?: () => Array<{ relativePath: string; chunkCount?: number; status?: string }>;
  countPendingIndexJobs?: () => number;
  getVectorStatus?: () => { status: string; error?: string; indexedChunks: number; lastIndexedAt: number; backend: string };
};

export function slowMetricSummary(metrics: DocumentGenerationDiagnostics['metrics']) {
  return [...metrics]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map(metric => `${metric.name} ${Math.round(metric.durationMs / 1000)}秒`)
    .join('，');
}

/** 4.1 per-调用分量 Top5 排序（按输入字符降序；同值保持插入序，V8 稳定排序保证确定性） */

function callBreakdownTop(breakdown: DocumentGenerationDiagnostics['llm']['callBreakdown'], topN = 5) {
  if (!breakdown) return [];
  return Object.entries(breakdown)
    .sort((a, b) => b[1].inputChars - a[1].inputChars)
    .slice(0, topN);
}

/** 4.1 per-调用分量 Top 摘要：进度页后台诊断 message 压缩展示（prefixKey 次数/输入万字） */

export function callBreakdownTopSummary(breakdown: DocumentGenerationDiagnostics['llm']['callBreakdown'], topN = 5) {
  return callBreakdownTop(breakdown, topN)
    .map(([key, item]) => `${key} ${item.calls}次/${(item.inputChars / 10000).toFixed(1)}万字`)
    .join('，');
}

/** 4.2 阶段耗时瀑布：phase:* 主流程阶段按开始时间排序逐行展示（完整瀑布，补齐既有 Top5 慢步骤之外的阶段视图） */

export function phaseWaterfallDetails(metrics: DocumentGenerationDiagnostics['metrics']) {
  return metrics
    .filter(metric => metric.name.startsWith('phase:'))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(metric => `${metric.name}：${(metric.durationMs / 1000).toFixed(1)} 秒`);
}

/** 4.1 per-调用分量 Top 详情：五维度完整行（details 逐行展示 次数/输入字符/L3 字符/缓存命中 token） */

export function callBreakdownTopDetails(breakdown: DocumentGenerationDiagnostics['llm']['callBreakdown'], topN = 5) {
  return callBreakdownTop(breakdown, topN)
    .map(([key, item]) => {
      const total = item.cacheHitTokens + item.cacheMissTokens;
      const cacheText = total > 0 ? `，缓存命中 ${Math.round((item.cacheHitTokens / total) * 100)}%（${item.cacheHitTokens}/${total} token）` : '';
      return `${key}：${item.calls} 次，输入 ${(item.inputChars / 10000).toFixed(1)} 万字（L3 ${(item.l3Chars / 10000).toFixed(1)} 万字）${cacheText}`;
    });
}

export function resolveDocumentGenerationEvidenceLimit(project: EvidenceLimitProject, scopedFilePaths: string[], requestedLimit?: number): number {
  if (Number.isFinite(requestedLimit) && requestedLimit! > 0) return Math.ceil(requestedLimit!);
  const scoped = new Set(scopedFilePaths.filter(Boolean));
  const chunkCount = project.listFiles?.()
    .filter(record => scoped.size === 0 || scoped.has(record.relativePath))
    .reduce((sum, record) => sum + Math.max(0, Math.ceil(Number(record.chunkCount) || 0)), 0) ?? 0;
  if (chunkCount > 0) return chunkCount;
  return Math.max(1, scoped.size);
}
