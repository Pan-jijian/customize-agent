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
  '清单计量与报价口径约定',
  '投标文件实质性响应要求',
  '投标保证金缴纳与退还程序',
  '开标程序与投标文件递交截止时间',
  '评标期间行为管控与资料闭环',
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
] as const;

/**
 * 词面召回特征：命中仅触发语义复核（不直接判定）。
 * 覆盖禁写词（utils.ts BID_DISCIPLINE_PHRASES 同口径）与无禁词词面变体的语境词
 * （实测评分报告原文"我公司对参与本项目投标及施工组织设计编制的工作人员实行严格的
 * 纪律管理"无任何禁词词面；"评审争议处理与澄清配合"标题同理）。
 */
const BID_PROCEDURE_LEXICAL_HINTS_RE = /评标|投标|行贿|打招呼|递条子|廉洁|串标|围标|弄虚作假|干扰评标|纪律|澄清|中标|报价|清单计量|评审|保证金|开标|递交|争议/u;

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

/**
 * 小节标题硬黑名单判定（确定性，黑名单语义——该词面组合本身禁出现，不依赖语义模型；
 * 真实生成回归：语义模型不可用（恒零承接）或章主题相似度干扰时语义判定放行纪律小节，
 * 导致纪律证据被输入层过滤后小节失去事实支撑 → 章节任务未就绪失败，故硬剔除层必须存在）：
 * 1. 招标条款碎片标题（编号前缀/承诺断言/条件从句/委员会动作等，与 outline.ts 同口径）；
 * 2. 与投标程序原型归一化精确相等；
 * 3. 程序词 × 管理词组合（评标/投标/开标/中标/评审 + 纪律/监督/争议/澄清/公示等）。
 * 施工合法小节（劳动纪律/质量纪律/安全纪律/技术澄清）不含程序词，零误杀。
 */
function isHardBannedSectionTitle(title: string): boolean {
  const normalized = title.trim().replace(/\s+/gu, '');
  if (!normalized) return true;
  if (isTenderClauseFragmentTitle(normalized)) return true;
  const key = normalizeSectionTitleKey(normalized);
  if (BID_PROCEDURE_SEMANTIC_PROTOTYPES.some(prototype => normalizeSectionTitleKey(prototype) === key)) return true;
  const hasProcedure = /评标|投标|开标|中标|评审|保证金|串标|围标|廉洁|询标|递交/u.test(normalized);
  const hasGovernance = /纪律|监督|争议|澄清|程序|行为|管控|限制|接触|公示|承诺|响应|办法/u.test(normalized);
  return hasProcedure && hasGovernance;
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
