/**
 * h13c fiveElementBlockStats 单测：L2 确定性三要素前置判定（岗位/频次/闭环词面封闭表）。
 * 语义通道全部 mock：验证词面命中即可确定要素存在，不依赖 bge 块级判定。
 * 另有阶段五模糊应答语义升级单测：词面命中仅召回，语义 gate 复核才计套话句（负例零误杀）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVagueResponseGate, fillerDensityReport, fiveElementBlockStats } from './tenderBidChecks';

vi.mock('./semanticSimilarity', () => ({
  buildSemanticSimilarity: vi.fn(),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  // 模糊应答语义 gate 用共享 provider 嵌入：模糊词根 [1,0]、合法语境词 [0,1]、其余 [0,0]
  getLocalSemanticProvider: () => ({
    embedDocuments: async (texts: string[]) => texts.map(text => {
      const vague = /力争|基本|大致|原则上|大概|左右|尽可能|尽量/u.test(text);
      const legal = /对称|上游/u.test(text);
      return [vague && !legal ? 1 : 0, legal ? 1 : 0];
    }),
  }),
}));

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

describe('buildVagueResponseGate 模糊应答语义判定（阶段五 5.2）', () => {
  it('词面命中且语义属模糊承诺判定 true', async () => {
    const judge = await buildVagueResponseGate();
    await expect(judge(['本工程力争在合同工期内完成全部施工内容'])).resolves.toEqual([true]);
  });

  it('词面变体（基本能够满足）经语义补漏判定 true', async () => {
    const judge = await buildVagueResponseGate();
    await expect(judge(['本方案基本能够满足招标文件的技术要求'])).resolves.toEqual([true]);
  });

  it('负例零误杀：力争上游不得判模糊应答', async () => {
    const judge = await buildVagueResponseGate();
    await expect(judge(['项目部发扬力争上游的企业精神'])).resolves.toEqual([false]);
  });

  it('负例零误杀：左右对称不得判模糊应答', async () => {
    const judge = await buildVagueResponseGate();
    await expect(judge(['建筑平面采用左右对称的布局形式'])).resolves.toEqual([false]);
  });

  it('词面未命中直接短路 false（不进入语义判定）', async () => {
    const judge = await buildVagueResponseGate();
    await expect(judge(['混凝土浇筑后按规定时间养护'])).resolves.toEqual([false]);
  });
});

describe('fillerDensityReport 模糊应答语义复核（阶段五 5.2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('词面命中但语义合法（力争上游）不计套话句', async () => {
    mockSimilarity(0.1);
    const report = await fillerDensityReport('项目部发扬力争上游的企业精神持续推进各项工作。');
    expect(report.fillerSentences).toBe(0);
    expect(report.vagueCandidateSentences).toBe(1);
    expect(report.vagueSemanticSentences).toBe(0);
  });

  it('语义确认的模糊应答句计入套话句与扣分口径', async () => {
    mockSimilarity(0.1);
    const report = await fillerDensityReport('本工程力争在合同工期内完成全部施工内容。');
    expect(report.fillerSentences).toBe(1);
    expect(report.vagueSemanticSentences).toBe(1);
  });

  it('左右对称结构描述不计套话句（负例零误杀）', async () => {
    mockSimilarity(0.1);
    const report = await fillerDensityReport('建筑平面采用左右对称的布局形式组织功能分区。');
    expect(report.vagueSemanticSentences).toBe(0);
    expect(report.fillerSentences).toBe(0);
  });
});
