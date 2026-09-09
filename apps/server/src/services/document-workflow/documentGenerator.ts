import type { DocumentDraftChapter, DocumentExecutionStage, GeneratedDocumentDraft } from './types';
import { Semaphore, throwIfAborted } from './utils';
import { measureGenerationStep } from './rolePipeline';
import { finalizeGeneration } from './documentPipeline';
import type { GenerationSession, GenerationSessionGlobal, GenerationSessionPlanning, GenerationSessionPrepare, GenerationSessionUnderstanding } from './generationStages/generationSession';
import { stageChapterLoop } from './generationStages/stageChapterLoop';
import { stageBlueprint } from './generationStages/stageBlueprint';
import { stageOutlinePlanning } from './generationStages/stageOutlinePlanning';
import { stageUnderstanding } from './generationStages/stageUnderstanding';
import { stagePrepare } from './generationStages/stagePrepare';
import { dedupeAfterTableFix, enforcePlannedSectionCompleteness, enforceWorkPackageSkeletons, repairTableExecutionGaps, reportBudgetTrimAudit, runGlobalConsistencyReviewLoop } from './globalQualityGates';

export async function generateDocumentDraft(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; resumeChapters?: DocumentDraftChapter[]; signal?: AbortSignal; onProgress?: (stages: DocumentExecutionStage[], checkpoint?: { chapters?: DocumentDraftChapter[] }) => void }): Promise<GeneratedDocumentDraft> {
  throwIfAborted(input.signal);

  // P1 六阶段拆分（方案 5.1）：阶段 0-4 已提取至 generationStages/，跨阶段共享状态经 GenerationSession 显式化。
  // global.input 由编排器在入口注入，其余字段由各 stage 函数填充。
  const session: GenerationSession = {
    global: { input } as unknown as GenerationSessionGlobal,
    prepare: {} as unknown as GenerationSessionPrepare,
    understanding: {} as unknown as GenerationSessionUnderstanding,
    planning: {} as unknown as GenerationSessionPlanning,
    blueprint: {
      chapterConcurrency: 0,
      reviewConcurrency: 0,
      reviewSemaphore: new Semaphore(1),
      reviewTaskPool: [],
      basicFactSearchResults: [],
      integratedBlueprint: undefined,
      blueprintActive: false,
      blueprintDataText: '',
      billFactLock: undefined,
    },
    chapterLoop: { draftPhaseStartedAt: 0, chapterDraftsFinal: [], globalReviewPhaseStartedAt: 0 },
  };
  await stagePrepare(session);

  await stageUnderstanding(session);

  // ===== 图谱分析结束 =====

  // P1 六阶段拆分（方案 5.1）：阶段 2（评标校验/小节规划/校准/过滤/路由）已提取至 generationStages/stageOutlinePlanning.ts。

  await stageOutlinePlanning(session);


  // P1 六阶段拆分（方案 5.1）：阶段 3（蓝图构建/分部校准/参数桶）已提取至 generationStages/stageBlueprint.ts。

  await stageBlueprint(session);

  // P1 六阶段拆分（方案 5.1）：阶段 4（章节循环）已提取至 generationStages/stageChapterLoop.ts。

  await stageChapterLoop(session);


  // 源级同口径裁决已在事实主表构建入口完成（buildCanonicalFactModel 内 applyScopeConflictResolutions），
  // Writer 输入的事实与蓝图约束全部只含裁决口径（补疑优先），败选数值从源头就不会写入正文；
  // 此处不再做生成后全文替换（用户明确要求：源头解决，而非事后清除）

  // 全局一致性审查：strict 画像默认开启（额外 LLM 成本，全文分块审查）；
  // fast 小文档降级为抽检（按 globalReviewSamplingRate 抽样章节，至少 2 章保证跨章对比）；
  // env DOCUMENT_GLOBAL_CONSISTENCY_REVIEW=1 强制开启、=0 强制关闭；开启后在最终导出前做一次跨章一致性审查，
  // 审查发现的确定性数值冲突先进入定向修复闭环（修复→复检，单轮，失败即放弃），仍有残留才注入导出校验升级为阻断。
  // 闭环主体已提取至 globalQualityGates.runGlobalConsistencyReviewLoop
  let globalConsistencyIssues: string[] = [];
  // 跨章一致性阶段的确定性去重是否已执行（供补表后去重判断：内容未变时 stripDuplicate* 幂等，可安全跳过）
  let globalDedupRan = false;
  if (session.planning.generationStrategy.enableGlobalReview) {
    const reviewed = await runGlobalConsistencyReviewLoop({
      globalReviewSamplingRate: session.planning.generationStrategy.globalReviewSamplingRate,
      chapterDraftsFinal: session.chapterLoop.chapterDraftsFinal, template: session.prepare.template, reviewPromptTexts: session.prepare.reviewPromptTexts, repairPromptTexts: session.prepare.repairPromptTexts,
      requirement: session.global.input.requirement, signal: session.global.input.signal, projectContext: session.planning.projectContext,
      generationDiagnostics: session.planning.generationDiagnostics, preliminaryFactsModel: session.understanding.preliminaryFactsModel, scopeConflicts: session.understanding.canonicalFacts.scopeConflicts,
      progressStages: session.global.progressStages, emitProgress: session.global.emitProgress, withProgressHeartbeat: session.global.withProgressHeartbeat,
      blueprintData: session.blueprint.integratedBlueprint?.validation.passed ? session.blueprint.integratedBlueprint.data : undefined,
    });
    globalConsistencyIssues = reviewed.issues;
    globalDedupRan = reviewed.dedupRan;
  } else {
    // 稳定版：工作包骨架收口不依赖全局一致性审查开关——balanced 画像下 enableGlobalReview=false 时
    // 阶段 0 小节缺失补建/骨架锚点直连补写/表格剥离必须仍然生效（关键小节缺失是终检 blocker 硬伤，
    // 不能因画像跳过导致修复链哑火）；全局一致性审查的 LLM 成本可省，确定性兑底不能省
    await enforceWorkPackageSkeletons({
      chapterDraftsFinal: session.chapterLoop.chapterDraftsFinal, template: session.prepare.template, repairPromptTexts: session.prepare.repairPromptTexts,
      projectContext: session.planning.projectContext, requirement: session.global.input.requirement, signal: session.global.input.signal,
      generationDiagnostics: session.planning.generationDiagnostics, progressStages: session.global.progressStages, emitProgress: session.global.emitProgress, withProgressHeartbeat: session.global.withProgressHeartbeat,
    });
  }

  // F1 缺规划小节补写收口（不依赖全局一致性审查开关，与骨架收口同口径）：写作侧小节留空
  // （分节管线质检拒/空响应）时章节节点 failed 但达标契约下无章级补写循环，此处单轮兑底补写
  await enforcePlannedSectionCompleteness({
    chapterDraftsFinal: session.chapterLoop.chapterDraftsFinal, template: session.prepare.template, repairPromptTexts: session.prepare.repairPromptTexts,
    requirement: session.global.input.requirement, signal: session.global.input.signal,
    generationDiagnostics: session.planning.generationDiagnostics, progressStages: session.global.progressStages, emitProgress: session.global.emitProgress, withProgressHeartbeat: session.global.withProgressHeartbeat,
  });

  // 表格执行率确定性核验已提取至 globalQualityGates.repairTableExecutionGaps（单轮定向补表修复闭环，失败即放弃）
  const { tableFixApplied } = await repairTableExecutionGaps({
    effectiveChapters: session.planning.effectiveChapters, chapterDraftsFinal: session.chapterLoop.chapterDraftsFinal, template: session.prepare.template, repairPromptTexts: session.prepare.repairPromptTexts,
    requirement: session.global.input.requirement, signal: session.global.input.signal,
    generationDiagnostics: session.planning.generationDiagnostics, progressStages: session.global.progressStages, emitProgress: session.global.emitProgress, withProgressHeartbeat: session.global.withProgressHeartbeat,
  });

  // h15 补表后确定性去重已提取至 globalQualityGates.dedupeAfterTableFix；
  // 触发条件：仅在补表 patch 真正落地、或跨章一致性阶段的去重未执行时才运行
  //（正文自上次去重后未变化时，stripDuplicate* 幂等，重跑只会重复一次全文扫描与语义嵌入构建）
  if (tableFixApplied || !globalDedupRan) {
    globalConsistencyIssues = await dedupeAfterTableFix({ chapterDraftsFinal: session.chapterLoop.chapterDraftsFinal, globalConsistencyIssues, progressStages: session.global.progressStages, emitProgress: session.global.emitProgress });
  }

  // P4 预算裁剪报告已提取至 globalQualityGates.reportBudgetTrimAudit（软限制裁剪量收敛为单一可观测出口）
  reportBudgetTrimAudit({ generationDiagnostics: session.planning.generationDiagnostics, progressStages: session.global.progressStages, chapterDraftsFinal: session.chapterLoop.chapterDraftsFinal, emitProgress: session.global.emitProgress });

  // 4.2 阶段瀑布：全局轮收口（一致性审查/补表/去重/预算裁剪报告）→ finalize 期由 measureGenerationStep 包裹
  session.planning.generationDiagnostics.metrics.push({ name: 'phase:global-review', startedAt: session.chapterLoop.globalReviewPhaseStartedAt, endedAt: Date.now(), durationMs: Date.now() - session.chapterLoop.globalReviewPhaseStartedAt });

  return measureGenerationStep(session.planning.generationDiagnostics, 'phase:finalize', () => finalizeGeneration({
    chapterDrafts: session.chapterLoop.chapterDraftsFinal, chapterDraftsByOrder: session.understanding.chapterDraftsByOrder, chapterGenerationStagesByOrder: session.understanding.chapterGenerationStagesByOrder,
    chapterGenerationStages: session.understanding.chapterGenerationStages, effectiveChapters: session.planning.effectiveChapters, template: session.prepare.template, allEvidence: session.understanding.allEvidence,
    projectMaterialScope: session.understanding.projectMaterialScope,
    progressStages: session.global.progressStages,
    documentSpec: session.prepare.documentSpec, projectMaterialProfile: session.prepare.projectMaterialProfile, projectMaterialSummary: session.prepare.projectMaterialSummary,
    domainProfile: session.prepare.domainProfile, documentBudget: session.planning.documentBudget, promptTexts: session.prepare.promptTexts, reviewPromptTexts: session.prepare.reviewPromptTexts, repairPromptTexts: session.prepare.repairPromptTexts,
    input: session.global.input,
    generationStrategy: session.planning.generationStrategy, generationDiagnostics: session.planning.generationDiagnostics,
    chapterScopedContext: session.planning.chapterScopedProjectContext,
    promptBindings: session.prepare.promptBindings, promptDocumentRules: session.prepare.promptDocumentRules,
    projectUnderstanding: session.prepare.projectUnderstanding, projectContext: session.planning.projectContext, projectRoot: session.prepare.projectRoot, projectId: session.prepare.projectId, readiness: session.prepare.readiness,
    factExtractionPromptTexts: session.prepare.factExtractionPromptTexts,
    blueprintData: session.blueprint.integratedBlueprint?.validation.passed ? session.blueprint.integratedBlueprint.data : undefined,
    billFactLock: session.blueprint.billFactLock,
    requirementSemantics: session.prepare.requirementSemantics,
    hasExplicitOutline: session.prepare.hasExplicitOutline, missingItems: session.understanding.missingItems, retrievalCoverageReports: session.understanding.retrievalCoverageReports,
    failedChapterMessages: session.understanding.failedChapterMessages, webResearchReport: session.understanding.webResearchReport, indexHealth: session.understanding.indexHealth, promptPlan: session.prepare.promptPlan,
    globalConsistencyIssues,
    scopeConflicts: session.understanding.canonicalFacts.scopeConflicts,
    writingTaskBrief: session.planning.writingTaskBrief,
    evaluationCriteriaItems: session.understanding.evaluationItems.map(item => item.title).filter(Boolean),
    tenderRequirements: session.planning.tenderRequirements,
    requirementsSimilarity: session.planning.requirementsSimilarity,
    factTokenScopeClassifier: session.planning.factTokenScopeClassifier,
    professionalDepthClassifier: session.planning.professionalDepthClassifier,
    agentWorkflow: session.understanding.agentWorkflow,
    emitProgress: session.global.emitProgress, withProgressHeartbeat: session.global.withProgressHeartbeat,
  }));
}

export { regenerateDocumentChapter } from './documentRegeneration';
