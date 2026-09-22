/**
 * 真值层（方案 v3 §2-§3）：实体-属性图 + 噪声闸 + 决定性裁决链。
 *
 * **为什么不是字段白名单**：属性名开放（不枚举），治理粒度是「某个主体某个属性的候选值集」，
 * 由**全序规则链**收敛到唯一值——新属性、新项目、新数据类型自动纳入，无需改代码。
 *
 * **四条原则的落点**：
 *   A 恒有值 —— resolve() 恒返回值（无候选时返回 undefined 由调用侧按"资料未提供"口径处理，
 *              但**有候选时必有唯一裁决**，不存在"待人工确认"分支）；
 *   B 不预设字段 —— attribute 开放；
 *   C 全自动裁决 —— R1..R7 全序，每级都有 tie-break；
 *   D 可溯源 —— 每条裁决带 { rule, evidence }。
 *
 * **噪声闸**（实测：`canonical.conflicts.project_name` 里「子项名称图名」来自 dwg 图签，
 * 与真项目名并列成"冲突"）：图签/OCR 残片/指向值/截断值/清单内部口径词在入图前剔除。
 */
import { CHANGE_CONNECTORS, classifyValueShape, type ValueOverride } from './valueOverride';
import { classifyPoolNoiseText } from './poolNoise';

export interface TruthCandidate {
  subject: string;
  attribute: string;
  value: string;
  source: string;
  /** 载体优先级（答疑/补遗 > 招标澄清 > 招标正文 > 清单 > 图纸 > 企业经验） */
  priority: number;
  /** 资料内出现序（越大越晚；用于同层级 tie-break） */
  order: number;
  /** 是否来自**澄清/变更语境**（该值所在文本含澄清/变更/补疑标记）——后口径的确定性信号 */
  clarified: boolean;
}

export interface ResolvedValue {
  subject: string;
  attribute: string;
  value: string;
  /** 裁决规则（R1..R7；进口径账本，机器可读） */
  rule: string;
  /** 依据资料（路径 + 原文片段） */
  evidence: Array<{ source: string; snippet: string }>;
  /** 被取代值（历史口径；正文不得再作为现行表述） */
  superseded: string[];
  /** 同属性全部候选（审计用） */
  candidates: TruthCandidate[];
}

export interface AuthoritativeValueAudit {
  resolved: ResolvedValue[];
  /** 噪声被剔除的值（可审计：证明"不是丢了，是判定为非值"） */
  noiseRejected: Array<{ attribute: string; value: string; source: string; reason: string }>;
}

/** 载体优先级（按来源串判定；不依赖字段） */
export function sourcePriority(source: string): number {
  const text = String(source || '');
  if (/补遗|补疑|答疑|澄清|question/i.test(text)) return 96;
  if (/招标|投标须知|招标公告/.test(text)) return 90;
  if (/清单|bill|boq|xls/i.test(text)) return 80;
  if (/图纸|dwg|施工图|设计说明/i.test(text)) return 75;
  if (/企业|公司|管理手册/.test(text)) return 60;
  return 70;
}

/** 来源内的"发布时序"指纹：答疑编号（"7招标答疑文件" → 7）/ 文件日期（2026.6.20 / 2026年6月20日） */
function sourceOrder(source: string): number {
  const dates = [...String(source || '').matchAll(/(20\d{2})[.\-年](\d{1,2})[.\-月](\d{1,2})/g)]
    .map(match => Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]));
  if (dates.length > 0) return Math.max(...dates);
  const index = /(\d{1,2})\s*(?:招标)?答疑文件/u.exec(source)?.[1];
  return index ? 1000 + Number(index) : 0;
}

/** 图签/图名类噪声（dwg 图签栏串格产物；实测「子项名称图名」进入 canonical 与真值争位）：
 * 必须带字段分隔符（冒号）或为独立短标签——否则会误伤以这些字开头的真值
 *（实测误伤：「专业工程暂估价」被 `^(?:…|专业|…)?` 命中整条剔除，而它是合法清单项）。 */
const DRAWING_SIGNATURE_VALUE_RE = /^(?:子项名称|图名|图号|比例|制图|审核|版次)\s*[：:]/u;
/** 独立短标签（无冒号也算图签格） */
const DRAWING_SIGNATURE_BARE_RE = /^(?:子项名称图名|图名图号|设计单位名称|制图人|审核人|比例尺)$/u;
/** 占位/未提供类值（实测「【清单未体现】」在最新答疑文件里胜出成"生效工期"——垃圾值必须拦在闸外） */
const PLACEHOLDER_VALUE_RE = /^(?:【[^】]{0,16}】|—+|待定|暂无?|未提供|详见|如上|同前)$/u;
/** 指向值（非值本身） */
const POINTER_VALUE_RE = /^(?:见|详见|参见|按|依据)\s*(?:招标文件|招标公告|投标须知|图纸|设计|清单|规范|合同)/u;
/** 内部口径词（清单计价表专用词，非工程内容） */
const INTERNAL_CALIBER_RE = /^(?:分部小计|本页小计|小计|合计|总计|综合单价|措施项目费|规费|税金|按实|暂估|暂列金额)$/u;

/** 噪声判定（返回原因；undefined = 可用值）
 * @param options.allowProse 事实池入口使用：允许长句值（段落判定只在真值层做值语义判定时启用） */
export function rejectValueNoise(value: string, options: { allowProse?: boolean; includePoolNoise?: boolean } = {}): string | undefined {
  const text = String(value || '').trim();
  if (!text) return '空值';
  if (text.length > 260) return '超长（疑为段落而非值）';
  // OCR 复写噪声（实测：「于注：本次招标项目计划工期于年年月月日变更修改为日变更修改为日」）：
  // 单字连续重复出现 ≥2 处即判复写残片（正常值「MU15粉煤灰多孔砖」「合格」无此形态）
  if ((text.match(/([\u4e00-\u9fa5])\1/gu) || []).length >= 2) return 'OCR 复写噪声';
  // 段落冒充值（实测：质量标准取到整句「本工程的质量及操作须符合《…》DGJ08-118-2005的要求。」）：
  // 值必须是短语级；长句以句末标点收尾 → 段落，不是值
  if (!options.allowProse && text.length > 40 && /[。；!？]$/u.test(text)) return '段落而非值';
  if (DRAWING_SIGNATURE_VALUE_RE.test(text) && text.length <= 14) return '图签/图名串格';
  if (DRAWING_SIGNATURE_BARE_RE.test(text)) return '图签/图名串格';
  if (PLACEHOLDER_VALUE_RE.test(text)) return '占位/未提供值';
  // 指向值（实测：「见招标公告计划开工日期：2026年08月31日…」整句作为"工期值"胜出——
  // 指向句不是值；其内嵌字段由内嵌展开步骤归属到正确属性，此处整句剔除）
  if (POINTER_VALUE_RE.test(text)) return '指向值（非值本身）';
  if (INTERNAL_CALIBER_RE.test(text)) return '清单内部口径词';
  // 表格串格：一格内串进 **≥3** 个「标签：值」对（实测「安徽省巢湖市 ，建筑面积：72062.84 ，层数：层，
  // 高度：23.950」）；阈值 3 是刻意的——「联系人：张三，电话：138…」是两个标签的**单条事实**，
  // 由程序性值语义复核处理，不能在此整条剔除（边界测试固化）
  if ((text.match(/[\u4e00-\u9fa5]{2,8}\s*[:：]/gu) || []).length >= 3) return '表格串格（多字段粘连）';
  if (options.includePoolNoise !== false && classifyPoolNoiseText(text)) return '池噪声（图签/坐标/残片/粘连）';
  // 截断值：以连接词/虚词结尾且无句末标点（「…位于巢湖市居巢」「…以及」）
  if (text.length >= 12 && /(?:以及|和|与|或|的|了|在|为|按|由|及)$/u.test(text)) return '截断值';
  return undefined;
}

/**
 * 值形态清洗（方案 §5）：剥离尾部括号噪声，保留主体值——
 * 实测：`基坑开挖深度 = 1.75m（图纸标注：0.5m/s ，基坑深度 -1.7 米（余同）；…重复三次…）`
 * → 主体值 `1.75m`（括号内为图纸标注重复串，不是值的一部分）。
 * 保守边界：仅当括号内长度 ≥ 12 且含重复/噪声特征（分号重复、"余同"、"标注："）时剥离；
 * 括号内是值的合法限定（如 `C30（抗渗P8）`）时保留原样。
 */
export function cleanValueForm(value: string): { value: string; note?: string } {
  const text = String(value || '').trim();
  const match = /^(?<main>[^（(]{1,40})[（(](?<inner>[\s\S]{12,})[）)]\s*$/u.exec(text);
  if (!match?.groups) return { value: text };
  const inner = match.groups.inner;
  const noisy = /；|;|余同|标注：|图纸标注|以下同/u.test(inner) || inner.length > 30;
  if (!noisy) return { value: text };
  return { value: match.groups.main.trim(), note: inner.slice(0, 80) };
}

/**
 * 内嵌字段展开：一条事实值里嵌着其他字段的标签+值（答疑表/澄清表常见形态）——
 * 实测：「见招标公告计划开工日期：2026年08月31日…」「现澄清为如下：…计划工期计划开工日期：2026年10月10日…」
 * 内嵌的「开工日期：2026年10月10日」应归属**开工日期**属性，而不是整体挂在"计划工期"名下。
 * 实现：按冒号切分（标签=前一段尾部汉字串 ≤10 字；值=后一段前 40 字）——
 * 整串贪婪匹配会把「计划开工日期」吞进上一段的值里，导致标签丢失（实测缺陷）。
 */
export function unpackEmbeddedFields(key: string, label: string | undefined, value: string): Array<{ attribute: string; value: string }> {
  const text = String(value || '');
  const results: Array<{ attribute: string; value: string }> = [];
  const outerAttribute = normalizeAttributeName(key, label);
  const segments = text.split(/[：:]/u);
  // 标签停用词（**关键**）：变更连接语/连接词不是字段标签——
  // 实测缺陷：「365日历天，现变更修改为:330日历天」把「现变更修改为」当标签，330 被归到该伪属性，
  // 且主候选被"内嵌归属"守卫跳过 → 工期只剩 365 一个候选（R1 无从收敛）
  const LABEL_STOPWORD_RE = /(?:变更|澄清|修改|调整|更正|修正|如下|其中|例如|即|注|说明)$|为$/u;
  for (let index = 0; index + 1 < segments.length; index += 1) {
    const labelRun = /([\u4e00-\u9fa5]{2,10})$/u.exec(segments[index] || '')?.[1];
    if (!labelRun) continue;
    if (LABEL_STOPWORD_RE.test(labelRun)) continue;
    const embeddedValue = (segments[index + 1] || '').trim().slice(0, 40);
    if (!/\d/u.test(embeddedValue)) continue;
    const attribute = normalizeAttributeName(labelRun, labelRun);
    if (!attribute || attribute === outerAttribute) continue;
    results.push({ attribute, value: embeddedValue });
  }
  return results;
}

/**
 * 值 token 抽取（形态驱动）：句子形态的值里取出**该形态的值本体**——
 * 实测：「本次招标项目计划工期于2026年08月05日变更修改为330日历天。」作为"工期值"胜出，
 * 需取「330日历天」（变更连接语后的 token）而非整句。
 * 规则：① 若值中含变更连接语 → 取连接语后第一个该形态 token；② 否则取最后一个该形态 token。
 */
export function extractValueToken(value: string, shape: string): string {
  const text = String(value || '').trim();
  const patterns: Record<string, RegExp> = {
    date: /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/gu,
    money: /\d+(?:\.\d+)?\s*(?:万元|亿元|元)/gu,
    standard: /(?:GB|JGJ|CJJ|DB|CECS|ISO|IEC)\s*\/?\s*T?\s*[\d.]+(?:-\d{2,4})?/giu,
    spec: /(?:C\d{2,3}|HRB\d{3,4}|HPB\d{3}|DN\s*\d+|Φ\s*\d+|φ\s*\d+|\d+(?:\.\d+)?\s*(?:mm|cm|kV|MPa|kPa|kW|W|A|V))/gu,
    measure: /\d+(?:\.\d+)?\s*(?:m2|m3|m²|m³|㎡|m|km|kg|t|吨|个|座|套|台|根|块|樘|扇|片|组|件|孔|盏|项|处|层|日历天|天|%)/gu,
  };
  if (shape === 'text') return text.slice(0, 80);
  const source = (patterns[shape] || patterns.measure!).source;
  const tokens = [...text.matchAll(new RegExp(source, 'gu'))].map(match => match[0].trim());
  if (tokens.length === 0) return text.slice(0, 80);
  const connector = new RegExp(`${CHANGE_CONNECTORS}\\s*[:：]?`, 'u').exec(text);
  if (connector) {
    const after = text.slice(connector.index + connector[0].length);
    const next = new RegExp(source, 'u').exec(after);
    if (next) return next[0].trim();
  }
  return tokens[tokens.length - 1]!;
}

/**
 * 值本体抽取 + 形态判定（**先取 token 再定形态**）：
 * 实测缺陷：整句 `本次招标项目计划工期于2026年08月05日变更修改为330日历天。` 先被判成 date
 * → 抽出「2026年08月05日」（澄清发生日）当作工期。正确顺序是：有变更连接语 → 取连接语后的 token
 * 并用**该 token** 的形态定类；无连接语 → 取该值中出现次数最多的形态 token。
 */
export function extractValueAndShape(value: string): { value: string; shape: string } {
  const text = String(value || '').trim();
  if (!text) return { value: '', shape: 'text' };
  const connector = new RegExp(`${CHANGE_CONNECTORS}\\s*[:：]?`, 'u').exec(text);
  const scanText = connector ? text.slice(connector.index + connector[0].length) : text;
  // 候选形态优先级：日期/金额/规范 是"整值型"；measure/spec 是"数值型"
  const shapeOrder: Array<{ shape: string; re: RegExp }> = [
    { shape: 'date', re: /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/u },
    { shape: 'money', re: /\d+(?:\.\d+)?\s*(?:万元|亿元|元)/u },
    { shape: 'standard', re: /(?:GB|JGJ|CJJ|DB|CECS|ISO|IEC)\s*\/?\s*T?\s*[\d.]+/iu },
    { shape: 'spec', re: /(?:C\d{2,3}|HRB\d{3,4}|HPB\d{3}|DN\s*\d+|Φ\s*\d+|φ\s*\d+|\d+(?:\.\d+)?\s*(?:mm|cm|kV|MPa|kPa|kW|W|A|V))/u },
    { shape: 'measure', re: /\d+(?:\.\d+)?\s*(?:m2|m3|m²|m³|㎡|m|km|kg|t|吨|个|座|套|台|根|块|樘|扇|片|组|件|孔|盏|项|处|层|日历天|天|%)/u },
  ];
  const hits = shapeOrder.filter(candidate => candidate.re.test(scanText));
  if (hits.length === 0) return { value: text.slice(0, 80), shape: 'text' };
  // 有连接语时优先"连接语后紧邻"的形态；否则取首位命中形态
  const chosen = hits[0]!;
  return { value: extractValueToken(text, chosen.shape), shape: chosen.shape };
}
/** 地址尾部 OCR 垃圾剥离：中文地址后紧跟的长拉丁/数字串（图签串格）截断——
 * 实测：「…交口北ZHC55640X5000铝合金窗框普通单层玻璃」→ 取「…交口北」 */
export function stripTrailingOcrGarbage(value: string): string {
  const text = String(value || '').trim();
  const latin = /[\u4e00-\u9fa5]([A-Za-z][A-Za-z0-9]{5,})/u.exec(text);
  let result = latin ? text.slice(0, (latin.index ?? 0) + 1) : text;
  // 尾部纯数字垃圾（地址串格：「…交口北0000」→「…交口北」）
  result = result.replace(/([\u4e00-\u9fa5])\d{3,}$/u, '$1');
  // 中文之间的长数字串（坐标/图号串格）——**仅对地址形值生效**：
  // 全局剥离会把「…变更修改为330330日」这类值剥成残句并使其逃脱噪声判据（实测回归）
  if (/省|市|区|县|路|街|交口|镇|乡/u.test(result)) {
    result = result.replace(/([\u4e00-\u9fa5])[\d\s]{3,}(?=[\u4e00-\u9fa5]|$)/gu, '$1');
  }
  return result;
}

/** 属性名归一（同义/别名/编号族合并；实测 `duration` 与 `schedule_requirement` 两条工期值并存） */
export function normalizeAttributeName(key: string, label?: string): string {
  const raw = `${label || ''}${key || ''}`.replace(/\s+/gu, '');
  if (!raw) return '';
  // 具体字段优先（「计划开工日期」必须归到开工日期，不能被 /工期/ 抢先归成计划工期）
  if (/开工日期|开工时间|startDate/i.test(raw)) return '开工日期';
  if (/竣工日期|完工日期|endDate/i.test(raw)) return '竣工日期';
  if (/质量标准|质量目标|quality/i.test(raw)) return '质量标准';
  if (/建设规模|建筑面积|规模|scale/i.test(raw)) return '建设规模';
  if (/建设地点|工程地点|location/i.test(raw)) return '建设地点';
  if (/招标人|建设单位|owner/i.test(raw)) return '招标人';
  if (/估算|限价|控制价|投资|金额|amount/i.test(raw)) return '合同金额';
  if (/项目名称|工程名称|projectName/i.test(raw)) return '项目名称';
  if (/项目编号|工程编号|projectCode/i.test(raw)) return '项目编号';
  if (/工期|日历天|duration|schedule/i.test(raw) && !/节点|阶段|考核|开工|竣工/i.test(raw)) return '计划工期';
  // 未识别属性：保留原名（不丢信息，属性开放）
  return raw.slice(0, 40);
}

/**
 * 决定性裁决链（R1..R7，全序）：
 * 候选集 → R1 变更链（被取代值出局）→ R2 载体优先级 → R3 时序 → R4 同源条款序
 * → R5 形态类型专属权威 → R6 证据计数 → R7 兜底（按形态定义）→ 唯一值
 */
function arbitrate(candidates: TruthCandidate[], overrides: ValueOverride[]): { winner: TruthCandidate; rule: string; superseded: string[] } | undefined {
  if (candidates.length === 0) return undefined;
  const supersededSet = new Set<string>();
  for (const override of overrides) {
    if (override.kind !== 'override') continue;
    if (candidates.some(candidate => candidate.value.includes(override.superseded))) supersededSet.add(override.superseded);
  }
  // R1 变更链：被取代值出局（全被取代时保留最后一个，遵循"恒有值"）
  let pool = candidates.filter(candidate => ![...supersededSet].some(value => candidate.value.includes(value)));
  if (pool.length === 0) pool = [...candidates];
  const ruleOf = (name: string, narrowed: TruthCandidate[]) => ({ winner: narrowed[0]!, rule: name, superseded: [...supersededSet] });
  if (pool.length === 1) return { winner: pool[0]!, rule: 'R1', superseded: [...supersededSet] };
  // R1.5 形态偏好（地址类）：候选里存在**强地址形**（含 路/街/号/交口 等地址构造）而另一些不是时，
  // 先按形态收窄——载体优先级不应把"项目名片段/表格串格"抬成地址（实测：建设地点取到「…项目一东区」）
  const STRONG_ADDRESS_RE = /(?:路|街|道|巷|号|交口|北侧|南侧|东侧|西侧|经开区|开发区|镇|村)/u;
  const strongAddress = pool.filter(candidate => STRONG_ADDRESS_RE.test(candidate.value) && /省|市|区|县/u.test(candidate.value));
  if (strongAddress.length > 0 && strongAddress.length < pool.length) pool = strongAddress;
  if (pool.length === 1) return { winner: pool[0]!, rule: 'R1.5', superseded: [...supersededSet] };
  // R2 载体优先级
  const maxPriority = Math.max(...pool.map(candidate => candidate.priority));
  let narrowed = pool.filter(candidate => candidate.priority === maxPriority);
  if (narrowed.length === 1) return ruleOf('R2', narrowed);
  // R2.5 澄清语境优先：来自澄清/变更语境的值是**后口径**（实测：开工日期 2026-10-10 出自澄清表、
  // 2026-08-31 出自"见招标公告"的指针句 —— 同来源同优先级时，澄清语境者是生效值）
  const clarifiedOnes = narrowed.filter(candidate => candidate.clarified);
  if (clarifiedOnes.length > 0 && clarifiedOnes.length < narrowed.length) narrowed = clarifiedOnes;
  if (narrowed.length === 1) return { winner: narrowed[0]!, rule: 'R2.5', superseded: [...supersededSet] };
  // R3 时序（后发布者胜；仅按**来源发布时序**，不按数组下标——同文件内出现序不代表时间先后）
  const maxOrder = Math.max(...narrowed.map(candidate => sourceOrder(candidate.source)));
  if (maxOrder > 0) {
    // 比"来源发布时序"本身（不用 recordIndex——同文件内出现序不代表时间先后）
    const byOrder = narrowed.filter(candidate => sourceOrder(candidate.source) === maxOrder);
    if (byOrder.length === 1) return { winner: byOrder[0]!, rule: 'R3', superseded: [...supersededSet] };
    narrowed = byOrder;
  }
  // R4 同源条款序（同文件内后修订：条款号大者胜）
  const clauseOf = (candidate: TruthCandidate) => {
    const hit = /(\d{1,2}(?:\.\d{1,2}){1,3})/u.exec(candidate.source + candidate.value);
    return hit ? Number(hit[1]!.split('.').reduce((sum, part) => sum + Number(part), 0)) : 0;
  };
  const sameSource = new Set(narrowed.map(candidate => candidate.source)).size === 1;
  if (sameSource) {
    const maxClause = Math.max(...narrowed.map(clauseOf));
    if (maxClause > 0) {
      const byClause = narrowed.filter(candidate => clauseOf(candidate) === maxClause);
      if (byClause.length === 1) return { winner: byClause[0]!, rule: 'R4', superseded: [...supersededSet] };
      narrowed = byClause;
    }
  }
  // R5 形态类型专属权威（工程实体参数以清单/图纸为准；规范引用合并全集）
  // 地址形态优先：候选里只要存在"地址形"值（省/市/区/路/街/号/交口），排除非地址形（清单串格文本）
  const ADDRESS_RE = /(?:省|市|区|县|镇|路|街|道|巷|号|交口|北侧|南侧|东侧|西侧|经开区|开发区)/u;
  const addressLike = narrowed.filter(candidate => ADDRESS_RE.test(candidate.value));
  if (addressLike.length >= 1 && addressLike.length < narrowed.length) {
    const longest = addressLike.reduce((best, candidate) => (candidate.value.length > best.value.length ? candidate : best), addressLike[0]!);
    return { winner: longest, rule: 'R5', superseded: [...supersededSet] };
  }
  const shape = classifyValueShape(narrowed[0]!.value);
  if (shape === 'measure' || shape === 'spec') {
    const entityFirst = narrowed.filter(candidate => sourcePriority(candidate.source) <= 80);
    if (entityFirst.length === 1) return { winner: entityFirst[0]!, rule: 'R5', superseded: [...supersededSet] };
    if (entityFirst.length > 1) narrowed = entityFirst;
  }
  if (shape === 'money') {
    const tenderFirst = narrowed.filter(candidate => sourcePriority(candidate.source) >= 90);
    if (tenderFirst.length === 1) return { winner: tenderFirst[0]!, rule: 'R5', superseded: [...supersededSet] };
    if (tenderFirst.length > 1) narrowed = tenderFirst;
  }
  // R6 证据计数（同一值出现次数多者胜）
  const counts = new Map<string, number>();
  for (const candidate of narrowed) counts.set(candidate.value, (counts.get(candidate.value) || 0) + 1);
  const maxCount = Math.max(...counts.values());
  const byCount = narrowed.filter(candidate => counts.get(candidate.value) === maxCount);
  if (byCount.length === 1) return { winner: byCount[0]!, rule: 'R6', superseded: [...supersededSet] };
  narrowed = byCount;
  // R7 兜底（按形态；不含任何"自行取舍"的方向选择）
  if (shape === 'standard') return { winner: narrowed[0]!, rule: 'R7', superseded: [...supersededSet] }; // 规范引用：并存合并
  if (shape === 'measure' || shape === 'spec' || shape === 'money') {
    // 工程实体/造价：取来源优先级最高者（R2 已过滤同层）中资料出现最晚者
    const latest = narrowed.reduce((best, candidate) => (candidate.order > best.order ? candidate : best), narrowed[0]!);
    return { winner: latest, rule: 'R7', superseded: [...supersededSet] };
  }
  // 文本类：取更具体者（含数字/规格者优先于泛化表述）
  const specific = narrowed.filter(candidate => /\d/u.test(candidate.value));
  return { winner: (specific.length > 0 ? specific : narrowed)[0]!, rule: 'R7', superseded: [...supersededSet] };
}

/** 构建真值层（读侧：只产出裁决结果与审计，不改写作） */
export function buildAuthoritativeValues(input: {
  facts: Array<{ key?: string; label?: string; value?: unknown; sourceFile?: string; source?: string }>;
  overrides?: ValueOverride[];
  /** 主体推导（默认按来源文件归属，未知时 ''） */
  subjectOf?: (fact: { key?: string; label?: string; sourceFile?: string }) => string;
}): AuthoritativeValueAudit {
  const overrides = input.overrides || [];
  const noiseRejected: AuthoritativeValueAudit['noiseRejected'] = [];
  const byAttribute = new Map<string, TruthCandidate[]>();
  input.facts.forEach((fact, index) => {
    const value = String(fact.value ?? '').trim();
    if (!value) return;
    const attribute = normalizeAttributeName(String(fact.key || ''), fact.label);
    if (!attribute) return;
    const source = String(fact.sourceFile || fact.source || '');
    const cleaned = cleanValueForm(value);
    const source0 = String(fact.sourceFile || fact.source || '');
    const subject0 = input.subjectOf ? input.subjectOf({ key: fact.key, label: fact.label, sourceFile: source0 }) : '';
    // 澄清语境信号（**只看值所在文本**，不看来源文件类型）：该值文本含澄清/变更/修改为标记 → 后口径。
    // 反例守卫：答疑文件里的**引用招标原文**（「见招标公告计划开工日期：2026年08月31日」）虽来自答疑，
    // 但值本身是指向招标文本的指针，不是澄清值——按来源一刀切会把招标旧值也标成"后口径"（实测回归）。
    const clarified = /澄清|变更|补疑|补遗|修改为|调整为|更正/u.test(cleaned.value)
      && !/^(?:见|详见|参见)/u.test(cleaned.value);
    const pushCandidate = (targetAttribute: string, targetValue: string) => {
      const list = byAttribute.get(targetAttribute) || [];
      list.push({
        subject: subject0,
        attribute: targetAttribute,
        value: targetValue,
        source: source0,
        priority: sourcePriority(source0),
        order: sourceOrder(source0) * 1000 + index,
        clarified,
      });
      byAttribute.set(targetAttribute, list);
    };
    // 内嵌字段**先展开**：指向句/澄清表里的真值（「计划开工日期：2026年10月10日」）不能被外层噪声一起丢掉
    const embeddedFields = unpackEmbeddedFields(String(fact.key || ''), fact.label, cleaned.value);
    for (const embedded of embeddedFields) {
      const embeddedClean = cleanValueForm(embedded.value);
      const embeddedValue = extractValueAndShape(embeddedClean.value).value;
      if (rejectValueNoise(embeddedValue)) continue;
      pushCandidate(embedded.attribute, embeddedValue);
    }
    const noise = rejectValueNoise(cleaned.value);
    if (noise) {
      noiseRejected.push({ attribute, value: cleaned.value.slice(0, 60), source, reason: noise });
      return;
    }
    const normalizedValue = stripTrailingOcrGarbage(extractValueAndShape(cleaned.value).value);
    // 抽出的 token 若正是某个**内嵌标签**的值（如外层键为「计划工期」而值是「计划开工日期：2026年10月10日」），
    // 该值已按内嵌标签归属到正确属性（开工日期），不得再挂到外层属性名下（实测缺陷：工期被填入日期）
    if (embeddedFields.some(embedded => embedded.value.includes(normalizedValue) || normalizedValue.includes(embedded.value.replace(/[（(].*$/u, '').trim()))) return;
    if (rejectValueNoise(normalizedValue)) {
      // 地址类值：剥尾部 OCR 垃圾后若成为合法地址则保留（实测「…交口北ZHC55640X5000铝合金」应清洗保留）
      const stripped = stripTrailingOcrGarbage(cleaned.value).slice(0, 80);
      if (!/省|市|区|县|路|街|交口/u.test(stripped) || rejectValueNoise(stripped)) return;
      pushCandidate(attribute, stripped);
      return;
    }
    pushCandidate(attribute, normalizedValue);
  });
  const resolved: ResolvedValue[] = [];
  for (const [attribute, candidates] of byAttribute) {
    const result = arbitrate(candidates, overrides);
    if (!result) continue;
    resolved.push({
      subject: result.winner.subject,
      attribute,
      value: result.winner.value,
      rule: result.rule,
      evidence: [{ source: result.winner.source, snippet: result.winner.value.slice(0, 120) }],
      superseded: result.superseded.filter(value => value !== result.winner.value),
      candidates,
    });
  }
  resolved.sort((left, right) => left.attribute.localeCompare(right.attribute, 'zh-Hans-CN'));
  return { resolved, noiseRejected };
}

/**
 * 写作硬约束块（真值层出口，取代 4.55.17 的窄口径约束）：
 * 凡有被取代值的属性 → 「现行为 X；被取代值 Y 不得再作为现行口径」。
 * 与窄口径版（clarificationOverrides）相比：不限于工期/开工日期，覆盖**全部发生变更的属性**
 *（含金额、规格、做法等任意数据类型——变更由值级覆盖识别，与字段无关）。
 */
export function renderTruthConstraintBlock(audit: AuthoritativeValueAudit): string {
  const rows = audit.resolved.filter(item => item.superseded.length > 0);
  if (rows.length === 0) return '';
  return [
    '【现行口径（真值层裁决，硬约束）】下列属性已按资料优先级与变更链裁决出**唯一现行值**；全文（正文、表格、信息表、进度计划、节点）必须一致使用，被取代值仅在引用变更过程时可出现（如「招标文件原为 X，经答疑澄清变更为 Y」），不得单独陈述现状：',
    ...rows.map(item => `- ${item.attribute}：现行为「${item.value}」；被取代（不得作为现行口径）：${item.superseded.join('、')}`),
  ].join('\n');
}

/** 口径账本（交付报告可展开：属性/生效值/裁决规则/依据/被取代值） */
export function renderCaliberLedger(audit: AuthoritativeValueAudit): string[] {
  return audit.resolved.map(item => {
    const base = `${item.attribute} = ${item.value}（裁决 ${item.rule}；依据 ${item.evidence[0]?.source || '—'}）`;
    return item.superseded.length > 0 ? `${base}；被取代：${item.superseded.join('、')}` : base;
  });
}

/**
 * 判定唯一性自检（方案 v3 §4）：真值层的生效值必须与**正文声明口径**一致。
 * 现状缺陷（实测）：同一事实被四类消费者各自取值各自判——蓝图按 365 推导进度表、正文按 330 写、
 * 检测器按第三种口径判。本函数把「真值层 ↔ 正文」的比对显性化，作为构建期一致性断言的一部分。
 */
export function caliberConsistencyIssues(markdown: string, audit: AuthoritativeValueAudit): Array<{ attribute: string; expected: string; message: string }> {
  const issues: Array<{ attribute: string; expected: string; message: string }> = [];
  if (!markdown || audit.resolved.length === 0) return issues;
  const normalized = markdown.replace(/\s+/gu, '');
  for (const item of audit.resolved) {
    const shape = classifyValueShape(item.value);
    if (!['measure', 'money', 'date', 'standard'].includes(shape)) continue;
    const token = item.value.replace(/\s+/gu, '');
    if (!token || token.length < 2) continue;
    if (normalized.includes(token)) continue;
    issues.push({
      attribute: item.attribute,
      expected: item.value,
      message: `口径不一致：真值层「${item.attribute}」生效值为「${item.value}」（裁决 ${item.rule}，依据 ${item.evidence[0]?.source || '—'}），但正文未按该口径落位`,
    });
  }
  return issues;
}
