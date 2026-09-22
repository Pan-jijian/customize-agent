import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';
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
  acceptance: '经检查验收合格后整改销项闭环',
} as const;

/** 五要素词面封闭表（L2 确定性判定单源）：plan/process 为方案类/工序类正式表述，
 * role/frequency/acceptance 为岗位/频次/闭环封闭词。评分（本文件 fiveElementBlockStats）
 * 与链尾补强（fiveElementClosureBoost）同源引用，禁止双口径漂移。 */
export const FIVE_ELEMENT_WORD_RES = {
  plan: /专项施工方案|专项方案|施工方案|施工组织设计|技术措施|管理制度|技术交底|作业指导书|操作规程/u,
  process: /施工工序|工艺流程|施工流程|作业流程|施工顺序|施工步骤|工艺步骤|流水段|流水作业|依次施工|工序/u,
  role: /项目经理|技术负责人|施工员|质检员|安全员|材料员|资料员|测量员|劳资员|班组长|监理工程师|试验员/u,
  frequency: /每日|每天|每周|每月|每季度|每批|不少于\s*\d+\s*次|至少\s*\d+\s*次|每周\s*\d+\s*次|每日\s*\d+\s*次|每\s*\d+\s*日/u,
  acceptance: /整改|复查|销项|复验|闭环|返工/u,
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
