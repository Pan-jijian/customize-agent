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
import { validateProjectContamination } from '../document-validation/documentContaminationService';
import { chapterReadinessIssues, evaluateChapterReadiness } from '../document-validation/chapterReadinessService';
import { validateFactConsistency } from '../document-validation/factConsistencyService';
import type { KbSearchResult } from '@/lib/api';
import type { DocumentAsset, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, GeneratedDocumentDraft } from './types';
import { boundFileRolesForMaterialSummary, defaultProjectRoleConfigIdForTemplate, getDocumentTemplate, templateFileBindings, templatePromptBindings } from './templateStore';
import { evidenceLine, evidencePromptBudgetForTarget, selectEvidenceByBudget } from './evidence';
import { displayChapterTitle, effectiveTemplateChapters, extractExplicitOutlineFromSources } from './outline';
import { evidenceMatchesFact } from './factMatching';
import { composeDocumentMarkdown, plannedStructureIssues, plannedStructurePrompt, extractGeneratedSections, finalizeDocumentMarkdown, tertiaryHeadingIssues } from './markdownComposer';
import { buildDocumentBudget, documentBudgetIssues, documentBudgetStatus, documentTextLength, pageTargetIssues } from './budget';
import { applySpecGateRules, buildExportGate, collectSectionContentGaps, plannedAutoSpecGateIssues, degenerateContentIssues, duplicateBasicInfoIssues, formalContentIntegrityIssues, formalPlaceholderIssues, formalStyleIssues, isExportBlockingIssue, minChapterSectionIssues, preciseFactUsageIssues, promptExampleLeakIssues, qualitySeveritySummary, sectionContentIntegrityIssues, tocBodyConsistencyIssues, tocHierarchyIssues } from './qualityValidation';
import { extractFacts, extractFactsWithLlm, extractStructuredFacts, extractStructuredTables, buildFactsModel, shouldRunLlmFactExtraction } from './factsModel';
import { stableHash, stringifyFactValue, throwIfAborted } from '@/services/document-workflow/utils';
import { displayStage, elapsedMessage, upsertProgressStage } from './progress';
import { callWithTimeout, getActiveModelWithProvider, getAdaptiveDocumentLlmLimit, limitAdaptiveDocumentLlmLimit } from './llmClient';
import type { RoleNodeArtifact } from './rolePipeline';
import { blockingChapterIssues, buildBoundEvidenceScope, buildRoleChapterContext, buildRoleEvidencePool, buildRoleExecutionNodes, chapterPlanFor, createGenerationDiagnostics, evidenceForRoleFiles, evidenceInScope, executeRoleExtractionNode, fileScopeKeys, lightweightChapterIssues, measureGenerationStep, promptOutlineTextsForExecution, promptTextsForExecution, projectEvidenceVersionHash, repairChapterByQuality, repairMarkdownByQuality, roleArtifactsDigest, roleFactsForChapter, shouldForbidDrawingImages, selectDocumentGenerationStrategy, tenderPlanChaptersFromArtifacts } from './rolePipeline';
import { buildChapterFactCoverageContext, buildLlmChapterContent, buildSectionParallelChapterContent, buildValidationIssues, expandChapterToTarget, expandDocumentToBudget, formatContextEntries, outputTokensForChapter, planChapterSectionsWithLlm, reviewAndOptimizeMarkdown, reviewChapterSummaries, reviewGlobalConsistency, supplementShortSections, timeoutMsForChapter, understandReferenceFiles } from './chapterGeneration';


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
  if (template?.fileBindings?.some(binding => binding.roleId === 'rule') && !roleIds.has('rule')) warnings.push('rule 角色未抽取到结构化事实');
  return { passed: errors.length === 0, warnings, errors };
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

function criticalChapterSectionGaps(markdown: string, chapter: DocumentTemplateChapter) {
  return collectSectionContentGaps(markdown, [{ title: chapter.title, content: markdown, sections: chapter.sections || [] }])
    .filter(gap => gap.planned || gap.reason === 'missing_planned_section');
}

function factsWithSourceFallback(facts: DocumentFact[], evidence: DocumentEvidence[]) {
  const fallback = evidence.find(item => item.filePath)?.filePath || '';
  if (!fallback) return facts;
  return facts.map(fact => fact.sourceFile ? fact : { ...fact, sourceFile: fallback, sourceRef: { filePath: fallback, roleId: fact.sourceRef?.roleId || fact.roleId, processingType: fact.sourceRef?.processingType || fact.processingType, sectionTitle: fact.sourceRef?.sectionTitle, chunkIndex: fact.sourceRef?.chunkIndex, cellRange: fact.sourceRef?.cellRange } });
}

function slowMetricSummary(metrics: DocumentGenerationDiagnostics['metrics']) {
  return [...metrics]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map(metric => `${metric.name} ${Math.round(metric.durationMs / 1000)}秒`)
    .join('，');
}

type EvidenceLimitProject = {
  listFiles?: () => Array<{ relativePath: string; chunkCount?: number }>;
};

export function resolveDocumentGenerationEvidenceLimit(project: EvidenceLimitProject, scopedFilePaths: string[], requestedLimit?: number): number {
  if (Number.isFinite(requestedLimit) && requestedLimit! > 0) return Math.ceil(requestedLimit!);
  const scoped = new Set(scopedFilePaths.filter(Boolean));
  const chunkCount = project.listFiles?.()
    .filter(record => scoped.size === 0 || scoped.has(record.relativePath))
    .reduce((sum, record) => sum + Math.max(0, Math.ceil(Number(record.chunkCount) || 0)), 0) ?? 0;
  if (chunkCount > 0) return chunkCount;
  return Math.max(1, scoped.size);
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
    message: '正在分析模板规范、用户要求与绑定材料摘要',
    details: ['解析 OUTLINE 与模板章节', '读取绑定文件清单', '评估材料覆盖率与生成准备度'],
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
    message: `正在扫描 ${explicitFileBindings.length} 个绑定材料并生成摘要`,
    details: ['读取材料清单', '统计基础事实与材料角色覆盖', '准备后台控制提示词'],
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
  const promptTexts = [backgroundControlPrompt, `生成前规划章节结构：\n${plannedStructurePrompt(template)}`, promptTextsForExecution(promptBindings, ['chapter_generation', 'formatting', 'reference'])].filter(Boolean).join('\n\n');
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
  const requestedEvidencePerChapter = resolveDocumentGenerationEvidenceLimit(project, [...evidenceScopePaths], input.maxEvidencePerChapter);
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
  const allEvidence: DocumentEvidence[] = [];
  const missingItems: string[] = [];
  const failedChapterMessages: string[] = [];
  const chapterGenerationStages: DocumentExecutionStage[] = [];
  let knowledgeBaseStageIndex = -1;
  const roleNodes = buildRoleExecutionNodes(template, promptBindings, fileBindings);
  const rolePoolEvidenceBudget = evidencePromptBudgetForTarget(Math.max(1200, explicitFileBindings.length * 900), 12000, getAdaptiveDocumentLlmLimit());
  const roleEvidencePool = buildRoleEvidencePool(project, roleNodes, projectRoot, rolePoolEvidenceBudget);
  const rolePoolStage = displayStage({
    type: 'file_understanding',
    roleId: 'role-evidence-pool',
    status: 'success',
    message: `已构建共享资料证据池：唯一文件 ${roleEvidencePool.uniqueFileCount} 份，角色绑定 ${roleEvidencePool.bindingCount} 条，加载片段 ${roleEvidencePool.loadedChunkCount}/${roleEvidencePool.totalChunkCount}`,
    details: [`复用绑定：${Math.max(0, roleEvidencePool.bindingCount - roleEvidencePool.uniqueFileCount)} 条`, `待执行资料理解节点：${roleNodes.length} 个`, roleEvidencePool.omittedChunkCount > 0 ? `按模型上下文预算延后加载片段：${roleEvidencePool.omittedChunkCount} 条` : '材料片段已全部纳入共享池'],
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
  const configuredRoleConcurrency = Number(process.env.DOCUMENT_ROLE_CONCURRENCY ?? (roleNodes.length > 12 ? 1 : 2));
  const roleConcurrency = Math.max(1, Math.min(roleNodes.length || 1, 3, Number.isFinite(configuredRoleConcurrency) ? Math.floor(configuredRoleConcurrency) : 1));
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
      const artifact = await withProgressHeartbeat(() => executeRoleExtractionNode(template, node, nodeEvidence, input.signal));
      const completedStage = displayStage({
        type: 'file_understanding',
        roleId: node.fileRoleId,
        promptId: node.promptRoleIds[0],
        status: nodeEvidence.length > 0 ? 'success' : 'fallback',
        message: elapsedMessage(`${node.fileRoleName} 节点已完成，产出章节建议 ${artifact.chapters.length} 个、事实 ${artifact.facts.length} 条`, nodeStartedAt),
        details: [`产出章节建议：${artifact.chapters.length} 个`, `提取事实：${artifact.facts.length} 条`, '已完成模型理解'],
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
    const compactRoleEvidence = selectEvidenceByBudget(allEvidence, { maxItems: Math.max(40, roleNodes.length * 8), maxChars: Math.max(45000, roleNodes.length * 5000), preservePinned: true });
    allEvidence.splice(0, allEvidence.length, ...compactRoleEvidence);
  }
  const tenderPlan = tenderPlanChaptersFromArtifacts(template, roleArtifacts);
  let effectiveChapters = effectiveTemplateChapters(template, documentSpec, { preserveExplicitOutline: hasExplicitOutline });
  const initialContextQuery = [template.name, template.outputTitle, input.requirement, ...effectiveChapters.flatMap(chapter => [chapter.title, chapter.purpose, ...(chapter.sections || [])])].filter(Boolean).join(' ');
  const projectContextEntries = recallDocumentContexts(initialContextQuery, undefined, projectRoot);
  const projectContext = [formatContextEntries(projectContextEntries), roleArtifactsDigest(roleArtifacts)].filter(Boolean).join('\n\n');
  const provisionalTemplate = { ...template, chapters: effectiveChapters };
  const provisionalBudget = buildDocumentBudget({ requirement: input.requirement, promptTexts, template: provisionalTemplate, chapters: effectiveChapters, spec: documentSpec });
  let skippedSectionPlanningCount = 0;
  let llmSectionPlanningCount = 0;
  const plannedChapters = await Promise.all(effectiveChapters.map(async chapter => {
    if (chapter.sections?.length) {
      skippedSectionPlanningCount += 1;
      return chapter;
    }
    llmSectionPlanningCount += 1;
    const chapterEvidence = selectEvidenceByBudget(allEvidence.filter(item => item.chapterId === chapter.id || evidenceMatchesFact(item, chapter.title)), { maxItems: input.maxEvidencePerChapter || 10, maxChars: evidencePromptBudgetForTarget(provisionalBudget.chapterTargets.get(chapter.id) || 1200), preservePinned: true });
    const roleContext = buildRoleChapterContext(roleArtifacts, chapter, chapterPlanFor(chapter, tenderPlan));
    const sections = await planChapterSectionsWithLlm({ template: provisionalTemplate, chapter, evidence: chapterEvidence, promptTexts, projectContext, requirement: input.requirement, roleContext, targetWords: provisionalBudget.chapterTargets.get(chapter.id) || 1200, signal: input.signal });
    return sections.length ? { ...chapter, sections } : chapter;
  }));
  effectiveChapters = plannedChapters;
  template = { ...template, chapters: effectiveChapters };
  const documentBudget = buildDocumentBudget({ requirement: input.requirement, promptTexts, template, chapters: effectiveChapters, spec: documentSpec });
  checkpointChapterOrderIds = effectiveChapters.map(chapter => chapter.id);
  const generationStrategy = selectDocumentGenerationStrategy({ template, targetWords: documentBudget.targetChars || [...documentBudget.chapterTargets.values()].reduce((sum, value) => sum + value, 0), requirement: input.requirement });
  if (generationStrategy.targetLlmConcurrency > 0) limitAdaptiveDocumentLlmLimit(generationStrategy.targetLlmConcurrency);
  const generationDiagnostics = createGenerationDiagnostics(generationStrategy);
  const llmConcurrencyMessage = generationStrategy.targetLlmConcurrency > 0 ? `LLM 并发上限 ${generationStrategy.targetLlmConcurrency}` : 'LLM 不做本地并发限流';
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-strategy', status: 'success', message: `已自动选择 ${generationStrategy.mode} 生成策略：章节审查 ${generationStrategy.enableChapterReview ? '启用' : '跳过'}、全局审查 ${generationStrategy.enableGlobalReview ? '启用' : '跳过'}、最终质量审查 ${generationStrategy.enableFinalQualityReview ? '启用' : '跳过'}、全文扩写 ${generationStrategy.enableDocumentBudgetExpansion ? '启用' : '跳过'}；${llmConcurrencyMessage}` }, { subtitle: '后台自动策略' }));
  const contextStage: DocumentExecutionStage = displayStage({
    type: 'context_recall',
    roleId: 'project-memory',
    status: projectContextEntries.length > 0 ? 'success' : 'skipped',
    message: projectContextEntries.length > 0 ? `已注入 ${projectContextEntries.length} 条短期/长期上下文` : '未召回可用上下文',
  }, { subtitle: '上下文记忆' });
  const sectionPlanningSource = hasExplicitOutline ? 'OUTLINE 章节' : '模板章节';
  const sectionPlanningStage: DocumentExecutionStage = displayStage({
    type: 'validation',
    roleId: 'section-planning',
    status: 'success',
    message: `小节规划：${llmSectionPlanningCount} 章由 LLM 基于${sectionPlanningSource}、角色和绑定文件证据规划小节，${skippedSectionPlanningCount} 章已由模板显式提供小节并跳过规划`,
  }, { subtitle: '小节规划策略' });

  // 第一个进度回调：角色绑定完成
  const outlineMessage = hasExplicitOutline ? `；识别到 OUTLINE 章节 ${explicitPromptChapters.length} 个` : '；未识别到有效 OUTLINE，将使用模板章节';
  upsertProgressStage(progressStages, displayStage({ type: 'role_binding', roleId: projectRoleConfigId, status: 'success', message: `已绑定 ${fileBindings.length} 个文件角色、${promptBindings.length} 个提示词角色；后台优化建议关注 ${documentSpec.factFields.length} 个事实字段；资料覆盖率 ${Math.round(readiness.materialCoverageRate * 100)}%${outlineMessage}` }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName }));
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-readiness', status: readiness.ready ? 'success' : 'failed', message: `生成准备度：资料 ${Math.round(readiness.materialCoverageRate * 100)}%，资料角色 ${Math.round(readiness.roleSatisfactionRate * 100)}%，优化建议 ${Math.round(readiness.specCompletenessRate * 100)}%；${projectMaterialSummary.source.selectionReason}` }, { subtitle: '生成准备度检查' }));
  upsertProgressStage(progressStages, contextStage);
  upsertProgressStage(progressStages, sectionPlanningStage);
  emitProgress();

  const configuredChapterConcurrencyRaw = process.env.DOCUMENT_CHAPTER_CONCURRENCY;
  const configuredChapterConcurrency = Number(configuredChapterConcurrencyRaw ?? generationStrategy.maxChapterConcurrency);
  const chapterConcurrency = Math.max(1, Math.min(effectiveChapters.length || 1, generationStrategy.maxChapterConcurrency, Number.isFinite(configuredChapterConcurrency) ? Math.floor(configuredChapterConcurrency) : generationStrategy.maxChapterConcurrency));
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'chapter-concurrency', status: 'success', message: `章节并发调度：本轮 ${chapterConcurrency}/${effectiveChapters.length} 章并发`, details: [`策略上限：${generationStrategy.maxChapterConcurrency}`, `环境变量 DOCUMENT_CHAPTER_CONCURRENCY：${configuredChapterConcurrencyRaw ?? '未设置'}`, `有效章节数：${effectiveChapters.length}`] }, { subtitle: '章节并发策略' }));
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
    const queries = [...new Set([...baseQueries, ...planQueries])].filter(Boolean);
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
    const scopedFilePaths = [...evidenceScopePaths].filter(Boolean).sort();
    const searchResults: KbSearchResult[][] = [];
    const maxSearchQueries = Math.max(2, Math.min(8, Math.floor(Number(process.env.DOCUMENT_MAX_QUERIES_PER_CHAPTER ?? 6))));
    for (const query of queries.slice(0, maxSearchQueries)) {
      throwIfAborted(input.signal);
      if (scopedFilePaths.length === 0) break;
      const result = await manager.search(projectRoot, query, {
        scope: 'project',
        filters: { filePaths: scopedFilePaths },
        limit: Math.min(requestedEvidencePerChapter, 12),
        weights: { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
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
    const pinnedEvidencePaths = new Set<string>((chapter.pinnedEvidenceFilePaths || []).filter(Boolean));
    const matchedRoleContexts = roleFactsForChapter(roleArtifacts, chapter, plan);
    rawEvidence.push(...matchedRoleContexts.flatMap(({ artifact }) => artifact.evidence
      .filter(item => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths))
      .map(item => ({ ...item, chapterId: chapter.id, source: 'role-node' }))));
    const chapterPinnedPaths = new Set([...pinnedEvidencePaths]);
    const chapterBudgetTarget = documentBudget.chapterTargets.get(chapter.id) || 1200;
    const pinnedEvidenceBudget = evidencePromptBudgetForTarget(chapterBudgetTarget, 6000, Math.max(12000, getAdaptiveDocumentLlmLimit() * 3000));
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
    const scopedEvidence = rawEvidence.filter(item => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths));
    const evidenceBudgetChars = evidencePromptBudgetForTarget(chapterBudgetTarget, 8000, Math.max(16000, getAdaptiveDocumentLlmLimit() * 3500));
    const maxEvidenceForChapter = Math.max(8, Math.min(28, requestedEvidencePerChapter * Math.max(1, Math.min(queries.length, 3))));
    const evidence = selectEvidenceByBudget(scopedEvidence, { maxItems: maxEvidenceForChapter, maxChars: evidenceBudgetChars, preservePinned: true }, generationDiagnostics);
    generationDiagnostics.evidence.contextChars += evidence.reduce((sum, item) => sum + item.content.length, 0);
    allEvidence.push(...evidence);
    const compactAllEvidence = selectEvidenceByBudget(allEvidence, { maxItems: Math.max(40, effectiveChapters.length * 10), maxChars: Math.max(50000, effectiveChapters.length * 9000), preservePinned: true });
    allEvidence.splice(0, allEvidence.length, ...compactAllEvidence);
    const missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
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
    const factCoverageContext = buildChapterFactCoverageContext({ chapter, plan, spec: documentSpec, roleFacts: matchedRoleContexts, evidence, missingFacts });
    const specChapterRule = documentSpec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title);
    const budgetTarget = documentBudget.chapterTargets.get(chapter.id) || 1200;
    const chapterMaxChars = Math.ceil(budgetTarget * (documentBudget.maxChars ? 1.1 : 1.18));
    const adaptiveMinimum = documentBudget.targetChars ? Math.min(1200, Math.max(450, Math.floor(budgetTarget * 0.72))) : 1200;
    const minWords = Math.max(plan?.minWords || 0, specChapterRule?.minWords || 0, documentSpec?.dynamicChapterRule.minWordsPerChapter || 0, Math.floor(budgetTarget * 0.78), adaptiveMinimum);
    const targetWords = budgetTarget;
    const generationMaxTokens = outputTokensForChapter(minWords, targetWords);
    const sectionCount = chapter.sections?.filter(Boolean).length || 0;
    const compositeChapterTitle = /[、，,；;]/u.test(chapter.title);
    const useSectionFirst = Number(process.env.DOCUMENT_SECTION_FIRST_GENERATION ?? 1) !== 0 && sectionCount >= 2 && !compositeChapterTitle;
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
      status: 'running',
      message: useSectionFirst ? `${displayChapterTitle(chapter.title)} 正在按小节并发成稿` : `${displayChapterTitle(chapter.title)} 正在整章一次成稿`,
      details: useSectionFirst
        ? [`有效证据：${evidence.length} 条`, `目标字数：约 ${targetWords} 字，上限约 ${chapterMaxChars} 字`, `小节并发上限：${generationStrategy.maxSectionConcurrency}`, `规划小节：${chapter.sections?.length || 0} 个`, '按章节结构拆分小节并发生成，章节聚合后再审查修复']
        : [`有效证据：${evidence.length} 条`, `目标字数：约 ${targetWords} 字，上限约 ${chapterMaxChars} 字`, `章节并发上限：${chapterConcurrency}`, '首次生成必须覆盖章节结构、小节、事实和目标篇幅，后置修复仅兜底'],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: useSectionFirst ? '小节并发' : '整章成稿' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    let llmContent = useSectionFirst
      ? await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-section-draft:${chapter.id}`, () => callWithTimeout(
        signal => buildSectionParallelChapterContent({ template, chapter, evidence, missingFacts, promptTexts, projectContext, requirement: input.requirement, roleContext, targetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, projectRoot, modelName: activeModelName, fileRolesHash, allowPartialResult: false, maxSectionConcurrency: generationStrategy.maxSectionConcurrency, diagnostics: generationDiagnostics, signal }),
        Math.min(timeoutMsForChapter(targetWords), Math.max(240000, Math.ceil((chapter.sections?.length || 2) * 150000 / Math.max(1, generationStrategy.maxSectionConcurrency || 1)))),
        input.signal,
      )))
      : await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, promptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords, targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext, signal }),
        timeoutMsForChapter(targetWords),
        input.signal,
      )));
    if (!llmContent && useSectionFirst) {
      progressStages[chapterProgressIndex] = displayStage({ type: 'chapter_generation', roleId: 'chapter_generation', promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId, status: 'running', message: `${displayChapterTitle(chapter.title)} 小节并发未完整返回，改用整章兜底生成`, details: [`目标字数：约 ${targetWords} 字`, `有效证据：${evidence.length} 条`], progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '整章兜底' } }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft-fallback:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, promptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords, targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext, signal }),
        timeoutMsForChapter(targetWords),
        input.signal,
      )));
    } else if (!llmContent) {
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 整章成稿未完整返回，正在执行整章兜底生成`,
        details: [`目标字数：约 ${targetWords} 字`, `有效证据：${evidence.length} 条`],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '整章兜底' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft-fallback:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, promptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords, targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext, signal }),
        timeoutMsForChapter(targetWords),
        input.signal,
      )));
    }
    throwIfAborted(input.signal);
    if (!llmContent) {
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
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, promptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords: Math.max(450, Math.floor(minWords * 0.75)), targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext, signal }),
        timeoutMsForChapter(targetWords),
        input.signal,
      )));
    }
    throwIfAborted(input.signal);
    if (!llmContent) throw new Error(`${chapter.title} 大模型未返回有效章节正文`);
    let chapterSectionGaps = criticalChapterSectionGaps(llmContent, chapter);
    if (chapterSectionGaps.length > 0) {
      const initialChapterContent = llmContent;
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 首次成稿存在 ${chapterSectionGaps.length} 个小节缺口，正在定向补写`,
        details: chapterSectionGaps.map(gap => gap.message),
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '小节补写' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-supplement:${chapter.id}`, () =>
        supplementShortSections({ template, chapter, content: initialChapterContent, evidence, missingFacts, promptTexts, projectContext, requirement: input.requirement, roleContext, targetWords, forbidDrawingImages, factCoverageContext, maxSectionConcurrency: generationStrategy.maxSectionConcurrency, forcedSections: chapterSectionGaps, signal: input.signal })
      ));
    }
    chapterSectionGaps = criticalChapterSectionGaps(llmContent, chapter);
    if (chapterSectionGaps.length > 0) {
      progressStages[chapterProgressIndex] = displayStage({ type: 'chapter_generation', roleId: 'chapter_generation', promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId, status: 'running', message: `${displayChapterTitle(chapter.title)} 首次生成仍有 ${chapterSectionGaps.length} 个小节缺口，正在章节内强制补齐`, details: chapterSectionGaps.map(gap => gap.message), progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节内小节补齐' } }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      const contentBeforeForcedSupplement = llmContent;
      llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-forced-section-supplement:${chapter.id}`, () =>
        supplementShortSections({ template, chapter, content: contentBeforeForcedSupplement, evidence, missingFacts, promptTexts, projectContext, requirement: input.requirement, roleContext, targetWords, forbidDrawingImages, factCoverageContext, maxSectionConcurrency: generationStrategy.maxSectionConcurrency, forcedSections: chapterSectionGaps, signal: input.signal })
      ));
      chapterSectionGaps = criticalChapterSectionGaps(llmContent, chapter);
    }
    if (chapterSectionGaps.length > 0) {
      progressStages[chapterProgressIndex] = displayStage({ type: 'chapter_generation', roleId: 'chapter_generation', promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId, status: 'running', message: `${displayChapterTitle(chapter.title)} 小节补齐仍未达标，正在整章重新生成`, details: chapterSectionGaps.map(gap => gap.message), progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '整章重生' } }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      const regenerated = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-regenerate-after-section-gaps:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, promptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords, targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext: `${factCoverageContext}\n\n本章上一轮存在小节缺口，必须一次性生成完整章节并覆盖以下小节问题：\n${chapterSectionGaps.map(gap => gap.message).join('\n')}`, signal }),
        timeoutMsForChapter(targetWords),
        input.signal,
      )));
      if (regenerated) llmContent = regenerated;
      chapterSectionGaps = criticalChapterSectionGaps(llmContent, chapter);
    }
    if (chapterSectionGaps.length > 0) {
      const partialContent = llmContent?.trim();
      if (partialContent) {
        const partialSections = chapter.sections?.length ? chapter.sections : extractGeneratedSections(partialContent);
        chapterDrafts.push({ id: chapter.id, title: chapter.title, content: partialContent, evidence, missingFacts, sections: partialSections });
        emitProgress(chapterDrafts);
      }
      throw new Error(`${chapter.title} 小节未完整生成：${chapterSectionGaps.map(gap => gap.sectionTitle).join('、')}`);
    }
    const localIssues = lightweightChapterIssues({ chapter, content: llmContent, missingFacts, targetWords });
    const localSeverity = qualitySeveritySummary(localIssues);
    generationDiagnostics.quality.blockingCount += localSeverity.blocking;
    generationDiagnostics.quality.importantCount += localSeverity.important;
    generationDiagnostics.quality.minorCount += localSeverity.minor;
    const blockingIssues = blockingChapterIssues(localIssues);
    if (blockingIssues.length > 0) {
      const contentBeforeRepair = llmContent;
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 正在根据质量问题修复章节：${blockingIssues.length} 个阻断问题`,
        details: blockingIssues,
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节修复' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      const repairResult = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-repair:${chapter.id}`, () =>
        repairChapterByQuality({ template, chapter: { id: chapter.id, title: chapter.title, content: contentBeforeRepair, evidence, missingFacts, sections: chapter.sections || [] }, issues: blockingIssues, promptTexts, requirement: input.requirement, forbidDrawingImages, diagnostics: generationDiagnostics, signal: input.signal })
      ));
      llmContent = repairResult.content;
      if (repairResult.appliedCount > 0) generationDiagnostics.quality.repairedCount += 1;
      throwIfAborted(input.signal);
    }
    if (!llmContent?.trim()) {
      throw new Error(`${displayChapterTitle(chapter.title)} 首次生成失败，未获得可用于定稿的正文`);
    }
    let content = llmContent;
    let expandRounds = 0;
    const needsExpansion = documentTextLength(content) < Math.floor(targetWords * 0.82) || blockingChapterIssues(lightweightChapterIssues({ chapter, content, missingFacts, targetWords })).length > 0;
    if (needsExpansion) {
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 首次成稿未达定稿门槛，正在定向扩写`,
        details: [`当前 ${documentTextLength(content)} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字`, `章节并发：${chapterConcurrency}`],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节扩写' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      const expandedChapter = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-expand:${chapter.id}`, () =>
        expandChapterToTarget({ template, chapter, content: llmContent, evidence, promptTexts, requirement: input.requirement, roleContext, targetChars: Math.floor(targetWords * 0.95), maxChars: chapterMaxChars, forbidDrawingImages, maxTokens: generationMaxTokens, signal: input.signal })
      ));
      content = expandedChapter.content;
      expandRounds = expandedChapter.rounds;
    }
    const chapterChars = documentTextLength(content);
    const sections = chapter.sections?.length ? chapter.sections : extractGeneratedSections(content);
    const expandedSectionIssues = sectionContentIntegrityIssues(content, [{ title: chapter.title, content, sections }]).map(issue => issue.message);
    const chapterIssues = [...lightweightChapterIssues({ chapter: { ...chapter, sections }, content, missingFacts, targetWords }), ...expandedSectionIssues];
    const chapterStatus = chapterCompletionStatus(chapterChars, targetWords, chapterIssues);
    latestChapterStageForProgress = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptBindings.find(binding => binding.roleId === 'chapter_generation')?.promptId,
      status: chapterStatus,
      message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已由大模型首轮成稿${expandRounds > 0 ? `并定向扩写 ${expandRounds} 轮` : ''}：当前 ${chapterChars} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字${chapterStatus !== 'success' ? `；风险：${chapterIssues.join('、') || '篇幅未达标'}` : ''}`, chapterStartedAt),
      details: [`达标率：${Math.round(chapterChars / Math.max(1, Math.floor(targetWords * 0.95)) * 100)}%`, `二级小节：${sections.length} 个`, `扩写轮次：${expandRounds}`],
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

  if (chapterDrafts.length === 0) {
    throw new Error(`章节生成未完成：${failedChapterMessages.join('；') || '没有生成任何有效章节'}`);
  }
  if (hasExplicitOutline && chapterDrafts.length < effectiveChapters.length) {
    throw new Error(`OUTLINE 指定 ${effectiveChapters.length} 章，实际只生成 ${chapterDrafts.length} 章：${failedChapterMessages.join('；') || '部分章节未生成'}`);
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
  const compactPostFileEvidence = selectEvidenceByBudget(allEvidence, { maxItems: Math.max(48, effectiveChapters.length * 10), maxChars: Math.max(52000, effectiveChapters.length * 9000), preservePinned: true });
  allEvidence.splice(0, allEvidence.length, ...compactPostFileEvidence);

  const facts = extractFacts(template, allEvidence, documentSpec);
  for (const artifact of roleArtifacts) {
    for (const fact of artifact.facts) facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;
  }
  const localFacts = extractStructuredFacts(allEvidence, template, documentSpec);
  const roleStructuredFacts: DocumentFact[] = roleArtifacts.flatMap(artifact => artifact.facts.map(fact => ({ key: fact.key, value: stringifyFactValue(fact.value), sourceFile: fact.sourceFile, roleId: fact.roleId, confidence: 0.9 })));
  const preLlmFacts = [...roleStructuredFacts, ...localFacts];
  let llmExtraction: { facts: DocumentFact[]; stages: DocumentExecutionStage[] } = { facts: [], stages: [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: '已有本地/角色事实覆盖主要必需字段，跳过 LLM 全量事实抽取' }] };
  if (shouldRunLlmFactExtraction(preLlmFacts, template, documentSpec)) {
    const factExtractionEvidence = selectEvidenceByBudget(allEvidence, { maxItems: 48, maxChars: 45000, preservePinned: true });
    try { llmExtraction = await extractFactsWithLlm(factExtractionEvidence, factExtractionPromptTexts, template, documentSpec, input.signal); } catch (err) { if (input.signal?.aborted) throw err; console.error('[gen] fact extraction failed:', err); }
  }
  throwIfAborted(input.signal);
  const structuredFacts = factsWithSourceFallback([...roleStructuredFacts, ...localFacts, ...llmExtraction.facts], allEvidence);

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
    message: `增强贡献：知识库证据 ${allEvidence.length} 条，人工确认/固定证据 ${pinnedEvidenceCount} 条，上下文 ${projectContextEntries.length} 条，自动检索证据 ${autoEvidenceCount} 条`,
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
  for (const artifact of roleArtifacts) {
    for (const warning of artifact.warnings) {
      validationIssues.push({
        level: 'error',
        message: warning,
        suggestion: '请检查绑定资料与角色抽取结果，避免依赖兜底片段进入正文生成。',
      });
    }
  }
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
  const missingChapterCount = Math.max(0, effectiveChapters.length - chapterDrafts.length);
  if (fallbackChapterCount > 0) validationIssues.push({ level: 'warning', message: `章节生成存在兜底：${fallbackChapterCount} 章`, suggestion: '已保留章节成果；建议复核对应章节，但不阻断导出。' });
  if (missingChapterCount > 0) validationIssues.push({ level: 'error', message: `部分章节生成失败：${missingChapterCount} 章`, suggestion: failedChapterMessages.join('；') || '请检查模型调用或资料配置后重新生成失败章节。' });
  const initialBlockingCount = validationIssues.filter(issue => issue.level === 'error' && isExportBlockingIssue(issue)).length;
  const assets: DocumentAsset[] = [];
  const executionStages: DocumentExecutionStage[] = [...progressStages];
  upsertProgressStage(executionStages, displayStage({ type: 'validation', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'failed' : 'success', message: `阻断 ${initialBlockingCount}，错误 ${validation.errors.length}，警告 ${validation.warnings.length}` }, { subtitle: '最终规范校验' }));
  upsertProgressStage(executionStages, displayStage({ type: 'formatting', roleId: 'document-workflow', status: 'success', message: '已生成正式排版 Markdown' }));
  upsertProgressStage(executionStages, displayStage({ type: 'export_ready', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'failed' : 'success', message: initialBlockingCount > 0 ? '导出门禁未通过，请完成阻断问题修复后再导出' : '已准备好导出 Markdown/HTML/DOCX/PDF' }));
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
    exportGate: { passed: initialBlockingCount === 0, blockingIssues: validationIssues.filter(issue => issue.level === 'error' && isExportBlockingIssue(issue)), checklist: [] },
    assets,
    partialChapters: chapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: chapterDrafts,
    generatedAt: Date.now(),
  };
  let initialMarkdown = composeDocumentMarkdown(base);
  throwIfAborted(input.signal);
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
      details: [`审查并发：${generationStrategy.maxChapterReviewConcurrency}`, '仅对本地扫描发现风险的生成结果触发 LLM 审查'],
      progress: { current: 1, total: 3, label: '章节审查' },
    }, { subtitle: '章节级质量审查' }));
    emitProgress(chapterDrafts, executionStages);
  }
  const chapterReview = shouldChapterReview
    ? await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'chapter-review', () => reviewChapterSummaries({ template, chapters: chapterDrafts, budget: documentBudget, promptTexts: reviewPromptTexts || promptTexts, requirement: input.requirement, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: input.signal }), { chapters: chapterDrafts.length }), executionStages)
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
    const configuredRepairConcurrency = Number(process.env.DOCUMENT_CHAPTER_REPAIR_CONCURRENCY ?? generationStrategy.maxChapterReviewConcurrency ?? 1);
    const repairConcurrency = Math.max(1, Math.min(generationStrategy.maxChapterReviewConcurrency || 1, Number.isFinite(configuredRepairConcurrency) ? Math.floor(configuredRepairConcurrency) : 1));
    for (let offset = 0; offset < chapterRepairTargets.length; offset += repairConcurrency) {
      throwIfAborted(input.signal);
      const batch = chapterRepairTargets.slice(offset, offset + repairConcurrency);
      const results = await Promise.all(batch.map(async summary => {
        const chapter = chapterDrafts.find(item => item.id === summary.chapterId);
        if (!chapter) return { chapterId: summary.chapterId, content: undefined as string | undefined, appliedCount: 0 };
        const result = await repairChapterByQuality({ template, chapter, issues: summary.issues, promptTexts: reviewPromptTexts || promptTexts, requirement: input.requirement, forbidDrawingImages, diagnostics: generationDiagnostics, signal: input.signal });
        return { chapterId: summary.chapterId, content: result.content, appliedCount: result.appliedCount };
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
      initialMarkdown = composeDocumentMarkdown({ ...base, chapters: chapterDrafts, validationIssues, executionStages });
    }
    executionStages.push(displayStage({ type: 'llm_review' as const, roleId: 'chapter-review-repair', status: 'success' as const, message: `章节就地修复完成：修复 ${repairedCount} 章，应用 ${patchCount} 个 patch` }, { subtitle: '章节就地修复' }));
    emitProgress(chapterDrafts, executionStages);
  }
  if (shouldChapterReview) {
    for (const summary of chapterReviewSummaries.filter(item => item.status !== 'pass' && item.issues.length > 0)) {
      validationIssues.push({ level: summary.status === 'fail' ? 'error' : 'warning', message: `${summary.title} 章节审查：共 ${summary.issues.length} 个问题；${summary.issues.join('；') || '存在质量风险'}`, suggestion: summary.suggestions.join('；') || '请复核章节事实覆盖、结构完整性和角色证据覆盖。' });
    }
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
    ? await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'global-consistency-review', () => reviewGlobalConsistency({ template, chapters: chapterDrafts, chapterReviews: chapterReviewSummaries, promptTexts: reviewPromptTexts || promptTexts, requirement: input.requirement, projectContext, diagnostics: generationDiagnostics, signal: input.signal }), { chapters: chapterDrafts.length }), executionStages)
    : { issues: [] as string[], stage: displayStage({ type: 'llm_review' as const, roleId: 'global-consistency-review', status: 'skipped', message: generationStrategy.enableGlobalReview ? '未发现需要 LLM 全局一致性审查的跨章节风险，已跳过' : '当前策略未启用全局一致性审查' }, { subtitle: '全局一致性审查' }) };
  executionStages.push(globalReview.stage);
  for (const issue of globalReview.issues) validationIssues.push({ level: 'warning', message: `全局一致性审查：${issue}`, suggestion: '请复核跨章节术语、关键事实、范围边界和上下文一致性。' });
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
    ? await withProgressHeartbeat(() => reviewAndOptimizeMarkdown({ template, spec: documentSpec, markdown: initialMarkdown, evidence: reviewEvidence, promptTexts: reviewPromptTexts || promptTexts, projectContext, requirement: input.requirement, diagnostics: generationDiagnostics, signal: input.signal }), executionStages)
    : { markdown: initialMarkdown, stage: { type: 'llm_review' as const, roleId: 'llm-review', status: riskChapters.length > 0 ? 'fallback' as const : 'success' as const, message: riskChapters.length > 0 ? `本地风险扫描发现 ${riskChapters.length} 个低/中风险章节，未达到最终 LLM 审查触发阈值，保留为待复核 warning` : '本地风险扫描未发现需要 LLM 最终质量审查的章节' } };
  review.stage.message = elapsedMessage(review.stage.message || 'LLM 审查完成', reviewStartedAt);
  throwIfAborted(input.signal);
  const reviewedMarkdownBase = finalizeDocumentMarkdown(review.markdown === initialMarkdown ? composeDocumentMarkdown({ ...base, validationIssues, exportGate: base.exportGate, executionStages }) : review.markdown, chapterDrafts, { forbidDrawingImages }).markdown;
  const structureIssueMessages = plannedStructureIssues(reviewedMarkdownBase, template).map(issue => issue.message);
  const placeholderIssueMessages = formalPlaceholderIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const gateIssueMessages = plannedAutoSpecGateIssues(reviewedMarkdownBase, template).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const preciseIssueMessages = preciseFactUsageIssues(reviewedMarkdownBase, factsModel).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const tocIssueMessages = [...tocHierarchyIssues(reviewedMarkdownBase), ...tocBodyConsistencyIssues(reviewedMarkdownBase)].map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const contentIntegrityMessages = formalContentIntegrityIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const sectionIntegrityMessages = sectionContentIntegrityIssues(reviewedMarkdownBase, chapterDrafts).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const repeatedBasicInfoMessages = duplicateBasicInfoIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const formalStyleMessages = formalStyleIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const minSectionMessages = minChapterSectionIssues(chapterDrafts).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const tertiaryHeadingMessages = tertiaryHeadingIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const qualityIssues = [...structureIssueMessages, ...placeholderIssueMessages, ...gateIssueMessages, ...preciseIssueMessages, ...tocIssueMessages, ...contentIntegrityMessages, ...sectionIntegrityMessages, ...repeatedBasicInfoMessages, ...formalStyleMessages, ...minSectionMessages, ...tertiaryHeadingMessages];
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
  const repair = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'local-patch-quality-repair', () => repairMarkdownByQuality({ markdown: reviewedMarkdownBase, template, chapters: chapterDrafts, promptTexts, requirement: input.requirement, issues: repairIssues, forbidDrawingImages, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: input.signal }), { issues: repairIssues.length }), executionStages);
  if (repair.stage) repair.stage.message = elapsedMessage(repair.stage.message || '质量修复完成', repairStartedAt);
  throwIfAborted(input.signal);
  const reviewedStages = repair.stage ? [...executionStages, review.stage, repair.stage] : [...executionStages, review.stage];
  let repairedChapterDrafts = repair.chapters;
  const postPatchMarkdown = composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages });
  const postPatchSectionGaps = collectSectionContentGaps(postPatchMarkdown, repairedChapterDrafts)
    .filter(gap => gap.planned || gap.reason === 'missing_planned_section' || gap.reason === 'empty' || gap.reason === 'table_only');
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
    for (let offset = 0; offset < repairedChapterDrafts.length; offset += generationStrategy.maxChapterConcurrency) {
      throwIfAborted(input.signal);
      const batch = repairedChapterDrafts.slice(offset, offset + generationStrategy.maxChapterConcurrency);
      const batchResults = await Promise.all(batch.map(async chapter => {
        const chapterGaps = postPatchSectionGaps.filter(gap => gap.chapterTitle === chapter.title);
        if (chapterGaps.length === 0) return chapter;
        const templateChapter = effectiveChapters.find(item => item.id === chapter.id || item.title === chapter.title) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections };
        const targetWords = documentBudget.chapterTargets.get(chapter.id) || 1200;
        const plan = chapterPlanFor(templateChapter, tenderPlan);
        const supplemented = await supplementShortSections({ template, chapter: templateChapter, content: chapter.content, evidence: chapter.evidence, missingFacts: chapter.missingFacts, promptTexts, projectContext, requirement: input.requirement, roleContext: buildRoleChapterContext(roleArtifacts, templateChapter, plan), targetWords, forbidDrawingImages, maxSectionConcurrency: generationStrategy.maxSectionConcurrency, forcedSections: chapterGaps, signal: input.signal });
        const sections = chapter.sections?.length ? chapter.sections : extractGeneratedSections(supplemented);
        return { ...chapter, content: supplemented, markdown: supplemented, sections };
      }));
      batchResults.forEach((chapter, index) => { patchedChapterDrafts[offset + index] = chapter; });
    }
    repairedChapterDrafts = patchedChapterDrafts;
    const remainingSectionIssues = sectionContentIntegrityIssues(composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }), repairedChapterDrafts);
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
    repairedChapterDrafts = await withProgressHeartbeat(() => expandDocumentToBudget({ template, chapters: repairedChapterDrafts, budget: documentBudget, promptTexts, requirement: input.requirement, forbidDrawingImages, signal: input.signal }), reviewedStages);
    const postRepairBudgetStatus = documentBudgetStatus(documentBudget, repairedChapterDrafts.map(chapter => chapter.content).join('\n\n'));
    upsertProgressStage(reviewedStages, displayStage({ type: 'validation', roleId: 'document-budget-repair', status: documentBudget.minChars && postRepairBudgetStatus.currentChars < documentBudget.minChars ? 'fallback' : 'success', message: elapsedMessage(`修复后预算补齐：当前 ${postRepairBudgetStatus.currentChars} 字，新增 ${Math.max(0, postRepairBudgetStatus.currentChars - postRepairBeforeChars)} 字，预计 ${postRepairBudgetStatus.estimatedPages} 页`, postRepairBudgetStartedAt) }, { subtitle: '修复后预算补齐' }));
  }
  const repairedMarkdown = composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages });
  let finalizedDocument = finalizeDocumentMarkdown(repairedMarkdown, repairedChapterDrafts, { forbidDrawingImages });
  let finalChapterDrafts = finalizedDocument.chapters;
  let finalMarkdown = finalizedDocument.markdown;
  const plannedFinalChapters = finalChapterDrafts.map(chapter => {
    const planned = repairedChapterDrafts.find(item => item.id === chapter.id || item.title === chapter.title);
    return { ...chapter, sections: planned?.sections || [] };
  });
  const finalSectionGaps = collectSectionContentGaps(finalMarkdown, plannedFinalChapters)
    .filter(gap => gap.planned || gap.reason === 'missing_planned_section' || gap.reason === 'empty' || gap.reason === 'table_only');
  if (finalSectionGaps.length > 0) {
    const finalSectionRepairStartedAt = Date.now();
    upsertProgressStage(reviewedStages, displayStage({ type: 'llm_review', roleId: 'final-section-content-repair', status: 'running', message: `最终结构化后补写残留空洞小节：${finalSectionGaps.length} 个问题`, details: finalSectionGaps.map(gap => gap.message), progress: { current: 1, total: finalSectionGaps.length, label: '最终小节补写' } }, { subtitle: '最终小节内容补写' }));
    emitProgress(finalChapterDrafts, reviewedStages);
    const repairedFinalChapters = [...finalChapterDrafts];
    for (let offset = 0; offset < finalChapterDrafts.length; offset += generationStrategy.maxChapterConcurrency) {
      throwIfAborted(input.signal);
      const batch = finalChapterDrafts.slice(offset, offset + generationStrategy.maxChapterConcurrency);
      const batchResults = await Promise.all(batch.map(async chapter => {
        const chapterGaps = finalSectionGaps.filter(gap => gap.chapterTitle === chapter.title);
        if (chapterGaps.length === 0) return chapter;
        const templateChapter = effectiveChapters.find(item => item.id === chapter.id || item.title === chapter.title) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections };
        const targetWords = documentBudget.chapterTargets.get(chapter.id) || 1200;
        const plan = chapterPlanFor(templateChapter, tenderPlan);
        const supplemented = await supplementShortSections({ template, chapter: templateChapter, content: chapter.content, evidence: chapter.evidence, missingFacts: chapter.missingFacts, promptTexts, projectContext, requirement: input.requirement, roleContext: buildRoleChapterContext(roleArtifacts, templateChapter, plan), targetWords, forbidDrawingImages, maxSectionConcurrency: generationStrategy.maxSectionConcurrency, forcedSections: chapterGaps, signal: input.signal });
        const sections = chapter.sections?.length ? chapter.sections : extractGeneratedSections(supplemented);
        return { ...chapter, content: supplemented, markdown: supplemented, sections };
      }));
      batchResults.forEach((chapter, index) => { repairedFinalChapters[offset + index] = chapter; });
    }
    finalizedDocument = finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: repairedFinalChapters, validationIssues, exportGate: base.exportGate, executionStages }), repairedFinalChapters, { forbidDrawingImages });
    finalChapterDrafts = finalizedDocument.chapters;
    finalMarkdown = finalizedDocument.markdown;
    const remainingFinalSectionIssues = sectionContentIntegrityIssues(finalMarkdown, finalChapterDrafts);
    upsertProgressStage(reviewedStages, displayStage({ type: 'llm_review', roleId: 'final-section-content-repair', status: remainingFinalSectionIssues.length > 0 ? 'fallback' : 'success', message: elapsedMessage(remainingFinalSectionIssues.length > 0 ? `最终补写后仍存在 ${remainingFinalSectionIssues.length} 个内容缺口` : '最终小节内容补写完成', finalSectionRepairStartedAt), details: remainingFinalSectionIssues.map(issue => issue.message) }, { subtitle: '最终小节内容补写' }));
    emitProgress(finalChapterDrafts, reviewedStages);
  }
  finalizedDocument = finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: finalChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }), finalChapterDrafts, { forbidDrawingImages });
  finalChapterDrafts = finalizedDocument.chapters;
  finalMarkdown = finalizedDocument.markdown;
  const preRepairWarningIssues = [...structureIssueMessages];
  validationIssues = applySpecGateRules(documentSpec, [...validationIssues, ...preRepairWarningIssues.map(message => ({ level: 'warning' as const, message }))], factsModel, finalChapterDrafts, finalMarkdown, fileBindings, promptBindings);
  validationIssues.push(...validateDraftWithAutoSpec({ markdown: finalMarkdown, spec: documentSpec, summary: projectMaterialSummary }));
  validationIssues.push(...validateFactConsistency({ markdown: finalMarkdown, facts: structuredFacts, summary: projectMaterialSummary }));
  validationIssues.push(...validateProjectContamination(finalMarkdown, projectMaterialSummary));
  validationIssues.push(...tocHierarchyIssues(finalMarkdown));
  validationIssues.push(...tocBodyConsistencyIssues(finalMarkdown));
  validationIssues.push(...formalContentIntegrityIssues(finalMarkdown));
  validationIssues.push(...sectionContentIntegrityIssues(finalMarkdown, finalChapterDrafts));
  validationIssues.push(...duplicateBasicInfoIssues(finalMarkdown));
  validationIssues.push(...formalStyleIssues(finalMarkdown));
  validationIssues.push(...tertiaryHeadingIssues(finalMarkdown));
  validationIssues.push(...minChapterSectionIssues(finalChapterDrafts));
  validationIssues.push(...preciseFactUsageIssues(finalMarkdown, factsModel));
  validationIssues.push(...formalPlaceholderIssues(finalMarkdown));
  validationIssues.push(...promptExampleLeakIssues(finalMarkdown, promptBindings));
  validationIssues.push(...degenerateContentIssues(finalMarkdown, finalChapterDrafts));
  validationIssues.push(...plannedAutoSpecGateIssues(finalMarkdown, template));
  const budgetIssues = documentBudgetIssues(documentBudget, finalChapterDrafts.map(chapter => chapter.content).join('\n\n'));
  const pageIssues = pageTargetIssues(template.generationSettings || template.exportSettings, finalMarkdown).filter(issue => !(documentBudget.minPages && /低于目标页数/u.test(issue.message)));
  validationIssues.push(...pageIssues);
  validationIssues.push(...budgetIssues);
  validationIssues.push(...plannedStructureIssues(finalMarkdown, template));
  const finalExportGate = buildExportGate(validationIssues, factsModel, finalChapterDrafts);
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
  generationDiagnostics.llm.currentLimit = getAdaptiveDocumentLlmLimit();
  const slowMetrics = slowMetricSummary(generationDiagnostics.metrics);
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-diagnostics', status: 'success', message: `性能统计：LLM ${generationDiagnostics.llm.calls} 次，失败 ${generationDiagnostics.llm.failures} 次，排队 ${generationDiagnostics.llm.throttledWaits} 次/${Math.round(generationDiagnostics.llm.throttledWaitMs / 1000)} 秒，检索 ${generationDiagnostics.evidence.searchQueries} 次/${Math.round(generationDiagnostics.evidence.searchMs / 1000)} 秒，证据上下文 ${generationDiagnostics.evidence.contextChars} 字，噪声过滤 ${generationDiagnostics.evidence.filteredNoise} 条，质量问题 阻断${generationDiagnostics.quality.blockingCount}/重要${generationDiagnostics.quality.importantCount}/轻微${generationDiagnostics.quality.minorCount}，自动限流调整 ${generationDiagnostics.llm.limitAdjustments} 次${slowMetrics ? `，Top耗时：${slowMetrics}` : ''}` }, { subtitle: '后台诊断' }));
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
    reviewMetadata: { chapterSummaries: chapterReviewSummaries, globalIssues: globalReview.issues, diagnostics: generationDiagnostics },
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
  const boundFilePaths = buildBoundEvidenceScope(projectRoot, templateFileBindings(template));
  const project = await manager.getProject(projectRoot);
  const requestedEvidencePerChapter = resolveDocumentGenerationEvidenceLimit(project, [...boundFilePaths], input.maxEvidencePerChapter);
  const rawEvidence: DocumentEvidence[] = [];
  const scopedFilePaths = [...boundFilePaths].filter(Boolean).sort();
  const maxSearchQueries = Math.max(2, Math.min(8, Math.floor(Number(process.env.DOCUMENT_MAX_QUERIES_PER_CHAPTER ?? 6))));
  for (const query of chapter.queries.slice(0, maxSearchQueries)) {
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
        sectionTitle: item.sectionTitle,
        source: item.source,
      })));
  }
  const scopedEvidence = rawEvidence.filter(item => evidenceInScope(projectRoot, item.filePath, boundFilePaths));
  const evidence = selectEvidenceByBudget(scopedEvidence, { maxItems: Math.max(8, Math.min(28, requestedEvidencePerChapter * 2)), maxChars: 18000, preservePinned: true });
  const existingContext = input.currentMarkdown || '';
  const existingFactSet = new Set(input.existingFacts ?? []);
  const missingFacts = chapter.requiredFacts.filter(fact => !existingFactSet.has(fact) && !evidence.some(item => evidenceMatchesFact(item, fact)));
  const content = [
    `## ${chapter.title}`,
    '',
    input.requirement ? `> 生成要求：${input.requirement}` : '',
    existingContext ? `> 当前文档上下文摘要：${existingContext.replace(/\s+/gu, ' ')}` : '',
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
