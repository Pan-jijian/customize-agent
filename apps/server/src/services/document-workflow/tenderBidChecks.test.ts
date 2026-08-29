/**
 * h13c fiveElementBlockStats 单测：L2 确定性三要素前置判定（岗位/频次/闭环词面封闭表）。
 * 语义通道全部 mock：验证词面命中即可确定要素存在，不依赖 bge 块级判定。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fiveElementBlockStats } from './tenderBidChecks';

vi.mock('./semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

import { buildSemanticSimilarity } from './semanticSimilarity';

const buildSimilarityMock = vi.mocked(buildSemanticSimilarity);

type SimilarityFn = (left: string, right: string) => number;

function mockSimilarity(score: number): void {
  buildSimilarityMock.mockResolvedValue((() => score) as SimilarityFn);
}

describe('fiveElementBlockStats 确定性三要素前置判定（h13c）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('词面三要素齐全的块在 bge 全低分下仍计入闭环块（确定性判定不依赖语义）', async () => {
    mockSimilarity(0.1);
    const markdown = '项目经理每周组织不少于1次节点核查会，质检员在3日内复查并销项，确保措施落地形成闭环记录。';
    const stats = await fiveElementBlockStats(markdown);
    expect(stats.closedLoopBlocks).toBe(1);
  });

  it('无岗位/频次/闭环词面的块在 bge 全高分下不计入闭环块（词面封闭表确定性否决）', async () => {
    mockSimilarity(0.85);
    const markdown = '施工现场加强安全管理，落实各项措施确保工程顺利进行并组织检查。';
    const stats = await fiveElementBlockStats(markdown);
    expect(stats.closedLoopBlocks).toBe(0);
  });

  it('词面频次缺失时确定性 false 压倒 bge 高分（不复用语义兜底）', async () => {
    mockSimilarity(0.85);
    const markdown = '项目经理负责落实整改措施，质检员复查销项形成闭环记录，确保问题当日处理完毕。';
    const stats = await fiveElementBlockStats(markdown);
    expect(stats.closedLoopBlocks).toBe(0);
  });
});
