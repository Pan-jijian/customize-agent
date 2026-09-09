import type { DocumentGenerationDiagnostics, DocumentTelemetryReport } from './types';

export function buildDocumentTelemetryReport(input: { diagnostics: DocumentGenerationDiagnostics; startedAt?: number; endedAt?: number }): DocumentTelemetryReport {
  const slowMetrics = [...input.diagnostics.metrics].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5).map(metric => ({ name: metric.name, durationMs: metric.durationMs }));
  // P19 修复轮热力图构建（P25 patchGuardStats 同源）：hits=预检命中（observe 命中 + enforce 拒绝），
  // repaired=放行应用命中，failed=拒绝 + 回滚（坏内容被挡住的修复失败口径）；供导出闭环报告归档与跨文档分析
  const repairHeat: DocumentTelemetryReport['repairHeat'] = {};
  for (const [roundId, stats] of Object.entries(input.diagnostics.llm.patchGuardStats || {})) {
    repairHeat[roundId] = { hits: stats.hits + stats.rejects, repaired: stats.hits, failed: stats.rejects + (stats.rollbacks ?? 0) };
  }
  return {
    llmCalls: input.diagnostics.llm.calls,
    llmFailures: input.diagnostics.llm.failures,
    maxParallelLlm: input.diagnostics.llm.maxActive,
    searchQueries: input.diagnostics.evidence.searchQueries,
    evidenceContextChars: input.diagnostics.evidence.contextChars,
    qualityIssues: { ...input.diagnostics.quality },
    slowMetrics,
    elapsedMs: input.startedAt && input.endedAt ? input.endedAt - input.startedAt : undefined,
    repairHeat: Object.keys(repairHeat).length > 0 ? repairHeat : undefined,
  };
}
