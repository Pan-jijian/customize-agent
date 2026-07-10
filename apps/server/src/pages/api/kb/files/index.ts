import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeProjectId, IndexStateStore } from '@customize-agent/knowledge';
import { getMultiProjectManager, getProjectRoot, isBuiltInKnowledgeFile } from '@/services/kbService';
import { upsertKbOperation } from '@/services/kbOperationLog';
import { withApiErrorBoundary } from '@/services/apiErrorBoundary';

type FastFile = {
  relativePath: string;
  category: string;
  format: string;
  contentHash: string;
  fileSize: number;
  mtime: number;
  chunkCount: number;
  collectionName: string;
  indexedAt: number;
  lastVerifiedAt: number;
  status: string;
  errorMessage?: string;
  metadataJson?: string;
};

/** 根据相对路径中的中文目录名推断文件分类 */
function categoryFromRelativePath(relativePath: string) {
  if (relativePath.includes('表格数据/')) return 'spreadsheet';
  if (relativePath.includes('图片素材/')) return 'image';
  if (relativePath.includes('图纸文件/')) return 'cad';
  if (relativePath.includes('文档资料/')) return 'document';
  return 'other';
}

function formatFromFile(filePath: string) {
  return path.extname(filePath).slice(1).toLowerCase() || 'text';
}

/** 扫描知识库目录下所有文件，返回磁盘上实际的文件列表 */
function scanKnowledgeBaseFiles(projectRoot: string): FastFile[] {
  const kbRoot = path.join(projectRoot, 'knowledgeBase');
  if (!fs.existsSync(kbRoot)) return [];
  const files: FastFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.source.txt')) continue;
      const stat = fs.statSync(full);
      const relativePath = path.relative(kbRoot, full).split(path.sep).join('/');
      files.push({
        relativePath,
        category: categoryFromRelativePath(relativePath),
        format: formatFromFile(relativePath),
        contentHash: '',
        fileSize: stat.size,
        mtime: stat.mtimeMs,
        chunkCount: 0,
        collectionName: '',
        indexedAt: 0,
        lastVerifiedAt: 0,
        status: 'pending',
      });
    }
  };
  walk(kbRoot);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
}

function readIndexedFiles(projectRoot: string): FastFile[] {
  const dbPath = path.join(os.homedir(), '.customize-agent', 'projects', computeProjectId(path.resolve(projectRoot)), 'kb.db');
  if (!fs.existsSync(dbPath)) return [];
  const store = new IndexStateStore(dbPath);
  try {
    return store.listRecords() as FastFile[];
  } finally {
    store.close();
  }
}

/** 合并已索引文件和磁盘文件，磁盘上新增文件以 pending 状态加入 */
function mergeIndexedAndDiskFiles(indexedFiles: FastFile[], projectRoot: string) {
  const byPath = new Map(indexedFiles.map(file => [file.relativePath, file]));
  for (const file of scanKnowledgeBaseFiles(projectRoot)) {
    const indexed = byPath.get(file.relativePath);
    byPath.set(file.relativePath, indexed ? { ...indexed, fileSize: file.fileSize, mtime: file.mtime } : file);
  }
  return Array.from(byPath.values()).sort((a, b) => Number(isBuiltInKnowledgeFile(a.relativePath)) - Number(isBuiltInKnowledgeFile(b.relativePath)) || b.mtime - a.mtime);
}

/** 标记文件是否为内置示例文件 */
function withBuiltInFlag<T extends { relativePath: string }>(file: T): T & { builtIn: boolean } {
  return { ...file, builtIn: isBuiltInKnowledgeFile(file.relativePath) };
}

/** 处理 KB 文件列表的获取、增量索引和批量删除操作 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'DELETE', 'POST'].includes(req.method!)) return res.status(405).json({ error: 'Method not allowed' });
    const bodyProjectRoot = typeof req.body?.projectRoot === 'string' ? req.body.projectRoot : undefined;
    const projectRoot = (req.query.projectRoot as string) || bodyProjectRoot || getProjectRoot();
    if (!projectRoot) return res.status(200).json({ files: [], total: 0 });

    if (req.method === 'GET' && req.query.reindex !== '1') {
      const category = req.query.category as string | undefined;
      const page = parseInt((req.query.page as string) || '1', 10);
      const limit = parseInt((req.query.limit as string) || '50', 10);
      let files: any[] = mergeIndexedAndDiskFiles(readIndexedFiles(projectRoot), projectRoot);
      if (category) files = files.filter(file => file.category === category);
      const total = files.length;
      const paged = files.slice((page - 1) * limit, page * limit).map(withBuiltInFlag);
      res.status(200).json({ files: paged, total, page, limit, vectorStatus: { enabled: false, dimension: 0, count: 0 }, initializing: false });
      return;
    }

    if (req.method === 'POST' && req.query.reindex !== '1') return res.status(400).json({ error: 'reindex=1 is required' });

    const project = await getMultiProjectManager().getProject(projectRoot);
    if (req.method === 'POST' || req.query.reindex === '1') await project.incrementalIndex();

    if (req.method === 'DELETE') {
      const { relativePath, relativePaths, folderPath, folderPaths, all } = req.body;
      const listedFiles = project.listFiles();
      const requestedFileTargets = all ? listedFiles.map(file => file.relativePath) : Array.isArray(relativePaths) ? relativePaths.map(String) : relativePath ? [String(relativePath)] : [];
      const requestedFolders = Array.isArray(folderPaths) ? folderPaths.map(String) : folderPath ? [String(folderPath)] : [];
      const folderTargets = requestedFolders.flatMap(folder => {
        const prefix = folder.replace(/^\/+|\/+$/gu, '');
        return listedFiles.filter(file => file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`)).map(file => file.relativePath);
      });
      const requestedTargets = Array.from(new Set([...requestedFileTargets, ...folderTargets]));
      if (requestedTargets.length === 0) return res.status(400).json({ error: 'relativePath, relativePaths or folderPaths is required' });
      const targets = requestedTargets.filter(target => !isBuiltInKnowledgeFile(target));
      if (targets.length === 0) return res.status(400).json({ error: '内置示例资料不可删除' });
      const operationId = `delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const title = all ? `删除全部用户文件 ${targets.length} 个` : targets.length === 1 ? `删除 ${targets[0]}` : `批量删除 ${targets.length} 个文件`;
      upsertKbOperation(projectRoot, { id: operationId, type: 'delete', title, stage: 'uploading', status: 'processing', percent: 10, message: '正在删除文件和索引', filePath: targets[0], fileName: targets[0]?.split('/').pop() });
      let deleted = 0;
      for (const target of targets) {
        await project.removeFile(target);
        deleted++;
        upsertKbOperation(projectRoot, { id: operationId, type: 'delete', title, stage: 'uploading', status: 'processing', percent: Math.min(95, Math.round((deleted / targets.length) * 90)), message: `已删除 ${deleted}/${targets.length}`, filePath: target, fileName: target.split('/').pop() });
      }
      upsertKbOperation(projectRoot, { id: operationId, type: 'delete', title, stage: 'done', status: 'success', percent: 100, message: `已删除 ${deleted} 个文件和索引`, filePath: targets[0], fileName: targets[0]?.split('/').pop() });
      return res.status(200).json({ success: true, deleted });
    }

    const category = req.query.category as string | undefined;
    const page = parseInt((req.query.page as string) || '1', 10);
    const limit = parseInt((req.query.limit as string) || '50', 10);
    let files = mergeIndexedAndDiskFiles(project.listFiles(), projectRoot);
    if (category) files = files.filter((f: { category: string }) => f.category === category);
    const vectorStatus = project.getVectorStatus();
    const total = files.length;
    const paged = files.slice((page - 1) * limit, page * limit).map(withBuiltInFlag);
    res.status(200).json({ files: paged, total, page, limit, vectorStatus });
}

/** 知识库文件 API：支持 GET 获取文件列表、POST 增量索引、DELETE 删除文件 */
export default withApiErrorBoundary('api/kb/files', handler);
