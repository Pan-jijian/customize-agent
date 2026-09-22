import type { DocumentDraftChapter } from './types';
import { duplicateParagraphIssues, fillerParagraphIssues, processParameterDensityIssues, sectionCardStructureIssues } from './constructionOrgAudit';
import { stripTableCellInvisibleChars } from './helpers/markdownCleanup';
import { PROCESS_PARAMETER_RE, QUANTIFIED_BODY_PARAM_RE } from './parameterPatterns';
import { fillerDensityReport } from './tenderBidChecks';
import { extractContextualTokens, narrativeCharCount, narrativeSentences, sentenceHasCommitmentContext } from './narrativeContext';
import { PROFESSIONAL_SCORE_CALIBER, type ScoringCaliberStamp } from './scoringCalibration';
import type { TenderBidTemplatingReport } from './tenderBidScoring';

/**
 * L6 质量度量：施工组织设计专业度评分（7 维）。
 * 每维 0-100 分，加权汇总为专业度总分，用于生成记录页展示与质量报告归档。
 * C0-2 语境约束校准：密度型（事实落位/工艺参数）token 仅从叙述句提取、
 * 词面型（评标响应）要求「响应词 + 承诺语境」同句出现、结构完整度加章级叙述字数门禁——
 * 词表/参数堆叠的无完整句文档（历史实测专业分 87）在语境约束后各维归零。
 * 口径定位：本报告为从属展示口径（交付主尺为六维质量报告），caliber 字段标注关系。
 */

export interface ProfessionalDimension {
  key: string;
  label: string;
  score: number;
  detail: string;
  weight: number;
}

export interface ProfessionalScoreReport {
  total: number;
  grade: '专业' | '良好' | '合格' | '待提升';
  dimensions: ProfessionalDimension[];
  summary: string;
  topIssues: string[];
  /** 评分口径戳（C0-7）：从属展示口径，交付主尺见六维质量报告 */
  caliber: ScoringCaliberStamp;
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 章级叙述字数门禁（C0-2）：低于此值的章不参与结构组判定——结构组词面命中必须建立在
 * 足量叙述正文之上（词表堆叠章（如「工程概况 主要施工内容 …」列表行）不构成结构存在性证据）。 */
const STRUCTURE_NARRATIVE_GATE_CHARS = 200;

/** 1. 结构完整度：核心结构组是否齐备（章级叙述字数门禁：叙述正文不足的章不计命中） */
function structureScore(chapters: DocumentDraftChapter[]): { score: number; detail: string } {
  const wholeText = chapters
    .map(chapter => `${chapter.title} ${(chapter.sections || []).join(' ')} ${chapter.content}`)
    .filter(text => narrativeCharCount(text) >= STRUCTURE_NARRATIVE_GATE_CHARS)
    .join('\n');
  const groups: Array<{ label: string; pattern: RegExp }> = [
    { label: '工程概况', pattern: /工程概况|项目概况|基本概况/u },
    { label: '主要施工内容', pattern: /主要施工内容/u },
    { label: '重难点分析', pattern: /重点.{0,4}难点/u },
    { label: '施工部署', pattern: /施工部署|总体部署|流水/u },
    { label: '进度计划', pattern: /进度计划|工期保障|工期计划/u },
    { label: '质量保证', pattern: /质量保证|质量管理|质量控制/u },
    { label: '安全文明', pattern: /安全.{0,8}(?:管理|措施|文明)|文明施工/u },
    { label: '资源配置', pattern: /劳动力|机械设备|材料.{0,4}计划|资源配置/u },
    { label: '绿色环保', pattern: /绿色施工|扬尘|噪声|环保/u },
    { label: '应急管理', pattern: /应急/u },
  ];
  const hit = groups.filter(group => group.pattern.test(wholeText));
  const score = clamp((hit.length / groups.length) * 100);
  const missing = groups.filter(group => !group.pattern.test(wholeText)).map(group => group.label);
  return { score, detail: `覆盖 ${hit.length}/${groups.length} 个核心结构组${missing.length ? `；缺失：${missing.join('、')}` : ''}` };
}

/** 2. 事实落位率：量化数字与项目事实覆盖（C0-2：token 仅从叙述句提取，罗列段不计）。
 * 标尺校准：量化密度系数 18→22；事实词按 18 类覆盖率计分（类数/18×15），消除长文档字数稀释。 */
function factLandingScore(chapters: DocumentDraftChapter[]): { score: number; detail: string } {
  const wholeText = chapters.map(chapter => chapter.content).join('\n');
  const quantified = extractContextualTokens(wholeText, QUANTIFIED_BODY_PARAM_RE);
  const factTokens = extractContextualTokens(wholeText, /工程量|材料|设备|范围|流程|验收|检测|复试|调试|隐蔽|检验批|资料|记录|系统|部位|接口|规格|标准/gu);
  const totalChars = Math.max(1, wholeText.length);
  const quantifiedDensity = quantified.size / (totalChars / 1000);
  const score = clamp(Math.min(100, quantifiedDensity * 22 + (factTokens.size / 18) * 15));
  return { score, detail: `量化参数 ${quantified.size} 项（每千字 ${quantifiedDensity.toFixed(1)}），专业事实词 ${factTokens.size}/18 类` };
}

/** 3. 工艺参数密度（C0-2：token 仅从叙述句提取，参数堆叠串不计）。
 * 标尺校准：口径扩展为参数库统一口径（强度等级 M5.0/C25、体积面积 m³/m²、绝缘电阻 MΩ、养护时间等）；
 * 公式由 密度×12+20 调整为 密度×20+40，与参考库优秀样本锚定。 */
function processParameterScore(chapters: DocumentDraftChapter[]): { score: number; detail: string } {
  const wholeText = chapters.map(chapter => chapter.content).join('\n');
  const processParams = extractContextualTokens(wholeText, PROCESS_PARAMETER_RE);
  const totalChars = Math.max(1, wholeText.length);
  const density = processParams.size / (totalChars / 1000);
  const score = clamp(Math.min(100, density * 20 + 40));
  return { score, detail: `工艺参数 ${processParams.size} 项（每千字 ${density.toFixed(1)}）` };
}

/**
 * 表格不完整单元格计数（导出供单测）：空单元格与模糊占位符计为不完整，
 * **但遵守写时红线的两条明示例外**（documentWritingTaskBrief.WRITING_INTEGRITY_CONSTRAINTS
 * 「表格规范红线」逐字同源）：「合计行的「—」」与「规格型号列『机具无型号』的「—」」。
 *
 * 历史口径冲突：写时明确允许这两类 `—`（不编造型号/无可加总明细），评分器却一律计为空 →
 * 合规写法被扣分（丰乐镇实测：机械配置表与进场验收表各 4 处规格 `—` 被判不完整，
 * 表格完整度 91 而非 100）。评分必须与写时标准同源，否则「按规范写」反而扣分。
 */
export function countIncompleteTableCells(tableLines: string[]): number {
  const headerCells = (tableLines[0] || '').split('|').slice(1, -1).map(cell => stripTableCellInvisibleChars(cell.trim()));
  const isSpecColumn = (columnIndex: number) => /规格|型号/u.test(headerCells[columnIndex] || '');
  const isTotalRow = (row: string) => /^[\s|]*\|?\s*(?:合计|小计|总计|累计)/u.test(row);
  const bodyRows = tableLines.slice(1).filter(row => row.replace(/\|/gu, '').replace(/[\s\-:]/gu, '').length > 0);
  return bodyRows.reduce((total, row) => {
    const cells = row.split('|').slice(1, -1).map(cell => stripTableCellInvisibleChars(cell.trim()));
    const totalRow = isTotalRow(row);
    return total + cells.filter((cell, columnIndex) => {
      if (cell !== '' && cell !== '-' && cell !== '—' && cell !== '/') return false;
      if (totalRow && cell === '—') return false;
      if (cell === '—' && isSpecColumn(columnIndex)) return false;
      return true;
    }).length;
  }, 0);
}

/** 4. 表格完整度 */
function tableScore(chapters: DocumentDraftChapter[], markdown = ''): { score: number; detail: string } {
  const wholeText = markdown || chapters.map(chapter => chapter.content).join('\n\n');
  const lines = wholeText.split('\n');
  let tableCount = 0;
  let completeTables = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!/^\|.+\|$/u.test(line)) {
      index += 1;
      continue;
    }
    const tableLines: string[] = [];
    while (index < lines.length && /^\|.+\|$/u.test(lines[index].trim())) {
      tableLines.push(lines[index].trim());
      index += 1;
    }
    if (tableLines.length < 3) continue;
    tableCount += 1;
    const emptyCells = countIncompleteTableCells(tableLines);
    if (emptyCells === 0) completeTables += 1;
  }
  const score = tableCount === 0 ? 40 : clamp((completeTables / tableCount) * 100);
  return { score, detail: `表格 ${tableCount} 个，其中字段完整 ${completeTables} 个` };
}

/** 5. 废话率（反比）：叠加 docx 套话密度口径（核心章节套话占比 ≤10%，超标线性扣分） */
async function fillerScore(chapters: DocumentDraftChapter[]): Promise<{ score: number; detail: string }> {
  const fillerIssues = await fillerParagraphIssues(chapters);
  const fillerHits = chapters.reduce((total, chapter) => {
    const count = (chapter.content.match(/本小节围绕|交底覆盖率按100%|24小时内形成整改责任|按施工准备→过程实施→检查验收→问题整改→资料归档的闭环组织|按作业条件确认→技术交底→过程实施|依据本项目已确认资料中的项目边界/gu) || []).length;
    return total + count;
  }, 0);
  const filler = await fillerDensityReport(chapters.map(chapter => chapter.content).join('\n'));
  // docx：套话占比 ≤10% 为达标线；超标部分线性扣分（每超 10 个百分点扣 40 分），叠加深套话短语命中扣分
  const ratioPenalty = Math.max(0, filler.ratio - 0.1) * 400;
  const score = clamp(100 - fillerHits * 15 - fillerIssues.filter(issue => issue.level === 'error').length * 25 - ratioPenalty);
  return { score, detail: `模板化空话命中 ${fillerHits} 处，套话句占比 ${(filler.ratio * 100).toFixed(1)}%（docx 达标线 ≤10%），废话段问题 ${fillerIssues.length} 项` };
}

/** 6. 重复率（反比） */
function duplicationScore(chapters: DocumentDraftChapter[]): { score: number; detail: string } {
  const duplicateIssues = duplicateParagraphIssues(chapters);
  const score = clamp(100 - duplicateIssues.length * 20 - duplicateIssues.filter(issue => issue.level === 'error').length * 20);
  return { score, detail: `重复段落问题 ${duplicateIssues.length} 项` };
}

/** 7. 评标响应度：招标硬性要求响应检测统一由 tenderRequirements.ts 锚点级语义通道
 * （requirementAcceptanceIssues）承担，本维度仅保留评分用的词面响应率快照，
 * 不再复用已删除的 constructionOrgAudit.reviewResponseIssues（阶段五 5.3 口径分裂治理）。
 * C0-2 语境约束：响应词必须与承诺语境同句出现（叙述句内）——词表行/标题行内出现响应词
 * 不构成响应（历史实测：无完整句的响应词表文档评标响应 100 分）。 */
function reviewResponseScore(chapters: DocumentDraftChapter[], markdown = ''): { score: number; detail: string } {
  const wholeText = markdown || chapters.map(chapter => chapter.content).join('\n\n');
  const sentences = narrativeSentences(wholeText);
  const responseItems: Array<{ label: string; pattern: RegExp }> = [
    { label: '质量标准', pattern: /质量标准|质量要求|合格率/u },
    { label: '计划工期', pattern: /计划工期|工期要求|日历天/u },
    { label: '保修', pattern: /缺陷责任期|保修|质保/u },
    { label: '安全目标', pattern: /安全.{0,8}目标|文明.{0,8}目标/u },
    { label: '项目经理', pattern: /项目经理|项目负责人/u },
  ];
  const hit = responseItems.filter(item => sentences.some(sentence => item.pattern.test(sentence) && sentenceHasCommitmentContext(sentence)));
  const missed = responseItems.filter(item => !hit.includes(item));
  const score = clamp((hit.length / responseItems.length) * 100);
  return { score, detail: `招标硬性要求响应 ${hit.length}/${responseItems.length} 项${missed.length ? `（未响应：${missed.map(item => item.label).join('、')}）` : ''}` };
}

/**
 * 表述实质性维度（替代原「重度模板化 → 总分封顶 54」）：
 * 把模板化报告的各分项按**各自既有验收线**折算为连续分——
 *   ① 套话句占比（线 ≤10%）：每超 10 个百分点扣 30 分
 *   ② 模糊应答词（零出现要求）：每处扣 8 分，上限 40
 *   ③ 重难点「归因+量化」双达标（线 ≥50%）：不足部分按差值 ×60 扣分，上限 30
 *   ④ 跨项目内容残留（零残留要求）：每处扣 10 分，上限 30
 * 保留信号、去掉单点否决：模板化严重时该维度显著低分并拖累总分，但不再把其他维度的
 * 真实水平一并抹掉（巢湖：六项满分被压到 54，掩盖了数据锚定/事实一致性等真实短板）。
 */
export function templatingSubstanceScore(report?: TenderBidTemplatingReport): { score: number; detail: string } {
  if (!report) return { score: 100, detail: '模板化未检测（无信号，按满分计）' };
  const fillerPenalty = Math.max(0, report.fillerRatio - 0.1) * 300;
  const vaguePenalty = Math.min(40, report.vagueHitCount * 8);
  // 重难点扣分只依据**量化目标**达标率（结构判定，可靠）；归因半项经实测无分辨力（见 tenderBidChecks
  // 的 heavyTemplated 注释：含成因段落 0.53~0.565 / 不含成因段落 0.53~0.57，同区间），故不上分。
  const measurableRatio = report.difficultyCountermeasures > 0
    ? report.difficultyQuantifiedCount / report.difficultyCountermeasures
    : 1;
  const difficultyPenalty = report.difficultyCountermeasures > 0
    ? Math.min(30, Math.max(0, 0.5 - measurableRatio) * 60)
    : 0;
  const residuePenalty = Math.min(30, report.crossProjectResidue.length * 10);
  const score = clamp(100 - fillerPenalty - vaguePenalty - difficultyPenalty - residuePenalty);
  return {
    score,
    detail: `套话句占比 ${(report.fillerRatio * 100).toFixed(1)}%（线 ≤10%）、模糊应答词 ${report.vagueHitCount} 处、`
      + `重难点量化达标 ${report.difficultyQuantifiedCount}/${report.difficultyCountermeasures}（线 ≥50%）、跨项目残留 ${report.crossProjectResidue.length} 处`
      + `；扣分 ${fillerPenalty.toFixed(0)}+${vaguePenalty.toFixed(0)}+${difficultyPenalty.toFixed(0)}+${residuePenalty.toFixed(0)}`,
  };
}

export async function buildProfessionalScoreReport(chapters: DocumentDraftChapter[], markdown = '', options: { templating?: TenderBidTemplatingReport } = {}): Promise<ProfessionalScoreReport> {
  const structure = structureScore(chapters);
  const factLanding = factLandingScore(chapters);
  const processParameter = processParameterScore(chapters);
  const table = tableScore(chapters, markdown);
  const filler = await fillerScore(chapters);
  const duplication = duplicationScore(chapters);
  const reviewResponse = reviewResponseScore(chapters, markdown);

  // 表述实质性（模板化信号降权并入，替代原「重度→总分封顶 54」的单点否决）：
  // 原口径把持续量压成二值且会掩盖真实短板（巢湖实测：七维六项满分、加权 98.6，却因归因闸门
  // 判重度模板化被压到 54；而实质短板在数据锚定 64、事实一致性 28，与模板化无关）。
  // 现口径：模板化各分项按**各自既有验收线**折分，作为加权维度参与，不再封顶总分。
  const templatingSubstance = templatingSubstanceScore(options.templating);
  // 无模板化信号时**不引入该维度**（否则等于白送 20 分——对抗套件实测：堆词文档本就无套话/残留信号，
  // 该维度会按"无信号"给满分，把 45 分抬到 47，削弱防骗分闸门）；有信号时才计入并按 0.8 重标定七维。
  const baseDimensions: Array<ProfessionalDimension & { baseWeight: number }> = [
    { key: 'structure', label: '结构完整度', score: structure.score, detail: structure.detail, weight: 0, baseWeight: 0.18 },
    { key: 'factLanding', label: '事实落位率', score: factLanding.score, detail: factLanding.detail, weight: 0, baseWeight: 0.18 },
    { key: 'processParameter', label: '工艺参数密度', score: processParameter.score, detail: processParameter.detail, weight: 0, baseWeight: 0.16 },
    { key: 'table', label: '表格完整度', score: table.score, detail: table.detail, weight: 0, baseWeight: 0.12 },
    { key: 'filler', label: '废话控制', score: filler.score, detail: filler.detail, weight: 0, baseWeight: 0.14 },
    { key: 'duplication', label: '重复控制', score: duplication.score, detail: duplication.detail, weight: 0, baseWeight: 0.12 },
    { key: 'reviewResponse', label: '评标响应度', score: reviewResponse.score, detail: reviewResponse.detail, weight: 0, baseWeight: 0.10 },
  ];
  const templatingWeight = options.templating ? 0.2 : 0;
  const dimensions: ProfessionalDimension[] = [
    ...baseDimensions.map(({ baseWeight, ...dimension }) => ({ ...dimension, weight: Number((baseWeight * (1 - templatingWeight)).toFixed(4)) })),
    ...(templatingWeight > 0 ? [{ key: 'templating', label: '表述实质性', score: templatingSubstance.score, detail: templatingSubstance.detail, weight: templatingWeight }] : []),
  ];
  const total = clamp(dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0));
  const grade: ProfessionalScoreReport['grade'] = total >= 85 ? '专业' : total >= 70 ? '良好' : total >= 55 ? '合格' : '待提升';
  const topIssues = [...duplicateParagraphIssues(chapters), ...await fillerParagraphIssues(chapters), ...processParameterDensityIssues(chapters), ...sectionCardStructureIssues(chapters)]
    .slice(0, 5)
    .map(issue => issue.message);
  const weakDimensions = dimensions.filter(dimension => dimension.score < 70).map(dimension => `${dimension.label}（${dimension.score}分）`);
  return {
    total,
    grade,
    dimensions,
    summary: `施工组织设计专业度评分 ${total} 分（${grade}；从属口径，交付主尺见六维质量报告）${options.templating && options.templating.level !== 'light' ? `；模板化等级：${options.templating.level === 'heavy' ? '重度' : '中度'}（已按「表述实质性」维度计分，不再封顶总分）` : ''}${weakDimensions.length ? `；待提升：${weakDimensions.join('、')}` : ''}`,
    topIssues,
    caliber: PROFESSIONAL_SCORE_CALIBER,
  };
}
