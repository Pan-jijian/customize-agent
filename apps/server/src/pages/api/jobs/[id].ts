import type { NextApiRequest, NextApiResponse } from 'next';
import { getProjectRoot } from '@/services/kbService';
import { getKbOperation } from '@/services/kbOperationLog';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    const id = req.query.id as string | undefined;
    if (!projectRoot || !id) return res.status(400).json({ error: 'projectRoot and id are required' });
    const job = getKbOperation(projectRoot, id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.status(200).json({ job });
  } catch (error) {
    console.error('[api] jobs/[id]', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
