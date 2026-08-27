import type { AgentWorkflowContext } from './agentWorkflow';
import type { DocumentAsset, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, GeneratedDocumentDraft, NumericScopeConflict, RetrievalCoverageReport, ValidationIssue, WritingTaskBrief } from './types';
import type { ProjectMaterialScope } from './projectMaterialScope';
import { assertEvidenceInProjectScope, filterEvidenceByProjectScope, filterFactsByProjectScope, projectScopeAudit, sourceInProjectScope } from './projectMaterialScope';
import { selectEvidenceByBudget } from './evidence';
import { validateDraftWithAutoSpec } from '../document-validation/documentValidationService';
import { validateProjectContamination } from '../document-validation/documentContaminationService';
import { chapterReadinessIssues, evaluateChapterReadiness } from '../document-validation/chapterReadinessService';
import { validateFactConsistency } from '../document-validation/factConsistencyService';
import { cleanFormalSourcePhrases, composeDocumentMarkdown, finalizeDocumentMarkdown, normalizeTertiaryHeadings, plannedStructureIssues, sanitizeFormalMarkdown } from './markdownComposer';
import { documentBudgetIssues, documentTextLength, pageTargetIssues } from './budget';
import { applySpecGateRules, autoSpecGateRequiredTexts, buildExportGate, qualitySeveritySummary, applyDeterministicConsistencyFixes, applyDeterministicConsistencyFixesToMarkdown, internalTerminologyIssues } from './qualityValidation';
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
import { applyScopeConflictResolutions, buildCanonicalFacts, detectNumericScopeConflicts } from './factGovernance';
import { comparableSectionTitleText, extractSection, stringifyFactValue, throwIfAborted, WORK_PACKAGE_SECTION_RE } from './utils';
import { formalTextGateIssues } from './agentWorkflow';
import { displayStage, upsertProgressStage } from './progress';
import { buildLlmSectionContent, buildValidationIssues, criticalSectionBlockerMinChars } from './chapterGeneration';
import { chapterSectionFactUsageIssues } from './chapterReview';
import { factCoverageIssues, factsWithEvidenceSource, criticalSectionBlockerLine, finalizeChapterContentQuality, normalizeProjectBasicInfoTable, partialChapterStatus, projectBasicPlaceholderIssues, slowMetricSummary, validateDraft } from './documentGeneratorHelpers';
import { constructionOrgProfessionalAuditIssues } from './constructionOrgAudit';
import { buildProfessionalScoreReport } from './documentProfessionalScore';
import { recordDeterministicFixCases } from './workflowCaseLog';

function sanitizeContaminationCandidates(markdown: string, summary: any) {
  const currentNames = new Set([summary?.projectName, ...(summary?.fingerprint?.projectNames || [])].filter(Boolean));
  return (summary?.contaminationCandidates || []).reduce((text: string, candidate: string) => {
    if (!candidate || candidate.length < 6 || currentNames.has(candidate)) return text;
    return text.replace(new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu'), '本项目工程');
  }, markdown);
}

/** 施组标准术语补写句：每句覆盖一组模板专业规则必要术语，仅当组内任一术语缺失时整句补写 */
const REQUIRED_TEXT_SUPPLEMENTS: Array<{ words: string[]; sentence: string }> = [
  { words: ['编制依据', '国家法律法规', '地方法规'], sentence: '本施工组织设计的编制依据包括国家法律法规、地方法规及现行工程建设标准、规范' },
  { words: ['工程量清单', '项目特征', '工程量', '图纸设计说明'], sentence: '项目特征与工程量以招标工程量清单及图纸设计说明为准' },
  { words: ['劳动力计划', '主要施工材料', '主要施工机械'], sentence: '劳动力计划、主要施工材料、主要施工机械按施工进度动态配置，详见本方案各保障章节' },
];

/** 模板专业规则必要术语（编制依据/主要施工材料等施组标准术语）缺失时确定性补写：
 * Writer 只收到“质量控制点”弱建议，常遗漏这些术语；逐句补写保证术语出现在正文，不依赖 LLM 自觉 */
function supplementRequiredTexts(markdown: string, template: DocumentTemplate): string {
  const missingRequiredTexts = autoSpecGateRequiredTexts(template).filter(item => !markdown.includes(item));
  if (missingRequiredTexts.length === 0) return markdown;
  const supplementSentences = REQUIRED_TEXT_SUPPLEMENTS
    .filter(group => group.words.some(word => missingRequiredTexts.includes(word)))
    .map(group => group.sentence);
  if (supplementSentences.length === 0) return markdown;
  const supplement = `\n\n**编制依据补充说明**：${supplementSentences.join('；')}。\n`;
  const anchor = /^(?:###|####)\s+(?:[\d.]+[\s\u00a0]*)?编制说明与工程概况$/mu.exec(markdown);
  if (anchor) {
    // 注入到“编制说明与工程概况”小节标题行之后
    const insertAt = markdown.indexOf('\n', anchor.index) + 1;
    return `${markdown.slice(0, insertAt)}${supplement}${markdown.slice(insertAt)}`;
  }
  return `${markdown.replace(/\s+$/u, '')}\n${supplement}`;
}

export function replaceMarkdownSection(content: string, sectionTitle: string, sectionContent: string) {
  const normalizeHeadingTitle = (value: string) => value
    .replace(/[\u00a0\u3000]/gu, ' ')
    .replace(/^\d+(?:\.\d+)*\s+/u, '')
    .trim();
  const stripGeneratedHeading = (value: string) => value
    .trim()
    .replace(/^#{2,6}\s+(?:\d+(?:\.\d+)*\s+)?[^\n]+\n+/u, '')
    .trim();
  const lines = content.split('\n');
  // 标题语义重写定位（与验收器 extractSectionFuzzy 同口径）：规划锚点“项目特点、重点、难点分析”
  // 在成稿中常被改写为“项目重点难点分析”等标题，字面不匹配导致修复器“未定位到原小节块”修复失效；
  // 可比标题归一化后按包含关系定位。聚合主题块（H3 下紧跟 H4 子小节）不可被单小节替换，跳过，
  // 只替换叶子级小节，避免整块内容被补写稿吞并（真实生成缺陷：深度不足修复替换整章主题块破坏结构）
  const comparableMatches = (headingTitle: string) => {
    const comparableHeading = comparableSectionTitleText(headingTitle);
    const comparableTitle = comparableSectionTitleText(sectionTitle);
    return comparableHeading === comparableTitle || comparableHeading.includes(comparableTitle) || comparableTitle.includes(comparableHeading);
  };
  const isAggregateThemeBlock = (index: number) => {
    const heading = /^(#{3,4})\s+(.+)$/u.exec(lines[index].trim());
    if (!heading || heading[1].length !== 3) return false;
    // 聚合主题块判定：H3 标题后（允许空行间隔）到下一个 H2/H3 之间若存在任何 #### 子小节，
    // 说明该块由子小节展开，不可被单小节整体替换，否则吞并子小节（如基本信息表）破坏结构
    for (let next = index + 1; next < lines.length; next += 1) {
      const trimmed = lines[next].trim();
      if (/^#{2,3}\s+/u.test(trimmed)) return false;
      if (/^####\s+/u.test(trimmed)) return true;
    }
    return false;
  };
  let cursor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineStart = cursor;
    cursor += line.length + 1;
    const heading = /^(#{3,4})\s+(.+)$/u.exec(line.trim());
    if (!heading) continue;
    const headingTitle = normalizeHeadingTitle(heading[2]);
    const exactMatch = headingTitle === sectionTitle || headingTitle.includes(sectionTitle) || sectionTitle.includes(headingTitle);
    if (!exactMatch && !comparableMatches(headingTitle)) continue;
    if (!exactMatch && comparableMatches(headingTitle) && isAggregateThemeBlock(index)) continue;
    const headingLevel = heading[1].length;
    // 工作包型关键小节：正文由同级 H4 工作包展开，替换边界必须扩展到下一个上级标题（H2/H3），
    // 吞并原有工作包 H4——否则生成稿工作包与旧稿工作包前后重复，且标题下直接跟 H4 会被误判为空标题
    const workPackageSection = WORK_PACKAGE_SECTION_RE.test(headingTitle) || WORK_PACKAGE_SECTION_RE.test(sectionTitle);
    const boundaryHeadingRe = workPackageSection && headingLevel === 3 ? /^#{2,3}\s+/u : /^#{2,4}\s+/u;
    let endLine = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (boundaryHeadingRe.test(lines[next].trim())) {
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

/**
 * Final Gate 修复候选解析：从 error 级结构缺陷消息中解析（章节标题、小节标题、是否关键小节）三元组，
 * 未命中返回 undefined（非结构类 error 不进修复循环）。覆盖消息形态：
 * - 空小节/深度不足（含 Reviewer 无章节前缀形态“XX 正文不足，未达到任务最小深度”）
 * - 小节完全缺失（“施工组织设计缺少"XXX"小节”）
 * - 锚点小节缺失或标题结构异常（专项验收器：锚点被合并/改写后工作包缺失，映射回标准锚点标题走追加修复）
 */
export function parseFinalGateRepairCandidate(issue: ValidationIssue): { issue: ValidationIssue; chapterTitle: string; sectionTitle: string; critical: boolean } | undefined {
  const criticalSectionTitleRe = /项目特点.*重点.*难点|重点.*难点.*分析|项目主要施工内容|主要分部分项工程施工方案|主要施工方法|危大工程专项施工方案审批流程|原材料进场复试与见证取样/u;
  const match = /^(.*?)(?:\s+|)(?:空小节|小节内容补写未完成|小节生成未达标|小节只有标题|只有标题或表格无正文|规划小节正文过短|正文小节正文过短|缺少规划小节|正文不足)[：:,，]\s*(.+)$/u.exec(issue.message);
  // 关键小节（重点难点/主要施工内容/分部分项方案等）优先修复：避免普通空小节占满修复名额导致关键小节错误残留
  const depthIssue = /^(.*?)\s+(项目特点、重点、难点分析|项目主要施工内容|主要分部分项工程施工方案|主要施工方法|危大工程专项施工方案审批流程|原材料进场复试与见证取样)\s+正文不足/u.exec(issue.message);
  // Reviewer 深度类消息无章节前缀（“项目主要施工内容 正文不足，未达到任务最小深度”），单独解析小节标题
  const reviewerDepthIssue = /^(.+?)\s*正文不足，未达到任务最小深度$/u.exec(issue.message);
  // Final Gate 结构校验消息：小节完全缺失（“施工组织设计缺少"项目主要施工内容"小节”），必须带引号才匹配，避免误伤“缺少规划小节”类消息
  const missingSectionIssue = /^(?:施工组织设计\s*)?缺少[“"'](.+?)[”"']小节$/u.exec(issue.message);
  // 专项结构校验消息：锚点小节被合并/改写后未形成规范结构（“工程重点难点及危大工程的保障体系 主要施工内容小节缺失或标题结构异常”），
  // 与 missingSectionIssue 同属“缺失可补写”语义，按标准锚点标题映射进追加修复路径（真实生成缺陷：合并标题工作包缺失时精确匹配落空，
  // 该消息未被任何解析正则命中导致永不修复）
  const anchorSectionIssue = /^(.*?)\s+(主要施工内容|分部分项工程施工方案)小节缺失或标题结构异常$/u.exec(issue.message);
  // 分部分项专项验收消息（分项不足/缺三段式/缺箭头链/参数不足）：与 anchorSectionIssue 同属“结构不达标可补写”语义，
  // 消息带章节前缀但无固定后缀形态，直接映射标准锚点标题（历史缺陷：验收器 blocker 未被门禁拦截、消息形态也未进修复循环，分部分项永远无法自愈）
  const divisionIssue = /^(.*?)\s+分部分项工程施工方案/u.exec(issue.message);
  if (!match && !missingSectionIssue && !anchorSectionIssue && !divisionIssue) return undefined;
  const chapterTitle = depthIssue ? depthIssue[1].trim() : reviewerDepthIssue ? '' : missingSectionIssue ? '' : anchorSectionIssue ? anchorSectionIssue[1].trim() : divisionIssue ? divisionIssue[1].trim() : match![1].trim();
  const sectionTitle = depthIssue ? depthIssue[2] : reviewerDepthIssue ? reviewerDepthIssue[1].trim() : missingSectionIssue ? missingSectionIssue[1].trim() : anchorSectionIssue ? (anchorSectionIssue[2] === '主要施工内容' ? '项目主要施工内容' : '主要分部分项工程施工方案') : divisionIssue ? '主要分部分项工程施工方案' : match![2].split(/[：:,，,]/u)[0].trim();
  return { issue, chapterTitle, sectionTitle, critical: criticalSectionTitleRe.test(sectionTitle) };
}

/**
 * 已修复小节旧快照 issue 过滤判定（Final Gate 修复后重算用）：结构缺陷类消息才进入过滤，
 * 章节+小节标题双包含命中即丢弃旧 issue，避免修复后的重算带着旧 blocker 进入最终交付。
 * 锚点缺失类消息只带缩写锚点（“主要施工内容小节缺失”），修复器按标准标题（“项目主要施工内容”）
 * 记 key，需去“项目/主要”前缀做包含匹配才能命中旧快照 issue，否则修复后旧 blocker 残留被门禁持续阻断。
 */
export function isRepairedSectionIssue(issueMessage: string, chapterTitle: string, sectionTitle: string) {
  if (!/空小节|小节内容补写未完成|小节生成未达标|小节只有标题|正文小节正文过短|规划小节正文过短|缺少规划小节|缺少[“"'].+[”"']小节|正文不足|小节缺失或标题结构异常|分部分项工程施工方案/u.test(issueMessage)) return false;
  // Reviewer 深度类消息无章节前缀，单独按“小节标题 + 正文不足，未达到任务最小深度”匹配
  const escapedSection = sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (new RegExp(`^\\s*${escapedSection}\\s*正文不足，未达到任务最小深度$`, 'u').test(issueMessage)) return true;
  const looseSection = sectionTitle.replace(/^(?:项目|主要)/u, '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return issueMessage.includes(chapterTitle) && (issueMessage.includes(sectionTitle) || (looseSection !== escapedSection && issueMessage.includes(looseSection)));
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
    if (numeric < rule.minNumericFacts) issues.push({ level: 'warning', severity: 'warning', message: `${chapter.title} ${rule.title} 参数落位不足：当前 ${numeric} 个，建议不少于 ${rule.minNumericFacts} 个`, suggestion: '关键小节必须写入项目规模、工期、层数、结构、专业工程或验收参数等具体数值。' });
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

function rebuildFinalMarkdown(input: { template: DocumentTemplate; requirement?: string; projectRoot: string; projectId: string; facts: Record<string, string>; structuredFacts: DocumentFact[]; factsModel: any; chapters: DocumentDraftChapter[]; sources: { filePath: string; count: number }[]; missingItems: string[]; validation: any; validationIssues: any[]; executionStages: DocumentExecutionStage[]; assets: DocumentAsset[]; promptDocumentRules: any }) {
  return finalizeDocumentMarkdown(composeDocumentMarkdown({ templateId: input.template.id, templateName: input.template.name, title: input.template.outputTitle, requirement: input.requirement || '', projectRoot: input.projectRoot, projectId: input.projectId, exportSettings: input.template.exportSettings, generationSettings: input.template.generationSettings, facts: input.facts, structuredFacts: input.structuredFacts, factsModel: input.factsModel, chapters: input.chapters, sources: input.sources, missingItems: [...new Set(input.missingItems)], validation: input.validation, validationIssues: input.validationIssues, executionStages: input.executionStages, exportGate: { passed: false, blockingIssues: [], checklist: [] }, assets: input.assets, partialChapters: [], checkpointChapters: input.chapters, generatedAt: Date.now() }, { forbidDrawingImages: false, promptRules: input.promptDocumentRules }), input.chapters, { forbidDrawingImages: false, promptRules: input.promptDocumentRules }).markdown;
}

/** 核心校验组：覆盖规格门禁、事实一致性、污染、占位符、预算、结构完整性、正式文本门禁与关键小节深度/密度（首次与 Final Gate 修复后共用） */
function buildFullValidationIssues(input: {
  documentSpec: any; validationIssues: ValidationIssue[]; factsModel: any; finalChapterDrafts: DocumentDraftChapter[]; finalMarkdown: string;
  template: DocumentTemplate; promptBindings: any[]; promptDocumentRules: any; projectMaterialSummary: any; domainProfile: any; structuredFacts: DocumentFact[]; documentBudget: any;
  scopeConflicts?: NumericScopeConflict[];
  evaluationCriteriaItems?: string[];
}): ValidationIssue[] {
  const { documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget, scopeConflicts, evaluationCriteriaItems } = input;
  return collectValidationIssueGroups(
    applySpecGateRules(documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template.projectBindings || [], promptBindings),
    validateDraftWithAutoSpec({ markdown: finalMarkdown, spec: documentSpec, summary: projectMaterialSummary }),
    validateFactConsistency({ markdown: finalMarkdown, facts: structuredFacts, summary: projectMaterialSummary, profile: domainProfile }),
    validateProjectContamination(finalMarkdown, projectMaterialSummary),
    projectBasicPlaceholderIssues(finalMarkdown, structuredFacts),
    buildStandardFinalValidationIssues({ markdown: finalMarkdown, chapters: finalChapterDrafts, factsModel, template, promptBindings, promptDocumentRules, scopeConflicts, evaluationCriteriaItems }),
    factCoverageIssues(finalMarkdown, [...structuredFacts, ...factsModel.preciseFacts], { maxIssues: 30 }).map(issue => ({ ...issue, level: 'warning' as const, severity: 'warning' as const, suggestion: '建议后续优化事实自然落位；导出阶段不因未落位的引用型或可优化事实阻断。' })),
    pageTargetIssues(template.generationSettings || template.exportSettings, finalMarkdown).filter(issue => !(documentBudget.minPages && /低于目标页数/u.test(issue.message))),
    documentBudgetIssues(documentBudget, finalMarkdown),
    plannedStructureIssues(finalMarkdown, template),
    formalTextGateIssues(finalMarkdown),
    internalTerminologyIssues(finalMarkdown),
    finalMarkdown.includes('WRITER_MISSING_SECTION') || finalMarkdown.includes('Writer 未完成') ? [{ level: 'error' as const, severity: 'blocker' as const, category: 'structure' as const, owner: 'system' as const, message: '最终正文仍包含未完成小节标记', suggestion: '必须重新补写对应小节并删除 WRITER_MISSING_SECTION/Writer 未完成。' }] : [],
    criticalSectionDepthIssues(finalChapterDrafts),
    criticalSectionFactDensityIssues(finalChapterDrafts),
    constructionOrgProfessionalAuditIssues(finalChapterDrafts, finalMarkdown).map(issue => issue.level === 'error' ? { ...issue, severity: 'blocker' as const } : issue),
  ).map(issue => issue.level === 'error' ? { ...issue, severity: issue.severity || 'blocker' } : issue);
}

/** 生成前/生成中的流程诊断：反映检索与事实映射状态而非最终正文缺陷，不参与缺陷计分 */
const FLOW_DIAGNOSTIC_ISSUE_RE = /章节级证据覆盖较弱|章节事实覆盖不足|小节事实或量化参数落位可继续优化/u;

/** 质量报告组：覆盖报告、事实追踪、章节覆盖、质量报告、修复策略与导出门禁（首次含检索覆盖复核，修复后重算时不重复累加） */
function buildQualityReportBundle(input: {
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
  const qualityReport = buildDocumentQualityReport({ markdown: finalMarkdown, chapters: finalChapterDrafts, issues, knowledgeCoverage, factTraces, template });
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
  /** 生成阶段裁决的源级同口径冲突（与 canonicalFacts.scopeConflicts 同源），用于事实主表回写，保证裁决口径全局唯一 */
  scopeConflicts?: NumericScopeConflict[];
  writingTaskBrief?: WritingTaskBrief;
  /** 招标文件评分条目标题（承接审计产物），用于最终正文承接后置校验 */
  evaluationCriteriaItems?: string[];
  emitProgress: (c?: DocumentDraftChapter[], s?: DocumentExecutionStage[]) => void;
  withProgressHeartbeat: <T>(w: () => Promise<T>, s?: DocumentExecutionStage[]) => Promise<T>;
}): Promise<GeneratedDocumentDraft> {
  const {
    chapterDraftsByOrder, chapterGenerationStagesByOrder, chapterGenerationStages, effectiveChapters, template, allEvidence, projectMaterialScope,
    progressStages, documentSpec, projectMaterialSummary, domainProfile, documentBudget,
    input, generationDiagnostics, promptTexts, promptBindings, promptDocumentRules, projectRoot, projectId, readiness,
    factExtractionPromptTexts, hasExplicitOutline, missingItems, retrievalCoverageReports, failedChapterMessages,
    webResearchReport, indexHealth, agentWorkflow, globalConsistencyIssues, scopeConflicts, writingTaskBrief, evaluationCriteriaItems, emitProgress, withProgressHeartbeat,
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
  // 源级同口径冲突裁决回写：裁决值统一进入事实主表与确定性校验基准，避免正文被主表败选值误导（如 4645㎡ 与 4646㎡ 并存）
  const governedStructuredFacts = applyScopeConflictResolutions(structuredFacts, scopeConflicts ?? detectNumericScopeConflicts(structuredFacts));
  for (const fact of governedStructuredFacts) facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;

  const structuredTables = filterFactsByProjectScope(extractStructuredTables(allEvidence), projectMaterialScope);
  const factsModel = buildFactsModel(governedStructuredFacts, structuredTables, missingItems, documentSpec, domainProfile);
  const chapterReadiness = evaluateChapterReadiness(chapterDrafts, documentSpec);
  const validation = validateDraft(chapterDrafts, governedStructuredFacts, template);
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
    // 生成阶段跨章一致性快照：确定性数值冲突（跨章一致性冲突/工序规格冲突）不在此重复包装，
    // 由 buildStandardFinalValidationIssues 在最终 finalMarkdown 上实时重跑报告，避免修复生效后旧快照
    // 仍以「跨章一致性复核」error 硬阻断导出（历史缺陷：用户环境保温层 2mm、10970㎡ 修复后旧快照残留阻断）
    (globalConsistencyIssues || []).filter(message => !/^跨章一致性冲突|^工序规格冲突/u.test(message)).slice(0, 10).map(message => ({ level: 'error' as const, severity: 'blocker' as const, category: 'fact_consistency' as const, owner: 'llm' as const, repairability: 'llm_repairable' as const, message: `跨章一致性复核：${message}`, suggestion: '跨章数值口径不一致属低级错误，必须定向修复统一口径后重新校验。' })),
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
  finalMarkdown = supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(finalMarkdown, structuredFacts), projectMaterialSummary)))), template);
  // 跨章一致性数值定点修复兜底：导出阶段用完整事实主表口径做最后一次确定性对齐，覆盖生成流程未修掉的
  // 数值冲突（finalize 口径与生成阶段 preliminaryFactsModel 可能不同）；“检测定位=修复定位”，
  // 修复后重建 finalMarkdown 再进入最终校验，避免残留冲突被导出门禁硬阻断
  const finalDeterministicFix = applyDeterministicConsistencyFixes(finalChapterDrafts, factsModel, scopeConflicts);
  // 全文级定点修复探测：封面信息块/基本信息表等合成区由 facts 生成，章节修复覆盖不到；败选数值残留会
  // 被重跑检测持续拦截形成死循环（历史缺陷：用户环境建设规模败选值 10970㎡ 留在封面，修复器在章节
  // 正文找不到目标 fixedCount=0，导出门禁永久阻断）
  const needsMarkdownFix = applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts).fixedCount > 0;
  if (finalDeterministicFix.fixedCount > 0 || needsMarkdownFix) {
    finalMarkdown = supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template);
    const postRebuildFix = applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts);
    if (postRebuildFix.fixedCount > 0) finalMarkdown = postRebuildFix.markdown;
    const totalFixed = finalDeterministicFix.fixedCount + postRebuildFix.fixedCount;
    const totalDetails = [...new Set([...finalDeterministicFix.details, ...postRebuildFix.details])];
    // 修复案例落盘（数据而非代码）：只追加、不参与生成决策，供事后复盘检测器覆盖盲区；失败静默不影响主链路
    recordDeterministicFixCases(totalDetails.map(detail => ({ caseType: 'deterministic_fix', recordedAt: Date.now(), fixName: 'applyDeterministicConsistencyFixes', detail })));
    upsertProgressStage(executionStages, displayStage({ type: 'validation', roleId: 'deterministic-consistency-fix', status: 'success', message: `跨章一致性数值定点修复：${totalFixed} 处（${totalDetails.slice(0, 4).join('、')}）`, details: totalDetails.slice(4) }, { subtitle: '跨章一致性修复' }));
  }

  const canonicalFacts = buildCanonicalFacts({ facts: structuredFacts, markdown: finalMarkdown });
  if (canonicalFacts.size > 0) executionStages.push({ type: 'fact_extraction', roleId: 'canonical-facts', status: 'success', message: `已决策可信基础事实 ${canonicalFacts.size} 项`, details: [...canonicalFacts.values()].map(fact => `${fact.label}=${fact.value}（${fact.source}，confidence=${fact.confidence}）`).slice(0, 12) });

  // Final Gate 修复后重算问题组会重新计算，修复基线只保留基础累计问题，避免重复累加
  const baseValidationIssues = validationIssues;
  validationIssues = buildFullValidationIssues({ documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget, scopeConflicts, evaluationCriteriaItems });

  let qualityBundle = buildQualityReportBundle({ finalChapterDrafts, effectiveChapters, factsModel, allEvidence, finalMarkdown, validationIssues, retrievalCoverageReports, includeRetrievalCoverage: true, template });
  let { knowledgeCoverage, factTraces, chapterCoverage, qualityReport, repairStrategies, finalExportGate } = qualityBundle;
  validationIssues = qualityBundle.validationIssues;
  const finalGateRepairStages: DocumentExecutionStage[] = [];
  // Final Gate 修复循环：每轮重算 error 级结构缺陷候选并补写（每轮最多 4 个），补写后重算校验组；
  // 最多 3 轮，避免“候选超限残留 error 直接阻断”（历史缺陷：6 个深度不足 error 只修 4 个，剩余 2 个让整篇生成失败）
  const repairedSectionKeys = new Set<string>();
  // 修复后重算校验组（Final Gate 循环内与循环后共用）：过滤已修复小节的旧快照 issue 与事实落位快照，
  // 用最新 finalMarkdown 重算全部校验组与导出门禁
  const recomputeFinalValidationBundle = () => {
    const repairedValidationBase = baseValidationIssues.filter(issue => ![...repairedSectionKeys].some(key => {
      const [chapterTitle, sectionTitle] = key.split('::');
      return isRepairedSectionIssue(issue.message, chapterTitle, sectionTitle);
    })
    // 事实落位警告是预算稿快照（Final Gate 修复前的章节草稿拼接），修复后的重算会用最新 finalMarkdown 重新生成，
    // 旧快照必须丢弃：否则已落位的事实（如基本信息表中的招标人）会带着修复前的警告进入最终交付。
    && !/已确认事实未在正文中落位/u.test(issue.message));
    validationIssues = buildFullValidationIssues({ documentSpec, validationIssues: repairedValidationBase, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget, scopeConflicts, evaluationCriteriaItems });
    qualityBundle = buildQualityReportBundle({ finalChapterDrafts, effectiveChapters, factsModel, allEvidence, finalMarkdown, validationIssues, retrievalCoverageReports, includeRetrievalCoverage: false, template });
    ({ knowledgeCoverage, factTraces, chapterCoverage, qualityReport, repairStrategies, finalExportGate } = qualityBundle);
    validationIssues = qualityBundle.validationIssues;
  };
  for (let finalGateRepairRound = 0; finalGateRepairRound < 3; finalGateRepairRound += 1) {
    // 修复口径：Final Gate 只修 error 级结构缺陷（空小节/缺失小节/深度不足），warning 建议类告警一律不进入修复循环，
    // 避免“建议补写→重算仍告警”的永不收敛修复空转；事实安全/污染类 error 由导出门禁阻断，不在此补写
    const finalGateRepairCandidates = [
      ...finalExportGate.blockingIssues,
      ...validationIssues.filter(issue => issue.level === 'error'),
    ];
    const emptySectionIssues = Array.from(new Map(finalGateRepairCandidates
      .map(issue => parseFinalGateRepairCandidate(issue))
      .filter((item): item is { issue: ValidationIssue; chapterTitle: string; sectionTitle: string; critical: boolean } => Boolean(item))
      .map(item => [`${item.chapterTitle}::${item.sectionTitle}`, item])).values())
      .sort((a, b) => Number(b.critical) - Number(a.critical))
      .slice(0, 4);
    if (emptySectionIssues.length === 0) break;
    const repairDetails: string[] = [];
    for (const { issue, chapterTitle: parsedChapterTitle, sectionTitle } of emptySectionIssues) {
      let chapterTitle = parsedChapterTitle;
      let chapterIndex = chapterTitle ? finalChapterDrafts.findIndex(chapter => chapter.title === chapterTitle || chapterTitle.includes(chapter.title) || chapter.title.includes(chapterTitle)) : -1;
      if (chapterIndex < 0) {
        chapterIndex = finalChapterDrafts.findIndex(chapter => (chapter.content || '').includes(sectionTitle));
      }
      if (chapterIndex < 0) {
        // 小节完全缺失（正文中无标题）：按模板计划小节定位章节，保证“缺少‘XXX’小节”类问题能进入补写
        chapterIndex = finalChapterDrafts.findIndex(chapter => {
          const plannedSections = effectiveChapters.find(item => item.id === chapter.id || item.title === chapter.title)?.sections || [];
          return plannedSections.some(section => section.includes(sectionTitle) || sectionTitle.includes(section));
        });
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
        allowLenientStructureGate: true,
      }));
      let repaired = false;
      // 深度不足类修复必须达到关键小节 blocker 字数才允许替换：防止把原本更长的正文换成更短的补写稿，
      // 导致修复轮次被浪费在无效替换上（曾出现 1800+ 字小节被换成 1200 字稿后仍不足 1760 的倒退）
      const depthAcceptMinChars = /正文不足|缺少[“"'].+[”"']小节|小节缺失或标题结构异常/u.test(issue.message) ? criticalMinChars : 0;
      if (generated && documentTextLength(generated) >= (depthAcceptMinChars || 80)) {
        // “小节缺失或标题结构异常”必须按标准 ### 结构追加修复：可比标题若命中 H4 级承接块（如主题块成稿的
        // “#### 2.5.1 主要分部分项工程施工方案”），原地替换会造成 ### 结构要求与 #### 标题层级倒置，
        // 校验器精确定位持续落空、修复永不收敛；统一追加“### 标准锚点”小节
        const forceAppend = /小节缺失或标题结构异常/u.test(issue.message);
        const nextContent = forceAppend ? draftChapter.content : replaceMarkdownSection(draftChapter.content, sectionTitle, generated);
        repaired = !forceAppend && nextContent !== draftChapter.content;
        if (!repaired && (forceAppend || /(?:缺少规划小节|缺少[“"'].+[”"']小节)/u.test(issue.message))) {
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
        const generatedChars = documentTextLength(generated || '');
        repairDetails.push(`失败：${chapterTitle}/${sectionTitle}（${generatedChars > 0 && generatedChars < (depthAcceptMinChars || 80) ? `补写仅 ${generatedChars} 字，未达 ${depthAcceptMinChars || 80} 字验收线` : generationDiagnostics.llm.lastError || '空响应'}）`);
      }
      const completedRepairStage = displayStage({ type: 'llm_review', roleId: `agent-final-gate-repair-${draftChapter.id}`, status: repaired ? 'success' : 'failed', message: repaired ? `Final Gate 空小节修复完成：${chapterTitle} / ${sectionTitle}` : `Final Gate 空小节修复失败：${chapterTitle} / ${sectionTitle}`, details: repairDetails }, { subtitle: 'Final Gate Repair' });
      upsertProgressStage(progressStages, completedRepairStage);
      upsertProgressStage(finalGateRepairStages, completedRepairStage);
      emitProgress(finalChapterDrafts, progressStages);
    }
    finalMarkdown = supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template);
    recomputeFinalValidationBundle();
  }
  // Final Gate 补写小节由 LLM 生成，可能引入新的跨章数值冲突（生成阶段修复闭环不覆盖补写内容）：
  // 导出前做最后一次确定性定点修复，修复后重建 finalMarkdown 并重算校验组，避免补写残留冲突被导出门禁硬阻断
  const postFinalGateFix = applyDeterministicConsistencyFixes(finalChapterDrafts, factsModel, scopeConflicts);
  // 全文级定点修复同 finalize 入口处：封面/信息表合成区的败选数值章节修复覆盖不到，必须同步修复
  const needsPostGateMarkdownFix = applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts).fixedCount > 0;
  if (postFinalGateFix.fixedCount > 0 || needsPostGateMarkdownFix) {
    finalMarkdown = supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template);
    const postRebuildMarkdownFix = applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts);
    if (postRebuildMarkdownFix.fixedCount > 0) finalMarkdown = postRebuildMarkdownFix.markdown;
    recomputeFinalValidationBundle();
    const totalFixed = postFinalGateFix.fixedCount + postRebuildMarkdownFix.fixedCount;
    const totalDetails = [...new Set([...postFinalGateFix.details, ...postRebuildMarkdownFix.details])];
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'deterministic-consistency-fix', status: 'success', message: `跨章一致性数值定点修复：${totalFixed} 处（${totalDetails.slice(0, 4).join('、')}）`, details: totalDetails.slice(4) }, { subtitle: '跨章一致性修复' }));
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
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-diagnostics', status: 'success', message: `性能统计：LLM ${generationDiagnostics.llm.calls} 次，失败 ${generationDiagnostics.llm.failures} 次，瞬态重试 ${generationDiagnostics.llm.retries} 次，schema 校验失败 ${generationDiagnostics.llm.schemaFailures} 次，峰值并行 ${generationDiagnostics.llm.maxActive}，检索 ${generationDiagnostics.evidence.searchQueries} 次/${Math.round(generationDiagnostics.evidence.searchMs / 1000)} 秒，证据上下文 ${generationDiagnostics.evidence.contextChars} 字，噪声过滤 ${generationDiagnostics.evidence.filteredNoise} 条，预算裁剪 ${generationDiagnostics.evidence.budgetDropped} 条，质量问题 阻断${generationDiagnostics.quality.blockingCount}/重要${generationDiagnostics.quality.importantCount}/轻微${generationDiagnostics.quality.minorCount}${slowMetrics ? `，Top耗时：${slowMetrics}` : ''}` }, { subtitle: '后台诊断' }));

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
