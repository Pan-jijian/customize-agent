import type { NextApiRequest, NextApiResponse } from 'next';
import { startGenerateDocumentTask } from '@/services/document-core/generatedDocumentService';
import { withApiErrorBoundary } from '@/services/common/apiErrorBoundary';
import { validateDocumentTemplateRunCached } from '@/services/document-workflow';

/**
 * 生成文档 API 处理器
 * 接收模板 ID 和需求，启动异步文档生成任务
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 仅允许 POST 请求
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { templateId, requirement, maxEvidencePerChapter, projectRoot, resumeDocumentId } = req.body as { templateId?: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; resumeDocumentId?: string };
  // 校验必填参数
  if (!templateId) return res.status(400).json({ error: 'templateId required' });
  if (!projectRoot) return res.status(400).json({ error: 'projectRoot required' });
  // 使用带短 TTL 缓存的校验：前端模板页面刚校验过时直接复用结果，避免重复执行资料理解等昂贵检查
  const validation = await validateDocumentTemplateRunCached(templateId, projectRoot, { requirement });
  const errors = validation.issues.filter(issue => issue.level === 'error');
  if (errors.length > 0) return res.status(422).json({ error: '生成前检查未通过', validation, issues: errors });
  // 启动异步生成任务并返回任务信息
  const task = startGenerateDocumentTask({ templateId, requirement, maxEvidencePerChapter, resumeDocumentId }, projectRoot);
  res.status(202).json(task);
}

export default withApiErrorBoundary('api/documents/generate', handler);
