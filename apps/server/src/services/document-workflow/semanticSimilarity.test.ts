/**
 * semanticSimilarity 单测：注入 embedDocuments 的余弦相似度闭包（数量校验/向量缓存/未命中兜底）、
 * 本地语义提供者单例、3.3 全局 LRU 缓存（命中计数/淘汰/关闭开关）。本地模型实例经 vi.mock 替换，
 * 避免加载 Transformers.js 重依赖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@customize-agent/knowledge', () => {
  class LocalTransformersEmbeddingProvider {
    constructor() {
      const scope = globalThis as { __semanticProviderInstances?: unknown[] };
      scope.__semanticProviderInstances = scope.__semanticProviderInstances || [];
      scope.__semanticProviderInstances.push(this);
    }
  }
  return { LocalTransformersEmbeddingProvider };
});

import { buildSemanticSimilarity, clearEmbedCacheForTest, getLocalSemanticProvider, SEMANTIC_COVERAGE_THRESHOLD, snapshotEmbedCacheStats } from './semanticSimilarity';

describe('SEMANTIC_COVERAGE_THRESHOLD', () => {
  it('语义承接判定阈值 0.6', () => {
    expect(SEMANTIC_COVERAGE_THRESHOLD).toBe(0.6);
  });
});

describe('buildSemanticSimilarity', () => {
  beforeEach(() => {
    const scope = globalThis as { __semanticProviderInstances?: unknown[] };
    scope.__semanticProviderInstances = [];
    clearEmbedCacheForTest();
  });

  it('空输入返回恒 0 函数且不调用嵌入', async () => {
    const embed = vi.fn(async () => []);
    const similarity = await buildSemanticSimilarity([], [], embed);
    expect(similarity('任意', '文本')).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it('注入嵌入向量计算点积余弦', async () => {
    const similarity = await buildSemanticSimilarity(
      ['甲', '乙'],
      ['甲', '乙'],
      async texts => texts.map((text, index) => (text === '甲' ? [1, 0] : [0, 1])),
    );
    expect(similarity('甲', '甲')).toBe(1);
    expect(similarity('甲', '乙')).toBe(0);
  });

  it('缓存外文本返回 0（不重复嵌入）', async () => {
    // 全局 LRU 缓存按文本去重后批量嵌入：left+right 拼接的 4 条中「甲/乙」各出现 2 次，
    // miss 文本去重为 2 条，embed 只收到 2 条文本
    const embed = vi.fn(async () => [[1, 0], [0, 1]]);
    const similarity = await buildSemanticSimilarity(['甲', '乙'], ['甲', '乙'], embed);
    expect(similarity('甲', '乙')).toBe(0);
    expect(similarity('丙', '甲')).toBe(0);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('嵌入数量与输入不一致抛错', async () => {
    await expect(
      buildSemanticSimilarity(['甲', '乙'], ['丙'], async () => [[1, 0]]),
    ).rejects.toThrow('本地语义模型嵌入数量不一致');
  });
});

describe('getLocalSemanticProvider', () => {
  it('进程内共享单例（懒加载，仅构造一次）', () => {
    const first = getLocalSemanticProvider();
    const second = getLocalSemanticProvider();
    expect(second).toBe(first);
    const scope = globalThis as { __semanticProviderInstances?: unknown[] };
    expect(scope.__semanticProviderInstances).toHaveLength(1);
  });
});

describe('3.3 全局 LRU 缓存', () => {
  beforeEach(() => {
    clearEmbedCacheForTest();
  });

  it('跨构建点命中：相同文本第二次构建不再调用嵌入且计数命中', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map((text, index) => [index + 1, 0]));
    await buildSemanticSimilarity(['甲'], ['乙'], embed);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(snapshotEmbedCacheStats()).toEqual({ embedCacheHits: 0, embedCacheMisses: 2 });
    await buildSemanticSimilarity(['甲'], ['乙'], embed);
    // 第二次构建全部命中缓存，embed 不再被调用
    expect(embed).toHaveBeenCalledTimes(1);
    expect(snapshotEmbedCacheStats()).toEqual({ embedCacheHits: 2, embedCacheMisses: 2 });
  });

  it('部分命中：只对 miss 子集调用嵌入', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map((text) => (text === '丙' ? [9, 0] : [1, 0])));
    await buildSemanticSimilarity(['甲'], ['乙'], embed);
    await buildSemanticSimilarity(['甲'], ['丙'], embed);
    expect(embed).toHaveBeenCalledTimes(2);
    // 第二次构建的文本为 [甲, 丙]：甲命中、丙 miss
    expect(embed.mock.calls[1][0]).toEqual(['丙']);
    expect(snapshotEmbedCacheStats()).toEqual({ embedCacheHits: 1, embedCacheMisses: 3 });
  });

  it('LRU 淘汰：超出容量后最久未用条目被逐出', async () => {
    process.env.DOCUMENT_EMBED_CACHE_SIZE = '2';
    try {
      const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
      // 第 1 次：[甲,乙] 全 miss，缓存 {甲,乙}
      await buildSemanticSimilarity(['甲'], ['乙'], embed);
      // 第 2 次：[甲,丙]：甲命中（移到尾部）、丙 miss；写丙后缓存超容量逐出最旧=乙 → {甲,丙}
      await buildSemanticSimilarity(['甲'], ['丙'], embed);
      // 第 3 次：[乙,甲]：乙已逐出（miss 重嵌）、甲命中
      await buildSemanticSimilarity(['乙'], ['甲'], embed);
      expect(embed).toHaveBeenCalledTimes(3);
      expect(embed.mock.calls[2][0]).toEqual(['乙']);
      expect(snapshotEmbedCacheStats()).toEqual({ embedCacheHits: 2, embedCacheMisses: 4 });
    } finally {
      delete process.env.DOCUMENT_EMBED_CACHE_SIZE;
    }
  });

  it('DOCUMENT_EMBED_CACHE=0 关闭缓存：每次构建都全量嵌入且不计数', async () => {
    process.env.DOCUMENT_EMBED_CACHE = '0';
    try {
      const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
      await buildSemanticSimilarity(['甲'], ['乙'], embed);
      await buildSemanticSimilarity(['甲'], ['乙'], embed);
      expect(embed).toHaveBeenCalledTimes(2);
      expect(snapshotEmbedCacheStats()).toEqual({ embedCacheHits: 0, embedCacheMisses: 0 });
    } finally {
      delete process.env.DOCUMENT_EMBED_CACHE;
    }
  });

  it('4.12.16 证据切片级文本入缓存：第二次构建同长文本全部命中不再嵌入', async () => {
    const longText = '本项目基坑开挖深度约五点八五米，支护采用放坡喷锚体系，土方开挖分层分段进行，随挖随撑并同步开展基坑监测，坑顶四周设置截水沟、排水沟及防护栏杆并定期巡查。';
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    await buildSemanticSimilarity(['甲'], [longText], embed);
    expect(embed).toHaveBeenCalledTimes(1);
    await buildSemanticSimilarity(['甲'], [longText], embed);
    // 证据切片级文本（≤2000 字）入缓存：第二次构建全部命中，embed 不再被调用
    expect(embed).toHaveBeenCalledTimes(1);
    expect(snapshotEmbedCacheStats()).toEqual({ embedCacheHits: 2, embedCacheMisses: 2 });
  });

  it('4.12.16 超长正文（>2000 字）不写缓存——再次嵌入同文本仍 miss（不挤占 LRU）', async () => {
    const longText = `本项目基坑开挖深度约五点八五米${'，支护采用放坡喷锚体系'.repeat(400)}`;
    expect(longText.length).toBeGreaterThan(2000);
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    await buildSemanticSimilarity(['甲'], [longText], embed);
    await buildSemanticSimilarity(['甲'], [longText], embed);
    // 超长正文不缓存：第二次仍全量嵌入；短文本「甲」命中缓存；超长文本 miss 不计数（统计只反映可缓存文本）
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls[1][0]).toEqual([longText]);
    expect(snapshotEmbedCacheStats()).toEqual({ embedCacheHits: 1, embedCacheMisses: 1 });
  });
});
