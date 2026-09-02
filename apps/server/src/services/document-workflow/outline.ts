import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { DocumentTemplate, DocumentTemplateChapter } from './types';
import { CN_NUMERAL_RE } from './constants';
import { violatesConfiguredChapterTitleFilter, violatesConfiguredChapterTitleForbiddenFilter } from './templateStore';

function cleanOutlineTitle(title: string) {
  let cleaned = title.trim();
  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned
      .replace(new RegExp(`^\\s*第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]\\s*`, 'u'), '')
      // 4.17.2 多级编号整体剥离（庐江实测：「1.2 质量管理体系」被旧单层剥离规则切成
      // 「2 质量管理体系」，残留二级编号命中「数字粘连名词碎片」规则误删合法目录条目；
      // 整段剥「1.2 / 1.2.3」级编号，编号后必须跟分隔符或空白——条款编号粘连汉字
      // 如「3.2项规定」不进此分支，仍由下层规则按条款残留拦截）
      .replace(new RegExp(`^\\s*[（(]?(?:\\d{1,3}|${CN_NUMERAL_RE})(?:[.．]\\d{1,3})+(?:[.．、）)]\\s*|\\s+)`, 'u'), '')
      .replace(new RegExp(`^\\s*[（(]?(?:\\d{1,3}|${CN_NUMERAL_RE})[)）、.．]\\s*`, 'u'), '')
      .replace(new RegExp(`^\\s*[-*+]\\s+`, 'u'), '')
      .trim();
  }
  return cleaned.replace(/\s+/gu, ' ');
}

/**
 * 招标条款碎片标题判别（显式 OUTLINE 提取与写手正文 H3 提取共用）：
 * 招标/评分办法条款被序号切分后的碎片混入标题（如「1委员会确定中」「如我方中标，我方承诺」「3项规定」「56m15：…」），
 * 特征为条件从句、承诺/保证断言、评标委员会评审动作、条款编号残留或带数字参数的条款要求，均非章节/小节标题
 */
export function isTenderClauseFragmentTitle(title: string) {
  const normalized = cleanOutlineTitle(title).replace(/\s+/gu, '');
  if (!normalized) return true;
  if (/^(?:如|若|如果|倘若|假如|当)[^，,。；]{0,24}[，,]/u.test(normalized)) return true;
  if (/^(?:我(?:方|公司)|本(?:单位|公司|工程|项目)|投标人|承包人|中标人|发包人|供应商)[^，,。；]{0,14}(?:承诺|保证|响应|满足|确保|应|须|将|会)/u.test(normalized)) return true;
  if (/(?:评标)?委员会[^，,。；]{0,10}(?:确定|认定|评审|判断|推荐)/u.test(normalized)) return true;
  if (/^(?:不(?:得|应|宜|少于|超过|大于|小于|低于|高于)|超过|低于|高于|达到|不少于|不大于|不超过|偏差率|误差)\s*\d/u.test(normalized)) return true;
  if (/^[^，,。；]{0,10}\d+(?:%|％)/u.test(normalized)) return true;
  // 条款编号残留：PDF 解析把条款编号切进标题（「3项规定」「2（3）目，报价在最高限价90%-100%之」「4对与评标活动…」「56m15：…」）
  if (/^\d+\s*项/u.test(normalized)) return true;
  if (/^\d+(?:[（(]\d+[)）])?\s*目/u.test(normalized)) return true;
  if (/^\d+\s*对(?:与|于)/u.test(normalized)) return true;
  if (/^\d{1,4}[a-zA-Z]{0,3}\d{0,4}\s*[：:]/u.test(normalized)) return true;
  // 数字+时间单位+逗号碎片（「00天，计划完成时间：」类，PDF 条款被逗号切分混入标题）
  if (/^\d{1,4}\s*(?:个)?(?:日历天|天|日|月|年)[，,、]/u.test(normalized)) return true;
  // 数字+参数列表碎片（真实生成回归：「5厘米，其余均为2.0厘米」——招标要求参数原文被写成小节标题，
  // 特征为数字开头后跟短参数串即现逗号，与「30日历天、计划完成时间」同属参数条款碎片）
  // 4.17.2 分隔符补顿号：庐江实测「4示媒介、期限」（「4. 公示媒介、期限」条款碎片，"公"字丢失）
  // 数字+短串+顿号同属参数条款碎片形态，旧字符类 [，,] 漏顿号导致漏判
  if (/^\d{1,4}[^，,。；\s]{1,6}[，,、]/u.test(normalized)) return true;
  // 数字粘连名词碎片（真实生成回归：「1人员及职责」「2同招标公告发布媒介」「1分为分割」——
  // 条款编号残留直接粘连汉字短语，整行=数字+2~10 汉字无其他字符；量词开头（个/名/台…）豁免，
  // 避免误伤「2个月完成主体结构」类合法标题）
  if (/^\d{1,2}[一-龥]{2,10}$/u.test(normalized) && !/^\d{1,2}(?:个|名|台|套|辆|份|种|类|层|栋|座|米|吨|年|月|天|日|周|次|项)/u.test(normalized)) return true;
  // 截断句碎片（真实生成回归：「本招标项目公共建筑根据《民用建筑设计统一标准》（」——
  // 标题以未闭合括号/书名号结尾，是被截断的条款原文；合法小节标题不会以左括号收尾）
  if (/[（(【［《]$/u.test(normalized)) return true;
  // 括号配对校验（4.12.12 真实生成回归）：「1发包人委派的发包人代表或监理工程师（以下简」——
  // 截断残留左括号但非行尾（左括号后还有「以下简」），上一规则拦不住；左括号到行尾无对应右括号即截断
  if (/[（(【［《][^）)】］》]*$/u.test(normalized)) return true;
  // 简称句式截断（4.12.12 真实生成回归）：合同条款「（以下简称××）」被解析截断残留「以下简」
  if (/以下简/u.test(normalized)) return true;
  // 数字+单位参数碎片（4.12.12 真实生成回归）：「65m18245.65m），（），（1）工程量与」——
  // PDF 参数列（数字+单位字母粘连）被切进标题；合法小节标题不会以「数字+拉丁字母」开头
  if (/^\d{1,4}\s*[a-zA-Z]/u.test(normalized)) return true;
  // 评标程序动作碎片（4.12.12 真实生成回归）：「确定评标价」「确定有效评标价」——
  // 评标委员会程序步骤被误提取为评分条目；技术标小节不会以评标价确定动作命名
  // （4.12.13 扩围：真实生成仍漏拦「确定评标基准价」——「基准」夹在动作与「价」之间）
  if (/^(?:确定|计算|比较|推荐|审查|否决)(?:有效)?评标(?:基准)?价/u.test(normalized)) return true;
  if (/^(?:其他要求|需要补充的其他内容|相当于或不低于|补充条款|建议编制要求|投标须知|评标办法)/u.test(normalized)) return true;
  // 资格条款义务句式（1.4 形态 A，实锤：「6.6 具备有效的营业执照」「6.7 具备有效的资质证书、具备有效的安全生产许可证」
  // 混入目录）：词面黑名单（isQualificationSectionTitle）只覆盖已知证照名，句式级判别覆盖词表外证照
  // （如「具备有效的食品经营许可证」）；施组小节标题不会以资格义务动词开头命名。与 isQualificationSectionTitle 同口径
  // 多级编号残留剥离：cleanOutlineTitle 只剥单层「数字+分隔符」，「6.7 具备…」剥后残留「7 具备…」，句式判别前再剥一次
  const clauseNormalized = normalized.replace(/^\d{1,3}(?:[.．]\d{1,3})*\s*/u, '');
  if (/^具备(?:有效|相应|满足)/u.test(clauseNormalized)) return true;
  if (/^(?:须|应|需|得)?提供[^，,。；]{0,12}(?:证明|材料|文件|证件|证书|报告)/u.test(clauseNormalized)) return true;
  // 4.17.2 条款义务陈述句（庐江实测：「本招标项目经理不得同时兼任本招标项目技术负责」——
  // 招标前置附表条款原文被截断当小节标题；义务主体+「不得/禁止/严禁/必须/应当」句式，
  // 施工组织设计小节标题不会以条款义务陈述命名）
  if (/^(?:本(?:招标)?(?:项目|工程)|投标人|承包人|中标人|发包人|供应商|项目经理|技术负责人|施工单位)[^，,。；]{0,24}(?:不得|禁止|严禁|必须|应当)/u.test(clauseNormalized)) return true;
  // 4.17.2 条款指向句（庐江实测：「项目经理业绩具体要求见招标公告」——"见/详见/参见"+
  // 招标文件族指向短语；施工小节标题不以"见××"结尾，指向句是条款引用不是小节命名）
  if (/(?:见|详见|参见|详见第)[^，,。；]{0,12}(?:招标公告|招标文件|投标人须知|补疑|澄清|工程量清单|图纸|合同条款|前附表)/u.test(clauseNormalized)) return true;
  // 条款编号残留扩展（4.12.14 真实生成回归）：「4款、第5.3款和第6.5款的规定先向招标人提出」——
  // 「数字+款」条款编号开头与「3项规定」「2（3）目」同族；「第X款…向…提出/告知/通知」为条款句尾
  // 动作而非小节标题（技术标小节不会以条款编号「款」开头命名）
  if (/^\d{1,3}\s*款/u.test(normalized)) return true;
  if (/第\d+(?:\.\d+)?款[^，,。；]{0,20}(?:向(?:招标人|发包人|监理人?|承包人)|提出|告知|通知|送达|发出)/u.test(normalized)) return true;
  // 乱码标题（4.12.14 用户自跑资料回归）：资料二进制/编码误读文本被提取为章节标题混入目录
  return isLikelyMojibakeTitle(normalized);
}

/**
 * 乱码标题判别：PDF/旧版 Office/CAD 二进制误读文本被大纲提取器当章节标题后混入目录——
 * 「考堂f肀」「渱潑喲W晀耀」「VdA«UdA»」「爀攀最椀猀琀礀」等形态；合法小节标题由常用汉字/
 * 数字/工程符号构成，不会命中。工程后缀搭配（门窗K值、B级混凝土）豁免汉字-拉丁交叉规则。
 */
export function isLikelyMojibakeTitle(title: string) {
  const compact = title.replace(/\s+/gu, '');
  if (!compact) return false;
  // UTF-16LE 中文被 latin1/utf8 误读的典型生僻字串（kbEvaluationService 同源特征，剔除其中
  // 攀/最/开等常用字——「开挖」「最终」等合法标题不得因单字命中被误杀），命中 ≥2 个才算乱码
  const misreadHits = (compact.match(/[爀椀猟礀氀漀挀渀捁扄潓瑲湥獴慔汢]/gu) || []).length;
  if (misreadHits >= 2) return true;
  // 罕见 Unicode 区块（箭头补充/CJK 部首/杂项数学/圈符/地图符号）：二进制误读产物
  if (/[\u2046-\u205F\u2070-\u209F\u2100-\u2102\u2104-\u214F\u21B0-\u21FF\u2270-\u22FF\u2400-\u243F\u249C-\u24FF\u2640-\u26FF\u27C0-\u27EF\u2900-\u297F\u2A00-\u2AFF\u2B00-\u2BFF\u2E00-\u2FFF\u3200-\u33FF]/u.test(compact)) return true;
  // Latin-1 扩展区（排除工程合法符号 °±²³¹·×÷）：正常中文标题不用 À-ÿ 扩展字母或 «»¼ 等符号
  if (/[\u00A0-\u00AF\u00B4\u00B6\u00B8\u00BA-\u00FF]/u.test(compact)) return true;
  // 汉字-Latin-汉字交叉混排（「考堂f肀」）：字母编号只出现在汉字前或后，不会夹在汉字中间；
  // 「值/级/类/区/型/构/段/座/轴/向/楼/层/栋/点/位」工程后缀豁免（门窗K值、B级混凝土合法标题）
  if (/[\u4e00-\u9fa5][A-Za-z][\u4e00-\u9fa5]/u.test(compact) && !/[\u4e00-\u9fa5][A-Za-z](?:值|级|类|区|型|构|段|座|轴|向|楼|层|栋|点|位)/u.test(compact)) return true;
  // 可读字符占比：非汉/拉丁/数字/常用标点的符号占比过高即乱码
  const chars = [...compact];
  const readable = chars.filter(char => /[\u4e00-\u9fa5A-Za-z0-9（）()【】《》、，。；;：:,.\-/㎡%°·±×÷≤≥—–]/u.test(char)).length;
  return readable / chars.length < 0.6;
}

/** 指令型/碎片标题判别（isTenderClauseFragmentTitle 超集：含冒号结尾、指令型提示语，
 * 供评分条目提取、大纲出口清洗与补挂拦截共用同一口径——碎片混入任何一环都应被同口径拦截） */
export function isInstructionLikeOutlineTitle(title: string) {
  const normalized = cleanOutlineTitle(title).replace(/\s+/gu, '');
  if (!normalized) return true;
  if (/^(?:目录|章节|大纲|要求|说明|注意|输出|格式|示例|例如|写法|占位|提示)$/u.test(normalized)) return true;
  if (/^(?:判断|判定|识别|确认)?是否(?:涉及|涉|需要|适用)|^(?:如|若|如果)(?:涉及|不涉及|适用|不适用)|(?:根据|结合).{0,12}(?:实际情况|项目情况|资料情况).{0,8}(?:判断|确定|编写|生成)|按需(?:生成|编写)|视情况|判断后|生成要求|编写要求|说明要求|注意事项/u.test(normalized)) return true;
  if (/[：:]$|[，、；。]$/u.test(normalized)) return true;
  return isTenderClauseFragmentTitle(normalized);
}

function isInvalidOutlineTitle(title: string) {
  return title.trim().length === 0 || isInstructionLikeOutlineTitle(title);
}

function outlineTitlesFromBlock(content: string) {
  const cnOrder = `${CN_NUMERAL_RE}`;
  const markers = [
    `第(?:\\d{1,3}|${cnOrder})[章节]\\s*`,
    `(?:\\d{1,3})[、)）]\\s*`,
    `(?:\\d{1,3})[.．]\\s+(?!\\d)`,
    `(?:${cnOrder})[、.．)）]\\s*`,
    `[（(](?:\\d{1,3}|${cnOrder})[)）]\\s*`,
    `[-*+]\\s+`,
  ];
  let normalized = content.replace(/\r?\n/gu, '\n');
  for (const marker of markers) {
    normalized = normalized.replace(new RegExp(`([；;。！？!?])\\s*(?=${marker})`, 'gu'), '$1\n');
    normalized = normalized.replace(new RegExp(`(?<=\\n)\\s+(?=${marker})`, 'gu'), '');
    normalized = normalized.replace(new RegExp(`(?<![\\d.．])\\s+(?=${marker})`, 'gu'), '\n');
  }
  return normalized
    .split(/\n|；|;/u)
    .map(line => cleanOutlineTitle(line))
    .filter(title => !isInvalidOutlineTitle(title));
}

const OUTLINE_TAG_NAME_RE = '(?:OUTLINE|CHAPTERS?|章节(?:大纲)?|大纲|目录)';
const OUTLINE_EXACT_RE = new RegExp(`<\\s*${OUTLINE_TAG_NAME_RE}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\s*${OUTLINE_TAG_NAME_RE}\\s*>`, 'giu');

export function hasExplicitOutlineBlock(text: string) {
  OUTLINE_EXACT_RE.lastIndex = 0;
  return OUTLINE_EXACT_RE.test(text);
}

export function isExplicitOutlineOpeningLine(text: string) {
  return new RegExp(`^\\s*<\\s*${OUTLINE_TAG_NAME_RE}(?:\\s[^>]*)?>`, 'iu').test(text);
}

export function isExplicitOutlineClosingLine(text: string) {
  return new RegExp(`^\\s*<\\/\\s*${OUTLINE_TAG_NAME_RE}\\s*>`, 'iu').test(text);
}

function extractOutlineBlocks(text: string, options?: { strict?: boolean }) {
  OUTLINE_EXACT_RE.lastIndex = 0;
  const exact = [...text.matchAll(OUTLINE_EXACT_RE)].map(match => match[1] || '');
  if (exact.length > 0 || options?.strict) return exact;
  const loose = /(?:<\s*)?(?:OUTLINE|CHAPTERS?|章节(?:大纲)?|大纲|目录)\s*>?\s*[:：]?\s*([\s\S]*?)(?:<\/\s*(?:OUTLINE|CHAPTERS?|章节(?:大纲)?|大纲|目录)\s*>|END\s+(?:OUTLINE|CHAPTERS?)|$)/iu.exec(text);
  return loose?.[1] ? [loose[1]] : [];
}

function extractExplicitOutlineFromText(text: string, source: string, options?: { strict?: boolean }): DocumentTemplateChapter[] {
  const chapters: DocumentTemplateChapter[] = [];
  const blocks = extractOutlineBlocks(text, options);
  for (const block of blocks) {
    for (const title of outlineTitlesFromBlock(block)) {
      chapters.push({
        id: `explicit-${source}-${chapters.length + 1}`,
        title,
        purpose: `根据显式大纲章节生成正式正文：${title}`,
        requiredFacts: [],
        sections: [],
        queries: [title],
      });
    }
  }
  return chapters.filter(chapter => !isInvalidOutlineTitle(chapter.title));
}

export function extractExplicitOutlineFromSources(sources: Array<{ text?: string; source: string; strict?: boolean }>) {
  for (const item of sources) {
    const chapters = extractExplicitOutlineFromText(item.text || '', item.source, { strict: item.strict });
    if (chapters.length >= 2) return chapters;
  }
  return [];
}

export function displayChapterTitle(title: string) {
  let cleaned = title.replace(/^#+\s*/u, '').trim();
  let prev = '';
  while (cleaned && cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned
      .replace(/^第[一二三四五六七八九十百千万\d]+[章节]\s*/u, '')
      .replace(/^\d+(?:\.\d+)*[、.．\s]+/u, '')
      .replace(/^[（(]?[一二三四五六七八九十]+[)）、.．\s]+/u, '')
      .trim();
  }
  return cleaned;
}

export function normalizeGeneratedChapterTitle(title: string) {
  return displayChapterTitle(title.replace(/\s+/gu, ' ').trim()).replace(/^[，,、；;：:。.!！?？\-—\s]+/u, '').trim();
}

export function isValidGeneratedChapterTitle(title: string) {
  const raw = title.trim();
  const clean = normalizeGeneratedChapterTitle(raw);
  if (!clean || clean.length < 2 || clean.length > 50) return false;
  if (/^#{3,6}\s*/u.test(raw)) return false;
  if (/^\|.*\|/u.test(raw) || /\|/u.test(clean)) return false;
  if (/^[，,、；;：:。.!！?？\-—]/u.test(raw)) return false;
  if (/[{}<>]|Markdown|JSON|变量|占位符/u.test(clean)) return false;
  if (/[。；;]$/u.test(clean) || /[:：]\s*[。；;]?$/u.test(clean)) return false;
  if (/^(目录|章节|大纲|要求|说明|注意|输出|格式|示例|例如|写法|占位)$/u.test(clean)) return false;
  if (isInstructionLikeOutlineTitle(clean)) return false;
  if (/(评标委员会|完全满足评审要求|全面梳理与响应|坚实的技术保障)/u.test(clean)) return false;
  return !isPollutedChapterTitle(clean);
}

function numberToChineseChapter(value: number) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value <= 10) return value === 10 ? '十' : digits[value];
  if (value < 20) return `十${digits[value % 10]}`;
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ''}`;
  }
  return String(value);
}

export function formalChapterTitle(index: number, title: string) {
  const clean = displayChapterTitle(title);
  return `第${numberToChineseChapter(index + 1)}章 ${clean}`;
}

function isPollutedChapterTitle(title: string) {
  return /见(?:公告|文件|资料|附件)|按(?:资料|文件|相关要求)|质量标准[:：]|范围[:：].*依据/u.test(title);
}

export function uniqueTemplateChapters(chapters: DocumentTemplateChapter[], options?: { preserveExplicitOutline?: boolean; template?: DocumentTemplate }) {
  const seen = new Set<string>();
  return chapters.filter(chapter => {
    const key = normalizeGeneratedChapterTitle(chapter.title);
    if (!key) return false;
    if (!options?.preserveExplicitOutline) {
      if (seen.has(key) || isPollutedChapterTitle(key)) return false;
      if (options?.template && violatesConfiguredChapterTitleForbiddenFilter(key, options.template)) return false;
    }
    seen.add(key);
    chapter.title = key; // chapter 是 filter 的回调参数，来自调用方传入的数组；调用方应传入副本以避免原始数据被修改
    return true;
  });
}

export function effectiveTemplateChapters(template: DocumentTemplate, spec?: AutoDocumentSpecPackage, options?: { preserveExplicitOutline?: boolean }): DocumentTemplateChapter[] {
  if (!spec || options?.preserveExplicitOutline) return uniqueTemplateChapters([...template.chapters], { ...options, template });
  return uniqueTemplateChapters([...template.chapters].map(chapter => {
    const title = displayChapterTitle(chapter.title);
    const rule = spec.chapterRules.find(item => item.id === chapter.id || displayChapterTitle(item.title) === title);
    return {
      ...chapter,
      title,
      purpose: chapter.purpose,
      requiredFacts: chapter.requiredFacts || [],
      queries: [...new Set([...(chapter.queries || []), title, rule?.generationHint || '', ...(chapter.sections || [])].filter(Boolean))],
    };
  }), { ...options, template });
}
