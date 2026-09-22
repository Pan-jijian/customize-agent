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
      const context = result.slice(Math.max(0, offset - 12), offset + match.length + 12);
      if (new RegExp(`${CHANGE_CONNECTORS}|原(?:为|值)|此前|由`, 'u').test(context)) return match;
      applied.push({ from: match, to: override.effective });
      return override.effective;
    });
    result = next;
  }
  return { text: result, applied };
}

/** 带标签的权威值（4.55.20 实测：答疑「最高投标限价现调整为:172460314.52元」——
 * 金额挂在泛标签「精确参数」下无法归属，但**原文句子**含口径标签，可确定性归属到合同金额） */
export interface LabeledAuthorityValue {
  attribute: '合同金额' | '计划工期' | '开工日期';
  value: string;
  source: string;
  /** 该值所在句含「作废/以本次答疑附件为准」类**资料作废声明**时标记（被作废来源的旧值应让位） */
  supersedesPriorMaterials: boolean;
}

const LABELED_VALUE_RULES: Array<{ attribute: LabeledAuthorityValue['attribute']; re: RegExp }> = [
  // 口径标签（最高投标限价/招标控制价/合同估算价…）后 16 字内的金额即该口径的权威值
  { attribute: '合同金额', re: /(?:最高投标限价|招标控制价|合同估算价(?:格)?|工程估算价|投标限价)[^。；\n]{0,16}?(?:现)?(?:调整)?为?\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*(亿元|万元|元)/u },
  { attribute: '计划工期', re: /(?:计划工期|合同工期|总工期)[^。；\n]{0,16}?([\d,]+(?:\.\d+)?)\s*个?\s*日历天/u },
  { attribute: '开工日期', re: /(?:计划)?开工日期[^。；\n]{0,8}?[:：]?\s*(20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/u },
];
/** 变更连接语（带标签值抽取复用）：命中时取连接语后的值为生效值（同句其余数值为旧口径） */
const LABELED_CHANGE_RE = new RegExp(`${CHANGE_CONNECTORS}\\s*[:：]?\\s*(\\d{1,4})\\s*个?\\s*日历天`, 'u');

/** 从资料文本抽取「带口径标签的权威值」（金额/工期/开工日期），供真值层作为候选并入裁决 */
export function extractLabeledAuthorityValues(sources: Array<{ text: string; source: string }>): LabeledAuthorityValue[] {
  const out: LabeledAuthorityValue[] = [];
  const MATERIAL_VOID_RE = /作废|以本次(?:招标)?答疑附件(?:中材料)?为准|以澄清(?:文件)?为准/u;
  for (const item of sources) {
    const text = String(item.text || '');
    if (!text) continue;
    for (const sentence of text.split(/[。；;\n]/u)) {
      if (sentence.length < 6) continue;
      const supersedesPriorMaterials = MATERIAL_VOID_RE.test(sentence);
      for (const rule of LABELED_VALUE_RULES) {
        const match = rule.re.exec(sentence);
        if (!match) continue;
        const raw = match[1]?.replace(/,/gu, '') || '';
        if (!raw) continue;
        // 变更连接语优先：同句含「现变更修改为:330日历天」时取**变更后**值（实测：原实现取首个数值=365）
        if (rule.attribute === '计划工期') {
          const changed = LABELED_CHANGE_RE.exec(sentence)?.[1];
          if (changed) {
            out.push({ attribute: '计划工期', value: `${changed}日历天`, source: item.source, supersedesPriorMaterials });
            continue;
          }
          out.push({ attribute: '计划工期', value: `${raw}日历天`, source: item.source, supersedesPriorMaterials });
          continue;
        }
        const value = rule.attribute === '合同金额' ? `${raw}${match[2] || ''}` : (match[1] || '').trim();
        out.push({ attribute: rule.attribute, value, source: item.source, supersedesPriorMaterials });
      }
    }
  }
  return out;
}
