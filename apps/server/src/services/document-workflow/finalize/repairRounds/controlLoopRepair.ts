/**
 * repairRounds/controlLoopRepair：评审关注闭环链链尾补写轮（D-T2，根治 B8 前半）。
 *
 * 背景（r28f 实机归因 B8）：质量三检/进度纠偏/工资代发等评审关注闭环链——终检
 * construction-org-control-loop 报出 warning 后无任何修复轮消费（r28f #27-29 残留：
 * 主要施工方法缺质量链、机械设备计划缺进度链、质量措施缺工资链），且旧判定按 title+sections
 * 宽 pattern 逐章命中（机械设备/物资计划类章因含「计划」被误判为进度链载体）。
 *
 * D-T2 收口：检测端升级为「主责章 + 全要素成链」判定（controlLoopChainScan 单源扫描，
 * warning 带 chapterId + provenance）。本轮链尾消费——章级定位（chapterId 直连 + 扫描实时
 * 重算剔除过期快照）→ LLM 定向补写（链语义 + 缺失环节清单，要求标准词面落位）→ 复检缺失
 * 要素数（下降才继续；变差回滚，汉字数大幅减少=删除式修复同判回滚）→ 落地后 rebuild +
 * recompute（终检重跑判定，链成即清除 warning）。
 * 位置在 content-depth-repair 之后（同族补写轮）、post-review-surface 之前（其复读剥离/
 * 格式清洗覆盖本轮补写引入的残留）。
 */
import { repairOutcomeReason, repairOutcomeStatus } from './repairOutcome';
import { displayStage, upsertProgressStage } from '../../progress';
import { buildChapterBudgetLedger, chapterOverflowAfterRound, recordChapterBudgetMetric, renderChapterBudgetInstruction, renderChapterOverflowNote } from './chapterBudgetLedger';
import type { ChapterBudgetEntry } from './chapterBudgetLedger';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { controlLoopChainScan, type ControlLoopChainDeficit } from '../../constructionOrgQualityRules';
import type { DocumentDraftChapter } from '../../types';
import type { FinalizeSession } from '../finalizeSession';

/** 每章定向补写轮上限（缺失要素可能多链多项：每轮补全部当前缺口，复检清零即停） */
const MAX_CHAIN_REPAIR_ROUNDS = 2;

/** 汉字数守卫阈值（删除式修复判定）：补写轮为增量修复，汉字数大幅减少即视为改写事故回滚 */
const HAN_SHRINK_TOLERANCE = 40;

function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fa5]/gu) || []).length;
}

/** 定向补写指令：链语义 + 缺失环节清单 + 局部修改约束 + 标准词面落位要求（词面判定机制） */
function instructionFor(draftChapter: DocumentDraftChapter, deficits: ControlLoopChainDeficit[], budgetEntry?: ChapterBudgetEntry): string {
  const lines: string[] = [
    '【评审关注闭环链定向补写】',
    `《${draftChapter.title}》的下列评审关注闭环链未成链（链条要素缺失），请在对应小节内自然补写齐全：`,
  ];
  for (const deficit of deficits) {
    lines.push(`- ${deficit.label}（缺：${deficit.missing.join('、')}）：${deficit.prompt}必须在本章内补写缺失环节，形成“${deficit.required.join('—')}”完整链条。`);
  }
  lines.push(
    '修复要求：',
    '1. 只做局部修改：在对应小节内扩写补实，或自然融入一段补写文字；不得新增、删除或合并小节，不得改动无关内容；',
    '2. 补写须结合本章既有语境（本工程工序、责任岗位、检查频次、记录方式），写清每个缺失环节“谁执行、何时执行、留存什么记录”，与既有句子自然衔接；',
    '3. 缺失环节由评审按标准术语查找，补写文字必须出现缺失要素的标准词面（如“互检”“交接检”），不得以近义改述代替；',
    '4. 禁止「按招标文件要求：」类条幅前缀与任何元话语，必须为正式施工组织设计正文行文，不得编造参数。',
    // 4.56 2-b：章预算账（本轮补写额度约束；链条补写同样属「修复链无预算追加」）
    ...(budgetEntry ? [renderChapterBudgetInstruction(budgetEntry)] : []),
  );
  return lines.join('\n');
}

/**
 * 4.56 2-b 章预算账查表（与 contentDepthRepair 同口径同源）：content 传「本章实时正文」，
 * 修复轮内上一轮已改写过章正文时额度必须按实时字数结算，否则额度是过期分母。
 */
function chapterBudgetEntryFor(session: FinalizeSession, chapterIndex: number, content: string): ChapterBudgetEntry | undefined {
  const chapters = session.finalChapterDrafts;
  if (!chapters[chapterIndex]) return undefined;
  const ledger = buildChapterBudgetLedger({
    chapterTargets: session.documentBudget?.chapterTargets,
    chapters: chapters.map((chapter, index) => (index === chapterIndex ? { ...chapter, content } : chapter)),
    documentTargetChars: session.documentBudget?.targetChars,
  });
  return ledger.chapters[chapterIndex];
}

export async function stageControlLoopRepair(session: FinalizeSession): Promise<void> {
  // 消费集合：provenance 精确过滤（检测端主责章判定产出的 warning，非 blocker）
  const warnings = session.validationIssues.filter(issue => issue.provenance?.detectorId === 'construction-org-control-loop' && issue.chapterId);
  // 章级定位 + 实时重算（快照过期剔除：重算后已达线的章不再注入补写）
  const initialScan = controlLoopChainScan(session.finalChapterDrafts);
  const targets = new Map<number, ControlLoopChainDeficit[]>();
  for (const issue of warnings) {
    const index = session.finalChapterDrafts.findIndex(chapter => chapter.id === issue.chapterId);
    if (index < 0) continue;
    const deficits = initialScan.filter(item => item.chapter.id === issue.chapterId).map(item => item.deficit);
    if (deficits.length === 0) continue;
    if (!targets.has(index)) targets.set(index, deficits);
  }
  if (targets.size === 0) {
    // 全链成链（或快照过期已达线）：写验收事件（D-T2 验收判据「三类闭环链 100% 成链」显性出口）
    const passStage = displayStage({ type: 'validation', roleId: 'control-loop-repair', status: 'success', message: '闭环链验收通过：质量三检/进度纠偏/工资代发链均已成链' }, { subtitle: '闭环链补写核验' });
    upsertProgressStage(session.progressStages, passStage);
    upsertProgressStage(session.finalGateRepairStages, passStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    return;
  }
  let repairedChapters = 0;
  let unresolvedChapters = 0;
  for (const [chapterIndex, initialDeficits] of targets) {
    const draftChapter = session.finalChapterDrafts[chapterIndex];
    if (!draftChapter) continue;
    // 残差单源：全章扫描（主责章判定与检测端同源）后取本链缺失要素数
    const residualOf = (content: string): number => controlLoopChainScan(
      session.finalChapterDrafts.map((chapter, index) => (index === chapterIndex ? { ...chapter, content } : chapter)),
    ).filter(item => item.chapter.id === draftChapter.id).reduce((sum, item) => sum + item.deficit.missing.length, 0);
    let chapterContent = draftChapter.content;
    let beforeResidual = residualOf(chapterContent);
    // 防御：快照与当前正文不同源时跳过（交由终门禁照常复核）
    if (beforeResidual === 0) continue;
    let rounds = 0;
    let chapterRepaired = false;
    let anyRollback = false;
    const roleId = `agent-control-loop-repair-${draftChapter.id}`;
    /** 4.56 2-b：本章跨轮超额注记（累积进阶段 message/details，与 metrics 同源） */
    const overflowNotes: string[] = [];
    const residualTrajectory = [beforeResidual];
    while (rounds < MAX_CHAIN_REPAIR_ROUNDS) {
      rounds += 1;
      // 当前残留链缺失（每轮以最新文本重新定位，检测定位=修复定位）
      const pendingDeficits = controlLoopChainScan(
        session.finalChapterDrafts.map((chapter, index) => (index === chapterIndex ? { ...chapter, content: chapterContent } : chapter)),
      ).filter(item => item.chapter.id === draftChapter.id).map(item => item.deficit);
      if (pendingDeficits.length === 0) break;
      const roundStartedAt = Date.now();
      const runningStage = displayStage({ type: 'llm_review', roleId, status: 'running', message: `闭环链补写中（第 ${rounds}/${MAX_CHAIN_REPAIR_ROUNDS} 轮）：${draftChapter.title}（${pendingDeficits.map(deficit => `${deficit.label}缺${deficit.missing.length}项`).join('、')}）` }, { subtitle: '闭环链补写核验' });
      upsertProgressStage(session.progressStages, runningStage);
      upsertProgressStage(session.finalGateRepairStages, runningStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      const outcome = await withPatchRollback({
        originalContent: chapterContent,
        repairRound: 'control-loop-repair',
        diagnostics: session.generationDiagnostics,
        beforeMetrics: [beforeResidual, -hanCount(chapterContent)],
        apply: async () => {
          // 4.56 2-b：预算账按实时正文结算后注入指令（本轮额度约束）
          const budgetEntry = chapterBudgetEntryFor(session, chapterIndex, chapterContent);
          const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
            template: session.template,
            chapter: { id: draftChapter.id, title: draftChapter.title, content: chapterContent, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
            issues: pendingDeficits.map(deficit => `${deficit.label}未成链，缺失环节：${deficit.missing.join('、')}`),
            promptTexts: instructionFor(draftChapter, pendingDeficits, budgetEntry),
            requirement: session.requirement,
            forbidDrawingImages: false,
            // 标书编制规格（正文表格口径）：修复链 system 口径同步
            bidComposition: session.bidComposition,
            diagnostics: session.generationDiagnostics,
            signal: session.signal,
            patchGuard: repairPatchGuard('control-loop-repair', session.generationDiagnostics),
          }));
          return repaired.content && repaired.content !== chapterContent ? repaired.content : chapterContent;
        },
        // 指标 1：缺失要素数（越大越差）；指标 2：负汉字数（汉字数大幅减少=删除式修复，越大越差）
        recheck: (content) => [residualOf(content), -hanCount(content)],
        shouldRollback: (before, after) => after[0] > before[0] || after[1] > before[1] + Math.max(HAN_SHRINK_TOLERANCE, Math.abs(before[1]) * 0.03),
      });
      if (outcome.rolledBack) anyRollback = true;
      if (outcome.rolledBack || outcome.content === chapterContent) break;
      const contentBeforeRound = chapterContent;
      chapterContent = outcome.content;
      session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: chapterContent };
      chapterRepaired = true;
      // 4.56 2-b 落地后章级超额检查（只观测不改写：本轮新增多少字 + 超出多少）
      const roundBudgetEntry = chapterBudgetEntryFor(session, chapterIndex, contentBeforeRound);
      const overflowReport = roundBudgetEntry
        ? chapterOverflowAfterRound({ chapterId: draftChapter.id, title: draftChapter.title, target: roundBudgetEntry.target, beforeContent: contentBeforeRound, afterContent: chapterContent })
        : undefined;
      if (overflowReport) {
        overflowNotes.push(renderChapterOverflowNote(overflowReport));
        recordChapterBudgetMetric({ diagnostics: session.generationDiagnostics, round: 'control-loop-repair', startedAt: roundStartedAt, report: overflowReport });
      }
      const afterResidual = outcome.afterMetrics[0] ?? residualOf(chapterContent);
      residualTrajectory.push(afterResidual);
      // 收敛判定：清零即通过；未下降（含回滚/空修复）即停止；下降且未达上限 → 再修一轮
      if (afterResidual === 0 || afterResidual >= beforeResidual || rounds >= MAX_CHAIN_REPAIR_ROUNDS) break;
      beforeResidual = afterResidual;
    }
    if (chapterRepaired) repairedChapters += 1;
    const finalResidual = chapterRepaired ? (residualTrajectory[residualTrajectory.length - 1] ?? beforeResidual) : beforeResidual;
    if (finalResidual > 0) unresolvedChapters += 1;
    const residualNote = `残留链缺失 ${finalResidual} 项（由终门禁照常复核）`;
    let message: string;
    if (finalResidual === 0 && chapterRepaired) message = `闭环链补写完成：${draftChapter.title}（${rounds} 轮补写后缺失清零，链已成链）`;
    else if (chapterRepaired) message = `闭环链补写部分生效：${draftChapter.title}（残留轨迹 ${residualTrajectory.join('→')}，已执行 ${rounds} 轮；${residualNote}）`;
    else if (anyRollback) message = `闭环链补写已回滚：${draftChapter.title}（修复后缺失数未下降或汉字大幅减少，保留修复前正文；${residualNote}）`;
    else message = `闭环链补写未生效：${draftChapter.title}（模型未产生有效修改；${residualNote}）`;
    // 4.56 2-b：章级超额观测上屏（message 摘要 + details 逐条）
    if (overflowNotes.length > 0) message = `${message}；${overflowNotes[overflowNotes.length - 1]}`;
    const completedStage = displayStage({ type: 'llm_review', roleId, status: repairOutcomeStatus({ before: residualTrajectory[0], after: finalResidual, repaired: chapterRepaired }), message, details: [...initialDeficits.map(deficit => `缺陷：${deficit.label}缺${deficit.missing.join('、')}`), ...overflowNotes] }, { subtitle: '闭环链补写核验' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (repairedChapters > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  // 终态残留=重算后主责章链缺失扫描（与检测端同源；残留由终门禁照常复核）
  const residualChains = controlLoopChainScan(session.finalChapterDrafts).length;
  session.generationDiagnostics.llm.lastInfo = `评审关注闭环链补写：${targets.size} 章不成链定位（质量三检/进度纠偏/工资代发链），${repairedChapters} 章次落地修复，${unresolvedChapters} 章残留，终态残留 ${residualChains} 条未成链（由终门禁照常复核）`;
}
