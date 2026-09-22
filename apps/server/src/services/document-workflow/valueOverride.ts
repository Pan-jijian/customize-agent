/**
 * 值级覆盖 VLO（Value-Level Override，方案 v3 §1）：
 *
 * **为什么不按字段**：答疑/补疑里出现什么是不可预知的（工期、合同金额、参考品牌、做法、标准号、
 * 新增条款……）。按字段白名单治理 = 把未知当已知 → 新类型必漏。本模块的治理粒度是**值对**：
 * 「被取代值 → 生效值」+ 语境内核（scope），任何数据类型零改造。
 *
 * **句式族（零字段知识，全部确定性）**：
 *   ① 变更连接语：「365日历天，现变更修改为:330日历天」「X 由 A 调整为 B」
 *   ② 原现对举：「原 A，现 B」「A（现变更为 B）」
 *   ③ 澄清表行：「条款号/条款名称/编列内容」表逐行（含 OCR 复写形态）
 *   ④ 答疑问答对：「问：… 答：…」（问句值=被取代，答案值=生效）
 *   ⑤ 同实体跨文对照：同一实体在招标与答疑各出现一次（招标值=被取代）
 *   ⑥ **新增型**：答疑新增内容（非覆盖）→ 由调用侧进要求池，本模块只做识别标记
 *
 * **scope（语境内核）**：每个值对携带条款号/关键词/实体名，应用时限定语境，
 * 避免「365」这样的同形值在无关位置被误判为旧口径。
 */

export interface ValueOverride {
  /** 被取代值（原样文本；应用时按 scope 限定语境比较） */
  superseded: string;
  /** 生效值（原样文本） */
  effective: string;
  /** 语境内核：条款号（如 1.3.2）/ 关键词（如 计划工期、屋面板）/ 实体名 */
  scope: string[];
  /** 依据资料（路径 + 原文片段，供口径账本追溯） */
  evidence: { source: string; snippet: string }[];
  /** 变更类型：覆盖（改值/改做法）｜新增（答疑新增要求，交要求池） */
  kind: 'override' | 'addition';
}

/** 全局正则缓存（同一 source 只编译一次；高频调用路径避免重复 new RegExp） */
const GLOBAL_PATTERN_CACHE = new Map<string, RegExp>();
function globalPatternFor(source: string): RegExp {
  const cached = GLOBAL_PATTERN_CACHE.get(source);
  if (cached) { cached.lastIndex = 0; return cached; }
  const created = new RegExp(source, 'gu');
  GLOBAL_PATTERN_CACHE.set(source, created);
  return created;
}

/** 值形态识别（用于 R5/R7 的类型专属权威；由值本身形态判定，不依赖字段名） */
export type ValueShape = 'measure' | 'spec' | 'date' | 'money' | 'standard' | 'text';

export function classifyValueShape(value: string): ValueShape {
  const text = String(value || '').trim();
  if (!text) return 'text';
  if (/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/u.test(text)) return 'date';
  if (/\d+(?:\.\d+)?\s*(?:万元|亿元|元)/u.test(text) && !/\d+(?:\.\d+)?\s*(?:万元|元)\s*\//u.test(text)) return 'money';
  if (/(?:GB|JGJ|CJJ|DB|CECS|ISO|IEC|JTG|SL|DL|YB|HG)\s*\/?\s*T?\s*[\d.]+/iu.test(text)) return 'standard';
  if (/(?:C\d{2,3}|HRB\d{3,4}|HPB\d{3}|DN\s*\d+|Φ\s*\d+|φ\s*\d+|\d+(?:\.\d+)?\s*(?:mm|cm|kV|MPa|kPa|kW|W|A|V))/u.test(text)) return 'spec';
  if (/\d+(?:\.\d+)?\s*(?:m2|m3|m²|m³|㎡|m|km|kg|t|吨|个|座|套|台|根|块|株|棵|处|项|日历天|天|层|樘|扇|片|组|件|孔|盏)/u.test(text)) return 'measure';
  return 'text';
}

/** 变更连接语（含全角/半角冒号与「变更修改为」复合形态） */
/** 变更连接语（单源：值级覆盖抽取与真值层的值本体抽取共用） */
export const CHANGE_CONNECTORS = '变更修改为|变更为|变更至|澄清为|澄清修改为|修改为|调整为|调整至|更正为|修正为|现为|现改为|更改为';

const SENTENCE_SPLIT_RE = /[。；;\n]/u;

/** 值片段模式（被取代/生效两侧的候选值：数值+单位、日期、金额、规范号、简短文本） */
const VALUE_TOKEN_RE = new RegExp([
  '\\d{4}\\s*年\\s*\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日',
  '\\d+(?:\\.\\d+)?\\s*(?:万元|亿元|日历天|个?月|天|m2|m3|m²|m³|㎡|mm|cm|km|m|kg|t|吨|个|座|套|台|根|块|樘|扇|片|组|件|孔|盏|项|处|层|kV|MPa|kPa|kW|W|A|V|%)',
  '(?:GB|JGJ|CJJ|DB|CECS|ISO|IEC)\\s*/?\\s*T?\\s*[\\d.]+(?:-\\d{2,4})?',
].join('|'), 'giu');

/** 中文条款号（1.3.2 / 第1.3.2条 / 1、2） */
const CLAUSE_NO_RE = /(?:第\s*)?(\d{1,2}(?:\.\d{1,2}){1,3})\s*(?:条|项|款)?/u;

function scopeFromSentence(sentence: string): string[] {
  const scope: string[] = [];
  const clause = CLAUSE_NO_RE.exec(sentence)?.[1];
  if (clause) scope.push(clause);
  const keys = sentence.match(/[一-龥]{2,8}(?=[：:）)]?(?:为|是|按|采用|统一|变更|澄清|调整))/gu);
  if (keys) scope.push(...keys.slice(0, 3));
  return [...new Set(scope)];
}

/**
 * 抽取值级覆盖（句式族 ①②③，零 LLM）。
 * @param sources [{ text, source }]：source 为文件路径（含"答疑/澄清/补疑"者按答疑侧处理）
 */
export function extractValueOverrides(sources: Array<{ text: string; source: string }>): ValueOverride[] {
  // 编译一次、循环内复用（原实现每句 new RegExp，1.8 万条证据时成为瓶颈）
  const CONNECTOR_WITH_VALUE_RE = new RegExp(`(${CHANGE_CONNECTORS})\\s*[:：]?\\s*(${VALUE_TOKEN_RE.source}|[\\u4e00-\\u9fa5]{2,12})`, 'u');
  const VALUE_TOKEN_SCAN_RE = new RegExp(VALUE_TOKEN_RE.source, 'gu');
  const TABLE_PAIR_RE = new RegExp(`([\\u4e00-\\u9fa5]{2,8})\\s*[:：]\\s*(${VALUE_TOKEN_RE.source})`, 'gu');
  const overrides: ValueOverride[] = [];
  const seen = new Set<string>();
  const push = (override: ValueOverride) => {
    const key = `${override.superseded}\u0000${override.effective}`;
    if (override.superseded === override.effective || seen.has(key)) return;
    seen.add(key);
    overrides.push(override);
  };
  // 性能：绝大多数证据不含变更语义——整体预筛（单次 includes）后再逐句解析；
  // 无预筛时 1.8 万条证据 × 每句 2 个 new RegExp 会让 finalize 阶段卡住（实测 11 分钟无进展）
  const CONTAINER_RE = /变更|澄清|补疑|补遗|调整为|修改为|更正/;
  for (const item of sources) {
    const text = String(item.text || '');
    if (!text || !CONTAINER_RE.test(text)) continue;
    for (const rawSentence of text.split(SENTENCE_SPLIT_RE)) {
      const sentence = rawSentence.replace(/\s+/gu, '');
      if (sentence.length < 4) continue;
      const scope = scopeFromSentence(sentence);
      // ① 变更连接语 / ② 原现对举：连接语后紧跟的值为生效值；同句其余值为被取代值
      const connector = CONNECTOR_WITH_VALUE_RE.exec(sentence);
      if (connector) {
        const effective = connector[2]!.trim();
        // 生效值侧必须是**值**（含数字/单位/日期）或短名词且本身不含变更标记
        //（实测垃圾对：「0808月 → 日变更修改为」——右侧捕获到了变更语本身）
        if (!/\d/u.test(effective) || new RegExp(CHANGE_CONNECTORS, 'u').test(effective)) continue;
        const effectiveShape = classifyValueShape(effective);
        const before = sentence.slice(0, connector.index);
        const candidates = [...before.matchAll(VALUE_TOKEN_SCAN_RE)].map(match => match[0].trim());
        // 同类替换：被取代值必须与生效值**同形态**（工期只被工期取代，不被"变更发生日期"取代——
        // 实测垃圾对：「2026年08月05日 → 330日历天」，08-05 是澄清发生日而非旧工期）
        for (const superseded of candidates) {
          if (superseded === effective) continue;
          if (classifyValueShape(superseded) !== effectiveShape) continue;
          push({
            superseded,
            effective,
            scope,
            evidence: [{ source: item.source, snippet: sentence.slice(0, 120) }],
            kind: 'override',
          });
        }
        continue;
      }
      // ③ 澄清表行：「XX：A」后紧跟同条款「XX：B」的复写形态（OCR 双写）——同句内取最后一次出现为生效
      const tablePairs = [...sentence.matchAll(TABLE_PAIR_RE)];
      if (tablePairs.length >= 2) {
        const byKey = new Map<string, string[]>();
        for (const pair of tablePairs) {
          const list = byKey.get(pair[1]!) || [];
          list.push(pair[2]!.trim());
          byKey.set(pair[1]!, list);
        }
        for (const [key, values] of byKey) {
          const unique = [...new Set(values)];
          if (unique.length < 2) continue;
          push({
            superseded: unique[0]!,
            effective: unique[unique.length - 1]!,
            scope: [...new Set([...scope, key])],
            evidence: [{ source: item.source, snippet: sentence.slice(0, 120) }],
            kind: 'override',
          });
        }
      }
    }
  }
  return overrides;
}

/**
 * 多次变更链收敛（方案 §1.4）：同一 (被取代, scope) 链上按资料时序取**最后一次**生效值。
 * 时序：来源串里的答疑编号/文件日期 > 数组顺序（后出现者视为更新）。
 */
export function collapseOverrideChains(overrides: ValueOverride[]): ValueOverride[] {
  const byKey = new Map<string, ValueOverride>();
  for (const override of overrides) {
    const key = `${override.superseded}\u0000${override.scope.join('|')}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, override); continue; }
    // 链式：A→B 与 B→C ⇒ A→C（生效值取链尾），历史保留在 evidence
    const chained: ValueOverride = existing.effective === override.superseded
      ? { ...override, superseded: existing.superseded, evidence: [...existing.evidence, ...override.evidence], scope: [...new Set([...existing.scope, ...override.scope])] }
      : { ...override, superseded: existing.superseded, evidence: [...existing.evidence, ...override.evidence], scope: [...new Set([...existing.scope, ...override.scope])] };
    byKey.set(key, chained);
  }
  return [...byKey.values()];
}

/** 覆盖表应用：把文本中出现的被取代值替换为生效值（scope 限定时仅当语境相关） */
export function applyOverridesToText(text: string, overrides: ValueOverride[]): { text: string; applied: Array<{ from: string; to: string }> } {
  let result = String(text || '');
  const applied: Array<{ from: string; to: string }> = [];
  for (const override of overrides) {
    if (override.kind !== 'override') continue;
    if (!override.superseded || !result.includes(override.superseded)) continue;
    // 引用形态豁免：「原 X，现 Y」「由 X 变更为 Y」类句中保留原值（那是变更过程说明）
    const next = result.replace(new RegExp(override.superseded.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu'), (match, offset: number) => {
      // 边界守卫：被取代值不得是更长数字串的一部分（「1365日历天」里的 365、
      // 「4000000.00元」里的 000000.00 类同形切片）——误替换会造出非法的第三个数
      if (offset > 0 && /[\d.,]/u.test(result[offset - 1]!)) return match;
      const context = result.slice(Math.max(0, offset - 12), offset + match.length + 12);
      // 豁免只认**明确把该值当旧值引用**的标记（原为/原值/原内容/此前/由…变更）——
      // 不认裸变更连接语：实测「最高投标限价现调整为:172460314.52元」是**单独陈述**一个
      // 后来才被取代的值（1 号答疑自身文件的现行表述），不是变更过程说明，不得豁免。
      if (/原(?:为|值|内容|计划|合同|招标)|此前|由[^，。；]{0,12}(?:变更|调整)|变更过程/u.test(context)) return match;
      applied.push({ from: match, to: override.effective });
      return override.effective;
    });
    result = next;
  }
  return { text: result, applied };
}

/**
 * 检索结果就地归一到现行口径（**检索出口**用）：章节写作与蓝图推导经 `searchWithCache`
 * 重新检索知识库、拿到的是原始切片——只在初始证据池上替换会漏掉这条通道，
 * 旧值（365 / 旧限价 / 旧开工日期）会在章节写作时重新进入写手输入。
 * 就地修改并返回被替换的条目数（调用侧用于诊断）。
 */
export function applyOverridesToRetrieved<T extends { content?: unknown }>(items: T[], overrides: ValueOverride[] | undefined): number {
  if (!overrides || overrides.length === 0) return 0;
  let rewritten = 0;
  for (const item of items) {
    const result = applyOverridesToText(String(item.content ?? ''), overrides);
    if (result.applied.length === 0) continue;
    item.content = result.text;
    rewritten += 1;
  }
  return rewritten;
}

/** 带标签的权威值（4.55.20 实测：答疑「最高投标限价现调整为:172460314.52元」——
 * 金额挂在泛标签「精确参数」下无法归属，但**原文句子**含口径标签，可确定性归属到合同金额。
 * 注：该句出自 1 号答疑，其限价已被 5 号答疑的 157166591.34 元取代——此处引它只为说明
 * 抽取机制（同形句式在每份答疑都出现），现行值由时序号裁决给出，不是本条示例值） */
export interface LabeledAuthorityValue {
  attribute: '合同金额' | '计划工期' | '开工日期';
  value: string;
  source: string;
  /** 该值所在句含「作废/以本次答疑附件为准」类**资料作废声明**时标记（被作废来源的旧值应让位） */
  supersedesPriorMaterials: boolean;
  /** 该值处于**澄清/变更语境**（本段或上文段落含澄清标记）——后口径的确定性信号，
   * 供真值层 R2.5/R7 在同源同期候选里择出生效值 */
  clarified: boolean;
}

const LABELED_VALUE_RULES: Array<{ attribute: LabeledAuthorityValue['attribute']; re: RegExp }> = [
  // 口径标签（最高投标限价/招标控制价/合同估算价…）后 16 字内、且中间无**组成性标签**的金额即该口径的权威值
  { attribute: '合同金额', re: /(?:最高投标限价|招标控制价|合同估算价(?:格)?|工程估算价|投标限价)(?<gap>[^。；\n]{0,16}?)(?:现)?(?:调整)?为?\s*[:：]?\s*(?<num>[\d,]+(?:\.\d+)?)\s*(?<unit>亿元|万元|元)/u },
  { attribute: '计划工期', re: /(?:计划工期|合同工期|总工期)(?<gap>[^。；\n]{0,16}?)(?<num>[\d,]+(?:\.\d+)?)\s*个?\s*日历天/u },
  { attribute: '开工日期', re: /(?:计划)?开工日期(?<gap>[^。；\n]{0,8}?)[:：]?\s*(?<num>20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/u },
];
/**
 * 变更连接语（带标签值抽取复用）：命中时取连接语后的值为生效值（同句其余数值为旧口径）。
 *
 * **必须用非捕获组包住连接语**：`|` 的优先级最低，`A|B|C\s*[:：]?\s*(\d+)` 里的后缀只作用于
 * **最后一个**分支 C，其余分支会以「裸连接语」成功匹配且捕获组为 null。
 * 实测缺陷：`现变更修改为:330日历天` 命中「变更修改为」而 match[1]=null →
 * 「取变更后值」分支永不生效 → 工期 330 丢失、365 胜出（且时序裁决无从收敛）。
 */
const LABELED_CHANGE_RE = new RegExp(`(?:${CHANGE_CONNECTORS})\\s*[:：]?\\s*(\\d{1,4})\\s*个?\\s*日历天`, 'u');

/** 工期类口径标签（与距离无关的变更值兜底识别用） */
const DURATION_LABEL_RE = /(?:计划工期|合同工期|总工期|工期)/u;

/**
 * 组成性标签：口径标签与数值之间出现这类标签时，该数值是**组成部分**而非该口径的总额。
 * 实测缺陷：「本次最高投标限价暂列金额由4000000.00元调整为7000000.00元」被抽成
 * 合同金额 = 4000000.00元（暂列金额），并在时序裁决中压过真正的总额 157166591.34元。
 */
const COMPONENT_LABEL_RE = /(?:暂列|暂估|分部分项|单项工程|单位工程|措施项目|其他项目|规费|税金|人工费|材料费|机械费|管理费|利润|单价|合价)/u;

/**
 * 澄清语境标记（**段落级**）：答疑文件先复述提问（含原值）再给出澄清表——值本身的文本不含
 * 澄清词，语境落在段落上。实测缺陷：7号答疑「现澄清为如下：」下一段的
 * 「1.3.2计划工期计划开工日期：2026年10月10日」自身无任何标记，与提问段里被复述的旧值
 * 「2026年8月31日」在同源同优先级下无法区分 → R7 取数组靠前者 = 旧值。
 */
const CLARIFY_CONTEXT_RE = /现澄清为|现变更为|澄清为如下|澄清修改为|变更修改为|现调整为|全部作废|以本次[^。；\n]{0,10}为准|以澄清[^。；\n]{0,6}为准/u;

/** 提问重置：新提问段落（编号/「问：」且含问号）起，前文澄清语境失效（其后是被复述的**原值**） */
const QUESTION_RESET_RE = /^\s*(?:\d{1,2}\s*[、.．]|问\s*[:：])/u;

/** 从资料文本抽取「带口径标签的权威值」（金额/工期/开工日期），供真值层作为候选并入裁决 */
export function extractLabeledAuthorityValues(sources: Array<{ text: string; source: string }>): LabeledAuthorityValue[] {
  const out: LabeledAuthorityValue[] = [];
  const MATERIAL_VOID_RE = /作废|以本次(?:招标)?答疑附件(?:中材料)?为准|以澄清(?:文件)?为准/u;
  for (const item of sources) {
    const text = String(item.text || '');
    if (!text) continue;
    // 澄清语境**按段落推进**：新提问段落重置（其后是复述的原值），澄清标记段落点亮（其后是生效值）
    let clarifyContext = false;
    for (const paragraph of text.split(/\n\s*\n/u)) {
      if (QUESTION_RESET_RE.test(paragraph) && /[？?]/u.test(paragraph)) clarifyContext = false;
      if (CLARIFY_CONTEXT_RE.test(paragraph)) clarifyContext = true;
      for (const sentence of paragraph.split(/[。；;\n]/u)) {
        if (sentence.length < 6) continue;
        const supersedesPriorMaterials = MATERIAL_VOID_RE.test(sentence);
        const clarified = clarifyContext || CLARIFY_CONTEXT_RE.test(sentence);
        // 工期变更值兜底：口径标签与变更值之间可能隔着澄清发生日等信息
        //（实测：「本次招标项目计划工期于2026年08月05日变更修改为330日历天」——
        //  标签后 16 字窗口够不到 330，规则正则整体失配 → 候选为空）。
        // 只要同句出现工期口径标签 + 变更连接语，就以**连接语之后**的值为准。
        const durationChange = DURATION_LABEL_RE.test(sentence) ? LABELED_CHANGE_RE.exec(sentence)?.[1] : undefined;
        if (durationChange) {
          out.push({ attribute: '计划工期', value: `${durationChange}日历天`, source: item.source, supersedesPriorMaterials, clarified });
        }
        for (const rule of LABELED_VALUE_RULES) {
          // 工期变更值已由上一步取「连接语之后」的值，同一句不再按规则正则重复抽工期
          if (rule.attribute === '计划工期' && durationChange) continue;
          const match = rule.re.exec(sentence);
          if (!match?.groups) continue;
          const raw = match.groups.num?.replace(/,/gu, '') || '';
          if (!raw) continue;
          // 组成性标签拦截：口径标签与数值之间夹着「暂列金额/暂估价/单价…」时，该数值是组成部分不是总额
          if (COMPONENT_LABEL_RE.test(match.groups.gap || '')) continue;
          // 值必须带单位的**完整形态**：裸数字「365」会成为全局误替换的种子
          //（实测回归：工期值退化成「365」后，覆盖表变成 365 → 330日历天，
          //  正文里任意位置的 365 都会被替换，包括「1365」「365日历天」本身）
          const value = rule.attribute === '合同金额' ? `${raw}${match.groups.unit || ''}`
            : rule.attribute === '计划工期' ? `${raw}日历天`
            : raw.trim();
          out.push({ attribute: rule.attribute, value, source: item.source, supersedesPriorMaterials, clarified });
        }
      }
    }
  }
  return out;
}
