import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { computeProjectId } from '@customize-agent/knowledge';
import type { getMultiProjectManager } from '../knowledge/kbService';
import { BLOCKING_CHAPTER_CACHE_ISSUE_RE, DOCUMENT_CACHE_TTL_MS, PROJECT_BASIC_FACT_FIELDS, PROMPT_EXECUTION_SCORE_RULES, QUALITY_REPAIR_INSTRUCTIONS, QUALITY_REPAIR_TYPE_RULES, REPAIRABLE_QUALITY_ISSUE_RE, ROLE_OUTPUT_TYPE_RULES } from '../constants';
import { listDocumentRoles } from '../document-core/documentRoleService';
import type { KbSearchResult } from '@/lib/api';
import type { ChapterDraftCacheValue, ProjectBasicFact, PromptIntentProfile, QualityRepairType, RoleEvidencePool, RoleExecutionNode, RoleExtractionChapterInput, RoleExtractionFactInput, RoleExtractionLlmResult, RoleExtractionRequirementInput, RoleNodeArtifact, RoleNodeFact, SectionDraftCacheValue, TenderPlanChapter } from '../types';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentGenerationStrategy, DocumentTemplate, DocumentTemplateChapter, FileBinding, PromptBinding } from './types';

export type { ProjectBasicFact, PromptIntentProfile, QualityRepairType, RoleEvidencePool, RoleExecutionNode, RoleExtractionChapterInput, RoleExtractionFactInput, RoleExtractionLlmResult, RoleExtractionRequirementInput, RoleNodeArtifact, RoleNodeFact, TenderPlanChapter } from '../types';
import { readPromptContents, violatesConfiguredChapterTitleFilter } from './templateStore';
import { buildEvidenceBundle, cleanEvidenceText, evidenceBundlePrompt, uniqueEvidence } from './evidence';
import { hasExplicitOutlineBlock, isExplicitOutlineClosingLine, isExplicitOutlineOpeningLine, isValidGeneratedChapterTitle, normalizeGeneratedChapterTitle } from './outline';
import { CAD_ENTITY_TOKEN_RE, CN_NUMERAL_RE, FILE_NAME_RE, MAX_DOCUMENT_CACHE_ITEMS, MAX_FALLBACK_CHAPTERS } from './constants';
import { FORMAL_WRITING_RULES, WORKFLOW_PHRASE_RE, removeUnwantedDrawingImages, sanitizeFormalMarkdown } from './markdownComposer';
import { documentTextLength } from './budget';
import { classifyQualitySeverity, degenerateContentIssues } from './qualityValidation';
import { callDocumentLlm, callDocumentLlmJson, getAdaptiveDocumentLlmLimit } from './llmClient';
import { asObjectArray, asStringArray, safePlanId, setLimitedCache, stableHash, stringifyFactValue, throwIfAborted } from './utils';

const ROLE_ARTIFACT_CACHE = new Map<string, RoleNodeArtifact>();
const CHAPTER_SEARCH_CACHE = new Map<string, KbSearchResult[]>();

const CHAPTER_DRAFT_CACHE = new Map<string, ChapterDraftCacheValue>();
const SECTION_DRAFT_CACHE = new Map<string, SectionDraftCacheValue>();


export function selectDocumentGenerationStrategy(input: { template: DocumentTemplate; targetWords: number; requirement?: string }): DocumentGenerationStrategy {
  const chapterCount = input.template.chapters.length;
  const avgChapterTarget = chapterCount > 0 ? input.targetWords / chapterCount : input.targetWords;
  const text = `${input.template.name}\n${input.template.category || ''}\n${input.requirement || ''}`;
  const strict = /专项|安全|质量|验收|审核|合同|合规|审计|风控|风险/u.test(text);
  const longform = input.targetWords >= 30000 || chapterCount >= 8 || avgChapterTarget >= 4000;
  const compact = input.targetWords <= 6000 && chapterCount <= 4 && !strict;
  const mode: DocumentGenerationStrategy['mode'] = strict ? 'strict' : longform ? 'longform' : compact ? 'fast' : 'balanced';
  const targetLlmConcurrency = Number(process.env.DOCUMENT_TARGET_LLM_CONCURRENCY ?? 0);
  const maxChapterConcurrency = Math.max(1, Math.floor(Number(process.env.DOCUMENT_CHAPTER_CONCURRENCY ?? chapterCount)));
  const maxSectionConcurrency = Math.max(1, Math.floor(Number(process.env.DOCUMENT_SECTION_CONCURRENCY ?? 999)));
  const maxChapterReviewConcurrency = Math.max(1, Math.floor(Number(process.env.DOCUMENT_CHAPTER_REVIEW_CONCURRENCY ?? chapterCount)));
  return {
    mode,
    enableChapterCache: true,
    enableChapterReview: true,
    enableGlobalReview: true,
    enableDocumentBudgetExpansion: true,
    enableFinalQualityReview: true,
    maxChapterConcurrency,
    maxSectionConcurrency,
    maxChapterReviewConcurrency,
    targetLlmConcurrency,
  };
}

export function createGenerationDiagnostics(strategy: DocumentGenerationStrategy): DocumentGenerationDiagnostics {
  return {
    strategy,
    metrics: [],
    cache: { chapterHits: 0, chapterMisses: 0, chapterWrites: 0, sectionHits: 0, sectionMisses: 0, sectionWrites: 0, prunedItems: 0, rejectedHits: 0 },
    llm: { calls: 0, failures: 0, throttledWaits: 0, throttledWaitMs: 0, maxActive: 0, currentLimit: getAdaptiveDocumentLlmLimit(), limitAdjustments: 0 },
    evidence: { raw: 0, used: 0, filteredNoise: 0, avgNoiseScore: 0, avgFactDensity: 0, searchQueries: 0, searchMs: 0, contextChars: 0 },
    quality: { blockingCount: 0, importantCount: 0, minorCount: 0, repairedCount: 0, reusedChapterCount: 0, reusedSectionCount: 0 },
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

export function pruneChapterDraftCache(diagnostics?: DocumentGenerationDiagnostics) {
  const now = Date.now();
  let pruned = 0;
  for (const [key, item] of CHAPTER_DRAFT_CACHE.entries()) {
    if (now - item.updatedAt > DOCUMENT_CACHE_TTL_MS) {
      CHAPTER_DRAFT_CACHE.delete(key);
      pruned += 1;
    }
  }
  while (CHAPTER_DRAFT_CACHE.size > MAX_DOCUMENT_CACHE_ITEMS) {
    const oldest = [...CHAPTER_DRAFT_CACHE.entries()].sort((a, b) => (a[1].updatedAt + a[1].hits * 60000) - (b[1].updatedAt + b[1].hits * 60000))[0]?.[0];
    if (!oldest) break;
    CHAPTER_DRAFT_CACHE.delete(oldest);
    pruned += 1;
  }
  if (diagnostics) diagnostics.cache.prunedItems += pruned;
}

export function persistentCacheEnabled() {
  return process.env.DOCUMENT_PERSISTENT_FACT_CACHE !== '0';
}

export function persistentDocumentCachePath(projectRoot: string, kind: string, key: string) {
  return path.join(os.homedir(), '.customize-agent', 'document-cache', stableHash(projectRoot), kind, `${key}.json`);
}

export function readPersistentJson<T>(projectRoot: string, kind: string, key: string): T | undefined {
  if (!persistentCacheEnabled()) return undefined;
  try {
    const filePath = persistentDocumentCachePath(projectRoot, kind, key);
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function writePersistentJson(projectRoot: string, kind: string, key: string, value: unknown) {
  if (!persistentCacheEnabled()) return;
  try {
    const filePath = persistentDocumentCachePath(projectRoot, kind, key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value));
  } catch {
    // 持久化缓存仅用于提速，失败不影响生成主流程。
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

function chunkHashes(chunks: Array<{ content: string; sectionTitle?: string }>, limit = 200) {
  const hashes: string[] = [];
  for (const chunk of chunks) {
    hashes.push(stableHash(`${chunk.sectionTitle || ''}\n${chunk.content}`));
    if (hashes.length >= limit) break;
  }
  return hashes;
}

export function projectEvidenceVersionHash(project: any, projectRoot: string, scopePaths: Set<string>) {
  const entries: Array<Record<string, unknown>> = [];
  for (const filePath of [...scopePaths].sort()) {
    const detail = project.getFileDetail(filePath) || project.getFileDetail(path.join(projectRoot, filePath));
    if (!detail) {
      entries.push({ filePath, missing: true });
      continue;
    }
    entries.push({ filePath: detail.file?.relativePath || filePath, chunkCount: detail.chunks?.length || 0, chunks: chunkHashes(detail.chunks || []) });
  }
  return stableHash({ type: 'project-evidence-version-v1', entries });
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

function evidenceFromProjectDetail(detail: any) {
  const evidence: DocumentEvidence[] = [];
  for (const chunk of (detail.chunks || []).slice(0, 120) as Array<{ content: string; sectionTitle?: string }>) {
    evidence.push({
      chapterId: 'role-evidence-pool',
      filePath: detail.file.relativePath,
      score: 1,
      content: chunk.content,
      sectionTitle: chunk.sectionTitle,
      source: 'role-node',
    });
  }
  return evidence;
}

export function buildRoleEvidencePool(project: any, nodes: RoleExecutionNode[], projectRoot: string): RoleEvidencePool {
  const files = new Map<string, DocumentEvidence[]>();
  const scoped = uniqueNodeFilePaths(nodes);
  for (const filePath of scoped.filePaths) {
    const key = evidencePoolKey(projectRoot, filePath);
    const detail = project.getFileDetail(filePath);
    if (detail && detail.chunks.length > 0) {
      files.set(key, evidenceFromProjectDetail(detail));
      continue;
    }
    files.set(key, []);
  }
  return { files, uniqueFileCount: files.size, bindingCount: scoped.bindingCount };
}

export function evidenceForRoleFiles(pool: RoleEvidencePool, node: RoleExecutionNode, projectRoot: string): DocumentEvidence[] {
  const evidence: DocumentEvidence[] = [];
  for (const filePath of node.filePaths) {
    const fileEvidence = pool.files.get(evidencePoolKey(projectRoot, filePath)) || [];
    for (const item of fileEvidence) evidence.push({ ...item, chapterId: node.id, roleId: node.fileRoleId, processingType: node.processingType });
  }
  return uniqueEvidence(evidence, 120);
}

export function roleArtifactCacheKey(input: { template: DocumentTemplate; node: RoleExecutionNode; evidence: DocumentEvidence[]; promptTexts: string; projectRoot: string; modelName?: string }) {
  return stableHash({
    type: 'role-artifact-v1',
    projectRoot: input.projectRoot,
    projectId: computeProjectId(input.projectRoot),
    templateId: input.template.id,
    templateName: input.template.name,
    node: {
      id: input.node.id,
      fileRoleId: input.node.fileRoleId,
      promptRoleIds: input.node.promptRoleIds,
      filePaths: input.node.filePaths,
      outputType: input.node.outputType,
    },
    promptTexts: input.promptTexts,
    modelName: input.modelName,
    evidence: input.evidence.map(item => ({ filePath: item.filePath, sectionTitle: item.sectionTitle, contentHash: stableHash(item.content) })),
  });
}

export async function executeRoleExtractionNodeCached(input: { template: DocumentTemplate; node: RoleExecutionNode; evidence: DocumentEvidence[]; promptTexts: string; projectRoot: string; modelName?: string; signal?: AbortSignal }) {
  throwIfAborted(input.signal);
  const key = roleArtifactCacheKey(input);
  const cached = ROLE_ARTIFACT_CACHE.get(key);
  if (cached) return { artifact: cached, cached: true };
  const artifact = await executeRoleExtractionNode(input.template, input.node, input.evidence, input.signal);
  throwIfAborted(input.signal);
  setLimitedCache(ROLE_ARTIFACT_CACHE, key, artifact);
  return { artifact, cached: false };
}

export function chapterSearchCacheKey(input: { projectRoot: string; query: string; evidenceScopePaths: Set<string>; maxEvidence: number; fileRolesHash: string; generationMode?: boolean }) {
  return stableHash({
    type: 'chapter-search-v2',
    projectRoot: input.projectRoot,
    projectId: computeProjectId(input.projectRoot),
    query: input.query,
    maxEvidence: input.maxEvidence,
    fileRolesHash: input.fileRolesHash,
    generationMode: Boolean(input.generationMode),
    scope: [...input.evidenceScopePaths].sort(),
  });
}

export async function cachedChapterSearch(input: { manager: ReturnType<typeof getMultiProjectManager>; projectRoot: string; query: string; evidenceScopePaths: Set<string>; maxEvidence: number; fileRolesHash: string; generationMode?: boolean }) {
  const key = chapterSearchCacheKey(input);
  const cached = CHAPTER_SEARCH_CACHE.get(key) || readPersistentJson<KbSearchResult[]>(input.projectRoot, 'chapter-search', key);
  if (cached) {
    setLimitedCache(CHAPTER_SEARCH_CACHE, key, cached);
    return cached;
  }
  const scopedFilePaths = [...input.evidenceScopePaths].filter(Boolean).sort();
  if (scopedFilePaths.length === 0) return [];
  const result = await input.manager.search(input.projectRoot, input.query, {
    scope: 'project',
    filters: { filePaths: scopedFilePaths },
    limit: input.generationMode ? input.maxEvidence : Math.max(input.maxEvidence, 30),
    weights: input.generationMode ? { keyword: 0.55, vector: 0.4, rewrite: 0, hybridBonus: 0.08 } : { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
    generationMode: input.generationMode,
  });
  setLimitedCache(CHAPTER_SEARCH_CACHE, key, result.results);
  writePersistentJson(input.projectRoot, 'chapter-search', key, result.results);
  return result.results;
}

export function chapterDraftCacheKey(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; requirement?: string; projectRoot: string; modelName?: string; targetWords: number; fileRolesHash: string }) {
  return stableHash({
    type: 'chapter-draft-v1',
    projectRoot: input.projectRoot,
    projectId: computeProjectId(input.projectRoot),
    templateId: input.template.id,
    chapterId: input.chapter.id,
    chapterTitle: input.chapter.title,
    requirement: input.requirement || '',
    promptTexts: input.promptTexts,
    modelName: input.modelName || '',
    targetWords: input.targetWords,
    fileRolesHash: input.fileRolesHash,
    missingFacts: input.missingFacts,
    evidence: input.evidence.map(item => ({ filePath: item.filePath, score: Math.round(item.score * 1000) / 1000, roleId: item.roleId, processingType: item.processingType, source: item.source, digest: stableHash(item.content.slice(0, 3000)) })),
  });
}

export function blockingChapterCacheIssues(issues: string[]) {
  const blocking: string[] = [];
  for (const issue of issues) {
    BLOCKING_CHAPTER_CACHE_ISSUE_RE.lastIndex = 0;
    if (BLOCKING_CHAPTER_CACHE_ISSUE_RE.test(issue)) blocking.push(issue);
  }
  return blocking;
}

export function readChapterDraftCache(input: Parameters<typeof chapterDraftCacheKey>[0], diagnostics?: DocumentGenerationDiagnostics) {
  pruneChapterDraftCache(diagnostics);
  const key = chapterDraftCacheKey(input);
  const memory = CHAPTER_DRAFT_CACHE.get(key);
  const cached = memory?.value || readPersistentJson<DocumentDraftChapter>(input.projectRoot, 'chapter-draft', key);
  if (!cached) {
    if (diagnostics) diagnostics.cache.chapterMisses += 1;
    return undefined;
  }
  if (cached.id !== input.chapter.id || !cached.content?.trim()) {
    if (diagnostics) diagnostics.cache.rejectedHits += 1;
    return undefined;
  }
  const targetIssues = lightweightChapterIssues({ chapter: input.chapter, content: cached.content, missingFacts: cached.missingFacts || input.missingFacts, targetWords: input.targetWords });
  if (blockingChapterCacheIssues(targetIssues).length > 0) {
    if (diagnostics) diagnostics.cache.rejectedHits += 1;
    return undefined;
  }
  if (memory) memory.hits += 1;
  setLimitedCache(CHAPTER_DRAFT_CACHE, key, { value: cached, updatedAt: Date.now(), hits: (memory?.hits || 0) + 1 });
  if (diagnostics) diagnostics.cache.chapterHits += 1;
  return cached;
}

export function writeChapterDraftCache(input: Parameters<typeof chapterDraftCacheKey>[0], chapter: DocumentDraftChapter, diagnostics?: DocumentGenerationDiagnostics) {
  const key = chapterDraftCacheKey(input);
  setLimitedCache(CHAPTER_DRAFT_CACHE, key, { value: chapter, updatedAt: Date.now(), hits: 0 });
  writePersistentJson(input.projectRoot, 'chapter-draft', key, chapter);
  if (diagnostics) diagnostics.cache.chapterWrites += 1;
  pruneChapterDraftCache(diagnostics);
}

export function sectionDraftCacheKey(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; sectionTitle: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; projectRoot: string; modelName?: string; targetWords: number; fileRolesHash: string }) {
  return stableHash({
    type: 'section-draft-v1',
    projectRoot: input.projectRoot,
    projectId: computeProjectId(input.projectRoot),
    templateId: input.template.id,
    chapterId: input.chapter.id,
    sectionTitle: input.sectionTitle,
    requirement: input.requirement || '',
    promptTexts: stableHash(input.promptTexts.slice(0, 12000)),
    modelName: input.modelName || '',
    targetWords: input.targetWords,
    fileRolesHash: input.fileRolesHash,
    evidence: input.evidence.map(item => ({ filePath: item.filePath, roleId: item.roleId, digest: stableHash(item.content.slice(0, 2000)) })),
  });
}

export function readSectionDraftCache(input: Parameters<typeof sectionDraftCacheKey>[0], diagnostics?: DocumentGenerationDiagnostics) {
  const key = sectionDraftCacheKey(input);
  const memory = SECTION_DRAFT_CACHE.get(key);
  const cached = memory?.value || readPersistentJson<string>(input.projectRoot, 'section-draft', key);
  if (!cached?.trim()) {
    if (diagnostics) diagnostics.cache.sectionMisses += 1;
    return undefined;
  }
  if (/后台流程话术|提示词|占位|TODO|待补充/iu.test(cached) || documentTextLength(cached) < Math.max(120, Math.floor(input.targetWords * 0.45))) {
    if (diagnostics) diagnostics.cache.rejectedHits += 1;
    return undefined;
  }
  setLimitedCache(SECTION_DRAFT_CACHE, key, { value: cached, updatedAt: Date.now(), hits: (memory?.hits || 0) + 1 });
  if (diagnostics) {
    diagnostics.cache.sectionHits += 1;
    diagnostics.quality.reusedSectionCount += 1;
  }
  return cached;
}

export function writeSectionDraftCache(input: Parameters<typeof sectionDraftCacheKey>[0], content: string, diagnostics?: DocumentGenerationDiagnostics) {
  if (!content.trim() || /后台流程话术|提示词|占位|TODO|待补充/iu.test(content)) return;
  const key = sectionDraftCacheKey(input);
  setLimitedCache(SECTION_DRAFT_CACHE, key, { value: content, updatedAt: Date.now(), hits: 0 });
  writePersistentJson(input.projectRoot, 'section-draft', key, content);
  if (diagnostics) diagnostics.cache.sectionWrites += 1;
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
  const matched = scored.filter(item => item.score > 5).slice(0, 2);
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
        sourceRequirement: item.content.replace(/\s+/gu, ' ').slice(0, 500),
        requiredContents: [],
        writingRules: [],
        evidenceNeeds: [],
        minWords: 1200,
        requirements: [],
      });
      if (headings.length >= MAX_FALLBACK_CHAPTERS) break;
    }
    if (headings.length >= MAX_FALLBACK_CHAPTERS) break;
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
    const value = item.content.replace(/\s+/gu, ' ').slice(0, 360);
    if (value.length <= 20) continue;
    facts.push({
      key: `${node.fileRoleName}事实${facts.length + 1}`,
      value,
      sourceFile: item.filePath,
      roleId: node.fileRoleId,
      processingType: node.processingType,
      relatedChapterHints: item.sectionTitle ? [item.sectionTitle] : [],
    });
    if (facts.length >= 20) break;
  }
  return facts;
}

export async function executeRoleExtractionNode(template: DocumentTemplate, node: RoleExecutionNode, evidence: DocumentEvidence[], signal?: AbortSignal): Promise<RoleNodeArtifact> {
  const sample = evidence.slice(0, 36).map(item => `文件:${item.filePath}\n片段:${item.sectionTitle || ''}\n内容:${item.content.slice(0, 1200)}`).join('\n\n---\n\n');
  const promptText = node.promptTexts.join('\n\n') || '请读取绑定文件角色，抽取可用于文档生成的结构化信息。';
  const extractionPrompt = `你正在执行一个“文件角色 × 提示词角色”的读取节点。\n节点类型：${node.outputType}\n文件角色：${node.fileRoleName}（${node.fileRoleId}）\n要求：严格按该节点绑定的提示词读取该文件角色的内容，不要读取其他角色。提示词角色只提供规则和格式约束，其中的示例、样例、占位项目名、编号、日期、数量和示例正文不得作为事实抽取来源。\n\n请返回 JSON，字段包括 chapters、facts、outputRequirements、forbidImageInsertion、warnings。chapters 只提取当前模板和规范包需要的正式章节；requirements 只保留可合并写入正文的核心要求，避免无依据地拆成过细子节点。facts 必须只来自下面的绑定文件片段，优先抽取对象、范围、区域、阶段、数量、日期、周期、规格、单位、资源数量、检查频次和来源口径；同类对象不得合并丢失，计量单位保持原文含义，必要时使用导出友好的正式写法。\n\n绑定文件片段：\n${sample}`;
  const warnings: string[] = [];
  throwIfAborted(signal);
  let llm = sample.trim() ? await callDocumentLlmJson<RoleExtractionLlmResult>(promptText, extractionPrompt, { signal }) : undefined;
  throwIfAborted(signal);
  if (roleExtractionNeedsRepair(llm)) {
    warnings.push(`${node.fileRoleName} 结构化读取返回格式异常，已尝试修复 JSON schema。`);
    const repaired = await callDocumentLlmJson<RoleExtractionLlmResult>(
      '你是 JSON schema 修复器。只根据输入 JSON 重新整理字段类型，不新增事实，不改写事实含义。',
      `请把下面 JSON 修复为严格结构：{"chapters":[],"facts":[],"outputRequirements":[],"warnings":[],"forbidImageInsertion":false}。chapters 和 facts 必须是数组；如果原值是对象，请转为数组；如果无法转换，使用空数组。只返回 JSON。\n\n原始 JSON：\n${JSON.stringify(llm).slice(0, 12000)}`,
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
  const usedFallback = chapters.length === 0 || facts.length === 0;
  if (usedFallback) warnings.push(`${node.fileRoleName} 部分结构化结果不足，已补充使用证据片段兜底。`);
  return {
    node,
    evidence,
    chapters: chapters.length > 0 ? chapters : fallbackChaptersFromEvidence(template, node, evidence),
    facts: facts.length > 0 ? facts : fallbackFactsFromEvidence(node, evidence),
    outputRequirements: asStringArray(llm?.outputRequirements),
    warnings: [...warnings, ...asStringArray(llm?.warnings)],
    forbidImageInsertion: llm?.forbidImageInsertion ?? node.outputType === 'drawing_facts',
  };
}

export function extractProjectBasicFacts(evidence: DocumentEvidence[]): ProjectBasicFact[] {
  const facts: ProjectBasicFact[] = [];
  const seen = new Set<string>();

  for (const item of evidence) {
    for (const { key, patterns } of PROJECT_BASIC_FACT_FIELDS) {
      if (facts.some(fact => fact.key === key)) continue;
      for (const pattern of patterns) {
        const value = pattern.exec(item.content)?.[1]?.replace(/\s+/gu, ' ').trim();
        if (!value || /见(?:公告|文件|资料|附件)|详见|按.*要求/u.test(value)) continue;
        const dedupeKey = `${key}:${value}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        facts.push({ key, value: value.slice(0, 300), sourceFile: item.filePath });
        break;
      }
    }
  }
  return facts;
}

export function analyzePromptIntent(text: string): PromptIntentProfile {
  // 防止超大文本导致正则表达式性能灾难，提取头部和尾部各 5000 字符进行意图判断（指令通常在开头或结尾）
  const safeText = text.length > 10000 ? `${text.slice(0, 5000)}\n\n${text.slice(-5000)}` : text;
  const normalized = safeText.replace(/\s+/gu, ' ');
  return {
    explicitStructure: /(?:目录|大纲|章节|结构|框架|按以下|如下结构|不要新增|不得新增|只写|仅写)/u.test(normalized),
    explicitSections: /(?:小节|二级标题|三级标题|一级标题|##|###|第[一二三四五六七八九十]+章|\d+[.、]\s*[^\s])/u.test(safeText),
    lengthLimit: /(?:\d+\s*(?:字|页|段)|控制在|不超过|不少于|篇幅|字数|页数)/u.test(normalized),
    wantsConcise: /(?:简洁|精简|简要|不要展开|无需展开|概述|摘要|少写|控制篇幅)/u.test(normalized),
    detailedInstructions: normalized.length >= 900 || /(?:必须包含|重点写|详细说明|逐项|分别说明|表格|列表|明细|流程|步骤|标准|责任|频次|验收)/u.test(normalized),
    explicitFacts: /(?:\d+\s*(?:天|日|个月|万元|元|%|㎡|m2|米|m|人|台|套)|项目名称|周期|质量标准|地点|预算|编号)/u.test(normalized),
    styleConstraint: /(?:口吻|语气|风格|措辞|正式|承诺|汇报|方案|不要使用|禁止使用)/u.test(normalized),
  };
}

export function shouldInjectProjectBasicFacts(profile: PromptIntentProfile) {
  return !(profile.explicitStructure || profile.explicitSections || profile.lengthLimit || profile.wantsConcise || profile.detailedInstructions || profile.explicitFacts || profile.styleConstraint);
}

export function projectBasicFactsPrompt(facts: ProjectBasicFact[], chapter: DocumentTemplateChapter, profile: PromptIntentProfile) {
  if (facts.length === 0 || !shouldInjectProjectBasicFacts(profile)) return '';
  const text = [chapter.title, chapter.purpose, ...(chapter.sections || []), ...(chapter.queries || [])].join('\n');
  const matched = facts.filter(fact => {
    const field = PROJECT_BASIC_FACT_FIELDS.find(item => item.key === fact.key);
    return !field || field.chapterHint.test(text) || /概况|总述|说明|背景/u.test(text);
  });
  if (matched.length === 0) return '';
  return [
    '## 项目基础事实候选',
    '以下事实来自已进入本章证据范围的绑定资料，仅在与本章主题相关时自然吸收进正文；不得新增章节、不得强制生成表格、不得输出本提示标题。',
    ...matched.slice(0, 12).map(fact => `- ${fact.key}：${fact.value}`),
  ].join('\n');
}

function formatBasicFactsDigest(facts: ProjectBasicFact[]) {
  if (facts.length === 0) return '';
  const lines = ['## 项目基础事实候选'];
  for (const fact of facts) lines.push(`- ${fact.key}：${fact.value}`);
  return lines.join('\n');
}

function formatArtifactDigest(artifact: RoleNodeArtifact) {
  const lines = [`## ${artifact.node.fileRoleName} / ${artifact.node.outputType}`];
  const chapterLines: string[] = [];
  for (const chapter of artifact.chapters.slice(0, 18)) chapterLines.push(`- ${chapter.title}：${chapter.requiredContents.join('、') || chapter.sourceRequirement.slice(0, 120)}`);
  if (chapterLines.length > 0) lines.push(`章节/要求：\n${chapterLines.join('\n')}`);
  const factLines: string[] = [];
  for (const fact of artifact.facts.slice(0, 30)) factLines.push(`- ${fact.key}：${stringifyFactValue(fact.value).slice(0, 220)}（来源：${fact.sourceFile}，角色：${fact.roleId}）`);
  if (factLines.length > 0) lines.push(`事实：\n${factLines.join('\n')}`);
  if (artifact.outputRequirements.length > 0) lines.push(`输出要求：${artifact.outputRequirements.join('；')}`);
  return lines.join('\n');
}

export function roleArtifactsDigest(artifacts: RoleNodeArtifact[], basicFacts: ProjectBasicFact[] = []) {
  const blocks: string[] = [];
  const tenderDigest = formatBasicFactsDigest(basicFacts);
  if (tenderDigest) blocks.push(tenderDigest);
  for (const artifact of artifacts) blocks.push(formatArtifactDigest(artifact));
  return blocks.join('\n\n');
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
  for (const artifact of artifacts) {
    for (const fact of artifact.facts) {
      if (!factMatchesHints(fact, hints)) continue;
      matched.push({ artifact, fact });
      if (matched.length >= 80) return matched;
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
  const factsText = [...factGroups.entries()].map(([key, lines]) => `### ${key}\n${lines.slice(0, 18).map(line => line.replace(FILE_NAME_RE, '').replace(CAD_ENTITY_TOKEN_RE, '')).join('\n')}`).join('\n\n');
  return [planText ? `【本章章节计划】\n${planText}` : '', factsText ? `【角色节点结构化产物】\n${factsText}` : ''].filter(Boolean).join('\n\n');
}

export function shouldForbidDrawingImages(artifacts: RoleNodeArtifact[], _template: DocumentTemplate) {
  return artifacts.some(item => item.forbidImageInsertion || item.node.outputType === 'drawing_facts');
}


export function tenderQualityIssues(markdown: string, chapters: DocumentDraftChapter[], plan: TenderPlanChapter[], artifacts: RoleNodeArtifact[], forbidDrawingImages: boolean) {
  const issues: string[] = [];
  for (const chapter of plan) {
    if (!markdown.includes(chapter.title)) issues.push(`章节计划建议未体现：${chapter.title}`);
    for (const item of chapter.requiredContents.slice(0, 12)) if (item && !markdown.includes(item)) issues.push(`${chapter.title} 未覆盖必写内容：${item}`);
  }
  for (const chapter of chapters) {
    const planItem = plan.find(item => item.title === chapter.title);
    const min = planItem?.minWords || 1000;
    if (chapter.content.length < min) issues.push(`${chapter.title} 内容深度不足：${chapter.content.length}/${min}`);
    if ((chapter.sections || []).length < 3) issues.push(`${chapter.title} 二级小节少于 3 个，必须由模型结合章节主题和项目资料补齐 3-6 个正式二级小节`);
    for (const section of chapter.sections || []) {
      if (section && !markdown.includes(section)) issues.push(`${chapter.title} 缺少目录小节：${section}`);
    }
  }
  for (const artifact of artifacts) {
    const importantFacts = artifact.facts.slice(0, 5).map(fact => stringifyFactValue(fact.value).slice(0, 24)).filter(value => value.length >= 6);
    if (importantFacts.length > 0 && !importantFacts.some(value => markdown.includes(value))) issues.push(`未体现 ${artifact.node.fileRoleName} 的关键读取结果`);
  }
  if (forbidDrawingImages && /!\[[^\]]*\]\([^)]*\)/iu.test(markdown)) issues.push('正文包含不应插入的图片');
  if (/\b(?:m\s*[²2]|m\s*[³3]|mm2|cm2|km2)\b/iu.test(markdown)) issues.push('正文包含导出不友好的计量单位写法');
  return [...new Set(issues)].slice(0, 40);
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
    const match = input.content.match(new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^#{3,4}\\s+|^##\\s+|$)`, 'mu'));
    if (!match) issues.push(`缺少配置小节：${section}`);
    else if (documentTextLength(match[1]) < 180) issues.push(`配置小节正文过短：${section}`);
  }
  if (documentTextLength(input.content) < Math.floor(input.targetWords * 0.85)) issues.push('正文篇幅明显低于目标');
  WORKFLOW_PHRASE_RE.lastIndex = 0;
  if (WORKFLOW_PHRASE_RE.test(input.content) || /知识库|检索|角色节点|事实字段|校验结果/u.test(input.content)) issues.push('正文包含后台流程话术');
  if (/资料未提供|满足相关要求|结合实际情况|按(?:相关|有关|规范|规定|设计)要求/u.test(input.content)) issues.push('正文存在空泛占位表达');
  for (const fact of input.missingFacts.slice(0, 8)) {
    if (fact && !input.content.includes(fact)) issues.push(`requiredFacts 未明显覆盖：${fact}`);
  }
  return [...new Set(issues)].slice(0, 10);
}

export function issuesForChapter(chapter: DocumentDraftChapter, issues: string[]) {
  const actionableIssues = issues.filter(repairableQualityIssue);
  const sectionHits = new Set(chapter.sections || []);
  const text = `${chapter.title}\n${chapter.sections?.join('\n') || ''}\n${chapter.content.slice(0, 4000)}`;
  return actionableIssues.filter(issue => issue.includes(chapter.title) || [...sectionHits].some(section => issue.includes(section)) || /图片|三级小节|目录|表格|量化|数值|单位|事实/u.test(issue) && /!\[|####|\*\*|\||按设计要求|按规范要求|m\s*[²2]|mm2|cm2|km2/u.test(text));
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

function markdownStructureValid(content: string, title: string) {
  const codeFenceCount = (content.match(/```/gu) || []).length;
  const normalizedTitle = title.replace(/^第[一二三四五六七八九十百千万]+章\s*/u, '').slice(0, 6);
  return codeFenceCount % 2 === 0 && content.includes(normalizedTitle) && !/^\s*$/u.test(content);
}

function applyChapterPatch(input: { content: string; patch: ChapterMarkdownPatch; title: string; forbidDrawingImages: boolean }) {
  const replacement = input.patch.replacement?.trim();
  if (!replacement || replacement.length > 2600) return { content: input.content, applied: false };
  if (input.forbidDrawingImages && /!\[[^\]]*\]\([^)]*\)/iu.test(replacement)) return { content: input.content, applied: false };
  const range = uniqueTextRange(input.content, input.patch);
  if (!range || range.length > 3200) return { content: input.content, applied: false };
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
    '禁止新增证据摘要中没有的信息；无法安全定位的问题不要生成 patch。',
    '返回 JSON：{"patches":[{"originalText":"原局部文本","targetStart":"定位起始文本","targetEnd":"定位结束文本","replacement":"替换后的局部文本","reason":"修复原因"}]}',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    `章节：${input.chapter.title}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    `需要局部修复的问题：\n${input.issues.map(item => `- ${item}`).join('\n')}`,
    input.chapter.evidence.length ? `本章证据摘要：\n${evidenceBundlePrompt(buildEvidenceBundle({ id: input.chapter.id, title: input.chapter.title, purpose: input.chapter.title, queries: [], requiredFacts: [] }, input.chapter.evidence))}` : '',
    '当前章节 Markdown：',
    input.chapter.content,
  ].filter(Boolean).join('\n\n'), { maxTokens: 2200, temperature: 0, signal: input.signal, diagnostics: input.diagnostics });
  throwIfAborted(input.signal);
  let content = input.chapter.content;
  let appliedCount = 0;
  for (const patch of (Array.isArray(result?.patches) ? result!.patches! : []).slice(0, 3)) {
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
    .map(chapter => ({ chapter, issues: issuesForChapter(chapter, repairableIssues).slice(0, 3) }))
    .filter(item => item.issues.length > 0);
  if (candidates.length === 0) {
    return {
      markdown: input.markdown,
      chapters: input.chapters,
      stage: { type: 'llm_review' as const, roleId: 'quality-repair', status: 'success' as const, message: `已完成质量检查，未定位到可安全局部修复的阻断问题：${repairableIssues.slice(0, 5).join('；')}` },
    };
  }
  const configuredRepairConcurrency = Number(process.env.DOCUMENT_REPAIR_CONCURRENCY ?? input.strategy?.maxChapterReviewConcurrency ?? candidates.length);
  const maxRepairConcurrency = (input.strategy?.maxChapterReviewConcurrency ?? candidates.length) || 1;
  const concurrency = Math.max(1, Math.min(maxRepairConcurrency, Number.isFinite(configuredRepairConcurrency) ? Math.floor(configuredRepairConcurrency) : candidates.length || 1));
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
    : `已完成质量检查，未生成可唯一定位且通过校验的局部 patch：${repairableIssues.slice(0, 5).join('；')}`;
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

export function sanitizePromptForExecution(content: string) {
  const lines = content.replace(/```[\s\S]*?```/gu, '\n【示例代码块已省略：仅作为格式参考，不作为项目事实】\n').split(/\r?\n/u);
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
    const startsRule = /(?:不得|禁止|必须|应当|要求|规则|格式|输出|保留|只返回|不要)/u.test(trimmed);
    if (startsExample && !startsRule) {
      if (!result.at(-1)?.includes('示例内容已省略')) result.push('【示例内容已省略：仅作为格式参考，不作为项目事实】');
      skippingExample = true;
      continue;
    }
    if (skippingExample) {
      if (!trimmed) {
        skippingExample = false;
        continue;
      }
      if (/^(?:#+\s*)?(?:规则|要求|输出|格式|禁止|注意|正文|章节|风格|校验)/u.test(trimmed)) skippingExample = false;
      else continue;
    }
    result.push(line);
  }
  return result.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function promptRoleExecutionTypes() {
  const roleTypes = new Map<string, string>();
  for (const role of listDocumentRoles('prompt')) roleTypes.set(role.id, role.executionType || 'reference');
  return roleTypes;
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
