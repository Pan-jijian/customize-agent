/**
 * 4.56 改造 2-b · 补写轮「章预算账」单源（chapterBudgetLedger）+ 接线 + 链尾收口章级总量预算。
 *
 * 根因 R2（真实生成 doc-1790144107028-aaba7ba3 实测）：写作完成时三章全部低于章预算，
 * 交付终稿各章 +57% / +83% / +87%——超产 100% 发生在写作之后的修复链，且不是重复内容
 * （完全重复段落 0），靠「事后压缩」压不回来。机制原因：补写轮各自只解决自己那一类缺陷，
 * **不知道章预算、不知道别的轮已经写了什么**，一律追加；`requirement-tail-closure` 更是一次
 * 确定性批插且无任何总量上限。
 *
 * 本测试锁定（判据机制化：所有阈值为常量或与输入字数的算式，不写项目数值）：
 * 1. 账本口径：分母取 `documentBudget.chapterTargets`（唯一权威来源）、分子取 `finalChapterDrafts`
 *    实时正文字数（`documentTextLength` 口径）；预算表未覆盖本章时走显式折算兜底且 `fallbackNote`
 *    必现（历史缺陷：`get(id) || 1200` 把缺失输入变成「自信的错误分母」）；文档级 Σ 与超额排序；
 * 2. 指令渲染正反例：必含「本章预算 X 字、当前 Y 字、剩余额度 Z 字」与「超出即须替换/合并，不得追加」，
 *    超额章追加超额字数；**硬约束**「该补的还要补」——额度段恒与「真实缺陷不得因额度放弃补写」同现，
 *    否则该段会被读成「不补的许可」；
 * 3. 落地后超额观测：未超预算不产记录（不污染阶段 message）；超额产 {before, after, added, over}
 *    并写 `generationDiagnostics.metrics`（无 metrics 段静默跳过不抛）；
 * 4. 接线（贡献最大的补写轮）：content-depth / requirement-response / control-loop /
 *    professional-chain 四轮的 LLM 指令均带章预算段，落地超额后阶段 message 出现
 *    「本轮新增 N 字…超出章预算 M 字」（只观测不截断——强制截断需改造 2-a 的写入通道）；
 * 5. 链尾收口章级总量预算：额度内照插（该补的还要补，且不再被误伤）；额度不足**不插但显性报出**
 *    （`budgetSkippedCount` + details 逐条），绝不静默丢弃；未定位素材挂文档级额度，无章归属不等于无约束。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/rolePipeline', () => ({
  repairChapterByQuality: vi.fn(),
  repairPatchGuard: vi.fn(() => undefined),
  // 修复动作计量经 rolePipeline 统一出口，mock 需提供同名 no-op
  recordRepairActions: vi.fn(),
}));

import { repairChapterByQuality } from '@/services/document-workflow/rolePipeline';
import { CHAPTER_MIN_BUDGET, documentTextLength } from '@/services/document-workflow/budget';
import {
  buildChapterBudgetLedger,
  chapterBudgetEntry,
  chapterBudgetEntryByTitle,
  chapterOverflowAfterRound,
  mergeLandedInserts,
  recordChapterBudgetMetric,
  renderChapterBudgetInstruction,
  renderChapterOverflowNote,
  renderDocumentBudgetSummary,
} from '@/services/document-workflow/finalize/repairRounds/chapterBudgetLedger';
import { stageContentDepthRepair } from '@/services/document-workflow/finalize/repairRounds/contentDepthRepair';
import { stageControlLoopRepair } from '@/services/document-workflow/finalize/repairRounds/controlLoopRepair';
import { stageProfessionalChainRepair } from '@/services/document-workflow/finalize/repairRounds/professionalChainRepair';
import { applyRequirementTailClosure } from '@/services/document-workflow/finalize/repairRounds/requirementResponseRepair';
import { criticalSectionDepthIssues } from '@/services/document-workflow/finalize/rebuildAndRecompute';
import { constructionOrgControlLoopIssues, constructionOrgProfessionalChainIssues } from '@/services/document-workflow/constructionOrgQualityRules';
import type { TenderRequirementAssignment } from '@/services/document-workflow/tenderRequirements';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';
import type { DocumentGenerationDiagnostics, TenderRequirementEntry, TenderRequirementModel } from '@/services/document-workflow/types';

const repairMock = vi.mocked(repairChapterByQuality);

interface StageLike { roleId?: string; status?: string; message?: string; details?: string[] }

function stageOf(stages: StageLike[], roleId: string): StageLike | undefined {
  return stages.find(stage => stage.roleId === roleId);
}

function repairResult(content: string) {
  return { content, appliedCount: 1, producedCount: 1, repairType: 'quality' as never };
}

/** 零向量嵌入注入：余弦恒 0（语义通道强制失效），链尾收口仅确定性通道参与判定 */
const zeroEmbed = async (texts: string[]): Promise<number[][]> => texts.map(() => [0, 0]);

function makeSession(chapters: Array<{ id: string; title: string; content: string }>, overrides: Record<string, unknown> = {}) {
  const session = {
    template: {},
    requirement: '',
    bidComposition: undefined,
    signal: undefined,
    factsModel: { project: [], preciseFacts: [] },
    generationDiagnostics: { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, lastError: '' }, metrics: [] },
    finalChapterDrafts: chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: [] })),
    progressStages: [] as StageLike[],
    finalGateRepairStages: [] as StageLike[],
    finalMarkdown: chapters.map(chapter => `## ${chapter.title}\n${chapter.content}`).join('\n\n'),
    emitProgress: vi.fn(),
    withProgressHeartbeat: (fn: () => Promise<unknown>) => fn(),
    recomputeFinalValidationBundle: vi.fn(async () => {}),
    validationIssues: [] as unknown[],
    ...overrides,
  } as unknown as FinalizeSession & { finalChapterDrafts: Array<{ content: string }> };
  Object.assign(session, { rebuildFinalMarkdown: vi.fn(() => session.finalChapterDrafts.map(chapter => chapter.content).join('\n\n')) });
  return session;
}

describe('chapterBudgetLedger · 账本口径（分母=章预算单源，分子=实时正文字数）', () => {
  const chapters = [
    { id: 'ch-over', title: '已超预算章', content: '本章正文已经写满并超出预算额度。' },
    { id: 'ch-at', title: '恰好用尽章', content: '本章正文恰好用尽预算额度。' },
    { id: 'ch-under', title: '尚有余量章', content: '简短正文。' },
  ];

  it('正例：逐章 target/current/remaining 与文档级 Σ 三值同源；remaining = target - current', () => {
    const currentOf = (index: number) => documentTextLength(chapters[index]!.content);
    const ledger = buildChapterBudgetLedger({
      chapterTargets: new Map([['ch-over', currentOf(0) - 1], ['ch-at', currentOf(1)], ['ch-under', currentOf(2) + 100]]),
      chapters,
      documentTargetChars: 10_000,
    });
    expect(chapterBudgetEntry(ledger, 'ch-over')).toMatchObject({ target: currentOf(0) - 1, current: currentOf(0), remaining: -1 });
    expect(chapterBudgetEntry(ledger, 'ch-at')).toMatchObject({ remaining: 0 });
    expect(chapterBudgetEntry(ledger, 'ch-under')).toMatchObject({ remaining: 100 });
    expect(chapterBudgetEntry(ledger, 'ch-missing')).toBeUndefined();
    const chapterSum = currentOf(0) + currentOf(1) + currentOf(2);
    expect(ledger.document).toEqual({ target: 10_000, current: chapterSum, remaining: 10_000 - chapterSum });
  });

  it('反例：remaining = 0（恰好用尽）不算超额——判据为 remaining < 0，避免边界误报', () => {
    const currentOf = (index: number) => documentTextLength(chapters[index]!.content);
    const ledger = buildChapterBudgetLedger({
      chapterTargets: new Map([['ch-over', currentOf(0) - 1], ['ch-at', currentOf(1)], ['ch-under', currentOf(2)]]),
      chapters,
    });
    // 超额集按超额降序（定向回收顺序：先回收超额最大者）
    expect(ledger.overBudget.map(chapter => chapter.chapterId)).toEqual(['ch-over']);
  });

  it('反例：预算表未覆盖本章不得静默落常量——显式折算兜底且 fallbackNote 必现（可见性判据）', () => {
    const oneChapter = [{ id: 'ch-1', title: '已覆盖章', content: '正文。' }, { id: 'ch-2', title: '未覆盖章', content: '正文。' }];
    const chapterTargets = new Map([['ch-1', 4_000]]);
    const ledger = buildChapterBudgetLedger({ chapterTargets, chapters: oneChapter, documentTargetChars: 9_000 });
    const uncovered = chapterBudgetEntry(ledger, 'ch-2')!;
    expect(uncovered.fallbackNote).toContain('章预算缺失回退');
    // 兜底口径与输入成比例（全文目标 ÷ 章数），而非任意硬编码常量：目标翻倍则兜底翻倍
    const doubled = chapterBudgetEntry(buildChapterBudgetLedger({ chapterTargets, chapters: oneChapter, documentTargetChars: 18_000 }), 'ch-2')!;
    expect(doubled.target).toBe(uncovered.target * 2);
    // 目标与章预算合计均不可用：取章最低预算锚点（常量引用，不落字面量）
    const anchor = chapterBudgetEntry(buildChapterBudgetLedger({ chapterTargets: new Map(), chapters: oneChapter }), 'ch-2')!;
    expect(anchor.target).toBe(CHAPTER_MIN_BUDGET);
    expect(anchor.fallbackNote).toBeTruthy();
  });

  it('分子口径与写作侧同源：HTML 标签/空白不计入（documentTextLength）', () => {
    const ledger = buildChapterBudgetLedger({
      chapterTargets: new Map([['ch-1', 1_000]]),
      chapters: [{ id: 'ch-1', title: '章', content: '<p> 正文 内容 </p>' }],
    });
    expect(chapterBudgetEntry(ledger, 'ch-1')!.current).toBe(documentTextLength('正文内容'));
  });

  it('收口素材回灌：章标题命中并入该章正文（跨轮重算额度不被重复授予）；未定位/标题未命中挂文档级不丢字数', () => {
    const chapter = { id: 'ch-q', title: '质量保证措施', content: '本章正文。' };
    const material = '我方在质量保修期内承担工程质量保修责任。';
    const cost = documentTextLength(material);
    // 正例：同章两条素材并入后，账本剩余额度按真实交付长度扣减（mergeLandedInserts 是唯一回灌口径）
    const merged = mergeLandedInserts([chapter], [{ chapterTitle: chapter.title, material }, { chapterTitle: chapter.title, material }]);
    expect(documentTextLength(merged.chapters[0]!.content)).toBe(documentTextLength(chapter.content) + cost * 2);
    expect(merged.unlocatedChars).toBe(0);
    const ledger = buildChapterBudgetLedger({ chapterTargets: new Map([['ch-q', documentTextLength(chapter.content) + cost * 2]]), chapters: merged.chapters });
    expect(chapterBudgetEntry(ledger, 'ch-q')!.remaining).toBe(0);
    // 反例：未定位（空标题）与标题未命中任何章 → 计入文档级字数，绝不计 0（插入物确实在成稿里）
    const loose = mergeLandedInserts([chapter], [{ chapterTitle: '', material }, { chapterTitle: '不存在的章', material }]);
    expect(loose.chapters[0]!.content).toBe(chapter.content);
    expect(loose.unlocatedChars).toBe(cost * 2);
    // 反例：无插入时原样返回（零成本，不重建章数组）
    const chaptersRef = [chapter];
    const untouched = mergeLandedInserts(chaptersRef, []);
    expect(untouched.chapters).toBe(chaptersRef);
    expect(untouched.unlocatedChars).toBe(0);
  });

  it('按标题查表（链尾收口以章标题定位插入目标，故预算查表同键）；空标题不命中', () => {
    const ledger = buildChapterBudgetLedger({ chapterTargets: new Map([['ch-1', 1_000]]), chapters: [{ id: 'ch-1', title: '确保工程质量的技术组织措施', content: '正文。' }] });
    expect(chapterBudgetEntryByTitle(ledger, '确保工程质量的技术组织措施')).toMatchObject({ chapterId: 'ch-1' });
    expect(chapterBudgetEntryByTitle(ledger, '')).toBeUndefined();
  });
});

describe('chapterBudgetLedger · 指令渲染（正反例 + 硬约束）', () => {
  it('正例（额度内）：预算/当前/剩余三值齐全 + 「超出即须替换/合并，不得追加」，不出现超额字样', () => {
    const text = renderChapterBudgetInstruction({ chapterId: 'ch-1', title: '章', target: 1_000, current: 400, remaining: 600 });
    expect(text).toContain('【章预算账】本章预算 1000 字、当前 400 字、剩余额度 600 字。');
    expect(text).toContain('超出即须替换/合并，不得追加');
    expect(text).not.toContain('已超出章预算');
  });

  it('反例（已超额）：显式给出超额字数与剩余负数（额度不足时先替换/压缩腾空间再落位）', () => {
    const text = renderChapterBudgetInstruction({ chapterId: 'ch-2', title: '章', target: 1_000, current: 1_600, remaining: -600 });
    expect(text).toContain('剩余额度 -600 字');
    expect(text).toContain('已超出章预算 600 字');
    expect(text).toContain('替换/合并');
  });

  it('硬约束（不得改变「该补的还要补」）：无论超额与否，额度段恒含「真实缺陷不得因额度放弃补写」', () => {
    const under = renderChapterBudgetInstruction({ chapterId: 'ch-1', title: '章', target: 1_000, current: 400, remaining: 600 });
    const over = renderChapterBudgetInstruction({ chapterId: 'ch-2', title: '章', target: 1_000, current: 1_600, remaining: -600 });
    for (const text of [under, over]) {
      // 这段若缺失，预算段就会被读成「不补的许可」——真实缺陷优先级高于篇幅
      expect(text).toContain('真实缺陷一律不得因额度放弃补写');
      expect(text).toContain('缺陷优先级高于篇幅');
    }
  });

  it('文档级摘要：含三值与超额章数（超额章为空时不给误导性明细）', () => {
    const empty = buildChapterBudgetLedger({ chapterTargets: new Map([['ch-1', 1_000]]), chapters: [{ id: 'ch-1', title: '章', content: '正文。' }], documentTargetChars: 1_000 });
    expect(renderDocumentBudgetSummary(empty)).toContain('【章预算账·全文】预算 1000 字、当前');
    expect(renderDocumentBudgetSummary(empty)).not.toContain('超额章');
    const overBudget = buildChapterBudgetLedger({ chapterTargets: new Map([['ch-1', 1]]), chapters: [{ id: 'ch-1', title: '章', content: '正文已超出。' }] });
    expect(renderDocumentBudgetSummary(overBudget)).toContain('超额章 1 个');
  });
});

describe('chapterBudgetLedger · 落地后超额观测（只观测不改写）', () => {
  const target = 6;
  const overReport = { chapterId: 'ch-1', title: '第一章', target, beforeContent: '一二三四五', afterContent: '一二三四五六七八' };

  it('正例：落地后超预算 → {before, after, added, over} 与 documentTextLength 同口径', () => {
    expect(chapterOverflowAfterRound(overReport)).toEqual({ chapterId: 'ch-1', title: '第一章', target, before: 5, after: 8, added: 3, over: 2 });
  });

  it('反例：未超预算（含恰好等于）不产记录——未超额章不得被写超额注记', () => {
    expect(chapterOverflowAfterRound({ ...overReport, target: 8 })).toBeUndefined();
    expect(chapterOverflowAfterRound({ ...overReport, target: 100 })).toBeUndefined();
  });

  it('反例：本轮净减但总额仍超 → 仍须报出（added 为负、over 为正），防「缩了一点就算合规」', () => {
    const report = chapterOverflowAfterRound({ ...overReport, beforeContent: '一二三四五六七八九十', afterContent: '一二三四五六七八' })!;
    expect(report).toMatchObject({ before: 10, after: 8, added: -2, over: 2 });
  });

  it('超额注记措辞：本轮新增/超出/预算三值 + 后续轮次须以替换合并回收（不得被读成「已接受超产」）', () => {
    const note = renderChapterOverflowNote(chapterOverflowAfterRound(overReport)!);
    expect(note).toContain('本轮新增 3 字（5→8 字），超出章预算 2 字（预算 6 字）');
    expect(note).toContain('替换/合并');
    expect(note).toContain('不得继续追加');
  });

  it('超额记录落 diagnostics.metrics（跨轮可聚合）；diagnostics 无 metrics 段时静默跳过不抛', () => {
    const diagnostics = { metrics: [] } as unknown as DocumentGenerationDiagnostics;
    recordChapterBudgetMetric({ diagnostics, round: 'content-depth-repair', startedAt: Date.now(), report: chapterOverflowAfterRound(overReport)! });
    expect(diagnostics.metrics).toHaveLength(1);
    expect(diagnostics.metrics[0]!.name).toBe('chapter-budget:content-depth-repair:ch-1');
    expect(diagnostics.metrics[0]!.meta).toMatchObject({ round: 'content-depth-repair', chapter: '第一章', target, before: 5, after: 8, added: 3, over: 2 });
    expect(() => recordChapterBudgetMetric({ diagnostics: {} as DocumentGenerationDiagnostics, round: 'x', startedAt: 0, report: chapterOverflowAfterRound(overReport)! })).not.toThrow();
  });
});

describe('4.56 2-b 接线 · 补写轮指令带章预算段 + 落地超额上屏（只观测不截断）', () => {
  const CRITICAL_SHORT = '### 危大工程专项施工方案审批流程\n本工程危大工程按程序报审后实施。';
  const CRITICAL_LONG = `### 危大工程专项施工方案审批流程\n${'危大工程范围包括基坑支护与降水工程、土方开挖工程、模板工程、起重吊装工程及脚手架工程，专项方案经施工单位技术负责人审批后报监理审查，超过一定规模的须组织专家论证。'.repeat(6)}`;
  const QUALITY_BEFORE = '本章执行自检、交接检制度。';
  const QUALITY_FULL = '严格执行自检、互检、交接检三检制度，发现问题及时整改，复查合格后方可进入下道工序，检查记录同步归档。';
  const MIXED_BEFORE = '### 道路工程\n本项目道路工程采用外脚手架配合塔吊完成主体结构施工。';
  const MIXED_AFTER = '### 道路工程\n本项目道路工程采用测量放线定位，沟槽开挖后分层回填，水稳与沥青面层依次摊铺。';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  /** 紧预算（必然已超额）：额度 = 修复前字数 - 1，判据与输入字数挂钩而非写死数值 */
  function tightBudget(content: string, chapterId: string) {
    return { documentBudget: { chapterTargets: new Map([[chapterId, Math.max(1, documentTextLength(content) - 1)]]), targetChars: 0 } };
  }

  it('content-depth-repair：指令含章预算段（含硬约束），落地超额后阶段 message/metrics 记录「本轮新增 + 超出」', async () => {
    const chapter = { id: 'ch-1', title: '施工组织设计', content: CRITICAL_SHORT };
    const session = makeSession([chapter], {
      validationIssues: criticalSectionDepthIssues([{ ...chapter, evidence: [], missingFacts: [], sections: [] }]),
      ...tightBudget(CRITICAL_SHORT, 'ch-1'),
    });
    repairMock.mockResolvedValueOnce(repairResult(CRITICAL_LONG));
    await stageContentDepthRepair(session);
    const promptTexts = (repairMock.mock.calls[0]![0] as unknown as { promptTexts: string }).promptTexts;
    expect(promptTexts).toContain('【章预算账】本章预算');
    expect(promptTexts).toContain('超出即须替换/合并，不得追加');
    expect(promptTexts).toContain('真实缺陷一律不得因额度放弃补写');
    const stage = stageOf(session.progressStages, 'agent-content-depth-repair-ch-1');
    expect(stage?.message).toContain('本轮新增');
    expect(stage?.message).toContain('超出章预算');
    expect(stage?.details?.some(detail => detail.includes('【章预算账】') && detail.includes('替换/合并'))).toBe(true);
    const metrics = (session.generationDiagnostics as unknown as DocumentGenerationDiagnostics).metrics!;
    expect(metrics.some(metric => String(metric.name).startsWith('chapter-budget:content-depth-repair:ch-1'))).toBe(true);
    expect(session.generationDiagnostics.llm.lastInfo).toContain('【章预算账·全文】');
  });

  it('control-loop-repair：指令含章预算段，落地超额后阶段 message 记录本轮新增与超出', async () => {
    const chapter = { id: 'ch-q', title: '质量保证措施', content: QUALITY_BEFORE };
    const drafts = [{ ...chapter, evidence: [], missingFacts: [], sections: [] }];
    const session = makeSession([chapter], { validationIssues: constructionOrgControlLoopIssues(drafts), ...tightBudget(QUALITY_BEFORE, 'ch-q') });
    repairMock.mockResolvedValueOnce(repairResult(QUALITY_FULL));
    await stageControlLoopRepair(session);
    const promptTexts = (repairMock.mock.calls[0]![0] as unknown as { promptTexts: string }).promptTexts;
    expect(promptTexts).toContain('【章预算账】');
    expect(promptTexts).toContain('真实缺陷一律不得因额度放弃补写');
    const stage = stageOf(session.progressStages, 'agent-control-loop-repair-ch-q');
    expect(stage?.message).toContain('本轮新增');
    expect(stage?.message).toContain('超出章预算');
  });

  it('professional-chain-repair：指令含章预算段，落地超额后阶段 message 记录本轮新增与超出', async () => {
    const chapter = { id: 'ch-x', title: '道路工程施工组织', content: MIXED_BEFORE };
    const drafts = [{ ...chapter, evidence: [], missingFacts: [], sections: [] }];
    const session = makeSession([chapter], {
      validationIssues: constructionOrgProfessionalChainIssues({ markdown: `## ${chapter.title}\n${MIXED_BEFORE}`, factsModel: { project: [], preciseFacts: [] } as never, chapters: drafts }),
      ...tightBudget(MIXED_BEFORE, 'ch-x'),
    });
    repairMock.mockResolvedValueOnce(repairResult(MIXED_AFTER));
    await stageProfessionalChainRepair(session);
    const promptTexts = (repairMock.mock.calls[0]![0] as unknown as { promptTexts: string }).promptTexts;
    expect(promptTexts).toContain('【章预算账】');
    expect(promptTexts).toContain('超出即须替换/合并，不得追加');
    const stage = stageOf(session.progressStages, 'agent-professional-chain-repair-ch-x');
    expect(stage?.message).toContain('本轮新增');
    expect(stage?.message).toContain('超出章预算');
  });

  it('反例：额度充裕时补写照常落地且无超额注记（防「预算闸误伤真实缺陷补写」）', async () => {
    const chapter = { id: 'ch-1', title: '施工组织设计', content: CRITICAL_SHORT };
    const session = makeSession([chapter], {
      validationIssues: criticalSectionDepthIssues([{ ...chapter, evidence: [], missingFacts: [], sections: [] }]),
      documentBudget: { chapterTargets: new Map([['ch-1', documentTextLength(CRITICAL_LONG) + 100]]), targetChars: 0 },
    });
    repairMock.mockResolvedValueOnce(repairResult(CRITICAL_LONG));
    await stageContentDepthRepair(session);
    expect(session.finalChapterDrafts[0]!.content).toBe(CRITICAL_LONG);
    const stage = stageOf(session.progressStages, 'agent-content-depth-repair-ch-1');
    expect(stage?.message).toContain('内容深度补写完成');
    expect(stage?.message).not.toContain('超出章预算');
  });
});

describe('4.56 2-b ③ · 链尾收口章级总量预算（额度内照插 / 额度不足不插但显性报出）', () => {
  const MARKDOWN = ['# 施工组织设计', '', '## 第一章 工程概况', '', '本工程位于工业园区，施工内容为道路与管网工程。', '', '## 第二章 质量保证措施', '', '本章阐述质量管理体系与过程控制安排。'].join('\n');
  const CHAPTER_TITLE = '质量保证措施';
  const CHAPTER_CONTENT = '本章阐述质量管理体系与过程控制安排。';
  const ENTRY: TenderRequirementEntry = { text: '承包人在质量保修期内承担工程质量保修责任。', coreTerms: ['质量保修责任'], sources: [], category: '质量保修', policy: 'respond' };
  const MATERIAL = '我方在质量保修期内承担工程质量保修责任。';
  const MATERIAL_COST = documentTextLength(MATERIAL);

  function modelOf(entries: TenderRequirementEntry[]): TenderRequirementModel {
    return { extracted: true, entries, excluded: [], reconciliation: { clauseCount: entries.length, entryCount: entries.length, excludedCount: 0, undecidedCount: 0, mergedCount: 0, batchCount: 1, retriedBatches: 0 } };
  }

  /** 预算账：章额度 = 当前章正文 + delta（delta 为负即额度不足） */
  function budgetWith(chapterId: string, delta: number) {
    return buildChapterBudgetLedger({
      chapterTargets: new Map([[chapterId, documentTextLength(CHAPTER_CONTENT) + delta]]),
      chapters: [{ id: chapterId, title: CHAPTER_TITLE, content: CHAPTER_CONTENT }],
    });
  }

  const assignment: TenderRequirementAssignment = { entry: ENTRY, chapterTitle: CHAPTER_TITLE, score: 0.5, lowConfidence: false };

  it('正例：额度恰好够 → 照插（该补的还要补，预算不误伤真实缺陷），并回报落位结构（章标题+素材）', async () => {
    const result = await applyRequirementTailClosure({
      markdown: MARKDOWN,
      tenderRequirements: modelOf([ENTRY]),
      requirementAssignments: [assignment],
      embedDocuments: zeroEmbed,
      chapterBudget: budgetWith('ch-q', MATERIAL_COST),
    });
    expect(result.insertedCount).toBe(1);
    expect(result.budgetSkippedCount).toBe(0);
    expect(result.markdown).toContain(MATERIAL);
    // 结构化落位回报：跨轮重算额度必须靠它回灌（markdown-only 插入不写章草稿，否则额度被重复授予）
    expect(result.insertions).toEqual([{ chapterTitle: CHAPTER_TITLE, material: MATERIAL }]);
  });

  it('反例：额度差 1 字 → 不插、正文零改动，但显性报出（预算不足 + 残留由终门禁照常复核）', async () => {
    const result = await applyRequirementTailClosure({
      markdown: MARKDOWN,
      tenderRequirements: modelOf([ENTRY]),
      requirementAssignments: [assignment],
      embedDocuments: zeroEmbed,
      chapterBudget: budgetWith('ch-q', MATERIAL_COST - 1),
    });
    expect(result.insertedCount).toBe(0);
    expect(result.budgetSkippedCount).toBe(1);
    expect(result.markdown).toBe(MARKDOWN);
    const skipped = result.details.filter(line => line.includes('章预算额度不足未插入'));
    expect(skipped).toHaveLength(1);
    // 不静默丢弃：报出条目类别、差额与素材片段（可复盘、可人工兜底）
    expect(skipped[0]).toContain(ENTRY.category);
    expect(skipped[0]).toContain(String(MATERIAL_COST - 1));
    expect(skipped[0]).toContain(String(MATERIAL_COST));
    expect(skipped[0]).toContain('残留由终门禁照常复核');
    expect(skipped[0]).toContain(MATERIAL.slice(0, 20));
  });

  it('反例：额度不足时 insertions 为空（不落位就不回报落位），但额度不足条数显性报出', async () => {
    const result = await applyRequirementTailClosure({
      markdown: MARKDOWN,
      tenderRequirements: modelOf([ENTRY]),
      requirementAssignments: [assignment],
      embedDocuments: zeroEmbed,
      chapterBudget: budgetWith('ch-q', MATERIAL_COST - 1),
    });
    expect(result.insertions).toEqual([]);
    expect(result.budgetSkippedCount).toBe(1);
  });

  it('反例：未定位素材（无主责章，回退文末）挂文档级额度——无章归属不等于无约束', async () => {
    const permissiveChapter = buildChapterBudgetLedger({ chapterTargets: new Map([['ch-q', documentTextLength(CHAPTER_CONTENT) + MATERIAL_COST]]), chapters: [{ id: 'ch-q', title: CHAPTER_TITLE, content: CHAPTER_CONTENT }] });
    const tightDocument: typeof permissiveChapter = { ...permissiveChapter, document: { ...permissiveChapter.document, remaining: MATERIAL_COST - 1 } };
    const result = await applyRequirementTailClosure({
      markdown: MARKDOWN,
      tenderRequirements: modelOf([ENTRY]),
      requirementAssignments: [],
      embedDocuments: zeroEmbed,
      chapterBudget: tightDocument,
    });
    expect(result.insertedCount).toBe(0);
    expect(result.budgetSkippedCount).toBe(1);
    expect(result.details.filter(line => line.includes('章预算额度不足未插入'))[0]).toContain('全文');
  });

  it('反例：无章归属且文档级额度充裕 → 照原口径回退文末补写（不因预算闸改变未定位行为）', async () => {
    const result = await applyRequirementTailClosure({
      markdown: MARKDOWN,
      tenderRequirements: modelOf([ENTRY]),
      requirementAssignments: [],
      embedDocuments: zeroEmbed,
      chapterBudget: buildChapterBudgetLedger({ chapterTargets: new Map(), chapters: [{ id: 'ch-q', title: CHAPTER_TITLE, content: CHAPTER_CONTENT }], documentTargetChars: documentTextLength(CHAPTER_CONTENT) + MATERIAL_COST }),
    });
    expect(result.insertedCount).toBe(1);
    expect(result.markdown.trimEnd().endsWith(MATERIAL)).toBe(true);
  });
});
