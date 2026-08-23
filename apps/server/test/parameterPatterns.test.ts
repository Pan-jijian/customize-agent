import { describe, expect, it } from 'vitest';
import { DEVICE_SPEC_RE, EVIDENCE_PARAMETER_RE, HAS_QUANTIFIED_VALUE_RE, PRECISE_TOKEN_RE, PROCESS_PARAMETER_RE, QUANTIFIED_FACT_RE } from '../src/services/document-workflow/parameterPatterns';

/** 带 /g 标志的正则 test 会推进 lastIndex，断言前统一复位 */
function matches(re: RegExp, text: string) {
  re.lastIndex = 0;
  return re.test(text);
}

describe('parameterPatterns 口径统一', () => {
  it('kN 属工艺参数口径：工艺审查命中、事实卡量化判定不命中', () => {
    const line = '单桩竖向承载力特征值不小于 500kN';
    expect(matches(PROCESS_PARAMETER_RE, line)).toBe(true);
    expect(matches(QUANTIFIED_FACT_RE, line)).toBe(false);
  });

  it('混凝土/钢筋牌号属证据参数口径：证据行命中、事实卡量化判定不命中', () => {
    expect(matches(EVIDENCE_PARAMETER_RE, '混凝土强度等级 C30，钢筋 HRB400')).toBe(true);
    expect(matches(QUANTIFIED_FACT_RE, '混凝土强度等级 C30，钢筋 HRB400')).toBe(false);
  });

  it('试验/检测类术语属工艺参数口径：工艺审查命中、通用量化不命中', () => {
    expect(matches(PROCESS_PARAMETER_RE, '锚杆按设计要求进行拉拔试验')).toBe(true);
    expect(matches(QUANTIFIED_FACT_RE, '锚杆按设计要求进行拉拔试验')).toBe(false);
  });

  it('尺寸乘式与标准编号三套口径一致命中', () => {
    expect(matches(PRECISE_TOKEN_RE, '600×600×300 预制检查井')).toBe(true);
    expect(matches(EVIDENCE_PARAMETER_RE, '600×600×300 预制检查井')).toBe(true);
    expect(matches(PRECISE_TOKEN_RE, '依据 GB/T 50204 验收')).toBe(true);
    expect(matches(EVIDENCE_PARAMETER_RE, '依据 GB/T 50204 验收')).toBe(true);
  });

  it('型号/规格关键词属事实值口径：事实值筛选命中、事实行量化判定不命中', () => {
    expect(matches(HAS_QUANTIFIED_VALUE_RE, '型号：QTZ80 塔式起重机')).toBe(true);
    expect(matches(QUANTIFIED_FACT_RE, '型号：QTZ80 塔式起重机')).toBe(false);
    expect(matches(DEVICE_SPEC_RE, 'QTZ80 塔式起重机')).toBe(true);
  });
});
