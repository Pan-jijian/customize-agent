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
import { cleanFormalSourcePhrases, composeDocumentMarkdown, dedupeTertiaryH4Titles, finalizeDocumentMarkdown, normalizeTertiaryHeadings, plannedStructureIssues, sanitizeFormalMarkdown } from './markdownComposer';
import { documentBudgetIssues, documentTextLength, pageTargetIssues } from './budget';
import { applySpecGateRules, autoSpecGateRequiredTexts, buildExportGate, qualitySeveritySummary, applyDeterministicConsistencyFixes, applyDeterministicConsistencyFixesToMarkdown, markdownTableQualityIssues, headingUncoveredEngineeringItems } from './qualityValidation';
import { applyNumericConsistencyDeterministicFixes, collapseRepeatedWords, extractAssemblyRateAuthority, extractGreeningMaintenanceAuthority, extractProjectScaleSummary, extractScheduleAuthority, extractSupportSystemAuthority, fixFinishThickness, fixGreeningMaintenanceMismatch, fixFormulaResidues, fixLaborPeakConflict, fixMetaDiscourseDeclarations, fixParagraphOpeningRepeats, fixSelfUnderminingCandidates, fixTableBorneContentSections, fixTruncatedSentenceArtifacts, fixTocFromBody, mergeTableLineResidues, runDeterministicChainUntilConverged, runFixUntilClean, stripCommercialDataBodyLines, stripCrossChapterSemanticDuplicateParagraphs, stripDuplicateTables, stripDuplicateTablesAcrossChapters, stripInternalDuplicateTableRows } from './documentIntegrityChecks';
import { fixInternalTermHeadingPhrases, internalTerminologyAnchorIssues, stripInternalTerminologySentences } from './internalTerminologyAnchors';
import { semanticChoiceConflicts, semanticChoiceConflictIssue } from './dataConsistencyReview';
import { blueprintPlanAuthorities, extractDecisionLockEntries } from './integratedBlueprint';
import type { BlueprintData } from './integratedBlueprint';
import { buildStandardFinalValidationIssues, crossChapterDuplicateSectionIssues } from './documentFinalValidation';
import { fixEmptyScoringResponses, fixScoringRequirementResponses } from './tenderRequirements';
import { buildDocumentProfileReport } from './documentProfiles';
import { buildKnowledgeCoverageReport, knowledgeCoverageIssues } from './documentKnowledgeCoverage';
import { buildDocumentFactTraces, factTraceIssues } from './documentFactTrace';
import { buildChapterCoverageReports, chapterCoverageIssues } from './documentChapterCoverage';
import { buildDocumentQualityReport, qualityReportIssues } from './documentQualityReport';
import { benchmarkGeneratedMarkdown } from './benchmarkQuality';
import { buildRepairStrategies, repairStrategyIssues } from './documentRepairStrategies';
import { repairChapterByQuality } from './rolePipeline';
import { enforcePlannedSectionCompleteness } from './globalQualityGates';
import { buildDocumentReviewChecklist } from './documentReviewChecklist';
import { collectValidationIssueGroups } from './documentQualityPipeline';
import { DOCUMENT_WORKFLOW_VERSION } from './documentWorkflowVersion';
import { buildDocumentTelemetryReport } from './documentTelemetry';
import { retrievalCoverageIssues } from './documentEvidenceRetrieval';
import { extractFacts, extractFactsWithLlm, extractLocalFactPool, buildFactsModel, shouldRunLlmFactExtraction } from './factsModel';
import { applyScopeConflictResolutions, buildCanonicalFactModel, buildCanonicalFacts, detectNumericScopeConflicts, extractDrawingAnnotationFacts } from './factGovernance';
import { extractSection, stringifyFactValue, throwIfAborted } from './utils';
import { formalTextGateIssues } from './agentWorkflow';
import { displayStage, upsertProgressStage } from './progress';
import { buildValidationIssues } from './chapterGeneration';
import { chapterSectionFactUsageIssues } from './chapterReview';
import { factCoverageIssues, factsWithEvidenceSource, criticalSectionBlockerLine, callBreakdownTopDetails, callBreakdownTopSummary, finalizeChapterContentQuality, finalizeFinalMarkdownStructure, normalizeProjectBasicInfoTable, partialChapterStatus, phaseWaterfallDetails, projectBasicPlaceholderIssues, slowMetricSummary, stripAtlasReferencePhrases, uncoveredImportantFacts, validateDraft } from './documentGeneratorHelpers';
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

/** 施组标准术语补写条目：每条覆盖一组模板专业规则必要术语，仅当组内任一术语缺失时整条补写。
 * 必须以编制依据正式条目形式注入——禁止「补充说明」标题与「详见本方案各保障章节」类元话语
 * （丰乐镇第 3 轮实测：「**编制依据补充说明**：…按施工进度动态配置，详见本方案各保障章节」
 * 元话语块进入正式正文被判定为内容污染；术语缺失时以正式条目兜底，保证门禁词形同时不污染正文） */
const REQUIRED_TEXT_SUPPLEMENTS: Array<{ words: string[]; basisItem: string }> = [
  { words: ['编制依据', '国家法律法规', '地方法规'], basisItem: '本施工组织设计的编制依据包括国家法律法规、地方法规及现行工程建设标准、规范' },
  { words: ['工程量清单', '施工图纸', '分部分项', '项目特征', '规格', '工程量', '图纸设计说明'], basisItem: '- 工程量清单及施工图纸：本项目分部分项工程量清单（项目特征、规格及工程量）与施工图纸设计说明；' },
  { words: ['劳动力计划', '主要施工材料', '主要施工机械'], basisItem: '- 施工组织设计文件：本工程劳动力计划、主要施工材料与主要施工机械配置计划；' },
];

/** 编制依据类别段落标题行与五类条目（总控提示词总纲要求按类别列出）：招标文件及补疑补遗/国家法律法规/
 * 国家行业地方现行规范标准/地方法规规章/企业管理体系五类；法律法规条目按公共知识列出具体法规名及文号
 * （丰乐镇实测缺陷：只写「国家现行法律、行政法规」类别话术被判内容空泛），不把工程量清单、
 * 施工图纸内容搬入编制依据正文 */
const REQUIRED_BASIS_CATEGORIES_TITLE = '**编制依据**：本施工组织设计的编制依据按以下类别列出：';
const REQUIRED_BASIS_CATEGORIES_ITEMS = [
  '- 招标文件及补疑补遗：本项目招标文件及招标补疑、澄清文件（招标文件与澄清、修正文件不一致的，以澄清、修正文件为准）；',
  '- 国家法律法规：《中华人民共和国建筑法》（2019年修正）、《中华人民共和国招标投标法》（2017年修正）、《中华人民共和国安全生产法》（2021年修正）、《中华人民共和国民法典》（2020年）、《建设工程质量管理条例》（国务院令第279号，2019年修订）、《建设工程安全生产管理条例》（国务院令第393号）、《保障农民工工资支付条例》（国务院令第724号）；',
  '- 国家/行业/地方现行规范标准：《建筑工程施工质量验收统一标准》（GB 50300-2013）及与本工程各分部分项工程对应的现行施工验收规范、标准与规程；',
  '- 地方法规规章：工程所在地现行地方性法规与政府规章（招标文件引用的地方性法规按其原文列出）；',
  '- 企业管理体系：公司质量、环境、职业健康安全管理体系文件及企业施工工艺标准。',
];

/** 编制依据五类清单的类别标记词（≥3 类命中即认定类别已列出；笼统句只含「国家法律法规/地方法规」
 * 两个词形无法命中「地方法规规章」精确词形，不满足类别清单口径） */
const BASIS_CATEGORY_TERMS = ['招标文件及补疑补遗', '国家法律法规', '现行规范标准', '地方法规规章', '企业管理体系'];

/** 模板专业规则必要术语（编制依据/主要施工材料等施组标准术语）缺失时确定性补写：
 * Writer 只收到“质量控制点”弱建议，常遗漏这些术语；逐句补写保证术语出现在正文，不依赖 LLM 自觉 */
export function supplementRequiredTexts(markdown: string, template: DocumentTemplate): string {
  const missingRequiredTexts = autoSpecGateRequiredTexts(template).filter(item => !markdown.includes(item));
  // 编制依据类别段落注入与术语缺失解耦（丰乐镇第十二轮实测）：LLM 写「编制依据」标题或只写
  // 「包括国家法律法规、地方法规及现行规范」一句笼统话时，missingRequiredTexts 已为空 → 原逻辑
  // 静默漏注入，总纲要求的五类清单全丢；类别词 ≥3 命中才认定类别已列出
  const basisCategoryHit = BASIS_CATEGORY_TERMS.filter(term => markdown.includes(term)).length;
  // 施组类恒注入（丰乐镇第十三轮）：编制依据五类清单是总纲硬要求，LLM 零提及（无标题无词形）时
  // 原触发条件静默跳过导致清单全丢——模板为施组类或正文已出现编制说明/工程概况章节即触发
  const isConstructionDoc = /编制说明|工程概况|施工准备/u.test(markdown);
  const basisTermRelevant = isConstructionDoc || missingRequiredTexts.includes('编制依据') || missingRequiredTexts.includes('国家法律法规') || missingRequiredTexts.includes('地方法规') || markdown.includes('编制依据');
  const needBasisBlock = basisCategoryHit < 3 && basisTermRelevant;
  if (missingRequiredTexts.length === 0 && !needBasisBlock) return markdown;
  const supplementItems = REQUIRED_TEXT_SUPPLEMENTS
    // 类别段落已覆盖编制依据术语时，跳过原单句兜底（避免与类别段落重复）
    .filter(group => (needBasisBlock ? group.words[0] !== '编制依据' : true))
    .filter(group => group.words.some(word => missingRequiredTexts.includes(word)))
    .map(group => group.basisItem);
  if (supplementItems.length === 0 && !needBasisBlock) return markdown;
  const items = [...(needBasisBlock ? REQUIRED_BASIS_CATEGORIES_ITEMS : []), ...supplementItems];
  // 条目以「；」为内部连接符，整块末尾统一句号收束（五类最后一条已句号时不命中替换）
  const supplement = needBasisBlock
    ? [REQUIRED_BASIS_CATEGORIES_TITLE, ...items].join('\n')
    : items.join('\n').replace(/；$/u, '。');
  // 锚点优先「编制依据」小节标题（LLM 已写标题但类别缺失时注入标题下），退「编制说明与工程概况」小节
  // 锚点扩展：编制依据 / 编制说明（与工程概况）/ 工程概况 / 项目概况 小节标题（LLM 写变体标题也能注入标题下）
  const anchor = /^(?:###|####)\s+(?:[\d.]+[\s\u00a0]*)?编制依据$/mu.exec(markdown)
    ?? /^(?:###|####)\s+(?:[\d.]+[\s\u00a0]*)?编制说明(?:与工程概况)?$/mu.exec(markdown)
    ?? /^(?:###|####)\s+(?:[\d.]+[\s\u00a0]*)?(?:工程概况|项目概况)$/mu.exec(markdown);
  if (anchor) {
    // 注入到编制依据/编制说明小节标题行之后
    const insertAt = markdown.indexOf('\n', anchor.index) + 1;
    return `${markdown.slice(0, insertAt)}${supplement}\n\n${markdown.slice(insertAt)}`;
  }
  return `${markdown.replace(/\s+$/u, '')}\n\n${supplement}`;
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
  // 规格型号列的“—”为「机具无型号」不适用语义（蛙式打夯机等小型机具），与合计行同口径豁免，
  // 不删行——删行会丢失真实投入的机具信息，且与检测层/注入层豁免口径一致（三层一致化）
  const isSpecModelColumn = (col: number) => /规格型号|规格|型号/u.test(rows[0][col] || '');
  for (let rowIndex = rows.length - 1; rowIndex > dividerIndex; rowIndex -= 1) {
    if (/^(?:合计|小计|总计|累计)/u.test(rows[rowIndex][0] || '')) continue;
    if (!rows[rowIndex].some((cell, col) => {
      if (isSpecModelColumn(col) && /^(?:—+|-+)$/u.test(cell)) return false;
      return cell === '' || PLACEHOLDER_CELL_RE.test(cell);
    })) continue;
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
  /** 一体化蓝图参数桶（生成前锁定口径）：蓝图引用冲突终检兑底实时重跑（替除生成阶段全卷快照） */
  blueprintData?: BlueprintData;
}): Promise<ValidationIssue[]> {
  const { documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget, scopeConflicts, evaluationCriteriaItems, effectiveChapters, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier, blueprintData } = input;
  return collectValidationIssueGroups(
    applySpecGateRules(documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template.projectBindings || [], promptBindings),
    validateDraftWithAutoSpec({ markdown: finalMarkdown, spec: documentSpec, summary: projectMaterialSummary }),
    validateFactConsistency({ markdown: finalMarkdown, facts: structuredFacts, summary: projectMaterialSummary, profile: domainProfile }),
    validateProjectContamination(finalMarkdown, projectMaterialSummary),
    projectBasicPlaceholderIssues(finalMarkdown, structuredFacts),
    await buildStandardFinalValidationIssues({ markdown: finalMarkdown, chapters: finalChapterDrafts, factsModel, template, promptBindings, promptDocumentRules, scopeConflicts, evaluationCriteriaItems, effectiveChapters, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier, blueprintData }),
    factCoverageIssues(finalMarkdown, [...structuredFacts, ...factsModel.preciseFacts], { maxIssues: 30 }).map(issue => ({ ...issue, level: 'warning' as const, severity: 'warning' as const, suggestion: '建议后续优化事实自然落位；导出阶段不因未落位的引用型或可优化事实阻断。' })),
    pageTargetIssues(template.generationSettings || template.exportSettings, finalMarkdown).filter(issue => !(documentBudget.minPages && /低于目标页数/u.test(issue.message))),
    documentBudgetIssues(documentBudget, finalMarkdown),
    plannedStructureIssues(finalMarkdown, template),
    formalTextGateIssues(finalMarkdown),
    await internalTerminologyAnchorIssues(finalMarkdown),
    headingUncoveredEngineeringItems(finalMarkdown),
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

/**
 * finalizeGeneration 输入聚合（二期结构改造：匿名参数对象命名化）。
 * 字段按职责分组：章节产物 / 模板与证据 / 提示词与规则 / 项目上下文 / 质量门禁输入 / 进度与基础设施。
 * TODO(类型精确化)：标记 any 的字段真实类型分散在生成器局部（DocumentBudget/DocumentDomainProfile/
 * GenerationStrategy 等），精确化需级联修复生成侧类型推导，留待生成编排器进一步拆分时收敛。
 */
export interface FinalizeGenerationInput {
  // ── 章节产物 ──
  chapterDrafts: DocumentDraftChapter[];
  chapterDraftsByOrder: Array<DocumentDraftChapter | undefined>;
  chapterGenerationStagesByOrder: Array<DocumentExecutionStage | undefined>;
  chapterGenerationStages: DocumentExecutionStage[];
  effectiveChapters: DocumentTemplateChapter[];
  // ── 模板与证据 ──
  template: DocumentTemplate; allEvidence: DocumentEvidence[];
  projectMaterialScope: ProjectMaterialScope;
  // ── 进度与基础设施 ──
  progressStages: DocumentExecutionStage[];
  input: { requirement?: string; signal?: AbortSignal; onProgress?: any };
  emitProgress: (c?: DocumentDraftChapter[], s?: DocumentExecutionStage[]) => void;
  withProgressHeartbeat: <T>(w: () => Promise<T>, s?: DocumentExecutionStage[]) => Promise<T>;
  // ── 规划与画像（生成期产物，finalize 只消费）──
  documentSpec: any; projectMaterialProfile: any; projectMaterialSummary: any; domainProfile: any;
  documentBudget: any; generationStrategy: any; readiness: any; indexHealth: any; promptPlan: any;
  // ── 提示词与规则 ──
  promptTexts: string; reviewPromptTexts: string;
  repairPromptTexts: string;
  factExtractionPromptTexts: string;
  promptBindings: any[]; promptDocumentRules: any;
  // ── 项目上下文 ──
  projectUnderstanding: any; projectContext: string; projectRoot: string; projectId: string;
  /** A2 章级 scoped 上下文工厂（生成器预构建）：Final Gate 补写调用按章精确裁剪蓝图；未提供时回退全量 projectContext */
  chapterScopedContext?: (chapter: DocumentTemplateChapter) => string;
  // ── 质量门禁输入（生成期审计产物）──
  generationDiagnostics: DocumentGenerationDiagnostics;
  hasExplicitOutline: boolean; missingItems: string[];
  retrievalCoverageReports: RetrievalCoverageReport[];
  failedChapterMessages: string[];
  webResearchReport: { enabled: boolean; queries: string[]; evidenceCount: number; filteredCount: number; chapters: string[] };
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
  /** 一体化蓝图参数桶（生成前锁定口径）：交付前确定性清洗的节点工期/机械台数/决策锁权威（三期蓝图接管） */
  blueprintData?: BlueprintData;
}

export async function finalizeGeneration(p: FinalizeGenerationInput): Promise<GeneratedDocumentDraft> {
  const {
    chapterDraftsByOrder, chapterGenerationStagesByOrder, chapterGenerationStages, effectiveChapters, template, allEvidence, projectMaterialScope,
    progressStages, documentSpec, projectMaterialSummary, domainProfile, documentBudget,
    input, generationDiagnostics, promptTexts, promptBindings, promptDocumentRules, projectRoot, projectId, readiness,
    factExtractionPromptTexts, hasExplicitOutline, missingItems, retrievalCoverageReports, failedChapterMessages, repairPromptTexts,
    webResearchReport, indexHealth, agentWorkflow, globalConsistencyIssues, scopeConflicts, writingTaskBrief, evaluationCriteriaItems, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier, blueprintData, emitProgress, withProgressHeartbeat,
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
  // 本地事实池统一入口（与生成准备抽取点同源，见 factsModel.extractLocalFactPool）；
  // structuredTables 经工作簿解析缓存复用生成准备阶段对同批表文件的解析结果，零重复磁盘 IO
  const { localFacts, projectBasicFacts, preciseFacts, structuredTables } = extractLocalFactPool({ evidence: allEvidence, template, spec: documentSpec, profile: domainProfile, scope: projectMaterialScope, diagnostics: generationDiagnostics });
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
  // 4.19 图纸标注事实补抽（finalize 同源接入）：生成准备阶段接入的 CAD 语义标注（坡底线/钢管土钉）
  // 只喂了 Writer 输入；finalize 重建事实主表未接入 → 危大/支护形式检查器输入槽位全空（真实回归实测：
  // 正文深度/支护形式留白、canonical 空）。与 documentGenerator L299 同口径确定性补抽并入主表链。
  const drawingAnnotationFacts = extractDrawingAnnotationFacts(allEvidence);
  const structuredFacts = filterFactsByProjectScope(factsWithEvidenceSource([...localFacts, ...projectBasicFacts, ...preciseFacts, ...llmExtraction.facts, ...drawingAnnotationFacts], allEvidence), projectMaterialScope);
  // 源级同口径冲突裁决回写：裁决值统一进入事实主表与确定性校验基准，避免正文被主表败选值误导（如 4645㎡ 与 4646㎡ 并存）
  const governedStructuredFacts = applyScopeConflictResolutions(structuredFacts, scopeConflicts ?? detectNumericScopeConflicts(structuredFacts));
  for (const fact of governedStructuredFacts) facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;

  const factsModel = await buildFactsModel(governedStructuredFacts, structuredTables, missingItems, documentSpec, domainProfile);
  // 4.19 canonical 主表构建（finalize 同源接入）：危大判定/支护形式一致性检查器消费 factsModel.canonical
  // 的 excavation_depth/foundation_support_form 槽位（byKey）；此前 finalize 从未构建 canonical，
  // 补抽事实即使进入主表也无 canonical 索引 → excavationHazardClassificationIssues 永远无输入
  const canonicalFactsModel = buildCanonicalFactModel({ facts: governedStructuredFacts, projectRoot, requirement: requirement || '', templateId: template.id });
  factsModel.canonical = canonicalFactsModel;
  // 4.17.3 计划总工期权威口径：factsModel 计划工期事实卡作为全文工期确定性修复的裁决基准
  //（庐江实测：45 vs 210 两套体系各自带表格，表格口径不唯一导致修复零产出、修复节点 failed）
  const scheduleAuthority = extractScheduleAuthority(factsModel);
  // 4.17.4：装配率权威口径（38.4% vs 招标锁定 30%）与工程规模摘要（6.1 一览表套话填充）
  const assemblyRateAuthority = extractAssemblyRateAuthority(factsModel);
  const scaleSummary = extractProjectScaleSummary(factsModel);
  // B1 支护体系权威（图纸/地质槽位 foundation_support_form）：交付前确定性裁决依据
  const supportAuthority = extractSupportSystemAuthority(factsModel);
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
    (globalConsistencyIssues || []).filter(message => !/^跨章一致性冲突|^工序规格冲突/u.test(message)).slice(0, 10).map(message => {
      // 数据一致性矛盾条目（阶段 2 统一审查并入）单独前缀，与跨章一致性复核区分定位；
      // 两类问题修复后旧快照会重算替换，此处仅打包当前清单进导出校验
      const isDataConflict = /^数据一致性矛盾/u.test(message);
      return { level: 'error' as const, severity: 'blocker' as const, category: 'fact_consistency' as const, owner: 'llm' as const, repairability: 'llm_repairable' as const, message: `${isDataConflict ? '数据一致性复核' : '跨章一致性复核'}：${message}`, suggestion: isDataConflict ? '全文数据必须一致：以绑定资料（图纸/清单/招标文件）为准选定唯一值，统一矛盾数值对。' : '跨章数值口径不一致属低级错误，必须定向修复统一口径后重新校验。' };
    }),
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
  finalMarkdown = fixTocFromBody(finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(finalMarkdown, structuredFacts), projectMaterialSummary)))), template))).markdown;
  // round-19：全文重建函数（章草稿 → finalMarkdown 标准化管道）单一定义：
  // 确定性修复后重建/Final Gate 补写后重建/事实落位后重建/表格修复后重建/post-gate 重建共用同一口径，
  // 消除 5 处 300+ 字符重复表达式（历史遗留：rebuild 定义在修复循环后才出现，前面的重建只能内联复制）
  const rebuildFinalMarkdownFromChapters = () => fixTocFromBody(finalizeFinalMarkdownStructure(supplementRequiredTexts(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanFormalSourcePhrases(sanitizeContaminationCandidates(normalizeProjectBasicInfoTable(rebuildFinalMarkdown({ template, requirement, projectRoot, projectId, facts, structuredFacts, factsModel, chapters: finalChapterDrafts, sources, missingItems, validation, validationIssues, executionStages, assets, promptDocumentRules }), structuredFacts), projectMaterialSummary)))), template))).markdown;

  const canonicalFacts = buildCanonicalFacts({ facts: structuredFacts, markdown: finalMarkdown });
  if (canonicalFacts.size > 0) executionStages.push({ type: 'fact_extraction', roleId: 'canonical-facts', status: 'success', message: `已决策可信基础事实 ${canonicalFacts.size} 项`, details: [...canonicalFacts.values()].map(fact => `${fact.label}=${fact.value}（${fact.source}，confidence=${fact.confidence}）`).slice(0, 12) });

  // 修复后重算问题组会重新计算，修复基线只保留基础累计问题，避免重复累加
  const baseValidationIssues = validationIssues;
  validationIssues = await buildFullValidationIssues({ documentSpec, validationIssues, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget, scopeConflicts, evaluationCriteriaItems, effectiveChapters, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier, blueprintData });

  let qualityBundle = await buildQualityReportBundle({ finalChapterDrafts, effectiveChapters, factsModel, allEvidence, finalMarkdown, validationIssues, retrievalCoverageReports, includeRetrievalCoverage: true, template });
  let { knowledgeCoverage, factTraces, chapterCoverage, qualityReport, repairStrategies, finalExportGate } = qualityBundle;
  validationIssues = qualityBundle.validationIssues;
  const finalGateRepairStages: DocumentExecutionStage[] = [];
  // round-20 S5/W8：全维度评审轮残留问题（否决级/高风险 error 阻断，中低风险 warning 展示），
  // 评审轮运行后赋值，recomputeFinalValidationBundle 重算校验组时并入，由导出门禁按 category 'qingtian_review' 硬阻断
  let qingtianReviewBlockingIssues: ValidationIssue[] = [];
  // 修复后重算校验组（事实落位轮/表格修复轮/评审轮后共用）：过滤旧快照 issue，
  // 用最新 finalMarkdown 重算全部校验组与导出门禁
  const recomputeFinalValidationBundle = async () => {
    const repairedValidationBase = baseValidationIssues.filter(issue =>
    // 事实落位警告是修复前的章节草稿拼接快照，修复后的重算会用最新 finalMarkdown 重新生成，
    // 旧快照必须丢弃：否则已落位的事实（如基本信息表中的招标人）会带着修复前的警告进入最终交付。
    !/已确认事实未在正文中落位/u.test(issue.message)
    // B5：确定性删除已生效的旧 issue 快照必须剔除——交付前 strip 删除复述句/内部术语后，
    // 旧快照残留会让门禁虚报已消除缺陷（历史缺陷：正文已删「本项目为…」但门禁仍报概况复述）
    && !(/概况段跨章复述/u.test(issue.message) && !/本项目为|本工程为|该项目为|该工程为/u.test(finalMarkdown))
    && !(/后台内部术语|后台内部话术/u.test(issue.message) && !/工作包|事实卡|事实主表|后台数据库|落位|峰值口径|控制口径|数据口径/u.test(finalMarkdown))
    // B8：生成阶段全卷快照消息（「跨章一致性复核/数据一致性复核」前缀）在重算时全部剔除——
    // 规格错位/表格重复/蓝图引用冲突等检查器已在 buildStandardFinalValidationIssues 中对最新 finalMarkdown 实时重跑，
    // 旧快照保留会导致已修复缺陷继续扣分（第五轮实测：终稿垫层全 C20 仍报 C30 错位、
    // 塑料管已拆 DN200 污水管 8205.53m / DN110 雨水管 7525.01m 两口径仍报单一蓝图冲突）
    && !/^(?:跨章一致性复核|数据一致性复核)：/u.test(issue.message));
    validationIssues = await buildFullValidationIssues({ documentSpec, validationIssues: repairedValidationBase, factsModel, finalChapterDrafts, finalMarkdown, template, promptBindings, promptDocumentRules, projectMaterialSummary, domainProfile, structuredFacts, documentBudget, scopeConflicts, evaluationCriteriaItems, effectiveChapters, tenderRequirements, requirementsSimilarity, factTokenScopeClassifier, professionalDepthClassifier, blueprintData });
    // 评审轮残留问题并入校验组（在导出门禁计算前），重算后 finalExportGate 即包含评审轮硬阻断
    validationIssues = [...validationIssues, ...qingtianReviewBlockingIssues];
    qualityBundle = await buildQualityReportBundle({ finalChapterDrafts, effectiveChapters, factsModel, allEvidence, finalMarkdown, validationIssues, retrievalCoverageReports, includeRetrievalCoverage: false, template });
    ({ knowledgeCoverage, factTraces, chapterCoverage, qualityReport, repairStrategies, finalExportGate } = qualityBundle);
    validationIssues = qualityBundle.validationIssues;
  };
  // 重要事实落位补写轮（P1-3）：结构缺陷修复收敛后，若项目基础字段类硬数据仍未落位（建筑面积、标段数、编号、工期等），
  // 按事实标签映射目标章节做一轮定向 patch 落位（保持数值口径，不新增小节、不改表头结构）。
  // 十度实测缺陷：建设规模“建筑面积约为4646㎡”、招标范围“本项目分为1个标段”未落位直达交付（针对性维度 68 分）
  const importantUnplacedFacts = uncoveredImportantFacts(finalMarkdown, [...structuredFacts, ...factsModel.preciseFacts], { maxItems: 60 });
  if (importantUnplacedFacts.length > 0) {
    // 标签→章节关键词映射：项目基础字段 → 概况/基本信息章；工期 → 进度部署章；质量 → 质量章；危大安全 → 安全章；资源材料机械 → 资源投入章
    const factChapterMatchers: Array<[RegExp, RegExp]> = [
      [/项目名称|工程名称|项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|施工范围/u, /概况|基本信息|概述|总述|简介/u],
      [/计划工期|合同工期|天数/u, /工期|进度|施工部署|总体部署|流水/u],
      [/质量标准|质量目标/u, /质量/u],
      [/危大|安全/u, /安全/u],
      [/资源|材料|机械|设备|机具/u, /资源|投入|物资|机械|设备|机具|周转/u],
      // B5 关键精确参数落位：面积/长度/强度/管径等工程参数 → 概况章或施工方法章（与 preciseFactUsageIssues 关键参数抽查同源）
      [/面积|占地|建筑面积|长度|宽度|高度|厚度|深度|强度|等级|坡度|管径|直径|规格|跨度|周长|体积|重量/u, /概况|施工方法|主要施工|方案/u],
    ];
    const chapterFactGroups = new Map<string, Array<{ label: string; value: string }>>();
    const unmatchedFacts: string[] = [];
    // B5 参数落位限幅：每组最多 12 条，防参数池过大时 LLM patch 膨胀（每章一次调用，组内超限丢弃并记录）
    const droppedParamFacts: string[] = [];
    for (const item of importantUnplacedFacts) {
      const matcher = factChapterMatchers.find(([labelRe]) => labelRe.test(item.label));
      const targetChapter = matcher ? finalChapterDrafts.find(chapter => matcher[1].test(chapter.title)) : undefined;
      if (!targetChapter) {
        unmatchedFacts.push(`${item.label}=${item.value}`);
        continue;
      }
      const group = chapterFactGroups.get(targetChapter.id) || [];
      if (group.length >= 12) {
        droppedParamFacts.push(`${item.label}=${item.value}`);
        continue;
      }
      group.push({ label: item.label, value: item.value });
      chapterFactGroups.set(targetChapter.id, group);
    }
    let factLandingPatches = 0;
    for (const [chapterId, factsGroup] of chapterFactGroups) {
      const chapterIndex = finalChapterDrafts.findIndex(chapter => chapter.id === chapterId);
      if (chapterIndex < 0) continue;
      const draftChapter = finalChapterDrafts[chapterIndex];
      const templateChapter = effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title);
      const runningStage = displayStage({ type: 'llm_review', roleId: `agent-fact-landing-${chapterId}`, status: 'running', message: `正在落位 ${factsGroup.length} 条重要事实：${draftChapter.title}`, details: [...factsGroup.map(item => `${item.label}=${item.value}`), ...unmatchedFacts.map(item => `跳过：${item}（无匹配章节）`), ...droppedParamFacts.map(item => `超限跳过：${item}`)] }, { subtitle: '事实落位修复' });
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
      finalMarkdown = rebuildFinalMarkdownFromChapters();
      await recomputeFinalValidationBundle();
    }
  }
  // 表格数据完整性修复轮（T1-2）：空单元格/占位符/列数不一致等表格 error 硬阻断导出（十度实测缺陷：
  // 竣工清理计划表末列为空、临时用电表“—/若干/约82kW”占位）。修复链路：定位章节 → 注入缺陷表格原文 patch 修复
  // → 确定性兜底（4.17.8 删除升级指令二修：每缺陷单次尝试，失败即放弃）。
  const tableDefectIssues = markdownTableQualityIssues(finalMarkdown).filter(issue => issue.level === 'error' && /空单元格|占位符单元格|列数不一致|分隔线位置不规范/u.test(issue.message));
  if (tableDefectIssues.length > 0) {
    let tableFixPatches = 0;
    // D2：按章分组 + 跨章并行——同章表格组内串行（每表独立修复闭环，组内后表以最新章内容为输入），
    // 跨章组批量并行（指令生成并行，限幅 DOCUMENT_TABLE_FIX_CONCURRENCY，默认 2）；每章单写者零覆盖
    const tableGroups: Array<Array<{ chapterIndex: number; issueIndex: number; message: string; suggestion: string; tableAnchor: string; rowAnchor: string }>> = [];
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
      const entry = { chapterIndex, issueIndex, message: issue.message, suggestion: issue.suggestion || '', tableAnchor, rowAnchor };
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
        for (const { chapterIndex, issueIndex, message, suggestion, tableAnchor, rowAnchor } of entries) {
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
            '合计/小计/总计/累计行的空单元格一律填“—”（不适用语义）；规格型号列中无规格型号的小型机具（蛙式打夯机等）可填“—”（机具无型号，合法）；其余单元格一律不得为空、不得用占位符，不得凭空编造型号。',
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
          // 4.17.8 升级指令二修删除：每缺陷单次尝试（失败即放弃）——二修轮是修复 token 主力军的组成部分，
          // 首次失败后直接确定性兜底，残留缺陷转导出门禁阻断
          // 确定性兜底（LLM 单修失败的最后防线）：合计行空填“—”、表名占格归一、全空列删列、零星空单元格删行，
          // 只做不引入新错误的确定性操作（检测器豁免合计行“—”），无缺陷表格原样返回
          const deterministic = repairTableBlockDeterministically(nextContent, tableAnchor);
          nextContent = deterministic.content;
          if (nextContent !== draftChapter.content) {
            finalChapterDrafts[chapterIndex] = { ...draftChapter, content: templateChapter ? finalizeChapterContentQuality(nextContent, templateChapter) : nextContent };
            tableFixPatches += 1;
          }
          // 修复结果判定：同源复检该表头锚点下的原缺陷行是否仍存在表格数据缺陷。
          // 行级判定（4.19 真实回归）：此前按「表头锚点表内任一占位符残留」判整表失败——LLM 按指令只修
          // 原缺陷行（钢筋行 420t/批），同表其他行的同类缺陷（砌体行约650m³/批）导致已修复节点误判
          // 「未生效」（5-2/6-3/6-4 三节点 failed，前两版全成功）。原缺陷行不再检出同类缺陷即视为修复
          // 成功；同表其他行的残留缺陷由导出门禁阻断，不在此重复判定
          const stillDefective = markdownTableQualityIssues(nextContent).some(item => item.level === 'error' && /空单元格|占位符单元格|列数不一致/u.test(item.message) && item.message.includes(tableAnchor) && (!rowAnchor || item.message.includes(rowAnchor)));
          const completedTableStage = displayStage({ type: 'llm_review', roleId: `agent-table-fix-${draftChapter.id}-${issueIndex}`, status: stillDefective ? 'failed' : 'success', message: stillDefective ? `表格数据修复未生效：${draftChapter.title}` : `表格数据修复完成：${draftChapter.title}`, details: [message] }, { subtitle: '表格数据修复' });
          upsertProgressStage(progressStages, completedTableStage);
          upsertProgressStage(finalGateRepairStages, completedTableStage);
          emitProgress(finalChapterDrafts, progressStages);
        }
      }));
    }
    if (tableFixPatches > 0) {
      finalMarkdown = rebuildFinalMarkdownFromChapters();
      await recomputeFinalValidationBundle();
    }
  }
  // 1.3 语义矛盾检测（决策锁"实体-选择"冲突，塔吊 vs 施工电梯类无数值矛盾）：与写作期注入同批输入
  // （623 行事实池三元组 + 同批 allEvidence）确定性重建决策锁作比对基准，检出转 blocker 并入既有修复通道；
  // 复检走统一注册表 semantic-choice 条目（与检测同源），一律不留 env 回退开关
  const decisionLockEntries = extractDecisionLockEntries({ facts: [...localFacts, ...projectBasicFacts, ...preciseFacts], evidence: allEvidence });
  if (decisionLockEntries.length > 0) {
    validationIssues = [...validationIssues, ...semanticChoiceConflicts(finalMarkdown, decisionLockEntries).map(conflict => semanticChoiceConflictIssue(conflict))];
  }
  // 阶段 5 交付前确定性清洗（数值定点兜底）：blocker 修复循环已删除，导出前做最后一次确定性定点修复，
  // 修复后重算校验组，避免残留冲突被导出门禁硬阻断。章节级修复原地改正文后重建全文，
  // 全文级修复覆盖封面/信息表合成区的败选数值（章节修复覆盖不到），最后定点替换跨章数值矛盾。
  const stage5ChapterFix = await applyDeterministicConsistencyFixes(finalChapterDrafts, factsModel, scopeConflicts);
  // D1 劳动力峰值三层锚点统一：蓝图 labor.peakValue（造价锚定）> 分阶段投入明细表峰值 > 正文表述。
  // 章节级频率投票修复器与全文级定点替换修复器共用同一权威口径，检测器也按该口径豁免——
  // 否则修复器把正文对齐蓝图后，表格互查检测器又会把正文拉回表峰值，形成修复循环拉扯
  const laborPeakAuthority = blueprintPlanAuthorities(blueprintData).laborPeakAuthority;
  // B2 绿化养护期权威（丰乐镇实测「养护一年」漏网）：养护期红线事实无章级锚定时，
  // 从 factsModel 清单/精确事实抽取权威养护年限，与检测器同源（extractGreeningMaintenanceAuthority）
  const greeningMaintenanceAuthority = extractGreeningMaintenanceAuthority(factsModel);
  // B1 语义重复交付前兜底：补表/门禁规则修复后可能再引入雷同段，交付前最后一次迭代收敛 strip
  const stage5SemanticDup = await stripCrossChapterSemanticDuplicateParagraphs(finalChapterDrafts);
  // B1 评分项响应强制：交付前对零命中/部分响应的实质条款按路由责任章节补写响应句（锚点同源判定）
  const stage5ScoringFix = await fixScoringRequirementResponses({
    chapters: finalChapterDrafts, model: tenderRequirements, similarity: requirementsSimilarity, signal,
  });
  if (stage5ChapterFix.fixedCount > 0 || stage5SemanticDup > 0 || stage5ScoringFix.fixedCount > 0) finalMarkdown = rebuildFinalMarkdownFromChapters();
  if (stage5ScoringFix.fixedCount > 0) {
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'scoring-requirement-fix', status: 'success', message: `评分项响应确定性补写 ：${stage5ScoringFix.fixedCount} 条（${stage5ScoringFix.details.slice(0, 3).join('、')}）`, details: stage5ScoringFix.details.slice(3) }, { subtitle: '交付前确 定性清洗' }));
  }
  // B6 交付前确定性清洗（丰乐镇第五轮实测）：跨章表格去重/断行残片合并/叠词收敛此前只有
  // 检测器无修复器——「工程名称表两处重复」「延长有效作业时间 |残行」「分部分项叠词误报」
  // 被导出门禁硬阻断且修复轮循环无效；检测定位=修复定位同源，章节级原地修复后统一重建全文，
  // 重建发生在全文级数值修复之前，避免覆盖 stage5MarkdownFix/stage5NumericFix 的修复成果。
  const stage5TableDup = stripDuplicateTablesAcrossChapters(finalChapterDrafts);
  let stage5ResidueCount = 0;
  let stage5FinishFixCount = 0;
  let stage5LaborFixCount = 0;
  let stage5SelfFixCount = 0;
  let stage5EmptyRespCount = 0;
  let stage5AtlasRefCount = 0;
  let stage5MetaFixCount = 0;
  let stage5FormulaFixCount = 0;
  let stage5OpeningFixCount = 0;
  let stage5TruncatedFixCount = 0;
  let stage5TableProseFixCount = 0;
  let stage5TableRowDupCount = 0;
  let stage5MaintenanceFixCount = 0;
  for (const chapter of finalChapterDrafts) {
    // 节点内闭环（丰乐镇第九轮方案）：每个确定性修复器修复后重跑自身直至零命中，
    // 修复完成才进入下一修复器——替代“单遍修复后无条件走下一节点”的直线模式
    const residueFix = runFixUntilClean(md => { const r = mergeTableLineResidues(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; }, chapter.content, 2);
    if (residueFix.fixedCount > 0) { chapter.content = residueFix.markdown; stage5ResidueCount += residueFix.fixedCount; }
    chapter.content = collapseRepeatedWords(chapter.content);
    // A21 装饰层厚度/劳动力峰值/自伤句式/空响应句（丰乐镇第七轮实测）：
    // 装饰层厚度 200mm 串染（抹面/打底/坐浆）、总人数 vs 高峰人数多口径、
    // 「未采用新技术」自伤句、LLM 自由发挥的空响应句——检测定位=修复定位同源，章节级原地修
    const finishFix = runFixUntilClean(md => { const r = fixFinishThickness(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; }, chapter.content, 2);
    if (finishFix.fixedCount > 0) { chapter.content = finishFix.markdown; stage5FinishFixCount += finishFix.fixedCount; }
    const laborFix = runFixUntilClean(md => { const r = fixLaborPeakConflict(md, laborPeakAuthority); return { markdown: r.markdown, fixedCount: r.fixedCount }; }, chapter.content, 2);
    if (laborFix.fixedCount > 0) { chapter.content = laborFix.markdown; stage5LaborFixCount += laborFix.fixedCount; }
    // B7 表内重复行确定性删除（丰乐镇实测「工程内容表两遍粘贴」）：同一表内的重复段
    // 跨章去重检测不到，与 duplicateTableRowIssues 同口径（检测定位=修复定位）
    const tableRowDupFix = runFixUntilClean(md => { const r = stripInternalDuplicateTableRows(md); return { markdown: r.markdown, fixedCount: r.removedCount }; }, chapter.content, 2);
    if (tableRowDupFix.fixedCount > 0) { chapter.content = tableRowDupFix.markdown; stage5TableRowDupCount += tableRowDupFix.fixedCount; }
    // B8 绿化养护期确定性统一（丰乐镇实测「养护一年」漏网）：正文养护年限与清单权威不符时
    // 确定性替换（与 fixGreeningMaintenanceMismatch 同源），无权威时静默跳过
    const maintenanceFix = runFixUntilClean(md => { const r = fixGreeningMaintenanceMismatch(md, greeningMaintenanceAuthority); return { markdown: r.markdown, fixedCount: r.fixedCount }; }, chapter.content, 2);
    if (maintenanceFix.fixedCount > 0) { chapter.content = maintenanceFix.markdown; stage5MaintenanceFixCount += maintenanceFix.fixedCount; }
    // B1/B2 段首机械重复剥离与截断句残留收敛（丰乐镇实测）：检测定位=修复定位同源，
    // 章节级原地修复，节点内闭环（修复后重跑自身直至零命中）
    const openingFix = runFixUntilClean(md => { const r = fixParagraphOpeningRepeats(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; }, chapter.content, 2);
    if (openingFix.fixedCount > 0) { chapter.content = openingFix.markdown; stage5OpeningFixCount += openingFix.fixedCount; }
    const truncatedFix = runFixUntilClean(md => { const r = fixTruncatedSentenceArtifacts(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; }, chapter.content, 2);
    if (truncatedFix.fixedCount > 0) { chapter.content = truncatedFix.markdown; stage5TruncatedFixCount += truncatedFix.fixedCount; }
    // F17/F18 元话语声明句与公式形态残留（远端客户反馈「公式直接输入正文」根治）：
    // 声明≠数据、公式≠值——交付前确定性清洗，与检测器同源同模式（清洗后重算校验组）
    const metaFix = runFixUntilClean(md => { const r = fixMetaDiscourseDeclarations(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; }, chapter.content, 2);
    if (metaFix.fixedCount > 0) { chapter.content = metaFix.markdown; stage5MetaFixCount += metaFix.fixedCount; }
    const formulaFix = runFixUntilClean(md => { const r = fixFormulaResidues(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; }, chapter.content, 2);
    if (formulaFix.fixedCount > 0) { chapter.content = formulaFix.markdown; stage5FormulaFixCount += formulaFix.fixedCount; }
    const selfFix = runFixUntilClean(md => { const r = fixSelfUnderminingCandidates(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; }, chapter.content, 2);
    if (selfFix.fixedCount > 0) { chapter.content = selfFix.markdown; stage5SelfFixCount += selfFix.fixedCount; }
    const emptyRespFix = runFixUntilClean(md => { const r = fixEmptyScoringResponses(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; }, chapter.content, 2);
    if (emptyRespFix.fixedCount > 0) { chapter.content = emptyRespFix.markdown; stage5EmptyRespCount += emptyRespFix.fixedCount; }
    // 图集/国标做法编号引用清洗（丰乐镇第 3 轮实测）：LLM 编造「做法执行15D501图集」类
    // 资料未提供的图集引用，短语级删除保留句子主体；检测定位=修复定位同源，章节级原地修
    const atlasRefFix = runFixUntilClean(md => { const r = stripAtlasReferencePhrases(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; }, chapter.content, 2);
    if (atlasRefFix.fixedCount > 0) { chapter.content = atlasRefFix.markdown; stage5AtlasRefCount += atlasRefFix.fixedCount; }
  }
  if (stage5TableDup.removedCount > 0 || stage5ResidueCount > 0 || stage5FinishFixCount > 0 || stage5LaborFixCount > 0 || stage5SelfFixCount > 0 || stage5EmptyRespCount > 0 || stage5AtlasRefCount > 0 || stage5MetaFixCount > 0 || stage5FormulaFixCount > 0 || stage5OpeningFixCount > 0 || stage5TruncatedFixCount > 0 || stage5TableRowDupCount > 0 || stage5MaintenanceFixCount > 0) {
    finalMarkdown = rebuildFinalMarkdownFromChapters();
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'deterministic-surface-fix', status: 'success', message: `交付前确定性清洗：跨章表格去重 ${stage5TableDup.removedCount} 行、断行残片合并 ${stage5ResidueCount} 处、装饰层厚度修复 ${stage5FinishFixCount} 处、劳动力峰值统一 ${stage5LaborFixCount} 处、段首机械重复剥离 ${stage5OpeningFixCount} 处、截断句残留收敛 ${stage5TruncatedFixCount} 处、元话语声明清洗 ${stage5MetaFixCount} 处、公式形态清洗 ${stage5FormulaFixCount} 处、自伤句式改写 ${stage5SelfFixCount} 处、空响应句改写 ${stage5EmptyRespCount} 处、图集引用清洗 ${stage5AtlasRefCount} 处、表内重复行删除 ${stage5TableRowDupCount} 行、绿化养护期统一 ${stage5MaintenanceFixCount} 处、叠词收敛` }, { subtitle: '交付前确定性清洗' }));
  }
  const stage5MarkdownFix = await applyDeterministicConsistencyFixesToMarkdown(finalMarkdown, factsModel, scopeConflicts);
  if (stage5MarkdownFix.fixedCount > 0) finalMarkdown = stage5MarkdownFix.markdown;
  // 跨章数值矛盾（劳动力峰值/节点工期/材料设备数量）确定性定点替换：检测定位=修复定位同源
  const stage5NumericFix = applyNumericConsistencyDeterministicFixes(finalMarkdown, { scheduleAuthority, assemblyRateAuthority, ...blueprintPlanAuthorities(blueprintData), supportAuthority });
  if (stage5NumericFix.fixedCount > 0) finalMarkdown = stage5NumericFix.markdown;
  // B3 表格承载正文确定性兜底（丰乐镇实测「1.2 项目主要施工内容」全表格小节）：
  // 关键小节正文全为表格时从表格行确定性生成段落叙述插入标题后（表格保留），
  // 覆盖 majorContentGovernanceIssues 的 error blocker，全文级一次收敛
  const stage5TableProseFix = fixTableBorneContentSections(finalMarkdown);
  if (stage5TableProseFix.fixedCount > 0) { finalMarkdown = stage5TableProseFix.markdown; stage5TableProseFixCount = stage5TableProseFix.fixedCount; }
  if (stage5TableProseFix.fixedCount > 0) {
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'table-borne-prose-fix', status: 'success', message: `表格承载正文段落改写兜底：${stage5TableProseFix.fixedCount} 处（${stage5TableProseFix.details.slice(0, 3).join('、')}）`, details: stage5TableProseFix.details.slice(3) }, { subtitle: '交付前确定性清洗' }));
  }
  if (stage5ChapterFix.fixedCount > 0 || stage5MarkdownFix.fixedCount > 0 || stage5NumericFix.fixedCount > 0) {
    await recomputeFinalValidationBundle();
    const totalFixed = stage5ChapterFix.fixedCount + stage5MarkdownFix.fixedCount + stage5NumericFix.fixedCount;
    const totalDetails = [...new Set([...stage5ChapterFix.details, ...stage5MarkdownFix.details, ...stage5NumericFix.details])];
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'deterministic-consistency-fix', status: 'success', message: `交付前确定性清洗：${totalFixed} 处（${totalDetails.slice(0, 4).join('、')}）`, details: totalDetails.slice(4) }, { subtitle: '交付前确定性清洗' }));
  }
  // 来源罗列话术确定性清洗兜底（十一度实测缺陷）：patch 类修复更新章节内容后若 未触发 rebuild，最终校验用
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
  // 缺节/空小节补写终兜底（丰乐镇第 2 轮实测）：全维度评审轮 patch 重写章节可能删除规划小节
  // （工程概况-项目管理组织机构与职责、施工总平面布置图-施工总平面布置原则与分区管理/
  // 竣工清理验收移交与保修 3 处缺节），生成期 enforcePlannedSectionCompleteness 早于评审轮覆盖不到；
  // 交付前对最终成稿再跑一次补写收口（缺节与纯表格空小节同口径，单轮失败即放弃，残留转门禁）
  const plannedSectionFixFinal = await enforcePlannedSectionCompleteness({
    chapterDraftsFinal: finalChapterDrafts, template, repairPromptTexts,
    requirement, signal, generationDiagnostics, progressStages, emitProgress, withProgressHeartbeat,
  });
  if (plannedSectionFixFinal.plannedSectionFixApplied) {
    finalMarkdown = rebuildFinalMarkdownFromChapters();
    await recomputeFinalValidationBundle();
  }
  // 4.17.8 交付前最终修复轮整体删除：其 12 类检测器与 blocker 修复循环 code map 全覆盖（检测侧单源），
  // 轮末重审/升级重试均属修复主力军化冗余——每缺陷 blocker 轮单次修复后失败即放弃，
  // 残留问题由导出门禁报告（不再进入 LLM 修复）；交付前确定性清洗（商务句/表格空单元格/数值定点）保留在下方。
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
  // B6 评审轮后表面修复兜底（丰乐镇第六轮实测）：全维度评审轮 patch 重写章节会再引入
  // 表格断行残片（「优先保障关键村 |」独立残行），stage5 修复链早于评审轮覆盖不到；
  // 最终导出前对全文再跑一遍残行合并+叠词收敛（与检测器同口径，零成本零误伤）。
  // A21 扩展（丰乐镇第七轮实测）：评审轮 patch 同样会再引入表格重复/装饰层 200mm 串染/
  // 劳动力多口径/自伤句式/空响应句，一并纳入评审轮后兜底，与 stage5 链同源。
  // 第九轮链级收敛：单遍兜底升级为链循环——任一修复器有新命中即整链重跑，
  // 修复器互相引入的问题在链中收敛，不再依赖“最后一个节点单遍修所有”的直线兜底。
  // F4（丰乐镇第五轮实测）：H4-H3 同名标题与「落位」内部术语标题修复轮 patch 覆盖不到，
  // 接入链循环确定性修复（同名 H4 追加「要点」、标题内「落位」→「落实」，与检测器同口径）
  const surfaceFixRound2Result = runDeterministicChainUntilConverged([
    md => { const r = mergeTableLineResidues(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; },
    md => { const next = collapseRepeatedWords(md); return { markdown: next, fixedCount: next === md ? 0 : 1 }; },
    md => { const r = stripDuplicateTables(md); return { markdown: r.markdown, fixedCount: r.removedCount }; },
    md => { const r = fixFinishThickness(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; },
    md => { const r = fixLaborPeakConflict(md, laborPeakAuthority); return { markdown: r.markdown, fixedCount: r.fixedCount }; },
    // B7/B8 评审轮后兜底（与 stage5 链同源）：评审轮 patch 会再引入表内重复行与养护期多口径
    md => { const r = stripInternalDuplicateTableRows(md); return { markdown: r.markdown, fixedCount: r.removedCount }; },
    md => { const r = fixGreeningMaintenanceMismatch(md, greeningMaintenanceAuthority); return { markdown: r.markdown, fixedCount: r.fixedCount }; },
    // B1/B2/B3 评审轮后兜底（与 stage5 链同源）：评审轮 patch 会再引入段首机械重复、
    // 截断句残留与关键小节表格承载正文，一并纳入链循环收敛
    md => { const r = fixParagraphOpeningRepeats(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; },
    md => { const r = fixTruncatedSentenceArtifacts(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; },
    md => { const r = fixTableBorneContentSections(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; },
    // F17/F18 评审轮后兜底（与 stage5 链同源）：评审轮 patch 会再引入元话语声明句与公式形态
    md => { const r = fixMetaDiscourseDeclarations(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; },
    md => { const r = fixFormulaResidues(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; },
    md => { const r = fixSelfUnderminingCandidates(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; },
    md => { const r = fixEmptyScoringResponses(md); return { markdown: r.markdown, fixedCount: r.fixedCount }; },
    md => dedupeTertiaryH4Titles(md),
    md => fixInternalTermHeadingPhrases(md),
  ], finalMarkdown, 3);
  if (surfaceFixRound2Result.markdown !== finalMarkdown) {
    finalMarkdown = surfaceFixRound2Result.markdown;
    await recomputeFinalValidationBundle();
  }
  // 内部术语句子确定性删除兜底（round-19 R3 已实现未接线，丰乐镇第 2 轮实测：
  // 「落位」「控制口径」「峰值口径」「数据口径」经 LLM 修复轮仍残留 4 词，检测器报 error blocker；
  // 交付前接入与检测器同源同阈值的整句删除（L1 精确词 + L3 语义锚点，标题/表格/目录行豁免），
  // 删除后重算校验组，旧 issue 快照由 recompute 内部口径剔除）
  const strippedTerminologyMarkdown = await stripInternalTerminologySentences(finalMarkdown);
  if (strippedTerminologyMarkdown !== finalMarkdown) {
    finalMarkdown = strippedTerminologyMarkdown;
    await recomputeFinalValidationBundle();
  }
  // B2 目录与正文一致性兜底：目录按最终正文 H2/H3 实际结构重建（fixTocFromBody 无改动时零成本），
  // 修复后再重算校验组，保证交付门禁与评分基于目录一致的最终成稿
  const tocConsistencyFix = fixTocFromBody(finalMarkdown);
  if (tocConsistencyFix.fixedCount > 0) {
    finalMarkdown = tocConsistencyFix.markdown;
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
  // 阶段展示终态直接汇总（历史 export_ready/document-workflow/agent-reviewer-repairer 状态修正分支已随旧管线删除）
  const finalStages = [...executionStages, ...finalGateRepairStages];
  // 门禁 details 全量持久化：阻断问题逐条落盘不截断（第九次回归实测 39 条阻断只落 12 条，
  // 生成后审查无法按执行阶段复盘全部阻断根因；检测器侧已各自限幅、阻断总数有界，无膨胀风险）
  finalStages.push(displayStage({ type: 'validation', roleId: 'agent-final-gate', status: finalExportGate.passed ? 'success' : 'failed', message: finalExportGate.passed ? 'Agent 最终门禁通过' : `Agent 最终门禁阻断 ${blockingCount} 个问题`, details: finalExportGate.blockingIssues.map(issue => issue.message) }, { subtitle: 'Agent 最终门禁' }));
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
  // 4.1 per-调用分量 Top5 输入大头（message 压缩展示 + details 五维度完整行）
  const callTopSummary = callBreakdownTopSummary(generationDiagnostics.llm.callBreakdown);
  // 1.1 事实净化门计数（合肥师范样本脏值形态：表格碎片/页码/标题标记/编号截断），非零才展示
  const factSanitizeMessage = generationDiagnostics.factSanitize
    ? `，事实净化 截断${generationDiagnostics.factSanitize.truncated}/丢弃${generationDiagnostics.factSanitize.dropped}/编号补全${generationDiagnostics.factSanitize.repaired}`
    : '';
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-diagnostics', status: 'success', message: `性能统计：LLM ${generationDiagnostics.llm.calls} 次，失败 ${generationDiagnostics.llm.failures} 次，瞬态重试 ${generationDiagnostics.llm.retries} 次，schema 校验失败 ${generationDiagnostics.llm.schemaFailures} 次，峰值并行 ${generationDiagnostics.llm.maxActive}，检索 ${generationDiagnostics.evidence.searchQueries} 次/${Math.round(generationDiagnostics.evidence.searchMs / 1000)} 秒，证据上下文 ${generationDiagnostics.evidence.contextChars} 字，噪声过滤 ${generationDiagnostics.evidence.filteredNoise} 条，预算裁剪 ${generationDiagnostics.evidence.budgetDropped} 条，质量问题 阻断${generationDiagnostics.quality.blockingCount}/重要${generationDiagnostics.quality.importantCount}/轻微${generationDiagnostics.quality.minorCount}${factSanitizeMessage}${slowMetrics ? `，Top耗时：${slowMetrics}` : ''}${callTopSummary ? `，调用输入Top5：${callTopSummary}` : ''}`, details: [...phaseWaterfallDetails(generationDiagnostics.metrics), ...callBreakdownTopDetails(generationDiagnostics.llm.callBreakdown)] }, { subtitle: '后台诊断' }));

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
