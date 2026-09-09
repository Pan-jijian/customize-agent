import { describe, expect, it } from 'vitest';
import { analyzeDefectHeatmap, buildWritingConstraintsReminder, DEFECT_HEATMAP_WINDOW, REPAIR_ROUND_LABELS, WRITING_CONSTRAINTS_REMINDER_MAX_CHARS } from '@/services/document-workflow/defectHeatmap';
import type { RepairHeatHistoryEntry } from '@/services/document-workflow/defectHeatmap';

/** 快速构造一份带修复轮热力的历史条目 */
function entry(exportedAt: number, heat: Record<string, { hits: number; repaired: number; failed: number }>): RepairHeatHistoryEntry {
  return { exportedAt, repairHeat: heat };
}

/** 构造连续 n 份同形态条目（时间递增） */
function series(n: number, heat: Record<string, { hits: number; repaired: number; failed: number }>, startAt = 1000): RepairHeatHistoryEntry[] {
  return Array.from({ length: n }, (_unused, index) => entry(startAt + index * 1000, heat));
}

describe('analyzeDefectHeatmap（P19 跨文档缺陷热力图）', () => {
  it('历史不足窗口长度：不产出任何建议', () => {
    const result = analyzeDefectHeatmap(series(DEFECT_HEATMAP_WINDOW - 1, { 'table-repair': { hits: 0, repaired: 0, failed: 0 } }));
    expect(result.retireCandidates).toEqual([]);
    expect(result.constraintSuggestions).toEqual([]);
  });

  it('连续窗口零命中且更早历史曾命中：候选退役', () => {
    const history = [
      ...series(2, { 'table-repair': { hits: 3, repaired: 3, failed: 0 } }, 0),
      ...series(DEFECT_HEATMAP_WINDOW, { 'table-repair': { hits: 0, repaired: 0, failed: 0 } }, 5000),
    ];
    const result = analyzeDefectHeatmap(history);
    expect(result.retireCandidates).toEqual(['table-repair']);
    expect(result.constraintSuggestions).toEqual([]);
  });

  it('连续窗口零命中但更早历史从未命中：不误报退役', () => {
    const history = series(DEFECT_HEATMAP_WINDOW, { 'table-repair': { hits: 0, repaired: 0, failed: 0 } });
    expect(analyzeDefectHeatmap(history).retireCandidates).toEqual([]);
  });

  it('窗口内该轮缺失观测：不视为零命中，不触发退役', () => {
    const history = [
      entry(0, { 'table-repair': { hits: 2, repaired: 2, failed: 0 } }),
      entry(1000, { 'table-repair': { hits: 0, repaired: 0, failed: 0 } }),
      entry(2000, {}),
      entry(3000, { 'table-repair': { hits: 0, repaired: 0, failed: 0 } }),
    ];
    expect(analyzeDefectHeatmap(history).retireCandidates).toEqual([]);
  });

  it('连续窗口高命中且失败率≥50%：建议加入写作硬约束', () => {
    const history = series(DEFECT_HEATMAP_WINDOW, { 'fact-landing': { hits: 4, repaired: 2, failed: 2 } });
    const result = analyzeDefectHeatmap(history);
    expect(result.constraintSuggestions).toEqual([`fact-landing｜50%｜连续${DEFECT_HEATMAP_WINDOW}次`]);
    expect(result.retireCandidates).toEqual([]);
  });

  it('失败率低于 50%：不建议', () => {
    const history = series(DEFECT_HEATMAP_WINDOW, { 'fact-landing': { hits: 10, repaired: 9, failed: 1 } });
    expect(analyzeDefectHeatmap(history).constraintSuggestions).toEqual([]);
  });

  it('历史乱序输入：按 exportedAt 排序后窗口判定一致', () => {
    const ordered = [
      ...series(2, { 'table-repair': { hits: 3, repaired: 3, failed: 0 } }, 0),
      ...series(DEFECT_HEATMAP_WINDOW, { 'table-repair': { hits: 0, repaired: 0, failed: 0 } }, 5000),
    ];
    const shuffled = [...ordered].reverse();
    expect(analyzeDefectHeatmap(shuffled).retireCandidates).toEqual(['table-repair']);
  });

  it('多轮混合信号：退役与建议并行产出', () => {
    const history = [
      entry(0, { 'round-a': { hits: 5, repaired: 5, failed: 0 }, 'round-b': { hits: 2, repaired: 1, failed: 1 } }),
      entry(1000, { 'round-a': { hits: 0, repaired: 0, failed: 0 }, 'round-b': { hits: 2, repaired: 1, failed: 1 } }),
      entry(2000, { 'round-a': { hits: 0, repaired: 0, failed: 0 }, 'round-b': { hits: 4, repaired: 1, failed: 3 } }),
      entry(3000, { 'round-a': { hits: 0, repaired: 0, failed: 0 }, 'round-b': { hits: 4, repaired: 1, failed: 3 } }),
    ];
    const result = analyzeDefectHeatmap(history);
    expect(result.retireCandidates).toEqual(['round-a']);
    expect(result.constraintSuggestions).toEqual([`round-b｜67%｜连续${DEFECT_HEATMAP_WINDOW}次`]);
  });
});

describe('buildWritingConstraintsReminder（P19 受限版自进化提醒）', () => {
  it('无建议：返回空字符串（不注入）', () => {
    expect(buildWritingConstraintsReminder([])).toBe('');
  });

  it('短建议：轮次 id 映射为人类可读缺陷类别（LLM 可执行）', () => {
    const reminder = buildWritingConstraintsReminder(['table-repair-round｜50%｜连续3次']);
    expect(reminder).toContain('缺陷热力图自进化提醒');
    expect(reminder).toContain(REPAIR_ROUND_LABELS['table-repair-round']);
    expect(reminder).toContain('（历史修复失败率 50%）');
    expect(reminder).not.toContain('table-repair-round');
    expect(reminder.length).toBeLessThanOrEqual(WRITING_CONSTRAINTS_REMINDER_MAX_CHARS);
  });

  it('未知轮次 id：保留原 id 不丢失信息', () => {
    const reminder = buildWritingConstraintsReminder(['unknown-round-x｜50%｜连续3次']);
    expect(reminder).toContain('unknown-round-x');
  });

  it('超长建议：截断至 ≤300 字符且保留前缀', () => {
    const many = Array.from({ length: 30 }, (_unused, index) => `round-${index}｜60%｜连续3次`);
    const reminder = buildWritingConstraintsReminder(many);
    expect(reminder.length).toBeLessThanOrEqual(WRITING_CONSTRAINTS_REMINDER_MAX_CHARS);
    expect(reminder).toContain('缺陷热力图自进化提醒');
  });
});
