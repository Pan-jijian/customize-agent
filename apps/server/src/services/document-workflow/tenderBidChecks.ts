import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';
import { MEASURE_UNIT_SOURCE } from './unitAliases';
import { buildSemanticGate } from './semanticGate';

/**
 * 招标技术标确定性检查层（对标《施工组织设计全维度校验提示词（修订完整版）》判定标尺）。
 *
 * 设计原则：判定标尺全部代码化（可测试、可复现），语义级匹配（术语等效/重难点归因质量）
 * 由 embedding 与 LLM 审查层承接，本文件只做确定性检测。
 *
 * 与 tenderBidScoring.ts 的分工：本文件输出"检测事实"（命中数、占比、等级），
 * 评分器消费这些事实映射到五维分数与模板化等级。
 */

// ── 1. 模糊应答词（附录一第 3 类 + 无效应答反向词，实质性响应章节零出现） ──
export const VAGUE_RESPONSE_PHRASES = [
  '基本满足', '大致符合', '力争', '原则上', '大概', '左右', '尽可能', '尽量满足',
] as const;

/** 模糊应答词面召回（词根级，仅召回不判定）：「基本能够满足」「大致可以符合」「力争上游」「左右对称」
 * 等变体均召回，语义 gate 复核后才计扣分——词面短语级判定会漏掉变体、误杀「力争上游/左右对称」合法句 */
const VAGUE_RESPONSE_LEXICAL_HINTS_RE = /基本|大致|力争|原则上|大概|左右|尽可能|尽量/u;

/** 模糊应答语义原型（正例）：应答性模糊承诺表述基准（补词面变体漏网，如「基本能够满足」「完全符合要求」语境依赖型） */
const VAGUE_RESPONSE_SEMANTIC_PROTOTYPES = [
  '基本满足招标文件要求',
  '大致符合相关规范标准',
  '力争达到优良质量标准',
  '原则上按照规范执行',
  '尽可能保证工程质量',
  '尽量满足工期要求',
] as const;

/** 模糊应答合法语境原型（负例保护）：含模糊词但语义属具体描述/正面表述，不得计扣分（力争上游/左右对称） */
const VAGUE_LEGAL_CONTEXT_PROTOTYPES = [
  '结构构件左右对称布置',
  '平面布置左右对称合理',
  '力争上游的企业精神',
] as const;

/** 构建模糊应答语义 gate：词面召回 + 语义复核（semanticGate 统一入口，禁止自行实现嵌入逻辑） */
export async function buildVagueResponseGate(embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<(texts: string[]) => Promise<boolean[]>> {
  return buildSemanticGate({
    prototypes: [...VAGUE_RESPONSE_SEMANTIC_PROTOTYPES],
    negativePrototypes: [...VAGUE_LEGAL_CONTEXT_PROTOTYPES],
    lexicalHints: VAGUE_RESPONSE_LEXICAL_HINTS_RE,
    embedDocuments,
  });
}

/** 模糊应答词命中明细（含出现次数），供评分报告定位（词面口径，评分扣分走语义复核口径） */
export function vagueResponseHits(markdown: string) {
  return VAGUE_RESPONSE_PHRASES.filter(phrase => markdown.includes(phrase))
    .map(phrase => ({ phrase, count: markdown.split(phrase).length - 1 }));
}

// ── 1b. 空话禁用短语（词面召回 + 语义复核口径，C8-U）──
/** 负面词库（短语级）：《施组设计汇总方案.md》第十一节 + 用户“青天大模型 AI 评标”提示词第十二节禁用词合并，
 * 生成侧提示词与链尾低雷同性评分共用。单字虚词（合理/充分/完善/切实/尽量/适时/加强/及时等）
 * 只进生成侧提示词，不纳入确定性评分扣分，避免“及时整改”等正常表述被误伤。
 * C8-U（s28m' 实锤）：短语纯词面命中是误伤源——规范引用句（“工程质量标准必须符合现行国家有关工程
 * 施工质量验收规范和标准的要求并精心组织施工”）与有量化信息的措施句中的短语命中全部被误计扣分
 * （5 处 3 种 -12 分）；评分扣分口径改为词面召回 + 语义复核——短语须出现在被判套话/filler 的句池
 * 句内才计入种类（见 fillerDensityReport.forbiddenEmptyPhraseHits，评分端禁止回退词面双轨）。 */
export const FORBIDDEN_EMPTY_PHRASES = [
  '精心组织', '科学统筹', '科学管理', '精益求精', '全力保障', '高效推进',
  '力争优质', '力争一流', '一流水平', '完善体系', '最大限度', '显著提升',
  '大力落实', '严格把控', '充分确保', '竭力打造', '现代化管理', '加强管理',
  '提高意识', '强化监督', '持续完善', '及时处理', '全方位',
  '常态化', '提质增效', '高标准', '统筹推进',
];

/** 生成侧禁写词库（用户提示词第十二节禁用词全量）：FORBIDDEN_EMPTY_PHRASES 基础上
 * 保留“定期检查/系统性”等语境敏感词——评分不扣分（避免误伤正常表述），但提示词层面继续禁写。 */
export const FORBIDDEN_PROMPT_PHRASES = [...FORBIDDEN_EMPTY_PHRASES, '定期检查', '系统性'];

// ── 2. 模板化套话检测：套话语义原型 + 套话密度三档（bge 余弦判定，无词表） ──
/** 套话语义原型（跨项目可替换、无本项目专属参数的空泛表述基准）：14 条族式原型覆盖高频口号变体。
 * 校准（离线实测，bge-small-zh-v1.5）：合成真口号句最高余弦 0.852~0.998、三版真实成稿内容最高 0.769，
 * 配合 FILLER_SENTENCE_THRESHOLD=0.80 实现零误报分离（扩库前 5 原型 + 0.6 阈值口径下
 * 任何合规成稿约 28% 管理/质量过程句落入原型语义空间，是“套话占比恒 ~27.8%”伪象的根因）。 */
export const FILLER_SEMANTIC_QUERIES = [
  '精心组织、科学管理，确保工程质量',
  '严格执行相关规范和设计要求',
  '根据实际情况适当调整施工安排',
  '建立健全管理体系，加强过程管理',
  '全力保障项目顺利推进',
  '加强管理、严格控制，确保工程质量达到优良标准',
  '精心策划、周密部署，全力以赴完成任务目标',
  '高度重视、狠抓落实，层层压实责任',
  '统筹兼顾、合理安排，确保各项工作有序推进',
  '严格管理、严格要求，确保一次成优',
  '认真贯彻落实各项管理制度，不断提升管理水平',
  '加强安全管理，杜绝各类安全事故发生',
  '合理安排施工工序，确保工程按期完工',
  '坚持质量第一、安全至上，认真做好各项工作',
] as const;

/**
 * 套话句判定阈值（0.80，离线校准值）：0.6 为「语义承接」判定阈值（条目标题↔大纲），
 * 复用它判套话会把普通管理过程句误计为套话（恒 ~28% 占比伪象根因）；0.80 在合成口号（≥0.852）
 * 与真实内容（≤0.769）之间完美分离（±0.03 裕度）。
 */
export const FILLER_SENTENCE_THRESHOLD = 0.8;

/** 目录条目行（“第六章 确保工程质量的技术组织措施”式）不入句池：目录是标题文本而非正文句，
 * 校准中曾以 0.73 成为最高分伪命中（且目录行短、无句读切分点，整行入池放大占比基数） */
const FILLER_TOC_LINE_RE = /^\s*(?:第[一二三四五六七八九十百\d]+[章节篇]|\d+(?:\.\d+){0,3})\s+[^。；;，,]*$/u;

/** 句池排除行判定（检测端与修复锚点端同源口径）：空行/标题/表格/列表/引用/目录条目行不进句池 */
export function isFillerPoolExcludedLine(line: string): boolean {
  // 零宽字符剥离后再判（r28f 实测标题行穿插 U+200B 类字符致 `^\s*#` 失配，
  // 章标题行「## 第六章 …」直入句池被判模板化空话——#53 根因；检测/修复/生成期三端同源受益）
  const trimmed = line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim();
  if (!trimmed) return true;
  if (/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(trimmed)) return true;
  return FILLER_TOC_LINE_RE.test(trimmed);
}

/** 共享句池构建：过滤非正文行后按。；; 切句，仅保留 ≥12 字正文句（检测/修复锚点/生成期质检三端同源） */
export function buildFillerSentencePool(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter(line => !isFillerPoolExcludedLine(line))
    .flatMap(line => line.split(/[。；;]/u))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 12);
}

/** 句级套话判定结果：semantic=套话语义原型命中（可进入确定性删除判定）；vague=模糊应答语义复核命中（交 LLM 具体化） */
export interface FillerSentenceJudgement {
  sentence: string;
  semantic: boolean;
  vague: boolean;
  filler: boolean;
  /** 与套话语义原型的最高余弦（观测与校准用） */
  similarity: number;
}

/**
 * 共享句级套话判定器（检测端 fillerDensityReport / 修复锚点端 fillerSentenceTargets /
 * 生成期 block-qc 扫描同源）：套话语义原型最高余弦 ≥ FILLER_SENTENCE_THRESHOLD，
 * 或模糊应答语义 gate 复核命中，即判套话句。
 */
export async function judgeFillerSentences(
  sentences: string[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<FillerSentenceJudgement[]> {
  if (sentences.length === 0) return [];
  const fillerSimilarity = await buildSemanticSimilarity(sentences, [...FILLER_SEMANTIC_QUERIES], embedDocuments);
  const vagueGate = await buildVagueResponseGate(embedDocuments);
  const vagueFlags = await vagueGate(sentences);
  return sentences.map((sentence, index) => {
    const similarity = Math.max(...FILLER_SEMANTIC_QUERIES.map(query => fillerSimilarity(sentence, query)));
    const semantic = similarity >= FILLER_SENTENCE_THRESHOLD;
    const vague = vagueFlags[index];
    return { sentence, semantic, vague, filler: semantic || vague, similarity };
  });
}

/**
 * 零信息口号句判定（确定性删除安全前置）：通过语义套话门且无任何数字/岗位/频次/合规锚点的
 * 短句（≤60 字）方为零信息纯口号——删除零信息句是无损净化（不损失可核查信息）；
 * 携带任何信息（数字/岗位/频次/合规承诺）的命中句一律保留，交 LLM 具体化重写（防误删承诺实质）。
 */
export function isZeroInfoSloganSentence(sentence: string): boolean {
  const compact = sentence.replace(/\s+/gu, '');
  if (compact.length === 0 || compact.length > 60) return false;
  if (/[0-9０-９]/u.test(compact)) return false;
  if (/项目经理|技术负责人|施工员|质检员|专职安全员|安全员|材料员|资料员|监理|班组|责任人|岗位/u.test(compact)) return false;
  if (/每日|每周|每月|每季|每年|每\d+|定期|不定期|不少于|不低于|至少/u.test(compact)) return false;
  if (/合同|约定|承诺|保证金|履约|招标|投标|中标|资质|奖项|证书|备案|报审|报验|审批|签证|变更/u.test(compact)) return false;
  return true;
}

// ── 2b. 模板化前缀句（元话语导语，D-T7 ①）──
/** 句首前缀剥离：标题符号/小节编号/条目编号/列表符（判定前先去前缀再测导语词首） */
export const TEMPLATE_PREFIX_STRIP_RE = /^(?:#{1,6}\s*)?(?:(?:\d+(?:\.\d+)*)(?:[.、)）]|\s)+|（\d+）|[（(][一二三四五六七八九十]+[）)]|[-*•]\s+)?\s*/u;

/** 模板化前缀句句首词表（确定性）：句子主语为文档自身（「本节/本章将…」）或叙述方位
 * （「以下从/综上所述」）即命中——元话语导语不含工程信息，是模板化前缀的等价形态。
 * 与 formalStyleIssues（终检检测）同源引用：4.28 前语义原型 0.6 阈值口径下施工描述句
 * 被 bge 噪声误判为前缀套话（r28f 实测命中样本 3/3 全误报：小节标题残片与砌筑/铺贴工艺句），
 * 现改为词面前置确定性判定＋修复侧确定性删除（检测定位＝修复定位）。 */
export const TEMPLATE_PREFIX_HEAD_RE = /^(?:(?:本节|本章|本小节|本部分|本(?:文|篇章))(?:将|拟|主要|重点|首先|从|围绕|按|结合|针对|以|通过|对|就|分|共|内容|的|内)|(?:以下|下述|下面)(?:从|将|为|是|内容|主要|就|围绕|介绍|说明)|综上所述|通过以上|由此可见|总的来说|总体而言)/u;

/** 模板化前缀句判定（检测端与修复锚点端同源单入口）：先剥零宽字符（r28f 实测正文穿插
 * U+200B 类字符致行首过滤失配）与条目编号，再测词首——不命中词表的句子零判定成本放行。 */
export function isTemplatePrefixSentence(sentence: string): boolean {
  const compact = sentence.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim();
  if (!compact) return false;
  return TEMPLATE_PREFIX_HEAD_RE.test(compact.replace(TEMPLATE_PREFIX_STRIP_RE, ''));
}

/** 模板化前缀句全文扫描（markdown 级句池单源）：零宽剥离 → 排除行过滤（isFillerPoolExcludedLine，
 * 含目录条目行）→ 按。；; 切句 → ≥12 字 → 词首判定。检测端 formalStyleIssues 与修复回滚复检
 * （repairTemplatingIssues recheck）共用；修复锚点端 templatePrefixTargets 逐章同口径（额外带定位）。 */
export function scanTemplatePrefixSentences(markdown: string): string[] {
  return markdown
    .split('\n')
    .map(line => line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim())
    .filter(line => line && !isFillerPoolExcludedLine(line))
    .flatMap(line => line.split(/[。；;]/u))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 12 && isTemplatePrefixSentence(sentence));
}

export type TemplatingLevel = 'heavy' | 'medium' | 'light';

export interface FillerDensityReport {
  /** 核心段落总句数（≥12 字正文句） */
  totalSentences: number;
  /** 套话句数（套话语义原型命中句 + 模糊应答语义复核命中句） */
  fillerSentences: number;
  /** 套话占比 */
  ratio: number;
  /** 模板化等级：≥40% 重度 / 20%-40% 中度 / <20% 轻度（docx L23 阈值） */
  level: TemplatingLevel;
  /** 模糊应答词面召回候选句数（词面命中仅召回，不直接计扣分） */
  vagueCandidateSentences: number;
  /** 模糊应答语义确认句数（语义 gate 复核命中，评分扣分口径） */
  vagueSemanticSentences: number;
  /** 空话禁用短语命中种类数（C8-U 词面召回 + 语义复核口径：短语须出现在被判套话/filler 的句池
   * 句内才计入）；低雷同性评分按种类 ×4 扣分的事实源——纯词面命中（规范引用/有信息措施语境）不扣分 */
  forbiddenEmptyPhraseHits: number;
  /** 套话句原文明细（去重，限 40 条）：模板化修复闭环的锚点源与生成后诊断样本 */
  fillerSentenceDetails: string[];
}

/** 套话密度统计：核心章节（全文口径，评分器可传核心段落子集）套话句占比。
 * 模糊应答词面命中仅召回（「力争上游」「左右对称」等合法句不得误计）；套话语义原型判定走
 * FILLER_SENTENCE_THRESHOLD（0.80 校准值），句池与修复锚点/生成期质检共享（含目录行过滤）。
 * C8-U：空话禁用短语同口径（forbiddenEmptyPhraseHits——词面召回 + 命中句被判 filler 才计入种类），
 * 低雷同性评分消费本字段，禁止评分端保留词面 includes 双轨。 */
export async function fillerDensityReport(
  markdown: string,
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<FillerDensityReport> {
  const sentences = buildFillerSentencePool(markdown);
  const judgements = await judgeFillerSentences(sentences, embedDocuments);
  const vagueCandidateSentences = sentences.filter(sentence => VAGUE_RESPONSE_LEXICAL_HINTS_RE.test(sentence)).length;
  const vagueSemanticSentences = judgements.filter(item => item.vague).length;
  const fillerSentenceFlags = judgements.map(item => item.filler);
  const fillerSentences = fillerSentenceFlags.filter(Boolean).length;
  // 套话句原文明细：按首次出现顺序去重，限 40 条——模板化修复闭环用其做锚点/诊断样本
  const fillerSentenceDetails = [...new Set(sentences.filter((_, index) => fillerSentenceFlags[index]))].slice(0, 40);
  // C8-U：空话短语扣分口径 = 词面召回 + 语义复核（检测事实，评分端单源消费）——短语须出现在被判
  // filler 的句池句内才计入种类；标题/表格/短句不入句池即不参与（与 C0-1 内容级判定同哲学）。
  // s28m' 实测：词面 5 处 3 种全部处于规范引用/有信息措施语境，语义复核零确认（-12 分误伤归零）。
  const confirmedForbiddenPhrases = new Set<string>();
  sentences.forEach((sentence, index) => {
    if (!fillerSentenceFlags[index]) return;
    for (const phrase of FORBIDDEN_EMPTY_PHRASES) {
      if (sentence.includes(phrase)) confirmedForbiddenPhrases.add(phrase);
    }
  });
  const forbiddenEmptyPhraseHits = confirmedForbiddenPhrases.size;
  const ratio = sentences.length ? fillerSentences / sentences.length : 0;
  const level: TemplatingLevel = ratio >= 0.4 ? 'heavy' : ratio >= 0.2 ? 'medium' : 'light';
  return { totalSentences: sentences.length, fillerSentences, ratio, level, vagueCandidateSentences, vagueSemanticSentences, forbiddenEmptyPhraseHits, fillerSentenceDetails };
}

// ── 3. 措施五要素闭合（方案＋流程＋责任人＋时间节点＋验收标准，bge 语义判定，缺 2 项以上判不完整） ──
/** 五要素语义原型（各要素的典型表述基准，bge 余弦 ≥ 阈值判定要素存在） */
export const FIVE_ELEMENT_SEMANTIC_QUERIES = {
  plan: '制定专项施工方案与管理制度，明确技术措施',
  process: '施工工序流程与工艺步骤顺序',
  role: '由项目经理、技术负责人等岗位人员分工负责',
  frequency: '每日、每周等检查频次与时间节点安排',
  // 4.60 I2-c：语义原型去「整改销项」词面——原原型字面即含该尾词，等于把套话写进判定基准
  acceptance: '经检查验收合格后处置闭环并留存检测与验收记录',
} as const;

/** 五要素词面封闭表（L2 确定性判定单源）：plan/process 为方案类/工序类正式表述，
 * role/frequency/acceptance 为岗位/频次/闭环封闭词。评分（本文件 fiveElementBlockStats）
 * 与链尾补强（fiveElementClosureBoost）同源引用，禁止双口径漂移。 */
export const FIVE_ELEMENT_WORD_RES = {
  plan: /专项施工方案|专项方案|施工方案|施工组织设计|技术措施|管理制度|技术交底|作业指导书|操作规程/u,
  process: /施工工序|工艺流程|施工流程|作业流程|施工顺序|施工步骤|工艺步骤|流水段|流水作业|依次施工|工序/u,
  role: /项目经理|技术负责人|施工员|质检员|安全员|材料员|资料员|测量员|劳资员|班组长|监理工程师|试验员/u,
  frequency: /每日|每天|每周|每月|每季度|每批|不少于\s*\d+\s*次|至少\s*\d+\s*次|每周\s*\d+\s*次|每日\s*\d+\s*次|每\s*\d+\s*日/u,
  // 4.60 I2-c **放宽为实质验收语义**（用户实测断源的对侧）：原表只有 整改|复查|销项|复验|闭环|返工
  // 六个词，是「闭环」的唯一词面出口——而唯一出口又与密度配额叠加，模型只能靠反复写这六个字得分。
  // 放宽后「写实质」（检验批验收、实测实量、送检复测、旁站见证、资料归档）与「得分」不再冲突，
  // 删除套话不再导致可落地性掉分。
  acceptance: /验收|检验批|实测实量|复测|送检|抽检|检测|试验|旁站|见证取样|报验|隐蔽|整改|复查|销项|复验|闭环|闭合|返工|返修|核验|复核|评定|归档|台账/u,
} as const;

export interface FiveElementBlockStats {
  blocks: number;
  /** 五要素至少 4 项齐全的块数（方案/流程/责任人/时间节点/验收标准） */
  completeBlocks: number;
  /** 缺责任人或缺时间节点的块数（docx L93：缺这两要素判措施不完整） */
  incompleteBlocks: number;
  /** 闭环三要素齐全块数（责任人＋检查频次＋整改闭环，供可落地性闭环密度检测复用同一批嵌入） */
  closedLoopBlocks: number;
}

/** 措施五要素闭合统计：按空行分块（≥30 字），五要素 bge 命中 ≥4 项为闭合块 */
export async function fiveElementBlockStats(
  markdown: string,
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<FiveElementBlockStats> {
  const blocks = markdown.split(/\n{2,}/u).filter(block => block.trim().length >= 30);
  const elementQueries = Object.values(FIVE_ELEMENT_SEMANTIC_QUERIES);
  const elementSimilarity = await buildSemanticSimilarity(blocks, elementQueries, embedDocuments);
  const hasElement = (block: string, query: string) =>
    elementSimilarity(block, query) >= SEMANTIC_COVERAGE_THRESHOLD;
  // L2 确定性三要素词面前置判定（bge 语义判定前）：岗位/频次/闭环三类词面属封闭词表，
  // 词面命中即可确定要素存在（bge 对长块嵌入式判定在块粒度放大时漏判——合肥师范实测
  // 17 块 0 闭环、可落地性 0 分误报：块内「项目经理每周组织…质检员复查销项」词面三要素齐全）。
  // 词表已提升为模块级 FIVE_ELEMENT_WORD_RES（链尾补强同源引用）。
  const ROLE_WORD_RE = FIVE_ELEMENT_WORD_RES.role;
  const FREQUENCY_WORD_RE = FIVE_ELEMENT_WORD_RES.frequency;
  const CLOSURE_WORD_RE = FIVE_ELEMENT_WORD_RES.acceptance;
  // B6 方案/工序两要素同样加词面前置（丰乐镇第五轮实测）：正文词面五要素齐全块 30 处
  // 被 bge 长块嵌入仅判出约 2 处，可落地性 6 分误报；plan/process 词表取封闭性强的
  // 正式表述（方案类文件名词/工序链词），命中即确定要素存在，与三要素口径同源。
  const PLAN_WORD_RE = FIVE_ELEMENT_WORD_RES.plan;
  const PROCESS_WORD_RE = FIVE_ELEMENT_WORD_RES.process;
  const hasDeterministicElement = (block: string, query: string): boolean | undefined => {
    if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.plan && !PLAN_WORD_RE.test(block)) return false;
    if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.plan && PLAN_WORD_RE.test(block)) return true;
    if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.process && !PROCESS_WORD_RE.test(block)) return false;
    if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.process && PROCESS_WORD_RE.test(block)) return true;
    if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.role && !ROLE_WORD_RE.test(block)) return false;
    if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.role && ROLE_WORD_RE.test(block)) return true;
    if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.frequency && !FREQUENCY_WORD_RE.test(block)) return false;
    if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.frequency && FREQUENCY_WORD_RE.test(block)) return true;
    if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.acceptance && !CLOSURE_WORD_RE.test(block)) return false;
    if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.acceptance && CLOSURE_WORD_RE.test(block)) return true;
    return undefined;
  };
  const judgeElement = (block: string, query: string) => {
    const deterministic = hasDeterministicElement(block, query);
    return deterministic !== undefined ? deterministic : hasElement(block, query);
  };
  let completeBlocks = 0;
  let incompleteBlocks = 0;
  let closedLoopBlocks = 0;
  for (const block of blocks) {
    const hits = elementQueries.filter(query => judgeElement(block, query)).length;
    if (hits >= 4) completeBlocks += 1;
    else if (!judgeElement(block, FIVE_ELEMENT_SEMANTIC_QUERIES.role) || !judgeElement(block, FIVE_ELEMENT_SEMANTIC_QUERIES.frequency)) incompleteBlocks += 1;
    if (judgeElement(block, FIVE_ELEMENT_SEMANTIC_QUERIES.role)
      && judgeElement(block, FIVE_ELEMENT_SEMANTIC_QUERIES.frequency)
      && judgeElement(block, FIVE_ELEMENT_SEMANTIC_QUERIES.acceptance)) closedLoopBlocks += 1;
  }
  return { blocks: blocks.length, completeBlocks, incompleteBlocks, closedLoopBlocks };
}

// ── 4. 重难点对策模板化专项检测（归因 bge 语义判定＋量化目标结构判定，占比 <50% 判重度模板化，docx L94/L156） ──
/** 归因分析语义原型：成因/风险来源表述基准（而非仅复述现象） */
export const ATTRIBUTION_SEMANTIC_QUERY = '分析该工程难点的成因与风险来源';
/** 量化控制目标：数值 + 单位/频次（结构判定，保留正则） */
export const QUANTIFIED_TARGET_RE = /\d+(?:\.\d+)?\s*(?:mm|cm|m|米|℃|%|kN|MPa|次|天|日历天|小时|h|Hz|m³|㎡|m²|t|吨|座|套|个)/u;

export interface DifficultyCountermeasureReport {
  /** 重难点章节对策条目总数 */
  countermeasures: number;
  /** 含归因分析的条目数 */
  attributed: number;
  /** 含量化控制目标的条目数 */
  quantified: number;
  /** 归因＋量化双达标条目数 */
  bothCount: number;
  /** 双达标占比 */
  ratio: number;
  /** <50% 判重度模板化（docx L156） */
  heavyTemplated: boolean;
  /** 条目明细（原文 + 归因/量化双达标标志，限 24 条）：模板化修复闭环的重难点条目锚点源 */
  entries: Array<{ text: string; attributed: boolean; quantified: boolean }>;
}

/** 重难点章节提取：定位"重难点/重点难点"标题段落后到下一同级标题前的内容；
 * 无独立标题小节时回退定位「重难点识别表」表格段（丰乐镇第五轮实测：重难点以表格形式
 * 承载于工程特点小节，标题正则永远匹配不到 → 检测恒 0 条目、双达标 0% 假阴性） */
export function extractKeyDifficultySection(markdown: string): string {
  // D-T7：行首锚定 + 逐级边界——r28f 实测「#### 1.1.3 重点难点」（H4 小节）被旧正则 `#{2,3}`
  // 偏置匹配（从第 2 个 # 起按 `##`+`[^\n]*` 命中）且边界 `^#{2,3}` 不认 H4 边界 → 提取范围
  // 吞掉后续全部内容（实测 8 条目中 6 条为 1.1.4/后续章无关正文）→ 双达标率被稀释
  // （0.125 假重度模板化）。现口径：`^#{2,4}` 行首锚定匹配标题，边界按命中标题的实际级别
  // 动态构建（H4 小节截到下一 H2-H4、H3 小节截到下一 H2/H3——H3 内含 H4 子标题不提前截断）。
  const match = markdown.match(/^#{2,4}\s*[^\n]*(?:重难点|重点难点|工程难点|难点分析)[^\n]*\n/mu);
  if (match && match.index !== undefined) {
    const start = match.index + match[0].length;
    const rest = markdown.slice(start);
    const level = match[0].match(/^#+/u)?.[0].length ?? 3;
    const boundary = new RegExp(`^#{2,${Math.max(2, level)}}\\s+`, 'mu');
    const nextHeading = rest.search(boundary);
    return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  }
  // 回退：表头含「重难点/重点难点」列的识别表（表头行 → 至首个非表格行结束；词表与标题路径同源：
  // r28f 表头为「重点难点」，旧回退正则只认「重难点」漏配）
  const tableHead = markdown.match(/^\|?\s*[^\n]*(?:重难点|重点难点|工程难点|难点分析)[^\n]*\|\s*$/mu);
  if (!tableHead || tableHead.index === undefined) return '';
  const rest = markdown.slice(tableHead.index);
  const lines = rest.split(/\n/u);
  const tableLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (tableLines.length > 0) break;
      continue;
    }
    if (!trimmed.startsWith('|')) {
      if (tableLines.length > 0) break;
      continue;
    }
    tableLines.push(line);
  }
  return tableLines.join('\n');
}

/** 重难点条目切分（单源）：表格载体（重难点识别表，每数据行一条）与段落载体（空行分段 ≥20 字）
 * 两种形式——写作时执行器（blockQualityExecutors 归因量化）与终检报告共用，条目口径一致 */
export function splitDifficultyEntries(section: string): string[] {
  const isTableForm = section.trim().startsWith('|');
  return isTableForm
    ? section.split(/\n/u).filter(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('|') && !/^\|\s*-+\s*\|/u.test(trimmed) && !/重难点/u.test(trimmed.split('|')[1] || '');
    }).filter(line => line.trim().length >= 20)
    : section.split(/\n{2,}/u).filter(block => block.trim().length >= 20);
}

/** 重难点条目评估（归因 bge 语义 + 量化目标结构判定）：写作时执行器与终检报告同源共享 */
export interface DifficultyEntryAssessment {
  entries: string[];
  attributed: number;
  quantified: number;
  bothCount: number;
  ratio: number;
  details: Array<{ text: string; attributed: boolean; quantified: boolean }>;
}

export async function assessDifficultyEntries(
  entries: string[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
  options: { attributionColumnIndex?: number } = {},
): Promise<DifficultyEntryAssessment> {
  // 惰性求值：表格形态走列判据，不需要嵌入（省掉对表格行的无意义嵌入调用）；仅散文形态才建相似度闭包
  let attributionSimilarity: Awaited<ReturnType<typeof buildSemanticSimilarity>> | undefined;
  const attributionOf = async (entry: string): Promise<boolean> => {
    if (attributionColumnIndex >= 0) return cellOf(entry, attributionColumnIndex).length >= 4;
    attributionSimilarity ??= await buildSemanticSimilarity(entries, [ATTRIBUTION_SEMANTIC_QUERY], embedDocuments);
    return attributionSimilarity(entry, ATTRIBUTION_SEMANTIC_QUERY) >= SEMANTIC_COVERAGE_THRESHOLD;
  };
  let attributed = 0;
  let quantified = 0;
  let bothCount = 0;
  const details: Array<{ text: string; attributed: boolean; quantified: boolean }> = [];
  // 表格形态：归因半改判「成因/风险来源列是否有实质内容」（结构判据）。
  // 实测（巢湖，真实 bge 余弦）：重难点以表格呈现时，**表头行（纯列名）得 0.643 通过、而真实条目
  // 只得 0.476~0.524 不通过**（阈值 0.6）——该语义度量对表格形态不具备分辨率（测的是"是否出现
  // 成因/风险来源词汇"，且长表格行被单元格碎片稀释）。表格行的归因本就有独立列承载，
  // 故按列判定：该列存在且单元格有实质内容（≥4 字）即视为已归因。
  const attributionColumnIndex = options.attributionColumnIndex ?? -1;
  const cellOf = (row: string, index: number) => (row.split('|').slice(1, -1)[index] ?? '').trim();
  for (const entry of entries) {
    const hasAttribution = await attributionOf(entry);
    const hasTarget = QUANTIFIED_TARGET_RE.test(entry);
    if (hasAttribution) attributed += 1;
    if (hasTarget) quantified += 1;
    if (hasAttribution && hasTarget) bothCount += 1;
    details.push({ text: entry, attributed: hasAttribution, quantified: hasTarget });
  }
  return { entries, attributed, quantified, bothCount, ratio: entries.length ? bothCount / entries.length : 0, details };
}

/** 重难点对策模板化检测：按条目（空行分段）统计"归因＋量化目标"双达标占比 */
export async function difficultyCountermeasureReport(
  markdown: string,
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<DifficultyCountermeasureReport> {
  const section = extractKeyDifficultySection(markdown);
  const entries = splitDifficultyEntries(section);
  // 表格形态：从表头行定位「成因/风险来源」列后按列判定归因（见 assessDifficultyEntries 注释）
  const attributionColumnIndex = (() => {
    const header = entries.find(entry => entry.trim().startsWith('|'));
    if (!header) return -1;
    return header.split('|').slice(1, -1).map(cell => cell.trim())
      .findIndex(cell => /成因|风险|致险|难点分析/u.test(cell));
  })();
  const assessment = await assessDifficultyEntries(entries, embedDocuments, { attributionColumnIndex });
  return {
    countermeasures: entries.length,
    attributed: assessment.attributed,
    quantified: assessment.quantified,
    bothCount: assessment.bothCount,
    ratio: assessment.ratio,
    // heavyTemplated 只依据**可测的一半**（量化目标，QUANTIFIED_TARGET_RE 结构判定）：
    // 归因语义半经三次实测**不具备分辨力**——同一查询下「含成因字面的段落」14 段得 0.530~0.565、
    // 「不含成因的段落」9 段得 0.53~0.57（两类同区间）；而短表头行反得 0.643 通过。
    // 该度量实际测的是「长度+主题词」而非「有无归因」，且截断归一化（120/200/300 字）也无法分离两类。
    // 它此前同时污染两处：①模板化等级（进而在旧口径下把总分封顶 54）；②修复轮收敛判据
    //（globalQualityGates 要求 !heavyTemplated 才判收敛 → 假重度导致修复轮空转多轮）。
    // 现口径：不可测的不上分、不参与收敛判定；attributed/bothCount 保留为观测字段。
    heavyTemplated: entries.length > 0 && assessment.quantified / entries.length < 0.5,
    entries: assessment.details.slice(0, 24),
  };
}

// ── 5. 四新技术有效性三标尺（可对标官方推广目录 / 替代落后工艺 / 升级价值，满足任意两项） ──
/** 官方推广目录引用（docx L77）：目录名形态通用（国家/省/市级推广目录均命中「新技术推广目录」子串） */
export const FOUR_NEW_CATALOG_RE = /建筑业10项新技术|10项新技术|新技术推广目录|建设领域推广/u;
/** 替代落后工艺表述 */
export const FOUR_NEW_REPLACE_RE = /替代|取代|淘汰.{0,10}(?:工艺|技术|做法)|(?:较|比).{0,10}(?:传统|常规|普通)/u;
/** 升级价值表述（提升/节省/降低等） */
export const FOUR_NEW_UPGRADE_RE = /(?:提升|提高|节省|节约|降低|缩短|减少).{0,10}(?:效率|工期|成本|损耗|能耗|人工|周期)|升级价值|效益显著/u;

/** 高频四新技术名称（附录七抽样，按通用跨专业词表） */
export const FOUR_NEW_TECH_NAMES = [
  'BIM', '铝模', '附着式升降脚手架', '跳仓法', '直螺纹', '装配式', '灌浆套筒',
  '自动化监测', '智慧工地', '再生利用', '非开挖', 'CCTV', '碳纤维', '薄贴法',
  '干法施工', '液压提升', '预制', '光伏一体化', 'BIPV', '模块化',
] as const;

export interface FourNewTechReport {
  found: string[];
  catalogCited: boolean;
  replaceClaimed: boolean;
  upgradeClaimed: boolean;
  /** 三标尺满足任意两项方为有效四新（docx L77） */
  effective: boolean;
}

export function fourNewTechCheck(markdown: string): FourNewTechReport {
  const found = FOUR_NEW_TECH_NAMES.filter(name => markdown.includes(name));
  const catalogCited = FOUR_NEW_CATALOG_RE.test(markdown);
  const replaceClaimed = FOUR_NEW_REPLACE_RE.test(markdown);
  const upgradeClaimed = FOUR_NEW_UPGRADE_RE.test(markdown);
  const metCount = [catalogCited, replaceClaimed, upgradeClaimed].filter(Boolean).length;
  return {
    found: [...found],
    catalogCited,
    replaceClaimed,
    upgradeClaimed,
    effective: found.length > 0 && metCount >= 2,
  };
}

// ── 6. 危大工程两步确认法（第一步类别匹配 37 号令目录，第二步参数分级，docx L82） ──
/** 危大类别词（附录三兜底清单 + 房建 7 项 / 市政 8 项） */
export const DANGEROUS_CATEGORY_RES = [
  /基坑|沟槽/u, /模板支撑|高支模/u, /脚手架|悬挑|附着式/u, /起重吊装|吊装/u,
  /幕墙/u, /人工挖孔桩/u, /装配式|钢结构安装/u, /拆除工程/u, /顶管|盾构|暗挖/u,
  /有限空间|水下作业/u, /吊篮/u, /塔吊|施工电梯|升降机/u, /沉井/u,
] as const;
/** 分级表述：一般危大/超危大/专家论证（附录四） */
export const DANGEROUS_GRADE_RE = /超危大|超规模|专家论证|一般危大/u;
/** 分级参数：深度/高度/跨度/重量数字（用于第二步参数达标核验） */
export const DANGEROUS_PARAM_RE = /(?:深度|高度|跨度|开挖).{0,8}\d+(?:\.\d+)?\s*(?:m|米)|(?:重量|吊装).{0,8}\d+(?:\.\d+)?\s*(?:kN|千牛)/u;

export interface DangerousTwoStepReport {
  /** 命中的危大类别（第一步类别匹配） */
  categories: string[];
  /** 是否出现分级表述（一般危大/超危大/专家论证） */
  graded: boolean;
  /** 是否出现分级参数（深度/高度/跨度/重量数字） */
  paramMatched: boolean;
  /** 两步确认完成（类别命中且分级+参数齐全） */
  twoStepComplete: boolean;
}

export function dangerousTwoStepCheck(markdown: string): DangerousTwoStepReport {
  const categories = DANGEROUS_CATEGORY_RES
    .filter(pattern => pattern.test(markdown))
    .map(pattern => pattern.source.replace(/\\u\w*|\\|\(|\||\)/gu, ''));
  const graded = DANGEROUS_GRADE_RE.test(markdown);
  const paramMatched = DANGEROUS_PARAM_RE.test(markdown);
  return {
    categories,
    graded,
    paramMatched,
    twoStepComplete: categories.length > 0 && graded && paramMatched,
  };
}

// ── 7. 应急预案结构八部分（docx L103） ──
export const EMERGENCY_EIGHT_PARTS = [
  { name: '总则', pattern: /总则/u },
  { name: '组织机构及职责', pattern: /应急(?:组织|领导)|组织机构|应急指挥部|应急小组/u },
  { name: '风险分析与危险源辨识', pattern: /风险分析|危险源辨识|风险辨识/u },
  { name: '应急物资设备通讯保障', pattern: /应急物资|物资.{0,8}(?:保障|储备)|通讯保障|通信保障/u },
  { name: '专项应急预案', pattern: /专项应急预案|专项预案/u },
  { name: '应急响应流程', pattern: /应急响应|响应流程|响应程序/u },
  { name: '后期处置', pattern: /后期处置|善后|事故调查/u },
  { name: '培训演练', pattern: /(?:应急)?演练|培训.{0,6}演练/u },
] as const;

/** 施工现场常用专项预案（docx L103 必覆盖清单） */
export const EMERGENCY_COMMON_PLANS = [
  '高处坠落', '物体打击', '坍塌', '触电', '火灾', '起重', '防汛', '防台风', '中暑', '中毒窒息', '管线破坏',
] as const;

export interface EmergencyStructureReport {
  coveredParts: string[];
  missingParts: string[];
  /** 八部分覆盖率 */
  coverage: number;
  /** 常用专项预案命中数（房建/市政一般应有 8-12 个） */
  planHits: string[];
}

export function emergencyStructureCheck(markdown: string): EmergencyStructureReport {
  const coveredParts = EMERGENCY_EIGHT_PARTS
    .filter(part => part.pattern.test(markdown))
    .map(part => part.name);
  const missingParts = EMERGENCY_EIGHT_PARTS
    .filter(part => !part.pattern.test(markdown))
    .map(part => part.name);
  const planHits = EMERGENCY_COMMON_PLANS.filter(plan => markdown.includes(plan));
  return {
    coveredParts: [...coveredParts],
    missingParts: [...missingParts],
    coverage: coveredParts.length / EMERGENCY_EIGHT_PARTS.length,
    planHits: [...planHits],
  };
}

// ── 9. 跨项目内容残留（docx L151：零残留要求） ──
export const CROSS_PROJECT_RES = [
  /其他项目/u, /其他标段/u, /其他城市/u, /本公司(?:其他|承建)/u,
  /某(?:市|县|区|项目)(?:的)?/u, /他项目/u, /兄弟项目/u,
] as const;

export function crossProjectResidueHits(markdown: string): string[] {
  // 列举语境豁免：清单固有名称「标识及其他项目」类形态（“其他项目”前接“及”）非跨项目残留，
  // 先整体移除再检测——防止“他项目”子串在豁免词组内部命中误报（丰乐镇实测 1.5.2 标题「标识及其他项目等景观工程」）
  const cleaned = markdown.replace(/及其他项目/gu, '及〔清单列举项〕');
  return CROSS_PROJECT_RES.filter(pattern => pattern.test(cleaned)).map(pattern => pattern.source.replace(/\\u/gu, ''));
}

// ══════════════════ 10. R9 表达质量族（短语级套话 / 条款体复述 / 表格内容泄漏成散文） ══════════════════
/**
 * 实测依据（非推断）：doc-1790168542563-ea526b1b（巢湖施工组织设计，68113 字）全文字面扫描
 * + 段落级人工抽样（合格 3/5）——三类缺陷穿透了既有**三层齐备**的套话治理
 * （写作期约束 taskCardPrompt 第 3 条 / 块质检 scanBlockTemplating 占比 >10% 阻断 /
 * 二轮定向反馈携带命中句原文），根因是判据的**粒度**与**语体**覆盖缺口，不是纪律问题：
 * ① 整句判定 + 阈值 0.80 → 短语级套话被实质内容稀释（整句主题由主体内容主导，余弦不足）；
 * ② 14 条原型全是**口号体** → 法律/条款语体（“我方应…”“承包人必须…”）不在覆盖内；
 * ③ 无“书名号枚举散文段”判据 → 表格内容泄漏成散文残句（末尾规范号年份被切掉）。
 * 本族三项判据只产出**检测事实**（命中原文 + 观测值），供修复端定点改写；删除判定仍归既有整句通道。
 */

// ── 10.1 短语级套话扫描（R9-a：判定粒度从整句下沉到子句）──
/**
 * 为什么需要下沉：套话嵌在实质句中时整句 embedding 由主体内容主导，整句余弦不足。
 * 实测句（行90）：「塘渣石垫层、水泥稳定碎（砾）石各分项施工质量验收统一以“精心组织施工”为总控目标，
 * 检验批验收逐级对照核验」——整句主题是“垫层与级配碎石验收”，“精心组织施工”只占一个短语。
 * 本层命中只产出“套话短语”（短语原文 + 所属整句），供**定点改写该短语**；
 * **不进删除判定**（整句删除仍由 isZeroInfoSloganSentence 承接——按短语删整句会连带删除句中实质信息）。
 */

/** 子句长度下限（6 字，自定）：实测缺陷短语「精心组织施工」恰为 6 字，下限必须 ≤6 才覆盖得住；
 * 4 字以下是「满足要求」「符合规范」类合法短短语密集区（误伤源），且 bge 对 ≤4 字短语与长原型的
 * 余弦噪声显著（长短失配），故取 6 字。更短的纯口号子句不会漏——它们由整句通道（整句即套话）承接。 */
export const FILLER_PHRASE_MIN_CHARS = 6;

/**
 * 子句切分（单源）：先取**引号显式短语**，再把剩余部分按顿号/逗号切分。
 * 为什么要取引号片段：实测缺陷形态是 `统一以“精心组织施工”为总控目标`——套话被引号显式括起，
 * 引号即天然短语边界；只有取出引号内片段才能得到**正确的改写锚点**（“精心组织施工”），
 * 而不是把“水泥稳定碎（砾）石各分项施工质量验收统一以”这类带框架词的残段交给修复端（改不动）。
 */
export function splitFillerPhrases(sentence: string): string[] {
  const quoted: string[] = [];
  const rest = sentence.replace(/["“”'']([^"“”'']{2,40})["“”'']/gu, (_all, inner: string) => {
    quoted.push(inner);
    return '，';
  });
  return [...rest.split(/[，,、]/u).map(part => part.trim()), ...quoted]
    .filter(phrase => phrase.replace(/\s+/gu, '').length >= FILLER_PHRASE_MIN_CHARS);
}

/** 词面命中的“程度修饰保护”（实测误伤源）：FORBIDDEN_EMPTY_PHRASES 是词表，存在合法词**包含子串**的误伤
 * ——实测「标准之间要求不一致时按最高标准执行」因“最高标准”含“高标准”被词面召回（该句是实质规则句）。
 * 命中词左侧紧邻程度/比较修饰字即视为该处的合法组合（最高标准/更高标准/较高标准），不计本次命中。 */
const FORBIDDEN_PHRASE_MODIFIER_CHARS = '最更较尤极超过偏';

/** 空话短语词面命中（FORBIDDEN_EMPTY_PHRASES **单源词表** + isZeroInfoSloganSentence **单源零信息判据**）：
 * 为什么不另造词表/判据——空话词表与零信息判据在本仓均已单源（生成侧禁写词库 / 整句删除安全前置），
 * 本层只做**粒度下沉**（同一判据作用于子句），不造第二份标尺（C8-U 教训：双轨口径必然漂移）。 */
function hitsForbiddenEmptyPhrase(phrase: string): boolean {
  return FORBIDDEN_EMPTY_PHRASES.some(word => {
    for (let index = phrase.indexOf(word); index >= 0; index = phrase.indexOf(word, index + 1)) {
      const previous = index > 0 ? phrase[index - 1] : '';
      if (!previous || !FORBIDDEN_PHRASE_MODIFIER_CHARS.includes(previous)) return true;
    }
    return false;
  });
}

export interface FillerPhraseHit {
  /** 套话短语原文（改写锚点：只改这一处，不删整句） */
  phrase: string;
  /** 所属整句原文（供修复端定位与提供上下文） */
  sentence: string;
  /** 与套话语义原型的最高余弦（观测与校准用：子句粒度下的分布见 judgeFillerPhrases 注释） */
  similarity: number;
  /** 命中通道：semantic=套话原型余弦命中；zero-info=空话词面 + 零信息判据（子句粒度）命中 */
  channel: 'semantic' | 'zero-info';
}

/**
 * 短语级套话判定（句数组入口：块质检/修复锚点端可按块或按章复用；markdown 级入口见 scanFillerPhrases）。
 *
 * **判据单源**：语义通道复用 `FILLER_SEMANTIC_QUERIES` 与 `FILLER_SENTENCE_THRESHOLD`（不另造原型库、
 * 不另造阈值）；不修改整句判定的语义（judgeFillerSentences 仍是“整句即套话”的删除判定）。
 *
 * 离线实测（真实文档 878 句 → 3906 子句，bge-small-zh-v1.5）：
 * - 子句最高余弦 **0.794**，≥0.80 命中 **0 条**——0.80 是**整句粒度**的校准点（14 条原型均为多分句长口号），
 *   子句粒度下同一原型分数整体下移（实测缺陷短语「精心组织施工」= **0.673**，被稀释的子句 = 0.588）。
 *   故语义通道照单源保留但**不在本语料开火**；短语级召回由 zero-info 通道承接
 *   （该通道实测命中 2 条，均为真套话：实测缺陷短语「精心组织施工」+ 同类模板句
 *   「本工程质量标准为精心组织施工」；词表子串误伤「最高标准」由程度修饰保护拦截归零）。
 * - similarity 字段即为此留痕：后续若按子句粒度重新校准（需先做人工标注集），取证用本字段。
 * 模糊应答（vague）通道**不下沉到子句**：其处置是“整句具体化”而非“短语改写”，且模糊词根
 * （力争/尽量/基本）在子句粒度下的合法性高度依赖语境，下沉即误伤。
 */
export async function judgeFillerPhrases(
  sentences: string[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<FillerPhraseHit[]> {
  const entries: Array<{ phrase: string; sentence: string }> = [];
  for (const sentence of sentences) {
    for (const phrase of splitFillerPhrases(sentence)) entries.push({ phrase, sentence });
  }
  if (entries.length === 0) return [];
  const similarity = await buildSemanticSimilarity(entries.map(entry => entry.phrase), [...FILLER_SEMANTIC_QUERIES], embedDocuments);
  const hits: FillerPhraseHit[] = [];
  for (const entry of entries) {
    const score = Math.max(...FILLER_SEMANTIC_QUERIES.map(query => similarity(entry.phrase, query)));
    if (score >= FILLER_SENTENCE_THRESHOLD) {
      hits.push({ ...entry, similarity: score, channel: 'semantic' });
    } else if (hitsForbiddenEmptyPhrase(entry.phrase) && isZeroInfoSloganSentence(entry.phrase)) {
      hits.push({ ...entry, similarity: score, channel: 'zero-info' });
    }
  }
  return hits;
}

/** markdown 级短语扫描（句池单源：buildFillerSentencePool 的过滤/切分口径与整句判定完全一致） */
export async function scanFillerPhrases(
  markdown: string,
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<FillerPhraseHit[]> {
  return judgeFillerPhrases(buildFillerSentencePool(markdown), embedDocuments);
}

/**
 * 短语级套话**确定性通道**（zero-info 单通道，无需嵌入）：块质检入口（4.59 R-B5 ① 接线用）。
 *
 * 为什么不复用 `judgeFillerPhrases`（async + 嵌入通道）：
 * ① 实测语义通道**在短语粒度 0 命中**（878 句/3906 子句最高余弦 0.794 < 阈值 0.80，见 judgeFillerPhrases
 *    注释）——块级质检每块都跑，为一个**不开火的通道**付每块一次嵌入调用是纯成本；
 * ② 嵌入调用失败会把块质检拖进"扫描失败"分支，把质检风险从"判据"变成"基础设施"。
 * 判据**完全同源**（同一份 `splitFillerPhrases` + `hitsForbiddenEmptyPhrase` + `isZeroInfoSloganSentence`，
 * 只是不计算 semantic 分），不存在第二把标尺。
 *
 * `similarity` 恒 0：本入口**不计算**语义分，消费端不得把 0 读作"距离远"——语义分只由 judgeFillerPhrases 产出。
 */
export function scanZeroInfoFillerPhrases(markdown: string): FillerPhraseHit[] {
  const hits: FillerPhraseHit[] = [];
  for (const sentence of buildFillerSentencePool(markdown)) {
    for (const phrase of splitFillerPhrases(sentence)) {
      if (hitsForbiddenEmptyPhrase(phrase) && isZeroInfoSloganSentence(phrase)) {
        hits.push({ phrase, sentence, similarity: 0, channel: 'zero-info' });
      }
    }
  }
  return hits;
}

// ── 10.2 条款体复述（R9-b：法律/条款语体，零本项目信息的义务复述）──
/**
 * 缺口：既有 14 条套话原型全是**口号体**（精心组织/严格执行/加强管理…），条款语体不在覆盖内。
 * 实测缺陷（行623，整段 202 字来自招标文件条款、零本项目信息、未被任何一层拦住）：
 * 「我方在任何时候都应采取各种合理的预防措施，防止其员工发生任何违法、违禁、暴力或妨碍治安的行为…」
 *
 * 判据（确定性，主判据）：含**招标义务词** ∧ 不含**本项目实体** ∧ 不含**可核查承诺**
 * ∧ 无**项目自指/岗位/手续/专业做法**锚点 → 判“条款复述”。
 * 后四类闸门是**防过度**（实测：只用“义务词 ∧ 无实体”两条时全文命中 38/878，其中
 * 「给水排水构筑物底板砼强度等级应采用C30」（材料牌号=量化参数）、
 * 「凡在与已交工工程有关联的部位施工时，必须提前向甲方提出书面联系单」（手续锚点）、
 * 「项目部编制生产安全事故应急救援预案…项目经理任组长，安全员负责日常应急管理」（岗位锚点）
 * 等**有项目信息的技术句/措施句**被误判；逐闸补齐后 **5/878**，逐条人工复核为零项目信息的义务复述
 * ——含实测缺陷句与「必须严格执行国家及地方政府的有关规定」类条款句；
 * 反例「我方承担…责任/费用」被承诺闸放行（防过度优先于召回，删除承诺实质的代价高于漏判一句套话））。
 * 已知边界（留给标注集校准，不擅自收窄）：命中清单含「《建筑防火通用规范》规定，防火分隔部位的封堵
 * 构造应保证防火分区的完整性」这类“规范引用 + 义务词、但零本项目锚点”的句子——本层按判据判为复述
 * （与实测缺陷段第 3 句同类）；若后续标注集判其为合法技术句，收窄点应是“含书名号引用”闸。
 */

/** 招标义务词（条款语体标志词）：应/应当/应负责/必须/不得/须。
 * 边界修正（实测误报源）：裸“应”会命中非义务子串用法——相应/响应/适应/对应/供应/反应/感应/顺应的
 * **前字**与 应用/应急/应对/应诉 的**后字**均须排除，否则「采取相应的保护措施」「应急物资」
 * 这类技术句会被判为义务表述（实测占误判大头）。 */
export const CLAUSE_OBLIGATION_RE = /(?<![相响适对供感反效因顺])(?:应负责|应当|应(?!用|急|对|酬|诉|邀|允|聘|试|考)|必须|不得|须)/u;

/** 本项目实体（判“零本项目信息”的反向锚点，四类）：单体名（1#厂房、2#门卫）/ 清单条目与条款引用 /
 * 量化参数（数字 + 计量或计数单位，含 万/亿 级与材料牌号 C30、MU20）/ 图纸要素（轴线、标高、构件…）。
 * 命中任一即**不判**条款复述（删掉项目信息的代价高于漏判一句套话）。 */

/** 量化参数单位串：量词主体**复用 unitAliases.MEASURE_UNIT_SOURCE 单源**（4.56 改造 3-b 反重复
 * 棘轮：手抄第二份量词交替串即红），只追加本判据需要而单源未登记的单位——长度小数（mm/cm）、
 * 压强势能（kW/kV/MPa/kN/kPa）、温度（℃/°）、百分比、时长（min/分钟/小时/天/日历天）与
 * 计数（次/遍/处/户/层/栋/区/名/位/人/项/份/道）。数字 + 任一单位即视为“带本项目量化信息”。 */
const PROJECT_QUANTITY_UNIT_SOURCE = `${MEASURE_UNIT_SOURCE}|mm|cm|kW|kV|MPa|kN|kPa|℃|°|%|min|分钟|小时|天|日历天|次|遍|处|户|层|栋|区|名|位|人|项|份|道`;
/** 量化参数（数字 + 可选 万/亿 级 + 单位）：用 RegExp 组合而非字面量，避免手抄第二份量词串 */
const PROJECT_QUANTITY_RE = new RegExp(`[0-9０-９](?:\\.[0-9]+)?\\s*(?:万|亿)?(?:${PROJECT_QUANTITY_UNIT_SOURCE})`, 'iu');
/** 量化参数（中文数字 + 单位，如「三台」「十二米」）：与上式同源同一份量词串 */
const PROJECT_QUANTITY_CN_RE = new RegExp(`[一二三四五六七八九十百千两](?:${PROJECT_QUANTITY_UNIT_SOURCE})`);

export const PROJECT_ENTITY_RES = [
  /[0-9０-９]\s*[#＃号]\s*[厂栋楼座幢区段]/u,
  /(?:工程量清单|清单)(?:序号|编号|条目|项)|第[0-9]+(?:项|条)|[0-9]+(?:\.[0-9]+)+条/u,
  PROJECT_QUANTITY_RE,
  /(?<![A-Za-z0-9])(?:MU|HRB|HPB|HRBF|Q|C|M)\s?[0-9]{1,4}(?:[.．][0-9]+)?(?![A-Za-z0-9])/iu,
  PROJECT_QUANTITY_CN_RE,
  /轴线|标高|层高|跨度|断面|大样|节点|预埋|构件/u,
] as const;

/** 可核查承诺（防过度闸）：承诺/义务类动词 + 可核查客体（费用/工期/数量/人员/责任…），
 * 或审批链（报…确认/认可/审核/同意/签字）——含则一律**不判**复述。
 * 实测依据：规格给出的边界样例「我方承担整个工程的安全保卫等的费用」正是“承诺了费用承担”，
 * 判复述会误导修复端删除可核查承诺（实质响应）——这类句子必须放行。 */
const VERIFIABLE_COMMITMENT_RE = /(?:承担|承诺|保证|确保|负责|配备|投入|设置|提供|办理|填报|报送|报审|报验|完成|按期|保修|维护|满足|服从)[^。；;]{0,24}(?:费用|金额|价款|工期|日历天|质量目标|数量|台|套|份|人|名|次|项|手续|资料|责任|要求|内容|进度|义务)|(?:报|经|由)[^。；;]{0,10}(?:确认|认可|审核|批准|同意|签字|备案)/u;

/** 项目自指（防过度闸）：句中出现“本工程/本项目/本设计/本方案”即非“零本项目信息”——
 * 实测被排除例：「本设计中未考虑冬季、雨季的施工措施，施工单位应根据有关施工验收规范采取相应措施」
 * （前半句是项目信息，后半句才是条款语体；整句判复述会连带删除项目信息）。 */
const PROJECT_SELF_REFERENCE_RE = /本(?:工程|项目|设计|方案|标段|项目部)/u;

/** 岗位锚点（防过度闸，与 isZeroInfoSloganSentence 的岗位词表同族）：实测被排除例
 * 「项目部编制生产安全事故应急救援预案，成立应急领导小组，项目经理任组长，安全员负责日常应急管理」
 * ——虽为通用话术，但承载了项目组织机构（有信息）。 */
const CLAUSE_DUTY_POST_RE = /项目经理|技术负责人|施工员|质检员|专职安全员|安全员|材料员|资料员|试验员|测量员|班组长|监理|责任人|岗位|班组/u;

/** 手续锚点（防过度闸）：实测被排除例「外来人员进入现场须登记领证，由门卫值守人员核验后放行」
 * ——登记/核验/台账/归档等可核查手续属项目做法，不是条款复述。 */
const CLAUSE_PROCEDURE_RE = /登记|领证|核验|签认|签字|归档|留存|台账|记录|备案|报审|报验/u;

/** 专业做法锚点（防过度闸）：实测被排除例「填土夯实应夯夯相连、不得漏夯」「当日回填应当日夯实」
 * ——含具体施工动作的技术句即便无量化参数也不是条款复述。 */
const CLAUSE_PRACTICE_ANCHOR_RE = /浇筑|养护|摊铺|碾压|回填|砌筑|焊接|绑扎|安装|调试|试压|打压|涂装|降水|开挖|支模|振捣|张拉|防腐|保温|导流|闭水|夯实|铺设|铺贴|抹灰|吊装|测量|放线|取样|送检|检验批|隐蔽验收/u;

/** 条款体复述判定（确定性单源：检测端与修复锚点端同入口）——先放行闸后判定，任一门命中即不判。 */
export function isClauseRecitationSentence(sentence: string): boolean {
  const compact = sentence.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').replace(/\s+/gu, '');
  if (compact.length < 12) return false;
  if (!CLAUSE_OBLIGATION_RE.test(compact)) return false;
  if (PROJECT_ENTITY_RES.some(pattern => pattern.test(compact))) return false;
  if (VERIFIABLE_COMMITMENT_RE.test(compact)) return false;
  if (PROJECT_SELF_REFERENCE_RE.test(compact)) return false;
  if (CLAUSE_DUTY_POST_RE.test(compact)) return false;
  if (CLAUSE_PROCEDURE_RE.test(compact)) return false;
  return !CLAUSE_PRACTICE_ANCHOR_RE.test(compact);
}

/** 条款复述全文扫描（句池单源，无需嵌入；修复锚点端逐章同口径） */
export function scanClauseRecitationSentences(markdown: string): string[] {
  return buildFillerSentencePool(markdown).filter(sentence => isClauseRecitationSentence(sentence));
}

/**
 * 条款体复述的**写作期约束文本**（4.59 R-B5 ②：处置通道 = constraint/块任务卡；单一出处，
 * 写作期任务卡与本模块判据同属一处，不另抄一份口径）。
 *
 * 为什么约束要写成"改写为本项目做法"而不是"禁止写条款"：本族的判定是**语体形态**
 *（「应/必须/不得」式义务复述 ∧ 无本项目实体 ∧ 无可核查承诺 ∧ 无岗位/手续/专业做法锚点），
 * 而正确写法是同一件事的**项目化表达**（谁做、何时、何部位、频次、记录）——写手需要的是替换目标，
 * 不是禁令（只禁不导会退化为"少写一段"）。
 * 为什么不给示例句（与 4.59 R-B7 同一原则）：给出条款体示例句等于给出可抄用的句子模板，
 * 本地模型对提示词示例的复读倾向远高于抽象指令；故只描述语体特征，不提供任何可抄句子。
 */
export const CLAUSE_RECITATION_CONSTRAINT_RULE = '【写作红线】不得整句复述规范/合同/招标文件的条款原文（“应/必须/不得”式义务复述语体，且句中无本项目实体、无可核查承诺）——把条款内容改写为本项目的具体做法：谁执行、何时执行、在哪个部位、频次多少、留什么记录，只写本项目实际执行的内容。';

/**
 * 条款体语义原型（**与口号体原型互补**的寄存器基准）：口号体原型测“鼓动/管理空话”
 * （精心组织、严格执行、加强管理——无义务主体、无权利义务结构），条款体原型测“权利义务复述”
 * （主语为条款主体，谓语为 应/必须/不得 + 义务）。两者覆盖**不同语体**，单一原型库任一方都无法
 * 同时覆盖（实测：202 字条款段对口号体原型最高余弦 0.691、对条款体 0.608——同一句两簇分数同量级，
 * 说明 bge 把两者都读作“泛化义务/口号”）。
 *
 * 因此本原型库的角色是**观测与校准通道**（judgeClauseRecitations.clauseSimilarity），
 * **不是开火判据**：实测零项目信息句池 92 句中 88 句口号体原型分数更高（条款原型未形成可分离簇），
 * 拿它开火要么假阴性（AND 口径丢掉实测缺陷句）要么误伤（OR 口径引入“模板材质由投标人自行选择”类
 * 实质句）。开火判据由确定性判据承接；本原型库为后续扩充/换模型时的重校准留基准。
 */
export const CLAUSE_RECITATION_SEMANTIC_PROTOTYPES = [
  '我方应按照招标文件及合同约定履行义务',
  '承包人必须服从发包人及监理人的管理',
  '应按国家现行规范标准执行',
  '我方应遵守招标文件的规定并承担相应责任',
  '承包人应严格按照招标文件及合同约定组织实施并服从监理人的指令',
] as const;

export interface ClauseRecitationJudgement {
  sentence: string;
  /** 确定性判据命中（开火口径，见 isClauseRecitationSentence） */
  clauseRecitation: boolean;
  /** 条款体原型最高余弦（**观测与校准用**，不参与开火——理由见原型库注释） */
  clauseSimilarity: number;
}

/** 条款复述句级判定器（clauseRecitation 由确定性判据决定，clauseSimilarity 仅留痕观测） */
export async function judgeClauseRecitations(
  sentences: string[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<ClauseRecitationJudgement[]> {
  if (sentences.length === 0) return [];
  const similarClause = await buildSemanticSimilarity(sentences, [...CLAUSE_RECITATION_SEMANTIC_PROTOTYPES], embedDocuments);
  return sentences.map(sentence => ({
    sentence,
    clauseRecitation: isClauseRecitationSentence(sentence),
    clauseSimilarity: Math.max(...CLAUSE_RECITATION_SEMANTIC_PROTOTYPES.map(prototype => similarClause(sentence, prototype))),
  }));
}

// ── 10.3 表格内容泄漏成散文（R9-d：书名号枚举段无主谓）──
/**
 * 实测形态（行557）：「编制依据表」的条目被倒成一段散文——整段仅由书名号枚举构成、无主谓，
 * 且末尾《建筑工程冬期施工规程》（JGJ/T 104）的年份被切掉：
 * 「《建筑桩基技术规范》（JGJ 94-2008）、《建筑机电工程抗震设计规范》（GB 50981-2014）、…（JGJ/T 104）」
 *
 * 判据（纯形态，确定性）：书名号枚举 ≥3 处 ∧ 非书名号/非规范号残留占比 ≤35% ∧ 残留无谓语特征词。
 * 阈值实测依据（同一真实文档）：
 * - 泄漏段：书名号 7 处、残留占比 **0.029**（残留仅“、、、、、、”六个分隔符，无谓语）；
 * - 合法依据引用段（含主谓：本工程执行《…》《…》等标准）：残留占比 **0.72~0.96**（谓语/宾语本身占字）；
 * - 表格内的依据行（结构载体）：0.33~0.60，且带 `|` 标记 → 由“结构载体先剔除”规则直接放过。
 * 故 0.35 在泄漏侧留 12 倍裕度、在合法侧留 2 倍裕度；结构载体（表格/列表/标题/引用行）是**正确载体**，
 * 判泄漏会误伤，一律先剔除再判。
 */
export const TABLE_LEAK_MIN_BOOK_CITATIONS = 3;
export const TABLE_LEAK_RESIDUAL_RATIO_LIMIT = 0.35;

/** 书名号引用（《…》，限长 60 防跨段贪婪） */
const TABLE_LEAK_BOOK_RE = /《[^《》]{1,60}》/gu;
/** 规范/标准编号（GB 50202-2013、JGJ/T 104 式，含括号形态）：属“枚举构成”的一部分，不计入残留 */
const TABLE_LEAK_STANDARD_CODE_RE = /[（(]?\s*(?:GB|JGJ|CJJ|CECS|JG|DB|JTG|SL|DL|TB|SH|HG|NB|YS)\s*\/?\s*T?\s*\d{2,5}(?:\s*[-—]\s*\d{2,4})?\s*[)）]?/giu;
/** 谓语特征词（“无主谓”的确定性代理）：残留里出现任一谓语/谓词性成分即视为句子（不判泄漏） */
const TABLE_LEAK_PREDICATE_RE = /执行|依据|按照|根据|采用|编制|组织|实施|施工|验收|安装|浇筑|检测|检查|管理|控制|负责|承担|落实|开展|进行|完成|建立|设置|确保|保证|满足|符合|规定|要求|参见|详见|遵照|遵守|结合|作为|包括|覆盖/u;

/** 结构载体行判定（表格行/列表项/标题/引用）：这些是正确载体，不参与泄漏判定 */
function isStructuralCarrierLine(line: string): boolean {
  return /^(?:#{1,6}\s|[-*+]\s|>|\|)/u.test(line) || /[|｜]/u.test(line);
}

/** 表格内容泄漏段判定（单段：非书名号残留占比 + 无谓语 → 判泄漏） */
export function isTableLeakParagraph(paragraph: string): boolean {
  const compact = paragraph.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').replace(/\s+/gu, '');
  if (!compact) return false;
  const citations = compact.match(TABLE_LEAK_BOOK_RE)?.length ?? 0;
  if (citations < TABLE_LEAK_MIN_BOOK_CITATIONS) return false;
  const residual = compact.replace(TABLE_LEAK_BOOK_RE, '').replace(TABLE_LEAK_STANDARD_CODE_RE, '');
  if (residual.length > compact.length * TABLE_LEAK_RESIDUAL_RATIO_LIMIT) return false;
  return !TABLE_LEAK_PREDICATE_RE.test(residual);
}

/** 表格内容泄漏全文扫描（markdown 级）：按空行分块 → 剔除结构载体行（表格/列表/标题/引用）→ 逐段判定。
 * 返回命中段原文，供修复端删段或改回表格（题注/编号由渲染层生成，不在本判据范围）。 */
export function scanTableLeakParagraphs(markdown: string): string[] {
  const paragraphs = markdown.split(/\n{2,}/u).map(block => block
    .split('\n')
    .map(line => line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '').trim())
    .filter(line => line.length > 0 && !isStructuralCarrierLine(line))
    .join('\n'));
  return paragraphs.filter(paragraph => isTableLeakParagraph(paragraph));
}
