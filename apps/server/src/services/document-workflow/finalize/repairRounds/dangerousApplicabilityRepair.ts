/**
 * repairRounds/dangerousApplicabilityRepair：危大工程辨识清单漏项链尾收口轮（r28j 实机归因：s28i 连续两轮）。
 *
 * 背景：C4 检测器 dangerousApplicabilityIssues（适用前提词面判定 × 辨识区别名覆盖）自 4.31 落地、
 * 4.41 删除确定性补写器后修复链无轮消费：s28i 正文「拆除工程」多处真实适用前提（拆改清运作业）
 * 而辨识叙述区（含「危大」行±6 行）缺「拆除工程/爆破拆除/机械拆除」别名精确词 → 终检
 * dangerous-applicability blocker 连续两轮直坠门禁。本轮链尾收口：全文缺口检测零成本通过 →
 * 定位含危大辨识区的章（含「辨识/清单锁定」叙述字样章优先，退化含「危大」章）→ LLM 定向补列
 * 遗漏适用项（补列必须紧邻既有辨识叙述/清单条目，落回辨识区覆盖范围，按建办质〔2018〕31号
 * 标注分级）→ 复检遗漏项覆盖残缺数 + 汉字数不明显减少（防删除式修复），变差即回滚；轮末
 * rebuild 后以全文检测复核（残留显性记录交终门禁，不猜测改写）。
 * 位置在 basis-regulations-repair 之后（同族链尾收口）、auto-spec-gate-repair 之前。
 */
import { repairOutcomeReason, repairOutcomeStatus } from './repairOutcome';
import { dangerousApplicabilityGaps, extractDangerZone, uncoveredDangerousItems } from '../../dangerousApplicability';
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import type { FinalizeSession } from '../finalizeSession';

/** 每章定向修复轮上限（辨识漏项可能多项：每轮补列全部缺口，复检覆盖清零即停） */
const MAX_DANGEROUS_REPAIR_ROUNDS = 2;

/** 辨识区引用在指令中的截断长度（防超长区段挤占修复 prompt） */
const MAX_ZONE_REFERENCE_CHARS = 900;

function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fa5]/gu) || []).length;
}

export async function stageDangerousApplicabilityRepair(session: FinalizeSession): Promise<void> {
  // 全文覆盖完好：零成本通过（链尾静默，不写进度事件）
  const fullGaps = dangerousApplicabilityGaps(session.finalMarkdown);
  if (fullGaps.missingNames.length === 0) return;
  // 定向目标章：含危大辨识区的章（extractDangerZone 非空）；含「辨识/清单锁定」叙述字样章优先
  const zoneChapters = session.finalChapterDrafts
    .map((chapter, index) => ({ chapter, index }))
    .filter(item => extractDangerZone(item.chapter.content) !== '');
  const narrativeTargets = zoneChapters.filter(item => /辨识清单|危大工程辨识|逐项辨识|清单锁定/u.test(item.chapter.content));
  const targets = (narrativeTargets.length > 0 ? narrativeTargets : zoneChapters.slice(0, 1))
    .filter(item => uncoveredDangerousItems(item.chapter.content, fullGaps.missingNames).length > 0);
  // 无含危大辨识区的定向修复章（全文叙述均不含辨识区痕迹）= 无定向目标，显性记录交终门禁
  if (targets.length === 0) {
    const unlocatableStage = displayStage({ type: 'validation', roleId: 'dangerous-applicability-repair', status: 'failed', message: `危大辨识清单漏项收口：全文报缺失（${fullGaps.missingNames.join('、')}）但无含危大辨识区的定向修复章，由终门禁照常复核` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, unlocatableStage);
    upsertProgressStage(session.finalGateRepairStages, unlocatableStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    return;
  }
  let repairedChapters = 0;
  for (const { chapter, index } of targets) {
    let chapterContent = chapter.content;
    let rounds = 0;
    let chapterRepaired = false;
    let anyRollback = false;
    const roleId = `agent-dangerous-applicability-repair-${chapter.id}`;
    while (rounds < MAX_DANGEROUS_REPAIR_ROUNDS && uncoveredDangerousItems(chapterContent, fullGaps.missingNames).length > 0) {
      rounds += 1;
      // 当前仍未覆盖的遗漏项（每轮以最新文本重新定位，检测定位=修复定位）
      const pendingItems = uncoveredDangerousItems(chapterContent, fullGaps.missingNames);
      if (pendingItems.length === 0) break;
      // 辨识区引用（去重行，防含「危大」行±6 行重叠导致同段重复引用）
      const zoneReference = [...new Set(extractDangerZone(chapterContent).split(/\r?\n/u))].join('\n').slice(0, MAX_ZONE_REFERENCE_CHARS);
      const instruction = [
        '【危大工程辨识清单漏项定向修复】',
        '本章危大工程辨识叙述/清单存在适用项遗漏（必须按下列缺口逐项补列，不得以概括话术代替）：',
        `- 遗漏适用项：${pendingItems.join('、')}（正文已出现适用前提但辨识清单未列入）`,
        `- 全文已出现的危大适用前提：${fullGaps.applicableNames.join('、')}（逐项核对辨识覆盖）`,
        '本章现有危大辨识区（补列条目必须紧邻其中既有辨识叙述/清单条目插入，新增句子必须保留「危大」字样语境）：',
        zoneReference,
        '修复要求：',
        `1. 仅补列遗漏项：将「${pendingItems.join('、')}」补入本章危大工程辨识叙述（自然融入既有句子或与既有条目并列成行），按建办质〔2018〕31号逐项辨识并标注分级；`,
        '2. 补列条目必须与既有辨识条目相邻（同一辨识叙述段落/同一清单块内），不得另起远离危大辨识区的独立小节；',
        '3. 不删除、不替换既有条目；其余内容一字不动：不改写、不删除无关内容，表格行不变。',
      ].join('\n');
      const runningStage = displayStage({ type: 'llm_review', roleId, status: 'running', message: `危大辨识清单漏项修复中（第 ${rounds}/${MAX_DANGEROUS_REPAIR_ROUNDS} 轮）：${chapter.title}（遗漏 ${pendingItems.length} 项）` }, { subtitle: '评审后兜底' });
      upsertProgressStage(session.progressStages, runningStage);
      upsertProgressStage(session.finalGateRepairStages, runningStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      const outcome = await withPatchRollback({
        originalContent: chapterContent,
        repairRound: 'dangerous-applicability-repair',
        diagnostics: session.generationDiagnostics,
        apply: async () => {
          const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
            template: session.template,
            chapter: { id: chapter.id, title: chapter.title, content: chapterContent, evidence: chapter.evidence, missingFacts: chapter.missingFacts, sections: chapter.sections },
            issues: pendingItems.map(item => `危大工程辨识清单遗漏适用项：${item}`),
            promptTexts: instruction,
            requirement: session.requirement,
            forbidDrawingImages: false,
            // 标书编制规格（正文表格口径）：修复链 system 口径同步
            bidComposition: session.bidComposition,
            diagnostics: session.generationDiagnostics,
            signal: session.signal,
            patchGuard: repairPatchGuard('dangerous-applicability-repair', session.generationDiagnostics),
          }));
          return repaired.content && repaired.content !== chapterContent ? repaired.content : chapterContent;
        },
        // 指标 1：遗漏项覆盖残缺数（越大越差）；指标 2：负汉字数（汉字数减少=删除式修复，越大越差）
        recheck: (content) => [uncoveredDangerousItems(content, fullGaps.missingNames).length, -hanCount(content)],
        shouldRollback: (before, after) => after[0] > before[0] || after[1] > before[1] + Math.max(40, Math.abs(before[1]) * 0.05),
      });
      if (outcome.rolledBack) anyRollback = true;
      if (outcome.rolledBack || outcome.content === chapterContent) break;
      chapterContent = outcome.content;
      session.finalChapterDrafts[index] = { ...chapter, content: chapterContent };
      chapterRepaired = true;
      if (uncoveredDangerousItems(chapterContent, fullGaps.missingNames).length === 0) break;
    }
    if (chapterRepaired) repairedChapters += 1;
    const residualItems = uncoveredDangerousItems(chapterContent, fullGaps.missingNames);
    let message: string;
    if (residualItems.length === 0) message = `危大辨识清单漏项修复完成：${chapter.title}（${rounds} 轮补列，适用项覆盖检测通过）`;
    else if (chapterRepaired) message = `危大辨识清单漏项修复部分生效：${chapter.title}（已执行 ${rounds} 轮，残留 ${residualItems.join('、')} 未覆盖，由终门禁照常复核）`;
    else if (anyRollback) message = `危大辨识清单漏项修复已回滚：${chapter.title}（修复复检未通过，保留修复前正文；残留 ${residualItems.join('、')} 未覆盖，由终门禁照常复核）`;
    else message = `危大辨识清单漏项修复未生效：${chapter.title}（模型未产生有效修改；残留 ${residualItems.join('、')} 未覆盖，由终门禁照常复核）`;
    const completedStage = displayStage({ type: 'llm_review', roleId, status: repairOutcomeStatus({ after: residualItems.length, repaired: chapterRepaired }), message, details: residualItems.length > 0 ? residualItems.map(item => `遗漏适用项：${item}`) : ['复检：危大工程辨识清单适用项覆盖检测通过'] }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (repairedChapters > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  const residualCount = dangerousApplicabilityGaps(session.finalMarkdown).missingNames.length;
  session.generationDiagnostics.llm.lastInfo = `危大辨识清单漏项收口：${targets.length} 章缺口定位，${repairedChapters} 章落地修复，终态残留 ${residualCount} 项缺口（残留由终门禁照常复核）`;
}
