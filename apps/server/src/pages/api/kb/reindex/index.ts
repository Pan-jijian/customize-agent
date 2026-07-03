import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const projectRoot = (req.body?.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });
    const project = await getMultiProjectManager().getProject(projectRoot);
    const diff = await project.incrementalIndex();
    res.status(200).json({ success: true, stats: { ...project.getStats(), vectorStatus: project.getVectorStatus() }, diff: { newFiles: diff.newFiles.length, modifiedFiles: diff.modifiedFiles.length, deletedFiles: diff.deletedFiles.length, hasChanges: diff.hasChanges } });
  } catch (e: unknown) { console.error('[api] kb/reindex', e); res.status(500).json({ error: 'Internal server error' }); }
}
