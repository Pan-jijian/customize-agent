/**
 * repairRounds · 编制依据法规漏列链尾收口轮（basis-regulations-repair）：
 * 丰乐镇实机终门禁归因 #8——编制依据段法律法规/地方性法规齐全但零施工验收规范编号，
 * 终检 basis-regulations-coverage 报 blocker 后修复链无轮消费直坠终门禁。本测试锁定：
 * 1. 接线：FINALIZE_REPAIR_ROUNDS 声明 + postReviewSurface 链尾调用位置（quotation-balance-repair
 *    收口之后、requirement-response-repair silent 重放之前）；
 * 2. 行为矩阵：全文覆盖完好零成本通过 / 章级定位 + LLM 补列落地（缺失类目复检 + recompute）/
 *    删除式修复回滚（汉字数大幅减少）/ 缺失类目上升回滚 / 章外区段显性记录；
 * repairChapterByQuality 全 mock（复检为确定性实现，无 LLM 网络依赖）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/rolePipeline', () => ({
  repairChapterByQuality: vi.fn(),
  repairPatchGuard: vi.fn(() => undefined),
}));

import { repairChapterByQuality } from '@/services/document-workflow/rolePipeline';
import { FINALIZE_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import { stageBasisRegulationsRepair } from '@/services/document-workflow/finalize/repairRounds/basisRegulationsRepair';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const repairMock = vi.mocked(repairChapterByQuality);
const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 漏列规范条目版本（法律法规/条例齐全、零施工验收规范编号：丰乐镇实机同形态，缺 1 类） */
const DEFECTIVE_CONTENT = [
  '## 编制依据',
  '本工程施工组织设计编制依据如下：',
  '《中华人民共和国建筑法》（主席令第91号，2019年修正）',
  '《建设工程质量管理条例》（国务院令第279号）',
].join('\n');
/** 修复后版本（补列施工验收规范条目，五类覆盖通过） */
const REPAIRED_CONTENT = [
  '## 编制依据',
  '本工程施工组织设计编制依据如下：',
  '《中华人民共和国建筑法》（主席令第91号，2019年修正）',
  '《建设工程质量管理条例》（国务院令第279号）',
  '《给水排水管道工程施工及验收规范》（GB 50268-2008）',
  '《建筑地基基础工程施工质量验收标准》（GB 50202-2018）',
].join('\n');

interface StageLike { roleId?: string; status?: string; message?: string; details?: string[] }

function stageOf(stages: StageLike[], roleId: string): StageLike | undefined {
  return stages.find(stage => stage.roleId === roleId);
}

function makeSession(chapters: Array<{ id: string; title: string; content: string }>, overrides: Record<string, unknown> = {}) {
  const session = {
    template: {},
    requirement: '',
    bidComposition: undefined,
    signal: undefined,
    blueprintData: undefined,
    generationDiagnostics: { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, lastError: '' } },
    finalChapterDrafts: chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: [] })),
    // 4.55.22：项目资料（无来源规范编号守卫的依据来源）——补列的标准必须能在资料里查到
    allEvidence: [{ content: '设计说明：给水排水管道施工按《给水排水管道工程施工及验收规范》（GB 50268-2008）执行；地基基础施工按《建筑地基基础工程施工质量验收标准》（GB 50202-2018）执行。', filePath: '结构设计总说明.dwg' }],
    progressStages: [] as StageLike[],
    finalGateRepairStages: [] as StageLike[],
    finalMarkdown: chapters.map(chapter => chapter.content).join('\n\n'),
    emitProgress: vi.fn(),
    withProgressHeartbeat: (fn: () => Promise<unknown>) => fn(),
    recomputeFinalValidationBundle: vi.fn(async () => {}),
    ...overrides,
  } as unknown as FinalizeSession & { finalChapterDrafts: Array<{ content: string }> };
  // rebuildFinalMarkdown 与章内容联动（落地后终态对账消费）
  Object.assign(session, { rebuildFinalMarkdown: vi.fn(() => session.finalChapterDrafts.map(chapter => chapter.content).join('\n\n')) });
  return session;
}

function repairResult(content: string) {
  return { content, appliedCount: 1, producedCount: 1, repairType: 'quality' as never };
}

describe('basis-regulations-repair 链尾接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE_REPAIR_ROUNDS 声明含 basis-regulations-repair，且位于 quotation-balance-repair 与 toc-consistency 之间', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const index = rounds.indexOf('basis-regulations-repair');
    expect(index).toBeGreaterThan(-1);
    expect(rounds.indexOf('quotation-balance-repair')).toBeLessThan(index);
    expect(rounds.indexOf('toc-consistency')).toBeGreaterThan(index);
  });

  it('postReviewSurface.ts 在 quotation 收口之后、补写静默重放之前调用（同一编制依据段族系链尾）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'finalize/repairRounds/postReviewSurface.ts'), 'utf8');
    const quotationIndex = source.indexOf('await stageQuotationBalanceRepair(session);');
    const basisIndex = source.indexOf('await stageBasisRegulationsRepair(session);');
    const replayIndex = source.indexOf('await stageRequirementResponseRepair(session, { silent: true });');
    expect(quotationIndex).toBeGreaterThan(-1);
    expect(basisIndex).toBeGreaterThan(quotationIndex);
    expect(replayIndex).toBeGreaterThan(basisIndex);
  });
});

describe('basis-regulations-repair 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('全文覆盖完好：零成本通过，不进修复轮', async () => {
    const session = makeSession([{ id: 'ch1', title: '编制依据', content: REPAIRED_CONTENT }]);
    await stageBasisRegulationsRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    expect(session.progressStages).toHaveLength(0);
  });

  it('章级定位漏列章 + LLM 补列落地：缺失清零、rebuild+recompute 复验、终态清零', async () => {
    const session = makeSession([{ id: 'ch1', title: '编制依据', content: DEFECTIVE_CONTENT }]);
    repairMock.mockResolvedValueOnce(repairResult(REPAIRED_CONTENT));
    await stageBasisRegulationsRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('编制依据法规漏列定向修复');
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('施工验收规范');
    expect(session.finalChapterDrafts[0].content).toBe(REPAIRED_CONTENT);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-basis-regulations-repair-ch1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('修复完成');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('终态残留 0 类缺口');
  });

  it('删除式修复回滚：汉字数大幅减少即回滚保留原文', async () => {
    const filler = '本项目严格按设计图纸与工程量清单组织施工。'.repeat(12);
    const original = `## 编制依据\n本工程编制依据如下：\n${filler}`;
    const session = makeSession([{ id: 'ch1', title: '编制依据', content: original }]);
    repairMock.mockResolvedValueOnce(repairResult('## 编制依据\n按现行法规执行。'));
    await stageBasisRegulationsRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(session.finalChapterDrafts[0].content).toBe(original);
    const stage = stageOf(session.progressStages, 'agent-basis-regulations-repair-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('缺失类目上升回滚：修复后缺口类别不减反增即回滚', async () => {
    // 修复前仅缺规范类（1 类）；修复后删除条例条目且未补规范 → 缺条例+规范（2 类 > 1 类）
    const original = [
      '## 编制依据',
      '《中华人民共和国建筑法》（主席令第91号，2019年修正）',
      '《建设工程质量管理条例》（国务院令第279号）',
      '本工程按上述法规及现行标准组织施工，严格履行合同约定的全部义务。',
    ].join('\n');
    const degraded = [
      '## 编制依据',
      '《中华人民共和国建筑法》（主席令第91号，2019年修正）',
      '本工程按上述法规及现行标准组织施工，严格履行合同约定的全部义务。',
    ].join('\n');
    const session = makeSession([{ id: 'ch1', title: '编制依据', content: original }]);
    repairMock.mockResolvedValueOnce(repairResult(degraded));
    await stageBasisRegulationsRepair(session);
    expect(session.finalChapterDrafts[0].content).toBe(original);
    const stage = stageOf(session.progressStages, 'agent-basis-regulations-repair-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  // 4.55.22 新增守卫：本轮指令要求模型"按本工程分部分项选择现行版本并列全名称与编号"，
  // 而唯一事实来源只有招标文件引用法规——标准编号全靠模型记忆产出，原 recheck 只看类目覆盖+汉字数，
  // 编造/废止编号照样落地。现要求新引入的编号必须能在项目资料中查到，否则回滚。
  it('无来源规范编号回滚：补列的编号在项目资料中查无 → 回滚保留原文', async () => {
    const session = makeSession([{ id: 'ch1', title: '编制依据', content: DEFECTIVE_CONTENT }]);
    const fabricated = [
      ...REPAIRED_CONTENT.split('\n'),
      '《既有建筑维护与改造通用规范》（GB 55022-2099）',
    ].join('\n');
    repairMock.mockResolvedValueOnce(repairResult(fabricated));
    await stageBasisRegulationsRepair(session);
    expect(session.finalChapterDrafts[0].content).toBe(DEFECTIVE_CONTENT);
  });

  it('章外区段报出：章级检测均通过时显性记录，不猜测改写', async () => {
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: '本工程位于肥西县，新建 DN200 给水管道。' }], {
      // 编制依据区段位于章外结构：全文报缺失但章级检测均通过
      finalMarkdown: '## 编制依据\n《中华人民共和国建筑法》\n《建设工程质量管理条例》\n\n本工程位于肥西县，新建 DN200 给水管道。',
    });
    await stageBasisRegulationsRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'basis-regulations-repair');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('无定向修复目标');
  });
});

/**
 * 4.55.29 指令根修（实机 `doc-1790104980418-d47a002e` 归因：修复轮自身缺陷）。
 *
 * 实机回滚消息：「编制依据法规漏列修复已回滚：主要施工方法与技术措施（修复复检未通过，保留修复前正文；
 * 残留 4 类缺口）」。证据链：该章编制依据段**规范条目已有 12 条**，真缺口是法律法规/条例/地方性法规/
 * 招标文件引用法规；而旧指令第 2 条**无条件**要求"按本工程分部分项选列施工验收规范名称与编号"，
 * 逼模型从记忆里产出自带编号的规范条目 → 撞上本轮"无来源新增编号"守卫（recheck 指标 3）→ 整轮回滚，
 * 三类真缺口一个字未补。根因是**任务自相矛盾**（缺口驱动缺失），不是模型不照做。
 * 现指令按缺口类目逐条下发；未缺规范类目时改为显性禁令（含后果）。
 */
describe('basis-regulations-repair 缺口驱动指令（4.55.29）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /** 需地方法规判定：location 为工程所在地（省/市两级） */
  const 蓝图 = { project: { location: '安徽省合肥市巢湖市' }, basisRegulations: [] as string[] };
  /** 缺法/条例/地方三类、规范类目已满足（且有编号来源）的编制依据段 */
  const 缺三类 = [
    '## 编制依据',
    '本工程编制依据如下：',
    '《给水排水管道工程施工及验收规范》（GB 50268-2008）',
    '《建筑地基基础工程施工质量验收标准》（GB 50202-2018）',
  ].join('\n');
  /** 补列法/条例/地方三类（法规名来自公开知识 + 属地，规范条目与既有条目一致，无新增编号） */
  const 补齐三类 = [
    '## 编制依据',
    '本工程编制依据如下：',
    '《中华人民共和国建筑法》（主席令第91号，2019年修正）',
    '《建设工程质量管理条例》（国务院令第279号）',
    '《合肥市市政设施管理条例》',
    '《给水排水管道工程施工及验收规范》（GB 50268-2008）',
    '《建筑地基基础工程施工质量验收标准》（GB 50202-2018）',
  ].join('\n');

  it('未缺规范类目：指令下达"不得新增规范编号"禁令，且不再要规范清单（消除自相矛盾）', async () => {
    const session = makeSession([{ id: 'ch1', title: '主要施工方法与技术措施', content: 缺三类 }], { blueprintData: 蓝图 });
    repairMock.mockResolvedValueOnce(repairResult(补齐三类));
    await stageBasisRegulationsRepair(session);
    const promptTexts = repairMock.mock.calls[0][0].promptTexts as unknown as string;
    expect(promptTexts).toContain('本轮不得新增任何规范编号');
    expect(promptTexts).not.toContain('施工验收规范条目：');
    // 三类真缺口逐条下发补列口径（机制化表述：属地=工程所在地）
    expect(promptTexts).toContain('国家法律法规条目：');
    expect(promptTexts).toContain('条例/办法条目：');
    expect(promptTexts).toContain('地方性法规与政府规章条目：');
    expect(promptTexts).toContain('工程所在地属地');
    // 三类补齐即落盘（不再整轮回滚）
    expect(session.finalChapterDrafts[0].content).toBe(补齐三类);
    const stage = stageOf(session.progressStages, 'agent-basis-regulations-repair-ch1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('修复完成');
  });

  it('缺规范类目：仍要求规范名称与编号 + 编号来源可查（判据不因缺口驱动而放宽）', async () => {
    const session = makeSession([{ id: 'ch1', title: '编制依据', content: DEFECTIVE_CONTENT }]);
    repairMock.mockResolvedValueOnce(repairResult(REPAIRED_CONTENT));
    await stageBasisRegulationsRepair(session);
    const promptTexts = repairMock.mock.calls[0][0].promptTexts as unknown as string;
    expect(promptTexts).toContain('施工验收规范条目：');
    expect(promptTexts).toContain('补列的规范编号必须能在项目资料');
    expect(promptTexts).not.toContain('本轮不得新增任何规范编号');
  });

  it('反例：禁令分支下模型仍编造编号 → 守卫照常回滚（指令不是唯一防线）', async () => {
    const session = makeSession([{ id: 'ch1', title: '主要施工方法与技术措施', content: 缺三类 }], { blueprintData: 蓝图 });
    const 编造 = `${补齐三类}\n《既有建筑维护与改造通用规范》（GB 55022-2099）`;
    repairMock.mockResolvedValueOnce(repairResult(编造));
    await stageBasisRegulationsRepair(session);
    expect(session.finalChapterDrafts[0].content).toBe(缺三类);
    const stage = stageOf(session.progressStages, 'agent-basis-regulations-repair-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('补列走追加锚点：锚点=编制依据段末条书名号条目行，append 模式（防模型自行全章重写删条目）', async () => {
    const session = makeSession([{ id: 'ch1', title: '主要施工方法与技术措施', content: 缺三类 }], { blueprintData: 蓝图 });
    repairMock.mockResolvedValueOnce(repairResult(补齐三类));
    await stageBasisRegulationsRepair(session);
    expect(repairMock.mock.calls[0][0].anchorTexts).toEqual([{ text: '《建筑地基基础工程施工质量验收标准》（GB 50202-2018）', append: true }]);
  });

  it('锚点退化：条目行在章内不唯一时不传锚点（防补写插到别处，退回无锚点模式）', async () => {
    const 重复行段 = [
      '## 编制依据',
      '本工程按国家现行规定组织实施。',
      '本工程按国家现行规定组织实施。',
    ].join('\n');
    const session = makeSession([{ id: 'ch1', title: '编制依据', content: 重复行段 }]);
    repairMock.mockResolvedValueOnce(repairResult(重复行段));
    await stageBasisRegulationsRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(repairMock.mock.calls[0][0].anchorTexts).toBeUndefined();
  });
});
