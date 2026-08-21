import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot } from '@/services/knowledge/kbService';
import { upsertKbOperation } from '@/services/knowledge/kbOperationLog';
import { isKnowledgeIndexing, startKnowledgeIndex } from '@/services/knowledge/kbIndexWorkerService';

/** 并发批次上传完成通知：所有文件批次成功落盘后关闭上传会话，允许后台索引 worker 退出等待并进入向量化阶段 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId : undefined;
  const projectRoot = typeof req.body?.projectRoot === 'string' && req.body.projectRoot.trim() ? req.body.projectRoot : getProjectRoot();
  if (!uploadId) return res.status(400).json({ error: 'uploadId is required' });
  if (!projectRoot) return res.status(400).json({ error: 'Project root is required' });

  const project = await getMultiProjectManager().getProject(projectRoot);
  await project.stageUploadedFilePaths([], uploadId, 0, true);
  // 兜底：若上传期间索引 worker 未启动（如首批全为空文件）或已提前退出，确保有 worker 消费剩余入队文件
  if (project.countPendingIndexJobs() > 0 && !isKnowledgeIndexing(projectRoot)) {
    startKnowledgeIndex({ id: `${uploadId}-worker`, projectRoot, vectorMode: 'defer', uploadOperationId: uploadId, uploadTitle: '文件夹' });
  }
  const message = '文件已全部落盘，后台正在解析、切片和向量入库';
  upsertKbOperation(projectRoot, { id: uploadId, type: 'upload', title: '上传文件夹', stage: 'parsing', status: 'processing', percent: 5, message });
  return res.status(202).json({ success: true, accepted: true, operationId: uploadId });
}
