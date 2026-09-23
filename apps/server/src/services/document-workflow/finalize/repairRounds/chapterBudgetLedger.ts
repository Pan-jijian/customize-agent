/**
 * repairRounds/chapterBudgetLedger：补写轮的「章预算账」单源（4.56 改造 2-b）。
 *
 * ── 根因（4.56 R2 / 真实生成 doc-1790144107028-aaba7ba3 实测）──
 * 写作完成时三章 26,674 / 7,652 / 5,168 = 39,494 字，**全部低于章预算**
 * （30,600 / 11,856 / 7,544 = 50,000）；交付终稿各章 +57% / +83% / +87% ——
 * 超产 100% 发生在写作之后的修复链，且不是重复内容（完全重复段落 0，799 句中近重复仅 7 句）：
 * 靠「事后压缩」压不回来。
 * 机制原因：修复轮各自只解决「自己那一类缺陷」，**不知道章预算、不知道别的轮已经写了什么**，
 * 一律追加——`contentDepthRepair` / `requirementResponseRepair` / `controlLoopRepair` /
 * `professionalChainRepair` / `requirement-tail-closure`（一次确定性批插，原先无任何总量上限）。
 *
 * ── 本模块提供三件事（**只做观测与指令约束，不强制截断**）──
 * 1. `buildChapterBudgetLedger`：以 `documentBudget.chapterTargets`（章预算唯一权威来源，
 *    与写作侧 `resolveChapterBudgetTarget` 同源）为分母、`finalChapterDrafts` 实时正文字数为
 *    分子，算出每章 `{ target, current, remaining }` 与文档级同三值；
 * 2. `renderChapterBudgetInstruction`：把「本章预算 X 字、当前 Y 字、剩余额度 Z 字；
 *    超出即须替换/合并，不得追加」渲染进补写轮指令（与既有 `instructionFor` 渲染同风格）；
 * 3. `chapterOverflowAfterRound` / `renderChapterOverflowNote` / `recordChapterBudgetMetric`：
 *    落地后的章级超额观测（本轮新增多少字 + 超出多少），写入该轮阶段 message/details 与
 *    `generationDiagnostics`（结构化持久化，复盘可见）。
 *
 * 强制截断（写入时拒绝超额）需要改造 2-a 的单一写入通道 `applyDocumentEdit(scope, edit)`，
 * 属后续批次；本模块只让补写轮「知道额度」，不改判缺陷是否值得修。
 *
 * ── 硬约束（不得违反）──
 * **该补的还要补**。预算账的作用是让补写轮知道额度并按额度替换/合并，**不是**让它们不补：
 * 真实缺陷的优先级高于篇幅。故 `renderChapterBudgetInstruction` 恒与「真实缺陷不得因额度放弃
 * 补写」的强制语同现——额度不足时的正确动作是「替换/合并/压缩低信息量表述后落位」，
 * 而不是「不补」。
 */
import { documentTextLength, resolveChapterBudgetTarget } from '../../budget';
import type { DocumentGenerationDiagnostics } from '../../types';

/** 章级预算账条目：target=章预算（权威来源），current=当前正文字数，remaining=target-current（可为负） */
export interface ChapterBudgetEntry {
  chapterId: string;
  title: string;
  /** 章预算（documentBudget.chapterTargets 单源；未覆盖时按 resolveChapterBudgetTarget 显式兜底） */
  target: number;
  /** 章当前字数（documentTextLength 口径，与写作侧/超产审计/阶段详情同源） */
  current: number;
  /** 剩余额度 = target - current（负数=已超额） */
  remaining: number;
  /** 预算表未覆盖本章时的显式兜底说明（由调用方上屏，使预算缺口可见而非静默） */
  fallbackNote?: string;
}

/** 文档级预算账（口径与章级同源：Σ章 current 为缺省分母，调用方可传入成稿 markdown 实测值） */
export interface DocumentBudgetSnapshot {
  target: number;
  current: number;
  remaining: number;
}

export interface ChapterBudgetLedger {
  chapters: ChapterBudgetEntry[];
  document: DocumentBudgetSnapshot;
  /** 超额章（current > target），按超额降序——定向收敛顺序（先回收超额最大的章） */
  overBudget: ChapterBudgetEntry[];
}

/** 章预算账构建入参：预算侧取 session.documentBudget，正文侧取 session.finalChapterDrafts */
export interface ChapterBudgetLedgerInput {
  /** documentBudget.chapterTargets（缺省=空表，逐章走 resolveChapterBudgetTarget 显式兜底） */
  chapterTargets?: Map<string, number>;
  /** 章列表（id/title/content 齐全即可；content 为当前正文） */
  chapters: Array<{ id: string; title: string; content: string }>;
  /** documentBudget.targetChars（文档级分母的首选；缺省用 Σ章预算） */
  documentTargetChars?: number;
  /** 文档级分子覆盖：调用方以成稿 markdown 计量时传入（缺省用 Σ章当前字数） */
  documentCurrentChars?: number;
}

/**
 * 构建章预算账（纯函数，零 LLM / 零 IO）。
 *
 * 分母口径**不做隐式兜底**：章预算缺失时交由 `resolveChapterBudgetTarget` 显式折算并回传
 * `fallbackNote`（历史缺陷：`chapterTargets.get(id) || 1200` 把「缺失输入」变成「自信的错误
 * 分母」）。分子与写作侧/超产审计同用 `documentTextLength`（去 HTML 标签 + 去空白）。
 */
export function buildChapterBudgetLedger(input: ChapterBudgetLedgerInput): ChapterBudgetLedger {
  const chapterTargets = input.chapterTargets ?? new Map<string, number>();
  const chapterCount = input.chapters.length;
  const chapters: ChapterBudgetEntry[] = input.chapters.map(chapter => {
    const { budgetTarget, fallbackNote } = resolveChapterBudgetTarget({
      chapterTargets,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      documentTargetChars: input.documentTargetChars,
      chapterCount,
    });
    const current = documentTextLength(chapter.content || '');
    return {
      chapterId: chapter.id,
      title: chapter.title,
      target: budgetTarget,
      current,
      remaining: budgetTarget - current,
      ...(fallbackNote ? { fallbackNote } : {}),
    };
  });
  const chapterSum = chapters.reduce((sum, chapter) => sum + chapter.current, 0);
  const targetSum = chapters.reduce((sum, chapter) => sum + chapter.target, 0);
  const explicitDocumentTarget = Number(input.documentTargetChars);
  const target = Number.isFinite(explicitDocumentTarget) && explicitDocumentTarget > 0 ? Math.round(explicitDocumentTarget) : targetSum;
  const current = input.documentCurrentChars !== undefined ? input.documentCurrentChars : chapterSum;
  return {
    chapters,
    document: { target, current, remaining: target - current },
    overBudget: chapters.filter(chapter => chapter.remaining < 0).sort((a, b) => a.remaining - b.remaining),
  };
}

/** 章预算账在指定章上的条目（章 id 直连；未命中返回 undefined——调用方须显式跳过而非静默按 0 计） */
export function chapterBudgetEntry(ledger: ChapterBudgetLedger, chapterId: string): ChapterBudgetEntry | undefined {
  return ledger.chapters.find(chapter => chapter.chapterId === chapterId);
}

/** 章预算账在指定章标题上的条目（链尾收口以**章标题**定位插入目标，故其预算查表也以标题为键） */
export function chapterBudgetEntryByTitle(ledger: ChapterBudgetLedger, chapterTitle: string): ChapterBudgetEntry | undefined {
  const title = String(chapterTitle || '').trim();
  if (!title) return undefined;
  return ledger.chapters.find(chapter => chapter.title === title);
}

/**
 * 渲染补写轮指令的章预算段（与既有 `instructionFor` 同风格：`【…】` 段头 + 编号/祈使约束行）。
 *
 * 措辞契约（4.56 2-b 判据，测试按此断言）：
 * - 必含「本章预算 X 字、当前 Y 字、剩余额度 Z 字」；
 * - 必含「超出即须替换/合并，不得追加」；
 * - 超额章追加「已超出章预算 N 字」并给出可执行的落位方式（替换/合并/先压缩再并入）；
 * - 恒含「真实缺陷不得因额度放弃补写」——防止本段被读成「不补的许可」（硬约束）。
 */
export function renderChapterBudgetInstruction(entry: ChapterBudgetEntry): string {
  const over = entry.current - entry.target;
  return [
    `【章预算账】本章预算 ${entry.target} 字、当前 ${entry.current} 字、剩余额度 ${entry.remaining} 字${over > 0 ? `（已超出章预算 ${over} 字）` : ''}。`,
    '超出即须替换/合并，不得追加：本轮补写须在剩余额度内落位——优先改写既有同类段落使其更实，或与既有段落合并去重，不得整段净新增；额度已用尽时先替换/压缩低信息量表述腾出空间，再落位新增内容。',
    '真实缺陷一律不得因额度放弃补写：额度不足时以「替换/合并」落位，而不是不补；缺陷优先级高于篇幅。',
  ].join('\n');
}

/** 链尾收口已落位素材（`RequirementTailClosureResult.insertions` 的元素形态；章标题为空串=回退文末） */
export interface LandedInsertion {
  chapterTitle: string;
  material: string;
}

/**
 * 把「已落位的收口素材」回灌到章正文快照（跨轮重算额度的必要一步）。
 *
 * 为什么必须回灌：链尾收口是 markdown-only 插入（**不写章草稿**）。若每轮都从章草稿重建账本，
 * 同一章额度会被每轮重复授予（收口轮数 × 额度）——账本就不再是权威分母。
 *
 * 口径（不静默丢失字数）：
 * - 章标题命中：并入该章正文（分子 = 真实交付长度）；
 * - 未定位（空标题=文末回退）**或标题未命中任何章**：计入 `unlocatedChars` 挂文档级额度
 *   ——插入物确实在成稿里，只是不属任何章，绝不计 0。
 */
export function mergeLandedInserts<T extends { title: string; content: string }>(
  chapters: T[],
  insertions: LandedInsertion[],
): { chapters: T[]; unlocatedChars: number } {
  if (insertions.length === 0) return { chapters, unlocatedChars: 0 };
  const byTitle = new Map<string, string[]>();
  let unlocatedChars = 0;
  for (const insertion of insertions) {
    const title = String(insertion.chapterTitle || '').trim();
    if (!title || !chapters.some(chapter => chapter.title === title)) {
      unlocatedChars += documentTextLength(insertion.material || '');
      continue;
    }
    const list = byTitle.get(title) ?? [];
    list.push(insertion.material);
    byTitle.set(title, list);
  }
  if (byTitle.size === 0) return { chapters, unlocatedChars };
  return {
    chapters: chapters.map(chapter => (byTitle.has(chapter.title) ? { ...chapter, content: `${chapter.content}\n${byTitle.get(chapter.title)!.join('\n')}` } : chapter)),
    unlocatedChars,
  };
}

/** 文档级预算摘要行（补写轮的 lastInfo/阶段 details 用；让「本轮相对全文额度」也可复盘） */
export function renderDocumentBudgetSummary(ledger: ChapterBudgetLedger): string {
  const { target, current, remaining } = ledger.document;
  const note = ledger.overBudget.length > 0
    ? `；超额章 ${ledger.overBudget.length} 个（最大超额 ${Math.abs(ledger.overBudget[0].remaining)} 字：${ledger.overBudget[0].title.slice(0, 24)}）`
    : '';
  return `【章预算账·全文】预算 ${target} 字、当前 ${current} 字、剩余额度 ${remaining} 字${note}`;
}

/** 章级超额观测记录（单轮单章）：added=本轮净增字数，over=落地后超出章预算的字数 */
export interface ChapterOverflowReport {
  chapterId: string;
  title: string;
  /** 章预算（分母，来自预算账） */
  target: number;
  /** 本轮修复前字数 */
  before: number;
  /** 本轮修复后字数 */
  after: number;
  /** 本轮净增字数（after - before，可为负=本轮净减） */
  added: number;
  /** 落地后超出章预算的字数（> 0） */
  over: number;
}

/**
 * 落地后的章级超额检查（4.56 2-b 观测项）：仅当**修复后**仍超章预算时返回记录。
 *
 * 返回 undefined 的两种情形（都不该污染阶段 message）：
 * ① 修复后未超预算；② 本轮无落地（调用方在内容未变时就不该调用）。
 */
export function chapterOverflowAfterRound(input: {
  chapterId: string;
  title: string;
  target: number;
  beforeContent: string;
  afterContent: string;
}): ChapterOverflowReport | undefined {
  const before = documentTextLength(input.beforeContent || '');
  const after = documentTextLength(input.afterContent || '');
  if (after <= input.target) return undefined;
  return {
    chapterId: input.chapterId,
    title: input.title,
    target: input.target,
    before,
    after,
    added: after - before,
    over: after - input.target,
  };
}

/**
 * 阶段 message / details 用的超额注记：**本轮新增多少字 + 超出多少**（4.56 2-b 验收项）。
 * 同时给出「后续轮次须以替换/合并回收」的动作指向，避免被读成「已接受超产」。
 */
export function renderChapterOverflowNote(report: ChapterOverflowReport): string {
  return `【章预算账】${report.title}：本轮新增 ${report.added} 字（${report.before}→${report.after} 字），超出章预算 ${report.over} 字（预算 ${report.target} 字）——后续轮次须以替换/合并回收，不得继续追加。`;
}

/**
 * 章级超额写进 diagnostics（结构化持久化，复盘可见；阶段 message/details 只承载本轮，
 * metrics 承载跨轮可聚合的记录）。
 *
 * 防御口径与 `recordRepairActions` 同族：单测以局部 session 桩（diagnostics 无 metrics 段）
 * 调用修复轮时静默跳过，不吞生产计数。
 */
export function recordChapterBudgetMetric(input: {
  diagnostics?: DocumentGenerationDiagnostics;
  /** 修复轮 id（与 LLM_PATCH_REPAIR_ROUNDS 同族命名，如 content-depth-repair） */
  round: string;
  startedAt: number;
  report: ChapterOverflowReport;
}): void {
  const metrics = input.diagnostics?.metrics;
  if (!Array.isArray(metrics)) return;
  const endedAt = Date.now();
  metrics.push({
    name: `chapter-budget:${input.round}:${input.report.chapterId}`,
    startedAt: input.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - input.startedAt),
    meta: {
      round: input.round,
      chapter: input.report.title,
      target: input.report.target,
      before: input.report.before,
      after: input.report.after,
      added: input.report.added,
      over: input.report.over,
    },
  });
}
