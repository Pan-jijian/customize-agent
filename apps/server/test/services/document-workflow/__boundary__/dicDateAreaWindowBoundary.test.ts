/**
 * dicDateAreaWindowBoundary：日期/字段/面积三检测器的窗口精确边界与格式归一化深挖（Q 组）。
 * 覆盖增量维度（与 dicFactsBoundary/dicFieldAreaBoundary 的基线互补，不重复）：
 *  - fabricatedStartDateIssues：月日补零归一化缺口谱系、knownDates 五源、key/fieldName 槽日期、
 *    正文多日期部分命中、锚点词双向窗口精确边界（前向/后向、完整词命中才豁免）；
 *  - fieldValueMismatchIssues：标签-数值 30 字符窗口精确边界、窗口内分号/换行截断、窗口内值形态；
 *  - areaArithmeticIssues：四段窗口（地上→值 30 / 值→地下 40 / 地下→标签 60 / 标签→值 20）精确边界。
 * 全部为确定性正则提取与数值比较判定，无语义依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  areaArithmeticIssues, fabricatedStartDateIssues, fieldValueMismatchIssues,
} from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

// ── Q1. fabricatedStartDateIssues：补零归一化缺口 + 五源 + 部分命中 ──

describe('Q1 fabricatedStartDate 补零归一化缺口谱系', () => {
  it('Q1-1 资料不补零+正文月补零 → 报（日期串不归一补零）', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月5日' })] });
    expect(fabricatedStartDateIssues('本工程2026年03月05日开工。', model).length).toBe(1);
  });
  it('Q1-2 资料不补零+正文月补零日不补 → 报', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月5日' })] });
    expect(fabricatedStartDateIssues('本工程2026年03月5日开工。', model).length).toBe(1);
  });
  it('Q1-3 资料不补零+正文日补零 → 报', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月5日' })] });
    expect(fabricatedStartDateIssues('本工程2026年3月05日开工。', model).length).toBe(1);
  });
  it('Q1-4 资料补零+正文不补零 → 报（反向形态同样不等）', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年03月05日' })] });
    expect(fabricatedStartDateIssues('本工程2026年3月5日开工。', model).length).toBe(1);
  });
  it('Q1-5 资料补零+正文同补零 → 不报（同形态合法）', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年03月05日' })] });
    expect(fabricatedStartDateIssues('本工程2026年03月05日开工。', model)).toEqual([]);
  });
  it('Q1-6 正文日期带空格+资料同日期 → 不报（空格形态归一）', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月5日' })] });
    expect(fabricatedStartDateIssues('本工程2026 年 3 月 5 日开工。', model)).toEqual([]);
  });
});

describe('Q1 knownDates 五源与槽位谱系（hasMaterialDates=false 时锚点门关闭）', () => {
  it('Q1-7 quality 源日期入 knownDates → 正文同日期合法', () => {
    const model = factsOf({ quality: [factOf({ value: '竣工验收2026年6月1日' })] });
    expect(fabricatedStartDateIssues('本工程2026年6月1日。', model)).toEqual([]);
  });
  it('Q1-8 resources 源日期入 knownDates → 正文同日期合法', () => {
    const model = factsOf({ resources: [factOf({ value: '设备进场2026年6月2日' })] });
    expect(fabricatedStartDateIssues('本工程2026年6月2日。', model)).toEqual([]);
  });
  it('Q1-9 preciseFacts 源日期入 knownDates → 正文同日期合法', () => {
    const model = factsOf({ preciseFacts: [factOf({ value: '开工令2026年6月3日' })] });
    expect(fabricatedStartDateIssues('本工程2026年6月3日。', model)).toEqual([]);
  });
  it('Q1-10 project 的 key 槽日期入 knownDates → 合法', () => {
    const model = factsOf({ project: [factOf({ key: '2026年7月1日', value: '开工日' })] });
    expect(fabricatedStartDateIssues('本工程2026年7月1日。', model)).toEqual([]);
  });
  it('Q1-11 project 的 fieldName 槽日期入 knownDates → 合法', () => {
    const model = factsOf({ project: [factOf({ fieldName: '开工令日期2026年8月1日', value: '—' })] });
    expect(fabricatedStartDateIssues('本工程2026年8月1日。', model)).toEqual([]);
  });
  it('Q1-12 仅 quality 源有日期（hasMaterialDates=false）时锚点词不豁免 → 报', () => {
    const model = factsOf({ quality: [factOf({ value: '2026年6月1日' })] });
    expect(fabricatedStartDateIssues('进度计划2026年9月1日。', model).length).toBe(1);
  });
  it('Q1-13 project 源有日期（hasMaterialDates=true）时同锚点词豁免 → 不报（对照 Q1-12）', () => {
    const model = factsOf({ project: [factOf({ value: '开工2026年3月1日' })] });
    expect(fabricatedStartDateIssues('进度计划2026年9月1日。', model)).toEqual([]);
  });
});

describe('Q1 正文多日期部分命中谱系', () => {
  it('Q1-14 已知日期跳过+未知日期报 → 只报 1 条', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    const issues = fabricatedStartDateIssues('2026年3月1日开工，2026年9月1日竣工。', model);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('2026年9月1日');
  });
  it('Q1-15 未知日期被后向锚点词豁免 → 0 条', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    expect(fabricatedStartDateIssues('2026年3月1日开工，竣工日期2026年9月1日。', model)).toEqual([]);
  });
});

// ── Q2. fabricatedStartDateIssues：锚点词双向窗口精确边界（完整词命中才豁免） ──

describe('Q2 fabricatedStartDate 锚点词后向窗口边界', () => {
  const anchors = ['进度计划', '里程碑', '节点安排', '验收时间', '完成日期', '竣工日期', '移交日期', '合同签订'];
  it.each(anchors)('Q2-1 锚点“$0”紧邻日期后 → 豁免', (anchor) => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    expect(fabricatedStartDateIssues(`本工程2026年9月1日${anchor}。`, model)).toEqual([]);
  });
  it.each(anchors)('Q2-2 锚点“$0”后向 36 字符（完整词恰入窗口右界）→ 豁免', (anchor) => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    const md = `本工程2026年9月1日${'、'.repeat(36)}${anchor}。`;
    expect(fabricatedStartDateIssues(md, model)).toEqual([]);
  });
  it.each(['进度计划', '竣工日期'])('Q2-3 锚点“$0”后向 37 字符（完整词出窗口）→ 报', (anchor) => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    const md = `本工程2026年9月1日${'、'.repeat(37)}${anchor}。`;
    expect(fabricatedStartDateIssues(md, model).length).toBe(1);
  });
});

describe('Q2 fabricatedStartDate 锚点词前向窗口边界', () => {
  it('Q2-4 锚点词前向 33 字符（完整词恰入窗口左界）→ 豁免', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    const md = `进度计划${'、'.repeat(33)}本工程2026年9月1日。`;
    expect(fabricatedStartDateIssues(md, model)).toEqual([]);
  });
  it.each(['进度计划', '合同签订'])('Q2-5a 锚点“$0”（4字）前向 34 字符 → 报', (anchor) => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    const md = `${anchor}${'、'.repeat(34)}本工程2026年9月1日。`;
    expect(fabricatedStartDateIssues(md, model).length).toBe(1);
  });
  it('Q2-5b 锚点“里程碑”（3字）前向 34 字符恰入窗口左界 → 豁免', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    const md = `里程碑${'、'.repeat(34)}本工程2026年9月1日。`;
    expect(fabricatedStartDateIssues(md, model)).toEqual([]);
  });
  it('Q2-5c 锚点“里程碑”（3字）前向 35 字符出窗口 → 报', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    const md = `里程碑${'、'.repeat(35)}本工程2026年9月1日。`;
    expect(fabricatedStartDateIssues(md, model).length).toBe(1);
  });
  it('Q2-6 锚点词跨窗口左界（词尾在窗口内词首在外）→ 不豁免报', () => {
    const model = factsOf({ schedule: [factOf({ value: '开工2026年3月1日' })] });
    // 锚点词 4 字中仅末字落在窗口左界内（起点 index-41），完整词匹配失败 → 报
    const md = `进度计划${'、'.repeat(37)}本工程2026年9月1日。`;
    expect(fabricatedStartDateIssues(md, model).length).toBe(1);
  });
});

// ── Q3. fieldValueMismatchIssues：标签-数值 30 字符窗口精确边界 ──

describe('Q3 fieldValueMismatch 标签-数值窗口边界', () => {
  const model = () => factsOf({
    project: [
      factOf({ fieldName: '总占地面积', value: '30000㎡' }),
      factOf({ fieldName: '单体建筑面积', value: '28500㎡' }),
    ],
  });
  const bodyLabels = ['单体建筑面积', '总建筑面积', '建筑面积'];
  it.each(bodyLabels)('Q3-1 标签“$0”+30 字符内数值命中 → 报', (label) => {
    const md = `${label}${'的'.repeat(25)}30000㎡。`;
    expect(fieldValueMismatchIssues(md, model()).length).toBe(1);
  });
  it('Q3-2 恰 30 字符窗口边界命中 → 报', () => {
    const md = `建筑面积${'的'.repeat(30)}30000㎡。`;
    expect(fieldValueMismatchIssues(md, model()).length).toBe(1);
  });
  it('Q3-3 31 字符超窗口 → 不报', () => {
    const md = `建筑面积${'的'.repeat(31)}30000㎡。`;
    expect(fieldValueMismatchIssues(md, model())).toEqual([]);
  });
  it('Q3-4 窗口内分号截断 → 不报', () => {
    const md = `建筑面积${'的'.repeat(10)}；${'的'.repeat(19)}30000㎡。`;
    expect(fieldValueMismatchIssues(md, model())).toEqual([]);
  });
  it('Q3-5 窗口内换行截断 → 不报', () => {
    const md = `建筑面积${'的'.repeat(10)}\n${'的'.repeat(19)}30000㎡。`;
    expect(fieldValueMismatchIssues(md, model())).toEqual([]);
  });
  it('Q3-6 窗口内千分位数值命中 → 报', () => {
    const md = `建筑面积${'的'.repeat(25)}30,000㎡。`;
    expect(fieldValueMismatchIssues(md, model()).length).toBe(1);
  });
  it('Q3-7 窗口内小数数值命中 → 报', () => {
    const m = factsOf({
      project: [
        factOf({ fieldName: '总占地面积', value: '30000.5㎡' }),
        factOf({ fieldName: '单体建筑面积', value: '28500㎡' }),
      ],
    });
    const md = `建筑面积${'的'.repeat(25)}30000.5㎡。`;
    expect(fieldValueMismatchIssues(md, m).length).toBe(1);
  });
  it('Q3-8 窗口内值属建筑面积池 → 不报（两池区分在窗口远距下仍有效）', () => {
    const md = `建筑面积${'的'.repeat(25)}28500㎡。`;
    expect(fieldValueMismatchIssues(md, model())).toEqual([]);
  });
});

// ── Q4. areaArithmeticIssues：四段窗口精确边界全谱系 ──

describe('Q4 areaArithmetic 四段窗口精确边界', () => {
  it('Q4-1 地上→值 30 字符恰边界 → 命中报', () => {
    expect(areaArithmeticIssues(`地上${'、'.repeat(30)}100㎡地下200㎡，单体建筑面积500㎡。`).length).toBe(1);
  });
  it('Q4-2 地上→值 31 字符超窗口 → 不报', () => {
    expect(areaArithmeticIssues(`地上${'、'.repeat(31)}100㎡地下200㎡，单体建筑面积500㎡。`)).toEqual([]);
  });
  it('Q4-3 值→地下 40 字符恰边界 → 命中报', () => {
    expect(areaArithmeticIssues(`地上100㎡${'、'.repeat(40)}地下200㎡，单体建筑面积500㎡。`).length).toBe(1);
  });
  it('Q4-4 值→地下 41 字符超窗口 → 不报', () => {
    expect(areaArithmeticIssues(`地上100㎡${'、'.repeat(41)}地下200㎡，单体建筑面积500㎡。`)).toEqual([]);
  });
  it('Q4-5 地下→标签 60 字符恰边界 → 命中报', () => {
    expect(areaArithmeticIssues(`地上100㎡地下200㎡${'、'.repeat(60)}单体建筑面积500㎡。`).length).toBe(1);
  });
  it('Q4-6 地下→标签 61 字符超窗口 → 不报', () => {
    expect(areaArithmeticIssues(`地上100㎡地下200㎡${'、'.repeat(61)}单体建筑面积500㎡。`)).toEqual([]);
  });
  it('Q4-7 标签→值 20 字符恰边界 → 命中报', () => {
    expect(areaArithmeticIssues(`地上100㎡地下200㎡单体建筑面积${'、'.repeat(20)}500㎡。`).length).toBe(1);
  });
  it('Q4-8 标签→值 21 字符超窗口 → 不报', () => {
    expect(areaArithmeticIssues(`地上100㎡地下200㎡单体建筑面积${'、'.repeat(21)}500㎡。`)).toEqual([]);
  });
});

describe('Q4 areaArithmetic 窗口边界内自洽与标签谱系', () => {
  it('Q4-9 地上→值 30 边界内自洽（和=总）→ 不报', () => {
    expect(areaArithmeticIssues(`地上${'、'.repeat(30)}300㎡地下200㎡，单体建筑面积500㎡。`)).toEqual([]);
  });
  it('Q4-10 值→地下 40 边界内自洽 → 不报', () => {
    expect(areaArithmeticIssues(`地上300㎡${'、'.repeat(40)}地下200㎡，单体建筑面积500㎡。`)).toEqual([]);
  });
  it('Q4-11 地下→标签 60 边界内自洽 → 不报', () => {
    expect(areaArithmeticIssues(`地上300㎡地下200㎡${'、'.repeat(60)}单体建筑面积500㎡。`)).toEqual([]);
  });
  it('Q4-12 标签→值 20 边界内自洽 → 不报', () => {
    expect(areaArithmeticIssues(`地上300㎡地下200㎡单体建筑面积${'、'.repeat(20)}500㎡。`)).toEqual([]);
  });
  it('Q4-13 总建筑面积标签+窗口内矛盾 → 报', () => {
    expect(areaArithmeticIssues(`地上100㎡地下200㎡总建筑面积${'、'.repeat(15)}500㎡。`).length).toBe(1);
  });
  it('Q4-14 总建筑面积标签+地下→标签 60 边界矛盾 → 报', () => {
    expect(areaArithmeticIssues(`地上100㎡地下200㎡${'、'.repeat(60)}总建筑面积500㎡。`).length).toBe(1);
  });
  it('Q4-15 总建筑面积标签+61 字符超窗口 → 不报', () => {
    expect(areaArithmeticIssues(`地上100㎡地下200㎡${'、'.repeat(61)}总建筑面积500㎡。`)).toEqual([]);
  });
});

describe('Q4 areaArithmetic 单位混合/断句/数值形态', () => {
  it('Q4-16 单位混合（㎡/m²/平方米）矛盾 → 报', () => {
    expect(areaArithmeticIssues('地上100㎡地下200m²单体建筑面积500平方米。').length).toBe(1);
  });
  it('Q4-17 单位混合自洽 → 不报', () => {
    expect(areaArithmeticIssues('地上300㎡地下200m²单体建筑面积500平方米。')).toEqual([]);
  });
  it('Q4-18 句号断开（窗口不可跨句）→ 不报', () => {
    expect(areaArithmeticIssues('地上100㎡，地下200㎡。单体建筑面积500㎡。')).toEqual([]);
  });
  it('Q4-19 分号断开 → 不报', () => {
    expect(areaArithmeticIssues('地上100㎡；地下200㎡，单体建筑面积500㎡。')).toEqual([]);
  });
  it('Q4-20 小数三元组差超容差 → 报（差 1.75 > 容差 1.50175）', () => {
    expect(areaArithmeticIssues('地上1000.5㎡地下500.25㎡总建筑面积1502.5㎡。').length).toBe(1);
  });
  it('Q4-21 小数三元组差 1 即报（1500.75 vs 1501.75）', () => {
    expect(areaArithmeticIssues('地上1000.5㎡地下500.25㎡总建筑面积1501.75㎡。').length).toBe(1);
  });
  it('Q4-22 千分位+值→地下 40 窗口边界矛盾 → 报', () => {
    expect(areaArithmeticIssues(`地上10,000㎡${'、'.repeat(40)}地下5,000㎡单体建筑面积14,000㎡。`).length).toBe(1);
  });
});
