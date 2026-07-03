import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  try {
    const projectRoot = (req.body?.projectRoot as string) || getProjectRoot();
    const relativePath = req.body?.relativePath as string | undefined;
    if (!projectRoot || !relativePath) return res.status(400).json({ error: 'projectRoot and relativePath are required' });
    const project = await getMultiProjectManager().getProject(projectRoot);
    const diff = await project.reindexFile(relativePath);
    const detail = project.getFileDetail(relativePath);
    res.status(200).json({ diff, detail });
  } catch (e: unknown) {
    console.error('[api] kb/files/reindex', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
