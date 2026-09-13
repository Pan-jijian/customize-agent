/**
 * 批 1 A4/A5 源层卫生测试：
 * - A4 规格书写统一器：数字间乘号（x、X、半角星号、全角形态）全部归一为 ×，白名单防误伤（字母语境 X 不归一）；
 * - A5a 表块间距规范化：sanitizeFormalMarkdown 链尾保证表格块与相邻内容恰好一个空行（幂等、守恒）；
 * - A5b 表编号体系检查：全文档级「表N」引用必须命中实体 + 实体编号唯一，歧义形态（计量表1块/意见表1份）不误报。
 */
import { describe, expect, it } from 'vitest';
import { normalizeProductionText, sanitizeFormalMarkdown } from '@/services/document-workflow/markdownComposer';
import { scanTableNumberingDefects, structureIntegrityIssues } from '@/services/document-workflow/structureIntegrityRules';

describe('A4 规格书写统一器（数字间乘号归一）', () => {
  it('数字间乘号形态（x/X/*/带空白/全角）全部归一为 ×', () => {
    expect(normalizeProductionText('网格400*400')).toBe('网格400×400');
    expect(normalizeProductionText('格栅1X22')).toBe('格栅1×22');
    expect(normalizeProductionText('板258x16')).toBe('板258×16');
    expect(normalizeProductionText('规格3 X 2')).toBe('规格3×2');
    expect(normalizeProductionText('600x600mm')).toBe('600×600mm');
    expect(normalizeProductionText('螺栓M10x100')).toBe('螺栓M10×100');
    expect(normalizeProductionText('3ｘ3')).toBe('3×3');
    expect(normalizeProductionText('40*4角钢')).toBe('40×4角钢');
  });

  it('白名单防误伤：字母语境 X / 行首 X / 汉字后缀不归一', () => {
    expect(normalizeProductionText('X射线机2台')).toBe('X射线机2台');
    expect(normalizeProductionText('沿X轴向布置')).toBe('沿X轴向布置');
    expect(normalizeProductionText('型号AX100')).toBe('型号AX100');
    expect(normalizeProductionText('SX2型套筒')).toBe('SX2型套筒');
  });

  it('归一幂等且与既有 × 紧凑化兼容', () => {
    expect(normalizeProductionText('600 × 600')).toBe('600×600');
    expect(normalizeProductionText(normalizeProductionText('400*400'))).toBe('400×400');
  });
});

describe('A5a 表块间距规范化（sanitizeFormalMarkdown 链尾）', () => {
  it('表格块与相邻内容之间规范为恰好一个空行（幂等）', () => {
    const input = '正文说明。\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n后续说明。';
    const once = sanitizeFormalMarkdown(input);
    expect(once).toContain('正文说明。\n\n| 列A | 列B |');
    expect(once).toContain('| 1 | 2 |\n\n后续说明。');
    expect(sanitizeFormalMarkdown(once)).toBe(once);
  });

  it('单行管道文本不作为表块（不插空行）', () => {
    const once = sanitizeFormalMarkdown('前文。\n| 单行说明\n后文。');
    expect(once).toContain('前文。\n| 单行说明\n后文。');
  });
});

describe('A5b 表编号体系检查（全文档级）', () => {
  const entity = '表1 道路结构层控制表\n| 项目 | 标准 |\n| --- | --- |\n| 压实度 | 96% |';

  it('引用命中实体：无缺陷', () => {
    expect(scanTableNumberingDefects(`施工参数按表1统一执行。\n\n${entity}`)).toEqual([]);
  });

  it('引用无实体：orphan-reference blocker', () => {
    const defects = scanTableNumberingDefects(`施工参数按表2统一执行。\n\n${entity}`);
    expect(defects).toHaveLength(1);
    expect(defects[0].kind).toBe('table-number-orphan-reference');
    expect(defects[0].message).toContain('表2');
  });

  it('实体编号重复：duplicate blocker', () => {
    const md = '表1 甲表\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n表1 乙表\n| C | D |\n| --- | --- |\n| 3 | 4 |';
    const defects = scanTableNumberingDefects(md);
    expect(defects.some(item => item.kind === 'table-number-duplicate')).toBe(true);
  });

  it('歧义形态不误报：计量表1块 / 意见表1份 / 表1中规定正文句', () => {
    const md = '计量表1块，漏电保护器1个。\n\n意见表1份随案提交。\n\n表1中规定了各项指标，均已明确。';
    expect(scanTableNumberingDefects(md)).toEqual([]);
  });

  it('「见」词首引用形态检出（（见表1））', () => {
    const defects = scanTableNumberingDefects('施工要求（见表1）执行。');
    expect(defects.some(item => item.kind === 'table-number-orphan-reference')).toBe(true);
  });

  it('structureIntegrityIssues 终检合并表编号缺陷（全文档级专属）', () => {
    const issues = structureIntegrityIssues('# 第一章 总则\n\n各项参数按表3执行。');
    expect(issues.some(issue => issue.message.includes('表3') && issue.suggestion.includes('一一对应'))).toBe(true);
  });
});
