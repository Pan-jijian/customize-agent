/**
 * withPatchRollback 单测（P12 回滚保护泛化）：
 * 1. 基础行为：patch 未落地跳过复检、指标下降不回滚、指标上升默认回滚、beforeMetrics 预设；
 * 2. F2 双指标抵偿语义（shouldRollback 自定义）逐字等价验证；
 * 3. P25 rollbacks 分组统计：回滚计数写入 patchGuardStats[repairRound].rollbacks，与
 *    recordPatchGuardHit 的 hits/rejects 桶共存互不覆盖。
 */
import { describe, expect, it, vi } from 'vitest';
import { withPatchRollback } from '@/services/document-workflow/patchRollback';
import type { DocumentGenerationDiagnostics } from '@/services/document-workflow/types';

function mockDiagnostics(): DocumentGenerationDiagnostics {
  return { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0 } } as unknown as DocumentGenerationDiagnostics;
}

const ORIGINAL = '修复前正文。';
const IMPROVED = '修复后正文（指标下降）。';
const WORSE = '修复后正文（指标上升）。';

describe('withPatchRollback 基础行为', () => {
  it('apply 无产出（返回原文）时跳过复检且不回滚', async () => {
    const recheck = vi.fn((content: string) => [content.length]);
    const outcome = await withPatchRollback({
      originalContent: ORIGINAL,
      repairRound: 'fact-landing',
      apply: async () => ORIGINAL,
      recheck,
    });
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.content).toBe(ORIGINAL);
    expect(outcome.afterMetrics).toEqual(outcome.beforeMetrics);
    expect(recheck).toHaveBeenCalledTimes(1); // 只算 before，apply 无产出跳过 after
  });

  it('修复后指标下降（未落位事实减少）不回滚，返回新内容', async () => {
    const outcome = await withPatchRollback({
      originalContent: ORIGINAL,
      repairRound: 'fact-landing',
      apply: async () => IMPROVED,
      recheck: (content) => [content === ORIGINAL ? 3 : 1],
    });
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.content).toBe(IMPROVED);
    expect(outcome.beforeMetrics).toEqual([3]);
    expect(outcome.afterMetrics).toEqual([1]);
  });

  it('修复后任一指标严格上升即回滚（默认判定），返回原文', async () => {
    const diagnostics = mockDiagnostics();
    const outcome = await withPatchRollback({
      originalContent: ORIGINAL,
      repairRound: 'table-repair',
      diagnostics,
      apply: async () => WORSE,
      recheck: (content) => [content === ORIGINAL ? 1 : 2],
    });
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.content).toBe(ORIGINAL);
    expect(outcome.beforeMetrics).toEqual([1]);
    expect(outcome.afterMetrics).toEqual([2]);
    expect(diagnostics.llm.patchGuardStats?.['table-repair']?.rollbacks).toBe(1);
  });

  it('指标相等不触发回滚（严格上升语义：变差才回滚）', async () => {
    const outcome = await withPatchRollback({
      originalContent: ORIGINAL,
      repairRound: 'planned-section-repair',
      apply: async () => IMPROVED,
      recheck: () => [2],
    });
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.content).toBe(IMPROVED);
  });

  it('beforeMetrics 预设时不重复复检 before', async () => {
    const recheck = vi.fn((content: string) => [content === ORIGINAL ? 5 : 2]);
    const outcome = await withPatchRollback({
      originalContent: ORIGINAL,
      repairRound: 'templating-repair',
      beforeMetrics: [5],
      apply: async () => IMPROVED,
      recheck,
    });
    expect(outcome.rolledBack).toBe(false);
    expect(recheck).toHaveBeenCalledTimes(1); // 只算 after
  });

  it('diagnostics 未传时回滚不抛错', async () => {
    const outcome = await withPatchRollback({
      originalContent: ORIGINAL,
      repairRound: 'workpackage-skeleton-repair',
      apply: async () => WORSE,
      recheck: (content) => [content === ORIGINAL ? 1 : 2],
    });
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.content).toBe(ORIGINAL);
  });
});

describe('F2 双指标抵偿语义（shouldRollback 自定义，与模板化修复判定逐字等价）', () => {
  // F2 判定：fillerWorse = after[0] > before[0] + 0.01 && !difficultyBetter；difficultyBetter = after[1] > before[1] + 0.01
  const f2ShouldRollback = (before: number[], after: number[]) => after[0] > before[0] + 0.01 && !(after[1] > before[1] + 0.01);

  it('套话占比上升 >1% 且重难点未提升 → 回滚', async () => {
    const outcome = await withPatchRollback({
      originalContent: ORIGINAL,
      repairRound: 'templating-repair',
      beforeMetrics: [0.275, 0.5],
      apply: async () => WORSE,
      recheck: () => [0.32, 0.5],
      shouldRollback: f2ShouldRollback,
    });
    expect(outcome.rolledBack).toBe(true);
  });

  it('套话占比上升 >1% 但重难点双达标提升 >1% → 保留修复（抵偿）', async () => {
    const outcome = await withPatchRollback({
      originalContent: ORIGINAL,
      repairRound: 'templating-repair',
      beforeMetrics: [0.275, 0.5],
      apply: async () => IMPROVED,
      recheck: () => [0.29, 0.62],
      shouldRollback: f2ShouldRollback,
    });
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.content).toBe(IMPROVED);
  });

  it('套话占比小幅上升（≤1%）不回滚', async () => {
    const outcome = await withPatchRollback({
      originalContent: ORIGINAL,
      repairRound: 'templating-repair',
      beforeMetrics: [0.275, 0.5],
      apply: async () => IMPROVED,
      recheck: () => [0.28, 0.5],
      shouldRollback: f2ShouldRollback,
    });
    expect(outcome.rolledBack).toBe(false);
  });
});

describe('P25 rollbacks 分组统计', () => {
  it('回滚计数写入 patchGuardStats[repairRound].rollbacks，重复回滚累计', async () => {
    const diagnostics = mockDiagnostics();
    for (let index = 0; index < 2; index += 1) {
      await withPatchRollback({
        originalContent: ORIGINAL,
        repairRound: 'global-consistency-repair',
        diagnostics,
        apply: async () => WORSE,
        recheck: (content) => [content === ORIGINAL ? 1 : 2],
      });
    }
    expect(diagnostics.llm.patchGuardStats?.['global-consistency-repair']?.rollbacks).toBe(2);
  });

  it('与 patchGuard hits/rejects 桶共存互不覆盖（recordPatchGuardHit 初始化同口径）', async () => {
    const diagnostics = mockDiagnostics();
    diagnostics.llm.patchGuardStats = { 'fact-landing': { hits: 3, rejects: 1, rollbacks: 0 } };
    await withPatchRollback({
      originalContent: ORIGINAL,
      repairRound: 'fact-landing',
      diagnostics,
      apply: async () => WORSE,
      recheck: (content) => [content === ORIGINAL ? 1 : 2],
    });
    expect(diagnostics.llm.patchGuardStats?.['fact-landing']).toEqual({ hits: 3, rejects: 1, rollbacks: 1 });
  });

  it('非回滚轮不产生 rollbacks 计数', async () => {
    const diagnostics = mockDiagnostics();
    await withPatchRollback({
      originalContent: ORIGINAL,
      repairRound: 'qingtian-review-repair',
      diagnostics,
      apply: async () => IMPROVED,
      recheck: (content) => [content === ORIGINAL ? 3 : 1],
    });
    expect(diagnostics.llm.patchGuardStats?.['qingtian-review-repair']).toBeUndefined();
  });
});
