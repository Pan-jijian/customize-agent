import type { NextApiRequest, NextApiResponse } from 'next';
import { buildProjectIntelligenceSync, readProjectIntelligence, startProjectIntelligenceBuild } from '@/services/document-workflow/projectIntelligence';
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
      // 同步构建与后台构建（排空触发/自愈触发）共享并发守卫：进行中时复用其结果，防并发写同一缓存文件
      const cache = await buildProjectIntelligenceSync(projectRoot);
      return res.status(200).json({ success: true, cache: { version: cache.version, createdAt: cache.createdAt, fileCount: cache.fileCount, factCount: cache.facts.length, intentCount: cache.chapterIntentIndex.length, graph: { works: cache.projectGraph.works.length, methods: cache.projectGraph.methods.length, resources: cache.projectGraph.resources.length, risks: cache.projectGraph.risks.length }, message: cache.projectGraphMessage } });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[api] kb/intelligence', e);
    return res.status(500).json({ error: message });
  }
}
