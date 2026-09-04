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
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentTemplateChapter, GeneratedDocumentDraft, RetrievalCoverageReport, TenderRequirementModel, WebAccessConfig } from './types';
import { buildPromptBindingPlan, defaultProjectRoleConfigIdForTemplate, getDocumentTemplate } from './templateStore';
import { evidenceLine, evidencePromptBudgetForTarget, isExemptEvidenceSource, selectEvidenceByBudget } from './evidence';
import { displayChapterTitle, effectiveTemplateChapters, extractExplicitOutlineFromSources } from './outline';
import { evidenceMatchesFact } from './factMatching';
import { plannedStructurePrompt, extractGeneratedSections } from './markdownComposer';
import { buildDocumentBudget, documentTextLength } from './budget';
import { sectionContentIntegrityIssues } from './qualityValidation';
import { buildDocumentBlueprintContext, buildDocumentBlueprintStructure, buildChapterScopedProjectContext, composeScopedProjectContext } from './documentBlueprint';
import { enrichConstructionOrgOutline } from './constructionOrgCatalog';
import { validateBidStructureBeforeGeneration, extractEvaluationCriteriaItems, chapterCriteriaText, prioritizeOverviewSections } from './constructionBidStructure';
import { buildSemanticSimilarity } from './semanticSimilarity';
import { partitionEvidenceByContentSafety, evidenceSafetyKey, filterOffTopicSectionsForChapters, buildBidProcedureJudge } from './evidenceContentSafety';
import { emptyTenderRequirements, extractRequirementFieldGaps, extractTenderRequirements, filterMandatoryClauseEvidence, hasTenderRequirements, MANDATORY_FIELD_NAMES, mandatoryFieldGaps, mergeTenderRequirements, missingMandatoryFields, normalizeChapterTitleLine, preselectTenderRequirementEvidence, readCachedTenderRequirements, requirementFieldGaps, requirementFieldLabel, routeTenderRequirementsToChapters, tenderRequirementsCacheKey, tenderRequirementCheckItems, tenderRequirementSemanticQuery, tenderRequirementsSummary, tenderRequirementsWritingRules, writeCachedTenderRequirements } from './tenderRequirements';
import { applyRequirementSectionAdditions, calibrateOutlineSectionsToRequirements } from './requirementCalibration';
import { buildFactTokenScopeClassifier } from './factTokenClassifier';
import { buildProfessionalDepthClassifier } from './professionalDepthClassifier';
import { buildWritingTaskBrief } from './documentWritingTaskBrief';
import { buildConstructionOrgTablePlans } from './constructionOrgTablePlan';
import { buildRetrievalCoverageReport, retrieveDeepChapterEvidence, retrievalCoverageRisk, shouldTriggerDeepRetrieval } from './documentEvidenceRetrieval';
import { buildChapterFactNeeds, extractLocalFactPool, buildFactsModel, factNeedsCoveragePrompt, factsForChapterNeeds, resolveChapterFactNeeds } from './factsModel';
import { adaptiveConcurrency, alignSectionHeadingsToPlan, runWithAdaptiveConcurrency, Semaphore, stableHash, throwIfAborted } from './utils';
import { displayStage, elapsedMessage, upsertProgressStage } from './progress';
import { getActiveModelWithProvider, raiseDocumentLlmConcurrencyForScale } from './llmClient';
import { createGenerationDiagnostics, evidenceInScope, measureGenerationStep, promptTextsForResolvedPrompts, selectDocumentGenerationStrategy } from './rolePipeline';
import { buildGenerationBudget, type GenerationBudget } from './generationBudget';
import { buildProjectMaterialProfile, buildProjectUnderstanding, expandProjectMaterialBindings, materialKindMaps, materialRoleId, retrievePlannedMaterialEvidence, sampleProjectMaterialEvidence } from './projectMaterialProfile';
import { buildChapterFactCoverageContext, buildLlmChapterContent, buildPlannedChapterContent, buildSectionParallelChapterContent, capFactCoverageContext, evidenceForSection, outputTokensForChapter } from './chapterGeneration';
import type { PlannedChapterContentInput, PlannedChapterContentResult } from './chapterGeneration';
import { planChapterStructure, type PlannedChapterStructure } from './chapterPlanner';
import { QUANTIFIED_FACT_RE } from './parameterPatterns';
import { chapterSectionFactUsageIssues } from './chapterReview';
import { buildRuntimePromptRules, cleanSectionTitleArtifacts, extractPromptStructuralRules, normalizePlannedSections, planChapterSectionsWithLlm, runtimePromptRulesPrompt } from './promptRuleExtraction';
import { retrieveWebEvidence, webAccessPrompt } from './webResearchService';
import { finalizeGeneration } from './documentPipeline';
import { chapterCompletionStatus, chapterGenerationTargets, collectProjectBasicEvidence, compactChapterQueries, finalizeChapterContentQuality, kbIndexHealth, optimizeChapterEvidence, preselectSemanticCandidates, PROJECT_BASIC_FACT_QUERIES, qualityFirstEvidenceItemLimit, resolveChapterPromptExecution, resolveDocumentGenerationEvidenceLimit, retrieveSectionEvidence, searchWeightsForChapter, semanticEvidenceText, stripBidDisciplineSentencesSemantic } from './documentGeneratorHelpers';
import { buildProjectGraph } from './projectGraph';
import { referenceQualityTargetLines, referenceWritingSkeletonLines } from './templateReferenceService';
import { buildScopedProjectIntelligence, constructionOrganizationPrompt, isIrrelevantProjectGap } from './projectIntelligence';
import { assertEvidenceInProjectScope, createProjectMaterialScope, filterEvidenceByProjectScope, projectScopeAudit } from './projectMaterialScope';
import { agentWorkflowStages, createAgentWorkflowContext, throttleAgentWorkflowNodes } from './agentWorkflow';
import { chapterTaskPrompt, chapterTaskPromptForPlannedStructure, planChapterTask, planDocument } from './agentPlanner';
import { buildCanonicalFactModel, governEvidenceValues, PROJECT_BASIC_FIELD_SPECS, renderScopeOverrideAnchors } from './factGovernance';
import { buildChapterReadinessPlan } from './chapterReadiness';
import { chineseTokenMatch } from './textMatch';
import { alignPlanDataToMaster, buildPlanDataMaster, renderBasicFactsForMaster, renderPlanDataMaster } from './planDataMaster';
import { buildDecisionLock, renderDecisionLock } from './decisionLock';
import { dedupeAfterTableFix, repairTableExecutionGaps, reportBudgetTrimAudit, runGlobalConsistencyReviewLoop } from './globalQualityGates';

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
  // round-20 S5/W7 P6-3：写作硬约束前置到生成提示词——禁编日期/禁商务数据/禁来源罗列/禁概况复述/禁后台话术
  // 在生成时即遵守，替代“先生成后检测删除”的事后修补（历史缺陷：修补链每轮 patch 都会冲掉前一轮修复）
  const generationWritingConstraintsPrompt = ['【全文写作硬约束（每一章生成时必须遵守，违反即评审失分）】',
    '1. 禁止编造时间事实：开工日期、竣工日期、工期起止等未在项目资料中确认的日期一律不得写入正文；进度表述改用“开工后第 N 天”“第 N 周”等相对口径，或引用资料中已确认的日期。',
    '2. 禁止商务数据：暂列金额、暂估价、综合单价、清单合价、税率、投标报价等商务条款数据不得写入施工组织设计正文，商务口径只允许出现在项目信息表中。',
    '3. 禁止资料来源罗列话术：不得出现“根据/依据招标文件、工程量清单、图纸及答疑”式来源罗列句，直接陈述项目事实与施工安排；编制依据小节可集中列出依据文件。',
    '4. 禁止跨章复述概况：除“工程概况/项目概况”章节外，其余章节不得以“本项目为/本工程为”开头整段复述项目总体概况，应直接展开本章主题内容。',
    '5. 禁止后台内部话术：不得出现“工作包”“WRITER_MISSING_SECTION”“已确认资料”等系统内部术语与兜底话术，一律改写为正式施工组织设计表述。',
    // round-21 S6：合规数值红线——安全/职业健康/危大工程章节是外部评审高危失分区（历史缺陷：
    // 高温停工写成 42℃、危大判定线张冠李戴、专家论证程序缺签章、同一监测指标两处数值矛盾），
    // 通用法规阈值前置到写作约束，从源头杜绝编造
    '6. 合规数值红线（安全、职业健康、危大工程章节必须逐条对照，违反即合规失分）：',
    '  a. 高温停工按《防暑降温措施管理办法》（安监总安健〔2012〕89号）：日最高气温达到40℃以上应停止当日室外露天作业；37℃~40℃时室外露天作业时间累计不得超过6小时且气温最高时段3小时内不得安排室外露天作业；35℃~37℃时应换班轮休缩短连续作业时间。不得写成42℃等其他阈值。',
    '  b. 危大工程判定线按住建部令第37号及建办质〔2018〕31号：基坑（槽）土方开挖、支护、降水，开挖深度超过3m（含3m）属危大工程，超过5m（含5m）属超过一定规模（需专家论证）；模板支撑搭设高度8m及以上或搭设跨度18m及以上属超过一定规模；落地式钢管脚手架搭设高度24m及以上属危大工程、50m及以上属超过一定规模，悬挑式脚手架分段架体搭设高度20m及以上属超过一定规模；采用非常规起重设备方法且单件起吊重量10kN及以上属危大工程、100kN及以上属超过一定规模。判定必须给出本项目对应参数（开挖深度/支撑高度/搭设高度/起吊重量），参数未在资料中确认的不得自行判定为危大或超危大。证据中含基坑底标高、±0.000对应绝对标高、垫层底标高等数值的，必须直接引用并据此给出开挖深度具体数值（开挖深度=地面标高-坑底标高），不得仅写“开挖深度超过3m”而不给数值；标高、坡率（如1:1.5）等设计参数应写入基坑支护与土方开挖相关小节。',
    '  c. 专家论证程序按住建部令第37号：超过一定规模的危大工程专项方案应组织不少于5名符合专业要求的专家（从地方住建主管部门专家库选取）论证；修改后的方案由施工单位技术负责人审核签字、加盖单位公章，并由总监理工程师审查签字、加盖执业印章后方可实施。',
    '  d. 监测预警值单一口径：同一监测指标（基坑位移速率、沉降预警值等）全文只能出现一个数值口径，不得前后矛盾；预警值优先引用设计文件明确值，无设计要求时按现行监测技术标准选取并注明依据。',
    '  e. 自设数值自洽：自设的防护尺寸、频次、时间节点等数值必须与同章及跨章表述一致，且尽量引用现行规范依据；无规范依据的自设值不得写成硬性规定。',
    // round-25：表格口径自查泄漏治理（历史缺陷：写手把「合计行与明细不一致，故修正为…」的推算过程写进正文，
    // 与表格数值自相矛盾直接进成品）——自查过程必须留在推理中，正文只呈现自洽的最终数值
    '7. 禁止数据自查话术：不得把表格口径推算、数据一致性自查过程写入正文（如"上表合计行…与…不一致，故…修正为…"），表格与正文数值必须直接自洽；不得把招标条款编号碎片（如"3项规定""1委员会确定中""56m15：…"）作为小节标题。',
    // 评分报告问题2：纪律承诺段（「对参与本项目投标及施工组织设计编制的工作人员实行严格的纪律管理，
    // 确保投标活动合法合规」）被 LLM 写入正文——投标/评标纪律属商务投标函内容，技术标出现即降专业性
    '8. 禁止商务投标函内容：投标/评标纪律承诺、廉洁承诺、廉洁自律、行贿、串标、围标、弄虚作假、干扰评标等商务投标函条款与承诺一律不得写入施工组织设计正文（招标文件中的此类条款属商务文件应响应内容，不是技术标内容）；本节只写技术方案与管理措施，不得以承诺句形式响应此类条款。'].join('\n');
  const generationControlPrompt = [generationWritingConstraintsPrompt, projectUnderstanding.prompt, projectMaterialPrompt(projectMaterialSummary, { publicSafe: true }), autoSpecPrompt(documentSpec, autoSpec.sourceHash, { publicSafe: true }), readinessPrompt(readiness, { publicSafe: true })].filter(Boolean).join('\n\n');
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
  // A3 修复类轻量提示词：跨章一致性修复/表格补写等 patch 级调用只背「写作硬约束+运行规则+格式规则」，
  // 不再携带全部写作/章节角色提示词全文（几十 k 字符中大部分与局部 patch 无关）——
  // 注意力聚焦的 patch 修复更精准，修复调用输入大幅瘦身；评审审查类调用仍用 reviewPromptTexts 全量视角
  const repairPromptTexts = [generationControlPrompt, runtimeRulesText, promptTextsForResolvedPrompts(promptPlan.formattingPrompts)].filter(Boolean).join('\n\n');
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
  const getCachedFileDetail = (relativePath: string) => {
    const key = `${relativePath}::full`;
    if (!fileDetailCache.has(key)) {
      try {
        fileDetailCache.set(key, project.getFileDetail?.(relativePath));
      } catch {
        fileDetailCache.set(key, undefined);
      }
    }
    return fileDetailCache.get(key);
  };
  const searchWithCache = async (query: string, scopedFilePaths: string[], limit: number, chapterTitle: string) => {
    const weights = searchWeightsForChapter(chapterTitle);
    // E1/E2：章节主检索为生成场景检索——generationMode:true 跳过 LLM 查询扩展（省 LLM 预算）。
    // cross-encoder 语义重排已恢复：推理下沉 worker 线程（packages/knowledge rerank-worker-thread），
    // 主线程不再被 ONNX 推理阻塞（历史：237 组查询 × 30 候选主线程推理阻塞 20-60 分钟，
    // 曾被迫 disableReranker 退化为纯 JS heuristicRerank，小节级证据相关性排序精度下降）。
    // 回退开关：DOCUMENT_GENERATION_RERANKER=0 恢复 heuristicRerank；KB_RERANKER_WORKER=0 回退主线程推理
    const generationRerankerEnabled = process.env.DOCUMENT_GENERATION_RERANKER !== '0';
    const key = stableHash({ query, scopedFilePaths, limit, weights, generationMode: true, reranker: generationRerankerEnabled });
    const cached = searchCache.get(key);
    if (cached) return cached;
    const result = await manager.search(projectRoot, query, {
      scope: 'project',
      filters: { filePaths: scopedFilePaths },
      limit,
      weights,
      generationMode: true,
      disableReranker: !generationRerankerEnabled,
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
  // 证据内容安全分区（源头断流，评分报告 P1 串章根因治理）：投标/评标纪律、评标办法、商务报价类证据
  // 从写手/图谱/事实/大纲链统一断开；系统侧消费通道（评分标准条目提取、招标要求提取）继续直读全量 allEvidence。
  // 语义模型恒可用：空候选由恒零函数承接，无降级分支（过滤失效显性暴露而非静默放行）
  const { safe: writerEvidence, excluded: excludedEvidence } = await partitionEvidenceByContentSafety(allEvidence);
  // 生成后清洗第二道防线的语义判定器：与证据层同口径原型集（嵌入一次构建，章节循环全程复用）
  const bidProcedureJudge = await buildBidProcedureJudge();
  if (excludedEvidence.length > 0) {
    upsertProgressStage(progressStages, displayStage({ type: 'knowledge_retrieval', roleId: 'evidence-content-safety', status: 'success', message: `证据内容安全过滤：${excludedEvidence.length} 条投标程序/评标纪律类证据已从写作链断开（系统侧提取通道不受影响）`, details: excludedEvidence.slice(0, 6).map(item => `${path.basename(item.filePath)}｜${item.sectionTitle || '正文片段'}`) }, { subtitle: '证据内容安全', order: progressStages.length }));
    emitProgress();
  }
  const safeProjectBasicEvidence = projectBasicEvidence.filter(item => !excludedEvidence.includes(item));
  // 排除证据内容指纹集：写作链证据（pinned/搜索召回）多为浅拷贝，按 filePath+sectionTitle 指纹比对
  const excludedEvidenceKeys = new Set(excludedEvidence.map(evidenceSafetyKey));
  // 本地事实池统一入口（与 finalize 抽取点同源，见 factsModel.extractLocalFactPool）：
  // 四个本地抽取器 + 项目范围过滤单点收敛；structuredTables 经工作簿解析缓存，
  // finalize 复抽取同一批表文件时零重复磁盘 IO（行为保持，抽取语义零变化）
  const earlyFactPool = extractLocalFactPool({ evidence: writerEvidence, template, spec: documentSpec, profile: domainProfile, scope: projectMaterialScope });
  const earlyLocalFacts = earlyFactPool.localFacts;
  const earlyProjectBasicFacts = earlyFactPool.projectBasicFacts;
  const earlyPreciseFacts = earlyFactPool.preciseFacts;
  const preliminaryFacts = [...earlyLocalFacts, ...earlyProjectBasicFacts, ...earlyPreciseFacts];
  const scopedIntelligence = buildScopedProjectIntelligence({ projectRoot, template, requirement: input.requirement });
  const intelligenceFacts = scopedIntelligence?.facts || [];
  const combinedPreliminaryFacts = [...intelligenceFacts, ...preliminaryFacts];
  const preliminaryFactsModel = await buildFactsModel(combinedPreliminaryFacts, earlyFactPool.structuredTables, missingItems, documentSpec, domainProfile);
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
    const projectGraphResult = await withProgressHeartbeat(() => buildProjectGraph({ evidence: writerEvidence, signal: input.signal, projectRoot, requirement: input.requirement, templateId: template.id }), progressStages);
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
  // 并以本地 bge-small 嵌入构建“条目标题 ↔ 大纲章节”语义相似度函数供承接审计使用（本地 bge 恒可用，构建失败直接抛出）
  const evaluationSourceTexts = allEvidence
    .filter(item => /评审|评分标准|评分办法|详细评审/u.test(`${item.sectionTitle || ''}${item.content}`))
    .map(item => item.content);
  const evaluationItems = extractEvaluationCriteriaItems(evaluationSourceTexts);
  // 空输入短路显性化（历史缺陷：评审证据存在但编号条目提取为空时，承接审计静默通过）——
  // 显性 stage 提示降级风险；黄山杯等短条目/绿色等级/禁编日期由评分项要求提取通道覆盖，不受此影响
  if (evaluationSourceTexts.length > 0 && evaluationItems.length === 0) {
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'bid-structure-audit', status: 'skipped', message: '评审章节证据存在但未提取到评分条目标题：评分标准编号条目提取为空，承接审计将静默通过', details: ['请检查招标文件评标办法章节编号格式；评分项要求（创优目标/绿色等级/禁编日期）由评分项要求提取通道覆盖'] }, { subtitle: '评标结构校验', order: progressStages.length }));
  }
  const criteriaSimilarity = await buildSemanticSimilarity(
    evaluationItems.map(item => item.title),
    enrichedOutlineChapters.map(chapterCriteriaText),
  );
  const bidStructureAudit = validateBidStructureBeforeGeneration({ template, chapters: enrichedOutlineChapters, requirement: input.requirement, evaluationItems, semanticSimilarity: criteriaSimilarity });
  // C1 前置链并行：评分项要求提取链（招标直读→预筛→主提取∥窄通道召回→条件补提→合并→缓存）
  // 独立任务与大纲规划并行执行——提取 LLM 时间被规划 LLM 时间覆盖（真实生成前置链省 2~4 分钟）；
  // 提取失败独立降级为空模型 + skipped 显性警示（提取失败不得阻断生成，与串行路径 skipped 语义一致）
  const tenderRequirementsTask = (async (): Promise<TenderRequirementModel> => {
    try {
      // 招标文件“要求与标准”层提取（round-13）：LLM 结构化提取全文评分项要求（创优目标/绿色等级/奖项条款/体系基准/禁编日期），
      // 不限于评审章节——投标人须知前附表（如 10.9）、专用合同条款（如 5.1.1）、技术标准章节（如第七章）等位置的要求均覆盖。
      // 提取失败/无绑定资料时返回空模型，零响应检测自动跳过。
      // W4/P3：提取证据预算上调（36→60 条 / 50k→100k 字符），要求层证据优先保留（截断即提取缺失）；
      // round-21 S6 修复：maxItemsPerFile 12→60（历史缺陷：招标文件.pdf 200+ 切片被单文件 12 条上限硬砍，
      // 评标办法正文（位于文件中后部）进不了提取输入 → 零响应 skipped → 评标结构约束整体失效）
      // round-21 S6 修复二（根因）：提取阶段 allEvidence 仅含 24 条基础事实（collectProjectBasicEvidence 按
      // projectBasicFactScore 过滤 + slice(0,24)），评标办法正文不含基础事实字段被整体过滤掉 → 提取输入无米下锅。
      // 改为招标/补疑/答疑文件直读全文（绕开检索与事实过滤，评标办法正文完整进入提取输入）；无直读内容时回退检索预算通道。
      const tenderFileEvidence: DocumentEvidence[] = [];
      for (const relativePath of [...evidenceScopePaths].sort()) {
        if (!/招标|补疑|答疑|评标/u.test(relativePath)) continue;
        const detail = getCachedFileDetail(relativePath);
        if (!detail?.chunks?.length) continue;
        for (const chunk of detail.chunks as Array<{ content: string; sectionTitle?: string }>) {
          tenderFileEvidence.push({
            chapterId: 'tender-requirements',
            filePath: detail.file?.relativePath || relativePath,
            score: 1,
            content: chunk.content || '',
            roleId: fileRoleByPath.get(relativePath),
            processingType: fileProcessingByPath.get(relativePath),
            sectionTitle: chunk.sectionTitle,
            source: 'pinned-evidence',
          });
        }
      }
      // 有用数据预筛（上下文聚焦治理）：招标文件直读全量中含约半数投标程序/清单/目录/格式类
      // 无用切片，全量吞入既浪费上下文又稀释模型注意力（真实生成回归：12 万字符全量分片下
      // 黄山杯等短条款被噪声稀释漏提）。预筛只召回义务词形/语义命中的切片进主提取；
      // 全量 tenderFileEvidence 仍保留作窄通道召回池（filterMandatoryClauseEvidence 全量参与）。
      const tenderRequirementEvidence = tenderFileEvidence.length > 0
        ? await preselectTenderRequirementEvidence(tenderFileEvidence)
        : selectEvidenceByBudget(
          [...allEvidence.filter(item => /招标|评标|投标须知|专用合同|合同条款|技术标准|技术要求/u.test(`${item.filePath || ''}${item.sectionTitle || ''}`)), ...allEvidence.filter(item => !/招标|评标|投标须知|专用合同|合同条款|技术标准|技术要求/u.test(`${item.filePath || ''}${item.sectionTitle || ''}`))],
          { preservePinned: true },
        );
      if (tenderFileEvidence.length > 0) {
        const beforeChars = tenderFileEvidence.reduce((sum, item) => sum + (item.content?.length || 0), 0);
        const afterChars = tenderRequirementEvidence.reduce((sum, item) => sum + (item.content?.length || 0), 0);
        upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'tender-requirement-preselect', status: 'success', message: `评分项要求有用数据预筛：${tenderFileEvidence.length} → ${tenderRequirementEvidence.length} 条切片（${Math.round((afterChars / Math.max(1, beforeChars)) * 100)}% 字符量）`, details: ['投标程序/清单/目录/格式类切片已从主提取输入剔除（义务词形+语义命中双通道保留）', '全量切片仍作必提条款窄通道召回池，兜底不失效'] }, { subtitle: '评分项要求提取·预筛', order: progressStages.length }));
        emitProgress();
      }
      // B 阶段：提取结果磁盘缓存（防脏双门禁+哈希失效）——同一项目资料未变化时跳过主提取/窄通道 LLM，
      // 命中时显性标注「复用上次提取」；env DOCUMENT_EXTRACTION_CACHE=0 显式关闭
      const extractionCacheEnabled = process.env.DOCUMENT_EXTRACTION_CACHE !== '0';
      const extractionCacheKey = extractionCacheEnabled ? tenderRequirementsCacheKey({ collectionEvidence: tenderFileEvidence, preselectEvidence: tenderRequirementEvidence }) : undefined;
      const cachedTenderRequirements = extractionCacheKey ? readCachedTenderRequirements(projectRoot, extractionCacheKey) : undefined;
      let tenderRequirements: TenderRequirementModel;
      if (cachedTenderRequirements) {
        tenderRequirements = cachedTenderRequirements;
        // roleId 与提取成功阶段分离：upsertProgressStage 按 type+roleId 覆盖，同 roleId 会吞掉「复用」标注
        upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'tender-requirements-cache', status: 'success', message: '复用上次提取结果（招标文件与预筛输入哈希命中，跳过主提取/窄通道 LLM）', details: tenderRequirementsSummary(tenderRequirements) }, { subtitle: '评分项要求提取·缓存复用', order: progressStages.length }));
        emitProgress();
      } else {
        tenderRequirements = await withProgressHeartbeat(() => extractTenderRequirements(tenderRequirementEvidence, { signal: input.signal }));
        // W4/P3 提取失败重试：一次调用失败不静默跳过（要求层整体失效 = 评标失分级风险），重试一次仍失败才走 skipped stage 显式可见
        if (!hasTenderRequirements(tenderRequirements) && tenderRequirementEvidence.length > 0) {
          tenderRequirements = await withProgressHeartbeat(() => extractTenderRequirements(tenderRequirementEvidence, { signal: input.signal }));
        }
        // round-23 P0-1：必提条款窄通道双路提取——主提取 150k 全量输入会稀释模型注意力，
        // 黄山杯/绿色等级/智慧工地等短条必提条款漏提（外部评分否决级：全文零落位且写作层杜撰替代奖项）。
        // 召回由本地 bge 语义模型完成（语义特征集余弦排序取 top-k），语义提取仍归 LLM 独立小输入，字段级合并补齐主结果缺失字段。
        const mandatoryEvidence = await filterMandatoryClauseEvidence(tenderFileEvidence);
        const initialGaps = mandatoryFieldGaps(tenderRequirements);
        if (mandatoryEvidence.length > 0 && initialGaps.length > 0) {
          const narrowRequirements = await withProgressHeartbeat(() => extractTenderRequirements(mandatoryEvidence, { signal: input.signal }));
          if (hasTenderRequirements(narrowRequirements)) {
            tenderRequirements = mergeTenderRequirements(tenderRequirements, narrowRequirements);
            upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'tender-mandatory-extraction', status: 'success', message: '必提条款窄通道补提完成（主提取漏提字段已补齐）', details: tenderRequirementsSummary(narrowRequirements) }, { subtitle: '评分项要求提取·必提补提', order: progressStages.length }));
            emitProgress();
          }
        }
        // round-26 字段级定向补提闭环（独立于窄通道，覆盖全部评分项要求字段——必提 6 字段 +
        // 特殊质量/前附表/禁编/禁止性；评标办法/篇幅要求按项目需求不提取）：
        // 主提取+窄通道后仍缺失的字段，做句级窗口聚焦提取（真实生成回归：招标文件 5.1.1 切片
        // 含全部字段原文，主提取+窄通道两轮均漏提）。窗口无证据的字段判定「资料无此要求」，
        // 降级为信息提示而非告警；证据存在但 LLM 仍漏提的字段分级告警（必提=告警，常规=提示）。
        // 字段补提残余真漏提字段（窗口证据存在但 LLM 仍漏提）：缓存防脏写门禁用——
        // 常规字段缺失会被旧门禁（仅查必提字段）放行固化，下次读缓存命中跳过补提闭环 → 永久丢失
        let stillMissingFields: string[] = [];
        const fieldGapsBefore = requirementFieldGaps(tenderRequirements);
        if (fieldGapsBefore.length > 0 && tenderFileEvidence.length > 0) {
          const gapResult = await withProgressHeartbeat(() => extractRequirementFieldGaps(tenderRequirements, tenderFileEvidence, { signal: input.signal }));
          tenderRequirements = gapResult.model;
          stillMissingFields = gapResult.stillGaps;
          const noEvidence = gapResult.noEvidenceGaps;
          // stillGaps 与 noEvidenceGaps 语义互斥（见 extractRequirementFieldGaps）：stillGaps 即窗口证据存在但 LLM 仍漏提的真漏提字段
          const missingByEvidence = gapResult.stillGaps;
          if (gapResult.stillGaps.length === 0) {
            upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'tender-field-gap-extraction', status: 'success', message: '评分项要求字段定向补提完成（字段级聚焦提取，全部评分项要求字段已提取）', details: tenderRequirementsSummary(tenderRequirements) }, { subtitle: '评分项要求提取·字段补提', order: progressStages.length }));
            emitProgress();
          }
          const isMandatory = (name: string) => (MANDATORY_FIELD_NAMES as readonly string[]).includes(name);
          if (missingByEvidence.length > 0) {
            const stillMandatory = missingByEvidence.filter(isMandatory);
            const stillOptional = missingByEvidence.filter(name => !isMandatory(name));
            const parts = [
              stillMandatory.length > 0 ? `必提字段 ${stillMandatory.map(name => requirementFieldLabel(name as (typeof MANDATORY_FIELD_NAMES)[number])).join('、')}` : '',
              stillOptional.length > 0 ? `常规字段 ${stillOptional.map(name => requirementFieldLabel(name as (typeof MANDATORY_FIELD_NAMES)[number])).join('、')}` : '',
            ].filter(Boolean);
            upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'tender-field-gap-missing', status: 'skipped', message: `字段定向补提后仍缺失：${parts.join('；')}（条款窗口证据存在但 LLM 提取失败）`, details: ['请检查 LLM 可用性与输出质量；正文将无法显性响应上述评分项要求'] }, { subtitle: '评分项要求提取·字段缺口', order: progressStages.length }));
            emitProgress();
          }
          if (noEvidence.length > 0) {
            const noEvidenceMandatory = noEvidence.filter(isMandatory);
            const noEvidenceOptional = noEvidence.filter(name => !isMandatory(name));
            const parts = [
              noEvidenceMandatory.length > 0 ? `必提字段 ${noEvidenceMandatory.map(name => requirementFieldLabel(name as (typeof MANDATORY_FIELD_NAMES)[number])).join('、')}` : '',
              noEvidenceOptional.length > 0 ? `常规字段 ${noEvidenceOptional.map(name => requirementFieldLabel(name as (typeof MANDATORY_FIELD_NAMES)[number])).join('、')}` : '',
            ].filter(Boolean);
            // roleId 独立于上方缺失告警 stage：同 roleId 会被 upsert 覆盖互吞（两分支可同时存在）
            upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'tender-field-gap-no-evidence', status: 'skipped', message: `${parts.join('；')}：招标资料中未找到对应条款（判定为无此要求，非漏提）`, details: ['若项目实际存在该要求，请检查招标文件相关章节切片完整性'] }, { subtitle: '评分项要求提取·字段缺口', order: progressStages.length }));
            emitProgress();
          }
        }
        // 写缓存（防脏写门禁：空结果/必提字段缺失/字段补提仍漏提不落盘，坏数据永不固化——
        // stillGaps 真漏提字段一旦固化，下次读缓存命中即跳过补提闭环，常规字段缺失永久丢失）
        if (extractionCacheKey && stillMissingFields.length === 0) writeCachedTenderRequirements(projectRoot, extractionCacheKey, tenderRequirements);
      }
      if (hasTenderRequirements(tenderRequirements)) {
        upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'tender-requirements-extraction', status: 'success', message: '招标文件评分项要求结构化提取完成', details: tenderRequirementsSummary(tenderRequirements) }, { subtitle: '评分项要求提取', order: progressStages.length }));
        emitProgress();
      } else if (tenderRequirementEvidence.length > 0) {
        upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'tender-requirements-extraction', status: 'skipped', message: '评分项要求提取未获得有效结果（模型不可用或资料中无要求），零响应检测自动跳过', details: [] }, { subtitle: '评分项要求提取', order: progressStages.length }));
        emitProgress();
      }
      return tenderRequirements;
    } catch (error) {
      // 提取链独立降级：bge/LLM 异常一律走空模型 + skipped 显性警示，不阻断生成
      upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'tender-requirements-extraction', status: 'skipped', message: '评分项要求提取链异常，已降级为空模型（零响应检测自动跳过）', details: [`异常信息：${error instanceof Error ? error.message : String(error)}`, '请检查 LLM 可用性与本地语义模型状态'] }, { subtitle: '评分项要求提取', order: progressStages.length }));
      emitProgress();
      return emptyTenderRequirements(false);
    }
  })();
  const baseEffectiveChapters = buildConstructionOrgTablePlans({ chapters: bidStructureAudit.enrichedChapters, projectGraph, canonicalFacts });
  template = { ...template, chapters: baseEffectiveChapters };
  // P4 确定性并行化：planDocument（章节任务规划，纯确定性逻辑 + 本地嵌入分类，无 LLM 调用）提前启动，
  // 与下方评审条目语义构建、招标要求提取、事实主表构建等前置链并行执行，原串行位置 await 结果；
  // 提前启动期间若拒绝，catch 占位防 unhandledRejection（错误在下方 await 处统一抛出）
  const plannedDocumentTask = planDocument({ template, context: agentWorkflow, title: template.name });
  plannedDocumentTask.catch(() => undefined);
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
      const matchedGaps = projectGraph.gaps.filter(g => !isIrrelevantProjectGap(g) && (matchesText(g) || broadChapter));

      const graphFiles = new Set<string>();
      for (const w of matchedWorks) (w.sourceFiles || []).forEach(f => graphFiles.add(f));
      for (const m of matchedMethods) (m.sourceFiles || []).forEach(f => graphFiles.add(f));
      for (const r of matchedResources) (r.sourceFiles || []).forEach(f => graphFiles.add(f));
      if (graphFiles.size === 0 && broadChapter) [...graphAllFiles].forEach(f => graphFiles.add(f));

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
  // 清单层标题清洗诊断（改8）：模板显式小节路径同样做确定性清洗，脏标题不再进入写作计划
  const sectionPlanCleanupNotes: string[] = [];
  const plannedChapters = await runWithAdaptiveConcurrency(effectiveChapters.map((chapter, chapterIndex) => ({ chapter, chapterIndex })), async ({ chapter, chapterIndex }) => {
    if (chapter.sections?.length) {
      skippedSectionPlanningCount += 1;
      const lockedSections = promptStructuralRules.filter(rule => rule.chapterIndex === chapterIndex || (rule.chapterTitle && displayChapterTitle(rule.chapterTitle) === displayChapterTitle(chapter.title))).flatMap(rule => rule.requiredSections.sort((a, b) => (a.order || 0) - (b.order || 0)).map(section => section.title));
      for (const raw of [...lockedSections, ...chapter.sections]) {
        const cleaned = cleanSectionTitleArtifacts(String(raw).trim());
        if (cleaned && cleaned !== String(raw).trim()) sectionPlanCleanupNotes.push(`${displayChapterTitle(chapter.title)}：${raw} → ${cleaned}`);
      }
      const mergedSections = normalizePlannedSections([...lockedSections, ...chapter.sections], chapter.title);
      return { ...chapter, sections: mergedSections.length ? mergedSections : normalizePlannedSections(chapter.sections, chapter.title) };
    }
    llmSectionPlanningCount += 1;
    const chapterEvidence = selectEvidenceByBudget(writerEvidence.filter(item => item.chapterId === chapter.id || evidenceMatchesFact(item, chapter.title)), { preservePinned: true });
    const roleContext = projectUnderstanding.chapterPlans.find(plan => plan.chapterId === chapter.id)?.writingGoal || '';
    const planningPromptExecution = resolveChapterPromptExecution(promptPlan, chapter);
    const sections = await planChapterSectionsWithLlm({ template: provisionalTemplate, chapter, chapterIndex, evidence: chapterEvidence, promptTexts: planningPromptExecution.promptTexts, projectContext, requirement: input.requirement, roleContext, targetWords: provisionalBudget.chapterTargets.get(chapter.id) || 1200, structuralRules: promptStructuralRules, signal: input.signal });
    const lockedRuleDetails = promptStructuralRules.filter(rule => rule.chapterIndex === chapterIndex || (rule.chapterTitle && displayChapterTitle(rule.chapterTitle) === displayChapterTitle(chapter.title))).flatMap(rule => rule.requiredSections.map(section => `强制小节：${section.title}`));
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'section-planning', promptId: planningPromptExecution.primaryPromptId, status: sections.length ? 'success' : 'failed', message: `${displayChapterTitle(chapter.title)} 小节规划${sections.length ? `生成 ${sections.length} 个小节` : '未生成可用小节'}`, details: [...planningPromptExecution.promptDetails, ...lockedRuleDetails, ...(sections.length ? sections.map(section => `规划小节：${section}`) : ['规划结果为空或被污染过滤'])] }, { subtitle: '小节规划' }));
    if (!sections.length) throw new Error(`${displayChapterTitle(chapter.title)} 小节规划未生成可用小节`);
    return { ...chapter, sections };
  }, { kind: 'llmRepair', targetWords: provisionalBudget.targetChars || 4000 });
  // C1：等待并行提取链结果（评分项要求——大纲要求校准与后续要求路由的输入）
  const tenderRequirements = await tenderRequirementsTask;
  const plannedWithConstructionOrgOutline = enrichConstructionOrgOutline({ template, chapters: plannedChapters, requirement: input.requirement });
  // C2 大纲要求校准：规划完成后、主题过滤前——评分项要求在结构层显性承接（创优目标与奖惩/绿色等级/智慧工地等
  // 必提要求在大纲层就有承接小节，而非写章时临场发挥）；additions-only 输出 + 结构守恒校验（原大纲小节不可能被删），
  // 空响应/失败/校验不通过一律回退原规划；env DOCUMENT_REQUIREMENT_CALIBRATION=0 可整体回退
  const requirementCalibrationEnabled = process.env.DOCUMENT_REQUIREMENT_CALIBRATION !== '0';
  let plannedWithCalibration = plannedWithConstructionOrgOutline.chapters;
  if (requirementCalibrationEnabled && hasTenderRequirements(tenderRequirements)) {
    const additions = await withProgressHeartbeat(() => calibrateOutlineSectionsToRequirements({ chapters: plannedWithConstructionOrgOutline.chapters, requirementSummary: tenderRequirementsSummary(tenderRequirements), templateName: template.name, signal: input.signal }));
    if (additions.length > 0) {
      const calibrationResult = applyRequirementSectionAdditions(plannedWithConstructionOrgOutline.chapters, additions);
      if (calibrationResult.applied.length > 0) {
        plannedWithCalibration = calibrationResult.chapters;
        upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'outline-requirement-calibration', status: 'success', message: `大纲要求校准：新增 ${calibrationResult.applied.reduce((sum, item) => sum + item.sections.length, 0)} 个评分项承接小节（结构守恒校验通过）`, details: calibrationResult.applied.map(item => `${displayChapterTitle(item.chapterTitle)}：${item.sections.join('、')}`) }, { subtitle: '大纲要求校准', order: progressStages.length }));
        emitProgress();
      } else {
        upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'outline-requirement-calibration', status: 'skipped', message: '大纲要求校准未通过结构守恒校验，回退原规划', details: ['校准新增小节未通过章名匹配/标题清洗校验，全部丢弃'] }, { subtitle: '大纲要求校准', order: progressStages.length }));
        emitProgress();
      }
    } else {
      upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'outline-requirement-calibration', status: 'skipped', message: '大纲要求校准未产出有效增量（章节结构已覆盖评分项要求或校准调用失败），回退原规划', details: [] }, { subtitle: '大纲要求校准', order: progressStages.length }));
      emitProgress();
    }
  }
  // 大纲小节主题约束（P1 串章根因治理）：投标/评标纪律、评标办法、商务报价类小节在大纲出口统一剔除，
  // 覆盖模板静态 sections 与 LLM 规划两条路径；下游写作/目录/预算无感知
  const plannedWithConstructionOrgRequiredSections = await filterOffTopicSectionsForChapters(plannedWithCalibration);
  const droppedSectionCount = plannedWithCalibration.reduce((count, chapter, index) => {
    const before = (chapter.sections || []).length;
    const after = (plannedWithConstructionOrgRequiredSections[index]?.sections || []).length;
    return count + Math.max(0, before - after);
  }, 0);
  // 第一道过滤（大纲规划出口）不单独打印：评标结构校验的补挂回路发生在本道过滤之后，
  // 需与补挂后二次过滤的增量合并统计，避免「已剔除」与「又补回」的矛盾日志
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
  // 改8：概况类小节置首（确定性调序，仅动小节顺序——首章以「编制说明与工程概况」类小节开篇）
  effectiveChapters = prioritizeOverviewSections(effectiveChapters);
  // 补挂回路二次过滤（真实生成回归，章节任务未就绪根因）：评标结构校验的评分条目/结构组补挂
  // 发生在大纲第一道过滤之后，会把招标条款碎片（「1委员会确定中」「相当于或不低于以下品牌」等）
  // 重新补入章节 sections；碎片小节无事实/证据支撑 → 章节任务未就绪失败。
  // 对补挂后的最终章节集再执行一次大纲主题过滤（确定性硬剔除层兜底，语义判定附加），
  // 与第一道过滤合并统计后统一打印，下游写作/目录/预算无感知
  const finalSectionFilteredChapters = await filterOffTopicSectionsForChapters(effectiveChapters);
  const additionalDroppedSectionCount = effectiveChapters.reduce((count, chapter, index) => {
    const before = (chapter.sections || []).length;
    const after = (finalSectionFilteredChapters[index]?.sections || []).length;
    return count + Math.max(0, before - after);
  }, 0);
  effectiveChapters = finalSectionFilteredChapters as typeof effectiveChapters;
  const totalDroppedSectionCount = droppedSectionCount + additionalDroppedSectionCount;
  if (totalDroppedSectionCount > 0) {
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'outline-topic-filter', status: 'success', message: `大纲小节主题过滤：剔除 ${totalDroppedSectionCount} 个评标纪律/商务报价类离题小节`, details: ['被剔除小节不进入写作、目录与预算计划', ...(additionalDroppedSectionCount > 0 ? [`评标结构校验补挂回路二次剔除：${additionalDroppedSectionCount} 个条款碎片/纪律小节`] : [])] }, { subtitle: '大纲主题约束', order: progressStages.length }));
    emitProgress();
  }
  if (finalBidStructureAudit.issues.length > 0 || bidStructureAudit.issues.length > 0) {
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'bid-structure-audit', status: finalBidStructureAudit.issues.some(issue => issue.severity === 'blocker') ? 'failed' : 'success', message: `评标结构符合性校验：${finalBidStructureAudit.diagnostics.length} 个结构组，${finalBidStructureAudit.diagnostics.filter(item => item.status === 'satisfied').length} 个已满足，${finalBidStructureAudit.diagnostics.filter(item => item.status === 'missing' && item.level === 'required').length} 个必查缺失（已自动补挂），${finalBidStructureAudit.diagnostics.filter(item => item.status === 'fragmented').length} 个分散`, details: [...finalBidStructureAudit.diagnostics.map(item => `${item.status === 'satisfied' ? '满足' : item.status === 'fragmented' ? '分散' : '补挂'}：${item.groupTitle}${item.status === 'missing' ? `（补挂小节：${item.missingSections.join('、')}）` : ''}`), ...finalBidStructureAudit.issues.map(issue => `提示：${issue.message}`).slice(0, 8)] }, { subtitle: '评标结构校验' }));
  }
  template = { ...template, chapters: effectiveChapters };
  // 评分项要求↔章节标题语义相似度（零响应检测第二道：变体表述兜底；语义模型恒可用，空输入返回恒零函数）
  // 章节标题与零响应检测侧同口径归一化（normalizeChapterTitleLine），避免闭包缓存 key 不一致静默返回 0
  const requirementsSimilarity = await buildSemanticSimilarity(
    tenderRequirementCheckItems(tenderRequirements).map(({ item }) => tenderRequirementSemanticQuery(item)),
    effectiveChapters.map(chapter => normalizeChapterTitleLine(chapter.title)),
  );
  // W4/P3 评分项要求章节级路由：每个要求项路由到语义最相似章节，生成时注入该章 roleContext
  // （“本章必须显性响应”），治本于生成侧——不再依赖事后零响应检测+补写
  const requirementsRoutes = await routeTenderRequirementsToChapters(tenderRequirements, effectiveChapters, requirementsSimilarity);
  if (requirementsRoutes.length > 0) {
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'tender-requirement-routing', status: 'success', message: `评分项要求章节级路由：${requirementsRoutes.length} 条要求已路由到责任章节（生成时显性响应）`, details: requirementsRoutes.map(route => `${route.kind}“${route.item.text}” → ${route.chapterTitle}（相似度 ${route.score.toFixed(2)}）`) }, { subtitle: '要求响应路由', order: progressStages.length }));
    emitProgress();
  }
  // 总量口径语义分类器（round-13）：事实反查的口径归属语义复核（根治跨口径误伤）；
  // 本地语义模型恒可用（本地 ONNX 推理），构建失败直接抛出，无不可用降级路径
  const factTokenScopeClassifier = await buildFactTokenScopeClassifier();
  // 专业深度语义分类器（round-14）：章节专业深度/缺项/套话/闭环/依赖的语义判定（根治关键词正则模拟语义打分）；
  // 本地语义模型恒可用，构建失败直接抛出，无不可用降级路径
  const professionalDepthClassifier = await buildProfessionalDepthClassifier();
  const writingTaskBrief = buildWritingTaskBrief({ chapters: effectiveChapters, factsModel: preliminaryFactsModel, projectGraph: projectGraph || undefined, requirement: input.requirement, templateName: template.name, tenderRequirements });
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
  // 评分项要求写作规则注入：生成时显性响应招标要求（零响应即评标失分），与零响应检测共用同一份提取模型
  const tenderWritingRulesText = tenderRequirementsWritingRules(tenderRequirements);
  projectContext = [baseProjectContext, documentBlueprintContext, tenderWritingRulesText].filter(Boolean).join('\n\n');
  // A2 章级 scoped 上下文：成稿/修复调用按章精确裁剪蓝图（数据结构级章→事实映射，他章内容零混入）。
  // 全局层（项目理解 baseProjectContext）与要求段全量保留——章级只瘦身蓝图事实/任务卡/实施方案。
  // 开关 DOCUMENT_CONTEXT_SLIM_CHAPTER=0 可整体回退为全量上下文（验证不劣化后保持默认开启）
  const documentBlueprintStructure = buildDocumentBlueprintStructure({ template, chapters: effectiveChapters, factsModel: preliminaryFactsModel, requirement: input.requirement, referenceLines, scopeConflicts: canonicalFacts.scopeConflicts });
  const slimChapterContextEnabled = process.env.DOCUMENT_CONTEXT_SLIM_CHAPTER !== '0';
  const chapterScopedProjectContext = (chapter: DocumentTemplateChapter) => {
    if (!slimChapterContextEnabled) return projectContext;
    // 3.1 消除 projectUnderstanding.prompt 双份注入：promptTexts（generationControlPrompt 成分）已全链路提供
    // projectUnderstanding.prompt，章级 scoped 只保留 constructionOrgContext（不在任何 promptTexts 变体中）+ 章级蓝图
    return composeScopedProjectContext({
      constructionOrgContext,
      scopedBlueprint: buildChapterScopedProjectContext({ chapterTitle: displayChapterTitle(chapter.title), structure: documentBlueprintStructure, requirementRules: tenderWritingRulesText }),
    });
  };
  if (!scopedIntelligence) {
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-blueprint', status: 'success', message: '已生成全局事实主表与文档蓝图，后续章节和小节将共用同一套专业约束', details: documentBlueprintContext.split('\n').slice(0, 12) }, { subtitle: '全局蓝图' }));
  }
  const documentBudget = buildDocumentBudget({ requirement: input.requirement, promptTexts, template, chapters: effectiveChapters, spec: documentSpec });
  const plannedDocument = await plannedDocumentTask;
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
    // 1.1 事实净化门计数并入诊断：extractLocalFactPool 调用点（earlyFactPool）早于本初始化（TDZ），经返回值带回
    if (earlyFactPool.factSanitize.truncated > 0 || earlyFactPool.factSanitize.dropped > 0 || earlyFactPool.factSanitize.repaired > 0) {
      generationDiagnostics.factSanitize = { ...earlyFactPool.factSanitize };
    }
  // 4.2 阶段耗时瀑布：规划期起点（蓝图/小节规划/计划主表段；函数前半段图谱检索因 diagnostics TDZ 不计入，
  // 其耗时已有 project-graph 等 stage 展示）。手动埋点而非 measureGenerationStep 包裹：规划段横跨大量
  // 同步构建代码与外部变量声明，闭包化会引发大规模作用域变更
  const planPhaseStartedAt = Date.now();
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
    details: sectionPlanCleanupNotes.length ? [...sectionPlanCleanupNotes] : undefined,
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
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'chapter-concurrency', status: 'success', message: `章节流水线调度：${effectiveChapters.length} 章全部同批并行生成，审查修复 ${reviewConcurrency} 路流水线（章节生成完立即进入审查，与后续章节生成重叠）`, details: [`有效章节数：${effectiveChapters.length}`, `平均章节目标：${avgChapterTarget} 字`, Number.isFinite(configuredChapterConcurrency) && configuredChapterConcurrency > 0 ? `章节并发来自 DOCUMENT_CHAPTER_CONCURRENCY=${Math.floor(configuredChapterConcurrency)}` : `全部章节并行生成，在飞调用不设并发上限；每章单轮修复（失败即放弃）`] }, { subtitle: '章节流水线策略' }));
  emitProgress();
  // P2 审查流水线：章节生成完成后立即收口（章级审查修复已删除，跨章审查与最终门禁在所有章节完成后按章节序执行）
  // 跨章引用安全：统一修复仅改全部章节成稿后的完整初稿，章节收口任务只做写入与进度汇报
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
  // B1 计划数据主表：写作前一次 LLM 调用生成全文唯一计划类数值口径（劳动力峰值/分阶段人数/机械台数/
  // 材料批次/检验批划分/进度节点）。这些数值资料中不存在，历史上由各章 LLM 独立推导 → 全文数据矛盾；
  // 主表文本注入各 Writer 的 L1 恒定段（全项目共享一次，同时成为 prefix cache 可命中前缀组成部分）。
  // 生成失败自动回退原「各章自推」路径（buildPlanDataMaster 返回 undefined 不阻断生成）；DOCUMENT_PLAN_DATA_MASTER=0 整体关闭
  const planDataMasterStartedAt = Date.now();
  const planDataMasterInput: Parameters<typeof buildPlanDataMaster>[0] = {
    basicFacts: renderBasicFactsForMaster(canonicalFacts),
    chapterTitles: effectiveChapters.map(chapter => chapter.title),
    signal: input.signal,
    diagnostics: generationDiagnostics,
  };
  const planDataMaster = await buildPlanDataMaster(planDataMasterInput);
  const planDataMasterText = planDataMaster ? renderPlanDataMaster(planDataMaster) : '';
    // 1.2 关键决策锁：规划期从净化后事实池 + 证据确定性提取封闭类目决策表（零 LLM 调用），
    // 渲染为全项目恒定文本注入所有章写作 prompt（同文档各调用逐字节一致 → 兼利 prefix cache）
    const decisionLockText = renderDecisionLock(buildDecisionLock({ facts: [...earlyFactPool.localFacts, ...earlyFactPool.projectBasicFacts, ...earlyFactPool.preciseFacts], evidence: writerEvidence }));
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'plan-data-master', status: 'success', message: planDataMaster ? `计划数据主表已生成：劳动力峰值 ${planDataMaster.laborPeak.count} 人、机械 ${planDataMaster.machines.length} 类、检验批 ${planDataMaster.inspectionBatches.length} 类、进度节点 ${planDataMaster.scheduleNodes.length} 个，将作为全文计划类数值唯一口径注入各章写作` : '计划数据主表未生成（自动回退各章独立推导口径，数据一致性由事后审查兜底）', details: planDataMaster ? [`耗时 ${Date.now() - planDataMasterStartedAt}ms`, planDataMaster.laborByPhase.length ? `分阶段劳动力：${planDataMaster.laborByPhase.map(item => `${item.phase} ${item.count} 人`).join('、')}` : '分阶段劳动力：未推导', ...planDataMaster.machines.slice(0, 8).map(item => `${item.name} ${item.count} 台`)] : [`耗时 ${Date.now() - planDataMasterStartedAt}ms`, `失败原因：${planDataMasterInput.lastFailure || '未知'}`] }, { subtitle: '计划数据口径' }));
  emitProgress();
  // 4.2 阶段瀑布：规划期收口 → 成稿期起点（成稿主循环含章级审查修复流水线重叠，合并记 phase:draft）
  generationDiagnostics.metrics.push({ name: 'phase:plan', startedAt: planPhaseStartedAt, endedAt: Date.now(), durationMs: Date.now() - planPhaseStartedAt });
  const draftPhaseStartedAt = Date.now();
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
        .filter(f => evidenceInScope(projectRoot, f, availableEvidenceScopePaths));
      for (const gf of graphFileList) {
        const detail = getCachedFileDetail(gf);
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
    const searchStartedAt = Date.now();
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptPlan.writerPrompts[0]?.id,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在执行质量优先的章节检索${graphMapping?.graphFiles.size ? `（图谱匹配 ${graphMapping.graphFiles.size} 个文件）` : ''}`,
      details: queries.map(query => `检索：${query.slice(0, 42)}`),
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '证据检索' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    const scopedFilePaths = resumedContent ? [] : [...availableEvidenceScopePaths].filter(Boolean).sort();

    const cachedIntentEvidence = resumedContent ? [] : (scopedIntelligence?.evidenceByChapterId?.[chapter.id] || []);
    if (cachedIntentEvidence.length > 0) rawEvidence.push(...cachedIntentEvidence);
    const searchResults: KbSearchResult[][] = [];
    // 优化：KB搜索并行化 — 多组查询并发执行，减少串行I/O等待
    const searchQueries = queries;
    // 模板必需事实定向查询并入首轮并行检索：提前命中缺失事实证据，降低后续深召回/补充检索触发概率，减少串行轮次
    const requiredFactSearchQueries = (chapter.requiredFacts || [])
      .filter((fact: string) => Boolean(fact) && !searchQueries.some(query => query.includes(fact) || fact.includes(query)))
      .map((fact: string) => `${chapter.title} ${fact}`);
    const mergedSearchQueries = [...searchQueries, ...requiredFactSearchQueries];
    if (scopedFilePaths.length > 0 && mergedSearchQueries.length > 0) {
      throwIfAborted(input.signal);
      const parallelResults = await runWithAdaptiveConcurrency(mergedSearchQueries, async query => searchWithCache(query, scopedFilePaths, Math.min(requestedEvidencePerChapter, 12), chapter.title), { kind: 'search' });
      searchResults.push(...parallelResults);
    }
    generationDiagnostics.evidence.searchQueries += mergedSearchQueries.length;
    generationDiagnostics.evidence.searchMs += Date.now() - searchStartedAt;
    // P4 细粒度埋点：章节检索段历史仅首尾两个事件（KB 搜索 + LLM 深召回可达 10 分钟级，中间零事件，
    // 前端长时间静止误判卡死）——关键检索节点即时更新本章 stage 消息与进度
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} KB 检索完成：${mergedSearchQueries.length} 组查询，准备深度召回与语义排序`,
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '证据检索' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
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
    if (/概况|工程|项目|总体|部署|进度|工期|质量/u.test(chapter.title)) rawEvidence.push(...safeProjectBasicEvidence.map(item => ({ ...item, chapterId: chapter.id, source: 'pinned-evidence' })));
    // round-20 S5/W7 P6-2：招标文件/投标须知类文件整文件 pinned 注入到概况/总述类章节——
    // 要求来源文件不得被检索召回截断（招标要求未写入正文的根因是要求原文根本没进 prompt）；
    // pinned 证据在预算截断时优先级最高，招标内容优先于其他证据进入；
    // 证据内容安全分区后取放行子集（writerEvidence），评标纪律/评标办法章节不进写手输入
    const tenderFileEvidence = writerEvidence.filter(item => /招标|投标须知|评标办法|专用合同条款|投标人须知/u.test(`${item.filePath || ''}${item.sectionTitle || ''}`));
    if (/概况|工程|项目|总体|部署/u.test(chapter.title) && tenderFileEvidence.length > 0) rawEvidence.push(...tenderFileEvidence.map(item => ({ ...item, chapterId: chapter.id, source: 'pinned-evidence' as const })));
    const chapterPinnedPaths = new Set([...pinnedEvidencePaths]);
    // 模板 pinned 文件整文件全量注入（不再按字符预算截断，截断即要求条款丢失）
    for (const relativePath of chapterPinnedPaths) {
      if (!evidenceInScope(projectRoot, relativePath, evidenceScopePaths)) continue;
      const isPinnedEvidence = pinnedEvidencePaths.has(relativePath);
      const detail = getCachedFileDetail(relativePath);
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
    const sampledEvidence = resumedContent ? [] : sampleProjectMaterialEvidence({ project, chapter, plan, profile: projectMaterialProfile, scopedFilePaths, highRisk: rolePoolRisk.highRisk });
    // 单次过滤：rawEvidence（上方仅做过路径域过滤）与 sampledEvidence 统一在此过一次项目资料口径过滤，
    // 不再对 sampled 先预过滤再随全量二次过滤（历史冗余：同一批 sampled 证据被过滤两遍）
    if (sampledEvidence.length > 0) scopedEvidence.push(...sampledEvidence);
    scopedEvidence = filterEvidenceByProjectScope(scopedEvidence, projectMaterialScope);
    // 写作链证据安全过滤：投标/评标纪律、评标办法、商务报价类证据（含搜索召回/深召回路径）不进写手与事实需求链
    if (excludedEvidenceKeys.size > 0) scopedEvidence = scopedEvidence.filter(item => !excludedEvidenceKeys.has(evidenceSafetyKey(item)));
    // P1 语义排序：章节证据按“章查询 ↔ 证据文本”本地 bge-small 余弦排序（语义主键，证据全量保留、无预算截断）。
    // 4.12.16 候选池词面粗筛：全量 ~1.5 万条本地嵌入是检索段 CPU 瓶颈（实测 20+ 分钟），
    // 先按词面/重要性分数取 topN 候选（默认 3000），仅候选池嵌入，未入池条目语义分为 0 退回 baseScore 口径
    const semanticTopCandidates = (() => {
      const raw = Number(process.env.DOCUMENT_SEMANTIC_TOP_CANDIDATES);
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3000;
    })();
    const semanticPool = preselectSemanticCandidates(chapter, scopedEvidence, semanticTopCandidates);
    const chapterSemanticSimilarity = await buildSemanticSimilarity([chapterCriteriaText(chapter)], semanticPool.map(semanticEvidenceText));
    let evidence = optimizeChapterEvidence(chapter, scopedEvidence, { preservePinned: true, semantic: { similarity: chapterSemanticSimilarity, queryText: chapterCriteriaText(chapter) } }, generationDiagnostics);
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
          graphMapping.graphBoqItems.length ? `图谱识别本章BOQ清单项（${graphMapping.graphBoqItems.length}项）：${graphMapping.graphBoqItems.map(b => `${b.name} ${b.quantity}${b.unit}`).join('、')}` : '',
          graphMapping.gaps.length ? `图谱识别本章资料缺口：${graphMapping.gaps.join('；')}` : '',
        ].filter(Boolean).join('\n')
      : '';
    // 写作任务书不再逐章注入：其“写作目标/必须覆盖/清单目标”与 plan（项目资料理解的章节计划，源自模板+图谱、更项目专属）语义重叠，
    // 全局写作约束由文档蓝图（projectContext）统一承载，逐章 roleContext 保留图谱提示与项目理解的章节计划即可
    const scopeOverrideAnchors = renderScopeOverrideAnchors(canonicalFacts.scopeConflicts);
    // W4/P3 本章责任要求项：路由到本章的评分项要求必须显性写入正文（生成侧治本，不依赖事后补写）
    const chapterRequirementContext = requirementsRoutes.length > 0
      ? (() => {
        const chapterTitle = normalizeChapterTitleLine(chapter.title);
        const routed = requirementsRoutes.filter(route => route.chapterTitle === chapterTitle);
        if (routed.length === 0) return '';
        return ['【本章必须显性响应的招标要求（逐条写入正文，零响应即评标失分）】', ...routed.map(route => `- ${route.kind}：${route.item.text}`)].join('\n');
      })()
      : '';
    // 4.17.8 六个百分百写作侧前置注入：扬尘治理六项是国家规范固定封闭集，历史缺陷只在检测/修复侧
    // 逐项补写（后期修复模式），写作 LLM 凭记忆编写必漏项（4.17.7 实测缺 2 项）；写作时即注入六项
    // 原文要求逐项落实，缺项从源头消失——修复是辅助，写作是主力
    const sixHundredPercentContext = /扬尘|文明施工|环境保护|绿色施工|安全文明|环保/u.test(`${chapter.title}${chapter.purpose || ''}`)
      ? ['【扬尘治理六个百分百——规范固定条目，必须逐项落实并写入正文，每项一句具体措施，六项不得缺项；若本项目无拆迁工程，对“拆迁工地100%湿法作业”必须显性写明“本项目无拆迁工程，不涉及拆迁工地湿法作业”，不得省略】',
        '- 施工工地周边100%围挡',
        '- 物料堆放100%覆盖',
        '- 出入车辆100%冲洗',
        '- 施工现场地面100%硬化',
        '- 拆迁工地100%湿法作业',
        '- 渣土车辆100%密闭运输'].join('\n')
      : '';
    const roleContext = [graphRoleHint, chapterRequirementContext, sixHundredPercentContext, scopeOverrideAnchors.length ? `【数据口径强制约束】${scopeOverrideAnchors.join('；')}` : '', plan?.writingGoal, plan?.mustCover?.length ? `本章必须覆盖：${plan.mustCover.join('、')}` : '', plan?.mustUseMaterialKinds?.length ? `本章优先使用资料类型：${plan.mustUseMaterialKinds.join('、')}` : ''].filter(Boolean).join('\n');
    const chapterPromptExecution = resolveChapterPromptExecution(promptPlan, chapter);
    if (promptPlan.writerPrompts.length > 0 && !chapterPromptExecution.primaryWriter) throw new Error(`${displayChapterTitle(chapter.title)} 写作主控提示词未进入章节生成阶段`);
    const chapterPromptTexts = [chapterPromptExecution.promptTexts, generationControlPrompt].filter(Boolean).join('\n\n');
    const chapterPromptDetails = chapterPromptExecution.promptDetails.length ? chapterPromptExecution.promptDetails : ['未绑定章节写作提示词'];
    const chapterFactNeeds = buildChapterFactNeeds({ template, chapter, spec: documentSpec, profile: domainProfile, promptTexts: chapterPromptTexts, requirement: input.requirement, plan: plan ? { requiredContents: plan.mustCover, evidenceNeeds: Object.values(plan.evidenceQueries).flat() } : undefined });
    let resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: preliminaryFactsModel, evidence: scopedEvidence, profile: domainProfile, excludedEvidenceKeys });
    let requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
    // 优化：图谱证据充足且多样化时才跳过深召回（文件多样性≥6 + 无缺失事实）
    const readinessPlan = buildChapterReadinessPlan({ chapter, evidence });
    const evidenceFileCount = new Set(evidence.map(item => item.filePath)).size;
    const graphEvidenceSufficient = Boolean(graphMapping)
      && (graphMapping?.graphFiles.size || 0) >= 8
      && evidenceFileCount >= 6
      && missingFacts.length === 0
      && readinessPlan.riskLevel === 'low';
    const needsDeepRetrieval = shouldTriggerDeepRetrieval({
      scopedFileCount: scopedFilePaths.length,
      evidenceCount: evidence.length,
      evidenceFileCount,
      suggestedStrategy: readinessPlan.suggestedStrategy,
      highRisk: rolePoolRisk.highRisk,
      missingFactsCount: missingFacts.length,
      requiredMissingNeedsCount: requiredMissingNeeds.length,
      riskLevel: readinessPlan.riskLevel,
    });
    if (!graphEvidenceSufficient && needsDeepRetrieval && scopedFilePaths.length > 0) {
      // P4 细粒度埋点：LLM 深召回是检索段最长 LLM 调用，开始前推送事件消除盲区
      const deepNeedCount = new Set([...missingFacts, ...requiredMissingNeeds]).size;
      if (deepNeedCount > 0) {
        progressStages[chapterProgressIndex] = displayStage({
          type: 'chapter_generation',
          roleId: 'chapter_generation',
          status: 'running',
          message: `${displayChapterTitle(chapter.title)} 正在深度召回缺失事实证据（${deepNeedCount} 项需求）`,
          progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '深度召回' },
        }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
        emitProgress();
      }
      // P1-4：缺失事实与必需事实需求并入同一次深召回（原两次调用查询集高度重叠，合并后每章深召回查询数约降 40%）
      const deepEvidence = await retrieveDeepChapterEvidence({ manager, projectRoot, chapter, scopedFilePaths, fileRoleByPath, fileProcessingByPath, requiredNeeds: [...new Set([...missingFacts, ...requiredMissingNeeds])], highRisk: rolePoolRisk.highRisk || requiredMissingNeeds.length > 0, signal: input.signal }).catch(() => []);
      deepEvidenceCount = deepEvidence.length;
      if (deepEvidence.length > 0) {
        // 深召回增量合并：scopedEvidence 各来源均已过项目资料口径过滤，deepEvidence 此处过滤后直接合并；
        // 不再对合并集先做一次 optimizeChapterEvidence 全量重排——下方 evidence 会统一重排一次
        //（历史冗余：同一输入同一参数连续重排两遍，optimizeChapterEvidence 为纯函数，中间结果随即被覆盖）
        scopedEvidence = [...scopedEvidence, ...filterEvidenceByProjectScope(deepEvidence, projectMaterialScope)];
        if (excludedEvidenceKeys.size > 0) scopedEvidence = scopedEvidence.filter(item => !excludedEvidenceKeys.has(evidenceSafetyKey(item)));
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { preservePinned: true }, generationDiagnostics);
        evidence = governEvidenceValues(evidence, canonicalFacts.scopeConflicts);
        assertEvidenceInProjectScope(evidence, projectMaterialScope, `chapter:${chapter.id}:deep`);
        missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
      }
      // P1-4：深召回后重算事实需求，仍缺失的必需需求触发下方一次轻量补充
      resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: preliminaryFactsModel, evidence: scopedEvidence, profile: domainProfile, excludedEvidenceKeys });
      requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
      // P4 细粒度埋点：深召回完成即时刷新命中数（含零命中），前端可见检索推进
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 深度召回完成：命中 ${deepEvidenceCount} 条${requiredMissingNeeds.length > 0 ? `，仍缺 ${requiredMissingNeeds.length} 项（触发轻量补充）` : ''}`,
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '证据检索' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress();
    }
    // P1-4：合并深召回后仍有必需事实缺口时做一次轻量补充（原第二次深召回，highRisk 强制；仅当新 needs 出现时触发）
    if (requiredMissingNeeds.length > 0 && scopedFilePaths.length > 0) {
      const mergedSupplementalEvidence = filterEvidenceByProjectScope(await retrieveDeepChapterEvidence({ manager, projectRoot, chapter, scopedFilePaths, fileRoleByPath, fileProcessingByPath, requiredNeeds: requiredMissingNeeds, highRisk: true, signal: input.signal }).catch(() => []), projectMaterialScope);
      if (mergedSupplementalEvidence.length > 0) {
        // 补充证据在上方赋值时已过滤项目资料口径，直接合并后统一重排一次（同深召回路径，省一次全量重排+全量过滤）
        scopedEvidence = [...scopedEvidence, ...mergedSupplementalEvidence];
        if (excludedEvidenceKeys.size > 0) scopedEvidence = scopedEvidence.filter(item => !excludedEvidenceKeys.has(evidenceSafetyKey(item)));
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { preservePinned: true }, generationDiagnostics);
        evidence = governEvidenceValues(evidence, canonicalFacts.scopeConflicts);
        assertEvidenceInProjectScope(evidence, projectMaterialScope, `chapter:${chapter.id}:supplemental`);
        missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
        resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: preliminaryFactsModel, evidence: scopedEvidence, profile: domainProfile, excludedEvidenceKeys });
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

    // P0-1 小节级检索复用：跨小节/跨修复轮缓存（查询=章节+小节标题），
    // 章节级 evidence 经 evidenceForSection 过滤后 ≥4 条且含量化参数时短路跳过检索；
    // 检索的 LocalReranker 交叉编码已下沉 worker 线程（rerank-worker-thread），不阻塞主线程
    const sectionEvidenceCache = new Map<string, DocumentEvidence[]>();
    const sectionEvidenceForChapter = (sectionTitle: string): Promise<DocumentEvidence[]> => {
      const cacheKey = stableHash({ kind: 'section', query: `${chapter.title} ${sectionTitle}`.trim(), scopedFilePaths });
      const cached = sectionEvidenceCache.get(cacheKey);
      if (cached) return Promise.resolve(cached);
      const chapterSectionEvidence = evidenceForSection(sectionTitle, chapter, evidence);
      const quantifiedCount = chapterSectionEvidence.filter(item => QUANTIFIED_FACT_RE.test(item.content)).length;
      if (chapterSectionEvidence.length >= 4 && quantifiedCount >= 1) {
        // 全量使用已命中证据，不再取前 5 条捷径（截断即丢证据）
        sectionEvidenceCache.set(cacheKey, chapterSectionEvidence);
        return Promise.resolve(chapterSectionEvidence);
      }
      return retrieveSectionEvidence({ manager, projectRoot, chapter, sectionTitle, scopedFilePaths, fileRoleByPath, fileProcessingByPath, signal: input.signal }).then(results => {
        sectionEvidenceCache.set(cacheKey, results);
        return results;
      });
    };
    // P4 硬回路提供器：两步生成大纲报告「材料缺失事实」时定向补检（复用小节级检索，禁用重排器，预算 9000 字符）
    const supplementEvidenceForChapter = (missingFacts: string[]): Promise<DocumentEvidence[]> => {
      if (missingFacts.length === 0 || scopedFilePaths.length === 0) return Promise.resolve([]);
      const label = missingFacts.join(' ');
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
      details: [`使用绑定文件：${chapterEvidenceFiles.size} 份`, `上下文字符：${chapterEvidenceChars}`, `检索查询：${queries.length} 组`, ...retrievalDetails],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '正文生成' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    generationDiagnostics.evidence.contextChars += chapterEvidenceChars;
    const indexedFacts = factsForChapterNeeds(resolvedFactNeeds);
    const projectBasicFactsForChapter = /概况|工程|项目|总体|部署|进度|工期|质量/u.test(chapter.title) ? earlyProjectBasicFacts : [];
    // F3：事实覆盖清单预算封顶（全量注入是块级输入 L3 爆炸主因；被截断索引仍由绑定材料证据兜底）
    const factCoverageContext = capFactCoverageContext(buildChapterFactCoverageContext({ chapter, plan: undefined, spec: documentSpec, roleFacts: matchedRoleContexts, evidence, missingFacts, indexedFacts: [...projectBasicFactsForChapter, ...indexedFacts], resolvedFactNeeds, factNeedsPrompt: factNeedsCoveragePrompt(resolvedFactNeeds) }));
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
    const budgetTarget = documentBudget.chapterTargets.get(chapter.id) || 1200;
    const sectionCount = chapter.sections?.filter(Boolean).length || 0;
    const compositeChapterTitle = /[、，,；;]/u.test(chapter.title);
    const targetPlan = chapterGenerationTargets({ budgetTarget, sectionCount, title: chapter.title, longformStrict: documentBudget.longformStrict });
    const chapterMaxChars = Math.ceil(targetPlan.maxWords * (documentBudget.maxChars ? 1.05 : 1));
    const targetWords = targetPlan.roundTarget;
    // 达标契约：minWords = 目标（不打折）。0.68 折扣是历史人为降标，是"初稿不达标→补写"链的源头；
    // spec/dynamicChapterRule 最小值已被 min(rule, targetWords) 截断为不超目标，直接取目标即全局最紧口径
    const minWords = targetWords;
    const generationMaxTokens = outputTokensForChapter(minWords, targetWords);
    // 长文模式：目标字数以提示词预算为准（roundTarget 已含完整章预算），不再被 structureTarget 二次压制；
    // 普通模式保留「结构承载量」上限，避免小节少时下达不切实际的整章目标
    const effectiveTargetWords = sectionCount > 0
      ? (documentBudget.longformStrict ? targetWords : Math.min(targetWords, Math.max(1800, targetPlan.structureTarget)))
      : targetWords;
    const maxSectionFirstSections = Math.max(4, Number(process.env.DOCUMENT_SECTION_FIRST_MAX_SECTIONS || 8));
    // 小节级成稿：长章节（目标 ≥6000 字、小节 4-8、非复合标题）自动启用，
    // 把整章长文拆成每节 900-1400 字的小调用，根治单次长文成稿长度不稳；
    // 耗时优化 P1：阈值放宽为「小节 2-8、非复合标题」即可启用——整章单次长调用（12 分钟级）
    // 是成稿段最大浪费（章 3 实测 724.6s 失败后降级链又重生成两遍），小节并发让单次输出
    // 稳定在 600-1400 字、失败只重试单节，整章路径仅保留给无小节章（小目标）
    // env DOCUMENT_SECTION_FIRST_GENERATION 显式置 0 可关闭，置 1 强制开启（不区分章节画像）
    const configuredSectionFirst = process.env.DOCUMENT_SECTION_FIRST_GENERATION;
    const sectionFirstDisabled = configuredSectionFirst !== undefined && Number(configuredSectionFirst) === 0;
    const sectionFirstForced = configuredSectionFirst !== undefined && Number(configuredSectionFirst) !== 0;
    const sectionFirstAutoEligible = sectionCount >= 2 && sectionCount <= maxSectionFirstSections && !compositeChapterTitle;
    const useSectionGroup = !sectionFirstDisabled && sectionCount >= 2 && (sectionCount > maxSectionFirstSections || compositeChapterTitle || (documentBudget.longformStrict && sectionCount >= 6));
    const useSectionFirst = !sectionFirstDisabled && !useSectionGroup && sectionCount >= 2 && sectionCount <= maxSectionFirstSections && (sectionFirstForced || sectionFirstAutoEligible || documentBudget.longformStrict);
    // 规划驱动模式状态：块级成稿后按 H3/H4 标题对齐（达标契约：不再有章级 Reviewer/Repairer 补写循环）
    let plannedStructureRef: PlannedChapterStructure | undefined;
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
      content = await stripBidDisciplineSentencesSemantic(content, bidProcedureJudge);
      latestChapterStageForProgress = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'success',
        message: `${displayChapterTitle(chapter.title)} 已复用已有章节正文：当前 ${documentTextLength(content)} 字，跳过 Writer，直接进入章节收口`,
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
      // C3 块级失败隔离重试器：失败块按同一目标字数单独成稿并插回原位置（成功块不动，不整章降级重写）。
      // 整章降级是历史缺陷「整章备用=整章失败重写」与全文字数雪崩的根因——单块质检未达标即全章重写，
      // 已成功的 2/3 内容全部作废；隔离重试只补失败块，成功块内容与 token 零浪费
      // 达标契约：重试不降标（历史 0.75/0.55 紧缩预算已删除）
      const retryFailedBlocks = async (buildInput: PlannedChapterContentInput, failedBlocks: PlannedChapterContentResult['failedBlocks'], sections: Array<string | undefined>): Promise<Array<string | undefined>> => {
        const retried = await Promise.all(failedBlocks.map(({ block }) =>
          buildPlannedChapterContent({ ...buildInput, targetWords: block.targetWords, maxWords: Math.ceil(block.targetWords * 1.1) }, { blocks: [block], coveredSections: [], fallbackSections: [], llmPlanned: false })
            .then(result => result?.markdown)
            .catch(() => undefined)
        ));
        const merged = [...sections];
        failedBlocks.forEach(({ index }, position) => {
          const piece = retried[position];
          if (piece) merged[index] = piece.replace(/^##\s+.+$/mu, '').trim();
        });
        return merged;
      };
      if (useSectionGroup) {
        // 规划驱动管线（治本路径）：章级 Planner 读项目图谱+文档蓝图，把显式细目重排为主题块并做语义合并
        // （相近细目合并进重写标题的 H4），从目录形态与 LLM 调用数两个维度根治碎片化；
        // LLM 失败/细目过少时由确定性语义域分组在同一管线内接管（永不回退逐小节碎片化成稿）
        const chapterTitleForBlueprint = displayChapterTitle(chapter.title);
        const blueprintChapterLines = documentBlueprintContext.split('\n').filter(line => line.includes(chapterTitleForBlueprint));
        const plannedBlueprintContext = blueprintChapterLines.length > 0 ? blueprintChapterLines.join('\n') : documentBlueprintContext;
        const plannedStructure = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-plan:${chapter.id}`, () =>
          planChapterStructure({ template, chapter, evidence, projectContext, requirement: input.requirement, roleContext, targetWords: effectiveTargetWords, graphContext: chapterTaskResult.task.graphContext, blueprintContext: plannedBlueprintContext, signal: input.signal, diagnostics: generationDiagnostics })
        ));
        if (plannedStructure.blocks.length > 0) {
          plannedStructureRef = plannedStructure;
          const plannedPromptTexts = [chapterPromptTexts, chapterTaskPromptForPlannedStructure(chapterTaskResult.task, plannedStructure)].filter(Boolean).join('\n\n');
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
          const plannedBuildInput: PlannedChapterContentInput = { template, chapter, evidence, missingFacts, promptTexts: plannedPromptTexts, projectContext: chapterScopedProjectContext(chapter), requirement: input.requirement, roleContext, targetWords: effectiveTargetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, compactProjectContext: true, scopedProjectContext: slimChapterContextEnabled, planDataMasterText, decisionLockText, sectionEvidenceProvider: sectionEvidenceForChapter, onSectionProgress: onSectionProgressForCheckpoint, diagnostics: generationDiagnostics, signal: input.signal };
          const plannedFirst = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-planned-block-draft:${chapter.id}`, () =>
            buildPlannedChapterContent(plannedBuildInput, plannedStructure)
          ));
          if (plannedFirst?.allSucceeded) {
            llmContent = plannedFirst.markdown;
          } else if (plannedFirst) {
            // C3：失败块两轮隔离重试（同一目标字数），全部成功即拼回完整章节；
            // 重试后仍失败才进入下方的整章备用路径（成功块不再被整章重写作废）
            let mergedSections = await retryFailedBlocks(plannedBuildInput, plannedFirst.failedBlocks, plannedFirst.sections);
            const stillFailed = plannedFirst.failedBlocks.filter(({ index }) => !mergedSections[index]);
            if (stillFailed.length > 0) mergedSections = await retryFailedBlocks(plannedBuildInput, stillFailed, mergedSections);
            if (mergedSections.every((section): section is string => Boolean(section))) llmContent = `## ${chapter.title}\n\n${mergedSections.join('\n\n')}`;
          }
        }
      } else if (useSectionFirst) {
        llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-section-draft:${chapter.id}`, () =>
          buildSectionParallelChapterContent({ template, chapter, evidence, missingFacts, promptTexts: agentEnhancedPromptTexts, projectContext: chapterScopedProjectContext(chapter), requirement: input.requirement, roleContext, targetWords: effectiveTargetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, projectRoot, modelName: getActiveModelWithProvider()?.model.name, materialContextHash: stableHash({ materialFilePaths, promptTexts: chapterPromptTexts }), allowPartialResult: false, compactProjectContext: true, scopedProjectContext: slimChapterContextEnabled, planDataMasterText, decisionLockText, sectionEvidenceProvider: sectionEvidenceForChapter, onSectionProgress: onSectionProgressForCheckpoint, diagnostics: generationDiagnostics, signal: input.signal })
        ));
      } else {
        llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft:${chapter.id}`, () =>
          buildLlmChapterContent(template, chapter, evidence, missingFacts, agentEnhancedPromptTexts, chapterScopedProjectContext(chapter), input.requirement, roleContext, { forbidDrawingImages, minWords, targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext, planDataMasterText, decisionLockText, signal: input.signal, diagnostics: generationDiagnostics, supplementEvidenceProvider: supplementEvidenceForChapter, evidenceFloorChars: generationBudget.evidenceFloorChars, evidenceCeilingChars: generationBudget.evidenceCeilingChars })
        ));
      }
      if (!llmContent) {
        // 达标契约：LLM 未返回有效正文时不进入任何降级链（紧凑备用/失败原因重试/证据骨架已删除）——
        // 块级隔离重试（同标准）已在前置流程耗尽，残留失败直接阻断生成，拒绝低质量兜底正文静默成文
        generationDiagnostics.llm.lastError = generationDiagnostics.llm.lastError || '全部成稿路径未返回有效正文';
      }
      // B3 确定性对齐：章节成稿后，强锚定槽位（劳动力峰值/机械台数）数值与主表不一致时按主表回填
      // （只替换数字本身、不动句式）；主表未生成时跳过。对齐覆盖全部成稿路径（主题块/小节/整章/备用/重试）
      if (llmContent && planDataMaster) {
        const aligned = alignPlanDataToMaster(llmContent, planDataMaster);
        if (aligned.fixed.length > 0) {
          llmContent = aligned.markdown;
          generationDiagnostics.llm.lastInfo = `计划数据主表对齐：${chapter.title} 回填 ${aligned.fixed.length} 处（${aligned.fixed.map(item => `${item.anchor} ${item.from}→${item.to}`).join('、')}）`;
        }
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
      // C2 标题对齐全覆盖：全部成稿路径（主题块/小节/整章/备用/重试）都把正文 H3/H4 对齐回生成前规划标题。
      // 分层对齐（H3 与 H4 分开）规避跨级误配（「施工部署」块标题把「施工部署与流水组织」H4 改写掉）；
      // 主题块管线 H3=块标题、H4=要点标题，逐小节/平铺管线 H3=规划小节
      const plannedH3Titles = plannedStructureRef && plannedStructureRef.blocks.length > 0
        ? plannedStructureRef.blocks.map(block => block.title)
        : (chapter.sections || []).filter(Boolean);
      const plannedH4Titles = plannedStructureRef && plannedStructureRef.blocks.length > 0
        ? plannedStructureRef.blocks.flatMap(block => block.subPoints.map(point => point.title))
        : [];
      let alignedContent = llmContent;
      if (plannedH3Titles.length > 0) alignedContent = alignSectionHeadingsToPlan(alignedContent, plannedH3Titles, 3);
      if (plannedH4Titles.length > 0) alignedContent = alignSectionHeadingsToPlan(alignedContent, plannedH4Titles, 4);
      content = finalizeChapterContentQuality(alignedContent, chapter);
      content = await stripBidDisciplineSentencesSemantic(content, bidProcedureJudge);
    }
    const factUsageIssues = await chapterSectionFactUsageIssues({ chapter, content, evidence });
    const chapterChars = documentTextLength(content);
    const generatedSectionsForReview = extractGeneratedSections(content);
    // C1 目录确定性：draft.sections 必须等于生成前规划大纲（主题块管线=块标题，其余=规划小节），
    // 不得从正文提取——正文 H3 被 LLM 改写后提取进目录是「目录污染」的直接源头；仅无任何规划来源时才提取兜底
    const plannedSectionTitles = plannedStructureRef && plannedStructureRef.blocks.length > 0 ? plannedStructureRef.blocks.map(block => block.title) : (chapter.sections || []).filter(Boolean);
    const sections = plannedSectionTitles.length > 0 ? plannedSectionTitles : (generatedSectionsForReview.length > 0 ? generatedSectionsForReview : []);
    const expandedSectionIssues = sectionContentIntegrityIssues(content, [{ title: chapter.title, content, sections }]).map(issue => issue.message);
    const factUsageWarnings = factUsageIssues.slice(0, 6).map(issue => `小节事实密度需优化：${issue}`);
    const chapterIssues = [...expandedSectionIssues, ...factUsageWarnings];
    const chapterStatus = chapterCompletionStatus(chapterChars, targetWords, chapterIssues);
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
    // P2：生成阶段结束，章节收口作为延迟任务返回，由审查池调度（与后续批次章节生成流水线重叠）
    return async (): Promise<void> => {
      // 达标契约收口：初稿质量由达标契约（minWords=目标、块质检 0.9×目标）保证，
      // 不再运行章级 Reviewer/Repairer 补写循环（历史缺陷：审查修复成为 token 主力军，
      // 补写落位锚点随成稿变化全部失效）。跨章一致性/数据一致性/结构问题统一在
      // 初稿完成后的全局一致性审查阶段冻结问题清单并定向修复
      const draftChapter = { id: chapter.id, title: chapter.title, content, evidence, missingFacts, sections, tablePlans: chapter.tablePlans || [] };
      chapterDraftsByOrder[chapterOrder] = draftChapter;
      chapterDrafts = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
      emitProgress(chapterDrafts);
    };
    } catch (err) {
      if (input.signal?.aborted) throw err;
      // 章节失败根因观测：llm.lastError 记录最后一次 LLM 调用失败的真实原因（空响应/限流/超时/质检未达标），
      // 历史上 catch 块只保留通用阻断消息，真实根因随进度节流丢失，导致间歇性失败无法归因
      const llmLastError = generationDiagnostics.llm.lastError;
      const llmStats = `failures=${generationDiagnostics.llm.failures} retries=${generationDiagnostics.llm.retries} reasoningTokens=${generationDiagnostics.llm.reasoningTokens || 0}`;
      console.error(`[gen] chapter ${chapter.title} failed:`, err, llmLastError ? `| LLM lastError: ${llmLastError}` : '| LLM lastError: (none)', '|', llmStats);
      const failureMessage = `${chapter.title}：${err instanceof Error ? err.message : '生成失败'}`;
      failedChapterMessages.push(failureMessage);
      latestChapterStageForProgress = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'failed',
        message: `${displayChapterTitle(chapter.title)} 生成失败：${failureMessage}`,
        details: [`LLM 最近错误：${llmLastError || '无记录'}`, `LLM 调用失败 ${generationDiagnostics.llm.failures} 次、重试 ${generationDiagnostics.llm.retries} 次`],
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
  // 4.2 阶段瀑布：成稿期（含章级审查）收口 → 全局轮起点
  generationDiagnostics.metrics.push({ name: 'phase:draft', startedAt: draftPhaseStartedAt, endedAt: Date.now(), durationMs: Date.now() - draftPhaseStartedAt });
  const globalReviewPhaseStartedAt = Date.now();
  const chapterDraftsFinal = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
  chapterGenerationStages.push(...chapterGenerationStagesByOrder.filter((item): item is DocumentExecutionStage => Boolean(item)));

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
  if (generationStrategy.enableGlobalReview) {
    const reviewed = await runGlobalConsistencyReviewLoop({
      globalReviewSamplingRate: generationStrategy.globalReviewSamplingRate,
      chapterDraftsFinal, template, reviewPromptTexts, repairPromptTexts,
      requirement: input.requirement, signal: input.signal, projectContext,
      generationDiagnostics, preliminaryFactsModel, scopeConflicts: canonicalFacts.scopeConflicts,
      progressStages, emitProgress, withProgressHeartbeat,
    });
    globalConsistencyIssues = reviewed.issues;
    globalDedupRan = reviewed.dedupRan;
  }

  // 表格执行率确定性核验已提取至 globalQualityGates.repairTableExecutionGaps（单轮定向补表修复闭环，失败即放弃）
  const { tableFixApplied } = await repairTableExecutionGaps({
    effectiveChapters, chapterDraftsFinal, template, repairPromptTexts,
    requirement: input.requirement, signal: input.signal,
    generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat,
  });

  // h15 补表后确定性去重已提取至 globalQualityGates.dedupeAfterTableFix；
  // 触发条件：仅在补表 patch 真正落地、或跨章一致性阶段的去重未执行时才运行
  //（正文自上次去重后未变化时，stripDuplicate* 幂等，重跑只会重复一次全文扫描与语义嵌入构建）
  if (tableFixApplied || !globalDedupRan) {
    globalConsistencyIssues = await dedupeAfterTableFix({ chapterDraftsFinal, globalConsistencyIssues, progressStages, emitProgress });
  }

  // P4 预算裁剪报告已提取至 globalQualityGates.reportBudgetTrimAudit（软限制裁剪量收敛为单一可观测出口）
  reportBudgetTrimAudit({ generationDiagnostics, progressStages, chapterDraftsFinal, emitProgress });

  // 4.2 阶段瀑布：全局轮收口（一致性审查/补表/去重/预算裁剪报告）→ finalize 期由 measureGenerationStep 包裹
  generationDiagnostics.metrics.push({ name: 'phase:global-review', startedAt: globalReviewPhaseStartedAt, endedAt: Date.now(), durationMs: Date.now() - globalReviewPhaseStartedAt });

  return measureGenerationStep(generationDiagnostics, 'phase:finalize', () => finalizeGeneration({
    chapterDrafts: chapterDraftsFinal, chapterDraftsByOrder, chapterGenerationStagesByOrder,
    chapterGenerationStages, effectiveChapters, template, allEvidence,
    projectMaterialScope,
    progressStages,
    documentSpec, projectMaterialProfile, projectMaterialSummary,
    domainProfile, documentBudget, promptTexts, reviewPromptTexts,
    input,
    generationStrategy, generationDiagnostics,
    chapterScopedContext: chapterScopedProjectContext,
    promptBindings, promptDocumentRules,
    projectUnderstanding, projectContext, projectRoot, projectId, readiness,
    factExtractionPromptTexts,
    hasExplicitOutline, missingItems, retrievalCoverageReports,
    failedChapterMessages, webResearchReport, indexHealth, promptPlan,
    globalConsistencyIssues,
    scopeConflicts: canonicalFacts.scopeConflicts,
    writingTaskBrief,
    evaluationCriteriaItems: evaluationItems.map(item => item.title).filter(Boolean),
    tenderRequirements,
    requirementsSimilarity,
    factTokenScopeClassifier,
    professionalDepthClassifier,
    agentWorkflow,
    emitProgress, withProgressHeartbeat,
  }));
}

export { regenerateDocumentChapter } from './documentRegeneration';
