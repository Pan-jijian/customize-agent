import type { AgentWorkflowContext } from './agentWorkflow';
import type { DocumentAsset, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, GeneratedDocumentDraft, NumericScopeConflict, RetrievalCoverageReport, TenderRequirementModel, ValidationIssue, WritingTaskBrief } from './types';
import type { FactTokenScopeClassifier } from './factTokenClassifier';
import type { ProfessionalDepthClassifier } from './professionalDepthClassifier';
import type { ProjectMaterialScope } from './projectMaterialScope';
import { assertEvidenceInProjectScope, filterEvidenceByProjectScope, filterFactsByProjectScope, projectScopeAudit, sourceInProjectScope } from './projectMaterialScope';
import { selectEvidenceByBudget } from './evidence';
import { validateDraftWithAutoSpec } from '../document-validation/documentValidationService';
import { validateProjectContamination } from '../document-validation/documentContaminationService';
import { chapterReadinessIssues, evaluateChapterReadiness } from '../document-validation/chapterReadinessService';
import { validateFactConsistency } from '../document-validation/factConsistencyService';
import { cleanFormalSourcePhrases, composeDocumentMarkdown, finalizeDocumentMarkdown, normalizeTertiaryHeadings, plannedStructureIssues, sanitizeFormalMarkdown, SOURCE_ENUMERATION_PHRASE_RE } from './markdownComposer';
import { documentBudgetIssues, documentTextLength, pageTargetIssues } from './budget';
import { applySpecGateRules, autoSpecGateRequiredTexts, buildExportGate, qualitySeveritySummary, applyDeterministicConsistencyFixes, applyDeterministicConsistencyFixesToMarkdown, internalTerminologyIssues, markdownTableQualityIssues } from './qualityValidation';
import { buildStandardFinalValidationIssues } from './documentFinalValidation';
import { buildDocumentProfileReport } from './documentProfiles';
import { buildKnowledgeCoverageReport, knowledgeCoverageIssues } from './documentKnowledgeCoverage';
import { buildDocumentFactTraces, factTraceIssues } from './documentFactTrace';
import { buildChapterCoverageReports, chapterCoverageIssues } from './documentChapterCoverage';
import { buildDocumentQualityReport, qualityReportIssues } from './documentQualityReport';
import { benchmarkGeneratedMarkdown } from './benchmarkQuality';
import { buildRepairStrategies, repairStrategyIssues } from './documentRepairStrategies';
import { repairChapterByQuality } from './rolePipeline';
import { buildDocumentReviewChecklist } from './documentReviewChecklist';
import { collectValidationIssueGroups } from './documentQualityPipeline';
import { DOCUMENT_WORKFLOW_VERSION } from './documentWorkflowVersion';
import { buildDocumentTelemetryReport } from './documentTelemetry';
import { retrievalCoverageIssues } from './documentEvidenceRetrieval';
import { extractFacts, extractFactsWithLlm, extractPreciseFactsFromEvidence, extractProjectBasicFactsFromEvidence, extractStructuredFacts, extractStructuredTables, buildFactsModel, shouldRunLlmFactExtraction } from './factsModel';
import { applyScopeConflictResolutions, buildCanonicalFacts, detectNumericScopeConflicts } from './factGovernance';
import { comparableSectionHeadingMatches, extractSection, stringifyFactValue, throwIfAborted, WORK_PACKAGE_SECTION_RE } from './utils';
import { formalTextGateIssues } from './agentWorkflow';
import { displayStage, upsertProgressStage } from './progress';
import { buildLlmSectionContent, buildValidationIssues, criticalSectionBlockerMinChars } from './chapterGeneration';
import { chapterSectionFactUsageIssues } from './chapterReview';
import { factCoverageIssues, factsWithEvidenceSource, criticalSectionBlockerLine, finalizeChapterContentQuality, finalizeFinalMarkdownStructure, normalizeProjectBasicInfoTable, partialChapterStatus, projectBasicPlaceholderIssues, slowMetricSummary, uncoveredImportantFacts, validateDraft } from './documentGeneratorHelpers';
import { constructionOrgProfessionalAuditIssues } from './constructionOrgAudit';
import { buildProfessionalScoreReport } from './documentProfessionalScore';
import { recordDeterministicFixCases } from './workflowCaseLog';
import { buildTemplateSimilarityReport } from './templateSimilarity';
import { referenceBenchmarkForType, referenceTextSlicesForType } from './templateReferenceService';
import { suggestProjectType } from './referenceQualityProfile';
import { reviewTemplatingSemantics } from './templatingReview';

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
  const comparableMatches = (headingTitle: string) => comparableSectionHeadingMatches(headingTitle, sectionTitle);
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
    // 反向包含（sectionTitle.includes(headingTitle)）不做：“主要施工方法”.includes(“施工方法”)会把
    // “#### 施工方法”H4 块误当目标小节，4600 字补写稿被替换进错误位置且标题被剥离后丢失（九度实测缺陷）
    const exactMatch = headingTitle === sectionTitle || headingTitle.includes(sectionTitle);
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

/** Final Gate 补写 qualityFeedback：工作包型小节注入三段式标签硬性要求（八度实测缺陷：补写稿无标签被专项验收器阻断） */
export function buildFinalGateRepairQualityFeedback(sectionTitle: string, lastFailure?: string): string {
  const workPackageQualityFeedback = WORK_PACKAGE_SECTION_RE.test(sectionTitle)
    ? `该小节按专业工程/分项工程方案组织，每个 #### 分项方案必须按“施工概况（作业对象、部位、工程量）”“施工流程（“→”箭头串联工序链）”“施工方法（工具机具、材料规格、工艺参数、验收标准）”三段展开，“施工概况”“施工流程”“施工方法”三个标签必须在每个分项方案正文中逐字出现。标签形态要求：三个标签必须写成纯文本行首形态（如“施工概况：”），严禁粗体包裹（**施工概况**：）或重复前缀（施工概况：**施工概况**：）。每个分项方案的施工流程段至少 1 条不少于 4 个环节的“→”工序链（如“基层清理→放线定位→分层施工→养护→验收”），施工方法段内也必须包含一条工序链。每个分项方案至少 4 个带单位工艺参数，小分项（拆除、门窗维修、立面修补等）同样必须写足，参数类型参考：拆除面积㎡、垃圾外运量t、外运距离km、日拆除进度㎡/天、更换数量樘、启闭力N、胶缝宽度mm、安装偏差mm。`
    : '';
  return `Final Gate 发现“${sectionTitle}”为空小节或深度不足。请基于证据完整重写该小节正式正文（原小节内容将被整体替换），包含检查责任、验收节点、资料闭环、整改复验要求，优先落位项目建筑面积、层数、工期、专业范围等量化参数，不得输出占位或解释。${workPackageQualityFeedback}${lastFailure ? `此前生成被拒原因：${lastFailure}，必须逐条修正。` : ''}`;
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
  // 全文级缺失消息无章节前缀（“施工组织设计缺少"项目主要施工内容"小节”）：Final Gate 追加修复后，
  // 旧快照 error 无法按“章节+小节”双包含过滤而残留（十度实测：修复成功仍白扣 8 分交付置信度），
  // 无章节前缀形态按小节标题单包含即视为旧快照丢弃
  if (/缺少[“"'][^”"']+[”"']小节/u.test(issueMessage) && issueMessage.includes(sectionTitle)) return true;
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
  // 最终组装不再逐章跑 finalizeChapterContentQuality：补跑重复 H4 去重 + 空壳小节删除兜底（与成稿阶段同口径）
  return finalizeFinalMarkdownStructure(finalizeDocumentMarkdown(composeDocumentMarkdown({ templateId: input.template.id, templateName: input.template.name, title: input.template.outputTitle, requirement: input.requirement || '', projectRoot: input.projectRoot, projectId: input.projectId, exportSettings: input.template.exportSettings, generationSettings: input.template.generationSettings, facts: input.facts, structuredFacts: input.structuredFacts, factsModel: input.factsModel, chapters: input.chapters, sources: input.sources, missingItems: [...new Set(input.missingItems)], validation: input.validation, validationIssues: input.validationIssues, executionStages: input.executionStages, exportGate: { passed: false, blockingIssues: [], checklist: [] }, assets: input.assets, partialChapters: [], checkpointChapters: input.chapters, generatedAt: Date.now() }, { forbidDrawingImages: false, promptRules: input.promptDocumentRules }), input.chapters, { forbidDrawingImages: false, promptRules: input.promptDocumentRules }).markdown);
}

/** 核心校验组：覆盖规格门禁、事实一致性、污染、占位符、预算、结构完整性、正式文本门禁与关键小节深度/密度（首次与 Final Gate 修复后共用） */
async function buildFullValidationIssues(input: {
  documentSpec: any; validationIssues: ValidationIssue[]; factsModel: any; finalChapterDrafts: DocumentDraftChapter[]; finalMarkdown: string;
  template: DocumentTemplate; promptBindings: any[]; promptDocumentRules: any; projectMaterialSummary: any; domainProfile: any; structuredFacts: DocumentFact[]; documentBudget: any;
  scopeConflicts?: NumericScopeConflict[];
  evaluationCriteriaItems?: string[];
  /** 模块挂靠后的大纲（含四新等承诺小节）：承接检查必须用承诺后大纲，原始模板未挂靠时承诺检测会静默落空 */
  effectiveChapters?: DocumentTemplateChapter[];
  /** 招标文件评分项要求（LLM 结构化提取）：零响应检测锚点与交付阻断修复轮输入 */
  tenderRequirements?: TenderRequirementModel;
  /** 评分项要求↔章节语义相似度函数（本地 bge 余弦） */
  requirementsSimilarity?: (leftText: string, rightText: string) => number;
  /** 总量口径语义分类器（round-13）：事实反查口径归属语义复核 */
  factTokenScopeClassifier?: FactTokenScopeClassifier;
  /** 专业深度语义分类器（round-14）：章节专业深度/缺项/套话/闭环/依赖的语义判定 */
  professionalDepthClassifier?: ProfessionalDepthClassifier;
}): Promise<ValidationIssue[]> {
  const { documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget, scopeConflicts, evaluationCriteriaItems, effectiveChapters, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier } = input;
  return collectValidationIssueGroups(
    applySpecGateRules(documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template.projectBindings || [], promptBindings),
    validateDraftWithAutoSpec({ markdown: finalMarkdown, spec: documentSpec, summary: projectMaterialSummary }),
    validateFactConsistency({ markdown: finalMarkdown, facts: structuredFacts, summary: projectMaterialSummary, profile: domainProfile }),
    validateProjectContamination(finalMarkdown, projectMaterialSummary),
    projectBasicPlaceholderIssues(finalMarkdown, structuredFacts),
    await buildStandardFinalValidationIssues({ markdown: finalMarkdown, chapters: finalChapterDrafts, factsModel, template, promptBindings, promptDocumentRules, scopeConflicts, evaluationCriteriaItems, effectiveChapters, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier }),
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
  // 可落地性目标基准：参考库同类工程完整五要素块均值（人工样本实测画像），
  // 替代“每 1500 字 1 块”的历史目标（十度实测：10 万字文档需 68 块，人工样本天花板仅 16 块，目标失真导致可落地性 59 分）
  const referenceCompleteBlocks = referenceBenchmarkForType(suggestProjectType(finalMarkdown))?.profile.fiveElementCompleteBlocks;
  const qualityReport = buildDocumentQualityReport({ markdown: finalMarkdown, chapters: finalChapterDrafts, issues, knowledgeCoverage, factTraces, template, referenceCompleteBlocks });
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
  /** 招标文件评分项要求（LLM 结构化提取产物）：零响应检测锚点 + 交付阻断修复轮输入 */
  tenderRequirements?: TenderRequirementModel;
  /** 评分项要求↔章节语义相似度函数（本地 bge 余弦，生成前预构建后随 p 传递复用） */
  requirementsSimilarity?: (leftText: string, rightText: string) => number;
  /** 总量口径语义分类器（round-13，生成前预构建）：事实反查口径归属语义复核，不可用时降级近邻窗口正则门控 */
  factTokenScopeClassifier?: FactTokenScopeClassifier;
  /** 专业深度语义分类器（round-14，生成前预构建）：章节专业深度/缺项/套话/闭环/依赖语义判定，不可用时静默跳过（零误伤） */
  professionalDepthClassifier?: ProfessionalDepthClassifier;
  emitProgress: (c?: DocumentDraftChapter[], s?: DocumentExecutionStage[]) => void;
  withProgressHeartbeat: <T>(w: () => Promise<T>, s?: DocumentExecutionStage[]) => Promise<T>;
}): Promise<GeneratedDocumentDraft> {
  const {
    chapterDraftsByOrder, chapterGenerationStagesByOrder, chapterGenerationStages, effectiveChapters, template, allEvidence, projectMaterialScope,
    progressStages, documentSpec, projectMaterialSummary, domainProfile, documentBudget,
    input, generationDiagnostics, promptTexts, promptBindings, promptDocumentRules, projectRoot, projectId, readiness,
    factExtractionPromptTexts, hasExplicitOutline, missingItems, retrievalCoverageReports, failedChapterMessages,
    webResearchReport, indexHealth, agentWorkflow, globalConsistencyIssues, scopeConflicts, writingTaskBrief, evaluationCriteriaItems, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier, emitProgress, withProgressHeartbeat,
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
  // chapterGenerationStages 是各章成稿的最终版 stage（success/failed），progressStages 里还残留同 identity 的
  // running 版（主题块并发成稿中间态）；直接数组拼接会让同名 stage 成对出现，running 态永久残留在前端节点图
  //（十四度实测：3 章 chapter_generation 同时出现 running 与 success 两份）
  const mergedProgressStages = [...progressStages];
  for (const stage of chapterGenerationStages) upsertProgressStage(mergedProgressStages, stage);
  const executionStages: DocumentExecutionStage[] = throttleExecutionStages(mergedProgressStages);
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
  finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(finalMarkdown, structuredFacts), projectMaterialSummary)))), template));
  // 跨章一致性数值定点修复兜底：导出阶段用完整事实主表口径做最后一次确定性对齐，覆盖生成流程未修掉的
  // 数值冲突（finalize 口径与生成阶段 preliminaryFactsModel 可能不同）；“检测定位=修复定位”，
  // 修复后重建 finalMarkdown 再进入最终校验，避免残留冲突被导出门禁硬阻断
  const finalDeterministicFix = applyDeterministicConsistencyFixes(finalChapterDrafts, factsModel, scopeConflicts);
  // 全文级定点修复探测：封面信息块/基本信息表等合成区由 facts 生成，章节修复覆盖不到；败选数值残留会
  // 被重跑检测持续拦截形成死循环（历史缺陷：用户环境建设规模败选值 10970㎡ 留在封面，修复器在章节
  // 正文找不到目标 fixedCount=0，导出门禁永久阻断）
  const needsMarkdownFix = applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts).fixedCount > 0;
  if (finalDeterministicFix.fixedCount > 0 || needsMarkdownFix) {
    finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
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
  validationIssues = await buildFullValidationIssues({ documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget, scopeConflicts, evaluationCriteriaItems, effectiveChapters, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier });

  let qualityBundle = buildQualityReportBundle({ finalChapterDrafts, effectiveChapters, factsModel, allEvidence, finalMarkdown, validationIssues, retrievalCoverageReports, includeRetrievalCoverage: true, template });
  let { knowledgeCoverage, factTraces, chapterCoverage, qualityReport, repairStrategies, finalExportGate } = qualityBundle;
  validationIssues = qualityBundle.validationIssues;
  const finalGateRepairStages: DocumentExecutionStage[] = [];
  // Final Gate 修复循环：每轮重算 error 级结构缺陷候选并补写（每轮最多 4 个），补写后重算校验组；
  // 最多 3 轮，避免“候选超限残留 error 直接阻断”（历史缺陷：6 个深度不足 error 只修 4 个，剩余 2 个让整篇生成失败）
  const repairedSectionKeys = new Set<string>();
  // 修复后重算校验组（Final Gate 循环内与循环后共用）：过滤已修复小节的旧快照 issue 与事实落位快照，
  // 用最新 finalMarkdown 重算全部校验组与导出门禁
  const recomputeFinalValidationBundle = async () => {
    const repairedValidationBase = baseValidationIssues.filter(issue => ![...repairedSectionKeys].some(key => {
      const [chapterTitle, sectionTitle] = key.split('::');
      return isRepairedSectionIssue(issue.message, chapterTitle, sectionTitle);
    })
    // 事实落位警告是预算稿快照（Final Gate 修复前的章节草稿拼接），修复后的重算会用最新 finalMarkdown 重新生成，
    // 旧快照必须丢弃：否则已落位的事实（如基本信息表中的招标人）会带着修复前的警告进入最终交付。
    && !/已确认事实未在正文中落位/u.test(issue.message));
    validationIssues = await buildFullValidationIssues({ documentSpec, validationIssues: repairedValidationBase, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget, scopeConflicts, evaluationCriteriaItems, effectiveChapters, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier });
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
      // 工作包型小节（主要施工内容/分部分项方案/主要施工方法）补写必须带三段式标签硬性要求：
      // 历史缺陷：八度实测 Final Gate 补写“主要分部分项工程施工方案”通篇无“施工概况/施工流程/施工方法”标签，
      // 分部分项专项验收器判定 9 个分项缺三段式+缺箭头工序链，3 轮补写全部不达标，导出门禁 2 个 blocker 残留导致生成失败
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
        qualityFeedback: buildFinalGateRepairQualityFeedback(sectionTitle, lastFailure),
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
    finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
    await recomputeFinalValidationBundle();
  }
  // 重要事实落位补写轮（P1-3）：结构缺陷修复收敛后，若项目基础字段类硬数据仍未落位（建筑面积、标段数、编号、工期等），
  // 按事实标签映射目标章节做一轮定向 patch 落位（保持数值口径，不新增小节、不改表头结构）。
  // 十度实测缺陷：建设规模“建筑面积约为4646㎡”、招标范围“本项目分为1个标段”未落位直达交付（针对性维度 68 分）
  const importantUnplacedFacts = uncoveredImportantFacts(finalMarkdown, [...structuredFacts, ...factsModel.preciseFacts], { maxItems: 10 });
  if (importantUnplacedFacts.length > 0) {
    // 标签→章节关键词映射：项目基础字段 → 概况/基本信息章；工期 → 进度部署章；质量 → 质量章；危大安全 → 安全章；资源材料机械 → 资源投入章
    const factChapterMatchers: Array<[RegExp, RegExp]> = [
      [/项目名称|工程名称|项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|施工范围/u, /概况|基本信息|概述|总述|简介/u],
      [/计划工期|合同工期/u, /工期|进度|施工部署|总体部署|流水/u],
      [/质量标准|质量目标/u, /质量/u],
      [/危大|安全/u, /安全/u],
      [/资源|材料|机械|设备|机具/u, /资源|投入|物资|机械|设备|机具|周转/u],
    ];
    const chapterFactGroups = new Map<string, Array<{ label: string; value: string }>>();
    const unmatchedFacts: string[] = [];
    for (const item of importantUnplacedFacts) {
      const matcher = factChapterMatchers.find(([labelRe]) => labelRe.test(item.label));
      const targetChapter = matcher ? finalChapterDrafts.find(chapter => matcher[1].test(chapter.title)) : undefined;
      if (!targetChapter) {
        unmatchedFacts.push(`${item.label}=${item.value}`);
        continue;
      }
      const group = chapterFactGroups.get(targetChapter.id) || [];
      group.push({ label: item.label, value: item.value });
      chapterFactGroups.set(targetChapter.id, group);
    }
    let factLandingPatches = 0;
    for (const [chapterId, factsGroup] of chapterFactGroups) {
      const chapterIndex = finalChapterDrafts.findIndex(chapter => chapter.id === chapterId);
      if (chapterIndex < 0) continue;
      const draftChapter = finalChapterDrafts[chapterIndex];
      const templateChapter = effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title);
      const runningStage = displayStage({ type: 'llm_review', roleId: `agent-fact-landing-${chapterId}`, status: 'running', message: `正在落位 ${factsGroup.length} 条重要事实：${draftChapter.title}`, details: [...factsGroup.map(item => `${item.label}=${item.value}`), ...unmatchedFacts.map(item => `跳过：${item}（无匹配章节）`)] }, { subtitle: '事实落位修复' });
      upsertProgressStage(progressStages, runningStage);
      upsertProgressStage(finalGateRepairStages, runningStage);
      emitProgress(finalChapterDrafts, progressStages);
      const factLandingInstruction = [
        '【事实落位定向修复】',
        '下列资料事实是项目硬数据，当前正文未出现。请逐条定位到本章最合适的位置（项目概况引导段、项目基本信息表对应行或对应小节），以局部 patch 方式自然写入，保持原始数值、单位与表述口径，不得改写、换算或编造。',
        '不得新增、删除或合并小节；表格内补充必须保持表头结构不变；只修改与落位事实直接相关的局部文本。',
        factsGroup.map(item => `- ${item.label}＝${item.value}`).join('\n'),
      ].join('\n');
      const repairedFact = await withProgressHeartbeat(() => repairChapterByQuality({
        template,
        chapter: { id: draftChapter.id, title: draftChapter.title, content: draftChapter.content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
        issues: factsGroup.map(item => `已确认事实未在正文中落位：${item.label}=${item.value}`),
        promptTexts: factLandingInstruction,
        requirement,
        forbidDrawingImages: false,
        diagnostics: generationDiagnostics,
        signal,
      }));
      if (repairedFact.content && repairedFact.content !== draftChapter.content) {
        finalChapterDrafts[chapterIndex] = { ...draftChapter, content: templateChapter ? finalizeChapterContentQuality(repairedFact.content, templateChapter) : repairedFact.content };
        factLandingPatches += repairedFact.appliedCount;
      }
      const completedStage = displayStage({ type: 'llm_review', roleId: `agent-fact-landing-${chapterId}`, status: repairedFact.appliedCount > 0 ? 'success' : 'failed', message: repairedFact.appliedCount > 0 ? `重要事实落位完成：${draftChapter.title}（${repairedFact.appliedCount} 处 patch）` : `重要事实落位未生效：${draftChapter.title}`, details: factsGroup.map(item => `${item.label}=${item.value}`) }, { subtitle: '事实落位修复' });
      upsertProgressStage(progressStages, completedStage);
      upsertProgressStage(finalGateRepairStages, completedStage);
      emitProgress(finalChapterDrafts, progressStages);
    }
    if (factLandingPatches > 0) {
      finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
      await recomputeFinalValidationBundle();
    }
  }
  // 表格数据完整性修复轮（T1-2）：空单元格/占位符/列数不一致等表格 error 硬阻断导出（十度实测缺陷：
  // 竣工清理计划表末列为空、临时用电表“—/若干/约82kW”占位），按缺陷表头锚点定位章节后 patch 式修复
  const tableDefectIssues = markdownTableQualityIssues(finalMarkdown).filter(issue => issue.level === 'error' && /空单元格|占位符单元格|列数不一致/u.test(issue.message)).slice(0, 3);
  if (tableDefectIssues.length > 0) {
    let tableFixPatches = 0;
    for (const issue of tableDefectIssues) {
      // 表头第一列作为表格锚点（表名或首个业务列），在章节草稿中定位包含该表格的章节
      const tableAnchor = (issue.message.split('：')[1] || '').split('（')[0]?.split('、')[0] || '';
      const chapterIndex = tableAnchor ? finalChapterDrafts.findIndex(chapter => (chapter.content || '').includes(tableAnchor)) : -1;
      if (chapterIndex < 0) continue;
      const draftChapter = finalChapterDrafts[chapterIndex];
      const templateChapter = effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title);
      const runningStage = displayStage({ type: 'llm_review', roleId: `agent-table-fix-${draftChapter.id}`, status: 'running', message: `正在修复表格数据缺失：${draftChapter.title}`, details: [issue.message] }, { subtitle: '表格数据修复' });
      upsertProgressStage(progressStages, runningStage);
      upsertProgressStage(finalGateRepairStages, runningStage);
      emitProgress(finalChapterDrafts, progressStages);
      const tableFixInstruction = [
        '【表格数据完整性定向修复】',
        '下列表格存在数据缺失缺陷：正式交付文档的表格不得出现空单元格，也不得用“—/若干/约/待定”等占位或模糊表达代替具体数据。',
        '请以局部 patch 方式修复该表格：每一列都必须有具体数据值。数据优先取自本章正文与证据摘要；正文与证据未直接给出时，按施工组织设计专业惯例给出具体数值或明确口径（如按班组工具配置估算台数），并保持数值单位一致、行列表头对齐。',
        '合计/小计/总计/累计行的“—”可按行业惯例保留为“不适用”语义；其余单元格一律不得为空、不得用占位符。',
        '保持表头结构与列数不变，不得新增、删除或合并小节；只修改缺陷表格相关局部文本。',
      ].join('\n');
      const repairedTable = await withProgressHeartbeat(() => repairChapterByQuality({
        template,
        chapter: { id: draftChapter.id, title: draftChapter.title, content: draftChapter.content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
        issues: [issue.message, issue.suggestion || ''],
        promptTexts: tableFixInstruction,
        requirement,
        forbidDrawingImages: false,
        diagnostics: generationDiagnostics,
        signal,
      }));
      if (repairedTable.content && repairedTable.content !== draftChapter.content) {
        finalChapterDrafts[chapterIndex] = { ...draftChapter, content: templateChapter ? finalizeChapterContentQuality(repairedTable.content, templateChapter) : repairedTable.content };
        tableFixPatches += repairedTable.appliedCount;
      }
      const completedTableStage = displayStage({ type: 'llm_review', roleId: `agent-table-fix-${draftChapter.id}`, status: repairedTable.appliedCount > 0 ? 'success' : 'failed', message: repairedTable.appliedCount > 0 ? `表格数据修复完成：${draftChapter.title}（${repairedTable.appliedCount} 处 patch）` : `表格数据修复未生效：${draftChapter.title}`, details: [issue.message] }, { subtitle: '表格数据修复' });
      upsertProgressStage(progressStages, completedTableStage);
      upsertProgressStage(finalGateRepairStages, completedTableStage);
      emitProgress(finalChapterDrafts, progressStages);
    }
    if (tableFixPatches > 0) {
      finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
      await recomputeFinalValidationBundle();
    }
  }
  // 交付阻断定向修复轮（round-12/13）：表格缺陷轮之外的内容级 error 此前只进导出门禁或评分扣减，从不进修复循环
  // （十一度实测：资料来源罗列话术 L70 永不修复、后台术语“工作包”10 处残留、主要施工内容 H4 层级误报缺失；
  //  round-13 扩展：评分项要求零响应/自伤表述/编造日期/字段错配/面积算术矛盾/劳动力矛盾/支护并存/危大清单不一致/六个百分百未逐项）。
  // 按消息特征定位章节后 patch 式修复（上限 4 条），修复后重建 finalMarkdown 并重算校验组
  const blockerContentIssues = validationIssues.filter(issue => issue.level === 'error' && /资料来源罗列话术|后台内部术语|生成后事实反查失败|主要施工内容|评分项要求未响应|自伤表述候选|正文编造开工日期|字段-数值错配|面积算术矛盾|劳动力数据矛盾|基坑支护方案前后不一致|危大工程辨识清单不一致|扬尘治理六个百分百/u.test(issue.message)).slice(0, 4);
  if (blockerContentIssues.length > 0) {
    let blockerFixPatches = 0;
    const normalizedBody = (chapter: DocumentDraftChapter) => (chapter.content || '').replace(/[\s,，]/gu, '');
    for (const issue of blockerContentIssues) {
      const locateChapterIndex = (message: string): number => {
        if (/资料来源罗列话术/u.test(message)) return finalChapterDrafts.findIndex(chapter => SOURCE_ENUMERATION_PHRASE_RE.test(chapter.content || ''));
        if (/后台内部术语/u.test(message)) return finalChapterDrafts.findIndex(chapter => (chapter.content || '').includes('工作包'));
        if (/生成后事实反查失败/u.test(message)) {
          const tokenPart = (message.split('数字')[1] || '').trim();
          return tokenPart ? finalChapterDrafts.findIndex(chapter => tokenPart.split(/[、,，\s]+/u).some(token => token && (chapter.content || '').includes(token))) : -1;
        }
        if (/主要施工内容/u.test(message)) {
          return finalChapterDrafts.findIndex(chapter => /项目主要施工内容|主要施工内容/u.test(`${chapter.title} ${(chapter.sections || []).join(' ')}`) || /^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?(?:项目)?主要施工\s*内容/gmu.test(chapter.content || ''));
        }
        // round-13 新增：招标要求层与数据一致性层的定向定位（提取消息中的关键短语/数值在章节中反查）
        if (/评分项要求未响应/u.test(message)) {
          const terms = (/核心词：([^）)]*)/u.exec(message)?.[1] || '').split(/[、/,，/\s]+/u).filter(term => term.length >= 2);
          const byTerms = finalChapterDrafts.findIndex(chapter => terms.some(term => normalizedBody(chapter).includes(term)));
          if (byTerms >= 0) return byTerms;
          const qualityChapter = finalChapterDrafts.findIndex(chapter => /质量目标|创优|质量保证|绿色施工|文明施工/u.test(chapter.title));
          return qualityChapter >= 0 ? qualityChapter : 0;
        }
        const quoted = /“([^”]+)”/u.exec(message)?.[1]?.replace(/\s+/gu, '') || '';
        if (/自伤表述候选/u.test(message)) return quoted ? finalChapterDrafts.findIndex(chapter => normalizedBody(chapter).includes(quoted.slice(0, 12))) : -1;
        if (/正文编造开工日期/u.test(message)) return quoted ? finalChapterDrafts.findIndex(chapter => normalizedBody(chapter).includes(quoted)) : -1;
        if (/字段-数值错配|面积算术矛盾/u.test(message)) {
          const numbers = (message.match(/[\d,]+(?:\.\d+)?/gu) || []).map(token => token.replace(/[,，]/gu, '')).filter(token => token.length >= 3);
          return finalChapterDrafts.findIndex(chapter => numbers.some(token => normalizedBody(chapter).includes(token)));
        }
        if (/劳动力数据矛盾/u.test(message)) return finalChapterDrafts.findIndex(chapter => /高峰/u.test(chapter.content || ''));
        if (/基坑支护方案前后不一致/u.test(message)) return finalChapterDrafts.findIndex(chapter => /放坡|喷锚|土钉|灌注桩|排桩|基坑支护/u.test(chapter.content || ''));
        if (/危大工程辨识清单不一致/u.test(message)) return finalChapterDrafts.findIndex(chapter => /危大/u.test(`${chapter.title} ${chapter.content || ''}`));
        if (/扬尘治理六个百分百/u.test(message)) return finalChapterDrafts.findIndex(chapter => /扬尘|环保|文明施工|绿色施工/u.test(`${chapter.title} ${chapter.content || ''}`));
        return -1;
      };
      const chapterIndex = locateChapterIndex(issue.message);
      if (chapterIndex < 0) continue;
      const draftChapter = finalChapterDrafts[chapterIndex];
      const templateChapter = effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title);
      const runningStage = displayStage({ type: 'llm_review', roleId: `agent-blocker-fix-${draftChapter.id}`, status: 'running', message: `正在修复交付阻断缺陷：${draftChapter.title}`, details: [issue.message] }, { subtitle: '交付阻断修复' });
      upsertProgressStage(progressStages, runningStage);
      upsertProgressStage(finalGateRepairStages, runningStage);
      emitProgress(finalChapterDrafts, progressStages);
      const blockerFixInstruction = (() => {
        if (/资料来源罗列话术/u.test(issue.message)) return ['【资料来源罗列话术定向修复】', '该章节正文包含“根据/依据招标文件、工程量清单、施工图纸…”等资料来源罗列句，正式交付文档不得出现。', '请以局部 patch 方式删除罗列表述：直接陈述项目事实、施工内容与控制措施；句中携带的实质数据（工期、规模、金额、编号等）必须保留，改为直接陈述方式重写，不得丢失事实。只修改相关句子，不得改动其他内容。'].join('\n');
        if (/后台内部术语/u.test(issue.message)) return ['【后台内部术语定向修复】', '该章节正文包含后台内部术语（集合概念名词），正式交付文档禁止出现。', '请以局部 patch 方式将每一处该术语按上下文语义改写为专业工程正式名称（如“拆除工程”“装饰装修工程”“机电安装工程”），保持段落结构与事实数据不变，不得新增或删除小节。'].join('\n');
        if (/生成后事实反查失败/u.test(issue.message)) return ['【总量口径数字定向修复】', '该章节正文出现资料事实主表中未找到的总量口径数字。', '请以局部 patch 方式逐项核对：主表已确认的口径必须一字不改引用；无法在主表中反查到的数字一律删除或改为定性表述（如“按计划配置”“满足规范要求”），禁止编造具体数值。只修改相关数字所在句子。'].join('\n');
        // 主要施工内容类缺陷按具体类型给专属指令：结构类指令修不了污染/流程/方法类缺陷，
        // 指令与缺陷错配导致 LLM 无法产出有效 patch、修复节点 failed（十四度实测：“脏事实或标题污染”被
        // 结构修复指令处理，appliedCount=0，交付阻断修复未生效）
        if (/主要施工内容存在脏事实或标题污染/u.test(issue.message)) return ['【主要施工内容污染清理】', '该章节“主要施工内容”小节混入了项目概况复述句（本项目为…/总建筑面积…/保留现状…等）、嵌入的正文标题或伪标题。', '请以局部 patch 方式逐段清理：删除概况复述句与“未尽事宜”类说明；本小节只保留各专业工程的“施工概况：”“施工流程：”“施工方法：”正式正文；概况数据确需引用时只写与专业工程直接相关的具体数字，不复述完整概况段。只修改污染段落，不得删除已有事实数据。'].join('\n');
        if (/主要施工内容存在.*流程污染/u.test(issue.message)) return ['【专业工程流程污染清理】', '该章节“主要施工内容”小节的“施工流程”混入了项目概况、总建筑面积、招标范围、未尽事宜等说明性事实。', '请以局部 patch 方式重写被污染的“施工流程：”段：只保留“工序1→工序2→…→验收归档”的纯工序链条（每个专业工程至少 4 个环节），将混入的概况说明删除或移至“施工概况”段。'].join('\n');
        if (/主要施工内容存在.*施工方法过弱/u.test(issue.message)) return ['【专业工程施工方法强化】', '该章节部分专业工程的“施工方法”只有工程名称或范围罗列，缺少实质工艺。', '请以局部 patch 方式强化对应“施工方法：”段：写入资料已确认的工程量、材料规格、检测、调试、验收或记录要求，至少 4 个带单位工艺参数；资料未明确的参数不得编造。'].join('\n');
        if (/主要施工内容存在.*重复专业工程小节/u.test(issue.message)) return ['【专业工程重复小节合并】', '该章节“主要施工内容”存在同名或近似专业工程小节重复铺陈。', '请以局部 patch 方式合并：同一专业工程只保留一个小节，将重复小节的独有内容并入保留小节后删除冗余小节（含其标题），保留小节仍须含“施工概况：”“施工流程：”“施工方法：”三标签。'].join('\n');
        if (/主要施工内容/u.test(issue.message)) return ['【主要施工内容结构定向修复】', '该章节的主要施工内容小节结构不达标。', '请以局部 patch 方式修复：①将“项目主要施工内容”写成三级标题（### 项目主要施工内容），内部专业工程写成四级标题（#### 专业工程名称）；②同一专业工程只保留一个小节，重复小节的独有内容合并后删除冗余小节；③每个专业工程小节必须含“施工概况：”“施工流程：”“施工方法：”三个标签，施工流程至少一条不少于 4 个环节的“→”工序链，施工方法至少 4 个带单位工艺参数。不得删除已有的事实数据。'].join('\n');
        if (/评分项要求未响应/u.test(issue.message)) return ['【评分项要求定向补写】', '招标文件明确要求该评分项必须显性响应，当前正文零命中，零响应即评标失分。', '请以局部 patch 方式在该章节合适位置补写一段响应文本：逐字写明该要求原文（含核心词），并配套本项目落实措施与保证体系（组织、技术、检查、验收闭环）；不新增小节、不改动其他内容。'].join('\n');
        if (/自伤表述候选/u.test(issue.message)) return ['【自伤表述定向改写】', '该章节正文包含暴露投标短板的表述，正式投标文件不得主动示弱。', '请以局部 patch 方式将该句改写为正向落实表述（如“按施工图绿色建筑专篇编制专项方案，逐项落实评分项并跟踪验收”）；若该表述属现场条件类合理风险描述（地质/管线尚不明确），保留但必须补充勘查计划与应对措施。只修改相关句子。'].join('\n');
        if (/正文编造开工日期/u.test(issue.message)) return ['【编造开工日期定向修复】', '该章节正文出现招标资料未提供、且违反“以开工令时间为准”条款的具体日历日期。', '请以局部 patch 方式删除该具体日期，统一改写为“以开工令时间为准”；如为进度计划节点，必须标注为计划推算节点并保持与总工期一致。只修改相关句子。'].join('\n');
        if (/字段-数值错配/u.test(issue.message)) return ['【字段数值错配定向修复】', '该章节正文将总占地面积误作建筑面积（或其他相近槽位混淆）。', '请以局部 patch 方式按绑定资料口径修正该数值并保持字段标签正确：总占地面积与建筑面积必须分开表述，不得互换数值。只修改相关句子。'].join('\n');
        if (/面积算术矛盾/u.test(issue.message)) return ['【面积算术一致性定向修复】', '该章节正文同一语句内地上+地下面积之和不等于单体建筑面积。', '请以局部 patch 方式按绑定资料口径统一三者数值，使地上+地下=总/单体面积，删除错误数值表述。只修改相关句子。'].join('\n');
        if (/劳动力数据矛盾/u.test(issue.message)) return ['【劳动力口径定向修复】', '该章节正文“高峰期 X 人”与分阶段投入明细表峰值矛盾。', '请以局部 patch 方式以分阶段明细表为准统一劳动力峰值口径：正文峰值表述与表格数据必须一致，删除矛盾数字或调整表格。只修改相关句子。'].join('\n');
        if (/基坑支护方案前后不一致/u.test(issue.message)) return ['【支护体系一致性定向修复】', '该章节正文放坡喷锚类与灌注桩排桩类两套支护体系并存。', '请以局部 patch 方式统一为一种支护体系（以图纸/地质条件为准），删除另一种体系的表述，并补充基坑开挖深度数值支撑危大分级判定。只修改相关句子。'].join('\n');
        if (/危大工程辨识清单不一致/u.test(issue.message)) return ['【危大清单一致性定向修复】', '该章节正文存在多处危大工程辨识清单且项名/数量不一致。', '请以局部 patch 方式将两处清单合并统一：项名、数量与分级表述唯一且一致，删除重复清单。只修改相关列表。'].join('\n');
        if (/扬尘治理六个百分百/u.test(issue.message)) return ['【六个百分百逐项补写】', '该章节正文的扬尘治理措施未逐项覆盖“六个百分百”全部六项。', '请以局部 patch 方式逐条补齐缺失项（工地周边100%围挡、物料堆放100%覆盖、出入车辆100%冲洗、施工现场地面100%硬化、拆迁工地100%湿法作业、渣土车辆100%密闭运输），每项一句落实措施。不新增小节。'].join('\n');
        // 兜底：未识别消息特征时按通用结构修复处理（避免空指令 patch 无效果）
        return ['【交付阻断缺陷定向修复】', '该章节正文存在交付阻断级缺陷，详见缺陷描述。', '请以局部 patch 方式修复：结合缺陷描述定位相关文本，删除错误内容或按专业规范改写，保持其余内容与事实数据不变。只修改相关句子。'].join('\n');
      })();
      const repairedBlocker = await withProgressHeartbeat(() => repairChapterByQuality({
        template,
        chapter: { id: draftChapter.id, title: draftChapter.title, content: draftChapter.content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
        issues: [issue.message, issue.suggestion || ''],
        promptTexts: blockerFixInstruction,
        requirement,
        forbidDrawingImages: false,
        diagnostics: generationDiagnostics,
        signal,
      }));
      if (repairedBlocker.content && repairedBlocker.content !== draftChapter.content) {
        finalChapterDrafts[chapterIndex] = { ...draftChapter, content: templateChapter ? finalizeChapterContentQuality(repairedBlocker.content, templateChapter) : repairedBlocker.content };
        blockerFixPatches += repairedBlocker.appliedCount;
      }
      const completedBlockerStage = displayStage({ type: 'llm_review', roleId: `agent-blocker-fix-${draftChapter.id}`, status: repairedBlocker.appliedCount > 0 ? 'success' : 'failed', message: repairedBlocker.appliedCount > 0 ? `交付阻断缺陷修复完成：${draftChapter.title}（${repairedBlocker.appliedCount} 处 patch）` : `交付阻断缺陷修复未生效：${draftChapter.title}`, details: [issue.message] }, { subtitle: '交付阻断修复' });
      upsertProgressStage(progressStages, completedBlockerStage);
      upsertProgressStage(finalGateRepairStages, completedBlockerStage);
      emitProgress(finalChapterDrafts, progressStages);
    }
    if (blockerFixPatches > 0) {
      finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
      await recomputeFinalValidationBundle();
    }
  }
  // Final Gate 补写小节由 LLM 生成，可能引入新的跨章数值冲突（生成阶段修复闭环不覆盖补写内容）：
  // 导出前做最后一次确定性定点修复，修复后重建 finalMarkdown 并重算校验组，避免补写残留冲突被导出门禁硬阻断
  const postFinalGateFix = applyDeterministicConsistencyFixes(finalChapterDrafts, factsModel, scopeConflicts);
  // 全文级定点修复同 finalize 入口处：封面/信息表合成区的败选数值章节修复覆盖不到，必须同步修复
  const needsPostGateMarkdownFix = applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts).fixedCount > 0;
  if (postFinalGateFix.fixedCount > 0 || needsPostGateMarkdownFix) {
    finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
    const postRebuildMarkdownFix = applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts);
    if (postRebuildMarkdownFix.fixedCount > 0) finalMarkdown = postRebuildMarkdownFix.markdown;
    await recomputeFinalValidationBundle();
    const totalFixed = postFinalGateFix.fixedCount + postRebuildMarkdownFix.fixedCount;
    const totalDetails = [...new Set([...postFinalGateFix.details, ...postRebuildMarkdownFix.details])];
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'deterministic-consistency-fix', status: 'success', message: `跨章一致性数值定点修复：${totalFixed} 处（${totalDetails.slice(0, 4).join('、')}）`, details: totalDetails.slice(4) }, { subtitle: '跨章一致性修复' }));
  }
  // 来源罗列话术确定性清洗兜底（十一度实测缺陷）：patch 类修复更新章节内容后若未触发 rebuild，最终校验用
  // markdown 可能残留“依据招标文件…”罗列句被导出门禁硬阻断；交付前用与导出侧一致的清洗函数兜底再重算
  const cleanedFinalMarkdown = cleanFormalSourcePhrases(finalMarkdown);
  if (cleanedFinalMarkdown !== finalMarkdown) {
    finalMarkdown = cleanedFinalMarkdown;
    await recomputeFinalValidationBundle();
  }
  // 画像闭环修复轮（round-15）：参考画像低分项（参数密度/工序链覆盖率）与重度模板化信号此前只进报告不进修复循环
  // （报告闭环缺失）；此处按确定性定位做定向 patch 修复（上限 2 条），修复后重建 finalMarkdown 并重算校验组，
  // 形成“生成 → 画像对标 → 定向修复 → 重算”闭环。定位/指令均为确定性产出，语义判定与改写仍归 LLM。
  const qualityBenchmarkNow = benchmarkGeneratedMarkdown(finalMarkdown);
  const templatingHeavy = Boolean(qualityReport.templating && qualityReport.templating.level === 'heavy');
  if (qualityBenchmarkNow || templatingHeavy) {
    interface ProfileFixPlan { kind: string; chapterTitle: string; detail: string; instruction: string[]; }
    const profileFixPlans: ProfileFixPlan[] = [];
    const paramDensityItem = qualityBenchmarkNow?.items.find(item => item.key === 'paramDensity');
    if (paramDensityItem && paramDensityItem.score < 80) {
      // 定位：数字 token 密度最低的长正文章节（参数密度低分项的最薄弱章节）
      let weakest: DocumentDraftChapter | undefined;
      let weakestDensity = Number.POSITIVE_INFINITY;
      for (const chapter of finalChapterDrafts) {
        const length = documentTextLength(chapter.content);
        if (length < 600) continue;
        const digits = (chapter.content.match(/\d+(?:\.\d+)?/gu) || []).length;
        const density = digits / Math.max(1, length / 1000);
        if (density < weakestDensity) { weakestDensity = density; weakest = chapter; }
      }
      if (weakest) {
        profileFixPlans.push({
          kind: 'param-density',
          chapterTitle: weakest.title,
          detail: `参数密度 ${paramDensityItem.generated.toFixed(1)} 个/千字（基准 ${paramDensityItem.reference.toFixed(1)}，得分 ${paramDensityItem.score}）`,
          instruction: ['【参数密度定向补强】', `该章节工程参数密度低于同类优质样本参考画像（每千字 ${paramDensityItem.generated.toFixed(1)} 个 vs 基准 ${paramDensityItem.reference.toFixed(1)} 个）。`, '请以局部 patch 方式在合适位置补充本项目可核实的工程参数（尺寸、强度等级、工期、数量、间距、厚度等），必须来自绑定资料事实或规范标准，禁止编造数值；参数自然融入现有段落，不新增小节。'],
        });
      }
    }
    const arrowItem = qualityBenchmarkNow?.items.find(item => item.key === 'arrowChainCoverage');
    if (arrowItem && arrowItem.score < 80) {
      // 定位：首个无“→”工序链的施工方法类长正文章节
      const chainLess = finalChapterDrafts.find(chapter => documentTextLength(chapter.content) >= 600 && /施工|工艺|方法|方案|流程/u.test(chapter.title) && !chapter.content.includes('→'));
      if (chainLess) {
        profileFixPlans.push({
          kind: 'arrow-chain',
          chapterTitle: chainLess.title,
          detail: `工序链覆盖率 ${(arrowItem.generated * 100).toFixed(0)}%（目标 ${(arrowItem.reference * 100).toFixed(0)}%，得分 ${arrowItem.score}）`,
          instruction: ['【工序链定向补写】', `该章节工序链覆盖率低于参考画像基准（目标 ${(arrowItem.reference * 100).toFixed(0)}%）。`, '请以局部 patch 方式在施工方法段落补写至少一条不少于 4 个环节的“→”工序链（如“放线定位→钻孔→清孔→钢筋笼吊放→混凝土浇筑→养护”），并保留已有事实数据；不新增小节。'],
        });
      }
    }
    if (templatingHeavy) {
      // 定位：套话词命中数最多的章节（重度模板化的最薄弱章节）
      const genericWords = ['加强组织领导', '严格执行规范', '落实责任制度', '确保工程质量', '强化过程管理', '提高思想认识', '完善管理体系', '形成闭环管理'];
      let worst: DocumentDraftChapter | undefined;
      let worstHits = 0;
      for (const chapter of finalChapterDrafts) {
        const hits = genericWords.reduce((sum, word) => sum + chapter.content.split(word).length - 1, 0);
        if (hits > worstHits) { worstHits = hits; worst = chapter; }
      }
      if (worst && worstHits >= 6) {
        profileFixPlans.push({
          kind: 'templating',
          chapterTitle: worst.title,
          detail: `重度模板化（套话句占比 ${(qualityReport.templating!.fillerRatio * 100).toFixed(1)}%，本章套话词命中 ${worstHits} 处）`,
          instruction: ['【模板化定向改写】', `该章节套话句占比过高（重度模板化），存在 ${worstHits} 处未绑定项目事实的管理套话。`, '请以局部 patch 方式将套话句改写为绑定本项目对象、动作、控制点与验收闭环的具体表述（每句至少含一个本项目事实或工程对象），保持段落结构不变，不新增小节、不改动事实数据。'],
        });
      }
    }
    let profileFixPatches = 0;
    for (const plan of profileFixPlans.slice(0, 2)) {
      const chapterIndex = finalChapterDrafts.findIndex(chapter => chapter.title === plan.chapterTitle);
      if (chapterIndex < 0) continue;
      const draftChapter = finalChapterDrafts[chapterIndex];
      const runningProfileStage = displayStage({ type: 'llm_review', roleId: `agent-profile-fix-${plan.kind}`, status: 'running', message: `画像定向修复：${draftChapter.title}`, details: [plan.detail] }, { subtitle: '画像闭环修复' });
      upsertProgressStage(progressStages, runningProfileStage);
      upsertProgressStage(finalGateRepairStages, runningProfileStage);
      emitProgress(finalChapterDrafts, progressStages);
      const repairedProfile = await withProgressHeartbeat(() => repairChapterByQuality({
        template,
        chapter: { id: draftChapter.id, title: draftChapter.title, content: draftChapter.content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
        issues: [plan.detail],
        promptTexts: plan.instruction.join('\n'),
        requirement,
        forbidDrawingImages: false,
        diagnostics: generationDiagnostics,
        signal,
      }));
      if (repairedProfile.content && repairedProfile.content !== draftChapter.content) {
        // 与交付阻断修复轮同口径：修复产物必须过章节内容质量收口（H4 去重/空壳清理/模板规则）
        const templateChapter = effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title);
        finalChapterDrafts[chapterIndex] = { ...draftChapter, content: templateChapter ? finalizeChapterContentQuality(repairedProfile.content, templateChapter) : repairedProfile.content };
        profileFixPatches += repairedProfile.appliedCount;
      }
      const completedProfileStage = displayStage({ type: 'llm_review', roleId: `agent-profile-fix-${plan.kind}`, status: repairedProfile.appliedCount > 0 ? 'success' : 'failed', message: repairedProfile.appliedCount > 0 ? `画像定向修复完成：${draftChapter.title}（${repairedProfile.appliedCount} 处 patch）` : `画像定向修复未生效：${draftChapter.title}`, details: [plan.detail] }, { subtitle: '画像闭环修复' });
      upsertProgressStage(progressStages, completedProfileStage);
      upsertProgressStage(finalGateRepairStages, completedProfileStage);
      emitProgress(finalChapterDrafts, progressStages);
    }
    if (profileFixPatches > 0) {
      finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
      await recomputeFinalValidationBundle();
    }
  }
  const reviewChecklist = buildDocumentReviewChecklist({ exportGate: finalExportGate, qualityReport, repairStrategies });
  const telemetry = buildDocumentTelemetryReport({ diagnostics: generationDiagnostics });
  const finalQualitySummary = qualitySeveritySummary(validationIssues);
  const professionalScore = buildProfessionalScoreReport(finalChapterDrafts, finalMarkdown, { templating: qualityReport.templating });
  // A3 模板语义相似度（docx 三档：<30% 独立 / 30-60% 参考改编 / >60% 抄袭风险）：
  // 嵌入模型不可用或参考库无同类样本时降级 undefined，不阻塞导出
  const templateSimilarity = await withProgressHeartbeat(() => buildTemplateSimilarityReport(finalMarkdown, referenceTextSlicesForType(suggestProjectType(finalMarkdown))));
  // A2 语义级模板化复核（仅 A1 风险信号命中时触发一次 LLM，失败静默降级）
  const templatingReview = qualityReport.templating
    ? await withProgressHeartbeat(() => reviewTemplatingSemantics({ templating: qualityReport.templating!, markdown: finalMarkdown, diagnostics: generationDiagnostics, signal }))
    : { issues: [], reviewed: false };
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
  if (qualityReport.templating && qualityReport.templating.level !== 'light') {
    finalStages.push(displayStage({ type: 'validation', roleId: 'document-templating-report', status: 'skipped', message: `模板化检测：${qualityReport.templating.level === 'heavy' ? '重度' : '中度'}模板化（套话句占比 ${(qualityReport.templating.fillerRatio * 100).toFixed(1)}%，重难点归因＋量化双达标占比 ${(qualityReport.templating.difficultyCountermeasureRatio * 100).toFixed(0)}%，模糊应答词 ${qualityReport.templating.vagueHitCount} 处）`, details: templatingReview.issues }, { subtitle: '模板化检测' }));
  }
  if (templateSimilarity) {
    finalStages.push(displayStage({ type: 'validation', roleId: 'document-template-similarity', status: templateSimilarity.level === 'independent' ? 'success' : 'skipped', message: `模板相似度：${templateSimilarity.level === 'independent' ? '独立编制' : templateSimilarity.level === 'adapted' ? '参考改编' : '抄袭风险'}（最高单句相似度 ${(templateSimilarity.maxSimilarity * 100).toFixed(0)}%，对比参考库 ${templateSimilarity.referenceSlices} 个样本切片）`, details: [] }, { subtitle: '模板相似度' }));
  }
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
      templateSimilarity,
      templatingReviewIssues: templatingReview.issues,
      writingTaskBrief,
      workflowVersion: DOCUMENT_WORKFLOW_VERSION,
      telemetry,
      qualityBenchmark: benchmarkGeneratedMarkdown(finalMarkdown),
    },
    generatedAt: Date.now(),
    markdown: finalMarkdown,
  };
}
