/**
 * repairRounds/tableArithmeticRepair：表内算术自洽修复轮（FINALIZE_REPAIR_ROUNDS: table-arithmetic-repair）。
 * C4 实机归因：资源/劳动力类表格的「合计」行/列与分项之和对不上（表5-2 实测分班组列与合计列口径打架），
 * 数据不一致直击评审对数据可信度的判定；此前终检 table-arithmetic-consistency blocker 无修复轮消费。
 * 修复链路：
 * - 章级同源重扫（tableArithmeticInconsistencyIssues / countTableArithmeticFindings 与终检同函数）：
 *   含显性合计标记（合计行/合计列）且分项和≠合计的表进 LLM 定向修复（以分项重算合计/按权威值修正分项）；
 * - 收敛修复（每章最多 2 轮，不自洽处数下降才继续下一轮；清零/不降/回滚即停）；
 * - 任一落地：重建终稿 + 重算校验组（终检按最新成稿复核）。
 * 产品级通用：判据仅凭表格结构与数值绑定，无项目/表名硬编码。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { countTableArithmeticFindings, tableArithmeticInconsistencyIssues } from '../../integrity/detectors/detectors';
import type { FinalizeSession } from '../finalizeSession';

/** 收敛修复：每章定向修复轮上限（不自洽处数下降才继续下一轮；不降/回滚/达上限即停止） */
const MAX_TABLE_ARITHMETIC_REPAIR_ROUNDS = 2;

export async function stageTableArithmeticRepair(session: FinalizeSession): Promise<void> {
  // 章级同源重扫（与终检 det('table-arithmetic-consistency') 同函数：检测定位=修复定位）
  const chapterIssues = new Map<string, ReturnType<typeof tableArithmeticInconsistencyIssues>>();
  for (const chapter of session.finalChapterDrafts) {
    const issues = tableArithmeticInconsistencyIssues(chapter.content);
    if (issues.length > 0) chapterIssues.set(chapter.id, issues);
  }
  const totalFindings = [...chapterIssues.keys()].reduce((sum, chapterId) => {
    const chapter = session.finalChapterDrafts.find(item => item.id === chapterId);
    return sum + (chapter ? countTableArithmeticFindings(chapter.content) : 0);
  }, 0);
  if (chapterIssues.size === 0) {
    const passStage = displayStage({ type: 'validation', roleId: 'table-arithmetic-repair', status: 'success', message: '表内算术自洽核对通过：全部含合计标记的表格分项和=合计' }, { subtitle: '表内算术自洽' });
    upsertProgressStage(session.progressStages, passStage);
    upsertProgressStage(session.finalGateRepairStages, passStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    return;
  }
  let repairedChapters = 0;
  let residualFindings = 0;
  for (const [chapterId, initialIssues] of chapterIssues) {
    const chapterIndex = session.finalChapterDrafts.findIndex(chapter => chapter.id === chapterId);
    if (chapterIndex < 0) continue;
    const draftChapter = session.finalChapterDrafts[chapterIndex];
    let chapterContent = draftChapter.content;
    let beforeCount = countTableArithmeticFindings(chapterContent);
    let rounds = 0;
    let chapterRepaired = false;
    let anyRollback = false;
    // 残留轨迹（首计数 + 每轮修复后计数）：stage 明细与诊断展示收敛过程
    const residualTrajectory = [beforeCount];
    // 收敛修复：不自洽处数下降才继续下一轮（上限 2 轮）；清零/不降/回滚即停止，残留由终检照常复核
    while (beforeCount > 0 && rounds < MAX_TABLE_ARITHMETIC_REPAIR_ROUNDS) {
      rounds += 1;
      const pending = tableArithmeticInconsistencyIssues(chapterContent);
      const runningStage = displayStage({ type: 'llm_review', roleId: `agent-table-arithmetic-${chapterId}`, status: 'running', message: `表格算术不自洽 ${pending.length} 张表，第 ${rounds} 轮定向修复中：${draftChapter.title}`, details: pending.map(issue => issue.message) }, { subtitle: '表内算术自洽' });
      upsertProgressStage(session.progressStages, runningStage);
      upsertProgressStage(session.finalGateRepairStages, runningStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      const instruction = [
        '【表格算术自洽修复】下列表格的「合计」（合计行/合计列）与分项之和对不上，请逐表修正表内数值：',
        ...(rounds > 1 ? [`本轮为第 ${rounds} 轮（最多 ${MAX_TABLE_ARITHMETIC_REPAIR_ROUNDS} 轮）：上一轮修复后仍有残留，必须让合计与分项之和完全相等。`] : []),
        '1. 以分项为准重算合计：合计 = 该行/该列已列出的分项之和（单位一致）；',
        '2. 若分项数值本身与资料/清单/上下文矛盾，按权威值修正分项，使分项和 = 合计；',
        '3. 台账类表（含「其他/其余」差额项的）保留显性「其他」项并给出数值，使合计 = 全部分项（含其他）之和；',
        '4. 只允许修正表格内的数值（合计格/分项格）；严禁编造无来源数值、严禁删除表格、严禁改动表格外正文。',
        '以局部 patch 方式输出：每个 patch 只包含表格区域的数值修正与必要定位上下文。',
        pending.map(issue => `- ${issue.message}`).join('\n'),
      ].join('\n');
      // 回滚保护（与 table-caption-repair 同口径）：本轮修复目标是「不自洽处数严格下降」——
      // 不降即视为未生效或引入了表格改写风险（数值改坏/结构破坏），回滚保留修复前正文
      const outcome = await withPatchRollback({
        originalContent: chapterContent,
        repairRound: 'table-arithmetic-repair',
        diagnostics: session.generationDiagnostics,
        beforeMetrics: [beforeCount],
        shouldRollback: (before, after) => after[0] >= before[0],
        apply: async () => {
          const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
            template: session.template,
            chapter: { id: draftChapter.id, title: draftChapter.title, content: chapterContent, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
            issues: pending.map(issue => issue.message),
            promptTexts: instruction,
            requirement: session.requirement,
            forbidDrawingImages: false,
            // 标书编制规格（暗标禁表）：修复链 system 口径同步
            bidComposition: session.bidComposition,
            diagnostics: session.generationDiagnostics,
            signal: session.signal,
            patchGuard: repairPatchGuard('table-arithmetic-repair', session.generationDiagnostics),
          }));
          return repaired.content && repaired.content !== chapterContent ? repaired.content : chapterContent;
        },
        recheck: (content) => [countTableArithmeticFindings(content)],
      });
      if (!outcome.rolledBack && outcome.content !== chapterContent) {
        chapterContent = outcome.content;
        session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: chapterContent };
        chapterRepaired = true;
      }
      if (outcome.rolledBack) anyRollback = true;
      const afterCount = countTableArithmeticFindings(chapterContent);
      residualTrajectory.push(afterCount);
      // 收敛判定：清零即通过；未下降（含回滚/空修复）即停止；下降且未达上限 → 再修一轮
      if (afterCount === 0 || afterCount >= beforeCount || rounds >= MAX_TABLE_ARITHMETIC_REPAIR_ROUNDS) break;
      beforeCount = afterCount;
    }
    if (chapterRepaired) repairedChapters += 1;
    const afterFindings = countTableArithmeticFindings(chapterContent);
    residualFindings += afterFindings;
    const completedStage = displayStage({ type: 'llm_review', roleId: `agent-table-arithmetic-${chapterId}`, status: afterFindings === 0 ? 'success' : 'failed', message: afterFindings === 0 ? `表内算术自洽修复完成：${draftChapter.title}（残留轨迹 ${residualTrajectory.join('→')}）` : chapterRepaired ? `表内算术自洽修复部分生效：${draftChapter.title}（不自洽处数残留轨迹 ${residualTrajectory.join('→')}，已执行 ${rounds} 轮定向修复（每章最多 ${MAX_TABLE_ARITHMETIC_REPAIR_ROUNDS} 轮）；残留由终检照常复核）` : anyRollback ? `表内算术自洽修复已回滚：${draftChapter.title}（修复后不自洽处数未下降，保留修复前正文；残留 ${afterFindings} 处由终检照常复核）` : `表内算术自洽修复未生效：${draftChapter.title}（模型未产生有效修改；残留 ${afterFindings} 处由终检照常复核）`, details: [...initialIssues.map(issue => issue.message), afterFindings > 0 ? `已执行 ${rounds} 轮定向修复，残留由终检照常复核` : ''] }, { subtitle: '表内算术自洽' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (repairedChapters > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  session.generationDiagnostics.llm.lastInfo = `表内算术自洽修复：${totalFindings} 处不自洽，${repairedChapters} 章完成定向修复，残留 ${residualFindings} 处（每章最多 ${MAX_TABLE_ARITHMETIC_REPAIR_ROUNDS} 轮收敛修复，残留由终检照常复核）`;
}
