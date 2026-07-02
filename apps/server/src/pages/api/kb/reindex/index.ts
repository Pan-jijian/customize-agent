import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const projectRoot = (req.body?.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });
    const project = await getMultiProjectManager().getProject(projectRoot);
    const diff = await project.incrementalIndex();
    res.status(200).json({ success: true, stats: project.getStats(), diff: { newFiles: diff.newFiles.length, modifiedFiles: diff.modifiedFiles.length, deletedFiles: diff.deletedFiles.length, hasChanges: diff.hasChanges } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
