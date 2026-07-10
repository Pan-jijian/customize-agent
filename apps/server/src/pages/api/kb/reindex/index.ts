import type { NextApiRequest, NextApiResponse } from 'next';
import { getProjectRoot } from '@/services/kbService';
import { getActiveKnowledgeIndex, startKnowledgeIndex } from '@/services/kbIndexWorkerService';
import { getKbOperation, getLatestKbOperation, upsertKbOperation } from '@/services/kbOperationLog';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const projectRoot = ((req.method === 'GET' ? req.query.projectRoot : req.body?.projectRoot) as string | undefined) || getProjectRoot();
    if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });

    if (req.method === 'GET') {
      const active = getActiveKnowledgeIndex(projectRoot);
      const activeJob = active ? getKbOperation(projectRoot, active.operationId) : undefined;
      const latest = getLatestKbOperation(projectRoot, 'reindex');
      return res.status(200).json({ running: Boolean(active), active, job: activeJob || latest || null });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const active = getActiveKnowledgeIndex(projectRoot);
    if (active) {
      const job = getKbOperation(projectRoot, active.operationId);
      return res.status(202).json({ success: true, accepted: true, alreadyRunning: true, operationId: active.operationId, job });
    }

    const operationId = `reindex-${Date.now()}`;
    const job = upsertKbOperation(projectRoot, {
      id: operationId,
      type: 'reindex',
      title: '重新解析入库',
      stage: 'uploading',
      status: 'processing',
      percent: 5,
      message: '重新解析入库任务已提交，正在后台排队执行',
    });
    startKnowledgeIndex({ id: operationId, projectRoot, forceReindexAll: true });
    return res.status(202).json({ success: true, accepted: true, operationId, job });
  } catch (error) {
    console.error('[api] kb/reindex', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
