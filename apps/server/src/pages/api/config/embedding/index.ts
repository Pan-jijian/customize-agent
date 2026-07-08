import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';
import type { EmbeddingConfig } from '@customize-agent/runtime';

/** 脱敏处理 Embedding 配置中的 API Key */
function publicEmbedding(config: EmbeddingConfig) {
  return {
    ...config,
    apiKey: config.apiKey ? '••••' + config.apiKey.slice(-4) : undefined,
    hasApiKey: !!config.apiKey,
  };
}

/**
 * Embedding 配置 API 处理器
 * GET: 获取当前 Embedding 配置
 * PUT: 更新 Embedding 配置（支持 two-spin 本地模型和 OpenAI 兼容 API 两种模式）
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!['GET', 'PUT'].includes(req.method!)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const store = getConfigStore();
    if (req.method === 'PUT') {
      const body = req.body as Partial<EmbeddingConfig>;
      const previous = store.getEmbedding();
      const provider = body.provider === 'openai-compatible' ? 'openai-compatible' : 'transformers-local';
      const dimensions = Number(body.dimensions ?? (provider === 'transformers-local' ? 512 : 1024));
      // 根据提供商类型构建配置：transformers-local 固定模型，openai-compatible 可自定义
      const embedding: EmbeddingConfig = provider === 'transformers-local'
        ? {
          provider: 'transformers-local',
          model: 'BAAI/bge-small-zh-v1.5',
          dimensions: 512,
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
