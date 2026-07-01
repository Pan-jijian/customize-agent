import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const q = (req.query.q as string) || '';
    if (!q.trim()) return res.status(200).json({ results: [], total: 0 });
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json({ results: [], total: 0 });
    const limit = parseInt((req.query.limit as string) || '20', 10);
    const result = await getMultiProjectManager().search(projectRoot, q, { limit });
    res.status(200).json({ results: result.results, total: result.results.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
