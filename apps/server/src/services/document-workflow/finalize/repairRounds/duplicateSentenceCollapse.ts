/**
 * repairRounds/duplicateSentenceCollapse：句级复读坍塌链尾收口轮（FINALIZE_REPAIR_ROUNDS: duplicate-sentence-collapse）。
 * C8 S5（U 通道：uniqueness 0.59 第一约束归因）——s28m' 离线复算 53 = 100 − 12（空话）− 35
 * （重复句超预算）：excess 主体为「上述/相关/有关＋泛对象词」泛化归口句复读（20 种 37 处；全篇
 * 复读 39 种仅 1 种命中句模族表——句模链路覆盖不到=修复死角）与同章完全复读（17 处）。本轮为
 * 链尾 markdown-only 零 LLM 收口：完全重复句（比较键 = 去标点归一化同句，≥12 字）保首次删后续
 * ——同章复读一律坍塌、跨章复读仅首现句命中泛化归口帧（GENERALIZED_CLOSURE_SENTENCE_RE）者
 * 坍塌，跨章业务句（合理重申，如标段划分/极端气温停作业）保留。出现枚举与 uniqueness 评分同源
 * 消费 duplicateSentenceOccurrences（检测定位=修复定位）；dry-run 校准：s28m' 删 54 处 53→88
 *（因子 0.978）、r28m' 删 11 处 98→100（跨章业务 2/1 句保留、零误伤）。位于
 * sentence-pattern-sweep 之后、replaySurfacePunctuationClosure（链尾标点兜底）之前——终门禁
 * 所检 = 交付所存 = 收口后成稿；幂等可重放（无目标时零变更、零成本）。
 */
import { GENERALIZED_CLOSURE_SENTENCE_RE } from '../../templatingGovernance';
import { displayStage, upsertProgressStage } from '../../progress';
import { duplicateSentenceOccurrences } from '../../tenderBidScoring';
import type { FinalizeSession } from '../finalizeSession';

/** 句级复读坍塌产出（removedCount=0 时 markdown 原样返回——幂等零变更） */
export interface DuplicateSentenceCollapseOutcome {
  markdown: string;
  removedCount: number;
  removedSentences: string[];
  /** 跨章业务句复读保留明细（合理重申不坍塌，如标段划分/高温停作业——审计透明） */
  keptSentences: string[];
  /** 删除构成：同章复读处数 */
  sameChapterRemoved: number;
  /** 删除构成：跨章泛化归口复读处数 */
  generalizedRemoved: number;
}

export function collapseDuplicateSentences(markdown: string): DuplicateSentenceCollapseOutcome {
  const lines = markdown.split('\n');
  // 章归属（`## ` 为章界；文首内容归属伪章「(文首)」——同章/跨章判定用）
  const chapterOf: string[] = [];
  let chapterKey = '(文首)';
  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.trim();
    if (/^##\s+/u.test(line)) chapterKey = line;
    chapterOf[lineIndex] = chapterKey;
  });
  const removedSentences: string[] = [];
  const keptSentences: string[] = [];
  const deleteByLine = new Map<number, Array<{ start: number; end: number }>>();
  let sameChapterRemoved = 0;
  let generalizedRemoved = 0;
  for (const group of duplicateSentenceOccurrences(markdown)) {
    const occurrences = group.occurrences;
    if (occurrences.length < 2) continue;
    const sameChapter = new Set(occurrences.map(item => chapterOf[item.lineIndex])).size === 1;
    const generalized = GENERALIZED_CLOSURE_SENTENCE_RE.test(occurrences[0].raw);
    if (!sameChapter && !generalized) {
      keptSentences.push(occurrences[0].raw);
      continue;
    }
    for (const occurrence of occurrences.slice(1)) {
      const ranges = deleteByLine.get(occurrence.lineIndex) || [];
      ranges.push({ start: occurrence.start, end: occurrence.end });
      deleteByLine.set(occurrence.lineIndex, ranges);
      removedSentences.push(occurrence.raw);
      if (sameChapter) sameChapterRemoved += 1;
      else generalizedRemoved += 1;
    }
  }
  if (removedSentences.length === 0) {
    return { markdown, removedCount: 0, removedSentences, keptSentences, sameChapterRemoved, generalizedRemoved };
  }
  for (const [lineIndex, ranges] of deleteByLine) {
    let line = lines[lineIndex];
    // 行内从后往前删除（吞句前导空白与句末分隔符；后删不影响前段索引）
    for (const range of ranges.sort((left, right) => right.start - left.start)) {
      let start = range.start;
      while (start > 0 && /\s/u.test(line[start - 1])) start -= 1;
      let end = range.end;
      while (end < line.length && /\s/u.test(line[end])) end += 1;
      if (/[。；;]/u.test(line[end] || '')) end += 1;
      line = line.slice(0, start) + line.slice(end);
    }
    lines[lineIndex] = line.trim() === '' ? '' : line.replace(/^[ \t]+/u, '').replace(/[ \t]+$/u, '');
  }
  // 连续空行合并（三连以上压为两连）
  return {
    markdown: lines.join('\n').replace(/\n{4,}/gu, '\n\n\n'),
    removedCount: removedSentences.length,
    removedSentences,
    keptSentences,
    sameChapterRemoved,
    generalizedRemoved,
  };
}

export async function stageDuplicateSentenceCollapse(session: FinalizeSession): Promise<void> {
  const result = collapseDuplicateSentences(session.finalMarkdown);
  const details = result.removedSentences.slice(0, 3).map(sentence => `复读坍塌：「${sentence.slice(0, 40)}」`);
  if (result.keptSentences.length > 0) details.push(`跨章业务复读保留 ${result.keptSentences.length} 种（合理重申不坍塌）`);
  const stage = displayStage({
    type: 'validation',
    roleId: 'duplicate-sentence-collapse',
    status: 'success',
    message: result.removedCount > 0
      ? `句级复读坍塌：完全重复句保首次删后续 ${result.removedCount} 处（同章复读 ${result.sameChapterRemoved} 处、跨章泛化归口复读 ${result.generalizedRemoved} 处）`
      : '句级复读核对通过：无完全重复句残留',
    details: details.length > 0 ? details : undefined,
  }, { subtitle: '模板化清理收口' });
  upsertProgressStage(session.progressStages, stage);
  upsertProgressStage(session.finalGateRepairStages, stage);
  if (result.removedCount > 0) {
    session.finalMarkdown = result.markdown;
    await session.recomputeFinalValidationBundle();
  }
  session.emitProgress(session.finalChapterDrafts, session.progressStages);
}
