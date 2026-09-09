/**
 * 工程类型策略表注册制单测（蓝图 L2 推导层工程类型全覆盖）：
 * - 一期：resolveDerivationStrategy 双信号解析、气候区域表、里程碑均分兜底、村域行为锁定；
 * - 二期：桥隧/公路/水利策略组判别与参数完整性；
 * - 三期：定额知识库接入点（laborQuotaTable 命中替换经验区间）与未命中降级的机制验证。
 * 原则：策略组为确定性常量，行为锁定；六策略组一律不内置定额数据（防编造），村域组（丰乐镇口径）缺省零变化。
 */
import { describe, expect, it } from 'vitest';
import {
  bridgeTunnelStrategy,
  buildingStrategy,
  climateForZone,
  generalStrategy,
  highwayStrategy,
  resolveClimateByLocation,
  resolveDerivationStrategy,
  villageMunicipalStrategy,
  waterConservancyStrategy,
  type BlueprintDerivationStrategy,
} from '@/services/document-workflow/blueprintDerivationStrategies';
import {
  buildBlueprintData,
  deriveConstructionDeployment,
  deriveEquipmentFromBoq,
  deriveKeyDifficulties,
  deriveLaborFromBoq,
  deriveMilestonesFromBoq,
} from '@/services/document-workflow/integratedBlueprint';
import type { BillOfQuantitiesResult, BoqEntry, BoqVillageReport } from '@/services/document-workflow/billOfQuantitiesParser';

/** 手工构造清单条目 */
function entry(
  seq: number,
  name: string,
  description: string,
  unit: string,
  quantity: number,
  options: { section?: string; subsection?: string } = {},
): BoqEntry {
  return {
    seq,
    code: String(seq).padStart(12, '0'),
    name,
    description,
    unit,
    quantity,
    section: options.section || '分部工程',
    subsection: options.subsection || '分节',
    villageGroup: '测试村',
    sourceFile: 'fixture.xls',
    chunkIndex: 0,
    sourceKind: 'markdown',
  };
}

/** 手工构造自然村分组报告 */
function villageOf(name: string, entryCount: number): BoqVillageReport {
  return {
    villageGroup: name,
    sheetId: 'sheet-1',
    pagesCovered: [1],
    pagesMissing: [],
    entryCount,
    entrySeqMissing: [],
    entriesFromDeclaration: 0,
    entriesWithoutCode: 0,
    entriesWithoutName: 0,
    entriesWithInvalidCode: 0,
    complete: true,
  };
}

/** 手工构造清单解析产物 */
function boqOf(entries: BoqEntry[], villages: BoqVillageReport[] = []): BillOfQuantitiesResult {
  return {
    entries,
    villages,
    totalEntries: entries.length,
    sourceFile: 'fixture.xls',
    complete: true,
    diagnostics: { totalChunks: 1, markdownChunks: 1, declarationChunks: 0, skippedChunks: 0, droppedIncompleteRows: 0 },
  };
}

/** 村域特征清单（管网+道路+绿化+亮化四信号，美丽乡村类） */
function villageBoq(): BillOfQuantitiesResult {
  return boqOf([
    entry(1, '塑料管铺设', '1．规格：DN200', 'm', 500, { section: '污水管网工程' }),
    entry(2, '挖沟槽土方', '1．开挖深度：2m 2．含回填', 'm3', 800, { section: '污水管网工程' }),
    entry(3, '水泥混凝土路面', '1．厚度：15cm', 'm2', 2000, { section: '道路工程' }),
    entry(4, '绿化栽植', '1．苗木：乔木', 'm2', 3000, { section: '绿化工程' }),
    entry(5, '路灯安装', '1．功率：60W', '套', 50, { section: '亮化工程' }),
  ], [villageOf('测试村', 5)]);
}

/** 房建特征清单（土方/混凝土/钢筋/砌体/装饰/塔吊） */
function buildingBoq(): BillOfQuantitiesResult {
  return boqOf([
    entry(1, '挖基坑土方', '1．开挖深度：2.5m', 'm3', 300, { section: '土方工程' }),
    entry(2, '现浇混凝土基础', '1．强度等级：C30', 'm3', 120, { section: '基础工程' }),
    entry(3, '钢筋制安', '1．牌号：HRB400', 't', 30, { section: '主体结构工程' }),
    entry(4, '砌体墙', '1．砖品种：烧结砖', 'm3', 200, { section: '主体结构工程' }),
    entry(5, '内墙抹灰', '1．砂浆配合比：1:3', 'm2', 1500, { section: '装饰装修工程' }),
    entry(6, '塔式起重机基础', '1．塔吊', '项', 1, { section: '措施项目' }),
  ]);
}

/** 桥隧特征清单（土方/桩基/下部/上部/钢筋/钢绞线六类信号） */
function bridgeBoq(): BillOfQuantitiesResult {
  return boqOf([
    entry(1, '基坑开挖土方', '1．开挖深度：3m', 'm3', 300, { section: '基础工程' }),
    entry(2, '钻孔灌注桩', '1．桩径：1.2m', 'm3', 50, { section: '基础工程' }),
    entry(3, '桥墩混凝土', '1．强度等级：C40', 'm3', 150, { section: '下部结构工程' }),
    entry(4, '现浇箱梁', '1．强度等级：C50', 'm3', 200, { section: '上部结构工程' }),
    entry(5, '钢筋制安', '1．牌号：HRB400', 't', 80, { section: '上部结构工程' }),
    entry(6, '预应力钢绞线', '1．规格：Φs15.2', 't', 40, { section: '上部结构工程' }),
  ]);
}

/** 公路特征清单（路基/基层/沥青面层/混凝土路面/边沟/交安/钢筋七类信号） */
function highwayBoq(): BillOfQuantitiesResult {
  return boqOf([
    entry(1, '路基土方开挖', '1．土壤类别：三类土', 'm3', 5000, { section: '路基工程' }),
    entry(2, '水泥稳定碎石基层', '1．厚度：20cm', 'm2', 8000, { section: '路面工程' }),
    entry(3, '沥青混凝土面层', '1．厚度：6cm', 'm2', 8000, { section: '路面工程' }),
    entry(4, '混凝土路面', '1．厚度：22cm', 'm2', 2000, { section: '路面工程' }),
    entry(5, '浆砌片石边沟', '1．断面：40×40cm', 'm3', 500, { section: '排水工程' }),
    entry(6, '波形梁护栏', '1．规格：双波', 'm', 1000, { section: '交安工程' }),
    entry(7, '护栏预埋钢筋', '1．牌号：HPB300', 't', 5, { section: '交安工程' }),
  ]);
}

/** 水利特征清单（土方/混凝土/钢筋/模板/金属结构/护坡六类信号） */
function waterBoq(): BillOfQuantitiesResult {
  return boqOf([
    entry(1, '土方开挖', '1．土壤类别：三类土', 'm3', 1000, { section: '土方与基础工程' }),
    entry(2, '闸室混凝土', '1．强度等级：C30', 'm3', 300, { section: '闸站结构工程' }),
    entry(3, '钢筋制安', '1．牌号：HRB400', 't', 30, { section: '闸站结构工程' }),
    entry(4, '闸墩模板', '1．面板：胶合板', 'm2', 800, { section: '闸站结构工程' }),
    entry(5, '金属结构安装', '1．闸门', 't', 20, { section: '金属结构安装' }),
    entry(6, '浆砌块石护坡', '1．厚度：30cm', 'm2', 500, { section: '护坡堤防工程' }),
  ]);
}

const CHAPTER_TITLES = ['主要分部分项工程施工方案', '物资与机械劳动力配置计划', '质量保证措施', '安全保证措施', '工期保证措施', '文明施工与环境保护', '施工总平面布置', '重难点分析及保证措施'];

describe('resolveDerivationStrategy 双信号解析（工程类型注册制）', () => {
  it('村域清单特征（villages>0 + 管网/道路/绿化/亮化）→ village-municipal', () => {
    const strategy = resolveDerivationStrategy({ basicFacts: '项目名称：美丽乡村建设项目', chapterTitles: [], boq: villageBoq() });
    expect(strategy.id).toBe('village-municipal');
  });

  it('丰乐镇真实文本 fixture（模板名+基本事实+清单分部）→ 稳定命中 village-municipal', () => {
    const strategy = resolveDerivationStrategy({
      templateName: '2026年度丰乐镇20个美丽宜居自然村建设项目',
      basicFacts: '项目名称：2026年度丰乐镇20个美丽宜居自然村建设项目 建设地点：安徽省合肥市肥西县丰乐镇 计划工期：360日历天',
      chapterTitles: CHAPTER_TITLES,
      boq: villageBoq(),
    });
    expect(strategy.id).toBe('village-municipal');
  });

  it('房建文本（安置房+主体结构+砌体+基坑）→ building', () => {
    const strategy = resolveDerivationStrategy({
      templateName: 'XX安置房项目施工组织设计',
      basicFacts: '项目名称：XX安置房项目 建设内容：主体结构、砌体、基坑支护',
      chapterTitles: [],
      boq: buildingBoq(),
    });
    expect(strategy.id).toBe('building');
  });

  it('桥隧文本（桥梁+箱梁+下部上部结构）→ bridge-tunnel', () => {
    const strategy = resolveDerivationStrategy({
      templateName: 'XX大桥工程施工组织设计',
      basicFacts: '项目名称：XX桥梁工程 建设内容：桥梁下部结构、上部结构、箱梁预制、桥面系',
      chapterTitles: [],
      boq: bridgeBoq(),
    });
    expect(strategy.id).toBe('bridge-tunnel');
  });

  it('公路文本（公路+路基+路面+沥青）→ highway', () => {
    const strategy = resolveDerivationStrategy({
      templateName: 'XX公路工程施工组织设计',
      basicFacts: '项目名称：XX公路工程 建设内容：路基工程、路面工程、沥青面层',
      chapterTitles: [],
      boq: highwayBoq(),
    });
    expect(strategy.id).toBe('highway');
  });

  it('水利文本（泵站+水闸+节制闸+围堰）→ water-conservancy', () => {
    const strategy = resolveDerivationStrategy({
      templateName: 'XX泵站工程施工组织设计',
      basicFacts: '项目名称：XX水闸工程 建设内容：泵站、节制闸、围堰导流',
      chapterTitles: [],
      boq: waterBoq(),
    });
    expect(strategy.id).toBe('water-conservancy');
  });

  it('无任何类型信号 → general', () => {
    const boq = boqOf([entry(1, '土方开挖', '1．土壤类别：三类土', 'm3', 100)]);
    const strategy = resolveDerivationStrategy({ basicFacts: '项目名称：XX工程', chapterTitles: [], boq });
    expect(strategy.id).toBe('general');
  });
});

describe('气候区域表（resolveClimateByLocation / climateForZone）', () => {
  it('安徽 → east（丰乐镇历史硬编码值迁入）', () => {
    expect(resolveClimateByLocation('安徽省合肥市肥西县')).toEqual({ rainySeason: '6-8月', highTemp: '7-8月', winter: '12-2月' });
  });

  it('黑龙江 → northeast（严寒冬施口径）', () => {
    expect(resolveClimateByLocation('黑龙江省哈尔滨市')).toEqual({ rainySeason: '7-8月', highTemp: '7月', winter: '11-3月' });
  });

  it('匹配不到 → 空对象（宁缺毋错，不注入错误气候值）', () => {
    expect(resolveClimateByLocation('未知地点')).toEqual({ rainySeason: '', highTemp: '', winter: '' });
  });

  it('climateForZone：east 有值、undefined 空', () => {
    expect(climateForZone('east')).toEqual({ rainySeason: '6-8月', highTemp: '7-8月', winter: '12-2月' });
    expect(climateForZone(undefined)).toEqual({ rainySeason: '', highTemp: '', winter: '' });
  });

  it('策略组气候区兜底：村域 east（零变化）、general 不注入', () => {
    expect(villageMunicipalStrategy.climateZone).toBe('east');
    expect(generalStrategy.climateZone).toBeUndefined();
  });
});

describe('六策略组参数完整性（确定性常量）', () => {
  const strategies: Array<{ id: string; strategy: BlueprintDerivationStrategy }> = [
    { id: 'village-municipal', strategy: villageMunicipalStrategy },
    { id: 'building', strategy: buildingStrategy },
    { id: 'general', strategy: generalStrategy },
    { id: 'bridge-tunnel', strategy: bridgeTunnelStrategy },
    { id: 'highway', strategy: highwayStrategy },
    { id: 'water-conservancy', strategy: waterConservancyStrategy },
  ];

  for (const { id, strategy } of strategies) {
    it(`${id}：里程碑/工种/工效/机械映射全部非空`, () => {
      expect(strategy.milestoneGroups.length).toBeGreaterThanOrEqual(4);
      expect(strategy.tradeMapping.length).toBeGreaterThanOrEqual(5);
      expect(Object.keys(strategy.laborUnitRange).length).toBeGreaterThanOrEqual(5);
      expect(strategy.equipmentMapping.length).toBeGreaterThanOrEqual(4);
      expect(strategy.machinePowerTable.length).toBeGreaterThan(0);
    });
  }

  it('定额知识库接入点：六策略组一律未配置（零编造数据锁，行为与 4.20.1 一致）', () => {
    for (const { strategy } of strategies) {
      expect(strategy.laborQuotaTable).toBeUndefined();
    }
  });
});

describe('里程碑均分兜底（P0：根治跨类型「360 天工期只推导 37 天」）', () => {
  it('分部特征全部未命中策略分组 → 按总工期均分，不超总工期', () => {
    const boq = boqOf([entry(1, 'X射线探伤', '1．探伤', '项', 10)]);
    const milestones = deriveMilestonesFromBoq(boq, 360, generalStrategy);
    expect(milestones.length).toBe(generalStrategy.milestoneGroups.length);
    const nonPrep = milestones.slice(1);
    for (const item of nonPrep) {
      expect(item.duration).toBeGreaterThanOrEqual(2);
      expect(item.basis).toContain('均分降级');
    }
    const sum = milestones.reduce((acc, item) => acc + (item.duration || 0), 0);
    expect(sum).toBeLessThanOrEqual(360);
  });

  it('分部特征权重足够 → 不触发均分降级（房建组）', () => {
    const milestones = deriveMilestonesFromBoq(buildingBoq(), 360, buildingStrategy);
    expect(milestones.length).toBe(buildingStrategy.milestoneGroups.length);
    expect(milestones.map(item => item.label)).toEqual(expect.arrayContaining(['基础工程', '主体结构工程', '装饰装修工程']));
    for (const item of milestones) expect(item.basis).not.toContain('均分降级');
  });
});

describe('定额知识库接入点机制（laborQuotaTable 命中替换经验区间，数据由权威定额库导入）', () => {
  // 生产策略组一律不内置定额数据；这里用测试夹具注入临时定额行验证接入机制
  const fixtureStrategy: BlueprintDerivationStrategy = {
    ...buildingStrategy,
    laborQuotaTable: [
      { subName: '钢筋制安', pattern: /钢筋|植筋/u, unit: 't', min: 4, max: 6, code: 'FJ-01', source: '测试夹具定额行（机制验证，非生产数据）' },
      { subName: '现浇混凝土', pattern: /混凝土|现浇|垫层/u, unit: 'm3', min: 1.0, max: 1.5, code: 'FJ-03', source: '测试夹具定额行（机制验证，非生产数据）' },
    ],
  };

  it('命中定额行 → basis 标注定额工效（子目名+编号+工日区间）并替换经验区间', () => {
    const labor = deriveLaborFromBoq(buildingBoq(), 90, 0, [], fixtureStrategy);
    const rebar = labor.byTrade.find(item => item.trade === '钢筋工');
    const concrete = labor.byTrade.find(item => item.trade === '混凝土工');
    expect(rebar?.basis).toContain('定额工效（钢筋制安 FJ-01');
    expect(concrete?.basis).toContain('定额工效（现浇混凝土 FJ-03');
    expect(rebar?.basis).not.toContain('经验工效区间');
  });

  it('定额未覆盖条目 → 降级经验区间表达（无定额命中形态）', () => {
    const boq = boqOf([entry(1, '挤塑板保温', '1．厚度：30mm', 'm2', 500)]);
    const labor = deriveLaborFromBoq(boq, 90, 0, [], fixtureStrategy);
    const insulation = labor.byTrade.find(item => item.trade === '保温工');
    expect(insulation).toBeDefined();
    expect(insulation?.basis).toContain('经验工效区间');
    // 降级文案「定额工效知识不全」含字面「定额工效」，区分定额命中形态「定额工效（」
    expect(insulation?.basis).not.toContain('定额工效（');
  });

  it('生产策略组未配置定额表 → 全部条目走经验区间（编造数据零进入）', () => {
    const labor = deriveLaborFromBoq(buildingBoq(), 90, 0, [], buildingStrategy);
    for (const item of labor.byTrade) {
      expect(item.basis).not.toContain('定额工效（');
    }
    const bridgeLabor = deriveLaborFromBoq(bridgeBoq(), 90, 0, [], bridgeTunnelStrategy);
    for (const item of bridgeLabor.byTrade) {
      expect(item.basis).not.toContain('定额工效（');
    }
  });
});

describe('房建组端到端（二期 fixture：机械/部署/重难点）', () => {
  it('deriveEquipmentFromBoq：塔式起重机出现（房建组机械映射）', () => {
    const equipment = deriveEquipmentFromBoq(buildingBoq(), buildingStrategy);
    expect(equipment.map(item => item.name)).toContain('塔式起重机');
  });

  it('deriveConstructionDeployment：无村分组时输出通用兑底，不出现「村内流水作业」', () => {
    const deployment = deriveConstructionDeployment(buildingBoq(), buildingStrategy);
    expect(deployment.flow).toBe('分区段流水作业');
    expect(deployment.flow).not.toContain('村内流水作业');
    expect(deployment.sequence).toContain('土方工程');
  });

  it('deriveKeyDifficulties：塔吊命中 → 垂直运输组织（房建组模板）', () => {
    const difficulties = deriveKeyDifficulties(buildingBoq(), buildingStrategy);
    expect(difficulties.map(item => item.name)).toContain('垂直运输组织');
  });

  it('buildBlueprintData（房建策略）：钢筋工经验区间口径（无定额表）+ 气候 central 兜底 + 无警告', () => {
    const result = buildBlueprintData({
      boq: buildingBoq(),
      basicFacts: '项目名称：XX安置房项目 计划工期：360日历天 质量标准：合格',
      projectName: 'XX安置房项目',
      strategy: buildingStrategy,
    });
    const rebar = result.data.resources.labor.byTrade.find(item => item.trade === '钢筋工');
    // 生产策略组不内置定额数据：钢筋工 basis 为经验区间表达，不得出现定额编号/命中形态
    expect(rebar?.basis).toContain('经验工效区间');
    expect(rebar?.basis).not.toContain('定额工效（');
    expect(rebar?.basis).not.toContain('FJ-');
    expect(result.data.climate).toEqual({ rainySeason: '6-8月', highTemp: '7-8月', winter: '12-2月' });
    expect(result.data.keyDifficulties.map(item => item.name)).toContain('垂直运输组织');
    expect(result.diagnostics.warnings).toHaveLength(0);
  });

  it('buildBlueprintData（general 无地点）：气候置空 + 诊断警告（宁缺毋错）', () => {
    const result = buildBlueprintData({
      boq: boqOf([entry(1, '土方开挖', '1．土壤类别：三类土', 'm3', 100)]),
      basicFacts: '项目名称：XX工程 计划工期：90日历天',
      projectName: 'XX工程',
      strategy: generalStrategy,
    });
    expect(result.data.climate).toEqual({ rainySeason: '', highTemp: '', winter: '' });
    expect(result.diagnostics.warnings.some(item => item.includes('气候区域未识别'))).toBe(true);
  });
});

/** 跨类型同等水平锁：任何工程类型资料 → 完整推导链路各资源桶非空、量级合理、零 throw。
 * 用户要求：不得只对村域（丰乐镇）类型好使，换其他类型项目资料必须同水平可用。 */
describe('跨类型端到端同等水平（六类型全链路完整性）', () => {
  // facts = 判别专用基本事实（各类型真实判别词形态）；全链路断言另用含建设地点的统一文本
  const CASES: Array<{ id: string; strategy: BlueprintDerivationStrategy; boq: BillOfQuantitiesResult; name: string; facts: string }> = [
    { id: 'village-municipal', strategy: villageMunicipalStrategy, boq: villageBoq(), name: 'XX美丽乡村项目', facts: '项目名称：XX美丽乡村项目 建设内容：污水管网、道路硬化、绿化、路灯' },
    { id: 'building', strategy: buildingStrategy, boq: buildingBoq(), name: 'XX安置房项目', facts: '项目名称：XX安置房项目 建设内容：主体结构、砌体、基坑支护' },
    { id: 'bridge-tunnel', strategy: bridgeTunnelStrategy, boq: bridgeBoq(), name: 'XX大桥工程', facts: '项目名称：XX大桥工程 建设内容：桥梁下部结构、上部结构、箱梁' },
    { id: 'highway', strategy: highwayStrategy, boq: highwayBoq(), name: 'XX公路工程', facts: '项目名称：XX公路工程 建设内容：路基工程、路面工程、沥青面层' },
    { id: 'water-conservancy', strategy: waterConservancyStrategy, boq: waterBoq(), name: 'XX水闸泵站工程', facts: '项目名称：XX水闸泵站工程 建设内容：泵站、水闸、节制闸' },
    {
      // 零判别词条目（土方/砖砌/管道/混凝土均为跨类型通用词，不触发任何类型判别信号）→ 走 general 兑底
      id: 'general',
      strategy: generalStrategy,
      boq: boqOf([
        entry(1, '土方开挖', '1．土壤类别：三类土', 'm3', 100),
        entry(2, '余方弃置', '1．运距：5km', 'm3', 60),
        entry(3, '砖砌挡墙', '1．砂浆：M7.5', 'm3', 200),
        entry(4, '管道铺设', '1．规格：DN300', 'm', 300),
        entry(5, '现浇混凝土', '1．C25商品混凝土 2．含振捣', 'm3', 50),
      ]),
      name: 'XX综合改造工程',
      facts: '项目名称：XX综合改造工程 建设内容：零星维修、场地平整、拆除清运',
    },
  ];

  for (const { id, strategy, boq, name, facts } of CASES) {
    it(`${id}：buildBlueprintData 全链路资源桶完整（里程碑/劳动力/机械/部署/重难点）`, () => {
      const result = buildBlueprintData({
        boq,
        basicFacts: `项目名称：${name} 建设地点：安徽省合肥市 计划工期：360日历天 质量标准：合格`,
        projectName: name,
        strategy,
      });
      const data = result.data;
      // 里程碑：策略组全部分组覆盖，工期非零且不超总工期
      expect(data.milestones.length).toBe(strategy.milestoneGroups.length);
      for (const item of data.milestones) {
        expect(item.duration).toBeGreaterThanOrEqual(2);
        expect(item.basis).toBeTruthy();
      }
      expect(data.milestones.reduce((acc, item) => acc + (item.duration || 0), 0)).toBeLessThanOrEqual(360);
      // 劳动力：工种构成完整，峰值非零，每个工种推导依据非空
      expect(data.resources.labor.byTrade.length).toBeGreaterThanOrEqual(4);
      expect(data.resources.labor.peakValue).toBeGreaterThan(0);
      for (const item of data.resources.labor.byTrade) {
        expect(item.basis).toBeTruthy();
        expect(item.max).toBeGreaterThan(0);
      }
      // 机械：机械映射命中产出，依据非空
      expect(data.resources.equipment.length).toBeGreaterThanOrEqual(2);
      for (const item of data.resources.equipment) expect(item.basis).toBeTruthy();
      // 施工部署：分部顺序与流水话术非空
      expect(data.constructionDeployment.sequence).toBeTruthy();
      expect(data.constructionDeployment.flow).toBeTruthy();
      // 重难点：每类型至少 1 条（零命中时兜底），每条含措施
      expect(data.keyDifficulties.length).toBeGreaterThanOrEqual(1);
      for (const item of data.keyDifficulties) expect(item.measure).toBeTruthy();
      // 项目名与气候（地点命中华东）正常注入
      expect(data.project.name).toBe(name);
      expect(data.climate.rainySeason).toBe('6-8月');
    });

    it(`${id}：resolveDerivationStrategy 判别稳定命中本策略组（文本信号独立于村分组）`, () => {
      const resolved = resolveDerivationStrategy({
        basicFacts: facts,
        chapterTitles: CHAPTER_TITLES,
        boq,
      });
      expect(resolved.id).toBe(id);
    });
  }
});

describe('村域行为锁定（丰乐镇口径零变化回归）', () => {
  it('deriveKeyDifficulties 动态名：20 个自然村 → 首条「20 个自然村分散施工组织协调」', () => {
    const boq = boqOf(
      [entry(1, '挖沟槽土方', '1．开挖深度：2m', 'm3', 100)],
      Array.from({ length: 20 }, (_, index) => villageOf(`第${index + 1}村`, 1)),
    );
    const difficulties = deriveKeyDifficulties(boq);
    expect(difficulties[0]?.name).toBe('20 个自然村分散施工组织协调');
  });

  it('buildBlueprintData 缺省策略（村域）：气候保持历史硬编码 east 值', () => {
    const result = buildBlueprintData({
      boq: villageBoq(),
      basicFacts: '项目名称：测试村建设项目 计划工期：90日历天 质量标准：合格',
      projectName: '测试村建设项目',
    });
    expect(result.data.climate).toEqual({ rainySeason: '6-8月', highTemp: '7-8月', winter: '12-2月' });
    // 村域组未配置定额表：工种 basis 保持经验区间表达（三期不改变村域行为）
    const labor = result.data.resources.labor;
    for (const item of labor.byTrade) expect(item.basis).toContain('经验工效区间');
  });
});
