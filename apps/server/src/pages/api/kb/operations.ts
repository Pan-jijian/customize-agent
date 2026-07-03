import type { NextApiRequest, NextApiResponse } from 'next';
import { getProjectRoot } from '@/services/kbService';
import { listKbOperations } from '@/services/kbOperationLog';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json({ operations: [] });
    const limit = Number(req.query.limit ?? 50);
    res.status(200).json({ operations: listKbOperations(projectRoot, Number.isFinite(limit) ? limit : 50) });
  } catch (e: unknown) {
    console.error('[api] kb/operations', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
