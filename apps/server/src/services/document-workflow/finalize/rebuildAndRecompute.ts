/**
 * rebuildAndRecompute：finalizeGeneration 的组装/重算域（P2 拆分，方案 5.2）。
 * - 辅助函数：污染候选清洗/术语补写/关键小节深度密度检测/全文重建/核心校验组/质量报告组/阶段限幅
 *   （由 documentPipeline.ts 机械搬迁而来，函数体逐字一致，行为保持）；
 * - stageValidationPack / stageComposeFinal / stageRebuildAndRecompute：校验打包/全文组装/rebuild+recompute 闭包单点。
 * rebuildFinalMarkdown / recomputeFinalValidationBundle 以 FinalizeSession 方法承载（P9 provenance 失效机制落地处）。
 */
import type { DocumentAsset, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentTemplate, DocumentTemplateChapter, NumericScopeConflict, RetrievalCoverageReport, TenderRequirementModel, ValidationIssue } from '../types';
import type { FactTokenScopeClassifier } from '../factTokenClassifier';
import type { ProfessionalDepthClassifier } from '../professionalDepthClassifier';
import type { BlueprintData } from '../integratedBlueprint';
import type { BillFactLock } from '../billFactLock';
import { validateDraftWithAutoSpec } from '../../document-validation/documentValidationService';
import { validateProjectContamination } from '../../document-validation/documentContaminationService';
import { validateFactConsistency } from '../../document-validation/factConsistencyService';
import { chapterReadinessIssues, evaluateChapterReadiness } from '../../document-validation/chapterReadinessService';
import { cleanFormalSourcePhrases, composeDocumentMarkdown, finalizeDocumentMarkdown, normalizeTertiaryHeadings, plannedStructureIssues, sanitizeFormalMarkdown } from '../markdownComposer';
import { isBodyTableForbidden, type BidCompositionSpec } from '../bidComposition';
import { appendTenderAppendixSections } from '../composeAppendices';
import { documentBudgetIssues, documentTextLength, pageTargetIssues } from '../budget';
import { applySpecGateRules, buildExportGate, headingUncoveredEngineeringItems } from '../qualityValidation';
import { fixTocFromBody } from '../documentIntegrityChecks';
import { internalTerminologyAnchorIssues } from '../internalTerminologyAnchors';
import { auditAuthorityCoverage, authorityAuditDetails, authorityAuditSummary } from '../authorityAudit';
import { buildStandardFinalValidationIssues } from '../documentFinalValidation';
import { buildKnowledgeCoverageReport, knowledgeCoverageIssues } from '../documentKnowledgeCoverage';
import { buildDocumentFactTraces, factTraceIssues } from '../documentFactTrace';
import { buildChapterCoverageReports, chapterCoverageIssues } from '../documentChapterCoverage';
import { buildDocumentQualityReport, qualityReportIssues } from '../documentQualityReport';
import { buildRepairStrategies, repairStrategyIssues } from '../documentRepairStrategies';
import { stripSnapshotIssues } from '../issueProvenance';
import { collectValidationIssueGroups } from '../documentQualityPipeline';
import { retrievalCoverageIssues } from '../documentEvidenceRetrieval';
import { buildCanonicalFacts } from '../factGovernance';
import { BOOK_TITLE_CITATION_RE, extractSection, stableHash } from '../utils';
import { formalTextGateIssues } from '../agentWorkflow';
import { displayStage, upsertProgressStage } from '../progress';
import { buildValidationIssues } from '../chapterGeneration';
import { chapterSectionFactUsageIssues } from '../chapterReview';
import { factCoverageIssues, finalizeChapterContentQuality, finalizeFinalMarkdownStructure, normalizeProjectBasicInfoTable, partialChapterStatus, criticalSectionBlockerLine, projectBasicPlaceholderIssues, validateDraft, vectorStatusLabel } from '../documentGeneratorHelpers';
import { constructionOrgProfessionalAuditIssues } from '../constructionOrgAudit';
// 方案 2.2 密度/结构执行器终检同源复核（写作侧 block-fact-density/block-structure-contract 的 finalize 复核函数）
import { BLOCK_FACT_DENSITY_PER1000, factDensityVerdict } from '../blockQualityExecutors';
import { det, detSafe } from '../detectorFixerRegistry';
import type { FinalizeSession } from './finalizeSession';

export function sanitizeContaminationCandidates(markdown: string, summary: any) {
  const currentNames = new Set([summary?.projectName, ...(summary?.fingerprint?.projectNames || [])].filter(Boolean));
  return (summary?.contaminationCandidates || []).reduce((text: string, candidate: string) => {
    if (!candidate || candidate.length < 6 || currentNames.has(candidate)) return text;
    return text.replace(new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu'), '本项目工程');
  }, markdown);
}

export function criticalSectionFactDensityIssues(chapters: DocumentDraftChapter[]) {
  const countMatches = (text: string, patterns: RegExp[]) => patterns.filter(pattern => pattern.test(text)).length;
  const numericFactCount = (text: string) => new Set(text.match(/\d+(?:\.\d+)?\s*(?:m²|㎡|平方米|m|mm|层|栋|日历天|天|%|台|套|根|处|个|kg|t|吨)/giu) || []).size;
  const rules = [
    {
      title: '项目特点、重点、难点分析',
      minNumericFacts: 5,
      minObjectFacts: 8,
      objectPatterns: [/建筑面积|面积/u, /层|框架结构|既有建筑/u, /结构形式|结构加固|墙体补强|装配式/u, /拆除|改造|装修|装饰/u, /工期|日历天/u, /质量标准|合格/u, /营业商铺|经营区域|场地/u, /管网|防水|室外道排/u, /智能化|弱电|消防|暖通|通风空调|水电/u],
    },
    {
      title: '项目主要施工内容',
      minNumericFacts: 4,
      minObjectFacts: 6,
      objectPatterns: [/拆除|垃圾外运|既有设施保护/u, /结构加固|墙体补强|框架结构/u, /装饰|装修|基层|面层|环保|阻燃/u, /防水|管网|给排水|阀门|道排/u, /消防|水电|电气|弱电|智能化|通风空调/u, /屋面|立面|室外|附属/u, /施工流程|施工方法|施工顺序|工艺流程/u, /验收|检测|调试|资料闭环/u],
    },
    {
      title: '主要分部分项工程施工方案',
      minNumericFacts: 4,
      minObjectFacts: 6,
      objectPatterns: [/拆除|垃圾外运|既有设施保护/u, /结构加固|墙体补强|框架结构/u, /装饰|装修|基层|面层|环保|阻燃/u, /防水|管网|给排水|阀门|道排/u, /消防|水电|电气|弱电|智能化|通风空调/u, /屋面|立面|室外|附属/u, /施工流程|施工方法|施工顺序|工艺流程/u, /验收|检测|调试|资料闭环/u],
    },
    {
      title: '主要施工方法',
      minNumericFacts: 4,
      minObjectFacts: 6,
      objectPatterns: [/拆除|垃圾外运|既有设施保护/u, /结构加固|墙体补强|框架结构/u, /装饰|装修|基层|面层|环保|阻燃/u, /防水|管网|给排水|阀门|道排/u, /消防|水电|电气|弱电|智能化|通风空调/u, /屋面|立面|室外|附属/u, /施工流程|施工方法|施工顺序|工艺流程/u, /验收|检测|调试|资料闭环/u],
    },
  ];
  return chapters.flatMap(chapter => rules.flatMap(rule => {
    const section = extractSection(chapter.content, rule.title);
    if (!section) return [];
    const numeric = numericFactCount(section);
    const objectFacts = countMatches(section, rule.objectPatterns);
    const issues: any[] = [];
    if (numeric < rule.minNumericFacts) issues.push({ level: 'warning', severity: 'warning', message: `${chapter.title} ${rule.title} 参数落位不足：当前 ${numeric} 个，建议不少于 ${rule.minNumericFacts} 个`, suggestion: '关键小节必须写入项目规模、工期、层数、结构、专业工程或验收参数等具体数值。' });
    if (objectFacts < rule.minObjectFacts) issues.push({ level: 'warning', severity: 'warning', message: `${chapter.title} ${rule.title} 专业事实覆盖不足：当前 ${objectFacts} 类，建议不少于 ${rule.minObjectFacts} 类`, suggestion: '优先基于当前项目绑定资料补充工程对象、专业范围、重点难点和对应施工内容；不得为满足类别数量编造或混入其他项目事实。' });
    return issues;
  }));
}

/** 方案 2.2 密度执行器终检同源复核（写作侧 block-fact-density）：逐章按比例口径复核量化参数密度
 * （与 blockQualityExecutors.factDensityVerdict 同一实现与常量，检测⊆写作）；写作时已首轮阻断，
 * 本复核为 finalize 链兜底——缺口记 warning 流程诊断口径（命中 flow diagnostic 降 info，不阻断导出）。 */
export function chapterFactDensityIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  return chapters.flatMap(chapter => {
    const verdict = factDensityVerdict(chapter.content);
    if (!verdict.gap) return [];
    return [{
      level: 'warning' as const,
      severity: 'warning' as const,
      message: `${chapter.title} 量化参数密度偏低：当前 ${verdict.params} 个（约 ${verdict.per1000}/千字，建议 ≥${BLOCK_FACT_DENSITY_PER1000}/千字、约 ${verdict.required} 个），小节事实或量化参数落位可继续优化`,
      suggestion: '优先将本章绑定资料中的工程规模、工期、部位做法、材料规格等参数自然写入对应工序；不得从行业惯例或相邻章节借参数凑数。',
    }];
  });
}

export function criticalSectionDepthIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const rules = [
    { title: '项目特点、重点、难点分析', minChars: 1800 },
    { title: '项目主要施工内容', minChars: 2200 },
    { title: '主要分部分项工程施工方案', minChars: 1200, blockerMinChars: 800 },
    { title: '主要施工方法', minChars: 2200 },
    { title: '危大工程专项施工方案审批流程', minChars: 500, blockerMinChars: 250 },
    { title: '原材料进场复试与见证取样', minChars: 600, blockerMinChars: 300 },
  ];
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    for (const rule of rules) {
      // exact 优先、fuzzy 兜底：exact 不会把相似子小节（如"质量检验方法"）误当"主要施工方法"（fuzzy 归一化后仅剩"方法"二字），
      // 只有标题被语义重写（缺前缀/后缀）时才启用 fuzzy，兼顾"标题重写不误报"与"相似标题不漏判"
      const body = extractSection(chapter.content, rule.title) || extractSection(chapter.content, rule.title, { fuzzy: true });
      const actualChars = documentTextLength(body);
      if (!body || actualChars >= rule.minChars) continue;
      const blockerMinChars = criticalSectionBlockerLine(rule.title);
      if (actualChars >= blockerMinChars) {
        issues.push({ level: 'warning', severity: 'warning', message: `${chapter.title} ${rule.title} 正文深度接近目标：当前 ${actualChars} 字，目标 ${rule.minChars} 字`, suggestion: '已达到可交付深度，建议后续按项目数据继续优化扩写。' });
      } else {
        issues.push({ level: 'error', severity: 'blocker', message: `${chapter.title} ${rule.title} 正文不足：当前 ${actualChars} 字，要求不少于 ${blockerMinChars} 字`, suggestion: '关键小节必须补足项目数据、重点难点与施工内容对应关系后方可导出。' });
      }
    }
  }
  return issues;
}

export function rebuildFinalMarkdown(input: { template: DocumentTemplate; requirement?: string; projectRoot: string; projectId: string; facts: Record<string, string>; structuredFacts: DocumentFact[]; factsModel: any; chapters: DocumentDraftChapter[]; sources: { filePath: string; count: number }[]; missingItems: string[]; validation: any; validationIssues: any[]; executionStages: DocumentExecutionStage[]; assets: DocumentAsset[]; promptDocumentRules: any; bodyTableForbidden?: boolean; coverForbidden?: boolean; bidComposition?: BidCompositionSpec; blueprintData?: BlueprintData }) {
  // 最终组装不再逐章跑 finalizeChapterContentQuality：补跑重复 H4 去重 + 空壳小节删除兼底（与成稿阶段同口径）
  const markdown = finalizeFinalMarkdownStructure(finalizeDocumentMarkdown(composeDocumentMarkdown({ templateId: input.template.id, templateName: input.template.name, title: input.template.outputTitle, requirement: input.requirement || '', projectRoot: input.projectRoot, projectId: input.projectId, exportSettings: input.template.exportSettings, generationSettings: input.template.generationSettings, facts: input.facts, structuredFacts: input.structuredFacts, factsModel: input.factsModel, chapters: input.chapters, sources: input.sources, missingItems: [...new Set(input.missingItems)], validation: input.validation, validationIssues: input.validationIssues, executionStages: input.executionStages, exportGate: { passed: false, blockingIssues: [], checklist: [] }, assets: input.assets, partialChapters: [], checkpointChapters: input.chapters, generatedAt: Date.now() }, { forbidDrawingImages: false, promptRules: input.promptDocumentRules, bodyTableForbidden: input.bodyTableForbidden, coverForbidden: input.coverForbidden }), input.chapters, { forbidDrawingImages: false, promptRules: input.promptDocumentRules, bodyTableForbidden: input.bodyTableForbidden, coverForbidden: input.coverForbidden }).markdown);
  // 文末附表区：按招标附表清单（appendixPlan）从一体化蓝图直出（无清单时不追加，正文不以表格承载附表数据）
  return appendTenderAppendixSections(markdown, { plan: input.bidComposition?.appendixPlan || [], blueprintData: input.blueprintData });
}

export async function buildFullValidationIssues(input: {
  documentSpec: any; validationIssues: ValidationIssue[]; factsModel: any; finalChapterDrafts: DocumentDraftChapter[]; finalMarkdown: string;
  template: DocumentTemplate; promptBindings: any[]; promptDocumentRules: any; projectMaterialSummary: any; domainProfile: any; structuredFacts: DocumentFact[]; documentBudget: any;
  scopeConflicts?: NumericScopeConflict[];
  evaluationCriteriaItems?: string[];
  /** 模块挂靠后的大纲（含四新等承诺小节）：承接检查必须用承诺后大纲，原始模板未挂靠时承诺检测会静默落空 */
  effectiveChapters?: DocumentTemplateChapter[];
  /** 招标文件评分项要求（LLM 结构化提取）：零响应检测锚点与交付阻断修复轮输入 */
  tenderRequirements?: TenderRequirementModel;
  /** 评分项要求↔章节语义相似度函数（本地 bge 余弦，生成前预构建恒非空） */
  requirementsSimilarity: (leftText: string, rightText: string) => number;
  /** 总量口径语义分类器（round-13）：事实反查口径归属语义复核（本地 bge 恒可用） */
  factTokenScopeClassifier: FactTokenScopeClassifier;
  /** 专业深度语义分类器（round-14）：章节专业深度/缺项/套话/闭环/依赖的语义判定（本地 bge 恒可用） */
  professionalDepthClassifier: ProfessionalDepthClassifier;
  /** 一体化蓝图参数桶（生成前锁定口径）：蓝图引用冲突终检兑底实时重跑（替除生成阶段全卷快照） */
  blueprintData?: BlueprintData;
  /** B1 清单事实锁（4.27.0 A1）：参数口径冲突误报裁决（多值分别命中不同清单条目 → 降级 info） */
  billFactLock?: BillFactLock;
  /** 标书编制规格（暗标禁表）：缺表类门禁豁免 + planned-structure 缺表检测跳过 */
  bodyTableForbidden?: boolean;
  /** 标书编制规格（暗标无封面）：封面必需检查跳过（终稿移除封面块） */
  coverForbidden?: boolean;
}): Promise<ValidationIssue[]> {
  const { documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget, scopeConflicts, evaluationCriteriaItems, effectiveChapters, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier, blueprintData, billFactLock, bodyTableForbidden, coverForbidden } = input;
  // P7：检测器注册表化（detectorFixerRegistry）——各组检测器经 det() 登记引用，元数据（权威依赖/确定性/scope/category）
  // 单源于声明表；调用顺序与行为保持现状（分组顺序变更必须同步声明表并附理由）
  return collectValidationIssueGroups(
    det('spec-gate-rules', () => applySpecGateRules(documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template.projectBindings || [], promptBindings)),
    det('auto-spec-validation', () => validateDraftWithAutoSpec({ markdown: finalMarkdown, spec: documentSpec, summary: projectMaterialSummary })),
    det('fact-consistency', () => validateFactConsistency({ markdown: finalMarkdown, facts: structuredFacts, summary: projectMaterialSummary, profile: domainProfile })),
    det('project-contamination', () => validateProjectContamination(finalMarkdown, projectMaterialSummary)),
    det('project-basic-placeholder', () => projectBasicPlaceholderIssues(finalMarkdown, structuredFacts)),
    await detSafe('standard-final', () => buildStandardFinalValidationIssues({ markdown: finalMarkdown, chapters: finalChapterDrafts, factsModel, template, promptBindings, promptDocumentRules, scopeConflicts, evaluationCriteriaItems, effectiveChapters, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier, blueprintData, billFactLock, bodyTableForbidden, coverForbidden })),
    det('fact-coverage', () => factCoverageIssues(finalMarkdown, [...structuredFacts, ...factsModel.preciseFacts], { maxIssues: 30 }).map(issue => ({ ...issue, level: 'warning' as const, severity: 'warning' as const, suggestion: '建议后续优化事实自然落位；导出阶段不因未落位的引用型或可优化事实阻断。' }))),
    det('page-target', () => pageTargetIssues(template.generationSettings || template.exportSettings, finalMarkdown).filter(issue => !(documentBudget.minPages && /低于目标页数/u.test(issue.message)))),
    det('document-budget', () => documentBudgetIssues(documentBudget, finalMarkdown)),
    det('planned-structure', () => plannedStructureIssues(finalMarkdown, template, bodyTableForbidden)),
    det('formal-text-gate', () => formalTextGateIssues(finalMarkdown)),
    await detSafe('internal-terminology-anchor', () => internalTerminologyAnchorIssues(finalMarkdown)),
    det('heading-uncovered-engineering-items', () => headingUncoveredEngineeringItems(finalMarkdown)),
    det('writer-missing-section', () => finalMarkdown.includes('WRITER_MISSING_SECTION') || finalMarkdown.includes('Writer 未完成') ? [{ level: 'error' as const, severity: 'blocker' as const, category: 'structure' as const, owner: 'system' as const, message: '最终正文仍包含未完成小节标记', suggestion: '必须重新补写对应小节并删除 WRITER_MISSING_SECTION/Writer 未完成。' }] : []),
    det('critical-section-depth', () => criticalSectionDepthIssues(finalChapterDrafts)),
    det('critical-section-fact-density', () => criticalSectionFactDensityIssues(finalChapterDrafts)),
    det('chapter-fact-density', () => chapterFactDensityIssues(finalChapterDrafts)),
    await detSafe('construction-org-professional-audit', async () => (await constructionOrgProfessionalAuditIssues(finalChapterDrafts, finalMarkdown)).map(issue => issue.level === 'error' ? { ...issue, severity: 'blocker' as const } : issue)),
  ).map(issue => issue.level === 'error' ? { ...issue, severity: issue.severity || 'blocker' } : issue);
}

/** 生成前/生成中的流程诊断：反映检索与事实映射状态而非最终正文缺陷，不参与缺陷计分 */

const FLOW_DIAGNOSTIC_ISSUE_RE = /章节级证据覆盖较弱|章节事实覆盖不足|小节事实或量化参数落位可继续优化/u;

/** 质量报告组：覆盖报告、事实追踪、章节覆盖、质量报告、修复策略与导出门禁（首次含检索覆盖复核，修复后重算时不重复累加） */
export async function buildQualityReportBundle(input: {
  finalChapterDrafts: DocumentDraftChapter[]; effectiveChapters: DocumentTemplateChapter[]; factsModel: any; allEvidence: DocumentEvidence[];
  finalMarkdown: string; validationIssues: ValidationIssue[]; retrievalCoverageReports: RetrievalCoverageReport[]; includeRetrievalCoverage: boolean; template: DocumentTemplate;
}) {
  const { finalChapterDrafts, effectiveChapters, factsModel, allEvidence, finalMarkdown, validationIssues, retrievalCoverageReports, includeRetrievalCoverage, template } = input;
  const knowledgeCoverage = buildKnowledgeCoverageReport({ chapters: finalChapterDrafts, templateChapters: effectiveChapters, factsModel, evidence: allEvidence });
  const factTraces = buildDocumentFactTraces(finalMarkdown, factsModel);
  const chapterCoverage = buildChapterCoverageReports({ chapters: finalChapterDrafts, templateChapters: effectiveChapters, factsModel });
  let issues = collectValidationIssueGroups(
    validationIssues,
    knowledgeCoverageIssues(knowledgeCoverage),
    factTraceIssues(factTraces, { maxIssues: 20 }),
    chapterCoverageIssues(chapterCoverage),
    includeRetrievalCoverage ? retrievalCoverageIssues(retrievalCoverageReports) : [],
  );
  // 生成前/生成中的流程诊断（检索覆盖、事实覆盖、小节落位建议）反映的是检索与事实映射状态而非最终正文缺陷，
  // 无法由修复循环处理，按 info 计入避免污染缺陷计分
  issues = issues.map(issue => FLOW_DIAGNOSTIC_ISSUE_RE.test(issue.message) && issue.level === 'warning' ? { ...issue, level: 'info' as const } : issue);
  // 可落地性目标基准（4.26.0 起固化字数口径）：每 1500 字 1 块完整五要素块。
  // 参考库锚点已随模板参考库移除下线，单一逻辑：target = max(6, ceil(字数/1500))
  const qualityReport = await buildDocumentQualityReport({ markdown: finalMarkdown, chapters: finalChapterDrafts, issues, knowledgeCoverage, factTraces, template });
  const repairStrategies = buildRepairStrategies({ issues, qualityReport, knowledgeCoverage, factTraces, chapterCoverage });
  issues = collectValidationIssueGroups(issues, qualityReportIssues(qualityReport), repairStrategyIssues(repairStrategies));
  const finalExportGate = buildExportGate(issues, factsModel, finalChapterDrafts);
  return { knowledgeCoverage, factTraces, chapterCoverage, qualityReport, repairStrategies, validationIssues: issues, finalExportGate };
}

/** P1-11 executionStages 限幅：20+ 章文档 progressStages 可达数百条，前端渲染/序列化开销随章数线性增长；
 * 超过上限时把中间历史阶段合并为一条归档摘要（保留头尾关键阶段） */
export function throttleExecutionStages(stages: DocumentExecutionStage[], limit = 300): DocumentExecutionStage[] {
  if (stages.length <= limit) return stages;
  const headCount = 4;
  const tailCount = limit - headCount - 1;
  if (tailCount <= 0) return stages.slice(-limit);
  const head = stages.slice(0, headCount);
  const tail = stages.slice(-tailCount);
  const archived = stages.slice(headCount, stages.length - tailCount);
  const failedCount = archived.filter(stage => stage.status === 'failed').length;
  const summary: DocumentExecutionStage = {
    type: 'validation',
    roleId: 'stage-archive',
    status: failedCount > 0 ? 'failed' : 'success',
    message: `已归档 ${archived.length} 个中间执行阶段${failedCount > 0 ? `（含 ${failedCount} 个失败记录）` : ''}`,
    details: archived[0]?.subtitle ? [`归档区间：${archived[0].subtitle} → ${archived[archived.length - 1]?.subtitle || ''}`] : [],
  };
  return [...head, summary, ...tail];
}


/** stageValidationPack：校验问题打包 + executionStages 构建（P2 拆分，方案 5.2） */
export async function stageValidationPack(session: FinalizeSession): Promise<void> {
  const chapterReadiness = evaluateChapterReadiness(session.chapterDrafts, session.documentSpec);
  session.validation = validateDraft(session.chapterDrafts, session.governedStructuredFacts, session.template);
  session.validation.warnings = [...session.validation.warnings, ...session.readiness.warnings];
  session.validation.errors = [...session.validation.errors, ...session.readiness.blockingIssues];

  session.sources = [...session.allEvidence.reduce((map, item) => map.set(item.filePath, (map.get(item.filePath) ?? 0) + 1), new Map<string, number>()).entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([filePath, count]) => ({ filePath, count }));
  const evidenceSourceCounts = new Map<string, number>();
  for (const item of session.allEvidence) evidenceSourceCounts.set(item.source || 'unknown', (evidenceSourceCounts.get(item.source || 'unknown') ?? 0) + 1);

  session.validationIssues = collectValidationIssueGroups(
    buildValidationIssues(session.validation, session.factsModel, session.chapterDrafts),
    chapterReadinessIssues(chapterReadiness),
    // 生成阶段跨章一致性快照：确定性数值冲突（跨章一致性冲突/工序规格冲突）不在此重复包装，
    // 由 buildStandardFinalValidationIssues 在最终 finalMarkdown 上实时重跑报告，避免修复生效后旧快照
    // 仍以「跨章一致性复核」error 硬阻断导出（历史缺陷：用户环境保温层 2mm、10970㎡ 修复后旧快照残留阻断）
    (session.globalConsistencyIssues || []).filter(message => !/^跨章一致性冲突|^工序规格冲突/u.test(message)).slice(0, 10).map(message => {
      // 数据一致性矛盾条目（阶段 2 统一审查并入）单独前缀，与跨章一致性复核区分定位；
      // 两类问题修复后旧快照会重算替换，此处仅打包当前清单进导出校验
      const isDataConflict = /^数据一致性矛盾/u.test(message);
      return { level: 'error' as const, severity: 'blocker' as const, category: 'fact_consistency' as const, owner: 'llm' as const, repairability: 'llm_repairable' as const, message: `${isDataConflict ? '数据一致性复核' : '跨章一致性复核'}：${message}`, suggestion: isDataConflict ? '全文数据必须一致：以绑定资料（图纸/清单/招标文件）为准选定唯一值，统一矛盾数值对。' : '跨章数值口径不一致属低级错误，必须定向修复统一口径后重新校验。', provenance: { detectorId: isDataConflict ? 'data-consistency-snapshot' : 'global-consistency-snapshot', fingerprint: stableHash(session.chapterDrafts.map(chapter => chapter.content).join('\n\n')) } };
    }),
  );
  const budgetDraftMarkdown = session.chapterDrafts.map(chapter => chapter.content).join('\n\n');
  session.validationIssues = collectValidationIssueGroups(
    session.validationIssues,
    factCoverageIssues(budgetDraftMarkdown, session.structuredFacts, { maxIssues: 20 }).map(issue => ({ ...issue, level: 'warning' as const, severity: 'warning' as const, suggestion: '建议 Agent Writer 在章节生成阶段优先落位可信基础事实；导出阶段不因未落位的低置信或泛化事实阻断。', provenance: { detectorId: 'fact-coverage', fingerprint: stableHash(budgetDraftMarkdown) } })),
  );

  const missingChapterCount = Math.max(0, session.effectiveChapters.length - session.chapterDrafts.length);
  session.validationIssues = collectValidationIssueGroups(session.validationIssues, [
    ...(missingChapterCount > 0 ? [{ level: 'error' as const, severity: 'blocker' as const, message: `部分章节生成失败：${missingChapterCount} 章`, suggestion: session.failedChapterMessages.join('；') || '请检查模型调用、知识库检索和事实抽取配置后重新生成失败章节。' }] : []),
  ]);
  const factUsageWarnings = await Promise.all(session.chapterDrafts.map(async chapter => {
    const templateChapter = session.effectiveChapters.find(item => item.id === chapter.id);
    if (!templateChapter) return [] as Array<{ level: 'warning'; message: string; suggestion: string }>;
    const issues = await chapterSectionFactUsageIssues({ chapter: templateChapter, content: chapter.content, evidence: chapter.evidence || [] });
    return issues.length > 0 ? [{ level: 'warning' as const, message: `${chapter.title} 小节事实或量化参数落位可继续优化：${issues.slice(0, 5).join('；')}`, suggestion: '建议在 Agent Writer 阶段扩大定向证据，不得在导出阶段补写。' }] : [];
  }));
  session.validationIssues = collectValidationIssueGroups(session.validationIssues, factUsageWarnings.flat());

  session.assets = [];
  // chapterGenerationStages 是各章成稿的最终版 stage（success/failed），progressStages 里还残留同 identity 的
  // running 版（主题块并发成稿中间态）；直接数组拼接会让同名 stage 成对出现，running 态永久残留在前端节点图
  //（十四度实测：3 章 chapter_generation 同时出现 running 与 success 两份）
  const mergedProgressStages = [...session.progressStages];
  for (const stage of session.chapterGenerationStages) upsertProgressStage(mergedProgressStages, stage);
  session.executionStages = throttleExecutionStages(mergedProgressStages);
  upsertProgressStage(session.executionStages, displayStage({ type: 'reference', roleId: 'knowledge-usage-report', status: 'success', message: `资料使用报告：证据 ${session.allEvidence.length} 条，来源文件 ${session.sources.length} 份，结构化事实 ${session.structuredFacts.length} 条`, details: [`证据类型：${[...evidenceSourceCounts.entries()].map(([name, count]) => `${name} ${count}`).join('，') || '无'}`, `索引健康：可用切片 ${session.indexHealth.usableChunkCount} 条，待索引 ${session.indexHealth.pendingJobs} 个，向量${vectorStatusLabel(session.indexHealth.vectorStatus?.status)}`] }, { subtitle: '资料使用报告' }));
  upsertProgressStage(session.executionStages, displayStage({ type: 'reference', roleId: 'web-research-report', status: session.webResearchReport.enabled ? 'success' : 'skipped', message: session.webResearchReport.enabled ? `联网增强：检索章节 ${new Set(session.webResearchReport.chapters).size} 个，查询 ${session.webResearchReport.queries.length} 个，使用公开资料 ${session.webResearchReport.evidenceCount} 条` : '联网增强未开启', details: session.webResearchReport.enabled ? [`检索主题：${[...new Set(session.webResearchReport.queries)].join('；') || '无'}`, `过滤结果：${session.webResearchReport.filteredCount} 条`, '公开资料仅用于通用规范、政策、工艺和措施补充，不作为项目事实来源'] : ['可在模型配置中开启联网增强'] }, { subtitle: '联网增强报告' }));

}

/** stageComposeFinal：全文组装 + 标准化管道（P2 拆分，方案 5.2） */
export function stageComposeFinal(session: FinalizeSession): void {
  // 标书编制规格（阶段 1 判定）：暗标正文禁表 + 无封面口径——组装管道与门禁同源
  const bodyTableForbidden = isBodyTableForbidden(session.bidComposition);
  const coverForbidden = session.bidComposition?.formatRules.cover === 'forbidden';
  const finalizedDocument = finalizeDocumentMarkdown(composeDocumentMarkdown({
    templateId: session.template.id,
    templateName: session.template.name,
    title: session.template.outputTitle,
    requirement: session.requirement || '',
    projectRoot: session.projectRoot,
    projectId: session.projectId,
    exportSettings: session.template.exportSettings,
    generationSettings: session.template.generationSettings,
    facts: session.facts,
    structuredFacts: session.structuredFacts,
    factsModel: session.factsModel,
    chapters: session.chapterDrafts,
    sources: session.sources,
    missingItems: [...new Set(session.missingItems)],
    validation: session.validation,
    validationIssues: session.validationIssues,
    executionStages: session.executionStages,
    exportGate: { passed: false, blockingIssues: [], checklist: [] },
    assets: session.assets,
    partialChapters: session.chapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, session.documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: session.chapterDrafts,
    generatedAt: Date.now(),
  }, { forbidDrawingImages: false, promptRules: session.promptDocumentRules, bodyTableForbidden, coverForbidden }), session.chapterDrafts, { forbidDrawingImages: false, promptRules: session.promptDocumentRules, bodyTableForbidden, coverForbidden });
  session.finalChapterDrafts = finalizedDocument.chapters.map(chapter => {
    const templateChapter = session.effectiveChapters.find(item => item.id === chapter.id) || chapter;
    return { ...chapter, sections: chapter.sections || [], content: finalizeChapterContentQuality(chapter.content, templateChapter) };
  });
  session.finalMarkdown = finalizeDocumentMarkdown(composeDocumentMarkdown({ templateId: session.template.id, templateName: session.template.name, title: session.template.outputTitle, requirement: session.requirement || '', projectRoot: session.projectRoot, projectId: session.projectId, exportSettings: session.template.exportSettings, generationSettings: session.template.generationSettings, facts: session.facts, structuredFacts: session.structuredFacts, factsModel: session.factsModel, chapters: session.finalChapterDrafts, sources: session.sources, missingItems: [...new Set(session.missingItems)], validation: session.validation, validationIssues: session.validationIssues, executionStages: session.executionStages, exportGate: { passed: false, blockingIssues: [], checklist: [] }, assets: session.assets, partialChapters: [], checkpointChapters: session.finalChapterDrafts, generatedAt: Date.now() }, { forbidDrawingImages: false, promptRules: session.promptDocumentRules, bodyTableForbidden, coverForbidden }), session.finalChapterDrafts, { forbidDrawingImages: false, promptRules: session.promptDocumentRules, bodyTableForbidden, coverForbidden }).markdown;
  session.finalMarkdown = fixTocFromBody(finalizeFinalMarkdownStructure(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(session.finalMarkdown, session.structuredFacts, { bodyTableForbidden }), session.projectMaterialSummary)))))).markdown;
  // 文末附表区：全部标准化管道完成后追加（不再经 normalize 管道，避免附表 H2 被当章标题处理）；
  // 数据源为一体化蓝图（appendixPlan 逐项绑定），无附表清单时不追加
  session.finalMarkdown = appendTenderAppendixSections(session.finalMarkdown, { plan: session.bidComposition?.appendixPlan || [], blueprintData: session.blueprintData });
}

/** V5 P5 M6 · 无主数值审计记录（确定性、零 LLM）：扫描 finalMarkdown 全部数值与 AuthorityIndex 匹配，
 * 三分类（一致 / 登记豁免 / 无主→推导缺口·工艺缺口·未登记），报告随执行阶段与 reviewMetadata 交付；
 * 修复轮每次重算校验组后重跑（upsert 幂等），报告始终基于最新 finalMarkdown——
 * 未登记数应随修复收敛至 0（验收口径「无主数值审计报告=0 未登记项」）。 */
function recordAuthorityAudit(session: FinalizeSession): void {
  const report = auditAuthorityCoverage(session.finalMarkdown, session.blueprintData);
  session.authorityAuditReport = report;
  upsertProgressStage(session.executionStages, displayStage({
    type: 'validation',
    roleId: 'authority-audit',
    status: report.unregisteredCount > 0 ? 'failed' : 'success',
    message: authorityAuditSummary(report),
    details: authorityAuditDetails(report),
  }, { subtitle: '权威覆盖审计' }));
}

/** stageRebuildAndRecompute：rebuild/recompute 闭包单点（P9 provenance 失效机制落地处，P2 拆分，方案 5.2） */
export async function stageRebuildAndRecompute(session: FinalizeSession): Promise<void> {
  // round-19：全文重建函数（章草稿 → finalMarkdown 标准化管道）单一定义：
  // 确定性修复后重建/Final Gate 补写后重建/事实落位后重建/表格修复后重建/post-gate 重建共用同一口径，
  // 消除 5 处 300+ 字符重复表达式（历史遗留：rebuild 定义在修复循环后才出现，前面的重建只能内联复制）
  session.rebuildFinalMarkdown = () => fixTocFromBody(finalizeFinalMarkdownStructure(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template: session.template, requirement: session.requirement, projectRoot: session.projectRoot, projectId: session.projectId, facts: session.facts, structuredFacts: session.structuredFacts, factsModel: session.factsModel, chapters: session.finalChapterDrafts, sources: session.sources, missingItems: session.missingItems, validation: session.validation, validationIssues: session.validationIssues, executionStages: session.executionStages, assets: session.assets, promptDocumentRules: session.promptDocumentRules, bodyTableForbidden: isBodyTableForbidden(session.bidComposition), coverForbidden: session.bidComposition?.formatRules.cover === 'forbidden', bidComposition: session.bidComposition, blueprintData: session.blueprintData }), session.structuredFacts, { bodyTableForbidden: isBodyTableForbidden(session.bidComposition) }), session.projectMaterialSummary)))))).markdown;

  const canonicalFacts = buildCanonicalFacts({ facts: session.structuredFacts, markdown: session.finalMarkdown });
  if (canonicalFacts.size > 0) session.executionStages.push({ type: 'fact_extraction', roleId: 'canonical-facts', status: 'success', message: `已决策可信基础事实 ${canonicalFacts.size} 项`, details: [...canonicalFacts.values()].map(fact => `${fact.label}=${fact.value}（${fact.source}，confidence=${fact.confidence}）`).slice(0, 12) });

  // 修复后重算问题组会重新计算，修复基线只保留基础累计问题，避免重复累加
  session.baseValidationIssues = session.validationIssues;
  session.validationIssues = await buildFullValidationIssues({ documentSpec: session.documentSpec, validationIssues: session.validationIssues, factsModel: session.factsModel, finalChapterDrafts: session.finalChapterDrafts, finalMarkdown: session.finalMarkdown, template: session.template, promptBindings: session.promptBindings, promptDocumentRules: session.promptDocumentRules, projectMaterialSummary: session.projectMaterialSummary, domainProfile: session.domainProfile, structuredFacts: session.structuredFacts, documentBudget: session.documentBudget, scopeConflicts: session.scopeConflicts, evaluationCriteriaItems: session.evaluationCriteriaItems, effectiveChapters: session.effectiveChapters, tenderRequirements: session.tenderRequirements, requirementsSimilarity: session.requirementsSimilarity, factTokenScopeClassifier: session.factTokenScopeClassifier, professionalDepthClassifier: session.professionalDepthClassifier, blueprintData: session.blueprintData, billFactLock: session.billFactLock, bodyTableForbidden: isBodyTableForbidden(session.bidComposition), coverForbidden: session.bidComposition?.formatRules.cover === 'forbidden' });

  session.qualityBundle = await buildQualityReportBundle({ finalChapterDrafts: session.finalChapterDrafts, effectiveChapters: session.effectiveChapters, factsModel: session.factsModel, allEvidence: session.allEvidence, finalMarkdown: session.finalMarkdown, validationIssues: session.validationIssues, retrievalCoverageReports: session.retrievalCoverageReports, includeRetrievalCoverage: true, template: session.template });
  session.validationIssues = session.qualityBundle.validationIssues;
  recordAuthorityAudit(session);
  session.finalGateRepairStages = [];
  // 修复后重算校验组（事实落位轮/表格修复轮后共用）：过滤旧快照 issue，
  // 用最新 finalMarkdown 重算全部校验组与导出门禁
  session.recomputeFinalValidationBundle = async () => {
    // P9 provenance 失效机制：生成阶段打包的校验 issue 快照带 provenance.detectorId
    //（fact-coverage / overview-recap / internal-terminology-anchor / 跨章一致性快照 / 数据一致性快照），
    // 重算校验组时按 detectorId 无条件剔除旧快照，由重算链对最新 finalMarkdown 实时重跑重新生成：
    // fact-coverage → buildFullValidationIssues det 注册表；overview-recap / internal-terminology-anchor →
    // buildStandardFinalValidationIssues 注册表；跨章一致性类 → 同上实时重跑。
    // 替代旧版 4 组脆弱正则（与 message 措辞耦合，检测器改文案即静默失效）。
    // 历史缺陷佐证：事实落位轮后已落位事实仍带修复前警告进入交付（如基本信息表招标人）；
    // 正文已删「本项目为…」但门禁仍报概况复述（B5）；终稿塑料管两口径仍报单一蓝图冲突（B8）。
    const repairedValidationBase = stripSnapshotIssues(session.baseValidationIssues);
    session.validationIssues = await buildFullValidationIssues({ documentSpec: session.documentSpec, validationIssues: repairedValidationBase, factsModel: session.factsModel, finalChapterDrafts: session.finalChapterDrafts, finalMarkdown: session.finalMarkdown, template: session.template, promptBindings: session.promptBindings, promptDocumentRules: session.promptDocumentRules, projectMaterialSummary: session.projectMaterialSummary, domainProfile: session.domainProfile, structuredFacts: session.structuredFacts, documentBudget: session.documentBudget, scopeConflicts: session.scopeConflicts, evaluationCriteriaItems: session.evaluationCriteriaItems, effectiveChapters: session.effectiveChapters, tenderRequirements: session.tenderRequirements, requirementsSimilarity: session.requirementsSimilarity, factTokenScopeClassifier: session.factTokenScopeClassifier, professionalDepthClassifier: session.professionalDepthClassifier, blueprintData: session.blueprintData, billFactLock: session.billFactLock, bodyTableForbidden: isBodyTableForbidden(session.bidComposition), coverForbidden: session.bidComposition?.formatRules.cover === 'forbidden' });
    session.qualityBundle = await buildQualityReportBundle({ finalChapterDrafts: session.finalChapterDrafts, effectiveChapters: session.effectiveChapters, factsModel: session.factsModel, allEvidence: session.allEvidence, finalMarkdown: session.finalMarkdown, validationIssues: session.validationIssues, retrievalCoverageReports: session.retrievalCoverageReports, includeRetrievalCoverage: false, template: session.template });
    session.validationIssues = session.qualityBundle.validationIssues;
    // P5 M6：修复轮重算后刷新无主数值审计（报告始终反映最新 finalMarkdown）
    recordAuthorityAudit(session);
  };
}
