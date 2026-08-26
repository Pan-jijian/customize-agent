import type { DocumentDraftChapter, DocumentFactTrace, DocumentTemplate, ValidationIssue } from './types';
import { isActionableTraceFact } from './documentFactTrace';
import { documentTextLength } from './budget';

/**
 * 招标技术标评审六维评分（确定性计算，非 LLM）：
 * 依据《施组设计汇总方案.md》第二节"去重后的高频评审逻辑"表
 * 资料完整性 / 方案针对性 / 合规性 / 可落地性 / 编制规范性 / 低雷同性，
 * 全部映射到可计算的确定性指标，与事实安全、污染、结构缺陷类 error 门禁分离。
 */

/** 负面词库（短语级）：《施组设计汇总方案.md》第十一节 + 用户“青天大模型 AI 评标”提示词第十二节禁用词合并，
 * 同时供低雷同性评分与生成提示词禁写。单字虚词（合理/充分/完善/切实/尽量/适时/加强/及时等）
 * 只进生成侧提示词，不纳入确定性评分正则，避免“及时整改”等正常表述被误伤 */
export const FORBIDDEN_EMPTY_PHRASES = [
  '精心组织', '科学统筹', '科学管理', '精益求精', '全力保障', '高效推进',
  '力争优质', '力争一流', '一流水平', '完善体系', '最大限度', '显著提升',
  '大力落实', '严格把控', '充分确保', '竭力打造', '现代化管理', '加强管理',
  '提高意识', '强化监督', '持续完善', '定期检查', '及时处理', '全方位',
  '系统性', '常态化', '提质增效', '高标准', '统筹推进',
];

/** 案例落地句式三要素（责任岗位 + 检查频次 + 整改闭环），供可落地性评分与提示词共用 */
export const CLOSED_LOOP_ROLE_RE = /项目经理|技术负责人|总工程师|项目负责人|施工员|质检员|质量员|安全员|专职安全员|材料员|资料员|测量员|试验员|电工|文明施工管理员|专业工长/u;
export const CLOSED_LOOP_FREQUENCY_RE = /每日|每天|每周|每月|每季度|每旬|每\s*\d+\s*天|不少于\s*\d+\s*次|定期/u;
export const CLOSED_LOOP_CLOSURE_RE = /整改|复查|销项|闭环|复验|回访/u;

/** 资料完整性强制模块：危大/扬尘/实名制/工资保障/应急/绿色施工 6 项各 1 分 */
const MANDATORY_MODULES: RegExp[] = [
  /危大|危险性较大/u,
  /扬尘/u,
  /实名制/u,
  /农民工工资|工资专用账户|工资保证金|工资支付|银行代发/u,
  /应急预案|应急演练|应急响应/u,
  /绿色施工/u,
];

/** 合规性强制项：危大闭环链 6 环节 + 三级配电两级保护 3 项 + 强制制度 4 项，各 1 分 */
const COMPLIANCE_ITEMS: RegExp[] = [
  /辨识|识别/u,
  /专项施工方案|专项方案/u,
  /专家论证|论证|审批/u,
  /交底/u,
  /监测|监控量测|观测/u,
  /验收/u,
  /三级配电/u,
  /两级保护/u,
  /漏电保护/u,
  /实名制/u,
  /工资专用账户|工资专户|银行代发/u,
  /应急预案/u,
  /绿色施工/u,
];

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

/** 资料完整性：章节齐全度（模板章节标题命中率）+ 强制模块覆盖（6 项各 1 分） */
function completenessScore(markdown: string, chapters: DocumentDraftChapter[], template?: DocumentTemplate | null) {
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
  const moduleHits = MANDATORY_MODULES.filter(pattern => pattern.test(markdown)).length;
  const moduleRate = moduleHits / MANDATORY_MODULES.length;
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

/** 合规性：危大闭环链（辨识→方案→审批论证→交底→监测→验收）+ 三级配电两级保护 + 实名制/工资专户/应急/绿色施工 */
function complianceScore(markdown: string) {
  const hits = COMPLIANCE_ITEMS.filter(pattern => pattern.test(markdown)).length;
  return Math.round((hits / COMPLIANCE_ITEMS.length) * 100);
}

/** 可落地性：管控闭环句式密度（责任岗位+检查频次+整改闭环），每 1500 字至少 1 段闭环句式 */
function executabilityScore(markdown: string) {
  const blocks = markdown.split(/\n{2,}/u).filter(block => block.trim().length >= 30);
  const closedLoopBlocks = blocks.filter(block =>
    CLOSED_LOOP_ROLE_RE.test(block) && CLOSED_LOOP_FREQUENCY_RE.test(block) && CLOSED_LOOP_CLOSURE_RE.test(block),
  ).length;
  const target = Math.max(6, Math.ceil(documentTextLength(markdown) / 1500));
  return Math.round(Math.min(1, closedLoopBlocks / target) * 100);
}

/** 编制规范性：复用已有确定性检查消息（目录层级/表格规范/跨章数据一致/结构完整） */
function normalizationScore(issues: ValidationIssue[]) {
  const normErrors = issues.filter(issue => issue.level === 'error' && NORMALIZATION_ISSUE_RE.test(issue.message)).length;
  const normWarnings = issues.filter(issue => issue.level === 'warning' && NORMALIZATION_ISSUE_RE.test(issue.message)).length;
  return Math.max(0, 100 - normErrors * 8 - Math.min(normWarnings * 3, 30));
}

/** 低雷同性：空话禁用词命中率 + 重复句式率（≥12 字符正文句去标点后重复比例） */
function uniquenessScore(markdown: string) {
  const forbiddenHits = FORBIDDEN_EMPTY_PHRASES.filter(phrase => markdown.includes(phrase)).length;
  const sentences = markdown
    .split(/\n+/u)
    .filter(line => line.trim() && !/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(line))
    .flatMap(line => line.split(/[。；;]/u))
    .map(sentence => sentence.replace(/[\s，,、：:（）()【】[\]《》“”"'`]/gu, ''))
    .filter(sentence => sentence.length >= 12);
  const duplicateRate = sentences.length ? (sentences.length - new Set(sentences).size) / sentences.length : 0;
  return Math.max(0, Math.round(100 - forbiddenHits * 4 - duplicateRate * 60));
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
  /** 低雷同性 */
  uniqueness: number;
}

export function buildTenderBidScores(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
  template?: DocumentTemplate | null;
  factTraces: DocumentFactTrace[];
  issues: ValidationIssue[];
}): TenderBidScores {
  return {
    completeness: completenessScore(input.markdown, input.chapters, input.template),
    specificity: specificityScore(input.markdown, input.chapters, input.factTraces),
    compliance: complianceScore(input.markdown),
    executability: executabilityScore(input.markdown),
    normalization: normalizationScore(input.issues),
    uniqueness: uniquenessScore(input.markdown),
  };
}
