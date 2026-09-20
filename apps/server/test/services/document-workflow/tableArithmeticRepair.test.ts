/**
 * repairRounds · 表内算术自洽修复轮（table-arithmetic-repair）：
 * C4 实机归因——资源/劳动力类表格「合计」与分项之和对不上（表5-2 型），
 * 终检 table-arithmetic-consistency blocker 此前无修复轮消费。本测试锁定：
 * 1. 接线：注册表双登记（FINALIZE 链尾声明 + LLM_PATCH 锚定 table-arithmetic-consistency）
 *    + documentPipeline 调用位置（table-caption-repair 之后、链尾 markdown-only 重放之前）；
 * 2. 行为矩阵：全文自洽零成本通过 / 章级定位 + LLM 定向修复落地（残留清零 + rebuild + recompute）/
 *    多轮收敛（部分下降继续、每章上限 2 轮）/ 未下降回滚（保留修复前正文 + patchGuard 回滚记账）/
 *    模型未产生有效修改显性记录 / 仅不自洽章进修复；
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
import { FINALIZE_REPAIR_ROUNDS, LLM_PATCH_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import { stageTableArithmeticRepair } from '@/services/document-workflow/finalize/repairRounds/tableArithmeticRepair';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const repairMock = vi.mocked(repairChapterByQuality);
const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 自洽表（横向 100+62=162、80+40=120）：修复轮零成本通过形态 */
const CONSISTENT_CONTENT = [
  '## 劳动力投入计划',
  '本工程劳动力按工种分班组投入，各班组人数如下表所示。',
  '| 工种 | 班组一（人） | 班组二（人） | 合计（人） |',
  '| --- | --- | --- | --- |',
  '| 钢筋工 | 100 | 62 | 162 |',
  '| 木工 | 80 | 40 | 120 |',
].join('\n');

/** 不自洽表（106+56=162 ≠ 合计 262）：1 处缺陷（表5-2 型） */
const DEFECTIVE_CONTENT = [
  '## 劳动力投入计划',
  '| 工种 | 班组一（人） | 班组二（人） | 合计（人） |',
  '| --- | --- | --- | --- |',
  '| 钢筋工 | 106 | 56 | 262 |',
].join('\n');

/** 修复后自洽（以分项重算合计 162） */
const REPAIRED_CONTENT = [
  '## 劳动力投入计划',
  '| 工种 | 班组一（人） | 班组二（人） | 合计（人） |',
  '| --- | --- | --- | --- |',
  '| 钢筋工 | 106 | 56 | 162 |',
].join('\n');

/** 「改了但没修好」形态（合计格 262→999，仍不自洽）：触发回滚 */
const WORSE_CONTENT = [
  '## 劳动力投入计划',
  '| 工种 | 班组一（人） | 班组二（人） | 合计（人） |',
  '| --- | --- | --- | --- |',
  '| 钢筋工 | 106 | 56 | 999 |',
].join('\n');

/** 两处缺陷（262 错 + 220 错）：多轮收敛场景起点 */
const MULTI_DEFECTIVE_CONTENT = [
  '## 劳动力投入计划',
  '| 工种 | 班组一（人） | 班组二（人） | 合计（人） |',
  '| --- | --- | --- | --- |',
  '| 钢筋工 | 106 | 56 | 262 |',
  '| 木工 | 80 | 40 | 220 |',
].join('\n');

/** 第一轮后：钢筋工修好、木工仍错（残留 1 处）→ 驱动第二轮 */
const PARTIALLY_REPAIRED_CONTENT = [
  '## 劳动力投入计划',
  '| 工种 | 班组一（人） | 班组二（人） | 合计（人） |',
  '| --- | --- | --- | --- |',
  '| 钢筋工 | 106 | 56 | 162 |',
  '| 木工 | 80 | 40 | 999 |',
].join('\n');

/** 第二轮后全部自洽（残留 0 处） */
const FULLY_REPAIRED_CONTENT = [
  '## 劳动力投入计划',
  '| 工种 | 班组一（人） | 班组二（人） | 合计（人） |',
  '| --- | --- | --- | --- |',
  '| 钢筋工 | 106 | 56 | 162 |',
  '| 木工 | 80 | 40 | 120 |',
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

describe('table-arithmetic-repair 接线（防「修复器存在但未接线」回归）', () => {
  it('注册表双登记：FINALIZE 链尾声明 + LLM_PATCH 锚定 table-arithmetic-consistency', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const index = rounds.indexOf('table-arithmetic-repair');
    expect(index).toBeGreaterThan(-1);
    expect(rounds.indexOf('table-caption-repair')).toBeLessThan(index);
    const llmRound = LLM_PATCH_REPAIR_ROUNDS.find(entry => entry.id === 'table-arithmetic-repair');
    expect(llmRound?.kind).toBe('llm-patch');
    expect(llmRound?.anchoredTo).toBe('table-arithmetic-consistency');
  });

  it('documentPipeline.ts 在 table-caption-repair 之后、链尾 markdown-only 重放之前调用', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const captionIndex = source.indexOf('await stageTableCaptionRepair(session);');
    const arithmeticIndex = source.indexOf('await stageTableArithmeticRepair(session);');
    const replayIndex = source.indexOf('await runSurfaceDeterministicCleans(session);');
    expect(captionIndex).toBeGreaterThan(-1);
    expect(arithmeticIndex).toBeGreaterThan(captionIndex);
    expect(replayIndex).toBeGreaterThan(arithmeticIndex);
  });
});

describe('table-arithmetic-repair 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('全文算术自洽：零成本通过，不进修复轮', async () => {
    const session = makeSession([{ id: 'ch1', title: '劳动力投入计划', content: CONSISTENT_CONTENT }]);
    await stageTableArithmeticRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'table-arithmetic-repair');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('表内算术自洽核对通过');
  });

  it('章级定位 + LLM 定向修复落地：残留清零、rebuild+recompute 复验、双写 success', async () => {
    const session = makeSession([{ id: 'ch1', title: '劳动力投入计划', content: DEFECTIVE_CONTENT }]);
    repairMock.mockResolvedValueOnce(repairResult(REPAIRED_CONTENT));
    await stageTableArithmeticRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const call = repairMock.mock.calls[0][0];
    expect(call.chapter.id).toBe('ch1');
    expect(call.promptTexts).toContain('表格算术自洽修复');
    expect(call.issues[0]).toContain('生成后事实反查失败');
    expect(session.finalChapterDrafts[0].content).toBe(REPAIRED_CONTENT);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-table-arithmetic-ch1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('修复完成');
    expect(stageOf(session.finalGateRepairStages, 'agent-table-arithmetic-ch1')?.status).toBe('success');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('残留 0 处');
  });

  it('多轮收敛：第一轮部分下降继续、第二轮清零（每章上限 2 轮）', async () => {
    const session = makeSession([{ id: 'ch1', title: '劳动力投入计划', content: MULTI_DEFECTIVE_CONTENT }]);
    repairMock
      .mockResolvedValueOnce(repairResult(PARTIALLY_REPAIRED_CONTENT))
      .mockResolvedValueOnce(repairResult(FULLY_REPAIRED_CONTENT));
    await stageTableArithmeticRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(2);
    expect(repairMock.mock.calls[1][0].promptTexts).toContain('上一轮修复后仍有残留');
    expect(session.finalChapterDrafts[0].content).toBe(FULLY_REPAIRED_CONTENT);
    const stage = stageOf(session.progressStages, 'agent-table-arithmetic-ch1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('残留轨迹 2→1→0');
  });

  it('修复未下降即回滚：保留修复前正文 + patchGuard 回滚记账', async () => {
    const session = makeSession([{ id: 'ch1', title: '劳动力投入计划', content: DEFECTIVE_CONTENT }]);
    repairMock.mockResolvedValueOnce(repairResult(WORSE_CONTENT));
    await stageTableArithmeticRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(session.finalChapterDrafts[0].content).toBe(DEFECTIVE_CONTENT);
    const stage = stageOf(session.progressStages, 'agent-table-arithmetic-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
    expect(session.generationDiagnostics.llm.patchGuardStats?.['table-arithmetic-repair']?.rollbacks).toBe(1);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
  });

  it('模型未产生有效修改：显性「未生效」记录，不改正文', async () => {
    const session = makeSession([{ id: 'ch1', title: '劳动力投入计划', content: DEFECTIVE_CONTENT }]);
    repairMock.mockResolvedValueOnce(repairResult(DEFECTIVE_CONTENT));
    await stageTableArithmeticRepair(session);
    expect(session.finalChapterDrafts[0].content).toBe(DEFECTIVE_CONTENT);
    const stage = stageOf(session.progressStages, 'agent-table-arithmetic-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('未生效');
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
  });

  it('章级定位：仅不自洽章进修复，自洽章不受影响', async () => {
    const session = makeSession([
      { id: 'ch1', title: '施工部署', content: CONSISTENT_CONTENT },
      { id: 'ch2', title: '劳动力投入计划', content: DEFECTIVE_CONTENT },
    ]);
    repairMock.mockResolvedValueOnce(repairResult(REPAIRED_CONTENT));
    await stageTableArithmeticRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(repairMock.mock.calls[0][0].chapter.id).toBe('ch2');
    expect(session.finalChapterDrafts[0].content).toBe(CONSISTENT_CONTENT);
    expect(session.finalChapterDrafts[1].content).toBe(REPAIRED_CONTENT);
  });
});
