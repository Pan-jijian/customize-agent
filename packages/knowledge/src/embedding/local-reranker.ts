import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

interface RerankWorkerResponse {
  id: number;
  scores?: number[];
  error?: string;
}

interface PendingRerankRequest {
  resolve: (scores: number[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class LocalReranker {
  private static instance: any = null;
  private static loadingPromise: Promise<any> | null = null;
  private static disabledUntil = 0;
  private static modelName = process.env.KB_RERANKER_MODEL || 'Xenova/bge-reranker-base';
  /** rerank 推理 worker 线程（懒加载常驻）；unavailable 后不再重建，本进程内回退主线程推理 */
  private static worker: Worker | null = null;
  private static workerUnavailable = false;
  private static workerNextId = 0;
  private static workerPending = new Map<number, PendingRerankRequest>();
  /** 单批（≤30 候选）推理超时：超时按失败处理，由调用方 catch 回落启发式重排 */
  private static readonly WORKER_TIMEOUT_MS = 180_000;

  public static async getInstance() {
    if (this.instance) return this.instance;
    if (Date.now() < this.disabledUntil) throw new Error('Local reranker is temporarily disabled after load failure');
    if (process.env.KB_ENABLE_LOCAL_RERANKER === 'false') throw new Error('Local reranker is disabled');

    // 使用 loadingPromise 防止高并发下的重复加载
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      const cacheDir = process.env.TRANSFORMERS_CACHE || path.join(os.homedir(), '.customize-agent', 'models');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      process.env.TRANSFORMERS_CACHE = cacheDir;

      // transformers 必须动态导入：它硬依赖 onnxruntime-node/sharp 原生绑定，静态导入会让
      // knowledge 包在模块加载期崩溃（Windows 上 npm≥11.6 阻止这两者的安装脚本，绑定缺失时
      // require 直接抛错），连带 kb-index-worker 启动失败报「kb-worker 报错退出」。
      // 动态导入把失败收敛到 rerank 路径内部，由调用方 catch 回落启发式重排。
      const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ pipeline?: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown> }>;
      const mod = await dynamicImport('@huggingface/transformers').catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`rerank 依赖 @huggingface/transformers 未安装或无法解析：${message}`);
      });
      if (!mod.pipeline) throw new Error('Transformers.js pipeline is unavailable');

      const pipe = await mod.pipeline('text-classification', this.modelName, {
        dtype: 'q8',
      } as any);

      this.instance = pipe;
      return pipe;
    })().catch(error => {
      this.loadingPromise = null;
      this.disabledUntil = Date.now() + 60_000;
      throw error;
    });

    return this.loadingPromise;
  }

  /**
   * worker 线程路径开关：默认开启（cross-encoder ONNX 推理在 worker 线程执行，主线程零阻塞）；
   * KB_RERANKER_WORKER=0/false 显式回退主线程推理（排查 worker 问题时的对照通道）
   */
  private static workerEnabled(): boolean {
    const raw = process.env.KB_RERANKER_WORKER;
    return raw !== '0' && raw !== 'false';
  }

  private static getWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (this.workerUnavailable) return null;
    try {
      // dist 编译产物同目录下存在 rerank-worker-thread.js；源码直跑（无编译产物）时回落主线程推理
      const workerPath = fileURLToPath(new URL('./rerank-worker-thread.js', import.meta.url));
      if (!fs.existsSync(workerPath)) {
        this.workerUnavailable = true;
        return null;
      }
      const worker = new Worker(workerPath);
      // unref：worker 不阻止主进程退出（常驻模型加载不应拖住进程生命周期）
      worker.unref();
      worker.on('message', (response: RerankWorkerResponse) => {
        const pending = this.workerPending.get(response.id);
        if (!pending) return;
        this.workerPending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error) pending.reject(new Error(response.error));
        else pending.resolve(response.scores || []);
      });
      worker.on('error', (error: Error) => {
        // worker 崩溃：拒绝全部在途请求（调用方回退主线程推理），本进程内不再重建 worker
        this.workerUnavailable = true;
        this.worker = null;
        for (const pending of this.workerPending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.workerPending.clear();
        worker.terminate().catch(() => {});
      });
      this.worker = worker;
      return worker;
    } catch {
      this.workerUnavailable = true;
      return null;
    }
  }

  private static rerankInWorker(query: string, texts: string[]): Promise<number[]> {
    const worker = this.getWorker();
    if (!worker) return Promise.reject(new Error('rerank worker unavailable'));
    const id = this.workerNextId++;
    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.workerPending.delete(id);
        reject(new Error('rerank worker timeout'));
      }, this.WORKER_TIMEOUT_MS);
      timer.unref?.();
      this.workerPending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, query, texts });
    });
  }

  /**
   * 对多条文本和查询进行相关性重排
   */
  public static async rerank(query: string, texts: string[]): Promise<number[]> {
    if (!texts.length) return [];

    // 优先走 worker 线程（默认）：ONNX 推理不阻塞主线程事件循环；
    // worker 不可用/失败时回退主线程推理（与历史行为一致，KB_ENABLE_LOCAL_RERANKER=false 总开关仍生效）
    if (this.workerEnabled() && process.env.KB_ENABLE_LOCAL_RERANKER !== 'false') {
      try {
        return await this.rerankInWorker(query, texts);
      } catch {
        // worker 路径失败，回落主线程推理
      }
    }

    const ranker = await this.getInstance();
    const scores: number[] = [];
    const safeQuery = this.takeHeadTail(query, 240);

    for (const text of texts) {
      try {
        const safeText = this.takeHeadTail(text, 1400);
        const out = await ranker({ text: safeQuery, text_pair: safeText });
        scores.push(this.extractScore(out));
      } catch {
        scores.push(0);
      }
    }

    return scores;
  }

  private static takeHeadTail(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    const headLength = Math.ceil(maxLength * 0.65);
    const tailLength = maxLength - headLength;
    return `${text.slice(0, headLength)}\n...\n${text.slice(-tailLength)}`;
  }

  private static extractScore(output: any): number {
    const first = Array.isArray(output) ? output[0] : output;
    if (Array.isArray(first)) return this.extractScore(first);
    const score = Number(first?.score ?? 0);
    return Number.isFinite(score) ? score : 0;
  }
}
