import type { NextApiRequest, NextApiResponse } from 'next';
import { startGenerateDocumentTask } from '@/services/generatedDocumentService';
import { withApiErrorBoundary } from '@/services/apiErrorBoundary';

/**
 * 生成文档 API 处理器
 * 接收模板 ID 和需求，启动异步文档生成任务
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 仅允许 POST 请求
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { templateId, requirement, maxEvidencePerChapter, projectRoot } = req.body as { templateId?: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string };
  // 校验必填参数
  if (!templateId) return res.status(400).json({ error: 'templateId required' });
  // 启动异步生成任务并返回任务信息
  const task = startGenerateDocumentTask({ templateId, requirement, maxEvidencePerChapter }, projectRoot);
  res.status(202).json(task);
}

export default withApiErrorBoundary('api/documents/generate', handler);
