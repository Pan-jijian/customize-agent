import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as path from 'path';
import { ensureBuiltInKnowledgeBase, getMultiProjectManager, getProjectRoot } from '@/services/kbService';
import { upsertKbOperation } from '@/services/kbOperationLog';

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

async function ensureBuiltInIndexed(projectRoot: string) {
  const project = await getMultiProjectManager().getProject(projectRoot);
  await project.incrementalIndex();
  return project.listFiles();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'DELETE', 'POST'].includes(req.method!)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const bodyProjectRoot = typeof req.body?.projectRoot === 'string' ? req.body.projectRoot : undefined;
    const projectRoot = (req.query.projectRoot as string) || bodyProjectRoot || getProjectRoot();
    if (!projectRoot) return res.status(200).json({ files: [], total: 0 });

    if (req.method === 'GET' && req.query.reindex !== '1') {
      const category = req.query.category as string | undefined;
      const page = parseInt((req.query.page as string) || '1', 10);
      const limit = parseInt((req.query.limit as string) || '50', 10);
      const resolvedProjectRoot = ensureBuiltInKnowledgeBase(projectRoot);
      let files: any[] = await ensureBuiltInIndexed(resolvedProjectRoot);
      if (files.length === 0) files = scanKnowledgeBaseFiles(resolvedProjectRoot);
      if (category) files = files.filter(file => file.category === category);
      const total = files.length;
      const paged = files.slice((page - 1) * limit, page * limit).map(file => ({ ...file, builtIn: true }));
      res.status(200).json({ files: paged, total, page, limit, initializing: false });
      return;
    }

    const project = await getMultiProjectManager().getProject(projectRoot);
    if (req.method === 'POST' || req.query.reindex === '1') await project.incrementalIndex();

    if (req.method === 'DELETE') {
      const { relativePath, relativePaths, all } = req.body;
      const targets = all ? project.listFiles().map(file => file.relativePath) : Array.isArray(relativePaths) ? relativePaths.map(String) : relativePath ? [String(relativePath)] : [];
      if (targets.length === 0) return res.status(400).json({ error: 'relativePath or relativePaths is required' });
      const operationId = `delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const title = all ? `删除全部 ${targets.length} 个文件` : targets.length === 1 ? `删除 ${targets[0]}` : `批量删除 ${targets.length} 个文件`;
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
    let files = project.listFiles();
    if (category) files = files.filter((f: { category: string }) => f.category === category);
    const vectorStatus = project.getVectorStatus();
    const total = files.length;
    const paged = files.slice((page - 1) * limit, page * limit).map((file: { relativePath: string }) => ({ ...file, builtIn: true }));
    res.status(200).json({ files: paged, total, page, limit, vectorStatus });
  } catch (e: unknown) { console.error('[api] kb/files/index', e); res.status(500).json({ error: 'Internal server error' }); }
}
