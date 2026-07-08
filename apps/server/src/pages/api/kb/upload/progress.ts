import type { NextApiRequest, NextApiResponse } from 'next';
import { getKbUploadProgress } from '@/services/kbUploadProgress';
import { getMultiProjectManager, getProjectRoot } from '@/services/kbService';

function mapJobStage(status: string) {
  if (status === 'PARSING') return 'parsing';
  if (status === 'CHUNKING') return 'chunking';
  if (status === 'INDEXING') return 'vectorizing';
  if (status === 'SUCCESS') return 'done';
  if (status === 'ERROR') return 'error';
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
    res.status(200).json(getKbUploadProgress(id) ?? { id, stage: 'uploading', percent: 0, message: '等待上传开始', updatedAt: Date.now() });
  } catch (e: unknown) {
    console.error('[api] kb/upload/progress', e);
    res.status(500).json({ error: 'Internal server error' });
  }
}
