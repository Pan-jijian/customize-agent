import type { NextApiRequest, NextApiResponse } from 'next';
import { regenerateDocumentChapter } from '@/services/documentWorkflowService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { templateId, chapterId, requirement, maxEvidencePerChapter, projectRoot } = req.body as { templateId?: string; chapterId?: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string };
    if (!templateId || !chapterId) return res.status(400).json({ error: 'templateId and chapterId required' });
    const chapter = await regenerateDocumentChapter({ templateId, chapterId, requirement, maxEvidencePerChapter, projectRoot });
    res.status(200).json({ chapter });
  } catch (e: unknown) {
    console.error('[api] documents/chapter/regenerate', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
