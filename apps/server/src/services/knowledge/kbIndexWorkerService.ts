import { fork } from 'child_process';
import path from 'path';
import { runIndexLoop, type KnowledgeIndexProgress } from '@customize-agent/knowledge';
import { getMultiProjectManager } from './kbService';
import { upsertKbOperation, type KbOperationStage } from './kbOperationLog';
import { startProjectIntelligenceBuild } from '../document-workflow/projectIntelligence';

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
  relativePaths?: string[];
}

const activeJobs = new Map<string, ActiveIndexJob>();

function normalizeWorkerOutput(chunk: unknown): string {
  return String(chunk)
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !/^Image too small to scale!!/u.test(line) && line !== 'Line cannot be recognized!!')
    .join('\n');
}

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
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: process.env,
    });
    child.stdout?.on('data', chunk => {
      const message = normalizeWorkerOutput(chunk);
      if (message) upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'parsing', status: 'processing', percent: 5, message: `后台索引输出：${message.slice(-1000)}` });
    });
    child.stderr?.on('data', chunk => {
      const message = normalizeWorkerOutput(chunk);
      if (message) upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'parsing', status: 'processing', percent: 5, message: `后台索引错误输出：${message.slice(-1000)}` });
    });
    child.on('error', error => {
      const message = error instanceof Error ? error.message : String(error);
      upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'error', status: 'error', percent: 100, message, error: message });
      resolve({ success: false, error: message });
    });
    // 操作日志单写者：子进程不再直接写 kb-operations.jsonl，进度与日志补丁经 IPC 转发由主进程统一落盘
    child.on('message', (msg: { type?: string; patch?: Parameters<typeof upsertKbOperation>[1] }) => {
      if (msg?.type === 'log' && msg?.patch) upsertKbOperation(job.projectRoot, msg.patch);
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
    const onProgress = (progress: KnowledgeIndexProgress) => upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: toOperationStage(progress.stage), status: progress.stage === 'error' ? 'error' : 'processing', percent: progress.percent, message: progress.message, filePath: progress.filePath || job.relativePath, chunkCount: progress.chunkCount, error: progress.vectorStatus?.error });
    // 索引主循环与 kb-index-worker.cjs 共用 runIndexLoop 实现，子进程只负责进程壳与日志转发
    const { vectorStatus } = await runIndexLoop(project, job, onProgress);
    if (vectorStatus.status === 'error') {
      const error = vectorStatus.error || 'HNSWLib 向量入库失败';
      upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'error', status: 'error', percent: 100, message: error, error });
      return { success: false, error, stats: { ...project.getStats(), vectorStatus } };
    }
    upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'done', status: 'success', percent: 100, message: job.relativePath ? '单文件重新解析完成，正在后台更新项目理解缓存' : '知识库后台索引完成，正在后台更新项目理解缓存', filePath: job.relativePath, fileName: job.relativePath?.split('/').pop() });
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
  const previous = activeJobs.get(job.projectRoot);
  const operationId = job.uploadOperationId ?? job.id;
  const operationType = job.uploadOperationId ? 'upload' : 'reindex';
  const operationTitle = job.uploadOperationId ? `上传 ${job.uploadTitle ?? '文件'}` : job.relativePath ? `重新解析 ${job.relativePath}` : '知识库后台索引';
  const runCurrent = () => {
    upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'uploading', status: 'processing', percent: 5, message: '索引任务已进入后台队列', filePath: job.relativePath, fileName: job.relativePath?.split('/').pop() });
    return (process.env.CUSTOMIZE_AGENT_DISABLE_KB_CHILD_PROCESS === '1'
      ? runInProcess(job, operationId, operationType, operationTitle)
      : runInChildProcess(job, operationId, operationType, operationTitle)
    ).then(result => {
      if (result.success) {
        upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'done', status: 'success', percent: 100, message: job.relativePath ? '单文件重新解析完成，正在后台更新项目理解缓存' : '知识库后台索引完成，正在后台更新项目理解缓存', filePath: job.relativePath, fileName: job.relativePath?.split('/').pop() });
        startProjectIntelligenceBuild(job.projectRoot);
      }
      return result;
    });
  };
  // 同项目已有索引任务在跑时串成链式队列：前一任务结束后继续消费新入队的文件，避免重叠上传的文件被吞
  const promise = previous ? previous.promise.then(runCurrent, runCurrent) : runCurrent();
  const entry: ActiveIndexJob = { operationId, promise, startedAt: previous?.startedAt ?? Date.now() };
  activeJobs.set(job.projectRoot, entry);
  // 仅当仍是最新链节时才清理，避免前一任务的 finally 误删后排队的新任务
  void promise.finally(() => {
    if (activeJobs.get(job.projectRoot) === entry) activeJobs.delete(job.projectRoot);
  });
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
