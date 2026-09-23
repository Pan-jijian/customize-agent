/**
 * A3 资源章数值拆分一致性单源单测（4.27.0）：
 * - scanResourceBreakdownClaims：三类模式（工种构成/机械台数/材料拆分）检出与豁免口径；
 *   阶段部署子窗口豁免（基线「亮化与收尾工程阶段投入43人…普工25人…混凝土工10人…管道工5人…绿化工3人」，
 *   25+10+5+3=43 恰为该阶段总人数属退场期部署非全项目构成漂移；该段位于劳动力总说明混合大块末段，
 *   整块合计因混有 168/85/216 阶段说明而失配，故按 [阶段匹配, 下一阶段匹配或块尾) 子窗口判定）；
 *   机械分配语境不误采（基线「其中3台」「1台转入」由 12 字无锚定搜索误采，锚定「名称后 ≤2 桥接字」后不误采）。
 * - fixResourceBreakdownNumbers：定点硬替换 + 复检（复检残留整体回滚）；幂等零残留。
 */
import { describe, expect, it } from 'vitest';
import { buildResourceBreakdownAuthority, fixResourceBreakdownNumbers, scanResourceBreakdownClaims } from '@/services/document-workflow/resourceBreakdownNumbers';
import type { BillFactLock, BillFactLockEntry } from '@/services/document-workflow/billFactLock';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';

function blueprint(labor: unknown, equipment: unknown[] = [], materialsPlan: unknown[] = []): BlueprintData {
  return { resources: { labor, equipment }, materialsPlan } as unknown as BlueprintData;
}

function authorityOf(labor: unknown, equipment: unknown[] = [], materialsPlan: unknown[] = [], lock?: BillFactLock) {
  const authority = buildResourceBreakdownAuthority(blueprint(labor, equipment, materialsPlan), lock);
  if (!authority) throw new Error('authority 构造失败');
  return authority;
}

/** 清单事实锁（口径分层第二源）：条目名 + 工程量 + 规格-数量对（规格 token 照抄锁） */
function lockOf(rows: Array<{ name: string; quantity: number; unit?: string; specs?: string[] }>): BillFactLock {
  const entries: BillFactLockEntry[] = rows.map((row, index) => ({
    seq: index + 1,
    name: row.name,
    description: '',
    quantity: row.quantity,
    unit: row.unit || '',
    section: '',
    subsection: '',
    villageGroup: '',
    sourceFile: 'test-lock.xls',
    specQuantityPairs: (row.specs || []).map(spec => ({ spec, quantity: `${row.quantity}${row.unit || ''}` })),
  }));
  return { entries, totalEntries: entries.length, sourceFile: 'test-lock.xls', complete: true };
}

describe('scanResourceBreakdownClaims 阶段部署子窗口豁免（A3 基线形态）', () => {
  it('退场期部署段（25+10+5+3=43=阶段总数）→ 整段豁免零检出', () => {
    const authority = authorityOf({ composition: [
      { trade: '普工', count: 45, basis: '' },
      { trade: '混凝土工', count: 88, basis: '' },
      { trade: '管道工', count: 34, basis: '' },
      { trade: '绿化工', count: 48, basis: '' },
    ] });
    const markdown = '亮化与收尾工程阶段投入43人，为退场收口期。普工25人负责收尾整修，混凝土工10人负责零星构件，管道工5人配合排查，绿化工3人进行场地恢复。';
    expect(scanResourceBreakdownClaims(markdown, authority)).toEqual([]);
  });

  it('阶段总数与工种合计不等 → 不豁免、照常检出', () => {
    const authority = authorityOf({ composition: [
      { trade: '普工', count: 45, basis: '' },
      { trade: '混凝土工', count: 88, basis: '' },
    ] });
    const markdown = '亮化与收尾工程阶段投入43人，为退场收口期。普工25人负责收尾整修，混凝土工10人负责零星构件。';
    const claims = scanResourceBreakdownClaims(markdown, authority);
    expect(claims.map(claim => claim.actual).sort((left, right) => left - right)).toEqual([10, 25]);
  });

  it('无阶段词的构成漂移 → 检出（豁免层不扩大）', () => {
    const authority = authorityOf({ composition: [{ trade: '混凝土工', count: 88, basis: '' }] });
    const claims = scanResourceBreakdownClaims('主体结构施工高峰期投入混凝土工10人。', authority);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: 'trade', actual: 10, expected: 88 });
  });

  it('混合大块（基线形态）：多阶段说明 + 末段 43 人部署明细 → 仅部署子窗口豁免', () => {
    const authority = authorityOf({ composition: [
      { trade: '普工', count: 45, basis: '' },
      { trade: '混凝土工', count: 88, basis: '' },
      { trade: '管道工', count: 34, basis: '' },
      { trade: '绿化工', count: 48, basis: '' },
    ] });
    const markdown = '施工准备与清杂拆除阶段投入168人，其中普工45人全部进场，承担场地清杂；混凝土工投入60人，提前介入拆除路面。亮化与收尾工程阶段投入43人，为退场收口期。普工25人负责收尾整修；混凝土工10人负责零星构件；管道工5人配合排查；绿化工3人进行场地恢复。第88日完成转段清点。';
    expect(scanResourceBreakdownClaims(markdown, authority)).toEqual([]);
  });

  it('混合大块：阶段子窗口合计不匹配 → 不豁免，真实漂移照常检出（防借阶段词漏修）', () => {
    const authority = authorityOf({ composition: [{ trade: '混凝土工', count: 88, basis: '' }] });
    const markdown = '施工准备与清杂拆除阶段投入168人，其中混凝土工45人全部进场。亮化与收尾工程阶段投入43人，为退场收口期。普工25人负责收尾整修。';
    const claims = scanResourceBreakdownClaims(markdown, authority);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: 'trade', actual: 45, expected: 88 });
  });
});

describe('scanResourceBreakdownClaims 机械分配语境（A3 基线误采回归）', () => {
  it('「其中3台」「1台转入」分配语境 → 不误采', () => {
    const authority = authorityOf({ composition: [] }, [{ name: '挖掘机', quantity: 5, spec: '' }]);
    const markdown = '施工准备与清杂拆除阶段投入全部5台挖掘机，其中3台用于房前屋后整理与清杂，2台用于拆除路面及基层。污水管网工程阶段保留5台挖掘机用于沟槽开挖，1台转入沟塘清淤与淤泥流砂开挖。';
    expect(scanResourceBreakdownClaims(markdown, authority)).toEqual([]);
  });

  it('机械台数漂移锚定检出（名称后紧邻台数）', () => {
    const authority = authorityOf({ composition: [] }, [{ name: '挖掘机', quantity: 5, spec: '' }]);
    const claims = scanResourceBreakdownClaims('土方阶段配置挖掘机3台。', authority);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.message).toContain('挖掘机 正文 3 台，蓝图权威 5 台');
  });

  it('「挖掘机共3台」桥接词白名单内 → 检出', () => {
    const authority = authorityOf({ composition: [] }, [{ name: '挖掘机', quantity: 5, spec: '' }]);
    expect(scanResourceBreakdownClaims('现场挖掘机共3台投入使用。', authority)).toHaveLength(1);
  });

  it('「挖掘机其中3台」桥接词白名单外 → 不误采', () => {
    const authority = authorityOf({ composition: [] }, [{ name: '挖掘机', quantity: 5, spec: '' }]);
    expect(scanResourceBreakdownClaims('现场挖掘机其中3台投入使用。', authority)).toEqual([]);
  });
});

describe('fixResourceBreakdownNumbers 定点修复与复检', () => {
  it('工种构成漂移 → 硬替换为蓝图权威 + 零残留', () => {
    const authority = authorityOf({ composition: [{ trade: '混凝土工', count: 88, basis: '' }] });
    const result = fixResourceBreakdownNumbers('主体结构施工高峰期投入混凝土工10人。', authority);
    expect(result.fixedCount).toBe(1);
    expect(result.residualCount).toBe(0);
    expect(result.markdown).toBe('主体结构施工高峰期投入混凝土工88人。');
    expect(result.details).toEqual(['工种构成 混凝土工 10→88']);
  });

  it('同工种多处偏离一轮全部收敛（不再首条 break）', () => {
    const authority = authorityOf({ composition: [{ trade: '混凝土工', count: 88, basis: '' }] });
    const result = fixResourceBreakdownNumbers('投入混凝土工10人。\n\n另处混凝土工12人。', authority);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toBe('投入混凝土工88人。\n\n另处混凝土工88人。');
  });

  it('机械多规格语境定点修复（只改偏离规格）', () => {
    const authority = authorityOf({ composition: [] }, [{ name: '挖掘机', quantity: 2, spec: '0.6m³' }, { name: '挖掘机', quantity: 1, spec: '1.0m³' }]);
    const result = fixResourceBreakdownNumbers('配置挖掘机（0.6m³）3台、挖掘机（1.0m³）1台。', authority);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('配置挖掘机（0.6m³）2台、挖掘机（1.0m³）1台。');
  });

  it('材料拆分漂移 → 逐规格硬替换（合计行豁免不修）', () => {
    const authority = authorityOf({ composition: [] }, [], [
      { name: '一般路灯', spec: '100W', quantity: 109, unit: '套', basis: '' },
      { name: '一般路灯', spec: '120W', quantity: 9, unit: '套', basis: '' },
    ]);
    const result = fixResourceBreakdownNumbers('一般路灯 100W 111套 + 120W 7套。\n| 合计 | 一般路灯 100W+120W | 118套 |', authority);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('一般路灯 100W 109套 + 120W 9套。');
    expect(result.markdown).toContain('| 合计 | 一般路灯 100W+120W | 118套 |');
    expect(result.residualCount).toBe(0);
  });

  it('幂等：修复后重跑零命中', () => {
    const authority = authorityOf({ composition: [{ trade: '混凝土工', count: 88, basis: '' }] });
    const first = fixResourceBreakdownNumbers('投入混凝土工10人。', authority);
    const second = fixResourceBreakdownNumbers(first.markdown, authority);
    expect(second.fixedCount).toBe(0);
    expect(second.markdown).toBe(first.markdown);
  });

  it('无蓝图 → 静默零改动', () => {
    expect(buildResourceBreakdownAuthority(undefined)).toBeUndefined();
    expect(fixResourceBreakdownNumbers('混凝土工10人。')).toEqual({ markdown: '混凝土工10人。', fixedCount: 0, details: [], residualCount: 0 });
  });
});

// ═══════ 4.55.30 材料拆分归属锚定 + 口径分层（巢湖真实 draft 两条误报归因，机制口径） ═══════
// ① 归属：规格数量属分句内**最近**的权威材料名，不属同句更早出现的其它材料
//（「…，管道消毒冲洗DN401m」的 DN40 1m 属管道消毒冲洗，曾被整句 includes 归到复合管名下）；
// ② 口径分层：蓝图 materialsPlan 是项目级汇总（跨单体求和），清单事实锁是逐条口径（单体/条目级）——
//    正文在单体语境引用逐条口径属正常，不得拿汇总值比对/改写。
describe('4.55.30 材料拆分归属锚定（分句内最近材料名）', () => {
  const materialsPlan = [
    { name: '复合管', spec: 'DN80', quantity: 430, unit: 'm', basis: '' },
    { name: '复合管', spec: 'DN40', quantity: 136.8, unit: 'm', basis: '' },
    { name: '管道消毒冲洗', spec: 'DN25', quantity: 229.2, unit: 'm', basis: '' },
    { name: '管道消毒冲洗', spec: 'DN40', quantity: 140.4, unit: 'm', basis: '' },
  ];
  /** 巢湖 3#门卫给水系统原文（复合管 0.6/5/1 三值由「计」桥接，不构成拆分宣称） */
  const markdown = '3#门卫给水系统作业对象为门卫室内生活给水管道及配套附件，复合管DN40计0.6m、DN20计5m、DN15计1m，配套减压器DN20共1组，管道消毒冲洗DN401m，成品管卡安装DN15、DN40各1项。';

  it('「管道消毒冲洗DN401m」不归到复合管名下（跨材料误绑 → 无复合管 claim）', () => {
    const claims = scanResourceBreakdownClaims(markdown, authorityOf({ composition: [] }, [], materialsPlan));
    expect(claims.filter(claim => claim.label.includes('复合管'))).toEqual([]);
    // 该值归其就近材料（管道消毒冲洗）：正文 1 vs 蓝图汇总 140.4 → 照常报出
    const disinfection = claims.filter(claim => claim.label.includes('管道消毒冲洗'));
    expect(disinfection).toHaveLength(1);
    expect(disinfection[0]).toMatchObject({ actual: 1, expected: 140.4, kind: 'material' });
  });

  it('同分句内其它材料名在前仍按最近名归属（复合管DN40 130m 照报，不串值）', () => {
    const claims = scanResourceBreakdownClaims('管道消毒冲洗DN40 1m，复合管DN40 130m。', authorityOf({ composition: [] }, [], materialsPlan));
    const byLabel = new Map(claims.map(claim => [claim.label, claim.actual]));
    expect([...byLabel.keys()].sort()).toEqual(['材料拆分 复合管（DN40）', '材料拆分 管道消毒冲洗（DN40）']);
    expect(byLabel.get('材料拆分 管道消毒冲洗（DN40）')).toBe(1);
    expect(byLabel.get('材料拆分 复合管（DN40）')).toBe(130);
  });
});

describe('4.55.30 材料拆分口径分层（逐条口径优先于项目级汇总）', () => {
  const materialsPlan = [
    { name: '管道消毒冲洗', spec: 'DN25', quantity: 229.2, unit: 'm', basis: '' },
    { name: '管道消毒冲洗', spec: 'DN40', quantity: 140.4, unit: 'm', basis: '' },
  ];

  it('正文值命中清单逐条口径 → 不判偏离（分层引用合法，零 claim、零改写）', () => {
    const lock = lockOf([{ name: '管道消毒冲洗', quantity: 0.6, unit: 'm', specs: ['DN40'] }]);
    const claims = scanResourceBreakdownClaims('管道消毒冲洗DN40 0.6m。', authorityOf({ composition: [] }, [], materialsPlan, lock));
    expect(claims).toEqual([]);
    // 对照：无锁（只有项目级汇总 140.4）时同一句会被判偏离
    expect(scanResourceBreakdownClaims('管道消毒冲洗DN40 0.6m。', authorityOf({ composition: [] }, [], materialsPlan))).toHaveLength(1);
  });

  it('正文值不在逐条口径集 → 逐条口径唯一时以之为期望值（不得改写为项目级汇总）', () => {
    const lock = lockOf([{ name: '管道消毒冲洗', quantity: 0.6, unit: 'm', specs: ['DN40'] }]);
    const claims = scanResourceBreakdownClaims('管道消毒冲洗DN401m。', authorityOf({ composition: [] }, [], materialsPlan, lock));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ actual: 1, expected: 0.6 });
    expect(claims[0]?.message).toContain('清单逐条口径 0.6m');
    expect(claims[0]?.message).toContain('蓝图汇总 140.4m');
  });

  it('逐条口径多值（无唯一裁决依据）→ 维持蓝图汇总口径（现状不放大）', () => {
    const lock = lockOf([
      { name: '管道消毒冲洗', quantity: 0.6, unit: 'm', specs: ['DN40'] },
      { name: '管道消毒冲洗', quantity: 139.8, unit: 'm', specs: ['DN40'] },
    ]);
    const claims = scanResourceBreakdownClaims('管道消毒冲洗DN401m。', authorityOf({ composition: [] }, [], materialsPlan, lock));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ actual: 1, expected: 140.4 });
    expect(claims[0]?.message).toContain('蓝图权威 140.4m');
  });

  it('修复器按逐条口径收敛（0.6m 而非汇总 140.4m），复检零残留', () => {
    const lock = lockOf([{ name: '管道消毒冲洗', quantity: 0.6, unit: 'm', specs: ['DN40'] }]);
    const result = fixResourceBreakdownNumbers('3#门卫安装：管道消毒冲洗DN401m，安装后通水验收。', authorityOf({ composition: [] }, [], materialsPlan, lock));
    expect(result.fixedCount).toBe(1);
    expect(result.residualCount).toBe(0);
    expect(result.markdown).toContain('管道消毒冲洗DN400.6m');
    expect(result.markdown).not.toContain('140.4');
  });
});
