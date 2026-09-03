/**
 * stagePhrasing 单测（Q5 施工阶段划分口径一致性，round-17/18）：
 * L1 封闭结构提取 → 本地语义聚类（mock 相似度）→ 并查集聚簇 → 簇间阶段数互异才判定冲突。
 * 语义通道全部 mock，避免加载 Transformers.js 重依赖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stagePhrasingIssues } from '@/services/document-workflow/stagePhrasing';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  buildSemanticSimilarity: vi.fn(),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
}));

import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';

const buildSimilarityMock = vi.mocked(buildSemanticSimilarity);

type SimilarityFn = (leftText: string, rightText: string) => number;

function mockSimilarity(fn: SimilarityFn): void {
  buildSimilarityMock.mockResolvedValue(fn);
}

describe('stagePhrasingIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('无阶段划分句 → 不告警', async () => {
    mockSimilarity(() => 1);
    expect(await stagePhrasingIssues('本工程位于市区，周边交通便利，场地平整。')).toEqual([]);
    expect(await stagePhrasingIssues('')).toEqual([]);
  });

  it('仅一条划分句 → 不告警（无法形成互异口径）', async () => {
    mockSimilarity(() => 1);
    expect(await stagePhrasingIssues('本工程分三个阶段实施。')).toEqual([]);
  });

  it('同簇同数字 → 不告警（同一口径，即使簇数不足 2）', async () => {
    mockSimilarity(() => 1);
    const issues = await stagePhrasingIssues('本工程分三个阶段实施。\n本工程共分三个阶段组织。');
    expect(issues).toEqual([]);
  });

  it('互异簇且阶段数互异 → error（双证据防线）', async () => {
    mockSimilarity(() => 0.1);
    const issues = await stagePhrasingIssues('本工程分三个阶段实施。\n本工程划分为四个阶段组织。');
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('error');
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].category).toBe('fact_consistency');
    expect(issues[0].repairability).toBe('llm_repairable');
    expect(issues[0].message).toContain('施工阶段划分口径不统一');
    expect(issues[0].message).toContain('2 种');
  });

  it('互异簇但阶段数相同 → 不告警（零误伤优先）', async () => {
    mockSimilarity(() => 0.1);
    expect(await stagePhrasingIssues('本工程分三个阶段实施。\n本工程共分三阶段组织。')).toEqual([]);
  });

  it('标题行/表格行不参与句提取', async () => {
    mockSimilarity(() => 0.1);
    const markdown = '## 本工程分三个阶段实施\n| 本工程划分为四个阶段 |\n本工程分三个阶段实施。';
    // 仅 1 条正文划分句 → 无法形成互异口径
    expect(await stagePhrasingIssues(markdown)).toEqual([]);
  });

  it('句长 8-60 字过滤：过短划分句不参与', async () => {
    mockSimilarity(() => 0.1);
    // '分三个阶段' 5 字 < 8 → 过滤，仅剩 1 条长句
    expect(await stagePhrasingIssues('分三个阶段\n本工程划分为四个阶段组织。')).toEqual([]);
  });
});
