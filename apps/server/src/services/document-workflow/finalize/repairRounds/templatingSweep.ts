/**
 * repairRounds/templatingSweep：模板化清理链尾重放轮（FINALIZE_REPAIR_ROUNDS: templating-sweep）。
 * D-T7 ① 收口（r28f #35 归因：终检 formalStyleIssues 报「模板化前缀」而修复链无链尾确定性收口）：
 * repairTemplatingIssues 的 LLM 修复与其后各 draft-mutating 轮的 rebuild 可再引入前缀导语句，
 * 链尾以零 LLM 确定性重放两器：
 * ① 模板化前缀句零信息删除（templatePrefixTargets + stripZeroInfoSloganSentences，与修复链同源判定：
 *    「本节/本章将…」元话语导语且无数字/岗位/频次/合规锚点即删——无损净化，含信息句保留交终检警告）；
 * ② 逐章段落完全重复去重（stripDuplicateParagraphs 重放：postReviewSurface 之后各 draft-mutating 轮
 *    的 rebuild 可回退其段落去重成果；章内作用域，跨章重复段由终检 duplicateParagraphIssues 报告兜底）。
 * 任一落地：重建终稿 + 重算校验组。位于 section-alignment-sweep 之后、duplicate-theme-merge 之前。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { stripDuplicateParagraphs } from '../../documentIntegrityChecks';
import { stripZeroInfoSloganSentences, templatePrefixTargets } from '../../constructionOrgAudit';
import type { FinalizeSession } from '../finalizeSession';

export async function stageTemplatingSweep(session: FinalizeSession): Promise<void> {
  // ① 零信息前缀句确定性删除（幂等：无目标/已删净时零成本静默）
  const prefixTargets = templatePrefixTargets(session.finalChapterDrafts);
  const stripped = prefixTargets.length > 0
    ? stripZeroInfoSloganSentences(session.finalChapterDrafts, prefixTargets)
    : { deletedCount: 0, deletedSentences: [] as string[], remaining: prefixTargets };
  // ② 逐章段落完全重复去重（保留首次出现，删除后续完全相同段落；零内容生成）
  let paragraphRemoved = 0;
  for (const chapter of session.finalChapterDrafts) {
    if (!chapter.content?.trim()) continue;
    const deduped = stripDuplicateParagraphs(chapter.content);
    if (deduped.removedCount > 0) {
      chapter.content = deduped.markdown;
      paragraphRemoved += deduped.removedCount;
    }
  }
  const total = stripped.deletedCount + paragraphRemoved;
  const stage = displayStage({
    type: 'validation',
    roleId: 'templating-sweep',
    status: 'success',
    message: total > 0
      ? `模板化链尾清理：零信息前缀句删除 ${stripped.deletedCount} 处、重复段落去重 ${paragraphRemoved} 处`
      : '模板化链尾核对通过：无零信息前缀句与重复段落残留',
    details: stripped.deletedSentences.length > 0
      ? stripped.deletedSentences.slice(0, 3).map(sentence => `前缀句删除：「${sentence.slice(0, 40)}」`)
      : undefined,
  }, { subtitle: '模板化清理收口' });
  upsertProgressStage(session.progressStages, stage);
  upsertProgressStage(session.finalGateRepairStages, stage);
  if (total > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  session.emitProgress(session.finalChapterDrafts, session.progressStages);
}
