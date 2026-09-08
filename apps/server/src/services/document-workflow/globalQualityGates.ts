/**
 * 全局质量收口块（从 documentGenerator.generateDocumentDraft 提取）：
 * 章节循环之后的全局收口阶段——全局一致性审查、表格执行率修复、补表后去重、预算裁剪报告。
 * 提取原则：行为保持，函数参数即原闭包捕获变量，返回值即原块对后续流程的产出。
 */
import type { DocumentDraftChapter, DocumentExecutionStage, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, NumericScopeConflict } from './types';
import { displayStage, upsertProgressStage } from './progress';
import { buildSemanticSimilarity, snapshotEmbedCacheStats } from './semanticSimilarity';
import { ambiguousEitherOrIssues, applyNumericConsistencyDeterministicFixes, basicInfoScheduleFieldIssues, crossChapterSemanticDuplicateIssues, crossSectionNumericConflictIssues, dangerousListConsistencyIssues, duplicateParagraphIssues, duplicateTableIssues, excavationDepthFromFacts, excavationDepthLockIssues, extractAssemblyRateAuthority, extractProjectScaleSummary, extractScheduleAuthority, extractSupportSystemAuthority, fixAdjacentPhraseDuplication, fixAmbiguousEitherOrCandidates, fixForbiddenConfigurationTerms, fixFormulaResidues, fixHazardIdentificationGaps, fixHeaderlessTables, fixInternalTerminology, fixMetaDiscourseDeclarations, fixPlaceholderTableCells, fixQualityAssuranceCoverage, fixSelfUnderminingCandidates, fixSixHundredPercentCoverage, formulaResidueIssues, foundationFormResidueIssues, laborPeakConflictIssues, metaDiscourseDeclarationIssues, nodeScheduleConsistencyIssues, overviewRecapCandidates, overviewRecapIssues, resourceConsistencyIssues, resourceTriadSectionHierarchyIssues, sixHundredPercentCoverageIssues, specLocationMismatchIssues, stripCrossChapterSemanticDuplicateParagraphs, stripDuplicateParagraphs, stripDuplicateTables, stripDuplicateTablesAcrossChapters, stripOverviewRecapBodyLines, supportSystemConflictIssues, tablePeakLaborWithChainFallback, waterLaborPeakAssociationIssues } from './documentIntegrityChecks';
import { blueprintCitationConsistencyIssues, blueprintPlanAuthorities, type BlueprintData } from './integratedBlueprint';
import { applyDeterministicConsistencyFixes, collectSectionContentGaps, crossChapterConsistencyIssues, processSpecConflictIssues } from './qualityValidation';
import { professionalSectionTaskCard } from './promptRuleExtraction';
import { reviewGlobalConsistency } from './chapterReview';
import { dataConsistencyConflictIssue, reviewDataConsistency } from './dataConsistencyReview';
import { tablePlanExecutionGaps } from './constructionOrgTablePlan';
import { measureGenerationStep, repairChapterByQuality } from './rolePipeline';
import { fillerSentenceTargets } from './constructionOrgAudit';
import { difficultyCountermeasureReport, fillerDensityReport } from './tenderBidChecks';
import { missingWorkPackageSkeletonTitles, stripEmptyWorkPackageHeadings, stripTablesInSection, workPackageSkeletonTitles } from './chapterPostProcessing';
import { DIVISION_SECTION_RE } from './writingSpec';
import { majorContentGovernanceIssues, perPackageContentElementIssues } from './constructionOrgQualityRules';

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
  // B1 语义重复 strip 扩围：补表 LLM 重写章节可能引入新的跨章雷同段（第九次回归实测：补表后
  // 5 处语义重复残留被导出门禁阻断，dedupeAfterTableFix 原仅覆盖逐字重复）；补表后必须同步跑
  // 语义级 strip（迭代至收敛，与跨章一致性阶段同源），删除后重算语义重复检测快照替换旧条目
  const postSemanticDupRemoved = await stripCrossChapterSemanticDuplicateParagraphs(chapterDraftsFinal);
  if (postSemanticDupRemoved > 0) {
    const postSemanticDupIssues = (await crossChapterSemanticDuplicateIssues(chapterDraftsFinal)).map(issue => `${issue.message}；${issue.suggestion || ''}`);
    globalConsistencyIssues = [...new Set([
      ...globalConsistencyIssues.filter(issue => !/跨章语义重复/u.test(issue)),
      ...postSemanticDupIssues,
    ])];
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'post-table-semantic-dedup', status: 'success', message: `补表后语义重复 strip：删除雷同段 ${postSemanticDupRemoved} 段` }, { subtitle: '表格执行率核验' }));
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
        const repaired = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `table-execution-repair:${draft.id}`, () => repairChapterByQuality({
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
 * 模板化修复闭环（套话句重写 + 重难点归因量化补齐）：套话/重难点检测此前只在评分侧消费、从未进入修复链
 * （历史缺陷：十六次同参回归套话句占比恒 ~27.8%、重难点归因+量化双达标 0%，templatingReview 只出建议不进修复）。
 * 与检测器同源定位（fillerSentenceTargets / difficultyCountermeasureReport.entries），命中句/条目原文直接作锚点直连
 * 修复（检测定位 = 修复定位），LLM 只改写不定位。每轮修复后同源复检驱动收敛，最多 2 轮、每轮锚点限幅。
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
}): Promise<{ templatingFixApplied: boolean }> {
  const { chapterDraftsFinal, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat } = input;
  let templatingFixApplied = false;
  for (let round = 0; round < 2; round += 1) {
    const fullMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
    const filler = await fillerDensityReport(fullMarkdown);
    const difficulty = await difficultyCountermeasureReport(fullMarkdown);
    const needsFillerFix = filler.ratio >= 0.1 || filler.vagueSemanticSentences > 0;
    const needsDifficultyFix = difficulty.countermeasures > 0 && difficulty.ratio < 0.5;
    if (!needsFillerFix && !needsDifficultyFix) break;
    // F2 回滚保护：修复前正文快照——历史缺陷（丰乐镇第五轮）：修复后套话句占比 27.5%→32.0%
    // 不降反升（LLM 重写产出的新句仍命中语义原型），带病修复不如不修
    const roundSnapshot = new Map(chapterDraftsFinal.map(chapter => [chapter.id, chapter.content]));
    const sentenceTargets = needsFillerFix ? await fillerSentenceTargets(chapterDraftsFinal) : [];
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
      const sentences = sentenceTargets.filter(target => (target.chapterId || target.chapterTitle) === (chapter.id || chapter.title)).map(target => target.sentence);
      const difficulty = difficultyByChapter.filter(item => item.chapter.id === chapter.id).map(item => ({ text: item.text, missingAttribution: item.missingAttribution, missingTarget: item.missingTarget }));
      return sentences.length > 0 || difficulty.length > 0 ? [{ chapter, sentences, difficulty }] : [];
    });
    if (targets.length === 0) break;
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'templating-repair', status: 'running', message: `模板化修复第 ${round + 1} 轮：套话句占比 ${(filler.ratio * 100).toFixed(1)}%，重难点双达标 ${(difficulty.ratio * 100).toFixed(0)}%（${targets.length} 章）` }, { subtitle: '模板化修复' }));
    emitProgress(chapterDraftsFinal);
    let appliedCount = 0;
    const repairOne = async (target: (typeof targets)[number]) => {
      const parts: string[] = [];
      if (target.sentences.length > 0) {
        parts.push(`第 1～${target.sentences.length} 条目标原文是本章已检出的空话套话句：逐条删除，或改写为“责任岗位 + 执行动作 + 量化标准 + 检查频次 + 整改时限”的具体措施表述；改写必须使用本章证据摘要中的项目事实与量化数据，不得凭空编造数值；属必须保留的合规承诺句可保留但须具体化到可核查。`);
      }
      let anchorIndex = target.sentences.length + 1;
      for (const item of target.difficulty) {
        const missingParts = [item.missingAttribution ? '归因句（该难点的成因/风险来源）' : '', item.missingTarget ? '量化控制目标（数值+单位，来自本章证据摘要或行业规范，不得编造）' : ''].filter(Boolean).join('与');
        parts.push(`第 ${anchorIndex} 条目标原文是重难点分析条目，缺少${item.missingAttribution && item.missingTarget ? '成因归因与量化控制目标' : missingParts}：保留条目原有事实与数值，在其内补充${missingParts}。`);
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
        diagnostics: generationDiagnostics,
        signal,
        anchorTexts: [...target.sentences, ...target.difficulty.map(item => item.text)],
        maxTokens: 6000,
        // F2 套话重写需要项目事实支撑：证据预算专用放大（默认 1500 字符最小集不足以支撑
        // 60 条套话句具体化重写，重写后仍是套话的根源之一）
        evidenceChars: 5000,
      })));
    };
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
    if (appliedCount === 0) {
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'templating-repair', status: 'failed', message: `模板化修复第 ${round + 1} 轮：修复 patch 未落地（${targets.length} 章锚点失配或 LLM 未产出）`, details: [`套话句占比 ${(filler.ratio * 100).toFixed(1)}% 未收敛，重难点双达标 ${(difficulty.ratio * 100).toFixed(0)}%`] }, { subtitle: '模板化修复' }));
      break;
    }
    // F2 回滚判定：修复后同源复检——套话占比上升且重难点双达标未提升时回滚本轮全部修改
    //（修复变差不可接受；重难点达标提升可抵偿套话占比小幅上升，保留修复）
    const recheckMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
    const recheckFiller = await fillerDensityReport(recheckMarkdown);
    const recheckDifficulty = await difficultyCountermeasureReport(recheckMarkdown);
    const fillerWorse = recheckFiller.ratio > filler.ratio + 0.01;
    const difficultyBetter = recheckDifficulty.ratio > difficulty.ratio + 0.01;
    if (fillerWorse && !difficultyBetter) {
      for (const chapter of chapterDraftsFinal) {
        const snapshot = roundSnapshot.get(chapter.id);
        if (snapshot !== undefined) chapter.content = snapshot;
      }
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'templating-repair', status: 'failed', message: `模板化修复第 ${round + 1} 轮：修复后套话句占比 ${(recheckFiller.ratio * 100).toFixed(1)}% > 修复前 ${(filler.ratio * 100).toFixed(1)}%，已回滚本轮修改`, details: ['LLM 重写未收敛，回滚保留修复前正文'] }, { subtitle: '模板化修复' }));
      emitProgress(chapterDraftsFinal);
      break;
    }
    templatingFixApplied = true;
  }
  // 修复收口：最终复检快照（逐轮复检已由下一轮开头检测承担，此处输出最终收敛值供评分与诊断）
  if (templatingFixApplied) {
    const finalMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
    const finalFiller = await fillerDensityReport(finalMarkdown);
    const finalDifficulty = await difficultyCountermeasureReport(finalMarkdown);
    const converged = finalFiller.ratio < 0.1 && (!finalDifficulty.heavyTemplated || finalDifficulty.countermeasures === 0);
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'templating-repair', status: converged ? 'success' : 'failed', message: `模板化修复完成：套话句占比 ${(finalFiller.ratio * 100).toFixed(1)}%（达标线 ≤10%），重难点归因+量化双达标 ${(finalDifficulty.ratio * 100).toFixed(0)}%（达标线 ≥50%）`, details: converged ? [] : ['未完全收敛：残留套话/缺要素条目由评分侧展示，不阻断交付'] }, { subtitle: '模板化修复' }));
    emitProgress(chapterDraftsFinal);
  }
  return { templatingFixApplied };
}

/**
 * 工作包骨架确定性收口（稳定版）：关键小节（项目主要施工内容/主要分部分项工程施工方案/主要施工方法）
 * 的内部 #### 标题结构由系统从资料识别的工作包清单锁定，写作后仍有缺失时（历史缺陷：主题块管线块质检
 * 只管标题缺失/重复/越界 + 字数、不查内容要素，重难点表/节点计划表串位可通过块质检 → 终检 blocker →
 * LLM 修复不收敛 → completed_with_issues 带病交付），修复链做确定性兑底：
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
}): Promise<{ skeletonFixApplied: boolean }> {
  const { chapterDraftsFinal, projectContext, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat } = input;
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
      return withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `workpackage-skeleton-repair:${target.chapter.id}`, () => repairChapterByQuality({
        template,
        chapter: { id: target.chapter.id, title: target.chapter.title, content: target.chapter.content, evidence: target.chapter.evidence || [], missingFacts: target.chapter.missingFacts || [], sections: target.chapter.sections },
        issues: [parts.join('\n'), '清单之外的内容一律不得改动；不得删除任何小节标题、表格与数值参数。'],
        promptTexts: repairPromptTexts,
        requirement,
        forbidDrawingImages: true,
        diagnostics: generationDiagnostics,
        signal,
        // 补写定位锚点 = 小节标题行：replacement 必须逐字保留标题行后在节内追加补写小节，系统已锁定补写目标
        anchorTexts: target.entries.map(entry => ({ text: entry.headingLine, append: true })),
        maxTokens: 6000,
      })));
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
}): Promise<{ plannedSectionFixApplied: boolean }> {
  const { chapterDraftsFinal, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat } = input;
  // 缺失判定与写作期/导出期检查器同源（collectSectionContentGaps 全量跑，只取 missing_planned_section 口径），
  // 补写目标 = 检查器会报「缺少规划小节」的小节，不多不少；
  // 丰乐镇第 2 轮实测扩展：规划小节只有标题或表格无正文（planned empty，如扬尘治理六个百分百/环境污染物管控指标
  // 只有表格无正文）同样进补写目标——写作侧留表格、修复链无人补正文段落，终检报「小节只有标题或表格无正文」-8 分/条
  const gaps = collectSectionContentGaps('', chapterDraftsFinal).filter(gap => gap.reason === 'missing_planned_section' || (gap.reason === 'empty' && gap.planned));
  const targets = chapterDraftsFinal.flatMap(chapter => {
    const chapterGaps = gaps.filter(gap => gap.chapterTitle === chapter.title);
    if (chapterGaps.length === 0) return [];
    const sectionTitles = chapterGaps.map(gap => ({ title: gap.sectionTitle, emptyOnly: gap.reason === 'empty' }));
    // 章末标题行作为补写定位锚点（append 模式：新小节插入该锚点之后）
    const lastHeadingLine = chapter.content.split('\n').map(line => line.trim()).filter(line => /^#{2,4}\s/u.test(line)).pop();
    if (!lastHeadingLine) return [];
    return [{ chapter, sectionTitles, lastHeadingLine }];
  });
  if (targets.length === 0) return { plannedSectionFixApplied: false };
  upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'planned-section-repair', status: 'running', message: `缺规划小节补写（${targets.length} 章缺失）` }, { subtitle: '缺节补写收口' }));
  emitProgress(chapterDraftsFinal);
  const chapterIndexByTitle = new Map(chapterDraftsFinal.map((chapter, index) => [chapter.title, index]));
  const repairOne = async (target: (typeof targets)[number]) => {
    const chapterIndex = chapterIndexByTitle.get(target.chapter.title) ?? chapterDraftsFinal.indexOf(target.chapter);
    const parts = target.sectionTitles.map(({ title: sectionTitle, emptyOnly }) => {
      const sectionOrdinal = ((target.chapter.sections || []).findIndex(section => section === sectionTitle) + 1) || ((target.chapter.sections || []).length + 1);
      const heading = `### ${chapterIndex + 1}.${sectionOrdinal} ${sectionTitle}`;
      if (emptyOnly) return `本章小节「${sectionTitle}」只有标题或表格无正式正文：必须在既有小节标题下补写正式正文段落（正文写在表格前后均可），不得新增同名小节标题、不得删除或改动已有表格与数值。\n${professionalSectionTaskCard(target.chapter.title, sectionTitle)}`;
      return `本章正文缺少规划小节「${sectionTitle}」：必须在章末新增小节标题「${heading}」（标题一字不差）并写入正式正文。\n${professionalSectionTaskCard(target.chapter.title, sectionTitle)}`;
    });
    return withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `planned-section-repair:${target.chapter.id}`, () => repairChapterByQuality({
      template,
      chapter: { id: target.chapter.id, title: target.chapter.title, content: target.chapter.content, evidence: target.chapter.evidence || [], missingFacts: target.chapter.missingFacts || [], sections: target.chapter.sections },
      issues: [...parts, '已有内容一律不得改动，不得删除任何已有小节、表格与数值参数；新增小节之外不得改动。'],
      promptTexts: repairPromptTexts,
      requirement,
      forbidDrawingImages: true,
      diagnostics: generationDiagnostics,
      signal,
      // 补写定位锚点 = 章末标题行：replacement 必须逐字保留锚点后在章末追加补写小节
      anchorTexts: [{ text: target.lastHeadingLine, append: true }],
      maxTokens: 6000,
    })));
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
    if (repaired.content && repaired.content !== chapter.content) {
      chapter.content = repaired.content;
      appliedCount += 1;
    }
  });
  emitProgress(chapterDraftsFinal);
  upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'planned-section-repair', status: appliedCount > 0 ? 'success' : 'failed', message: appliedCount > 0 ? `缺规划小节补写完成：补写 ${appliedCount} 章` : '缺规划小节补写：修复 patch 未落地（锚点失配或 LLM 未产出）' }, { subtitle: '缺节补写收口' }));
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
}): Promise<{ issues: string[]; dedupRan: boolean }> {
  const { chapterDraftsFinal, template, reviewPromptTexts, repairPromptTexts, requirement, signal, projectContext, generationDiagnostics, preliminaryFactsModel, scopeConflicts, progressStages, emitProgress, withProgressHeartbeat, blueprintData } = input;
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
    const runDeterministicConsistencyCheck = async () => {
      const fullMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
      // 概况复述语义兑底（与导出校验 documentFinalValidation 同口径：候选句 vs 概况章正文 bge 余弦）
      const recapCandidates = overviewRecapCandidates(fullMarkdown);
      const recapSimilarity = await buildSemanticSimilarity(recapCandidates.sentences, recapCandidates.overviewBody ? [recapCandidates.overviewBody] : []);
      return [
        ...(await crossChapterConsistencyIssues(fullMarkdown, preliminaryFactsModel, scopeConflicts)).filter(issue => /跨章一致性冲突/u.test(issue.message)),
        ...(await processSpecConflictIssues(fullMarkdown, preliminaryFactsModel)).filter(issue => issue.level === 'error'),
        ...resourceConsistencyIssues(fullMarkdown, { laborPeakAuthority: blueprintPlanAuthorities(blueprintData).laborPeakAuthority }),
        ...laborPeakConflictIssues(fullMarkdown),
        // F16 用水高峰人数 vs 劳动力峰值跨字段关联（临时用水人数必须与劳动力峰值同口径）
        ...waterLaborPeakAssociationIssues(fullMarkdown),
        // F17/F18 元话语声明句与公式形态残留（远端客户反馈「公式直接输入正文」根治）
        ...metaDiscourseDeclarationIssues(fullMarkdown),
        ...formulaResidueIssues(fullMarkdown),
        ...nodeScheduleConsistencyIssues(fullMarkdown),
        ...crossSectionNumericConflictIssues(fullMarkdown),
        // F14 规格错位检测：正文规格 vs 清单权威映射（specAuthorityMap），确定性可判且无权威时静默跳过
        ...specLocationMismatchIssues(fullMarkdown, preliminaryFactsModel.specAuthorityMap),
        ...foundationFormResidueIssues(fullMarkdown),
        ...ambiguousEitherOrIssues(fullMarkdown),
        ...excavationDepthLockIssues(fullMarkdown),
        ...dangerousListConsistencyIssues(fullMarkdown),
        ...basicInfoScheduleFieldIssues(fullMarkdown),
        ...duplicateTableIssues(fullMarkdown),
        ...duplicateParagraphIssues(fullMarkdown),
        ...resourceTriadSectionHierarchyIssues(fullMarkdown),
        ...await supportSystemConflictIssues(fullMarkdown, supportAuthority),
        ...await sixHundredPercentCoverageIssues(fullMarkdown),
        ...overviewRecapIssues(fullMarkdown, { semanticSimilarity: recapSimilarity }),
        // 1.5 语义级跨章重复（措辞不同内容同质的跨章段落，bge ≥0.82）：并入既有去重收口，与 strip 同源
        ...(await crossChapterSemanticDuplicateIssues(chapterDraftsFinal)),
        // 三期收口：蓝图引用一致性质检（权威源=蓝图参数桶）——总工期/关键工程量不一致 error 进修复链，
        // 红线事实缺口 warning 由章级对齐缺口观测兑底（不进入修复轮）
        ...(blueprintData ? blueprintCitationConsistencyIssues(fullMarkdown, blueprintData).filter(issue => issue.level === 'error') : []),
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
    for (const chapter of chapterDraftsFinal) {
      const numericFix = applyNumericConsistencyDeterministicFixes(chapter.content, { ...blueprintPlanAuthorities(blueprintData), supportAuthority });
      if (numericFix.fixedCount > 0) {
        chapter.content = numericFix.markdown;
        preDeterministicFixCount += numericFix.fixedCount;
      }
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
                : '请严格按冲突描述中给出的资料口径修正本章对应表述，不得引入新的数值；与资料口径一致的既有表述（含分层/子项数值）不得改动；同一材料多种规格按所属部位/分部分项分别使用，禁止全文统一为一种规格。';
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
    await repairTemplatingIssues({ chapterDraftsFinal, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat });
    // 工作包骨架确定性收口（稳定版）：关键小节内部 #### 结构由系统锁定，写作后仍缺失时确定性兑底——
    // 表格剥离（零 LLM）+ 缺失骨架锚点直连补写（系统下发标题、LLM 只填三要素正文）；
    // 放在模板化修复之后：套话重写不改结构，骨架收口不改套话，两条修复链互不干扰
    await enforceWorkPackageSkeletons({ chapterDraftsFinal, projectContext, template, repairPromptTexts, requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat });
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
    // B1 蓝图权威（进度节点/机械台数）与 factsModel 权威（总工期/装配率）并列注入
    const masterAuthorities = blueprintPlanAuthorities(blueprintData);
    // A3 劳动力峰值跨章权威（丰乐镇实测）：蓝图 peakValue（造价锚定口径，量级可靠）优先；
    // 蓝图不可用时回退全文表峰值扫描（表缺失时回退高峰表述最大值）。丰乐镇第 3 轮：
    // 蓝图荒谬值已被造价锚定校验拦截，峰值不再出现正文自编 71 与蓝图 1222 两套口径。
    const laborPeakAuthority = (masterAuthorities.laborPeakAuthority && masterAuthorities.laborPeakAuthority > 0)
      ? masterAuthorities.laborPeakAuthority
      : tablePeakLaborWithChainFallback(chapterDraftsFinal.map(chapter => chapter.content).join('\n\n'));
    let postNumericFixCount = 0;
    for (const chapter of chapterDraftsFinal) {
      const numericFix = applyNumericConsistencyDeterministicFixes(chapter.content, { scheduleAuthority, assemblyRateAuthority, ...masterAuthorities, supportAuthority, laborPeakAuthority });
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
    // A4 跨章重复表删除（丰乐镇实测）：同一关键节点表复制粘贴到 4 个章节时逐章去重永不命中，
    // 先全文判定再映射回章节删除（与检测器同源口径），删后不重跑逐章 stripDuplicateTables 的重复表步骤。
    const crossChapterTableDedupe = stripDuplicateTablesAcrossChapters(chapterDraftsFinal);
    removedTableLines += crossChapterTableDedupe.removedCount;
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
    // A6 危大/自伤/六个百分百确定性收口（丰乐镇 79 分基线对照）：三类问题 LLM 修复轮定位能力不足，
    // 按检测器同源口径确定性改写/补写（自伤句式改写、危大辨识清单补遗漏项、扬尘六个百分百补缺项短句），
    // 逐章执行与检测器全文判定同源，修复后由导出门禁复检自然清零
    let selfUnderminingFixCount = 0;
    let hazardGapFixCount = 0;
    let sixHundredFixCount = 0;
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
      const hazardGapFix = fixHazardIdentificationGaps(chapter.content);
      if (hazardGapFix.fixedCount > 0) {
        chapter.content = hazardGapFix.markdown;
        hazardGapFixCount += hazardGapFix.fixedCount;
      }
      const sixHundredFix = await fixSixHundredPercentCoverage(chapter.content);
      if (sixHundredFix.fixedCount > 0) {
        chapter.content = sixHundredFix.markdown;
        sixHundredFixCount += sixHundredFix.fixedCount;
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
    if (deterministicFix.fixedCount > 0 || postNumericFixCount > 0 || removedTableLines > 0 || removedParagraphLines > 0 || removedRecapLines > 0 || removedSemanticDupParagraphs > 0 || phraseFixCount > 0 || placeholderFixCount > 0 || qaCoverageFixCount > 0 || selfUnderminingFixCount > 0 || hazardGapFixCount > 0 || sixHundredFixCount > 0 || internalTermFixCount > 0 || headerlessTableFixCount > 0 || ambiguousEitherOrFixCount > 0 || forbiddenConfigFixCount > 0) {
      // 修复后重算：确定性检测快照必须用最新检测结果替换，不得合并保留已修复问题的旧快照
      //（历史缺陷：修复已生效但旧快照残留，被 finalize 包装为「跨章一致性复核」error 硬阻断导出）
      deterministicIssues = await runDeterministicConsistencyCheck();
      globalConsistencyIssues = [...new Set([...llmReviewIssues, ...deterministicIssues])];
      const fixParts = [
        deterministicFix.fixedCount > 0 ? `数值 ${deterministicFix.fixedCount} 处` : '',
        postNumericFixCount > 0 ? `跨章数值 ${postNumericFixCount} 处` : '',
        removedTableLines > 0 ? `重复表格 ${removedTableLines} 行` : '',
        removedParagraphLines > 0 ? `重复段落 ${removedParagraphLines} 行` : '',
        removedRecapLines > 0 ? `概况复述句 ${removedRecapLines} 行` : '',
        removedSemanticDupParagraphs > 0 ? `跨章语义重复段 ${removedSemanticDupParagraphs} 段` : '',
        selfUnderminingFixCount > 0 ? `自伤表述改写 ${selfUnderminingFixCount} 处` : '',
        hazardGapFixCount > 0 ? `危大辨识补漏 ${hazardGapFixCount} 项` : '',
        sixHundredFixCount > 0 ? `扬尘六个百分百补写 ${sixHundredFixCount} 项` : '',
        internalTermFixCount > 0 ? `内部术语清洗 ${internalTermFixCount} 处` : '',
        headerlessTableFixCount > 0 ? `无表头表格补齐 ${headerlessTableFixCount} 处` : '',
        ambiguousEitherOrFixCount > 0 ? `两可表述归一 ${ambiguousEitherOrFixCount} 处` : '',
        forbiddenConfigFixCount > 0 ? `配置污染清洗 ${forbiddenConfigFixCount} 处` : '',
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
    console.error('[gen] global consistency review failed:', err);
  }
  return { issues: globalConsistencyIssues, dedupRan: globalDedupRan };
}
