import type { AgentWorkflowContext } from './agentWorkflow';
import type { DocumentAsset, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentGenerationStrategy, DocumentTemplate, DocumentTemplateChapter, GeneratedDocumentDraft, NumericScopeConflict, PromptBinding, RetrievalCoverageReport, RuntimePromptRuleSet, TenderRequirementItem, TenderRequirementModel, ValidationIssue, WritingTaskBrief } from './types';
import type { FactTokenScopeClassifier } from './factTokenClassifier';
import type { ProfessionalDepthClassifier } from './professionalDepthClassifier';
import type { ProjectMaterialScope } from './projectMaterialScope';
import type { ProjectMaterialProfile, ProjectUnderstanding } from './projectMaterialProfile';
import type { DocumentBudget } from './budget';
import type { PromptBindingPlan } from './templateStore';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { ProjectMaterialSummary } from '../document-core/projectMaterialService';
import type { DocumentDomainProfile } from '../document-core/documentDomainProfileService';
import type { DocumentGenerationReadiness } from '../document-validation/documentReadinessService';
import { assertEvidenceInProjectScope, filterEvidenceByProjectScope, filterFactsByProjectScope, projectScopeAudit, sourceInProjectScope } from './projectMaterialScope';
import { selectEvidenceByBudget } from './evidence';
import { tuningProfile } from './tuningProfile';
import { validateDraftWithAutoSpec } from '../document-validation/documentValidationService';
import { validateProjectContamination } from '../document-validation/documentContaminationService';
import { chapterReadinessIssues, evaluateChapterReadiness } from '../document-validation/chapterReadinessService';
import { validateFactConsistency } from '../document-validation/factConsistencyService';
import { cleanFormalSourcePhrases, composeDocumentMarkdown, finalizeDocumentMarkdown, normalizeTertiaryHeadings, plannedStructureIssues, sanitizeFormalMarkdown } from './markdownComposer';
import { documentBudgetIssues, documentTextLength, pageTargetIssues } from './budget';
import { applySpecGateRules, autoSpecGateRequiredTexts, buildExportGate, qualitySeveritySummary, applyDeterministicConsistencyFixes, applyDeterministicConsistencyFixesToMarkdown, markdownTableQualityIssues, headingUncoveredEngineeringItems } from './qualityValidation';
import { applyNumericConsistencyDeterministicFixes, extractAssemblyRateAuthority, extractGreeningMaintenanceAuthority, extractProjectScaleSummary, extractScheduleAuthority, extractSupportSystemAuthority, fixTableBorneContentSections, fixTocFromBody, runDeterministicChainUntilConverged, runFixUntilClean, stripCommercialDataBodyLines, stripCrossChapterSemanticDuplicateParagraphs, stripDuplicateTablesAcrossChapters } from './documentIntegrityChecks';
import { internalTerminologyAnchorIssues, stripInternalTerminologySentences } from './internalTerminologyAnchors';
import { semanticChoiceConflicts, semanticChoiceConflictIssue } from './dataConsistencyReview';
import { blueprintPlanAuthorities, extractDecisionLockEntries } from './integratedBlueprint';
import type { BlueprintData } from './integratedBlueprint';
import { buildStandardFinalValidationIssues, crossChapterDuplicateSectionIssues } from './documentFinalValidation';
import { fixScoringRequirementResponses } from './tenderRequirements';
import { buildDocumentProfileReport } from './documentProfiles';
import { buildKnowledgeCoverageReport, knowledgeCoverageIssues } from './documentKnowledgeCoverage';
import { buildDocumentFactTraces, factTraceIssues } from './documentFactTrace';
import { buildChapterCoverageReports, chapterCoverageIssues } from './documentChapterCoverage';
import { buildDocumentQualityReport, qualityReportIssues } from './documentQualityReport';
import { benchmarkGeneratedMarkdown } from './benchmarkQuality';
import { buildRepairStrategies, repairStrategyIssues } from './documentRepairStrategies';
import { repairChapterByQuality, repairPatchGuard } from './rolePipeline';
import { withPatchRollback } from './patchRollback';
import { stripSnapshotIssues } from './issueProvenance';
import { enforcePlannedSectionCompleteness } from './globalQualityGates';
import { buildDocumentReviewChecklist } from './documentReviewChecklist';
import { collectValidationIssueGroups } from './documentQualityPipeline';
import { DOCUMENT_WORKFLOW_VERSION } from './documentWorkflowVersion';
import { buildDocumentTelemetryReport } from './documentTelemetry';
import { retrievalCoverageIssues } from './documentEvidenceRetrieval';
import { extractFacts, extractFactsWithLlm, extractLocalFactPool, buildFactsModel, shouldRunLlmFactExtraction } from './factsModel';
import { applyScopeConflictResolutions, buildCanonicalFactModel, buildCanonicalFacts, detectNumericScopeConflicts, extractDrawingAnnotationFacts } from './factGovernance';
import { extractSection, stableHash, stringifyFactValue, throwIfAborted } from './utils';
import { formalTextGateIssues } from './agentWorkflow';
import { displayStage, upsertProgressStage } from './progress';
import { buildValidationIssues } from './chapterGeneration';
import { chapterSectionFactUsageIssues } from './chapterReview';
import { factCoverageIssues, factsWithEvidenceSource, criticalSectionBlockerLine, callBreakdownTopDetails, callBreakdownTopSummary, finalizeChapterContentQuality, finalizeFinalMarkdownStructure, normalizeProjectBasicInfoTable, partialChapterStatus, phaseWaterfallDetails, projectBasicPlaceholderIssues, slowMetricSummary, uncoveredImportantFacts, validateDraft } from './documentGeneratorHelpers';
import type { kbIndexHealth } from './documentGeneratorHelpers';
import { constructionOrgProfessionalAuditIssues } from './constructionOrgAudit';
import { buildProfessionalScoreReport } from './documentProfessionalScore';
import { recordDeterministicFixCases } from './workflowCaseLog';
import { referenceBenchmarkForType } from './templateReferenceService';
import { suggestProjectType } from './referenceQualityProfile';
import { reviewTemplatingSemantics } from './templatingReview';
import { qingtianReviewValidationIssues, runFullDimensionReview } from './fullDimensionReview';
import { SURFACE_FIX_STEPS, type SurfaceFixerContext } from './deterministicFixChains';
import { assertRegistryConsistency, det } from './detectorFixerRegistry';
import { createFinalizeSession, type FinalizeGenerationInput } from './finalize/finalizeSession';
import { stageRebuildFacts } from './finalize/rebuildFacts';
import { stageComposeFinal, stageRebuildAndRecompute, stageValidationPack } from './finalize/rebuildAndRecompute';

import { stageFactLanding } from './finalize/repairRounds/factLanding';
import { stageTableRepair } from './finalize/repairRounds/tableRepair';

import { stageSemanticChoice } from './finalize/repairRounds/semanticChoice';
import { stageDeterministicStage5 } from './finalize/repairRounds/deterministicStage5';
import { stageQingtianReview } from './finalize/repairRounds/qingtianReview';
import { stagePostReviewSurface } from './finalize/repairRounds/postReviewSurface';
import { stageNumericVerification } from './finalize/repairRounds/numericVerification';
import { stageRequirementVerification } from './finalize/repairRounds/requirementVerification';
import { stageFinalGate } from './finalize/finalGate';
import { stageHealthDiagnosis } from './finalize/healthDiagnosis';

export async function finalizeGeneration(p: FinalizeGenerationInput): Promise<GeneratedDocumentDraft> {
  // P23：注册表一致性检查（每次最终化前执行，开销 O(n) 字符串比对可忽略）——
  // 修复器锚定缺失/权威口径拉扯/llm-patch 缺 patchGuard 任一违反即抛错显性暴露，不静默降级
  assertRegistryConsistency();
  const {
    chapterDraftsByOrder, chapterGenerationStagesByOrder, chapterGenerationStages, effectiveChapters,
    input, hasExplicitOutline, failedChapterMessages,
  } = p;
  const { signal, requirement } = input;

  // P2 拆分（方案 5.2）：跨阶段共享状态显式化为 FinalizeSession；各阶段仅消费/写回 session 字段
  const session = createFinalizeSession(p);

  const chapterDrafts = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
  session.chapterDrafts = chapterDrafts;
  chapterGenerationStages.push(...chapterGenerationStagesByOrder.filter((item): item is DocumentExecutionStage => Boolean(item)));
  if (chapterDrafts.length === 0) throw new Error(`章节生成未完成：${failedChapterMessages.join('；') || '没有生成任何有效章节'}`);
  if (hasExplicitOutline && chapterDrafts.length < effectiveChapters.length) throw new Error(`OUTLINE 指定 ${effectiveChapters.length} 章，实际只生成 ${chapterDrafts.length} 章：${failedChapterMessages.join('；') || '部分章节未生成'}`);

  await stageRebuildFacts(session);
  await stageValidationPack(session);
  stageComposeFinal(session);
  await stageRebuildAndRecompute(session);

  // P6：修复轮顺序由 FINALIZE_REPAIR_ROUNDS（detectorFixerRegistry）单源声明，下方线性链按声明顺序逐一对应：
  // fact-landing-round → table-repair-round → semantic-choice-conflict → deterministic-stage5 → formal-source-clean
  // → qingtian-full-review → planned-section-final → commercial-strip → table-deterministic-repair → post-review-surface
  // → numeric-verification → requirement-verification → terminology-strip → toc-consistency
  //（顺序快照测试锁定；新增修复轮必须同时更新声明表）
  await stageFactLanding(session);
  await stageTableRepair(session);
  // P2 拆分（方案 5.2）：语义矛盾检测轮/阶段5确定性清洗/全维度评审轮/评审后兜底链/门禁收口已提取至 finalize/。
  await stageSemanticChoice(session);
  await stageDeterministicStage5(session);
  await stageQingtianReview(session);
  await stagePostReviewSurface(session);
  // C2 正文数值 vs 资料原文确定性核对轮：零 LLM 确定性提取疑似无来源数值，未匹配项定向 LLM 修复（单轮，失败即放弃）；
  // 置于评审后兜底链之后，核对覆盖全部修复轮成果，作为交付前数值兜底
  await stageNumericVerification(session);
  // C3 生成后用户要求执行核验闭环：逐条核验 requirementSemantics 要求落实，未满足项定向补写（单轮，失败即放弃）
  await stageRequirementVerification(session);
  await stageFinalGate(session);
  // P18 自动健康诊断：finalize 末尾纯读 telemetry 产出显性告警（零 LLM 成本），
  // 告警写回 telemetry.healthAlerts 随 reviewMetadata 归档（导出时进入 exportReports 历史对比存储）
  await stageHealthDiagnosis(session);
  const compactFinalChapterDrafts = session.finalChapterDrafts.map(chapter => ({ ...chapter, evidence: selectEvidenceByBudget(chapter.evidence || [], { preservePinned: true }) }));
  session.finalChapterDrafts = compactFinalChapterDrafts;

  return {
    templateId: session.template.id,
    templateName: session.template.name,
    title: session.template.outputTitle,
    requirement: requirement || '',
    projectRoot: session.projectRoot,
    projectId: session.projectId,
    exportSettings: session.template.exportSettings,
    generationSettings: session.template.generationSettings,
    facts: session.facts,
    structuredFacts: session.structuredFacts,
    factsModel: session.factsModel,
    chapters: compactFinalChapterDrafts,
    sources: session.sources,
    missingItems: [...new Set(session.missingItems)],
    validation: session.validation,
    validationIssues: session.validationIssues,
    exportGate: session.qualityBundle.finalExportGate,
    executionStages: session.finalStages,
    assets: session.assets,
    partialChapters: session.finalChapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, session.documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: compactFinalChapterDrafts,
    promptRules: session.promptDocumentRules,
    agentWorkflow: session.agentWorkflow,
    reviewMetadata: {
      chapterSummaries: [],
      globalIssues: [],
      diagnostics: session.generationDiagnostics,
      profile: buildDocumentProfileReport({ template: session.template, chapters: effectiveChapters, requirement }),
      knowledgeCoverage: session.qualityBundle.knowledgeCoverage,
      factTraces: session.qualityBundle.factTraces,
      chapterCoverage: session.qualityBundle.chapterCoverage,
      retrievalCoverage: session.retrievalCoverageReports,
      qualityReport: session.qualityBundle.qualityReport,
      repairStrategies: session.qualityBundle.repairStrategies,
      reviewChecklist: session.reviewChecklist,
      professionalScore: session.professionalScore,
      templatingReviewIssues: session.templatingReview.issues,
      writingTaskBrief: session.writingTaskBrief,
      workflowVersion: DOCUMENT_WORKFLOW_VERSION,
      telemetry: session.telemetry,
      qualityBenchmark: await benchmarkGeneratedMarkdown(session.finalMarkdown),
    },
    generatedAt: Date.now(),
    markdown: session.finalMarkdown,
  };
}


