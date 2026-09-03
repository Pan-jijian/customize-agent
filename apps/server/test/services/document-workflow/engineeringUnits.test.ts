/**
 * engineeringUnits 单测：工程计量口径归一化（全角/单位归一链/计量 token 提取），
 * 供事实匹配与参数一致性比对共用。
 */
import { describe, expect, it } from 'vitest';
import { extractEngineeringMeasureTokens, normalizeEngineeringMeasure, normalizeEngineeringTextForFactMatch } from '@/services/document-workflow/engineeringUnits';

describe('normalizeEngineeringMeasure', () => {
  it('全角字符转半角并去空白', () => {
    expect(normalizeEngineeringMeasure('Ｃ３０　混凝土')).toBe('C30混凝土');
  });

  it('面积/体积单位归一', () => {
    expect(normalizeEngineeringMeasure('100平方米')).toBe('100m2');
    expect(normalizeEngineeringMeasure('200㎡')).toBe('200m2');
    expect(normalizeEngineeringMeasure('3公顷')).toBe('3hm2');
    expect(normalizeEngineeringMeasure('50立方米')).toBe('50m3');
    expect(normalizeEngineeringMeasure('２升')).toBe('2l');
    // 归一链顺序：/升/ → l 先于 /毫升/，'毫升' 的 '升' 已被替换 → '毫l'
    expect(normalizeEngineeringMeasure('500毫升')).toBe('500毫l');
  });

  it('长度单位归一（长单位优先于短单位）', () => {
    expect(normalizeEngineeringMeasure('5千米')).toBe('5km');
    expect(normalizeEngineeringMeasure('2公里')).toBe('2km');
    expect(normalizeEngineeringMeasure('300毫米')).toBe('300mm');
    expect(normalizeEngineeringMeasure('50厘米')).toBe('50cm');
    expect(normalizeEngineeringMeasure('10米')).toBe('10m');
  });

  it('重量单位归一', () => {
    expect(normalizeEngineeringMeasure('5千克')).toBe('5kg');
    expect(normalizeEngineeringMeasure('3公斤')).toBe('3kg');
    expect(normalizeEngineeringMeasure('500克')).toBe('500g');
    expect(normalizeEngineeringMeasure('2吨')).toBe('2t');
  });

  it('货币/工期单位归一', () => {
    expect(normalizeEngineeringMeasure('100人民币万元')).toBe('100万元');
    expect(normalizeEngineeringMeasure('50万元人民币')).toBe('50万元');
    expect(normalizeEngineeringMeasure('300日历天')).toBe('300天');
    expect(normalizeEngineeringMeasure('30自然日')).toBe('30天');
    expect(normalizeEngineeringMeasure('20工作日')).toBe('20工作天');
    expect(normalizeEngineeringMeasure('6个月')).toBe('6月');
    expect(normalizeEngineeringMeasure('8小时')).toBe('8h');
    expect(normalizeEngineeringMeasure('30分钟')).toBe('30min');
  });

  it('压力/力/功率/电学单位归一（千级先于单级）', () => {
    expect(normalizeEngineeringMeasure('10兆帕')).toBe('10mpa');
    expect(normalizeEngineeringMeasure('5千帕')).toBe('5kpa');
    expect(normalizeEngineeringMeasure('200千牛')).toBe('200kn');
    expect(normalizeEngineeringMeasure('100牛')).toBe('100n');
    expect(normalizeEngineeringMeasure('3千瓦')).toBe('3kw');
    expect(normalizeEngineeringMeasure('2兆瓦')).toBe('2mw');
    expect(normalizeEngineeringMeasure('50瓦')).toBe('50w');
    expect(normalizeEngineeringMeasure('10千伏')).toBe('10kv');
    expect(normalizeEngineeringMeasure('220伏')).toBe('220v');
    expect(normalizeEngineeringMeasure('5毫安')).toBe('5ma');
    expect(normalizeEngineeringMeasure('10安培')).toBe('10a');
    expect(normalizeEngineeringMeasure('50赫兹')).toBe('50hz');
    expect(normalizeEngineeringMeasure('25摄氏度')).toBe('25℃');
  });

  it('百分比/千分比/直径/管径归一', () => {
    expect(normalizeEngineeringMeasure('百分之25')).toBe('25%');
    expect(normalizeEngineeringMeasure('千分之5')).toBe('5permille');
    expect(normalizeEngineeringMeasure('直径600mm')).toBe('φ600');
    expect(normalizeEngineeringMeasure('Φ600')).toBe('φ600');
    expect(normalizeEngineeringMeasure('DN200')).toBe('dn200');
    expect(normalizeEngineeringMeasure('D100')).toBe('d100');
  });

  it('大写单位缩写归一为小写（需非单词字符词边界，空白已被前序链清除）', () => {
    expect(normalizeEngineeringMeasure('100-KN')).toBe('100-kn');
    expect(normalizeEngineeringMeasure('5-MPA')).toBe('5-mpa');
  });

  it('乘号归一与标点清除', () => {
    expect(normalizeEngineeringMeasure('３米×４米')).toBe('3mx4m');
    expect(normalizeEngineeringMeasure('直径600，强度C30。')).toBe('φ600强度C30');
  });
});

describe('normalizeEngineeringTextForFactMatch', () => {
  it('归一化后小写化', () => {
    expect(normalizeEngineeringTextForFactMatch('ＡＢＣ 100㎡')).toBe('abc100m2');
  });
});

describe('extractEngineeringMeasureTokens', () => {
  it('提取强度/面积/工期计量 token', () => {
    const tokens = extractEngineeringMeasureTokens('混凝土强度C30，面积100平方米，工期300日历天');
    expect(tokens).toEqual(expect.arrayContaining(['c30', '100m2', '300天']));
  });

  it('提取尺寸乘式与直径 token', () => {
    const tokens = extractEngineeringMeasureTokens('层高3米×4米，直径600mm');
    expect(tokens).toEqual(expect.arrayContaining(['3m', '4m', 'φ600']));
  });

  it('提取小数标高与比例 token', () => {
    const tokens = extractEngineeringMeasureTokens('标高1.500');
    expect(tokens).toEqual(expect.arrayContaining(['1.500']));
  });

  it('无计量内容返回空数组', () => {
    expect(extractEngineeringMeasureTokens('本段无任何数值信息')).toEqual([]);
  });
});
