/**
 * chapterIntentClassifier 单测（P17 章标题意图语义分类器）：
 * 1. 构建时一次性批量预嵌入（33 原型 + 全部章标题）；
 * 2. 锚点嵌入数量不一致抛错（无不可用降级路径）；
 * 3. 正则兜底保持（union）：历史正则命中的标题即使语义 miss 仍命中，命中集不收缩；
 * 4. 语义扩展命中：正则不含的变体标题（如「施工方案」）经语义相似度 ≥0.6 命中对应意图；
 * 5. 无关标题全 miss。
 * 语义提供者全部 mock（与 factTokenClassifier.test.ts 同模式）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedMock = vi.fn();
vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  getLocalSemanticProvider: () => ({ embedDocuments: embedMock }),
  buildSemanticSimilarity: vi.fn(),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
}));

import { buildChapterIntentClassifier } from '@/services/document-workflow/chapterIntentClassifier';

// 原型总数：laborPeak 5 + schedule 7 + blueprint 6 + basicFacts 8 + dustControl 7 = 33
const ANCHOR_COUNT = 33;

/** 全零向量：所有语义相似度为 0（纯正则兜底路径） */
function zeroEmbeddings(): void {
  embedMock.mockImplementation(async (texts: string[]) => texts.map(() => [0, 0]));
}

/** 仅「施工方案」与「施工进度计划」（schedule 组首锚点）向量为 [1,0]，其余全零 */
function semanticEmbeddings(): void {
  embedMock.mockImplementation(async (texts: string[]) => texts.map(text => (text === '施工方案' || text === '施工进度计划' ? [1, 0] : [0, 0])));
}

describe('buildChapterIntentClassifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('构建时一次性批量预嵌入全部原型与章标题', async () => {
    zeroEmbeddings();
    await buildChapterIntentClassifier(['工程概况', '施工方案']);
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock.mock.calls[0][0]).toHaveLength(ANCHOR_COUNT + 2);
  });

  it('锚点嵌入数量不一致抛错（本地语义模型无不可用降级）', async () => {
    embedMock.mockResolvedValueOnce([[1, 0]]);
    await expect(buildChapterIntentClassifier(['工程概况'])).rejects.toThrow('锚点嵌入数量不一致');
  });

  it('正则兜底保持（语义全 miss 时历史正则命中集不变）', async () => {
    zeroEmbeddings();
    const classifier = await buildChapterIntentClassifier(['劳动力安排计划', '主要资源配置计划', '施工进度计划', '工程概况', '扬尘治理措施']);
    // 蓝图权威三组历史正则映射
    expect(classifier.needsBlueprintAuthority('劳动力安排计划')).toEqual(['laborPeak']);
    expect(classifier.needsBlueprintAuthority('主要资源配置计划')).toEqual(['blueprint']);
    expect(classifier.needsBlueprintAuthority('施工进度计划')).toEqual(['schedule']);
    // 概况类 + 扬尘类
    expect(classifier.needsBasicFacts('工程概况')).toBe(true);
    expect(classifier.needsDustControl('扬尘治理措施')).toBe(true);
  });

  it('组合标题（标题+用途）语义 miss 时正则兜底原行为', async () => {
    zeroEmbeddings();
    const classifier = await buildChapterIntentClassifier(['文明施工专项方案']);
    // 构建时未嵌入组合文本 → 语义 miss → 正则兜底命中
    expect(classifier.needsDustControl('文明施工专项方案——扬尘管控')).toBe(true);
  });

  it('语义扩展命中：正则不含的变体标题经相似度 ≥0.6 命中意图', async () => {
    semanticEmbeddings();
    const classifier = await buildChapterIntentClassifier(['施工方案']);
    // 「施工方案」正则不含劳动力/资源/进度 → 原正则 miss；语义与「施工进度计划」锚点命中 → schedule
    expect(classifier.needsBlueprintAuthority('施工方案')).toEqual(['schedule']);
    // 语义未命中其他意图组且正则不含 → 不扩展误命中
    expect(classifier.needsBlueprintAuthority('施工方案')).not.toContain('laborPeak');
    expect(classifier.needsBlueprintAuthority('施工方案')).not.toContain('blueprint');
  });

  it('语义命中与正则命中并集去重（同权威不重复）', async () => {
    semanticEmbeddings();
    const classifier = await buildChapterIntentClassifier(['施工进度计划']);
    // 语义命中 schedule 且正则「进度」也命中 → 去重后仅一条
    expect(classifier.needsBlueprintAuthority('施工进度计划')).toEqual(['schedule']);
  });

  it('无关标题三意图全 miss', async () => {
    zeroEmbeddings();
    const classifier = await buildChapterIntentClassifier(['安全生产管理']);
    expect(classifier.needsBlueprintAuthority('安全生产管理')).toEqual([]);
    expect(classifier.needsBasicFacts('安全生产管理')).toBe(false);
    expect(classifier.needsDustControl('安全生产管理')).toBe(false);
  });
});
