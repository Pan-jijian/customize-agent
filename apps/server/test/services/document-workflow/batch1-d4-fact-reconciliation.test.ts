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
import { factReconciliationIssues } from '@/services/document-workflow/factReconciliation';
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
function blueprintOf(quantities: Record<string, { value: number; unit: string }>): BlueprintData {
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
