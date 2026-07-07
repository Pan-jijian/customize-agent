import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { upsertKbOperation, type KbOperationStage } from './kbOperationLog';

interface WorkerProgress {
  stage: KbOperationStage;
  percent: number;
  message: string;
  filePath?: string;
  chunkCount?: number;
}

interface WorkerResult {
  success: boolean;
  error?: string;
  stats?: unknown;
}

interface IndexJob {
  id: string;
  projectRoot: string;
  vectorMode?: 'sync' | 'defer';
}

const activeJobs = new Map<string, Promise<WorkerResult>>();

function getWorkerStorageRoot(): string {
  return path.join(os.homedir(), '.customize-agent');
}

function getServerDir(): string {
  const cwdServer = path.join(process.cwd(), 'apps', 'server');
  return process.cwd().endsWith(`${path.sep}apps${path.sep}server`) ? process.cwd() : cwdServer;
}

function workerSource() {
  return `
    import('node:worker_threads').then(async ({ parentPort, workerData }) => {
      const { createRequire } = await import('node:module');
      const requireFromServer = createRequire(workerData.serverDir + '/package.json');
      const knowledgeEntry = requireFromServer.resolve('@customize-agent/knowledge');
      const { MultiProjectManager } = await import(knowledgeEntry);
      const manager = new MultiProjectManager(workerData.storageRoot);
      try {
        const project = await manager.getProject(workerData.projectRoot);
        const diff = await project.incrementalIndex({
          vectorMode: workerData.vectorMode,
          onProgress: progress => parentPort.postMessage({ type: 'progress', progress }),
        });
        parentPort.postMessage({
          type: 'done',
          result: {
            success: true,
            stats: { ...project.getStats(), vectorStatus: project.getVectorStatus() },
            diff: { newFiles: diff.newFiles.length, modifiedFiles: diff.modifiedFiles.length, deletedFiles: diff.deletedFiles.length, hasChanges: diff.hasChanges },
          },
        });
      } catch (error) {
        parentPort.postMessage({ type: 'done', result: { success: false, error: error instanceof Error ? error.message : String(error) } });
      } finally {
        await manager.shutdown();
      }
    });
  `;
}

export function enqueueKnowledgeIndex(job: IndexJob): Promise<WorkerResult> {
  const existing = activeJobs.get(job.projectRoot);
  if (existing) return existing;
  upsertKbOperation(job.projectRoot, { id: job.id, type: 'reindex', title: '知识库后台索引', stage: 'uploading', status: 'processing', percent: 5, message: '索引任务已进入后台队列' });
  const promise = new Promise<WorkerResult>(resolve => {
    const worker = new Worker(workerSource(), {
      eval: true,
      workerData: {
        projectRoot: job.projectRoot,
        storageRoot: getWorkerStorageRoot(),
        serverDir: getServerDir(),
        vectorMode: job.vectorMode,
      },
    });
    worker.on('message', (message: { type?: string; progress?: WorkerProgress; result?: WorkerResult }) => {
      if (message.type === 'progress' && message.progress) {
        upsertKbOperation(job.projectRoot, {
          id: job.id,
          type: 'reindex',
          title: '知识库后台索引',
          stage: message.progress.stage,
          status: 'processing',
          percent: message.progress.percent,
          message: message.progress.message,
          filePath: message.progress.filePath,
          chunkCount: message.progress.chunkCount,
        });
      }
      if (message.type === 'done') {
        const result = message.result ?? { success: false, error: 'Worker returned empty result' };
        upsertKbOperation(job.projectRoot, {
          id: job.id,
          type: 'reindex',
          title: '知识库后台索引',
          stage: result.success ? 'done' : 'error',
          status: result.success ? 'success' : 'error',
          percent: 100,
          message: result.success ? '知识库后台索引完成' : (result.error ?? '知识库后台索引失败'),
          error: result.error,
        });
        resolve(result);
        worker.terminate().catch(() => undefined);
      }
    });
    worker.on('error', error => {
      const message = error instanceof Error ? error.message : String(error);
      const result = { success: false, error: message };
      upsertKbOperation(job.projectRoot, { id: job.id, type: 'reindex', title: '知识库后台索引', stage: 'error', status: 'error', percent: 100, message, error: message });
      resolve(result);
    });
  }).finally(() => activeJobs.delete(job.projectRoot));
  activeJobs.set(job.projectRoot, promise);
  return promise;
}

export function startKnowledgeIndex(job: IndexJob): void {
  void enqueueKnowledgeIndex(job);
}

export function isKnowledgeIndexing(projectRoot: string): boolean {
  return activeJobs.has(projectRoot);
}
