import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';
import type { EmbeddingConfig } from '@customize-agent/runtime';

function publicEmbedding(config: EmbeddingConfig) {
  return {
    ...config,
    apiKey: config.apiKey ? '••••' + config.apiKey.slice(-4) : undefined,
    hasApiKey: !!config.apiKey,
  };
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'PUT'].includes(req.method!)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const store = getConfigStore();
    if (req.method === 'PUT') {
      const body = req.body as Partial<EmbeddingConfig>;
      const previous = store.getEmbedding();
      const provider = body.provider === 'openai-compatible' || body.provider === 'transformers-local' ? body.provider : 'hash';
      const dimensions = Number(body.dimensions ?? (provider === 'hash' ? 384 : provider === 'transformers-local' ? 512 : 1024));
      const embedding: EmbeddingConfig = provider === 'hash'
        ? { provider: 'hash', dimensions: Number.isFinite(dimensions) ? dimensions : 384 }
        : provider === 'transformers-local'
          ? {
            provider: 'transformers-local',
            model: typeof body.model === 'string' ? body.model.trim() : 'BAAI/bge-small-zh-v1.5',
            dimensions: Number.isFinite(dimensions) ? dimensions : 512,
          }
          : {
            provider: 'openai-compatible',
            baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '',
            apiKey: typeof body.apiKey === 'string' && !body.apiKey.includes('•') ? body.apiKey : previous.apiKey,
            model: typeof body.model === 'string' ? body.model.trim() : '',
            dimensions: Number.isFinite(dimensions) ? dimensions : 1024,
          };
      if (embedding.provider === 'openai-compatible' && (!embedding.baseUrl || !embedding.model)) {
        return res.status(400).json({ error: 'Embedding baseUrl and model are required' });
      }
      if (embedding.provider === 'transformers-local' && !embedding.model) {
        return res.status(400).json({ error: 'Embedding model is required' });
      }
      store.setEmbedding(embedding);
      return res.status(200).json(publicEmbedding(embedding));
    }
    return res.status(200).json(publicEmbedding(store.getEmbedding()));
  } catch (e: unknown) {
    console.error('[api] config/embedding', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
