import type { NextApiRequest, NextApiResponse } from 'next';
import { generateDocumentDraft } from '@/services/documentWorkflowService';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { templateId, requirement, maxEvidencePerChapter, projectRoot } = req.body as { templateId?: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string };
    if (!templateId) return res.status(400).json({ error: 'templateId required' });
    const draft = await generateDocumentDraft({ templateId, requirement, maxEvidencePerChapter, projectRoot });
    res.status(200).json({ draft });
  } catch (e: unknown) {
    console.error('[api] documents/generate', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
