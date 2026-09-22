/**
 * 真值层 + 值级覆盖单测（方案 v3 §1-§3）。
 * 样本**逐字取自巢湖真实自测**的事实值与答疑证据（含各种残片/噪声形态）——
 * 这些形态是实测踩过的坑，作为回归守卫固化。
 */
import { describe, expect, it } from 'vitest';
import { buildAuthoritativeValues, cleanValueForm, extractValueAndShape, normalizeAttributeName, rejectValueNoise, stripTrailingOcrGarbage, sourcePriority } from '@/services/document-workflow/authoritativeValues';
import { applyOverridesToRetrieved, applyOverridesToText, collapseOverrideChains, extractLabeledAuthorityValues, extractValueOverrides } from '@/services/document-workflow/valueOverride';

const 答疑 = '巢湖项目/答疑文件/7招标答疑文件（电子签章版）.pdf';
const 招标 = '巢湖项目/招标文件.pdf';

/**
 * 带口径标签权威值抽取（真实答疑原文 → 真值层候选）。
 * 4.55.22 根治的三个独立缺陷（均出自巢湖真实自测，逐字固化）：
 *   ① 连接语正则缺少非捕获组 → `现变更修改为:330日历天` 的 330 静默丢失；
 *   ② 口径标签与变更值距离超过 16 字（「计划工期**于2026年08月05日**变更修改为330日历天」）→ 规则正则整体失配；
 *   ③ 口径标签与数值之间夹组成性标签（「最高投标限价**暂列金额由**4000000.00元…」）→ 组成部分被当成合同总额。
 */
describe('带口径标签权威值抽取（4.55.22 根治）', () => {
  const labeled = (texts: Array<[string, string]>) => extractLabeledAuthorityValues(texts.map(([text, source]) => ({ text, source })));

  it('变更连接语后的值为生效值（正则优先级缺陷回归：330 不再丢失）', () => {
    const result = labeled([[`1、本次招标项目原计划工期:365日历天，现变更修改为:330日历天。`, 答疑]]);
    expect(result.filter(item => item.attribute === '计划工期').map(item => item.value)).toEqual(['330日历天']);
  });

  it('口径标签与变更值相隔澄清发生日（距离无关：仍取连接语后的 330）', () => {
    const result = labeled([['本次招标项目计划工期于2026年08月05日变更修改为330日历天。', 答疑]]);
    expect(result.filter(item => item.attribute === '计划工期').map(item => item.value)).toEqual(['330日历天']);
  });

  it('值携带完整单位（裸数字会成为全局误替换的种子）', () => {
    const result = labeled([['2.8计划工期：365日历天', 招标]]);
    expect(result.map(item => item.value)).toEqual(['365日历天']);
  });

  it('组成性标签拦截：暂列金额不是合同总额', () => {
    const result = labeled([['（2）本次最高投标限价暂列金额由4000000.00元调整为7000000.00元，请说明该项调整的主要考虑。', 答疑]]);
    expect(result.filter(item => item.attribute === '合同金额')).toEqual([]);
  });

  it('总额仍正常抽取（括号内提及暂列金额不影响）', () => {
    const result = labeled([['2、本次招标项目最高投标限价现调整为: 157166591.34元（其中含暂列金额7000000.00元），详细内容见本次招标答疑附件。', 答疑]]);
    expect(result.filter(item => item.attribute === '合同金额').map(item => item.value)).toEqual(['157166591.34元']);
  });

  it('澄清语境按段落判定：提问段复述的原值不算澄清值', () => {
    const page = [
      '2、原招标文件计划开工日期是2026年8月31日（具体开工日期以招标人出具的书面开工通知为准），',
      '现在开标日期改为2026年9月24日，计划开工日期是否调整？',
      '答：本次招标项目因部分内容完善调整，于2026年09月07日发布招标答疑重新启动招标，故投标人须知前附表第1.3.2条原内容：',
      '现澄清为如下：',
      '1.3.2计划工期计划开工日期：2026年10月10日（具体开工日期以招标人出具的书面开工通知为准）',
    ].join('\n\n');
    const byValue = new Map(labeled([[page, 答疑]]).map(item => [item.value, item]));
    expect(byValue.get('2026年8月31日')?.clarified).toBe(false);
    expect(byValue.get('2026年10月10日')?.clarified).toBe(true);
  });
});

/**
 * 巢湖端到端（多份补疑 + 建库实况）：真值层必须收敛到**现行口径**。
 * 实测缺陷（4.55.21 发布前拦截）：金额取到 7号答疑里作废的暂列金额 4000000.00元、
 * 工期取到 365、开工日期取到被澄清掉的 2026年8月31日——三条同时错。
 */
describe('巢湖端到端：多份补疑的现行口径裁决（4.55.22 根治）', () => {
  const 答疑1 = '巢湖项目/答疑文件/1招标答疑文件（电子签章版）.pdf';
  const 答疑5 = '巢湖项目/答疑文件/5招标答疑文件（电子签章版）.pdf';
  const sources = [
    { text: '2.7合同估算价：22303.66万元\n2.8计划工期：365日历天', source: 招标 },
    { text: '1、本次招标项目原计划工期:365日历天，现变更修改为:330日历天。\n3、本次招标项目最高投标限价现调整为:172460314.52元（其中含暂列金额4000000.00元），详细内容见本次招标答疑附件。', source: 答疑1 },
    { text: '2、本次招标项目最高投标限价现调整为: 157166591.34元（其中含暂列金额7000000.00元），详细内容见本次招标答疑附件。', source: 答疑5 },
    { text: '2、原招标文件计划开工日期是2026年8月31日（具体开工日期以招标人出具的书面开工通知为准），\n\n现在开标日期改为2026年9月24日，计划开工日期是否调整？\n\n答：本次招标项目因部分内容完善调整，故投标人须知前附表第1.3.2条原内容：\n\n现澄清为如下：\n\n1.3.2计划工期计划开工日期：2026年10月10日（具体开工日期以招标人出具的书面开工通知为准）', source: 答疑 },
  ];
  const overrides = collapseOverrideChains(extractValueOverrides(sources));
  const audit = buildAuthoritativeValues({
    facts: [
      // 事实池实况：招标原文旧值 + 蓝图进度表推导出的天数（既不是 365 也不是 330）
      { key: '计划工期', value: '365日历天', sourceFile: 招标 },
      { key: '计划工期', value: '348天', sourceFile: '巢湖项目/4-工程量清单各项分类表/进度计划表.xls' },
      { key: '合同金额', value: '22303.66万元', sourceFile: 招标 },
    ],
    overrides,
    labeledValues: extractLabeledAuthorityValues(sources),
  });
  const pick = (attribute: string) => audit.resolved.find(item => item.attribute === attribute);

  it('合同金额 = 157166591.34元（最新补疑胜出；暂列金额与作废限价均不得当总额）', () => {
    expect(pick('合同金额')?.value).toBe('157166591.34元');
    expect(pick('合同金额')?.rule).toBe('R3');
  });

  it('计划工期 = 330日历天（R1 变更链；365 出局）', () => {
    expect(pick('计划工期')?.value).toBe('330日历天');
    expect(pick('计划工期')?.superseded).toContain('365日历天');
  });

  it('开工日期 = 2026年10月10日（澄清表生效值胜出）', () => {
    expect(pick('开工日期')?.value).toBe('2026年10月10日');
  });

  it('写作前置覆盖表：被取代值均指向现行值，且不含组成部分', () => {
    const table = audit.resolved.flatMap(item => item.superseded.map(value => `${value}→${item.value}`));
    expect(table).toContain('365日历天→330日历天');
    expect(table).toContain('172460314.52元→157166591.34元');
    expect(table).toContain('22303.66万元→157166591.34元');
    expect(table.join('|')).not.toContain('4000000.00元');
  });
});

describe('R1 生效值升格 + 确定性终止（4.55.22）', () => {
  it('生效值未进候选时由覆盖链升格并胜出（原实现回退全量=放弃覆盖）', () => {
    const audit = buildAuthoritativeValues({
      facts: [{ key: '计划工期', value: '365日历天', sourceFile: 招标 }],
      overrides: collapseOverrideChains(extractValueOverrides([{ text: '原计划工期:365日历天，现变更修改为:330日历天', source: 答疑 }])),
    });
    expect(audit.resolved.find(item => item.attribute === '计划工期')?.value).toBe('330日历天');
  });

  it('裁决与候选输入顺序无关（R7 终止比较器全序）', () => {
    const sources = [
      { key: '开工日期', value: '2026年8月31日', sourceFile: 答疑 },
      { key: '开工日期', value: '2026年10月10日', sourceFile: '巢湖项目/答疑文件/6招标澄清文件.pdf' },
    ];
    const forward = buildAuthoritativeValues({ facts: sources });
    const backward = buildAuthoritativeValues({ facts: [...sources].reverse() });
    expect(forward.resolved.find(item => item.attribute === '开工日期')?.value)
      .toBe(backward.resolved.find(item => item.attribute === '开工日期')?.value);
  });

  it('跨资料包不串值：少数资料包的候选被判为非本项目（不参与裁决）', () => {
    const audit = buildAuthoritativeValues({
      facts: [
        { key: '计划工期', value: '330日历天', sourceFile: '巢湖项目/答疑文件/1招标答疑文件.pdf' },
        { key: '计划工期', value: '330日历天', sourceFile: '巢湖项目/招标文件.pdf' },
        { key: '计划工期', value: '90日历天', sourceFile: '丰乐镇项目/招标文件.pdf' },
      ],
    });
    expect(audit.resolved.find(item => item.attribute === '计划工期')?.value).toBe('330日历天');
    expect(audit.noiseRejected.some(item => item.reason.includes('跨资料包') && item.value === '90日历天')).toBe(true);
  });

  it('跨资料包隔离保守边界：存在裸文件名来源时不启用（不误删合法事实）', () => {
    const audit = buildAuthoritativeValues({
      facts: [
        { key: '计划工期', value: '330日历天', sourceFile: '巢湖项目/答疑文件/1招标答疑文件.pdf' },
        { key: '计划工期', value: '330日历天', sourceFile: '巢湖项目/招标文件.pdf' },
        { key: '计划工期', value: '90日历天', sourceFile: '招标文件.pdf' },
      ],
    });
    expect(audit.noiseRejected.some(item => item.reason.includes('跨资料包'))).toBe(false);
  });
});

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

describe('判定唯一性自检（真值层 ↔ 正文声明口径）', () => {
  const audit = buildAuthoritativeValues({
    facts: [
      { key: '计划工期', value: '365日历天', sourceFile: 招标 },
      { key: '计划工期', value: '365日历天，现变更修改为:330日历天', sourceFile: 答疑 },
    ],
    overrides: collapseOverrideChains(extractValueOverrides([
      { text: '365日历天，现变更修改为:330日历天', source: 答疑 },
      { text: '365日历天', source: 招标 },
    ])),
  });

  it('正文按生效值落位 → 零不一致', async () => {
    const { caliberConsistencyIssues } = await import('@/services/document-workflow/authoritativeValues');
    expect(caliberConsistencyIssues('本工程总工期330日历天，按此组织施工。', audit)).toEqual([]);
  });

  it('正文未按生效值落位（只写被取代值）→ 报不一致', async () => {
    const { caliberConsistencyIssues } = await import('@/services/document-workflow/authoritativeValues');
    const issues = caliberConsistencyIssues('本工程总工期365日历天，按此组织施工。', audit);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0]!.message).toContain('330日历天');
  });
});

/**
 * 被取代登记的安全边界（4.55.22 实测拦截）：写作前会把「被取代值」在**事实池与全部证据**里
 * 全局替换成现行值。逐项多值属性（搭设高度/窗材质/厚度…）的候选来自不同分项，
 * 「胜出值」只是众多分项里被选中一个——其余分项值不是旧口径。
 * 实测缺陷：不加边界时覆盖表产出「7m→4.5m」「5.7m→4.5m」「1.8mm→1.2mm」「1.6m→2.40m」等，
 * 证据侧一次替换 51 处技术参数。
 */
describe('被取代登记的安全边界（4.55.22 根治）', () => {
  it('逐项多值属性不登记被取代（分项值的差异不是口径变更）', () => {
    const audit = buildAuthoritativeValues({
      facts: [
        { key: '搭设高度', value: '4.5m', sourceFile: '巢湖项目/答疑文件/1招标答疑文件.pdf' },
        { key: '搭设高度', value: '7m', sourceFile: '巢湖项目/4-工程量清单各项分类表/清单.xls' },
        { key: '搭设高度', value: '5.7m', sourceFile: '巢湖项目/4-工程量清单各项分类表/清单.xls' },
      ],
    });
    expect(audit.resolved.find(item => item.attribute === '搭设高度')?.superseded).toEqual([]);
  });

  it('单值型项目口径仍正常登记（工期/金额/开工日期由带口径标签机制识别）', () => {
    const audit = buildAuthoritativeValues({
      facts: [],
      overrides: [],
      labeledValues: [
        { attribute: '计划工期', value: '330日历天', source: 答疑, clarified: true },
        { attribute: '计划工期', value: '365日历天', source: 招标, clarified: false },
      ],
    });
    expect(audit.resolved.find(item => item.attribute === '计划工期')?.superseded).toContain('365日历天');
  });

  it('变更链自证：链声明的生效值与裁决胜出值不符时，不登记该链的被取代值', () => {
    // 「1.8mm→50mm」是清单语境下的跨分项误配；该属性实际胜出值是答疑口径的 1.2mm
    const override = {
      superseded: '1.8mm', effective: '50mm', scope: ['厚度'],
      evidence: [{ source: '巢湖项目/4-工程量清单各项分类表/清单.xls', snippet: '' }], kind: 'override' as const,
    };
    const audit = buildAuthoritativeValues({
      facts: [
        { key: '窗材质', value: '1.8mm', sourceFile: '巢湖项目/4-工程量清单各项分类表/清单.xls' },
        { key: '窗材质', value: '1.2mm', sourceFile: 答疑 },
      ],
      overrides: [override],
    });
    const resolved = audit.resolved.find(item => item.attribute === '窗材质');
    expect(resolved?.value).toBe('1.2mm');
    expect(resolved?.superseded).toEqual([]);
  });

  it('变更链自证通过时正常登记（链生效值 = 裁决胜出值）', () => {
    const override = {
      superseded: '1.8mm', effective: '2.5mm', scope: ['窗材质'],
      evidence: [{ source: '巢湖项目/答疑文件/1招标答疑文件.pdf', snippet: '' }], kind: 'override' as const,
    };
    const audit = buildAuthoritativeValues({
      facts: [
        { key: '窗材质', value: '1.8mm', sourceFile: '巢湖项目/4-工程量清单各项分类表/清单.xls' },
        { key: '窗材质', value: '1.2mm', sourceFile: '巢湖项目/4-工程量清单各项分类表/清单2.xls' },
      ],
      overrides: [override],
    });
    const resolved = audit.resolved.find(item => item.attribute === '窗材质');
    expect(resolved?.value).toBe('2.5mm');
    expect(resolved?.superseded).toContain('1.8mm');
  });
});

describe('口径残留终检（被取代值不得作为现行口径）', () => {
  const ledger = [{ attribute: '计划工期', value: '330日历天', rule: 'R1', evidence: [{ source: 答疑 }], superseded: ['365日历天'] }];

  it('正文同时含生效值与旧值 → 报被取代口径残留', async () => {
    const { caliberConsistencyIssues } = await import('@/services/document-workflow/qualityValidation');
    const issues = caliberConsistencyIssues('本工程总工期330日历天。其中主体结构施工365天。', ledger);
    expect(issues.map(issue => issue.message).join('|')).toContain('被取代口径残留');
  });

  it('同族裸数字残留（365天）同样报出', async () => {
    const { caliberConsistencyIssues } = await import('@/services/document-workflow/qualityValidation');
    const issues = caliberConsistencyIssues('本工程总工期330日历天，总历时365天。', ledger);
    expect(issues.some(issue => issue.message.includes('被取代口径残留'))).toBe(true);
  });

  it('变更过程陈述豁免（「原为365日历天…现变更为330日历天」不报）', async () => {
    const { caliberConsistencyIssues } = await import('@/services/document-workflow/qualityValidation');
    const issues = caliberConsistencyIssues('本工程总工期330日历天（原为365日历天，经答疑澄清变更为330日历天）。', ledger);
    expect(issues).toEqual([]);
  });

  it('数值边界：不得把 1365 当成 365 的残留', async () => {
    const { caliberConsistencyIssues } = await import('@/services/document-workflow/qualityValidation');
    const issues = caliberConsistencyIssues('本工程总工期330日历天，另含1365日历天的保修期。', ledger);
    expect(issues).toEqual([]);
  });
});

describe('覆盖表文本应用（写作输入就地替换）', () => {
  const overrides = collapseOverrideChains(extractValueOverrides([{ text: '原计划工期:365日历天，现变更修改为:330日历天', source: 答疑 }]));

  it('被取代值就地替换为生效值，变更过程句保留原值', () => {
    expect(applyOverridesToText('本工程总工期365日历天。', overrides).text).toBe('本工程总工期330日历天。');
    expect(applyOverridesToText('原计划工期为365日历天，现变更为330日历天。', overrides).text)
      .toBe('原计划工期为365日历天，现变更为330日历天。');
  });

  it('边界守卫：不得替换更长数字串里的同形片段（1365日历天 / 2365）', () => {
    const result = applyOverridesToText('1#厂房工期1365日历天，2#厂房2365日历天。', overrides);
    expect(result.text).toBe('1#厂房工期1365日历天，2#厂房2365日历天。');
    expect(result.applied).toEqual([]);
  });

  it('检索出口收口：章节写作二次检索拿到的切片同样归一（旧值不得从这条通道回流）', () => {
    const chunks = [
      { content: '2.8计划工期：365日历天', filePath: '招标文件.pdf' },
      { content: '本工程计划工期365日历天，质量目标合格。', filePath: '工程概况.docx' },
      { content: '主体结构施工工艺说明。', filePath: '施工方案.docx' },
    ];
    const rewritten = applyOverridesToRetrieved(chunks, overrides);
    expect(rewritten).toBe(2);
    expect(chunks[0]!.content).toBe('2.8计划工期：330日历天');
    expect(chunks[1]!.content).toBe('本工程计划工期330日历天，质量目标合格。');
    expect(chunks[2]!.content).toBe('主体结构施工工艺说明。');
  });

  it('检索出口无覆盖表时零改动（不误伤）', () => {
    const chunks = [{ content: '计划工期365日历天' }];
    expect(applyOverridesToRetrieved(chunks, undefined)).toBe(0);
    expect(applyOverridesToRetrieved(chunks, [])).toBe(0);
    expect(chunks[0]!.content).toBe('计划工期365日历天');
  });
});
