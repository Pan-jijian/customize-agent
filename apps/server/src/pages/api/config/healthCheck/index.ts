import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';
import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';

function providerFactoryName(providerName: string, providerConfig?: { protocol?: string }): string {
  const protocol = resolveProtocol(providerName, providerConfig);
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'google') return 'google';
  if (protocol === 'ollama') return 'ollama';
  if (protocol === 'openai') {
    return ['deepseek', 'openai', 'openrouter', 'ollama'].includes(providerName) ? providerName : 'openai';
  }
  return providerName;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { provider: providerName } = req.body;
    if (!providerName) return res.status(400).json({ success: false, message: 'Provider name required' });
    const cfg = getConfigStore().getProvider(providerName);
    const start = Date.now();
    try {
      const p = createProvider(providerFactoryName(providerName, cfg), { apiKey: cfg?.apiKey, baseUrl: cfg?.baseUrl, modelName: providerName });
      const ok = await p.healthCheck();
      res.status(200).json({ success: ok, message: ok ? '连接成功' : '连接失败', latencyMs: Date.now() - start });
    } catch (err: any) { res.status(200).json({ success: false, message: err.message, latencyMs: Date.now() - start }); }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
