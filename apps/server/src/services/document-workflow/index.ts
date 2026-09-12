// 显式导出清单（替代 export *）：依赖关系可见，同名冲突按 export * 语义保留先出现者。
// 新增导出需同步维护本清单。

export type { PromptRequiredSectionRule, PromptChapterStructuralRule, PromptDocumentRuleSet, WebAccessConfig, RuleExtractionTrace, RuntimePromptRuleSet, PlannedTableField, PlannedTablePlan, ChapterReadinessPlan, DocumentTemplateChapter, DocumentExportSettings, DocumentGenerationSettings, PromptBinding, ProjectBinding, DocumentTemplate, DocumentEvidence, ResourceEvidence, EvidenceBundle, DocumentDraftChapter, FactSourceRef, DocumentFact, StructuredTableFact, EvidenceFactIndex, ChapterFactNeed, ResolvedFactNeed, CanonicalFact, CanonicalFactConflict, CanonicalFactGap, NumericScopeConflict, CanonicalFactModel, DocumentFactsModel, TenderRequirementItem, TenderRequirementModel, ValidationIssue, ExportGateResult, DocumentExecutionStage, DocumentAsset, ChapterReviewSummary, DocumentGenerationStrategy, DocumentPerformanceMetric, DocumentGenerationDiagnostics, DocumentProfileReport, DocumentKnowledgeCoverageReport, DocumentFactTrace, ChapterCoverageReport, RetrievalCoverageReport, DocumentQualityReport, RepairStrategy, DocumentReviewChecklistItem, DocumentWorkflowVersion, DocumentTelemetryReport, DocumentReviewMetadata, GeneratedDocumentDraft, ProjectGraph, WritingTaskBrief, WritingTaskBriefChapter, BoqRowTrace } from './types';

export { readPromptContents, buildPromptBindingPlan, listDocumentTemplates, getDocumentTemplate, getTemplateAtVersion, saveDocumentTemplate, validateDocumentTemplateRun, validateDocumentTemplateRunCached, deleteDocumentTemplate, duplicateDocumentTemplate, violatesConfiguredChapterTitleForbiddenFilter, violatesConfiguredChapterTitleFilter, defaultProjectRoleConfigIdForTemplate, projectRoleConfigForTemplate, templatePromptBindings } from './templateStore';
export type { PromptExecutionCategory, ResolvedPromptContent, PromptBindingPlan } from './templateStore';

export { generateDocumentDraft } from './documentGenerator';

export { CAD_ENTITY_TOKEN_RE, FILE_NAME_RE, CN_NUMERAL_RE } from './constants';

export { readableSourceLabel, cleanEvidenceText, evidenceQualityScore, extractKeyFactLines, sanitizeEvidenceContent, extractKeyParameterWindows, uniqueEvidence, isExemptEvidenceSource, EvidenceClaimRegistry, dedupeChapterEvidence, dedupeGlobalEvidence, selectEvidenceByBudget, evidenceLine, buildEvidenceBundle, evidencePromptBudgetForTarget, evidencePromptImportance, buildEvidenceLayers, evidenceBundlePrompt, buildChapterEvidencePool, T0_WHITELIST_ENABLED } from './evidence';
export type { EvidenceClaimResult, EvidencePromptOptions, EvidenceLayerStats, EvidenceLayers } from './evidence';

export { isTenderClauseFragmentTitle, isLikelyMojibakeTitle, isInstructionLikeOutlineTitle, isFragmentLikeSectionTitle, normalizePlannedSectionTitle, hasExplicitOutlineBlock, isExplicitOutlineOpeningLine, isExplicitOutlineClosingLine, extractExplicitOutlineFromSources, displayChapterTitle, normalizeGeneratedChapterTitle, isValidGeneratedChapterTitle, formalChapterTitle, uniqueTemplateChapters, effectiveTemplateChapters } from './outline';

export { evidenceMatchesFact, specFactTargets, evidenceSatisfiesSpecField } from './factMatching';

export { removeUnwantedDrawingImages, WORKFLOW_PHRASE_RE, normalizeProductionText, normalizeTenderSourcePageRefs, hasInlineListCollision, normalizeInlineListBreaks, normalizeMarkdownTableDividers, stripMarkdownDocumentFence, SOURCE_ENUMERATION_PHRASE_RE, cleanFormalSourcePhrases, sourcePhraseIssues, sectionHeadingIssues, sectionDuplicateIssues, mergeTableLineBreaks, sanitizeFormalMarkdown, MARKDOWN_TABLE_FORMAT_RULES, TENDER_BID_WRITING_RULES, FORMAL_WRITING_RULES, SECTION_GENERATION_SAFETY_RULES, DOCUMENT_L0_COMMON_PREFIX, L0_WRITER_SYSTEM_PREFIX, writerSystemPrefix, docSystemPrefix, removeAdjacentDuplicateHeadings, dedupeCrossLevelHeadingDuplicates, dedupeRepeatedBlocksWithinSections, extractGeneratedSections, normalizeTertiaryHeadings, tertiaryHeadingIssues, inferChapterSectionsFromMarkdown, applyPromptDocumentRules, ensureFormalToc, findChapterBlock, plannedStructurePrompt, promptDocumentRuleIssues, plannedStructureIssues, finalizeDocumentMarkdown, composeDocumentMarkdown } from './markdownComposer';

export { WORK_PACKAGE_SECTION_RE, hasProcessSequenceExpression, normalizeSubsectionTitleForDedup, findDuplicateH4Titles, dedupeRepeatedSubsections, extractSection, comparableSectionTitleText, comparableSectionHeadingMatches, alignSectionHeadingsToPlan, stableHash, asStringArray, asObjectArray, safePlanId, stringifyFactValue, throwIfAborted, SYSTEM_CONSTRAINT_PREFIX, systemConstraintLine, BID_DISCIPLINE_PHRASES, isBidDisciplineSentence, adaptiveConcurrency, runWithAdaptiveConcurrency, Semaphore } from './utils';

export { stageTitle, stageRoleDisplayName, displayStage, upsertProgressStage, elapsedMessage } from './progress';

export { estimateDocumentPages, documentTextLength, charsPerPageForSettings, parseChineseNumber, explicitLengthTargets, chapterBudgetWeight, buildDocumentBudget, pageTargetIssues, documentBudgetIssues, documentBudgetStatus } from './budget';
export type { DocumentBudget, ExplicitLengthMode } from './budget';

export { extractFacts, extractStructuredTables, fieldExtractionPattern, extractStructuredFacts, extractLocalFactPool, sanitizeExtractedFacts, reliableFactForTarget, shouldRunLlmFactExtraction, extractFactsWithLlm, normalizedFactValue, detectFactConflicts, cleanPdfHeadingNoise, normalizeOcrFactText, isValidProjectBasicFactValue, extractProjectBasicFactsFromEvidence, extractPreciseFactsFromEvidence, buildSchemaFacts, buildChapterFactNeeds, resolveChapterFactNeeds, factsForChapterNeeds, factNeedsCoveragePrompt, buildFactsModel, extractBillItemFacts, buildSpecAuthorityMap } from './factsModel';
export type { FactSanitizeStats } from './factsModel';

export { isExportBlockingIssue, classifyQualitySeverity, qualitySeveritySummary, degenerateContentIssues, headingDuplicateIssues, evaluationCriteriaCoreKeywords, evaluationCriteriaCoverageIssues, internalTerminologyIssues, innovationTechCoverageIssues, buildExportGate, fallbackEvaluatorForRule, markdownTables, markdownImages, safeRegex, issueMessage, duplicateBasicInfoIssues, formalStyleIssues, minChapterSectionIssues, tocHierarchyIssues, tocBodyConsistencyIssues, instructionLikeHeadingIssues, formalContentIntegrityIssues, formalHeadingHierarchyIssues, markdownTableQualityIssues, tableSpamIssues, collectSectionContentGaps, sectionContentIntegrityIssues, crossChapterConsistencyIssues, processSpecConflictIssues, applyDeterministicConsistencyFixes, applyDeterministicConsistencyFixesToMarkdown, closedLoopDensityIssues, managementMeasureNumberIssues, genericProfessionalContentIssues, generatedFactVerificationIssues, generatedFactVerificationIssuesAsync, professionalScoreIssues, professionalContentIssues, preciseFactUsageIssues, boqPlacementIssues, drawingReferenceIssues, formalPlaceholderIssues, plannedAutoSpecGateIssues, autoSpecGateForbiddenTexts, autoSpecGateRequiredTexts, applySpecGateRules, promptExampleLeakIssues } from './qualityValidation';
export type { MarkdownSectionContentGap } from './qualityValidation';

export { concurrencyForDocumentScale, raiseDocumentLlmConcurrencyForScale, getDocumentLlmMaxConcurrency, isTransientLlmError, isContextOverflowLlmError, providerFactoryName, getActiveModelWithProvider, decideThinkingPolicy, contextLayerChars, llmPrefixFingerprint, sortScheduledLaunches, callDocumentLlm, extractJsonPayload, validateJsonAgainstSchema, describeJsonParseFailure, repairTruncatedJson, amplifiedTruncationMaxTokens, callDocumentLlmJsonWithRetry, callDocumentLlmJson, retryDelayMs, prefixScheduleWindowFor } from './llmClient';
export type { DocumentLlmTaskKind, ThinkingDecision, ContextLayerKey, DocumentJsonSchemaField, DocumentJsonSchema } from './llmClient';

export { selectDocumentGenerationStrategy, createGenerationDiagnostics, measureGenerationStep, blockingChapterIssues, repairableQualityIssue, lightweightChapterIssues, issuesForChapter, classifyQualityRepairType, repairTypeInstruction, repairChapterByQuality, fileScopeKeys, evidenceProjectPath, evidenceInCurrentProject, evidenceInScope, sanitizePromptForExecution, promptTextsForResolvedPrompts, promptTextsForExecution, promptOutlineTextsForExecution } from './rolePipeline';
export type { AnchorSpec, QualityRepairType } from './rolePipeline';

export { buildValidationIssues, buildChapterFactCoverageContext, extractUserRequirementFacts, userRequirementFactsPrompt, capFactCoverageContext, buildLlmChapterContent, sectionTargets, buildSectionBudgetInstruction, tokenizeForRelevance, evidenceForSection, normalizeFactUsageText, buildSectionFactCard, sectionFactUsageIssue, compactSectionProjectContext, compactScopedProjectContext, buildLlmSectionContent, sectionSupplementAttempts, buildQualifiedSectionSupplement, buildPlannedChapterContent } from './chapterGeneration';
export type { PlannedChapterContentInput, PlannedChapterContentResult } from './chapterGeneration';

export { sectionContentBody, currentSectionBlock, mergeDuplicateWorkPackageSubsections, dedupeQuantityFacts, filterConstructionSteps, parseMajorConstructionPackages, majorConstructionSkeletonNames, scopeEngineeringNames, workPackageSkeletonPrompt, workPackageSkeletonTitles, stripMarkdownTableBlocks, workPackageCrossSectionIssue, stripTablesInSection, missingWorkPackageSkeletonTitles, majorContentPollutionIssue, sectionStructureIssue, ensureTertiarySectionShell, ensureGroupTertiaryShell, groupHasMajorConstructionSection, isCriticalDeepSection, isGeneralManagementSection, keySectionWritingRequirement, criticalSectionBlockerMinChars, outputTokensForChapter, expansionRoundsForDeficit, acceptExpandedChapter } from './chapterPostProcessing';

export { chapterSectionFactUsageIssues, chunkTextForReview, reviewGlobalConsistency } from './chapterReview';

export { buildEvidenceOnlyChapterContent } from './chapterExpansion';


export { cleanSectionTitleArtifacts, professionalSectionTaskCard, isInvalidPlannedSectionTitle, sectionTitleEquivalent, buildRuntimePromptRules, runtimePromptRulesPrompt, extractPromptDocumentRules, extractPromptStructuralRules, normalizePlannedSections, minimumSectionCount, planChapterSectionsWithLlm, previewPromptRules, detectPromptRuleConflicts } from './promptRuleExtraction';
export type { PromptRulePreview, PlannedTableRequest } from './promptRuleExtraction';

export { evidenceDedupeIdentity, collectProjectBasicEvidence, searchWeightsForChapter, processingTypeWeightForChapter, chapterTextScore, semanticEvidenceText, optimizeChapterEvidence, preselectSemanticCandidates, compactChapterQueries, qualityFirstSearchQueryLimit, qualityFirstEvidenceItemLimit, retrieveSectionEvidence } from './helpers/evidenceRetrieval';
export { factsWithEvidenceSource, normalizeForCoverage, isCommercialSensitiveFactText, significantFactValue, factValueAppears, uncoveredImportantFacts, factCoverageIssues } from './helpers/factCoverage';
export { PROJECT_BASIC_FACT_QUERIES, projectBasicFactScore, projectBasicFactCandidates, projectBasicValueFor, repairKnownProjectBasicPlaceholders, cleanInlineFactValue, parseProjectBasicRowsFromMarkdown, markdownRowValue, projectBasicInfoRows, projectBasicInfoTableMarkdown, removeDuplicateProjectBasicInfoBlocks, normalizeProjectBasicInfoTable, projectBasicPlaceholderIssues } from './helpers/projectBasicInfo';
export { removeSystemInjectedBoilerplate, repairPlannedSectionBodies, repairTableOnlySections, isMarkdownTableSeparatorLine, looksLikeMarkdownTableLine, splitMarkdownTableLine, formatMarkdownTableLine, genericTableHeaders, normalizeBareMarkdownTables, stripProvenanceTableColumns, replaceForbiddenFormalPhrases, stripForbiddenPlaceholderSentences, stripAtlasReferencePhrases, stripBidDisciplineSentences, stripBidDisciplineSentencesSemantic, splitOverlongParagraphs, demoteNonFormalH2, filterResolvedFinalIssues, splitLongParagraphs, normalizeWorkPackageLabels, splitGluedTableHeaderLines, cleanChineseWordBreakSpaces, rewriteWorkPackageTerminology, stripTenderClauseFragmentHeadings, stripDataConsistencyLeakSentences, dedupeCrossSectionDuplicateSentences, finalizeChapterContentQuality, finalizeFinalMarkdownStructure, promptMatchesChapter, resolveChapterPromptExecution } from './helpers/markdownCleanup';
export { chapterGenerationTargets, validateDraft, chapterCompletionStatus, repairTargetWordsForSection, hasDepthWarningIssues, criticalSectionBlockerLine, anchorTitleForSection, partialChapterStatus, summarizeIssueList, kbIndexHealth, slowMetricSummary, callBreakdownTopSummary, phaseWaterfallDetails, callBreakdownTopDetails, resolveDocumentGenerationEvidenceLimit } from './helpers/diagnostics';
export type { EvidenceLimitProject } from './helpers/diagnostics';

export { finalizeGeneration } from './documentPipeline';
export { repairTableBlocksInMarkdownDeterministically } from './tableRepairHelpers';
export type { FinalizeGenerationInput } from './finalize/finalizeSession';

export { runAutomaticHealthDiagnosis, HEALTH_DIAGNOSIS_THRESHOLDS } from './automaticHealthDiagnosis';
export type { AutomaticHealthDiagnosisResult } from './automaticHealthDiagnosis';
export { analyzeDefectHeatmap, buildWritingConstraintsReminder, DEFECT_HEATMAP_WINDOW, DEFECT_HEATMAP_FAILURE_RATIO, WRITING_CONSTRAINTS_REMINDER_MAX_CHARS, REPAIR_ROUND_LABELS } from './defectHeatmap';
export type { RepairHeatCell, RepairHeatHistoryEntry, DefectHeatmapAnalysis } from './defectHeatmap';

export { materialKindLabel, inferMaterialKind, templateProjectBindings, expandProjectMaterialBindings, buildProjectMaterialProfile, buildProjectUnderstanding, projectUnderstandingPrompt, materialKindMaps, materialRoleId, materialProcessingType, retrievePlannedMaterialEvidence, sampleProjectMaterialEvidence } from './projectMaterialProfile';
export type { MaterialKind, MaterialFileProfile, ProjectMaterialProfile, ChapterMaterialPlan, ProjectUnderstanding } from './projectMaterialProfile';

export { resolveAgentMaterialScope, buildAgentMaterialSnapshot, buildBaseProjectGraph, createAgentWorkflowContext, throttleAgentWorkflowNodes, agentWorkflowStages, formalTextGateIssues } from './agentWorkflow';
export type { AgentMaterialScope, AgentMaterialSnapshotFile, AgentMaterialSnapshot, AgentWorkflowNodeStatus, AgentWorkflowNode, AgentWorkflowContext } from './agentWorkflow';

export { FORMAL_FORBIDDEN_PHRASES, planDocument, planChapterTask, chapterTaskPromptForPlannedStructure } from './agentPlanner';
export type { AgentSectionPlan, AgentChapterPlan, AgentDocumentPlan, AgentSectionTask, AgentChapterTask } from './agentPlanner';

export { appendFingerprintEntry, extractHeadingTitles, findFingerprintCollisions, loadFingerprintPool } from './sectionFingerprint';
export type { FingerprintCollision, SectionFingerprintEntry, SectionFingerprintPool } from './sectionFingerprint';
export { DIVERSITY_PLANNING_TEMPERATURE, NAMING_STYLES, ORGANIZATION_PERSPECTIVES, deriveDiversityProfile, loadDiversityHistory, recordDiversityUsage } from './diversityProfile';
export type { DiversityProfile } from './diversityProfile';

