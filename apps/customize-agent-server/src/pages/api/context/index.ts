import type { NextApiRequest, NextApiResponse } from 'next';
import { listLongTermContexts, listShortTermContexts, deleteMemory, updateMemory } from '@/services/contextService';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const type = (req.query.type as string) || 'long_term';
      const search = req.query.search as string | undefined;
      const data = type === 'long_term' ? listLongTermContexts(search) : listShortTermContexts(search);
      return res.status(200).json(data);
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
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
