import { buildSemanticSimilarity } from './semanticSimilarity';
import { buildSemanticGate } from './semanticGate';
import { isTenderClauseFragmentTitle } from './outline';
import type { DocumentEvidence, DocumentTemplateChapter } from './types';

/**
 * 证据内容安全过滤（输入层源头断流）：投标/评标纪律、评标办法、商务报价类证据根本不应进入
 * 大纲规划与章节写作的模型输入（评分报告 P1 串章根因：招标文件"纪律和监督"章节证据一路进入
 * 大纲 LLM 与写手 LLM，生成后清洗管道只能词面补救，且标题行豁免导致 6 个小节漏网）。
 *
 * 设计边界：
 * 1. 词面特征只做召回触发（短路优化），判定由本地 bge 嵌入余弦相似度完成——禁止纯词面判定
 *    （词面变体如"对与评标活动有关的工作人员的纪律要求""评审争议处理与澄清配合"不含禁写词，
 *    历史词面清洗全部漏网）；
 * 2. 语义模型恒可用：空候选由 buildSemanticSimilarity 恒零函数承接，无"语义不可用即跳过过滤"
 *    的降级分支（过滤失效必须显性暴露而非静默放行）；
 * 3. 放行保护：劳动纪律/质量纪律/安全纪律等施工合法内容与投标程序原型相似度低，且与施工
 *    语义原型相似度更高，双向比对后放行——过滤函数导出供单测覆盖负例集；
 * 4. 系统侧消费通道（tenderRequirements 提取、评分标准条目提取）不走本过滤，直读全文不受影响。
 */

/** 投标程序/评标纪律/商务报价类语义原型（判定为"不应进入施工写作模型输入"的内容基准） */
const BID_PROCEDURE_SEMANTIC_PROTOTYPES = [
  '对与评标活动有关的工作人员的纪律要求',
  '评标委员会成员与投标人接触的限制',
  '评标纪律与廉洁从业承诺要求',
  '评审争议处理与投标澄清配合程序',
  '评审结果确认与中标公示流程',
  '评标办法与分值构成说明',
  '异常低价评审与计算方式说明',
  '清单计量与报价口径约定',
  '投标文件实质性响应要求',
  '投标保证金缴纳与退还程序',
  '开标程序与投标文件递交截止时间',
  '评标期间行为管控与资料闭环',
  // 批2-2 商务合同条款类（V2 1.1：预付款/担保/保证金/价格波动/暂列金额/计税/发票/违约）——
  // 商务条款属商务文件内容，素材切片进写作链即产生「商务数据入正文」与自降专业性双重问题，
  // 输入层断流（与 detectors.ts 商务检测/清洗层同域不同层：此处治源头不产，输出层为安全网）
  '预付款与进度款支付比例约定',
  '履约担保与保证金缴纳退还约定',
  '价格波动与合同价款调整约定',
  '暂列金额与暂估价使用约定',
  '税费计取与发票结算约定',
  '违约责任与罚款赔偿条款',
] as const;

/** 施工技术/管理类语义原型（放行保护基准：合法施工内容与其相似度更高时不排除） */
const CONSTRUCTION_SEMANTIC_PROTOTYPES = [
  '劳动力配置计划与高峰期人数安排',
  '施工质量保证措施与验收标准',
  '安全生产管理与教育培训要求',
  '施工进度计划与关键线路安排',
  '材料设备采购进场计划与检验要求',
  '施工现场文明施工与环境保护管理',
  '劳动纪律与班组作业管理制度',
  '施工机械设备配置与维护保养计划',
  // 批2-2 商务词面相邻的施工合法内容（负例保护）：工资支付/材料采购/工期奖惩是施组合法主题，
  // 防「农民工工资支付保障」「材料采购验收」「进度奖惩承诺」被商务条款原型误排
  '农民工工资支付保障与劳务实名制管理',
  '材料采购质量证明与进场验收管理',
  '工期承诺与进度考核奖惩管理',
] as const;

/**
 * 词面召回特征：命中仅触发语义复核（不直接判定）。
 * 覆盖禁写词（utils.ts BID_DISCIPLINE_PHRASES 同口径）与无禁词词面变体的语境词
 * （实测评分报告原文"我公司对参与本项目投标及施工组织设计编制的工作人员实行严格的
 * 纪律管理"无任何禁词词面；"评审争议处理与澄清配合"标题同理）。
 */
const BID_PROCEDURE_LEXICAL_HINTS_RE = /评标|投标|行贿|打招呼|递条子|廉洁|串标|围标|弄虚作假|干扰评标|纪律|澄清|中标|报价|清单计量|评审|保证金|开标|递交|争议|异常低价|评标基准价|预付款|进度款|担保|价格波动|材料调差|暂列金额|暂估价|计税|税金|发票|违约/u;

/** 语义判定阈值：与 SEMANTIC_COVERAGE_THRESHOLD 同值（bge 余弦 ≥0.6 视为语义命中） */
const EVIDENCE_SAFETY_THRESHOLD = 0.6;

/** 证据判定样本：sectionTitle + 正文开头 400 字（证据内容常为长切片，判定只需开头语义） */
function evidenceSample(item: DocumentEvidence): string {
  const title = item.sectionTitle?.trim() || '';
  const body = (item.content || '').replace(/\s+/gu, ' ').slice(0, 400);
  return title ? `${title}。${body}` : body;
}

export interface EvidenceSafetyPartition {
  /** 放行证据：可进入大纲规划、事实提取、项目图谱与章节写作 */
  safe: DocumentEvidence[];
  /** 排除证据：投标/评标纪律、评标办法、商务报价类，仅系统侧提取通道可直读 */
  excluded: DocumentEvidence[];
}

/**
 * 证据安全判定 key：写作链证据（pinned 注入/搜索召回）多为 allEvidence 条目的浅拷贝，
 * 引用比较不可靠；以 filePath + sectionTitle（空则内容前 60 字）作内容指纹比对。
 */
export function evidenceSafetyKey(item: DocumentEvidence): string {
  const title = item.sectionTitle?.trim() || item.content.replace(/\s+/gu, '').slice(0, 60);
  return `${item.filePath}::${title}`;
}

/**
 * 按内容安全分区证据：词面召回候选 → bge 语义复核（与投标程序原型余弦 ≥ 阈值，
 * 且不高于施工语义原型相似度时排除）。
 * @param embedDocuments 单测注入的嵌入实现（替代本地模型），生产环境不传
 */
export async function partitionEvidenceByContentSafety(
  evidence: DocumentEvidence[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<EvidenceSafetyPartition> {
  if (evidence.length === 0) return { safe: [], excluded: [] };
  // 词面召回：未命中即放行（短路，不触发语义模型）
  const candidates = evidence.filter(item => BID_PROCEDURE_LEXICAL_HINTS_RE.test(evidenceSample(item)));
  if (candidates.length === 0) return { safe: [...evidence], excluded: [] };
  const samples = candidates.map(evidenceSample);
  // 双向语义比对：投标程序相似度 vs 施工语义相似度（恒可用，空候选由恒零函数承接，无降级分支）
  const bidSimilarity = await buildSemanticSimilarity(samples, [...BID_PROCEDURE_SEMANTIC_PROTOTYPES], embedDocuments);
  const constructionSimilarity = await buildSemanticSimilarity(samples, [...CONSTRUCTION_SEMANTIC_PROTOTYPES], embedDocuments);
  const excludedSet = new Set<DocumentEvidence>();
  for (const item of candidates) {
    const sample = evidenceSample(item);
    const bidScore = Math.max(...BID_PROCEDURE_SEMANTIC_PROTOTYPES.map(prototype => bidSimilarity(sample, prototype)));
    const constructionScore = Math.max(...CONSTRUCTION_SEMANTIC_PROTOTYPES.map(prototype => constructionSimilarity(sample, prototype)));
    // 命中投标程序语义，且施工语义不强于投标程序语义才排除——劳动纪律/质量纪律句放行
    if (bidScore >= EVIDENCE_SAFETY_THRESHOLD && bidScore > constructionScore) excludedSet.add(item);
  }
  return {
    safe: evidence.filter(item => !excludedSet.has(item)),
    excluded: [...excludedSet],
  };
}

/**
 * 构建"投标程序/评标纪律"语义判定器：与证据过滤同口径的双向比对（投标程序原型相似度 ≥ 阈值，
 * 且严格高于施工语义原型相似度才算命中），供生成后清洗层（stripBidDisciplineSentencesSemantic）复用。
 * 嵌入与余弦计算统一经 semanticGate 入口实现（禁止自行实现嵌入逻辑），判定对象是 LLM 生成正文
 * （构建时未知），不能依赖 buildSemanticSimilarity 的预嵌入缓存（缓存未命中恒 0）。
 * 语义模型恒可用：提供者构造失败直接抛出，无"语义不可用跳过过滤"的降级分支。
 * @param embedDocuments 单测注入的嵌入实现（替代本地模型），生产环境不传
 */
export async function buildBidProcedureJudge(
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<(texts: string[]) => Promise<boolean[]>> {
  return buildSemanticGate({
    prototypes: [...BID_PROCEDURE_SEMANTIC_PROTOTYPES],
    negativePrototypes: [...CONSTRUCTION_SEMANTIC_PROTOTYPES],
    threshold: EVIDENCE_SAFETY_THRESHOLD,
    embedDocuments,
  });
}

/** 大纲小节主题过滤阈值：标题与投标程序原型余弦 ≥ 此值且高于章主题相似度时剔除 */
const OFF_TOPIC_SECTION_THRESHOLD = 0.6;

/** 归一化标题 key：去空白与标点（用于与投标程序原型精确比对，原型即禁止内容基准） */
function normalizeSectionTitleKey(title: string) {
  return title.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

/** 声明句截断小节（真实生成回归）：招标文件表格声明句被 LLM 截断成小节名
 * （「我公司对该表提供的内容及相关资料均属」等），主语+承担声明形态，非施工技术内容；
 * 「投标承诺函」「对业主的承诺」等正常承诺小节不含承接声明结尾，零误杀 */
const DECLARATION_FRAGMENT_SECTION_RE = /^(?:我公司|本公司|我方|投标人|供应商|承包人)(?:就|对)[^，。；]{0,22}(?:均属|属实|真实有效|承担|负责|无异议|为准)$/u;

/**
 * 小节标题硬黑名单判定（确定性，黑名单语义——该词面组合本身禁出现，不依赖语义模型；
 * 真实生成回归：语义模型不可用（恒零承接）或章主题相似度干扰时语义判定放行纪律小节，
 * 导致纪律证据被输入层过滤后小节失去事实支撑 → 章节任务未就绪失败，故硬剔除层必须存在）：
 * 1. 招标条款碎片标题（编号前缀/承诺断言/条件从句/委员会动作等，与 outline.ts 同口径）；
 * 2. 与投标程序原型归一化精确相等；
 * 3. 程序词 × 管理词组合（评标/投标/开标/中标/评审 + 纪律/监督/争议/澄清/公示等）。
 * 施工合法小节（劳动纪律/质量纪律/安全纪律/技术澄清）不含程序词，零误杀。
 */
export function isHardBannedSectionTitle(title: string): boolean {
  const normalized = title.trim().replace(/\s+/gu, '');
  if (!normalized) return true;
  if (isTenderClauseFragmentTitle(normalized)) return true;
  if (DECLARATION_FRAGMENT_SECTION_RE.test(normalized)) return true;
  const key = normalizeSectionTitleKey(normalized);
  if (BID_PROCEDURE_SEMANTIC_PROTOTYPES.some(prototype => normalizeSectionTitleKey(prototype) === key)) return true;
  // 农民工工资保证金/工资保证金是工资保障章合法施工内容，非商务条款：程序词检测前先剥离，
  // 防「工资保证金缴纳与退还管理办法」（保证金+办法）被通用程序+治理双词分支误杀（P1 回归根因）
  const procedureText = normalized.replace(/农民工工资保证金|工资保证金/gu, '');
  const hasProcedure = /评标|投标|开标|中标|评审|保证金|串标|围标|廉洁|询标|递交/u.test(procedureText);
  const hasGovernance = /纪律|监督|争议|澄清|程序|行为|管控|限制|接触|公示|承诺|响应|办法/u.test(normalized);
  if (hasProcedure && hasGovernance) return true;
  // 商务条款小节硬黑名单（评分报告 P5 目录「8.2 ☑电子保函」串章根因 + P3「异常低价计算方式」回归）：
  // 电子保函/投标保证金/履约担保/异常低价类小节属商务文件内容，非施组技术正文；
  // 农民工工资保证金是工资保障章合法施工内容，技术语境词（农民工/工资/专用账户/实名）豁免，不得误杀。
  if (/异常低价|评标基准价/u.test(normalized)) return true;
  if (/电子保函|保函|投标保证金|履约担保|履约保证金|保证金(?:的)?(?:缴纳|退还|提交|方式)/u.test(normalized)) {
    if (!/农民工|工资|专用账户|实名|考勤|劳资/u.test(normalized)) return true;
  }
  // 批2-2 商务合同条款类小节硬黑名单（与证据层商务原型同源口径）：预付款/进度款/价格波动/
  // 暂列金额/材料调差/税费发票/违约类小节属商务条款，非施组技术正文；「价格波动风险管控」等
  // 施工侧表达不含商务后缀组合（调整/约定），零误杀
  if (/暂列金额|暂估价|材料调差/u.test(normalized)) return true;
  if (/预付款(?:支付|比例|约定|申请|保函)|进度款(?:支付|申请|计量|约定)|履约担保/u.test(normalized)) return true;
  if (/价格波动(?:调整|约定)|违约金(?:条款|约定)|计税|税金(?:计取|结算)|发票(?:开具|结算)/u.test(normalized)) return true;
  // 资格审查类小节硬黑名单（目录污染根因）：模板自带「具备有效的营业执照」「具备有效的资质证书、
  // 具备有效的安全生产许可证」「财务状况证明」「业绩证明」等投标人资格条件小节属招标文件资格审查
  // 内容，非施工组织设计正文。词面组合本身禁出现（不依赖语义模型），施工技术语境词放行防误杀
  // （真实生成回归：6.6/6.7 资格条件小节穿透两级大纲过滤进入最终目录）
  return isQualificationSectionTitle(normalized);
}

/**
 * 资格类小节标题判定（isHardBannedSectionTitle 的资格类分支独立导出）：
 * 供生成后检测器（bidderQualificationSectionIssues）与确定性删除同源复用——
 * 生成前大纲过滤与生成后 Final Gate 检测必须同一口径，防「过滤已拦但检测放行」的口径漂移。
 */
export function isQualificationSectionTitle(title: string): boolean {
  const normalized = title.trim().replace(/\s+/gu, '');
  if (!normalized) return false;
  // 1.4 形态 A 句式级判别（与 outline.ts isTenderClauseFragmentTitle 同口径，防「生成前已拦、生成后放行」口径漂移）：
  // 先去小节编号前缀（6.6 具备有效的…），资格义务句式覆盖词表外证照（如「具备有效的食品经营许可证」）
  const stripped = normalized.replace(/^\d{1,3}(?:[.．]\d{1,3})*[、.．]?/u, '');
  if (/^具备(?:有效|相应|满足)/u.test(stripped)) return true;
  if (/^(?:须|应|需|得)?提供[^，,。；]{0,12}(?:证明|材料|文件|证件|证书|报告)/u.test(stripped)) return true;
  const hasQualification = /营业执照|资质证书|安全生产许可证|资格预审|资格审查|资质审查|财务状况|业绩证明|业绩要求|银行资信|审计报告|信用记录|信用评价|不良行为记录|联合体投标|联合体协议/u.test(normalized);
  if (!hasQualification) return false;
  const hasTechnicalContext = /施工|技术|方案|措施|管理|控制|验收|工艺|流程|计划|组织|进度|质量|工期|文明|绿色|环保|节能|材料|设备|机械|人员|劳务|检验|检测|试验|保证|落实|制度/u.test(normalized);
  return !hasTechnicalContext;
}

/**
 * 投标人资格条件类要求条款判定（与 isHardBannedSectionTitle 资格类词面同源，作用于要求条款而非小节标题）：
 * 招标文件资格审查条款（「投标人资质要求：具备有效的营业执照…」「财务状况要求…」等）属投标人资格条件，
 * 不是施组技术正文应响应的实质要求——路由/写作规则注入/零响应检测/大纲校准全部排除。
 * 双信号判定：投标人资格语境锚定词 + 资格条件词；无锚定不判定（正文合法提到「安全生产许可证」不误伤）。
 * 真实生成回归根因：合肥师范「投标人资质要求：具备有效的营业执照…」被语义分类为 responsive →
 * 路由到安全文明章 → 写作时新增 6.6/6.7 资格条件小节，目录与正文双重污染。
 */
export function isBidderQualificationText(text: string): boolean {
  const normalized = text.trim().replace(/\s+/gu, '');
  if (!normalized) return false;
  const hasBidderAnchor = /投标人|投标方|承包人资格|资格要求|资格审查|资格预审|资质要求|资质条件|资质等级|资格条件|财务状况|业绩要求|业绩证明|信用要求|联合体/u.test(normalized);
  if (!hasBidderAnchor) return false;
  // r8 扩围（实机 #2 复核：社保证明条款漏网）：「技术负责人…连续三个月社保缴费证明…社保缴纳单位应当是投标人」
  // 是资格审查材料条款（投标资格文件），非施组技术响应要求——资格词表补「社保」族
  // r11 扩围（丰乐镇门禁 #3「人员管理 ☑」直坠归因）：执业资格类证照同族漏网——「具备…二级及以上
  // 注册建造师，具备…安全生产考核合格证书（B证），且必须是本单位人员」是投标人资格材料条款，
  // 语义判定 0.57 边缘分（正文仅在机械章提「一级建造师」错位句）无法稳定判响应——资格词表补
  // 「注册建造师/建造师注册证书/安全生产考核合格证书/职称证书」执业资格族，词面出池断根
  const hasQualificationTerm = /营业执照|资质证书|安全生产许可证|级及以上资质|注册建造师|建造师注册证书|安全生产考核合格证书|职称证书|财务状况|财务报告|审计报告|银行资信|业绩证明|类似业绩|信用记录|信用评价|不良行为记录|投标保证金|履约保证金|社保/u.test(normalized);
  return hasQualificationTerm;
}

/**
 * 合同程序条款判定（r8 实机 #1/#3 复核：合同范本/监理程序条文被误当施组响应要求）：
 * ① 合同范本对偶语（「你方…我方…」）是合同条款特有语言（招标技术条款用「投标人/招标人」），
 *    非对投标人施工组织的实质要求；
 * ② 「发包人+审批/批准/备案/同意」是合同管理程序约定（资料报送/审批/备案属合同范畴，
 *    prompt 合同履约管理程序条款规则同口径，LLM 漏判时本地兜底）；
 * ③ 以「监理人」开头（含编号前缀）的条款描述监理方自身职责与程序（监理规范条文照抄形态），
 *    非施组响应要求——「隐蔽工程验收须提前48小时通知监理人」类（投标人为主语的验收
 *    要求）不以监理人开头，不受影响。
 */
export function isContractProcedureClause(text: string): boolean {
  const normalized = text.trim().replace(/\s+/gu, '');
  if (!normalized) return false;
  if (/你方/u.test(normalized) && /我方/u.test(normalized)) return true;
  if (/发包人[^。；;]{0,30}?(?:审批|批准|备案|同意|许可)/u.test(normalized)) return true;
  if (/^[\d（(、.．\s]{0,8}监理人/u.test(normalized) && /(?:提交|报送|审批|延期|通知|检查|验收)/u.test(normalized)) return true;
  return false;
}

/**
 * 大纲小节主题约束（大纲出口过滤，评分报告 P1 串章根因治理二）：判定小节标题是否属于本章主题域。
 * 投标/评标纪律、评标办法、商务报价类标题（"对与评标活动有关的工作人员的纪律要求"、
 * "评审争议处理与澄清配合"等无禁词词面变体）一律剔除；施工合法小节放行。
 * 判定规则与证据过滤同构：词面召回 → bge 三路语义比对
 * （投标程序相似度 ≥ 阈值，且高于章主题相似度与施工语义相似度才剔除）。
 * 确定性规则只做词面兜底，语义模型恒可用（空候选由恒零函数承接，无降级分支）。
 */
export async function filterOffTopicSections(
  input: { sections: string[]; chapterTitle: string; chapterPurpose?: string; embedDocuments?: (texts: string[]) => Promise<number[][]> },
): Promise<string[]> {
  const sections = input.sections.filter(title => title?.trim());
  if (sections.length === 0) return [];
  // 确定性硬剔除层：条款碎片 + 纪律/程序类黑名单（不依赖语义模型，语义不可用仍生效）
  const hardKept = sections.filter(title => !isHardBannedSectionTitle(title));
  const candidates = hardKept.filter(title => BID_PROCEDURE_LEXICAL_HINTS_RE.test(title));
  if (candidates.length === 0) return hardKept;
  const topicText = `${input.chapterTitle} ${input.chapterPurpose || ''}`.trim();
  const bidSimilarity = await buildSemanticSimilarity(candidates, [...BID_PROCEDURE_SEMANTIC_PROTOTYPES], input.embedDocuments);
  const topicSimilarity = await buildSemanticSimilarity(candidates, topicText ? [topicText] : [], input.embedDocuments);
  const constructionSimilarity = await buildSemanticSimilarity(candidates, [...CONSTRUCTION_SEMANTIC_PROTOTYPES], input.embedDocuments);
  const dropped = new Set<string>();
  for (const title of candidates) {
    const bidScore = Math.max(...BID_PROCEDURE_SEMANTIC_PROTOTYPES.map(prototype => bidSimilarity(title, prototype)));
    const topicScore = topicText ? topicSimilarity(title, topicText) : 0;
    const constructionScore = Math.max(...CONSTRUCTION_SEMANTIC_PROTOTYPES.map(prototype => constructionSimilarity(title, prototype)));
    // 施工合法小节保护：与施工语义原型（劳动纪律/质量保证等）相似度更高时放行
    if (bidScore >= OFF_TOPIC_SECTION_THRESHOLD && bidScore > topicScore && bidScore > constructionScore) dropped.add(title);
  }
  return hardKept.filter(title => !dropped.has(title));
}

/**
 * 大纲出口批量过滤：模板静态 sections 路径与 LLM 规划路径汇合后的章节集合统一过滤
 * （plannedChapters 出口单点调用，下游写作/目录/预算无感知）。
 */
export async function filterOffTopicSectionsForChapters(
  chapters: DocumentTemplateChapter[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<DocumentTemplateChapter[]> {
  return Promise.all(chapters.map(async chapter => ({
    ...chapter,
    sections: await filterOffTopicSections({ sections: chapter.sections || [], chapterTitle: chapter.title, chapterPurpose: chapter.purpose, embedDocuments }),
  })));
}
