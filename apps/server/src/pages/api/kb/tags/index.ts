import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

/** 标签列表 API：返回知识库中所有去重的标签集合 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json([]);
    const tags = (await getMultiProjectManager().getProject(projectRoot)).listTags();
    res.status(200).json([...new Set(tags.map((t: any) => t.tag))]);
  } catch (e: unknown) { console.error('[api] kb/tags', e); res.status(500).json({ error: 'Internal server error' }); }
}
