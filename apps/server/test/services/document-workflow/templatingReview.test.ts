/**
 * templatingReview 单测：A2 Reviewer 语义级复核——风险信号判定（templatingNeedsSemanticReview）
 * 与 reviewTemplatingSemantics 的触发/不触发/LLM 失败静默/问题过滤截断。llmClient 全 mock。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callDocumentLlmJsonMock } = vi.hoisted(() => ({ callDocumentLlmJsonMock: vi.fn() }));
vi.mock('@/services/document-workflow/llmClient', () => ({ callDocumentLlmJson: callDocumentLlmJsonMock }));

import { reviewTemplatingSemantics, templatingNeedsSemanticReview } from '@/services/document-workflow/templatingReview';
import type { TenderBidTemplatingReport } from '@/services/document-workflow/tenderBidScoring';
import type { DocumentGenerationDiagnostics } from '@/services/document-workflow/types';

function makeReport(overrides: Partial<TenderBidTemplatingReport> = {}): TenderBidTemplatingReport {
  return {
    level: 'light', fillerRatio: 0.05, fillerSentences: 5, totalSentences: 100,
    vagueHitCount: 0, vaguePhrases: [], duplicateSentenceRate: 0.02, crossProjectResidue: [],
    difficultyCountermeasureRatio: 0.8, difficultyBothCount: 8, difficultyCountermeasures: 10,
    difficultyHeavyTemplated: false,
    ...overrides,
  };
}

const DIAGNOSTICS = {} as DocumentGenerationDiagnostics;

describe('templatingNeedsSemanticReview', () => {
  it('重度模板化 / 模糊应答词命中 / 重难点重度模板化警示任一即触发', () => {
    expect(templatingNeedsSemanticReview(makeReport({ level: 'heavy' }))).toBe(true);
    expect(templatingNeedsSemanticReview(makeReport({ vagueHitCount: 3 }))).toBe(true);
    expect(templatingNeedsSemanticReview(makeReport({ difficultyHeavyTemplated: true }))).toBe(true);
  });

  it('轻度且无命中信号不触发', () => {
    expect(templatingNeedsSemanticReview(makeReport())).toBe(false);
    expect(templatingNeedsSemanticReview(makeReport({ level: 'medium', vagueHitCount: 0, difficultyHeavyTemplated: false }))).toBe(false);
  });
});

describe('reviewTemplatingSemantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('无风险信号时不调用 LLM，直接返回未复核', async () => {
    const result = await reviewTemplatingSemantics({ templating: makeReport(), markdown: '正文', diagnostics: DIAGNOSTICS });
    expect(result).toEqual({ issues: [], reviewed: false });
    expect(callDocumentLlmJsonMock).not.toHaveBeenCalled();
  });

  it('风险信号命中时调用 LLM 并透传问题列表', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({ issues: ['问题一', '问题二'] });
    const result = await reviewTemplatingSemantics({
      templating: makeReport({ level: 'heavy' }),
      markdown: '## 重难点分析\n基坑开挖是本项目重点难点。',
      diagnostics: DIAGNOSTICS,
    });
    expect(result).toEqual({ issues: ['问题一', '问题二'], reviewed: true });
    expect(callDocumentLlmJsonMock).toHaveBeenCalledTimes(1);
    // 提示词含确定性检测信号与待复核正文
    const prompt = callDocumentLlmJsonMock.mock.calls[0][1] as string;
    expect(prompt).toContain('模板化等级=heavy');
    expect(prompt).toContain('待复核正文');
    expect(prompt).toContain('重难点分析');
  });

  it('问题过滤非字符串与空串并截断至 6 条', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({ issues: ['a', '', 'b', 42, 'c', 'd', 'e', 'f', 'g', null] });
    const result = await reviewTemplatingSemantics({
      templating: makeReport({ vagueHitCount: 1 }),
      markdown: '正文',
      diagnostics: DIAGNOSTICS,
    });
    expect(result.issues).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(result.reviewed).toBe(true);
  });

  it('正文命中四新技术时信号摘要包含四新命中列表', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({ issues: [] });
    await reviewTemplatingSemantics({
      templating: makeReport({ level: 'heavy' }),
      markdown: '本工程采用智慧工地与预制构件技术，实现模块化施工。',
      diagnostics: DIAGNOSTICS,
    });
    const prompt = callDocumentLlmJsonMock.mock.calls[0][1] as string;
    expect(prompt).toContain('四新技术命中');
  });

  it('LLM 失败静默降级返回未复核（不阻断）', async () => {
    callDocumentLlmJsonMock.mockRejectedValue(new Error('llm down'));
    const result = await reviewTemplatingSemantics({
      templating: makeReport({ level: 'heavy' }),
      markdown: '正文',
      diagnostics: DIAGNOSTICS,
    });
    expect(result).toEqual({ issues: [], reviewed: false });
  });
});
