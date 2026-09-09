/**
 * 确定性修复链注册表顺序锁死单测（第 1 期 P10）：
 * stage5 逐章链与 round-2 全文链的顺序即修复执行顺序，顺序漂移会改变「修复器互相引入
 * 问题」的收敛路径；此处以 key 序列快照锁死两条链的过滤结果。
 */
import { describe, expect, it } from 'vitest';
import { SURFACE_FIX_STEPS, stage5FixSteps, round2FixSteps } from '../../../src/services/document-workflow/deterministicFixChains';

describe('SURFACE_FIX_STEPS 链顺序锁死（P10 单源）', () => {
  it('注册键唯一且无空修复函数', () => {
    const keys = SURFACE_FIX_STEPS.map(step => step.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const step of SURFACE_FIX_STEPS) expect(typeof step.fix).toBe('function');
  });

  it('每条链至少被 stage5 或 round2 消费（无孤儿修复器）', () => {
    for (const step of SURFACE_FIX_STEPS) expect(step.stage5 || step.round2).toBe(true);
  });

  it('stage5 逐章链顺序与原硬编码清单一致', () => {
    expect(stage5FixSteps().map(step => step.key)).toEqual([
      'table-line-residue',
      'repeated-words',
      'finish-thickness',
      'labor-peak',
      'internal-table-row-dup',
      'greening-maintenance',
      'paragraph-opening-repeat',
      'truncated-sentence',
      'meta-discourse',
      'formula-residue',
      'self-undermining',
      'empty-scoring-response',
      'atlas-reference',
    ]);
  });

  it('round-2 全文链顺序与原硬编码清单一致', () => {
    expect(round2FixSteps().map(step => step.key)).toEqual([
      'table-line-residue',
      'repeated-words',
      'duplicate-tables',
      'finish-thickness',
      'labor-peak',
      'internal-table-row-dup',
      'greening-maintenance',
      'paragraph-opening-repeat',
      'truncated-sentence',
      'table-borne-prose',
      'meta-discourse',
      'formula-residue',
      'self-undermining',
      'empty-scoring-response',
      'tertiary-h4-dedupe',
      'internal-term-heading',
    ]);
  });
});
