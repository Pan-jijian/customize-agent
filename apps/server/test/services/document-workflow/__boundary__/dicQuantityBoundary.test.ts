/**
 * fixQuantityAuthorityConflicts 判定层锚点直连边界矩阵（S5：豁免全废，只做坐标替换）
 * 分层采样设计（每条用例独立断言）：
 *  A 数值格式 × 单位全组合（锚点切片解析 → 权威值替换）
 *  B 差异率谱系（无阈值：非零差异全部替换；值 == 权威不入候选由采集层保证）
 *  C 零豁免矩阵（村名/规格/表格行/句级语境：锚点直连照替换）
 *  D 多锚点与列举边界（只改锚点坐标，其余文本不动）
 *  E 名称形态无关（括号三态/长名短名/名称含编号；名称仅作修复说明）
 *  F 数值-单位间距谱系与跨行形态（数值 span 替换）
 *  G 确定性随机组合采样（不变量断言）
 */
import { describe, expect, it } from 'vitest';
import { fixQuantityAuthorityConflicts } from '@/services/document-workflow/documentIntegrityChecks';
import type { QuantityConflictAnchor } from '@/services/document-workflow/integratedBlueprint';
import {
  LIST_SEPARATORS, NUMERIC_FORMATS, SPEC_WORDS, VILLAGE_WORDS, VILLAGE_WORDS_REMOVED,
  caseName, contextTemplates, mulberry32, seededSamples,
} from './boundaryKit';

type Authority = { name: string; value: number; unit: string };
const BASE: Authority = { name: '级配碎石', value: 20931.02, unit: 'm²' };

/** 锚点构造：在正文中定位原文数值串（生产由判定层裁决产出；值 == 权威不入候选） */
function anchorAt(markdown: string, name: string, raw: string, authorityValue: number, unit: string): QuantityConflictAnchor {
  const start = markdown.indexOf(raw);
  return { name, value: Number(raw.replace(/,/gu, '')), unit, authorityValue, start, end: start + raw.length };
}

/** 单锚点修复断言：结果 == 原文把锚点切片换成权威值 */
function assertSingleFix(markdown: string, raw: string, authority: Authority, result: { markdown: string; fixedCount: number }) {
  expect(result.fixedCount).toBe(1);
  expect(result.markdown).toBe(markdown.replace(raw, String(authority.value)));
}

describe('G3-A 数值格式×单位全组合（锚点切片解析→替换）', () => {
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
  const rows = (NUMERIC_FORMATS as readonly string[]).filter(format => format !== '1e3').flatMap(format => unitVariants.map(([unitLabel, authority]) => ({
    label: caseName('G3-A 数值格式', { fmt: format, unit: unitLabel }),
    markdown: `${authority.name}${format}${unitLabel}。`,
    authority,
    raw: format,
  })));
  it.each(rows)('$label', ({ markdown, authority, raw }) => {
    // 单位只影响锚点摘要文案，不影响坐标替换（单位变体互配归采集层结构定位）
    assertSingleFix(markdown, raw, authority, fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, authority.name, raw, authority.value, authority.unit)]));
  });
  it('G3-A 科学计数法锚点：切片 1e3 解析为 1000 → 替换（采集层正则不产出该形态，锁定解析器行为）', () => {
    const markdown = `${BASE.name}1e3${BASE.unit}。`;
    const at = markdown.indexOf('1e3');
    const anchor: QuantityConflictAnchor = { name: BASE.name, value: 1000, unit: BASE.unit, authorityValue: BASE.value, start: at, end: at + 3 };
    assertSingleFix(markdown, '1e3', BASE, fixQuantityAuthorityConflicts(markdown, [anchor]));
  });
});

describe('G3-B 差异率谱系（无阈值）', () => {
  const cases: Array<{ pct: number }> = [
    { pct: 0 }, { pct: 1 }, { pct: 2 }, { pct: 2.1 }, { pct: 3 }, { pct: 10 },
    { pct: 30 }, { pct: 50 }, { pct: 70 }, { pct: 90 }, { pct: 99 },
  ];
  it.each(cases)('G3-B 差异率 $pct%', ({ pct }) => {
    const value = Number((BASE.value * (1 - pct / 100)).toFixed(2));
    const markdown = `${BASE.name}${value}${BASE.unit}。`;
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, BASE.name, String(value), BASE.value, BASE.unit)]);
    // pct=0（值 == 权威）行：采集层不入候选，此处锁定替换器幂等（替换为同值文本不变）
    assertSingleFix(markdown, String(value), BASE, result);
  });
});

describe('G3-C1 村名语境零豁免（裁决在判定层，修复层照替换）', () => {
  it.each([...VILLAGE_WORDS])('G3-C1 窗口词“%s”照替换', (word) => {
    const markdown = `马老${word}村${BASE.name}40${BASE.unit}。`;
    assertSingleFix(markdown, '40', BASE, fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, BASE.name, '40', BASE.value, BASE.unit)]));
  });
  it.each([...VILLAGE_WORDS_REMOVED])('G3-C1 收紧剔除词“%s”照替换', (word) => {
    const markdown = `马老${word}村${BASE.name}40${BASE.unit}。`;
    assertSingleFix(markdown, '40', BASE, fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, BASE.name, '40', BASE.value, BASE.unit)]));
  });
  it.each([...VILLAGE_WORDS])('G3-C1 段落村名语境“%s”照替换', (word) => {
    // 村名列表远离条目名的段落形态：判定层裁决，修复层无段落级词表豁免
    const markdown = `殷${word}组、五星等自然村组，主要作业内容为整体化粪池安装、${BASE.name}铺设及配套土方开挖回填。本分项工程量为：砌筑检查井2座；${BASE.name}40${BASE.unit}；回填方42.12m³。`;
    assertSingleFix(markdown, '40', BASE, fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, BASE.name, '40', BASE.value, BASE.unit)]));
  });
});

describe('G3-C2 表格行零豁免（表内锚点由采集层掩码排除）', () => {
  const rows = [
    { label: 'G3-C2 表格段内条目', markdown: `| 方岗段 | 道路、铺装 | 路床碾压1436.4m²、${BASE.name}359.1${BASE.unit} | 土方班组1个 |`, raw: '359.1' },
    { label: 'G3-C2 表格行单元', markdown: `| 分部 | ${BASE.name} | ${BASE.unit} | 480.5 | 备注 |`, raw: '480.5' },
    { label: 'G3-C2 紧凑表格行', markdown: `|${BASE.name}|${BASE.unit}|480.5|`, raw: '480.5' },
    { label: 'G3-C2 多行表格', markdown: `| 面坊郢段 | 管网 | 直径450塑料检查井40座 | 管道班组1个 |\n| 分部 | ${BASE.name} | ${BASE.unit} | 480.5 |`, raw: '480.5' },
  ];
  it.each(rows)('$label', ({ markdown, raw }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, BASE.name, raw, BASE.value, BASE.unit)]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain(String(BASE.value));
  });
});

describe('G3-C3 规格限定词零豁免（前/后置）', () => {
  const rows = (SPEC_WORDS as readonly string[]).flatMap(spec => (['前置', '后置'] as const).map(pos => ({
    label: caseName('G3-C3 规格零豁免', { spec, pos }),
    markdown: pos === '前置' ? `${spec}${BASE.name}40${BASE.unit}。` : `${BASE.name}${spec}铺设40${BASE.unit}。`,
  })));
  it.each(rows)('$label', ({ markdown }) => {
    assertSingleFix(markdown, '40', BASE, fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, BASE.name, '40', BASE.value, BASE.unit)]));
  });
});

describe('G3-C5 句级语境零豁免（锚点直连，不整句豁免）', () => {
  const peer = { name: '水泥混凝土', value: 20872.82, unit: 'm²' };
  const rows = [
    { label: '2大0小', markdown: `景观工程主要工程量包括${BASE.name}480.5${BASE.unit}、${peer.name}572.3${peer.unit}。`, raw: '480.5' },
    { label: '3大1小', markdown: `景观工程主要工程量包括${BASE.name}480.5${BASE.unit}、${peer.name}572.3${peer.unit}、挖一般土方146.93m³、仿木护栏333m。`, raw: '480.5' },
    { label: '单条目', markdown: `${BASE.name}40${BASE.unit}。`, raw: '40' },
    { label: '1大2小', markdown: `主要工程量包括${BASE.name}40${BASE.unit}、${peer.name}22960.1${peer.unit}、仿木护栏366.3m。`, raw: '40' },
    { label: '2大2小', markdown: `主要工程量包括${BASE.name}40${BASE.unit}、${peer.name}572.3${peer.unit}、挖一般土方4606.12m³、仿木护栏366.3m。`, raw: '40' },
    { label: '3大4小（2.1 道路段形态）', markdown: `道路工程主要工程量包括挖一般土方4040.45m³、${BASE.name}18949.52${BASE.unit}，以及拆除路面633m²、余方弃置158.25m³。`, raw: '18949.52' },
  ];
  it.each(rows)('G3-C5 句级语境零豁免 $label', ({ markdown, raw }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, BASE.name, raw, BASE.value, BASE.unit)]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain(String(BASE.value));
  });
});

describe('G3-D 多锚点与列举边界（只改锚点坐标）', () => {
  const rows = (LIST_SEPARATORS as readonly string[]).flatMap(sep => ([4, 12, 24, 60] as const).map(gap => {
    const filler = 'x'.repeat(Math.max(0, gap - 2));
    return {
      label: caseName('G3-D 列举', { sep: JSON.stringify(sep), gap: String(gap) }),
      markdown: `${BASE.name}40${BASE.unit}${sep}${filler}其他条目${BASE.value}${BASE.unit}。`,
    };
  }));
  it.each(rows)('$label', ({ markdown }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, BASE.name, '40', BASE.value, BASE.unit)]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain(`${BASE.name}${BASE.value}${BASE.unit}`);
    // 列举中的其他条目数值不在锚点内 → 原样保留（无窗口启发，只认坐标）
    expect(result.markdown).toContain(`其他条目${BASE.value}${BASE.unit}`);
  });
  it('G3-D 双锚点同句各自替换（坐标互不干扰）', () => {
    const md = `主要工程量包括${BASE.name}40${BASE.unit}、其他条目10m。`;
    const result = fixQuantityAuthorityConflicts(md, [
      anchorAt(md, BASE.name, '40', BASE.value, BASE.unit),
      anchorAt(md, '其他条目', '10', 250, 'm'),
    ]);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toBe(`主要工程量包括${BASE.name}${BASE.value}${BASE.unit}、其他条目250m。`);
  });
});

describe('G3-E 名称形态无关（括号三态/名称含编号；名称仅作修复说明）', () => {
  const rows: Array<{ label: string; markdown: string; name: string }> = [
    { label: 'G3-E 路床 半角括号', markdown: '路床(槽)碾压检验18429.52m²。', name: '路床(槽)碾压检验' },
    { label: 'G3-E 路床 全角括号', markdown: '路床（槽）碾压检验18429.52m²。', name: '路床(槽)碾压检验' },
    { label: 'G3-E 路床 无槽字（名称不重匹配）', markdown: '路床碾压检验18429.52m²。', name: '路床(槽)碾压检验' },
    { label: 'G3-E 生态池 全角闭括号', markdown: '1#生态池（2T/D）18429.52m²。', name: '1#生态池（2T/D)' },
    { label: 'G3-E 生态池 去括号内容', markdown: '1#生态池18429.52m²。', name: '1#生态池（2T/D)' },
    { label: 'G3-E 栽植色带 半角括号', markdown: '栽植色带(生态池外围一圈)18429.52m²。', name: '栽植色带（生态池外围一圈）' },
    { label: 'G3-E 栽植色带 去括号内容', markdown: '栽植色带18429.52m²。', name: '栽植色带（生态池外围一圈）' },
    { label: 'G3-E 给排水附（配）件 原名', markdown: '给排水附（配）件18429.52m²。', name: '给排水附（配）件' },
    { label: 'G3-E 给排水附件 无「配」字', markdown: '给排水附件18429.52m²。', name: '给排水附（配）件' },
  ];
  it.each(rows)('$label', ({ markdown, name }) => {
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, name, '18429.52', 19930.52, 'm²')]);
    assertSingleFix(markdown, '18429.52', { name, value: 19930.52, unit: 'm²' }, result);
  });
});

describe('G3-F 数值-单位间距谱系与跨行形态（数值 span 替换）', () => {
  const rows = ['40m²', '40 m²', '40  m²', '40\tm²', '40\nm²'].map(spacing => ({
    label: caseName('G3-F 间距', { spacing: JSON.stringify(spacing) }),
    markdown: `${BASE.name}${spacing}。`,
  }));
  it.each(rows)('$label', ({ markdown }) => {
    // 跨行/间距形态属采集层窗口契约；修复层只替换锚点数值 span（单位与间隔原样保留）
    const result = fixQuantityAuthorityConflicts(markdown, [anchorAt(markdown, BASE.name, '40', BASE.value, BASE.unit)]);
    assertSingleFix(markdown, '40', BASE, result);
  });
});

describe('G3-G 确定性随机组合采样（锚点直连不变量）', () => {
  const names = ['级配碎石', '挖一般土方', '路床(槽)碾压检验', '水泥混凝土', '拆除路面', '塑料管', '塑料管铺设', '栽植色带'];
  const units = ['m²', '㎡', 'm³', 'm', '吨', '座'];
  const contexts = ['prose', 'proseList', 'proseListPrev', 'tableRow', 'tableRowPrevUnit', 'headingH4', 'headingH3', 'boldLead', 'village', 'specPrefix', 'specSuffix', 'negation'];
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
    const raw = String(s.textValue);
    const result = fixQuantityAuthorityConflicts(s.markdown, [anchorAt(s.markdown, s.authority.name, raw, s.authority.value, s.authority.unit)]);
    // 不变量 1：单锚点至多一处替换
    expect(result.fixedCount).toBeLessThanOrEqual(1);
    // 不变量 2：替换落点唯一且精确（替换前后唯一差异即锚点切片被换成权威值）
    if (result.fixedCount === 1) expect(result.markdown).toBe(s.markdown.replace(raw, String(s.authority.value)));
    // 不变量 3：若未替换（坐标失配形态）文本原样不动
    if (result.fixedCount === 0) expect(result.markdown).toBe(s.markdown);
  });
});
