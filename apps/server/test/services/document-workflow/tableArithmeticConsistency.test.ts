/**
 * C-T3 表内算术自洽检测器（table-arithmetic-consistency）矩阵：
 * 含显性合计标记（合计行/合计列）的表格「分项和=合计」确定性核对。本测试锁定：
 * 1. 触发口径：仅显性合计语义参与核对（合计列横向 / 合计行纵向）；
 * 2. 保守策略（宁漏报不误报——误报代价是修复轮把正确的表改坏）：无合计标记不判 /
 *    不定词 / 单位混用 / 多合计（分节小计）/ 插注行 / 悬空数字 / 区间约数 / 单分项 / 容差全跳过；
 * 3. 数值正确性：千分位解析、「其他」差额项豁免与有值参与、自洽零误报；
 * 4. 发布契约：issue 字段（error/blocker）+ message 前缀（判定链锚「生成后事实反查失败」）+ 上限 5 条。
 * 纯函数，无 mock。
 */
import { describe, expect, it } from 'vitest';
import { countTableArithmeticFindings, tableArithmeticInconsistencyIssues } from '@/services/document-workflow/integrity/detectors/detectors';

/** 标准 Markdown 表构造（表头 + `| --- |` 分隔行 + 数据行） */
function table(header: string[], rows: string[][]): string {
  return [header, header.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`).join('\n');
}

/** C4 表5-2 型横向缺陷：班组分项 106+56+2=164，合计列 262 */
const LATERAL_DEFECT = table(
  ['工种', '班组一（人）', '班组二（人）', '班组三（人）', '合计（人）'],
  [['钢筋工', '106', '56', '2', '262']],
);

describe('触发口径：合计列横向 / 合计行纵向', () => {
  it('合计列横向不自洽报出（表5-2 型：分项和 164 ≠ 合计 262）', () => {
    const issues = tableArithmeticInconsistencyIssues(LATERAL_DEFECT);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('表格算术不自洽 1 处');
    expect(issues[0].message).toContain('「钢筋工」行');
    expect(issues[0].message).toContain('262');
    expect(issues[0].message).toContain('164');
    expect(issues[0].message).toContain('差 98');
    expect(countTableArithmeticFindings(LATERAL_DEFECT)).toBe(1);
  });

  it('合计行纵向不自洽逐列报出（2 列各 1 条 finding，聚合单 issue）', () => {
    const markdown = table(
      ['项目', '数量（m2）', '金额（元）'],
      [
        ['甲', '100', '2000'],
        ['乙', '150', '3000'],
        ['合计', '500', '6000'],
      ],
    );
    const issues = tableArithmeticInconsistencyIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('表格算术不自洽 2 处');
    expect(issues[0].message).toContain('「数量（m2）」列');
    expect(issues[0].message).toContain('「金额（元）」列');
    expect(countTableArithmeticFindings(markdown)).toBe(2);
  });

  it('自洽表零误报（横向 100+62=162、纵向 250/5000）', () => {
    const lateral = table(
      ['工种', '班组一（人）', '班组二（人）', '合计（人）'],
      [
        ['钢筋工', '100', '62', '162'],
        ['木工', '80', '40', '120'],
      ],
    );
    const vertical = table(
      ['项目', '数量（m2）', '金额（元）'],
      [
        ['甲', '100', '2000'],
        ['乙', '150', '3000'],
        ['合计', '250', '5000'],
      ],
    );
    expect(tableArithmeticInconsistencyIssues(lateral)).toEqual([]);
    expect(tableArithmeticInconsistencyIssues(vertical)).toEqual([]);
  });
});

describe('保守策略：宁漏报不误报', () => {
  it('无显性合计标记的表不判（r8 表5-2 真实形态：不同统计维度不可机械求和）', () => {
    const markdown = table(
      ['工种', '同时在场人数（人）', '主要工种投入（人）'],
      [
        ['钢筋工', '43', '56'],
        ['木工', '106', '262'],
        ['混凝土工', '57', '262'],
      ],
    );
    expect(tableArithmeticInconsistencyIssues(markdown)).toEqual([]);
  });

  it('分项格含「部分」类不定词：该行不可断言保守跳过', () => {
    const markdown = table(
      ['工种', '班组一（人）', '班组二（人）', '合计（人）'],
      [['钢筋工', '106', '部分班组', '262']],
    );
    expect(tableArithmeticInconsistencyIssues(markdown)).toEqual([]);
  });

  it('分项单位混用（人/台并存）：不可求和保守跳过', () => {
    const markdown = table(
      ['工种', '投入人数（人）', '投入台数（台）', '合计'],
      [['钢筋工', '100 人', '62 台', '162']],
    );
    expect(tableArithmeticInconsistencyIssues(markdown)).toEqual([]);
  });

  it('「其中」类插注行不参与核对', () => {
    const markdown = table(
      ['工种', '班组一（人）', '班组二（人）', '合计（人）'],
      [
        ['钢筋工', '100', '62', '162'],
        ['其中：女工', '10', '2', '999'],
      ],
    );
    expect(tableArithmeticInconsistencyIssues(markdown)).toEqual([]);
  });

  it('数字无单位悬空在描述文字中：不可断言保守跳过', () => {
    const markdown = table(
      ['项目', '数量说明'],
      [
        ['甲段', '管径DN200，长度100'],
        ['乙段', '200'],
        ['合计', '400'],
      ],
    );
    expect(tableArithmeticInconsistencyIssues(markdown)).toEqual([]);
  });

  it('区间值与约数保守跳过', () => {
    const rangeValue = table(
      ['项目', '数量（m3）'],
      [
        ['甲段', '150~180'],
        ['乙段', '100'],
        ['合计', '280'],
      ],
    );
    const approxValue = table(
      ['项目', '数量（m3）'],
      [
        ['甲段', '约 120'],
        ['乙段', '100'],
        ['合计', '220'],
      ],
    );
    expect(tableArithmeticInconsistencyIssues(rangeValue)).toEqual([]);
    expect(tableArithmeticInconsistencyIssues(approxValue)).toEqual([]);
  });

  it('可求和分项 <2 个：单分项列不可断言保守跳过', () => {
    const markdown = table(
      ['项目', '数量（m2）'],
      [
        ['甲段', '100'],
        ['合计', '250'],
      ],
    );
    expect(tableArithmeticInconsistencyIssues(markdown)).toEqual([]);
  });

  it('多合计行/多合计列（分节小计）整表不判', () => {
    const multiRow = table(
      ['项目', '数量（m2）'],
      [
        ['甲区', '100'],
        ['小计', '999'],
        ['乙区', '200'],
        ['合计', '888'],
      ],
    );
    const multiCol = table(
      ['项目', '班组一（人）', '合计（人）', '总计（人）'],
      [['钢筋工', '100', '999', '888']],
    );
    expect(tableArithmeticInconsistencyIssues(multiRow)).toEqual([]);
    expect(tableArithmeticInconsistencyIssues(multiCol)).toEqual([]);
  });

  it('容差 max(1, |合计|×0.5%) 内四舍五入差不报', () => {
    const markdown = table(
      ['项目', '数量（m2）'],
      [
        ['甲段', '99.8'],
        ['乙段', '100.2'],
        ['合计', '200.3'],
      ],
    );
    expect(tableArithmeticInconsistencyIssues(markdown)).toEqual([]);
  });
});

describe('数值正确性与发布契约', () => {
  it('千分位金额正确解析（1,200+800=2,000 不误报）', () => {
    const markdown = table(
      ['项目', '金额（元）'],
      [
        ['甲项', '1,200'],
        ['乙项', '800'],
        ['合计', '2,000'],
      ],
    );
    expect(tableArithmeticInconsistencyIssues(markdown)).toEqual([]);
  });

  it('「其他」差额项：无值豁免求和 / 有值照常参与', () => {
    const exempt = table(
      ['分项', '金额（万元）'],
      [
        ['人工费', '100'],
        ['材料费', '300'],
        ['其他', '其他费用'],
        ['合计', '400'],
      ],
    );
    const valued = table(
      ['分项', '金额（万元）'],
      [
        ['人工费', '100'],
        ['材料费', '300'],
        ['其他', '50'],
        ['合计', '500'],
      ],
    );
    expect(tableArithmeticInconsistencyIssues(exempt)).toEqual([]);
    const issues = tableArithmeticInconsistencyIssues(valued);
    expect(issues).toHaveLength(1); // 100+300+50=450 ≠ 500：其他有值即参与求和，不复豁免
    expect(issues[0].message).toContain('450');
  });

  it('issue 字段契约（error/blocker + 「生成后事实反查失败」前缀 + llm_repairable）', () => {
    const issues = tableArithmeticInconsistencyIssues(LATERAL_DEFECT);
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue.level).toBe('error');
    expect(issue.severity).toBe('blocker');
    expect(issue.category).toBe('evidence_coverage');
    expect(issue.owner).toBe('llm');
    expect(issue.repairability).toBe('llm_repairable');
    expect(issue.message).toMatch(/^生成后事实反查失败：表格算术不自洽/);
    expect(issue.suggestion).toContain('合计');
  });

  it('多表聚合：issue 上限 5 条、countTableArithmeticFindings 处数同源', () => {
    const sixTables = Array.from({ length: 6 }, (_, index) => table(
      ['项目', '甲（人）', '乙（人）', '合计（人）'],
      [[`分项${index + 1}`, '10', '20', String(90 + index)]],
    )).join('\n\n');
    expect(countTableArithmeticFindings(sixTables)).toBe(6);
    expect(tableArithmeticInconsistencyIssues(sixTables)).toHaveLength(5);
  });
});
