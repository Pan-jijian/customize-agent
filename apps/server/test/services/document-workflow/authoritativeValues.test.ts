/**
 * 真值层 + 值级覆盖单测（方案 v3 §1-§3）。
 * 样本**逐字取自巢湖真实自测**的事实值与答疑证据（含各种残片/噪声形态）——
 * 这些形态是实测踩过的坑，作为回归守卫固化。
 */
import { describe, expect, it } from 'vitest';
import { buildAuthoritativeValues, cleanValueForm, extractValueAndShape, normalizeAttributeName, rejectValueNoise, stripTrailingOcrGarbage, sourcePriority } from '@/services/document-workflow/authoritativeValues';
import { collapseOverrideChains, extractValueOverrides } from '@/services/document-workflow/valueOverride';

const 答疑 = '巢湖项目/答疑文件/7招标答疑文件（电子签章版）.pdf';
const 招标 = '巢湖项目/招标文件.pdf';

describe('值级覆盖 VLO（巢湖真值）', () => {
  it('变更连接语：365日历天 → 330日历天（半角/全角冒号均可）', () => {
    for (const text of ['365日历天，现变更修改为:330日历天', '365日历天，现变更修改为：330日历天']) {
      const overrides = extractValueOverrides([{ text, source: 答疑 }]);
      expect(overrides.some(item => item.superseded === '365日历天' && item.effective === '330日历天')).toBe(true);
    }
  });

  it('仅给出生效值（同句无旧值）时不产出值对——旧值由其他资料候选承载', () => {
    const overrides = extractValueOverrides([{ text: '本次招标项目计划工期于2026年08月05日变更修改为330日历天。', source: 答疑 }]);
    expect(overrides.every(item => item.superseded !== '2026年08月05日')).toBe(true);
  });

  it('同类替换：变更发生日期不当作被取代的工期（「2026年08月05日 → 330日历天」不产出）', () => {
    const overrides = extractValueOverrides([{ text: '本次招标项目计划工期于2026年08月05日变更修改为330日历天。', source: 答疑 }]);
    expect(overrides.some(item => item.superseded.includes('08月05日'))).toBe(false);
  });

  it('垃圾对不产出（「0808月 → 日变更修改为」）', () => {
    const overrides = extractValueOverrides([{ text: '于注：本次招标项目计划工期于20262026年年0808月月0505日变更修改为日变更修改为330330日', source: 答疑 }]);
    expect(overrides.every(item => /\d/u.test(item.effective))).toBe(true);
  });
});

describe('噪声闸（实测形态）', () => {
  it('图签/占位/指向/串格/复写/段落 均已拦', () => {
    expect(rejectValueNoise('子项名称图名')).toBeTruthy();
    expect(rejectValueNoise('【清单未体现】')).toBeTruthy();
    expect(rejectValueNoise('见招标公告计划开工日期：2026年08月31日（具体开工日期以招标人出具的书面开工通知为准）')).toBeTruthy();
    expect(rejectValueNoise('安徽省巢湖市 ，建筑面积：72062.84 ，层数：层，高度：23.950')).toBeTruthy();
    expect(rejectValueNoise('于注：本次招标项目计划工期于年年月月日变更修改为日变更修改为日')).toBeTruthy();
    expect(rejectValueNoise('本工程的质量及操作须符合《城市道路工程施工质量验收规程》DGJ08-118-2005的要求。')).toBeTruthy();
  });

  it('正常值不误伤（含曾被误伤的「专业工程暂估价」）', () => {
    for (const value of ['专业工程暂估价', 'MU15粉煤灰多孔砖、预拌DM M7.5水泥砂浆', '合格', '330日历天', '22303.66万元', '巢湖市居巢经开区义成路与南外环路交口北侧']) {
      expect(rejectValueNoise(value)).toBeUndefined();
    }
  });
});

describe('值形态与清洗（实测形态）', () => {
  it('句子形态取值本体：变更语后 token 优先（2026年08月05日 不再被当成工期）', () => {
    const r = extractValueAndShape('本次招标项目计划工期于2026年08月05日变更修改为330日历天。');
    expect(r.value).toBe('330日历天');
    expect(r.shape).toBe('measure');
  });

  it('括号噪声剥离（图纸标注重复串）', () => {
    const cleaned = cleanValueForm('1.75m（图纸标注：0.5m/s ，基坑深度 -1.7 米（余同）；1.75m/s ，基坑深度 -1.7 米（余同））');
    expect(cleaned.value).toBe('1.75m');
  });

  it('地址尾部 OCR 垃圾剥离（图号串格/坐标数字）', () => {
    expect(stripTrailingOcrGarbage('…交口北ZHC55640X5000铝合金窗框')).toContain('交口北');
    expect(stripTrailingOcrGarbage('巢湖市居巢经开区义成路与南外环路交口北0000')).toBe('巢湖市居巢经开区义成路与南外环路交口北');
    expect(stripTrailingOcrGarbage('巢湖市居巢经开区义成路与南外环路交口北0000侧')).toBe('巢湖市居巢经开区义成路与南外环路交口北侧');
  });

  it('属性归一：具体字段优先（计划开工日期 → 开工日期，不被"工期"抢走）', () => {
    expect(normalizeAttributeName('计划开工日期')).toBe('开工日期');
    expect(normalizeAttributeName('duration')).toBe('计划工期');
    expect(normalizeAttributeName('schedule_requirement')).toBe('计划工期');
  });

  it('来源优先级：答疑 > 招标 > 清单 > 图纸', () => {
    expect(sourcePriority(答疑)).toBeGreaterThan(sourcePriority(招标));
    expect(sourcePriority(招标)).toBeGreaterThan(sourcePriority('x/1#厂房土建工程.xls'));
    expect(sourcePriority('x/1#厂房土建工程.xls')).toBeGreaterThan(sourcePriority('x/结构施工图.dwg'));
  });
});

describe('决定性裁决（巢湖关键属性，端到端）', () => {
  const facts = [
    { key: '计划工期', value: '365日历天，现变更修改为:330日历天', sourceFile: 答疑 },
    { key: '计划工期', value: '365日历天', sourceFile: 招标 },   // 招标原文旧口径（应被取代）
    { key: '计划工期', value: '本次招标项目计划工期于2026年08月05日变更修改为330日历天。', sourceFile: 答疑 },
    { key: '计划工期', value: '见招标公告计划开工日期：2026年08月31日（具体开工日期以招标人出具的书面开工通知为准）', sourceFile: 答疑 },
    { key: '计划工期', value: '现澄清为如下：条款号条款号条款名称条款名称编列内容编列内容1.3.2计划工期计划开工日期：2026年10月10日（具体开工日期以', sourceFile: 答疑 },
    { key: '建设地点', value: '巢湖市光电新能源产业园项目东区标准化厂房二标段位于巢湖市居巢经开区义成路与南外环路交口北0000侧', sourceFile: 'x/结构施工图.dwg' },
    { key: '建筑规模', value: '安徽省巢湖市 ，建筑面积：72062.84 ，层数：层，高度：23.950', sourceFile: 招标 },
    { key: '建筑规模', value: '建筑面积72062.84平方米', sourceFile: 答疑 },
    { key: '质量标准', value: '本工程的质量及操作须符合《城市道路工程施工质量验收规程》DGJ08-118-2005的要求。', sourceFile: 招标 },
    { key: '质量标准', value: '合格', sourceFile: 招标 },
    { key: '合同估算价格', value: '22303.66万元', sourceFile: 招标 },
  ];
  const audit = buildAuthoritativeValues({ facts, overrides: collapseOverrideChains(extractValueOverrides(facts.map(f => ({ text: f.value, source: f.sourceFile })))) });
  const pick = (attribute: string) => audit.resolved.find(item => item.attribute === attribute);

  it('计划工期 = 330日历天（365 记为被取代；不被日期形态污染）', () => {
    expect(pick('计划工期')?.value).toBe('330日历天');
    expect(pick('计划工期')?.superseded).toContain('365日历天');
  });

  it('开工日期 = 2026年10月10日（答疑澄清口径胜出，招标指针句 08-31 落败）', () => {
    expect(pick('开工日期')?.value).toBe('2026年10月10日');
  });

  it('建设地点 = 含完整地址构造（OCR 尾垃圾剥离、无数字串格）', () => {
    const value = pick('建设地点')?.value || '';
    expect(value).toContain('居巢经开区义成路与南外环路交口北');
    expect(value).not.toMatch(/\d{3,}/u);
  });

  it('建设规模 = 答疑口径（串格值被拦）', () => {
    expect(pick('建设规模')?.value).toBe('建筑面积72062.84平方米');
  });

  it('质量标准 = 合格（段落冒充值被拦）', () => {
    expect(pick('质量标准')?.value).toBe('合格');
  });

  it('合同金额 = 22303.66万元', () => {
    expect(pick('合同金额')?.value).toBe('22303.66万元');
  });

  it('恒有值：所有受管属性均有唯一裁决与依据（无"待人工确认"分支）', () => {
    for (const item of audit.resolved) {
      expect(item.value.length).toBeGreaterThan(0);
      expect(item.rule).toMatch(/^R[0-9.]+$/u);
      expect(item.evidence.length).toBeGreaterThan(0);
    }
  });
});
