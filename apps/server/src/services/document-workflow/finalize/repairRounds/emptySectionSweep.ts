/**
 * repairRounds/emptySectionSweep：无依据空壳小节链尾清扫轮（FINALIZE_REPAIR_ROUNDS: empty-section-sweep）。
 * D-T3 ②（r28f 终检「空小节」blocker 归因）：补写轮（enforcePlannedSectionCompleteness）把原空壳 H4
 * （「特殊技术标准和要求」形态）的正文搬往规划名小节后，无规划归属的空壳标题行残留 → 终检
 * section-content-integrity「空小节」blocker 直坠交付（有规划归属空壳属补写辖区，本清扫器只管
 * 无依据空壳——「无依据则移除并重建编号」）。
 * 零 LLM：stripEmptyUnplannedSectionHeadings（globalQualityGates）整行移除 + 章内编号原子重放，
 * 定位与终检同源（qualityValidation.emptyUnplannedSectionSpans 与 collectSectionContentGaps 同判定链）。
 * 任一落地：重建终稿 + 重算校验组（终检按最新成稿复核）。位于链尾最后 draft-mutating 位置：
 * table-arithmetic-repair 之后、链尾 markdown-only 重放（runSurfaceDeterministicCleans 等）之前。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { mergeShadowedPlannedHeadings, stripEmptyUnplannedSectionHeadings } from '../../globalQualityGates';
import type { FinalizeSession } from '../finalizeSession';

export async function stageEmptySectionSweep(session: FinalizeSession): Promise<void> {
  // 4.55.25：先做「规划标题被自拟标题顶替」的确定性归位（内容归规划标题、空壳消失），再清扫无依据空壳。
  // 实测形态：规划「1.3 场地条件核查与交接」空壳 + 紧随「1.4 现场踏勘」承载内容——归位后两者同时消解。
  const merged = mergeShadowedPlannedHeadings(session.finalChapterDrafts);
  const outcome = stripEmptyUnplannedSectionHeadings(session.finalChapterDrafts);
  const stage = displayStage({
    type: 'validation',
    roleId: 'empty-section-sweep',
    status: 'success',
    message: merged.mergedCount > 0 || outcome.removedCount > 0
      ? `空节清扫完成：规划标题归位 ${merged.mergedCount} 处、移除无依据空壳标题 ${outcome.removedCount} 处（${outcome.renumberedChapters} 章重排编号）`
      : '空节清扫核对通过：无空壳小节',
    details: [...merged.details, ...outcome.details].length > 0 ? [...merged.details, ...outcome.details] : undefined,
  }, { subtitle: '空节清扫' });
  upsertProgressStage(session.progressStages, stage);
  upsertProgressStage(session.finalGateRepairStages, stage);
  if (merged.mergedCount > 0 || outcome.removedCount > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  session.emitProgress(session.finalChapterDrafts, session.progressStages);
}
