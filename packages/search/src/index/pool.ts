import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import type { WorkerRequest, WorkerResponse } from './types.js';

function getWorkerPath(): string {
  return path.join(__dirname, 'worker.js');
}

/** 池中的单个 Worker 封装 */
interface PoolWorker {
  worker: Worker;
  busy: boolean;
  processedCount: number;
  id: number;
}

/** 队列中的待处理任务 */
interface QueuedTask {
  request: WorkerRequest;
  resolve: (result: WorkerResponse) => void;
  reject: (err: Error) => void;
}

/** 单个 Worker 处理文件数阈值 → 触发优雅重启防止内存泄漏 */
const MAX_FILES_PER_WORKER = 500;
/** 大文件阈值：超过此大小送 Worker Pool 异步处理 */
const LARGE_FILE_THRESHOLD = 100_000;
/** 文件大小熔断线：超过 1MB 直接跳过 */
const MAX_FILE_SIZE = 1_000_000;

/**
 * tree-sitter Worker 线程池 (ADR-7)。
 *
 * 设计要点：
 *   - 常热预热：系统启动时预拉 poolSize 个 Worker，每个预加载全部 10 种语言 WASM 语法
 *   - 阈值轮换：单个 Worker 处理 500 个文件后优雅重启，防止 WASM 内存泄漏和堆碎片化
 *   - 文件熔断：> 1MB 文件跳过，> 100KB 文件异步解析，小文件主线程同步处理
 */
export class TreeSitterWorkerPool {
  private workers: PoolWorker[] = [];
  private queue: QueuedTask[] = [];
  private nextId = 0;
  private poolSize: number;

  constructor(poolSize?: number) {
    this.poolSize = poolSize ?? Math.max(2, os.cpus().length - 1);
  }

  /** 初始化线程池：预拉起常热 Worker + 注册消息回调 */
  async init(): Promise<void> {
    const workerPath = getWorkerPath();

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(workerPath);
      const poolWorker: PoolWorker = { worker, busy: false, processedCount: 0, id: i };

      worker.on('message', (response: WorkerResponse) => {
        poolWorker.busy = false;
        poolWorker.processedCount++;

        // 阈值轮换：处理文件数达标 → 优雅重启 Worker
        if (poolWorker.processedCount >= MAX_FILES_PER_WORKER) {
          this.recycleWorker(poolWorker);
        }

        // 匹配并解析对应的排队任务
        const taskIdx = this.queue.findIndex(t => t.request.id === response.id);
        if (taskIdx >= 0) {
          const task = this.queue.splice(taskIdx, 1)[0]!;
          task.resolve(response);
        }

        // 继续分发下一个排队任务
        this.dispatchNext();
      });

      worker.on('error', (err: Error) => {
        console.warn(`[WorkerPool] Worker ${i} 异常: ${err.message}，正在替换...`);
        poolWorker.busy = false;
        this.recycleWorker(poolWorker);
        this.dispatchNext();
      });

      this.workers.push(poolWorker);
    }
  }

  /**
   * Worker 轮换：终止旧 Worker → 立即创建新 Worker → 重新加载 WASM 语法。
   * 重启期间其他 Worker 继续服务（至少保留 1 个活跃 Worker）。
   */
  private recycleWorker(poolWorker: PoolWorker): void {
    poolWorker.worker.terminate().catch(() => {});
    const newWorker = new Worker(getWorkerPath());
    newWorker.on('message', poolWorker.worker.listeners('message')[0] as (r: WorkerResponse) => void);
    newWorker.on('error', poolWorker.worker.listeners('error')[0] as (e: Error) => void);
    poolWorker.worker = newWorker;
    poolWorker.processedCount = 0;
  }

  /** 从队列取出下一个任务分发给空闲 Worker */
  private dispatchNext(): void {
    const idleWorker = this.workers.find(w => !w.busy);
    if (!idleWorker) return;

    const task = this.queue.shift();
    if (!task) return;

    idleWorker.busy = true;
    idleWorker.worker.postMessage(task.request);
  }

  /**
   * 提交文件解析任务到线程池。
   * 文件 > 1MB → 熔断，直接返回 skipped
   * 文件 ≤ 1MB → 入队等待 Worker 处理
   */
  async parseFile(filePath: string, code: string, mode: 'index' | 'validate'): Promise<WorkerResponse> {
    if (code.length > MAX_FILE_SIZE) {
      return { id: -1, skipped: true, reason: `文件超过 ${MAX_FILE_SIZE} 字节熔断线` };
    }

    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const request: WorkerRequest = { id, filePath, code, mode };
      this.queue.push({ request, resolve, reject });
      this.dispatchNext();
    });
  }

  /**
   * 判断文件是否应使用 Worker Pool 异步解析。
   * 小文件（< 100KB）主线程同步处理更快，大文件送池避免阻塞事件循环。
   */
  shouldUsePool(code: string): boolean {
    return code.length >= LARGE_FILE_THRESHOLD && code.length <= MAX_FILE_SIZE;
  }

  /** 关闭线程池：终止全部 Worker */
  async shutdown(): Promise<void> {
    for (const pw of this.workers) {
      await pw.worker.terminate();
    }
    this.workers = [];
  }

  /** 当前忙碌的 Worker 数 */
  get activeCount(): number {
    return this.workers.filter(w => w.busy).length;
  }

  /** 当前空闲的 Worker 数 */
  get idleCount(): number {
    return this.workers.filter(w => !w.busy).length;
  }
}
