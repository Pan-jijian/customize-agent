import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    const relativePath = req.query.relativePath as string | undefined;
    if (!projectRoot || !relativePath) return res.status(400).json({ error: 'projectRoot and relativePath are required' });
    const project = await getMultiProjectManager().getProject(projectRoot);
    const detail = project.getFileDetail(relativePath);
    if (!detail) return res.status(404).json({ error: 'file not found' });
    res.status(200).json(detail);
  } catch (e: unknown) {
    console.error('[api] kb/files/detail', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
