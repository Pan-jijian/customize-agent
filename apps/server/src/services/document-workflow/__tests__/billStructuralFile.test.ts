/**
 * 清单文件「0 条目」分类防回归。
 *
 * 实测缺陷：巢湖「A.1 招标工程量清单封面」解析出 0 条目，被蓝图报成「部分清单文件解析失败」——
 * 而封面页天然没有分部分项条目，是每份招标清单的标准组成部分。使用者据此去查解析器是白费。
 * 现口径：只有「有明细表特征却 0 条目」才算失败；结构性文件（封面/扉页/目录/总说明）不告警。
 */
import { describe, expect, it } from 'vitest';
import { isStructuralOnlyBillFile } from '@/services/document-workflow/integratedBlueprint/parse';

const chunk = (content: string) => ({ content });

describe('isStructuralOnlyBillFile', () => {
  it('封面页 → 结构性文件（不告警）', () => {
    expect(isStructuralOnlyBillFile([
      chunk('工作表：1 A.1 招标工程量清单封面\n| COL1 | COL2 |\n| 招标工程量清单 | |\n| | 招  标  人：|\n| | （单位盖章）|'),
    ])).toBe(true);
  });

  it('目录/总说明类 → 结构性文件', () => {
    expect(isStructuralOnlyBillFile([chunk('工作表：总说明\n本工程工程量清单编制依据……')])).toBe(true);
    expect(isStructuralOnlyBillFile([chunk('工作表：目录\n1 分部分项工程量清单计价表……')])).toBe(true);
  });

  it('真清单明细表（有分部分项/项目编码特征）→ 不是结构性文件', () => {
    expect(isStructuralOnlyBillFile([
      chunk('| 序号 | 项目编码 | 项目名称 | 项目特征描述 | 计量单位 | 工程量 |\n| 1 | 050102012001 | 铺种草皮 | 草皮种类：矮生百慕大 | m2 | 148.000 |'),
    ])).toBe(false);
  });

  it('同时含封面与明细表 → 不是结构性文件（防「有明细却 0 条目」被放过）', () => {
    expect(isStructuralOnlyBillFile([
      chunk('工作表：A.1 招标工程量清单封面'),
      chunk('| 序号 | 项目编码 | 项目名称 |\n| 1 | 010101001001 | 挖一般土方 |'),
    ])).toBe(false);
  });

  it('既无明细特征也无结构标记 → 不是结构性文件（真失败，仍要告警）', () => {
    expect(isStructuralOnlyBillFile([chunk('| COL1 | COL2 | COL3 |\n| | | |')])).toBe(false);
  });

  it('空切片 → 不是结构性文件（由调用方按「索引无切片」处理）', () => {
    expect(isStructuralOnlyBillFile([])).toBe(false);
  });
});
