import type { DocumentDraftChapter, DocumentFactTrace, DocumentTemplate, ValidationIssue } from './types';
import { isActionableTraceFact } from './documentFactTrace';
import { documentTextLength } from './budget';
import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';
import {
  fillerDensityReport,
  vagueResponseHits,
  fiveElementBlockStats,
  dangerousTwoStepCheck,
  emergencyStructureCheck,
  difficultyCountermeasureReport,
  crossProjectResidueHits,
  type TemplatingLevel,
} from './tenderBidChecks';

/**
 * 招标技术标评审六维评分（确定性计算，非 LLM）：
 * 依据《施组设计汇总方案.md》第二节"去重后的高频评审逻辑"表
 * 资料完整性 / 方案针对性 / 合规性 / 可落地性 / 编制规范性 / 低雷同性，
 * 全部映射到可计算的确定性指标，与事实安全、污染、结构缺陷类 error 门禁分离。
 */

/** 负面词库（短语级）：《施组设计汇总方案.md》第十一节 + 用户“青天大模型 AI 评标”提示词第十二节禁用词合并，
 * 供低雷同性评分使用。单字虚词（合理/充分/完善/切实/尽量/适时/加强/及时等）
 * 只进生成侧提示词，不纳入确定性评分正则，避免“及时整改”等正常表述被误伤。
 * 十度实测：短语级正则仍会误伤正常语境（“建设单位会同监管部门定期检查”/“智能化系统性调试”），
 * “定期检查”“系统性”移入 FORBIDDEN_PROMPT_PHRASES（仅禁写，不参与评分扣分）。 */
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

/** 闭环三要素（责任岗位＋检查频次＋整改闭环）：由 tenderBidChecks.fiveElementBlockStats
 * 的 role/frequency/acceptance 语义原型复用同一批 bge 嵌入，本文件不再保留要素正则 */

/** 资料完整性强制模块语义原型：危大/扬尘/实名制/工资保障/应急/绿色施工 6 项各 1 分 */
const MANDATORY_MODULE_QUERIES = [
  '危险性较大的分部分项工程安全管理',
  '扬尘污染防治措施',
  '建筑工人实名制管理',
  '农民工工资专用账户与工资支付保障',
  '生产安全事故应急预案与应急演练',
  '绿色施工与四节一环保措施',
] as const;

/** 合规性强制项语义原型：危大闭环链 6 环节 + 三级配电两级保护 3 项 + 强制制度 4 项，各 1 分 */
const COMPLIANCE_ITEM_QUERIES = [
  '危险源辨识与风险识别评估',
  '编制专项施工方案',
  '组织专家论证并履行审批程序',
  '对作业人员进行安全技术交底',
  '施工过程监测与监控量测',
  '分部分项工程验收',
  '三级配电系统',
  '两级漏电保护装置',
  '漏电保护器与接地保护',
  '实名制考勤与人员管理',
  '农民工工资专用账户银行代发',
  '应急预案编制与响应',
  '绿色施工措施与评价',
] as const;

/** 编制规范性：复用已有确定性检查（目录层级/表格规范/跨章数据一致/结构完整）的消息口径 */
const NORMALIZATION_ISSUE_RE = /目录|层级|编号|表格|表头|分隔线|跨章|数据一致|数值口径|页码|空小节|缺少|缺失|缺节/u;

function normalizeHeadingTitle(title: string) {
  return title
    .replace(/^第[一二三四五六七八九十百千万\d]+[章节]\s*/u, '')
    .replace(/^\d+(?:\.\d+)*[、.．\s]+/u, '')
    .replace(/^[（(]?[一二三四五六七八九十]+[)）、.．\s]+/u, '')
    .replace(/\s+/gu, '')
    .trim();
}

function headingTitles(markdown: string) {
  return [...markdown.matchAll(/^#{1,3}\s+(.+)$/gmu)]
    .map(match => normalizeHeadingTitle(match[1] || ''))
    .filter(title => title.length >= 2);
}

/** 资料完整性：章节齐全度（模板章节标题命中率）+ 强制模块覆盖（6 项各 1 分，块级 bge 语义判定） */
function completenessScore(
  markdown: string,
  chapters: DocumentDraftChapter[],
  template: DocumentTemplate | null | undefined,
  anyBlockMatches: (query: string) => boolean,
) {
  const titles = headingTitles(markdown);
  let chapterHitRate = 1;
  const templateChapters = template?.chapters || [];
  if (templateChapters.length > 0) {
    const normalizedTemplateTitles = templateChapters.map(chapter => normalizeHeadingTitle(chapter.title)).filter(Boolean);
    const hits = normalizedTemplateTitles.filter(title => titles.some(actual => actual.includes(title) || title.includes(actual))).length;
    chapterHitRate = hits / normalizedTemplateTitles.length;
  } else if (chapters.length > 0) {
    const hits = chapters.filter(chapter => titles.some(actual => actual.includes(normalizeHeadingTitle(chapter.title)) || normalizeHeadingTitle(chapter.title).includes(actual))).length;
    chapterHitRate = hits / chapters.length;
  }
  const moduleHits = MANDATORY_MODULE_QUERIES.filter(anyBlockMatches).length;
  const moduleRate = moduleHits / MANDATORY_MODULE_QUERIES.length;
  return Math.round((chapterHitRate * 0.55 + moduleRate * 0.45) * 100);
}

/** 方案针对性：项目专属事实落位率 + 专属事实跨章节分布率 */
function specificityScore(markdown: string, chapters: DocumentDraftChapter[], factTraces: DocumentFactTrace[]) {
  const scoredTraces = factTraces.filter(isActionableTraceFact);
  const usedTraces = scoredTraces.filter(trace => trace.status === 'used');
  const usedRate = scoredTraces.length ? usedTraces.length / scoredTraces.length : 1;
  const usedValues = usedTraces
    .map(trace => String(trace.value || '').replace(/\s+/gu, ' ').trim())
    .filter(value => value.length >= 4 && value.length <= 60);
  const normalizedBodies = chapters.map(chapter => (chapter.content || '').replace(/\s+/gu, ' '));
  const distributedCount = usedValues.filter(value => normalizedBodies.filter(body => body.includes(value)).length >= 2).length;
  const distribution = usedValues.length ? distributedCount / usedValues.length : 1;
  return Math.round((usedRate * 0.55 + distribution * 0.45) * 100);
}

/**
 * 合规性：危大闭环链（辨识→方案→审批论证→交底→监测→验收）+ 三级配电两级保护 + 实名制/工资专户/应急/绿色施工；
 * 按 docx 判定标尺叠加：危大两步确认法（类别匹配+参数分级，10%）与应急预案八部分结构（10%）
 */
function complianceScore(markdown: string, anyBlockMatches: (query: string) => boolean) {
  const hits = COMPLIANCE_ITEM_QUERIES.filter(anyBlockMatches).length;
  const base = hits / COMPLIANCE_ITEM_QUERIES.length;
  const dangerous = dangerousTwoStepCheck(markdown);
  const dangerousRate = dangerous.twoStepComplete ? 1
    : dangerous.categories.length > 0 && dangerous.graded ? 0.6
      : dangerous.categories.length > 0 ? 0.3 : 0;
  const emergency = emergencyStructureCheck(markdown);
  return Math.round((base * 0.8 + dangerousRate * 0.1 + emergency.coverage * 0.1) * 100);
}

/** 可落地性：措施五要素闭合块密度（方案＋流程＋责任人＋时间节点＋验收标准，docx L93）
 * 目标基准优先取参考库同类工程完整五要素块均值（人工样本实测画像，对标口径），
 * 无参考库样本时回退每 1500 字 1 块的历史口径 */
async function executabilityScore(markdown: string, referenceCompleteBlocks?: number) {
  const { blocks, completeBlocks } = await fiveElementBlockStats(markdown);
  const target = Math.max(6, Math.ceil(referenceCompleteBlocks ?? documentTextLength(markdown) / 1500));
  const density = Math.min(1, completeBlocks / target);
  const fiveElementRate = blocks ? completeBlocks / blocks : 0;
  return Math.round((density * 0.7 + fiveElementRate * 0.3) * 100);
}

/** 编制规范性：复用已有确定性检查消息（目录层级/表格规范/跨章数据一致/结构完整） */
function normalizationScore(issues: ValidationIssue[]) {
  const normErrors = issues.filter(issue => issue.level === 'error' && NORMALIZATION_ISSUE_RE.test(issue.message)).length;
  const normWarnings = issues.filter(issue => issue.level === 'warning' && NORMALIZATION_ISSUE_RE.test(issue.message)).length;
  return Math.max(0, 100 - normErrors * 8 - Math.min(normWarnings * 3, 30));
}

/**
 * 低雷同性：空话禁用词命中率 + 模糊应答词（附录一第 3 类，零出现要求）+ 套话密度超标扣分
 * （docx L156：核心章节套话占比≤10%）+ 重复句式率（≥12 字符正文句去标点后重复比例）
 */
function uniquenessScore(markdown: string, filler: Awaited<ReturnType<typeof fillerDensityReport>>) {
  const forbiddenHits = FORBIDDEN_EMPTY_PHRASES.filter(phrase => markdown.includes(phrase)).length;
  const vagueHitCount = vagueResponseHits(markdown).reduce((sum, hit) => sum + hit.count, 0);
  const fillerPenalty = Math.max(0, filler.ratio - 0.1) * 100;
  const sentences = markdown
    .split(/\n+/u)
    .filter(line => line.trim() && !/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(line))
    .flatMap(line => line.split(/[。；;]/u))
    .map(sentence => sentence.replace(/[\s，,、：:（）()【】[\]《》“”"'`]/gu, ''))
    .filter(sentence => sentence.length >= 12);
  const duplicateRate = sentences.length ? (sentences.length - new Set(sentences).size) / sentences.length : 0;
  return Math.max(0, Math.round(100 - forbiddenHits * 4 - vagueHitCount * 6 - fillerPenalty * 0.5 - duplicateRate * 60));
}

export interface TenderBidScores {
  /** 资料完整性 */
  completeness: number;
  /** 方案针对性 */
  specificity: number;
  /** 合规性 */
  compliance: number;
  /** 可落地性 */
  executability: number;
  /** 编制规范性 */
  normalization: number;
  /** 低雷同性（触发式否决项：<30 判重度雷同风险） */
  uniqueness: number;
}

/** 模板化套用专项检测报告（docx 第十类核心降档判定，供报告与降档决策） */
export interface TenderBidTemplatingReport {
  /** 整体模板化等级：重/中/轻 */
  level: TemplatingLevel;
  /** 套话句占比（docx：核心章节 ≤10%） */
  fillerRatio: number;
  /** 套话句/总句数（量化依据） */
  fillerSentences: number;
  totalSentences: number;
  /** 模糊应答词命中次数（零出现要求） */
  vagueHitCount: number;
  vaguePhrases: string[];
  /** 重复句式率 */
  duplicateSentenceRate: number;
  /** 跨项目内容残留命中（零残留要求） */
  crossProjectResidue: string[];
  /** 重难点对策"归因+量化目标"双达标占比（<50% 判重度模板化，docx L156） */
  difficultyCountermeasureRatio: number;
  difficultyBothCount: number;
  difficultyCountermeasures: number;
  /** 重难点章节重度模板化警示 */
  difficultyHeavyTemplated: boolean;
}

export async function buildTenderBidTemplatingReport(
  markdown: string,
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<TenderBidTemplatingReport> {
  const filler = await fillerDensityReport(markdown, embedDocuments);
  const vagueHits = vagueResponseHits(markdown);
  const sentences = markdown
    .split(/\n+/u)
    .filter(line => line.trim() && !/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(line))
    .flatMap(line => line.split(/[。；;]/u))
    .map(sentence => sentence.replace(/[\s，,、:：（）()【】[\]《》“”"'`]/gu, ''))
    .filter(sentence => sentence.length >= 12);
  const duplicateRate = sentences.length ? (sentences.length - new Set(sentences).size) / sentences.length : 0;
  const difficulty = await difficultyCountermeasureReport(markdown, embedDocuments);
  const residue = crossProjectResidueHits(markdown);
  // 重难点对策双达标占比 <50% 直接判重度模板化（docx L156）；否则按套话密度三档
  const level: TemplatingLevel = difficulty.heavyTemplated ? 'heavy' : filler.level;
  return {
    level,
    fillerRatio: filler.ratio,
    fillerSentences: filler.fillerSentences,
    totalSentences: filler.totalSentences,
    vagueHitCount: vagueHits.reduce((sum, hit) => sum + hit.count, 0),
    vaguePhrases: vagueHits.map(hit => hit.phrase),
    duplicateSentenceRate: duplicateRate,
    crossProjectResidue: residue,
    difficultyCountermeasureRatio: difficulty.ratio,
    difficultyBothCount: difficulty.bothCount,
    difficultyCountermeasures: difficulty.countermeasures,
    difficultyHeavyTemplated: difficulty.heavyTemplated,
  };
}

export async function buildTenderBidScores(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
  template?: DocumentTemplate | null;
  factTraces: DocumentFactTrace[];
  issues: ValidationIssue[];
  /** 参考库同类工程完整五要素块均值（可选）：提供时作为可落地性目标基准 */
  referenceCompleteBlocks?: number;
  /** 单测注入的嵌入实现（替代本地模型），生产环境不传 */
  embedDocuments?: (texts: string[]) => Promise<number[][]>;
}): Promise<TenderBidScores> {
  // 强制模块与合规项共享同一批块嵌入（≥30 字段落块），块级任一命中即判定该项存在
  const blocks = input.markdown.split(/\n{2,}/u).filter(block => block.trim().length >= 30);
  const querySimilarity = await buildSemanticSimilarity(
    blocks,
    [...MANDATORY_MODULE_QUERIES, ...COMPLIANCE_ITEM_QUERIES],
    input.embedDocuments,
  );
  const anyBlockMatches = (query: string) =>
    blocks.some(block => querySimilarity(block, query) >= SEMANTIC_COVERAGE_THRESHOLD);
  const filler = await fillerDensityReport(input.markdown, input.embedDocuments);
  return {
    completeness: completenessScore(input.markdown, input.chapters, input.template, anyBlockMatches),
    specificity: specificityScore(input.markdown, input.chapters, input.factTraces),
    compliance: complianceScore(input.markdown, anyBlockMatches),
    executability: await executabilityScore(input.markdown, input.referenceCompleteBlocks),
    normalization: normalizationScore(input.issues),
    uniqueness: uniquenessScore(input.markdown, filler),
  };
}
