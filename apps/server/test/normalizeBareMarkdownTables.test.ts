import { describe, expect, it } from 'vitest';
import { normalizeBareMarkdownTables } from '../src/services/document-workflow/documentGeneratorHelpers';

/**
 * normalizeBareMarkdownTables 裸表格列头修复回归测试：
 * 历史缺陷——对缺分隔行的裸表格强制套通用列头模板（控制项目/执行要求/责任岗位…），
 * 造成“责任岗位”列填日期、“检查标准”列填管径的列头数据错位（真实生成缺陷：徽光阁材料进场表/取水点表）。
 */
describe('normalizeBareMarkdownTables', () => {
  it('裸表格数据行含数值（无列头）时原样保留，不套通用列头模板', () => {
    const input = [
      '| AB组分结构植筋胶 | 专用型 | 第6～25日 | 第5日进场 | 产品合格证、性能检测报告齐全 |',
      '| 阻燃胶合板及阻燃矿棉板 | / | 第26～40日 | 第24日进场 | 燃烧性能等级与环保指标复核 |',
    ].join('\n');
    const output = normalizeBareMarkdownTables(input);
    expect(output).toContain('AB组分结构植筋胶');
    expect(output).not.toContain('控制项目');
    expect(output).not.toContain('责任岗位');
  });

  it('裸表格列头行+数据行（缺分隔行）保留原列头并补分隔行', () => {
    const input = [
      '| 材料名称 | 规格型号 | 进场时间 | 复试时间 | 资料要求 |',
      '| AB组分结构植筋胶 | 专用型 | 第6～25日 | 第5日进场 | 见证取样复试合格 |',
      '| 水泥基防水涂料 | / | 第20～35日 | 第18日进场 | 抽样送检 |',
    ].join('\n');
    const output = normalizeBareMarkdownTables(input);
    expect(output).toContain('| 材料名称 | 规格型号 | 进场时间 | 复试时间 | 资料要求 |');
    expect(output).toContain('---');
    expect(output).not.toContain('控制项目');
  });

  it('规范表格（已有分隔行）保持原样', () => {
    const input = [
      '| 设备名称 | 单台功率 | 数量 | 检查频次 |',
      '| --- | --- | --- | --- |',
      '| 小型提升设备 | 5.5kW | 2台 | 每日1次 |',
    ].join('\n');
    const output = normalizeBareMarkdownTables(input);
    expect(output).toContain('| 设备名称 | 单台功率 | 数量 | 检查频次 |');
    expect(output).toContain('| 小型提升设备 | 5.5kW | 2台 | 每日1次 |');
  });

  it('列数不齐的裸表格原样保留', () => {
    const input = [
      '| 转运路线 | 起讫点 | 转运时段 |',
      '| 主通道 | 南侧入口至首层卸料平台 | 8:30—16:00 | 装饰材料 |',
    ].join('\n');
    const output = normalizeBareMarkdownTables(input);
    expect(output).not.toContain('控制项目');
    expect(output).toContain('主通道');
  });

  it('列头行本身含数字时（数据行形态）不误判为列头', () => {
    const input = [
      '| 首层取水点 | 砂浆拌制、冲洗 | DN25 | 密闭桶接漏 | 每日 |',
      '| 二层取水点 | 养护、清洁 | DN20 | 严禁溢流 | 每日 |',
    ].join('\n');
    const output = normalizeBareMarkdownTables(input);
    expect(output).not.toContain('控制项目');
    expect(output).toContain('DN25');
  });
});
