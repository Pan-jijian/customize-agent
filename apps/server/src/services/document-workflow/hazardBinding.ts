/**
 * 危大判定参数绑定（**写作前定死**，纯确定性，零 LLM）。
 *
 * ## 要根治什么
 *
 * 巢湖基线实测：危大章节 4 项判定里 2 项与清单实测**直接矛盾**、1 项引用了不适用的条款——
 *
 * | 类别 | 清单实测 | 阈值 | 正文写了 |
 * |---|---|---|---|
 * | 脚手架 | 搭设高度 18.05m以内 | ≥24m | 「搭设高度超过24m区段，属危大工程」 |
 * | 基坑土方 | 挖土深度 1.0m／1.5m 内 | ≥3m | 「开挖深度超过3m，属危大工程」 |
 * | 起重吊装 | 钢柱单根 5t以内；**塔式起重机** | 2.3.1 非常规设备且≥10kN | 「单件起吊重量超过10kN，属危大」 |
 *
 * 写作期**已有**通用阈值表与义务（`stagePrepare` rule 6b：判定必须给出本项目对应参数、
 * 参数未确认不得判定为危大）——**但项目实测值要模型自己回证据里找，它没找到**。
 * 唯一做过「本项目参数 × 阈值」的 `excavationHazardRuleCard` 是死代码（宿主 `buildLlmSectionContent`
 * 全仓零生产调用点）。
 *
 * 本模块把「抽参数 → 配阈值 → 出结论」全部前置成确定性事实，交给写作侧照写，不给模型自由裁量空间。
 *
 * ## 二态结论（**资料齐全，必须决出唯一值；不设逃生口**）
 *
 * - `属危大` / `属超过一定规模的危大`：数值达标，或命中无门槛的形态型条款（如 2.3.2 采用起重机械安装），
 *   或条件型条款（基坑 2.1.2）的资料条件信号命中
 * - `不属危大`：数值未达标且条件信号未命中、且无适用形态型条款
 *
 * **不设「依据不足」第三态**：这是全自动生成产品，项目资料齐全，规则链必须自己决出结论。
 * 「须按设计文件/专项方案确定」类套话禁止进入正文（用户红线）。
 *
 * ## 为什么阈值写在代码里
 *
 * 阈值是**国家规范常量**（住建部令第37号 + 建办质〔2018〕31号 附件1/附件2），与既有
 * `constructionProcessKnowledge` 同类做法。三处既有实现口径互不一致
 * （`stagePrepare` 落地架 24m/50m、`dangerousApplicability` 脚手架写 ≥15m、任务书 B6），
 * 本模块作为**单源**对外导出阈值表，供注入文案引用。
 */

/** 危大类别（与建办质〔2018〕31号 附件1 的条目分组一致） */
export type HazardCategory =
  | '基坑工程'
  | '模板工程及支撑体系'
  | '起重吊装及起重机械安装拆卸工程'
  | '脚手架工程';

/** 判定结论（二态：属 / 不属；不设逃生口） */
export type HazardConclusion = '属危大' | '属超过一定规模的危大' | '不属危大';

export interface HazardThreshold {
  /** 条款号（附件1 危大 / 附件2 超过一定规模） */
  clause: string;
  /** 阈值描述（供正文引用） */
  text: string;
  /** 数值阈值（归一后：长度类为 m，重量类为 kN）；无重量门槛的形态型条款为 undefined */
  value?: number;
  /** 该阈值对应的**量纲**：只有同量纲的本项目参数才能与之比较——
   * 实测缺陷：同一类别下「支撑高度 3.6m」与「单跨跨度 12m」被一起取最大，
   * 于是拿**跨度**去比**高度**的 5m 阈值，得出错误的"达标"结论 */
  dimension?: '深度' | '高度' | '跨度' | '重量';
  /** 比较方式：'gte' 表示「≥ 阈值即命中」 */
  compare?: 'gte';
  /**
   * 条款类型：
   * - `numeric` 数值型（只看数值）
   * - `form` 形态型（只要形态命中即属，无重量/高度门槛）
   * - `conditional` 条件型（数值未达标仍可能属，须按地质/周边等条件复核）
   */
  kind: 'numeric' | 'form' | 'conditional';
}

/**
 * 危大判定阈值表（**单源**）。附件1 = 危大工程范围；附件2 = 超过一定规模的危大工程范围。
 * 数值与条款号逐条核对自建办质〔2018〕31号原文（巢湖资料内含该文全文，已复核）。
 */
export const HAZARD_THRESHOLDS: Record<HazardCategory, { hazardous: HazardThreshold[]; superHazardous: HazardThreshold[] }> = {
  基坑工程: {
    hazardous: [
      { clause: '2.1.1', text: '开挖深度超过 3m（含 3m）的基坑（槽）的土方开挖、支护、降水工程', value: 3, dimension: '深度', compare: 'gte', kind: 'numeric' },
      { clause: '2.1.2', text: '开挖深度虽未超过 3m，但地质条件、周围环境和地下管线复杂，或影响毗邻建、构筑物安全的基坑（槽）土方开挖、支护、降水工程', kind: 'conditional' },
    ],
    superHazardous: [
      { clause: '3.1.1', text: '开挖深度超过 5m（含 5m）的基坑（槽）的土方开挖、支护、降水工程', value: 5, dimension: '深度', compare: 'gte', kind: 'numeric' },
    ],
  },
  模板工程及支撑体系: {
    hazardous: [
      { clause: '2.2.2', text: '混凝土模板支撑工程：搭设高度 5m 及以上，或搭设跨度 10m 及以上，或施工总荷载（设计值）15kN/m² 及以上，或集中线荷载（设计值）20kN/m 及以上', value: 5, dimension: '高度', compare: 'gte', kind: 'numeric' },
      { clause: '2.2.2', text: '混凝土模板支撑工程：搭设高度 5m 及以上，或搭设跨度 10m 及以上，或施工总荷载（设计值）15kN/m² 及以上，或集中线荷载（设计值）20kN/m 及以上', value: 10, dimension: '跨度', compare: 'gte', kind: 'numeric' },
    ],
    superHazardous: [
      { clause: '3.2.2', text: '混凝土模板支撑工程：搭设高度 8m 及以上，或搭设跨度 18m 及以上，或施工总荷载（设计值）20kN/m² 及以上，或集中线荷载（设计值）40kN/m 及以上', value: 8, dimension: '高度', compare: 'gte', kind: 'numeric' },
      { clause: '3.2.2', text: '混凝土模板支撑工程：搭设高度 8m 及以上，或搭设跨度 18m 及以上，或施工总荷载（设计值）20kN/m² 及以上，或集中线荷载（设计值）40kN/m 及以上', value: 18, dimension: '跨度', compare: 'gte', kind: 'numeric' },
    ],
  },
  起重吊装及起重机械安装拆卸工程: {
    hazardous: [
      { clause: '2.3.1', text: '采用非常规起重设备、方法，且单件起吊重量在 10kN 及以上的起重吊装工程', value: 10, dimension: '重量', compare: 'gte', kind: 'numeric' },
      { clause: '2.3.2', text: '采用起重机械进行安装的工程', kind: 'form' },
    ],
    superHazardous: [
      { clause: '3.3.1', text: '采用非常规起重设备、方法，且单件起吊重量在 100kN 及以上的起重吊装工程', value: 100, dimension: '重量', compare: 'gte', kind: 'numeric' },
    ],
  },
  脚手架工程: {
    hazardous: [
      { clause: '2.4.1', text: '搭设高度 24m 及以上的落地式钢管脚手架工程（包括采光井、电梯井脚手架）', value: 24, dimension: '高度', compare: 'gte', kind: 'numeric' },
      { clause: '2.4.2', text: '附着式升降脚手架工程', kind: 'form' },
      { clause: '2.4.6', text: '异型脚手架工程', kind: 'form' },
    ],
    superHazardous: [
      { clause: '3.4.1', text: '搭设高度 50m 及以上落地式钢管脚手架工程', value: 50, dimension: '高度', compare: 'gte', kind: 'numeric' },
    ],
  },
};

/** 本项目实测参数 */
export interface HazardParameter {
  category: HazardCategory;
  /** 参数名（清单字段名，如「搭设高度」「支撑高度」「挖土深度」「单根柱质量」） */
  name: string;
  /** 原始文本（如「18.05m以内」） */
  raw: string;
  /** 归一值：长度类 → m；重量类 → kN */
  normalized?: number;
  /** 归一单位 */
  unit?: 'm' | 'kN';
  /** 量纲（与阈值 dimension 对齐比较） */
  dimension: '深度' | '高度' | '跨度' | '重量';
  /** 区间形态：上界（「X以内」）/ 下界（「X以外」）/ 精确（纯 X） */
  bound: 'upper' | 'lower' | 'exact';
  source: string;
}

export interface HazardBinding {
  category: HazardCategory;
  /** 本项目实测参数（无实测时的说明） */
  parameter: string;
  /** 参数来源（资料路径） */
  parameterSource: string;
  /** 适用条款号 */
  clause: string;
  /** 阈值描述 */
  threshold: string;
  conclusion: HazardConclusion;
  /** 判定依据（本项目参数 × 阈值 → 结论） */
  basis: string;
}

/**
 * 清单字段名 → 危大类别（句式族；字段名逐字取自巢湖清单实测）。
 * **通用词表**：均为工程量清单/图纸说明的通用项目特征字段名，不绑定任何具体项目或工程类型。
 */
const PARAMETER_FIELDS: Array<{ name: string; category: HazardCategory; unit: 'm' | 'kN'; dimension: HazardParameter['dimension'] }> = [
  { name: '搭设高度', category: '脚手架工程', unit: 'm', dimension: '高度' },
  { name: '支撑高度', category: '模板工程及支撑体系', unit: 'm', dimension: '高度' },
  { name: '支模高度', category: '模板工程及支撑体系', unit: 'm', dimension: '高度' },
  { name: '搭设跨度', category: '模板工程及支撑体系', unit: 'm', dimension: '跨度' },
  { name: '支撑跨度', category: '模板工程及支撑体系', unit: 'm', dimension: '跨度' },
  { name: '挖土深度', category: '基坑工程', unit: 'm', dimension: '深度' },
  { name: '开挖深度', category: '基坑工程', unit: 'm', dimension: '深度' },
  { name: '单根柱质量', category: '起重吊装及起重机械安装拆卸工程', unit: 'kN', dimension: '重量' },
  { name: '单件起吊重量', category: '起重吊装及起重机械安装拆卸工程', unit: 'kN', dimension: '重量' },
  { name: '起吊重量', category: '起重吊装及起重机械安装拆卸工程', unit: 'kN', dimension: '重量' },
];

/**
 * 结构跨度补抽（模板支撑 2.2.2 的「搭设跨度 ≥10m」条件）。
 *
 * **字段名必须具体，且必须有左边界**——实测缺陷：原先含裸「跨度」且无边界，
 * `吊车跨度：26.8m`（DWG 里 20T 吊车的跨度标注）被当成模板支撑跨度，
 * 直接把 3.6m 高支模的项目误判成「超过一定规模的危大」。
 * 现只认显式表述（搭设跨度/支撑跨度/最大单跨跨度/单跨跨度/结构跨度），
 * 巢湖实测命中来源为招标文件「最大单跨跨度为 35.86 米」。
 */
const SPAN_FIELDS = ['搭设跨度', '支撑跨度', '最大单跨跨度', '单跨跨度', '结构跨度'];

/**
 * 条件型条款的触发信号（基坑 2.1.2：地质条件、周围环境、地下管线、毗邻建（构）筑物）。
 * 资料齐全时这些条件**必然可判**：命中即属危大，未命中即不属——不给"依据不足"逃生口。
 */
const CONDITION_SIGNAL_RE = /毗邻(?:建|构)?筑?物|临近建筑物|周边(?:建筑物|建筑|环境复杂)|地下管线|管线复杂|复杂地质|地质条件复杂|邻近(?:道路|管线|建筑物)|紧邻/u;

/** 不可判定值（清单常见的「详见…」指向型描述） */
const UNRESOLVABLE_VALUE_RE = /详见|见设计|按设计|施工图纸|以图纸|自行考虑|综合考虑/u;

/**
 * 值归一：`18.05m以内` → 18.05 m；`5t以内` → 49 kN；`30cm内` → 0.3 m。
 * 区间语义：`以内/内` → upper（上界）；`以外/以上` → lower（下界）；纯数值 → exact。
 */
export function normalizeParameterValue(raw: string, unit: 'm' | 'kN'): { normalized: number; bound: HazardParameter['bound'] } | undefined {
  const text = String(raw || '').replace(/\s+/gu, '');
  if (!text || UNRESOLVABLE_VALUE_RE.test(text)) return undefined;
  const match = /(\d+(?:\.\d+)?)\s*(mm|cm|m|t|吨|kg|kN|KN|kn)?/u.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const token = (match[2] || '').toLowerCase();
  let normalized: number;
  if (unit === 'm') {
    // 长度归一：mm/cm/m → m。缺单位时按 m（清单「3.60内」这类省略单位形态实测存在）
    normalized = token === 'mm' ? amount / 1000 : token === 'cm' ? amount / 100 : amount;
  } else {
    // 重量归一：统一到 kN（1t ≈ 9.8kN，取 9.8；kg → kN）
    normalized = token === 't' || token === '吨' ? amount * 9.8 : token === 'kg' ? amount * 0.0098 : amount;
  }
  const bound: HazardParameter['bound'] = /以内|内$|以內/u.test(text) ? 'upper' : /以外|以上|及以上|不低于/u.test(text) ? 'lower' : 'exact';
  return { normalized: Math.round(normalized * 1000) / 1000, bound };
}

/**
 * 从资料证据抽取本项目危大相关实测参数（确定性）。
 * @param evidence 写作侧证据（`{ content, filePath }`），逐条扫描清单项目特征描述
 */
export function extractHazardParameters(evidence: Array<{ content?: unknown; filePath?: string; sectionTitle?: string }>): HazardParameter[] {
  const out: HazardParameter[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    const text = String(item.content || '');
    if (!text) continue;
    for (const field of PARAMETER_FIELDS) {
      // 清单形态：「N．搭设高度：18.05m以内」（序号+字段名+全/半角冒号+值）。
      // 值必须**紧邻**字段名且形态封闭——贪婪吃到下一字段会把「3.60m以内 3．模板材质：…」
      // 整串当成值（实测缺陷），既污染注入文案又让边界判定失真。
      const re = new RegExp(`${field.name}\\s*[:：]\\s*(\\d+(?:\\.\\d+)?\\s*(?:mm|cm|m|t|吨|kg|kN|KN)?\\s*(?:以内|以外|以內|及以上|以上|内)?)`, 'gu');
      for (const match of text.matchAll(re)) {
        const raw = String(match[1] || '').trim();
        const normalized = normalizeParameterValue(raw, field.unit);
        if (!normalized) continue;
        const key = `${field.category}\u0000${field.name}\u0000${raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          category: field.category,
          name: field.name,
          raw,
          normalized: normalized.normalized,
          unit: field.unit,
          dimension: field.dimension,
          bound: normalized.bound,
          source: `${item.filePath || ''} ${item.sectionTitle || ''}`.trim(),
        });
      }
    }
    // 结构跨度兜底（模板支撑 2.2.2 的「搭设跨度 ≥10m」条件）：
    // 左边界 `(?<![一-龥])` 防「吊车跨度」这类更长词内的子串命中；「为」承接「最大单跨跨度为 35.86 米」句式
    for (const name of SPAN_FIELDS) {
      const re = new RegExp(`(?<![\\u4e00-\\u9fa5])${name}\\s*(?:[:：]|为|是)?\\s*(?:约为|达|至)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:mm|cm|m|米)?`, 'gu');
      for (const match of text.matchAll(re)) {
        const raw = `${String(match[1])}m`;
        const normalized = normalizeParameterValue(raw, 'm');
        if (!normalized) continue;
        const key = `模板工程及支撑体系\u0000${name}\u0000${raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          category: '模板工程及支撑体系',
          name,
          raw,
          normalized: normalized.normalized,
          unit: 'm',
          dimension: '跨度',
          bound: normalized.bound,
          source: `${item.filePath || ''} ${item.sectionTitle || ''}`.trim(),
        });
      }
    }
  }
  return out;
}

/** 起重设备形态信号：常规设备 vs 非常规设备（决定 2.3.1 前提是否成立） */
const CONVENTIONAL_LIFTING_RE = /塔式起重机|塔吊|汽车吊|履带吊|施工升降机|龙门架|物料提升机/u;
const UNCONVENTIONAL_LIFTING_RE = /非常规起重设备|非常规起重方法|液压提升|顶升|滑移|整体提升/u;

/**
 * 危大判定（写作前定死）。
 * @param evidence 写作侧证据（清单切片）
 * @param canonical 已归一的项目事实（可选：`基坑开挖深度` / `基坑支护形式` 槽位）
 */
export function extractHazardBindings(
  evidence: Array<{ content?: unknown; filePath?: string; sectionTitle?: string }>,
  canonical?: Record<string, string | undefined>,
): HazardBinding[] {
  const parameters = extractHazardParameters(evidence);
  const corpus = billOfQuantitiesCorpus(evidence);
  // 图纸标注的基坑深度作为基坑类别补充实测（canonical 槽位由 extractDrawingAnnotationFacts 确定性填充）
  const canonicalDepth = (() => {
    const raw = canonical?.['基坑开挖深度'];
    if (!raw) return undefined;
    const parsed = normalizeParameterValue(raw, 'm');
    return parsed ? { raw, normalized: parsed.normalized } : undefined;
  })();
  const bindings: HazardBinding[] = [];
  for (const category of Object.keys(HAZARD_THRESHOLDS) as HazardCategory[]) {
    const own = parameters.filter(item => item.category === category);
    // 最保守取值：**按量纲分别取最大值**（最深的坑、最高的架、最重的吊件、最大的跨度才决定判定）。
    // 实测缺陷：不分量纲地对整类取最大，会把「支撑高度 3.6m」与「单跨跨度 12m」混为一谈，
    // 拿跨度去比高度的 5m 阈值。
    const maxOfDimension = (dimension: HazardParameter['dimension']): HazardParameter | undefined =>
      own.filter(item => item.dimension === dimension)
        .reduce<HazardParameter | undefined>((best, item) => ((item.normalized ?? 0) > (best?.normalized ?? -1) ? item : best), undefined);
    const depthFallback = category === '基坑工程' && canonicalDepth && ((maxOfDimension('深度')?.normalized ?? 0) < canonicalDepth.normalized)
      ? canonicalDepth : undefined;
    const measured = maxOfDimension('深度') ?? maxOfDimension('高度') ?? maxOfDimension('跨度') ?? maxOfDimension('重量')
      ?? (depthFallback ? { category, name: '基坑开挖深度', raw: depthFallback.raw, normalized: depthFallback.normalized, unit: 'm' as const, dimension: '深度' as const, bound: 'exact' as const, source: '图纸标注（canonical）' } : undefined);
    /** 命中判定：**同量纲**的本项目参数 ≥ 阈值才算命中 */
    const hitsDimension = (rule: HazardThreshold): HazardParameter | undefined => {
      if (rule.value === undefined || !rule.dimension) return undefined;
      const candidate = maxOfDimension(rule.dimension);
      return candidate && (candidate.normalized ?? 0) >= rule.value ? candidate : undefined;
    };
    const specs = HAZARD_THRESHOLDS[category];
    const parameterText = measured ? `${measured.name} ${measured.raw}` : '资料未给出实测参数';
    const parameterSource = measured?.source || '';
    const push = (clause: string, threshold: string, conclusion: HazardConclusion, basis: string) =>
      bindings.push({ category, parameter: parameterText, parameterSource, clause, threshold, conclusion, basis });
    const unitLabel = measured?.unit === 'kN' ? 'kN' : 'm';

    // 附件1 中**无重量/高度门槛的形态型条款**优先（命中即属，且不受数值门槛影响）
    const formRule = specs.hazardous.find(rule => rule.kind === 'form' && matchesForm(rule.clause, corpus, category));
    if (formRule) {
      push(formRule.clause, formRule.text, '属危大', `本项目${formClausePhrase(formRule.clause)}，对照 ${formRule.clause} 属危大工程（该条款无重量/高度门槛）`);
      continue;
    }
    if (!measured) {
      // 该类别在资料中无实测参数 → 本项目**不含**该类危大工程（资料齐全前提下的确定性结论）：
      // 清单无对应分项即不涉及，正文不得列入危大清单，也不得写"依据不足"类套话。
      push(specs.hazardous[0]?.clause || '', specs.hazardous[0]?.text || '', '不属危大',
        `本项目资料中无${category}对应实测参数（无从判定达到 ${specs.hazardous[0]?.clause} 门槛），且清单无该类分项，不属危大工程`);
      continue;
    }
    // 数值型：**逐条阈值按量纲对照**（同一 clause 的多条取或条件各带自己的 dimension），
    // 先判附件2（超过一定规模）再判附件1（危大）——高门槛是低门槛的超集，顺序反了会降级误报。
    const superHit = specs.superHazardous
      .map(rule => ({ rule, measured: hitsDimension(rule) }))
      .find(entry => entry.measured !== undefined);
    const hazardHit = specs.hazardous
      .map(rule => ({ rule, measured: hitsDimension(rule) }))
      .find(entry => entry.measured !== undefined);
    // 复合前提条款（如 2.3.1「采用非常规起重设备、方法」且 ≥10kN）——量达标但前提不成立时不判属
    const hazardApplies = hazardHit !== undefined && !(hazardHit.rule.clause === '2.3.1' && !UNCONVENTIONAL_LIFTING_RE.test(corpus));
    if (superHit) {
      const { rule, measured: hitParameter } = superHit;
      push(rule.clause, rule.text, '属超过一定规模的危大', `本项目 ${hitParameter!.name} ${hitParameter!.raw} = ${hitParameter!.normalized}${hitParameter!.unit}，达 ${rule.clause} 的 ≥${rule.value}${hitParameter!.unit} 门槛，属超过一定规模的危大工程`);
      continue;
    }
    if (hazardApplies) {
      const { rule, measured: hitParameter } = hazardHit!;
      push(rule.clause, rule.text, '属危大', `本项目 ${hitParameter!.name} ${hitParameter!.raw} = ${hitParameter!.normalized}${hitParameter!.unit}，达 ${rule.clause} 的 ≥${rule.value}${hitParameter!.unit} 门槛，属危大工程`);
      continue;
    }
    // 未达主条件：条件型条款（基坑 2.1.2）按资料中的条件信号**判定**——命中即属、未命中即不属。
    // 资料齐全时这些条件必然可判，**不设「依据不足」逃生口**（套话不得进正文）。
    const conditional = specs.hazardous.find(rule => rule.kind === 'conditional');
    if (conditional) {
      const signal = CONDITION_SIGNAL_RE.exec(corpus)?.[0];
      push(conditional.clause, conditional.text,
        signal ? '属危大' : '不属危大',
        signal
          ? `本项目 ${parameterText} = ${measured.normalized}${unitLabel} 未达 2.1.1 数值门槛，但资料载明「${signal}」，对照 ${conditional.clause}（地质条件、周围环境、地下管线、毗邻建（构）筑物复杂）属危大工程`
          : `本项目 ${parameterText} = ${measured.normalized}${unitLabel} 未达 2.1.1 的 3m 门槛，且资料未见毗邻建（构）筑物、地下管线复杂或地质条件复杂等 2.1.2 触发条件，对照 ${conditional.clause} 不属危大工程`);
      continue;
    }
    // 多条并列条件的条款（模板 2.2.2：高度/跨度/荷载取或）：**逐条件按量纲对照**，全部未达才判「不属」。
    // 实测缺陷：原实现把同类别不同量纲的参数一起取最大值，拿「跨度 12m」去比「高度 5m」阈值。
    if (category === '模板工程及支撑体系') {
      const spans = parameters.filter(item => item.category === category && item.dimension === '跨度');
      const maxSpan = spans.reduce<HazardParameter | undefined>((best, item) => ((item.normalized ?? 0) > (best?.normalized ?? -1) ? item : best), undefined);
      const spanHit = maxSpan !== undefined && (maxSpan.normalized ?? 0) >= 10;
      const heightHit = (maxOfDimension('高度')?.normalized ?? 0) >= 5;
      const height = maxOfDimension('高度');
      push(specs.hazardous[0]!.clause, specs.hazardous[0]!.text,
        spanHit || heightHit ? '属危大' : '不属危大',
        spanHit
          ? `本项目 搭设跨度 ${maxSpan!.raw}（来源字段「${maxSpan!.name}」）、支撑高度 ${height?.raw ?? '—'}，其中跨度达 2.2.2 的 ≥10m 门槛，属危大工程`
          : heightHit
            ? `本项目 支撑高度 ${height!.raw} = ${height!.normalized}m，达 2.2.2 的 ≥5m 门槛，属危大工程`
            : `本项目 支撑高度 ${height?.raw ?? '资料未给出'} 未达 5m 门槛，且资料未见 ≥10m 的搭设跨度，对照 2.2.2 各项条件均未达，不属危大工程`);
      continue;
    }
    const primary = specs.hazardous[0];
    const primaryMeasured = primary ? hitsDimension(primary) : undefined;
    push(primary?.clause || '', primary?.text || '', '不属危大',
      `本项目 ${primaryMeasured ? `${primaryMeasured.name} ${primaryMeasured.raw}` : parameterText} 未达 ${primary?.clause} 的 ≥${primary?.value}${primaryMeasured?.unit ?? unitLabel} 阈值，且无适用形态型条款，不属危大工程`);
  }
  return bindings;
}

/**
 * 形态判定语料 = **清单证据**（本项目实际构成的权威载体）。
 *
 * 实测缺陷（严重）：原先用全文语料做形态匹配，`/附着式升降脚手架/` 直接命中资料里**抄录的
 * 31 号文目录**（巢湖 CAD 图层把整段目录抄进了 `结构设计总说明审图修改_t3.dwg`：
 * 「… 3排箍筋 2.4.2 附着式升降脚手架工程。 …」），于是**任何项目**都被判
 * 「本项目采用附着式升降脚手架，属危大」。
 *
 * 改用清单语料后天然隔离：清单是「本项目实际有什么」的确定性载体，
 * 实测巢湖清单 0 处「附着式/异型脚手架」，脚手架全部为「搭设方式：双排,密目网(全封闭) 围护」= 落地式。
 */
export function billOfQuantitiesCorpus(evidence: Array<{ content?: unknown; filePath?: string; sectionTitle?: string }>): string {
  return evidence
    .filter(item => /清单|工程量|bill|boq|\.xls/iu.test(`${item.filePath || ''} ${item.sectionTitle || ''}`))
    .map(item => String(item.content || ''))
    .join('\n')
    // 兜底：即使误收进含规范目录的切片，也按「条款号 + 类别词」目录形态整段剥离
    .replace(/\d+\.\d+(?:\.\d+)?\s*(?:基坑工程|模板工程及支撑体系|模板支撑工程|模板工程|起重吊装及起重机械安装拆卸工程|起重吊装|脚手架工程|附着式升降脚手架工程|附着式升降脚手架|异型脚手架工程|异型脚手架|拆除工程|暗挖工程)[^。；\n]{0,60}/gu, '')
    .replace(/(?:危大工程范围|超过一定规模的危大工程范围)[^。；\n]{0,80}/gu, '');
}

/** 形态型条款命中判定（语料须先经 projectProseCorpus 剔除规范目录） */
function matchesForm(clause: string, corpus: string, category: HazardCategory): boolean {
  if (clause === '2.3.2') {
    // 「采用起重机械进行安装的工程」：常规起重设备（塔吊/汽车吊…）即命中
    if (category !== '起重吊装及起重机械安装拆卸工程') return false;
    return CONVENTIONAL_LIFTING_RE.test(corpus) || UNCONVENTIONAL_LIFTING_RE.test(corpus);
  }
  if (clause === '2.4.2') return /附着式升降脚手架|爬架/u.test(corpus);
  if (clause === '2.4.6') return /异型脚手架/u.test(corpus);
  return false;
}

function formClausePhrase(clause: string): string {
  if (clause === '2.3.2') return '起重机械进行安装（钢结构吊装采用塔式起重机等起重机械）';
  if (clause === '2.4.2') return '附着式升降脚手架';
  if (clause === '2.4.6') return '异型脚手架';
  return '该形态';
}

/**
 * 危大判定块（写作硬约束）：逐项给出「本项目实测参数 × 适用条款阈值 → 结论」，
 * 并要求正文照此表述——**禁止照抄规范阈值充当本项目参数**。
 */
export function renderHazardBindingBlock(bindings: HazardBinding[]): string {
  if (bindings.length === 0) return '';
  return [
    '【危大判定（写作前已按清单实测参数定死，硬约束）】下列判定为**本项目实际参数对照规范阈值**的确定性结论，'
    + '正文必须逐项按「本项目实际参数 + 判定阈值对照 + 结论」三要素表述，条款号须引用正确；'
    + '**禁止照抄规范阈值充当本项目参数**（不得写「开挖深度超过3m」而不给本项目实测值），'
    + '判「不属危大」的类别不得写成属危大，**不得写「须按设计文件/专项方案确定」「依据不足」类回避表述**（本项目资料齐全，判定已确定）：',
    ...bindings.map(item => `- ${item.category}：本项目「${item.parameter}」；适用条款 ${item.clause}（${item.threshold}）→ 结论：**${item.conclusion}**。依据：${item.basis}`),
    // 以下两条由已删除的死代码 `excavationHazardRuleCard`（宿主 buildLlmSectionContent 全仓零调用）
    // 承接过来——它从未到达模型，但其非阈值类要求仍有价值，且阈值已由本模块单源承担，不再保留第二份。
    '涉及基坑支护形式与做法时，必须写明具体支护参数并与资料一致：土钉墙写明土钉规格（钢管 Φ 及壁厚）、长度、竖向/水平间距、喷射混凝土面层厚度与钢筋网规格；放坡开挖写明放坡坡率（如 1:0.75）与坡面防护做法；**禁止「按设计坡率」「放坡或支护」类参数留白或两可表述**。',
    '危大工程辨识清单表格与正文排除性声明必须**同口径**：清单只列参数确认达到判定阈值的类别；正文声明「本工程无/未涉及某类危大工程」的类别不得再列入危大清单表格（反之亦然），阈值表述不得两处不一致。',
  ].join('\n');
}
