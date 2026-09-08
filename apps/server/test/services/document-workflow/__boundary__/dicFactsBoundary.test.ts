/**
 * 事实模型驱动检测器边界矩阵（P1 第 3 批）
 * 覆盖：fabricatedStartDate（编造开工日期）/ fieldValueMismatch（字段-数值错配）/
 * basicInfoScheduleField（计划工期违约词）/ excavationDepthLock（基坑深度锁定）/
 * excavationDepthFromFacts（深度提取）/ excavationHazardClassification（危大分级）/
 * supportFormFactConsistency（支护形式一致性）/ equipmentEntryTiming（设备进场时间）/
 * foundationFormResidue（桩基表述残留）/ ambiguousEitherOr（两可表述）
 */
import { describe, expect, it } from 'vitest';
import {
  ambiguousEitherOrIssues, basicInfoScheduleFieldIssues, equipmentEntryTimingIssues,
  excavationDepthFromFacts, excavationDepthLockIssues, excavationHazardClassificationIssues,
  fabricatedStartDateIssues, fieldValueMismatchIssues, foundationFormResidueIssues,
  supportFormFactConsistencyIssues,
} from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf, caseName } from './boundaryKit';

// ── A. 编造开工日期 ──

describe('A1 fabricatedStartDate 资料日期合法谱系', () => {
  const factArrays: Array<{ name: keyof ReturnType<typeof factsOf>; fact: ReturnType<typeof factOf> }> = [
    { name: 'project', fact: factOf({ key: 'p', value: '开工日期2026年3月1日' }) },
    { name: 'schedule', fact: factOf({ key: 's', value: '计划开工2026年3月1日' }) },
    { name: 'quality', fact: factOf({ key: 'q', value: '验收2026年3月1日' }) },
    { name: 'resources', fact: factOf({ key: 'r', value: '进场2026年3月1日' }) },
    { name: 'preciseFacts', fact: factOf({ key: 'f', value: '开工2026年3月1日' }) },
  ];
  it.each(factArrays)('A1 $name 数组来源日期合法不报', (row) => {
    const model = factsOf({ [row.name]: [row.fact] });
    const issues = fabricatedStartDateIssues('本工程2026年3月1日开工。', model);
    expect(issues).toEqual([]);
  });
  it('A1 带空格日期格式资料内合法', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026 年 3 月 1 日' })] });
    expect(fabricatedStartDateIssues('本工程2026 年 3 月 1 日开工。', model)).toEqual([]);
  });
  it('A1 资料日期在 fieldName 槽位', () => {
    const model = factsOf({ project: [factOf({ fieldName: '2026年12月31日', value: '竣工' })] });
    expect(fabricatedStartDateIssues('本工程2026年12月31日竣工。', model)).toEqual([]);
  });
});

describe('A2 fabricatedStartDate 无资料日期正文日期', () => {
  it('A2 空模型+正文日期→报', () => {
    const issues = fabricatedStartDateIssues('本工程2026年3月1日开工。', factsOf({}));
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('2026年3月1日');
  });
  it('A2 资料无日期字段+正文日期→报', () => {
    const model = factsOf({ project: [factOf({ value: '工期210日历天' })] });
    expect(fabricatedStartDateIssues('本工程2026年3月1日开工。', model).length).toBe(1);
  });
  it('A2 资料日期仅存在于无关数组不豁免（knownDates 与 hasMaterialDates 口径分离）', () => {
    const model = factsOf({ quality: [factOf({ value: '验收2026年5月1日' })] });
    // 正文日期 2026年3月1日 ∉ knownDates（仅 quality 有 5月1日）；hasMaterialDates=false（schedule/project 无日期）→ 报
    expect(fabricatedStartDateIssues('本工程2026年3月1日开工。', model).length).toBe(1);
  });
});

describe('A3 fabricatedStartDate 锚点词豁免', () => {
  const anchors = ['进度计划', '里程碑', '节点安排', '验收时间', '完成日期', '竣工日期', '移交日期', '合同签订'];
  it.each(anchors)('A3 锚点“$0”+资料日期→节点日期豁免', (anchor) => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    const md = `${anchor}：本工程2026年9月1日。`;
    expect(fabricatedStartDateIssues(md, model)).toEqual([]);
  });
  it('A3 锚点在 40 字符窗口外不豁免', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    // 锚点词在日期前 50+ 字符（窗口只回看 40）：「进度计划」不进上下文窗口 → 报
    const far = `进度计划${'、'.repeat(50)}本工程2026年9月1日。`;
    expect(fabricatedStartDateIssues(far, model).length).toBe(1);
  });
  it('A3 锚点词在 40 字符窗口边界内豁免', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    const near = `${'、'.repeat(30)}进度计划本工程2026年9月1日。`;
    expect(fabricatedStartDateIssues(near, model)).toEqual([]);
  });
});

describe('A4 fabricatedStartDate 资料外日期无锚点', () => {
  it('A4 schedule 资料有日期+正文资料外日期→报', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    const issues = fabricatedStartDateIssues('本工程2026年9月1日开工。', model);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('2026年9月1日');
  });
  it('A4 project 资料有日期+正文资料外日期→报', () => {
    const model = factsOf({ project: [factOf({ value: '开工2026年3月1日' })] });
    expect(fabricatedStartDateIssues('本工程2026年9月1日开工。', model).length).toBe(1);
  });
});

describe('A5 fabricatedStartDate 日期格式谱系', () => {
  const formats = [
    { label: '三位数年不匹配', md: '本工程999年3月1日开工。', expectIssue: false },
    { label: '月日双位', md: '本工程2026年12月31日开工。', expectIssue: true },
    { label: '月日单位', md: '本工程2026年1月1日开工。', expectIssue: true },
    { label: '无日字不匹配', md: '本工程2026年3月开工。', expectIssue: false },
    { label: '中文数字不匹配', md: '本工程二〇二六年三月一日开工。', expectIssue: false },
  ];
  it.each(formats)('A5 $label', ({ md, expectIssue }) => {
    const issues = fabricatedStartDateIssues(md, factsOf({}));
    expect(issues.length > 0).toBe(expectIssue);
  });
  it('A5 最多报 3 条', () => {
    const md = '2026年1月1日开工、2026年2月2日开工、2026年3月3日开工、2026年4月4日开工。';
    expect(fabricatedStartDateIssues(md, factsOf({})).length).toBe(3);
  });
});

// ── B. 字段-数值错配 ──

describe('B1 fieldValueMismatch 标签×值谱系', () => {
  const siteLabels = ['总占地面积', '占地面积'];
  const bodyLabels = ['单体建筑面积', '总建筑面积', '建筑面积'];
  const rows = bodyLabels.flatMap(label => ([
    {
      label: caseName('B1 正文值=siteArea值', { body: label, site: '总占地面积' }),
      facts: [factOf({ fieldName: '总占地面积', value: '30000㎡' }), factOf({ fieldName: '单体建筑面积', value: '28500㎡' })],
      md: `${label}30000㎡。`,
      expectIssue: true,
    },
    {
      label: caseName('B1 正文值=buildingArea值', { body: label, site: '总占地面积' }),
      facts: [factOf({ fieldName: '总占地面积', value: '30000㎡' }), factOf({ fieldName: '单体建筑面积', value: '28500㎡' })],
      md: `${label}28500㎡。`,
      expectIssue: false,
    },
    {
      label: caseName('B1 正文值两池外', { body: label, site: '总占地面积' }),
      facts: [factOf({ fieldName: '总占地面积', value: '30000㎡' }), factOf({ fieldName: '单体建筑面积', value: '28500㎡' })],
      md: `${label}31000㎡。`,
      expectIssue: false,
    },
  ]));
  it.each(rows)('$label', ({ facts, md, expectIssue }) => {
    const model = factsOf({ project: facts });
    const issues = fieldValueMismatchIssues(md, model);
    expect(issues.length > 0).toBe(expectIssue);
  });
});

describe('B2 fieldValueMismatch 槽位边界', () => {
  it('B2 两池交集值不报（siteArea 与 buildingArea 同值）', () => {
    const model = factsOf({ project: [factOf({ fieldName: '总占地面积', value: '30000㎡' }), factOf({ fieldName: '总建筑面积', value: '30000㎡' })] });
    expect(fieldValueMismatchIssues('总建筑面积30000㎡。', model)).toEqual([]);
  });
  it('B2 缺 siteArea 标签不报', () => {
    const model = factsOf({ project: [factOf({ fieldName: '单体建筑面积', value: '28500㎡' })] });
    expect(fieldValueMismatchIssues('单体建筑面积28500㎡。', model)).toEqual([]);
  });
  it('B2 缺 buildingArea 标签不报', () => {
    const model = factsOf({ project: [factOf({ fieldName: '总占地面积', value: '30000㎡' })] });
    expect(fieldValueMismatchIssues('单体建筑面积30000㎡。', model)).toEqual([]);
  });
  it('B2 总用地面积不入 siteArea 池（标签词不含「占地面积」）', () => {
    const model = factsOf({ project: [factOf({ fieldName: '总用地面积', value: '30000㎡' }), factOf({ fieldName: '单体建筑面积', value: '28500㎡' })] });
    expect(fieldValueMismatchIssues('单体建筑面积30000㎡。', model)).toEqual([]);
  });
  it('B2 地上建筑面积不入 buildingArea 池（可与 siteArea 值重合误报判定）', () => {
    const model = factsOf({ project: [factOf({ fieldName: '总占地面积', value: '30000㎡' }), factOf({ fieldName: '地上建筑面积', value: '30000㎡' })] });
    // buildingAreaValues 空 → 不报（size===0）
    expect(fieldValueMismatchIssues('单体建筑面积30000㎡。', model)).toEqual([]);
  });
  it('B2 千分位数值归一', () => {
    const model = factsOf({ project: [factOf({ fieldName: '总占地面积', value: '30,000㎡' }), factOf({ fieldName: '单体建筑面积', value: '28500㎡' })] });
    expect(fieldValueMismatchIssues('总建筑面积30000㎡。', model).length).toBe(1);
  });
  it('B2 小数数值', () => {
    const model = factsOf({ project: [factOf({ fieldName: '总占地面积', value: '30000.5㎡' }), factOf({ fieldName: '单体建筑面积', value: '28500㎡' })] });
    expect(fieldValueMismatchIssues('总建筑面积30000.5㎡。', model).length).toBe(1);
  });
});

describe('B3 fieldValueMismatch 单位与标签来源谱系', () => {
  const units = ['㎡', 'm2', 'm²', '平方米'];
  it.each(units)('B3 单位“$0”', (unit) => {
    const model = factsOf({ preciseFacts: [factOf({ fieldName: '总占地面积', value: `30000${unit}` }), factOf({ fieldName: '建筑面积', value: `28500${unit}` })] });
    expect(fieldValueMismatchIssues(`单体建筑面积30000${unit}。`, model).length).toBe(1);
  });
  it('B3 标签取自 key 槽位（fieldName 缺失）', () => {
    const model = factsOf({ project: [factOf({ key: '总占地面积', value: '30000㎡' }), factOf({ key: '总建筑面积', value: '28500㎡' })] });
    expect(fieldValueMismatchIssues('总建筑面积30000㎡。', model).length).toBe(1);
  });
  it('B3 最多报 3 条', () => {
    const model = factsOf({ project: [factOf({ fieldName: '总占地面积', value: '30000㎡' }), factOf({ fieldName: '单体建筑面积', value: '28500㎡' })] });
    const md = '单体建筑面积30000㎡。总建筑面积30000㎡。建筑面积30000㎡。单体建筑面积30000㎡。';
    expect(fieldValueMismatchIssues(md, model).length).toBe(3);
  });
});

// ── C. 计划工期字段违约词 ──

describe('C1 basicInfoScheduleField 违约词谱系', () => {
  const words = ['工期延误', '延误', '违约', '切除', '赔偿', '罚款', '解除', '扣减'];
  it.each(words)('C1 违约词“$0”→报', (word) => {
    const md = `| 计划工期 | ${word}相关条款 |`;
    const issues = basicInfoScheduleFieldIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('blocker');
  });
  it('C1 合肥师范实测复合句报', () => {
    const md = '| 计划工期 | 工期延误56天以上发包人可切除剩余工程量 |';
    expect(basicInfoScheduleFieldIssues(md).length).toBe(1);
  });
  it('C1 合法日历天值不报', () => {
    const md = '| 计划工期 | 540个日历天 |';
    expect(basicInfoScheduleFieldIssues(md)).toEqual([]);
  });
  it('C1 纯数字值不报', () => {
    expect(basicInfoScheduleFieldIssues('| 计划工期 | 210日历天 |')).toEqual([]);
  });
  it('C1 空值不报', () => {
    expect(basicInfoScheduleFieldIssues('| 计划工期 |  |')).toEqual([]);
  });
});

describe('C2 basicInfoScheduleField 结构边界', () => {
  it('C2 违约词在其他字段行不报', () => {
    expect(basicInfoScheduleFieldIssues('| 质量目标 | 工期延误条款 |')).toEqual([]);
  });
  it('C2 违约词在正文（非表格行）不报', () => {
    expect(basicInfoScheduleFieldIssues('本工程工期延误条款如下。')).toEqual([]);
  });
  it('C2 行首无竖线不报', () => {
    expect(basicInfoScheduleFieldIssues('计划工期 | 违约条款 |')).toEqual([]);
  });
  it('C2 全角空格与多空格仍命中', () => {
    expect(basicInfoScheduleFieldIssues('|  计划工期  |  违约条款  |').length).toBe(1);
  });
  it('C2 最多报 2 条', () => {
    const md = '| 计划工期 | 违约条款 |\n| 计划工期 | 赔偿条款 |\n| 计划工期 | 罚款条款 |';
    expect(basicInfoScheduleFieldIssues(md).length).toBe(2);
  });
});

// ── D. 基坑深度锁定 ──

describe('D1 excavationDepthLock 锁定形态谱系（不报）', () => {
  const locked = [
    '基坑开挖深度5.85m。',
    '基坑开挖深度约6m。',
    '开挖深度为5.85m。',
    '基坑底标高-3.5m。',
    '基坑支护及开挖：深度达5m。',
    '开挖深度为5.85米。',
    '基坑开挖支护：标高-4.2m锁定。',
  ];
  it.each(locked)('D1 锁定“%#”', (md) => {
    expect(excavationDepthLockIssues(md)).toEqual([]);
  });
  it('D1 锁定后比较式阈值同存不报', () => {
    const md = '基坑开挖深度5.85m。开挖深度超过3m属危大工程。基坑支护方案。';
    expect(excavationDepthLockIssues(md)).toEqual([]);
  });
});

describe('D2 excavationDepthLock 排除形态谱系（报）', () => {
  const exclusions = [
    '基坑开挖支护：开挖深度超过3m属危大工程。',
    '基坑开挖支护：单次开挖深度不大于1.5m。',
    '基坑开挖支护：深度按基坑支护设计图纸确定。',
    '基坑开挖支护：开挖深度2倍距离。',
    '基坑开挖支护：标高以上300mm人工清底。',
    '基坑开挖支护：标高偏差控制在±5。',
    '基坑开挖支护：标高±0.000。',
    '基坑开挖支护：坑底标高后24h内完成垫层。',
    '基坑开挖支护：标高低于水池最低水位500mm。',
    '基坑开挖支护：基底标高偏差0～-50mm。',
  ];
  it.each(exclusions)('D2 排除“%#”→报', (md) => {
    const issues = excavationDepthLockIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('基坑深度数值未锁定');
  });
  it('D2 时间数形态谱系排除', () => {
    for (const unit of ['2天', '1周', '3h', '1月']) {
      const md = `基坑开挖支护：坑底标高后${unit}内完成。`;
      expect(excavationDepthLockIssues(md).length).toBe(1);
    }
  });
});

describe('D3 excavationDepthLock 语境计数边界', () => {
  it('D3 语境 2 处不报', () => {
    expect(excavationDepthLockIssues('基坑支护方案。')).toEqual([]);
  });
  it('D3 语境 3 处报', () => {
    expect(excavationDepthLockIssues('基坑开挖支护施工方案。').length).toBe(1);
  });
  it('D3 语境 4 处报（基坑×2）', () => {
    expect(excavationDepthLockIssues('基坑开挖支护及基坑降水方案。').length).toBe(1);
  });
  it('D3 无基坑语境但有锁定形态不报', () => {
    expect(excavationDepthLockIssues('开挖深度5.85m。')).toEqual([]);
  });
  it('D3 深度语境 2 处+锁定缺失不报（语境不足）', () => {
    expect(excavationDepthLockIssues('基坑支护方案。')).toEqual([]);
  });
});

// ── E. 基坑深度提取与危大分级 ──

describe('E1 excavationDepthFromFacts 来源谱系', () => {
  it('E1 canonical 槽位直接提取', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '5.15m（图纸标注：坡底线）' } } } as never });
    expect(excavationDepthFromFacts(model)).toBe(5.15);
  });
  const gateWords = ['基坑开挖深度', '基坑深度', '开挖深度', '坡底线', '坑底标高'];
  it.each(gateWords)('E1 关键词门“$0”图纸来源', (word) => {
    const model = factsOf({ drawings: [factOf({ value: `${word}6.2m` })] });
    expect(excavationDepthFromFacts(model)).toBe(6.2);
  });
  it('E1 无关键词门图纸文本不提取', () => {
    const model = factsOf({ drawings: [factOf({ value: '建筑高度28.9m' })] });
    expect(excavationDepthFromFacts(model)).toBeUndefined();
  });
  it('E1 canonical 与图纸多值取最大', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '5.15m' } } } as never, drawings: [factOf({ value: '坡底线6.2m' })] });
    expect(excavationDepthFromFacts(model)).toBe(6.2);
  });
  it('E1 project 与 preciseFacts 来源', () => {
    const model = factsOf({ project: [factOf({ value: '基坑深度4.1m' })], preciseFacts: [factOf({ value: '开挖深度5.0m' })] });
    expect(excavationDepthFromFacts(model)).toBe(5);
  });
});

describe('E2 excavationDepthFromFacts 比较式与数值域', () => {
  const comparative = ['开挖深度超过5m', '开挖深度大于5m', '开挖深度不小于3m', '开挖深度16m及以上', '开挖深度5m以上', '开挖深度3m及以下'];
  it.each(comparative)('E2 比较式“$0”排除', (text) => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: text } } } as never });
    expect(excavationDepthFromFacts(model)).toBeUndefined();
  });
  it('E2 数值域下界 <1 过滤', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '0.5m' } } } as never });
    expect(excavationDepthFromFacts(model)).toBeUndefined();
  });
  it('E2 数值域上界 50 过滤', () => {
    const model = factsOf({ canonical: { byKey: { excavation_depth: { value: '50m' } } } as never });
    expect(excavationDepthFromFacts(model)).toBeUndefined();
  });
  it('E2 负标高取绝对值', () => {
    const model = factsOf({ drawings: [factOf({ value: '坑底标高-3.5m' })] });
    expect(excavationDepthFromFacts(model)).toBe(3.5);
  });
  it('E2 比较式条文不压过真实标注（canonical 污染防御）', () => {
    const model = factsOf({
      canonical: { byKey: { excavation_depth: { value: '开挖深度16m及以上属危大工程' } } } as never,
      drawings: [factOf({ value: '坡底线标高5.15m' })],
    });
    expect(excavationDepthFromFacts(model)).toBe(5.15);
  });
  it('E2 空模型与缺失数组防御', () => {
    expect(excavationDepthFromFacts(factsOf({}))).toBeUndefined();
    expect(excavationDepthFromFacts(factsOf({ canonical: { byKey: {} } } as never))).toBeUndefined();
  });
});

describe('E3 excavationHazardClassification 分级矩阵', () => {
  const cases = [
    { label: 'depth=2.9 无标注', depth: 2.9, md: '基坑支护方案。', expectCount: 0 },
    { label: 'depth=3 无标注→报危大', depth: 3, md: '基坑支护方案。', expectCount: 1, keyword: '危大工程判定缺失' },
    { label: 'depth=3 有危大→不报', depth: 3, md: '基坑属危大工程。', expectCount: 0 },
    { label: 'depth=4.9 无标注→报危大', depth: 4.9, md: '基坑支护方案。', expectCount: 1 },
    { label: 'depth=5 全无→报两条', depth: 5, md: '基坑支护方案。', expectCount: 2 },
    { label: 'depth=5 有危大缺超规模→报1', depth: 5, md: '基坑属危大工程。', expectCount: 1, keyword: '超过一定规模' },
    { label: 'depth=5 有超规模缺危大→报1', depth: 5, md: '基坑支护方案属超过一定规模需专家论证。', expectCount: 1, keyword: '危大工程判定缺失' },
    { label: 'depth=5 双标注→不报', depth: 5, md: '基坑属危大工程且超过一定规模需专家论证。', expectCount: 0 },
    { label: 'depth=10 全无→报两条', depth: 10, md: '基坑支护方案。', expectCount: 2 },
    { label: '无深度事实→不报', depth: undefined, md: '基坑支护方案。', expectCount: 0 },
  ];
  it.each(cases)('E3 $label', (row) => {
    const model = row.depth === undefined
      ? factsOf({})
      : factsOf({ canonical: { byKey: { excavation_depth: { value: `${row.depth}m` } } } as never });
    const issues = excavationHazardClassificationIssues(row.md, model);
    expect(issues.length).toBe(row.expectCount);
    if (row.keyword) expect(issues.some(issue => issue.message.includes(row.keyword as string))).toBe(true);
  });
});

// ── F. 支护形式事实一致性 ──

describe('F1 supportFormFact 资料形式词谱系', () => {
  const forms = ['土钉墙', '放坡', '喷锚', '挂网喷浆', '排桩', '灌注桩', '地下连续墙', '内支撑', '锚杆', '锚索'];
  it.each(forms)('F1 资料形式“$0”正文落地不报', (form) => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: `基坑支护形式为${form}` } } } as never });
    const md = `基坑支护小节：本工程采用${form}。`;
    expect(supportFormFactConsistencyIssues(md, model)).toEqual([]);
  });
  it('F1 drawings 来源形式词', () => {
    const model = factsOf({ drawings: [factOf({ value: '基坑支护形式：土钉墙+放坡' })] });
    const md = '基坑支护小节：本工程采用土钉墙与放坡。';
    expect(supportFormFactConsistencyIssues(md, model)).toEqual([]);
  });
  it('F1 资料文本含排除门词不入池', () => {
    const model = factsOf({ drawings: [factOf({ value: '支护形式监测频次说明' })] });
    expect(supportFormFactConsistencyIssues('基坑支护小节。', model)).toEqual([]);
  });
  it('F1 资料文本含基坑开挖深度排除', () => {
    const model = factsOf({ preciseFacts: [factOf({ value: '基坑开挖深度5.85m，支护形式闭环管理' })] });
    expect(supportFormFactConsistencyIssues('基坑支护小节。', model)).toEqual([]);
  });
});

describe('F2 supportFormFact 资料外体系词', () => {
  const foreignWords = ['支护桩', '冠梁', '钻孔灌注桩', '咬合桩'];
  it.each(foreignWords)('F2 资料=土钉墙，正文含“$0”→报', (word) => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '基坑支护形式为土钉墙' } } } as never });
    const issues = supportFormFactConsistencyIssues(`基坑支护小节：本工程采用${word}。`, model);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some(issue => issue.message.includes(word))).toBe(true);
  });
  it('F2 资料外词=资料内形式词时不报（灌注桩在资料中）', () => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '基坑支护形式为灌注桩' } } } as never });
    expect(supportFormFactConsistencyIssues('基坑支护小节：本工程采用灌注桩。', model)).toEqual([]);
  });
  it('F2 资料含地下连续墙时正文复用不报', () => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '地下连续墙' } } } as never });
    expect(supportFormFactConsistencyIssues('基坑支护采用地下连续墙。', model)).toEqual([]);
  });
});

describe('F3 supportFormFact 否定豁免', () => {
  const negations = ['不采用', '未采用', '不设置', '未设置', '不使用', '不宜采用', '不得采用', '不再出现', '不得出现', '严禁出现', '避免出现', '已删除', '取消'];
  it.each(negations)('F3 否定词“$0”+资料外词豁免', (negation) => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '基坑支护形式为土钉墙' } } } as never });
    const md = `本工程${negation}支护桩。基坑支护小节：采用土钉墙。`;
    expect(supportFormFactConsistencyIssues(md, model)).toEqual([]);
  });
  it('F3 否定词超出 12 字符窗口不豁免', () => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '基坑支护形式为土钉墙' } } } as never });
    const md = `本工程不采用${'、'.repeat(20)}支护桩。基坑支护小节：采用土钉墙。`;
    expect(supportFormFactConsistencyIssues(md, model).length).toBeGreaterThan(0);
  });
  it('F3 同句否定词生效（12 字符内）', () => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '基坑支护形式为土钉墙' } } } as never });
    expect(supportFormFactConsistencyIssues('本项目未采用冠梁结构。基坑支护采用土钉墙。', model)).toEqual([]);
  });
});

describe('F4 supportFormFact 反向完整性', () => {
  it('F4 资料形式未落地+正文有基坑语境→报', () => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '基坑支护形式为土钉墙' } } } as never });
    const issues = supportFormFactConsistencyIssues('基坑支护小节：按设计实施。', model);
    expect(issues.some(issue => issue.message.includes('支护形式未落地'))).toBe(true);
  });
  it('F4 资料形式未落地+正文无基坑语境→不报', () => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '基坑支护形式为土钉墙' } } } as never });
    expect(supportFormFactConsistencyIssues('本工程装饰装修方案。', model)).toEqual([]);
  });
  it('F4 多形式部分落地不报（放坡落地）', () => {
    const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '基坑支护形式为土钉墙+放坡' } } } as never });
    expect(supportFormFactConsistencyIssues('基坑支护小节：采用放坡。', model)).toEqual([]);
  });
  it('F4 无形式事实→不报', () => {
    expect(supportFormFactConsistencyIssues('基坑支护小节。', factsOf({}))).toEqual([]);
  });
});

// ── G. 设备进场时间 ──

describe('G1 equipmentEntry 设备词谱系提取', () => {
  const equipments = ['塔式起重机', '施工升降机', '施工电梯', '汽车起重机', '汽车吊', '混凝土泵车', '混凝土泵', '挖掘机', '装载机', '推土机', '压路机', '平地机', '空压机', '注浆机', '锚杆钻机', '混凝土喷射机', '喷射机', '吊篮', '钢筋加工设备', '塔吊'];
  it.each(equipments)('G1 设备“$0”进场词谱系', (equipment) => {
    const md = `${equipment}第100日进场。`;
    // 无总工期/基坑节点：提取正常但无矛盾判定
    expect(equipmentEntryTimingIssues(md, factsOf({}))).toEqual([]);
  });
  const verbs = ['进场', '投入使用', '安装', '调试'];
  it.each(verbs)('G1 进场词“$0”', (verb) => {
    const md = `挖掘机第100日${verb}。`;
    expect(equipmentEntryTimingIssues(md, factsOf({}))).toEqual([]);
  });
});

describe('G2 equipmentEntry 尾期进场阈值', () => {
  it('G2 第167日（79.5%）不报', () => {
    const md = '计划工期210日历天。塔式起重机第167日进场。';
    expect(equipmentEntryTimingIssues(md, factsOf({}))).toEqual([]);
  });
  it('G2 第168日（80%）报', () => {
    const md = '计划工期210日历天。塔式起重机第168日进场。';
    const issues = equipmentEntryTimingIssues(md, factsOf({}));
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('尾期进场');
  });
  it('G2 第210日（100%）报', () => {
    const md = '计划工期210日历天。塔式起重机第210日进场。';
    expect(equipmentEntryTimingIssues(md, factsOf({})).length).toBe(1);
  });
  const totalAnchors = ['计划工期', '合同工期', '总工期', '工期总日历天数'];
  it.each(totalAnchors)('G2 总工期锚点“$0”', (anchor) => {
    const md = `${anchor}210日历天。塔式起重机第200日进场。`;
    expect(equipmentEntryTimingIssues(md, factsOf({})).length).toBe(1);
  });
  it('G2 总工期来自 facts.schedule', () => {
    const model = factsOf({ schedule: [factOf({ value: '计划工期210日历天' })] });
    const md = '塔式起重机第200日进场。';
    expect(equipmentEntryTimingIssues(md, model).length).toBe(1);
  });
  it('G2 总工期 29 天不识别（域外）', () => {
    expect(equipmentEntryTimingIssues('计划工期29日历天。塔式起重机第20日进场。', factsOf({}))).toEqual([]);
  });
  it('G2 总工期 3001 天不识别（域外）', () => {
    expect(equipmentEntryTimingIssues('计划工期3001日历天。塔式起重机第20日进场。', factsOf({}))).toEqual([]);
  });
});

describe('G3 equipmentEntry 工序倒挂', () => {
  const pitEquipments = ['挖掘机', '空压机', '注浆机', '锚杆钻机', '混凝土喷射机', '喷射机', '推土机'];
  it.each(pitEquipments)('G3 基坑设备“$0”晚于基坑节点→报', (equipment) => {
    const md = `第100日完成基坑支护及土方外运。${equipment}第120日进场。`;
    const issues = equipmentEntryTimingIssues(md, factsOf({}));
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('工序倒挂');
  });
  it('G3 基坑设备与节点同日不报（不大于）', () => {
    const md = '第100日完成基坑支护及土方外运。挖掘机第100日进场。';
    expect(equipmentEntryTimingIssues(md, factsOf({}))).toEqual([]);
  });
  it('G3 基坑设备早于节点不报', () => {
    const md = '第100日完成基坑支护及土方外运。挖掘机第90日进场。';
    expect(equipmentEntryTimingIssues(md, factsOf({}))).toEqual([]);
  });
  it('G3 非基坑设备晚于节点不报', () => {
    const md = '第100日完成基坑支护及土方外运。塔式起重机第120日进场。';
    expect(equipmentEntryTimingIssues(md, factsOf({}))).toEqual([]);
  });
  it('G3 无基坑节点不判倒挂', () => {
    expect(equipmentEntryTimingIssues('挖掘机第120日进场。', factsOf({}))).toEqual([]);
  });
  it('G3 多基坑节点取最早', () => {
    const md = '第100日完成基坑支护及土方外运。第120日完成基坑支护及土方外运。挖掘机第110日进场。';
    // pitDone=min(100,120)=100，110>100 → 倒挂报
    expect(equipmentEntryTimingIssues(md, factsOf({})).length).toBe(1);
  });
  it('G3 设备名距进场词超 24 字符不提取', () => {
    const md = `第100日完成基坑支护及土方外运。挖掘机${'、'.repeat(25)}第120日进场。`;
    expect(equipmentEntryTimingIssues(md, factsOf({}))).toEqual([]);
  });
});

// ── H. 桩基表述残留 ──

describe('H1 foundationFormResidue 结构谱系', () => {
  it('H1 无地基与基础块不报', () => {
    const md = '桩基施工。桩基检测。桩基验收。';
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
  it('H1 块内含桩基工序词不报（本项目含桩）', () => {
    const md = '### 地基与基础\n本工程采用灌注桩。桩基施工流程。';
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
  const pileWords = ['桩基', '灌注桩', '钻孔桩', '打桩', '成桩', '桩机'];
  it.each(pileWords)('H1 块内工序词“$0”豁免', (word) => {
    const md = `### 地基与基础\n垫层施工，${word}工序。`;
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
  it('H1 块为筏板+全文桩基词 1 处不报（<2）', () => {
    const md = '### 地基与基础\n筏板基础施工。\n## 进度计划\n桩基检测。';
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
  it('H1 块为筏板+全文桩基词 2 处报', () => {
    const md = '### 地基与基础\n筏板基础施工。\n## 进度计划\n桩基检测。\n桩基验收。';
    const issues = foundationFormResidueIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('2 处');
  });
  it('H1 标题行桩基词不计入', () => {
    const md = '### 地基与基础\n筏板基础施工。\n#### 桩基施工方案\n';
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
  it('H1 桩基词去重后计处数（3 行 2 独有）', () => {
    const md = '### 地基与基础\n筏板基础施工。\n## 进度计划\n桩基施工。\n桩基施工。\n桩基检测。';
    const issues = foundationFormResidueIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('2 处');
  });
  it('H1 同文多行去重后仅 1 处不报', () => {
    const md = '### 地基与基础\n筏板基础施工。\n## 进度计划\n桩基施工。\n桩基施工。\n桩基施工。';
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
});

// ── I. 两可表述 ──

describe('I1 ambiguousEitherOr 形态 A 斜杠并列', () => {
  const slashHits = [
    '采用支护桩/放坡。',
    '基础形式为桩基础/独立基础。',
    '基坑采用钢板桩/排桩支护方案。',
    '本工程选用排桩/喷锚支护方式。',
    '支护体系为排桩/连续墙。',
    '基坑拟采用土钉墙/放坡开挖。',
  ];
  it.each(slashHits)('I1 斜杠两可“%#”→报', (md) => {
    expect(ambiguousEitherOrIssues(md).length).toBe(1);
  });
  const slashNegatives = [
    '主体结构木工/钢筋工施工。', // 无设计词
    '50mm/70mm。', // 数字枚举
    '钢板桩/槽钢挡护用于管线保护。', // 管线豁免
    '本工程钢板桩/槽钢挡护措施。', // 无决策词
  ];
  it.each(slashNegatives)('I1 斜杠豁免“%#”', (md) => {
    expect(ambiguousEitherOrIssues(md)).toEqual([]);
  });
  it('I1 归一化后带空格斜杠仍命中', () => {
    expect(ambiguousEitherOrIssues('采用支护桩 / 放坡。').length).toBe(1);
  });
});

describe('I2 ambiguousEitherOr 形态 B 括号悬置', () => {
  const pendingHits = [
    '桩基（或独立基础/筏板基础按图纸实施）。',
    '支护形式（或按图纸确定）。',
    '基坑支护（或待定）。',
    '基础形式（或另行确定）。',
    '支护体系（或视现场情况而定）。',
    '基坑支护（或根据实际确定）。',
  ];
  it.each(pendingHits)('I2 悬置“%#”→报', (md) => {
    expect(ambiguousEitherOrIssues(md).length).toBe(1);
  });
  const pendingNegatives = [
    '装饰风格（或按图纸实施）。', // 无设计词前缀
    '桩基施工质量（或按验收规范执行）。', // 括号内无悬置词
  ];
  it.each(pendingNegatives)('I2 悬置豁免“%#”', (md) => {
    expect(ambiguousEitherOrIssues(md)).toEqual([]);
  });
});

describe('I3 ambiguousEitherOr 形态 C 直陈两可', () => {
  const eitherOrHits = [
    '采用钢板桩或排桩。',
    '按专项方案放坡或支护。',
    '基坑选用喷锚或土钉墙。',
    '基础采用筏板或独立基础。',
    '基坑支护方案为排桩或连续墙。',
    '本工程拟采用灌注桩或支护桩。',
  ];
  it.each(eitherOrHits)('I3 直陈两可“%#”→报', (md) => {
    expect(ambiguousEitherOrIssues(md).length).toBe(1);
  });
  const eitherOrNegatives = [
    '土方开挖或回填前。', // 无决策词
    '集水井或排水沟设置。', // 无设计词
    '钢板桩或槽钢挡护用于管线保护。', // 管线豁免
    '施工顺序按现场进度安排。', // 「按」后无设计词
  ];
  it.each(eitherOrNegatives)('I3 直陈豁免“%#”', (md) => {
    expect(ambiguousEitherOrIssues(md)).toEqual([]);
  });
  it('I3 左组截取保留词族实义', () => {
    const issues = ambiguousEitherOrIssues('基坑采用地下连续墙或排桩支护。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('地下连续墙或排桩');
  });
});
