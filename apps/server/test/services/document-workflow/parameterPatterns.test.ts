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

  it('尺寸乘式不拆科学记数法/小数片段（第三轮收编：1.0×10⁻² 的 0×10、6.5x10 的 5x10）', () => {
    expect(matches(PRECISE_TOKEN_RE, '透水系数≥1.0×10⁻²cm/s')).not.toContain('0×10');
    expect(matches(PRECISE_TOKEN_RE, '板6.5x10')).not.toContain('5x10');
    // 正常整数尺寸不受影响
    expect(matches(PRECISE_TOKEN_RE, '尺寸50×10方管')).toContain('50×10');
    expect(matches(PRECISE_TOKEN_RE, '300x300x10预埋板')).toContain('300x300x10');
  });

  it('M24d D1 面积单位三形态可提（r28k/s28l 实机盲区根治）', () => {
    expect(matches(PRECISE_TOKEN_RE, '建筑面积1436.400m2，')).toContain('1436.400m2');
    expect(matches(PRECISE_TOKEN_RE, '建筑面积961.42平方米。')).toContain('961.42平方米');
    expect(matches(PRECISE_TOKEN_RE, '建筑面积937.72㎡；')).toContain('937.72㎡');
    expect(matches(PRECISE_TOKEN_RE, '占地1436.4m²，')).toContain('1436.4m²');
  });

  it('M24d D1 m² 不截断为 m（原被 m 分支截断为「1436.4m」）', () => {
    expect(matches(PRECISE_TOKEN_RE, '占地1436.4m²，')).not.toContain('1436.4m');
    expect(matches(PRECISE_TOKEN_RE, '占地1436.4m²，')).toContain('1436.4m²');
  });

  it('M24d D1 非词形单位后接标点可提（原 \\b 边界不成立而漏提）', () => {
    expect(matches(PRECISE_TOKEN_RE, '压实度93%，合格')).toContain('93%');
    expect(matches(PRECISE_TOKEN_RE, '温度25℃，正常')).toContain('25℃');
  });

  it('M24d D1 既有形态零回归', () => {
    expect(matches(PRECISE_TOKEN_RE, '长度20mm；')).toContain('20mm');
    expect(matches(PRECISE_TOKEN_RE, '合计100.5m3。')).toContain('100.5m3');
    expect(matches(PRECISE_TOKEN_RE, '长约500m，')).toContain('500m');
    expect(matches(PRECISE_TOKEN_RE, 'C30混凝土')).toContain('C30');
    expect(matches(PRECISE_TOKEN_RE, '管径DN50')).toContain('DN50');
    // 裸小数非工程数字不提取
    expect(matches(PRECISE_TOKEN_RE, '坡度i=0.3、')).toEqual([]);
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

  it('r28 扩围：绿化/苗木类形态（地径D10/胸径Φ12/养护期为二年/成活率≥95%）→ 命中', () => {
    expect(matches(PROCESS_PARAMETER_RE, '其中红枫B地径D10')).not.toHaveLength(0);
    expect(matches(PROCESS_PARAMETER_RE, '腊梅胸径Φ12')).not.toHaveLength(0);
    expect(matches(PROCESS_PARAMETER_RE, '养护期为二年')).not.toHaveLength(0);
    expect(matches(PROCESS_PARAMETER_RE, '移栽成活率≥95%')).not.toHaveLength(0);
  });

  it('r28 反例：绿化描述句无参数形态 → 0 命中（防词表过宽）', () => {
    expect(matches(PROCESS_PARAMETER_RE, '绿化苗木按设计规格选型并及时栽植，养护管理到位。')).toHaveLength(0);
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
