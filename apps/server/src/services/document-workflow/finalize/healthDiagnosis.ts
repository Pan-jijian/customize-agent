/**
 * healthDiagnosis：P18 自动健康诊断（finalize 末尾，纯读 telemetry 零 LLM 成本）。
 * 产出显性告警 stage（status:skipped 不阻断），并把告警写回 session.telemetry.healthAlerts
 * 随 reviewMetadata 归档，导出时进入 exportReports（B3 历史对比存储）。
 * 无告警时不推 stage（零噪音），生成流程行为与拆分前完全一致。
 */
import { runAutomaticHealthDiagnosis } from '../automaticHealthDiagnosis';
import { displayStage } from '../progress';
import type { FinalizeSession } from './finalizeSession';

export async function stageHealthDiagnosis(session: FinalizeSession): Promise<void> {
  const result = runAutomaticHealthDiagnosis(session.generationDiagnostics);
  session.telemetry.healthAlerts = result.alerts;
  if (result.alerts.length === 0) return;
  session.finalStages.push(displayStage({
    type: 'validation',
    roleId: 'document-health-diagnosis',
    status: 'skipped',
    message: `自动健康诊断：${result.alerts.length} 项告警（不阻断，供配置优化参考）`,
    details: result.alerts,
  }, { subtitle: '健康诊断' }));
}
