/**
 * 边界矩阵（P1 第 29 批 · FF 组）
 * 覆盖：coverage 报告提取的 documentIntegrityChecks.ts 未覆盖语句行精准选题——
 * 每条用例锚定一个此前从未执行的防御分支/豁免分支（L82/L128/L209/L323/L347/L544-550/
 * L1075/L1087/L1752/L1914-1916/L2012/L2235/L2609/L3013/L3037/L3120-3126/L3135/L3168/
 * L3186/L3196/L3198/L3217-3218/L3269/L3306/L3309/L3311/L3313/L3335/L3340/L3378/L3447/
 * L3510/L3523/L3618/L2038），断言按真实实现行为锁定。
 * 原则：每条用例独立断言意义；真实实现行为一律锁定，不迎合用例改实现。
 */
import { describe, expect, it } from 'vitest';
import {
  ambiguousEitherOrIssues,
  applyNumericConsistencyDeterministicFixes,
  areaArithmeticIssues,
  crossSectionNumericConflictIssues,
  extractAssemblyRateAuthority,
  extractGreeningMaintenanceAuthority,
  extractScheduleAuthority,
  fieldValueMismatchIssues,
  fixAdjacentPhraseDuplication,
  fixQuantityAuthorityConflicts,
  resourceConsistencyIssues,
  specLocationMismatchIssues,
  stripDuplicateTables,
  stripOverviewRecapBodyLines,
  tablePeakLabor,
} from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

const HUGE = '9'.repeat(400); // Number(HUGE) === Infinity

// ── FF1. fieldValueMismatchIssues：scopeValuePairs 无标签/无数值分支（L82） ──

describe('FF1 字段-数值错配：事实文本无标签或无数值', () => {
  it('FF1 fact 无面积标签 → 不提取 → 0 条', () => {
    const facts = factsOf({ project: [factOf({ value: '本工程建设规模约2.5亿元' })] });
    expect(fieldValueMismatchIssues('单体建筑面积 1000㎡。', facts)).toHaveLength(0);
  });
  it('FF1 fact 标签有面积词但值无面积单位（亩）→ 0 条', () => {
    const facts = factsOf({ project: [factOf({ key: '总占地面积', value: '约100亩' })] });
    expect(fieldValueMismatchIssues('单体建筑面积 1000㎡。', facts)).toHaveLength(0);
  });
  it('FF1 正常槽位混淆对照（检测器活性锚定）→ 1 条', () => {
    const facts = factsOf({ project: [factOf({ key: '总占地面积', value: '1000㎡' }), factOf({ key: '总建筑面积', value: '2000㎡' })] });
    const issues = fieldValueMismatchIssues('单体建筑面积 1000㎡。', facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('将总占地面积误作单体建筑面积');
  });
});

// ── FF2. areaArithmeticIssues：非有限数跳过（L128） ──

describe('FF2 面积算术：超长数字溢出为 Infinity', () => {
  it('FF2 地上面积为 400 位数字（Number=Infinity）→ 不报', () => {
    expect(areaArithmeticIssues(`地上${HUGE}㎡地下10㎡单体建筑面积20㎡`)).toHaveLength(0);
  });
  it('FF2 正常自洽算式对照（活性锚定）→ 0 条', () => {
    expect(areaArithmeticIssues('地上10㎡地下10㎡单体建筑面积20㎡')).toHaveLength(0);
  });
});

// ── FF3. chainPeaksOf：箭头前无语境词跳过（L209，经 resourceConsistencyIssues） ──

describe('FF3 劳动力箭头链：语境词被逗号阻断', () => {
  it('FF3 箭头前语境词被逗号阻断 → 链不成立 → 链值不入池 → 0 条', () => {
    expect(resourceConsistencyIssues('高峰10人，5人→8人。')).toHaveLength(0);
  });
  it('FF3 正常链对照（劳动力按5人→8人 取链峰值 8）→ 0 条', () => {
    expect(resourceConsistencyIssues('劳动力按5人→8人。')).toHaveLength(0);
  });
});

// ── FF4. tablePeakLabor：分隔行不在表头下一行（L323） ──

describe('FF4 劳动力表识别：分隔行位置异常', () => {
  it('FF4 分隔行在第 3 行（位置 2）→ 整表放弃 → undefined', () => {
    expect(tablePeakLabor('| 阶段 | 人数 |\n| 施工 | 20 |\n| --- | --- |')).toBeUndefined();
  });
});

// ── FF5. tablePeakLabor：数据行非纯数字单元格（L347） ──

describe('FF5 劳动力表识别：非数字单元格', () => {
  it('FF5 数据行人数列全为「约N人」形态 → 无有效数 → undefined', () => {
    expect(tablePeakLabor('| 施工准备阶段 | 劳动力人数 |\n| --- | --- |\n| 土方 | 约20人 |\n| 基础 | 约15人 |')).toBeUndefined();
  });
});

// ── FF6-FF8. resourceConsistencyIssues 班组算式三分支（L544/L548/L550） ──

describe('FF6 班组算式：无末位数字的段跳过（L544）', () => {
  it('FF6 「道路浇筑工人＋铺装6人=6人」无数字段跳过且加总自洽 → 0 条', () => {
    expect(resourceConsistencyIssues('道路浇筑工人＋铺装6人=6人。')).toHaveLength(0);
  });
  it('FF6 乘法项正常解析对照（2×4=8 参与求和）→ 0 条', () => {
    expect(resourceConsistencyIssues('道路浇筑8人＋机动2×4人=16人。')).toHaveLength(0);
  });
});

describe('FF7 班组算式：全部段无数字（L548）', () => {
  it('FF7 「工人＋普工=8人」左侧无任何数字 → 不检 → 0 条', () => {
    expect(resourceConsistencyIssues('工人＋普工=8人。')).toHaveLength(0);
  });
});

describe('FF8 班组算式：总数为 0 或 Infinity（L550）', () => {
  it('FF8 「=0人」total≤0 拦截 → 0 条', () => {
    expect(resourceConsistencyIssues('道路浇筑8人＋铺装2人=0人。')).toHaveLength(0);
  });
  it('FF8 总数 400 位数字（Infinity）拦截 → 0 条', () => {
    expect(resourceConsistencyIssues(`道路浇筑8人＋铺装2人=${HUGE}人。`)).toHaveLength(0);
  });
});

// ── FF9-FF10. stripOverviewRecapBodyLines：概况区间未闭合（L1075）/短句保留（L1087） ──

const alwaysSimilar = () => 0.9;

describe('FF9 概况复述清洗：概况区间未闭合', () => {
  it('FF9 「## 工程概况」到文末无同级标题 → 全区间保护 → 原样返回', () => {
    const markdown = '## 工程概况\n本项目为某市政道路工程。甲乙丙丁戊己庚辛壬癸。';
    expect(stripOverviewRecapBodyLines(markdown, alwaysSimilar)).toBe(markdown);
  });
});

describe('FF10 概况复述清洗：短句保留（L1087）', () => {
  it('FF10 「本项目为短句」7 字 <12 → 不判复述 → 保留', () => {
    const markdown = '## 工程概况\n本项目为某市政道路工程。甲乙丙丁戊己庚辛壬癸。子丑寅卯辰巳午未申酉戌亥。\n\n## 施工组织\n本项目为短句。';
    expect(stripOverviewRecapBodyLines(markdown, alwaysSimilar)).toContain('本项目为短句。');
  });
  it('FF10 「本工程为短句」6 字 <12 → 保留', () => {
    const markdown = '## 工程概况\n本项目为某市政道路工程。甲乙丙丁戊己庚辛壬癸。子丑寅卯辰巳午未申酉戌亥。\n\n## 施工组织\n本工程为短句。';
    expect(stripOverviewRecapBodyLines(markdown, alwaysSimilar)).toContain('本工程为短句。');
  });
});

// ── FF11. extractGreeningMaintenanceAuthority：中文数字无法解析（L1752） ──

describe('FF11 养护期提取：无法解析的中文数字', () => {
  it('FF11 「十一二」三字形态 → cnNumberToArabic undefined → 不提取', () => {
    const facts = factsOf({ bills: [factOf({ key: '喷播植草籽', value: '养护期十一二年' })] });
    expect(extractGreeningMaintenanceAuthority(facts)).toBeUndefined();
  });
  it('FF11 「二十三年」三字形态 → undefined', () => {
    const facts = factsOf({ bills: [factOf({ key: '喷播植草籽', value: '养护二十三年' })] });
    expect(extractGreeningMaintenanceAuthority(facts)).toBeUndefined();
  });
});

// ── FF12. qualifyLocationHit：实体限定词组合/不组合（L1914-1916，经 crossSectionNumericConflictIssues） ──

describe('FF12 部位实体限定词：组合与不组合', () => {
  it('FF12 限定词紧邻（gap 空）→ 「项目部驻地」vs「总协调驻地」不同实体 → 0 条', () => {
    expect(crossSectionNumericConflictIssues('项目部驻地灭火器4具。总协调驻地灭火器20具。')).toHaveLength(0);
  });
  it('FF12 gap「的」仍组合 → 「项目部的驻地」与「项目部驻地」同实体 → 报', () => {
    const issues = crossSectionNumericConflictIssues('项目部的驻地灭火器4具。项目部驻地灭火器20具。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('项目部驻地');
  });
  it('FF12 gap「施工区」3 字弱连接 → 组合 → 同实体 → 报', () => {
    expect(crossSectionNumericConflictIssues('项目部施工区驻地灭火器4具。项目部驻地灭火器20具。')).toHaveLength(1);
  });
  it('FF12 gap「远离」不组合 → 两处归「驻地」同组 → 报', () => {
    const issues = crossSectionNumericConflictIssues('项目部远离驻地灭火器4具。项目部远离驻地灭火器20具。');
    expect(issues).toHaveLength(1);
  });
});

// ── FF13. crossSectionNumericConflictIssues：Infinity 值过滤后不足两值（L2012） ──

describe('FF13 数值锚点：非有限值过滤', () => {
  it('FF13 同组两值其一为 400 位数字（Infinity 滤除）→ numbers 不足 2 → 不报', () => {
    expect(crossSectionNumericConflictIssues(`办公区灭火器${HUGE}具。办公区灭火器5具。`)).toHaveLength(0);
  });
  it('FF13 同组两值均为 Infinity → numbers 为空 → 不报', () => {
    expect(crossSectionNumericConflictIssues(`办公区灭火器${HUGE}具。办公区灭火器${'8'.repeat(400)}具。`)).toHaveLength(0);
  });
});

// ── FF14. ambiguousEitherOrIssues：管线保护语境豁免（L2235） ──

describe('FF14 两可表述：管线豁免窗口', () => {
  it('FF14 「管线保护采用钢板桩或槽钢挡护」→ 管线词在窗口 → 豁免 0 条', () => {
    expect(ambiguousEitherOrIssues('管线保护采用钢板桩或槽钢挡护。')).toHaveLength(0);
  });
  it('FF14 无管线词对照 → 报', () => {
    expect(ambiguousEitherOrIssues('采用钢板桩或槽钢挡护。')).toHaveLength(1);
  });
});

// ── FF15. stripDuplicateTables：全空行触发 jaccard 空数组（L2609） ──

describe('FF15 表格去重：空单元格行', () => {
  it('FF15 表间全空行（||）rowCells=[] → jaccard 返回 0 不崩溃，重复表仍删除', () => {
    const markdown = '| 表头A | 表头B |\n| --- | --- |\n| x | y |\n||\n| 表头A | 表头B |\n| --- | --- |\n| x | y |';
    const result = stripDuplicateTables(markdown);
    expect(result.removedCount).toBe(3);
    expect((result.markdown.match(/表头A/g) || []).length).toBe(1);
    expect(result.markdown).toContain('||');
  });
});

// ── FF16. fixLaborPeakConflicts：非有限峰值/控制上限跳过（L3013/L3037，经 applyNumeric 管线） ──

describe('FF16 劳动力峰值修复：非有限数值', () => {
  it('FF16 「高峰400位数字人」Infinity → 不替换', () => {
    const result = applyNumericConsistencyDeterministicFixes(`高峰期约${HUGE}人。`, { laborPeakAuthority: 186 });
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain(HUGE);
  });
  it('FF16 「劳动力按400位数字人」反向口径 Infinity → 不替换', () => {
    const result = applyNumericConsistencyDeterministicFixes(`劳动力按${HUGE}人配置。`, { laborPeakAuthority: 186 });
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain(HUGE);
  });
  it('FF16 「高峰控制在400位数字人以内」控制上限 Infinity → 不替换', () => {
    const result = applyNumericConsistencyDeterministicFixes(`高峰期人数控制在${HUGE}人以内。`, { laborPeakAuthority: 186 });
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain(HUGE);
  });
});

// ── FF17. stageKeysOf 七分支（L3120-3126，经 fixNodeScheduleConflicts 权威表+非权威表对齐） ──

describe('FF17 节点工期修复：行名归类七分支', () => {
  const cases = [
    { label: 'cleanup', rowName: '竣工清理与预验收' },
    { label: 'completion', rowName: '竣工验收' },
    { label: 'decoration', rowName: '装饰装修及幕墙' },
    { label: 'mep', rowName: '机电安装' },
    { label: 'secondary', rowName: '二次结构与ALC墙板' },
    { label: 'topping', rowName: '主体结构封顶' },
    { label: 'excavation', rowName: '土方开挖与基坑支护' },
  ];
  it.each(cases)('FF17 行名「$rowName」→ 权威 100 对齐替换非权威表 80', ({ rowName }) => {
    const markdown = [
      '## 总进度计划',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      `| ${rowName} | 第100日 |`,
      // 非权威表块前 6 行窗口内不得含「总进度计划」标题（headerProbe 窗口），空行拉远
      '', '', '', '', '', '', '',
      '## 其他表',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      `| ${rowName} | 第80日 |`,
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).not.toContain('第80日');
    expect((result.markdown.match(/第100日/g) || []).length).toBe(2);
  });
  it('FF17 七行权威表 + 七行非权威表 → 一次对齐 7 处', () => {
    const rows = cases.map(item => item.rowName);
    const authority = ['## 总进度计划', '| 节点 | 完成日 |', '| --- | --- |', ...rows.map(name => `| ${name} | 第100日 |`)];
    const other = ['## 其他表', '| 节点 | 完成日 |', '| --- | --- |', ...rows.map(name => `| ${name} | 第80日 |`)];
    const result = applyNumericConsistencyDeterministicFixes([...authority, '', ...other].join('\n'));
    expect(result.fixedCount).toBe(7);
    expect(result.markdown).not.toContain('第80日');
  });
});

// ── FF18. lastDayOf：相对量豁免（L3135）+ 无权威不替换（L3196） ──

describe('FF18 节点工期修复：相对量完成日不作为权威', () => {
  it('FF18 权威表行「竣工验收合格后第90日」相对量 → 不建权威 → 正文第90日不动', () => {
    const markdown = [
      '## 总进度计划',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 竣工验收 | 竣工验收合格后第90日 |',
      '',
      '竣工验收节点第90日。',
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('竣工验收节点第90日');
  });
});

// ── FF19. nodeAuthorities 非法 offset（L3168） ──

describe('FF19 外部节点权威注入：非法 offset', () => {
  it('FF19 offset「第0日」day<1 → 不注入 → 正文不动', () => {
    const result = applyNumericConsistencyDeterministicFixes('第80日完成主体结构封顶。', {
      nodeAuthorities: [{ node: '主体结构封顶', offset: '第0日' }],
    });
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('第80日');
  });
});

// ── FF20. 非权威表行名无节点词（L3186） ──

describe('FF20 节点工期修复：行名无节点词', () => {
  it('FF20 「其他工作」行 stageKeysOf 为空 → 不对齐 → 第80日保留', () => {
    const markdown = [
      '## 总进度计划',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 主体结构封顶 | 第100日 |',
      // 非权威表块前 6 行窗口不得含「总进度计划」标题
      '', '', '', '', '', '', '',
      '## 其他表',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 其他工作 | 第80日 |',
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('| 其他工作 | 第80日 |');
  });
});

// ── FF21. 正文节点无权威（L3196） ──

describe('FF21 节点工期修复：正文节点无权威', () => {
  it('FF21 权威表只有封顶 → 正文「基坑支护完成第90日」无 excavation 权威 → 不动', () => {
    const markdown = [
      '## 总进度计划',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 主体结构封顶 | 第100日 |',
      '',
      '基坑支护施工完成第90日。',
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('基坑支护施工完成第90日');
  });
});

// ── FF22. 权威表行内节点句（L3198） ──

describe('FF22 节点工期修复：权威表行内的节点句不替换', () => {
  it('FF22 权威表行「第311日完成主体结构封顶，第320日」→ 句在权威 span 内 → 311 不动', () => {
    const markdown = [
      '## 总进度计划',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 主体结构封顶 | 第311日完成主体结构封顶，第320日 |',
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('第311日完成主体结构封顶');
  });
});

// ── FF23. 形态 B 倒序式替换（L3217/L3218） ──

describe('FF23 节点工期修复：形态 B 倒序式', () => {
  it('FF23 「基坑支护及土方外运施工完成第90日」→ excavation 权威 120', () => {
    const markdown = [
      '## 总进度计划',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 基坑支护及土方外运 | 第120日 |',
      '',
      '基坑支护及土方外运施工完成第90日。',
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('完成第120日');
  });
  it('FF23 「室外工程及竣工验收完成第200日」→ completion 权威 300', () => {
    const markdown = [
      '## 总进度计划',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 室外工程及竣工验收 | 第300日 |',
      '',
      '室外工程及竣工验收完成第200日。',
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('完成第300日');
  });
});

// ── FF24-FF27. fixCrossSectionNumericConflicts 各豁免分支 ──

describe('FF24 数量修复：一轮非有限跳过（L3269）', () => {
  it('FF24 正文「灭火器400位数字具」Infinity → 无候选 → 不修', () => {
    const result = applyNumericConsistencyDeterministicFixes(`| 灭火器 | 12具 |\n现场配置灭火器${HUGE}具。`);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain(HUGE);
  });
});

describe('FF25 数量修复：二轮非有限跳过（L3309）', () => {
  it('FF25 正文有候选「4具」时，另一匹配为 Infinity → 只修 4 具，Infinity 保留', () => {
    const result = applyNumericConsistencyDeterministicFixes(`| 灭火器 | 12具 |\n现场配置灭火器4具。另备灭火器${HUGE}具。`);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('灭火器12具');
    expect(result.markdown).toContain(`灭火器${HUGE}具`);
  });
});

describe('FF26 数量修复：否定声明句豁免（L3306）', () => {
  it('FF26 「不再出现」行整行豁免，同文另一候选仍修复', () => {
    const result = applyNumericConsistencyDeterministicFixes('| 灭火器 | 12具 |\n现场配置灭火器4具。\n灭火器2具，不再出现其他口径。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('灭火器12具');
    expect(result.markdown).toContain('灭火器2具，不再出现其他口径');
  });
});

describe('FF27 数量修复：正文部位组豁免（L3311）', () => {
  it('FF27 「办公区灭火器2具」部位组非空 → 不归一，未标注 4 具仍修', () => {
    const result = applyNumericConsistencyDeterministicFixes('| 灭火器 | 12具 |\n现场配置灭火器4具。办公区灭火器2具。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('灭火器12具');
    expect(result.markdown).toContain('办公区灭火器2具');
  });
});

describe('FF28 数量修复：众数兜底带部位表格行跳过（L3313）', () => {
  it('FF28 未标注表格 12/12/2 众数=12 → 未标注 2 归一，带部位行 2 保留', () => {
    const markdown = [
      '| 灭火器 | 12具 |',
      '| 灭火器 | 12具 |',
      '| 灭火器 | 2具 |',
      '| 办公区 | 灭火器 | 2具 |',
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown);
    expect(result.fixedCount).toBe(1);
    expect((result.markdown.match(/^\| 灭火器 \| 2具 \|$/gm) || []).length).toBe(0);
    expect(result.markdown).toContain('| 办公区 | 灭火器 | 2具 |');
    expect((result.markdown.match(/12具/g) || []).length).toBe(3);
  });
});

// ── FF29-FF30. code 锚点修复轮 ──

describe('FF29 code 锚点：否定声明句豁免（L3335）', () => {
  it('FF29 「不再出现」行 C20 不动，另一行 C30→C15', () => {
    const result = applyNumericConsistencyDeterministicFixes('垫层C20浇筑，不再出现C35标号。\n垫层C30浇筑。', {
      codeAuthorities: { cushion: 'C15' },
    });
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('垫层C20浇筑');
    expect(result.markdown).toContain('垫层C15浇筑');
  });
});

describe('FF30 code 锚点：权威值一致跳过（L3340）', () => {
  it('FF30 「垫层C15」已与权威一致 → 不动，仅 C20→C15', () => {
    const result = applyNumericConsistencyDeterministicFixes('垫层C15浇筑。垫层C20浇筑。', {
      codeAuthorities: { cushion: 'C15' },
    });
    expect(result.fixedCount).toBe(1);
    expect((result.markdown.match(/垫层C15浇筑/g) || []).length).toBe(2);
  });
});

// ── FF31. fixQuantityAuthorityConflicts：名称元字符转义（L3378） ──

describe('FF31 清单权威修复：名称含正则元字符', () => {
  it('FF31 名称「C.1项铺装」点号转义 → 字面匹配修复 50→100', () => {
    const result = fixQuantityAuthorityConflicts('C.1项铺装 50m。', [{ name: 'C.1项铺装', value: 100, unit: 'm' }]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('C.1项铺装 100m');
  });
  it('FF31 名称「A+B铺装」加号转义 → 字面匹配修复 5→100', () => {
    const result = fixQuantityAuthorityConflicts('A+B铺装 5m。', [{ name: 'A+B铺装', value: 100, unit: 'm' }]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('A+B铺装 100m');
  });
});

// ── FF32. fixQuantityAuthorityConflicts：窗口值 Infinity（L3447） ──

describe('FF32 清单权威修复：窗口数值 Infinity', () => {
  it('FF32 正文值为 400 位数字 → best 不更新 → 不修', () => {
    const result = fixQuantityAuthorityConflicts(`塑料管铺设 ${HUGE}m。`, [{ name: '塑料管铺设', value: 100, unit: 'm' }]);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain(HUGE);
  });
});

// ── FF33. extractScheduleAuthority：canonical 条目无工期标签（L3510） ──

describe('FF33 计划工期权威：canonical 标签过滤', () => {
  it('FF33 canonical 首条目无工期标签跳过 → 次条目「210日历天」提取', () => {
    const facts = factsOf({
      canonical: {
        schedule: {
          a: [{ label: '节点安排', value: '第100日' }],
          b: [{ label: '计划工期', value: '210日历天' }],
        },
      } as never,
    });
    expect(extractScheduleAuthority(facts)).toBe(210);
  });
  it('FF33 canonical 全部条目无工期标签 → undefined', () => {
    const facts = factsOf({ canonical: { schedule: { a: [{ label: '节点', value: '第100日' }] } } as never });
    expect(extractScheduleAuthority(facts)).toBeUndefined();
  });
});

// ── FF34. extractAssemblyRateAuthority：值无百分比（L3523） ──

describe('FF34 装配率权威：无百分比数值', () => {
  it('FF34 装配率事实值为定性表述 → undefined', () => {
    const facts = factsOf({ project: [factOf({ key: '装配率', value: '满足装配式建筑要求' })] });
    expect(extractAssemblyRateAuthority(facts)).toBeUndefined();
  });
  it('FF34 tenderRequirements 装配率文本无 % → undefined', () => {
    const facts = factsOf({ tenderRequirements: { assemblyRate: { text: '装配率不低于政策要求' } } } as never);
    expect(extractAssemblyRateAuthority(facts)).toBeUndefined();
  });
});

// ── FF35. fixAdjacentPhraseDuplication：纯字母块不折叠（L3618） ──

describe('FF35 粘连清洗：无数字无中文块', () => {
  it('FF35 「abababab」块无数字无中文 → 不折叠', () => {
    const result = fixAdjacentPhraseDuplication('abababab。');
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe('abababab。');
  });
});

// ── FF36. specLocationMismatchIssues：B 标号规格类型（L2038） ──

describe('FF36 规格错位：B 标号类型', () => {
  const map = { 砌块: [{ location: '垫层', spec: 'B5', sourceFile: '清单' }, { location: '垫层', spec: 'B5', sourceFile: '清单' }] };
  it('FF36 正文「垫层B3」与权威 B5 不一致 → 报', () => {
    const issues = specLocationMismatchIssues('垫层采用B3砌块砌筑。', map);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('B5');
  });
  it('FF36 正文「垫层B5」与权威一致 → 0 条', () => {
    expect(specLocationMismatchIssues('垫层采用B5砌块砌筑。', map)).toHaveLength(0);
  });
});
