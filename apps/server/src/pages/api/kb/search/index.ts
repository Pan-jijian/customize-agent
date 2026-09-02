import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/knowledge/kbService';

/** 知识库搜索 API：支持 keyword/vector/hybridBonus 权重配置的混合搜索。
 * 注：rewrite 权重刻意不下放——llmProvider 未接入时查询重写恒为单查询，rewrite 权重恒不生效（见 kbService.ts P1-10 注释）。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const q = (req.query.q as string) || '';
    if (!q.trim()) return res.status(200).json({ results: [], total: 0 });
    const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
    if (!projectRoot) return res.status(200).json({ results: [], total: 0 });
    const limit = parseInt((req.query.limit as string) || '20', 10);
    const readWeight = (value: string | string[] | undefined) => {
      const parsed = Number(Array.isArray(value) ? value[0] : value);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
    };
    const weights = {
      keyword: readWeight(req.query.keywordWeight),
      vector: readWeight(req.query.vectorWeight),
      hybridBonus: readWeight(req.query.hybridBonus),
    };
    const result = await getMultiProjectManager().search(projectRoot, q, { limit, weights });
    res.status(200).json({ results: result.results, total: result.results.length, queryTimeMs: result.queryTimeMs, scopesSearched: result.scopesSearched, debug: result.debug });
  } catch (e: unknown) { console.error('[api] kb/search', e); res.status(500).json({ error: 'Internal server error' }); }
}
