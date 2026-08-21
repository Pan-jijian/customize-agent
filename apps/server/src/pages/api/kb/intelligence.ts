import type { NextApiRequest, NextApiResponse } from 'next';
import { buildProjectIntelligence, readProjectIntelligence, startProjectIntelligenceBuild } from '@/services/document-workflow/projectIntelligence';
import { getProjectRoot } from '@/services/knowledge/kbService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const projectRoot = (req.body?.projectRoot as string) || (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(400).json({ error: 'projectRoot is required' });
    if (req.method === 'GET') {
      const cache = readProjectIntelligence(projectRoot);
      return res.status(200).json({ success: true, available: !!cache, cache: cache ? { version: cache.version, createdAt: cache.createdAt, fileCount: cache.fileCount, factCount: cache.facts.length, intentCount: cache.chapterIntentIndex.length, graph: { works: cache.projectGraph.works.length, methods: cache.projectGraph.methods.length, resources: cache.projectGraph.resources.length, risks: cache.projectGraph.risks.length }, message: cache.projectGraphMessage } : undefined });
    }
    if (req.method === 'POST') {
      if (req.body?.async) {
        startProjectIntelligenceBuild(projectRoot);
        return res.status(202).json({ success: true, accepted: true });
      }
      const cache = await buildProjectIntelligence(projectRoot);
      return res.status(200).json({ success: true, cache: { version: cache.version, createdAt: cache.createdAt, fileCount: cache.fileCount, factCount: cache.facts.length, intentCount: cache.chapterIntentIndex.length, graph: { works: cache.projectGraph.works.length, methods: cache.projectGraph.methods.length, resources: cache.projectGraph.resources.length, risks: cache.projectGraph.risks.length }, message: cache.projectGraphMessage } });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[api] kb/intelligence', e);
    return res.status(500).json({ error: message });
  }
}
