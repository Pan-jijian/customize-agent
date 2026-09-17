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
