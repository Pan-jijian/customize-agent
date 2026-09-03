/**
 * factTokenClassifier 单测（round-13 总量口径语义分类器）：预嵌入锚点数量校验、
 * 批量分类的「频次口径不升级/总量口径升级」判定。语义提供者全部 mock。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedMock = vi.fn();
vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  getLocalSemanticProvider: () => ({ embedDocuments: embedMock }),
  buildSemanticSimilarity: vi.fn(),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
}));

import { buildFactTokenScopeClassifier } from '@/services/document-workflow/factTokenClassifier';

// SCOPE_ANCHORS 10 条（全 [1,0]）、COUNT_ANCHORS 6 条（全 [0,1]）
const SCOPE_COUNT = 10;
const COUNT_COUNT = 6;
const scopeVectors = Array.from({ length: SCOPE_COUNT }, () => [1, 0]);
const countVectors = Array.from({ length: COUNT_COUNT }, () => [0, 1]);

function mockAnchorEmbeddings(): void {
  embedMock
    .mockResolvedValueOnce(scopeVectors)
    .mockResolvedValueOnce(countVectors);
}

describe('buildFactTokenScopeClassifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('构建时批量预嵌入范围/计数锚点', async () => {
    mockAnchorEmbeddings();
    await buildFactTokenScopeClassifier();
    expect(embedMock).toHaveBeenCalledTimes(2);
    expect(embedMock.mock.calls[0][0]).toHaveLength(SCOPE_COUNT);
    expect(embedMock.mock.calls[1][0]).toHaveLength(COUNT_COUNT);
  });

  it('锚点嵌入数量不一致抛错', async () => {
    embedMock.mockResolvedValueOnce([[1, 0]]).mockResolvedValueOnce(countVectors);
    await expect(buildFactTokenScopeClassifier()).rejects.toThrow('锚点嵌入数量不一致');
  });

  it('空查询直接返回空数组', async () => {
    mockAnchorEmbeddings();
    const classifier = await buildFactTokenScopeClassifier();
    expect(await classifier.batchClassify([])).toEqual([]);
  });

  it('总量口径锚点显著（余弦 ≥0.6）→ scope', async () => {
    mockAnchorEmbeddings();
    const classifier = await buildFactTokenScopeClassifier();
    embedMock.mockResolvedValue([[1, 0]]);
    expect(await classifier.batchClassify(['计划总工期 300日历天'])).toEqual(['scope']);
  });

  it('频次计数口径显著且强于总量口径 → other（不升级）', async () => {
    mockAnchorEmbeddings();
    const classifier = await buildFactTokenScopeClassifier();
    embedMock.mockResolvedValue([[0, 1]]);
    expect(await classifier.batchClassify(['专项应急演练 4次'])).toEqual(['other']);
  });

  it('双口径均不显著 → other', async () => {
    mockAnchorEmbeddings();
    const classifier = await buildFactTokenScopeClassifier();
    embedMock.mockResolvedValue([[0.5, 0.5]]);
    expect(await classifier.batchClassify(['模糊表述'])).toEqual(['other']);
  });

  it('查询嵌入缺失/空向量 → other（不抛错）', async () => {
    mockAnchorEmbeddings();
    const classifier = await buildFactTokenScopeClassifier();
    embedMock.mockResolvedValue([[]]);
    expect(await classifier.batchClassify(['无向量查询'])).toEqual(['other']);
  });

  it('批量查询逐条独立判定', async () => {
    mockAnchorEmbeddings();
    const classifier = await buildFactTokenScopeClassifier();
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    expect(await classifier.batchClassify(['总量表述', '频次表述'])).toEqual(['scope', 'other']);
  });
});
