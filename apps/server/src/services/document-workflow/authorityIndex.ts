/**
 * V5 P1 · AuthorityIndex 单一权威索引：蓝图数据全量权威投影。
 *
 * 背景（体系根因）：原"权威"是 4 张互不同步的人工白名单——renderBlueprintDataText 手写行 /
 * CHAPTER_AUTHORITY_ANCHORS 章锚点卡 / blueprintPlanAuthorities 映射（机械仅 7 类、规格仅垫层）/
 * alignChapterContentToBlueprint 域锚点；外加数据层/渲染层多处物理截断。蓝图 data 增对象、白名单
 * 不跟进 → 漏对象是设计使然（挖掘机矛盾 1 vs 5 无修复通道即此断点）。
 *
 * 本模块把"权威"改为机制产物：
 * 1. 全量投影：按 BlueprintData 字段类型注册 transform（下表），遍历结构投影——凡进入蓝图 data 的
 *    多口径风险对象（数值/规格）自动成为权威条目，不存在"白名单外"的对象；
 * 2. 单一结构：检测（数值↔权威核查）、修复（定点替换）、渲染（权威参数库）、审计（无主数值）
 *    共用本索引；
 * 3. 覆盖契约：collectNumericLeaves ↔ 条目 paths 双向断言（authorityCoverageGaps）——
 *    蓝图新增数值字段未登记 transform 时契约测试直接失败，"漏对象"从人肉审计变为机制保证；
 * 4. F/D 分级：kind=fact 资料原文事实（原样引用）；kind=derived 系统确定性推导值
 *    （引用含依据、禁止重算/加总/平移）。
 */
import type { BlueprintData, BlueprintQuantity } from './integratedBlueprint';

export type AuthorityKind = 'fact' | 'derived';

/** 权威域：章域路由（渲染聚焦）、检测分组、审计分流共用 */
export type AuthorityDomain =
  | 'contract'
  | 'schedule'
  | 'labor'
  | 'equipment'
  | 'material'
  | 'quantity'
  | 'spec'
  | 'earthwork'
  | 'test'
  | 'redline';

export interface AuthorityEntry {
  /** 稳定 id（domain + label 去重）：检测/修复/审计跨模块引用 */
  id: string;
  kind: AuthorityKind;
  domain: AuthorityDomain;
  /** 人类可读标签（渲染行文案主锚） */
  label: string;
  /** 正文匹配锚点（名称/别名；消费端可做模糊/包含匹配） */
  anchors: string[];
  /** 型号/规格（清单特征原文；渲染行随条目输出，检测/匹配不消费） */
  spec?: string;
  /** 权威值（数值或规格文本） */
  value: number | string;
  unit: string;
  /** 来源（资料文件名/推导器标识） */
  source: string;
  /** 推导依据（D 类：写作层引用时一并呈现，修复/审计展示用） */
  trace?: string;
  /** 数量分村/分工程明细（清单聚合条目：合计数与分工程明细并存；分村多值合法性判定依据） */
  groups?: Array<{ group: string; value: number }>;
  /** 金额禁区（禁入正文；合同估算价/金额类红线事实） */
  amountRestricted?: boolean;
  /** 该条目覆盖的 BlueprintData 数值叶子路径（覆盖契约双向断言用） */
  paths: string[];
}

export interface AuthorityIndex {
  entries: AuthorityEntry[];
  byDomain: Map<AuthorityDomain, AuthorityEntry[]>;
}

// ── 机械通用同义词（匹配层增强：仅补充锚点，不影响是否入权威——入权威由全量投影保证）──
const EQUIPMENT_COMMON_ALIASES: Array<{ re: RegExp; alias: string }> = [
  { re: /挖掘机/u, alias: '挖机' },
  { re: /塔式起重机|塔吊/u, alias: '塔吊' },
  { re: /施工升降机|施工电梯/u, alias: '施工电梯' },
  { re: /汽车起重机|汽车吊|吊车/u, alias: '汽车吊' },
  { re: /装载机/u, alias: '铲车' },
  { re: /混凝土输送泵|地泵|泵车/u, alias: '地泵' },
  { re: /插入式振捣器|振捣棒/u, alias: '振捣棒' },
];

/** 区间口径单值收敛（中值）：写作/检测/修复只认单值，区间端点不泄漏 */
function midValue(min: number | undefined, max: number | undefined, fallback: number): number {
  if (min !== undefined && max !== undefined) return Math.round((min + max) / 2);
  if (max !== undefined) return max;
  if (min !== undefined) return min;
  return fallback;
}

/** 条目 id 去重（同 domain+label 追加序号） */
function assignIds(entries: AuthorityEntry[]): AuthorityEntry[] {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const base = `${entry.domain}:${entry.label}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    entry.id = count === 0 ? base : `${base}#${count + 1}`;
  }
  return entries;
}

type AuthorityTransform = (data: BlueprintData) => AuthorityEntry[];

// ── 逐字段类型 transform 注册（全量投影唯一入口；新增蓝图字段必须在此登记，否则覆盖契约测试失败）──

// 各 transform 对可选字段做缺失防御（`?? []`）：蓝图 JSON 落盘恢复/部分构造 fixture 的环境下
// 字段可能整体缺省——投影必须容忍缺省（缺省 = 无条目），不得抛错中断渲染/检测链

const contractTransform: AuthorityTransform = data => {
  const entries: AuthorityEntry[] = [];
  if (data.contract.totalDays > 0) {
    entries.push({
      id: '', kind: 'fact', domain: 'contract', label: '总工期',
      anchors: ['总工期', '合同工期', '施工工期', '工期'],
      value: data.contract.totalDays, unit: '日历天',
      source: '招标文件/合同条款', paths: ['contract.totalDays'],
    });
  }
  if (data.contract.estimatedAmount !== undefined && data.contract.estimatedAmount > 0) {
    entries.push({
      id: '', kind: 'fact', domain: 'contract', label: '合同估算价',
      anchors: ['合同估算价', '估算价', '工程造价'],
      value: data.contract.estimatedAmount, unit: '万元',
      source: '招标文件', amountRestricted: true, paths: ['contract.estimatedAmount'],
    });
  }
  return entries;
};

const scheduleTransform: AuthorityTransform = data => {
  const entries: AuthorityEntry[] = [];
  (data.milestones ?? []).forEach((milestone, index) => {
    if ((milestone.duration ?? 0) <= 0) return;
    entries.push({
      id: '', kind: 'derived', domain: 'schedule', label: `里程碑:${milestone.label}`,
      anchors: [milestone.label],
      value: milestone.duration ?? 0, unit: '天',
      source: '里程碑推导', trace: milestone.basis, paths: [`milestones[${index}].duration`],
    });
  });
  const milestoneSum = (data.milestones ?? []).reduce((sum, item) => sum + (item.duration ?? 0), 0);
  if (data.contract.totalDays > 0) {
    entries.push({
      id: '', kind: 'derived', domain: 'schedule', label: '机动工期',
      anchors: ['机动工期', '机动时间', '工期余量'],
      value: Math.max(0, data.contract.totalDays - milestoneSum), unit: '天',
      source: '工期推导', trace: `总工期 ${data.contract.totalDays} 天 − 里程碑合计 ${milestoneSum} 天`, paths: [],
    });
  }
  return entries;
};

const laborTransform: AuthorityTransform = data => {
  const labor = data.resources.labor;
  const entries: AuthorityEntry[] = [];
  if (labor.peakValue > 0) {
    entries.push({
      id: '', kind: 'derived', domain: 'labor', label: '劳动力峰值',
      anchors: ['劳动力峰值', '高峰人数', '峰值人数'],
      value: labor.peakValue, unit: '人',
      source: '劳动力推导', trace: labor.peakBasis,
      paths: ['resources.labor.peak.min', 'resources.labor.peak.max', 'resources.labor.peakValue'],
    });
  }
  (labor.byPhase ?? []).forEach((phase, index) => {
    if (phase.min === undefined && phase.max === undefined) return;
    entries.push({
      id: '', kind: 'derived', domain: 'labor', label: `阶段劳动力:${phase.phase}`,
      anchors: [phase.phase],
      value: midValue(phase.min, phase.max, 0), unit: '人',
      source: '劳动力推导', trace: phase.basis,
      paths: [`resources.labor.byPhase[${index}].min`, `resources.labor.byPhase[${index}].max`],
    });
  });
  (labor.byTrade ?? []).forEach((trade, index) => {
    if (trade.min === undefined && trade.max === undefined) return;
    entries.push({
      id: '', kind: 'derived', domain: 'labor', label: `工种区间:${trade.trade}`,
      anchors: [trade.trade],
      value: midValue(trade.min, trade.max, 0), unit: '人',
      source: '劳动力推导', trace: trade.basis,
      paths: [`resources.labor.byTrade[${index}].min`, `resources.labor.byTrade[${index}].max`],
    });
  });
  (labor.composition ?? []).forEach((trade, index) => {
    entries.push({
      id: '', kind: 'derived', domain: 'labor', label: `工种构成:${trade.trade}`,
      anchors: [trade.trade],
      value: trade.count, unit: '人',
      source: '劳动力推导', trace: trade.basis,
      paths: [`resources.labor.composition[${index}].count`],
    });
  });
  return entries;
};

const equipmentTransform: AuthorityTransform = data => {
  return (data.resources.equipment ?? []).map((item, index) => {
    const aliases = EQUIPMENT_COMMON_ALIASES.filter(rule => rule.re.test(item.name)).map(rule => rule.alias);
    return {
      id: '', kind: 'derived' as const, domain: 'equipment' as const, label: item.name,
      anchors: [item.name, ...aliases.filter(alias => alias !== item.name)],
      value: item.quantity ?? midValue(item.min, item.max, 1), unit: '台', spec: item.spec,
      source: '机械推导', trace: item.basis,
      paths: [`resources.equipment[${index}].quantity`, `resources.equipment[${index}].min`, `resources.equipment[${index}].max`],
    };
  });
};

const materialTransform: AuthorityTransform = data => {
  return (data.materialsPlan ?? []).map((item, index) => ({
    id: '', kind: 'fact' as const, domain: 'material' as const,
    label: item.spec ? `${item.name}（${item.spec}）` : item.name,
    anchors: [item.name],
    value: item.quantity ?? item.spec ?? item.name, unit: item.unit, spec: item.spec,
    source: '清单汇总', trace: item.basis,
    paths: [`materialsPlan[${index}].quantity`],
  }));
};

const quantityTransform: AuthorityTransform = data => {
  return Object.entries(data.quantities ?? {}).map(([name, quantity]) => ({
    id: '', kind: 'fact' as const, domain: 'quantity' as const, label: name,
    anchors: [name],
    value: quantity.value, unit: quantity.unit,
    source: quantity.sourceFile || '工程量清单',
    groups: quantity.groups?.length ? quantity.groups : undefined,
    paths: [
      `quantities.${name}.value`,
      ...(quantity.groups ?? []).map((_, index) => `quantities.${name}.groups[${index}].value`),
    ],
  }));
};

const specTransform: AuthorityTransform = data => {
  return Object.entries(data.specAuthorities ?? {}).map(([name, spec]) => ({
    id: '', kind: 'fact' as const, domain: 'spec' as const, label: `规格:${name}`,
    anchors: [name],
    value: spec, unit: '',
    source: '清单特征', paths: [],
  }));
};

const earthworkTransform: AuthorityTransform = data => {
  const entries: AuthorityEntry[] = [];
  const balance = data.earthworkBalance;
  if (!balance) return entries;
  const rows: Array<{ key: 'excavation' | 'backfill' | 'disposal'; label: string }> = [
    { key: 'excavation', label: '挖方' },
    { key: 'backfill', label: '填方' },
    { key: 'disposal', label: '弃方' },
  ];
  for (const row of rows) {
    const value = balance[row.key];
    if (value === undefined || value <= 0) continue;
    entries.push({
      id: '', kind: 'derived', domain: 'earthwork', label: `土方平衡:${row.label}`,
      anchors: [`土方${row.label}`, row.label],
      value, unit: 'm³',
      source: '土方平衡推导', trace: balance.basis, paths: [`earthworkBalance.${row.key}`],
    });
  }
  return entries;
};

const testPlanTransform: AuthorityTransform = data => {
  return (data.testPlan ?? []).map((item, index) => ({
    id: '', kind: 'derived' as const, domain: 'test' as const, label: `试验计划:${item.scope}`,
    anchors: [item.scope],
    value: item.count ?? item.scope, unit: item.count !== undefined ? '次' : '',
    source: '试验计划推导', trace: item.basis,
    paths: [`testPlan[${index}].count`],
  }));
};

const redLineTransform: AuthorityTransform = data => {
  const facts = data.redLineFacts ?? [];
  const entries: AuthorityEntry[] = facts.map(fact => ({
    id: '', kind: 'fact' as const, domain: 'redline' as const, label: fact.key,
    anchors: [fact.key],
    value: fact.value, unit: '',
    source: fact.source, amountRestricted: fact.amount, paths: [],
  }));
  const villageFact = facts.find(fact => fact.key === '自然村数量');
  const match = villageFact ? /(\d+)/u.exec(villageFact.value) : null;
  if (match) {
    entries.push({
      id: '', kind: 'fact', domain: 'redline', label: '自然村数量',
      anchors: ['自然村数量', '自然村'],
      value: Number(match[1]), unit: '个',
      source: villageFact?.source || '招标文件', paths: [],
    });
  }
  return entries;
};

/** transform 注册表（全量投影唯一入口） */
const AUTHORITY_TRANSFORMS: AuthorityTransform[] = [
  contractTransform,
  scheduleTransform,
  laborTransform,
  equipmentTransform,
  materialTransform,
  quantityTransform,
  specTransform,
  earthworkTransform,
  testPlanTransform,
  redLineTransform,
];

/** 全量权威投影：蓝图 data → 权威索引（单一权威源） */
export function buildAuthorityIndex(data: BlueprintData): AuthorityIndex {
  const entries = assignIds(AUTHORITY_TRANSFORMS.flatMap(transform => transform(data)));
  const byDomain = new Map<AuthorityDomain, AuthorityEntry[]>();
  for (const entry of entries) {
    const group = byDomain.get(entry.domain);
    if (group) group.push(entry);
    else byDomain.set(entry.domain, [entry]);
  }
  return { entries, byDomain };
}

// ── 覆盖契约：collectNumericLeaves ↔ 条目 paths 双向断言 ──

export interface NumericLeaf {
  path: string;
  value: number;
}

/** 遍历蓝图 data 收集全部数值叶子（路径形如 milestones[0].duration / quantities.挖沟槽土方.value） */
export function collectNumericLeaves(root: unknown, prefix = ''): NumericLeaf[] {
  const out: NumericLeaf[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'number') {
      out.push({ path, value: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(root, prefix);
  return out;
}

/** 覆盖豁免（仅限来源元数据类，非多口径对象；新增豁免必须注明理由） */
const AUTHORITY_EXEMPT_PATH_RES: RegExp[] = [
  // 清单条目来源序号：资料追踪元数据，不构成正文数值口径
  /^quantities\.[^.]+\.seq$/u,
];

/** 覆盖契约：返回未被权威条目覆盖、且不在豁免表的数值叶子路径（空数组 = 契约满足）。
 * 蓝图新增数值字段未登记 transform 时，本函数立即暴露缺口（契约测试断言其恒为空）。 */
export function authorityCoverageGaps(data: BlueprintData): string[] {
  const covered = new Set(buildAuthorityIndex(data).entries.flatMap(entry => entry.paths));
  return collectNumericLeaves(data)
    .map(leaf => leaf.path)
    .filter(path => !covered.has(path) && !AUTHORITY_EXEMPT_PATH_RES.some(re => re.test(path)));
}

// ── 渲染层（V5 P2 数据驱动渲染）：全局桶/章域卡/章切片共用一个引擎 ──
// 全量渲染、零 slice 物理截断（预算由章域路由聚焦控制）；DOMAIN_RENDERERS 为
// Record<AuthorityDomain, …> 类型锚点——新增 domain 未登记渲染器即编译失败，
// “数据有而桶无”由类型系统 + 渲染覆盖率测试双保险。

/** domain 渲染次序（全局桶/章域卡共用的稳定输出序） */
const AUTHORITY_DOMAIN_RENDER_ORDER: AuthorityDomain[] = ['contract', 'schedule', 'labor', 'equipment', 'material', 'quantity', 'spec', 'earthwork', 'test', 'redline'];

/** 标签前缀剥离（`阶段劳动力:主体施工` → `主体施工`；无前缀原样返回） */
function stripLabelPrefix(label: string, prefix: string): string {
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

const DOMAIN_RENDERERS: Record<AuthorityDomain, (entries: AuthorityEntry[]) => string[]> = {
  contract: entries => {
    const rows: string[] = [];
    const totalDays = entries.find(entry => entry.label === '总工期');
    if (totalDays) rows.push(`- 总工期：${totalDays.value} 日历天`);
    // 合同估算价（amountRestricted）不进正文口径行：金额类由 redline 金额行统一声明
    return rows;
  },
  schedule: entries => {
    const rows: string[] = [];
    const milestones = entries.filter(entry => entry.label.startsWith('里程碑:'));
    if (milestones.length > 0) rows.push(`- 里程碑（各节点用时，总和 ≤ 总工期）：${milestones.map(entry => `${stripLabelPrefix(entry.label, '里程碑:')} ${entry.value} 天`).join('、')}`);
    const buffer = entries.find(entry => entry.label === '机动工期');
    if (buffer) rows.push(`- 机动工期：${buffer.value} 天`);
    return rows;
  },
  labor: entries => {
    const rows: string[] = [];
    const peak = entries.find(entry => entry.label === '劳动力峰值');
    if (peak) rows.push(`- 劳动力峰值：${peak.value} 人（造价锚定口径唯一峰值，各章必须引用该值，不得自设其他峰值）`);
    const phases = entries.filter(entry => entry.label.startsWith('阶段劳动力:'));
    if (phases.length > 0) rows.push(`- 分阶段劳动力投入（各阶段同时在场人数，分阶段计划表数据源）：${phases.map(entry => `${stripLabelPrefix(entry.label, '阶段劳动力:')} ${entry.value} 人`).join('、')}`);
    const trades = entries.filter(entry => entry.label.startsWith('工种区间:'));
    if (trades.length > 0) rows.push(`- 工种区间（区间中值参考，不得作为工种表口径，不得自设）：${trades.map(entry => `${stripLabelPrefix(entry.label, '工种区间:')} ${entry.value} 人`).join('、')}`);
    const composition = entries.filter(entry => entry.label.startsWith('工种构成:'));
    if (composition.length > 0) rows.push(`- 工种构成（合计=${peak?.value ?? 0} 人，写作层工种表唯一数据源，不得自设构成）：${composition.map(entry => `${stripLabelPrefix(entry.label, '工种构成:')} ${entry.value} 人`).join('、')}`);
    return rows;
  },
  equipment: entries => {
    if (entries.length === 0) return [];
    return [`- 主要机械（台数唯一口径，不得自设）：${entries.map(entry => `${entry.label}${entry.spec ? `（${entry.spec}）` : ''} ${entry.value} 台`).join('、')}`];
  },
  material: entries => {
    if (entries.length === 0) return [];
    const rows = [`- 物资计划·主要材料（清单汇总，名称、型号规格、数量必须与此一致；清单明确给出的规格是事实数据，未列材料不得自编型号规格）：${entries.map(entry => `${entry.label} ${entry.value}${entry.unit}`).join('、')}`];
    // 同名多规格拆分逐项列（丰乐镇十四版：118 套被 LLM 自行分配为 111+7；逐项照抄硬约束）
    const byName = new Map<string, AuthorityEntry[]>();
    for (const entry of entries) {
      const name = entry.anchors[0] ?? entry.label;
      const group = byName.get(name);
      if (group) group.push(entry);
      else byName.set(name, [entry]);
    }
    for (const [name, items] of byName) {
      if (items.length < 2) continue;
      const total = items.reduce((sum, item) => sum + (typeof item.value === 'number' ? item.value : 0), 0);
      rows.push(`- ${name}规格-数量拆分（逐项照抄，不得自行分配/改动）：${items.map(item => `${item.spec || '未标规格'} ${item.value}${item.unit}`).join(' + ')}（合计 ${Math.round(total * 1000) / 1000}${items[0]?.unit ?? ''}）`);
    }
    return rows;
  },
  quantity: entries => {
    if (entries.length === 0) return [];
    return [`- 工程量清单（合计口径；分村/分工程明细为合法多值）：${entries.map(entry => {
      const base = `${entry.label} ${entry.value}${entry.unit}`;
      const detail = entry.groups?.length ? `（分工程：${entry.groups.map(group => `${group.group} ${group.value}`).join('、')}）` : '';
      return base + detail;
    }).join('、')}`];
  },
  spec: entries => {
    if (entries.length === 0) return [];
    return [`- 规格权威（清单特征原文，必须原样引用，不得自编）：${entries.map(entry => `${stripLabelPrefix(entry.label, '规格:')}=${entry.value}`).join('、')}`];
  },
  earthwork: entries => {
    if (entries.length === 0) return [];
    return [`- 土方平衡（清单汇总口径）：${entries.map(entry => `${stripLabelPrefix(entry.label, '土方平衡:')} ${entry.value}${entry.unit}`).join('、')}`];
  },
  test: entries => {
    if (entries.length === 0) return [];
    return [`- 试验计划（推导口径，不得自设）：${entries.map(entry => `${stripLabelPrefix(entry.label, '试验计划:')} ${entry.value}${entry.unit}`).join('、')}`];
  },
  redline: entries => {
    // 同 label 去重保首条（红线事实与“自然村数量”派生条目并存时只留事实原文）
    const seen = new Set<string>();
    const deduped = entries.filter(entry => {
      if (seen.has(entry.label)) return false;
      seen.add(entry.label);
      return true;
    });
    const rows: string[] = [];
    const nonAmount = deduped.filter(entry => !entry.amountRestricted);
    const amounts = deduped.filter(entry => entry.amountRestricted);
    if (nonAmount.length > 0) rows.push(`- 评审红线事实（must_cite，正文必须逐条出现且数值一致）：${nonAmount.map(entry => `${entry.label}=${entry.value}`).join('；')}`);
    if (amounts.length > 0) rows.push(`- 金额类红线事实（商务禁区，不进正文）：${amounts.map(entry => `${entry.label}=${entry.value}`).join('；')}`);
    return rows;
  },
};

/** V5 P2 通用渲染器：按 domain 渲染权威条目（全量、无 slice 截断）。domains 缺省渲染
 * 全部 domain；行文案单一来源，全局桶/章域卡/章切片共用。 */
export function renderAuthorityDomains(index: AuthorityIndex, domains?: AuthorityDomain[]): string[] {
  const order = domains && domains.length > 0 ? AUTHORITY_DOMAIN_RENDER_ORDER.filter(domain => domains.includes(domain)) : AUTHORITY_DOMAIN_RENDER_ORDER;
  const rows: string[] = [];
  for (const domain of order) {
    rows.push(...DOMAIN_RENDERERS[domain](index.byDomain.get(domain) ?? []));
  }
  return rows;
}

/** 权威条目按域过滤（章域路由/审计分流共用） */
export function entriesByDomains(index: AuthorityIndex, domains: AuthorityDomain[]): AuthorityEntry[] {
  return index.entries.filter(entry => domains.includes(entry.domain));
}

/** 数量分组明细辅助：分村多值合法性判定（值 ∈ 分组值 ∪ 合计 → 合法分层口径） */
export function quantityValueIsLegal(entry: AuthorityEntry, value: number): boolean {
  if (typeof entry.value === 'number' && Math.abs(entry.value - value) < 1e-6) return true;
  return (entry.groups ?? []).some(group => Math.abs(group.value - value) < 1e-6);
}

/** 劳动力峰值单值 getter（检测器/注册表/终检等单点消费：同一权威投影口径，防各消费点私取蓝图字段） */
export function blueprintLaborPeakAuthority(data?: BlueprintData): number | undefined {
  if (!data) return undefined;
  const entry = (buildAuthorityIndex(data).byDomain.get('labor') ?? []).find(item => item.label === '劳动力峰值');
  return entry && typeof entry.value === 'number' && entry.value > 0 ? entry.value : undefined;
}

/** 数量分工程明细权威（V5 P4b 跨工程同值复制检测专用）：只取携带 ≥2 组分工程/分村明细的
 *  条目（单组/无组条目无「跨工程」判定面）；消费点（globalQualityGates / documentFinalValidation）
 *  与检测器输入同源，防各点私拼明细结构。 */
export interface QuantityGroupAuthority {
  name: string;
  value: number;
  unit: string;
  groups?: Array<{ group: string; value: number }>;
}

export function blueprintQuantityGroupAuthorities(data?: BlueprintData): QuantityGroupAuthority[] {
  if (!data) return [];
  return (buildAuthorityIndex(data).byDomain.get('quantity') ?? [])
    .filter(entry => typeof entry.value === 'number' && (entry.groups?.length ?? 0) >= 2)
    .map(entry => ({ name: entry.label, value: entry.value as number, unit: entry.unit, groups: entry.groups }));
}

/** 阶段劳动力权威（V5 P4b 阶段人数混用检测专用）：labor 域的「阶段劳动力:X」投影条目
 *  （byPhase 推导值，midValue 收敛），phase 去标签前缀还原阶段名。 */
export interface PhaseLaborAuthority {
  phase: string;
  value: number;
  trace?: string;
}

export function blueprintPhaseLaborAuthorities(data?: BlueprintData): PhaseLaborAuthority[] {
  if (!data) return [];
  const prefix = '阶段劳动力:';
  return (buildAuthorityIndex(data).byDomain.get('labor') ?? [])
    .filter(entry => entry.label.startsWith(prefix) && typeof entry.value === 'number' && entry.value > 0)
    .map(entry => ({ phase: entry.label.slice(prefix.length), value: entry.value as number, trace: entry.trace }));
}

/** 类型导出：消费端（检测/修复/审计）引用 */
export type { BlueprintQuantity };
