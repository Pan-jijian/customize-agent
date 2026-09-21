/**
 * 全局质量收口块（从 documentGenerator.generateDocumentDraft 提取）：
 * 章节循环之后的全局收口阶段——全局一致性审查、表格执行率修复、补表后去重、预算裁剪报告。
 * 提取原则：行为保持，函数参数即原闭包捕获变量，返回值即原块对后续流程的产出。
 */
import type { DocumentDraftChapter, DocumentExecutionStage, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, NumericScopeConflict } from './types';
import { displayStage, upsertProgressStage } from './progress';
import { snapshotEmbedCacheStats } from './semanticSimilarity';
import { ambiguousEitherOrIssues, applyNumericConsistencyDeterministicFixes, applySpanReplacements, basicInfoScheduleFieldIssues, crossProjectValueCopyIssues, crossSectionNumericConflictIssues, dangerousListConsistencyIssues, duplicateParagraphIssues, duplicateTableIssues, duplicateTableRowIssues, equipmentBatchConflicts, excavationDepthFromFacts, excavationDepthLockIssues, extractAssemblyRateAuthority, extractGreeningMaintenanceAuthority, extractProjectScaleSummary, extractScheduleAuthority, extractSupportSystemAuthority, fixAdjacentPhraseDuplication, fixAmbiguousEitherOrCandidates, fixForbiddenConfigurationTerms, fixGreeningMaintenanceMismatch, fixHeaderlessTables, fixInternalTerminology, fixPlaceholderTableCells, fixSelfUnderminingCandidates, formulaResidueIssues, foundationFormResidueIssues, laborPeakConflictIssues, metaDiscourseDeclarationIssues, nodeScheduleConsistencyIssues, overviewRecapIssues, phaseLaborMixingIssues, preliminaryActionTimingIssues, resourceConsistencyIssues, resourceTriadSectionHierarchyIssues, sixHundredPercentCoverageIssues, specLocationMismatchIssues, stripDuplicateParagraphs, stripDuplicateTables, stripDuplicateTablesAcrossChapters, stripInternalDuplicateTableRows, supportSystemConflictIssues, tablePeakLaborWithChainFallback, waterLaborPeakAssociationIssues } from './documentIntegrityChecks';
import { arbitrateNumericConflicts } from './numericConflictArbiter';
import type { BillFactLock } from './billFactLock';
import { blueprintCitationVerdict, rebaseCitationAnchorsForChapters, type BlueprintCitationAdjudicationSummary, type BlueprintData, type QuantityConflictAnchor } from './integratedBlueprint';
import { blueprintEquipmentAuthorities, blueprintLaborPeakAuthority, blueprintPhaseLaborAuthorities, blueprintQuantityGroupAuthorities, buildAuthorityIndex } from './authorityIndex';
import { applyDeterministicConsistencyFixes, classifyThematicSectionKey, collectSectionContentGaps, crossChapterConsistencyIssues, emptyUnplannedSectionSpans, normalizeSectionTitleForGap, processSpecConflictIssues } from './qualityValidation';
import { professionalSectionTaskCard } from './promptRuleExtraction';
import { reviewGlobalConsistency } from './chapterReview';
import { dataConsistencyConflictIssue, reviewDataConsistency } from './dataConsistencyReview';
import { tablePlanExecutionGaps } from './constructionOrgTablePlan';
import { measureGenerationStep, repairChapterByQuality, repairPatchGuard } from './rolePipeline';
import { withPatchRollback } from './patchRollback';
import { fillerSentenceTargets, stripZeroInfoSloganSentences, templatePrefixTargets } from './constructionOrgAudit';
import { difficultyCountermeasureReport, fillerDensityReport, scanTemplatePrefixSentences } from './tenderBidChecks';
import { missingWorkPackageSkeletonTitles, stripEmptyWorkPackageHeadings, stripTablesInSection, workPackageSkeletonTitles } from './chapterPostProcessing';
import { DIVISION_SECTION_RE } from './writingSpec';
import { majorContentGovernanceIssues, perPackageContentElementIssues } from './constructionOrgQualityRules';
import { flowFormRepairTargets, isStructuralLabelTitle, sentencePatternRepairTargets, skeletonFingerprintRepairTargets, titleRepairTargets } from './templatingGovernance';
import { bodyTableDismantleIssue, isBodyFigureForbidden, isBodyTableForbidden, unplannedBodyTableIssue, type BidCompositionSpec } from './bidComposition';
import { countMarkdownTables, extractGeneratedSections, extractMarkdownTableTextBlocks } from './markdownComposer';
import { normalizeGeneratedChapterTitle } from './outline';
import { nearSubsectionTitleMatch, normalizeSubsectionTitleForDedup, sectionHeadingTitleText, WORK_PACKAGE_SECTION_RE } from './utils';
import { renumberSectionHeadings } from './structureIntegrityRules';

export type EmitProgressFn = (checkpointChapters?: DocumentDraftChapter[], stages?: DocumentExecutionStage[]) => void;
export type WithProgressHeartbeatFn = <T>(work: () => Promise<T>) => Promise<T>;

// F8 残留冲突分类正则（模块级导出供单测锁定分类口径）：命中 → 资料两可/审查提示类残留（benign，不置 failed）；
// 不命中 → 确定性可修但修复后仍残留（blocking，置 failed 由交付门禁兑底）
export const AMBIGUOUS_RESIDUE_RE = /两可|按图纸|资料[^。；;\n]{0,14}(?:未明确|两可|冲突)|支护[^。；;\n]{0,10}并存/u;

/**
 * P4 预算裁剪报告：生成全程软限制裁剪量汇总，历史缺陷（maxItems/maxChars/slice 静默裁剪，链路无感知，
 * 质量问题时无法区分「证据不足」与「预算截断」）在此收敛为单一可观测出口；
 * 软限制审计分类：语义取舍类已迁移本地语义模型，防爆兜底类保留且逐项记录裁剪量
 * A6 上下文可观测：LLM 输入规模与 prefix cache 命中率并入同一出口，供上下文分层瘦身（A1/A2/A5）前后对比验收
 */
export function reportBudgetTrimAudit(input: {
  generationDiagnostics: DocumentGenerationDiagnostics;
  progressStages: DocumentExecutionStage[];
  chapterDraftsFinal: DocumentDraftChapter[];
  emitProgress: EmitProgressFn;
}): void {
  const { generationDiagnostics, progressStages, chapterDraftsFinal, emitProgress } = input;
  const evidenceStats = generationDiagnostics.evidence;
  const llmStats = generationDiagnostics.llm;
  // 3.3 bge 嵌入全局 LRU 缓存统计：快照并入 diagnostics.semantic，供命中率验收（目标 >50%）
  const embedStats = snapshotEmbedCacheStats();
  generationDiagnostics.semantic = embedStats;
  const embedTotal = embedStats.embedCacheHits + embedStats.embedCacheMisses;
  const embedHitRate = embedTotal > 0 ? Math.round(embedStats.embedCacheHits * 10000 / embedTotal) / 100 : null;
  const cacheTotal = (llmStats.promptCacheHitTokens || 0) + (llmStats.promptCacheMissTokens || 0);
  const cacheHitRate = cacheTotal > 0 ? Math.round((llmStats.promptCacheHitTokens || 0) * 10000 / cacheTotal) / 100 : null;
  // 3.4 上下文分层占比（L0 system 恒定/L1 任务级/L2 章级/L3 小节级）：供 A1/A2/A5 分层瘦身前后对比验收
  const layerStats = llmStats.layerChars;
  const layerTotal = layerStats ? layerStats.l0 + layerStats.l1 + layerStats.l2 + layerStats.l3 : 0;
  const layerPercent = (value: number) => layerTotal > 0 ? Math.round(value * 10000 / layerTotal) / 100 : 0;
  const layerReport = layerStats && layerTotal > 0
    ? `上下文分层：L0 system 恒定 ${layerStats.l0} 字（${layerPercent(layerStats.l0)}%）、L1 任务级 ${layerStats.l1} 字（${layerPercent(layerStats.l1)}%）、L2 章级 ${layerStats.l2} 字（${layerPercent(layerStats.l2)}%）、L3 小节级 ${layerStats.l3} 字（${layerPercent(layerStats.l3)}%）`
    : '上下文分层：本次生成未采集 L0-L3 分层统计';
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'budget-trim-report',
    status: 'success',
    message: `预算裁剪报告：证据 ${evidenceStats.raw} 条 → 采用 ${evidenceStats.used} 条（噪声过滤 ${evidenceStats.filteredNoise} 条、预算兜底裁剪 ${evidenceStats.budgetDropped} 条），证据上下文 ${evidenceStats.contextChars} 字`,
    details: [
      `证据质量：平均噪声分 ${evidenceStats.avgNoiseScore}，平均事实密度 ${evidenceStats.avgFactDensity}`,
      `证据分层（T0 关键事实/T1 高相关片段/T2 目录索引）：T0 注入 ${evidenceStats.t0Chars || 0} 字、T1 注入 ${evidenceStats.t1Chars || 0} 字、T2 索引 ${evidenceStats.t2Lines || 0} 行、目录省略 ${evidenceStats.omittedChars || 0} 字——A2 块级增量压缩后 T1 应显著低于 T0+T2`,
      `检索：${evidenceStats.searchQueries} 组查询，耗时 ${Math.round(evidenceStats.searchMs / 1000)} 秒`,
      `证据双通道覆盖度（P2-B 观测采集）：预分配注入 ${evidenceStats.intentEvidenceInjected ?? 0} 条（最终留存 ${evidenceStats.intentEvidenceUsed ?? 0} 条）／运行时召回注入 ${evidenceStats.retrievedEvidenceInjected ?? 0} 条（最终留存 ${evidenceStats.retrievedEvidenceUsed ?? 0} 条）`,
      `LLM：${llmStats.calls} 次调用，失败 ${llmStats.failures} 次，重试 ${llmStats.retries} 次，schema 校验失败 ${llmStats.schemaFailures} 次`,
      `LLM 上下文输入：${llmStats.inputChars || 0} 字符（system+user）${llmStats.unlayeredChars ? `（其中未分层调用 ${llmStats.unlayeredChars} 字符，占比 ${Math.round((llmStats.unlayeredChars / (llmStats.inputChars || 1)) * 10000) / 100}%）` : ''}，输入 ${llmStats.inputTokens || 0} token / 输出 ${llmStats.outputTokens || 0} token`,
      layerReport,
      cacheHitRate === null
        ? '上下文缓存：提供商未返回 prefix cache 指标（prompt_cache_hit/miss_tokens），无法观测命中率'
        : `上下文缓存：命中 ${llmStats.promptCacheHitTokens} token / 未命中 ${llmStats.promptCacheMissTokens} token（命中率 ${cacheHitRate}%）——未命中占比高说明固定前缀未收敛，system/user 分离（A5）后应显著上升`,
      // 4a 推理 token 观测：生成任务要求关闭思考；reasoningTokens>0 说明 disableThinking 未生效
      // （思考占用与正文共享的输出池 → 空响应/正文截断根因），用于发布后真实生成对账
      `推理 token：${llmStats.reasoningTokens ? `${llmStats.reasoningTokens} token（思考未完全关闭，disableThinking 未生效风险）` : '0（思考已关闭）'}`,
      embedHitRate === null
        ? 'bge 嵌入缓存：本次生成无嵌入调用'
        : `bge 嵌入缓存：命中 ${embedStats.embedCacheHits} 条 / 未命中 ${embedStats.embedCacheMisses} 条（命中率 ${embedHitRate}%，全局 LRU 容量 ${process.env.DOCUMENT_EMBED_CACHE_SIZE || 2000}）`,
      '防爆兜底类软限制（保留并逐项记录裁剪量）：selectEvidenceByBudget 的 maxItems/maxChars、uniqueEvidence 噪声过滤、evidenceBundlePrompt 的 maxChars、块级证据 top-k 截断、块级 facts 截断',
      '语义取舍类软限制（已迁移本地语义模型）：evaluationTexts 词面过滤→条目对象化、criterionFeatures 二字滑窗→bge-small 余弦、章节证据字符硬截→语义排序取 top-k',
      'LLM 输出侧：schema 校验（截断位置可诊断）、空响应重试提示词收敛、块成稿 maxTokens 按目标字数 1:1.2（不走 thinking ×6 放大）',
    ],
  }, { subtitle: '预算裁剪审计' }));
  emitProgress(chapterDraftsFinal);
}

/**
 * h15 修复顺序闭环：表格执行率修复（LLM 补表）位于跨章一致性确定性删除之后，补表 patch
 * 可能整表粘贴既有表格副本（真实生成实测：补表后新增 100% 重复表未被删除）——补表完成后
 * 必须再跑一轮确定性删除（重复表格/重复段落），顺序与跨章一致性阶段一致（后一步输入为前一步删除后的文本）。
 * 触发条件收敛（调用侧判断）：仅在补表 patch 真正落地、或跨章一致性阶段的去重未执行时才运行
 *（正文自上次去重后未变化时，stripDuplicate* 幂等，重跑只会重复一次全文扫描）。
 * 返回更新后的 globalConsistencyIssues（删除后重算删除类检测快照，替换旧条目）。
 */
export async function dedupeAfterTableFix(input: {
  chapterDraftsFinal: DocumentDraftChapter[];
  globalConsistencyIssues: string[];
  progressStages: DocumentExecutionStage[];
  emitProgress: EmitProgressFn;
}): Promise<string[]> {
  const { chapterDraftsFinal, progressStages, emitProgress } = input;
  let globalConsistencyIssues = input.globalConsistencyIssues;
  let postRemovedTableLines = 0;
  let postRemovedParagraphLines = 0;
  for (const chapter of chapterDraftsFinal) {
    const beforeLines = chapter.content.split(/\r?\n/u).length;
    const tableResult = stripDuplicateTables(chapter.content);
    const tableRowDupResult = stripInternalDuplicateTableRows(tableResult.markdown);
    const paraResult = stripDuplicateParagraphs(tableRowDupResult.markdown);
    const totalRemoved = beforeLines - paraResult.markdown.split(/\r?\n/u).length;
    if (totalRemoved > 0) {
      postRemovedTableLines += tableResult.removedCount + tableRowDupResult.removedCount;
      postRemovedParagraphLines += paraResult.removedCount;
      chapter.content = paraResult.markdown;
    }
  }
  if (postRemovedTableLines > 0 || postRemovedParagraphLines > 0) {
    // 删除后重算删除类检测快照：重复表格/重复段落的旧条目必须用最新检测结果替换，
    // 不得合并保留已修复问题的旧快照（与跨章一致性阶段的快照替换原则一致）
    const postDedupMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
    const postDedupDeterministic = [
      ...duplicateTableIssues(postDedupMarkdown),
      ...duplicateParagraphIssues(postDedupMarkdown),
    ].map(issue => `${issue.message}；${issue.suggestion || ''}`);
    globalConsistencyIssues = [...new Set([
      ...globalConsistencyIssues.filter(issue => !/表格重复|段落完全重复/u.test(issue)),
      ...postDedupDeterministic,
    ])];
    const postFixParts = [
      postRemovedTableLines > 0 ? `重复表格 ${postRemovedTableLines} 行` : '',
      postRemovedParagraphLines > 0 ? `重复段落 ${postRemovedParagraphLines} 行` : '',
    ].filter(Boolean).join('、');
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'post-table-dedup', status: 'success', message: `补表后确定性去重：${postFixParts}` }, { subtitle: '表格执行率核验' }));
    emitProgress(chapterDraftsFinal);
  }
  return globalConsistencyIssues;
}

/** 暗标拆表闭环输入（与 repairTableExecutionGaps 共享调用上下文） */
interface DismantleBodyTablesInput {
  chapterDraftsFinal: DocumentDraftChapter[];
  template: DocumentTemplate;
  repairPromptTexts: string;
  requirement?: string;
  signal?: AbortSignal;
  generationDiagnostics: DocumentGenerationDiagnostics;
  progressStages: DocumentExecutionStage[];
  emitProgress: EmitProgressFn;
  withProgressHeartbeat: WithProgressHeartbeatFn;
  bidComposition?: BidCompositionSpec;
}

/**
 * 正文拆表闭环（C1 双口径）：
 * ① 正文禁表（bodyTablePolicy=forbidden，招标显式禁表句）：全量拆表——正文残留表格改写为段落式叙述；
 * ② 允许口径（章级授权，scope 传入）：仅拆「未列入表格授权计划的章」的表格——无计划章出现表格违反
 *    章级授权（写作 LLM 自设表格；授权章 = 有表格计划/静态声明/图类承载指令的章，与终检门禁同源口径）。
 * 与补表闭环同构反演：检测与反向门禁同口径（countMarkdownTables 分隔线行计数），
 * 修复=表格块原文锚点直连改写（extractMarkdownTableTextBlocks 精确摘录，LLM 不复述只输出段落式改写），
 * P12 回滚保护同补表（表数不降反升即回滚保留修复前正文）；残留转终检反向门禁阻断，不自行兜底。
 */
async function dismantleBodyTables(input: DismantleBodyTablesInput, scope?: { plannedChapterKeys: Set<string> }): Promise<{ tableFixApplied: boolean }> {
  const { chapterDraftsFinal, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat, bidComposition } = input;
  const unplannedTargets = (chapter: DocumentDraftChapter) => !scope || !scope.plannedChapterKeys.has(normalizeGeneratedChapterTitle(chapter.title));
  const targets = chapterDraftsFinal
    .filter(unplannedTargets)
    .map(chapter => ({ chapter, tableCount: countMarkdownTables(chapter.content), blocks: extractMarkdownTableTextBlocks(chapter.content) }))
    .filter(item => item.tableCount > 0);
  if (targets.length === 0) return { tableFixApplied: false };
  const repairLabel = scope ? '无计划表格修复' : '正文拆表修复';
  const scopeReason = scope ? '本章未列入系统表格计划（正文表格须来自系统表格计划，不得自设）' : '招标正文禁表（显式禁表句）';
  upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'table-execution-repair', status: 'running', message: `${repairLabel}：${targets.length} 个章节正文残留表格（${scopeReason}）` }, { subtitle: repairLabel }));
  emitProgress(chapterDraftsFinal);
  let appliedCount = 0;
  const failedDetails: string[] = [];
  const repairOne = async (target: (typeof targets)[number]) => {
    const { chapter, tableCount, blocks } = target;
    return withPatchRollback({
      originalContent: chapter.content,
      repairRound: 'table-execution-repair',
      diagnostics: generationDiagnostics,
      beforeMetrics: [tableCount],
      apply: async () => {
        const repaired = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `body-table-dismantle:${chapter.id}`, () => repairChapterByQuality({
          template,
          chapter: { id: chapter.id, title: chapter.title, content: chapter.content, evidence: chapter.evidence || [], missingFacts: chapter.missingFacts || [], sections: chapter.sections },
          issues: [scope ? unplannedBodyTableIssue(tableCount) : bodyTableDismantleIssue(tableCount)],
          promptTexts: repairPromptTexts,
          requirement,
          // 绘图禁令分流：forbidden 拆表（正文禁表口径）保持禁图；允许口径章级拆表按 bodyFigurePolicy
          forbidDrawingImages: scope ? isBodyFigureForbidden(bidComposition) : true,
          bidComposition,
          diagnostics: generationDiagnostics,
          signal,
          patchGuard: repairPatchGuard('table-execution-repair', generationDiagnostics),
          // 锚点直连：系统从正文精确摘录的表格块原文即改写目标；表格块提取为空（畸形表）时走非锚点模式
          anchorTexts: blocks.length > 0 ? blocks : undefined,
          // 表格→段落改写输出量大于建表（每张表按 1600 token 预留）
          maxTokens: Math.min(12000, Math.max(6000, blocks.length * 1600)),
        })));
        return repaired.content && repaired.content !== chapter.content ? repaired.content : chapter.content;
      },
      // 同源复检：章内表格数（与反向门禁 countMarkdownTables 同口径），不降反升即回滚
      recheck: (content) => [countMarkdownTables(content)],
    });
  };
  const results = await Promise.allSettled(targets.map(target => repairOne(target)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      if (signal?.aborted) throw result.reason;
      failedDetails.push(`${targets[index].chapter.title}：拆表修复异常（${result.reason instanceof Error ? result.reason.message : '未知错误'}）`);
      return;
    }
    const repaired = result.value;
    const { chapter } = targets[index];
    if (repaired.rolledBack) {
      failedDetails.push(`${chapter.title}：拆表后表格数不降反升，已回滚本轮修改`);
      return;
    }
    if (repaired.content && repaired.content !== chapter.content) {
      chapter.content = repaired.content;
      appliedCount += 1;
    } else {
      failedDetails.push(`${chapter.title}：拆表 patch 未应用（${generationDiagnostics?.llm.lastError || '无产出'}）`);
    }
  });
  // 收口：残留表格数清零时才 success；残留转终检反向门禁（bid-composition-body-table blocker），不自行兜底
  const residual = chapterDraftsFinal.filter(unplannedTargets).reduce((sum, chapter) => sum + countMarkdownTables(chapter.content), 0);
  upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'table-execution-repair', status: residual > 0 ? 'failed' : 'success', message: residual > 0 ? `${repairLabel}：${appliedCount} 章已改写，${scope ? '未授权章' : '正文'}仍有 ${residual} 处表格残留（终检门禁拦截）` : `${repairLabel}：${appliedCount} 章已改写，${scope ? '未授权章表格清零' : '正文表格清零'}`, details: failedDetails }, { subtitle: repairLabel }));
  emitProgress(chapterDraftsFinal);
  return { tableFixApplied: appliedCount > 0 };
}

/**
 * 表格执行率确定性核验：表格计划（治理决策）必须真实落为 markdown 表格；
 * 执行率显著不足的章节进入定向补表修复闭环（单轮，失败即放弃），保证表格数量与计划一致。
 * 返回 tableFixApplied 供调用侧判断补表后去重是否触发（未落地时正文未变，重复执行去重无意义）。
 * 正文禁表（bodyTablePolicy=forbidden，显式禁表句）：补表闭环反转为全量拆表（正文残留表格改写为段落式叙述）；
 * 允许口径：无计划章自设表格先拆除（C1 章级授权）后，再按计划缺口补表。
 */
export async function repairTableExecutionGaps(input: {
  effectiveChapters: DocumentTemplateChapter[];
  chapterDraftsFinal: DocumentDraftChapter[];
  template: DocumentTemplate;
  repairPromptTexts: string;
  requirement?: string;
  signal?: AbortSignal;
  generationDiagnostics: DocumentGenerationDiagnostics;
  progressStages: DocumentExecutionStage[];
  emitProgress: EmitProgressFn;
  withProgressHeartbeat: WithProgressHeartbeatFn;
  /** 标书编制规格（正文禁表/允许）：forbidden 反转全量拆表；允许口径执行章级授权拆表 */
  bidComposition?: BidCompositionSpec;
}): Promise<{ tableFixApplied: boolean }> {
  const { effectiveChapters, chapterDraftsFinal, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat } = input;
  // 正文禁表（显式禁表句）：不补表，改为全量拆表（表格承载数据改写为段落式连贯叙述）
  if (isBodyTableForbidden(input.bidComposition)) {
    return dismantleBodyTables(input);
  }
  // C1 章级授权：无计划章正文表格先行拆除（写作 LLM 自设表格违反授权制；授权章 = 有表格计划/静态
  // 声明/图类承载指令的章，与终检门禁 bodyCompositionTableIssues 同源口径）；拆表发生在终验兜底
  // 插入（insertRequiredTable）之前，不存在「误拆必需表格」风险
  const plannedChapterKeys = new Set(
    effectiveChapters
      .filter(chapter => (chapter.tablePlans?.length || 0) > 0 || (chapter.tableSections?.length || 0) > 0 || (chapter.diagramRequirements?.length || 0) > 0)
      .map(chapter => normalizeGeneratedChapterTitle(chapter.title)),
  );
  const unplannedDismantle = await dismantleBodyTables(input, { plannedChapterKeys });
  let tableGaps = tablePlanExecutionGaps(effectiveChapters, chapterDraftsFinal);
  // 补表 patch 是否真正落地（供补表后去重的触发判断：未落地时正文未变，重复执行去重无意义）
  let tableFixApplied = unplannedDismantle.tableFixApplied;
  if (tableGaps.length > 0) {
    // 4.17.8 每章单轮修复：补表修复只跑一轮，失败即放弃（残留缺口转导出门禁）——
    // 2 轮循环与首轮失败重试是修复 token 主力军的组成部分（同一章节缺表重复消耗全文上下文）
    for (let round = 0; round < 1 && tableGaps.length > 0; round += 1) {
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'table-execution-repair', status: 'running', message: `表格执行率修复第 ${round + 1} 轮（${tableGaps.length} 个章节缺表）` }, { subtitle: '表格执行率修复' }));
      emitProgress(chapterDraftsFinal);
      let appliedCount = 0;
      const failedGapDetails: string[] = [];
      // P3 耗时优化：表格修复按缺口章节并行（历史 for gap 串行，N 章缺表串行 N×2 次 LLM 调用；
      // 各章 repairChapterByQuality 只改本章 draft.content，落位在全部调用完成后串行按序执行，无并发覆盖风险）
      const gapTargets = tableGaps.flatMap(gap => {
        const draft = chapterDraftsFinal.find(item => item.title === gap.chapterTitle || gap.chapterTitle.includes(item.title) || item.title.includes(gap.chapterTitle));
        return draft ? [{ gap, draft }] : [];
      });
      const repairTableGap = async (target: (typeof gapTargets)[number]) => {
        const { gap, draft } = target;
        // P2c Delta 输入瘦身：补表修复证据按缺口表归属小节定向（归属小节证据 + 无小节归属的章级证据），
        // 避免全章证据（可达数万字）重复注入两轮补表调用；无小节归属的章级证据承载项目图谱数值，必须保留
        const gapSectionTitles = [...new Set(gap.plans.map(plan => plan.section).filter(Boolean))];
        const scopedEvidence = gapSectionTitles.length > 0
          ? draft.evidence.filter(item => {
            const section = item.sectionTitle;
            return !section || gapSectionTitles.some(title => section === title || section.includes(title) || title.includes(section));
          })
          : draft.evidence;
        const baseChapter = { id: draft.id, title: draft.title, content: draft.content, evidence: scopedEvidence.length ? scopedEvidence : draft.evidence, missingFacts: draft.missingFacts || [], sections: draft.sections };
        const baseIssue = `计划表格缺失（本章计划 ${gap.planned} 张，正文实际检出 ${gap.actual} 张）：${gap.plans.map(plan => `${plan.title}（表头：${plan.fields.map(field => field.name).join('、')}）`).join('；')}。必须按表头字段补齐这些 markdown 表格并紧跟相关小节输出，不得删除已有正文；每个表格前须有 1～2 句引导叙述说明表格作用与关键结论，表格不能替代小节正文；表格内项目特有数字、日期、工程量、规格必须来自项目资料或项目图谱，不得编造；人数、台班、进度时间等计划类数值必须原样引用蓝图权威锚点（劳动力峰值、工种构成、分阶段投入、机械台数、总工期节点），不得基于工程量或定额自行推算另设，不得留空、不得写“按需配置”等空话。`;
        // 并行修复共享 diagnostics.llm.lastError，重试提示中的失败原因存在轻微串章竞争（仅影响诊断文案，不影响修复正确性）
        // P12 回滚保护：补表修复后同源复检该章计划表格缺口数（tablePlanExecutionGaps 章级隔离），
        // 缺口不降反升（LLM 乱删既有表格）即回滚保留修复前正文
        return withPatchRollback({
          originalContent: draft.content,
          repairRound: 'table-execution-repair',
          diagnostics: generationDiagnostics,
          beforeMetrics: [gap.plans.length],
          apply: async () => {
            const repaired = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `table-execution-repair:${draft.id}`, () => repairChapterByQuality({
              template,
              chapter: baseChapter,
              issues: [baseIssue],
              promptTexts: repairPromptTexts,
              requirement,
              forbidDrawingImages: true,
              diagnostics: generationDiagnostics,
              signal,
              patchGuard: repairPatchGuard('table-execution-repair', generationDiagnostics),
              // 补表 patch 一次输出多张表（表头+分隔线+数据行+引导句），默认预算下 JSON 易截断
              // 致 patches 解析失败、修复空手（历史缺陷：补表 patch 未应用）；每张表按 1200 token 预留
              maxTokens: Math.min(12000, Math.max(6000, gap.plans.length * 1200)),
            })));
            return repaired.content && repaired.content !== draft.content ? repaired.content : draft.content;
          },
          recheck: (content) => {
            // 章级隔离复检：以修复后章内容替换该章草稿重算计划表格缺口（同源检测，跨章缺口不受并发修复影响）
            const replacedDrafts = chapterDraftsFinal.map(item => item.id === draft.id ? { title: item.title, content, sections: item.sections } : item);
            const nextGaps = tablePlanExecutionGaps(effectiveChapters, replacedDrafts).filter(item => item.chapterTitle === draft.title || item.chapterTitle === gap.chapterTitle || draft.title.includes(item.chapterTitle) || item.chapterTitle.includes(draft.title));
            return [nextGaps.reduce((sum, item) => sum + item.plans.length, 0)];
          },
        });
        // 4.17.8 补表失败重试删除：每章单次尝试（失败即放弃）——重试轮是修复 token 主力军的组成部分
      };
      const repairedTableResults = await Promise.allSettled(gapTargets.map(target => repairTableGap(target)));
      const patchedDraftIds = new Set<string>();
      repairedTableResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          if (signal?.aborted) throw result.reason;
          failedGapDetails.push(`${gapTargets[index].gap.chapterTitle}：修复异常（${result.reason instanceof Error ? result.reason.message : '未知错误'}）`);
          return;
        }
        const repaired = result.value;
        const { gap, draft } = gapTargets[index];
        if (repaired.rolledBack) {
          // 修复后计划表格缺口不降反升（LLM 乱删既有表格），回滚保留修复前正文（回滚计数已入 patchGuardStats）
          failedGapDetails.push(`${gap.chapterTitle}：修复后计划表格缺口增多，已回滚本轮修改`);
          return;
        }
        if (repaired.content && repaired.content !== draft.content && !patchedDraftIds.has(draft.id)) {
          draft.content = repaired.content;
          patchedDraftIds.add(draft.id);
          appliedCount += 1;
        } else if (!patchedDraftIds.has(draft.id)) {
          failedGapDetails.push(`${gap.chapterTitle}：缺 ${gap.plans.map(plan => plan.title).join('、')}（${generationDiagnostics?.llm.lastError || '补表 patch 未应用'}）`);
        }
      });
      if (appliedCount === 0) {
        // 修复未应用任何 patch 时也必须收口 running 态：否则“表格执行率修复”stage 永久停在 running，
        // 前端节点图出现卡死假象（十四度实测：1 个章节缺表但补表 patch 全部落空，stage 停在 running）；
        // 改6：失败原因与缺口表清单落盘到 stage details，便于生成后按章节诊断
        upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'table-execution-repair', status: 'failed', message: `表格执行率修复第 ${round + 1} 轮：补表 patch 未应用（${tableGaps.length} 个章节缺表）`, details: failedGapDetails }, { subtitle: '表格执行率修复' }));
        emitProgress(chapterDraftsFinal);
        break;
      }
      tableFixApplied = true;
      emitProgress(chapterDraftsFinal);
      tableGaps = tablePlanExecutionGaps(effectiveChapters, chapterDraftsFinal);
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'table-execution-repair', status: tableGaps.length > 0 ? 'failed' : 'success', message: tableGaps.length > 0 ? `表格执行率修复第 ${round + 1} 轮完成，仍有 ${tableGaps.length} 个章节缺表` : `表格执行率修复第 ${round + 1} 轮完成` }, { subtitle: '表格执行率修复' }));
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'table-execution-review', status: tableGaps.length > 0 ? 'failed' : 'success', message: tableGaps.length > 0 ? `表格执行率复检：仍有 ${tableGaps.length} 个章节缺表` : '表格执行率复检通过' }, { subtitle: '表格执行率核验' }));
    }
  }
  return { tableFixApplied };
}

/** 治理目标章归属匹配（templatingGovernance 章标题来自成稿 ## 行；三级回退防目标丢失） */
function chapterOwnsTarget(chapter: DocumentDraftChapter, targetTitle: string): boolean {
  if (!targetTitle) return false;
  const heading = /^##\s+(.+?)\s*$/mu.exec(chapter.content)?.[1];
  return targetTitle === chapter.title || targetTitle === heading || chapter.content.includes(targetTitle);
}

/**
 * 模板化修复闭环（套话句重写 + 重难点归因量化补齐）：套话/重难点检测此前只在评分侧消费、从未进入修复链
 * （历史缺陷：十六次同参回归套话句占比恒 ~27.8%、重难点归因+量化双达标 0%，templatingReview 只出建议不进修复）。
 * 与检测器同源定位（fillerSentenceTargets / difficultyCountermeasureReport.entries），命中句/条目原文直接作锚点直连
 * 修复（检测定位 = 修复定位），LLM 只改写不定位。每轮修复后同源复检驱动收敛，最多 2 轮、每轮锚点限幅。
 * 4.28.0 C1/C2：套话检测口径校准（0.80 阈值 + 14 原型，消除恒 ~28% 误报——旧 0.6 阈值下
 * 任何成稿约 28% 管理/质量过程句被误计套话）；零信息纯口号句改走确定性删除（系统级净化，
 * 不经 LLM 改写，历史负效果：LLM 批量改写误报句引入同义新空话）。
 * 修复失败不阻断（阻断权留给确定性门禁，与 templatingReview 设计边界一致）；调用方在修复后按原顺序执行
 * deterministicFix / postNumericFix 数值兜底，套话重写引入的数值破坏被确定性修复修正。
 */
export async function repairTemplatingIssues(input: {
  chapterDraftsFinal: DocumentDraftChapter[];
  template: DocumentTemplate;
  repairPromptTexts: string;
  requirement?: string;
  signal?: AbortSignal;
  generationDiagnostics: DocumentGenerationDiagnostics;
  progressStages: DocumentExecutionStage[];
  emitProgress: EmitProgressFn;
  withProgressHeartbeat: WithProgressHeartbeatFn;
  /** 标书编制规格（正文表格口径：表格计划/禁表/禁图证据）：修复链与写作链同口径 */
  bidComposition?: BidCompositionSpec;
}): Promise<{ templatingFixApplied: boolean }> {
  const { chapterDraftsFinal, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat, bidComposition } = input;
  let templatingFixApplied = false;
  for (let round = 0; round < 2; round += 1) {
    const fullMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
    const filler = await fillerDensityReport(fullMarkdown);
    const difficulty = await difficultyCountermeasureReport(fullMarkdown);
    const needsFillerFix = filler.fillerSentences > 0;
    // C1 检测口径校准（4.28.0，阈值 0.80 + 14 原型）：命中即真套话句，不再用占比阈值作触发闸
    //（历史缺陷：0.6 阈值下任何成稿 ~28% 误报，修复器消费误报句改写真实内容产出同义新空话）
    const needsDifficultyFix = difficulty.countermeasures > 0 && difficulty.ratio < 0.5;
    // WS1/WS3/WS4 治理目标同轮承载（检测口径与终检 templatedLabelIssues/flowFormRepeatIssues/
    // skeletonFingerprintIssues/titleIntegrityIssues 同源）：骨架指纹全文超量、工序表达形式相邻重复、
    // 标题残缺/句化——LLM 锚点直连改写（修复定位 = 检测定位）
    const skeletonTargets = skeletonFingerprintRepairTargets(fullMarkdown);
    const flowTargets = flowFormRepairTargets(fullMarkdown);
    // C4 D3 句模聚类复读目标：同模式句超量（顺序词链/完成即转入/验收衔接/资料闭环式）逐句差异改写
    // （检测端 sentencePatternRepeatIssues 同源判定——历史缺陷：句模复读无修复目标，裸奔直坠终检）
    const patternTargets = sentencePatternRepairTargets(fullMarkdown);
    const titleTargets = titleRepairTargets(fullMarkdown);
    // D-T7 ①：模板化前缀句（「本节/本章将…」元话语导语）修复目标——检测端 formalStyleIssues
    // 同源判定（scanTemplatePrefixSentences 句池 + isTemplatePrefixSentence 词首词表）
    const prefixTargets = templatePrefixTargets(chapterDraftsFinal);
    const needsSkeletonFix = skeletonTargets.length > 0;
    const needsFlowFix = flowTargets.length > 0;
    const needsPatternFix = patternTargets.length > 0;
    const needsTitleFix = titleTargets.length > 0;
    const needsPrefixFix = prefixTargets.length > 0;
    if (!needsFillerFix && !needsDifficultyFix && !needsSkeletonFix && !needsFlowFix && !needsPatternFix && !needsTitleFix && !needsPrefixFix) break;
    // C2 句级定点治理：零信息纯口号句（semantic 通道 + 零信息硬闸）先走确定性删除——
    // 删除是无损净化（不承载可核查信息）且无 LLM 随机性；删除后正文与快照为本轮回滚基线，
    // LLM 修复变差回滚时保留删除成果（删除不参与回滚，F2 判定语义逐字保持）；
    // 剩余命中句（vague 通道 / 含信息或合规承诺句）交 LLM 锚点具体化重写
    const sentenceTargets = needsFillerFix ? await fillerSentenceTargets(chapterDraftsFinal) : [];
    // D-T7 ①：前缀句并入同一删除池——零信息前缀句即删，含信息句进 remaining 交 LLM 去前缀改写
    if (needsPrefixFix) sentenceTargets.push(...prefixTargets);
    const stripped = sentenceTargets.length > 0
      ? stripZeroInfoSloganSentences(chapterDraftsFinal, sentenceTargets)
      : { deletedCount: 0, deletedSentences: [] as string[], remaining: sentenceTargets };
    if (stripped.deletedCount > 0) {
      console.error(`[gen][templating] 零信息句（口号/前缀）确定性删除 ${stripped.deletedCount} 处：${stripped.deletedSentences.slice(0, 3).join(' / ')}${stripped.deletedSentences.length > 3 ? ' 等' : ''}`);
    }
    // F2 回滚保护（P12 泛化）：修复前正文快照 + 同源复检 + 变差即回滚统一收敛到 withPatchRollback——
    // 历史缺陷（丰乐镇第五轮）：修复后套话句占比 27.5%→32.0% 不降反升（LLM 重写产出的新句仍命中语义原型），
    // 带病修复不如不修；判定语义逐字保持：套话占比上升 >1% 且重难点双达标未提升 >1% 才回滚
    const postStripMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
    const roundSnapshot = new Map(chapterDraftsFinal.map(chapter => [chapter.id, chapter.content]));
    // 重难点缺要素条目锚点：归一化（去空白）包含匹配定位到具体章节
    const difficultyTargets = needsDifficultyFix
      ? difficulty.entries.filter(entry => !entry.attributed || !entry.quantified).slice(0, 20)
      : [];
    const difficultyByChapter = difficultyTargets.flatMap(entry => {
      const compactEntry = entry.text.replace(/\s+/gu, '');
      const chapter = chapterDraftsFinal.find(item => item.content.replace(/\s+/gu, '').includes(compactEntry));
      return chapter ? [{ chapter, text: entry.text, missingAttribution: !entry.attributed, missingTarget: !entry.quantified }] : [];
    });
    const targets = chapterDraftsFinal.flatMap(chapter => {
      const kept = stripped.remaining.filter(target => (target.chapterId || target.chapterTitle) === (chapter.id || chapter.title));
      const sentences = kept.filter(target => target.channel !== 'prefix').map(target => target.sentence);
      const prefixSentences = kept.filter(target => target.channel === 'prefix').map(target => target.sentence);
      const difficulty = difficultyByChapter.filter(item => item.chapter.id === chapter.id).map(item => ({ text: item.text, missingAttribution: item.missingAttribution, missingTarget: item.missingTarget }));
      const frames = skeletonTargets.filter(target => chapterOwnsTarget(chapter, target.chapterTitle));
      const flows = flowTargets.filter(target => chapterOwnsTarget(chapter, target.chapterTitle));
      const patterns = patternTargets.filter(target => chapterOwnsTarget(chapter, target.chapterTitle));
      const titles = titleTargets.filter(target => chapterOwnsTarget(chapter, target.chapterTitle));
      return sentences.length > 0 || prefixSentences.length > 0 || difficulty.length > 0 || frames.length > 0 || flows.length > 0 || patterns.length > 0 || titles.length > 0
        ? [{ chapter, sentences, prefixSentences, difficulty, frames, flows, patterns, titles }]
        : [];
    });
    if (targets.length === 0) {
      // C2：零信息口号句已确定性删净且无剩余 LLM 目标 → 删除单独生效并收口（不发起空修复调用）
      if (stripped.deletedCount > 0) {
        templatingFixApplied = true;
        upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'templating-repair', status: 'success', message: `模板化修复第 ${round + 1} 轮：确定性删除零信息句（口号/前缀）${stripped.deletedCount} 处（无剩余重写目标）` }, { subtitle: '模板化修复' }));
        emitProgress(chapterDraftsFinal);
      }
      break;
    }
    const repairDimension = [
      needsFillerFix ? `套话句占比 ${(filler.ratio * 100).toFixed(1)}%${stripped.deletedCount > 0 ? `（已确定性删除零信息句 ${stripped.deletedCount} 处）` : ''}` : '',
      needsPrefixFix ? `模板化前缀句 ${prefixTargets.length} 处` : '',
      needsDifficultyFix ? `重难点双达标 ${(difficulty.ratio * 100).toFixed(0)}%` : '',
      needsSkeletonFix ? `骨架指纹 ${skeletonTargets.length} 组` : '',
      needsFlowFix ? `工序形式 ${flowTargets.length} 处` : '',
      needsPatternFix ? `句模复读 ${patternTargets.length} 处` : '',
      needsTitleFix ? `标题缺陷 ${titleTargets.length} 处` : '',
    ].filter(Boolean).join('、');
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'templating-repair', status: 'running', message: `模板化修复第 ${round + 1} 轮：${repairDimension}（${targets.length} 章）` }, { subtitle: '模板化修复' }));
    emitProgress(chapterDraftsFinal);
    let appliedCount = 0;
    const repairOne = async (target: (typeof targets)[number]) => {
      const parts: string[] = [];
      if (target.sentences.length > 0) {
        parts.push(`第 1～${target.sentences.length} 条目标原文是本章已检出的空话套话句（零信息纯口号句已由系统确定性删除，此处为含信息或合规承诺类命中句）：逐条原地改写为“责任岗位 + 执行动作 + 量化标准 + 检查频次 + 整改时限”式可核查措施，且每条改写句必须嵌入不少于 2 个项目实体（村名/工程量/规格，取自本章证据摘要）；禁止以同义空话替换、禁止改写清单外内容、不得凭空编造数值；属必须保留的合规承诺句须具体化到可核查。`);
      }
      let anchorIndex = target.sentences.length + 1;
      if (target.prefixSentences.length > 0) {
        const indices = target.prefixSentences.map(() => { const current = anchorIndex; anchorIndex += 1; return current; });
        parts.push(`第 ${indices.join('、')} 条目标原文是模板化前缀导语句（句首为“本节/本章将/以下从”式元话语）：删除前缀后直接从作业对象、执行动作、量化措施切入改写，句内工程信息（数值/规格/岗位/频次）必须全部保留；禁止以同义导语替换。`);
      }
      for (const item of target.difficulty) {
        const missingParts = [item.missingAttribution ? '归因句（该难点的成因/风险来源）' : '', item.missingTarget ? '量化控制目标（数值+单位，来自本章证据摘要或行业规范，不得编造）' : ''].filter(Boolean).join('与');
        parts.push(`第 ${anchorIndex} 条目标原文是重难点分析条目，缺少${item.missingAttribution && item.missingTarget ? '成因归因与量化控制目标' : missingParts}：保留条目原有事实与数值，在其内补充${missingParts}。`);
        anchorIndex += 1;
      }
      for (const frame of target.frames) {
        const indices = frame.sentences.map(() => { const current = anchorIndex; anchorIndex += 1; return current; });
        // 4.40 d5e：保留额度按形态动态（基准字形 2 / 变体形态 8）；改写要求「逐句差异化」，不给同义示例（示例即模板化源头）
        parts.push(`第 ${indices.join('、')} 条目标原文含全篇复读骨架「${frame.fingerprintLabel}」（全篇 ${frame.totalCount} 处，验收上限 ${frame.cap} 处）：逐句改写为差异化句式（每条句子的动词与语序不得雷同，禁止集中复用同一替换说法），保留原句全部事实信息（岗位、数值、频次不得丢失）。`);
      }
      for (const flow of target.flows) {
        parts.push(`第 ${anchorIndex} 条目标原文是小节标题，其所在小节「${flow.blockTitle}」的工序顺序表达当前为【${flow.currentForm}】形式且与相邻小节同形式：将该小节的工序顺序表达改写为【${flow.targetForm}】形式，内容与数值保持不变（工艺参数不得删减）。`);
        anchorIndex += 1;
      }
      for (const pattern of target.patterns) {
        const indices = pattern.sentences.map(() => { const current = anchorIndex; anchorIndex += 1; return current; });
        // C4：同模式句复读逐句差异改写——保留额度已由检测端按章序扣除（改写方向不附示例，示例即模板化源头）
        parts.push(`第 ${indices.join('、')} 条目标原文是同一句式模版在全篇复读的句子（该句式全篇 ${pattern.totalCount} 处，全篇保留额度 ${pattern.cap} 处）：逐句改写为自然多样表达（变换句式结构与连接词组织，或拆分为多句；各句改写方向须彼此不同，禁止集中复用同一替换句式），保持原句全部工序顺序、数值与验收事实不变。`);
      }
      for (const title of target.titles) {
        parts.push(`第 ${anchorIndex} 条目标原文是小节标题（${title.reason}）：将该小节标题重命名为完整表达本小节内容的正式名称，正文内容不变；禁止使用“施工概况/施工流程/施工方法”等结构标签词充当标题。`);
        anchorIndex += 1;
      }
      parts.push('清单之外的内容一律不得改动；不得删除任何小节标题、表格与数值参数。');
      return withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `templating-repair:${target.chapter.id}`, () => repairChapterByQuality({
        template,
        chapter: { id: target.chapter.id, title: target.chapter.title, content: target.chapter.content, evidence: target.chapter.evidence || [], missingFacts: target.chapter.missingFacts || [], sections: target.chapter.sections },
        issues: [parts.join('\n')],
        promptTexts: repairPromptTexts,
        requirement,
        forbidDrawingImages: true,
        bidComposition,
        diagnostics: generationDiagnostics,
        signal,
        patchGuard: repairPatchGuard('templating-repair', generationDiagnostics),
        anchorTexts: [...target.sentences, ...target.prefixSentences, ...target.difficulty.map(item => item.text), ...target.frames.flatMap(frame => frame.sentences), ...target.flows.map(flow => flow.blockTitle), ...target.patterns.flatMap(pattern => pattern.sentences), ...target.titles.map(title => title.title)],
        maxTokens: 6000,
        // F2 套话重写需要项目事实支撑：证据预算专用放大（默认 1500 字符最小集不足以支撑
        // 60 条套话句具体化重写，重写后仍是套话的根源之一）
        evidenceChars: 5000,
      })));
    };
    const rollbackOutcome = await withPatchRollback({
      // 回滚基线 = 删除后正文（LLM 修复变差回滚时保留确定性删除成果）
      originalContent: postStripMarkdown,
      repairRound: 'templating-repair',
      diagnostics: generationDiagnostics,
      // 修复前指标 = 循环开头对同一正文的检测值（避免重复同源复检；与 recheck 计算口径同源）；
      // 确定性删除是纯收益不计入回滚判定（占比已先降），LLM 修复把指标推回高于轮初值才判变差；
      // 第 6 位为模板化前缀句全文计数（scanTemplatePrefixSentences，与 recheck 同口径）；
      // 第 7 位为句模复读修复目标数（sentencePatternRepairTargets，C4 同口径）
      beforeMetrics: [filler.ratio, difficulty.ratio, skeletonTargets.length, flowTargets.length, titleTargets.length, scanTemplatePrefixSentences(fullMarkdown).length, patternTargets.length],
      apply: async () => {
        const results = await Promise.allSettled(targets.map(target => repairOne(target)));
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            if (signal?.aborted) throw result.reason;
            console.error('[gen] templating repair failed:', result.reason);
            return;
          }
          const repaired = result.value;
          const { chapter } = targets[index];
          if (repaired.content && repaired.content !== chapter.content) {
            chapter.content = repaired.content;
            appliedCount += 1;
          }
        });
        emitProgress(chapterDraftsFinal);
        return chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
      },
      // 同源复检：修复后全文重算套话句占比 + 重难点双达标率 + 模板化前缀句/句模复读计数
      recheck: async (content) => {
        const recheckFiller = await fillerDensityReport(content);
        const recheckDifficulty = await difficultyCountermeasureReport(content);
        return [recheckFiller.ratio, recheckDifficulty.ratio, skeletonFingerprintRepairTargets(content).length, flowFormRepairTargets(content).length, titleRepairTargets(content).length, scanTemplatePrefixSentences(content).length, sentencePatternRepairTargets(content).length];
      },
      // F2 双指标抵偿 + 治理指标不回退：套话占比上升 >1% 且重难点双达标未提升 >1% → 回滚；
      // 骨架指纹/工序形式/标题缺陷/模板化前缀计数总数上升 → 回滚（改写引入新模板化残留不可接受，前后同口径计数）
      shouldRollback: (before, after) => (after[0] > before[0] + 0.01 && !(after[1] > before[1] + 0.01))
        || after.slice(2).reduce((sum, value) => sum + value, 0) > before.slice(2).reduce((sum, value) => sum + value, 0),
    });
    if (appliedCount === 0 && stripped.deletedCount === 0) {
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'templating-repair', status: 'failed', message: `模板化修复第 ${round + 1} 轮：修复 patch 未落地（${targets.length} 章锚点失配或 LLM 未产出）`, details: [`未收敛维度：${repairDimension}`] }, { subtitle: '模板化修复' }));
      break;
    }
    if (rollbackOutcome.rolledBack) {
      for (const chapter of chapterDraftsFinal) {
        const snapshot = roundSnapshot.get(chapter.id);
        if (snapshot !== undefined) chapter.content = snapshot;
      }
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'templating-repair', status: 'failed', message: `模板化修复第 ${round + 1} 轮：修复后指标变差已回滚本轮修改（套话 ${(rollbackOutcome.beforeMetrics[0] * 100).toFixed(1)}%→${(rollbackOutcome.afterMetrics[0] * 100).toFixed(1)}%，治理缺陷目标 ${rollbackOutcome.beforeMetrics.slice(2).reduce((sum, value) => sum + value, 0)}→${rollbackOutcome.afterMetrics.slice(2).reduce((sum, value) => sum + value, 0)}）`, details: ['LLM 重写未收敛，回滚保留修复前正文'] }, { subtitle: '模板化修复' }));
      emitProgress(chapterDraftsFinal);
      break;
    }
    templatingFixApplied = true;
  }
  // 修复收口：最终复检快照（逐轮复检已由下一轮开头检测承担，此处输出最终收敛值供评分与诊断）；
  // WS1/WS3/WS4 维度同口径复扫（历史缺陷：收口只报套话/重难点，骨架指纹与工序形式/标题残留状态不可见）
  if (templatingFixApplied) {
    const finalMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
    const finalFiller = await fillerDensityReport(finalMarkdown);
    const finalDifficulty = await difficultyCountermeasureReport(finalMarkdown);
    const finalSkeletons = skeletonFingerprintRepairTargets(finalMarkdown);
    const finalFlows = flowFormRepairTargets(finalMarkdown);
    const finalPatterns = sentencePatternRepairTargets(finalMarkdown);
    const finalTitles = titleRepairTargets(finalMarkdown);
    const finalPrefixes = scanTemplatePrefixSentences(finalMarkdown);
    const converged = finalFiller.ratio < 0.1 && (!finalDifficulty.heavyTemplated || finalDifficulty.countermeasures === 0) && finalSkeletons.length === 0 && finalFlows.length === 0 && finalPatterns.length === 0 && finalTitles.length === 0 && finalPrefixes.length === 0;
    const templateResidue = [
      finalSkeletons.length > 0 ? `骨架指纹 ${[...new Set(finalSkeletons.map(item => `${item.fingerprintLabel}×${item.totalCount}`))].join('、')}` : '',
      finalFlows.length > 0 ? `工序形式相邻重复 ${finalFlows.length} 处` : '',
      finalPatterns.length > 0 ? `句模复读 ${[...new Set(finalPatterns.map(item => `${item.patternLabel}×${item.totalCount}`))].join('、')}` : '',
      finalTitles.length > 0 ? `标题缺陷 ${finalTitles.length} 处` : '',
      finalPrefixes.length > 0 ? `模板化前缀句 ${finalPrefixes.length} 处` : '',
    ].filter(Boolean).join('；');
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'templating-repair', status: converged ? 'success' : 'failed', message: `模板化修复完成：套话句占比 ${(finalFiller.ratio * 100).toFixed(1)}%（达标线 ≤10%），重难点归因+量化双达标 ${(finalDifficulty.ratio * 100).toFixed(0)}%（达标线 ≥50%）${templateResidue ? `，模板化残留：${templateResidue}` : ''}`, details: converged ? [] : ['未完全收敛：残留项先由确定性修复链（终检前）收敛；复核未清零的残留经终检检测器判定，仍不达标即列入终检复核清单（不阻断导出，宁缺毋假）'] }, { subtitle: '模板化修复' }));
    emitProgress(chapterDraftsFinal);
  }
  return { templatingFixApplied };
}

/**
 * 工作包骨架确定性收口（稳定版）：关键小节（项目主要施工内容/主要分部分项工程施工方案/主要施工方法）
 * 的内部 #### 标题结构由系统从资料识别的工作包清单锁定，写作后仍有缺失时（历史缺陷：主题块管线块质检
 * 只管标题缺失/重复/越界 + 字数、不查内容要素，重难点表/节点计划表串位可通过块质检 → 终检 blocker →
 * LLM 修复不收敛 → completed_with_issues 复核清单交付（4.50 交付解耦：门禁残留统一转人工复核清单，不影响查看与导出）），修复链做确定性兑底：
 * 1) 表格剥离（零 LLM）：关键小节内的重难点表/节点表等串位表格确定性删除，其他小节合法表格不动；
 * 2) 骨架锚点直连补写：以小节标题行为补写定位锚点，LLM 只输出缺失工作包小节正文（标题一字不差由系统下发）；
 * 最多 2 轮收敛，补写失败不阻断（阻断权留给终检 blocker，与 templating 修复设计边界一致）。
 */
export async function enforceWorkPackageSkeletons(input: {
  chapterDraftsFinal: DocumentDraftChapter[];
  projectContext: string;
  template: DocumentTemplate;
  repairPromptTexts: string;
  requirement?: string;
  signal?: AbortSignal;
  generationDiagnostics: DocumentGenerationDiagnostics;
  progressStages: DocumentExecutionStage[];
  emitProgress: EmitProgressFn;
  withProgressHeartbeat: WithProgressHeartbeatFn;
  /** 标书编制规格（正文表格口径：表格计划/禁表/禁图证据）：修复链与写作链同口径 */
  bidComposition?: BidCompositionSpec;
}): Promise<{ skeletonFixApplied: boolean }> {
  const { chapterDraftsFinal, projectContext, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat, bidComposition } = input;
  // 关键小节标题行形态：容忍标题内空格（十度实测“项目主要施工 内容”）与缺“工程”变体（锚定清单同口径）；
  // H3/H4 双层级（H4 关键小节实测：模板中该小节常为 H4，H3 硬编码会导致修复链完全哑火）
  const KEY_SECTION_HEADING = /^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?(?:项目主要施工\s*内容|主要施工\s*内容|主要分部分项工程施工方案|主要分部分项施工方案|主要施工方法)\s*$/u;
  let skeletonFixApplied = false;
  let strippedCount = 0;
  let filledCount = 0;
  // 阶段 0：关键小节整体缺失确定性补建（稳定版）：planner 可能不规划该小节（轮1/轮2 实测“项目主要施工内容”
  // 整节消失、Final Gate 21 阻断带病交付），骨架清单可用而全文档无该小节标题行时，把「### 项目主要施工内容」
  // 空小节确定性补建到语义宿主章末尾（宿主判定：标题含整体理解/工程概况/项目理解/招标范围/编制边界/现场踏勘/施工界面的章，
  // fallback 第一章），后续锚点直连补写填充工作包正文；小节缺失是终检 blocker 硬伤，必须修复链兜底
  // 稳定版补充：补建小节同步入章 sections 数组并带「章号.序号」编号——目录由 sections 生成、正文节集合
  // 只收集带编号 H3（tocBodyConsistencyIssues 口径），无编号补建小节会导致目录与正文节数守恒校验报错
  // 且评标目录项丢失
  const majorSkeletonNames = workPackageSkeletonTitles(projectContext, chapterDraftsFinal.flatMap(chapter => chapter.evidence || []));
  if (majorSkeletonNames.length > 0) {
    // 章内补建（三期验收回归）：逐章检查「该章规划了关键小节但成稿缺失」——历史实现只做全文级检查，
    // 第一章已有「项目主要施工内容」时第二章缺「主要分部分项工程施工方案」永远检测不到（轮 9 实测）；
    // 补建位置 = 该章末尾（带章号.序号编号，与目录/正文节集合口径一致）
    const KEY_PLANNED_SECTION_RE = /项目主要施工内容|主要施工内容|主要分部分项工程施工方案|主要分部分项施工方案|主要施工方法/u;
    for (const chapter of chapterDraftsFinal) {
      const hasKeyHeading = chapter.content.split('\n').some(line => KEY_SECTION_HEADING.test(line.trim()));
      if (hasKeyHeading) continue;
      const planned = (chapter.sections || []).find(section => KEY_PLANNED_SECTION_RE.test(section));
      if (!planned) continue;
      if (!Array.isArray(chapter.sections)) chapter.sections = [];
      const existingIndex = chapter.sections.findIndex(section => KEY_PLANNED_SECTION_RE.test(section));
      const sectionOrdinal = existingIndex >= 0 ? existingIndex + 1 : chapter.sections.length + 1;
      const heading = `### ${chapterDraftsFinal.indexOf(chapter) + 1}.${sectionOrdinal} ${planned}`;
      chapter.content = `${chapter.content.replace(/\s+$/u, '')}\n\n${heading}\n`;
      skeletonFixApplied = true;
    }
    // 全文兑底（历史路径）：全文无任何关键小节且无章规划它时，补建「### 项目主要施工内容」到语义宿主章
    // （宿主判定补充施工方法类章——轮 9 实测「主要施工方法」章未被旧正则命中导致补建挂错宿主）
    const hasKeyHeadingAnywhere = chapterDraftsFinal.some(chapter => chapter.content.split('\n').some(line => KEY_SECTION_HEADING.test(line.trim())));
    const hasPlannedAnywhere = chapterDraftsFinal.some(chapter => (chapter.sections || []).some(section => KEY_PLANNED_SECTION_RE.test(section)));
    if (!hasKeyHeadingAnywhere && !hasPlannedAnywhere) {
      const host = chapterDraftsFinal.find(chapter => /整体理解|工程概况|项目理解|招标范围|编制边界|现场踏勘|施工界面|主要施工方法|施工方案/u.test(chapter.title)) || chapterDraftsFinal[0];
      if (host) {
        const hostIndex = chapterDraftsFinal.indexOf(host);
        if (!Array.isArray(host.sections)) host.sections = [];
        const existingIndex = host.sections.findIndex(section => /项目主要施工内容|主要施工内容/u.test(section));
        const sectionOrdinal = existingIndex >= 0 ? existingIndex + 1 : (host.sections.push('项目主要施工内容'), host.sections.length);
        const heading = `### ${hostIndex + 1}.${sectionOrdinal} 项目主要施工内容`;
        host.content = `${host.content.replace(/\s+$/u, '')}\n\n${heading}\n`;
        skeletonFixApplied = true;
      }
    }
  }
  // 确定性第一遍（G2 收口）：关键小节表格剥离无条件执行——关键小节禁表格是硬规则，
  // 不依赖骨架清单（丰乐镇第五轮实测：骨架名提取为空时全量清单表穿透交付，制造跨章工程量口径漂移）
  for (const chapter of chapterDraftsFinal) {
    let content = chapter.content;
    for (const headingLine of chapter.content.split('\n').map(line => line.trim()).filter(line => KEY_SECTION_HEADING.test(line))) {
      const sectionTitle = headingLine.replace(/^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?/u, '');
      const stripped = stripTablesInSection(content, sectionTitle, majorSkeletonNames);
      if (stripped !== content) { content = stripped; strippedCount += 1; }
    }
    chapter.content = content;
  }
  // 确定性第二遍：空正文包剥离（依赖骨架清单——无清单时不做空包判定，避免误删正文）
  // 稳定版：空正文工作包（标题存在正文 <80 字）确定性删除——补写判定只看标题缺失（轮3 实测
  // 12 个骨架包中 4 个正文为空漏补），删除后按“标题缺失”口径锚点直连补写，复用现有补写链路；
  // 骨架名与阶段 0/补写轮同源（全卷清单 majorSkeletonNames）——单章 evidence 不含招标范围时
  // 该章关键小节的空包/串位表会漏剥（与补写轮全卷口径漂移）
  for (const chapter of chapterDraftsFinal) {
    const names = majorSkeletonNames;
    if (names.length === 0) continue;
    let content = chapter.content;
    for (const headingLine of chapter.content.split('\n').map(line => line.trim()).filter(line => KEY_SECTION_HEADING.test(line))) {
      const sectionTitle = headingLine.replace(/^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?/u, '');
      // 4.19.11 分部章容器小节（「主要分部分项工程施工方案」在「主要施工方法」章内）豁免工作包骨架
      // 剥离：容器块是全章总述小节（4.19.5 定调），无工作包 H4 骨架；骨架名若命中 LLM 自由发挥的 H4
      // 会整块误剥总述正文（与补写轮同口径豁免，口径与写作层 isDivisionChapterContainer 同源）
      if (DIVISION_SECTION_RE.test(chapter.title) && DIVISION_SECTION_RE.test(sectionTitle)) continue;
      const emptiesStripped = stripEmptyWorkPackageHeadings(content, sectionTitle, names);
      if (emptiesStripped !== content) { content = emptiesStripped; strippedCount += 1; }
    }
    chapter.content = content;
  }
  // 锚点直连补写：缺失骨架工作包标题的章节按小节标题行锚点补写（最多 2 轮收敛，同源复检驱动）
  // 稳定版：骨架名统一用全卷清单 majorSkeletonNames（阶段 0 同源）——历史缺陷：补写轮用单章 evidence 重算
  // 骨架名，宿主章 evidence 不含招标范围条款时阶段 0 补建的小节永远得不到正文填充
  for (let round = 0; round < 2; round += 1) {
    const targets = chapterDraftsFinal.flatMap(chapter => {
      const names = majorSkeletonNames;
      if (names.length === 0) return [];
      const entries = chapter.content.split('\n').map(line => line.trim()).filter(line => KEY_SECTION_HEADING.test(line))
        .flatMap(headingLine => {
          const sectionTitle = headingLine.replace(/^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?/u, '');
          // 4.19.11 分部章容器小节豁免骨架补写（丰乐镇第十二轮实测）：容器块是全章总述小节
          // （4.19.5 规划层不展开骨架、写作层总述提示词「无需四级标题」），补写轮却按关键小节
          // 口径把「绿化工程」等工作包 H4 补进容器块 → 总述小节被工作包骨架污染 + 补写 LLM
          // 重写时截断原总述正文（「工程、小菜园」断裂残片）→ 终稿 2.24.1「绿化工程要点」
          // 标题与总述内容错位。口径与写作层 isDivisionChapterContainer 同源（分部章+容器标题）
          if (DIVISION_SECTION_RE.test(chapter.title) && DIVISION_SECTION_RE.test(sectionTitle)) return [];
          const missing = missingWorkPackageSkeletonTitles(chapter.content, sectionTitle, names);
          return missing.length > 0 ? [{ headingLine, sectionTitle, missing }] : [];
        });
      return entries.length > 0 ? [{ chapter, entries }] : [];
    });
    if (targets.length === 0) break;
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'workpackage-skeleton-repair', status: 'running', message: `工作包骨架补写第 ${round + 1} 轮（${targets.length} 章）` }, { subtitle: '工作包骨架收口' }));
    emitProgress(chapterDraftsFinal);
    const repairOne = async (target: (typeof targets)[number]) => {
      const parts = target.entries.map((entry, index) => {
        const skeleton = entry.missing.map((name, nameIndex) => `#### ${nameIndex + 1} ${name}`).join('\n');
        return `第 ${index + 1} 处：「${entry.headingLine}」小节内部缺少以下工作包小节（内部结构已由系统从资料锁定）：\n${skeleton}\n请在该小节内部按上述标题逐一补齐（标题一字不差，不得增删改、合并或调序），每个工作包小节按三要素展开正式正文：作业对象与工程量（什么部位、什么规模）、工序顺序（先后顺序清晰）、施工方法（工艺做法、工艺参数、验收检测）。已有内容一律不得改动，不得删除任何已有小节与段落，不得输出 Markdown 表格。`;
      });
      // P12 回滚保护：补写后同源复检该章关键小节骨架缺失总数（missingWorkPackageSkeletonTitles 同口径），
      // 缺失不降反升（LLM 乱删已有工作包标题）即回滚保留修复前正文
      return withPatchRollback({
        originalContent: target.chapter.content,
        repairRound: 'workpackage-skeleton-repair',
        diagnostics: generationDiagnostics,
        beforeMetrics: [target.entries.reduce((sum, entry) => sum + entry.missing.length, 0)],
        apply: async () => {
          const repaired = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `workpackage-skeleton-repair:${target.chapter.id}`, () => repairChapterByQuality({
            template,
            chapter: { id: target.chapter.id, title: target.chapter.title, content: target.chapter.content, evidence: target.chapter.evidence || [], missingFacts: target.chapter.missingFacts || [], sections: target.chapter.sections },
            issues: [parts.join('\n'), '清单之外的内容一律不得改动；不得删除任何小节标题、表格与数值参数。'],
            promptTexts: repairPromptTexts,
            requirement,
            forbidDrawingImages: true,
            bidComposition,
            diagnostics: generationDiagnostics,
            signal,
            patchGuard: repairPatchGuard('workpackage-skeleton-repair', generationDiagnostics),
            // 补写定位锚点 = 小节标题行：replacement 必须逐字保留标题行后在节内追加补写小节，系统已锁定补写目标
            anchorTexts: target.entries.map(entry => ({ text: entry.headingLine, append: true })),
            maxTokens: 6000,
          })));
          return repaired.content && repaired.content !== target.chapter.content ? repaired.content : target.chapter.content;
        },
        recheck: (content) => {
          const names = majorSkeletonNames;
          if (names.length === 0) return [0];
          let missing = 0;
          for (const headingLine of content.split('\n').map(line => line.trim()).filter(line => KEY_SECTION_HEADING.test(line))) {
            const sectionTitle = headingLine.replace(/^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?/u, '');
            if (DIVISION_SECTION_RE.test(target.chapter.title) && DIVISION_SECTION_RE.test(sectionTitle)) continue;
            missing += missingWorkPackageSkeletonTitles(content, sectionTitle, names).length;
          }
          return [missing];
        },
      });
    };
    const results = await Promise.allSettled(targets.map(target => repairOne(target)));
    let appliedCount = 0;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        if (signal?.aborted) throw result.reason;
        console.error('[gen] workpackage skeleton repair failed:', result.reason);
        return;
      }
      const repaired = result.value;
      const { chapter } = targets[index];
      if (repaired.rolledBack) {
        // 补写后骨架缺失不降反升（LLM 乱删已有工作包标题），回滚保留修复前正文（回滚计数已入 patchGuardStats）
        console.error('[gen] workpackage skeleton repair rolled back:', chapter.title);
        return;
      }
      if (repaired.content && repaired.content !== chapter.content) {
        chapter.content = repaired.content;
        appliedCount += 1;
        filledCount += 1;
      }
    });
    emitProgress(chapterDraftsFinal);
    if (appliedCount === 0) break;
    skeletonFixApplied = true;
  }
  if (skeletonFixApplied || strippedCount > 0) {
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'workpackage-skeleton-repair', status: 'success', message: `工作包骨架收口完成：表格剥离 ${strippedCount} 处、骨架补写 ${filledCount} 章` }, { subtitle: '工作包骨架收口' }));
    emitProgress(chapterDraftsFinal);
  }
  return { skeletonFixApplied };
}

/**
 * 近名小节确定性合并（r11 丰乐镇门禁 #1 兜底，与写作期 alignSectionHeadingsToPlan 近名轮同源口径）：
 * 写作期模型对规划小节标题单字改写（「分区落位→分区落实」实测）在可比匹配口径下零命中——错字标题
 * 未被对齐回规划名（写作期近名对齐已开，本合并兜底既有产物与评审轮 LLM 重写引入的变体）→ 缺节判定
 * 成立触发补写轮 → 补写版与错字版并存（章内 H3 超规划小节数）直坠 section-count-overflow 硬阻断。
 * 策略：章内近名 H3 对（nearSubsectionTitleMatch 单源，编辑距离近似）确定性合并——保留首现行
 * （恰一侧精确命中规划且非其本身时改名为规划名）、后现行标题行摘除、其正文并入首现块末
 * （零内容生成：只删标题行不删任何正文）。防误配：两行各有自己的精确规划归属（规划本身即近名
 * 小节对）或双无归属且标题为结构标签（泛化无主题，标签治理另有专门修复器）时跳过。
 * 调用点：postReviewSurface 缺节补写（plannedSectionFixFinal）之前——先合并再判定缺节，补写轮不重复补。
 */
/** 标题块边界：自 from 行向下第一个 H2/H3 行（含）或文末（mergeNearDuplicateSectionHeadings 与
 * mergeDuplicateThematicSections 共用） */
function headingBlockEnd(lines: string[], from: number) {
  for (let index = from + 1; index < lines.length; index += 1) {
    if (/^#{2,3}\s/u.test(lines[index].trim())) return index;
  }
  return lines.length;
}
/** 保留原「### 编号 」前缀形态，仅替换标题文本（同上两函数共用） */
function headingPrefixOf(line: string) {
  const base = /^(\s*###\s+)/u.exec(line)?.[1] ?? '### ';
  const numbered = /^((?:\d+(?:\.\d+)*|[一二三四五六七八九十]+)(?:[、.．]|\s+)\s*)/u.exec(line.slice(base.length));
  return numbered ? `${base}${numbered[1]}` : base;
}

export function mergeNearDuplicateSectionHeadings(chapterDraftsFinal: DocumentDraftChapter[]): { mergedCount: number; details: string[] } {
  let mergedCount = 0;
  const details: string[] = [];
  for (const chapter of chapterDraftsFinal) {
    if (!chapter.content?.trim()) continue;
    const planned = (chapter.sections || [])
      .map(section => ({ title: section, normalized: normalizeSubsectionTitleForDedup(section) }))
      .filter(item => item.normalized);
    // guard 循环：每轮合并一对、上限 4 轮（三个以上连环近名对逐轮收敛；正常 1 轮即无剩余近名对）
    for (let guard = 0; guard < 4; guard += 1) {
      const lines = chapter.content.split('\n');
      const h3s: { line: number; title: string; normalized: string }[] = [];
      lines.forEach((line, index) => {
        if (!/^\s*###\s+\S/u.test(line)) return;
        const title = sectionHeadingTitleText(line);
        const normalized = title ? normalizeSubsectionTitleForDedup(title) : '';
        if (normalized) h3s.push({ line: index, title, normalized });
      });
      let pair: { keep: (typeof h3s)[number]; drop: (typeof h3s)[number]; plannedTitle?: string } | undefined;
      for (let i = 0; i < h3s.length && !pair; i += 1) {
        for (let j = i + 1; j < h3s.length && !pair; j += 1) {
          const keep = h3s[i];
          const drop = h3s[j];
          if (keep.normalized === drop.normalized) continue;
          if (!nearSubsectionTitleMatch(keep.normalized, drop.normalized)) continue;
          const keepPlanned = planned.find(item => item.normalized === keep.normalized);
          const dropPlanned = planned.find(item => item.normalized === drop.normalized);
          // 双归属防线：两行各有精确规划归属（规划本身即近名小节对，如「…落位…」与「…落实…」同在
          // 规划列表）——合法结构，不得合并
          if (keepPlanned && dropPlanned) continue;
          // 双无归属的泛化标签不合并：结构标签不代表确定主题，标签治理另有专门修复器
          if (!keepPlanned && !dropPlanned && (isStructuralLabelTitle(keep.title) || isStructuralLabelTitle(drop.title))) continue;
          pair = { keep, drop, plannedTitle: (dropPlanned || keepPlanned)?.title };
          break;
        }
      }
      if (!pair) {
        // D-T6 ② 单行漂移改名（r28f 门禁 #2 归因）：近名变体（「安全责任体系与目标落位→…目标落实」
        // 单字漂移）无配对对象时上方 pair 逻辑零命中（漂移行与规划名精确行从未并存，补写轮因
        // sameSectionTitle 近名容忍也不补）——成稿小节名与规划主题块不一致（目录=正文=主题块
        // 100% 对应的结构对齐判据），且后续 LLM 重写可再引入变体。此处把「未精确覆盖任何规划
        // 小节、且唯一近似某未覆盖规划小节」的漂移行就地改名回规划名（保前缀编号；结构标签与
        // 歧义形态保守跳过），与写作期 alignSectionHeadingsToPlan 近名轮同口径。
        const covered = new Set<string>();
        for (const heading of h3s) {
          for (const item of planned) {
            if (heading.normalized.includes(item.normalized)) covered.add(item.normalized);
          }
        }
        const drifts = h3s.flatMap(heading => {
          if (planned.some(item => heading.normalized.includes(item.normalized))) return [];
          if (isStructuralLabelTitle(heading.title)) return [];
          return planned
            .filter(item => !covered.has(item.normalized) && nearSubsectionTitleMatch(heading.normalized, item.normalized))
            .map(item => ({ heading, plannedTitle: item.title }));
        });
        const drift = drifts.length === 1 ? drifts[0] : undefined;
        if (!drift) break;
        chapter.content = lines
          .map((line, index) => (index === drift.heading.line ? `${headingPrefixOf(line)}${drift.plannedTitle}` : line))
          .join('\n');
        mergedCount += 1;
        details.push(`「${drift.heading.title}」对齐规划名「${drift.plannedTitle}」（第 ${chapterDraftsFinal.indexOf(chapter) + 1} 章）`);
        continue;
      }
      const { keep, drop, plannedTitle } = pair;
      const keepEnd = headingBlockEnd(lines, keep.line);
      const dropEnd = headingBlockEnd(lines, drop.line);
      const keepBody = lines.slice(keep.line + 1, keepEnd);
      while (keepBody.length > 0 && keepBody[keepBody.length - 1].trim() === '') keepBody.pop();
      const dropBody = lines.slice(drop.line + 1, dropEnd);
      while (dropBody.length > 0 && dropBody[dropBody.length - 1].trim() === '') dropBody.pop();
      while (dropBody.length > 0 && dropBody[0].trim() === '') dropBody.shift();
      const mergedBody = dropBody.length > 0 ? [...keepBody, '', ...dropBody, ''] : [...keepBody, ''];
      const nextContent = [
        ...lines.slice(0, keep.line),
        plannedTitle ? `${headingPrefixOf(lines[keep.line])}${plannedTitle}` : lines[keep.line],
        ...mergedBody,
        ...lines.slice(keepEnd, drop.line),
        ...lines.slice(dropEnd),
      ];
      chapter.content = nextContent.join('\n').replace(/\n{3,}/gu, '\n\n');
      mergedCount += 1;
      details.push(`「${drop.title}」并入「${plannedTitle || keep.title}」（第 ${chapterDraftsFinal.indexOf(chapter) + 1} 章）`);
    }
  }
  return { mergedCount, details };
}

/**
 * D-T7 ② 重复主题小节确定性合并（minChapterSectionIssues 检测消费，duplicate-theme-merge 轮）：
 * r28f 实证（第三章「物资分类与采购权限」+「主要材料投入量」、第四章「道路作业机械配置与调度」+
 * 「苗木吊运与栽植机具」同桶）此前检测恒报、修复链零消费——同桶（classifyThematicSectionKey 单源，
 * 与检测端同口径）规划小节 ≥2 项且正文均有 H3 落位时，逐对合并：行序靠前项为保留位（标题漂移
 * 变体改名回规划名，保前缀编号），其后项标题行摘除、正文并入保留块末（零内容生成：只删标题行
 * 不删任何正文与表格），规划数组同步删除已合并项（正文=规划=目录三源一致，缺节/超节判定不因
 * 合并产生新缺口）；章内编号空档由 renumberSectionHeadings 原子重放。正文缺行（未落位）或
 * 定位撞同一行的规划对保守跳过——宁缺毋假，交终检报告。
 */
export function mergeDuplicateThematicSections(chapterDraftsFinal: DocumentDraftChapter[]): { mergedCount: number; details: string[] } {
  let mergedCount = 0;
  const details: string[] = [];
  chapterDraftsFinal.forEach((chapter, chapterIndex) => {
    if (!chapter.content?.trim()) return;
    let changedInChapter = 0;
    // guard 循环：同桶多对逐轮收敛（每轮全章重扫一次分桶与 H3 定位，上限 6 轮）
    for (let guard = 0; guard < 6; guard += 1) {
      const rawSections = chapter.sections || [];
      const indexed = rawSections
        .map((section, index) => ({ section: String(section || '').trim(), index }))
        .filter(item => item.section);
      const themed = new Map<string, Array<{ section: string; index: number }>>();
      for (const item of indexed) {
        const key = classifyThematicSectionKey(item.section);
        if (key) themed.set(key, [...(themed.get(key) || []), item]);
      }
      const bucket = [...themed.values()].find(items => items.length >= 2);
      if (!bucket) break;
      const lines = chapter.content.split('\n');
      const h3s: Array<{ line: number; title: string; normalized: string }> = [];
      lines.forEach((line, index) => {
        if (!/^\s*###\s+\S/u.test(line)) return;
        const title = sectionHeadingTitleText(line);
        const normalized = title ? normalizeSectionTitleForGap(title) : '';
        if (normalized) h3s.push({ line: index, title, normalized });
      });
      const findHeading = (section: string) => {
        const key = normalizeSectionTitleForGap(section);
        return h3s.find(item => item.normalized === key) || h3s.find(item => nearSubsectionTitleMatch(item.normalized, key));
      };
      const located = bucket.flatMap(item => {
        const heading = findHeading(item.section);
        return heading ? [{ section: item.section, index: item.index, heading }] : [];
      });
      const unique = located.filter((item, index) => located.findIndex(other => other.heading.line === item.heading.line) === index);
      // C8 S4-② 数组并发去重（s28m' 机械章实锤）：同桶多条规划条目（本体 + 「（二）（三）…」
      // 后缀拆分）经近名匹配全部命中同一 H3 行时，unique 化后仅剩首条 → 此前直接 break →
      // 数组残留后缀条目、正文=规划=目录三源不一致，duplicate-theme-merge 每轮重报空转。
      // 同组仅保留与 H3 行精确对应的条目（无精确者取行序首条），其余后缀条目从规划数组删除
      //（正文本无对应行，零内容改动）；后续轮次照常消费 unique ≥2 的真重复对。
      const lineCollision = new Map<number, typeof located>();
      for (const item of located) lineCollision.set(item.heading.line, [...(lineCollision.get(item.heading.line) || []), item]);
      const collision = [...lineCollision.values()].find(items => items.length > 1);
      if (collision) {
        const keepItem = collision.find(item => item.heading.normalized === normalizeSectionTitleForGap(item.section)) || collision[0];
        const droppedIndexes = collision.filter(item => item !== keepItem).map(item => item.index);
        chapter.sections = rawSections.filter((_, index) => !droppedIndexes.includes(index));
        mergedCount += 1;
        changedInChapter += 1;
        details.push(`「${collision.filter(item => item !== keepItem).map(item => item.section).join('、')}」与「${keepItem.section}」同节对齐去重（第 ${chapterIndex + 1} 章）`);
        continue;
      }
      if (unique.length < 2) break;
      unique.sort((a, b) => a.heading.line - b.heading.line);
      const keep = unique[0];
      const drop = unique[1];
      const keepEnd = headingBlockEnd(lines, keep.heading.line);
      const dropEnd = headingBlockEnd(lines, drop.heading.line);
      const keepBody = lines.slice(keep.heading.line + 1, keepEnd);
      while (keepBody.length > 0 && keepBody[keepBody.length - 1].trim() === '') keepBody.pop();
      const dropBody = lines.slice(drop.heading.line + 1, dropEnd);
      while (dropBody.length > 0 && dropBody[dropBody.length - 1].trim() === '') dropBody.pop();
      while (dropBody.length > 0 && dropBody[0].trim() === '') dropBody.shift();
      const mergedBody = dropBody.length > 0 ? [...keepBody, '', ...dropBody, ''] : [...keepBody, ''];
      const keepLine = keep.heading.normalized === normalizeSectionTitleForGap(keep.section)
        ? lines[keep.heading.line]
        : `${headingPrefixOf(lines[keep.heading.line])}${keep.section}`;
      chapter.content = [
        ...lines.slice(0, keep.heading.line),
        keepLine,
        ...mergedBody,
        ...lines.slice(keepEnd, drop.heading.line),
        ...lines.slice(dropEnd),
      ].join('\n').replace(/\n{3,}/gu, '\n\n');
      // 规划数组同步删除已合并项（按原索引删除，保持数组顺序）
      chapter.sections = rawSections.filter((_, index) => index !== drop.index);
      mergedCount += 1;
      changedInChapter += 1;
      details.push(`「${drop.section}」并入「${keep.section}」（第 ${chapterIndex + 1} 章）`);
    }
    if (changedInChapter > 0) {
      // 合并不消耗编号：章内 H3 编号空档原子重放（章序=装配层「第N章」=终检口径，三源同值）
      const renumbered = renumberSectionHeadings(chapter.content, { chapterNumber: chapterIndex + 1 });
      chapter.content = renumbered.markdown;
    }
  });
  return { mergedCount, details };
}

/**
 * D-T6 ② 规划外小节确定性收口（section-count-overflow 门禁修复消费，r28f 实测「第 7 章成稿
 * 5 节 vs 规划 4 节」归因）：近名漂移由 mergeNearDuplicateSectionHeadings 改名/合并、无规划
 * 归属空壳由 stripEmptyUnplannedSectionHeadings 清扫，本函数收口第三形态——非近名非空壳的
 * 规划外 H3（LLM 擅加分节穿透到链尾）。判定与 sectionCountOverflowIssues 同源（豁免口径/
 * normalizeSectionTitleForGap 键/overflow 触发条件），处理策略与检测器 suggestion 同口径
 * 「有归属则并入并降 H4」：上方存在规划小节 H3（相邻主题块）时整行降为 H4（剥除 H3 编号，
 * 内容零改动——结构上并入上方主题块）；近名形态（属 merge 辖区，降级会造成缺节 blocker）、
 * 防撞名后缀形态（属 fixCollisionNumberedHeadings 辖区，「（1）」后缀泄漏为 H4 违规）与
 * 章首规划外（无上方规划 H3，无归属可并入）保守跳过。降级后章内编号空档由
 * renumberSectionHeadings 章片段模式原子重放（同 stage5/空节清扫口径）。
 * 调用点：stageSectionAlignmentSweep——位于 merge 之后（近名先行改名/合并，本函数只处理残余）。
 */
export function reconcileUnplannedSectionHeadings(chapterDraftsFinal: DocumentDraftChapter[]): { demotedCount: number; details: string[] } {
  let demotedCount = 0;
  const details: string[] = [];
  chapterDraftsFinal.forEach((chapter, chapterIndex) => {
    if (!chapter.content?.trim()) return;
    const exempt = (section: string) => {
      const trimmed = String(section || '').trim();
      return !trimmed || isStructuralLabelTitle(trimmed) || /^附录/u.test(trimmed)
        || (DIVISION_SECTION_RE.test(chapter.title) && WORK_PACKAGE_SECTION_RE.test(trimmed));
    };
    const plannedSections = (chapter.sections || []).filter(section => !exempt(section));
    if (plannedSections.length === 0) return;
    // 与检测器同域触发：成稿 H3 数未超规划数时没有需要收口的多节（缺节方向由补写轮覆盖）
    const actualSections = extractGeneratedSections(chapter.content).filter(section => !exempt(section));
    if (actualSections.length <= plannedSections.length) return;
    const plannedNormTitles = plannedSections.map(section => normalizeSectionTitleForGap(section));
    const plannedKeys = new Set(plannedNormTitles);
    const lines = chapter.content.split('\n');
    const h3s: { line: number; title: string; normalized: string }[] = [];
    lines.forEach((line, index) => {
      if (!/^\s*###\s+\S/u.test(line)) return;
      const title = sectionHeadingTitleText(line);
      const normalized = title ? normalizeSectionTitleForGap(title) : '';
      if (normalized) h3s.push({ line: index, title, normalized });
    });
    let lastPlannedLine = -1;
    let demotedInChapter = 0;
    for (const item of h3s) {
      if (plannedKeys.has(item.normalized)) {
        lastPlannedLine = item.line;
        continue;
      }
      if (exempt(item.title)) continue;
      // 近名形态属 merge 辖区（降级后规划名仍缺失会造成 missing_planned_section blocker）
      if (plannedNormTitles.some(normalized => nearSubsectionTitleMatch(item.normalized, normalized))) continue;
      // 防撞名后缀形态属 fixCollisionNumberedHeadings 辖区（重命名/合并而非降级）
      if (/(?:（(?:\d+|[一二三四五六七八九十]+)）)+$/u.test(item.title)) continue;
      // 章首规划外（上方无规划 H3）：无归属可并入，保守跳过（交终检报告）
      if (lastPlannedLine < 0) continue;
      lines[item.line] = `#### ${item.title}`;
      demotedInChapter += 1;
      details.push(`第 ${chapterIndex + 1} 章「${item.title}」降为 H4（并入上方规划小节主题块）`);
    }
    if (demotedInChapter === 0) return;
    demotedCount += demotedInChapter;
    // 降级不消耗编号：章内 H3 编号空档原子重放（章序=装配层「第N章」=终检口径，三源同值）
    const renumbered = renumberSectionHeadings(lines.join('\n'), { chapterNumber: chapterIndex + 1 });
    chapter.content = renumbered.markdown;
  });
  return { demotedCount, details };
}

/**
 * D-T3 空节清扫（链尾确定性收口，与 emptyUnplannedSectionSpans 同源定位）：无规划归属的严格空壳
 * H3/H4 标题行整节移除 + 章内编号原子重放。r28f 实证形态：补写轮把原 H4（「特殊技术标准和要求」）
 * 的正文搬往规划名小节后空壳标题行自有残留 → 终检「空小节」blocker 直坠交付（有规划归属的空壳
 * 属补写辖区，由 enforcePlannedSectionCompleteness 覆盖；本清扫器只管无依据空壳——「无依据则移除」）。
 * guard 循环收敛「空壳 H3 内嵌空壳 H4」（删 H4 后 H3 才空，逐轮删至无空壳，上限 4 轮）；删除后
 * 章内编号空档由 renumberSectionHeadings 章片段模式原子重放（与 stage5/装配层同口径，幂等）。
 * 零内容生成：只删标题行不删任何正文与表格。返回删除数与重编号章数供阶段消息。
 */
export function stripEmptyUnplannedSectionHeadings(chapterDraftsFinal: DocumentDraftChapter[]): { removedCount: number; renumberedChapters: number; details: string[] } {
  let removedCount = 0;
  let renumberedChapters = 0;
  const details: string[] = [];
  chapterDraftsFinal.forEach((chapter, index) => {
    if (!chapter.content?.trim()) return;
    let removedInChapter = 0;
    for (let guard = 0; guard < 4; guard += 1) {
      const spans = emptyUnplannedSectionSpans(chapter);
      if (spans.length === 0) break;
      const removeLines = new Set(spans.map(span => span.line));
      chapter.content = chapter.content.split('\n').filter((_, lineIndex) => !removeLines.has(lineIndex)).join('\n').replace(/\n{3,}/gu, '\n\n');
      removedInChapter += spans.length;
      for (const span of spans) details.push(`第 ${index + 1} 章移除空壳标题「${span.rawTitle}」`);
    }
    if (removedInChapter === 0) return;
    removedCount += removedInChapter;
    // 删除 H3 行后「编号被分配又被删除」产生空档：章片段模式原子重放（章序=装配层「第N章」=终检口径，三源同值）
    const renumbered = renumberSectionHeadings(chapter.content, { chapterNumber: index + 1 });
    chapter.content = renumbered.markdown;
    if (renumbered.fixedCount > 0) renumberedChapters += 1;
  });
  return { removedCount, renumberedChapters, details };
}

/**
 * 缺规划小节补写收口（F1）：规划大纲小节（chapter.sections）在成稿中缺失（写作侧小节留空/节级质检拒）时，
 * 章节节点 failed 但达标契约下不再有章级补写循环 → 终稿缺节、评分「缺少规划小节」error 硬扣分。
 * 修复链兜底：以章末标题行为锚点直连补写，系统下发缺节标题（带章号.序号编号）+专属专业任务卡，
 * LLM 只补写该节正式正文（单轮，失败不阻断，阻断权留给终检 blocker）——与工作包骨架收口同口径。
 * 历史缺陷（丰乐镇第五轮）：劳动力安排计划章「资源配置计划」小节留空无修复，终稿缺节 -8 分。
 */
export async function enforcePlannedSectionCompleteness(input: {
  chapterDraftsFinal: DocumentDraftChapter[];
  template: DocumentTemplate;
  repairPromptTexts: string;
  requirement?: string;
  signal?: AbortSignal;
  generationDiagnostics: DocumentGenerationDiagnostics;
  progressStages: DocumentExecutionStage[];
  emitProgress: EmitProgressFn;
  withProgressHeartbeat: WithProgressHeartbeatFn;
  /** 修复轮调用方（postReviewSurface）传入：事件双写落点——finalStages=executionStages 快照(早于修复轮)+本数组，
   * 单写 progressStages 在持久化 executionStages 中不可见；生成期调用不传，行为不变 */
  finalGateRepairStages?: DocumentExecutionStage[];
  /** 标书编制规格（正文表格口径：表格计划/禁表/禁图证据）：修复链与写作链同口径 */
  bidComposition?: BidCompositionSpec;
}): Promise<{ plannedSectionFixApplied: boolean }> {
  const { chapterDraftsFinal, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat, finalGateRepairStages, bidComposition } = input;
  // 缺失判定与写作期/导出期检查器同源（collectSectionContentGaps 全量跑，只取 missing_planned_section 口径），
  // 补写目标 = 检查器会报「缺少规划小节」的小节，不多不少；
  // 丰乐镇第 2 轮实测扩展：规划小节只有标题或表格无正文（planned empty，如扬尘治理六个百分百/环境污染物管控指标
  // 只有表格无正文）同样进补写目标——写作侧留表格、修复链无人补正文段落，终检报「小节只有标题或表格无正文」-8 分/条
  const gaps = collectSectionContentGaps('', chapterDraftsFinal).filter(gap => gap.reason === 'missing_planned_section' || (gap.reason === 'empty' && gap.planned));
  const targets = chapterDraftsFinal.flatMap(chapter => {
    const chapterGaps = gaps.filter(gap => gap.chapterTitle === chapter.title);
    if (chapterGaps.length === 0) return [];
    const sectionTitles = chapterGaps.map(gap => ({ title: gap.sectionTitle, emptyOnly: gap.reason === 'empty' }));
    // 章末标题行作为补写锚点（章末追加模式：锚点仅作存在性校验，补写小节落章末——锚点行后
    // 仍有其正文时在位插入会把标题行切成空壳触发回滚，r28j B8 实测 s28i 第五章）
    const lastHeadingLine = chapter.content.split('\n').map(line => line.trim()).filter(line => /^#{2,4}\s/u.test(line)).pop();
    if (!lastHeadingLine) return [];
    return [{ chapter, sectionTitles, lastHeadingLine }];
  });
  if (targets.length === 0) return { plannedSectionFixApplied: false };
  const plannedSectionRunningStage = displayStage({ type: 'llm_review', roleId: 'planned-section-repair', status: 'running', message: `缺规划小节补写（${targets.length} 章缺失）` }, { subtitle: '缺节补写收口' });
  upsertProgressStage(progressStages, plannedSectionRunningStage);
  // 4.36.2 复查修正：修复轮（postReviewSurface）调用时事件双写，否则复盘不可见
  if (finalGateRepairStages) upsertProgressStage(finalGateRepairStages, plannedSectionRunningStage);
  emitProgress(chapterDraftsFinal);
  const chapterIndexByTitle = new Map(chapterDraftsFinal.map((chapter, index) => [chapter.title, index]));
  /** 空标题行计数（补写回滚守卫）：H2-H4 标题行后（跳过空行）无任何正文或直接接另一标题行即计一个
   * ——r28g B8 归因（r28f 实测）：补写 LLM 把锚点 H4（如「特殊技术标准和要求」）与其正文切开，
   * H4 变空壳直坠终检「空小节」blocker；复检指标不降反升即回滚整个补写 patch。 */
  const emptyHeadingCount = (content: string): number => {
    const lines = content.split('\n');
    let count = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^#{2,4}\s+\S/u.test(lines[index].trim())) continue;
      let next = index + 1;
      while (next < lines.length && lines[next].trim() === '') next += 1;
      if (next >= lines.length || /^#{1,6}\s+\S/u.test(lines[next].trim())) count += 1;
    }
    return count;
  };
  const repairOne = async (target: (typeof targets)[number]) => {
    const chapterIndex = chapterIndexByTitle.get(target.chapter.title) ?? chapterDraftsFinal.indexOf(target.chapter);
    const parts = target.sectionTitles.map(({ title: sectionTitle, emptyOnly }) => {
      // r28g B1/B2 归因（r28f 实测）：补写编号原取规划序位——规划首节在成稿单字漂移（落位/落实）
      // 被判缺失后章末补写编号复用 7.1，与既有同号小节并存（编号重复 + 目录口径对不上）。章末
      // 追加语义下编号取章内现有 H3 最大小节号 +1，无现有 H3 时退回规划序位。
      const existingOrdinals = [...target.chapter.content.matchAll(/^###\s+\d+\.(\d+)\s/gmu)].map(match => Number(match[1]));
      const sectionOrdinal = existingOrdinals.length > 0
        ? Math.max(...existingOrdinals) + 1
        : (((target.chapter.sections || []).findIndex(section => section === sectionTitle) + 1) || ((target.chapter.sections || []).length + 1));
      const heading = `### ${chapterIndex + 1}.${sectionOrdinal} ${sectionTitle}`;
      if (emptyOnly) return `本章小节「${sectionTitle}」只有标题或表格无正式正文：必须在既有小节标题下补写正式正文段落（正文写在表格前后均可），不得新增同名小节标题、不得删除或改动已有表格与数值。\n${professionalSectionTaskCard(target.chapter.title, sectionTitle)}`;
      return `本章正文缺少规划小节「${sectionTitle}」：必须在章末新增小节标题「${heading}」（标题一字不差）并写入正式正文。\n${professionalSectionTaskCard(target.chapter.title, sectionTitle)}`;
    });
    // P12 回滚保护：补写后同源复检该章缺规划小节数（collectSectionContentGaps 同口径）与空标题
    // 行数（emptyHeadingCount 同源），任一指标不降反升（LLM 乱删已有小节/切开锚点标题）即回滚
    // 保留修复前正文
    return withPatchRollback({
      originalContent: target.chapter.content,
      repairRound: 'planned-section-repair',
      diagnostics: generationDiagnostics,
      beforeMetrics: [target.sectionTitles.length, emptyHeadingCount(target.chapter.content)],
      apply: async () => {
        const repaired = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `planned-section-repair:${target.chapter.id}`, () => repairChapterByQuality({
          template,
          chapter: { id: target.chapter.id, title: target.chapter.title, content: target.chapter.content, evidence: target.chapter.evidence || [], missingFacts: target.chapter.missingFacts || [], sections: target.chapter.sections },
          issues: [...parts, '已有内容一律不得改动，不得删除任何已有小节、表格与数值参数；新增小节之外不得改动。'],
          promptTexts: repairPromptTexts,
          requirement,
          forbidDrawingImages: true,
          bidComposition,
          diagnostics: generationDiagnostics,
          signal,
          patchGuard: repairPatchGuard('planned-section-repair', generationDiagnostics),
          // 章末追加锚点 = 章末标题行：锚点仅作存在性校验，replacement 追加到章末，锚点原文原位不动
          // （历史缺陷 r28j B8：锚点行后仍有其正文，原位插入切出空壳标题 → emptyHeadingCount 上升 → P12 回滚误杀）
          anchorTexts: [{ text: target.lastHeadingLine, append: true, appendAt: 'chapter-end' }],
          maxTokens: 6000,
        })));
        return repaired.content && repaired.content !== target.chapter.content ? repaired.content : target.chapter.content;
      },
      recheck: (content) => {
        const chapterGaps = collectSectionContentGaps('', [{ title: target.chapter.title, content, sections: target.chapter.sections }]).filter(gap => gap.chapterTitle === target.chapter.title && (gap.reason === 'missing_planned_section' || (gap.reason === 'empty' && gap.planned)));
        return [chapterGaps.length, emptyHeadingCount(content)];
      },
    });
  };
  const results = await Promise.allSettled(targets.map(target => repairOne(target)));
  let appliedCount = 0;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      if (signal?.aborted) throw result.reason;
      console.error('[gen] planned section repair failed:', result.reason);
      return;
    }
    const repaired = result.value;
    const { chapter } = targets[index];
    if (repaired.rolledBack) {
      // 补写后缺规划小节数不降反升（LLM 乱删已有小节），回滚保留修复前正文（回滚计数已入 patchGuardStats）
      console.error('[gen] planned section repair rolled back:', chapter.title);
      return;
    }
    if (repaired.content && repaired.content !== chapter.content) {
      chapter.content = repaired.content;
      appliedCount += 1;
    }
  });
  // r28g B2 时序兜底（r28f 实测）：近名合并（postReviewSurface 链首）跑在缺节补写之前——补写按
  // 规划名写入后不再复核近名对，成稿写歪节（落实）与补写规划名节（落位）并存直坠
  // section-count-overflow。补写落地后立即跑一次同源近名合并（零内容生成：仅摘重复标题行 +
  // 内容并入首现块），保持章内 H3 与规划小节一一对应。
  const postRepairMerge = appliedCount > 0 ? mergeNearDuplicateSectionHeadings(chapterDraftsFinal) : { mergedCount: 0, details: [] as string[] };
  emitProgress(chapterDraftsFinal);
  const plannedSectionCompletedStage = displayStage({ type: 'llm_review', roleId: 'planned-section-repair', status: appliedCount > 0 ? 'success' : 'failed', message: appliedCount > 0 ? `缺规划小节补写完成：补写 ${appliedCount} 章${postRepairMerge.mergedCount > 0 ? `（近名合并 ${postRepairMerge.mergedCount} 处）` : ''}` : '缺规划小节补写：修复 patch 未落地（锚点失配或 LLM 未产出）' }, { subtitle: '缺节补写收口' });
  upsertProgressStage(progressStages, plannedSectionCompletedStage);
  if (finalGateRepairStages) upsertProgressStage(finalGateRepairStages, plannedSectionCompletedStage);
  return { plannedSectionFixApplied: appliedCount > 0 };
}

/**
 * 全局一致性审查闭环：LLM 全文审查 + 确定性检测同源合并 → 数值定点替换（前置降轮次）→
 * 跨章冲突 LLM 定向修复（单轮按章并行，不留多轮回退路径）→ 确定性定点修复（后置清零）→ 确定性去重。
 * 审查发现的确定性数值冲突先进入定向修复闭环（修复→复检），仍有残留才注入导出校验升级为阻断。
 * 返回 issues（供 finalize 注入导出校验）与 dedupRan（供补表后去重判断：内容未变时 stripDuplicate* 幂等，可安全跳过）。
 */
export async function runGlobalConsistencyReviewLoop(input: {
  globalReviewSamplingRate?: number;
  chapterDraftsFinal: DocumentDraftChapter[];
  template: DocumentTemplate;
  reviewPromptTexts: string;
  repairPromptTexts: string;
  requirement?: string;
  signal?: AbortSignal;
  projectContext: string;
  generationDiagnostics: DocumentGenerationDiagnostics;
  preliminaryFactsModel: DocumentFactsModel;
  scopeConflicts: NumericScopeConflict[];
  progressStages: DocumentExecutionStage[];
  emitProgress: EmitProgressFn;
  withProgressHeartbeat: WithProgressHeartbeatFn;
  /** 一体化蓝图（生成前锁定口径）：节点工期/机械台数权威注入确定性修复 */
  blueprintData?: BlueprintData;
  /** B1 清单事实锁（4.27.0 A1/A2）：参数口径冲突/规格错位裁决的清单锚点（缺失时裁决器恒无锚留 LLM） */
  billFactLock?: BillFactLock;
  /** 标书编制规格（正文表格/图片口径）：跨章一致性修复与内部修复链同口径 */
  bidComposition?: BidCompositionSpec;
}): Promise<{ issues: string[]; dedupRan: boolean }> {
  const { chapterDraftsFinal, template, reviewPromptTexts, repairPromptTexts, requirement, signal, projectContext, generationDiagnostics, preliminaryFactsModel, scopeConflicts, progressStages, emitProgress, withProgressHeartbeat, blueprintData, billFactLock, bidComposition } = input;
  let globalConsistencyIssues: string[] = [];
  // 跨章一致性阶段的确定性去重是否已执行（供补表后去重判断：内容未变时 stripDuplicate* 幂等，可安全跳过）
  let globalDedupRan = false;
  try {
    const samplingRate = input.globalReviewSamplingRate ?? 1;
    const sampledChapters = samplingRate >= 1 || chapterDraftsFinal.length <= 2
      ? chapterDraftsFinal
      : chapterDraftsFinal.filter((_chapter, index) => index % Math.max(2, Math.round(1 / samplingRate)) === 0);
    const sampledCount = sampledChapters.length;
    const runGlobalReview = () => withProgressHeartbeat(() => reviewGlobalConsistency({ template, chapters: sampledChapters, chapterReviews: [], promptTexts: reviewPromptTexts, requirement, projectContext, diagnostics: generationDiagnostics, signal }));
    // v3 阶段 2：统一一致性审查——全局一致性 LLM 审查与数据一致性数值矛盾审查并行合并为单一问题清单。
    // reviewDataConsistency 不再单独跑一轮（历史：初稿完成后另起一轮全文数值审查，再转 blocker 修复），
    // 矛盾清单直接并入统一问题清单冻结（初稿即修复基准，阶段 3 只消费清单不再重审全文）。
    const runUnifiedLlmReview = async (): Promise<{ issues: string[]; stage: Awaited<ReturnType<typeof runGlobalReview>>['stage'] }> => {
      const fullReviewMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
      const [globalResult, dataConflicts] = await Promise.all([
        runGlobalReview(),
        reviewDataConsistency(fullReviewMarkdown, { diagnostics: generationDiagnostics, signal }),
      ]);
      return {
        issues: [...new Set([...globalResult.issues, ...dataConflicts.map(conflict => {
          const issue = dataConsistencyConflictIssue(conflict);
          return `${issue.message}；${issue.suggestion || ''}`;
        })])],
        stage: globalResult.stage,
      };
    };
    // 确定性冲突检测（crossChapterConsistencyIssues / processSpecConflictIssues + documentIntegrityChecks
    // h13/h14/h15 检测家族）：正文出现与资料建设规模/估算价/结构层规格不一致的取值、劳动力/设备数量跨章矛盾、
    // 两可表述、基坑深度未锁定、危大清单不一致、表格/段落重复等问题时，确定性检测比 LLM 审查更精确；
    // 此前只在导出校验阶段暴露、生成流程内无修复机会，用户只能看到“导出门禁未通过”后手动继续生成
    // （历史缺陷，且重跑生成必然复现——LLM 依据同样资料会再次写出同样数值，导致“继续生成”按钮永远失败）。
    // 此处并入修复闭环统一修复，与导出校验同源同阈值（检测定位=修复定位）。
    // F8 残留分类：确定性检测 issue 与 LLM 审查 issue 分开追踪——收口节点只有「确定性可修但残留」才置 failed，
    // LLM 审查类/资料两可类不再制造误导性 error 节点（由交付门禁兑底）
    let deterministicIssues: string[] = [];
    // S5 判定层冲突锚点（blueprintCitationVerdict.anchors，全文坐标）：前置/后置确定性修复共用——
    // 检测时捕获（检测-修复同源快照），正文变更后重跑 verdict 刷新（旧坐标失效不消费）
    let citationAnchors: QuantityConflictAnchor[] = [];
    // S5 判定记录观测：候选/三态计数与逐条结论落盘（判定过程可审计；不改变检测结果）
    const recordCitationAdjudication = (summary: BlueprintCitationAdjudicationSummary) => {
      console.log(`[gen] citation-adjudication: 候选 ${summary.total} 条（冲突 ${summary.conflicts}、未决 ${summary.uncertain}、一致 ${summary.consistent}）${summary.unavailable ? `；判定不可用：${summary.unavailable}` : ''}`);
      upsertProgressStage(progressStages, displayStage({
        type: 'validation',
        roleId: 'citation-adjudication',
        status: summary.conflicts > 0 ? 'failed' : 'success',
        message: `蓝图引用语义判定：候选 ${summary.total} 条（冲突 ${summary.conflicts}、未决 ${summary.uncertain}、一致 ${summary.consistent}）${summary.unavailable ? `；判定不可用：${summary.unavailable}` : ''}`,
        details: summary.records.filter(record => record.conclusion !== 'consistent').slice(0, 20).map(record => `[${record.conclusion}] ${record.subject}：${record.rationale}`),
      }, { subtitle: '蓝图引用判定' }));
      emitProgress(chapterDraftsFinal);
    };
    // V5 P4：蓝图权威索引（AuthorityIndex 全量投影）——检测/前置修复/后置修复共用同一权威源，
    // 替代 blueprintPlanAuthorities 人工映射白名单（蓝图 data 全字段自动入权威，新增设备/清单条目自动获得修复通道）
    const blueprintAuthorityIndex = blueprintData ? buildAuthorityIndex(blueprintData) : undefined;
    const runDeterministicConsistencyCheck = async () => {
      const fullMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
      // S5 蓝图引用语义判定（三态）：error 级冲突进修复链（uncertain/缺口 warning 由判定记录落盘
      // 显式暴露）；工程量冲突锚点捕获供前置/后置确定性修复直连
      const citationVerdict = blueprintData
        ? await blueprintCitationVerdict(fullMarkdown, blueprintData, { diagnostics: generationDiagnostics, signal, onAdjudication: recordCitationAdjudication })
        : undefined;
      if (citationVerdict) citationAnchors = citationVerdict.anchors;
      return [
        ...(await crossChapterConsistencyIssues(fullMarkdown, preliminaryFactsModel, scopeConflicts)).filter(issue => /跨章一致性冲突/u.test(issue.message)),
        ...(await processSpecConflictIssues(fullMarkdown, preliminaryFactsModel)).filter(issue => issue.level === 'error'),
        ...resourceConsistencyIssues(fullMarkdown, { laborPeakAuthority: blueprintLaborPeakAuthority(blueprintData) }),
        ...laborPeakConflictIssues(fullMarkdown),
        // F16 用水高峰人数 vs 劳动力峰值跨字段关联（临时用水人数必须与劳动力峰值同口径）
        ...waterLaborPeakAssociationIssues(fullMarkdown),
        // F17/F18 元话语声明句与公式形态残留（远端客户反馈「公式直接输入正文」根治）
        ...metaDiscourseDeclarationIssues(fullMarkdown),
        ...formulaResidueIssues(fullMarkdown),
        ...nodeScheduleConsistencyIssues(fullMarkdown),
        ...crossSectionNumericConflictIssues(fullMarkdown),
        // V5 P4b 跨工程同值复制：多村/多标段清单条目分组明细（groups）与正文分工程语境比对——
        // 修复器对「值 ∈ 分组值集」精确豁免（分村分表合法量不归一），本检测器接手该豁免放过的
        // 同值复制错误（值恰为其他工程明细值 / 同值出现在多个工程对象语境且明细值不同）
        ...(await crossProjectValueCopyIssues(fullMarkdown, blueprintQuantityGroupAuthorities(blueprintData), { diagnostics: generationDiagnostics, signal })),
        // V5 P4b 阶段人数混用：正文「XX阶段 + N 人」vs byPhase 推导权威（阶段名命中但数值不符）
        ...phaseLaborMixingIssues(fullMarkdown, blueprintPhaseLaborAuthorities(blueprintData)),
        // 批2-1 机械分批求和：句内「首批/剩余补充」分批台数并存但无组合等于权威总数（丰乐镇实测 5+5≠5）
        ...equipmentBatchConflicts(fullMarkdown, blueprintEquipmentAuthorities(blueprintData)),
        // 批2-1 前期动作时限：前期准备动作（交底/考察/封样/编制审批…）时限落在开工后第 N 日且 N≥总工期
        ...preliminaryActionTimingIssues(fullMarkdown, blueprintData?.contract.totalDays),
        // F14 规格错位检测：正文规格 vs 清单权威映射（specAuthorityMap），确定性可判且无权威时静默跳过
        ...specLocationMismatchIssues(fullMarkdown, preliminaryFactsModel.specAuthorityMap),
        ...foundationFormResidueIssues(fullMarkdown),
        ...ambiguousEitherOrIssues(fullMarkdown),
        ...excavationDepthLockIssues(fullMarkdown),
        ...dangerousListConsistencyIssues(fullMarkdown),
        ...basicInfoScheduleFieldIssues(fullMarkdown),
        ...duplicateTableIssues(fullMarkdown),
        ...duplicateTableRowIssues(fullMarkdown),
        ...duplicateParagraphIssues(fullMarkdown),
        ...resourceTriadSectionHierarchyIssues(fullMarkdown),
        ...await supportSystemConflictIssues(fullMarkdown, supportAuthority),
        ...await sixHundredPercentCoverageIssues(fullMarkdown),
        ...overviewRecapIssues(fullMarkdown),
        // 三期收口：蓝图引用一致性质检（权威源=蓝图参数桶）——总工期/关键工程量不一致 error 进修复链，
        // 红线事实缺口 warning 由章级对齐缺口观测兑底（不进入修复轮）
        ...(citationVerdict?.issues.filter(issue => issue.level === 'error') ?? []),
        // G1 关键小节逐专业工程三要素判定（缺哪维报哪维，修复轮定向补写）
        ...perPackageContentElementIssues(fullMarkdown),
        // G2 关键小节清单口径治理（禁表格承载正文 + 禁清单内部口径词）
        ...majorContentGovernanceIssues(fullMarkdown),
      ].map(issue => `${issue.message}；${issue.suggestion || ''}`);
    };
    const globalReview = await runUnifiedLlmReview();
    // B1 支护体系权威（图纸/地质槽位 foundation_support_form）：检测器裁决方向注入 + 确定性修复器裁决依据
    const supportAuthority = extractSupportSystemAuthority(preliminaryFactsModel);
    // 基坑开挖深度权威（canonical 槽位 excavation_depth）：「基坑深度数值未锁定」修复指令的确定性数值来源——
    // 无权威口径时修复器只能从 1.5K 证据摘要自行理解「-5.150 坡底线」类标注，补写 5.15m 无保障
    const excavationDepthAuthority = excavationDepthFromFacts(preliminaryFactsModel);
    // LLM 审查 issue 与确定性检测 issue 分离：确定性部分在每轮复检/定点修复后全量重跑替换，
    // 不得合并保留已修复问题的旧快照（历史缺陷：确定性修复已生效但旧快照残留，
    // 被 finalize 包装为「跨章一致性复核」error 硬阻断导出）
    let llmReviewIssues = globalReview.issues;
    deterministicIssues = await runDeterministicConsistencyCheck();
    globalConsistencyIssues = [...new Set([...llmReviewIssues, ...deterministicIssues])];
    // A2 前置：跨章数值矛盾（劳动力峰值/节点工期/材料设备数量）确定性定点替换先于 LLM 定向修复执行——
    // 检测器已锁定矛盾数值对与权威口径（表格优先），无需 LLM 定位能力（历史缺陷：修复器
    // 无法在正文定位错误数值 → 不产出 patch → 空转轮次，矛盾残留被导出门禁硬阻断）
    let preDeterministicFixCount = 0;
    // S5 判定层锚点章级重定位（全文坐标→章内坐标；逐章替换不跨章不漂移）
    const preCitationAnchorBatches = rebaseCitationAnchorsForChapters(citationAnchors, chapterDraftsFinal.map(chapter => chapter.content));
    for (const [chapterIndex, chapter] of chapterDraftsFinal.entries()) {
      const numericFix = applyNumericConsistencyDeterministicFixes(chapter.content, { authorityIndex: blueprintAuthorityIndex, supportAuthority, quantityAnchors: preCitationAnchorBatches[chapterIndex] });
      if (numericFix.fixedCount > 0) {
        chapter.content = numericFix.markdown;
        preDeterministicFixCount += numericFix.fixedCount;
      }
    }
    // A1/A2 数值裁决器（4.27.0）：参数概念多口径冲突/规格错位以清单事实锁确定性裁决——
    // ①各值分别命中不同清单条目→误报（检测端降级，不替换）；②单锚→锁值硬替换（复检失败整组回滚）；
    // ③无锚→保留 LLM 定向修复。与检测端同源扫描（检测定位=修复定位）；须先于 LLM 定向修复执行
    //（历史缺陷：12 项参数口径冲突 llm-patch 不收敛空转）
    const arbiterResult = await arbitrateNumericConflicts(
      chapterDraftsFinal.map(chapter => chapter.content).join('\n\n'),
      { billFactLock, specAuthorityMap: preliminaryFactsModel.specAuthorityMap, blueprintQuantities: blueprintData?.quantities },
    );
    if (arbiterResult.replacements.length > 0) {
      let chapterOffset = 0;
      for (const chapter of chapterDraftsFinal) {
        const chapterStart = chapterOffset;
        const chapterEnd = chapterStart + chapter.content.length;
        const local = arbiterResult.replacements
          .filter(item => item.start >= chapterStart && item.end <= chapterEnd)
          .map(item => ({ ...item, start: item.start - chapterStart, end: item.end - chapterStart }));
        if (local.length > 0) {
          const applied = applySpanReplacements(chapter.content, local);
          chapter.content = applied.markdown;
          preDeterministicFixCount += applied.fixedCount;
        }
        chapterOffset = chapterEnd + 2;
      }
    }
    // D3 扩面收尾：裁决结论持久化为执行阶段（原仅 console.log——误报降级/无锚保留在交付闭环不可审计，
    // 「每个 blocker 有修复路径或升级路径」要求裁决过程可溯源）；三类明细：确定性替换/误报降级/无锚留 LLM
    if (arbiterResult.details.length > 0 || arbiterResult.falsePositiveGroups.length > 0 || arbiterResult.noAnchorGroups.length > 0) {
      console.log(`[gen] numeric-arbiter: 替换 ${arbiterResult.replacements.length} 处、误报裁决 ${arbiterResult.falsePositiveGroups.length} 组、无锚保留 ${arbiterResult.noAnchorGroups.length} 组`);
      upsertProgressStage(progressStages, displayStage({
        type: 'validation',
        roleId: 'numeric-arbiter',
        status: 'success',
        message: `数值裁决器（清单事实锁/规格权威）：确定性硬替换 ${arbiterResult.replacements.length} 处、误报降级 ${arbiterResult.falsePositiveGroups.length} 组、无锚留 LLM 定向修复 ${arbiterResult.noAnchorGroups.length} 组`,
        details: [
          ...arbiterResult.details.map(item => `确定性替换：${item}`),
          ...arbiterResult.falsePositiveGroups.map(item => `误报裁决（不同清单条目口径并存，不阻断）：${item}`),
          ...arbiterResult.noAnchorGroups.map(item => `无确定性锚点（交 LLM 定向修复，残留由门禁兜底）：${item}`),
        ],
      }, { subtitle: '数值裁决' }));
      emitProgress(chapterDraftsFinal);
    }
    if (preDeterministicFixCount > 0) {
      deterministicIssues = await runDeterministicConsistencyCheck();
      globalConsistencyIssues = [...new Set([...llmReviewIssues, ...deterministicIssues])];
    }
    // 跨章一致性冲突修复闭环：按冲突描述中的正确口径对点名章节做 fact_conflict 定向修复，再复检；
    // 无任何 patch 落地的轮次立即停止，避免空转消耗 LLM 预算
    // P1-1 复检瘦身：确定性复检每轮必做（零 LLM 成本）；LLM 复检仅最后一轮或确定性清零时执行一次，
    // stale 标志标记「跳过 LLM 复检」的轮次，防空转 break 时旧快照残留被 finalize 包装为 error 硬阻断
    let llmReviewStale = false;
    // P12 回滚保护复检：章级确定性检测器子集（与 runDeterministicConsistencyCheck 同源函数引用）——
    // 跨章数值/语义检测需全文上下文无法章级判定，章内缺陷（重复/元话语/公式残留/三要素/清单口径）
    // 修复后不降反升即回滚；跨章残留由轮级确定性复检（runDeterministicConsistencyCheck）兑底
    const chapterDefectCount = (content: string): number[] => {
      const hits = [
        ...metaDiscourseDeclarationIssues(content),
        ...formulaResidueIssues(content),
        ...duplicateTableIssues(content),
        ...duplicateTableRowIssues(content),
        ...duplicateParagraphIssues(content),
        ...perPackageContentElementIssues(content),
        ...majorContentGovernanceIssues(content),
      ];
      return [hits.length];
    };
    // v3 阶段 3：统一修复模式——问题清单冻结后每缺陷只修一次，固定单轮修复（一次修复 + 末尾统一复检一次）；
    // 旧 DOCUMENT_GLOBAL_REVIEW_ROUNDS env 多轮开关已删除（不留回退路径）
    const globalReviewRounds = 1;
    for (let repairRound = 0; repairRound < globalReviewRounds && globalConsistencyIssues.length > 0; repairRound += 1) {
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'global-consistency-repair', status: 'running', message: `跨章一致性冲突第 ${repairRound + 1} 轮定向修复（${globalConsistencyIssues.length} 个冲突）` }, { subtitle: '跨章一致性修复' }));
      emitProgress(chapterDraftsFinal);
      let appliedCount = 0;
      // P3 耗时优化：冲突修复按章并行（历史 for 循环逐章串行，N 章冲突修复串行 N 次 LLM 调用，
      // 全局一致性阶段可放大数倍耗时；各章 repairChapterByQuality 只改本章 content，无共享状态，并行安全）
      const repairChapterTargets = chapterDraftsFinal.flatMap(chapter => {
        // 冲突关联章节：LLM 审查 issue 含章节标题；确定性冲突的 issue 不含章节标题，
        // 用冲突表述中的数值/层级定位（数值或“找平层/防水层”等层级出现在哪个章节正文，哪个章节参与定向修复）
        const normalizedChapterContent = chapter.content.replace(/\s+/gu, '').replace(/平方米|m²|m2/giu, '㎡');
        const related = globalConsistencyIssues.filter(issue => {
          if (issue.includes(chapter.title)) return true;
          // 基坑深度数值未锁定：message 无章节标题/引号原文/数值单位（历史缺陷：四种定位手段全部落空，
          // 修复任务从未派发 → 正文深度永远缺失，残留被导出门禁硬阻断），按语义直接关联基坑/支护类章节
          if (/基坑深度数值未锁定/u.test(issue)) return /基坑|支护|开挖|土方|降水/u.test(chapter.title) || chapter.content.includes('基坑');
          // 冲突数值列表到分号为止（issue 是“message；suggestion”拼接，分号后是修复建议文案，
          // 混入会阻断数值定位）——历史缺陷：建议尾部并入 conflictList 导致建设规模冲突无法关联任何章节，
          // 修复指令从未发出，残留冲突被导出校验硬阻断（用户环境 10970平方米 死循环）
          const conflictList = issue.match(/不一致的表述\s*([^；;。\n]+)/u)?.[1] || '';
          const valueHits = conflictList.split(/[、，,]/u).some(value => {
            const normalized = value.trim().replace(/\s+/gu, '').replace(/平方米|m²|m2/giu, '㎡');
            return normalized.length >= 3 && normalizedChapterContent.includes(normalized);
          });
          if (valueHits) return true;
          const layer = issue.match(/正文([^配比厚度\s]{1,6}?)(?:配比|厚度)/u)?.[1];
          if (layer && chapter.content.includes(layer)) return true;
          // h15 通用定位：issue 引号内文本（≥6 字）或数值+单位出现在本章正文即关联
          //（documentIntegrityChecks 检测族的 message 不含「不一致的表述」前缀，
          // 历史缺陷：劳动力矛盾/设备数量矛盾等无法定位章节，检测空转永不进修复循环）
          const quotedHit = [...issue.matchAll(/“([^”]{6,80})”/gu)].some(match => normalizedChapterContent.includes(match[1].replace(/\s+/gu, '')));
          if (quotedHit) return true;
          // C5 设备台数冲突定位（r28l/s28l 实机死链修复）：质量校验族台数矛盾消息用直角引号包裹
          // 设备名（「高清网络球形摄像机」配置台数出现互相矛盾的取值 8、33），取值为裸数字无单位
          // （「8、33」无台/辆后缀）——上文六手段全落空致修复任务从未派发（摄像机 8/33 对峙连续
          // 两轮零改善实锤，报告协议触发根因专项）。引号内实体词（≥2 字）出现在本章正文即关联，
          // 与 quotedHit 同口径扩引号形态（“”/「」兼容）；「配置台数」语境后缀限定防短词全域误命中
          const equipmentCountHit = issue.match(/[“「]([^”」]{2,24})[”」]\s*配置台数/u)?.[1];
          if (equipmentCountHit && normalizedChapterContent.includes(equipmentCountHit.replace(/\s+/gu, ''))) return true;
          return [...issue.matchAll(/(\d[\d,，.]*)\s*(?:人|台|日|个|次|天|月|套|具|处|项|条)/gu)].some(match => normalizedChapterContent.includes(match[0].replace(/\s+/gu, '')));
        });
        return related.length > 0 ? [{ chapter, related }] : [];
      });
      const repairedChapterResults = await Promise.allSettled(repairChapterTargets.map(({ chapter, related }) => withPatchRollback({
        originalContent: chapter.content,
        repairRound: 'global-consistency-repair',
        diagnostics: generationDiagnostics,
        apply: async () => {
          const repaired = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `global-consistency-repair:${chapter.id}`, () => repairChapterByQuality({
            template,
            chapter: { id: chapter.id, title: chapter.title, content: chapter.content, evidence: chapter.evidence || [], missingFacts: chapter.missingFacts || [], sections: chapter.sections },
            issues: related.map(issue => {
              // 重复类冲突（表格/段落重复）的修复指令是删除冗余而非按资料口径修正数值；
              // 其余冲突严格按资料口径修正（h15：修复指令与冲突类型对齐，避免 LLM 对重复类 issue 乱改数值）
              const repairInstruction = /重复/u.test(issue)
                ? '请删除本冲突描述的重复内容（保留首次出现的完整版本），不得改动其余正文。'
                : /缺少三要素/u.test(issue)
                  ? '请按冲突描述中列出的缺失要素定向补写：只补缺失要素的内容（作业对象与工程量/工序顺序/施工方法），不得删除或改动已有正文；补写的工程量数值必须取工程量清单汇总值，不得编造。'
                  : /清单内部口径词|不应使用 Markdown 表格/u.test(issue)
                    ? '请删除本冲突描述中点名的清单内部口径内容（“分部小计/本页小计/合计/按实/暂估”等口径行或承载专业工程正文的 Markdown 表格），把表格中的项目总量数据改写为段落式连贯叙述（数值保持不变），不得改动其余正文。'
                    : /基坑深度数值未锁定/u.test(issue)
                  ? (excavationDepthAuthority !== undefined
                    ? `请在本章基坑支护/开挖小节写出确定性的基坑开挖深度表述：本工程基坑开挖深度为 ${excavationDepthAuthority}m（权威口径来自图纸标注，严禁写其他深度数值或「按图纸确定」类回避表述），并同步保留既有危大工程分级标注。`
                    : '请从本章证据摘要中的图纸标注/勘察资料锁定基坑开挖深度数值，以确定性表述写入基坑支护小节（严禁「按图纸确定」类回避表述），不得编造数值。')
                  : /规格错位/u.test(issue)
                    ? '请按冲突描述中的工程量清单权威规格修正本章对应部位的规格表述：同一材料不同部位允许不同规格，同一部位只允许权威规格，禁止把多种规格全文归一为一种。'
                    : /出现多个口径/u.test(issue)
                    // r6 K（r5 实机 #8 归因）：参数概念多口径冲突存在两类——有锚（检测侧确定性仲裁已消解，
                    // 不达 LLM）与无锚（多值均无权威，实测死株补植时限 7日/3日 各执一词、bge 组内平票）。
                    // 无锚形态 LLM 无资料口径可依易空转（r5 实测修复轮后仍残留）——给出确定性决胜规则：
                    // 冲突描述按全文出现顺序列出各口径，首现口径锁定为唯一口径，消除自由裁量
                    ? '本冲突无权威资料口径可依：请保留冲突描述中列出的第一个口径（全文首现口径），将本章中该概念其余口径的数值表述统一为与首现口径一致；只改数值表述，不得改动动作词、句式与其余内容，不得引入新的数值。'
                    : /配置台数出现互相矛盾的取值/u.test(issue)
                    // C5 台数矛盾指令特化（r28l/s28l 实机）：台数消息只列出裸数字取值、无资料口径，
                    // 默认指令「按资料口径修正」无依可依（LLM 空转）；与参数多口径同源的确定性决胜
                    // 规则——冲突描述按全文出现顺序列出取值（生成端 scanEquipmentCountClaims 顺序
                    // 收集，首值即正文首现），首现口径锁定为全项目总量口径。分项保守护栏（s28l
                    // 道闸机「共6套其中4套+1套」总数-分项实机）：「其中 N 套」分项与清单独立条目
                    // 台数属合法分层，保留但须注明与总量关系，防把分项改写成总量
                    ? '本冲突无权威资料口径可依：请保留冲突描述中列出的第一个取值（全文首现口径）作为该设备的全项目总量，将本章中该设备台数的其余全项目口径统一为一值；「其中 N 套」类分项序列或清单独立条目台数可保留，但须注明与全项目总量的关系；只改台数表述，不得改动设备名称、动作词与其余内容，不得引入新的数值。'
                    : '请严格按冲突描述中给出的资料口径修正本章对应表述，不得引入新的数值；与资料口径一致的既有表述（含分层/子项数值）不得改动；同一材料多种规格按所属部位/分部分项分别使用，禁止全文统一为一种规格。';
              return `${issue}；${repairInstruction}`;
            }),
            promptTexts: repairPromptTexts,
            requirement,
            forbidDrawingImages: true,
            bidComposition,
            diagnostics: generationDiagnostics,
            signal,
            patchGuard: repairPatchGuard('global-consistency-repair', generationDiagnostics),
          })));
          return repaired.content && repaired.content !== chapter.content ? repaired.content : chapter.content;
        },
        recheck: chapterDefectCount,
      })));
      repairedChapterResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          if (signal?.aborted) throw result.reason;
          console.error('[gen] global consistency repair failed:', result.reason);
          return;
        }
        const repaired = result.value;
        const { chapter } = repairChapterTargets[index];
        if (repaired.rolledBack) {
          // 修复后章内缺陷不降反升，回滚保留修复前正文（回滚计数已入 patchGuardStats）
          console.error('[gen] global consistency repair rolled back:', chapter.title);
          return;
        }
        if (repaired.content && repaired.content !== chapter.content) {
          chapter.content = repaired.content;
          appliedCount += 1;
        }
      });
      if (appliedCount === 0) {
        // 本轮无 patch 落地、正文未变：若上一轮跳过 LLM 复检，需补一次刷新快照，
        // 避免已修复的 LLM issue 旧快照残留被 finalize 包装为「跨章一致性复核」error 硬阻断
        if (llmReviewStale) llmReviewIssues = (await runUnifiedLlmReview()).issues;
        break;
      }
      emitProgress(chapterDraftsFinal);
      // P1-1 复检瘦身：确定性检测每轮必做（零 LLM 成本，驱动下一轮判定）；LLM 复检仅最后一轮
      // 或确定性冲突清零时执行一次——LLM issue 是否已修复无法确定性判定，但无需每轮重复全文大输入调用
      const deterministicRecheck = await runDeterministicConsistencyCheck();
      deterministicIssues = deterministicRecheck;
      // 2.3：末轮判定跟随 env 轮次上限（单轮模式下首轮即末轮，LLM 复检保留一次）
      const finalRound = repairRound === globalReviewRounds - 1;
      if (finalRound || deterministicRecheck.length === 0) {
        llmReviewIssues = (await runUnifiedLlmReview()).issues;
        llmReviewStale = false;
      } else {
        llmReviewStale = true;
      }
      globalConsistencyIssues = [...new Set([...llmReviewIssues, ...deterministicRecheck])];
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'global-consistency-review', status: globalConsistencyIssues.length > 0 ? 'failed' : 'success', message: globalConsistencyIssues.length > 0 ? `跨章一致性复检：仍有 ${globalConsistencyIssues.length} 个冲突` : '跨章一致性复检通过' }, { subtitle: '全局一致性审查' }));
      emitProgress(chapterDraftsFinal);
    }
    // 模板化修复闭环（套话句重写 + 重难点归因量化补齐）：正确性修复链之后、确定性数值修复之前执行——
    // 套话重写可能引入数值破坏，由随后的 deterministicFix/postNumericFix 两道数值兜底按原顺序修正；
    // 套话句锚点来自修复后最新正文，不与正确性修复轮共享快照
    await repairTemplatingIssues({ chapterDraftsFinal, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat, bidComposition });
    // 工作包骨架确定性收口（稳定版）：关键小节内部 #### 结构由系统锁定，写作后仍缺失时确定性兑底——
    // 表格剥离（零 LLM）+ 缺失骨架锚点直连补写（系统下发标题、LLM 只填三要素正文）；
    // 放在模板化修复之后：套话重写不改结构，骨架收口不改套话，两条修复链互不干扰
    await enforceWorkPackageSkeletons({ chapterDraftsFinal, projectContext, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat, bidComposition });
    // LLM 定向修复轮次（默认 1 轮）后仍未消除的数值冲突：按检测同源归属规则确定性定点替换（“检测定位=修复定位”），
    // 不依赖 LLM 定位能力——repairChapterByQuality 约束“无法安全定位的问题不要生成 patch”，数值冲突
    // 修复器常因无法在正文定位错误数值而不产出 patch，残留冲突会被导出门禁硬阻断形成“继续生成”死循环
    const deterministicFix = await applyDeterministicConsistencyFixes(chapterDraftsFinal, preliminaryFactsModel, scopeConflicts);
    // A2 收口：LLM 定向修复轮可能重新引入跨章数值矛盾（劳动力峰值/节点工期/材料设备数量），
    // 导出前与检测器同源定点替换兜底（与修复循环前置的口径一致，形成「前置降轮次 + 后置清零」闭环）
    // 4.17.3：注入计划总工期权威口径（factsModel 锁定值），45 vs 210 类两套体系并存时确定性裁决
    // 4.17.4：追加装配率权威口径（38.4% vs 招标锁定 30%）与工程规模摘要（6.1 一览表套话填充）
    const scheduleAuthority = extractScheduleAuthority(preliminaryFactsModel);
    const assemblyRateAuthority = extractAssemblyRateAuthority(preliminaryFactsModel);
    const scaleSummary = extractProjectScaleSummary(preliminaryFactsModel);
    // B1 蓝图权威（进度节点/机械台数/规格/工程量）统一走 AuthorityIndex 全量投影（V5 P4 单一权威源），
    // 与 factsModel 权威（总工期/装配率）并列注入
    // A3 劳动力峰值跨章权威（丰乐镇实测）：蓝图 peakValue（清单工效推导口径，量级可靠）优先；
    // 蓝图不可用时回退全文表峰值扫描（表缺失时回退高峰表述最大值）。丰乐镇第 3 轮：
    // 蓝图荒谬值已被内部一致性校验（超推导区间）拦截，峰值不再出现正文自编 71 与蓝图 1222 两套口径。
    const blueprintPeak = blueprintLaborPeakAuthority(blueprintData);
    const laborPeakAuthority = (blueprintPeak !== undefined && blueprintPeak > 0)
      ? blueprintPeak
      : tablePeakLaborWithChainFallback(chapterDraftsFinal.map(chapter => chapter.content).join('\n\n'));
    let postNumericFixCount = 0;
    // S5 后置锚点刷新：前置修复/LLM 修复轮/数值裁决器均已改写正文，旧全文坐标失效——重跑判定
    // （同内容候选命中判定缓存，零额外 LLM 成本），按章重定位后注入
    if (blueprintData) {
      const postCitationVerdict = await blueprintCitationVerdict(chapterDraftsFinal.map(chapter => chapter.content).join('\n\n'), blueprintData, { diagnostics: generationDiagnostics, signal, onAdjudication: recordCitationAdjudication });
      citationAnchors = postCitationVerdict.anchors;
    }
    const postCitationAnchorBatches = rebaseCitationAnchorsForChapters(citationAnchors, chapterDraftsFinal.map(chapter => chapter.content));
    for (const [chapterIndex, chapter] of chapterDraftsFinal.entries()) {
      const numericFix = applyNumericConsistencyDeterministicFixes(chapter.content, { authorityIndex: blueprintAuthorityIndex, scheduleAuthority, assemblyRateAuthority, supportAuthority, laborPeakAuthority, quantityAnchors: postCitationAnchorBatches[chapterIndex] });
      if (numericFix.fixedCount > 0) {
        chapter.content = numericFix.markdown;
        postNumericFixCount += numericFix.fixedCount;
      }
    }
    // h15：重复内容确定性删除（重复表格/重复段落），结构冗余删除比 LLM 定位更可靠；
    // 各删除步骤顺序执行且互不重叠（后一步的输入是前一步删除后的文本）
    // B2 绿化养护期权威（与 stage5 链同源）：factsModel 清单/精确事实抽取养护年限，无权威时修复器静默跳过
    const greeningMaintenanceAuthority = extractGreeningMaintenanceAuthority(preliminaryFactsModel);
    let removedTableLines = 0;
    let removedParagraphLines = 0;
    let phraseFixCount = 0;
    let maintenanceFixCount = 0;
    let placeholderFixCount = 0;
    // A4 跨章重复表删除（丰乐镇实测）：同一关键节点表复制粘贴到 4 个章节时逐章去重永不命中，
    // 先全文判定再映射回章节删除（与检测器同源口径），删后不重跑逐章 stripDuplicateTables 的重复表步骤。
    const crossChapterTableDedupe = stripDuplicateTablesAcrossChapters(chapterDraftsFinal);
    removedTableLines += crossChapterTableDedupe.removedCount;
    for (const chapter of chapterDraftsFinal) {
      const beforeLines = chapter.content.split(/\r?\n/u).length;
      const tableResult = stripDuplicateTables(chapter.content);
      const tableRowDupResult = stripInternalDuplicateTableRows(tableResult.markdown);
      const paraResult = stripDuplicateParagraphs(tableRowDupResult.markdown);
      // 4.17.4 确定性清洗链：句内重复短语折叠 → 6.1 一览表套话数据填充
      const phraseResult = fixAdjacentPhraseDuplication(paraResult.markdown);
      const placeholderResult = fixPlaceholderTableCells(phraseResult.markdown, { areaSummary: scaleSummary, scheduleDays: scheduleAuthority });
      const maintenanceResult = fixGreeningMaintenanceMismatch(placeholderResult.markdown, greeningMaintenanceAuthority);
      const finalLines = maintenanceResult.markdown.split(/\r?\n/u).length;
      const totalRemoved = beforeLines - finalLines;
      const extraFixes = (phraseResult.fixedCount - 0) + placeholderResult.fixedCount + maintenanceResult.fixedCount;
      phraseFixCount += phraseResult.fixedCount;
      placeholderFixCount += placeholderResult.fixedCount;
      maintenanceFixCount += maintenanceResult.fixedCount;
      if (totalRemoved > 0 || extraFixes > 0) {
        removedTableLines += tableResult.removedCount + tableRowDupResult.removedCount;
        removedParagraphLines += paraResult.removedCount;
        chapter.content = maintenanceResult.markdown;
      }
    }
    // A6 自伤表述确定性改写（丰乐镇 79 分基线对照）：LLM 修复轮定位能力不足，按检测器同源口径
    // 确定性改写（只改形态不改语义），逐章执行与检测器全文判定同源，修复后由导出门禁复检自然清零
    let selfUnderminingFixCount = 0;
    let internalTermFixCount = 0;
    let headerlessTableFixCount = 0;
    let ambiguousEitherOrFixCount = 0;
    let forbiddenConfigFixCount = 0;
    for (const chapter of chapterDraftsFinal) {
      const selfUnderminingFix = fixSelfUnderminingCandidates(chapter.content);
      if (selfUnderminingFix.fixedCount > 0) {
        chapter.content = selfUnderminingFix.markdown;
        selfUnderminingFixCount += selfUnderminingFix.fixedCount;
      }
      // A11 内部术语清洗（「控制口径/峰值口径/工作包」后台术语进正文）
      const internalTermFix = fixInternalTerminology(chapter.content);
      if (internalTermFix.fixedCount > 0) {
        chapter.content = internalTermFix.markdown;
        internalTermFixCount += internalTermFix.fixedCount;
      }
      // A13 无表头表格补齐表头（分隔线前无表头行时补「项目|内容」表头，后续由跨章重复表删除器统一处理）
      const headerlessTableFix = fixHeaderlessTables(chapter.content);
      if (headerlessTableFix.fixedCount > 0) {
        chapter.content = headerlessTableFix.markdown;
        headerlessTableFixCount += headerlessTableFix.fixedCount;
      }
      // A16 关键设计决策两可表述归一（钢板桩或型钢/放坡或钢板桩等并列悬置形态，按正文主流口径收敛）
      const ambiguousEitherOrFix = fixAmbiguousEitherOrCandidates(chapter.content);
      if (ambiguousEitherOrFix.fixedCount > 0) {
        chapter.content = ambiguousEitherOrFix.markdown;
        ambiguousEitherOrFixCount += ambiguousEitherOrFix.fixedCount;
      }
      // A22 配置要求不得出现类污染清洗（公共资源交易监督管理等招标人角色行为误入投标正文）
      const forbiddenConfigFix = fixForbiddenConfigurationTerms(chapter.content);
      if (forbiddenConfigFix.fixedCount > 0) {
        chapter.content = forbiddenConfigFix.markdown;
        forbiddenConfigFixCount += forbiddenConfigFix.fixedCount;
      }
    }
    globalDedupRan = true;
    if (deterministicFix.fixedCount > 0 || postNumericFixCount > 0 || removedTableLines > 0 || removedParagraphLines > 0 || phraseFixCount > 0 || placeholderFixCount > 0 || selfUnderminingFixCount > 0 || internalTermFixCount > 0 || headerlessTableFixCount > 0 || ambiguousEitherOrFixCount > 0 || forbiddenConfigFixCount > 0 || maintenanceFixCount > 0) {
      // 修复后重算：确定性检测快照必须用最新检测结果替换，不得合并保留已修复问题的旧快照
      //（历史缺陷：修复已生效但旧快照残留，被 finalize 包装为「跨章一致性复核」error 硬阻断导出）
      deterministicIssues = await runDeterministicConsistencyCheck();
      globalConsistencyIssues = [...new Set([...llmReviewIssues, ...deterministicIssues])];
      const fixParts = [
        deterministicFix.fixedCount > 0 ? `数值 ${deterministicFix.fixedCount} 处` : '',
        postNumericFixCount > 0 ? `跨章数值 ${postNumericFixCount} 处` : '',
        removedTableLines > 0 ? `重复表格 ${removedTableLines} 行` : '',
        removedParagraphLines > 0 ? `重复段落 ${removedParagraphLines} 行` : '',
        selfUnderminingFixCount > 0 ? `自伤表述改写 ${selfUnderminingFixCount} 处` : '',
        internalTermFixCount > 0 ? `内部术语清洗 ${internalTermFixCount} 处` : '',
        headerlessTableFixCount > 0 ? `无表头表格补齐 ${headerlessTableFixCount} 处` : '',
        ambiguousEitherOrFixCount > 0 ? `两可表述归一 ${ambiguousEitherOrFixCount} 处` : '',
        forbiddenConfigFixCount > 0 ? `配置污染清洗 ${forbiddenConfigFixCount} 处` : '',
        maintenanceFixCount > 0 ? `绿化养护期统一 ${maintenanceFixCount} 处` : '',
      ].filter(Boolean).join('、');
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'global-consistency-deterministic-fix', status: 'success', message: `跨章一致性定点修复：${fixParts}${deterministicFix.details.slice(0, 4).length > 0 ? `（${deterministicFix.details.slice(0, 4).join('、')}）` : ''}`, details: deterministicFix.details.slice(4) }, { subtitle: '跨章一致性修复' }));
      emitProgress(chapterDraftsFinal);
    }
    // B1：跨章一致性修复 running stage 收口——修复循环结束后必须置终态，
    // 历史缺陷：repair 与 review 两个 roleId 并存且 repair 永不置终态，「跨章一致性修复」节点前端永久 running
    // F8 残留冲突分类收口：只有「确定性可修但修复后仍残留」才置 failed；LLM 审查类（非确定性判定）与
    // 资料两可类（检测器报出但修复器无权威依据，如资料本身「土钉或锚杆」两可选型）置 success+warning 说明，
    // 由交付门禁兑底——不再因不可修问题制造误导性 error 节点（轮8 实锤：残留 3 冲突全部属此类）
    const blockingResidue = deterministicIssues.filter(issue => !AMBIGUOUS_RESIDUE_RE.test(issue));
    const benignResidue = [...llmReviewIssues, ...deterministicIssues.filter(issue => AMBIGUOUS_RESIDUE_RE.test(issue))];
    const residueStatus = blockingResidue.length > 0 ? 'failed' : 'success';
    const residueMessage = blockingResidue.length > 0
      ? `跨章一致性修复完成：仍残留 ${blockingResidue.length} 个可修复冲突（已记录，由交付门禁兑底）`
      : benignResidue.length > 0
        ? `跨章一致性修复完成：确定性冲突已全部消除；另有 ${benignResidue.length} 个审查提示/资料两可项（已记录，由交付门禁复核）`
        : '跨章一致性修复完成：冲突已全部消除';
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'global-consistency-repair', status: residueStatus, message: residueMessage }, { subtitle: '跨章一致性修复' }));
    emitProgress(chapterDraftsFinal);
    const sampledStage = sampledCount < chapterDraftsFinal.length ? { ...globalReview.stage, message: `${globalReview.stage.message || '全局一致性审查完成'}（抽检 ${sampledCount}/${chapterDraftsFinal.length} 章）` } : globalReview.stage;
    upsertProgressStage(progressStages, sampledStage);
    emitProgress(chapterDraftsFinal);
  } catch (err) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error('[gen] global consistency review failed:', err);
    // 降级治理：原实现只 console.error 后**返回初值**（部分结果当成功）——用户看到的是
    // 「跨章一致性已审」而实际整链（审查 + 定向修复 + 确定性去重）从未执行。
    // 该环节崩溃是「不检测」而非「未通过」，必须显性上屏并把异常并入交付告警。
    const failureStage = displayStage({
      type: 'llm_review',
      roleId: 'global-consistency-repair',
      status: 'failed',
      message: `跨章一致性审查异常中断：本环节**未执行**（${message}）`,
      details: [
        '后果：跨章数值冲突的 LLM 复查与定向修复、跨章表格/段落确定性去重均不会执行。',
        '终门禁会重算确定性冲突，但仍可能有冲突未经复查直接进入交付；请人工复核跨章一致性问题。',
      ],
    }, { subtitle: '跨章一致性审查' });
    upsertProgressStage(progressStages, failureStage);
    emitProgress(chapterDraftsFinal);
  }
  return { issues: globalConsistencyIssues, dedupRan: globalDedupRan };
}
