/**
 * selection 单测：评分选择器（不静默丢弃 + 丢弃日志）与文本/事实重要性评分口径。
 */
import { describe, expect, it } from 'vitest';
import { factImportanceScore, selectByScore, textImportanceScore } from '@/services/document-workflow/selection';

describe('selectByScore', () => {
  it('按分数降序选择并遵守 maxItems 预算', () => {
    const { selected, dropped } = selectByScore(
      [{ id: 'a', v: 1 }, { id: 'b', v: 3 }, { id: 'c', v: 2 }],
      item => item.v,
      { maxItems: 2 },
    );
    expect(selected.map(item => item.id)).toEqual(['b', 'c']);
    expect(dropped.map(item => item.id)).toEqual(['a']);
  });

  it('遵守 maxChars + charFn 预算', () => {
    const { selected, dropped } = selectByScore(['aaa', 'bb'], () => 1, { maxChars: 4, charFn: item => item.length });
    expect(selected).toEqual(['aaa']);
    expect(dropped).toEqual(['bb']);
  });

  it('未丢弃时不产生丢弃日志', () => {
    const { dropped, droppedLog } = selectByScore([1, 2], () => 1, { maxItems: 5 });
    expect(dropped).toHaveLength(0);
    expect(droppedLog).toHaveLength(0);
  });

  it('丢弃时记录日志与摘要（超 10 项只列前 10）', () => {
    const items = Array.from({ length: 15 }, (_, index) => `item-${index}`);
    const { droppedLog } = selectByScore(items, () => 1, { maxItems: 3 }, '候选证据');
    expect(droppedLog[0]).toContain('[selection] 候选证据');
    expect(droppedLog[0]).toContain('丢弃 12项');
    expect(droppedLog).toHaveLength(12);
    expect(droppedLog.at(-1)).toContain('及其他 2 项');
  });
});

describe('textImportanceScore', () => {
  it('数值/单位/标准/关键术语/来源标题加权', () => {
    // 3 处数值 *3 + 日历天 +2 + GB +3 + 工期术语 +1 + 计划工期 +2 = 17，长度 ≥20 不减分
    expect(textImportanceScore('C30混凝土强度，执行GB50204，工期300日历天，计划工期详下表')).toBe(17);
  });

  it('短文本减 1 分', () => {
    expect(textImportanceScore('施工')).toBe(0);
  });

  it('空文本 0 分', () => {
    expect(textImportanceScore('')).toBe(0);
  });
});

describe('factImportanceScore', () => {
  it('必需 + 数值 + 基础字段 + 单位加权', () => {
    // required 10 + 数值 5 + 计划工期 4 + 日历天 3 = 22
    expect(factImportanceScore({ key: '计划工期', value: '300日历天', required: true })).toBe(22);
  });

  it('招标来源与货币单位加权', () => {
    // 数值 5 + 万元 3 + 招标文件 2 = 10
    expect(factImportanceScore({ fieldName: '金额', value: '5000万元', fieldId: '招标文件附件1' })).toBe(10);
  });

  it('空事实 0 分', () => {
    expect(factImportanceScore({})).toBe(0);
  });
});
