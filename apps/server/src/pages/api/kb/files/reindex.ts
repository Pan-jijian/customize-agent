import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectKbRoot, getProjectRoot } from '@/services/knowledge/kbService';
import { getActiveKnowledgeIndex, startKnowledgeIndex } from '@/services/knowledge/kbIndexWorkerService';
import { getKbOperation, upsertKbOperation } from '@/services/knowledge/kbOperationLog';

function listFilesRecursively(directory: string, base: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(full, base));
    else if (!entry.name.endsWith('.source.txt')) files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files;
}

/** 文件或文件夹重索引 API：提交后台任务，对指定范围重新解析、分块和入库 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  try {
    const projectRoot = (req.body?.projectRoot as string) || getProjectRoot();
    const relativePath = req.body?.relativePath as string | undefined;
    if (!projectRoot || !relativePath) return res.status(400).json({ error: 'projectRoot and relativePath are required' });

    const kbRoot = getProjectKbRoot(projectRoot);
    const targetPath = path.resolve(kbRoot, relativePath);
    if (!targetPath.startsWith(path.resolve(kbRoot) + path.sep)) return res.status(400).json({ error: 'invalid relativePath' });
    if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'file or folder not found' });
    const stat = fs.statSync(targetPath);
    const relativePaths = stat.isDirectory() ? listFilesRecursively(targetPath, kbRoot) : [relativePath];
    if (relativePaths.length === 0) return res.status(400).json({ error: 'folder has no indexable files' });

    const active = getActiveKnowledgeIndex(projectRoot);
    if (active) {
      const job = getKbOperation(projectRoot, active.operationId);
      return res.status(202).json({ success: true, accepted: true, alreadyRunning: true, operationId: active.operationId, job });
    }

    const operationId = `file-reindex-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const title = stat.isDirectory() ? `重新解析文件夹 ${relativePath}` : `重新解析 ${relativePath}`;
    const job = upsertKbOperation(projectRoot, {
      id: operationId,
      type: 'reindex',
      title,
      stage: 'uploading',
      status: 'processing',
      percent: 5,
      message: stat.isDirectory() ? `文件夹重新解析任务已提交，共 ${relativePaths.length} 个文件` : '单文件重新解析任务已提交，正在后台排队执行',
      filePath: relativePath,
      fileName: relativePath.split('/').filter(Boolean).pop(),
    });
    startKnowledgeIndex({ id: operationId, projectRoot, relativePath, relativePaths, forceReindexAll: false });
    return res.status(202).json({ success: true, accepted: true, operationId, job, fileCount: relativePaths.length });
  } catch (e: unknown) {
    console.error('[api] kb/files/reindex', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
