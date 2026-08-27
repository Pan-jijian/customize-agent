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

/** 模糊应答词命中明细（含出现次数），供评分扣分与报告定位 */
export function vagueResponseHits(markdown: string) {
  return VAGUE_RESPONSE_PHRASES.filter(phrase => markdown.includes(phrase))
    .map(phrase => ({ phrase, count: markdown.split(phrase).length - 1 }));
}

// ── 2. 模板化套话检测：空泛词 + 通用模板句式 + 套话密度三档 ──
/** 通用模板固定句式（跨项目可替换、无本项目专属参数） */
export const TEMPLATE_FILLER_SENTENCE_RES = [
  /一般来说/u, /通常情况下/u, /常规施工/u, /按照规范施工/u, /严格按规范/u,
  /视情况而定/u, /适当(?:调整|安排)/u, /满足设计要求/u, /确保工程质量/u,
] as const;

/** 空泛虚词（附录一第 1 类 + 无效修饰词抽样，短语级避免误伤正常表述） */
export const EMPTY_FILLER_WORDS = [
  '精心组织', '科学统筹', '精益求精', '全力保障', '高效推进', '一流水平',
  '完善体系', '最大限度', '显著提升', '大力落实', '严格把控', '充分确保',
  '现代化管理', '加强管理', '提高意识', '强化监督', '持续完善', '提质增效',
] as const;

export type TemplatingLevel = 'heavy' | 'medium' | 'light';

export interface FillerDensityReport {
  /** 核心段落总句数（≥12 字正文句） */
  totalSentences: number;
  /** 套话句数（含空泛词/通用模板句式/模糊应答词） */
  fillerSentences: number;
  /** 套话占比 */
  ratio: number;
  /** 模板化等级：≥40% 重度 / 20%-40% 中度 / <20% 轻度（docx L23 阈值） */
  level: TemplatingLevel;
}

/** 套话密度统计：核心章节（全文口径，评分器可传核心段落子集）套话句占比 */
export function fillerDensityReport(markdown: string): FillerDensityReport {
  const sentences = markdown
    .split(/\n+/u)
    .filter(line => line.trim() && !/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(line))
    .flatMap(line => line.split(/[。；;]/u))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 12);
  const fillerSentences = sentences.filter(sentence =>
    EMPTY_FILLER_WORDS.some(word => sentence.includes(word))
    || TEMPLATE_FILLER_SENTENCE_RES.some(pattern => pattern.test(sentence))
    || VAGUE_RESPONSE_PHRASES.some(phrase => sentence.includes(phrase)),
  ).length;
  const ratio = sentences.length ? fillerSentences / sentences.length : 0;
  const level: TemplatingLevel = ratio >= 0.4 ? 'heavy' : ratio >= 0.2 ? 'medium' : 'light';
  return { totalSentences: sentences.length, fillerSentences, ratio, level };
}

// ── 3. 措施五要素闭合（方案＋流程＋责任人＋时间节点＋验收标准，缺 2 项以上判不完整） ──
export const MEASURE_PLAN_RE = /(?:制定|编制|建立|明确|采用|执行).{0,15}(?:方案|制度|措施|预案)/u;
export const MEASURE_PROCESS_RE = /工序|流程|步骤|顺序|工艺/u;
export const MEASURE_ROLE_RE = /项目经理|技术负责人|总工程师|项目负责人|施工员|质检员|质量员|安全员|专职安全员|材料员|资料员|测量员|试验员|电工|文明施工管理员|专业工长|班组长|监理工程师/u;
export const MEASURE_FREQUENCY_RE = /每日|每天|每周|每月|每季度|每旬|每\s*\d+\s*天|不少于\s*\d+\s*次|24\s*小时|随时/u;
export const MEASURE_ACCEPTANCE_RE = /验收|整改|复查|销项|闭环|复验|复核|检查合格|合格后/u;

export interface FiveElementBlockStats {
  blocks: number;
  /** 五要素至少 4 项齐全的块数（方案/流程/责任人/时间节点/验收标准） */
  completeBlocks: number;
  /** 缺责任人或缺时间节点的块数（docx L93：缺这两要素判措施不完整） */
  incompleteBlocks: number;
}

/** 措施五要素闭合统计：按空行分块（≥30 字），五要素命中 ≥4 项为闭合块 */
export function fiveElementBlockStats(markdown: string): FiveElementBlockStats {
  const blocks = markdown.split(/\n{2,}/u).filter(block => block.trim().length >= 30);
  let completeBlocks = 0;
  let incompleteBlocks = 0;
  for (const block of blocks) {
    const hits = [MEASURE_PLAN_RE, MEASURE_PROCESS_RE, MEASURE_ROLE_RE, MEASURE_FREQUENCY_RE, MEASURE_ACCEPTANCE_RE]
      .filter(pattern => pattern.test(block)).length;
    if (hits >= 4) completeBlocks += 1;
    else if (!MEASURE_ROLE_RE.test(block) || !MEASURE_FREQUENCY_RE.test(block)) incompleteBlocks += 1;
  }
  return { blocks: blocks.length, completeBlocks, incompleteBlocks };
}

// ── 4. 重难点对策模板化专项检测（归因＋量化目标占比 <50% 判重度模板化，docx L94/L156） ──
/** 归因分析表述：成因/风险来源（而非仅复述现象） */
export const DIFFICULTY_ATTRIBUTION_RE = /因为|由于|成因|风险来源|主要风险|难点在于|系.*(?:导致|造成)|因.{0,20}(?:深厚|水位|地质|临近|邻近|狭小|交叉)/u;
/** 量化控制目标：数值 + 单位/频次 */
export const QUANTIFIED_TARGET_RE = /\d+(?:\.\d+)?\s*(?:mm|cm|m|米|℃|%|kN|MPa|次|天|小时|h|Hz|m³)/u;

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
}

/** 重难点章节提取：定位"重难点/重点难点"标题段落后到下一同级标题前的内容 */
export function extractKeyDifficultySection(markdown: string): string {
  const match = markdown.match(/#{2,3}\s*[^\n]*(?:重难点|重点难点|工程难点|难点分析)[^\n]*\n/u);
  if (!match || match.index === undefined) return '';
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const nextHeading = rest.search(/^#{2,3}\s+/mu);
  return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
}

/** 重难点对策模板化检测：按条目（空行分段）统计"归因＋量化目标"双达标占比 */
export function difficultyCountermeasureReport(markdown: string): DifficultyCountermeasureReport {
  const section = extractKeyDifficultySection(markdown);
  const entries = section.split(/\n{2,}/u).filter(block => block.trim().length >= 20);
  let attributed = 0;
  let quantified = 0;
  let bothCount = 0;
  for (const entry of entries) {
    const hasAttribution = DIFFICULTY_ATTRIBUTION_RE.test(entry);
    const hasTarget = QUANTIFIED_TARGET_RE.test(entry);
    if (hasAttribution) attributed += 1;
    if (hasTarget) quantified += 1;
    if (hasAttribution && hasTarget) bothCount += 1;
  }
  const ratio = entries.length ? bothCount / entries.length : 0;
  return {
    countermeasures: entries.length,
    attributed,
    quantified,
    bothCount,
    ratio,
    heavyTemplated: entries.length > 0 && ratio < 0.5,
  };
}

// ── 5. 四新技术有效性三标尺（可对标官方推广目录 / 替代落后工艺 / 升级价值，满足任意两项） ──
/** 官方推广目录引用（docx L77） */
export const FOUR_NEW_CATALOG_RE = /建筑业10项新技术|10项新技术|安徽省住房城乡建设领域新技术推广目录|新技术推广目录|建设领域推广/u;
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

// ── 8. 四节一环保量化基准值（附录八，核验绿色施工指标达标承诺） ──
export const GREEN_BENCHMARK_CHECKS = [
  { name: '节能：施工用电损耗率≤5%', pattern: /用电损耗.{0,8}5\s*%|损耗率.{0,8}≤\s*5/u },
  { name: '节能：节能灯具占比100%', pattern: /节能(?:型)?灯.{0,12}100\s*%|照明.{0,12}100\s*%节能/u },
  { name: '节地：场内土方平衡率≥70%', pattern: /土方平衡.{0,8}7\d\s*%|土方(?:平衡|回填).{0,10}70/u },
  { name: '节水：非传统水源利用率', pattern: /非传统水源|中水|雨水(?:收集|利用)/u },
  { name: '节材：模板周转次数≥8次', pattern: /周转.{0,8}(?:8|[89]\d)\s*次|周转次数.{0,6}\d/u },
  { name: '环保：扬尘六个百分百', pattern: /六个百分百|6个100%|六个100%|扬尘.{0,10}100\s*%/u },
  { name: '环保：废水三级沉淀', pattern: /三级沉淀/u },
] as const;

export interface GreenBenchmarkReport {
  hits: string[];
  /** 基准值达标命中率（≥60% 视为绿色施工指标基本达标） */
  coverage: number;
}

export function greenBenchmarkCheck(markdown: string): GreenBenchmarkReport {
  const hits = GREEN_BENCHMARK_CHECKS.filter(check => check.pattern.test(markdown)).map(check => check.name);
  return { hits: [...hits], coverage: hits.length / GREEN_BENCHMARK_CHECKS.length };
}

// ── 9. 跨项目内容残留（docx L151：零残留要求） ──
export const CROSS_PROJECT_RES = [
  /其他项目/u, /其他标段/u, /其他城市/u, /本公司(?:其他|承建)/u,
  /某(?:市|县|区|项目)(?:的)?/u, /他项目/u, /兄弟项目/u,
] as const;

export function crossProjectResidueHits(markdown: string): string[] {
  return CROSS_PROJECT_RES.filter(pattern => pattern.test(markdown)).map(pattern => pattern.source.replace(/\\u/gu, ''));
}
