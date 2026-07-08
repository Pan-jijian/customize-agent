import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';
import { LocalTransformersEmbeddingProvider } from '@customize-agent/knowledge';

/**
 * Embedding 健康检查 API 处理器
 * 测试 Embedding 服务的连通性：本地模型直接推理，远程 API 发送请求验证
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 仅允许 POST 请求
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const start = Date.now();
  try {
    const embedding = getConfigStore().getEmbedding();
    // 测试本地 transformers 模型
    if (embedding.provider === 'transformers-local') {
      const provider = new LocalTransformersEmbeddingProvider({ model: embedding.model, dimensions: embedding.dimensions });
      const vector = await provider.embedQuery('ping');
      return res.status(200).json({ success: vector.length > 0, message: vector.length > 0 ? '本地语义 Embedding 可用' : '返回向量为空', latencyMs: Date.now() - start });
    }
    // 测试远程 API
    if (!embedding.baseUrl || !embedding.model) return res.status(200).json({ success: false, message: 'Embedding baseUrl/model 未配置', latencyMs: Date.now() - start });
    const response = await fetch(`${embedding.baseUrl.replace(/\/+$/u, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(embedding.apiKey ? { Authorization: `Bearer ${embedding.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: embedding.model, input: ['ping'] }),
    });
    if (!response.ok) return res.status(200).json({ success: false, message: `HTTP ${response.status}`, latencyMs: Date.now() - start });
    const payload = await response.json() as { data?: Array<{ embedding?: number[] }> };
    const vector = payload.data?.[0]?.embedding;
    return res.status(200).json({ success: Array.isArray(vector) && vector.length > 0, message: Array.isArray(vector) && vector.length > 0 ? '连接成功' : '返回向量为空', latencyMs: Date.now() - start });
  } catch (e: unknown) {
    console.error('[api] config/embedding/healthCheck', e);
    return res.status(200).json({ success: false, message: 'Health check failed', latencyMs: Date.now() - start });
  }
}
