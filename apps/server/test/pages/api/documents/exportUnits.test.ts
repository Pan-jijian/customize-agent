/**
 * 导出链单位上标化边界（normalizeExportUnits 内的 normalizePower）：
 * 无数字前缀的大写「M2/M3」是编号/标号（里程碑 M2、分段 M3），不是量纲单位——
 * 丰乐镇总进度计划表实测被误换成「m²」「m³」（此前还被 normalizeProductionText 误换成
 * 「平方米」「立方米」）；数字前缀形态与裸小写形态的既有归一行为保持不变。
 */
import { describe, expect, it } from 'vitest';
import { __documentExportTest__ } from '@/pages/api/documents/export';

const { normalizeExportUnits } = __documentExportTest__;

describe('normalizeExportUnits 上标化边界', () => {
  it('里程碑编号 M2/M3（无数字前缀）原样保留', () => {
    expect(normalizeExportUnits('M2 污水管网进度过半')).toBe('M2 污水管网进度过半');
    expect(normalizeExportUnits('M3 污水管网完成')).toBe('M3 污水管网完成');
  });

  it('M2.5 砂浆标号原样保留', () => {
    expect(normalizeExportUnits('卵石灌 M2.5 混合砂浆')).toBe('卵石灌 M2.5 混合砂浆');
  });

  it('数字前缀与裸小写形态仍正常上标化', () => {
    expect(normalizeExportUnits('100m2')).toBe('100m²');
    expect(normalizeExportUnits('100 m3')).toBe('100 m³');
    expect(normalizeExportUnits('单位：m2')).toBe('单位：m²');
  });

  it('㎡ 归一为上标', () => {
    expect(normalizeExportUnits('面积20㎡')).toBe('面积20m²');
  });
});
