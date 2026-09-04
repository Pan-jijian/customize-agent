import type { DocumentEvidence, DocumentFact } from './types';
import { cleanPdfHeadingNoise } from './factsModel';
import { stringifyFactValue } from './utils';

/**
 * 1.2 关键决策锁（确定性提取，零 LLM 调用）：
 * 工艺路线/机械选型/材料供应这类"实体-选择"在规划层从未被锁定，各章独立并发成稿各自发挥必然漂移
 * （实锤：决策应锁塔吊但后章写施工电梯类矛盾，数值一致性审查只查含数值句子，完全在检测盲区）。
 * 本模块从 factsModel + 证据确定性提取封闭类目的"项目关键决策表"：类目取值必须有证据支撑
 * （否定句不计分），多源取值按来源权威度裁决（补疑/澄清 > 招标文件 > 清单/图纸 > 规范 > 其他，
 * 与 scopeConflicts 源级裁决口径同源），同目多值共存（塔吊+施工电梯同属垂直运输）时全部锁定。
 * 决策表渲染为恒定文本注入所有章写作 prompt 恒定段（同文档各调用逐字节一致 → 同时利好 prefix cache）。
 */

/** 决策锁条目：封闭类目 + 锁定取值集（按证据支持力度降序） */
export interface DecisionLockEntry {
  id: string;
  label: string;
  values: string[];
}

/** 类目元数据（导出供 1.3 语义矛盾检测器同源比对：锁构建与冲突检测共用同一套 relevance/options/否定口径） */
export interface DecisionCategoryMeta {
  id: string;
  label: string;
  /** 类目相关句召回（句子不含任一类目词不进入计分） */
  relevance: RegExp;
  options: Array<{ value: string; aliases: RegExp }>;
  /** 互斥类目：取值物理互斥（模板体系/混凝土供应/基坑支护），多值共存时只能锁最高分唯一值。
   * 4.17.8 修复：历史缺陷——互斥类目多值全部锁定（放坡+喷锚+灌注桩并存），写作 LLM 按锁
   * 规则各章任选其一，支护/模板体系跨章打架（真实生成 4.17.7 门禁：放坡喷锚类 4 段 vs 灌注桩 1 段） */
  exclusive?: boolean;
}

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
];

/** 否定子句：含选项别名但处于否定语境的提及不计分（“不采用自拌混凝土”不构成自拌的证据支撑） */
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
export function buildDecisionLock(input: { facts: DocumentFact[]; evidence: DocumentEvidence[] }): DecisionLockEntry[] {
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
    // 4.17.8 互斥类目唯一化：模板/混凝土/支护体系物理互斥，只锁最高分唯一值（同分取名字典序，保逐字节一致）。
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

/** 渲染决策锁为注入写作 prompt 恒定段的文本（同文档各调用逐字节一致 → prefix cache 可命中） */
export function renderDecisionLock(entries: DecisionLockEntry[]): string {
  if (entries.length === 0) return '';
  const lines = ['【项目关键决策锁定——以下技术决策已从项目资料中裁决锁定，全文各章必须严格一致；涉及已锁定类目时只能采用锁定值，不得另写其他方案/机械/体系（锁定类目之外的常规内容仍按证据与章节要求正常编写）】'];
  for (const entry of entries) lines.push(`- ${entry.label}：${entry.values.join('、')}`);
  return lines.join('\n');
}

/** 类目元数据访问：1.3 语义矛盾检测器按锁条目 id 取同类目 relevance/options（与锁构建单一事实源，防双写漂移） */
export function decisionLockCategoryMeta(id: string): DecisionCategoryMeta | undefined {
  return DECISION_CATEGORIES.find(category => category.id === id);
}

/** 子句级否定判定（与锁构建同口径）：别名命中子句含否定词时视为否定提及——检测侧"不采用施工电梯"不算冲突 */
export function decisionMentionNegated(text: string, aliases: RegExp): boolean {
  const hitClause = mentionClauses(text).find(clause => aliases.test(clause));
  return !!hitClause && DECISION_NEGATION_RE.test(hitClause);
}
