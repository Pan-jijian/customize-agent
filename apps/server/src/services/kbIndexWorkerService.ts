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

interface IndexJob {
  id: string;
  projectRoot: string;
  vectorMode?: 'sync' | 'defer';
}

const activeJobs = new Map<string, Promise<WorkerResult>>();

function toOperationStage(stage: string): KbOperationStage {
  if (stage === 'parsing' || stage === 'chunking' || stage === 'vectorizing' || stage === 'done' || stage === 'error') return stage;
  if (stage === 'indexing') return 'chunking';
  if (stage === 'scanning') return 'uploading';
  return 'vectorizing';
}

export function enqueueKnowledgeIndex(job: IndexJob): Promise<WorkerResult> {
  const existing = activeJobs.get(job.projectRoot);
  if (existing) return existing;
  upsertKbOperation(job.projectRoot, { id: job.id, type: 'reindex', title: '知识库后台索引', stage: 'uploading', status: 'processing', percent: 5, message: '索引任务已进入后台队列' });

  const promise = (async (): Promise<WorkerResult> => {
    try {
      const project = await getMultiProjectManager().getProject(job.projectRoot);
      const diff = await project.incrementalIndex({
        vectorMode: job.vectorMode,
        onProgress: (progress: WorkerProgress) => {
          upsertKbOperation(job.projectRoot, {
            id: job.id,
            type: 'reindex',
            title: '知识库后台索引',
            stage: toOperationStage(progress.stage),
            status: progress.stage === 'error' ? 'error' : 'processing',
            percent: progress.percent,
            message: progress.message,
            filePath: progress.filePath,
            chunkCount: progress.chunkCount,
            error: progress.vectorStatus?.error,
          });
        },
      });
      const vectorStatus = project.getVectorStatus();
      if (vectorStatus.status === 'error') {
        const error = vectorStatus.error || 'sqlite-vec 向量入库失败';
        upsertKbOperation(job.projectRoot, { id: job.id, type: 'reindex', title: '知识库后台索引', stage: 'error', status: 'error', percent: 100, message: error, error });
        return { success: false, error, stats: { ...project.getStats(), vectorStatus } };
      }
      const result = {
        success: true,
        stats: { ...project.getStats(), vectorStatus },
        diff: { newFiles: diff.newFiles.length, modifiedFiles: diff.modifiedFiles.length, deletedFiles: diff.deletedFiles.length, hasChanges: diff.hasChanges },
      };
      upsertKbOperation(job.projectRoot, { id: job.id, type: 'reindex', title: '知识库后台索引', stage: 'done', status: 'success', percent: 100, message: '知识库后台索引完成' });
      return result;
    } catch (error) {
      const message = error instanceof Error ? (error.stack || error.message) : String(error);
      upsertKbOperation(job.projectRoot, { id: job.id, type: 'reindex', title: '知识库后台索引', stage: 'error', status: 'error', percent: 100, message, error: message });
      return { success: false, error: message };
    }
  })().finally(() => activeJobs.delete(job.projectRoot));

  activeJobs.set(job.projectRoot, promise);
  return promise;
}

export function startKnowledgeIndex(job: IndexJob): void {
  void enqueueKnowledgeIndex(job);
}

export function isKnowledgeIndexing(projectRoot: string): boolean {
  return activeJobs.has(projectRoot);
}
