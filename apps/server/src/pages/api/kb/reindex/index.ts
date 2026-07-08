import type { NextApiRequest, NextApiResponse } from 'next';
import { getProjectRoot } from '@/services/kbService';
import { startKnowledgeIndex } from '@/services/kbIndexWorkerService';
import { upsertKbOperation } from '@/services/kbOperationLog';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const projectRoot = (req.body?.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });
    const operationId = `reindex-${Date.now()}`;
    upsertKbOperation(projectRoot, { id: operationId, type: 'reindex', title: '重新解析入库', stage: 'uploading', status: 'processing', percent: 5, message: '重新解析入库任务已提交' });
    startKnowledgeIndex({ id: operationId, projectRoot, forceReindexAll: true });
    res.status(202).json({ success: true, accepted: true, operationId });
  } catch (e: unknown) { console.error('[api] kb/reindex', e); res.status(500).json({ error: 'Internal server error' }); }
}
