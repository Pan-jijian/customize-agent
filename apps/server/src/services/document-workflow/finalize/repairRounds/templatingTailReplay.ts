/**
 * repairRounds/templatingTailReplay：模板化清理链尾重放轮（markdown 版，FINALIZE_REPAIR_ROUNDS: templating-tail-replay）。
 * C8 S6（A' 对象错位通道归因）——templating-sweep 扫 session.finalChapterDrafts，而 tail closure 的
 * markdown-only 插入物（补写段落/替换文本）只写 session.finalMarkdown 不回写章 drafts：s28m' 实测
 * 插入物 6 探针 drafts 全 false / markdown 全 true——stage「无重复段落残留」通过为 drafts 视角假通过；
 * 且链尾各 markdown-only 轮（删句/断句/标点收口）亦可能新生重复段，而此后再无 drafts 消费点。
 * 本轮为链尾 markdown 版重放：对 session.finalMarkdown 按 `## ` 行级切章构造伪 chapters（头区不参与），
 * 复用与 templating-sweep 完全相同的三函数——① templatePrefixTargets → stripZeroInfoSloganSentences
 * （零信息前缀句确定性删除；目录条目行/标题行由 isFillerPoolExcludedLine 单源排除，不针对标题字面量硬编码）
 * ② 逐章 stripDuplicateParagraphs（章内段落完全重复去重；≥40 字指纹、标题/表格/列表行不入池）。
 * 任一落地：写回 finalMarkdown + 重算校验组（markdown-only，无需 rebuildFinalMarkdown——不走 drafts）。
 * 位于 duplicate-sentence-collapse 之后、replaySurfacePunctuationClosure（链尾标点兜底）之前——
 * 终门禁所检 = 交付所存 = 收口后成稿；幂等可重放（无目标时零变更、零成本）。
 * 校准（C8 S6 探针）：s28m'/r28m' 终稿重放零删除（无残留、零误伤）；合成样本触发能力验证
 * 前缀句 2/2 可删句删除（含数字岗位句被零信息硬闸拒删）+ 章内重复段 1/1 删除（跨章复用段章内作用域保留）。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { stripDuplicateParagraphs } from '../../documentIntegrityChecks';
import { stripZeroInfoSloganSentences, templatePrefixTargets } from '../../constructionOrgAudit';
import type { FinalizeSession } from '../finalizeSession';
import type { DocumentDraftChapter } from '../../types';

/** 链尾模板化重放产出（无删除时 markdown 原样返回——幂等零变更） */
export interface TemplatingTailReplayOutcome {
  markdown: string;
  /** 零信息前缀句删除处数 */
  prefixRemoved: number;
  prefixSentences: string[];
  /** 章内重复段落删除处数 */
  paragraphRemoved: number;
  /** 前缀句修复锚点提取数（含被零信息硬闸拒删者——审计透明） */
  targetCount: number;
}

export function replayTemplatingOnMarkdown(markdown: string): TemplatingTailReplayOutcome {
  // `## ` 行级章区间切分（头区——首个章界前内容——不参与：非章正文）
  const lines = markdown.split('\n');
  const ranges: Array<{ startLine: number; endLine: number; title: string }> = [];
  let current: { startLine: number; endLine: number; title: string } | undefined;
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (/^##\s+/u.test(line)) {
      if (current) { current.endLine = index; ranges.push(current); }
      current = { startLine: index, endLine: lines.length, title: line.replace(/^#+\s*/u, '') };
    }
  });
  if (current) ranges.push(current);
  if (ranges.length === 0) {
    return { markdown, prefixRemoved: 0, prefixSentences: [], paragraphRemoved: 0, targetCount: 0 };
  }
  // 伪 chapters：id/evidence/missingFacts 为消费函数必填结构，与 templating-sweep 的 drafts 同形
  const pseudo: DocumentDraftChapter[] = ranges.map((range, index) => ({
    id: `md-chapter-${index}`,
    title: range.title,
    content: lines.slice(range.startLine, range.endLine).join('\n'),
    evidence: [],
    missingFacts: [],
  }));
  // ① 零信息前缀句确定性删除（幂等：无目标/已删净时零成本静默）
  const targets = templatePrefixTargets(pseudo);
  const stripped = targets.length > 0
    ? stripZeroInfoSloganSentences(pseudo, targets)
    : { deletedCount: 0, deletedSentences: [] as string[], remaining: targets };
  // ② 逐章段落完全重复去重（章内作用域——seen 随函数调用新建；跨章重复段由终检报告兜底，同 templating-sweep）
  let paragraphRemoved = 0;
  for (const chapter of pseudo) {
    if (!chapter.content?.trim()) continue;
    const deduped = stripDuplicateParagraphs(chapter.content);
    if (deduped.removedCount > 0) {
      chapter.content = deduped.markdown;
      paragraphRemoved += deduped.removedCount;
    }
  }
  if (stripped.deletedCount === 0 && paragraphRemoved === 0) {
    return { markdown, prefixRemoved: 0, prefixSentences: [], paragraphRemoved: 0, targetCount: targets.length };
  }
  // 区间替换拼回（从后往前 splice 防索引偏移）
  const out = [...lines];
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index];
    out.splice(range.startLine, range.endLine - range.startLine, ...pseudo[index].content.split('\n'));
  }
  return {
    markdown: out.join('\n'),
    prefixRemoved: stripped.deletedCount,
    prefixSentences: stripped.deletedSentences,
    paragraphRemoved,
    targetCount: targets.length,
  };
}

export async function stageTemplatingTailReplay(session: FinalizeSession): Promise<void> {
  const result = replayTemplatingOnMarkdown(session.finalMarkdown);
  const total = result.prefixRemoved + result.paragraphRemoved;
  const stage = displayStage({
    type: 'validation',
    roleId: 'templating-tail-replay',
    status: 'success',
    message: total > 0
      ? `模板化链尾重放（markdown）：零信息前缀句删除 ${result.prefixRemoved} 处、重复段落去重 ${result.paragraphRemoved} 处`
      : '模板化链尾重放核对通过：无零信息前缀句与重复段落残留',
    details: result.prefixSentences.length > 0
      ? result.prefixSentences.slice(0, 3).map(sentence => `前缀句删除：「${sentence.slice(0, 40)}」`)
      : undefined,
  }, { subtitle: '模板化清理收口' });
  upsertProgressStage(session.progressStages, stage);
  upsertProgressStage(session.finalGateRepairStages, stage);
  if (total > 0) {
    session.finalMarkdown = result.markdown;
    await session.recomputeFinalValidationBundle();
  }
  session.emitProgress(session.finalChapterDrafts, session.progressStages);
}
