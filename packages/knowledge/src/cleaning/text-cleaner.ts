import type { FileCategory } from '../types.js';

/**
 * 入库前文本清洗（源头治理）：在「解析完成 → 分块入库」之间移除确定性的噪声数据，
 * 使入库的即干净、真实需要的数据——下游检索、证据注入、生成链路全流程受益
 * （上下文更瘦、prefix cache 更稳、事实提取更准），并减少生成链路的重复清洗成本。
 *
 * 清洗范围（三类，按文件类型与内容特征分流）：
 * A. 格式噪声（K1）：页眉/页脚/图框标题栏高重复行、纯页码行、目录区段、连续空行、
 *    投标文件格式模板段、泛化引用行、补疑零信息回复行、图纸纯坐标行；
 * B. 内容无关数据（K2，章节级）：合同通用条款（标准示范文本，不含项目数据）、
 *    招标公告程序段（文件获取/递交/开标方式）、评标办法商务评审细则——
 *    施工组织设计（技术标）生成用不到的商务/程序性内容，不入库、不进检索上下文。
 * C. 图纸/清单专门噪声（K3）：图纸图框标题栏信息行（图号/比例/签名行）、CAD 属性行
 *    （图层/颜色/线型）、清单纯报价表格段（费汇总/暂估/规费/税金，含金额行证据）、
 *    清单扉页签章段——分部分项清单的名称/特征/工程量是施组核心数据，绝不删。
 *
 * 保守策略（宁多勿丢红线）：每条规则都要求「标题模式 + 内容特征/规模」多重证据，
 * 只删高置信噪声；清洗后文本若不足原文 30% 整体回退；KB_TEXT_CLEANING=0 关闭清洗。
 */

export interface TextCleanStats {
  /** 页眉/页脚/图框标题栏高重复行数 */
  headerFooterLines: number;
  /** 纯页码行数 */
  pageNumberLines: number;
  /** 目录区段行数 */
  tocRegionLines: number;
  /** 压缩掉的连续空行数 */
  blankLines: number;
  /** 招标文件：投标文件格式模板段行数 */
  tenderFormatLines: number;
  /** 招标文件：泛化引用行数 */
  tenderGenericLines: number;
  /** 补疑文件：零信息回复行数 */
  clarificationLines: number;
  /** 图纸：无汉字纯坐标行数 */
  cadNoiseLines: number;
  /** 合同通用条款章节行数（K2 内容无关） */
  contractGeneralClauseLines: number;
  /** 招标公告程序段行数（K2 内容无关） */
  announcementProcedureLines: number;
  /** 评标商务评审细则段行数（K2 内容无关） */
  businessReviewLines: number;
  /** 图纸：图框标题栏信息行数（图号/比例/签名行，K3） */
  cadTitleBlockLines: number;
  /** 图纸：CAD 属性行数（图层/颜色/线型，K3） */
  cadAttributeLines: number;
  /** 图纸：CAD 图元属性枚举行数（管道符表格形态的实体罗列，K3） */
  cadEntityPropertyLines: number;
  /** 招标文件：电子投标程序句行数（加密/解密/上传/撤回等操作句，行级） */
  tenderEprocedureLines: number;
  /** 清单：纯报价表格段行数（费汇总/暂估价/规费/税金，K3） */
  billPricingLines: number;
  /** 清单：扉页签章段行数（K3） */
  billTitlePageLines: number;
}

export interface TextCleaningResult {
  /** 清洗后的文本（30% 回退保护下可能等于原文） */
  text: string;
  removedLines: number;
  removedChars: number;
  stats: TextCleanStats;
}

export interface TextCleaningInput {
  text: string;
  /** 文件分类（classifier 的 FileCategory），用于选择清洗规则组 */
  category?: FileCategory | string;
  /** 文件名/相对路径（招标/补疑文档类型判定依据） */
  fileName?: string;
  /** 显式开关；缺省读环境变量 KB_TEXT_CLEANING（=0 关闭） */
  enabled?: boolean;
}

type DocKind = 'tender' | 'clarification' | 'bill' | 'other';

function zeroStats(): TextCleanStats {
  return {
    headerFooterLines: 0, pageNumberLines: 0, tocRegionLines: 0, blankLines: 0,
    tenderFormatLines: 0, tenderGenericLines: 0, clarificationLines: 0, cadNoiseLines: 0,
    contractGeneralClauseLines: 0, announcementProcedureLines: 0, businessReviewLines: 0,
    cadTitleBlockLines: 0, cadAttributeLines: 0, cadEntityPropertyLines: 0,
    tenderEprocedureLines: 0, billPricingLines: 0, billTitlePageLines: 0,
  };
}

/** 文档类型判定：文件名 + 文首内容双重特征（招标文件 / 补疑答疑 / 工程量清单 / 其他） */
function detectDocKind(fileName: string, head: string): DocKind {
  if (/(补疑|答疑|澄清|补遗|变更通知|招标答疑)/u.test(fileName) || /答疑纪要|澄清函|补遗文件|招标文件答疑/u.test(head)) return 'clarification';
  if (/(招标文件|招标公告|招标书|邀请招标)/u.test(fileName) || /投标人须知|招标公告|投标邀请/u.test(head)) return 'tender';
  if (/(清单|BQ|bill|Bill)/u.test(fileName) || /^.{0,300}工程量清单|分部分项工程量清单/u.test(head)) return 'bill';
  return 'other';
}

/** 页眉/页脚/图框标题栏高重复行：全文出现 ≥3 次 + 长度 4-60 + 非表格行 + 非列表项 + 非表头 */
function isHeaderFooterLine(trimmed: string, count: number): boolean {
  if (count < 3) return false;
  if (trimmed.length < 4 || trimmed.length > 60) return false;
  if (trimmed.includes('|')) return false;
  if (/^[-*•·]\s|^\d+[、.．]\s/u.test(trimmed)) return false;
  // 表头保护：短行含表头关键词（纯文本格式清单/表格每页重复的表头）保留
  if (trimmed.length < 12 && /序号|名称|单位|数量|金额|备注|编码/u.test(trimmed)) return false;
  return true;
}

/** 纯页码行：独立成行的纯数字/页码格式（小文件保护：行数 <20 不删，可能是数据文件） */
function isPageNumberLine(trimmed: string, totalLines: number): boolean {
  if (totalLines < 20) return false;
  return /^\d{1,4}$/u.test(trimmed)
    || /^第\s*\d{1,4}\s*页/u.test(trimmed)
    || /^\d{1,4}\s*\/\s*\d{1,4}$/u.test(trimmed)
    || /^[-–—]\s*\d{1,4}\s*[-–—]$/u.test(trimmed);
}

const TOC_DOT_LINE_RE = /^.{2,80}[.·…]{3,}\s*\d{1,4}\s*$/u;
const TOC_TITLE_RE = /^目\s*录\s*$/u;

/**
 * 目录区段探测：从「目录」标题行开始，连续收集点线行（"标题......页码"）与短标题行，
 * 遇到正文特征行（长行/表格行）停止。返回区段结束位置与点线行占比，由调用方按
 * 「行数 ≥4 且点线占比 ≥50%」双重条件决定是否整区删除。
 */
function collectTocRegion(lines: string[], start: number): { end: number; dotLineRatio: number } {
  let end = start + 1;
  let dotLines = 0;
  const hardLimit = Math.min(lines.length, start + 300);
  let lastWasDotLine = false;
  for (let j = start + 1; j < hardLimit; j += 1) {
    const trimmed = lines[j]!.trim();
    if (!trimmed) continue;
    if (TOC_DOT_LINE_RE.test(trimmed)) { dotLines += 1; end = j + 1; lastWasDotLine = true; continue; }
    // 目录区内的章节标题行：短行、非表格、非列表、非「第X章 长正文」形态、非句末标点结尾的正文句；
    // 仅当下一行仍是点线行时才继续收集（标题行夹在点线行之间的排版），否则视为正文标题结束区段——
    // 目录末行与正文首行同为「第X章 XXX」文本时无法靠行内容区分，只能靠点线上下文
    const nextTrimmed = (lines[j + 1] ?? '').trim();
    const looksLikeTocTitle = trimmed.length < 50 && !trimmed.includes('|') && !/^[-*•·]\s/u.test(trimmed) && !/^第[一二三四五六七八九十百\d]+[章节部分][：:]/u.test(trimmed) && !/[。；;！？!?]$/u.test(trimmed);
    if (looksLikeTocTitle && lastWasDotLine && TOC_DOT_LINE_RE.test(nextTrimmed)) { end = j + 1; continue; }
    break;
  }
  const count = end - start;
  return { end, dotLineRatio: count > 0 ? dotLines / count : 0 };
}

/** 招标文件：投标文件格式模板段标题（投标函/身份证明/授权书等格式模板） */
const TENDER_FORMAT_TITLE_RE = /投标函(格式)?$|法定代表人(身份)?证明(书)?(格式)?$|授权委托书(格式)?$|投标保证金.*格式$|资格审查资料.*格式$|近年.*情况.*格式$/u;

/** 招标文件：段内盖章/签字/日期填空标记（格式模板段证据） */
const TENDER_FORMAT_SIGN_RE = /（盖[章章]*）|（签[字名]）|（公[章章]*）|（日期）|（盖章）|盖单位章|签字或盖章/u;

/**
 * 投标文件格式模板段探测：标题行匹配格式模板特征后，向后收集段内容（至空行分隔段落结束），
 * 段内含盖章/签字标记才算模板段（标题 + 盖章标记双重证据）。
 */
function collectTenderFormatBlock(lines: string[], start: number): number {
  if (!TENDER_FORMAT_TITLE_RE.test(lines[start]!.trim())) return start;
  let end = start + 1;
  let hasSign = false;
  for (let j = start + 1; j < lines.length; j += 1) {
    const trimmed = lines[j]!.trim();
    if (TENDER_FORMAT_SIGN_RE.test(lines[j]!)) hasSign = true;
    if (!trimmed) { end = j + 1; break; }
    // 下一个章节标题行（「第X章/条」或中文序号）视为新段起点；纯数字序号（"1. xxx"）在
    // 格式模板段内是常见的填空条目，不中断段收集
    if (j > start + 1 && /^(第[一二三四五六七八九十百\d]+[章节条部分]|[一二三四五六七八九十]+[、.．])/u.test(trimmed) && trimmed.length < 30) break;
    end = j + 1;
  }
  return hasSign ? end : start;
}

/** 招标文件：泛化引用行（"详见投标人须知前附表"类短行，无实质项目信息；后缀短语可选） */
const TENDER_GENERIC_LINE_RE = /^(详见|具体见|以|按).{0,30}?(前附表|招标文件|招标公告|补疑|澄清|清单|图纸|合同文件)((的)?(要求|规定|为准|执行))?[。；;]?$|^投标人应(仔细|认真)(阅读|核对)(招标文件|本项目)(的全部内容)?[。；;]?$|^未(按|依照|按照)(上述|本|招标文件)要求/u;
/** 招标文件：电子投标程序句（行级）。投标人须知条目式排版无可靠段落边界，按句删除
 * 程序性操作（加密/解密/上传/撤回/签号/病毒防范/获取/发布/提出/发出/发送/下载/拒收/提交/开标/导入/制作/中断/在线/查询/登录/进行/公示）；
 * 双重信号（程序动词 + 程序对象）防止误删技术条款。仅招标文件生效。 */
const TENDER_EPROCEDURE_PREFIX_RE = /(?:电子交易系统|数字证书|加密|解密|撤回操作|上传投标文件|签号|病毒防范)/u;
const TENDER_EPROCEDURE_LINE_RE = /(?:电子交易系统|数字证书|加密|解密|撤回操作|上传投标文件|签号|病毒防范).{0,45}(?:上传|递交|撤回|解密|完成|显示|关闭|发放|发送|防范|获取|发布|提出|发出|下载|拒收|查看|接收|提交|开标|导入|拒绝|制作|中断|在线|查询|登录|进行|公示)|(?:投标截止时间).{0,35}(?:上传|递交|撤回|自动关闭)/u;
/** 具体时间/地点证据：跨行拼接删除的防护——拼接后含实质时间地点信息的不删 */
const TENDER_TIME_PLACE_RE = /\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}时\d{1,2}分|地点[：:为是]/u;
/** 折行接续行判定：行首非编号/序号/条文标题（PDF 折行接续的行首是句中词） */
const TENDER_CONTINUATION_HEAD_RE = /^(?:###\s*)?(?:第[一二三四五六七八九十百零两\d]+[条章节]|[（(]?[一二三四五六七八九十\d]+[）)、.、．]|\d{1,3}[.、．]|[【［])/u;

/** 补疑文件：零信息回复行（"答：按招标文件执行"类套话；含数字/单位的实质回复不删） */
const CLARIFICATION_BOILERPLATE_RE = /^(?:(?:答|答复|回复)[：:]\s*)?(?:按|以)(招标文件|招标公告|合同文件|清单|图纸|补疑|答疑)?(约定|规定|要求|执行|为准)[。；;]?$|^(?:(?:答|答复|回复)[：:]\s*)?不(作|做|予)(调整|修改|变更)[。；;]?$|^(?:(?:答|答复|回复)[：:]\s*)?维持(不变|原状)[。；;]?$|^(?:(?:答|答复|回复)[：:]\s*)?(本项|此项)(无|没有)(调整|修改|变化)[。；;]?$/u;

/** 图纸：无汉字纯坐标数字行（≥2 组相邻 "数字,数字" 坐标对即 ≥3 个连续坐标值，设计坐标不写入施组正文） */
function isCoordinateNoiseLine(trimmed: string): boolean {
  if (/[\p{Script=Han}]/u.test(trimmed)) return false;
  const coordMatches = trimmed.match(/-?\d+(?:\.\d+)?\s*[,，]\s*-?\d+(?:\.\d+)?/gu) ?? [];
  return coordMatches.length >= 2;
}

/** 图纸：图框标题栏关键词（图号/比例/日期/签名列） */
const CAD_TITLE_BLOCK_KEY_RE = /^(图号|图别|比例|日期|阶段|版次|设计|制图|审核|校对|审定|复核)/u;
/** 图框行负向词：含这些词的行是实质内容（设计说明/设计要求/审核意见等），不是图框信息 */
const CAD_TITLE_BLOCK_GUARD_RE = /说明|要求|依据|变更|图纸|内容|标准|规范|标高|强度|参数|意见|结论|目录|名称|负责人|设计人|审核人/u;

/**
 * 图纸：图框标题栏信息行（"图号 J-01"、"比例 1:100"、"设计 王某某" 类签名/标注行）。
 * 标题 + 负向词双重判定：短行 + 图框关键词开头 + 不含实质内容词。
 */
function isCadTitleBlockLine(trimmed: string): boolean {
  if (trimmed.length > 30 || trimmed.length < 3) return false;
  if (!CAD_TITLE_BLOCK_KEY_RE.test(trimmed)) return false;
  if (CAD_TITLE_BLOCK_GUARD_RE.test(trimmed)) return false;
  return true;
}

/** 图纸：CAD 转换产物的图元属性行（图层/颜色/线型/块名等，与施组编制无关） */
const CAD_ATTRIBUTE_LINE_RE = /^(图层|颜色|线型|线宽|块名|文字样式|标注样式|打印样式|线型比例)\s*[:：=]?\s*\S{0,30}$/u;

/** 图纸：CAD 属性行判定（属性关键词 + 单行短值；含「说明/图例」的行是图例内容，保留） */
function isCadAttributeLine(trimmed: string): boolean {
  if (trimmed.length > 40) return false;
  if (!CAD_ATTRIBUTE_LINE_RE.test(trimmed)) return false;
  if (/说明|图例|表/u.test(trimmed)) return false;
  return true;
}

/**
 * 图纸：CAD 图元属性枚举行（「| 图层: X | 块: Y | 实体类型: … | 坐标: (…)」
 * 管道符表格形态或「└── 标注文本: …」图元注释行）——专业转换器/历史版本产物形态，
 * 图元属性包装与施组编制无关，「坐标/关联对象/状态」类纯图元定位信息会稀释检索语义。
 * 行首键名 + 冒号 + 短值多重特征判定；「图纸节点: 文件名」锚定行不删（文件溯源有用）。
 */
function isCadEntityPropertyLine(trimmed: string): boolean {
  if (trimmed.length > 50) return false;
  if (/^[|└\s]*(?:图层|块|实体类型|坐标|关联对象|状态)\s*[:：]/u.test(trimmed)) return true;
  if (/^└──\s*(?:标注文本\s*[:：])?/u.test(trimmed)) return true;
  if (/^图纸节点\s*[:：].{0,100}(?:图层|块|实体类型)\s*[:：]/u.test(trimmed)) return true;
  return false;
}

// ── K2 内容无关数据清洗（章节/段落级，多重证据判定，宁多勿丢）──────────────────────────

type SectionDropKind = 'contractGeneralClauseLines' | 'announcementProcedureLines' | 'businessReviewLines' | 'billPricingLines' | 'billTitlePageLines';

interface SectionDrop {
  kind: SectionDropKind;
  end: number;
}

/** 合同通用条款章节标题（GF 系列示范文本的标准通用条款，不含项目数据） */
const CONTRACT_GENERAL_TITLE_RE = /通用合同条款|合同通用条款/u;
/** 专用合同条款标题：项目数据所在章节，必须保留，同时作为通用条款章节的边界 */
const CONTRACT_SPECIAL_TITLE_RE = /专用合同条款|合同专用条款/u;
/** 通用条款章节最小规模证据：行数 ≥50 或字符数 ≥2000（防误删同名短段） */
const CONTRACT_CHAPTER_MIN_LINES = 50;
const CONTRACT_CHAPTER_MIN_CHARS = 2000;
/** 招标公告程序段标题：文件获取/递交/开标等程序性小节（何时何地操作，与施组编制无关） */
const TENDER_PROCEDURE_TITLE_RE = /招标文件的获取|投标文件的递交|投标文件递交|开标(时间|地点|方式)|投标截止/u;
/** 程序段内容证据：段内含时间/日期/时分或「获取/递交/截止/开标 + 数字」才判定为程序段 */
const PROCEDURE_TIME_HINT_RE = /\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}[:：]\d{2}|(获取|递交|截止|开标|地点).{0,20}\d/u;
/** 评标商务评审段标题：报价/商务评分细则（技术标不涉及报价，用不到） */
const BUSINESS_REVIEW_TITLE_RE = /商务(标)?(部分)?评审|报价评审|投标报价评审|商务部分|报价得分/u;
/** 技术评审线索：段内出现技术评审/施组相关关键词则不删（评标办法混合排版时商务与技术相连，宁多勿丢） */
const TECH_REVIEW_HINT_RE = /施工组织设计|技术(标)?(部分)?评审|技术部分|技术标/u;
/** 新「第X部分/编」标题（合同通用条款章节边界；通用条款标题本身不触发） */
const PART_TITLE_RE = /^第[一二三四五六七八九十百\d]+[部分编]/u;

/** 清单：纯报价表格段标题（费用汇总/暂估/规费/税金/计日工——纯商务数据；
 * 分部分项工程量清单的名称/特征/工程量是施组核心数据，不在此列，绝不删） */
const BILL_PURE_PRICING_TITLE_RE = /(单位工程)?费汇总表|其他项目清单(与计价表)?|规费|税金(项目)?|暂估(单)?价(一览表)?|暂列金额|计日工|总价措施项目/u;
/** 清单：段内金额行证据（单价/合价数字 + 元；≥2 行确认是报价数据区段） */
const BILL_PRICE_ROW_RE = /\d[\d,]*(?:\.\d+)?\s*元/u;
/** 清单：扉页签章证据（造价工程师签字/执业印章/编制单位——扉页程序性信息） */
const BILL_TITLE_PAGE_SIGN_RE = /造价(工程师)?|执业(印章)?|签章|编制单位|审核人|法定代表人/u;

/**
 * 章节级边界收集（合同通用条款）：从标题行向后收集至「专用合同条款」或下一个「第X部分/编」
 * 标题为止，返回区段结束位置与累计字符数（规模证据由调用方判定）。
 */
function collectChapterRegion(lines: string[], start: number): { end: number; chars: number } {
  let end = start + 1;
  let chars = lines[start]!.length;
  const hardLimit = Math.min(lines.length, start + 1500);
  for (let j = start + 1; j < hardLimit; j += 1) {
    const trimmed = lines[j]!.trim();
    if (CONTRACT_SPECIAL_TITLE_RE.test(trimmed) && trimmed.length < 30) break;
    if (j > start + 1 && PART_TITLE_RE.test(trimmed) && trimmed.length < 40 && !CONTRACT_GENERAL_TITLE_RE.test(trimmed)) break;
    end = j + 1;
    chars += lines[j]!.length;
  }
  return { end, chars };
}

/**
 * 段落级边界收集（公告程序段/商务评审段）：从标题行向后收集至空行段落结束或下一个
 * 「第X章/条」/中文序号标题；纯数字序号（"4.1 获取时间"）是段内条目不中断。
 * 返回区段结束位置与段内容（证据判定由调用方执行）。
 */
function collectParagraphRegion(lines: string[], start: number, maxLines = 60): { end: number; body: string } {
  let end = start + 1;
  const parts: string[] = [];
  for (let j = start + 1; j < Math.min(lines.length, start + maxLines); j += 1) {
    const trimmed = lines[j]!.trim();
    if (!trimmed) { end = j + 1; break; }
    if (j > start + 1 && /^(第[一二三四五六七八九十百\d]+[章节条部分]|[一二三四五六七八九十]+[、.．])/u.test(trimmed) && trimmed.length < 30) break;
    end = j + 1;
    parts.push(lines[j]!);
  }
  return { end, body: parts.join('\n') };
}

/** CAD 文本格式控制码（AutoCAD MTEXT/DTEXT 语法）：
 * %%U/%%O 下划线/上划线格式开关（删除，后接文本保留）、%%D/%%P/%%C 度/正负/直径符号、
 * %%% 百分号转义（「95%%%」=「95%」）。DWG/DXF 提取文本中的字段占位「%%U %%U」
 * （如「本工程叠合板均按%%U %%U设计」）是未解析的字段表达式，逐字保留会污染
 * 检索语义与生成引用，还原为可读文本。 */
const CAD_CONTROL_CODE_RE = /(%%[UuOo])|(%%[Dd])|(%%[Pp])|(%%[Cc])|(%%%)/gu;
function cleanCadControlCodes(line: string): string {
  return line.replace(CAD_CONTROL_CODE_RE, (_match, underline?: string, degree?: string, plusMinus?: string, diameter?: string) => {
    if (underline) return '';
    if (degree) return '°';
    if (plusMinus) return '±';
    if (diameter) return '∅';
    return '%';
  });
}

/**
 * K2 预扫描：整篇文档一次遍历，产出「起始行 → 待删区段」映射。
 * 三条规则均要求「标题模式 + 内容/规模证据」双重确认：
 * 1. 合同通用条款章节（不限文件类型）：标题匹配 + 章节规模 ≥50 行或 ≥2000 字符，
 *    且区段止于「专用合同条款」——项目专属数据（专用条款）绝不吞并；
 * 2. 招标公告程序段（仅招标文件）：标题匹配 + 段内含时间/地点数字证据；
 * 3. 评标商务评审细则段（仅招标文件）：标题匹配 + 段内无技术评审/施组关键词
 *    （技术评审评分细则是施组生成的得分点依据，绝不能删）。
 */
function collectSectionLevelNoise(lines: string[], docKind: DocKind): Map<number, SectionDrop> {
  const drops = new Map<number, SectionDrop>();
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (!trimmed || trimmed.length > 40) continue;
    // 1. 合同通用条款章节（通用适用）
    if (CONTRACT_GENERAL_TITLE_RE.test(trimmed)) {
      const region = collectChapterRegion(lines, i);
      if (region.end - i >= CONTRACT_CHAPTER_MIN_LINES || region.chars >= CONTRACT_CHAPTER_MIN_CHARS) {
        drops.set(i, { kind: 'contractGeneralClauseLines', end: region.end });
        // -1：让循环 ++ 后落在区段末行的下一行，继续检查该行标题（相邻区段不互跳）
        i = region.end - 1;
        continue;
      }
    }
    if (docKind === 'tender') {
      // 2. 招标公告程序段
      if (TENDER_PROCEDURE_TITLE_RE.test(trimmed)) {
        const region = collectParagraphRegion(lines, i);
        if (region.end > i + 1 && PROCEDURE_TIME_HINT_RE.test(region.body)) {
          drops.set(i, { kind: 'announcementProcedureLines', end: region.end });
          i = region.end - 1;
          continue;
        }
      }
      // 3. 评标商务评审细则段
      if (BUSINESS_REVIEW_TITLE_RE.test(trimmed)) {
        const region = collectParagraphRegion(lines, i);
        if (region.end > i + 1 && !TECH_REVIEW_HINT_RE.test(region.body)) {
          drops.set(i, { kind: 'businessReviewLines', end: region.end });
          i = region.end - 1;
        }
      }
    }
    // 4. 清单纯报价表格段（清单文件或招标文件内的清单章节）：
    //    标题 + 段内金额行 ≥2 双重证据（费汇总/暂估/规费/税金是纯商务数据；
    //    分部分项清单的名称/特征/工程量不在标题列，绝不误删）
    if ((docKind === 'bill' || docKind === 'tender') && BILL_PURE_PRICING_TITLE_RE.test(trimmed)) {
      const region = collectParagraphRegion(lines, i, 100);
      const priceRows = region.body.split('\n').filter(line => BILL_PRICE_ROW_RE.test(line)).length;
      if (region.end > i + 1 && priceRows >= 2) {
        drops.set(i, { kind: 'billPricingLines', end: region.end });
        i = region.end - 1;
        continue;
      }
    }
    // 5. 清单扉页签章段（仅清单文件）：工程量清单标题 + 造价签章证据
    if (docKind === 'bill' && /^工程量清单(扉页|封面)?$/u.test(trimmed)) {
      const region = collectParagraphRegion(lines, i, 40);
      if (region.end > i + 1 && BILL_TITLE_PAGE_SIGN_RE.test(region.body)) {
        drops.set(i, { kind: 'billTitlePageLines', end: region.end });
        i = region.end - 1;
      }
    }
  }
  return drops;
}

/** 入库前文本清洗主入口：行级保守清洗 + 目录/格式段级清洗 + 30% 整体回退保护 */
export function cleanExtractedText(input: TextCleaningInput): TextCleaningResult {
  const enabled = input.enabled ?? process.env.KB_TEXT_CLEANING !== '0';
  if (!enabled || !input.text) return { text: input.text, removedChars: 0, removedLines: 0, stats: zeroStats() };
  const docKind = detectDocKind(input.fileName || '', input.text.slice(0, 4000));
  const isCad = input.category === 'cad' || input.category === 'diagram';
  // CAD 控制码还原前置：确定性无损替换（%%U/%%O 格式开关删除、%%%→%），
  // 不参与行级启发式删除与 30% 回退保护——纯图纸文件（标高/图元行占比高）常触发
  // 回退保护使整个清洗作废，控制码还原若挂在行级规则里会随之失效
  const sourceText = isCad ? cleanCadControlCodes(input.text) : input.text;
  const lines = sourceText.split(/\r?\n/u);
  const totalLines = lines.length;

  // 全文高重复行统计（页眉/页脚/图框标题栏判定依据）
  const lineCounts = new Map<string, number>();
  for (const line of lines) {
    const key = line.trim();
    if (!key) continue;
    lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
  }

  const stats = zeroStats();
  const kept: string[] = [];
  let removedLines = 0;
  let removedChars = 0;
  let sectionRemovedChars = 0;
  const drop = (line: string, counter: (stats: TextCleanStats) => void): void => {
    removedLines += 1;
    removedChars += line.length;
    counter(stats);
  };

  // K2 章节/段落级预扫描：整篇文档一次遍历得出待删区段映射（主循环优先消费）
  const sectionDrops = collectSectionLevelNoise(lines, docKind);

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trim();

    // 0. K2 内容无关区段（章节/段落级整段删除，最高优先级，30% 回退保护兜底）
    const sectionDrop = sectionDrops.get(index);
    if (sectionDrop) {
      for (let j = index; j < sectionDrop.end; j += 1) {
        drop(lines[j]!, s => { s[sectionDrop.kind] += 1; });
        sectionRemovedChars += lines[j]!.length;
      }
      index = sectionDrop.end;
      continue;
    }

    // 1. 目录区段（「目录」标题行 + 点线占比 ≥50% + 行数 ≥4 三重证据，整区删除）
    if (TOC_TITLE_RE.test(trimmed)) {
      const region = collectTocRegion(lines, index);
      const count = region.end - index;
      if (count >= 4 && region.dotLineRatio >= 0.5) {
        for (let j = index; j < region.end; j += 1) drop(lines[j]!, s => { s.tocRegionLines += 1; });
        index = region.end;
        continue;
      }
    }

    // 2. 连续空行压缩：≥3 连续空行保留 2 个（单空行是段落分隔，留给分块器）
    if (!trimmed) {
      let run = 1;
      while (index + run < lines.length && !lines[index + run]!.trim()) run += 1;
      const keepCount = Math.min(run, 2);
      for (let k = 0; k < keepCount; k += 1) kept.push('');
      const dropped = run - keepCount;
      if (dropped > 0) { removedLines += dropped; stats.blankLines += dropped; }
      index += run;
      continue;
    }

    // 3. 页眉/页脚/图框标题栏高重复行
    if (isHeaderFooterLine(trimmed, lineCounts.get(trimmed) ?? 1)) {
      drop(line, s => { s.headerFooterLines += 1; });
      index += 1;
      continue;
    }

    // 4. 纯页码行
    if (isPageNumberLine(trimmed, totalLines)) {
      drop(line, s => { s.pageNumberLines += 1; });
      index += 1;
      continue;
    }

    // 5. 招标文件：投标文件格式模板段（段级）
    if (docKind === 'tender') {
      const blockEnd = collectTenderFormatBlock(lines, index);
      if (blockEnd > index) {
        for (let j = index; j < blockEnd; j += 1) drop(lines[j]!, s => { s.tenderFormatLines += 1; });
        index = blockEnd;
        continue;
      }
      // 招标文件：泛化引用行（行级）
      if (trimmed.length <= 60 && TENDER_GENERIC_LINE_RE.test(trimmed)) {
        drop(line, s => { s.tenderGenericLines += 1; });
        index += 1;
        continue;
      }
      // 招标文件：电子投标程序句（行级；加密/解密/上传/撤回等操作句，无时间地点证据可依）
      if (TENDER_EPROCEDURE_LINE_RE.test(trimmed)) {
        drop(line, s => { s.tenderEprocedureLines += 1; });
        index += 1;
        continue;
      }
      // 招标文件：电子投标程序句（跨行拼接；PDF 提取折行把程序动词折到下一行，行间夹空行）
      if (TENDER_EPROCEDURE_PREFIX_RE.test(trimmed)
          && !/[。；;：:！!？?]$/u.test(trimmed)) {
        let nextIdx = index + 1;
        while (nextIdx < lines.length && !lines[nextIdx]!.trim()) nextIdx += 1;
        if (nextIdx < lines.length && nextIdx - index <= 3) {
          const next = lines[nextIdx]!.trim();
          const continuation = next.length > 0 && next.length < 80 && !TENDER_CONTINUATION_HEAD_RE.test(next);
          const joined = `${trimmed}${next}`;
          if (continuation && TENDER_EPROCEDURE_LINE_RE.test(joined) && !TENDER_TIME_PLACE_RE.test(joined)) {
            drop(line, s => { s.tenderEprocedureLines += 1; });
            drop(lines[nextIdx]!, s => { s.tenderEprocedureLines += 1; });
            index = nextIdx + 1;
            continue;
          }
        }
      }
    }

    // 6. 补疑文件：零信息回复行（行级，长度 ≤25 且无数字/单位）
    if (docKind === 'clarification' && trimmed.length <= 25 && CLARIFICATION_BOILERPLATE_RE.test(trimmed) && !/\d/u.test(trimmed)) {
      drop(line, s => { s.clarificationLines += 1; });
      index += 1;
      continue;
    }

    // 7. 图纸：无汉字纯坐标数字行
    if (isCad && isCoordinateNoiseLine(trimmed)) {
      drop(line, s => { s.cadNoiseLines += 1; });
      index += 1;
      continue;
    }

    // 8. 图纸：图框标题栏信息行（图号/比例/日期/签名行）
    if (isCad && isCadTitleBlockLine(trimmed)) {
      drop(line, s => { s.cadTitleBlockLines += 1; });
      index += 1;
      continue;
    }

    // 9. 图纸：CAD 属性行（图层/颜色/线型）
    if (isCad && isCadAttributeLine(trimmed)) {
      drop(line, s => { s.cadAttributeLines += 1; });
      index += 1;
      continue;
    }

    // 10. 图纸：CAD 图元属性枚举行（管道符表格形态实体罗列）
    if (isCad && isCadEntityPropertyLine(trimmed)) {
      drop(line, s => { s.cadEntityPropertyLines += 1; });
      index += 1;
      continue;
    }

    kept.push(line);
    index += 1;
  }

  const resultText = kept.join('\n');
  // 整体回退保护（宁多勿丢）：
  // 1) 行级启发式删除导致剩余不足原文 30% → 判定误伤，回退原文；
  // 2) K2 章节级删除（标题 + 规模/内容 + 边界三重证据）置信度高，不参与 30% 判定，
  //    否则通用条款占比高的合同文件永远洗不掉；但剩余不足原文 10% 时仍整体回退（防极端全删）
  // 回退时返回 sourceText（已做 CAD 控制码还原），保证确定性还原在回退路径同样生效
  const totalChars = sourceText.trim().length;
  const remainingRatio = totalChars > 0 ? resultText.trim().length / totalChars : 1;
  const lineLevelRemovedChars = removedChars - sectionRemovedChars;
  const lineLevelSafe = lineLevelRemovedChars === 0 || remainingRatio >= 0.3;
  const extremeSafe = remainingRatio >= 0.1;
  if (removedChars > 0 && totalChars > 2000 && (!lineLevelSafe || !extremeSafe)) {
    return { text: sourceText, removedChars: 0, removedLines: 0, stats: zeroStats() };
  }
  return { text: resultText, removedChars, removedLines, stats };
}
