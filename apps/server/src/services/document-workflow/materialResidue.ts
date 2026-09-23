/**
 * 资料载体残片判定（单源，4.55.12 巢湖实测）：
 *
 * 「残片」= 资料**载体的原文形态**（答疑对答、图纸 OCR 表格串、纯参数堆砌行），不是可交付正文。
 * 两类消费方共用本判据，避免口径分叉：
 * ① **源头侧**（evidence.cleanEvidenceText）：残片行在进入证据池前剔除 → 写作模型看不到、不会引用；
 * ② **兜底侧**（tenderRequirements.fixFormalSourceResidue）：MISS 掉源头（如链尾补写重新引入）时的
 *    交付前整行删除。
 *
 * **判据形态（勿改宽）**：初版按「整行数字符号占比 ≥0.45」判定，实测把 CAD 标注行
 * （`└── 标注文本: 15.65(基坑底标高) | 关联对象: 邻近标注 坡率 1:1.0 | 状态: 普通标注`）整行删掉——
 * 那正是图纸真实事实（基坑底标高）的载体。故改按**无标点长串**判定：图纸/正文的正常行都有标点与
 * 字段分隔（最长无标点串 ≤ 约 20 字符），OCR 表格串则是数百字符的连续密集串。
 */
import { stripDuplicatedLabelEchoes } from './poolNoise';

/** 无标点长串长度门槛（正常行最长无标点串实测 ≤20；OCR 表格串 40+） */
const RESIDUE_RUN_MIN_LENGTH = 25;
/** 长串内数字+符号占比门槛 */
const RESIDUE_RUN_DENSITY_MIN = 0.45;
/** 长串内汉字占比上限：正文正常串（「其中800×800地砖与600×600地砖按设计划分」）由汉字词承载语义，
 * 占比 ≥0.3；OCR 表格串（「J01B1-1…钢筋表18080型式…」）汉字占比 <0.25。此为防误伤主闸 */
const RESIDUE_RUN_CJK_MAX = 0.3;
/** 标点/分隔符（切开连续串的字符：含字段分隔符｜/、CAD 层级符与括号） */
const RUN_BREAKER_RE = /[，。；：、·|｜,;:（）()【】《》[\]{}<>「」'"“”\s]/gu;

/** 纯参数堆砌行：≥N 个顿号分隔段且 ≥80% 段是裸数值（无成句语义的填充行；
 * 巢湖实测该行是「无主数值审计：疑似编造 JC-07/JC-08/JC-09」的唯一来源） */
const FILLER_MIN_SEGMENTS = 15;
const FILLER_BARE_RATIO = 0.6;
const BARE_VALUE_SEGMENT_RE = /^\s*[\d.]+\s*(?:[A-Za-z%℃²³]+|平方米|立方米|平方|立方|米|天|年|月|日|周|小时|分钟|元|万元|台|套|个|项|批|次|人|份|页|处|座|根|块|组|件|孔|盏|樘|扇|片)*\s*$/u;

export function isMaterialResidueLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s/u.test(trimmed) || /^\|/u.test(trimmed)) return false;
  // ① 答疑对答行（无长度门槛：短答案行同属残片）
  if (/^(?:答|答复|回复|答疑)\s*[:：]/u.test(trimmed)) return true;
  if (trimmed.length < 30) return false;
  // ② OCR 表格串：存在「无标点密集长串」（数字符号占比 ≥0.45）
  for (const run of trimmed.split(RUN_BREAKER_RE)) {
    if (run.length < RESIDUE_RUN_MIN_LENGTH) continue;
    const digits = (run.match(/[0-9]/gu) || []).length;
    const symbols = (run.match(/[+\-*/×@%·．.,≤≥~～$]/gu) || []).length;
    const cjk = (run.match(/[一-龥]/gu) || []).length;
    if (cjk / run.length > RESIDUE_RUN_CJK_MAX) continue;
    if ((digits + symbols) / run.length >= RESIDUE_RUN_DENSITY_MIN) return true;
  }
  // ③ 纯参数堆砌行
  const segments = trimmed.split(/[、，,；;]/u).map(segment => segment.trim()).filter(Boolean);
  if (segments.length >= FILLER_MIN_SEGMENTS) {
    const bare = segments.filter(segment => BARE_VALUE_SEGMENT_RE.test(segment)).length;
    if (bare / segments.length >= FILLER_BARE_RATIO) return true;
  }
  return false;
}

/** 剔除残片行（残片行替换为空行，避免把相邻段落粘成一行；连续空行收敛为一段） */
export function stripMaterialResidueLines(text: string): string {
  if (!text) return text;
  return text
    .split(/\r?\n/u)
    .map(line => (isMaterialResidueLine(line) ? '' : line))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n');
}

/** 句中形态资料残片（4.55.19 实测漏网形态）：
 * 「现澄清为如下：条款号条款号条款名称条款名称编列内容编列内容1.3.2计划工期…」——
 * 以**句子成分**出现（不在独立行），行级判据（isMaterialResidueLine）看不见。
 * 判据：澄清表导语 + 表头字段复写（条款号/条款名称/编列内容任一连续复写 ≥2 次）→ 该小句为
 * 澄清表残片，整句移除（保留其后的正常正文）。 */
const CLARIFICATION_TABLE_DUMP_RE = /(?:现澄清为如下|澄清为如下|澄清如下)[：:][^。；\n]*/gu;

export function stripSentenceLevelResidue(text: string): { text: string; removed: number } {
  if (!text) return { text, removed: 0 };
  let removed = 0;
  let result = text.replace(CLARIFICATION_TABLE_DUMP_RE, () => {
    removed += 1;
    return '';
  });
  // 表头字段复写（条款号条款号…）：单处复写即判残片（正常行文不会连续复写字段名）。
  // 4.55.24 判据单源：与池噪声闸（classifyPoolNoiseText 的 duplicated_label）共用同一形态判定
  const duplicated = stripDuplicatedLabelEchoes(result);
  result = duplicated.text;
  removed += duplicated.removed;
  // 清理空壳标点（「：。」「，。」等）
  result = result.replace(/[：:，,；;]\s*(?=[。；;])/gu, '');
  return { text: result, removed };
}

/**
 * 变更过程叙述清理（4.55.20 用户口径）：正式投标正文**只陈述现行值**，
 * 不得出现「招标澄清文件明确原365日历天现变更修改为330日历天」类**变更过程叙述**——
 * 评标人只看现行口径；旧值出现在正文里即失分点（无论是否加"原/现"修饰）。
 * 判据：含「澄清/答疑/补遗 + 明确/载明/规定」导语或「原X…（现）变更为Y」句式的**小句**整段移除，
 * 保留同句其余内容（现行值由口径约束/链尾替换落地）。幂等。
 */
const CLARIFICATION_NARRATIVE_RE = /[^。；\n]{0,30}(?:澄清|答疑|补遗)(?:文件)?[^。；\n]{0,10}(?:明确|载明|规定|说明)[^。；\n]{0,60}/gu;
const ORIGINAL_TO_NOW_RE = /[^。；\n]{0,20}原[^。；\n]{0,24}?(?:现|变更为|调整为|修改为)[^。；\n]{0,24}/gu;
// 4.55.24 实测漏网形态（巢湖终稿 1 处）：「招标阶段计划工期为365日历天，现澄清变更为330日历天」——
// 上面两条都不命中：CLARIFICATION_NARRATIVE_RE 要求「澄清+明确/载明/规定/说明」，
// ORIGINAL_TO_NOW_RE 要求出现「原」。而该句有「澄清」「变更为」无「原/明确」，故整句留在正文。
// 判据收窄到「带招标/原* 前缀的变更叙述小句」：删该小句、保留同句现行值（幂等）。
const TENDER_STAGE_CHANGE_RE = /[^。；\n，,]{0,20}(?:招标|原招标|原合同|原计划)[^。；\n]{0,20}?(?:现|已|均|将)?(?:澄清|变更|调整|修改|更正)为[^。；\n，,]{0,24}[，,]?/gu;
// 「经/根据 澄清（文件）…调整为…」形态（同上口径，无「招标」前缀亦为变更过程叙述）
const VIA_CLARIFICATION_CHANGE_RE = /(?:经|根据)[^。；\n，,]{0,8}(?:澄清|答疑|补遗)(?:文件)?[^。；\n]{0,16}?(?:调整为|变更为|修改为|更正为)[^。；\n，,]{0,24}[，,]?/gu;

export function stripClarificationNarrative(text: string): { text: string; removed: number } {
  if (!text) return { text, removed: 0 };
  let removed = 0;
  let result = String(text).replace(CLARIFICATION_NARRATIVE_RE, () => { removed += 1; return ''; });
  result = result.replace(ORIGINAL_TO_NOW_RE, (match) => {
    // 只删「原…现/变更…」变更过程叙述；含「原因/原则/原始」等词的正常语句不误伤
    if (/原因|原则|原始|原本|原状|原地|原材料/.test(match)) return match;
    removed += 1;
    return '';
  });
  result = result.replace(TENDER_STAGE_CHANGE_RE, () => { removed += 1; return ''; });
  result = result.replace(VIA_CLARIFICATION_CHANGE_RE, () => { removed += 1; return ''; });
  return { text: result.replace(/[，,；;]\s*(?=[。；])/gu, ''), removed };
}

/**
 * 指向型表述确定性清除（4.55.25 用户实测；4.55.36 §L3-8/9/10 判据修正）。
 *
 * **用户口径**：这是技术标，不是写着玩的——「具体做法参见《钢筋混凝土及砖砌排水检查井》20S515/29」
 * 这类**指向替代**在交付物里**不能出现**：评标人拿不到做法，等同没写。
 * 4.55.24 只加了写作前红线与检测器（报 blocker），但**模型无视红线时正文照旧带病交付**——
 * 只报不删等于没修。本函数是链尾确定性兜底（与材料残片/澄清叙述同链、同单源判据）。
 *
 * **处置（小句级，不误伤句子其余内容）**：按标点切成小句，**只删指向型小句**；
 * 若整句删空则连句读一起收敛。指向处应写的具体做法由写作侧按绑定参数写出——
 * 缺失的内容由「内容深度/事实密度」类检测器在正确的位置报告，而不是靠留一句指向搪塞。
 *
 * **4.55.36 判据修正（§L3-8/9/10，全部来自实测漏网与存量误伤）**：
 * - §L3-8 **ASCII 尖括号等价**：`做法详见<混凝土排水管道基础及接口>23S5166/21页`（巢湖实测形态）
 *   的 `<…>` 与中文书名号 `《…》` 同为「标题记号」，两种包裹形态一并判；
 * - §L3-9 **逗号容忍**：指向短语内部可出现一个逗号（「做法，详见《…》」「详见《…》，20S515/29」）——
 *   小句级切分在逗号处断开，判据看不见跨逗号的指向短语，故增加**句级先行扫描**变体；
 * - §L3-10 **规范引用豁免（存量误伤根修）**：书名号内为**规范/法规名**（以 法/条例/办法/规定/规则/
 *   决定/细则/标准/规范/规程/导则/准则/通则/技术要求 等命名惯例收尾或含之），或标题后**紧跟标准代号**
 *   （GB/JGJ/CJJ… 的「字母前缀＋数字」形态，与图集号「数字＋字母＋数字」形态互补）时**不删**——
 *   历史事故：`按《绿色建筑评价标准》（GB/T 50378-2019）执行` 整句被删致**正文数据丢失**，
 *   只能靠链尾回插（basisRegulationsCrossRepair.replayTailStrippedBasisCitations）补救。
 *
 * 判据机制化：豁免用的是命名惯例与代号形态，不含任何具体标准名/项目数值白名单。
 */

/** 指向型标题记号（书名号与 ASCII 尖括号等价，§L3-8） */
const POINTER_TITLE_SOURCE = '(?:《[^》]{2,40}》|<[^<>]{2,40}>)';

/** §L3-10 规范/法规名命名惯例（法规：法/条例/办法/规定/规则/决定/细则；标准：标准/规范/规程/
 *  导则/准则/通则/技术要求/技术条件）——标题内含上述词即判「规范引用」不删 */
const REGULATION_TITLE_INNER_RE = /(?:法|条例|办法|规定|规则|决定|细则|标准|规范|规程|导则|准则|通则|技术要求|技术条件)$|(?:标准|规范|规程|导则|条例|办法|规定|技术要求)/u;

/** §L3-10 标准代号形态：字母前缀＋数字（GB 50204-2015／JGJ 18-2012／DB34/T 4289-2022／GB/T 50378-2019），
 *  可带括号包裹。与图集号形态（数字＋字母＋数字：20S515／12J201／23S5166）互补——
 *  这是「规范引用」与「图集指向」的机制化区分（前者不删，后者删）。 */
const STANDARD_CODE_AFTER_TITLE_RE = /^\s*(?:[（(][^）)]{0,24}[）)]\s*)?[A-Z]{2,6}(?:\s*\/\s*[A-Z]{1,6})?\s*\d/u;

/** §L3-9 句级逗号容忍窗口：允许至多一个逗号，且不跨句界 */
const COMMA_WINDOW = '(?:[^，,、；;。！？\\n]{0,6}[，,])?[^，,、；;。！？\\n]{0,8}';

/** 指向型小句定位正则（只负责定位；§L3-10 豁免由 isProtectedTitleReference 裁决）：
 * 每条的**第一个捕获组**为标题记号（无捕获组的形态无豁免，按原口径判）。 */
const POINTER_TITLE_CLAUSE_SOURCES: readonly string[] = [
  // 图集/标准图引用替代做法：「参见《钢筋混凝土及砖砌排水检查井》20S515/29」
  // 「具体详见<混凝土排水管道基础及接口>23S516」（含 ASCII 尖括号与图集页码，§L3-8）
  `(?:具体)?(?:做法|详见|参见|见|按|依据|参照)[^，,、；;\\n]{0,12}?(${POINTER_TITLE_SOURCE})[^，,、；;\\n]{0,12}`,
  // 裸图集号引用（标题记号可有可无）：「按皖2015S209/93~相关专业图纸」
  `(?:参见|详见|参照|按|依照)[^，,、；;\\n]{0,6}?(?:(${POINTER_TITLE_SOURCE}))?[^，,、；;\\n]{0,6}?(?:[皖烷京沪苏浙粤鲁豫鄂湘川渝陕冀晋蒙辽吉黑闽赣桂黔滇甘青宁新藏]\\s?\\d{4}|\\d{2})\\s?[A-Z]{1,2}\\s?\\d{2,4}(?:[/／]\\d{1,3})?[^，,、；;\\n]{0,10}`,
];

const POINTER_CLAUSE_PATTERNS: RegExp[] = [
  ...POINTER_TITLE_CLAUSE_SOURCES.map(source => new RegExp(source, 'u')),
  // 大样图/详图指向
  /(?:详见|参见|见)[^，,、；;\n]{0,16}?(?:大样图|详图|节点图|工艺图|做法表)/u,
  // 按设计图纸/按图纸/以图纸为准
  /按(?:设计)?(?:施工)?图纸(?:控制|计量|要求|施工|确定|执行|进行|处理|设置|选用|计算|调整)?/u,
  /以(?:设计)?图纸为准/u,
  // 缺资料搪塞
  /(?:资料|图纸|清单|设计文件)(?:中)?未(?:提供|明确|给出|注明)[^，,、；;\n]{0,12}(?:参数|数据|做法|要求|规格)?/u,
  /(?:具体(?:参数|做法|数值))?待(?:补充|确认|核实|明确)/u,
];

/** §L3-9 句级逗号容忍变体（在小句切分之前扫描）：窗口内允许一个逗号 */
const POINTER_SENTENCE_PATTERNS: RegExp[] = [
  new RegExp(`(?:具体)?(?:做法|详见|参见|见|按|依据|参照)${COMMA_WINDOW}?(${POINTER_TITLE_SOURCE})(?:[^，,、；;。！？\\n]{0,6}[，,])?[^，,、；;。！？\\n]{0,8}`, 'u'),
];

function pointerTitleInner(token: string): string {
  return token.slice(1, -1);
}

/** §L3-10 规范引用豁免：标题为规范/法规名，或标题后紧跟标准代号 → 正当规范引用，不得删 */
function isProtectedTitleReference(token: string, tail: string): boolean {
  if (REGULATION_TITLE_INNER_RE.test(pointerTitleInner(token))) return true;
  return STANDARD_CODE_AFTER_TITLE_RE.test(tail);
}

/** 小句是否为指向型（含 §L3-10 豁免裁决）：任一非豁免命中即判指向型小句 */
function isPointerClause(clause: string): boolean {
  for (const source of POINTER_TITLE_CLAUSE_SOURCES) {
    for (const match of clause.matchAll(new RegExp(source, 'gu'))) {
      const title = match[1];
      if (title === undefined) return true;
      const tail = match[0].slice(match[0].lastIndexOf(title) + title.length);
      if (!isProtectedTitleReference(title, tail)) return true;
    }
  }
  return POINTER_CLAUSE_PATTERNS.slice(POINTER_TITLE_CLAUSE_SOURCES.length).some(pattern => new RegExp(pattern.source, 'u').test(clause));
}

/** §L3-9 句级命中（返回命中跨度样本 + 去命中文本），与 stripDrawingPointerPhrases 同源同判据 */
function stripSentenceLevelPointers(sentence: string): { text: string; hits: string[] } {
  let result = sentence;
  const hits: string[] = [];
  for (const pattern of POINTER_SENTENCE_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, 'gu'), (match: string, title?: string) => {
      if (title !== undefined) {
        const tail = match.slice(match.lastIndexOf(title) + title.length);
        if (isProtectedTitleReference(title, tail)) return match;
      }
      hits.push(match.trim());
      return '';
    });
  }
  return { text: result, hits };
}

interface PointerStripResult {
  text: string;
  /** 被删的指向型小句样本（与 text 严格同源：hits 非空 ⇔ text 有删减） */
  hits: string[];
}

/** 指向型小句扫描/清除单一实现（检测端 drawingPointerPhraseHits 与清洗端 stripDrawingPointerPhrases 共用） */
function scanPointerClauses(text: string): PointerStripResult {
  if (!text) return { text, hits: [] };
  const hits: string[] = [];
  const keptSentences: string[] = [];
  for (const sentence of String(text).split(/(?<=[。；])/u)) {
    if (!sentence.trim()) { keptSentences.push(sentence); continue; }
    // §L3-9 句级逗号容忍先行（小句切分前；命中跨度整段移除）
    const sentenceLevel = stripSentenceLevelPointers(sentence);
    hits.push(...sentenceLevel.hits);
    // 保留分隔符切分（小句级裁剪：只删指向型小句，句子其余内容原样保留）
    const pieces = sentenceLevel.text.split(/([，,、；;])/u);
    const kept: string[] = [];
    let clauseRemoved = 0;
    for (let index = 0; index < pieces.length; index += 2) {
      const clause = pieces[index] ?? '';
      if (clause.trim() && isPointerClause(clause)) { hits.push(clause.trim().slice(0, 60)); clauseRemoved += 1; continue; }
      kept.push(clause);
      const delimiter = pieces[index + 1];
      if (delimiter && index + 2 < pieces.length) kept.push(delimiter);
    }
    // 只剥**小句级分隔符**（逗号/顿号）；句末分号属句子边界，不得剥（否则「…；下一句」会被并成一句）
    const rebuilt = kept.join('').replace(/^[，,、]+/u, '').replace(/[，,、]+$/u, '');
    // 整句被删空（句内只剩指向）→ 连句读一起收敛
    if (!rebuilt.replace(/[。；;\s]/gu, '')) {
      if (clauseRemoved === 0 && sentenceLevel.hits.length === 0) hits.push(sentence.trim().slice(0, 60));
      continue;
    }
    // 不补句读：表格行/标题行/列表行本就不以句读结尾，补「。」会破坏 Markdown 结构
    //（句子的原有句读在拼接中已保留：句边界字符不是小句分隔符）
    keptSentences.push(rebuilt);
  }
  const result = keptSentences.join('')
    .replace(/[，,、；;]{2,}/gu, '，')
    .replace(/[，,、；;]\s*(?=[。；])/gu, '')
    .replace(/\n{3,}/gu, '\n\n');
  return { text: result, hits };
}

export function stripDrawingPointerPhrases(text: string): { text: string; removed: number } {
  const result = scanPointerClauses(text);
  return { text: result.text, removed: result.hits.length };
}

/**
 * 指向型表述命中扫描（检测端，与 stripDrawingPointerPhrases **同一实现**：
 * 检测定位=修复定位，检测报出的每一处都是清洗器会删的那一处——两套判据不允许存在）。
 * 返回命中样本（空数组=无命中）。
 */
export function drawingPointerPhraseHits(text: string): string[] {
  return scanPointerClauses(text).hits;
}
