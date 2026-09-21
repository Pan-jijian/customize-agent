/**
 * repairRounds/sentencePatternSweep：句模复读链尾收口轮（FINALIZE_REPAIR_ROUNDS: sentence-pattern-sweep）。
 * C8 S3（F 通道：修复链覆盖断层）——s28m' 实证：句模复读修复仅写作期（stage 60），finalize 链无
 * 重放；且 tail closure 等 markdown-only 插入物晚于全部 draft-mutating 轮（templating-sweep 扫
 * 章 drafts 看不到插入物，A' 对象错位）→ 写作期残留（7/13/36 处）至终稿反增（13/14/46 处）。
 * 本轮为链尾 markdown-only 零 LLM 收口：宣告引导句确定性剥离（stripSentencePatternAnnouncements，
 * 与检测端 form-announcement 族单源判定）——「施工按以下顺序组织：」+ 列表的引导语删除无损
 *（列表自承载全部信息）；残余承载式句（含真实工序链，不可无损剥离）由密度命中线
 *（sentencePatternThreshold：检测/修复目标/评分/复检四端单源）判定放行，超线残差仍由终检
 * sentence-pattern-repeat blocker 复核（owner llm，显性不静默）。
 * 位于 delivery-structure-closure 之后、replaySurfacePunctuationClosure（链尾标点兜底）之前——
 * 终门禁所检 = 交付所存 = 收口后成稿；幂等可重放（无目标时零变更、零成本）。
 */
import { stripSentencePatternAnnouncements } from '../../templatingGovernance';
import { displayStage, upsertProgressStage } from '../../progress';
import type { FinalizeSession } from '../finalizeSession';

export async function stageSentencePatternSweep(session: FinalizeSession): Promise<void> {
  const stripped = stripSentencePatternAnnouncements(session.finalMarkdown);
  const stage = displayStage({
    type: 'validation',
    roleId: 'sentence-pattern-sweep',
    status: 'success',
    message: stripped.removedCount > 0
      ? `句模复读链尾收口：宣告引导句确定性剥离 ${stripped.removedCount} 处（列表引导语删除无损，列表内容保留）`
      : '句模复读链尾核对通过：无宣告引导句残留',
    details: stripped.removedSentences.length > 0
      ? stripped.removedSentences.slice(0, 4).map(sentence => `引导句剥离：「${sentence.slice(0, 40)}」`)
      : undefined,
  }, { subtitle: '模板化清理收口' });
  upsertProgressStage(session.progressStages, stage);
  upsertProgressStage(session.finalGateRepairStages, stage);
  if (stripped.removedCount > 0) {
    session.finalMarkdown = stripped.markdown;
    await session.recomputeFinalValidationBundle();
  }
  session.emitProgress(session.finalChapterDrafts, session.progressStages);
}
