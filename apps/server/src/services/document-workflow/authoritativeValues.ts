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
  /** 是否**项目级口径**（单值型：原文带口径标签抽取，如「最高投标限价…」「计划工期…」「开工日期…」）。
   *
   * 4.55.29：口径终检的「正文须逐字落位」判据只对**口径**成立——它要求正文复现该值，
   * 这只有在写手**被告知过**这个口径时才是正当的。写作侧（stageUnderstanding/stageOutlinePlanning/
   * derive）一直以 `labeledValues` 划定口径集（`caliberAttributes`），finalize 读侧现与之同源；
   * 非口径属性（「底坑垫层做法」「钢筋连接」「主要材料包括」这类**章节内容型**属性）的值是写作素材，
   * 不得要求逐字落位——否则产出写手从未被告知、也永不消解的 blocker。 */
  caliber: boolean;
  /** 同属性全部候选（审计用） */
  candidates: TruthCandidate[];
}

export interface AuthoritativeValueAudit {
  resolved: ResolvedValue[];
  /** 噪声被剔除的值（可审计：证明"不是丢了，是判定为非值"） */
  noiseRejected: Array<{ attribute: string; value: string; source: string; reason: string }>;
}

/** 澄清/变更载体的来源指纹（答疑 / 澄清 / 补疑 / 补遗 / 问答） */
const CLARIFY_SOURCE_RE = /补遗|补疑|答疑|澄清|question/i;

/** 载体优先级（按来源串判定；不依赖字段） */
export function sourcePriority(source: string): number {
  const text = String(source || '');
  if (CLARIFY_SOURCE_RE.test(text)) return 96;
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
  // 序号形态扩围（实测：答疑/澄清/补遗/补疑 各有编号文件——「5招标答疑文件」「6招标澄清文件」，
  // 原实现只认「答疑文件」→「6招标澄清文件」的发布时间指纹为 0，时序比较失效）
  const index = /(\d{1,2})\s*(?:招标)?(?:答疑|澄清|补遗|补疑)(?:文件|公告|书)?/u.exec(source)?.[1];
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

/**
 * **缺席声明**（4.55.29 L0-1）：值本身在声明「资料没有给出该信息」，不是信息。
 *
 * 实测根因（巢湖 4.55.29 终稿）：LLM 抽取通道在无对应资料时**自行写出**「未在资料中明确体现」
 * 作为字段值，原闭集（待定|未提供|详见|如上|同前）未覆盖 → 缺席声明经 R 链裁决成真值层的
 * **生效值**，口径终检随即要求正文逐字落位「项目编号 = 未在资料中明确体现」
 *（正文没照写是正确的，照写才是缺陷）。缺席声明的正确归宿是 `missing`，不是值。
 *
 * 判据（机制，整值形态而非子串）：剥去书名号/方括号与尾部标点后，**整值**是缺席声明。
 * 只认「整值即声明」，不认句中含「未」——`未经处理的原土`/`未筛分碎石`/`未注明的按设计`
 * 这类合法值带实质内容，不以本族形态开头或收尾，不受影响。
 */
const ABSENCE_DECLARATION_RE = /^(?:【[^】]{0,24}】|—+|[待暂](?:定|补充|确认|核实|无|缺)|不详|未知|不适用|未在资料(?:中|里)?(?:明确)?(?:体现|给出|提供|说明|标注|载明|列明|查到|查得)|(?:资料|文件|图纸|清单)(?:中|里)?(?:均|也)?未(?:明确|体现|给出|提供|说明|标注|载明|列明|涉及|提及|查到)|未(?:明确|体现|提供|涉及|提及|给出|标注|说明|描述|予明确|查到)|系统暂未(?:从知识库确认)?|无法确认|无相关(?:资料|信息|内容|记录)|无此(?:项|内容|信息)|以(?:图纸|清单|资料|招标文件)为准|详见|如上|同前|同上)$/u

/** 缺席声明判定（剥括号与尾部标点后整值匹配；长度上界防长段落借首词命中）
 * 导出供事实冲突检测同源复用（缺席声明不是可比值，不得参与多源对账）。 */
export function isAbsenceDeclaration(text: string): boolean {
  const bare = text.replace(/^【/u, '').replace(/】$/u, '').replace(/[\s。；;，,、.．]+$/u, '').trim();
  return bare.length > 0 && bare.length <= 24 && ABSENCE_DECLARATION_RE.test(bare);
}
/** 指向值（非值本身） */
const POINTER_VALUE_RE = /^(?:见|详见|参见|按|依据)\s*(?:招标文件|招标公告|投标须知|图纸|设计|清单|规范|合同)/u;
/** 商务口径（技术标不承载）：与参数池商务红线同族，用于把「须逐字落位」限制在工程口径上 */
const COMMERCIAL_CALIBER_RE = /暂列金额|暂估价|预留金|投标报价|报价明细|综合单价|单价|合价|税率|增值税|利润|结算/u;

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
  // 缺席声明（4.55.29 L0-1）：整值在声明「资料未给出该信息」——信息缺席不是信息，归宿是 missing
  if (isAbsenceDeclaration(text)) return '缺席声明（资料未给出该信息）';
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
const CHANGE_CONNECTOR_RE = new RegExp(`${CHANGE_CONNECTORS}\\s*[:：]?`, 'u');
/** 全局正则缓存（同一 source 只编译一次；高频调用路径避免重复 new RegExp——1.8 万条证据下为性能瓶颈） */
const GLOBAL_PATTERN_CACHE = new Map<string, RegExp>();
function globalPatternFor(source: string): RegExp {
  const cached = GLOBAL_PATTERN_CACHE.get(source);
  if (cached) { cached.lastIndex = 0; return cached; }
  const created = new RegExp(source, 'gu');
  GLOBAL_PATTERN_CACHE.set(source, created);
  return created;
}

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
  const tokens = [...text.matchAll(globalPatternFor(source))].map(match => match[0].trim());
  if (tokens.length === 0) return text.slice(0, 80);
  const connector = CHANGE_CONNECTOR_RE.exec(text);
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
  const connector = CHANGE_CONNECTOR_RE.exec(text);
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
  // label 与 key 同值时只取一份（实测缺陷：属性名被拼成「安全合规要求安全合规要求」「测评合格编号测评合格编号」）
  const labelText = String(label || '').trim();
  const keyText = String(key || '').trim();
  const raw = (labelText && labelText === keyText ? labelText : `${labelText}${keyText}`).replace(/\s+/gu, '');
  if (!raw) return '';
  // 具体字段优先（「计划开工日期」必须归到开工日期，不能被 /工期/ 抢先归成计划工期）
  if (/开工日期|开工时间|startDate/i.test(raw)) return '开工日期';
  if (/竣工日期|完工日期|endDate/i.test(raw)) return '竣工日期';
  if (/质量标准|质量目标|quality/i.test(raw)) return '质量标准';
  if (/建设规模|建筑面积|规模|scale/i.test(raw)) return '建设规模';
  if (/建设地点|工程地点|location/i.test(raw)) return '建设地点';
  if (/招标人|建设单位|owner/i.test(raw)) return '招标人';
  // 4.55.22：**暂列金额必须先判**——它含「金额」二字，会被下面的 /金额/ 规则归并成「合同金额」，
  // 于是 700 万变成"合同金额的被取代值"，正文里合法的暂列金额会被替换成合同总额（实测自测暴露）。
  if (/暂列金额|暂列金/u.test(raw)) return '暂列金额';
  if (/估算|限价|控制价|投资|金额|amount/i.test(raw)) return '合同金额';
  if (/项目名称|工程名称|projectName/i.test(raw)) return '项目名称';
  if (/项目编号|工程编号|projectCode/i.test(raw)) return '项目编号';
  if (/工期|日历天|duration|schedule/i.test(raw) && !/节点|阶段|考核|开工|竣工/i.test(raw)) return '计划工期';
  // 未识别属性：保留原名（不丢信息，属性开放）
  return raw.slice(0, 40);
}

/**
 * 值等价键（R6 计数与候选去重用）：日期去前导零、金额单位归一到元——
 * 否则同一口径被拆成多个候选，证据计数失真。
 * 实测：「2026年8月31日」与「2026年08月31日」是同一日期却各计一次票。
 */
function valueEquivalenceKey(value: string): string {
  let key = String(value || '').trim();
  key = key.replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/gu, (_match, year: string, month: string, day: string) => `${year}年${Number(month)}月${Number(day)}日`);
  const money = /^([\d,]+(?:\.\d+)?)\s*(亿元|万元|元)$/u.exec(key);
  if (money) {
    const amount = Number(money[1]!.replace(/,/gu, '')) * (money[2] === '亿元' ? 1e8 : money[2] === '万元' ? 1e4 : 1);
    if (Number.isFinite(amount)) key = `${amount.toFixed(2)}元`;
  }
  return key;
}

/**
 * 决定性裁决链（R1..R7，全序）：
 * 候选集 → R1 变更链（被取代值出局）→ R1.5 强地址形 → R2.5 澄清/变更语境优先 → R2 载体优先级
 * → R3 时序 → R4 同源条款序 → R5 形态类型专属权威 → R6 证据计数 → R7 兜底（按形态定义）→ 唯一值
 * （R2.5 必须在 R2 之前：载体优先级若先收窄，澄清值可能已被淘汰，R2.5 不可达）
 */
/**
 * 命中本属性候选的变更链（被取代值 → 链声明的生效值）。
 * 调用侧用它做**变更链自证**：链声明的生效值必须与裁决胜出值一致，链才可信——
 * 实测反例：「1.8mm → 50mm」（清单「0.60/反面/厚度」语境下的跨分项误配）在「窗材质」属性上
 * 命中候选 1.8mm，但该属性实际胜出值是 1.2mm → 链与裁决结果不符 → 不是真正的口径变更。
 */
function matchedOverrideChains(candidates: TruthCandidate[], overrides: ValueOverride[]): Map<string, string> {
  const matched = new Map<string, string>();
  for (const override of overrides) {
    if (override.kind !== 'override') continue;
    if (!candidates.some(candidate => candidate.value.includes(override.superseded))) continue;
    matched.set(override.superseded, override.effective);
  }
  return matched;
}

/**
 * 澄清/变更语境的确定性信号（R2.5 的唯一判据）：
 * ① 候选构造时值文本自带澄清/变更标记（`clarified`）；或
 * ② **载体来源**为答疑/澄清/补疑/补遗 **且** 值文本含变更连接语
 *    —— 事实池把「原计划工期:365日历天，现变更修改为:330日历天」整句抽成值时，语境在整句里；
 *    抽取器/写侧归一各自剥掉语境后，值本身只剩「330日历天」，载体来源是唯一留存的语境证据。
 *    故仅凭 `clarified` 字段会把「变更句被剥壳后的新值」降级为普通候选（实测漏判口子）。
 */
function clarifiedPreference(candidate: TruthCandidate): boolean {
  if (candidate.clarified) return true;
  return CLARIFY_SOURCE_RE.test(candidate.source) && CHANGE_CONNECTOR_RE.test(candidate.value);
}

function arbitrate(candidates: TruthCandidate[], overrides: ValueOverride[]): { winner: TruthCandidate; rule: string; superseded: string[] } | undefined {
  if (candidates.length === 0) return undefined;
  const supersededSet = new Set<string>();
  const promoted: TruthCandidate[] = [];
  for (const override of overrides) {
    if (override.kind !== 'override') continue;
    if (!candidates.some(candidate => candidate.value.includes(override.superseded))) continue;
    supersededSet.add(override.superseded);
    // 生效值**升格为候选**：值级覆盖的生效值取自原文（「现变更修改为:330日历天」的 330），
    // 若它未被带标签抽取或事实池捕获，R1 过滤掉旧值后候选集为空 → 原实现回退「全部候选」，
    // 等于**放弃覆盖**（实测：工期 365→330 的覆盖被吞，365 仍胜出）。
    if (candidates.some(candidate => candidate.value === override.effective)) continue;
    if (promoted.some(candidate => candidate.value === override.effective)) continue;
    const evidenceSource = override.evidence[0]?.source || '';
    promoted.push({
      subject: candidates[0]!.subject,
      attribute: candidates[0]!.attribute,
      value: override.effective,
      source: evidenceSource,
      priority: sourcePriority(evidenceSource),
      order: sourceOrder(evidenceSource) * 1000 + 900,
      clarified: true,
    });
  }
  // R1 变更链：被取代值出局（生效值升格候选后仍为空时，才退回全量以遵循"恒有值"）
  let pool = [...candidates.filter(candidate => ![...supersededSet].some(value => candidate.value.includes(value))), ...promoted];
  if (pool.length === 0) pool = [...candidates];
  const ruleOf = (name: string, narrowed: TruthCandidate[]) => ({ winner: narrowed[0]!, rule: name, superseded: [...supersededSet] });
  if (pool.length === 1) return { winner: pool[0]!, rule: 'R1', superseded: [...supersededSet] };
  // R1.5 形态偏好（地址类）：候选里存在**强地址形**（含 路/街/号/交口 等地址构造）而另一些不是时，
  // 先按形态收窄——载体优先级不应把"项目名片段/表格串格"抬成地址（实测：建设地点取到「…项目一东区」）
  const STRONG_ADDRESS_RE = /(?:路|街|道|巷|号|交口|北侧|南侧|东侧|西侧|经开区|开发区|镇|村)/u;
  const strongAddress = pool.filter(candidate => STRONG_ADDRESS_RE.test(candidate.value) && /省|市|区|县/u.test(candidate.value));
  if (strongAddress.length > 0 && strongAddress.length < pool.length) pool = strongAddress;
  if (pool.length === 1) return { winner: pool[0]!, rule: 'R1.5', superseded: [...supersededSet] };
  // R2.5 澄清语境优先（**先于载体优先级收窄**）：澄清/变更值是本属性的**后口径**，载体优先级
  // 绝不能把招标正文旧值抬成生效值——原序把本判据排在 R2 之后，等于让 R2 先按「答疑 96 > 招标 90」
  // 收窄，一旦澄清值所在载体的优先级不最高（或来源串未命中答疑指纹），澄清值被 R2 提前淘汰、
  // R2.5 根本不可达，只能指望 R6/R7 兜底（R6 证据计数按候选条数计票，旧值来源多时反被抬回）。
  // 实测（doc-1790119909475-7ea5c969，巢湖）：计划工期 招标 365 / 答疑澄清 330，正文写出 365。
  //
  // **链升格候选（promoted）不参与本判据**：它的权威由 R1（旧值出局）+ 载体优先级承担；若让它
  // 借 `clarified` 标记参与语境优先，跨分项误配的变更链（scope「厚度」的 1.8mm→50mm 挂到「窗材质」）
  // 会压过真正的答疑口径（4.55.22 实测边界，见单测「变更链自证…不符时不登记」）。升格候选仍留在池内。
  const promotedSet = new Set(promoted);
  const clarifiedOnes = pool.filter(candidate => !promotedSet.has(candidate) && clarifiedPreference(candidate));
  if (clarifiedOnes.length > 0 && clarifiedOnes.length < pool.filter(candidate => !promotedSet.has(candidate)).length) {
    pool = [...clarifiedOnes, ...pool.filter(candidate => promotedSet.has(candidate))];
  }
  if (pool.length === 1) return { winner: pool[0]!, rule: 'R2.5', superseded: [...supersededSet] };
  // R2 载体优先级
  const maxPriority = Math.max(...pool.map(candidate => candidate.priority));
  let narrowed = pool.filter(candidate => candidate.priority === maxPriority);
  if (narrowed.length === 1) return ruleOf('R2', narrowed);
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
  // R6 证据计数（同一值出现次数多者胜；同义形态归一后计数——日期前导零、金额单位）
  const counts = new Map<string, number>();
  for (const candidate of narrowed) {
    const key = valueEquivalenceKey(candidate.value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const maxCount = Math.max(...counts.values());
  const byCount = narrowed.filter(candidate => counts.get(valueEquivalenceKey(candidate.value)) === maxCount);
  if (byCount.length === 1) return { winner: byCount[0]!, rule: 'R6', superseded: [...supersededSet] };
  narrowed = byCount;
  // R7 兜底（按形态；不含任何"自行取舍"的方向选择，且**必须确定性**——
  // 原实现取 narrowed[0]，数组序=事实池拼接顺序，与资料时序无关：
  // 实测开工日期在同源同优先级的两候选间取到靠前者=已被澄清掉的旧值 2026年8月31日）
  return { winner: deterministicTerminal(narrowed, shape), rule: 'R7', superseded: [...supersededSet] };
}

/**
 * R7 终止比较器（全序，与输入顺序无关）：
 * ① 澄清后值 > 招标原值（方案 §2 R7：时间类取招标方要求的生效值）
 * ② 后发布资料 > 先发布资料
 * ③ 载体优先级高者 > 低者
 * ④ 更具体者（更长）> 更泛者
 * ⑤ 稳定字典序（末级 tie-break，保证同一候选集恒得同一结果）
 */
function deterministicTerminal(pool: TruthCandidate[], shape: string): TruthCandidate {
  return [...pool].sort((left, right) => {
    if (left.clarified !== right.clarified) return left.clarified ? -1 : 1;
    if (sourceOrder(left.source) !== sourceOrder(right.source)) return sourceOrder(right.source) - sourceOrder(left.source);
    if (left.priority !== right.priority) return right.priority - left.priority;
    if (/standard/u.test(shape)) return left.value.localeCompare(right.value, 'zh-Hans-CN');
    if (left.value.length !== right.value.length) return right.value.length - left.value.length;
    return left.value.localeCompare(right.value, 'zh-Hans-CN');
  })[0]!;
}

/** 资料包根（relative_path 首段） */
function materialRootOf(source: string): string {
  const text = String(source || '').replace(/^\/+/u, '');
  const slash = text.indexOf('/');
  return slash > 0 ? text.slice(0, slash) : text;
}

/**
 * 跨资料包隔离：真值层的裁决域必须是**一个项目的一个资料包**——不同资料包里的
 * 同名属性（工期/合同金额/开工日期…）是不同项目的事实，混在一起裁决必然串值。
 * 实测：知识库同库并存 3 个项目（丰乐镇 90日历天 / 舒城 360日历天 / 巢湖 330日历天）时，
 * 无主体约束的裁决把 90日历天 判成"巢湖工期"、把丰乐镇的 1100万元 判成"巢湖合同金额"。
 * 上游按资料范围检索已收窄，此处做**独立于调用方**的兜底，并把越界候选写进 noiseRejected
 * （可审计：证明不是丢了，是判定为非本项目）。
 * 保守边界：仅当**全部候选**都带目录前缀时才启用（存在裸文件名来源时无法可靠比较资料包，
 * 宁可不动也不能误删合法事实）。
 */
function isolateMaterialPackages(byAttribute: Map<string, TruthCandidate[]>, noiseRejected: AuthoritativeValueAudit['noiseRejected']): void {
  for (const [attribute, candidates] of byAttribute) {
    if (candidates.length < 2) continue;
    if (candidates.some(candidate => !candidate.source.includes('/'))) continue;
    const rootCount = new Map<string, number>();
    for (const candidate of candidates) {
      const root = materialRootOf(candidate.source);
      rootCount.set(root, (rootCount.get(root) || 0) + 1);
    }
    if (rootCount.size <= 1) continue;
    const dominant = [...rootCount.entries()].sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0], 'zh-Hans-CN'))[0]![0];
    for (const candidate of candidates) {
      if (materialRootOf(candidate.source) === dominant) continue;
      noiseRejected.push({ attribute, value: candidate.value.slice(0, 60), source: candidate.source, reason: `跨资料包（本项目资料包：${dominant}）` });
    }
    byAttribute.set(attribute, candidates.filter(candidate => materialRootOf(candidate.source) === dominant));
  }
}

/** 构建真值层（读侧：只产出裁决结果与审计，不改写作） */
/**
 * 值-标签形态相容闸（4.55.24）。
 *
 * **实测根因**（巢湖 4.55.23 终稿 63 项阻断中约 25 项的直接来源）：真值层把一个"标签"和一个
 * 毫无形态关系的"值"配成对，再经 R 链裁决成生效值，产出**语义上不可能落位**的口径：
 *   「材料投入计划」= DN1000 ｜「机械设备计划」= DN1000
 *   「检测仪器计划」= 接地系统测试（1#厂房安装工程）｜「技术参数精确参数」= 71807.64 平方米
 * 写手写不出「材料投入计划 = DN1000」，caliber-consistency 就永久报「正文未按该口径落位」——
 * 这 25 项**改写作、改修复轮都消不掉**，只能在真值层入闸消掉。
 *
 * 判据（窄而确定，不预设字段白名单）：
 * ① **文本型属性**（计划/方案/措施/制度/职责/体系/程序/规划/组织/安排/要求/标准… 结尾）不得取
 *    **裸型号值**（`DN1000`/`C30`/`HRB400` 这类无中文、无单位汉字的纯标识 token）；
 * ② **多标签拼接属性名**（≥8 字且含 ≥2 个通用尾词，如「技术参数精确参数」）本身即缺陷信号 → 拒收；
 * ③ **规格型属性**（规格/型号/等级/管径/厚度…）不得取长句值（>30 字且含句读）。
 */
const TEXTUAL_ATTRIBUTE_RE = /(?:计划|方案|措施|制度|职责|体系|程序|规划|组织|安排|要求|标准|办法|流程|台账|记录)$/u;
const BARE_MODEL_TOKEN_RE = /^[A-Za-z]{1,6}\s?[-/]?\s?\d{1,6}(?:\.\d+)?$/u;
const SPEC_ATTRIBUTE_RE = /(?:规格|型号|等级|管径|直径|厚度|强度等级|牌号|标号|尺寸)$/u;
const GENERIC_FIELD_TAIL_WORDS = ['参数', '要求', '标准', '数据', '指标', '信息'];

/**
 * 时间型属性（4.55.29 L0-3 扩围）：属性名本身声明「这里的值是时间口径」。
 * 实测根因：图签串格值「1#厂房建筑超高施工增加，檐口高度22.2m、一层」经值 token 抽取后
 * 取到「22.2m」，挂到「工期关键节点」名下成为**语义上不可能落位**的口径——
 * 一个长度值被当成工期节点权威，正文没照写（正确），口径终检却判「正文未按该口径落位」。
 * 判据取自属性名语义（不是项目数值）：时间型属性的值必须含**日期或时长 token**。
 */
const TEMPORAL_ATTRIBUTE_RE = /(?:工期|节点|日期|期限|周期|时长|时间|时刻|进度计划)$/u;
/** 日期或时长 token（与 conflictComparableFactValue 的槽位分桶同口径） */
const TEMPORAL_VALUE_TOKEN_RE = /\d{4}\s*年\s*\d{1,2}\s*月|\d+\s*个?\s*(?:日历天|天|个月|月|周|年|小时|工作日)/u;
/** 时间语义词：节点名单（「基础完成、主体封顶、竣工验收」）不带日期也合法，不得按形态误剔 */
const TEMPORAL_VOCAB_RE = /(?:工期|节点|阶段|开工|竣工|完工|完成|封顶|验收|日历天|工作日|月份|年度|季度)/u;

/** 返回不相容原因（相容返回 undefined） */
export function attributeValueShapeMismatch(attribute: string, value: string): string | undefined {
  const attr = String(attribute || '').trim();
  const val = String(value || '').trim();
  if (!attr || !val) return undefined;
  if (TEXTUAL_ATTRIBUTE_RE.test(attr) && BARE_MODEL_TOKEN_RE.test(val)) {
    return `值-标签形态不相容：文本型属性「${attr}」取了裸型号值「${val}」`;
  }
  // 时间型属性：值须含日期/时长 token 或时间语义词（节点名单如「基础完成、主体封顶」合法，不误伤）
  if (TEMPORAL_ATTRIBUTE_RE.test(attr) && !TEMPORAL_VALUE_TOKEN_RE.test(val) && !TEMPORAL_VOCAB_RE.test(val)) {
    return `值-标签形态不相容：时间型属性「${attr}」取了无日期/时长的值「${val.slice(0, 40)}」`;
  }
  // 计**出现次数**而非"命中的词种数"：「技术参数精确参数」里「参数」出现两次才是拼接信号
  const tailHits = GENERIC_FIELD_TAIL_WORDS.reduce((total, word) => total + (attr.split(word).length - 1), 0);
  if (attr.length >= 8 && tailHits >= 2) {
    return `值-标签形态不相容：属性名「${attr}」为多标签拼接，不作为口径属性`;
  }
  if (SPEC_ATTRIBUTE_RE.test(attr) && val.length > 30 && /[，。；,;]/u.test(val)) {
    return `值-标签形态不相容：规格型属性「${attr}」取了长句值`;
  }
  return undefined;
}

export function buildAuthoritativeValues(input: {
  facts: Array<{ key?: string; label?: string; value?: unknown; sourceFile?: string; source?: string }>;
  overrides?: ValueOverride[];
  /** 带口径标签的权威值（原文句式抽取：最高投标限价/计划工期/开工日期；作废声明者优先） */
  labeledValues?: Array<{ attribute: string; value: string; source: string; supersedesPriorMaterials?: boolean; clarified?: boolean }>;
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
    // 4.55.24 值-标签形态相容闸：不相容的值对不入真值层（记 noiseRejected 可审计）
    const shapeMismatch = attributeValueShapeMismatch(attribute, normalizedValue);
    if (shapeMismatch) {
      noiseRejected.push({ attribute, value: normalizedValue.slice(0, 60), source, reason: shapeMismatch });
      return;
    }
    pushCandidate(attribute, normalizedValue);
  });
  /**
   * 带口径标签机制识别出的属性集合 = **单值型项目口径**（原文句式声明：「最高投标限价…」
   * 「计划工期…」「开工日期…」）。它们才具备「被取代」语义（一个项目只有一个现行工期/金额/开工日期）。
   *
   * **为什么落选登记必须限定在这个集合**（4.55.22 实测缺陷）：逐项多值属性（搭设高度/窗材质/
   * 厚度/柱截面尺寸/管径…）的候选来自**不同分项**，「胜出值」只是众多分项里被选中一个——
   * 其余分项值不是"被取代的旧口径"。不加边界时覆盖表产出「7m→4.5m」「5.7m→4.5m」「3.6m→4.5m」
   * 「1.8mm→1.2mm」「1.6m→2.40m」等，把分项技术数据当旧口径**全局替换**（证据侧一次替换 51 处），
   * 会在下一轮真实生成里污染技术参数。判据取自机制本身（带标签抽取），不预设字段白名单。
   */
  const caliberAttributes = new Set((input.labeledValues || [])
    .map(labeled => normalizeAttributeName(labeled.attribute, labeled.attribute))
    .filter(Boolean));
  // 带标签权威值并入候选：作废声明（「原资料全部作废，以本次答疑为准」）者给最高优先级+澄清标记
  for (const labeled of input.labeledValues || []) {
    const attribute = normalizeAttributeName(labeled.attribute, labeled.attribute);
    if (!attribute) continue;
    const cleaned = cleanValueForm(labeled.value);
    if (rejectValueNoise(cleaned.value, { allowProse: true, includePoolNoise: false })) continue;
    const list = byAttribute.get(attribute) || [];
    list.push({
      subject: '',
      attribute,
      value: extractValueAndShape(cleaned.value).value,
      source: labeled.source,
      priority: labeled.supersedesPriorMaterials ? 99 : sourcePriority(labeled.source),
      order: sourceOrder(labeled.source) * 1000 + 500,
      // 澄清标记取**段落级语境**判定值；调用方未提供时按"带口径标签 ⇒ 出自澄清语境"沿用旧口径
      clarified: labeled.clarified ?? true,
    });
    byAttribute.set(attribute, list);
  }
  isolateMaterialPackages(byAttribute, noiseRejected);
  const resolved: ResolvedValue[] = [];
  for (const [attribute, candidates] of byAttribute) {
    const result = arbitrate(candidates, overrides);
    if (!result) continue;
    // 4.55.20：落选候选登记为被取代值（非文本形态）——同一口径的旧值必须被禁止再出现在正文
    //（实测：1/5 号答疑各有最高投标限价，正文不得再用作废的 22303.66万元/172460314.52元）。
    // 4.55.22 安全边界：**仅单值型项目口径**登记（见 caliberAttributes）——逐项多值属性的落选值
    // 是别的分项的值，登记成"被取代"会导致全库文本误替换。
    const winnerShape = classifyValueShape(result.winner.value);
    const losers = caliberAttributes.has(attribute) && ['measure', 'money', 'date', 'standard'].includes(winnerShape)
      ? candidates.map(candidate => candidate.value).filter(value => value !== result.winner.value)
      : [];
    // R1 出局值同样受安全边界约束：单值型项目口径（带标签识别）无条件登记；
    // 其余属性须**变更链自证**（链声明的生效值 = 本次裁决胜出值）才登记。
    const chains = matchedOverrideChains(candidates, overrides);
    const chainedLosers = result.superseded.filter(value =>
      caliberAttributes.has(attribute) || chains.get(value) === result.winner.value);
    // 变更链声明的被取代值必须**留存**（4.55.31）。写侧「现行口径前置」会把旧值就地改写进事实池/
    // 检索证据（`writerEvidence` 与 `allEvidence` 共享对象引用 → 证据侧同步被改写），到 finalize 读侧
    // 重算时候选集里**已无旧值** → `matchedOverrideChains` 的 `candidates.some(含旧值)` 失配 →
    // superseded 只剩「2026年10月10日」「资料中未明确体现计划工期。」这类**非单位值** →
    // 残留闸的残留集为空 → 正文里 6 处 365日历天 全部静默放行（实测 doc-1790119909475-7ea5c969 巢湖）。
    // 判据 = **变更链自证**：链声明的生效值 == 本次裁决胜出值 ⇒ 链的被取代值确是**本属性**的旧口径，
    // 与候选是否还在无关（旧值消失恰恰是"它已被取代"的结果，不是"它不存在"的证据）。
    // 安全边界与 losers 同源：仅单值型项目口径（caliberAttributes），且形态与胜出值同类（防跨形态误登）。
    const chainDeclared = caliberAttributes.has(attribute)
      ? overrides
        .filter(override => override.kind === 'override'
          && override.superseded !== result.winner.value
          && valueEquivalenceKey(override.effective) === valueEquivalenceKey(result.winner.value)
          && classifyValueShape(override.superseded) === winnerShape)
        .map(override => override.superseded)
      : [];
    resolved.push({
      subject: result.winner.subject,
      attribute,
      value: result.winner.value,
      rule: result.rule,
      evidence: [{ source: result.winner.source, snippet: result.winner.value.slice(0, 120) }],
      superseded: [...new Set([...chainedLosers.filter(value => value !== result.winner.value), ...chainDeclared, ...losers])],
      // 项目级口径 = 原文带口径标签抽取出的属性（caliberAttributes）；其余为章节内容型属性。
      // 商务口径（暂列金额/暂估价/预留金…）**不入**「正文须逐字落位」集——技术标不承载金额类数据，
      // 变更追踪仍由 superseded 承担（`caliberAttributes` 未变），两者职责分离。
      caliber: caliberAttributes.has(attribute) && !COMMERCIAL_CALIBER_RE.test(attribute),
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
  // 4.55.32 口径须落位清单（与口径终检**读写同源**）：口径终检要求「正文逐字含该值」，
  // 而写手此前只被告知**发生过变更**的属性（本块原有唯一内容），未被告知**必须出现**的口径集
  //（`caliber === true` 的项目级口径，如开工日期/合同金额）——写手没被要求写，终检却按"未落位"阻断
  //（实测：开工日期 2026年10月10日 真值层有值、正文零次）。
  // 两者同源：终检判什么，写手就被要求写什么；清单只含项目级口径（非口径属性不入，避免约束膨胀）。
  const mustState = audit.resolved.filter(item => item.caliber && item.superseded.length === 0);
  const blocks: string[] = [];
  if (rows.length > 0) {
    blocks.push([
      '【现行口径（真值层裁决，硬约束）】下列属性已按资料优先级与变更链裁决出**唯一现行值**；全文（正文、表格、信息表、进度计划、节点）必须一致使用，被取代值仅在引用变更过程时可出现（如「招标文件原为 X，经答疑澄清变更为 Y」），不得单独陈述现状：',
      ...rows.map(item => `- ${item.attribute}：现行为「${item.value}」；被取代（不得作为现行口径）：${item.superseded.join('、')}`),
    ].join('\n'));
  }
  if (mustState.length > 0) {
    blocks.push([
      '【项目级口径（必须在正文出现）】下列口径是本项目的唯一现行值，必须在正文相应位置（工程概况／编制说明／工期与进度等）**逐字写出**（数值、单位、日期形态均不得改写或省略）：',
      ...mustState.map(item => `- ${item.attribute}：${item.value}`),
    ].join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * 口径链尾确定性回填（4.55.33）——**「必须在正文出现」的项目级口径，写作没做到时由链尾补上**。
 *
 * 动因（实测）：口径终检要求正文逐字含项目级口径（如开工日期 `2026年10月10日`），
 * 写作侧虽已在硬约束块里被告知必须写（`renderTruthConstraintBlock` 的「项目级口径（必须在正文出现）」），
 * 但模型可能仍以**别的等价表述**代替（实测：写「开工日期以监理工程师签发开工令之日起算」，
 * 全篇零次出现该日期）——写手未被强制，终检照常阻断，且该 blocker 无修复轮消费。
 *
 * 判据（机制，非模板套话）：
 * ① 仅处理 `caliber === true` 且**值在正文中逐字缺席**的口径；
 * ② 仅处理**可直接落位的值形态**（日期/金额/量值/规格/标准编号），段落型值不插；
 * ③ 必须在正文中找到**属性名出现处**（口径名在本项目里被提起过）——找不到就不插（不硬塞进无关段落）；
 * ④ 插在该句之后，形态为「{属性名}为{值}。」——原文一字不删，纯增量插入；已存在则不动（幂等）。
 */
const CALIBER_PLACEABLE_SHAPES = new Set(['measure', 'money', 'date', 'standard', 'spec']);

export function backfillCaliberPlacements(markdown: string, ledger: readonly ResolvedValue[]): { markdown: string; inserted: Array<{ attribute: string; value: string }> } {
  const inserted: Array<{ attribute: string; value: string }> = [];
  let output = markdown;
  const normalized = () => output.replace(/\s+/gu, '');
  for (const item of ledger) {
    if (!item.caliber) continue;
    const attribute = String(item.attribute || '').trim();
    const value = String(item.value || '').trim();
    if (!attribute || !value) continue;
    if (!CALIBER_PLACEABLE_SHAPES.has(classifyValueShape(value))) continue;
    if (normalized().includes(value.replace(/\s+/gu, ''))) continue;
    const statement = `${attribute}为${value}。`;
    // 锚点①：属性名出现处——插在所属句子之后（句读边界 = 。；;\n）
    const index = output.indexOf(attribute);
    if (index >= 0) {
      let sentenceEnd = index + attribute.length;
      while (sentenceEnd < output.length && !/[。；;\n]/u.test(output[sentenceEnd]!)) sentenceEnd += 1;
      if (sentenceEnd >= output.length) continue;
      // 幂等：该句已含该声明则跳过
      if (output.slice(index, sentenceEnd).includes(value)) continue;
      output = `${output.slice(0, sentenceEnd + 1)}${statement}${output.slice(sentenceEnd + 1)}`;
      inserted.push({ attribute, value });
      continue;
    }
    // 锚点②：属性名在正文中**一次都没被提起**（实测：全篇 0 次「开工日期」）——项目级口径的自然归宿
    // 是概况类章节（工程概况/项目概况/编制说明），插在该章末尾（下一个标题行之前）。找不到概况章则不插
    //（仍然不硬塞进无关段落）。判据是标题语义，不是项目特有章节名。
    const heading = /^#{2,3}\s*[^\n]*?(?:概况|概述|编制说明)[^\n]*$/mu.exec(output);
    if (!heading) continue;
    const sectionStart = heading.index + heading[0].length;
    const nextHeading = /^#{2,3}\s/mu.exec(output.slice(sectionStart));
    const sectionEnd = nextHeading ? sectionStart + nextHeading.index : output.length;
    const insertAt = output.lastIndexOf('\n', sectionEnd - 1) + 1;
    if (output.slice(sectionStart, sectionEnd).includes(value)) continue;
    output = `${output.slice(0, insertAt)}${statement}\n${output.slice(insertAt)}`;
    inserted.push({ attribute, value });
  }
  return { markdown: output, inserted };
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
