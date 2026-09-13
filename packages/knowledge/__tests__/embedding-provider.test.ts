import { afterEach, describe, expect, it } from 'vitest';
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
