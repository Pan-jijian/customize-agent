import type { NextApiRequest, NextApiResponse } from 'next';
import { abortGeneratedDocument, deleteGeneratedDocument, getGeneratedDocument, listGeneratedDocuments, updateGeneratedDocument } from '@/services/generatedDocumentService';

/**
 * 生成文档列表 API 处理器
 * GET: 获取单个文档（传 id）或全部文档列表
 * PUT: 更新文档字段
 * POST: 中止文档生成
 * DELETE: 删除文档
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const id = typeof req.query.id === 'string' ? req.query.id : undefined;
      if (id) {
        const record = getGeneratedDocument(id);
        if (!record) return res.status(404).json({ error: 'Document not found' });
        return res.status(200).json({ document: record });
      }
      return res.status(200).json({ documents: listGeneratedDocuments() });
    }
    if (req.method === 'PUT') {
      const { id, ...patch } = req.body as { id?: string; [key: string]: unknown };
      if (!id) return res.status(400).json({ error: 'id required' });
      const record = updateGeneratedDocument(id, patch);
      if (!record) return res.status(404).json({ error: 'Document not found' });
      return res.status(200).json({ document: record });
    }
    if (req.method === 'POST') {
      const { action, documentId } = req.body as { action?: string; documentId?: string };
      if (action === 'abort' && documentId) {
        const record = abortGeneratedDocument(documentId);
        if (!record) return res.status(409).json({ error: 'Document not found or not generating' });
        return res.status(200).json({ document: record });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }
    if (req.method === 'DELETE') {
      const id = typeof req.query.id === 'string' ? req.query.id : req.body?.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      deleteGeneratedDocument(id);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    console.error('[api] documents/generated', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
