/**
 * repairRounds/duplicateThemeMerge：重复主题小节链尾合并轮（FINALIZE_REPAIR_ROUNDS: duplicate-theme-merge）。
 * D-T7 ② 收口（r28f #36/#37 归因：minChapterSectionIssues 检测恒报、修复链零消费）：同桶
 * （classifyThematicSectionKey 单源：劳动力/机械/材料/特殊气候）规划小节 ≥2 项的章，正文 H3 行
 * 成对合并（mergeDuplicateThematicSections：保留首现、后续标题行摘除正文并入、规划数组同步、
 * 章内编号原子重放）。零 LLM、零内容生成（只删标题行不删任何正文与表格）。位于
 * section-alignment-sweep → templating-sweep 之后、delivery-structure-closure（链尾 markdown-only
 * 收口，目录按合并后正文实际结构重建）之前。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { mergeDuplicateThematicSections } from '../../globalQualityGates';
import type { FinalizeSession } from '../finalizeSession';

export async function stageDuplicateThemeMerge(session: FinalizeSession): Promise<void> {
  const merge = mergeDuplicateThematicSections(session.finalChapterDrafts);
  const stage = displayStage({
    type: 'validation',
    roleId: 'duplicate-theme-merge',
    status: 'success',
    message: merge.mergedCount > 0
      ? `重复主题小节合并：${merge.mergedCount} 处（保留首现小节，后续标题行摘除、正文并入，规划数组同步）`
      : '重复主题小节核对通过：同桶小节无并存',
    details: merge.details.length > 0 ? merge.details.slice(0, 6) : undefined,
  }, { subtitle: '重复主题合并' });
  upsertProgressStage(session.progressStages, stage);
  upsertProgressStage(session.finalGateRepairStages, stage);
  if (merge.mergedCount > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  session.emitProgress(session.finalChapterDrafts, session.progressStages);
}
