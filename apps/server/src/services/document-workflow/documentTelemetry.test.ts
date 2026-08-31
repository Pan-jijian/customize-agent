/**
 * documentTelemetry 单测：遥测报告汇总（慢指标 Top5/耗时/质量快照）。
 */
import { describe, expect, it } from 'vitest';
import { buildDocumentTelemetryReport } from './documentTelemetry';
import type { DocumentGenerationDiagnostics } from './types';

function makeDiagnostics(overrides: Partial<DocumentGenerationDiagnostics> = {}): DocumentGenerationDiagnostics {
  return {
    strategy: { mode: 'balanced', enableChapterReview: true, enableGlobalReview: true, enableDocumentBudgetExpansion: true, enableFinalQualityReview: true },
    metrics: [],
    llm: { calls: 0, failures: 0, maxActive: 0, retries: 0 },
    semantic: { embedCacheHits: 0, embedCacheMisses: 0 },
    evidence: { raw: 0, used: 0, filteredNoise: 0, budgetDropped: 0, avgNoiseScore: 0, avgFactDensity: 0, searchQueries: 0, searchMs: 0, contextChars: 0, t0Chars: 0, t1Chars: 0, t2Lines: 0, omittedChars: 0 },
    quality: { blockingCount: 0, importantCount: 0, minorCount: 0, repairedCount: 0 },
    ...overrides,
  };
}

describe('buildDocumentTelemetryReport', () => {
  it('汇总 LLM/证据/质量与慢指标 Top5（按耗时降序）', () => {
    const metrics = Array.from({ length: 8 }, (_, index) => ({ name: `metric-${index}`, startedAt: 0, endedAt: index, durationMs: index * 10 }));
    const report = buildDocumentTelemetryReport({
      diagnostics: makeDiagnostics({
        metrics,
        llm: { calls: 12, failures: 2, maxActive: 4, retries: 1 },
        evidence: { raw: 10, used: 8, filteredNoise: 1, budgetDropped: 1, avgNoiseScore: 0.1, avgFactDensity: 0.8, searchQueries: 5, searchMs: 100, contextChars: 3000 },
        quality: { blockingCount: 1, importantCount: 2, minorCount: 3, repairedCount: 4 },
      }),
    });
    expect(report.llmCalls).toBe(12);
    expect(report.llmFailures).toBe(2);
    expect(report.maxParallelLlm).toBe(4);
    expect(report.searchQueries).toBe(5);
    expect(report.evidenceContextChars).toBe(3000);
    expect(report.qualityIssues).toEqual({ blockingCount: 1, importantCount: 2, minorCount: 3, repairedCount: 4 });
    expect(report.slowMetrics).toHaveLength(5);
    expect(report.slowMetrics[0].name).toBe('metric-7');
    expect(report.slowMetrics[0].durationMs).toBe(70);
    expect(report.slowMetrics[4].name).toBe('metric-3');
    expect(report.elapsedMs).toBeUndefined();
  });

  it('elapsedMs 由起止时间计算', () => {
    const report = buildDocumentTelemetryReport({ diagnostics: makeDiagnostics(), startedAt: 1000, endedAt: 3500 });
    expect(report.elapsedMs).toBe(2500);
  });

  it('无起止时间不计算耗时', () => {
    const report = buildDocumentTelemetryReport({ diagnostics: makeDiagnostics(), startedAt: 1000 });
    expect(report.elapsedMs).toBeUndefined();
  });
});
