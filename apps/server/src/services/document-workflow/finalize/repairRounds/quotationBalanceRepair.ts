/**
 * repairRounds/quotationBalanceRepair：引文成对性残缺链尾收口轮（r4 实机终门禁归因）。
 *
 * 背景：编制依据段法规长列举句 LLM 输出"自吞噬中间段"残缺——「（主席令第21号公布，2017」
 * 与「实施条例》（国务院令第613号）」直接拼接（丢失「年修正）、《中华人民共和国招标投标法」）、
 * 「（国务院令第279」与「安全生产管理条例》」直接拼接（丢失「号）、《建设工程」），
 * 终检 punctuationArtifactIssues / structureIntegrityRules.scanPunctuationBalance 报
 * 「全角括号/书名号不闭合」blocker 后，修复链无任何轮消费该类 blocker（其注释早已设计
 * "error 进修复轮由 LLM 重写所在句子/小节"，该轮从未存在）——同根因 4 项阻断直坠终门禁。
 * 本轮链尾收口：全文成对性不平衡 → 章级计数定位残缺章 → LLM 定向补全残缺拼接句，
 * 复检章级成对性恢复 + 汉字数不明显减少（防删除式修复），变差即回滚。
 * 位置在 regulation-number-typo 之后（同为"自吞噬残余"的链尾确定性/定向收口点）、
 * toc-consistency 之前。跨章抵消形态（章级全平衡但全文不平衡）无定向修复目标：
 * 显性记录交终门禁，不得猜测改写。
 */
import { repairOutcomeReason, repairOutcomeStatus } from './repairOutcome';
import { PAIRED_PUNCTUATION_SYMBOLS } from '../../structureIntegrityRules';
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import type { FinalizeSession } from '../finalizeSession';

/** 每章定向修复轮上限（残缺行可能多处：每轮修一处拼接，平衡即停） */
const MAX_BALANCE_REPAIR_ROUNDS = 2;

/** 残缺行文本随指令给出的截断上限（编制依据类长句约数百字，截断仅防御极端行） */
const MAX_LINE_EXCERPT_CHARS = 800;

/** 文本中的成对性破坏对数（不闭合的符号对计数；0=全部成对） */
function unbalancedPairCount(text: string): number {
  let count = 0;
  for (const { open, close } of PAIRED_PUNCTUATION_SYMBOLS) {
    if (text.split(open).length - 1 !== text.split(close).length - 1) count += 1;
  }
  return count;
}

function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fa5]/gu) || []).length;
}

/** 残缺行定位：给定符号对，返回首个开闭数不等的行（行号+文本） */
function locateUnbalancedLine(content: string, open: string, close: string): { lineNumber: number; text: string } | undefined {
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const openCount = lines[index].split(open).length - 1;
    const closeCount = lines[index].split(close).length - 1;
    if (openCount !== closeCount) return { lineNumber: index + 1, text: lines[index].trim().slice(0, MAX_LINE_EXCERPT_CHARS) };
  }
  return undefined;
}

export async function stageQuotationBalanceRepair(session: FinalizeSession): Promise<void> {
  // 全文成对性完好：零成本通过（链尾静默，不写进度事件）
  if (unbalancedPairCount(session.finalMarkdown) === 0) return;
  // 章级计数定位残缺章；章级全平衡而全文不平衡=跨章抵消（无定向目标，显性记录交终门禁）
  const defectiveChapters = session.finalChapterDrafts
    .map((chapter, index) => ({ chapter, index }))
    .filter(item => unbalancedPairCount(item.chapter.content) > 0);
  if (defectiveChapters.length === 0) {
    const unlocatableStage = displayStage({ type: 'validation', roleId: 'quotation-balance-repair', status: 'failed', message: '引文成对性残缺收口：全文成对性不平衡但各章计数均平衡（残缺位于目录/附表等非章区域或跨章抵消），无定向修复目标，由终门禁照常复核' }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, unlocatableStage);
    upsertProgressStage(session.finalGateRepairStages, unlocatableStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    return;
  }
  let repairedChapters = 0;
  for (const { chapter, index } of defectiveChapters) {
    let chapterContent = chapter.content;
    let rounds = 0;
    let chapterRepaired = false;
    let anyRollback = false;
    const roleId = `agent-quotation-balance-repair-${chapter.id}`;
    while (rounds < MAX_BALANCE_REPAIR_ROUNDS && unbalancedPairCount(chapterContent) > 0) {
      rounds += 1;
      // 当前残留的不配对符号对及首个残缺行（每轮以最新文本重新定位）
      const pendingDefects: Array<{ label: string; lineNumber: number; text: string }> = [];
      for (const { open, close, label } of PAIRED_PUNCTUATION_SYMBOLS) {
        if (chapterContent.split(open).length - 1 === chapterContent.split(close).length - 1) continue;
        const located = locateUnbalancedLine(chapterContent, open, close);
        if (located) pendingDefects.push({ label, ...located });
      }
      if (pendingDefects.length === 0) break;
      const instruction = [
        '【引文成对性残缺定向修复】',
        '本章存在引文成对性破坏（法规长列举句内容丢失拼接的自吞噬残留，必须修复）：',
        ...pendingDefects.map(defect => `- 第 ${defect.lineNumber} 行「${defect.label}」不配对：${defect.text}`),
        '修复要求：',
        '1. 仅修复残缺拼接处：补全被丢失的中间文本（法规名称、文号、修正年份等表述必须完整准确，如「（国务院令第279号）、《建设工程安全生产管理条例》」），恢复全角括号（）与书名号《》的成对性；',
        '2. 其余内容一字不动：不改写、不删除无关内容，不新增或删除小节，表格行不变；',
        '3. 若残缺句确实无法从上下文确定缺失内容，可删除残缺的半截引用，保留其余完整条目。',
      ].join('\n');
      const runningStage = displayStage({ type: 'llm_review', roleId, status: 'running', message: `引文成对性残缺修复中（第 ${rounds}/${MAX_BALANCE_REPAIR_ROUNDS} 轮）：${chapter.title}（${pendingDefects.map(defect => `${defect.label}第 ${defect.lineNumber} 行`).join('、')}）` }, { subtitle: '评审后兜底' });
      upsertProgressStage(session.progressStages, runningStage);
      upsertProgressStage(session.finalGateRepairStages, runningStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      const outcome = await withPatchRollback({
        originalContent: chapterContent,
        repairRound: 'quotation-balance-repair',
        diagnostics: session.generationDiagnostics,
        apply: async () => {
          const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
            template: session.template,
            chapter: { id: chapter.id, title: chapter.title, content: chapterContent, evidence: chapter.evidence, missingFacts: chapter.missingFacts, sections: chapter.sections },
            issues: pendingDefects.map(defect => `第 ${defect.lineNumber} 行${defect.label}不配对：${defect.text.slice(0, 80)}`),
            promptTexts: instruction,
            requirement: session.requirement,
            forbidDrawingImages: false,
            // 标书编制规格（正文表格口径）：修复链 system 口径同步
            bidComposition: session.bidComposition,
            diagnostics: session.generationDiagnostics,
            signal: session.signal,
            patchGuard: repairPatchGuard('quotation-balance-repair', session.generationDiagnostics),
          }));
          return repaired.content && repaired.content !== chapterContent ? repaired.content : chapterContent;
        },
        // 指标 1：成对性破坏对数（越大越差）；指标 2：负汉字数（汉字数减少=内容删除式修复，越大越差）
        recheck: (content) => [unbalancedPairCount(content), -hanCount(content)],
        shouldRollback: (before, after) => after[0] > before[0] || after[1] > before[1] + Math.max(40, Math.abs(before[1]) * 0.05),
      });
      if (outcome.rolledBack) anyRollback = true;
      if (outcome.rolledBack || outcome.content === chapterContent) break;
      chapterContent = outcome.content;
      session.finalChapterDrafts[index] = { ...chapter, content: chapterContent };
      chapterRepaired = true;
      if (unbalancedPairCount(chapterContent) === 0) break;
    }
    if (chapterRepaired) repairedChapters += 1;
    const residual = unbalancedPairCount(chapterContent);
    let message: string;
    if (residual === 0) message = `引文成对性残缺修复完成：${chapter.title}（${rounds} 轮补全，括号/书名号成对性已恢复）`;
    else if (chapterRepaired) message = `引文成对性残缺修复部分生效：${chapter.title}（已执行 ${rounds} 轮，残留 ${residual} 对不配对，由终门禁照常复核）`;
    else if (anyRollback) message = `引文成对性残缺修复已回滚：${chapter.title}（修复复检未通过，保留修复前正文；残留 ${residual} 对不配对，由终门禁照常复核）`;
    else message = `引文成对性残缺修复未生效：${chapter.title}（模型未产生有效修改；残留 ${residual} 对不配对，由终门禁照常复核）`;
    const completedStage = displayStage({ type: 'llm_review', roleId, status: repairOutcomeStatus({ after: residual, repaired: chapterRepaired }), message, details: [`残缺定位：${pendingDefectSummary(chapter.content)}`] }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (repairedChapters > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  const residualPairs = unbalancedPairCount(session.finalMarkdown);
  session.generationDiagnostics.llm.lastInfo = `引文成对性残缺收口：${defectiveChapters.length} 章残缺定位，${repairedChapters} 章落地修复，终态全文不配对 ${residualPairs} 对（残留由终门禁照常复核）`;
}

/** 章内残缺定位摘要（stage details 用）：各符号对的行号与开闭计数 */
function pendingDefectSummary(content: string): string {
  const summaries: string[] = [];
  for (const { open, close, label } of PAIRED_PUNCTUATION_SYMBOLS) {
    const openCount = content.split(open).length - 1;
    const closeCount = content.split(close).length - 1;
    if (openCount === closeCount) continue;
    const located = locateUnbalancedLine(content, open, close);
    summaries.push(`${label}开 ${openCount}/闭 ${closeCount}（第 ${located?.lineNumber ?? '?'} 行）`);
  }
  return summaries.join('；') || '无';
}
