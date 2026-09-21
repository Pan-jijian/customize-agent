import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalTransformersEmbeddingProvider } from '../src/embedding/embedding-provider.js';

/**
 * getPipeline 进程级静态缓存的 rejected 自愈回归（finalize 末期硬停治理）：
 * 旧实现一次加载失败后 rejected Promise 永久驻留缓存，模型路径修复后同一进程内所有嵌入调用
 * 持续失败（是「快完成时被中止」的放大器）；修复后失败即从缓存剔除，下次调用重新加载。
 * 经 createPipeline 原型注入模拟「首次失败、二次成功」，不加载真实 BGE 模型。
 */
type PipelineFactory = () => Promise<unknown>;
const proto = LocalTransformersEmbeddingProvider.prototype as unknown as { createPipeline: PipelineFactory };
const pipelinesCache = LocalTransformersEmbeddingProvider as unknown as { pipelines: Map<string, unknown> };

describe('LocalTransformersEmbeddingProvider.getPipeline 缓存自愈', () => {
  const original = proto.createPipeline;
  afterEach(() => {
    proto.createPipeline = original;
    pipelinesCache.pipelines.clear();
  });

  it('首次加载失败后从缓存剔除，下次调用重新加载成功', async () => {
    let calls = 0;
    proto.createPipeline = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('model load failed')) : Promise.resolve(async () => [[1]]);
    };
    const provider = new LocalTransformersEmbeddingProvider({ modelPath: '/fake-model-dir' });
    await expect(provider.embedDocuments(['文本'])).rejects.toThrow('model load failed');
    const vectors = await provider.embedDocuments(['文本']);
    expect(calls).toBe(2);
    expect(vectors[0]?.[0]).toBe(1);
  });

  it('并发复用同一加载中的 pipeline（同一进程不重复加载）', async () => {
    let calls = 0;
    proto.createPipeline = () => {
      calls += 1;
      return Promise.resolve(async () => [[3, 4]]);
    };
    const provider = new LocalTransformersEmbeddingProvider({ modelPath: '/fake-model-dir' });
    const [a, b] = await Promise.all([provider.embedDocuments(['x']), provider.embedDocuments(['y'])]);
    expect(calls).toBe(1);
    // 向量经 resize/归一化：[3,4] → [0.6, 0.8]
    expect(a[0]?.[0]).toBeCloseTo(0.6);
    expect(b[0]?.[1]).toBeCloseTo(0.8);
  });
});

/**
 * 批次间让出事件循环（第 5 章 r28h 挂起治理）：onnxruntime-node 的 Run 在主线程同步执行，
 * 连续大批次推理会饿死心跳/HTTP（磁盘冻结的「假死」形态）；修复后每批之间 setImmediate 让出，
 * 并每 32 批打一条进度日志供运维识别「计算中」。经 prototype 注入假 extractor，不加载真实模型。
 */
describe('LocalTransformersEmbeddingProvider 批次间让出事件循环', () => {
  const original = proto.createPipeline;
  afterEach(() => {
    proto.createPipeline = original;
    pipelinesCache.pipelines.clear();
  });

  it('批次间 setImmediate 让出：嵌入进行中事件循环宏任务可推进', async () => {
    let ticks = 0;
    let spinning = true;
    const spinLoop = (): void => {
      if (!spinning) return;
      ticks += 1;
      setImmediate(spinLoop);
    };
    setImmediate(spinLoop);
    const ticksAtBatch: number[] = [];
    proto.createPipeline = () => Promise.resolve(async (batch: unknown) => {
      ticksAtBatch.push(ticks);
      const size = Array.isArray(batch) ? batch.length : 1;
      return Array.from({ length: size }, () => [1]);
    });
    const provider = new LocalTransformersEmbeddingProvider({ modelPath: '/fake-model-dir', batchSize: 2 });
    try {
      const vectors = await provider.embedDocuments(Array.from({ length: 8 }, (_, index) => `文本${index}`));
      expect(vectors).toHaveLength(8);
    } finally {
      spinning = false;
    }
    // 无让出时整个 embed 是纯微任务链（ticks 恒 0）；让出后 check 阶段在批次间隙执行 spinLoop
    expect(ticksAtBatch).toHaveLength(4);
    expect(ticks).toBeGreaterThan(0);
    expect(ticksAtBatch[1]).toBeGreaterThan(0);
  });

  it('≥32 批打进度日志（含位置），小批量静默', async () => {
    proto.createPipeline = () => Promise.resolve(async (batch: unknown) => {
      const size = Array.isArray(batch) ? batch.length : 1;
      return Array.from({ length: size }, () => [1]);
    });
    const provider = new LocalTransformersEmbeddingProvider({ modelPath: '/fake-model-dir', batchSize: 1 });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await provider.embedDocuments(Array.from({ length: 10 }, (_, index) => `小${index}`));
      expect(logSpy.mock.calls.filter(call => String(call[0]).includes('[embed]'))).toHaveLength(0);
      await provider.embedDocuments(Array.from({ length: 33 }, (_, index) => `大${index}`));
      const progressLogs = logSpy.mock.calls.filter(call => String(call[0]).includes('[embed]'));
      expect(progressLogs).toHaveLength(1);
      expect(String(progressLogs[0]?.[0])).toContain('32/33');
    } finally {
      logSpy.mockRestore();
    }
  });
});
