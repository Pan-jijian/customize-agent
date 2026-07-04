import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  if (_req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    res.status(200).json({ vectorStore: 'Qdrant', embeddingProvider: 'HashEmbeddingProvider', externalExtractors: ['DWG', 'Visio', 'OCR', 'PDF', 'Office', 'Spreadsheet'], dedupEngine: 'MinHash + SHA-256', chunker: 'TextChunker' });
  } catch (e: unknown) {
    console.error('[api] kb/features', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
