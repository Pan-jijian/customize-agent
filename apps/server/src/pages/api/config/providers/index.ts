import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';
import { detectProtocol } from '@customize-agent/runtime';
import { withApiErrorBoundary } from '@/services/apiErrorBoundary';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'POST'].includes(req.method!)) return res.status(405).json({ error: 'Method not allowed' });
    const store = getConfigStore();
    if (req.method === 'POST') {
      const { name, apiKey, baseUrl, protocol, directEndpoint, capabilities, oldName } = req.body;
      if (!name) return res.status(400).json({ error: 'Provider name required' });
      const targetName = String(name);
      const sourceName = oldName ? String(oldName) : targetName;
      if (sourceName !== targetName) {
        const config = store.load();
        const previous = config.providers[sourceName] ?? {};
        config.providers[targetName] = { ...previous, ...config.providers[targetName] };
        delete config.providers[sourceName];
        for (const tier of ['reader', 'reasoning', 'action'] as const) {
          const t = config.models[tier];
          t.list = t.list.map(model => model.provider === sourceName ? { ...model, provider: targetName, name: model.name === sourceName ? targetName : model.name } : model);
          if (t.active === sourceName) t.active = targetName;
        }
        store.save(config);
      }
      store.ensureProvider(targetName);
      if (apiKey !== undefined) store.setProviderKey(targetName, apiKey);
      if (baseUrl !== undefined) store.setProviderUrl(targetName, baseUrl);
      if (protocol !== undefined) store.setProviderProtocol(targetName, protocol);
      if (directEndpoint !== undefined) store.setProviderDirectEndpoint(targetName, directEndpoint === true);
      if (capabilities !== undefined && typeof capabilities === 'object') store.setProviderCapabilities(targetName, {
        imageGeneration: capabilities.imageGeneration === true,
        imageUnderstanding: capabilities.imageUnderstanding === true,
        fileUnderstanding: capabilities.fileUnderstanding === true,
        audio: capabilities.audio === true,
        video: capabilities.video === true,
      });
      const config = store.load();
      if (!config.models.action.list.some((model) => model.provider === targetName && model.name === targetName)) {
        store.addModel('action', { provider: targetName, name: targetName });
      }
      return res.status(200).json({ success: true });
    }
    const config = store.load();
    res.status(200).json(Object.entries(config.providers).map(([name, cfg]) => ({ name, apiKey: cfg.apiKey ? '••••' + cfg.apiKey.slice(-4) : undefined, baseUrl: cfg.baseUrl, protocol: cfg.protocol, directEndpoint: cfg.directEndpoint === true, detectedProtocol: detectProtocol(name), hasApiKey: !!cfg.apiKey, capabilities: cfg.capabilities ?? {} })));
}

export default withApiErrorBoundary('api/config/providers', handler);
