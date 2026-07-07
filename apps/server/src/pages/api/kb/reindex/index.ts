import type { NextApiRequest, NextApiResponse } from 'next';
import { getProjectRoot } from '@/services/kbService';
import { enqueueKnowledgeIndex } from '@/services/kbIndexWorkerService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const projectRoot = (req.body?.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });
    const result = await enqueueKnowledgeIndex({ id: `reindex-${Date.now()}`, projectRoot });
    if (!result.success) return res.status(500).json({ error: result.error || 'Reindex failed' });
    res.status(200).json(result);
  } catch (e: unknown) { console.error('[api] kb/reindex', e); res.status(500).json({ error: 'Internal server error' }); }
}
