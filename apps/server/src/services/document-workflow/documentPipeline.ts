import type { DocumentAsset, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, GeneratedDocumentDraft, RetrievalCoverageReport, ValidationIssue } from './types';
import { selectEvidenceByBudget } from './evidence';
import { validateDraftWithAutoSpec } from '../document-validation/documentValidationService';
import { validateProjectContamination } from '../document-validation/documentContaminationService';
import { chapterReadinessIssues, evaluateChapterReadiness } from '../document-validation/chapterReadinessService';
import { validateFactConsistency } from '../document-validation/factConsistencyService';
import { displayChapterTitle } from './outline';
import { composeDocumentMarkdown, plannedStructureIssues, promptDocumentRuleIssues, extractGeneratedSections, finalizeDocumentMarkdown, tertiaryHeadingIssues } from './markdownComposer';
import { documentBudgetIssues, documentBudgetStatus, documentTextLength, pageTargetIssues } from './budget';
import { applySpecGateRules, buildExportGate, collectSectionContentGaps, plannedAutoSpecGateIssues, duplicateBasicInfoIssues, formalContentIntegrityIssues, formalPlaceholderIssues, formalStyleIssues, isExportBlockingIssue, minChapterSectionIssues, preciseFactUsageIssues, qualitySeveritySummary, sectionContentIntegrityIssues, tocBodyConsistencyIssues, tocHierarchyIssues } from './qualityValidation';
import { buildPostRepairIssues, buildProfessionalRepairIssues } from './documentPostRepairChecks';
import { buildRepairTaskMessage, collectMessageGroups, collectValidationIssueGroups, dedupeValidationIssues, repairIssueSignature, unresolvedRepairTasks } from './documentQualityPipeline';
import { buildStandardFinalValidationIssues } from './documentFinalValidation';
import { buildDocumentProfileReport } from './documentProfiles';
import { buildKnowledgeCoverageReport, knowledgeCoverageIssues } from './documentKnowledgeCoverage';
import { buildDocumentFactTraces, factTraceIssues } from './documentFactTrace';
import { buildChapterCoverageReports, chapterCoverageIssues } from './documentChapterCoverage';
import { buildDocumentQualityReport, qualityReportIssues } from './documentQualityReport';
import { buildRepairStrategies, repairStrategyIssues } from './documentRepairStrategies';
import { buildDocumentReviewChecklist } from './documentReviewChecklist';
import { DOCUMENT_WORKFLOW_VERSION } from './documentWorkflowVersion';
import { buildDocumentTelemetryReport } from './documentTelemetry';
import { retrievalCoverageIssues } from './documentEvidenceRetrieval';
import { extractFacts, extractFactsWithLlm, extractPreciseFactsFromEvidence, extractProjectBasicFactsFromEvidence, extractStructuredFacts, extractStructuredTables, buildFactsModel, shouldRunLlmFactExtraction } from './factsModel';
import { buildCanonicalFacts } from './factGovernance';
import { stringifyFactValue, throwIfAborted } from './utils';
import { displayStage, elapsedMessage, upsertProgressStage } from './progress';
import { callWithTimeout } from './llmClient';
import { lightweightChapterIssues, measureGenerationStep, repairChapterByQuality, repairMarkdownByQuality } from './rolePipeline';
import { buildValidationIssues, chapterSectionFactUsageIssues, expandDocumentToBudget, reviewAndOptimizeMarkdown, reviewChapterSummaries, reviewGlobalConsistency, supplementShortSections, understandReferenceFiles } from './chapterGeneration';
import { appendMissingFactPatchesToChapters, applyDeterministicGateRepairs, appendDeterministicBudgetClosing, appendDeterministicSectionClosings, demoteNonFormalH2, factCoverageIssues, factsWithSourceFallback, filterResolvedFinalIssues, finalizeChapterContentQuality, isMaterialDiagnosticNoise, normalizeProjectBasicInfoTable, partialChapterStatus, projectBasicPlaceholderIssues, repairKnownProjectBasicPlaceholders, replaceForbiddenFormalPhrases, shouldUseIssueForDefaultRepair, slowMetricSummary, validateDraft } from './documentGeneratorHelpers';

export async function finalizeGeneration(p: {
  chapterDrafts: DocumentDraftChapter[];
  chapterDraftsByOrder: Array<DocumentDraftChapter | undefined>;
  chapterGenerationStagesByOrder: Array<DocumentExecutionStage | undefined>;
  chapterGenerationStages: DocumentExecutionStage[];
  effectiveChapters: DocumentTemplateChapter[];
  template: DocumentTemplate; allEvidence: DocumentEvidence[];
  progressStages: DocumentExecutionStage[];
  documentSpec: any; projectMaterialProfile: any; projectMaterialSummary: any; domainProfile: any;
  documentBudget: any; promptTexts: string; reviewPromptTexts: string;
  input: { requirement?: string; signal?: AbortSignal; onProgress?: any };
  generationStrategy: any; generationDiagnostics: DocumentGenerationDiagnostics;
  promptBindings: any[]; promptDocumentRules: any;
  projectUnderstanding: any; projectContext: string; projectRoot: string; projectId: string; readiness: any;
  factExtractionPromptTexts: string;
  hasExplicitOutline: boolean; missingItems: string[];
  retrievalCoverageReports: RetrievalCoverageReport[];
  failedChapterMessages: string[];
  webResearchReport: { enabled: boolean; queries: string[]; evidenceCount: number; filteredCount: number; chapters: string[] };
  indexHealth: any; promptPlan: any;
  emitProgress: (c?: DocumentDraftChapter[], s?: DocumentExecutionStage[]) => void;
  withProgressHeartbeat: <T>(w: () => Promise<T>, s?: DocumentExecutionStage[]) => Promise<T>;
}): Promise<GeneratedDocumentDraft> {
  let chapterDrafts = p.chapterDrafts;
  const { chapterDraftsByOrder, chapterGenerationStagesByOrder,
    chapterGenerationStages, effectiveChapters, template, allEvidence,
    progressStages,
    documentSpec, projectMaterialProfile: _projectMaterialProfile, projectMaterialSummary,
    domainProfile, documentBudget, promptTexts, reviewPromptTexts,
    input, generationStrategy, generationDiagnostics,
    promptBindings, promptDocumentRules,
    projectUnderstanding, projectContext, projectRoot, projectId, readiness,
    factExtractionPromptTexts,
    hasExplicitOutline, missingItems, retrievalCoverageReports,
    failedChapterMessages, webResearchReport, indexHealth, promptPlan: _promptPlan,
    emitProgress, withProgressHeartbeat,
  } = p;
  const { signal, requirement } = input;

  chapterDrafts = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
  chapterGenerationStages.push(...chapterGenerationStagesByOrder.filter((item): item is DocumentExecutionStage => Boolean(item)));
  const generatedChapterEvidence = chapterDrafts.flatMap(chapter => chapter.evidence || []);
  if (generatedChapterEvidence.length > 0) {
    allEvidence.push(...generatedChapterEvidence);
    const compactGeneratedEvidence = selectEvidenceByBudget(allEvidence, { maxChars: Math.max(50000, effectiveChapters.length * 9000), preservePinned: true });
    allEvidence.splice(0, allEvidence.length, ...compactGeneratedEvidence);
  }

  if (chapterDrafts.length === 0) {
    throw new Error(`章节生成未完成：${failedChapterMessages.join('；') || '没有生成任何有效章节'}`);
  }
  if (hasExplicitOutline && chapterDrafts.length < effectiveChapters.length) {
    throw new Error(`OUTLINE 指定 ${effectiveChapters.length} 章，实际只生成 ${chapterDrafts.length} 章：${failedChapterMessages.join('；') || '部分章节未生成'}`);
  }

  throwIfAborted(signal);
  upsertProgressStage(progressStages, displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'running', message: '正在理解多模态参考文件' }, { subtitle: '多模态参考文件' }));
  emitProgress(chapterDrafts);
  let fileUnderstanding: { stage: DocumentExecutionStage; notes: string[] } = { stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '文件理解跳过' }, notes: [] };
  try { fileUnderstanding = await understandReferenceFiles(projectRoot, allEvidence, signal); } catch (err) { if (signal?.aborted) throw err; console.error('[gen] fileUnderstanding failed:', err); }
  upsertProgressStage(progressStages, fileUnderstanding.stage);
  emitProgress(chapterDrafts);
  throwIfAborted(signal);
  for (const note of fileUnderstanding.notes) {
    allEvidence.push({
      chapterId: 'multimodal-file-understanding',
      filePath: '多模态模型文件理解结果',
      score: 1,
      content: note,
      roleId: 'multimodal-files',
      processingType: 'reference',
      source: 'multimodal',
    });
  }
  const compactPostFileEvidence = selectEvidenceByBudget(allEvidence, { maxItems: Math.max(48, effectiveChapters.length * 10), maxChars: Math.max(52000, effectiveChapters.length * 9000), preservePinned: true });
  allEvidence.splice(0, allEvidence.length, ...compactPostFileEvidence);

  const facts = extractFacts(template, allEvidence, documentSpec);
  const localFacts = extractStructuredFacts(allEvidence, template, documentSpec);
  const projectBasicFacts = extractProjectBasicFactsFromEvidence(allEvidence);
  const preciseFacts = extractPreciseFactsFromEvidence(allEvidence, domainProfile);
  const roleStructuredFacts: DocumentFact[] = [];
  const preLlmFacts = [...roleStructuredFacts, ...localFacts, ...projectBasicFacts, ...preciseFacts];
  let llmExtraction: { facts: DocumentFact[]; stages: DocumentExecutionStage[] } = { facts: [], stages: [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: '已有本地/资料事实覆盖主要必需字段，跳过 LLM 全量事实抽取' }] };
  if (shouldRunLlmFactExtraction(preLlmFacts, template, documentSpec)) {
    const factExtractionEvidence = selectEvidenceByBudget(allEvidence, { maxItems: 48, maxChars: 45000, preservePinned: true });
    try { llmExtraction = await extractFactsWithLlm(factExtractionEvidence, factExtractionPromptTexts, template, documentSpec, signal); } catch (err) { if (signal?.aborted) throw err; console.error('[gen] fact extraction failed:', err); }
  }
  throwIfAborted(signal);
  const structuredFacts = factsWithSourceFallback([...roleStructuredFacts, ...localFacts, ...projectBasicFacts, ...preciseFacts, ...llmExtraction.facts], allEvidence);

  // 进度回调：文件理解 + 事实抽取完成
  upsertProgressStage(progressStages, fileUnderstanding.stage);
  for (const stage of llmExtraction.stages) {
    upsertProgressStage(progressStages, stage);
  }
  emitProgress();
  const structuredTables = extractStructuredTables(allEvidence);
  const pinnedEvidenceCount = allEvidence.filter(item => item.source === 'pinned-evidence').length;
  const autoEvidenceCount = allEvidence.filter(item => item.source !== 'pinned-evidence' && item.source !== 'bound-file').length;
  const enhancementStage: DocumentExecutionStage = displayStage({
    type: 'reference',
    roleId: 'quality-enhancement',
    status: allEvidence.length > 0 ? 'success' : 'skipped',
    message: `增强贡献：知识库证据 ${allEvidence.length} 条，人工确认/固定证据 ${pinnedEvidenceCount} 条，自动检索证据 ${autoEvidenceCount} 条`,
  }, { subtitle: '证据与上下文增强' });
  progressStages.push(enhancementStage);
  emitProgress();
  for (const fact of structuredFacts) facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;
  const sourceCounts = new Map<string, number>();
  for (const item of allEvidence) sourceCounts.set(item.filePath, (sourceCounts.get(item.filePath) ?? 0) + 1);
  const evidenceSourceCounts = new Map<string, number>();
  for (const item of allEvidence) evidenceSourceCounts.set(item.source || 'unknown', (evidenceSourceCounts.get(item.source || 'unknown') ?? 0) + 1);
  const sources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).map(([filePath, count]) => ({ filePath, count }));
  const factsModel = buildFactsModel(structuredFacts, structuredTables, missingItems, documentSpec, domainProfile);
  const chapterReadiness = evaluateChapterReadiness(chapterDrafts, documentSpec);
  const validation = validateDraft(chapterDrafts, structuredFacts, template);
  validation.warnings = [...validation.warnings, ...readiness.warnings];
  validation.errors = [...validation.errors, ...readiness.blockingIssues];
  let validationIssues = collectValidationIssueGroups(
    buildValidationIssues(validation, factsModel, chapterDrafts),
    chapterReadinessIssues(chapterReadiness),
  );
  const forbidDrawingImages = false;
  const budgetStartedAt = Date.now();
  const budgetBeforeChars = documentTextLength(chapterDrafts.map(chapter => chapter.content).join('\n\n'));
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-budget',
    status: 'running',
    message: `正在进行全文预算校准：当前 ${budgetBeforeChars} 字`,
    details: [`章节数：${chapterDrafts.length}`, `目标：${documentBudget.targetChars || documentBudget.targetPages || '按章节深度'}`],
    progress: { current: 1, total: 2, label: '预算校准' },
  }, { subtitle: '文档预算' }));
  emitProgress(chapterDrafts);
  const budgetExpandedChapters = generationStrategy.enableDocumentBudgetExpansion
    ? await withProgressHeartbeat(() => expandDocumentToBudget({
      template,
      chapters: chapterDrafts,
      budget: documentBudget,
      promptTexts,
      requirement: requirement,
      forbidDrawingImages,
      signal: signal,
      onRoundProgress: (chapters, context) => {
        chapterDrafts.splice(0, chapterDrafts.length, ...chapters);
        upsertProgressStage(progressStages, displayStage({
          type: 'validation',
          roleId: 'document-budget',
          status: 'running',
          message: `正在进行全文预算校准：第 ${context.round}/${context.maxRounds} 轮，当前 ${context.totalChars} 字，新增 ${context.addedChars} 字`,
          details: [`章节数：${chapters.length}`, `目标：${documentBudget.targetChars || documentBudget.targetPages || '按章节深度'}`],
          progress: { current: Math.min(context.round + 1, context.maxRounds), total: context.maxRounds + 1, label: '预算校准' },
        }, { subtitle: '文档预算' }));
        emitProgress(chapterDrafts);
      },
    }))
    : chapterDrafts;
  chapterDrafts.splice(0, chapterDrafts.length, ...budgetExpandedChapters);
  const budgetDraftMarkdown = chapterDrafts.map(chapter => chapter.content).join('\n\n');
  const factPatch = appendMissingFactPatchesToChapters(chapterDrafts, structuredFacts, budgetDraftMarkdown);
  if (factPatch.patchedCount > 0) {
    chapterDrafts.splice(0, chapterDrafts.length, ...factPatch.chapters);
    validationIssues = [...validationIssues, { level: 'info', message: `已自动补写未落位事实 ${factPatch.patchedCount} 项`, suggestion: '补写仅使用本项目资料明确事实，未补写商务敏感信息或系统暂未确认内容。' }];
  }
  const budgetStatus = documentBudgetStatus(documentBudget, chapterDrafts.map(chapter => chapter.content).join('\n\n'));
  const budgetTargetText = [
    documentBudget.targetChars ? `目标 ${documentBudget.targetChars} 字${documentBudget.minChars || documentBudget.maxChars ? `（区间 ${documentBudget.minChars || 0}-${documentBudget.maxChars || '∞'} 字）` : ''}` : undefined,
    documentBudget.targetPages ? `目标 ${documentBudget.targetPages} 页${documentBudget.minPages || documentBudget.maxPages ? `（区间 ${documentBudget.minPages || 0}-${documentBudget.maxPages || '∞'} 页）` : ''}` : undefined,
  ].filter(Boolean).join(' / ') || '默认章节深度';
  const budgetOverLimit = Boolean(documentBudget.maxChars && budgetStatus.currentChars > documentBudget.maxChars);
  const budgetStage = displayStage({ type: 'validation', roleId: 'document-budget', status: budgetOverLimit || (documentBudget.minChars && budgetStatus.currentChars < documentBudget.minChars) ? 'fallback' : 'success', message: elapsedMessage(`文档预算：当前 ${budgetStatus.currentChars} 字，新增 ${Math.max(0, budgetStatus.currentChars - budgetBeforeChars)} 字，预计 ${budgetStatus.estimatedPages} 页；${budgetTargetText}`, budgetStartedAt) }, { subtitle: '文档预算' });
  upsertProgressStage(progressStages, budgetStage);
  emitProgress(chapterDrafts);
  const fallbackChapterCount = chapterGenerationStages.filter(stage => stage.type === 'chapter_generation' && stage.status === 'fallback').length;
  const missingChapterCount = Math.max(0, effectiveChapters.length - chapterDrafts.length);
  const generationStatusIssues: ValidationIssue[] = [
    ...(fallbackChapterCount > 0 ? [{ level: 'info' as const, message: `章节生成存在补充完善：${fallbackChapterCount} 章`, suggestion: '已保留章节成果；如需更高质量可复核对应章节，但不阻断导出。' }] : []),
    ...(missingChapterCount > 0 ? [{ level: 'error' as const, message: `部分章节生成失败：${missingChapterCount} 章`, suggestion: failedChapterMessages.join('；') || '请检查模型调用、知识库检索和事实抽取配置后重新生成失败章节。' }] : []),
  ];
  const chapterFactUsageValidationIssues = chapterDrafts.flatMap(chapter => {
    const templateChapter = effectiveChapters.find(item => item.id === chapter.id);
    if (!templateChapter) return [];
    const factUsageIssues = chapterSectionFactUsageIssues({ chapter: templateChapter, content: chapter.content, evidence: chapter.evidence || [] });
    return factUsageIssues.length > 0 ? [{ level: 'warning' as const, message: `${displayChapterTitle(chapter.title)} 小节知识库事实或量化参数落位可继续优化：${factUsageIssues.slice(0, 5).join('；')}`, suggestion: '建议扩大本地知识库检索并定向补写对应小节，优先使用清单、图纸、招标要求中的原始事实、规格、数量、标准和工期参数。' }] : [];
  });
  validationIssues = collectValidationIssueGroups(validationIssues, generationStatusIssues, chapterFactUsageValidationIssues);
  const initialBlockingCount = validationIssues.filter(issue => issue.level === 'error' && isExportBlockingIssue(issue)).length;
  const assets: DocumentAsset[] = [];
  const executionStages: DocumentExecutionStage[] = [...progressStages];
  upsertProgressStage(executionStages, displayStage({
    type: 'reference',
    roleId: 'knowledge-usage-report',
    status: 'success',
    message: `资料使用报告：证据 ${allEvidence.length} 条，来源文件 ${sources.length} 份，结构化事实 ${structuredFacts.length} 条`,
    details: [
      `证据类型：${[...evidenceSourceCounts.entries()].map(([name, count]) => `${name} ${count}`).join('，') || '无'}`,
      `索引健康：可用切片 ${indexHealth.usableChunkCount} 条，待索引 ${indexHealth.pendingJobs} 个，向量 ${indexHealth.vectorStatus?.status || 'unknown'}`,
      factPatch.patchedCount > 0 ? `自动补写事实：${factPatch.patchedCount}/${factPatch.missingCount}` : `事实落位补写：0/${factPatch.missingCount}`,
    ],
  }, { subtitle: '资料使用报告' }));
  upsertProgressStage(executionStages, displayStage({
    type: 'reference',
    roleId: 'web-research-report',
    status: webResearchReport.enabled ? 'success' : 'skipped',
    message: webResearchReport.enabled ? `联网增强：检索章节 ${new Set(webResearchReport.chapters).size} 个，查询 ${webResearchReport.queries.length} 个，使用公开资料 ${webResearchReport.evidenceCount} 条` : '联网增强未开启',
    details: webResearchReport.enabled ? [
      `检索主题：${[...new Set(webResearchReport.queries)].join('；') || '无'}`,
      `过滤结果：${webResearchReport.filteredCount} 条`,
      '公开资料仅用于通用规范、政策、工艺和措施补充，不作为项目事实来源',
    ] : ['可在模型配置中开启联网增强'],
  }, { subtitle: '联网增强报告' }));
  upsertProgressStage(executionStages, displayStage({ type: 'validation', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'failed' : 'success', message: `阻断 ${initialBlockingCount}，错误 ${validation.errors.length}，警告 ${validation.warnings.length}` }, { subtitle: '最终规范校验' }));
  upsertProgressStage(executionStages, displayStage({ type: 'formatting', roleId: 'document-workflow', status: 'success', message: '已生成正式排版 Markdown' }));
  upsertProgressStage(executionStages, displayStage({ type: 'export_ready', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'failed' : 'success', message: initialBlockingCount > 0 ? '导出门禁未通过，请完成阻断问题修复后再导出' : '已准备好导出 Markdown/HTML/DOCX/PDF' }));
  const base = {
    templateId: template.id,
    templateName: template.name,
    title: template.outputTitle,
    requirement: requirement || '',
    projectRoot,
    projectId,
    exportSettings: template.exportSettings,
    generationSettings: template.generationSettings,
    facts,
    structuredFacts,
    factsModel,
    chapters: chapterDrafts,
    sources,
    missingItems: [...new Set(missingItems)],
    validation,
    validationIssues,
    executionStages,
    exportGate: { passed: initialBlockingCount === 0, blockingIssues: validationIssues.filter(issue => issue.level === 'error' && isExportBlockingIssue(issue)), checklist: [] },
    assets,
    partialChapters: chapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: chapterDrafts,
    generatedAt: Date.now(),
  };
  let initialMarkdown = composeDocumentMarkdown(base, { forbidDrawingImages, promptRules: promptDocumentRules });
  if (process.env.DOCUMENT_ENABLE_POST_EXPORT_REVIEW !== '1') {
    const finalizedDocument = finalizeDocumentMarkdown(initialMarkdown, chapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules });
    let finalChapterDrafts = finalizedDocument.chapters.map(chapter => {
      const templateChapter = effectiveChapters.find(item => item.id === chapter.id) || chapter;
      return { ...chapter, content: finalizeChapterContentQuality(chapter.content, templateChapter) };
    });
    let finalMarkdown = '';
    const collectDefaultFinalIssues = (markdown: string, chapters: DocumentDraftChapter[]) => collectValidationIssueGroups(
      validationIssues.filter(issue => !isMaterialDiagnosticNoise(issue) && issue.level !== 'error' && !/目录与正文不一致|表格分隔线位置不规范|正文存在过长段落|正文存在非正式章二级标题|正文残留资料页码|小节只有标题或表格无正文/u.test(issue.message)),
      validateDraftWithAutoSpec({ markdown, spec: documentSpec, summary: projectMaterialSummary }),
      validateFactConsistency({ markdown, facts: structuredFacts, summary: projectMaterialSummary, profile: domainProfile }),
      validateProjectContamination(markdown, projectMaterialSummary),
      projectBasicPlaceholderIssues(markdown, structuredFacts),
      buildStandardFinalValidationIssues({ markdown, chapters, factsModel, template, promptBindings, promptDocumentRules }),
      pageTargetIssues(template.generationSettings || template.exportSettings, markdown).filter(issue => !(documentBudget.minPages && /低于目标页数/u.test(issue.message))),
      documentBudgetIssues(documentBudget, markdown),
    );
    let finalIssues: ValidationIssue[] = [];
    const rebuildDefaultFinalState = () => {
      finalMarkdown = normalizeProjectBasicInfoTable(repairKnownProjectBasicPlaceholders(replaceForbiddenFormalPhrases(finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: finalChapterDrafts }, { forbidDrawingImages, promptRules: promptDocumentRules }), finalChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules }).markdown), structuredFacts), structuredFacts);
      finalIssues = dedupeValidationIssues(collectDefaultFinalIssues(finalMarkdown, finalChapterDrafts));
      finalMarkdown = demoteNonFormalH2(applyDeterministicGateRepairs(finalMarkdown, finalIssues));
      finalIssues = dedupeValidationIssues(collectDefaultFinalIssues(finalMarkdown, finalChapterDrafts));
      finalMarkdown = appendDeterministicSectionClosings(finalMarkdown, finalIssues);
      finalIssues = dedupeValidationIssues(collectDefaultFinalIssues(finalMarkdown, finalChapterDrafts));
      finalMarkdown = appendDeterministicBudgetClosing(finalMarkdown, documentBudget.minChars);
      finalIssues = filterResolvedFinalIssues(finalMarkdown, dedupeValidationIssues(collectDefaultFinalIssues(finalMarkdown, finalChapterDrafts)));
    };
    const applyDefaultRepairChapters = (chapters: DocumentDraftChapter[]) => {
      finalChapterDrafts = chapters.map(chapter => {
        const templateChapter = effectiveChapters.find(item => item.id === chapter.id) || chapter;
        return { ...chapter, sections: chapter.sections || [], content: finalizeChapterContentQuality(chapter.content, templateChapter) };
      });
      rebuildDefaultFinalState();
    };
    const buildDefaultRepairIssues = () => finalIssues
      .filter(shouldUseIssueForDefaultRepair)
      .map(issue => buildRepairTaskMessage(issue))
      .slice(0, 24);
    const runDefaultBudgetRepair = async (roleId: string, subtitle: string) => {
      if (!documentBudget.minChars || !generationStrategy.enableDocumentBudgetExpansion || documentTextLength(finalMarkdown) >= documentBudget.minChars || (documentBudget.maxChars && documentTextLength(finalMarkdown) >= documentBudget.maxChars)) return false;
      const beforeChars = documentTextLength(finalMarkdown);
      finalChapterDrafts = (await withProgressHeartbeat(() => expandDocumentToBudget({
        template,
        chapters: finalChapterDrafts,
        budget: documentBudget,
        promptTexts,
        requirement: requirement,
        forbidDrawingImages,
        signal: signal,
        onRoundProgress: (chapters, context) => {
          finalChapterDrafts = chapters.map(chapter => ({ ...chapter, sections: chapter.sections || [] }));
          upsertProgressStage(executionStages, displayStage({
            type: 'validation',
            roleId,
            status: 'running',
            message: `${subtitle}：第 ${context.round}/${context.maxRounds} 轮，当前 ${context.totalChars} 字，新增 ${context.addedChars} 字`,
          }, { subtitle }));
          emitProgress(finalChapterDrafts, executionStages);
        },
      }), executionStages))
        .map(chapter => ({ ...chapter, sections: chapter.sections || [] }));
      rebuildDefaultFinalState();
      const afterChars = documentTextLength(finalMarkdown);
      executionStages.push(displayStage({ type: 'validation', roleId, status: afterChars < documentBudget.minChars ? 'fallback' : 'success', message: `${subtitle}：当前 ${afterChars} 字，新增 ${Math.max(0, afterChars - beforeChars)} 字，目标下限 ${documentBudget.minChars} 字` }, { subtitle }));
      return afterChars > beforeChars;
    };
    const defaultRepairStages: DocumentExecutionStage[] = [];
    rebuildDefaultFinalState();
    for (let round = 0; round < 5; round += 1) {
      throwIfAborted(signal);
      const budgetGrew = await runDefaultBudgetRepair(`default-budget-repair-${round + 1}`, round === 0 ? '默认路径预算补齐' : '默认路径预算再补齐');
      if (budgetGrew) continue;
      const defaultRepairIssues = buildDefaultRepairIssues();
      const onlyBudgetGap = defaultRepairIssues.length > 0 && defaultRepairIssues.every(issue => /正文篇幅低于目标字数|正文长度低于提示词要求/u.test(issue));
      if (defaultRepairIssues.length === 0 || onlyBudgetGap) break;
      const repair = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'default-path-quality-repair', () => repairMarkdownByQuality({ markdown: finalMarkdown, template, chapters: finalChapterDrafts, promptTexts, requirement: requirement, issues: defaultRepairIssues, forbidDrawingImages, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: signal }), { issues: defaultRepairIssues.length, round: round + 1 }), executionStages);
      if (repair.stage) defaultRepairStages.push({ ...repair.stage, message: `${repair.stage.message || '默认路径质量修复完成'}；第 ${round + 1} 轮，触发问题 ${defaultRepairIssues.length} 个` });
      if (repair.chapters === finalChapterDrafts) break;
      applyDefaultRepairChapters(repair.chapters);
      const unresolvedTasks = unresolvedRepairTasks(defaultRepairIssues, finalIssues).slice(0, 8);
      if (unresolvedTasks.length === 0) continue;
      const escalation = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'default-path-quality-repair-escalation', () => repairMarkdownByQuality({ markdown: finalMarkdown, template, chapters: finalChapterDrafts, promptTexts, requirement: requirement, issues: unresolvedTasks, forbidDrawingImages, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: signal }), { issues: unresolvedTasks.length, round: round + 1 }), executionStages);
      if (escalation.chapters !== finalChapterDrafts) applyDefaultRepairChapters(escalation.chapters);
      defaultRepairStages.push(displayStage({ type: 'llm_review', roleId: `default-repair-verify-${round + 1}`, status: finalIssues.some(issue => unresolvedTasks.some(task => repairIssueSignature(task) === repairIssueSignature(issue))) ? 'fallback' : 'success', message: `修复后验证闭环完成：第 ${round + 1} 轮升级修复 ${unresolvedTasks.length} 个残留问题`, details: unresolvedTasks }, { subtitle: '修复后验证' }));
    }
    rebuildDefaultFinalState();
    const finalExportGate = buildExportGate(finalIssues, factsModel, finalChapterDrafts);
    const stagedExecution = [...executionStages, ...defaultRepairStages];
    const finalStages = stagedExecution.map(stage => {
      if (stage.type === 'validation' && stage.roleId === 'document-workflow') return { ...stage, status: finalExportGate.blockingIssues.length > 0 ? 'failed' as const : 'success' as const, message: `阻断 ${finalExportGate.blockingIssues.length}，问题 ${finalIssues.length}` };
      if (stage.type === 'export_ready') return { ...stage, status: finalExportGate.passed ? 'success' as const : 'failed' as const, message: finalExportGate.passed ? '已准备好导出 Markdown/HTML/DOCX/PDF' : '导出门禁未通过，请完成阻断问题修复后再导出' };
      return stage;
    });
    finalStages.push(displayStage({ type: 'llm_review', roleId: 'post-export-review', status: 'skipped', message: '已跳过导出后的重型 LLM 复审；默认路径已执行本地硬规则校验与必要的精准局部修复；如需开启重型复审请设置 DOCUMENT_ENABLE_POST_EXPORT_REVIEW=1' }, { subtitle: '导出后复审' }));
    const compactFinalChapterDrafts = finalChapterDrafts.map(chapter => ({
      ...chapter,
      evidence: selectEvidenceByBudget(chapter.evidence || [], { maxItems: 12, maxChars: 9000, preservePinned: true }),
    }));
    return {
      ...base,
      chapters: compactFinalChapterDrafts,
      validationIssues: finalIssues,
      exportGate: finalExportGate,
      executionStages: finalStages,
      partialChapters: finalChapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
      checkpointChapters: compactFinalChapterDrafts,
      reviewMetadata: { chapterSummaries: [], globalIssues: [], diagnostics: generationDiagnostics },
      markdown: finalMarkdown,
    };
  }
  throwIfAborted(signal);
  const localChapterReviewSummaries = chapterDrafts.map(chapter => {
    const templateChapter = effectiveChapters.find(item => item.id === chapter.id) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections };
    const issues = lightweightChapterIssues({ chapter: templateChapter, content: chapter.content, missingFacts: chapter.missingFacts, targetWords: documentBudget.chapterTargets.get(chapter.id) || 1200 });
    const blocking = issues.some(issue => /缺少|空小节|只有标题|只有表格|正文篇幅明显低于目标|后台流程话术|占位|requiredFacts/u.test(issue));
    return { chapterId: chapter.id, title: chapter.title, status: blocking ? 'fail' as const : issues.length > 0 ? 'warn' as const : 'pass' as const, issues, suggestions: [], chars: documentTextLength(chapter.content) };
  });
  const chapterReviewRiskCount = localChapterReviewSummaries.filter(summary => summary.status !== 'pass').length;
  const shouldChapterReview = generationStrategy.enableChapterReview && chapterReviewRiskCount > 0;
  if (shouldChapterReview) {
    upsertProgressStage(executionStages, displayStage({
      type: 'llm_review',
      roleId: 'chapter-review',
      status: 'running',
      message: `正在进行章节级质量审查：${chapterReviewRiskCount}/${chapterDrafts.length} 章存在本地风险`,
      details: ['仅对本地扫描发现风险的生成结果触发 LLM 审查，按风险章节自然并行'],
      progress: { current: 1, total: 3, label: '章节审查' },
    }, { subtitle: '章节级质量审查' }));
    emitProgress(chapterDrafts, executionStages);
  }
  const chapterReview = shouldChapterReview
    ? await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'chapter-review', () => reviewChapterSummaries({ template, chapters: chapterDrafts, budget: documentBudget, promptTexts: reviewPromptTexts || promptTexts, requirement: requirement, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: signal }), { chapters: chapterDrafts.length }), executionStages)
    : { summaries: localChapterReviewSummaries, stage: displayStage({ type: 'llm_review' as const, roleId: 'chapter-review', status: 'skipped', message: generationStrategy.enableChapterReview ? '本地章节扫描未发现需要 LLM 章节审查的问题，已跳过' : '当前策略未启用章节级 LLM 审查' }, { subtitle: '章节级质量审查' }) };
  executionStages.push(chapterReview.stage);
  let chapterReviewSummaries = chapterReview.summaries;
  const chapterRepairTargets = chapterReviewSummaries.filter(summary => summary.status !== 'pass' && summary.issues.length > 0);
  if (chapterRepairTargets.length > 0) {
    upsertProgressStage(executionStages, displayStage({
      type: 'llm_review',
      roleId: 'chapter-review-repair',
      status: 'running',
      message: `正在按章节审查结果就地修复：${chapterRepairTargets.length} 章`,
      details: chapterRepairTargets.map(summary => `${summary.title}：${summary.issues.slice(0, 5).join('；')}`),
      progress: { current: 1, total: chapterRepairTargets.length, label: '章节就地修复' },
    }, { subtitle: '章节就地修复' }));
    emitProgress(chapterDrafts, executionStages);
    const repairedById = new Map<string, string>();
    let patchCount = 0;
    const repairConcurrency = Math.max(1, chapterRepairTargets.length || 1);
    for (let offset = 0; offset < chapterRepairTargets.length; offset += repairConcurrency) {
      throwIfAborted(signal);
      const batch = chapterRepairTargets.slice(offset, offset + repairConcurrency);
      const results = await Promise.all(batch.map(async summary => {
        const chapter = chapterDrafts.find(item => item.id === summary.chapterId);
        if (!chapter) return { chapterId: summary.chapterId, content: undefined as string | undefined, appliedCount: 0 };
        try {
          const result = await callWithTimeout(
            signal => repairChapterByQuality({ template, chapter, issues: summary.issues.slice(0, 4), promptTexts: reviewPromptTexts || promptTexts, requirement: requirement, forbidDrawingImages, diagnostics: generationDiagnostics, signal }),
            90000,
            signal,
          );
          return { chapterId: summary.chapterId, content: result?.content, appliedCount: result?.appliedCount || 0 };
        } catch {
          return { chapterId: summary.chapterId, content: undefined as string | undefined, appliedCount: 0 };
        }
      }));
      for (const result of results) {
        if (result.content) repairedById.set(result.chapterId, result.content);
        patchCount += result.appliedCount;
      }
    }
    let repairedCount = 0;
    const repairedChapterIds = new Set<string>();
    for (let index = 0; index < chapterDrafts.length; index += 1) {
      const content = repairedById.get(chapterDrafts[index].id);
      if (content && content !== chapterDrafts[index].content) {
        chapterDrafts[index] = { ...chapterDrafts[index], content };
        repairedChapterIds.add(chapterDrafts[index].id);
        repairedCount += 1;
      }
    }
    if (repairedCount > 0) {
      chapterReviewSummaries = chapterReviewSummaries.map(summary => repairedChapterIds.has(summary.chapterId)
        ? { ...summary, status: 'warn' as const, issues: [], suggestions: [`已按章节审查结果应用局部修复，修复前问题已移交最终校验复核。`], chars: documentTextLength(chapterDrafts.find(chapter => chapter.id === summary.chapterId)?.content || '') }
        : summary);
      initialMarkdown = composeDocumentMarkdown({ ...base, chapters: chapterDrafts, validationIssues, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules });
    }
    executionStages.push(displayStage({ type: 'llm_review' as const, roleId: 'chapter-review-repair', status: 'success' as const, message: `章节就地修复完成：修复 ${repairedCount} 章，应用 ${patchCount} 个 patch` }, { subtitle: '章节就地修复' }));
    emitProgress(chapterDrafts, executionStages);
  }
  if (shouldChapterReview) {
    const chapterReviewValidationIssues = chapterReviewSummaries
      .filter(item => item.status !== 'pass' && item.issues.length > 0)
      .map(summary => ({ level: summary.status === 'fail' ? 'error' as const : 'warning' as const, message: `${summary.title} 章节审查：共 ${summary.issues.length} 个问题；${summary.issues.join('；') || '存在质量风险'}`, suggestion: summary.suggestions.join('；') || '请复核章节事实覆盖、结构完整性和角色证据覆盖。' }));
    validationIssues = collectValidationIssueGroups(validationIssues, chapterReviewValidationIssues);
  }
  const shouldGlobalReview = generationStrategy.enableGlobalReview && (shouldChapterReview || validationIssues.some(issue => /事实一致性|项目污染|章节缺失|结构/u.test(issue.message)));
  if (shouldGlobalReview) {
    upsertProgressStage(executionStages, displayStage({
      type: 'llm_review',
      roleId: 'global-consistency-review',
      status: 'running',
      message: '正在进行全局一致性审查',
      details: ['仅在章节审查或本地校验发现跨章节风险时触发'],
      progress: { current: 2, total: 3, label: '全局审查' },
    }, { subtitle: '全局一致性审查' }));
    emitProgress(chapterDrafts, executionStages);
  }
  const globalReview = shouldGlobalReview
    ? await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'global-consistency-review', () => reviewGlobalConsistency({ template, chapters: chapterDrafts, chapterReviews: chapterReviewSummaries, promptTexts: reviewPromptTexts || promptTexts, requirement: requirement, projectContext, diagnostics: generationDiagnostics, signal: signal }), { chapters: chapterDrafts.length }), executionStages)
    : { issues: [] as string[], stage: displayStage({ type: 'llm_review' as const, roleId: 'global-consistency-review', status: 'skipped', message: generationStrategy.enableGlobalReview ? '未发现需要 LLM 全局一致性审查的跨章节风险，已跳过' : '当前策略未启用全局一致性审查' }, { subtitle: '全局一致性审查' }) };
  executionStages.push(globalReview.stage);
  validationIssues = collectValidationIssueGroups(
    validationIssues,
    globalReview.issues.map(issue => ({ level: 'warning' as const, message: `全局一致性审查：${issue}`, suggestion: '请复核跨章节术语、关键事实、范围边界和上下文一致性。' })),
  );
  emitProgress(chapterDrafts, executionStages);
  const riskChapters = chapterDrafts.filter(chapter => chapter.evidence.length === 0 || chapter.missingFacts.length > 0 || documentTextLength(chapter.content) < Math.floor((documentBudget.chapterTargets.get(chapter.id) || 1200) * 0.7) || chapterReviewSummaries.some(summary => summary.chapterId === chapter.id && summary.status === 'fail') || lightweightChapterIssues({ chapter: effectiveChapters.find(item => item.id === chapter.id) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections }, content: chapter.content, missingFacts: chapter.missingFacts, targetWords: documentBudget.chapterTargets.get(chapter.id) || 1200 }).length > 0);
  const forceFinalQualityReview = initialBlockingCount > 0 || globalReview.issues.length > 0 || chapterReviewSummaries.some(summary => summary.status === 'fail') || validationIssues.some(issue => /事实一致性|项目污染|章节生成存在兜底|章节生成失败|阻断/u.test(issue.message));
  const shouldFinalQualityReview = generationStrategy.enableFinalQualityReview && (forceFinalQualityReview || riskChapters.length > Math.max(3, Math.floor(chapterDrafts.length * 0.35)));
  const reviewStartedAt = Date.now();
  if (shouldFinalQualityReview) {
    upsertProgressStage(executionStages, displayStage({
      type: 'llm_review',
      roleId: 'llm-review',
      status: 'running',
      message: `正在进行最终质量审查：风险章节 ${riskChapters.length} 个`,
      details: ['只检查结构、事实一致性、目录层级和正式文档风格，不重写正文'],
      progress: { current: 3, total: 3, label: '质量审查' },
    }, { subtitle: '最终质量审查' }));
    emitProgress(chapterDrafts, executionStages);
  }
  const reviewEvidence = selectEvidenceByBudget(allEvidence, { maxItems: Math.max(32, effectiveChapters.length * 8), maxChars: Math.max(36000, effectiveChapters.length * 6000), preservePinned: true });
  const review = shouldFinalQualityReview
    ? await withProgressHeartbeat(() => reviewAndOptimizeMarkdown({ template, spec: documentSpec, markdown: initialMarkdown, evidence: reviewEvidence, promptTexts: reviewPromptTexts || promptTexts, projectContext, requirement: requirement, diagnostics: generationDiagnostics, signal: signal }), executionStages)
    : { markdown: initialMarkdown, stage: { type: 'llm_review' as const, roleId: 'llm-review', status: riskChapters.length > 0 ? 'fallback' as const : 'success' as const, message: riskChapters.length > 0 ? `本地风险扫描发现 ${riskChapters.length} 个低/中风险章节，未达到最终 LLM 审查触发阈值，保留为待复核 warning` : '本地风险扫描未发现需要 LLM 最终质量审查的章节' } };
  review.stage.message = elapsedMessage(review.stage.message || 'LLM 审查完成', reviewStartedAt);
  throwIfAborted(signal);
  const reviewedMarkdownBase = applyDeterministicGateRepairs(finalizeDocumentMarkdown(review.markdown === initialMarkdown ? composeDocumentMarkdown({ ...base, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules }) : review.markdown, chapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules }).markdown, validationIssues);
  const structureIssueMessages = plannedStructureIssues(reviewedMarkdownBase, template).map(issue => buildRepairTaskMessage(issue));
  const placeholderIssueMessages = formalPlaceholderIssues(reviewedMarkdownBase).map(issue => buildRepairTaskMessage(issue));
  const gateIssueMessages = plannedAutoSpecGateIssues(reviewedMarkdownBase, template).map(issue => buildRepairTaskMessage(issue));
  const preciseIssueMessages = preciseFactUsageIssues(reviewedMarkdownBase, factsModel).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const tocIssueMessages = promptDocumentRules.forbidToc ? [] : [...tocHierarchyIssues(reviewedMarkdownBase), ...tocBodyConsistencyIssues(reviewedMarkdownBase)].map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const contentIntegrityMessages = formalContentIntegrityIssues(reviewedMarkdownBase).map(issue => buildRepairTaskMessage(issue));
  const sectionIntegrityMessages = sectionContentIntegrityIssues(reviewedMarkdownBase, chapterDrafts).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const professionalMessages = buildProfessionalRepairIssues({ markdown: reviewedMarkdownBase, chapters: chapterDrafts, factsModel }).map(issue => buildRepairTaskMessage(issue));
  const repeatedBasicInfoMessages = duplicateBasicInfoIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const formalStyleMessages = formalStyleIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const minSectionMessages = minChapterSectionIssues(chapterDrafts).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const tertiaryHeadingMessages = tertiaryHeadingIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const qualityIssues = collectMessageGroups(structureIssueMessages, placeholderIssueMessages, gateIssueMessages, preciseIssueMessages, tocIssueMessages, contentIntegrityMessages, sectionIntegrityMessages, professionalMessages, repeatedBasicInfoMessages, formalStyleMessages, minSectionMessages, tertiaryHeadingMessages);
  const sectionRepairIssueSet = new Set(sectionIntegrityMessages);
  const repairStartedAt = Date.now();
  const repairIssues = qualityIssues.filter(message => !sectionRepairIssueSet.has(message));
  upsertProgressStage(executionStages, displayStage({
    type: 'llm_review',
    roleId: 'quality-repair',
    status: repairIssues.length > 0 ? 'running' : 'success',
    message: repairIssues.length > 0 ? `正在进行精准质量修复：${repairIssues.length} 个问题` : '未发现需要精准修复的问题',
    details: repairIssues,
    progress: { current: 1, total: Math.max(1, repairIssues.length), label: '质量修复' },
  }, { subtitle: '精准质量修复' }));
  emitProgress(chapterDrafts, executionStages);
  const repair = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'local-patch-quality-repair', () => repairMarkdownByQuality({ markdown: reviewedMarkdownBase, template, chapters: chapterDrafts, promptTexts, requirement: requirement, issues: repairIssues, forbidDrawingImages, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: signal }), { issues: repairIssues.length }), executionStages);
  if (repair.stage) repair.stage.message = elapsedMessage(repair.stage.message || '质量修复完成', repairStartedAt);
  throwIfAborted(signal);
  let reviewedStages = repair.stage ? [...executionStages, review.stage, repair.stage] : [...executionStages, review.stage];
  let repairedChapterDrafts = repair.chapters;
  let postPatchMarkdown = composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules });
  postPatchMarkdown = applyDeterministicGateRepairs(postPatchMarkdown, validationIssues);
  const postRepairIssues = buildPostRepairIssues({ markdown: postPatchMarkdown, chapters: repairedChapterDrafts, template, factsModel });
  const unresolvedQualityTasks = unresolvedRepairTasks(repairIssues, postRepairIssues).slice(0, 8);
  if (unresolvedQualityTasks.length > 0) {
    const escalation = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'local-patch-quality-repair-escalation', () => repairMarkdownByQuality({ markdown: postPatchMarkdown, template, chapters: repairedChapterDrafts, promptTexts, requirement: requirement, issues: unresolvedQualityTasks, forbidDrawingImages, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: signal }), { issues: unresolvedQualityTasks.length }), reviewedStages);
    repairedChapterDrafts = escalation.chapters;
    postPatchMarkdown = composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules });
    postPatchMarkdown = applyDeterministicGateRepairs(postPatchMarkdown, validationIssues);
    reviewedStages = escalation.stage ? [...reviewedStages, { ...escalation.stage, roleId: 'quality-repair-escalation', message: `修复后验证发现残留问题，已升级修复 ${unresolvedQualityTasks.length} 个问题` }] : reviewedStages;
  }
  const postPatchSectionGaps = collectSectionContentGaps(postPatchMarkdown, repairedChapterDrafts.map(chapter => ({ ...chapter, sections: extractGeneratedSections(chapter.content) })))
    .filter(gap => gap.reason === 'empty' || gap.reason === 'table_only');
  if (postPatchSectionGaps.length > 0) {
    const sectionRepairStartedAt = Date.now();
    upsertProgressStage(reviewedStages, displayStage({
      type: 'llm_review',
      roleId: 'section-content-repair',
      status: 'running',
      message: `正在补写空洞小节：${postPatchSectionGaps.length} 个问题`,
      details: postPatchSectionGaps.map(gap => gap.message),
      progress: { current: 1, total: postPatchSectionGaps.length, label: '小节补写' },
    }, { subtitle: '小节内容补写' }));
    emitProgress(repairedChapterDrafts, reviewedStages);
    const patchedChapterDrafts = [...repairedChapterDrafts];
    for (let offset = 0; offset < repairedChapterDrafts.length; offset += Math.max(1, repairedChapterDrafts.length || 1)) {
      throwIfAborted(signal);
      const batch = repairedChapterDrafts.slice(offset, offset + Math.max(1, repairedChapterDrafts.length || 1));
      const batchResults = await Promise.all(batch.map(async chapter => {
        const chapterGaps = postPatchSectionGaps.filter(gap => gap.chapterTitle === chapter.title);
        if (chapterGaps.length === 0) return chapter;
        const templateChapter = effectiveChapters.find((item: any) => item.id === chapter.id || item.title === chapter.title) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections };
        const targetWords = documentBudget.chapterTargets.get(chapter.id) || 1200;
        const plan = projectUnderstanding.chapterPlans.find((item: any) => item.chapterId === templateChapter.id || item.chapterTitle === templateChapter.title);
        const repairRoleContext = [plan?.writingGoal, plan?.mustCover?.length ? `本章必须覆盖：${plan.mustCover.join('、')}` : ''].filter(Boolean).join('\n');
        try {
          const supplemented = await callWithTimeout(
            signal => supplementShortSections({ template, chapter: templateChapter, content: chapter.content, evidence: chapter.evidence, missingFacts: chapter.missingFacts, promptTexts, projectContext, requirement: requirement, roleContext: repairRoleContext, targetWords, forbidDrawingImages, forcedSections: chapterGaps, signal }),
            Math.min(300000, Math.max(90000, chapterGaps.length * 90000)),
            signal,
          );
          if (!supplemented) return chapter;
          const sections = extractGeneratedSections(supplemented);
          return { ...chapter, content: supplemented, markdown: supplemented, sections };
        } catch {
          return chapter;
        }
      }));
      batchResults.forEach((chapter, index) => { patchedChapterDrafts[offset + index] = chapter; });
    }
    repairedChapterDrafts = patchedChapterDrafts;
    const remainingSectionIssues = sectionContentIntegrityIssues(composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules }), repairedChapterDrafts);
    upsertProgressStage(reviewedStages, displayStage({ type: 'llm_review', roleId: 'section-content-repair', status: remainingSectionIssues.length > 0 ? 'fallback' : 'success', message: elapsedMessage(remainingSectionIssues.length > 0 ? `小节补写后仍存在 ${remainingSectionIssues.length} 个内容缺口` : '小节内容补写完成', sectionRepairStartedAt), details: remainingSectionIssues.map(issue => issue.message) }, { subtitle: '小节内容补写' }));
    emitProgress(repairedChapterDrafts, reviewedStages);
  }
  const repairedBudgetStatus = documentBudgetStatus(documentBudget, repairedChapterDrafts.map(chapter => chapter.content).join('\n\n'));
  if (generationStrategy.enableDocumentBudgetExpansion && documentBudget.minChars && repairedBudgetStatus.currentChars < Math.floor(documentBudget.minChars * 0.9) && (!documentBudget.maxChars || repairedBudgetStatus.currentChars < documentBudget.maxChars)) {
    const postRepairBudgetStartedAt = Date.now();
    const postRepairBeforeChars = repairedBudgetStatus.currentChars;
    upsertProgressStage(reviewedStages, displayStage({
      type: 'validation',
      roleId: 'document-budget-repair',
      status: 'running',
      message: `正在进行修复后预算补齐：当前 ${postRepairBeforeChars} 字`,
      details: [`目标下限：${documentBudget.minChars} 字`, `章节数：${repairedChapterDrafts.length}`],
      progress: { current: 1, total: 2, label: '预算补齐' },
    }, { subtitle: '修复后预算补齐' }));
    emitProgress(repairedChapterDrafts, reviewedStages);
    repairedChapterDrafts = await withProgressHeartbeat(() => expandDocumentToBudget({ template, chapters: repairedChapterDrafts, budget: documentBudget, promptTexts, requirement: requirement, forbidDrawingImages, signal: signal }), reviewedStages);
    const postRepairBudgetStatus = documentBudgetStatus(documentBudget, repairedChapterDrafts.map(chapter => chapter.content).join('\n\n'));
    upsertProgressStage(reviewedStages, displayStage({ type: 'validation', roleId: 'document-budget-repair', status: documentBudget.minChars && postRepairBudgetStatus.currentChars < documentBudget.minChars ? 'fallback' : 'success', message: elapsedMessage(`修复后预算补齐：当前 ${postRepairBudgetStatus.currentChars} 字，新增 ${Math.max(0, postRepairBudgetStatus.currentChars - postRepairBeforeChars)} 字，预计 ${postRepairBudgetStatus.estimatedPages} 页`, postRepairBudgetStartedAt) }, { subtitle: '修复后预算补齐' }));
  }
  const repairedMarkdown = composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules });
  let finalizedDocument = finalizeDocumentMarkdown(repairedMarkdown, repairedChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules });
  let finalChapterDrafts = finalizedDocument.chapters;
  let finalMarkdown = finalizedDocument.markdown;
  const finalSectionGaps = collectSectionContentGaps(finalMarkdown, finalChapterDrafts.map(chapter => ({ ...chapter, sections: extractGeneratedSections(chapter.content) })))
    .filter(gap => gap.reason === 'empty' || gap.reason === 'table_only');
  if (finalSectionGaps.length > 0) {
    const finalSectionRepairStartedAt = Date.now();
    upsertProgressStage(reviewedStages, displayStage({ type: 'llm_review', roleId: 'final-section-content-repair', status: 'running', message: `最终结构化后补写残留空洞小节：${finalSectionGaps.length} 个问题`, details: finalSectionGaps.map(gap => gap.message), progress: { current: 1, total: finalSectionGaps.length, label: '最终小节补写' } }, { subtitle: '最终小节内容补写' }));
    emitProgress(finalChapterDrafts, reviewedStages);
    const repairedFinalChapters = [...finalChapterDrafts];
    for (let offset = 0; offset < finalChapterDrafts.length; offset += Math.max(1, finalChapterDrafts.length || 1)) {
      throwIfAborted(signal);
      const batch = finalChapterDrafts.slice(offset, offset + Math.max(1, finalChapterDrafts.length || 1));
      const batchResults = await Promise.all(batch.map(async chapter => {
        const chapterGaps = finalSectionGaps.filter(gap => gap.chapterTitle === chapter.title);
        if (chapterGaps.length === 0) return chapter;
        const templateChapter = effectiveChapters.find((item: any) => item.id === chapter.id || item.title === chapter.title) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections };
        const targetWords = documentBudget.chapterTargets.get(chapter.id) || 1200;
        const plan = projectUnderstanding.chapterPlans.find((item: any) => item.chapterId === templateChapter.id || item.chapterTitle === templateChapter.title);
        const repairRoleContext = [plan?.writingGoal, plan?.mustCover?.length ? `本章必须覆盖：${plan.mustCover.join('、')}` : ''].filter(Boolean).join('\n');
        try {
          const supplemented = await callWithTimeout(
            signal => supplementShortSections({ template, chapter: templateChapter, content: chapter.content, evidence: chapter.evidence, missingFacts: chapter.missingFacts, promptTexts, projectContext, requirement: requirement, roleContext: repairRoleContext, targetWords, forbidDrawingImages, forcedSections: chapterGaps, signal }),
            Math.min(300000, Math.max(90000, chapterGaps.length * 90000)),
            signal,
          );
          if (!supplemented) return chapter;
          const sections = extractGeneratedSections(supplemented);
          return { ...chapter, content: supplemented, markdown: supplemented, sections };
        } catch {
          return chapter;
        }
      }));
      batchResults.forEach((chapter, index) => { repairedFinalChapters[offset + index] = chapter; });
    }
    finalizedDocument = finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: repairedFinalChapters, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules }), repairedFinalChapters, { forbidDrawingImages, promptRules: promptDocumentRules });
    finalChapterDrafts = finalizedDocument.chapters;
    finalMarkdown = finalizedDocument.markdown;
    const remainingFinalSectionIssues = sectionContentIntegrityIssues(finalMarkdown, finalChapterDrafts);
    upsertProgressStage(reviewedStages, displayStage({ type: 'llm_review', roleId: 'final-section-content-repair', status: remainingFinalSectionIssues.length > 0 ? 'fallback' : 'success', message: elapsedMessage(remainingFinalSectionIssues.length > 0 ? `最终补写后仍存在 ${remainingFinalSectionIssues.length} 个内容缺口` : '最终小节内容补写完成', finalSectionRepairStartedAt), details: remainingFinalSectionIssues.map(issue => issue.message) }, { subtitle: '最终小节内容补写' }));
    emitProgress(finalChapterDrafts, reviewedStages);
  }
  finalizedDocument = finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: finalChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules }), finalChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules });
  finalChapterDrafts = finalizedDocument.chapters;
  finalMarkdown = normalizeProjectBasicInfoTable(repairKnownProjectBasicPlaceholders(finalizedDocument.markdown, structuredFacts), structuredFacts);
  const canonicalFacts = buildCanonicalFacts({ facts: structuredFacts, markdown: finalMarkdown });
  if (canonicalFacts.size > 0) executionStages.push({ type: 'fact_extraction', roleId: 'canonical-facts', status: 'success', message: `已决策可信基础事实 ${canonicalFacts.size} 项`, details: [...canonicalFacts.values()].map(fact => `${fact.label}=${fact.value}（${fact.source}，confidence=${fact.confidence}）`).slice(0, 12) });
  const preRepairWarningIssues = [...structureIssueMessages];
  validationIssues = collectValidationIssueGroups(
    applySpecGateRules(documentSpec, [...validationIssues, ...preRepairWarningIssues.map(message => ({ level: 'warning' as const, message }))], factsModel, finalChapterDrafts, finalMarkdown, template.projectBindings || [], promptBindings),
    validateDraftWithAutoSpec({ markdown: finalMarkdown, spec: documentSpec, summary: projectMaterialSummary }),
    validateFactConsistency({ markdown: finalMarkdown, facts: structuredFacts, summary: projectMaterialSummary, profile: domainProfile }),
    validateProjectContamination(finalMarkdown, projectMaterialSummary),
    projectBasicPlaceholderIssues(finalMarkdown, structuredFacts),
    buildStandardFinalValidationIssues({ markdown: finalMarkdown, chapters: finalChapterDrafts, factsModel, template, promptBindings, promptDocumentRules }),
  );
  const finalFactPatch = appendMissingFactPatchesToChapters(finalChapterDrafts, structuredFacts, finalMarkdown);
  if (finalFactPatch.patchedCount > 0) {
    finalChapterDrafts = finalFactPatch.chapters.map(chapter => ({ ...chapter, sections: chapter.sections || [] }));
    validationIssues = [...validationIssues, { level: 'info', message: `最终审查阶段已补写未落位事实 ${finalFactPatch.patchedCount} 项`, suggestion: '补写仅使用本项目资料明确事实，未补写商务敏感信息或系统暂未确认内容。' }];
    finalMarkdown = finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: finalChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules }), finalChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules }).markdown;
  }
  validationIssues = collectValidationIssueGroups(validationIssues, factCoverageIssues(finalMarkdown, [...structuredFacts, ...factsModel.preciseFacts], { maxIssues: 30 }));
  finalMarkdown = finalizeDocumentMarkdown(finalMarkdown, finalChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules }).markdown;
  const budgetIssues = documentBudgetIssues(documentBudget, finalMarkdown);
  const pageIssues = pageTargetIssues(template.generationSettings || template.exportSettings, finalMarkdown).filter(issue => !(documentBudget.minPages && /低于目标页数/u.test(issue.message)));
  validationIssues = dedupeValidationIssues(collectValidationIssueGroups(validationIssues, pageIssues, budgetIssues, plannedStructureIssues(finalMarkdown, template), promptDocumentRuleIssues(finalMarkdown, promptDocumentRules)));
  const knowledgeCoverage = buildKnowledgeCoverageReport({ chapters: finalChapterDrafts, templateChapters: effectiveChapters, factsModel, evidence: allEvidence });
  const factTraces = buildDocumentFactTraces(finalMarkdown, factsModel);
  const chapterCoverage = buildChapterCoverageReports({ chapters: finalChapterDrafts, templateChapters: effectiveChapters, factsModel });
  validationIssues = dedupeValidationIssues(collectValidationIssueGroups(
    validationIssues,
    knowledgeCoverageIssues(knowledgeCoverage),
    factTraceIssues(factTraces, { maxIssues: 20 }),
    chapterCoverageIssues(chapterCoverage),
    retrievalCoverageIssues(retrievalCoverageReports),
  ));
  let finalExportGate = buildExportGate(validationIssues, factsModel, finalChapterDrafts);
  let qualityReport = buildDocumentQualityReport({ markdown: finalMarkdown, chapters: finalChapterDrafts, issues: validationIssues, knowledgeCoverage, factTraces, chapterCoverage });
  const repairStrategies = buildRepairStrategies({ issues: validationIssues, qualityReport, knowledgeCoverage, factTraces, chapterCoverage });
  validationIssues = dedupeValidationIssues(collectValidationIssueGroups(validationIssues, qualityReportIssues(qualityReport), repairStrategyIssues(repairStrategies)));
  finalExportGate = buildExportGate(validationIssues, factsModel, finalChapterDrafts);
  qualityReport = buildDocumentQualityReport({ markdown: finalMarkdown, chapters: finalChapterDrafts, issues: validationIssues, knowledgeCoverage, factTraces, chapterCoverage });
  const reviewChecklist = buildDocumentReviewChecklist({ exportGate: finalExportGate, qualityReport, repairStrategies });
  const telemetry = buildDocumentTelemetryReport({ diagnostics: generationDiagnostics });
  const blockingCount = finalExportGate.blockingIssues.length;
  const finalQualitySummary = qualitySeveritySummary(validationIssues);
  generationDiagnostics.quality.blockingCount += finalQualitySummary.blocking;
  generationDiagnostics.quality.importantCount += finalQualitySummary.important;
  generationDiagnostics.quality.minorCount += finalQualitySummary.minor;
  const finalStages: DocumentExecutionStage[] = reviewedStages.map(stage => {
    if (stage.type === 'validation' && stage.roleId === 'document-workflow') return { ...stage, status: blockingCount > 0 ? 'failed' : 'success', message: `阻断 ${blockingCount}，问题 ${validationIssues.length}` };
    if (stage.type === 'export_ready') return { ...stage, status: finalExportGate.passed ? 'success' : 'failed', message: finalExportGate.passed ? '已准备好导出 Markdown/HTML/DOCX/PDF' : '导出门禁未通过，请完成阻断问题修复后再导出' };
    return stage;
  });
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-delivery-score', status: qualityReport.passed ? 'success' : 'fallback', message: qualityReport.summary, details: qualityReport.actions }, { subtitle: '交付评分' }));
  finalStages.push(displayStage({ type: 'reference', roleId: 'knowledge-coverage', status: knowledgeCoverage.score >= 85 ? 'success' : 'fallback', message: `知识库确认覆盖率：${knowledgeCoverage.score}%（证据 ${knowledgeCoverage.evidenceCount} 条，文件 ${knowledgeCoverage.confirmedFiles} 份）`, details: [knowledgeCoverage.remediation] }, { subtitle: '知识库覆盖' }));
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-review-checklist', status: reviewChecklist.every(item => item.passed) ? 'success' : 'fallback', message: `交付复核清单：通过 ${reviewChecklist.filter(item => item.passed).length}/${reviewChecklist.length}`, details: reviewChecklist.map(item => `${item.passed ? '通过' : '待修复'}：${item.label}${item.message ? `（${item.message}）` : ''}`) }, { subtitle: '交付复核' }));
  const slowMetrics = slowMetricSummary(generationDiagnostics.metrics);
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-diagnostics', status: 'success', message: `性能统计：LLM ${generationDiagnostics.llm.calls} 次，失败 ${generationDiagnostics.llm.failures} 次，峰值并行 ${generationDiagnostics.llm.maxActive}，检索 ${generationDiagnostics.evidence.searchQueries} 次/${Math.round(generationDiagnostics.evidence.searchMs / 1000)} 秒，证据上下文 ${generationDiagnostics.evidence.contextChars} 字，噪声过滤 ${generationDiagnostics.evidence.filteredNoise} 条，质量问题 阻断${generationDiagnostics.quality.blockingCount}/重要${generationDiagnostics.quality.importantCount}/轻微${generationDiagnostics.quality.minorCount}${slowMetrics ? `，Top耗时：${slowMetrics}` : ''}` }, { subtitle: '后台诊断' }));
  const compactFinalChapterDrafts = finalChapterDrafts.map(chapter => ({
    ...chapter,
    evidence: selectEvidenceByBudget(chapter.evidence || [], { maxItems: 12, maxChars: 9000, preservePinned: true }),
  }));
  const finalBase = {
    ...base,
    chapters: compactFinalChapterDrafts,
    validationIssues,
    exportGate: finalExportGate,
    executionStages: finalStages,
    partialChapters: finalChapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: compactFinalChapterDrafts,
    reviewMetadata: {
      chapterSummaries: chapterReviewSummaries,
      globalIssues: globalReview.issues,
      diagnostics: generationDiagnostics,
      profile: buildDocumentProfileReport({ template, chapters: effectiveChapters, requirement: requirement }),
      knowledgeCoverage,
      factTraces,
      chapterCoverage,
      retrievalCoverage: retrievalCoverageReports,
      qualityReport,
      repairStrategies,
      reviewChecklist,
      workflowVersion: DOCUMENT_WORKFLOW_VERSION,
      telemetry,
    },
  };
  return { ...finalBase, markdown: finalMarkdown };
}

