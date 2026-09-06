import { describe, expect, it } from 'vitest';
import { detectSmartTableHeader, locateTableColumns, scoreTableHeaderRow } from '../src/extraction/table-header-detect.js';

/**
 * F1/F2 智能表头行检测 + 语义列定位单测：
 * 工程表格常见「标题行（E.1 分部分项工程量清单计价表）→ 多级表头 → 数据行」结构，
 * 历史实现取 matrix[0] 当表头导致真实列名全部退化为 COL2~COL15（合肥师范清单 xls 实锤）。
 * 测试锁定：标题行低分不选、真实表头高分胜出、标题降级注释、多级表头拼接、语义列按名定位。
 */

// 15 列偏移清单样本：标题行 + 工程名称行 + 真实表头在第 2 行，
// 名称/特征/单位/工程量列全部不在历史硬编码列位（body[2]/body[3]/body[4]/body[5]）
const OFFSET_15_MATRIX: string[][] = [
  ['E.1 分部分项工程量清单计价表', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['工程名称：合肥师范项目', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['序号', '项目编码', '', '', '项目名称', '项目特征描述', '', '', '', '计量单位', '', '', '工程量', '', ''],
  ['1', '010101001001', '', '', '垫层', '1.混凝土种类:商品混凝土；2.混凝土强度等级:C15', '', '', '', 'm3', '', '', '125.80', '', ''],
  ['2', '010502001001', '', '', '矩形柱', '1.混凝土种类:商品混凝土；2.混凝土强度等级:C35', '', '', '', 'm3', '', '', '86.40', '', ''],
];

describe('scoreTableHeaderRow', () => {
  it('标题行仅命中「工程量」一组 → 2 分（不达 4 分表头门槛）', () => {
    expect(scoreTableHeaderRow(OFFSET_15_MATRIX[0] || [])).toBe(2);
  });

  it('工程名称行命中 name 组 → 2 分', () => {
    expect(scoreTableHeaderRow(OFFSET_15_MATRIX[1] || [])).toBe(2);
  });

  it('真实表头行命中 seq/code/name/feature/unit/quantity 六组 → 12 分', () => {
    expect(scoreTableHeaderRow(OFFSET_15_MATRIX[2] || [])).toBe(12);
  });

  it('纯数据行零命中 → 0 分', () => {
    expect(scoreTableHeaderRow(OFFSET_15_MATRIX[3] || [])).toBe(0);
  });

  it('同组关键词重复命中不累加（「项目编码」+「清单编码」两列只计一组）', () => {
    expect(scoreTableHeaderRow(['序号', '项目编码', '清单编码', '项目名称'])).toBe(6);
  });

  it('空行 → 0 分', () => {
    expect(scoreTableHeaderRow([])).toBe(0);
  });
});

describe('detectSmartTableHeader', () => {
  it('15 列偏移清单：标题行/工程名称行不选，真实表头行（第 3 行）胜出', () => {
    const smart = detectSmartTableHeader(OFFSET_15_MATRIX);
    expect(smart.headerIndex).toBe(2);
    expect(smart.headers[0]).toBe('序号');
    expect(smart.headers[4]).toBe('项目名称');
    expect(smart.headers[5]).toBe('项目特征描述');
    expect(smart.headers[9]).toBe('计量单位');
    expect(smart.headers[12]).toBe('工程量');
  });

  it('标题行与工程名称行降级为注释（titleLines）', () => {
    const smart = detectSmartTableHeader(OFFSET_15_MATRIX);
    expect(smart.titleLines).toEqual(['E.1 分部分项工程量清单计价表', '工程名称：合肥师范项目']);
  });

  it('语义列定位：15 列偏移下 seq/name/feature/unit/quantity 索引全部正确', () => {
    const smart = detectSmartTableHeader(OFFSET_15_MATRIX);
    expect(smart.columnMap).toMatchObject({ seq: 0, code: 1, name: 4, feature: 5, unit: 9, quantity: 12 });
  });

  it('表头在扫描范围末尾（第 40 行）仍可定位', () => {
    const matrix = Array.from({ length: 40 }, (_, index) => (index === 39
      ? ['序号', '项目名称', '项目特征描述', '计量单位', '工程量']
      : ['前置噪声标题', '', '', '', '']));
    const smart = detectSmartTableHeader(matrix);
    expect(smart.headerIndex).toBe(39);
    expect(smart.headers[1]).toBe('项目名称');
  });

  it('多级表头：子表头行（人工费/材料费）与主表头拼接为主列_子列，子表头行不再当数据', () => {
    const matrix = [
      ['分部分项工程量清单与计价表', '', '', ''],
      ['序号', '项目名称', '项目特征描述', '综合单价'],
      ['', '', '', '人工费 材料费 机械费 管理费 利润'],
      ['1', '垫层', '混凝土强度等级:C15', '312.50'],
    ];
    const smart = detectSmartTableHeader(matrix);
    expect(smart.headerIndex).toBe(2);
    expect(smart.headers[3]).toBe('综合单价_人工费 材料费 机械费 管理费 利润');
    // 拼接后子表头行被跳过，语义列不受子表头干扰
    expect(smart.columnMap.name).toBe(1);
  });

  it('子表头行序号列是纯整数（数据形态）→ 不拼接，按普通数据行处理', () => {
    const matrix = [
      ['序号', '项目名称', '项目特征描述', '综合单价'],
      ['1', '垫层', '混凝土强度等级:C15', '312.50'],
    ];
    const smart = detectSmartTableHeader(matrix);
    expect(smart.headerIndex).toBe(0);
    expect(smart.headers[3]).toBe('综合单价');
  });

  it('无列关键词表格（进度表类）→ 回退 matrix[0]，保持历史行为', () => {
    const matrix = [
      ['日期', '节点', '负责人', '状态'],
      ['2026-01-01', '开工', '张三', '完成'],
    ];
    const smart = detectSmartTableHeader(matrix);
    expect(smart.headerIndex).toBe(0);
    expect(smart.headers).toEqual(['日期', '节点', '负责人', '状态']);
    expect(smart.titleLines).toEqual([]);
  });

  it('空 matrix → 安全返回空表头（不抛异常）', () => {
    const smart = detectSmartTableHeader([]);
    expect(smart.headerIndex).toBe(0);
    expect(smart.headers).toEqual([]);
    expect(smart.titleLines).toEqual([]);
  });

  it('同分并列时取首个出现的行（bestScore 严格大于才更新，后行同分不覆盖）', () => {
    // 两行均为 4 分：严格大于才更新 → 取首行
    const matrix = [
      ['序号', '项目名称'],
      ['项目特征描述', '计量单位'],
      ['1', '垫层'],
    ];
    const smart = detectSmartTableHeader(matrix);
    expect(smart.headerIndex).toBe(0);
    expect(smart.headers).toEqual(['序号', '项目名称']);
  });
});

describe('locateTableColumns', () => {
  it('标准清单列名 → 全部定位', () => {
    const map = locateTableColumns(['序号', '项目编码', '项目名称', '项目特征描述', '计量单位', '工程量']);
    expect(map).toEqual({ seq: 0, code: 1, name: 2, feature: 3, unit: 4, quantity: 5 });
  });

  it('列名变体（「名称」「数量」「特征描述」）→ 同样定位', () => {
    const map = locateTableColumns(['编号', '名称', '特征描述', '单位', '数量']);
    expect(map).toEqual({ seq: -1, code: -1, name: 1, feature: 2, unit: -1, quantity: 4 });
  });

  it('缺失列 → -1', () => {
    const map = locateTableColumns(['序号', '项目名称']);
    expect(map).toEqual({ seq: 0, code: -1, name: 1, feature: -1, unit: -1, quantity: -1 });
  });

  it('长关键词优先：「项目特征描述」列不会被「名称」组误占（名称组最长词优先）', () => {
    const map = locateTableColumns(['项目名称', '项目特征描述']);
    expect(map.name).toBe(0);
    expect(map.feature).toBe(1);
  });

  it('「工程量」与「数量」并存时取最长关键词列', () => {
    const map = locateTableColumns(['序号', '项目名称', '工程量', '数量']);
    expect(map.quantity).toBe(2);
  });

  it('表头含空格（「计量 单位」）→ 精确匹配失败回 -1（现状约束：不模糊归一）', () => {
    const map = locateTableColumns(['序号', '项目名称', '计量 单位', '工程量']);
    expect(map.unit).toBe(-1);
  });
});
