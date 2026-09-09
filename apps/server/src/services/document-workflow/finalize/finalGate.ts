/**
 * finalGate：门禁/评分/诊断/复核清单/telemetry（finalizeGeneration 收口段）。
 * P2 拆分（方案 5.2）：由 finalizeGeneration 代码块机械搬迁而来，业务语义逐字一致（行为保持）。
 */
import { buildDocumentReviewChecklist } from '../documentReviewChecklist';
import { qualitySeveritySummary } from '../qualityValidation';
import { buildDocumentTelemetryReport } from '../documentTelemetry';
import { buildProfessionalScoreReport } from '../documentProfessionalScore';
import { reviewTemplatingSemantics } from '../templatingReview';
import { callBreakdownTopDetails, callBreakdownTopSummary, phaseWaterfallDetails, slowMetricSummary } from '../documentGeneratorHelpers';
import { displayStage } from '../progress';
import type { FinalizeSession } from './finalizeSession';

export async function stageFinalGate(session: FinalizeSession): Promise<void> {
  session.reviewChecklist = buildDocumentReviewChecklist({ exportGate: session.qualityBundle.finalExportGate, qualityReport: session.qualityBundle.qualityReport, repairStrategies: session.qualityBundle.repairStrategies });
  const finalQualitySummary = qualitySeveritySummary(session.validationIssues);
  // 4.12.12：质量口径对齐——最终质量汇总须先累加进 diagnostics 再构建 telemetry（此前 telemetry
  // 构建在累加之前，导致 qualityIssues 缺失修复循环后的最终残留汇总）；阻断数以导出门禁实际残留为准，
  // 避免「telemetry 阻断 0 但导出门禁 N 阻断」的修复轮口径脱节
  session.generationDiagnostics.quality.blockingCount += finalQualitySummary.blocking;
  session.generationDiagnostics.quality.importantCount += finalQualitySummary.important;
  session.generationDiagnostics.quality.minorCount += finalQualitySummary.minor;
  session.telemetry = buildDocumentTelemetryReport({ diagnostics: session.generationDiagnostics });
  const blockingCount = session.qualityBundle.finalExportGate.blockingIssues.length;
  session.telemetry.qualityIssues.blockingCount = blockingCount;
  session.professionalScore = await buildProfessionalScoreReport(session.finalChapterDrafts, session.finalMarkdown, { templating: session.qualityBundle.qualityReport.templating });
  // A2 语义级模板化复核（仅 A1 风险信号命中时触发一次 LLM，失败静默降级）
  session.templatingReview = session.qualityBundle.qualityReport.templating
    ? await session.withProgressHeartbeat(() => reviewTemplatingSemantics({ templating: session.qualityBundle.qualityReport.templating!, markdown: session.finalMarkdown, diagnostics: session.generationDiagnostics, signal: session.signal }))
    : { issues: [], reviewed: false };
  // 阶段展示终态直接汇总（历史 export_ready/document-workflow/agent-reviewer-repairer 状态修正分支已随旧管线删除）
  session.finalStages = [...session.executionStages, ...session.finalGateRepairStages];
  // 门禁 details 全量持久化：阻断问题逐条落盘不截断（第九次回归实测 39 条阻断只落 12 条，
  // 生成后审查无法按执行阶段复盘全部阻断根因；检测器侧已各自限幅、阻断总数有界，无膨胀风险）
  session.finalStages.push(displayStage({ type: 'validation', roleId: 'agent-final-gate', status: session.qualityBundle.finalExportGate.passed ? 'success' : 'failed', message: session.qualityBundle.finalExportGate.passed ? 'Agent 最终门禁通过' : `Agent 最终门禁阻断 ${blockingCount} 个问题`, details: session.qualityBundle.finalExportGate.blockingIssues.map(issue => issue.message) }, { subtitle: 'Agent 最终门禁' }));
  const confidenceBelowFloor = session.qualityBundle.qualityReport.deliveryProbability < 70;
  session.finalStages.push(displayStage({ type: 'validation', roleId: 'document-delivery-score', status: session.qualityBundle.qualityReport.passed ? 'success' : session.qualityBundle.finalExportGate.passed ? 'skipped' : 'failed', message: session.qualityBundle.finalExportGate.passed && !session.qualityBundle.qualityReport.passed ? `${session.qualityBundle.qualityReport.summary}${confidenceBelowFloor ? '；置信度低于 70%，建议完成续修后再交付归档' : '（导出门禁已通过，作为后续优化建议归档）'}` : session.qualityBundle.qualityReport.summary, details: confidenceBelowFloor && session.qualityBundle.finalExportGate.passed ? [...session.qualityBundle.qualityReport.actions, '续修建议：交付置信度低于 70% 门槛，建议按交付复核清单补齐短板维度后重新生成或续修。'] : session.qualityBundle.qualityReport.actions }, { subtitle: '交付评分' }));
  session.finalStages.push(displayStage({ type: 'validation', roleId: 'document-professional-score', status: session.professionalScore.grade === '专业' || session.professionalScore.grade === '良好' ? 'success' : 'skipped', message: session.professionalScore.summary, details: [...session.professionalScore.dimensions.map(dimension => `${dimension.label}：${dimension.score} 分（${dimension.detail}）`), ...session.professionalScore.topIssues.map(issue => `待修复：${issue}`)] }, { subtitle: '专业度评分' }));
  if (session.qualityBundle.qualityReport.templating && session.qualityBundle.qualityReport.templating.level !== 'light') {
    session.finalStages.push(displayStage({ type: 'validation', roleId: 'document-templating-report', status: 'skipped', message: `模板化检测：${session.qualityBundle.qualityReport.templating.level === 'heavy' ? '重度' : '中度'}模板化（套话句占比 ${(session.qualityBundle.qualityReport.templating.fillerRatio * 100).toFixed(1)}%，重难点归因＋量化双达标占比 ${(session.qualityBundle.qualityReport.templating.difficultyCountermeasureRatio * 100).toFixed(0)}%，模糊应答词 ${session.qualityBundle.qualityReport.templating.vagueHitCount} 处）`, details: session.templatingReview.issues }, { subtitle: '模板化检测' }));
  }
  if (session.writingTaskBrief) {
    session.finalStages.push(displayStage({ type: 'reference', roleId: 'document-writing-task-brief', status: 'success', message: `写作任务书：${session.writingTaskBrief.documentType}，${session.writingTaskBrief.chapters.length} 章任务卡，全局写作焦点 ${session.writingTaskBrief.globalWritingFocus.length} 条`, details: [...session.writingTaskBrief.globalWritingFocus, ...session.writingTaskBrief.chapters.slice(0, 10).map(chapter => `${chapter.chapterTitle}：覆盖 ${chapter.mustCover.length} 项`)], subtitle: '写作任务书' }));
  }
  session.finalStages.push(displayStage({ type: 'reference', roleId: 'knowledge-coverage', status: session.qualityBundle.knowledgeCoverage.score >= 85 ? 'success' : 'failed', message: `资料确认覆盖率：${session.qualityBundle.knowledgeCoverage.score}%（证据 ${session.qualityBundle.knowledgeCoverage.evidenceCount} 条，文件 ${session.qualityBundle.knowledgeCoverage.confirmedFiles} 份）`, details: [session.qualityBundle.knowledgeCoverage.remediation] }, { subtitle: '资料覆盖' }));
  session.finalStages.push(displayStage({ type: 'validation', roleId: 'document-review-checklist', status: session.reviewChecklist.every(item => item.passed) ? 'success' : session.qualityBundle.finalExportGate.passed ? 'skipped' : 'failed', message: `交付复核清单：通过 ${session.reviewChecklist.filter(item => item.passed).length}/${session.reviewChecklist.length}${session.qualityBundle.finalExportGate.passed && !session.reviewChecklist.every(item => item.passed) ? '（导出门禁已通过，其余项作为优化建议归档）' : ''}`, details: session.reviewChecklist.map(item => `${item.passed ? '通过' : '待修复'}：${item.label}${item.message ? `（${item.message}）` : ''}`) }, { subtitle: '交付复核' }));
  const slowMetrics = slowMetricSummary(session.generationDiagnostics.metrics);
  // 4.1 per-调用分量 Top5 输入大头（message 压缩展示 + details 五维度完整行）
  const callTopSummary = callBreakdownTopSummary(session.generationDiagnostics.llm.callBreakdown);
  // 1.1 事实净化门计数（合肥师范样本脏值形态：表格碎片/页码/标题标记/编号截断），非零才展示
  const factSanitizeMessage = session.generationDiagnostics.factSanitize
    ? `，事实净化 截断${session.generationDiagnostics.factSanitize.truncated}/丢弃${session.generationDiagnostics.factSanitize.dropped}/编号补全${session.generationDiagnostics.factSanitize.repaired}`
    : '';
  session.finalStages.push(displayStage({ type: 'validation', roleId: 'document-diagnostics', status: 'success', message: `性能统计：LLM ${session.generationDiagnostics.llm.calls} 次，失败 ${session.generationDiagnostics.llm.failures} 次，瞬态重试 ${session.generationDiagnostics.llm.retries} 次，schema 校验失败 ${session.generationDiagnostics.llm.schemaFailures} 次，峰值并行 ${session.generationDiagnostics.llm.maxActive}，检索 ${session.generationDiagnostics.evidence.searchQueries} 次/${Math.round(session.generationDiagnostics.evidence.searchMs / 1000)} 秒，证据上下文 ${session.generationDiagnostics.evidence.contextChars} 字，噪声过滤 ${session.generationDiagnostics.evidence.filteredNoise} 条，预算裁剪 ${session.generationDiagnostics.evidence.budgetDropped} 条，质量问题 阻断${session.generationDiagnostics.quality.blockingCount}/重要${session.generationDiagnostics.quality.importantCount}/轻微${session.generationDiagnostics.quality.minorCount}${factSanitizeMessage}${slowMetrics ? `，Top耗时：${slowMetrics}` : ''}${callTopSummary ? `，调用输入Top5：${callTopSummary}` : ''}`, details: [...phaseWaterfallDetails(session.generationDiagnostics.metrics), ...callBreakdownTopDetails(session.generationDiagnostics.llm.callBreakdown)] }, { subtitle: '后台诊断' }));

}
