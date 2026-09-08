/**
 * 检测器族边界矩阵（P1 第 7 批）
 * 覆盖：A 编造日期/字段错配/面积算术；B 劳动力表格提取与资源一致性 7 模式；
 * C 支护体系（权威裁决+语义冲突+确定性修复）；D 危大清单/语义采样/六百分百/属地适配；
 * E 段首重复/概况复述/闭环密度/自伤/叠词/残行/装饰厚度/劳动力峰值/收敛工具。
 * 原则：每条用例独立断言意义；真实实现行为一律锁定（探针先行确认），不改实现迎合用例；
 * 语义类检测用共享词模拟器（与检测器词表同源），恒值模拟器锁定词面兜底通道。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  areaArithmeticIssues, bodySentencesForSemantic, closurePhraseDensityCapIssues,
  collapseRepeatedWords, dangerousListConsistencyIssues, extractSupportSystemAuthority,
  fabricatedStartDateIssues, fieldValueMismatchIssues, finishThicknessIssues,
  fixFinishThickness, fixLaborPeakConflict, fixSupportSystemConflicts,
  laborPeakConflictIssues, localAdaptationKeywordIssues, mergeTableLineResidues,
  overviewRecapCandidates, overviewRecapIssues, paragraphOpeningRepeatIssues,
  REPEATED_WORD_RE, repeatedWordIssues, resourceConsistencyIssues,
  runDeterministicChainUntilConverged, runFixUntilClean, selfUnderminingCandidateIssues,
  sixHundredPercentCoverageIssues, stripOverviewRecapBodyLines,
  supportSystemConflictIssues, tablePeakLabor, tablePeakLaborWithChainFallback,
} from '@/services/document-workflow/documentIntegrityChecks';
import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';
import type { DocumentFact, DocumentFactsModel, ValidationIssue } from '@/services/document-workflow/types';
import { factOf, factsOf } from './boundaryKit';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

/** 共享词语义模拟器：left/right 共享任一领域词即 0.9（与各检测器词表同源） */
const DETECTOR_KW = [
  '围挡', '覆盖', '冲洗', '硬化', '湿法', '密闭',
  '土钉', '放坡', '喷锚', '灌注桩', '排桩', '地下连续墙',
  '优质工程', '标准化工地', '非传统水源', '回收率', '工伤保险',
  '尚未完成', '缺口', '跟踪完善',
] as const;
const SHARED_WORD_SIM = async (_leftTexts: string[], _rightTexts: string[]) => (left: string, right: string): number => {
  if (left === right) return 1;
  return DETECTOR_KW.some(word => left.includes(word) && right.includes(word)) ? 0.9 : 0.1;
};
/** 恒值语义模拟器：锁定词面兜底/语义独立通道 */
const CONST_SIM = (value: number) => async (_leftTexts: string[], _rightTexts: string[]) => (_l: string, _r: string): number => value;

beforeEach(() => {
  vi.mocked(buildSemanticSimilarity).mockImplementation(SHARED_WORD_SIM);
});

/** 锚定单条 issue 的断言辅助 */
const expectBlockIssue = (issues: ValidationIssue[], messagePart: string) => {
  expect(issues.length).toBeGreaterThan(0);
  expect(issues[0].message).toContain(messagePart);
};

// ── A. 编造日期 / 字段错配 / 面积算术（同步确定性） ──

describe('A1 fabricatedStartDateIssues 编造开工日期', () => {
  it('A1 资料无日期正文有日期 → 报编造', () => {
    const issues = fabricatedStartDateIssues('本工程于2026年3月1日开工。', factsOf({}));
    expectBlockIssue(issues, '编造开工日期“2026年3月1日”');
    expect(issues[0].level).toBe('error');
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].category).toBe('fact_consistency');
  });
  it('A1 资料日期与正文一致 → 不报', () => {
    const facts = factsOf({ project: [factOf({ key: 'p', value: '开工日期2026年3月1日' })] });
    expect(fabricatedStartDateIssues('本工程于2026年3月1日开工。', facts)).toEqual([]);
  });
  it('A1 宽松空格格式归一（2026 年 3 月 1 日）→ 不报', () => {
    const facts = factsOf({ project: [factOf({ key: 'p', value: '开工日期2026年3月1日' })] });
    expect(fabricatedStartDateIssues('本工程于2026 年 3 月 1 日开工。', facts)).toEqual([]);
  });
  it('A1 资料有其他日期+正文进度节点锚点词 → 豁免跳过', () => {
    const facts = factsOf({ project: [factOf({ key: 'p', value: '开工日期2026年5月1日' })] });
    const issues = fabricatedStartDateIssues('施工进度里程碑节点为2026年6月1日完成主体结构封顶。', facts);
    expect(issues).toEqual([]);
  });
  it('A1 资料有其他日期+正文无锚点 → 报', () => {
    const facts = factsOf({ project: [factOf({ key: 'p', value: '开工日期2026年5月1日' })] });
    const issues = fabricatedStartDateIssues('2026年6月1日组织竣工验收。', facts);
    expectBlockIssue(issues, '编造开工日期“2026年6月1日”');
  });
  it('A1 无资料日期+锚点词 → 仍报（锚点豁免仅限资料已有日期）', () => {
    const issues = fabricatedStartDateIssues('施工进度里程碑节点为2026年6月1日完成主体结构封顶。', factsOf({}));
    expectBlockIssue(issues, '编造开工日期');
  });
  it('A1 前导零不归一（2026年03月01日 ≠ 2026年3月1日）→ 报', () => {
    const facts = factsOf({ project: [factOf({ key: 'p', value: '开工日期2026年03月01日' })] });
    const issues = fabricatedStartDateIssues('本工程于2026年3月1日开工。', facts);
    expectBlockIssue(issues, '编造开工日期');
  });
  it('A1 同日期两处各报一条', () => {
    const issues = fabricatedStartDateIssues('2026年3月1日开工，2026年3月1日竣工。', factsOf({}));
    expect(issues).toHaveLength(2);
  });
  it('A1 超过 3 处截断 slice(0,3)', () => {
    const md = '2026年3月1日。2026年4月1日。2026年5月1日。2026年6月1日。';
    expect(fabricatedStartDateIssues(md, factsOf({}))).toHaveLength(3);
  });
  it('A1 fieldName+value 拼接提取资料日期', () => {
    const facts = factsOf({ project: [factOf({ fieldName: '计划开工日期', value: '2026年3月1日' })] });
    expect(fabricatedStartDateIssues('本工程于2026年3月1日开工。', facts)).toEqual([]);
  });
  it('A1 preciseFacts 数组也入资料日期池', () => {
    const facts = factsOf({ preciseFacts: [factOf({ value: '竣工日期2026年9月1日' })] });
    expect(fabricatedStartDateIssues('本工程于2026年9月1日竣工。', facts)).toEqual([]);
  });
  it('A1 非日历形态（2026-03-01）不匹配 → 不报', () => {
    expect(fabricatedStartDateIssues('开工日期2026-03-01，以开工令为准。', factsOf({}))).toEqual([]);
  });
});

describe('A2 fieldValueMismatchIssues 字段-数值错配', () => {
  const siteBuildingFacts = (): DocumentFactsModel => factsOf({
    project: [
      factOf({ fieldName: '总占地面积', value: '50000㎡' }),
      factOf({ fieldName: '总建筑面积', value: '30000㎡' }),
    ],
  });
  it('A2 总建筑面积被误标为总占地面积值 → 报', () => {
    const issues = fieldValueMismatchIssues('本项目总建筑面积50000㎡。', siteBuildingFacts());
    expectBlockIssue(issues, '字段-数值错配');
    expect(issues[0].message).toContain('30000');
  });
  it('A2 正确建筑数值 → 不报', () => {
    expect(fieldValueMismatchIssues('本项目总建筑面积30000㎡。', siteBuildingFacts())).toEqual([]);
  });
  it('A2 双集交叠（占地=建筑同值）→ 合法不报', () => {
    const facts = factsOf({ project: [factOf({ fieldName: '总占地面积', value: '50000㎡' }), factOf({ fieldName: '总建筑面积', value: '50000㎡' })] });
    expect(fieldValueMismatchIssues('本项目总建筑面积50000㎡。', facts)).toEqual([]);
  });
  it('A2 资料无占地面积 → 早退不报', () => {
    const facts = factsOf({ project: [factOf({ fieldName: '总建筑面积', value: '30000㎡' })] });
    expect(fieldValueMismatchIssues('本项目总建筑面积30000㎡。', facts)).toEqual([]);
  });
  it('A2 资料无建筑面积 → 早退不报', () => {
    const facts = factsOf({ project: [factOf({ fieldName: '总占地面积', value: '50000㎡' })] });
    expect(fieldValueMismatchIssues('本项目总建筑面积50000㎡。', facts)).toEqual([]);
  });
  it('A2 地上/地下建筑面积不进建筑值集合 → 不报', () => {
    const facts = factsOf({ project: [factOf({ fieldName: '总占地面积', value: '50000㎡' }), factOf({ fieldName: '地上建筑面积', value: '20000㎡' })] });
    expect(fieldValueMismatchIssues('本项目总建筑面积50000㎡。', facts)).toEqual([]);
  });
  it.each(['m2', 'm²', '平方米'])('A2 单位变体 %s 命中', (unit) => {
    const issues = fieldValueMismatchIssues(`本项目总建筑面积50000${unit}。`, siteBuildingFacts());
    expectBlockIssue(issues, '字段-数值错配');
  });
  it('A2 千分位数值解析命中', () => {
    const issues = fieldValueMismatchIssues('本项目总建筑面积50,000㎡。', siteBuildingFacts());
    expectBlockIssue(issues, '字段-数值错配');
  });
  it('A2 标签后 31 字窗口外 → 不匹配', () => {
    const padding = '建'.repeat(31);
    expect(fieldValueMismatchIssues(`本项目总建筑面积${padding}50000㎡。`, siteBuildingFacts())).toEqual([]);
  });
  it('A2 零值跳过', () => {
    expect(fieldValueMismatchIssues('本项目总建筑面积0㎡。', siteBuildingFacts())).toEqual([]);
  });
  it('A2 单体建筑面积标签也命中', () => {
    const issues = fieldValueMismatchIssues('本项目单体建筑面积50000㎡。', siteBuildingFacts());
    expectBlockIssue(issues, '字段-数值错配');
  });
  it('A2 正文占地面积表述不匹配检测标签 → 不报', () => {
    expect(fieldValueMismatchIssues('本项目占地面积50000㎡。', siteBuildingFacts())).toEqual([]);
  });
  it('A2 超过 3 处截断 slice(0,3)', () => {
    const md = '总建筑面积50000㎡。总建筑面积50000㎡。总建筑面积50000㎡。总建筑面积50000㎡。';
    expect(fieldValueMismatchIssues(md, siteBuildingFacts())).toHaveLength(3);
  });
});

describe('A3 areaArithmeticIssues 面积算术一致性', () => {
  it('A3 地上+地下≠总建筑面积 → 报', () => {
    const issues = areaArithmeticIssues('地上建筑面积30000㎡，地下建筑面积10000㎡，总建筑面积50000㎡。');
    expectBlockIssue(issues, '面积算术矛盾');
    expect(issues[0].message).toContain('50000');
  });
  it('A3 自洽三元组 → 不报', () => {
    expect(areaArithmeticIssues('地上30000㎡，地下10000㎡，总建筑面积40000㎡。')).toEqual([]);
  });
  it('A3 tolerance 内差异 → 不报（total*0.001）', () => {
    expect(areaArithmeticIssues('地上30001㎡，地下10000㎡，总建筑面积40000㎡。')).toEqual([]);
  });
  it('A3 超 tolerance → 报', () => {
    expect(areaArithmeticIssues('地上30000㎡，地下10000㎡，总建筑面积40050㎡。')).toHaveLength(1);
  });
  it('A3 单体建筑面积标签命中', () => {
    expectBlockIssue(areaArithmeticIssues('地上20000㎡，地下10000㎡，单体建筑面积35000㎡。'), '面积算术矛盾');
  });
  it('A3 千分位解析自洽 → 不报', () => {
    expect(areaArithmeticIssues('地上30,000㎡，地下10,000㎡，总建筑面积40,000㎡。')).toEqual([]);
  });
  it('A3 无地下面积 → 不报', () => {
    expect(areaArithmeticIssues('地上30000㎡，总建筑面积30000㎡。')).toEqual([]);
  });
  it('A3 多句各自独立计算 → 两条', () => {
    const md = '地上30000㎡，地下10000㎡，总建筑面积50000㎡。地上20000㎡，地下10000㎡，总建筑面积35000㎡。';
    expect(areaArithmeticIssues(md)).toHaveLength(2);
  });
  it('A3 超过 3 处截断 slice(0,3)', () => {
    const md = '地上30000㎡，地下10000㎡，总建筑面积50000㎡。'.repeat(4);
    expect(areaArithmeticIssues(md)).toHaveLength(3);
  });
});

// ── B. 劳动力表格提取与资源一致性 7 模式（同步确定性） ──

describe('B1 tablePeakLabor 劳动力表峰值', () => {
  const standardTable = (rows: string[]) => ['| 施工阶段 | 投入人数 |', '| --- | --- |', ...rows].join('\n');
  it('B1 标准表峰值 186', () => {
    expect(tablePeakLabor(standardTable(['| 施工准备 | 62 |', '| 主体结构 | 186 |', '| 装饰装修 | 95 |']))).toBe(186);
  });
  it('B1 高峰列优先于平均列', () => {
    const md = ['| 施工阶段 | 阶段平均人数 | 阶段高峰人数 |', '| --- | --- | --- |', '| 主体结构 | 190 | 230 |'].join('\n');
    expect(tablePeakLabor(md)).toBe(230);
  });
  it('B1 无分隔行双列表头（首行即表头）', () => {
    const md = ['| 施工阶段 | 人数 |', '| 主体结构 | 186 |', '| 装饰装修 | 95 |'].join('\n');
    expect(tablePeakLabor(md)).toBe(186);
  });
  it('B1 岗位配置表排除（岗位+职责）', () => {
    const md = ['| 岗位 | 人数 | 职责 |', '| --- | --- | --- |', '| 项目经理 | 1 | 全面负责 |'].join('\n');
    expect(tablePeakLabor(md)).toBeUndefined();
  });
  it('B1 工种明细表排除（hasTradeCol）', () => {
    const md = ['| 工种 | 人数 |', '| --- | --- |', '| 普工 | 34 |'].join('\n');
    expect(tablePeakLabor(md)).toBeUndefined();
  });
  it('B1 合计行不计入表峰值', () => {
    expect(tablePeakLabor(standardTable(['| 施工准备 | 10 |', '| 主体结构 | 20 |', '| 合计 | 33 |']))).toBe(20);
  });
  it('B1 多表取最大', () => {
    const md = `${standardTable(['| 主体结构 | 100 |'])}\n\n${standardTable(['| 主体结构 | 200 |'])}`;
    expect(tablePeakLabor(md)).toBe(200);
  });
  it('B1 空表（无数据行）→ undefined', () => {
    expect(tablePeakLabor(standardTable([]))).toBeUndefined();
  });
  it('B1 阶段列与人数列同列 → 跳过', () => {
    const md = ['| 阶段投入人数 |', '| --- |', '| 62 |'].join('\n');
    expect(tablePeakLabor(md)).toBeUndefined();
  });
  it('B1 表头无人数列 → undefined', () => {
    const md = ['| 分部 | 内容 |', '| --- | --- |', '| 一 | 说明 |'].join('\n');
    expect(tablePeakLabor(md)).toBeUndefined();
  });
  it('B1 数据单元格带人字解析', () => {
    expect(tablePeakLabor(standardTable(['| 主体结构 | 186人 |']))).toBe(186);
  });
  it('B1 千分位单元格解析', () => {
    expect(tablePeakLabor(standardTable(['| 主体结构 | 1,860 |']))).toBe(1860);
  });
});

describe('B2 tablePeakLaborWithChainFallback 链回退', () => {
  it('B2 表存在 → 表峰值优先', () => {
    const md = ['| 施工阶段 | 投入人数 |', '| --- | --- |', '| 主体结构 | 186 |'].join('\n');
    expect(tablePeakLaborWithChainFallback(md)).toBe(186);
  });
  it('B2 无表 → 正文总口径峰值', () => {
    expect(tablePeakLaborWithChainFallback('高峰期投入220人。装饰装修阶段高峰期90人。')).toBe(220);
  });
  it('B2 全部峰值带阶段限定 → undefined', () => {
    expect(tablePeakLaborWithChainFallback('主体结构阶段高峰期220人。装饰装修阶段高峰期90人。')).toBeUndefined();
  });
  it('B2 混合口径只取总口径最大值', () => {
    expect(tablePeakLaborWithChainFallback('高峰期220人。装饰装修阶段高峰期300人。')).toBe(220);
  });
  it('B2 无表无峰值 → undefined', () => {
    expect(tablePeakLaborWithChainFallback('施工管理规范。')).toBeUndefined();
  });
  it('B2 约形态数值', () => {
    expect(tablePeakLaborWithChainFallback('高峰期约220人。')).toBe(220);
  });
  it('B2 千分位数值', () => {
    expect(tablePeakLaborWithChainFallback('高峰期1,200人。')).toBe(1200);
  });
});

describe('B3 resourceConsistencyIssues 模式1 正文峰值互查', () => {
  it('B3 同组无阶段相差>30% → 报', () => {
    const issues = resourceConsistencyIssues('高峰期投入220人。高峰期投入80人。');
    expectBlockIssue(issues, '劳动力数据矛盾');
    expect(issues[0].message).toContain('相差 64%');
  });
  it('B3 相差≤30% → 不报', () => {
    expect(resourceConsistencyIssues('高峰期投入220人。高峰期投入180人。')).toEqual([]);
  });
  it('B3 管理口径 vs 峰值口径 → 不互查', () => {
    expect(resourceConsistencyIssues('劳动力配置管理人员18人，高峰期286人。')).toEqual([]);
  });
  it('B3 不同工种 → 不互查', () => {
    expect(resourceConsistencyIssues('劳动力投入钢筋工60人，劳动力投入木工80人。')).toEqual([]);
  });
  it('B3 同工种相差>30% → 报', () => {
    const issues = resourceConsistencyIssues('劳动力投入钢筋工60人，劳动力投入钢筋工20人。');
    expectBlockIssue(issues, '劳动力数据矛盾');
  });
  it('B3 同工种接近 → 不报', () => {
    expect(resourceConsistencyIssues('劳动力投入钢筋工60人，劳动力投入钢筋工55人。')).toEqual([]);
  });
  it('B3 不同阶段 → 不互查', () => {
    expect(resourceConsistencyIssues('地下结构阶段高峰期220人。室外工程阶段高峰期90人。')).toEqual([]);
  });
  it('B3 同阶段不同值 → 报', () => {
    const issues = resourceConsistencyIssues('地下结构阶段高峰期220人。地下结构阶段高峰期80人。');
    expectBlockIssue(issues, '劳动力数据矛盾');
  });
  it('B3 总口径≥阶段口径90% → 正常不报', () => {
    expect(resourceConsistencyIssues('高峰期总人数180人。室外工程阶段高峰90人。')).toEqual([]);
  });
  it('B3 总口径<阶段口径90%且>30% → 报', () => {
    const issues = resourceConsistencyIssues('高峰期总人数60人。室外工程阶段高峰90人。');
    expectBlockIssue(issues, '劳动力数据矛盾');
  });
  it('B3 表格行内数值不入池', () => {
    const md = ['| 施工准备 | 高峰期62人 |', '高峰期80人。'].join('\n');
    expect(resourceConsistencyIssues(md)).toEqual([]);
  });
  it('B3 多组冲突只报第一条', () => {
    const issues = resourceConsistencyIssues('高峰期投入220人。高峰期投入80人。高峰期投入100人。');
    expect(issues).toHaveLength(1);
  });
  it('B3 STAGE 模式同阶段相差>30% → 报', () => {
    const issues = resourceConsistencyIssues('装饰装修阶段投入20人。装饰装修阶段投入80人。');
    expectBlockIssue(issues, '劳动力数据矛盾');
  });
  it('B3 STAGE 模式不同阶段 → 不报', () => {
    expect(resourceConsistencyIssues('装饰装修阶段投入20人。主体结构阶段投入20人。')).toEqual([]);
  });
  it('B3 箭头链峰值接管（链内低峰不入池）', () => {
    const issues = resourceConsistencyIssues('高峰期按32人→86人→48人分阶段投入。高峰期50人。');
    expectBlockIssue(issues, '劳动力数据矛盾');
    expect(issues[0].message).toContain('86 人');
  });
  it('B3 管理组同组互查', () => {
    const issues = resourceConsistencyIssues('劳动力配置管理人员18人，劳动力配置管理人员4人。');
    expectBlockIssue(issues, '劳动力数据矛盾');
  });
  it('B3 反向口径（劳动力词在前）入池互查', () => {
    const issues = resourceConsistencyIssues('劳动力投入约220人。劳动力投入约80人。');
    expectBlockIssue(issues, '劳动力数据矛盾');
  });
});

describe('B4 模式2 多表峰值互查', () => {
  const peakTable = (value: number) => ['| 施工阶段 | 阶段高峰人数 |', '| --- | --- |', `| 主体结构 | ${value} |`].join('\n');
  it('B4 两高峰列表相差>30% → 报', () => {
    const issues = resourceConsistencyIssues(`${peakTable(200)}\n\n${peakTable(100)}`);
    expectBlockIssue(issues, '分阶段投入明细表峰值');
  });
  it('B4 相差25% → 不报', () => {
    expect(resourceConsistencyIssues(`${peakTable(200)}\n\n${peakTable(150)}`)).toEqual([]);
  });
  it('B4 一表有高峰列一表无 → 不互查', () => {
    const plain = ['| 施工阶段 | 人数 |', '| --- | --- |', '| 主体结构 | 150 |'].join('\n');
    expect(resourceConsistencyIssues(`${peakTable(200)}\n\n${plain}`)).toEqual([]);
  });
  it('B4 两表峰值相同 → 不报', () => {
    expect(resourceConsistencyIssues(`${peakTable(200)}\n\n${peakTable(200)}`)).toEqual([]);
  });
  it('B4 相差正好30% → 不报（边界锁定）', () => {
    expect(resourceConsistencyIssues(`${peakTable(200)}\n\n${peakTable(140)}`)).toEqual([]);
  });
});

describe('B5 模式3 正文峰值 vs 表峰值', () => {
  const table = (value: number) => ['| 施工阶段 | 人数 |', '| --- | --- |', `| 主体结构 | ${value} |`].join('\n');
  it('B5 正文>表峰值1.3倍 → 报', () => {
    const issues = resourceConsistencyIssues(`高峰期投入286人。\n\n${table(100)}`);
    expectBlockIssue(issues, '分阶段投入明细表最大峰值');
  });
  it('B5 正文≤1.3倍 → 不报', () => {
    expect(resourceConsistencyIssues(`高峰期投入120人。\n\n${table(100)}`)).toEqual([]);
  });
  it('B5 正好1.3倍 → 不报（边界锁定）', () => {
    expect(resourceConsistencyIssues(`高峰期投入130人。\n\n${table(100)}`)).toEqual([]);
  });
  it('B5 无表 → 不比较', () => {
    expect(resourceConsistencyIssues('高峰期投入286人。')).toEqual([]);
  });
  it('B5 正文仅管理/工种口径 → 不比较', () => {
    expect(resourceConsistencyIssues(`劳动力配置管理人员18人。\n\n${table(100)}`)).toEqual([]);
  });
});

describe('B6 模式6 总量控制上限 vs 峰值', () => {
  it('B6 阶段峰值超上限 → 报', () => {
    const issues = resourceConsistencyIssues('高峰期总人数控制在260人以内。主体阶段高峰投入约300人。');
    expectBlockIssue(issues, '控制上限');
  });
  it('B6 峰值不超上限 → 不报', () => {
    expect(resourceConsistencyIssues('高峰期总人数控制在300人。主体阶段高峰投入260人。')).toEqual([]);
  });
  it('B6 表峰值超上限也报', () => {
    const md = ['高峰期总人数控制在100人。', '| 施工阶段 | 人数 |', '| --- | --- |', '| 主体结构 | 150 |'].join('\n');
    expectBlockIssue(resourceConsistencyIssues(md), '控制上限');
  });
  it('B6 峰值等于上限 → 不报', () => {
    expect(resourceConsistencyIssues('高峰期总人数控制在86人。高峰期86人。')).toEqual([]);
  });
});

describe('B7 模式7 班组加总算式一致性', () => {
  it('B7 宣称总人数与算式结果矛盾 → 报', () => {
    const issues = resourceConsistencyIssues('投入20人，道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4人=27人。');
    expectBlockIssue(issues, '宣称总人数 20 人与班组加总算式结果 27 人');
  });
  it('B7 算式左侧求和≠结果 → 报', () => {
    const issues = resourceConsistencyIssues('道路浇筑8人＋铺装6人=27人。');
    expectBlockIssue(issues, '左侧求和 14 人 ≠ 结果 27 人');
  });
  it('B7 近似措辞豁免宣称比较', () => {
    expect(resourceConsistencyIssues('投入约20人，道路浇筑8人＋铺装6人=14人。')).toEqual([]);
  });
  it('B7 无加号算式 → 不查', () => {
    expect(resourceConsistencyIssues('投入20人=27人。')).toEqual([]);
  });
  it('B7 表格行不查', () => {
    expect(resourceConsistencyIssues('| 班组 | 8人＋6人=14人 |')).toEqual([]);
  });
  it('B7 标题行不查', () => {
    expect(resourceConsistencyIssues('# 8人＋6人=14人')).toEqual([]);
  });
  it('B7 全自洽 → 不报', () => {
    expect(resourceConsistencyIssues('投入27人，道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4人=27人。')).toEqual([]);
  });
  it('B7 相差15%边界（23 vs 27 不报、22 vs 27 报）', () => {
    expect(resourceConsistencyIssues('投入23人，道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4人=27人。')).toEqual([]);
    expectBlockIssue(resourceConsistencyIssues('投入22人，道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4人=27人。'), '宣称总人数');
  });
});

describe('B8 模式4 合计行 vs 明细行之和', () => {
  const table = (total: number) => ['| 施工阶段 | 人数 |', '| --- | --- |', '| 施工准备 | 10 |', '| 主体结构 | 20 |', `| 合计 | ${total} |`].join('\n');
  it('B8 合计差25% → 报', () => {
    const issues = resourceConsistencyIssues(table(40));
    expectBlockIssue(issues, '合计行 40 人与明细行之和 30 人');
  });
  it('B8 合计差≤10% → 不报', () => {
    expect(resourceConsistencyIssues(table(33))).toEqual([]);
  });
  it('B8 无合计行 → 不报', () => {
    const md = ['| 施工阶段 | 人数 |', '| --- | --- |', '| 施工准备 | 10 |', '| 主体结构 | 20 |'].join('\n');
    expect(resourceConsistencyIssues(md)).toEqual([]);
  });
  it('B8 明细行<2 → 不报', () => {
    const md = ['| 施工阶段 | 人数 |', '| --- | --- |', '| 施工准备 | 10 |', '| 合计 | 40 |'].join('\n');
    expect(resourceConsistencyIssues(md)).toEqual([]);
  });
});

describe('B9 模式5 总工日量级自洽', () => {
  it('B9 总工日超上限（>峰值×工期×1.3）→ 报', () => {
    const issues = resourceConsistencyIssues('共计20000个工日。高峰期100人。总工期90天。');
    expectBlockIssue(issues, '总工日 20000 个与峰值 100 人×总工期 90 天不自洽');
  });
  it('B9 区间内 → 不报', () => {
    expect(resourceConsistencyIssues('共计8000个工日。高峰期100人。总工期90天。')).toEqual([]);
  });
  it('B9 低于下限（<峰值×工期×0.1）→ 报', () => {
    const issues = resourceConsistencyIssues('共计500个工日。高峰期100人。总工期90天。');
    expectBlockIssue(issues, '不自洽');
  });
  it('B9 无总量语境词不采样（偏差超5个工日）', () => {
    expect(resourceConsistencyIssues('偏差超过5个工日的即调整。高峰期100人。总工期90天。')).toEqual([]);
  });
  it('B9 工期<30天不采样', () => {
    expect(resourceConsistencyIssues('共计20000个工日。高峰期100人。总工期25天。')).toEqual([]);
  });
  it('B9 无峰值 → 不报', () => {
    expect(resourceConsistencyIssues('共计20000个工日。总工期90天。')).toEqual([]);
  });
  it('B9 全问题集截断 slice(0,5)', () => {
    const md = '投入20人，班组甲8人＋班组乙6人=27人。投入20人，班组丙8人＋班组丁6人=27人。投入20人，班组戊8人＋班组己6人=27人。投入20人，班组庚8人＋班组辛6人=27人。投入20人，班组壬8人＋班组癸6人=27人。';
    expect(resourceConsistencyIssues(md)).toHaveLength(5);
  });
});

// ── C. 支护体系（权威裁决 + 语义冲突 + 确定性修复） ──

describe('C1 extractSupportSystemAuthority 支护权威提取', () => {
  const canonicalOf = (supportValue: string): DocumentFactsModel['canonical'] =>
    ({ byKey: { foundation_support_form: factOf({ key: 'foundation_support_form', value: supportValue }) } } as DocumentFactsModel['canonical']);
  it('C1 无 factsModel → undefined', () => {
    expect(extractSupportSystemAuthority()).toBeUndefined();
  });
  it('C1 null → undefined', () => {
    expect(extractSupportSystemAuthority(null)).toBeUndefined();
  });
  it('C1 空 canonical → undefined', () => {
    expect(extractSupportSystemAuthority(factsOf({}))).toBeUndefined();
  });
  it('C1 土钉墙放坡值 → slope', () => {
    expect(extractSupportSystemAuthority(factsOf({ canonical: canonicalOf('土钉墙放坡喷锚支护') }))).toBe('slope');
  });
  it('C1 灌注桩排桩值 → pile', () => {
    expect(extractSupportSystemAuthority(factsOf({ canonical: canonicalOf('钻孔灌注桩排桩支护') }))).toBe('pile');
  });
  it('C1 两族词并存 → undefined（混合体系交语义检测）', () => {
    expect(extractSupportSystemAuthority(factsOf({ canonical: canonicalOf('灌注桩加局部放坡混合体系') }))).toBeUndefined();
  });
  it('C1 桩机词不判桩族 → undefined', () => {
    expect(extractSupportSystemAuthority(factsOf({ canonical: canonicalOf('桩机2台') }))).toBeUndefined();
  });
  it('C1 无支护词 → undefined', () => {
    expect(extractSupportSystemAuthority(factsOf({ canonical: canonicalOf('常规开挖') }))).toBeUndefined();
  });
});

describe('C2 supportSystemConflictIssues 支护并存冲突', () => {
  const SLOPE_BLOCK = '基坑采用放坡开挖，坡面设置土钉墙喷锚支护，坡率按1比1放坡。边坡稳定满足设计规范要求，确保基坑施工安全可靠。';
  const PILE_BLOCK = '基坑采用钻孔灌注桩加排桩支护方案，桩径800毫米，桩长20米。基坑周边设置冠梁围护结构，确保基坑侧壁稳定安全。';
  it('C2 两体系各自成段 → 报冲突', async () => {
    const issues = await supportSystemConflictIssues(`${SLOPE_BLOCK}\n\n${PILE_BLOCK}`);
    expectBlockIssue(issues, '放坡喷锚类支护表述与灌注桩排桩类支护表述分别成段出现');
    expect(issues[0].message).toContain('放坡喷锚类 1 段、灌注桩排桩类 1 段');
  });
  it('C2 authority=slope 注入裁决提示', async () => {
    const issues = await supportSystemConflictIssues(`${SLOPE_BLOCK}\n\n${PILE_BLOCK}`, 'slope');
    expect(issues[0].message).toContain('土钉墙、锚杆等放坡喷锚类——删除灌注桩排桩类表述');
  });
  it('C2 authority=pile 注入裁决提示', async () => {
    const issues = await supportSystemConflictIssues(`${SLOPE_BLOCK}\n\n${PILE_BLOCK}`, 'pile');
    expect(issues[0].message).toContain('灌注桩排桩类——删除放坡喷锚类独立成段表述');
  });
  it('C2 无权威 → 无提示', async () => {
    const issues = await supportSystemConflictIssues(`${SLOPE_BLOCK}\n\n${PILE_BLOCK}`);
    expect(issues[0].message).not.toContain('权威体系判定');
  });
  it('C2 仅坡喷锚段 → 不报', async () => {
    expect(await supportSystemConflictIssues(SLOPE_BLOCK)).toEqual([]);
  });
  it('C2 仅桩族段 → 不报', async () => {
    expect(await supportSystemConflictIssues(PILE_BLOCK)).toEqual([]);
  });
  it('C2 桩机词面不判桩族 → 不报', async () => {
    const md = `${SLOPE_BLOCK}\n\n桩机2台进场作业，安排专人管理设备安全使用。施工机械操作人员持证上岗，定期检查维护保养设备运行状态良好。`;
    expect(await supportSystemConflictIssues(md)).toEqual([]);
  });
  it('C2 混合块（两族词并存）不判冲突', async () => {
    const mixed = '基坑采用放坡开挖，局部钻孔灌注桩支护，两套体系并存设计。边坡稳定满足规范要求，确保基坑施工安全可靠。';
    expect(await supportSystemConflictIssues(`${mixed}\n\n${SLOPE_BLOCK}`)).toEqual([]);
  });
  it('C2 短块（<30字）过滤', async () => {
    expect(await supportSystemConflictIssues('采用放坡开挖支护坡面。')).toEqual([]);
  });
  it('C2 桩块无桩族实义词面 → 不判桩族', async () => {
    const md = `${SLOPE_BLOCK}\n\n基坑围护采用机械成孔施工工艺，安排专业人员负责质量管控。施工过程加强监测管理，确保基坑周边环境安全稳定。`;
    expect(await supportSystemConflictIssues(md)).toEqual([]);
  });
});

describe('C3 fixSupportSystemConflicts 支护确定性裁决修复', () => {
  it('C3 authority undefined → 不动', () => {
    const md = '基坑采用钻孔灌注桩加排桩支护方案。';
    const result = fixSupportSystemConflicts(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
  it('C3 authority=pile → 不动（混合体系合法交 LLM）', () => {
    const md = '基坑采用钻孔灌注桩支护。基坑放坡开挖。';
    expect(fixSupportSystemConflicts(md, 'pile').fixedCount).toBe(0);
  });
  it('C3 纯桩句删除', () => {
    const result = fixSupportSystemConflicts('基坑采用钻孔灌注桩加排桩支护方案。基坑降水措施同步实施。', 'slope');
    expect(result.markdown).not.toContain('钻孔灌注桩');
    expect(result.markdown).toContain('基坑降水措施同步实施');
    expect(result.fixedCount).toBe(1);
  });
  it('C3 混句词级替换', () => {
    const result = fixSupportSystemConflicts('基坑采用放坡开挖结合钻孔灌注桩支护。', 'slope');
    expect(result.markdown).toContain('土钉墙');
    expect(result.markdown).not.toContain('钻孔灌注桩');
  });
  it('C3 冠梁→坡顶映射（混句内替换）', () => {
    const result = fixSupportSystemConflicts('基坑采用放坡开挖，冠梁与灌注桩配套设置。', 'slope');
    expect(result.markdown).toContain('坡顶');
    expect(result.markdown).not.toContain('冠梁');
  });
  it('C3 混句机械逗号项删除', () => {
    const result = fixSupportSystemConflicts('基坑采用放坡开挖，高压旋喷桩机、挖掘机进场施工。', 'slope');
    expect(result.markdown).not.toContain('高压旋喷桩机');
    expect(result.markdown).toContain('挖掘机进场施工');
  });
  it('C3 混句句尾标点随尾项被删时补回', () => {
    const result = fixSupportSystemConflicts('基坑采用放坡开挖，高压旋喷桩机。', 'slope');
    expect(result.markdown).toContain('基坑采用放坡开挖。');
  });
  it('C3 标题行不动', () => {
    const md = '## 支护方案\n钻孔灌注桩排桩支护设计。';
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).toContain('## 支护方案');
  });
  it('C3 表格行不动', () => {
    const md = '| 支护形式 | 钻孔灌注桩 |\n| 放坡 | 是 |';
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.markdown).toBe(md);
  });
  it('C3 十词映射全替换', () => {
    const md = '基坑采用放坡开挖，高压旋喷桩、旋喷桩、钻孔灌注桩、咬合桩、地下连续墙、搅拌桩、灌注桩、支护桩、排桩、冠梁配套设置。';
    const result = fixSupportSystemConflicts(md, 'slope');
    for (const word of ['高压旋喷桩', '旋喷桩', '钻孔灌注桩', '咬合桩', '地下连续墙', '搅拌桩', '灌注桩', '支护桩', '排桩', '冠梁']) {
      expect(result.markdown).not.toContain(word);
    }
    expect(result.markdown).toContain('土钉墙');
    expect(result.markdown).toContain('坡顶');
  });
  it('C3 无桩词行不动', () => {
    const md = '基坑采用放坡开挖，土钉墙喷锚支护坡面。';
    expect(fixSupportSystemConflicts(md, 'slope').fixedCount).toBe(0);
  });
  it('C3 多句混合行部分删', () => {
    const result = fixSupportSystemConflicts('钻孔灌注桩支护方案先行施工。基坑降水措施同步实施。', 'slope');
    expect(result.markdown).not.toContain('钻孔灌注桩支护方案先行施工');
    expect(result.markdown).toContain('基坑降水措施同步实施');
  });
  it('C3 fixedCount=删除+改写', () => {
    const md = '钻孔灌注桩支护方案先行施工。基坑采用放坡开挖结合灌注桩支护。';
    const result = fixSupportSystemConflicts(md, 'slope');
    expect(result.fixedCount).toBe(2);
  });
  it('C3 details 汇总格式', () => {
    const result = fixSupportSystemConflicts('钻孔灌注桩支护方案先行施工。', 'slope');
    expect(result.details[0]).toContain('删除桩族句 1 句、改写混句 0 句');
  });
});

// ── D. 危大清单 / 语义采样 / 六百分百 / 属地适配 ──

describe('D1 dangerousListConsistencyIssues 危大清单一致性', () => {
  it('D1 两清单一致 → 不报', () => {
    const md = [
      '## 危大工程辨识清单',
      '1. 深基坑工程',
      '2. 高支模工程',
      '### 危大工程识别清单',
      '1. 深基坑工程',
      '2. 高支模工程',
    ].join('\n');
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D1 两清单差异 → 报', () => {
    const md = [
      '## 危大工程辨识清单',
      '1. 深基坑工程',
      '2. 高支模工程',
      '### 危大工程识别清单',
      '1. 深基坑工程',
      '2. 起重吊装工程',
    ].join('\n');
    const issues = dangerousListConsistencyIssues(md);
    expectBlockIssue(issues, '危大工程辨识清单不一致');
    expect(issues[0].message).toContain('前者独有【高支模工程】');
    expect(issues[0].message).toContain('后者独有【起重吊装工程】');
  });
  it('D1 编号形态归一（1. 与 （1））→ 不报', () => {
    const md = [
      '## 危大工程辨识清单',
      '1. 深基坑工程',
      '2. 高支模工程',
      '### 危大工程识别清单',
      '（1）深基坑工程',
      '（2）高支模工程',
    ].join('\n');
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D1 括号标注归一 → 不报', () => {
    const md = [
      '## 危大工程辨识清单',
      '1. 深基坑工程',
      '2. 高支模工程',
      '### 危大工程识别清单',
      '1.（开挖深度超5米）深基坑工程',
      '2.（搭设高度超8米）高支模工程',
    ].join('\n');
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D1 施工尾缀归一 → 不报', () => {
    const md = [
      '## 危大工程辨识清单',
      '1. 深基坑工程施工',
      '2. 高支模工程施工',
      '### 危大工程识别清单',
      '1. 深基坑工程',
      '2. 高支模工程',
    ].join('\n');
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D1 作业尾缀归一 → 不报', () => {
    const md = [
      '## 危大工程辨识清单',
      '1. 起重吊装作业',
      '2. 脚手架作业',
      '### 危大工程识别清单',
      '1. 起重吊装',
      '2. 脚手架',
    ].join('\n');
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D1 单清单 → 不报', () => {
    const md = ['## 危大工程辨识清单', '1. 深基坑工程', '2. 高支模工程'].join('\n');
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D1 清单仅1项不收集', () => {
    const md = ['## 危大工程辨识清单', '1. 深基坑工程', '### 危大工程识别清单', '1. 深基坑工程'].join('\n');
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D1 超40字条目不收集', () => {
    const long = '深基坑工程开挖深度超过五米且周边环境复杂需要进行专项论证评审'.repeat(2) + '补充说明';
    const md = [
      '## 危大工程辨识清单',
      `1. ${long}`,
      '2. 高支模工程',
      '### 危大工程识别清单',
      '1. 深基坑工程',
      '2. 高支模工程',
    ].join('\n');
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it.each(['## 危大工程清单', '### 3.2 危大工程及超危大识别', '#### 危大工程辨识'])('D1 标题谱系 %s', (heading) => {
    const md = [
      heading,
      '1. 深基坑工程',
      '2. 高支模工程',
      '### 危大工程识别清单',
      '1. 深基坑工程',
      '2. 起重吊装工程',
    ].join('\n');
    expectBlockIssue(dangerousListConsistencyIssues(md), '危大工程辨识清单不一致');
  });
  it('D1 H1 标题不收集 → 不报', () => {
    const md = [
      '# 危大工程辨识清单',
      '1. 深基坑工程',
      '2. 高支模工程',
      '### 危大工程识别清单',
      '1. 深基坑工程',
      '2. 起重吊装工程',
    ].join('\n');
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D1 清单内重复项去重', () => {
    const md = [
      '## 危大工程辨识清单',
      '1. 深基坑工程',
      '1. 深基坑工程',
      '2. 高支模工程',
      '### 危大工程识别清单',
      '1. 深基坑工程',
      '2. 高支模工程',
    ].join('\n');
    expect(dangerousListConsistencyIssues(md)).toEqual([]);
  });
  it('D1 超过3处两两差异截断 slice(0,3)', () => {
    const md = [
      '## 危大工程辨识清单',
      '1. 深基坑工程',
      '2. 高支模工程',
      '### 危大工程识别清单',
      '1. 深基坑工程',
      '2. 起重吊装工程',
      '#### 危大工程清单',
      '1. 深基坑工程',
      '2. 脚手架工程',
      '## 危大及超危大辨识',
      '1. 深基坑工程',
      '2. 拆除工程',
    ].join('\n');
    expect(dangerousListConsistencyIssues(md)).toHaveLength(3);
  });
  it('D1 标题紧邻标题（清单标题行直接相邻）第三清单不漏检', () => {
    const md = [
      '## 危大工程辨识清单',
      '1. 深基坑工程',
      '2. 高支模工程',
      '### 危大工程识别清单',
      '#### 危大工程清单',
      '1. 深基坑工程',
      '2. 起重吊装工程',
    ].join('\n');
    expectBlockIssue(dangerousListConsistencyIssues(md), '危大工程辨识清单不一致');
  });
});

describe('D2 bodySentencesForSemantic 语义候选句采样', () => {
  it('D2 基本提取', () => {
    expect(bodySentencesForSemantic('第一条施工措施说明文字。第二条施工措施说明文字。')).toHaveLength(2);
  });
  it('D2 标题行排除', () => {
    expect(bodySentencesForSemantic('## 第一章标题文字内容')).toEqual([]);
  });
  it('D2 表格行排除', () => {
    expect(bodySentencesForSemantic('| 表格列 | 内容文字 |')).toEqual([]);
  });
  it('D2 空行排除', () => {
    expect(bodySentencesForSemantic('')).toEqual([]);
  });
  it('D2 短句<8字排除', () => {
    expect(bodySentencesForSemantic('措施说明。')).toEqual([]);
  });
  it('D2 长句>120字排除', () => {
    expect(bodySentencesForSemantic(`${'文'.repeat(121)}。`)).toEqual([]);
  });
  it('D2 重复句去重', () => {
    const md = '第一条施工措施说明文字。\n第一条施工措施说明文字。';
    expect(bodySentencesForSemantic(md)).toHaveLength(1);
  });
  it('D2 分号句拆分', () => {
    expect(bodySentencesForSemantic('第一条施工措施已落实；第二条施工措施已落实。')).toHaveLength(2);
  });
  it('D2 ≤400句全量', () => {
    const md = Array.from({ length: 3 }, (_, i) => `第${i + 1}条施工内容说明文字。`).join('\n');
    expect(bodySentencesForSemantic(md)).toHaveLength(3);
  });
  it('D2 >400句均匀采样（401→201，首尾均在）', () => {
    const md = Array.from({ length: 401 }, (_, i) => `第${i + 1}条施工内容说明文字。`).join('\n');
    const sentences = bodySentencesForSemantic(md);
    expect(sentences).toHaveLength(201);
    expect(sentences[0]).toBe('第1条施工内容说明文字。');
    expect(sentences[sentences.length - 1]).toBe('第401条施工内容说明文字。');
  });
});

describe('D3 sixHundredPercentCoverageIssues 六个百分百', () => {
  const LEXICAL_SIX = '施工工地周边100%围挡、物料堆放100%覆盖、出入车辆100%冲洗、施工现场地面100%硬化、拆迁工地100%湿法作业、渣土车辆100%密闭运输。';
  it('D3 无扬尘内容 → 不检测', async () => {
    expect(await sixHundredPercentCoverageIssues('本工程施工管理规范。')).toEqual([]);
  });
  it('D3 六项词面兜底（语义恒低分仍命中）→ 不报', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    expect(await sixHundredPercentCoverageIssues(`落实扬尘治理要求。${LEXICAL_SIX}`)).toEqual([]);
  });
  it('D3 六项语义命中 → 不报', async () => {
    const md = '落实扬尘治理要求。现场四周设置围挡。物料堆放覆盖防尘。出场车辆冲洗干净。场地地面全部硬化。拆迁区域湿法作业。渣土车辆密闭运输。';
    expect(await sixHundredPercentCoverageIssues(md)).toEqual([]);
  });
  it('D3 全缺 → 报0/6', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const md = '现场采取洒水降尘措施。安排专人负责文明施工管理。每日检查施工现场环境。落实扬尘治理各项制度要求。';
    const issues = await sixHundredPercentCoverageIssues(md);
    expectBlockIssue(issues, '0/6 项命中');
    expect(issues[0].message).toContain('施工工地周边100%围挡');
  });
  it('D3 部分词面命中 → 报2/6', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const md = '落实扬尘治理要求。施工工地周边100%围挡。物料堆放100%覆盖。';
    const issues = await sixHundredPercentCoverageIssues(md);
    expectBlockIssue(issues, '2/6 项命中');
    expect(issues[0].message).toContain('出入车辆100%冲洗');
  });
  it('D3 拆迁豁免（工程主语+短距否定词）→ 湿法项不缺失', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const md = '落实扬尘治理要求。本项目无拆迁工程。施工工地周边100%围挡、物料堆放100%覆盖、出入车辆100%冲洗、施工现场地面100%硬化、渣土车辆100%密闭运输。';
    expect(await sixHundredPercentCoverageIssues(md)).toEqual([]);
  });
  it('D3 无主语否定（临时设施不涉及拆迁）→ 不豁免', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const md = '落实扬尘治理要求。临时设施布置不涉及拆迁补偿。施工工地周边100%围挡、物料堆放100%覆盖、出入车辆100%冲洗、施工现场地面100%硬化、渣土车辆100%密闭运输。';
    const issues = await sixHundredPercentCoverageIssues(md);
    expectBlockIssue(issues, '拆迁工地100%湿法作业');
  });
  it('D3 主语与否定词超30字 → 不豁免', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const md = `落实扬尘治理要求。本项目${'占位文字内容'.repeat(6)}不涉及拆迁。施工工地周边100%围挡、物料堆放100%覆盖、出入车辆100%冲洗、施工现场地面100%硬化、渣土车辆100%密闭运输。`;
    const issues = await sixHundredPercentCoverageIssues(md);
    expectBlockIssue(issues, '拆迁工地100%湿法作业');
  });
  it('D3 冲洗点词面形态命中', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const md = '落实扬尘治理要求。出入口设置冲洗点。施工工地周边100%围挡、物料堆放100%覆盖、施工现场地面100%硬化、渣土车辆100%密闭运输、本项目无拆迁工程。';
    expect(await sixHundredPercentCoverageIssues(md)).toEqual([]);
  });
  it('D3 密闭式词面形态命中', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const md = '落实扬尘治理要求。渣土车辆密闭式运输。施工工地周边100%围挡、物料堆放100%覆盖、施工现场地面100%硬化、本项目无拆迁工程。';
    const issues = await sixHundredPercentCoverageIssues(md);
    expect(issues.map(issue => issue.message).join('')).not.toContain('渣土车辆100%密闭运输');
  });
  it('D3 湿法作业拆迁距离词面命中', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const md = '落实扬尘治理要求。拆迁工地湿法作业。施工工地周边100%围挡、物料堆放100%覆盖、施工现场地面100%硬化、渣土车辆100%密闭运输。';
    const issues = await sixHundredPercentCoverageIssues(md);
    expect(issues.map(issue => issue.message).join('')).not.toContain('拆迁工地100%湿法作业');
  });
  it('D3 预筛行限定（无扬尘词面行不进语义判定）', async () => {
    const md = '落实扬尘治理要求。围挡措施完整落实到位。现场设置洒水装置，每日安排专人洒水。';
    const issues = await sixHundredPercentCoverageIssues(md);
    expectBlockIssue(issues, '1/6 项命中');
    expect(issues[0].message).not.toContain('施工工地周边100%围挡');
  });
});

describe('D4 localAdaptationKeywordIssues 属地适配', () => {
  const anhuiFacts = (): DocumentFactsModel => factsOf({ project: [factOf({ fieldName: '建设地点', value: '安徽省合肥市肥东县' })] });
  const THREE_HITS = '本工程争创市级优质工程奖。施工用水采用非传统水源，回收率指标量化管理。为全体作业人员办理工伤保险。';
  it('D4 安徽项目三项语义命中 → 不报', async () => {
    expect(await localAdaptationKeywordIssues(THREE_HITS, anhuiFacts())).toEqual([]);
  });
  it('D4 安徽全缺 → 创优+工伤双报', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const issues = await localAdaptationKeywordIssues('建立劳务用工管理制度。', anhuiFacts());
    expect(issues).toHaveLength(2);
    expect(issues.map(issue => issue.message).join('')).toContain('属地创优目标缺失');
    expect(issues.map(issue => issue.message).join('')).toContain('工伤保险表述缺失');
  });
  it('D4 非安徽 → 不查创优', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const facts = factsOf({ project: [factOf({ fieldName: '建设地点', value: '江苏省南京市' })] });
    expect(await localAdaptationKeywordIssues('施工管理规范。', facts)).toEqual([]);
  });
  it('D4 非安徽+劳务词 → 仅工伤报', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const facts = factsOf({ project: [factOf({ fieldName: '建设地点', value: '江苏省南京市' })] });
    const issues = await localAdaptationKeywordIssues('建立劳务用工管理制度。', facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('工伤保险表述缺失');
  });
  it('D4 安徽有绿色词无量化语义 → 四节一环保报', async () => {
    const facts = anhuiFacts();
    const md = '本工程争创市级优质工程奖。落实绿色施工要求。为全体作业人员办理工伤保险。';
    const issues = await localAdaptationKeywordIssues(md, facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('四节一环保量化指标缺失');
  });
  it('D4 正文无绿色词 → 不报四节一环保', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const md = '本工程争创市级优质工程奖。为全体作业人员办理工伤保险。';
    const issues = await localAdaptationKeywordIssues(md, anhuiFacts());
    expect(issues.map(issue => issue.message).join('')).not.toContain('四节一环保');
  });
  it('D4 工伤语义命中+无劳务词 → 不报工伤', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const facts = factsOf({ project: [factOf({ fieldName: '建设地点', value: '江苏省南京市' })] });
    expect(await localAdaptationKeywordIssues('为全体作业人员办理工伤保险。', facts)).toEqual([]);
  });
  it('D4 省内城市别名（合肥）→ 判安徽', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const facts = factsOf({ project: [factOf({ fieldName: '建设地点', value: '合肥市' })] });
    const issues = await localAdaptationKeywordIssues('建立劳务用工管理制度。', facts);
    expect(issues.map(issue => issue.message).join('')).toContain('属地创优目标缺失');
  });
  it('D4 非地点字段不判属地（建设单位含安徽）', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const facts = factsOf({ project: [factOf({ fieldName: '建设单位', value: '安徽建工集团' })] });
    expect(await localAdaptationKeywordIssues('施工管理规范。', facts)).toEqual([]);
  });
  it.each(['建设地点', '工程地点', '项目地点', '实施地点', '服务地点', '交付地点', '建设地址'])('D4 地点标签 %s 判安徽', async (label) => {
    const facts = factsOf({ project: [factOf({ fieldName: label, value: '安徽省合肥市' })] });
    const issues = await localAdaptationKeywordIssues(THREE_HITS, facts);
    expect(issues).toEqual([]);
  });
  it('D4 四节词谱系触发（节水）', async () => {
    const facts = anhuiFacts();
    const md = '本工程争创市级优质工程奖。落实节水措施。为全体作业人员办理工伤保险。';
    const issues = await localAdaptationKeywordIssues(md, facts);
    expect(issues[0].message).toContain('四节一环保量化指标缺失');
  });
  it('D4 工伤触发词谱系（农民工）', async () => {
    vi.mocked(buildSemanticSimilarity).mockImplementation(CONST_SIM(0.1));
    const facts = factsOf({ project: [factOf({ fieldName: '建设地点', value: '江苏省南京市' })] });
    const issues = await localAdaptationKeywordIssues('农民工工资按月足额发放。', facts);
    expect(issues[0].message).toContain('工伤保险表述缺失');
  });
});

// ── E. 段首重复/概况复述/闭环密度/自伤/叠词/残行/装饰厚度/劳动力峰值/收敛工具 ──

describe('E1 paragraphOpeningRepeatIssues 段首机械重复', () => {
  const OPENING = '为保证工程质量和安全生产，项目部建立完善的质量管理体系。';
  it('E1 三处同构段首 → 报 warning', () => {
    const issues = paragraphOpeningRepeatIssues(`${OPENING}\n${OPENING}\n${OPENING}`);
    expectBlockIssue(issues, '段首固定开场机械重复 3 次');
    expect(issues[0].level).toBe('warning');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].category).toBe('style');
  });
  it('E1 两处同构 → 不报', () => {
    expect(paragraphOpeningRepeatIssues(`${OPENING}\n${OPENING}`)).toEqual([]);
  });
  it('E1 数字差异不影响指纹 → 报', () => {
    const md = [
      '工程规划建设12栋住宅楼及配套用房设施。',
      '工程规划建设28栋住宅楼及配套用房设施。',
      '工程规划建设35栋住宅楼及配套用房设施。',
    ].join('\n');
    expectBlockIssue(paragraphOpeningRepeatIssues(md), '段首固定开场机械重复');
  });
  it('E1 纯数字句指纹<10 跳过 → 不报', () => {
    const md = '123456789012345678。\n123456789012345678。\n123456789012345678。';
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
  it('E1 段首句<18字不提取 → 不报', () => {
    const md = '本工程严格执行各项安全管理规定。\n本工程严格执行各项安全管理规定。\n本工程严格执行各项安全管理规定。';
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
  it('E1 段首句>60字不提取 → 不报', () => {
    const long = `${'文'.repeat(62)}。`;
    expect(paragraphOpeningRepeatIssues(`${long}\n${long}\n${long}`)).toEqual([]);
  });
  it('E1 表格行不提取', () => {
    const md = `| ${OPENING} |\n| ${OPENING} |\n| ${OPENING} |`;
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
  it('E1 标题前缀形态提取（标题行+段落句）', () => {
    const md = [
      '## 安全管理目标',
      OPENING,
      '## 进度管理目标',
      OPENING,
      '## 质量管理目标',
      OPENING,
    ].join('\n');
    expectBlockIssue(paragraphOpeningRepeatIssues(md), '段首固定开场机械重复');
  });
  it('E1 指纹前16字同构后段不同 → 报', () => {
    const md = [
      '本项目施工组织设计编制依据充分和可靠，符合国家现行规范标准要求。',
      '本项目施工组织设计编制依据充分和可靠，结合工程实际编制专项方案。',
      '本项目施工组织设计编制依据充分和可靠，针对现场条件制定控制措施。',
    ].join('\n');
    expectBlockIssue(paragraphOpeningRepeatIssues(md), '段首固定开场机械重复');
  });
  it('E1 超过3组截断 slice(0,3)', () => {
    const md = [
      OPENING, OPENING, OPENING,
      '本工程严格执行安全生产责任制度并落实到位。',
      '本工程严格执行安全生产责任制度并落实到位。',
      '本工程严格执行安全生产责任制度并落实到位。',
      '施工现场建立质量责任体系并组织全员实施。',
      '施工现场建立质量责任体系并组织全员实施。',
      '施工现场建立质量责任体系并组织全员实施。',
      '环境保护措施按方案要求逐项落实到位执行。',
      '环境保护措施按方案要求逐项落实到位执行。',
      '环境保护措施按方案要求逐项落实到位执行。',
    ].join('\n');
    expect(paragraphOpeningRepeatIssues(md)).toHaveLength(3);
  });
});

describe('E2 overviewRecapCandidates 概况复述候选', () => {
  const md = '## 工程概况\n本项目总建筑面积50000平方米。\n## 施工部署\n本项目为总建筑面积50000平方米的工程。';
  it('E2 概况区外复述句收集+概况体提取', () => {
    const { overviewBody, sentences } = overviewRecapCandidates(md);
    expect(sentences).toEqual(['本项目为总建筑面积50000平方米的工程']);
    expect(overviewBody).toContain('总建筑面积50000平方米');
  });
  it.each(['本工程为', '该项目为', '该工程为'])('E2 开头形态 %s 收集', (prefix) => {
    const doc = `## 工程概况\n本项目总建筑面积50000平方米。\n## 施工部署\n${prefix}总建筑面积50000平方米的工程。`;
    const { sentences } = overviewRecapCandidates(doc);
    expect(sentences).toHaveLength(1);
  });
  it('E2 短句<12字不收集', () => {
    const { sentences } = overviewRecapCandidates('## 工程概况\n本项目总建筑面积50000平方米。\n本项目为小型工程。');
    expect(sentences).toEqual([]);
  });
  it('E2 概况区内复述句不作为候选', () => {
    const { sentences } = overviewRecapCandidates('## 工程概况\n本项目为总建筑面积50000平方米的工程。');
    expect(sentences).toEqual([]);
  });
  it('E2 无概况区 → 候选有概况体空', () => {
    const { overviewBody, sentences } = overviewRecapCandidates('本项目为总建筑面积50000平方米的工程。');
    expect(sentences).toHaveLength(1);
    expect(overviewBody).toBe('');
  });
  it('E2 行内句中截取（从开头词起）', () => {
    const { sentences } = overviewRecapCandidates('## 工程概况\n本项目总建筑面积50000平方米。\n## 施工部署\n本小节介绍施工部署内容，本项目为总建筑面积50000平方米的工程。');
    expect(sentences).toEqual(['本项目为总建筑面积50000平方米的工程']);
  });
  it('E2 H1 标题不锚定 → 全文档视为区外', () => {
    const { overviewBody } = overviewRecapCandidates('# 工程概况\n本项目总建筑面积50000平方米。');
    expect(overviewBody).toBe('');
  });
  it('E2 H5 标题不锚定（#{2,4}）', () => {
    const { overviewBody } = overviewRecapCandidates('##### 工程概况\n本项目总建筑面积50000平方米。');
    expect(overviewBody).toBe('');
  });
});

describe('E3 overviewRecapIssues 概况复述检测', () => {
  const sim = (left: string, right: string) => (left.includes('50000') && right.includes('50000') ? 0.9 : 0.1);
  const md = '## 工程概况\n本项目总建筑面积50000平方米。\n## 施工部署\n本项目为总建筑面积50000平方米的工程。';
  it('E3 相似度达标 → 报', () => {
    const issues = overviewRecapIssues(md, { semanticSimilarity: sim });
    expectBlockIssue(issues, '项目概况段跨章复述不得出现');
    expect(issues[0].message).toContain('本项目为总建筑面积50000平方米的工程');
  });
  it('E3 相似度低 → 不报', () => {
    const doc = '## 工程概况\n本项目总建筑面积50000平方米。\n## 施工部署\n本项目为施工管理重点工程。';
    expect(overviewRecapIssues(doc, { semanticSimilarity: sim })).toEqual([]);
  });
  it('E3 未注入语义函数 → 不报', () => {
    expect(overviewRecapIssues(md)).toEqual([]);
  });
  it('E3 无候选句 → 不报', () => {
    expect(overviewRecapIssues('## 工程概况\n本项目总建筑面积50000平方米。', { semanticSimilarity: sim })).toEqual([]);
  });
  it('E3 概况体空 → 不报', () => {
    expect(overviewRecapIssues('本项目为总建筑面积50000平方米的工程。', { semanticSimilarity: sim })).toEqual([]);
  });
  it('E3 复述句最多取3处', () => {
    const doc = [
      '## 工程概况',
      '本项目总建筑面积50000平方米。',
      '## 施工部署',
      '本项目为总建筑面积50000平方米的工程甲。',
      '本项目为总建筑面积50000平方米的工程乙。',
      '本项目为总建筑面积50000平方米的工程丙。',
      '本项目为总建筑面积50000平方米的工程丁。',
    ].join('\n');
    const issues = overviewRecapIssues(doc, { semanticSimilarity: sim });
    expect(issues[0].message).toContain('3 处');
  });
});

describe('E4 stripOverviewRecapBodyLines 复述句行级清洗', () => {
  const sim = (left: string, right: string) => (left.includes('50000') && right.includes('50000') ? 0.9 : 0.1);
  it('E4 复述句整行删除', () => {
    const md = '## 工程概况\n本项目总建筑面积50000平方米。\n## 施工部署\n本项目为总建筑面积50000平方米的工程。\n本小节部署施工组织。';
    const cleaned = stripOverviewRecapBodyLines(md, sim);
    expect(cleaned).not.toContain('本项目为总建筑面积50000平方米的工程');
    expect(cleaned).toContain('本小节部署施工组织');
    expect(cleaned).toContain('本项目总建筑面积50000平方米');
  });
  it('E4 非复述句保留', () => {
    const md = '## 工程概况\n本项目总建筑面积50000平方米。\n## 施工部署\n本项目为施工管理重点工程。';
    expect(stripOverviewRecapBodyLines(md, sim)).toBe(md);
  });
  it('E4 无变化返回原引用', () => {
    const md = '普通段落内容。\n另一段普通内容。';
    expect(stripOverviewRecapBodyLines(md, sim)).toBe(md);
  });
  it('E4 概况区间行不动', () => {
    const md = '## 工程概况\n本项目为总建筑面积50000平方米的工程。';
    expect(stripOverviewRecapBodyLines(md, sim)).toBe(md);
  });
  it('E4 标题行与表格行不动', () => {
    const md = '## 工程概况\n本项目总建筑面积50000平方米。\n## 施工部署\n| 本项目为总建筑面积50000平方米的工程 |';
    expect(stripOverviewRecapBodyLines(md, sim)).toBe(md);
  });
  it('E4 短句<12字不动', () => {
    const md = '## 工程概况\n本项目总建筑面积50000平方米。\n本项目为短句。';
    expect(stripOverviewRecapBodyLines(md, sim)).toBe(md);
  });
  it('E4 行内部分句删除', () => {
    const md = '## 工程概况\n本项目总建筑面积50000平方米。\n## 施工部署\n本小节介绍部署要点。本项目为总建筑面积50000平方米的工程。后续内容继续。';
    const cleaned = stripOverviewRecapBodyLines(md, sim);
    expect(cleaned).not.toContain('本项目为总建筑面积50000平方米的工程');
    expect(cleaned).toContain('本小节介绍部署要点');
  });
  it('E4 四形态开头均删除', () => {
    const md = [
      '## 工程概况',
      '本项目总建筑面积50000平方米。',
      '## 施工部署',
      '本工程为总建筑面积50000平方米的工程。',
      '该项目为总建筑面积50000平方米的工程。',
      '该工程为总建筑面积50000平方米的工程。',
    ].join('\n');
    const cleaned = stripOverviewRecapBodyLines(md, sim);
    expect(cleaned).not.toContain('本工程为总建筑面积50000平方米的工程');
    expect(cleaned).not.toContain('该项目为总建筑面积50000平方米的工程');
    expect(cleaned).not.toContain('该工程为总建筑面积50000平方米的工程');
  });
});

describe('E5 closurePhraseDensityCapIssues 闭环句式密度', () => {
  it('E5 密度≥3次/千字 → 报', () => {
    const md = `${'文'.repeat(3000)}${'销项'.repeat(10)}`;
    const issues = closurePhraseDensityCapIssues(md);
    expectBlockIssue(issues, '闭环句式模板化密集');
    expect(issues[0].message).toContain('销项');
    expect(issues[0].level).toBe('warning');
  });
  it('E5 密度<3 → 不报', () => {
    const md = `${'文'.repeat(3000)}${'销项'.repeat(8)}`;
    expect(closurePhraseDensityCapIssues(md)).toEqual([]);
  });
  it('E5 文档<3000字跳过', () => {
    expect(closurePhraseDensityCapIssues('销项销项销项销项。')).toEqual([]);
  });
  it('E5 报密度最高词', () => {
    const md = `${'文'.repeat(3000)}${'销项'.repeat(10)}${'整改'.repeat(5)}`;
    expect(closurePhraseDensityCapIssues(md)[0].message).toContain('销项');
  });
  it('E5 HTML标签去除后计数', () => {
    const md = `${'文'.repeat(3000)}${'<b>销项</b>'.repeat(10)}`;
    expectBlockIssue(closurePhraseDensityCapIssues(md), '闭环句式模板化密集');
  });
});

describe('E6 selfUnderminingCandidateIssues 自伤表述候选', () => {
  it('E6 专项设计未完成 → 报候选', async () => {
    const issues = await selfUnderminingCandidateIssues('专项设计文件尚未完成，相关内容待后续补充。');
    expectBlockIssue(issues, '自伤表述候选');
    expect(issues[0].message).toContain('尚未完成');
  });
  it('E6 指标缺口原型命中', async () => {
    const issues = await selfUnderminingCandidateIssues('评分指标存在缺口尚未明确。');
    expectBlockIssue(issues, '自伤表述候选');
  });
  it('E6 跟踪完善原型命中', async () => {
    const issues = await selfUnderminingCandidateIssues('依据承诺函后续跟踪完善相关事项。');
    expectBlockIssue(issues, '自伤表述候选');
  });
  it('E6 短句<12字过滤 → 不报', async () => {
    expect(await selfUnderminingCandidateIssues('尚未完成补充。')).toEqual([]);
  });
  it('E6 标题行排除', async () => {
    expect(await selfUnderminingCandidateIssues('## 专项设计文件尚未完成')).toEqual([]);
  });
  it('E6 表格行排除', async () => {
    expect(await selfUnderminingCandidateIssues('| 专项设计文件尚未完成 |')).toEqual([]);
  });
  it('E6 列表行排除', async () => {
    expect(await selfUnderminingCandidateIssues('- 专项设计文件尚未完成')).toEqual([]);
  });
  it('E6 正向声明句豁免（编制范围为）', async () => {
    const md = '编制范围为招标文件所界定的全部施工内容，专项设计文件尚未完成的内容同步纳入管理。';
    expect(await selfUnderminingCandidateIssues(md)).toEqual([]);
  });
  it('E6 控制性约束条件豁免', async () => {
    const md = '专项设计文件尚未完成的内容作为施工组织的控制性约束条件。';
    expect(await selfUnderminingCandidateIssues(md)).toEqual([]);
  });
  it('E6 重复句去重', async () => {
    const md = '专项设计文件尚未完成，相关内容待后续补充。\n专项设计文件尚未完成，相关内容待后续补充。';
    expect(await selfUnderminingCandidateIssues(md)).toHaveLength(1);
  });
  it('E6 超过3条截断 slice(0,3)', async () => {
    const md = '专项设计文件尚未完成，待后续补充。\n评分指标存在缺口尚未明确。\n依据承诺函后续跟踪完善事项。\n专项设计文件内容尚未完成。';
    expect(await selfUnderminingCandidateIssues(md)).toHaveLength(3);
  });
  it('E6 分号分句各自判定', async () => {
    const md = '专项设计文件尚未完成，待后续补充；评分指标存在缺口尚未明确。';
    expect(await selfUnderminingCandidateIssues(md)).toHaveLength(2);
  });
});

describe('E7 叠词检测与去重（REPEATED_WORD_RE）', () => {
  it('E7 紧邻双字重复命中', () => {
    REPEATED_WORD_RE.lastIndex = 0;
    expect(REPEATED_WORD_RE.test('执行执行')).toBe(true);
  });
  it('E7 分部分项术语豁免', () => {
    REPEATED_WORD_RE.lastIndex = 0;
    expect(REPEATED_WORD_RE.test('分部分项')).toBe(false);
  });
  it('E7 前字为分豁免', () => {
    REPEATED_WORD_RE.lastIndex = 0;
    expect(REPEATED_WORD_RE.test('分执行执行')).toBe(false);
  });
  it('E7 后字为项豁免', () => {
    REPEATED_WORD_RE.lastIndex = 0;
    expect(REPEATED_WORD_RE.test('执行执行项')).toBe(false);
  });
  it('E7 repeatedWordIssues 单词报', () => {
    const issues = repeatedWordIssues('施工执行执行验收。');
    expectBlockIssue(issues, '叠词重复表述');
    expect(issues[0].message).toContain('执行执行');
  });
  it('E7 无叠词 → 不报', () => {
    expect(repeatedWordIssues('正常施工内容。')).toEqual([]);
  });
  it('E7 多词合并报告', () => {
    const issues = repeatedWordIssues('执行执行进行进行。');
    expect(issues[0].message).toContain('执行执行');
    expect(issues[0].message).toContain('进行进行');
  });
  it('E7 不同叠词最多3个', () => {
    const issues = repeatedWordIssues('执行执行。进行进行。检查检查。落实落实。');
    expect(issues[0].message.split('、')).toHaveLength(3);
  });
  it('E7 collapseRepeatedWords 收敛', () => {
    expect(collapseRepeatedWords('执行执行')).toBe('执行');
  });
  it('E7 三连一次替换锁定', () => {
    expect(collapseRepeatedWords('执行执行执行')).toBe('执行执行');
  });
  it('E7 术语不动', () => {
    expect(collapseRepeatedWords('分部分项验收')).toBe('分部分项验收');
  });
  it('E7 重复词同一句多处收敛', () => {
    expect(collapseRepeatedWords('执行执行与进行进行')).toBe('执行与进行');
  });
});

describe('E8 mergeTableLineResidues 表格断行残片合并', () => {
  it('E8 残行拼回上一行末单元格（中文标点不加空格）', () => {
    const md = '| 措施 | 内容 |\n| --- | --- |\n| 1 | 增开清表作业面， |\n延长有效作业时间 |';
    const result = mergeTableLineResidues(md);
    expect(result.markdown).toContain('| 1 | 增开清表作业面，延长有效作业时间 |');
    expect(result.fixedCount).toBe(1);
  });
  it('E8 非标点结尾加空格', () => {
    const md = '| 措施 | 内容 |\n| --- | --- |\n| 1 | 措施内容 |\n补充说明 |';
    const result = mergeTableLineResidues(md);
    expect(result.markdown).toContain('| 1 | 措施内容 补充说明 |');
  });
  it('E8 多竖线残行不动', () => {
    const md = '| 措施 | 内容 |\n残行一 | 残行二 |';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
  it('E8 残行不以竖线结尾不动', () => {
    const md = '| 措施 | 内容 |\n延长有效作业时间';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
  it('E8 残行以竖线开头不动（表格行）', () => {
    const md = '| 措施 | 内容 |\n| 延长有效作业时间 |';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
  it('E8 标题行残片不动', () => {
    const md = '| 措施 | 内容 |\n# 标题 |';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
  it('E8 上一行非表格不动', () => {
    const md = '普通段落。\n延长有效作业时间 |';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
  it('E8 连续残行依次合并', () => {
    const md = '| 措施 | 内容 |\n| --- | --- |\n| 1 | 措施 |\n续一 |\n续二 |';
    const result = mergeTableLineResidues(md);
    expect(result.markdown).toContain('| 1 | 措施 续一 续二 |');
    expect(result.fixedCount).toBe(2);
  });
  it('E8 无残行不动', () => {
    const md = '| 措施 | 内容 |\n| --- | --- |\n| 1 | 说明 |';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
});

describe('E9 finishThickness 装饰层厚度异常', () => {
  it.each(['抹面', '打底', '找平', '坐浆', '结合层', '粘结层', '罩面', '批嵌', '腻子'])('E9 语境词 %s 前向命中', (word) => {
    const issues = finishThicknessIssues(`${word}厚度200mm。`);
    expectBlockIssue(issues, '装饰层工艺参数异常');
    expect(issues[0].message).toContain(word);
  });
  it('E9 前向窗口超10字不命中', () => {
    expect(finishThicknessIssues(`抹面${'字'.repeat(11)}200mm。`)).toEqual([]);
  });
  it('E9 后向形态命中', () => {
    const issues = finishThicknessIssues('200mm厚找平层。');
    expectBlockIssue(issues, '装饰层工艺参数异常');
  });
  it('E9 两位数厚度不报', () => {
    expect(finishThicknessIssues('抹面厚度99mm。')).toEqual([]);
  });
  it('E9 100mm 报（≥100边界）', () => {
    expectBlockIssue(finishThicknessIssues('抹面厚度100mm。'), '装饰层工艺参数异常');
  });
  it('E9 结构层厚度不动', () => {
    expect(finishThicknessIssues('墙体厚度200mm。')).toEqual([]);
  });
  it('E9 多命中截断 unique slice(0,3)', () => {
    const issues = finishThicknessIssues('抹面厚度200mm。打底厚度300mm。找平厚度400mm。坐浆厚度500mm。');
    const message = issues[0].message;
    expect(message).toContain('抹面');
    expect(message).toContain('打底');
    expect(message).toContain('找平');
    expect(message).not.toContain('“坐浆”厚度');
  });
  it('E9 fix 前向除10（200→20）', () => {
    const result = fixFinishThickness('抹面厚度200mm，坐浆30mm。');
    expect(result.markdown).toBe('抹面厚度20mm，坐浆30mm。');
    expect(result.fixedCount).toBe(1);
  });
  it('E9 fix 150→15', () => {
    expect(fixFinishThickness('打底厚度150mm。').markdown).toBe('打底厚度15mm。');
  });
  it('E9 fix 100→10', () => {
    expect(fixFinishThickness('找平厚度100mm。').markdown).toBe('找平厚度10mm。');
  });
  it('E9 fix 后向形态除10', () => {
    const result = fixFinishThickness('200mm厚找平层。');
    expect(result.markdown).toBe('20mm厚找平层。');
    expect(result.fixedCount).toBe(1);
  });
  it('E9 fix 前后两模式同修', () => {
    const result = fixFinishThickness('抹面厚度200mm，200mm厚打底层施工。');
    expect(result.markdown).toBe('抹面厚度20mm，20mm厚打底层施工。');
    expect(result.fixedCount).toBe(2);
  });
  it('E9 fix 结构层不动', () => {
    const result = fixFinishThickness('墙体厚度200mm。');
    expect(result.markdown).toBe('墙体厚度200mm。');
    expect(result.fixedCount).toBe(0);
  });
  it('E9 fix details 记录', () => {
    expect(fixFinishThickness('抹面厚度200mm。').details).toContain('200mm→20mm');
  });
});

describe('E10 laborPeakConflict 劳动力峰值口径矛盾', () => {
  it('E10 总人数与高峰人数差>20% → 报', () => {
    const issues = laborPeakConflictIssues('高峰期总人数181人。高峰人数86人。');
    expectBlockIssue(issues, '劳动力峰值口径矛盾');
    expect(issues[0].message).toContain('181');
    expect(issues[0].message).toContain('86');
  });
  it('E10 差≤20% → 不报', () => {
    expect(laborPeakConflictIssues('高峰期总人数181人。高峰人数160人。')).toEqual([]);
  });
  it('E10 同值 → 不报', () => {
    expect(laborPeakConflictIssues('高峰期总人数181人。高峰人数181人。')).toEqual([]);
  });
  it('E10 只一口径 → 不报', () => {
    expect(laborPeakConflictIssues('高峰期总人数181人。')).toEqual([]);
  });
  it('E10 总人数三形态提取', () => {
    const md = '高峰期总人数181人。劳动力总人数150人。总人数120人。高峰人数86人。';
    const issues = laborPeakConflictIssues(md);
    expect(issues[0].message).toContain('181');
    expect(issues[0].message).toContain('150');
    expect(issues[0].message).toContain('120');
  });
  it('E10 峰值形态变体（峰值需求约）', () => {
    const issues = laborPeakConflictIssues('高峰期总人数181人。峰值需求约86人。');
    expectBlockIssue(issues, '劳动力峰值口径矛盾');
  });
  it('E10 fix 高峰口径多者胜出', () => {
    const result = fixLaborPeakConflict('高峰期总人数181人。高峰人数86人。高峰人数86人。');
    expect(result.markdown).toBe('高峰期总人数86人。高峰人数86人。高峰人数86人。');
    expect(result.fixedCount).toBe(1);
    expect(result.details[0]).toContain('181人→86人');
  });
  it('E10 fix 总人数口径多者胜出', () => {
    const result = fixLaborPeakConflict('高峰期总人数181人。劳动力总人数181人。高峰人数86人。');
    expect(result.markdown).toBe('高峰期总人数181人。劳动力总人数181人。高峰人数181人。');
  });
  it('E10 fix 同值不动', () => {
    expect(fixLaborPeakConflict('高峰期总人数181人。高峰人数181人。').fixedCount).toBe(0);
  });
  it('E10 fix 只一口径不动', () => {
    expect(fixLaborPeakConflict('高峰期总人数181人。').fixedCount).toBe(0);
  });
  it('E10 fix 零值口径防崩溃', () => {
    const result = fixLaborPeakConflict('高峰期总人数0人。高峰人数86人。');
    expect(result.markdown).toBe('高峰期总人数0人。高峰人数86人。');
    expect(result.fixedCount).toBe(0);
  });
  it('E10 20%边界（181 vs 144 → 报、181 vs 145 → 不报）', () => {
    expectBlockIssue(laborPeakConflictIssues('高峰期总人数181人。高峰人数144人。'), '劳动力峰值口径矛盾');
    expect(laborPeakConflictIssues('高峰期总人数181人。高峰人数145人。')).toEqual([]);
  });
});

describe('E11 runFixUntilClean 节点内闭环修复', () => {
  const shrinkAA = (markdown: string) => (markdown.includes('AA')
    ? { markdown: markdown.replace('AA', 'A'), fixedCount: 1 }
    : { markdown, fixedCount: 0 });
  it('E11 默认3轮单替换演化（AAAAAA→AAA）', () => {
    const result = runFixUntilClean(shrinkAA, 'AAAAAA');
    expect(result.markdown).toBe('AAA');
    expect(result.fixedCount).toBe(3);
  });
  it('E11 maxRounds 截断（AAAAAAAA 3轮→AAAAA）', () => {
    const result = runFixUntilClean(shrinkAA, 'AAAAAAAA');
    expect(result.markdown).toBe('AAAAA');
    expect(result.fixedCount).toBe(3);
  });
  it('E11 首轮零命中立即跳出', () => {
    const result = runFixUntilClean(shrinkAA, 'BB');
    expect(result.markdown).toBe('BB');
    expect(result.fixedCount).toBe(0);
  });
  it('E11 修复引入新形态逐轮消化', () => {
    const swap = (markdown: string) => (markdown.includes('AA')
      ? { markdown: markdown.replace('AA', 'BB'), fixedCount: 1 }
      : { markdown, fixedCount: 0 });
    const result = runFixUntilClean(swap, 'AAAA');
    expect(result.markdown).toBe('BBBB');
    expect(result.fixedCount).toBe(2);
  });
  it('E11 自定义轮次（10轮至干净 fixedCount 5）', () => {
    const result = runFixUntilClean(shrinkAA, 'AAAAAA', 10);
    expect(result.markdown).toBe('A');
    expect(result.fixedCount).toBe(5);
  });
});

describe('E12 runDeterministicChainUntilConverged 链级收敛循环', () => {
  const stepOne = (markdown: string) => (markdown.includes('1') ? { markdown: markdown.replaceAll('1', '2'), fixedCount: 1 } : { markdown, fixedCount: 0 });
  const stepTwo = (markdown: string) => (markdown.includes('2') ? { markdown: markdown.replaceAll('2', '3'), fixedCount: 1 } : { markdown, fixedCount: 0 });
  it('E12 链序执行收敛', () => {
    const result = runDeterministicChainUntilConverged([stepOne, stepTwo], '111');
    expect(result.markdown).toBe('333');
    expect(result.fixedCount).toBe(2);
  });
  it('E12 A修复后B新命中整链重跑', () => {
    const addB = (markdown: string) => (markdown.includes('A') ? { markdown: markdown.replaceAll('A', 'AB'), fixedCount: 1 } : { markdown, fixedCount: 0 });
    const toC = (markdown: string) => (markdown.includes('AB') ? { markdown: markdown.replaceAll('AB', 'C'), fixedCount: 1 } : { markdown, fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([addB, toC], 'AA');
    expect(result.markdown).toBe('CC');
    expect(result.fixedCount).toBe(2);
  });
  it('E12 无进展跳出', () => {
    const idle = (markdown: string) => ({ markdown, fixedCount: 0 });
    expect(runDeterministicChainUntilConverged([idle, idle], '原文')).toEqual({ markdown: '原文', fixedCount: 0 });
  });
  it('E12 maxRounds 截断', () => {
    const firstA = (markdown: string) => (markdown.includes('A') ? { markdown: markdown.replace('A', 'B'), fixedCount: 1 } : { markdown, fixedCount: 0 });
    const idle = (markdown: string) => ({ markdown, fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([firstA, idle], 'AAAA');
    expect(result.markdown).toBe('BBBA');
    expect(result.fixedCount).toBe(3);
  });
  it('E12 修复器顺序保持', () => {
    const idle = (markdown: string) => ({ markdown, fixedCount: 0 });
    const result = runDeterministicChainUntilConverged([idle, stepTwo], '222');
    expect(result.markdown).toBe('333');
  });
  it('E12 前修复器输出供后修复器消费', () => {
    const result = runDeterministicChainUntilConverged([stepOne, stepTwo], '121');
    expect(result.markdown).toBe('333');
  });
});
