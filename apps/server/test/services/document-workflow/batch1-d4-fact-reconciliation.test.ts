/**
 * 批 1 D4 数值对账六类测试（事实溯源 8 处缺陷模式合成注入全拦）：
 * - D4.1 合计推导：管道总长 16344.54 = 权威 16037.54 + 基础 307（重复计入）→ blocker；
 * - D4.2 规格-数值绑定：DN200 7965m（7965m 属 DN300）→ blocker；
 * - D4.3 数值语义槽位：埋深 23.45m（实为 23.45km 总长口径误用）→ blocker；
 * - D4.4 近似数值口径：约 309 点（数字池无同值/近似来源）→ blocker；
 * - D4.5 分项显式：合计 557 座未展示分项 → warning；
 * - D4.6 名称口径：木质门 12 樘 vs 清单金属门 12 樘 → blocker；顶棚 118.57m²（权威 18.57m²）无源 → blocker；
 * - 规格错位（垫层 C30 vs 权威 C20）由既有 spec-location-mismatch 检测器承担（分工防重复）；
 * 负例：合法分项展示 / 正确绑定 / 合理埋深 / 可推导近似 / 正确名称 均不得误报；
 * 权威缺失（无清单/无蓝图/无事实主表）时全部规则静默跳过（不误伤无数据项目）。
 */
import { describe, expect, it } from 'vitest';
import { factReconciliationIssues, fixSpecQuantityBindings, fixUnsourcedNameBindings } from '@/services/document-workflow/factReconciliation';
import { collectBlueprintCitationCandidates } from '@/services/document-workflow/integratedBlueprint/citation';
import { specLocationMismatchIssues } from '@/services/document-workflow/integrity/detectors/detectors';
import type { BillFactLock, BillFactLockEntry } from '@/services/document-workflow/billFactLock';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';
import type { SpecAuthorityMap } from '@/services/document-workflow/types';

/** 清单事实锁条目构造（测试最小字面量：非关注字段给默认值） */
function lockEntry(partial: Partial<BillFactLockEntry> & { name: string; quantity: number; unit: string }): BillFactLockEntry {
  return {
    seq: 1,
    description: '',
    section: '',
    subsection: '',
    villageGroup: '',
    sourceFile: 'test-boq.xlsx',
    specQuantityPairs: [],
    ...partial,
  };
}

function lockOf(entries: BillFactLockEntry[]): BillFactLock {
  return { entries, totalEntries: entries.length, sourceFile: 'test-boq.xlsx', complete: true };
}

/** 蓝图 quantities 最小构造（仅 quantities 参与 D4 对账） */
function blueprintOf(quantities: Record<string, { value: number; unit: string; specBreakdown?: Array<{ spec: string; value: number }> }>): BlueprintData {
  return { quantities } as unknown as BlueprintData;
}

describe('D4.1 合计推导对账（重复计入拦截）', () => {
  const blueprint = blueprintOf({
    污水管道: { value: 16037.54, unit: 'm' },
    管道基础: { value: 307, unit: 'm' },
  });

  it('污水管道总长 16344.54m = 16037.54 + 307（误并入管道基础）→ blocker', () => {
    const issues = factReconciliationIssues({ markdown: '本工程新建污水管道总长 16344.54m。', blueprintData: blueprint });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('16344.54');
    expect(issues[0].message).toContain('16037.54');
    expect(issues[0].message).toContain('管道基础');
  });

  it('合计与权威一致（总长 16037.54m）→ 不报', () => {
    const issues = factReconciliationIssues({ markdown: '本工程新建污水管道总长 16037.54m。', blueprintData: blueprint });
    expect(issues).toEqual([]);
  });
});

describe('D4.2 规格-数值绑定对账（张冠李戴拦截）', () => {
  const lock = lockOf([
    lockEntry({ name: 'HDPE双壁波纹管', quantity: 7965, unit: 'm', specQuantityPairs: [{ spec: 'DN300', quantity: '7965m' }] }),
    lockEntry({ name: 'PE排水管', quantity: 211, unit: 'm', specQuantityPairs: [{ spec: 'DN200', quantity: '211m' }] }),
  ]);

  it('DN200 7965m（7965m 属 DN300 清单数量）→ blocker', () => {
    const issues = factReconciliationIssues({ markdown: '污水管道 DN200 管段共 7965m，采用双壁波纹管。', billFactLock: lock });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('7965');
    expect(issues[0].message).toContain('DN300');
  });

  it('规格-数值正确绑定（DN200 211m / DN300 7965m）→ 不报', () => {
    const issues = factReconciliationIssues({ markdown: 'DN200 污水管 211m，DN300 波纹管 7965m。', billFactLock: lock });
    expect(issues).toEqual([]);
  });

  // 4.31 丰乐镇 v6 #2：DN25 管「不大于 1.0m」为支架间距工艺约束上限，非该规格清单数量
  it('DN25 管不大于 1.0m（工艺约束句）→ 不报（4.31 约束豁免）', () => {
    const constraintLock = lockOf([
      lockEntry({ name: '塑料管', quantity: 9.87, unit: 'm', specQuantityPairs: [{ spec: 'DN25', quantity: '9.87m' }] }),
      lockEntry({ name: '提升泵', quantity: 4, unit: '台', specQuantityPairs: [{ spec: '5.5m', quantity: '4台' }] }),
    ]);
    const issues = factReconciliationIssues({ markdown: 'DN25 管不大于 1.0m。', billFactLock: constraintLock });
    expect(issues.filter(issue => issue.message.includes('DN25'))).toEqual([]);
  });

  it('DN25 11.23m（属 DN32 清单数量）→ 张冠李戴仍报（豁免未过宽）', () => {
    const crossLock = lockOf([
      lockEntry({ name: '塑料管', quantity: 9.87, unit: 'm', specQuantityPairs: [{ spec: 'DN25', quantity: '9.87m' }] }),
      lockEntry({ name: '塑料管', quantity: 11.23, unit: 'm', specQuantityPairs: [{ spec: 'DN32', quantity: '11.23m' }] }),
    ]);
    const issues = factReconciliationIssues({ markdown: 'DN25 11.23m。', billFactLock: crossLock });
    expect(issues.some(issue => issue.message.includes('DN25'))).toBe(true);
  });

  // r14 丰乐镇 E6：「DN110 UPVC排水管总长15m」的 15m 是 DN110 自身局部长度量，间隙词含
  // 「总长」类长度量词且单位为长度类时数值语义上绑定该规格自身，与清单总量可不同值；
  // 15 恰与无关条目「人行道混凝土垫层 15m³」数值相等纯属巧合，不构成归属张冠李戴
  const lengthQuantifierLock = lockOf([
    lockEntry({ name: '塑料管', quantity: 7525.01, unit: 'm', specQuantityPairs: [{ spec: 'DN110', quantity: '7525.01m' }] }),
    lockEntry({ name: '人行道混凝土垫层', quantity: 15, unit: 'm3', specQuantityPairs: [{ spec: '10cm', quantity: '15m3' }] }),
  ]);

  it('DN110 UPVC排水管总长15m（长度量词句）→ 不报（r14 长度量词豁免）', () => {
    const issues = factReconciliationIssues({ markdown: 'DN110 UPVC排水管总长15m，管沟开挖深度按设计图纸确定。', billFactLock: lengthQuantifierLock });
    expect(issues.filter(issue => issue.message.includes('DN110'))).toEqual([]);
  });

  it('DN110 UPVC排水管15m（无长度量词）→ 张冠李戴仍报（豁免窄化正确）', () => {
    const issues = factReconciliationIssues({ markdown: 'DN110 UPVC排水管15m，管沟开挖深度按设计图纸确定。', billFactLock: lengthQuantifierLock });
    expect(issues.some(issue => issue.message.includes('DN110'))).toBe(true);
  });

  // r17 丰乐镇门禁 #B1：DN110 15m 无源（恰撞无关条目「人行道混凝土垫层 15m³」）——修复器原位
  // 替换为该规格组和值（同条目名分组之和；替换后必过检测组和豁免），复检零残留 + 幂等
  const r17Lock = lockOf([
    lockEntry({ name: '塑料管', quantity: 1000, unit: 'm', specQuantityPairs: [{ spec: 'DN110', quantity: '1000m' }] }),
    lockEntry({ name: '塑料管', quantity: 400, unit: 'm', specQuantityPairs: [{ spec: 'DN110', quantity: '400m' }] }),
    lockEntry({ name: '人行道混凝土垫层', quantity: 15, unit: 'm3', specQuantityPairs: [{ spec: '10cm', quantity: '15m3' }] }),
    lockEntry({ name: '混凝土管道铺设', quantity: 50, unit: 'm', specQuantityPairs: [{ spec: 'DN200', quantity: '50m' }] }),
  ]);

  it('D4.2 修复器：DN110 15m → 组和 1400m 替换，复检零残留 + 幂等', () => {
    const md = '管道安装涉及DN110 UPVC排水管15m、DN200混凝土管50m，管径规格分散且单段工程量小。';
    const fixed = fixSpecQuantityBindings(md, { billFactLock: r17Lock });
    expect(fixed.fixedCount).toBe(1);
    expect(fixed.markdown).toContain('DN110 UPVC排水管1400m');
    expect(fixed.markdown).toContain('DN200混凝土管50m');
    expect(factReconciliationIssues({ markdown: fixed.markdown, billFactLock: r17Lock }).filter(issue => issue.message.includes('DN110'))).toEqual([]);
    expect(fixSpecQuantityBindings(fixed.markdown, { billFactLock: r17Lock }).fixedCount).toBe(0);
  });

  it('D4.2 修复器：同形句两处逐处收敛（机械章/劳动力章重复形态）', () => {
    const md = '管道安装涉及DN110 UPVC排水管15m。\n\n管道工对应DN110 UPVC排水管15m施工。';
    const fixed = fixSpecQuantityBindings(md, { billFactLock: r17Lock });
    expect(fixed.fixedCount).toBe(2);
    expect(fixed.markdown).not.toContain('15m');
    expect(factReconciliationIssues({ markdown: fixed.markdown, billFactLock: r17Lock }).filter(issue => issue.message.includes('DN110'))).toEqual([]);
  });

  // r28g B3 归因（r28f 实测）：设备配置数误绑豁免——「C30商品混凝土由混凝土搅拌运输车2台按
  // 浇筑计划配送」的 2 台是搅拌车配置台数，非 C30 清单量；旧口径下间隙 ≤16 字的数值被无条件
  // 绑定给规格，恰撞 C25 条目「涵头」2台 → 误报张冠李戴。间隙点名设备主体且单位为「台」即豁免。
  const deviceCountLock = lockOf([
    lockEntry({ name: '水泥混凝土', quantity: 500, unit: 'm3', specQuantityPairs: [{ spec: 'C30', quantity: '500m3' }] }),
    lockEntry({ name: '涵头', quantity: 2, unit: '台', specQuantityPairs: [{ spec: 'C25', quantity: '2台' }] }),
  ]);

  it('C30商品混凝土由混凝土搅拌运输车2台配送（设备配置数）→ 不报（r28g 设备配置豁免）', () => {
    const issues = factReconciliationIssues({ markdown: 'C30商品混凝土由混凝土搅拌运输车2台按浇筑计划配送，浇筑前检查模板与钢筋。', billFactLock: deviceCountLock });
    expect(issues.filter(issue => issue.message.includes('C30'))).toEqual([]);
  });

  it('C30 混凝土 2台（间隙无设备主体词）→ 张冠李戴仍报（豁免未过宽）', () => {
    const issues = factReconciliationIssues({ markdown: 'C30 混凝土 2台。', billFactLock: deviceCountLock });
    expect(issues.some(issue => issue.message.includes('C30'))).toBe(true);
  });

  // C-T1 规格-数值绑定加固（r28f #19 类错位）：①修复器单位兼容——旧口径机械替换会把「C30 混凝土 2台」的
  // 2台 替换为 C30 的 m3 组和值 500（「500台」跨量纲错误且复检放行）；候选单位全不兼容时改为移除数量串
  // ②检测端后窗豁免：「2台搅拌运输车」数值后紧跟设备主体词同样属设备配置数（数值在设备词前）
  it('C-T1 修复器：C30 混凝土 2台 → 无同单位候选移除数量（不得跨量纲替换为 500台）', () => {
    const fixed = fixSpecQuantityBindings('C30 混凝土 2台。', { billFactLock: deviceCountLock });
    expect(fixed.fixedCount).toBe(1);
    expect(fixed.markdown).not.toContain('500台');
    expect(fixed.markdown).not.toContain('2台');
    expect(fixed.markdown).toContain('C30 混凝土。');
    expect(factReconciliationIssues({ markdown: fixed.markdown, billFactLock: deviceCountLock })).toEqual([]);
    expect(fixSpecQuantityBindings(fixed.markdown, { billFactLock: deviceCountLock }).fixedCount).toBe(0);
  });

  it('C-T1 后窗豁免：C30 混凝土 2台搅拌运输车（数值后设备主体词）→ 不报', () => {
    const issues = factReconciliationIssues({ markdown: 'C30 混凝土 2台搅拌运输车按浇筑计划供应，浇筑前检查模板与钢筋。', billFactLock: deviceCountLock });
    expect(issues.filter(issue => issue.message.includes('C30'))).toEqual([]);
  });

  it('C-T1 单位书写变体归一：正文「15米」按清单「m」候选替换（不因书写差异阻断）', () => {
    const fixed = fixSpecQuantityBindings('管道安装涉及DN110 UPVC排水管15米。', { billFactLock: r17Lock });
    expect(fixed.fixedCount).toBe(1);
    expect(fixed.markdown).toContain('DN110 UPVC排水管1400米');
  });

  // C8 S4-④ 枚举换项豁免与设备配置豁免扩「套」（s28m' 两处误报实锤）：「安装7kW充电桩、庭院灯5套」
  // 的 5套 属枚举后项「庭院灯」（其规格量恰为 5套，无豁免即误报张冠李戴）；「7kW 5套慢充桩」的
  // 5套 是慢充桩配置数。两豁免共用同一 lock：5套 命中 120W 条目值，确保「无豁免必误报」可被测出。
  const enumDeviceLock = lockOf([
    lockEntry({ name: '充电桩', quantity: 30, unit: '套', specQuantityPairs: [{ spec: '7kW', quantity: '30套' }] }),
    lockEntry({ name: '庭院灯', quantity: 5, unit: '套', specQuantityPairs: [{ spec: '120W', quantity: '5套' }] }),
  ]);
  const specBinding = (md: string) => factReconciliationIssues({ markdown: md, billFactLock: enumDeviceLock }).filter(issue => issue.message.includes('规格-数值绑定错位'));

  it('S4-④ 枚举换项豁免：7kW充电桩、庭院灯5套（5套属枚举后项）→ 不报张冠李戴', () => {
    expect(specBinding('配电区安装7kW充电桩、庭院灯5套，沿停车场周边布置。')).toEqual([]);
  });

  it('S4-④ 枚举换项反例：7kW充电桩、合计5套（末段合计连接语维持原绑定）→ 照报', () => {
    const issues = specBinding('本工程安装7kW充电桩、合计5套。');
    expect(issues.some(issue => issue.message.includes('庭院灯'))).toBe(true);
  });

  it('S4-④ 设备配置豁免扩「套」：7kW慢充桩5套（间隙含充桩）/ 7kW 5套慢充桩（数值后窗含充桩）→ 不报', () => {
    expect(specBinding('配电区安装7kW慢充桩5套，验收合格后投入使用。')).toEqual([]);
    expect(specBinding('配电区安装7kW 5套慢充桩已进场，验收后组织安装。')).toEqual([]);
  });

  it('S4-④ 反例：7kW充电桩5套（「充电桩」非连续「充桩」不入设备词表）→ 张冠李戴照报（防词表过宽）', () => {
    const issues = specBinding('配电区安装7kW充电桩5套，验收合格后投入使用。');
    expect(issues.some(issue => issue.message.includes('庭院灯'))).toBe(true);
  });
});

describe('D4.3 数值语义槽位对账（埋深误用总长口径拦截）', () => {
  const blueprint = blueprintOf({ 污水管道总长: { value: 23.45, unit: 'km' } });

  it('埋深不小于 23.45m（23.45 为总长口径）→ blocker', () => {
    const issues = factReconciliationIssues({ markdown: '新建管道埋深不小于 23.45m，采用开槽施工。', blueprintData: blueprint });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('23.45');
    expect(issues[0].message).toContain('总长');
  });

  it('合理埋深（2.5m / 管顶覆土 0.8m）→ 不报', () => {
    const issues = factReconciliationIssues({ markdown: '管道埋深 2.5m，管顶覆土 0.8m。', blueprintData: blueprint });
    expect(issues).toEqual([]);
  });
});

describe('D4.4 近似数值口径对账（约 309 点拦截）', () => {
  const blueprint = blueprintOf({
    塑料检查井: { value: 555, unit: '座' },
    砌筑检查井: { value: 2, unit: '座' },
  });

  it('检查口约 309 点（无同值/近似权威来源）→ blocker', () => {
    const issues = factReconciliationIssues({ markdown: '管网沿线设置检查口约 309 点。', blueprintData: blueprint });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('309');
  });

  it('约 555 座（可推导到权威 555 座）→ 不报', () => {
    const issues = factReconciliationIssues({ markdown: '塑料检查井约 555 座。', blueprintData: blueprint });
    expect(issues).toEqual([]);
  });
});

describe('D4.5 分项显式对账（合计 557 座无分项）', () => {
  const blueprint = blueprintOf({
    塑料检查井: { value: 555, unit: '座' },
    砌筑检查井: { value: 2, unit: '座' },
  });

  it('检查井合计 557 座未展示分项 → warning', () => {
    const issues = factReconciliationIssues({ markdown: '本工程新建检查井合计 557 座。', blueprintData: blueprint });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('557');
    expect(issues[0].message).toContain('555');
    expect(issues[0].message).toContain('砌筑检查井');
  });

  it('合法分项展示（555 座 + 2 座 = 合计 557 座）→ 不报（防误伤合法分解）', () => {
    const issues = factReconciliationIssues({ markdown: '本工程新建塑料检查井 555 座、砌筑检查井 2 座，合计 557 座。', blueprintData: blueprint });
    expect(issues).toEqual([]);
  });
});

describe('D4.6 名称口径对账（材质替换 / 名称-数值无源）', () => {
  const lock = lockOf([
    lockEntry({ name: '金属门', quantity: 12, unit: '樘' }),
    lockEntry({ name: '顶棚抹灰', quantity: 18.57, unit: 'm2' }),
  ]);

  it('木质门 12 樘（清单为金属门 12 樘）→ blocker', () => {
    const issues = factReconciliationIssues({ markdown: '各单体建筑木质门 12 樘。', billFactLock: lock });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('木质门');
    expect(issues[0].message).toContain('金属门');
  });

  it('顶棚抹灰 118.57m²（权威 18.57m²）且 118.57 全部权威无源 → blocker', () => {
    const issues = factReconciliationIssues({ markdown: '顶棚抹灰面积 118.57m²。', billFactLock: lock });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('118.57');
  });

  it('正确名称与正确数值（金属门 12 樘、顶棚抹灰 18.57m²）→ 不报', () => {
    const issues = factReconciliationIssues({ markdown: '金属门 12 樘；顶棚抹灰 18.57m²。', billFactLock: lock });
    expect(issues).toEqual([]);
  });
});

// 4.31 丰乐镇 v6 聚合口径豁免：子集和（#4-61）/ 组和补差（检查井 557）/ 同名组和闭合（开挖 12599.51）
describe('D4.6/D4.1 聚合口径豁免（4.31，跨名称组和与同名组和闭合）', () => {
  it('塑料检查井 557 座（= 同名组和 555 + 砌筑检查井 2）→ 不报（组和补差豁免）', () => {
    const wellsLock = lockOf([
      lockEntry({ name: '塑料检查井', quantity: 300, unit: '座' }),
      lockEntry({ name: '塑料检查井', quantity: 255, unit: '座' }),
      lockEntry({ name: '砌筑检查井', quantity: 2, unit: '座' }),
    ]);
    const issues = factReconciliationIssues({ markdown: '检查井逐座验收，共塑料检查井557座。', billFactLock: wellsLock });
    expect(issues.filter(issue => issue.message.includes('557'))).toEqual([]);
  });

  it('塑料检查井 558 座（≠ 组和 + 权威池任一值）→ 仍报（防豁免过宽）', () => {
    const wellsLock = lockOf([
      lockEntry({ name: '塑料检查井', quantity: 300, unit: '座' }),
      lockEntry({ name: '塑料检查井', quantity: 255, unit: '座' }),
      lockEntry({ name: '砌筑检查井', quantity: 2, unit: '座' }),
    ]);
    const issues = factReconciliationIssues({ markdown: '检查井逐座验收，共塑料检查井558座。', billFactLock: wellsLock });
    expect(issues.some(issue => issue.message.includes('558'))).toBe(true);
  });

  it('「管沟开挖总量为 12599.51m³」= 同名 2 条村组之和 → 不报（同名组和闭合）', () => {
    const earthLock = lockOf([
      lockEntry({ name: '挖沟槽土方', quantity: 8000, unit: 'm3' }),
      lockEntry({ name: '挖沟槽土方', quantity: 4599.51, unit: 'm3' }),
      lockEntry({ name: '回填方', quantity: 3000, unit: 'm3' }),
    ]);
    const issues = factReconciliationIssues({ markdown: '本工程排水管沟开挖总量为12599.51m³。', billFactLock: earthLock });
    expect(issues.filter(issue => issue.message.includes('12599.51'))).toEqual([]);
  });

  it('「管沟开挖总量为 12599.61m³」≠ 任何组和 → 仍报（防豁免过宽）', () => {
    const earthLock = lockOf([
      lockEntry({ name: '挖沟槽土方', quantity: 8000, unit: 'm3' }),
      lockEntry({ name: '挖沟槽土方', quantity: 4599.51, unit: 'm3' }),
      lockEntry({ name: '回填方', quantity: 3000, unit: 'm3' }),
    ]);
    const issues = factReconciliationIssues({ markdown: '本工程排水管沟开挖总量为12599.61m³，回填方总量3000m³。', billFactLock: earthLock });
    expect(issues.some(issue => issue.message.includes('12599.61'))).toBe(true);
  });
});

// 4.32 丰乐镇 v6 复测：同名池超 meet-in-middle 上限（40 条）→ 浅组合判定
// （回填方 4270 = 3570 + 700，原实现在池 >40 时整体返回 false，42 条同名条目逐条误报「绑定无源」）
describe('D4.6a 超上限同名池浅组合判定（4.32，回填方 4270 = 3570 + 700）', () => {
  const bigLock = lockOf([
    ...Array.from({ length: 40 }, (_, index) => lockEntry({ name: '回填方', quantity: Number((index + 1.11).toFixed(2)), unit: 'm3' })),
    lockEntry({ name: '回填方', quantity: 3570, unit: 'm3' }),
    lockEntry({ name: '回填方', quantity: 700, unit: 'm3' }),
  ]);

  it('42 条「回填方」池 4270 = 3570 + 700（两值之和）→ 不报', () => {
    const issues = factReconciliationIssues({ markdown: '本分项回填方 4270m³ 已分层夯实完成。', billFactLock: bigLock });
    expect(issues.filter(issue => issue.message.includes('4270'))).toEqual([]);
  });

  it('42 条池 4273（≠ 任何浅组合）→ 仍报（防豁免过宽）', () => {
    const issues = factReconciliationIssues({ markdown: '本分项回填方 4273m³ 已完成分层夯实。', billFactLock: bigLock });
    expect(issues.some(issue => issue.message.includes('4273'))).toBe(true);
  });
});

describe('D4.6 规格维度（垫层 C30 vs 权威 C20）由既有 spec-location-mismatch 承担', () => {
  const specAuthorityMap: SpecAuthorityMap = {
    混凝土强度等级: [
      { location: '垫层', spec: 'C20', quantity: '50m3', sourceFile: 'test-boq.xlsx' },
      { location: '路面', spec: 'C30', quantity: '120m3', sourceFile: 'test-boq.xlsx' },
    ],
  };

  it('垫层使用 C30（清单权威 C20）→ blocker', () => {
    const issues = specLocationMismatchIssues('管道基础垫层采用 C30 混凝土浇筑。', specAuthorityMap);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('垫层');
    expect(issues[0].message).toContain('C30');
    expect(issues[0].message).toContain('C20');
  });

  it('垫层 C20 合规 → 不报', () => {
    expect(specLocationMismatchIssues('管道基础垫层采用 C20 混凝土浇筑。', specAuthorityMap)).toEqual([]);
  });
});

describe('权威缺失静默跳过（不误伤无清单项目）', () => {
  it('无清单/无蓝图/无事实主表 → 不报任何 issue', () => {
    const md = '本工程新建检查井合计 557 座，管道埋深 23.45m，围挡约 309 点，木质门 12 樘。';
    expect(factReconciliationIssues({ markdown: md })).toEqual([]);
  });
});

// ── R20 规格拆分绑定（通用机制·任意工程任意专业）：名称合计（specBreakdown）挂单拦截 / 规格小计
// 豁免（反向保护）/ 值前置形态 / 表格行形态 / 合计显式分解合法 / 无拆分权威静默。
// 机制全部由清单特征描述规格 token 与蓝图聚合推导驱动，不含任何项目常量
// （路灯 100W/118 仅为本用例数据；同构造的泵类功率规格用例验证跨专业通用性） ──
describe('D4.2-R20 规格拆分绑定（合计挂单项拦截·通用机制）', () => {
  const lightsLock = lockOf([
    lockEntry({ name: '一般路灯', quantity: 50, unit: '套', description: '100W LED，高4.5m，含基础', specQuantityPairs: [{ spec: '100W', quantity: '50套' }] }),
    lockEntry({ name: '一般路灯', quantity: 40, unit: '套', description: '100W LED，高4.5m，含基础', specQuantityPairs: [{ spec: '100W', quantity: '40套' }] }),
    lockEntry({ name: '一般路灯', quantity: 19, unit: '套', description: '100W LED，高4.5m，含基础', specQuantityPairs: [{ spec: '100W', quantity: '19套' }] }),
    lockEntry({ name: '一般路灯', quantity: 9, unit: '套', description: '120W LED，高6m，含基础', specQuantityPairs: [{ spec: '120W', quantity: '9套' }] }),
  ]);
  const lightsBlueprint = blueprintOf({
    一般路灯: { value: 118, unit: '套', specBreakdown: [{ spec: '100W', value: 109 }, { spec: '120W', value: 9 }] },
  });
  const aggregateIssues = (md: string) => factReconciliationIssues({ markdown: md, billFactLock: lightsLock, blueprintData: lightsBlueprint }).filter(issue => issue.message.includes('跨规格名称合计'));

  it('「100W 共118套」（118=名称合计 109+9）→ blocker（名称合计不得挂单一规格）', () => {
    const issues = aggregateIssues('附属设施材料包括一般路灯100W共118套、120W共9套。');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('109');
    expect(issues[0].message).toContain('120W');
  });

  it('确定性修复：100W 共118套 → 109（复检零残留 + 幂等）', () => {
    const md = '附属设施材料包括一般路灯100W共118套、120W共9套。';
    const fixed = fixSpecQuantityBindings(md, { billFactLock: lightsLock, blueprintData: lightsBlueprint });
    expect(fixed.fixedCount).toBe(1);
    expect(fixed.markdown).toContain('100W共109套');
    expect(aggregateIssues(fixed.markdown)).toEqual([]);
    expect(fixSpecQuantityBindings(fixed.markdown, { billFactLock: lightsLock, blueprintData: lightsBlueprint }).fixedCount).toBe(0);
  });

  it('规格小计豁免（反向保护）：100W 109套 / 120W 9套 → 不报', () => {
    expect(aggregateIssues('附属设施材料包括一般路灯100W共109套、120W共9套。')).toEqual([]);
  });

  it('合计+显式分解 → 不报（合法口径）', () => {
    expect(aggregateIssues('一般路灯共118套（100W 109套、120W 9套，含基础）。')).toEqual([]);
  });

  it('值前置形态：一般路灯118套（100W LED…）→ blocker 且数值不被改写（交 LLM 改述）', () => {
    const md = '景观工程包括菜园围栏2360m、一般路灯118套（100W LED，高4.5m，含基础）。';
    const issues = factReconciliationIssues({ markdown: md, billFactLock: lightsLock, blueprintData: lightsBlueprint }).filter(issue => issue.message.includes('名称合计须显式分解'));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    const fixed = fixSpecQuantityBindings(md, { billFactLock: lightsLock, blueprintData: lightsBlueprint });
    expect(fixed.markdown).toContain('一般路灯118套（100W LED');
  });

  it('表格行形态：数量单元格 118 → 109 原位替换 + 幂等', () => {
    const md = '| 部位 | 名称 | 数量 | 单位 |\n| --- | --- | --- | --- |\n| 亮化工程 | 一般路灯（100W LED，高4.5m，含基础） | 118 | 套 |\n';
    const issues = factReconciliationIssues({ markdown: md, billFactLock: lightsLock, blueprintData: lightsBlueprint }).filter(issue => issue.message.includes('跨规格名称合计'));
    expect(issues).toHaveLength(1);
    const fixed = fixSpecQuantityBindings(md, { billFactLock: lightsLock, blueprintData: lightsBlueprint });
    expect(fixed.fixedCount).toBe(1);
    expect(fixed.markdown).toContain('| 109 |');
    expect(fixSpecQuantityBindings(fixed.markdown, { billFactLock: lightsLock, blueprintData: lightsBlueprint }).fixedCount).toBe(0);
  });

  it('通用性：设备功率规格（潜水排污泵 5.5kW/7.5kW）同机制拦截与修复', () => {
    const pumpLock = lockOf([
      lockEntry({ name: '潜水排污泵', quantity: 12, unit: '台', description: '5.5kW', specQuantityPairs: [{ spec: '5.5kW', quantity: '12台' }] }),
      lockEntry({ name: '潜水排污泵', quantity: 3, unit: '台', description: '7.5kW', specQuantityPairs: [{ spec: '7.5kW', quantity: '3台' }] }),
    ]);
    const pumpBlueprint = blueprintOf({
      潜水排污泵: { value: 15, unit: '台', specBreakdown: [{ spec: '5.5kW', value: 12 }, { spec: '7.5kW', value: 3 }] },
    });
    const md = '设备方案中潜水排污泵5.5kW共15台、7.5kW共3台。';
    const issues = factReconciliationIssues({ markdown: md, billFactLock: pumpLock, blueprintData: pumpBlueprint }).filter(issue => issue.message.includes('跨规格名称合计'));
    expect(issues).toHaveLength(1);
    const fixed = fixSpecQuantityBindings(md, { billFactLock: pumpLock, blueprintData: pumpBlueprint });
    expect(fixed.markdown).toContain('5.5kW共12台');
  });

  it('干净切分门（通用）：跨维度交叉聚合（小计和≠合计）自动退出，不误报', () => {
    // 通用机制：条目特征同时含强度×厚度双 token 时组值交叉重复计入 → 小计和≠名称合计，
    // 非「名称合计 = Σ规格小计」单维拆分口径，正文引用其组合值属正常，任何工程自动退出
    const concreteLock = lockOf([
      lockEntry({ name: '水泥混凝土', quantity: 60, unit: 'm2', description: 'C30混凝土，厚15cm', specQuantityPairs: [{ spec: 'C30', quantity: '60m2' }] }),
      lockEntry({ name: '水泥混凝土', quantity: 40, unit: 'm2', description: 'C25混凝土，厚20cm', specQuantityPairs: [{ spec: 'C25', quantity: '40m2' }] }),
    ]);
    const crossed = blueprintOf({
      水泥混凝土: { value: 100, unit: 'm2', specBreakdown: [{ spec: 'C30', value: 60 }, { spec: '15cm', value: 60 }, { spec: 'C25', value: 40 }, { spec: '20cm', value: 40 }] },
    });
    const md = '本工程C30混凝土用量100m2。';
    const issues = factReconciliationIssues({ markdown: md, billFactLock: concreteLock, blueprintData: crossed }).filter(issue => issue.message.includes('跨规格名称合计'));
    expect(issues).toEqual([]);
    expect(fixSpecQuantityBindings(md, { billFactLock: concreteLock, blueprintData: crossed }).fixedCount).toBe(0);
    // 对照（证明抑制来自门而非数据巧合）：同锁同文本、改单维切分（和=合计）→ 判定启用
    const clean = blueprintOf({
      水泥混凝土: { value: 100, unit: 'm2', specBreakdown: [{ spec: 'C30', value: 60 }, { spec: 'C25', value: 40 }] },
    });
    expect(factReconciliationIssues({ markdown: md, billFactLock: concreteLock, blueprintData: clean }).filter(issue => issue.message.includes('跨规格名称合计'))).toHaveLength(1);
  });

  it('无名称合计权威（无蓝图 specBreakdown）→ 静默（不误伤）', () => {
    const issues = factReconciliationIssues({ markdown: '附属设施材料包括一般路灯100W共118套。', billFactLock: lightsLock }).filter(issue => issue.message.includes('跨规格名称合计'));
    expect(issues).toEqual([]);
  });
});

describe('r25 citation 规格小计结构豁免（r24b B3 归因：与规格-数值绑定修复的往返拉扯）', () => {
  const citationBlueprint = citationBlueprintOf({
    LED灯具: { value: 118, unit: '套', specBreakdown: [{ spec: '100W', value: 109 }, { spec: '120W', value: 9 }] },
  });
  it('规格+名称+小计三元组列举（100W 109套、120W 9套）→ 不入候选（判定层不误判 conflict）', () => {
    const collection = collectBlueprintCitationCandidates('灯具安装：100W LED灯具109套、120W LED灯具9套。', citationBlueprint);
    expect(collection.candidates.filter(candidate => candidate.kind === 'quantity')).toHaveLength(0);
  });
  it('无规格限定的不一致同名引用 → 照常入候选（豁免不过宽）', () => {
    const collection = collectBlueprintCitationCandidates('现场配置LED灯具100套。', citationBlueprint);
    const quantityCandidates = collection.candidates.filter(candidate => candidate.kind === 'quantity');
    expect(quantityCandidates).toHaveLength(1);
    expect(quantityCandidates[0]?.value).toBe(100);
    expect(quantityCandidates[0]?.authority).toBe(118);
  });
});

// r28j M16 工期缓冲项豁免（r28i 归因：「亮化与收尾工程节点用时2天，合计89天，预留机动工期1天」
// 的「工期1天」被 dayRe 误采为总工期口径候选——89+1=90 与蓝图权威数学一致；数字前同分句
// 窗口含预留/机动/缓冲词时属工期分解的缓冲项，不入候选）
describe('r28j M16 工期缓冲项豁免（citation dayRe 同分句窗口）', () => {
  it('「合计89天，预留机动工期1天」缓冲项不入候选（实机归因形态）', () => {
    const collection = collectBlueprintCitationCandidates('亮化与收尾工程节点用时2天，合计89天，预留机动工期1天。', citationBlueprintOf({}, 90));
    expect(collection.candidates.filter(candidate => candidate.kind === 'total-days')).toHaveLength(0);
  });

  it('缓冲词族「预留/机动/缓冲」均豁免（同分句窗口，不跨句误伤）', () => {
    const reserved = collectBlueprintCitationCandidates('本工程工期90日历天，预留工期5天用于联调缓冲。', citationBlueprintOf({}, 90));
    expect(reserved.candidates.filter(candidate => candidate.kind === 'total-days')).toHaveLength(0);
    // 跨句对照：下一句的真实工期异值不受上句缓冲词影响
    const crossSentence = collectBlueprintCitationCandidates('预留机动工期1天。本工程总工期95日历天完成全部施工内容。', citationBlueprintOf({}, 90));
    const days = crossSentence.candidates.filter(candidate => candidate.kind === 'total-days');
    expect(days).toHaveLength(1);
    expect(days[0]?.value).toBe(95);
  });

  it('真总工期异值句仍入候选（豁免不过宽）', () => {
    const collection = collectBlueprintCitationCandidates('本工程总工期95日历天完成全部施工内容。', citationBlueprintOf({}, 90));
    const days = collection.candidates.filter(candidate => candidate.kind === 'total-days');
    expect(days).toHaveLength(1);
    expect(days[0]?.value).toBe(95);
  });
});

// r28m M24a A1/F3 citation 判据扩围（r28k 实机：作业组织口径误入候选 + 进度分解子项误采为总工期口径）
describe('r28m M24a A1/F3 citation 判据扩围', () => {
  const villageBlueprint = {
    redLineFacts: [{ key: '自然村数量', value: '20个自然村' }],
    resources: { labor: { peakValue: 0 } },
    contract: { totalDays: 0 },
    project: { scope: '覆盖20个自然村' },
    quantities: {},
  } as unknown as BlueprintData;

  it('A1：「9个自然村作业面核对」不入 village-count 候选（作业组织口径，非村数陈述）', () => {
    const collection = collectBlueprintCitationCandidates('施工员每日按9个自然村作业面核对现场进度与人员到岗情况。', villageBlueprint);
    expect(collection.candidates.filter(candidate => candidate.kind === 'village-count')).toHaveLength(0);
  });

  it('A1 边界：真村数异值引用仍入候选（负向排除不过宽）', () => {
    const collection = collectBlueprintCitationCandidates('本项目覆盖9个自然村。', villageBlueprint);
    const village = collection.candidates.filter(candidate => candidate.kind === 'village-count');
    expect(village).toHaveLength(1);
    expect(village[0]?.value).toBe(9);
    expect(village[0]?.authority).toBe(20);
  });

  it('F3：「关键线路控制工期300天」子项口径不入 total-days 候选（进度分解子项表述）', () => {
    const collection = collectBlueprintCitationCandidates('关键线路控制工期300天，非关键线路按流水插入组织。', citationBlueprintOf({}, 90));
    expect(collection.candidates.filter(candidate => candidate.kind === 'total-days')).toHaveLength(0);
  });

  it('F3 边界：真总工期异值句仍入候选（子项词豁免不误伤项目总工期口径）', () => {
    const collection = collectBlueprintCitationCandidates('本项目总工期为300天。', citationBlueprintOf({}, 90));
    const days = collection.candidates.filter(candidate => candidate.kind === 'total-days');
    expect(days).toHaveLength(1);
    expect(days[0]?.value).toBe(300);
  });
});

// r26 实测归因：49 个同名清单条目对同一处正文绑定逐条复报同一处「无源」（灌水 49 条）——
// 绑定级去重（一处绑定只报一条）+ 同名多条目聚合文案；交付前确定性删除器按子句边界删除无源绑定子句。
describe('r26 名称绑定复报收敛与无源绑定确定性删除', () => {
  /** 49 个同名条目（数量互异）——复现「同名单条目逐条复报」灌水形态 */
  const manyConcreteLock = lockOf(
    Array.from({ length: 49 }, (_, index) => lockEntry({ name: '水泥混凝土', quantity: Number((2300.57 + index).toFixed(2)), unit: 'm2' })),
  );

  it('同名 49 条目对同一处绑定只报一条（绑定级去重）+ 聚合文案不内嵌单一数量', () => {
    const issues = factReconciliationIssues({
      markdown: '道路工程涉及改造面积2783㎡，其中新建水泥混凝土面层面积1757㎡，施工放样复核后进入下道工序。',
      billFactLock: manyConcreteLock,
    });
    const bindings = issues.filter(issue => issue.message.startsWith('名称-数值绑定无源'));
    expect(bindings).toHaveLength(1);
    expect(bindings[0].message).toContain('1757');
    expect(bindings[0].message).toContain('同名清单条目（共 49 条');
  });

  it('转写宽容：正文整数 1757㎡ = 权威 1757.12㎡ 的截断转写 → 不报', () => {
    const toleranceLock = lockOf([lockEntry({ name: '整理绿化用地', quantity: 1757.12, unit: 'm2' })]);
    const issues = factReconciliationIssues({ markdown: '本工程整理绿化用地1757㎡。', billFactLock: toleranceLock });
    expect(issues.filter(issue => issue.message.startsWith('名称-数值绑定'))).toEqual([]);
  });

  it('转写宽容不覆盖非转写值：1758㎡ vs 权威 1757.12㎡ → 仍报（防豁免过宽）', () => {
    const toleranceLock = lockOf([lockEntry({ name: '整理绿化用地', quantity: 1757.12, unit: 'm2' })]);
    const issues = factReconciliationIssues({ markdown: '本工程整理绿化用地1758㎡。', billFactLock: toleranceLock });
    expect(issues.some(issue => issue.message.startsWith('名称-数值绑定无源'))).toBe(true);
  });

  it('确定性删除：无源绑定子句按子句边界删除（复检零残留 + 幂等）', () => {
    const md = '道路工程涉及改造面积2783㎡，其中新建水泥混凝土面层面积1757㎡，施工放样复核后进入下道工序。';
    const fixed = fixUnsourcedNameBindings(md, { billFactLock: manyConcreteLock });
    expect(fixed.fixedCount).toBe(1);
    expect(fixed.markdown).toContain('改造面积2783㎡');
    expect(fixed.markdown).not.toContain('1757');
    expect(fixed.markdown).toContain('施工放样复核后进入下道工序');
    expect(factReconciliationIssues({ markdown: fixed.markdown, billFactLock: manyConcreteLock }).filter(issue => issue.message.startsWith('名称-数值绑定无源'))).toEqual([]);
    expect(fixUnsourcedNameBindings(fixed.markdown, { billFactLock: manyConcreteLock }).fixedCount).toBe(0);
  });

  it('豁免链命中处不删除（合法性保护）：组和补差可闭合的绑定保持原文', () => {
    const wellsLock = lockOf([
      lockEntry({ name: '塑料检查井', quantity: 300, unit: '座' }),
      lockEntry({ name: '塑料检查井', quantity: 255, unit: '座' }),
      lockEntry({ name: '砌筑检查井', quantity: 2, unit: '座' }),
    ]);
    const md = '检查井逐座验收，共塑料检查井557座，验收合格后封顶。';
    const fixed = fixUnsourcedNameBindings(md, { billFactLock: wellsLock });
    expect(fixed.fixedCount).toBe(0);
    expect(fixed.markdown).toBe(md);
  });

  it('无清单权威 → 删除器静默跳过（不误伤无数据项目）', () => {
    const md = '任意正文水泥混凝土1757㎡。';
    const fixed = fixUnsourcedNameBindings(md, {});
    expect(fixed.fixedCount).toBe(0);
    expect(fixed.markdown).toBe(md);
  });
});

/** citation 候选收集所需的最小蓝图数据（红线/资源/合同/范围空载，仅 quantities 参与结构定位；totalDays 供工期候选用例） */
function citationBlueprintOf(quantities: Record<string, unknown>, totalDays = 0): BlueprintData {
  return {
    redLineFacts: [],
    resources: { labor: { peakValue: 0 } },
    contract: { totalDays },
    project: { scope: '' },
    quantities,
  } as unknown as BlueprintData;
}

describe('巢湖实测口径收口：阈值分档 / 位置高度量 / 零值（误报清除，真错仍报）', () => {
  // 「单个雨水口接出管采用DN200管，2个及2个以上雨水口接出管采用DN300管」——2个 是雨水口
  // 分档门槛（阈值），不是 DN200 的数量；该值恰撞清单「混凝土检查井」（C35 2个）报张冠李戴
  const thresholdLock = lockOf([
    lockEntry({ name: '塑料管', quantity: 168, unit: 'm', specQuantityPairs: [{ spec: 'DN200', quantity: '168m' }] }),
    lockEntry({ name: '混凝土检查井', quantity: 2, unit: '个', specQuantityPairs: [{ spec: 'C35', quantity: '2个' }] }),
  ]);

  it('「DN200管，2个及2个以上雨水口…」阈值分档句 → 不报（分档门槛非清单数量）', () => {
    const issues = factReconciliationIssues({
      markdown: '单个雨水口接出管采用DN200管，2个及2个以上雨水口接出管采用DN300管。',
      billFactLock: thresholdLock,
    });
    expect(issues.filter(issue => issue.message.includes('DN200'))).toEqual([]);
  });

  const zeroLock = lockOf([
    lockEntry({ name: '塑料管', quantity: 168, unit: 'm', specQuantityPairs: [{ spec: 'DN300', quantity: '168m' }] }),
    lockEntry({ name: '现浇构件钢筋', quantity: 0, unit: '个', specQuantityPairs: [{ spec: 'HRB400', quantity: '0个' }] }),
  ]);

  it('「DN300管，0.0个坡百雨求井」（图纸 OCR 残句）→ 不报（零值不构成数量归属）', () => {
    const issues = factReconciliationIssues({
      markdown: '无道牙处采用平箅式单箅雨水口，单个雨水口接出管采用DN300管，0.0个坡百雨求井。',
      billFactLock: zeroLock,
    });
    expect(issues.filter(issue => issue.message.includes('DN300'))).toEqual([]);
  });

  it('对照：DN200 2个（无阈值尾缀）→ 张冠李戴仍报（豁免未过宽）', () => {
    const issues = factReconciliationIssues({
      markdown: '单个雨水口接出管采用DN200管，2个。',
      billFactLock: thresholdLock,
    });
    expect(issues.some(issue => issue.message.includes('DN200'))).toBe(true);
  });

  // 「桥架底边距地7米」的 7米 是安装高度（长度单位），被误绑给「桥架」后恰撞「塑料管 7m」
  const positionLock = lockOf([
    lockEntry({ name: '桥架', quantity: 2811, unit: 'm' }),
    lockEntry({ name: '塑料管', quantity: 7, unit: 'm' }),
  ]);

  it('「桥架底边距地7米」位置高度句 → 不报（距地高度非工程量）', () => {
    const issues = factReconciliationIssues({
      markdown: '桥架底边距地7米，沿墙壁安装。',
      billFactLock: positionLock,
    });
    expect(issues.filter(issue => issue.message.includes('桥架'))).toEqual([]);
  });

  it('对照：桥架 7米（无位置量词）→ 绑定错位仍报（豁免未过宽）', () => {
    const issues = factReconciliationIssues({
      markdown: '桥架 7米，沿墙壁安装。',
      billFactLock: positionLock,
    });
    expect(issues.some(issue => issue.message.includes('桥架'))).toBe(true);
  });
});
