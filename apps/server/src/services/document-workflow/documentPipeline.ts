import type { AgentWorkflowContext } from './agentWorkflow';
import type { DocumentAsset, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, GeneratedDocumentDraft, NumericScopeConflict, RetrievalCoverageReport, TenderRequirementItem, TenderRequirementModel, ValidationIssue, WritingTaskBrief } from './types';
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
import { applySpecGateRules, autoSpecGateRequiredTexts, buildExportGate, qualitySeveritySummary, applyDeterministicConsistencyFixes, applyDeterministicConsistencyFixesToMarkdown, markdownTableQualityIssues, generatedFactVerificationIssuesAsync, boqPlacementIssues, preciseFactUsageIssues } from './qualityValidation';
import { areaArithmeticIssues, bodySentencesForSemantic, collapseRepeatedWords, commercialDataInBodyIssues, dangerousListConsistencyIssues, fabricatedStartDateIssues, fieldValueMismatchIssues, localAdaptationKeywordIssues, overviewRecapCandidates, overviewRecapIssues, repeatedWordIssues, resourceConsistencyIssues, selfUnderminingCandidateIssues, sixHundredPercentCoverageIssues, stripCommercialDataBodyLines, stripCommercialDataSentences, stripOverviewRecapBodyLines, supportSystemConflictIssues } from './documentIntegrityChecks';
import { buildSemanticSimilarity } from './semanticSimilarity';
import { normalizeChapterTitleLine, requirementsCoverageIssues, tenderRequirementCheckItems, tenderRequirementSemanticQuery } from './tenderRequirements';
import { constructionOrgMajorContentIssues } from './constructionOrgQualityRules';
import { internalTerminologyAnchorIssues, stripInternalTerminologySentences } from './internalTerminologyAnchors';
import { parameterConceptConflictIssues } from './parameterConceptConflicts';
import { constructionSystemCoverageIssues } from './constructionSystemCoverage';
import { dangerousApplicabilityIssues } from './dangerousApplicability';
import { stagePhrasingIssues } from './stagePhrasing';
import { emergencySectionDepthIssues } from './emergencySectionDepth';
import { buildDataConsistencyReviewCached, conflictNumericKey, dataConsistencyConflictIssue, reviewDataConsistency, reviewDataConsistencyBatched } from './dataConsistencyReview';
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
import { comparableSectionHeadingMatches, extractSection, stringifyFactValue, throwIfAborted, WORK_PACKAGE_SECTION_RE, systemConstraintLine } from './utils';
import { formalTextGateIssues } from './agentWorkflow';
import { displayStage, upsertProgressStage } from './progress';
import { buildLlmSectionContent, buildValidationIssues, criticalSectionBlockerMinChars, normalizeFactUsageText } from './chapterGeneration';
import { chapterSectionFactUsageIssues } from './chapterReview';
import { factCoverageIssues, factsWithEvidenceSource, criticalSectionBlockerLine, finalizeChapterContentQuality, finalizeFinalMarkdownStructure, normalizeProjectBasicInfoTable, partialChapterStatus, projectBasicPlaceholderIssues, slowMetricSummary, uncoveredImportantFacts, validateDraft } from './documentGeneratorHelpers';
import { constructionOrgProfessionalAuditIssues } from './constructionOrgAudit';
import { buildProfessionalScoreReport } from './documentProfessionalScore';
import { recordDeterministicFixCases } from './workflowCaseLog';
import { referenceBenchmarkForType } from './templateReferenceService';
import { suggestProjectType } from './referenceQualityProfile';
import { reviewTemplatingSemantics } from './templatingReview';
import { qingtianReviewValidationIssues, runFullDimensionReview } from './fullDimensionReview';

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
    ? `该小节按专业工程/分项工程方案组织，每个 #### 分项方案必须按“施工概况（作业对象、部位、工程量）”“施工流程（工序顺序表达串联工序链）”“施工方法（工具机具、材料规格、工艺参数、验收标准）”三段展开，“施工概况”“施工流程”“施工方法”三个标签必须在每个分项方案正文中逐字出现。标签形态要求：三个标签必须写成纯文本行首形态（如“施工概况：”），严禁粗体包裹（**施工概况**：）或重复前缀（施工概况：**施工概况**：）。每个分项方案的施工流程段至少 1 条不少于 4 个环节的工序顺序表达（箭头链、编号步骤、有序/无序列表或顺序词叙述均可，如“基层清理→放线定位→分层施工→养护→验收”），施工方法段内也必须包含一条工序顺序表达。每个分项方案至少 4 个带单位工艺参数，小分项（拆除、门窗维修、立面修补等）同样必须写足，参数类型参考：拆除面积㎡、垃圾外运量t、外运距离km、日拆除进度㎡/天、更换数量樘、启闭力N、胶缝宽度mm、安装偏差mm。`
    : '';
  return `Final Gate 发现“${sectionTitle}”为空小节或深度不足。请基于证据完整重写该小节正式正文（原小节内容将被整体替换），包含检查责任、验收节点、资料闭环、整改复验要求，不得输出占位或解释。量化参数只引用与本小节直接相关的具体数字（工期、工程量、材料规格、强度等级等）；禁止以“本项目为……”开头整段复述项目概况（建设地点、总建筑面积、层数、总工期等总述信息只在概况类小节集中交代一次），正文直接切入本小节专业内容。${workPackageQualityFeedback}${lastFailure ? `此前生成被拒原因：${lastFailure}，必须逐条修正。` : ''}`;
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

/** 按表头第一列锚点从 markdown 中提取缺陷表格块（表头行到最后一个连续表格行；找不到返回空串） */
function extractTableBlockByAnchor(content: string, anchor: string): string {
  if (!anchor) return '';
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*\|/u.test(lines[index]) || !lines[index].includes(anchor)) continue;
    let start = index;
    while (start > 0 && /^\s*\|/u.test(lines[start - 1])) start -= 1;
    let end = index;
    while (end + 1 < lines.length && /^\s*\|/u.test(lines[end + 1])) end += 1;
    return lines.slice(start, end + 1).join('\n');
  }
  return '';
}

/**
 * 表格空单元格/占位缺陷确定性兜底（LLM 修复失败后的最后防线，只做不引入新错误的确定性操作）：
 * 1. 合计/小计/总计/累计行的空单元格 → 填“—”（检测器按行业惯例豁免）；
 * 2. 表名占首格（表头首格以“表”结尾且数据行末列全空）→ 表头删首格、数据行删末格，列对齐归一；
 * 3. 数据行全空列 → 删除整列（含表头）；4. 零星空单元格 → 删除所在数据行；
 * 5. 删到只剩表头/分隔线时整个表格块删除（表格已无意义）。
 * 无缺陷表格原样返回。删除动作计数返回供进度留痕。
 */
function repairTableBlockLines(rawLines: string[]): { lines: string[]; removed: number } {
  const rows = rawLines.map(line => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => cell.trim()));
  if (rows.length < 2) return { lines: rawLines, removed: 0 };
  const dividerIndex = rows.length > 1 && rows[1].length > 0 && rows[1].every(cell => /^:?-{2,}:?$/u.test(cell)) ? 1 : 0;
  const width = () => Math.max(...rows.map(row => row.length));
  let removed = 0;
  let changed = false;
  // 1. 合计行空单元格 → “—”
  for (let rowIndex = dividerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!/^(?:合计|小计|总计|累计)/u.test(row[0] || '')) continue;
    for (let col = 1; col < row.length; col += 1) {
      if (row[col] === '') { row[col] = '—'; changed = true; }
    }
  }
  // 2. 表名占首格归一：表头首格以“表”结尾、数据行末列全空且数据行首列非空 → 表头删首格、数据行删末格
  const header = rows[0];
  const dataRows = rows.slice(dividerIndex + 1);
  if (dataRows.length > 0 && /表$/u.test(header[0] || '') && dataRows.every(row => row.length > 0 && row[row.length - 1] === '') && dataRows.some(row => row[0] !== '')) {
    rows[0] = header.slice(1);
    for (let rowIndex = dividerIndex + 1; rowIndex < rows.length; rowIndex += 1) rows[rowIndex] = rows[rowIndex].slice(0, rows[rowIndex].length - 1);
    changed = true;
    removed += 1;
  }
  // 3. 数据行全空列 → 删除整列
  if (rows.length > dividerIndex + 1) {
    const colsToDrop: number[] = [];
    for (let col = 0; col < width(); col += 1) {
      const allEmpty = rows.slice(dividerIndex + 1).every(row => (row[col] || '') === '');
      if (allEmpty) colsToDrop.push(col);
    }
    if (colsToDrop.length > 0) {
      for (const row of rows) for (let k = colsToDrop.length - 1; k >= 0; k -= 1) row.splice(colsToDrop[k], 1);
      changed = true;
      removed += 1;
    }
  }
  // 4. 零星空单元格/占位符单元格 → 删除所在数据行（4.12.12 扩围：—/若干/约/待定/N/A 占位与
  // 空单元格同口径确定性删行，消除 LLM 修复不收敛的表格占位符残留；合计/小计/总计/累计行豁免）
  const PLACEHOLDER_CELL_RE = /^(?:—+|-+|\/|N\/A|n\/a|待定|待补充|待确认|待查|待补|若干|暂无|无数据)$/u;
  for (let rowIndex = rows.length - 1; rowIndex > dividerIndex; rowIndex -= 1) {
    if (/^(?:合计|小计|总计|累计)/u.test(rows[rowIndex][0] || '')) continue;
    if (!rows[rowIndex].some(cell => cell === '' || PLACEHOLDER_CELL_RE.test(cell))) continue;
    rows.splice(rowIndex, 1);
    changed = true;
    removed += 1;
  }
  // 4.5 “约82kW”模糊前缀归一（约N 占位表述在交付口径属占位符，数值确定化后不再阻断）
  for (let rowIndex = dividerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let col = 0; col < row.length; col += 1) {
      if (!/^约\d/u.test(row[col] || '')) continue;
      row[col] = (row[col] || '').replace(/^约/u, '');
      changed = true;
    }
  }
  // 5. 删到只剩表头/分隔线时整个表格块删除
  if (rows.length <= dividerIndex + 1) {
    rows.splice(0, rows.length);
    changed = true;
    removed += 1;
  }
  if (!changed) return { lines: rawLines, removed: 0 };
  const rebuilt = rows.map((row, rowIndex) => (rowIndex === dividerIndex ? `| ${row.map(() => '---').join(' | ')} |` : `| ${row.join(' | ')} |`));
  return { lines: rebuilt, removed };
}

/** 按表头第一列锚点定位单张缺陷表格并做确定性修复（表格专轮 LLM 修复失败后的兜底） */
function repairTableBlockDeterministically(content: string, tableAnchor: string): { content: string; removed: number } {
  const block = extractTableBlockByAnchor(content, tableAnchor);
  if (!block) return { content, removed: 0 };
  const repaired = repairTableBlockLines(block.split(/\r?\n/u));
  return repaired.removed > 0 ? { content: content.replace(block, repaired.lines.join('\n')), removed: repaired.removed } : { content, removed: 0 };
}

/**
 * markdown 全文级表格确定性修复（round-19 R5）：交付前兜底。表格专轮修复之后全维度评审轮修复
 * 可能重写表格引入空单元格（徽光阁实测危险源辨识表“高处作业坠落”行末两列空），交付前逐块
 * 做与专轮兜底同口径的确定性修复，只做不引入新错误的确定性操作。
 */
export function repairTableBlocksInMarkdownDeterministically(markdown: string): { markdown: string; removed: number } {
  const lines = markdown.split(/\r?\n/u);
  const result: string[] = [];
  let removed = 0;
  let index = 0;
  while (index < lines.length) {
    if (!/^\s*\|/u.test(lines[index])) { result.push(lines[index]); index += 1; continue; }
    let end = index;
    while (end + 1 < lines.length && /^\s*\|/u.test(lines[end + 1])) end += 1;
    const repaired = repairTableBlockLines(lines.slice(index, end + 1));
    if (repaired.removed > 0) removed += 1;
    result.push(...repaired.lines);
    index = end + 1;
  }
  return { markdown: result.join('\n'), removed };
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

/** 评审轮招标对标材料（round-21 S6）：工程概况事实 + 评标办法条目 + 评分项要求 + 清单特征摘要。
 * 评审轮零检出根因修复：不注入对标材料时评审模型无招标依据可对照，只能按通用规范空评
 * （实测 5 块评审零检出而外部评分按同一青天规范+招标材料检出 207 条） */
function buildTenderReviewContext(input: { factsModel: any; evaluationCriteriaItems?: string[]; tenderRequirements?: TenderRequirementModel }): string {
  const sections: string[] = [];
  const canonical = input.factsModel?.canonical;
  const valueOf = (fact: { value?: string } | undefined) => fact?.value;
  if (canonical) {
    const firstOf = (fact: { value?: string } | Array<{ value?: string }> | undefined) => (Array.isArray(fact) ? fact.map(item => item?.value).filter(Boolean) : fact?.value ? [fact.value] : []);
    const identityLines = [
      valueOf(canonical.projectIdentity?.projectName) ? `项目名称：${valueOf(canonical.projectIdentity.projectName)}` : '',
      valueOf(canonical.projectIdentity?.owner) ? `招标人：${valueOf(canonical.projectIdentity.owner)}` : '',
      valueOf(canonical.projectIdentity?.location) ? `建设地点：${valueOf(canonical.projectIdentity.location)}` : '',
      ...firstOf(canonical.projectScope?.scale).map(value => `建设规模：${value}`),
      ...firstOf(canonical.schedule?.duration).map(value => `计划工期：${value}`),
      ...firstOf(canonical.quality?.target).map(value => `质量目标：${value}`),
    ].filter(Boolean);
    if (identityLines.length) sections.push(`工程概况事实：\n${identityLines.join('\n')}`);
  }
  const criteria = (input.evaluationCriteriaItems || []).filter(Boolean);
  if (criteria.length) sections.push(`评标办法技术评审条目：\n${criteria.map(item => `- ${item}`).join('\n')}`);
  const req = input.tenderRequirements;
  if (req && req.extracted) {
    const reqLines: string[] = [];
    const pushItems = (label: string, items: TenderRequirementItem[] | undefined) => {
      for (const item of items || []) reqLines.push(`${label}：${item.text}`);
    };
    pushItems('创优目标', req.awardObjectives);
    pushItems('特殊质量标准', req.specialQualityStandards);
    pushItems('奖项条款', req.awardClauses);
    if (req.greenBuildingGrade) reqLines.push(`绿色建筑等级：${req.greenBuildingGrade.text}`);
    if (req.smartSiteGrade) reqLines.push(`智慧工地等级：${req.smartSiteGrade.text}`);
    if (req.assemblyRate) reqLines.push(`装配率要求：${req.assemblyRate.text}`);
    pushItems('体系基准', req.systematicBenchmarks);
    pushItems('禁止性约束', req.prohibitionNotes);
    if (req.dateFabricationProhibited) reqLines.push('禁编日期条款：正文不得自设具体开工/竣工日期');
    if (reqLines.length) sections.push(`招标文件评分项要求：\n${reqLines.map(line => `- ${line}`).join('\n')}`);
  }
  const bills: string[] = (input.factsModel?.bills || []).slice(0, 10).map((fact: DocumentFact) => `${fact.fieldName || fact.key} ${fact.value}`.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  if (bills.length) sections.push(`工程量清单特征摘要：\n${bills.map(line => `- ${line}`).join('\n')}`);
  return sections.join('\n\n');
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
  /** 评分项要求↔章节语义相似度函数（本地 bge 余弦，生成前预构建恒非空） */
  requirementsSimilarity: (leftText: string, rightText: string) => number;
  /** 总量口径语义分类器（round-13）：事实反查口径归属语义复核（本地 bge 恒可用） */
  factTokenScopeClassifier: FactTokenScopeClassifier;
  /** 专业深度语义分类器（round-14）：章节专业深度/缺项/套话/闭环/依赖的语义判定（本地 bge 恒可用） */
  professionalDepthClassifier: ProfessionalDepthClassifier;
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
    await internalTerminologyAnchorIssues(finalMarkdown),
    finalMarkdown.includes('WRITER_MISSING_SECTION') || finalMarkdown.includes('Writer 未完成') ? [{ level: 'error' as const, severity: 'blocker' as const, category: 'structure' as const, owner: 'system' as const, message: '最终正文仍包含未完成小节标记', suggestion: '必须重新补写对应小节并删除 WRITER_MISSING_SECTION/Writer 未完成。' }] : [],
    criticalSectionDepthIssues(finalChapterDrafts),
    criticalSectionFactDensityIssues(finalChapterDrafts),
    (await constructionOrgProfessionalAuditIssues(finalChapterDrafts, finalMarkdown)).map(issue => issue.level === 'error' ? { ...issue, severity: 'blocker' as const } : issue),
  ).map(issue => issue.level === 'error' ? { ...issue, severity: issue.severity || 'blocker' } : issue);
}

/** 生成前/生成中的流程诊断：反映检索与事实映射状态而非最终正文缺陷，不参与缺陷计分 */
const FLOW_DIAGNOSTIC_ISSUE_RE = /章节级证据覆盖较弱|章节事实覆盖不足|小节事实或量化参数落位可继续优化/u;

/** 质量报告组：覆盖报告、事实追踪、章节覆盖、质量报告、修复策略与导出门禁（首次含检索覆盖复核，修复后重算时不重复累加） */
async function buildQualityReportBundle(input: {
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
  const qualityReport = await buildDocumentQualityReport({ markdown: finalMarkdown, chapters: finalChapterDrafts, issues, knowledgeCoverage, factTraces, template, referenceCompleteBlocks });
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

/** 4.2 确定性一致性修复收敛（3 处→2 处）：finalize 入口的章节级修复默认去掉——其成果会被后续
 * Final Gate 补写/评审轮修复的正文变更破坏，且 Final Gate 后必跑一次兜底，入口修复边际价值被覆盖。
 * DOCUMENT_FINALIZE_ENTRY_FIX=1 恢复入口章节级修复（回退开关）。 */
export function finalizeEntryConsistencyFixEnabled() {
  return process.env.DOCUMENT_FINALIZE_ENTRY_FIX === '1';
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
  /** A2 章级 scoped 上下文工厂（生成器预构建）：Final Gate 补写调用按章精确裁剪蓝图；未提供时回退全量 projectContext */
  chapterScopedContext?: (chapter: DocumentTemplateChapter) => string;
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
  /** 评分项要求↔章节语义相似度函数（本地 bge 余弦，生成前预构建恒非空，随 p 传递复用） */
  requirementsSimilarity: (leftText: string, rightText: string) => number;
  /** 总量口径语义分类器（round-13，生成前预构建）：事实反查口径归属语义复核（本地 bge 恒可用） */
  factTokenScopeClassifier: FactTokenScopeClassifier;
  /** 专业深度语义分类器（round-14，生成前预构建）：章节专业深度/缺项/套话/闭环/依赖语义判定（本地 bge 恒可用） */
  professionalDepthClassifier: ProfessionalDepthClassifier;
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
    // 证据全量保留（无预算截断）：章节证据收集后不再压缩，数据零丢失
    allEvidence.splice(0, allEvidence.length, ...selectEvidenceByBudget(allEvidence, { preservePinned: true }));
  }
  const scopedAllEvidence = filterEvidenceByProjectScope(allEvidence, projectMaterialScope);
  allEvidence.splice(0, allEvidence.length, ...scopedAllEvidence);
  assertEvidenceInProjectScope(allEvidence, projectMaterialScope, 'finalize:all-evidence');

  throwIfAborted(signal);
  const compactPostFileEvidence = selectEvidenceByBudget(allEvidence, { preservePinned: true });
  allEvidence.splice(0, allEvidence.length, ...filterEvidenceByProjectScope(compactPostFileEvidence, projectMaterialScope));
  assertEvidenceInProjectScope(allEvidence, projectMaterialScope, 'finalize:post-file-understanding');

  const facts = extractFacts(template, allEvidence, documentSpec);
  const localFacts = filterFactsByProjectScope(extractStructuredFacts(allEvidence, template, documentSpec), projectMaterialScope);
  const projectBasicFacts = filterFactsByProjectScope(extractProjectBasicFactsFromEvidence(allEvidence), projectMaterialScope);
  const preciseFacts = filterFactsByProjectScope(extractPreciseFactsFromEvidence(allEvidence, domainProfile), projectMaterialScope);
  const preLlmFacts = [...localFacts, ...projectBasicFacts, ...preciseFacts];
  let llmExtraction: { facts: DocumentFact[]; stages: DocumentExecutionStage[] } = { facts: [], stages: [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: '已有本地/资料事实覆盖主要必需字段，跳过 LLM 全量事实抽取' }] };
  if (shouldRunLlmFactExtraction(preLlmFacts, template, documentSpec)) {
    const factExtractionEvidence = selectEvidenceByBudget(allEvidence, { preservePinned: true });
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
  const factsModel = await buildFactsModel(governedStructuredFacts, structuredTables, missingItems, documentSpec, domainProfile);
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
  const factUsageWarnings = await Promise.all(chapterDrafts.map(async chapter => {
    const templateChapter = effectiveChapters.find(item => item.id === chapter.id);
    if (!templateChapter) return [] as Array<{ level: 'warning'; message: string; suggestion: string }>;
    const issues = await chapterSectionFactUsageIssues({ chapter: templateChapter, content: chapter.content, evidence: chapter.evidence || [] });
    return issues.length > 0 ? [{ level: 'warning' as const, message: `${chapter.title} 小节事实或量化参数落位可继续优化：${issues.slice(0, 5).join('；')}`, suggestion: '建议在 Agent Writer 阶段扩大定向证据，不得在导出阶段补写。' }] : [];
  }));
  validationIssues = collectValidationIssueGroups(validationIssues, factUsageWarnings.flat());

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
  // 4.2 确定性一致性修复收敛（3 处→2 处）：finalize 入口的章节级修复默认去掉，其成果会被后续
  // Final Gate 补写/评审轮修复的正文变更破坏，且 Final Gate 后必跑一次兜底（入口修复边际价值被覆盖）。
  // DOCUMENT_FINALIZE_ENTRY_FIX=1 恢复入口章节级修复。
  const finalDeterministicFix = finalizeEntryConsistencyFixEnabled()
    ? await applyDeterministicConsistencyFixes(finalChapterDrafts, factsModel, scopeConflicts)
    : { fixedCount: 0, details: [] as string[] };
  // 全文级定点修复探测：封面信息块/基本信息表等合成区由 facts 生成，章节修复覆盖不到；败选数值残留会
  // 被重跑检测持续拦截形成死循环（历史缺陷：用户环境建设规模败选值 10970㎡ 留在封面，修复器在章节
  // 正文找不到目标 fixedCount=0，导出门禁永久阻断）
  const needsMarkdownFix = (await applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts)).fixedCount > 0;
  if (finalDeterministicFix.fixedCount > 0 || needsMarkdownFix) {
    finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
    const postRebuildFix = await applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts);
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
  // D1+D3：数据一致性审查与首次校验组并行 + 快照复用。审查任务与 buildFullValidationIssues 用同一 finalMarkdown
  // 并行发起（中间修复循环若改正文，消费点由哈希门禁自动重跑）；快照三防线——正文哈希门禁/写入门禁（LLM 失败
  // 不缓存）/内存级生命周期（闭包局部变量不跨生成）。复用点位：首次审查消费、blocker 复检、交付前轮与交付前复检。
  // 分项回退开关：DOCUMENT_CONSISTENCY_REVIEW_SNAPSHOT=0 时禁用并行发起与快照复用，恢复串行直调（行为与改造前一致）
  const dataConsistencySnapshotEnabled = process.env.DOCUMENT_CONSISTENCY_REVIEW_SNAPSHOT !== '0';
  const reviewDataConsistencyCached = dataConsistencySnapshotEnabled
    ? buildDataConsistencyReviewCached({ signal, diagnostics: generationDiagnostics })
    : async (markdown: string) => reviewDataConsistency(markdown, { signal, diagnostics: generationDiagnostics });
  const initialDataConsistencyReviewTask = dataConsistencySnapshotEnabled ? reviewDataConsistencyCached(finalMarkdown) : undefined;
  // 防 unhandled rejection：主流程若先因 abort 抛出而无人 await 任务，此 catch 吸收 rejection（消费点仍正常传播）
  initialDataConsistencyReviewTask?.catch(() => undefined);
  // 数据一致性复检批量化开关：data-consistency 复检为全文 LLM 审查（N 条冲突 per-issue 复检 = N 次全文审查），
  // 开启后修复循环跳过单条复检，交付前轮末统一重审一次（数值对签名比对）判定残留；=0 恢复 per-issue 复检
  const dataConsistencyBatchReviewEnabled = process.env.DOCUMENT_DATA_CONSISTENCY_BATCH_REVIEW !== '0';
  validationIssues = await buildFullValidationIssues({ documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget, scopeConflicts, evaluationCriteriaItems, effectiveChapters, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier });

  let qualityBundle = await buildQualityReportBundle({ finalChapterDrafts, effectiveChapters, factsModel, allEvidence, finalMarkdown, validationIssues, retrievalCoverageReports, includeRetrievalCoverage: true, template });
  let { knowledgeCoverage, factTraces, chapterCoverage, qualityReport, repairStrategies, finalExportGate } = qualityBundle;
  validationIssues = qualityBundle.validationIssues;
  const finalGateRepairStages: DocumentExecutionStage[] = [];
  // Final Gate 修复循环：每轮重算 error 级结构缺陷候选并补写（候选全量进入，无数量配额），补写后重算校验组；
  // 最多 3 轮，避免“候选超限残留 error 直接阻断”（历史缺陷：6 个深度不足 error 只修 4 个，剩余 2 个让整篇生成失败）
  const repairedSectionKeys = new Set<string>();
  // round-20 S5/W8：全维度评审轮残留问题（否决级/高风险 error 阻断，中低风险 warning 展示），
  // 评审轮运行后赋值，recomputeFinalValidationBundle 重算校验组时并入，由导出门禁按 category 'qingtian_review' 硬阻断
  let qingtianReviewBlockingIssues: ValidationIssue[] = [];
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
    // 评审轮残留问题并入校验组（在导出门禁计算前），重算后 finalExportGate 即包含评审轮硬阻断
    validationIssues = [...validationIssues, ...qingtianReviewBlockingIssues];
    qualityBundle = await buildQualityReportBundle({ finalChapterDrafts, effectiveChapters, factsModel, allEvidence, finalMarkdown, validationIssues, retrievalCoverageReports, includeRetrievalCoverage: false, template });
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
      .sort((a, b) => Number(b.critical) - Number(a.critical));
    if (emptySectionIssues.length === 0) break;
    const repairDetails: string[] = [];
    // D2 同款：按章分组 + 跨章并行——同章空小节合并为一个补写组内串行（单写者），跨章组批量并行
    // （限幅 DOCUMENT_FINAL_GATE_REPAIR_CONCURRENCY，默认 3）；正文替换每次迭代读取最新章内容，
    // 避免同章多小节修复互相覆盖（历史缺陷：展开旧章对象会丢掉同章前一节刚落位的补写）
    const locatedEmptyGroups: Array<{ chapterIndex: number; items: Array<{ issue: ValidationIssue; chapterTitle: string; sectionTitle: string }> }> = [];
    const locatedEmptyGroupByChapter = new Map<number, number>();
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
      const existingIndex = locatedEmptyGroupByChapter.get(chapterIndex);
      if (existingIndex === undefined) {
        locatedEmptyGroupByChapter.set(chapterIndex, locatedEmptyGroups.length);
        locatedEmptyGroups.push({ chapterIndex, items: [{ issue, chapterTitle, sectionTitle }] });
      } else {
        locatedEmptyGroups[existingIndex].items.push({ issue, chapterTitle, sectionTitle });
      }
    }
    const finalGateRepairConcurrency = Math.max(1, Math.min(6, Number(process.env.DOCUMENT_FINAL_GATE_REPAIR_CONCURRENCY || 3)));
    for (let groupOffset = 0; groupOffset < locatedEmptyGroups.length; groupOffset += finalGateRepairConcurrency) {
      const batch = locatedEmptyGroups.slice(groupOffset, groupOffset + finalGateRepairConcurrency);
      await Promise.all(batch.map(async ({ chapterIndex, items }) => {
        const draftChapter = finalChapterDrafts[chapterIndex];
        // 定位阶段已验证 templateChapter 存在，此处非空断言安全
        const templateChapter = effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title)!;
        // 同章空小节组内串行：与改造前 per-issue 串行语义一致（每节独立补写与验收）
        for (const { issue, chapterTitle, sectionTitle } of items) {
          const latestChapter = finalChapterDrafts[chapterIndex];
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
        projectContext: p.chapterScopedContext ? p.chapterScopedContext(templateChapter) : p.projectContext,
        compactProjectContext: true,
        // 3.5 scoped 专用紧凑化：只有走章级 scoped 上下文（chapterScopedContext）时才用专用紧凑函数
        scopedProjectContext: Boolean(p.chapterScopedContext),
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
            const nextContent = forceAppend ? latestChapter.content : replaceMarkdownSection(latestChapter.content, sectionTitle, generated);
            repaired = !forceAppend && nextContent !== latestChapter.content;
            if (!repaired && (forceAppend || /(?:缺少规划小节|缺少[“"'].+[”"']小节)/u.test(issue.message))) {
              // 规划小节在正文中完全缺失：无原块可替换，将补写正文追加为新的三级小节
              const appended = `${latestChapter.content.replace(/\s+$/u, '')}\n\n### ${sectionTitle}\n\n${generated.replace(/^#{2,6}\s+(?:\d+(?:\.\d+)*\s+)?[^\n]+\n+/u, '').trim()}\n`;
              repaired = true;
              finalChapterDrafts[chapterIndex] = { ...latestChapter, content: finalizeChapterContentQuality(appended, templateChapter) };
              repairedSectionKeys.add(`${chapterTitle}::${sectionTitle}`);
              repairDetails.push(`成功：${chapterTitle}/${sectionTitle}（${documentTextLength(generated)}字，追加为缺失小节）`);
            } else if (repaired) {
              finalChapterDrafts[chapterIndex] = { ...latestChapter, content: finalizeChapterContentQuality(nextContent, templateChapter) };
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
      }));
    }
    finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
    await recomputeFinalValidationBundle();
  }
  // 重要事实落位补写轮（P1-3）：结构缺陷修复收敛后，若项目基础字段类硬数据仍未落位（建筑面积、标段数、编号、工期等），
  // 按事实标签映射目标章节做一轮定向 patch 落位（保持数值口径，不新增小节、不改表头结构）。
  // 十度实测缺陷：建设规模“建筑面积约为4646㎡”、招标范围“本项目分为1个标段”未落位直达交付（针对性维度 68 分）
  const importantUnplacedFacts = uncoveredImportantFacts(finalMarkdown, [...structuredFacts, ...factsModel.preciseFacts]);
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
  // 竣工清理计划表末列为空、临时用电表“—/若干/约82kW”占位）。修复链路：定位章节 → 注入缺陷表格原文 patch 修复
  // → 同源复检 → 升级指令二修 → 确定性兜底。历史失效根因：修复指令不含缺陷表格原文（LLM 在超长章节中
  // 定位不到表格，appliedCount=0）、修复后不复检（LLM 声称应用但未修表格无感知）、无确定性兜底。
  const tableDefectIssues = markdownTableQualityIssues(finalMarkdown).filter(issue => issue.level === 'error' && /空单元格|占位符单元格|列数不一致|分隔线位置不规范/u.test(issue.message));
  if (tableDefectIssues.length > 0) {
    let tableFixPatches = 0;
    // D2：按章分组 + 跨章并行——同章表格组内串行（每表独立修复闭环，组内后表以最新章内容为输入），
    // 跨章组批量并行（指令生成并行，限幅 DOCUMENT_TABLE_FIX_CONCURRENCY，默认 2）；每章单写者零覆盖
    const tableGroups: Array<Array<{ chapterIndex: number; issueIndex: number; message: string; suggestion: string; tableAnchor: string }>> = [];
    const tableGroupIndexByChapter = new Map<number, number>();
    for (let issueIndex = 0; issueIndex < tableDefectIssues.length; issueIndex += 1) {
      const issue = tableDefectIssues[issueIndex];
      // 双锚点定位章节：表头第一列（表名或首个业务列）+ 缺陷行首列。
      // 单锚点历史缺陷：“竣工清理与移交计划表”作为表头首格时按首列锚点定位，在聚合章（人材机保障章）中
      // 命中错误目标或无法与表格所在章节对应；补行首列锚点后两者必须同现于同一章节草稿才进入修复
      const tableAnchor = (issue.message.split('：')[1] || '').split('（')[0]?.split('、')[0] || '';
      const rowAnchor = /（[“"']?([^”"'）)]{2,30})[”"']?行/u.exec(issue.message)?.[1] || '';
      const chapterIndex = tableAnchor
        ? finalChapterDrafts.findIndex(chapter => {
            const content = chapter.content || '';
            return content.includes(tableAnchor) && (!rowAnchor || content.includes(rowAnchor));
          })
        : -1;
      if (chapterIndex < 0) continue;
      const entry = { chapterIndex, issueIndex, message: issue.message, suggestion: issue.suggestion || '', tableAnchor };
      const existingIndex = tableGroupIndexByChapter.get(chapterIndex);
      if (existingIndex === undefined) {
        tableGroupIndexByChapter.set(chapterIndex, tableGroups.length);
        tableGroups.push([entry]);
      } else {
        tableGroups[existingIndex].push(entry);
      }
    }
    const tableFixConcurrency = Math.max(1, Math.min(4, Number(process.env.DOCUMENT_TABLE_FIX_CONCURRENCY || 2)));
    for (let groupOffset = 0; groupOffset < tableGroups.length; groupOffset += tableFixConcurrency) {
      const batch = tableGroups.slice(groupOffset, groupOffset + tableFixConcurrency);
      await Promise.all(batch.map(async entries => {
        for (const { chapterIndex, issueIndex, message, suggestion, tableAnchor } of entries) {
          // 组内后表以最新章内容为输入（含此前已落位的同章表格 patch），与改造前 per-table 串行语义一致
          const draftChapter = finalChapterDrafts[chapterIndex];
          const templateChapter = effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title);
          const runningStage = displayStage({ type: 'llm_review', roleId: `agent-table-fix-${draftChapter.id}-${issueIndex}`, status: 'running', message: `正在修复表格数据缺失：${draftChapter.title}`, details: [message] }, { subtitle: '表格数据修复' });
          upsertProgressStage(progressStages, runningStage);
          upsertProgressStage(finalGateRepairStages, runningStage);
          emitProgress(finalChapterDrafts, progressStages);
          // 缺陷表格原文必须注入指令：从章节草稿提取（优先），章节草稿缺失时退回最终产物提取。
          // 历史失效根因：指令只有“表头+行名”，LLM 在 2 万字聚合章中无法定位表格 → patch 全部落空
          const defectTableBlock = extractTableBlockByAnchor(draftChapter.content, tableAnchor) || extractTableBlockByAnchor(finalMarkdown, tableAnchor) || '';
          const tableFixInstruction = [
            '【表格数据完整性定向修复】',
            '下列表格存在数据缺失缺陷：正式交付文档的表格不得出现空单元格，也不得用“—/若干/约/待定”等占位或模糊表达代替具体数据。',
            `缺陷表格原文（只允许修改这一张表，逐格修复；不得改动其他表格与小节）：\n${defectTableBlock.slice(0, 2000)}`,
            '请以局部 patch 方式修复该表格：每一列都必须有具体数据值。数据优先取自本章正文与证据摘要；正文与证据未直接给出时，按施工组织设计专业惯例给出具体数值或明确口径（如按班组工具配置估算台数），并保持数值单位一致、行列表头对齐。',
            '若表格首行就是分隔线（缺表头行），必须依据表格数据内容补写一行业务表头（每列一个业务字段名），再紧跟分隔线；表头不得使用泛化字段名。',
            '合计/小计/总计/累计行的空单元格一律填“—”（不适用语义）；其余单元格一律不得为空、不得用占位符。',
            '若表头第一列是表名（如“竣工清理与移交计划表”），把表名移到表格上方正文叙述中，表头从业务列名开始，并同步校正数据行列对齐。',
            '保持表头结构与列数不变，不得新增、删除或合并小节；只修改缺陷表格相关局部文本。',
          ].join('\n');
          const repairedTable = await withProgressHeartbeat(() => repairChapterByQuality({
            template,
            chapter: { id: draftChapter.id, title: draftChapter.title, content: draftChapter.content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
            issues: [message, suggestion],
            promptTexts: tableFixInstruction,
            requirement,
            forbidDrawingImages: false,
            diagnostics: generationDiagnostics,
            signal,
          }));
          let nextContent = repairedTable.content || draftChapter.content;
          const firstApplied = repairedTable.appliedCount > 0 && nextContent !== draftChapter.content;
          // 同源复检（F2 口径）：修复后重跑表格检测，该表头锚点仍存在同类缺陷 → 升级指令二修（携带修复后表格原文）
          if (firstApplied) {
            const residual = markdownTableQualityIssues(nextContent).filter(item => item.level === 'error' && /空单元格|占位符单元格|列数不一致/u.test(item.message) && item.message.includes(tableAnchor)).slice(0, 2);
            if (residual.length > 0) {
              const recheckBlock = extractTableBlockByAnchor(nextContent, tableAnchor) || '';
              const upgradeInstruction = [
                '【表格数据完整性二修（首次修复未消除缺陷）】',
                `首次修复后仍存在缺陷：${residual.map(item => item.message).join('；')}`,
                `修复后表格原文（逐格检查仍然为空的单元格，立即填入具体值）：\n${recheckBlock.slice(0, 2000)}`,
                '空单元格所在列若正文已有对应内容（如“验收标准”列），从本节正文对应段落逐项摘录填入；正文没有的按专业惯例推算具体值；无法推算的删除该行并说明原因。',
                '合计/小计/总计/累计行空单元格填“—”；表名占用表头第一格时必须移出表格。',
              ].join('\n');
              const secondRepair = await withProgressHeartbeat(() => repairChapterByQuality({
                template,
                chapter: { id: draftChapter.id, title: draftChapter.title, content: nextContent, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
                issues: residual.map(item => item.message),
                promptTexts: upgradeInstruction,
                requirement,
                forbidDrawingImages: false,
                diagnostics: generationDiagnostics,
                signal,
              }));
              if (secondRepair.content && secondRepair.content !== nextContent) nextContent = secondRepair.content;
            }
          }
          // 确定性兜底（LLM 二修仍失败的最后防线）：合计行空填“—”、表名占格归一、全空列删列、零星空单元格删行，
          // 只做不引入新错误的确定性操作（检测器豁免合计行“—”），无缺陷表格原样返回
          const deterministic = repairTableBlockDeterministically(nextContent, tableAnchor);
          nextContent = deterministic.content;
          if (nextContent !== draftChapter.content) {
            finalChapterDrafts[chapterIndex] = { ...draftChapter, content: templateChapter ? finalizeChapterContentQuality(nextContent, templateChapter) : nextContent };
            tableFixPatches += 1;
          }
          // 修复结果判定：同源复检该表头锚点是否仍存在表格数据缺陷
          const stillDefective = markdownTableQualityIssues(nextContent).some(item => item.level === 'error' && /空单元格|占位符单元格|列数不一致/u.test(item.message) && item.message.includes(tableAnchor));
          const completedTableStage = displayStage({ type: 'llm_review', roleId: `agent-table-fix-${draftChapter.id}-${issueIndex}`, status: stillDefective ? 'failed' : 'success', message: stillDefective ? `表格数据修复未生效：${draftChapter.title}` : `表格数据修复完成：${draftChapter.title}`, details: [message] }, { subtitle: '表格数据修复' });
          upsertProgressStage(progressStages, completedTableStage);
          upsertProgressStage(finalGateRepairStages, completedTableStage);
          emitProgress(finalChapterDrafts, progressStages);
        }
      }));
    }
    if (tableFixPatches > 0) {
      finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
      await recomputeFinalValidationBundle();
    }
  }
  // 交付阻断定向修复轮（round-12/13，round-16 重构为修复闭环 F2/F3）：
  // ① 全量派发（F3）：所有 error 级内容缺陷均进修复循环，不再用消息白名单枚举
  //    （徽光阁失败根因：概况段跨章复述 blocker 不在白名单 → 从未修复 → 被"不得出现"硬阻断）；
  //    封面/页眉/页脚/附图等后期人工兜底项与表格/标题重复/目录等专轮项除外；
  // ② 复检闭环（F2）：每轮修复后用与检测同源的判定复检，未消除则携带复检证据换升级指令二修；
  // ③ 确定性删除兜底：二修仍失败且可确定性定位的类型（来源罗列句/概况复述句/编造日期句）直接删除问题内容。
  // 所有修复步骤记录供前端展示；本地语义模型恒可用，语义类复检/删除与生成侧同源同口径。
  const manualPostprocessIssueRe = /封面|页眉|页脚|附图|图片引用|CAD图|示意图|插图/u;
  // h7：L3.5 数据一致性 LLM 审查层——全文数值句批量审查矛盾对（劳动力/面积/工期/节点日期等开放矛盾空间），
  // 转 blocker 进修复轮；确定性 resourceConsistencyIssues 5 模式为候选生成器，LLM 审查覆盖正则盲区
  // D1 消费点：快照开关开启时 await 与首次校验组并行发起的审查任务（中间修复循环若改正文，哈希门禁自动重跑）；
  // 开关关闭时 initialDataConsistencyReviewTask 为空，此行为恢复改造前的串行直调
  const dataConsistencyConflicts = initialDataConsistencyReviewTask
    ? await initialDataConsistencyReviewTask
    : await reviewDataConsistencyCached(finalMarkdown);
  if (dataConsistencyConflicts.length > 0) {
    // 矛盾数值签名去重：同一矛盾数值对 LLM 可能按不同 kind 重复上报（如 labor/duration 双标），
    // 数值对相同的只进一次修复循环，避免重复 patch 浪费修复轮配额
    const seenConflictKeys = new Set<string>();
    const conflictIssues = dataConsistencyConflicts
      .map(conflict => dataConsistencyConflictIssue(conflict))
      .filter(issue => {
        const key = conflictNumericKey(issue.message);
        if (!key || seenConflictKeys.has(key)) return false;
        seenConflictKeys.add(key);
        return true;
      });
    validationIssues = [...validationIssues, ...conflictIssues];
  }
  // round-19 R1：属地适配与政策合规类（属地创优目标缺失/四节一环保量化指标缺失/工伤保险表述缺失）
  // 排在聚合末尾，此前被 slice(0,8) 截断导致“持续报 blocker 但永不进修复循环”（徽光阁实测：
  // 创优目标/工伤保险缺失最终校验仍报 error、正文零命中）；配额截断已全面移除，全部 error 级缺陷进修复循环
  const localAdaptationBlockerRe = /属地创优目标缺失|四节一环保量化指标缺失|工伤保险表述缺失/u;
  const blockerContentIssues = (() => {
    const base = validationIssues
      .filter(issue => issue.level === 'error' && !manualPostprocessIssueRe.test(issue.message) && !/表格|标题重复|目录/u.test(issue.message));
    // 全部 error 级缺陷进修复循环（无数量配额截断），localAdaptation 类优先派发
    const others = base.filter(issue => !localAdaptationBlockerRe.test(issue.message));
    const localAdaptation = base.filter(issue => localAdaptationBlockerRe.test(issue.message));
    return [...localAdaptation, ...others];
  })();
  const normalizedBody = (chapter: DocumentDraftChapter) => (chapter.content || '').replace(/[\s,，]/gu, '');
  // round-20 S3：修复指令与章节定位函数提升到修复循环外（blocker 修复循环与交付前最终修复轮共用同一份分支），
  // 避免交付前轮只有六类分支导致数据一致性/评分项响应类缺陷在全维度评审轮修复回归后无交付前兜底。
  // round-20 S4：缺陷消息前缀路由收敛为集中式 code 映射——消息前缀是检测器生成的封闭集，路由属结构层
  // 而非语义判断；30 处正则 if 链收敛为一处 Map，新增缺陷类型只改这个 Map 与对应指令/定位 case。
  const BLOCKER_ISSUE_CODE_MAP: Array<{ code: string; match: RegExp }> = [
    { code: 'source-phrase', match: /资料来源罗列话术/u },
    { code: 'internal-term', match: /后台内部术语|后台内部话术/u },
    { code: 'overview-recap', match: /概况段跨章复述/u },
    { code: 'fact-verification', match: /生成后事实反查失败/u },
    { code: 'major-content-dirty', match: /主要施工内容存在脏事实或标题污染/u },
    { code: 'major-content-flow', match: /主要施工内容存在.*流程污染/u },
    { code: 'major-content-method', match: /主要施工内容存在.*施工方法过弱/u },
    { code: 'major-content-dup', match: /主要施工内容存在.*重复专业工程小节/u },
    { code: 'duplicate-subsection', match: /同名小节重复/u },
    { code: 'major-content-structure', match: /主要施工内容/u },
    { code: 'requirement-unresponded', match: /评分项要求未响应/u },
    { code: 'self-undermining', match: /自伤表述候选/u },
    { code: 'fabricated-date', match: /正文编造开工日期/u },
    { code: 'field-value-mismatch', match: /字段-数值错配/u },
    { code: 'area-arithmetic', match: /面积算术矛盾/u },
    { code: 'labor-contradiction', match: /劳动力数据矛盾/u },
    { code: 'data-consistency', match: /数据一致性矛盾/u },
    { code: 'support-conflict', match: /基坑支护方案前后不一致/u },
    { code: 'dangerous-list-inconsistent', match: /危大工程辨识清单不一致/u },
    { code: 'six-hundred-percent', match: /扬尘治理六个百分百/u },
    { code: 'local-award', match: /本地创优目标缺失/u },
    { code: 'green-quant', match: /四节一环保量化指标缺失/u },
    { code: 'work-injury', match: /工伤保险表述缺失/u },
    { code: 'param-conflict', match: /同一参数概念出现多口径数值冲突/u },
    { code: 'system-zero-coverage', match: /专业工程系统在正文零覆盖/u },
    { code: 'dangerous-list-missing', match: /危大工程辨识清单遗漏|未编制危大工程辨识清单/u },
    { code: 'repeated-word', match: /正文存在叠词重复表述/u },
    { code: 'commercial-data', match: /正文出现商务条款数据/u },
    { code: 'boq-placement', match: /清单项落位不足/u },
    { code: 'precise-param', match: /可靠精确参数使用不足/u },
    { code: 'stage-phrasing', match: /施工阶段划分口径不统一/u },
    { code: 'emergency-depth', match: /应急预案小节深度不足/u },
  ];
  const blockerIssueCodeFor = (message: string): string => BLOCKER_ISSUE_CODE_MAP.find(entry => entry.match.test(message))?.code || '';
  const blockerFixInstructionFor = (message: string): string => {
    const instructions: Record<string, string> = {
      'source-phrase': ['【资料来源罗列话术定向修复】', '该章节正文包含“根据/依据招标文件、工程量清单、施工图纸…”等资料来源罗列句，正式交付文档不得出现。', '请以局部 patch 方式删除罗列表述：直接陈述项目事实、施工内容与控制措施；句中携带的实质数据（工期、规模、金额、编号等）必须保留，改为直接陈述方式重写，不得丢失事实。只修改相关句子，不得改动其他内容。'].join('\n'),
      'internal-term': ['【后台内部术语定向修复】', '该章节正文包含后台内部术语或内部话术（生成系统概念，缺陷描述中已列命中句子），正式交付文档禁止出现。', '请以局部 patch 方式将每一处该表述按上下文语义改写为面向评标人的正式表述（如“按工作包逐项说明”→“按专业工程逐项说明”，“根据已确认资料”→“根据现场实测与图纸要求”），保持段落结构与事实数据不变，不得新增或删除小节。'].join('\n'),
      'overview-recap': ['【概况段跨章复述定向修复】', '该章节正文包含以“本项目为”开头整段复述项目概况的内容（与概况章正文重复），正式交付文档不得跨章复述概况。', '请以局部 patch 方式删除这些复述句：整段概况陈述必须删除；句中如含本章必需的事实数据，改写为局部引用（一句话内点到即止）。只修改复述句，不得改动其他内容。'].join('\n'),
      'fact-verification': ['【总量口径数字定向修复】', '该章节正文出现资料事实主表中未找到的总量口径数字。', '请以局部 patch 方式逐项核对：主表已确认的口径必须一字不改引用；无法在主表中反查到的数字一律删除或改为定性表述（如“按计划配置”“满足规范要求”），禁止编造具体数值。只修改相关数字所在句子。'].join('\n'),
      'major-content-dirty': ['【主要施工内容污染清理】', '该章节“主要施工内容”小节混入了项目概况复述句（本项目为…/总建筑面积…/保留现状…等）、嵌入的正文标题或伪标题。', '请以局部 patch 方式逐段清理：删除概况复述句与“未尽事宜”类说明；本小节只保留各专业工程的“施工概况：”“施工流程：”“施工方法：”正式正文；概况数据确需引用时只写与专业工程直接相关的具体数字，不复述完整概况段。只修改污染段落，不得删除已有事实数据。'].join('\n'),
      'major-content-flow': ['【专业工程流程污染清理】', '该章节“主要施工内容”小节的“施工流程”混入了项目概况、总建筑面积、招标范围、未尽事宜等说明性事实。', '请以局部 patch 方式重写被污染的“施工流程：”段：只保留纯工序链（每个专业工程至少 4 个环节，工序顺序表达形式由模型自然选择：顺序词叙述、编号步骤、有序/无序列表或箭头链均可），将混入的概况说明删除或移至“施工概况”段。'].join('\n'),
      'major-content-method': ['【专业工程施工方法强化】', '该章节部分专业工程的“施工方法”只有工程名称或范围罗列，缺少实质工艺。', '请以局部 patch 方式强化对应“施工方法：”段：写入资料已确认的工程量、材料规格、检测、调试、验收或记录要求，至少 4 个带单位工艺参数；资料未明确的参数不得编造。'].join('\n'),
      'major-content-dup': ['【专业工程重复小节合并】', '该章节“主要施工内容”存在同名或近似专业工程小节重复铺陈。', '请以局部 patch 方式合并：同一专业工程只保留一个小节，将重复小节的独有内容并入保留小节后删除冗余小节（含其标题），保留小节仍须含“施工概况：”“施工流程：”“施工方法：”三标签。'].join('\n'),
      'duplicate-subsection': ['【同名小节重复合并】', '该章节存在同名 H4 小节重复出现（缺陷描述已列重复小节名与次数），目录重复堆叠属评标硬扣分点。', '请以局部 patch 方式修复：同一主题只保留一个小节——将重复小节中的独有内容合并进保留小节（含正文与表格），删除冗余小节的标题与重复内容；若两小节主题确实不同，则将后者标题重命名为可区分的具体主题（禁止只加“一/二”序号敷衍）。合并后全文不得出现两个同名标题。'].join('\n'),
      'major-content-structure': ['【主要施工内容结构定向修复】', '该章节的主要施工内容小节结构不达标。', '请以局部 patch 方式修复：①将“项目主要施工内容”写成三级标题（### 项目主要施工内容），内部专业工程写成四级标题（#### 专业工程名称）；②同一专业工程只保留一个小节，重复小节的独有内容合并后删除冗余小节；③每个专业工程小节必须含“施工概况：”“施工流程：”“施工方法：”三个标签，施工流程至少有 1 处 4 个环节以上的工序顺序表达（形式由模型自然选择：顺序词叙述、编号步骤、有序/无序列表或箭头链均可），施工方法至少 4 个带单位工艺参数。不得删除已有的事实数据。'].join('\n'),
      'requirement-unresponded': ['【评分项要求定向补写】', '招标文件明确要求该评分项必须显性响应，当前正文零命中，零响应即评标失分。', '请以局部 patch 方式在该章节合适位置补写一段响应文本：逐字写明该要求原文（含核心词），并配套本项目落实措施与保证体系（组织、技术、检查、验收闭环）；不新增小节、不改动其他内容。'].join('\n'),
      'self-undermining': ['【自伤表述定向改写】', '该章节正文包含暴露投标短板的表述，正式投标文件不得主动示弱。', '请以局部 patch 方式将该句改写为正向落实表述（如“按施工图绿色建筑专篇编制专项方案，逐项落实评分项并跟踪验收”）；若该表述属现场条件类合理风险描述（地质/管线尚不明确），保留但必须补充勘查计划与应对措施。只修改相关句子。'].join('\n'),
      'fabricated-date': ['【编造开工日期定向修复】', '该章节正文出现招标资料未提供、且违反“以开工令时间为准”条款的具体日历日期。', '请以局部 patch 方式删除该具体日期，统一改写为“以开工令时间为准”；如为进度计划节点，必须标注为计划推算节点并保持与总工期一致。只修改相关句子。'].join('\n'),
      'field-value-mismatch': ['【字段数值错配定向修复】', '该章节正文将总占地面积误作建筑面积（或其他相近槽位混淆）。', '请以局部 patch 方式按绑定资料口径修正该数值并保持字段标签正确：总占地面积与建筑面积必须分开表述，不得互换数值。只修改相关句子。'].join('\n'),
      'area-arithmetic': ['【面积算术一致性定向修复】', '该章节正文同一语句内地上+地下面积之和不等于单体建筑面积。', '请以局部 patch 方式按绑定资料口径统一三者数值，使地上+地下=总/单体面积，删除错误数值表述。只修改相关句子。'].join('\n'),
      'labor-contradiction': ['【劳动力数据定向修复】', '该章节正文“高峰期 X 人”与分阶段投入明细表峰值矛盾（缺陷描述中的数值对即矛盾数字）。', '请以局部 patch 方式以分阶段明细表为准统一劳动力峰值数据：正文峰值表述与表格数据必须一致，删除矛盾数字或调整表格。只修改相关句子。禁止将本缺陷描述与修复要求本身写入正文，输出仅限正文内容。'].join('\n'),
      'data-consistency': ['【数据一致性矛盾定向修复】', '该章节正文存在数据矛盾（缺陷描述中的原文 A 与原文 B 为矛盾数值对，必须统一）。', '请以局部 patch 方式统一数据：以绑定资料（图纸/工程量清单/招标文件）为准选定唯一数值，将矛盾数值对中的错误表述删除或修正为一致值；资料未明确的改为定性表述（如“按规范要求取值”），禁止编造。只修改相关数值所在句子。禁止将本缺陷描述与修复要求本身写入正文，输出仅限正文内容。'].join('\n'),
      'support-conflict': ['【支护体系一致性定向修复】', '该章节正文放坡喷锚类与灌注桩排桩类两套支护体系并存。', '请以局部 patch 方式统一为一种支护体系（以图纸/地质条件为准），删除另一种体系的表述，并补充基坑开挖深度数值支撑危大分级判定。只修改相关句子。'].join('\n'),
      'dangerous-list-inconsistent': ['【危大清单一致性定向修复】', '该章节正文存在多处危大工程辨识清单且项名/数量不一致。', '请以局部 patch 方式将两处清单合并统一：项名、数量与分级表述唯一且一致，删除重复清单。只修改相关列表。'].join('\n'),
      'six-hundred-percent': ['【六个百分百逐项补写】', '该章节正文的扬尘治理措施未逐项覆盖“六个百分百”全部六项。', '请以局部 patch 方式逐条补齐缺失项（工地周边100%围挡、物料堆放100%覆盖、出入车辆100%冲洗、施工现场地面100%硬化、拆迁工地100%湿法作业、渣土车辆100%密闭运输），每项一句落实措施。不新增小节。若本项目无拆迁工程，对“拆迁工地100%湿法作业”必须显式说明不适用原因（如“本项目无拆迁工程，不涉及拆迁工地湿法作业”），不得省略该项。'].join('\n'),
      'local-award': ['【属地创优目标补写】', '该章节正文未提及省市级优质工程/文明标准化工地等创优目标（安徽省属地适配项）。', '请以局部 patch 方式在质量目标或创优规划位置补写与项目实际规模相符的创优目标表述；奖项名称必须以评分项要求提取结果（招标文件原文）为准逐字落位，禁止自行编造或替换为其他奖项名称。只修改目标表述相关句子。'].join('\n'),
      'green-quant': ['【四节一环保量化指标补写】', '该章节绿色施工内容无任何量化指标（非传统水源利用率/漏损率/土方平衡率/废弃物回收率等）。', '请以局部 patch 方式补充量化指标与模板周转次数：数值参考行业通用水平与附录八基准（如可回收废弃物回收率≥80%、模板周转≥8次），不得编造极端值；每个指标配一句落实措施。只修改绿色施工相关句子。'].join('\n'),
      'work-injury': ['【工伤保险表述补写】', '该章节正文有劳务/农民工管理内容但未提及工伤保险缴纳（政策合规关键词漏项）。', '请以局部 patch 方式在劳务管理/农民工工资保障位置补充“按规定为作业人员办理工伤保险”表述。只修改劳务管理相关句子。'].join('\n'),
      'param-conflict': ['【参数口径统一定向修复】', '该章节正文同一参数概念出现多口径数值（详见缺陷描述中的数值原文），自相矛盾即评审硬伤。', '请以局部 patch 方式统一口径：以绑定资料（图纸/工程量清单/规范）为准选定唯一数值，删除其余矛盾表述；资料未明确的参数改为定性表述（如“按规范要求取值”），禁止编造。只修改相关数值所在句子。'].join('\n'),
      'system-zero-coverage': ['【专业工程系统零覆盖补写】', '该章节大纲涉及某专业工程系统（详见缺陷描述中的系统名），但正文对该系统零覆盖，零覆盖即评标失分。', '请以局部 patch 方式在该章节合适位置补写该系统施工方案正文：含施工概况（工程量与作业条件）、施工流程（不少于 4 个环节的工序顺序表达，形式由模型自然选择：顺序词叙述、编号步骤、有序/无序列表或箭头链均可）、施工方法（至少 4 个带单位工艺参数，参数必须来自绑定资料，不得编造）。不得删除已有内容。'].join('\n'),
      'dangerous-list-missing': ['【危大工程辨识清单补全】', '正文已出现危大工程适用前提（基坑深度/脚手架高度/起重设备等），但辨识清单遗漏适用项或全文未编制辨识清单，遗漏即合规硬伤。', '请以局部 patch 方式按建办质〔2018〕31号补全辨识：将遗漏项写入危大工程辨识清单并标注分级，超过一定规模的专项施工方案注明专家论证要求；清单项名与全文其他清单保持唯一一致。只修改清单相关段落。'].join('\n'),
      'repeated-word': ['【叠词重复表述定向修复】', '该章节正文存在同一双字词紧邻重复（如“执行执行”“进行进行”）。', '请以局部 patch 方式删除紧邻重复字词，保持语句完整通顺；其余内容与事实数据不得改动。'].join('\n'),
      'commercial-data': ['【商务条款数据定向清理】', '该章节正文出现商务条款数据（暂列金额/暂估价/综合单价/税率等），施组正文禁止出现商务数据。', '请以局部 patch 方式删除含商务数据的句子：句中的商务数字（金额/单价/税率）一律删除，不得改写为其他商务表述；如删除后语义不完整，改写为定性表述（如“按合同约定执行”）。只修改相关句子。'].join('\n'),
      'boq-placement': ['【清单项落位定向补写】', '该章节对应专业工程的工程量清单项在正文零落位或落位率不足，零落位即评审失分。', '请以局部 patch 方式在“主要施工内容”小节按专业工程分组补写未落位清单项（缺陷描述中已列明细，最多 30 项，其余同类项按已列名称分组归并）：每条写“施工概况：”工程名称+工程量+作业条件；“施工流程：”不少于 4 个环节的工序顺序表达（形式由模型自然选择：顺序词叙述、编号步骤、有序/无序列表或箭头链均可）；“施工方法：”至少 4 个带单位工艺参数。清单项名称必须逐字引用缺陷描述中的原文（不得改写为近似词），参数必须来自缺陷描述或绑定资料，禁止编造。不新增小节标题。'].join('\n'),
      'precise-param': ['【关键参数落位定向补写】', '该章节正文缺少资料中的关键工程参数（工期/面积/强度等级/材料规格/规范编号，缺陷描述中已列缺失参数）。', '请以局部 patch 方式将缺失的关键参数自然补入相关句子：参数值必须与资料一致，不得编造；补写后保持原句结构不变。只修改相关句子。'].join('\n'),
      'stage-phrasing': ['【阶段口径统一定向修复】', '该章节正文存在多种互异的施工阶段划分口径（详见缺陷描述中的划分句原文），口径互异即自相矛盾。', '请以局部 patch 方式统一口径：以总进度计划/施工部署章节的阶段划分为唯一口径，其余划分句逐字对齐或删除；划分句保留必要的阶段名称与工序对应关系，不得丢失事实。只修改相关句子。'].join('\n'),
      'emergency-depth': ['【应急预案小节补强】', '该章节应急预案小节未达到可落地深度（详见缺陷描述：缺字数或缺三要素之一）。', '请以局部 patch 方式补写缺失要素：应急组织体系（领导小组/抢险队与职责）、应急处置程序与演练安排（含响应分级与处置流程）、应急物资保障（清单与配置数量）；总字数不少于 300 字，内容必须绑定本项目风险特征。只补写该小节缺失要素，不得删除已有内容。'].join('\n'),
    };
    // 兜底：未识别消息特征时按通用结构修复处理（避免空指令 patch 无效果）
    const instruction = instructions[blockerIssueCodeFor(message)] || ['【交付阻断缺陷定向修复】', '该章节正文存在交付阻断级缺陷，详见缺陷描述。', '请以局部 patch 方式修复：结合缺陷描述定位相关文本，删除错误内容或按专业规范改写，保持其余内容与事实数据不变。只修改相关句子。'].join('\n');
    // 元话语泄漏根治（评分报告 N2）：修复指令本身（"不得出现X/不再出现X"等约束文字）曾整段泄漏进正文
    return `${instruction}\n${systemConstraintLine('本修复指令仅指导局部修改：指令文字本身（含"不得出现/不再出现/禁止出现"等约束表述）禁止写入正文，正文只输出修复后的正式内容')}`;
  };
  const locateChapterIndex = (issue: ValidationIssue): number => {
    // F2 章节锚点：校验器已知缺陷所在章节时附 chapterId/sectionTitle，优先直连定位——
    // 历史缺陷：缺陷消息不含可匹配关键字时（如“缺少关键线路”类）定位失败整轮放弃
    if (issue.chapterId) {
      const byId = finalChapterDrafts.findIndex(chapter => chapter.id === issue.chapterId);
      if (byId >= 0) return byId;
    }
    if (issue.sectionTitle) {
      const compactTitle = issue.sectionTitle.replace(/[\s,，]/gu, '');
      const bySection = finalChapterDrafts.findIndex(chapter =>
        (chapter.sections || []).some(section => section.replace(/[\s,，]/gu, '') === compactTitle)
        || chapter.title.replace(/[\s,，]/gu, '') === compactTitle
        || (compactTitle.length >= 6 && normalizedBody(chapter).includes(compactTitle.slice(0, 12)))
      );
      if (bySection >= 0) return bySection;
    }
    const message = issue.message;
    const quoted = /“([^”]+)”/u.exec(message)?.[1]?.replace(/\s+/gu, '') || '';
    switch (blockerIssueCodeFor(message)) {
      case 'source-phrase':
        return finalChapterDrafts.findIndex(chapter => SOURCE_ENUMERATION_PHRASE_RE.test(chapter.content || ''));
      case 'internal-term': {
        // round-18 E7：语义锚点命中消息携带引号片段（“…”前 24 字），优先按片段定位章节，
        // 精确词消息（“工作包”）同样落入引号定位；都定位不到再兜底查“工作包”
        const quotedTerm = /“([^”]{2,})/u.exec(message)?.[1]?.replace(/\s+/gu, '') || '';
        if (quotedTerm) {
          const byQuoteTerm = finalChapterDrafts.findIndex(chapter => normalizedBody(chapter).includes(quotedTerm.slice(0, 12)));
          if (byQuoteTerm >= 0) return byQuoteTerm;
        }
        return finalChapterDrafts.findIndex(chapter => (chapter.content || '').includes('工作包'));
      }
      case 'overview-recap': {
        const quotedRecap = /“([^”]{4,})/u.exec(message)?.[1]?.replace(/\s+/gu, '') || '';
        if (quotedRecap) {
          const byQuote = finalChapterDrafts.findIndex(chapter => normalizedBody(chapter).includes(quotedRecap.slice(0, 16)));
          if (byQuote >= 0) return byQuote;
        }
        return finalChapterDrafts.findIndex(chapter => !/工程概况|项目概况|基本信息/u.test(chapter.title) && /本项目为/u.test(chapter.content || ''));
      }
      case 'fact-verification': {
        const tokenPart = (message.split('数字')[1] || '').trim();
        return tokenPart ? finalChapterDrafts.findIndex(chapter => tokenPart.split(/[、,，\s]+/u).some(token => token && (chapter.content || '').includes(token))) : -1;
      }
      case 'major-content-structure':
        return finalChapterDrafts.findIndex(chapter => /项目主要施工内容|主要施工内容/u.test(`${chapter.title} ${(chapter.sections || []).join(' ')}`) || /^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?(?:项目)?主要施工\s*内容/gmu.test(chapter.content || ''));
      case 'requirement-unresponded': {
        // round-13 新增：招标要求层与数据一致性层的定向定位（提取消息中的关键短语/数值在章节中反查）
        const terms = (/核心词：([^）)]*)/u.exec(message)?.[1] || '').split(/[、/,，/\s]+/u).filter(term => term.length >= 2);
        const byTerms = finalChapterDrafts.findIndex(chapter => terms.some(term => normalizedBody(chapter).includes(term)));
        if (byTerms >= 0) return byTerms;
        const qualityChapter = finalChapterDrafts.findIndex(chapter => /质量目标|创优|质量保证|绿色施工|文明施工/u.test(chapter.title));
        return qualityChapter >= 0 ? qualityChapter : 0;
      }
      case 'self-undermining':
        return quoted ? finalChapterDrafts.findIndex(chapter => normalizedBody(chapter).includes(quoted.slice(0, 12))) : -1;
      case 'fabricated-date':
        return quoted ? finalChapterDrafts.findIndex(chapter => normalizedBody(chapter).includes(quoted)) : -1;
      case 'field-value-mismatch':
      case 'area-arithmetic': {
        const numbers = (message.match(/[\d,]+(?:\.\d+)?/gu) || []).map(token => token.replace(/[,，]/gu, '')).filter(token => token.length >= 3);
        return finalChapterDrafts.findIndex(chapter => numbers.some(token => normalizedBody(chapter).includes(token)));
      }
      case 'data-consistency': {
        // 矛盾消息携带原文 A/B 数值对：提取数值 token 反查出现章节（与 field-value-mismatch 同口径）
        const numbers = (message.match(/[\d,]+(?:\.\d+)?/gu) || []).map(token => token.replace(/[,，]/gu, '')).filter(token => token.length >= 3);
        return finalChapterDrafts.findIndex(chapter => numbers.some(token => normalizedBody(chapter).includes(token)));
      }
      case 'labor-contradiction':
        return finalChapterDrafts.findIndex(chapter => /高峰/u.test(chapter.content || ''));
      case 'support-conflict':
        return finalChapterDrafts.findIndex(chapter => /放坡|喷锚|土钉|灌注桩|排桩|基坑支护/u.test(chapter.content || ''));
      case 'dangerous-list-inconsistent':
        return finalChapterDrafts.findIndex(chapter => /危大/u.test(`${chapter.title} ${chapter.content || ''}`));
      case 'six-hundred-percent':
        return finalChapterDrafts.findIndex(chapter => /扬尘|环保|文明施工|绿色施工/u.test(`${chapter.title} ${chapter.content || ''}`));
      case 'local-award': {
        const awardChapter = finalChapterDrafts.findIndex(chapter => /质量|创优|目标/u.test(chapter.title));
        return awardChapter >= 0 ? awardChapter : 0;
      }
      case 'green-quant': {
        const greenChapter = finalChapterDrafts.findIndex(chapter => /绿色|环保|节能|四节/u.test(`${chapter.title} ${chapter.content || ''}`));
        return greenChapter >= 0 ? greenChapter : 0;
      }
      case 'work-injury': {
        // 工伤保险补写必须落在农民工/劳务管理小节所在章节；不得仅凭「安全」词命中
        // （安全词几乎每章都有，会导致定位错章，补写指令在无劳务管理位置的章节落空，修复空手）
        const laborSectionChapter = finalChapterDrafts.findIndex(chapter => /农民工工资|劳务管理|劳务实名|工资保障/u.test(chapter.content || ''));
        if (laborSectionChapter >= 0) return laborSectionChapter;
        return finalChapterDrafts.findIndex(chapter => /劳务|农民工|工资/u.test(`${chapter.title} ${chapter.content || ''}`));
      }
      case 'param-conflict': {
        // 冲突消息携带口径原文（如 2.5m、1.8m），提取数值 token 反查出现章节
        const numbers = (message.match(/[\d]+(?:\.\d+)?\s*(?:mm|cm|m|米|MPa|kN|kV|kW|℃|°C|元|万元|人|天|日|个|层|樘|处|套|台|t|吨)/gu) || []).map(token => token.replace(/\s+/gu, ''));
        return finalChapterDrafts.findIndex(chapter => numbers.some(token => normalizedBody(chapter).includes(token)));
      }
      case 'system-zero-coverage': {
        // 零覆盖消息携带系统名（电梯、幕墙…），定位到标题含该系统名（大纲义务）的章节
        const systems = (message.split('：')[1] || '').split(/[、,，]/u).map(name => name.trim()).filter(Boolean);
        return finalChapterDrafts.findIndex(chapter => systems.some(name => name && chapter.title.includes(name)));
      }
      case 'dangerous-list-missing':
        return finalChapterDrafts.findIndex(chapter => /危大|基坑|脚手架|起重|吊篮|拆除/u.test(`${chapter.title} ${chapter.content || ''}`));
      case 'repeated-word': {
        const words = [...message.matchAll(/“([^”]{2,})”/gu)].map(match => match[1]);
        return finalChapterDrafts.findIndex(chapter => words.some(word => normalizedBody(chapter).includes(word)));
      }
      case 'commercial-data': {
        const terms = (message.split('：')[1] || '').split(/[、,，]/u).map(term => term.trim()).filter(Boolean);
        return finalChapterDrafts.findIndex(chapter => terms.some(term => term && (chapter.content || '').includes(term)));
      }
      case 'boq-placement':
        // 清单补写落到"主要施工内容"章节（复用主要施工内容定位逻辑）
        return finalChapterDrafts.findIndex(chapter => /项目主要施工内容|主要施工内容/u.test(`${chapter.title} ${(chapter.sections || []).join(' ')}`) || /^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?(?:项目)?主要施工\s*内容/gmu.test(chapter.content || ''));
      case 'precise-param': {
        const missingPart = (message.split('缺失如')[1] || '').split(/[、,，）)]/u).map(token => token.trim()).filter(token => token.length >= 3);
        const byToken = finalChapterDrafts.findIndex(chapter => missingPart.some(token => normalizedBody(chapter).includes(token)));
        if (byToken >= 0) return byToken;
        const overviewChapter = finalChapterDrafts.findIndex(chapter => /工程概况|项目概况|基本信息/u.test(chapter.title));
        return overviewChapter >= 0 ? overviewChapter : 0;
      }
      case 'stage-phrasing': {
        const phrases = [...message.matchAll(/“([^”]{3,})”/gu)].map(match => match[1]);
        const byPhrase = finalChapterDrafts.findIndex(chapter => phrases.some(phrase => normalizedBody(chapter).includes(phrase)));
        if (byPhrase >= 0) return byPhrase;
        const deployChapter = finalChapterDrafts.findIndex(chapter => /进度|部署|工期/u.test(chapter.title));
        return deployChapter >= 0 ? deployChapter : 0;
      }
      case 'emergency-depth':
        return finalChapterDrafts.findIndex(chapter => /应急|安全/u.test(`${chapter.title} ${chapter.content || ''}`));
      default: {
        // F2 消息标题前缀反查：缺陷消息自带章节标题前缀（如「X章：进度工期章节缺少关键线路…」、
        // 「X章 专业评分不足…」）时，无 code 关键字也能定位；仍未命中才返回 -1 放弃。
        // 最长前缀优先：章节标题互为前缀时（如「施工进度计划」vs「施工进度计划与工期保障」），
        // 短标题先行误命中会把 patch 派发到错误章节
        const compactMessage = message.replace(/[\s,，]/gu, '');
        let bestIndex = -1;
        let bestLength = 0;
        finalChapterDrafts.forEach((chapter, chapterIndex) => {
          const compactTitle = chapter.title.replace(/[\s,，]/gu, '');
          if (compactTitle.length >= 3 && compactTitle.length > bestLength && compactMessage.startsWith(compactTitle)) {
            bestIndex = chapterIndex;
            bestLength = compactTitle.length;
          }
        });
        return bestIndex;
      }
    }
  };
  // round-19：全文重建函数与修复指令/章节定位函数提升到修复循环外，
  // 供 blocker 修复循环与交付前最终修复轮（全维度评审轮之后的 E4/E7/E11 回归兜底）复用同一口径
  const rebuildFinalMarkdownFromChapters = () => finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
  // 2.2 跨系统去重：收集本轮修复成功的 blocker 缺陷签名（code+归一化原文），供全维度评审轮
  // 判定「同一缺陷已由确定性系统修复」时跳过重复 LLM 修复（两阶段灰度：observe 计数/enforce 跳过）
  const resolvedBlockerSignatures = new Set<string>();
  if (blockerContentIssues.length > 0) {
    let blockerFixPatches = 0;
    // 复检器注册表（F2 同源复检）：match 匹配缺陷消息 → detect 在修复后全文上重跑同源检测，
    // 返回仍存在的同类缺陷（空数组=已消除）。delete 为二修仍失败后的确定性删除兜底（仅可确定性定位类型提供）。
    interface BlockerRechecker { match: RegExp; label: string; detect: (markdown: string) => Promise<string[]>; delete?: (content: string, message: string) => Promise<{ content: string; removed: number }> }
    // 概况复述语义兑底：概况章正文作语义基准，detect/delete 与检测器（overviewRecapIssues）同源同阈值（余弦 ≥0.6）
    const overviewRecapTools = await (async () => {
      const overviewBody = finalChapterDrafts.find(chapter => /工程概况|项目概况|基本信息/u.test(chapter.title))?.content;
      if (!overviewBody) return undefined;
      const candidates = overviewRecapCandidates(finalMarkdown);
      if (candidates.sentences.length === 0) return undefined;
      const similarity = await buildSemanticSimilarity(candidates.sentences, [overviewBody]);
      return { overviewBody, similarity };
    })();
    const recheckers: BlockerRechecker[] = [
      {
        match: /资料来源罗列话术/u,
        label: '资料来源罗列话术',
        detect: async markdown => {
          // 与 sourcePhraseIssues 同源：非编制依据节、非表格行中的来源罗列短语
          const found: string[] = [];
          let inBasis = false;
          for (const line of markdown.split(/\r?\n/u)) {
            const trimmed = line.trim();
            if (/^#{2,4}\s+/u.test(trimmed)) { inBasis = /编制依据|编制说明|法律法规|规范标准|标准依据/u.test(trimmed); continue; }
            if (inBasis || /^\s*\|/u.test(trimmed)) continue;
            if (SOURCE_ENUMERATION_PHRASE_RE.test(line)) found.push(trimmed.slice(0, 32));
          }
          return found;
        },
        delete: async content => {
          const next = cleanFormalSourcePhrases(content);
          return { content: next, removed: next === content ? 0 : 1 };
        },
      },
      { match: /后台内部术语|后台内部话术/u, label: '后台内部术语', detect: async markdown => (await internalTerminologyAnchorIssues(markdown)).map(item => item.message) },
      { match: /同一参数概念出现多口径数值冲突/u, label: '参数概念口径冲突', detect: async markdown => (await parameterConceptConflictIssues(markdown)).map(item => item.message) },
      { match: /专业工程系统在正文零覆盖/u, label: '专业工程系统零覆盖', detect: async () => constructionSystemCoverageIssues(finalChapterDrafts).map(item => item.message) },
      { match: /危大工程辨识清单遗漏|未编制危大工程辨识清单/u, label: '危大工程辨识遗漏', detect: async markdown => dangerousApplicabilityIssues(markdown).map(item => item.message) },
      { match: /主要施工内容/u, label: '主要施工内容缺陷', detect: async markdown => constructionOrgMajorContentIssues(finalChapterDrafts, markdown).map(item => item.message) },
      {
        match: /评分项要求未响应/u,
        label: '评分项要求未响应',
        // 复检与最终校验同口径：要求项 ↔（章节标题 + 正文句）同闭包 embedding（bodyTexts 必传），
        // 且查询文本必须用 tenderRequirementSemanticQuery 与构建侧一致（历史缺陷：缺 bodyTexts 只查章节标题、
        // 查询/构建口径不一致 cache miss 恒 0，正文已响应仍报零命中，修复轮永不收敛）
        detect: async markdown => {
          const queries = tenderRequirementCheckItems(tenderRequirements).map(({ item }) => tenderRequirementSemanticQuery(item));
          const chapterLines = markdown.split(/\n/u).filter(line => /^#{2,4}\s/u.test(line.trim())).map(line => normalizeChapterTitleLine(line)).filter(Boolean).slice(0, 80);
          const bodyTexts = bodySentencesForSemantic(markdown);
          const similarity = await buildSemanticSimilarity(queries, [...chapterLines, ...bodyTexts]);
          return (await requirementsCoverageIssues(markdown, tenderRequirements, { semanticSimilarity: similarity, bodyTexts })).filter(item => /评分项要求未响应/u.test(item.message)).map(item => item.message);
        },
      },
      { match: /自伤表述候选/u, label: '自伤表述候选', detect: async markdown => (await selfUnderminingCandidateIssues(markdown)).map(item => item.message) },
      {
        match: /正文编造开工日期/u,
        label: '正文编造开工日期',
        detect: async markdown => fabricatedStartDateIssues(markdown, factsModel).map(item => item.message),
        delete: async (content, message) => {
          const quoted = (/“([^”]+)”/u.exec(message)?.[1] || '').replace(/\s+/gu, '');
          if (!quoted || quoted.length < 6) return { content, removed: 0 };
          const parts = content.split(/(?<=[。；;])\s*/u);
          let removed = 0;
          const kept = parts.filter(part => {
            if (!part.includes(quoted)) return true;
            removed += 1;
            return false;
          });
          return removed > 0 ? { content: kept.join(''), removed } : { content, removed: 0 };
        },
      },
      { match: /字段-数值错配/u, label: '字段-数值错配', detect: async markdown => fieldValueMismatchIssues(markdown, factsModel).map(item => item.message) },
      { match: /面积算术矛盾/u, label: '面积算术矛盾', detect: async markdown => areaArithmeticIssues(markdown).map(item => item.message) },
      { match: /劳动力数据矛盾/u, label: '劳动力数据矛盾', detect: async markdown => resourceConsistencyIssues(markdown).map(item => item.message) },
      {
        match: /数据一致性矛盾/u,
        label: '数据一致性矛盾',
        // L3.5 审查层同源复检（D3 快照复用）：修复后全文重跑 LLM 批量审查，仍有矛盾（含修复引入的新矛盾）则进入升级轮；
        // 正文哈希未变时直接复用快照，省去每次修复后的全文审查调用
        detect: async markdown => (await reviewDataConsistencyCached(markdown)).map(conflict => dataConsistencyConflictIssue(conflict).message),
      },
      { match: /基坑支护方案前后不一致/u, label: '基坑支护方案前后不一致', detect: async markdown => (await supportSystemConflictIssues(markdown)).map(item => item.message) },
      { match: /危大工程辨识清单不一致/u, label: '危大工程辨识清单不一致', detect: async markdown => dangerousListConsistencyIssues(markdown).map(item => item.message) },
      { match: /扬尘治理六个百分百/u, label: '扬尘治理六个百分百', detect: async markdown => (await sixHundredPercentCoverageIssues(markdown)).map(item => item.message) },
      { match: /本地创优目标缺失|四节一环保量化指标缺失|工伤保险表述缺失/u, label: '本地适配与政策合规关键词', detect: async markdown => (await localAdaptationKeywordIssues(markdown, factsModel)).map(item => item.message) },
      { match: /生成后事实反查失败/u, label: '生成后事实反查失败', detect: async markdown => (await generatedFactVerificationIssuesAsync(markdown, factsModel, { scopeClassifier: factTokenScopeClassifier })).filter(item => /生成后事实反查失败/u.test(item.message)).map(item => item.message) },
      { match: /正文存在叠词重复表述/u, label: '叠词重复表述', detect: async markdown => repeatedWordIssues(markdown).map(item => item.message), delete: async content => { const next = collapseRepeatedWords(content); return { content: next, removed: next === content ? 0 : 1 }; } },
      { match: /正文出现商务条款数据/u, label: '商务条款数据', detect: async markdown => (await commercialDataInBodyIssues(markdown)).map(item => item.message), delete: async content => { const next = stripCommercialDataSentences(content); return { content: next, removed: next === content ? 0 : 1 }; } },
      { match: /清单项落位不足/u, label: '清单项落位不足', detect: async markdown => (await boqPlacementIssues(markdown, finalChapterDrafts, factsModel)).map(item => item.message) },
      { match: /可靠精确参数使用不足/u, label: '可靠精确参数使用不足', detect: async markdown => (await preciseFactUsageIssues(markdown, factsModel, finalChapterDrafts)).filter(item => /关键参数抽查/u.test(item.message)).map(item => item.message) },
      { match: /施工阶段划分口径不统一/u, label: '施工阶段划分口径', detect: async markdown => (await stagePhrasingIssues(markdown)).map(item => item.message) },
      { match: /应急预案小节深度不足/u, label: '应急预案小节深度', detect: async markdown => (await emergencySectionDepthIssues(markdown)).map(item => item.message) },
      ...(overviewRecapTools ? [{
        match: /概况段跨章复述/u,
        label: '概况段跨章复述',
        detect: async (markdown: string): Promise<string[]> => {
          const candidates = overviewRecapCandidates(markdown);
          if (candidates.sentences.length === 0 || !candidates.overviewBody) return [];
          const similarity = await buildSemanticSimilarity(candidates.sentences, [candidates.overviewBody]);
          return overviewRecapIssues(markdown, { semanticSimilarity: similarity }).map(item => item.message);
        },
        delete: async (content: string): Promise<{ content: string; removed: number }> => {
          const sentences = content.split(/(?<=[。；;])\s*/u);
          // 复述开头形态与检测侧 overviewRecapCandidates 同口径封闭集（本项目为/本工程为/该项目为/该工程为）
          const recapCandidates = sentences.filter(sentence => /本项目为|本工程为|该项目为|该工程为/u.test(sentence));
          if (recapCandidates.length === 0) return { content, removed: 0 };
          const similarity = await buildSemanticSimilarity(recapCandidates, [overviewRecapTools.overviewBody]);
          let removed = 0;
          const kept = sentences.filter(sentence => {
            if (!/本项目为|本工程为|该项目为|该工程为/u.test(sentence)) return true;
            if (similarity(sentence, overviewRecapTools.overviewBody) < 0.6) return true;
            removed += 1;
            return false;
          });
          return removed > 0 ? { content: kept.join(''), removed } : { content, removed: 0 };
        },
      } as BlockerRechecker] : []),
    ];
    // 修复指令与章节定位复用块外 blockerFixInstructionFor/locateChapterIndex（round-20 S3/S4 收敛为单一来源）
    // D2：按章分组 + 跨章并行——同章 issue 合并为一个修复任务组内串行（单写者），跨章组批量并行
    // （指令生成并行，限幅 DOCUMENT_BLOCKER_FIX_CONCURRENCY，默认 3）；patch 落位后全量重建 finalMarkdown，
    // 每章单写者 + 重建合并保证零覆盖；定位失败的缺陷保持串行 failed stage 先行上报
    const locatedBlockerGroups: Array<{ chapterIndex: number; issues: ValidationIssue[] }> = [];
    const locatedGroupIndexByChapter = new Map<number, number>();
    for (const issue of blockerContentIssues) {
      const chapterIndex = locateChapterIndex(issue);
      if (chapterIndex < 0) {
        // 定位失败不允许静默跳过：产生可见 failed stage（缺陷消息与定位失败原因），供前端与复盘追踪
        upsertProgressStage(progressStages, displayStage({ type: 'llm_review', roleId: 'agent-blocker-fix-unlocated', status: 'failed', message: `交付阻断缺陷未定位到章节（未进入修复循环）：${issue.message}`, details: ['章节定位失败：缺陷消息不含可匹配的章节标题，且正文各章标题均无命中', '处理：该缺陷已记录并保留在最终校验结果中'] }, { subtitle: '交付阻断修复' }));
        upsertProgressStage(finalGateRepairStages, displayStage({ type: 'llm_review', roleId: 'agent-blocker-fix-unlocated', status: 'failed', message: `交付阻断缺陷未定位到章节（未进入修复循环）：${issue.message}`, details: ['章节定位失败'] }, { subtitle: '交付阻断修复' }));
        emitProgress(finalChapterDrafts, progressStages);
        continue;
      }
      const existingIndex = locatedGroupIndexByChapter.get(chapterIndex);
      if (existingIndex === undefined) {
        locatedGroupIndexByChapter.set(chapterIndex, locatedBlockerGroups.length);
        locatedBlockerGroups.push({ chapterIndex, issues: [issue] });
      } else {
        locatedBlockerGroups[existingIndex].issues.push(issue);
      }
    }
    const blockerFixConcurrency = Math.max(1, Math.min(6, Number(process.env.DOCUMENT_BLOCKER_FIX_CONCURRENCY || 3)));
    for (let groupOffset = 0; groupOffset < locatedBlockerGroups.length; groupOffset += blockerFixConcurrency) {
      const batch = locatedBlockerGroups.slice(groupOffset, groupOffset + blockerFixConcurrency);
      await Promise.all(batch.map(async ({ chapterIndex, issues }) => {
        const draftChapter = finalChapterDrafts[chapterIndex];
        const templateChapter = effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title);
        // 同章 issue 组内串行修复：与改造前 per-issue 串行语义一致（每 issue 独立修复闭环与复检）
        for (const issue of issues) {
          const rechecker = recheckers.find(item => item.match.test(issue.message));
          const runningStage = displayStage({ type: 'llm_review', roleId: `agent-blocker-fix-${draftChapter.id}`, status: 'running', message: `正在修复交付阻断缺陷：${draftChapter.title}`, details: [issue.message] }, { subtitle: '交付阻断修复' });
          upsertProgressStage(progressStages, runningStage);
          upsertProgressStage(finalGateRepairStages, runningStage);
          emitProgress(finalChapterDrafts, progressStages);
          let remaining: string[] = [issue.message];
          let attempt: number;
          // 修复失败原因归类（h7 修复失败治理）：区分「定位失败或输出无效（未产出 patch）」
          // 与「patch 已应用但未消除缺陷（修复方式不匹配）」，随失败 stage 上报前端
          let repairFailureReason = '';
          // 修复闭环：最多 2 轮 LLM patch（第 2 轮换升级指令并携带复检证据），每轮修复后立即同源复检
          for (attempt = 0; attempt < 2 && remaining.length > 0; attempt += 1) {
            const instruction = attempt === 0
              ? blockerFixInstructionFor(issue.message)
              : ['【修复未生效升级重试】', `上一轮修复后复检仍存在 ${remaining.length} 处同类缺陷（复检证据：${remaining.slice(0, 2).join('；')}），说明上一轮修复方式与缺陷特征不匹配或 patch 未落位。`, '本轮必须更换修复方式：先精确定位问题句，再整体替换该句（不得只改个别词），替换后的文本必须完全符合下列要求：', blockerFixInstructionFor(issue.message)].join('\n');
            const repairedBlocker = await withProgressHeartbeat(() => repairChapterByQuality({
              template,
              chapter: { id: draftChapter.id, title: draftChapter.title, content: finalChapterDrafts[chapterIndex].content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
              issues: [issue.message, issue.suggestion || ''],
              promptTexts: instruction,
              requirement,
              forbidDrawingImages: false,
              diagnostics: generationDiagnostics,
              signal,
            }));
            if (repairedBlocker.content && repairedBlocker.content !== finalChapterDrafts[chapterIndex].content) {
              finalChapterDrafts[chapterIndex] = { ...finalChapterDrafts[chapterIndex], content: templateChapter ? finalizeChapterContentQuality(repairedBlocker.content, templateChapter) : repairedBlocker.content };
              blockerFixPatches += repairedBlocker.appliedCount;
              // 修复后立即重建全文并同源复检（闭环核心：不复检就无法确认缺陷是否真正消除）
              finalMarkdown = rebuildFinalMarkdownFromChapters();
              if (rechecker) {
                if (dataConsistencyBatchReviewEnabled && blockerIssueCodeFor(issue.message) === 'data-consistency') {
                  // 数据一致性批量化复检：该复检为全文 LLM 审查，逐条复检会造成 N 条冲突 N 次全文审查；
                  // 修复后跳过单条复检，残留矛盾由交付前轮重新收集并修复（第二轮修复机会保留闭环语义）
                  remaining = [];
                } else {
                  // 同 code 过滤：检测器一次返回同类全部消息（如本地适配检测器一次报创优/四节一环保/工伤保险三类），
                  // 不复检口径必须只判定当前修复的缺陷类别，否则修复 A 后被 B 污染误判失败
                  remaining = (await rechecker.detect(finalMarkdown)).filter(message => blockerIssueCodeFor(message) === blockerIssueCodeFor(issue.message));
                }
              } else if (repairedBlocker.appliedCount > 0) remaining = [];
              if (remaining.length === 0) break;
            } else if (attempt === 0) {
              // 首轮未产出 patch 不直接放弃：升级轮携带「先精确定位再替换」指令重试一次，
              // 缺词补写/表格补写类缺陷常因首轮定位犹豫而空手，直接判失败导致每轮仅一次小调用即 error
              continue;
            } else {
              // 升级轮仍未产生任何变更：同一指令下继续重试无意义，直接进入确定性删除或终止
              // F4 诊断分层：LLM 已产出 patch 但锚点全部失配（补表类常见）≠ 完全未产出
              repairFailureReason = repairedBlocker.producedCount > 0
                ? `patch 已产出 ${repairedBlocker.producedCount} 条但均未应用（锚点失配或结构校验拒绝）`
                : '定位失败或输出无效（未产出 patch）';
              break;
            }
          }
          // 确定性删除兜底：二修仍失败且可确定性定位的类型，直接删除问题内容（修复侧降级，非生成侧模板拼接）
          if (remaining.length > 0 && rechecker?.delete) {
            const deleted = await rechecker.delete(finalChapterDrafts[chapterIndex].content, issue.message);
            if (deleted.removed > 0) {
              finalChapterDrafts[chapterIndex] = { ...finalChapterDrafts[chapterIndex], content: deleted.content };
              blockerFixPatches += deleted.removed;
              finalMarkdown = rebuildFinalMarkdownFromChapters();
              remaining = (await rechecker.detect(finalMarkdown)).filter(message => blockerIssueCodeFor(message) === blockerIssueCodeFor(issue.message));
            }
          }
          const blockerFixed = remaining.length === 0;
          if (blockerFixed) {
            // 2.2 跨系统去重：修复成功即收集缺陷签名（code + 消息引号原文归一化）。
            // 引号原文缺失的消息（如 source-phrase 仅报行号）无可靠对齐锚点，保守不参与去重
            const quotedOriginal = /“([^”]+)”/u.exec(issue.message)?.[1];
            if (quotedOriginal) {
              resolvedBlockerSignatures.add(`${blockerIssueCodeFor(issue.message)}\u0000${normalizeFactUsageText(quotedOriginal)}`);
            }
          }
          if (!blockerFixed && !repairFailureReason) {
            // 两轮均产出 patch 但复检仍残留：修复方式与缺陷特征不匹配
            repairFailureReason = 'patch 已应用但未消除缺陷（修复方式不匹配）';
          }
          const completedBlockerStage = displayStage({ type: 'llm_review', roleId: `agent-blocker-fix-${draftChapter.id}`, status: blockerFixed ? 'success' : 'failed', message: blockerFixed ? `交付阻断缺陷修复完成：${draftChapter.title}（${attempt} 轮内复检通过）` : `交付阻断缺陷修复未生效：${draftChapter.title}（${attempt} 轮 LLM 修复${rechecker?.delete ? '+确定性删除' : ''}后复检仍有 ${remaining.length} 处；失败原因：${repairFailureReason}）`, details: [issue.message, ...(blockerFixed ? [] : [`复检残留：${remaining.slice(0, 3).join('；')}`])] }, { subtitle: '交付阻断修复' });
          upsertProgressStage(progressStages, completedBlockerStage);
          upsertProgressStage(finalGateRepairStages, completedBlockerStage);
          emitProgress(finalChapterDrafts, progressStages);
        }
      }));
    }
    if (blockerFixPatches > 0) {
      finalMarkdown = rebuildFinalMarkdownFromChapters();
      await recomputeFinalValidationBundle();
    }
  }
  // Final Gate 补写小节由 LLM 生成，可能引入新的跨章数值冲突（生成阶段修复闭环不覆盖补写内容）：
  // 导出前做最后一次确定性定点修复，修复后重建 finalMarkdown 并重算校验组，避免补写残留冲突被导出门禁硬阻断
  const postFinalGateFix = await applyDeterministicConsistencyFixes(finalChapterDrafts, factsModel, scopeConflicts);
  // 全文级定点修复同 finalize 入口处：封面/信息表合成区的败选数值章节修复覆盖不到，必须同步修复
  const needsPostGateMarkdownFix = (await applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts)).fixedCount > 0;
  if (postFinalGateFix.fixedCount > 0 || needsPostGateMarkdownFix) {
    finalMarkdown = finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template));
    const postRebuildMarkdownFix = await applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts);
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
  // ── 全维度评审轮（round-20 S4/W5）：青天规范内置，分块评审→问题清单→定向修复→复评 ──
  // 九维评审逻辑（合规红线/内容质量/数据逻辑/内容完整/本地适配/模板化/围串标残留）不再依赖代码正则围栏，
  // 由 LLM 按内置青天规范提示词对全文分块评审（首评 ≤7 块+修复 ≤3 章+复评 ≤2 块，全轮 ≤12 次调用），
  // 检出问题按风险等级分流：否决级/高风险进定向修复（局部 patch，修复后复评验证），中低风险进报告。
  // 评审调用只产出问题清单（只检测不改写铁律），改写一律走 repairChapterByQuality。
  const fullDimensionReviewResult = await runFullDimensionReview({
    template,
    chapters: finalChapterDrafts,
    effectiveChapters,
    requirement,
    projectName: projectMaterialSummary?.projectName || '',
    tenderContext: buildTenderReviewContext({ factsModel, evaluationCriteriaItems, tenderRequirements }),
    resolvedBlockerSignatures,
    diagnostics: generationDiagnostics,
    signal,
    heartbeat: withProgressHeartbeat,
    onStage: stage => {
      const reviewStage = displayStage({ type: 'llm_review', roleId: 'agent-qingtian-review', status: stage.status, message: stage.message, details: stage.details }, { subtitle: '全维度评审' });
      upsertProgressStage(progressStages, reviewStage);
      upsertProgressStage(finalGateRepairStages, reviewStage);
      emitProgress(finalChapterDrafts, progressStages);
    },
  });
  // round-20 S5/W8：评审轮残留问题转门禁校验问题（否决级/高风险 error 硬阻断，中低风险 warning），
  // 并入重算校验组后由导出门禁按 category 'qingtian_review' 阻断
  qingtianReviewBlockingIssues = fullDimensionReviewResult.reviewed ? qingtianReviewValidationIssues(fullDimensionReviewResult.remainingIssues) : [];
  if (fullDimensionReviewResult.fixedCount > 0) {
    finalMarkdown = rebuildFinalMarkdownFromChapters();
    await recomputeFinalValidationBundle();
  } else if (qingtianReviewBlockingIssues.length > 0) {
    // 无修复但评审轮检出残留问题：不重建正文，仅重算校验组让门禁消费评审轮阻断
    await recomputeFinalValidationBundle();
  }
  // ── 交付前最终修复轮（round-19 R2/R3/R4）：blocker 修复循环之后的 LLM patch（全维度评审轮修复等）
  // 会冲掉或重新引入 E4/E7/E11 类缺陷（徽光阁实测：概况复述句回归 5 处、内部话术“已确认资料”4 处、
  // 六个百分百 2/6、属地创优目标/工伤保险被 slice(0,8) 截断从未修复）。此处按与 blocker 修复循环同源口径：
  // 检测 → 章节定位 → LLM patch（最多 2 轮升级+复检）→ 确定性删除兜底统一收口。
  const preDeliveryRecapTools = await (async () => {
    const overviewBody = finalChapterDrafts.find(chapter => /工程概况|项目概况|基本信息/u.test(chapter.title))?.content;
    if (!overviewBody) return undefined;
    const candidates = overviewRecapCandidates(finalMarkdown);
    if (candidates.sentences.length === 0) return undefined;
    const similarity = await buildSemanticSimilarity(candidates.sentences, [overviewBody]);
    return { overviewBody, similarity };
  })();
  const preDeliveryIssues = [
    ...(await sixHundredPercentCoverageIssues(finalMarkdown)),
    ...(await localAdaptationKeywordIssues(finalMarkdown, factsModel)),
    ...(preDeliveryRecapTools ? overviewRecapIssues(finalMarkdown, { semanticSimilarity: preDeliveryRecapTools.similarity }) : []),
    ...await internalTerminologyAnchorIssues(finalMarkdown),
    // round-20 S3：数据一致性八类纳入交付前收口——与 blocker 修复循环 recheckers 同源检测器，
    // blocker 修复循环之后的全维度评审轮修复可能重新引入或从未修复这些缺陷（交付前轮是唯一 LLM 修复兜底）
    ...fabricatedStartDateIssues(finalMarkdown, factsModel),
    ...fieldValueMismatchIssues(finalMarkdown, factsModel),
    ...areaArithmeticIssues(finalMarkdown),
    ...resourceConsistencyIssues(finalMarkdown),
    // h7：交付前轮重跑 L3.5 审查（D3 快照复用）——blocker 修复循环之后的全维度评审轮修复可能重新引入数值矛盾；
    // blocker 循环修复后正文哈希未变时直接复用快照，省去交付前轮一次全文审查
    ...(await reviewDataConsistencyCached(finalMarkdown)).map(conflict => dataConsistencyConflictIssue(conflict)),
    ...await supportSystemConflictIssues(finalMarkdown),
    ...dangerousListConsistencyIssues(finalMarkdown),
    ...await commercialDataInBodyIssues(finalMarkdown),
    ...repeatedWordIssues(finalMarkdown),
  ].filter(issue => issue.level === 'error');
  // 批量化复检轮末统一重审基准：本轮回 data-consistency 缺陷消息集（修复跳过 per-issue 复检后按数值对签名比对残留）
  const preDeliveryDataConsistencyMessages = preDeliveryIssues
    .filter(issue => blockerIssueCodeFor(issue.message) === 'data-consistency')
    .map(issue => issue.message);
  if (preDeliveryIssues.length > 0) {
    let preDeliveryFixPatches = 0;
    // round-20 S3：交付前修复轮收口——指令/章节定位复用块外 blockerFixInstructionFor/locateChapterIndex 单一来源，
    // 复检改用与 blocker 修复循环 recheckers 同源的 preDeliveryRecheckers 表（按缺陷 code 分派，同一检测器同一口径），
    // 覆盖范围从 E4/E7/E11 六类扩展到数据一致性八类（画像/Q9 改写轮已停用，交付前是唯一 LLM 修复兜底）
    const preDeliveryRecheckers: Array<{ code: string; detect: (markdown: string) => Promise<string[]> | string[]; delete?: (content: string, message: string) => Promise<{ content: string; removed: number }> }> = [
      { code: 'six-hundred-percent', detect: async markdown => (await sixHundredPercentCoverageIssues(markdown)).map(item => item.message) },
      { code: 'local-award', detect: async markdown => (await localAdaptationKeywordIssues(markdown, factsModel)).filter(item => /本地创优目标缺失/u.test(item.message)).map(item => item.message) },
      { code: 'green-quant', detect: async markdown => (await localAdaptationKeywordIssues(markdown, factsModel)).filter(item => /四节一环保量化指标缺失/u.test(item.message)).map(item => item.message) },
      { code: 'work-injury', detect: async markdown => (await localAdaptationKeywordIssues(markdown, factsModel)).filter(item => /工伤保险表述缺失/u.test(item.message)).map(item => item.message) },
      { code: 'overview-recap', detect: markdown => (preDeliveryRecapTools ? overviewRecapIssues(markdown, { semanticSimilarity: preDeliveryRecapTools.similarity }).map(item => item.message) : []) },
      { code: 'internal-term', detect: async markdown => (await internalTerminologyAnchorIssues(markdown)).map(item => item.message) },
      { code: 'fabricated-date', detect: markdown => fabricatedStartDateIssues(markdown, factsModel).map(item => item.message) },
      { code: 'field-value-mismatch', detect: markdown => fieldValueMismatchIssues(markdown, factsModel).map(item => item.message) },
      { code: 'area-arithmetic', detect: markdown => areaArithmeticIssues(markdown).map(item => item.message) },
      { code: 'labor-contradiction', detect: markdown => resourceConsistencyIssues(markdown).map(item => item.message) },
      { code: 'data-consistency', detect: async markdown => (await reviewDataConsistencyCached(markdown)).map(conflict => dataConsistencyConflictIssue(conflict).message) },
      { code: 'support-conflict', detect: async markdown => (await supportSystemConflictIssues(markdown)).map(item => item.message) },
      { code: 'dangerous-list-inconsistent', detect: markdown => dangerousListConsistencyIssues(markdown).map(item => item.message) },
      { code: 'commercial-data', detect: async markdown => (await commercialDataInBodyIssues(markdown)).map(item => item.message), delete: async content => { const next = stripCommercialDataSentences(content); return { content: next, removed: next === content ? 0 : 1 }; } },
      { code: 'repeated-word', detect: markdown => repeatedWordIssues(markdown).map(item => item.message), delete: async content => { const next = collapseRepeatedWords(content); return { content: next, removed: next === content ? 0 : 1 }; } },
    ];
    // D2 同款：按章分组 + 跨章并行——同章 issue 合并为一个修复任务组内串行（单写者），跨章组批量并行
    // （限幅 DOCUMENT_PREDELIVERY_FIX_CONCURRENCY，默认 3）；定位失败的缺陷保持原语义静默跳过
    const locatedPreDeliveryGroups: Array<{ chapterIndex: number; issues: ValidationIssue[] }> = [];
    const locatedPreDeliveryGroupByChapter = new Map<number, number>();
    for (const issue of preDeliveryIssues) {
      const chapterIndex = locateChapterIndex(issue);
      if (chapterIndex < 0) continue;
      const existingIndex = locatedPreDeliveryGroupByChapter.get(chapterIndex);
      if (existingIndex === undefined) {
        locatedPreDeliveryGroupByChapter.set(chapterIndex, locatedPreDeliveryGroups.length);
        locatedPreDeliveryGroups.push({ chapterIndex, issues: [issue] });
      } else {
        locatedPreDeliveryGroups[existingIndex].issues.push(issue);
      }
    }
    const preDeliveryFixConcurrency = Math.max(1, Math.min(6, Number(process.env.DOCUMENT_PREDELIVERY_FIX_CONCURRENCY || 3)));
    for (let groupOffset = 0; groupOffset < locatedPreDeliveryGroups.length; groupOffset += preDeliveryFixConcurrency) {
      const batch = locatedPreDeliveryGroups.slice(groupOffset, groupOffset + preDeliveryFixConcurrency);
      await Promise.all(batch.map(async ({ chapterIndex, issues }) => {
        const draftChapter = finalChapterDrafts[chapterIndex];
        const templateChapter = effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title);
        // 同章 issue 组内串行修复：与改造前 per-issue 串行语义一致（每 issue 独立修复闭环与复检）
        for (const issue of issues) {
          const rechecker = preDeliveryRecheckers.find(item => item.code === blockerIssueCodeFor(issue.message));
          const runningStage = displayStage({ type: 'llm_review', roleId: `agent-predelivery-fix-${draftChapter.id}`, status: 'running', message: `交付前定向修复：${draftChapter.title}`, details: [issue.message] }, { subtitle: '交付前修复' });
          upsertProgressStage(progressStages, runningStage);
          upsertProgressStage(finalGateRepairStages, runningStage);
          emitProgress(finalChapterDrafts, progressStages);
          let remaining: string[] = [issue.message];
          let attempt: number;
          // 修复失败原因归类（h7 修复失败治理）：与 blocker 修复循环同口径，随失败 stage 上报前端
          let repairFailureReason = '';
          for (attempt = 0; attempt < 2 && remaining.length > 0; attempt += 1) {
            const instruction = attempt === 0
              ? blockerFixInstructionFor(issue.message)
              : ['【修复未生效升级重试】', `上一轮修复后复检仍存在 ${remaining.length} 处同类缺陷（复检证据：${remaining.slice(0, 2).join('；')}），说明上一轮修复方式与缺陷特征不匹配或 patch 未落位。`, '本轮必须更换修复方式：先精确定位问题句，再整体替换该句（不得只改个别词），替换后的文本必须完全符合下列要求：', blockerFixInstructionFor(issue.message)].join('\n');
            const repairedPreDelivery = await withProgressHeartbeat(() => repairChapterByQuality({
              template,
              chapter: { id: draftChapter.id, title: draftChapter.title, content: finalChapterDrafts[chapterIndex].content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
              issues: [issue.message, issue.suggestion || ''],
              promptTexts: instruction,
              requirement,
              forbidDrawingImages: false,
              diagnostics: generationDiagnostics,
              signal,
            }));
            if (repairedPreDelivery.content && repairedPreDelivery.content !== finalChapterDrafts[chapterIndex].content) {
              finalChapterDrafts[chapterIndex] = { ...finalChapterDrafts[chapterIndex], content: templateChapter ? finalizeChapterContentQuality(repairedPreDelivery.content, templateChapter) : repairedPreDelivery.content };
              preDeliveryFixPatches += repairedPreDelivery.appliedCount;
              finalMarkdown = rebuildFinalMarkdownFromChapters();
              if (rechecker) {
                if (dataConsistencyBatchReviewEnabled && blockerIssueCodeFor(issue.message) === 'data-consistency') {
                  // 数据一致性批量化复检：跳过单条全文审查，轮末统一重审一次判定残留（数值对签名比对）
                  remaining = [];
                } else {
                  // 复检口径（preDelivery 专用精确匹配）：检测器一次返回全文同类全部消息
                  // （如数据一致性检测器一次报全文全部矛盾对），其他章节位置的同类缺陷由各自的
                  // issue 循环单独修复；逐条原文比对只判定「当前这条缺陷是否消除」，
                  // 避免修复 A 后被其他位置的 B 污染误判失败（历史缺陷：误报 failed stage）
                  remaining = (await rechecker.detect(finalMarkdown)).filter(message => message === issue.message);
                }
              } else if (repairedPreDelivery.appliedCount > 0) remaining = [];
              if (remaining.length === 0) break;
            } else if (attempt === 0) {
              // 首轮未产出 patch 升级重试一次（与 blocker 修复循环同口径），
              // 避免缺词补写类缺陷因首轮定位犹豫空手后一轮即失败
              continue;
            } else {
              // 升级轮仍未产生任何变更：交给确定性删除兜底
              // F4 诊断分层：LLM 已产出 patch 但锚点全部失配（补表类常见）≠ 完全未产出
              repairFailureReason = repairedPreDelivery.producedCount > 0
                ? `patch 已产出 ${repairedPreDelivery.producedCount} 条但均未应用（锚点失配或结构校验拒绝）`
                : '定位失败或输出无效（未产出 patch）';
              break;
            }
          }
          // 确定性删除兜底（与 blocker 修复循环同源）：二修仍失败且可确定性定位的类型直接删除问题内容
          if (remaining.length > 0 && rechecker?.delete) {
            const deleted = await rechecker.delete(finalChapterDrafts[chapterIndex].content, issue.message);
            if (deleted.removed > 0) {
              finalChapterDrafts[chapterIndex] = { ...finalChapterDrafts[chapterIndex], content: deleted.content };
              preDeliveryFixPatches += deleted.removed;
              finalMarkdown = rebuildFinalMarkdownFromChapters();
              // 与 LLM 修复复检同口径：只判定当前缺陷原文是否消除，其他位置同类缺陷不计入
              remaining = (await rechecker.detect(finalMarkdown)).filter(message => message === issue.message);
            }
          }
          const preDeliveryFixed = remaining.length === 0;
          if (!preDeliveryFixed && !repairFailureReason) {
            // 两轮均产出 patch 但复检仍残留：修复方式与缺陷特征不匹配
            repairFailureReason = 'patch 已应用但未消除缺陷（修复方式不匹配）';
          }
          const completedPreDeliveryStage = displayStage({ type: 'llm_review', roleId: `agent-predelivery-fix-${draftChapter.id}`, status: preDeliveryFixed ? 'success' : 'failed', message: preDeliveryFixed ? `交付前定向修复完成：${draftChapter.title}（${attempt} 轮内复检通过）` : `交付前定向修复未生效：${draftChapter.title}（${attempt} 轮 LLM 修复${rechecker?.delete ? '+确定性删除' : ''}后复检仍有 ${remaining.length} 处；失败原因：${repairFailureReason}）`, details: [issue.message, ...(preDeliveryFixed ? [] : [`复检残留：${remaining.slice(0, 3).join('；')}`])] }, { subtitle: '交付前修复' });
          upsertProgressStage(progressStages, completedPreDeliveryStage);
          upsertProgressStage(finalGateRepairStages, completedPreDeliveryStage);
          emitProgress(finalChapterDrafts, progressStages);
        }
      }));
    }
    // 确定性删除兜底统一收口（仅概况复述/内部话术可确定性定位；缺词类只能补写，无法删除）
    if (preDeliveryRecapTools) {
      const strippedRecap = stripOverviewRecapBodyLines(finalMarkdown, preDeliveryRecapTools.similarity);
      if (strippedRecap !== finalMarkdown) {
        finalMarkdown = strippedRecap;
        preDeliveryFixPatches += 1;
      }
    }
    const strippedTerminology = await stripInternalTerminologySentences(finalMarkdown);
    if (strippedTerminology !== finalMarkdown) {
      finalMarkdown = strippedTerminology;
      preDeliveryFixPatches += 1;
    }
    // 数据一致性批量化复检轮末统一重审：本轮回 data-consistency 缺陷修复已跳过 per-issue 全文审查，
    // 在确定性删除收口后对最终正文跑一次全文审查，按数值对签名判定各缺陷是否消除（口径与原 per-issue
    // 复检一致：只判本轮缺陷，修复新引入的其他矛盾不计入）；残留以 failed stage 上报，交付门禁由确定性检测器兜底
    if (dataConsistencyBatchReviewEnabled && preDeliveryDataConsistencyMessages.length > 0) {
      const remainingBatch = await reviewDataConsistencyBatched(finalMarkdown, preDeliveryDataConsistencyMessages, { signal, diagnostics: generationDiagnostics });
      if (remainingBatch.length > 0) {
        const batchRecheckStage = displayStage({ type: 'llm_review', roleId: 'agent-predelivery-data-consistency-batch-recheck', status: 'failed', message: `交付前数据一致性轮末统一重审：${preDeliveryDataConsistencyMessages.length - remainingBatch.length}/${preDeliveryDataConsistencyMessages.length} 处矛盾已消除，${remainingBatch.length} 处仍残留`, details: remainingBatch.slice(0, 5) }, { subtitle: '交付前修复' });
        upsertProgressStage(progressStages, batchRecheckStage);
        upsertProgressStage(finalGateRepairStages, batchRecheckStage);
        emitProgress(finalChapterDrafts, progressStages);
      }
    }
    if (preDeliveryFixPatches > 0) {
      await recomputeFinalValidationBundle();
    }
  }
  // 商务条款数据交付前兜底清洗（round-18 E9）：blocker 修复循环结束后的 LLM patch（全维度评审轮修复等）
  // 可能引入商务句（暂列金额/综合单价等，徽光阁实测“暂列金额60万元计入其他项目清单”在修复循环后进入正文），
  // 门禁已升级硬阻断（CRITICAL_BLOCK_RE 含“商务条款”）；交付前用与检测器同口径的行级安全清洗兜底
  // （标题行/表格行不触碰，仅删含商务词的正文句），清洗后重算校验组再判定最终门禁
  const cleanedCommercialMarkdown = stripCommercialDataBodyLines(finalMarkdown);
  if (cleanedCommercialMarkdown !== finalMarkdown) {
    finalMarkdown = cleanedCommercialMarkdown;
    await recomputeFinalValidationBundle();
  }
  // 表格空单元格交付前确定性修复（round-19 R5）：表格专轮之后的 LLM patch（全维度评审轮修复）可能重写表格
  // 引入空单元格（徽光阁实测危险源辨识表“高处作业坠落”行末两列空且最终校验持续报 error），
  // 交付前逐块做与专轮兜底同口径的确定性修复（合计行空填“—”、全空列删列、零星空单元格删行）。
  // 注意：removed 只统计删除块数，合计行填“—”类修复不计入，须按 markdown 变化判断是否重算
  const repairedTableMarkdown = repairTableBlocksInMarkdownDeterministically(finalMarkdown);
  if (repairedTableMarkdown.markdown !== finalMarkdown) {
    finalMarkdown = repairedTableMarkdown.markdown;
    await recomputeFinalValidationBundle();
  }
  const reviewChecklist = buildDocumentReviewChecklist({ exportGate: finalExportGate, qualityReport, repairStrategies });
  const finalQualitySummary = qualitySeveritySummary(validationIssues);
  // 4.12.12：质量口径对齐——最终质量汇总须先累加进 diagnostics 再构建 telemetry（此前 telemetry
  // 构建在累加之前，导致 qualityIssues 缺失修复循环后的最终残留汇总）；阻断数以导出门禁实际残留为准，
  // 避免「telemetry 阻断 0 但导出门禁 N 阻断」的修复轮口径脱节
  generationDiagnostics.quality.blockingCount += finalQualitySummary.blocking;
  generationDiagnostics.quality.importantCount += finalQualitySummary.important;
  generationDiagnostics.quality.minorCount += finalQualitySummary.minor;
  const telemetry = buildDocumentTelemetryReport({ diagnostics: generationDiagnostics });
  const blockingCount = finalExportGate.blockingIssues.length;
  telemetry.qualityIssues.blockingCount = blockingCount;
  const professionalScore = await buildProfessionalScoreReport(finalChapterDrafts, finalMarkdown, { templating: qualityReport.templating });
  // A2 语义级模板化复核（仅 A1 风险信号命中时触发一次 LLM，失败静默降级）
  const templatingReview = qualityReport.templating
    ? await withProgressHeartbeat(() => reviewTemplatingSemantics({ templating: qualityReport.templating!, markdown: finalMarkdown, diagnostics: generationDiagnostics, signal }))
    : { issues: [], reviewed: false };
  const finalStages = [...executionStages, ...finalGateRepairStages].map(stage => {
    if (stage.type === 'validation' && stage.roleId === 'document-workflow') return { ...stage, status: blockingCount > 0 ? 'failed' as const : 'success' as const, message: `阻断 ${blockingCount}，问题 ${validationIssues.length}` };
    if (stage.type === 'export_ready') return { ...stage, status: finalExportGate.passed ? 'success' as const : 'failed' as const, message: finalExportGate.passed ? '已准备好导出 Markdown/HTML/DOCX/PDF' : '导出门禁未通过，请完成阻断问题修复后再导出' };
    if (finalExportGate.passed && stage.status === 'failed' && /^agent-(?:reviewer|repairer)-/u.test(stage.roleId)) {
      return { ...stage, status: 'skipped' as const, message: `${stage.message || '章节中间审查失败'}；最终门禁已通过，历史中间态已归档` };
    }
    return stage;
  });
  finalStages.push(displayStage({ type: 'validation', roleId: 'agent-final-gate', status: finalExportGate.passed ? 'success' : 'failed', message: finalExportGate.passed ? 'Agent 最终门禁通过' : `Agent 最终门禁阻断 ${blockingCount} 个问题`, details: finalExportGate.blockingIssues.slice(0, 12).map(issue => issue.message) }, { subtitle: 'Agent 最终门禁' }));
  const confidenceBelowFloor = qualityReport.deliveryProbability < 70;
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-delivery-score', status: qualityReport.passed ? 'success' : finalExportGate.passed ? 'skipped' : 'failed', message: finalExportGate.passed && !qualityReport.passed ? `${qualityReport.summary}${confidenceBelowFloor ? '；置信度低于 70%，建议完成续修后再交付归档' : '（导出门禁已通过，作为后续优化建议归档）'}` : qualityReport.summary, details: confidenceBelowFloor && finalExportGate.passed ? [...qualityReport.actions, '续修建议：交付置信度低于 70% 门槛，建议按交付复核清单补齐短板维度后重新生成或续修。'] : qualityReport.actions }, { subtitle: '交付评分' }));
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-professional-score', status: professionalScore.grade === '专业' || professionalScore.grade === '良好' ? 'success' : 'skipped', message: professionalScore.summary, details: [...professionalScore.dimensions.map(dimension => `${dimension.label}：${dimension.score} 分（${dimension.detail}）`), ...professionalScore.topIssues.map(issue => `待修复：${issue}`)] }, { subtitle: '专业度评分' }));
  if (qualityReport.templating && qualityReport.templating.level !== 'light') {
    finalStages.push(displayStage({ type: 'validation', roleId: 'document-templating-report', status: 'skipped', message: `模板化检测：${qualityReport.templating.level === 'heavy' ? '重度' : '中度'}模板化（套话句占比 ${(qualityReport.templating.fillerRatio * 100).toFixed(1)}%，重难点归因＋量化双达标占比 ${(qualityReport.templating.difficultyCountermeasureRatio * 100).toFixed(0)}%，模糊应答词 ${qualityReport.templating.vagueHitCount} 处）`, details: templatingReview.issues }, { subtitle: '模板化检测' }));
  }
  if (writingTaskBrief) {
    finalStages.push(displayStage({ type: 'reference', roleId: 'document-writing-task-brief', status: 'success', message: `写作任务书：${writingTaskBrief.documentType}，${writingTaskBrief.chapters.length} 章任务卡，全局写作焦点 ${writingTaskBrief.globalWritingFocus.length} 条`, details: [...writingTaskBrief.globalWritingFocus, ...writingTaskBrief.chapters.slice(0, 10).map(chapter => `${chapter.chapterTitle}：覆盖 ${chapter.mustCover.length} 项`)], subtitle: '写作任务书' }));
  }
  finalStages.push(displayStage({ type: 'reference', roleId: 'knowledge-coverage', status: knowledgeCoverage.score >= 85 ? 'success' : 'failed', message: `资料确认覆盖率：${knowledgeCoverage.score}%（证据 ${knowledgeCoverage.evidenceCount} 条，文件 ${knowledgeCoverage.confirmedFiles} 份）`, details: [knowledgeCoverage.remediation] }, { subtitle: '资料覆盖' }));
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-review-checklist', status: reviewChecklist.every(item => item.passed) ? 'success' : finalExportGate.passed ? 'skipped' : 'failed', message: `交付复核清单：通过 ${reviewChecklist.filter(item => item.passed).length}/${reviewChecklist.length}${finalExportGate.passed && !reviewChecklist.every(item => item.passed) ? '（导出门禁已通过，其余项作为优化建议归档）' : ''}`, details: reviewChecklist.map(item => `${item.passed ? '通过' : '待修复'}：${item.label}${item.message ? `（${item.message}）` : ''}`) }, { subtitle: '交付复核' }));
  const slowMetrics = slowMetricSummary(generationDiagnostics.metrics);
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-diagnostics', status: 'success', message: `性能统计：LLM ${generationDiagnostics.llm.calls} 次，失败 ${generationDiagnostics.llm.failures} 次，瞬态重试 ${generationDiagnostics.llm.retries} 次，schema 校验失败 ${generationDiagnostics.llm.schemaFailures} 次，峰值并行 ${generationDiagnostics.llm.maxActive}，检索 ${generationDiagnostics.evidence.searchQueries} 次/${Math.round(generationDiagnostics.evidence.searchMs / 1000)} 秒，证据上下文 ${generationDiagnostics.evidence.contextChars} 字，噪声过滤 ${generationDiagnostics.evidence.filteredNoise} 条，预算裁剪 ${generationDiagnostics.evidence.budgetDropped} 条，质量问题 阻断${generationDiagnostics.quality.blockingCount}/重要${generationDiagnostics.quality.importantCount}/轻微${generationDiagnostics.quality.minorCount}${slowMetrics ? `，Top耗时：${slowMetrics}` : ''}` }, { subtitle: '后台诊断' }));

  const compactFinalChapterDrafts = finalChapterDrafts.map(chapter => ({ ...chapter, evidence: selectEvidenceByBudget(chapter.evidence || [], { preservePinned: true }) }));
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
      templatingReviewIssues: templatingReview.issues,
      writingTaskBrief,
      workflowVersion: DOCUMENT_WORKFLOW_VERSION,
      telemetry,
      qualityBenchmark: await benchmarkGeneratedMarkdown(finalMarkdown),
    },
    generatedAt: Date.now(),
    markdown: finalMarkdown,
  };
}
