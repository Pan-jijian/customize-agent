import type { DocumentGenerationDiagnostics, DocumentTelemetryReport } from './types';

export function buildDocumentTelemetryReport(input: { diagnostics: DocumentGenerationDiagnostics; startedAt?: number; endedAt?: number }): DocumentTelemetryReport {
  const slowMetrics = [...input.diagnostics.metrics].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5).map(metric => ({ name: metric.name, durationMs: metric.durationMs }));
  return {
    llmCalls: input.diagnostics.llm.calls,
    llmFailures: input.diagnostics.llm.failures,
    maxParallelLlm: input.diagnostics.llm.maxActive,
    searchQueries: input.diagnostics.evidence.searchQueries,
    evidenceContextChars: input.diagnostics.evidence.contextChars,
    qualityIssues: { ...input.diagnostics.quality },
    slowMetrics,
    elapsedMs: input.startedAt && input.endedAt ? input.endedAt - input.startedAt : undefined,
  };
}
