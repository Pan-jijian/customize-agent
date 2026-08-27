import { beforeEach, describe, expect, it, vi } from 'vitest';
import { templatingNeedsSemanticReview, reviewTemplatingSemantics } from '../src/services/document-workflow/templatingReview';
import type { TenderBidTemplatingReport } from '../src/services/document-workflow/tenderBidScoring';

const callDocumentLlmJsonMock = vi.hoisted(() => vi.fn());
vi.mock('../src/services/document-workflow/llmClient', () => ({
  callDocumentLlmJson: callDocumentLlmJsonMock,
}));

const BASE_REPORT: TenderBidTemplatingReport = {
  level: 'light',
  fillerRatio: 0.05,
  fillerSentences: 1,
  totalSentences: 20,
  vagueHitCount: 0,
  vaguePhrases: [],
  duplicateSentenceRate: 0,
  crossProjectResidue: [],
  difficultyCountermeasureRatio: 0.8,
  difficultyBothCount: 4,
  difficultyCountermeasures: 5,
  difficultyHeavyTemplated: false,
};

function diagnostics() {
  return {
    strategy: undefined,
    metrics: [],
    llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, failureStreak: 0, schemaFailures: 0 },
    evidence: { raw: 0, used: 0, filteredNoise: 0, budgetDropped: 0, avgNoiseScore: 0, avgFactDensity: 0, searchQueries: 0, searchMs: 0, contextChars: 0 },
    quality: { blockingCount: 0, importantCount: 0, minorCount: 0, repairedCount: 0 },
  } as const;
}

const HEAVY_REPORT: TenderBidTemplatingReport = { ...BASE_REPORT, level: 'heavy' as const };

beforeEach(() => {
  callDocumentLlmJsonMock.mockReset();
});

describe('templatingNeedsSemanticReview（风险信号触发条件）', () => {
  it('light 且无模糊词时不需要复核', () => {
    expect(templatingNeedsSemanticReview(BASE_REPORT)).toBe(false);
  });

  it('重度模板化触发复核', () => {
    expect(templatingNeedsSemanticReview({ ...BASE_REPORT, level: 'heavy' })).toBe(true);
  });

  it('重难点重度模板化触发复核', () => {
    expect(templatingNeedsSemanticReview({ ...BASE_REPORT, difficultyHeavyTemplated: true })).toBe(true);
  });

  it('模糊应答词命中触发复核', () => {
    expect(templatingNeedsSemanticReview({ ...BASE_REPORT, vagueHitCount: 2 })).toBe(true);
  });
});

describe('reviewTemplatingSemantics（LLM 语义级复核）', () => {
  it('无风险信号时不调用 LLM 直接返回空', async () => {
    const result = await reviewTemplatingSemantics({ templating: BASE_REPORT, markdown: '本工程基坑开挖深度为7.5米，采用灌注桩加内支撑支护体系。', diagnostics: diagnostics() as never });
    expect(result).toEqual({ issues: [], reviewed: false });
    expect(callDocumentLlmJsonMock).not.toHaveBeenCalled();
  });

  it('风险信号命中时调用 LLM 并返回复核建议', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({ issues: ['重难点识别泛化：未点明本项目基坑临近地铁的真实风险，建议补充成因与针对性对策。'] });
    const result = await reviewTemplatingSemantics({ templating: HEAVY_REPORT, markdown: '本工程基坑开挖深度为7.5米，采用灌注桩加内支撑支护体系。', diagnostics: diagnostics() as never });
    expect(callDocumentLlmJsonMock).toHaveBeenCalledTimes(1);
    expect(result.reviewed).toBe(true);
    expect(result.issues).toHaveLength(1);
    // 提示词应包含确定性检测信号与 docx 语义级复核维度
    const systemArg = callDocumentLlmJsonMock.mock.calls[0]?.[0];
    expect(String(systemArg)).toContain('重难点三级判定');
  });

  it('LLM 返回空数组或失败时静默降级不阻断', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({ issues: [] });
    const emptyResult = await reviewTemplatingSemantics({ templating: HEAVY_REPORT, markdown: '正文内容。', diagnostics: diagnostics() as never });
    expect(emptyResult).toEqual({ issues: [], reviewed: true });

    callDocumentLlmJsonMock.mockRejectedValue(new Error('llm down'));
    const failedResult = await reviewTemplatingSemantics({ templating: HEAVY_REPORT, markdown: '正文内容。', diagnostics: diagnostics() as never });
    expect(failedResult).toEqual({ issues: [], reviewed: false });
  });
});
