import type { NextApiRequest, NextApiResponse } from 'next';
import { startGenerateDocumentTask } from '@/services/generatedDocumentService';
import { withApiErrorBoundary } from '@/services/apiErrorBoundary';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { templateId, requirement, maxEvidencePerChapter, projectRoot } = req.body as { templateId?: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string };
  if (!templateId) return res.status(400).json({ error: 'templateId required' });
  const task = startGenerateDocumentTask({ templateId, requirement, maxEvidencePerChapter }, projectRoot);
  res.status(202).json(task);
}

export default withApiErrorBoundary('api/documents/generate', handler);
