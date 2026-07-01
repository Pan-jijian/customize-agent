import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json([]);
    const tags = (await getMultiProjectManager().getProject(projectRoot)).listTags();
    res.status(200).json([...new Set(tags.map((t: any) => t.tag))]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
