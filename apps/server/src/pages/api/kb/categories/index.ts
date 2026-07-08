import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

/** 文件分类统计 API：按 category 统计各分类的文件数量和总大小 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const kb = getMultiProjectManager();
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json([]);
    const project = await kb.getProject(projectRoot);
    const files = project.listFiles();
    const cats: Record<string, { fileCount: number; totalSize: number }> = {};
    for (const f of files) {
      const cat = f.category || 'other';
      if (!cats[cat]) cats[cat] = { fileCount: 0, totalSize: 0 };
      cats[cat].fileCount++;
      cats[cat].totalSize += f.fileSize || 0;
    }
    const result = Object.entries(cats).map(([category, stats]) => ({ category, ...stats }));
    res.status(200).json(result);
  } catch (e: unknown) { console.error('[api] kb/categories', e); res.status(500).json({ error: 'Internal server error' }); }
}
