import { fork } from 'child_process';
import path from 'path';
import { getMultiProjectManager } from './kbService';
import { upsertKbOperation, type KbOperationStage } from './kbOperationLog';

interface WorkerProgress {
  stage: string;
  percent: number;
  message: string;
  filePath?: string;
  chunkCount?: number;
  vectorStatus?: { error?: string; status?: string };
}

interface WorkerResult {
  success: boolean;
  error?: string;
  stats?: unknown;
}

interface ActiveIndexJob {
  operationId: string;
  promise: Promise<WorkerResult>;
  startedAt: number;
}

interface IndexJob {
  id: string;
  projectRoot: string;
  vectorMode?: 'sync' | 'defer';
  uploadOperationId?: string;
  uploadTitle?: string;
  forceReindexAll?: boolean;
  relativePath?: string;
}

const activeJobs = new Map<string, ActiveIndexJob>();

function toOperationStage(stage: string): KbOperationStage {
  if (stage === 'parsing' || stage === 'chunking' || stage === 'vectorizing' || stage === 'done' || stage === 'error') return stage;
  if (stage === 'indexing') return 'chunking';
  if (stage === 'scanning') return 'uploading';
  return 'vectorizing';
}

function runInChildProcess(job: IndexJob, operationId: string, operationType: 'upload' | 'reindex', operationTitle: string): Promise<WorkerResult> {
  const workerPath = path.resolve(process.cwd(), 'scripts/kb-index-worker.cjs');
  return new Promise(resolve => {
    const child = fork(workerPath, [JSON.stringify({ ...job, operationId })], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: process.env,
    });
    child.on('error', error => {
      const message = error instanceof Error ? error.message : String(error);
      upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'error', status: 'error', percent: 100, message, error: message });
      resolve({ success: false, error: message });
    });
    child.on('exit', code => {
      if (code === 0) resolve({ success: true });
      else {
        const message = `知识库后台进程退出，退出码 ${code ?? 'unknown'}`;
        upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'error', status: 'error', percent: 100, message, error: message });
        resolve({ success: false, error: message });
      }
    });
  });
}

async function runInProcess(job: IndexJob, operationId: string, operationType: 'upload' | 'reindex', operationTitle: string): Promise<WorkerResult> {
  let project: Awaited<ReturnType<ReturnType<typeof getMultiProjectManager>['getProject']>> | undefined;
  try {
    project = await getMultiProjectManager().getProject(job.projectRoot);
    const onProgress = (progress: WorkerProgress) => upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: toOperationStage(progress.stage), status: progress.stage === 'error' ? 'error' : 'processing', percent: progress.percent, message: progress.message, filePath: progress.filePath || job.relativePath, chunkCount: progress.chunkCount, error: progress.vectorStatus?.error });
    let diff = job.relativePath
      ? await project.reindexFile(job.relativePath, { vectorMode: job.vectorMode, onProgress })
      : job.forceReindexAll
        ? await project.forceReindexAll({ vectorMode: job.vectorMode, onProgress })
        : await project.consumePendingIndexJobs({ vectorMode: job.vectorMode, onProgress, waitForUploadId: job.uploadOperationId });
    let idleChecks = 0;
    while (!job.relativePath && (project.countPendingIndexJobs() > 0 || (job.uploadOperationId && project.uploadSessionIsOpen(job.uploadOperationId) && idleChecks < 120))) {
      if (project.countPendingIndexJobs() === 0) {
        idleChecks += 1;
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      idleChecks = 0;
      const nextDiff = await project.consumePendingIndexJobs({ vectorMode: job.vectorMode, onProgress, waitForUploadId: job.uploadOperationId });
      diff = { newFiles: [...diff.newFiles, ...nextDiff.newFiles], modifiedFiles: [...diff.modifiedFiles, ...nextDiff.modifiedFiles], deletedFiles: [...diff.deletedFiles, ...nextDiff.deletedFiles], unchangedCount: diff.unchangedCount + nextDiff.unchangedCount, mtimeOnlyCount: diff.mtimeOnlyCount + nextDiff.mtimeOnlyCount, skippedFiles: [...diff.skippedFiles, ...nextDiff.skippedFiles], hasChanges: diff.hasChanges || nextDiff.hasChanges, diffTimeMs: diff.diffTimeMs + nextDiff.diffTimeMs };
    }
    const vectorStatus = project.getVectorStatus();
    if (vectorStatus.status === 'error') {
      const error = vectorStatus.error || 'HNSWLib 向量入库失败';
      upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'error', status: 'error', percent: 100, message: error, error });
      return { success: false, error, stats: { ...project.getStats(), vectorStatus } };
    }
    upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'done', status: 'success', percent: 100, message: job.relativePath ? '单文件重新解析完成' : '知识库后台索引完成', filePath: job.relativePath, fileName: job.relativePath?.split('/').pop() });
    return { success: true, stats: { ...project.getStats(), vectorStatus } };
  } catch (error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    (project as { failPendingIndexJobs?: (message: string) => void } | undefined)?.failPendingIndexJobs?.(message);
    upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'error', status: 'error', percent: 100, message, error: message });
    return { success: false, error: message };
  }
}

/** 将知识库索引任务加入队列执行，包含扫描变更、解析分块、向量化等阶段，并通过操作日志实时汇报进度 */
export function enqueueKnowledgeIndex(job: IndexJob): Promise<WorkerResult> {
  const existing = activeJobs.get(job.projectRoot);
  if (existing) return existing.promise;
  const operationId = job.uploadOperationId ?? job.id;
  const operationType = job.uploadOperationId ? 'upload' : 'reindex';
  const operationTitle = job.uploadOperationId ? `上传 ${job.uploadTitle ?? '文件'}` : job.relativePath ? `重新解析 ${job.relativePath}` : '知识库后台索引';
  upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'uploading', status: 'processing', percent: 5, message: '索引任务已进入后台队列', filePath: job.relativePath, fileName: job.relativePath?.split('/').pop() });
  const promise = (process.env.CUSTOMIZE_AGENT_DISABLE_KB_CHILD_PROCESS === '1'
    ? runInProcess(job, operationId, operationType, operationTitle)
    : runInChildProcess(job, operationId, operationType, operationTitle)
  ).finally(() => activeJobs.delete(job.projectRoot));
  activeJobs.set(job.projectRoot, { operationId, promise, startedAt: Date.now() });
  return promise;
}

export function startKnowledgeIndex(job: IndexJob): void {
  void enqueueKnowledgeIndex(job);
}

export function isKnowledgeIndexing(projectRoot: string): boolean {
  return activeJobs.has(projectRoot);
}

export function getActiveKnowledgeIndex(projectRoot: string): { operationId: string; startedAt: number } | undefined {
  const active = activeJobs.get(projectRoot);
  return active ? { operationId: active.operationId, startedAt: active.startedAt } : undefined;
}
