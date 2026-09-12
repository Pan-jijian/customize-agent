import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { DocumentTemplate, DocumentTemplateChapter } from './types';
import { CN_NUMERAL_RE } from './constants';
import { violatesConfiguredChapterTitleFilter, violatesConfiguredChapterTitleForbiddenFilter } from './templateStore';

/** 复选框/对勾/圈符：招标文件选项符号，不属合法中文小节标题字符（评分报告 P5：目录「8.2 ☑电子保函」
 * 串章回归根因——投标保证金条款原文连同复选框符号被 LLM 带入小节标题）；
 * 大纲提取/显式章节/规划标题三通道统一剥离（单一来源，禁止各文件私造第二份符号表） */
function stripCheckboxSymbols(title: string) {
  return title.replace(/[☑✓✔☐□☒○●◉◇◆]/gu, '');
}

function cleanOutlineTitle(title: string) {
  let cleaned = stripCheckboxSymbols(title.trim());
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
  // 数据值+括号指令标题（舒城实测：「26元（保留两位小数）」——招标条款计算结果/数值参数被 LLM
  // 直接写为小节标题；特征为数字+货币/计量单位+括号内含指令性动词（保留/计算/填写/详见/按…计），
  // 合法施组小节标题不会以纯数据值命名，括号内更不会含指令性措辞）
  if (/\d+(?:元|万元|㎡|m[²3]?|km|m|cm|mm|kg|t|L|㎡|立方米|平方米|公顷|亩|度|kPa|MPa)[（(](?:保留|计算|填写|详见|见|按|不得|应|须)/u.test(normalized)) return true;
  // 冒号后条款义务句式（舒城实测：「隐蔽工程验收：所有隐蔽工程验收必须由承包人按规定」——
  // 招标条款原文被 LLM 截断为小节标题；topic 后冒号分隔的从句含「必须由/应由/须由」义务句式，
  // 施组小节标题不用冒号引出条款义务陈述；宽松匹配：冒号后任意内容+义务助动词即判条款碎片）
  if (/[：:].{0,30}(?:必须由|应由|须由)/u.test(normalized)) return true;
  // 截断介词结尾（舒城实测：「…必须由承包人按规定」「…必须由施工方按规定」——条款义务句被截断，
  // 标题以介词/助动词「由/按/须」收尾且前文含义务标记（必须/应/须），合法标题不以截断介词结尾）
  if (/(?:必须|应|须|需).{0,30}(?:由|按|须)$/.test(normalized)) return true;
  // 条款编号引用句式（舒城实测：「11.5 1.1条的规定另行交纳履约保证」——合同条款
  // 「按第X.X条的规定另行交纳履约保证(金)」被 LLM 截断为小节标题；特征为条款编号
  // 「X.X条/款」或「第X.X条」+「的规定/约定」，施组小节标题不会引用合同条款编号）
  if (/(?:\d+(?:\.\d+)*|第\d+(?:\.\d+)*)条(?:款)?的?(?:规定|约定)/u.test(normalized)) return true;
  // 条款义务动作句式（舒城实测同源：「另行交纳履约保证」——「另行交纳/缴纳」为合同条款
  // 义务动作措辞，施组小节标题不以「另行+义务动词」命名）
  if (/另行(?:交纳|缴纳|支付|提交|办理|承担|履行)/u.test(normalized)) return true;
  // 内部占位桶标签（舒城实测：「未分部条目」——大纲规划器内部未分桶标签被 LLM 直接写为
  // 小节标题；「未分部/未分类/未分组/未归类/未划分」是规划器内部状态词，不构成交付标题）
  if (/^未(?:分部|分类|分组|归类|划分|分配)/u.test(normalized)) return true;
  // 乱码标题（4.12.14 用户自跑资料回归）：资料二进制/编码误读文本被提取为章节标题混入目录
  return isLikelyMojibakeTitle(normalized);
}

/**
 * 乱码标题判别：PDF/旧版 Office/CAD 二进制误读文本被大纲提取器当章节标题后混入目录——
 * 「考堂f肀」「渱潑喲W晀耀」「VdA«UdA»」「爀攀最椀猀琀礀」等形态；合法小节标题由常用汉字/
 * 数字/工程符号构成，不会命中。工程后缀搭配（门窗K值、B级混凝土）豁免汉字-拉丁交叉规则。
 */
export function isLikelyMojibakeTitle(title: string) {
  // Markdown 强调符号不是乱码特征：先剥首尾星号再判（「**注意：**」「**注意事项**」等粗体
  // 标题行曾被可读字符占比规则误判为乱码——4 星 + 4 字 readable=0.5 < 0.6，被 sanitize
  // 标题过滤误删；粗体包裹合法标题应与纯文本标题同判）
  const compact = title.replace(/\s+/gu, '').replace(/^\*+|\*+$/gu, '');
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

/** 规划小节标题归一化：剥章节编号前缀、句尾标点、英文括号注释等规划模型残留。
 * （原 promptRuleExtraction 迁入：constructionBidStructure 补挂链需同口径判定，
 * 而 promptRuleExtraction 依赖 constructionBidStructure，迁移打破循环依赖） */
export function normalizePlannedSectionTitle(title: string) {
  return displayChapterTitle(title.replace(/\*+/gu, ''))
    .replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分、.．\s-]*/u, '')
    .replace(/^\d+(?:\.\d+)*(?:[.．、]|\s)+/u, '')
    .replace(/^[-—–]\s*/u, '')
    .replace(/[<>]/gu, '')
    .replace(/[：:。；;,.，]+$/gu, '')
    // 清理规划模型残留的英文括号注释（如 "(or use numbering consistent with the outline)"），避免注释进入目录与正文标题
    .replace(/\s*[（(][^（）()]{0,40}[a-zA-Z]{3,}[^（）()]{0,40}[)）]\s*$/u, '')
    .trim();
}

/**
 * 条款碎片/指令泄漏型小节标题判别（第十六版评审 B 类标题硬伤拦截）：
 * 招标文件条款文本被截断（数字前缀残留/合同条款片段/逗号链单字结尾）或模板编排指令泄漏
 * （「每个单位工程独立制表」）成为节标题时判定为碎片，规划器与补写链同口径剔除。
 * （原 promptRuleExtraction 迁入，供评分条目提取、大纲出口清洗与补挂拦截共用）
 */
export function isFragmentLikeSectionTitle(title: string): boolean {
  const normalized = normalizePlannedSectionTitle(title).replace(/\s+/gu, '');
  if (!normalized) return true;
  // 1) 数字前缀残留（「2发包人代表…」数字后直接接汉字无分隔，normalize 剥不掉）
  if (/^\d+[^\d.．、]/u.test(normalized)) return true;
  // 2) 合同条款文本片段泄漏（「发包人代表的任何批准、检查、证书、同意、通」类截断条款）
  if (/^(?:发包人代表|任何批准|计量与支付|变更与索赔|缺陷责任|竣工验收程序|违约责任|争议解决|合同价格)/u.test(normalized)) return true;
  // 2.5) 投标承诺断言句式（舒城实测：「我公司对该表提供的内容及相关资料均属实」——投标函
  // 承诺句被评分条目提取器当条目后补挂为小节标题；施组小节标题是名词短语，不作第一人称断言）
  if (/^(?:我(?:方|公司|单位)|本单位|本公司).{0,20}(?:承诺|保证|均属实|均真实|均有效|承担)/u.test(normalized)) return true;
  // 3) 模板编排指令泄漏（「每个单位工程独立制表」类指令语态）
  if (/独立制表|单独制表|分别编制|逐一编制|另行编制|单位工程独立|分单位工程/u.test(normalized)) return true;
  // 4) 逗号链+单字截断结尾（条款列举被截断作标题，如「…、同意、通」）
  if (/[、，,]/u.test(normalized) && normalized.length >= 10 && /^[\u4e00-\u9fa5]$/u.test(normalized.slice(-1))) {
    const tail = normalized.split(/[、，,]/u);
    if (tail.length >= 3 && tail[tail.length - 1].length === 1) return true;
  }
  // 5) 数据值+括号指令标题（舒城实测：「26元（保留两位小数）」normalize 后为「26元保留两位小数」——
  // 招标条款计算结果被 LLM 写为小节标题；数字+货币/计量单位+括号内指令性动词）
  if (/\d+(?:元|万元|㎡|m[²3]?|km|m|cm|mm|kg|t|L|立方米|平方米|公顷|亩|度|kPa|MPa)[（(](?:保留|计算|填写|详见|见|按|不得|应|须)/u.test(normalized)) return true;
  // 6) 冒号后条款义务句式（舒城实测：「隐蔽工程验收：所有…必须由承包人按规定」normalize 后冒号被剥离，
  // 但义务句式「必须由/应由/须由」保留；施组小节标题不会含条款义务陈述）
  if (/(?:必须由|应由|须由)/u.test(normalized)) return true;
  // 7) 截断介词结尾（舒城实测：标题以「由/按/须」收尾且前文含义务标记，合法标题不以截断介词结尾）
  if (/(?:必须|应|须|需).{0,30}(?:由|按|须)$/.test(normalized)) return true;
  // 8) 条款编号引用句式（舒城实测：「1.1条的规定另行交纳履约保证」——合同条款「按第X.X条
  // 的规定另行交纳履约保证(金)」被 LLM 截断为小节标题；施组小节标题不会引用合同条款编号）
  if (/(?:\d+(?:\.\d+)*|第\d+(?:\.\d+)*)条(?:款)?的?(?:规定|约定)/u.test(normalized)) return true;
  // 9) 条款义务动作句式（舒城实测同源：「另行交纳履约保证」——「另行交纳/缴纳」为合同条款
  // 义务动作措辞，施组小节标题不以「另行+义务动词」命名）
  if (/另行(?:交纳|缴纳|支付|提交|办理|承担|履行)/u.test(normalized)) return true;
  // 10) 内部占位桶标签（舒城实测：「未分部条目」——大纲规划器内部未分桶标签被 LLM 直接
  // 写为小节标题；「未分部/未分类/未分组/未归类/未划分」是规划器内部状态词，非交付标题）
  if (/^未(?:分部|分类|分组|归类|划分|分配)/u.test(normalized)) return true;
  // 11) 句子型逗号长链（舒城实测：招标评分表 PDF 断裂文本「5 分力投入经济合理，满足施工需要」
  // 被评分条目承接审计补挂为小节标题；施组小节标题以名词短语命名，句子长评不是标题）——
  // 逗号分句含 ≥7 字长句字段即判句子；合法顿号列举条目（「拟采用的新技术、新工艺」）不命中
  const commaFields = normalized.split(/[、，,]/u).filter(Boolean);
  if (commaFields.length >= 2 && commaFields.some(field => field.length >= 7)) return true;
  return false;
}

function isInvalidOutlineTitle(title: string) {
  return title.trim().length === 0 || isInstructionLikeOutlineTitle(title);
}

/** OUTLINE 解析项：sectionCandidate 标记二级小节候选（多级编号 1.1 / 括号编号（1）/ 缩进行） */
interface OutlineParsedTitle {
  title: string;
  sectionCandidate: boolean;
  kind: 'numbered' | 'dotted' | 'paren' | 'indent' | 'plain';
}

const OUTLINE_DOTTED_ITEM_RE = /^[（(]?\d{1,3}(?:[.．]\d{1,3})+(?:[.．、）)]|\s+|[一-龥])/u;
const OUTLINE_PAREN_ITEM_RE = /^[（(]\d{1,3}[)）]/u;
const OUTLINE_INDENT_RE = /^(?: {2,}|\t)/u;
const OUTLINE_NUMBERED_ITEM_RE = new RegExp(`^(?:第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]|\\d{1,3}[、)）]|\\d{1,3}[.．]\\s|(?:${CN_NUMERAL_RE})[、.．)）])`, 'u');

/** 单行 OUTLINE 项解析：多级编号/括号编号识别为二级小节候选；同名类标记连续出现由调用侧维持平铺章语义 */
function parseOutlineTitleLine(rawLine: string): OutlineParsedTitle | null {
  const line = rawLine.replace(/\u3000/gu, '  ');
  const trimmed = line.replace(/^[-*+]\s+/u, '').trim();
  if (!trimmed) return null;
  const title = cleanOutlineTitle(rawLine);
  if (!title || isInvalidOutlineTitle(title)) return null;
  if (OUTLINE_DOTTED_ITEM_RE.test(trimmed)) return { title, sectionCandidate: true, kind: 'dotted' };
  if (OUTLINE_PAREN_ITEM_RE.test(trimmed)) return { title, sectionCandidate: true, kind: 'paren' };
  if (OUTLINE_NUMBERED_ITEM_RE.test(trimmed)) return { title, sectionCandidate: false, kind: 'numbered' };
  if (OUTLINE_INDENT_RE.test(line)) return { title, sectionCandidate: true, kind: 'indent' };
  return { title, sectionCandidate: false, kind: 'plain' };
}

/**
 * OUTLINE 块两级解析（组件 3）：`1.1 xx`、`（1）xx`、缩进行识别为二级小节候选并携带 kind，
 * 由调用侧挂靠最近的章；纯平铺行为不变（无二级标记时逐行输出章，与旧实现逐字一致）。
 * 多级编号 `1.1` 在预处理阶段同时作为分行标记，行内混排的 `1.1 xx` 也能被切出。
 */
function outlineItemsFromBlock(content: string): OutlineParsedTitle[] {
  const cnOrder = `${CN_NUMERAL_RE}`;
  const markers = [
    `第(?:\\d{1,3}|${cnOrder})[章节]\\s*`,
    `(?:\\d{1,3}[.．]){1,2}\\d{1,3}[.．、）)]?(?=\\s|[一-龥])`,
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
    .map(line => parseOutlineTitleLine(line))
    .filter((item): item is OutlineParsedTitle => Boolean(item));
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
  let lastChapterKind: OutlineParsedTitle['kind'] | null = null;
  const normalizeKey = (title: string) => title.replace(/\s+/gu, '');
  for (const block of extractOutlineBlocks(text, options)) {
    for (const item of outlineItemsFromBlock(block)) {
      const current = chapters[chapters.length - 1];
      // 两级解析：二级小节标记（1.1 / （1）/ 缩进）挂靠最近的章；纯平铺行为不变——
      // 与上一章同类的小节标记连续出现（如（1）（2）（3）连排、同级缩进连排）维持原「平铺=章」语义
      if (current && item.sectionCandidate && lastChapterKind && lastChapterKind !== item.kind) {
        if (normalizeKey(item.title) !== normalizeKey(current.title) && !(current.sections || []).some(section => normalizeKey(section) === normalizeKey(item.title))) {
          current.sections = [...(current.sections || []), item.title];
        }
        continue;
      }
      chapters.push({
        id: `explicit-${source}-${chapters.length + 1}`,
        title: item.title,
        purpose: `根据显式大纲章节生成正式正文：${item.title}`,
        requiredFacts: [],
        sections: [],
        queries: [item.title],
      });
      lastChapterKind = item.kind;
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
  let cleaned = stripCheckboxSymbols(title.replace(/^#+\s*/u, '').trim());
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
