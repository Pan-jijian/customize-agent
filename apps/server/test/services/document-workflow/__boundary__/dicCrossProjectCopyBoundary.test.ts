/**
 * dicCrossProjectCopy：V5 P4b 跨工程同值复制 / 阶段人数混用检测边界矩阵（K/L 组）。
 * 覆盖：crossProjectValueCopyIssues（K1-K9）——判定 B（单组语境值恰为其他工程明细值）、
 * 判定 A（同值出现在 ≥2 工程对象语境且明细值不同）、表格行/无组/多组语境/明细值全同豁免；
 * phaseLaborMixingIssues（L1-L7）——阶段名命中值不符、值相符、阶段名不匹配、表格行、
 * 部分命中（施工准备↔施工准备与清杂拆除）、负向声明豁免、多命中取最长；
 * 权威查询 helper（H1-H3）——blueprintQuantityGroupAuthorities / blueprintPhaseLaborAuthorities
 * 与蓝图数据的同源投影契约。全部用例为确定性判定，无语义/网络依赖。
 */
import { describe, expect, it } from 'vitest';
import { crossProjectValueCopyIssues, phaseLaborMixingIssues } from '@/services/document-workflow/documentIntegrityChecks';
import { blueprintPhaseLaborAuthorities, blueprintQuantityGroupAuthorities } from '@/services/document-workflow/authorityIndex';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';

const quantityAuthorities = [{
  name: '挖沟槽土方',
  value: 1052.8,
  unit: 'm³',
  groups: [
    { group: '白鸥观澜公厕', value: 838.81 },
    { group: '青青家园', value: 213.99 },
  ],
}];

describe('dicCrossProjectCopy · K 组：跨工程同值复制检测', () => {
  it('K1 单组语境值恰为其他工程明细值（判定 B）→ blocker', () => {
    const issues = crossProjectValueCopyIssues('白鸥观澜公厕挖沟槽土方213.99m³施工完成。', quantityAuthorities);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('跨工程同值复制');
    expect(issues[0].message).toContain('白鸥观澜公厕');
    expect(issues[0].message).toContain('青青家园');
    expect(issues[0].message).toContain('213.99');
    expect(issues[0].suggestion).toContain('838.81');
    expect(issues[0].severity).toBe('blocker');
  });

  it('K2 分工程各项取正确明细值 → 0 条', () => {
    const issues = crossProjectValueCopyIssues('白鸥观澜公厕挖沟槽土方838.81m³、青青家园挖沟槽土方213.99m³。', quantityAuthorities);
    expect(issues).toHaveLength(0);
  });

  it('K3 两组同写错值（判定 A：同值跨组出现且明细值不同）→ blocker', () => {
    const issues = crossProjectValueCopyIssues('白鸥观澜公厕挖沟槽土方999m³。青青家园挖沟槽土方999m³。', quantityAuthorities);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('同时出现在');
    expect(issues[0].message).toContain('999');
  });

  it('K4 同一数值出现在两组语境（判定 B 优先报单点复制）→ blocker', () => {
    const issues = crossProjectValueCopyIssues('白鸥观澜公厕挖沟槽土方213.99m³。青青家园挖沟槽土方213.99m³。', quantityAuthorities);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('跨工程同值复制');
  });

  it('K5 表格行（分村分表合法承载）→ 0 条', () => {
    const issues = crossProjectValueCopyIssues('| 白鸥观澜公厕 | 挖沟槽土方 | 213.99 | m³ |', quantityAuthorities);
    expect(issues).toHaveLength(0);
  });

  it('K6 无组语境总述句 → 0 条', () => {
    const issues = crossProjectValueCopyIssues('本工程挖沟槽土方1052.8m³，其中分村实施。', quantityAuthorities);
    expect(issues).toHaveLength(0);
  });

  it('K7 多组语境列举句（语境不唯一）→ 0 条', () => {
    const issues = crossProjectValueCopyIssues('白鸥观澜公厕、青青家园挖沟槽土方1052.8m³。', quantityAuthorities);
    expect(issues).toHaveLength(0);
  });

  it('K8 单组语境值非任何明细值（普通漂移走修复器通道）→ 0 条', () => {
    const issues = crossProjectValueCopyIssues('白鸥观澜公厕挖沟槽土方999m³。', quantityAuthorities);
    expect(issues).toHaveLength(0);
  });

  it('K9 明细值全同条目复制同值不构成跨工程错误 → 0 条', () => {
    const sameValue = [{ name: '栽植色带', value: 200, unit: 'm²', groups: [{ group: '甲村', value: 100 }, { group: '乙村', value: 100 }] }];
    const issues = crossProjectValueCopyIssues('甲村栽植色带100m²、乙村栽植色带100m²。', sameValue);
    expect(issues).toHaveLength(0);
  });

  it('K10 单位变体（m² 与 ㎡）照常解析 → blocker', () => {
    const area = [{ name: '栽植色带', value: 300, unit: 'm²', groups: [{ group: '甲村', value: 200 }, { group: '乙村', value: 100 }] }];
    const issues = crossProjectValueCopyIssues('甲村栽植色带100㎡种植完成。', area);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('乙村');
  });
});

const phaseAuthorities = [
  { phase: '污水管网工程', value: 35, trace: '按造价折算' },
  { phase: '道路铺装工程', value: 68 },
];

describe('dicCrossProjectCopy · L 组：阶段人数混用检测', () => {
  it('L1 阶段名命中但数值不符 → blocker', () => {
    const issues = phaseLaborMixingIssues('污水管网工程阶段投入劳动力约50人。', phaseAuthorities);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('阶段劳动力数据矛盾');
    expect(issues[0].message).toContain('污水管网工程');
    expect(issues[0].suggestion).toContain('35');
    expect(issues[0].severity).toBe('blocker');
  });

  it('L2 阶段名命中且数值相符 → 0 条', () => {
    const issues = phaseLaborMixingIssues('污水管网工程阶段投入劳动力约35人。', phaseAuthorities);
    expect(issues).toHaveLength(0);
  });

  it('L3 阶段名不属于本项目阶段集合（无权威可比）→ 0 条', () => {
    const issues = phaseLaborMixingIssues('基坑开挖阶段投入劳动力约50人。', phaseAuthorities);
    expect(issues).toHaveLength(0);
  });

  it('L4 表格行（分阶段明细表合法承载）→ 0 条', () => {
    const issues = phaseLaborMixingIssues('| 污水管网工程 | 阶段投入劳动力约50人 |', phaseAuthorities);
    expect(issues).toHaveLength(0);
  });

  it('L5 部分命中（施工准备 ↔ 施工准备与清杂拆除，公共子串 ≥4 字）→ blocker', () => {
    const issues = phaseLaborMixingIssues('施工准备阶段投入劳动力约30人。', [{ phase: '施工准备与清杂拆除', value: 22, trace: '按工期分摊' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].suggestion).toContain('22');
    expect(issues[0].suggestion).toContain('按工期分摊');
  });

  it('L6 负向声明句（引用旧值的修复声明）→ 0 条', () => {
    const issues = phaseLaborMixingIssues('本章不再出现“污水管网工程阶段投入劳动力约50人”的表述。', phaseAuthorities);
    expect(issues).toHaveLength(0);
  });

  it('L7 多命中取最长公共子串（道路铺装工程精确命中而非道路工程）→ blocker', () => {
    const issues = phaseLaborMixingIssues('道路铺装工程阶段投入劳动力约70人。', [{ phase: '道路工程', value: 40 }, { phase: '道路铺装工程', value: 68 }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('道路铺装工程');
    expect(issues[0].suggestion).toContain('68');
  });
});

/** 精简蓝图 fixture：只填 P4b 相关字段（quantities.groups / labor.byPhase）+ 全量投影
 * 遍历所需的空域字段（specAuthorities/earthworkBalance/testPlan/redLineFacts），
 * 其余字段以类型断言省略——helper 投影仅消费目标域。 */
function makeBlueprint(): BlueprintData {
  return {
    contract: { totalDays: 90, qualityStandard: '合格', pricingFile: '', estimatedAmount: 1200 },
    milestones: [],
    resources: {
      labor: {
        peak: { min: 140, max: 160 },
        peakValue: 150,
        peakBasis: '造价锚定',
        byPhase: [
          { phase: '污水管网工程', min: 30, max: 40, basis: '按造价折算' },
          { phase: '道路铺装工程', min: 60, max: 76, basis: '推导' },
        ],
        byTrade: [],
        composition: [],
      },
      equipment: [],
    },
    materialsPlan: [],
    quantities: {
      挖沟槽土方: {
        value: 1052.8, unit: 'm³', sourceFile: '清单.pdf', seq: 1,
        groups: [
          { group: '白鸥观澜公厕', value: 838.81 },
          { group: '青青家园', value: 213.99 },
        ],
      },
      塑料检查井: { value: 555, unit: '座', sourceFile: '清单.pdf', seq: 2 },
    },
    specAuthorities: {},
    earthworkBalance: { excavation: 0, backfill: 0, disposal: 0, basis: '' },
    testPlan: [],
    redLineFacts: [],
  } as unknown as BlueprintData;
}

describe('dicCrossProjectCopy · H 组：权威查询 helper 契约', () => {
  it('H1 blueprintQuantityGroupAuthorities 只取 ≥2 分组明细的条目并携带 groups', () => {
    const entries = blueprintQuantityGroupAuthorities(makeBlueprint());
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('挖沟槽土方');
    expect(entries[0].value).toBe(1052.8);
    expect(entries[0].groups).toHaveLength(2);
  });

  it('H2 blueprintPhaseLaborAuthorities 投影「阶段劳动力:X」为 phase/value（midValue 收敛）', () => {
    const phases = blueprintPhaseLaborAuthorities(makeBlueprint());
    expect(phases).toHaveLength(2);
    expect(phases[0]).toEqual({ phase: '污水管网工程', value: 35, trace: '按造价折算' });
    expect(phases[1].value).toBe(68);
  });

  it('H3 数据缺失时两 helper 返回空数组（静默跳过契约）', () => {
    expect(blueprintQuantityGroupAuthorities(undefined)).toEqual([]);
    expect(blueprintPhaseLaborAuthorities(undefined)).toEqual([]);
  });

  it('H4 helper→检测器端到端：蓝图分组明细直接支撑同值复制判定', () => {
    const issues = crossProjectValueCopyIssues('白鸥观澜公厕挖沟槽土方213.99m³。', blueprintQuantityGroupAuthorities(makeBlueprint()));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('青家园');
  });
});
