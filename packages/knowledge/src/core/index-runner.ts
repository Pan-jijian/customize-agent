import type { DiffResult } from '../types.js';
import type { KnowledgeBaseManager, KnowledgeIndexProgress } from './knowledge-base-manager.js';

export interface IndexRunJob {
  relativePath?: string;
  relativePaths?: string[];
  forceReindexAll?: boolean;
  vectorMode?: 'sync' | 'defer';
  uploadOperationId?: string;
}

export interface IndexRunOutcome {
  diff: DiffResult;
  vectorStatus: ReturnType<KnowledgeBaseManager['getVectorStatus']>;
}

/**
 * 知识库索引主循环：扫描变更 → 解析分块 → 等待上传批次 → 向量化收尾。
 * 主进程直跑（CUSTOMIZE_AGENT_DISABLE_KB_CHILD_PROCESS=1）与后台子进程（kb-index-worker.cjs）
 * 共用同一实现，避免两处逐行重复导致索引行为漂移。
 * 进度上报通过 onProgress 回调交给调用方（主进程写操作日志、子进程经 IPC 转发），本函数不落盘。
 */
export async function runIndexLoop(
  project: KnowledgeBaseManager,
  job: IndexRunJob,
  onProgress: (progress: KnowledgeIndexProgress) => void,
): Promise<IndexRunOutcome> {
  let diff: DiffResult = job.relativePaths?.length
    ? await project.incrementalIndex({ vectorMode: job.vectorMode, onProgress, onlyRelativePaths: job.relativePaths })
    : job.relativePath
      ? await project.reindexFile(job.relativePath, { vectorMode: job.vectorMode, onProgress })
      : job.forceReindexAll
        ? await project.forceReindexAll({ vectorMode: job.vectorMode, onProgress })
        : await project.consumePendingIndexJobs({ vectorMode: job.vectorMode, onProgress, waitForUploadId: job.uploadOperationId });
  let idleChecks = 0;
  // 上传 session 空闲上限：批次间无新文件到达超过该时长即退出等待，避免前端中断后 worker 永久挂起
  const sessionIdleLimitMs = Math.max(60_000, Number(process.env.CUSTOMIZE_KB_UPLOAD_SESSION_IDLE_MS || 600_000));
  const maxIdleChecks = Math.max(10, Math.ceil(sessionIdleLimitMs / 1000));
  // 等待任何未关闭的上传 session（不限于本 operationId），避免重叠上传的后续批次文件无人消费
  while (!job.relativePath && !job.relativePaths?.length && (project.countPendingIndexJobs() > 0 || (project.hasOpenUploadSessions() && idleChecks < maxIdleChecks))) {
    if (project.countPendingIndexJobs() === 0) {
      idleChecks += 1;
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    idleChecks = 0;
    const nextDiff = await project.consumePendingIndexJobs({ vectorMode: job.vectorMode, onProgress, waitForUploadId: job.uploadOperationId });
    diff = {
      newFiles: [...diff.newFiles, ...nextDiff.newFiles],
      modifiedFiles: [...diff.modifiedFiles, ...nextDiff.modifiedFiles],
      deletedFiles: [...diff.deletedFiles, ...nextDiff.deletedFiles],
      unchangedCount: diff.unchangedCount + nextDiff.unchangedCount,
      mtimeOnlyCount: diff.mtimeOnlyCount + nextDiff.mtimeOnlyCount,
      skippedFiles: [...diff.skippedFiles, ...nextDiff.skippedFiles],
      hasChanges: diff.hasChanges || nextDiff.hasChanges,
      diffTimeMs: diff.diffTimeMs + nextDiff.diffTimeMs,
    };
  }
  let vectorStatus = project.getVectorStatus();
  if (job.vectorMode === 'defer' && vectorStatus.status === 'pending') {
    await project.indexVectors();
    vectorStatus = project.getVectorStatus();
  }
  return { diff, vectorStatus };
}
