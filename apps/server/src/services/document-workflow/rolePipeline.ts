import * as fs from 'node:fs';
import * as path from 'node:path';
import { BLOCKING_CHAPTER_ISSUE_RE, PROMPT_EXECUTION_SCORE_RULES, QUALITY_REPAIR_INSTRUCTIONS, QUALITY_REPAIR_TYPE_RULES, REPAIRABLE_QUALITY_ISSUE_RE, ROLE_OUTPUT_TYPE_RULES } from '../constants';
import { listDocumentRoles } from '../document-core/documentRoleService';
import type { QualityRepairType, RoleEvidencePool, RoleExecutionNode, RoleExtractionChapterInput, RoleExtractionFactInput, RoleExtractionLlmResult, RoleExtractionRequirementInput, RoleNodeArtifact, RoleNodeFact, TenderPlanChapter } from '../types';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentGenerationDiagnostics, DocumentGenerationStrategy, DocumentTemplate, DocumentTemplateChapter, FileBinding, PromptBinding } from './types';

export type { QualityRepairType, RoleEvidencePool, RoleExecutionNode, RoleExtractionChapterInput, RoleExtractionFactInput, RoleExtractionLlmResult, RoleExtractionRequirementInput, RoleNodeArtifact, RoleNodeFact, TenderPlanChapter } from '../types';
import { readPromptContents, type ResolvedPromptContent, violatesConfiguredChapterTitleFilter } from './templateStore';
import { buildEvidenceBundle, cleanEvidenceText, evidenceBundlePrompt, evidencePromptBudgetForTarget, selectEvidenceByBudget, uniqueEvidence } from './evidence';
import { hasExplicitOutlineBlock, isExplicitOutlineClosingLine, isExplicitOutlineOpeningLine, isValidGeneratedChapterTitle, normalizeGeneratedChapterTitle } from './outline';
import { CAD_ENTITY_TOKEN_RE, CN_NUMERAL_RE, FILE_NAME_RE } from './constants';
import { FORMAL_WRITING_RULES, WORKFLOW_PHRASE_RE, removeUnwantedDrawingImages, sanitizeFormalMarkdown } from './markdownComposer';
import { documentTextLength } from './budget';
import { classifyQualitySeverity, degenerateContentIssues } from './qualityValidation';
import { callDocumentLlmJson } from './llmClient';
import { asObjectArray, asStringArray, safePlanId, stableHash, stringifyFactValue, throwIfAborted } from './utils';


export function selectDocumentGenerationStrategy(input: { template: DocumentTemplate; targetWords: number; requirement?: string }): DocumentGenerationStrategy {
  const chapterCount = input.template.chapters.length;
  const avgChapterTarget = chapterCount > 0 ? input.targetWords / chapterCount : input.targetWords;
  const text = `${input.template.name}\n${input.template.category || ''}\n${input.requirement || ''}`;
  const strict = /专项|安全|质量|验收|审核|合同|合规|审计|风控|风险/u.test(text);
  const longform = input.targetWords >= 30000 || chapterCount >= 8 || avgChapterTarget >= 4000;
  const compact = input.targetWords <= 6000 && chapterCount <= 4 && !strict;
  const mode: DocumentGenerationStrategy['mode'] = strict ? 'strict' : longform ? 'longform' : compact ? 'fast' : 'balanced';
  return {
    mode,
    enableChapterReview: true,
    enableGlobalReview: true,
    enableDocumentBudgetExpansion: true,
    enableFinalQualityReview: true,
  };
}

export function createGenerationDiagnostics(strategy: DocumentGenerationStrategy): DocumentGenerationDiagnostics {
  return {
    strategy,
    metrics: [],
    llm: { calls: 0, failures: 0, maxActive: 0 },
    evidence: { raw: 0, used: 0, filteredNoise: 0, avgNoiseScore: 0, avgFactDensity: 0, searchQueries: 0, searchMs: 0, contextChars: 0 },
    quality: { blockingCount: 0, importantCount: 0, minorCount: 0, repairedCount: 0 },
  };
}

export async function measureGenerationStep<T>(diagnostics: DocumentGenerationDiagnostics, name: string, run: () => Promise<T>, meta?: Record<string, string | number | boolean>) {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    const endedAt = Date.now();
    diagnostics.metrics.push({ name, startedAt, endedAt, durationMs: endedAt - startedAt, meta });
  }
}

export function normalizeRoleText(value: string) {
  return value.toLowerCase();
}

export function inferRoleOutputType(role: { id: string; name: string; processingType?: string }, promptTexts: string[] = []): RoleExecutionNode['outputType'] {
  const text = normalizeRoleText(`${role.id} ${role.name} ${role.processingType || ''} ${promptTexts.join(' ')}`);
  for (const rule of ROLE_OUTPUT_TYPE_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) return rule.outputType;
  }
  return 'reference_facts';
}

function scorePromptRoleTokens(promptText: string, fileRole: { id: string; name: string; processingType?: string }) {
  let score = 0;
  const tokens = [fileRole.id, fileRole.name, fileRole.processingType || ''];
  for (const token of tokens) {
    if (token && promptText.includes(normalizeRoleText(token))) score += 4;
  }
  return score;
}

export function promptExecutionScore(promptRoleId: string, fileRole: { id: string; name: string; processingType?: string }, promptTexts: string[]) {
  const promptText = normalizeRoleText(`${promptRoleId} ${promptTexts.join(' ')}`);
  const fileText = normalizeRoleText(`${fileRole.id} ${fileRole.name} ${fileRole.processingType || ''}`);
  let score = scorePromptRoleTokens(promptText, fileRole);
  for (const rule of PROMPT_EXECUTION_SCORE_RULES) {
    rule.promptPattern.lastIndex = 0;
    if (rule.filePattern) rule.filePattern.lastIndex = 0;
    const fileMatched = !rule.filePattern || rule.filePattern.test(fileText);
    if (fileMatched && rule.promptPattern.test(promptText)) score += rule.points;
  }
  return score;
}


export function evidencePoolKey(projectRoot: string, filePath: string) {
  return path.relative(projectRoot, path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath));
}

export function projectEvidenceVersionHash(project: any, projectRoot: string, scopePaths: Set<string>) {
  const records = typeof project.listFiles === 'function' ? project.listFiles() as Array<Record<string, unknown>> : [];
  const byPath = new Map(records.map(record => [String(record.relativePath || ''), record]));
  const entries: Array<Record<string, unknown>> = [];
  for (const filePath of [...scopePaths].sort()) {
    const relativePath = evidencePoolKey(projectRoot, filePath);
    const record = byPath.get(filePath) || byPath.get(relativePath);
    if (!record) {
      entries.push({ filePath: relativePath, missing: true });
      continue;
    }
    entries.push({
      filePath: record.relativePath || relativePath,
      contentHash: record.contentHash,
      fileSize: record.fileSize,
      mtime: record.mtime,
      chunkCount: record.chunkCount,
      indexedAt: record.indexedAt,
    });
  }
  return stableHash({ type: 'project-evidence-version-v2', entries });
}

function uniqueNodeFilePaths(nodes: RoleExecutionNode[]) {
  const seen = new Set<string>();
  const filePaths: string[] = [];
  let bindingCount = 0;
  for (const node of nodes) {
    for (const filePath of node.filePaths) {
      bindingCount += 1;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      filePaths.push(filePath);
    }
  }
  return { filePaths, bindingCount };
}

function evidenceFromProjectDetail(detail: any, maxChars?: number) {
  const evidence: DocumentEvidence[] = [];
  let usedChars = 0;
  const chunks = (detail.chunks || []) as Array<{ content: string; sectionTitle?: string }>;
  const totalChunks = Number.isFinite(detail.totalChunkCount) ? Number(detail.totalChunkCount) : chunks.length;
  for (const chunk of chunks) {
    const content = cleanEvidenceText(chunk.content);
    if (!content) continue;
    if (Number.isFinite(maxChars) && maxChars! > 0 && usedChars + content.length > maxChars! && evidence.length > 0) break;
    evidence.push({
      chapterId: 'role-evidence-pool',
      filePath: detail.file.relativePath,
      score: 1,
      content,
      sectionTitle: chunk.sectionTitle,
      source: 'role-node',
    });
    usedChars += content.length;
  }
  return { evidence, totalChunks, omittedChunks: Math.max(0, totalChunks - chunks.length) };
}

export function buildRoleEvidencePool(project: any, nodes: RoleExecutionNode[], projectRoot: string, maxCharsPerFile?: number): RoleEvidencePool {
  const files = new Map<string, DocumentEvidence[]>();
  const scoped = uniqueNodeFilePaths(nodes);
  let totalChunkCount = 0;
  let loadedChunkCount = 0;
  let omittedChunkCount = 0;
  for (const filePath of scoped.filePaths) {
    const key = evidencePoolKey(projectRoot, filePath);
    const detail = project.getFileDetail(filePath, Number.isFinite(maxCharsPerFile) && maxCharsPerFile! > 0 ? { maxChunkContentChars: maxCharsPerFile } : undefined);
    if (detail && detail.chunks.length > 0) {
      const loaded = evidenceFromProjectDetail(detail, maxCharsPerFile);
      files.set(key, loaded.evidence);
      totalChunkCount += loaded.totalChunks;
      loadedChunkCount += loaded.evidence.length;
      omittedChunkCount += loaded.omittedChunks;
      continue;
    }
    files.set(key, []);
  }
  return { files, uniqueFileCount: files.size, bindingCount: scoped.bindingCount, totalChunkCount, loadedChunkCount, omittedChunkCount };
}

export function evidenceForRoleFiles(pool: RoleEvidencePool, node: RoleExecutionNode, projectRoot: string): DocumentEvidence[] {
  const evidence: DocumentEvidence[] = [];
  for (const filePath of node.filePaths) {
    const fileEvidence = pool.files.get(evidencePoolKey(projectRoot, filePath)) || [];
    for (const item of fileEvidence) evidence.push({ ...item, chapterId: node.id, roleId: node.fileRoleId, processingType: node.processingType });
  }
  const maxItems = Math.max(8, Math.floor(Number(process.env.DOCUMENT_ROLE_EVIDENCE_MAX_ITEMS ?? 36)));
  const maxChars = Math.max(12000, Math.floor(Number(process.env.DOCUMENT_ROLE_EVIDENCE_MAX_CHARS ?? 42000)));
  return selectEvidenceByBudget(evidence, { maxItems, maxChars, preservePinned: true });
}

export function blockingChapterIssues(issues: string[]) {
  const blocking: string[] = [];
  for (const issue of issues) {
    BLOCKING_CHAPTER_ISSUE_RE.lastIndex = 0;
    if (BLOCKING_CHAPTER_ISSUE_RE.test(issue)) blocking.push(issue);
  }
  return blocking;
}

function groupFileBindingsByRole(bindings: FileBinding[]) {
  const byRole = new Map<string, string[]>();
  for (const binding of bindings) {
    const paths = byRole.get(binding.roleId) || [];
    paths.push(binding.filePath);
    byRole.set(binding.roleId, paths);
  }
  return byRole;
}

function promptsByRole(promptBindings: PromptBinding[]) {
  const prompts = new Map<string, string[]>();
  for (const prompt of readPromptContents(promptBindings)) {
    const contents = prompts.get(prompt.roleId) || [];
    contents.push(sanitizePromptForExecution(prompt.content));
    prompts.set(prompt.roleId, contents);
  }
  return prompts;
}

function eligiblePromptRoles(promptRoles: ReturnType<typeof listDocumentRoles>, loadedPromptRoles: Set<string>) {
  const roles: ReturnType<typeof listDocumentRoles> = [];
  for (const role of promptRoles) {
    if (!loadedPromptRoles.has(role.id)) continue;
    const executionType = role.executionType || 'reference';
    const isTemplatePlanningRole = /technical-review|review-standard|template|章节|目录|评审标准/u.test(`${role.id} ${role.name} ${role.description || ''}`);
    if (executionType === 'fact_extraction' || executionType === 'reference' || isTemplatePlanningRole) roles.push(role);
  }
  return roles;
}

function selectPromptMatches(role: ReturnType<typeof listDocumentRoles>[number], promptRoles: ReturnType<typeof listDocumentRoles>, promptMap: Map<string, string[]>) {
  const scored: Array<{ promptRole: ReturnType<typeof listDocumentRoles>[number]; texts: string[]; score: number }> = [];
  for (const promptRole of promptRoles) {
    const texts = promptMap.get(promptRole.id) || [];
    scored.push({ promptRole, texts, score: promptExecutionScore(promptRole.id, role, texts) });
  }
  scored.sort((a, b) => b.score - a.score);
  const matched = scored.filter(item => item.score > 5);
  if (matched.length > 0) return matched;
  const fallback = scored.find(item => {
    const type = item.promptRole.executionType || 'reference';
    return type === 'fact_extraction' || type === 'reference';
  });
  return fallback ? [fallback] : [];
}

function collectSelectedPromptFields(selected: Array<{ promptRole: ReturnType<typeof listDocumentRoles>[number]; texts: string[] }>) {
  const promptRoleIds: string[] = [];
  const promptRoleNames: string[] = [];
  const promptTexts: string[] = [];
  for (const item of selected) {
    promptRoleIds.push(item.promptRole.id);
    promptRoleNames.push(item.promptRole.name);
    for (const text of item.texts) promptTexts.push(text);
  }
  return { promptRoleIds, promptRoleNames, promptTexts };
}

export function buildRoleExecutionNodes(_template: DocumentTemplate, promptBindings: PromptBinding[], fileBindings: FileBinding[]): RoleExecutionNode[] {
  const fileRoles = listDocumentRoles('file');
  const promptRoles = listDocumentRoles('prompt');
  const byRole = groupFileBindingsByRole(fileBindings);
  const promptMap = promptsByRole(promptBindings);
  const orderedPromptRoles = eligiblePromptRoles(promptRoles, new Set(promptMap.keys()));
  const nodes: RoleExecutionNode[] = [];
  for (const role of fileRoles) {
    if (!byRole.has(role.id)) continue;
    const selected = selectPromptMatches(role, orderedPromptRoles, promptMap);
    const fields = collectSelectedPromptFields(selected);
    nodes.push({
      id: `node-${role.id}`,
      fileRoleId: role.id,
      fileRoleName: role.name,
      filePaths: byRole.get(role.id) || [],
      processingType: role.processingType,
      promptRoleIds: fields.promptRoleIds,
      promptRoleNames: fields.promptRoleNames,
      promptTexts: fields.promptTexts,
      outputType: inferRoleOutputType(role, fields.promptTexts),
    });
  }
  return nodes;
}


export function fallbackChaptersFromEvidence(template: DocumentTemplate, node: RoleExecutionNode, evidence: DocumentEvidence[]): TenderPlanChapter[] {
  if (node.outputType !== 'template_requirements') return [];
  const headings: TenderPlanChapter[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    const lines = item.content.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (!new RegExp(`^(?:第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]|[（(]?(?:\\d{1,3}|${CN_NUMERAL_RE})[)）、.．]|\\d+(?:\\.\\d+)*[、.．])`, 'u').test(line)) continue;
      const title = normalizeGeneratedChapterTitle(line);
      if (!isValidGeneratedChapterTitle(line) || seen.has(title) || violatesConfiguredChapterTitleFilter(title, template)) continue;
      seen.add(title);
      headings.push({
        id: safePlanId(title, `chapter-${headings.length + 1}`),
        title,
        order: headings.length,
        sourceRequirement: item.content.replace(/\s+/gu, ' '),
        requiredContents: [],
        writingRules: [],
        evidenceNeeds: [],
        minWords: 1200,
        requirements: [],
      });
    }
  }
  return headings;
}


export function roleExtractionNeedsRepair(llm?: RoleExtractionLlmResult) {
  if (!llm) return false;
  return (llm.chapters != null && !Array.isArray(llm.chapters)) || (llm.facts != null && !Array.isArray(llm.facts));
}

export function fallbackFactsFromEvidence(node: RoleExecutionNode, evidence: DocumentEvidence[]): RoleNodeFact[] {
  const facts: RoleNodeFact[] = [];
  for (const item of evidence) {
    const value = item.content.replace(/\s+/gu, ' ');
    if (value.length <= 20) continue;
    facts.push({
      key: `${node.fileRoleName}事实${facts.length + 1}`,
      value,
      sourceFile: item.filePath,
      roleId: node.fileRoleId,
      processingType: node.processingType,
      relatedChapterHints: item.sectionTitle ? [item.sectionTitle] : [],
    });
  }
  return facts;
}

export async function executeRoleExtractionNode(template: DocumentTemplate, node: RoleExecutionNode, evidence: DocumentEvidence[], signal?: AbortSignal): Promise<RoleNodeArtifact> {
  const promptText = node.promptTexts.join('\n\n') || '请读取绑定文件角色，抽取可用于文档生成的结构化信息。';
  const sample = evidenceBundlePrompt({
    chapterId: node.id,
    textEvidence: evidence,
    resources: [],
    byKind: { map: [], image: [], table: [], document: [], spreadsheet: [], text: [], attachment: [] },
    summary: '',
  }, { maxChars: evidencePromptBudgetForTarget(1800, 8000, 14000) });
  const extractionPrompt = `你正在执行一个“文件角色 × 提示词角色”的读取节点。\n节点类型：${node.outputType}\n文件角色：${node.fileRoleName}（${node.fileRoleId}）\n要求：严格按该节点绑定的提示词读取该文件角色的内容，不要读取其他角色。提示词角色只提供规则和格式约束，其中的示例、样例、占位项目名、编号、日期、数量和示例正文不得作为事实抽取来源。\n\n请返回 JSON，字段包括 chapters、facts、outputRequirements、forbidImageInsertion、warnings。chapters 只提取当前模板和规范包需要的正式章节；requirements 只保留可合并写入正文的核心要求，避免无依据地拆成过细子节点。facts 必须只来自下面的绑定文件片段，优先抽取对象、范围、区域、阶段、数量、日期、周期、规格、单位、资源数量、检查频次和来源口径；同类对象不得合并丢失，计量单位保持原文含义，必要时使用导出友好的正式写法。\n\n绑定文件片段：\n${sample}`;
  const warnings: string[] = [];
  throwIfAborted(signal);
  let llm = sample.trim() ? await callDocumentLlmJson<RoleExtractionLlmResult>(promptText, extractionPrompt, { signal }) : undefined;
  throwIfAborted(signal);
  if (roleExtractionNeedsRepair(llm)) {
    warnings.push(`${node.fileRoleName} 结构化读取返回格式异常，已尝试修复 JSON schema。`);
    const repaired = await callDocumentLlmJson<RoleExtractionLlmResult>(
      '你是 JSON schema 修复器。只根据输入 JSON 重新整理字段类型，不新增事实，不改写事实含义。',
      `请把下面 JSON 修复为严格结构：{"chapters":[],"facts":[],"outputRequirements":[],"warnings":[],"forbidImageInsertion":false}。chapters 和 facts 必须是数组；如果原值是对象，请转为数组；如果无法转换，使用空数组。只返回 JSON。\n\n原始 JSON：\n${JSON.stringify(llm)}`,
      { signal },
    );
    if (repaired && !roleExtractionNeedsRepair(repaired)) llm = repaired;
    else warnings.push(`${node.fileRoleName} 结构化读取修复失败，已降级使用证据片段生成。`);
  }
  const llmChapters = asObjectArray<RoleExtractionChapterInput>(llm?.chapters);
  const llmFacts = asObjectArray<RoleExtractionFactInput>(llm?.facts);
  const chapters: TenderPlanChapter[] = [];
  llmChapters.forEach((item, index) => {
    const title = typeof item.title === 'string' ? normalizeGeneratedChapterTitle(item.title) : '';
    if (!title || !isValidGeneratedChapterTitle(item.title || title) || violatesConfiguredChapterTitleFilter(title, template)) return;
    chapters.push({
      id: safePlanId(title, `chapter-${index + 1}`),
      title,
      order: index,
      sourceRequirement: item.sourceRequirement || title,
      requiredContents: asStringArray(item.requiredContents),
      writingRules: asStringArray(item.writingRules),
      evidenceNeeds: asStringArray(item.evidenceNeeds),
      minWords: Math.max(800, Math.min(3500, Number(item.minWords) || 1200)),
      requirements: asObjectArray<RoleExtractionRequirementInput>(item.requirements).map((requirement, reqIndex) => ({
        id: safePlanId(`${title}-${requirement.title || reqIndex + 1}`, `req-${index + 1}-${reqIndex + 1}`),
        title: requirement.title || `要求 ${reqIndex + 1}`,
        requirementText: requirement.requirementText || requirement.title || '',
        requiredContents: asStringArray(requirement.requiredContents),
        writingRules: asStringArray(requirement.writingRules),
        evidenceNeeds: asStringArray(requirement.evidenceNeeds),
        preferredSourceRoleIds: asStringArray(requirement.preferredSourceRoleIds),
      })),
    });
  });
  const facts: RoleNodeFact[] = [];
  const evidenceFiles = new Set(evidence.map(item => item.filePath));
  llmFacts.forEach(item => {
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    const sourceFile = item.sourceFile && evidenceFiles.has(item.sourceFile) ? item.sourceFile : evidence.find(e => e.filePath)?.filePath || '';
    if (!key || item.value == null || !sourceFile || !evidenceFiles.has(sourceFile)) return;
    facts.push({
      key,
      value: cleanEvidenceText(stringifyFactValue(item.value)),
      sourceFile,
      roleId: node.fileRoleId,
      processingType: node.processingType,
      relatedChapterHints: asStringArray(item.relatedChapterHints),
    });
  });
  const fallbackChapters = chapters.length > 0 ? [] : fallbackChaptersFromEvidence(template, node, evidence);
  const fallbackFacts = facts.length > 0 ? [] : fallbackFactsFromEvidence(node, evidence);
  if (chapters.length === 0 && fallbackChapters.length > 0) warnings.push(`${node.fileRoleName} 结构化章节读取不足，已补充使用证据标题兜底。`);
  if (facts.length === 0 && fallbackFacts.length > 0) warnings.push(`${node.fileRoleName} 结构化事实读取不足，已补充使用证据片段兜底。`);
  const artifactEvidence = uniqueEvidence(evidence, undefined);
  return {
    node,
    evidence: artifactEvidence,
    chapters: chapters.length > 0 ? chapters : fallbackChapters,
    facts: facts.length > 0 ? facts : fallbackFacts,
    outputRequirements: asStringArray(llm?.outputRequirements),
    warnings: [...warnings, ...asStringArray(llm?.warnings)],
    forbidImageInsertion: llm?.forbidImageInsertion ?? node.outputType === 'drawing_facts',
  };
}

function formatArtifactDigest(artifact: RoleNodeArtifact) {
  const lines = [`## ${artifact.node.fileRoleName} / ${artifact.node.outputType}`];
  const chapterLimit = Math.max(8, Math.min(24, Number(process.env.DOCUMENT_ROLE_DIGEST_CHAPTER_LIMIT ?? 18)));
  const factLimit = Math.max(16, Math.min(60, Number(process.env.DOCUMENT_ROLE_DIGEST_FACT_LIMIT ?? 30)));
  const chapterLines: string[] = [];
  for (const chapter of artifact.chapters.slice(0, chapterLimit)) chapterLines.push(`- ${chapter.title}：${(chapter.requiredContents.join('、') || chapter.sourceRequirement).slice(0, 180)}`);
  if (chapterLines.length > 0) lines.push(`章节/要求：\n${chapterLines.join('\n')}`);
  const factLines: string[] = [];
  for (const fact of artifact.facts.slice(0, factLimit)) factLines.push(`- ${fact.key}：${stringifyFactValue(fact.value).slice(0, 260)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`);
  if (factLines.length > 0) lines.push(`事实：\n${factLines.join('\n')}`);
  if (artifact.outputRequirements.length > 0) lines.push(`输出要求：${artifact.outputRequirements.join('；')}`);
  return lines.join('\n');
}

export function roleArtifactsDigest(artifacts: RoleNodeArtifact[]) {
  const artifactLimit = Math.max(4, Math.min(12, Number(process.env.DOCUMENT_ROLE_DIGEST_ARTIFACT_LIMIT ?? 8)));
  return artifacts.slice(0, artifactLimit).map(artifact => formatArtifactDigest(artifact)).join('\n\n');
}

export function tenderPlanChaptersFromArtifacts(template: DocumentTemplate, artifacts: RoleNodeArtifact[]): TenderPlanChapter[] {
  const chapters: TenderPlanChapter[] = [];
  for (const artifact of artifacts) {
    if (artifact.node.outputType !== 'template_requirements') continue;
    for (const chapter of artifact.chapters) chapters.push(chapter);
  }
  chapters.sort((a, b) => a.order - b.order);
  const byTitle = new Map<string, TenderPlanChapter>();
  for (const chapter of chapters) {
    const title = normalizeGeneratedChapterTitle(chapter.title);
    if (!isValidGeneratedChapterTitle(chapter.title) || violatesConfiguredChapterTitleFilter(title, template)) continue;
    if (!byTitle.has(title)) byTitle.set(title, { ...chapter, title });
  }
  return [...byTitle.values()];
}


export function chapterPlanFor(chapter: DocumentTemplateChapter, plan: TenderPlanChapter[]) {
  return plan.find(item => item.id === chapter.id || item.title === chapter.title);
}

function chapterFactHints(chapter: DocumentTemplateChapter, plan?: TenderPlanChapter) {
  const hints: string[] = [chapter.title];
  for (const item of chapter.requiredFacts || []) if (item) hints.push(item);
  for (const item of plan?.requiredContents || []) if (item) hints.push(item);
  for (const item of plan?.evidenceNeeds || []) if (item) hints.push(item);
  for (const requirement of plan?.requirements || []) {
    if (requirement.title) hints.push(requirement.title);
    for (const item of requirement.requiredContents) if (item) hints.push(item);
    for (const item of requirement.evidenceNeeds) if (item) hints.push(item);
  }
  return hints;
}

function factMatchesHints(fact: RoleNodeFact, hints: string[]) {
  if (hints.length === 0) return true;
  const text = `${fact.key}\n${stringifyFactValue(fact.value)}\n${fact.relatedChapterHints.join('\n')}`;
  for (const hint of hints) {
    if (text.includes(hint) || hint.includes(fact.key)) return true;
  }
  return false;
}

export function roleFactsForChapter(artifacts: RoleNodeArtifact[], chapter: DocumentTemplateChapter, plan?: TenderPlanChapter) {
  const hints = chapterFactHints(chapter, plan);
  const matched: Array<{ artifact: RoleNodeArtifact; fact: RoleNodeFact }> = [];
  const maxFacts = Math.max(40, Math.min(120, Number(process.env.DOCUMENT_ROLE_FACTS_PER_CHAPTER ?? 80)));
  for (const artifact of artifacts) {
    for (const fact of artifact.facts) {
      if (!factMatchesHints(fact, hints)) continue;
      matched.push({ artifact, fact });
      if (matched.length >= maxFacts) return matched;
    }
  }
  return matched;
}

export function buildRoleChapterContext(artifacts: RoleNodeArtifact[], chapter: DocumentTemplateChapter, plan?: TenderPlanChapter) {
  const matchedFacts = roleFactsForChapter(artifacts, chapter, plan);
  const planText = plan ? [
    `章节来源要求：${plan.sourceRequirement}`,
    plan.requiredContents.length ? `必须包含：${plan.requiredContents.join('、')}` : '',
    plan.writingRules.length ? `写作规范：${plan.writingRules.join('、')}` : '',
    plan.evidenceNeeds.length ? `需要证据：${plan.evidenceNeeds.join('、')}` : '',
    plan.requirements.length ? `要求项：\n${plan.requirements.map(item => `- ${item.title}：${item.requirementText || item.requiredContents.join('、')}`).join('\n')}` : '',
  ].filter(Boolean).join('\n') : '';
  const factGroups = new Map<string, string[]>();
  for (const { artifact, fact } of matchedFacts) {
    const key = `${artifact.node.fileRoleName}（${artifact.node.outputType}）`;
    factGroups.set(key, [...(factGroups.get(key) || []), `- ${fact.key}：${cleanEvidenceText(stringifyFactValue(fact.value))}`]);
  }
  const maxGroupLines = Math.max(8, Math.min(24, Number(process.env.DOCUMENT_ROLE_FACT_LINES_PER_GROUP ?? 18)));
  const factsText = [...factGroups.entries()].map(([key, lines]) => `### ${key}\n${lines.slice(0, maxGroupLines).map(line => line.replace(FILE_NAME_RE, '').replace(CAD_ENTITY_TOKEN_RE, '').slice(0, 320)).join('\n')}`).join('\n\n');
  return [planText ? `【本章章节计划】\n${planText}` : '', factsText ? `【角色节点结构化产物】\n${factsText}` : ''].filter(Boolean).join('\n\n');
}

export function shouldForbidDrawingImages(artifacts: RoleNodeArtifact[], _template: DocumentTemplate) {
  return artifacts.some(item => item.forbidImageInsertion || item.node.outputType === 'drawing_facts');
}

export function repairableQualityIssue(issue: string) {
  REPAIRABLE_QUALITY_ISSUE_RE.lastIndex = 0;
  return REPAIRABLE_QUALITY_ISSUE_RE.test(issue);
}

export function lightweightChapterIssues(input: { chapter: DocumentTemplateChapter; content: string; missingFacts: string[]; targetWords: number }) {
  const issues: string[] = [];
  if (!new RegExp(`^##\\s+${input.chapter.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'mu').test(input.content)) issues.push('正文缺少章节标题');
  for (const degenerateIssue of degenerateContentIssues(input.content, [{ id: input.chapter.id, title: input.chapter.title, content: input.content, evidence: [], sections: input.chapter.sections || [], missingFacts: [] }])) {
    issues.push(degenerateIssue.message);
  }
  for (const section of input.chapter.sections || []) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = input.content.match(new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*[.．、]?\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^###\\s+|^##\\s+|$)`, 'mu'));
    if (!match) issues.push(`缺少规划小节：${section}`);
    else if (documentTextLength(match[1]) < 180) issues.push(`规划小节正文过短：${section}`);
  }
  if (documentTextLength(input.content) < Math.floor(input.targetWords * 0.85)) issues.push('正文篇幅明显低于目标');
  WORKFLOW_PHRASE_RE.lastIndex = 0;
  if (WORKFLOW_PHRASE_RE.test(input.content) || /知识库|检索|角色节点|事实字段|校验结果/u.test(input.content)) issues.push('正文包含后台流程话术');
  if (/资料未提供|满足相关要求|结合实际情况|根据实际情况|视情况|待明确|待确认/u.test(input.content)) issues.push('正文存在空泛占位表达');
  for (const fact of input.missingFacts.slice(0, 8)) {
    if (fact && !input.content.includes(fact)) issues.push(`requiredFacts 未明显覆盖：${fact}`);
  }
  return [...new Set(issues)].slice(0, 12);
}

export function issuesForChapter(chapter: DocumentDraftChapter, issues: string[]) {
  const actionableIssues = issues.filter(repairableQualityIssue);
  const sectionHits = new Set(chapter.sections || []);
  const text = `${chapter.title}\n${chapter.sections?.join('\n') || ''}\n${chapter.content.slice(0, 8000)}`;
  return actionableIssues
    .filter(issue => issue.includes(chapter.title) || [...sectionHits].some(section => issue.includes(section)) || /图片|三级小节|目录|表格|量化|数值|单位|事实/u.test(issue) && /!\[|####|\*\*|\||m\s*[²2]|mm2|cm2|km2/u.test(text))
    .slice(0, 6);
}

export function classifyQualityRepairType(issues: string[]): QualityRepairType {
  const text = issues.join('\n');
  for (const rule of QUALITY_REPAIR_TYPE_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) return rule.type;
  }
  return 'generic';
}

export function repairTypeInstruction(type: QualityRepairType) {
  return QUALITY_REPAIR_INSTRUCTIONS[type] || QUALITY_REPAIR_INSTRUCTIONS.generic;
}

interface ChapterMarkdownPatch {
  originalText?: string;
  targetStart?: string;
  targetEnd?: string;
  replacement?: string;
  reason?: string;
}

function uniqueTextRange(content: string, patch: ChapterMarkdownPatch) {
  const originalText = patch.originalText?.trim();
  if (originalText && content.indexOf(originalText) === content.lastIndexOf(originalText)) return originalText;
  const targetStart = patch.targetStart?.trim();
  const targetEnd = patch.targetEnd?.trim();
  if (!targetStart || !targetEnd) return undefined;
  const startIndex = content.indexOf(targetStart);
  const endIndex = content.indexOf(targetEnd, startIndex + targetStart.length);
  if (startIndex < 0 || endIndex < 0) return undefined;
  const endOffset = endIndex + targetEnd.length;
  const range = content.slice(startIndex, endOffset);
  return content.indexOf(range) === content.lastIndexOf(range) ? range : undefined;
}

function patchLengthBudget(content: string) {
  return Math.max(2600, Math.min(16000, Math.ceil(documentTextLength(content) * 0.45)));
}

function markdownStructureValid(content: string, title: string) {
  const codeFenceCount = (content.match(/```/gu) || []).length;
  const normalizedTitle = title.replace(/^第[一二三四五六七八九十百千万]+章\s*/u, '').trim();
  return codeFenceCount % 2 === 0 && (!normalizedTitle || content.includes(normalizedTitle)) && !/^\s*$/u.test(content);
}

function applyChapterPatch(input: { content: string; patch: ChapterMarkdownPatch; title: string; forbidDrawingImages: boolean }) {
  const replacement = input.patch.replacement?.trim();
  const budget = patchLengthBudget(input.content);
  if (!replacement || replacement.length > budget) return { content: input.content, applied: false };
  if (input.forbidDrawingImages && /!\[[^\]]*\]\([^)]*\)/iu.test(replacement)) return { content: input.content, applied: false };
  const range = uniqueTextRange(input.content, input.patch);
  if (!range || range.length > budget) return { content: input.content, applied: false };
  const next = sanitizeFormalMarkdown(removeUnwantedDrawingImages(input.content.replace(range, replacement), input.forbidDrawingImages));
  if (!markdownStructureValid(next, input.title)) return { content: input.content, applied: false };
  if (documentTextLength(next) < Math.floor(documentTextLength(input.content) * 0.65)) return { content: input.content, applied: false };
  return { content: next, applied: next !== input.content };
}

export async function repairChapterByQuality(input: { template: DocumentTemplate; chapter: DocumentDraftChapter; issues: string[]; promptTexts: string; requirement?: string; forbidDrawingImages: boolean; repairType?: QualityRepairType; diagnostics?: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  throwIfAborted(input.signal);
  const repairType = input.repairType || classifyQualityRepairType(input.issues);
  const result = await callDocumentLlmJson<{ patches?: ChapterMarkdownPatch[] }>([
    '你是章节局部修复专家。只返回 JSON patch，不返回完整章节，不重写无问题内容。',
    repairTypeInstruction(repairType),
    FORMAL_WRITING_RULES,
    input.forbidDrawingImages ? '图片类资料只作为文本事实来源，禁止插入图片或 Markdown 图片语法。' : '',
    '每个 patch 必须能通过 originalText 或 targetStart/targetEnd 在原章节中唯一定位；replacement 只替换该局部片段。',
    '只修复列出的问题，不得整章重写，不得删除无问题小节，不得改变一级/二级章节结构。',
    '如问题涉及缺少正式表格，replacement 必须包含 Markdown 表名、表头、分隔线和至少一行数据；不得只写“见下表”或空表。',
    '如问题涉及提示词要求的关键词或禁用内容，只在相关段落自然补齐或替换，不得堆砌关键词。',
    '禁止新增证据摘要中没有的信息；无法安全定位的问题不要生成 patch。',
    '返回 JSON：{"patches":[{"originalText":"原局部文本","targetStart":"定位起始文本","targetEnd":"定位结束文本","replacement":"替换后的局部文本","reason":"修复原因"}]}',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    `章节：${input.chapter.title}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    `需要局部修复的问题：\n${input.issues.map(item => `- ${item}`).join('\n')}`,
    input.chapter.evidence.length ? `本章证据摘要：\n${evidenceBundlePrompt(buildEvidenceBundle({ id: input.chapter.id, title: input.chapter.title, purpose: input.chapter.title, queries: [], requiredFacts: [] }, input.chapter.evidence), { maxChars: evidencePromptBudgetForTarget(documentTextLength(input.chapter.content), 5000, 14000) })}` : '',
    '当前章节 Markdown：',
    input.chapter.content,
  ].filter(Boolean).join('\n\n'), { maxTokens: 2200, temperature: 0, signal: input.signal, diagnostics: input.diagnostics });
  throwIfAborted(input.signal);
  let content = input.chapter.content;
  let appliedCount = 0;
  const patches = Array.isArray(result?.patches) ? result!.patches! : [];
  for (const patch of patches) {
    const applied = applyChapterPatch({ content, patch, title: input.chapter.title, forbidDrawingImages: input.forbidDrawingImages });
    content = applied.content;
    if (applied.applied) appliedCount += 1;
  }
  return { content, appliedCount, repairType };
}

export async function repairMarkdownByQuality(input: { markdown: string; template: DocumentTemplate; chapters: DocumentDraftChapter[]; promptTexts: string; requirement?: string; issues: string[]; forbidDrawingImages: boolean; strategy?: DocumentGenerationStrategy; diagnostics?: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  const repairableIssues = input.issues.filter(issue => classifyQualitySeverity(issue) !== 'minor').filter(repairableQualityIssue);
  if (repairableIssues.length === 0) return { markdown: input.markdown, chapters: input.chapters, stage: undefined as DocumentExecutionStage | undefined };
  const candidates = input.chapters
    .map(chapter => ({ chapter, issues: issuesForChapter(chapter, repairableIssues) }))
    .filter(item => item.issues.length > 0);
  if (candidates.length === 0) {
    return {
      markdown: input.markdown,
      chapters: input.chapters,
      stage: { type: 'llm_review' as const, roleId: 'quality-repair', status: 'success' as const, message: `已完成质量检查，未定位到可安全局部修复的阻断问题：共 ${repairableIssues.length} 个；${repairableIssues.slice(0, 8).join('；')}` },
    };
  }
  const concurrency = Math.max(1, candidates.length || 1);
  const repairedById = new Map<string, string>();
  let patchCount = 0;
  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    throwIfAborted(input.signal);
    const batch = candidates.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async item => repairChapterByQuality({ template: input.template, chapter: item.chapter, issues: item.issues, promptTexts: input.promptTexts, requirement: input.requirement, forbidDrawingImages: input.forbidDrawingImages, diagnostics: input.diagnostics, signal: input.signal })));
    results.forEach((result, index) => {
      repairedById.set(batch[index].chapter.id, result.content);
      patchCount += result.appliedCount;
    });
  }
  let repairedCount = 0;
  const repairedChapters = input.chapters.map(chapter => {
    const content = repairedById.get(chapter.id);
    if (!content || content === chapter.content) return chapter;
    repairedCount += 1;
    return { ...chapter, content };
  });
  const message = repairedCount > 0
    ? `已应用 ${patchCount} 个局部质量 patch，修复 ${repairedCount} 个章节；未进行整章或全文重写`
    : `已完成质量检查，未生成可唯一定位且通过校验的局部 patch：共 ${repairableIssues.length} 个；${repairableIssues.slice(0, 8).join('；')}`;
  return {
    markdown: input.markdown,
    chapters: repairedChapters,
    stage: { type: 'llm_review' as const, roleId: 'quality-repair', status: 'success' as const, message },
  };
}

/** 从证据中抽取事实字段，按规范包中的事实定义进行匹配 */


export function fileScopeKeys(projectRoot: string, filePath: string) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  const relativePath = path.isAbsolute(filePath) ? path.relative(projectRoot, filePath) : filePath;
  return [filePath, absolutePath, relativePath, path.join(projectRoot, relativePath)];
}

export function evidenceProjectPath(projectRoot: string, filePath: string) {
  const normalizedRoot = path.resolve(projectRoot);
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  const kbPath = path.resolve(normalizedRoot, 'knowledgeBase', filePath);
  if (fs.existsSync(kbPath)) return kbPath;
  return path.resolve(normalizedRoot, filePath);
}

export function evidenceInCurrentProject(projectRoot: string, filePath: string) {
  const normalizedRoot = path.resolve(projectRoot);
  const absolute = evidenceProjectPath(normalizedRoot, filePath);
  return absolute === normalizedRoot || absolute.startsWith(`${normalizedRoot}${path.sep}`);
}

export function evidenceInScope(projectRoot: string, filePath: string, scopePaths: Set<string>) {
  return evidenceInCurrentProject(projectRoot, filePath) && scopePaths.size > 0 && fileScopeKeys(projectRoot, filePath).some(key => scopePaths.has(key));
}

export function buildBoundEvidenceScope(projectRoot: string, bindings: FileBinding[]) {
  return new Set(bindings.flatMap(binding => fileScopeKeys(projectRoot, binding.filePath)));
}

function preservePromptCodeBlock(block: string) {
  return /<OUTLINE>|\|\s*[^\n]+\s*\||#{1,6}\s+|必须|禁止|不得|应当|要求|规则|格式|输出|表格|章节|小节|正文/u.test(block);
}

export function sanitizePromptForExecution(content: string) {
  const normalized = content.replace(/```([\s\S]*?)```/gu, (_match, block: string) => preservePromptCodeBlock(block) ? `\n${block.trim()}\n` : '\n【示例代码块已省略：仅作为格式参考，不作为当前文档事实】\n');
  const lines = normalized.split(/\r?\n/u);
  const result: string[] = [];
  let skippingExample = false;
  let inOutline = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (isExplicitOutlineOpeningLine(trimmed)) inOutline = true;
    if (inOutline) {
      result.push(line);
      if (isExplicitOutlineClosingLine(trimmed)) inOutline = false;
      continue;
    }
    const startsExample = /^(?:#+\s*)?(?:示例|样例|范例|例如|参考示例|示例数据|示例正文|示例目录|example|sample)\s*[:：]?/iu.test(trimmed);
    const startsRule = /(?:不得|禁止|必须|应当|要求|规则|格式|输出|保留|只返回|不要|表格|章节|小节|正文|目录|封面)/u.test(trimmed);
    if (startsExample && !startsRule) {
      if (!result.at(-1)?.includes('示例内容已省略')) result.push('【示例内容已省略：仅作为格式参考，不作为当前文档事实】');
      skippingExample = true;
      continue;
    }
    if (skippingExample) {
      if (!trimmed) {
        skippingExample = false;
        continue;
      }
      if (/^(?:#+\s*)?(?:规则|要求|输出|格式|禁止|注意|正文|章节|小节|表格|风格|校验)/u.test(trimmed) || /\|\s*[^\n]+\s*\|/u.test(trimmed)) skippingExample = false;
      else continue;
    }
    result.push(line);
  }
  return result.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function promptRoleExecutionTypes() {
  const roleTypes = new Map<string, string>();
  for (const type of ['fact_extraction', 'chapter_generation', 'llm_review', 'validation', 'formatting', 'reference']) roleTypes.set(type, type);
  for (const role of listDocumentRoles('prompt')) roleTypes.set(role.id, role.executionType || 'reference');
  return roleTypes;
}

export function promptTextsForResolvedPrompts(prompts: ResolvedPromptContent[]) {
  return prompts.map(prompt => `## [${prompt.roleId}/${prompt.category}] ${prompt.name}\n${sanitizePromptForExecution(prompt.content)}`).join('\n\n');
}

export function promptTextsForExecution(promptBindings: PromptBinding[], executionTypes: string[]) {
  const roleTypes = promptRoleExecutionTypes();
  const allowed = new Set(executionTypes);
  const blocks: string[] = [];
  for (const prompt of readPromptContents(promptBindings)) {
    if (!allowed.has(roleTypes.get(prompt.roleId) || 'reference')) continue;
    blocks.push(`## [${prompt.roleId}] ${prompt.name}\n${sanitizePromptForExecution(prompt.content)}`);
  }
  return blocks.join('\n\n');
}

export function promptOutlineTextsForExecution(promptBindings: PromptBinding[]) {
  const blocks: string[] = [];
  for (const prompt of readPromptContents(promptBindings)) {
    if (!hasExplicitOutlineBlock(prompt.content)) continue;
    blocks.push(`## [${prompt.roleId}] ${prompt.name}\n${prompt.content}`);
  }
  return blocks.join('\n\n');
}
