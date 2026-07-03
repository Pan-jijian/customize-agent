import type { NextApiRequest, NextApiResponse } from 'next';
import { getKbUploadProgress } from '@/services/kbUploadProgress';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const id = String(req.query.id ?? '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    res.status(200).json(getKbUploadProgress(id) ?? { id, stage: 'uploading', percent: 0, message: '等待上传开始', updatedAt: Date.now() });
  } catch (e: unknown) {
    console.error('[api] kb/upload/progress', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
