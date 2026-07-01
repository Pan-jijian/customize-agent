import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json({ files: [], total: 0 });
    const project = await getMultiProjectManager().getProject(projectRoot);
    await project.incrementalIndex();

    if (req.method === 'DELETE') {
      const { relativePath } = req.body;
      if (!relativePath) return res.status(400).json({ error: 'relativePath is required' });
      await project.removeFile(relativePath);
      return res.status(200).json({ success: true });
    }

    const category = req.query.category as string | undefined;
    const page = parseInt((req.query.page as string) || '1', 10);
    const limit = parseInt((req.query.limit as string) || '50', 10);
    let files = project.listFiles();
    if (category) files = files.filter((f) => f.category === category);
    const total = files.length;
    const paged = files.slice((page - 1) * limit, page * limit);
    res.status(200).json({ files: paged, total, page, limit });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
