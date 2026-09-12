/**
 * V5 P1 契约测试：AuthorityIndex 全量权威投影 + 覆盖契约。
 *
 * 契约核心：collectNumericLeaves（蓝图 data 全部数值叶子）必须被权威条目 paths 全覆盖——
 * 蓝图新增数值字段未登记 transform 时 authorityCoverageGaps 立即非空，本测试断言其恒为空。
 * "漏对象"从人肉审计变为机制保证（负向用例：注入未知字段 → 契约立即暴露缺口）。
 */
import { describe, expect, it } from 'vitest';
import {
  authorityCoverageGaps,
  buildAuthorityIndex,
  collectNumericLeaves,
  quantityValueIsLegal,
  renderAuthorityDomains,
} from '@/services/document-workflow/authorityIndex';
import type { AuthorityIndex } from '@/services/document-workflow/authorityIndex';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';

/** 全字段填充 fixture：覆盖 BlueprintData 全部数值叶子（契约测试基准） */
function makeBlueprintData(): BlueprintData {
  return {
    project: { name: '舒城县美丽宜居自然村建设项目', scope: '9 个自然村市政配套', works: ['道路工程', '排水工程'], location: '六安市舒城县' },
    contract: { totalDays: 240, qualityStandard: '合格', pricingFile: '安徽省 2018 版计价定额', estimatedAmount: 1200 },
    climate: { rainySeason: '6-7月梅雨', highTemp: '7-8月高温', winter: '冬季施工' },
    milestones: [
      { key: 'prep', label: '施工准备', duration: 20, basis: '推导' },
      { key: 'main', label: '主体施工', duration: 180, basis: '推导' },
    ],
    resources: {
      labor: {
        peak: { min: 160, max: 200 },
        peakValue: 180,
        peakBasis: '造价锚定',
        byPhase: [
          { phase: '施工准备阶段', min: 20, max: 30, basis: '推导' },
          { phase: '主体施工阶段', min: 120, max: 140, basis: '推导' },
        ],
        byTrade: [{ trade: '钢筋工', min: 10, max: 16, basis: '推导' }],
        composition: [{ trade: '普工', count: 60, basis: '推导' }],
      },
      equipment: [
        { name: '挖掘机', spec: '0.8m³', min: 2, max: 4, basis: '推导' },
        { name: '自卸汽车', quantity: 6, basis: '推导' },
      ],
    },
    materialsPlan: [
      { name: '一般路灯', quantity: 118, unit: '套', spec: '100W', basis: '清单汇总' },
      { name: '级配碎石', quantity: 3200, unit: 'm³', basis: '清单汇总' },
    ],
    fundPlan: { wageRule: '按月足额', usagePlan: '专款专用' },
    testPlan: [{ scope: '混凝土试块', count: 12, basis: '推导' }],
    earthworkBalance: { excavation: 10000, backfill: 8000, disposal: 2000, basis: '清单汇总' },
    tempUtilities: { powerLoad: '200kW', waterUsage: '50m³/天' },
    redLineFacts: [
      { key: '自然村数量', value: '9 个自然村', source: '招标文件' },
      { key: '绿化养护期', value: '2 年', source: '清单特征' },
      { key: '合同估算价', value: '1200 万元', source: '招标文件', amount: true },
    ],
    amountRule: '金额类数据禁入正文（合同估算价例外）',
    decisionLock: { entries: [{ id: 'method', label: '施工方法', values: ['机械开挖'] }] },
    quantities: {
      挖沟槽土方: {
        value: 20420.39, unit: 'm³', sourceFile: '清单.pdf', seq: 1,
        groups: [
          { group: '白鸥观澜公厕', value: 838.81 },
          { group: '青青家园', value: 213.99 },
        ],
      },
      塑料检查井: { value: 555, unit: '座', sourceFile: '清单.pdf', seq: 2 },
    },
    specAuthorities: { 垫层: 'C20' },
    inspectionBatches: [{ scope: '排水管道', planDesc: '按检查井分段' }],
    standardBlocks: [{ id: 'dust', title: '扬尘治理', source: '参考.docx', items: ['六个百分百'], gap: false }],
    constructionDeployment: { sections: [{ name: '第一施工段', basis: '推导' }], sequence: '先地下后地上', sequenceBasis: '推导', flow: '分区流水' },
    keyDifficulties: [{ name: '交通导改', measure: '分段围挡', basis: '推导' }],
    basisRegulations: ['《中华人民共和国安全生产法》'],
    drawingNote: '图纸与清单不一致时以清单为准',
  };
}

function entryOf(index: AuthorityIndex, label: string) {
  const entry = index.entries.find(item => item.label === label);
  if (!entry) throw new Error(`未找到权威条目：${label}`);
  return entry;
}

describe('buildAuthorityIndex 全量投影', () => {
  it('契约类事实条目：总工期/估算价（金额禁区）', () => {
    const index = buildAuthorityIndex(makeBlueprintData());
    const days = entryOf(index, '总工期');
    expect(days.kind).toBe('fact');
    expect(days.value).toBe(240);
    expect(days.paths).toContain('contract.totalDays');
    const amount = entryOf(index, '合同估算价');
    expect(amount.amountRestricted).toBe(true);
  });

  it('劳动力峰值条目归并区间三路径（端点不泄漏为独立条目）', () => {
    const index = buildAuthorityIndex(makeBlueprintData());
    const peak = entryOf(index, '劳动力峰值');
    expect(peak.value).toBe(180);
    expect(peak.kind).toBe('derived');
    expect(peak.paths).toEqual(['resources.labor.peak.min', 'resources.labor.peak.max', 'resources.labor.peakValue']);
    expect(index.entries.filter(item => item.label === '劳动力峰值')).toHaveLength(1);
  });

  it('阶段劳动力/工种构成逐项成 D 类条目（含推导依据）', () => {
    const index = buildAuthorityIndex(makeBlueprintData());
    expect(entryOf(index, '阶段劳动力:主体施工阶段').value).toBe(130);
    expect(entryOf(index, '阶段劳动力:主体施工阶段').trace).toBe('推导');
    expect(entryOf(index, '工种构成:普工').value).toBe(60);
  });

  it('机械条目全量收录：区间中值单值化 + 通用别名（挖掘机→挖机）', () => {
    const index = buildAuthorityIndex(makeBlueprintData());
    const excavator = entryOf(index, '挖掘机');
    expect(excavator.value).toBe(3);
    expect(excavator.anchors).toContain('挖机');
    expect(entryOf(index, '自卸汽车').value).toBe(6);
  });

  it('工程量条目携带分村明细（合计 + groups 并存）', () => {
    const index = buildAuthorityIndex(makeBlueprintData());
    const trench = entryOf(index, '挖沟槽土方');
    expect(trench.value).toBe(20420.39);
    expect(trench.groups).toEqual([
      { group: '白鸥观澜公厕', value: 838.81 },
      { group: '青青家园', value: 213.99 },
    ]);
    expect(trench.paths).toContain('quantities.挖沟槽土方.groups[0].value');
  });

  it('机动工期条目 = 总工期 − 里程碑合计', () => {
    const index = buildAuthorityIndex(makeBlueprintData());
    expect(entryOf(index, '机动工期').value).toBe(40);
  });

  it('byDomain 分组覆盖全部条目', () => {
    const index = buildAuthorityIndex(makeBlueprintData());
    const grouped = [...index.byDomain.values()].flat();
    expect(grouped).toHaveLength(index.entries.length);
    expect(index.byDomain.get('equipment')?.length).toBe(2);
    expect(index.byDomain.get('quantity')?.length).toBe(2);
  });
});

describe('覆盖契约（collectNumericLeaves ↔ 条目 paths 双向断言）', () => {
  it('全字段 fixture 契约满足（缺口为空）', () => {
    expect(authorityCoverageGaps(makeBlueprintData())).toEqual([]);
  });

  it('机制防漏：蓝图新增未登记数值字段 → 契约立即暴露缺口', () => {
    const data = makeBlueprintData();
    (data as unknown as Record<string, unknown>).brandNewBlock = { count: 7 };
    expect(authorityCoverageGaps(data)).toEqual(['brandNewBlock.count']);
  });

  it('collectNumericLeaves 路径格式（数组下标/记录键）', () => {
    const paths = collectNumericLeaves(makeBlueprintData()).map(leaf => leaf.path);
    expect(paths).toContain('milestones[0].duration');
    expect(paths).toContain('quantities.挖沟槽土方.value');
    // 来源序号属元数据（豁免表），不在契约检查量内但被 walker 收集
    expect(paths).toContain('quantities.塑料检查井.seq');
  });

  it('豁免表仅覆盖来源序号类元数据（不掩盖真实缺口）', () => {
    const data = makeBlueprintData();
    const gaps = authorityCoverageGaps(data);
    expect(gaps.filter(path => /\.seq$/u.test(path))).toEqual([]);
  });
});

describe('quantityValueIsLegal（分村多值合法性判定）', () => {
  it('合计值与分组值均合法；范围外值不合法', () => {
    const index = buildAuthorityIndex(makeBlueprintData());
    const trench = entryOf(index, '挖沟槽土方');
    expect(quantityValueIsLegal(trench, 20420.39)).toBe(true);
    expect(quantityValueIsLegal(trench, 838.81)).toBe(true);
    expect(quantityValueIsLegal(trench, 213.99)).toBe(true);
    expect(quantityValueIsLegal(trench, 999.99)).toBe(false);
  });

  it('无分组明细的条目只认合计值', () => {
    const index = buildAuthorityIndex(makeBlueprintData());
    const well = entryOf(index, '塑料检查井');
    expect(quantityValueIsLegal(well, 555)).toBe(true);
    expect(quantityValueIsLegal(well, 100)).toBe(false);
  });
});

describe('V5 P2 渲染覆盖率（全量渲染、零截断、顺序稳定）', () => {
  it('10 域全部有渲染路径：每域代表性行输出（机制：新增 domain 未登记渲染器即编译失败）', () => {
    const index = buildAuthorityIndex(makeBlueprintData());
    expect(index.byDomain.size).toBe(10);
    const rows = renderAuthorityDomains(index);
    const text = rows.join('\n');
    expect(text).toContain('- 总工期：240 日历天');
    expect(text).toContain('- 里程碑（各节点用时，总和 ≤ 总工期）：施工准备 20 天、主体施工 180 天');
    expect(text).toContain('- 机动工期：40 天');
    expect(text).toContain('- 劳动力峰值：180 人');
    expect(text).toContain('- 分阶段劳动力投入（各阶段同时在场人数，分阶段计划表数据源）：施工准备阶段 25 人、主体施工阶段 130 人');
    expect(text).toContain('- 工种区间（区间中值参考，不得作为工种表口径，不得自设）：钢筋工 13 人');
    expect(text).toContain('- 工种构成（合计=180 人，写作层工种表唯一数据源，不得自设构成）：普工 60 人');
    expect(text).toContain('- 主要机械（台数唯一口径，不得自设）：挖掘机（0.8m³） 3 台、自卸汽车 6 台');
    expect(text).toContain('- 物资计划·主要材料（清单汇总，名称、型号规格、数量必须与此一致；清单明确给出的规格是事实数据，未列材料不得自编型号规格）：一般路灯（100W） 118套、级配碎石 3200m³');
    expect(text).toContain('- 工程量清单（合计口径；分村/分工程明细为合法多值）：挖沟槽土方 20420.39m³（分工程：白鸥观澜公厕 838.81、青青家园 213.99）、塑料检查井 555座');
    expect(text).toContain('- 规格权威（清单特征原文，必须原样引用，不得自编）：垫层=C20');
    expect(text).toContain('- 土方平衡（清单汇总口径）：挖方 10000m³、填方 8000m³、弃方 2000m³');
    expect(text).toContain('- 试验计划（推导口径，不得自设）：混凝土试块 12次');
    expect(text).toContain('- 评审红线事实（must_cite，正文必须逐条出现且数值一致）：自然村数量=9 个自然村；绿化养护期=2 年');
    expect(text).toContain('- 金额类红线事实（商务禁区，不进正文）：合同估算价=1200 万元');
  });

  it('渲染次序稳定：contract → schedule → labor → equipment → material → quantity → spec → earthwork → test → redline', () => {
    const rows = renderAuthorityDomains(buildAuthorityIndex(makeBlueprintData()));
    const prefixes = ['- 总工期', '- 里程碑（', '- 劳动力峰值', '- 主要机械', '- 物资计划', '- 工程量清单', '- 规格权威', '- 土方平衡', '- 试验计划', '- 评审红线事实'];
    const positions = prefixes.map(prefix => rows.findIndex(row => row.startsWith(prefix)));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('domain 过滤视图（章域卡机制）：仅渲染命中域，其他域行零泄漏', () => {
    const index = buildAuthorityIndex(makeBlueprintData());
    const text = renderAuthorityDomains(index, ['contract', 'labor']).join('\n');
    expect(text).toContain('- 总工期：240 日历天');
    expect(text).toContain('- 劳动力峰值：180 人');
    expect(text).not.toContain('- 主要机械');
    expect(text).not.toContain('- 物资计划');
    expect(text).not.toContain('- 评审红线事实');
  });

  it('去截断：材料 45 条、阶段 12 个全量渲染（无 slice 截断与「等」尾巴）', () => {
    const data = makeBlueprintData();
    data.materialsPlan = Array.from({ length: 45 }, (_, position) => ({
      name: `材料${String(position + 1).padStart(2, '0')}`,
      quantity: 100 - position,
      unit: 't',
      basis: '清单汇总',
    }));
    data.resources.labor.byPhase = Array.from({ length: 12 }, (_, position) => ({
      phase: `阶段${position + 1}`,
      min: position + 1,
      max: position + 3,
      basis: '推导',
    }));
    const rows = renderAuthorityDomains(buildAuthorityIndex(data));
    const materialRow = rows.find(row => row.startsWith('- 物资计划'))!;
    expect(materialRow).toContain('材料45');
    expect(materialRow).not.toContain(' 等');
    const phaseRow = rows.find(row => row.startsWith('- 分阶段劳动力投入'))!;
    expect(phaseRow.match(/阶段\d+/gu)?.length).toBe(12);
  });

  it('降级容忍：空索引/缺省字段不抛错（蓝图 JSON 恢复场景）', () => {
    const empty = renderAuthorityDomains({ entries: [], byDomain: new Map() });
    expect(empty).toEqual([]);
    const minimal = { contract: { totalDays: 0 }, resources: { labor: { peakValue: 0 } } } as unknown as ReturnType<typeof makeBlueprintData>;
    expect(renderAuthorityDomains(buildAuthorityIndex(minimal))).toEqual([]);
  });
});
