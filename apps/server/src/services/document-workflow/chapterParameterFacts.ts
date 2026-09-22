/**
 * chapterParameterFacts：可靠参数按章使用（C-T6）——资料事实链参数索引的按章相关性注入 /
 * 使用率归因审计 / 修复链缺失池（一个模块三处消费，口径单源）。
 *
 * 背景（B6/#38 根治）：参数池（factsModel.factIndex.parameterFacts：规格/参数/数量/时间/比例/
 * 标准编号类可靠事实）此前没有写作侧直读通道——参数只能经检索召回/事实需求间接进入提示词，
 * 实测可靠参数使用率 17%（远低于告警线 28%）。与清单直读（billFactLock）/图纸直读（drawingFactLock）
 * 同范式补齐三环：
 * - 写作侧（stageChapterLoop）：按章相关性渲染本章可用参数清单，生成时显式可见（源头提升使用率）；
 * - 审计侧（documentQualityReport.parameterUsageAudit）：按章归因——已使用 / 相关而遗漏（义务集）/
 *   不相关遗漏（仅登记），义务满足率 = used/(used+relevantMissed)（C-T6 ≥80% 验收出口）；
 * - 修复侧（contentDepthRepair）：相关而遗漏的参数按最相关章分配，随内容深度补写轮消费。
 *
 * 口径单源：章 token（标题+小节切词，含双字子词扩展）× 参数文本（键/字段名/值）词面命中计分——
 * 注入可见性、审计义务集、修复目标章三处共用同一打分（口径不分裂）。
 * 商务红线：参数池构建已排除商务金额/单价/税率/预留金类事实（factsModel.isGenerationExcludedFact），
 * 本模块消费侧再排除一次（防上游池变更泄漏）——商务数据零进入注入/义务/修复。
 */
import { chapterRelevanceTokens, expandRelevanceToken } from './billFactLock';
import { isGenerationExcludedFact } from './factsModel';
import { normalizeEngineeringTextForFactMatch } from './engineeringUnits';
import { classifyPoolNoiseText, type PoolNoiseCategory } from './poolNoise';
import { rejectValueNoise } from './authoritativeValues';
import { normalizeQuantityZeros } from './documentFactTrace';
import { CHANGE_CONNECTORS } from './valueOverride';
import { stableHash } from './utils';
import type { DocumentFact, ValidationIssue } from './types';

/** 参数池输入（factsModel 子集；factIndex 缺失时回退 preciseFacts，与检测端 collectPreciseFactTokens 同源兜底） */
export interface ParameterFactsSource {
  factIndex?: { parameterFacts?: DocumentFact[] } | null;
  preciseFacts?: DocumentFact[] | null;
}

/** 参数池噪声（OCR/识别残缺类条目不可逐字写入正文：不注入、不计义务、不修复） */
const PARAMETER_NOISE_RE = /OCR|乱码|识别错误|无法确认|语义断裂|页码/u;

/** 商务域补充排除（消费侧兜底，与商务数据检测器词面同族）：isGenerationExcludedFact 已覆盖金额/单价/
 * 税率/增值税/报价/合价类，未覆盖「预留金/暂列金额/暂估价」——C-T6 红线（预留金零进入）在此补齐 */
const PARAMETER_COMMERCIAL_EXTRA_RE = /暂列金额|暂估价|预留金/u;

/**
 * 4.55.29 池准入形态闸——**「可靠参数」= 可逐字落位的规格型值**。
 *
 * 实测根因（巢湖 doc-d47a002e 全量归因）：义务满足率 124/229 = 54.1%，其中「相关而遗漏」105 条里
 * 约 85 条**根本不是参数**，是抽取通道从清单/表格切出的碎片与商务数值：
 *   裸费率 `1.5%`/`0.8%`/`15%`、裸金额 `6000万元`/`500元`、裸时长 `22天`/`8小时`、
 *   清单编码 `JF-01`/`JC-06`、条款号 `3.4项`/`4.3项`、变更叙述 `365日历天，现变更修改为:330日历天`、
 *   整句 `质量要求`/`评价标准`/`风险控制要求` 段落。
 * 这些值的**概念词不在值内**（费率/时长/金额的主体名在被截掉的上下文里），正文无从逐字落位；
 * 把它们计入义务集，等于**用一个不可能完成的义务把满足率永久压在门槛之下**——检测定位失真，
 * 修复轮照此补写只会往正文塞裸数字（正是商务数据泄漏进技术标的成因）。
 *
 * 判据（机制，不含任何项目数值/字段白名单）：
 * ① 段落/占位/图签/串格/截断 —— 复用真值层同一形态闸 `rejectValueNoise`（单源，不另立一套）；
 * ② 裸量碎片 —— 整值只有「数值 + 通用量词/商务单位」而无概念词：非工程单位的%（费率/合格率）、
 *    金额（元/万元/亿元）、通用计数与时长（项/个/天/月/年/小时/人/次）单独出现时不构成参数
 *    （`C30`/`DN100`/`GB50204-2015`/`Q355B`/`300mm` 这类自带概念或工程单位的形态不受影响）；
 * ③ 变更叙述 —— 含变更连接语（变更修改为/澄清为…）的整值是真值层的裁决输入，不是可落位参数
 *    （生效值由 `authoritativeValues` 裁决产出，参数池消费生效值而非过程叙述）；
 * ④ 清单/图签编码 —— `JF-01`/`JC-06` 类「短字母前缀 + 1~3 位序号」编号不携带工程语义，
 *    且与标准编号形态（`GB50204-2015`/`JC/T 1234-2020`，含 4 位以上数字段）可判然区分。
 */
const PARAMETER_BARE_QUANTITY_RE = /^\d+(?:\.\d+)?\s*(?:%|元|万元|亿元|项|个|天|月|年|周|小时|分钟|人|次|份|批|层)$/u;
const PARAMETER_LISTING_CODE_RE = /^[A-Za-z]{1,4}\s*[-–—]?\s*\d{1,3}$/u;
/** 通用参数桶键名：命中即「键不携带概念」——值若同时是裸量，则该条目**整体无概念词**，
 * 正文无从锚定（键为实质名如「排水管道」「灯具型号」时，裸量值仍有锚点，不受本判据约束） */
const PARAMETER_GENERIC_KEY_RE = /^(?:精确参数|技术参数|参数|参数规格|规格参数|数据|指标|其他|其它|备注|说明|未分类)$/u;
/** 标准编号形态（含 4 位以上数字段）：与清单编码区分，不得误出池 */
const PARAMETER_STANDARD_CODE_RE = /(?:GB|JGJ|CJJ|CJ|JG|JT|TB|SL|DL|HG|SH|YB|SY|GA|QB|WS|JC|NB|CECS|ISO|IEC|JTG|DB)\s*\/?\s*T?\s*[\d.]{4,}/iu;
/** 自带概念的规格/牌号/管径/材料代号：字母前缀 + 数字（C30 / DN100 / HRB400 / Q355B / MU10 / M7.5） */
const PARAMETER_SPEC_CODE_RE = /^[A-Za-z]{1,3}\s*\d+(?:\.\d+)?[A-Za-z]?$/u;

/** 变更叙述判定（复用值级覆盖的连接语单源） */
function isChangeNarrativeValue(value: string): boolean {
  return new RegExp(CHANGE_CONNECTORS, 'u').test(value);
}

/** 条文句/整句形态（参数是短语级值）：句末标点、列表引导（`：2.1`）、条文情态句式 */
const PARAMETER_PROSE_RE = /[。！？]|[：:]\s*[\d（(]|(?:应|须|不得|必须|严禁|宜)[^，。；]{0,20}(?:采用|符合|按照|满足|设置|办理|执行|组织|进行|大于|小于|超过|支付|承担|参加)/u;
/** 单位/机构名（以组织后缀收尾）：是项目主体信息，不是工程参数（工程参数带量值或规格形态） */
const PARAMETER_ORG_NAME_RE = /(?:有限公司|有限责任公司|股份公司|集团公司|公司|事务所|管理处|管理局|委员会|服务中心)$/u;

/** 池准入：返回剔除原因（可用返回 undefined） */
export function parameterPoolRejectionReason(fact: DocumentFact): string | undefined {
  const value = String(fact.value || '').trim();
  if (!value) return '空值';
  // ① 真值层同源形态闸（段落/占位/图签/串格/截断/池噪声）
  const shapeNoise = rejectValueNoise(value);
  if (shapeNoise) return shapeNoise;
  // ② 裸量碎片：值只有「数值 + 通用量词/商务单位」且**键也不携带概念**（通用桶）——
  //    该条目整体无概念词，正文无从逐字落位。规格/标准编号形态自带概念，先行放行；
  //    键为实质名（排水管道/灯具型号/道路工程）时值仍有锚点，不适用本判据。
  const key = String(fact.key || '').trim();
  if (PARAMETER_GENERIC_KEY_RE.test(key)
    && !PARAMETER_SPEC_CODE_RE.test(value) && !PARAMETER_STANDARD_CODE_RE.test(value)
    && PARAMETER_BARE_QUANTITY_RE.test(value)) {
    return '裸量碎片（键为通用桶、值无概念词，正文无从逐字落位）';
  }
  // ③ 变更叙述不是可落位参数（生效值由真值层裁决产出）
  if (isChangeNarrativeValue(value)) return '变更叙述（非可落位参数）';
  // ⑤ 条文句/整句：参数是**短语级值**（`C30`/`DN100`/`Q355B`/`10.9级 M16`），不是一整句话
  if (value.length >= 18 && PARAMETER_PROSE_RE.test(value)) return '条文句（非短语级参数）';
  // ⑥ OCR 数字粘连残片：`…交口北0000`/`…北 00 00 侧`（同一数字段复写）——不可逐字锚定
  if (/(?:\d)\s*(?:\d)(?:\s*\d){2,}/u.test(value) && /(?:北|南|东|西|侧|号|路|街|村|镇|区)\s*\d/u.test(value)) return 'OCR 数字复写残片';
  // ⑦ 单位/机构名不是工程参数（招标代理、监管部门等主体信息，技术标不落位）
  if (PARAMETER_ORG_NAME_RE.test(value)) return '单位/机构名（非工程参数）';
  // ④ 清单/图签编码（标准编号与自带概念的规格代号除外）
  if (PARAMETER_LISTING_CODE_RE.test(value) && !PARAMETER_STANDARD_CODE_RE.test(value) && !PARAMETER_SPEC_CODE_RE.test(value)) return '清单/图签编码';
  return undefined;
}

/**
 * 本章参数注入的**字符预算**（默认 3600；条数上限已删除）。
 *
 * 上限治理：原 `CHAPTER_PARAMETER_MAX_ENTRIES = 60` 已删除——**本章相关参数清单是「逐项落位义务」
 * 的载体**（实测参数落位仅 126/244 = 51.6%，与清单被截断直接相关）。被截掉的参数在第 61 项起
 * 既不进写作提示词、也不进落位义务 ⇒ 永远写不进正文。
 * 现口径：字符预算是**渲染预算**（超出的条目降级为「仅列名」而非消失），义务不丢。
 */
const CHAPTER_PARAMETER_MAX_CHARS = 3600;

/** 参数文本（相关性计分与渲染共用口径）：键/字段名/值 */
function parameterFactText(fact: DocumentFact): string {
  return `${fact.key || ''} ${fact.fieldName || ''} ${fact.value || ''}`.trim();
}

/** 可用参数池 + 净化出池登记（D6 池净化：只出池不删档——噪声条目移出义务集但保留在审计中） */
interface UsableParameterPool {
  /** 可用参数（空值/噪声/商务/重复剔除后） */
  usable: DocumentFact[];
  /** D6 表格噪声出池登记（图签/坐标/残片/目录行/编号粘连，与要求池同源判定，可审计） */
  noiseExcluded: Array<{ fact: DocumentFact; category: PoolNoiseCategory }>;
}

/** 可用参数池：空值/噪声/商务/重复剔除（去重键 key|value，池内原始顺序保持）。
 * D6 同源净化：表格噪声（图签/坐标/残片/粘连）与要求池共用 poolNoise 判定——一处判定全链生效
 * （写作注入/义务审计/修复分配三处消费同一池，噪声零进入义务集）。 */
function usableParameterFacts(factsModel: ParameterFactsSource | undefined | null, supersededValues: ReadonlySet<string> = new Set()): UsableParameterPool {
  const empty: UsableParameterPool = { usable: [], noiseExcluded: [] };
  if (!factsModel) return empty;
  const pool = factsModel.factIndex?.parameterFacts?.length ? factsModel.factIndex.parameterFacts : (factsModel.preciseFacts || []);
  const seen = new Set<string>();
  const usable: DocumentFact[] = [];
  const noiseExcluded: Array<{ fact: DocumentFact; category: PoolNoiseCategory }> = [];
  for (const fact of pool) {
    if (!fact) continue;
    const value = String(fact.value || '').trim();
    if (!value) continue;
    // 4.55.29 被取代值零进入义务集（真值层裁决单源）：口径已被裁决取代的旧值**不得**要求正文落位——
    // 正文写它才是缺陷。实测：`365日历天`（工期已裁决为 330日历天）与陈旧建筑面积 `71807.64平方米`
    // 混在参数池里，产出永久消不掉的义务缺口，并驱动修复轮往正文补写已作废口径。
    if (supersededValues.has(normalizeEngineeringTextForFactMatch(value))) continue;
    if (PARAMETER_NOISE_RE.test(parameterFactText(fact))) continue;
    // 商务红线双保险：池构建（isGenerationExcludedFact，含合同估算价类反豁免口径）已排除大部分，
    // 消费侧再兜底排除补充词面（预留金/暂列金额/暂估价）与商务域事实
    if (isGenerationExcludedFact(fact)) continue;
    if (PARAMETER_COMMERCIAL_EXTRA_RE.test(parameterFactText(fact))) continue;
    // D6 表格噪声净化（与要求池同源判定）：图签/坐标/目录行/残片/粘连出池——不可锚定正文且误导修复。
    // 判定对象为「值」：键/字段名是分类标签（项目名称/精确参数），拼接判定会以键前缀遮蔽值首形态
    // （「项目名称 2225111舒城县…」值首编号粘连漏判），值才是最终要逐字落位的内容
    const noiseCategory = classifyPoolNoiseText(value);
    if (noiseCategory) {
      noiseExcluded.push({ fact, category: noiseCategory });
      continue;
    }
    // 4.55.29 池准入形态闸（见 parameterPoolRejectionReason）：碎片/商务裸量/变更叙述/编号不是参数。
    // 出池 = 移出写作注入与义务集，但仍登记在审计中（只出池不删档）
    if (parameterPoolRejectionReason(fact)) continue;
    // 4.55.29 项目主体级事实不入参数池（与 buildBoundFactAudit 的 projectLevel 同一判据单源）：
    // 项目名称/建设地点/建设规模/工期/招标范围…的对象就是项目本身，其落位由「项目基础事实卡片」
    // 与关键事实落位审计（keyFactPlacement）承担。混入参数池的后果实测：清单「项目名称」列的分部
    // 工程名与措施项名（「混凝土及钢筋混凝土工程」「施工用电接引（应用于整个项目）」）被当作项目名称
    // 参数，正文不可能逐字落位 → 永久义务缺口（巢湖实测 7 条）。
    if (PROJECT_LEVEL_KEY_RE.test(String(fact.key || '').trim())) continue;
    // 去重键用**归一值**（4.55.29）：`71807.64平方米` 与 `71807.64 平方米` 是同一参数，
    // 原键用原始值 → 空格变体各占一条，重复计入义务集（实测两条同值并列缺口）
    const dedupeKey = `${fact.key}|${normalizeEngineeringTextForFactMatch(value)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    usable.push(fact);
  }
  return { usable, noiseExcluded };
}

/** 章 token 展开集（标题+小节切词 → 双字子词展开，一次展开供全池打分复用） */
function chapterParameterTokens(chapterTitle: string, sections: string[] = []): string[] {
  const expanded = new Set<string>();
  for (const token of chapterRelevanceTokens(chapterTitle, sections)) {
    for (const item of expandRelevanceToken(token)) expanded.add(item);
  }
  return [...expanded];
}

/** 参数与章的相关性分：展开 token 命中参数文本的个数（>0 即相关；打分序用于注入排序与修复定位） */
function parameterRelevanceScore(fact: DocumentFact, expandedTokens: string[]): number {
  const text = parameterFactText(fact);
  let score = 0;
  for (const token of expandedTokens) {
    if (text.includes(token)) score += 1;
  }
  return score;
}

/** 本章相关参数选择（写作注入与义务口径共用）：仅取相关（score>0），分数降序、键值字典序兜底可复现 */
export function selectChapterParameterFacts(
  factsModel: ParameterFactsSource | undefined | null,
  chapterTitle: string,
  options: { sections?: string[]; supersededValues?: ReadonlySet<string> } = {},
): DocumentFact[] {
  const { usable: pool } = usableParameterFacts(factsModel, options.supersededValues);
  if (pool.length === 0) return [];
  const tokens = chapterParameterTokens(chapterTitle, options.sections || []);
  if (tokens.length === 0) return [];
  // 上限治理：**不设条数上限**——本章全部相关参数都须进入义务口径（原 slice(0,60) 让第 61 项起消失）
  return pool
    .map(fact => ({ fact, score: parameterRelevanceScore(fact, tokens) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score
      || String(a.fact.key).localeCompare(String(b.fact.key), 'zh')
      || String(a.fact.value).localeCompare(String(b.fact.value), 'zh'))
    .map(item => item.fact);
}

/**
 * 本章可靠参数清单渲染（写作注入，行数组由调用侧并入 roleContext）：
 * header 声明逐项落位义务与商务禁入；条目行 `- 键（字段名）：值`（值截断 80 字符防单条超长）。
 */
export function renderChapterParameterLines(
  factsModel: ParameterFactsSource | undefined | null,
  chapterTitle: string,
  options: { sections?: string[]; maxChars?: number } = {},
): string[] {
  const selected = selectChapterParameterFacts(factsModel, chapterTitle, options);
  if (selected.length === 0) return [];
  const maxChars = Math.max(1, options.maxChars ?? CHAPTER_PARAMETER_MAX_CHARS);
  const lines: string[] = [];
  let total = 0;
  for (const fact of selected) {
    const field = fact.fieldName && fact.fieldName !== fact.key ? `（${fact.fieldName}）` : '';
    // 4.55.25 绑定层：有对象锚点的值以「对象｜属性=值」形态注入——写手据此把值写到**该对象**处，
    // 不得跨对象借用（多对象多值并列合规）；无对象锚点的保持原形态（不阻断既有链路）
    const object = String(fact.objectName || '').trim();
    const line = object
      ? `- ${object}｜${fact.key}${field}=${String(fact.value).slice(0, 80)}`
      : `- ${fact.key}${field}：${String(fact.value).slice(0, 80)}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  const rest = selected.slice(lines.length);
  if (lines.length === 0) return [];
  return [
    `【本章可靠参数清单（资料事实链参数索引：${selected.length} 项与本章相关的规格/参数/数量/时间/比例/标准编号，须逐项在正文对应位置自然写入，保持原值原形态（数字、单位、编号中的连字符与年份不得改写、拆分或省略）；商务金额/单价/税率/预留金类数据一律不得写入正文）】`,
    '【逐对象写实铁律】带对象前缀的条目（「对象｜属性=值」）必须写到**该对象**的正文处——**禁止把某对象的参数写到另一对象**；同一属性在不同对象下各有其值（如「基础垫层 100mm」与「地坪垫层 300mm」并列）是**正确**的，不得"统一"或只取其一。',
    ...lines,
    // 上限治理：超预算的条目**降级为仅列名**（原实现直接 break 掉、在提示词中彻底消失）。
    // 名字+值是落位义务的最小载体，压缩详略可以，丢弃义务不行。
    ...(rest.length > 0 ? [`- 另需落位（仅列名，共${rest.length}项，须同样逐项写入正文）：${rest.map(fact => String(fact.key)).join('、')}`] : []),
  ];
}

/**
 * 绑定审计（4.55.25 P4）：把「值有没有对象」变成**可量化指标**。
 *
 * 口径与判据：
 * - `bound`：带对象锚点（抽取期从原文共现取得）的参数——写作时以「对象｜属性=值」注入，
 *   写手据此把值写到该对象处；也是唯一可作为"可改写权威"的来源。
 * - `unbound`：无对象 —— 不作为可改写权威；其**正确数量应为 0**（有锚点却抽不到 = 抽取器缺陷，
 *   按缺陷清单逐条清零），故本审计输出样例供逐条定位，不做"暂时容忍"的分类。
 * - `projectLevel`：项目主体级（工期/金额/地点等，对象即项目本身）——按其性质本无工程对象，
 *   不计入 unbound 分母。
 */
const PROJECT_LEVEL_KEY_RE = /^(?:项目名称|项目编号|招标人|建设单位|建设地点|建设规模|计划工期|合同工期|总工期|开工日期|质量标准|质量目标|合同估算价|最高投标限价|招标范围|施工范围|投标人|开标|评标|资金来源|编制依据|安全生产许可证)/u;

export interface BoundFactAudit {
  total: number;
  bound: number;
  projectLevel: number;
  unbound: number;
  /** 绑定率（= bound / (bound + unbound)，项目主体级不计入分母） */
  bindRate: number;
  unboundSamples: string[];
}

export function buildBoundFactAudit(parameterFacts: Array<{ key: string; value: string; objectName?: string }>): BoundFactAudit {
  let bound = 0;
  let projectLevel = 0;
  const unboundSamples: string[] = [];
  for (const fact of parameterFacts) {
    if (String(fact.objectName || '').trim()) { bound += 1; continue; }
    if (PROJECT_LEVEL_KEY_RE.test(String(fact.key || '').trim())) { projectLevel += 1; continue; }
    if (unboundSamples.length < 12) unboundSamples.push(`${String(fact.key).slice(0, 20)}：${String(fact.value).slice(0, 30)}`);
  }
  const unbound = parameterFacts.length - bound - projectLevel;
  const denominator = bound + unbound;
  return {
    total: parameterFacts.length,
    bound,
    projectLevel,
    unbound,
    bindRate: denominator > 0 ? bound / denominator : 1,
    unboundSamples,
  };
}

/**
 * 4.55.29 写法变体归一兜底（正文已写、只判据写法不同 → 假缺口）。
 *
 * 实测（巢湖）：真值「巢湖市光电新能源产业园项目一东区标准化厂房二标段施工」对正文
 * 「…项目—东区标准化厂房」——CJK「一」与破折号族是同一连接符的两种写法；真值
 * 「总建筑面积约为72062.84平方米」对正文「总建筑面积72062.84平方米」——概数词「约/约为」
 * 是陈述修饰而非值的一部分。这类假缺口把已落位的参数计入义务集，压低满足率并驱动修复轮
 * 往正文重复补写同一事实。
 *
 * **只在主判据（逐字命中）失败后**启用；变体只做**保守收缩**（连接符族统一、概数/范围词剔除），
 * 不做语义改写；收缩后长度不足 5 字不作数（防短串巧合命中）。
 */
const CONNECTOR_FAMILY_RE = /[一—–‑﹣]/gu;
const APPROXIMATION_WORD_RE = /(?:约(?:为)?|大约|大概|左右|共计|总计|合计|合计为|不小于|不少于|不超过|不大于|应不少于)/gu;
/** 管径/直径代号称谓族（`d300`/`DN300`/`Φ300`/`φ300`/`de300` 是同一管径的行业写法变体） */
const DIAMETER_CODE_RE = /^(?:dn|de|d|φ|ф)/iu;

function parameterVariantHits(normalizedMarkdown: string, dashUnifiedMarkdown: string, value: string): boolean {
  const unified = normalizeEngineeringTextForFactMatch(value).replace(CONNECTOR_FAMILY_RE, '-');
  if (unified.length >= 5 && dashUnifiedMarkdown.includes(unified)) return true;
  const trimmed = unified.replace(APPROXIMATION_WORD_RE, '');
  if (trimmed.length >= 5 && trimmed !== unified && dashUnifiedMarkdown.includes(trimmed)) return true;
  // 尾零归一（`4656.030m2` ↔ `4656.03m2`；与 documentFactTrace.normalizeQuantityZeros 同口径单源，
  // 实测正文写 4656.030m²、真值写 4656.03 → 逐字不等被判缺口）
  const zeroTrimmed = normalizeQuantityZeros(trimmed);
  if (zeroTrimmed.length >= 5 && zeroTrimmed !== trimmed && dashUnifiedMarkdown.includes(zeroTrimmed)) return true;
  if (normalizeQuantityZeros(dashUnifiedMarkdown).includes(zeroTrimmed)) return true;
  // 管径代号称谓归一（`d300` ↔ 正文 `DN300`）
  if (DIAMETER_CODE_RE.test(unified)) {
    const body = unified.replace(DIAMETER_CODE_RE, 'dn');
    if (body.length >= 4 && normalizedMarkdown.includes(body)) return true;
  }
  return false;
}

/** 参数使用判定（字面口径，双端 normalizeEngineeringTextForFactMatch 归一；组合值按段片段兜底） */
function parameterValueUsedIn(normalizedMarkdown: string, value: string, dashUnifiedMarkdown = ''): boolean {
  const normalizedValue = normalizeEngineeringTextForFactMatch(value);
  if (!normalizedValue) return false;
  if (normalizedMarkdown.includes(normalizedValue)) return true;
  // 组合值兜底（表格行摘要等「甲、乙、丙」多段值）：任一段（归一后 ≥5 字符）命中即视为已使用
  const fragments = value.split(/[、，,;；/|]+/u)
    .map(item => normalizeEngineeringTextForFactMatch(item))
    .filter(item => item.length >= 5);
  if (fragments.some(fragment => normalizedMarkdown.includes(fragment))) return true;
  return dashUnifiedMarkdown ? parameterVariantHits(normalizedMarkdown, dashUnifiedMarkdown, value) : false;
}

/** 参数使用归因结果（审计/修复/测试共用） */
export interface ParameterUsageBreakdown {
  /** 参数池规模（空值/噪声/商务/重复剔除后） */
  totalParams: number;
  /** 正文已使用的参数 */
  used: DocumentFact[];
  /** 相关而遗漏：与至少一个章的标题/小节词面相关且正文未使用（义务集，修复链补写对象） */
  relevantMissed: DocumentFact[];
  /** 不相关遗漏：与全部章均无词面相关且正文未使用（仅归因登记，不计义务） */
  irrelevantMissed: DocumentFact[];
  /** D6 表格噪声出池登记（图签/坐标/残片/粘连——移出义务集，保留审计） */
  noiseExcluded: Array<{ fact: DocumentFact; category: PoolNoiseCategory }>;
}

/** 参数使用归因（口径单源）：逐池参数做使用判定（字面命中 → used），未使用按「是否与任一章相关」二分归因；
 * D6 噪声条目在池入口已出池（noiseExcluded 登记），不计义务 */
export function classifyParameterUsage(
  markdown: string,
  factsModel: ParameterFactsSource | undefined | null,
  chapters: Array<{ title: string; sections?: string[] }> = [],
  options: { supersededValues?: ReadonlySet<string> } = {},
): ParameterUsageBreakdown {
  const { usable: pool, noiseExcluded } = usableParameterFacts(factsModel, options.supersededValues);
  const normalizedMarkdown = normalizeEngineeringTextForFactMatch(markdown || '');
  // 连接符族（CJK「一」/破折号）统一后的正文视图：只服务写法变体兜底（主判据不受影响）
  const dashUnifiedMarkdown = normalizedMarkdown.replace(CONNECTOR_FAMILY_RE, '-');
  const tokenSets = chapters.map(chapter => chapterParameterTokens(chapter.title, chapter.sections || []));
  const used: DocumentFact[] = [];
  const relevantMissed: DocumentFact[] = [];
  const irrelevantMissed: DocumentFact[] = [];
  for (const fact of pool) {
    if (parameterValueUsedIn(normalizedMarkdown, String(fact.value), dashUnifiedMarkdown)) {
      used.push(fact);
      continue;
    }
    const relevant = tokenSets.some(tokens => tokens.length > 0 && parameterRelevanceScore(fact, tokens) > 0);
    (relevant ? relevantMissed : irrelevantMissed).push(fact);
  }
  return { totalParams: pool.length, used, relevantMissed, irrelevantMissed, noiseExcluded };
}

/** 可靠参数使用审计（DocumentQualityReport.parameterUsageAudit 出口；义务口径见 rate 注释） */
export interface ParameterUsageAudit {
  /** 参数池规模（空值/噪声/商务/重复剔除后） */
  totalParams: number;
  /** 正文已使用参数数 */
  usedParams: number;
  /** 相关而遗漏数（义务集规模） */
  relevantMissedCount: number;
  /** 相关而遗漏明细（前 20 条，`键：值`，供交付审计核验） */
  relevantMissed: string[];
  /** 不相关遗漏数（归因：与全部章无词面相关，不计义务） */
  irrelevantMissedCount: number;
  /** D6 池净化出池计数（表格噪声：图签/坐标/残片/粘连——不计义务，只出池不删档可审计；旧存档报告无此字段） */
  noiseExcludedCount?: number;
  /** 出池噪声明细（前 10 条，`[类别]键：值` 截断，供交付审计核验） */
  noiseExcluded?: string[];
  /** 义务满足率 = usedParams/(usedParams+relevantMissedCount)；义务集为空或章集缺失（相关口径不可判定）时 null */
  rate: number | null;
}

/** 构建可靠参数使用审计：无参数池时返回 undefined（分量不可用显式降级，与 B-T3/C-T5 审计口径一致） */
export function buildParameterUsageAudit(input: {
  markdown: string;
  factsModel: ParameterFactsSource | undefined | null;
  chapters?: Array<{ title: string; sections?: string[] }>;
  /** 真值层已裁决取代的旧值（归一文本）：不得进入义务集（见 usableParameterFacts） */
  supersededValues?: ReadonlySet<string>;
}): ParameterUsageAudit | undefined {
  const chapters = input.chapters || [];
  const breakdown = classifyParameterUsage(input.markdown, input.factsModel, chapters, { supersededValues: input.supersededValues });
  if (breakdown.totalParams === 0) return undefined;
  const usedParams = breakdown.used.length;
  const relevantMissedCount = breakdown.relevantMissed.length;
  const obligationTotal = usedParams + relevantMissedCount;
  return {
    totalParams: breakdown.totalParams,
    usedParams,
    relevantMissedCount,
    relevantMissed: breakdown.relevantMissed.slice(0, 20).map(fact => `${fact.key}：${String(fact.value).slice(0, 60)}`),
    irrelevantMissedCount: breakdown.irrelevantMissed.length,
    noiseExcludedCount: breakdown.noiseExcluded.length,
    noiseExcluded: breakdown.noiseExcluded.slice(0, 10).map(item => `[${item.category}]${item.fact.key}：${String(item.fact.value).slice(0, 50)}`),
    rate: chapters.length > 0 && obligationTotal > 0 ? usedParams / obligationTotal : null,
  };
}

/** 相关而遗漏参数值列表（修复链消费；按池内顺序确定性截断，默认 ≤12） */
export function missingRelevantParameterTokens(
  markdown: string,
  factsModel: ParameterFactsSource | undefined | null,
  chapters: Array<{ title: string; sections?: string[] }> = [],
  options: { max?: number } = {},
): string[] {
  const max = Math.max(1, options.max ?? 12);
  return classifyParameterUsage(markdown, factsModel, chapters).relevantMissed
    .map(fact => String(fact.value).trim())
    .filter(value => value.length > 0 && value.length <= 80)
    .slice(0, max);
}

/** 参数值可注入长度上限（与 missingRelevantParameterTokens 同口径：超长值无法自然嵌入正文，不进补写指令） */
const PARAMETER_REPAIR_VALUE_MAX = 80;

/**
 * 每章单轮补写指令的**批量**（不是截断）——超出本批的参数由后续轮次继续消费。
 *
 * 历史教训（本常量本身就是证据）：初版 6/24 在 s28l 的 74 条缺口下仅覆盖 17 条，
 * 义务满足率上不去；当时的处置是**放宽上限**（6/24 → 16/96）而不是去掉总量上限——
 * 于是 96 条以外的参数**仍永不修复**，只是把悬崖往后挪了一格。任何固定的总量上限
 * 都是「把丢失伪装成预算」，项目数据量一大就复现。
 *
 * 现口径：**分配层不设任何上限**——每个相关而遗漏的参数都必须有主章。
 * 此前还有「每章 16 条」的批量上限，其副作用是**所有章都满额时该参数被整体丢弃**
 *（内层择优循环走完仍未分配），同样是丢失。上限的正当位置在**指令渲染层**：
 * 那里按真实 prompt 预算决定本轮展示多少条，剩余项由后续轮次继续（分配函数每轮基于
 * **当前正文**重算 relevantMissed，已落位的自然退出）。分配层一旦截断，
 * 渲染层再正确也拿不到被截掉的那些。
 */

/** 相关而遗漏参数 → 目标章索引的修复分配（逐条按相关性降序取章，同分取大纲靠前章；
 * 首选章满额时顺位次优章——仅分数 >0 的章可承载，防单章拥塞（s28l 质量/施工方法两章集中 60+ 条）
 * 造成分配浪费；逐章/总量限额防指令膨胀） */
export function assignMissingParameterChapters(
  markdown: string,
  factsModel: ParameterFactsSource | undefined | null,
  chapters: Array<{ title: string; sections?: string[] }> = [],
): Map<number, string[]> {
  const assignment = new Map<number, string[]>();
  if (chapters.length === 0) return assignment;
  const missed = classifyParameterUsage(markdown, factsModel, chapters).relevantMissed;
  if (missed.length === 0) return assignment;
  const tokenSets = chapters.map(chapter => chapterParameterTokens(chapter.title, chapter.sections || []));
  for (const fact of missed) {
    const value = String(fact.value).trim();
    if (value.length === 0 || value.length > PARAMETER_REPAIR_VALUE_MAX) continue;
    // 相关性降序候选章（同分取大纲靠前章；分数 >0 才入候选——与 relevantMissed 判定同尺度）
    const ranked = tokenSets
      .map((tokens, index) => ({ index, score: tokens.length === 0 ? 0 : parameterRelevanceScore(fact, tokens) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    // 逐章择优：取相关性最高的章；同章聚合为一条补写指令（指令大小由渲染层按预算控制）
    const best = ranked[0];
    if (best) {
      const list = assignment.get(best.index) ?? [];
      list.push(value);
      assignment.set(best.index, list);
    }
  }
  return assignment;
}

/** 可靠参数义务满足率门槛（C3-4 验收出口：可落位者全落位；义务集规模小于最小值时不判定防小样本抖动） */
export const PARAMETER_OBLIGATION_MIN_RATE = 0.9;
export const PARAMETER_OBLIGATION_MIN_TOTAL = 8;

/**
 * 可靠参数义务缺口检测（参数池净化后义务满足率 < 门槛 → error）：
 * 与报告出口 buildParameterUsageAudit.rate、修复出口 assignMissingParameterChapters 同源单源
 * （classifyParameterUsage）——检测定位=修复定位（content-depth-repair 按 provenance 消费本类 error）。
 * 义务集为空或章节缺失（相关口径不可判定）时不判定。
 */
export function parameterObligationUsageIssues(
  markdown: string,
  factsModel: ParameterFactsSource | undefined | null,
  chapters: Array<{ title: string; sections?: string[] }> = [],
  options: { supersededValues?: ReadonlySet<string> } = {},
): ValidationIssue[] {
  if (chapters.length === 0) return [];
  const breakdown = classifyParameterUsage(markdown, factsModel, chapters, options);
  const obligationTotal = breakdown.used.length + breakdown.relevantMissed.length;
  if (obligationTotal < PARAMETER_OBLIGATION_MIN_TOTAL) return [];
  const rate = breakdown.used.length / obligationTotal;
  if (rate >= PARAMETER_OBLIGATION_MIN_RATE) return [];
  const samples = breakdown.relevantMissed.slice(0, 3).map(fact => String(fact.value).slice(0, 30));
  return [{
    level: 'error',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `可靠参数义务落位不足：${breakdown.used.length}/${obligationTotal}（相关而遗漏 ${breakdown.relevantMissed.length} 项${samples.length > 0 ? `，缺失如 ${samples.join('、')}` : ''}）`,
    suggestion: '请将资料中的可靠参数（规格/型号/尺寸/强度/规范编号等）在对应章节的对应位置自然写入，保持原值原形态（数字、单位、编号中的连字符与年份不得改写、拆分或省略）；商务金额、单价、税率、预留金类数据一律不得写入正文。',
    provenance: { detectorId: 'parameter-obligation-usage', fingerprint: stableHash(markdown) },
  }];
}
