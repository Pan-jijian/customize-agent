import * as path from 'node:path';
import * as fs from 'node:fs';
import { computeProjectId } from '@customize-agent/knowledge';
import { getMultiProjectManager, getProjectRoot, listKnowledgeFiles } from '../knowledge/kbService';
import { getConfigStore } from '../common/configService';
import { getProjectRoleConfig, listDocumentRoles } from '../document-core/documentRoleService';
import { autoSpecPrompt, getOrCreateAutoDocumentSpec } from '../document-core/autoDocumentSpecService';
import { buildProjectMaterialSummary, projectMaterialPrompt } from '../document-core/projectMaterialService';
import { resolveDocumentDomainProfile } from '../document-core/documentDomainProfileService';
import { resolveTemplateMaterialRoles } from '../document-core/materialRoleResolver';
import { evaluateDocumentReadiness, readinessPrompt } from '../document-validation/documentReadinessService';
import { validateDraftWithAutoSpec } from '../document-validation/documentValidationService';
import { validateProjectContamination } from '../document-validation/documentContaminationService';
import { chapterReadinessIssues, evaluateChapterReadiness } from '../document-validation/chapterReadinessService';
import { validateFactConsistency } from '../document-validation/factConsistencyService';
import type { KbSearchResult } from '@/lib/api';
import type { DocumentAsset, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, FileBinding, GeneratedDocumentDraft, RetrievalCoverageReport, ValidationIssue, WebAccessConfig } from './types';
import { boundFileRolesForMaterialSummary, buildPromptBindingPlan, defaultProjectRoleConfigIdForTemplate, getDocumentTemplate, templateFileBindings, templatePromptBindings, type ResolvedPromptContent } from './templateStore';
import { evidenceLine, evidencePromptBudgetForTarget, selectEvidenceByBudget } from './evidence';
import { displayChapterTitle, effectiveTemplateChapters, extractExplicitOutlineFromSources } from './outline';
import { evidenceMatchesFact } from './factMatching';
import { composeDocumentMarkdown, plannedStructureIssues, plannedStructurePrompt, promptDocumentRuleIssues, extractGeneratedSections, finalizeDocumentMarkdown, tertiaryHeadingIssues } from './markdownComposer';
import { buildDocumentBudget, documentBudgetIssues, documentBudgetStatus, documentTextLength, pageTargetIssues } from './budget';
import { applySpecGateRules, buildExportGate, collectSectionContentGaps, plannedAutoSpecGateIssues, duplicateBasicInfoIssues, formalContentIntegrityIssues, formalPlaceholderIssues, formalStyleIssues, isExportBlockingIssue, minChapterSectionIssues, preciseFactUsageIssues, qualitySeveritySummary, sectionContentIntegrityIssues, tocBodyConsistencyIssues, tocHierarchyIssues } from './qualityValidation';
import { buildPostRepairIssues, buildProfessionalRepairIssues } from './documentPostRepairChecks';
import { buildRepairTaskMessage, collectMessageGroups, collectValidationIssueGroups, dedupeValidationIssues, repairIssueSignature, unresolvedRepairTasks } from './documentQualityPipeline';
import { buildDocumentBlueprintContext } from './documentBlueprint';
import { buildStandardFinalValidationIssues } from './documentFinalValidation';
import { buildDocumentProfileReport } from './documentProfiles';
import { buildKnowledgeCoverageReport, knowledgeCoverageIssues } from './documentKnowledgeCoverage';
import { buildDocumentFactTraces, factTraceIssues } from './documentFactTrace';
import { buildChapterCoverageReports, chapterCoverageIssues } from './documentChapterCoverage';
import { buildDocumentQualityReport, qualityReportIssues } from './documentQualityReport';
import { buildRepairStrategies, repairStrategyIssues } from './documentRepairStrategies';
import { buildDocumentReviewChecklist } from './documentReviewChecklist';
import { DOCUMENT_WORKFLOW_VERSION } from './documentWorkflowVersion';
import { buildDocumentTelemetryReport } from './documentTelemetry';
import { buildRetrievalCoverageReport, retrieveDeepChapterEvidence, retrievalCoverageIssues, retrievalCoverageRisk, sampleBoundFileEvidence } from './documentEvidenceRetrieval';
import { buildChapterFactNeeds, extractFacts, extractFactsWithLlm, extractPreciseFactsFromEvidence, extractProjectBasicFactsFromEvidence, extractStructuredFacts, extractStructuredTables, buildFactsModel, factNeedsCoveragePrompt, factsForChapterNeeds, isValidProjectBasicFactValue, normalizeOcrFactText, resolveChapterFactNeeds, shouldRunLlmFactExtraction } from './factsModel';
import { buildCanonicalFacts } from './factGovernance';
import { stableHash, stringifyFactValue, throwIfAborted } from '@/services/document-workflow/utils';
import { displayStage, elapsedMessage, upsertProgressStage } from './progress';
import { callWithTimeout, getActiveModelWithProvider } from './llmClient';
import type { RoleNodeArtifact } from './rolePipeline';
import { blockingChapterIssues, buildBoundEvidenceScope, buildRoleChapterContext, buildRoleEvidencePool, buildRoleExecutionNodes, chapterPlanFor, createGenerationDiagnostics, evidenceForRoleFiles, evidenceInScope, executeRoleExtractionNode, fileScopeKeys, lightweightChapterIssues, measureGenerationStep, promptTextsForResolvedPrompts, projectEvidenceVersionHash, repairChapterByQuality, repairMarkdownByQuality, roleArtifactsDigest, roleFactsForChapter, shouldForbidDrawingImages, selectDocumentGenerationStrategy, tenderPlanChaptersFromArtifacts } from './rolePipeline';
import { buildChapterFactCoverageContext, buildLlmChapterContent, buildRuntimePromptRules, buildSectionParallelChapterContent, buildValidationIssues, chapterSectionFactUsageIssues, expandChapterToTarget, expandDocumentToBudget, extractPromptStructuralRules, normalizePlannedSections, outputTokensForChapter, planChapterSectionsWithLlm, reviewAndOptimizeMarkdown, reviewChapterSummaries, reviewGlobalConsistency, runtimePromptRulesPrompt, supplementShortSections, timeoutMsForChapter, understandReferenceFiles } from './chapterGeneration';
import { retrieveWebEvidence, webAccessPrompt } from './webResearchService';


function reportGenerationDebugEvent(projectRoot: string, event: Record<string, unknown>) {
  try {
    const envPath = ['chapter-generation-failure.env', 'document-generation-timeout.env'].map(name => path.join(projectRoot, '.dbg', name)).find(file => fs.existsSync(file));
    if (!envPath) return;
    const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/u).map(line => line.split('=')).filter(parts => parts.length >= 2).map(([key, ...rest]) => [key, rest.join('=')])) as Record<string, string>;
    const url = env.DEBUG_SERVER_URL;
    if (!url) return;
    void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: env.DEBUG_SESSION_ID || 'chapter-generation-failure', runId: 'pre', ts: Date.now(), ...event }) }).catch(() => undefined);
  } catch {
    // debug-only: ignore reporting failures
  }
}

function expandDirectoryFileBindings(projectRoot: string, bindings: FileBinding[]) {
  if (bindings.length === 0) return bindings;
  const files = listKnowledgeFiles(projectRoot);
  const filePathSet = new Set(files.map(file => file.relativePath));
  const usableDirectoryFiles = files.filter(file => file.status !== 'disk' && file.status !== 'error' && Number(file.indexedAt || 0) > 0 && Number(file.chunkCount || 0) > 0);
  const expanded: FileBinding[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    const normalizedPath = binding.filePath.replace(/^\/+|\/+$/gu, '');
    const matchedPaths = filePathSet.has(normalizedPath)
      ? [normalizedPath]
      : usableDirectoryFiles.filter(file => file.relativePath.startsWith(`${normalizedPath}/`)).map(file => file.relativePath);
    for (const filePath of matchedPaths) {
      const key = `${binding.roleId}\n${filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      expanded.push({ ...binding, filePath });
    }
  }
  return expanded;
}

function validateDraft(chapters: DocumentDraftChapter[], structuredFacts: DocumentFact[] = [], template?: DocumentTemplate) {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const chapter of chapters) {
    if (chapter.evidence.length === 0) warnings.push(`${chapter.title} 未检索到资料证据`);
    if (chapter.content.length < 80) warnings.push(`${chapter.title} 内容较短，建议人工补充或重新生成`);
  }
  if (template && chapters.length < template.chapters.length) errors.push(`章节生成不完整：已生成 ${chapters.length}/${template.chapters.length} 章`);
  if (template && templatePromptBindings(template).length === 0) errors.push('模板未绑定任何提示词');
  const roleIds = new Set(structuredFacts.map(fact => fact.roleId));
  if (template?.fileBindings?.some(binding => binding.roleId === 'rule') && !roleIds.has('rule')) warnings.push('rule 角色未抽取到结构化事实');
  return { passed: errors.length === 0, warnings, errors };
}

function chapterCompletionStatus(chars: number, targetWords: number, issues: string[] = []): DocumentExecutionStage['status'] {
  if (chars <= 0 || issues.some(issue => /未返回有效章节正文|生成失败/u.test(issue))) return 'failed';
  const targetChars = Math.max(1, Math.floor(targetWords * 0.95));
  if (chars < Math.floor(targetChars * 0.75)) return 'failed';
  if (chars < Math.floor(targetChars * 0.9) || issues.length > 0) return 'fallback';
  return 'success';
}

function partialChapterStatus(chapter: DocumentDraftChapter, targetWords?: number): 'completed' | 'failed' {
  const chars = documentTextLength(chapter.content);
  if (chars <= 0) return 'failed';
  if (targetWords && chars < Math.floor(targetWords * 0.95 * 0.75)) return 'failed';
  return 'completed';
}

const PROJECT_BASIC_FACT_QUERIES = [
  '项目名称 项目编号 招标人 项目概况与招标范围 建设地点 建设规模 计划工期 质量标准 合同估算价',
  '计划工期 合同工期 总工期 日历天',
  '合同估算价 合同估算价格 投资估算 最高投标限价 招标控制价',
  '质量标准 质量目标 合格',
  '建设地点 建设规模 招标范围',
];

function projectBasicFactScore(text: string) {
  const normalized = normalizeOcrFactText(text);
  let score = 0;
  if (/项目名称|工程名称|招标项目名称|项目编号|招标项目编号|招标人|建设单位|发包人/u.test(normalized)) score += 4;
  if (/计划工期|合同工期|总工期|\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年)/u.test(normalized)) score += 6;
  if (/合同估算价|投资估算|最高投标限价|招标控制价|\d+(?:\.\d+)?\s*(?:万元|元)/u.test(normalized)) score += 5;
  if (/质量标准|质量目标|合格|优良/u.test(normalized)) score += 4;
  if (/建设地点|建设规模|招标范围|项目概况与招标范围/u.test(normalized)) score += 4;
  if (/招标文件|招标公告|投标人须知|前附表|合同协议/u.test(normalized)) score += 2;
  return score;
}

function evidenceDedupeIdentity(item: DocumentEvidence) {
  return `${item.filePath}|${item.sectionTitle || ''}|${normalizeOcrFactText(item.content).slice(0, 180)}`;
}

async function collectProjectBasicEvidence(input: { manager: ReturnType<typeof getMultiProjectManager>; project: any; projectRoot: string; scopedFilePaths: string[]; fileRoleByPath: Map<string, string>; fileProcessingByPath: Map<string, string>; signal?: AbortSignal }): Promise<DocumentEvidence[]> {
  const evidence: DocumentEvidence[] = [];
  const scopedFileSet = new Set(input.scopedFilePaths);
  for (const query of PROJECT_BASIC_FACT_QUERIES) {
    throwIfAborted(input.signal);
    const result = await input.manager.search(input.projectRoot, query, { scope: 'project', filters: { filePaths: input.scopedFilePaths }, limit: 10, weights: { keyword: 0.65, vector: 0.25, rewrite: 0.8, hybridBonus: 0.2 }, generationMode: false });
    evidence.push(...result.results.filter(item => scopedFileSet.has(item.filePath) && projectBasicFactScore(`${item.sectionTitle || ''}\n${item.content}`) > 0).map(item => ({
      chapterId: 'project-basic',
      filePath: item.filePath,
      score: Math.max(item.score, 1) + projectBasicFactScore(`${item.sectionTitle || ''}\n${item.content}`),
      content: item.content,
      roleId: input.fileRoleByPath.get(item.filePath),
      processingType: input.fileProcessingByPath.get(item.filePath),
      sectionTitle: item.sectionTitle,
      source: 'pinned-evidence',
    })));
  }
  for (const relativePath of input.scopedFilePaths) {
    throwIfAborted(input.signal);
    const detail = input.project.getFileDetail?.(relativePath, { maxChunkContentChars: 12000 });
    if (!detail?.chunks?.length) continue;
    for (const chunk of detail.chunks as Array<{ content: string; sectionTitle?: string }>) {
      const text = `${chunk.sectionTitle || ''}\n${chunk.content || ''}`;
      const score = projectBasicFactScore(text);
      if (score <= 0) continue;
      const filePath = detail.file?.relativePath || relativePath;
      evidence.push({
        chapterId: 'project-basic',
        filePath,
        score: 1 + score,
        content: chunk.content,
        roleId: input.fileRoleByPath.get(filePath),
        processingType: input.fileProcessingByPath.get(filePath),
        sectionTitle: chunk.sectionTitle,
        source: 'pinned-evidence',
      });
    }
  }
  const seen = new Set<string>();
  return evidence.sort((a, b) => b.score - a.score).filter(item => {
    const key = evidenceDedupeIdentity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

function criticalChapterSectionGaps(markdown: string, chapter: DocumentTemplateChapter) {
  return collectSectionContentGaps(markdown, [{ title: chapter.title, content: markdown, sections: chapter.sections || [] }])
    .filter(gap => gap.planned || gap.reason === 'missing_planned_section');
}

function repairPlannedSectionBodies(content: string, _chapter: Pick<DocumentTemplateChapter, 'title' | 'sections'>) {
  return content;
}

function repairTableOnlySections(content: string) {
  return content;
}

function projectBasicFactCandidates(facts: DocumentFact[]) {
  return facts.filter(fact => /项目名称|工程名称|项目编号|招标项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|计划工期|合同工期|周期要求|质量标准|合同估算|投资估算|最高投标限价|招标控制价/u.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`));
}

function projectBasicValueFor(facts: DocumentFact[], patterns: RegExp[]) {
  return projectBasicFactCandidates(facts)
    .filter(fact => patterns.some(pattern => pattern.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`)))
    .filter(fact => isValidProjectBasicFactValue(fact.fieldId, fact.value))
    .sort((a, b) => {
      const aText = stringifyFactValue(a.value);
      const bText = stringifyFactValue(b.value);
      const aScore = (a.sourceFile?.includes('招标文件') ? 3 : 0) + (a.sourceRef?.sectionTitle && /项目概况|招标公告|前附表|招标范围/u.test(a.sourceRef.sectionTitle) ? 2 : 0) - Math.floor(aText.length / 80);
      const bScore = (b.sourceFile?.includes('招标文件') ? 3 : 0) + (b.sourceRef?.sectionTitle && /项目概况|招标公告|前附表|招标范围/u.test(b.sourceRef.sectionTitle) ? 2 : 0) - Math.floor(bText.length / 80);
      return bScore - aScore;
    })[0]?.value;
}

function repairKnownProjectBasicPlaceholders(content: string, facts: DocumentFact[]) {
  const candidates = projectBasicFactCandidates(facts);
  if (candidates.length === 0) return content;
  let next = content;
  const valueFor = (patterns: RegExp[]) => projectBasicValueFor(facts, patterns);
  const replacements: Array<{ label: RegExp; value?: unknown }> = [
    { label: /计划工期|合同工期|周期要求/u, value: valueFor([/计划工期|合同工期|周期要求|schedule_requirement/u]) },
    { label: /质量标准|质量目标/u, value: valueFor([/质量标准|quality_standard/u]) },
    { label: /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u, value: valueFor([/合同估算|投资估算|最高投标限价|招标控制价|project_investment_estimate/u]) },
    { label: /建设地点/u, value: valueFor([/建设地点|project_location/u]) },
    { label: /建设规模/u, value: valueFor([/建设规模|project_scale/u]) },
  ];
  for (const item of replacements) {
    const value = cleanInlineFactValue(stringifyFactValue(item.value || ''));
    if (!value) continue;
    next = next.replace(new RegExp(`(${item.label.source})(\\s*[|：:]\\s*)(?:资料未明确|系统暂未从知识库确认)[^|\\n。；;]*`, 'gu'), `$1$2${value}`);
  }
  return next;
}

function cleanInlineFactValue(value: string) {
  return normalizeOcrFactText(value).replace(/[。；;]$/u, '').trim();
}

function parseProjectBasicRowsFromMarkdown(content: string) {
  const rows = new Map<string, [string, string]>();
  for (const line of content.split(/\r?\n/u)) {
    if (!/^\|.*\|\s*$/u.test(line) || /^\|\s*:?-{3,}:?/u.test(line)) continue;
    const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.replace(/\*\*/gu, '').trim());
    if (cells.length < 2) continue;
    const label = cells[0] === '序号' && cells.length >= 3 ? cells[1] : cells[0];
    const value = cells[0] === '序号' && cells.length >= 3 ? cells[2] : cells[1];
    const source = cells[0] === '序号' && cells.length >= 4 ? cells[3] : cells[2];
    const normalizedLabel = label.replace(/\/|：|:/gu, '').trim();
    if (!/项目名称|工程名称|项目编号|招标项目编号|招标人|项目业主|建设单位|发包人|建设地点|建设规模|施工范围|招标范围|计划工期|合同工期|质量标准|合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(normalizedLabel)) continue;
    const fieldId = /计划工期|合同工期/u.test(normalizedLabel) ? 'schedule_requirement'
      : /质量标准/u.test(normalizedLabel) ? 'quality_standard'
        : /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(normalizedLabel) ? 'project_investment_estimate'
          : /招标人|项目业主|建设单位|发包人/u.test(normalizedLabel) ? 'owner'
            : /建设地点/u.test(normalizedLabel) ? 'project_location'
              : /项目编号|招标项目编号/u.test(normalizedLabel) ? 'project_code'
                : undefined;
    if (!value || /内容|参数|资料未明确|系统暂未从知识库确认/u.test(value) || !isValidProjectBasicFactValue(fieldId || 'project_name', value)) continue;
    rows.set(normalizedLabel, [cleanInlineFactValue(value), cleanInlineFactValue(source || '项目资料') || '项目资料']);
  }
  return rows;
}

function markdownRowValue(parsedRows: Map<string, [string, string]>, patterns: RegExp[]) {
  for (const [label, value] of parsedRows.entries()) {
    if (patterns.some(pattern => pattern.test(label))) return value;
  }
  return undefined;
}

function projectBasicInfoRows(facts: DocumentFact[], existingMarkdown = '', fullMarkdown = existingMarkdown) {
  const parsedRows = parseProjectBasicRowsFromMarkdown(existingMarkdown);
  const canonical = buildCanonicalFacts({ facts, markdown: fullMarkdown });
  const pickCanonical = (key: string, fallbackPatterns: RegExp[]) => {
    const fact = canonical.get(key);
    if (fact) return [fact.value, fact.source || '项目资料'] as [string, string];
    return markdownRowValue(parsedRows, fallbackPatterns) || ['', ''];
  };
  const rows: Array<[string, string, string]> = [
    ['项目名称', ...pickCanonical('project_name', [/项目名称|工程名称|project_name/u])],
    ['项目编号', ...pickCanonical('project_code', [/项目编号|招标项目编号|project_code/u])],
    ['招标人', ...pickCanonical('owner', [/招标人|项目业主|建设单位|发包人|owner/u])],
    ['建设地点', ...pickCanonical('project_location', [/建设地点|project_location/u])],
    ['建设规模', ...pickCanonical('project_scale', [/建设规模|project_scale/u])],
    ['计划工期', ...pickCanonical('schedule_requirement', [/计划工期|合同工期|周期要求|schedule_requirement/u])],
    ['质量标准', ...pickCanonical('quality_standard', [/质量标准|quality_standard/u])],
    ['合同估算价', ...pickCanonical('project_investment_estimate', [/合同估算|投资估算|最高投标限价|招标控制价|project_investment_estimate/u])],
  ];
  return rows.map(([label, value, source]) => [label, value || '系统暂未从知识库确认', value ? source || '项目资料' : '待系统补抽确认'] as [string, string, string]);
}

function projectBasicInfoTableMarkdown(facts: DocumentFact[], existingMarkdown = '', fullMarkdown = existingMarkdown) {
  const rows = projectBasicInfoRows(facts, existingMarkdown, fullMarkdown);
  return ['**项目基本信息表**', '', '| 信息项 | 内容 |', '|---|---|', ...rows.map(row => `| ${row[0]} | ${row[1]} |`)].join('\n');
}

function isMarkdownTableSeparatorLine(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line.trim());
}

function looksLikeMarkdownTableLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || /^#{1,6}\s+/u.test(trimmed) || isMarkdownTableSeparatorLine(trimmed)) return false;
  const pipeCount = (trimmed.match(/\|/gu) || []).length;
  return pipeCount >= 2 || pipeCount >= 1 && /^\s*\|/u.test(trimmed) || pipeCount >= 1 && /\|\s*$/u.test(trimmed);
}

function splitMarkdownTableLine(line: string) {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').trim().split('|').map(cell => cell.trim());
}

function formatMarkdownTableLine(cells: string[], columns: number) {
  const normalized = cells.slice(0, columns);
  while (normalized.length < columns) normalized.push('');
  return `| ${normalized.join(' | ')} |`;
}

function genericTableHeaders(columns: number) {
  if (columns === 2) return ['信息项', '内容'];
  const headers = ['项目', '内容', '备注', '说明'];
  return Array.from({ length: columns }, (_item, index) => headers[index] || `列${index + 1}`);
}

function normalizeBareMarkdownTables(markdown: string) {
  const lines = markdown.replace(/\r?\n/gu, '\n').split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    const nextIndex = lines[index + 1]?.trim() === '' ? index + 2 : index + 1;
    const separator = lines[nextIndex] || '';
    if (looksLikeMarkdownTableLine(line) && isMarkdownTableSeparatorLine(separator)) {
      output.push(line);
      if (nextIndex !== index + 1) output.push(lines[index + 1] || '');
      output.push(separator);
      index = nextIndex + 1;
      while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
        output.push(lines[index] || '');
        index += 1;
      }
      continue;
    }
    if (!looksLikeMarkdownTableLine(line)) {
      output.push(line);
      index += 1;
      continue;
    }
    const rows: string[] = [];
    let cursor = index;
    while (cursor < lines.length && looksLikeMarkdownTableLine(lines[cursor] || '')) {
      rows.push(lines[cursor] || '');
      cursor += 1;
    }
    const columnCounts = rows.map(row => splitMarkdownTableLine(row).length);
    const columns = columnCounts[0] || 0;
    if (rows.length < 2 || columns < 2 || columnCounts.some(count => count !== columns)) {
      output.push(line);
      index += 1;
      continue;
    }
    if (output.length > 0 && output[output.length - 1]?.trim()) output.push('');
    output.push(formatMarkdownTableLine(genericTableHeaders(columns), columns));
    output.push(formatMarkdownTableLine(Array.from({ length: columns }, () => '---'), columns));
    for (const row of rows) output.push(formatMarkdownTableLine(splitMarkdownTableLine(row), columns));
    index = cursor;
    if (index < lines.length && lines[index]?.trim()) output.push('');
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n');
}

function stripProvenanceTableColumns(markdown: string) {
  const lines = markdown.replace(/\r?\n/gu, '\n').split('\n');
  const output: string[] = [];
  const splitRow = (line: string) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
  const isTableRow = (line: string) => /^\s*\|.*\|\s*$/u.test(line);
  const isSeparator = (line: string) => /^\s*\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line);
  const formatRow = (cells: string[]) => `| ${cells.join(' | ')} |`;
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    const separator = lines[index + 1] || '';
    if (!isTableRow(line) || !isSeparator(separator)) {
      output.push(line);
      index += 1;
      continue;
    }
    const headers = splitRow(line);
    const removeIndexes = headers.map((cell, cellIndex) => /^(?:资料来源|资料来源\/(?:说明|证明)|来源|证明)$/u.test(cell) ? cellIndex : -1).filter(cellIndex => cellIndex >= 0);
    if (removeIndexes.length === 0) {
      output.push(line);
      index += 1;
      continue;
    }
    const keep = (cells: string[]) => cells.filter((_cell, cellIndex) => !removeIndexes.includes(cellIndex));
    output.push(formatRow(keep(headers)));
    output.push(formatRow(keep(splitRow(separator)).map(cell => cell || '---')));
    index += 2;
    while (index < lines.length && isTableRow(lines[index] || '')) {
      output.push(formatRow(keep(splitRow(lines[index] || ''))));
      index += 1;
    }
  }
  return output.join('\n').replace(/资料来源\/(?:说明|证明)/gu, '');
}

function removeDuplicateProjectBasicInfoBlocks(markdown: string) {
  const projectBasicLabels = [/^项目名称$/u, /^工程名称$/u, /^项目编号$/u, /^招标项目编号$/u, /^招标人$/u, /^项目业主$/u, /^建设单位$/u, /^发包人$/u, /^建设地点$/u, /^实施地点$/u, /^建设规模$/u, /^工程规模$/u, /^计划工期$/u, /^合同工期$/u, /^总工期$/u, /^质量标准$/u, /^质量目标$/u, /^合同估算价$/u, /^投资估算$/u, /^最高投标限价$/u, /^招标控制价$/u];
  const lines = markdown.replace(/\r?\n/gu, '\n').split('\n');
  const output: string[] = [];
  let seenProjectBasicTable = false;
  const splitRow = (line: string) => splitMarkdownTableLine(line).map(cell => cell.replace(/\*\*/gu, '').trim());
  const isProjectBasicLabel = (label: string) => projectBasicLabels.some(pattern => pattern.test(label));
  const isTwoColumnProjectBasicTable = (rows: string[]) => {
    const dataRows = rows.slice(2).map(splitRow).filter(cells => cells.length >= 2);
    const labels = dataRows.map(cells => cells[0] || '');
    const matched = labels.filter(isProjectBasicLabel).length;
    return matched >= 3 && matched >= Math.ceil(labels.length * 0.45);
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    const next = lines[index + 1] || '';
    const namedProjectBasicTitle = /(?:\*\*[^\n]*项目基本信息表[^\n]*\*\*|####\s+[^\n]*项目基本信息表[^\n]*|###\s+[^\n]*项目基本信息表[^\n]*)/u.test(line);
    if (namedProjectBasicTitle) {
      const block: string[] = [line];
      index += 1;
      while (index < lines.length && !(looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) && (lines[index] || '').trim() === '') {
        block.push(lines[index] || '');
        index += 1;
      }
      if (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) {
        block.push(lines[index] || '', lines[index + 1] || '');
        index += 2;
        while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
          block.push(lines[index] || '');
          index += 1;
        }
      }
      if (!seenProjectBasicTable) {
        seenProjectBasicTable = true;
        output.push(...block);
      }
      continue;
    }
    if (looksLikeMarkdownTableLine(line) && isMarkdownTableSeparatorLine(next)) {
      const rows = [line, next];
      index += 2;
      while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
        rows.push(lines[index] || '');
        index += 1;
      }
      if (isTwoColumnProjectBasicTable(rows)) {
        if (!seenProjectBasicTable) {
          seenProjectBasicTable = true;
          output.push(...rows);
        }
        continue;
      }
      output.push(...rows);
      continue;
    }
    output.push(line);
    index += 1;
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\n{1,2}\|\s*信息项\s*\|\s*内容\s*\|\s*\n+(?:该小节围绕[^\n]*\n+)+\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*/gu, '\n\n');
}

function normalizeProjectBasicInfoTable(content: string, facts: DocumentFact[]) {
  if (!/项目基本信息|项目概况|工程概况|招标范围/u.test(content)) return removeDuplicateProjectBasicInfoBlocks(normalizeBareMarkdownTables(stripProvenanceTableColumns(content)));
  const projectSection = /^(###\s+(?:\d+\.\d+\s+)?[^\n]*(?:项目概况|工程概况|项目基本信息|招标范围)[^\n]*\n)/mu.exec(content);
  if (!projectSection?.index && projectSection?.index !== 0) return content;
  const sectionStart = projectSection.index;
  const sectionBodyStart = sectionStart + projectSection[0].length;
  const nextHeading = /^###\s+/gmu;
  nextHeading.lastIndex = sectionBodyStart;
  const nextMatch = nextHeading.exec(content);
  const sectionEnd = nextMatch?.index ?? content.length;
  const body = content.slice(sectionBodyStart, sectionEnd);
  const table = projectBasicInfoTableMarkdown(facts, body, content);
  const hasUsefulFact = projectBasicInfoRows(facts, body, content).some(row => !/资料未明确|系统暂未从知识库确认/u.test(row[1]));
  if (!hasUsefulFact) return content;
  const cleanedBody = body
    .replace(/\*\*项目基本信息表\*\*[\s\S]*?(?=\n\n(?:[^|\n]|$)|$)/u, '')
    .replace(/\|\s*(?:序号\s*\|\s*项目名称\s*\|\s*内容参数|信息项\s*\|\s*内容\s*(?:\|\s*资料来源\/(?:说明|证明))?)\s*\|[\s\S]*?(?=\n\n(?:[^|\n]|$)|$)/u, '')
    .replace(/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|\s*\n(?:^\|.*\|\s*\n?)*/gmu, '')
    .replace(/该小节围绕“[^”]+”进行补充说明[^\n]*(?:\n\n该小节围绕“[^”]+”进行补充说明[^\n]*)*/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const rebuiltSection = `${projectSection[0].trimEnd()}\n\n${table}${cleanedBody ? `\n\n${cleanedBody}` : ''}\n\n`;
  return removeDuplicateProjectBasicInfoBlocks(normalizeBareMarkdownTables(stripProvenanceTableColumns(`${content.slice(0, sectionStart)}${rebuiltSection}${content.slice(sectionEnd).trimStart()}`)));
}

function projectBasicPlaceholderIssues(markdown: string, facts: DocumentFact[]) {
  if (projectBasicFactCandidates(facts).length === 0 || !/资料未明确|系统暂未从知识库确认/u.test(markdown)) return [];
  const labels = ['计划工期', '合同工期', '质量标准', '合同估算价', '合同估算价格', '建设地点', '建设规模'];
  return labels.filter(label => new RegExp(`${label}[^\n|。；;]{0,40}(?:资料未明确|系统暂未从知识库确认)`, 'u').test(markdown)).map(label => ({ level: 'error' as const, message: `${label} 已抽取到知识库事实但正文仍显示系统暂未确认`, suggestion: '请优先使用项目基础事实卡片中的知识库原值，不得用占位表达覆盖已确认事实。' }));
}

function replaceForbiddenFormalPhrases(content: string) {
  return content
    .replace(/见招标文件/gu, '按本项目招标文件已明确的相应条款执行')
    .replace(/按图纸/gu, '依据经确认的设计文件和图纸内容组织实施')
    .replace(/按设计要求/gu, '依据设计文件明确的构造、材料、尺寸和验收要求执行')
    .replace(/按(?:资料|文件|说明|方案|规范|标准|要求)/gu, '依据本项目已确认资料、技术文件和验收标准')
    .replace(/满足(?:相关|有关)?要求/gu, '满足本项目已明确的质量、安全、技术和验收控制要求')
    .replace(/\b兜底\b|兜底生成|兜底片段/gu, '补充完善')
    .replace(/本节(?:将|主要|重点)?/gu, '')
    .replace(/本章将/gu, '')
    .replace(/根据需要|视情况|结合实际情况/gu, '结合已确认资料、现场条件和审批后的施工组织安排')
    .replace(/相关要求/gu, '本项目已明确的质量、安全、技术和验收要求');
}

function splitLongParagraphs(content: string) {
  return content.split(/\n{2,}/u).map(block => {
    if (/^\s*(#{1,6}\s+|[-*+]\s+|\|)/u.test(block) || block.length < 520) return block;
    const sentences = block.split(/(?<=[。；])/u).map(item => item.trim()).filter(Boolean);
    if (sentences.length < 4) return block;
    const chunks: string[] = [];
    let current = '';
    for (const sentence of sentences) {
      if (current.length > 260 && current.length + sentence.length > 420) {
        chunks.push(current);
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current) chunks.push(current);
    return chunks.join('\n\n');
  }).join('\n\n');
}

function finalizeChapterContentQuality(content: string, chapter: Pick<DocumentTemplateChapter, 'title' | 'sections'>) {
  return splitLongParagraphs(replaceForbiddenFormalPhrases(repairTableOnlySections(repairPlannedSectionBodies(content, chapter)))).replace(/\n{3,}/gu, '\n\n').trim();
}

function promptMatchesChapter(prompt: ResolvedPromptContent, _chapter: DocumentTemplateChapter) {
  return prompt.category === 'writer' || prompt.category === 'chapter' || prompt.category === 'formatting';
}

function resolveChapterPromptExecution(promptPlan: ReturnType<typeof buildPromptBindingPlan>, chapter: DocumentTemplateChapter) {
  const chapterPrompts = promptPlan.chapterPrompts.filter(prompt => promptMatchesChapter(prompt, chapter));
  const prompts = [...promptPlan.writerPrompts, ...chapterPrompts, ...promptPlan.formattingPrompts];
  const primaryWriter = promptPlan.writerPrompts[0];
  const promptDetails = prompts.map(prompt => `${prompt.category === 'writer' ? '写作控制提示词' : prompt.category}｜${prompt.roleId}｜${prompt.name}｜${prompt.content.length} 字符`);
  const systemPrompt = promptTextsForResolvedPrompts(promptPlan.writerPrompts);
  const scopedPrompt = promptTextsForResolvedPrompts([...chapterPrompts, ...promptPlan.formattingPrompts]);
  return {
    primaryPromptId: primaryWriter?.id,
    primaryWriter,
    prompts,
    promptTexts: [
      systemPrompt ? `【最高优先级：配置写作主控提示词】\n${systemPrompt}` : '',
      scopedPrompt ? `【章节/格式提示词】\n${scopedPrompt}` : '',
    ].filter(Boolean).join('\n\n'),
    promptDetails,
  };
}

function factsWithSourceFallback(facts: DocumentFact[], evidence: DocumentEvidence[]) {
  const fallback = evidence.find(item => item.filePath)?.filePath || '';
  if (!fallback) return facts;
  return facts.map(fact => fact.sourceFile ? fact : { ...fact, sourceFile: fallback, sourceRef: { filePath: fallback, roleId: fact.sourceRef?.roleId || fact.roleId, processingType: fact.sourceRef?.processingType || fact.processingType, sectionTitle: fact.sourceRef?.sectionTitle, chunkIndex: fact.sourceRef?.chunkIndex, cellRange: fact.sourceRef?.cellRange } });
}

function normalizeForCoverage(value: string) {
  return normalizeOcrFactText(value)
    .replace(/[\s,，.。:：;；|｜（）()《》<>【】"“”'‘’]/gu, '')
    .split('[').join('')
    .split(']').join('')
    .toLowerCase();
}

function isCommercialSensitiveFactText(text: string) {
  return /工程造价|造价|报价|投标报价|报价明细|综合单价|单价|合价|金额|税率|增值税|利润|预留金|暂列金额|最高投标限价|招标控制价|合同估算价|合同估算价格|投资估算|估算价/u.test(text);
}

function significantFactValue(value: unknown) {
  const text = cleanInlineFactValue(stringifyFactValue(value));
  if (!text || /资料未明确|系统暂未从知识库确认|未确认|待确认|无|暂无/u.test(text)) return '';
  if (isCommercialSensitiveFactText(text)) return '';
  if (text.length > 160) return '';
  return text;
}

function factValueAppears(markdown: string, value: string) {
  const normalizedMarkdown = normalizeForCoverage(markdown);
  const normalizedValue = normalizeForCoverage(value);
  if (!normalizedValue || normalizedValue.length < 2) return true;
  if (normalizedMarkdown.includes(normalizedValue)) return true;
  const numericParts = value.match(/\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年|万元|元|平方米|㎡|m²|立方米|m³|米|m|mm|cm|台|套|人|项|%|MPa|kPa)?/giu) || [];
  return numericParts.length > 0 && numericParts.some(part => normalizeForCoverage(part).length >= 2 && normalizedMarkdown.includes(normalizeForCoverage(part)));
}

function uncoveredImportantFacts(markdown: string, facts: DocumentFact[], options: { maxItems?: number } = {}) {
  const important = facts.filter(fact => {
    const labelText = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
    if (isCommercialSensitiveFactText(`${labelText}${stringifyFactValue(fact.value)}`)) return false;
    return /项目名称|工程名称|项目编号|招标项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|计划工期|合同工期|质量标准|质量目标|危大|安全|资源|材料|机械|设备/u.test(labelText) || /\d/u.test(stringifyFactValue(fact.value));
  });
  const seen = new Set<string>();
  const missing: Array<{ fact: DocumentFact; label: string; value: string }> = [];
  for (const fact of important) {
    const value = significantFactValue(fact.value);
    if (!value) continue;
    const label = fact.fieldName || fact.key || fact.fieldId || '资料事实';
    const key = `${label}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (factValueAppears(markdown, value)) continue;
    missing.push({ fact, label, value });
    if (options.maxItems && missing.length >= options.maxItems) break;
  }
  return missing;
}

function factCoverageIssues(markdown: string, facts: DocumentFact[], options: { maxIssues?: number } = {}) {
  return uncoveredImportantFacts(markdown, facts, { maxItems: options.maxIssues }).map(item => ({ level: 'warning' as const, message: `已确认事实未在正文中落位：${item.label}=${item.value}`, suggestion: '请将该事实自然写入对应章节或小节，不得改变原始数值和单位。' }));
}

function factMatchesChapterText(fact: DocumentFact, chapter: DocumentDraftChapter) {
  const text = `${chapter.title} ${(chapter.sections || []).join(' ')} ${fact.key || ''} ${fact.fieldName || ''} ${fact.fieldId || ''}`;
  if (/概况|工程|项目|总体/u.test(chapter.title) && /项目|工程|招标人|建设单位|地点|规模|范围/u.test(text)) return true;
  if (/工期|进度/u.test(chapter.title) && /工期|进度|节点|开工|竣工/u.test(text)) return true;
  if (/质量/u.test(chapter.title) && /质量|验收|标准/u.test(text)) return true;
  if (/安全|文明|危大|风险/u.test(chapter.title) && /安全|文明|危大|风险/u.test(text)) return true;
  if (/人|材|机|资源|材料|机械|设备|劳动力/u.test(chapter.title) && /人|材|机|资源|材料|机械|设备|劳动力/u.test(text)) return true;
  return (chapter.sections || []).some(section => text.includes(section));
}

function appendMissingFactPatchesToChapters(chapters: DocumentDraftChapter[], facts: DocumentFact[], markdown: string) {
  const missing = uncoveredImportantFacts(markdown, facts, { maxItems: 18 });
  if (missing.length === 0) return { chapters, patchedCount: 0, missingCount: 0 };
  const nextChapters = chapters.map(chapter => ({ ...chapter }));
  let patchedCount = 0;
  for (const item of missing) {
    const target = nextChapters.find(chapter => factMatchesChapterText(item.fact, chapter)) || nextChapters[0];
    if (!target || factValueAppears(target.content, item.value)) continue;
    const sentence = `${item.label}按知识库已确认事实执行为${item.value}，项目部在施工组织、技术交底、过程检查和验收复核中保持该项事实口径一致，不擅自变更已确认的数值、单位和适用范围。`;
    target.content = `${target.content.trim()}\n\n${sentence}`;
    patchedCount += 1;
  }
  return { chapters: nextChapters.map(chapter => ({ ...chapter, sections: chapter.sections || [] })), patchedCount, missingCount: missing.length };
}

function searchWeightsForChapter(title: string) {
  if (/概况|项目|工程|地点|规模|工期|质量|估算/u.test(title)) return { keyword: 0.65, vector: 0.25, rewrite: 0.8, hybridBonus: 0.2 };
  if (/人|材|机|资源|材料|设备|机械|劳动力/u.test(title)) return { keyword: 0.55, vector: 0.35, rewrite: 0.75, hybridBonus: 0.18 };
  if (/危大|安全|文明|风险/u.test(title)) return { keyword: 0.5, vector: 0.4, rewrite: 0.8, hybridBonus: 0.2 };
  return { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 };
}

function processingTypeWeightForChapter(chapter: DocumentTemplateChapter, processingType?: string) {
  const text = `${chapter.title} ${(chapter.sections || []).join(' ')} ${chapter.requiredFacts.join(' ')}`;
  if (processingType === 'reference') return 0.55;
  if (processingType === 'table') return /清单|工程量|数量|材料|设备|资源|费用|造价|范围|统计|表/u.test(text) ? 1.45 : 0.95;
  if (processingType === 'rule') return /要求|规则|招标|评审|响应|质量|安全|验收|标准|工期|进度|风险|约束/u.test(text) ? 1.35 : 0.95;
  if (processingType === 'drawing') return /图纸|设计|布置|位置|平面|剖面|立面|空间|施工方法|做法/u.test(text) ? 1.35 : 0.85;
  if (processingType === 'specification') return /技术|规范|标准|参数|做法|质量|验收|施工方法/u.test(text) ? 1.3 : 1;
  return 1;
}

function chapterTextScore(chapter: DocumentTemplateChapter, item: Pick<DocumentEvidence, 'content' | 'sectionTitle' | 'filePath'>) {
  const text = `${item.sectionTitle || ''}\n${item.filePath}\n${item.content}`;
  const tokens = [...new Set([chapter.title, ...(chapter.sections || []), ...chapter.requiredFacts].flatMap(value => value.split(/[\s、，,。；;：:（）()《》【】\-/]+/u)).map(value => value.trim()).filter(value => value.length >= 2).slice(0, 36))];
  const hits = tokens.filter(token => text.includes(token)).length;
  return Math.min(1.8, hits * 0.16);
}

function optimizeChapterEvidence(chapter: DocumentTemplateChapter, evidence: DocumentEvidence[], options: { maxChars: number; maxItems?: number; preservePinned?: boolean }, diagnostics?: DocumentGenerationDiagnostics) {
  const scored = evidence.map(item => ({
    ...item,
    score: item.score * processingTypeWeightForChapter(chapter, item.processingType) + chapterTextScore(chapter, item),
  }));
  return selectEvidenceByBudget(scored, options, diagnostics);
}

function compactChapterQueries(chapter: DocumentTemplateChapter, queries: string[], chapterBasicQueries: string[]) {
  const sectionQuery = (chapter.sections || []).slice(0, 10).join(' ');
  const requiredFactQuery = chapter.requiredFacts.slice(0, 10).join(' ');
  const primary = `${chapter.title} ${sectionQuery} ${requiredFactQuery}`.trim();
  return [...new Set([primary, ...queries, ...chapterBasicQueries].filter(Boolean))];
}

function qualityFirstSearchQueryLimit(chapter: DocumentTemplateChapter, chapterBasicQueries: string[]) {
  const configured = Number(process.env.DOCUMENT_MAX_QUERIES_PER_CHAPTER);
  const base = Number.isFinite(configured) && configured > 0 ? configured : 4;
  const complexityBonus = (chapter.sections || []).length >= 6 || chapter.requiredFacts.length >= 8 ? 1 : 0;
  return Math.max(2, Math.min(9, Math.floor(base) + complexityBonus + Math.min(2, chapterBasicQueries.length)));
}

function qualityFirstEvidenceItemLimit(requestedEvidencePerChapter: number, chapter: DocumentTemplateChapter, deepRetrieval = false) {
  const complexityBonus = (chapter.sections || []).length >= 6 || chapter.requiredFacts.length >= 8 ? 4 : 0;
  const deepBonus = deepRetrieval ? 18 : 0;
  return Math.max(12, Math.min(deepRetrieval ? 58 : 26, requestedEvidencePerChapter + 10 + complexityBonus + deepBonus));
}

async function retrieveSectionEvidence(input: { manager: ReturnType<typeof getMultiProjectManager>; projectRoot: string; chapter: DocumentTemplateChapter; sectionTitle: string; scopedFilePaths: string[]; fileRoleByPath: Map<string, string>; fileProcessingByPath: Map<string, string>; signal?: AbortSignal }) {
  throwIfAborted(input.signal);
  if (input.scopedFilePaths.length === 0) return [];
  const query = `${input.chapter.title} ${input.sectionTitle}`.trim();
  const result = await input.manager.search(input.projectRoot, query, {
    scope: 'project',
    filters: { filePaths: input.scopedFilePaths },
    limit: 5,
    weights: searchWeightsForChapter(query),
    generationMode: false,
  });
  return selectEvidenceByBudget(result.results
    .filter(item => input.scopedFilePaths.includes(item.filePath))
    .map(item => ({
      chapterId: input.chapter.id,
      filePath: item.filePath,
      score: item.score + 1.2,
      content: item.content,
      roleId: input.fileRoleByPath.get(item.filePath),
      processingType: input.fileProcessingByPath.get(item.filePath),
      sectionTitle: item.sectionTitle,
      source: 'section-evidence',
    })), { maxItems: 5, maxChars: 9000, preservePinned: true });
}

async function retrieveMissingFactEvidence(input: { manager: ReturnType<typeof getMultiProjectManager>; projectRoot: string; chapter: DocumentTemplateChapter; needs: string[]; scopedFilePaths: string[]; fileRoleByPath: Map<string, string>; fileProcessingByPath: Map<string, string>; signal?: AbortSignal }) {
  const evidence: DocumentEvidence[] = [];
  for (const need of input.needs.slice(0, 8)) {
    throwIfAborted(input.signal);
    const query = `${input.chapter.title} ${need} ${(input.chapter.sections || []).join(' ')}`.trim();
    const result = await input.manager.search(input.projectRoot, query, {
      scope: 'project',
      filters: { filePaths: input.scopedFilePaths },
      limit: 6,
      weights: searchWeightsForChapter(`${input.chapter.title} ${need}`),
      generationMode: false,
    });
    evidence.push(...result.results
      .filter(item => input.scopedFilePaths.includes(item.filePath))
      .map(item => ({
        chapterId: input.chapter.id,
        filePath: item.filePath,
        score: item.score + 2,
        content: item.content,
        roleId: input.fileRoleByPath.get(item.filePath),
        processingType: input.fileProcessingByPath.get(item.filePath),
        sectionTitle: item.sectionTitle,
        source: 'required-fact-evidence',
      })));
  }
  return selectEvidenceByBudget(evidence, { maxItems: Math.max(6, input.needs.length * 3), maxChars: 18000, preservePinned: true });
}

function summarizeIssueList(prefix: string, filePaths: string[], limit = 12) {
  if (filePaths.length === 0) return [];
  const names = filePaths.slice(0, limit).map(filePath => path.basename(filePath));
  const suffix = filePaths.length > limit ? ` 等 ${filePaths.length} 个文件` : '';
  return [`${prefix}：${names.join('、')}${suffix}`];
}

function kbIndexHealth(project: EvidenceLimitProject, scopedFilePaths: string[]) {
  const scoped = new Set(scopedFilePaths.filter(Boolean));
  const files = project.listFiles?.() || [];
  const scopedRecords = files.filter(record => scoped.size === 0 || scoped.has(record.relativePath));
  const indexedPaths = new Set(scopedRecords.map(record => record.relativePath));
  const missingFiles = [...scoped].filter(filePath => !indexedPaths.has(filePath));
  const emptyFiles = scopedRecords.filter(record => Math.max(0, Math.ceil(Number(record.chunkCount) || 0)) === 0).map(record => record.relativePath);
  const errorFiles = scopedRecords.filter(record => record.status === 'error').map(record => record.relativePath);
  const pendingJobs = typeof project.countPendingIndexJobs === 'function' ? project.countPendingIndexJobs() : 0;
  const vectorStatus = typeof project.getVectorStatus === 'function' ? project.getVectorStatus() : undefined;
  const usableRecords = scopedRecords.filter(record => record.status !== 'error' && Math.max(0, Math.ceil(Number(record.chunkCount) || 0)) > 0);
  const usablePaths = usableRecords.map(record => record.relativePath);
  const usableChunkCount = usableRecords.reduce((sum, record) => sum + Math.max(0, Math.ceil(Number(record.chunkCount) || 0)), 0);
  const unavailableWarnings = [
    ...summarizeIssueList('部分绑定文件未完成索引，已自动跳过', missingFiles),
    ...summarizeIssueList('部分绑定文件没有可用切片，已自动跳过', emptyFiles),
    ...summarizeIssueList('部分绑定文件索引失败，已自动跳过', errorFiles),
  ];
  const blockingIssues = scoped.size > 0 && usableChunkCount === 0 ? ['所有绑定文件均无可用切片'] : [];
  const warnings = [
    ...unavailableWarnings,
    ...(pendingJobs > 0 ? [`仍有 ${pendingJobs} 个待索引任务，建议等待索引完成后生成`] : []),
    ...(vectorStatus && vectorStatus.status !== 'ready' ? [`向量索引状态为 ${vectorStatus.status}，当前召回质量可能下降`] : []),
  ];
  return { scopedRecords, usablePaths, missingFiles, emptyFiles, errorFiles, pendingJobs, vectorStatus, usableChunkCount, blockingIssues, warnings };
}

type EvidenceLimitProject = {
  listFiles?: () => Array<{ relativePath: string; chunkCount?: number; status?: string }>;
  countPendingIndexJobs?: () => number;
  getVectorStatus?: () => { status: string; error?: string; indexedChunks: number; lastIndexedAt: number; backend: string };
};

function slowMetricSummary(metrics: DocumentGenerationDiagnostics['metrics']) {
  return [...metrics]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map(metric => `${metric.name} ${Math.round(metric.durationMs / 1000)}秒`)
    .join('，');
}

export function resolveDocumentGenerationEvidenceLimit(project: EvidenceLimitProject, scopedFilePaths: string[], requestedLimit?: number): number {
  if (Number.isFinite(requestedLimit) && requestedLimit! > 0) return Math.ceil(requestedLimit!);
  const scoped = new Set(scopedFilePaths.filter(Boolean));
  const chunkCount = project.listFiles?.()
    .filter(record => scoped.size === 0 || scoped.has(record.relativePath))
    .reduce((sum, record) => sum + Math.max(0, Math.ceil(Number(record.chunkCount) || 0)), 0) ?? 0;
  if (chunkCount > 0) return chunkCount;
  return Math.max(1, scoped.size);
}

/** 文档生成主入口：依次执行角色绑定、知识检索、文件理解、事实抽取、章节生成、封面生成、LLM 审查和导出校验，返回完整文档草稿 */
export async function generateDocumentDraft(input: { templateId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; resumeChapters?: DocumentDraftChapter[]; signal?: AbortSignal; onProgress?: (stages: DocumentExecutionStage[], checkpoint?: { chapters?: DocumentDraftChapter[] }) => void }): Promise<GeneratedDocumentDraft> {
  throwIfAborted(input.signal);
  const baseTemplate = getDocumentTemplate(input.templateId);
  if (!baseTemplate) throw new Error('Document template not found');
  const projectRoot = path.resolve(input.projectRoot || getProjectRoot());
  if (!projectRoot) throw new Error('No knowledge base project found');
  const projectId = computeProjectId(projectRoot);
  let template = baseTemplate;
  const manager = getMultiProjectManager();
  let chapterDrafts: DocumentDraftChapter[] = [];
  let checkpointChapterOrderIds: string[] = [];
  const emitProgress = (checkpointChapters?: DocumentDraftChapter[], stages: DocumentExecutionStage[] = progressStages) => {
    const chapters = checkpointChapters ? [...checkpointChapters].sort((a, b) => {
      const ia = checkpointChapterOrderIds.indexOf(a.id);
      const ib = checkpointChapterOrderIds.indexOf(b.id);
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
    }) : undefined;
    input.onProgress?.([...stages], chapters ? { chapters } : undefined);
  };
  const heartbeatMs = Math.max(15_000, Math.min(60_000, Number(process.env.DOCUMENT_GENERATION_HEARTBEAT_MS ?? 30_000)));
  const withProgressHeartbeat = async <T>(work: () => Promise<T>, stages: DocumentExecutionStage[] = progressStages): Promise<T> => {
    const timer = setInterval(() => {
      if (!input.signal?.aborted) emitProgress(chapterDrafts, stages);
    }, heartbeatMs);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  };
  const projectRoleConfigId = defaultProjectRoleConfigIdForTemplate(template) || 'none';
  const projectRoleConfigName = getProjectRoleConfig(projectRoleConfigId)?.name || projectRoleConfigId;
  const progressStages: DocumentExecutionStage[] = [displayStage({
    type: 'role_binding',
    roleId: projectRoleConfigId,
    status: 'running',
    message: `生成任务已创建，正在读取模板与角色配置：${template.name}`,
    details: [`当前项目：${projectId}`, `资料目录：${path.join(projectRoot, 'knowledgeBase')}`, '正在读取文件角色和提示词角色绑定'],
    progress: { current: 1, total: 4, label: '初始化配置' },
  }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName, order: 0 })];
  emitProgress();
  const promptPlan = buildPromptBindingPlan(template);
  const promptBindings = promptPlan.bindings;
  const explicitFileBindings = templateFileBindings(template);
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'running',
    message: '正在分析模板规范、用户要求与绑定材料摘要',
    details: ['解析 OUTLINE 与模板章节', '读取绑定文件清单', '评估材料覆盖率与生成准备度'],
    progress: { current: 1, total: 3, label: '准备分析' },
  }, { subtitle: '生成准备', order: progressStages.length }));
  emitProgress();
  if (explicitFileBindings.length === 0) throw new Error('模板未绑定知识库文件。模板生成文件只允许使用显式绑定的知识库文件，请先在模板中绑定需要参与生成的资料。');
  const promptOutlineTexts = promptTextsForResolvedPrompts([...promptPlan.writerPrompts, ...promptPlan.chapterPrompts]);
  const explicitPromptChapters = extractExplicitOutlineFromSources([
    { text: input.requirement, source: '用户需求', strict: true },
    { text: promptOutlineTexts, source: '提示词角色', strict: true },
  ]);
  const hasExplicitOutline = explicitPromptChapters.length >= 2;
  if (hasExplicitOutline) {
    template = { ...baseTemplate, chapters: explicitPromptChapters };
  }
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'running',
    message: `正在扫描 ${explicitFileBindings.length} 个绑定材料并生成摘要`,
    details: ['读取材料清单', '统计基础事实与材料角色覆盖', '准备后台控制提示词'],
    progress: { current: 2, total: 5, label: '资料摘要' },
  }, { subtitle: '生成准备', order: progressStages.length }));
  emitProgress();
  const fileBindings = expandDirectoryFileBindings(projectRoot, explicitFileBindings);
  if (fileBindings.length === 0) throw new Error('模板绑定的知识库文件或文件夹不存在，请重新选择项目文件绑定。');
  const projectMaterialSummary = await withProgressHeartbeat(() => Promise.resolve(buildProjectMaterialSummary(projectRoot, { requirement: input.requirement, boundFilePaths: fileBindings.map(binding => binding.filePath), boundFileRoles: boundFileRolesForMaterialSummary(fileBindings) })));
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'running',
    message: '正在生成自动文档规格并评估生成准备度',
    details: [`资料覆盖率线索：${Object.keys(projectMaterialSummary.materialInventory).length} 类角色`, '评估必需资料角色', '生成事实字段与章节约束'],
    progress: { current: 3, total: 5, label: '规格评估' },
  }, { subtitle: '生成准备', order: progressStages.length }));
  emitProgress();
  const autoSpec = await withProgressHeartbeat(() => Promise.resolve(getOrCreateAutoDocumentSpec(template, input.requirement || '')));
  const documentSpec = autoSpec.spec;
  const domainProfile = resolveDocumentDomainProfile(template, input.requirement || '');
  const resolvedMaterialRoles = resolveTemplateMaterialRoles(template, projectMaterialSummary);
  const readiness = evaluateDocumentReadiness({ template, spec: documentSpec, summary: projectMaterialSummary, resolvedRoles: resolvedMaterialRoles });
  if (!readiness.ready) throw new Error(`生成准备度不足：${readiness.blockingIssues.join('；')}`);
  const generationControlPrompt = [projectMaterialPrompt(projectMaterialSummary, { publicSafe: true }), autoSpecPrompt(documentSpec, autoSpec.sourceHash, { publicSafe: true }), readinessPrompt(readiness, { publicSafe: true })].filter(Boolean).join('\n\n');
  const diagnosticControlPrompt = [projectMaterialPrompt(projectMaterialSummary), autoSpecPrompt(documentSpec, autoSpec.sourceHash), readinessPrompt(readiness)].filter(Boolean).join('\n\n');
  const writingPromptTexts = promptTextsForResolvedPrompts([...promptPlan.writerPrompts, ...promptPlan.formattingPrompts]);
  const generalChapterPromptTexts = promptTextsForResolvedPrompts([...promptPlan.writerPrompts, ...promptPlan.chapterPrompts, ...promptPlan.formattingPrompts]);
  const sourcePromptTexts = promptTextsForResolvedPrompts(promptPlan.prompts);
  const webAccessConfig = ((getConfigStore() as unknown as { load: () => { webAccess?: WebAccessConfig } }).load().webAccess || { enabled: false, allowProjectFacts: false, maxQueriesPerChapter: 2, maxResultsPerQuery: 3, trustedDomains: [] });
  const runtimePromptRules = buildRuntimePromptRules({ promptTexts: [generationControlPrompt, sourcePromptTexts].filter(Boolean).join('\n\n'), requirement: input.requirement, template, rolePrompts: promptPlan.prompts });
  const runtimeRulesText = [runtimePromptRulesPrompt(runtimePromptRules), webAccessPrompt(webAccessConfig.enabled)].filter(Boolean).join('\n\n');
  const promptTexts = [generationControlPrompt, runtimeRulesText, `生成前规划章节结构：\n${plannedStructurePrompt(template)}`, writingPromptTexts || generalChapterPromptTexts].filter(Boolean).join('\n\n');
  const promptDocumentRules = runtimePromptRules;
  const factExtractionPromptTexts = [diagnosticControlPrompt, runtimeRulesText, promptTextsForResolvedPrompts([...promptPlan.extractionPrompts, ...promptPlan.referencePrompts])].filter(Boolean).join('\n\n');
  const reviewPromptTexts = [generationControlPrompt, runtimeRulesText, promptTextsForResolvedPrompts([...promptPlan.writerPrompts, ...promptPlan.chapterPrompts, ...promptPlan.formattingPrompts])].filter(Boolean).join('\n\n');
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-preparation',
    status: 'success',
    message: `模板规范与资料摘要分析完成，识别 ${fileBindings.length} 条文件角色绑定`,
    details: [`提示词角色：${promptBindings.length} 个`, `文件角色：${fileBindings.length} 个`, hasExplicitOutline ? `识别 OUTLINE 章节：${explicitPromptChapters.length} 个` : '未识别显式 OUTLINE，使用模板章节'],
    progress: { current: 3, total: 3, label: '准备完成' },
  }, { subtitle: '生成准备', order: progressStages.length }));
  emitProgress();
  const evidenceScopePaths = buildBoundEvidenceScope(projectRoot, fileBindings);
  const allFileRoles = listDocumentRoles('file');
  const fileRoleByPath = new Map(fileBindings.flatMap(binding => fileScopeKeys(projectRoot, binding.filePath).map(key => [key, binding.roleId] as const)));
  const fileProcessingByPath = new Map(fileBindings.flatMap(binding => fileScopeKeys(projectRoot, binding.filePath).map(key => [key, allFileRoles.find(role => role.id === binding.roleId)?.processingType || 'reference'] as const)));
  upsertProgressStage(progressStages, displayStage({
    type: 'knowledge_retrieval',
    roleId: 'knowledge-index',
    status: 'running',
    message: '正在读取已入库的模板绑定资料',
    details: ['使用上传阶段已完成的解析、切片和索引结果', '不在生成流程中重新解析或入库', '准备章节证据检索范围'],
    progress: { current: 1, total: 3, label: '读取索引' },
  }, { subtitle: '知识库检索', order: progressStages.length }));
  emitProgress();
  const project = await withProgressHeartbeat(() => manager.getProject(projectRoot));
  const indexHealth = kbIndexHealth(project, [...evidenceScopePaths]);
  if (indexHealth.blockingIssues.length > 0) throw new Error(`生成前知识索引不可用：${indexHealth.blockingIssues.join('；')}`);
  const availableEvidenceScopePaths = new Set(indexHealth.usablePaths.flatMap(filePath => fileScopeKeys(projectRoot, filePath)));
  const requestedEvidencePerChapter = resolveDocumentGenerationEvidenceLimit(project, [...availableEvidenceScopePaths], input.maxEvidencePerChapter);
  upsertProgressStage(progressStages, displayStage({
    type: 'knowledge_retrieval',
    roleId: 'knowledge-index',
    status: indexHealth.warnings.length > 0 ? 'fallback' : 'success',
    message: `已读取知识索引：绑定文件 ${indexHealth.scopedRecords.length} 份，可用切片 ${indexHealth.usableChunkCount} 条，开始构建角色资料证据池`,
    details: [`绑定文件：${evidenceScopePaths.size} 份`, `可用证据文件：${availableEvidenceScopePaths.size} 份`, `向量状态：${indexHealth.vectorStatus?.status || 'unknown'}`, ...indexHealth.warnings, '即将按角色读取资料片段'],
    progress: { current: 3, total: 3, label: '索引已就绪' },
  }, { subtitle: '知识库检索', order: progressStages.length }));
  emitProgress();
  throwIfAborted(input.signal);
  const allEvidence: DocumentEvidence[] = [];
  const retrievalCoverageReports: RetrievalCoverageReport[] = [];
  const webResearchReport = { enabled: webAccessConfig.enabled, queries: [] as string[], evidenceCount: 0, filteredCount: 0, chapters: [] as string[] };
  const missingItems: string[] = [];
  const failedChapterMessages: string[] = [];
  const chapterGenerationStages: DocumentExecutionStage[] = [];
  const chapterDraftsByOrder: Array<DocumentDraftChapter | undefined> = [];
  const chapterGenerationStagesByOrder: Array<DocumentExecutionStage | undefined> = [];
  let knowledgeBaseStageIndex = -1;
  const roleNodes = buildRoleExecutionNodes(template, promptBindings, fileBindings);
  const rolePoolEvidenceBudget = evidencePromptBudgetForTarget(Math.max(1200, explicitFileBindings.length * 900), 12000, 0);
  const roleEvidencePool = buildRoleEvidencePool(project, roleNodes, projectRoot, rolePoolEvidenceBudget);
  const rolePoolRisk = retrievalCoverageRisk({ totalChunks: roleEvidencePool.totalChunkCount, loadedChunks: roleEvidencePool.loadedChunkCount });
  const rolePoolStage = displayStage({
    type: 'file_understanding',
    roleId: 'role-evidence-pool',
    status: 'success',
    message: `已构建共享资料证据池：唯一文件 ${roleEvidencePool.uniqueFileCount} 份，角色绑定 ${roleEvidencePool.bindingCount} 条，加载片段 ${roleEvidencePool.loadedChunkCount}/${roleEvidencePool.totalChunkCount}`,
    details: [`复用绑定：${Math.max(0, roleEvidencePool.bindingCount - roleEvidencePool.uniqueFileCount)} 条`, `待执行资料理解节点：${roleNodes.length} 个`, roleEvidencePool.omittedChunkCount > 0 ? `按模型上下文预算延后加载片段：${roleEvidencePool.omittedChunkCount} 条` : '材料片段已全部纳入共享池'],
    progress: { current: roleEvidencePool.uniqueFileCount, total: Math.max(1, roleEvidencePool.bindingCount), label: '资料池' },
  }, { subtitle: '共享资料池', order: progressStages.length });
  upsertProgressStage(progressStages, rolePoolStage);
  emitProgress();
  const projectBasicEvidence = await collectProjectBasicEvidence({ manager, project, projectRoot, scopedFilePaths: [...evidenceScopePaths].filter(Boolean).sort(), fileRoleByPath, fileProcessingByPath, signal: input.signal });
  if (projectBasicEvidence.length > 0) {
    allEvidence.push(...projectBasicEvidence);
    upsertProgressStage(progressStages, displayStage({ type: 'knowledge_retrieval', roleId: 'project-basic-evidence', status: 'success', message: `已锁定项目基础事实证据 ${projectBasicEvidence.length} 条`, details: projectBasicEvidence.slice(0, 8).map(item => `${path.basename(item.filePath)}｜${item.sectionTitle || '正文片段'}｜score=${item.score.toFixed(2)}`) }, { subtitle: '基础事实召回', order: progressStages.length }));
    emitProgress();
  }
  const roleArtifacts: RoleNodeArtifact[] = [];
  const projectEvidenceVersion = projectEvidenceVersionHash(project, projectRoot, evidenceScopePaths);
  const activeModelName = getActiveModelWithProvider()?.model.name;
  const roleCachePromptTexts = promptTextsForResolvedPrompts([...promptPlan.extractionPrompts, ...promptPlan.referencePrompts]);
  const fileRolesHash = stableHash({
    fileBindings,
    evidenceScopePaths: [...evidenceScopePaths].sort(),
    activeModelName,
    projectEvidenceVersion,
    promptTexts: roleCachePromptTexts,
    materialFingerprint: projectMaterialSummary.fingerprint,
    materialInventory: Object.fromEntries(Object.entries(projectMaterialSummary.materialInventory).map(([role, files]) => [role, files.map(file => ({ filePath: file.filePath, chunkCount: file.chunkCount }))])),
  });
  const roleConcurrency = Math.max(1, roleNodes.length || 1);
  for (let offset = 0; offset < roleNodes.length; offset += roleConcurrency) {
    throwIfAborted(input.signal);
    const batch = roleNodes.slice(offset, offset + roleConcurrency);
    const batchJobs = batch.map(async (node, batchIndex) => {
      const nodeStartedAt = Date.now();
      const nodeEvidence = evidenceForRoleFiles(roleEvidencePool, node, projectRoot).filter(item => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths));
      const runningStageIndex = progressStages.length;
      const runningStage = displayStage({
        type: 'file_understanding',
        roleId: node.fileRoleId,
        promptId: node.promptRoleIds[0],
        status: 'running',
        message: `${node.fileRoleName} 正在复用共享资料池读取 ${node.filePaths.length} 条绑定，候选证据 ${nodeEvidence.length} 条`,
        details: [`绑定文件：${node.filePaths.length} 份`, `候选证据：${nodeEvidence.length} 条`, node.promptRoleNames.length ? `关联提示词：${node.promptRoleNames.join('、')}` : '未绑定专用提示词'],
        progress: { current: offset + batchIndex + 1, total: roleNodes.length, label: '资料理解' },
      }, { subtitle: node.fileRoleName, roleName: node.fileRoleName, promptName: node.promptRoleNames.join('、') || undefined, order: runningStageIndex });
      progressStages.push(runningStage);
      emitProgress();
      const artifact = await withProgressHeartbeat(() => executeRoleExtractionNode(template, node, nodeEvidence, input.signal));
      const completedStage = displayStage({
        type: 'file_understanding',
        roleId: node.fileRoleId,
        promptId: node.promptRoleIds[0],
        status: nodeEvidence.length > 0 ? 'success' : 'fallback',
        message: elapsedMessage(`${node.fileRoleName} 节点已完成，产出章节建议 ${artifact.chapters.length} 个、事实 ${artifact.facts.length} 条`, nodeStartedAt),
        details: [`产出章节建议：${artifact.chapters.length} 个`, `提取事实：${artifact.facts.length} 条`, '已完成模型理解'],
        progress: { current: offset + batchIndex + 1, total: roleNodes.length, label: '资料理解' },
      }, { subtitle: node.fileRoleName, roleName: node.fileRoleName, promptName: node.promptRoleNames.join('、') || undefined, order: runningStageIndex });
      progressStages[runningStageIndex] = completedStage;
      emitProgress();
      return { artifact, evidence: nodeEvidence };
    });
    const batchResults = await Promise.all(batchJobs);
    for (const item of batchResults) {
      allEvidence.push(...item.evidence);
      roleArtifacts.push(item.artifact);
    }
    const compactRoleEvidence = selectEvidenceByBudget(allEvidence, { maxItems: Math.max(40, roleNodes.length * 8), maxChars: Math.max(45000, roleNodes.length * 5000), preservePinned: true });
    allEvidence.splice(0, allEvidence.length, ...compactRoleEvidence);
  }
  const earlyLocalFacts = extractStructuredFacts(allEvidence, template, documentSpec);
  const earlyProjectBasicFacts = extractProjectBasicFactsFromEvidence(allEvidence);
  const earlyPreciseFacts = extractPreciseFactsFromEvidence(allEvidence, domainProfile);
  const earlyRoleFacts: DocumentFact[] = roleArtifacts.flatMap(artifact => artifact.facts.map(fact => ({ key: fact.key, value: stringifyFactValue(fact.value), sourceFile: fact.sourceFile, roleId: fact.roleId, confidence: 0.9 })));
  const preliminaryFactsModel = buildFactsModel([...earlyRoleFacts, ...earlyLocalFacts, ...earlyProjectBasicFacts, ...earlyPreciseFacts], extractStructuredTables(allEvidence), missingItems, documentSpec, domainProfile);
  const tenderPlan = tenderPlanChaptersFromArtifacts(template, roleArtifacts);
  let effectiveChapters = effectiveTemplateChapters(template, documentSpec, { preserveExplicitOutline: hasExplicitOutline });
  const baseProjectContext = roleArtifactsDigest(roleArtifacts);
  let projectContext = [baseProjectContext, buildDocumentBlueprintContext({ template: { ...template, chapters: effectiveChapters }, chapters: effectiveChapters, factsModel: preliminaryFactsModel, requirement: input.requirement })].filter(Boolean).join('\n\n');
  const provisionalTemplate = { ...template, chapters: effectiveChapters };
  const promptStructuralRules = extractPromptStructuralRules([promptTexts, input.requirement || ''].filter(Boolean).join('\n\n'), effectiveChapters);
  const provisionalBudget = buildDocumentBudget({ requirement: input.requirement, promptTexts, template: provisionalTemplate, chapters: effectiveChapters, spec: documentSpec });
  let skippedSectionPlanningCount = 0;
  let llmSectionPlanningCount = 0;
  const plannedChapters = await Promise.all(effectiveChapters.map(async (chapter, chapterIndex) => {
    if (chapter.sections?.length) {
      skippedSectionPlanningCount += 1;
      const lockedSections = promptStructuralRules.filter(rule => rule.chapterIndex === chapterIndex || (rule.chapterTitle && displayChapterTitle(rule.chapterTitle) === displayChapterTitle(chapter.title))).flatMap(rule => rule.requiredSections.sort((a, b) => (a.order || 0) - (b.order || 0)).map(section => section.title));
      const mergedSections = normalizePlannedSections([...lockedSections, ...chapter.sections], chapter.title);
      return { ...chapter, sections: mergedSections.length ? mergedSections : normalizePlannedSections(chapter.sections, chapter.title) };
    }
    llmSectionPlanningCount += 1;
    const chapterEvidence = selectEvidenceByBudget(allEvidence.filter(item => item.chapterId === chapter.id || evidenceMatchesFact(item, chapter.title)), { maxChars: evidencePromptBudgetForTarget(provisionalBudget.chapterTargets.get(chapter.id) || 1200), preservePinned: true });
    const roleContext = buildRoleChapterContext(roleArtifacts, chapter, chapterPlanFor(chapter, tenderPlan));
    const planningPromptExecution = resolveChapterPromptExecution(promptPlan, chapter);
    const sections = await planChapterSectionsWithLlm({ template: provisionalTemplate, chapter, chapterIndex, evidence: chapterEvidence, promptTexts: planningPromptExecution.promptTexts, projectContext, requirement: input.requirement, roleContext, targetWords: provisionalBudget.chapterTargets.get(chapter.id) || 1200, structuralRules: promptStructuralRules, signal: input.signal });
    const lockedRuleDetails = promptStructuralRules.filter(rule => rule.chapterIndex === chapterIndex || (rule.chapterTitle && displayChapterTitle(rule.chapterTitle) === displayChapterTitle(chapter.title))).flatMap(rule => rule.requiredSections.map(section => `强制小节：${section.title}`));
    upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'section-planning', promptId: planningPromptExecution.primaryPromptId, status: sections.length ? 'success' : 'fallback', message: `${displayChapterTitle(chapter.title)} 小节规划${sections.length ? `生成 ${sections.length} 个小节` : '未生成可用小节'}`, details: [...planningPromptExecution.promptDetails, ...lockedRuleDetails, ...(sections.length ? sections.map(section => `规划小节：${section}`) : ['规划结果为空或被污染过滤'])] }, { subtitle: '小节规划' }));
    return sections.length ? { ...chapter, sections } : chapter;
  }));
  effectiveChapters = plannedChapters;
  template = { ...template, chapters: effectiveChapters };
  const documentBlueprintContext = buildDocumentBlueprintContext({ template, chapters: effectiveChapters, factsModel: preliminaryFactsModel, requirement: input.requirement });
  projectContext = [baseProjectContext, documentBlueprintContext].filter(Boolean).join('\n\n');
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-blueprint', status: 'success', message: '已生成全局事实主表与文档蓝图，后续章节和小节将共用同一套专业约束', details: documentBlueprintContext.split('\n').slice(0, 12) }, { subtitle: '全局蓝图' }));
  const documentBudget = buildDocumentBudget({ requirement: input.requirement, promptTexts, template, chapters: effectiveChapters, spec: documentSpec });
  checkpointChapterOrderIds = effectiveChapters.map(chapter => chapter.id);
  const generationStrategy = selectDocumentGenerationStrategy({ template, targetWords: documentBudget.targetChars || [...documentBudget.chapterTargets.values()].reduce((sum, value) => sum + value, 0), requirement: input.requirement });
  const generationDiagnostics = createGenerationDiagnostics(generationStrategy);
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-strategy', status: 'success', message: `已自动选择 ${generationStrategy.mode} 生成策略：章节审查 ${generationStrategy.enableChapterReview ? '启用' : '跳过'}、全局审查 ${generationStrategy.enableGlobalReview ? '启用' : '跳过'}、最终质量审查 ${generationStrategy.enableFinalQualityReview ? '启用' : '跳过'}、全文扩写 ${generationStrategy.enableDocumentBudgetExpansion ? '启用' : '跳过'}；LLM 调用按工作流任务自然并行` }, { subtitle: '后台自动策略' }));
  const sectionPlanningSource = hasExplicitOutline ? 'OUTLINE 章节' : '模板章节';
  const sectionPlanningStage: DocumentExecutionStage = displayStage({
    type: 'validation',
    roleId: 'section-planning',
    status: 'success',
    message: `小节规划：${llmSectionPlanningCount} 章由 LLM 基于${sectionPlanningSource}、角色和绑定文件证据规划小节，${skippedSectionPlanningCount} 章已由模板显式提供小节并跳过规划`,
  }, { subtitle: '小节规划策略' });

  // 第一个进度回调：角色绑定完成
  const outlineMessage = hasExplicitOutline ? `；识别到 OUTLINE 章节 ${explicitPromptChapters.length} 个` : '；未识别到有效 OUTLINE，将使用模板章节';
  const promptPlanDetails = [
    ...promptPlan.prompts.map(prompt => `${prompt.category}｜${prompt.roleId}｜${prompt.id}｜${prompt.name}｜${prompt.bindingSource}｜${prompt.content.length} 字符｜hash=${prompt.contentHash}｜${prompt.contentPreview}`),
    ...promptPlan.unresolvedRoles.map(roleId => `unresolved｜${roleId}｜项目角色配置中的提示词角色不存在`),
    ...promptPlan.missingResourceRoles.map(roleId => `missingResource｜${roleId}｜提示词角色未显式绑定资源`),
  ];
  upsertProgressStage(progressStages, displayStage({ type: 'role_binding', roleId: projectRoleConfigId, status: 'success', message: `已绑定 ${fileBindings.length} 个文件角色、${promptPlan.prompts.length} 个有效提示词；写作 ${promptPlan.writerPrompts.length}、章节 ${promptPlan.chapterPrompts.length}、抽取 ${promptPlan.extractionPrompts.length}；已自动抽取运行时规则 ${runtimePromptRules.executionSummary.length} 条；语义资料覆盖 ${Math.round(readiness.materialCoverageRate * 100)}%${outlineMessage}`, details: [...promptPlanDetails, ...runtimePromptRules.executionSummary.map(item => `runtimeRule｜${item}`)] }, { subtitle: projectRoleConfigName, roleName: projectRoleConfigName }));
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'runtime-prompt-rules', status: 'success', message: `运行时提示词规则已抽取：${runtimePromptRules.executionSummary.length} 条，版本 ${runtimePromptRules.sourceHash}`, details: runtimePromptRules.executionSummary.length ? [...runtimePromptRules.executionSummary, `必需表格：${runtimePromptRules.requiredTables.join('、') || '无'}`, `必含关键词：${runtimePromptRules.requiredKeywords?.join('、') || '无'}`, `禁含内容：${runtimePromptRules.forbiddenPatterns?.join('、') || '无'}`] : ['未从提示词中识别到额外硬规则，使用系统默认质量规则'] }, { subtitle: '提示词规则执行' }));
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'document-readiness', status: readiness.ready ? 'success' : 'failed', message: `生成准备度：绑定资料已就绪，语义覆盖 ${Math.round(readiness.materialCoverageRate * 100)}%，角色匹配 ${Math.round(readiness.roleSatisfactionRate * 100)}%，优化建议 ${Math.round(readiness.specCompletenessRate * 100)}%`, details: readiness.diagnostics }, { subtitle: '生成准备度检查' }));
  upsertProgressStage(progressStages, sectionPlanningStage);
  emitProgress();

  const chapterConcurrency = Math.max(1, effectiveChapters.length || 1);
  upsertProgressStage(progressStages, displayStage({ type: 'validation', roleId: 'chapter-concurrency', status: 'success', message: `章节并发调度：本轮 ${chapterConcurrency}/${effectiveChapters.length} 章自然并行`, details: [`有效章节数：${effectiveChapters.length}`] }, { subtitle: '章节并发策略' }));
  emitProgress();
  for (let chapterOffset = 0; chapterOffset < effectiveChapters.length; chapterOffset += chapterConcurrency) {
    const chapterBatch = effectiveChapters.slice(chapterOffset, chapterOffset + chapterConcurrency);
    await Promise.all(chapterBatch.map(async (chapter, batchIndex) => {
    const chapterOrder = chapterOffset + batchIndex;
    throwIfAborted(input.signal);
    const chapterStartedAt = Date.now();
    const chapterProgressIndex = progressStages.length;
    let latestChapterStageForProgress: DocumentExecutionStage | undefined;
    try {
    progressStages.push(displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptPlan.writerPrompts[0]?.id,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在检索证据并准备章节内容`,
      details: [`章节序号：${chapterOrder + 1}/${effectiveChapters.length}`, `二级小节：${chapter.sections?.length || 0} 个`, '正在生成检索查询'],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节生成' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder }));
    emitProgress();
    const rawEvidence: DocumentEvidence[] = [];
    const plan = chapterPlanFor(chapter, tenderPlan);
    const planQueries = plan ? [plan.title, ...plan.requiredContents, ...plan.evidenceNeeds, ...plan.requirements.flatMap(item => [item.title, item.requirementText, ...item.requiredContents, ...item.evidenceNeeds])].filter(Boolean) : [];
    const baseQueries = chapter.queries.length > 0 ? chapter.queries : [template.name, template.outputTitle, chapter.title];
    const chapterBasicQueries = /概况|工程|项目|总体|部署|进度|工期|质量/u.test(chapter.title) ? PROJECT_BASIC_FACT_QUERIES : [];
    const queries = compactChapterQueries(chapter, [...baseQueries, ...planQueries], chapterBasicQueries);
    const maxSearchQueries = qualityFirstSearchQueryLimit(chapter, chapterBasicQueries);
    const searchStartedAt = Date.now();
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptPlan.writerPrompts[0]?.id,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在执行质量优先的章节检索`,
      details: queries.slice(0, maxSearchQueries).map(query => `检索：${query.slice(0, 42)}`),
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '证据检索' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    const scopedFilePaths = [...availableEvidenceScopePaths].filter(Boolean).sort();
    const searchResults: KbSearchResult[][] = [];
    for (const query of queries.slice(0, maxSearchQueries)) {
      throwIfAborted(input.signal);
      if (scopedFilePaths.length === 0) break;
      const result = await manager.search(projectRoot, query, {
        scope: 'project',
        filters: { filePaths: scopedFilePaths },
        limit: Math.min(requestedEvidencePerChapter, 12),
        weights: searchWeightsForChapter(chapter.title),
        generationMode: false,
      });
      searchResults.push(result.results);
    }
    generationDiagnostics.evidence.searchQueries += Math.min(queries.length, maxSearchQueries);
    generationDiagnostics.evidence.searchMs += Date.now() - searchStartedAt;
    for (const results of searchResults) {
      rawEvidence.push(...results
        .filter((item: KbSearchResult) => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths))
        .map((item: KbSearchResult) => ({
          chapterId: chapter.id,
          filePath: item.filePath,
          score: item.score,
          content: item.content,
          roleId: fileRoleByPath.get(item.filePath),
          processingType: fileProcessingByPath.get(item.filePath),
          sectionTitle: item.sectionTitle,
          source: item.source,
        })));
    }
    const pinnedEvidencePaths = new Set<string>((chapter.pinnedEvidenceFilePaths || []).filter(Boolean));
    const matchedRoleContexts = roleFactsForChapter(roleArtifacts, chapter, plan);
    rawEvidence.push(...matchedRoleContexts.flatMap(({ artifact }) => artifact.evidence
      .filter(item => evidenceInScope(projectRoot, item.filePath, evidenceScopePaths))
      .map(item => ({ ...item, chapterId: chapter.id, source: 'role-node' }))));
    if (/概况|工程|项目|总体|部署|进度|工期|质量/u.test(chapter.title)) rawEvidence.push(...projectBasicEvidence.map(item => ({ ...item, chapterId: chapter.id, source: 'pinned-evidence' })));
    const chapterPinnedPaths = new Set([...pinnedEvidencePaths]);
    const chapterBudgetTarget = documentBudget.chapterTargets.get(chapter.id) || 1200;
    const pinnedEvidenceBudget = evidencePromptBudgetForTarget(chapterBudgetTarget, 6000, 12000);
    for (const relativePath of chapterPinnedPaths) {
      if (!evidenceInScope(projectRoot, relativePath, evidenceScopePaths)) continue;
      const isPinnedEvidence = pinnedEvidencePaths.has(relativePath);
      const detail = (project as any).getFileDetail(relativePath, { maxChunkContentChars: pinnedEvidenceBudget });
      if (!detail) continue;
      rawEvidence.push(...(detail.chunks as Array<{ content: string; sectionTitle?: string }>).map(chunk => ({
        chapterId: chapter.id,
        filePath: detail.file.relativePath,
        score: 1,
        content: chunk.content,
        roleId: fileRoleByPath.get(detail.file.relativePath),
        processingType: fileProcessingByPath.get(detail.file.relativePath),
        sectionTitle: chunk.sectionTitle,
        source: isPinnedEvidence ? 'pinned-evidence' : 'bound-file',
      })));
    }
    let scopedEvidence = rawEvidence.filter(item => evidenceInScope(projectRoot, item.filePath, availableEvidenceScopePaths));
    if (webAccessConfig.enabled) {
      const webResult = await retrieveWebEvidence({ config: webAccessConfig, chapterId: chapter.id, chapterTitle: chapter.title, sectionTitles: chapter.sections || [], runtimeRules: runtimePromptRules, localFacts: [...preliminaryFactsModel.project, ...preliminaryFactsModel.schedule, ...preliminaryFactsModel.quality, ...preliminaryFactsModel.safety, ...preliminaryFactsModel.resources, ...preliminaryFactsModel.preciseFacts], signal: input.signal });
      if (webResult.evidence.length > 0) {
        scopedEvidence.push(...webResult.evidence);
        webResearchReport.chapters.push(chapter.title);
        webResearchReport.evidenceCount += webResult.evidence.length;
      }
      webResearchReport.queries.push(...webResult.queries);
      webResearchReport.filteredCount += webResult.filtered;
    }
    const evidenceBudgetChars = evidencePromptBudgetForTarget(chapterBudgetTarget, 7000, 26000);
    const sampledEvidence = sampleBoundFileEvidence({ project, chapter, scopedFilePaths, fileRoleByPath, fileProcessingByPath, highRisk: rolePoolRisk.highRisk });
    if (sampledEvidence.length > 0) scopedEvidence.push(...sampledEvidence);
    let evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter, chapter, rolePoolRisk.highRisk), maxChars: evidenceBudgetChars + (rolePoolRisk.highRisk ? 14000 : 4000), preservePinned: true }, generationDiagnostics);
    let missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
    let deepEvidenceCount = 0;
    if ((rolePoolRisk.highRisk || missingFacts.length > 0 || evidence.length < 8) && scopedFilePaths.length > 0) {
      const deepEvidence = await retrieveDeepChapterEvidence({ manager, projectRoot, chapter, scopedFilePaths, fileRoleByPath, fileProcessingByPath, requiredNeeds: missingFacts, highRisk: rolePoolRisk.highRisk, signal: input.signal });
      deepEvidenceCount = deepEvidence.length;
      if (deepEvidence.length > 0) {
        scopedEvidence = optimizeChapterEvidence(chapter, [...scopedEvidence, ...deepEvidence], { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 12, chapter, rolePoolRisk.highRisk), maxChars: evidenceBudgetChars + (rolePoolRisk.highRisk ? 36000 : 16000), preservePinned: true }, generationDiagnostics);
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 8, chapter, rolePoolRisk.highRisk), maxChars: evidenceBudgetChars + (rolePoolRisk.highRisk ? 28000 : 12000), preservePinned: true }, generationDiagnostics);
        missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
      }
    }
    if (evidence.length === 0) missingItems.push(`${chapter.title}：系统暂未检索到明确知识库依据`);
    for (const fact of missingFacts) missingItems.push(`${chapter.title}：${fact} 系统暂未从知识库确认`);
    // 证据检索完成 → 持续刷新证据数量
    const knowledgeBaseStage = displayStage({ type: 'knowledge_retrieval', roleId: 'knowledge-base', status: (allEvidence.length > 0 ? 'success' : 'fallback'), message: `已检索/绑定 ${allEvidence.length} 条证据` });
    if (knowledgeBaseStageIndex < 0) {
      knowledgeBaseStageIndex = upsertProgressStage(progressStages, knowledgeBaseStage);
    } else {
      progressStages[knowledgeBaseStageIndex] = { ...knowledgeBaseStage, order: progressStages[knowledgeBaseStageIndex]?.order ?? knowledgeBaseStage.order };
    }
    emitProgress();

    throwIfAborted(input.signal);
    const forbidDrawingImages = shouldForbidDrawingImages(roleArtifacts, template);
    const roleContext = buildRoleChapterContext(roleArtifacts, chapter, plan);
    const chapterPromptExecution = resolveChapterPromptExecution(promptPlan, chapter);
    if (promptPlan.writerPrompts.length > 0 && !chapterPromptExecution.primaryWriter) throw new Error(`${displayChapterTitle(chapter.title)} 写作主控提示词未进入章节生成阶段`);
    const chapterPromptTexts = [chapterPromptExecution.promptTexts, generationControlPrompt].filter(Boolean).join('\n\n');
    const chapterPromptDetails = chapterPromptExecution.promptDetails.length ? chapterPromptExecution.promptDetails : ['未绑定章节写作提示词'];
    const chapterFactNeeds = buildChapterFactNeeds({ template, chapter, spec: documentSpec, profile: domainProfile, promptTexts: chapterPromptTexts, requirement: input.requirement, plan });
    let resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: preliminaryFactsModel, evidence: scopedEvidence, profile: domainProfile });
    let requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
    if (requiredMissingNeeds.length > 0 && scopedFilePaths.length > 0) {
      const supplementalEvidence = await retrieveMissingFactEvidence({ manager, projectRoot, chapter, needs: requiredMissingNeeds, scopedFilePaths, fileRoleByPath, fileProcessingByPath, signal: input.signal });
      const deepNeedEvidence = await retrieveDeepChapterEvidence({ manager, projectRoot, chapter, scopedFilePaths, fileRoleByPath, fileProcessingByPath, requiredNeeds: requiredMissingNeeds, highRisk: true, signal: input.signal });
      const mergedSupplementalEvidence = [...supplementalEvidence, ...deepNeedEvidence];
      if (mergedSupplementalEvidence.length > 0) {
        scopedEvidence = optimizeChapterEvidence(chapter, [...scopedEvidence, ...mergedSupplementalEvidence], { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 16, chapter, true), maxChars: evidenceBudgetChars + 42000, preservePinned: true }, generationDiagnostics);
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter + 12, chapter, true), maxChars: evidenceBudgetChars + 32000, preservePinned: true }, generationDiagnostics);
        missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
        resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: preliminaryFactsModel, evidence: scopedEvidence, profile: domainProfile });
        requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
      }
    }
    const retrievalCoverageReport = buildRetrievalCoverageReport({ chapter, evidence, risk: rolePoolRisk });
    retrievalCoverageReports.push(retrievalCoverageReport);
    const chapterEvidenceFiles = new Set(evidence.map(item => item.filePath));
    const chapterEvidenceChars = evidence.reduce((sum, item) => sum + item.content.length, 0);
    const retrievalDetails = [
      ...(rolePoolRisk.highRisk ? [`延迟切片风险：已加载 ${rolePoolRisk.loadedChunks}/${rolePoolRisk.totalChunks}，已启用深召回`] : []),
      `深召回证据：${deepEvidenceCount} 条`,
      `事实覆盖：${retrievalCoverageReport.requiredFactCovered}/${retrievalCoverageReport.requiredFactTotal}`,
      `小节覆盖：${retrievalCoverageReport.sectionCovered}/${retrievalCoverageReport.sectionTotal}`,
    ];
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: promptPlan.writerPrompts[0]?.id,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 已选取 ${evidence.length} 条高相关证据，正在生成正文`,
      details: [`使用绑定文件：${chapterEvidenceFiles.size} 份`, `上下文字符：${chapterEvidenceChars}`, `检索查询：${Math.min(queries.length, maxSearchQueries)} 组`, ...retrievalDetails],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '正文生成' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    generationDiagnostics.evidence.contextChars += chapterEvidenceChars;
    const indexedFacts = factsForChapterNeeds(resolvedFactNeeds);
    const projectBasicFactsForChapter = /概况|工程|项目|总体|部署|进度|工期|质量/u.test(chapter.title) ? earlyProjectBasicFacts : [];
    const factCoverageContext = buildChapterFactCoverageContext({ chapter, plan, spec: documentSpec, roleFacts: matchedRoleContexts, evidence, missingFacts, indexedFacts: [...projectBasicFactsForChapter, ...indexedFacts], resolvedFactNeeds, factNeedsPrompt: factNeedsCoveragePrompt(resolvedFactNeeds) });
    const factNeedSummary = { total: resolvedFactNeeds.length, satisfied: resolvedFactNeeds.filter(item => item.status === 'satisfied').length, missing: resolvedFactNeeds.filter(item => item.status === 'missing').length, lowConfidence: resolvedFactNeeds.filter(item => item.status === 'low_confidence').length };
    for (const fact of requiredMissingNeeds) missingItems.push(`${chapter.title}：事实需求未确认 ${fact}`);
    const specChapterRule = documentSpec?.chapterRules.find(rule => rule.id === chapter.id || rule.title === chapter.title);
    const budgetTarget = documentBudget.chapterTargets.get(chapter.id) || 1200;
    const generationTargetCap = budgetTarget;
    const chapterMaxChars = Math.ceil(budgetTarget * (documentBudget.maxChars ? 1.1 : 1.18));
    const adaptiveMinimum = documentBudget.targetChars ? Math.min(1800, Math.max(600, Math.floor(generationTargetCap * 0.5))) : 1200;
    const targetWords = generationTargetCap;
    const budgetTargetWords = budgetTarget;
    const minWords = Math.max(Math.min(plan?.minWords || 0, targetWords), Math.min(specChapterRule?.minWords || 0, targetWords), Math.min(documentSpec?.dynamicChapterRule.minWordsPerChapter || 0, targetWords), Math.floor(targetWords * 0.78), adaptiveMinimum);
    const generationMaxTokens = outputTokensForChapter(minWords, targetWords);
    const fallbackRatio = 0.55;
    const fallbackCap = Math.min(targetWords, 6000);
    const fallbackTargetWords = Math.max(900, Math.min(targetWords, Math.ceil(targetWords * fallbackRatio), fallbackCap));
    const fallbackMinWords = Math.max(450, Math.min(minWords, Math.floor(fallbackTargetWords * 0.72)));
    const fallbackMaxWords = Math.max(fallbackTargetWords + 300, Math.min(chapterMaxChars, Math.ceil(fallbackTargetWords * 1.25)));
    const fallbackMaxTokens = outputTokensForChapter(fallbackMinWords, fallbackTargetWords);
    const fallbackTimeoutMs = Math.min(timeoutMsForChapter(fallbackTargetWords), 180000);
    const compactTargetWords = Math.max(900, Math.min(fallbackTargetWords, 3600));
    const compactMinWords = Math.max(450, Math.min(fallbackMinWords, Math.floor(compactTargetWords * 0.72)));
    const compactMaxWords = Math.max(compactTargetWords + 300, Math.min(chapterMaxChars, Math.ceil(compactTargetWords * 1.2)));
    const compactMaxTokens = outputTokensForChapter(compactMinWords, compactTargetWords);
    const compactTimeoutMs = Math.min(timeoutMsForChapter(compactTargetWords), 150000);
    const sectionCount = chapter.sections?.filter(Boolean).length || 0;
    const compositeChapterTitle = /[、，,；;]/u.test(chapter.title);
    const useSectionFirst = Number(process.env.DOCUMENT_SECTION_FIRST_GENERATION ?? 1) !== 0 && sectionCount >= 2 && (documentBudget.longformStrict || !compositeChapterTitle);
    progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: chapterPromptExecution.primaryPromptId,
      status: 'running',
      message: useSectionFirst ? `${displayChapterTitle(chapter.title)} 正在按小节并发成稿` : `${displayChapterTitle(chapter.title)} 正在整章一次成稿`,
      details: useSectionFirst
        ? [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, `首轮质量目标：约 ${targetWords} 字${budgetTargetWords !== targetWords ? `，总预算分配约 ${budgetTargetWords} 字` : ''}，上限约 ${chapterMaxChars} 字`, `规划小节：${chapter.sections?.length || 0} 个`, '按章节结构拆分小节自然并发生成，章节聚合后再审查修复']
        : [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, `目标字数：约 ${targetWords} 字，上限约 ${chapterMaxChars} 字`, '首次生成必须覆盖章节结构、小节、事实和目标篇幅，后置修复仅兜底'],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: useSectionFirst ? '小节并发' : '整章成稿' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    emitProgress();
    const sectionFirstTimeoutMs = useSectionFirst ? Math.min(timeoutMsForChapter(targetWords) + 30000, 330000) : Math.min(timeoutMsForChapter(targetWords), 180000);
    let llmContent = useSectionFirst
      ? await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-section-draft:${chapter.id}`, () => callWithTimeout(
        signal => buildSectionParallelChapterContent({ template, chapter, evidence, missingFacts, promptTexts: chapterPromptTexts, projectContext, requirement: input.requirement, roleContext, targetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, projectRoot, modelName: activeModelName, fileRolesHash, allowPartialResult: true, sectionEvidenceProvider: sectionTitle => retrieveSectionEvidence({ manager, projectRoot, chapter, sectionTitle, scopedFilePaths, fileRoleByPath, fileProcessingByPath, signal }), diagnostics: generationDiagnostics, signal }),
        sectionFirstTimeoutMs,
        input.signal,
      )))
      : await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, chapterPromptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords, targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext, signal }),
        timeoutMsForChapter(targetWords),
        input.signal,
      )));
    if (!llmContent && useSectionFirst) {
      progressStages[chapterProgressIndex] = displayStage({ type: 'chapter_generation', roleId: 'chapter_generation', promptId: chapterPromptExecution.primaryPromptId, status: 'failed', message: `${displayChapterTitle(chapter.title)} 小节并发未在限定时间内返回，已跳过整章重试并标记为章节阻断`, details: ['小节优先模式不再执行整章重试，避免单章长时间空等；请优先重试失败小节或降低目标篇幅。'], progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '小节超时' } }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      throw new Error(`${chapter.title} 小节并发超时，已跳过整章重试`);
    } else if (!llmContent) {
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 整章成稿未完整返回，正在执行整章重试生成`,
        details: [`目标字数：约 ${targetWords} 字`, `有效证据：${evidence.length} 条`],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '整章重试' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft-fallback:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, chapterPromptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords: fallbackMinWords, targetWords: fallbackTargetWords, maxWords: fallbackMaxWords, maxTokens: fallbackMaxTokens, factCoverageContext, signal }),
        fallbackTimeoutMs,
        input.signal,
      )));
    }
    throwIfAborted(input.signal);
    if (!llmContent) {
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 正在压缩上下文后重试生成`,
        details: ['已压缩证据与上下文后重新请求模型生成', `目标字数：约 ${targetWords} 字`],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '紧凑重试' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      llmContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-draft-compact-fallback:${chapter.id}`, () => callWithTimeout(
        signal => buildLlmChapterContent(template, chapter, evidence, missingFacts, chapterPromptTexts, projectContext, input.requirement, roleContext, { forbidDrawingImages, minWords: compactMinWords, targetWords: compactTargetWords, maxWords: compactMaxWords, maxTokens: compactMaxTokens, factCoverageContext, signal }),
        compactTimeoutMs,
        input.signal,
      )));
    }
    throwIfAborted(input.signal);
    if (!llmContent) throw new Error(`${chapter.title} 大模型未返回有效章节正文`);
    let chapterContent = llmContent;
    let chapterSectionGaps = criticalChapterSectionGaps(chapterContent, chapter);
    let sectionRepairRound = 0;
    let previousGapSignature = chapterSectionGaps.map(gap => `${gap.sectionTitle}:${gap.reason}:${gap.bodyLength}`).join('|');
    while (chapterSectionGaps.length > 0) {
      sectionRepairRound += 1;
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 存在 ${chapterSectionGaps.length} 个小节缺口，正在按目标缺口强制补写`,
        details: chapterSectionGaps.map(gap => gap.message),
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: `小节补写第 ${sectionRepairRound} 轮` },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      const contentBeforeSectionRepair = chapterContent;
      const repairedSectionContent = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-section-repair:${chapter.id}:${sectionRepairRound}`, () =>
        supplementShortSections({ template, chapter, content: contentBeforeSectionRepair, evidence, missingFacts, promptTexts: chapterPromptTexts, projectContext, requirement: input.requirement, roleContext, targetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, forcedSections: chapterSectionGaps, signal: input.signal })
      ));
      if (repairedSectionContent?.trim()) chapterContent = repairedSectionContent;
      chapterSectionGaps = criticalChapterSectionGaps(chapterContent, chapter);
      const currentGapSignature = chapterSectionGaps.map(gap => `${gap.sectionTitle}:${gap.reason}:${gap.bodyLength}`).join('|');
      const hasSectionProgress = currentGapSignature !== previousGapSignature;
      if (chapterSectionGaps.length === 0) break;
      if (!hasSectionProgress) break;
      previousGapSignature = currentGapSignature;
    }
    if (chapterSectionGaps.length > 0) {
      progressStages[chapterProgressIndex] = displayStage({ type: 'chapter_generation', roleId: 'chapter_generation', promptId: chapterPromptExecution.primaryPromptId, status: 'failed', message: `${displayChapterTitle(chapter.title)} 小节补齐仍未完全达标，已标记为阻断问题`, details: chapterSectionGaps.map(gap => gap.message), progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '小节未达标' } }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
    }
    const localIssues = lightweightChapterIssues({ chapter, content: chapterContent, missingFacts, targetWords });
    const localSeverity = qualitySeveritySummary(localIssues);
    generationDiagnostics.quality.blockingCount += localSeverity.blocking;
    generationDiagnostics.quality.importantCount += localSeverity.important;
    generationDiagnostics.quality.minorCount += localSeverity.minor;
    const blockingIssues = blockingChapterIssues(localIssues);
    if (blockingIssues.length > 0) {
      const contentBeforeRepair = chapterContent;
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 正在根据质量问题修复章节：${blockingIssues.length} 个阻断问题`,
        details: blockingIssues,
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节修复' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      const repairResult = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-repair:${chapter.id}`, () =>
        repairChapterByQuality({ template, chapter: { id: chapter.id, title: chapter.title, content: contentBeforeRepair, evidence, missingFacts: [...missingFacts, ...requiredMissingNeeds.map(item => `事实需求未确认：${item}`)], sections: chapter.sections || [] }, issues: blockingIssues, promptTexts: chapterPromptTexts, requirement: input.requirement, forbidDrawingImages, diagnostics: generationDiagnostics, signal: input.signal })
      ));
      chapterContent = repairResult.content;
      if (repairResult.appliedCount > 0) generationDiagnostics.quality.repairedCount += 1;
      throwIfAborted(input.signal);
    }
    if (!chapterContent.trim()) {
      throw new Error(`${displayChapterTitle(chapter.title)} 首次生成失败，未获得可用于定稿的正文`);
    }
    let content = chapterContent;
    let expandRounds = 0;
    const needsExpansion = documentTextLength(content) < Math.floor(targetWords * 0.82) || blockingChapterIssues(lightweightChapterIssues({ chapter, content, missingFacts, targetWords })).length > 0;
    if (needsExpansion) {
      progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 首次成稿未达定稿门槛，正在定向扩写`,
        details: [`当前 ${documentTextLength(content)} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字`, `章节并发：${chapterConcurrency}`],
        progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '章节扩写' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      const expandedChapter = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `chapter-expand:${chapter.id}`, () =>
        expandChapterToTarget({ template, chapter, content: chapterContent, evidence, promptTexts: chapterPromptTexts, requirement: input.requirement, roleContext, targetChars: Math.floor(targetWords * 0.95), maxChars: chapterMaxChars, forbidDrawingImages, maxTokens: Math.min(generationMaxTokens, fallbackMaxTokens), signal: input.signal })
      ));
      content = expandedChapter.content;
      expandRounds = expandedChapter.rounds;
    }
    content = finalizeChapterContentQuality(content, chapter);
    let postGenerationGaps = collectSectionContentGaps(content, [{ title: chapter.title, content, sections: chapter.sections || [] }]);
    reportGenerationDebugEvent(projectRoot, { event: 'section-repair-check', hypothesisId: 'H1', chapterId: chapter.id, chapterTitle: chapter.title, gapCount: postGenerationGaps.length, gaps: postGenerationGaps.slice(0, 10).map(gap => ({ title: gap.sectionTitle, reason: gap.reason, message: gap.message })), contentChars: documentTextLength(content), targetWords });
    if (postGenerationGaps.length > 0) {
      progressStages[chapterProgressIndex] = displayStage({ type: 'chapter_generation', roleId: 'chapter_generation', promptId: chapterPromptExecution.primaryPromptId, status: 'running', message: `${displayChapterTitle(chapter.title)} 正在小节级定向补写 ${postGenerationGaps.length} 个未达标小节`, details: postGenerationGaps.slice(0, 8).map(gap => gap.message), progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: '小节补写' } }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      emitProgress(chapterDrafts);
      content = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, `section-repair:${chapter.id}`, () => supplementShortSections({ template, chapter, content, evidence, missingFacts, promptTexts: chapterPromptTexts, projectContext, requirement: input.requirement, roleContext, targetWords: Math.max(1200, Math.floor(targetWords * 0.35)), maxWords: Math.min(chapterMaxChars, Math.max(2400, Math.floor(targetWords * 0.55))), forbidDrawingImages, factCoverageContext, forcedSections: postGenerationGaps, signal: input.signal })));
      content = finalizeChapterContentQuality(content, chapter);
      postGenerationGaps = collectSectionContentGaps(content, [{ title: chapter.title, content, sections: chapter.sections || [] }]);
      if (postGenerationGaps.length === 0) generationDiagnostics.quality.repairedCount += 1;
    }
    const factUsageIssues = chapterSectionFactUsageIssues({ chapter, content, evidence });
    const chapterChars = documentTextLength(content);
    const sections = chapter.sections?.length ? chapter.sections : extractGeneratedSections(content);
    const expandedSectionIssues = sectionContentIntegrityIssues(content, [{ title: chapter.title, content, sections }]).map(issue => issue.message);
    const factUsageWarnings = factUsageIssues.slice(0, 6).map(issue => `小节事实密度需优化：${issue}`);
    const chapterIssues = [...lightweightChapterIssues({ chapter: { ...chapter, sections }, content, missingFacts, targetWords }), ...expandedSectionIssues, ...factUsageWarnings];
    const chapterStatus = chapterCompletionStatus(chapterChars, targetWords, chapterIssues);
    latestChapterStageForProgress = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: chapterPromptExecution.primaryPromptId,
      status: chapterStatus,
      message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已由大模型首轮成稿${expandRounds > 0 ? `并定向扩写 ${expandRounds} 轮` : ''}：当前 ${chapterChars} 字 / 目标 ${Math.floor(targetWords * 0.95)} 字${chapterStatus !== 'success' ? `；风险：${chapterIssues.join('、') || '篇幅未达标'}` : ''}`, chapterStartedAt),
      details: [`达标率：${Math.round(chapterChars / Math.max(1, Math.floor(targetWords * 0.95)) * 100)}%`, ...chapterPromptDetails, `二级小节：${sections.length} 个`, `扩写轮次：${expandRounds}`],
      progress: { current: chapterOrder + 1, total: effectiveChapters.length, label: chapterStatus === 'success' ? '章节达标' : '章节风险' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    chapterGenerationStagesByOrder[chapterOrder] = latestChapterStageForProgress;
    const draftChapter = { id: chapter.id, title: chapter.title, content, evidence, missingFacts, sections };
    chapterDraftsByOrder[chapterOrder] = draftChapter;
    chapterDrafts = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
    emitProgress(chapterDrafts);
    const finalIssues = lightweightChapterIssues({ chapter, content, missingFacts, targetWords });
    const finalSeverity = qualitySeveritySummary(finalIssues);
    generationDiagnostics.quality.blockingCount += finalSeverity.blocking;
    generationDiagnostics.quality.importantCount += finalSeverity.important;
    generationDiagnostics.quality.minorCount += finalSeverity.minor;
    } catch (err) {
      if (input.signal?.aborted) throw err;
      console.error(`[gen] chapter ${chapter.title} failed:`, err);
      failedChapterMessages.push(`${chapter.title}：${err instanceof Error ? err.message : '生成失败'}`);
      chapterGenerationStagesByOrder[chapterOrder] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'failed',
        message: `${displayChapterTitle(chapter.title)} 生成失败`,
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    }
    // 章节生成完成（成功或失败）→ 汇报进度
    if (latestChapterStageForProgress) progressStages[chapterProgressIndex] = latestChapterStageForProgress;
    emitProgress(chapterDrafts);
    }));
  }
  chapterDrafts = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
  chapterGenerationStages.push(...chapterGenerationStagesByOrder.filter((item): item is DocumentExecutionStage => Boolean(item)));
  const generatedChapterEvidence = chapterDrafts.flatMap(chapter => chapter.evidence || []);
  if (generatedChapterEvidence.length > 0) {
    allEvidence.push(...generatedChapterEvidence);
    const compactGeneratedEvidence = selectEvidenceByBudget(allEvidence, { maxChars: Math.max(50000, effectiveChapters.length * 9000), preservePinned: true });
    allEvidence.splice(0, allEvidence.length, ...compactGeneratedEvidence);
  }

  if (chapterDrafts.length === 0) {
    throw new Error(`章节生成未完成：${failedChapterMessages.join('；') || '没有生成任何有效章节'}`);
  }
  if (hasExplicitOutline && chapterDrafts.length < effectiveChapters.length) {
    throw new Error(`OUTLINE 指定 ${effectiveChapters.length} 章，实际只生成 ${chapterDrafts.length} 章：${failedChapterMessages.join('；') || '部分章节未生成'}`);
  }

  throwIfAborted(input.signal);
  upsertProgressStage(progressStages, displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'running', message: '正在理解多模态参考文件' }, { subtitle: '多模态参考文件' }));
  emitProgress(chapterDrafts);
  let fileUnderstanding: { stage: DocumentExecutionStage; notes: string[] } = { stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '文件理解跳过' }, notes: [] };
  try { fileUnderstanding = await understandReferenceFiles(projectRoot, allEvidence, input.signal); } catch (err) { if (input.signal?.aborted) throw err; console.error('[gen] fileUnderstanding failed:', err); }
  upsertProgressStage(progressStages, fileUnderstanding.stage);
  emitProgress(chapterDrafts);
  throwIfAborted(input.signal);
  for (const note of fileUnderstanding.notes) {
    allEvidence.push({
      chapterId: 'multimodal-file-understanding',
      filePath: '多模态模型文件理解结果',
      score: 1,
      content: note,
      roleId: 'multimodal-files',
      processingType: 'reference',
      source: 'multimodal',
    });
  }
  const compactPostFileEvidence = selectEvidenceByBudget(allEvidence, { maxItems: Math.max(48, effectiveChapters.length * 10), maxChars: Math.max(52000, effectiveChapters.length * 9000), preservePinned: true });
  allEvidence.splice(0, allEvidence.length, ...compactPostFileEvidence);

  const facts = extractFacts(template, allEvidence, documentSpec);
  for (const artifact of roleArtifacts) {
    for (const fact of artifact.facts) facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;
  }
  const localFacts = extractStructuredFacts(allEvidence, template, documentSpec);
  const projectBasicFacts = extractProjectBasicFactsFromEvidence(allEvidence);
  const preciseFacts = extractPreciseFactsFromEvidence(allEvidence, domainProfile);
  const roleStructuredFacts: DocumentFact[] = roleArtifacts.flatMap(artifact => artifact.facts.map(fact => ({ key: fact.key, value: stringifyFactValue(fact.value), sourceFile: fact.sourceFile, roleId: fact.roleId, confidence: 0.9 })));
  const preLlmFacts = [...roleStructuredFacts, ...localFacts, ...projectBasicFacts, ...preciseFacts];
  let llmExtraction: { facts: DocumentFact[]; stages: DocumentExecutionStage[] } = { facts: [], stages: [{ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped', message: '已有本地/角色事实覆盖主要必需字段，跳过 LLM 全量事实抽取' }] };
  if (shouldRunLlmFactExtraction(preLlmFacts, template, documentSpec)) {
    const factExtractionEvidence = selectEvidenceByBudget(allEvidence, { maxItems: 48, maxChars: 45000, preservePinned: true });
    try { llmExtraction = await extractFactsWithLlm(factExtractionEvidence, factExtractionPromptTexts, template, documentSpec, input.signal); } catch (err) { if (input.signal?.aborted) throw err; console.error('[gen] fact extraction failed:', err); }
  }
  throwIfAborted(input.signal);
  const structuredFacts = factsWithSourceFallback([...roleStructuredFacts, ...localFacts, ...projectBasicFacts, ...preciseFacts, ...llmExtraction.facts], allEvidence);

  // 进度回调：文件理解 + 事实抽取完成
  upsertProgressStage(progressStages, fileUnderstanding.stage);
  for (const stage of llmExtraction.stages) {
    upsertProgressStage(progressStages, stage);
  }
  emitProgress();
  const structuredTables = extractStructuredTables(allEvidence);
  const pinnedEvidenceCount = allEvidence.filter(item => item.source === 'pinned-evidence').length;
  const autoEvidenceCount = allEvidence.filter(item => item.source !== 'pinned-evidence' && item.source !== 'bound-file').length;
  const enhancementStage: DocumentExecutionStage = displayStage({
    type: 'reference',
    roleId: 'quality-enhancement',
    status: allEvidence.length > 0 ? 'success' : 'skipped',
    message: `增强贡献：知识库证据 ${allEvidence.length} 条，人工确认/固定证据 ${pinnedEvidenceCount} 条，自动检索证据 ${autoEvidenceCount} 条`,
  }, { subtitle: '证据与上下文增强' });
  progressStages.push(enhancementStage);
  emitProgress();
  for (const fact of structuredFacts) facts[fact.key] = `${stringifyFactValue(fact.value)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`;
  const sourceCounts = new Map<string, number>();
  for (const item of allEvidence) sourceCounts.set(item.filePath, (sourceCounts.get(item.filePath) ?? 0) + 1);
  const evidenceSourceCounts = new Map<string, number>();
  for (const item of allEvidence) evidenceSourceCounts.set(item.source || 'unknown', (evidenceSourceCounts.get(item.source || 'unknown') ?? 0) + 1);
  const sources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).map(([filePath, count]) => ({ filePath, count }));
  const factsModel = buildFactsModel(structuredFacts, structuredTables, missingItems, documentSpec, domainProfile);
  const chapterReadiness = evaluateChapterReadiness(chapterDrafts, documentSpec);
  const validation = validateDraft(chapterDrafts, structuredFacts, template);
  validation.warnings = [...validation.warnings, ...readiness.warnings];
  validation.errors = [...validation.errors, ...readiness.blockingIssues];
  const roleArtifactWarningIssues = roleArtifacts.flatMap(artifact => artifact.warnings.map(warning => ({
    level: /结构化事实读取不足|结构化章节读取不足|兜底|片段/u.test(warning) ? 'info' as const : 'warning' as const,
    message: warning,
    suggestion: '这是资料抽取诊断，不代表已抽取到的可靠参数不可用；生成时仍应优先使用绑定资料中的可靠参数。',
  })));
  let validationIssues = collectValidationIssueGroups(
    buildValidationIssues(validation, factsModel, chapterDrafts),
    chapterReadinessIssues(chapterReadiness),
    roleArtifactWarningIssues,
  );
  const forbidDrawingImages = shouldForbidDrawingImages(roleArtifacts, template);
  const budgetStartedAt = Date.now();
  const budgetBeforeChars = documentTextLength(chapterDrafts.map(chapter => chapter.content).join('\n\n'));
  upsertProgressStage(progressStages, displayStage({
    type: 'validation',
    roleId: 'document-budget',
    status: 'running',
    message: `正在进行全文预算校准：当前 ${budgetBeforeChars} 字`,
    details: [`章节数：${chapterDrafts.length}`, `目标：${documentBudget.targetChars || documentBudget.targetPages || '按章节深度'}`],
    progress: { current: 1, total: 2, label: '预算校准' },
  }, { subtitle: '文档预算' }));
  emitProgress(chapterDrafts);
  const budgetExpandedChapters = generationStrategy.enableDocumentBudgetExpansion
    ? await withProgressHeartbeat(() => expandDocumentToBudget({ template, chapters: chapterDrafts, budget: documentBudget, promptTexts, requirement: input.requirement, forbidDrawingImages, signal: input.signal }))
    : chapterDrafts;
  chapterDrafts.splice(0, chapterDrafts.length, ...budgetExpandedChapters);
  const budgetDraftMarkdown = chapterDrafts.map(chapter => chapter.content).join('\n\n');
  const factPatch = appendMissingFactPatchesToChapters(chapterDrafts, structuredFacts, budgetDraftMarkdown);
  if (factPatch.patchedCount > 0) {
    chapterDrafts.splice(0, chapterDrafts.length, ...factPatch.chapters);
    validationIssues = [...validationIssues, { level: 'info', message: `已自动补写未落位事实 ${factPatch.patchedCount} 项`, suggestion: '补写仅使用知识库已确认事实，未补写商务敏感信息或系统暂未确认内容。' }];
  }
  const budgetStatus = documentBudgetStatus(documentBudget, chapterDrafts.map(chapter => chapter.content).join('\n\n'));
  const budgetTargetText = [
    documentBudget.targetChars ? `目标 ${documentBudget.targetChars} 字${documentBudget.minChars || documentBudget.maxChars ? `（区间 ${documentBudget.minChars || 0}-${documentBudget.maxChars || '∞'} 字）` : ''}` : undefined,
    documentBudget.targetPages ? `目标 ${documentBudget.targetPages} 页${documentBudget.minPages || documentBudget.maxPages ? `（区间 ${documentBudget.minPages || 0}-${documentBudget.maxPages || '∞'} 页）` : ''}` : undefined,
  ].filter(Boolean).join(' / ') || '默认章节深度';
  const budgetOverLimit = Boolean(documentBudget.maxChars && budgetStatus.currentChars > documentBudget.maxChars);
  const budgetStage = displayStage({ type: 'validation', roleId: 'document-budget', status: budgetOverLimit || (documentBudget.minChars && budgetStatus.currentChars < documentBudget.minChars) ? 'fallback' : 'success', message: elapsedMessage(`文档预算：当前 ${budgetStatus.currentChars} 字，新增 ${Math.max(0, budgetStatus.currentChars - budgetBeforeChars)} 字，预计 ${budgetStatus.estimatedPages} 页；${budgetTargetText}`, budgetStartedAt) }, { subtitle: '文档预算' });
  upsertProgressStage(progressStages, budgetStage);
  emitProgress(chapterDrafts);
  const fallbackChapterCount = chapterGenerationStages.filter(stage => stage.type === 'chapter_generation' && stage.status === 'fallback').length;
  const missingChapterCount = Math.max(0, effectiveChapters.length - chapterDrafts.length);
  const generationStatusIssues: ValidationIssue[] = [
    ...(fallbackChapterCount > 0 ? [{ level: 'info' as const, message: `章节生成存在补充完善：${fallbackChapterCount} 章`, suggestion: '已保留章节成果；如需更高质量可复核对应章节，但不阻断导出。' }] : []),
    ...(missingChapterCount > 0 ? [{ level: 'error' as const, message: `部分章节生成失败：${missingChapterCount} 章`, suggestion: failedChapterMessages.join('；') || '请检查模型调用、知识库检索和事实抽取配置后重新生成失败章节。' }] : []),
  ];
  const chapterFactUsageValidationIssues = chapterDrafts.flatMap(chapter => {
    const templateChapter = effectiveChapters.find(item => item.id === chapter.id);
    if (!templateChapter) return [];
    const factUsageIssues = chapterSectionFactUsageIssues({ chapter: templateChapter, content: chapter.content, evidence: chapter.evidence || [] });
    return factUsageIssues.length > 0 ? [{ level: 'error' as const, message: `${displayChapterTitle(chapter.title)} 小节知识库事实或量化参数落位不足：${factUsageIssues.slice(0, 5).join('；')}`, suggestion: '请扩大本地知识库检索并定向补写对应小节，优先使用清单、图纸、招标要求中的原始事实、规格、数量、标准和工期参数。' }] : [];
  });
  validationIssues = collectValidationIssueGroups(validationIssues, generationStatusIssues, chapterFactUsageValidationIssues);
  const initialBlockingCount = validationIssues.filter(issue => issue.level === 'error' && isExportBlockingIssue(issue)).length;
  const assets: DocumentAsset[] = [];
  const executionStages: DocumentExecutionStage[] = [...progressStages];
  upsertProgressStage(executionStages, displayStage({
    type: 'reference',
    roleId: 'knowledge-usage-report',
    status: 'success',
    message: `资料使用报告：证据 ${allEvidence.length} 条，来源文件 ${sources.length} 份，结构化事实 ${structuredFacts.length} 条`,
    details: [
      `证据类型：${[...evidenceSourceCounts.entries()].map(([name, count]) => `${name} ${count}`).join('，') || '无'}`,
      `索引健康：可用切片 ${indexHealth.usableChunkCount} 条，待索引 ${indexHealth.pendingJobs} 个，向量 ${indexHealth.vectorStatus?.status || 'unknown'}`,
      factPatch.patchedCount > 0 ? `自动补写事实：${factPatch.patchedCount}/${factPatch.missingCount}` : `事实落位补写：0/${factPatch.missingCount}`,
    ],
  }, { subtitle: '资料使用报告' }));
  upsertProgressStage(executionStages, displayStage({
    type: 'reference',
    roleId: 'web-research-report',
    status: webResearchReport.enabled ? 'success' : 'skipped',
    message: webResearchReport.enabled ? `联网增强：检索章节 ${new Set(webResearchReport.chapters).size} 个，查询 ${webResearchReport.queries.length} 个，使用公开资料 ${webResearchReport.evidenceCount} 条` : '联网增强未开启',
    details: webResearchReport.enabled ? [
      `检索主题：${[...new Set(webResearchReport.queries)].join('；') || '无'}`,
      `过滤结果：${webResearchReport.filteredCount} 条`,
      '公开资料仅用于通用规范、政策、工艺和措施补充，不作为项目事实来源',
    ] : ['可在模型配置中开启联网增强'],
  }, { subtitle: '联网增强报告' }));
  upsertProgressStage(executionStages, displayStage({ type: 'validation', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'failed' : 'success', message: `阻断 ${initialBlockingCount}，错误 ${validation.errors.length}，警告 ${validation.warnings.length}` }, { subtitle: '最终规范校验' }));
  upsertProgressStage(executionStages, displayStage({ type: 'formatting', roleId: 'document-workflow', status: 'success', message: '已生成正式排版 Markdown' }));
  upsertProgressStage(executionStages, displayStage({ type: 'export_ready', roleId: 'document-workflow', status: initialBlockingCount > 0 ? 'failed' : 'success', message: initialBlockingCount > 0 ? '导出门禁未通过，请完成阻断问题修复后再导出' : '已准备好导出 Markdown/HTML/DOCX/PDF' }));
  const base = {
    templateId: template.id,
    templateName: template.name,
    title: template.outputTitle,
    requirement: input.requirement || '',
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
    exportGate: { passed: initialBlockingCount === 0, blockingIssues: validationIssues.filter(issue => issue.level === 'error' && isExportBlockingIssue(issue)), checklist: [] },
    assets,
    partialChapters: chapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: chapterDrafts,
    generatedAt: Date.now(),
  };
  let initialMarkdown = composeDocumentMarkdown(base, { forbidDrawingImages, promptRules: promptDocumentRules });
  if (process.env.DOCUMENT_ENABLE_POST_EXPORT_REVIEW !== '1') {
    const finalizedDocument = finalizeDocumentMarkdown(initialMarkdown, chapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules });
    let finalChapterDrafts = finalizedDocument.chapters.map(chapter => {
      const templateChapter = effectiveChapters.find(item => item.id === chapter.id) || chapter;
      return { ...chapter, content: finalizeChapterContentQuality(chapter.content, templateChapter) };
    });
    let finalMarkdown = normalizeProjectBasicInfoTable(repairKnownProjectBasicPlaceholders(replaceForbiddenFormalPhrases(finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: finalChapterDrafts }, { forbidDrawingImages, promptRules: promptDocumentRules }), finalChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules }).markdown), structuredFacts), structuredFacts);
    const collectDefaultFinalIssues = (markdown: string, chapters: DocumentDraftChapter[]) => collectValidationIssueGroups(
      validationIssues,
      validateDraftWithAutoSpec({ markdown, spec: documentSpec, summary: projectMaterialSummary }),
      validateFactConsistency({ markdown, facts: structuredFacts, summary: projectMaterialSummary, profile: domainProfile }),
      validateProjectContamination(markdown, projectMaterialSummary),
      projectBasicPlaceholderIssues(markdown, structuredFacts),
      buildStandardFinalValidationIssues({ markdown, chapters, factsModel, template, promptBindings, promptDocumentRules }),
      pageTargetIssues(template.generationSettings || template.exportSettings, markdown).filter(issue => !(documentBudget.minPages && /低于目标页数/u.test(issue.message))),
      documentBudgetIssues(documentBudget, markdown),
    );
    let finalIssues = dedupeValidationIssues(collectDefaultFinalIssues(finalMarkdown, finalChapterDrafts));
    let defaultRepairStage: DocumentExecutionStage | undefined;
    const defaultRepairIssues = finalIssues
      .filter(issue => issue.level === 'error' || /提示词要求|正式表格|禁止内容|后台|占位|空小节|缺少规划小节|目录|封面/u.test(issue.message))
      .map(issue => buildRepairTaskMessage(issue))
      .slice(0, 24);
    if (defaultRepairIssues.length > 0) {
      const repair = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'default-path-quality-repair', () => repairMarkdownByQuality({ markdown: finalMarkdown, template, chapters: finalChapterDrafts, promptTexts, requirement: input.requirement, issues: defaultRepairIssues, forbidDrawingImages, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: input.signal }), { issues: defaultRepairIssues.length }), executionStages);
      defaultRepairStage = repair.stage ? { ...repair.stage, message: `${repair.stage.message || '默认路径质量修复完成'}；触发问题 ${defaultRepairIssues.length} 个` } : undefined;
      if (repair.chapters !== finalChapterDrafts) {
        finalChapterDrafts = repair.chapters.map(chapter => {
          const templateChapter = effectiveChapters.find(item => item.id === chapter.id) || chapter;
          return { ...chapter, sections: chapter.sections || [], content: finalizeChapterContentQuality(chapter.content, templateChapter) };
        });
        finalMarkdown = normalizeProjectBasicInfoTable(repairKnownProjectBasicPlaceholders(replaceForbiddenFormalPhrases(finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: finalChapterDrafts }, { forbidDrawingImages, promptRules: promptDocumentRules }), finalChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules }).markdown), structuredFacts), structuredFacts);
        finalIssues = dedupeValidationIssues(collectDefaultFinalIssues(finalMarkdown, finalChapterDrafts));
        const unresolvedTasks = unresolvedRepairTasks(defaultRepairIssues, finalIssues).slice(0, 8);
        if (unresolvedTasks.length > 0) {
          const escalation = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'default-path-quality-repair-escalation', () => repairMarkdownByQuality({ markdown: finalMarkdown, template, chapters: finalChapterDrafts, promptTexts, requirement: input.requirement, issues: unresolvedTasks, forbidDrawingImages, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: input.signal }), { issues: unresolvedTasks.length }), executionStages);
          if (escalation.chapters !== finalChapterDrafts) {
            finalChapterDrafts = escalation.chapters.map(chapter => {
              const templateChapter = effectiveChapters.find(item => item.id === chapter.id) || chapter;
              return { ...chapter, sections: chapter.sections || [], content: finalizeChapterContentQuality(chapter.content, templateChapter) };
            });
            finalMarkdown = normalizeProjectBasicInfoTable(repairKnownProjectBasicPlaceholders(replaceForbiddenFormalPhrases(finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: finalChapterDrafts }, { forbidDrawingImages, promptRules: promptDocumentRules }), finalChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules }).markdown), structuredFacts), structuredFacts);
            finalIssues = dedupeValidationIssues(collectDefaultFinalIssues(finalMarkdown, finalChapterDrafts));
          }
          defaultRepairStage = displayStage({ type: 'llm_review', roleId: 'default-repair-verify', status: finalIssues.some(issue => unresolvedTasks.some(task => repairIssueSignature(task) === repairIssueSignature(issue))) ? 'fallback' : 'success', message: `修复后验证闭环完成：升级修复 ${unresolvedTasks.length} 个残留问题`, details: unresolvedTasks }, { subtitle: '修复后验证' });
        }
      }
    }
    const finalExportGate = buildExportGate(finalIssues, factsModel, finalChapterDrafts);
    const finalStages = executionStages.map(stage => {
      if (stage.type === 'validation' && stage.roleId === 'document-workflow') return { ...stage, status: finalExportGate.blockingIssues.length > 0 ? 'failed' as const : 'success' as const, message: `阻断 ${finalExportGate.blockingIssues.length}，问题 ${finalIssues.length}` };
      if (stage.type === 'export_ready') return { ...stage, status: finalExportGate.passed ? 'success' as const : 'failed' as const, message: finalExportGate.passed ? '已准备好导出 Markdown/HTML/DOCX/PDF' : '导出门禁未通过，请完成阻断问题修复后再导出' };
      return stage;
    });
    if (defaultRepairStage) finalStages.push(defaultRepairStage);
    finalStages.push(displayStage({ type: 'llm_review', roleId: 'post-export-review', status: 'skipped', message: '已跳过导出后的重型 LLM 复审；默认路径已执行本地硬规则校验与必要的精准局部修复；如需开启重型复审请设置 DOCUMENT_ENABLE_POST_EXPORT_REVIEW=1' }, { subtitle: '导出后复审' }));
    const compactFinalChapterDrafts = finalChapterDrafts.map(chapter => ({
      ...chapter,
      evidence: selectEvidenceByBudget(chapter.evidence || [], { maxItems: 12, maxChars: 9000, preservePinned: true }),
    }));
    return {
      ...base,
      chapters: compactFinalChapterDrafts,
      validationIssues: finalIssues,
      exportGate: finalExportGate,
      executionStages: finalStages,
      partialChapters: finalChapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
      checkpointChapters: compactFinalChapterDrafts,
      reviewMetadata: { chapterSummaries: [], globalIssues: [], diagnostics: generationDiagnostics },
      markdown: finalMarkdown,
    };
  }
  throwIfAborted(input.signal);
  const localChapterReviewSummaries = chapterDrafts.map(chapter => {
    const templateChapter = effectiveChapters.find(item => item.id === chapter.id) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections };
    const issues = lightweightChapterIssues({ chapter: templateChapter, content: chapter.content, missingFacts: chapter.missingFacts, targetWords: documentBudget.chapterTargets.get(chapter.id) || 1200 });
    const blocking = issues.some(issue => /缺少|空小节|只有标题|只有表格|正文篇幅明显低于目标|后台流程话术|占位|requiredFacts/u.test(issue));
    return { chapterId: chapter.id, title: chapter.title, status: blocking ? 'fail' as const : issues.length > 0 ? 'warn' as const : 'pass' as const, issues, suggestions: [], chars: documentTextLength(chapter.content) };
  });
  const chapterReviewRiskCount = localChapterReviewSummaries.filter(summary => summary.status !== 'pass').length;
  const shouldChapterReview = generationStrategy.enableChapterReview && chapterReviewRiskCount > 0;
  if (shouldChapterReview) {
    upsertProgressStage(executionStages, displayStage({
      type: 'llm_review',
      roleId: 'chapter-review',
      status: 'running',
      message: `正在进行章节级质量审查：${chapterReviewRiskCount}/${chapterDrafts.length} 章存在本地风险`,
      details: ['仅对本地扫描发现风险的生成结果触发 LLM 审查，按风险章节自然并行'],
      progress: { current: 1, total: 3, label: '章节审查' },
    }, { subtitle: '章节级质量审查' }));
    emitProgress(chapterDrafts, executionStages);
  }
  const chapterReview = shouldChapterReview
    ? await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'chapter-review', () => reviewChapterSummaries({ template, chapters: chapterDrafts, budget: documentBudget, promptTexts: reviewPromptTexts || promptTexts, requirement: input.requirement, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: input.signal }), { chapters: chapterDrafts.length }), executionStages)
    : { summaries: localChapterReviewSummaries, stage: displayStage({ type: 'llm_review' as const, roleId: 'chapter-review', status: 'skipped', message: generationStrategy.enableChapterReview ? '本地章节扫描未发现需要 LLM 章节审查的问题，已跳过' : '当前策略未启用章节级 LLM 审查' }, { subtitle: '章节级质量审查' }) };
  executionStages.push(chapterReview.stage);
  let chapterReviewSummaries = chapterReview.summaries;
  const chapterRepairTargets = chapterReviewSummaries.filter(summary => summary.status !== 'pass' && summary.issues.length > 0);
  if (chapterRepairTargets.length > 0) {
    upsertProgressStage(executionStages, displayStage({
      type: 'llm_review',
      roleId: 'chapter-review-repair',
      status: 'running',
      message: `正在按章节审查结果就地修复：${chapterRepairTargets.length} 章`,
      details: chapterRepairTargets.map(summary => `${summary.title}：${summary.issues.slice(0, 5).join('；')}`),
      progress: { current: 1, total: chapterRepairTargets.length, label: '章节就地修复' },
    }, { subtitle: '章节就地修复' }));
    emitProgress(chapterDrafts, executionStages);
    const repairedById = new Map<string, string>();
    let patchCount = 0;
    const repairConcurrency = Math.max(1, chapterRepairTargets.length || 1);
    for (let offset = 0; offset < chapterRepairTargets.length; offset += repairConcurrency) {
      throwIfAborted(input.signal);
      const batch = chapterRepairTargets.slice(offset, offset + repairConcurrency);
      const results = await Promise.all(batch.map(async summary => {
        const chapter = chapterDrafts.find(item => item.id === summary.chapterId);
        if (!chapter) return { chapterId: summary.chapterId, content: undefined as string | undefined, appliedCount: 0 };
        try {
          const result = await callWithTimeout(
            signal => repairChapterByQuality({ template, chapter, issues: summary.issues.slice(0, 4), promptTexts: reviewPromptTexts || promptTexts, requirement: input.requirement, forbidDrawingImages, diagnostics: generationDiagnostics, signal }),
            90000,
            input.signal,
          );
          return { chapterId: summary.chapterId, content: result?.content, appliedCount: result?.appliedCount || 0 };
        } catch {
          return { chapterId: summary.chapterId, content: undefined as string | undefined, appliedCount: 0 };
        }
      }));
      for (const result of results) {
        if (result.content) repairedById.set(result.chapterId, result.content);
        patchCount += result.appliedCount;
      }
    }
    let repairedCount = 0;
    const repairedChapterIds = new Set<string>();
    for (let index = 0; index < chapterDrafts.length; index += 1) {
      const content = repairedById.get(chapterDrafts[index].id);
      if (content && content !== chapterDrafts[index].content) {
        chapterDrafts[index] = { ...chapterDrafts[index], content };
        repairedChapterIds.add(chapterDrafts[index].id);
        repairedCount += 1;
      }
    }
    if (repairedCount > 0) {
      chapterReviewSummaries = chapterReviewSummaries.map(summary => repairedChapterIds.has(summary.chapterId)
        ? { ...summary, status: 'warn' as const, issues: [], suggestions: [`已按章节审查结果应用局部修复，修复前问题已移交最终校验复核。`], chars: documentTextLength(chapterDrafts.find(chapter => chapter.id === summary.chapterId)?.content || '') }
        : summary);
      initialMarkdown = composeDocumentMarkdown({ ...base, chapters: chapterDrafts, validationIssues, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules });
    }
    executionStages.push(displayStage({ type: 'llm_review' as const, roleId: 'chapter-review-repair', status: 'success' as const, message: `章节就地修复完成：修复 ${repairedCount} 章，应用 ${patchCount} 个 patch` }, { subtitle: '章节就地修复' }));
    emitProgress(chapterDrafts, executionStages);
  }
  if (shouldChapterReview) {
    const chapterReviewValidationIssues = chapterReviewSummaries
      .filter(item => item.status !== 'pass' && item.issues.length > 0)
      .map(summary => ({ level: summary.status === 'fail' ? 'error' as const : 'warning' as const, message: `${summary.title} 章节审查：共 ${summary.issues.length} 个问题；${summary.issues.join('；') || '存在质量风险'}`, suggestion: summary.suggestions.join('；') || '请复核章节事实覆盖、结构完整性和角色证据覆盖。' }));
    validationIssues = collectValidationIssueGroups(validationIssues, chapterReviewValidationIssues);
  }
  const shouldGlobalReview = generationStrategy.enableGlobalReview && (shouldChapterReview || validationIssues.some(issue => /事实一致性|项目污染|章节缺失|结构/u.test(issue.message)));
  if (shouldGlobalReview) {
    upsertProgressStage(executionStages, displayStage({
      type: 'llm_review',
      roleId: 'global-consistency-review',
      status: 'running',
      message: '正在进行全局一致性审查',
      details: ['仅在章节审查或本地校验发现跨章节风险时触发'],
      progress: { current: 2, total: 3, label: '全局审查' },
    }, { subtitle: '全局一致性审查' }));
    emitProgress(chapterDrafts, executionStages);
  }
  const globalReview = shouldGlobalReview
    ? await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'global-consistency-review', () => reviewGlobalConsistency({ template, chapters: chapterDrafts, chapterReviews: chapterReviewSummaries, promptTexts: reviewPromptTexts || promptTexts, requirement: input.requirement, projectContext, diagnostics: generationDiagnostics, signal: input.signal }), { chapters: chapterDrafts.length }), executionStages)
    : { issues: [] as string[], stage: displayStage({ type: 'llm_review' as const, roleId: 'global-consistency-review', status: 'skipped', message: generationStrategy.enableGlobalReview ? '未发现需要 LLM 全局一致性审查的跨章节风险，已跳过' : '当前策略未启用全局一致性审查' }, { subtitle: '全局一致性审查' }) };
  executionStages.push(globalReview.stage);
  validationIssues = collectValidationIssueGroups(
    validationIssues,
    globalReview.issues.map(issue => ({ level: 'warning' as const, message: `全局一致性审查：${issue}`, suggestion: '请复核跨章节术语、关键事实、范围边界和上下文一致性。' })),
  );
  emitProgress(chapterDrafts, executionStages);
  const riskChapters = chapterDrafts.filter(chapter => chapter.evidence.length === 0 || chapter.missingFacts.length > 0 || documentTextLength(chapter.content) < Math.floor((documentBudget.chapterTargets.get(chapter.id) || 1200) * 0.7) || chapterReviewSummaries.some(summary => summary.chapterId === chapter.id && summary.status === 'fail') || lightweightChapterIssues({ chapter: effectiveChapters.find(item => item.id === chapter.id) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections }, content: chapter.content, missingFacts: chapter.missingFacts, targetWords: documentBudget.chapterTargets.get(chapter.id) || 1200 }).length > 0);
  const forceFinalQualityReview = initialBlockingCount > 0 || globalReview.issues.length > 0 || chapterReviewSummaries.some(summary => summary.status === 'fail') || validationIssues.some(issue => /事实一致性|项目污染|章节生成存在兜底|章节生成失败|阻断/u.test(issue.message));
  const shouldFinalQualityReview = generationStrategy.enableFinalQualityReview && (forceFinalQualityReview || riskChapters.length > Math.max(3, Math.floor(chapterDrafts.length * 0.35)));
  const reviewStartedAt = Date.now();
  if (shouldFinalQualityReview) {
    upsertProgressStage(executionStages, displayStage({
      type: 'llm_review',
      roleId: 'llm-review',
      status: 'running',
      message: `正在进行最终质量审查：风险章节 ${riskChapters.length} 个`,
      details: ['只检查结构、事实一致性、目录层级和正式文档风格，不重写正文'],
      progress: { current: 3, total: 3, label: '质量审查' },
    }, { subtitle: '最终质量审查' }));
    emitProgress(chapterDrafts, executionStages);
  }
  const reviewEvidence = selectEvidenceByBudget(allEvidence, { maxItems: Math.max(32, effectiveChapters.length * 8), maxChars: Math.max(36000, effectiveChapters.length * 6000), preservePinned: true });
  const review = shouldFinalQualityReview
    ? await withProgressHeartbeat(() => reviewAndOptimizeMarkdown({ template, spec: documentSpec, markdown: initialMarkdown, evidence: reviewEvidence, promptTexts: reviewPromptTexts || promptTexts, projectContext, requirement: input.requirement, diagnostics: generationDiagnostics, signal: input.signal }), executionStages)
    : { markdown: initialMarkdown, stage: { type: 'llm_review' as const, roleId: 'llm-review', status: riskChapters.length > 0 ? 'fallback' as const : 'success' as const, message: riskChapters.length > 0 ? `本地风险扫描发现 ${riskChapters.length} 个低/中风险章节，未达到最终 LLM 审查触发阈值，保留为待复核 warning` : '本地风险扫描未发现需要 LLM 最终质量审查的章节' } };
  review.stage.message = elapsedMessage(review.stage.message || 'LLM 审查完成', reviewStartedAt);
  throwIfAborted(input.signal);
  const reviewedMarkdownBase = finalizeDocumentMarkdown(review.markdown === initialMarkdown ? composeDocumentMarkdown({ ...base, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules }) : review.markdown, chapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules }).markdown;
  const structureIssueMessages = plannedStructureIssues(reviewedMarkdownBase, template).map(issue => buildRepairTaskMessage(issue));
  const placeholderIssueMessages = formalPlaceholderIssues(reviewedMarkdownBase).map(issue => buildRepairTaskMessage(issue));
  const gateIssueMessages = plannedAutoSpecGateIssues(reviewedMarkdownBase, template).map(issue => buildRepairTaskMessage(issue));
  const preciseIssueMessages = preciseFactUsageIssues(reviewedMarkdownBase, factsModel).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const tocIssueMessages = promptDocumentRules.forbidToc ? [] : [...tocHierarchyIssues(reviewedMarkdownBase), ...tocBodyConsistencyIssues(reviewedMarkdownBase)].map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const contentIntegrityMessages = formalContentIntegrityIssues(reviewedMarkdownBase).map(issue => buildRepairTaskMessage(issue));
  const sectionIntegrityMessages = sectionContentIntegrityIssues(reviewedMarkdownBase, chapterDrafts).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const professionalMessages = buildProfessionalRepairIssues({ markdown: reviewedMarkdownBase, chapters: chapterDrafts, factsModel }).map(issue => buildRepairTaskMessage(issue));
  const repeatedBasicInfoMessages = duplicateBasicInfoIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const formalStyleMessages = formalStyleIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const minSectionMessages = minChapterSectionIssues(chapterDrafts).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const tertiaryHeadingMessages = tertiaryHeadingIssues(reviewedMarkdownBase).map(issue => `${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`);
  const qualityIssues = collectMessageGroups(structureIssueMessages, placeholderIssueMessages, gateIssueMessages, preciseIssueMessages, tocIssueMessages, contentIntegrityMessages, sectionIntegrityMessages, professionalMessages, repeatedBasicInfoMessages, formalStyleMessages, minSectionMessages, tertiaryHeadingMessages);
  const sectionRepairIssueSet = new Set(sectionIntegrityMessages);
  const repairStartedAt = Date.now();
  const repairIssues = qualityIssues.filter(message => !sectionRepairIssueSet.has(message));
  upsertProgressStage(executionStages, displayStage({
    type: 'llm_review',
    roleId: 'quality-repair',
    status: repairIssues.length > 0 ? 'running' : 'success',
    message: repairIssues.length > 0 ? `正在进行精准质量修复：${repairIssues.length} 个问题` : '未发现需要精准修复的问题',
    details: repairIssues,
    progress: { current: 1, total: Math.max(1, repairIssues.length), label: '质量修复' },
  }, { subtitle: '精准质量修复' }));
  emitProgress(chapterDrafts, executionStages);
  const repair = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'local-patch-quality-repair', () => repairMarkdownByQuality({ markdown: reviewedMarkdownBase, template, chapters: chapterDrafts, promptTexts, requirement: input.requirement, issues: repairIssues, forbidDrawingImages, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: input.signal }), { issues: repairIssues.length }), executionStages);
  if (repair.stage) repair.stage.message = elapsedMessage(repair.stage.message || '质量修复完成', repairStartedAt);
  throwIfAborted(input.signal);
  let reviewedStages = repair.stage ? [...executionStages, review.stage, repair.stage] : [...executionStages, review.stage];
  let repairedChapterDrafts = repair.chapters;
  let postPatchMarkdown = composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules });
  const postRepairIssues = buildPostRepairIssues({ markdown: postPatchMarkdown, chapters: repairedChapterDrafts, template, factsModel });
  const unresolvedQualityTasks = unresolvedRepairTasks(repairIssues, postRepairIssues).slice(0, 8);
  if (unresolvedQualityTasks.length > 0) {
    const escalation = await withProgressHeartbeat(() => measureGenerationStep(generationDiagnostics, 'local-patch-quality-repair-escalation', () => repairMarkdownByQuality({ markdown: postPatchMarkdown, template, chapters: repairedChapterDrafts, promptTexts, requirement: input.requirement, issues: unresolvedQualityTasks, forbidDrawingImages, strategy: generationStrategy, diagnostics: generationDiagnostics, signal: input.signal }), { issues: unresolvedQualityTasks.length }), reviewedStages);
    repairedChapterDrafts = escalation.chapters;
    postPatchMarkdown = composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules });
    reviewedStages = escalation.stage ? [...reviewedStages, { ...escalation.stage, roleId: 'quality-repair-escalation', message: `修复后验证发现残留问题，已升级修复 ${unresolvedQualityTasks.length} 个问题` }] : reviewedStages;
  }
  const postPatchSectionGaps = collectSectionContentGaps(postPatchMarkdown, repairedChapterDrafts)
    .filter(gap => gap.planned || gap.reason === 'missing_planned_section' || gap.reason === 'empty' || gap.reason === 'table_only');
  if (postPatchSectionGaps.length > 0) {
    const sectionRepairStartedAt = Date.now();
    upsertProgressStage(reviewedStages, displayStage({
      type: 'llm_review',
      roleId: 'section-content-repair',
      status: 'running',
      message: `正在补写空洞小节：${postPatchSectionGaps.length} 个问题`,
      details: postPatchSectionGaps.map(gap => gap.message),
      progress: { current: 1, total: postPatchSectionGaps.length, label: '小节补写' },
    }, { subtitle: '小节内容补写' }));
    emitProgress(repairedChapterDrafts, reviewedStages);
    const patchedChapterDrafts = [...repairedChapterDrafts];
    for (let offset = 0; offset < repairedChapterDrafts.length; offset += Math.max(1, repairedChapterDrafts.length || 1)) {
      throwIfAborted(input.signal);
      const batch = repairedChapterDrafts.slice(offset, offset + Math.max(1, repairedChapterDrafts.length || 1));
      const batchResults = await Promise.all(batch.map(async chapter => {
        const chapterGaps = postPatchSectionGaps.filter(gap => gap.chapterTitle === chapter.title);
        if (chapterGaps.length === 0) return chapter;
        const templateChapter = effectiveChapters.find(item => item.id === chapter.id || item.title === chapter.title) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections };
        const targetWords = documentBudget.chapterTargets.get(chapter.id) || 1200;
        const plan = chapterPlanFor(templateChapter, tenderPlan);
        try {
          const supplemented = await callWithTimeout(
            signal => supplementShortSections({ template, chapter: templateChapter, content: chapter.content, evidence: chapter.evidence, missingFacts: chapter.missingFacts, promptTexts, projectContext, requirement: input.requirement, roleContext: buildRoleChapterContext(roleArtifacts, templateChapter, plan), targetWords, forbidDrawingImages, forcedSections: chapterGaps, signal }),
            Math.min(300000, Math.max(90000, chapterGaps.length * 90000)),
            input.signal,
          );
          if (!supplemented) return chapter;
          const sections = chapter.sections?.length ? chapter.sections : extractGeneratedSections(supplemented);
          return { ...chapter, content: supplemented, markdown: supplemented, sections };
        } catch {
          return chapter;
        }
      }));
      batchResults.forEach((chapter, index) => { patchedChapterDrafts[offset + index] = chapter; });
    }
    repairedChapterDrafts = patchedChapterDrafts;
    const remainingSectionIssues = sectionContentIntegrityIssues(composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules }), repairedChapterDrafts);
    upsertProgressStage(reviewedStages, displayStage({ type: 'llm_review', roleId: 'section-content-repair', status: remainingSectionIssues.length > 0 ? 'fallback' : 'success', message: elapsedMessage(remainingSectionIssues.length > 0 ? `小节补写后仍存在 ${remainingSectionIssues.length} 个内容缺口` : '小节内容补写完成', sectionRepairStartedAt), details: remainingSectionIssues.map(issue => issue.message) }, { subtitle: '小节内容补写' }));
    emitProgress(repairedChapterDrafts, reviewedStages);
  }
  const repairedBudgetStatus = documentBudgetStatus(documentBudget, repairedChapterDrafts.map(chapter => chapter.content).join('\n\n'));
  if (generationStrategy.enableDocumentBudgetExpansion && documentBudget.minChars && repairedBudgetStatus.currentChars < Math.floor(documentBudget.minChars * 0.9) && (!documentBudget.maxChars || repairedBudgetStatus.currentChars < documentBudget.maxChars)) {
    const postRepairBudgetStartedAt = Date.now();
    const postRepairBeforeChars = repairedBudgetStatus.currentChars;
    upsertProgressStage(reviewedStages, displayStage({
      type: 'validation',
      roleId: 'document-budget-repair',
      status: 'running',
      message: `正在进行修复后预算补齐：当前 ${postRepairBeforeChars} 字`,
      details: [`目标下限：${documentBudget.minChars} 字`, `章节数：${repairedChapterDrafts.length}`],
      progress: { current: 1, total: 2, label: '预算补齐' },
    }, { subtitle: '修复后预算补齐' }));
    emitProgress(repairedChapterDrafts, reviewedStages);
    repairedChapterDrafts = await withProgressHeartbeat(() => expandDocumentToBudget({ template, chapters: repairedChapterDrafts, budget: documentBudget, promptTexts, requirement: input.requirement, forbidDrawingImages, signal: input.signal }), reviewedStages);
    const postRepairBudgetStatus = documentBudgetStatus(documentBudget, repairedChapterDrafts.map(chapter => chapter.content).join('\n\n'));
    upsertProgressStage(reviewedStages, displayStage({ type: 'validation', roleId: 'document-budget-repair', status: documentBudget.minChars && postRepairBudgetStatus.currentChars < documentBudget.minChars ? 'fallback' : 'success', message: elapsedMessage(`修复后预算补齐：当前 ${postRepairBudgetStatus.currentChars} 字，新增 ${Math.max(0, postRepairBudgetStatus.currentChars - postRepairBeforeChars)} 字，预计 ${postRepairBudgetStatus.estimatedPages} 页`, postRepairBudgetStartedAt) }, { subtitle: '修复后预算补齐' }));
  }
  const repairedMarkdown = composeDocumentMarkdown({ ...base, chapters: repairedChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules });
  let finalizedDocument = finalizeDocumentMarkdown(repairedMarkdown, repairedChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules });
  let finalChapterDrafts = finalizedDocument.chapters;
  let finalMarkdown = finalizedDocument.markdown;
  const plannedFinalChapters = finalChapterDrafts.map(chapter => {
    const planned = repairedChapterDrafts.find(item => item.id === chapter.id || item.title === chapter.title);
    return { ...chapter, sections: planned?.sections || [] };
  });
  const finalSectionGaps = collectSectionContentGaps(finalMarkdown, plannedFinalChapters)
    .filter(gap => gap.planned || gap.reason === 'missing_planned_section' || gap.reason === 'empty' || gap.reason === 'table_only');
  if (finalSectionGaps.length > 0) {
    const finalSectionRepairStartedAt = Date.now();
    upsertProgressStage(reviewedStages, displayStage({ type: 'llm_review', roleId: 'final-section-content-repair', status: 'running', message: `最终结构化后补写残留空洞小节：${finalSectionGaps.length} 个问题`, details: finalSectionGaps.map(gap => gap.message), progress: { current: 1, total: finalSectionGaps.length, label: '最终小节补写' } }, { subtitle: '最终小节内容补写' }));
    emitProgress(finalChapterDrafts, reviewedStages);
    const repairedFinalChapters = [...finalChapterDrafts];
    for (let offset = 0; offset < finalChapterDrafts.length; offset += Math.max(1, finalChapterDrafts.length || 1)) {
      throwIfAborted(input.signal);
      const batch = finalChapterDrafts.slice(offset, offset + Math.max(1, finalChapterDrafts.length || 1));
      const batchResults = await Promise.all(batch.map(async chapter => {
        const chapterGaps = finalSectionGaps.filter(gap => gap.chapterTitle === chapter.title);
        if (chapterGaps.length === 0) return chapter;
        const templateChapter = effectiveChapters.find(item => item.id === chapter.id || item.title === chapter.title) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections };
        const targetWords = documentBudget.chapterTargets.get(chapter.id) || 1200;
        const plan = chapterPlanFor(templateChapter, tenderPlan);
        try {
          const supplemented = await callWithTimeout(
            signal => supplementShortSections({ template, chapter: templateChapter, content: chapter.content, evidence: chapter.evidence, missingFacts: chapter.missingFacts, promptTexts, projectContext, requirement: input.requirement, roleContext: buildRoleChapterContext(roleArtifacts, templateChapter, plan), targetWords, forbidDrawingImages, forcedSections: chapterGaps, signal }),
            Math.min(300000, Math.max(90000, chapterGaps.length * 90000)),
            input.signal,
          );
          if (!supplemented) return chapter;
          const sections = chapter.sections?.length ? chapter.sections : extractGeneratedSections(supplemented);
          return { ...chapter, content: supplemented, markdown: supplemented, sections };
        } catch {
          return chapter;
        }
      }));
      batchResults.forEach((chapter, index) => { repairedFinalChapters[offset + index] = chapter; });
    }
    finalizedDocument = finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: repairedFinalChapters, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules }), repairedFinalChapters, { forbidDrawingImages, promptRules: promptDocumentRules });
    finalChapterDrafts = finalizedDocument.chapters;
    finalMarkdown = finalizedDocument.markdown;
    const remainingFinalSectionIssues = sectionContentIntegrityIssues(finalMarkdown, finalChapterDrafts);
    upsertProgressStage(reviewedStages, displayStage({ type: 'llm_review', roleId: 'final-section-content-repair', status: remainingFinalSectionIssues.length > 0 ? 'fallback' : 'success', message: elapsedMessage(remainingFinalSectionIssues.length > 0 ? `最终补写后仍存在 ${remainingFinalSectionIssues.length} 个内容缺口` : '最终小节内容补写完成', finalSectionRepairStartedAt), details: remainingFinalSectionIssues.map(issue => issue.message) }, { subtitle: '最终小节内容补写' }));
    emitProgress(finalChapterDrafts, reviewedStages);
  }
  finalizedDocument = finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: finalChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules }), finalChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules });
  finalChapterDrafts = finalizedDocument.chapters;
  finalMarkdown = normalizeProjectBasicInfoTable(repairKnownProjectBasicPlaceholders(finalizedDocument.markdown, structuredFacts), structuredFacts);
  const canonicalFacts = buildCanonicalFacts({ facts: structuredFacts, markdown: finalMarkdown });
  if (canonicalFacts.size > 0) executionStages.push({ type: 'fact_extraction', roleId: 'canonical-facts', status: 'success', message: `已决策可信基础事实 ${canonicalFacts.size} 项`, details: [...canonicalFacts.values()].map(fact => `${fact.label}=${fact.value}（${fact.source}，confidence=${fact.confidence}）`).slice(0, 12) });
  const preRepairWarningIssues = [...structureIssueMessages];
  validationIssues = collectValidationIssueGroups(
    applySpecGateRules(documentSpec, [...validationIssues, ...preRepairWarningIssues.map(message => ({ level: 'warning' as const, message }))], factsModel, finalChapterDrafts, finalMarkdown, fileBindings, promptBindings),
    validateDraftWithAutoSpec({ markdown: finalMarkdown, spec: documentSpec, summary: projectMaterialSummary }),
    validateFactConsistency({ markdown: finalMarkdown, facts: structuredFacts, summary: projectMaterialSummary, profile: domainProfile }),
    validateProjectContamination(finalMarkdown, projectMaterialSummary),
    projectBasicPlaceholderIssues(finalMarkdown, structuredFacts),
    buildStandardFinalValidationIssues({ markdown: finalMarkdown, chapters: finalChapterDrafts, factsModel, template, promptBindings, promptDocumentRules }),
  );
  const finalFactPatch = appendMissingFactPatchesToChapters(finalChapterDrafts, structuredFacts, finalMarkdown);
  if (finalFactPatch.patchedCount > 0) {
    finalChapterDrafts = finalFactPatch.chapters.map(chapter => ({ ...chapter, sections: chapter.sections || [] }));
    validationIssues = [...validationIssues, { level: 'info', message: `最终审查阶段已补写未落位事实 ${finalFactPatch.patchedCount} 项`, suggestion: '补写仅使用知识库已确认事实，未补写商务敏感信息或系统暂未确认内容。' }];
    finalMarkdown = finalizeDocumentMarkdown(composeDocumentMarkdown({ ...base, chapters: finalChapterDrafts, validationIssues, exportGate: base.exportGate, executionStages }, { forbidDrawingImages, promptRules: promptDocumentRules }), finalChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules }).markdown;
  }
  validationIssues = collectValidationIssueGroups(validationIssues, factCoverageIssues(finalMarkdown, [...structuredFacts, ...factsModel.preciseFacts], { maxIssues: 30 }));
  finalMarkdown = finalizeDocumentMarkdown(finalMarkdown, finalChapterDrafts, { forbidDrawingImages, promptRules: promptDocumentRules }).markdown;
  const budgetIssues = documentBudgetIssues(documentBudget, finalMarkdown);
  const pageIssues = pageTargetIssues(template.generationSettings || template.exportSettings, finalMarkdown).filter(issue => !(documentBudget.minPages && /低于目标页数/u.test(issue.message)));
  validationIssues = dedupeValidationIssues(collectValidationIssueGroups(validationIssues, pageIssues, budgetIssues, plannedStructureIssues(finalMarkdown, template), promptDocumentRuleIssues(finalMarkdown, promptDocumentRules)));
  const knowledgeCoverage = buildKnowledgeCoverageReport({ chapters: finalChapterDrafts, templateChapters: effectiveChapters, factsModel, evidence: allEvidence });
  const factTraces = buildDocumentFactTraces(finalMarkdown, factsModel);
  const chapterCoverage = buildChapterCoverageReports({ chapters: finalChapterDrafts, templateChapters: effectiveChapters, factsModel });
  validationIssues = dedupeValidationIssues(collectValidationIssueGroups(
    validationIssues,
    knowledgeCoverageIssues(knowledgeCoverage),
    factTraceIssues(factTraces, { maxIssues: 20 }),
    chapterCoverageIssues(chapterCoverage),
    retrievalCoverageIssues(retrievalCoverageReports),
  ));
  let finalExportGate = buildExportGate(validationIssues, factsModel, finalChapterDrafts);
  let qualityReport = buildDocumentQualityReport({ markdown: finalMarkdown, chapters: finalChapterDrafts, issues: validationIssues, knowledgeCoverage, factTraces, chapterCoverage });
  const repairStrategies = buildRepairStrategies({ issues: validationIssues, qualityReport, knowledgeCoverage, factTraces, chapterCoverage });
  validationIssues = dedupeValidationIssues(collectValidationIssueGroups(validationIssues, qualityReportIssues(qualityReport), repairStrategyIssues(repairStrategies)));
  finalExportGate = buildExportGate(validationIssues, factsModel, finalChapterDrafts);
  qualityReport = buildDocumentQualityReport({ markdown: finalMarkdown, chapters: finalChapterDrafts, issues: validationIssues, knowledgeCoverage, factTraces, chapterCoverage });
  const reviewChecklist = buildDocumentReviewChecklist({ exportGate: finalExportGate, qualityReport, repairStrategies });
  const telemetry = buildDocumentTelemetryReport({ diagnostics: generationDiagnostics });
  const blockingCount = finalExportGate.blockingIssues.length;
  const finalQualitySummary = qualitySeveritySummary(validationIssues);
  generationDiagnostics.quality.blockingCount += finalQualitySummary.blocking;
  generationDiagnostics.quality.importantCount += finalQualitySummary.important;
  generationDiagnostics.quality.minorCount += finalQualitySummary.minor;
  const finalStages: DocumentExecutionStage[] = reviewedStages.map(stage => {
    if (stage.type === 'validation' && stage.roleId === 'document-workflow') return { ...stage, status: blockingCount > 0 ? 'failed' : 'success', message: `阻断 ${blockingCount}，问题 ${validationIssues.length}` };
    if (stage.type === 'export_ready') return { ...stage, status: finalExportGate.passed ? 'success' : 'failed', message: finalExportGate.passed ? '已准备好导出 Markdown/HTML/DOCX/PDF' : '导出门禁未通过，请完成阻断问题修复后再导出' };
    return stage;
  });
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-delivery-score', status: qualityReport.passed ? 'success' : 'fallback', message: qualityReport.summary, details: qualityReport.actions }, { subtitle: '交付评分' }));
  finalStages.push(displayStage({ type: 'reference', roleId: 'knowledge-coverage', status: knowledgeCoverage.score >= 85 ? 'success' : 'fallback', message: `知识库确认覆盖率：${knowledgeCoverage.score}%（证据 ${knowledgeCoverage.evidenceCount} 条，文件 ${knowledgeCoverage.confirmedFiles} 份）`, details: [knowledgeCoverage.remediation] }, { subtitle: '知识库覆盖' }));
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-review-checklist', status: reviewChecklist.every(item => item.passed) ? 'success' : 'fallback', message: `交付复核清单：通过 ${reviewChecklist.filter(item => item.passed).length}/${reviewChecklist.length}`, details: reviewChecklist.map(item => `${item.passed ? '通过' : '待修复'}：${item.label}${item.message ? `（${item.message}）` : ''}`) }, { subtitle: '交付复核' }));
  const slowMetrics = slowMetricSummary(generationDiagnostics.metrics);
  finalStages.push(displayStage({ type: 'validation', roleId: 'document-diagnostics', status: 'success', message: `性能统计：LLM ${generationDiagnostics.llm.calls} 次，失败 ${generationDiagnostics.llm.failures} 次，峰值并行 ${generationDiagnostics.llm.maxActive}，检索 ${generationDiagnostics.evidence.searchQueries} 次/${Math.round(generationDiagnostics.evidence.searchMs / 1000)} 秒，证据上下文 ${generationDiagnostics.evidence.contextChars} 字，噪声过滤 ${generationDiagnostics.evidence.filteredNoise} 条，质量问题 阻断${generationDiagnostics.quality.blockingCount}/重要${generationDiagnostics.quality.importantCount}/轻微${generationDiagnostics.quality.minorCount}${slowMetrics ? `，Top耗时：${slowMetrics}` : ''}` }, { subtitle: '后台诊断' }));
  const compactFinalChapterDrafts = finalChapterDrafts.map(chapter => ({
    ...chapter,
    evidence: selectEvidenceByBudget(chapter.evidence || [], { maxItems: 12, maxChars: 9000, preservePinned: true }),
  }));
  const finalBase = {
    ...base,
    chapters: compactFinalChapterDrafts,
    validationIssues,
    exportGate: finalExportGate,
    executionStages: finalStages,
    partialChapters: finalChapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: compactFinalChapterDrafts,
    reviewMetadata: {
      chapterSummaries: chapterReviewSummaries,
      globalIssues: globalReview.issues,
      diagnostics: generationDiagnostics,
      profile: buildDocumentProfileReport({ template, chapters: effectiveChapters, requirement: input.requirement }),
      knowledgeCoverage,
      factTraces,
      chapterCoverage,
      retrievalCoverage: retrievalCoverageReports,
      qualityReport,
      repairStrategies,
      reviewChecklist,
      workflowVersion: DOCUMENT_WORKFLOW_VERSION,
      telemetry,
    },
  };
  return { ...finalBase, markdown: finalMarkdown };
}

export async function regenerateDocumentChapter(input: { templateId: string; chapterId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; documentId?: string; currentMarkdown?: string; existingFacts?: string[] }): Promise<DocumentDraftChapter> {
  const template = getDocumentTemplate(input.templateId);
  if (!template) throw new Error('Document template not found');
  const chapter = template.chapters.find(item => item.id === input.chapterId);
  if (!chapter) throw new Error('Document chapter not found');
  const projectRoot = path.resolve(input.projectRoot || getProjectRoot());
  if (!projectRoot) throw new Error('No knowledge base project found');
  const manager = getMultiProjectManager();
  const fileBindings = templateFileBindings(template);
  const boundFilePaths = buildBoundEvidenceScope(projectRoot, fileBindings);
  const allFileRoles = listDocumentRoles('file');
  const fileRoleByPath = new Map(fileBindings.flatMap(binding => fileScopeKeys(projectRoot, binding.filePath).map(key => [key, binding.roleId] as const)));
  const fileProcessingByPath = new Map(fileBindings.flatMap(binding => fileScopeKeys(projectRoot, binding.filePath).map(key => [key, allFileRoles.find(role => role.id === binding.roleId)?.processingType || 'reference'] as const)));
  const project = await manager.getProject(projectRoot);
  const requestedEvidencePerChapter = resolveDocumentGenerationEvidenceLimit(project, [...boundFilePaths], input.maxEvidencePerChapter);
  const rawEvidence: DocumentEvidence[] = [];
  const scopedFilePaths = [...boundFilePaths].filter(Boolean).sort();
  const queries = compactChapterQueries(chapter, chapter.queries, []);
  const maxSearchQueries = qualityFirstSearchQueryLimit(chapter, []);
  for (const query of queries.slice(0, maxSearchQueries)) {
    const result = await manager.search(projectRoot, query, {
      scope: 'project',
      filters: { filePaths: scopedFilePaths },
      limit: Math.min(requestedEvidencePerChapter, 12),
      weights: { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
    });
    rawEvidence.push(...result.results
      .filter((item: KbSearchResult) => evidenceInScope(projectRoot, item.filePath, boundFilePaths))
      .map((item: KbSearchResult) => ({
        chapterId: chapter.id,
        filePath: item.filePath,
        score: item.score,
        content: item.content,
        roleId: fileRoleByPath.get(item.filePath),
        processingType: fileProcessingByPath.get(item.filePath),
        sectionTitle: item.sectionTitle,
        source: item.source,
      })));
  }
  const scopedEvidence = rawEvidence.filter(item => evidenceInScope(projectRoot, item.filePath, boundFilePaths));
  const evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter, chapter), maxChars: 16000, preservePinned: true });
  const existingContext = input.currentMarkdown || '';
  const existingFactSet = new Set(input.existingFacts ?? []);
  const missingFacts = chapter.requiredFacts.filter(fact => !existingFactSet.has(fact) && !evidence.some(item => evidenceMatchesFact(item, fact)));
  const content = [
    `## ${chapter.title}`,
    '',
    input.requirement ? `> 生成要求：${input.requirement}` : '',
    existingContext ? `> 当前文档上下文摘要：${existingContext.replace(/\s+/gu, ' ')}` : '',
    evidence.length > 0 ? `本章根据知识库资料围绕“${chapter.purpose}”重新整理，并与当前文档上下文保持一致。` : '系统暂未检索到足够证据，建议扩大本地知识库检索后复核。',
    '',
    evidence.length > 0 ? '### 资料依据' : '',
    ...evidence.map(evidenceLine),
    '',
    missingFacts.length > 0 ? '### 待确认事项' : '',
    ...missingFacts.map(item => `- ${item}：建议扩大本地知识库检索、事实补抽或人工复核系统落位结果。`),
  ].filter(Boolean).join('\n');
  return { id: chapter.id, title: chapter.title, content, evidence, missingFacts };
}
