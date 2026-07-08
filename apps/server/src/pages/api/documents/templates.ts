import type { NextApiRequest, NextApiResponse } from 'next';
import { deleteDocumentTemplate, duplicateDocumentTemplate, listDocumentTemplates, saveDocumentTemplate, validateDocumentTemplateRun, type DocumentTemplate } from '@/services/documentWorkflowService';

/**
 * 文档模板 API 处理器
 * GET: 获取模板列表或验证模板
 * POST/PUT: 创建/更新模板
 * DELETE: 删除模板
 * PATCH: 复制模板
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const validateId = String(req.query.validate || '');
      if (validateId) return res.status(200).json({ validation: await validateDocumentTemplateRun(validateId, typeof req.query.projectRoot === 'string' && req.query.projectRoot ? req.query.projectRoot : undefined) });
      return res.status(200).json({ templates: listDocumentTemplates() });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const template = req.body as DocumentTemplate;
      if (!template?.id || !template.name) return res.status(400).json({ error: 'template id and name required' });
      return res.status(200).json({ template: saveDocumentTemplate(template), templates: listDocumentTemplates() });
    }
    if (req.method === 'DELETE') {
      const templateId = String(req.query.templateId || '');
      if (!templateId) return res.status(400).json({ error: 'templateId required' });
      deleteDocumentTemplate(templateId);
      return res.status(200).json({ success: true, templates: listDocumentTemplates() });
    }
    if (req.method === 'PATCH') {
      const { templateId } = req.body as { templateId?: string };
      if (!templateId) return res.status(400).json({ error: 'templateId required' });
      return res.status(200).json({ template: duplicateDocumentTemplate(templateId), templates: listDocumentTemplates() });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    console.error('[api] documents/templates', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
