import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ vectorStore: 'ChromaDB (HTTP)', embeddingProvider: 'HashEmbeddingProvider', externalExtractors: ['DWG', 'Visio'], dedupEngine: 'MinHash + SHA-256', chunker: 'TextChunker' });
}
