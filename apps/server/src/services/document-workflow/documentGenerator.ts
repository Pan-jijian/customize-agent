import * as path from 'node:path';
import { computeProjectId } from '@customize-agent/knowledge';
import { getMultiProjectManager, getProjectRoot } from '../knowledge/kbService';
import { getConfigStore } from '../common/configService';
import { getProjectRoleConfig } from '../document-core/documentRoleService';
import { autoSpecPrompt, getOrCreateAutoDocumentSpec } from '../document-core/autoDocumentSpecService';
import { buildProjectMaterialSummary, projectMaterialPrompt } from '../document-core/projectMaterialService';
import { resolveDocumentDomainProfile } from '../document-core/documentDomainProfileService';
import { evaluateDocumentReadiness, readinessPrompt } from '../document-validation/documentReadinessService';
import type { KbSearchResult } from '@/lib/api';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, GeneratedDocumentDraft, RetrievalCoverageReport, WebAccessConfig } from './types';
import { buildPromptBindingPlan, defaultProjectRoleConfigIdForTemplate, getDocumentTemplate } from './templateStore';
import { evidenceLine, evidencePromptBudgetForTarget, selectEvidenceByBudget } from './evidence';
import { displayChapterTitle, effectiveTemplateChapters, extractExplicitOutlineFromSources } from './outline';
import { evidenceMatchesFact } from './factMatching';
import { plannedStructurePrompt, extractGeneratedSections } from './markdownComposer';
import { buildDocumentBudget, documentTextLength } from './budget';
import { collectSectionContentGaps, qualitySeveritySummary, sectionContentIntegrityIssues } from './qualityValidation';
import { buildDocumentBlueprintContext } from './documentBlueprint';
import { buildRetrievalCoverageReport, retrieveDeepChapterEvidence, retrievalCoverageRisk } from './documentEvidenceRetrieval';
import { buildChapterFactNeeds, extractPreciseFactsFromEvidence, extractProjectBasicFactsFromEvidence, extractStructuredFacts, extractStructuredTables, buildFactsModel, factNeedsCoveragePrompt, factsForChapterNeeds, resolveChapterFactNeeds } from './factsModel';
import { stableHash, throwIfAborted } from './utils';
import { displayStage, elapsedMessage, upsertProgressStage } from './progress';
import { callWithTimeout, getActiveModelWithProvider } from './llmClient';
import { blockingChapterIssues, createGenerationDiagnostics, evidenceInScope, lightweightChapterIssues, measureGenerationStep, promptTextsForResolvedPrompts, repairChapterByQuality, selectDocumentGenerationStrategy } from './rolePipeline';
import { buildProjectMaterialProfile, buildProjectUnderstanding, expandProjectMaterialBindings, materialKindMaps, materialRoleId, retrievePlannedMaterialEvidence, sampleProjectMaterialEvidence } from './projectMaterialProfile';
import { buildChapterFactCoverageContext, buildLlmChapterContent, buildSectionParallelChapterContent, chapterSectionFactUsageIssues, expandChapterToTarget, outputTokensForChapter, supplementShortSections, timeoutMsForChapter } from './chapterGeneration';
import { buildRuntimePromptRules, extractPromptStructuralRules, normalizePlannedSections, planChapterSectionsWithLlm, runtimePromptRulesPrompt } from './promptRuleExtraction';
import { retrieveWebEvidence, webAccessPrompt } from './webResearchService';
import { finalizeGeneration } from './documentPipeline';
import { buildEvidenceBackedChapterFallback, chapterCompletionStatus, collectProjectBasicEvidence, compactChapterQueries, criticalChapterSectionGaps, finalizeChapterContentQuality, kbIndexHealth, optimizeChapterEvidence, PROJECT_BASIC_FACT_QUERIES, qualityFirstEvidenceItemLimit, qualityFirstSearchQueryLimit, reportGenerationDebugEvent, resolveChapterPromptExecution, resolveDocumentGenerationEvidenceLimit, retrieveMissingFactEvidence, retrieveSectionEvidence, searchWeightsForChapter } from './documentGeneratorHelpers';

export async function generateDocumentDraft(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; resumeChapters?: DocumentDraftChapter[]; signal?: AbortSignal; onProgress?: (stages: DocumentExecutionStage[], checkpoint?: { chapters?: DocumentDraftChapter[] }) => void }): Promise<GeneratedDocumentDraft> {
  throwIfAborted(input.signal);
  const baseTemplate = getDocumentTemplate(input.templateId);
  if (!baseTemplate) throw new Error('Document template not found');
  const projectRoot = path.resolve(input.projectRoot || getProjectRoot());
  if (!projectRoot) throw new Error('No knowledge base project found');
  const projectId = computeProjectId(projectRoot);
  let template = baseTemplate;
  const manager = getMultiProjectManager();
  let chapterDrafts: DocumentDraftChapter[] = [];
  let checkpointChapterOrderIds: string[] = [];
  const emitProgress = (checkpointChapters?: DocumentDraftChapter[], stages: DocumentExecutionStage[] = progressStages) => {
    const chapters = checkpointChapters ? [...checkpointChapters].sort((a, b) => {
      const ia = checkpointChapterOrderIds.indexOf(a.id);
      const ib = checkpointChapterOrderIds.indexOf(b.id);
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
    }) : undefined;
    input.onProgress?.([...stages], chapters ? { chapters } : undefined);
  };
  const heartbeatMs = Math.max(15_000, Math.min(60_000, Number(process.env.DOCUMENT_GENERATION_HEARTBEAT_MS ?? 30_000)));
  const withProgressHeartbeat = async <T>(work: () => Promise<T>, stages: DocumentExecutionStage[] = progressStages): Promise<T> => {
    const timer = setInterval(() => {
      if (!input.signal?.aborted) emitProgress(chapterDrafts, stages);
    }, heartbeatMs);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  };
  const projectRoleConfigId = defaultProjectRoleConfigIdForTemplate(template) || 'none';
  const projectRoleConfigName = getProjectRoleConfig(projectRoleConfigId)?.name || projectRoleConfigId;
  const progressStages: DocumentExecutionStage[] = [displayStage({
    type: 'role_binding',
    roleId: projectRoleConfigId,
    status: 'running',
    message: `生成任务已创建，正在读取模板与角色配置：${template.name}`,
    details: [`当前项目：${projectId}`, `资料目录：${path.join(projectRoot, 'knowledgeBase')}`, '正在读取项目资料包和提示词配置'],
    progress: { current: 1, total: 4, label: '初始化配置' },
  }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName, order: 0 })];
  emitProgress();
  const promptPlan = buildPromptBindingPlan(template);
  const promptBindings = promptPlan.bindings;
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'running',
    message: '正在分析模板规范、用户要求与项目资料包',
    details: ['解析 OUTLINE 与模板章节', '读取项目资料包', '自动识别资料类型并构建项目理解'],
    progress: { current: 1, total: 3, label: '准备分析' },
  }, { subtitle: '生成准备', order: progressStages.length }));
  emitProgress();
  const materialFilePaths = expandProjectMaterialBindings(projectRoot, template);
  if (materialFilePaths.length === 0) throw new Error('模板未绑定可用项目资料包，请先在模板中绑定需要参与生成的项目文件夹。');
  const projectMaterialProfile = buildProjectMaterialProfile(projectRoot, template);
  const projectUnderstanding = buildProjectUnderstanding(template, projectMaterialProfile);
  const { kindByPath, processingByPath } = materialKindMaps(projectMaterialProfile);
  const promptOutlineTexts = promptTextsForResolvedPrompts([...promptPlan.writerPrompts, ...promptPlan.chapterPrompts]);
  const explicitPromptChapters = extractExplicitOutlineFromSources([
    { text: input.requirement, source: '用户需求', strict: true },
    { text: promptOutlineTexts, source: '提示词角色', strict: true },
  ]);
  const hasExplicitOutline = explicitPromptChapters.length >= 2;
  if (hasExplicitOutline) template = { ...baseTemplate, chapters: explicitPromptChapters };
  const projectMaterialSummary = await withProgressHeartbeat(() => Promise.resolve(buildProjectMaterialSummary(projectRoot, { requirement: input.requirement, boundFilePaths: materialFilePaths })));
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'running',
    message: '正在生成自动文档规格并评估生成准备度',
    details: [`项目资料：${materialFilePaths.length} 份`, `资料类型：${Object.values(projectMaterialProfile.groups).filter(files => files.length > 0).length} 类`, '生成事实字段与章节约束'],
    progress: { current: 2, total: 3, label: '规格评估' },
  }, { subtitle: '生成准备', order: progressStages.length }));
  emitProgress();
  const autoSpec = await withProgressHeartbeat(() => Promise.resolve(getOrCreateAutoDocumentSpec(template, input.requirement || '')));
  const documentSpec = autoSpec.spec;
  const domainProfile = resolveDocumentDomainProfile(template, input.requirement || '');
  const resolvedMaterialRoles: Parameters<typeof evaluateDocumentReadiness>[0]['resolvedRoles'] = [];
  const readiness = evaluateDocumentReadiness({ template, spec: documentSpec, summary: projectMaterialSummary, resolvedRoles: resolvedMaterialRoles });
  if (!readiness.ready) throw new Error(`生成准备度不足：${readiness.blockingIssues.join('；')}`);
  const generationControlPrompt = [projectUnderstanding.prompt, projectMaterialPrompt(projectMaterialSummary, { publicSafe: true }), autoSpecPrompt(documentSpec, autoSpec.sourceHash, { publicSafe: true }), readinessPrompt(readiness, { publicSafe: true })].filter(Boolean).join('\n\n');
  const diagnosticControlPrompt = [projectUnderstanding.prompt, projectMaterialPrompt(projectMaterialSummary), autoSpecPrompt(documentSpec, autoSpec.sourceHash), readinessPrompt(readiness)].filter(Boolean).join('\n\n');
  const writingPromptTexts = promptTextsForResolvedPrompts([...promptPlan.writerPrompts, ...promptPlan.formattingPrompts]);
  const generalChapterPromptTexts = promptTextsForResolvedPrompts([...promptPlan.writerPrompts, ...promptPlan.chapterPrompts, ...promptPlan.formattingPrompts]);
  const sourcePromptTexts = promptTextsForResolvedPrompts(promptPlan.prompts);
  const webAccessConfig = ((getConfigStore() as unknown as { load: () => { webAccess?: WebAccessConfig } }).load().webAccess || { enabled: false, allowProjectFacts: false, maxQueriesPerChapter: 2, maxResultsPerQuery: 3, trustedDomains: [] });
  const runtimePromptRules = buildRuntimePromptRules({ promptTexts: [generationControlPrompt, sourcePromptTexts].filter(Boolean).join('\n\n'), requirement: input.requirement, template, rolePrompts: promptPlan.prompts });
  const runtimeRulesText = [runtimePromptRulesPrompt(runtimePromptRules), webAccessPrompt(webAccessConfig.enabled)].filter(Boolean).join('\n\n');
  const promptTexts = [generationControlPrompt, runtimeRulesText, `生成前规划章节结构：\n${plannedStructurePrompt(template)}`, writingPromptTexts || generalChapterPromptTexts].filter(Boolean).join('\n\n');
  const promptDocumentRules = runtimePromptRules;
  const factExtractionPromptTexts = [diagnosticControlPrompt, runtimeRulesText, promptTextsForResolvedPrompts([...promptPlan.extractionPrompts, ...promptPlan.referencePrompts])].filter(Boolean).join('\n\n');
  const reviewPromptTexts = [generationControlPrompt, runtimeRulesText, promptTextsForResolvedPrompts([...promptPlan.writerPrompts, ...promptPlan.chapterPrompts, ...promptPlan.formattingPrompts])].filter(Boolean).join('\n\n');
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'success',
    message: `模板规范与项目资料理解完成，识别 ${materialFilePaths.length} 份项目资料`,
    details: [`提示词绑定：${promptBindings.length} 个`, `项目资料包：${projectMaterialProfile.materialRoots.join('、') || '当前知识库'}`, hasExplicitOutline ? `识别 OUTLINE 章节：${explicitPromptChapters.length} 个` : '未识别显式 OUTLINE，使用模板章节'],
    progress: { current: 3, total: 3, label: '准备完成' },
  }, { subtitle: '生成准备', order: progressStages.length }));
  emitProgress();
  const evidenceScopePaths = new Set(materialFilePaths);
  const fileRoleByPath = new Map([...kindByPath.entries()].map(([filePath, kind]) => [filePath, materialRoleId(kind)] as const));
  const fileProcessingByPath = new Map([...processingByPath.entries()].map(([filePath, processing]) => [filePath, processing] as const));
  upsertProgressStage(progressStages, displayStage({
    type: 'knowledge_retrieval',
    roleId: 'knowledge-index',
    status: 'running',
    message: '正在读取项目资料包索引',
    details: ['使用上传阶段已完成的解析、切片和索引结果', '不在生成流程中重新解析或入库', '准备按资料类型召回章节证据'],
    progress: { current: 1, total: 3, label: '读取索引' },
  }, { subtitle: '知识库检索', order: progressStages.length }));
  emitProgress();
  const project = await withProgressHeartbeat(() => manager.getProject(projectRoot));
  const indexHealth = kbIndexHealth(project, [...evidenceScopePaths]);
  if (indexHealth.blockingIssues.length > 0) throw new Error(`生成前知识索引不可用：${indexHealth.blockingIssues.join('；')}`);
  const availableEvidenceScopePaths = new Set(indexHealth.usablePaths);
  const requestedEvidencePerChapter = resolveDocumentGenerationEvidenceLimit(project, [...availableEvidenceScopePaths], input.maxEvidencePerChapter);
  const indexHealthHasActionableWarning = indexHealth.pendingJobs > 0 || (indexHealth.vectorStatus && indexHealth.vectorStatus.status !== 'ready') || indexHealth.usableChunkCount === 0;
  const rolePoolRisk = retrievalCoverageRisk({ totalChunks: indexHealth.usableChunkCount, loadedChunks: indexHealth.usableChunkCount });
  upsertProgressStage(progressStages, displayStage({
    type: 'knowledge_retrieval',
    roleId: 'knowledge-index',
    status: indexHealthHasActionableWarning ? 'fallback' : 'success',
    message: `已读取知识索引：项目资料 ${indexHealth.scopedRecords.length} 份，可用切片 ${indexHealth.usableChunkCount} 条`,
    details: [`项目资料：${evidenceScopePaths.size} 份`, `可用证据文件：${availableEvidenceScopePaths.size} 份`, `向量状态：${indexHealth.vectorStatus?.status || 'unknown'}`, ...indexHealth.warnings, '后续将按招标正文/清单/图纸/补疑等资料类型召回'],
    progress: { current: 3, total: 3, label: '索引已就绪' },
  }, { subtitle: '知识库检索', order: progressStages.length }));
  emitProgress();
  throwIfAborted(input.signal);
  const allEvidence: DocumentEvidence[] = [];
  const retrievalCoverageReports: RetrievalCoverageReport[] = [];
  const webResearchReport = { enabled: webAccessConfig.enabled, queries: [] as string[], evidenceCount: 0, filteredCount: 0, chapters: [] as string[] };
  const missingItems: string[] = [];
  const failedChapterMessages: string[] = [];
  const chapterGenerationStages: DocumentExecutionStage[] = [];
  const chapterDraftsByOrder: Array<DocumentDraftChapter | undefined> = [];
  const chapterGenerationStagesByOrder: Array<DocumentExecutionStage | undefined> = [];
  let knowledgeBaseStageIndex = -1;
  const projectUnderstandingStage = { stage: displayStage({ type: 'file_understanding', roleId: 'project-understanding', status: 'success', message: `已完成项目资料理解：${projectMaterialProfile.files.length} 份资料，${Object.values(projectMaterialProfile.groups).filter(files => files.length > 0).length} 类资料类型`, details: projectUnderstanding.prompt.split('\n').slice(0, 16) }, { subtitle: '项目资料理解', order: progressStages.length }) };
  upsertProgressStage(progressStages, projectUnderstandingStage.stage);
  emitProgress();
  const projectBasicEvidence = await collectProjectBasicEvidence({ manager, project, projectRoot, scopedFilePaths: [...evidenceScopePaths].filter(Boolean).sort(), fileRoleByPath, fileProcessingByPath, signal: input.signal });
  if (projectBasicEvidence.length > 0) {
    allEvidence.push(...projectBasicEvidence);
    upsertProgressStage(progressStages, displayStage({ type: 'knowledge_retrieval', roleId: 'project-basic-evidence', status: 'success', message: `已锁定项目基础事实证据 ${projectBasicEvidence.length} 条`, details: projectBasicEvidence.slice(0, 8).map(item => `${path.basename(item.filePath)}｜${item.sectionTitle || '正文片段'}｜score=${item.score.toFixed(2)}`) }, { subtitle: '基础事实召回', order: progressStages.length }));
    emitProgress();
  }
  const earlyLocalFacts = extractStructuredFacts(allEvidence, template, documentSpec);
  const earlyProjectBasicFacts = extractProjectBasicFactsFromEvidence(allEvidence);
  const earlyPreciseFacts = extractPreciseFactsFromEvidence(allEvidence, domainProfile);
  const preliminaryFactsModel = buildFactsModel([...earlyLocalFacts, ...earlyProjectBasicFacts, ...earlyPreciseFacts], extractStructuredTables(allEvidence), missingItems, documentSpec, domainProfile);
  let effectiveChapters = effectiveTemplateChapters(template, documentSpec, { preserveExplicitOutline: hasExplicitOutline });
  const baseProjectContext = projectUnderstanding.prompt;
  let projectContext = [baseProjectContext, buildDocumentBlueprintContext({ template: { ...template, chapters: effectiveChapters }, chapters: effectiveChapters, factsModel: preliminaryFactsModel, requirement: input.requirement })].filter(Boolean).join('\n\n');
  const provisionalTemplate = { ...template, chapters: effectiveChapters };
  const promptStructuralRules = extractPromptStructuralRules([promptTexts, input.requirement || ''].filter(Boolean).join('\n\n'), effectiveChapters);
  const provisionalBudget = buildDocumentBudget({ requirement: input.requirement, promptTexts, template: provisionalTemplate, chapters: effectiveChapters, spec: documentSpec });
  let skippedSectionPlanningCount = 0;
  let llmSectionPlanningCount = 0;
  const plannedChapters = await Promise.all(effectiveChapters.map(async (chapter, chapterIndex) => {
    if (chapter.sections?.length) {
      skippedSectionPlanningCount += 1;
      const lockedSections = promptStructuralRules.filter(rule => rule.chapterIndex === chapterIndex || (rule.chapterTitle && displayChapterTitle(rule.chapterTitle) === displayChapterTitle(chapter.title))).flatMap(rule => rule.requiredSections.sort((a, b) => (a.order || 0) - (b.order || 0)).map(section => section.title));
      const mergedSections = normalizePlannedSections([...lockedSections, ...chapter.sections], chapter.title);
      return { ...chapter, sections: mergedSections.length ? mergedSections : normalizePlannedSections(chapter.sections, chapter.title) };
    }
    llmSectionPlanningCount += 1;
    const chapterEvidence = selectEvidenceByBudget(allEvidence.filter(item => item.chapterId === chapter.id || evidenceMatchesFact(item, chapter.title)), { maxChars: evidencePromptBudgetForTarget(provisionalBudget.chapterTargets.get(chapter.id) || 1200), preservePinned: true });
    const roleContext = projectUnderstanding.chapterPlans.find(plan => plan.chapterId === chapter.id)?.writingGoal || '';
    const planningPromptExecution = resolveChapterPromptExecution(promptPlan, chapter);
    const sections = await planChapterSectionsWithLlm({ template: provisionalTemplate, chapter, chapterIndex, evidence: chapterEvidence, promptTexts: planningPromptExecution.promptTexts, projectContext, requirement: input.requirement, roleContext, targetWords: provisionalBudget.chapterTargets.get(chapter.id) || 1200, structuralRules: promptStructuralRules, signal: input.signal });
    const lockedRuleDetails = promptStructuralRules.filter(rule => rule.chapterIndex === chapterIndex || (rule.chapterTitle && displayChapterTitle(rule.chapterTitle) === displayChapterTitle(chapter.title))).flatMap(rule => rule.requiredSections.map(section => `强制小节：${section.title}`));
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'section-planning', promptId: planningPromptExecution.primaryPromptId, status: sections.length ? 'success' : 'fallback', message: `${displayChapterTitle(chapter.title)} 小节规划${sections.length ? `生成 ${sections.length} 个小节` : '未生成可用小节'}`, details: [...planningPromptExecution.promptDetails, ...lockedRuleDetails, ...(sections.length ? sections.map(section => `规划小节：${section}`) : ['规划结果为空或被污染过滤'])] }, { subtitle: '小节规划' }));
    return sections.length ? { ...chapter, sections } : chapter;
  }));
  effectiveChapters = plannedChapters;
  template = { ...template, chapters: effectiveChapters };
  const documentBlueprintContext = buildDocumentBlueprintContext({ template, chapters: effectiveChapters, factsModel: preliminaryFactsModel, requirement: input.requirement });
  projectContext = [baseProjectContext, documentBlueprintContext].filter(Boolean).join('\n\n');
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-blueprint', status: 'success', message: '已生成全局事实主表与文档蓝图，后续章节和小节将共用同一套专业约束', details: documentBlueprintContext.split('\n').slice(0, 12) }, { subtitle: '全局蓝图' }));
  const documentBudget = buildDocumentBudget({ requirement: input.requirement, promptTexts, template, chapters: effectiveChapters, spec: documentSpec });
  checkpointChapterOrderIds = effectiveChapters.map(chapter => chapter.id);
  const generationStrategy = selectDocumentGenerationStrategy({ template, targetWords: documentBudget.targetChars || [...documentBudget.chapterTargets.values()].reduce((sum, value) => sum + value, 0), requirement: input.requirement });
  const generationDiagnostics = createGenerationDiagnostics(generationStrategy);
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-strategy', status: 'success', message: `已自动选择 ${generationStrategy.mode} 生成策略：章节审查 ${generationStrategy.enableChapterReview ? '启用' : '跳过'}、全局审查 ${generationStrategy.enableGlobalReview ? '启用' : '跳过'}、最终质量审查 ${generationStrategy.enableFinalQualityReview ? '启用' : '跳过'}、全文扩写 ${generationStrategy.enableDocumentBudgetExpansion ? '启用' : '跳过'}；LLM 调用按工作流任务自然并行` }, { subtitle: '后台自动策略' }));
  const sectionPlanningSource = hasExplicitOutline ? 'OUTLINE 章节' : '模板章节';
  const sectionPlanningStage: DocumentExecutionStage = displayStage({
    type: 'validation',
    roleId: 'section-planning',
    status: 'success',
    message: `小节规划：${llmSectionPlanningCount} 章由 LLM 基于${sectionPlanningSource}、项目资料理解和证据规划小节，${skippedSectionPlanningCount} 章已由模板显式提供小节并跳过规划`,
  }, { subtitle: '小节规划策略' });

  // 第一个进度回调：角色绑定完成
  const outlineMessage = hasExplicitOutline ? `；识别到 OUTLINE 章节 ${explicitPromptChapters.length} 个` : '；未识别到有效 OUTLINE，将使用模板章节';
  const promptPlanDetails = [
    ...promptPlan.prompts.map(prompt => `${prompt.category}｜${prompt.roleId}｜${prompt.id}｜${prompt.name}｜${prompt.bindingSource}｜${prompt.content.length} 字符｜hash=${prompt.contentHash}｜${prompt.contentPreview}`),
    ...promptPlan.unresolvedRoles.map(roleId => `unresolved｜${roleId}｜项目角色配置中的提示词角色不存在`),
    ...promptPlan.missingResourceRoles.map(roleId => `missingResource｜${roleId}｜提示词角色未显式绑定资源`),
  ];
  upsertProgressStage(progressStages, displayStage({ type: 'role_binding', roleId: projectRoleConfigId, status: 'success', message: `已绑定项目资料 ${materialFilePaths.length} 份、${promptPlan.prompts.length} 个有效提示词；写作 ${promptPlan.writerPrompts.length}、章节 ${promptPlan.chapterPrompts.length}、抽取 ${promptPlan.extractionPrompts.length}；已自动抽取运行时规则 ${runtimePromptRules.executionSummary.length} 条；语义资料覆盖 ${Math.round(readiness.materialCoverageRate * 100)}%${outlineMessage}`, details: [...promptPlanDetails, ...runtimePromptRules.executionSummary.map(item => `runtimeRule｜${item}`)] }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName }));
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'runtime-prompt-rules', status: 'success', message: `运行时提示词规则已抽取：${runtimePromptRules.executionSummary.length} 条，版本 ${runtimePromptRules.sourceHash}`, details: runtimePromptRules.executionSummary.length ? [...runtimePromptRules.executionSummary, `必需表格：${runtimePromptRules.requiredTables.join('、') || '无'}`, `必含关键词：${runtimePromptRules.requiredKeywords?.join('、') || '无'}`, `禁含内容：${runtimePromptRules.forbiddenPatterns?.join('、') || '无'}`] : ['未从提示词中识别到额外硬规则，使用系统默认质量规则'] }, { subtitle: '提示词规则执行' }));
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-readiness', status: readiness.ready ? 'success' : 'failed', message: `生成准备度：绑定资料已就绪，语义覆盖 ${Math.round(readiness.materialCoverageRate * 100)}%，角色匹配 ${Math.round(readiness.roleSatisfactionRate * 100)}%，优化建议 ${Math.round(readiness.specCompletenessRate * 100)}%`, details: readiness.diagnostics }, { subtitle: '生成准备度检查' }));
  upsertProgressStage(progressStages, sectionPlanningStage);
  emitProgress();

  const chapterConcurrency = Math.max(1, effectiveChapters.length || 1);
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'chapter-concurrency', status: 'success', message: `章节并发调度：本轮 ${chapterConcurrency}/${effectiveChapters.length} 章自然并行`, details: [`有效章节数：${effectiveChapters.length}`] }, { subtitle: '章节并发策略' }));
  emitProgress();
  for (let chapterOffset = 0; chapterOffset < effectiveChapters.length; chapterOffset += chapterConcurrency) {
    const chapterBatch = effectiveChapters.slice(chapterOffset, chapterOffset + chapterConcurrency);
    await Promise.all(chapterBatch.map(async (chapter, batchIndex) => {
    const chapterOrder = chapterOffset + batchIndex;
    throwIfAborted(input.signal);
    const chapterStartedAt = Date.now();
    const chapterProgressIndex = progressStages.length;
    let latestChapterStageForProgress: DocumentExecutionStage | undefined;
    try {
    progressStages.push(displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptPlan.writerPrompts[0]?.id,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在检索证据并准备章节内容`,
      details: [`章节序号：${chapterOrder + 1}/${effectiveChapters.length}`, `二级小节：${chapter.sections?.length || 0} 个`, '正在生成检索查询'],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节生成' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder }));
    emitProgress();
    const rawEvidence: DocumentEvidence[] = [];
    const plan = projectUnderstanding.chapterPlans.find(item => item.chapterId === chapter.id || item.chapterTitle === chapter.title);
    const planQueries = plan ? Object.values(plan.evidenceQueries).flat().filter(Boolean) : [];
    const baseQueries = chapter.queries.length > 0 ? chapter.queries : [template.name, template.outputTitle, chapter.title];
    const chapterBasicQueries = /概况|工程|项目|总体|部署|进度|工期|质量/u.test(chapter.title) ? PROJECT_BASIC_FACT_QUERIES : [];
    const queries = compactChapterQueries(chapter, [...baseQueries, ...planQueries], chapterBasicQueries);
    const maxSearchQueries = qualityFirstSearchQueryLimit(chapter, chapterBasicQueries);
    const searchStartedAt = Date.now();
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptPlan.writerPrompts[0]?.id,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在执行质量优先的章节检索`,
      details: queries.slice(0, maxSearchQueries).map(query => `检索：${query.slice(0, 42)}`),
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '证据检索' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    const scopedFilePaths = [...availableEvidenceScopePaths].filter(Boolean).sort();
    const searchResults: KbSearchResult[][] = [];
    for (const query of queries.slice(0, maxSearchQueries)) {
      throwIfAborted(input.signal);
      if (scopedFilePaths.length === 0) break;
      const result = await manager.search(projectRoot, query, {
        scope: 'project',
        filters: { filePaths: scopedFilePaths },
        limit: Math.min(requestedEvidencePerChapter, 12),
        weights: searchWeightsForChapter(chapter.title),
        generationMode: false,
      });
      searchResults.push(result.results);
    }
    generationDiagnostics.evidence.searchQueries += Math.min(queries.length, maxSearchQueries);
    generationDiagnostics.evidence.searchMs += Date.now() - searchStartedAt;
    for (const results of searchResults) {
      rawEvidence.push(...results
        .filter((item: KbSearchResult) => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths))
        .map((item: KbSearchResult) => ({
          chapterId: chapter.id,
          filePath: item.filePath,
          score: item.score,
          content: item.content,
          roleId: fileRoleByPath.get(item.filePath),
          processingType: fileProcessingByPath.get(item.filePath),
          sectionTitle: item.sectionTitle,
          source: item.source,
        })));
    }
    const plannedMaterialEvidence = await retrievePlannedMaterialEvidence({ manager, projectRoot, chapter, plan, profile: projectMaterialProfile, scopedFilePaths, limitPerQuery: Math.min(requestedEvidencePerChapter, 10), signal: input.signal });
    rawEvidence.push(...plannedMaterialEvidence);
    const pinnedEvidencePaths = new Set<string>((chapter.pinnedEvidenceFilePaths || []).filter(Boolean));
    const matchedRoleContexts: Array<{ fact: never }> = [];
    if (/概况|工程|项目|总体|部署|进度|工期|质量/u.test(chapter.title)) rawEvidence.push(...projectBasicEvidence.map(item => ({ ...item, chapterId: chapter.id, source: 'pinned-evidence' })));
    const chapterPinnedPaths = new Set([...pinnedEvidencePaths]);
    const chapterBudgetTarget = documentBudget.chapterTargets.get(chapter.id) || 1200;
    const pinnedEvidenceBudget = evidencePromptBudgetForTarget(chapterBudgetTarget, 6000, 12000);
    for (const relativePath of chapterPinnedPaths) {
      if (!evidenceInScope(projectRoot, relativePath, evidenceScopePaths)) continue;
      const isPinnedEvidence = pinnedEvidencePaths.has(relativePath);
      const detail = (project as any).getFileDetail(relativePath, { maxChunkContentChars: pinnedEvidenceBudget });
      if (!detail) continue;
      rawEvidence.push(...(detail.chunks as Array<{ content: string; sectionTitle?: string }>).map(chunk => ({
        chapterId: chapter.id,
        filePath: detail.file.relativePath,
        score: 1,
        content: chunk.content,
        roleId: fileRoleByPath.get(detail.file.relativePath),
        processingType: fileProcessingByPath.get(detail.file.relativePath),
        sectionTitle: chunk.sectionTitle,
        source: isPinnedEvidence ? 'pinned-evidence' : 'bound-file',
      })));
    }
    let scopedEvidence = rawEvidence.filter(item => evidenceInScope(projectRoot, item.filePath, availableEvidenceScopePaths));
    if (webAccessConfig.enabled) {
      const webResult = await retrieveWebEvidence({ config: webAccessConfig, chapterId: chapter.id, chapterTitle: chapter.title, sectionTitles: chapter.sections || [], runtimeRules: runtimePromptRules, localFacts: [...preliminaryFactsModel.project, ...preliminaryFactsModel.schedule, ...preliminaryFactsModel.quality, ...preliminaryFactsModel.safety, ...preliminaryFactsModel.resources, ...preliminaryFactsModel.preciseFacts], signal: input.signal });
      if (webResult.evidence.length > 0) {
        scopedEvidence.push(...webResult.evidence);
        webResearchReport.chapters.push(chapter.title);
        webResearchReport.evidenceCount += webResult.evidence.length;
      }
      webResearchReport.queries.push(...webResult.queries);
      webResearchReport.filteredCount += webResult.filtered;
    }
    const evidenceBudgetChars = evidencePromptBudgetForTarget(chapterBudgetTarget, 7000, 26000);
    const sampledEvidence = sampleProjectMaterialEvidence({ project, chapter, plan, profile: projectMaterialProfile, scopedFilePaths, highRisk: rolePoolRisk.highRisk });
    if (sampledEvidence.length > 0) scopedEvidence.push(...sampledEvidence);
    let evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter, chapter, rolePoolRisk.highRisk), maxChars: evidenceBudgetChars + (rolePoolRisk.highRisk ? 14000 : 4000), preservePinned: true }, generationDiagnostics);
    let missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
    let deepEvidenceCount = 0;
    if ((rolePoolRisk.highRisk || missingFacts.length > 0 || evidence.length < 8) && scopedFilePaths.length > 0) {
      const deepEvidence = await retrieveDeepChapterEvidence({ manager, projectRoot, chapter, scopedFilePaths, fileRoleByPath, fileProcessingByPath, requiredNeeds: missingFacts, highRisk: rolePoolRisk.highRisk, signal: input.signal });
      deepEvidenceCount = deepEvidence.length;
      if (deepEvidence.length > 0) {
        scopedEvidence = optimizeChapterEvidence(chapter, [...scopedEvidence, ...deepEvidence], { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 12, chapter, rolePoolRisk.highRisk), maxChars: evidenceBudgetChars + (rolePoolRisk.highRisk ? 36000 : 16000), preservePinned: true }, generationDiagnostics);
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 8, chapter, rolePoolRisk.highRisk), maxChars: evidenceBudgetChars + (rolePoolRisk.highRisk ? 28000 : 12000), preservePinned: true }, generationDiagnostics);
        missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
      }
    }
    if (evidence.length === 0) missingItems.push(`${chapter.title}：系统暂未检索到明确知识库依据`);
    for (const fact of missingFacts) missingItems.push(`${chapter.title}：${fact} 系统暂未从知识库确认`);
    // 证据检索完成 → 持续刷新证据数量
    const knowledgeBaseStage = displayStage({ type: 'knowledge_retrieval', roleId: 'knowledge-base', status: (allEvidence.length > 0 ? 'success' : 'fallback'), message: `已检索/绑定 ${allEvidence.length} 条证据` });
    if (knowledgeBaseStageIndex < 0) {
      knowledgeBaseStageIndex = upsertProgressStage(progressStages, knowledgeBaseStage);
    } else {
      progressStages[knowledgeBaseStageIndex] = { ...knowledgeBaseStage, order: progressStages[knowledgeBaseStageIndex]?.order ?? knowledgeBaseStage.order };
    }
    emitProgress();

    throwIfAborted(input.signal);
    const forbidDrawingImages = false;
    const roleContext = [plan?.writingGoal, plan?.mustCover?.length ? `本章必须覆盖：${plan.mustCover.join('、')}` : '', plan?.mustUseMaterialKinds?.length ? `本章优先使用资料类型：${plan.mustUseMaterialKinds.join('、')}` : ''].filter(Boolean).join('\n');
    const chapterPromptExecution = resolveChapterPromptExecution(promptPlan, chapter);
    if (promptPlan.writerPrompts.length > 0 && !chapterPromptExecution.primaryWriter) throw new Error(`${displayChapterTitle(chapter.title)} 写作主控提示词未进入章节生成阶段`);
    const chapterPromptTexts = [chapterPromptExecution.promptTexts, generationControlPrompt].filter(Boolean).join('\n\n');
    const chapterPromptDetails = chapterPromptExecution.promptDetails.length ? chapterPromptExecution.promptDetails : ['未绑定章节写作提示词'];
    const chapterFactNeeds = buildChapterFactNeeds({ template, chapter, spec: documentSpec, profile: domainProfile, promptTexts: chapterPromptTexts, requirement: input.requirement, plan: plan ? { requiredContents: plan.mustCover, evidenceNeeds: Object.values(plan.evidenceQueries).flat() } : undefined });
    let resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: preliminaryFactsModel, evidence: scopedEvidence, profile: domainProfile });
    let requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
    if (requiredMissingNeeds.length > 0 && scopedFilePaths.length > 0) {
      const supplementalEvidence = await retrieveMissingFactEvidence({ manager, projectRoot, chapter, needs: requiredMissingNeeds, scopedFilePaths, fileRoleByPath, fileProcessingByPath, signal: input.signal });
      const deepNeedEvidence = await retrieveDeepChapterEvidence({ manager, projectRoot, chapter, scopedFilePaths, fileRoleByPath, fileProcessingByPath, requiredNeeds: requiredMissingNeeds, highRisk: true, signal: input.signal });
      const mergedSupplementalEvidence = [...supplementalEvidence, ...deepNeedEvidence];
      if (mergedSupplementalEvidence.length > 0) {
        scopedEvidence = optimizeChapterEvidence(chapter, [...scopedEvidence, ...mergedSupplementalEvidence], { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 16, chapter, true), maxChars: evidenceBudgetChars + 42000, preservePinned: true }, generationDiagnostics);
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 12, chapter, true), maxChars: evidenceBudgetChars + 32000, preservePinned: true }, generationDiagnostics);
        missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
        resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: preliminaryFactsModel, evidence: scopedEvidence, profile: domainProfile });
        requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
      }
    }
    const retrievalCoverageReport = buildRetrievalCoverageReport({ chapter, evidence, risk: rolePoolRisk });
    retrievalCoverageReports.push(retrievalCoverageReport);
    const chapterEvidenceFiles = new Set(evidence.map(item => item.filePath));
    const chapterEvidenceChars = evidence.reduce((sum, item) => sum + item.content.length, 0);
    const retrievalDetails = [
      ...(rolePoolRisk.highRisk ? [`延迟切片风险：已加载 ${rolePoolRisk.loadedChunks}/${rolePoolRisk.totalChunks}，已启用深召回`] : []),
      `深召回证据：${deepEvidenceCount} 条`,
      `事实覆盖：${retrievalCoverageReport.requiredFactCovered}/${retrievalCoverageReport.requiredFactTotal}`,
      `小节覆盖：${retrievalCoverageReport.sectionCovered}/${retrievalCoverageReport.sectionTotal}`,
    ];
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptPlan.writerPrompts[0]?.id,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 已选取 ${evidence.length} 条高相关证据，正在生成正文`,
      details: [`使用绑定文件：${chapterEvidenceFiles.size} 份`, `上下文字符：${chapterEvidenceChars}`, `检索查询：${Math.min(queries.length, maxSearchQueries)} 组`, ...retrievalDetails],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '正文生成' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    generationDiagnostics.evidence.contextChars += chapterEvidenceChars;
    const indexedFacts = factsForChapterNeeds(resolvedFactNeeds);
    const projectBasicFactsForChapter = /概况|工程|项目|总体|部署|进度|工期|质量/u.test(chapter.title) ? earlyProjectBasicFacts : [];
    const factCoverageContext = buildChapterFactCoverageContext({ chapter, plan: undefined, spec: documentSpec, roleFacts: matchedRoleContexts, evidence, missingFacts, indexedFacts: [...projectBasicFactsForChapter, ...indexedFacts], resolvedFactNeeds, factNeedsPrompt: factNeedsCoveragePrompt(resolvedFactNeeds) });
    const factNeedSummary = { total: resolvedFactNeeds.length, satisfied: resolvedFactNeeds.filter(item => item.status === 'satisfied').length, missing: resolvedFactNeeds.filter(item => item.status === 'missing').length, lowConfidence: resolvedFactNeeds.filter(item => item.status === 'low_confidence').length };
    for (const fact of requiredMissingNeeds) missingItems.push(`${chapter.title}：事实需求未确认 ${fact}`);
    const specChapterRule = documentSpec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title);
    const budgetTarget = documentBudget.chapterTargets.get(chapter.id) || 1200;
    const longformInitialCap = Math.max(3500, Number(process.env.DOCUMENT_LONGFORM_INITIAL_CHAPTER_CAP || 8000));
    const generationTargetCap = documentBudget.longformStrict ? Math.min(budgetTarget, longformInitialCap) : budgetTarget;
    const chapterMaxChars = Math.ceil(generationTargetCap * (documentBudget.maxChars ? 1.1 : 1.18));
    const adaptiveMinimum = documentBudget.targetChars ? Math.min(1800, Math.max(600, Math.floor(generationTargetCap * 0.5))) : 1200;
    const targetWords = generationTargetCap;
    const budgetTargetWords = budgetTarget;
    const minWords = Math.max(Math.min(specChapterRule?.minWords || 0, targetWords), Math.min(documentSpec?.dynamicChapterRule.minWordsPerChapter || 0, targetWords), Math.floor(targetWords * 0.78), adaptiveMinimum);
    const generationMaxTokens = outputTokensForChapter(minWords, targetWords);
    const fallbackRatio = 0.55;
    const fallbackCap = Math.min(targetWords, 6000);
    const fallbackTargetWords = Math.max(900, Math.min(targetWords, Math.ceil(targetWords * fallbackRatio), fallbackCap));
    const fallbackMinWords = Math.max(450, Math.min(minWords, Math.floor(fallbackTargetWords * 0.72)));
    const fallbackMaxWords = Math.max(fallbackTargetWords + 300, Math.min(chapterMaxChars, Math.ceil(fallbackTargetWords * 1.25)));
    const fallbackMaxTokens = outputTokensForChapter(fallbackMinWords, fallbackTargetWords);
    const fallbackTimeoutMs = Math.min(timeoutMsForChapter(fallbackTargetWords), 180000);
    const compactTargetWords = Math.max(900, Math.min(fallbackTargetWords, 3600));
    const compactMinWords = Math.max(450, Math.min(fallbackMinWords, Math.floor(compactTargetWords * 0.72)));
    const compactMaxWords = Math.max(compactTargetWords + 300, Math.min(chapterMaxChars, Math.ceil(compactTargetWords * 1.2)));
    const compactMaxTokens = outputTokensForChapter(compactMinWords, compactTargetWords);
    const compactTimeoutMs = Math.min(timeoutMsForChapter(compactTargetWords), 150000);
    const sectionCount = chapter.sections?.filter(Boolean).length || 0;
    const compositeChapterTitle = /[、，,；;]/u.test(chapter.title);
    const maxSectionFirstSections = Math.max(4, Number(process.env.DOCUMENT_SECTION_FIRST_MAX_SECTIONS || 8));
    const useSectionFirst = Number(process.env.DOCUMENT_SECTION_FIRST_GENERATION ?? 0) !== 0 && sectionCount >= 2 && sectionCount <= maxSectionFirstSections && (documentBudget.longformStrict || !compositeChapterTitle);
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: chapterPromptExecution.primaryPromptId,
      status: 'running',
      message: useSectionFirst ? `${displayChapterTitle(chapter.title)} 正在按小节并发成稿` : `${displayChapterTitle(chapter.title)} 正在整章一次成稿`,
      details: useSectionFirst
        ? [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, `首轮质量目标：约 ${targetWords} 字${budgetTargetWords !== targetWords ? `，总预算分配约 ${budgetTargetWords} 字` : ''}，上限约 ${chapterMaxChars} 字`, `规划小节：${chapter.sections?.length || 0} 个`, '按章节结构拆分小节自然并发生成，章节聚合后再审查修复']
        : [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, `目标字数：约 ${targetWords} 字，上限约 ${chapterMaxChars} 字`, `规划小节：${sectionCount} 个${sectionCount > maxSectionFirstSections ? '，超过小节并发上限，改用整章稳定成稿' : ''}`, '首次生成必须覆盖章节结构、小节、事实和目标篇幅，后置修复仅兜底'],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: useSectionFirst ? '小节并发' : '整章成稿' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    const sectionFirstTimeoutMs = useSectionFirst ? Math.min(timeoutMsForChapter(targetWords) + 30000, 330000) : Math.min(timeoutMsForChapter(targetWords), 180000);
    let llmContent = useSectionFirst
      ? await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-section-draft:${chapter.id}`, () => callWithTimeout(
        signal => buildSectionParallelChapterContent({ template, chapter, evidence, missingFacts, promptTexts: chapterPromptTexts, projectContext, requirement: input.requirement, roleContext, targetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, projectRoot, modelName: getActiveModelWithProvider()?.model.name, materialContextHash: stableHash({ materialFilePaths, promptTexts: chapterPromptTexts }), allowPartialResult: false, sectionEvidenceProvider: sectionTitle => retrieveSectionEvidence({ manager, projectRoot, chapter, sectionTitle, scopedFilePaths, fileRoleByPath, fileProcessingByPath, signal }), diagnostics: generationDiagnostics, signal }),
        sectionFirstTimeoutMs,
        input.signal,
      )))
      : await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, chapterPromptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords, targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext, signal }),
        timeoutMsForChapter(targetWords),
        input.signal,
      )));
    if (!llmContent && useSectionFirst) {
      progressStages[chapterProgressIndex] = displayStage({ type: 'chapter_generation', roleId: 'chapter_generation', promptId: chapterPromptExecution.primaryPromptId, status: 'failed', message: `${displayChapterTitle(chapter.title)} 小节并发未在限定时间内返回，已跳过整章重试并标记为章节阻断`, details: ['小节优先模式不再执行整章重试，避免单章长时间空等；请优先重试失败小节或降低目标篇幅。'], progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '小节超时' } }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      throw new Error(`${chapter.title} 小节并发超时，已跳过整章重试`);
    } else if (!llmContent) {
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 整章成稿未完整返回，正在执行整章重试生成`,
        details: [`目标字数：约 ${targetWords} 字`, `有效证据：${evidence.length} 条`],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '整章重试' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft-fallback:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, chapterPromptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords: fallbackMinWords, targetWords: fallbackTargetWords, maxWords: fallbackMaxWords, maxTokens: fallbackMaxTokens, factCoverageContext, signal }),
        fallbackTimeoutMs,
        input.signal,
      )));
    }
    throwIfAborted(input.signal);
    if (!llmContent) {
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 正在压缩上下文后重试生成`,
        details: ['已压缩证据与上下文后重新请求模型生成', `目标字数：约 ${targetWords} 字`],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '紧凑重试' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft-compact-fallback:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, chapterPromptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords: compactMinWords, targetWords: compactTargetWords, maxWords: compactMaxWords, maxTokens: compactMaxTokens, factCoverageContext, signal }),
        compactTimeoutMs,
        input.signal,
      )));
    }
    throwIfAborted(input.signal);
    if (!llmContent) {
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'fallback',
        message: `${displayChapterTitle(chapter.title)} 大模型未返回有效正文，已使用真实证据构建可审查草稿`,
        details: [`LLM 最近错误：${generationDiagnostics.llm.lastError || '空响应或超时'}`, `证据条数：${evidence.length}`],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '证据兜底草稿' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      llmContent = buildEvidenceBackedChapterFallback(chapter, evidence, fallbackTargetWords);
    }
    let chapterContent = llmContent;
    const generatedSectionTitles = extractGeneratedSections(chapterContent);
    const chapterForValidation = generatedSectionTitles.length >= Math.min(3, chapter.sections?.length || 3)
      ? { ...chapter, sections: generatedSectionTitles }
      : chapter;
    let chapterSectionGaps = criticalChapterSectionGaps(chapterContent, chapterForValidation);
    let sectionRepairRound = 0;
    let previousGapSignature = chapterSectionGaps.map(gap => `${gap.sectionTitle}:${gap.reason}:${gap.bodyLength}`).join('|');
    while (chapterSectionGaps.length > 0) {
      sectionRepairRound += 1;
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 存在 ${chapterSectionGaps.length} 个小节缺口，正在按目标缺口强制补写`,
        details: chapterSectionGaps.map(gap => gap.message),
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: `小节补写第 ${sectionRepairRound} 轮` },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      const contentBeforeSectionRepair = chapterContent;
      const repairedSectionContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-section-repair:${chapter.id}:${sectionRepairRound}`, () =>
        supplementShortSections({ template, chapter, content: contentBeforeSectionRepair, evidence, missingFacts, promptTexts: chapterPromptTexts, projectContext, requirement: input.requirement, roleContext, targetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, forcedSections: chapterSectionGaps, signal: input.signal })
      ));
      if (repairedSectionContent?.trim()) chapterContent = repairedSectionContent;
      chapterSectionGaps = criticalChapterSectionGaps(chapterContent, chapterForValidation);
      const currentGapSignature = chapterSectionGaps.map(gap => `${gap.sectionTitle}:${gap.reason}:${gap.bodyLength}`).join('|');
      const hasSectionProgress = currentGapSignature !== previousGapSignature;
      if (chapterSectionGaps.length === 0) break;
      if (!hasSectionProgress) break;
      previousGapSignature = currentGapSignature;
    }
    if (chapterSectionGaps.length > 0) {
      progressStages[chapterProgressIndex] = displayStage({ type: 'chapter_generation', roleId: 'chapter_generation', promptId: chapterPromptExecution.primaryPromptId, status: 'failed', message: `${displayChapterTitle(chapter.title)} 小节补齐仍未完全达标，已标记为阻断问题`, details: chapterSectionGaps.map(gap => gap.message), progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '小节未达标' } }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
    }
    const localIssues = lightweightChapterIssues({ chapter, content: chapterContent, missingFacts, targetWords });
    const localSeverity = qualitySeveritySummary(localIssues);
    generationDiagnostics.quality.blockingCount += localSeverity.blocking;
    generationDiagnostics.quality.importantCount += localSeverity.important;
    generationDiagnostics.quality.minorCount += localSeverity.minor;
    const blockingIssues = blockingChapterIssues(localIssues);
    if (blockingIssues.length > 0) {
      const contentBeforeRepair = chapterContent;
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 正在根据质量问题修复章节：${blockingIssues.length} 个阻断问题`,
        details: blockingIssues,
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节修复' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      const repairResult = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-repair:${chapter.id}`, () =>
        repairChapterByQuality({ template, chapter: { id: chapter.id, title: chapter.title, content: contentBeforeRepair, evidence, missingFacts: [...missingFacts, ...requiredMissingNeeds.map(item => `事实需求未确认：${item}`)], sections: chapter.sections || [] }, issues: blockingIssues, promptTexts: chapterPromptTexts, requirement: input.requirement, forbidDrawingImages, diagnostics: generationDiagnostics, signal: input.signal })
      ));
      chapterContent = repairResult.content;
      if (repairResult.appliedCount > 0) generationDiagnostics.quality.repairedCount += 1;
      throwIfAborted(input.signal);
    }
    if (!chapterContent.trim()) {
      throw new Error(`${displayChapterTitle(chapter.title)} 首次生成失败，未获得可用于定稿的正文`);
    }
    let content = chapterContent;
    let expandRounds = 0;
    const needsExpansion = documentTextLength(content) < Math.floor(targetWords * 0.82) || blockingChapterIssues(lightweightChapterIssues({ chapter, content, missingFacts, targetWords })).length > 0;
    if (needsExpansion) {
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 首次成稿未达定稿门槛，正在定向扩写`,
        details: [`当前 ${documentTextLength(content)} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字`, `章节并发：${chapterConcurrency}`],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节扩写' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      const expandedChapter = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-expand:${chapter.id}`, () =>
        expandChapterToTarget({ template, chapter, content: chapterContent, evidence, promptTexts: chapterPromptTexts, requirement: input.requirement, roleContext, targetChars: Math.floor(targetWords * 0.95), maxChars: chapterMaxChars, forbidDrawingImages, maxTokens: Math.min(generationMaxTokens, fallbackMaxTokens), signal: input.signal })
      ));
      content = expandedChapter.content;
      expandRounds = expandedChapter.rounds;
    }
    content = finalizeChapterContentQuality(content, chapter);
    let validationSections = extractGeneratedSections(content);
    let postGenerationGaps = collectSectionContentGaps(content, [{ title: chapter.title, content, sections: validationSections }])
      .filter(gap => gap.reason === 'empty' || gap.reason === 'table_only');
    reportGenerationDebugEvent(projectRoot, { event: 'section-repair-check', hypothesisId: 'H1', chapterId: chapter.id, chapterTitle: chapter.title, gapCount: postGenerationGaps.length, gaps: postGenerationGaps.slice(0, 10).map(gap => ({ title: gap.sectionTitle, reason: gap.reason, message: gap.message })), contentChars: documentTextLength(content), targetWords });
    if (postGenerationGaps.length > 0) {
      progressStages[chapterProgressIndex] = displayStage({ type: 'chapter_generation', roleId: 'chapter_generation', promptId: chapterPromptExecution.primaryPromptId, status: 'running', message: `${displayChapterTitle(chapter.title)} 正在小节级定向补写 ${postGenerationGaps.length} 个未达标小节`, details: postGenerationGaps.slice(0, 8).map(gap => gap.message), progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '小节补写' } }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      content = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `section-repair:${chapter.id}`, () => supplementShortSections({ template, chapter, content, evidence, missingFacts, promptTexts: chapterPromptTexts, projectContext, requirement: input.requirement, roleContext, targetWords: Math.max(1200, Math.floor(targetWords * 0.35)), maxWords: Math.min(chapterMaxChars, Math.max(2400, Math.floor(targetWords * 0.55))), forbidDrawingImages, factCoverageContext, forcedSections: postGenerationGaps, signal: input.signal })));
      content = finalizeChapterContentQuality(content, chapter);
      validationSections = extractGeneratedSections(content);
      postGenerationGaps = collectSectionContentGaps(content, [{ title: chapter.title, content, sections: validationSections }])
        .filter(gap => gap.reason === 'empty' || gap.reason === 'table_only');
      if (postGenerationGaps.length === 0) generationDiagnostics.quality.repairedCount += 1;
    }
    const factUsageIssues = chapterSectionFactUsageIssues({ chapter, content, evidence });
    const chapterChars = documentTextLength(content);
    const generatedSectionsForReview = extractGeneratedSections(content);
    const sections = generatedSectionsForReview.length > 0 ? generatedSectionsForReview : chapter.sections || [];
    const expandedSectionIssues = sectionContentIntegrityIssues(content, [{ title: chapter.title, content, sections }]).map(issue => issue.message);
    const factUsageWarnings = factUsageIssues.slice(0, 6).map(issue => `小节事实密度需优化：${issue}`);
    const chapterIssues = [...lightweightChapterIssues({ chapter: { ...chapter, sections }, content, missingFacts, targetWords }), ...expandedSectionIssues, ...factUsageWarnings];
    const chapterStatus = chapterCompletionStatus(chapterChars, targetWords, chapterIssues);
    latestChapterStageForProgress = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: chapterPromptExecution.primaryPromptId,
      status: chapterStatus,
      message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已由大模型首轮成稿${expandRounds > 0 ? `并定向扩写 ${expandRounds} 轮` : ''}：当前 ${chapterChars} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字${chapterStatus !== 'success' ? `；风险：${chapterIssues.join('、') || '篇幅未达标'}` : ''}`, chapterStartedAt),
      details: [`达标率：${Math.round(chapterChars / Math.max(1, Math.floor(targetWords * 0.95)) * 100)}%`, ...chapterPromptDetails, `二级小节：${sections.length} 个`, `扩写轮次：${expandRounds}`],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: chapterStatus === 'success' ? '章节达标' : '章节风险' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    chapterGenerationStagesByOrder[chapterOrder] = latestChapterStageForProgress;
    const draftChapter = { id: chapter.id, title: chapter.title, content, evidence, missingFacts, sections };
    chapterDraftsByOrder[chapterOrder] = draftChapter;
    chapterDrafts = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
    emitProgress(chapterDrafts);
    const finalIssues = lightweightChapterIssues({ chapter, content, missingFacts, targetWords });
    const finalSeverity = qualitySeveritySummary(finalIssues);
    generationDiagnostics.quality.blockingCount += finalSeverity.blocking;
    generationDiagnostics.quality.importantCount += finalSeverity.important;
    generationDiagnostics.quality.minorCount += finalSeverity.minor;
    } catch (err) {
      if (input.signal?.aborted) throw err;
      console.error(`[gen] chapter ${chapter.title} failed:`, err);
      failedChapterMessages.push(`${chapter.title}：${err instanceof Error ? err.message : '生成失败'}`);
      chapterGenerationStagesByOrder[chapterOrder] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'failed',
        message: `${displayChapterTitle(chapter.title)} 生成失败`,
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    }
    // 章节生成完成（成功或失败）→ 汇报进度
    if (latestChapterStageForProgress) progressStages[chapterProgressIndex] = latestChapterStageForProgress;
    emitProgress(chapterDrafts);
    }));
  }
  const chapterDraftsFinal = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
  chapterGenerationStages.push(...chapterGenerationStagesByOrder.filter((item): item is DocumentExecutionStage => Boolean(item)));

  return finalizeGeneration({
    chapterDrafts: chapterDraftsFinal, chapterDraftsByOrder, chapterGenerationStagesByOrder,
    chapterGenerationStages, effectiveChapters, template, allEvidence,
    progressStages,
    documentSpec, projectMaterialProfile, projectMaterialSummary,
    domainProfile, documentBudget, promptTexts, reviewPromptTexts,
    input,
    generationStrategy, generationDiagnostics,
    promptBindings, promptDocumentRules,
    projectUnderstanding, projectContext, projectRoot, projectId, readiness,
    factExtractionPromptTexts,
    hasExplicitOutline, missingItems, retrievalCoverageReports,
    failedChapterMessages, webResearchReport, indexHealth, promptPlan,
    emitProgress, withProgressHeartbeat,
  });
}

export async function regenerateDocumentChapter(input: { templateId: string; chapterId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; documentId?: string; currentMarkdown?: string; existingFacts?: string[] }): Promise<DocumentDraftChapter> {
  const template = getDocumentTemplate(input.templateId);
  if (!template) throw new Error('Document template not found');
  const chapter = template.chapters.find(item => item.id === input.chapterId);
  if (!chapter) throw new Error('Document chapter not found');
  const projectRoot = path.resolve(input.projectRoot || getProjectRoot());
  if (!projectRoot) throw new Error('No knowledge base project found');
  const manager = getMultiProjectManager();
  const materialFilePaths = expandProjectMaterialBindings(projectRoot, template);
  const projectMaterialProfile = buildProjectMaterialProfile(projectRoot, template);
  const { kindByPath, processingByPath } = materialKindMaps(projectMaterialProfile);
  const boundFilePaths = new Set(materialFilePaths);
  const fileRoleByPath = new Map([...kindByPath.entries()].map(([filePath, kind]) => [filePath, materialRoleId(kind)] as const));
  const fileProcessingByPath = new Map([...processingByPath.entries()].map(([filePath, processing]) => [filePath, processing] as const));
  const project = await manager.getProject(projectRoot);
  const requestedEvidencePerChapter = resolveDocumentGenerationEvidenceLimit(project, [...boundFilePaths], input.maxEvidencePerChapter);
  const rawEvidence: DocumentEvidence[] = [];
  const scopedFilePaths = [...boundFilePaths].filter(Boolean).sort();
  const queries = compactChapterQueries(chapter, chapter.queries, []);
  const maxSearchQueries = qualityFirstSearchQueryLimit(chapter, []);
  for (const query of queries.slice(0, maxSearchQueries)) {
    const result = await manager.search(projectRoot, query, {
      scope: 'project',
      filters: { filePaths: scopedFilePaths },
      limit: Math.min(requestedEvidencePerChapter, 12),
      weights: { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
    });
    rawEvidence.push(...result.results
      .filter((item: KbSearchResult) => evidenceInScope(projectRoot, item.filePath, boundFilePaths))
      .map((item: KbSearchResult) => ({
        chapterId: chapter.id,
        filePath: item.filePath,
        score: item.score,
        content: item.content,
        roleId: fileRoleByPath.get(item.filePath),
        processingType: fileProcessingByPath.get(item.filePath),
        sectionTitle: item.sectionTitle,
        source: item.source,
      })));
  }
  const scopedEvidence = rawEvidence.filter(item => evidenceInScope(projectRoot, item.filePath, boundFilePaths));
  const evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter, chapter), maxChars: 16000, preservePinned: true });
  const existingContext = input.currentMarkdown || '';
  const existingFactSet = new Set(input.existingFacts ?? []);
  const missingFacts = chapter.requiredFacts.filter(fact => !existingFactSet.has(fact) && !evidence.some(item => evidenceMatchesFact(item, fact)));
  const content = [
    `## ${chapter.title}`,
    '',
    input.requirement ? `> 生成要求：${input.requirement}` : '',
    existingContext ? `> 当前文档上下文摘要：${existingContext.replace(/\s+/gu, ' ')}` : '',
    evidence.length > 0 ? `本章根据知识库资料围绕“${chapter.purpose}”重新整理，并与当前文档上下文保持一致。` : '系统暂未检索到足够证据，建议扩大本地知识库检索后复核。',
    '',
    evidence.length > 0 ? '### 资料依据' : '',
    ...evidence.map(evidenceLine),
    '',
    missingFacts.length > 0 ? '### 待确认事项' : '',
    ...missingFacts.map(item => `- ${item}：建议扩大本地知识库检索、事实补抽或人工复核系统落位结果。`),
  ].filter(Boolean).join('\n');
  return { id: chapter.id, title: chapter.title, content, evidence, missingFacts };
}
