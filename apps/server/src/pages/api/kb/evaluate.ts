import type { NextApiRequest, NextApiResponse } from 'next';
import { getProjectRoot } from '@/services/knowledge/kbService';
import { buildAutoKbRetrievalEvalCases, evaluateKbRetrieval, type KbRetrievalEvalCase } from '@/services/knowledge/kbEvaluationService';

function parseCases(value: unknown): KbRetrievalEvalCase[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : undefined)
    .filter(Boolean)
    .map(item => ({
      id: typeof item!.id === 'string' ? item!.id : undefined,
      query: typeof item!.query === 'string' ? item!.query : '',
      relevantFiles: Array.isArray(item!.relevantFiles) ? item!.relevantFiles.filter((value): value is string => typeof value === 'string') : undefined,
      relevantSnippets: Array.isArray(item!.relevantSnippets) ? item!.relevantSnippets.filter((value): value is string => typeof value === 'string') : undefined,
      expectedTerms: Array.isArray(item!.expectedTerms) ? item!.expectedTerms.filter((value): value is string => typeof value === 'string') : undefined,
      filePaths: Array.isArray(item!.filePaths) ? item!.filePaths.filter((value): value is string => typeof value === 'string') : undefined,
      filePathPrefixes: Array.isArray(item!.filePathPrefixes) ? item!.filePathPrefixes.filter((value): value is string => typeof value === 'string') : undefined,
      topK: typeof item!.topK === 'number' ? item!.topK : undefined,
    }));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const projectRoot = typeof body.projectRoot === 'string' && body.projectRoot.trim() ? body.projectRoot : getProjectRoot();
    if (!projectRoot) return res.status(400).json({ error: 'projectRoot is required' });
    const filePaths = Array.isArray(body.filePaths) ? body.filePaths.filter((value): value is string => typeof value === 'string') : undefined;
    const filePathPrefixes = Array.isArray(body.filePathPrefixes) ? body.filePathPrefixes.filter((value): value is string => typeof value === 'string') : undefined;
    const autoGenerate = body.autoGenerate === true;
    const cases = autoGenerate
      ? await buildAutoKbRetrievalEvalCases({
        projectRoot,
        filePaths,
        filePathPrefixes,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
        perFileLimit: typeof body.perFileLimit === 'number' ? body.perFileLimit : undefined,
        fileLayer: body.fileLayer === 'document' || body.fileLayer === 'cad' || body.fileLayer === 'all' ? body.fileLayer : undefined,
        includeExtensions: Array.isArray(body.includeExtensions) ? body.includeExtensions.filter((value): value is string => typeof value === 'string') : undefined,
        excludeExtensions: Array.isArray(body.excludeExtensions) ? body.excludeExtensions.filter((value): value is string => typeof value === 'string') : undefined,
      })
      : parseCases(body.cases);
    if (cases.length === 0) return res.status(400).json({ error: 'cases is required' });
    const report = await evaluateKbRetrieval({
      projectRoot,
      cases,
      topK: typeof body.topK === 'number' ? body.topK : undefined,
      generationMode: typeof body.generationMode === 'boolean' ? body.generationMode : undefined,
      filePaths: autoGenerate ? undefined : filePaths,
      filePathPrefixes: autoGenerate ? undefined : filePathPrefixes,
      compact: typeof body.compact === 'boolean' ? body.compact : undefined,
      disableReranker: typeof body.disableReranker === 'boolean' ? body.disableReranker : undefined,
    });
    res.status(200).json(report);
  } catch (e: unknown) {
    console.error('[api] kb/evaluate', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
