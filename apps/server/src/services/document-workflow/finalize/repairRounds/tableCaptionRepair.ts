/**
 * repairRounds/tableCaptionRepair：正文表格题名补全轮（FINALIZE_REPAIR_ROUNDS: table-caption-repair）。
 * r24 B8 实机归因：正文存在「无题名形态」表格（表上方 8 行内无可提取表名），题注注入器无可注入对象 →
 * 终检 table-caption 报出 blockers 直坠终门禁。修复链路：
 * - 确定性补名（零 LLM）：章草稿无题表 × 本章计划表按表头字段覆盖对账（completeTitlelessTableTitles），
 *   一对一贪心把计划表题名补为独立表题行（表头字段全等命中即计划表本体，题名可信）；
 * - LLM 补名轮：残留无题表（无计划表匹配/低置信）章级单次定向补名（补写独立表题行，纯增量），
 *   回滚保护（同源复检无题表数须严格下降，否则回滚保留修复前正文）；
 * - 任一落地：重建终稿 + 重算校验组（链尾重放/终门禁按最新成稿判定）。
 * 产品级通用：判据仅凭表头字段文本与表格结构，无项目/表名硬编码。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { isBodyTableForbidden } from '../../bidComposition';
import { finalizeChapterContentQuality } from '../../documentGeneratorHelpers';
import { completeTitlelessTableTitles, extractTitlelessTableBlocks } from '../../constructionOrgTablePlan';
import type { FinalizeSession } from '../finalizeSession';

export async function stageTableCaptionRepair(session: FinalizeSession): Promise<void> {
  // 正文禁表（bodyTablePolicy=forbidden，显式禁表句）：表格本不应存在（拆表轮已处理），题名补全不适用
  if (isBodyTableForbidden(session.bidComposition)) return;
  const countTitleless = (content: string) => extractTitlelessTableBlocks(content).length;
  const beforeTotal = session.finalChapterDrafts.reduce((sum, chapter) => sum + countTitleless(chapter.content), 0);
  if (beforeTotal === 0) return;
  // 阶段一：确定性补名（零 LLM）——章内无题表 × 本章计划表表头字段对账，一对一贪心补独立表题行
  let deterministicCount = 0;
  for (const chapter of session.finalChapterDrafts) {
    const plans = chapter.tablePlans || [];
    if (plans.length === 0) continue;
    const completion = completeTitlelessTableTitles(chapter.content, plans);
    if (completion.completed > 0) {
      chapter.content = completion.markdown;
      deterministicCount += completion.completed;
    }
  }
  if (deterministicCount > 0) {
    const deterministicStage = displayStage({ type: 'validation', roleId: 'table-caption-completion', status: 'success', message: `表格题名确定性补全：${deterministicCount} 张无题表按计划表字段对账补名` }, { subtitle: '表格题名补全' });
    upsertProgressStage(session.progressStages, deterministicStage);
    upsertProgressStage(session.finalGateRepairStages, deterministicStage);
  }
  // 阶段二：LLM 补名轮——残留无题表章级单次定向补名（计划表无匹配/低置信的表）
  let llmApplied = 0;
  for (let chapterIndex = 0; chapterIndex < session.finalChapterDrafts.length; chapterIndex += 1) {
    const draftChapter = session.finalChapterDrafts[chapterIndex];
    const titleless = extractTitlelessTableBlocks(draftChapter.content);
    if (titleless.length === 0) continue;
    const templateChapter = session.effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title);
    const roleId = `agent-table-caption-${draftChapter.id}`;
    const runningStage = displayStage({ type: 'llm_review', roleId, status: 'running', message: `正在补全表格题名：${draftChapter.title}`, details: [`无题名表格 ${titleless.length} 张`] }, { subtitle: '表格题名补全' });
    upsertProgressStage(session.progressStages, runningStage);
    upsertProgressStage(session.finalGateRepairStages, runningStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    const instruction = [
      '【表格题名补全】下列表格缺少独立表题行，请为每张表在表格正上方补写一行表题。',
      '表题命名要求：概括该表内容与用途的业务表名（10～24 字），以“表/台账/清单/计划/记录/一览表”等名词结尾；不得使用“表格/数据表/明细”类无信息泛化名。',
      `缺表题表格原文（只允许在各表正上方补一行表题；严禁修改表头、数据行、表格列数与其余正文，严禁删除表格）：\n${titleless.map(block => block.blockText).join('\n\n')}`,
      '以局部 patch 方式输出：每处 patch 只包含新增表题行与必要定位上下文，不得重写其他内容。',
    ].join('\n');
    // 回滚保护（与 table-repair 的「变差回滚」差异点）：本轮修复目标是「无题表数严格下降」——
    // 不降即视为未生效或引入了表格改写风险（错误位置补题/改动表格本体），回滚保留修复前正文
    const outcome = await withPatchRollback({
      originalContent: draftChapter.content,
      repairRound: 'table-caption-repair',
      diagnostics: session.generationDiagnostics,
      beforeMetrics: [titleless.length],
      shouldRollback: (_before, after) => after[0] >= titleless.length,
      apply: async () => {
        const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
          template: session.template,
          chapter: { id: draftChapter.id, title: draftChapter.title, content: draftChapter.content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
          issues: [`正文存在 ${titleless.length} 张缺少表题的表格`],
          promptTexts: instruction,
          requirement: session.requirement,
          forbidDrawingImages: false,
          diagnostics: session.generationDiagnostics,
          signal: session.signal,
          patchGuard: repairPatchGuard('table-caption-repair', session.generationDiagnostics),
        }));
        return repaired.content && repaired.content !== draftChapter.content ? repaired.content : draftChapter.content;
      },
      recheck: (content) => [countTitleless(content)],
    });
    const nextContent = outcome.content;
    if (!outcome.rolledBack && nextContent !== draftChapter.content) {
      session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: templateChapter ? finalizeChapterContentQuality(nextContent, templateChapter) : nextContent };
      llmApplied += 1;
    }
    const remaining = outcome.rolledBack ? titleless.length : outcome.afterMetrics[0];
    const completedStage = displayStage({
      type: 'llm_review',
      roleId,
      status: outcome.rolledBack || remaining > 0 ? 'failed' : 'success',
      message: outcome.rolledBack
        ? `表格题名补全已回滚：${draftChapter.title}（补名后无题表数未下降，保留修复前正文）`
        : remaining > 0
          ? `表格题名补全未完全生效：${draftChapter.title}（残留 ${remaining} 张无题表由终检复核）`
          : `表格题名补全完成：${draftChapter.title}`,
      details: [`无题表 ${titleless.length} 张 → 残留 ${remaining} 张`],
    }, { subtitle: '表格题名补全' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (deterministicCount > 0 || llmApplied > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
}
