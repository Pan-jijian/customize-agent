import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';

/** 知识库功能特性 API：返回当前使用的向量引擎、嵌入模型和解析器配置 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const embedding = getConfigStore().getEmbedding();
    const provider = String(embedding.provider);
    const embeddingProvider = provider === 'openai-compatible'
      ? `OpenAICompatibleEmbeddingProvider (${embedding.model || 'unconfigured'})`
      : `LocalTransformersEmbeddingProvider (${embedding.model || 'BAAI/bge-small-zh-v1.5'})`;
    res.status(200).json({ vectorStore: 'SQLite + HNSWLib', embeddingProvider, builtinExtractors: ['PDF/OCR', 'Office', 'Spreadsheet', 'Image OCR', 'CAD', 'Diagram', 'Structured Data'], dedupEngine: 'MinHash + SHA-256', chunker: 'BGE WordPiece TextChunker' });
  } catch (e: unknown) { console.error('[api] kb/features', e); res.status(500).json({ error: 'Internal server error' }); }
}
