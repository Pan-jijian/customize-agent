import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';
import { detectProtocol } from '@customize-agent/runtime';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'DELETE'].includes(req.method!)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const provider = req.query.provider as string;
    const store = getConfigStore();
    const cfg = store.getProvider(provider);
    if (!cfg) return res.status(404).json({ error: 'Not found' });

    if (req.method === 'DELETE') {
      const config = store.load();
      delete config.providers[provider];
      for (const tier of ['reader', 'reasoning', 'action'] as const) {
        const t = config.models[tier];
        t.list = t.list.filter((m) => m.provider !== provider);
        if (t.list.every((m) => m.name !== t.active)) t.active = t.list[0]?.name ?? '';
      }
      store.save(config);
      return res.status(200).json({ success: true });
    }

    res.status(200).json({
      name: provider,
      apiKey: cfg.apiKey ? '••••' + cfg.apiKey.slice(-4) : undefined,
      baseUrl: cfg.baseUrl,
      protocol: cfg.protocol,
      detectedProtocol: detectProtocol(provider),
      hasApiKey: !!cfg.apiKey,
      capabilities: cfg.capabilities ?? {},
    });
  } catch (e: unknown) { console.error('[api] config/providers/[provider]', e); res.status(500).json({ error: 'Internal server error' }); }
}
