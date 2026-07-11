import type { NextApiRequest, NextApiResponse } from 'next';
import { discoverKnowledgeFiles, getProjectRoot } from '@/services/kbService';
import { withApiErrorBoundary } from '@/services/apiErrorBoundary';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const projectRoot = (req.query.projectRoot as string) || getProjectRoot();
  if (!projectRoot) return res.status(200).json({ files: [], total: 0 });
  const q = String(req.query.q || '');
  const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
  const limit = parseInt((req.query.limit as string) || '50', 10);
  const includeContent = req.query.includeContent !== '0';
  const result = await discoverKnowledgeFiles(projectRoot, { query: q, category, limit, includeContent });
  return res.status(200).json(result);
}

export default withApiErrorBoundary('api/kb/files/search', handler);
