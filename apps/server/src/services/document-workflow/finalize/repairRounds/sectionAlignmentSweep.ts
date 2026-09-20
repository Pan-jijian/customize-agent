/**
 * repairRounds/sectionAlignmentSweep：小节结构对齐链尾重放轮（FINALIZE_REPAIR_ROUNDS: section-alignment-sweep）。
 * D-T6 ②（r28f 门禁 #2 归因：「第 7 章成稿 5 节 vs 规划 4 节」）：postReviewSurface 内的近名合并/
 * 漂移改名（mergeNearDuplicateSectionHeadings）位于缺节补写（enforcePlannedSectionCompleteness）之前，
 * 其后各 draft-mutating 轮的 rebuild 与「漂移+补写并存」历史形态（漂移行落单遗留、补写版与漂移版
 * 并存）到链尾再无第二次收口点。本轮在链尾重放两器（零 LLM、零内容生成）：
 * ① mergeNearDuplicateSectionHeadings（近名成对合并 + 单行漂移改名回规划名）；
 * ② reconcileUnplannedSectionHeadings（非近名规划外 H3 降 H4，与 sectionCountOverflowIssues 同源判定）。
 * r28h 扩围（r28h2/s28h2 终态实机归因）：合并摘除小节标题行/写作期无编号 H3/章号错位（9.x 居于第 8 章）
 * 会产生章内编号空档与错位——本器此前不重排编号，其后到终门禁无第二个编号重放点（r28h2 缺 3.1/5.1、
 * s28h2 章号错位+重复直坠门禁）。本轮在合并/降级落地后追加 ③ 全章编号原子重放
 * （renumberSectionHeadings 章片段模式，与 empty-section-sweep/duplicate-theme-merge 同源）：
 * 编号空档/章号错位/无编号 H3 一并收口；其后 delivery-structure-closure（fixTocFromBody）按最新
 * 正文结构重建目录，目录-正文一致性自然恢复。
 * 任一落地（合并/降级/编号重放）：重建终稿 + 重算校验组（终检按最新成稿复核）。位于链尾最后
 * draft-mutating 位置：empty-section-sweep 之后、链尾 markdown-only 重放（runSurfaceDeterministicCleans 等）之前。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { mergeNearDuplicateSectionHeadings, reconcileUnplannedSectionHeadings } from '../../globalQualityGates';
import { renumberSectionHeadings } from '../../structureIntegrityRules';
import type { FinalizeSession } from '../finalizeSession';

export async function stageSectionAlignmentSweep(session: FinalizeSession): Promise<void> {
  const merge = mergeNearDuplicateSectionHeadings(session.finalChapterDrafts);
  const reconcile = reconcileUnplannedSectionHeadings(session.finalChapterDrafts);
  // r28h 扩围：链尾最后收口点——合并摘行/降级/写作期遗留（无编号 H3、章号错位）的章内编号
  // 统一按「章序.节序」原子重放（与终检 sectionNumberingIssues 同口径「编号须从 1 起连续、章号=章序」）
  let renumberedChapters = 0;
  session.finalChapterDrafts.forEach((chapter, index) => {
    if (!chapter.content?.trim()) return;
    const renumbered = renumberSectionHeadings(chapter.content, { chapterNumber: index + 1 });
    if (renumbered.fixedCount > 0) {
      chapter.content = renumbered.markdown;
      renumberedChapters += 1;
    }
  });
  const total = merge.mergedCount + reconcile.demotedCount;
  const changed = total > 0 || renumberedChapters > 0;
  const details = [...merge.details, ...reconcile.details];
  const stage = displayStage({
    type: 'validation',
    roleId: 'section-alignment-sweep',
    status: 'success',
    message: changed
      ? `小节结构对齐收口：近名对齐/合并 ${merge.mergedCount} 处、规划外小节降级 ${reconcile.demotedCount} 处、编号重放 ${renumberedChapters} 章`
      : '小节结构对齐核对通过：成稿小节与规划主题块一一对应',
    details: details.length > 0 ? details.slice(0, 6) : undefined,
  }, { subtitle: '结构对齐收口' });
  upsertProgressStage(session.progressStages, stage);
  upsertProgressStage(session.finalGateRepairStages, stage);
  if (changed) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  session.emitProgress(session.finalChapterDrafts, session.progressStages);
}
