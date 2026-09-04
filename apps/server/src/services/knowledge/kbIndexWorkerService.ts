import { fork } from 'child_process';
import fs from 'node:fs';
import path from 'path';
import { runIndexLoop, type KnowledgeIndexProgress } from '@customize-agent/knowledge';
import { getMultiProjectManager } from './kbService';
import { upsertKbOperation, type KbOperationStage } from './kbOperationLog';
import { startProjectIntelligenceBuild } from '../document-workflow/projectIntelligence';

interface WorkerResult {
  success: boolean;
  error?: string;
  /** 成功但存在降级（如向量索引不可用）时的提示信息，操作状态标记 warning */
  warning?: string;
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

/**
 * 定位后台索引 worker 脚本。历史上仅按 process.cwd() 解析，依赖启动方把 cwd 设为服务包根目录
 * （customize-web bin 确实如此，但远端用户以其他方式启动时 cwd 不可控，脚本找不到时子进程
 * 秒退退出码 1，上传报「知识库后台进程退出」）。改为多候选路径：cwd 下、cwd 逐级向上、
 * 本模块（.next 产物）逐级向上，任一命中即可。
 */
function resolveWorkerScriptPath(): string | undefined {
  const candidates = new Set<string>();
  const pushUpward = (from: string) => {
    for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
      candidates.add(path.join(dir, 'scripts/kb-index-worker.cjs'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
    }
  };
  pushUpward(process.cwd());
  if (typeof __dirname !== 'undefined') pushUpward(__dirname);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function runInChildProcess(job: IndexJob, operationId: string, operationType: 'upload' | 'reindex', operationTitle: string): Promise<WorkerResult> {
  const workerPath = resolveWorkerScriptPath();
  if (!workerPath) {
    // 脚本缺失（打包异常/启动目录不可控）：直接进程内索引，保证上传不因进程壳问题失败
    console.warn('[kb-worker] worker script not found, running index loop in-process');
    return runInProcess(job, operationId, operationType, operationTitle);
  }
  return new Promise(resolve => {
    const child = fork(workerPath, [JSON.stringify({ ...job, operationId })], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: process.env,
    });
    let settled = false;
    // 子进程 stdout/stderr 按 chunk 触发（OCR 噪声下每秒可达数十次），upsertKbOperation 每次都要全量读写
    // JSONL，直接透传会造成严重写放大。按 500ms 窗口合并追加（stdout/stderr 分开合并以保留原有前缀语义），
    // 进程退出/出错前兜底冲刷保证不丢日志。
    const pendingByPrefix = new Map<string, string[]>();
    let flushTimer: NodeJS.Timeout | null = null;
    const flushOutput = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      for (const [prefix, lines] of pendingByPrefix) {
        if (lines.length === 0) continue;
        upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'parsing', status: 'processing', percent: 5, message: `${prefix}${lines.join('\n').slice(-1000)}` });
      }
      pendingByPrefix.clear();
    };
    const queueOutput = (chunk: unknown, prefix: string) => {
      const message = normalizeWorkerOutput(chunk);
      if (!message) return;
      const lines = pendingByPrefix.get(prefix) ?? [];
      lines.push(message);
      pendingByPrefix.set(prefix, lines);
      if (!flushTimer) {
        flushTimer = setTimeout(flushOutput, 500);
        flushTimer.unref?.();
      }
    };
    child.stdout?.on('data', chunk => queueOutput(chunk, '后台索引输出：'));
    child.stderr?.on('data', chunk => queueOutput(chunk, '后台索引错误输出：'));
    child.on('error', error => {
      if (settled) return;
      settled = true;
      flushOutput();
      // spawn 级失败（node 找不到/权限/EACCES 等）：进程内兜底，远端环境差异不再阻断上传
      const message = error instanceof Error ? error.message : String(error);
      console.error('[kb-worker] spawn error, falling back to in-process indexing:', message);
      upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'parsing', status: 'processing', percent: 5, message: `后台子进程启动失败（${message}），已自动切换为主进程内索引` });
      resolve(runInProcess(job, operationId, operationType, operationTitle));
    });
    // 操作日志单写者：子进程不再直接写 kb-operations.jsonl，进度与日志补丁经 IPC 转发由主进程统一落盘
    // receivedDone/receivedError：子进程已上报终态补丁后，即使退出阶段异常
    // （fork 场景 native teardown 会 SIGABRT，子进程最后以 SIGKILL 自终结）也不覆盖已落盘结果
    let receivedDone = false;
    let receivedError = false;
    let receivedAnyIpc = false;
    let workerWarning: string | undefined;
    child.on('message', (msg: { type?: string; patch?: Parameters<typeof upsertKbOperation>[1] }) => {
      if (msg?.type === 'log' && msg?.patch) {
        receivedAnyIpc = true;
        if (msg.patch.stage === 'done') receivedDone = true;
        if (msg.patch.status === 'error') receivedError = true;
        if (msg.patch.status === 'warning') workerWarning = msg.patch.error || msg.patch.message;
        upsertKbOperation(job.projectRoot, msg.patch);
      }
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      flushOutput();
      if (code === 0 || receivedDone) {
        resolve({ success: true, warning: workerWarning });
        return;
      }
      // 子进程启动即失败（脚本加载失败、原生绑定崩溃等），从未上报任何 IPC 补丁：
      // 自动切换为进程内索引兜底，避免远端环境差异导致上传整体报「知识库后台进程退出」
      if (!receivedAnyIpc) {
        console.error('[kb-worker] exit without any IPC, falling back to in-process indexing', { operationId, code, signal });
        upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'parsing', status: 'processing', percent: 5, message: `后台子进程启动失败（退出码 ${code ?? signal ?? 'unknown'}），已自动切换为主进程内索引` });
        resolve(runInProcess(job, operationId, operationType, operationTitle));
        return;
      }
      const message = `知识库后台进程退出，退出码 ${code ?? signal ?? 'unknown'}`;
      console.error('[kb-worker] exit', { operationId, code, signal });
      if (!receivedError) {
        upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'error', status: 'error', percent: 100, message, error: message });
      }
      resolve({ success: false, error: message });
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
    // 向量索引失败/降级不阻断上传：文本解析与切片已入库，关键词检索可用，操作状态标记 warning
    const vectorWarning = vectorStatus.status === 'error'
      ? (vectorStatus.error || 'HNSWLib 向量入库失败')
      : vectorStatus.status === 'unavailable'
        ? (vectorStatus.error || 'hnswlib-node native 绑定不可用，向量索引已降级')
        : undefined;
    if (vectorWarning) {
      upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'done', status: 'warning', percent: 100, message: job.relativePath ? '单文件重新解析完成（向量索引降级），正在后台更新项目理解缓存' : '知识库后台索引完成（向量索引降级），正在后台更新项目理解缓存', filePath: job.relativePath, fileName: job.relativePath?.split('/').pop(), error: vectorWarning });
      return { success: true, warning: vectorWarning, stats: { ...project.getStats(), vectorStatus } };
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
        if (result.warning) {
          // 向量降级成功：保留 warning 状态与原因，不被通用成功补丁覆盖
          upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'done', status: 'warning', percent: 100, message: job.relativePath ? '单文件重新解析完成（向量索引降级），正在后台更新项目理解缓存' : '知识库后台索引完成（向量索引降级），正在后台更新项目理解缓存', filePath: job.relativePath, fileName: job.relativePath?.split('/').pop(), error: result.warning });
        } else {
          upsertKbOperation(job.projectRoot, { id: operationId, type: operationType, title: operationTitle, stage: 'done', status: 'success', percent: 100, message: job.relativePath ? '单文件重新解析完成，正在后台更新项目理解缓存' : '知识库后台索引完成，正在后台更新项目理解缓存', filePath: job.relativePath, fileName: job.relativePath?.split('/').pop() });
        }
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
