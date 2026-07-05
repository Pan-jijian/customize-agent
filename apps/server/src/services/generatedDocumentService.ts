import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GeneratedDocumentDraft, DocumentAsset } from './documentWorkflowService';
import { generateDocumentDraft } from './documentWorkflowService';
import { getMultiProjectManager, getProjectRoot } from './kbService';

export type GeneratedDocumentStatus = 'generating' | 'completed' | 'failed';

export interface GeneratedDocumentRecord {
  id: string;
  taskId?: string;
  templateId: string;
  templateName?: string;
  title: string;
  requirement: string;
  markdown: string;
  editedMarkdown?: string;
  status: GeneratedDocumentStatus;
  draft?: GeneratedDocumentDraft;
  assets: DocumentAsset[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
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
  promise: Promise<GeneratedDocumentRecord>;
}

const tasks = new Map<string, GenerateTask>();

function projectId(projectRoot = getProjectRoot()) {
  return crypto.createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
}

export function generatedRoot(projectRoot = getProjectRoot()) {
  const root = path.join(os.homedir(), '.customize-agent', 'projects', projectId(projectRoot), 'generatedDocuments');
  fs.mkdirSync(path.join(root, 'drafts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  return root;
}

function indexPath(projectRoot = getProjectRoot()) { return path.join(generatedRoot(projectRoot), 'index.json'); }
function assetsPath(projectRoot = getProjectRoot()) { return path.join(generatedRoot(projectRoot), 'assets.json'); }
function draftPath(id: string, projectRoot = getProjectRoot()) { return path.join(generatedRoot(projectRoot), 'drafts', `${id}.json`); }
function generatedAssetAbsolutePath(asset: GeneratedAssetRecord, projectRoot = getProjectRoot()) {
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

export function listGeneratedDocuments(projectRoot = getProjectRoot()) {
  return readJson<GeneratedDocumentRecord[]>(indexPath(projectRoot), []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getGeneratedDocument(id: string, projectRoot = getProjectRoot()) {
  return readJson<GeneratedDocumentRecord | null>(draftPath(id, projectRoot), null);
}

export function saveGeneratedDocument(record: GeneratedDocumentRecord, projectRoot = getProjectRoot()) {
  const now = Date.now();
  const next = { ...record, updatedAt: now };
  writeJson(draftPath(next.id, projectRoot), next);
  const list = listGeneratedDocuments(projectRoot).filter(item => item.id !== next.id);
  list.unshift(next);
  writeJson(indexPath(projectRoot), list.map(item => ({ ...item, draft: undefined })));
  return next;
}

export function updateGeneratedDocument(id: string, patch: Partial<GeneratedDocumentRecord>, projectRoot = getProjectRoot()) {
  const current = getGeneratedDocument(id, projectRoot);
  if (!current) return null;
  return saveGeneratedDocument({ ...current, ...patch, id }, projectRoot);
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

export async function indexGeneratedAsset(id: string, projectRoot = getProjectRoot()) {
  const asset = getGeneratedAsset(id, projectRoot);
  if (!asset?.path) return null;
  const absolutePath = generatedAssetAbsolutePath(asset, projectRoot);
  if (!absolutePath || !fs.existsSync(absolutePath)) throw new Error('asset file not found');
  const kbRelativePath = path.join('生成资源', path.basename(asset.path)).split(path.sep).join('/');
  const kbAbsolutePath = path.join(projectRoot, 'knowledgeBase', kbRelativePath);
  fs.mkdirSync(path.dirname(kbAbsolutePath), { recursive: true });
  if (absolutePath !== kbAbsolutePath) fs.copyFileSync(absolutePath, kbAbsolutePath);
  const project = await getMultiProjectManager().getProject(projectRoot);
  await project.reindexFile(kbRelativePath);
  const next = listGeneratedAssets(projectRoot).map(item => item.id === id ? { ...item, path: kbRelativePath, source: 'generated' as const, indexed: true, updatedAt: Date.now() } : item);
  writeJson(assetsPath(projectRoot), next);
  return next.find(item => item.id === id) || null;
}

export function openGeneratedAssetTarget(id: string, target: 'file' | 'directory', projectRoot = getProjectRoot()) {
  const asset = getGeneratedAsset(id, projectRoot);
  if (!asset) return null;
  const absolutePath = generatedAssetAbsolutePath(asset, projectRoot);
  if (!absolutePath || !fs.existsSync(absolutePath)) return null;
  return target === 'directory' ? path.dirname(absolutePath) : absolutePath;
}

export function startGenerateDocumentTask(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number }, projectRoot = getProjectRoot()) {
  const now = Date.now();
  const documentId = `doc-${now}-${crypto.randomBytes(4).toString('hex')}`;
  const taskId = `task-${now}-${crypto.randomBytes(4).toString('hex')}`;
  const initial: GeneratedDocumentRecord = {
    id: documentId,
    taskId,
    templateId: input.templateId,
    title: '生成中',
    requirement: input.requirement || '',
    markdown: '',
    status: 'generating',
    assets: [],
    createdAt: now,
    updatedAt: now,
  };
  saveGeneratedDocument(initial, projectRoot);
  const promise = generateDocumentDraft(input).then(result => {
    const record = saveGeneratedDocument({
      ...initial,
      templateName: result.templateName,
      title: result.title,
      markdown: result.markdown,
      status: 'completed',
      draft: result,
      assets: result.assets || [],
      completedAt: Date.now(),
    }, projectRoot);
    upsertGeneratedAssets(result.assets || [], documentId, projectRoot);
    return record;
  }).catch(error => {
    const record = saveGeneratedDocument({ ...initial, status: 'failed', error: error instanceof Error ? error.message : String(error) }, projectRoot);
    return record;
  }).finally(() => {
    const task = tasks.get(taskId);
    if (task) task.status = getGeneratedDocument(documentId, projectRoot)?.status || task.status;
  });
  const task: GenerateTask = { id: taskId, documentId, status: 'generating', promise };
  tasks.set(taskId, task);
  return { taskId, documentId, record: initial };
}

export function getGenerateTask(taskId: string) {
  return tasks.get(taskId) || null;
}
