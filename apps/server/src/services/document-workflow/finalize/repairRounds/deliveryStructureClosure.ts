/**
 * repairRounds/deliveryStructureClosure：交付结构收口轮（FINALIZE_REPAIR_ROUNDS: delivery-structure-closure）。
 * D-T6 ①③（r28f 门禁 #1 与 warningIssues 长段归因）：
 * ① 目录↔正文一一对应——fixTocFromBody 原调用点在 postReviewSurface（链中段），其后
 *    length-compression-repair / fact-distribution-round / table-caption-repair /
 *    table-arithmetic-repair / empty-section-sweep / section-alignment-sweep 的 rebuild 均可改变
 *    正文 H3 结构（r28f 实测目录 29 节 vs 正文 28 节直坠门禁），链尾以正文实际结构重建目录
 *    （无改动时零成本静默）；
 * ② 过长段落 0——splitOverlengthBodyParagraphs 对 >380 行的链尾切分（写作期 splitLongParagraphs
 *    仅覆盖写作期，链尾 rebuild 与 LLM 补写句拼接引入的超长行无收口点）。
 * 两操作均为 markdown-only（不改章 drafts、不 rebuild），位于链尾 markdown-only 重放
 * （runSurfaceDeterministicCleans / replayBlueprintCitationNumericFixes / replayRequirementTailClosure）
 * 之后、stageFinalGate 之前——终门禁所检 = 交付所存 = 收口后成稿。
 */
import { fixTocFromBody } from '../../documentIntegrityChecks';
import { splitOverlengthBodyParagraphs } from '../../helpers/markdownCleanup';
import { displayStage, upsertProgressStage } from '../../progress';
import type { FinalizeSession } from '../finalizeSession';

export async function stageDeliveryStructureClosure(session: FinalizeSession): Promise<void> {
  const details: string[] = [];
  // ③ 超长段落切分先于目录重建：切分不改标题行，目录重建基于切分后正文（同一次 recompute 收口）
  const split = splitOverlengthBodyParagraphs(session.finalMarkdown);
  if (split.markdown !== session.finalMarkdown) {
    session.finalMarkdown = split.markdown;
    details.push(`超长段落切分：消除 >380 字符段落 ${split.splitCount} 处`);
  }
  // ① 目录按正文实际 H2/H3 结构重建（与 tocBodyConsistencyIssues 检测口径同源）
  const toc = fixTocFromBody(session.finalMarkdown);
  if (toc.fixedCount > 0) {
    session.finalMarkdown = toc.markdown;
    details.push(...toc.details);
  }
  const changed = details.length > 0;
  const stage = displayStage({
    type: 'validation',
    roleId: 'delivery-structure-closure',
    status: 'success',
    message: changed
      ? `交付结构收口：${details.join('；')}`
      : '交付结构收口核对通过：目录与正文一致、无超长段落',
    details: changed ? details : undefined,
  }, { subtitle: '交付结构收口' });
  upsertProgressStage(session.progressStages, stage);
  upsertProgressStage(session.finalGateRepairStages, stage);
  if (changed) await session.recomputeFinalValidationBundle();
  session.emitProgress(session.finalChapterDrafts, session.progressStages);
}
