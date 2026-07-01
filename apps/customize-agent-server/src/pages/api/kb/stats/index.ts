import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json({});
    const project = await getMultiProjectManager().getProject(projectRoot);
    await project.incrementalIndex();
    res.status(200).json(project.getStats());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
