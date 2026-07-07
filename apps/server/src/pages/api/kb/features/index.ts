import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfigStore } from '@/services/configService';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const embedding = getConfigStore().getEmbedding();
    const provider = String(embedding.provider);
    const embeddingProvider = provider === 'openai-compatible'
      ? `OpenAICompatibleEmbeddingProvider (${embedding.model || 'unconfigured'})`
      : `LocalTransformersEmbeddingProvider (${embedding.model || 'BAAI/bge-small-zh-v1.5'})`;
    res.status(200).json({ vectorStore: 'SQLite + sqlite-vec', embeddingProvider, externalExtractors: ['DWG', 'Visio', 'OCR', 'PDF', 'Office', 'Spreadsheet'], dedupEngine: 'MinHash + SHA-256', chunker: 'TextChunker' });
  } catch (e: unknown) { console.error('[api] kb/features', e); res.status(500).json({ error: 'Internal server error' }); }
}
