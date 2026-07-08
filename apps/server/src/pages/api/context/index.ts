import type { NextApiRequest, NextApiResponse } from 'next';
import { listLongTermContexts, listShortTermContexts, deleteMemory, updateMemory, getContextStats, clearContexts, compressContexts } from '@/services/contextService';

/** 上下文管理 API：支持记忆的增删改查、压缩和清空操作 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const type = (req.query.type as string) || 'long_term';
      if (req.query.stats === '1') return res.status(200).json(getContextStats(type));
      const search = req.query.search as string | undefined;
      const data = type === 'long_term' ? listLongTermContexts(search) : listShortTermContexts(search);
      return res.status(200).json(data);
    }
    if (req.method === 'POST') {
      const { action, type = 'long_term' } = req.body;
      if (action === 'compress') return res.status(200).json({ success: true, ...compressContexts(type) });
      if (action === 'clear') return res.status(200).json({ success: true, deleted: clearContexts(type) });
      return res.status(400).json({ error: 'Unknown action' });
    }
    if (req.method === 'DELETE') {
      const id = req.query.id as string;
      if (!id) return res.status(400).json({ error: 'id required' });
      const ok = deleteMemory(id);
      if (!ok) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ success: true });
    }
    if (req.method === 'PUT') {
      const { id, content, context } = req.body;
      if (!id || !content) return res.status(400).json({ error: 'id and content required' });
      const ok = updateMemory(id, { content, context });
      if (!ok) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ success: true });
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) { console.error('[api] context', e); res.status(500).json({ error: 'Internal server error' }); }
}
