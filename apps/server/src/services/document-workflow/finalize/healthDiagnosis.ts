/**
 * healthDiagnosis：P18 自动健康诊断（finalize 末尾，纯读 telemetry 零 LLM 成本）。
 * 产出显性告警 stage（status:skipped 不阻断），并把告警写回 session.telemetry.healthAlerts
 * 随 reviewMetadata 归档，导出时进入 exportReports（B3 历史对比存储）。
 * 无告警时不推 stage（零噪音），生成流程行为与拆分前完全一致。
 * P2 内存峰值观测：收尾采样进程内存（rss/heap），rss 超 DOCUMENT_MEMORY_ALERT_MB（默认 3072）
 * 折入 healthAlerts——支撑 OOM 归因（进程被杀时记录只剩『生成任务已中断』，无内存侧证据无法定位）。
 */
import { runAutomaticHealthDiagnosis } from '../automaticHealthDiagnosis';
import { displayStage } from '../progress';
import type { FinalizeSession } from './finalizeSession';

function resolveMemoryAlertThresholdMb(): number {
  const raw = Number(process.env.DOCUMENT_MEMORY_ALERT_MB ?? 3072);
  return Number.isFinite(raw) && raw > 0 ? raw : 3072;
}

export async function stageHealthDiagnosis(session: FinalizeSession): Promise<void> {
  const result = runAutomaticHealthDiagnosis(session.generationDiagnostics);
  const memory = process.memoryUsage();
  const rssMb = Math.round(memory.rss / 1048576);
  const heapMb = Math.round(memory.heapUsed / 1048576);
  const thresholdMb = resolveMemoryAlertThresholdMb();
  console.log(`[gen] memory(finalize) rss=${rssMb}MB heap=${heapMb}MB threshold=${thresholdMb}MB`);
  const alerts = rssMb >= thresholdMb
    ? [...result.alerts, `进程内存 rss=${rssMb}MB 超过告警阈值 ${thresholdMb}MB：大文档生成建议 NODE_OPTIONS=--max-old-space-size=4096，并控制并发生成任务数（DOCUMENT_MAX_CONCURRENT_GENERATIONS）`]
    : result.alerts;
  session.telemetry.healthAlerts = alerts;
  if (alerts.length === 0) return;
  session.finalStages.push(displayStage({
    type: 'validation',
    roleId: 'document-health-diagnosis',
    status: 'skipped',
    message: `自动健康诊断：${alerts.length} 项告警（不阻断，供配置优化参考）`,
    details: alerts,
  }, { subtitle: '健康诊断' }));
}
