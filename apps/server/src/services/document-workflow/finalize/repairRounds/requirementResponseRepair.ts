/**
 * repairRounds/requirementResponseRepair：招标要求响应定向补写轮（检测→修复链缺口补齐）。
 *
 * 背景（r3 实机终门禁 50 项阻断归因）：招标要求提取池中「显性响应」条目在写作侧漏写
 * （锚词实测：注册建造师 0 命中、保修 0 命中、回访 0 命中），章级验收 requirementAcceptanceIssues
 * 报「零响应/部分响应」blocker 后，修复链无任何轮消费该类 blocker——40+ 项要求未响应直接坠入
 * 终门禁（复核清单）。本轮补齐该链路缺口：消费 requirements-coverage blocker
 * （provenance.detectorId 精确反查条目，不解析 message 文案），按主责章
 * （requirementAssignments 蓝图分配，与章级注入/验收同源）分组定向补写。
 *
 * 补写素材：条款原文经 bidderVoiceClauseText 转投标人口吻（与检测端 voice 分句通道同源），
 * 关键分句与数字逐字保留；缺失锚点逐条反馈。复检：tenderRequirementResponseGaps
 * 确定性三通道（与检测器 clauseSatisfied 严格同源，零嵌入成本）。
 * V5 P4.2 收敛修复：每章最多 2 轮，残留数下降才继续下一轮，不降/回滚即停止；
 * 与 C2/C3 不同——残留不转 warning：要求未响应是评标失分风险，由终门禁照常复核（宁缺毋假）。
 *
 * r4 实机归因新增外层收敛周期（MAX_RESPONSE_REPAIR_CYCLES）：补写轮改写多章文本后
 * recompute 语义重算时，语义边缘项（最佳相似度 0.55–0.60）发生滑移新报残留——单周期
 * 结束时的新残留此前无轮消费直坠终门禁。外层周期在「新残留数下降」时再消费一轮
 * （重新分组、每章重新 2 轮收敛），上限 2 周期；周期内章级逻辑与单周期间完全一致。
 * 修复落地后 rebuildFinalMarkdown + recomputeFinalValidationBundle 复验终态残留。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { bidderVoiceClauseText, normalizeChapterTitleLine, requirementAcceptanceIssues, tenderRequirementCheckItems, tenderRequirementResponseGaps, tenderRequirementSemanticQuery } from '../../tenderRequirements';
import type { TenderRequirementAssignment } from '../../tenderRequirements';
import { bodySentencesForSemantic, REQUIREMENTS_SEMANTIC_SENTENCE_LIMIT } from '../../documentIntegrityChecks';
import { buildSemanticSimilarity } from '../../semanticSimilarity';
import { stableHash } from '../../utils';
import { documentTextLength } from '../../budget';
import { buildChapterBudgetLedger, chapterBudgetEntryByTitle, chapterOverflowAfterRound, mergeLandedInserts, recordChapterBudgetMetric, renderChapterBudgetInstruction, renderChapterOverflowNote } from './chapterBudgetLedger';
import type { ChapterBudgetEntry, ChapterBudgetLedger } from './chapterBudgetLedger';
import type { TenderRequirementEntry, TenderRequirementModel } from '../../types';
import type { FinalizeSession } from '../finalizeSession';

/** V5 P4.2 收敛修复：每章定向补写轮上限（残留数下降才继续下一轮；不降/回滚/达上限即停止） */
const MAX_RESPONSE_REPAIR_ROUNDS = 2;

/**
 * r4 实机归因：外层收敛周期上限（补写后 recompute 语义重算新报的残留需要再消费；
 * 首周期处理初检 blocker，第二周期处理首周期改写后新滑移出的残留）
 */
const MAX_RESPONSE_REPAIR_CYCLES = 2;

/** 单条款补写素材字数上限（防御性截断；正常条款远小于该值） */
const MAX_CLAUSE_MATERIAL_CHARS = 600;

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

/** blocker 过滤单源（周期循环每轮以最新 validationIssues 为准；链尾终局收口复用） */
export function requirementResponseBlockers(session: FinalizeSession) {
  return session.validationIssues.filter(issue => issue.severity === 'blocker' && issue.provenance?.detectorId === 'requirements-coverage');
}

export async function stageRequirementResponseRepair(session: FinalizeSession, options?: { silent?: boolean }): Promise<void> {
  if (!session.tenderRequirements?.extracted) return;
  // 条目全集 + 指纹索引（周期循环共用；entryByFingerprint 与 requirementAcceptanceIssues 的 provenance.fingerprint 同源）
  const entries = tenderRequirementCheckItems(session.tenderRequirements).map(({ item }) => item);
  const entryByFingerprint = new Map(entries.map(entry => [stableHash(entry.text), entry]));
  let firstCycleBlockerCount = 0;
  let unlocatedTotal = 0;
  let repairedChaptersTotal = 0;
  let resolvedTotal = 0;
  let repairedInAnyCycle = false;
  for (let cycle = 1; cycle <= MAX_RESPONSE_REPAIR_CYCLES; cycle += 1) {
    // 输入=检测链最新 blocker（requirements-coverage provenance 精确过滤，不依赖 message 文案）
    const blockerIssues = requirementResponseBlockers(session);
    if (blockerIssues.length === 0) {
      if (cycle === 1) {
        // r7 链尾重放（postReviewSurface 在 quotation-balance-repair 后调用）：silent 模式无新 blocker
        // 时零成本返回——不改写首轮真实补写记录（被动回退导致的重放仅在确有残留时重新消费）
        if (options?.silent) return;
        const passStage = displayStage({ type: 'validation', roleId: 'requirement-response-repair', status: 'success', message: '招标要求响应验收通过：全部显性响应类要求均已在正文中检出' }, { subtitle: '招标要求响应核验' });
        upsertProgressStage(session.progressStages, passStage);
        upsertProgressStage(session.finalGateRepairStages, passStage);
        session.emitProgress(session.finalChapterDrafts, session.progressStages);
        return;
      }
      // 收敛周期后清零：终态无残留，循环收口
      break;
    }
    if (cycle === 1) firstCycleBlockerCount = blockerIssues.length;
    const cycleLabel = cycle > 1 ? `（收敛周期 ${cycle}/${MAX_RESPONSE_REPAIR_CYCLES}：处理上轮补写后重算新报残留）` : '';
    // 条目 → 主责章分组（蓝图分配单源；标题归一化匹配 + includes 兜底）
    const blockersByChapter = new Map<number, TenderRequirementEntry[]>();
    const seenEntryTexts = new Set<string>();
    let unlocatedCount = 0;
    for (const issue of blockerIssues) {
      const entry = issue.provenance ? entryByFingerprint.get(issue.provenance.fingerprint) : undefined;
      if (!entry) {
        unlocatedCount += 1;
        continue;
      }
      if (seenEntryTexts.has(entry.text)) continue;
      const assignment = session.requirementAssignments.find(item => item.entry.text === entry.text);
      if (!assignment) {
        unlocatedCount += 1;
        continue;
      }
      const target = normalizeChapterTitleLine(assignment.chapterTitle);
      let chapterIndex = session.finalChapterDrafts.findIndex(chapter => normalizeChapterTitleLine(chapter.title) === target);
      if (chapterIndex < 0) {
        chapterIndex = session.finalChapterDrafts.findIndex(chapter => {
          const title = normalizeChapterTitleLine(chapter.title);
          return title.includes(target) || target.includes(title);
        });
      }
      if (chapterIndex < 0) {
        unlocatedCount += 1;
        continue;
      }
      seenEntryTexts.add(entry.text);
      const list = blockersByChapter.get(chapterIndex) ?? [];
      list.push(entry);
      blockersByChapter.set(chapterIndex, list);
    }
    unlocatedTotal += unlocatedCount;
    if (blockersByChapter.size === 0) {
      if (cycle === 1) {
        const failedStage = displayStage({ type: 'validation', roleId: 'requirement-response-repair', status: 'failed', message: `招标要求响应补写无法定位责任章：${blockerIssues.length} 条未响应要求均未匹配到蓝图分配记录（由终门禁照常复核）` }, { subtitle: '招标要求响应核验' });
        upsertProgressStage(session.progressStages, failedStage);
        upsertProgressStage(session.finalGateRepairStages, failedStage);
        session.emitProgress(session.finalChapterDrafts, session.progressStages);
        return;
      }
      break;
    }
    // 定向补写指令：条款原文 voice 素材（关键分句逐字保留）+ 缺失锚点反馈 + 反条幅/局部修改约束
    const instructionFor = (pendingGaps: Array<{ entry: TenderRequirementEntry; missing: string[] }>, round: number, budgetEntry?: ChapterBudgetEntry): string => [
      '【招标要求响应定向补写修复】',
      ...(round > 1 ? [`本轮为第 ${round} 轮（最多 ${MAX_RESPONSE_REPAIR_ROUNDS} 轮）：上一轮补写后复检仍有要求未完全响应，请针对下列缺口逐条严格补足。`] : []),
      '下列招标文件明确要求（评标实质性内容）经全文验收未完全响应。请在正文最合适的位置补写实质性响应内容：',
      '1. 逐条以投标人口吻（我方/本公司）写出条款实质内容与配套保证措施，必须是正式施组正文行文；',
      '2. 下列「建议口径」是条款原文的投标人口吻转换：其关键分句与数字参数必须逐字保留（可自然衔接、调整语序，但专有名词/等级/数字/单位不得改字）；',
      '3. 禁止「按招标文件要求：」「按上述条款」类条幅前缀与任何元话语；',
      '4. 只做局部修改：优先并入既有相关段落，或在合适小节内插入补写段落；不得新增、删除或合并小节，不得改动无关内容。',
      // 4.56 2-b：章预算账（补写额度约束；要求响应类补写同样是「修复链无预算追加」的来源之一）
      ...(budgetEntry ? [renderChapterBudgetInstruction(budgetEntry)] : []),
      ...pendingGaps.flatMap(gap => {
        const material = bidderVoiceClauseText(gap.entry.text).replace(/\s+/gu, ' ').trim();
        const lines = [`- [${gap.entry.category}] 建议口径：${material.slice(0, MAX_CLAUSE_MATERIAL_CHARS)}`];
        if (gap.missing.length > 0) lines.push(`  验收缺口（补写须覆盖）：${gap.missing.join('、')}`);
        return lines;
      }),
    ].join('\n');
    let repairedChapters = 0;
    for (const [chapterIndex, chapterEntries] of blockersByChapter) {
      const draftChapter = session.finalChapterDrafts[chapterIndex];
      let chapterContent = draftChapter.content;
      let pending = chapterEntries;
      let beforeCount = tenderRequirementResponseGaps(pending, chapterContent).filter(gap => !gap.satisfied).length;
      // 防御：blocker 快照与当前正文不同源（正文已改但未重算）时跳过，交由重算链兜底
      if (beforeCount === 0) continue;
      let rounds = 0;
      let chapterRepaired = false;
      let anyRollback = false;
      const residualTrajectory = [beforeCount];
      const roleId = `agent-requirement-response-repair-${draftChapter.id}`;
      /** 4.56 2-b：本轮章级超额注记（累积进阶段 message/details，与 metrics 同源） */
      const overflowNotes: string[] = [];
      while (pending.length > 0 && rounds < MAX_RESPONSE_REPAIR_ROUNDS) {
        rounds += 1;
        const pendingGaps = tenderRequirementResponseGaps(pending, chapterContent).filter(gap => !gap.satisfied);
        if (pendingGaps.length === 0) break;
        const roundStartedAt = Date.now();
        const runningStage = displayStage({ type: 'llm_review', roleId, status: 'running', message: `招标要求响应补写中${cycleLabel}（第 ${rounds}/${MAX_RESPONSE_REPAIR_ROUNDS} 轮）：${draftChapter.title}（${pendingGaps.length} 条要求未完全响应）`, details: pendingGaps.map(gap => `未响应：${gap.entry.category}（缺：${gap.missing.join('、') || '全文零命中'}）`) }, { subtitle: '招标要求响应核验' });
        upsertProgressStage(session.progressStages, runningStage);
        upsertProgressStage(session.finalGateRepairStages, runningStage);
        session.emitProgress(session.finalChapterDrafts, session.progressStages);
        const outcome = await withPatchRollback({
          originalContent: chapterContent,
          repairRound: 'requirement-response-repair',
          diagnostics: session.generationDiagnostics,
          beforeMetrics: [pendingGaps.length],
          apply: async () => {
            // 4.56 2-b：预算账按实时正文结算后注入指令（本轮额度约束）
            const budgetEntry = chapterBudgetEntryFor(session, chapterIndex, chapterContent);
            const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
              template: session.template,
              chapter: { id: draftChapter.id, title: draftChapter.title, content: chapterContent, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
              issues: pendingGaps.map(gap => `招标要求未响应（${gap.entry.category}）：${gap.entry.text.slice(0, 60)}`),
              promptTexts: instructionFor(pendingGaps, rounds, budgetEntry),
              requirement: session.requirement,
              forbidDrawingImages: false,
              // 标书编制规格（正文表格口径）：修复链 system 口径同步
              bidComposition: session.bidComposition,
              diagnostics: session.generationDiagnostics,
              signal: session.signal,
              patchGuard: repairPatchGuard('requirement-response-repair', session.generationDiagnostics),
            }));
            return repaired.content && repaired.content !== chapterContent ? repaired.content : chapterContent;
          },
          recheck: (content) => [tenderRequirementResponseGaps(pending, content).filter(gap => !gap.satisfied).length],
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
          recordChapterBudgetMetric({ diagnostics: session.generationDiagnostics, round: 'requirement-response-repair', startedAt: roundStartedAt, report: overflowReport });
        }
        const afterCount = tenderRequirementResponseGaps(pending, chapterContent).filter(gap => !gap.satisfied).length;
        residualTrajectory.push(afterCount);
        // 收敛判定：清零即通过；未下降（含回滚/空修复）即停止；下降且未达上限 → 再修一轮（残留数下降才继续）
        if (afterCount === 0 || afterCount >= beforeCount || rounds >= MAX_RESPONSE_REPAIR_ROUNDS) break;
        beforeCount = afterCount;
        pending = tenderRequirementResponseGaps(pending, chapterContent).filter(gap => !gap.satisfied).map(gap => gap.entry);
      }
      if (chapterRepaired) repairedChapters += 1;
      const residualGaps = tenderRequirementResponseGaps(chapterEntries, chapterContent).filter(gap => !gap.satisfied);
      resolvedTotal += chapterEntries.length - residualGaps.length;
      const residualNote = `残留 ${residualGaps.length} 条要求未完全响应，由终门禁照常复核`;
      let message: string;
      if (residualGaps.length === 0) message = `招标要求响应补写完成${cycleLabel}：${draftChapter.title}（${chapterEntries.length} 条要求经 ${rounds} 轮补写全部响应）`;
      else if (chapterRepaired) message = `招标要求响应补写部分生效${cycleLabel}：${draftChapter.title}（残留轨迹 ${residualTrajectory.join('→')}，已执行 ${rounds} 轮；${residualNote}）`;
      else if (anyRollback) message = `招标要求响应补写已回滚${cycleLabel}：${draftChapter.title}（修复后未响应数未下降，保留修复前正文；${residualNote}）`;
      else message = `招标要求响应补写未生效${cycleLabel}：${draftChapter.title}（模型未产生有效修改；${residualNote}）`;
      // 4.56 2-b：章级超额观测上屏（message 摘要 + details 逐条）
      if (overflowNotes.length > 0) message = `${message}；${overflowNotes[overflowNotes.length - 1]}`;
      const completedStage = displayStage({ type: 'llm_review', roleId, status: residualGaps.length === 0 ? 'success' : 'failed', message, details: [...chapterEntries.map(entry => `要求：${entry.category}「${entry.text.slice(0, 60)}」`), ...(residualGaps.length > 0 ? [`残留未响应 ${residualGaps.length} 条：${residualGaps.map(gap => `「${gap.entry.text.slice(0, 40)}」缺 ${gap.missing.join('、') || '全文零命中'}`).join('；')}`] : []), ...overflowNotes] }, { subtitle: '招标要求响应核验' });
      upsertProgressStage(session.progressStages, completedStage);
      upsertProgressStage(session.finalGateRepairStages, completedStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
    }
    if (repairedChapters > 0) {
      repairedChaptersTotal += repairedChapters;
      repairedInAnyCycle = true;
      session.finalMarkdown = session.rebuildFinalMarkdown();
      await session.recomputeFinalValidationBundle();
    } else {
      // 本周期无修复落地（全部回滚/未生效/防御跳过）：同样内容再补写无意义，停止外层循环
      break;
    }
    // 外层收敛判定：recompute 后的最新残留（含语义通道复验）；清零或未下降即停止，下降则再跑一个收敛周期
    const residualIssues = requirementResponseBlockers(session);
    if (residualIssues.length === 0 || residualIssues.length >= blockerIssues.length) break;
  }
  // 终态残留=重算后检测链最新 blocker 数（含语义通道复验，口径比确定性复检更宽松）
  const residualBlockers = requirementResponseBlockers(session);
  if (repairedInAnyCycle || firstCycleBlockerCount > 0) {
    session.generationDiagnostics.llm.lastInfo = `招标要求响应定向补写：初检 ${firstCycleBlockerCount} 条未响应要求（定位 ${firstCycleBlockerCount - Math.min(unlocatedTotal, firstCycleBlockerCount)} 条${unlocatedTotal > 0 ? `，未定位 ${unlocatedTotal} 条` : ''}），章级定向补写（每章最多 ${MAX_RESPONSE_REPAIR_ROUNDS} 轮收敛修复，收敛周期上限 ${MAX_RESPONSE_REPAIR_CYCLES}），${repairedChaptersTotal} 章次落地，本次修复响应 ${resolvedTotal} 条，终态残留 ${residualBlockers.length} 条（由终门禁照常复核）`;
  }
}

// ═══════════════════════════ r10 链尾要求响应终局收口 ═══════════════════════════

/** 链尾终局收口单次确定性补写上限（C3-3 扩容：D6 消费面扩容后残留规模可达数十条——
 * 语义放行但锚点缺口的条目全部进入修复消费面，单轮 32 × 上限 3 轮覆盖 ~96 条） */
/**
 * 链尾收口**每轮批量**（不是总量上限）：32 条/轮。
 * `attemptedSignatures` 会把已尝试的条目排除，故下一轮自然取「尚未尝试」的下一批——
 * 真正的悬崖在 `MAX_TAIL_CLOSURE_ROUNDS`（见其注释）。上限治理：批量保留，总量不设。
 */
const MAX_TAIL_CLOSURE_INSERTS = 32;

/** C8 S1 查重下限（24→8）：签名归一化后 ≥8 字符才参与查重——短于 8 的素材子串可能自然命中
 * 正文不参与判定；≥8 的等价形态全文命中视为已落位（历史 24 护栏使「（9）发现脏、差，有缺损。」
 * 等 12 字符短条款完全不查重 → 三连重复） */
const INSERTION_SIGNATURE_MIN_CHARS = 8;

export interface RequirementTailClosureResult {
  markdown: string;
  insertedCount: number;
  /** C8 S1：形态闸拒插素材条数（显性明细在 details；对应残留由终门禁照常复核，零静默降级） */
  rejectedCount: number;
  /** 4.56 2-b ③：**章级总量预算**截断条数——额度不足未插入的素材（显性明细在 details；对应残留由
   * 终门禁照常复核。不插必报，静默不插＝缺陷消失，比超产更严重） */
  budgetSkippedCount: number;
  details: string[];
  /** 4.56 2-b ③：本步已落位素材的**结构化**清单（章标题为空串＝未定位回退文末）。
   * 收口为 markdown-only 插入不写章草稿，调用方跨轮重算额度时必须把它计入——否则每轮都从
   * 章草稿重建账本，同一章额度被重复授予（收口轮数 × 额度）。 */
  insertions: Array<{ chapterTitle: string; material: string }>;
}

/** 插入物签名归一化（C8 S1 ② 查重加固）：字符变体折叠——乘号族（×、✕、✖、✗、✘ 与星号）、
 * 引号族、全半角、括号/标点形态、省略号——用于「素材是否已按等价形态落位正文」的查重。
 * r28m' 实证：「4000×3200」与「4000*3200」字符差异使 includes 查重失效 → 重复插入。 */
export function insertionSignature(text: string): string {
  return text
    .replace(/[０-９Ａ-Ｚａ-ｚ]/gu, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/％/gu, '%')
    .replace(/[×✕✖✗✘✳*·‧・]/gu, '*')
    .replace(/[「」『』“”„‟"'`´]/gu, '"')
    .replace(/[（【〔〖]/gu, '(')
    .replace(/[）】〕〗]/gu, ')')
    .replace(/[，、]/gu, ',')
    .replace(/。/gu, '.')
    .replace(/；/gu, ';')
    .replace(/：/gu, ':')
    .replace(/！/gu, '!')
    .replace(/？/gu, '?')
    .replace(/[－—–‐]/gu, '-')
    .replace(/…/gu, '...')
    .replace(/\s+/gu, '')
    .toLowerCase();
}

/** 插入物形态闸（C8 S1 ④，确定性零 LLM）：返回拒绝原因（null=放行）。链尾插入物直接进交付成稿、
 * 无后续质量闸——拒插素材显性记录于 details，对应残留由终门禁照常复核（宁缺毋假）。
 * 边界（防误拒真素材）：①过短——归一化后 <6 字符与 clauseSegmentCoverage 下限同源（插入也不可能
 * 达成分句落位，纯污染）；②表格/拍平——含 | 或制表符（品牌表拍平残片实机形态）；③括号不配对——
 * 四种括号族各自计数不等（截断/拼接残片）；④OCR 残片——括号内 4-8 位无义字母数字串
 * （r28m' 实录「（18laxj）」）；⑤截断尾——全文无句末终止符且以连接/虚词字符或逗号顿号结尾
 * （r28m' 实录「…由代理机构在发布最」；含句末标点的完整表述不在此列，避免误拒无标点长句）。 */
export function insertionMaterialRejection(material: string): string | null {
  const text = material.trim();
  if (!text) return '空素材';
  if (insertionSignature(text).length < 6) return '过短素材（归一化 <6 字符，插入亦无法达成分句落位）';
  if (/[|\t]/u.test(text)) return '表格拍平残片（含表格分隔符）';
  for (const [open, close] of [['（', '）'], ['(', ')'], ['【', '】'], ['「', '」']] as const) {
    const openCount = text.split(open).length - 1;
    const closeCount = text.split(close).length - 1;
    if (openCount !== closeCount) return `括号不配对（${open}${close} ${openCount}/${closeCount}）`;
  }
  if (/[（(][0-9a-zA-Z]{4,8}[）)]/u.test(text)) return 'OCR 残片（括号内无义字母数字串）';
  const noTerminal = !/[。！？；.!?;：:]/u.test(text);
  if (noTerminal && /(?:[，、,]|[与和及或将把对从向于至到则而并且以最更较刚正才遂仍])$/u.test(text)) return '截断尾（无句末标点且以连接/虚词字符结尾）';
  return null;
}

/**
 * r10 链尾要求响应终局收口（r9 #1/#2 实机归因，机制级收口）：
 * 要求响应修复的全部轮次（主链 + postReviewSurface 静默重放）都位于终稿最后净变更阶段之前——
 * 边缘语义条款（相似度 0.60x）在后续 content-depth 重写/确定性清洗引起的正文漂移中滑出 0.6
 * 阈值后新报的 blocker（r9 实证：#1/#2 两条质量保修要求以 0.59x 零命中浮现）再无任何修复轮
 * 消费，直坠终门禁（复盘实证：各修复批次明细从未出现两条要求的踪迹，终门禁却报「自动轮次已
 * 耗尽」）。本函数在 postReviewSurface 最尾部（toc-consistency / 蓝图数值重放之后）以检测端
 * 完全同源口径（requirementAcceptanceIssues + 现场构建语义闭包）对最终成稿重跑 requirements-
 * coverage，对残留 blocker 用条款原文的投标人口吻转换（bidderVoiceClauseText，与检测端
 * voice 分句通道同源——插入文本按构造满足 clauseSatisfied）确定性补写至主责章末（章定位与
 * 修复轮同源：requirementAssignments 蓝图分配 + normalizeChapterTitleLine 标题匹配；未定位
 * 回退文末）。调用方随后 recompute，保证「终门禁所检 = 修复所写」；已满足条目天然不在残留中
 * （现场重跑判定），重放幂等零成本。
 * C8 S1 质量闸：插入前签名归一化查重（insertionSignature，下限 24→8 字符）+ 形态闸
 * （insertionMaterialRejection：过短/拍平/括号不配对/OCR 残片/截断尾 → 拒插+显性记录）；
 * attemptedSignatures 跨轮传递「已插入/已拒插」签名——插入过的不重插。
 */
export async function applyRequirementTailClosure(input: {
  markdown: string;
  tenderRequirements?: TenderRequirementModel;
  requirementAssignments: TenderRequirementAssignment[];
  signal?: FinalizeSession['signal'];
  diagnostics?: FinalizeSession['generationDiagnostics'];
  /** C8 S1 跨轮幂等：调用方（replayRequirementTailClosure 循环）跨轮传递的「已尝试签名」集合
   * （插入过/拒插过的不重试）；单测/单次调用不传时本函数内新建 */
  attemptedSignatures?: Set<string>;
  /** 单测注入的嵌入实现（替代本地模型），生产环境不传（与 buildSemanticSimilarity 同口径） */
  embedDocuments?: (texts: string[]) => Promise<number[][]>;
  /**
   * 4.56 2-b ③ 章级总量预算账（调用方以 session.documentBudget + session.finalChapterDrafts 构建；
   * 不传＝不做预算约束，保持单测/旧调用点行为不变）。
   *
   * 本通道是**确定性批量插入**（原先无任何总量上限）：一次可插 MAX_TAIL_CLOSURE_INSERTS 条、
   * 循环 MAX_TAIL_CLOSURE_ROUNDS 轮。加预算后：按章把素材分配到该章**剩余额度**内，额度不足的
   * 条目不插 + 显性报出。**不插必报**：对应残留天然留在终检 requirements-coverage 阻断项里，
   * 由终门禁照常复核（绝不静默丢弃——静默不插等于缺陷消失，比超产更严重）。
   */
  chapterBudget?: ChapterBudgetLedger;
}): Promise<RequirementTailClosureResult> {
  const noop: RequirementTailClosureResult = { markdown: input.markdown, insertedCount: 0, rejectedCount: 0, budgetSkippedCount: 0, details: [], insertions: [] };
  const entries = tenderRequirementCheckItems(input.tenderRequirements).map(({ item }) => item);
  if (entries.length === 0) return noop;
  // 检测端同源现场重跑（与 documentFinalValidation requirements-coverage 装配逐项一致）
  const queries = entries.map(entry => tenderRequirementSemanticQuery(entry));
  const chapterLines = input.markdown.split(/\n/u).filter(line => /^#{2,4}\s/u.test(line.trim())).map(line => normalizeChapterTitleLine(line)).filter(Boolean).slice(0, 80);
  // 检测端同源现场重跑（与 documentFinalValidation requirements-coverage 装配逐项一致）；
  // 句集全量档（r11 滑移治理）：插入动作改变句数后 stride 采样集整体洗牌，边缘条款 0.60x→0.57
  // 滑出阈值——本通道同时供“插入前残留判定”与调用方循环复检，必须与终门禁所见严格同集
  const bodySentences = bodySentencesForSemantic(input.markdown, REQUIREMENTS_SEMANTIC_SENTENCE_LIMIT);
  const semanticSimilarity = await buildSemanticSimilarity(queries, [...chapterLines, ...bodySentences], input.embedDocuments);
  const issues = await requirementAcceptanceIssues({
    markdown: input.markdown,
    entries,
    bodyTexts: bodySentences,
    semanticSimilarity,
    signal: input.signal,
    diagnostics: input.diagnostics,
  });
  const blockers = issues.filter(issue => issue.severity === 'blocker' && issue.provenance?.detectorId === 'requirements-coverage');
  if (blockers.length === 0) return noop;
  const entryByFingerprint = new Map(entries.map(entry => [stableHash(entry.text), entry]));
  const seenTexts = new Set<string>();
  // 防重复插入（C8 S1 查重加固 + 跨轮幂等）：签名归一化比较（乘号族/引号族/全半角/标点折叠，
  // 见 insertionSignature）+ 下限 24→8 字符；调用方循环化的重放通过 attemptedSignatures 跨轮
  // 传递「已插入/已拒插」签名——插入过的不重插。重复段落对交付质量的伤害大于缺一条补写；
  // 未落位残留由终门禁照常复核。查重命中静默跳过（正文已含等价形态，无需记录）。
  const markdownSignature = insertionSignature(input.markdown);
  const attempted = input.attemptedSignatures ?? new Set<string>();
  const rejectedDetails: string[] = [];
  const budgetSkippedDetails: string[] = [];
  // 4.56 2-b ③ 章级总量预算：额度按「章」结算（章标题 → 剩余额度），未定位条目（回退文末）
  // 计入文档级剩余额度。remaining 可变（同一次调用内多条素材插同一章须累计扣减）。
  const chapterRemaining = new Map<string, number>();
  const documentRemaining = { value: input.chapterBudget ? input.chapterBudget.document.remaining : Number.POSITIVE_INFINITY };
  const remainingFor = (chapterTitle: string): { label: string; get: () => number; take: (cost: number) => void } | undefined => {
    if (!input.chapterBudget) return undefined;
    const entry = chapterBudgetEntryByTitle(input.chapterBudget, chapterTitle);
    if (!entry) {
      // 未定位素材（回退文末）：挂文档级额度，避免「无章归属即无约束」
      return { label: '全文', get: () => documentRemaining.value, take: cost => { documentRemaining.value -= cost; } };
    }
    if (!chapterRemaining.has(entry.chapterId)) chapterRemaining.set(entry.chapterId, entry.remaining);
    return { label: entry.title, get: () => chapterRemaining.get(entry.chapterId) ?? 0, take: cost => chapterRemaining.set(entry.chapterId, (chapterRemaining.get(entry.chapterId) ?? 0) - cost) };
  };
  const records: Array<{ entry: TenderRequirementEntry; chapterTitle: string; material: string }> = [];
  for (const issue of blockers) {
    if (records.length >= MAX_TAIL_CLOSURE_INSERTS) break;
    const entry = issue.provenance ? entryByFingerprint.get(issue.provenance.fingerprint) : undefined;
    if (!entry || seenTexts.has(entry.text)) continue;
    // 条款原文 → 投标人口吻（关键分句逐字保留；空白折叠与检测端 normalize 同口径——C8 S1 起
    // 行首枚举前缀随 bidderVoiceClauseText 统一剥离：检测端 voice 分句通道同函数同源剥离，
    // 插入物与判定侧形态严格一致，条款号不再泄漏进正文）
    const material = bidderVoiceClauseText(entry.text).replace(/\s+/gu, '').trim();
    if (!material) continue;
    const signature = insertionSignature(material);
    if (attempted.has(signature)) continue;
    if (signature.length >= INSERTION_SIGNATURE_MIN_CHARS && markdownSignature.includes(signature)) {
      attempted.add(signature);
      continue;
    }
    const rejection = insertionMaterialRejection(material);
    if (rejection) {
      attempted.add(signature);
      rejectedDetails.push(`【${entry.category}】形态闸拒插（${rejection}）：${material.slice(0, 40)}${material.length > 40 ? '…' : ''}`);
      continue;
    }
    const assignment = input.requirementAssignments.find(item => item.entry.text === entry.text);
    const chapterTitle = assignment?.chapterTitle || '';
    // 4.56 2-b ③ 章级总量预算闸：额度不足即不插，并**显性报出**（不静默丢弃）。
    // 成本口径与预算账同源（documentTextLength），保证「插入字数 = 账本扣减字数」逐笔对得上。
    const quota = remainingFor(chapterTitle);
    if (quota) {
      const cost = documentTextLength(material);
      const remaining = quota.get();
      if (cost > remaining) {
        // 幂等：记入 attempted，同一重放内不重复空转（下次由调用方在链尾重放时按新额度重算）
        attempted.add(signature);
        budgetSkippedDetails.push(`【${entry.category}】章预算额度不足未插入（${quota.label} 剩余额度 ${remaining} 字 < 需插入 ${cost} 字）：${material.slice(0, 40)}${material.length > 40 ? '…' : ''}（残留由终门禁照常复核）`);
        continue;
      }
      quota.take(cost);
    }
    seenTexts.add(entry.text);
    attempted.add(signature);
    records.push({ entry, chapterTitle, material });
  }
  if (records.length === 0) {
    return { markdown: input.markdown, insertedCount: 0, rejectedCount: rejectedDetails.length, budgetSkippedCount: budgetSkippedDetails.length, details: [...budgetSkippedDetails, ...rejectedDetails], insertions: [] };
  }
  let markdown = input.markdown;
  const paragraphsByChapter = new Map<string, string[]>();
  for (const record of records) {
    const list = paragraphsByChapter.get(record.chapterTitle) ?? [];
    list.push(record.material);
    paragraphsByChapter.set(record.chapterTitle, list);
  }
  for (const [chapterTitle, paragraphs] of paragraphsByChapter) {
    markdown = insertParagraphsAtChapterEnd(markdown, chapterTitle, paragraphs);
  }
  // 确定性复验（零嵌入成本）：插入文本按构造满足条款判定通道；未确认项显式记录不静默
  const verified = tenderRequirementResponseGaps(records.map(record => record.entry), markdown).filter(gap => gap.satisfied).length;
  const details = [
    ...records.map(record => `【${record.entry.category}】${record.chapterTitle || '文末'}：${record.material.slice(0, 48)}${record.material.length > 48 ? '…' : ''}`),
    // 4.56 2-b ③：额度不足未插条目显性报出（先于形态闸记录，便于复盘时按「预算」而非「质量」归因）
    ...budgetSkippedDetails,
    ...rejectedDetails,
    ...(verified < records.length ? [`未确认落位 ${records.length - verified} 条（由终门禁照常复核）`] : []),
  ];
  return {
    markdown,
    insertedCount: records.length,
    rejectedCount: rejectedDetails.length,
    budgetSkippedCount: budgetSkippedDetails.length,
    details,
    insertions: records.map(record => ({ chapterTitle: record.chapterTitle, material: record.material })),
  };
}

/** r11 链尾收口循环上限（r10 实机 #3 机制归因：单次收口插入补写文本后句集变化引发语义采样重洗，
 * 边缘条款 0.60x→0.57 新浮出残留无轮消费——循环收口每轮消费「插入后新浮现」的残留，
 * 插入文本按构造满足条款判定（insertedCount>0 即残留已实降），正常 1-2 轮收敛，上限防振荡） */
/**
 * 链尾收口轮数**安全上限**（原 3，配合每轮 32 条 ⇒ 残留超 ~96 条时尾部不再补写）。
 * 上限治理：改为**达标驱动**——循环持续到残留清零或不再下降，本值仅兜住最坏情况。
 * 每轮 = 一次 LLM 补写，故本值直接乘算成本；仍以「严格下降」为闸的理据同 P2-5。
 */
export const MAX_TAIL_CLOSURE_ROUNDS = 8;

/**
 * r10 链尾要求响应终局收口（可重放形态，r15 封装范式）：在调用点以检测端完全同源口径现场重跑
 * requirements-coverage，对残留 blocker 用条款原文投标人口吻转换确定性补写至主责章末；随后
 * recompute 保证「终门禁所检 = 修复所写」。已满足条目天然不在残留中（现场重跑判定），重放幂等零成本。
 * 调用点：stagePostReviewSurface 尾部内联（原位置：toc-consistency / 蓝图数值重放之后）+ documentPipeline
 * 链尾重放（r24 B1-B5 实机归因：本收口为 markdown-only 插入不写章草稿，其后 stageFactDistribution 的
 * rebuildFinalMarkdown 从章 drafts 重拼成稿把插入全部回退——r23 实测「一级建造师」等 5 条补写阶段记录
 * success 而终稿零踪迹、终检重新检出直坠终门禁；由 pipeline 在最后一次净变更点之后、终门禁之前再调用，
 * 与 runSurfaceDeterministicCleans / replayBlueprintCitationNumericFixes 同范式）。
 * C8 S1：跨轮幂等（attemptedSignatures 在循环内跨轮传递「已插入/已拒插」签名——插入过的
 * 不重插）；形态闸拒插素材并入 details 显性记录（拒插不为零成本静默，残留由终门禁照常复核）。
 */
export async function replayRequirementTailClosure(session: FinalizeSession): Promise<void> {
  if (!session.tenderRequirements?.extracted) return;
  let totalInserted = 0;
  let totalRejected = 0;
  let totalBudgetSkipped = 0;
  // C8 S1 跨轮幂等：本重放内「已插入/已拒插」签名集合跨轮传递（插入过/拒插过的不重试）
  const attemptedSignatures = new Set<string>();
  const tailDetails: string[] = [];
  // 4.56 2-b ③：本重放内已落位的收口素材——收口为 markdown-only 插入**不写章草稿**，故下一轮
  // 重建账本时必须回灌（mergeLandedInserts），否则同一章额度会被每轮重复授予（收口轮数 × 额度）。
  const landedInsertions: Array<{ chapterTitle: string; material: string }> = [];
  let residualCount = 0;
  for (let closureRound = 1; closureRound <= MAX_TAIL_CLOSURE_ROUNDS; closureRound += 1) {
    // 4.56 2-b ③：章级总量预算账（每轮重算——上一轮插入后各章剩余额度已变，用新额度结算）
    const merged = mergeLandedInserts(session.finalChapterDrafts, landedInsertions);
    const baseLedger = buildChapterBudgetLedger({
      chapterTargets: session.documentBudget?.chapterTargets,
      chapters: merged.chapters,
      documentTargetChars: session.documentBudget?.targetChars,
    });
    // 未定位素材落在文末（不属任何章）：计入文档级分子，保证文档级额度同样不被重复授予
    const chapterBudget: ChapterBudgetLedger = merged.unlocatedChars > 0
      ? { ...baseLedger, document: { ...baseLedger.document, current: baseLedger.document.current + merged.unlocatedChars, remaining: baseLedger.document.remaining - merged.unlocatedChars } }
      : baseLedger;
    const tailClosure = await applyRequirementTailClosure({
      markdown: session.finalMarkdown,
      tenderRequirements: session.tenderRequirements,
      requirementAssignments: session.requirementAssignments,
      signal: session.signal,
      diagnostics: session.generationDiagnostics,
      attemptedSignatures,
      chapterBudget,
    });
    totalRejected += tailClosure.rejectedCount;
    totalBudgetSkipped += tailClosure.budgetSkippedCount;
    tailDetails.push(...tailClosure.details);
    if (tailClosure.insertedCount === 0) {
      // C8 S1：零插入即断链前取当前终检残留数（拒插记录需正确的 stage 状态与残留注记）
      residualCount = requirementResponseBlockers(session).length;
      break;
    }
    session.finalMarkdown = tailClosure.markdown;
    await session.recomputeFinalValidationBundle();
    totalInserted += tailClosure.insertedCount;
    landedInsertions.push(...tailClosure.insertions);
    residualCount = requirementResponseBlockers(session).length;
    if (residualCount === 0) break;
  }
  if (totalInserted > 0 || totalRejected > 0 || totalBudgetSkipped > 0) {
    const gateNote = totalRejected > 0 ? `，${totalRejected} 条素材未过质量闸（拒插，显性记录）` : '';
    // 4.56 2-b ③：额度不足未插条数上屏——「不插必报」，绝不以静默不插冒充「已收口」
    const budgetNote = totalBudgetSkipped > 0 ? `，${totalBudgetSkipped} 条因章预算额度不足未插入（显性记录，残留由终门禁照常复核）` : '';
    const tailClosureStage = displayStage({ type: 'validation', roleId: 'requirement-tail-closure', status: residualCount === 0 ? 'success' : 'failed', message: `招标要求响应链尾终局收口：${totalInserted} 条残留要求以投标人口吻确定性补写落位${gateNote}${budgetNote}${residualCount > 0 ? `（残留 ${residualCount} 条由终门禁照常复核）` : ''}`, details: tailDetails }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, tailClosureStage);
    upsertProgressStage(session.finalGateRepairStages, tailClosureStage);
  }
}

/** 章末段落插入（章定位：H2 标题归一化匹配，与修复轮章定位同源；未定位回退文末） */
function insertParagraphsAtChapterEnd(markdown: string, chapterTitle: string, paragraphs: string[]): string {
  const lines = markdown.split('\n');
  const target = chapterTitle ? normalizeChapterTitleLine(chapterTitle) : '';
  let headingIndex = -1;
  if (target) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!/^##\s/u.test(line)) continue;
      const normalized = normalizeChapterTitleLine(line);
      if (normalized === target || normalized.includes(target) || target.includes(normalized)) {
        headingIndex = index;
        break;
      }
    }
  }
  if (headingIndex < 0) {
    return `${markdown.replace(/\s+$/u, '')}\n\n${paragraphs.join('\n\n')}\n`;
  }
  let chapterEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s/u.test(lines[index].trim())) {
      chapterEnd = index;
      break;
    }
  }
  let insertAt = chapterEnd;
  while (insertAt > headingIndex + 1 && !lines[insertAt - 1].trim()) insertAt -= 1;
  const next = [...lines];
  next.splice(insertAt, 0, ...paragraphs.flatMap(paragraph => ['', paragraph]));
  return next.join('\n');
}
