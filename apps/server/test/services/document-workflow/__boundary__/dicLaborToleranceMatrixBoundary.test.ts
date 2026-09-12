/**
 * 边界矩阵（P1 第 32 批 · PP 组 · resourceConsistencyIssues 模式容差谱系）
 * 断言按无容差新行为推导（工程投标文档不允许模糊数值：不同数值即矛盾）。
 *  - P1 正文峰值互查：不同数值即互斥
 *  - P2 正文 vs 表峰值：正文 > 表峰值即报
 *  - P3 合计行 vs 明细行之和：不一致即报
 *  - P4 总工日推算：> 峰值×工期算术上限即报
 *  - P5 绿化养护期正文比对：不同数值即报（authority=10）
 */
import { describe, expect, it } from 'vitest';
import { greeningMaintenanceMismatchIssues, resourceConsistencyIssues } from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

// ── P1. 正文峰值互查容差 ──

const P1_TABLE: Array<{ x: number; issues: number }> = [
  { x: 100, issues: 0 },
  { x: 101, issues: 1 },
  { x: 119, issues: 1 },
  { x: 120, issues: 1 },
  { x: 121, issues: 1 },
  { x: 79, issues: 1 },
  { x: 80, issues: 1 },
  { x: 81, issues: 1 },
  { x: 200, issues: 1 },
  { x: 50, issues: 1 },
];

describe('P1 劳动力峰值互查：不同数值即互斥', () => {
  it.each(P1_TABLE)('P1 「约100人」vs「约$x人」→ 报 $issues 条', ({ x, issues }) => {
    expect(resourceConsistencyIssues(`高峰期约100人。高峰期约${x}人。`)).toHaveLength(issues);
  });
});

// ── P2. 正文 vs 表峰值（单向+容差） ──

const P2_TABLE: Array<{ x: number; issues: number }> = [
  { x: 100, issues: 0 },
  { x: 101, issues: 0 },
  { x: 119, issues: 0 },
  { x: 120, issues: 0 },
  { x: 121, issues: 0 },
  { x: 79, issues: 1 },
  { x: 80, issues: 1 },
  { x: 81, issues: 1 },
  { x: 200, issues: 0 },
  { x: 50, issues: 1 },
];

describe('P2 正文 vs 表峰值：正文 > 表峰值即报', () => {
  it.each(P2_TABLE)('P2 正文约100人 vs 表「$x」→ 报 $issues 条', ({ x, issues }) => {
    const markdown = `高峰期约100人。\n\n| 阶段 | 人数 |\n|---|---|\n| 施工 | ${x} |`;
    expect(resourceConsistencyIssues(markdown)).toHaveLength(issues);
  });
});

// ── P3. 合计行 vs 明细行之和（差 >10% 报） ──

const P3_TABLE: Array<{ sum: number; issues: number }> = [
  { sum: 90, issues: 1 },
  { sum: 95, issues: 1 },
  { sum: 99, issues: 1 },
  { sum: 100, issues: 0 },
  { sum: 105, issues: 1 },
  { sum: 110, issues: 1 },
  { sum: 120, issues: 1 },
  { sum: 80, issues: 1 },
  { sum: 89, issues: 1 },
  { sum: 111, issues: 1 },
  { sum: 112, issues: 1 },
];

describe('P3 合计行 vs 明细行之和：不一致即报', () => {
  it.each(P3_TABLE)('P3 明细之和 $sum vs 合计 100 → 报 $issues 条', ({ sum, issues }) => {
    const b = Math.floor(sum / 2);
    const a = sum - b;
    const markdown = `| 阶段 | 人数 |\n|---|---|\n| 班组A | ${a} |\n| 班组B | ${b} |\n| 合计 | 100 |`;
    expect(resourceConsistencyIssues(markdown)).toHaveLength(issues);
  });
});

// ── P4. 总工日推算（区间 [900, 9000]，峰值 100×工期 90） ──

const P4_TABLE: Array<{ d: number; issues: number }> = [
  { d: 90, issues: 0 },
  { d: 900, issues: 0 },
  { d: 9000, issues: 0 },
  { d: 8600, issues: 0 },
  { d: 4500, issues: 0 },
  { d: 899, issues: 0 },
  { d: 91, issues: 0 },
  { d: 8100, issues: 0 },
  { d: 8899, issues: 0 },
  { d: 9001, issues: 1 },
  { d: 11699, issues: 1 },
  { d: 11700, issues: 1 },
  { d: 11701, issues: 1 },
];

describe('P4 总工日推算：> 峰值×工期算术上限即报', () => {
  it.each(P4_TABLE)('P4 总工日 $d（峰值100×工期90）→ 报 $issues 条', ({ d, issues }) => {
    const markdown = `高峰期约100人。计划工期90日历天。总工日${d}个工日。`;
    expect(resourceConsistencyIssues(markdown)).toHaveLength(issues);
  });
  it.each(['总', '合计', '总计', '共'])('P4 语境词「%s工日」→ 20000 超上限报 1 条', (word) => {
    expect(resourceConsistencyIssues(`高峰期约100人。计划工期90日历天。${word}工日20000个工日。`)).toHaveLength(1);
  });
});

// ── P5. 绿化养护期正文比对（authority=10，差 >20% 报） ──

const P5_TABLE: Array<{ x: number; issues: number }> = [
  { x: 7, issues: 1 },
  { x: 8, issues: 1 },
  { x: 10, issues: 0 },
  { x: 12, issues: 1 },
  { x: 13, issues: 1 },
  { x: 15, issues: 1 },
];

describe('P5 绿化养护期正文比对：不同数值即报（权威 10 年）', () => {
  it.each(P5_TABLE)('P5 正文「绿化养护期$x年」vs 权威 10 年 → 报 $issues 条', ({ x, issues }) => {
    const facts = factsOf({ bills: [factOf({ key: '喷播植草籽', value: '养护十年' })] });
    expect(greeningMaintenanceMismatchIssues(`绿化养护期${x}年。`, facts)).toHaveLength(issues);
  });
  it('P5 否定声明行豁免：「不再出现绿化养护期15年」→ 0 条', () => {
    const facts = factsOf({ bills: [factOf({ key: '喷播植草籽', value: '养护十年' })] });
    expect(greeningMaintenanceMismatchIssues('不再出现绿化养护期15年。', facts)).toHaveLength(0);
  });
});
