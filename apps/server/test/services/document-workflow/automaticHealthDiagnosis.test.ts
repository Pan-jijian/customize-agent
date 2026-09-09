import { describe, expect, it } from 'vitest';
import { runAutomaticHealthDiagnosis } from '@/services/document-workflow/automaticHealthDiagnosis';
import type { DocumentGenerationDiagnostics } from '@/services/document-workflow/types';

/** 最小诊断骨架：四指标分母/分子可控（其余字段零值，不参与判定） */
function diagnosticsWith(overrides: {
  hit?: number; miss?: number; reasoningTokens?: number; budgetDropped?: number; raw?: number; failures?: number; calls?: number;
}): DocumentGenerationDiagnostics {
  return {
    strategy: { mode: 'balanced', enableChapterReview: true, enableGlobalReview: true, enableDocumentBudgetExpansion: false, enableFinalQualityReview: true },
    metrics: [],
    llm: {
      calls: overrides.calls ?? 0, failures: overrides.failures ?? 0, maxActive: 1, retries: 0,
      promptCacheHitTokens: overrides.hit ?? 0, promptCacheMissTokens: overrides.miss ?? 0,
      reasoningTokens: overrides.reasoningTokens ?? 0,
    },
    semantic: { embedCacheHits: 0, embedCacheMisses: 0 },
    evidence: { raw: overrides.raw ?? 0, used: 0, filteredNoise: 0, budgetDropped: overrides.budgetDropped ?? 0, avgNoiseScore: 0, avgFactDensity: 0, searchQueries: 0, searchMs: 0, contextChars: 0, t0Chars: 0, t1Chars: 0, t2Lines: 0, omittedChars: 0 },
    quality: { blockingCount: 0, importantCount: 0, minorCount: 0, repairedCount: 0 },
  };
}

describe('runAutomaticHealthDiagnosis（P18 四指标阈值判定）', () => {
  it('全健康指标：无告警', () => {
    const result = runAutomaticHealthDiagnosis(diagnosticsWith({ hit: 800, miss: 200, reasoningTokens: 0, budgetDropped: 2, raw: 10, failures: 1, calls: 100 }));
    expect(result.alerts).toEqual([]);
    expect(result.metrics.prefixCacheHitRate).toBe(0.8);
    expect(result.metrics.reasoningTokens).toBe(0);
    expect(result.metrics.budgetDropRatio).toBe(0.2);
    expect(result.metrics.llmFailureRate).toBe(0.01);
  });

  it('prefix cache 命中率低于 40%：告警', () => {
    const result = runAutomaticHealthDiagnosis(diagnosticsWith({ hit: 30, miss: 70 }));
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain('固定前缀缓存命中率 30.0%');
  });

  it('prefix cache 命中率恰为 40%：不告警（边界）', () => {
    const result = runAutomaticHealthDiagnosis(diagnosticsWith({ hit: 40, miss: 60 }));
    expect(result.alerts).toEqual([]);
  });

  it('prefix cache 无观测（hit+miss=0）：不误报', () => {
    const result = runAutomaticHealthDiagnosis(diagnosticsWith({}));
    expect(result.alerts).toEqual([]);
    expect(result.metrics.prefixCacheHitRate).toBeNull();
  });

  it('reasoningTokens > 0：disableThinking 告警', () => {
    const result = runAutomaticHealthDiagnosis(diagnosticsWith({ reasoningTokens: 42 }));
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain('disableThinking 未生效');
  });

  it('budgetDropped/raw 超过 30%：预算裁剪告警', () => {
    const result = runAutomaticHealthDiagnosis(diagnosticsWith({ budgetDropped: 31, raw: 100 }));
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain('证据预算裁剪 31.0%');
  });

  it('budgetDropped/raw 恰为 30%：不告警（边界）；raw=0 不误报', () => {
    expect(runAutomaticHealthDiagnosis(diagnosticsWith({ budgetDropped: 30, raw: 100 })).alerts).toEqual([]);
    expect(runAutomaticHealthDiagnosis(diagnosticsWith({ budgetDropped: 5, raw: 0 })).alerts).toEqual([]);
  });

  it('llm.failures/calls 超过 10%：失败率告警', () => {
    const result = runAutomaticHealthDiagnosis(diagnosticsWith({ failures: 11, calls: 100 }));
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain('LLM 失败率 11.0%');
  });

  it('llm.failures/calls 恰为 10%：不告警（边界）；calls=0 不误报', () => {
    expect(runAutomaticHealthDiagnosis(diagnosticsWith({ failures: 10, calls: 100 })).alerts).toEqual([]);
    expect(runAutomaticHealthDiagnosis(diagnosticsWith({ failures: 3, calls: 0 })).alerts).toEqual([]);
  });

  it('全异常：4 条告警全部产出', () => {
    const result = runAutomaticHealthDiagnosis(diagnosticsWith({ hit: 10, miss: 90, reasoningTokens: 7, budgetDropped: 60, raw: 100, failures: 20, calls: 100 }));
    expect(result.alerts.length).toBe(4);
    expect(result.metrics).toEqual({ prefixCacheHitRate: 0.1, reasoningTokens: 7, budgetDropRatio: 0.6, llmFailureRate: 0.2 });
  });
});
