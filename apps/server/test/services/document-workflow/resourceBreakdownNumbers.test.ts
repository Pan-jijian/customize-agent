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

/** 清单事实锁（口径分层第二源）：条目名 + 工程量 + 规格-数量对（规格 token 照抄锁）
 *  village=该条目所属单体/分区标识（语句口径层级判定用；缺省为空 = 无单体语境） */
function lockOf(rows: Array<{ name: string; quantity: number; unit?: string; specs?: string[]; village?: string }>): BillFactLock {
  const entries: BillFactLockEntry[] = rows.map((row, index) => ({
    seq: index + 1,
    name: row.name,
    description: '',
    quantity: row.quantity,
    unit: row.unit || '',
    section: '',
    subsection: '',
    villageGroup: row.village || '',
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

// ═══════ 4.55.32 材料拆分口径层级对齐（巢湖真实 draft 五条疑似误报归因，机制口径） ═══════
// ① 量词口径闸：抽取量词必须属该材料权威量词集（蓝图单位 ∪ 清单逐条单位）；
// ② 项目级语句合法口径 = 各逐条值 ∪ 逐条值合计（组和）∪ 蓝图汇总；
// ③ 单体语句（逐条口径含 ≥2 个单体/分区标识且本句点名其一）合法口径 = 该单体逐条值。
describe('4.55.32 材料拆分量词口径闸（跨量词取值不参与比对）', () => {
  // 巢湖模板原文形态：水表（组）与 井室/砌筑检查井（座）同句，且后者列表紧邻水表规格
  const materialsPlan = [
    { name: '水表', spec: 'DN65', quantity: 2, unit: '组', basis: '' },
    { name: '水表', spec: 'DN40', quantity: 1, unit: '组', basis: '' },
    { name: '砌筑检查井', spec: 'DN65', quantity: 4, unit: '座', basis: '' },
    { name: '砌筑检查井', spec: 'DN100', quantity: 17, unit: '座', basis: '' },
  ];
  const lock = lockOf([
    { name: '水表', quantity: 2, unit: '组', specs: ['DN65'] },
    { name: '水表', quantity: 1, unit: '组', specs: ['DN40'] },
    { name: '砌筑检查井', quantity: 4, unit: '座', specs: ['DN65', 'DN100'] },
    { name: '砌筑检查井', quantity: 17, unit: '座', specs: ['DN100', 'DN150'] },
  ]);
  /** 原文：水表 7 组按 DNxx N组…；井室 54 座按 DNxx N座…（座值曾按「组」报出：水表（DN40）正文 29组） */
  const markdown = '室外给水水表2组按DN65 2组、DN40 1组安装于砌筑检查井内，井室50座按DN40 29座、DN65 4座、DN100 21座砌筑。';

  it('井室列表的座值不再按组抽到水表名下（零claim）', () => {
    expect(scanResourceBreakdownClaims(markdown, authorityOf({ composition: [] }, [], materialsPlan, lock))).toEqual([]);
  });

  it('砌筑检查井 DN100 组和（4+17=21）属项目级汇总明细 → 不判偏离（对照：25 照报蓝图权威 17）', () => {
    const authority = authorityOf({ composition: [] }, [], materialsPlan, lock);
    const drifted = scanResourceBreakdownClaims('水表2组安装于砌筑检查井内，井室50座按DN40 29座、DN65 4座、DN100 25座砌筑。', authority);
    expect(drifted).toHaveLength(1);
    expect(drifted[0]).toMatchObject({ label: '材料拆分 砌筑检查井（DN100）', actual: 25, expected: 17 });
    expect(drifted[0]?.message).toContain('蓝图权威 17座');
  });

  it('同量词真漂移照报，且逐条=汇总时报文不带「跨单体总量」提示（防自相矛盾报文）', () => {
    const claims = scanResourceBreakdownClaims('室外给水水表2组按DN65 5组、DN40 1组安装于砌筑检查井内。', authorityOf({ composition: [] }, [], materialsPlan, lock));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ label: '材料拆分 水表（DN65）', actual: 5, expected: 2 });
    expect(claims[0]?.message).toContain('清单逐条口径 2组');
    expect(claims[0]?.message).not.toContain('跨单体总量');
  });
});

describe('4.55.32 语句口径层级 ↔ 权威口径层级（单体语句比逐条、项目级语句比汇总）', () => {
  const materialsPlan = [
    { name: '管道消毒冲洗', spec: 'DN25', quantity: 229.2, unit: 'm', basis: '' },
    { name: '管道消毒冲洗', spec: 'DN40', quantity: 140.4, unit: 'm', basis: '' },
  ];
  const lock = lockOf([
    { name: '管道消毒冲洗', quantity: 0.6, unit: 'm', specs: ['DN40'], village: '3#门卫' },
    { name: '管道消毒冲洗', quantity: 139.8, unit: 'm', specs: ['DN40'], village: '室外管网' },
  ]);

  it('项目级语句写汇总值（跨单体总量）→ 放行', () => {
    const authority = authorityOf({ composition: [] }, [], materialsPlan, lock);
    expect(scanResourceBreakdownClaims('全项目管道消毒冲洗DN40 140.4m。', authority)).toEqual([]);
  });

  it('单体语句写汇总值 → 报出并以该单体逐条口径为期望值（不得把跨单体总量写进单体语句）', () => {
    const claims = scanResourceBreakdownClaims('3#门卫给水系统管道消毒冲洗DN40 140.4m。', authorityOf({ composition: [] }, [], materialsPlan, lock));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ actual: 140.4, expected: 0.6 });
    expect(claims[0]?.message).toContain('清单逐条口径 0.6m');
    expect(claims[0]?.message).toContain('蓝图汇总 140.4m 为跨单体总量');
  });

  it('单体语句写本单体逐条口径 → 放行；无单体语境且值不属任一层口径 → 照报', () => {
    const authority = authorityOf({ composition: [] }, [], materialsPlan, lock);
    expect(scanResourceBreakdownClaims('3#门卫给水系统管道消毒冲洗DN40 0.6m。', authority)).toEqual([]);
    const stray = scanResourceBreakdownClaims('全项目管道消毒冲洗DN40 1m。', authority);
    expect(stray).toHaveLength(1);
    expect(stray[0]).toMatchObject({ actual: 1, expected: 140.4 });
  });

  it('修复器在单体语句上按该单体逐条口径收敛（写汇总值被改写为 0.6m 且复检零残留）', () => {
    const result = fixResourceBreakdownNumbers('3#门卫给水系统管道消毒冲洗DN40 140.4m。', authorityOf({ composition: [] }, [], materialsPlan, lock));
    expect(result.fixedCount).toBe(1);
    expect(result.residualCount).toBe(0);
    expect(result.markdown).toContain('管道消毒冲洗DN40 0.6m');
  });
});

describe('4.55.32 机械台数单源归属（#5 配套说明不得被记为本设备台数）', () => {
  /** 真机蓝图为中值口径：塔式起重机（QTZ63）min1max3 → 2 台；混凝土输送泵 min2max4 → 3 台 */
  const realAuthority = () => authorityOf({ composition: [] }, [
    { name: '塔式起重机', spec: 'QTZ63', min: 1, max: 3 },
    { name: '混凝土输送泵', min: 2, max: 4 },
  ]);

  it('正样本：塔式起重机配混凝土输送泵2台作业 —— 2 台属塔式起重机（配套说明），不记入混凝土输送泵名下', () => {
    // 真机 doc-1790132484476-29b74c88 原句；旧实现把「…配混凝土输送泵2台」的 2 台记到混凝土输送泵
    // （蓝图权威 3 台）名下 → 「机械台数与蓝图权威不一致：混凝土输送泵 正文 2 台，蓝图权威 3 台」误报
    const claims = scanResourceBreakdownClaims('钢结构吊装以QTZ63塔式起重机配混凝土输送泵2台作业，各工序经施工员自检、质检员复检并报监理验收后进入下道工序。', realAuthority());
    expect(claims).toEqual([]);
  });

  it('反例：混凝土输送泵自身台数漂移仍照报（归属闸不掩盖真偏离）', () => {
    const claims = scanResourceBreakdownClaims('混凝土输送泵5台配置。', realAuthority());
    expect(claims).toHaveLength(1);
    expect(claims[0]?.message).toContain('混凝土输送泵 正文 5 台，蓝图权威 3 台');
  });

  it('反例：塔式起重机自身台数漂移仍照报（引导名即本条目，互含视为同条目）', () => {
    const claims = scanResourceBreakdownClaims('QTZ63塔式起重机3台安装并完成检测验收。', realAuthority());
    expect(claims).toHaveLength(1);
    expect(claims[0]?.message).toContain('塔式起重机 正文 3 台，蓝图权威 2 台');
  });

  it('反例：同类设备并列各自成量（挖掘机2台、装载机3台）不跨名归账', () => {
    const authority = authorityOf({ composition: [] }, [
      { name: '挖掘机', quantity: 2, spec: '' },
      { name: '装载机', quantity: 3, spec: '' },
    ]);
    const claims = scanResourceBreakdownClaims('土方阶段配置挖掘机2台、装载机3台。', authority);
    expect(claims).toEqual([]);
  });
});
