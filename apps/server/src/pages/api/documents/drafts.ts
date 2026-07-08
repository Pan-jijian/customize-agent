import type { NextApiRequest, NextApiResponse } from 'next';
import { listDocumentDrafts, saveDocumentDraft } from '@/services/documentStoreService';
import type { GeneratedDocumentDraft } from '@/services/documentWorkflowService';

/**
 * 文档草稿 API 处理器
 * GET: 获取所有草稿列表
 * POST: 保存/更新草稿
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') return res.status(200).json({ drafts: listDocumentDrafts() });
    if (req.method === 'POST') {
      const { draft, id } = req.body as { draft?: GeneratedDocumentDraft; id?: string };
      if (!draft) return res.status(400).json({ error: 'draft required' });
      return res.status(200).json({ draft: saveDocumentDraft(draft, id) });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    console.error('[api] documents/drafts', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
