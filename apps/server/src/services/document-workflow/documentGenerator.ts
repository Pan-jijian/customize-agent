import * as path from 'node:path';
import { computeProjectId } from '@customize-agent/knowledge';
import { getMultiProjectManager, getProjectKbRoot, getProjectRoot } from '../knowledge/kbService';
import { getConfigStore } from '../common/configService';
import { getProjectRoleConfig } from '../document-core/documentRoleService';
import { autoSpecPrompt, getOrCreateAutoDocumentSpec } from '../document-core/autoDocumentSpecService';
import { buildProjectMaterialSummary, projectMaterialPrompt } from '../document-core/projectMaterialService';
import { resolveDocumentDomainProfile } from '../document-core/documentDomainProfileService';
import { evaluateDocumentReadiness, readinessPrompt } from '../document-validation/documentReadinessService';
import type { KbSearchResult } from '@/lib/api';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, GeneratedDocumentDraft, RetrievalCoverageReport, WebAccessConfig } from './types';
import { buildPromptBindingPlan, defaultProjectRoleConfigIdForTemplate, getDocumentTemplate } from './templateStore';
import { evidenceLine, evidencePromptBudgetForTarget, isExemptEvidenceSource, selectEvidenceByBudget } from './evidence';
import { displayChapterTitle, effectiveTemplateChapters, extractExplicitOutlineFromSources } from './outline';
import { evidenceMatchesFact } from './factMatching';
import { plannedStructurePrompt, extractGeneratedSections } from './markdownComposer';
import { buildDocumentBudget, documentTextLength } from './budget';
import { sectionContentIntegrityIssues, crossChapterConsistencyIssues, processSpecConflictIssues, applyDeterministicConsistencyFixes } from './qualityValidation';
import { buildDocumentBlueprintContext } from './documentBlueprint';
import { enrichConstructionOrgOutline } from './constructionOrgCatalog';
import { validateBidStructureBeforeGeneration, extractEvaluationCriteriaItems, chapterCriteriaText } from './constructionBidStructure';
import { buildSemanticSimilarity } from './semanticSimilarity';
import { buildWritingTaskBrief } from './documentWritingTaskBrief';
import { buildConstructionOrgTablePlans, tablePlanExecutionGaps } from './constructionOrgTablePlan';
import { buildRetrievalCoverageReport, retrieveDeepChapterEvidence, retrievalCoverageRisk } from './documentEvidenceRetrieval';
import { buildChapterFactNeeds, extractPreciseFactsFromEvidence, extractProjectBasicFactsFromEvidence, extractStructuredFacts, extractStructuredTables, buildFactsModel, factNeedsCoveragePrompt, factsForChapterNeeds, resolveChapterFactNeeds } from './factsModel';
import { adaptiveConcurrency, comparableSectionTitleText, runWithAdaptiveConcurrency, Semaphore, stableHash, throwIfAborted, WORK_PACKAGE_SECTION_RE } from './utils';
import { displayStage, elapsedMessage, upsertProgressStage } from './progress';
import { getActiveModelWithProvider, raiseDocumentLlmConcurrencyForScale } from './llmClient';
import { createGenerationDiagnostics, evidenceInScope, measureGenerationStep, promptTextsForResolvedPrompts, repairChapterByQuality, selectDocumentGenerationStrategy } from './rolePipeline';
import { buildGenerationBudget, type GenerationBudget } from './generationBudget';
import { buildProjectMaterialProfile, buildProjectUnderstanding, expandProjectMaterialBindings, materialKindMaps, materialRoleId, retrievePlannedMaterialEvidence, sampleProjectMaterialEvidence } from './projectMaterialProfile';
import { buildChapterFactCoverageContext, buildLlmChapterContent, buildLlmSectionContent, buildPlannedChapterContent, buildSectionParallelChapterContent, criticalSectionBlockerMinChars, evidenceForSection, outputTokensForChapter } from './chapterGeneration';
import { planChapterStructure, plannedSectionCoverageMap, cleanInputSections, type PlannedChapterStructure } from './chapterPlanner';
import { QUANTIFIED_FACT_RE } from './parameterPatterns';
import { buildEvidenceOnlyChapterContent } from './chapterExpansion';
import { chapterSectionFactUsageIssues, reviewGlobalConsistency } from './chapterReview';
import { buildRuntimePromptRules, extractPromptStructuralRules, normalizePlannedSections, planChapterSectionsWithLlm, runtimePromptRulesPrompt } from './promptRuleExtraction';
import { retrieveWebEvidence, webAccessPrompt } from './webResearchService';
import { finalizeGeneration } from './documentPipeline';
import { anchorTitleForSection, chapterCompletionStatus, chapterGenerationTargets, collectProjectBasicEvidence, compactChapterQueries, finalizeChapterContentQuality, hasDepthWarningIssues, kbIndexHealth, optimizeChapterEvidence, PROJECT_BASIC_FACT_QUERIES, qualityFirstEvidenceItemLimit, qualityFirstSearchQueryLimit, repairTargetWordsForSection, resolveChapterPromptExecution, resolveDocumentGenerationEvidenceLimit, retrieveSectionEvidence, searchWeightsForChapter, semanticEvidenceText } from './documentGeneratorHelpers';
import { buildProjectGraph } from './projectGraph';
import { referenceQualityTargetLines, referenceWritingSkeletonLines } from './templateReferenceService';
import { buildScopedProjectIntelligence, constructionOrganizationPrompt } from './projectIntelligence';
import { assertEvidenceInProjectScope, createProjectMaterialScope, filterEvidenceByProjectScope, filterFactsByProjectScope, projectScopeAudit } from './projectMaterialScope';
import { agentWorkflowStages, createAgentWorkflowContext, throttleAgentWorkflowNodes } from './agentWorkflow';
import { buildTargetedRepairInstruction, chapterTaskPrompt, chapterTaskPromptForPlannedStructure, planChapterTask, planDocument, reviewChapterDraft } from './agentPlanner';
import { buildCanonicalFactModel, governEvidenceValues, PROJECT_BASIC_FIELD_SPECS, renderScopeOverrideAnchors } from './factGovernance';
import { buildChapterReadinessPlan } from './chapterReadiness';
import { chineseTokenMatch } from './textMatch';

/** P3：按剩余问题类型粗略预估还需的修复轮次（深度/补写类每轮约修复 2 小节，其他类 1 轮） */
function estimateRemainingRepairRounds(issues: Array<{ message: string }>): number {
  const depthCount = issues.filter(issue => /正文不足，未达到任务最小深度|Writer 未完成/u.test(issue.message)).length;
  const otherCount = issues.length - depthCount;
  return Math.max(depthCount > 0 ? Math.ceil(depthCount / 2) : 0, otherCount > 0 ? 1 : 0);
}

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
    details: [`当前项目：${projectId}`, `资料目录：${getProjectKbRoot(projectRoot)}`, '正在读取项目资料包和提示词配置'],
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
  const preflightScope = createAgentWorkflowContext({ template, requirement: input.requirement, projectRoot, facts: [] });
  const materialFilePaths = preflightScope.materialScope.selectedFiles;
  if (materialFilePaths.length === 0) throw new Error('模板未绑定可用项目资料包，请先在模板中绑定需要参与生成的项目文件夹。');
  const projectMaterialProfile = buildProjectMaterialProfile(projectRoot, template, { requirement: input.requirement });
  let projectUnderstanding = buildProjectUnderstanding(template, projectMaterialProfile);
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
  const projectMaterialScope = createProjectMaterialScope(projectId, [...availableEvidenceScopePaths]);
  const requestedEvidencePerChapter = resolveDocumentGenerationEvidenceLimit(project, [...availableEvidenceScopePaths], input.maxEvidencePerChapter);
  const indexHealthHasActionableWarning = indexHealth.pendingJobs > 0 || indexHealth.usableChunkCount === 0;
  const rolePoolRisk = retrievalCoverageRisk({ totalChunks: Math.min(indexHealth.usableChunkCount, materialFilePaths.length * 20), loadedChunks: Math.min(indexHealth.usableChunkCount, materialFilePaths.length * 20), vectorReady: indexHealth.vectorStatus ? indexHealth.vectorStatus.status === 'ready' : undefined });
  upsertProgressStage(progressStages, displayStage({
    type: 'knowledge_retrieval',
    roleId: 'knowledge-index',
    status: indexHealthHasActionableWarning ? 'failed' : 'success',
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
  const searchCache = new Map<string, KbSearchResult[]>();
  const fileDetailCache = new Map<string, ReturnType<NonNullable<typeof project.getFileDetail>>>();
  const getCachedFileDetail = (relativePath: string, options: { maxChunkContentChars: number }) => {
    const key = `${relativePath}::${options.maxChunkContentChars}`;
    if (!fileDetailCache.has(key)) {
      try {
        fileDetailCache.set(key, project.getFileDetail?.(relativePath, options));
      } catch {
        fileDetailCache.set(key, undefined);
      }
    }
    return fileDetailCache.get(key);
  };
  const searchWithCache = async (query: string, scopedFilePaths: string[], limit: number, chapterTitle: string) => {
    const weights = searchWeightsForChapter(chapterTitle);
    const key = stableHash({ query, scopedFilePaths, limit, weights, generationMode: false });
    const cached = searchCache.get(key);
    if (cached) return cached;
    const result = await manager.search(projectRoot, query, {
      scope: 'project',
      filters: { filePaths: scopedFilePaths },
      limit,
      weights,
      generationMode: false,
    }).catch(() => null);
    const results = result?.results || [];
    searchCache.set(key, results);
    return results;
  };
  const projectUnderstandingStage = { stage: displayStage({ type: 'file_understanding', roleId: 'project-understanding', status: 'success', message: `已完成项目资料理解：${projectMaterialProfile.files.length} 份资料，${Object.values(projectMaterialProfile.groups).filter(files => files.length > 0).length} 类资料类型`, details: projectUnderstanding.prompt.split('\n').slice(0, 16) }, { subtitle: '项目资料理解', order: progressStages.length }) };
  upsertProgressStage(progressStages, projectUnderstandingStage.stage);
  emitProgress();
  const projectBasicEvidence = filterEvidenceByProjectScope(await collectProjectBasicEvidence({ manager, project, projectRoot, scopedFilePaths: [...evidenceScopePaths].filter(Boolean).sort(), fileRoleByPath, fileProcessingByPath, signal: input.signal }), projectMaterialScope);
  assertEvidenceInProjectScope(projectBasicEvidence, projectMaterialScope, 'project-basic-evidence');
  if (projectBasicEvidence.length > 0) {
    allEvidence.push(...projectBasicEvidence);
    upsertProgressStage(progressStages, displayStage({ type: 'knowledge_retrieval', roleId: 'project-basic-evidence', status: 'success', message: `已锁定项目基础事实证据 ${projectBasicEvidence.length} 条`, details: projectBasicEvidence.slice(0, 8).map(item => `${path.basename(item.filePath)}｜${item.sectionTitle || '正文片段'}｜score=${item.score.toFixed(2)}`) }, { subtitle: '基础事实召回', order: progressStages.length }));
    emitProgress();
  }
  const earlyLocalFacts = filterFactsByProjectScope(extractStructuredFacts(allEvidence, template, documentSpec), projectMaterialScope);
  const earlyProjectBasicFacts = filterFactsByProjectScope(extractProjectBasicFactsFromEvidence(allEvidence), projectMaterialScope);
  const earlyPreciseFacts = filterFactsByProjectScope(extractPreciseFactsFromEvidence(allEvidence, domainProfile), projectMaterialScope);
  const preliminaryFacts = [...earlyLocalFacts, ...earlyProjectBasicFacts, ...earlyPreciseFacts];
  const scopedIntelligence = buildScopedProjectIntelligence({ projectRoot, template, requirement: input.requirement });
  const intelligenceFacts = scopedIntelligence?.facts || [];
  const combinedPreliminaryFacts = [...intelligenceFacts, ...preliminaryFacts];
  const preliminaryFactsModel = buildFactsModel(combinedPreliminaryFacts, filterFactsByProjectScope(extractStructuredTables(allEvidence), projectMaterialScope), missingItems, documentSpec, domainProfile);
  const agentWorkflow = createAgentWorkflowContext({ template, requirement: input.requirement, projectRoot, facts: combinedPreliminaryFacts, projectGraph: scopedIntelligence?.projectGraph, projectGraphSource: scopedIntelligence ? 'project-intelligence' : undefined });
  for (const stage of agentWorkflowStages(agentWorkflow)) upsertProgressStage(progressStages, stage);
  if (scopedIntelligence) upsertProgressStage(progressStages, displayStage({ type: 'file_understanding', roleId: 'project-intelligence-cache', status: 'success', message: `已复用入库后项目理解资产与绑定 scope 快照：${scopedIntelligence.files.length} 份绑定资料`, details: [`项目级缓存时间：${new Date(scopedIntelligence.cache.createdAt).toLocaleString()}`, `scope 快照：${scopedIntelligence.scopeSnapshot.scopeHash.slice(0, 12)}`, `复用预计算事实：${scopedIntelligence.facts.length} 条`, `复用预计算项目图谱：${scopedIntelligence.projectGraph.works.length}工程/${scopedIntelligence.projectGraph.methods.length}工法/${scopedIntelligence.projectGraph.resources.length}资源`, `复用施工组织设计专项图谱：${scopedIntelligence.constructionOrganizationGraph.workPackages.length} 个工作包/${scopedIntelligence.constructionOrganizationGraph.controlMatrix.length} 条控制矩阵`, `图谱来源：${scopedIntelligence.cache.projectGraphMessage}`, `章节意图证据覆盖：${Object.keys(scopedIntelligence.evidenceByChapterId || {}).length}/${template.chapters.length} 章`, `排除正文不适用资料：${scopedIntelligence.files.filter(file => !file.usableForBody).length} 份`] }, { subtitle: '项目理解缓存 / Scope 快照' }));
  emitProgress();

  // ===== 项目资料图谱：命中 project-intelligence 时复用入库后完整项目图谱；缓存缺失时临时构建完整项目图谱 =====
  let projectGraph = agentWorkflow.baseProjectGraph;
  if (!scopedIntelligence) {
    upsertProgressStage(progressStages, displayStage({
      type: 'file_understanding', roleId: 'project-graph', status: 'running',
      message: `正在临时构建完整项目图谱：${allEvidence.length} 条证据 → LLM 结构化提取`,
      details: ['缓存缺失或版本过期，建议重新构建项目理解缓存；本次生成将临时构建完整项目图谱。', '提取：工程内容、施工方法、材料设备、技术标准、重点难点'],
      progress: { current: 2, total: 3, label: '项目图谱' },
    }, { subtitle: '项目资料图谱分析', order: progressStages.length }));
    emitProgress();
    // generationDiagnostics 在此函数后半段才初始化，临时图谱构建路径不依赖诊断统计，不传 diagnostics 避免 TDZ
    const projectGraphResult = await withProgressHeartbeat(() => buildProjectGraph({ evidence: allEvidence, signal: input.signal, projectRoot, requirement: input.requirement, templateId: template.id }), progressStages);
    if (!projectGraphResult.graph) throw new Error(`完整项目图谱构建失败：${projectGraphResult.stage.message || projectGraphResult.stage.status}`);
    projectGraph = projectGraphResult.graph;
    upsertProgressStage(progressStages, projectGraphResult.stage);
    emitProgress();
  }
  if (projectGraph) projectUnderstanding = buildProjectUnderstanding(template, projectMaterialProfile, projectGraph);
  const canonicalFacts = buildCanonicalFactModel({ facts: combinedPreliminaryFacts, projectGraph, requiredKeys: PROJECT_BASIC_FIELD_SPECS.map(spec => spec.key), projectRoot, requirement: input.requirement, templateId: template.id });
  preliminaryFactsModel.canonical = canonicalFacts;

  // 构建章节→图谱节点映射：将图谱中的 works/methods/resources 按章节标题匹配
  const rawEffectiveChapters = effectiveTemplateChapters(template, documentSpec, { preserveExplicitOutline: hasExplicitOutline });
  const outlineEnrichment = enrichConstructionOrgOutline({ template, chapters: rawEffectiveChapters, requirement: input.requirement });
  const enrichedOutlineChapters = outlineEnrichment.chapters;
  // 评分标准条目提取：从绑定招标材料中定位技术评审章节的编号条目（对象化，不再 slice(0,600) 词面过滤），
  // 并以本地 bge-small 嵌入构建“条目标题 ↔ 大纲章节”语义相似度函数供承接审计使用（嵌入不可用时审计自动降级为显式承接判定）
  const evaluationSourceTexts = allEvidence
    .filter(item => /评审|评分标准|评分办法|详细评审/u.test(`${item.sectionTitle || ''}${item.content}`))
    .map(item => item.content);
  const evaluationItems = extractEvaluationCriteriaItems(evaluationSourceTexts);
  const criteriaSimilarity = await buildSemanticSimilarity(
    evaluationItems.map(item => item.title),
    enrichedOutlineChapters.map(chapterCriteriaText),
  );
  const bidStructureAudit = validateBidStructureBeforeGeneration({ template, chapters: enrichedOutlineChapters, requirement: input.requirement, evaluationItems, semanticSimilarity: criteriaSimilarity });
  const baseEffectiveChapters = buildConstructionOrgTablePlans({ chapters: bidStructureAudit.enrichedChapters, projectGraph, canonicalFacts });
  template = { ...template, chapters: baseEffectiveChapters };
  const chapterGraphMap = new Map<string, { graphFiles: Set<string>; graphBoqItems: Array<{ name: string; quantity: string; unit: string; sourceFiles: string[] }>; graphWorks: string[]; graphMethods: string[]; gaps: string[] }>();
  if (projectGraph) {
    const graphAllFiles = new Set<string>();
    for (const item of [...projectGraph.works, ...projectGraph.methods, ...projectGraph.resources, ...projectGraph.schedule, ...projectGraph.standards, ...projectGraph.risks, ...projectGraph.requirements, ...projectGraph.siteConditions]) (item.sourceFiles || []).forEach(f => graphAllFiles.add(f));
    for (const chapter of baseEffectiveChapters) {
      const chapterScope = [chapter.title, chapter.purpose, ...(chapter.sections || []), ...(chapter.requiredFacts || []), ...(chapter.queries || [])].join(' ');
      const matchesText = (value: string) => value && (chineseTokenMatch(value, chapterScope, 0.18) || chineseTokenMatch(value, chapter.title, 0.12));
      const broadChapter = /概况|总体|部署|施工|进度|工期|质量|安全|资源|人材机|材料|机械|劳动力|风险|危大|绿色|环保/u.test(chapterScope);
      const matchedWorks = projectGraph.works.filter(w => w.name && (matchesText(w.name) || broadChapter));
      const matchedMethods = projectGraph.methods.filter(m => m.name && (matchesText(m.name) || (m.applicableWorks || []).some(matchesText) || broadChapter));
      const matchedResources = projectGraph.resources.filter(r => r.name && (matchesText(r.name) || (/资源|人材机|材料|机械|劳动力/u.test(chapterScope) && /material|equipment|labor/u.test(r.type))));
      const matchedGaps = projectGraph.gaps.filter(g => matchesText(g) || broadChapter);

      const graphFiles = new Set<string>();
      for (const w of matchedWorks) (w.sourceFiles || []).forEach(f => graphFiles.add(f));
      for (const m of matchedMethods) (m.sourceFiles || []).forEach(f => graphFiles.add(f));
      for (const r of matchedResources) (r.sourceFiles || []).forEach(f => graphFiles.add(f));
      if (graphFiles.size === 0 && broadChapter) [...graphAllFiles].slice(0, 12).forEach(f => graphFiles.add(f));

      chapterGraphMap.set(chapter.id, {
        graphFiles,
        graphBoqItems: matchedResources.map(r => ({ name: r.name, quantity: r.quantity, unit: r.unit, sourceFiles: r.sourceFiles || [] })),
        graphWorks: matchedWorks.map(w => w.name),
        graphMethods: matchedMethods.map(m => m.name),
        gaps: matchedGaps,
      });
    }
    if (!scopedIntelligence) {
      upsertProgressStage(progressStages, displayStage({
        type: 'file_understanding', roleId: 'project-graph-match',
        status: 'success',
        message: `图谱→章节映射完成：${projectGraph.works.length}工程 ${projectGraph.methods.length}工法 ${projectGraph.resources.length}资源 → ${baseEffectiveChapters.length}章`,
        details: baseEffectiveChapters.map(c => {
          const m = chapterGraphMap.get(c.id);
          return `${displayChapterTitle(c.title)}：匹配文件${m?.graphFiles.size || 0}个，BOQ项${m?.graphBoqItems.length || 0}个`;
        }),
      }, { subtitle: '图谱章节映射' }));
      emitProgress();
    }
  }
  // ===== 图谱分析结束 =====

  let effectiveChapters = baseEffectiveChapters;
  const constructionOrgContext = constructionOrganizationPrompt(scopedIntelligence?.constructionOrganizationGraph) || scopedIntelligence?.constructionOrganizationContext;
  const baseProjectContext = [projectUnderstanding.prompt, constructionOrgContext].filter(Boolean).join('\n\n');
  let projectContext = [baseProjectContext, buildDocumentBlueprintContext({ template: { ...template, chapters: effectiveChapters }, chapters: effectiveChapters, factsModel: preliminaryFactsModel, requirement: input.requirement, scopeConflicts: canonicalFacts.scopeConflicts })].filter(Boolean).join('\n\n');
  const provisionalTemplate = { ...template, chapters: effectiveChapters };
  const promptStructuralRules = extractPromptStructuralRules([promptTexts, input.requirement || ''].filter(Boolean).join('\n\n'), effectiveChapters);
  const provisionalBudget = buildDocumentBudget({ requirement: input.requirement, promptTexts, template: provisionalTemplate, chapters: effectiveChapters, spec: documentSpec });
  let skippedSectionPlanningCount = 0;
  let llmSectionPlanningCount = 0;
  const plannedChapters = await runWithAdaptiveConcurrency(effectiveChapters.map((chapter, chapterIndex) => ({ chapter, chapterIndex })), async ({ chapter, chapterIndex }) => {
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
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'section-planning', promptId: planningPromptExecution.primaryPromptId, status: sections.length ? 'success' : 'failed', message: `${displayChapterTitle(chapter.title)} 小节规划${sections.length ? `生成 ${sections.length} 个小节` : '未生成可用小节'}`, details: [...planningPromptExecution.promptDetails, ...lockedRuleDetails, ...(sections.length ? sections.map(section => `规划小节：${section}`) : ['规划结果为空或被污染过滤'])] }, { subtitle: '小节规划' }));
    if (!sections.length) throw new Error(`${displayChapterTitle(chapter.title)} 小节规划未生成可用小节`);
    return { ...chapter, sections };
  }, { kind: 'llmRepair', targetWords: provisionalBudget.targetChars || 4000, concurrency: 2 });
  const plannedWithConstructionOrgOutline = enrichConstructionOrgOutline({ template, chapters: plannedChapters, requirement: input.requirement });
  const plannedWithConstructionOrgRequiredSections = plannedWithConstructionOrgOutline.chapters;
  // 标准模块挂靠报告：挂靠量不再被写死上限截断（历史缺陷：50 上限静默丢弃尾部模块小节），
  // 无处安放的可选模块显式可见——宁多勿丢，丢失必可见
  {
    const outlineReport = plannedWithConstructionOrgOutline.report;
    if (outlineReport.unattached.length > 0) {
      upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'construction-org-outline-unattached', status: 'success', message: `标准模块挂靠：${outlineReport.totals.attachedModules} 个模块、${outlineReport.totals.sectionCount} 个小节；${outlineReport.unattached.length} 个可选模块未挂靠（无语义匹配章节，已记录）`, details: outlineReport.unattached.map(item => `未挂靠：${item.moduleTitle}（${item.sections.length} 小节，${item.level}）`) }, { subtitle: '标准模块挂靠' }));
    } else {
      upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'construction-org-outline-attached', status: 'success', message: `标准模块挂靠：${outlineReport.totals.attachedModules} 个模块、${outlineReport.totals.sectionCount} 个小节全部挂靠`, details: outlineReport.attached.map(item => `${item.kind === 'fallback' ? '兜底挂靠' : '挂靠'}：${item.moduleTitle} → ${item.chapterTitle}`) }, { subtitle: '标准模块挂靠' }));
    }
  }
  // 规划后章节文本已变化，重建语义相似度缓存（同一闭包缓存 key 不可跨阶段复用）
  const finalCriteriaSimilarity = await buildSemanticSimilarity(
    evaluationItems.map(item => item.title),
    plannedWithConstructionOrgRequiredSections.map(chapterCriteriaText),
  );
  const finalBidStructureAudit = validateBidStructureBeforeGeneration({ template, chapters: plannedWithConstructionOrgRequiredSections, requirement: input.requirement, evaluationItems, semanticSimilarity: finalCriteriaSimilarity });
  effectiveChapters = buildConstructionOrgTablePlans({ chapters: finalBidStructureAudit.enrichedChapters, projectGraph, canonicalFacts });
  if (finalBidStructureAudit.issues.length > 0 || bidStructureAudit.issues.length > 0) {
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'bid-structure-audit', status: finalBidStructureAudit.issues.some(issue => issue.severity === 'blocker') ? 'failed' : 'success', message: `评标结构符合性校验：${finalBidStructureAudit.diagnostics.length} 个结构组，${finalBidStructureAudit.diagnostics.filter(item => item.status === 'satisfied').length} 个已满足，${finalBidStructureAudit.diagnostics.filter(item => item.status === 'missing' && item.level === 'required').length} 个必查缺失（已自动补挂），${finalBidStructureAudit.diagnostics.filter(item => item.status === 'fragmented').length} 个分散`, details: [...finalBidStructureAudit.diagnostics.map(item => `${item.status === 'satisfied' ? '满足' : item.status === 'fragmented' ? '分散' : '补挂'}：${item.groupTitle}${item.status === 'missing' ? `（补挂小节：${item.missingSections.join('、')}）` : ''}`), ...finalBidStructureAudit.issues.map(issue => `提示：${issue.message}`).slice(0, 8)] }, { subtitle: '评标结构校验' }));
  }
  template = { ...template, chapters: effectiveChapters };
  const writingTaskBrief = buildWritingTaskBrief({ chapters: effectiveChapters, factsModel: preliminaryFactsModel, projectGraph: projectGraph || undefined, requirement: input.requirement, templateName: template.name });
  // T5 蓝图注入：同类工程质量参考（软性参考，按篇幅折减；无同类型参考样本或类型未识别时返回空，不注入）；
  // 写法骨架切片（方案4/E5）：与量化参考同链路注入，补齐“怎么写才像范文”的展开模式描述
  const referenceLines = [
    ...referenceQualityTargetLines({ templateName: template.name, chapterTitles: effectiveChapters.map(chapter => chapter.title), requirement: input.requirement, targetWords: provisionalBudget.targetChars || 0 }),
    ...referenceWritingSkeletonLines({ templateName: template.name, chapterTitles: effectiveChapters.map(chapter => chapter.title), requirement: input.requirement }),
  ];
  if (referenceLines.length > 0) {
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'reference-benchmark', status: 'success', message: '已读取模板参考库同类工程画像，作为质量软性参考注入文档蓝图', details: referenceLines }, { subtitle: '参考画像注入', order: progressStages.length }));
  }
  const documentBlueprintContext = buildDocumentBlueprintContext({ template, chapters: effectiveChapters, factsModel: preliminaryFactsModel, requirement: input.requirement, referenceLines, scopeConflicts: canonicalFacts.scopeConflicts });
  projectContext = [baseProjectContext, documentBlueprintContext].filter(Boolean).join('\n\n');
  if (!scopedIntelligence) {
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-blueprint', status: 'success', message: '已生成全局事实主表与文档蓝图，后续章节和小节将共用同一套专业约束', details: documentBlueprintContext.split('\n').slice(0, 12) }, { subtitle: '全局蓝图' }));
  }
  const documentBudget = buildDocumentBudget({ requirement: input.requirement, promptTexts, template, chapters: effectiveChapters, spec: documentSpec });
  const plannedDocument = planDocument({ template, context: agentWorkflow, title: template.name });
  agentWorkflow.documentPlan = plannedDocument.plan;
  agentWorkflow.nodes.push(plannedDocument.node);
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'agent-document-planner', status: 'success', message: plannedDocument.node.outputSummary || 'Agent 文档规划完成', details: plannedDocument.plan.chapters.map(chapter => `${chapter.title}：${chapter.sections.length} 条细目`) }, { subtitle: 'Agent Document Planner', order: progressStages.length }));
  checkpointChapterOrderIds = effectiveChapters.map(chapter => chapter.id);
  // P1 全局预算模型：生成前按章节数×目标字数×资料量一次性计算并发数、证据预算、审查深度与修复轮次预算
  const budgetTargetWords = documentBudget.targetChars || [...documentBudget.chapterTargets.values()].reduce((sum, value) => sum + value, 0);
  const generationStrategy = selectDocumentGenerationStrategy({ template, targetWords: budgetTargetWords, requirement: input.requirement, materialFileCount: materialFilePaths.length, evidenceCount: allEvidence.length });
  const generationBudget: GenerationBudget = buildGenerationBudget({
    template,
    chapters: effectiveChapters,
    targetWords: budgetTargetWords,
    requirement: input.requirement,
    materialFileCount: materialFilePaths.length,
    evidenceCount: allEvidence.length,
    hasVeryLargeExplicitChapter: effectiveChapters.some(chapter => (chapter.sections || []).filter(Boolean).length >= 30),
    configuredChapterConcurrency: Number(process.env.DOCUMENT_CHAPTER_CONCURRENCY || 0),
    strategy: generationStrategy,
  });
  const generationDiagnostics = createGenerationDiagnostics(generationStrategy);
  // 按文档规模提升全局 LLM 并发上限（8/16/24/32 档）：长文档调用量大，默认 4 并发会线性拉长总耗时；
  // 端点限流由瞬态重试与失败连击降级串行兜底
  raiseDocumentLlmConcurrencyForScale(budgetTargetWords);
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-strategy', status: 'success', message: `已自动选择 ${generationStrategy.mode} 生成策略：章节审查 ${generationStrategy.enableChapterReview ? '启用' : '跳过'}、全局审查 ${generationStrategy.enableGlobalReview ? `${generationStrategy.globalReviewSamplingRate && generationStrategy.globalReviewSamplingRate < 1 ? `抽检 ${Math.round((generationStrategy.globalReviewSamplingRate ?? 1) * 100)}%` : '启用'}` : '跳过'}、最终质量审查 ${generationStrategy.enableFinalQualityReview ? '启用' : '跳过'}、全文扩写 ${generationStrategy.enableDocumentBudgetExpansion ? '启用' : '跳过'}`, details: generationBudget.triggers }, { subtitle: '后台自动策略' }));
  // 源级口径冲突裁决节点：向用户明示补疑修正后的统一口径，避免用户对比资料原文旧值与正文新值时误判为生成错误
  if (canonicalFacts.scopeConflicts.length > 0) {
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'scope-conflict-resolution', status: 'success', message: `源级数据口径冲突已裁决（补疑/澄清修正文件权威最高）：${canonicalFacts.scopeConflicts.map(conflict => conflict.resolution ? `${conflict.scope} → ${conflict.resolution}` : `${conflict.scope} → 待人工复核`).join('；')}`, details: canonicalFacts.scopeConflicts.flatMap(conflict => conflict.values.map(value => `来源「${value.sourceFile || '未知文件'}」取值 ${value.value}${value.unit}`)) }, { subtitle: '数据口径裁决' }));
  }
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
  upsertProgressStage(progressStages, displayStage({ type: 'role_binding', roleId: projectRoleConfigId, status: 'success', message: `已绑定项目资料 ${materialFilePaths.length} 份、${promptPlan.prompts.length} 个有效提示词；写作 ${promptPlan.writerPrompts.length}、章节 ${promptPlan.chapterPrompts.length}、抽取 ${promptPlan.extractionPrompts.length}；已自动抽取运行时规则 ${runtimePromptRules.executionSummary.length} 条${outlineMessage}`, details: [...promptPlanDetails, ...runtimePromptRules.executionSummary.map(item => `runtimeRule｜${item}`)] }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName }));
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'runtime-prompt-rules', status: 'success', message: `运行时提示词规则已抽取：${runtimePromptRules.executionSummary.length} 条，版本 ${runtimePromptRules.sourceHash}`, details: runtimePromptRules.executionSummary.length ? [...runtimePromptRules.executionSummary, `必需表格：${runtimePromptRules.requiredTables.join('、') || '无'}`, `必含关键词：${runtimePromptRules.requiredKeywords?.join('、') || '无'}`, `禁含内容：${runtimePromptRules.forbiddenPatterns?.join('、') || '无'}`] : ['未从提示词中识别到额外硬规则，使用系统默认质量规则'] }, { subtitle: '提示词规则执行' }));
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-readiness', status: readiness.ready ? 'success' : 'failed', message: '生成准备度：绑定资料已就绪', details: readiness.diagnostics }, { subtitle: '生成准备度检查' }));
  upsertProgressStage(progressStages, sectionPlanningStage);
  emitProgress();

  const avgChapterTarget = Math.round(([...documentBudget.chapterTargets.values()].reduce((sum, value) => sum + value, 0) || documentBudget.targetChars || 0) / Math.max(1, effectiveChapters.length));
  const configuredChapterConcurrency = Number(process.env.DOCUMENT_CHAPTER_CONCURRENCY || 0);
  // P1：并发预算统一由预算模型给出；P2：审查修复与生成流水线重叠（审查池与生成批独立限流）
  const chapterConcurrency = generationBudget.chapterConcurrency;
  const reviewConcurrency = generationBudget.reviewConcurrency;
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'chapter-concurrency', status: 'success', message: `章节流水线调度：${effectiveChapters.length} 章全部同批并行生成，审查修复 ${reviewConcurrency} 路流水线（章节生成完立即进入审查，与后续章节生成重叠）`, details: [`有效章节数：${effectiveChapters.length}`, `平均章节目标：${avgChapterTarget} 字`, Number.isFinite(configuredChapterConcurrency) && configuredChapterConcurrency > 0 ? `章节并发来自 DOCUMENT_CHAPTER_CONCURRENCY=${Math.floor(configuredChapterConcurrency)}` : `全部章节并行生成，在飞调用由全局 LLM 并发档位（${generationBudget.llmConcurrency}）统一约束；修复轮次预算 ${generationBudget.repairRoundBudget} 轮`] }, { subtitle: '章节流水线策略' }));
  emitProgress();
  // P4 检索自适应：前序章节"缺事实"信号累积的查询扩展深度（0-2，调高后续章节查询扩展与深召回）
  let searchExpansionBoost = 0;
  // P2 审查流水线：章节生成完成后立即进入审查修复（独立信号量限流），与后续批次章节生成重叠；
  // 跨章引用安全：Repairer 仅修复本章小节，跨章审查与最终门禁在所有章节完成后按章节序执行
  const reviewSemaphore = new Semaphore(reviewConcurrency);
  const reviewTaskPool: Promise<void>[] = [];
  // P1-5 基础事实查询跨章缓存：PROJECT_BASIC_FACT_QUERIES 不含章节标题，概况/质量/进度类章节会并入每章查询集重复全链路检索；
  // 在章节循环外预执行一次（默认权重），章节内直接取用结果
  const basicFactScopePaths = [...availableEvidenceScopePaths].filter(Boolean).sort();
  const basicFactSearchStartedAt = Date.now();
  const basicFactSearchResults = basicFactScopePaths.length > 0
    ? (await runWithAdaptiveConcurrency(PROJECT_BASIC_FACT_QUERIES, async query => searchWithCache(query, basicFactScopePaths, Math.min(requestedEvidencePerChapter, 12), ''), { kind: 'search' })).flat()
    : [];
  generationDiagnostics.evidence.searchQueries += PROJECT_BASIC_FACT_QUERIES.length;
  generationDiagnostics.evidence.searchMs += Date.now() - basicFactSearchStartedAt;
  for (let chapterOffset = 0; chapterOffset < effectiveChapters.length; chapterOffset += chapterConcurrency) {
    const chapterBatch = effectiveChapters.slice(chapterOffset, chapterOffset + chapterConcurrency);
    const batchTasks = await Promise.all(chapterBatch.map(async (chapter, batchIndex): Promise<(() => Promise<void>) | undefined> => {
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
    const resumedChapter = input.resumeChapters?.find(item => item.id === chapter.id || item.title === chapter.title);
    const resumedContent = resumedChapter?.content?.trim();
    const rawEvidence: DocumentEvidence[] = resumedChapter?.evidence?.length ? [...resumedChapter.evidence] : [];
    const plan = projectUnderstanding.chapterPlans.find(item => item.chapterId === chapter.id || item.chapterTitle === chapter.title);
    const planQueries = plan ? Object.values(plan.evidenceQueries).flat().filter(Boolean) : [];
    const baseQueries = chapter.queries.length > 0 ? chapter.queries : [template.name, template.outputTitle, chapter.title];

    // ===== 图谱驱动证据注入：优先拉取图谱匹配文件的切片内容 =====
    const graphMapping = chapterGraphMap.get(chapter.id);
    if (projectGraph && graphMapping && graphMapping.graphFiles.size > 0) {
      const scopedPathList = [...availableEvidenceScopePaths];
      // 模糊路径解析：图谱LLM可能返回短路径（如"招标文件.pdf"），解析为KB精确路径
      const resolveExactPath = (fuzzy: string): string | undefined => {
        if (scopedPathList.includes(fuzzy)) return fuzzy;
        return scopedPathList.find(p => p.endsWith(fuzzy) || p.includes(fuzzy));
      };
      const graphFileList = [...graphMapping.graphFiles]
        .map(f => resolveExactPath(f) || f)
        .filter(f => evidenceInScope(projectRoot, f, availableEvidenceScopePaths))
        .slice(0, 12);
      for (const gf of graphFileList) {
        const detail = getCachedFileDetail(gf, { maxChunkContentChars: 8000 });
        if (!detail?.chunks?.length) continue;
        for (const chunk of detail.chunks as Array<{ content: string; sectionTitle?: string }>) {
          rawEvidence.push({
            chapterId: chapter.id,
            filePath: detail.file?.relativePath || gf,
            score: 5 + (graphMapping.graphWorks.length + graphMapping.graphMethods.length) * 0.5,
            content: chunk.content,
            roleId: fileRoleByPath.get(gf),
            processingType: fileProcessingByPath.get(gf),
            sectionTitle: chunk.sectionTitle,
            source: 'graph-evidence',
          });
        }
      }
    }
    // ===== 图谱驱动证据注入结束 =====

    // P1-5：基础事实查询已跨章预执行缓存（basicFactSearchResults），不再并入本章查询集重复检索
    const usesCachedBasicFacts = /概况|工程|项目|总体|部署|进度|工期|质量/u.test(chapter.title);
    const queries = compactChapterQueries(chapter, [...baseQueries, ...planQueries], []);
    // P4：前序章节缺事实信号累积的扩展深度叠加到本章查询上限
    const maxSearchQueries = qualityFirstSearchQueryLimit(chapter, []) + searchExpansionBoost;
    const searchStartedAt = Date.now();
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptPlan.writerPrompts[0]?.id,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在执行质量优先的章节检索${graphMapping?.graphFiles.size ? `（图谱匹配 ${graphMapping.graphFiles.size} 个文件）` : ''}`,
      details: queries.slice(0, maxSearchQueries).map(query => `检索：${query.slice(0, 42)}`),
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '证据检索' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    const scopedFilePaths = resumedContent ? [] : [...availableEvidenceScopePaths].filter(Boolean).sort();

    const cachedIntentEvidence = resumedContent ? [] : (scopedIntelligence?.evidenceByChapterId?.[chapter.id] || []);
    if (cachedIntentEvidence.length > 0) rawEvidence.push(...cachedIntentEvidence);
    const searchResults: KbSearchResult[][] = [];
    // 优化：KB搜索并行化 — 多组查询并发执行，减少串行I/O等待
    const searchQueries = queries.slice(0, maxSearchQueries);
    // 模板必需事实定向查询并入首轮并行检索：提前命中缺失事实证据，降低后续深召回/补充检索触发概率，减少串行轮次
    const requiredFactSearchQueries = (chapter.requiredFacts || [])
      .filter((fact: string) => Boolean(fact) && !searchQueries.some(query => query.includes(fact) || fact.includes(query)))
      .slice(0, 4)
      .map((fact: string) => `${chapter.title} ${fact}`);
    const mergedSearchQueries = [...searchQueries, ...requiredFactSearchQueries];
    if (scopedFilePaths.length > 0 && mergedSearchQueries.length > 0) {
      throwIfAborted(input.signal);
      const parallelResults = await runWithAdaptiveConcurrency(mergedSearchQueries, async query => searchWithCache(query, scopedFilePaths, Math.min(requestedEvidencePerChapter, 12), chapter.title), { kind: 'search' });
      searchResults.push(...parallelResults);
    }
    generationDiagnostics.evidence.searchQueries += mergedSearchQueries.length;
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
    // P1-5：概况/质量/进度类章节直接取用跨章预执行的基础事实检索结果（resumed 章节跳过，与原检索语义一致）
    if (usesCachedBasicFacts && scopedFilePaths.length > 0 && basicFactSearchResults.length > 0) {
      rawEvidence.push(...basicFactSearchResults
        .filter(item => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths))
        .map(item => ({
          chapterId: chapter.id,
          filePath: item.filePath,
          score: item.score,
          content: item.content,
          roleId: fileRoleByPath.get(item.filePath),
          processingType: fileProcessingByPath.get(item.filePath),
          sectionTitle: item.sectionTitle,
          source: 'basic-fact-cache',
        })));
    }
    const plannedMaterialEvidence = resumedContent ? [] : await retrievePlannedMaterialEvidence({ manager, projectRoot, chapter, plan, profile: projectMaterialProfile, scopedFilePaths, limitPerQuery: Math.min(requestedEvidencePerChapter, 10), signal: input.signal }).catch(() => []);
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
      const detail = getCachedFileDetail(relativePath, { maxChunkContentChars: pinnedEvidenceBudget });
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
    if (!resumedContent && webAccessConfig.enabled && webAccessConfig.allowProjectFacts) {
      const webResult = await retrieveWebEvidence({ config: webAccessConfig, chapterId: chapter.id, chapterTitle: chapter.title, sectionTitles: chapter.sections || [], runtimeRules: runtimePromptRules, localFacts: [...preliminaryFactsModel.project, ...preliminaryFactsModel.schedule, ...preliminaryFactsModel.quality, ...preliminaryFactsModel.safety, ...preliminaryFactsModel.resources, ...preliminaryFactsModel.preciseFacts], signal: input.signal });
      webResearchReport.queries.push(...webResult.queries);
      webResearchReport.filteredCount += webResult.filtered + webResult.evidence.length;
    }
    const evidenceBudgetChars = evidencePromptBudgetForTarget(chapterBudgetTarget, generationBudget.evidenceFloorChars, generationBudget.evidenceCeilingChars);
    const sampledEvidence = resumedContent ? [] : sampleProjectMaterialEvidence({ project, chapter, plan, profile: projectMaterialProfile, scopedFilePaths, highRisk: rolePoolRisk.highRisk });
    if (sampledEvidence.length > 0) scopedEvidence.push(...filterEvidenceByProjectScope(sampledEvidence, projectMaterialScope));
    scopedEvidence = filterEvidenceByProjectScope(scopedEvidence, projectMaterialScope);
    // P1 语义排序：章节证据按“章查询 ↔ 证据文本”本地 bge-small 余弦排序（语义主键，预算只做最终兑底）。
    // 候选池先按词面/重要性分数粗排收窄到 60 条（pinned 证据全保留）控制嵌入批量规模；
    // 嵌入不可用时语义选项缺省，优化退化为原 score 口径（语义模型不可用不得阻断生成）
    const semanticPool = scopedEvidence.length > 60
      ? [...new Set([...scopedEvidence.filter(item => isExemptEvidenceSource(item)), ...[...scopedEvidence].sort((a, b) => b.score - a.score).slice(0, 60)])]
      : scopedEvidence;
    const chapterSemanticSimilarity = await buildSemanticSimilarity([chapterCriteriaText(chapter)], semanticPool.map(semanticEvidenceText));
    let evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter, chapter, rolePoolRisk.highRisk), maxChars: evidenceBudgetChars + (rolePoolRisk.highRisk ? 14000 : 4000), preservePinned: true, semantic: chapterSemanticSimilarity ? { similarity: chapterSemanticSimilarity, queryText: chapterCriteriaText(chapter) } : undefined }, generationDiagnostics);
    // 源级同口径裁决前置到证据切片：资料原文（如招标正文 4645㎡）被补疑修正后，进入写作 LLM 的切片必须先改写成裁决值，
    // 否则模型看到原文旧值会照抄（历史缺陷：第 3 章 checkpoint 混用 4645/4646），只能靠事后全局审查修复
    evidence = governEvidenceValues(evidence, canonicalFacts.scopeConflicts);
    assertEvidenceInProjectScope(evidence, projectMaterialScope, `chapter:${chapter.id}:initial`);
    let missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
    let deepEvidenceCount = 0;
    // P1-4：事实需求计算提前到深召回判断之前，把 requiredMissingNeeds 并入深召回一次完成，
    // 避免缺失事实与必需事实需求两次深召回查询集高度重叠
    const forbidDrawingImages = false;
    const graphRoleHint = graphMapping
      ? [
          graphMapping.graphWorks.length ? `图谱识别本章工程内容：${graphMapping.graphWorks.join('、')}` : '',
          graphMapping.graphMethods.length ? `图谱识别本章施工方法：${graphMapping.graphMethods.join('、')}` : '',
          graphMapping.graphBoqItems.length ? `图谱识别本章BOQ清单项（${graphMapping.graphBoqItems.length}项）：${graphMapping.graphBoqItems.slice(0, 30).map(b => `${b.name} ${b.quantity}${b.unit}`).join('、')}` : '',
          graphMapping.gaps.length ? `图谱识别本章资料缺口：${graphMapping.gaps.join('；')}` : '',
        ].filter(Boolean).join('\n')
      : '';
    // 写作任务书不再逐章注入：其“写作目标/必须覆盖/清单目标”与 plan（项目资料理解的章节计划，源自模板+图谱、更项目专属）语义重叠，
    // 全局写作约束由文档蓝图（projectContext）统一承载，逐章 roleContext 保留图谱提示与项目理解的章节计划即可
    const scopeOverrideAnchors = renderScopeOverrideAnchors(canonicalFacts.scopeConflicts);
    const roleContext = [graphRoleHint, scopeOverrideAnchors.length ? `【数据口径强制约束】${scopeOverrideAnchors.join('；')}` : '', plan?.writingGoal, plan?.mustCover?.length ? `本章必须覆盖：${plan.mustCover.join('、')}` : '', plan?.mustUseMaterialKinds?.length ? `本章优先使用资料类型：${plan.mustUseMaterialKinds.join('、')}` : ''].filter(Boolean).join('\n');
    const chapterPromptExecution = resolveChapterPromptExecution(promptPlan, chapter);
    if (promptPlan.writerPrompts.length > 0 && !chapterPromptExecution.primaryWriter) throw new Error(`${displayChapterTitle(chapter.title)} 写作主控提示词未进入章节生成阶段`);
    const chapterPromptTexts = [chapterPromptExecution.promptTexts, generationControlPrompt].filter(Boolean).join('\n\n');
    const chapterPromptDetails = chapterPromptExecution.promptDetails.length ? chapterPromptExecution.promptDetails : ['未绑定章节写作提示词'];
    const chapterFactNeeds = buildChapterFactNeeds({ template, chapter, spec: documentSpec, profile: domainProfile, promptTexts: chapterPromptTexts, requirement: input.requirement, plan: plan ? { requiredContents: plan.mustCover, evidenceNeeds: Object.values(plan.evidenceQueries).flat() } : undefined });
    let resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: preliminaryFactsModel, evidence: scopedEvidence, profile: domainProfile });
    let requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
    // 优化：图谱证据充足且多样化时才跳过深召回（文件多样性≥6 + 无缺失事实）
    const readinessPlan = buildChapterReadinessPlan({ chapter, evidence });
    const evidenceFileCount = new Set(evidence.map(item => item.filePath)).size;
    const graphEvidenceSufficient = Boolean(graphMapping)
      && (graphMapping?.graphFiles.size || 0) >= 8
      && evidenceFileCount >= 6
      && missingFacts.length === 0
      && readinessPlan.riskLevel === 'low';
    const needsDeepRetrieval = scopedFilePaths.length <= 80 && (readinessPlan.suggestedStrategy === 'evidence_first' || rolePoolRisk.highRisk || missingFacts.length > 0 || requiredMissingNeeds.length > 0 || (evidence.length < 8 && readinessPlan.riskLevel !== 'low'));
    if (!graphEvidenceSufficient && needsDeepRetrieval && scopedFilePaths.length > 0) {
      // P1-4：缺失事实与必需事实需求并入同一次深召回（原两次调用查询集高度重叠，合并后每章深召回查询数约降 40%）
      const deepEvidence = await retrieveDeepChapterEvidence({ manager, projectRoot, chapter, scopedFilePaths, fileRoleByPath, fileProcessingByPath, requiredNeeds: [...new Set([...missingFacts, ...requiredMissingNeeds])], highRisk: rolePoolRisk.highRisk || requiredMissingNeeds.length > 0, signal: input.signal }).catch(() => []);
      deepEvidenceCount = deepEvidence.length;
      if (deepEvidence.length > 0) {
        scopedEvidence = optimizeChapterEvidence(chapter, [...scopedEvidence, ...filterEvidenceByProjectScope(deepEvidence, projectMaterialScope)], { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 12, chapter, rolePoolRisk.highRisk), maxChars: evidenceBudgetChars + (rolePoolRisk.highRisk ? 36000 : 16000), preservePinned: true }, generationDiagnostics);
        scopedEvidence = filterEvidenceByProjectScope(scopedEvidence, projectMaterialScope);
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 8, chapter, rolePoolRisk.highRisk), maxChars: evidenceBudgetChars + (rolePoolRisk.highRisk ? 28000 : 12000), preservePinned: true }, generationDiagnostics);
        evidence = governEvidenceValues(evidence, canonicalFacts.scopeConflicts);
        assertEvidenceInProjectScope(evidence, projectMaterialScope, `chapter:${chapter.id}:deep`);
        missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
      }
      // P1-4：深召回后重算事实需求，仍缺失的必需需求触发下方一次轻量补充
      resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: preliminaryFactsModel, evidence: scopedEvidence, profile: domainProfile });
      requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
    }
    // P1-4：合并深召回后仍有必需事实缺口时做一次轻量补充（原第二次深召回，highRisk 强制；仅当新 needs 出现时触发）
    if (requiredMissingNeeds.length > 0 && scopedFilePaths.length > 0) {
      const mergedSupplementalEvidence = filterEvidenceByProjectScope(await retrieveDeepChapterEvidence({ manager, projectRoot, chapter, scopedFilePaths, fileRoleByPath, fileProcessingByPath, requiredNeeds: requiredMissingNeeds, highRisk: true, signal: input.signal }).catch(() => []), projectMaterialScope);
      if (mergedSupplementalEvidence.length > 0) {
        scopedEvidence = optimizeChapterEvidence(chapter, [...scopedEvidence, ...mergedSupplementalEvidence], { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 16, chapter, true), maxChars: evidenceBudgetChars + 42000, preservePinned: true }, generationDiagnostics);
        scopedEvidence = filterEvidenceByProjectScope(scopedEvidence, projectMaterialScope);
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 12, chapter, true), maxChars: evidenceBudgetChars + 32000, preservePinned: true }, generationDiagnostics);
        evidence = governEvidenceValues(evidence, canonicalFacts.scopeConflicts);
        assertEvidenceInProjectScope(evidence, projectMaterialScope, `chapter:${chapter.id}:supplemental`);
        missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
        resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: preliminaryFactsModel, evidence: scopedEvidence, profile: domainProfile });
        requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
      }
    }
    assertEvidenceInProjectScope(evidence, projectMaterialScope, `chapter:${chapter.id}:writer-input`);
    if (evidence.length === 0) missingItems.push(`${chapter.title}：缺少可支撑正文的项目资料证据`);
    for (const fact of missingFacts) missingItems.push(`${chapter.title}：事实需求未满足 ${fact}`);
    // 证据检索完成 → 持续刷新证据数量
    const knowledgeBaseStage = displayStage({ type: 'knowledge_retrieval', roleId: 'knowledge-base', status: (allEvidence.length > 0 ? 'success' : 'failed'), message: `已检索/绑定 ${allEvidence.length} 条证据` });
    if (knowledgeBaseStageIndex < 0) {
      knowledgeBaseStageIndex = upsertProgressStage(progressStages, knowledgeBaseStage);
    } else {
      progressStages[knowledgeBaseStageIndex] = { ...knowledgeBaseStage, order: progressStages[knowledgeBaseStageIndex]?.order ?? knowledgeBaseStage.order };
    }
    emitProgress();

    throwIfAborted(input.signal);

    // P4 检索自适应：本章仍有未满足的必需事实需求 → 调高后续章节查询扩展深度（上限 +2）
    if (requiredMissingNeeds.length > 0 && searchExpansionBoost < 2) searchExpansionBoost += 1;
    // P0-1 小节级检索复用：跨小节/跨修复轮缓存（查询=章节+小节标题），
    // 章节级 evidence 经 evidenceForSection 过滤后 ≥4 条且含量化参数时短路跳过检索；
    // 检索本身已在 retrieveSectionEvidence 内跳过 LocalReranker，后续还有双层本地重排兜底
    const sectionEvidenceCache = new Map<string, DocumentEvidence[]>();
    const sectionEvidenceForChapter = (sectionTitle: string): Promise<DocumentEvidence[]> => {
      const cacheKey = stableHash({ kind: 'section', query: `${chapter.title} ${sectionTitle}`.trim(), scopedFilePaths });
      const cached = sectionEvidenceCache.get(cacheKey);
      if (cached) return Promise.resolve(cached);
      const chapterSectionEvidence = evidenceForSection(sectionTitle, chapter, evidence);
      const quantifiedCount = chapterSectionEvidence.filter(item => QUANTIFIED_FACT_RE.test(item.content)).length;
      if (chapterSectionEvidence.length >= 4 && quantifiedCount >= 1) {
        const shortcut = chapterSectionEvidence.slice(0, 5);
        sectionEvidenceCache.set(cacheKey, shortcut);
        return Promise.resolve(shortcut);
      }
      return retrieveSectionEvidence({ manager, projectRoot, chapter, sectionTitle, scopedFilePaths, fileRoleByPath, fileProcessingByPath, signal: input.signal }).then(results => {
        sectionEvidenceCache.set(cacheKey, results);
        return results;
      });
    };
    // P4 硬回路提供器：两步生成大纲报告「材料缺失事实」时定向补检（复用小节级检索，禁用重排器，预算 9000 字符）
    const supplementEvidenceForChapter = (missingFacts: string[]): Promise<DocumentEvidence[]> => {
      if (missingFacts.length === 0 || scopedFilePaths.length === 0) return Promise.resolve([]);
      const label = missingFacts.slice(0, 6).join(' ');
      return retrieveSectionEvidence({ manager, projectRoot, chapter, sectionTitle: label, scopedFilePaths, fileRoleByPath, fileProcessingByPath, signal: input.signal }).catch(() => []);
    };
    const retrievalCoverageReport = buildRetrievalCoverageReport({ chapter, evidence, risk: rolePoolRisk });
    retrievalCoverageReports.push(retrievalCoverageReport);
    const chapterEvidenceFiles = new Set(evidence.map(item => item.filePath));
    const chapterEvidenceChars = evidence.reduce((sum, item) => sum + item.content.length, 0);
    const retrievalDetails = [
      ...(rolePoolRisk.highRisk ? [`召回覆盖风险（${rolePoolRisk.riskReason || '切片未完全预加载'}）：已加载 ${rolePoolRisk.loadedChunks}/${rolePoolRisk.totalChunks}，已启用深召回`] : []),
      `项目理解缓存证据：${cachedIntentEvidence.length} 条`,
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
    const chapterTaskResult = planChapterTask({ plan: plannedDocument.plan, chapter, context: agentWorkflow, evidence });
    agentWorkflow.chapterTasks = [...(agentWorkflow.chapterTasks || []).filter(item => item.chapterId !== chapter.id), chapterTaskResult.task];
    agentWorkflow.nodes.push(chapterTaskResult.node);
    throttleAgentWorkflowNodes(agentWorkflow);
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: `agent-chapter-task-${chapter.id}`, status: chapterTaskResult.task.ready || resumedContent ? 'success' : 'failed', message: chapterTaskResult.task.ready ? chapterTaskResult.node.outputSummary || `${displayChapterTitle(chapter.title)} 章节任务规划完成` : resumedContent ? `${displayChapterTitle(chapter.title)} 章节任务未完全就绪，已复用已有正文并交由 Reviewer/Repairer 处理` : chapterTaskResult.node.outputSummary || `${displayChapterTitle(chapter.title)} 章节任务规划完成`, details: chapterTaskResult.task.issues.map(issue => issue.message) }, { subtitle: 'Agent Chapter Task Planner', order: progressStages.length }));
    emitProgress(chapterDrafts);
    if (!chapterTaskResult.task.ready && !resumedContent) throw new Error(`${displayChapterTitle(chapter.title)} 章节任务未就绪：${chapterTaskResult.task.issues.map(issue => issue.message).join('；')}`);
    const agentEnhancedPromptTexts = [chapterPromptTexts, chapterTaskPrompt(chapterTaskResult.task)].filter(Boolean).join('\n\n');
    const factNeedSummary = { total: resolvedFactNeeds.length, satisfied: resolvedFactNeeds.filter(item => item.status === 'satisfied').length, missing: resolvedFactNeeds.filter(item => item.status === 'missing').length, lowConfidence: resolvedFactNeeds.filter(item => item.status === 'low_confidence').length };
    for (const fact of requiredMissingNeeds) missingItems.push(`${chapter.title}：事实需求未确认 ${fact}`);
    const specChapterRule = documentSpec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title);
    const budgetTarget = documentBudget.chapterTargets.get(chapter.id) || 1200;
    const sectionCount = chapter.sections?.filter(Boolean).length || 0;
    const compositeChapterTitle = /[、，,；;]/u.test(chapter.title);
    const targetPlan = chapterGenerationTargets({ budgetTarget, sectionCount, title: chapter.title, longformStrict: documentBudget.longformStrict });
    const chapterMaxChars = Math.ceil(targetPlan.maxWords * (documentBudget.maxChars ? 1.05 : 1));
    const adaptiveMinimum = documentBudget.targetChars ? Math.min(1800, Math.max(600, Math.floor(targetPlan.roundTarget * 0.45))) : 1200;
    const targetWords = targetPlan.roundTarget;
    const minWords = Math.max(Math.min(specChapterRule?.minWords || 0, targetWords), Math.min(documentSpec?.dynamicChapterRule.minWordsPerChapter || 0, targetWords), Math.floor(targetWords * 0.68), adaptiveMinimum);
    const generationMaxTokens = outputTokensForChapter(minWords, targetWords);
    const effectiveTargetWords = sectionCount > 0 ? Math.min(targetWords, Math.max(1800, targetPlan.structureTarget)) : targetWords;
    const maxSectionFirstSections = Math.max(4, Number(process.env.DOCUMENT_SECTION_FIRST_MAX_SECTIONS || 8));
    // 小节级成稿：长章节（目标 ≥6000 字、小节 4-8、非复合标题）自动启用，
    // 把整章长文拆成每节 900-1400 字的小调用，根治单次长文成稿长度不稳；
    // env DOCUMENT_SECTION_FIRST_GENERATION 显式置 0 可关闭，置 1 强制开启（不区分章节画像）
    const configuredSectionFirst = process.env.DOCUMENT_SECTION_FIRST_GENERATION;
    const sectionFirstDisabled = configuredSectionFirst !== undefined && Number(configuredSectionFirst) === 0;
    const sectionFirstForced = configuredSectionFirst !== undefined && Number(configuredSectionFirst) !== 0;
    const sectionFirstAutoEligible = targetWords >= 6000 && sectionCount >= 4 && sectionCount <= maxSectionFirstSections && !compositeChapterTitle;
    const useSectionGroup = !sectionFirstDisabled && sectionCount >= 2 && (sectionCount > maxSectionFirstSections || compositeChapterTitle || (documentBudget.longformStrict && sectionCount >= 6));
    const useSectionFirst = !sectionFirstDisabled && !useSectionGroup && sectionCount >= 2 && sectionCount <= maxSectionFirstSections && (sectionFirstForced || sectionFirstAutoEligible || documentBudget.longformStrict);
    // 规划驱动模式状态：块级成稿后 Reviewer/Repairer 按覆盖映射表审查承接，避免把语义合并后的 H4 误判为缺节并重新拆回
    let plannedStructureRef: PlannedChapterStructure | undefined;
    let plannedPromptTextsRef: string | undefined;
    let plannedCoverageRef: Record<string, string[]> | undefined;
    // 小节级 checkpoint：小节完成时把“进行中章节”（含已完成小节正文）写入 checkpoint 快照，
    // 章节生成中途失败/中止时不丢已生成小节；节流 3 秒避免高频写盘
    let lastSectionCheckpointAt = 0;
    const emitSectionCheckpoint = (partialSections: Array<string | undefined>) => {
      const nowSectionCheckpoint = Date.now();
      if (nowSectionCheckpoint - lastSectionCheckpointAt < 3000) return;
      lastSectionCheckpointAt = nowSectionCheckpoint;
      const partialContent = partialSections.filter(Boolean).join('\n\n');
      if (!partialContent.trim()) return;
      emitProgress([...chapterDrafts, { id: chapter.id, title: chapter.title, content: `## ${chapter.title}\n\n${partialContent}`, evidence, missingFacts, sections: chapter.sections || [], tablePlans: chapter.tablePlans || [], inProgress: true }]);
    };
    const onSectionProgressForCheckpoint = (event: { phase: 'start' | 'complete' | 'retry'; partialSections?: Array<string | undefined> }) => {
      if (event.phase === 'complete' && event.partialSections) emitSectionCheckpoint(event.partialSections);
    };
    let content: string;
    if (resumedContent) {
      content = finalizeChapterContentQuality(resumedContent, chapter);
      latestChapterStageForProgress = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'success',
        message: `${displayChapterTitle(chapter.title)} 已复用已有章节正文：当前 ${documentTextLength(content)} 字，跳过 Writer，直接进入 Reviewer/Repairer/Final Gate`,
        details: [`有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, '来源：resumeChapters/checkpointChapters'],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '复用章节' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      progressStages[chapterProgressIndex] = latestChapterStageForProgress;
      emitProgress(chapterDrafts);
    } else {
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: useSectionGroup ? `${displayChapterTitle(chapter.title)} 正在规划主题块并准备并发成稿` : useSectionFirst ? `${displayChapterTitle(chapter.title)} 正在按小节并发成稿` : `${displayChapterTitle(chapter.title)} 正在整章一次成稿`,
        details: (useSectionGroup || useSectionFirst)
          ? [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, targetPlan.label, `生成上限约 ${chapterMaxChars} 字`, `模板细目：${chapter.sections?.length || 0} 条`, useSectionGroup ? '细目较多，先由章级 Planner 聚类为主题块并语义合并，再按主题块全并发出稿，避免逐小节碎片化' : '按章节结构拆分小节自然并发生成，章节聚合后再审查修复']
          : [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, targetPlan.label, `生成上限约 ${chapterMaxChars} 字`, `规划小节：${sectionCount} 个`, '首次生成必须覆盖章节结构、小节和事实，篇幅目标仅作为规划参考'], 
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: useSectionGroup ? '主题块并发' : useSectionFirst ? '小节并发' : '整章成稿' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress();
      let llmContent: string | undefined;
      if (useSectionGroup) {
        // 规划驱动管线（治本路径）：章级 Planner 读项目图谱+文档蓝图，把显式细目重排为主题块并做语义合并
        // （相近细目合并进重写标题的 H4），从目录形态与 LLM 调用数两个维度根治碎片化；
        // LLM 失败/细目过少时由确定性语义域分组在同一管线内接管（永不回退逐小节碎片化成稿）
        const chapterTitleForBlueprint = displayChapterTitle(chapter.title);
        const blueprintChapterLines = documentBlueprintContext.split('\n').filter(line => line.includes(chapterTitleForBlueprint));
        const plannedBlueprintContext = blueprintChapterLines.length > 0 ? blueprintChapterLines.join('\n') : documentBlueprintContext.slice(0, 4000);
        const plannedStructure = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-plan:${chapter.id}`, () =>
          planChapterStructure({ template, chapter, evidence, projectContext, requirement: input.requirement, roleContext, targetWords: effectiveTargetWords, graphContext: chapterTaskResult.task.graphContext, blueprintContext: plannedBlueprintContext, signal: input.signal, diagnostics: generationDiagnostics })
        ));
        if (plannedStructure.blocks.length > 0) {
          plannedStructureRef = plannedStructure;
          const plannedCoverage = plannedSectionCoverageMap(cleanInputSections(chapter), plannedStructure);
          plannedCoverageRef = plannedCoverage;
          const plannedPromptTexts = [chapterPromptTexts, chapterTaskPromptForPlannedStructure(chapterTaskResult.task, plannedStructure)].filter(Boolean).join('\n\n');
          plannedPromptTextsRef = plannedPromptTexts;
          const h4Count = plannedStructure.blocks.reduce((sum, block) => sum + block.subPoints.length, 0);
          const mergedCount = plannedStructure.blocks.reduce((sum, block) => sum + block.subPoints.reduce((count, point) => count + Math.max(0, point.sources.length - 1), 0), 0);
          const plannerNote = plannedStructure.llmPlanned
            ? (plannedStructure.llmFailure ? `（部分主题块降级：${plannedStructure.llmFailure.slice(0, 80)}）` : (plannedStructure.fallbackSections.length > 0 ? `（${plannedStructure.fallbackSections.length} 条细目由覆盖校验挂回主题块）` : ''))
            : `（LLM 规划未命中：${(plannedStructure.llmFailure || '未返回有效结构').slice(0, 80)}，已按语义域确定性分组）`;
          progressStages[chapterProgressIndex] = displayStage({
            type: 'chapter_generation',
            roleId: 'chapter_generation',
            promptId: chapterPromptExecution.primaryPromptId,
            status: 'running',
            message: `${displayChapterTitle(chapter.title)} 已规划 ${plannedStructure.blocks.length} 个主题块，正在按主题块并发成稿${plannerNote}`,
            details: [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `输入细目 ${sectionCount} 条 → 主题块 ${plannedStructure.blocks.length} 个（每块 2~4 个 H4 要点）`, `语义合并 ${mergedCount} 条细目，目录级 H4 合计 ${h4Count} 个`, '单块 1200~2200 字，主题块间全并发，单节深度与整体耗时双优'],
            progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '主题块并发' },
          }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
          // 同步把「Agent Chapter Task Planner」stage 更新为规划驱动视角：
          // 细目任务卡是事实/证据分配单元，最终目录按主题块+H4 成稿，避免残留「N/N 个小节任务就绪」误导
          const chapterTaskStage = progressStages.find(stage => stage.roleId === `agent-chapter-task-${chapter.id}`);
          if (chapterTaskStage) {
            chapterTaskStage.message = `${chapterTaskResult.task.sections.filter(item => item.ready).length}/${chapterTaskResult.task.sections.length} 条细目任务就绪（已规划为 ${plannedStructure.blocks.length} 个主题块）`;
          }
          emitProgress(chapterDrafts);
          llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-planned-block-draft:${chapter.id}`, () =>
            buildPlannedChapterContent({ template, chapter, evidence, missingFacts, promptTexts: plannedPromptTexts, projectContext, requirement: input.requirement, roleContext, targetWords: effectiveTargetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, compactProjectContext: true, sectionEvidenceProvider: sectionEvidenceForChapter, onSectionProgress: onSectionProgressForCheckpoint, diagnostics: generationDiagnostics, signal: input.signal }, plannedStructure)
          ));
        }
      } else if (useSectionFirst) {
        llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-section-draft:${chapter.id}`, () =>
          buildSectionParallelChapterContent({ template, chapter, evidence, missingFacts, promptTexts: agentEnhancedPromptTexts, projectContext, requirement: input.requirement, roleContext, targetWords: effectiveTargetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, projectRoot, modelName: getActiveModelWithProvider()?.model.name, materialContextHash: stableHash({ materialFilePaths, promptTexts: chapterPromptTexts }), allowPartialResult: false, compactProjectContext: true, sectionEvidenceProvider: sectionEvidenceForChapter, onSectionProgress: onSectionProgressForCheckpoint, diagnostics: generationDiagnostics, signal: input.signal })
        ));
      } else {
        llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft:${chapter.id}`, () =>
          buildLlmChapterContent(template, chapter, evidence, missingFacts, agentEnhancedPromptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords, targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext, signal: input.signal, diagnostics: generationDiagnostics, supplementEvidenceProvider: supplementEvidenceForChapter, evidenceFloorChars: generationBudget.evidenceFloorChars, evidenceCeilingChars: generationBudget.evidenceCeilingChars })
        ));
      }
      if (!llmContent && (useSectionGroup || useSectionFirst)) {
        // 整章紧凑备用成稿按原细目组织正文（buildLlmChapterContent 的 sectionInstruction），
        // 必须清空主题块规划引用：否则 Reviewer/Repairer 继续用 H4 主题块锚点定位，
        // 会在大段正文中 extractSection 全部失败，产生"未匹配到独立小节标题"误报 + 修复无效循环
        if (useSectionGroup) {
          plannedStructureRef = undefined;
          plannedPromptTextsRef = undefined;
          plannedCoverageRef = undefined;
        }
        progressStages[chapterProgressIndex] = displayStage({
          type: 'chapter_generation',
          roleId: 'chapter_generation',
          promptId: chapterPromptExecution.primaryPromptId,
          status: 'running',
          message: `${displayChapterTitle(chapter.title)} ${useSectionGroup ? '主题块成稿未完成' : '小节成稿未完成'}，正在切换为整章紧凑备用成稿`,
          details: [`LLM 最近错误：${generationDiagnostics.llm.lastError || '成稿空响应或超时'}`, `有效证据：${evidence.length} 条`],
          progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '整章备用' },
        }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
        emitProgress(chapterDrafts);
        llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-compact-fallback:${chapter.id}`, () =>
          buildLlmChapterContent(template, chapter, evidence, missingFacts, agentEnhancedPromptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords: Math.floor(minWords * 0.65), targetWords: Math.floor(effectiveTargetWords * 0.75), maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext, signal: input.signal, diagnostics: generationDiagnostics, supplementEvidenceProvider: supplementEvidenceForChapter, evidenceFloorChars: generationBudget.evidenceFloorChars, evidenceCeilingChars: generationBudget.evidenceCeilingChars }).catch(error => {
            generationDiagnostics.llm.lastError = error instanceof Error ? error.message : String(error);
            return undefined;
          })
        ));
      }
      if (!llmContent && evidence.length > 0) {
        // P0-2 确定性兜底改造：进入证据骨架前，先把 LLM 失败原因反馈给模型再试 1 次紧凑整章生成，
        // 给瞬态故障（超时/限流/预算耗尽）一次恢复机会，避免正常场景退化为模板拼接正文
        progressStages[chapterProgressIndex] = displayStage({
          type: 'chapter_generation',
          roleId: 'chapter_generation',
          promptId: chapterPromptExecution.primaryPromptId,
          status: 'running',
          message: `${displayChapterTitle(chapter.title)} LLM 多路径未返回有效正文，正在反馈失败原因重试紧凑整章生成`,
          details: [`LLM 最近错误：${generationDiagnostics.llm.lastError || '空响应或超时'}`, `证据条数：${evidence.length}`],
          progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '失败原因重试' },
        }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
        emitProgress(chapterDrafts);
        const retryRoleContext = [roleContext, `【上一轮 LLM 生成失败，请先分析失败原因，再调整策略重新输出完整章节正文】失败原因：${generationDiagnostics.llm.lastError || '空响应或超时'}`].filter(Boolean).join('\n');
        llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-lastretry:${chapter.id}`, () =>
          buildLlmChapterContent(template, chapter, evidence, missingFacts, agentEnhancedPromptTexts, projectContext, input.requirement, retryRoleContext, { forbidDrawingImages, minWords: Math.floor(minWords * 0.55), targetWords: Math.floor(effectiveTargetWords * 0.6), maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext, signal: input.signal, diagnostics: generationDiagnostics, supplementEvidenceProvider: supplementEvidenceForChapter, evidenceFloorChars: generationBudget.evidenceFloorChars, evidenceCeilingChars: generationBudget.evidenceCeilingChars }).catch(error => {
            generationDiagnostics.llm.lastError = error instanceof Error ? error.message : String(error);
            return undefined;
          })
        ));
      }
      if (!llmContent && evidence.length > 0) {
        progressStages[chapterProgressIndex] = displayStage({
          type: 'chapter_generation',
          roleId: 'chapter_generation',
          promptId: chapterPromptExecution.primaryPromptId,
          status: 'running',
          message: `${displayChapterTitle(chapter.title)} LLM 全故障，正在用当前项目证据生成带阻断标记的可审查骨架草稿`,
          details: [`LLM 最近错误：${generationDiagnostics.llm.lastError || '空响应或超时'}`, `证据条数：${evidence.length}`, '骨架草稿将带 [EVIDENCE_SKELETON] 标记并由 Review 门禁强制拦截，不允许静默通过'],
          progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '证据骨架' },
        }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
        emitProgress(chapterDrafts);
        llmContent = `[EVIDENCE_SKELETON]\n${buildEvidenceOnlyChapterContent({ chapter, evidence, targetWords: effectiveTargetWords, forbidDrawingImages })}`;
      }
      throwIfAborted(input.signal);
      if (!llmContent) {
        const message = `${displayChapterTitle(chapter.title)} 大模型未返回有效正文，已阻断生成`;
        progressStages[chapterProgressIndex] = displayStage({
          type: 'chapter_generation',
          roleId: 'chapter_generation',
          promptId: chapterPromptExecution.primaryPromptId,
          status: 'failed',
          message,
          details: [`LLM 最近错误：${generationDiagnostics.llm.lastError || '空响应或超时'}`, `证据条数：${evidence.length}`],
          progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节阻断' },
        }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
        emitProgress(chapterDrafts);
        throw new Error(message);
      }
      const chapterContent = llmContent;
      if (!chapterContent.trim()) {
        throw new Error(`${displayChapterTitle(chapter.title)} 首次生成失败，未获得可用于定稿的正文`);
      }
      content = finalizeChapterContentQuality(chapterContent, chapter);
    }
    const factUsageIssues = chapterSectionFactUsageIssues({ chapter, content, evidence });
    const chapterChars = documentTextLength(content);
    const generatedSectionsForReview = extractGeneratedSections(content);
    const sections = generatedSectionsForReview.length > 0 ? generatedSectionsForReview : chapter.sections || [];
    const expandedSectionIssues = sectionContentIntegrityIssues(content, [{ title: chapter.title, content, sections }]).map(issue => issue.message);
    const factUsageWarnings = factUsageIssues.slice(0, 6).map(issue => `小节事实密度需优化：${issue}`);
    const chapterIssues = [...expandedSectionIssues, ...factUsageWarnings];
    // P0-2：LLM 全故障时的证据骨架草稿强制 failed，禁止通过 Review 门禁静默成文
    const chapterStatus = content.includes('[EVIDENCE_SKELETON]') ? 'failed' : chapterCompletionStatus(chapterChars, targetWords, chapterIssues);
    latestChapterStageForProgress = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: chapterPromptExecution.primaryPromptId,
      status: chapterStatus,
      message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已由大模型成稿：当前 ${chapterChars} 字；章节预算约 ${targetPlan.budgetTarget} 字，本轮目标约 ${targetPlan.roundTarget} 字${chapterIssues.length ? `；待优化：${chapterIssues.slice(0, 8).join('、')}` : ''}`, chapterStartedAt),
      details: [`本轮完成率：${Math.round(chapterChars / Math.max(1, targetPlan.roundTarget) * 100)}%`, `结构目标约 ${targetPlan.structureTarget} 字`, ...chapterPromptDetails, `二级小节：${sections.length} 个`],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: chapterIssues.length ? '章节已生成' : '章节达标' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    chapterGenerationStagesByOrder[chapterOrder] = latestChapterStageForProgress;
    // P2：生成阶段结束，审查修复阶段作为延迟任务返回，由审查池调度（与后续批次章节生成流水线重叠）
    return async (): Promise<void> => {
    try {
    let draftChapter = { id: chapter.id, title: chapter.title, content, evidence, missingFacts, sections, tablePlans: chapter.tablePlans || [] };
    let agentReview = reviewChapterDraft({ task: chapterTaskResult.task, draft: draftChapter, context: agentWorkflow, plannedCoverage: plannedCoverageRef });
    agentWorkflow.reviewResults = { ...(agentWorkflow.reviewResults || {}), [chapter.id]: agentReview };
    let blockingReviewIssues = agentReview.issues.filter(issue => issue.severity === 'blocker' || issue.level === 'error');
    let hasWriterMissingIssues = blockingReviewIssues.some(issue => /Writer 未完成/u.test(issue.message));
    let hasDepthBlockers = blockingReviewIssues.some(issue => /正文不足，未达到任务最小深度/u.test(issue.message));
    // 深度不足类问题（含 warning 级）也要触发修复：Reviewer 只把关键小节的"正文不足"标为 blocker，
    // 普通小节是 warning 级；若只按 blocker 触发，warning 级深度缺口永远不补写，修复循环空转（历史缺陷：47 个 warning 修复两轮问题数纹丝不动）
    let hasDepthWarnings = hasDepthWarningIssues(agentReview.issues);
    let needsRepair = (blockingReviewIssues.length > 0 && (agentReview.repairable || hasWriterMissingIssues || hasDepthBlockers)) || hasDepthWarnings;
    // P3：Repairer 轮次预算上限（默认 3 轮），超预算转"标记问题 + 门禁阻断 + 用户决策"
    const repairRoundBudget = generationBudget.repairRoundBudget;
    let repairRounds = 0;
    agentWorkflow.nodes.push({ id: `chapter-reviewer-${chapter.id}`, type: 'chapter_reviewer', status: blockingReviewIssues.length ? (needsRepair ? 'running' : 'failed') : 'completed', startedAt: Date.now(), completedAt: Date.now(), outputSummary: agentReview.issues.length ? `${agentReview.issues.length} 个 Reviewer 提示` : 'Reviewer 通过', metrics: { supportedFacts: agentReview.supportedFacts }, issues: agentReview.issues });
    throttleAgentWorkflowNodes(agentWorkflow);
    upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: `agent-reviewer-${chapter.id}`, status: blockingReviewIssues.length ? (needsRepair ? 'running' : 'failed') : 'success', message: blockingReviewIssues.length ? `${displayChapterTitle(chapter.title)} Reviewer 发现 ${blockingReviewIssues.length} 个阻断问题，等待 Repairer 修复（轮次预算 ${repairRoundBudget} 轮）` : `${displayChapterTitle(chapter.title)} Reviewer 通过${agentReview.issues.length ? `（${agentReview.issues.length} 个优化提示）` : ''}`, details: agentReview.issues.map(issue => issue.message) }, { subtitle: 'Agent Reviewer', order: progressStages.length }));
    emitProgress(chapterDrafts);
    // Reviewer 深度通过线 = 承接小节组内最大 minChars × 0.8；Repairer 补写目标必须对齐该线，
    // 否则补写达标（0.7×目标）却被复审驳回，同一小节反复修（历史缺陷：补写 793 字过 Repairer 验收线仍被复审以 0.8×组内最大深度驳回）
    const anchorDepthMap = new Map<string, number>();
    for (const section of chapterTaskResult.task.sections) {
      const anchor = anchorTitleForSection(plannedCoverageRef, section.title);
      anchorDepthMap.set(anchor, Math.max(anchorDepthMap.get(anchor) || 0, section.minChars));
    }
    while (needsRepair && repairRounds < repairRoundBudget) {
      repairRounds += 1;
      const repairReview = { ...agentReview, issues: blockingReviewIssues };
      const repairInstruction = agentReview.repairable
        ? buildTargetedRepairInstruction({ task: chapterTaskResult.task, review: repairReview, plannedMode: Boolean(plannedStructureRef) })
        : [
          '【Agent 定向修复任务】',
          `章节：${chapterTaskResult.task.title}`,
          'Reviewer 发现 Writer 未完成小节。必须基于对应小节事实卡和证据生成正式正文，替换并删除 WRITER_MISSING_SECTION 标记；不得跳过这些小节，不得保留占位说明。',
          ...blockingReviewIssues.map(issue => `- ${issue.message}；${issue.suggestion || ''}`),
        ].join('\n');
      const repairerStageOrder = progressStages.length;
      // 修复范围：深度不足类问题（含 warning 级）全部参与补写——只修 blocker 会让普通小节永远不补写（历史缺陷：47 个 warning 级"正文不足"修复两轮问题数纹丝不动，轮次预算空转）
      const writerMissingIssues = agentReview.issues.filter(item => /Writer 未完成/u.test(item.message));
      const depthRepairIssues = agentReview.issues.filter(item => /正文不足，未达到任务最小深度/u.test(item.message));
      const sectionRewriteIssues = [...writerMissingIssues, ...depthRepairIssues.filter(item => !writerMissingIssues.some(existing => existing.message === item.message))];
      const repairSectionResults: string[] = [];
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: `agent-repairer-${chapter.id}`, status: 'running', message: `${displayChapterTitle(chapter.title)} Reviewer 发现 ${blockingReviewIssues.length} 个阻断问题，正在定向修复`, details: blockingReviewIssues.map(issue => issue.message) }, { subtitle: 'Agent Repairer', order: repairerStageOrder }));
      emitProgress(chapterDrafts);
      const replaceChapterSection = (contentValue: string, title: string, sectionValue: string, anchorTitle?: string) => {
        const normalizeHeadingTitle = (value: string) => value.replace(/[\u00a0\u3000]/gu, ' ').replace(/^\d+(?:\.\d+)*\s+/u, '').trim();
        // 与验收器/终检修复器同口径（comparableSectionTitleText）：去编号、空白、lower、去“施工/专项方案”修饰与“项目|工程|主要|重点|技术”泛化词，
        // 避免字面差异大的重写标题（如“项目重点难点分析”vs“项目特点、重点、难点分析”）定位失败后退入 plannedIndex 兑底插新小节，旧承接小节残留形成重复
        const comparableHeadingTitle = comparableSectionTitleText;
        // 标题重写（plannedCoverage 1:1 承接）场景：规划标题与正文 H4 标题字面差异大，定位须同时尝试承接标题，
        // 否则 miss 后走 plannedIndex 兜底在下一规划小节前插入新 H4，旧承接小节残留形成重复小节（每轮修复多一个）
        const matchesSectionHeading = (headingTitle: string) => {
          const candidates = [title, anchorTitle].filter((item): item is string => typeof item === 'string');
          return candidates.some(candidate => {
            const comparableHeading = comparableHeadingTitle(headingTitle);
            const comparableCandidate = comparableHeadingTitle(candidate);
            return headingTitle === candidate || headingTitle.includes(candidate) || candidate.includes(headingTitle)
              || comparableHeading === comparableCandidate || comparableHeading.includes(comparableCandidate) || comparableCandidate.includes(comparableHeading);
          });
        };
        const stripGeneratedHeading = (value: string) => value.trim().replace(/^#{2,6}\s+(?:\d+(?:\.\d+)*\s+)?[^\n]+\n+/u, '').trim();
        const lines = contentValue.split('\n');
        let cursor = 0;
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          const lineStart = cursor;
          cursor += line.length + 1;
          const heading = /^(#{3,4})\s+(.+)$/u.exec(line.trim());
          if (!heading) continue;
          const headingTitle = normalizeHeadingTitle(heading[2]);
          if (!matchesSectionHeading(headingTitle)) continue;
          // 工作包型关键小节：正文由同级 H4 工作包展开，替换边界扩展到下一个上级标题（H2/H3），
          // 吞并原有工作包 H4——否则每轮 Repairer 补写都会在旧工作包前追加一组新工作包，形成多组重复
          const boundaryHeadingRe = heading[1].length === 3 && WORK_PACKAGE_SECTION_RE.test(title) ? /^#{2,3}\s+/u : /^#{2,4}\s+/u;
          let endLine = lines.length;
          for (let next = lineIndex + 1; next < lines.length; next += 1) {
            if (boundaryHeadingRe.test(lines[next].trim())) {
              endLine = next;
              break;
            }
          }
          const endOffset = endLine < lines.length ? lines.slice(0, endLine).join('\n').length : contentValue.length;
          const body = stripGeneratedHeading(sectionValue);
          return `${contentValue.slice(0, lineStart)}${line.trim()}\n\n${body}${contentValue.slice(endOffset)}`;
        }
        const plannedIndex = chapterTaskResult.task.sections.findIndex(item => comparableHeadingTitle(item.title) === comparableHeadingTitle(title));
        if (plannedIndex >= 0) {
          const nextPlanned = chapterTaskResult.task.sections.slice(plannedIndex + 1).map(item => comparableHeadingTitle(item.title));
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const heading = /^(#{3,4})\s+(.+)$/u.exec(lines[lineIndex].trim());
            if (!heading) continue;
            if (!nextPlanned.includes(comparableHeadingTitle(heading[2]))) continue;
            const insertOffset = lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0);
            const body = stripGeneratedHeading(sectionValue);
            return body ? `${contentValue.slice(0, insertOffset).trimEnd()}\n\n### ${title}\n\n${body}\n\n${contentValue.slice(insertOffset).trimStart()}` : contentValue;
          }
        }
        const body = stripGeneratedHeading(sectionValue);
        return body ? `${contentValue.trimEnd()}\n\n### ${title}\n\n${body}` : contentValue;
      };
      // 单个小节补写（LLM 调用部分）：返回待落位的补写结果；落位必须在批次完成后串行执行，避免并发改写 draftChapter 互相覆盖
      const processSectionRewrite = async (issue: { message: string; suggestion?: string }): Promise<{ sectionTitle: string; rewriteReason: string; normalizedSection?: string; normalizedLength: number; enoughDepth: boolean; evidenceCount: number; repairTargetWords: number; failed?: string } | undefined> => {
        throwIfAborted(input.signal);
        const sectionTitle = issue.message
          .replace(/\s*Writer 未完成.*$/u, '')
          .replace(/\s*正文不足，未达到任务最小深度.*$/u, '')
          .trim();
        const rewriteReason = /Writer 未完成/u.test(issue.message) ? '缺失小节' : '深度不足小节';
        const taskSection = chapterTaskResult.task.sections.find(item => item.title === sectionTitle);
        const anchorMinChars = anchorDepthMap.get(anchorTitleForSection(plannedCoverageRef, sectionTitle)) || 0;
        // 补写目标对齐 Reviewer 通过线（组内最大 minChars × 0.8）：目标 = ceil(anchorMinChars / 0.8)，
        // 使 Repairer 验收线 0.7×目标 ≈ 0.875×anchorMinChars ≥ Reviewer 0.8×anchorMinChars，一次补写即可复审通过
        const repairTargetWords = repairTargetWordsForSection(sectionTitle, taskSection?.minChars, anchorMinChars);
        const isDepthRepair = /正文不足，未达到任务最小深度/u.test(issue.message);
        const sectionEvidence = filterEvidenceByProjectScope(await sectionEvidenceForChapter(sectionTitle).catch(() => []), projectMaterialScope);
        assertEvidenceInProjectScope(sectionEvidence.length ? sectionEvidence : evidence, projectMaterialScope, `repair:${chapter.id}:${sectionTitle}`);
        generationDiagnostics.llm.lastError = undefined;
        let repairedSection = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `agent-repairer-section:${chapter.id}:${sectionTitle}`, () => buildLlmSectionContent({
          template,
          chapter,
          sectionTitle,
          evidence: sectionEvidence.length ? sectionEvidence : evidence,
          missingFacts,
          promptTexts: [plannedPromptTextsRef || agentEnhancedPromptTexts, repairInstruction].filter(Boolean).join('\n\n'),
          projectContext,
          requirement: input.requirement,
          roleContext,
          targetWords: repairTargetWords,
          maxWords: repairTargetWords * 1.25,
          forbidDrawingImages,
          factCoverageContext,
          qualityFeedback: `Repairer 定向补写“${sectionTitle}”。必须输出该小节正式正文并彻底删除 WRITER_MISSING_SECTION 标记。`,
          diagnostics: generationDiagnostics,
          signal: input.signal,
          allowLenientStructureGate: true,
        })));
        if (!repairedSection || repairedSection.includes('WRITER_MISSING_SECTION')) {
          const lastFailure = generationDiagnostics.llm.lastError;
          generationDiagnostics.llm.lastError = undefined;
          repairedSection = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `agent-repairer-section-retry:${chapter.id}:${sectionTitle}`, () => buildLlmSectionContent({
            template,
            chapter,
            sectionTitle,
            evidence: sectionEvidence.length ? sectionEvidence : evidence,
            missingFacts,
            promptTexts: repairInstruction,
            projectContext,
            requirement: input.requirement,
            roleContext,
            targetWords: repairTargetWords,
            maxWords: repairTargetWords * 1.15,
            forbidDrawingImages,
            factCoverageContext,
            qualityFeedback: `第二次定向补写“${sectionTitle}”：只写该小节正式正文，不写解释，不保留 WRITER_MISSING_SECTION。${lastFailure ? `上次失败原因：${lastFailure}，必须逐条修正。` : ''}`,
            diagnostics: generationDiagnostics,
            signal: input.signal,
            allowLenientStructureGate: true,
          })));
        }
        if (repairedSection && !repairedSection.includes('WRITER_MISSING_SECTION')) {
          const normalizedSection = /^#{3,4}\s+/u.test(repairedSection.trim()) ? repairedSection.trim() : `### ${sectionTitle}\n\n${repairedSection.trim()}`;
          const normalizedLength = documentTextLength(normalizedSection);
          // 深度验收线：与 buildLlmSectionContent 的 minSectionChars 口径完全一致，
          // 门禁（含降级验收）已放行的内容不得在此处被更严的线拒收；关键小节 blocker 线承担 0.8×目标的把关职责
          const depthAcceptLine = Math.min(Math.max(Math.floor(repairTargetWords * 0.7), criticalSectionBlockerMinChars(sectionTitle)), Math.max(500, repairTargetWords));
          const enoughDepth = !isDepthRepair || normalizedLength >= depthAcceptLine;
          return { sectionTitle, rewriteReason, normalizedSection, normalizedLength, enoughDepth, evidenceCount: sectionEvidence.length || evidence.length, repairTargetWords };
        }
        return { sectionTitle, rewriteReason, normalizedLength: 0, enoughDepth: false, evidenceCount: 0, repairTargetWords, failed: !repairedSection ? generationDiagnostics.llm.lastError || '空响应' : '仍包含 WRITER_MISSING_SECTION' };
      };
      // 深度不足小节批量并发补写（每批 3 个）：批次内 LLM 调用并发，落位串行，避免并发改写 draftChapter 互相覆盖
      const rewriteBatchSize = 3;
      for (let start = 0; start < sectionRewriteIssues.length; start += rewriteBatchSize) {
        const batch = sectionRewriteIssues.slice(start, start + rewriteBatchSize);
        const batchResults = await Promise.allSettled(batch.map(issue => processSectionRewrite(issue)));
        for (const result of batchResults) {
          if (result.status === 'rejected') {
            if (input.signal?.aborted) throw result.reason;
            repairSectionResults.push(`失败：${result.reason instanceof Error ? result.reason.message : '未知异常'}`);
            continue;
          }
          if (!result.value) continue;
          if (result.value.failed) {
            repairSectionResults.push(`失败：${result.value.sectionTitle}（${result.value.failed}）`);
            continue;
          }
          const anchorSectionTitle = anchorTitleForSection(plannedCoverageRef, result.value.sectionTitle);
          const nextContent = result.value.enoughDepth ? replaceChapterSection(draftChapter.content, result.value.sectionTitle, result.value.normalizedSection || '', anchorSectionTitle) : draftChapter.content;
          const hasRange = nextContent !== draftChapter.content;
          if (hasRange) draftChapter = { ...draftChapter, content: nextContent };
          repairSectionResults.push(hasRange ? `成功：${result.value.sectionTitle}（${result.value.normalizedLength}字，证据 ${result.value.evidenceCount} 条）` : `失败：${result.value.sectionTitle}（${result.value.enoughDepth ? '未定位到原小节块' : `补写不足 ${result.value.normalizedLength}/${result.value.repairTargetWords} 字`}）`);
        }
        upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: `agent-repairer-${chapter.id}`, status: 'running', message: `${displayChapterTitle(chapter.title)} 已补写深度不足小节 ${Math.min(start + rewriteBatchSize, sectionRewriteIssues.length)}/${sectionRewriteIssues.length}`, details: repairSectionResults }, { subtitle: 'Agent Repairer', order: repairerStageOrder }));
        emitProgress(chapterDrafts);
      }
      let repaired = { content: draftChapter.content, appliedCount: 0 };
      if (blockingReviewIssues.some(issue => !/Writer 未完成|正文不足，未达到任务最小深度/u.test(issue.message))) {
        repaired = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `agent-repairer:${chapter.id}`, () => repairChapterByQuality({ template, chapter: { id: chapter.id, title: chapter.title, content: draftChapter.content, evidence, missingFacts, sections }, issues: blockingReviewIssues.map(issue => `${issue.message}；${issue.suggestion || ''}`), promptTexts: [plannedPromptTextsRef || agentEnhancedPromptTexts, repairInstruction].filter(Boolean).join('\n\n'), requirement: input.requirement, forbidDrawingImages, diagnostics: generationDiagnostics, signal: input.signal })));
      }
      draftChapter = { ...draftChapter, content: finalizeChapterContentQuality(repaired.content || draftChapter.content, chapter) };
      agentReview = reviewChapterDraft({ task: chapterTaskResult.task, draft: draftChapter, context: agentWorkflow, plannedCoverage: plannedCoverageRef });
      agentWorkflow.reviewResults = { ...(agentWorkflow.reviewResults || {}), [chapter.id]: agentReview };
      blockingReviewIssues = agentReview.issues.filter(issue => issue.severity === 'blocker' || issue.level === 'error');
      hasWriterMissingIssues = blockingReviewIssues.some(issue => /Writer 未完成/u.test(issue.message));
      hasDepthBlockers = blockingReviewIssues.some(issue => /正文不足，未达到任务最小深度/u.test(issue.message));
      hasDepthWarnings = hasDepthWarningIssues(agentReview.issues);
      needsRepair = (blockingReviewIssues.length > 0 && (agentReview.repairable || hasWriterMissingIssues || hasDepthBlockers)) || hasDepthWarnings;
      const postRepairFailed = blockingReviewIssues.length > 0;
      agentWorkflow.nodes.push({ id: `chapter-repairer-${chapter.id}`, type: 'chapter_repairer', status: postRepairFailed ? 'failed' : 'completed', startedAt: Date.now(), completedAt: Date.now(), outputSummary: agentReview.issues.length ? `修复后仍有 ${agentReview.issues.length} 个问题` : '定向修复通过', metrics: { supportedFacts: agentReview.supportedFacts }, issues: agentReview.issues });
      throttleAgentWorkflowNodes(agentWorkflow);
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: `agent-reviewer-${chapter.id}`, status: postRepairFailed ? 'failed' : 'success', message: postRepairFailed ? `${displayChapterTitle(chapter.title)} Reviewer 第 ${repairRounds} 轮复审仍有 ${blockingReviewIssues.length} 个阻断问题${needsRepair && repairRounds < repairRoundBudget ? '，继续下一轮修复' : ''}` : `${displayChapterTitle(chapter.title)} Reviewer 第 ${repairRounds} 轮复审通过`, details: agentReview.issues.map(issue => issue.message) }, { subtitle: 'Agent Reviewer', order: repairerStageOrder - 1 }));
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: `agent-repairer-${chapter.id}`, status: postRepairFailed ? 'failed' : 'success', message: agentReview.issues.length ? `${displayChapterTitle(chapter.title)} 第 ${repairRounds} 轮定向修复后仍有 ${agentReview.issues.length} 个问题` : `${displayChapterTitle(chapter.title)} 定向修复通过`, details: [...repairSectionResults, ...agentReview.issues.map(issue => `剩余：${issue.message}`)] }, { subtitle: 'Agent Repairer', order: repairerStageOrder }));
      emitProgress(chapterDrafts);
    }
    if (agentReview.issues.some(issue => issue.severity === 'blocker' || issue.level === 'error')) {
      const remainingRounds = estimateRemainingRepairRounds(blockingReviewIssues);
      failedChapterMessages.push(`${displayChapterTitle(chapter.title)} Reviewer 未通过：${agentReview.issues.map(issue => issue.message).join('；')}（修复轮次预算 ${repairRoundBudget} 轮已用尽，预估还需 ${remainingRounds} 轮修复；问题已标记并转入门禁阻断，可在记录详情查看后决定继续修复或调整模板）`);
    }
    chapterDraftsByOrder[chapterOrder] = draftChapter;
    chapterDrafts = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
    emitProgress(chapterDrafts);
    generationDiagnostics.quality.blockingCount += agentReview.issues.filter(issue => issue.level === 'error').length;
    generationDiagnostics.quality.importantCount += agentReview.issues.filter(issue => issue.level === 'warning').length;
    } catch (reviewErr) {
      // 审查修复阶段异常不中断整次生成：标记为失败章节，交由 Final Gate 门禁阻断
      if (input.signal?.aborted) throw reviewErr;
      console.error(`[gen] chapter ${chapter.title} review failed:`, reviewErr);
      failedChapterMessages.push(`${displayChapterTitle(chapter.title)}：审查修复阶段失败：${reviewErr instanceof Error ? reviewErr.message : '未知错误'}`);
    }
    };
    } catch (err) {
      if (input.signal?.aborted) throw err;
      console.error(`[gen] chapter ${chapter.title} failed:`, err);
      const failureMessage = `${chapter.title}：${err instanceof Error ? err.message : '生成失败'}`;
      failedChapterMessages.push(failureMessage);
      latestChapterStageForProgress = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'failed',
        message: `${displayChapterTitle(chapter.title)} 生成失败：${failureMessage}`,
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      chapterGenerationStagesByOrder[chapterOrder] = latestChapterStageForProgress;
    }
    // 章节生成完成（成功或失败）→ 汇报进度
    if (latestChapterStageForProgress) progressStages[chapterProgressIndex] = latestChapterStageForProgress;
    emitProgress(chapterDrafts);
    }));
    // P2：本批章节全部生成完毕，审查修复任务排入审查池（reviewConcurrency 限流），与下一批章节生成重叠
    for (const reviewTask of batchTasks) {
      if (!reviewTask) continue;
      reviewTaskPool.push(reviewSemaphore.run(reviewTask));
    }
  }
  // P2：等待全部章节审查修复完成；chapterDraftsByOrder 按章节序写入，跨章引用修复安全
  await Promise.all(reviewTaskPool);
  const chapterDraftsFinal = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
  chapterGenerationStages.push(...chapterGenerationStagesByOrder.filter((item): item is DocumentExecutionStage => Boolean(item)));

  // 源级同口径裁决已在事实主表构建入口完成（buildCanonicalFactModel 内 applyScopeConflictResolutions），
  // Writer 输入的事实与蓝图约束全部只含裁决口径（补疑优先），败选数值从源头就不会写入正文；
  // 此处不再做生成后全文替换（用户明确要求：源头解决，而非事后清除）

  // 全局一致性审查：strict 画像默认开启（额外 LLM 成本，全文分块审查）；
  // fast 小文档降级为抽检（按 globalReviewSamplingRate 抽样章节，至少 2 章保证跨章对比）；
  // env DOCUMENT_GLOBAL_CONSISTENCY_REVIEW=1 强制开启、=0 强制关闭；开启后在最终导出前做一次跨章一致性审查，
  // 审查发现的确定性数值冲突先进入定向修复闭环（修复→复检，最多 2 轮），仍有残留才注入导出校验升级为阻断
  let globalConsistencyIssues: string[] = [];
  if (generationStrategy.enableGlobalReview) {
    try {
      const samplingRate = generationStrategy.globalReviewSamplingRate ?? 1;
      const sampledChapters = samplingRate >= 1 || chapterDraftsFinal.length <= 2
        ? chapterDraftsFinal
        : chapterDraftsFinal.filter((chapter, index) => index % Math.max(2, Math.round(1 / samplingRate)) === 0);
      const sampledCount = sampledChapters.length;
      const runGlobalReview = () => withProgressHeartbeat(() => reviewGlobalConsistency({ template, chapters: sampledChapters, chapterReviews: [], promptTexts: reviewPromptTexts, requirement: input.requirement, projectContext, diagnostics: generationDiagnostics, signal: input.signal }));
      // 确定性跨章数值冲突（crossChapterConsistencyIssues / processSpecConflictIssues）：正文出现与资料
      // 建设规模/估算价/结构层规格不一致的取值时，确定性检测比 LLM 审查更精确；此前只在导出校验阶段暴露、
      // 生成流程内无修复机会，用户只能看到“导出门禁未通过”后手动继续生成（历史缺陷，且重跑生成必然复现——
      // LLM 依据同样资料会再次写出同样数值，导致“继续生成”按钮永远失败）。此处并入修复闭环统一修复。
      const runDeterministicConsistencyCheck = () => {
        const fullMarkdown = chapterDraftsFinal.map(chapter => chapter.content).join('\n\n');
        return [
          ...crossChapterConsistencyIssues(fullMarkdown, preliminaryFactsModel, canonicalFacts.scopeConflicts).filter(issue => /跨章一致性冲突/u.test(issue.message)),
          ...processSpecConflictIssues(fullMarkdown, preliminaryFactsModel).filter(issue => issue.level === 'error'),
        ].map(issue => `${issue.message}；${issue.suggestion || ''}`);
      };
      const globalReview = await runGlobalReview();
      globalConsistencyIssues = [...new Set([...globalReview.issues, ...runDeterministicConsistencyCheck()])];
      // 跨章一致性冲突修复闭环：按冲突描述中的正确口径对点名章节做 fact_conflict 定向修复，再复检；
      // 无任何 patch 落地的轮次立即停止，避免空转消耗 LLM 预算
      for (let repairRound = 0; repairRound < 2 && globalConsistencyIssues.length > 0; repairRound += 1) {
        upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'global-consistency-repair', status: 'running', message: `跨章一致性冲突第 ${repairRound + 1} 轮定向修复（${globalConsistencyIssues.length} 个冲突）` }, { subtitle: '跨章一致性修复' }));
        emitProgress(chapterDraftsFinal);
        let appliedCount = 0;
        for (const chapter of chapterDraftsFinal) {
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
            return Boolean(layer && chapter.content.includes(layer));
          });
          if (related.length === 0) continue;
          const repaired = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `global-consistency-repair:${chapter.id}`, () => repairChapterByQuality({
            template,
            chapter: { id: chapter.id, title: chapter.title, content: chapter.content, evidence: chapter.evidence || [], missingFacts: chapter.missingFacts || [], sections: chapter.sections },
            issues: related.map(issue => `${issue}；请严格按冲突描述中给出的资料口径修正本章对应表述，不得引入新的数值；与资料口径一致的既有表述（含分层/子项数值）不得改动。`),
            promptTexts: reviewPromptTexts,
            requirement: input.requirement,
            forbidDrawingImages: true,
            diagnostics: generationDiagnostics,
            signal: input.signal,
          })));
          if (repaired.content && repaired.content !== chapter.content) {
            chapter.content = repaired.content;
            appliedCount += 1;
          }
        }
        if (appliedCount === 0) break;
        emitProgress(chapterDraftsFinal);
        const reReview = await runGlobalReview();
        globalConsistencyIssues = [...new Set([...reReview.issues, ...runDeterministicConsistencyCheck()])];
        upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'global-consistency-review', status: globalConsistencyIssues.length > 0 ? 'failed' : 'success', message: globalConsistencyIssues.length > 0 ? `跨章一致性复检：仍有 ${globalConsistencyIssues.length} 个冲突` : '跨章一致性复检通过' }, { subtitle: '全局一致性审查' }));
        emitProgress(chapterDraftsFinal);
      }
      // 2 轮 LLM 定向修复仍未消除的数值冲突：按检测同源归属规则确定性定点替换（“检测定位=修复定位”），
      // 不依赖 LLM 定位能力——repairChapterByQuality 约束“无法安全定位的问题不要生成 patch”，数值冲突
      // 修复器常因无法在正文定位错误数值而不产出 patch，残留冲突会被导出门禁硬阻断形成“继续生成”死循环
      const deterministicFix = applyDeterministicConsistencyFixes(chapterDraftsFinal, preliminaryFactsModel, canonicalFacts.scopeConflicts);
      if (deterministicFix.fixedCount > 0) {
        // 修复后重算：确定性数值冲突快照必须用最新检测结果替换，不得合并保留已修复问题的旧快照
        //（历史缺陷：修复已生效但旧快照残留，被 finalize 包装为「跨章一致性复核」error 硬阻断导出）
        globalConsistencyIssues = [
          ...new Set([
            ...globalConsistencyIssues.filter(issue => !/^跨章一致性冲突|^工序规格冲突/u.test(issue)),
            ...runDeterministicConsistencyCheck(),
          ]),
        ];
        upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'global-consistency-deterministic-fix', status: 'success', message: `跨章一致性数值定点修复：${deterministicFix.fixedCount} 处（${deterministicFix.details.slice(0, 4).join('、')}）`, details: deterministicFix.details.slice(4) }, { subtitle: '跨章一致性修复' }));
        emitProgress(chapterDraftsFinal);
      }
      const sampledStage = sampledCount < chapterDraftsFinal.length ? { ...globalReview.stage, message: `${globalReview.stage.message || '全局一致性审查完成'}（抽检 ${sampledCount}/${chapterDraftsFinal.length} 章）` } : globalReview.stage;
      upsertProgressStage(progressStages, sampledStage);
      emitProgress(chapterDraftsFinal);
    } catch (err) {
      if (input.signal?.aborted) throw err;
      console.error('[gen] global consistency review failed:', err);
    }
  }

  // 表格执行率确定性核验：表格计划（治理决策）必须真实落为 markdown 表格；
  // 执行率显著不足的章节进入定向补表修复闭环（最多 2 轮），保证表格数量与计划一致
  let tableGaps = tablePlanExecutionGaps(effectiveChapters, chapterDraftsFinal);
  if (tableGaps.length > 0) {
    for (let round = 0; round < 2 && tableGaps.length > 0; round += 1) {
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'table-execution-repair', status: 'running', message: `表格执行率修复第 ${round + 1} 轮（${tableGaps.length} 个章节缺表）` }, { subtitle: '表格执行率修复' }));
      emitProgress(chapterDraftsFinal);
      let appliedCount = 0;
      for (const gap of tableGaps) {
        const draft = chapterDraftsFinal.find(item => item.title === gap.chapterTitle || gap.chapterTitle.includes(item.title) || item.title.includes(gap.chapterTitle));
        if (!draft) continue;
        const repaired = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `table-execution-repair:${draft.id}`, () => repairChapterByQuality({
          template,
          chapter: { id: draft.id, title: draft.title, content: draft.content, evidence: draft.evidence || [], missingFacts: draft.missingFacts || [], sections: draft.sections },
          issues: [`计划表格缺失（计划 ${gap.planned} 张，实际仅 ${gap.actual} 张）：${gap.plans.map(plan => `${plan.title}（表头：${plan.fields.map(field => field.name).join('、')}）`).join('；')}。必须按表头字段补齐这些 markdown 表格并紧跟相关小节输出，不得删除已有正文；每个表格前须有 1～2 句引导叙述说明表格作用与关键结论，表格不能替代小节正文；deriveFromProject 字段基于项目工程量、总工期与工序流水按定额工效推导具体数值，projectFactOnly 字段不得编造。`],
          promptTexts: reviewPromptTexts,
          requirement: input.requirement,
          forbidDrawingImages: true,
          diagnostics: generationDiagnostics,
          signal: input.signal,
        })));
        if (repaired.content && repaired.content !== draft.content) {
          draft.content = repaired.content;
          appliedCount += 1;
        }
      }
      if (appliedCount === 0) break;
      emitProgress(chapterDraftsFinal);
      tableGaps = tablePlanExecutionGaps(effectiveChapters, chapterDraftsFinal);
      upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'table-execution-review', status: tableGaps.length > 0 ? 'failed' : 'success', message: tableGaps.length > 0 ? `表格执行率复检：仍有 ${tableGaps.length} 个章节缺表` : '表格执行率复检通过' }, { subtitle: '表格执行率核验' }));
    }
  }

  // P4 预算裁剪报告：生成全程软限制裁剪量汇总，历史缺陷（maxItems/maxChars/slice 静默裁剪，链路无感知，
  // 质量问题时无法区分「证据不足」与「预算截断」）在此收敛为单一可观测出口；
  // 软限制审计分类：语义取舍类已迁移本地语义模型，防爆兜底类保留且逐项记录裁剪量
  {
    const evidenceStats = generationDiagnostics.evidence;
    const llmStats = generationDiagnostics.llm;
    upsertProgressStage(progressStages, displayStage({
      type: 'validation',
      roleId: 'budget-trim-report',
      status: 'success',
      message: `预算裁剪报告：证据 ${evidenceStats.raw} 条 → 采用 ${evidenceStats.used} 条（噪声过滤 ${evidenceStats.filteredNoise} 条、预算兜底裁剪 ${evidenceStats.budgetDropped} 条），证据上下文 ${evidenceStats.contextChars} 字`,
      details: [
        `证据质量：平均噪声分 ${evidenceStats.avgNoiseScore}，平均事实密度 ${evidenceStats.avgFactDensity}`,
        `检索：${evidenceStats.searchQueries} 组查询，耗时 ${Math.round(evidenceStats.searchMs / 1000)} 秒`,
        `LLM：${llmStats.calls} 次调用，失败 ${llmStats.failures} 次，重试 ${llmStats.retries} 次，schema 校验失败 ${llmStats.schemaFailures} 次`,
        '防爆兜底类软限制（保留并逐项记录裁剪量）：selectEvidenceByBudget 的 maxItems/maxChars、uniqueEvidence 噪声过滤、evidenceBundlePrompt 的 maxChars、块级证据 top-k 截断、块级 facts 截断',
        '语义取舍类软限制（已迁移本地语义模型）：evaluationTexts 词面过滤→条目对象化、criterionFeatures 二字滑窗→bge-small 余弦、章节证据字符硬截→语义排序取 top-k',
        'LLM 输出侧：schema 校验（截断位置可诊断）、空响应重试提示词收敛、块成稿 maxTokens 按目标字数 1:1.2（不走 thinking ×6 放大）',
      ],
    }, { subtitle: '预算裁剪审计' }));
    emitProgress(chapterDraftsFinal);
  }

  return finalizeGeneration({
    chapterDrafts: chapterDraftsFinal, chapterDraftsByOrder, chapterGenerationStagesByOrder,
    chapterGenerationStages, effectiveChapters, template, allEvidence,
    projectMaterialScope,
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
    globalConsistencyIssues,
    scopeConflicts: canonicalFacts.scopeConflicts,
    writingTaskBrief,
    evaluationCriteriaItems: evaluationItems.map(item => item.title).filter(Boolean),
    agentWorkflow,
    emitProgress, withProgressHeartbeat,
  });
}

export { regenerateDocumentChapter } from './documentRegeneration';
