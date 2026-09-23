import type { DocumentTemplateChapter, PlannedTablePlan } from './types';
import { figureTableHeaderRow } from './figureSubstituteTables';

/** 图位规格（章 + 图类名）：由 collectFigurePlaceholderSpecs 汇集；
 * 4.55.25 零图口径下它表示「该章应以数据表落实的图类要求」 */
export interface FigurePlaceholderSpec {
  chapterTitle: string;
  name: string;
}
import type { PlannedTableRequest } from './promptRuleExtraction';

function normalizeText(text: string) {
  return text.replace(/\s+/gu, '').toLowerCase();
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

/** 二字滑窗重叠率：标题语义重合度判定（容忍“劳动力动态投入”与“劳动力投入计划”等表述差异） */
function bigramOverlap(left: string, right: string) {
  const bigrams = (text: string) => {
    const set = new Set<string>();
    for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2));
    return set;
  };
  const target = bigrams(normalizeText(right));
  const source = [...bigrams(normalizeText(left))];
  if (source.length === 0) return 0;
  return source.filter(pair => target.has(pair)).length / source.length;
}

/** 提示词必需表格归属评分下限：最高分低于此值视为无归属，显性返回最终门禁兑底链（产品内部判定参数） */
const TABLE_ATTACH_MIN_SCORE = 0.3;
/** 小节承接表格的滑窗重叠阈值（≥ 此值视为承接，避免表述差异导致表格丢失；产品内部判定参数） */
const TABLE_ATTACH_OVERLAP_THRESHOLD = 0.6;

/** 提示词声明必需表格 → 章节匹配评分（表名与章标题/小节标题的包含关系与滑窗重叠，取最高） */
function requiredTableMatchScore(title: string, chapter: DocumentTemplateChapter) {
  const norm = normalizeText(title).replace(/表$/u, '');
  if (!norm) return 0;
  let best = 0;
  for (const haystack of [chapter.title, ...(chapter.sections || [])]) {
    const normalized = normalizeText(haystack);
    if (!normalized) continue;
    if (normalized.includes(norm) || norm.includes(normalized)) { best = Math.max(best, 1); continue; }
    best = Math.max(best, bigramOverlap(norm, normalized));
  }
  return best;
}

/**
 * 规划表格计划构建：表格来源 = 提示词声明的必需表格（用户声明层，必写）+ LLM 章节规划的表格需求
 * （按章按节产出）。无静态目录匹配、无系统创作——规划没有的表不出现。
 * 提示词声明的必需表格逐表全章评分归属最高分章；无归属（评分低于 TABLE_ATTACH_MIN_SCORE）的显性返回，
 * 交由最终门禁的必需表格兜底链（markdownComposer.insertRequiredTable）处理并供进度消息展示。
 * 标书编制规格为 forbidden（招标显式禁表句：正文不得出现表格/图表）时短路：正文不注入任何表格计划
 * （LLM 规划表格需求与提示词必需表格均已由阶段 1 编制规格裁决，图表由终稿附表区直出承接）；
 * allowed（暗标/明标/未识别且无禁表证据）时正常构建。
 */
export function buildPlannedTablePlans(input: {
  chapters: DocumentTemplateChapter[];
  plannedTables: Map<string, PlannedTableRequest[]>;
  requiredTables?: string[];
  /** 标书编制规格（阶段 1 判定）的正文表格策略：forbidden（显式禁表句）时正文不注入任何表格计划 */
  bodyTablePolicy?: 'forbidden' | 'allowed';
}): { chapters: DocumentTemplateChapter[]; unattachedRequiredTables: string[] } {
  if (input.bodyTablePolicy === 'forbidden') return { chapters: input.chapters, unattachedRequiredTables: [] };
  const plansByChapterId = new Map<string, PlannedTablePlan[]>();
  const addPlan = (chapterId: string, request: { title: string; fields: string[]; section?: string; required: boolean; reason: string }) => {
    const title = request.title.trim();
    if (!title) return;
    const plans = plansByChapterId.get(chapterId) || [];
    if (plans.some(plan => plan.title === title || plan.title.includes(title) || title.includes(plan.title))) return;
    plans.push({
      id: `planned-table-${chapterId}-${plans.length + 1}`,
      title,
      chapterTitle: '',
      section: request.section || '',
      required: request.required,
      reason: request.reason,
      fields: request.fields.filter(Boolean).map(name => ({ name })).slice(0, 12),
    });
    plansByChapterId.set(chapterId, plans);
  };
  for (const chapter of input.chapters) {
    for (const request of input.plannedTables.get(chapter.id) || []) {
      addPlan(chapter.id, { title: request.title, fields: request.fields, required: false, reason: '本章小节规划产出的表格需求（按章按节规划）。' });
    }
  }
  const unattachedRequiredTables: string[] = [];
  for (const rawTitle of input.requiredTables || []) {
    const title = rawTitle.trim();
    if (!title) continue;
    let bestChapter: DocumentTemplateChapter | undefined;
    let bestScore = 0;
    for (const chapter of input.chapters) {
      const score = requiredTableMatchScore(title, chapter);
      if (score > bestScore) { bestScore = score; bestChapter = chapter; }
    }
    if (!bestChapter || bestScore < TABLE_ATTACH_MIN_SCORE) { unattachedRequiredTables.push(title); continue; }
    addPlan(bestChapter.id, { title, fields: [], required: true, reason: '用户提示词声明的必需表格。' });
  }
  const chapters = input.chapters.map(chapter => {
    const plans = plansByChapterId.get(chapter.id);
    if (!plans?.length) return chapter;
    return {
      ...chapter,
      tableSections: unique([...(chapter.tableSections || []), ...plans.map(plan => plan.title)]),
      tableRequirements: unique([
        ...(chapter.tableRequirements || []),
        ...plans.filter(plan => plan.required).map(plan => `${plan.title}：用户提示词声明的必需表格，必须真实输出为 markdown 表格，表头与行数据必须与本章内容一致。`),
      ]),
      tablePlans: plans.map(plan => ({ ...plan, chapterTitle: chapter.title })),
    };
  });
  return { chapters, unattachedRequiredTables };
}

/** 按小节标题把章节表格计划分配到具体小节（小节级成稿链路使用，保证表格指令到达 Writer） */
export function sectionTablePlans(chapter: DocumentTemplateChapter, sectionTitle: string): PlannedTablePlan[] {
  const plans = chapter.tablePlans || [];
  if (plans.length === 0) return [];
  const norm = normalizeText(sectionTitle || '');
  if (!norm) return plans;
  return plans.filter(plan => {
    // 规划归属小节直接命中
    const sectionNorm = normalizeText(plan.section || '');
    if (sectionNorm && (norm.includes(sectionNorm) || sectionNorm.includes(norm))) return true;
    const titleNorm = normalizeText(plan.title);
    if (titleNorm && (norm.includes(titleNorm) || titleNorm.includes(norm))) return true;
    // 表名去掉“表”后缀后与小节标题互相包含（如“劳动力投入计划”小节承接“劳动力动态投入计划表”）
    const plainTitle = titleNorm.replace(/表$/u, '');
    if (plainTitle && (norm.includes(plainTitle) || plainTitle.includes(norm))) return true;
    // 二字滑窗重叠率兜底：小节标题与表名语义高度重合（≥60%）视为承接，避免表述差异导致表格丢失
    if (plainTitle && bigramOverlap(norm, plainTitle) >= TABLE_ATTACH_OVERLAP_THRESHOLD) return true;
    return false;
  });
}

/** 章节内没有被任何小节承接的表格计划（兜底挂到最匹配的承载小节，防止表格因小节标题不匹配而丢失） */
export function unassignedSectionTablePlans(chapter: DocumentTemplateChapter, sectionTitles: string[]): PlannedTablePlan[] {
  const plans = chapter.tablePlans || [];
  if (plans.length === 0) return [];
  return plans.filter(plan => !sectionTitles.some(title => sectionTablePlans(chapter, title).some(assigned => assigned.id === plan.id)));
}

/** 文档中的 markdown 表格数量（分隔行计数） */
function markdownTableCount(markdown: string) {
  let count = 0;
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*\|?\s*:?-{3,}:?/u.test(line) && line.includes('|')) count += 1;
  }
  return count;
}

/** 表题行最大长度：超过视为正文段落（表题与后文粘连时按表名前缀截取）；产品内部判定参数 */
const TABLE_TITLE_MAX_LEN = 40;
/** 表题粘连前缀截取最大长度（截取到行内首个“表”字，如“XX计划表上述措施…”→“XX计划表”） */
const TABLE_TITLE_PREFIX_MAX_LEN = 36;
const TABLE_TITLE_PREFIX_PATTERN = new RegExp(`^.{2,${TABLE_TITLE_PREFIX_MAX_LEN}}?表`, 'u');
/** 表格引导语结尾模式（通用工程写作引导句，如“详见下表”“如下所示”）：此类行是叙述引导而非表题；产品级通用词表，与具体项目无关 */
const TABLE_LEADIN_TAIL_PATTERN = /(详见|参见|参照|如[下上]|如下|如上|[下上]表|所示|附表|后表)[：:。]?$/u;
/** 表前引导句锚点（产品级通用引导语，与具体项目无关）：「…如下表」「…见下表」「…按下表记录」「…如下：」类点名表格用途的引导语（r23 P3b；r24 B8 补「按[下上]表」族） */
const TABLE_LEADIN_ANCHOR_RE = /详见下表|参见下表|参照下表|按[下上]表|如下表所示|如下表|见下表|如上表|如下所示|如下所列|列举如下|列表如下|如下[：:]/u;
/** 表名尾词（通用表格命名构成词，产品级通用词表）：提取候选须以名词性尾词落定，防动词/承诺短语误截（r23 P3b） */
const TABLE_NAME_TAIL_RE = /(表|计划|清单|台账|汇总|统计|安排|措施|要求|标准|参数|要点|记录|配置|情况|指标|一览|明细|方案)$/u;
/** 行内表名短语提取动词（通用管理动词，产品级通用词表）：「编制X表/建立X台账/形成X清单」叙述句形态（r23 P3b） */
const TABLE_NAME_VERB_RE = /(?:编制|建立|形成|汇总|列出|统计|整理|绘制|制定)([^，。；;：:]{2,28}?(?:表|台账|清单|一览表))/u;
/** 表名核心词通用修饰词（中文表格命名的通用构成词，去修饰后比对语义骨架；产品级通用词表，与具体项目无关） */
const TABLE_TITLE_MODIFIER_PATTERN = /(汇总|计划|记录|清单|台账|一览|配置|控制|检查|要点|情况|措施|方案|安排|表)/gu;
/** 逐表对账阈值（产品内部判定参数）：完整标题/核心词滑窗重叠 ≥0.5、表头字段覆盖 ≥0.5 视为承接 */
const TABLE_MATCH_TITLE_OVERLAP = 0.5;
const TABLE_MATCH_CORE_OVERLAP = 0.5;
const TABLE_MATCH_FIELD_COVERAGE = 0.5;
/** 逐表对账通道分：完整标题 > 核心词 > 字段（一对一贪心分配按分降序） */
const TABLE_MATCH_SCORE_TITLE = 0.9;
const TABLE_MATCH_SCORE_CORE = 0.7;
const TABLE_MATCH_SCORE_FIELD = 0.5;
/** 无题表确定性补名参数（产品内部判定参数）：计划表字段覆盖率阈值 + 计划表最少字段数（少字段计划表不参与匹配，防低置信误配） */
const TITLELESS_FIELD_COVERAGE = 0.6;
const TITLELESS_MIN_PLAN_FIELDS = 3;

/** markdown 实际表格候选（逐表对账用）：题名 + 表头单元格 + 题注编号有无 */
interface MarkdownTableCandidate {
  title: string;
  headerCells: string[];
  /** 题名行是否已带题注编号前缀（“表X-Y”）：题注校验依据（剥离前原始题名判定） */
  captioned: boolean;
}

/** 表头行/数据行拆格（去首尾竖线，去空格） */
function splitTableCells(line: string): string[] {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim()).filter(Boolean);
}

/**
 * 题注编号口径的**共享碎片**（判据单源）：编号概念只有一个，两个变体只能共用同一份字符类与标点类——
 * 两处各写一份"表 + 数字 + 破折号"的字符类，任何一处扩容（如新增中文数字形态）都会让另一处沉默失配，
 * 而"两个编号判据互不承认"正是 4.58 实测的双编号根因（见 TABLE_CAPTION_NUMBER_HEAD_SOURCE 注释）。
 */
const TABLE_CAPTION_DIGITS = '[\\d一二三四五六七八九十]+';
const TABLE_CAPTION_TAIL_PUNCT = '[:：、.．]?';

/**
 * 题注编号前缀识别（“表3-2”“表3.2”“表一、”）：已带题注的表题不重复注入（幂等）与题注校验共用。
 *
 * 与下方 `TABLE_CAPTION_NUMBER_HEAD_SOURCE` **同源不同口径**（有意保留两个变体，共用上面的碎片）：
 * 本变体是**窄口径**（编号段至多一段破折号 + 必须以空白收尾）= "完整编号"，用于注入器的幂等判定；
 * 放宽它会改变"是否跳过注入"的行为（见 R9-e 判据注释的实测理由），故不在本处放宽。
 */
const TABLE_CAPTION_PREFIX_RE = new RegExp(`^表\\s*${TABLE_CAPTION_DIGITS}(?:[-－.．—]\\s*${TABLE_CAPTION_DIGITS})?\\s*${TABLE_CAPTION_TAIL_PUNCT}\\s`, 'u');

/** 题注编号前缀剥离：兼容“表3-2 劳动力投入计划表”“表 3.2：”“表一、”等系统/人工题注 */
function stripTableNumberPrefix(title: string) {
  return title.replace(TABLE_CAPTION_PREFIX_RE, '').trim();
}

/** r28h M4b 残缺题注前缀（「表N-题名」——编号的表序段丢失形态：数值清理误删「M 道」类数字的历史
 * 产物）：完整前缀判据（TABLE_CAPTION_PREFIX_RE）要求编号段以数字收尾，此形态漏网会让注入器
 * 在原行上再叠「表N-M 表N-题名」双编号；注入前剥离前缀按当前表序重新编号（题名余文保留） */
const MALFORMED_CAPTION_PREFIX_RE = new RegExp(`^表\\s*${TABLE_CAPTION_DIGITS}\\s*[-—–－.．]\\s*(?=[^\\d\\s])`, 'u');

/** 中文章节号 → 阿拉伯数字（“第十章”→10，“二十三”→23；纯数字原样；通用中文数字，无项目语义） */
const CHINESE_DIGIT_VALUE: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function chineseNumberToArabic(text: string): number {
  if (/^\d+$/u.test(text)) return Number(text);
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (char === '十') { total += (current || 1) * 10; current = 0; }
    else if (char === '百') { total += (current || 1) * 100; current = 0; }
    else if (CHINESE_DIGIT_VALUE[char]) current = CHINESE_DIGIT_VALUE[char];
  }
  return total + current;
}

/** 表块定位解析（逐表对账与题注注入共用）：表题行位置与题名形态（标准行/粘连行/表头首格/引导句/无题名） */
interface TableBlockProbe {
  headerIndex: number;
  dividerIndex: number;
  /** 表题行 index（line/attached/leadIn 形态）；headerCell/none 形态为 undefined */
  titleIndex?: number;
  kind: 'line' | 'attached' | 'headerCell' | 'leadIn' | 'none';
  /** 原始题名（含题注前缀；headerCell 形态为原始首格；leadIn 形态为提取表名；none 形态为空串） */
  rawTitle: string;
  /** headerCell 形态已剔除表名首格；其余形态为原始表头单元格 */
  headerCells: string[];
}

/** 表名候选最终校验：长度/尾词/字符集（引导句提取与截断回退共用） */
function validLeadInTableName(name: string): boolean {
  return name.length >= 3 && name.length <= 30 && TABLE_NAME_TAIL_RE.test(name) && /^[\u4e00-\u9fa5A-Za-z0-9（）()、与及的]+$/u.test(name);
}

/**
 * 从引导句/管理叙述句中提取表名候选（r23 P3b 归因：LLM 常以引导句点名表格用途而不单独写表题行，
 * 原判据将整行当引导句跳过致表格无题注）。纯原文提取不改写不补造，任一环节不满足返回空串
 *（不注入，交终检报出）。两类来源：
 * - 引导锚点形态（「…主要施工内容与工程量汇总如下表，…」）：锚点前片段 → 「按…枚举」截断 →
 *   句读边界切 → 剥「现将/兹将」类前缀 → 尾词/长度/字符校验；
 * - 行内动词短语形态（「编制工期关键节点控制表，明确…」）：「编制/建立/形成」+ 名词短语 + 尾词。
 * 校验不过（尾词不符/超长/含非常用字符）即放弃，防「我公司郑重承诺如下表」类正文承诺句误取。
 */
function extractLeadInTableName(line: string): string {
  let candidate = '';
  const anchor = TABLE_LEADIN_ANCHOR_RE.exec(line);
  if (anchor) {
    if (anchor.index < 3) return '';
    candidate = line.slice(0, anchor.index);
    // 「按…枚举清单…汇总」结构（如「…控制要点按分项工程、施工工序、…汇总如下表」）：
    // 判定要求顿号紧贴「按」后（首个顿号前不得跨句读）——枚举顿号链紧贴是「按…清单」的形态特征，
    // 「应急物资按分散施工面配置，每村配备急救箱1个、…」类叙述句（顿号前有句读）不误截；
    // 截断结果须自证有效（长度+尾词）否则回退未截断候选——防「项目经理按事故等级在1小时内向
    // 建设单位、监理单位…报告」类叙述句（顿号紧贴但非清单）误截致漏提取
    let enumerationCut = -1;
    for (const match of candidate.matchAll(/按/gu)) {
      const start = (match.index || 0) + 1;
      const after = candidate.slice(start, start + 30);
      const dunAt = after.indexOf('、');
      const pauseAt = after.search(/[，。；：:]/u);
      if (dunAt >= 0 && (pauseAt < 0 || dunAt < pauseAt)) enumerationCut = match.index || 0;
    }
    if (enumerationCut > 0 && validLeadInTableName(candidate.slice(0, enumerationCut).replace(/\s+/gu, ''))) {
      candidate = candidate.slice(0, enumerationCut);
    }
    // 句读边界切：取最后一个句读右侧片段（跨句引导语如「…予以明确。主要危险源清单与管控措施如下表：」）
    const boundary = Math.max(...['。', '；', '！', '？', '，', '、', '：', ':', ';'].map(mark => candidate.lastIndexOf(mark)));
    if (boundary >= 0) candidate = candidate.slice(boundary + 1);
    candidate = candidate.replace(/^(?:现将|兹将|并将|现拟|以下|下面|下列)/u, '').trim();
  } else {
    const verb = TABLE_NAME_VERB_RE.exec(line);
    if (!verb) return '';
    candidate = (verb[1] || '').trim();
  }
  // 候选内部空白归一（PDF/材料转写残留的句中空格，如「应急救援物资 与设备配置表」）：
  // 题注行是系统注入行，空白归一不属原文改写；含空白候选不归一会被字符校验拒掉致漏提取
  candidate = candidate.replace(/\s+/gu, '');
  if (!validLeadInTableName(candidate)) return '';
  return candidate;
}

function probeTableBlock(lines: string[], dividerIndex: number): TableBlockProbe | undefined {
  const headerIndex = dividerIndex - 1;
  const headerCells = splitTableCells(lines[headerIndex] || '');
  if (headerCells.length === 0) return undefined;
  const firstCell = headerCells[0] || '';
  // 表头首格承载表名（“表名顶替首列名”脏形态）：以“表”结尾的短格视为题名，从字段中剔除
  if (headerCells.length >= 3 && firstCell.length >= 3 && firstCell.length <= 20 && /表$/u.test(firstCell)) {
    return { headerIndex, dividerIndex, kind: 'headerCell', rawTitle: firstCell, headerCells: headerCells.slice(1) };
  }
  // 表题行：向上最近的非空行（允跨空行、上限 8 行）；撞到表格行即视为无题名。
  // 引导句（“本节配置详见下表：”类叙述行）不是表题，跳过继续上溯——防止将引导句注入为题注；
  // 但引导句/叙述句内含可提取表名时按 leadIn 形态保留原行并在其下方注入题注行（r23 P3b）。
  for (let up = dividerIndex - 2; up >= 0 && dividerIndex - up <= 8; up -= 1) {
    const above = (lines[up] || '').trim();
    if (!above) continue;
    if (above.includes('|')) break;
    if (above.startsWith('#')) {
      // 标题行形态（r23 P3b 归因：「#### 项目基本信息表」下表格无题注）：紧邻表格且标题文本以
      // 「表」结尾（剥编号前缀）即该表名，在标题下方注入题注行；其余标题照旧终止上溯
      const headingText = above.replace(/^#{1,6}\s+/u, '').replace(/^\d+(?:\.\d+)*[、.．\s]*/u, '').trim();
      if (/表$/u.test(headingText) && headingText.length >= 2 && headingText.length <= 30) {
        return { headerIndex, dividerIndex, titleIndex: up, kind: 'leadIn', rawTitle: headingText, headerCells };
      }
      break;
    }
    // 加粗表题行形态（系统注入与 LLM 常写「**表名**」整行加粗）：整行即表题，剥加粗标记取表名，
    // 行原位替换为纯文本题注行——若走粘连形态会残留「**」余文行（r24 B8 归因：基本信息表重建行
    // 「**项目基本信息表**」在加粗残留分支下产生孤立「**」残行）
    const boldTitle = /^\*\*([^*\n]{2,40})\*\*$/u.exec(above);
    if (boldTitle) return { headerIndex, dividerIndex, titleIndex: up, kind: 'line', rawTitle: boldTitle[1].trim(), headerCells };
    // 带题注前缀的行已是完整表题形态，直接采用（防首“表”截取误切题注内表字，如“表3-1 表题一表”）
    if (TABLE_CAPTION_PREFIX_RE.test(above)) return { headerIndex, dividerIndex, titleIndex: up, kind: 'line', rawTitle: above, headerCells };
    // 引导句/管理叙述句内表名提取（r23 P3b；r24 B8 提前到粘连形态之前）：命中且有效 → leadIn 形态
    // （保留原行，下方注入题注行）。粘连截取以行内首个“表”字截断，引导句中的「…按下表记录」会让截断
    // 结果吞入引导词尾、余文残行（r23 实机归因：畸形题注「表9-2 …维护情况按下表」+ 孤立残行
    // 「记录，各便道位置…」）——引导锚点形态先行，锚点前原文即干净表名，兜住整族引导句
    const leadInTitle = extractLeadInTableName(above);
    if (leadInTitle) return { headerIndex, dividerIndex, titleIndex: up, kind: 'leadIn', rawTitle: leadInTitle, headerCells };
    // 粘连形态：不以“表”结尾且行首即表名（首“表”前 ≤36 字）且“表”后有实质余文（≥2 字非句读开头）→ 表名+说明同行的脏形态；
    // 截断尾不得落在引导词上（「[下上如附]表」结尾的截断串如「按下表」是引导句组成部分而非表名——本次拒绝，
    // 交上方引导句/叙述分支继续上溯，防「各岗位安全职责如下表所示」类无表名引导句被截成畸形题名）
    const attached = TABLE_TITLE_PREFIX_PATTERN.exec(above)?.[0];
    if (attached && !/表$/u.test(above) && !/[下上如附]表$/u.test(attached)) {
      const rest = above.slice(attached.length);
      if (rest.length >= 2 && !/^[：:；;，,、。]/u.test(rest)) return { headerIndex, dividerIndex, titleIndex: up, kind: 'attached', rawTitle: attached, headerCells };
    }
    // 叙述引导行（通用引导语词表/句读判据）：不是表题，继续上溯
    if (TABLE_LEADIN_TAIL_PATTERN.test(above) || /[：:；;，,、]$/u.test(above) || above.includes('。')) continue;
    if (above.length <= TABLE_TITLE_MAX_LEN) return { headerIndex, dividerIndex, titleIndex: up, kind: 'line', rawTitle: above, headerCells };
    break;
  }
  return { headerIndex, dividerIndex, kind: 'none', rawTitle: '', headerCells };
}

/** markdown 实际表格枚举：题名（表题行/表头首格表名/题注剥离后）与表头单元格（脏形态剔除表名首格） */
export function extractMarkdownTableCandidates(markdown: string): MarkdownTableCandidate[] {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const candidates: MarkdownTableCandidate[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const divider = lines[index];
    if (!(/^\s*\|?\s*:?-{3,}:?/u.test(divider) && divider.includes('|'))) continue;
    const probe = probeTableBlock(lines, index);
    if (!probe) continue;
    candidates.push({
      title: stripTableNumberPrefix(probe.rawTitle),
      headerCells: probe.headerCells,
      captioned: TABLE_CAPTION_PREFIX_RE.test(probe.rawTitle.trim()),
    });
  }
  return candidates;
}

/** 无题名表格块（r24 B8 题名补全）：表块位置与原文摘录（确定性补名/LLM 补名轮/复检共用同一枚举） */
export interface TitlelessTableBlock {
  /** 表头行 index（markdown 行坐标） */
  headerIndex: number;
  /** 表头单元格（字段对账与补名指令共用） */
  headerCells: string[];
  /** 表块原文（表头行起连续表格行，上限 10 行；补名指令注入用） */
  blockText: string;
}

/** 无题名表格块枚举（probe 形态 kind='none'：表上方 8 行内无可用表题行/引导句/标题行/加粗题名形态）——
 * 题注注入器与逐表对账的共同盲区；补名判定与补名指令注入共用同一枚举（口径同源）。 */
export function extractTitlelessTableBlocks(markdown: string): TitlelessTableBlock[] {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const blocks: TitlelessTableBlock[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const divider = lines[index];
    if (!(/^\s*\|?\s*:?-{3,}:?/u.test(divider) && divider.includes('|'))) continue;
    const probe = probeTableBlock(lines, index);
    if (!probe || probe.kind !== 'none') continue;
    const blockLines = [lines[probe.headerIndex] || '', divider];
    for (let row = index + 1; row < lines.length && row - index <= 10; row += 1) {
      if (!(lines[row] || '').trim().startsWith('|')) break;
      blockLines.push(lines[row]);
    }
    blocks.push({ headerIndex: probe.headerIndex, headerCells: probe.headerCells, blockText: blockLines.join('\n') });
  }
  return blocks;
}

/**
 * 无题表题名确定性补全（r24 B8）：章内无题名表格与本章计划表按表头字段覆盖对账，一对一贪心匹配
 * （覆盖率高者优先，每张计划表/每张实际表至多配对一次）后将计划表题名作为独立表题行补到表格正上方。
 * 判定链产品级通用：仅凭表头字段文本双向包含匹配，无项目/表名硬编码；题名行插入形态与注入器约定一致
 * （表题行 + 空行 + 表头行），补名后题注注入/终检链条自然消费。无匹配/低置信残留表交 LLM 补名轮。
 */
export function completeTitlelessTableTitles(markdown: string, plans: PlannedTablePlan[]): { markdown: string; completed: number } {
  if (plans.length === 0) return { markdown, completed: 0 };
  const blocks = extractTitlelessTableBlocks(markdown);
  if (blocks.length === 0) return { markdown, completed: 0 };
  const pairs: Array<{ planIndex: number; blockIndex: number; score: number }> = [];
  plans.forEach((plan, planIndex) => {
    if (plan.fields.length < TITLELESS_MIN_PLAN_FIELDS) return;
    blocks.forEach((block, blockIndex) => {
      const coverage = fieldCoverage(plan.fields, block.headerCells);
      if (coverage >= TITLELESS_FIELD_COVERAGE) pairs.push({ planIndex, blockIndex, score: coverage });
    });
  });
  if (pairs.length === 0) return { markdown, completed: 0 };
  pairs.sort((left, right) => right.score - left.score);
  const usedPlans = new Set<number>();
  const usedBlocks = new Set<number>();
  const titleByHeaderIndex = new Map<number, string>();
  for (const pair of pairs) {
    if (usedPlans.has(pair.planIndex) || usedBlocks.has(pair.blockIndex)) continue;
    const title = (plans[pair.planIndex].title || '').trim();
    if (!title) continue;
    usedPlans.add(pair.planIndex);
    usedBlocks.add(pair.blockIndex);
    titleByHeaderIndex.set(blocks[pair.blockIndex].headerIndex, title);
  }
  if (titleByHeaderIndex.size === 0) return { markdown, completed: 0 };
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const title = titleByHeaderIndex.get(index);
    if (title) output.push(title, '');
    output.push(lines[index]);
  }
  return { markdown: output.join('\n'), completed: titleByHeaderIndex.size };
}

// ═══════════════ r26d 终稿无题表题名回填（草稿表头键反查） ═══════════════

/** 无题表题名回填结果（markdown=回填后全文；recovered=回填张数；details=逐表题名记录） */
export interface TitlelessTableTitleRecovery {
  markdown: string;
  recovered: number;
  details: string[];
}

/** 表头单元格归一键（回填对账用）：去全部空白后以 \u0000 连接；列数 <2 的骨架表不参与（低置信防误配） */
function tableHeaderKey(cells: string[]): string {
  if (cells.length < 2) return '';
  return cells.map(cell => cell.replace(/\s+/gu, '')).join('\u0000');
}

/** 草稿表题索引（表头归一键 → 唯一题名）：逐章草稿表块 probe（与 extractMarkdownTableCandidates
 * 同源单源）取样，题名形态 line/leadIn/headerCell/attached 均可回填（剥题注编号前缀）；
 * 同键多题名（歧义）与草稿自身无题名（kind='none'）不建条目——宁漏不回填错。 */
function buildDraftTableTitleIndex(chapterDrafts: string[]): Map<string, string> {
  const titlesByHeaderKey = new Map<string, Set<string>>();
  for (const content of chapterDrafts) {
    const lines = (content || '').replace(/\r/gu, '').split('\n');
    for (let index = 1; index < lines.length; index += 1) {
      const divider = lines[index];
      if (!(/^\s*\|?\s*:?-{3,}:?/u.test(divider) && divider.includes('|'))) continue;
      const probe = probeTableBlock(lines, index);
      if (!probe || probe.kind === 'none') continue;
      const title = stripTableNumberPrefix(probe.rawTitle).trim();
      if (!title) continue;
      const key = tableHeaderKey(probe.headerCells);
      if (!key) continue;
      const titles = titlesByHeaderKey.get(key) ?? new Set<string>();
      titles.add(title);
      titlesByHeaderKey.set(key, titles);
    }
  }
  const uniqueTitleByKey = new Map<string, string>();
  for (const [key, titles] of titlesByHeaderKey) {
    if (titles.size === 1) uniqueTitleByKey.set(key, [...titles][0]!);
  }
  return uniqueTitleByKey;
}

/**
 * 终稿无题表题名回填（r26d 门禁归因）：链尾章级 patch 与 rebuild（事实扩散/表格补名等 draft-mutating
 * 阶段）可能使终稿表格丢失表题行（r26c 实测：终稿「风险因素|影响工序|…」表无任何题名行、草稿同表头
 * 表仍带题名——probe 上溯撞表格行 kind='none' 直坠题注终检 blocker）。数据源为章草稿（写作层原始
 * 产物，题名行在草稿侧保有）：以表头单元格归一键反查同表题名，回填为独立表题行（表题行+空行+表头行，
 * 与注入器约定一致）；回填后由题注注入链分配编号。纯表头字段结构判据零项目语义；歧义键（同表头
 * 多题名）/草稿无题名/无匹配原样保留（交终检报出）；回填后表不再属无题表枚举（幂等可重放）。
 */
export function recoverTitlelessTableTitlesFromDrafts(markdown: string, chapterDrafts: string[]): TitlelessTableTitleRecovery {
  const blocks = extractTitlelessTableBlocks(markdown);
  if (blocks.length === 0) return { markdown, recovered: 0, details: [] };
  const uniqueTitleByKey = buildDraftTableTitleIndex(chapterDrafts);
  if (uniqueTitleByKey.size === 0) return { markdown, recovered: 0, details: [] };
  const titleByHeaderIndex = new Map<number, string>();
  const details: string[] = [];
  for (const block of blocks) {
    const title = uniqueTitleByKey.get(tableHeaderKey(block.headerCells));
    if (!title) continue;
    titleByHeaderIndex.set(block.headerIndex, title);
    details.push(`「${title}」`);
  }
  if (titleByHeaderIndex.size === 0) return { markdown, recovered: 0, details: [] };
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const title = titleByHeaderIndex.get(index);
    if (title) output.push(title, '');
    output.push(lines[index]);
  }
  return { markdown: output.join('\n'), recovered: titleByHeaderIndex.size, details };
}

/**
 * 明标正文表题注确定性注入（R20 C3）：正文每张表格的表题行注入「表{章号}-{章内序号} 表名」。
 * - 幂等：题名行/首格已带题注前缀则跳过，重跑不产生「表3-2 表3-2 表名」；
 * - 形态归位：表名占表头首格（以“表”结尾的短格）→ 移出为独立表题行后注入；
 *   表题与后文粘连（超长行且以表名前缀开头）→ 拆为「题注行 + 原文余文行」，内容零丢失；
 * - 引导句形态（r23 P3b）：引导句/叙述句/以“表”结尾的标题行内可提取表名（extractLeadInTableName）
 *   → 原行保留，题注行插入到表格正上方——与「整行即表题」的 line 形态区分，不吞原文不改写；
 * - 不动：未检出题名形态的表格（交终检 table-caption 校验报出）；附表区（## 附表N）不注入（附表编号体系独立）；
 * - 暗标（bodyTableForbidden）由调用方直接跳过（正文图表本不应存在）。
 */
export function injectTableCaptions(markdown: string): string {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const appendixIndex = lines.findIndex(line => /^##\s+附表\s*[一二三四五六七八九十\d]{1,3}/u.test(line));
  const bodyEnd = appendixIndex >= 0 ? appendixIndex : lines.length;
  const replacements = new Map<number, string[]>();
  let chapterNo = 0;
  let tableSeq = 0;
  for (let index = 0; index < bodyEnd; index += 1) {
    // 章号推进（“第X章”解析优先；无编号标题按出现顺序递增）；目录/附表标题不计章
    const heading = /^##\s+(.+?)\s*$/u.exec(lines[index]);
    if (heading && !/^(目录|附表)/u.test(heading[1])) {
      const numbered = /^第\s*([一二三四五六七八九十百\d]+)\s*章/u.exec(heading[1]);
      chapterNo = numbered ? chineseNumberToArabic(numbered[1]) : chapterNo + 1;
      tableSeq = 0;
    }
    const divider = lines[index];
    if (index < 1 || !(/^\s*\|?\s*:?-{3,}:?/u.test(divider) && divider.includes('|'))) continue;
    const probe = probeTableBlock(lines, index);
    if (!probe || probe.kind === 'none') continue;
    tableSeq += 1;
    if (TABLE_CAPTION_PREFIX_RE.test(probe.rawTitle.trim())) continue;
    // r28h M4b：残缺题注前缀剥离（「表3-路结构层…」→「路结构层…」）后按当前表序重编号，
    // 防注入产出「表3-2 表3-路结构层…」双编号；剥离后题名为空（该行仅剩残缺前缀）不注入
    const cleanTitle = probe.rawTitle.replace(MALFORMED_CAPTION_PREFIX_RE, '').trim();
    if (!cleanTitle) continue;
    const captionLine = `表${chapterNo}-${tableSeq} ${cleanTitle}`;
    if (probe.kind === 'headerCell') {
      // 表头首格表名移出为独立题注行，表头行同步恢复列名
      const headerLine = `| ${probe.headerCells.join(' | ')} |`;
      replacements.set(probe.headerIndex, [captionLine, '', headerLine]);
      continue;
    }
    const titleIndex = probe.titleIndex as number;
    if (probe.kind === 'line') {
      replacements.set(titleIndex, [captionLine]);
      continue;
    }
    if (probe.kind === 'leadIn') {
      // 引导句/标题行形态：原行保留，题注行插入到表格正上方（引导句与表格之间）
      replacements.set(titleIndex, [lines[titleIndex] || '', '', captionLine]);
      continue;
    }
    // 粘连形态：题注行 + 原文余文行（行内表名前缀之后的文字原样保留）
    const fullLine = (lines[titleIndex] || '').trim();
    const rest = fullLine.slice(probe.rawTitle.length).trim();
    replacements.set(titleIndex, rest ? [captionLine, '', rest] : [captionLine]);
  }
  if (replacements.size === 0) return markdown;
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const replacement = replacements.get(index);
    if (replacement) output.push(...replacement);
    else output.push(lines[index]);
  }
  return output.join('\n');
}

// ═══════════════ r25 B1 题注粘连拆分 + 表编号唯一化 ═══════════════

/** 粘连拆分最小余文长度（产品内部判定参数）：题注名后残留正文短于该值不拆，防拆出无意义碎句 */
const CAPTION_GLUE_RESIDUE_MIN = 8;
/** 粘连余文指代锚（通用衔接词，产品级通用词表）：题注名 + 后随正文的分界锚点（如「XX计划表上述措施…」） */
const CAPTION_RESIDUE_ANCHOR_RE = /(上述|前述|相关|该项|该表|本表|该计划|此项|本项|据此|为此)/u;
/** 题注名合法性（与 validLeadInTableName 同口径收窄）：长度 3~30、名词性尾词落定、不含句读（防引用整句误判为表名） */
function validCaptionTitle(name: string): boolean {
  return validLeadInTableName(name) && !/[。；！？，,.;!?]/u.test(name);
}

/**
 * r28h M4c 行尾粘连题注拆分（与行首粘连形态镜像；r28h2 实机归因：LLM 补名把「表N-M 题名」写回
 * 正文句尾——「…复验合格后报监理单位验收。表5-2 道路区段…清单」同行，probe 上溯因行内含「。」
 * 跳过致 kind='none'，题注链全链不消费）。判定：从右向左试每个「表N-M」候选——前置须句读收尾
 *（排引用句「见表5-2 所示」）、题名过 validCaptionTitle（长度/尾词/字符集/无句读，与行首形态
 * 同源）；表格行/标题行不处理；无匹配返回 null（调用侧原样保留）。
 */
function splitTrailingGluedCaption(row: string): { body: string; caption: string } | null {
  if (!row || row.startsWith('#') || row.includes('|')) return null;
  const matches = [...row.matchAll(/表\s*(\d+)\s*[-—–－.．]\s*(\d+)\s*[:：]?\s*(?=\S)/gu)];
  for (let cursor = matches.length - 1; cursor >= 0; cursor -= 1) {
    const match = matches[cursor];
    const start = match.index ?? 0;
    const body = row.slice(0, start).trimEnd();
    if (!/[。；！？:：]$/u.test(body)) continue;
    const title = row.slice(start + match[0].length).trim();
    if (!validCaptionTitle(title)) continue;
    return { body, caption: `表${match[1]}-${match[2]} ${title}` };
  }
  return null;
}

/**
 * r25 B1 题注粘连拆分（实机归因：LLM 修复轮 patch 重写把题注行与相邻正文合并为一行——
 * 「表1-1 重点难点识别与对策表上述措施以…抽验。」——注入器幂等（行首已带题注前缀）不再消费，
 * 粘连直坠交付）。对行首题注行内的「题注名 + 后随正文」按两条通用判据拆分：
 * - 首「表」截取（与探针 attached 同源）：截到行内首个“表”字的短串通过题名校验且后随余文
 *   超过阈值 → 「题注行 + 空行 + 余文行」；
 * - 指代锚切分：题名后跟「上述/相关/该项…」类衔接词（锚点前文本通过题名校验）→ 同位拆分，
 *   兜住表名不含“表”字/首“表”截取不可用的形态（如「工种配置与技能要求上述措施以…」）。
 * 纯结构判据零项目语义；不满足任一判据（干净题注、引用行「表7-1用于…」、断行残形「…计划按表」）
 * 原样保留。
 */
export function splitGluedTableCaptions(markdown: string): string {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const output: string[] = [];
  for (const line of lines) {
    const row = line.trim();
    const match = /^表\s*(\d+(?:[-—–]\d+)?)\s+(\S.*)$/u.exec(row);
    if (!match) {
      // r28h M4c 行尾粘连镜像形态（题名被补写在正文句尾）：拆为「正文行 + 空行 + 题注行」，
      // 题名行独立后与行首形态同构（注入器/编号唯一化/终检自然消费）
      const trailing = splitTrailingGluedCaption(row);
      if (trailing) {
        output.push(trailing.body, '', trailing.caption);
        continue;
      }
      output.push(line);
      continue;
    }
    const rest = match[2];
    let cutAt = -1;
    let title = '';
    const attached = TABLE_TITLE_PREFIX_PATTERN.exec(rest)?.[0];
    if (attached && validCaptionTitle(attached) && rest.slice(attached.length).length >= CAPTION_GLUE_RESIDUE_MIN) {
      cutAt = attached.length;
      title = attached;
    }
    if (cutAt < 0) {
      const anchor = CAPTION_RESIDUE_ANCHOR_RE.exec(rest);
      if (anchor && anchor.index >= 3) {
        const candidate = rest.slice(0, anchor.index).trim();
        if (validCaptionTitle(candidate) && rest.slice(anchor.index).length >= CAPTION_GLUE_RESIDUE_MIN) {
          cutAt = anchor.index;
          title = candidate;
        }
      }
    }
    if (cutAt < 0) {
      output.push(line);
      continue;
    }
    output.push(`表${match[1]} ${title}`, '', rest.slice(cutAt).trim());
  }
  return output.join('\n');
}

/** 回指续文句首词（通用衔接词，句首判定）：粘连拆分/注入器拆分产物中「题注名 + 后续正文」的正文句首词 */
const CAPTION_FOLLOWUP_PREFIX_RE = /^(?:上述|前述|相关|该项|该表|本表|该计划|此项|本项|据此|为此)/u;

/**
 * r25 B1 题注-续文回位：三类来源（粘连拆分产物、注入器 attached 拆分产物、LLM 修复轮重排残留）
 * 会形成「题注行 → 回指续文行（上述/相关/该项…）→ 表格」的截断形态——题注与表格被续文隔断，
 * 编号实体判据失配（题注不再贴表）、引用成孤儿、读序上续文插断题表相邻。
 * 将单行回指续文原位移到表格块之后（回指句以表为先行词，后置读序自然）；
 * 非回指行（引导句/引用句/正文叙述）不移动；仅处理单行续文 + 表格紧邻（空行分隔）形态；幂等。
 * 4.59 R-B3：本函数与 splitGluedTableCaptions 一并导出——题注剥离（stripModelAuthoredCaptionNumbers）
 * 必须在其**之后**（粘连形态拆开成干净题注行后，剥离判据才认得出"贴表题注"），链序见 finalizeTableCaptions。
 */
export function relocateCaptionFollowUps(markdown: string): string {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const row = (lines[index] || '').trim();
    const caption = /^表\s*\d+(?:[-—–－]\d+)?\s+(\S.*)$/u.exec(row);
    const follow = findCaptionFollowUp(lines, index, caption ? caption[1].trim() : '');
    if (!follow) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    const tableStart = follow.nextTableStart;
    const tableEnd = follow.tableEnd;
    output.push(lines[index]);
    for (let cursor = index + 1; cursor < follow.followIndex; cursor += 1) output.push(lines[cursor]);
    for (let cursor = tableStart; cursor < tableEnd; cursor += 1) output.push(lines[cursor]);
    output.push('', (lines[follow.followIndex] || '').trim());
    index = tableEnd;
  }
  return output.join('\n');
}

/** 回位探测（拆出便于阅读）：返回续文行/表格块坐标；不满足单行续文+紧邻表格形态返回 null */
function findCaptionFollowUp(lines: string[], captionIndex: number, title: string): { followIndex: number; nextTableStart: number; tableEnd: number } | null {
  if (!title || !validCaptionTitle(title)) return null;
  let follow = captionIndex + 1;
  while (follow < lines.length && !(lines[follow] || '').trim()) follow += 1;
  const followText = follow < lines.length ? (lines[follow] || '').trim() : '';
  if (!followText || !CAPTION_FOLLOWUP_PREFIX_RE.test(followText)) return null;
  if (followText.length < CAPTION_GLUE_RESIDUE_MIN || /^(?:[#|>]|[-*]\s|\d+[.、)])/u.test(followText)) return null;
  let table = follow + 1;
  while (table < lines.length && !(lines[table] || '').trim()) table += 1;
  if (table >= lines.length || !/^\s*\|/u.test(lines[table] || '')) return null;
  let divider = table + 1;
  while (divider < lines.length && !(lines[divider] || '').trim()) divider += 1;
  const dividerText = divider < lines.length ? (lines[divider] || '').trim() : '';
  if (!(/^\s*\|?\s*:?-{3,}:?/u.test(dividerText) && dividerText.includes('|'))) return null;
  let end = divider + 1;
  while (end < lines.length && (lines[end] || '').trim().startsWith('|')) end += 1;
  return { followIndex: follow, nextTableStart: table, tableEnd: end };
}

/** 题注实体的贴表判据（与 structureIntegrity scanTableNumberingDefects 实体判据同口径：下一非空行即表格行） */
function captionFollowedByTable(lines: string[], captionIndex: number): boolean {
  let next = captionIndex + 1;
  while (next < lines.length && !(lines[next] || '').trim()) next += 1;
  return next < lines.length && /^\s*\|/u.test(lines[next] || '');
}

/** 题注行内编号 key 归一（全角连字符/破折号 → 半角，与 scanTableNumberingDefects 同口径） */
function normalizeCaptionKey(raw: string) {
  return raw.replace(/[—–－]/gu, '-');
}

// ── §L3-2 章内表号跳号 / §L3-3 表题残缺 ──
// 两者共用「题注实体」口径（与 normalizeTableNumbering 同源：贴表题注 + 有效题名独立行，
// 正文引用句/叙述句不入池），因此不会把「见表3-2 所示」这类行内引用误判成题注缺陷。
// 注意 normalizeTableNumbering 只在**存在重复编号**时才重排编号，章内缺号（1,2,4…）不会触发它，
// 终检此前也无对应判据——这两族是真实盲区。
/** 题注实体：章号 + 表序 + 题名 */
interface CaptionEntityRef { line: number; chapterNo: number; sequence: number; name: string }

const CAPTION_ENTITY_RE = /^表\s*(\d+)\s*[-—–－.．]\s*(\d+)\s*[:：、.．]?\s*(.*)$/u;
/** 树形/制表符残留（组织架构树被抄进题名：「表2-5 └── 材料员、机械员」） */
const CAPTION_TREE_RESIDUE_RE = /[└├│─━┌┐┘┴┬┤]/u;

function collectCaptionEntities(markdown: string): CaptionEntityRef[] {
  const lines = String(markdown || '').replace(/\r/gu, '').split('\n');
  const entities: CaptionEntityRef[] = [];
  let chapterNo = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+(.+?)\s*$/u.exec(lines[index].trim());
    if (heading && !/^(目录|附表)/u.test(heading[1])) {
      const numbered = /^第\s*([一二三四五六七八九十百\d]+)\s*章/u.exec(heading[1]);
      chapterNo = numbered ? chineseNumberToArabic(numbered[1]) : chapterNo + 1;
    }
    const match = CAPTION_ENTITY_RE.exec(lines[index].trim());
    if (!match) continue;
    const name = (match[3] || '').trim();
    if (!captionFollowedByTable(lines, index) && !validCaptionTitle(name)) continue;
    entities.push({ line: index + 1, chapterNo, sequence: Number(match[2]), name });
  }
  return entities;
}

export interface TableNumberingGap {
  chapterNo: number;
  /** 该章内已出现的表序（升序去重） */
  sequences: number[];
  /** 章内缺失的表序（1..max 中未出现者） */
  missing: number[];
  /** 缺号后的首张表所在行（1 基） */
  line: number;
}

/** 章内表号跳号扫描（§L3-2）：章内 `表N-k` 的 k 应自 1 起连续；缺号即编号体系断裂 */
export function scanTableNumberingGaps(markdown: string): TableNumberingGap[] {
  const byChapter = new Map<number, CaptionEntityRef[]>();
  for (const entity of collectCaptionEntities(markdown)) {
    if (entity.chapterNo < 1) continue;
    const list = byChapter.get(entity.chapterNo) || [];
    list.push(entity);
    byChapter.set(entity.chapterNo, list);
  }
  const gaps: TableNumberingGap[] = [];
  for (const [chapterNo, list] of [...byChapter.entries()].sort((left, right) => left[0] - right[0])) {
    const sequences = [...new Set(list.map(entity => entity.sequence))].sort((left, right) => left - right);
    const max = sequences[sequences.length - 1] || 0;
    const missing: number[] = [];
    for (let sequence = 1; sequence <= max; sequence += 1) if (!sequences.includes(sequence)) missing.push(sequence);
    if (missing.length === 0) continue;
    const firstMissingAfter = list.find(entity => entity.sequence > (missing[0] ?? 0)) || list[0];
    gaps.push({ chapterNo, sequences, missing, line: firstMissingAfter.line });
  }
  return gaps;
}

export interface TableNumberingGapIssue {
  level: 'error';
  severity: 'blocker';
  category: 'table';
  owner: 'llm';
  repairability: 'llm_repairable';
  message: string;
  suggestion: string;
}

/** 章内表号跳号判定（§L3-2）：目标稿 0 命中（章内 1..16 / 1..5 / 1..3 连续）。
 *  语料 5 处命中经逐条复核只有 1 处为真（doc15 第 1 章「裸表号 表1/表2/表3 与 表N-k 混用」），
 *  其余 4 处（doc01 ch2 / doc18 ch9 / doc23 ch4+ch9）**全是误报**：这些章的表号实际连续
 *  （表2-1..2-6 / 表9-1..9-3 / 表4-1..4-6 / 表9-1..9-4），只因个别题注被纳入条件
 *  （贴表 || 有效题名）过滤而**漏计**，被算成缺号——如「表9-2 项目经理 → 技术负责人 → …」
 *  （链式表达含顿号且不与表体紧邻）、「表9-3 图 9-1 项目管理机构」（题名夹图号）、
 *  「表4-1 配电箱安装检测配置绝缘电阻测试仪2台、…」（列举式题名）。
 *  即缺号清单受题注实体识别率支配，精度 1/5，不可作为确定性修复输入；
 *  按「零命中不接入」口径只保留实现与单测，不接入终检、不配 fixerDisposition。 */
export function tableNumberingGapIssues(markdown: string): TableNumberingGapIssue[] {
  return scanTableNumberingGaps(markdown).slice(0, 3).map(gap => ({
    level: 'error' as const,
    severity: 'blocker' as const,
    category: 'table' as const,
    owner: 'llm' as const,
    repairability: 'llm_repairable' as const,
    message: `第 ${gap.chapterNo} 章表号跳号：表序 ${gap.sequences.join('、')} 缺 ${gap.missing.join('、')}（首个缺号后首张表见第 ${gap.line} 行）`,
    suggestion: '补齐或重排该章表号使其自 1 起连续（只改编号前缀，不改题名与表体；引用句中的表号同步改写）。',
  }));
}

export interface TableCaptionDefect {
  line: number;
  chapterNo: number;
  /** 题注原文（截断展示用） */
  raw: string;
  /** 残缺类型（机制化判据名，非项目词表） */
  kind: 'empty-title' | 'tree-residue' | 'duplicated-prefix' | 'short-title';
}

/** 表题残缺扫描（§L3-3）：题注实体（贴表/有效题名行）中题名残缺的形态——
 *  无题名 / 含结构树残留符 / 题名重复「表」字 / 题名核心 < 3 汉字（题名核心=去编号前缀与结尾「表」字）。 */
export function scanTableCaptionDefects(markdown: string): TableCaptionDefect[] {
  const defects: TableCaptionDefect[] = [];
  for (const entity of collectCaptionEntities(markdown)) {
    const raw = entity.name;
    const stripped = stripTableNumberPrefix(raw);
    const core = stripped.replace(/[^一-龥]/gu, '');
    if (!stripped) defects.push({ line: entity.line, chapterNo: entity.chapterNo, raw, kind: 'empty-title' });
    else if (CAPTION_TREE_RESIDUE_RE.test(stripped)) defects.push({ line: entity.line, chapterNo: entity.chapterNo, raw, kind: 'tree-residue' });
    else if (/^表/u.test(stripped)) defects.push({ line: entity.line, chapterNo: entity.chapterNo, raw, kind: 'duplicated-prefix' });
    else if (core.length > 0 && core.length < 3) defects.push({ line: entity.line, chapterNo: entity.chapterNo, raw, kind: 'short-title' });
  }
  return defects;
}

export interface TableCaptionDefectIssue {
  level: 'error';
  severity: 'blocker';
  category: 'table';
  owner: 'llm';
  repairability: 'llm_repairable';
  message: string;
  suggestion: string;
}

/** 表题残缺判定（§L3-3）：目标稿 0 命中；全语料 5 命中（doc01，全真：题名重复「表」字
 *  「表1-2 表施工部署关键节点及责任分工表」等 5 张连号表），精度 5/5。
 *  已知漏报：doc01 第 586 行「表2-5 └── 材料员、机械员」（树残留真缺陷）未报——题名含顿号且不与表体
 *  紧邻，被题注实体纳入条件过滤；该漏报是可接受的保守方向（宁漏报不误报）。
 *  题名「句子化」分支（含句末标点/超长整句）实测为正文引用行误报（「表2-3 列要求执行，…。」），
 *  已剔除不出现在本判据中。目标稿零命中，按「零命中不接入」口径只保留实现与单测，不接入终检。 */
export function tableCaptionDefectIssues(markdown: string): TableCaptionDefectIssue[] {
  const labels: Record<TableCaptionDefect['kind'], string> = {
    'empty-title': '题注无题名',
    'tree-residue': '题名混入组织架构树残留符',
    'duplicated-prefix': '题名重复「表」字',
    'short-title': '题名过短（核心不足 3 字）',
  };
  return scanTableCaptionDefects(markdown).slice(0, 5).map(defect => ({
    level: 'error' as const,
    severity: 'blocker' as const,
    category: 'table' as const,
    owner: 'llm' as const,
    repairability: 'llm_repairable' as const,
    message: `表题残缺（第 ${defect.line} 行，${labels[defect.kind]}）：“表${defect.chapterNo}-…”题名为“${defect.raw.slice(0, 40)}”`,
    suggestion: '按表体内容补写题名（保留既有编号，不改表体与数据）；题名须为名词性短语，不含句读、树形符号与重复的「表」字前缀。',
  }));
}

/**
 * r25 B1 表编号唯一化（实机归因：项目基本信息表由终链重建插入（晚于首轮题注注入），链尾重跑
 * 注入给它分配章内序号 1，与首轮已编「表1-1」的正文首表撞号——「表1-1」实体出现 2 次
 * 直坠交付 blocker；重跑注入对已带题注表幂等跳过，冲突无法自愈）。
 * 机制级收口：先拆粘连（splitGluedTableCaptions），再对「含重复编号的章」按题注实体出现顺序
 * 整体重排为「章号-章内序号」，同章被改编号的旧 key → 新 key 映射同步全文引用
 * （按/见/如/参见/详见…表X-Y 与行内残留题注前缀引用）；重复 key 歧义不建映射（引用保持原样，
 * 宁缺毋假）。无重复编号的章与附表区零改动；幂等（重放时旧=新，全静默）。
 * 判据全部为编号/结构形态，与具体项目无关。
 */
/**
 * 4.58 R9-e 连续多题注收敛（实测 `doc-1790168542563-ea526b1b`）。
 *
 * ## 现象
 *
 * ```
 * #### 1.34.5 编制依据
 * 本工程编制依据由…如下表所列。          ← 引导句
 * 表1-34-1 本工程编制依据文件一览表      ← 题注①（模型按小节号 1.34 自编）
 * 表1-3 依据文件一览表                   ← 题注②（模型按文档表序自编）
 * | 类别 | 名称与文号 |                    ← 同一个表格
 * ```
 *
 * ## 为什么注入器的幂等检查拦不住
 *
 * `injectTableCaptions` 的幂等判据是「表题行已带题注前缀 → 跳过注入」，而题注①②**都**带前缀，
 * 于是注入器判定"该表已有题注"而跳过——**双题注原样进交付物**。这不是注入器失效，
 * 而是"题注编号由模型决定"这一前提本身不成立：**编号是机械信息，不该由模型生成**。
 *
 * ## 口径
 *
 * 紧邻**同一张表**的连续题注行只保留**第一行**（其题名余文保留），其余删除；
 * 编号随后由 `normalizeTableNumbering` 按当前表序统一重排——模型写下的编号一律不作数。
 *
 * 为何只删多余行而保留第一行的题名：题名是语义信息（可能比后续行更完整），
 * 编号是机械信息；分离二者，各归其位。
 *
 * 安全性：连续 ≥2 行题注只可能出现在"同一张表被写了多个题注"的场景——两张不同的表之间
 * 必然隔着表体（`|` 行），构不成连续。故本判据不会误删不同表的题注。
 */
export function collapseDuplicateTableCaptions(markdown: string): string {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const dropped = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!isTableCaptionLine(lines[index] || '')) continue;
    // 收集从 index 起的连续题注行
    let end = index;
    while (end + 1 < lines.length && isTableCaptionLine(lines[end + 1] || '')) end += 1;
    if (end === index) continue;
    // 该批题注之后（跳过空行）必须是表格，否则不属"同一张表的多个题注"，原样保留
    let probe = end + 1;
    while (probe < lines.length && (lines[probe] || '').trim() === '') probe += 1;
    if (!/^\s*\|/u.test(lines[probe] || '')) { index = end; continue; }
    for (let drop = index + 1; drop <= end; drop += 1) dropped.add(drop);
    index = end;
  }
  if (dropped.size === 0) return markdown;
  return lines.filter((_, index) => !dropped.has(index)).join('\n');
}

/**
 * 4.58 R9-e 脱位题注归位（实测 `doc-1790168542563-ea526b1b` 行266→269）。
 *
 * ## 现象
 *
 * ```
 * 表1-2 可追溯的安装台账                    ← 题注
 * 抗震支吊架安装完成后，由质检员…销项；      ← 模型继续写正文，把题注与表隔开
 *
 * | 工序节点 | 前置条件 | … |                ← 表格（因此无题注）
 * ```
 *
 * 实测该文档 4 张无题注表格中，1 张属此形态（题注存在但与表格脱离，被终检判「缺少题注编号」）。
 *
 * ## 口径
 *
 * 题注行与其后**近距离**出现的表格之间若隔着**正文行**（≤2 行非空内容），把**题注下移到紧邻表格**
 * （正文行保持原位）——题注属于表格，正文属于上下文，各归其位。
 *
 * 保守边界：只下移，不删除；间隔超过 2 行非空内容即视为"该题注属别处"，不作处理。
 * 为何不下移表格：移动表体会影响正文引用位置与前后语义衔接，风险高于收益。
 */
const DETACHED_CAPTION_MAX_GAP_LINES = 2;

/**
 * 题注行判据（**多段编号**，R9-e 专用）。
 *
 * 为何不直接复用 `TABLE_CAPTION_PREFIX_RE`：后者以 `\s`（恰好一个空白）收尾，
 * 且编号只允许一段破折号——实测模型写下的 `表1-34-1 本工程编制依据文件一览表`
 *（按小节号 `1.34` 自编 + 表序）在它下面**不匹配**（`表1-34` 之后跟的是 `-` 不是空白），
 * `MALFORMED_CAPTION_PREFIX_RE` 也不匹配（该判据要求破折号后为**非数字**，而这里是 `3`）。
 * 两条判据的盲区叠加，使这类题注既不被认作题注、也不被认作残缺编号。
 *
 * 为何不直接放宽 `TABLE_CAPTION_PREFIX_RE`：它是**注入器的幂等判据**，
 * 放宽会改变"是否跳过注入"的行为，波及面远大于本处所需。故 R9-e 用独立判据，
 * 只服务于收敛与归位两个动作（语义是"这一行看起来是题注"）。
 *
 * 4.59 R-B3：本串同时是**剥离器**（stripModelAuthoredCaptionNumbers）的判据来源——剥离只针对
 * 被本判据认作题注的行。两处（判定与剥离）共用同一份编号头串＝同一份"什么算题注编号"的口径；
 * 与窄口径变体之间只共享字符类碎片（TABLE_CAPTION_DIGITS / TABLE_CAPTION_TAIL_PUNCT），
 * 两个变体的差异（破折号段数、尾部空白）各有实测理由，见各处注释。
 */
const TABLE_CAPTION_NUMBER_HEAD_SOURCE = `表\\s*${TABLE_CAPTION_DIGITS}(?:\\s*[-－.．—]\\s*${TABLE_CAPTION_DIGITS})*\\s*${TABLE_CAPTION_TAIL_PUNCT}\\s*`;

/** 题注行判据（R9-e 专用；见上方注释）：编号头 + 表名首字 */
const TABLE_CAPTION_LINE_RE = new RegExp(`^${TABLE_CAPTION_NUMBER_HEAD_SOURCE}\\S`, 'u');

/**
 * 题注行判定（R9-e 专用；见 TABLE_CAPTION_LINE_RE 注释）。
 * 4.59 R-B3：本函数同时是剥离器（stripModelAuthoredCaptionNumbers）的判据来源——**剥离器只剥离
 * 被本判据认作题注的行**，两处共用同一份编号头串（TABLE_CAPTION_NUMBER_HEAD_SOURCE），不另造第二份
 * 「什么算题注编号」的口径（判据单源）。
 */
export function isTableCaptionLine(line: string): boolean {
  return TABLE_CAPTION_LINE_RE.test((line || '').trim());
}

/** 4.59 R-B3：题注编号头剥离（与 isTableCaptionLine 同源；仅用于剥离器内部与判据自检测试） */
export const TABLE_CAPTION_NUMBER_HEAD_RE = new RegExp(`^${TABLE_CAPTION_NUMBER_HEAD_SOURCE}`, 'u');

export function relocateDetachedTableCaptions(markdown: string): string {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const moves: Array<{ from: number; to: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isTableCaptionLine(lines[index] || '')) continue;
    // 向上/向下探：本行之后应紧跟表格才算"已就位"；否则在窗口内找表格
    let probe = index + 1;
    let intervening = 0;
    let tableAt = -1;
    while (probe < lines.length) {
      const text = (lines[probe] || '').trim();
      if (text === '') { probe += 1; continue; }
      if (/^\s*\|/u.test(lines[probe] || '')) { tableAt = probe; break; }
      if (/^#{1,6}\s/u.test(text) || isTableCaptionLine(text)) break;
      intervening += 1;
      if (intervening > DETACHED_CAPTION_MAX_GAP_LINES) break;
      probe += 1;
    }
    if (tableAt < 0 || intervening === 0) continue;
    moves.push({ from: index, to: tableAt });
  }
  if (moves.length === 0) return markdown;
  // 自下而上处理，避免行号漂移
  const byFrom = new Map(moves.map(move => [move.from, move.to]));
  const removed = new Set(moves.map(move => move.from));
  // 题注必须落在**表格行之前**（insertBefore），不是之后——否则题注会跑到表体下面（首版实测踩过）
  const insertBefore = new Map<number, string[]>();
  for (const move of moves) {
    const list = insertBefore.get(move.to) || [];
    list.push(lines[move.from] || '');
    insertBefore.set(move.to, list);
  }
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const pending = insertBefore.get(index);
    if (pending) output.push(...pending);
    if (!removed.has(index)) output.push(lines[index]);
  }
  return output.join('\n');
}

/**
 * 4.59 R-B3 第二半：**模型自写题注编号的确定性剥离**（链尾一半；写作期一半在章任务卡的同名声明，
 * 见 TABLE_CAPTION_MECHANICAL_RULE）。
 *
 * ## 为什么光靠"收敛/归位/单一入口"不够（4.58 R9-e 之后仍复现的实测根因）
 *
 * R9-e 做的是**在模型写下的编号之上**收敛与重排；编号的**所有权仍在模型手里**，于是：
 * - 实测形态（4.59 交付物，编制依据章）：模型按**小节号**写 `表1-34-1 本工程编制依据文件一览表`，
 *   又按**文档表序**写 `表1-3 本工程编制依据文件一览表`，两行连续；
 * - `collapseDuplicateTableCaptions` 收敛掉第二行（表名同），保留 `表1-34-1 …`；
 * - 注入器的幂等判据 `TABLE_CAPTION_PREFIX_RE`（编号须以数字收尾）与残缺判据
 *   `MALFORMED_CAPTION_PREFIX_RE`（破折号后须为非数字）对 `表1-34-1` **两条都不匹配**，
 *   于是注入器把它当"无题注表"再叠一层 → `表1-3 表1-34-1 本工程编制依据文件一览表`。
 *   双编号从「两行」变成「一行内两段」，机械编号仍然不成立。
 * 结论：只要模型写下的编号能被原样保留，"机械生成"就永远是尽力而为——必须**剥离**，
 * 让注入器按章内表序重新分配（编号单点所有权）。
 *
 * ## 判据（三重门，缺一不可——防"剥了但没被重新认领"造成题注丢失）
 *
 * ① 整行是题注行（`isTableCaptionLine`，与 R9-e 同一份编号头串，判据单源）；
 * ② 该行**紧邻表格**（`captionFollowedByTable`）：只有紧邻才保证剥离后注入器必然重新认领
 *    （probe 上溯 ≤8 行、剥编号后余文 ≤40 字 → kind='line'，题名摘要见 probeTableBlock）。
 *    悬挂题注（题名合法、表在 2 行正文之外）**不剥**：剥离它只会把题注变成一句游离正文，
 *    而它由 relocateDetachedTableCaptions / 终检「题注悬空」族负责，不归本函数；
 * ③ 剥离后余文本身是合法题名（`validCaptionTitle`：长度/尾词/字符集/无句读）：防剥出空行或半截句，
 *    同时保证 ② 的"重新认领"成立（kind='line' 的判据正是一个合法题名行）。
 *
 * ## 口径边界（有意如此，均为实测形态）
 *
 * - **对所有模型题注一视同仁**（含"编号写对"的）：编号所有权必须单点，否则"对的保留、错的剥离"
 *   本身就是第二套编号口径。代价是正常章（模型按 1..N 顺序写对）也要重排一次——`normalizeTableNumbering`
 *   按章内表序重排后结果与原编号一致（同一章同序），不产生内容差。
 * - 只处理**正文区**：附表区（`## 附表N`）不碰——附表编号体系独立，与 `normalizeTableNumbering`
 *   同一段边界口径。
 * - 剥离**编号头**而非整行：重复叠加的编号头（模型写 `表1-3 表1-34-1 表名`）循环剥离至无编号头
 *   （上限 3 轮，防病态输入）。
 * - 残余边界：正文里的**行内引用**（"见表1-3 所列"）不动——剥了会让引用指向失效；重排后引用与题注
 *   可能不齐（模型引用口径本身就没有可判据的基准），不在本函数取值范围内。
 *
 * 返回剥离计数：调用方（finalizeTableCaptions）据此留下可见记录（零静默降级）。
 */
export function stripModelAuthoredCaptionNumbers(markdown: string): { markdown: string; stripped: number } {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const appendixIndex = lines.findIndex(line => /^##\s+附表\s*[一二三四五六七八九十\d]{1,3}/u.test(line));
  const bodyEnd = appendixIndex >= 0 ? appendixIndex : lines.length;
  let stripped = 0;
  for (let index = 0; index < bodyEnd; index += 1) {
    const line = lines[index] || '';
    if (!isTableCaptionLine(line)) continue;
    if (!captionFollowedByTable(lines, index)) continue;
    let name = line.trim();
    for (let round = 0; round < 3 && TABLE_CAPTION_NUMBER_HEAD_RE.test(name); round += 1) {
      name = name.replace(TABLE_CAPTION_NUMBER_HEAD_RE, '').trim();
    }
    if (!validCaptionTitle(name)) continue;
    lines[index] = name;
    stripped += 1;
  }
  if (stripped === 0) return { markdown, stripped };
  return { markdown: lines.join('\n'), stripped };
}

/**
 * 写作期任务卡里的题注声明（4.59 R-B3 前半，**单一出处**：章任务卡引用本常量，不另抄一份文本）。
 *
 * 为什么要写进任务卡：链尾剥离是**确定性兜底**，但模型每写一次编号就多一次"编号与最终表序不齐"
 * 的机会（重排后正文引用可能对不上）；写作期不写编号能从源头消除该形态。
 * 为什么只声明"题注行"、不要求模型改正文引用：模型无法预知最终编号（机械编号按章内表序分配），
 * 要求它写引用编号只会制造新的不一致——引用一律用表名（见条文）。
 */
export const TABLE_CAPTION_MECHANICAL_RULE = '表格题注（表名行）不要写「表X-Y」编号前缀，只写表名本身（如「主要施工机械设备配置表」）——题注编号由系统在成稿后按章内表序机械生成；正文引用表时用表名指代（如「见主要施工机械设备配置表」），不要写编号。';

/**
 * 表格题注收口**单一入口**（4.58 R9-e）。
 *
 * 题注链此前在 4 处各自拼 `normalizeTableNumbering(injectTableCaptions(x))`——拼接方式一致但
 * **没有任何机制保证后续新增步骤被各处同步**（本仓反复出现的"判据分裂"形态）。
 * 收敛为单一入口后，新增/调整步骤只需改这一处。
 */
export function finalizeTableCaptions(markdown: string): string {
  // 顺序有意（4.59 R-B3 在 ②-c 与 ③ 之间插入剥离，位置不可挪）：
  // ① 先归位脱位题注（让它们回到表格上方，注入器/剥离器才能认出"这是一条题注"）；
  // ②-a 收敛连续多题注（去重）——**必须在剥离之前**：此时模型编号还在，isTableCaptionLine 才认得出
  //    那一行是题注（实测 `表1-34-1 本工程编制依据文件一览表` 只被该判据认出）；
  // ②-b 粘连拆分 + 回指续文回位**提前到剥离之前**（4.59 幂等修正）：这两步原是 normalizeTableNumbering
  //    的第一步（在注入之后），于是「表1-3 劳动力投入计划表上述措施…」这类粘连题注在**第一遍**
  //    既不满足剥离的"残留即合法题名"判据（残留含句读）、也不满足注入器的幂等跳过条件以外的路径，
  //    模型编号被原样保留；而第二遍（题注已被拆干净）剥离才开始生效 → 同一份 markdown 两遍产出不同编号
  //    （实测：第一遍 表1-3 → 第二遍 表1-1）。把拆分提前，剥离在**同一遍内**就看得到干净题注行，
  //    编号所有权从此是单点的、且逐遍一致（幂等）。两步本身幂等（normalizeTableNumbering 内再跑一次不变）。
  // ③ 剥离模型自写编号（R-B3）：让下一步的注入器按章内表序重新分配编号（编号单点所有权）；
  // ④ 注入缺失的题注；⑤ 统一重排编号（含粘连拆分/重复编号归并，与 ②-b 同源调用）。
  const relocated = relocateDetachedTableCaptions(markdown);
  const deduped = collapseDuplicateTableCaptions(relocated);
  const splitCaptions = relocateCaptionFollowUps(splitGluedTableCaptions(deduped));
  const { markdown: strippedMarkdown, stripped } = stripModelAuthoredCaptionNumbers(splitCaptions);
  if (stripped > 0) {
    // 零静默降级：题注编号被改写属内容面变换，必须留可见记录（含实测依据编号，便于回查交付物）
    console.warn(`[table-caption] 4.59 R-B3 剥离模型自写题注编号 ${stripped} 处（编号改由注入器按章内表序机械分配）`);
  }
  return normalizeTableNumbering(injectTableCaptions(strippedMarkdown));
}

export function normalizeTableNumbering(markdown: string): string {
  const split = relocateCaptionFollowUps(splitGluedTableCaptions(markdown));
  const lines = split.replace(/\r/gu, '').split('\n');
  const appendixIndex = lines.findIndex(line => /^##\s+附表\s*[一二三四五六七八九十\d]{1,3}/u.test(line));
  const bodyEnd = appendixIndex >= 0 ? appendixIndex : lines.length;
  interface CaptionEntity { index: number; chapterNo: number; oldKey: string; name: string }
  const entities: CaptionEntity[] = [];
  let chapterNo = 0;
  for (let index = 0; index < bodyEnd; index += 1) {
    const heading = /^##\s+(.+?)\s*$/u.exec(lines[index]);
    if (heading && !/^(目录|附表)/u.test(heading[1])) {
      const numbered = /^第\s*([一二三四五六七八九十百\d]+)\s*章/u.exec(heading[1]);
      chapterNo = numbered ? chineseNumberToArabic(numbered[1]) : chapterNo + 1;
    }
    if (chapterNo < 1) continue;
    const row = (lines[index] || '').trim();
    const match = /^表\s*(\d+(?:[-—–－]\d+)?)\s+(\S.*)$/u.exec(row);
    if (!match) continue;
    const name = match[2].trim();
    // 实体纳入：贴表题注（与终检实体判据同口径：下一非空行即表格行）+ 有效题名独立行
    // （无表跟随的题注样行——表格被合并删除等残留——仍纳入章内序参与唯一化，防悬挂编号与他人撞号；
    // 引用句/叙述句（含句读、超长、无名词尾）不纳入）
    if (!captionFollowedByTable(lines, index) && !validCaptionTitle(name)) continue;
    entities.push({ index, chapterNo, oldKey: normalizeCaptionKey(match[1]), name });
  }
  const byKey = new Map<string, CaptionEntity[]>();
  for (const entity of entities) {
    const list = byKey.get(entity.oldKey) ?? [];
    list.push(entity);
    byKey.set(entity.oldKey, list);
  }
  const duplicateChapters = new Set<number>();
  const ambiguousKeys = new Set<string>();
  for (const [key, list] of byKey) {
    if (list.length <= 1) continue;
    ambiguousKeys.add(key);
    for (const entity of list) duplicateChapters.add(entity.chapterNo);
  }
  if (duplicateChapters.size === 0) return split;
  const rewriteByIndex = new Map<number, string>();
  const referenceMap = new Map<string, string>();
  for (const chapter of duplicateChapters) {
    const list = entities.filter(entity => entity.chapterNo === chapter).sort((left, right) => left.index - right.index);
    list.forEach((entity, order) => {
      const newKey = `${chapter}-${order + 1}`;
      if (newKey !== entity.oldKey) {
        rewriteByIndex.set(entity.index, `表${newKey} ${entity.name}`);
        if (!ambiguousKeys.has(entity.oldKey)) referenceMap.set(entity.oldKey, newKey);
      }
    });
  }
  if (rewriteByIndex.size === 0 && referenceMap.size === 0) return split;
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rewrite = rewriteByIndex.get(index);
    if (rewrite) {
      output.push(rewrite);
      continue;
    }
    if (index >= bodyEnd || referenceMap.size === 0) {
      output.push(lines[index]);
      continue;
    }
    // 引用同步：单遍扫描（题注行已重写不入此径）；附表引用「附表N」由前置负后顾排除；
    // 「表1份/表2个」量词形态跳过（无子号编号后紧跟量词即非表格引用）
    output.push((lines[index] || '').replace(/(?<!附)表\s*(\d+(?:[-—–－]\d+)?)\s*(?![份个张条页行列项次台套人天年月日])/gu, (full, raw: string) => {
      const mapped = referenceMap.get(normalizeCaptionKey(raw));
      return mapped ? `表${mapped}` : full;
    }));
  }
  return output.join('\n');
}


/** 表名基础形：normalize + 去括号注释 + 去尾部“表” */
function tableTitlePlain(title: string) {
  return normalizeText(title).replace(/[（(][^）)]*[）)]/gu, '').replace(/表$/u, '');
}

/** 表名核心词：基础形再去通用修饰词，比对“劳动力配置汇总表 ↔ 分阶段劳动力投入表”类语义骨架漂移 */
function tableTitleCore(title: string) {
  return tableTitlePlain(title).replace(TABLE_TITLE_MODIFIER_PATTERN, '');
}

/** 表头字段覆盖率：规划表头与实际表头单元格的双向包含命中率 */
function fieldCoverage(fields: PlannedTablePlan['fields'], headerCells: string[]) {
  if (fields.length === 0 || headerCells.length === 0) return 0;
  const cells = headerCells.map(cell => normalizeText(cell)).filter(Boolean);
  if (cells.length === 0) return 0;
  let hit = 0;
  for (const field of fields) {
    const name = normalizeText(field.name).replace(/[（(][^）)]*[）)]?/gu, '');
    if (!name) continue;
    if (cells.some(cell => cell.includes(name) || name.includes(cell))) hit += 1;
  }
  return hit / fields.length;
}

/** 单表匹配分：完整标题/核心词/字段三通道取最高（0 = 未承接） */
function tablePlanMatchScore(plan: PlannedTablePlan, candidate: MarkdownTableCandidate) {
  const plainTitle = tableTitlePlain(plan.title);
  const coreTitle = tableTitleCore(plan.title);
  if (plainTitle && bigramOverlap(plainTitle, candidate.title) >= TABLE_MATCH_TITLE_OVERLAP) return TABLE_MATCH_SCORE_TITLE;
  if (coreTitle && bigramOverlap(coreTitle, candidate.title) >= TABLE_MATCH_CORE_OVERLAP) return TABLE_MATCH_SCORE_CORE;
  if (fieldCoverage(plan.fields, candidate.headerCells) >= TABLE_MATCH_FIELD_COVERAGE) return TABLE_MATCH_SCORE_FIELD;
  return 0;
}

/** 逐表对账：规划表逐张与正文实际表格题名/表头匹配（一对一贪心分配，防一张实际表承接多张计划表），返回未承接的计划表 */
export function matchMissingTablePlans(plans: PlannedTablePlan[], markdown: string): PlannedTablePlan[] {
  if (plans.length === 0) return [];
  const candidates = extractMarkdownTableCandidates(markdown);
  if (candidates.length === 0) return [...plans];
  const pairs: Array<{ plan: PlannedTablePlan; index: number; score: number }> = [];
  plans.forEach(plan => {
    candidates.forEach((candidate, index) => {
      const score = tablePlanMatchScore(plan, candidate);
      if (score > 0) pairs.push({ plan, index, score });
    });
  });
  pairs.sort((left, right) => right.score - left.score);
  const assignedPlans = new Set<string>();
  const usedCandidates = new Set<number>();
  for (const pair of pairs) {
    if (assignedPlans.has(pair.plan.id) || usedCandidates.has(pair.index)) continue;
    assignedPlans.add(pair.plan.id);
    usedCandidates.add(pair.index);
  }
  return plans.filter(plan => !assignedPlans.has(plan.id));
}

export interface TablePlanExecutionGap {
  chapterTitle: string;
  /** 本章计划表总数（展示用） */
  planned: number;
  /** 本章实际 markdown 表格总数（展示用；含未题名表格） */
  actual: number;
  /** 逐表对账后未在正文中承接的计划表（定向补表依据；旧版为章全部计划，R20 起为缺失表） */
  plans: PlannedTablePlan[];
}

/** 表格执行率确定性核验（R20 逐表对账）：规划应输出的表格逐张与正文实际表格题名/表头对账（一对一），未承接即缺口。
 * 替代旧数量口径（“≥60% 且缺≥2 张才报”）——旧口径丢 1 张表永远漏网；
 * 对账匹配器为通用三通道（完整标题/核心词滑窗重叠、表头字段覆盖），仅凭文本判据，无项目/表名硬编码。 */
export function tablePlanExecutionGaps(chapters: DocumentTemplateChapter[], drafts: Array<{ title: string; content: string; sections?: string[] }>): TablePlanExecutionGap[] {
  const gaps: TablePlanExecutionGap[] = [];
  for (const chapter of chapters) {
    const plans = chapter.tablePlans || [];
    if (plans.length === 0) continue;
    const draft = drafts.find(item => item.title === chapter.title) || drafts.find(item => chapter.title.includes(item.title) || item.title.includes(chapter.title));
    if (!draft) continue;
    const missingPlans = matchMissingTablePlans(plans, draft.content);
    if (missingPlans.length === 0) continue;
    gaps.push({ chapterTitle: chapter.title, planned: plans.length, actual: markdownTableCount(draft.content), plans: missingPlans });
  }
  return gaps;
}

/** 表格排版与字段填写约束（章级/小节级 prompt 共用） */
const TABLE_FORMAT_RULES = [
  // 4.44 门禁链源头根治：表题独立成行硬约束（4.43 实测 Writer 把表名并入表头首格顶替首列名，
  // 触发终检 table-title-in-header 阻断；写时归一是安全网，指令层同源消灭该形态）
  '【表格排版硬约束】每个表格的表名必须独立成行写在表格上方（表题，如“劳动力动态投入计划表”单独一行），不得并入表头首格、不得顶替首列名；表头行必须以“|”开头单独占一行，下一行紧跟“|---|”分隔行，数据行逐行以“|”开头；严禁把表头接在正文段落同一行（如“正文……。| 表头1 | 表头2 |”），输出表格前必须先换行。',
  '每个表格前必须写 1～2 句引导叙述（说明该表的作用、数据口径与关键结论），表格不能替代所在小节全部正文；表格输出后还应围绕表中关键节点、责任分工与纠偏措施展开至少一段实施性正文。',
  '只输出表格/清单本体和用户提示词明确要求的文字；不得输出系统来源说明、后台溯源列、固定表前后说明或占位话术。',
  '【字段填写约束】项目特有数字、日期、工程量、规格必须来自项目资料或项目图谱，不得编造；人数、台班、进度时间等计划类数值必须原样引用蓝图权威锚点（劳动力峰值、工种构成、分阶段投入、机械台数、总工期节点），不得基于工程量或定额自行推算另设，不得留空、不得写“按需配置”“根据进度灵活调配”等空话。',
  // 4.55.16 空话单元格扩围（巢湖实测：工程量列 6 格全写「按清单工程量」，而同段正文已有 12792.800m3）：
  // 「按X」式搪塞在表格里等价于留空——字段名承诺的是数据，不是免责声明
  '【空话禁令】下列写法在表格单元格中一律禁止（视同留空，终检阻断）：“按清单工程量”“按设计标高/按图纸/按设计”“按规范”“按方案”“符合设计要求/规范要求”“根据现场情况”“相关人员及时处理”“加强管理”“严格控制”。工程量列必须写**清单原值（数值+单位）**（如 12792.800m3、1200m2），规格/净距列必须写**图纸或清单给出的具体数值**；资料未给出该字段值的，写具体来源与判定依据（如“按施工图结施-03 基础平面图”），不得用“按……”搪塞。',
];

function tablePlanLines(plan: PlannedTablePlan, index: number) {
  return [
    `${index + 1}. ${plan.required ? '必写' : '应写'}：${plan.title}`,
    plan.fields.length ? `   - 表头必须为：${plan.fields.map(field => field.name).join(' | ')}（不得擅自改字段、删字段或增加后台溯源列）` : '',
    plan.section ? `   - 归属小节：${plan.section}` : '',
    `   - 来源：${plan.reason}`,
  ].filter(Boolean).join('\n');
}

export function tablePlansPrompt(chapter: DocumentTemplateChapter) {
  const plans = chapter.tablePlans || [];
  if (plans.length === 0) return '';
  return [
    '【本章表格/清单结构化生成要求（硬性验收项）】',
    '以下表格来自用户提示词声明与本章小节规划，不得按数量机械增减；每个应输出的表格都必须真实输出为 markdown 表格；输出后按本清单逐表自检，缺失即视为正文不足。',
    ...TABLE_FORMAT_RULES,
    ...plans.map((plan, index) => tablePlanLines(plan, index)),
  ].filter(Boolean).join('\n');
}

/** R20 C1 图类呈现元件（招标要求条目识别的「图/框图」元件 → 正文承载映射；产品级通用图类词表，与具体项目无关） */
export interface DiagramArtifactRequirement {
  /** 元件名（图类名词，如「横道图」「网络图」） */
  name: string;
  /** 承载指令（转为正文可执行的文字框图/时间轴表格呈现形式） */
  instruction: string;
  /** 来源要求原文（写作注入时作证据展示，人工可溯） */
  source: string;
}

/** 图类元件识别词表与承载映射（识别词 → 正文呈现形式指令）：明标不产正式图件，图类元件以文字框图/时间轴表在正文承载 */
const DIAGRAM_ARTIFACT_RULES: Array<{ pattern: RegExp; instruction: string }> = [
  { pattern: /横道图|甘特图/u, instruction: '以表格式时间轴呈现（阶段与节点、起止时间、与工期目标的关系）；表中时间节点必须与总工期及开工竣工日期一致' },
  { pattern: /网络图|关键线路/u, instruction: '以文字框图呈现（工作节点、先后衔接关系、关键线路标注），节点划分必须与本工程施工组织一致' },
  { pattern: /组织机构图|组织框图|机构框图|机构图/u, instruction: '以文字框图呈现组织机构层级（部门或岗位、隶属关系）' },
  { pattern: /平面布置图|布置图/u, instruction: '以分区布置的文字框图或布置要点表呈现（分区、布置内容、管控要求）' },
  { pattern: /流程图|工艺流程图/u, instruction: '以文字框图呈现流程步骤与衔接关系' },
];

/** 图类呈现元件提取：扫描要求条目（要求正文与核心词双通道），同名元件去重保留首次命中 */
export function extractDiagramArtifacts(entries: Array<{ text: string; coreTerms: string[] }>): DiagramArtifactRequirement[] {
  const results: DiagramArtifactRequirement[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const haystack = `${entry.text}\n${entry.coreTerms.join(' ')}`;
    for (const rule of DIAGRAM_ARTIFACT_RULES) {
      const match = rule.pattern.exec(haystack);
      if (!match || seen.has(match[0])) continue;
      seen.add(match[0]);
      results.push({ name: match[0], instruction: rule.instruction, source: entry.text });
    }
  }
  return results;
}

/** 图类元件语义归属：逐元件路由到最相似章节（低于阈值不注入防错挂，未归属显性返回供进度展示） */
export function attachDiagramArtifacts(
  chapters: DocumentTemplateChapter[],
  artifacts: DiagramArtifactRequirement[],
  similarity: (source: string, chapterTitle: string) => number,
  threshold = 0.45,
): { chapters: DocumentTemplateChapter[]; unattached: DiagramArtifactRequirement[] } {
  if (artifacts.length === 0 || chapters.length === 0) return { chapters, unattached: [] };
  const additions = new Map<number, string[]>();
  const unattached: DiagramArtifactRequirement[] = [];
  for (const artifact of artifacts) {
    let bestIndex = -1;
    let bestScore = 0;
    chapters.forEach((chapter, index) => {
      const score = similarity(artifact.source, chapter.title);
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    });
    if (bestIndex < 0 || bestScore < threshold) { unattached.push(artifact); continue; }
    const lines = additions.get(bestIndex) || [];
    lines.push(`「${artifact.name}」${artifact.instruction}（招标要求原文：「${artifact.source.length > 80 ? `${artifact.source.slice(0, 80)}…` : artifact.source}」）`);
    additions.set(bestIndex, lines);
  }
  const nextChapters = chapters.map((chapter, index) => {
    const lines = additions.get(index);
    if (!lines?.length) return chapter;
    return { ...chapter, diagramRequirements: unique([...(chapter.diagramRequirements || []), ...lines]) };
  });
  return { chapters: nextChapters, unattached };
}

/** 章级图类呈现指令（Writer prompt 片段）：与表格计划指令并列注入；正文禁表口径（显式禁表句）由调用方短路（图类归文末附表区）。
 * B-T1：图类内容以文字框图/表格式时间轴承载（内容承载），内容结束处输出规范图题行（形态声明，图名即要素名）；
 * 图题行独立成行、不附加说明文字；禁止任何内部话术（不得出现「由编制人绘制后附」类说明）。 */
export function diagramRequirementsPrompt(chapter: DocumentTemplateChapter) {
  const items = chapter.diagramRequirements || [];
  if (items.length === 0) return '';
  return [
    '【本章图表化呈现要求（硬性验收项）】',
    '以下要素必须以 Markdown 数据表（表头字段 + 数据行，数据取自资料，禁止编造）或结构化的「文字框图」「表格式时间轴」在正文中实际呈现（≥3 行要点）；每项呈现内容结束处另起一行输出规范图题行（格式「图 X-X 图名」，X-X 为章序号与本章图序号，图名即要素名），图题行独立成行、不附加任何说明文字；不得引用未在正文出现的其他图号，不得编造图中数据；**只输出图题行而无数据表/框图内容视为该项未落实**：',
    ...items.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n');
}

// ═══════════════ B-T1 图位/图题机制（内容承载 + 形态声明并列：文字框图/时间轴=内容，图题行=形象声明） ═══════════════

/** 图题行（带编号「图 X-X 图名」；编号 key 归一与表题同口径 normalizeCaptionKey） */
const FIGURE_CAPTION_NUMBERED_RE = /^图\s*(\d+(?:[-—–－]\d+)?)\s+(\S.*)$/u;
/** 图题行（无编号「图 图名」，补位链产物形态；编号由 normalizeFigureNumbering 统一分配） */
const FIGURE_CAPTION_BARE_RE = /^图\s+(\S.*)$/u;
/** 图题名尾词（图类命名构成词，产品级通用词表）：规范图位须以图类名词落定 */
const FIGURE_NAME_TAIL_RE = /(图|图表)$/u;
/** 图名构成词尾白名单（C2 归一化）：尾词未落「图」的工程图类构成词——仅此类补「图」，
 * 防正文引用句（「…中所示内容」类）被误改成图题（宁缺不假） */
const FIGURE_NAME_COMPOSITE_TAIL_RE = /(计划|机构|布置|流程|示意|系统|架构|组织|网络|横道|曲线|关系|框图|简图|大样|剖面|平面|立面|结构|工艺|路线|流向|时序|方案|安排)$/u;
/** 图题名样开头排除（引用/叙述句，防正文句子被当图题）：宽松扫描口径 */
const FIGURE_NAME_LIKE_EXCLUDE_RE = /^(?:所示|如下|见|参见|详见|如|按|为|其中|内|上|下)/u;

/** C2 图名归一化（规格汇集与注入双口径统一）：尾词未落「图」的工程图类构成名补「图」
 * （「施工进度计划」→「施工进度计划图」「项目管理机构」→「项目管理机构图」）；
 * 已带图类尾词或非构成词尾原样返回（不猜不造） */
export function normalizeFigureSpecName(rawName: string): string {
  const name = (rawName || '').trim();
  if (!name) return name;
  if (FIGURE_NAME_TAIL_RE.test(name)) return name;
  if (FIGURE_NAME_COMPOSITE_TAIL_RE.test(name)) return `${name}图`;
  return name;
}

/** 图题名合法性（编号分配口径，宁漏不误）：剥括号注释后 2~36 字、图类尾词落定、无句读空白 */
function validFigureCaptionName(name: string): boolean {
  const bare = name.replace(/[（(][^）)]*[）)]/gu, '').trim();
  if (bare.length < 2 || bare.length > 36) return false;
  if (!FIGURE_NAME_TAIL_RE.test(bare)) return false;
  if (/[。；！？，,.;!?：:]/u.test(name)) return false;
  return /^[\u4e00-\u9fa5A-Za-z0-9（）()、与及\-—－]+$/u.test(name);
}

/** 图题名样判据（防重复注入的宽松扫描口径）：2~36 字无句读、非引用/叙述句开头；
 * 与编号分配判据分离——宽松防漏（已有图题不再补位）、严格防误（正文叙述句不被编号） */
function figureCaptionNameLike(name: string): boolean {
  if (name.length < 2 || name.length > 36) return false;
  if (/[。；！？，,.;!?：:]/u.test(name)) return false;
  return !FIGURE_NAME_LIKE_EXCLUDE_RE.test(name);
}

/** 图题行所属章（行号 → 最近的上文 H2 标题文本；用于同章同源去重的章键） */
function figureChapterOf(lines: string[], index: number): string {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const heading = /^##\s+(.+?)\s*$/u.exec((lines[cursor] || '').trim());
    if (heading) return heading[1]!;
  }
  return '';
}

/** 图名核心词键（同图判定）：「横道图」↔「施工进度横道图」同图——去括号注释与图类尾词后比对 */
function figureNameKey(name: string): string {
  return normalizeText(name).replace(/[（(][^）)]*[）)]/gu, '').replace(/[图表]+$/u, '');
}

/** 同图判定（核心词互相包含）：补位防重复/覆盖对账共用 */
function figureNamesMatch(left: string, right: string): boolean {
  const a = figureNameKey(left);
  const b = figureNameKey(right);
  if (a.length < 2 || b.length < 2) return false;
  return a.includes(b) || b.includes(a);
}

/** 正文口径边界行号（文末附表区起点；-1 无）：图题链与题注链共用口径 */
function figureBodyEndIndex(lines: string[]): number {
  const appendixIndex = lines.findIndex(line => /^##\s+附表\s*[一二三四五六七八九十\d]{1,3}/u.test(line));
  return appendixIndex >= 0 ? appendixIndex : lines.length;
}

/** 正文区行→章号扫描（与 injectTableCaptions/normalizeTableNumbering 同口径单源）：
 * 「第X章」解析优先、无编号标题按出现顺序递增；目录/附表标题不计章 */
function scanFigureChapterNumbers(lines: string[], bodyEnd: number): number[] {
  const chapterByLine = new Array<number>(lines.length).fill(0);
  let chapterNo = 0;
  for (let index = 0; index < bodyEnd; index += 1) {
    const heading = /^##\s+(.+?)\s*$/u.exec(lines[index]);
    if (heading && !/^(目录|附表)/u.test(heading[1])) {
      const numbered = /^第\s*([一二三四五六七八九十百\d]+)\s*章/u.exec(heading[1]);
      chapterNo = numbered ? chineseNumberToArabic(numbered[1]) : chapterNo + 1;
    }
    chapterByLine[index] = chapterNo;
  }
  return chapterByLine;
}

/** 单行图题探针（严格口径）：返回图名与旧编号 key（无编号=空串）；非规范图题行返 null */
function probeFigureCaptionLine(rawLine: string): { name: string; oldKey: string } | null {
  const row = rawLine.trim();
  const numbered = FIGURE_CAPTION_NUMBERED_RE.exec(row);
  if (numbered) {
    const name = numbered[2].trim();
    return validFigureCaptionName(name) ? { name, oldKey: normalizeCaptionKey(numbered[1]) } : null;
  }
  const bare = FIGURE_CAPTION_BARE_RE.exec(row);
  if (!bare) return null;
  const name = bare[1].trim();
  return validFigureCaptionName(name) ? { name, oldKey: '' } : null;
}

/** 规范图题实体（编号分配与覆盖对账共用） */
export interface FigureCaptionEntity {
  lineIndex: number;
  chapterNo: number;
  /** 旧编号 key（无编号形态为空串） */
  oldKey: string;
  name: string;
}

/** 正文区规范图题提取（严格口径，附表区不计） */
export function extractFigureCaptions(markdown: string): FigureCaptionEntity[] {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const bodyEnd = figureBodyEndIndex(lines);
  const chapterByLine = scanFigureChapterNumbers(lines, bodyEnd);
  const entities: FigureCaptionEntity[] = [];
  for (let index = 0; index < bodyEnd; index += 1) {
    const chapterNo = chapterByLine[index];
    if (chapterNo < 1) continue;
    const probe = probeFigureCaptionLine(lines[index] || '');
    if (probe) entities.push({ lineIndex: index, chapterNo, oldKey: probe.oldKey, name: probe.name });
  }
  return entities;
}

/** C2 现地修复：非规范「图 …」行（缺图类尾词/句读粘连）就地修复（正文区限定）。
 * ①粘连前缀拆分：「图4-3 网络图相关内容纳入…」→「图4-3 网络图」+ 残余句另起行
 *   （取最短「图类尾词落定」前缀，前缀须过严格判据）；
 * ②尾词补全：「图 施工进度计划」→「图 施工进度计划图」（仅构成词尾白名单，防正文引用句误修）。
 * 修复不改语义（残余句独立成行）、幂等（修复后行通过严格判据，复跑零变化）。 */
function repairMalformedFigureLines(lines: string[]): { lines: string[]; repaired: number } {
  const bodyEnd = figureBodyEndIndex(lines);
  const output: string[] = [];
  let repaired = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (index >= bodyEnd) {
      output.push(raw);
      continue;
    }
    if (probeFigureCaptionLine(raw)) {
      output.push(raw);
      continue;
    }
    // 仅处理「图」起始行（编号/裸形态；非图起始行原样）
    const row = raw.trim();
    const match = /^图\s*(\d+(?:[-—–－]\d+)?)?\s+(\S.*)$/u.exec(row);
    if (!match) {
      output.push(raw);
      continue;
    }
    const number = match[1] || '';
    const rawName = match[2].trim();
    const figureLine = (name: string) => (number ? `图${number} ${name}` : `图 ${name}`);
    // ①粘连前缀拆分（最短图类尾词落定前缀）
    const prefixMatch = /^(.{1,30}?(?:图|图表))/u.exec(rawName);
    if (prefixMatch && validFigureCaptionName(prefixMatch[1])) {
      const prefix = prefixMatch[1];
      const rest = rawName.slice(prefix.length).replace(/^[。；，、,.;！？!?\s]+/u, '').trim();
      output.push(figureLine(prefix));
      if (rest) output.push(rest);
      repaired += 1;
      continue;
    }
    // ②尾词补全（无句读 + 构成词尾白名单）
    if (!/[。；！？，,.;!?：:]/u.test(rawName)) {
      const completed = normalizeFigureSpecName(rawName);
      if (completed !== rawName && validFigureCaptionName(completed)) {
        output.push(figureLine(completed));
        repaired += 1;
        continue;
      }
    }
    output.push(raw);
  }
  return { lines: output, repaired };
}

/**
 * B-T1 图位补位（终稿确定性兜底）：图类要求规格 ↔ 正文已有图题（宽松扫描 + 图名核心词匹配，
 * 「横道图」↔「施工进度横道图」同图）对照，缺失的规格把无编号图题行「图 图名」注入目标章正文末尾
 * （下一个一级标题前；目标章标题未定位时注入全文末尾保底）。编号由 normalizeFigureNumbering 统一分配，
 * 二函数须串行成对使用；幂等（重放时规格图名已在正文，零注入）。
 * C2：注入前先做非规范图题行就地修复（拆分/补尾词），修复行进入既有图题扫描——根治
 * 「宽松认『像』不补、严格不认」的补了白补死循环。
 */
/**
 * 图类要求 → 数据表（4.55.25 零图口径）。
 *
 * **用户口径**：正文**只出表**——不再出现任何图题、图号、图件、图片；原文里"要求出图"的条目
 * 一律按**数据表**落实。因此本函数：
 * · 正文既有图题行 → **删除**（含不在规格清单里的残留图题），就地在原位放等效数据表；
 * · 缺失的图类要求 → 在目标章末尾放等效数据表；**无对应数据则什么都不放**（不保留裸图题，宁缺毋假）；
 * · 不产生图号、不注入图片引用、不做图号归一（`normalizeFigureNumbering` 已删除）。
 * 幂等：同章同数据源（表头签名）只出一张表；重放结果不变。
 */
export function ensureFigureAsTables(markdown: string, specs: FigurePlaceholderSpec[], options: {
  substituteTable?: (figureName: string) => string[] | undefined;
} = {}): { markdown: string; inserted: string[] } {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  // 图题行判定：严格判据（裸图题「图 图名」）或**编号图题**「图N-M 图名」——零图口径下两类都应删除
  const numberedFigureLine = /^图\s*\d+(?:[-—–－]\d+)?\s+\S/u;
  const isFigureCaptionLine = (line: string): boolean => Boolean(probeFigureCaptionLine(line)) || numberedFigureLine.test(line.trim());
  const bodyEnd = figureBodyEndIndex(lines);
  const inserted: string[] = [];
  // 同章同源去重：签名（表头行）→ 章键，保证同一份数据只出一张表
  const tableSignatureByChapter = new Set<string>();
  const emitTable = (chapterKey: string, table: string[] | undefined): string[] | undefined => {
    if (!table || table.length === 0) return undefined;
    const signature = `${chapterKey}|${table[0] || ''}`;
    if (tableSignatureByChapter.has(signature)) return undefined;
    tableSignatureByChapter.add(signature);
    return table;
  };
  // ① 既有图题行：删除图题，原位放等效数据表（同章同源只出一次）
  const captionTables = new Map<number, string[]>();
  const matchedSpecNames = new Set<string>();
  for (let index = 0; index < bodyEnd; index += 1) {
    const row = (lines[index] || '').trim();
    if (!isFigureCaptionLine(row)) continue;
    const probe = probeFigureCaptionLine(row);
    const captionName = probe?.name || row.replace(numberedFigureLine, '').trim() || row;
    const name = probe?.name || '';
    const spec = name ? specs.find(item => figureNamesMatch(name, normalizeFigureSpecName(item.name))) : undefined;
    if (spec) matchedSpecNames.add(spec.name);
    const table = emitTable(normalizeText(figureChapterOf(lines, index)), options.substituteTable?.(name || captionName));
    if (table) captionTables.set(index, table);
    inserted.push(`移除图题「${captionName.slice(0, 24)}」${table ? '改为等效数据表' : '（无对应数据，仅移除）'}`);
  }
  // ② 缺失的图类要求：在目标章末尾放等效数据表（无数据则不放）
  const missing = specs.filter(spec => !matchedSpecNames.has(spec.name));
  const chapterEndIndexOf = (chapterTitle: string): number => {
    const target = normalizeText(chapterTitle);
    const headingIndexes: number[] = [];
    for (let index = 0; index < bodyEnd; index += 1) {
      const heading = /^##\s+(.+?)\s*$/u.exec(lines[index] || '');
      if (heading && !/^(目录|附表)/u.test(heading[1]!)) headingIndexes.push(index);
    }
    if (!target) return bodyEnd;
    for (let order = 0; order < headingIndexes.length; order += 1) {
      const normalized = normalizeText((lines[headingIndexes[order]!] || '').replace(/^##\s+/u, ''));
      if (normalized.includes(target) || target.includes(normalized)) {
        return order + 1 < headingIndexes.length ? headingIndexes[order + 1]! : bodyEnd;
      }
    }
    return bodyEnd;
  };
  const insertAt = new Map<number, string[]>();
  for (const spec of missing) {
    const end = chapterEndIndexOf(spec.chapterTitle);
    const table = options.substituteTable?.(normalizeFigureSpecName(spec.name));
    if (!table || table.length === 0) continue;   // 无数据 → 不产生任何行（不保留裸图题）
    // 幂等守卫：正文已含该替代表（表头行相同）→ 不再重复出表（重放/多入口共用同一判据）
    if (markdown.includes(table[0] || '')) continue;
    if (!emitTable(normalizeText(spec.chapterTitle), table)) continue;
    const bucket = insertAt.get(end) || [];
    bucket.push('', ...table, '');
    insertAt.set(end, bucket);
    inserted.push(`${spec.chapterTitle}：图类要求「${spec.name}」以数据表落实`);
  }
  if (inserted.length === 0) return { markdown, inserted: [] };
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const table = captionTables.get(index);
    if (table) { output.push('', ...table, ''); continue; }   // 图题行整行被替换
    if (isFigureCaptionLine(lines[index] || '')) continue;  // 残留图题（含不在规格内的）：直接删除（零图）
    const bucket = insertAt.get(index);
    if (bucket) output.push(...bucket);
    output.push(lines[index]!);
  }
  const trailing = insertAt.get(lines.length);
  if (trailing) output.push(...trailing);
  return { markdown: output.join('\n'), inserted };
}

/**
 * B-T1 图类元件与结构要求合并去重（stageOutlinePlanning 数据源）：A-T1 结构/呈现要求（图/框图形态）
 * 并入 R20 C1 图类元件——被排除的格式类条款的图类信号不随排除丢失；按图名核心词判重（figureNamesMatch）。
 */
export function mergeStructureDiagramArtifacts(
  artifacts: DiagramArtifactRequirement[],
  structureItems: Array<{ form: string; element: string; sourceText: string }>,
): DiagramArtifactRequirement[] {
  const merged = [...artifacts];
  for (const item of structureItems) {
    if (item.form !== 'diagram' && item.form !== 'org_chart') continue;
    const name = (item.element || '').trim();
    if (!name) continue;
    if (merged.some(existing => figureNamesMatch(existing.name, name))) continue;
    merged.push({
      name,
      instruction: item.form === 'org_chart' ? '以文字框图呈现组织机构层级（部门或岗位、隶属关系）' : '以文字框图或表格式时间轴呈现（内容要点完整）',
      source: item.sourceText,
    });
  }
  return merged;
}
 
 /** 图位规格汇集（终稿注入数据源）：结构/呈现要求（图/框图形态，章归属来自蓝图路由或现场路由）+
 * 章级图类承载指令（diagramRequirements）合并去重（同章同图核心词判重）。
 */
export function collectFigurePlaceholderSpecs(input: {
  structureItems?: Array<{ chapterTitle: string; form: string; element: string }>;
  chapters?: Array<{ title: string; diagramRequirements?: string[] }>;
}): FigurePlaceholderSpec[] {
  const specs: FigurePlaceholderSpec[] = [];
  const add = (chapterTitle: string, rawName: string) => {
    const chapter = (chapterTitle || '').trim();
    // C2：规格图名归一化（尾词补「图」）——注入/评分/覆盖对账三口径与严格判据一致，
    // 根治「施工进度计划」类规格补了不被认（严格判据拒收）的死循环
    const name = normalizeFigureSpecName((rawName || '').trim());
    if (!chapter || !name || name.length > 60) return;
    if (specs.some(spec => spec.chapterTitle === chapter && figureNamesMatch(spec.name, name))) return;
    specs.push({ chapterTitle: chapter, name });
  };
  for (const item of input.structureItems || []) {
    if (item.form !== 'diagram' && item.form !== 'org_chart') continue;
    add(item.chapterTitle, item.element);
  }
  for (const chapter of input.chapters || []) {
    for (const requirement of chapter.diagramRequirements || []) {
      const name = /^「([^」]+)」/u.exec(requirement)?.[1];
      if (name) add(chapter.title, name);
    }
  }
  return specs;
}

/** 图位覆盖对账（B-T1 验收：招标明文每项图类要求 → 正文规范图位一一对照；图名核心词匹配）。
 * C2：规格图名先归一化（尾词补「图」）——与注入链/严格判据同口径，防「补了不被认」虚缺 */
export function figureTableCoverage(specs: FigurePlaceholderSpec[], markdown: string): { total: number; covered: number; missing: FigurePlaceholderSpec[] } {
  if (specs.length === 0) return { total: 0, covered: 0, missing: [] };
  const missing: FigurePlaceholderSpec[] = [];
  let covered = 0;
  for (const spec of specs) {
    // 4.55.25 零图口径：图类要求以**数据表**落实——覆盖率按该图类替代表的表头行是否出现在正文判定
    const header = figureTableHeaderRow(normalizeFigureSpecName(spec.name));
    if (header && markdown.includes(header)) covered += 1;
    else missing.push(spec);
  }
  return { total: specs.length, covered, missing };
}
