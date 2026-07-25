import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DocumentDraftChapter, GeneratedDocumentDraft, DocumentAsset } from '../document-workflow/types';
import { generateDocumentDraft } from '../document-workflow';
import { computeProjectId } from '@customize-agent/knowledge';
import { getProjectRoot } from '../knowledge/kbService';

export type GeneratedDocumentStatus = 'generating' | 'completed' | 'warning' | 'failed' | 'aborted';

export interface GeneratedDocumentRecord {
  id: string;
  taskId?: string;
  templateId: string;
  templateName?: string;
  title: string;
  requirement: string;
  projectRoot?: string;
  projectId?: string;
  knowledgeBasePath?: string;
  markdown: string;
  editedMarkdown?: string;
  status: GeneratedDocumentStatus;
  draft?: GeneratedDocumentDraft;
  executionStages?: GeneratedDocumentDraft['executionStages'];
  partialChapters?: GeneratedDocumentDraft['partialChapters'];
  checkpointChapters?: DocumentDraftChapter[];
  reviewMetadata?: GeneratedDocumentDraft['reviewMetadata'];
  assets: DocumentAsset[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  warningIssues?: string[];
}

function failRunningStages(stages: GeneratedDocumentRecord['executionStages'], message: string): GeneratedDocumentRecord['executionStages'] {
  return stages?.map(stage => stage.status === 'running' ? { ...stage, status: 'failed' as const, message } : stage);
}

function isAbortError(error: unknown) {
  return error instanceof Error && /用户中止|aborted|abort/i.test(error.message);
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

function summarizeCheckpointChapters(chapters: DocumentDraftChapter[] | undefined): GeneratedDocumentDraft['partialChapters'] {
  return (chapters || []).map(chapter => ({
    id: chapter.id,
    title: chapter.title,
    chars: chapter.content.length,
    status: chapter.content.trim().length > 0 ? 'completed' as const : 'failed' as const,
    updatedAt: Date.now(),
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
  timeoutTimer?: NodeJS.Timeout;
  progressTimer?: NodeJS.Timeout;
}

const tasks = new Map<string, GenerateTask>();
const DOCUMENT_TASK_TIMEOUT_MS = Math.max(10 * 60_000, Number(process.env.DOCUMENT_TASK_TIMEOUT_MS ?? 120 * 60_000));
const DOCUMENT_TASK_STALE_MS = Math.max(60_000, Number(process.env.DOCUMENT_TASK_STALE_MS ?? 5 * 60_000));
const DOCUMENT_TASK_NO_PROGRESS_MS = Math.max(5 * 60_000, Number(process.env.DOCUMENT_TASK_NO_PROGRESS_MS ?? 15 * 60_000));

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
  if (record.status !== 'generating') return record;
  if (getActiveTaskByDocumentId(record.id)) return record;
  if (Date.now() - record.updatedAt < DOCUMENT_TASK_STALE_MS) return record;
  const completedAt = Date.now();
  return saveGeneratedDocument({
    ...record,
    status: 'failed',
    error: '生成任务已失联，请点击重新生成',
    executionStages: failRunningStages(record.executionStages, '生成任务已失联，请点击重新生成'),
    completedAt,
  }, projectRoot);
}

export function listGeneratedDocuments(projectRoot = getProjectRoot()) {
  return readJson<GeneratedDocumentRecord[]>(indexPath(projectRoot), [])
    .map(item => markStaleGeneratingRecord(item, projectRoot))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getGeneratedDocument(id: string, projectRoot = getProjectRoot()) {
  const record = readJson<GeneratedDocumentRecord | null>(draftPath(id, projectRoot), null);
  return record ? markStaleGeneratingRecord(record, projectRoot) : null;
}

export function saveGeneratedDocument(record: GeneratedDocumentRecord, projectRoot = getProjectRoot()) {
  const now = Date.now();
  const next = { ...record, updatedAt: now };
  writeJson(draftPath(next.id, projectRoot), next);
  const list = readJson<GeneratedDocumentRecord[]>(indexPath(projectRoot), []).filter(item => item.id !== next.id);
  list.unshift(next);
  writeJson(indexPath(projectRoot), list.map(item => ({ ...item, draft: undefined, executionStages: item.executionStages, partialChapters: item.partialChapters, checkpointChapters: item.checkpointChapters, reviewMetadata: item.reviewMetadata })));
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
      clearGenerateTaskTimers(task);
      tasks.delete(key);
    }
  }
  return saveGeneratedDocument({ ...current, status: 'aborted', error: '用户中止', executionStages: failRunningStages(current.executionStages, '用户中止'), completedAt: Date.now() }, projectRoot);
}

export function deleteGeneratedDocument(id: string, projectRoot = getProjectRoot()) {
  try {
    fs.rmSync(draftPath(id, projectRoot), { force: true });
  } catch {
    console.warn('[generated-documents] 删除文档记录失败或文件不存在', id);
  }
  writeJson(indexPath(projectRoot), listGeneratedDocuments(projectRoot).filter(item => item.id !== id));
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
  const now = Date.now();
  const relativePath = generatedDocumentAssetPath(record);
  const absolutePath = path.join(generatedRoot(projectRoot), relativePath.replace(/^generatedDocuments\//u, ''));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, record.editedMarkdown || record.markdown, 'utf8');
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

function trimEvidenceContent<T extends GeneratedDocumentRecord>(record: T): T {
  const trimEvidence = (item: GeneratedDocumentDraft['chapters'][number]['evidence'][number]) => ({ ...item, content: item.content.slice(0, 500) });
  const draft = record.draft ? { ...record.draft, chapters: record.draft.chapters.map(chapter => ({ ...chapter, evidence: chapter.evidence.map(trimEvidence) })) } : record.draft;
  return { ...record, draft };
}

function clearGenerateTaskTimers(task: GenerateTask) {
  if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
  if (task.progressTimer) clearInterval(task.progressTimer);
}

function failGeneratingDocument(documentId: string, projectRoot: string, message: string) {
  const current = getGeneratedDocument(documentId, projectRoot);
  if (!current || current.status !== 'generating') return current;
  return saveGeneratedDocument({ ...current, status: 'failed', error: message, executionStages: failRunningStages(current.executionStages, message), completedAt: Date.now() }, projectRoot);
}

function activeTaskResponse(task: GenerateTask, projectRoot: string) {
  const record = getGeneratedDocument(task.documentId, projectRoot);
  if (!record || record.status !== 'generating') return null;
  return { taskId: task.id, documentId: task.documentId, record };
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
    executionStages: [...(existing.executionStages || []), { type: 'validation', roleId: 'resume-generation', status: 'running', message: '已从上次结果继续生成，系统将自动复用可用章节缓存和进度数据' }],
    updatedAt: now,
  } : {
    id: documentId,
    taskId,
    templateId: input.templateId,
    title: '生成中',
    requirement: input.requirement || '',
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
  const controller = new AbortController();
  const taskRef: { current?: GenerateTask } = {};
  const failAndStop = (message: string) => {
    controller.abort();
    if (taskRef.current) clearGenerateTaskTimers(taskRef.current);
    failGeneratingDocument(documentId, resolvedProjectRoot, message);
    tasks.delete(taskId);
  };
  const resumeChapters = mergeDraftChapters(existing?.draft?.chapters, existing?.checkpointChapters);
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
        const checkpointChapters = checkpoint?.chapters ? mergeDraftChapters(current.checkpointChapters, checkpoint.chapters) : current.checkpointChapters;
        saveGeneratedDocument({
          ...current,
          executionStages: stages,
          checkpointChapters,
          partialChapters: checkpoint?.chapters ? summarizeCheckpointChapters(checkpointChapters) : current.partialChapters,
        }, resolvedProjectRoot);
        lastProgressSaveAt = nowProgress;
        lastProgressSignature = signature;
        console.log(`[gen] progress saved: ${stages.length} stages, checkpoint=${checkpointChapters?.length || 0}, doc=${documentId}`);
      }
    } catch (err) { console.error('[gen] progress save error:', err); }
  } }).then(async result => {
    const current = getGeneratedDocument(documentId, resolvedProjectRoot);
    if (!current || current.status !== 'generating') return current ?? initial;
    const warningIssues = result.validationIssues.filter(issue => issue.level === 'error' || issue.level === 'warning').map(issue => issue.suggestion ? `${issue.message}：${issue.suggestion}` : issue.message);
    if (!result.exportGate.passed && warningIssues.length === 0) warningIssues.push('导出门禁未通过：存在未完成的检查项');
    const record = saveGeneratedDocument(trimEvidenceContent({
      ...current,
      templateName: result.templateName,
      title: result.title,
      markdown: result.markdown,
      status: warningIssues.length > 0 ? 'warning' : 'completed',
      draft: result,
      executionStages: result.executionStages,
      partialChapters: result.partialChapters,
      checkpointChapters: result.chapters,
      reviewMetadata: result.reviewMetadata,
      assets: result.assets || [],
      completedAt: Date.now(),
      warningIssues,
    }), resolvedProjectRoot);
    upsertGeneratedDocumentAsset(record, resolvedProjectRoot);
    const assets = upsertGeneratedAssets(result.assets || [], documentId, resolvedProjectRoot);
    return record;
  }).catch(error => {
    const current = getGeneratedDocument(documentId, resolvedProjectRoot);
    if (!current || current.status !== 'generating') return current ?? initial;
    const message = error instanceof Error ? error.message : String(error);
    const status: GeneratedDocumentStatus = isAbortError(error) ? 'aborted' : 'failed';
    const record = saveGeneratedDocument({ ...current, status, error: message, executionStages: failRunningStages(current.executionStages, message), completedAt: Date.now() }, resolvedProjectRoot);
    return record;
  }).finally(() => {
    if (taskRef.current) clearGenerateTaskTimers(taskRef.current);
    tasks.delete(taskId);
  });
  const task: GenerateTask = { id: taskId, documentId, status: 'generating', controller, promise, startedAt: now, lastProgressAt: now };
  taskRef.current = task;
  task.timeoutTimer = setTimeout(() => failAndStop('生成任务超时，请点击继续生成或重新生成'), DOCUMENT_TASK_TIMEOUT_MS);
  task.progressTimer = setInterval(() => {
    if (Date.now() - task.lastProgressAt > DOCUMENT_TASK_NO_PROGRESS_MS) failAndStop('生成任务长时间无进度，请点击继续生成或重新生成');
  }, Math.min(60_000, DOCUMENT_TASK_NO_PROGRESS_MS));
  tasks.set(taskId, task);
  return { taskId, documentId, record: initial };
}

export function getGenerateTask(taskId: string) {
  return tasks.get(taskId) || null;
}
