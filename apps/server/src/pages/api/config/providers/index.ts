import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';
import { detectProtocol } from '@customize-agent/runtime';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const store = getConfigStore();
    if (req.method === 'POST') {
      const { name, apiKey, baseUrl, protocol } = req.body;
      if (!name) return res.status(400).json({ error: 'Provider name required' });
      store.ensureProvider(name);
      if (apiKey !== undefined) store.setProviderKey(name, apiKey);
      if (baseUrl !== undefined) store.setProviderUrl(name, baseUrl);
      if (protocol !== undefined) store.setProviderProtocol(name, protocol);
      const config = store.load();
      if (!config.models.action.list.some((model) => model.provider === name && model.name === name)) {
        store.addModel('action', { provider: name, name });
      }
      return res.status(200).json({ success: true });
    }
    const config = store.load();
    res.status(200).json(Object.entries(config.providers).map(([name, cfg]) => ({ name, apiKey: cfg.apiKey ? '••••' + cfg.apiKey.slice(-4) : undefined, baseUrl: cfg.baseUrl, protocol: cfg.protocol, detectedProtocol: detectProtocol(name), hasApiKey: !!cfg.apiKey })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
