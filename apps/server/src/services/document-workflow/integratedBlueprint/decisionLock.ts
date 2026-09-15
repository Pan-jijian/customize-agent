/**
 * 决策锁确定性提取（类别表/提及收集/裁定入口/核心工程量）——原 decisionLock.ts 三期收口迁入
 *
 * S6 零行为拆分自 integratedBlueprint.ts（门面 re-export，对外导出不变）：仅机械搬迁，未改动任何语句与常量。
 */
import { cleanPdfHeadingNoise } from '../factsModel';
import { stringifyFactValue } from '../utils';
import type { BillOfQuantitiesResult, BoqEntry } from '../billOfQuantitiesParser';
import type { DocumentEvidence, DocumentFact } from '../types';
import type { BlueprintContract, BlueprintDecisionLock, BlueprintLabor, DecisionCategoryMeta, DecisionLockEntry } from './types';

// ═══════════════════════════════ 决策锁确定性提取（三期收口：原 decisionLock.ts 移入蓝图模块内部） ═══════════════════════════════
// 工艺路线/机械选型/材料供应这类"实体-选择"从 factsModel + 证据确定性提取封闭类目
// "项目关键决策表"：类目取值必须有证据支撑（否定句不计分），多源取值按来源权威度裁决
// （补疑/澄清 > 招标文件 > 清单/图纸 > 规范 > 其他，与 scopeConflicts 源级裁决口径同源），
// 同目多值共存（塔吊+施工电梯同属垂直运输）时全部锁定。

/** 封闭决策类目表：垂直运输/模板体系/混凝土供应/脚手架/基坑支护/土方外运 */
const DECISION_CATEGORIES: DecisionCategoryMeta[] = [
  {
    id: 'vertical_transport',
    label: '垂直运输方式',
    relevance: /塔吊|塔式起重机|施工电梯|施工升降机|物料提升机|垂直运输/u,
    options: [
      { value: '塔式起重机', aliases: /塔吊|塔式起重机/ },
      { value: '施工升降机', aliases: /施工电梯|施工升降机/ },
      { value: '物料提升机', aliases: /物料提升机/ },
      { value: '汽车式起重机', aliases: /汽车吊|汽车式起重机/ },
    ],
  },
  {
    id: 'formwork',
    label: '模板体系',
    relevance: /模板/u,
    exclusive: true,
    options: [
      { value: '木胶合板模板', aliases: /木胶合板|覆膜胶合板|胶合板模板|木模板/ },
      { value: '钢模板', aliases: /钢模板|定型钢模/ },
      { value: '铝合金模板', aliases: /铝合金模板|铝模/ },
      { value: '大模板', aliases: /大模板/ },
      { value: '爬升模板', aliases: /爬升模板|爬模/ },
    ],
  },
  {
    id: 'concrete_supply',
    label: '混凝土供应',
    relevance: /混凝土/u,
    exclusive: true,
    options: [
      { value: '商品混凝土（预拌）', aliases: /商品混凝土|预拌混凝土/ },
      { value: '自拌混凝土', aliases: /自拌混凝土|现场拌制混凝土|现场搅拌混凝土/ },
    ],
  },
  {
    id: 'scaffold',
    label: '脚手架体系',
    relevance: /脚手架|爬架/u,
    options: [
      { value: '落地式钢管脚手架', aliases: /落地式[^，。；;]{0,6}脚手架|落地脚手架/ },
      { value: '悬挑式脚手架', aliases: /悬挑[^，。；;]{0,6}脚手架|悬挑脚手架/ },
      { value: '附着式升降脚手架', aliases: /附着式升降脚手架|爬架/ },
      { value: '门式脚手架', aliases: /门式脚手架/ },
      { value: '盘扣式脚手架', aliases: /盘扣/ },
      { value: '碗扣式脚手架', aliases: /碗扣/ },
    ],
  },
  {
    id: 'foundation_support',
    label: '基坑支护形式',
    relevance: /基坑|支护/u,
    exclusive: true,
    options: [
      { value: '放坡开挖', aliases: /放坡/ },
      { value: '土钉墙支护', aliases: /土钉墙|土钉支护/ },
      { value: '灌注桩支护', aliases: /灌注桩|钻孔灌注桩|排桩支护/ },
      { value: '钢板桩支护', aliases: /钢板桩|拉森桩/ },
      { value: '地下连续墙', aliases: /地下连续墙|地连墙/ },
      { value: '锚杆（索）支护', aliases: /锚杆|锚索/ },
      { value: '喷锚支护', aliases: /喷锚/ },
    ],
  },
  {
    id: 'earthwork_haul',
    label: '土方外运方式',
    relevance: /土方|渣土|弃土/u,
    options: [
      { value: '自卸汽车外运', aliases: /自卸汽车|自卸车/ },
      { value: '密闭渣土车外运', aliases: /密闭式?[^，。；;]{0,4}车|渣土车/ },
      { value: '场内平衡利用', aliases: /场内平衡|就地平衡|场内调配|回填利用/ },
    ],
  },
  // ── 4.36 D1 扩围（远端 4.35.0 报错实锤：两可表述/规格错位产生源=设计决策类目缺锁）──
  // 从「实体-选择」类目扩展覆盖设计决策类：基础形式/设备减振方式/浇筑组织/路面结构类型；
  // 不设互斥位（个别多单体工程多形式并存属真实多样，锁允许多值共存），
  // 两可场景裁决由 D3「决策项语法模式」消费：有锁归一侧、无锁转显式决策缺口
  {
    id: 'foundation_form',
    label: '基础形式',
    relevance: /基础/u,
    options: [
      { value: '独立基础', aliases: /独立基础/ },
      { value: '条形基础', aliases: /条形基础|带形基础/ },
      { value: '筏板基础', aliases: /筏板基础|筏形基础|满堂基础/ },
      { value: '桩基础', aliases: /桩基础|桩基/u },
      { value: '箱形基础', aliases: /箱形基础|箱型基础/ },
    ],
  },
  {
    id: 'vibration_isolation',
    label: '设备减振方式',
    relevance: /减振|隔振|减震|振动/u,
    options: [
      { value: '减振吊架', aliases: /减振吊架|隔振吊架|减震吊架|弹性吊架/ },
      { value: '减振基础', aliases: /减振基础|隔振基础|减震基础|惯性基础/ },
      { value: '橡胶隔振垫', aliases: /橡胶隔振垫|橡胶减振垫|隔振垫/ },
      { value: '弹簧减振器', aliases: /弹簧减振器|弹簧隔振器|阻尼弹簧减振器/ },
    ],
  },
  {
    id: 'concrete_pouring',
    label: '混凝土浇筑连续组织',
    relevance: /浇筑/u,
    options: [
      // 「同步」类弱形态（「同步或分段浇筑」）进 weakAliases：定位锚定用，不进计分（防「同步」裸词混入锁分）
      { value: '连续浇筑', aliases: /连续浇筑|一次浇筑|整体浇筑/, weakAliases: /同步浇筑|同步施工|同步/u },
      { value: '分段浇筑', aliases: /分段浇筑|分仓浇筑|跳仓浇筑|分区浇筑/ },
    ],
  },
  {
    id: 'pavement_structure',
    label: '路面结构类型',
    relevance: /路面|基层|面层|沥青|水泥稳定/u,
    // 非互斥（4.36 复查修正）：面层沥青+基层半刚性为道路工程合法组合，exclusive 单值锁会把锁外
    // 「半刚性」判为语义矛盾误报 blocker（semanticChoiceConflicts → LLM 修复轮误改真实内容）；
    // 多值共存锁定，与批次注释口径一致
    options: [
      // 裸「柔性」进 weakAliases（强别名族仅路面/面层复合词）：「柔性接口/柔性连接」等非路面语境
      // 不得归入本类目（matchDecisionCategory 双侧覆盖规则下弱形态须有对侧强命中背书）
      { value: '柔性路面', aliases: /沥青混凝土路面|沥青混凝土面层|沥青路面|沥青面层/, weakAliases: /柔性/u },
      { value: '半刚性路面', aliases: /半刚性/u },
      { value: '刚性路面', aliases: /刚性路面|水泥混凝土路面|水泥混凝土面层/ },
    ],
  },
];

/** 否定子句：含选项别名但处于否定语境的提及不计分（"不采用自拌混凝土"不构成自拌的证据支撑） */
const DECISION_NEGATION_RE = /不采用|不使用|不设置|不考虑|不得|禁止|取消/u;

/** 来源权威度（与 scopeConflicts 源级裁决口径同源：补疑/澄清修正文件权威最高） */
function decisionSourceWeight(item: DocumentEvidence) {
  const tag = `${item.filePath || ''} ${item.roleId || ''} ${item.sectionTitle || ''}`;
  if (/补疑|澄清|答疑|修正|更新/u.test(tag)) return 100;
  if (/招标文件|招标公告|投标人须知|前附表/u.test(tag)) return 90;
  if (/清单|工程量/u.test(tag)) return 80;
  if (/图纸|设计|dwg|drawing/iu.test(tag)) return 80;
  if (/规范|标准|规程/u.test(tag)) return 60;
  return 50;
}

interface DecisionMention {
  text: string;
  weight: number;
}

/** 证据句切分 + 事实行合成候选提及（事实已经 1.1 净化门处理，按置信度折算权重） */
function collectDecisionMentions(facts: DocumentFact[], evidence: DocumentEvidence[]): DecisionMention[] {
  const mentions: DecisionMention[] = [];
  for (const item of evidence) {
    const weight = decisionSourceWeight(item);
    const content = cleanPdfHeadingNoise(stringifyFactValue(item.content));
    for (const sentence of content.split(/[。；;\n]/u)) {
      const text = sentence.trim();
      if (text.length < 6 || text.length > 200) continue;
      mentions.push({ text, weight });
    }
  }
  for (const fact of facts) {
    const text = `${fact.key || ''} ${fact.fieldName || ''} ${stringifyFactValue(fact.value)}`.trim();
    if (text.length < 6 || text.length > 200) continue;
    mentions.push({ text, weight: Math.round(Math.max(0.5, Math.min(1, fact.confidence || 0.7)) * 60) });
  }
  return mentions;
}

/** 子句级否定判定：选项别名所在子句含否定词时该提及不计分 */
function mentionClauses(text: string) {
  return text.split(/[，,、：:]/u).map(clause => clause.trim()).filter(Boolean);
}

/**
 * 确定性提取项目关键决策表。
 * 计分：选项在类目相关句中出现即累计来源权重分；入选门槛 = 至少一条权威来源提及（bestWeight ≥60）；
 * 多值共存 = 得分 ≥ max(60, 类目最高分 × 0.4) 的选项全部锁定（≤3 个，按得分降序、同分按值名排序保逐字节一致）。
 */
export function extractDecisionLockEntries(input: { facts: DocumentFact[]; evidence: DocumentEvidence[] }): DecisionLockEntry[] {
  const mentions = collectDecisionMentions(input.facts, input.evidence);
  const entries: DecisionLockEntry[] = [];
  for (const category of DECISION_CATEGORIES) {
    const scores = new Map<string, { score: number; mentions: number; bestWeight: number }>();
    for (const mention of mentions) {
      if (!category.relevance.test(mention.text)) continue;
      const clauses = mentionClauses(mention.text);
      for (const option of category.options) {
        const hitClause = clauses.find(clause => option.aliases.test(clause));
        if (!hitClause || DECISION_NEGATION_RE.test(hitClause)) continue;
        const slot = scores.get(option.value) || { score: 0, mentions: 0, bestWeight: 0 };
        slot.score += mention.weight;
        slot.mentions += 1;
        slot.bestWeight = Math.max(slot.bestWeight, mention.weight);
        scores.set(option.value, slot);
      }
    }
    const ranked = [...scores.entries()]
      .map(([value, stat]) => ({ value, ...stat }))
      .sort((a, b) => b.score - a.score || b.mentions - a.mentions || (a.value < b.value ? -1 : 1));
    const top = ranked[0];
    if (!top || top.bestWeight < 60) continue;
    // 互斥类目唯一化：模板/混凝土/支护体系物理互斥，只锁最高分唯一值（同分取名字典序，保逐字节一致）；
    // 非互斥类目（垂直运输塔吊+电梯、土方外运自卸+场内平衡）保持多值共存锁定语义
    if (category.exclusive) {
      entries.push({ id: category.id, label: category.label, values: [top.value] });
      continue;
    }
    const threshold = Math.max(60, top.score * 0.4);
    const values = ranked.filter(item => item.score >= threshold).slice(0, 3).map(item => item.value);
    if (values.length > 0) entries.push({ id: category.id, label: category.label, values });
  }
  return entries;
}

/** 类目元数据访问：语义矛盾检测器按锁条目 id 取同类目 relevance/options（与锁构建单一事实源，防双写漂移） */
export function decisionLockCategoryMeta(id: string): DecisionCategoryMeta | undefined {
  return DECISION_CATEGORIES.find(category => category.id === id);
}

/** 决策项语法模式判定（4.36 D3）：两侧选项词任一命中类目选项 aliases 即返回该类目。
 * 两可表述检测器（ambiguous-either-or）与修复链归一（fixAmbiguousEitherOrCandidates）共用——
 * 「减振吊架或减振基础」「同步或分段浇筑」「柔性或半刚性」类形态从此走决策注册表，
 * 不再逐条扩充硬编码句式表（句式追不上形态的无穷性）。 */
export function matchDecisionCategory(sideA: string, sideB: string): DecisionCategoryMeta | undefined {
  return DECISION_CATEGORIES.find(category => {
    const covered = (text: string) => category.options.some(option => option.aliases.test(text) || option.weakAliases?.test(text));
    const strongHit = category.options.some(option => option.aliases.test(sideA) || option.aliases.test(sideB));
    // 双侧均须命中选项词族（强/弱别名），且至少一侧为强别名命中——防弱别名裸词误配：
    // 「柔性接口或刚性接口」两侧只有「柔性」弱形态、无任何强命中 → 不归入路面结构类目；
    // 「柔性或半刚性」有对侧强命中（半刚性）→ 归入（远端 4.35.0 实锤形态）。
    return strongHit && covered(sideA) && covered(sideB);
  });
}

/** 决策项定位锚点（4.36 D3 修复侧）：在左侧选项词文本中定位命中词起始偏移（aliases 优先、
 * weakAliases 兜底）。weakAliases 仅用于替换范围锚定（「同步或分段浇筑」的「同步」起点），
 * 不参与锁计分；返回 undefined（左侧未命中，如纯右组命中形态）时调用方按缺口路径处理，
 * 不盲目扩大替换范围——贪婪左组含普通前缀（「混凝土采用」），吞前缀会误删正文。 */
export function locateDecisionOptionAnchor(category: DecisionCategoryMeta, text: string): { option: DecisionCategoryMeta['options'][number]; index: number; end: number } | undefined {
  for (const option of category.options) {
    const strong = option.aliases.exec(text);
    if (strong) return { option, index: strong.index, end: strong.index + strong[0].length };
  }
  for (const option of category.options) {
    const weak = option.weakAliases?.exec(text);
    if (weak) return { option, index: weak.index, end: weak.index + weak[0].length };
  }
  return undefined;
}

/** 子句级否定判定（与锁构建同口径）：别名命中子句含否定词时视为否定提及——检测侧"不采用施工电梯"不算冲突 */
export function decisionMentionNegated(text: string, aliases: RegExp): boolean {
  const hitClause = mentionClauses(text).find(clause => aliases.test(clause));
  return !!hitClause && DECISION_NEGATION_RE.test(hitClause);
}

/** 核心工程量（确定性口径：条目数最多的前 3 个分部 × 分部内工程量最大条目；金额类条目除外；同条目数按清单出现顺序）。
 * 无分部分节结构的条目（section 空）不参与：无施工方法小节可归属，不合成内部占位桶 */
function deriveCoreQuantities(boq: BillOfQuantitiesResult): string[] {
  const bySection = new Map<string, BoqEntry[]>();
  for (const entry of boq.entries) {
    if (!entry.name || entry.quantity <= 0) continue;
    if (/暂列|金额|计日工|税|费/u.test(entry.name)) continue;
    if (!entry.section) continue;
    const list = bySection.get(entry.section) || [];
    list.push(entry);
    bySection.set(entry.section, list);
  }
  const ranked = [...bySection.entries()]
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, 3);
  return ranked.map(([section, entries]) => {
    const top = [...entries].sort((a, b) => b.quantity - a.quantity || (a.name < b.name ? -1 : 1))[0]!;
    return `${top.name} ${top.quantity}${top.unit}（${section}）`;
  });
}

/** 自然村数量（确定性提取）：项目名/基本事实中「N个（美丽宜居）自然村」正则 → 缺失时降级清单自然村分组数。
 * P3.6 源头根治：正则开头不加空格前缀（「丰乐镇20个」无空格形态曾匹配失败降级成清单分组 9 村），
 * 项目名优先匹配（基本事实可能被跨项目串染，项目名是招标文件口径最稳源）。 */

export function buildBlueprintDecisionLock(input: {
  facts?: DocumentFact[];
  evidence?: DocumentEvidence[];
  contract?: BlueprintContract;
  labor?: BlueprintLabor;
  boq?: BillOfQuantitiesResult;
  villageCount?: number;
}): BlueprintDecisionLock {
  const entries = extractDecisionLockEntries({ facts: input.facts || [], evidence: input.evidence || [] });
  const dataEntries: DecisionLockEntry[] = [];
  if (input.contract && input.contract.totalDays > 0) {
    dataEntries.push({ id: 'contract_days', label: '总工期', values: [`${input.contract.totalDays} 日历天`] });
  }
  if (input.labor && input.labor.peakValue > 0) {
    dataEntries.push({ id: 'labor_peak', label: '劳动力峰值', values: [`${input.labor.peakValue} 人`] });
  }
  const villageCount = input.villageCount || 0;
  if (villageCount > 0) {
    dataEntries.push({ id: 'village_count', label: '自然村数量', values: [`${villageCount} 个自然村`] });
  }
  if (input.boq) {
    const coreQuantities = deriveCoreQuantities(input.boq);
    if (coreQuantities.length > 0) {
      dataEntries.push({ id: 'core_quantities', label: '核心工程量', values: coreQuantities });
    }
  }
  return { entries: [...entries, ...dataEntries] };
}

/** 从基本事实文本提取合同口径（工期/质量标准/计价文件；提取不到降级为空串，不编造）。
 * P3.6 源头根治：总工期不再裸匹配第一个「N日历天」（质保期/阶段工期 90 天曾被误采为总工期，
 * 真实 210 天被漏采）；只从工期类锚点词邻接收值，lookbehind 排除「节点/阶段/分项/关键」工期
 * 子项形态（阶段工期 90 天不可顶替总工期），与 scheduleDays 一致性锚点同口径。 */
