import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'PUT'].includes(req.method!)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const store = getConfigStore();
    if (req.method === 'PUT') {
      const incoming = req.body;
      const config = store.load();
      for (const tier of ['reader', 'reasoning', 'action'] as const) {
        const tc = incoming[tier] as { active?: unknown; list?: unknown[] } | undefined;
        if (!tc || !Array.isArray(tc.list)) continue;
        config.models[tier] = {
          active: typeof tc.active === 'string' ? tc.active : '',
          list: tc.list
            .filter((entry: unknown): entry is { name: string; provider: string } => {
              const model = entry as Record<string, unknown>;
              return typeof model.name === 'string' && typeof model.provider === 'string';
            })
            .map(entry => ({ name: entry.name, provider: entry.provider })),
        };
      }
      store.save(config);
      return res.status(200).json({ success: true });
    }
    res.status(200).json(store.load().models);
  } catch (e: unknown) { console.error('[api] config/models', e); res.status(500).json({ error: 'Internal server error' }); }
}
