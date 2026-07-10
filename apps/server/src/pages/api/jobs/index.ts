import type { NextApiRequest, NextApiResponse } from 'next';
import { getProjectRoot } from '@/services/kbService';
import { listActiveKbOperations, listKbOperations } from '@/services/kbOperationLog';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json({ jobs: [] });
    const activeOnly = req.query.active === '1' || req.query.active === 'true';
    const limit = Number(req.query.limit ?? 50);
    const jobs = activeOnly
      ? listActiveKbOperations(projectRoot)
      : listKbOperations(projectRoot, Number.isFinite(limit) ? limit : 50);
    return res.status(200).json({ jobs });
  } catch (error) {
    console.error('[api] jobs', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
