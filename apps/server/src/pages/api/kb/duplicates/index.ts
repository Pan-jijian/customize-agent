import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json([]);
    const records = (await getMultiProjectManager().getProject(projectRoot)).listFiles();
    const byHash = new Map<string, typeof records>();
    for (const r of records) { const e = byHash.get(r.contentHash); if (e) e.push(r); else byHash.set(r.contentHash, [r]); }
    res.status(200).json([...byHash.entries()].filter(([, v]) => v.length > 1).map(([h, fs]) => ({ contentHash: h, files: fs.map((f: { relativePath: string }) => ({ projectId: '', projectRoot, relativePath: f.relativePath })) })));
  } catch (e: unknown) { console.error('[api] kb/duplicates', e); res.status(500).json({ error: 'Internal server error' }); }
}
