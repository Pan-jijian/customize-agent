/**
 * parameterPatterns 单测：量化参数识别正则统一口径（精确 token/事实量化/证据参数/工艺参数/设备规格/正文参数）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEVICE_SPEC_RE,
  EVIDENCE_PARAMETER_RE,
  HAS_QUANTIFIED_VALUE_RE,
  PRECISE_TOKEN_RE,
  PROCESS_PARAMETER_RE,
  QUANTIFIED_BODY_PARAM_RE,
  QUANTIFIED_FACT_RE,
} from '@/services/document-workflow/parameterPatterns';

function matches(re: RegExp, text: string): string[] {
  return text.match(re) ?? [];
}

describe('PRECISE_TOKEN_RE', () => {
  it('数值+单位/标准编号/尺寸乘式', () => {
    expect(matches(PRECISE_TOKEN_RE, 'C30混凝土，浇筑300mm厚')).toEqual(expect.arrayContaining(['300mm']));
    expect(matches(PRECISE_TOKEN_RE, '执行GB50204标准')).toEqual(expect.arrayContaining(['GB50204']));
    expect(matches(PRECISE_TOKEN_RE, '截面500x300')).toEqual(expect.arrayContaining(['500x300']));
  });
});

describe('QUANTIFIED_FACT_RE / HAS_QUANTIFIED_VALUE_RE', () => {
  it('事实行量化判断', () => {
    expect(QUANTIFIED_FACT_RE.test('计划工期300日历天')).toBe(true);
    expect(QUANTIFIED_FACT_RE.test('管径DN200')).toBe(true);
    expect(QUANTIFIED_FACT_RE.test('本工程位于市区')).toBe(false);
  });

  it('事实值含量化元素', () => {
    expect(HAS_QUANTIFIED_VALUE_RE.test('5000万元')).toBe(true);
    expect(HAS_QUANTIFIED_VALUE_RE.test('型号X1规格')).toBe(true);
    expect(HAS_QUANTIFIED_VALUE_RE.test('符合要求')).toBe(false);
  });
});

describe('EVIDENCE_PARAMETER_RE', () => {
  it('证据行参数识别（单位/管径/牌号/标准/乘式）', () => {
    expect(EVIDENCE_PARAMETER_RE.test('强度等级C30')).toBe(true);
    expect(EVIDENCE_PARAMETER_RE.test('钢筋HRB400')).toBe(true);
    expect(EVIDENCE_PARAMETER_RE.test('依据JGJ 120')).toBe(true);
    expect(EVIDENCE_PARAMETER_RE.test('描述性文本')).toBe(false);
  });
});

describe('PROCESS_PARAMETER_RE', () => {
  it('工艺参数（强度/尺寸/坡度/压实度/试验类）', () => {
    expect(matches(PROCESS_PARAMETER_RE, '强度等级C30')).not.toHaveLength(0);
    expect(matches(PROCESS_PARAMETER_RE, '坡度2%')).not.toHaveLength(0);
    expect(matches(PROCESS_PARAMETER_RE, '压实度≥95%')).not.toHaveLength(0);
    expect(matches(PROCESS_PARAMETER_RE, '采用闭水试验检测')).not.toHaveLength(0);
    expect(matches(PROCESS_PARAMETER_RE, '无参数描述')).toHaveLength(0);
  });

  it('多字符单位优先于单字符（m³/m² 不截断成 m）', () => {
    expect(matches(PROCESS_PARAMETER_RE, '混凝土30m³')).toEqual(['30m³']);
    expect(matches(PROCESS_PARAMETER_RE, '模板500m²')).toEqual(['500m²']);
  });
});

describe('DEVICE_SPEC_RE', () => {
  it('设备规格（型号/容量/IP 等级）', () => {
    expect(matches(DEVICE_SPEC_RE, '配电箱型号XL21容量50kW')).toEqual(expect.arrayContaining(['XL21', '50kW']));
    expect(matches(DEVICE_SPEC_RE, 'IP65')).not.toHaveLength(0);
  });
});

describe('QUANTIFIED_BODY_PARAM_RE', () => {
  it('正文量化参数', () => {
    expect(matches(QUANTIFIED_BODY_PARAM_RE, '建筑面积28000m²，工期300日历天')).toEqual(expect.arrayContaining(['28000m²', '300日历天']));
  });
});
