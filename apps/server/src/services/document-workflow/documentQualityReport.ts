import { buildTenderBidScores, buildTenderBidTemplatingReport, MANDATORY_MODULE_QUERIES } from './tenderBidScoring';
import { collectFigurePlaceholderSpecs, figureCoverage, tablePlanExecutionGaps } from './constructionOrgTablePlan';
import { drawingFactPlacement, type DrawingFactLock } from './drawingFactLock';
import { bodyCompositionTableIssues, tableCaptionCoverage } from './markdownComposer';
import { scanBillExplicitDispositions } from './billFactLock';
import { appendixEntryCarried } from './composeAppendices';
import { tenderRequirementResponseGaps } from './tenderRequirements';
import { documentTextLength } from './budget';
import { classifyBlockingIssue, professionalDepthTotal, professionalScoreTargetLine } from './qualityValidation';
import { countTableArithmeticFindings } from './integrity/detectors/detectors';
import { buildEvaluationCriteriaAttainmentAudit } from './evaluationCriteriaMapping';
import { auditBasisRegulationsCross } from './basisRegulationsCross';
import { QUALITY_REPORT_CALIBER, SCORING_CALIBRATION_VERSION } from './scoringCalibration';
import type { AuthorityAuditReport } from './authorityAudit';
import type { ProfessionalDepthClassifier } from './professionalDepthClassifier';
import type { BidAppendixEntry, BidCompositionSpec } from './bidComposition';
import type {
  BoqRowTrace, DocumentDraftChapter, DocumentFactTrace, DocumentKnowledgeCoverageReport, DocumentQualityDimension,
  DocumentQualityReport, DocumentRequirementChecklistItem, DocumentTemplate, DocumentTemplateChapter,
  TenderRequirementModel, ValidationIssue,
} from './types';

/**
 * 招标技术标评审口径评分 v3（对齐口径 E，确定性计算，非 LLM；产品级通用公式，零项目语义）：
 * 维度与权重：要求实体响应 30% / 结构呈现落实 15% / 数据锚定 20% / 专业深度 15% / 合规与规范 10% /
 * 事实完整与一致性 10%。设计基准（repair-master-plan 4.2）：六个维度各自达到目标态时总分恰为 95
 * （27 + 15 + 18 + 15 + 10 + 10），95+ 只能由实体质量全达标构成，机制分不再虚高（D3 根治）。
 * 五条铁律落地：①要求响应=锚点全命中率（纯确定性对账，非终检指纹消费——D1 口径过宽根治）
 * ②评分域含结构域与数据域（图表落位 / BOQ / 参数 / 图纸 / 数字溯源——D2 盲区根治）
 * ③结构/机制分量保持但受实体分量制约 ④双数收敛 delivery = overall − min(10, blocking×3)（D4 根治）
 * ⑤防通胀：历史缺陷样本（r28f）在诚实口径下 <75（校准套件固化）。
 * 低雷同性在评审逻辑中是触发式否决项（与公开模板重合度超 30% 触发雷同判定），不作为线性权重维度，
 * 而是对加权结果做乘数修正（uniqueness 低于 90 分开始拉低 overall）。
 * 双模式感知：bidComposition 结构口径（明标=表计划逐表对账+图位+题注；暗标=附表区承载率+正文表格合规——
 * 显式禁表句按表格行数、允许口径（C1 证据判定）按章级授权，与终检门禁同源）。
 * 降级原则：任一构成输入缺失（无要求模型/无编制规格/无表计划/无审计源）→ 对应分量「不可用」显式降级
 * （不计不扣、不在 summary 显示、权重按可用集合两级重归一），不伪造满分、不制造惩罚。
 * 内部质量门禁（error 级：事实安全/污染/结构缺陷）与评分分离，继续通过 blockingIssues 收敛交付置信度。
 */

/** 维度权重（产品级通用常量，与项目无关；目标态全达标 = 95 分的精确构造） */
/**
 * 质量报告的**最低权重覆盖率**（G 线 P3-4/P3-1）。
 *
 * `weighted` 是可用维度的重归一分：不可用维度被剔除分母后归一，于是仅 2 个维度参与时
 * 也可能算出 95 分，而读者无从知道这个 95 只来自 2/6 维。覆盖率下限强制两件事：
 * ① 报告显性打印「本次仅计量 X/6 维、权重覆盖 Y%」；
 * ② 覆盖率不足时 `passed` 不成立 —— 不得用重归一分宣告达标。
 */
export const MIN_QUALITY_COVERAGE = 0.9;

export const QUALITY_DIMENSION_WEIGHTS = {
  requirement: 0.3,
  structure: 0.15,
  dataAnchor: 0.2,
  professionalDepth: 0.15,
  compliance: 0.1,
  factIntegrity: 0.1,
} as const;

/** 要求实体响应构成权重：①锚点全命中率（respond 类逐条对账）②强制模块覆盖 */
export const REQUIREMENT_PART_WEIGHTS = { anchors: 0.85, modules: 0.15 } as const;

/** 结构呈现落实构成权重（明标口径：表计划执行率 + 图位覆盖率 + 正文题注覆盖率；暗标显式禁表口径 bodyTablePolicy=forbidden：附表区承载率 + 正文禁表合规；
 * 暗标允许口径（C1）：附表区承载率 + 表计划执行率 + 正文表格授权合规 + 题注覆盖率） */
export const STRUCTURE_PART_WEIGHTS = { execution: 0.45, figure: 0.35, caption: 0.2, appendix: 0.75, bodyCompliance: 0.25 } as const;

/** 数据锚定构成权重：①BOQ 有效行落位率 ②参数义务满足率 ③图纸事实引用率 ④数字溯源（无主数值审计） */
export const DATA_ANCHOR_PART_WEIGHTS = { boq: 0.4, parameters: 0.3, drawing: 0.15, authority: 0.15 } as const;

/** 合规与规范构成权重：①自伤表述 ②占位符 ③篇幅达标 ④表内算术自洽 ⑤编制依据↔正文双向对账（C5 P6；
 * 目标态五分量全 100 → 维度 100，95 目标态构造不变） */
export const COMPLIANCE_PART_WEIGHTS = { selfHarm: 0.25, placeholder: 0.2, length: 0.15, tableConsistency: 0.2, regulation: 0.2 } as const;

/** 事实完整与一致性构成权重：①事实一致性对账 ②规格/名称/合计绑定冲突 ③关键事实落位率 */
export const FACT_INTEGRITY_PART_WEIGHTS = { reconciliation: 0.6, binding: 0.2, keyFacts: 0.2 } as const;

/** 单条 fact_consistency error 级冲突在对账/绑定子分量中的扣分（0 冲突=100） */
export const ACCURACY_ERROR_PENALTY = 20;

/** 合规类命中扣分（自伤/占位符：每处 25；篇幅：每条 50；表内不自洽：每处 20，均下限 0） */
export const COMPLIANCE_HIT_PENALTY = 25;
export const LENGTH_HIT_PENALTY = 50;
export const TABLE_CONSISTENCY_HIT_PENALTY = 20;

/** 编制依据对账缺口扣分（每处缺口 20，下限 0；计数源 = auditBasisRegulationsCross 与检测器同源） */
export const REGULATION_GAP_PENALTY = 20;

/** 数字溯源扣分（无主数值审计三桶缺口每处 5 分，下限 0） */
export const AUTHORITY_GAP_PENALTY = 5;

/**
 * 低雷同性门槛（G 线 P3-3）：uniqueness 由「乘性压缩 overall」改为「独立否决门槛」。
 * 取值依据：评审逻辑本就把低雷同性当触发式否决项（与公开模板重合度超 30% 触发雷同判定），
 * 60 分对应「重合度明显偏高、需人工研判」的水平。低于该值判雷同风险，直接判报告未通过。
 */
export const UNIQUENESS_FLOOR = 60;

/** 双数收敛常量：delivery = overall − min(DELIVERY_PENALTY_CAP, blocking×DELIVERY_BLOCKING_PENALTY) */
export const DELIVERY_BLOCKING_PENALTY = 3;
export const DELIVERY_PENALTY_CAP = 10;

/** 事实一致性冲突类问题 category（对账口径计数源） */
const FACT_CONSISTENCY_CATEGORY = 'fact_consistency';

/** 事实一致性「绑定」子集消息特征：规格/名称/合计值绑定错位 */
const ACCURACY_BINDING_RE = /规格-数值绑定|名称-数值绑定|合计值/u;

/** 编制依据对账缺口消息锚（C5 P6）：缺口由合规维度·编制依据分量单源计数，事实一致性对账不双计 */
const REGULATION_GAP_MESSAGE_RE = /编制依据对账缺口/u;

/** 合规检查消息锚（A-F 批次确定性检测器，与修复轮同源）：自伤表述 / 占位符 / 篇幅 /（表自洽直算） */
const COMPLIANCE_MESSAGE_RES = {
  selfHarm: /自伤表述/u,
  placeholder: /占位符|占位式表达/u,
  length: /正文篇幅/u,
} as const;

type QualityMode = 'blind' | 'open' | 'unknown';

/** 评分分量：value=null 表示输入缺失显式降级（不计不扣、权重重归一） */
interface ScorePart {
  value: number | null;
  detail?: string;
}

/** 分量加权组装（维度内与维度间共用的两级重归一）：仅计可用分量，按可用权重集合归一；全部不可用返回 null */
function weighParts(parts: Array<ScorePart & { weight: number }>): ScorePart {
  const available = parts.filter((part): part is ScorePart & { value: number; weight: number } => part.value !== null && Number.isFinite(part.value));
  if (available.length === 0) return { value: null };
  const weightSum = available.reduce((sum, part) => sum + part.weight, 0);
  const value = available.reduce((sum, part) => sum + part.value * part.weight, 0) / weightSum;
  const detail = available.map(part => part.detail).filter((text): text is string => Boolean(text)).join('、') || undefined;
  return { value, detail };
}

/** 强制模块覆盖率（buildTenderBidScores 单源判定透传，避免二次嵌入） */
function moduleCoveragePart(moduleCoverageRate: number): ScorePart {
  if (!Number.isFinite(moduleCoverageRate)) return { value: null };
  const hits = Math.round(moduleCoverageRate * MANDATORY_MODULE_QUERIES.length);
  return { value: moduleCoverageRate * 100, detail: `强制模块 ${hits}/${MANDATORY_MODULE_QUERIES.length}` };
}

/** C-T5 清单落位审计（豁免行清单可审计）：有效行=非豁免行（口径行豁免登记）；落位率=字面落位/有效行；
 * 显性说明行单独登记——说明句本身构成字面落位（命中在已落位行内），审计区分「说明式处置」与「施工内容落位」 */
function buildBillPlacementAudit(markdown: string, boqRowTraces: BoqRowTrace[]): DocumentQualityReport['billPlacementAudit'] {
  const effectiveTraces = boqRowTraces.filter(trace => !trace.exempt);
  const placedTraces = effectiveTraces.filter(trace => trace.placed);
  const explicitDispositions = placedTraces.length > 0
    ? scanBillExplicitDispositions(markdown, placedTraces.map(trace => trace.itemName))
    : new Map<string, string>();
  return boqRowTraces.length > 0
    ? {
        effectiveRows: effectiveTraces.length,
        placedRows: placedTraces.length,
        explicitRows: explicitDispositions.size,
        rate: effectiveTraces.length > 0 ? placedTraces.length / effectiveTraces.length : null,
        exemptRows: boqRowTraces.filter(trace => trace.exempt).slice(0, 50).map(trace => `${trace.itemName}${trace.quantity ? ` ${trace.quantity}${trace.unit}` : ''}`),
      }
    : undefined;
}

/** 正文禁表合规（显式禁表句口径）：正文区（第一个附表标题之前）表格行计数；附表清单为空时全文即正文。
 * 正文出现表格本属 F-T3 硬门禁（阻断修复），评分再计一遍形成双保险（合规硬项不豁免）。 */
function bodyTableViolationCount(markdown: string, plan: BidAppendixEntry[]): number {
  let start = -1;
  for (const entry of plan) {
    const index = markdown.indexOf(`## ${entry.title}`);
    if (index >= 0 && (start < 0 || index < start)) start = index;
  }
  const body = start >= 0 ? markdown.slice(0, start) : markdown;
  return body.match(/^\s*\|/gmu)?.length || 0;
}

/** 结构呈现落实（模式感知 + C1 正文表格口径证据判定）：明标=表计划执行率 + 图位覆盖率 + 正文题注覆盖率；
 * 暗标=附表区承载率（appendixPlan 逐项内容级承载判定）+ 正文表格合规——显式禁表句（forbidden）按正文表格行数，
 * 允许口径（allowed）按章级授权（未授权章表格违规，与终检门禁 bodyCompositionTableIssues 同源）+ 表执行率 + 题注覆盖率；
 * 暗标禁图时图位不适用自动跳过。 */
function structurePart(input: {
  markdown: string;
  mode: QualityMode;
  bidComposition?: BidCompositionSpec | null;
  effectiveChapters?: DocumentTemplateChapter[];
  chapters: DocumentDraftChapter[];
}): ScorePart {
  const { markdown, mode, bidComposition, effectiveChapters, chapters } = input;
  if (mode === 'blind') {
    const parts: Array<ScorePart & { weight: number }> = [];
    const plan = bidComposition?.appendixPlan || [];
    if (plan.length > 0) {
      const carried = plan.filter(entry => appendixEntryCarried(markdown, entry)).length;
      parts.push({ weight: STRUCTURE_PART_WEIGHTS.appendix, value: (carried / plan.length) * 100, detail: `附表承载 ${carried}/${plan.length}` });
    }
    if (bidComposition?.bodyTablePolicy === 'forbidden') {
      const violations = bodyTableViolationCount(markdown, plan);
      parts.push({
        weight: STRUCTURE_PART_WEIGHTS.bodyCompliance,
        value: Math.max(0, 100 - violations * COMPLIANCE_HIT_PENALTY),
        detail: violations > 0 ? `正文禁表 违规 ${violations} 处` : '正文禁表合规',
      });
    } else {
      // 允许口径（C1）：表格按系统表格计划输出——表执行率 + 未授权章表格合规（暗标禁图，图位不适用）
      const plannedTotal = (effectiveChapters || []).reduce((sum, chapter) => sum + (chapter.tablePlans?.length || 0), 0);
      if (plannedTotal > 0 && effectiveChapters) {
        const missing = tablePlanExecutionGaps(effectiveChapters, chapters).reduce((sum, gap) => sum + gap.plans.length, 0);
        const executed = Math.max(0, plannedTotal - missing);
        parts.push({ weight: STRUCTURE_PART_WEIGHTS.execution, value: (executed / plannedTotal) * 100, detail: `表执行 ${executed}/${plannedTotal}` });
      }
      const plannedTitles = (effectiveChapters || [])
        .filter(chapter => (chapter.tablePlans?.length || 0) > 0 || (chapter.tableSections?.length || 0) > 0 || (chapter.diagramRequirements?.length || 0) > 0)
        .map(chapter => chapter.title);
      const unplanned = bodyCompositionTableIssues(markdown, { bodyTableForbidden: false, plannedChapterTitles: plannedTitles }).length;
      parts.push({
        weight: STRUCTURE_PART_WEIGHTS.bodyCompliance,
        value: Math.max(0, 100 - unplanned * COMPLIANCE_HIT_PENALTY),
        detail: unplanned > 0 ? `正文未授权表格 违规 ${unplanned} 处` : '正文表格授权合规',
      });
      const caption = tableCaptionCoverage(markdown, false);
      if (caption.total > 0) {
        parts.push({ weight: STRUCTURE_PART_WEIGHTS.caption, value: (caption.captioned / caption.total) * 100, detail: `题注 ${caption.captioned}/${caption.total}` });
      }
    }
    return weighParts(parts);
  }
  const parts: Array<ScorePart & { weight: number }> = [];
  const plannedTotal = (effectiveChapters || []).reduce((sum, chapter) => sum + (chapter.tablePlans?.length || 0), 0);
  if (plannedTotal > 0 && effectiveChapters) {
    const missing = tablePlanExecutionGaps(effectiveChapters, chapters).reduce((sum, gap) => sum + gap.plans.length, 0);
    const executed = Math.max(0, plannedTotal - missing);
    parts.push({ weight: STRUCTURE_PART_WEIGHTS.execution, value: (executed / plannedTotal) * 100, detail: `表执行 ${executed}/${plannedTotal}` });
  }
  // B-T1 图位覆盖（图类要求 ↔ 正文规范图题；无图类要求时不可用降级不参与）
  const figureSpecs = collectFigurePlaceholderSpecs({ chapters: effectiveChapters });
  if (figureSpecs.length > 0) {
    const figure = figureCoverage(figureSpecs, markdown);
    parts.push({ weight: STRUCTURE_PART_WEIGHTS.figure, value: (figure.covered / figure.total) * 100, detail: `图位 ${figure.covered}/${figure.total}` });
  }
  const caption = tableCaptionCoverage(markdown, bidComposition?.bodyTablePolicy === 'forbidden');
  if (caption.total > 0) {
    parts.push({ weight: STRUCTURE_PART_WEIGHTS.caption, value: (caption.captioned / caption.total) * 100, detail: `题注 ${caption.captioned}/${caption.total}` });
  }
  return weighParts(parts);
}

/** 数据锚定：BOQ 有效行落位率（C-T5）+ 参数义务满足率（C-T6）+ 图纸事实引用率（B-T3）+
 * 数字溯源（F-T4 无主数值审计：三桶缺口每处扣 5，零缺口=100）；各源缺失时分量降级不计不扣 */
function dataAnchorPart(input: {
  markdown: string;
  billPlacementAudit: DocumentQualityReport['billPlacementAudit'];
  parameterUsageAudit?: DocumentQualityReport['parameterUsageAudit'];
  drawingFactLock?: DrawingFactLock;
  authorityAuditReport?: AuthorityAuditReport;
}): ScorePart {
  const { markdown, billPlacementAudit, parameterUsageAudit, drawingFactLock, authorityAuditReport } = input;
  const parts: Array<ScorePart & { weight: number }> = [];
  if (billPlacementAudit && billPlacementAudit.rate !== null && Number.isFinite(billPlacementAudit.rate)) {
    parts.push({ weight: DATA_ANCHOR_PART_WEIGHTS.boq, value: billPlacementAudit.rate * 100, detail: `BOQ 落位 ${billPlacementAudit.placedRows}/${billPlacementAudit.effectiveRows}` });
  }
  if (parameterUsageAudit && parameterUsageAudit.rate !== null && Number.isFinite(parameterUsageAudit.rate)) {
    parts.push({ weight: DATA_ANCHOR_PART_WEIGHTS.parameters, value: parameterUsageAudit.rate * 100, detail: `参数 ${parameterUsageAudit.usedParams}/${parameterUsageAudit.usedParams + parameterUsageAudit.relevantMissedCount}` });
  }
  // 降级治理：图纸分量**不可用时必须显式标注**。原实现直接不入 parts ⇒ `weighParts` 按剩余分量
  // 重归一 ⇒ 维度分被抬高（少一个低分分量，均值反而上升），而读者只看到「数据锚定 92」，
  // 看不到图纸那一路根本没测。这与「覆盖率前置」是同一类问题（覆盖面必须可见）。
  const drawingMissingReason = !drawingFactLock
    ? '图纸事实锁不可用（未构建或构建失败）'
    : drawingFactLock.groups.length === 0
      ? '图纸事实锁无可用分组（无图纸类证据入库）'
      : undefined;
  if (drawingFactLock && drawingFactLock.groups.length > 0) {
    const placement = drawingFactPlacement(drawingFactLock, markdown);
    parts.push({ weight: DATA_ANCHOR_PART_WEIGHTS.drawing, value: placement.rate * 100, detail: `图纸事实 ${placement.referenced.length}/${drawingFactLock.groups.length}` });
  }
  if (authorityAuditReport) {
    const gapCount = authorityAuditReport.unregisteredCount + authorityAuditReport.derivationGaps.length + authorityAuditReport.processGaps.length;
    parts.push({
      weight: DATA_ANCHOR_PART_WEIGHTS.authority,
      value: Math.max(0, 100 - gapCount * AUTHORITY_GAP_PENALTY),
      detail: gapCount > 0 ? `无主数值 缺口 ${gapCount} 处` : '无主数值 0 缺口',
    });
  }
  const weighed = weighParts(parts);
  if (drawingMissingReason && weighed.value !== null) {
    weighed.detail = `${weighed.detail ? `${weighed.detail}；` : ''}⚠ ${drawingMissingReason}，图纸分量未计量（本维度按剩余分量重归一）`;
  }
  return weighed;
}

/** 专业深度：章级（≥800 字，与 professionalScoreIssues 同口径）六维语义评分（12 分制，qualityValidation 单源）
 * 按章目标线归一（资源类 10/12，其余 8/12）——达标即满分，未达标按比例；分析器缺失/无可评章时降级不计不扣 */
async function professionalDepthPart(chapters: DocumentDraftChapter[], classifier: ProfessionalDepthClassifier | undefined): Promise<ScorePart> {
  if (!classifier) return { value: null };
  const scored = chapters.filter(chapter => documentTextLength(chapter.content) >= 800);
  if (scored.length === 0) return { value: null };
  // 降级治理：分析失败的章原来被 `.filter(Boolean)` 静默摘除（分母变小、均值被抬高），
  // 且**哪些章失败、为什么失败**全程不可见。现计数并在 detail 中显式标注。
  const analysisFailures: string[] = [];
  const analyses = await Promise.all(scored.map(chapter => classifier.analyze(chapter.content).catch((error: unknown) => {
    analysisFailures.push(`${chapter.title}：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  })));
  const entries = scored
    .map((chapter, index) => ({ title: chapter.title, analysis: analyses[index] }))
    .filter((entry): entry is { title: string; analysis: NonNullable<typeof entry.analysis> } => Boolean(entry.analysis));
  if (entries.length === 0) return { value: null };
  let sum = 0;
  const weak: string[] = [];
  for (const entry of entries) {
    const total = professionalDepthTotal(entry.analysis.dimensions);
    const line = professionalScoreTargetLine(entry.title);
    sum += Math.min(1, total / line);
    if (total < line) weak.push(`${entry.title} ${total}/12`);
  }
  const value = (sum / entries.length) * 100;
  // 降级治理：分析失败的章必须可见（否则「分母变小抬高均值」对读者完全不可见）
  const failureNote = analysisFailures.length > 0 ? `；⚠ ${analysisFailures.length} 章语义分析失败未计入（${analysisFailures.slice(0, 2).join('；')}）` : '';
  const detail = (weak.length > 0
    ? `专业深度达标 ${Math.round(value)}（薄弱：${weak.slice(0, 3).join('、')}）`
    : `专业深度达标 ${Math.round(value)}（全部章达目标线）`) + failureNote;
  return { value, detail };
}

/** 合规与规范：自伤/占位符/篇幅按检测器 issue 计数扣分（消息锚与修复轮单源），表内算术自洽按
 * C-T3 确定性直算（countTableArithmeticFindings 与修复轮同源），编制依据↔正文双向对账按 C5 P6
 * 审计单源计数（auditBasisRegulationsCross 与检测器/修复轮同判定，每处缺口扣 20）；
 * 无编制依据区段（零声明条目）时编制依据分量显式降级不计不扣，其余四项恒可算。 */
function compliancePart(issues: ValidationIssue[], markdown: string): ScorePart {
  const countMatching = (re: RegExp) => issues.filter(issue => re.test(issue.message)).length;
  const selfHarm = countMatching(COMPLIANCE_MESSAGE_RES.selfHarm);
  const placeholder = countMatching(COMPLIANCE_MESSAGE_RES.placeholder);
  const length = countMatching(COMPLIANCE_MESSAGE_RES.length);
  const tableFindings = countTableArithmeticFindings(markdown);
  const regulationAudit = auditBasisRegulationsCross(markdown);
  const declaredGaps = regulationAudit.declaredNotUsed.length;
  const usedGaps = regulationAudit.usedNotDeclared.length;
  const hasBasisDeclarations = regulationAudit.stats.declaredCodes + regulationAudit.stats.declaredNames > 0;
  const regulationPart: ScorePart & { weight: number } = hasBasisDeclarations
    ? {
        weight: COMPLIANCE_PART_WEIGHTS.regulation,
        value: Math.max(0, 100 - (declaredGaps + usedGaps) * REGULATION_GAP_PENALTY),
        detail: declaredGaps + usedGaps > 0
          ? `编制依据缺口 ${declaredGaps + usedGaps} 处（声明未用 ${declaredGaps}/引用未声明 ${usedGaps}）`
          : '编制依据对账 0 缺口',
      }
    : { weight: COMPLIANCE_PART_WEIGHTS.regulation, value: null };
  return weighParts([
    { weight: COMPLIANCE_PART_WEIGHTS.selfHarm, value: Math.max(0, 100 - selfHarm * COMPLIANCE_HIT_PENALTY), detail: selfHarm > 0 ? `自伤 ${selfHarm} 处` : '自伤 0' },
    { weight: COMPLIANCE_PART_WEIGHTS.placeholder, value: Math.max(0, 100 - placeholder * COMPLIANCE_HIT_PENALTY), detail: placeholder > 0 ? `占位符 ${placeholder} 处` : '占位符 0' },
    { weight: COMPLIANCE_PART_WEIGHTS.length, value: Math.max(0, 100 - length * LENGTH_HIT_PENALTY), detail: length > 0 ? `篇幅超限 ${length} 条` : '篇幅达标' },
    { weight: COMPLIANCE_PART_WEIGHTS.tableConsistency, value: Math.max(0, 100 - tableFindings * TABLE_CONSISTENCY_HIT_PENALTY), detail: tableFindings > 0 ? `表内不自洽 ${tableFindings} 处` : '表自洽 100%' },
    regulationPart,
  ]);
}

/** 事实完整与一致性：对账（fact_consistency 冲突）+ 绑定类冲突 + 关键事实落位率（C-T7，招标人/工期/
 * 造价口径）；编制依据对账缺口（C5 P6）由合规维度·编制依据分量单源计数，此处不从对账重复计（防双计）；
 * 关键事实审计缺失时该分量降级不计不扣 */
function factIntegrityPart(issues: ValidationIssue[], keyFactPlacementAudit: DocumentQualityReport['keyFactPlacementAudit']): ScorePart {
  const factErrors = issues.filter(issue => issue.level === 'error' && issue.category === FACT_CONSISTENCY_CATEGORY && !REGULATION_GAP_MESSAGE_RE.test(issue.message));
  const bindingErrors = factErrors.filter(issue => ACCURACY_BINDING_RE.test(issue.message));
  const parts: Array<ScorePart & { weight: number }> = [
    {
      weight: FACT_INTEGRITY_PART_WEIGHTS.reconciliation,
      value: Math.max(0, 100 - factErrors.length * ACCURACY_ERROR_PENALTY),
      detail: factErrors.length > 0 ? `对账冲突 ${factErrors.length} 条` : '对账零冲突',
    },
    {
      weight: FACT_INTEGRITY_PART_WEIGHTS.binding,
      value: Math.max(0, 100 - bindingErrors.length * ACCURACY_ERROR_PENALTY),
      detail: bindingErrors.length > 0 ? `绑定冲突 ${bindingErrors.length} 条` : '绑定零冲突',
    },
  ];
  if (keyFactPlacementAudit && keyFactPlacementAudit.rate !== null && Number.isFinite(keyFactPlacementAudit.rate)) {
    parts.push({ weight: FACT_INTEGRITY_PART_WEIGHTS.keyFacts, value: keyFactPlacementAudit.rate * 100, detail: `关键事实 ${keyFactPlacementAudit.placed}/${keyFactPlacementAudit.specs}` });
  }
  return weighParts(parts);
}

export async function buildDocumentQualityReport(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
  issues: ValidationIssue[];
  knowledgeCoverage: DocumentKnowledgeCoverageReport;
  factTraces: DocumentFactTrace[];
  template?: DocumentTemplate | null;
  /** v3：招标要求模型（要求实体响应锚点对账 + 对照表）；缺失时对应分量显式降级 */
  tenderRequirements?: TenderRequirementModel | null;
  /** v3：标书编制规格（模式感知：bidType/正文禁表/附表清单/格式要求） */
  bidComposition?: BidCompositionSpec | null;
  /** v3：模块挂靠后大纲（明标结构落实的逐表对账与图位基准） */
  effectiveChapters?: DocumentTemplateChapter[];
  /** B-T3 图纸事实锁：数据锚定分量（图纸事实落位率）判定源，缺失时分量降级不计不扣 */
  drawingFactLock?: DrawingFactLock;
  /** C-T5 BOQ 行级追踪：清单落位审计（豁免行登记 + 有效行处置率）判定源，缺失时审计字段不输出 */
  boqRowTraces?: BoqRowTrace[];
  /** C-T6 可靠参数使用审计：按章相关性归因（义务满足率），调用侧预计算传入（与 boqRowTraces 同范式），缺失时审计字段不输出 */
  parameterUsageAudit?: DocumentQualityReport['parameterUsageAudit'];
  /** C-T7 关键事实落位审计：须落位清单口径（8 项基础字段有值项 × factValueAppears 命中），调用侧预计算传入（同 C-T6 范式），缺失时审计字段不输出 */
  keyFactPlacementAudit?: DocumentQualityReport['keyFactPlacementAudit'];
  /** F-T4 无主数值审计报告：数据锚定「数字溯源」分量判定源（三桶缺口计数），缺失时分量降级不计不扣 */
  authorityAuditReport?: AuthorityAuditReport;
  /** 专业深度语义分类器（round-14 本地 bge 恒可用）：章级 12 分制达标率判定源，缺失时分量降级不计不扣 */
  professionalDepthClassifier?: ProfessionalDepthClassifier;
  /** 招标评分表条目（C0-3 评分细则映射层）：逐条三态承接判定与专家视角模拟分判定源，缺失/为空时不输出 */
  evaluationCriteriaItems?: string[];
  /** 单测注入的嵌入实现（替代本地模型），生产环境不传 */
  embedDocuments?: (texts: string[]) => Promise<number[][]>;
}): Promise<DocumentQualityReport> {
  const scores = await buildTenderBidScores({
    markdown: input.markdown,
    chapters: input.chapters,
    template: input.template,
    factTraces: input.factTraces,
    issues: input.issues,
    embedDocuments: input.embedDocuments,
  });
  const mode: QualityMode = input.bidComposition?.bidType || 'unknown';

  // 要求实体响应（锚点口径一次性对账，维度与对照表共用；comply 类不在文本响应验收域）
  const checklistEntries = input.tenderRequirements?.extracted ? (input.tenderRequirements.entries || []) : [];
  const responseGaps = checklistEntries.length > 0 ? tenderRequirementResponseGaps(checklistEntries, input.markdown) : [];
  const respondGaps = responseGaps.filter(gap => gap.entry.policy !== 'comply');
  const anchorPart: ScorePart = respondGaps.length > 0
    ? (() => {
        const satisfied = respondGaps.filter(gap => gap.satisfied).length;
        return { value: (satisfied / respondGaps.length) * 100, detail: `锚点全命中 ${satisfied}/${respondGaps.length}` };
      })()
    : { value: null };

  const billPlacementAudit = buildBillPlacementAudit(input.markdown, input.boqRowTraces || []);
  const requirementPart = weighParts([
    { ...anchorPart, weight: REQUIREMENT_PART_WEIGHTS.anchors },
    { ...moduleCoveragePart(scores.moduleCoverageRate), weight: REQUIREMENT_PART_WEIGHTS.modules },
  ]);
  const structure = structurePart({ markdown: input.markdown, mode, bidComposition: input.bidComposition, effectiveChapters: input.effectiveChapters, chapters: input.chapters });
  const dataAnchor = dataAnchorPart({
    markdown: input.markdown,
    billPlacementAudit,
    parameterUsageAudit: input.parameterUsageAudit,
    drawingFactLock: input.drawingFactLock,
    authorityAuditReport: input.authorityAuditReport,
  });
  const professionalDepth = await professionalDepthPart(input.chapters, input.professionalDepthClassifier);
  const compliance = compliancePart(input.issues, input.markdown);
  const factIntegrity = factIntegrityPart(input.issues, input.keyFactPlacementAudit);

  type DimensionCandidate = ScorePart & { key: DocumentQualityDimension['key']; label: string; weight: number };
  const candidateDimensions: DimensionCandidate[] = [
    { key: 'requirement', label: '要求实体响应', ...requirementPart, weight: QUALITY_DIMENSION_WEIGHTS.requirement },
    { key: 'structure', label: '结构呈现落实', ...structure, weight: QUALITY_DIMENSION_WEIGHTS.structure },
    { key: 'dataAnchor', label: '数据锚定', ...dataAnchor, weight: QUALITY_DIMENSION_WEIGHTS.dataAnchor },
    { key: 'professionalDepth', label: '专业深度', ...professionalDepth, weight: QUALITY_DIMENSION_WEIGHTS.professionalDepth },
    { key: 'compliance', label: '合规与规范', ...compliance, weight: QUALITY_DIMENSION_WEIGHTS.compliance },
    { key: 'factIntegrity', label: '事实完整与一致性', ...factIntegrity, weight: QUALITY_DIMENSION_WEIGHTS.factIntegrity },
  ];
  const availableDimensions = candidateDimensions.filter(
    (dimension): dimension is DimensionCandidate & { value: number } => dimension.value !== null && Number.isFinite(dimension.value),
  );
  const weightSum = availableDimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const weighted = weightSum > 0 ? availableDimensions.reduce((sum, dimension) => sum + dimension.value * dimension.weight, 0) / weightSum : 0;
  // G 线 P3-4 + P3-1：**计量覆盖面必须显性化**。
  // `weighted` 是「可用维度的重归一分」——不可用的维度（value === null）被剔除分母后归一，
  // 于是只有 2 个维度参与时也可能算出 95 分，读报告的人无从知道这个 95 只来自 2/6 维。
  // 权重和恒为 1.0（QUALITY_DIMENSION_WEIGHTS），故 weightSum 即权重覆盖率。
  // 覆盖率不足时：① 报告显性打印；② `passed` 直接不成立（不得用重归一分宣告达标）。
  const coverageRatio = weightSum;
  const measuredDimensionCount = availableDimensions.length;
  const totalDimensionCount = candidateDimensions.length;
  const coverageSufficient = coverageRatio >= MIN_QUALITY_COVERAGE;
  // G 线 P3-3：取消 uniqueness 的**乘性压缩**，改为独立门槛项（见 UNIQUENESS_FLOOR）。
  // 原式 `overall = weighted × min(1, uniqueness/90)` 使 overall ≤ 100×(uniqueness/90) ——
  // 要达 95 必须 uniqueness ≥ 85.5，而实测 s28m 的 uniqueness ≈ 74.6 ⇒ **理论上限 83**
  // （`.dbg/final-acceptance-record.md` 自述「上限 83 受 uniqueness 0.83 约束」）。
  // 即：即使六个维度全部满分，文档在数学上永远拿不到 95，而 uniqueness 是第 7 个、乘性、
  // 且不出现在「六维」里的量 —— 目标「六维 ≥95」与尺子的「overall ≥95」根本不是同一个命题。
  // 现口径：overall 只由六维加权构成；雷同性由独立门槛（< UNIQUENESS_FLOOR 判雷同风险）承担否决。
  const overall = Math.round(weighted);
  const dimensions: DocumentQualityDimension[] = availableDimensions.map(dimension => ({
    key: dimension.key,
    label: dimension.label,
    score: Math.round(dimension.value),
    weight: dimension.weight,
    detail: dimension.detail,
  }));

  // 双数收敛（铁律 4）：delivery = overall − min(10, blocking×3)——两套数字恒差 ≤10（D4 根治），
  // 目标态 blockers=0 时两值相等；阻断越多扣越多但封顶 10，不再出现 92 vs 28 式打架
  // 口径说明（G 线 P0-7 推迟至 P3）：本处阻断口径 = 所有 error 级，而终门禁 = isHardExportBlockingIssue
  // 白名单子集，两者是集合包含关系却同名。该差异属**评分口径语义**，改动会波及 deliveryProbability
  // 与既有评分校准（6 条校准测试），按 P3-5「任何影响分数的改动必须递增口径版本」，
  // 与 P3 尺子修订一并实施，不在此处单独变更。
  // 注：交付结果本身已无矛盾——P0-1 让主尺未达标产出 blocker，导出层以「更严的一方」生效。
  // G 线 P0-7 阻断口径单源：此前数「所有 error 级」，而终门禁用 classifyBlockingIssue
  //（白名单子集）——同名不同集，报告与门禁可以自相矛盾。现统一消费门禁side的同一出口。
  const blockingIssues = input.issues.filter(issue => issue.level === 'error' && classifyBlockingIssue(issue)).length;
  const deliveryProbability = Math.max(0, Math.min(99, Math.round(overall - Math.min(DELIVERY_PENALTY_CAP, blockingIssues * DELIVERY_BLOCKING_PENALTY))));
  // G 线 P3-2：目标**固定 95**，不再随资料覆盖度静默降为 85。
  // 原式 `target = coverage >= 95 ? 95 : 85` 有两个后果：①产品在绝大多数项目上以 85 为达标线
  // 宣告「已达到当前质量目标」，与「95+ 可交付」直接错位；②**逆向激励** —— 补强知识库反而
  // 抬高自己的达标线。资料覆盖不足应作为独立的前置条件与风险标注，不得降低文档质量达标线。
  const target = 95;
  const templating = await buildTenderBidTemplatingReport(input.markdown, input.embedDocuments);
  // C0-3 评分细则映射层：招标评分表逐条 → 检测目标（内容级三态判定），专家视角模拟分与六维并列展示
  const evaluationCriteriaAttainment = input.evaluationCriteriaItems && input.evaluationCriteriaItems.length > 0
    ? await buildEvaluationCriteriaAttainmentAudit({ items: input.evaluationCriteriaItems, markdown: input.markdown, embedDocuments: input.embedDocuments })
    : undefined;

  // 对照表与要求实体响应同源：responded = 锚点对账 satisfied（comply 类不属文本响应验收域，恒 responded）
  const requirementChecklist: DocumentRequirementChecklistItem[] | undefined = checklistEntries.length > 0
    ? checklistEntries.map((entry, index) => ({
        text: entry.text.slice(0, 160),
        category: entry.category,
        responded: entry.policy === 'comply' ? true : Boolean(responseGaps[index]?.satisfied),
      }))
    : undefined;

  const modeNote = mode === 'unknown' ? '；⚠ 标书类型未判定（按明标口径）——暗标项目须核对招标文件后重跑' : '';
  // C0-5/C0-7：口径版本与主从关系显性标注（本报告=交付主尺；招标六项/专业分七维为从属口径）
  const attainmentNote = evaluationCriteriaAttainment
    ? `；评分细则模拟 ${evaluationCriteriaAttainment.simulatedScore}%（met ${evaluationCriteriaAttainment.met} / partial ${evaluationCriteriaAttainment.partial} / missing ${evaluationCriteriaAttainment.missing}）`
    : '';
  // G 线 P3-3：雷同性作为独立否决门槛参与 passed（不再靠乘性压缩总体分数来体现）
  // G 线 P3-4/P3-1：覆盖率同样是否决前置——重归一分不得用来宣告达标
  const passed = deliveryProbability >= target && blockingIssues === 0 && scores.uniqueness >= UNIQUENESS_FLOOR && coverageSufficient;
  const actions = passed
    ? ['已达到当前质量目标，建议保持事实口径和导出前复核。']
    : [
        ...(coverageSufficient ? [] : [`本次仅计量 ${measuredDimensionCount}/${totalDimensionCount} 维（权重覆盖 ${(coverageRatio * 100).toFixed(0)}%，低于下限 ${(MIN_QUALITY_COVERAGE * 100).toFixed(0)}%）：重归一分不得作为达标依据，须先补齐缺失维度的计量条件再判定。`]),
        '按对齐评分口径补齐短板维度：要求实体响应补锚点全命中（核心词与数字参数逐条落位）、结构呈现补图表落位、数据锚定补 BOQ/参数/图纸/无主数值溯源、专业深度按章补六维薄弱项、合规与规范清理自伤与占位符并压缩超限篇幅且编制依据与正文双向对齐、事实一致性补关键事实落位与数值对账。',
        '系统需优先修复阻断问题、扩大本地知识库检索、补抽结构化事实，并将未落位事实写入对应章节。',
      ];
  if (scores.uniqueness < UNIQUENESS_FLOOR) {
    actions.push(`低雷同性 ${scores.uniqueness} 低于门槛 ${UNIQUENESS_FLOOR}：存在与公开模板/通用话术重合的雷同风险，须改写高重合段落后再交付。`);
  }
  // G 线 P3-4：计量覆盖面显性打印（覆盖率不足时加 ⚠ 前缀，杜绝「只测了 2 维就报 95+」被读成全面达标）
  const coverageNote = `${coverageSufficient ? '' : '⚠ '}本次仅计量 ${measuredDimensionCount}/${totalDimensionCount} 维、权重覆盖 ${(coverageRatio * 100).toFixed(0)}%`;
  const summary = `交付置信度 ${deliveryProbability}% / 目标 ${target}%，综合评分 ${overall}/100（${[...dimensions.map(dimension => `${dimension.label} ${dimension.score}`), `低雷同性 ${scores.uniqueness}`].join('、')}）；${coverageNote}${modeNote}${attainmentNote}；评分口径 ${SCORING_CALIBRATION_VERSION}（主尺）`;
  return {
    overall,
    deliveryProbability,
    target,
    passed,
    scores,
    mode,
    dimensions,
    requirementChecklist,
    billPlacementAudit,
    parameterUsageAudit: input.parameterUsageAudit,
    keyFactPlacementAudit: input.keyFactPlacementAudit,
    templating,
    caliber: QUALITY_REPORT_CALIBER,
    evaluationCriteriaAttainment,
    measurementCoverage: { dimensions: measuredDimensionCount, totalDimensions: totalDimensionCount, weightRatio: coverageRatio, sufficient: coverageSufficient },
    summary,
    actions,
  };
}

export function qualityReportIssues(report: DocumentQualityReport): ValidationIssue[] {
  if (report.passed) return [];
  return [{
    // G 线 P0-1 交付资格判定：主尺未达标必须进阻断集。
    // 此前按 info 计入（注释「避免污染缺陷计分」），代价是主尺结论在**数据结构上永远进不了**
    // blockingIssues —— 阻断判据首行要求 `severity === 'blocker'`，而 level:'info' 只会被
    // 归类为 suggestion。于是全链没有任何执行点持有「这份文档不够格交付」的判断权：
    // 不达标也照常导出，用户看不出区别。
    //
    // 语义澄清：本项是**整篇聚合结论**，不是单点正文缺陷（单点缺陷各自已有 issue）。
    // 故 repairability 取 manual_review —— 不交给 LLM 修复轮（若标 llm_repairable，修复链会
    // 反复尝试一个由诸多缺陷聚合而成、无法单点收敛的目标）。归用户决策：补强资料/配置后重生成，
    // 或显式接受「非交付物」。
    level: 'error',
    severity: 'blocker',
    category: 'structure',
    repairability: 'manual_review',
    owner: 'user',
    message: `交付置信度未达目标：${report.deliveryProbability}% / ${report.target}%（综合评分 ${report.overall}/100）`,
    suggestion: report.actions.join(' '),
  }];
}
