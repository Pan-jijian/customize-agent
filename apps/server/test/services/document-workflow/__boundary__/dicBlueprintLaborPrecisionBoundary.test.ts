/**
 * 第十三批边界矩阵（Q 组）：蓝图 L2 造价锚定 + 公式值化 + 权威源回填（丰乐镇第 3 轮根治）。
 * 覆盖：单位混加拦截（Q1）、造价锚定窗口 1100 万 → [80,229]（Q2）、无交集以造价锚定为准（Q3）、
 * 1222 超窗校验拦截（Q4）、柴油机械临电剔除与降级定性（Q5）、milestones 权重 0 兜底（Q6）、
 * byPhase 五阶段产出（Q7）、渲染层公式符号断言与 byTrade 单值（Q8）、
 * 设备单位校验（路灯安装「项」不入高空作业车「套」）（Q9）、
 * blueprintPlanAuthorities.laborPeakAuthority 权威源回填（Q10）。
 * 原则：每条用例独立断言意义；真实实现行为一律锁定，不迎合用例改实现。
 */
import { describe, expect, it } from 'vitest';
import {
  blueprintPlanAuthorities,
  buildBlueprintData,
  buildBlueprintOutline,
  deriveCostAnchoredLaborWindow,
  deriveLaborFromBoq,
  deriveMilestonesFromBoq,
  deriveTempUtilitiesFromBoq,
  renderBlueprintDataText,
  validateBlueprint,
} from '@/services/document-workflow/integratedBlueprint';
import type { BlueprintEquipmentItem, IntegratedBlueprint } from '@/services/document-workflow/integratedBlueprint';
import type { BillOfQuantitiesResult, BoqEntry } from '@/services/document-workflow/billOfQuantitiesParser';

const FULL_CHAPTER_TITLES = [
  '主要分部分项工程施工方案',
  '物资与机械劳动力配置计划',
  '质量保证措施',
  '安全保证措施',
  '工期保证措施',
  '文明施工与环境保护',
  '施工总平面布置',
  '重难点分析及保证措施',
];

/** 手工构造清单条目（直接对象，不依赖 markdown 解析） */
function entry(seq: number, name: string, description: string, unit: string, quantity: number): BoqEntry {
  return {
    seq,
    code: String(seq).padStart(12, '0'),
    name,
    description,
    unit,
    quantity,
    section: '分部工程',
    subsection: '分节',
    villageGroup: '测试村',
    sourceFile: 'fixture.xls',
    chunkIndex: 0,
    sourceKind: 'markdown',
  };
}

/** 手工构造清单解析产物 */
function boqOf(entries: BoqEntry[]): BillOfQuantitiesResult {
  return {
    entries,
    villages: [],
    totalEntries: entries.length,
    sourceFile: 'fixture.xls',
    complete: true,
    diagnostics: { totalChunks: 1, markdownChunks: 1, declarationChunks: 0, skippedChunks: 0, droppedIncompleteRows: 0 },
  };
}

/** 公式形态符号断言集合（D 组值化红线：正文只允许计算值不允许公式） */
const FORMULA_SYMBOL_RE = /[Pp]\s*=|Σ|cos\s*φ|φ|[Kk][12]|[qQ]\s*=|×/u;

describe('Q1 单位混加拦截（m² 条目不入 m³ 组）', () => {
  it('级配碎石垫层（m²）被混凝土组（m³）跳过，混凝土工 basis 只含同单位条目', () => {
    const boq = boqOf([
      entry(1, '级配碎石垫层', '1．垫层：级配碎石', 'm2', 5000),
      entry(2, 'C20混凝土垫层', '1．混凝土强度等级：C20', 'm3', 100),
    ]);
    const labor = deriveLaborFromBoq(boq, 90, 1100, []);
    const concrete = labor.byTrade.find(item => item.trade === '混凝土工');
    expect(concrete).toBeDefined();
    expect(concrete?.basis).toContain('100m3');
    expect(concrete?.basis).not.toContain('5000');
    // 未匹配条目不进任何工种（普工 fallback 已删除）：级配碎石垫层不产生普工
    expect(labor.byTrade.find(item => item.trade === '普工')).toBeUndefined();
  });
});

describe('Q2 造价锚定窗口计算（1100 万 → [80, 229]）', () => {
  it('deriveCostAnchoredLaborWindow(1100, 77) 确定性输出 [80, 229]', () => {
    expect(deriveCostAnchoredLaborWindow(1100, 77)).toEqual({
      min: 80,
      max: 229,
      detail: '合同估算价 1100 万元 × 人工费占比 15%~25% ÷ 综合工日单价 250~350 元 ÷ 有效工期 77 天 × 峰值系数 1.3~1.6',
    });
  });
});

describe('Q3 工程量推导与造价锚定无交集（400000 m³ 土方）', () => {
  it('普工区间 {405, 1122} 与锚定 [80, 229] 无交集 → 以造价锚定为准，peakValue = 155', () => {
    const boq = boqOf([entry(1, '挖一般土方', '1．部位：村庄道路 2．土壤类别：三类土', 'm3', 400000)]);
    const labor = deriveLaborFromBoq(boq, 90, 1100, []);
    expect(labor.peakValue).toBe(155);
    expect(labor.peakBasis).toContain('无交集');
    expect(labor.peakBasis).toContain('以造价锚定区间为准');
    expect(labor.peak).toEqual({ min: 80, max: 229 });
  });
});

describe('Q4 1222 超窗值校验拦截（造价锚定量级校验）', () => {
  function buildBlueprint() {
    const boq = boqOf([entry(1, '挖一般土方', '1．部位：村庄道路', 'm3', 400000)]);
    const basicFacts = '项目名称：测试村建设项目 计划工期：90日历天 质量标准：合格 计价依据：合造价〔2018〕13号文 合同估算价：1100万元';
    const { data } = buildBlueprintData({ boq, basicFacts, projectName: '测试村建设项目' });
    const outline = buildBlueprintOutline({ chapterTitles: FULL_CHAPTER_TITLES, boq, docType: '单位工程施工组织设计' });
    const blueprint: IntegratedBlueprint = {
      meta: { version: '2.0.0', docType: '单位工程施工组织设计', createdAt: '2026-09-06', sourceMaterials: ['fixture.xls'] },
      data,
      outline,
      validation: { passed: false, checks: [] },
      diagnostics: { stage: '阶段 D', standardBlocksLoaded: 0, standardBlockGaps: [], laborDerivationBasis: '', llmCalls: 0, fallbackUsed: [], warnings: [], durationMs: 0 },
    };
    return { blueprint, boq };
  }

  it('构造蓝图通过四道校验（正常峰值 155 在量级窗口内）', () => {
    const { blueprint, boq } = buildBlueprint();
    const report = validateBlueprint(blueprint, boq);
    expect(report.passed).toBe(true);
  });

  it('篡改 peakValue = 1222 → 内部一致性校验失败且报造价锚定超窗', () => {
    const { blueprint, boq } = buildBlueprint();
    blueprint.data.resources.labor.peakValue = 1222;
    const report = validateBlueprint(blueprint, boq);
    const consistency = report.checks.find(check => check.name === '4. 内部一致性校验');
    expect(consistency?.passed).toBe(false);
    expect(consistency?.message).toContain('造价锚定');
    expect(consistency?.message).toContain('1222');
  });
});

describe('Q5 临时用电柴油机械剔除与降级定性', () => {
  const dieselOnly: BlueprintEquipmentItem[] = [
    { name: '挖掘机', spec: '0.6~1.0m³', min: 2, max: 4, basis: '' },
    { name: '自卸汽车', spec: '8t', min: 2, max: 4, basis: '' },
    { name: '压路机', spec: '8~12t', min: 1, max: 2, basis: '' },
    { name: '洒水车', spec: '', min: 1, max: 2, basis: '' },
    { name: '高空作业车', spec: '', min: 1, max: 2, basis: '' },
  ];
  const labor = deriveLaborFromBoq(boqOf([entry(1, '挖一般土方', '1．部位：村庄道路', 'm3', 400000)]), 90, 1100, []);

  it('纯柴油机械 → 定性表述不编数值（3168kW 类荒谬值根治）', () => {
    const result = deriveTempUtilitiesFromBoq(dieselOnly, labor);
    expect(result.powerLoad).toContain('柴油机械不计入用电负荷');
    expect(result.powerLoad).toContain('临时用电以村庄既有电源分散接入为主');
    expect(result.powerLoad).not.toMatch(/\d/u);
    expect(result.powerLoad).not.toMatch(FORMULA_SYMBOL_RE);
  });

  it('加蛙式打夯机（3kW 电动机具）→ 只计电动机具，用电负荷约 2 kW 无公式符号', () => {
    const result = deriveTempUtilitiesFromBoq([...dieselOnly, { name: '蛙式打夯机', spec: '', min: 1, max: 2, basis: '' }], labor);
    expect(result.powerLoad).toContain('用电负荷约 2 kW');
    expect(result.powerLoad).toContain('电动机具总功率约 3 kW');
    expect(result.powerLoad).not.toContain('挖掘机');
    expect(result.powerLoad).not.toMatch(FORMULA_SYMBOL_RE);
  });

  it('临时用水值化：引用劳动力峰值 155 人，高峰日生活用水量约 9.3 m³', () => {
    const result = deriveTempUtilitiesFromBoq(dieselOnly, labor);
    expect(result.waterUsage).toContain('高峰人数 155 人');
    expect(result.waterUsage).toContain('高峰日生活用水量约 9.3 m³');
    expect(result.waterUsage).not.toMatch(FORMULA_SYMBOL_RE);
  });
});

describe('Q6 milestones 权重 0 → 2 天下限兜底', () => {
  it('无任何分部匹配条目 → 非 prep 阶段 duration 全部 ≥ 2', () => {
    const boq = boqOf([entry(1, '其他项目', '1．描述：无', '项', 1)]);
    const milestones = deriveMilestonesFromBoq(boq, 90);
    expect(milestones).toHaveLength(5);
    for (const milestone of milestones.slice(1)) {
      expect(milestone.duration).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('Q7 byPhase 五阶段产出（分阶段计划表数据源）', () => {
  const boq = boqOf([
    entry(1, '拆除砖砌体', '1．拆除方式：人工配合机械', 'm3', 200),
    entry(2, '塑料管铺设', '1．管径：DN300', 'm', 1000),
    entry(3, '村庄道路铺装', '1．铺装形式：块料面层', 'm2', 5000),
    entry(4, '栽植乔木', '1．苗木规格：胸径10cm', 'm2', 3000),
    entry(5, '路灯安装', '1．光源：LED', '项', 1),
  ]);

  it('五个阶段全部产出且每阶段 min ≤ max', () => {
    const labor = deriveLaborFromBoq(boq, 90, 1100, []);
    expect(labor.byPhase.map(item => item.phase)).toEqual([
      '施工准备与清杂拆除',
      '污水管网工程',
      '道路铺装工程',
      '景观与绿化工程',
      '亮化与收尾工程',
    ]);
    for (const phase of labor.byPhase) {
      expect(phase.min).toBeGreaterThan(0);
      expect(phase.min).toBeLessThanOrEqual(phase.max ?? 0);
    }
  });
});

describe('Q8 渲染层公式值化与 byTrade 单值', () => {
  const boq = boqOf([
    entry(1, '拆除砖砌体', '1．拆除方式：人工配合机械', 'm3', 200),
    entry(2, '塑料管铺设', '1．管径：DN300', 'm', 1000),
    entry(3, '村庄道路铺装', '1．铺装形式：块料面层', 'm2', 5000),
    entry(4, '栽植乔木', '1．苗木规格：胸径10cm', 'm2', 3000),
    entry(5, '路灯安装', '1．光源：LED', '项', 1),
  ]);
  const basicFacts = '项目名称：测试村建设项目 计划工期：90日历天 质量标准：合格 计价依据：合造价〔2018〕13号文 合同估算价：1100万元';
  const { data } = buildBlueprintData({ boq, basicFacts, projectName: '测试村建设项目' });
  const text = renderBlueprintDataText(data);

  it('渲染文本不含任何公式符号（P =/Σ/cosφ/K1/K2/q =/×）', () => {
    expect(text).not.toMatch(FORMULA_SYMBOL_RE);
  });

  it('劳动力峰值行：155 人 + 造价锚定口径唯一峰值声明', () => {
    expect(text).toContain('- 劳动力峰值：155 人（造价锚定口径唯一峰值，各章必须引用该值，不得自设其他峰值）');
  });

  it('工种配置行归一化单值（区间中值），不再输出「不另设工种数值」表述', () => {
    expect(text).toContain('瓦工 50 人');
    expect(text).toContain('管道工 5 人');
    expect(text).toContain('绿化工 7 人');
    expect(text).toContain('电工 1 人');
    expect(text).not.toContain('不另设工种数值');
  });
});

describe('Q9 设备单位一致性（「项」条目不入「套」设备桶）', () => {
  it('路灯安装（项）不产生高空作业车（套）', () => {
    const boq = boqOf([
      entry(1, '路灯安装', '1．光源：LED', '项', 1),
      entry(2, '栽植乔木', '1．苗木规格：胸径10cm', 'm2', 3000),
    ]);
    const basicFacts = '项目名称：测试村建设项目 计划工期：90日历天 质量标准：合格 计价依据：合造价〔2018〕13号文 合同估算价：1100万元';
    const { data } = buildBlueprintData({ boq, basicFacts, projectName: '测试村建设项目' });
    expect(data.resources.equipment.find(item => item.name === '高空作业车')).toBeUndefined();
    expect(data.resources.equipment.find(item => item.name === '洒水车')).toBeDefined();
  });
});

describe('Q10 blueprintPlanAuthorities.laborPeakAuthority 权威源回填', () => {
  it('laborPeakAuthority = 蓝图 peakValue（正文峰值表述的确定性校正源）', () => {
    const boq = boqOf([
      entry(1, '拆除砖砌体', '1．拆除方式：人工配合机械', 'm3', 200),
      entry(2, '塑料管铺设', '1．管径：DN300', 'm', 1000),
      entry(3, '村庄道路铺装', '1．铺装形式：块料面层', 'm2', 5000),
      entry(4, '栽植乔木', '1．苗木规格：胸径10cm', 'm2', 3000),
      entry(5, '路灯安装', '1．光源：LED', '项', 1),
    ]);
    const basicFacts = '项目名称：测试村建设项目 计划工期：90日历天 质量标准：合格 计价依据：合造价〔2018〕13号文 合同估算价：1100万元';
    const { data } = buildBlueprintData({ boq, basicFacts, projectName: '测试村建设项目' });
    expect(data.resources.labor.peakValue).toBe(155);
    expect(blueprintPlanAuthorities(data).laborPeakAuthority).toBe(155);
  });
});
