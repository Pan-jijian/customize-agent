/**
 * 修复轮次结果三档口径（4.55.27，用户实测归因）：
 * 原判定 `残留===0 ? success : failed` 把三件事混为一谈——实测轨迹
 * `105→54→42`（收敛中）、`63→62→62`（零净下降=真异常）、回滚（保护性）全标 failed，
 * 造成「修复节点第一次就异常」的观感，并淹没了真正的零进展。
 */
import { describe, expect, it } from 'vitest';
import { repairOutcomeReason, repairOutcomeStatus } from '@/services/document-workflow/finalize/repairRounds/repairOutcome';

describe('repairOutcomeStatus 三档判定', () => {
  it('清零 → success（实测 17→0、6→0）', () => {
    expect(repairOutcomeStatus({ before: 17, after: 0 })).toBe('success');
    expect(repairOutcomeStatus({ after: 0 })).toBe('success');
  });

  it('有净下降未清零 → partial（实测 105→54→42 收敛中）', () => {
    expect(repairOutcomeStatus({ before: 105, after: 42, repaired: true })).toBe('partial');
    expect(repairOutcomeStatus({ before: 63, after: 62, repaired: true })).toBe('partial');
  });

  it('零净下降 → failed（实测 1→1、2→2、63→62→62 实为不动）', () => {
    expect(repairOutcomeStatus({ before: 1, after: 1, repaired: false })).toBe('failed');
    expect(repairOutcomeStatus({ before: 2, after: 2 })).toBe('failed');
  });

  it('回滚 → failed（保护性，附原因）', () => {
    expect(repairOutcomeStatus({ before: 5, after: 3, rolledBack: true })).toBe('failed');
    expect(repairOutcomeReason({ before: 5, after: 3, rolledBack: true })).toContain('已回滚');
  });

  it('无轨迹数据时按"是否真改动过正文"判定', () => {
    expect(repairOutcomeStatus({ after: 4, repaired: true })).toBe('partial');
    expect(repairOutcomeStatus({ after: 4, repaired: false })).toBe('failed');
  });

  it('零进展原因显性化（供定位引擎缺陷）', () => {
    expect(repairOutcomeReason({ before: 1, after: 1 })).toContain('零净下降');
    expect(repairOutcomeReason({ before: 5, after: 0 })).toBe('');
  });
});
