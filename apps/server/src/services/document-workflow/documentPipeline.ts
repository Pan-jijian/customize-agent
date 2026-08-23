import type { AgentWorkflowContext } from './agentWorkflow';
import type { DocumentAsset, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, GeneratedDocumentDraft, RetrievalCoverageReport, ValidationIssue, WritingTaskBrief } from './types';
import type { ProjectMaterialScope } from './projectMaterialScope';
import { assertEvidenceInProjectScope, filterEvidenceByProjectScope, filterFactsByProjectScope, projectScopeAudit, sourceInProjectScope } from './projectMaterialScope';
import { selectEvidenceByBudget } from './evidence';
import { validateDraftWithAutoSpec } from '../document-validation/documentValidationService';
import { validateProjectContamination } from '../document-validation/documentContaminationService';
import { chapterReadinessIssues, evaluateChapterReadiness } from '../document-validation/chapterReadinessService';
import { validateFactConsistency } from '../document-validation/factConsistencyService';
import { cleanFormalSourcePhrases, composeDocumentMarkdown, finalizeDocumentMarkdown, normalizeTertiaryHeadings, plannedStructureIssues, promptDocumentRuleIssues, sanitizeFormalMarkdown } from './markdownComposer';
import { documentBudgetIssues, documentTextLength, pageTargetIssues } from './budget';
import { applySpecGateRules, buildExportGate, qualitySeveritySummary } from './qualityValidation';
import { buildStandardFinalValidationIssues } from './documentFinalValidation';
import { buildDocumentProfileReport } from './documentProfiles';
import { buildKnowledgeCoverageReport, knowledgeCoverageIssues } from './documentKnowledgeCoverage';
import { buildDocumentFactTraces, factTraceIssues } from './documentFactTrace';
import { buildChapterCoverageReports, chapterCoverageIssues } from './documentChapterCoverage';
import { buildDocumentQualityReport, qualityReportIssues } from './documentQualityReport';
import { benchmarkGeneratedMarkdown } from './benchmarkQuality';
import { buildRepairStrategies, repairStrategyIssues } from './documentRepairStrategies';
import { buildDocumentReviewChecklist } from './documentReviewChecklist';
import { collectValidationIssueGroups } from './documentQualityPipeline';
import { DOCUMENT_WORKFLOW_VERSION } from './documentWorkflowVersion';
import { buildDocumentTelemetryReport } from './documentTelemetry';
import { retrievalCoverageIssues } from './documentEvidenceRetrieval';
import { extractFacts, extractFactsWithLlm, extractPreciseFactsFromEvidence, extractProjectBasicFactsFromEvidence, extractStructuredFacts, extractStructuredTables, buildFactsModel, shouldRunLlmFactExtraction } from './factsModel';
import { buildCanonicalFacts } from './factGovernance';
import { extractSection, stringifyFactValue, throwIfAborted } from './utils';
import { formalTextGateIssues } from './agentWorkflow';
import { displayStage, upsertProgressStage } from './progress';
import { buildLlmSectionContent, buildValidationIssues, criticalSectionBlockerMinChars } from './chapterGeneration';
import { chapterSectionFactUsageIssues, understandReferenceFiles } from './chapterReview';
import { factCoverageIssues, factsWithEvidenceSource, finalizeChapterContentQuality, normalizeProjectBasicInfoTable, partialChapterStatus, projectBasicPlaceholderIssues, slowMetricSummary, validateDraft } from './documentGeneratorHelpers';
import { constructionOrgProfessionalAuditIssues } from './constructionOrgAudit';
import { buildProfessionalScoreReport } from './documentProfessionalScore';

function sanitizeContaminationCandidates(markdown: string, summary: any) {
  const currentNames = new Set([summary?.projectName, ...(summary?.fingerprint?.projectNames || [])].filter(Boolean));
  return (summary?.contaminationCandidates || []).reduce((text: string, candidate: string) => {
    if (!candidate || candidate.length < 6 || currentNames.has(candidate)) return text;
    return text.replace(new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu'), '本项目工程');
  }, markdown);
}

function replaceMarkdownSection(content: string, sectionTitle: string, sectionContent: string) {
  const normalizeHeadingTitle = (value: string) => value
    .replace(/[\u00a0\u3000]/gu, ' ')
    .replace(/^\d+(?:\.\d+)*\s+/u, '')
    .trim();
  const stripGeneratedHeading = (value: string) => value
    .trim()
    .replace(/^#{2,6}\s+(?:\d+(?:\.\d+)*\s+)?[^\n]+\n+/u, '')
    .trim();
  const lines = content.split('\n');
  let cursor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineStart = cursor;
    cursor += line.length + 1;
    const heading = /^(#{3,4})\s+(.+)$/u.exec(line.trim());
    if (!heading) continue;
    const headingTitle = normalizeHeadingTitle(heading[2]);
    if (headingTitle !== sectionTitle && !headingTitle.includes(sectionTitle) && !sectionTitle.includes(headingTitle)) continue;
    let endLine = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^#{2,4}\s+/u.test(lines[next].trim())) {
        endLine = next;
        break;
      }
    }
    const endOffset = endLine < lines.length ? lines.slice(0, endLine).join('\n').length : content.length;
    const body = stripGeneratedHeading(sectionContent);
    return `${content.slice(0, lineStart)}${line.trim()}\n\n${body}${content.slice(endOffset)}`;
  }
  return content;
}

function criticalSectionFactDensityIssues(chapters: DocumentDraftChapter[]) {
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
    if (numeric < rule.minNumericFacts) issues.push({ level: 'error', severity: 'blocker', message: `${chapter.title} ${rule.title} 参数落位不足：当前 ${numeric} 个，要求不少于 ${rule.minNumericFacts} 个`, suggestion: '关键小节必须写入项目规模、工期、层数、结构、专业工程或验收参数等具体数值。' });
    if (objectFacts < rule.minObjectFacts) issues.push({ level: 'warning', severity: 'warning', message: `${chapter.title} ${rule.title} 专业事实覆盖不足：当前 ${objectFacts} 类，建议不少于 ${rule.minObjectFacts} 类`, suggestion: '优先基于当前项目绑定资料补充工程对象、专业范围、重点难点和对应施工内容；不得为满足类别数量编造或混入其他项目事实。' });
    return issues;
  }));
}

function criticalSectionDepthIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
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
      const body = extractSection(chapter.content, rule.title);
      const actualChars = documentTextLength(body);
      if (!body || actualChars >= rule.minChars) continue;
      const blockerMinChars = rule.blockerMinChars || Math.floor(rule.minChars * 0.8);
      if (actualChars >= blockerMinChars) {
        issues.push({ level: 'warning', severity: 'warning', message: `${chapter.title} ${rule.title} 正文深度接近目标：当前 ${actualChars} 字，目标 ${rule.minChars} 字`, suggestion: '已达到可交付深度，建议后续按项目数据继续优化扩写。' });
      } else {
        issues.push({ level: 'error', severity: 'blocker', message: `${chapter.title} ${rule.title} 正文不足：当前 ${actualChars} 字，要求不少于 ${blockerMinChars} 字`, suggestion: '关键小节必须补足项目数据、重点难点与施工内容对应关系后方可导出。' });
      }
    }
  }
  return issues;
}

function rebuildFinalMarkdown(input: { template: DocumentTemplate; requirement?: string; projectRoot: string; projectId: string; facts: Record<string, string>; structuredFacts: DocumentFact[]; factsModel: any; chapters: DocumentDraftChapter[]; sources: { filePath: string; count: number }[]; missingItems: string[]; validation: any; validationIssues: any[]; executionStages: DocumentExecutionStage[]; assets: DocumentAsset[]; promptDocumentRules: any }) {
  return finalizeDocumentMarkdown(composeDocumentMarkdown({ templateId: input.template.id, templateName: input.template.name, title: input.template.outputTitle, requirement: input.requirement || '', projectRoot: input.projectRoot, projectId: input.projectId, exportSettings: input.template.exportSettings, generationSettings: input.template.generationSettings, facts: input.facts, structuredFacts: input.structuredFacts, factsModel: input.factsModel, chapters: input.chapters, sources: input.sources, missingItems: [...new Set(input.missingItems)], validation: input.validation, validationIssues: input.validationIssues, executionStages: input.executionStages, exportGate: { passed: false, blockingIssues: [], checklist: [] }, assets: input.assets, partialChapters: [], checkpointChapters: input.chapters, generatedAt: Date.now() }, { forbidDrawingImages: false, promptRules: input.promptDocumentRules }), input.chapters, { forbidDrawingImages: false, promptRules: input.promptDocumentRules }).markdown;
}

/** 核心校验组：覆盖规格门禁、事实一致性、污染、占位符、预算、结构完整性、正式文本门禁与关键小节深度/密度（首次与 Final Gate 修复后共用） */
function buildFullValidationIssues(input: {
  documentSpec: any; validationIssues: ValidationIssue[]; factsModel: any; finalChapterDrafts: DocumentDraftChapter[]; finalMarkdown: string;
  template: DocumentTemplate; promptBindings: any[]; promptDocumentRules: any; projectMaterialSummary: any; domainProfile: any; structuredFacts: DocumentFact[]; documentBudget: any;
}): ValidationIssue[] {
  const { documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget } = input;
  return collectValidationIssueGroups(
    applySpecGateRules(documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template.projectBindings || [], promptBindings),
    validateDraftWithAutoSpec({ markdown: finalMarkdown, spec: documentSpec, summary: projectMaterialSummary }),
    validateFactConsistency({ markdown: finalMarkdown, facts: structuredFacts, summary: projectMaterialSummary, profile: domainProfile }),
    validateProjectContamination(finalMarkdown, projectMaterialSummary),
    projectBasicPlaceholderIssues(finalMarkdown, structuredFacts),
    buildStandardFinalValidationIssues({ markdown: finalMarkdown, chapters: finalChapterDrafts, factsModel, template, promptBindings, promptDocumentRules }),
    factCoverageIssues(finalMarkdown, [...structuredFacts, ...factsModel.preciseFacts], { maxIssues: 30 }).map(issue => ({ ...issue, level: 'warning' as const, severity: 'warning' as const, suggestion: '建议后续优化事实自然落位；导出阶段不因未落位的引用型或可优化事实阻断。' })),
    pageTargetIssues(template.generationSettings || template.exportSettings, finalMarkdown).filter(issue => !(documentBudget.minPages && /低于目标页数/u.test(issue.message))),
    documentBudgetIssues(documentBudget, finalMarkdown),
    plannedStructureIssues(finalMarkdown, template),
    promptDocumentRuleIssues(finalMarkdown, promptDocumentRules),
    formalTextGateIssues(finalMarkdown),
    finalMarkdown.includes('WRITER_MISSING_SECTION') || finalMarkdown.includes('Writer 未完成') ? [{ level: 'error' as const, severity: 'blocker' as const, category: 'structure' as const, owner: 'system' as const, message: '最终正文仍包含未完成小节标记', suggestion: '必须重新补写对应小节并删除 WRITER_MISSING_SECTION/Writer 未完成。' }] : [],
    criticalSectionDepthIssues(finalChapterDrafts),
    criticalSectionFactDensityIssues(finalChapterDrafts),
    constructionOrgProfessionalAuditIssues(finalChapterDrafts, finalMarkdown).map(issue => issue.level === 'error' ? { ...issue, severity: 'blocker' as const } : issue),
  ).map(issue => issue.level === 'error' ? { ...issue, severity: issue.severity || 'blocker' } : issue);
}

/** 质量报告组：覆盖报告、事实追踪、章节覆盖、质量报告、修复策略与导出门禁（首次含检索覆盖复核，修复后重算时不重复累加） */
function buildQualityReportBundle(input: {
  finalChapterDrafts: DocumentDraftChapter[]; effectiveChapters: DocumentTemplateChapter[]; factsModel: any; allEvidence: DocumentEvidence[];
  finalMarkdown: string; validationIssues: ValidationIssue[]; retrievalCoverageReports: RetrievalCoverageReport[]; includeRetrievalCoverage: boolean;
}) {
  const { finalChapterDrafts, effectiveChapters, factsModel, allEvidence, finalMarkdown, validationIssues, retrievalCoverageReports, includeRetrievalCoverage } = input;
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
  const qualityReport = buildDocumentQualityReport({ markdown: finalMarkdown, chapters: finalChapterDrafts, issues, knowledgeCoverage, factTraces, chapterCoverage });
  const repairStrategies = buildRepairStrategies({ issues, qualityReport, knowledgeCoverage, factTraces, chapterCoverage });
  issues = collectValidationIssueGroups(issues, qualityReportIssues(qualityReport), repairStrategyIssues(repairStrategies));
  const finalExportGate = buildExportGate(issues, factsModel, finalChapterDrafts);
  return { knowledgeCoverage, factTraces, chapterCoverage, qualityReport, repairStrategies, validationIssues: issues, finalExportGate };
}

/** P1-11 executionStages 限幅：20+ 章文档 progressStages 可达数百条，前端渲染/序列化开销随章数线性增长；
 * 超过上限时把中间历史阶段合并为一条归档摘要（保留头尾关键阶段） */
function throttleExecutionStages(stages: DocumentExecutionStage[], limit = 300): DocumentExecutionStage[] {
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

export async function finalizeGeneration(p: {
  chapterDrafts: DocumentDraftChapter[];
  chapterDraftsByOrder: Array<DocumentDraftChapter | undefined>;
  chapterGenerationStagesByOrder: Array<DocumentExecutionStage | undefined>;
  chapterGenerationStages: DocumentExecutionStage[];
  effectiveChapters: DocumentTemplateChapter[];
  template: DocumentTemplate; allEvidence: DocumentEvidence[];
  projectMaterialScope: ProjectMaterialScope;
  progressStages: DocumentExecutionStage[];
  documentSpec: any; projectMaterialProfile: any; projectMaterialSummary: any; domainProfile: any;
  documentBudget: any; promptTexts: string; reviewPromptTexts: string;
  input: { requirement?: string; signal?: AbortSignal; onProgress?: any };
  generationStrategy: any; generationDiagnostics: DocumentGenerationDiagnostics;
  promptBindings: any[]; promptDocumentRules: any;
  projectUnderstanding: any; projectContext: string; projectRoot: string; projectId: string; readiness: any;
  factExtractionPromptTexts: string;
  hasExplicitOutline: boolean; missingItems: string[];
  retrievalCoverageReports: RetrievalCoverageReport[];
  failedChapterMessages: string[];
  webResearchReport: { enabled: boolean; queries: string[]; evidenceCount: number; filteredCount: number; chapters: string[] };
  indexHealth: any; promptPlan: any;
  agentWorkflow: AgentWorkflowContext;
  globalConsistencyIssues?: string[];
  writingTaskBrief?: WritingTaskBrief;
  emitProgress: (c?: DocumentDraftChapter[], s?: DocumentExecutionStage[]) => void;
  withProgressHeartbeat: <T>(w: () => Promise<T>, s?: DocumentExecutionStage[]) => Promise<T>;
}): Promise<GeneratedDocumentDraft> {
  const {
    chapterDraftsByOrder, chapterGenerationStagesByOrder, chapterGenerationStages, effectiveChapters, template, allEvidence, projectMaterialScope,
    progressStages, documentSpec, projectMaterialSummary, domainProfile, documentBudget,
    input, generationDiagnostics, promptTexts, promptBindings, promptDocumentRules, projectRoot, projectId, readiness,
    factExtractionPromptTexts, hasExplicitOutline, missingItems, retrievalCoverageReports, failedChapterMessages,
    webResearchReport, indexHealth, agentWorkflow, globalConsistencyIssues, writingTaskBrief, emitProgress, withProgressHeartbeat,
  } = p;
  const { signal, requirement } = input;

  const chapterDrafts = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
  chapterGenerationStages.push(...chapterGenerationStagesByOrder.filter((item): item is DocumentExecutionStage => Boolean(item)));
  if (chapterDrafts.length === 0) throw new Error(`章节生成未完成：${failedChapterMessages.join('；') || '没有生成任何有效章节'}`);
  if (hasExplicitOutline && chapterDrafts.length < effectiveChapters.length) throw new Error(`OUTLINE 指定 ${effectiveChapters.length} 章，实际只生成 ${chapterDrafts.length} 章：${failedChapterMessages.join('；') || '部分章节未生成'}`);

  const generatedChapterEvidence = filterEvidenceByProjectScope(chapterDrafts.flatMap(chapter => chapter.evidence || []), projectMaterialScope);
  assertEvidenceInProjectScope(generatedChapterEvidence, projectMaterialScope, 'finalize:chapter-evidence');
  if (generatedChapterEvidence.length > 0) {
    allEvidence.push(...generatedChapterEvidence);
    // P1-7 证据内存节流：章节证据收集后统一压缩，maxChars 90k 封顶（20+ 章文档不再线性膨胀），pinned 证据仍优先保留
    const compactGeneratedEvidence = selectEvidenceByBudget(allEvidence, { maxChars: Math.min(90000, Math.max(50000, effectiveChapters.length * 9000)), preservePinned: true });
    allEvidence.splice(0, allEvidence.length, ...compactGeneratedEvidence);
  }
  const scopedAllEvidence = filterEvidenceByProjectScope(allEvidence, projectMaterialScope);
  allEvidence.splice(0, allEvidence.length, ...scopedAllEvidence);
  assertEvidenceInProjectScope(allEvidence, projectMaterialScope, 'finalize:all-evidence');

  throwIfAborted(signal);
  upsertProgressStage(progressStages, displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'running', message: '正在理解多模态参考文件' }, { subtitle: '多模态参考文件' }));
  emitProgress(chapterDrafts);
  let fileUnderstanding: { stage: DocumentExecutionStage; notes: string[] } = { stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '文件理解跳过' }, notes: [] };
  try {
    fileUnderstanding = await understandReferenceFiles(projectRoot, allEvidence, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error('[gen] fileUnderstanding failed:', err);
  }
  upsertProgressStage(progressStages, fileUnderstanding.stage);
  const compactPostFileEvidence = selectEvidenceByBudget(allEvidence, { maxItems: Math.max(48, effectiveChapters.length * 10), maxChars: Math.min(90000, Math.max(52000, effectiveChapters.length * 9000)), preservePinned: true });
  allEvidence.splice(0, allEvidence.length, ...filterEvidenceByProjectScope(compactPostFileEvidence, projectMaterialScope));
  assertEvidenceInProjectScope(allEvidence, projectMaterialScope, 'finalize:post-file-understanding');

  const facts = extractFacts(template, allEvidence, documentSpec);
  const localFacts = filterFactsByProjectScope(extractStructuredFacts(allEvidence, template, documentSpec), projectMaterialScope);
  const projectBasicFacts = filterFactsByProjectScope(extractProjectBasicFactsFromEvidence(allEvidence), projectMaterialScope);
  const preciseFacts = filterFactsByProjectScope(extractPreciseFactsFromEvidence(allEvidence, domainProfile), projectMaterialScope);
  const preLlmFacts = [...localFacts, ...projectBasicFacts, ...preciseFacts];
  let llmExtraction: { facts: DocumentFact[]; stages: DocumentExecutionStage[] } = { facts: [], stages: [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: '已有本地/资料事实覆盖主要必需字段，跳过 LLM 全量事实抽取' }] };
  if (shouldRunLlmFactExtraction(preLlmFacts, template, documentSpec)) {
    const factExtractionEvidence = selectEvidenceByBudget(allEvidence, { maxItems: 48, maxChars: 45000, preservePinned: true });
    try {
      llmExtraction = await extractFactsWithLlm(factExtractionEvidence, factExtractionPromptTexts, template, documentSpec, signal, generationDiagnostics);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.error('[gen] fact extraction failed:', err);
    }
  }
  for (const stage of llmExtraction.stages) upsertProgressStage(progressStages, stage);
  const structuredFacts = filterFactsByProjectScope(factsWithEvidenceSource([...localFacts, ...projectBasicFacts, ...preciseFacts, ...llmExtraction.facts], allEvidence), projectMaterialScope);
  for (const fact of structuredFacts) facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;

  const structuredTables = filterFactsByProjectScope(extractStructuredTables(allEvidence), projectMaterialScope);
  const factsModel = buildFactsModel(structuredFacts, structuredTables, missingItems, documentSpec, domainProfile);
  const chapterReadiness = evaluateChapterReadiness(chapterDrafts, documentSpec);
  const validation = validateDraft(chapterDrafts, structuredFacts, template);
  validation.warnings = [...validation.warnings, ...readiness.warnings];
  validation.errors = [...validation.errors, ...readiness.blockingIssues];

  const sources = [...allEvidence.reduce((map, item) => map.set(item.filePath, (map.get(item.filePath) ?? 0) + 1), new Map<string, number>()).entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([filePath, count]) => ({ filePath, count }));
  const evidenceSourceCounts = new Map<string, number>();
  for (const item of allEvidence) evidenceSourceCounts.set(item.source || 'unknown', (evidenceSourceCounts.get(item.source || 'unknown') ?? 0) + 1);

  let validationIssues = collectValidationIssueGroups(
    buildValidationIssues(validation, factsModel, chapterDrafts),
    chapterReadinessIssues(chapterReadiness),
    (globalConsistencyIssues || []).slice(0, 10).map(message => ({ level: 'warning' as const, severity: 'warning' as const, category: 'fact_consistency' as const, owner: 'llm' as const, message: `跨章一致性复核：${message}`, suggestion: '建议在章节续写或定向修复阶段消除跨章不一致。' })),
  );
  const budgetDraftMarkdown = chapterDrafts.map(chapter => chapter.content).join('\n\n');
  validationIssues = collectValidationIssueGroups(
    validationIssues,
    factCoverageIssues(budgetDraftMarkdown, structuredFacts, { maxIssues: 20 }).map(issue => ({ ...issue, level: 'warning' as const, severity: 'warning' as const, suggestion: '建议 Agent Writer 在章节生成阶段优先落位可信基础事实；导出阶段不因未落位的低置信或泛化事实阻断。' })),
  );

  const missingChapterCount = Math.max(0, effectiveChapters.length - chapterDrafts.length);
  validationIssues = collectValidationIssueGroups(validationIssues, [
    ...(missingChapterCount > 0 ? [{ level: 'error' as const, severity: 'blocker' as const, message: `部分章节生成失败：${missingChapterCount} 章`, suggestion: failedChapterMessages.join('；') || '请检查模型调用、知识库检索和事实抽取配置后重新生成失败章节。' }] : []),
  ]);
  validationIssues = collectValidationIssueGroups(validationIssues, chapterDrafts.flatMap(chapter => {
    const templateChapter = effectiveChapters.find(item => item.id === chapter.id);
    if (!templateChapter) return [];
    const issues = chapterSectionFactUsageIssues({ chapter: templateChapter, content: chapter.content, evidence: chapter.evidence || [] });
    return issues.length > 0 ? [{ level: 'warning' as const, message: `${chapter.title} 小节事实或量化参数落位可继续优化：${issues.slice(0, 5).join('；')}`, suggestion: '建议在 Agent Writer 阶段扩大定向证据，不得在导出阶段补写。' }] : [];
  }));

  const assets: DocumentAsset[] = [];
  const executionStages: DocumentExecutionStage[] = throttleExecutionStages([...progressStages, ...chapterGenerationStages]);
  upsertProgressStage(executionStages, displayStage({ type: 'reference', roleId: 'knowledge-usage-report', status: 'success', message: `资料使用报告：证据 ${allEvidence.length} 条，来源文件 ${sources.length} 份，结构化事实 ${structuredFacts.length} 条`, details: [`证据类型：${[...evidenceSourceCounts.entries()].map(([name, count]) => `${name} ${count}`).join('，') || '无'}`, `索引健康：可用切片 ${indexHealth.usableChunkCount} 条，待索引 ${indexHealth.pendingJobs} 个，向量 ${indexHealth.vectorStatus?.status || 'unknown'}`] }, { subtitle: '资料使用报告' }));
  upsertProgressStage(executionStages, displayStage({ type: 'reference', roleId: 'web-research-report', status: webResearchReport.enabled ? 'success' : 'skipped', message: webResearchReport.enabled ? `联网增强：检索章节 ${new Set(webResearchReport.chapters).size} 个，查询 ${webResearchReport.queries.length} 个，使用公开资料 ${webResearchReport.evidenceCount} 条` : '联网增强未开启', details: webResearchReport.enabled ? [`检索主题：${[...new Set(webResearchReport.queries)].join('；') || '无'}`, `过滤结果：${webResearchReport.filteredCount} 条`, '公开资料仅用于通用规范、政策、工艺和措施补充，不作为项目事实来源'] : ['可在模型配置中开启联网增强'] }, { subtitle: '联网增强报告' }));

  const finalizedDocument = finalizeDocumentMarkdown(composeDocumentMarkdown({
    templateId: template.id,
    templateName: template.name,
    title: template.outputTitle,
    requirement: requirement || '',
    projectRoot,
    projectId,
    exportSettings: template.exportSettings,
    generationSettings: template.generationSettings,
    facts,
    structuredFacts,
    factsModel,
    chapters: chapterDrafts,
    sources,
    missingItems: [...new Set(missingItems)],
    validation,
    validationIssues,
    executionStages,
    exportGate: { passed: false, blockingIssues: [], checklist: [] },
    assets,
    partialChapters: chapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: chapterDrafts,
    generatedAt: Date.now(),
  }, { forbidDrawingImages: false, promptRules: promptDocumentRules }), chapterDrafts, { forbidDrawingImages: false, promptRules: promptDocumentRules });
  let finalChapterDrafts = finalizedDocument.chapters.map(chapter => {
    const templateChapter = effectiveChapters.find(item => item.id === chapter.id) || chapter;
    return { ...chapter, sections: chapter.sections || [], content: finalizeChapterContentQuality(chapter.content, templateChapter) };
  });
  let finalMarkdown = finalizeDocumentMarkdown(composeDocumentMarkdown({ templateId: template.id, templateName: template.name, title: template.outputTitle, requirement: requirement || '', projectRoot, projectId, exportSettings: template.exportSettings, generationSettings: template.generationSettings, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems: [...new Set(missingItems)], validation, validationIssues, executionStages, exportGate: { passed: false, blockingIssues: [], checklist: [] }, assets, partialChapters: [], checkpointChapters: finalChapterDrafts, generatedAt: Date.now() }, { forbidDrawingImages: false, promptRules: promptDocumentRules }), finalChapterDrafts, { forbidDrawingImages: false, promptRules: promptDocumentRules }).markdown;
  finalMarkdown = normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(finalMarkdown, structuredFacts), projectMaterialSummary))));

  const canonicalFacts = buildCanonicalFacts({ facts: structuredFacts, markdown: finalMarkdown });
  if (canonicalFacts.size > 0) executionStages.push({ type: 'fact_extraction', roleId: 'canonical-facts', status: 'success', message: `已决策可信基础事实 ${canonicalFacts.size} 项`, details: [...canonicalFacts.values()].map(fact => `${fact.label}=${fact.value}（${fact.source}，confidence=${fact.confidence}）`).slice(0, 12) });

  // Final Gate 修复后重算问题组会重新计算，修复基线只保留基础累计问题，避免重复累加
  const baseValidationIssues = validationIssues;
  validationIssues = buildFullValidationIssues({ documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget });

  let qualityBundle = buildQualityReportBundle({ finalChapterDrafts, effectiveChapters, factsModel, allEvidence, finalMarkdown, validationIssues, retrievalCoverageReports, includeRetrievalCoverage: true });
  let { knowledgeCoverage, factTraces, chapterCoverage, qualityReport, repairStrategies, finalExportGate } = qualityBundle;
  validationIssues = qualityBundle.validationIssues;
  const finalGateRepairStages: DocumentExecutionStage[] = [];
  const finalGateRepairCandidates = [
    ...finalExportGate.blockingIssues,
    ...validationIssues.filter(issue => issue.level === 'error'),
  ];
  const criticalSectionTitleRe = /项目特点.*重点.*难点|重点.*难点.*分析|项目主要施工内容|主要分部分项工程施工方案|主要施工方法|危大工程专项施工方案审批流程|原材料进场复试与见证取样/u;
  const emptySectionIssues = Array.from(new Map(finalGateRepairCandidates
    .map(issue => {
      const match = /^(.*?)(?:\s+|)(?:空小节|小节内容补写未完成|小节生成未达标|小节只有标题|只有标题或表格无正文|规划小节正文过短|正文小节正文过短|缺少规划小节|正文不足)[：:,，]\s*(.+)$/u.exec(issue.message);
      if (!match) return undefined;
      // 关键小节（重点难点/主要施工内容/分部分项方案等）优先修复：避免普通空小节占满修复名额导致关键小节错误残留
      const depthIssue = /^(.*?)\s+(项目特点、重点、难点分析|项目主要施工内容|主要分部分项工程施工方案|主要施工方法|危大工程专项施工方案审批流程|原材料进场复试与见证取样)\s+正文不足/u.exec(issue.message);
      // Reviewer 深度类消息无章节前缀（“项目主要施工内容 正文不足，未达到任务最小深度”），单独解析小节标题
      const reviewerDepthIssue = /^(.+?)\s*正文不足，未达到任务最小深度$/u.exec(issue.message);
      const sectionTitle = depthIssue ? depthIssue[2] : reviewerDepthIssue ? reviewerDepthIssue[1].trim() : match[2].split(/[：:,，,]/u)[0].trim();
      return { issue, match, critical: criticalSectionTitleRe.test(sectionTitle) };
    })
    .filter((item): item is { issue: ValidationIssue; match: RegExpExecArray; critical: boolean } => Boolean(item))
    .map(item => [`${item.match[1].trim()}::${item.match[2].trim()}`, item])).values())
    .sort((a, b) => Number(b.critical) - Number(a.critical))
    .slice(0, 4);
  if (emptySectionIssues.length > 0) {
    const repairDetails: string[] = [];
    const repairedSectionKeys = new Set<string>();
    for (const { issue, match } of emptySectionIssues) {
      let chapterTitle = match[1].trim();
      let sectionTitle = match[2].trim();
      const depthIssue = /^(.*?)\s+(项目特点、重点、难点分析|项目主要施工内容|主要分部分项工程施工方案|主要施工方法|危大工程专项施工方案审批流程|原材料进场复试与见证取样)\s+正文不足/u.exec(issue.message);
      if (depthIssue) {
        chapterTitle = depthIssue[1].trim();
        sectionTitle = depthIssue[2].trim();
      }
      const reviewerDepthIssue = /^(.+?)\s*正文不足，未达到任务最小深度$/u.exec(issue.message);
      if (reviewerDepthIssue) {
        chapterTitle = '';
        sectionTitle = reviewerDepthIssue[1].trim();
      }
      let chapterIndex = chapterTitle ? finalChapterDrafts.findIndex(chapter => chapter.title === chapterTitle || chapterTitle.includes(chapter.title) || chapter.title.includes(chapterTitle)) : -1;
      if (chapterIndex < 0) {
        chapterIndex = finalChapterDrafts.findIndex(chapter => (chapter.content || '').includes(sectionTitle));
      }
      const draftChapter = finalChapterDrafts[chapterIndex];
      const templateChapter = effectiveChapters.find(chapter => chapter.id === draftChapter?.id || chapter.title === draftChapter?.title);
      if (chapterIndex < 0 || !draftChapter || !templateChapter) {
        repairDetails.push(`失败：${chapterTitle}/${sectionTitle} 未定位到章节`);
        continue;
      }
      chapterTitle = chapterTitle || draftChapter.title;
      const runningRepairStage = displayStage({ type: 'llm_review', roleId: `agent-final-gate-repair-${draftChapter.id}`, status: 'running', message: `Final Gate 正在补写空小节：${chapterTitle} / ${sectionTitle}`, details: repairDetails }, { subtitle: 'Final Gate Repair' });
      upsertProgressStage(progressStages, runningRepairStage);
      upsertProgressStage(finalGateRepairStages, runningRepairStage);
      emitProgress(finalChapterDrafts, progressStages);
      const criticalMinChars = criticalSectionBlockerMinChars(sectionTitle);
      const repairTargetWords = Math.max(620, criticalMinChars > 0 ? Math.ceil(criticalMinChars / 0.7) : 620);
      const lastFailure = generationDiagnostics.llm.lastError;
      generationDiagnostics.llm.lastError = undefined;
      const generated = await withProgressHeartbeat(() => buildLlmSectionContent({
        template,
        chapter: templateChapter,
        sectionTitle,
        evidence: draftChapter.evidence?.length ? draftChapter.evidence : allEvidence,
        missingFacts: [],
        promptTexts,
        projectContext: p.projectContext,
        requirement,
        roleContext: 'Final Gate 空小节定向修复',
        targetWords: repairTargetWords,
        maxWords: Math.ceil(repairTargetWords * 1.32),
        forbidDrawingImages: false,
        qualityFeedback: `Final Gate 发现“${sectionTitle}”为空小节或深度不足。请基于证据完整重写该小节正式正文（原小节内容将被整体替换），包含检查责任、验收节点、资料闭环、整改复验要求，优先落位项目建筑面积、层数、工期、专业范围等量化参数，不得输出占位或解释。${lastFailure ? `此前生成被拒原因：${lastFailure}，必须逐条修正。` : ''}`,
        diagnostics: generationDiagnostics,
        signal,
      }));
      let repaired = false;
      if (generated && documentTextLength(generated) >= 80) {
        const nextContent = replaceMarkdownSection(draftChapter.content, sectionTitle, generated);
        repaired = nextContent !== draftChapter.content;
        if (!repaired && /缺少规划小节/u.test(issue.message)) {
          // 规划小节在正文中完全缺失：无原块可替换，将补写正文追加为新的三级小节
          const appended = `${draftChapter.content.replace(/\s+$/u, '')}\n\n### ${sectionTitle}\n\n${generated.replace(/^#{2,6}\s+(?:\d+(?:\.\d+)*\s+)?[^\n]+\n+/u, '').trim()}\n`;
          repaired = true;
          finalChapterDrafts[chapterIndex] = { ...draftChapter, content: finalizeChapterContentQuality(appended, templateChapter) };
          repairedSectionKeys.add(`${chapterTitle}::${sectionTitle}`);
          repairDetails.push(`成功：${chapterTitle}/${sectionTitle}（${documentTextLength(generated)}字，追加为缺失小节）`);
        } else if (repaired) {
          finalChapterDrafts[chapterIndex] = { ...draftChapter, content: finalizeChapterContentQuality(nextContent, templateChapter) };
          repairedSectionKeys.add(`${chapterTitle}::${sectionTitle}`);
          repairDetails.push(`成功：${chapterTitle}/${sectionTitle}（${documentTextLength(generated)}字）`);
        } else {
          repairDetails.push(`失败：${chapterTitle}/${sectionTitle}（未定位到原小节块）`);
        }
      } else {
        repairDetails.push(`失败：${chapterTitle}/${sectionTitle}（${generationDiagnostics.llm.lastError || '空响应'}）`);
      }
      const completedRepairStage = displayStage({ type: 'llm_review', roleId: `agent-final-gate-repair-${draftChapter.id}`, status: repaired ? 'success' : 'failed', message: repaired ? `Final Gate 空小节修复完成：${chapterTitle} / ${sectionTitle}` : `Final Gate 空小节修复失败：${chapterTitle} / ${sectionTitle}`, details: repairDetails }, { subtitle: 'Final Gate Repair' });
      upsertProgressStage(progressStages, completedRepairStage);
      upsertProgressStage(finalGateRepairStages, completedRepairStage);
      emitProgress(finalChapterDrafts, progressStages);
    }
    finalMarkdown = normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary))));
    const repairedValidationBase = baseValidationIssues.filter(issue => ![...repairedSectionKeys].some(key => {
      const [chapterTitle, sectionTitle] = key.split('::');
      if (!/空小节|小节内容补写未完成|小节生成未达标|小节只有标题|正文小节正文过短|规划小节正文过短|缺少规划小节|正文不足/u.test(issue.message)) return false;
      // Reviewer 深度类消息无章节前缀，单独按“小节标题 + 正文不足，未达到任务最小深度”匹配
      const escapedSection = sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (new RegExp(`^\\s*${escapedSection}\\s*正文不足，未达到任务最小深度$`, 'u').test(issue.message)) return true;
      return issue.message.includes(chapterTitle) && issue.message.includes(sectionTitle);
    })
    // 事实落位警告是预算稿快照（Final Gate 修复前的章节草稿拼接），修复后的重算会用最新 finalMarkdown 重新生成，
    // 旧快照必须丢弃：否则已落位的事实（如基本信息表中的招标人）会带着修复前的警告进入最终交付。
    && !/已确认事实未在正文中落位/u.test(issue.message));
    validationIssues = buildFullValidationIssues({ documentSpec, validationIssues: repairedValidationBase, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget });
    qualityBundle = buildQualityReportBundle({ finalChapterDrafts, effectiveChapters, factsModel, allEvidence, finalMarkdown, validationIssues, retrievalCoverageReports, includeRetrievalCoverage: false });
    ({ knowledgeCoverage, factTraces, chapterCoverage, qualityReport, repairStrategies, finalExportGate } = qualityBundle);
    validationIssues = qualityBundle.validationIssues;
  }
  const reviewChecklist = buildDocumentReviewChecklist({ exportGate: finalExportGate, qualityReport, repairStrategies });
  const telemetry = buildDocumentTelemetryReport({ diagnostics: generationDiagnostics });
  const finalQualitySummary = qualitySeveritySummary(validationIssues);
  const professionalScore = buildProfessionalScoreReport(finalChapterDrafts, finalMarkdown);
  generationDiagnostics.quality.blockingCount += finalQualitySummary.blocking;
  generationDiagnostics.quality.importantCount += finalQualitySummary.important;
  generationDiagnostics.quality.minorCount += finalQualitySummary.minor;

  const blockingCount = finalExportGate.blockingIssues.length;
  const finalStages = [...executionStages, ...finalGateRepairStages].map(stage => {
    if (stage.type === 'validation' && stage.roleId === 'document-workflow') return { ...stage, status: blockingCount > 0 ? 'failed' as const : 'success' as const, message: `阻断 ${blockingCount}，问题 ${validationIssues.length}` };
    if (stage.type === 'export_ready') return { ...stage, status: finalExportGate.passed ? 'success' as const : 'failed' as const, message: finalExportGate.passed ? '已准备好导出 Markdown/HTML/DOCX/PDF' : '导出门禁未通过，请完成阻断问题修复后再导出' };
    if (finalExportGate.passed && stage.status === 'failed' && /^agent-(?:reviewer|repairer)-/u.test(stage.roleId)) {
      return { ...stage, status: 'skipped' as const, message: `${stage.message || '章节中间审查失败'}；最终门禁已通过，历史中间态已归档` };
    }
    return stage;
  });
  finalStages.push(displayStage({ type: 'validation', roleId: 'agent-final-gate', status: finalExportGate.passed ? 'success' : 'failed', message: finalExportGate.passed ? 'Agent 最终门禁通过' : `Agent 最终门禁阻断 ${blockingCount} 个问题`, details: finalExportGate.blockingIssues.slice(0, 12).map(issue => issue.message) }, { subtitle: 'Agent 最终门禁' }));
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-delivery-score', status: qualityReport.passed ? 'success' : finalExportGate.passed ? 'skipped' : 'failed', message: finalExportGate.passed && !qualityReport.passed ? `${qualityReport.summary}（导出门禁已通过，作为后续优化建议归档）` : qualityReport.summary, details: qualityReport.actions }, { subtitle: '交付评分' }));
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-professional-score', status: professionalScore.grade === '专业' || professionalScore.grade === '良好' ? 'success' : 'skipped', message: professionalScore.summary, details: [...professionalScore.dimensions.map(dimension => `${dimension.label}：${dimension.score} 分（${dimension.detail}）`), ...professionalScore.topIssues.map(issue => `待修复：${issue}`)] }, { subtitle: '专业度评分' }));
  if (writingTaskBrief) {
    finalStages.push(displayStage({ type: 'reference', roleId: 'document-writing-task-brief', status: 'success', message: `写作任务书：${writingTaskBrief.documentType}，${writingTaskBrief.chapters.length} 章任务卡，全局写作焦点 ${writingTaskBrief.globalWritingFocus.length} 条`, details: [...writingTaskBrief.globalWritingFocus, ...writingTaskBrief.chapters.slice(0, 10).map(chapter => `${chapter.chapterTitle}：覆盖 ${chapter.mustCover.length} 项`)], subtitle: '写作任务书' }));
  }
  finalStages.push(displayStage({ type: 'reference', roleId: 'knowledge-coverage', status: knowledgeCoverage.score >= 85 ? 'success' : 'failed', message: `资料确认覆盖率：${knowledgeCoverage.score}%（证据 ${knowledgeCoverage.evidenceCount} 条，文件 ${knowledgeCoverage.confirmedFiles} 份）`, details: [knowledgeCoverage.remediation] }, { subtitle: '资料覆盖' }));
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-review-checklist', status: reviewChecklist.every(item => item.passed) ? 'success' : finalExportGate.passed ? 'skipped' : 'failed', message: `交付复核清单：通过 ${reviewChecklist.filter(item => item.passed).length}/${reviewChecklist.length}${finalExportGate.passed && !reviewChecklist.every(item => item.passed) ? '（导出门禁已通过，其余项作为优化建议归档）' : ''}`, details: reviewChecklist.map(item => `${item.passed ? '通过' : '待修复'}：${item.label}${item.message ? `（${item.message}）` : ''}`) }, { subtitle: '交付复核' }));
  const slowMetrics = slowMetricSummary(generationDiagnostics.metrics);
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-diagnostics', status: 'success', message: `性能统计：LLM ${generationDiagnostics.llm.calls} 次，失败 ${generationDiagnostics.llm.failures} 次，瞬态重试 ${generationDiagnostics.llm.retries} 次，峰值并行 ${generationDiagnostics.llm.maxActive}，检索 ${generationDiagnostics.evidence.searchQueries} 次/${Math.round(generationDiagnostics.evidence.searchMs / 1000)} 秒，证据上下文 ${generationDiagnostics.evidence.contextChars} 字，噪声过滤 ${generationDiagnostics.evidence.filteredNoise} 条，质量问题 阻断${generationDiagnostics.quality.blockingCount}/重要${generationDiagnostics.quality.importantCount}/轻微${generationDiagnostics.quality.minorCount}${slowMetrics ? `，Top耗时：${slowMetrics}` : ''}` }, { subtitle: '后台诊断' }));

  const compactFinalChapterDrafts = finalChapterDrafts.map(chapter => ({ ...chapter, evidence: selectEvidenceByBudget(chapter.evidence || [], { maxItems: 12, maxChars: 9000, preservePinned: true }) }));
  finalChapterDrafts = compactFinalChapterDrafts;

  return {
    templateId: template.id,
    templateName: template.name,
    title: template.outputTitle,
    requirement: requirement || '',
    projectRoot,
    projectId,
    exportSettings: template.exportSettings,
    generationSettings: template.generationSettings,
    facts,
    structuredFacts,
    factsModel,
    chapters: compactFinalChapterDrafts,
    sources,
    missingItems: [...new Set(missingItems)],
    validation,
    validationIssues,
    exportGate: finalExportGate,
    executionStages: finalStages,
    assets,
    partialChapters: finalChapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: compactFinalChapterDrafts,
    promptRules: promptDocumentRules,
    agentWorkflow,
    reviewMetadata: {
      chapterSummaries: [],
      globalIssues: [],
      diagnostics: generationDiagnostics,
      profile: buildDocumentProfileReport({ template, chapters: effectiveChapters, requirement }),
      knowledgeCoverage,
      factTraces,
      chapterCoverage,
      retrievalCoverage: retrievalCoverageReports,
      qualityReport,
      repairStrategies,
      reviewChecklist,
      professionalScore,
      writingTaskBrief,
      workflowVersion: DOCUMENT_WORKFLOW_VERSION,
      telemetry,
      qualityBenchmark: benchmarkGeneratedMarkdown(finalMarkdown),
    },
    generatedAt: Date.now(),
    markdown: finalMarkdown,
  };
}
