import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json([]);
    const project = await getMultiProjectManager().getProject(projectRoot);
    if (req.method === 'POST') {
      const { rules } = req.body;
      if (Array.isArray(rules)) rules.forEach((r: string) => { if (r.trim()) project.addIgnoreRule(r.trim()); });
      return res.status(200).json({ success: true });
    }
    res.status(200).json(project.listIgnoreRules().map((r: any) => r.pattern));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
