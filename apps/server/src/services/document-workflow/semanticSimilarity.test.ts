/**
 * semanticSimilarity 单测：注入 embedDocuments 的余弦相似度闭包（数量校验/向量缓存/未命中兜底）
 * 与本地语义提供者单例。本地模型实例经 vi.mock 替换，避免加载 Transformers.js 重依赖。
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

import { buildSemanticSimilarity, getLocalSemanticProvider, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';

describe('SEMANTIC_COVERAGE_THRESHOLD', () => {
  it('语义承接判定阈值 0.6', () => {
    expect(SEMANTIC_COVERAGE_THRESHOLD).toBe(0.6);
  });
});

describe('buildSemanticSimilarity', () => {
  beforeEach(() => {
    const scope = globalThis as { __semanticProviderInstances?: unknown[] };
    scope.__semanticProviderInstances = [];
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
    // texts = [...leftTexts, ...rightTexts] 共 4 条（缓存前不去重），需返回 4 条向量
    const embed = vi.fn(async () => [[1, 0], [0, 1], [1, 0], [0, 1]]);
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
