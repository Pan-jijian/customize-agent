/**
 * 数值类检测器/修复器边界矩阵（P1 第 2 批）
 * 覆盖：laborPeak（峰值口径）/ nodeSchedule（节点工期）/ crossSection（跨节数值锚点）/
 * areaArithmetic（面积算术）/ finishThickness（装饰层厚度）/ repeatedWord（叠词）/
 * mergeTableLineResidues（表格残行）/ runFixUntilClean+Chain（收敛循环）/
 * tablePeakLabor（表峰值）/ extract*Authority（权威提取）
 */
import { describe, expect, it } from 'vitest';
import {
  areaArithmeticIssues, collapseRepeatedWords, crossSectionNumericConflictIssues,
  extractAssemblyRateAuthority, extractProjectScaleSummary, extractScheduleAuthority,
  finishThicknessIssues, fixFinishThickness, fixLaborPeakConflict, laborPeakConflictIssues,
  mergeTableLineResidues, nodeScheduleConsistencyIssues, repeatedWordIssues,
  runDeterministicChainUntilConverged, runFixUntilClean, tablePeakLabor,
  tablePeakLaborWithChainFallback,
} from '@/services/document-workflow/documentIntegrityChecks';
import type { DocumentFact, DocumentFactsModel } from '@/services/document-workflow/types';
import { caseName, product } from './boundaryKit';

type FactsModel = DocumentFactsModel;
const factsOf = (partial: Partial<FactsModel>): FactsModel => partial as FactsModel;
/** 构造完整 DocumentFact（补齐非关键字段） */
const factOf = (f: { key?: string; fieldName?: string; value: string }): DocumentFact =>
  ({ key: '', fieldName: '', sourceFile: '', roleId: '', confidence: 0, ...f });

// ── A. 劳动力峰值口径 ──

describe('A1 laborPeak 全形态组合（矛盾检测）', () => {
  const totalForms = ['高峰期总人数', '劳动力总人数', '总人数'];
  const peakForms = ['高峰人数', '高峰期人数', '峰值', '峰值需求', '峰值人数', '峰值约'];
  const rows = product(totalForms, peakForms).map(([totalForm, peakForm]) => ({
    label: caseName('A1 峰值形态', { total: totalForm, peak: peakForm }),
    conflict: `${totalForm}100人，${peakForm}60人。`,
    consistent: `${totalForm}100人，${peakForm}100人。`,
  }));
  it.each(rows)('$label 矛盾→报', ({ conflict }) => {
    const issues = laborPeakConflictIssues(conflict);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe('blocker');
  });
  it.each(rows)('$label 一致→不报', ({ consistent }) => {
    expect(laborPeakConflictIssues(consistent)).toEqual([]);
  });
});

describe('A2 laborPeak 20% 阈值边界', () => {
  const cases: Array<{ peak: number; total: number; expectIssue: boolean }> = [
    { peak: 100, total: 100, expectIssue: false },
    { peak: 100, total: 120, expectIssue: false }, // diff=20 = 20% 边界（严格大于才报）
    { peak: 100, total: 121, expectIssue: true }, // diff=21 > 20%
    { peak: 100, total: 80, expectIssue: false }, // 反向 diff=20 边界
    { peak: 100, total: 79, expectIssue: true },
    { peak: 100, total: 60, expectIssue: true },
    { peak: 1000, total: 1199, expectIssue: false }, // 199 < 200
    { peak: 1000, total: 1201, expectIssue: true },
  ];
  it.each(cases)('A2 peak=$peak total=$total → $expectIssue', ({ peak, total, expectIssue }) => {
    const md = `高峰期总人数${peak}人，高峰人数${total}人。`;
    const issues = laborPeakConflictIssues(md);
    expect(issues.length > 0).toBe(expectIssue);
  });
});

describe('A3 laborPeak 频率胜出修复', () => {
  const cases: Array<{ label: string; markdown: string; expectOut: string }> = [
    { label: '总2次峰1次→总胜', markdown: '高峰期总人数100人、总人数100人，高峰人数60人。', expectOut: '高峰期总人数100人、总人数100人，高峰人数100人。' },
    { label: '峰2次总1次→峰胜', markdown: '高峰期总人数100人，高峰人数60人、峰值需求60人。', expectOut: '高峰期总人数60人，高峰人数60人、峰值需求60人。' },
    { label: '总1峰1→峰胜（平局峰优先）', markdown: '高峰期总人数100人，高峰人数60人。', expectOut: '高峰期总人数60人，高峰人数60人。' },
    { label: '总3峰1→总胜（只改loser）', markdown: '高峰期总人数100人、总人数100人、总人数100人，高峰人数60人。', expectOut: '高峰期总人数100人、总人数100人、总人数100人，高峰人数100人。' },
  ];
  it.each(cases)('A3 $label', ({ markdown, expectOut }) => {
    const result = fixLaborPeakConflict(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe(expectOut);
  });
  it('A3 单侧缺失不修', () => {
    expect(fixLaborPeakConflict('高峰期总人数100人。').fixedCount).toBe(0);
    expect(fixLaborPeakConflict('高峰人数60人。').fixedCount).toBe(0);
  });
  it('A3 零值过滤', () => {
    expect(laborPeakConflictIssues('高峰期总人数0人，高峰人数60人。')).toEqual([]);
    expect(fixLaborPeakConflict('高峰期总人数0人，高峰人数60人。').fixedCount).toBe(0);
  });
  it('A3 同值不修', () => {
    expect(fixLaborPeakConflict('高峰期总人数100人，高峰人数100人。').fixedCount).toBe(0);
  });
});

describe('A4 laborPeak 随机组合采样（不变量）', () => {
  const totalForms = ['高峰期总人数', '劳动力总人数', '总人数'];
  const peakForms = ['高峰人数', '高峰期人数', '峰值', '峰值需求', '峰值人数', '峰值约'];
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const samples = Array.from({ length: 200 }, () => {
    const totalForm = totalForms[Math.floor(rand() * totalForms.length)];
    const peakForm = peakForms[Math.floor(rand() * peakForms.length)];
    const totalV = Math.floor(rand() * 500) + 1;
    const peakV = Math.floor(rand() * 500) + 1;
    return {
      markdown: `${totalForm}${totalV}人，${peakForm}${peakV}人。`,
      totalV, peakV,
    };
  });
  it.each(samples)('A4 随机采样 idx=%#', (s) => {
    const result = fixLaborPeakConflict(s.markdown);
    // 不变量 1：fixed ∈ {0,1}
    expect(result.fixedCount).toBeLessThanOrEqual(1);
    // 不变量 2：修复后无矛盾（幂等收敛）
    const recheck = fixLaborPeakConflict(result.markdown);
    expect(recheck.fixedCount).toBe(0);
    // 不变量 3：检测器与修复器口径一致（修复后 issues 为空）
    expect(laborPeakConflictIssues(result.markdown)).toEqual([]);
  });
});

// ── B. 节点工期口径 ──

describe('B1 nodeSchedule 四形态两两组合 × 差值档', () => {
  const forms: Record<string, string> = {
    A正序: '第{day}日完成主体结构封顶',
    B表格: '主体结构封顶完成 | 第{day}天',
    C倒序: '主体封顶节点锁定在开工后第{day}日',
    // 表格行形态必须独立成行（行首「|」），前置换行与拼接句分隔
    D表行: '\n| 主体结构封顶 | 开工后第{day}日 |',
  };
  const formPairs = product(Object.keys(forms), Object.keys(forms)).filter(([a, b]) => a < b);
  const diffs = [
    { label: '差4天→不报', first: 100, second: 104, expectIssue: false },
    { label: '差5天→报', first: 100, second: 105, expectIssue: true },
    { label: '差210天→报', first: 100, second: 310, expectIssue: true },
  ];
  const rows = formPairs.flatMap(([fa, fb]) => diffs.map(diff => ({
    label: caseName('B1 形态对×差值', { forms: `${fa}+${fb}`, diff: diff.label }),
    markdown: `${forms[fa].replace('{day}', String(diff.first))}。${forms[fb].replace('{day}', String(diff.second))}。`,
    expectIssue: diff.expectIssue,
  })));
  it.each(rows)('$label', ({ markdown, expectIssue }) => {
    const issues = nodeScheduleConsistencyIssues(markdown);
    expect(issues.length > 0).toBe(expectIssue);
  });
});

describe('B2 nodeSchedule 单样本与枚举句防护', () => {
  const singles = [
    '第210日完成主体结构封顶。',
    '主体结构封顶完成 | 第210天',
    '主体封顶节点锁定在开工后第210日。',
    '| 主体结构封顶 | 开工后第210日 |',
    '第210日完成装饰装修及幕墙。',
    '第210日完成室外工程及竣工验收。',
  ];
  it.each(singles)('B2 单样本不报 %#', (markdown) => {
    expect(nodeScheduleConsistencyIssues(markdown)).toEqual([]);
  });
  const crossBind = [
    '基础及地下室结构在第135日完成，主体结构封顶在第270日完成。', // 枚举句不跨绑
    '正负零、第300日完成主体结构封顶、第450日', // 形态B负向前瞻
    '主体结构封顶、第450日完成装饰装修', // 形态C负向前瞻
    '主体结构封顶后第10日拆除', // 「后」排除
    '第15日完成场地清表、临建搭设和基坑支护施工准备', // 准备阶段不采
  ];
  it.each(crossBind)('B2 跨节点防护不报 %#', (markdown) => {
    const issues = nodeScheduleConsistencyIssues(markdown);
    expect(issues).toEqual([]);
  });
});

describe('B3 nodeSchedule day 边界与同节点同口径', () => {
  it.each([
    ['第999日完成主体结构封顶。主体结构封顶完成 | 第999天', false],
    ['第1000日完成主体结构封顶。主体结构封顶完成 | 第1000天', false],
    ['第3000日完成主体结构封顶。主体结构封顶完成 | 第3000天', false],
    ['第3001日完成主体结构封顶。主体结构封顶完成 | 第3001天', false], // 超界过滤后只剩1样本
    ['第1日完成主体结构封顶。主体结构封顶完成 | 第1天', false],
  ] as Array<[string, boolean]>)('B3 同口径 %#', (markdown, _) => {
    expect(nodeScheduleConsistencyIssues(markdown)).toEqual([]);
  });
  it('B3 3001 超界样本不参与比较（不报）', () => {
    const md = '第3001日完成主体结构封顶。主体结构封顶完成 | 第300天';
    expect(nodeScheduleConsistencyIssues(md)).toEqual([]);
  });
  it('B3 六节点同句各自独立判定', () => {
    const md = '第100日完成基坑支护及土方外运，第120日完成地下结构出正负零，第200日完成主体结构封顶，第300日完成装饰装修及幕墙，第330日完成机电安装及智能化调试，第360日完成室外工程及竣工验收。';
    expect(nodeScheduleConsistencyIssues(md)).toEqual([]);
  });
});

// ── C. 跨节数值锚点 ──

describe('C1 crossSection 单口径不报', () => {
  const anchors: Array<[string, string]> = [
    ['挤塑聚苯板', '挤塑聚苯板厚度30mm。'],
    ['XPS', 'XPS 130mm厚。'],
    ['垫层', '垫层采用C15混凝土。'],
    ['变压器', '变压器315kVA。'],
    ['模板周转', '模板周转次数8次。'],
    ['砌块', '蒸压加气混凝土砌块A5.0。'],
    ['灭火器', '灭火器20具。'],
    ['潜水泵', '潜水泵4台。'],
  ];
  // it.each 展开 tuple 传参：fn(label, md) 两参数（单参数 row 收到的是 label）
  it.each(anchors)('C1 $0 单口径不报', (_label, md) => {
    expect(crossSectionNumericConflictIssues(md)).toEqual([]);
  });
});

describe('C2 crossSection 两口径冲突报', () => {
  const conflicts: Array<[string, string]> = [
    ['XPS 30 vs 130', '挤塑聚苯板厚度30mm。XPS厚度130mm。'],
    ['垫层 C15 vs C20', '垫层采用C15混凝土。垫层混凝土强度等级C20。'],
    ['变压器 315 vs 800', '变压器315kVA。变压器800kVA。'],
    ['模板周转 8 vs 6', '模板周转次数8次。模板周转使用6次。'],
    ['砌块 A5.0 vs A3.5', '砌块A5.0。砌块A3.5。'],
    ['灭火器 20 vs 40', '灭火器20具。灭火器40具。'],
    ['潜水泵 4 vs 8', '潜水泵4台。潜水泵8台。'],
    ['急救箱 3 vs 4', '急救箱3个。急救箱4个。'],
  ];
  it.each(conflicts)('C2 $0 报', (_label, md) => {
    const issues = crossSectionNumericConflictIssues(md);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe('blocker');
  });
});

describe('C3 crossSection 排除语境防护', () => {
  const negatives = [
    '挤塑聚苯板拼缝宽度不大于2mm。', // 宽度排除
    '挤塑聚苯板采用70mm厚岩棉板。', // 采用排除
    '外挑楼板采用70mm厚岩棉板。',
    '混凝土垫层C25。', // 异名垫层不采
    '人行道混凝土垫层C25。',
    '挤塑聚苯板铺设方向与流水方向平行。', // 铺设排除
  ];
  it.each(negatives)('C3 排除语境不报 %#', (md) => {
    expect(crossSectionNumericConflictIssues(md)).toEqual([]);
  });
});

// ── D. 面积算术 ──

describe('D1 areaArithmetic 三元组', () => {
  it('D1 算术一致不报', () => {
    expect(areaArithmeticIssues('地上500㎡、地下200㎡，单体建筑面积700㎡。')).toEqual([]);
  });
  it('D1 算术矛盾报（含差值与建议）', () => {
    const issues = areaArithmeticIssues('地上500㎡、地下200㎡，单体建筑面积800㎡。');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('差 100.00㎡');
  });
  it('D1 千分位正确计算', () => {
    expect(areaArithmeticIssues('地上1,000㎡、地下2,000㎡，单体建筑面积3,000㎡。')).toEqual([]);
  });
  it('D1 0.1% 容差边界', () => {
    const near = (total: number, sum: number) => areaArithmeticIssues(`地上${sum}㎡、地下0㎡，单体建筑面积${total}㎡。`);
    expect(near(700000, 700700)).toEqual([]); // 差 700 = 0.1% 边界（≤ 容差）
    expect(near(700000, 700702).length).toBeGreaterThan(0); // 差 702 > max(1, 700)
  });
  it('D1 单位变体全支持', () => {
    const variants = ['㎡', 'm2', 'm²', '平方米'];
    for (const unit of variants) {
      expect(areaArithmeticIssues(`地上500${unit}、地下200${unit}，单体建筑面积800${unit}。`).length).toBeGreaterThan(0);
    }
  });
  it('D1 最多报 3 处', () => {
    // 容差 = max(1, total×0.1%)：差值必须超过容差才报（差 1 的小数不报，改差 2）
    const md = '地上500㎡、地下200㎡，单体建筑面积800㎡。地上1㎡、地下1㎡，单体建筑面积4㎡。地上2㎡、地下2㎡，单体建筑面积6㎡。地上3㎡、地下3㎡，总建筑面积8㎡。';
    expect(areaArithmeticIssues(md).length).toBe(3);
  });
});

// ── E. 装饰层厚度 ──

describe('E1 finishThickness 语境词×厚度×前后置', () => {
  const contextWords = ['抹面', '打底', '找平', '坐浆', '结合层', '粘结层', '罩面', '批嵌', '腻子'];
  const rows = contextWords.flatMap(word => ([
    { label: caseName('E1 厚度前置', { word, v: '99' }), markdown: `99mm厚${word}。`, expectIssue: false },
    { label: caseName('E1 厚度前置', { word, v: '100' }), markdown: `100mm厚${word}。`, expectIssue: true },
    { label: caseName('E1 厚度前置', { word, v: '200' }), markdown: `200mm厚${word}。`, expectIssue: true },
    { label: caseName('E1 厚度前置', { word, v: '1000' }), markdown: `1000mm厚${word}。`, expectIssue: true },
    { label: caseName('E1 厚度后置', { word, v: '99' }), markdown: `${word}99mm。`, expectIssue: false },
    { label: caseName('E1 厚度后置', { word, v: '100' }), markdown: `${word}100mm。`, expectIssue: true },
    { label: caseName('E1 厚度后置', { word, v: '200' }), markdown: `${word}200mm。`, expectIssue: true },
    { label: caseName('E1 厚度后置', { word, v: '1000' }), markdown: `${word}1000mm。`, expectIssue: true },
  ]));
  it.each(rows)('$label', ({ markdown, expectIssue }) => {
    const issues = finishThicknessIssues(markdown);
    expect(issues.length > 0).toBe(expectIssue);
  });
});

describe('E2 finishThickness 结构层负例与修复', () => {
  const negatives = [
    '墙体200mm。',
    '垫层200mm。',
    '回填虚铺200mm。',
    '槽底预留200mm。',
    '抹面20mm。',
    '打底30mm。',
  ];
  it.each(negatives)('E2 结构/常规厚度不报 %#', (md) => {
    expect(finishThicknessIssues(md)).toEqual([]);
  });
  const fixes: Array<[string, string]> = [
    ['抹面200mm。', '抹面20mm。'],
    ['200mm厚打底。', '20mm厚打底。'],
    ['找平100mm。', '找平10mm。'],
    ['坐浆120mm。', '坐浆12mm。'],
    ['100mm厚结合层。', '10mm厚结合层。'],
  ];
  it.each(fixes)('E2 修复 %#', (input, expected) => {
    const result = fixFinishThickness(input);
    expect(result.markdown).toBe(expected);
    expect(result.fixedCount).toBe(1);
  });
});

// ── F. 叠词 ──

describe('F1 repeatedWord 叠词谱系', () => {
  const positives = ['执行执行', '准备准备', '严格严格', '确保确保', '进行进行', '检查检查', '验收验收', '现场现场'];
  it.each(positives)('F1 叠词报 %#', (word) => {
    const issues = repeatedWordIssues(`施工前${word}落实。`);
    expect(issues.length).toBeGreaterThan(0);
  });
  it.each(positives)('F1 叠词修 %#', (word) => {
    expect(collapseRepeatedWords(`施工前${word}落实。`)).toBe(`施工前${word.slice(0, 2)}落实。`);
  });
  // 「分部分项」术语豁免：前置「分」或后置「项」的紧邻重复不判叠词；
  // 「分部分部分项」后无「项」、属异常重复形态，应报
  const negatives = ['分部分项', '部部分项', '实实验', '预预制'];
  it.each(negatives)('F1 术语/单字不报 %#', (word) => {
    expect(repeatedWordIssues(`本工程${word}验收。`)).toEqual([]);
  });
  it('F1 异常重复「分部分部分项」报', () => {
    expect(repeatedWordIssues('本工程分部分部分项验收。').length).toBeGreaterThan(0);
  });
  it('F1 三叠收敛为单次', () => {
    // REPEATED_WORD_RE 匹配双字+双字四字形态：「重重重重」全局收敛为「重重」；
    // 三叠「重重重」无第二对完整双字，不在双字叠词检测契约内（原样保留）
    expect(collapseRepeatedWords('重重重重')).toBe('重重');
    expect(collapseRepeatedWords('重重重')).toBe('重重重');
  });
  it('F1 数字与英文不判叠词', () => {
    expect(repeatedWordIssues('11 22 AA BB')).toEqual([]);
  });
});

// ── G. 表格残行合并 ──

describe('G1 mergeTableLineResidues', () => {
  it('G1 标准残行合并', () => {
    const md = '| 段落 | 内容 |\n| --- | --- |\n| 土方 | 增开清表作业面， |\n延长有效作业时间 |';
    const result = mergeTableLineResidues(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('| 土方 | 增开清表作业面，延长有效作业时间 |');
  });
  it('G1 标点结尾不加空格', () => {
    const md = '| 段落 | 内容 |\n| --- | --- |\n| 土方 | 增开清表作业面， |\n延长有效作业时间 |';
    const result = mergeTableLineResidues(md);
    expect(result.markdown).toContain('作业面，延长');
  });
  it('G1 非标点结尾加空格', () => {
    const md = '| 段落 | 内容 |\n| --- | --- |\n| 土方 | 增开清表 |\n作业面 |';
    const result = mergeTableLineResidues(md);
    expect(result.markdown).toContain('增开清表 作业面 |');
  });
  it('G1 非表格上文不合并', () => {
    const md = '正文段落\n延长有效作业时间 |';
    const result = mergeTableLineResidues(md);
    expect(result.fixedCount).toBe(0);
  });
  it('G1 多竖线残行不合并', () => {
    const md = '| 段落 | 内容 |\n| --- | --- |\n| 土方 | 清表 |\n残|行|';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
  it('G1 标题行不合并', () => {
    const md = '| 段落 | 内容 |\n| --- | --- |\n| 土方 | 清表 |\n### 标题 |';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
});

// ── H. 收敛循环 ──

describe('H1 runFixUntilClean / runDeterministicChainUntilConverged', () => {
  it('H1 单轮收敛', () => {
    let calls = 0;
    const result = runFixUntilClean((md) => {
      calls += 1;
      return calls === 1 ? { markdown: md.replace('重重', '重'), fixedCount: 1 } : { markdown: md, fixedCount: 0 };
    }, '重重重');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('重重');
    expect(calls).toBe(2);
  });
  it('H1 多轮收敛累计', () => {
    const result = runFixUntilClean((md) => {
      // 全局收敛（同 collapseRepeatedWords 口径）：每轮清除全部叠词对
      const next = md.replace(/重重/gu, '重');
      return next === md ? { markdown: md, fixedCount: 0 } : { markdown: next, fixedCount: 1 };
    }, '重重重重');
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toBe('重');
  });
  it('H1 上限截断', () => {
    let rounds = 0;
    const result = runFixUntilClean((md) => {
      rounds += 1;
      return { markdown: md + '重', fixedCount: 1 };
    }, '重', 3);
    expect(rounds).toBe(3);
    expect(result.fixedCount).toBe(3);
  });
  it('H1 链修复 A 后 B 新命中→整链重跑', () => {
    const seen: string[] = [];
    const fixA = (md: string) => {
      seen.push('A');
      return md.includes('甲甲') ? { markdown: md.replace('甲甲', '甲'), fixedCount: 1 } : { markdown: md, fixedCount: 0 };
    };
    const fixB = (md: string) => {
      seen.push('B');
      return md.includes('乙乙') ? { markdown: md.replace('乙乙', '乙'), fixedCount: 1 } : { markdown: md, fixedCount: 0 };
    };
    const result = runDeterministicChainUntilConverged([fixA, fixB], '甲甲乙乙');
    expect(result.markdown).toBe('甲乙');
    expect(result.fixedCount).toBe(2);
    expect(seen.length).toBeGreaterThanOrEqual(4); // A B A B 至少两轮
  });
  it('H1 链无进展跳出', () => {
    let calls = 0;
    const fix = () => { calls += 1; return { markdown: 'x', fixedCount: 0 }; };
    const result = runDeterministicChainUntilConverged([fix, fix], 'x');
    expect(result.fixedCount).toBe(0);
    expect(calls).toBe(2); // 一轮即无进展
  });
});

// ── I. 表峰值劳动力 ──

describe('I1 tablePeakLabor 表结构谱系', () => {
  const peakTable = '| 阶段 | 人数 |\n| --- | --- |\n| 主体结构 | 100 |\n| 装饰装修 | 60 |';
  it('I1 峰值表取最大', () => {
    expect(tablePeakLabor(peakTable)).toBe(100);
  });
  it('I1 分工种表不入峰值池', () => {
    const tradeTable = '| 阶段 | 工种 | 人数 |\n| --- | --- | --- |\n| 主体结构 | 木工 | 100 |\n| 装饰装修 | 普工 | 60 |';
    expect(tablePeakLabor(tradeTable)).toBeUndefined();
  });
  it('I1 合计行不参与明细 peak', () => {
    // 契约：明细行存在时 peak 取明细最大值（合计行仅作无明细时的兑底值）
    const withTotal = '| 阶段 | 人数 |\n| --- | --- |\n| 主体结构 | 80 |\n| 装饰装修 | 60 |\n| 合计 | 140 |';
    expect(tablePeakLabor(withTotal)).toBe(80);
  });
  it('I1 仅合计行时合计为 peak', () => {
    // 合计标签必须在非人数列（单列「人数」表无标签位，不构成真实合计表）
    const onlyTotal = '| 阶段 | 人数 |\n| --- | --- |\n| 合计 | 140 |';
    expect(tablePeakLabor(onlyTotal)).toBe(140);
  });
  it('I1 无表回退 undefined', () => {
    expect(tablePeakLabor('正文无表。')).toBeUndefined();
  });
  it('I1 链回退：表缺失时取正文高峰最大值', () => {
    expect(tablePeakLaborWithChainFallback('高峰人数86人，高峰人数120人。')).toBe(120);
  });
  it('I1 阶段限定峰值不入权威池', () => {
    expect(tablePeakLaborWithChainFallback('管网阶段高峰35人，高峰人数86人。')).toBe(86);
  });
});

// ── J. 权威提取 ──

describe('J1 extractScheduleAuthority', () => {
  it('J1 工期标签命中', () => {
    const model = factsOf({ schedule: [factOf({ key: 'schedule', fieldName: '计划工期', value: '计划工期：2026年3月1日起，210日历天' })] });
    expect(extractScheduleAuthority(model)).toBe(210);
  });
  it('J1 周期标签命中', () => {
    const model = factsOf({ schedule: [factOf({ key: 'period', fieldName: '施工周期', value: '45日历天' })] });
    expect(extractScheduleAuthority(model)).toBe(45);
  });
  it('J1 混合长句取首个日历天', () => {
    const model = factsOf({ schedule: [factOf({ key: 's', fieldName: '工期', value: '计划工期210日历天，含冬雨季45日历天' })] });
    expect(extractScheduleAuthority(model)).toBe(210);
  });
  it('J1 非工期标签跳过', () => {
    const model = factsOf({ schedule: [factOf({ key: 'x', fieldName: '开工日期', value: '2026年3月1日起，210日历天' })] });
    expect(extractScheduleAuthority(model)).toBeUndefined();
  });
  it('J1 无日历天 undefined', () => {
    const model = factsOf({ schedule: [factOf({ key: 's', fieldName: '工期', value: '按期完成' })] });
    expect(extractScheduleAuthority(model)).toBeUndefined();
  });
  it('J1 canonical 兜底', () => {
    const model = factsOf({ canonical: { schedule: { s: [{ label: '总工期', value: '365日历天' }] as never } } as never });
    expect(extractScheduleAuthority(model)).toBe(365);
  });
  it('J1 空模型 undefined', () => {
    expect(extractScheduleAuthority(null)).toBeUndefined();
    expect(extractScheduleAuthority(factsOf({}))).toBeUndefined();
  });
});

describe('J2 extractAssemblyRateAuthority', () => {
  it('J2 装配率事实卡命中', () => {
    const model = factsOf({ project: [factOf({ key: 'assembly', fieldName: '装配率', value: '30%' })] });
    expect(extractAssemblyRateAuthority(model)).toBe(30);
  });
  it('J2 小数装配率', () => {
    const model = factsOf({ project: [factOf({ key: 'assembly', fieldName: '装配率', value: '38.4%' })] });
    expect(extractAssemblyRateAuthority(model)).toBe(38.4);
  });
  it('J2 超界值过滤', () => {
    const model = factsOf({ project: [factOf({ key: 'assembly', fieldName: '装配率', value: '150%' })] });
    expect(extractAssemblyRateAuthority(model)).toBeUndefined();
  });
  it('J2 tenderRequirements 兜底', () => {
    const model = factsOf({ tenderRequirements: { assemblyRate: { text: '装配率不低于50%' } } as never });
    expect(extractAssemblyRateAuthority(model)).toBe(50);
  });
  it('J2 非装配标签跳过', () => {
    const model = factsOf({ project: [factOf({ key: 'x', fieldName: '绿化率', value: '30%' })] });
    expect(extractAssemblyRateAuthority(model)).toBeUndefined();
  });
  it('J2 空模型 undefined', () => {
    expect(extractAssemblyRateAuthority(null)).toBeUndefined();
  });
});

describe('J3 extractProjectScaleSummary', () => {
  it('J3 面积+层数全量组合', () => {
    const model = factsOf({
      project: [factOf({ key: 'p', fieldName: '单体建筑面积', value: '5000㎡' })],
      drawings: [factOf({ value: '地上5层' })],
      tables: [{ value: '地下1层' }] as never,
    });
    expect(extractProjectScaleSummary(model)).toBe('建筑面积5000平方米、地上5层、地下1层');
  });
  it('J3 无层数省略', () => {
    const model = factsOf({ project: [factOf({ key: 'p', fieldName: '建设规模', value: '3000平方米' })] });
    expect(extractProjectScaleSummary(model)).toBe('建筑面积3000平方米');
  });
  it('J3 无面积只层数', () => {
    const model = factsOf({ drawings: [factOf({ value: '地上3层地下2层' })] });
    expect(extractProjectScaleSummary(model)).toBe('地上3层、地下2层');
  });
  it('J3 全缺 undefined', () => {
    expect(extractProjectScaleSummary(factsOf({}))).toBeUndefined();
  });
  it('J3 小数面积', () => {
    const model = factsOf({ project: [factOf({ key: 'p', fieldName: '单体建筑面积', value: '1234.5㎡' })] });
    expect(extractProjectScaleSummary(model)).toBe('建筑面积1234.5平方米');
  });
});
