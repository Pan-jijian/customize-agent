import type { NextApiRequest, NextApiResponse } from 'next';
import { getKbOperation } from '@/services/knowledge/kbOperationLog';
import { getMultiProjectManager, getProjectRoot } from '@/services/knowledge/kbService';

/** 将索引任务状态映射为前端展示阶段 */
function mapJobStage(status: string) {
  if (status === 'PARSING') return 'parsing';
  if (status === 'CHUNKING') return 'chunking';
  if (status === 'INDEXING') return 'vectorizing';
  if (status === 'SUCCESS') return 'done';
  if (status === 'ERROR') return 'error';
  return 'uploading';
}

/** 将操作日志阶段映射为前端展示阶段 */
function mapOperationStage(stage: string) {
  if (stage === 'uploading' || stage === 'parsing' || stage === 'chunking' || stage === 'vectorizing' || stage === 'done') return stage;
  if (stage === 'generating' || stage === 'validating') return 'uploading';
  return 'uploading';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const id = String(req.query.id ?? '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    const projectRoot = String(req.query.projectRoot || getProjectRoot());
    try {
      const project = await getMultiProjectManager().getProject(projectRoot);
      const jobs = project.listIndexJobsByPrefix(id);
      if (jobs.length > 0) {
        const failed = jobs.find(job => job.status === 'ERROR');
        const doneCount = jobs.filter(job => job.status === 'SUCCESS').length;
        const active = jobs.find(job => !['SUCCESS', 'ERROR'].includes(job.status)) ?? failed ?? jobs.at(-1)!;
        const percent = Math.round(jobs.reduce((sum, job) => sum + job.percent, 0) / jobs.length);
        return res.status(200).json({
          id,
          stage: failed ? 'error' : doneCount === jobs.length ? 'done' : mapJobStage(active.status),
          percent: failed ? 100 : doneCount === jobs.length ? 100 : percent,
          message: failed?.errorMessage || active.message,
          jobs,
          updatedAt: active.updatedAt,
        });
      }
    } catch {
      // 兼容旧进度缓存。
    }
    // 兜底：从持久化操作日志读取上传进度，进程重启/热更新后进度不丢失
    const operation = getKbOperation(projectRoot, id);
    if (operation) {
      return res.status(200).json({
        id,
        stage: operation.status === 'error' ? 'error' : operation.stage === 'done' ? 'done' : mapOperationStage(operation.stage),
        percent: operation.percent,
        message: operation.message,
        fileName: operation.fileName,
        error: operation.error,
        updatedAt: operation.updatedAt,
      });
    }
    res.status(200).json({ id, stage: 'uploading', percent: 0, message: '等待上传开始', updatedAt: Date.now() });
  } catch (e: unknown) {
    console.error('[api] kb/upload/progress', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
