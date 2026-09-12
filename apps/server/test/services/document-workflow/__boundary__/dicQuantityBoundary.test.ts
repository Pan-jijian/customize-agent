/**
 * G3 fixQuantityAuthorityConflicts 边界矩阵（P1）
 * 分层采样设计（每条用例独立断言）：
 *  A 数值格式 × 单位全组合（替换正确性）
 *  B 差异率谱系（2% 阈值边界）
 *  C 五重豁免矩阵（正反例：最长条目名/表格行/规格前后置/村名窗口+段落/句级口径）
 *  D 列举窗口截断（下一条目值距离谱系）
 *  E 括号三态名称互配
 *  F 数值-单位间距谱系
 *  G 确定性随机组合采样（不变量断言）
 */
import { describe, expect, it } from 'vitest';
import { fixQuantityAuthorityConflicts } from '@/services/document-workflow/documentIntegrityChecks';
import {
  LIST_SEPARATORS, NUMERIC_FORMATS, SPEC_WORDS, UNIT_GROUPS, VILLAGE_WORDS, VILLAGE_WORDS_REMOVED,
  caseName, contextTemplates, mulberry32, parenStates, product, seededSamples,
} from './boundaryKit';

type Authority = { name: string; value: number; unit: string };
const BASE: Authority = { name: '级配碎石', value: 20931.02, unit: 'm²' };

/** 断言替换落点唯一且精确：结果 == 原文把目标数值换成权威值 */
function assertSingleFix(markdown: string, originalRaw: string, authority: Authority, result: { markdown: string; fixedCount: number }) {
  expect(result.fixedCount).toBe(1);
  expect(result.markdown).toBe(markdown.replace(originalRaw, String(authority.value)));
}

describe('G3-A 数值格式×单位全组合（替换正确性）', () => {
  const unitVariants: Array<[string, Authority]> = [
    ['m²', BASE],
    ['㎡', { ...BASE, unit: '㎡' }],
    ['m2', { ...BASE, unit: 'm2' }],
    ['M2', { ...BASE, unit: 'M2' }],
    ['m³', { ...BASE, unit: 'm³', name: '挖一般土方' }],
    ['吨', { ...BASE, unit: '吨', name: '级配碎石' }],
    ['t', { ...BASE, unit: 't' }],
    ['m', { ...BASE, unit: 'm', name: '金属扶手栏杆' }],
  ];
  const rows = (NUMERIC_FORMATS as readonly string[]).flatMap(format => unitVariants.map(([unitLabel, authority]) => ({
    label: caseName('G3-A 数值格式', { fmt: format, unit: unitLabel }),
    markdown: `${authority.name}${format}${unitLabel}。`,
    authority,
    raw: format,
    // 科学计数法不识别（左边界防线）：不得截取「1e3」中的 3
    expectFix: format !== '1e3',
  })));
  it.each(rows)('$label', ({ markdown, authority, raw, expectFix }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [authority]);
    if (expectFix) assertSingleFix(markdown, raw, authority, result);
    else {
      expect(result.fixedCount).toBe(0);
      expect(result.markdown).toBe(markdown);
    }
  });
});

describe('G3-B 差异率谱系（D2 零漂移豁免）', () => {
  const cases: Array<{ pct: number; expectFix: boolean }> = [
    { pct: 0, expectFix: false },
    { pct: 1, expectFix: true },
    { pct: 2, expectFix: true },
    { pct: 2.1, expectFix: true },
    { pct: 3, expectFix: true },
    { pct: 10, expectFix: true },
    { pct: 30, expectFix: true },
    { pct: 50, expectFix: true },
    { pct: 70, expectFix: true },
    { pct: 90, expectFix: true },
    { pct: 99, expectFix: true },
  ];
  it.each(cases)('G3-B 差异率 $pct% → $expectFix', ({ pct, expectFix }) => {
    const value = Number((BASE.value * (1 - pct / 100)).toFixed(2));
    const markdown = `${BASE.name}${value}${BASE.unit}。`;
    const result = fixQuantityAuthorityConflicts(markdown, [BASE]);
    if (expectFix) assertSingleFix(markdown, String(value), BASE, result);
    else expect(result.fixedCount).toBe(0);
  });
});

describe('G3-C1 最长条目名优先（子串对）', () => {
  const namePairs: Array<{ long: string; short: string; longValue: number; shortValue: number; unit: string }> = [
    { long: '塑料管铺设', short: '塑料管', longValue: 8205.53, shortValue: 7525.01, unit: 'm' },
    { long: '栽植色带（生态池外围一圈）', short: '栽植色带', longValue: 90, shortValue: 552, unit: 'm²' },
    { long: '路床(槽)碾压检验', short: '路床碾压', longValue: 19930.52, shortValue: 19930.52, unit: 'm²' },
    { long: '人行道板安砌', short: '人行道板', longValue: 264.8, shortValue: 150, unit: 'm²' },
  ];
  const valueCases = ['与长条目一致', '与短条目一致', '与两者都不同'] as const;
  const rows = namePairs.flatMap(pair => valueCases.map(valueCase => {
    const longAuthority: Authority = { name: pair.long, value: pair.longValue, unit: pair.unit };
    const shortAuthority: Authority = { name: pair.short, value: pair.shortValue, unit: pair.unit };
    const textValue = valueCase === '与长条目一致' ? String(pair.longValue) : valueCase === '与短条目一致' ? String(pair.shortValue) : String(Number((pair.longValue * 0.4).toFixed(2)));
    // 语义：正文名称与值配对后按长条目校正——值漂移 >2% 才修（名称-值错配如「人行道板安砌150m²」应修 264.8）
    const drift = Math.abs(Number(textValue) - pair.longValue) / pair.longValue;
    const expectFix = drift > 0.02;
    return {
      label: caseName('G3-C1 最长条目名优先', { name: pair.long, vcase: valueCase }),
      markdown: `${pair.long}${textValue}${pair.unit}。`,
      authorities: [shortAuthority, longAuthority],
      expectFix,
      expectText: `${pair.long}${expectFix ? String(pair.longValue) : textValue}${pair.unit}`,
    };
  }));
  it.each(rows)('$label', ({ markdown, authorities, expectFix, expectText }) => {
    const result = fixQuantityAuthorityConflicts(markdown, authorities);
    expect(result.fixedCount).toBe(expectFix ? 1 : 0);
    expect(result.markdown).toContain(expectText);
  });
});

describe('G3-C2 表格行豁免（分村分表数据）', () => {
  const tableForms = [
    `| 方岗段 | 道路、铺装 | 路床碾压1436.4m²、${BASE.name}359.1${BASE.unit} | 土方班组1个 |`,
    `| 分部 | ${BASE.name} | ${BASE.unit} | 480.5 | 备注 |`,
    `|${BASE.name}|${BASE.unit}|480.5|`,
    `| 面坊郢段 | 管网 | 直径450塑料检查井40座 | 管道班组1个 |\n| 分部 | ${BASE.name} | ${BASE.unit} | 480.5 |`,
  ];
  it.each(tableForms)('G3-C2 表格行豁免 %#', (markdown) => {
    const result = fixQuantityAuthorityConflicts(markdown, [BASE]);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });
});

describe('G3-C3 规格限定词豁免（前/后置）', () => {
  const rows = (SPEC_WORDS as readonly string[]).flatMap(spec => (['前置', '后置'] as const).map(pos => ({
    label: caseName('G3-C3 规格豁免', { spec, pos }),
    markdown: pos === '前置' ? `${spec}${BASE.name}40${BASE.unit}。` : `${BASE.name}${spec}铺设40${BASE.unit}。`,
  })));
  it.each(rows)('$label', ({ markdown }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [BASE]);
    expect(result.fixedCount).toBe(0);
  });
  it('G3-C3 无规格限定词时照常修复（对照组）', () => {
    const markdown = `${BASE.name}40${BASE.unit}。`;
    const result = fixQuantityAuthorityConflicts(markdown, [BASE]);
    assertSingleFix(markdown, '40', BASE, result);
  });
});

describe('G3-C4 村名语境豁免（窗口 12 字 × 段落级）', () => {
  // 段落级豁免字符集（郢庄岗塘圩坝）：即使超出 12 字窗口仍整段豁免
  const PARA_WORDS = ['郢', '庄', '岗', '塘', '圩', '坝'];
  const windowRows = (VILLAGE_WORDS as readonly string[]).flatMap(word => (['紧邻名称', '12字边界', '超出窗口13字'] as const).map(pos => {
    // 窗口语义：村名词到条目名的距离 ≤12 字豁免；filler 长度控制距离（+1 为「村」字）
    const filler = pos === '紧邻名称' ? '' : pos === '12字边界' ? '一二三四五六七八九十甲' : '一二三四五六七八九十甲乙丙';
    return {
      label: caseName('G3-C4 窗口村名豁免', { word, pos }),
      markdown: `马老${word}村${filler}${BASE.name}40${BASE.unit}。`,
      // D2 收紧：窗口豁免词（池/井）无段落级兜底——「12字边界」filler 11 字+「村」1 字
      // 使词距名称 13 字（窗口外），仅段落词（郢庄岗塘圩坝）靠段落级豁免继续豁免
      expectExempt: pos === '紧邻名称' || PARA_WORDS.includes(word),
    };
  }));
  it.each(windowRows)('$label', ({ markdown, expectExempt }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [BASE]);
    if (expectExempt) expect(result.fixedCount).toBe(0);
    else assertSingleFix(markdown, '40', BASE, result);
  });
  const removedRows = (VILLAGE_WORDS_REMOVED as readonly string[]).map(word => ({
    label: caseName('G3-C4 收紧剔除词窗口内修复', { word }),
    markdown: `马老${word}村${BASE.name}40${BASE.unit}。`,
  }));
  it.each(removedRows)('$label', ({ markdown }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [BASE]);
    assertSingleFix(markdown, '40', BASE, result);
  });
  const paraRows = VILLAGE_WORDS.map(word => ({
    label: caseName('G3-C4 段落村名豁免', { word }),
    // 村名列表只含被测词（避免固定「张大郢」干扰段落级判定）
    markdown: `殷${word}组、五星等自然村组，主要作业内容为整体化粪池安装、${BASE.name}铺设及配套土方开挖回填。本分项工程量为：砌筑检查井2座；${BASE.name}40${BASE.unit}；回填方42.12m³。`,
    // 池/井行：正文固定语境「整体化粪池安装」「砌筑检查井2座」触发窗口豁免（12 字内）
    // ——该形态无法探测段落级词表对池/井的覆盖（窗口豁免已先行命中），期望豁免
    expectExempt: ['郢', '庄', '岗', '塘', '圩', '坝', '池', '井'].includes(word),
  }));
  it.each(paraRows)('$label', ({ markdown, expectExempt }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [BASE]);
    if (expectExempt) expect(result.fixedCount).toBe(0);
    else assertSingleFix(markdown, '40', BASE, result);
  });
});

describe('G3-C5 句级口径豁免（总量锚点 + ≥2 不一致候选）', () => {
  const peer = { name: '水泥混凝土', value: 20872.82, unit: 'm²' };
  const peerFar = { name: '仿木护栏', value: 333, unit: 'm' };
  const cases: Array<{ label: string; markdown: string; expectExempt: boolean }> = [
    { label: '2大0小（无总量锚点）→不豁免', markdown: `景观工程主要工程量包括${BASE.name}480.5${BASE.unit}、${peer.name}572.3${peer.unit}。`, expectExempt: false },
    { label: '3大1小→豁免', markdown: `景观工程主要工程量包括${BASE.name}480.5${BASE.unit}、${peer.name}572.3${peer.unit}、挖一般土方146.93m³、${peerFar.name}333${peerFar.unit}。`, expectExempt: true },
    { label: '1大0小→不豁免（单条目修复）', markdown: `${BASE.name}40${BASE.unit}。`, expectExempt: false },
    { label: '1大2小→不豁免', markdown: `主要工程量包括${BASE.name}40${BASE.unit}、${peer.name}22960.1${peer.unit}、${peerFar.name}366.3${peerFar.unit}。`, expectExempt: false },
    { label: '2大2小→不豁免', markdown: `主要工程量包括${BASE.name}40${BASE.unit}、${peer.name}572.3${peer.unit}、挖一般土方4606.12m³、${peerFar.name}366.3${peerFar.unit}。`, expectExempt: false },
    { label: '3大4小→不豁免（2.1 道路段形态）', markdown: `道路工程主要工程量包括挖一般土方4040.45m³、路床碾压检验18949.52m²、${BASE.name}18949.52${BASE.unit}，以及拆除路面633m²、拆除基层633m²、余方弃置158.25m³。`, expectExempt: false },
  ];
  it.each(cases)('G3-C5 $label', ({ markdown, expectExempt }) => {
    const authorities: Authority[] = [BASE, peer, peerFar, { name: '挖一般土方', value: 4187.38, unit: 'm³' }, { name: '路床碾压检验', value: 19930.52, unit: 'm²' }, { name: '拆除路面', value: 2134, unit: 'm²' }, { name: '拆除基层', value: 2134, unit: 'm²' }, { name: '余方弃置', value: 3245.5, unit: 'm³' }];
    const result = fixQuantityAuthorityConflicts(markdown, authorities);
    if (expectExempt) expect(result.fixedCount).toBe(0);
    else expect(result.fixedCount).toBeGreaterThan(0);
  });
});

describe('G3-D 列举窗口截断（下一条目值距离谱系）', () => {
  const rows = (LIST_SEPARATORS as readonly string[]).flatMap(sep => ([4, 12, 24, 60] as const).map(gap => {
    const filler = 'x'.repeat(Math.max(0, gap - 2));
    return {
      label: caseName('G3-D 窗口截断', { sep: JSON.stringify(sep), gap: String(gap) }),
      markdown: `${BASE.name}40${BASE.unit}${sep}${filler}其他条目${BASE.value}${BASE.unit}。`,
    };
  }));
  it.each(rows)('$label', ({ markdown }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [BASE]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain(`${BASE.name}${BASE.value}${BASE.unit}`);
    // 下一条目的数值不得被改动（列举截断保护）
    expect(result.markdown).toContain(`其他条目${BASE.value}${BASE.unit}`);
  });
});

describe('G3-E 括号三态名称互配', () => {
  // 显式期望表：flexNamePattern 只把括号可选化（括号内容必选）——
  // 括号形式变化（半/全角）仍命中；括号内容被删的形态不命中（除非内容字仍在，如「给排水附件」）
  const rows: Array<{ label: string; markdown: string; authority: Authority; expectFix: boolean }> = [
    { label: 'G3-E 路床(槽) 半角括号→修', markdown: '路床(槽)碾压检验18429.52m²。', authority: { name: '路床(槽)碾压检验', value: 19930.52, unit: 'm²' }, expectFix: true },
    { label: 'G3-E 路床（槽） 全角括号→修', markdown: '路床（槽）碾压检验18429.52m²。', authority: { name: '路床(槽)碾压检验', value: 19930.52, unit: 'm²' }, expectFix: true },
    { label: 'G3-E 路床无槽字→不命中（括号内容必选）', markdown: '路床碾压检验18429.52m²。', authority: { name: '路床(槽)碾压检验', value: 19930.52, unit: 'm²' }, expectFix: false },
    { label: 'G3-E 生态池 原名→修', markdown: '1#生态池（2T/D)18429.52m²。', authority: { name: '1#生态池（2T/D)', value: 19930.52, unit: 'm²' }, expectFix: true },
    { label: 'G3-E 生态池 全角闭括号→修', markdown: '1#生态池（2T/D）18429.52m²。', authority: { name: '1#生态池（2T/D)', value: 19930.52, unit: 'm²' }, expectFix: true },
    { label: 'G3-E 生态池 去括号内容→不命中', markdown: '1#生态池18429.52m²。', authority: { name: '1#生态池（2T/D)', value: 19930.52, unit: 'm²' }, expectFix: false },
    { label: 'G3-E 栽植色带 原名→修', markdown: '栽植色带（生态池外围一圈）18429.52m²。', authority: { name: '栽植色带（生态池外围一圈）', value: 19930.52, unit: 'm²' }, expectFix: true },
    { label: 'G3-E 栽植色带 半角括号→修', markdown: '栽植色带(生态池外围一圈)18429.52m²。', authority: { name: '栽植色带（生态池外围一圈）', value: 19930.52, unit: 'm²' }, expectFix: true },
    { label: 'G3-E 栽植色带 去括号内容→不命中', markdown: '栽植色带18429.52m²。', authority: { name: '栽植色带（生态池外围一圈）', value: 19930.52, unit: 'm²' }, expectFix: false },
    { label: 'G3-E 公厕内墙 半角括号→修', markdown: '公厕内墙2(面砖内墙面)18429.52m²。', authority: { name: '公厕内墙2(面砖内墙面)', value: 19930.52, unit: 'm²' }, expectFix: true },
    { label: 'G3-E 公厕内墙 全角括号→修', markdown: '公厕内墙2（面砖内墙面）18429.52m²。', authority: { name: '公厕内墙2(面砖内墙面)', value: 19930.52, unit: 'm²' }, expectFix: true },
    { label: 'G3-E 公厕内墙 去括号内容→不命中', markdown: '公厕内墙2、面砖18429.52m²。', authority: { name: '公厕内墙2(面砖内墙面)', value: 19930.52, unit: 'm²' }, expectFix: false },
    { label: 'G3-E 给排水附（配）件 原名→修', markdown: '给排水附（配）件18429.52m²。', authority: { name: '给排水附（配）件', value: 19930.52, unit: 'm²' }, expectFix: true },
    { label: 'G3-E 给排水附件 无「配」字→不命中', markdown: '给排水附件18429.52m²。', authority: { name: '给排水附（配）件', value: 19930.52, unit: 'm²' }, expectFix: false },
    { label: 'G3-E 给排水附配件 无「附」字→不命中', markdown: '给排水配件18429.52m²。', authority: { name: '给排水附（配）件', value: 19930.52, unit: 'm²' }, expectFix: false },
  ];
  it.each(rows)('$label', ({ markdown, authority, expectFix }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [authority]);
    if (expectFix) assertSingleFix(markdown, '18429.52', authority, result);
    else {
      expect(result.fixedCount).toBe(0);
      expect(result.markdown).toBe(markdown);
    }
  });
});

describe('G3-F 数值-单位间距谱系', () => {
  // 跨行形态（40\nm²）：窗口被换行截断，不修（防跨条目误抓——契约）
  const rows = ['40m²', '40 m²', '40  m²', '40\tm²'].map(spacing => ({
    label: caseName('G3-F 间距', { spacing: JSON.stringify(spacing) }),
    markdown: `${BASE.name}${spacing}。`,
  }));
  it.each(rows)('$label', ({ markdown }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [BASE]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain(String(BASE.value));
  });
  it('G3-F 跨行形态 40\nm²→换行截断不修', () => {
    const markdown = `${BASE.name}40\nm²。`;
    const result = fixQuantityAuthorityConflicts(markdown, [BASE]);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });
});

describe('G3-G 确定性随机组合采样（不变量断言）', () => {
  const names = ['级配碎石', '挖一般土方', '路床(槽)碾压检验', '水泥混凝土', '拆除路面', '塑料管', '塑料管铺设', '栽植色带'];
  const units = ['m²', '㎡', 'm³', 'm', '吨', '座'];
  const contexts = ['prose', 'proseList', 'proseListPrev', 'tableRow', 'headingH4', 'village', 'specPrefix', 'negation'];
  const rand = mulberry32(20260907);
  type Sample = { markdown: string; authority: Authority; ctx: string; textValue: number };
  const samples: Sample[] = seededSamples(20260907, 600, (): Sample => {
    const name = names[Math.floor(rand() * names.length)];
    const unit = units[Math.floor(rand() * units.length)];
    const authority: Authority = { name, value: Number((100 + rand() * 20000).toFixed(2)), unit };
    const textValue = Number((10 + rand() * 3000).toFixed(2));
    const ctx = contexts[Math.floor(rand() * contexts.length)];
    const markdown = contextTemplates(name, String(textValue), unit)[ctx];
    return { markdown, authority, ctx, textValue };
  });
  it.each(samples)('G3-G 随机采样 seed=20260907 idx=%#', (s) => {
    const result = fixQuantityAuthorityConflicts(s.markdown, [s.authority]);
    // 不变量 1：fixedCount ∈ {0,1}（单权威至多一处替换）
    expect(result.fixedCount).toBeLessThanOrEqual(1);
    // 不变量 2：若替换，权威值必然落点（替换前后唯一差异即数值被换成权威值）
    if (result.fixedCount === 1) expect(result.markdown).toContain(String(s.authority.value));
    // 不变量 3：若未替换，文本原样不动
    if (result.fixedCount === 0) expect(result.markdown).toBe(s.markdown);
    // 不变量 4：非目标语境前缀（村名/规格词/否定句）在数值之前的文本不被改动
    for (const key of ['village', 'specPrefix', 'negation'] as const) {
      if (s.ctx === key) {
        const tmpl = contextTemplates(s.authority.name, String(s.textValue), s.authority.unit)[key];
        const valuePos = tmpl.indexOf(String(s.textValue));
        const prefix = valuePos === -1 ? tmpl : tmpl.slice(0, valuePos);
        expect(result.markdown).toContain(prefix);
      }
    }
  });
});
