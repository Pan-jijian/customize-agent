import type { ValidationIssue } from './types';

/**
 * P9 issue 快照 provenance（失效机制）：生成阶段打包的校验 issue 快照记录其产生检测器身份
 * （ValidationIssue.provenance.detectorId），重算校验组时按 detectorId 无条件剔除旧快照，
 * 由重算链对最新 finalMarkdown 实时重跑重新生成对应新 issue：
 * - 'fact-coverage' → buildFullValidationIssues det('fact-coverage') 对 finalMarkdown 重跑；
 * - 'overview-recap' → buildStandardFinalValidationIssues det('overview-recap') 重跑（带 semanticSimilarity）；
 * - 'internal-terminology-anchor' → buildFullValidationIssues det('internal-terminology-anchor') 重跑（L1 精确词兜底确定性召回）；
 * - 'global-consistency-snapshot' / 'data-consistency-snapshot' → buildStandardFinalValidationIssues 跨章一致性类检查器实时重跑。
 * 替代旧版 4 组脆弱正则逐条匹配 message 文本的失效判定（正则与 message 措辞耦合，
 * 检测器改文案即静默失效）；旧正则的内容条件（finalMarkdown 无总述词/术语词才剔除）属保守近似，
 * provenance 版无条件剔除 + 重跑链重新判定，净效果等价或更精确（已修复缺陷不再被旧快照误报）。
 */
export const SNAPSHOT_DETECTOR_IDS: ReadonlySet<string> = new Set([
  'fact-coverage', // documentPipeline factCoverageIssues 打包（“已确认事实未在正文中落位”）
  'overview-recap', // documentIntegrityChecks.overviewRecapIssues（“项目概况段跨章复述不得出现”）
  'internal-terminology-anchor', // internalTerminologyAnchors.internalTerminologyAnchorIssues + qualityValidation.internalTerminologyIssues（“后台内部术语/话术”）
  'global-consistency-snapshot', // documentPipeline 生成阶段跨章一致性快照打包（“跨章一致性复核：”前缀）
  'data-consistency-snapshot', // documentPipeline 生成阶段数据一致性矛盾快照打包（“数据一致性复核：”前缀）
]);

/** 重算校验组基线：剔除全部快照 issue（无 provenance 或非快照 detectorId 的 issue 保留）。
 * recomputeFinalValidationBundle 使用；剔除后由重算链重新生成快照对应的最新 issue。 */
export function stripSnapshotIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter(issue => !issue.provenance || !SNAPSHOT_DETECTOR_IDS.has(issue.provenance.detectorId));
}
