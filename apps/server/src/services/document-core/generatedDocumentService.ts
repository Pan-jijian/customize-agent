import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DocumentDraftChapter, GeneratedDocumentDraft, DocumentAsset } from '../document-workflow/types';
import { generateDocumentDraft } from '../document-workflow';
import { collectSectionContentGaps } from '../document-workflow/qualityValidation';
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
const DOCUMENT_TASK_TIMEOUT_MS = Math.max(10 * 60_000, Number(process.env.DOCUMENT_TASK_TIMEOUT_MS ?? 90 * 60_000));
const DOCUMENT_TASK_NO_PROGRESS_MS = Math.max(10 * 60_000, Number(process.env.DOCUMENT_TASK_NO_PROGRESS_MS ?? 30 * 60_000));

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

function markStaleGeneratingRecord(record: GeneratedDocumentRecord, _projectRoot = getProjectRoot()) {
  if (record.status !== 'generating' || getActiveTaskByDocumentId(record.id)) return record;
  const staleAfterMs = Math.max(DOCUMENT_TASK_TIMEOUT_MS, DOCUMENT_TASK_NO_PROGRESS_MS * 2);
  if (Date.now() - record.updatedAt < staleAfterMs) return record;
  const message = '生成任务已中断，请点击继续生成或重新生成';
  const status: GeneratedDocumentStatus = record.checkpointChapters?.length ? 'warning' : 'failed';
  return {
    ...record,
    title: fallbackFailedTitle(record),
    status,
    error: record.error || message,
    executionStages: failRunningStages(record.executionStages, message),
    completedAt: Date.now(),
    warningIssues: record.checkpointChapters?.length ? [...(record.warningIssues || []), message] : record.warningIssues,
  };
}

export function listGeneratedDocuments(projectRoot = getProjectRoot()) {
  return readJson<GeneratedDocumentRecord[]>(indexPath(projectRoot), [])
    .map(item => {
      const next = markStaleGeneratingRecord(item, projectRoot);
      if (next !== item) saveGeneratedDocument(next, projectRoot);
      return next;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getGeneratedDocument(id: string, projectRoot = getProjectRoot()) {
  const record = readJson<GeneratedDocumentRecord | null>(draftPath(id, projectRoot), null);
  if (!record) return null;
  const next = markStaleGeneratingRecord(record, projectRoot);
  return next !== record ? saveGeneratedDocument(next, projectRoot) : next;
}

export function saveGeneratedDocument(record: GeneratedDocumentRecord, projectRoot = getProjectRoot()) {
  const now = Date.now();
  const next = trimEvidenceContent({ ...record, updatedAt: now });
  writeJson(draftPath(next.id, projectRoot), next);
  const list = readJson<GeneratedDocumentRecord[]>(indexPath(projectRoot), []).filter(item => item.id !== next.id);
  list.unshift(next);
  writeJson(indexPath(projectRoot), list.map(item => trimEvidenceContent({ ...item, draft: undefined, executionStages: item.executionStages, partialChapters: item.partialChapters, checkpointChapters: item.checkpointChapters, reviewMetadata: item.reviewMetadata })));
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

function clearGenerateTaskTimers(task: GenerateTask) {
  if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
  if (task.progressTimer) clearInterval(task.progressTimer);
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
    executionStages: [...(existing.executionStages || []), { type: 'validation', roleId: 'resume-generation', status: 'running', message: '已重新进入生成流程，系统将重新生成章节内容并执行质量门禁' }],
    updatedAt: now,
  } : {
    id: documentId,
    taskId,
    templateId: input.templateId,
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
  const controller = new AbortController();
  const taskRef: { current?: GenerateTask } = {};
  const failAndStop = (message: string) => {
    controller.abort();
    if (taskRef.current) clearGenerateTaskTimers(taskRef.current);
    const current = getGeneratedDocument(documentId, resolvedProjectRoot);
    if (current?.checkpointChapters?.length) {
      saveGeneratedDocument({
        ...current,
        title: current.title && current.title !== '生成中' ? current.title : `${current.templateName || '文档'}生成未完成`,
        status: 'warning',
        error: message,
        markdown: current.markdown || current.checkpointChapters.map(chapter => `# ${chapter.title}\n\n${chapter.content}`).join('\n\n'),
        executionStages: failRunningStages(current.executionStages, message),
        completedAt: Date.now(),
        warningIssues: [...(current.warningIssues || []), message],
      }, resolvedProjectRoot);
    } else {
      failGeneratingDocument(documentId, resolvedProjectRoot, message);
    }
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
        const checkpointChapters = checkpoint?.chapters ? mergeDraftChapters(current.checkpointChapters, checkpoint.chapters).map(trimChapterEvidence) : current.checkpointChapters;
        saveGeneratedDocument(trimEvidenceContent({
          ...current,
          executionStages: stages,
          checkpointChapters,
          partialChapters: checkpoint?.chapters ? summarizeCheckpointChapters(checkpointChapters) : current.partialChapters,
        }), resolvedProjectRoot);
        lastProgressSaveAt = nowProgress;
        lastProgressSignature = signature;
        console.log(`[gen] progress saved: ${stages.length} stages, checkpoint=${checkpointChapters?.length || 0}, doc=${documentId}`);
      }
    } catch (err) { console.error('[gen] progress save error:', err); }
  } }).then(async result => {
    const current = getGeneratedDocument(documentId, resolvedProjectRoot);
    if (!current || current.status !== 'generating') return current ?? initial;
    const hiddenDiagnosticRe = /结构化事实读取不足|正文可能未显式覆盖|仅包含文件类型和占位符|不在本次招标范围内|知识库文件索引失败|暂无可检索内容切片|未抽取到结构化事实|兜底片段|资料抽取诊断|无法直接读取文本内容|占位符|缺乏详细的.*具体尺寸|需结合原文件进一步深化|章节生成存在兜底/u;
    const warningIssues = result.validationIssues
      .filter(issue => issue.level === 'error' || issue.level === 'warning')
      .map(issue => issue.suggestion ? `${issue.message}：${issue.suggestion}` : issue.message)
      .filter(message => !/^\s*[[{]/u.test(message) && !/"status"\s*:/u.test(message) && !hiddenDiagnosticRe.test(message));
    const sectionGaps = collectSectionContentGaps(result.markdown, result.chapters).filter(gap => gap.reason === 'empty' || gap.reason === 'table_only');
    if (sectionGaps.length > 0) warningIssues.unshift(`小节内容补写未完成：仍有 ${sectionGaps.length} 个空洞或表格无说明小节，请继续生成或补充资料后重试`);
    if (!result.exportGate.passed && warningIssues.length === 0) warningIssues.push('导出门禁未通过：存在未完成的硬阻断检查项');
    const record = saveGeneratedDocument(trimEvidenceContent({
      ...current,
      templateName: result.templateName,
      title: result.title,
      markdown: result.markdown,
      status: result.exportGate.passed ? 'completed' : 'warning',
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
    const status: GeneratedDocumentStatus = isAbortError(error) ? 'aborted' : current.checkpointChapters?.length ? 'warning' : 'failed';
    const markdown = current.markdown || current.checkpointChapters?.map(chapter => `# ${chapter.title}\n\n${chapter.content}`).join('\n\n') || '';
    const record = saveGeneratedDocument(trimEvidenceContent({
      ...current,
      title: status === 'failed' ? fallbackFailedTitle(current) : current.title && current.title !== '生成中' ? current.title : `${current.templateName || '文档'}生成未完成`,
      status,
      error: message,
      markdown,
      executionStages: failRunningStages(current.executionStages, message),
      completedAt: Date.now(),
      warningIssues: status === 'warning' ? [...(current.warningIssues || []), message] : current.warningIssues,
    }), resolvedProjectRoot);
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
