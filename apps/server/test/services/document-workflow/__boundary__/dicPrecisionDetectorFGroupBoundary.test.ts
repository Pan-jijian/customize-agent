/**
 * 第十三批边界矩阵（R 组）：F 组检测链补盲（丰乐镇第 3 轮根治）。
 * 覆盖：同工种跨表高峰人数比对（R1-R3）、用水高峰人数 vs 劳动力峰值关联（R4-R6）、
 * 元话语声明句检测与清洗（R7-R9）、公式形态残留检测与清洗（R10-R13）。
 * 原则：每条用例独立断言意义；真实实现行为一律锁定，不迎合用例改实现。
 */
import { describe, expect, it } from 'vitest';
import {
  fixFormulaResidues,
  fixMetaDiscourseDeclarations,
  formulaResidueIssues,
  laborPeakConflictIssues,
  metaDiscourseDeclarationIssues,
  waterLaborPeakAssociationIssues,
} from '@/services/document-workflow/documentIntegrityChecks';

/** 分工种人数表（hasTradeCol：表头「工种」+「人数」） */
function tradeTable(rows: Array<[string, string]>): string {
  const lines = ['| 工种 | 人数 |', '| --- | --- |'];
  for (const [trade, count] of rows) lines.push(`| ${trade} | ${count} |`);
  return lines.join('\n');
}

describe('R1 同工种跨表高峰人数比对（电工 40 vs 4 → error）', () => {
  it('两表同工种电工差异 >20% → error', () => {
    const md = `${tradeTable([['电工', '40'], ['管道工', '12']])}\n\n${tradeTable([['电工', '4'], ['管道工', '12']])}`;
    const issues = laborPeakConflictIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('同工种跨表高峰人数矛盾');
    expect(issues[0]?.message).toContain('电工');
  });
});

describe('R2 分阶段表内多行同工种（合法动态配置）', () => {
  it('单表同工种分阶段多行取表内 max，不报跨表矛盾', () => {
    const md = [
      '| 施工阶段 | 工种 | 人数 |',
      '| --- | --- | --- |',
      '| 施工准备 | 电工 | 2 |',
      '| 主体施工 | 电工 | 4 |',
    ].join('\n');
    expect(laborPeakConflictIssues(md)).toEqual([]);
  });
});

describe('R3 跨表同工种一致（不报）', () => {
  it('两表电工均为 4 → 零 error', () => {
    const md = `${tradeTable([['电工', '4'], ['管道工', '12']])}\n\n${tradeTable([['电工', '4'], ['管道工', '12']])}`;
    expect(laborPeakConflictIssues(md)).toEqual([]);
  });
});

describe('R4 用水高峰人数 vs 劳动力峰值关联拦截', () => {
  it('临时用水按 120 人 vs 劳动力峰值 71 人 → error（双口径残留）', () => {
    const md = '本工程劳动力峰值为 71 人。临时用水按高峰人数 120 人计算，各施工组单独设置计量表。';
    const issues = waterLaborPeakAssociationIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('用水高峰人数与劳动力峰值不一致');
    expect(issues[0]?.message).toContain('120');
    expect(issues[0]?.message).toContain('71');
  });
});

describe('R5 用水高峰人数与劳动力峰值一致（不报）', () => {
  it('生活用水按高峰人数 71 人 = 劳动力峰值 71 人 → 零 error', () => {
    const md = '本工程劳动力峰值为 71 人。生活用水按高峰人数 71 人计算。';
    expect(waterLaborPeakAssociationIssues(md)).toEqual([]);
  });
});

describe('R6 仅用水句无劳动力峰值句（不报）', () => {
  it('用水口径数字不与自身互查（waterSet ⊆ laborSet 恒真漏检根治）', () => {
    const md = '临时用水按高峰人数 120 人计算。';
    expect(waterLaborPeakAssociationIssues(md)).toEqual([]);
  });
});

describe('R7 元话语声明句检测与整句删除', () => {
  it('纯声明句检测 → error；清洗后声明消失、数据句保留、检测清零', () => {
    const md = '本工程不再另行统计累计投入人次。劳动力峰值为 71 人。';
    const issues = metaDiscourseDeclarationIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('元话语声明句');
    const fixed = fixMetaDiscourseDeclarations(md);
    expect(fixed.markdown).not.toContain('不再另行统计累计投入人次');
    expect(fixed.markdown).toContain('劳动力峰值为 71 人');
    expect(fixed.markdown).not.toMatch(/^[。；;\s]/u);
    expect(metaDiscourseDeclarationIssues(fixed.markdown)).toEqual([]);
  });
});

describe('R8 从句删除保留数据主句', () => {
  it('「，不再另行出现其他口径」从句删除，劳动力峰值数据保留', () => {
    const md = '本工程劳动力峰值为 71 人，不再另行出现其他口径。';
    const fixed = fixMetaDiscourseDeclarations(md);
    expect(fixed.markdown).toContain('劳动力峰值为 71 人');
    expect(fixed.markdown).not.toContain('不再另行出现其他口径');
    expect(fixed.markdown).not.toContain('，。');
  });
});

describe('R9 唯一基准式声明从句清洗', () => {
  it('「以 90 日历天为唯一控制基准」数据保留，「，不再另行调整」从句删除', () => {
    const md = '工期控制以 90 日历天为唯一控制基准，不再另行调整。';
    const fixed = fixMetaDiscourseDeclarations(md);
    expect(fixed.markdown).toContain('以 90 日历天为唯一控制基准');
    expect(fixed.markdown).not.toContain('不再另行调整');
  });
});

describe('R10 公式形态残留检测与纯公式句清洗', () => {
  it('公式句检测 → error；清洗后无公式符号、数据句保留', () => {
    const md = '临时用电计算：P = 1.05 × (K1 × ΣP1 / cosφ + K2 × ΣP2)。高峰人数 71 人。';
    const issues = formulaResidueIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('公式形态残留');
    const fixed = fixFormulaResidues(md);
    expect(fixed.markdown).not.toContain('P =');
    expect(fixed.markdown).not.toContain('Σ');
    expect(fixed.markdown).not.toContain('cosφ');
    expect(fixed.markdown).toContain('高峰人数 71 人');
    expect(formulaResidueIssues(fixed.markdown)).toEqual([]);
  });
});

describe('R11 混合句片段删除保留值化数据', () => {
  it('公式片段删除不吞同句数据（「，用电负荷约 48kW」保留）', () => {
    const md = '临时用电按 P = 1.05 × K1 × ΣP1 / cosφ 计算，用电负荷约 48kW。';
    const fixed = fixFormulaResidues(md);
    expect(fixed.markdown).toContain('用电负荷约 48kW');
    expect(fixed.markdown).not.toContain('P =');
    expect(fixed.markdown).not.toContain('Σ');
  });
});

describe('R12 里程桩号不误伤', () => {
  it('K1+200 / K2+350 桩号不含计算符号 → 零 error 且清洗不修改', () => {
    const md = '管线起讫桩号 K1+200 至 K2+350 段。';
    expect(formulaResidueIssues(md)).toEqual([]);
    expect(fixFormulaResidues(md).markdown).toBe(md);
  });
});

describe('R13 值化句不误伤', () => {
  it('「用电负荷约 48kW」「高峰日生活用水量约 9.3 m³」→ 零 error', () => {
    const md = '用电负荷约 48kW，高峰日生活用水量约 9.3 m³。';
    expect(formulaResidueIssues(md)).toEqual([]);
  });
});
