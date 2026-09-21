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
  isFillerPoolExcludedLine,
  type TemplatingLevel,
} from './tenderBidChecks';
import { isNarrativeLine, isTocClusterLine, stripHeadingLines } from './narrativeContext';
import { countSentencePatternHits, SENTENCE_PATTERN_FAMILIES, sentencePatternThreshold } from './templatingGovernance';

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

/** 资料完整性强制模块语义原型：危大/扬尘/实名制/工资保障/应急/绿色施工 6 项各 1 分（导出供 v2 评分展示口径） */
export const MANDATORY_MODULE_QUERIES = [
  '危险性较大的分部分项工程安全管理',
  '扬尘污染防治措施',
  '建筑工人实名制管理',
  '农民工工资专用账户与工资支付保障',
  '生产安全事故应急预案与应急演练',
  '绿色施工与四节一环保措施',
] as const;

/** 合规性强制项语义原型：危大闭环链 6 环节 + 三级配电两级保护 3 项 + 强制制度 4 项，各 1 分（导出供 v2 评分展示口径与审计探针复用） */
export const COMPLIANCE_ITEM_QUERIES = [
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

/** 编制规范性匹配正则定义在 normalizationScore 上方（B7 口径修正） */

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

/** 资料完整性：章节齐全度（模板章节标题命中率）+ 强制模块覆盖（块级 bge 语义判定）。
 * 模块覆盖率由 buildTenderBidScores 单源计算（v2 要件完整性同源消费），本函数不再重复判定。 */
function completenessScore(
  markdown: string,
  chapters: DocumentDraftChapter[],
  template: DocumentTemplate | null | undefined,
  moduleCoverageRate: number,
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
  return Math.round((chapterHitRate * 0.55 + moduleCoverageRate * 0.45) * 100);
}

/** 方案针对性：项目专属事实落位率 + 专属事实跨章节分布率 */
function specificityScore(chapters: DocumentDraftChapter[], factTraces: DocumentFactTrace[]) {
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
 * 按 docx 判定标尺叠加：危大两步确认法（类别匹配+参数分级，10%）与应急预案八部分结构（10%）。
 * C0-2 语境约束：危大两步与应急八部分为词面型分量，消费结构证据文本（stripHeadingLines）——
 * 标题行/目录行剥离：空壳标题（如标题行「生产安全事故应急预案与应急演练」）不得单独构成结构
 * 证据（C0 基线：纯标题文档在旧口径下骗得应急覆盖率分数）；表格/列表/正文行保留且不设切句
 * 长度门槛（危大清单表等结构化载体与短句是合法证据）。
 */
function complianceScore(markdown: string, anyBlockMatches: (query: string) => boolean) {
  const hits = COMPLIANCE_ITEM_QUERIES.filter(anyBlockMatches).length;
  const base = hits / COMPLIANCE_ITEM_QUERIES.length;
  const evidenceText = stripHeadingLines(markdown);
  const dangerous = dangerousTwoStepCheck(evidenceText);
  const dangerousRate = dangerous.twoStepComplete ? 1
    : dangerous.categories.length > 0 && dangerous.graded ? 0.6
      : dangerous.categories.length > 0 ? 0.3 : 0;
  const emergency = emergencyStructureCheck(evidenceText);
  return Math.round((base * 0.8 + dangerousRate * 0.1 + emergency.coverage * 0.1) * 100);
}

/** 可落地性：措施五要素闭合块密度（方案＋流程＋责任人＋时间节点＋验收标准，docx L93）
 * 目标基准（4.26.0 起固化字数口径，参考库锚点已随模板参考库移除下线）：
 * target = max(6, ceil(有效字数 / 1500))，单一逻辑无分支 */
async function executabilityScore(markdown: string) {
  const { blocks, completeBlocks } = await fiveElementBlockStats(markdown);
  const target = Math.max(6, Math.ceil(documentTextLength(markdown) / 1500));
  const density = Math.min(1, completeBlocks / target);
  const fiveElementRate = blocks ? completeBlocks / blocks : 0;
  return Math.round((density * 0.7 + fiveElementRate * 0.3) * 100);
}

/** 编制规范性：只计结构/表格/格式类检查器产出。
 * B7 口径修正（丰乐镇第七轮实测）：旧正则把「跨章一致性复核」「事实一致性冲突」等
 * 全部计入编制规范性，每条 -8 导致 normalization 恒 0 分；
 * B7 第二轮收口（丰乐镇实测）：① 无 category 历史消息仅按格式结构词计分，事实落位
 * （「图纸目录」）类排除；② category='structure' 有历史兜底污染（classifyValidationIssue
 * 把评分项响应/属地创优/工伤保险等合规类 error 也标 structure），必须叠加结构类消息特征
 * 双重确认；③ table/format 均为确定性结构检查器产出，直接计分。 */
const NORMALIZATION_ISSUE_RE = /目录|层级|编号|表格|表头|分隔线|页码|空小节|缺少规划小节|小节只有标题|缺节/u;
const NORMALIZATION_EXCLUDE_RE = /跨章一致性复核|事实一致性冲突|事实冲突|评分项要求|可靠精确参数|应急预案|属地创优|工伤保险|专业评分|深度不足|事实反查|存在多个值|已确认事实未在正文中落位|事实未在正文中落位/u;
// category='structure' 双重确认的结构类消息特征（不含「标题」宽词，避免合规类长消息误中）
const STRUCTURE_ISSUE_RE = /缺少规划小节|小节只有标题|空小节|只有标题或表格无正文|小节内容补写未完成|小节生成未达标|同名小节|H4 标题|正文缺少章节标题|小节正文过短/u;

export function normalizationScore(issues: ValidationIssue[]) {
  const isNormalizationIssue = (issue: ValidationIssue) => {
    if (issue.category === 'table' || issue.category === 'format') return true;
    if (issue.category === 'structure') return STRUCTURE_ISSUE_RE.test(issue.message);
    if (issue.category) return false;
    return !NORMALIZATION_EXCLUDE_RE.test(issue.message) && NORMALIZATION_ISSUE_RE.test(issue.message);
  };
  const normErrors = issues.filter(issue => issue.level === 'error' && isNormalizationIssue(issue)).length;
  const normWarnings = issues.filter(issue => issue.level === 'warning' && isNormalizationIssue(issue)).length;
  return Math.max(0, 100 - normErrors * 8 - Math.min(normWarnings * 3, 30));
}

/** 重复句统计共享单源（C0-4）：行级过滤（标题/表格/列表/引用/目录条目行/目录聚簇行）
 * 后按。；; 切句，去标点后 ≥12 字计一句；duplicateInstances=重复出现次数（总数-唯一数）。
 * uniqueness 扣分与模板化报告的 duplicateSentenceRate 同源消费，禁止双口径漂移。
 * C8 S5（U 通道）：出现明细拆为 duplicateSentenceOccurrences——评分统计与句级复读坍塌修复
 * （duplicateSentenceCollapse，检测定位=修复定位）两端口径严格同源。 */
export interface DuplicateSentenceStats {
  totalSentences: number;
  uniqueSentences: number;
  duplicateInstances: number;
  duplicateRate: number;
}

/** 完全重复句出现（C8 S5）：行号 + 行内起止（trim 后句本体，不含句末分隔符——删除修复按此定位） */
export interface DuplicateSentenceOccurrence {
  lineIndex: number;
  start: number;
  end: number;
  raw: string;
}

/** 完全重复句分组（按出现序；含唯一句组——修复端过滤 length≥2）：
 * 比较键 = 去标点归一化文本，与 duplicateSentenceStats 原口径逐字一致。 */
export function duplicateSentenceOccurrences(markdown: string): Array<{ key: string; occurrences: DuplicateSentenceOccurrence[] }> {
  const groups = new Map<string, DuplicateSentenceOccurrence[]>();
  markdown.split('\n').forEach((line, lineIndex) => {
    if (isFillerPoolExcludedLine(line) || isTocClusterLine(line)) return;
    for (const match of line.matchAll(/[^。；;]+/gu)) {
      const text = match[0] || '';
      const raw = text.trim();
      const key = raw.replace(/[\s，,、:：（）()【】[\]《》“”"'`]/gu, '');
      if (key.length < 12) continue;
      const start = (match.index || 0) + (text.length - text.trimStart().length);
      const list = groups.get(key) || [];
      list.push({ lineIndex, start, end: start + raw.length, raw });
      groups.set(key, list);
    }
  });
  return [...groups.entries()].map(([key, occurrences]) => ({ key, occurrences }));
}

export function duplicateSentenceStats(markdown: string): DuplicateSentenceStats {
  const groups = duplicateSentenceOccurrences(markdown);
  const totalSentences = groups.reduce((sum, group) => sum + group.occurrences.length, 0);
  const uniqueSentences = groups.length;
  const duplicateInstances = totalSentences - uniqueSentences;
  return {
    totalSentences,
    uniqueSentences,
    duplicateInstances,
    duplicateRate: totalSentences > 0 ? duplicateInstances / totalSentences : 0,
  };
}

/**
 * 低雷同性：空话禁用词命中率 + 模糊应答词（附录一第 3 类，零出现要求）+ 套话密度超标扣分
 * （docx L156：核心章节套话占比≤10%）+ 重复句式率（≥12 字符正文句去标点后重复比例）。
 * 模糊应答扣分走语义复核口径（vagueSemanticSentences）：「力争上游/左右对称」等合法句词面命中不扣分。
 * C0-4 长度归一校准：重复句预算 = 每万字 1 条（最少 10 条）——短文档不因个别合理复述被重罚、
 * 长文档按篇幅摊薄（r28l 6 万字 17 条重复在旧口径扣 ~1 分，校准后扣 7 分；s28l 14.5 万字 25 条
 * 校准后扣 10 分）；超出预算部分每条扣 1 分，与原比例扣分取较大值（短文档保持原口径）。
 */
function uniquenessScore(markdown: string, filler: Awaited<ReturnType<typeof fillerDensityReport>>) {
  const forbiddenHits = FORBIDDEN_EMPTY_PHRASES.filter(phrase => markdown.includes(phrase)).length;
  const vagueHitCount = filler.vagueSemanticSentences;
  const fillerPenalty = Math.max(0, filler.ratio - 0.1) * 100;
  const dup = duplicateSentenceStats(markdown);
  const dupBudget = Math.max(10, Math.ceil(documentTextLength(markdown) / 10000));
  const dupExcess = Math.max(0, dup.duplicateInstances - dupBudget);
  const duplicatePenalty = Math.max(dup.duplicateRate * 60, dupExcess);
  return Math.max(0, Math.round(100 - forbiddenHits * 4 - vagueHitCount * 6 - fillerPenalty * 0.5 - duplicatePenalty));
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
  /** 强制模块语义覆盖率（0..1，MANDATORY_MODULE_QUERIES 六项）：v2 要件完整性构成分量，单源判定 */
  moduleCoverageRate: number;
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
  /** C4 句模复读命中族（≥ 密度命中线 sentencePatternThreshold；检测/修复目标同源计数）：filler 语义原型正交的结构帧证据 */
  sentencePatternHits: Array<{ patternId: string; patternLabel: string; count: number }>;
}

export async function buildTenderBidTemplatingReport(
  markdown: string,
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<TenderBidTemplatingReport> {
  const filler = await fillerDensityReport(markdown, embedDocuments);
  const vagueHits = vagueResponseHits(markdown);
  const duplicateRate = duplicateSentenceStats(markdown).duplicateRate;
  const difficulty = await difficultyCountermeasureReport(markdown, embedDocuments);
  const residue = crossProjectResidueHits(markdown);
  // C4 评分接入（D3）：句模复读并入模板化降档——≥1 族命中判中档下限、≥2 族或单族 ≥2 倍命中线判重档
  // （r28l/s28l 实机：完整链 13/47 句、闭环 11/28 句——语义套话原型判不出，按结构帧计分）；
  // C8 S3② 命中线密度化（sentencePatternThreshold 单源：max(6, 正文字数/5000)，长文防误伤）
  const sentencePatternLine = sentencePatternThreshold(markdown);
  const sentencePatternHits = SENTENCE_PATTERN_FAMILIES
    .map(family => ({ patternId: family.id, patternLabel: family.label, count: countSentencePatternHits(markdown, family) }))
    .filter(hit => hit.count >= sentencePatternLine);
  const sentencePatternSevere = sentencePatternHits.length >= 2 || sentencePatternHits.some(hit => hit.count >= sentencePatternLine * 2);
  // 重难点对策双达标占比 <50% 直接判重度模板化（docx L156）；否则按套话密度与句模复读合成三档
  const level: TemplatingLevel = difficulty.heavyTemplated || filler.level === 'heavy' || sentencePatternSevere
    ? 'heavy'
    : filler.level === 'medium' || sentencePatternHits.length > 0
      ? 'medium'
      : 'light';
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
    sentencePatternHits,
  };
}

/** 评分小节（C0-1）：标题 + 实质正文段落（含空壳小节——标题承接 partial 判定用）。
 * 实质段落 = 块内含 ≥1 个 ≥12 字叙述行（非标题/表格/列表/引用/目录聚簇行），目录聚簇行在段内剔除。 */
export interface ScoringSection {
  /** 原始标题行（含 # 号）；无标题区为空串 */
  heading: string;
  /** 标题文本（去 # 号与编号，partial 判定与诊断展示用） */
  headingText: string;
  /** 是否有实质正文（≥1 个实质段落） */
  hasSubstantiveBody: boolean;
  /** 实质正文段落（判定文本源，已剔除目录聚簇行） */
  substantiveParagraphs: string[];
}

/** 小节切分（C0-1 单源）：按标题行切分 markdown，聚合空行分界的实质段落。
 * 空壳标题（无实质正文）保留在 sections 中（供评分细则映射层的「标题承接」partial 判定），
 * 但不进入评分判定单元（splitScoringBlocks 消费）。 */
export function splitScoringSections(markdown: string): ScoringSection[] {
  const cleaned = markdown.replace(/[\u200b-\u200f\u2060\ufeff]/gu, '');
  const rawSections = cleaned.split(/(?=^#{1,6}\s)/mu);
  const sections: ScoringSection[] = [];
  for (const raw of rawSections) {
    if (!raw.trim()) continue;
    const lines = raw.split('\n');
    const hasHeading = /^#{1,6}\s/u.test(lines[0] || '');
    const heading = hasHeading ? (lines[0] || '').trim() : '';
    const headingText = hasHeading ? normalizeHeadingTitle(heading.replace(/^#{1,6}\s+/u, '')) : '';
    const bodyLines = hasHeading ? lines.slice(1) : lines;
    const paragraphs: string[][] = [];
    let current: string[] = [];
    for (const line of bodyLines) {
      if (!line.trim()) {
        if (current.length > 0) {
          paragraphs.push(current);
          current = [];
        }
        continue;
      }
      current.push(line);
    }
    if (current.length > 0) paragraphs.push(current);
    const substantiveParagraphs: string[] = [];
    for (const paragraph of paragraphs) {
      const kept = paragraph.filter(line => !isTocClusterLine(line));
      if (kept.some(line => isNarrativeLine(line))) {
        substantiveParagraphs.push(kept.map(line => line.trim()).join('\n'));
      }
    }
    sections.push({ heading, headingText, hasSubstantiveBody: substantiveParagraphs.length > 0, substantiveParagraphs });
  }
  return sections;
}

/** 评分判定单元长度上限（防 bge 512 token 窗口截断：单位汉字约 1 token，600 字内单窗可嵌） */
const SCORING_UNIT_MAX_CHARS = 600;

/** 段落切窗：命中文本=正文本体（C0 探针实测：去标题词后 r28l/s28l 真实成稿命中零损失
 * 19/19，堆词样本模块命中 2/6→0——标题词不得构成语义证据「须同节正文含实体响应」），
 * 超长段落按行累积切为 ≤600 字多窗（分段末内容不再沉入块中部被截断） */
function windowParagraph(paragraph: string): string[] {
  const units: string[] = [];
  let buffer: string[] = [];
  let length = 0;
  for (const line of paragraph.split('\n')) {
    if (length > 0 && length + line.length > SCORING_UNIT_MAX_CHARS) {
      units.push(buffer.join('\n'));
      buffer = [];
      length = 0;
    }
    buffer.push(line);
    length += line.length + 1;
  }
  if (buffer.length > 0) units.push(buffer.join('\n'));
  return units;
}

/** 评分判定单元（C0-1 内容级判定）：标题不单独构成判定单元且不参与命中文本——单元=实质正文窗口。
 * 空壳标题（无实质正文）不产出单元（r28l 实测：仅标题块命中 14/19、6 强制模块全部靠标题单独命中，
 * 「### 1.1 编制说明与工程概况」类空壳标题误命中「编制专项施工方案」）；标题词的语义诱饵不计
 * （标题承接由评分细则映射层 partial 独立判定）；目录聚簇行剔除、超长段落切窗。
 * 导出供单测与对抗套件验证切分粒度。 */
export function splitScoringBlocks(markdown: string): string[] {
  const units: string[] = [];
  for (const section of splitScoringSections(markdown)) {
    if (!section.hasSubstantiveBody) continue;
    for (const paragraph of section.substantiveParagraphs) {
      units.push(...windowParagraph(paragraph));
    }
  }
  return units;
}

export async function buildTenderBidScores(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
  template?: DocumentTemplate | null;
  factTraces: DocumentFactTrace[];
  issues: ValidationIssue[];
  /** 单测注入的嵌入实现（替代本地模型），生产环境不传 */
  embedDocuments?: (texts: string[]) => Promise<number[][]>;
}): Promise<TenderBidScores> {
  // 强制模块与合规项共享同一批块嵌入，块级任一命中即判定该项存在
  const blocks = splitScoringBlocks(input.markdown);
  const querySimilarity = await buildSemanticSimilarity(
    blocks,
    [...MANDATORY_MODULE_QUERIES, ...COMPLIANCE_ITEM_QUERIES],
    input.embedDocuments,
  );
  const anyBlockMatches = (query: string) =>
    blocks.some(block => querySimilarity(block, query) >= SEMANTIC_COVERAGE_THRESHOLD);
  const moduleCoverageRate = MANDATORY_MODULE_QUERIES.filter(anyBlockMatches).length / MANDATORY_MODULE_QUERIES.length;
  const filler = await fillerDensityReport(input.markdown, input.embedDocuments);
  return {
    completeness: completenessScore(input.markdown, input.chapters, input.template, moduleCoverageRate),
    specificity: specificityScore(input.chapters, input.factTraces),
    compliance: complianceScore(input.markdown, anyBlockMatches),
    executability: await executabilityScore(input.markdown),
    normalization: normalizationScore(input.issues),
    uniqueness: uniquenessScore(input.markdown, filler),
    moduleCoverageRate,
  };
}
