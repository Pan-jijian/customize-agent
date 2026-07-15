import type { NextApiRequest, NextApiResponse } from 'next';
import { deleteGeneratedDocument, getGeneratedDocument, updateGeneratedDocument } from '@/services/generatedDocumentService';

/**
 * 单个生成文档 API 处理器
 * GET: 获取指定文档
 * PUT: 更新指定文档
 * DELETE: 删除指定文档
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ error: 'id required' });
    if (req.method === 'GET') {
      const record = getGeneratedDocument(id);
      if (!record) return res.status(404).json({ error: 'Document not found' });
      if (req.query.lite === '1' && record.status === 'generating') {
        return res.status(200).json({ document: { id: record.id, taskId: record.taskId, templateId: record.templateId, templateName: record.templateName, title: record.title, requirement: record.requirement, markdown: '', status: record.status, executionStages: record.executionStages, assets: [], createdAt: record.createdAt, updatedAt: record.updatedAt, error: record.error, warningIssues: record.warningIssues } });
      }
      return res.status(200).json({ document: record });
    }
    if (req.method === 'PUT') {
      const record = updateGeneratedDocument(id, req.body || {});
      if (!record) return res.status(404).json({ error: 'Document not found' });
      return res.status(200).json({ document: record });
    }
    if (req.method === 'DELETE') {
      deleteGeneratedDocument(id);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    console.error('[api] documents/generated/[id]', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
