/**
 * P18 自动健康诊断：finalize 末尾纯读 telemetry 产出显性告警（零 LLM 成本）。
 * 四指标阈值判定（全部为 advisory 告警，不阻断生成，仅显性展示并随导出闭环报告归档）：
 * 1. prefix cache 命中率 < 40% → 固定前缀未收敛，检查 L0/L2 恒定段结构；
 * 2. reasoningTokens > 0 → disableThinking 未生效（推理 token 出现即浪费）；
 * 3. budgetDropped / raw > 30% → 证据预算裁剪过重，疑似预算配置失配；
 * 4. llm.failures / calls > 10% → LLM 失败率偏高，检查限流与重试策略。
 * 分母为零（无观测数据）时该指标不参与判定（不误报）。
 */
import type { DocumentGenerationDiagnostics } from './types';

/** 单指标阈值（全部为超出即告警的上限/下限口径） */
export const HEALTH_DIAGNOSIS_THRESHOLDS = {
  /** prefix cache 命中率下限（低于此值告警） */
  prefixCacheHitRateFloor: 0.4,
  /** 证据预算裁剪率上限（超过此值告警） */
  budgetDropRatioCeiling: 0.3,
  /** LLM 失败率上限（超过此值告警） */
  llmFailureRateCeiling: 0.1,
} as const;

export interface AutomaticHealthDiagnosisResult {
  /** 显性告警文案（供进度 stage 展示与导出闭环报告归档） */
  alerts: string[];
  /** 各指标观测值（分母为零时为 null，不参与判定） */
  metrics: {
    prefixCacheHitRate: number | null;
    reasoningTokens: number;
    budgetDropRatio: number | null;
    llmFailureRate: number | null;
  };
}

/** 纯读诊断数据判定告警：无任何副作用，可离线单测 */
export function runAutomaticHealthDiagnosis(diagnostics: DocumentGenerationDiagnostics): AutomaticHealthDiagnosisResult {
  const alerts: string[] = [];
  const hit = diagnostics.llm.promptCacheHitTokens ?? 0;
  const miss = diagnostics.llm.promptCacheMissTokens ?? 0;
  const cacheTotal = hit + miss;
  const prefixCacheHitRate = cacheTotal > 0 ? hit / cacheTotal : null;
  if (prefixCacheHitRate !== null && prefixCacheHitRate < HEALTH_DIAGNOSIS_THRESHOLDS.prefixCacheHitRateFloor) {
    alerts.push(`固定前缀缓存命中率 ${(prefixCacheHitRate * 100).toFixed(1)}% 低于 40%：固定前缀未收敛，检查 L0/L2 恒定段结构`);
  }
  const reasoningTokens = diagnostics.llm.reasoningTokens ?? 0;
  if (reasoningTokens > 0) {
    alerts.push(`推理 token 累计 ${reasoningTokens}：disableThinking 未生效，检查模型 provider 配置`);
  }
  const budgetDropRatio = diagnostics.evidence.raw > 0 ? diagnostics.evidence.budgetDropped / diagnostics.evidence.raw : null;
  if (budgetDropRatio !== null && budgetDropRatio > HEALTH_DIAGNOSIS_THRESHOLDS.budgetDropRatioCeiling) {
    alerts.push(`证据预算裁剪 ${(budgetDropRatio * 100).toFixed(1)}%（${diagnostics.evidence.budgetDropped}/${diagnostics.evidence.raw}）：裁剪过重，疑似预算配置失配`);
  }
  const llmFailureRate = diagnostics.llm.calls > 0 ? diagnostics.llm.failures / diagnostics.llm.calls : null;
  if (llmFailureRate !== null && llmFailureRate > HEALTH_DIAGNOSIS_THRESHOLDS.llmFailureRateCeiling) {
    alerts.push(`LLM 失败率 ${(llmFailureRate * 100).toFixed(1)}%（${diagnostics.llm.failures}/${diagnostics.llm.calls}）：失败率偏高，检查限流与重试策略`);
  }
  return { alerts, metrics: { prefixCacheHitRate, reasoningTokens, budgetDropRatio, llmFailureRate } };
}
