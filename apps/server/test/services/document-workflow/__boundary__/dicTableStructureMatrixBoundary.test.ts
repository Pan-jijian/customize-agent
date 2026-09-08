/**
 * 边界矩阵（P1 第 32 批 · QQ 组 · 表格结构/合计词/混凝土部位分组谱系）
 * 断言按探测锁定的真实行为推导。
 *  - Q1 表头×分隔行 12 组合 × tablePeakLabor（无空格表头可识别、人员列不识别、无分隔行不识别）
 *  - Q2 合计行词谱系（合计/总计/小计 均触发模式 4）
 *  - Q3 混凝土部位分组（F14）：不同部位合法、同部位冲突、同句枚举豁免、跨工序豁免
 *  - Q4 数据行形态变体（20人/约20人/20 人 单元格）
 */
import { describe, expect, it } from 'vitest';
import { crossSectionNumericConflictIssues, resourceConsistencyIssues, tablePeakLabor } from '@/services/document-workflow/documentIntegrityChecks';

// ── Q1. 表头 × 分隔行组合 × tablePeakLabor ──

const Q1_TABLE: Array<{ header: string; sep: string; peak: number | 'undef' }> = [
  { header: '| 阶段 | 人数 |', sep: '|---|---|', peak: 20 },
  { header: '| 阶段 | 人数 |', sep: '| --- | --- |', peak: 20 },
  { header: '| 阶段 | 人数 |', sep: '', peak: 'undef' },
  { header: '|阶段|人数|', sep: '|---|---|', peak: 20 },
  { header: '|阶段|人数|', sep: '| --- | --- |', peak: 20 },
  { header: '|阶段|人数|', sep: '', peak: 'undef' },
  { header: '| 阶段 | 人员 |', sep: '|---|---|', peak: 'undef' },
  { header: '| 阶段 | 人员 |', sep: '| --- | --- |', peak: 'undef' },
  { header: '| 阶段 | 人员 |', sep: '', peak: 'undef' },
  { header: '| 序号 | 内容 |', sep: '|---|---|', peak: 'undef' },
  { header: '| 序号 | 内容 |', sep: '| --- | --- |', peak: 'undef' },
  { header: '| 序号 | 内容 |', sep: '', peak: 'undef' },
];

describe('Q1 劳动力表识别：表头×分隔行组合', () => {
  it.each(Q1_TABLE)('Q1 表头「$header」分隔「$sep」→ $peak', ({ header, sep, peak }) => {
    const markdown = [header, sep, '| 施工 | 20 |'].filter(Boolean).join('\n');
    if (peak === 'undef') {
      expect(tablePeakLabor(markdown)).toBeUndefined();
    } else {
      expect(tablePeakLabor(markdown)).toBe(peak);
    }
  });
});

// ── Q2. 合计行词谱系 ──

describe('Q2 劳动力合计行：封闭词谱系', () => {
  it.each(['合计', '总计', '小计'])('Q2 「%s」行 100 vs 明细之和 70 → 差>10% 报 1 条', (word) => {
    const markdown = `| 阶段 | 人数 |\n|---|---|\n| 班组A | 40 |\n| 班组B | 30 |\n| ${word} | 100 |`;
    expect(resourceConsistencyIssues(markdown)).toHaveLength(1);
  });
});

// ── Q3. 混凝土部位分组（F14） ──

describe('Q3 混凝土强度部位分组（F14）', () => {
  it('Q3 不同部位不同标号 → 合法口径 → 0 条', () => {
    expect(crossSectionNumericConflictIssues('垫层采用C15混凝土。主体采用C35混凝土。')).toHaveLength(0);
  });
  it('Q3 同部位两标号 → 互斥 → 报 1 条', () => {
    expect(crossSectionNumericConflictIssues('垫层采用C15混凝土。垫层采用C30混凝土。')).toHaveLength(1);
  });
  it('Q3 同部位同标号 → 一致 → 0 条', () => {
    expect(crossSectionNumericConflictIssues('垫层采用C15混凝土。垫层采用C15混凝土。')).toHaveLength(0);
  });
  it('Q3 同句并列枚举「C30/C35」→ 正常枚举 → 0 条', () => {
    expect(crossSectionNumericConflictIssues('混凝土强度等级C30/C35。')).toHaveLength(0);
  });
  it('Q3 跨工序切换「再浇筑C30」→ 后续构件豁免 → 0 条', () => {
    expect(crossSectionNumericConflictIssues('垫层采用C15混凝土，再浇筑C30混凝土。')).toHaveLength(0);
  });
});

// ── Q4. 数据行形态变体（探测锁定） ──

describe('Q4 劳动力表数据行形态', () => {
  it.each([
    ['| 施工 | 20人 |', 20],
    ['| 施工 | 约20人 |', undefined],
    ['| 施工 | 20 人 |', 20],
    ['| 施工 | 20 |', 20],
  ] as Array<[string, number | undefined]>)('Q4 数据行「%s」→ %s', (row, peak) => {
    const markdown = `| 阶段 | 人数 |\n|---|---|\n${row}`;
    if (peak === undefined) {
      expect(tablePeakLabor(markdown)).toBeUndefined();
    } else {
      expect(tablePeakLabor(markdown)).toBe(peak);
    }
  });
});
