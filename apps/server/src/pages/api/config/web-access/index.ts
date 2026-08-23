import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/common/configService';
import type { WebAccessConfig } from '@/services/document-workflow/types';

function publicWebAccess(config: Partial<WebAccessConfig>): WebAccessConfig {
  const maxQueriesPerChapter = Number(config.maxQueriesPerChapter ?? 2);
  const maxResultsPerQuery = Number(config.maxResultsPerQuery ?? 3);
  return {
    enabled: config.enabled === true,
    allowProjectFacts: false,
    maxQueriesPerChapter: Number.isFinite(maxQueriesPerChapter) ? Math.min(4, Math.max(1, Math.floor(maxQueriesPerChapter))) : 2,
    maxResultsPerQuery: Number.isFinite(maxResultsPerQuery) ? Math.min(5, Math.max(1, Math.floor(maxResultsPerQuery))) : 3,
    trustedDomains: Array.isArray(config.trustedDomains) ? config.trustedDomains.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()).slice(0, 30) : [],
  };
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'PUT'].includes(req.method!)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const store = getConfigStore() as unknown as { load: () => { webAccess?: WebAccessConfig }; save: (config: { webAccess?: WebAccessConfig }) => { webAccess?: WebAccessConfig } };
    const current = publicWebAccess(store.load().webAccess || { enabled: false, allowProjectFacts: false, maxQueriesPerChapter: 2, maxResultsPerQuery: 3, trustedDomains: [] });
    if (req.method === 'PUT') {
      const body = req.body as Partial<WebAccessConfig>;
      const next = publicWebAccess({ ...current, ...body, allowProjectFacts: false });
      const saved = store.save({ ...store.load(), webAccess: next });
      return res.status(200).json(publicWebAccess(saved.webAccess || next));
    }
    return res.status(200).json(current);
  } catch (error: unknown) {
    console.error('[api] config/web-access', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
