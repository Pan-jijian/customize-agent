/**
 * repairRounds/semanticChoice：决策锁语义矛盾检测轮（FINALIZE_REPAIR_ROUNDS: semantic-choice-conflict）。
 * P2 拆分（方案 5.2）：由 finalizeGeneration 代码块机械搬迁而来，业务语义逐字一致（行为保持）。
 */
import { semanticChoiceConflicts, semanticChoiceConflictIssue } from '../../dataConsistencyReview';
import type { FinalizeSession } from '../finalizeSession';

export async function stageSemanticChoice(session: FinalizeSession): Promise<void> {
  // 1.3 语义矛盾检测（决策锁"实体-选择"冲突，塔吊 vs 施工电梯类无数值矛盾）：与写作期注入同批输入
  // （623 行事实池三元组 + 同批 allEvidence）确定性重建决策锁作比对基准，检出转 blocker 并入既有修复通道；
  // 复检走统一注册表 semantic-choice 条目（与检测同源），一律不留 env 回退开关
  // 决策锁实体-选择冲突比对条目由 rebuildFacts 阶段计算（依赖事实主表局部变量，提前计算行为等价），此处只消费
  if (session.decisionLockEntries.length > 0) {
    session.validationIssues = [...session.validationIssues, ...semanticChoiceConflicts(session.finalMarkdown, session.decisionLockEntries).map(conflict => semanticChoiceConflictIssue(conflict))];
  }
}
