/**
 * repairRounds/lengthCompressionRepair：成稿篇幅压缩轮（LLM_PATCH_REPAIR_ROUNDS: length-compression-repair）。
 * D-T3 ①（B8 后半根治）：r28f 实测成稿 61706 字 vs 目标 50000 字（+23%）——document-budget 的
 * minimum 模式 >120%「明显超出」warning 此前无修复轮消费，超产直坠交付（验收线「目标 ±20% 内」）。
 * 修复链路：
 * - 触发单源 documentLengthOverflow（超出目标 20% 才触发；15%~25% 自然波动不压缩，aim 取目标 110%）；
 * - 章级超额定位（chapterTargets 单源，正超额降序，每轮最多 6 章，单章超额 ≥200 字才值得定向修复）；
 * - 收敛修复（全文最多 2 轮；每轮落地后重建 + 重算校验组，超标消除即提前收敛）；
 * - 信息守恒守卫（零删信息）：汉字数须下降，且修复后标题多重集不得缺失、数值 token 不得缺失、
 *   表格行数不得减少——任一违反即回滚（withPatchRollback）；
 * - 仍超标时由终检 document-budget 照常复核（warning 不阻断导出，宁缺不假）。
 * 产品级通用：判据仅凭字数预算与文本结构，无项目/章名硬编码。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { documentLengthOverflow, documentTextLength } from '../../budget';
import type { FinalizeSession } from '../finalizeSession';

/** 全文压缩收敛轮上限（每轮落地后重判超标；超标消除即提前收敛） */
const MAX_LENGTH_COMPRESSION_ROUNDS = 2;
/** 每轮定向修复的章数上限（超额降序取前列；控制单阶段 LLM 调用预算） */
const MAX_CHAPTERS_PER_ROUND = 6;
/** 单章超额低于此值不发起压缩（噪声抖动不值得 LLM 调用，且压缩空间不足） */
const MIN_CHAPTER_COMPRESSION_CHARS = 200;

/** 标题计数（H1-H6 归一文本多重集）：压缩禁止丢标题——缺失数 >0 即回滚 */
function headingCounts(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of content.matchAll(/^#{1,6}\s+(.+)$/gmu)) {
    const title = (match[1] || '').replace(/\s+/gu, '');
    if (title) counts.set(title, (counts.get(title) || 0) + 1);
  }
  return counts;
}

/** 数值 token 集合（数字串含小数）：压缩禁止删数值——缺失数 >0 即回滚 */
function numericTokenSet(content: string): Set<string> {
  return new Set([...content.matchAll(/\d+(?:\.\d+)?/gu)].map(match => match[0]));
}

/** 表格行数（Markdown 表格行）：压缩禁止删表——行数减少即回滚 */
function tableRowCount(content: string): number {
  return content.split('\n').filter(line => /^\s*\|/u.test(line)).length;
}

/** 信息守恒指标（基线 = 修复前内容）：[汉字数, 标题多重集缺失数, 数值 token 缺失数, 表格行数] */
function conservationMetrics(content: string, baseline: { headings: Map<string, number>; numbers: Set<string> }): [number, number, number, number] {
  const headings = headingCounts(content);
  let missingHeadings = 0;
  for (const [title, count] of baseline.headings) missingHeadings += Math.max(0, count - (headings.get(title) || 0));
  const numbers = numericTokenSet(content);
  let missingNumbers = 0;
  for (const token of baseline.numbers) if (!numbers.has(token)) missingNumbers += 1;
  return [documentTextLength(content), missingHeadings, missingNumbers, tableRowCount(content)];
}

/** 章级超额定位（chapterTargets 单源，正超额降序取前 N）：单章超额 <200 字不入选 */
function overflowChapterTargets(session: FinalizeSession): Array<{ chapterId: string; chapterTitle: string; currentChars: number; targetChars: number }> {
  const targets: Array<{ chapterId: string; chapterTitle: string; currentChars: number; targetChars: number }> = [];
  for (const chapter of session.finalChapterDrafts) {
    const targetChars = session.documentBudget.chapterTargets.get(chapter.id) || 0;
    if (targetChars <= 0) continue;
    const currentChars = documentTextLength(chapter.content);
    if (currentChars - targetChars < MIN_CHAPTER_COMPRESSION_CHARS) continue;
    targets.push({ chapterId: chapter.id, chapterTitle: chapter.title, currentChars, targetChars });
  }
  return targets
    .sort((left, right) => (right.currentChars - right.targetChars) - (left.currentChars - left.targetChars))
    .slice(0, MAX_CHAPTERS_PER_ROUND);
}

export async function stageLengthCompressionRepair(session: FinalizeSession): Promise<void> {
  // 触发判定与终检 document-budget 同口径（finalMarkdown 读源）：未超标即 pass（零 LLM 零改动）
  const initialOverflow = documentLengthOverflow(session.documentBudget, session.finalMarkdown);
  if (!initialOverflow) {
    const passStage = displayStage({ type: 'validation', roleId: 'length-compression-repair', status: 'success', message: '成稿篇幅核对通过：字数在目标 +20% 容差内' }, { subtitle: '篇幅压缩' });
    upsertProgressStage(session.progressStages, passStage);
    upsertProgressStage(session.finalGateRepairStages, passStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    return;
  }
  let repairedChapters = 0;
  // 全文长度轨迹（超标初值 + 每轮落地后重判）：阶段消息与诊断展示收敛过程
  const trajectory: number[] = [initialOverflow.currentChars];
  for (let round = 1; round <= MAX_LENGTH_COMPRESSION_ROUNDS; round += 1) {
    const overflow = documentLengthOverflow(session.documentBudget, session.finalMarkdown);
    if (!overflow) break;
    const targets = overflowChapterTargets(session);
    if (targets.length === 0) break;
    let appliedThisRound = 0;
    for (const target of targets) {
      const chapterIndex = session.finalChapterDrafts.findIndex(chapter => chapter.id === target.chapterId);
      if (chapterIndex < 0) continue;
      const draftChapter = session.finalChapterDrafts[chapterIndex];
      const chapterContent = draftChapter.content;
      const baseline = { headings: headingCounts(chapterContent), numbers: numericTokenSet(chapterContent) };
      const beforeMetrics = conservationMetrics(chapterContent, baseline);
      const aimChars = Math.ceil(target.targetChars * 1.1);
      const runningStage = displayStage({ type: 'llm_review', roleId: `agent-length-compression-${target.chapterId}`, status: 'running', message: `成稿篇幅超出目标（当前全文 ${overflow.currentChars} 字 / 目标约 ${overflow.targetChars} 字），第 ${round} 轮压缩修复中：${draftChapter.title}（当前约 ${beforeMetrics[0]} 字 → 上限约 ${aimChars} 字）` }, { subtitle: '篇幅压缩' });
      upsertProgressStage(session.progressStages, runningStage);
      upsertProgressStage(session.finalGateRepairStages, runningStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      const instruction = [
        `【成稿篇幅压缩修复】本章正文超出篇幅目标（当前约 ${beforeMetrics[0]} 字，章目标约 ${target.targetChars} 字，压缩上限约 ${aimChars} 字），请在不损失任何信息的前提下压缩：`,
        (round > 1 ? `本轮为第 ${round} 轮（最多 ${MAX_LENGTH_COMPRESSION_ROUNDS} 轮）：上一轮压缩后全文仍超出目标，必须进一步合并重复表述。` : ''),
        '1. 合并重复段落与同义重复表述：同一事项在多处重复展开的合并为一处（保留信息最全的表述并自然衔接）；',
        '2. 严禁删除独有信息：标题、数值、单位、表格、法规/规范编号及任何仅出现一次的实体信息必须保留——允许删除的只有与保留处重复的表述；',
        `3. 压缩后本章字数应不超过约 ${aimChars} 字（当前约 ${beforeMetrics[0]} 字）；`,
        '4. 保持事实与口径不变（构件名、材料名、计量数值、工期节点保持原文）。',
        '以局部 patch 方式输出：每个 patch 只包含被合并/改写段落的替换文本与必要定位上下文。',
      ].filter(Boolean).join('\n');
      // 信息守恒守卫（零删信息）：字数须降、标题/数值不得缺失、表格行数不得减少——任一违反即回滚
      const outcome = await withPatchRollback({
        originalContent: chapterContent,
        repairRound: 'length-compression-repair',
        diagnostics: session.generationDiagnostics,
        beforeMetrics,
        shouldRollback: (before, after) => after[0] >= before[0] || after[1] > 0 || after[2] > 0 || after[3] < before[3],
        apply: async () => {
          const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
            template: session.template,
            chapter: { id: draftChapter.id, title: draftChapter.title, content: chapterContent, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
            issues: [`${draftChapter.title} 篇幅超出目标：当前约 ${beforeMetrics[0]} 字，章目标约 ${target.targetChars} 字`],
            promptTexts: instruction,
            requirement: session.requirement,
            forbidDrawingImages: false,
            // 标书编制规格（暗标禁表）：修复链 system 口径同步
            bidComposition: session.bidComposition,
            diagnostics: session.generationDiagnostics,
            signal: session.signal,
            patchGuard: repairPatchGuard('length-compression-repair', session.generationDiagnostics),
          }));
          return repaired.content && repaired.content !== chapterContent ? repaired.content : chapterContent;
        },
        recheck: (content) => conservationMetrics(content, baseline),
      });
      const afterMetrics = conservationMetrics(outcome.content, baseline);
      const compressed = !outcome.rolledBack && outcome.content !== chapterContent;
      if (compressed) {
        session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: outcome.content };
        repairedChapters += 1;
        appliedThisRound += 1;
      }
      const completedStage = displayStage({
        type: 'llm_review',
        roleId: `agent-length-compression-${target.chapterId}`,
        status: compressed ? 'success' : 'failed',
        message: compressed
          ? `篇幅压缩修复完成：${draftChapter.title}（${beforeMetrics[0]} → ${afterMetrics[0]} 字）`
          : outcome.rolledBack
            ? `篇幅压缩修复已回滚：${draftChapter.title}（压缩后字数未下降或信息守恒校验未通过，保留修复前正文）`
            : `篇幅压缩修复未生效：${draftChapter.title}（模型未产生有效修改；残留由终检照常复核）`,
        details: compressed ? undefined : [`修复前约 ${beforeMetrics[0]} 字 / 章目标约 ${target.targetChars} 字`],
      }, { subtitle: '篇幅压缩' });
      upsertProgressStage(session.progressStages, completedStage);
      upsertProgressStage(session.finalGateRepairStages, completedStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
    }
    if (appliedThisRound === 0) break;
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
    trajectory.push(documentTextLength(session.finalMarkdown));
  }
  const finalOverflow = documentLengthOverflow(session.documentBudget, session.finalMarkdown);
  session.generationDiagnostics.llm.lastInfo = finalOverflow
    ? `篇幅压缩修复：全文超幅 ${Math.round(initialOverflow.excessRatio * 100)}%，${repairedChapters} 章完成压缩，残留超幅 ${Math.round(finalOverflow.excessRatio * 100)}%（全文长度轨迹 ${trajectory.join('→')}；残留由终检照常复核）`
    : `篇幅压缩修复：全文超幅 ${Math.round(initialOverflow.excessRatio * 100)}%，${repairedChapters} 章完成压缩后回到目标容差内（全文长度轨迹 ${trajectory.join('→')}）`;
}
