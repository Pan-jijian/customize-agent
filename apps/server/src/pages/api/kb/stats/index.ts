import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

/** 知识库统计 API：返回文件统计和向量引擎状态 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json({});
    const project = await getMultiProjectManager().getProject(projectRoot);
    res.status(200).json({ ...project.getStats(), vectorStatus: project.getVectorStatus() });
  } catch (e: unknown) { console.error('[api] kb/stats', e); res.status(500).json({ error: 'Internal server error' }); }
}
