import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/knowledge/kbService';
import { setKbUploadProgress } from '@/services/knowledge/kbUploadProgress';
import { upsertKbOperation } from '@/services/knowledge/kbOperationLog';

/** 并发批次上传完成通知：所有文件批次成功落盘后关闭上传会话，允许后台索引 worker 退出等待并进入向量化阶段 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId : undefined;
  const projectRoot = typeof req.body?.projectRoot === 'string' && req.body.projectRoot.trim() ? req.body.projectRoot : getProjectRoot();
  if (!uploadId) return res.status(400).json({ error: 'uploadId is required' });
  if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });

  const project = await getMultiProjectManager().getProject(projectRoot);
  await project.stageUploadedFilePaths([], uploadId, 0, true);
  const message = '文件已全部落盘，后台正在解析、切片和向量入库';
  setKbUploadProgress(uploadId, { stage: 'parsing', percent: 5, message });
  upsertKbOperation(projectRoot, { id: uploadId, type: 'upload', title: '上传文件夹', stage: 'parsing', status: 'processing', percent: 5, message });
  return res.status(202).json({ success: true, accepted: true, operationId: uploadId });
}
