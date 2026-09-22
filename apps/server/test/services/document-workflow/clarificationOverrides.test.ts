/**
 * 答疑澄清生效层单测（4.55.17）：样本逐字取自巢湖真实自测的事实值与答疑证据。
 */
import { describe, expect, it } from 'vitest';
import { extractClarificationOverrides, isClarificationSource, renderClarificationConstraintBlock } from '@/services/document-workflow/clarificationOverrides';

const 答疑来源 = '巢湖项目/答疑文件/7招标答疑文件（电子签章版）.pdf';
const 招标来源 = '巢湖项目/招标文件.pdf';

describe('extractClarificationOverrides（巢湖真值）', () => {
  it('变更句式：「365日历天，现变更修改为:330日历天」→ 工期生效 330，取代 365', () => {
    const overrides = extractClarificationOverrides([{ text: '365日历天，现变更修改为:330日历天', source: 答疑来源 }]);
    const duration = overrides.find(item => item.field === '计划工期');
    expect(duration?.effective).toBe('330日历天');
    expect(duration?.superseded).toContain('365日历天');
  });

  it('全角冒号与无冒号变体同样命中', () => {
    for (const text of ['365日历天，现变更修改为：330日历天', '本次招标项目计划工期于2026年08月05日变更修改为330日历天。']) {
      expect(extractClarificationOverrides([{ text, source: 答疑来源 }]).find(item => item.field === '计划工期')?.effective).toBe('330日历天');
    }
  });

  it('「见招标公告…」是指向招标文本的旧口径，不得当答疑值（巢湖实锤）', () => {
    const overrides = extractClarificationOverrides([
      { text: '见招标公告计划开工日期：2026年08月31日（具体开工日期以招标人出具的书面开工通知为准）', source: 答疑来源 },
      { text: '现澄清为如下：条款号条款号条款名称条款名称编列内容编列内容1.3.2计划工期计划开工日期：2026年10月10日（具体开工日期以', source: 答疑来源 },
    ]);
    const startDate = overrides.find(item => item.field === '开工日期');
    expect(startDate?.effective).toBe('2026年10月10日');
    expect(startDate?.superseded).toContain('2026年08月31日');
  });

  it('无变更时静默（不产出 override，零误伤）', () => {
    expect(extractClarificationOverrides([{ text: '本工程计划工期330日历天。', source: 招标来源 }])).toEqual([]);
  });
});

describe('renderClarificationConstraintBlock（写作硬约束块）', () => {
  it('产出「现行唯一口径 + 被取代值不得作为现行表述」约束', () => {
    const block = renderClarificationConstraintBlock([
      { field: '计划工期', effective: '330日历天', superseded: ['365日历天'], source: 答疑来源 },
      { field: '开工日期', effective: '2026年10月10日', superseded: ['2026年08月31日'], source: 答疑来源 },
    ]);
    expect(block).toContain('答疑澄清生效口径');
    expect(block).toContain('330日历天');
    expect(block).toContain('365日历天');
    expect(block).toContain('2026年10月10日');
  });

  it('无被取代值时不出块（无变更项目零注入）', () => {
    expect(renderClarificationConstraintBlock([{ field: '计划工期', effective: '330日历天', superseded: [], source: 'x' }])).toBe('');
  });
});

describe('isClarificationSource', () => {
  it('答疑/澄清/补疑/补遗类路径命中，招标文件不命中', () => {
    expect(isClarificationSource(答疑来源)).toBe(true);
    expect(isClarificationSource('项目/补遗书.pdf')).toBe(true);
    expect(isClarificationSource(招标来源)).toBe(false);
  });
});
