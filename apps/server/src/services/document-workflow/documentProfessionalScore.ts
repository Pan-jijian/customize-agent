import type { DocumentDraftChapter } from './types';
import { duplicateParagraphIssues, fillerParagraphIssues, processParameterDensityIssues, tableCompletenessIssues, reviewResponseIssues, sectionCardStructureIssues } from './constructionOrgAudit';
import { PROCESS_PARAMETER_RE, QUANTIFIED_BODY_PARAM_RE } from './parameterPatterns';
import { fillerDensityReport } from './tenderBidChecks';
import type { TenderBidTemplatingReport } from './tenderBidScoring';

/**
 * L6 质量度量：施工组织设计专业度评分（7 维）。
 * 每维 0-100 分，加权汇总为专业度总分，用于生成记录页展示与质量报告归档。
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
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 1. 结构完整度：核心结构组是否齐备 */
function structureScore(chapters: DocumentDraftChapter[]): { score: number; detail: string } {
  const wholeText = chapters.map(chapter => `${chapter.title} ${(chapter.sections || []).join(' ')} ${chapter.content}`).join('\n');
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

/** 2. 事实落位率：量化数字与项目事实覆盖。
 * 标尺校准：量化密度系数 18→22；事实词按 18 类覆盖率计分（类数/18×15），消除长文档字数稀释。 */
function factLandingScore(chapters: DocumentDraftChapter[]): { score: number; detail: string } {
  const wholeText = chapters.map(chapter => chapter.content).join('\n');
  const quantified = new Set(wholeText.match(QUANTIFIED_BODY_PARAM_RE) || []);
  const factTokens = new Set(wholeText.match(/工程量|材料|设备|范围|流程|验收|检测|复试|调试|隐蔽|检验批|资料|记录|系统|部位|接口|规格|标准/gu) || []);
  const totalChars = Math.max(1, wholeText.length);
  const quantifiedDensity = quantified.size / (totalChars / 1000);
  const score = clamp(Math.min(100, quantifiedDensity * 22 + (factTokens.size / 18) * 15));
  return { score, detail: `量化参数 ${quantified.size} 项（每千字 ${quantifiedDensity.toFixed(1)}），专业事实词 ${factTokens.size}/18 类` };
}

/** 3. 工艺参数密度。
 * 标尺校准：口径扩展为参数库统一口径（强度等级 M5.0/C25、体积面积 m³/m²、绝缘电阻 MΩ、养护时间等）；
 * 公式由 密度×12+20 调整为 密度×20+40，与参考库优秀样本锚定。 */
function processParameterScore(chapters: DocumentDraftChapter[]): { score: number; detail: string } {
  const wholeText = chapters.map(chapter => chapter.content).join('\n');
  const processParams = new Set(wholeText.match(PROCESS_PARAMETER_RE) || []);
  const totalChars = Math.max(1, wholeText.length);
  const density = processParams.size / (totalChars / 1000);
  const score = clamp(Math.min(100, density * 20 + 40));
  return { score, detail: `工艺参数 ${processParams.size} 项（每千字 ${density.toFixed(1)}）` };
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
    const bodyRows = tableLines.slice(1).filter(row => row.replace(/\|/gu, '').replace(/[\s\-:]/gu, '').length > 0);
    const emptyCells = bodyRows.reduce((total, row) => {
      const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
      return total + cells.filter(cell => cell === '' || cell === '-' || cell === '—' || cell === '/').length;
    }, 0);
    if (emptyCells === 0) completeTables += 1;
  }
  const score = tableCount === 0 ? 40 : clamp((completeTables / tableCount) * 100);
  return { score, detail: `表格 ${tableCount} 个，其中字段完整 ${completeTables} 个` };
}

/** 5. 废话率（反比）：叠加 docx 套话密度口径（核心章节套话占比 ≤10%，超标线性扣分） */
async function fillerScore(chapters: DocumentDraftChapter[]): Promise<{ score: number; detail: string }> {
  const fillerIssues = fillerParagraphIssues(chapters);
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

/** 7. 评标响应度 */
function reviewResponseScore(chapters: DocumentDraftChapter[], markdown = ''): { score: number; detail: string } {
  const wholeText = markdown || chapters.map(chapter => chapter.content).join('\n\n');
  const responseItems: Array<{ label: string; pattern: RegExp }> = [
    { label: '质量标准', pattern: /质量标准|质量要求|合格率/u },
    { label: '计划工期', pattern: /计划工期|工期要求|日历天/u },
    { label: '保修', pattern: /缺陷责任期|保修|质保/u },
    { label: '安全目标', pattern: /安全.{0,8}目标|文明.{0,8}目标/u },
    { label: '项目经理', pattern: /项目经理|项目负责人/u },
  ];
  const reviewIssues = reviewResponseIssues(chapters, markdown);
  const hit = responseItems.filter(item => item.pattern.test(wholeText));
  const score = clamp((hit.length / responseItems.length) * 100);
  return { score, detail: `招标硬性要求响应 ${hit.length}/${responseItems.length} 项${reviewIssues.length ? `（未响应：${reviewIssues.map(issue => issue.message.replace(/未检测到对招标硬性要求的响应：/u, '')).join('、')}）` : ''}` };
}

export async function buildProfessionalScoreReport(chapters: DocumentDraftChapter[], markdown = '', options: { templating?: TenderBidTemplatingReport } = {}): Promise<ProfessionalScoreReport> {
  const structure = structureScore(chapters);
  const factLanding = factLandingScore(chapters);
  const processParameter = processParameterScore(chapters);
  const table = tableScore(chapters, markdown);
  const filler = await fillerScore(chapters);
  const duplication = duplicationScore(chapters);
  const reviewResponse = reviewResponseScore(chapters, markdown);

  const dimensions: ProfessionalDimension[] = [
    { key: 'structure', label: '结构完整度', score: structure.score, detail: structure.detail, weight: 0.18 },
    { key: 'factLanding', label: '事实落位率', score: factLanding.score, detail: factLanding.detail, weight: 0.18 },
    { key: 'processParameter', label: '工艺参数密度', score: processParameter.score, detail: processParameter.detail, weight: 0.16 },
    { key: 'table', label: '表格完整度', score: table.score, detail: table.detail, weight: 0.12 },
    { key: 'filler', label: '废话控制', score: filler.score, detail: filler.detail, weight: 0.14 },
    { key: 'duplication', label: '重复控制', score: duplication.score, detail: duplication.detail, weight: 0.12 },
    { key: 'reviewResponse', label: '评标响应度', score: reviewResponse.score, detail: reviewResponse.detail, weight: 0.10 },
  ];
  const total = clamp(dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0));
  // docx 模板化降档：重度模板化直接压到合格线以下，中度压到良好线以下（模板化是核心降档判定）
  const cappedTotal = options.templating?.level === 'heavy' ? Math.min(total, 54) : options.templating?.level === 'medium' ? Math.min(total, 69) : total;
  const grade: ProfessionalScoreReport['grade'] = cappedTotal >= 85 ? '专业' : cappedTotal >= 70 ? '良好' : cappedTotal >= 55 ? '合格' : '待提升';
  const topIssues = [...duplicateParagraphIssues(chapters), ...fillerParagraphIssues(chapters), ...processParameterDensityIssues(chapters), ...sectionCardStructureIssues(chapters)]
    .slice(0, 5)
    .map(issue => issue.message);
  const weakDimensions = dimensions.filter(dimension => dimension.score < 70).map(dimension => `${dimension.label}（${dimension.score}分）`);
  return {
    total: cappedTotal,
    grade,
    dimensions,
    summary: `施工组织设计专业度评分 ${cappedTotal} 分（${grade}）${options.templating && options.templating.level !== 'light' ? `；模板化等级：${options.templating.level === 'heavy' ? '重度' : '中度'}（降档已生效）` : ''}${weakDimensions.length ? `；待提升：${weakDimensions.join('、')}` : ''}`,
    topIssues,
  };
}
