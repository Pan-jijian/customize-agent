import type { NextApiRequest, NextApiResponse } from 'next';
import { getProjectRoot } from '@/services/kbService';
import { clearKbOperations, deleteKbOperation, listKbOperations } from '@/services/kbOperationLog';

/** 操作记录 API：GET 获取操作历史，DELETE 删除单条或清空所有记录 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json(req.method === 'DELETE' ? { success: true, deleted: 0 } : { operations: [] });
    if (req.method === 'GET') {
      const limit = Number(req.query.limit ?? 50);
      return res.status(200).json({ operations: listKbOperations(projectRoot, Number.isFinite(limit) ? limit : 50) });
    }
    if (req.method === 'DELETE') {
      const id = req.query.id as string | undefined;
      if (id) {
        const deleted = deleteKbOperation(projectRoot, id);
        return res.status(200).json({ success: deleted, deleted: deleted ? 1 : 0 });
      }
      return res.status(200).json({ success: true, deleted: clearKbOperations(projectRoot) });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    console.error('[api] kb/operations', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
