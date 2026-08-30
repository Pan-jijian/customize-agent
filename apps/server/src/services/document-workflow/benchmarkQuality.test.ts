/**
 * benchmarkQuality 单测：质量对标评分纯计算——ratioScore/duplicationScore 口径、
 * 工序链最低目标、5 指标逐项达成率与加权总分。参考库基准与画像提取均 mock。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildReferenceQualityProfileMock, suggestProjectTypeMock, referenceBenchmarkForTypeMock } = vi.hoisted(() => ({
  buildReferenceQualityProfileMock: vi.fn(),
  suggestProjectTypeMock: vi.fn(),
  referenceBenchmarkForTypeMock: vi.fn(),
}));
vi.mock('./referenceQualityProfile', () => ({
  buildReferenceQualityProfile: buildReferenceQualityProfileMock,
  suggestProjectType: suggestProjectTypeMock,
}));
vi.mock('./templateReferenceService', () => ({
  referenceBenchmarkForType: referenceBenchmarkForTypeMock,
}));

import { benchmarkGeneratedMarkdown } from './benchmarkQuality';

const LONG_MARKDOWN = `${'本工程施工组织设计围绕项目概况与施工部署展开。'.repeat(25)}`;

const REFERENCE_PROFILE = {
  wordCount: 3000, effectiveWordCount: 2500,
  paramDensity: 10, paramCount: 25,
  arrowChainCoverage: 0.05, duplicationRate: 0.1,
  tableCount: 10, sectionCount: 20, subsectionCount: 30, subitemCount: 40,
};

function mockBenchmark(profile = REFERENCE_PROFILE) {
  suggestProjectTypeMock.mockReturnValue('房建');
  referenceBenchmarkForTypeMock.mockReturnValue({ profile, sourceCount: 3 });
}

describe('benchmarkGeneratedMarkdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正文过短（<500 字）返回 undefined', async () => {
    expect(await benchmarkGeneratedMarkdown('太短')).toBeUndefined();
    expect(await benchmarkGeneratedMarkdown('')).toBeUndefined();
    expect(suggestProjectTypeMock).not.toHaveBeenCalled();
  });

  it('参考库无同类基准时返回 undefined', async () => {
    suggestProjectTypeMock.mockReturnValue('房建');
    referenceBenchmarkForTypeMock.mockReturnValue(undefined);
    expect(await benchmarkGeneratedMarkdown(LONG_MARKDOWN)).toBeUndefined();
  });

  it('5 项指标逐项对标（达成率封顶 120）', async () => {
    mockBenchmark();
    buildReferenceQualityProfileMock.mockResolvedValue({
      wordCount: 3000, effectiveWordCount: 2500,
      paramDensity: 16, paramCount: 40, // 16/(10*0.8)=2 → 200 → 封顶 120
      arrowChainCoverage: 0.04, // 4/8=50（目标 max(0.05,0.08)=0.08）
      duplicationRate: 0.15, // 超标：100-(0.15-0.1)*400=80
      tableCount: 3, // 3/(10*0.6)=50
      sectionCount: 10, // 10 >= 20*0.4=8 → 100
      subsectionCount: 30, subitemCount: 40,
    });
    const result = await benchmarkGeneratedMarkdown(LONG_MARKDOWN);
    expect(result?.projectType).toBe('房建');
    expect(result?.referenceSourceCount).toBe(3);
    const items = new Map(result!.items.map(item => [item.key, item]));
    expect(items.get('paramDensity')?.score).toBe(120);
    expect(items.get('paramDensity')?.passed).toBe(true);
    expect(items.get('arrowChainCoverage')?.score).toBe(50);
    expect(items.get('arrowChainCoverage')?.passed).toBe(false);
    expect(items.get('duplicationRate')?.score).toBe(80);
    expect(items.get('duplicationRate')?.passed).toBe(true);
    expect(items.get('tableCount')?.score).toBe(50);
    expect(items.get('sectionCount')?.score).toBe(100);
  });

  it('重复率未超标得满分', async () => {
    mockBenchmark();
    buildReferenceQualityProfileMock.mockResolvedValue({
      wordCount: 3000, effectiveWordCount: 2500,
      paramDensity: 10, paramCount: 25,
      arrowChainCoverage: 0.08,
      duplicationRate: 0.05, // <= 0.1 → 100
      tableCount: 10, sectionCount: 20, subsectionCount: 30, subitemCount: 40,
    });
    const result = await benchmarkGeneratedMarkdown(LONG_MARKDOWN);
    expect(result!.items.find(item => item.key === 'duplicationRate')?.score).toBe(100);
  });

  it('加权总分：参数密度 30 / 工序链 20 / 重复率 20 / 表格 15 / 章节 15', async () => {
    mockBenchmark();
    buildReferenceQualityProfileMock.mockResolvedValue({
      wordCount: 3000, effectiveWordCount: 2500,
      paramDensity: 10, paramCount: 25, // 10/8=125 → 120
      arrowChainCoverage: 0.08, // 100
      duplicationRate: 0.1, // 100
      tableCount: 10, // 10/6 → 120（封顶）
      sectionCount: 20, // 100
      subsectionCount: 30, subitemCount: 40,
    });
    const result = await benchmarkGeneratedMarkdown(LONG_MARKDOWN);
    // 120*0.3 + 100*0.2 + 100*0.2 + 120*0.15 + 100*0.15 = 36+20+20+18+15 = 109 → min(100,109)=100
    expect(result?.overallScore).toBe(100);
  });

  it('工序链参考值不足 8% 时以 8% 为最低目标', async () => {
    mockBenchmark({ ...REFERENCE_PROFILE, arrowChainCoverage: 0.02 });
    buildReferenceQualityProfileMock.mockResolvedValue({
      wordCount: 3000, effectiveWordCount: 2500,
      paramDensity: 10, paramCount: 25,
      arrowChainCoverage: 0.04, // 4/8=50
      duplicationRate: 0.1,
      tableCount: 10, sectionCount: 20, subsectionCount: 30, subitemCount: 40,
    });
    const result = await benchmarkGeneratedMarkdown(LONG_MARKDOWN);
    const arrow = result!.items.find(item => item.key === 'arrowChainCoverage');
    expect(arrow?.reference).toBe(0.08);
    expect(arrow?.score).toBe(50);
  });
});
