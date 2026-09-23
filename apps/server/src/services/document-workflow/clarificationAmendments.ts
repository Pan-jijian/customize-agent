/**
 * 答疑技术性修正通道（4.55.36 批次 2 / 方案 2-1~2-5）：答疑文件的**非单值技术性修正**权威化。
 *
 * **实测缺陷（巢湖 doc-1790144107028）**：补疑文件「…补疑2026.9.1.docx」已入库、已召回
 * （草稿证据池里该文件路径出现 1483 次），但其中一半技术性修正**从未进入终稿**——
 * 雨水口连接管混凝土满包 / 地上楼梯间踏步 304 不锈钢防滑条 30*1.5mm / ±0.000 相当于绝对标高 8.00 /
 * 一期已完成以围墙为分界线，终稿出现次数均为 0。
 *
 * **根因**：答疑文件此前只作为**普通证据**参与检索。答疑的「一问一答一短句」形态与任何章节主题都
 * 不强相关（语义相似度≈0），永远进不了章节证据窗口；值级覆盖链（valueOverride.CHANGE_CONNECTORS →
 * clarificationOverrides.extractClarificationOverrides）只覆盖**单值口径**（合同金额/计划工期/开工日期/
 * 暂列金额），而「改为180°中粗砂基础」「取消此划线」「不涉及」「混凝土满包」这类**技术性修正**没有通道。
 *
 * **本模块**：从答疑/澄清/补疑文本抽「对象 + 变更动作 + 变更后内容（+ 变更前内容）」四元组，
 * 按章归属注入写作硬约束（修正后必须写、修正前不得写），并在终检按**同一账本**报出残留/未落位。
 *
 * 判据（形态驱动、零 LLM、**不预设对象词表、不含任何项目值**）：
 *   · 问答句式：答句（`答：/回复：/答复：`）是修正载体，问句提供对象与修正前形态；
 *   · 变更动作（值级单源 CHANGE_CONNECTORS 的超集）：
 *       替换族 `改为/均改为/暂按/调整为/变更为/修正为…`（动作后紧跟修正后内容）
 *       取消族 `取消/不涉及/不需要/不用/不做/去除`（动作前的宾语为被取消对象）
 *       指向族 `按…执行/实施/计入`、`以…为准/为分界线`、答句首 `采用…`（整句即修正后内容）
 *       确认族 是非问的肯定答（`是的/可以/需要`）以及对问句谓词的短答（`混凝土满包`/`C25`）
 *   · 修正后内容 = 动作补语；无补语时取问句谓词的**肯定形态**（`X是否采用Y` → `X采用Y`）。
 *   · 修正前内容 = 问句实践谓词（为/采用/按/用）的补语（替换族）或答句取消动作前的宾语（取消族）。
 *
 * **问答配对只在有序全文上做**：KB 切片把问句与答句放在不同 chunk、证据池按分数排序，
 * 在碎片池上「最近邻配对」实测正确率不足半数——配错对象比不抽更糟，故写作侧与检测侧共用
 * `clarificationSourceTexts`（有序全文：`getCachedFileDetail` 的 chunks 顺序）。
 *
 * **账本单源**：抽出的账本（ClarificationAmendment[]）同时是写作注入与终检检测的**唯一输入**
 * （`session.planning.clarificationAmendments` → 终检 caliber-consistency 容器内同族检测），
 * 杜绝「写手被告知的账本」与「检测器比对的账本」两份漂移（4.55.22 的两个单一真值源教训）。
 *
 * **与值级覆盖的关系（2-4）**：单值口径继续走 valueOverride/clarificationOverrides 既有链，
 * 本通道只补**非单值技术性修正**；两者共享同一条「生效/被取代」语义——修正后 = 生效形态，
 * 修正前 = 被取代形态（正文作为现行做法出现即残留，措辞与 provenance 与「被取代口径残留」同族）。
 *
 * 形态覆盖与已知缺口（诚实记录，不静默）：
 *   · 覆盖：一问一答（同行内联/分段/编号均可）、一句多答（`答：需要，X不需要`）、
 *     答句内先因后果（`答：机动车地面停车位皆为植草砖，取消此划线`）、是非问确认、短答；
 *   · **不覆盖（显式缺口，见 unparsedAnswers）**：① 非问答形态的平铺技术陈述——如补疑
 *     「温馨提示」里的「本工程采用国家2000高程系统,建筑室内±0.000相当于绝对标高为8.00」，
 *     无问答结构也无变更动词，按判据不抽，由 `unparsedAnswers`/诊断上报为缺口；
 *     ② 答句为纯指向（`见下图`/`详S02说明`/`SW01第四章节`）时不产出修正——指向不是可写作内容；
 *     ③ 同段落内「问-答-问」连环（PDF 抽取后同行粘连）时，最后一个问句可能被截掉。
 */

import type { ValidationIssue } from './types';
import { sourcePriority } from './authoritativeValues';
import { assignBillRowChapter } from './billFactLock';
import { CHANGE_REFERENCE_CONTEXT_RE, isClarificationSource } from './clarificationOverrides';
import { extractEngineeringMeasureTokens, normalizeEngineeringTextForFactMatch } from './engineeringUnits';
import { stableHash } from './utils';
import { CHANGE_CONNECTORS, classifyValueShape } from './valueOverride';

/** 本通道 issue 的 provenance 单源（终检按此 id 失效重跑，见 issueProvenance.SNAPSHOT_DETECTOR_IDS） */
export const CLARIFICATION_AMENDMENT_DETECTOR_ID = 'clarification-amendment';

/** 修正形态：replace=替换（修正前→修正后）、confirm=确认（是非问确认/短答/指向，正文必须体现）、
 *  cancel=取消（否定型修正，正文不得再把被取消项作为现行做法） */
export type ClarificationAmendmentKind = 'replace' | 'confirm' | 'cancel';

export interface ClarificationAmendmentBefore {
  /** 修正前形态原文（正文出现即「被取代形态残留」） */
  text: string;
  /** 形态强度：携带量值/规格（可逐字比对）→ strong（残留判 blocker）；纯词面短语 → weak（残留判 warning） */
  strength: 'strong' | 'weak';
}

export interface ClarificationAmendment {
  kind: ClarificationAmendmentKind;
  /** 修正对象（问句实践谓词的主语 / 答句取消动作的宾语；人可读，供追溯与按章归属） */
  object: string;
  /** 变更动作原文（供追溯：`均改为`/`取消`/`是的`/`短答`…） */
  action: string;
  /** 修正后内容：写作必须按此表述；cancel 族为否定表述（`不需要`/`取消X`） */
  after: string;
  /** 修正前内容：正文作为现行做法出现即残留；cancel 族为被取消对象 */
  before: ClarificationAmendmentBefore[];
  /** 来源文件（人可追溯） */
  source: string;
  /** 原文答句（溯源，截断 200 字） */
  excerpt: string;
  /** 章归属（复用清单事实锁的「对象→章」单源 assignBillRowChapter）；缺省 = 全文适用块 */
  chapterTitle?: string;
  /** 建议落位小节（assignBillRowChapter 同源产出） */
  section?: string;
}

export interface ClarificationAmendmentLedger {
  amendments: ClarificationAmendment[];
  /** 显式缺口：问答对里**未能解析**的短答（≤40 字，既非指向型也无动作词）——不静默丢弃 */
  unparsedAnswers: Array<{ question: string; answer: string; source: string }>;
  /** 显式缺口：**非问答形态的平铺技术陈述**（携带量值 + 规范动词，却既无问答结构也无变更动词）——
   * 例：巢湖补疑「温馨提示」的「建筑室内±0.000相当于绝对标高为8.00」。判据不抽（可能误伤工程陈述），
   * 但必须可见：诊断计数 + 样本（仅诊断，绝不注入提示词）。 */
  uncoveredStatements: { count: number; samples: Array<{ text: string; source: string }> };
  /** 源文件数（诊断用） */
  sourceCount: number;
  /** 问答对总数（诊断用：抽取覆盖分母） */
  pairCount: number;
}

/** 平铺技术陈述的形态闸（诊断用，只做「值得人工看一眼」的筛选，不进提示词） */
const DECLARATIVE_MEASURE_RE = /(?:\d|±)/u;
const DECLARATIVE_NORM_RE = /(?:采用|按|执行|为准|不得|应|必须|相当于|统一|计入)/u;

// ────────────────────────────── 文本切分（问答句对） ──────────────────────────────

/** 答句标记：答疑文本里修正内容的载体边界 */
const ANSWER_MARKER_RE = /(?:答|回复|答复|回\s*答)\s*[:：]/gu;
/** 问句起始标记（编号 / 问 / 问题）：段首编号用于裁掉上一答残留 */
const QUESTION_START_RE = /(?:^|[\n。；;！])\s*(?:#{1,4}\s*)?(?:\d{1,3}\s*[、.．)）]|问\s*[:：]|问题\s*\d{0,2}\s*[:：]?)/u;
/** 行内编号（`…DN1006、屋面太阳能光伏是否…`：PDF 抽取把两问粘在一行）：取最后一个行内编号为问句起点。
 * `.`/`．` 后接数字视为小数点（`4.200处梁面标高` 不是编号），不当切点。 */
const INLINE_ITEM_RE = /\d{1,3}\s*(?:[、)）]|[.．](?!\d))/gu;
/** 停顿符（答句尾部混入的下一个问句在此截断） */
const SENTENCE_PAUSE_RE = /[。；;，,\n]/u;

function cleanInline(text: string): string {
  return String(text || '').replace(/\s+/gu, ' ').replace(/^(?:#{1,4}|[-*])\s*/u, '').trim();
}

function paragraphBoundsOf(text: string, index: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const end = text.indexOf('\n', index);
  return { start, end: end === -1 ? text.length : end };
}

/** 上一个非空行的起点（答疑文本按空行分段；答句自成一段时，问句在上一段） */
function previousParagraphStart(text: string, position: number): number {
  let end = position;
  while (end > 0) {
    const lineEnd = text[end - 1] === '\n' ? end - 1 : end;
    const lineStart = text.lastIndexOf('\n', Math.max(0, lineEnd - 1)) + 1;
    if (text.slice(lineStart, lineEnd).trim()) return lineStart;
    end = lineStart;
  }
  return 0;
}

/** 问句裁剪：段首编号之后 / 行内最后一个编号之后（去掉上一答的残留尾巴） */
function trimToQuestionStart(text: string): string {
  const matches = [...text.matchAll(new RegExp(QUESTION_START_RE.source, 'gu'))];
  const last = matches[matches.length - 1];
  let sliced = last?.index === undefined ? text : text.slice(last.index + last[0].length);
  // 行内粘连（`…DN1006、屋面太阳能光伏是否在本次招标范围？`）：编号不在段首，取最后一个行内编号
  const inline = [...sliced.matchAll(new RegExp(INLINE_ITEM_RE.source, 'gu'))];
  const lastInline = inline[inline.length - 1];
  if (lastInline?.index !== undefined && lastInline.index > 0) {
    const tail = sliced.slice(lastInline.index + lastInline[0].length);
    if (tail.trim().length >= 6) sliced = tail;
  }
  return cleanInline(sliced).slice(-300);
}

/** 答句裁剪：段内尾部混入的下一个问句（同行「问-答-问」粘连）截掉 */
function trimAnswerTail(answer: string): string {
  const text = cleanInline(answer);
  const lastQuestion = Math.max(text.lastIndexOf('？'), text.lastIndexOf('?'));
  if (lastQuestion < 0) return text;
  const reversed = [...text.slice(0, lastQuestion)].reverse().join('');
  const pause = SENTENCE_PAUSE_RE.exec(reversed);
  const cut = pause?.index === undefined ? lastQuestion : lastQuestion - pause.index - 1;
  return (cut > 0 ? text.slice(0, cut + 1) : text.slice(0, lastQuestion)).trim();
}

/** 问答句对切分（**必须在有序全文上运行**）：答句 = 标记所在段落内、标记之后的内容；
 * 问句 = 本段段首（或上一答结束处，取较后者）到标记之间被裁到问句起点 */
export function segmentClarificationPairs(text: string): Array<{ question: string; answer: string; questionParagraph: string; answerParagraph: string }> {
  const pairs: Array<{ question: string; answer: string; questionParagraph: string; answerParagraph: string }> = [];
  const markers = [...text.matchAll(ANSWER_MARKER_RE)];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index]!;
    const markerStart = marker.index || 0;
    const answerStart = markerStart + marker[0].length;
    const answerParagraph = text.slice(answerStart, paragraphBoundsOf(text, answerStart).end).trim();
    const answer = trimAnswerTail(answerParagraph);
    if (!answer) continue;
    const paragraphStart = paragraphBoundsOf(text, markerStart).start;
    const previous = markers[index - 1];
    const previousEnd = previous?.index === undefined ? 0 : previous.index + previous[0].length;
    // 内联问答（问句与答句同段/同行）：问句在标记之前；否则问句自成一段，取上一非空段
    const questionStart = text.slice(paragraphStart, markerStart).trim() ? paragraphStart : previousParagraphStart(text, paragraphStart);
    const from = Math.max(questionStart, previousEnd);
    pairs.push({
      question: trimToQuestionStart(text.slice(from, markerStart)),
      answer,
      questionParagraph: text.slice(from, markerStart).trim(),
      answerParagraph,
    });
  }
  return pairs;
}

// ────────────────────────────── 动作判据 ──────────────────────────────

/** 替换族：值级单源 CHANGE_CONNECTORS 的超集（答疑特有：改为/均改为/暂按…考虑） */
const REPLACE_ACTION_RE = new RegExp(
  `${CHANGE_CONNECTORS}|均改为|全部改为|统一改为|一律改为|改成|改为|暂按|暂定按`,
  'u',
);
/** 取消族（否定型修正）：动作前的宾语为被取消项 */
const CANCEL_ACTION_RE = /(?:不涉及|不需要|不需|无需|不用|不做|不再|取消|去除|删除|不予)/u;
/** 取消族中「显式移除具名对象」的动作——只有它们才把动作前宾语登记为残留形态 */
const CANCEL_NAMED_OBJECT_RE = /(?:不涉及|取消|去除|删除)/u;
/** 指向族：整句是对「做法/依据」的指向或确认（`按X执行`、`以X为准/为分界线`、答句首 `采用X`） */
const POINT_TO_FRAME_RE = /(?:按|依据|参照)[^，。；]{2,40}?(?:执行|实施|施工|计入|做法|说明|要求|考虑)|以[^，。；]{2,24}?为(?:准|分界(?:线|点)?|依据|界限|原则)|^采用[^，。；]{2,40}$/u;
/** 确认族：整子句为肯定答（是非问的确认形态） */
const AFFIRMATIVE_CLAUSE_RE = /^(?:是|是的|对|对的|可以|可行|可采用|可|需要|需|要|必须|应|应该|均需|均要|均按|同意|确认|有|会)[。！]?$/u;
/** 「无须修正」的确认（`无误`/`正确`：确认设计无误，不产生写作义务——义务在答句其余子句里） */
const NOOP_AFFIRMATIVE_CLAUSE_RE = /^(?:无误|正确|无异议|没问题|没有问题|符合)[。！]?$/u;
/** 问句里的疑问标记（短答族的前置条件：这是提问，不是陈述） */
const QUESTION_HINT_RE = /(?:是否|要不要|需不需要|够不够|能不能|可不可以|可否|能否|多少|多大|多高|多厚|多久|何种|哪些|如何|怎么|为何|为什么|有无|未见|未明确|请明确|请确认|规格|型号|尺寸|材质|做法|要求|标准|标号|强度等级|数量|高度|厚度|宽度|长度|标高|管径|参数|品牌)/u;
/** 纯指向型短答（见/详/参图集）：指向不是可写作内容，不入本通道（落位与否由图纸/图集锁另判） */
const POINTER_ANSWER_RE = /^(?:见|详见|参见|参照|参图|详|按图|依图|如图|附图|不在此次|不在本次|不在|无(?:专项)?图)/u;
/** 指向型补语（`SW01中的第四章节`/`详S02说明`/`建施-…`）：不可写作，替换族遇到即跳过 */
const POINTER_COMPLEMENT_RE = /(?:详见|参见|参照|图集|图号|大样|建施|结施|SW\s*\d|S\s*\d{2}|04S516)/u;
/** 非技术补语噪声闸（体裁判据，非对象词表）：商务/费用/工期类口径走值级覆盖链，不属本通道 */
const NON_TECHNICAL_COMPLEMENT_RE = /(?:费用|报价|清单|投标人|中标|结算|不予调整|工期|日历天|万元|亿元|元)/u;
/** 量值/规格形态（含中文量词：`两道`/`三遍`）——残留判 blocker 的形态闸 */
const MEASURE_SHAPE_RE = /(?:\d|[一二三四五六七八九十两])\s*(?:道|遍|层|次|个|座|套|台|根|块|处|项|只|组|片|扇|樘|米|厚|mm|cm|km|m|㎡|m2|m3|吨|t|kg|kw|kv|kva|v|a|w|j|pa|mpa)/iu;
/** 对象前导连接词/代词/疑问引导（`而井室四周` → `井室四周`、`是否在地坪直接砌筑` → `在地坪直接砌筑`） */
const OBJECT_LEAD_RE = /^(?:(?:是否|请问|请明确|请确认|请设计确认|明确|[而但且并则即故均皆也都又于此该项上述以上其中另另外再需需要应必须全部整体为是])+)/u;
/** 对象尾部疑问残留（`管底基础至管顶上50cm是否` → `管底基础至管顶上50cm`、`井室四周为何` → `井室四周`） */
const OBJECT_TAIL_RE = /(?:是否|要不要|需不需要|为何|如何|怎么|多少|多大|哪些|需|需要|要|应|应该|必须|可否|能否|全部|均|皆|的)+$/u;

/** 修正形态强度（形态判据，非词表）：携带量值/规格 → 可逐字比对，残留判 blocker */
export function amendmentFormStrength(text: string): 'strong' | 'weak' {
  const value = String(text || '');
  return /\d/u.test(value) || MEASURE_SHAPE_RE.test(value) || classifyValueShape(value) !== 'text' ? 'strong' : 'weak';
}

function cleanObject(raw: string): string {
  return String(raw || '')
    .split(/[？?]/u)[0]!
    .replace(OBJECT_LEAD_RE, '')
    .replace(OBJECT_TAIL_RE, '')
    .replace(/[？?。！!，,、；;：:\s]+$/u, '')
    .trim()
    .slice(0, 40);
}

/** 商务尾巴截断（`…按7.5m计入，投标人应充分踏勘现场，自行承担风险，不予调整` → 只留技术部分）：
 * 体裁判据（费用/报价/投标人责任属值级与商务链），不是对象词表 */
function cutCommercialTail(text: string): string {
  const parts = String(text || '').split(/[，,]/u).map(part => part.trim()).filter(Boolean);
  const cut = parts.findIndex((part, index) => index >= 1 && NON_TECHNICAL_COMPLEMENT_RE.test(part));
  return (cut > 0 ? parts.slice(0, cut) : parts).join('，');
}

function cleanComplement(raw: string): string {
  return cutCommercialTail(String(raw || '').split(/[？?]/u)[0]!)
    .replace(/^[，,、。；;：:\s]+/u, '')
    .replace(/^(?:是的|是|对|对的|可以|可行|需要的?|需要)[，,、]+/u, '')
    .replace(/[？?。；;！!]+$/u, '')
    // 拆解取消项后可能留下悬空动词（`…防火涂料表面再喷涂`）：一并去掉
    .replace(/(?:再|重新)?(?:喷涂|涂刷|刷|做|施工|采用|设置|进行|安装|铺设|设置)+$/u, '')
    .replace(/(?:是否|需不需要|需要|需|应|应该|必须|均|皆|要|可行|可以|吗|呢|吧)+$/u, '')
    .trim()
    .slice(0, 60);
}

function sentencesOf(text: string): string[] {
  return String(text || '').split(/[。；;\n]/u).map(part => part.trim()).filter(Boolean);
}

function clausesOf(text: string): string[] {
  return String(text || '').split(/[。；;，,？?\n]/u).map(part => part.trim()).filter(Boolean);
}

/** 问句实践谓词（`X为Y`/`X采用Y`/`X按Y`/`X用Y`）：给出对象 X 与修正前形态 Y */
function practicePredicatesOf(question: string): Array<{ object: string; complement: string }> {
  const out: Array<{ object: string; complement: string }> = [];
  for (const clause of clausesOf(question)) {
    const match = /^(.*?)(?:均为|皆为|采用|为|按|用|做)(.+)$/u.exec(clause);
    if (!match) continue;
    const object = cleanObject(match[1] || '');
    // 疑问词粘连（`而井室四周为何采用塘渣石回填`：谓词捕在「为」，补语残留「何采用…」）
    const complement = cleanComplement((match[2] || '').replace(/^(?:何|为何|如何|怎么)?(?:均为|皆为|采用|为|做|用|按)/u, ''));
    if (object.length < 2 || complement.length < 2 || complement.length > 24) continue;
    if (NON_TECHNICAL_COMPLEMENT_RE.test(complement) || POINTER_COMPLEMENT_RE.test(complement)) continue;
    out.push({ object, complement });
  }
  return out;
}

/** 问句核心对象（实践谓词对象优先；回退：从末句向前找疑问标记之前的成分） */
function questionObjectOf(question: string): string {
  const practice = practicePredicatesOf(question);
  if (practice.length > 0) return practice[0]!.object;
  const clauses = clausesOf(question);
  for (let index = clauses.length - 1; index >= 0; index -= 1) {
    const clause = clauses[index]!;
    const cut = clause.split(/是否|要不要|需不需要|可否|能否|多少|多大|怎么|如何|为何|为什么|请明确|请确认|请问|有无/u)[0] || clause;
    const object = cleanObject(cut);
    if (object.length >= 2) return object;
  }
  return cleanObject(clauses[clauses.length - 1] || question);
}

/** 问句谓词的肯定形态（`X是否采用Y` → `X采用Y`；`X要不要做Y` → `X要做Y`）：确认族的修正后内容 */
function questionAssertionOf(question: string): string {
  const sentence = sentencesOf(question).pop() || question;
  const affirmative = sentence
    .replace(/[？?]+$/u, '')
    .replace(/^(?:请明确|请确认|请设计确认|请问|明确)+/u, '')
    .replace(/是否|要不要|需不需要|可否|能否|能不能|可不可以/u, (match) => (match === '需不需要' ? '需' : match === '可否' || match === '能否' || match === '能不能' || match === '可不可以' ? '可以' : ''))
    .replace(/有无/u, '')
    .trim();
  return cleanComplement(affirmative);
}

// ────────────────────────────── 抽取 ──────────────────────────────

function beforeEntry(text: string): ClarificationAmendmentBefore {
  return { text, strength: amendmentFormStrength(text) };
}

function amendmentKey(item: ClarificationAmendment): string {
  return `${normalizeEngineeringTextForFactMatch(item.object)}|${normalizeEngineeringTextForFactMatch(item.after)}`;
}

/** 单问答对的修正抽取（形态驱动；不预设对象词表） */
function amendmentsFromPair(question: string, answer: string, source: string): ClarificationAmendment[] {
  const out: ClarificationAmendment[] = [];
  const excerpt = answer.slice(0, 200);
  const questionObject = questionObjectOf(question);
  const practice = practicePredicatesOf(question);
  const base = { source, excerpt } as const;
  const answerClauses = clausesOf(answer);
  for (let clauseIndex = 0; clauseIndex < answerClauses.length; clauseIndex += 1) {
    const clause = answerClauses[clauseIndex]!;
    if (clause.length < 2) continue;
    // ① 替换族：动作后紧跟修正后内容（`答：改为180°中粗砂基础` / `答：均改为2：8灰土回填`）。
    // 修正后口径跨越句子的情形（`答：改为180°中粗砂基础。并外设土工布。`）：并/且/同时 起头的
    // 后续子句属同一修正后内容的延续，并入 after（该子句自身无变更动作时）
    const replace = REPLACE_ACTION_RE.exec(clause);
    if (replace) {
      const continuation = (() => {
        const next = answerClauses[clauseIndex + 1];
        if (!next || !/^(?:并|且|同时|另|还|再)/u.test(next)) return '';
        if (REPLACE_ACTION_RE.test(next) || CANCEL_ACTION_RE.test(next)) return '';
        return next;
      })();
      const afterBody = `${clause.slice(replace.index + replace[0].length)}${continuation ? `。${continuation}` : ''}`;
      const after = cleanComplement(afterBody);
      const inlineObject = cleanObject(clause.slice(0, replace.index));
      if (after.length < 2 || after.length > 60 || POINTER_ANSWER_RE.test(after) || POINTER_COMPLEMENT_RE.test(after)) continue;
      const before = [
        ...(inlineObject.length >= 2 && inlineObject !== questionObject && !NON_TECHNICAL_COMPLEMENT_RE.test(inlineObject) ? [beforeEntry(inlineObject)] : []),
        ...practice.filter(item => item.complement !== after).map(item => beforeEntry(item.complement)),
      ];
      out.push({ kind: 'replace', object: inlineObject.length >= 2 && inlineObject !== questionObject ? inlineObject : questionObject, action: replace[0].trim(), after, before, ...base });
      continue;
    }
    // ② 取消族：否定型修正（`答：不涉及` / `氯化橡胶面漆两道不需要` / `取消此划线`）
    const cancel = CANCEL_ACTION_RE.exec(clause);
    if (cancel) {
      const namedObject = cleanObject(clause.slice(0, cancel.index));
      const object = namedObject.length >= 2 ? namedObject : questionObject;
      const suffix = cleanComplement(clause.slice(cancel.index + cancel[0].length));
      const after = `${cancel[0]}${suffix}`.slice(0, 40);
      // 商务型否定（`不予调整`）不入本通道（体裁判据）
      if (/^不予/u.test(cancel[0]) && NON_TECHNICAL_COMPLEMENT_RE.test(clause)) continue;
      // 残留形态只在「显式移除具名对象」或「被取消项带量值/规格形态」时登记：
      // 否则（`防火涂料表面不需再做面漆`）会把合法出现的对象词面判成残留（误伤闸）
      const before = namedObject.length >= 2 && (CANCEL_NAMED_OBJECT_RE.test(cancel[0]) || amendmentFormStrength(namedObject) === 'strong')
        ? [beforeEntry(namedObject)]
        : [];
      out.push({ kind: 'cancel', object, action: cancel[0].trim(), after, before, ...base });
      continue;
    }
  }
  // ③ 指向族：整答句即修正后内容（`答：是的，按沥青道路做法实施` / `答：以围墙为分界线，一期已完成…`）
  const frame = POINT_TO_FRAME_RE.exec(answer);
  if (frame && !POINTER_ANSWER_RE.test(answer) && !POINTER_COMPLEMENT_RE.test(answer)) {
    const after = cleanComplement(trimAnswerTail(answer));
    // `以X为分界线/为准`：X 即修正对象（形态判据，非词表）
    const frameObject = cleanObject(/以([^，。；]{2,12})为(?:准|分界(?:线|点)?|依据|界限|原则)/u.exec(after)?.[1] || questionObject);
    if (after.length >= 4) out.push({ kind: 'confirm', object: frameObject || questionObject, action: frame[0].slice(0, 16), after, before: [], ...base });
  }
  // ④ 确认族：是非问的肯定答（`答：是的` / `答：需要` / `答：可以`）。
  // 「需要 X，不需要 Y」形态下本族与②取消族并存（X 要写、Y 不得写），不因②已产出而跳过。
  for (const clause of clausesOf(answer)) {
    if (NOOP_AFFIRMATIVE_CLAUSE_RE.test(clause)) continue;
    if (!AFFIRMATIVE_CLAUSE_RE.test(clause)) continue;
    const assertion = questionAssertionOf(question);
    if (assertion.length < 4) continue;
    out.push({ kind: 'confirm', object: questionObject, action: clause.replace(/[。！]$/u, ''), after: assertion, before: [], ...base });
    break;
  }
  if (out.length === 0) {
    // ⑤ 短答族：对疑问句的短答即修正后内容（`答：混凝土满包` / `答：C25` / `答：304不锈钢防滑条30*1.5mm`）
    // 答句首的「无须修正」确认（`答：无误，11号为深照型灯具`）剥掉后，实质内容照抽
    const bare = cleanComplement(answer.replace(/[。！]$/u, '').replace(/^(?:无误|正确|无异议|没问题|没有问题|符合)[，,、]?/u, ''));
    if (bare.length >= 2 && bare.length <= 40
      && /[？?]/u.test(question)
      && QUESTION_HINT_RE.test(question)
      && !POINTER_ANSWER_RE.test(bare)
      && !POINTER_COMPLEMENT_RE.test(bare)
      && !NON_TECHNICAL_COMPLEMENT_RE.test(bare)
      && !REPLACE_ACTION_RE.test(bare)
      && !CANCEL_ACTION_RE.test(bare)) {
      out.push({ kind: 'confirm', object: questionObject, action: '短答', after: bare, before: [], ...base });
    }
  }
  return out.slice(0, 3);
}

/** 同对内的语义重复/自相矛盾收敛：取消项从「问句肯定形态」里剔除；被包含的确认断言让位于精确动作句 */
function reconcilePair(amendments: ClarificationAmendment[]): ClarificationAmendment[] {
  const cancels = amendments.filter(item => item.kind === 'cancel');
  const adjusted = amendments.map(item => {
    if (item.kind === 'cancel') return item;
    let after = item.after;
    for (const cancel of cancels) {
      if (cancel.object.length >= 3 && after.includes(cancel.object)) after = after.replace(cancel.object, '');
    }
    return after === item.after ? item : { ...item, after: cleanComplement(after) };
  });
  return adjusted.filter((item, index) => {
    if (item.after.length < 2) return false;
    return !adjusted.some((other, otherIndex) => {
      if (otherIndex === index || other.after.length < 4) return false;
      const sameObject = normalizeEngineeringTextForFactMatch(other.object) === normalizeEngineeringTextForFactMatch(item.object);
      // 同一修正对象下，「确认」若被另一条更精确的修正覆盖（after 互为子串）→ 只留精确那条
      if (sameObject && item.kind === 'confirm' && item.after.includes(other.after)) return true;
      // 与另一条修正指向同一修正后内容时：保留精确动作句，丢掉「是的/短答」这类泛指确认
      return other.after.length < item.after.length && item.after.includes(other.after) && AFFIRMATIVE_CLAUSE_RE.test(item.action);
    });
  });
}

export interface ExtractClarificationAmendmentsInput {
  /** 源文本（source 为文件路径/来源串，经 isClarificationSource 判定是否为答疑澄清载体） */
  texts: Array<{ text: string; source: string }>;
  /** 账本条数上限（提示词预算保护；超出丢弃，条数在诊断可见） */
  maxAmendments?: number;
}

/**
 * 抽取答疑技术性修正账本（含显式缺口）。
 * 只处理 `isClarificationSource(source)` 的源——招标正文/清单/图纸的同形句不入本通道
 * （它们没有「修正」语义，抽出来只会变成误伤）。
 */
export function extractClarificationAmendmentLedger(input: ExtractClarificationAmendmentsInput): ClarificationAmendmentLedger {
  const amendments: ClarificationAmendment[] = [];
  const unparsedAnswers: Array<{ question: string; answer: string; source: string }> = [];
  const uncoveredSamples: Array<{ text: string; source: string }> = [];
  const seen = new Set<string>();
  let sourceCount = 0;
  let pairCount = 0;
  let uncoveredCount = 0;
  const maxAmendments = input.maxAmendments ?? 80;
  for (const item of input.texts || []) {
    const text = String(item?.text || '');
    const source = String(item?.source || '');
    if (!text || !isClarificationSource(source)) continue;
    sourceCount += 1;
    const coveredParagraphs = new Set<string>();
    const pairs = segmentClarificationPairs(text);
    for (const pair of pairs) {
      pairCount += 1;
      coveredParagraphs.add(pair.questionParagraph);
      coveredParagraphs.add(pair.answerParagraph);
      const extracted = reconcilePair(amendmentsFromPair(pair.question, pair.answer, source))
        .filter(amendment => amendment.object.length >= 2 && amendment.after.length >= 2);
      if (extracted.length === 0) {
        const answer = pair.answer.trim();
        // 显式缺口：非指向型、非商务噪声的短答（≤40 字）说明我们没读懂，登记而非静默丢弃
        if (answer.length >= 2 && answer.length <= 40 && !POINTER_ANSWER_RE.test(answer) && !NON_TECHNICAL_COMPLEMENT_RE.test(answer)) {
          unparsedAnswers.push({ question: pair.question.slice(0, 80), answer: answer.slice(0, 80), source });
        }
        continue;
      }
      for (const amendment of extracted) {
        const key = amendmentKey(amendment);
        if (seen.has(key) || amendments.length >= maxAmendments) continue;
        seen.add(key);
        amendments.push(amendment);
      }
    }
    // 未被任何问答对覆盖的平铺技术陈述：形态闸命中即登记（诊断可见，不注入）
    for (const paragraph of text.split(/\n+/u)) {
      const clean = paragraph.trim();
      if (clean.length < 8 || coveredParagraphs.has(clean)) continue;
      if (!DECLARATIVE_MEASURE_RE.test(clean) || !DECLARATIVE_NORM_RE.test(clean)) continue;
      uncoveredCount += 1;
      uncoveredSamples.push({ text: clean.slice(0, 120), source });
    }
  }
  // 诊断样本：技术性陈述优先（费用/报价/投标人条款属商务链，排在后面），只留前 20 条
  const samples = [...uncoveredSamples]
    .sort((left, right) => Number(NON_TECHNICAL_COMPLEMENT_RE.test(left.text)) - Number(NON_TECHNICAL_COMPLEMENT_RE.test(right.text)))
    .slice(0, 20);
  return { amendments, unparsedAnswers, uncoveredStatements: { count: uncoveredCount, samples }, sourceCount, pairCount };
}

/** 抽取答疑技术性修正（账本主体；缺口见 extractClarificationAmendmentLedger） */
export function extractClarificationAmendments(input: ExtractClarificationAmendmentsInput): ClarificationAmendment[] {
  return extractClarificationAmendmentLedger(input).amendments;
}

/**
 * 有序全量文本读取（写作侧与检测侧的**同一份**输入）：只有有序全文才能把问句与答句配成对。
 * `readDetail` 传入 `session.understanding.getCachedFileDetail`（同步、幂等、有缓存）。
 */
export function clarificationSourceTexts(
  filePaths: Iterable<string>,
  readDetail: (relativePath: string) => { file?: { relativePath?: string }; chunks?: Array<{ content?: string; sectionTitle?: string }> } | undefined,
): Array<{ text: string; source: string }> {
  const out: Array<{ text: string; source: string }> = [];
  const seen = new Set<string>();
  for (const filePath of filePaths || []) {
    if (!filePath || !isClarificationSource(filePath)) continue;
    const detail = readDetail(filePath);
    if (!detail?.chunks?.length) continue;
    const source = detail.file?.relativePath || filePath;
    if (seen.has(source)) continue;
    seen.add(source);
    const lines: string[] = [];
    for (const chunk of detail.chunks) {
      const title = String(chunk.sectionTitle || '').trim();
      const content = String(chunk.content || '').trim();
      if (title) lines.push(title);
      if (content && content !== title) lines.push(content);
    }
    const text = lines.join('\n').trim();
    if (text) out.push({ text, source });
  }
  return out;
}

/**
 * 对象→章归属（复用清单事实锁单源 assignBillRowChapter）：修正对象与修正后内容作为伪条目参数，
 * 命中章节 token 时归属该章（并给出建议小节）；无命中时由该方法的方法类章兜底给出归属。
 * 归属失败（无章节集）保持空 → 全文适用块，**不丢弃**。
 */
export function assignClarificationAmendmentChapters(
  amendments: readonly ClarificationAmendment[],
  chapters: Array<{ title: string; sections?: string[] }> = [],
): ClarificationAmendment[] {
  if (chapters.length === 0) return [...amendments];
  return amendments.map(amendment => {
    const assignment = assignBillRowChapter({ name: amendment.object, description: `${amendment.object} ${amendment.after}` }, chapters);
    if (!assignment) return amendment;
    return { ...amendment, chapterTitle: assignment.chapterTitle, ...(assignment.section ? { section: assignment.section } : {}) };
  });
}

// ────────────────────────────── 写作注入 ──────────────────────────────

function amendmentConstraintLine(amendment: ClarificationAmendment): string {
  const before = amendment.before[0]?.text;
  if (amendment.kind === 'cancel') {
    return `- ${amendment.object}：${amendment.after}${before ? `——修正前形态「${before}」不得再作为现行做法` : '——不得再作为现行做法'}`;
  }
  if (amendment.kind === 'replace' && before) {
    return `- ${amendment.object}：修正后「${amendment.after}」；修正前「${before}」为被取代形态，不得作为现行做法`;
  }
  return `- ${amendment.object}：${amendment.after}`;
}

const AMENDMENT_BLOCK_TITLE = '【答疑修正（必须按修正后写，不得写修正前）】';

/**
 * 修正硬约束块（写作注入单源）：有章归属的取本章条目，无归属的并入「全文适用」段——
 * 归属失败不得导致修正消失（2-2：不可归属时放进全局写作焦点，不得静默丢弃）。
 */
export function renderClarificationAmendmentBlock(
  amendments: readonly ClarificationAmendment[] | undefined,
  options: { chapterTitle?: string; limit?: number } = {},
): string {
  if (!amendments || amendments.length === 0) return '';
  const limit = options.limit ?? 12;
  const chapterTitle = options.chapterTitle;
  const scoped = chapterTitle ? amendments.filter(item => item.chapterTitle === chapterTitle) : amendments.filter(item => !item.chapterTitle);
  const globalRows = chapterTitle ? amendments.filter(item => !item.chapterTitle) : [];
  if (scoped.length === 0 && globalRows.length === 0) return '';
  const header = `${AMENDMENT_BLOCK_TITLE}以下条目来自答疑/澄清/补疑文件，是**技术性做法的现行唯一口径**：正文（含表格、附图说明、施工方法、质量与验收描述）必须写「修正后」内容；被取代形态仅可在如实陈述变更过程时引用（如「原为X，经答疑修正为Y」）。`;
  const rows = scoped.slice(0, limit).map(amendmentConstraintLine);
  if (scoped.length > limit) rows.push(`- （另有 ${scoped.length - limit} 条本章答疑修正，按同一口径执行，不得写修正前形态）`);
  const sections = [header, ...rows];
  if (globalRows.length > 0) {
    sections.push('（以下修正全文适用，本章亦须遵守）', ...globalRows.slice(0, Math.max(2, limit - 2)).map(amendmentConstraintLine));
  }
  return sections.filter(Boolean).join('\n');
}

// ────────────────────────────── 检索加权（2-5） ──────────────────────────────

/**
 * 中性载体档（sourcePriority 对**无来源指纹**载体返回的默认档）：加权倍数以此为基准，
 * 不写死新常数——倍数随载体优先级单源变化（答疑澄清 96 档 → ×1.37）。
 */
const NEUTRAL_CARRIER_PRIORITY = sourcePriority('未标注来源的资料');

/**
 * 写作检索「变更优先」加权（2-5）：答疑/补疑载体（sourcePriority 96 档）在章证据排序中加权。
 * 诚实边界：加权只能把答疑切片排到**同档证据之前**，无法把主题弱相关的短答从语义零分区救出——
 * 修正内容的落位由本模块的注入通道（renderClarificationAmendmentBlock）负责，
 * 加权只保证答疑原文在被召回时优先进入写作窗口（修正依据可被写手看到）。
 */
export function clarificationEvidenceBoost(filePath: string): number {
  if (!isClarificationSource(filePath)) return 1;
  return sourcePriority(filePath) / NEUTRAL_CARRIER_PRIORITY;
}

// ────────────────────────────── 终检检测（2-3） ──────────────────────────────

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 修正前形态是否作为**现行做法**出现（变更过程陈述语境豁免，与「被取代口径残留」同源判据） */
function residueAsCurrent(form: string, doc: string): boolean {
  const token = normalizeEngineeringTextForFactMatch(form);
  if (token.length < 3) return false;
  for (const match of doc.matchAll(new RegExp(escapeRegExpLiteral(token), 'gu'))) {
    const offset = match.index || 0;
    const context = doc.slice(Math.max(0, offset - 16), offset + token.length + 16);
    if (CHANGE_REFERENCE_CONTEXT_RE.test(context)) continue;
    return true;
  }
  return false;
}

function characterBigrams(text: string): string[] {
  const grams: string[] = [];
  for (let index = 0; index + 1 < text.length; index += 1) grams.push(text.slice(index, index + 2));
  return grams;
}

/**
 * 修正后内容是否落位：归一后逐字包含即落位；否则按字符二元组覆盖率 ≥0.6 且量值 token 命中判定
 * （写作表述与答疑原文不同形是常态，「逐字复现」只对短规格成立）。
 */
function afterLanded(after: string, doc: string): boolean {
  const token = normalizeEngineeringTextForFactMatch(after);
  if (token.length < 4) return true;
  if (doc.includes(token)) return true;
  const grams = characterBigrams(token);
  if (grams.length === 0) return true;
  const coverage = grams.filter(gram => doc.includes(gram)).length / grams.length;
  if (coverage < 0.6) return false;
  const measures = extractEngineeringMeasureTokens(after).map(item => normalizeEngineeringTextForFactMatch(item)).filter(item => item.length >= 2);
  return measures.length === 0 || measures.some(item => doc.includes(item));
}

/** 明确对立：正文句子同时出现修正对象与否定表述 */
const OPPOSITION_RE = /(?:不采用|不设置|不设|不需要|不需|无需|不予|不再|不做|不考虑|不进行|不涉及|取消)/u;

/** 对立判据的匹配核：短对象整体比对（`雨水口连接管`），长对象取最长的实词片段（避免 `隔油池` 这类
 * 短片段在无关句子里触发误报） */
function objectCores(object: string): string[] {
  const clean = object.trim();
  if (clean.length >= 4 && clean.length <= 12) return [clean];
  const parts = clean.split(/[、，,及与和\s（）()]/u).map(part => part.trim()).filter(part => part.length >= 4).sort((left, right) => right.length - left.length);
  if (parts.length > 0) return [parts[0]!];
  return clean.length >= 4 ? [clean] : [];
}

function oppositeStatement(amendment: ClarificationAmendment, doc: string): string | undefined {
  const cores = objectCores(amendment.object);
  if (cores.length === 0) return undefined;
  for (const sentence of doc.split(/[。；;]/u)) {
    if (sentence.length < 6 || !OPPOSITION_RE.test(sentence)) continue;
    if (cores.some(core => sentence.includes(core))) return sentence.slice(0, 60);
  }
  return undefined;
}

/**
 * 答疑技术性修正终检（2-3，与「被取代口径残留」同族）：
 *   ① 修正前形态作为现行做法出现 → 形态强（量值/规格）判 blocker，形态弱判 warning；
 *   ② 正文以否定表述处理修正对象 → blocker（明确对立；独立于落位判据）；
 *   ③ 修正后内容未落位 → warning（不足额）。
 * 账本来自写作侧同一份（session.planning.clarificationAmendments），读写同源；provenance 单源
 * CLARIFICATION_AMENDMENT_DETECTOR_ID，由 issueProvenance 失效机制按 id 剔除旧快照并实时重跑。
 */
export function clarificationAmendmentIssues(
  markdown: string,
  amendments: readonly ClarificationAmendment[] | undefined = [],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!markdown || !amendments || amendments.length === 0) return issues;
  const doc = normalizeEngineeringTextForFactMatch(markdown);
  const fingerprint = stableHash(markdown);
  for (const amendment of amendments) {
    const residues = amendment.before.filter(entry => residueAsCurrent(entry.text, doc));
    if (residues.length > 0) {
      const strong = residues.some(entry => entry.strength === 'strong');
      const forms = residues.map(entry => `「${entry.text}」`).join('、');
      issues.push({
        level: strong ? 'error' : 'warning',
        severity: strong ? 'blocker' : 'warning',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        provenance: { detectorId: CLARIFICATION_AMENDMENT_DETECTOR_ID, fingerprint },
        message: `被取代形态残留：答疑修正后「${amendment.object}」为「${amendment.after}」，正文仍以修正前形态 ${forms} 作为现行做法（修正前形态仅可在陈述变更过程时引用）`,
        suggestion: `请把正文中 ${forms} 改为答疑修正后内容「${amendment.after}」（来源：${amendment.source}）；确需说明变更过程的，写成「原为X，经答疑修正为Y」的形式。`,
      });
    }
    if (amendment.kind === 'cancel') continue;
    const after = amendment.after.trim();
    if (after.length < 2) continue;
    // ③ 明确对立独立于落位判据：正文以否定表述处理修正对象即对立（即使别处已写修正后内容，
    // 同文档两套口径也必须暴露）——二元组覆盖对否定句仍会判「已落位」，故不能挂在落位判据之下
    const opposition = oppositeStatement(amendment, doc);
    if (opposition) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        provenance: { detectorId: CLARIFICATION_AMENDMENT_DETECTOR_ID, fingerprint },
        message: `答疑修正未落实（明确对立）：「${amendment.object}」经答疑修正为「${after}」，正文却以否定表述处理（如「${opposition}」）`,
        suggestion: `请按答疑修正后内容改写该处表述：「${after}」（来源：${amendment.source}）；答疑已明确的做法不得写成不做/不采用。`,
      });
      continue;
    }
    // 落位判据的适用区间：过短无判别力、过长（>60 字断言）二元组覆盖不可靠 → 只保留注入义务
    if (after.length < 6 || after.length > 60) continue;
    if (afterLanded(after, doc)) continue;
    // ② 修正后内容未落位（不足额）：warning——义务已作为写作硬约束下发，此处为终检兜底
    issues.push({
      level: 'warning',
      severity: 'warning',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      provenance: { detectorId: CLARIFICATION_AMENDMENT_DETECTOR_ID, fingerprint },
      message: `答疑修正未落位：「${amendment.object}」经答疑修正为「${after}」，正文未体现该修正后内容（不足额）`,
      suggestion: `请在相关章节补写答疑修正后内容「${after}」（来源：${amendment.source}）；该条已作为写作硬约束下发，此处为终检兜底。`,
    });
  }
  return issues;
}
