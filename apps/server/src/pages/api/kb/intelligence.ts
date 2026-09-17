import type { NextApiRequest, NextApiResponse } from 'next';
import { buildProjectIntelligenceSync, readProjectIntelligence, startProjectIntelligenceBuild, startProjectIntelligenceBuildForLibrary } from '@/services/document-workflow/projectIntelligence';
import { getProjectRoot } from '@/services/knowledge/kbService';

/** 资料包理解缓存运维接口：缓存按资料包（知识库顶层目录名）独立构建与读取，materialRoot 即包 ID */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const projectRoot = (req.body?.projectRoot as string) || (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(400).json({ error: 'projectRoot is required' });
    const materialRoot = String(req.body?.materialRoot || req.query.materialRoot || '').trim();
    if (req.method === 'GET') {
      if (!materialRoot) return res.status(400).json({ error: 'materialRoot is required（资料包 ID = 知识库顶层目录名）' });
      const cache = readProjectIntelligence(projectRoot, materialRoot);
      return res.status(200).json({ success: true, materialRoot, available: !!cache, cache: cache ? { version: cache.version, packRoot: cache.packRoot, createdAt: cache.createdAt, fileCount: cache.fileCount, factCount: cache.facts.length, intentCount: cache.chapterIntentIndex.length, graph: { works: cache.projectGraph.works.length, methods: cache.projectGraph.methods.length, resources: cache.projectGraph.resources.length, risks: cache.projectGraph.risks.length }, message: cache.projectGraphMessage } : undefined });
    }
    if (req.method === 'POST') {
      if (req.body?.async) {
        if (materialRoot) startProjectIntelligenceBuild(projectRoot, materialRoot);
        else startProjectIntelligenceBuildForLibrary(projectRoot);
        return res.status(202).json({ success: true, accepted: true, scope: materialRoot ? 'pack' : 'library' });
      }
      if (!materialRoot) return res.status(400).json({ error: 'materialRoot is required（同步构建必须指定资料包 ID）' });
      // 同步构建与后台构建（排空触发/自愈触发）共享并发守卫：进行中时复用其结果，防并发写同一缓存文件
      const cache = await buildProjectIntelligenceSync(projectRoot, materialRoot);
      return res.status(200).json({ success: true, cache: { version: cache.version, packRoot: cache.packRoot, createdAt: cache.createdAt, fileCount: cache.fileCount, factCount: cache.facts.length, intentCount: cache.chapterIntentIndex.length, graph: { works: cache.projectGraph.works.length, methods: cache.projectGraph.methods.length, resources: cache.projectGraph.resources.length, risks: cache.projectGraph.risks.length }, message: cache.projectGraphMessage } });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[api] kb/intelligence', e);
    return res.status(500).json({ error: message });
  }
}
