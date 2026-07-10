import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot, isBuiltInKnowledgeFile } from '@/services/kbService';
import { getActiveKnowledgeIndex, startKnowledgeIndex } from '@/services/kbIndexWorkerService';
import { getKbOperation, upsertKbOperation } from '@/services/kbOperationLog';

/** 单个文件重索引 API：提交后台任务，对指定文件重新解析、分块和入库 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  try {
    const projectRoot = (req.body?.projectRoot as string) || getProjectRoot();
    const relativePath = req.body?.relativePath as string | undefined;
    if (!projectRoot || !relativePath) return res.status(400).json({ error: 'projectRoot and relativePath are required' });
    if (isBuiltInKnowledgeFile(relativePath)) return res.status(400).json({ error: '内置示例资料不可重新解析' });

    const kbRoot = path.join(projectRoot, 'knowledgeBase');
    const targetPath = path.resolve(kbRoot, relativePath);
    if (!targetPath.startsWith(path.resolve(kbRoot) + path.sep)) return res.status(400).json({ error: 'invalid relativePath' });
    if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'file not found' });

    const active = getActiveKnowledgeIndex(projectRoot);
    if (active) {
      const job = getKbOperation(projectRoot, active.operationId);
      return res.status(202).json({ success: true, accepted: true, alreadyRunning: true, operationId: active.operationId, job });
    }

    const operationId = `file-reindex-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const title = `重新解析 ${relativePath}`;
    const job = upsertKbOperation(projectRoot, {
      id: operationId,
      type: 'reindex',
      title,
      stage: 'uploading',
      status: 'processing',
      percent: 5,
      message: '单文件重新解析任务已提交，正在后台排队执行',
      filePath: relativePath,
      fileName: relativePath.split('/').pop(),
    });
    startKnowledgeIndex({ id: operationId, projectRoot, relativePath, forceReindexAll: false });
    return res.status(202).json({ success: true, accepted: true, operationId, job });
  } catch (e: unknown) {
    console.error('[api] kb/files/reindex', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
