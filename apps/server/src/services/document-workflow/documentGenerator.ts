import * as path from 'node:path';
import { computeProjectId } from '@customize-agent/knowledge';
import { getMultiProjectManager, getProjectRoot } from '../knowledge/kbService';
import { recallDocumentContexts } from '../context/contextService';
import { getProjectRoleConfig, listDocumentRoles } from '../document-core/documentRoleService';
import { autoSpecPrompt, getOrCreateAutoDocumentSpec } from '../document-core/autoDocumentSpecService';
import { buildProjectMaterialSummary, projectMaterialPrompt } from '../document-core/projectMaterialService';
import { resolveTemplateMaterialRoles } from '../document-core/materialRoleResolver';
import { evaluateDocumentReadiness, readinessPrompt } from '../document-validation/documentReadinessService';
import { validateDraftWithAutoSpec } from '../document-validation/documentValidationService';
import { validateEngineeringSpecialty, validateProjectContamination } from '../document-validation/engineeringDocumentValidationService';
import { chapterReadinessIssues, evaluateChapterReadiness } from '../document-validation/chapterReadinessService';
import { validateFactConsistency } from '../document-validation/factConsistencyService';
import { validateDocumentQualityBenchmark } from '../document-validation/documentQualityBenchmarkService';
import { assignTechnicalFactsToChapter, engineeringCoverageMatrixPrompt, extractEngineeringTechnicalFacts, technicalFactsPrompt, validateEngineeringDetailGate, validateQuantifiedCoverage, type TechnicalFactAssignment } from '../document-validation/engineeringTechnicalFactService';
import type { KbSearchResult } from '@/lib/api';
import type { DocumentAsset, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentTemplate, DocumentTemplateChapter, GeneratedDocumentDraft } from './types';
import { boundFileRolesForMaterialSummary, defaultProjectRoleConfigIdForTemplate, getDocumentTemplate, templateFileBindings, templatePromptBindings } from './templateStore';
import { evidenceLine, uniqueEvidence } from './evidence';
import { displayChapterTitle, effectiveTemplateChapters, extractExplicitOutlineFromSources } from './outline';
import { evidenceMatchesFact } from './factMatching';
import { composeDocumentMarkdown, configuredStructureIssues, configuredStructurePrompt, ensureFormalToc, extractGeneratedSections, inferChapterSectionsFromMarkdown, normalizeTertiaryHeadings, removeUnwantedDrawingImages, sanitizeFormalMarkdown, tertiaryHeadingIssues } from './markdownComposer';
import { buildDocumentBudget, documentBudgetIssues, documentBudgetStatus, documentTextLength, pageTargetIssues } from './budget';
import { applySpecGateRules, buildExportGate, configuredAutoSpecGateIssues, degenerateContentIssues, duplicateProjectBasicInfoIssues, formalPlaceholderIssues, formalStyleIssues, isExportBlockingIssue, minChapterSectionIssues, preciseFactUsageIssues, promptExampleLeakIssues, qualitySeveritySummary, tocHierarchyIssues } from './qualityValidation';
import { extractFacts, extractFactsWithLlm, extractStructuredFacts, extractStructuredTables, buildFactsModel, shouldRunLlmFactExtraction } from './factsModel';
import { stableHash, stringifyFactValue, throwIfAborted } from './utils';
import { displayStage, elapsedMessage, upsertProgressStage } from './progress';
import { callDocumentLlmJson, callWithTimeout, getActiveModelWithProvider, getAdaptiveDocumentLlmLimit, limitAdaptiveDocumentLlmLimit } from './llmClient';
import type { ProjectBasicFact, RoleNodeArtifact } from './rolePipeline';
import { analyzePromptIntent, blockingChapterCacheIssues, buildBoundEvidenceScope, buildRoleChapterContext, buildRoleEvidencePool, buildRoleExecutionNodes, cachedChapterSearch, chapterPlanFor, createGenerationDiagnostics, evidenceForRoleFiles, evidenceInScope, executeRoleExtractionNodeCached, extractProjectBasicFacts, fileScopeKeys, lightweightChapterIssues, measureGenerationStep, projectBasicFactsPrompt, promptOutlineTextsForExecution, promptTextsForExecution, projectEvidenceVersionHash, pruneChapterDraftCache, readChapterDraftCache, repairChapterByQuality, repairMarkdownByQuality, roleArtifactsDigest, roleFactsForChapter, shouldForbidDrawingImages, selectDocumentGenerationStrategy, tenderPlanChaptersFromArtifacts, tenderQualityIssues, writeChapterDraftCache } from './rolePipeline';
import { buildChapterFactCoverageContext, buildLlmChapterContent, buildSectionParallelChapterContent, buildValidationIssues, expandChapterToTarget, expandDocumentToBudget, formatContextEntries, outputTokensForChapter, reviewAndOptimizeMarkdown, reviewChapterSummaries, reviewGlobalConsistency, supplementShortSections, timeoutMsForChapter, understandReferenceFiles } from './chapterGeneration';


function validateDraft(chapters: DocumentDraftChapter[], structuredFacts: DocumentFact[] = [], template?: DocumentTemplate) {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const chapter of chapters) {
    if (chapter.evidence.length === 0) warnings.push(`${chapter.title} 未检索到资料证据`);
    if (chapter.content.length < 80) warnings.push(`${chapter.title} 内容较短，建议人工补充或重新生成`);
  }
  if (template && chapters.length < template.chapters.length) errors.push(`章节生成不完整：已生成 ${chapters.length}/${template.chapters.length} 章`);
  if (template && templatePromptBindings(template).length === 0) errors.push('模板未绑定任何提示词');
  const roleIds = new Set(structuredFacts.map(fact => fact.roleId));
  for (const requiredRole of ['project_fact', 'rule']) {
    if (template?.fileBindings?.some(binding => binding.roleId === requiredRole) && !roleIds.has(requiredRole)) warnings.push(`${requiredRole} 角色未抽取到结构化事实`);
  }
  return { passed: errors.length === 0, warnings, errors };
}

function normalizePlannedSections(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .filter(item => typeof item === 'string')
    .map(item => item.replace(/^\s*(?:#{1,6}|[-*+]|\d+[、.)）．]|[（(][^)）]+[)）])\s*/u, '').trim())
    .filter(item => item.length >= 2 && item.length <= 40)
    .filter(item => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .slice(0, 6);
}

async function planMissingChapterSectionsWithLlm(params: { chapters: DocumentTemplateChapter[]; promptTexts: string; projectContext: string; requirement?: string; signal?: AbortSignal }) {
  const chaptersNeedingPlan = params.chapters.filter(chapter => (chapter.sections?.filter(Boolean).length || 0) < 2);
  if (chaptersNeedingPlan.length === 0) return params.chapters;
  const result = await callDocumentLlmJson<{ chapters?: Array<{ title?: string; sections?: unknown }> }>(
    '你是专业文档结构规划专家。你的任务是根据用户提示词、文档需求、项目资料摘要和一级章节标题，动态规划专业二级小节。只返回 JSON。',
    [
      '请为缺少二级小节的一级章节规划二级小节。',
      '要求：',
      '1. 只为输入的一级章节规划小节，不得新增、删除、重排一级章节。',
      '2. 每章规划 3-6 个二级小节，名称必须贴合章节主题、用户提示词、需求和资料上下文。',
      '3. 不要使用通用占位词，不要机械套用固定模板。',
      '4. 小节标题应适合正式专业文档，可直接作为 Markdown 二级标题。',
      '5. 只输出 JSON：{"chapters":[{"title":"一级章节名","sections":["二级小节1","二级小节2"]}]}。',
      '',
      `文档需求：${params.requirement || '未提供'}`,
      '',
      `用户提示词与模板摘要：\n${params.promptTexts.slice(0, 6000) || '未提供'}`,
      '',
      `项目资料摘要：\n${params.projectContext.slice(0, 6000) || '未提供'}`,
      '',
      `一级章节列表：\n${chaptersNeedingPlan.map((chapter, index) => `${index + 1}. ${chapter.title}`).join('\n')}`,
    ].join('\n'),
    { signal: params.signal },
  ).catch(() => undefined);
  const byTitle = new Map<string, string[]>();
  for (const item of result?.chapters || []) {
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const sections = normalizePlannedSections(item.sections);
    if (title && sections.length >= 2) byTitle.set(title, sections);
  }
  return params.chapters.map(chapter => {
    if ((chapter.sections?.filter(Boolean).length || 0) >= 2) return chapter;
    const sections = byTitle.get(chapter.title) || [];
    if (sections.length < 2) return chapter;
    return { ...chapter, sections, queries: Array.from(new Set([...(chapter.queries || []), ...sections])) };
  });
}

function chapterCompletionStatus(chars: number, targetWords: number, issues: string[] = []): DocumentExecutionStage['status'] {
  if (chars <= 0 || issues.some(issue => /未返回有效章节正文|生成失败/u.test(issue))) return 'failed';
  const targetChars = Math.max(1, Math.floor(targetWords * 0.95));
  if (chars < Math.floor(targetChars * 0.75)) return 'failed';
  if (chars < Math.floor(targetChars * 0.9) || issues.length > 0) return 'fallback';
  return 'success';
}

function partialChapterStatus(chapter: DocumentDraftChapter, targetWords?: number): 'completed' | 'failed' {
  const chars = documentTextLength(chapter.content);
  if (chars <= 0) return 'failed';
  if (targetWords && chars < Math.floor(targetWords * 0.95 * 0.75)) return 'failed';
  return 'completed';
}

/** 文档生成主入口：依次执行角色绑定、知识检索、文件理解、事实抽取、章节生成、封面生成、LLM 审查和导出校验，返回完整文档草稿 */
export async function generateDocumentDraft(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; resumeChapters?: DocumentDraftChapter[]; signal?: AbortSignal; onProgress?: (stages: DocumentExecutionStage[], checkpoint?: { chapters?: DocumentDraftChapter[] }) => void }): Promise<GeneratedDocumentDraft> {
  throwIfAborted(input.signal);
  const baseTemplate = getDocumentTemplate(input.templateId);
  if (!baseTemplate) throw new Error('Document template not found');
  const projectRoot = path.resolve(input.projectRoot || getProjectRoot());
  if (!projectRoot) throw new Error('No knowledge base project found');
  const projectId = computeProjectId(projectRoot);
  let template = baseTemplate;
  const manager = getMultiProjectManager();
  const maxEvidence = Math.max(5, Math.min(30, input.maxEvidencePerChapter ?? 12));
  const chapterDrafts: DocumentDraftChapter[] = [];
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
    details: [`当前项目：${projectId}`, `资料目录：${path.join(projectRoot, 'knowledgeBase')}`, '正在读取文件角色和提示词角色绑定'],
    progress: { current: 1, total: 4, label: '初始化配置' },
  }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName, order: 0 })];
  emitProgress();
  const promptBindings = templatePromptBindings(template);
  const explicitFileBindings = templateFileBindings(template);
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'running',
    message: '正在分析模板规范、用户要求与项目资料摘要',
    details: ['解析 OUTLINE 与模板章节', '读取绑定文件清单', '评估资料覆盖率与生成准备度'],
    progress: { current: 1, total: 3, label: '准备分析' },
  }, { subtitle: '生成准备', order: progressStages.length }));
  emitProgress();
  if (explicitFileBindings.length === 0) throw new Error('模板未绑定知识库文件。模板生成文件只允许使用显式绑定的知识库文件，请先在模板中绑定需要参与生成的资料。');
  const promptOutlineTexts = promptOutlineTextsForExecution(promptBindings);
  const explicitPromptChapters = extractExplicitOutlineFromSources([
    { text: input.requirement, source: '用户需求' },
    { text: promptOutlineTexts, source: '提示词角色', strict: true },
  ]);
  const hasExplicitOutline = explicitPromptChapters.length >= 2;
  if (hasExplicitOutline) {
    template = { ...baseTemplate, chapters: explicitPromptChapters };
  }
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'running',
    message: `正在扫描 ${explicitFileBindings.length} 个绑定资料并生成项目摘要`,
    details: ['读取资料清单', '统计项目事实与资料角色覆盖', '准备后台控制提示词'],
    progress: { current: 2, total: 5, label: '资料摘要' },
  }, { subtitle: '生成准备', order: progressStages.length }));
  emitProgress();
  const projectMaterialSummary = await withProgressHeartbeat(() => Promise.resolve(buildProjectMaterialSummary(projectRoot, { requirement: input.requirement, boundFilePaths: explicitFileBindings.map(binding => binding.filePath), boundFileRoles: boundFileRolesForMaterialSummary(explicitFileBindings) })));
  const fileBindings = explicitFileBindings;
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'running',
    message: '正在生成自动文档规格并评估生成准备度',
    details: [`资料覆盖率线索：${Object.keys(projectMaterialSummary.materialInventory).length} 类角色`, '评估必需资料角色', '生成事实字段与章节约束'],
    progress: { current: 3, total: 5, label: '规格评估' },
  }, { subtitle: '生成准备', order: progressStages.length }));
  emitProgress();
  const autoSpec = await withProgressHeartbeat(() => Promise.resolve(getOrCreateAutoDocumentSpec(template, input.requirement || '')));
  const documentSpec = autoSpec.spec;
  const resolvedMaterialRoles = resolveTemplateMaterialRoles(template, projectMaterialSummary);
  const readiness = evaluateDocumentReadiness({ template, spec: documentSpec, summary: projectMaterialSummary, resolvedRoles: resolvedMaterialRoles });
  if (!readiness.ready) throw new Error(`生成准备度不足：${readiness.blockingIssues.join('；')}`);
  const backgroundControlPrompt = [projectMaterialPrompt(projectMaterialSummary), autoSpecPrompt(documentSpec, autoSpec.sourceHash), readinessPrompt(readiness)].filter(Boolean).join('\n\n');
  const promptTexts = [backgroundControlPrompt, `模板配置章节结构：\n${configuredStructurePrompt(template)}`, promptTextsForExecution(promptBindings, ['chapter_generation', 'formatting', 'reference'])].filter(Boolean).join('\n\n');
  const promptIntent = analyzePromptIntent([promptTexts, input.requirement || ''].filter(Boolean).join('\n\n'));
  const factExtractionPromptTexts = [backgroundControlPrompt, promptTextsForExecution(promptBindings, ['fact_extraction', 'reference'])].filter(Boolean).join('\n\n');
  const reviewPromptTexts = [backgroundControlPrompt, promptTextsForExecution(promptBindings, ['validation', 'llm_review', 'formatting', 'reference'])].filter(Boolean).join('\n\n');
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'success',
    message: `模板规范与资料摘要分析完成，识别 ${fileBindings.length} 条文件角色绑定`,
    details: [`提示词角色：${promptBindings.length} 个`, `文件角色：${fileBindings.length} 个`, hasExplicitOutline ? `识别 OUTLINE 章节：${explicitPromptChapters.length} 个` : '未识别显式 OUTLINE，使用模板章节'],
    progress: { current: 3, total: 3, label: '准备完成' },
  }, { subtitle: '生成准备', order: progressStages.length }));
  emitProgress();
  const evidenceScopePaths = buildBoundEvidenceScope(projectRoot, fileBindings);
  const allFileRoles = listDocumentRoles('file');
  const fileRoleByPath = new Map(fileBindings.flatMap(binding => fileScopeKeys(projectRoot, binding.filePath).map(key => [key, binding.roleId] as const)));
  const fileProcessingByPath = new Map(fileBindings.flatMap(binding => fileScopeKeys(projectRoot, binding.filePath).map(key => [key, allFileRoles.find(role => role.id === binding.roleId)?.processingType || 'reference'] as const)));
  upsertProgressStage(progressStages, displayStage({
    type: 'knowledge_retrieval',
    roleId: 'knowledge-index',
    status: 'running',
    message: '正在读取已入库的模板绑定资料',
    details: ['使用上传阶段已完成的解析、切片和索引结果', '不在生成流程中重新解析或入库', '准备章节证据检索范围'],
    progress: { current: 1, total: 3, label: '读取索引' },
  }, { subtitle: '知识库检索', order: progressStages.length }));
  emitProgress();
  const project = await withProgressHeartbeat(() => manager.getProject(projectRoot));
  upsertProgressStage(progressStages, displayStage({
    type: 'knowledge_retrieval',
    roleId: 'knowledge-index',
    status: 'success',
    message: '已读取知识库索引，开始构建角色资料证据池',
    details: [`证据范围文件：${evidenceScopePaths.size} 份`, '即将按角色读取资料片段'],
    progress: { current: 3, total: 3, label: '索引已就绪' },
  }, { subtitle: '知识库检索', order: progressStages.length }));
  emitProgress();
  throwIfAborted(input.signal);
  const technicalFactAssignments: TechnicalFactAssignment[] = [];
  const allEvidence: DocumentEvidence[] = [];
  const missingItems: string[] = [];
  const failedChapterMessages: string[] = [];
  const chapterGenerationStages: DocumentExecutionStage[] = [];
  let knowledgeBaseStageIndex = -1;
  const roleNodes = buildRoleExecutionNodes(template, promptBindings, fileBindings);
  const roleEvidencePool = buildRoleEvidencePool(project, roleNodes, projectRoot);
  const rolePoolStage = displayStage({
    type: 'file_understanding',
    roleId: 'role-evidence-pool',
    status: 'success',
    message: `已构建共享资料证据池：唯一文件 ${roleEvidencePool.uniqueFileCount} 份，角色绑定 ${roleEvidencePool.bindingCount} 条`,
    details: [`复用绑定：${Math.max(0, roleEvidencePool.bindingCount - roleEvidencePool.uniqueFileCount)} 条`, `待执行资料理解节点：${roleNodes.length} 个`],
    progress: { current: roleEvidencePool.uniqueFileCount, total: Math.max(1, roleEvidencePool.bindingCount), label: '资料池' },
  }, { subtitle: '共享资料池', order: progressStages.length });
  upsertProgressStage(progressStages, rolePoolStage);
  emitProgress();
  const roleArtifacts: RoleNodeArtifact[] = [];
  const projectEvidenceVersion = projectEvidenceVersionHash(project, projectRoot, evidenceScopePaths);
  const activeModelName = getActiveModelWithProvider()?.model.name;
  const roleCachePromptTexts = promptTextsForExecution(promptBindings, ['fact_extraction', 'reference', 'chapter_generation']);
  const fileRolesHash = stableHash({
    fileBindings,
    evidenceScopePaths: [...evidenceScopePaths].sort(),
    activeModelName,
    projectEvidenceVersion,
    promptTexts: roleCachePromptTexts,
    materialFingerprint: projectMaterialSummary.fingerprint,
    materialInventory: Object.fromEntries(Object.entries(projectMaterialSummary.materialInventory).map(([role, files]) => [role, files.map(file => ({ filePath: file.filePath, chunkCount: file.chunkCount }))])),
  });
  const configuredRoleConcurrency = Number(process.env.DOCUMENT_ROLE_CONCURRENCY ?? roleNodes.length);
  const roleConcurrency = Math.max(1, Math.min(roleNodes.length || 1, Number.isFinite(configuredRoleConcurrency) ? Math.floor(configuredRoleConcurrency) : roleNodes.length || 1));
  for (let offset = 0; offset < roleNodes.length; offset += roleConcurrency) {
    throwIfAborted(input.signal);
    const batch = roleNodes.slice(offset, offset + roleConcurrency);
    const batchJobs = batch.map(async (node, batchIndex) => {
      const nodeStartedAt = Date.now();
      const nodeEvidence = evidenceForRoleFiles(roleEvidencePool, node, projectRoot).filter(item => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths));
      const runningStageIndex = progressStages.length;
      const runningStage = displayStage({
        type: 'file_understanding',
        roleId: node.fileRoleId,
        promptId: node.promptRoleIds[0],
        status: 'running',
        message: `${node.fileRoleName} 正在复用共享资料池读取 ${node.filePaths.length} 条绑定，候选证据 ${nodeEvidence.length} 条`,
        details: [`绑定文件：${node.filePaths.length} 份`, `候选证据：${nodeEvidence.length} 条`, node.promptRoleNames.length ? `关联提示词：${node.promptRoleNames.join('、')}` : '未绑定专用提示词'],
        progress: { current: offset + batchIndex + 1, total: roleNodes.length, label: '资料理解' },
      }, { subtitle: node.fileRoleName, roleName: node.fileRoleName, promptName: node.promptRoleNames.join('、') || undefined, order: runningStageIndex });
      progressStages.push(runningStage);
      emitProgress();
      const { artifact, cached } = await withProgressHeartbeat(() => executeRoleExtractionNodeCached({ template, node, evidence: nodeEvidence, promptTexts: roleCachePromptTexts, projectRoot, modelName: activeModelName, signal: input.signal }));
      const completedStage = displayStage({
        type: 'file_understanding',
        roleId: node.fileRoleId,
        promptId: node.promptRoleIds[0],
        status: nodeEvidence.length > 0 ? 'success' : 'fallback',
        message: elapsedMessage(`${node.fileRoleName} 节点已${cached ? '复用缓存' : '完成'}，产出章节建议 ${artifact.chapters.length} 个、事实 ${artifact.facts.length} 条`, nodeStartedAt),
        details: [`产出章节建议：${artifact.chapters.length} 个`, `提取事实：${artifact.facts.length} 条`, cached ? '命中角色理解缓存' : '已完成模型理解'],
        progress: { current: offset + batchIndex + 1, total: roleNodes.length, label: '资料理解' },
      }, { subtitle: node.fileRoleName, roleName: node.fileRoleName, promptName: node.promptRoleNames.join('、') || undefined, order: runningStageIndex });
      progressStages[runningStageIndex] = completedStage;
      emitProgress();
      return { artifact, evidence: nodeEvidence };
    });
    const batchResults = await Promise.all(batchJobs);
    for (const item of batchResults) {
      allEvidence.push(...item.evidence);
      roleArtifacts.push(item.artifact);
    }
  }
  const tenderPlan = tenderPlanChaptersFromArtifacts(template, roleArtifacts);
  let effectiveChapters = effectiveTemplateChapters(template, documentSpec, { preserveExplicitOutline: hasExplicitOutline });
  const contextQuery = [template.name, template.outputTitle, input.requirement, ...effectiveChapters.flatMap(chapter => [chapter.title, chapter.purpose])].filter(Boolean).join(' ');
  const projectContextEntries = recallDocumentContexts(contextQuery, 8, projectRoot);
  const projectBasicFacts = extractProjectBasicFacts(roleArtifacts.flatMap(artifact => artifact.evidence));
  const projectContext = [formatContextEntries(projectContextEntries), roleArtifactsDigest(roleArtifacts, projectBasicFacts)].filter(Boolean).join('\n\n').slice(0, 24000);
  const chaptersMissingSections = effectiveChapters.filter(chapter => (chapter.sections?.filter(Boolean).length || 0) < 2);
  if (chaptersMissingSections.length > 0) {
    upsertProgressStage(progressStages, displayStage({
      type: 'validation',
      roleId: 'chapter-structure-plan',
      status: 'running',
      message: `正在由大模型为 ${chaptersMissingSections.length} 个缺少二级小节的章节动态规划结构`,
      details: ['读取提示词约束', '结合项目资料摘要', '生成可用于并发写作和目录展示的章节结构'],
      progress: { current: 1, total: 3, label: '结构规划' },
    }, { subtitle: '章节结构规划', order: progressStages.length }));
    emitProgress();
    effectiveChapters = await withProgressHeartbeat(() => planMissingChapterSectionsWithLlm({ chapters: effectiveChapters, promptTexts, projectContext, requirement: input.requirement, signal: input.signal }));
    template = { ...template, chapters: effectiveChapters };
    const plannedCount = effectiveChapters.filter(chapter => (chapter.sections?.filter(Boolean).length || 0) >= 2).length;
    upsertProgressStage(progressStages, displayStage({
      type: 'validation',
      roleId: 'chapter-structure-plan',
      status: plannedCount >= effectiveChapters.length ? 'success' : plannedCount > 0 ? 'fallback' : 'failed',
      message: plannedCount > 0 ? `章节结构规划完成，${plannedCount}/${effectiveChapters.length} 个章节已获得二级小节` : '章节结构规划未返回有效小节，后续将从正文标题中提取并标记结构风险',
      details: effectiveChapters.slice(0, 8).map(chapter => `${chapter.title}：${chapter.sections?.length || 0} 个小节`),
      progress: { current: 3, total: 3, label: '结构规划' },
    }, { subtitle: '章节结构规划', order: progressStages.length }));
    emitProgress();
  }
  const documentBudget = buildDocumentBudget({ requirement: input.requirement, promptTexts, template, chapters: effectiveChapters, spec: documentSpec });
  const resumeChapterById = new Map((input.resumeChapters || [])
    .filter(chapter => chapter.id && chapter.content?.trim())
    .map(chapter => [chapter.id, chapter] as const));
  checkpointChapterOrderIds = effectiveChapters.map(chapter => chapter.id);
  const generationStrategy = selectDocumentGenerationStrategy({ template, targetWords: documentBudget.targetChars || [...documentBudget.chapterTargets.values()].reduce((sum, value) => sum + value, 0), requirement: input.requirement });
  if (generationStrategy.targetLlmConcurrency > 0) limitAdaptiveDocumentLlmLimit(generationStrategy.targetLlmConcurrency);
  const generationDiagnostics = createGenerationDiagnostics(generationStrategy);
  pruneChapterDraftCache(generationDiagnostics);
  const llmConcurrencyMessage = generationStrategy.targetLlmConcurrency > 0 ? `LLM 并发上限 ${generationStrategy.targetLlmConcurrency}` : 'LLM 不做本地并发限流';
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-strategy', status: 'success', message: `已自动选择 ${generationStrategy.mode} 生成策略：章节缓存 ${generationStrategy.enableChapterCache ? '启用' : '跳过'}、章节审查 ${generationStrategy.enableChapterReview ? '启用' : '跳过'}、全局审查 ${generationStrategy.enableGlobalReview ? '启用' : '跳过'}、最终质量审查 ${generationStrategy.enableFinalQualityReview ? '启用' : '跳过'}、全文扩写 ${generationStrategy.enableDocumentBudgetExpansion ? '启用' : '跳过'}；${llmConcurrencyMessage}` }, { subtitle: '后台自动策略' }));
  const contextStage: DocumentExecutionStage = displayStage({
    type: 'context_recall',
    roleId: 'project-memory',
    status: projectContextEntries.length > 0 ? 'success' : 'skipped',
    message: projectContextEntries.length > 0 ? `已注入 ${projectContextEntries.length} 条短期/长期上下文` : '未召回可用项目上下文',
  }, { subtitle: '项目记忆' });

  // 第一个进度回调：角色绑定完成
  const outlineMessage = hasExplicitOutline ? `；识别到 OUTLINE 章节 ${explicitPromptChapters.length} 个` : '；未识别到有效 OUTLINE，将使用模板章节';
  upsertProgressStage(progressStages, displayStage({ type: 'role_binding', roleId: projectRoleConfigId, status: 'success', message: `已绑定 ${fileBindings.length} 个文件角色、${promptBindings.length} 个提示词角色；后台优化建议关注 ${documentSpec.factFields.length} 个事实字段；资料覆盖率 ${Math.round(readiness.materialCoverageRate * 100)}%${outlineMessage}` }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName }));
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-readiness', status: readiness.ready ? 'success' : 'failed', message: `生成准备度：资料 ${Math.round(readiness.materialCoverageRate * 100)}%，资料角色 ${Math.round(readiness.roleSatisfactionRate * 100)}%，优化建议 ${Math.round(readiness.specCompletenessRate * 100)}%；${projectMaterialSummary.source.selectionReason}` }, { subtitle: '生成准备度检查' }));
  upsertProgressStage(progressStages, contextStage);
  emitProgress();

  const configuredChapterConcurrency = Number(process.env.DOCUMENT_CHAPTER_CONCURRENCY ?? generationStrategy.maxChapterConcurrency);
  const chapterConcurrency = Math.max(1, Math.min(generationStrategy.maxChapterConcurrency, configuredChapterConcurrency));
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
      promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在检索证据并准备章节内容`,
      details: [`章节序号：${chapterOrder + 1}/${effectiveChapters.length}`, `二级小节：${chapter.sections?.length || 0} 个`, '正在生成检索查询'],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节生成' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder }));
    emitProgress();
    const rawEvidence: DocumentEvidence[] = [];
    const plan = chapterPlanFor(chapter, tenderPlan);
    const planQueries = plan ? [plan.title, ...plan.requiredContents, ...plan.evidenceNeeds, ...plan.requirements.flatMap(item => [item.title, item.requirementText, ...item.requiredContents, ...item.evidenceNeeds])].filter(Boolean) : [];
    const baseQueries = chapter.queries.length > 0 ? chapter.queries : [template.name, template.outputTitle, chapter.title];
    const queries = [...new Set([...baseQueries, ...planQueries])].filter(Boolean).slice(0, 4);
    const searchStartedAt = Date.now();
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在执行 ${queries.length} 组知识库检索`,
      details: queries.map(query => `检索：${query.slice(0, 42)}`),
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '证据检索' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    const searchResults = await Promise.all(queries.map(query => cachedChapterSearch({ manager, projectRoot, query, evidenceScopePaths, maxEvidence, fileRolesHash, generationMode: false })));
    generationDiagnostics.evidence.searchQueries += queries.length;
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
    const pinnedEvidencePaths = new Set(chapter.pinnedEvidenceFilePaths || []);
    const matchedRoleContexts = roleFactsForChapter(roleArtifacts, chapter, plan);
    rawEvidence.push(...matchedRoleContexts.flatMap(({ artifact }) => artifact.evidence
      .filter(item => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths))
      .slice(0, 8)
      .map(item => ({ ...item, chapterId: chapter.id, source: 'role-node' }))));
    const chapterPinnedPaths = new Set([...pinnedEvidencePaths]);
    for (const relativePath of chapterPinnedPaths) {
      if (!evidenceInScope(projectRoot, relativePath, evidenceScopePaths)) continue;
      const isPinnedEvidence = pinnedEvidencePaths.has(relativePath);
      const detail = project.getFileDetail(relativePath);
      if (!detail) continue;
      const pinnedChunkLimit = Math.max(maxEvidence, 20);
      rawEvidence.push(...detail.chunks.slice(0, pinnedChunkLimit).map(chunk => ({
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
    const scopedEvidence = rawEvidence.filter(item => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths));
    const evidenceLimit = maxEvidence;
    const technicalFactLimit = 120;
    const evidence = uniqueEvidence(scopedEvidence, evidenceLimit, generationDiagnostics);
    generationDiagnostics.evidence.contextChars += evidence.reduce((sum, item) => sum + item.content.length, 0);
    const technicalFactEvidence = uniqueEvidence(scopedEvidence, technicalFactLimit, generationDiagnostics);
    allEvidence.push(...evidence);
    const technicalFacts = extractEngineeringTechnicalFacts(technicalFactEvidence, 160);
    const technicalFactAssignment = assignTechnicalFactsToChapter(chapter, technicalFacts);
    technicalFactAssignments.push(technicalFactAssignment);
    const technicalFactContext = technicalFactsPrompt(technicalFactAssignment);
    const coverageMatrixContext = engineeringCoverageMatrixPrompt(technicalFactAssignment);
    const missingFacts = chapter.requiredFacts.filter(fact => !evidence.some(item => evidenceMatchesFact(item, fact)));
    if (evidence.length === 0) missingItems.push(`${chapter.title}：未检索到明确资料依据`);
    for (const fact of missingFacts) missingItems.push(`${chapter.title}：${fact} 未检索到明确依据`);
    // 证据检索完成 → 持续刷新证据数量
    const knowledgeBaseStage = displayStage({ type: 'knowledge_retrieval', roleId: 'knowledge-base', status: (allEvidence.length > 0 ? 'success' : 'fallback'), message: `已检索/绑定 ${allEvidence.length} 条证据` });
    if (knowledgeBaseStageIndex < 0) {
      knowledgeBaseStageIndex = upsertProgressStage(progressStages, knowledgeBaseStage);
    } else {
      progressStages[knowledgeBaseStageIndex] = { ...knowledgeBaseStage, order: progressStages[knowledgeBaseStageIndex]?.order ?? knowledgeBaseStage.order };
    }
    emitProgress();

    throwIfAborted(input.signal);
    const forbidDrawingImages = shouldForbidDrawingImages(roleArtifacts, template);
    const roleContext = buildRoleChapterContext(roleArtifacts, chapter, plan);
    const scopedProjectBasicFacts = projectBasicFacts.filter(fact => evidenceInScope(projectRoot, fact.sourceFile, evidenceScopePaths));
    const projectBasicFactContext = projectBasicFactsPrompt(scopedProjectBasicFacts, chapter, promptIntent);
    const factCoverageContext = buildChapterFactCoverageContext({ chapter, plan, spec: documentSpec, roleFacts: matchedRoleContexts, technicalFactAssignment, projectBasicFacts: scopedProjectBasicFacts, evidence, missingFacts });
    const specChapterRule = documentSpec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title);
    const budgetTarget = documentBudget.chapterTargets.get(chapter.id) || 1200;
    const chapterMaxChars = Math.ceil(budgetTarget * (documentBudget.maxChars ? 1.1 : 1.18));
    const adaptiveMinimum = documentBudget.targetChars ? Math.min(1200, Math.max(450, Math.floor(budgetTarget * 0.72))) : 1200;
    const minWords = Math.max(plan?.minWords || 0, specChapterRule?.minWords || 0, documentSpec?.dynamicChapterRule.minWordsPerChapter || 0, Math.floor(budgetTarget * 0.78), adaptiveMinimum);
    const targetWords = budgetTarget;
    const resumedChapter = resumeChapterById.get(chapter.id);
    if (resumedChapter) {
      const resumedIssues = lightweightChapterIssues({ chapter, content: resumedChapter.content, missingFacts, targetWords });
      if (blockingChapterCacheIssues(resumedIssues).length === 0) {
        const chapterChars = documentTextLength(resumedChapter.content);
        const reusableChapter: DocumentDraftChapter = { ...resumedChapter, title: chapter.title, evidence: resumedChapter.evidence?.length ? resumedChapter.evidence : evidence, missingFacts, sections: resumedChapter.sections?.length ? resumedChapter.sections : (chapter.sections || extractGeneratedSections(resumedChapter.content)) };
        chapterDrafts.push(reusableChapter);
        emitProgress(chapterDrafts);
        generationDiagnostics.cache.chapterHits += 1;
        generationDiagnostics.quality.reusedChapterCount += 1;
        const reusedStage = displayStage({
          type: 'chapter_generation',
          roleId: 'chapter_generation',
          promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
          status: 'success',
          message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已复用上次完成章节：当前 ${chapterChars} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字`, chapterStartedAt),
        }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
        chapterGenerationStages.push(reusedStage);
        progressStages[chapterProgressIndex] = reusedStage;
        emitProgress(chapterDrafts);
        return;
      }
      generationDiagnostics.cache.rejectedHits += 1;
    }
    const chapterCacheInput = { template, chapter, evidence, missingFacts, promptTexts, requirement: input.requirement, projectRoot, modelName: activeModelName, targetWords, fileRolesHash };
    const cachedChapter = generationStrategy.enableChapterCache ? readChapterDraftCache(chapterCacheInput, generationDiagnostics) : undefined;
    if (cachedChapter) {
      const chapterChars = documentTextLength(cachedChapter.content);
      const cachedStage = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
        status: 'success',
        message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已复用章节缓存：当前 ${chapterChars} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字`, chapterStartedAt),
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      chapterGenerationStages.push(cachedStage);
      chapterDrafts.push(cachedChapter);
      progressStages[chapterProgressIndex] = cachedStage;
      emitProgress(chapterDrafts);
      return;
    }
    const generationMaxTokens = outputTokensForChapter(minWords, targetWords);
    const canUseSectionFirst = (chapter.sections?.filter(Boolean).length || 0) >= 2;
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在${canUseSectionFirst ? '按二级小节并发生成' : '整章生成'}正文`,
      details: [`有效证据：${evidence.length} 条`, `目标字数：约 ${targetWords} 字，上限约 ${chapterMaxChars} 字`, `章节并发上限：${chapterConcurrency}`, canUseSectionFirst ? `小节并发上限：${generationStrategy.maxSectionConcurrency}，规划小节：${chapter.sections?.length || 0} 个` : '未启用小节并发，使用整章生成'],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '正文生成' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    let llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft:${chapter.id}`, () => callWithTimeout(
      signal => buildSectionParallelChapterContent({
        template,
        chapter,
        evidence,
        missingFacts,
        promptTexts,
        projectContext,
        requirement: input.requirement,
        roleContext,
        targetWords,
        maxWords: chapterMaxChars,
        forbidDrawingImages,
        factCoverageContext,
        projectRoot,
        modelName: activeModelName,
        fileRolesHash,
        allowPartialResult: true,
        maxSectionConcurrency: generationStrategy.maxSectionConcurrency,
        diagnostics: generationDiagnostics,
        signal,
        onSectionProgress: event => {
          progressStages[chapterProgressIndex] = displayStage({
            type: 'chapter_generation',
            roleId: 'chapter_generation',
            promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
            status: 'running',
            message: `${displayChapterTitle(chapter.title)} 正在生成二级小节：${event.completed}/${event.total}${event.sectionTitle ? `，当前：${event.sectionTitle}` : ''}`,
            details: [`章节并发：${chapterConcurrency}`, `小节并发：${generationStrategy.maxSectionConcurrency}`, `阶段：${event.phase === 'retry' ? '重试' : event.phase === 'complete' ? '完成' : '生成中'}`],
            progress: { current: event.completed, total: event.total, label: '小节生成' },
          }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
          emitProgress(chapterDrafts);
        },
      }),
      timeoutMsForChapter(targetWords),
      input.signal,
    )));
    if (!llmContent) {
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 小节生成未完整返回，正在执行整章兜底生成`,
        details: [`目标字数：约 ${targetWords} 字`, `有效证据：${evidence.length} 条`],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '整章兜底' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft-fallback:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, promptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords, targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, technicalFactContext, coverageMatrixContext, projectBasicFactContext, factCoverageContext, signal }),
        timeoutMsForChapter(targetWords),
        input.signal,
      )));
    }
    throwIfAborted(input.signal);
    if (!llmContent) {
      const compactEvidence = evidence.slice(0, 80);
      const compactRoleContext = roleContext.slice(0, 12000);
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 正在执行紧凑兜底生成`,
        details: ['已压缩证据与上下文', `目标字数：约 ${targetWords} 字`],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '紧凑兜底' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft-compact-fallback:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, compactEvidence, missingFacts, promptTexts, projectContext, input.requirement, compactRoleContext, { forbidDrawingImages, minWords: Math.max(450, Math.floor(minWords * 0.75)), targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, technicalFactContext: technicalFactContext.slice(0, 12000), coverageMatrixContext: coverageMatrixContext.slice(0, 8000), projectBasicFactContext: projectBasicFactContext.slice(0, 8000), factCoverageContext: factCoverageContext.slice(0, 10000), signal }),
        timeoutMsForChapter(targetWords),
        input.signal,
      )));
    }
    throwIfAborted(input.signal);
    if (!llmContent) throw new Error(`${chapter.title} 大模型未返回有效章节正文`);
    const initialChapterContent = llmContent;
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在检查并补写短小节`,
      details: [`目标字数：约 ${targetWords} 字`, `规划小节：${chapter.sections?.length || 0} 个`],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '小节补写' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress(chapterDrafts);
    llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-supplement:${chapter.id}`, () =>
      supplementShortSections({ template, chapter, content: initialChapterContent, evidence, missingFacts, promptTexts, projectContext, requirement: input.requirement, roleContext, targetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, maxSectionConcurrency: generationStrategy.maxSectionConcurrency, signal: input.signal })
    ));
    const localIssues = lightweightChapterIssues({ chapter, content: llmContent, missingFacts, targetWords });
    const localSeverity = qualitySeveritySummary(localIssues);
    generationDiagnostics.quality.blockingCount += localSeverity.blocking;
    generationDiagnostics.quality.importantCount += localSeverity.important;
    generationDiagnostics.quality.minorCount += localSeverity.minor;
    const blockingIssues = blockingChapterCacheIssues(localIssues);
    if (blockingIssues.length > 0) {
      const contentBeforeRepair = llmContent;
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 正在根据质量问题修复章节`,
        details: blockingIssues.slice(0, 5),
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节修复' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      const repairResult = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-repair:${chapter.id}`, () =>
        repairChapterByQuality({ template, chapter: { id: chapter.id, title: chapter.title, content: contentBeforeRepair, evidence, missingFacts, sections: chapter.sections || [] }, issues: blockingIssues.slice(0, 3), promptTexts, requirement: input.requirement, forbidDrawingImages, diagnostics: generationDiagnostics, signal: input.signal })
      ));
      llmContent = repairResult.content;
      if (repairResult.appliedCount > 0) generationDiagnostics.quality.repairedCount += 1;
      throwIfAborted(input.signal);
    }
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在按目标字数扩写和定稿`,
      details: [`当前目标：${Math.floor(targetWords * 0.95)} 字`, `章节并发：${chapterConcurrency}`],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节扩写' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress(chapterDrafts);
    const draftContent = llmContent || `## ${chapter.title}\n\n本章节生成失败，缺少可用于定稿的正文。`;
    const expandedChapter = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-expand:${chapter.id}`, () =>
      expandChapterToTarget({ template, chapter, content: draftContent, evidence, promptTexts, requirement: input.requirement, roleContext, targetChars: Math.floor(targetWords * 0.95), maxChars: chapterMaxChars, forbidDrawingImages, maxTokens: generationMaxTokens, signal: input.signal })
    ));
    const content = expandedChapter.content;
    const chapterChars = documentTextLength(content);
    const sections = chapter.sections?.length ? chapter.sections : extractGeneratedSections(content);
    const chapterIssues = lightweightChapterIssues({ chapter: { ...chapter, sections }, content, missingFacts, targetWords });
    const chapterStatus = chapterCompletionStatus(chapterChars, targetWords, chapterIssues);
    latestChapterStageForProgress = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
      status: chapterStatus,
      message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已由大模型生成${expandedChapter.rounds > 0 ? `并扩写 ${expandedChapter.rounds} 轮` : ''}：当前 ${chapterChars} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字${chapterStatus !== 'success' ? `；风险：${chapterIssues.join('、') || '篇幅未达标'}` : ''}`, chapterStartedAt),
      details: [`达标率：${Math.round(chapterChars / Math.max(1, Math.floor(targetWords * 0.95)) * 100)}%`, `二级小节：${sections.length} 个`, `扩写轮次：${expandedChapter.rounds}`],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: chapterStatus === 'success' ? '章节达标' : '章节风险' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    chapterGenerationStages.push(latestChapterStageForProgress);
    const draftChapter = { id: chapter.id, title: chapter.title, content, evidence, missingFacts, sections };
    chapterDrafts.push(draftChapter);
    emitProgress(chapterDrafts);
    const finalIssues = lightweightChapterIssues({ chapter, content, missingFacts, targetWords });
    const finalSeverity = qualitySeveritySummary(finalIssues);
    generationDiagnostics.quality.blockingCount += finalSeverity.blocking;
    generationDiagnostics.quality.importantCount += finalSeverity.important;
    generationDiagnostics.quality.minorCount += finalSeverity.minor;
    if (generationStrategy.enableChapterCache && blockingChapterCacheIssues(finalIssues).length === 0) writeChapterDraftCache(chapterCacheInput, draftChapter, generationDiagnostics);
    } catch (err) {
      if (input.signal?.aborted) throw err;
      console.error(`[gen] chapter ${chapter.title} failed:`, err);
      failedChapterMessages.push(`${chapter.title}：${err instanceof Error ? err.message : '生成失败'}`);
      chapterGenerationStages.push(displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'failed',
        message: `${displayChapterTitle(chapter.title)} 生成失败`,
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder }));
    }
    // 章节生成完成（成功或失败）→ 汇报进度
    if (latestChapterStageForProgress) progressStages[chapterProgressIndex] = latestChapterStageForProgress;
    emitProgress(chapterDrafts);
    }));
  }
  chapterDrafts.sort((a, b) => effectiveChapters.findIndex(chapter => chapter.id === a.id) - effectiveChapters.findIndex(chapter => chapter.id === b.id));
  technicalFactAssignments.sort((a, b) => effectiveChapters.findIndex(chapter => chapter.id === a.chapterId) - effectiveChapters.findIndex(chapter => chapter.id === b.chapterId));

  if (chapterDrafts.length === 0) {
    throw new Error(`章节生成未完成：${failedChapterMessages.slice(0, 6).join('；') || '没有生成任何有效章节'}`);
  }
  if (hasExplicitOutline && chapterDrafts.length < effectiveChapters.length) {
    throw new Error(`OUTLINE 指定 ${effectiveChapters.length} 章，实际只生成 ${chapterDrafts.length} 章：${failedChapterMessages.slice(0, 6).join('；') || '部分章节未生成'}`);
  }

  throwIfAborted(input.signal);
  let fileUnderstanding: { stage: DocumentExecutionStage; notes: string[] } = { stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '文件理解跳过' }, notes: [] };
  try { fileUnderstanding = await understandReferenceFiles(projectRoot, allEvidence, input.signal); } catch (err) { if (input.signal?.aborted) throw err; console.error('[gen] fileUnderstanding failed:', err); }
  throwIfAborted(input.signal);
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

  const facts = extractFacts(template, allEvidence, documentSpec);
  for (const artifact of roleArtifacts) {
    for (const fact of artifact.facts) facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;
  }
  const localFacts = extractStructuredFacts(allEvidence, template, documentSpec);
  const roleStructuredFacts: DocumentFact[] = roleArtifacts.flatMap(artifact => artifact.facts.map(fact => ({ key: fact.key, value: stringifyFactValue(fact.value), sourceFile: fact.sourceFile, roleId: fact.roleId, confidence: 0.9 })));
  const projectBasicStructuredFacts: DocumentFact[] = projectBasicFacts.map((fact: ProjectBasicFact) => ({ key: fact.key, value: fact.value, sourceFile: fact.sourceFile, roleId: 'project_basic_fact', confidence: 0.85 }));
  const preLlmFacts = [...projectBasicStructuredFacts, ...roleStructuredFacts, ...localFacts];
  let llmExtraction: { facts: DocumentFact[]; stages: DocumentExecutionStage[] } = { facts: [], stages: [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: '已有本地/角色事实覆盖主要必需字段，跳过 LLM 全量事实抽取' }] };
  if (shouldRunLlmFactExtraction(preLlmFacts, template, documentSpec)) {
    try { llmExtraction = await extractFactsWithLlm(allEvidence, factExtractionPromptTexts, template, documentSpec, input.signal); } catch (err) { if (input.signal?.aborted) throw err; console.error('[gen] fact extraction failed:', err); }
  }
  throwIfAborted(input.signal);
  const structuredFacts = [...projectBasicStructuredFacts, ...roleStructuredFacts, ...localFacts, ...llmExtraction.facts];

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
    message: `增强贡献：知识库证据 ${allEvidence.length} 条，人工确认/固定证据 ${pinnedEvidenceCount} 条，项目上下文 ${projectContextEntries.length} 条，自动检索证据 ${autoEvidenceCount} 条`,
  }, { subtitle: '证据与上下文增强' });
  progressStages.push(enhancementStage);
  emitProgress();
  for (const fact of structuredFacts) facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;
  const sourceCounts = new Map<string, number>();
  for (const item of allEvidence) sourceCounts.set(item.filePath, (sourceCounts.get(item.filePath) ?? 0) + 1);
  const sources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).map(([filePath, count]) => ({ filePath, count }));
  const factsModel = buildFactsModel(structuredFacts, structuredTables, missingItems, documentSpec);
  const chapterReadiness = evaluateChapterReadiness(chapterDrafts, documentSpec);
  const validation = validateDraft(chapterDrafts, structuredFacts, template);
  validation.warnings.push(...readiness.warnings);
  validation.errors.push(...readiness.blockingIssues);
  let validationIssues = buildValidationIssues(validation, factsModel, chapterDrafts);
  validationIssues.push(...chapterReadinessIssues(chapterReadiness));
  const forbidDrawingImages = shouldForbidDrawingImages(roleArtifacts, template);
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
    ? await withProgressHeartbeat(() => expandDocumentToBudget({ template, chapters: chapterDrafts, budget: documentBudget, promptTexts, requirement: input.requirement, forbidDrawingImages, signal: input.signal }))
    : chapterDrafts;
  chapterDrafts.splice(0, chapterDrafts.length, ...budgetExpandedChapters);
  const budgetDraftMarkdown = chapterDrafts.map(chapter => chapter.content).join('\n\n');
  const budgetStatus = documentBudgetStatus(documentBudget, budgetDraftMarkdown);
  const budgetTargetText = [
    documentBudget.targetChars ? `目标 ${documentBudget.targetChars} 字${documentBudget.minChars || documentBudget.maxChars ? `（区间 ${documentBudget.minChars || 0}-${documentBudget.maxChars || '∞'} 字）` : ''}` : undefined,
    documentBudget.targetPages ? `目标 ${documentBudget.targetPages} 页${documentBudget.minPages || documentBudget.maxPages ? `（区间 ${documentBudget.minPages || 0}-${documentBudget.maxPages || '∞'} 页）` : ''}` : undefined,
  ].filter(Boolean).join(' / ') || '默认章节深度';
  const budgetOverLimit = Boolean(documentBudget.maxChars && budgetStatus.currentChars > documentBudget.maxChars);
  const budgetStage = displayStage({ type: 'validation', roleId: 'document-budget', status: budgetOverLimit || (documentBudget.minChars && budgetStatus.currentChars < documentBudget.minChars) ? 'fallback' : 'success', message: elapsedMessage(`文档预算：当前 ${budgetStatus.currentChars} 字，新增 ${Math.max(0, budgetStatus.currentChars - budgetBeforeChars)} 字，预计 ${budgetStatus.estimatedPages} 页；${budgetTargetText}`, budgetStartedAt) }, { subtitle: '文档预算' });
  upsertProgressStage(progressStages, budgetStage);
  emitProgress(chapterDrafts);
  const fallbackChapterCount = chapterGenerationStages.filter(stage => stage.type === 'chapter_generation' && stage.status === 'fallback').length;
  const failedChapterCount = chapterGenerationStages.filter(stage => stage.type === 'chapter_generation' && stage.status === 'failed').length;
  if (fallbackChapterCount > 0) validationIssues.push({ level: 'error', message: `章节生成存在兜底：${fallbackChapterCount} 章`, suggestion: '请检查模型调用、提示词长度或证据负载后重新生成。' });
  if (failedChapterCount > 0) validationIssues.push({ level: 'warning', message: `部分章节生成失败：${failedChapterCount} 章`, suggestion: failedChapterMessages.slice(0, 6).join('；') || '请检查模型调用或资料配置后重新生成失败章节。' });
  const initialBlockingCount = validationIssues.filter(issue => issue.level === 'error' && isExportBlockingIssue(issue)).length;
  const assets: DocumentAsset[] = [];
  const executionStages: DocumentExecutionStage[] = [...progressStages];
  upsertProgressStage(executionStages, displayStage({ type: 'validation', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'failed' : 'success', message: `阻断 ${initialBlockingCount}，错误 ${validation.errors.length}，警告 ${validation.warnings.length}` }, { subtitle: '最终规范校验' }));
  upsertProgressStage(executionStages, displayStage({ type: 'formatting', roleId: 'document-workflow', status: 'success', message: '已生成正式排版 Markdown' }));
  upsertProgressStage(executionStages, displayStage({ type: 'export_ready', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'fallback' : 'success', message: initialBlockingCount > 0 ? '导出存在风险项，仍可导出，请人工复核' : '已准备好导出 Markdown/HTML/DOCX/PDF' }));
  const base = {
    templateId: template.id,
    templateName: template.name,
    title: template.outputTitle,
    requirement: input.requirement || '',
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
    exportGate: { passed: true, blockingIssues: [], checklist: [] },
    assets,
    partialChapters: chapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: chapterDrafts,
    generatedAt: Date.now(),
  };
  const initialMarkdown = composeDocumentMarkdown(base);
  throwIfAborted(input.signal);
  upsertProgressStage(executionStages, displayStage({
    type: 'llm_review',
    roleId: 'chapter-review',
    status: 'running',
    message: `正在进行章节级质量审查：${chapterDrafts.length} 章`,
    details: [`审查并发：${generationStrategy.maxChapterReviewConcurrency}`, '检查事实覆盖、结构完整性和篇幅达标'],
    progress: { current: 1, total: 3, label: '章节审查' },
  }, { subtitle: '章节级质量审查' }));
  emitProgress(chapterDrafts, executionStages);
  const chapterReview = generationStrategy.enableChapterReview
    ? await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'chapter-review', () => reviewChapterSummaries({ template, chapters: chapterDrafts, budget: documentBudget, promptTexts: reviewPromptTexts || promptTexts, requirement: input.requirement, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: input.signal }), { chapters: chapterDrafts.length }), executionStages)
    : { summaries: chapterDrafts.map(chapter => ({ chapterId: chapter.id, title: chapter.title, status: 'pass' as const, issues: [], suggestions: [], chars: documentTextLength(chapter.content) })), stage: displayStage({ type: 'llm_review' as const, roleId: 'chapter-review', status: 'skipped', message: '当前策略未启用章节级 LLM 审查' }, { subtitle: '章节级质量审查' }) };
  executionStages.push(chapterReview.stage);
  for (const summary of chapterReview.summaries.filter(item => item.status !== 'pass')) {
    validationIssues.push({ level: summary.status === 'fail' ? 'error' : 'warning', message: `${summary.title} 章节审查：${summary.issues.slice(0, 4).join('；') || '存在质量风险'}`, suggestion: summary.suggestions.slice(0, 3).join('；') || '请复核章节事实覆盖、结构完整性和专业闭环。' });
  }
  upsertProgressStage(executionStages, displayStage({
    type: 'llm_review',
    roleId: 'global-consistency-review',
    status: 'running',
    message: '正在进行全局一致性审查',
    details: ['检查跨章节术语、项目参数、范围边界和闭环关系'],
    progress: { current: 2, total: 3, label: '全局审查' },
  }, { subtitle: '全局一致性审查' }));
  emitProgress(chapterDrafts, executionStages);
  const globalReview = generationStrategy.enableGlobalReview
    ? await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'global-consistency-review', () => reviewGlobalConsistency({ template, chapters: chapterDrafts, chapterReviews: chapterReview.summaries, promptTexts: reviewPromptTexts || promptTexts, requirement: input.requirement, projectContext, diagnostics: generationDiagnostics, signal: input.signal }), { chapters: chapterDrafts.length }), executionStages)
    : { issues: [] as string[], stage: displayStage({ type: 'llm_review' as const, roleId: 'global-consistency-review', status: 'skipped', message: '当前策略未启用全局 LLM 一致性审查' }, { subtitle: '全局一致性审查' }) };
  executionStages.push(globalReview.stage);
  for (const issue of globalReview.issues) validationIssues.push({ level: 'warning', message: `全局一致性审查：${issue}`, suggestion: '请复核跨章节术语、项目参数、范围边界和闭环关系。' });
  emitProgress(chapterDrafts, executionStages);
  const riskChapters = chapterDrafts.filter(chapter => chapter.evidence.length === 0 || chapter.missingFacts.length > 0 || documentTextLength(chapter.content) < Math.floor((documentBudget.chapterTargets.get(chapter.id) || 1200) * 0.7) || chapterReview.summaries.some(summary => summary.chapterId === chapter.id && summary.status !== 'pass') || lightweightChapterIssues({ chapter: effectiveChapters.find(item => item.id === chapter.id) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections }, content: chapter.content, missingFacts: chapter.missingFacts, targetWords: documentBudget.chapterTargets.get(chapter.id) || 1200 }).length > 0);
  const forceFinalQualityReview = initialBlockingCount > 0 || globalReview.issues.length > 0 || chapterReview.summaries.some(summary => summary.status === 'fail') || validationIssues.some(issue => /事实一致性|项目污染|章节生成存在兜底|章节生成失败|阻断/u.test(issue.message));
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
  const review = shouldFinalQualityReview
    ? await withProgressHeartbeat(() => reviewAndOptimizeMarkdown({ template, spec: documentSpec, markdown: initialMarkdown, evidence: allEvidence, promptTexts: reviewPromptTexts || promptTexts, projectContext, requirement: input.requirement, diagnostics: generationDiagnostics, signal: input.signal }), executionStages)
    : { markdown: initialMarkdown, stage: { type: 'llm_review' as const, roleId: 'llm-review', status: riskChapters.length > 0 ? 'skipped' as const : 'success' as const, message: riskChapters.length > 0 ? `本地风险扫描发现 ${riskChapters.length} 个低/中风险章节，当前策略未启用最终质量审查` : '本地风险扫描未发现需要 LLM 最终质量审查的章节' } };
  review.stage.message = elapsedMessage(review.stage.message || 'LLM 审查完成', reviewStartedAt);
  throwIfAborted(input.signal);
  const reviewedMarkdownBase = normalizeTertiaryHeadings(removeUnwantedDrawingImages(review.markdown === initialMarkdown ? composeDocumentMarkdown({ ...base, validationIssues, exportGate: base.exportGate, executionStages }) : review.markdown, forbidDrawingImages));
  const structureIssueMessages = configuredStructureIssues(reviewedMarkdownBase, template).map(issue => issue.message);
  const placeholderIssueMessages = formalPlaceholderIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const gateIssueMessages = configuredAutoSpecGateIssues(reviewedMarkdownBase, template).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const preciseIssueMessages = preciseFactUsageIssues(reviewedMarkdownBase, factsModel).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const quantifiedCoverageMessages = validateQuantifiedCoverage({ assignments: technicalFactAssignments, markdown: reviewedMarkdownBase }).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const tocIssueMessages = tocHierarchyIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const duplicateBasicInfoMessages = duplicateProjectBasicInfoIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const formalStyleMessages = formalStyleIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const minSectionMessages = minChapterSectionIssues(chapterDrafts).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const tertiaryHeadingMessages = tertiaryHeadingIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const qualityIssues = [...tenderQualityIssues(reviewedMarkdownBase, chapterDrafts, tenderPlan, roleArtifacts, forbidDrawingImages), ...structureIssueMessages, ...placeholderIssueMessages, ...gateIssueMessages, ...preciseIssueMessages, ...quantifiedCoverageMessages, ...tocIssueMessages, ...duplicateBasicInfoMessages, ...formalStyleMessages, ...minSectionMessages, ...tertiaryHeadingMessages];
  const repairStartedAt = Date.now();
  const repairIssues = qualityIssues;
  upsertProgressStage(executionStages, displayStage({
    type: 'llm_review',
    roleId: 'quality-repair',
    status: repairIssues.length > 0 ? 'running' : 'success',
    message: repairIssues.length > 0 ? `正在进行精准质量修复：${repairIssues.length} 个问题` : '未发现需要精准修复的问题',
    details: repairIssues.slice(0, 6),
    progress: { current: 1, total: Math.max(1, repairIssues.length), label: '质量修复' },
  }, { subtitle: '精准质量修复' }));
  emitProgress(chapterDrafts, executionStages);
  const repair = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'local-patch-quality-repair', () => repairMarkdownByQuality({ markdown: reviewedMarkdownBase, template, chapters: chapterDrafts, promptTexts, requirement: input.requirement, issues: repairIssues, forbidDrawingImages, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: input.signal }), { issues: repairIssues.length }), executionStages);
  if (repair.stage) repair.stage.message = elapsedMessage(repair.stage.message || '质量修复完成', repairStartedAt);
  throwIfAborted(input.signal);
  const reviewedStages = repair.stage ? [...executionStages, review.stage, repair.stage] : [...executionStages, review.stage];
  let repairedChapterDrafts = repair.chapters;
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
    repairedChapterDrafts = await withProgressHeartbeat(() => expandDocumentToBudget({ template, chapters: repairedChapterDrafts, budget: documentBudget, promptTexts, requirement: input.requirement, forbidDrawingImages, signal: input.signal }), reviewedStages);
    const postRepairBudgetStatus = documentBudgetStatus(documentBudget, repairedChapterDrafts.map(chapter => chapter.content).join('\n\n'));
    upsertProgressStage(reviewedStages, displayStage({ type: 'validation', roleId: 'document-budget-repair', status: documentBudget.minChars && postRepairBudgetStatus.currentChars < documentBudget.minChars ? 'fallback' : 'success', message: elapsedMessage(`修复后预算补齐：当前 ${postRepairBudgetStatus.currentChars} 字，新增 ${Math.max(0, postRepairBudgetStatus.currentChars - postRepairBeforeChars)} 字，预计 ${postRepairBudgetStatus.estimatedPages} 页`, postRepairBudgetStartedAt) }, { subtitle: '修复后预算补齐' }));
  }
  const repairedMarkdown = composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages });
  const finalSections = inferChapterSectionsFromMarkdown(repairedMarkdown, repairedChapterDrafts);
  const finalChapterDrafts = repairedChapterDrafts.map((chapter, index) => ({ ...chapter, sections: finalSections[index] || chapter.sections || [] }));
  const finalMarkdown = normalizeTertiaryHeadings(sanitizeFormalMarkdown(ensureFormalToc(removeUnwantedDrawingImages(repairedMarkdown, forbidDrawingImages), finalChapterDrafts)));
  const preRepairWarningIssues = [...tenderQualityIssues(reviewedMarkdownBase, chapterDrafts, tenderPlan, roleArtifacts, forbidDrawingImages), ...structureIssueMessages];
  validationIssues = applySpecGateRules(documentSpec, [...validationIssues, ...preRepairWarningIssues.map(message => ({ level: 'warning' as const, message }))], factsModel, finalChapterDrafts, finalMarkdown, fileBindings, promptBindings);
  validationIssues.push(...validateDraftWithAutoSpec({ markdown: finalMarkdown, spec: documentSpec, summary: projectMaterialSummary }));
  validationIssues.push(...validateFactConsistency({ markdown: finalMarkdown, facts: structuredFacts, summary: projectMaterialSummary }));
  validationIssues.push(...validateProjectContamination(finalMarkdown, projectMaterialSummary));
  validationIssues.push(...validateEngineeringDetailGate({ template, chapters: finalChapterDrafts, assignments: technicalFactAssignments, finalMarkdown }));
  validationIssues.push(...validateQuantifiedCoverage({ assignments: technicalFactAssignments, markdown: finalMarkdown }));
  validationIssues.push(...tocHierarchyIssues(finalMarkdown));
  validationIssues.push(...duplicateProjectBasicInfoIssues(finalMarkdown));
  validationIssues.push(...formalStyleIssues(finalMarkdown));
  validationIssues.push(...tertiaryHeadingIssues(finalMarkdown));
  validationIssues.push(...minChapterSectionIssues(finalChapterDrafts));
  validationIssues.push(...preciseFactUsageIssues(finalMarkdown, factsModel));
  validationIssues.push(...formalPlaceholderIssues(finalMarkdown));
  validationIssues.push(...promptExampleLeakIssues(finalMarkdown, promptBindings));
  validationIssues.push(...degenerateContentIssues(finalMarkdown, finalChapterDrafts));
  for (const benchmark of validateDocumentQualityBenchmark({ template, chapters: finalChapterDrafts, markdown: finalMarkdown })) validationIssues.push(...benchmark.issues);
  validationIssues.push(...validateEngineeringSpecialty({ markdown: finalMarkdown, chapters: finalChapterDrafts, summary: projectMaterialSummary, roles: resolvedMaterialRoles }));
  validationIssues.push(...configuredAutoSpecGateIssues(finalMarkdown, template));
  const budgetIssues = documentBudgetIssues(documentBudget, finalChapterDrafts.map(chapter => chapter.content).join('\n\n'));
  const pageIssues = pageTargetIssues(template.generationSettings || template.exportSettings, finalMarkdown).filter(issue => !(documentBudget.minPages && /低于目标页数/u.test(issue.message)));
  validationIssues.push(...pageIssues);
  validationIssues.push(...budgetIssues);
  validationIssues.push(...configuredStructureIssues(finalMarkdown, template));
  const finalExportGate = buildExportGate(validationIssues, factsModel, finalChapterDrafts);
  const blockingCount = finalExportGate.blockingIssues.length;
  const finalQualitySummary = qualitySeveritySummary(validationIssues);
  generationDiagnostics.quality.blockingCount += finalQualitySummary.blocking;
  generationDiagnostics.quality.importantCount += finalQualitySummary.important;
  generationDiagnostics.quality.minorCount += finalQualitySummary.minor;
  const finalStages: DocumentExecutionStage[] = reviewedStages.map(stage => {
    if (stage.type === 'validation' && stage.roleId === 'document-workflow') return { ...stage, status: blockingCount > 0 ? 'failed' : 'success', message: `阻断 ${blockingCount}，问题 ${validationIssues.length}` };
    if (stage.type === 'export_ready') return { ...stage, status: finalExportGate.passed ? 'success' : 'fallback', message: finalExportGate.passed ? '已准备好导出 Markdown/HTML/DOCX/PDF' : '导出存在风险项，仍可导出，请人工复核' };
    return stage;
  });
  generationDiagnostics.llm.currentLimit = getAdaptiveDocumentLlmLimit();
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-diagnostics', status: 'success', message: `性能统计：LLM ${generationDiagnostics.llm.calls} 次，失败 ${generationDiagnostics.llm.failures} 次，排队 ${generationDiagnostics.llm.throttledWaits} 次/${Math.round(generationDiagnostics.llm.throttledWaitMs / 1000)} 秒，检索 ${generationDiagnostics.evidence.searchQueries} 次/${Math.round(generationDiagnostics.evidence.searchMs / 1000)} 秒，证据上下文 ${generationDiagnostics.evidence.contextChars} 字，缓存命中 ${generationDiagnostics.cache.chapterHits} 章/${generationDiagnostics.cache.sectionHits} 小节，写入 ${generationDiagnostics.cache.chapterWrites} 章/${generationDiagnostics.cache.sectionWrites} 小节，噪声过滤 ${generationDiagnostics.evidence.filteredNoise} 条，质量问题 阻断${generationDiagnostics.quality.blockingCount}/重要${generationDiagnostics.quality.importantCount}/轻微${generationDiagnostics.quality.minorCount}，自动限流调整 ${generationDiagnostics.llm.limitAdjustments} 次` }, { subtitle: '后台诊断' }));
  const finalBase = {
    ...base,
    chapters: finalChapterDrafts,
    validationIssues,
    exportGate: finalExportGate,
    executionStages: finalStages,
    partialChapters: finalChapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: finalChapterDrafts,
    reviewMetadata: { chapterSummaries: chapterReview.summaries, globalIssues: globalReview.issues, diagnostics: generationDiagnostics },
  };
  return { ...finalBase, markdown: finalMarkdown };
}

export async function regenerateDocumentChapter(input: { templateId: string; chapterId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; documentId?: string; currentMarkdown?: string; existingFacts?: string[] }): Promise<DocumentDraftChapter> {
  const template = getDocumentTemplate(input.templateId);
  if (!template) throw new Error('Document template not found');
  const chapter = template.chapters.find(item => item.id === input.chapterId);
  if (!chapter) throw new Error('Document chapter not found');
  const projectRoot = path.resolve(input.projectRoot || getProjectRoot());
  if (!projectRoot) throw new Error('No knowledge base project found');
  const manager = getMultiProjectManager();
  const maxEvidence = Math.max(5, Math.min(30, input.maxEvidencePerChapter ?? 12));
  const boundFilePaths = buildBoundEvidenceScope(projectRoot, templateFileBindings(template));
  const rawEvidence: DocumentEvidence[] = [];
  const scopedFilePaths = [...boundFilePaths].filter(Boolean).sort();
  for (const query of chapter.queries) {
    const result = await manager.search(projectRoot, query, {
      scope: 'project',
      filters: { filePaths: scopedFilePaths },
      limit: Math.max(maxEvidence, 30),
      weights: { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
    });
    rawEvidence.push(...result.results
      .filter((item: KbSearchResult) => evidenceInScope(projectRoot, item.filePath, boundFilePaths))
      .map((item: KbSearchResult) => ({
        chapterId: chapter.id,
        filePath: item.filePath,
        score: item.score,
        content: item.content,
        sectionTitle: item.sectionTitle,
        source: item.source,
      })));
  }
  const evidence = uniqueEvidence(rawEvidence.filter(item => evidenceInScope(projectRoot, item.filePath, boundFilePaths)), maxEvidence);
  const existingContext = input.currentMarkdown ? input.currentMarkdown.slice(0, 4_000) : '';
  const existingFactSet = new Set(input.existingFacts ?? []);
  const missingFacts = chapter.requiredFacts.filter(fact => !existingFactSet.has(fact) && !evidence.some(item => evidenceMatchesFact(item, fact)));
  const content = [
    `## ${chapter.title}`,
    '',
    input.requirement ? `> 生成要求：${input.requirement}` : '',
    existingContext ? `> 当前文档上下文摘要：${existingContext.replace(/\s+/gu, ' ').slice(0, 800)}` : '',
    evidence.length > 0 ? `本章根据知识库资料围绕“${chapter.purpose}”重新整理，并与当前文档上下文保持一致。` : '建议补充更多资料后复核。',
    '',
    evidence.length > 0 ? '### 资料依据' : '',
    ...evidence.map(evidenceLine),
    '',
    missingFacts.length > 0 ? '### 待确认事项' : '',
    ...missingFacts.map(item => `- ${item}：建议人工复核或补充更明确资料。`),
  ].filter(Boolean).join('\n');
  return { id: chapter.id, title: chapter.title, content, evidence, missingFacts };
}
