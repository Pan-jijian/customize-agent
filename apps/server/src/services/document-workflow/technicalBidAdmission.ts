/**
 * 技术标准入判据（单源，4.55.14 巢湖实测归因）：
 *
 * **问题**：招标文件里的内容并非技术标都要写。此前只有「资格类」带锚定词的双信号判据
 * （isBidderQualificationText），子串陷阱会让垃圾内容穿透——巢湖终稿第二章大纲实况：
 *   · 「业绩证明材料中要求提供：（2）中标查询网址及查询路径披露」——`业绩证明**材料**` 里的
 *     「材料」被技术语境词表命中，判成「有技术语境」放行；
 *   · 「我单位获得中国施工企业管理协会颁发的2022年度…」——评分表里的资信加分项，无任何判据。
 * 两者都进了正文大纲，并把该章拖到「规划块全部失败」。
 *
 * **判据设计（自带语境的强形态，不依赖锚定词）**：技术标（施工组织设计）正文只回答
 * 「这个工程怎么施工」。下列四类内容在施组正文里**不会自然出现**，命中即判非技术内容——
 * 强形态词本身即语境，无需再配「投标人资格要求」类锚定词（锚定缺失正是旧判据的漏点）：
 *   ① 投标人资格与资信：营业执照/资质证书/安全生产许可证/业绩证明/获奖/认证/财务审计/社保/行贿犯罪…
 *   ② 招标程序与评标纪律：中标查询网址/中标公示/开标记录/评标办法/投标递交/电子交易/质疑投诉/投标有效期…
 *   ③ 商务与计价：投标报价/综合单价/下浮率/暂列金额/规费税金/预付款进度款/保证金保函…
 *   ④ 合同条件：违约责任/违约金/索赔/争议解决/通用（专用）合同条款/「…的约定：」…
 *
 * **保守边界**：只判强形态，不做「含弱词即排除」——「材料进场验收」「人员配置」「设备安装」
 * 等施工内容不受影响；技术评审要点（施工方案针对性/危大工程/工期质量安全体系）仍照常响应。
 * 同一判据供四处消费（要求池入池 / 证据链 / 大纲与小节标题 / 响应分母），保证口径不分叉。
 */

export type TenderContentClass = 'technical' | 'bidder_qualification' | 'tender_procedure' | 'commercial' | 'contract_terms';

/** ① 投标人资格与资信强形态（含评分表资信加分项：获奖/业绩/认证） */
const QUALIFICATION_STRONG_RE = /业绩证明|类似(?:工程)?业绩|工程业绩|获奖(?:情况|证书|证明|材料)|荣获|协会颁发|优质工程奖|鲁班奖|杯奖(?:证书|证明)|认证证书|管理体系认证|注册资本|社保证明|社会保险证明|无行贿犯罪|行贿犯罪档案|资格审查|资格后审|资格预审|投标人资格/u;
// 证照类（营业执照/资质证书/安全生产许可证/审计报告/财务报表/信用等级）**刻意不入本判据**：
// 「资质证书技术复核」「安全生产许可证管理制度」「审计报告编制流程」「营业执照管理措施」是
// **以证照为管理对象**的技术管理内容（分包资质审查、证照台账、制度落实），属施组正文，
// 由 isQualificationSectionTitle 既有的「技术语境豁免」通道按宽技术词表判定；
// 本判据只收**在技术标里没有技术语义**的形态（业绩证明/获奖证书/资信加分项/招标程序/合同条件）。
/** 创优目标形态（技术响应项，非资信加分项）：「确保/争创/创建/实现…杯奖/奖项/优质工程」是工程
 * 质量目标承诺（施工组织设计应写），与「我单位获得…协会颁发的…杯奖」（资信获奖）区分——
 * 后者才是资格/商务内容。历史教训：创优类条目被误丢会导致「零承接」永久误报 */
const QUALITY_GOAL_RE = /(?:确保|争创|争获|创建|实现|达到|荣获?(?:目标)|力创|目标)[^。；;]{0,12}(?:杯奖|奖项|优质工程|鲁班奖|詹天佑奖|省优|市优)/u;

/** ② 招标程序与评标纪律强形态 */
const PROCEDURE_STRONG_RE = /中标查询|中标公示|中标结果(?:查询|公示|公告)|中标候选人公示|开标记录|开标一览表|评标办法|评标委员会|评标标准|评标程序|评标价|定标程序|中标通知书|投标文件(?:递交|上传|加密|解密|编制)|电子交易系统|公共资源交易|质疑(?:投诉|渠道|答复)|投诉(?:渠道|受理|处理)|投标有效期|投标截止|澄清(?:函|通知)|补遗书|答疑澄清/u;

/** ③ 商务与计价强形态 */
const COMMERCIAL_STRONG_RE = /投标报价|报价明细|综合单价|下浮率|暂列金额|暂估价|计日工|规费|税金|税率|增值税|预付款(?:比例|支付|申请)|进度款(?:支付|申请|计量)|履约保证金|投标保证金|投标担保|电子保函|价格波动调整|材料调差/u;

/** 声明/承诺碎片（评分表条目的截断产物，非施组小节）：「我公司计划参与招标项目名称：…」类片段
 * 一旦被补挂成小节，正文会写出无技术语义的声明句（巢湖实测：该碎片进入第一章小节清单）。 */
const DECLARATION_FRAGMENT_RE = /^(?:我|本)(?:公司|单位|方|投标人|项目部)(?:计划|承诺|将|拟)/u;

/** ④ 合同条件强形态 */
const CONTRACT_STRONG_RE = /违约责任|违约金|索赔(?:期限|程序|条款|意向)|争议解决|合同解除|通用合同条款|专用合同条款|(?:特别|有关)约定[:：]|(?:的)约定[:：]/u;

/** 分类（强形态优先，命中即返回；全不命中 → technical） */
export function classifyTenderContent(text: string): TenderContentClass {
  const normalized = String(text || '').trim().replace(/\s+/gu, '');
  if (!normalized) return 'technical';
  // 创优目标（确保/争创…杯奖）是技术响应项，优先于资信获奖判据
  if (QUALITY_GOAL_RE.test(normalized)) return 'technical';
  if (DECLARATION_FRAGMENT_RE.test(normalized)) return 'contract_terms';
  if (PROCEDURE_STRONG_RE.test(normalized)) return 'tender_procedure';
  if (QUALIFICATION_STRONG_RE.test(normalized)) return 'bidder_qualification';
  if (COMMERCIAL_STRONG_RE.test(normalized)) return 'commercial';
  if (CONTRACT_STRONG_RE.test(normalized)) return 'contract_terms';
  return 'technical';
}

/** 技术标正文可写判定（= 分类为 technical） */
export function isTechnicalBidAdmissible(text: string): boolean {
  return classifyTenderContent(text) === 'technical';
}

/** 非技术类内容的中文标签（报告/审计/复核清单展示用） */
export const TENDER_CONTENT_CLASS_LABEL: Record<Exclude<TenderContentClass, 'technical'>, string> = {
  bidder_qualification: '投标人资格与资信（属资格文件/商务标）',
  tender_procedure: '招标程序与评标纪律（属招标程序约定）',
  commercial: '商务与计价（属商务标）',
  contract_terms: '合同条件（属合同文件）',
};

/**
 * 资信加分项判定（评分表条目专用）：招标文件把业绩/获奖/认证类放进**施工组织设计评分表**时，
 * 按用户口径「按招标要求响应，但限定形态」——不得编成施工小节（会污染技术标正文、暗标触红线），
 * 只允许以承诺句/证明材料清单形态承载；暗标时一律剔除。
 * 与 classifyTenderContent 的资格类区别：本判据只收**资信类**（业绩/获奖/认证/信用/注册资本），
 * 不含营业执照/资质证书/安全生产许可证（后者属资格文件，任何形态都不进技术标）。
 */
export function isCreditScoringContent(text: string): boolean {
  const normalized = String(text || '').trim().replace(/\s+/gu, '');
  if (!normalized) return false;
  if (QUALITY_GOAL_RE.test(normalized)) return false;
  return /业绩|获奖|奖项|荣获|协会颁发|优质工程奖|杯奖|认证证书|管理体系认证|信用等级|信用评价|注册资本|财务报表|审计报告/u.test(normalized);
}
