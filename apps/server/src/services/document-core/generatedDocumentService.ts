import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DocumentDraftChapter, GeneratedDocumentDraft, DocumentAsset } from '../document-workflow/types';
import { generateDocumentDraft, getDocumentTemplate } from '../document-workflow';
import { collectSectionContentGaps } from '../document-workflow/qualityValidation';
import { DOCUMENT_WORKFLOW_VERSION } from '../document-workflow/documentWorkflowVersion';
import { computeProjectId } from '@customize-agent/knowledge';
import { getProjectRoot } from '../knowledge/kbService';
import { documentTextLength } from '../document-workflow/budget';
import { upsertKbOperation } from '../knowledge/kbOperationLog';

export type GeneratedDocumentStatus = 'generating' | 'completed' | 'warning' | 'failed' | 'aborted';

export interface GeneratedDocumentListItem {
  id: string;
  taskId?: string;
  templateId: string;
  templateName?: string;
  templateVersion?: number;
  title: string;
  requirement: string;
  projectRoot?: string;
  projectId?: string;
  knowledgeBasePath?: string;
  status: GeneratedDocumentStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  elapsedMs?: number;
  error?: string;
  warningIssues?: string[];
  warningCount?: number;
  blockerCount?: number;
  suggestionCount?: number;
  wordCount?: number;
  chapterCount?: number;
  completedChapterCount?: number;
  latestStage?: string;
  latestMessage?: string;
  assets?: DocumentAsset[];
  partialChapters?: GeneratedDocumentDraft['partialChapters'];
}

export interface GeneratedDocumentRecord {
  id: string;
  taskId?: string;
  templateId: string;
  templateName?: string;
  templateVersion?: number;
  title: string;
  requirement: string;
  projectRoot?: string;
  projectId?: string;
  knowledgeBasePath?: string;
  markdown: string;
  editedMarkdown?: string;
  wordCount?: number;
  status: GeneratedDocumentStatus;
  draft?: GeneratedDocumentDraft;
  executionStages?: GeneratedDocumentDraft['executionStages'];
  partialChapters?: GeneratedDocumentDraft['partialChapters'];
  checkpointChapters?: DocumentDraftChapter[];
  reviewMetadata?: GeneratedDocumentDraft['reviewMetadata'];
  promptProvenance?: GeneratedDocumentDraft['promptProvenance'];
  agentWorkflow?: GeneratedDocumentDraft['agentWorkflow'];
  assets: DocumentAsset[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  warningIssues?: string[];
  maxEvidencePerChapter?: number;
}

function failRunningStages(stages: GeneratedDocumentRecord['executionStages'], message: string): GeneratedDocumentRecord['executionStages'] {
  return stages?.map(stage => stage.status === 'running' ? { ...stage, status: 'failed' as const, message } : stage);
}

function isAbortError(error: unknown) {
  return error instanceof Error && /用户中止|aborted|abort/i.test(error.message);
}

function fallbackFailedTitle(record: Pick<GeneratedDocumentRecord, 'title' | 'templateName'>) {
  return record.title && record.title !== '生成中' ? record.title : `${record.templateName || '文档'}生成失败`;
}

function mergeDraftChapters(...sources: Array<DocumentDraftChapter[] | undefined>): DocumentDraftChapter[] {
  const chapters = new Map<string, DocumentDraftChapter>();
  for (const source of sources) {
    for (const chapter of source || []) {
      if (chapter.id && chapter.content?.trim()) chapters.set(chapter.id, chapter);
    }
  }
  return [...chapters.values()];
}

function reusableCheckpointChapters(existing: GeneratedDocumentRecord | null, input: { templateId: string; requirement?: string }, projectRoot: string): DocumentDraftChapter[] {
  if (!existing) return [];
  const template = getDocumentTemplate(input.templateId);
  const workflowVersion = existing.reviewMetadata?.workflowVersion?.version || existing.draft?.reviewMetadata?.workflowVersion?.version;
  const exportGatePassed = existing.draft?.exportGate?.passed === true;
  const sameTemplate = existing.templateId === input.templateId && (!template || !existing.templateVersion || existing.templateVersion === template.version);
  const sameProject = existing.projectRoot === projectRoot && existing.projectId === computeProjectId(projectRoot);
  const sameRequirement = (existing.requirement || '') === (input.requirement || '');
  if (!sameTemplate || !sameProject || !sameRequirement || workflowVersion !== DOCUMENT_WORKFLOW_VERSION.version || !exportGatePassed) return [];
  const passingIds = new Set((existing.draft?.partialChapters || existing.partialChapters || []).filter(chapter => chapter.status === 'completed').map(chapter => chapter.id));
  return mergeDraftChapters(existing.draft?.chapters, existing.checkpointChapters).filter(chapter =>
    passingIds.has(chapter.id) &&
    Boolean(chapter.content?.trim()) &&
    !/WRITER_MISSING_SECTION|Writer 未完成/u.test(chapter.content)
  );
}

function summarizeCheckpointChapters(chapters: DocumentDraftChapter[] | undefined): GeneratedDocumentDraft['partialChapters'] {
  return (chapters || []).map(chapter => ({
    id: chapter.id,
    title: chapter.title,
    chars: documentTextLength(chapter.content),
    status: chapter.content.trim().length > 0 ? 'completed' as const : 'failed' as const,
    updatedAt: Date.now(),
    timedOut: chapter.timedOut,
    elapsedMs: chapter.elapsedMs,
  }));
}

export interface GeneratedAssetRecord extends DocumentAsset {
  name: string;
  source: 'knowledge_base' | 'generated' | 'uploaded' | 'external_url';
  indexed: boolean;
  usedByDocumentIds: string[];
  createdAt: number;
  updatedAt: number;
}

interface GenerateTask {
  id: string;
  documentId: string;
  status: GeneratedDocumentStatus;
  controller: AbortController;
  promise: Promise<GeneratedDocumentRecord>;
  startedAt: number;
  lastProgressAt: number;
}

const tasks = new Map<string, GenerateTask>();
const ABANDONED_RECORD_STALE_MS = Math.max(60 * 60_000, Number(process.env.DOCUMENT_ABANDONED_RECORD_STALE_MS ?? 24 * 60 * 60_000));

function generatedProjectId(projectRoot = getProjectRoot()) {
  return computeProjectId(path.resolve(projectRoot));
}

export function generatedRoot(projectRoot = getProjectRoot()) {
  const root = path.join(os.homedir(), '.customize-agent', 'projects', generatedProjectId(projectRoot), 'generatedDocuments');
  fs.mkdirSync(path.join(root, 'drafts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  return root;
}

function indexPath(projectRoot = getProjectRoot()) { return path.join(generatedRoot(projectRoot), 'index.json'); }
function assetsPath(projectRoot = getProjectRoot()) { return path.join(generatedRoot(projectRoot), 'assets.json'); }
function draftPath(id: string, projectRoot = getProjectRoot()) { return path.join(generatedRoot(projectRoot), 'drafts', `${id}.json`); }
export function generatedAssetAbsolutePath(asset: Pick<GeneratedAssetRecord, 'path'>, projectRoot = getProjectRoot()) {
  if (!asset.path) return null;
  if (path.isAbsolute(asset.path)) return asset.path;
  if (asset.path.startsWith('generatedDocuments/assets/')) return path.join(generatedRoot(projectRoot), asset.path.replace(/^generatedDocuments\/assets\//u, 'assets/'));
  return path.join(projectRoot, 'knowledgeBase', asset.path);
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getActiveTaskByDocumentId(documentId: string) {
  for (const task of tasks.values()) if (task.documentId === documentId) return task;
  return null;
}

function markStaleGeneratingRecord(record: GeneratedDocumentRecord, projectRoot = getProjectRoot()) {
  if (record.status !== 'generating' || getActiveTaskByDocumentId(record.id)) return record;
  if (Date.now() - record.updatedAt < ABANDONED_RECORD_STALE_MS) return record;
  const message = '生成任务已中断，请点击继续生成或重新生成';
  const status: GeneratedDocumentStatus = record.checkpointChapters?.length ? 'warning' : 'failed';
  const next = {
    ...record,
    title: fallbackFailedTitle(record),
    status,
    error: record.error || message,
    executionStages: failRunningStages(record.executionStages, message),
    completedAt: Date.now(),
    warningIssues: record.checkpointChapters?.length ? [...(record.warningIssues || []), message] : record.warningIssues,
  };
  if (record.taskId) {
    upsertDocumentOperation(projectRoot, {
      taskId: record.taskId,
      title: `生成 ${next.title}`,
      status: status === 'warning' ? 'warning' : 'error',
      percent: 100,
      message,
      stages: next.executionStages,
      error: message,
    });
  }
  return next;
}

export function listGeneratedDocuments(projectRoot = getProjectRoot()) {
  return readJson<GeneratedDocumentListItem[]>(indexPath(projectRoot), [])
    .map(item => {
      if (item.status !== 'generating') return item;
      const fullRecord = readJson<GeneratedDocumentRecord | null>(draftPath(item.id, projectRoot), null);
      if (!fullRecord) return item;
      const next = markStaleGeneratingRecord(fullRecord, projectRoot);
      if (next !== fullRecord) return toGeneratedDocumentListItem(saveGeneratedDocument(next, projectRoot, { preserveUpdatedAt: true }));
      return toGeneratedDocumentListItem(fullRecord);
    })
    .sort((a, b) => (b.createdAt || b.updatedAt) - (a.createdAt || a.updatedAt));
}

export function getGeneratedDocument(id: string, projectRoot = getProjectRoot()) {
  const record = readJson<GeneratedDocumentRecord | null>(draftPath(id, projectRoot), null);
  if (!record) return null;
  const next = markStaleGeneratingRecord(record, projectRoot);
  const saved = next !== record ? saveGeneratedDocument(next, projectRoot, { preserveUpdatedAt: true }) : next;
  return ensureGeneratedDocumentAsset(saved, projectRoot);
}

export function saveGeneratedDocument(record: GeneratedDocumentRecord, projectRoot = getProjectRoot(), options?: { preserveUpdatedAt?: boolean }) {
  const now = Date.now();
  const next = trimEvidenceContent({ ...record, updatedAt: options?.preserveUpdatedAt ? record.updatedAt : now });
  writeJson(draftPath(next.id, projectRoot), next);
  const list = readJson<GeneratedDocumentListItem[]>(indexPath(projectRoot), []).filter(item => item.id !== next.id);
  list.unshift(toGeneratedDocumentListItem(next));
  writeJson(indexPath(projectRoot), list);
  return next;
}

export function updateGeneratedDocument(id: string, patch: Partial<GeneratedDocumentRecord>, projectRoot = getProjectRoot()) {
  const current = getGeneratedDocument(id, projectRoot);
  if (!current) return null;
  return saveGeneratedDocument({ ...current, ...patch, id }, projectRoot);
}

export function abortGeneratedDocument(id: string, projectRoot = getProjectRoot()) {
  const current = getGeneratedDocument(id, projectRoot);
  if (!current) return null;
  if (current.status !== 'generating') return current;
  for (const [key, task] of tasks) {
    if (task.documentId === id) {
      task.status = 'aborted';
      task.controller.abort();
      tasks.delete(key);
    }
  }
  const message = '用户中止';
  const executionStages = failRunningStages(current.executionStages, message);
  const record = saveGeneratedDocument({ ...current, status: 'aborted', error: message, executionStages, completedAt: Date.now() }, projectRoot);
  if (record.taskId) {
    upsertDocumentOperation(projectRoot, { taskId: record.taskId, title: `生成 ${record.title}`, status: 'warning', percent: 100, message, stages: executionStages, error: message });
  }
  return record;
}

export function deleteGeneratedDocument(id: string, projectRoot = getProjectRoot()) {
  try {
    fs.rmSync(draftPath(id, projectRoot), { force: true });
  } catch {
    console.warn('[generated-documents] 删除文档记录失败或文件不存在', id);
  }
  const list = readJson<GeneratedDocumentListItem[]>(indexPath(projectRoot), []).filter(item => item.id !== id);
  writeJson(indexPath(projectRoot), list);
}

export function listGeneratedAssets(projectRoot = getProjectRoot()) {
  return readJson<GeneratedAssetRecord[]>(assetsPath(projectRoot), []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function upsertGeneratedAssets(assets: DocumentAsset[], documentId: string, projectRoot = getProjectRoot()) {
  const now = Date.now();
  const existing = listGeneratedAssets(projectRoot);
  const next = [...existing];
  for (const asset of assets) {
    const index = next.findIndex(item => item.id === asset.id);
    const source: GeneratedAssetRecord['source'] = asset.path?.startsWith('generatedDocuments/assets/') || asset.status === 'generated' || asset.status === 'prompt_ready' ? 'generated' : 'knowledge_base';
    const record: GeneratedAssetRecord = {
      ...asset,
      name: path.basename(asset.path || asset.url || asset.id),
      source,
      indexed: index >= 0 ? next[index]!.indexed : false,
      usedByDocumentIds: index >= 0 ? [...new Set([...next[index]!.usedByDocumentIds, documentId])] : [documentId],
      createdAt: index >= 0 ? next[index]!.createdAt : now,
      updatedAt: now,
    };
    if (index >= 0) next[index] = { ...next[index], ...record };
    else next.push(record);
  }
  writeJson(assetsPath(projectRoot), next);
  return next;
}

function generatedDocumentAssetPath(record: Pick<GeneratedDocumentRecord, 'id' | 'title'>) {
  return `generatedDocuments/assets/${safeKnowledgeFileName(record.title)}-${record.id}.md`;
}

export function upsertGeneratedDocumentAsset(record: GeneratedDocumentRecord, projectRoot = getProjectRoot()) {
  const markdown = record.editedMarkdown || record.markdown;
  if (!markdown?.trim()) return null;
  const relativePath = generatedDocumentAssetPath(record);
  const absolutePath = path.join(generatedRoot(projectRoot), relativePath.replace(/^generatedDocuments\//u, ''));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, markdown, 'utf8');
  const asset: DocumentAsset = {
    id: `document-${record.id}`,
    type: 'file',
    role: 'generated',
    path: relativePath,
    status: 'generated',
    message: '模板运行生成的 Markdown 文档，仅登记到生成资源，不进入知识库',
  };
  return upsertGeneratedAssets([asset], record.id, projectRoot).find(item => item.id === asset.id) || null;
}

function ensureGeneratedDocumentAsset(record: GeneratedDocumentRecord, projectRoot = getProjectRoot()) {
  if (record.status === 'generating' || !(record.editedMarkdown || record.markdown)?.trim()) return record;
  const assetId = `document-${record.id}`;
  if (record.assets?.some(asset => asset.id === assetId && asset.path)) return record;
  const asset = upsertGeneratedDocumentAsset(record, projectRoot);
  if (!asset) return record;
  return saveGeneratedDocument({ ...record, assets: [asset, ...(record.assets || []).filter(item => item.id !== asset.id)] }, projectRoot);
}

export function getGeneratedAsset(id: string, projectRoot = getProjectRoot()) {
  return listGeneratedAssets(projectRoot).find(asset => asset.id === id) || null;
}

export function deleteGeneratedAsset(id: string, projectRoot = getProjectRoot()) {
  const asset = getGeneratedAsset(id, projectRoot);
  if (!asset) return false;
  const absolutePath = generatedAssetAbsolutePath(asset, projectRoot);
  if (absolutePath && absolutePath.startsWith(generatedRoot(projectRoot))) {
    try {
      fs.rmSync(absolutePath, { force: true });
    } catch {
      console.warn('[generated-documents] 删除生成资源文件失败或文件不存在', absolutePath);
    }
  }
  writeJson(assetsPath(projectRoot), listGeneratedAssets(projectRoot).filter(item => item.id !== id));
  return true;
}

function safeKnowledgeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|]/gu, '_').slice(0, 120) || 'generated-document';
}

export function openGeneratedAssetTarget(id: string, target: 'file' | 'directory', projectRoot = getProjectRoot()) {
  const asset = getGeneratedAsset(id, projectRoot);
  if (!asset) return null;
  const absolutePath = generatedAssetAbsolutePath(asset, projectRoot);
  if (!absolutePath || !fs.existsSync(absolutePath)) return null;
  return target === 'directory' ? path.dirname(absolutePath) : absolutePath;
}

function trimChapterEvidence(chapter: DocumentDraftChapter): DocumentDraftChapter {
  const maxItems = Math.max(4, Math.floor(Number(process.env.DOCUMENT_PERSIST_EVIDENCE_MAX_ITEMS ?? 10)));
  const maxChars = Math.max(300, Math.floor(Number(process.env.DOCUMENT_PERSIST_EVIDENCE_ITEM_CHARS ?? 900)));
  return {
    ...chapter,
    evidence: (chapter.evidence || []).slice(0, maxItems).map(item => ({
      ...item,
      content: typeof item.content === 'string' ? item.content.replace(/\s+/gu, ' ').slice(0, maxChars) : '',
    })),
  };
}

function toGeneratedDocumentListItem(record: GeneratedDocumentRecord): GeneratedDocumentListItem {
  const stages = record.executionStages || record.draft?.executionStages || [];
  const latestStage = [...stages].reverse().find(stage => stage.message || stage.subtitle || stage.roleId);
  const chapters = record.partialChapters || summarizeCheckpointChapters(record.checkpointChapters || record.draft?.checkpointChapters || record.draft?.chapters);
  const validationIssues = record.draft?.validationIssues || [];
  const blockerCount = record.draft?.exportGate
    ? (record.draft.exportGate.blockingIssues?.length ?? 0)
    : validationIssues.filter(issue => issue.severity === 'blocker' || issue.level === 'error').length;
  const warningCount = validationIssues.filter(issue => issue.severity === 'warning' || issue.level === 'warning').length || record.warningIssues?.length || 0;
  const suggestionCount = validationIssues.filter(issue => issue.severity === 'suggestion' || issue.level === 'info').length;
  return {
    id: record.id,
    taskId: record.taskId,
    templateId: record.templateId,
    templateName: record.templateName,
    templateVersion: record.templateVersion,
    title: record.title,
    requirement: record.requirement,
    projectRoot: record.projectRoot,
    projectId: record.projectId,
    knowledgeBasePath: record.knowledgeBasePath,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    elapsedMs: record.completedAt ? record.completedAt - record.createdAt : record.updatedAt - record.createdAt,
    error: record.error,
    warningIssues: (record.warningIssues || []).slice(0, 12),
    warningCount,
    blockerCount,
    suggestionCount,
    wordCount: documentTextLength(record.editedMarkdown || record.markdown || record.draft?.markdown || ''),
    chapterCount: chapters?.length || record.draft?.chapters?.length || 0,
    completedChapterCount: (chapters || []).filter(chapter => chapter.status === 'completed').length,
    latestStage: latestStage?.subtitle || latestStage?.roleName || latestStage?.roleId,
    latestMessage: latestStage?.message,
    assets: (record.assets || []).slice(0, 8),
    partialChapters: chapters,
  };
}

function trimEvidenceContent<T extends GeneratedDocumentRecord>(record: T): T {
  const draft = record.draft ? {
    ...record.draft,
    chapters: record.draft.chapters?.map(trimChapterEvidence),
    checkpointChapters: record.draft.checkpointChapters?.map(trimChapterEvidence),
  } : record.draft;
  return {
    ...record,
    draft,
    checkpointChapters: record.checkpointChapters?.map(trimChapterEvidence),
  };
}

function failGeneratingDocument(documentId: string, projectRoot: string, message: string) {
  const current = getGeneratedDocument(documentId, projectRoot);
  if (!current || current.status !== 'generating') return current;
  return saveGeneratedDocument({ ...current, title: fallbackFailedTitle(current), status: 'failed', error: message, executionStages: failRunningStages(current.executionStages, message), completedAt: Date.now() }, projectRoot);
}

function activeTaskResponse(task: GenerateTask, projectRoot: string) {
  const record = getGeneratedDocument(task.documentId, projectRoot);
  if (!record || record.status !== 'generating') return null;
  return { taskId: task.id, documentId: task.documentId, record };
}

function documentOperationDetails(stages: GeneratedDocumentRecord['executionStages'] | undefined) {
  const important = (stages || []).filter(stage =>
    stage.type === 'role_binding' ||
    stage.roleId === 'runtime-prompt-rules' ||
    stage.roleId === 'document-readiness' ||
    stage.type === 'export_ready' ||
    stage.status === 'failed',
  );
  return important.flatMap(stage => [
    `${stage.subtitle || stage.roleName || stage.roleId}：${stage.message || stage.status}`,
    ...(stage.details || []).slice(0, 8).map(detail => `  - ${detail}`),
  ]).slice(0, 80);
}

function upsertDocumentOperation(projectRoot: string, input: { taskId: string; title: string; status: 'processing' | 'success' | 'warning' | 'error'; percent: number; message: string; stages?: GeneratedDocumentRecord['executionStages']; error?: string }) {
  upsertKbOperation(projectRoot, {
    id: input.taskId,
    type: 'document',
    title: input.title,
    stage: input.status === 'processing' ? 'generating' : input.status === 'error' ? 'error' : 'done',
    status: input.status,
    percent: input.percent,
    message: input.message,
    error: input.error,
    details: documentOperationDetails(input.stages),
  });
}

/** 启动异步文档生成任务，包含进度回调持久化、结果入库、资源管理，返回任务 ID 和文档 ID */
export function startGenerateDocumentTask(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number; resumeDocumentId?: string }, projectRoot = getProjectRoot()) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const currentProjectId = computeProjectId(resolvedProjectRoot);
  const now = Date.now();
  const existing = input.resumeDocumentId ? getGeneratedDocument(input.resumeDocumentId, resolvedProjectRoot) : null;
  if (existing) {
    const active = getActiveTaskByDocumentId(existing.id);
    const activeResponse = active ? activeTaskResponse(active, resolvedProjectRoot) : null;
    if (activeResponse) return activeResponse;
  }
  if (!existing) {
    for (const task of tasks.values()) {
      const active = activeTaskResponse(task, resolvedProjectRoot);
      if (active && active.record.templateId === input.templateId && active.record.projectRoot === resolvedProjectRoot) return active;
    }
  }
  const documentId = existing?.id || `doc-${now}-${crypto.randomBytes(4).toString('hex')}`;
  const taskId = `task-${now}-${crypto.randomBytes(4).toString('hex')}`;
  const initial: GeneratedDocumentRecord = existing ? {
    ...existing,
    taskId,
    status: 'generating',
    error: undefined,
    completedAt: undefined,
    executionStages: [{ type: 'validation', roleId: 'resume-generation', status: 'running', message: '已重新进入生成流程；仅复用通过当前工作流版本、项目、模板、需求和导出门禁校验的章节，其余章节重新生成' }],
    partialChapters: undefined,
    checkpointChapters: undefined,
    draft: undefined,
    warningIssues: undefined,
    updatedAt: now,
  } : {
    id: documentId,
    taskId,
    templateId: input.templateId,
    templateVersion: getDocumentTemplate(input.templateId)?.version,
    title: '生成中',
    requirement: input.requirement || '',
    maxEvidencePerChapter: input.maxEvidencePerChapter,
    projectRoot: resolvedProjectRoot,
    projectId: currentProjectId,
    knowledgeBasePath: path.join(resolvedProjectRoot, 'knowledgeBase'),
    markdown: '',
    status: 'generating',
    assets: [],
    createdAt: now,
    updatedAt: now,
  };
  saveGeneratedDocument(initial, resolvedProjectRoot);
  upsertDocumentOperation(resolvedProjectRoot, { taskId, title: `生成 ${initial.title}`, status: 'processing', percent: 1, message: '文档生成任务已进入后台队列', stages: initial.executionStages });
  const controller = new AbortController();
  const taskRef: { current?: GenerateTask } = {};
  const resumeChapters = reusableCheckpointChapters(existing, input, resolvedProjectRoot);
  let lastProgressSaveAt = 0;
  let lastProgressSignature = '';
  const minProgressSaveInterval = Math.max(1_000, Math.min(15_000, Number(process.env.DOCUMENT_PROGRESS_SAVE_INTERVAL_MS ?? 5_000)));
  const promise = generateDocumentDraft({ ...input, projectRoot: resolvedProjectRoot, resumeChapters, signal: controller.signal, onProgress: (stages, checkpoint) => {
    try {
      if (taskRef.current) taskRef.current.lastProgressAt = Date.now();
      const nowProgress = Date.now();
      const signature = JSON.stringify({
        stages: stages.map(stage => ({ type: stage.type, roleId: stage.roleId, status: stage.status, message: stage.message, progress: stage.progress })),
        checkpoint: checkpoint?.chapters?.map(chapter => [chapter.id, chapter.content.length, chapter.sections?.length || 0]) || [],
      });
      if (!checkpoint?.chapters && signature === lastProgressSignature && nowProgress - lastProgressSaveAt < minProgressSaveInterval) return;
      const current = getGeneratedDocument(documentId, resolvedProjectRoot);
      if (current && current.status === 'generating') {
        const checkpointChapters = checkpoint?.chapters ? mergeDraftChapters(current.checkpointChapters, checkpoint.chapters).map(trimChapterEvidence) : current.checkpointChapters;
        const checkpointMarkdown = checkpointChapters?.length ? checkpointChapters.map(chapter => `# ${chapter.title}\n\n${chapter.content}`).join('\n\n') : current.markdown;
        const saved = saveGeneratedDocument(trimEvidenceContent({
          ...current,
          executionStages: stages,
          checkpointChapters,
          partialChapters: checkpoint?.chapters ? summarizeCheckpointChapters(checkpointChapters) : current.partialChapters,
          markdown: checkpointMarkdown,
          wordCount: checkpointMarkdown ? documentTextLength(checkpointMarkdown) : current.wordCount,
        }), resolvedProjectRoot);
        const latestStage = [...stages].reverse().find(stage => stage.status === 'running') || stages[stages.length - 1];
        upsertDocumentOperation(resolvedProjectRoot, { taskId, title: `生成 ${saved.templateName || saved.title}`, status: 'processing', percent: Math.max(1, Math.min(99, latestStage?.progress ? Math.round((latestStage.progress.current / Math.max(1, latestStage.progress.total)) * 90) : 30)), message: latestStage?.message || '文档生成中', stages });
        lastProgressSaveAt = nowProgress;
        lastProgressSignature = signature;
        console.log(`[gen] progress saved: ${stages.length} stages, checkpoint=${checkpointChapters?.length || 0}, doc=${documentId}`);
      }
    } catch (err) { console.error('[gen] progress save error:', err); }
  } }).then(async result => {
    if (taskRef.current) {
      taskRef.current.lastProgressAt = Date.now();
    }
    const current = getGeneratedDocument(documentId, resolvedProjectRoot);
    if (!current || current.status !== 'generating') return current ?? initial;
    const hiddenDiagnosticRe = /结构化事实读取不足|正文可能未显式覆盖|仅包含文件类型和占位符|不在本次招标范围内|知识库文件索引失败|暂无可检索内容切片|未抽取到结构化事实|兜底片段|资料抽取诊断|无法直接读取文本内容|占位符|缺乏详细的.*具体尺寸|需结合原文件进一步深化|章节生成存在兜底/u;
    const markdown = result.markdown || '';
    const hasIllegalH2 = /^##\s+(?!目录$)(?!第[一二三四五六七八九十百千万\d]+章\s+)/gmu.test(markdown);
    const hasPageRefs = /(?:第?\d+页|P\.?\s*\d+)/iu.test(markdown);
    const hasForbiddenParty = /施工方/u.test(markdown);
    const warningIssues = result.validationIssues
      .filter(issue => issue.level === 'error' || issue.level === 'warning')
      .map(issue => issue.suggestion ? `${issue.message}：${issue.suggestion}` : issue.message)
      .filter(message => !/^\s*[[{]/u.test(message) && !/"status"\s*:/u.test(message) && !hiddenDiagnosticRe.test(message))
      .filter(message => !/正文存在非正式章二级标题/u.test(message) || hasIllegalH2)
      .filter(message => !/资料页码|文件页码|页码引用/u.test(message) || hasPageRefs)
      .filter(message => !/禁止内容|施工方/u.test(message) || hasForbiddenParty)
      .filter(message => result.exportGate.passed ? !/目录与正文不一致|表格分隔线位置不规范/u.test(message) : true);
    const sectionGaps = collectSectionContentGaps(result.markdown, result.chapters).filter(gap => gap.reason === 'empty');
    if (sectionGaps.length > 0) warningIssues.unshift(`小节内容补写未完成：仍有 ${sectionGaps.length} 个空洞小节，请继续生成或补充资料后重试`);
    if (!result.exportGate.passed && warningIssues.length === 0) warningIssues.push('导出门禁未通过：存在未完成的硬阻断检查项');
    const completedBase = trimEvidenceContent({
      ...current,
      templateName: result.templateName,
      templateVersion: result.templateVersion ?? current.templateVersion,
      title: result.title,
      markdown: result.markdown,
      status: result.exportGate.passed ? 'completed' as const : 'failed' as const,
      draft: result,
      executionStages: result.executionStages,
      partialChapters: result.partialChapters,
      checkpointChapters: result.chapters,
      reviewMetadata: result.reviewMetadata,
      promptProvenance: result.promptProvenance ?? current.promptProvenance,
      agentWorkflow: result.agentWorkflow,
      assets: result.assets || [],
      completedAt: Date.now(),
      warningIssues,
    });
    const generatedAsset = upsertGeneratedDocumentAsset(completedBase, resolvedProjectRoot);
    const record = saveGeneratedDocument({
      ...completedBase,
      assets: generatedAsset ? [generatedAsset, ...(completedBase.assets || []).filter(asset => asset.id !== generatedAsset.id)] : completedBase.assets,
    }, resolvedProjectRoot);
    upsertGeneratedAssets(result.assets || [], documentId, resolvedProjectRoot);
    upsertDocumentOperation(resolvedProjectRoot, { taskId, title: `生成 ${record.title}`, status: record.status === 'completed' ? 'success' : 'error', percent: 100, message: record.status === 'completed' ? '文档生成完成，已通过导出门禁' : `文档生成未通过导出门禁，存在 ${warningIssues.length || 1} 个阻断问题`, stages: result.executionStages, error: record.status === 'completed' ? undefined : warningIssues.join('；') });
    return record;
  }).catch(error => {
    const current = getGeneratedDocument(documentId, resolvedProjectRoot);
    if (!current || current.status !== 'generating') return current ?? initial;
    const message = error instanceof Error ? error.message : String(error);
    const status: GeneratedDocumentStatus = isAbortError(error) ? 'aborted' : current.checkpointChapters?.length ? 'warning' : 'failed';
    const markdown = current.markdown || current.checkpointChapters?.map(chapter => `# ${chapter.title}\n\n${chapter.content}`).join('\n\n') || '';
    const failedStages = failRunningStages(current.executionStages, message);
    const record = saveGeneratedDocument(trimEvidenceContent({
      ...current,
      title: status === 'failed' ? fallbackFailedTitle(current) : current.title && current.title !== '生成中' ? current.title : `${current.templateName || '文档'}生成未完成`,
      status,
      error: message,
      markdown,
      executionStages: failedStages,
      completedAt: Date.now(),
      warningIssues: status === 'warning' ? [...(current.warningIssues || []), message] : current.warningIssues,
    }), resolvedProjectRoot);
    upsertDocumentOperation(resolvedProjectRoot, { taskId, title: `生成 ${record.title}`, status: status === 'warning' ? 'warning' : 'error', percent: 100, message, stages: failedStages, error: message });
    return record;
  }).finally(() => {
    tasks.delete(taskId);
  });
  const task: GenerateTask = { id: taskId, documentId, status: 'generating', controller, promise, startedAt: now, lastProgressAt: now };
  taskRef.current = task;
  tasks.set(taskId, task);
  return { taskId, documentId, record: initial };
}

export function getGenerateTask(taskId: string) {
  return tasks.get(taskId) || null;
}
