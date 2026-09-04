/**
 * LocalReranker 的 worker 线程宿主：cross-encoder（bge-reranker-base）ONNX 推理是 CPU 密集计算，
 * 在主线程执行会阻塞事件循环（生成场景数百组查询 × 30 候选的推理曾阻塞主线程 20-60 分钟，
 * HTTP 无响应、前端误判卡死）。推理整体下沉到本 worker，主线程仅做消息收发；
 * 请求串行处理（单次推理占满 worker 线程，并发只叠加内存无吞吐收益），模型懒加载一次常驻。
 */
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface RerankRequest {
  id: number;
  query: string;
  texts: string[];
}

let rankerPromise: Promise<unknown> | null = null;
/** 模型加载失败熔断：60 秒内快速失败，避免每个请求都重试一次分钟级加载 */
let loadDisabledUntil = 0;

function loadRanker(): Promise<unknown> {
  if (Date.now() < loadDisabledUntil) return Promise.reject(new Error('rerank worker model load is temporarily disabled after failure'));
  if (!rankerPromise) {
    rankerPromise = (async () => {
      const cacheDir = process.env.TRANSFORMERS_CACHE || path.join(os.homedir(), '.customize-agent', 'models');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      process.env.TRANSFORMERS_CACHE = cacheDir;
      // 同 local-reranker.ts：transformers 硬依赖 onnxruntime-node/sharp，必须动态导入，
      // 否则绑定缺失的平台（Windows + npm≥11.6）在本 worker 线程加载期直接崩溃。
      const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ pipeline?: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown> }>;
      const mod = await dynamicImport('@huggingface/transformers').catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`rerank 依赖 @huggingface/transformers 未安装或无法解析：${message}`);
      });
      if (!mod.pipeline) throw new Error('Transformers.js pipeline is unavailable');
      return mod.pipeline('text-classification', process.env.KB_RERANKER_MODEL || 'Xenova/bge-reranker-base', { dtype: 'q8' } as never);
    })().catch(error => {
      rankerPromise = null;
      loadDisabledUntil = Date.now() + 60_000;
      throw error;
    });
  }
  return rankerPromise;
}

function takeHeadTail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const headLength = Math.ceil(maxLength * 0.65);
  const tailLength = maxLength - headLength;
  return `${text.slice(0, headLength)}\n...\n${text.slice(-tailLength)}`;
}

function extractScore(output: unknown): number {
  const first = Array.isArray(output) ? output[0] : output;
  if (Array.isArray(first)) return extractScore(first);
  const score = Number((first as { score?: unknown } | undefined)?.score ?? 0);
  return Number.isFinite(score) ? score : 0;
}

async function handle(request: RerankRequest): Promise<number[]> {
  const ranker = await loadRanker() as (input: { text: string; text_pair: string }) => Promise<unknown>;
  const scores: number[] = [];
  const safeQuery = takeHeadTail(request.query, 240);
  for (const text of request.texts) {
    try {
      const out = await ranker({ text: safeQuery, text_pair: takeHeadTail(text, 1400) });
      scores.push(extractScore(out));
    } catch {
      scores.push(0);
    }
  }
  return scores;
}

let queue: Promise<unknown> = Promise.resolve();
parentPort?.on('message', (request: RerankRequest) => {
  queue = queue.then(async () => {
    try {
      const scores = await handle(request);
      parentPort?.postMessage({ id: request.id, scores });
    } catch (error) {
      parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
