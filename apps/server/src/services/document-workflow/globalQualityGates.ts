/**
 * 全局质量收口块（从 documentGenerator.generateDocumentDraft 提取）：
 * 章节循环之后的全局收口阶段——全局一致性审查、表格执行率修复、补表后去重、预算裁剪报告。
 * 提取原则：行为保持，函数参数即原闭包捕获变量，返回值即原块对后续流程的产出。
 */
import type { DocumentDraftChapter, DocumentExecutionStage, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, NumericScopeConflict } from './types';
import { displayStage, upsertProgressStage } from './progress';
import { buildSemanticSimilarity, snapshotEmbedCacheStats } from './semanticSimilarity';
import { ambiguousEitherOrIssues, applyNumericConsistencyDeterministicFixes, basicInfoScheduleFieldIssues, crossChapterSemanticDuplicateIssues, crossSectionNumericConflictIssues, dangerousListConsistencyIssues, duplicateParagraphIssues, duplicateTableIssues, excavationDepthLockIssues, extractAssemblyRateAuthority, extractProjectScaleSummary, extractScheduleAuthority, fixAdjacentPhraseDuplication, fixPlaceholderTableCells, fixQualityAssuranceCoverage, foundationFormResidueIssues, nodeScheduleConsistencyIssues, overviewRecapCandidates, overviewRecapIssues, resourceConsistencyIssues, resourceTriadSectionHierarchyIssues, sixHundredPercentCoverageIssues, stripCrossChapterSemanticDuplicateParagraphs, stripDuplicateParagraphs, stripDuplicateTables, stripOverviewRecapBodyLines, supportSystemConflictIssues } from './documentIntegrityChecks';
import { applyDeterministicConsistencyFixes, crossChapterConsistencyIssues, processSpecConflictIssues } from './qualityValidation';
import { reviewGlobalConsistency } from './chapterReview';
import { tablePlanExecutionGaps } from './constructionOrgTablePlan';
import { measureGenerationStep, repairChapterByQuality } from './rolePipeline';

export type EmitProgressFn = (checkpointChapters?: DocumentDraftChapter[], stages?: DocumentExecutionStage[]) => void;
export type WithProgressHeartbeatFn = <T>(work: () => Promise<T>) => Promise<T>;

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
 * 必须再跑一轮确定性删除（表格/段落/概况复述），顺序与跨章一致性阶段一致（后一步输入为前一步删除后的文本）。
 * 触发条件收敛（调用侧判断）：仅在补表 patch 真正落地、或跨章一致性阶段的去重未执行时才运行
 *（正文自上次去重后未变化时，stripDuplicate* 幂等，重跑只会重复一次全文扫描与语义嵌入构建）。
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
  const postTableFixMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
  const postTableFixRecapCandidates = overviewRecapCandidates(postTableFixMarkdown);
  const postTableFixRecapSimilarity = await buildSemanticSimilarity(postTableFixRecapCandidates.sentences, postTableFixRecapCandidates.overviewBody ? [postTableFixRecapCandidates.overviewBody] : []);
  let postRemovedTableLines = 0;
  let postRemovedParagraphLines = 0;
  let postRemovedRecapLines = 0;
  for (const chapter of chapterDraftsFinal) {
    const beforeLines = chapter.content.split(/\r?\n/u).length;
    const tableResult = stripDuplicateTables(chapter.content);
    const paraResult = stripDuplicateParagraphs(tableResult.markdown);
    const recapResult = stripOverviewRecapBodyLines(paraResult.markdown, postTableFixRecapSimilarity);
    const totalRemoved = beforeLines - recapResult.split(/\r?\n/u).length;
    if (totalRemoved > 0) {
      postRemovedTableLines += tableResult.removedCount;
      postRemovedParagraphLines += paraResult.removedCount;
      postRemovedRecapLines += totalRemoved - tableResult.removedCount - paraResult.removedCount;
      chapter.content = recapResult;
    }
  }
  if (postRemovedTableLines > 0 || postRemovedParagraphLines > 0 || postRemovedRecapLines > 0) {
    // 删除后重算删除类检测快照：重复表格/重复段落/概况复述的旧条目必须用最新检测结果替换，
    // 不得合并保留已修复问题的旧快照（与跨章一致性阶段的快照替换原则一致）
    const postDedupMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
    const postDedupDeterministic = [
      ...duplicateTableIssues(postDedupMarkdown),
      ...duplicateParagraphIssues(postDedupMarkdown),
      ...overviewRecapIssues(postDedupMarkdown, { semanticSimilarity: postTableFixRecapSimilarity }),
    ].map(issue => `${issue.message}；${issue.suggestion || ''}`);
    globalConsistencyIssues = [...new Set([
      ...globalConsistencyIssues.filter(issue => !/表格重复|段落完全重复|概况复述/u.test(issue)),
      ...postDedupDeterministic,
    ])];
    const postFixParts = [
      postRemovedTableLines > 0 ? `重复表格 ${postRemovedTableLines} 行` : '',
      postRemovedParagraphLines > 0 ? `重复段落 ${postRemovedParagraphLines} 行` : '',
      postRemovedRecapLines > 0 ? `概况复述句 ${postRemovedRecapLines} 行` : '',
    ].filter(Boolean).join('、');
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'post-table-dedup', status: 'success', message: `补表后确定性去重：${postFixParts}` }, { subtitle: '表格执行率核验' }));
    emitProgress(chapterDraftsFinal);
  }
  return globalConsistencyIssues;
}

/**
 * 表格执行率确定性核验：表格计划（治理决策）必须真实落为 markdown 表格；
 * 执行率显著不足的章节进入定向补表修复闭环（单轮，失败即放弃），保证表格数量与计划一致。
 * 返回 tableFixApplied 供调用侧判断补表后去重是否触发（未落地时正文未变，重复执行去重无意义）。
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
}): Promise<{ tableFixApplied: boolean }> {
  const { effectiveChapters, chapterDraftsFinal, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat } = input;
  let tableGaps = tablePlanExecutionGaps(effectiveChapters, chapterDraftsFinal);
  // 补表 patch 是否真正落地（供补表后去重的触发判断：未落地时正文未变，重复执行去重无意义）
  let tableFixApplied = false;
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
        const gapModuleTitles = [...new Set(gap.plans.map(plan => plan.moduleTitle).filter(Boolean))];
        const scopedEvidence = gapModuleTitles.length > 0
          ? draft.evidence.filter(item => {
            const section = item.sectionTitle;
            return !section || gapModuleTitles.some(title => section === title || section.includes(title) || title.includes(section));
          })
          : draft.evidence;
        const baseChapter = { id: draft.id, title: draft.title, content: draft.content, evidence: scopedEvidence.length ? scopedEvidence : draft.evidence, missingFacts: draft.missingFacts || [], sections: draft.sections };
        const baseIssue = `计划表格缺失（计划 ${gap.planned} 张，实际仅 ${gap.actual} 张）：${gap.plans.map(plan => `${plan.title}（表头：${plan.fields.map(field => field.name).join('、')}）`).join('；')}。必须按表头字段补齐这些 markdown 表格并紧跟相关小节输出，不得删除已有正文；每个表格前须有 1～2 句引导叙述说明表格作用与关键结论，表格不能替代小节正文；deriveFromProject 字段基于项目工程量、总工期与工序流水按定额工效推导具体数值，projectFactOnly 字段不得编造。`;
        // 并行修复共享 diagnostics.llm.lastError，重试提示中的失败原因存在轻微串章竞争（仅影响诊断文案，不影响修复正确性）
        let repaired = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `table-execution-repair:${draft.id}`, () => repairChapterByQuality({
          template,
          chapter: baseChapter,
          issues: [baseIssue],
          promptTexts: repairPromptTexts,
          requirement,
          forbidDrawingImages: true,
          diagnostics: generationDiagnostics,
          signal,
          // 补表 patch 一次输出多张表（表头+分隔线+数据行+引导句），默认预算下 JSON 易截断
          // 致 patches 解析失败、修复空手（历史缺陷：补表 patch 未应用）；每张表按 1200 token 预留
          maxTokens: Math.min(12000, Math.max(6000, gap.plans.length * 1200)),
        })));
        // 4.17.8 补表失败重试删除：每章单次尝试（失败即放弃）——重试轮是修复 token 主力军的组成部分
        return repaired;
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

/**
 * 全局一致性审查闭环：LLM 全文审查 + 确定性检测同源合并 → 数值定点替换（前置降轮次）→
 * 跨章冲突 LLM 定向修复（默认 1 轮，DOCUMENT_GLOBAL_REVIEW_ROUNDS=2 恢复双轮，按章并行）→ 确定性定点修复（后置清零）→ 确定性去重。
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
}): Promise<{ issues: string[]; dedupRan: boolean }> {
  const { chapterDraftsFinal, template, reviewPromptTexts, repairPromptTexts, requirement, signal, projectContext, generationDiagnostics, preliminaryFactsModel, scopeConflicts, progressStages, emitProgress, withProgressHeartbeat } = input;
  let globalConsistencyIssues: string[] = [];
  // 跨章一致性阶段的确定性去重是否已执行（供补表后去重判断：内容未变时 stripDuplicate* 幂等，可安全跳过）
  let globalDedupRan = false;
  try {
    const samplingRate = input.globalReviewSamplingRate ?? 1;
    const sampledChapters = samplingRate >= 1 || chapterDraftsFinal.length <= 2
      ? chapterDraftsFinal
      : chapterDraftsFinal.filter((chapter, index) => index % Math.max(2, Math.round(1 / samplingRate)) === 0);
    const sampledCount = sampledChapters.length;
    const runGlobalReview = () => withProgressHeartbeat(() => reviewGlobalConsistency({ template, chapters: sampledChapters, chapterReviews: [], promptTexts: reviewPromptTexts, requirement, projectContext, diagnostics: generationDiagnostics, signal }));
    // 确定性冲突检测（crossChapterConsistencyIssues / processSpecConflictIssues + documentIntegrityChecks
    // h13/h14/h15 检测家族）：正文出现与资料建设规模/估算价/结构层规格不一致的取值、劳动力/设备数量跨章矛盾、
    // 两可表述、基坑深度未锁定、危大清单不一致、表格/段落重复等问题时，确定性检测比 LLM 审查更精确；
    // 此前只在导出校验阶段暴露、生成流程内无修复机会，用户只能看到“导出门禁未通过”后手动继续生成
    // （历史缺陷，且重跑生成必然复现——LLM 依据同样资料会再次写出同样数值，导致“继续生成”按钮永远失败）。
    // 此处并入修复闭环统一修复，与导出校验同源同阈值（检测定位=修复定位）。
    const runDeterministicConsistencyCheck = async () => {
      const fullMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
      // 概况复述语义兑底（与导出校验 documentFinalValidation 同口径：候选句 vs 概况章正文 bge 余弦）
      const recapCandidates = overviewRecapCandidates(fullMarkdown);
      const recapSimilarity = await buildSemanticSimilarity(recapCandidates.sentences, recapCandidates.overviewBody ? [recapCandidates.overviewBody] : []);
      return [
        ...(await crossChapterConsistencyIssues(fullMarkdown, preliminaryFactsModel, scopeConflicts)).filter(issue => /跨章一致性冲突/u.test(issue.message)),
        ...(await processSpecConflictIssues(fullMarkdown, preliminaryFactsModel)).filter(issue => issue.level === 'error'),
        ...resourceConsistencyIssues(fullMarkdown),
        ...nodeScheduleConsistencyIssues(fullMarkdown),
        ...crossSectionNumericConflictIssues(fullMarkdown),
        ...foundationFormResidueIssues(fullMarkdown),
        ...ambiguousEitherOrIssues(fullMarkdown),
        ...excavationDepthLockIssues(fullMarkdown),
        ...dangerousListConsistencyIssues(fullMarkdown),
        ...basicInfoScheduleFieldIssues(fullMarkdown),
        ...duplicateTableIssues(fullMarkdown),
        ...duplicateParagraphIssues(fullMarkdown),
        ...resourceTriadSectionHierarchyIssues(fullMarkdown),
        ...await supportSystemConflictIssues(fullMarkdown),
        ...await sixHundredPercentCoverageIssues(fullMarkdown),
        ...overviewRecapIssues(fullMarkdown, { semanticSimilarity: recapSimilarity }),
        // 1.5 语义级跨章重复（措辞不同内容同质的跨章段落，bge ≥0.82）：并入既有去重收口，与 strip 同源
        ...(await crossChapterSemanticDuplicateIssues(chapterDraftsFinal)),
      ].map(issue => `${issue.message}；${issue.suggestion || ''}`);
    };
    const globalReview = await runGlobalReview();
    // LLM 审查 issue 与确定性检测 issue 分离：确定性部分在每轮复检/定点修复后全量重跑替换，
    // 不得合并保留已修复问题的旧快照（历史缺陷：确定性修复已生效但旧快照残留，
    // 被 finalize 包装为「跨章一致性复核」error 硬阻断导出）
    let llmReviewIssues = globalReview.issues;
    globalConsistencyIssues = [...new Set([...llmReviewIssues, ...(await runDeterministicConsistencyCheck())])];
    // A2 前置：跨章数值矛盾（劳动力峰值/节点工期/材料设备数量）确定性定点替换先于 LLM 定向修复执行——
    // 检测器已锁定矛盾数值对与权威口径（表格优先），无需 LLM 定位能力（历史缺陷：修复器
    // 无法在正文定位错误数值 → 不产出 patch → 空转轮次，矛盾残留被导出门禁硬阻断）
    let preDeterministicFixCount = 0;
    for (const chapter of chapterDraftsFinal) {
      const numericFix = applyNumericConsistencyDeterministicFixes(chapter.content);
      if (numericFix.fixedCount > 0) {
        chapter.content = numericFix.markdown;
        preDeterministicFixCount += numericFix.fixedCount;
      }
    }
    if (preDeterministicFixCount > 0) {
      globalConsistencyIssues = [...new Set([...llmReviewIssues, ...(await runDeterministicConsistencyCheck())])];
    }
    // 跨章一致性冲突修复闭环：按冲突描述中的正确口径对点名章节做 fact_conflict 定向修复，再复检；
    // 无任何 patch 落地的轮次立即停止，避免空转消耗 LLM 预算
    // P1-1 复检瘦身：确定性复检每轮必做（零 LLM 成本）；LLM 复检仅最后一轮或确定性清零时执行一次，
    // stale 标志标记「跳过 LLM 复检」的轮次，防空转 break 时旧快照残留被 finalize 包装为 error 硬阻断
    let llmReviewStale = false;
    // 2.3 评审轮合并：全局一致性 LLM 定向修复 2 轮 → 默认 1 轮（采样率模型已具备，单轮即可覆盖）；
    // DOCUMENT_GLOBAL_REVIEW_ROUNDS=2 恢复双轮。轮次上限收敛为 1-2 闭区间，防 env 误配放大 LLM 预算
    const globalReviewRounds = Math.max(1, Math.min(2, Number(process.env.DOCUMENT_GLOBAL_REVIEW_ROUNDS || 1) || 1));
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
          return [...issue.matchAll(/(\d[\d,，.]*)\s*(?:人|台|日|个|次|天|月|套|具|处|项|条)/gu)].some(match => normalizedChapterContent.includes(match[0].replace(/\s+/gu, '')));
        });
        return related.length > 0 ? [{ chapter, related }] : [];
      });
      const repairedChapterResults = await Promise.allSettled(repairChapterTargets.map(({ chapter, related }) => withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `global-consistency-repair:${chapter.id}`, () => repairChapterByQuality({
        template,
        chapter: { id: chapter.id, title: chapter.title, content: chapter.content, evidence: chapter.evidence || [], missingFacts: chapter.missingFacts || [], sections: chapter.sections },
        issues: related.map(issue => {
          // 重复类冲突（表格/段落重复）的修复指令是删除冗余而非按资料口径修正数值；
          // 其余冲突严格按资料口径修正（h15：修复指令与冲突类型对齐，避免 LLM 对重复类 issue 乱改数值）
          const repairInstruction = /重复/u.test(issue)
            ? '请删除本冲突描述的重复内容（保留首次出现的完整版本），不得改动其余正文。'
            : '请严格按冲突描述中给出的资料口径修正本章对应表述，不得引入新的数值；与资料口径一致的既有表述（含分层/子项数值）不得改动。';
          return `${issue}；${repairInstruction}`;
        }),
        promptTexts: repairPromptTexts,
        requirement,
        forbidDrawingImages: true,
        diagnostics: generationDiagnostics,
        signal,
      })))));
      repairedChapterResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          if (signal?.aborted) throw result.reason;
          console.error('[gen] global consistency repair failed:', result.reason);
          return;
        }
        const repaired = result.value;
        const { chapter } = repairChapterTargets[index];
        if (repaired.content && repaired.content !== chapter.content) {
          chapter.content = repaired.content;
          appliedCount += 1;
        }
      });
      if (appliedCount === 0) {
        // 本轮无 patch 落地、正文未变：若上一轮跳过 LLM 复检，需补一次刷新快照，
        // 避免已修复的 LLM issue 旧快照残留被 finalize 包装为「跨章一致性复核」error 硬阻断
        if (llmReviewStale) llmReviewIssues = (await runGlobalReview()).issues;
        break;
      }
      emitProgress(chapterDraftsFinal);
      // P1-1 复检瘦身：确定性检测每轮必做（零 LLM 成本，驱动下一轮判定）；LLM 复检仅最后一轮
      // 或确定性冲突清零时执行一次——LLM issue 是否已修复无法确定性判定，但无需每轮重复全文大输入调用
      const deterministicRecheck = await runDeterministicConsistencyCheck();
      // 2.3：末轮判定跟随 env 轮次上限（单轮模式下首轮即末轮，LLM 复检保留一次）
      const finalRound = repairRound === globalReviewRounds - 1;
      if (finalRound || deterministicRecheck.length === 0) {
        llmReviewIssues = (await runGlobalReview()).issues;
        llmReviewStale = false;
      } else {
        llmReviewStale = true;
      }
      globalConsistencyIssues = [...new Set([...llmReviewIssues, ...deterministicRecheck])];
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'global-consistency-review', status: globalConsistencyIssues.length > 0 ? 'failed' : 'success', message: globalConsistencyIssues.length > 0 ? `跨章一致性复检：仍有 ${globalConsistencyIssues.length} 个冲突` : '跨章一致性复检通过' }, { subtitle: '全局一致性审查' }));
      emitProgress(chapterDraftsFinal);
    }
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
    let postNumericFixCount = 0;
    for (const chapter of chapterDraftsFinal) {
      const numericFix = applyNumericConsistencyDeterministicFixes(chapter.content, { scheduleAuthority, assemblyRateAuthority });
      if (numericFix.fixedCount > 0) {
        chapter.content = numericFix.markdown;
        postNumericFixCount += numericFix.fixedCount;
      }
    }
    // h15：重复内容确定性删除（重复表格/重复段落/概况复述句），结构冗余删除比 LLM 定位更可靠；
    // 三个删除步骤顺序执行且互不重叠（后一步的输入是前一步删除后的文本）
    const dedupeFullMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
    const dedupeRecapCandidates = overviewRecapCandidates(dedupeFullMarkdown);
    const dedupeRecapSimilarity = await buildSemanticSimilarity(dedupeRecapCandidates.sentences, dedupeRecapCandidates.overviewBody ? [dedupeRecapCandidates.overviewBody] : []);
    let removedTableLines = 0;
    let removedParagraphLines = 0;
    let removedRecapLines = 0;
    let phraseFixCount = 0;
    let placeholderFixCount = 0;
    let qaCoverageFixCount = 0;
    for (const chapter of chapterDraftsFinal) {
      const beforeLines = chapter.content.split(/\r?\n/u).length;
      const tableResult = stripDuplicateTables(chapter.content);
      const paraResult = stripDuplicateParagraphs(tableResult.markdown);
      const recapResult = stripOverviewRecapBodyLines(paraResult.markdown, dedupeRecapSimilarity);
      // 4.17.4 确定性清洗链：句内重复短语折叠 → 6.1 一览表套话数据填充 → 6.1 质量保障内容补全
      const phraseResult = fixAdjacentPhraseDuplication(recapResult);
      const placeholderResult = fixPlaceholderTableCells(phraseResult.markdown, { areaSummary: scaleSummary, scheduleDays: scheduleAuthority });
      const qaCoverageResult = fixQualityAssuranceCoverage(placeholderResult.markdown);
      const finalLines = qaCoverageResult.markdown.split(/\r?\n/u).length;
      const totalRemoved = beforeLines - finalLines;
      const extraFixes = (phraseResult.fixedCount - 0) + placeholderResult.fixedCount + qaCoverageResult.fixedCount;
      phraseFixCount += phraseResult.fixedCount;
      placeholderFixCount += placeholderResult.fixedCount;
      qaCoverageFixCount += qaCoverageResult.fixedCount;
      if (totalRemoved > 0 || extraFixes > 0) {
        removedTableLines += tableResult.removedCount;
        removedParagraphLines += paraResult.removedCount;
        removedRecapLines += totalRemoved - tableResult.removedCount - paraResult.removedCount;
        chapter.content = qaCoverageResult.markdown;
      }
    }
    // 1.5 语义级跨章重复 strip（保留信息密度高者，删除低密度方整段）：逐字重复已由上面 strip 处理，
    // 此处清"措辞不同内容同质"的跨章雷同段；与检测器同源于 findCrossChapterSemanticDupPairs，删除后复检自然清零
    const removedSemanticDupParagraphs = await stripCrossChapterSemanticDuplicateParagraphs(chapterDraftsFinal);
    globalDedupRan = true;
    if (deterministicFix.fixedCount > 0 || postNumericFixCount > 0 || removedTableLines > 0 || removedParagraphLines > 0 || removedRecapLines > 0 || removedSemanticDupParagraphs > 0 || phraseFixCount > 0 || placeholderFixCount > 0 || qaCoverageFixCount > 0) {
      // 修复后重算：确定性检测快照必须用最新检测结果替换，不得合并保留已修复问题的旧快照
      //（历史缺陷：修复已生效但旧快照残留，被 finalize 包装为「跨章一致性复核」error 硬阻断导出）
      globalConsistencyIssues = [...new Set([...llmReviewIssues, ...(await runDeterministicConsistencyCheck())])];
      const fixParts = [
        deterministicFix.fixedCount > 0 ? `数值 ${deterministicFix.fixedCount} 处` : '',
        postNumericFixCount > 0 ? `跨章数值 ${postNumericFixCount} 处` : '',
        removedTableLines > 0 ? `重复表格 ${removedTableLines} 行` : '',
        removedParagraphLines > 0 ? `重复段落 ${removedParagraphLines} 行` : '',
        removedRecapLines > 0 ? `概况复述句 ${removedRecapLines} 行` : '',
        removedSemanticDupParagraphs > 0 ? `跨章语义重复段 ${removedSemanticDupParagraphs} 段` : '',
      ].filter(Boolean).join('、');
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'global-consistency-deterministic-fix', status: 'success', message: `跨章一致性定点修复：${fixParts}${deterministicFix.details.slice(0, 4).length > 0 ? `（${deterministicFix.details.slice(0, 4).join('、')}）` : ''}`, details: deterministicFix.details.slice(4) }, { subtitle: '跨章一致性修复' }));
      emitProgress(chapterDraftsFinal);
    }
    // B1：跨章一致性修复 running stage 收口——修复循环结束后必须置终态，
    // 历史缺陷：repair 与 review 两个 roleId 并存且 repair 永不置终态，「跨章一致性修复」节点前端永久 running
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'global-consistency-repair', status: globalConsistencyIssues.length > 0 ? 'failed' : 'success', message: globalConsistencyIssues.length > 0 ? `跨章一致性修复完成：仍残留 ${globalConsistencyIssues.length} 个冲突（已记录，由交付门禁兜底）` : '跨章一致性修复完成：冲突已全部消除' }, { subtitle: '跨章一致性修复' }));
    emitProgress(chapterDraftsFinal);
    const sampledStage = sampledCount < chapterDraftsFinal.length ? { ...globalReview.stage, message: `${globalReview.stage.message || '全局一致性审查完成'}（抽检 ${sampledCount}/${chapterDraftsFinal.length} 章）` } : globalReview.stage;
    upsertProgressStage(progressStages, sampledStage);
    emitProgress(chapterDraftsFinal);
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error('[gen] global consistency review failed:', err);
  }
  return { issues: globalConsistencyIssues, dedupRan: globalDedupRan };
}
