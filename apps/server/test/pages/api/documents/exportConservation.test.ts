/**
 * A2 内容守恒断言（批 1）：导出链产出与导出源去标记比对必须逐字一致——
 * 结构操作（补分隔线/列对齐/插空行/相邻表边界截断）与已声明单位改写不构成违约；
 * 任何未声明的正文改写（增删改字）必须被 content-not-conserved 阻断项捕获（observe 采样 / enforce 阻断）。
 */
import { describe, expect, it } from 'vitest';
import { __documentExportTest__ } from '@/pages/api/documents/export';

const { canonicalExportText, exportConservationDiff, prepareExportMarkdown } = __documentExportTest__;

describe('A2 守恒断言：归一化口径', () => {
  it('结构符/空白剥离，单位形态归一（两侧对称）', () => {
    expect(canonicalExportText('## 标题\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('标题ab12');
    expect(canonicalExportText('面积100m2，素土夯实')).toBe('面积100m2，素土夯实');
    expect(canonicalExportText('面积100m²，素土夯实')).toBe('面积100m2，素土夯实');
    expect(canonicalExportText('面积100 m<sup>2</sup>')).toBe('面积100m2');
  });

  it('歧义形态（里程碑 M2 / M2.5 标号）保留原样，不引入单边改写', () => {
    expect(canonicalExportText('卵石灌 M2.5 混合砂浆')).toBe('卵石灌M2.5混合砂浆');
  });

  it('去标记后同源文本必然一致（表格语法差异不构成违约）', () => {
    const diff = exportConservationDiff('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |', '|   甲   | 乙 |\n| --- | --- |\n| 1 | 2 |');
    expect(diff.conserved).toBe(true);
  });
});

describe('A2 守恒断言：导出链端到端', () => {
  it('结构操作与单位改写不构成守恒违约', () => {
    const prepared = prepareExportMarkdown('# 第一章 总则\n\n面积100m2，素土夯实。\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |');
    expect(prepared.audit.blockers.filter(item => item.code === 'content-not-conserved')).toHaveLength(0);
  });

  it('未声明的内容改写（重复标题去重）被捕获', () => {
    const prepared = prepareExportMarkdown('# 第一章 总则\n\n#### 现场条件现场条件\n\n正文。');
    const conservation = prepared.audit.blockers.find(item => item.code === 'content-not-conserved');
    expect(conservation).toBeDefined();
    expect(conservation?.message).toContain('分歧');
  });

  it('observe 下裸表假表头注入构成守恒违约（造内容被断言捕获）', () => {
    const prepared = prepareExportMarkdown('# 第一章 总则\n\n| 甲 | 乙 |\n| 丙 | 丁 |\n\n正文。');
    const codes = prepared.audit.blockers.map(item => item.code);
    expect(codes).toContain('bare-table');
    expect(codes).toContain('content-not-conserved');
  });

  it('exportConservationDiff 报告首个分歧位置与上下文', () => {
    const diff = exportConservationDiff('甲方要求工期为90天。', '甲方要求工期为120天。');
    expect(diff.conserved).toBe(false);
    if (!diff.conserved) {
      expect(diff.sourceContext).toContain('工期为');
      expect(diff.productContext).toContain('工期为');
    }
  });
});
