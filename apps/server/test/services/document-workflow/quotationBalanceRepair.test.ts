/**
 * repairRounds · 引文成对性残缺链尾收口轮（quotation-balance-repair）：
 * r4 实机归因——编制依据段法规列举句自吞噬拼接丢失（「2017实施条例》《第279安全生产管理条例》」），
 * 终检 punctuation-artifact 报 blocker 后修复链无轮消费直坠终门禁。本测试锁定：
 * 1. 接线：FINALIZE_REPAIR_ROUNDS 声明 + postReviewSurface 链尾调用位置（regulation-number-typo
 *    与 toc-consistency 之间）；
 * 2. 行为矩阵：全文平衡零成本通过 / 章级定位 + LLM 补全落地（成对性复检 + recompute）/
 *    变差回滚（成对性恶化或内容删除式修复）/ 非章区域或跨章抵消显性记录；
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
import { stageQuotationBalanceRepair } from '@/services/document-workflow/finalize/repairRounds/quotationBalanceRepair';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const repairMock = vi.mocked(repairChapterByQuality);
const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 残缺文本 fixture（与 r4 实机行 62 同形态：括号/书名号拼接丢失） */
const DEFECTIVE_LINE = '本施工组织设计编制遵循《中华人民共和国招标投标法》（主席令第21号公布，2017实施条例》（国务院令第613号）等现行法规。';
/** 修复后文本（补全「年修正）、《中华人民共和国招标投标法」拼接丢失段） */
const REPAIRED_LINE = '本施工组织设计编制遵循《中华人民共和国招标投标法》（主席令第21号公布，2017年修正）、《中华人民共和国招标投标法实施条例》（国务院令第613号）等现行法规。';

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

describe('quotation-balance-repair 链尾接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE_REPAIR_ROUNDS 声明含 quotation-balance-repair，且位于 regulation-number-typo 与 toc-consistency 之间', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const index = rounds.indexOf('quotation-balance-repair');
    expect(index).toBeGreaterThan(-1);
    expect(rounds.indexOf('regulation-number-typo')).toBeLessThan(index);
    expect(rounds.indexOf('toc-consistency')).toBeGreaterThan(index);
  });

  it('postReviewSurface.ts 在确定性清洗与 toc 之间调用收口，且收口后有清洗重放（rebuild 回退恢复）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'finalize/repairRounds/postReviewSurface.ts'), 'utf8');
    const callIndex = source.indexOf('await stageQuotationBalanceRepair(session);');
    const tocIndex = source.indexOf('fixTocFromBody(session.finalMarkdown)');
    expect(callIndex).toBeGreaterThan(-1);
    expect(tocIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeLessThan(tocIndex);
    // r6 回归（v11 rebuild 回退实机归因）：quotation 章级 patch 成功后 rebuildFinalMarkdown() 会回退
    // 此前全部字符串级清洗——首跑清洗（函数体外调用）必须在收口之前，且收口之后必须存在清洗重放调用
    const cleansFnIndex = source.indexOf('async function runSurfaceDeterministicCleans');
    expect(cleansFnIndex).toBeGreaterThan(-1);
    expect(source.indexOf('fixRegulationNumberTypos(session.finalMarkdown)')).toBeGreaterThan(cleansFnIndex);
    const firstCleansCallIndex = source.indexOf('await runSurfaceDeterministicCleans(session);');
    expect(firstCleansCallIndex).toBeGreaterThan(-1);
    expect(firstCleansCallIndex).toBeLessThan(callIndex);
    expect(source.indexOf('await runSurfaceDeterministicCleans(session);', callIndex)).toBeGreaterThan(callIndex);
  });
});

describe('requirement-response-repair 链尾重放（r6 #1/#2：quotation 章级重写吞补写）', () => {
  it('postReviewSurface.ts 在 quotation 收口后 silent 重放补写轮（quotation → 补写重放 → 清洗重放 → toc）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'finalize/repairRounds/postReviewSurface.ts'), 'utf8');
    // r9 链尾收口扩围：applyRequirementTailClosure/requirementResponseBlockers 与重放轮同模块
    // 合并导入后断言从精确 import 形态放宽为「导入行含重放轮符号」（防静默移除的保护意图不变）
    const replayImportLine = source.split('\n').find(line => line.includes("from './requirementResponseRepair'"));
    expect(replayImportLine).toBeDefined();
    expect(replayImportLine).toContain('stageRequirementResponseRepair');
    const quotationIndex = source.indexOf('await stageQuotationBalanceRepair(session);');
    const replayIndex = source.indexOf('await stageRequirementResponseRepair(session, { silent: true });');
    expect(quotationIndex).toBeGreaterThan(-1);
    expect(replayIndex).toBeGreaterThan(quotationIndex);
    const cleansReplayIndex = source.indexOf('await runSurfaceDeterministicCleans(session);', quotationIndex);
    expect(replayIndex).toBeLessThan(cleansReplayIndex);
  });

  it('requirementResponseRepair.ts silent 分支：无残留零成本返回（不写通过记录、首轮记录不被覆盖）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'finalize/repairRounds/requirementResponseRepair.ts'), 'utf8');
    const fnIndex = source.indexOf('export async function stageRequirementResponseRepair(session: FinalizeSession, options?: { silent?: boolean })');
    expect(fnIndex).toBeGreaterThan(-1);
    const cycleOneBlock = source.slice(source.indexOf('if (cycle === 1) {', fnIndex));
    expect(cycleOneBlock).toContain('if (options?.silent) return;');
  });
});

describe('规格错位清单权威链尾收口（r7 #4：终检 spec-location-mismatch 只报不修 → 确定性收口）', () => {
  it('清洗组末块：文号收口之后含规格收口（扫描-硬替换-recompute-双写事件）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'finalize/repairRounds/postReviewSurface.ts'), 'utf8');
    const cleansFnIndex = source.indexOf('async function runSurfaceDeterministicCleans');
    const regulationIndex = source.indexOf('const regulationNumberFix = fixRegulationNumberTypos(session.finalMarkdown)');
    const specIndex = source.indexOf('const specAuthorityMap = session.factsModel?.specAuthorityMap;');
    expect(cleansFnIndex).toBeGreaterThan(-1);
    expect(regulationIndex).toBeGreaterThan(cleansFnIndex);
    expect(specIndex).toBeGreaterThan(regulationIndex);
    const specBlock = source.slice(specIndex);
    expect(specBlock).toContain('scanSpecLocationMismatchHits(session.finalMarkdown, specAuthorityMap)');
    expect(specBlock).toContain('applySpanReplacements(session.finalMarkdown, specReplacements)');
    expect(specBlock).toContain('session.recomputeFinalValidationBundle()');
    expect(specBlock).toContain("'spec-location-mismatch-clean'");
  });
});

describe('quotation-balance-repair 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('全文成对性完好：零成本通过，不进修复轮', async () => {
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: '编制依据：《中华人民共和国建筑法》（主席令第91号公布，2019年修正）。' }]);
    await stageQuotationBalanceRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    expect(session.progressStages).toHaveLength(0);
  });

  it('章级定位残缺 + LLM 补全落地：成对性恢复、rebuild+recompute 复验、终态清零', async () => {
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: DEFECTIVE_LINE }]);
    repairMock.mockResolvedValueOnce(repairResult(REPAIRED_LINE));
    await stageQuotationBalanceRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('引文成对性残缺定向修复');
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('不配对');
    expect(session.finalChapterDrafts[0].content).toBe(REPAIRED_LINE);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-quotation-balance-repair-ch1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('修复完成');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('终态全文不配对 0 对');
  });

  it('删除式修复回滚：汉字数大幅减少即回滚保留原文', async () => {
    const filler = '本项目严格按设计图纸与工程量清单组织施工。'.repeat(12);
    const original = `编制依据：${filler}《中华人民共和国招标投标法（主席令第21号公布`;
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: original }]);
    repairMock.mockResolvedValueOnce(repairResult('编制依据：按现行法规组织施工。'));
    await stageQuotationBalanceRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(session.finalChapterDrafts[0].content).toBe(original);
    const stage = stageOf(session.progressStages, 'agent-quotation-balance-repair-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('成对性恶化回滚：修复后不配对对数上升即回滚', async () => {
    // 修复前仅全角括号 1 对不平衡（书名号平衡）
    const original = '本工程编制依据为《中华人民共和国招标投标法》（主席令第21号公布。';
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: original }]);
    // 修复后全角括号与书名号均不平衡（2 对 > 修复前 1 对）
    repairMock.mockResolvedValueOnce(repairResult('编制依据：《中华人民共和国招标投标法（主席令第21号公布。'));
    await stageQuotationBalanceRepair(session);
    expect(session.finalChapterDrafts[0].content).toBe(original);
    const stage = stageOf(session.progressStages, 'agent-quotation-balance-repair-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('非章区域/跨章抵消：章级计数均平衡时显性记录，不猜测改写', async () => {
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: '编制依据：《中华人民共和国建筑法》（主席令第91号公布，2019年修正）。' }], {
      // 封面区（非章内容）不闭合 → 全文不平衡但章级平衡
      finalMarkdown: '投标文件封面（不闭合\n\n编制依据：《中华人民共和国建筑法》（主席令第91号公布，2019年修正）。',
    });
    await stageQuotationBalanceRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'quotation-balance-repair');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('无定向修复目标');
  });
});
