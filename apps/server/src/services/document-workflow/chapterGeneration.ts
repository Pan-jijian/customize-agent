import * as fs from 'node:fs';
import * as path from 'node:path';
import { createProvider } from '@customize-agent/llm';
import type { recallDocumentContexts } from '../context/contextService';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { MarkdownSectionContentGap } from './qualityValidation';
import type { ChapterReviewSummary, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentGenerationStrategy, DocumentTemplate, DocumentTemplateChapter, PromptChapterStructuralRule, PromptDocumentRuleSet, ResolvedFactNeed, ValidationIssue } from './types';
import type { DocumentBudget } from './budget';
import { documentTextLength } from './budget';
import { buildEvidenceBundle, cleanEvidenceText, evidenceBundlePrompt, evidencePromptBudgetForTarget } from './evidence';
import { FORMAL_WRITING_RULES, SECTION_GENERATION_SAFETY_RULES, removeUnwantedDrawingImages, sanitizeFormalMarkdown } from './markdownComposer';
import { callDocumentLlm, callDocumentLlmJson, callWithTimeout, getActiveModelWithProvider, providerFactoryName } from './llmClient';
import { stringifyFactValue, throwIfAborted } from './utils';
import type { RoleNodeFact, TenderPlanChapter } from './rolePipeline';
import { lightweightChapterIssues, measureGenerationStep } from './rolePipeline';
import { displayChapterTitle } from './outline';
import { displayStage, elapsedMessage } from './progress';

export function mimeTypeFromPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}

function splitTextForReview(text: string, chunkChars: number) {
  const normalized = text.trim();
  if (!normalized) return [];
  const size = Math.max(1000, Math.ceil(chunkChars));
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += size) chunks.push(normalized.slice(start, start + size));
  return chunks;
}

function chunkTextForReview(text: string, chunkChars: number) {
  const chunks = splitTextForReview(text, chunkChars);
  if (chunks.length === 0) return '';
  return chunks.length === 1
    ? chunks[0]
    : chunks.map((chunk, index) => `【片段 ${index + 1}/${chunks.length}】\n${chunk}`).join('\n\n');
}

function chunkPrompt(chunk: string, index: number, total: number) {
  return total <= 1 ? chunk : `【片段 ${index + 1}/${total}】\n${chunk}`;
}

function summarizeChapterForConsistency(chapter: DocumentDraftChapter, budget = 1800) {
  const sections = (chapter.sections || []).filter(Boolean).join('、') || '未规划小节';
  const plain = chapter.content
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/[#>*_`\-|]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const textBudget = Math.max(800, budget - 500);
  const headSize = Math.max(600, Math.floor(textBudget * 0.7));
  const tailSize = Math.max(200, textBudget - headSize);
  const head = plain.slice(0, headSize);
  const tail = plain.length > headSize + tailSize ? plain.slice(-tailSize) : '';
  const evidenceBudget = Math.max(120, Math.floor((budget - head.length - tail.length) / 4));
  const evidence = chapter.evidence.slice(0, 4).map(item => `${item.filePath || item.roleId || '证据'}: ${cleanEvidenceText(item.content || '').slice(0, evidenceBudget)}`).join('\n');
  const missingFacts = chapter.missingFacts.length ? `未覆盖事实：${chapter.missingFacts.slice(0, 12).join('、')}` : '未覆盖事实：无';
  return [`章节：${chapter.title}`, `字数：${documentTextLength(chapter.content)}`, `小节：${sections}`, missingFacts, evidence ? `证据摘要：\n${evidence}` : '', `正文摘要：${head}${tail ? `\n尾部摘要：${tail}` : ''}`].filter(Boolean).join('\n').slice(0, budget);
}

function parseReviewJson(text: string | undefined) {
  if (!text) return undefined;
  const normalized = text.replace(/^```(?:json)?\s*/u, '').replace(/```$/u, '').trim();
  try {
    return JSON.parse(normalized) as { status?: string; issues?: unknown[]; suggestions?: unknown[]; repairInstructions?: unknown[]; repair?: unknown };
  } catch {
    const match = normalized.match(/\{[\s\S]*\}/u);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]) as { status?: string; issues?: unknown[]; suggestions?: unknown[]; repairInstructions?: unknown[]; repair?: unknown };
    } catch {
      return undefined;
    }
  }
}

function reviewItemToString(item: unknown) {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  const value = item as { message?: unknown; suggestion?: unknown; location?: unknown; type?: unknown; severity?: unknown };
  const message = typeof value.message === 'string' ? value.message.trim() : '';
  const suggestion = typeof value.suggestion === 'string' ? value.suggestion.trim() : '';
  const location = typeof value.location === 'string' ? value.location.trim() : '';
  const type = typeof value.type === 'string' ? value.type.trim() : '';
  const severity = typeof value.severity === 'string' ? value.severity.trim() : '';
  return [severity, location || type, message, suggestion].filter(Boolean).join('：').trim();
}

function mergeUniqueStrings(items: unknown[]) {
  return [...new Set(items.map(reviewItemToString).filter(Boolean))];
}

function stageIssueSummary(items: string[], fallback: string) {
  if (items.length === 0) return fallback;
  const selected: string[] = [];
  let chars = 0;
  for (const item of items) {
    if (chars + item.length > 420 && selected.length > 0) break;
    selected.push(item);
    chars += item.length;
  }
  return selected.join('；');
}

function envPositiveInt(name: string) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function adaptiveReviewPlan(input: { totalChars: number; chapterCount: number; chunkChars: number; phase: 'chapter' | 'global' | 'final' }) {
  const totalChunks = Math.max(1, Math.ceil(Math.max(0, input.totalChars) / Math.max(1000, input.chunkChars)));
  const chapterCount = Math.max(1, input.chapterCount);
  const lengthFactor = Math.max(1, Math.ceil(input.totalChars / 24000));
  if (input.phase === 'chapter') {
    return {
      chunks: envPositiveInt('DOCUMENT_CHAPTER_REVIEW_MAX_CHUNKS') ?? Math.min(totalChunks, Math.max(2, Math.ceil(totalChunks * 0.75))),
      issues: envPositiveInt('DOCUMENT_CHAPTER_REVIEW_MAX_ISSUES') ?? Math.max(8, Math.ceil(lengthFactor * 8)),
      ms: Math.max(60_000, Number(process.env.DOCUMENT_CHAPTER_REVIEW_MAX_MS ?? Math.min(12 * 60_000, Math.max(3 * 60_000, lengthFactor * 90_000)))),
    };
  }
  if (input.phase === 'global') {
    return {
      chunks: envPositiveInt('DOCUMENT_GLOBAL_REVIEW_MAX_CHUNKS') ?? Math.min(totalChunks, Math.max(chapterCount, Math.ceil(totalChunks * 0.65))),
      issues: envPositiveInt('DOCUMENT_GLOBAL_REVIEW_MAX_ISSUES') ?? Math.max(24, Math.min(120, chapterCount * 8 + lengthFactor * 10)),
      ms: Math.max(90_000, Number(process.env.DOCUMENT_GLOBAL_REVIEW_MAX_MS ?? Math.min(18 * 60_000, Math.max(4 * 60_000, lengthFactor * 120_000)))),
    };
  }
  return {
    chunks: envPositiveInt('DOCUMENT_FINAL_REVIEW_MAX_CHUNKS') ?? Math.min(totalChunks, Math.max(chapterCount, Math.ceil(totalChunks * 0.8))),
    issues: envPositiveInt('DOCUMENT_FINAL_REVIEW_MAX_ISSUES') ?? Math.max(24, Math.min(140, chapterCount * 10 + lengthFactor * 12)),
    ms: Math.max(90_000, Number(process.env.DOCUMENT_FINAL_REVIEW_MAX_MS ?? Math.min(20 * 60_000, Math.max(5 * 60_000, lengthFactor * 150_000)))),
  };
}

export async function understandReferenceFiles(projectRoot: string, evidence: DocumentEvidence[], signal?: AbortSignal): Promise<{ notes: string[]; stage: DocumentExecutionStage }> {
  const active = getActiveModelWithProvider();
  if (!active?.provider.capabilities?.fileUnderstanding && !active?.provider.capabilities?.imageUnderstanding) {
    return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '当前模型未开启文件理解/图片理解能力' } };
  }
  throwIfAborted(signal);
  const provider = createProvider(providerFactoryName(active.model.provider, active.provider), { baseUrl: active.provider.baseUrl, apiKey: active.provider.apiKey, modelName: active.model.name, directEndpoint: active.provider.directEndpoint });
  const fileAwareProvider = provider as typeof provider & { understandFiles?: (files: Array<{ name: string; mimeType: string; data: Buffer }>, prompt: string, options?: { maxTokens?: number; signal?: AbortSignal }) => Promise<{ content: string }> };
  if (!fileAwareProvider.understandFiles) return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '当前 Provider 未实现文件理解接口' } };
  const maxFiles = Math.max(1, Math.floor(Number(process.env.DOCUMENT_FILE_UNDERSTANDING_MAX_FILES ?? 4)));
  const maxBytes = Math.max(128 * 1024, Math.floor(Number(process.env.DOCUMENT_FILE_UNDERSTANDING_MAX_BYTES ?? 8 * 1024 * 1024)));
  const candidates = [...new Set(evidence.map(item => item.filePath).filter(file => /\.(png|jpe?g|webp|pdf|docx|xlsx)$/iu.test(file)))].slice(0, maxFiles);
  const skipped: string[] = [];
  const files = candidates.map(filePath => {
    const absolute = path.join(projectRoot, 'knowledgeBase', filePath);
    if (!fs.existsSync(absolute)) return undefined;
    const stat = fs.statSync(absolute);
    if (stat.size > maxBytes) {
      skipped.push(path.basename(filePath));
      return undefined;
    }
    return { name: path.basename(filePath), mimeType: mimeTypeFromPath(filePath), data: fs.readFileSync(absolute) };
  }).filter(Boolean) as Array<{ name: string; mimeType: string; data: Buffer }>;
  if (files.length === 0) return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: skipped.length ? `参考文件过大，已跳过 ${skipped.length} 个多模态文件理解` : '没有可发送给多模态模型的参考文件' } };
  try {
    throwIfAborted(signal);
    const response = await callWithTimeout(
      localSignal => fileAwareProvider.understandFiles!(files, '请阅读这些参考图片/文件，提炼可用于文档生成和审查的事实、视觉要点、地图信息和封面设计建议。请用中文要点输出。', { maxTokens: 1200, signal: localSignal }),
      Math.max(30000, Math.min(90000, Number(process.env.DOCUMENT_FILE_UNDERSTANDING_TIMEOUT_MS ?? 60000))),
      signal,
    );
    throwIfAborted(signal);
    const note = response?.content.trim() || '';
    return { notes: note ? [note] : [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: note ? 'success' : 'fallback', message: note ? `已理解 ${files.length} 个多模态参考文件` : '多模态模型未返回有效文件理解结果' } };
  } catch {
    return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'fallback', message: '文件理解调用失败，继续使用本地解析内容' } };
  }
}






export function buildValidationIssues(validation: { warnings: string[]; errors: string[] }, factsModel: DocumentFactsModel, draftChapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...validation.errors.map(message => ({ level: 'error' as const, message, suggestion: '请补充配置或资料后重新生成。' })),
    ...validation.warnings.map(message => ({ level: 'warning' as const, message, suggestion: '建议人工确认或补充对应资料。' })),
  ];
  if (draftChapters.some(chapter => chapter.content.includes('资料未提供'))) issues.push({ level: 'warning', message: '存在资料未提供章节', suggestion: '请检查项目角色配置中的文件绑定和顺序。' });
  if (factsModel.conflicts.length > 0) issues.push(...factsModel.conflicts.map(message => ({ level: 'warning' as const, message, suggestion: '请根据当前模板绑定的角色、文件证据和用户要求复核取值口径。' })));
  return issues;
}

function extractChapterPreciseTokens(evidence: DocumentEvidence[]) {
  const tokens = new Set<string>();
  const tokenRe = /(?:\b[A-Z]{1,8}[\w./-]*\d[\w./-]*\b|\b\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年|万元|元)\b|\b\d+\s*[×xX]\s*\d+(?:\s*[×xX]\s*\d+)?\b|\b(?:GB|GB\/T|ISO|IEC|IEEE|RFC|API|DB\d*|T\/[A-Z]+)\s*[\w.-]+\b)/giu;
  for (const item of evidence) {
    const content = stringifyFactValue(item.content).replace(/\s+/gu, ' ');
    if (/报价明细|投标报价|单价|合价|综合单价|预留金|税率|增值税|利润|结算/u.test(content) && !/合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(content)) continue;
    if (/OCR|识别错误|乱码|无法确认|疑似|不确定|语义断裂/u.test(content)) continue;
    for (const match of content.matchAll(tokenRe)) tokens.add(match[0].trim());
    if (tokens.size >= 40) break;
  }
  return [...tokens].slice(0, 40);
}

export function buildChapterFactCoverageContext(input: { chapter: DocumentTemplateChapter; plan?: TenderPlanChapter; spec?: AutoDocumentSpecPackage; roleFacts: Array<{ fact: RoleNodeFact }>; evidence: DocumentEvidence[]; missingFacts: string[]; indexedFacts?: DocumentFact[]; resolvedFactNeeds?: ResolvedFactNeed[]; factNeedsPrompt?: string }) {
  const specRule = input.spec?.chapterRules.find(rule => rule.id === input.chapter.id || rule.title === input.chapter.title);
  const specFactNames = (specRule?.requiredFactIds || [])
    .map(id => input.spec?.factFields.find(field => field.id === id)?.name)
    .filter(Boolean) as string[];
  const requiredFacts = [...new Set([
    ...input.chapter.requiredFacts,
    ...specFactNames,
    ...(input.plan?.requiredContents || []),
    ...(input.plan?.evidenceNeeds || []),
    ...(input.resolvedFactNeeds || []).filter(item => item.need.required).map(item => item.need.label),
  ].filter(Boolean))];
  const roleFactLines = input.roleFacts.map(({ fact }) => `- ${fact.key}：${cleanEvidenceText(stringifyFactValue(fact.value))}`);
  const resolvedFacts = (input.resolvedFactNeeds || []).flatMap(item => item.facts);
  const indexedFactLines = resolvedFacts.length > 0
    ? []
    : (input.indexedFacts || []).slice(0, 40).map(fact => `- ${fact.key || fact.fieldName || '资料事实'}：${cleanEvidenceText(stringifyFactValue(fact.value)).slice(0, 180)}${fact.sourceFile ? `（来源：${fact.sourceFile.split('/').pop()}）` : ''}`);
  const projectBasicFacts = [...resolvedFacts, ...(input.indexedFacts || [])]
    .filter(fact => /建设地点|建设规模|招标范围|计划工期|合同工期|周期要求|质量标准|合同估算|投资估算|最高投标限价|招标控制价/u.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`))
    .filter((fact, index, array) => array.findIndex(item => `${item.key || item.fieldName}:${stringifyFactValue(item.value)}` === `${fact.key || fact.fieldName}:${stringifyFactValue(fact.value)}`) === index)
    .slice(0, 12);
  const preciseTokens = [...new Set([...extractChapterPreciseTokens(input.evidence), ...resolvedFacts.map(fact => stringifyFactValue(fact.value)).filter(value => /\d|DN|φ|Φ|mm|cm|m²|m3|m³|MPa|kPa|℃|%|GB|JGJ|ISO|台|套|个|项|批|次|份|人|㎡|日历天|万元|元/iu.test(value)).slice(0, 80), ...(input.indexedFacts || []).map(fact => stringifyFactValue(fact.value)).filter(value => /\d|DN|φ|Φ|mm|cm|m²|m3|m³|MPa|kPa|℃|%|GB|JGJ|ISO|台|套|个|项|批|次|份|人|㎡|日历天|万元|元/iu.test(value)).slice(0, 40)])].slice(0, 100);
  const evidenceSourceCount = new Set([...input.evidence.map(item => item.filePath), ...resolvedFacts.map(item => item.sourceFile), ...(input.indexedFacts || []).map(item => item.sourceFile)]).size;
  const unresolvedNeeds = (input.resolvedFactNeeds || []).filter(item => item.status !== 'satisfied' && item.need.required).map(item => item.need.label);
  return [
    '【本章事实覆盖与参数落位要求】',
    requiredFacts.length ? `必须优先覆盖的事实/要求：\n${requiredFacts.map(item => `- ${item}`).join('\n')}` : '',
    roleFactLines.length ? `角色节点已抽取事实：\n${roleFactLines.join('\n')}` : '',
    projectBasicFacts.length ? `项目基础事实卡片（资料已明确，项目概况、项目基本信息表、进度和质量相关内容必须优先使用，不得写“资料未明确”）：\n${projectBasicFacts.map(fact => `- ${fact.key || fact.fieldName}：${cleanEvidenceText(stringifyFactValue(fact.value)).slice(0, 220)}${fact.sourceFile ? `（来源：${fact.sourceFile.split('/').pop()}）` : ''}`).join('\n')}\n项目基本信息表必须使用固定表头：| 信息项 | 内容 |，不得使用“序号｜项目名称｜内容参数”表头，不得输出后台溯源列。` : '',
    input.factNeedsPrompt || '',
    indexedFactLines.length ? `全局资料事实索引匹配到的本章可写事实：\n${indexedFactLines.join('\n')}` : '',
    preciseTokens.length ? `本章资料中可直接使用的可靠精确参数/编号：${preciseTokens.join('、')}。这些参数来自绑定资料，不属于编造；涉及对应对象、部位、工序、材料、设备、项目概况、质量验收或安全控制时必须自然写入正文，并保持原样或等价专业表达。项目基础事实中的合同估算价、计划工期可用于项目概况；不得写入报价明细、单价、税率、预留金。` : '',
    unresolvedNeeds.length ? `当前事实需求仍未充分确认：${unresolvedNeeds.join('、')}。未确认项不得编造；但已满足事实需求中的资料事实必须写入对应小节。` : '',
    input.missingFacts.length ? `模板显式要求中当前检索未充分命中的项：${input.missingFacts.join('、')}。未命中项不得编造，但不得因此省略上方已经明确的可靠参数。` : '',
    `本章可用材料来源约 ${evidenceSourceCount} 个文件，正文必须按事实需求把可用事实内化到对应小节，不得单列后台资料清单。`,
  ].filter(Boolean).join('\n');
}

/** 使用 LLM 生成单章内容，基于证据包、提示词角色和用户需求 */
export async function buildLlmChapterContent(template: DocumentTemplate, chapter: DocumentTemplate['chapters'][number], evidence: DocumentEvidence[], missingFacts: string[], promptTexts: string, projectContext: string, requirement?: string, roleContext = '', options: { forbidDrawingImages?: boolean; minWords?: number; targetWords?: number; maxWords?: number; maxTokens?: number; factCoverageContext?: string; signal?: AbortSignal } = {}) {
  const bundle = buildEvidenceBundle(chapter, evidence);
  const evidenceText = evidenceBundlePrompt(bundle, { maxChars: evidencePromptBudgetForTarget(options.targetWords || options.minWords) });
  if (!evidenceText.trim() && !roleContext.trim()) return undefined;
  const sectionInstruction = chapter.sections?.length
    ? `本章小节由生成前规划得到，请完整包含并展开以下小节：\n${chapter.sections.map(section => `- ${section}`).join('\n')}`
    : '本章没有预设小节；请按用户提示词、模板章节、角色要求和绑定材料自然组织正文。';
  const sectionBudgetInstruction = buildSectionBudgetInstruction(chapter, options.targetWords || options.minWords || 0);
  const system = [
    FORMAL_WRITING_RULES,
    options.forbidDrawingImages ? '图片类材料只作为文本事实依据；禁止插入图片或 Markdown 图片语法。' : '',
    promptTexts,
  ].filter(Boolean).join('\n\n');
  const prompt = [
    `文档模板：${template.name}`,
    `章节标题：${chapter.title}`,
    `章节目的：${chapter.purpose}`,
    sectionInstruction,
    sectionBudgetInstruction,
    requirement ? `用户要求：${requirement}` : '',
    projectContext ? `上下文/历史记忆（仅作偏好、历史纠偏和连续性参考；如与知识库证据冲突，以知识库证据为准）：\n${projectContext}` : '',
    roleContext ? roleContext : '',
    options.factCoverageContext || '',
    missingFacts.length ? `需要特别补足的信息：${missingFacts.join('、')}` : '',
    '请生成可直接导出的 Markdown 章节，要求：',
    `- 保留章节标题；内容不少于 ${options.minWords || 1000} 字${options.targetWords ? `，目标约 ${options.targetWords} 字` : ''}${options.maxWords ? `，最多不超过 ${options.maxWords} 字` : ''}。`,
    chapter.sections?.length ? '- 必须完整包含已规划小节；不要新增未规划的二级小节。' : '- 未预设小节时，不要为了凑结构强行新增小节。',
    chapter.tableSections?.length ? `- 以下小节可使用表格辅助表达：${chapter.tableSections.join('、')}。` : '',
    '- 内容必须遵循用户提示词、模板章节、提示词角色、文件角色和绑定材料；不得编造材料未提供的事实。',
    '- 将材料要点自然融入正文；不要输出系统证据清单、中间分析过程或后台流程话术。',
    SECTION_GENERATION_SAFETY_RULES,
    '',
    evidenceText ? '绑定材料：' : '',
    evidenceText,
  ].filter(Boolean).join('\n');
  const content = await callDocumentLlm(system, prompt, false, { maxTokens: options.maxTokens, signal: options.signal });
  if (!content || content.length < 120) return undefined;
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('## ') ? content : `## ${chapter.title}\n\n${content}`, Boolean(options.forbidDrawingImages)));
}

export function sectionTargets(chapter: DocumentTemplateChapter, targetWords: number) {
  const sections = chapter.sections?.filter(Boolean) || [];
  if (sections.length === 0) return [];
  const rawBase = Math.floor(targetWords / sections.length);
  const minimum = targetWords >= sections.length * 900 ? 900 : Math.max(520, Math.floor(rawBase * 0.9));
  const base = Math.max(minimum, rawBase);
  return sections.map(section => ({ title: section, targetWords: base }));
}

export function buildSectionBudgetInstruction(chapter: DocumentTemplateChapter, targetWords: number) {
  const targets = sectionTargets(chapter, targetWords);
  if (targets.length === 0) return '';
  return [
    '本章小节篇幅计划（首轮生成应尽量一次达成，避免后续补写）：',
    ...targets.map(item => `- ${item.title}：约 ${item.targetWords} 字，至少达到 ${Math.floor(item.targetWords * 0.8)} 字，并写入与该小节相关的材料事实、适用边界和必要说明。`),
  ].join('\n');
}

export function tokenizeForRelevance(text: string) {
  return [...new Set((text.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9_-]{3,}/gu) || []).map(item => item.toLowerCase()))];
}

export function evidenceForSection(sectionTitle: string, chapter: DocumentTemplateChapter, evidence: DocumentEvidence[]) {
  const tokens = tokenizeForRelevance([sectionTitle, chapter.title, ...(chapter.requiredFacts || [])].join(' '));
  const basicFactSection = /项目概况|工程概况|总体|部署|施工方案|工期|进度|质量|安全|资源|材料|设备/u.test(sectionTitle);
  const scored = evidence.map((item, index) => {
    const text = `${item.filePath}\n${item.sectionTitle || ''}\n${item.content}`.toLowerCase();
    const rawText = `${item.filePath}\n${item.sectionTitle || ''}\n${item.content}`;
    const hitScore = tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
    const sectionScore = item.sectionTitle && (sectionTitle.includes(item.sectionTitle) || item.sectionTitle.includes(sectionTitle)) ? 4 : 0;
    const parameterScore = /\d|DN|φ|Φ|mm|cm|m²|m3|m³|MPa|kPa|℃|%|GB|JGJ|ISO|台|套|个|项|批|次|份|人|㎡|日历天|万元|元|规格|型号|数量|合同估算价|合同估算价格|计划工期/iu.test(rawText) ? 1.5 : 0;
    const basicFactScore = basicFactSection && /计划工期|合同工期|合同估算价|合同估算价格|投资估算|建设地点|建设规模|质量标准|招标范围/u.test(rawText) ? 5 : 0;
    const typeScore = /table|sheet|bill|data|drawing|图纸|表格|清单|参数|数据|说明/u.test(`${item.roleId || ''} ${item.processingType || ''} ${item.filePath}`) ? 0.8 : 0;
    return { item, score: hitScore + sectionScore + parameterScore + basicFactScore + typeScore + item.score * 0.1 - index * 0.001 };
  }).sort((a, b) => b.score - a.score);
  const selected = scored.filter(item => item.score > 0).map(item => item.item);
  return selected.length > 0 ? selected : evidence;
}

function normalizePlannedSectionTitle(title: string) {
  return displayChapterTitle(title)
    .replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分、.．\s-]*/u, '')
    .replace(/^\d+(?:\.\d+)*(?:[.．、]|\s)+/u, '')
    .replace(/[<>]/gu, '')
    .replace(/[：:。；;,.，]+$/gu, '')
    .trim();
}

function isInvalidPlannedSectionTitle(title: string, chapterTitle: string) {
  const normalized = normalizePlannedSectionTitle(title);
  const normalizedChapter = normalizePlannedSectionTitle(chapterTitle);
  if (normalized.length < 4 || normalized.length > 60) return true;
  if (normalized === normalizedChapter) return true;
  if (/^(?:目标与范围|资料依据|实施内容|质量控制|概述|总体要求)$/u.test(normalized)) return true;
  if (/如需|应由|大模型|提示词|上下文|动态规划|OUTLINE|章节生成|按照.*明确指定|需求和资料|JSON|小节标题/u.test(normalized)) return true;
  if (/(.)\1/u.test(normalized)) return true;
  const tail = normalizedChapter.match(/[\p{L}\p{N}]{2,6}$/u)?.[0] || '';
  if (tail.length >= 2 && /^.{2,8}\p{L}$/u.test(normalized) && normalized.endsWith(tail.slice(-1)) && !normalized.includes(tail)) return true;
  return false;
}

function chineseOrdinalToNumber(value: string) {
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^\d+$/u.test(value)) return Number(value);
  if (digits[value] !== undefined) return digits[value];
  if (value === '十') return 10;
  const tenMatch = /^(?:(一|二|两|三|四|五|六|七|八|九)?)十(?:(一|二|两|三|四|五|六|七|八|九))?$/u.exec(value);
  if (!tenMatch) return undefined;
  const tens = tenMatch[1] ? digits[tenMatch[1]] : 1;
  const ones = tenMatch[2] ? digits[tenMatch[2]] : 0;
  return tens * 10 + ones;
}

function sectionTitleEquivalent(a: string, b: string) {
  const left = normalizePlannedSectionTitle(a).replace(/[\s()（）:：.。；;,，、-]/gu, '');
  const right = normalizePlannedSectionTitle(b).replace(/[\s()（）:：.。；;,，、-]/gu, '');
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function cleanParsedSectionTitles(titles: string[]) {
  return Array.from(new Set(titles.map(normalizePlannedSectionTitle).filter(title => title.length >= 2 && title.length <= 30 && !/必须|强制|排序|设置|输出|独立|之后|之前|小节|其他必要/u.test(title))));
}

function parseSectionListFromRuleText(text: string) {
  const topList = /(?:以下小节设置和排序|强制小节|必须小节)[：:]\s*([\s\S]*?)(?:\n\s*#{2,6}\s|\n\s*第[一二两三四五六七八九十\d]+章|$)/u.exec(text)?.[1];
  if (topList) {
    const titles = [...topList.matchAll(/(?:^|\n)\s*\d+[.．、]\s*([^——\-—：:。；;\n]{2,30})(?:[——\-—：:]|，|,|。|；|;|\n|$)/gu)].map(match => match[1]);
    const cleaned = cleanParsedSectionTitles(titles);
    if (cleaned.length > 0) return cleaned;
  }

  const titles: string[] = [];
  const afterRequiredPattern = /第[一二两三四五六七八九十\d]+章[^。；;\n]{0,50}(?:强制)?(?:包含|设置|输出|排序|挂靠)[^：:。；;\n]{0,20}[：:]\s*([^。；;\n]{2,120})/gu;
  for (const match of text.matchAll(afterRequiredPattern)) {
    for (const item of match[1].split(/[、,，/／及和与]/u)) titles.push(item);
  }
  const quotedSectionPattern = /[“"]([^”"]{2,30})[”"]\s*(?:二级)?小节/gu;
  for (const match of text.matchAll(quotedSectionPattern)) titles.push(match[1]);
  const namedPattern = /([\p{Script=Han}A-Za-z0-9（）()]{2,30})(?:——|—|-|：|:)\s*(?:独立的)?(?:二级)?小节/gu;
  for (const match of text.matchAll(namedPattern)) titles.push(match[1]);
  const afterSectionLabelPattern = /(?:必须|应当|需|需要|包含|设置|输出)[^。；;\n]{0,30}(?:独立的)?(?:二级)?小节[：:]\s*([^。；;\n]{2,80})/gu;
  for (const match of text.matchAll(afterSectionLabelPattern)) {
    for (const item of match[1].split(/[、,，/／及和与]/u)) titles.push(item);
  }
  return cleanParsedSectionTitles(titles);
}

export function extractPromptDocumentRules(promptTexts: string): PromptDocumentRuleSet {
  const normalizedText = promptTexts.replace(/\\n/gu, '\n');
  const requiredTables = new Set<string>();
  const tableLine = /全文必须输出[：:]\s*([^。；;\n]+)/u.exec(normalizedText)?.[1] || /必须输出(?:的)?表格[：:]\s*([^。；;\n]+)/u.exec(normalizedText)?.[1] || '';
  for (const part of tableLine.split(/[、,，]/u)) {
    const title = /([\p{Script=Han}A-Za-z0-9（）()]{2,30}表)$/u.exec(part.trim())?.[1];
    if (title && title.length >= 4 && title.length <= 30) requiredTables.add(title);
  }
  if (/项目基本信息表/u.test(normalizedText)) requiredTables.add('项目基本信息表');
  const forbiddenTerms = ['知识库', '提示词', '建议补充', '资料库', 'OCR', '后台', '绑定片段', '兜底'];
  if (/杜绝|禁止|不得|严禁/u.test(normalizedText)) forbiddenTerms.push('施工方', '投标人', '高度重视', '重中之重');
  if (/商务|报价|单价|税率|利润|造价/u.test(normalizedText)) forbiddenTerms.push('综合单价', '报价明细', '税率', '增值税', '利润', '预留金');
  return {
    forbidCover: /严禁生成封面|不输出封面|禁止封面/u.test(normalizedText),
    forbidToc: /严禁生成[^\n。；;]*目录|不输出[^\n。；;]*目录|禁止[^\n。；;]*目录/u.test(normalizedText),
    forbiddenTerms: [...new Set(forbiddenTerms)],
    preferredTerms: [{ from: '施工方', to: '我公司' }, { from: '投标人', to: '我公司' }, { from: '高度重视', to: '严格落实' }, { from: '重中之重', to: '关键控制事项' }],
    requiredTables: [...requiredTables],
  };
}

export function extractPromptStructuralRules(promptTexts: string, chapters?: DocumentTemplateChapter[]): PromptChapterStructuralRule[] {
  const normalizedText = promptTexts.replace(/\\n/gu, '\n');
  const chapterRulePattern = /第([一二两三四五六七八九十\d]+)章[^\n。；;]{0,80}(?:强制|必须|挂靠|小节|排序|最先|之后|之前)/gu;
  const grouped = new Map<number, { blocks: string[]; titles: string[] }>();
  const matches = [...normalizedText.matchAll(chapterRulePattern)];
  for (const match of matches) {
    const chapterNumber = chineseOrdinalToNumber(match[1]);
    if (!chapterNumber) continue;
    const start = Math.max(0, match.index || 0);
    const next = matches.find(item => (item.index || 0) > start)?.index;
    const block = normalizedText.slice(start, Math.min(normalizedText.length, next ?? start + 1400));
    const titles = parseSectionListFromRuleText(block);
    if (titles.length === 0) continue;
    const item = grouped.get(chapterNumber) || { blocks: [], titles: [] };
    item.blocks.push(block);
    for (const title of titles) {
      if (!item.titles.some(existing => sectionTitleEquivalent(existing, title))) item.titles.push(title);
    }
    grouped.set(chapterNumber, item);
  }
  return [...grouped.entries()].map(([chapterNumber, item]) => {
    const chapter = chapters?.[chapterNumber - 1];
    return {
      chapterIndex: chapterNumber - 1,
      chapterTitle: chapter?.title,
      source: item.blocks[0]?.split('\n').find(line => line.trim())?.trim().slice(0, 120),
      requiredSections: item.titles.map((title, index) => ({ title, order: index + 1, required: true, source: item.blocks[0]?.slice(0, 240) })),
    };
  });
}

function structuralRulesForChapter(rules: PromptChapterStructuralRule[] | undefined, chapter: DocumentTemplateChapter, chapterIndex?: number) {
  return (rules || []).filter(rule => {
    if (rule.chapterIndex !== undefined && chapterIndex !== undefined && rule.chapterIndex === chapterIndex) return true;
    if (rule.chapterTitle && sectionTitleEquivalent(rule.chapterTitle, chapter.title)) return true;
    return false;
  });
}

function applyPromptStructuralRules(sections: string[], chapterTitle: string, rules: PromptChapterStructuralRule[]) {
  const locked = rules.flatMap(rule => rule.requiredSections).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (locked.length === 0) return sections;
  const result: string[] = [];
  for (const rule of locked) {
    const title = normalizePlannedSectionTitle(rule.title);
    if (title && title.length >= 2 && title.length <= 60 && !result.some(item => sectionTitleEquivalent(item, title))) result.push(title);
  }
  for (const section of sections) {
    const title = normalizePlannedSectionTitle(section);
    if (!title || isInvalidPlannedSectionTitle(title, chapterTitle)) continue;
    if (!result.some(item => sectionTitleEquivalent(item, title))) result.push(title);
  }
  return result;
}

function compoundSectionSeeds(chapterTitle: string) {
  const title = normalizePlannedSectionTitle(chapterTitle);
  const seeds: string[] = [];
  const completeClause = /体系|措施|管理|保障|方案|要求|计划|控制|配置/u;
  const addAndGroup = (value: string) => {
    const match = /^(.*?)([^与和及、,，；;]+(?:[与和及][^与和及、,，；;]+)+)(的.+)$/u.exec(value);
    if (!match) return false;
    const prefix = match[1] || '';
    const suffix = match[3] || '';
    for (const item of match[2].split(/[与和及]/u)) seeds.push(normalizePlannedSectionTitle(`${prefix}${item}${suffix}`));
    return true;
  };
  const addCommaGroup = (value: string) => {
    const parts = value.split(/[、,，]/u).map(normalizePlannedSectionTitle).filter(Boolean);
    if (parts.length > 1 && parts.every(part => part.length >= 4 && completeClause.test(part))) {
      for (const part of parts) {
        if (!addAndGroup(part)) seeds.push(part);
      }
      return true;
    }
    const match = /^(.*?)([^、,，；;]+(?:[、,，][^、,，；;]+)+)(的.+)$/u.exec(value);
    if (!match) return false;
    const prefix = match[1] || '';
    const suffix = match[3] || '';
    for (const item of match[2].split(/[、,，]/u)) seeds.push(normalizePlannedSectionTitle(`${prefix}${item}${suffix}`));
    return true;
  };
  for (const part of title.split(/[；;]/u)) {
    if (addCommaGroup(part) || addAndGroup(part)) continue;
    const cleaned = normalizePlannedSectionTitle(part);
    if (cleaned && cleaned !== title) seeds.push(cleaned);
  }
  return Array.from(new Set(seeds)).filter(item => item.length >= 4 && item.length <= 60 && item !== title && !isInvalidPlannedSectionTitle(item, chapterTitle));
}

function evidenceParameterDensity(evidence: DocumentEvidence[]) {
  const text = evidence.map(item => `${item.sectionTitle || ''}\n${item.content}`).join('\n').slice(0, 30000);
  const matches = text.match(/\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年|万元|元)|DN\s*\d+|Φ\s*\d+|φ\s*\d+|C\d{2,}|HRB\d+|GB\/?T?\s*[\w.-]+|JGJ\s*[\w.-]+/giu) || [];
  return new Set(matches.map(item => item.replace(/\s+/gu, ''))).size;
}

function minimumSectionCount(chapter: DocumentTemplateChapter, targetWords: number, evidence: DocumentEvidence[], lockedCount: number) {
  const title = chapter.title;
  const coreChapter = /质量|安全|工期|进度|物资|材料|机械|设备|劳动力|危大|专项|文明|总平面|施工方法|施工方案/u.test(title);
  let minimum = targetWords >= 14000 ? 8 : targetWords >= 8000 ? 6 : targetWords >= 5000 ? 5 : targetWords >= 3000 ? 4 : 3;
  if (coreChapter) minimum = Math.max(minimum, 4);
  const density = evidenceParameterDensity(evidence);
  if (density >= 20) minimum = Math.max(minimum, 6);
  else if (density >= 10) minimum = Math.max(minimum, 5);
  return Math.max(minimum, lockedCount);
}

function fallbackSectionsForChapter(chapterTitle: string) {
  if (/质量/u.test(chapterTitle)) return ['质量目标与质量管理体系', '关键工序质量控制措施', '材料设备进场验收与检验', '质量检查试验与验收程序', '质量通病防治与整改闭环', '成品保护与资料管理'];
  if (/安全/u.test(chapterTitle)) return ['安全生产管理体系', '危险源辨识与分级管控', '现场安全防护措施', '临时用电与机械设备安全管理', '应急处置与安全检查整改', '安全教育培训与交底'];
  if (/工期|进度/u.test(chapterTitle)) return ['总工期目标与节点安排', '施工进度计划编制原则', '关键线路与工序穿插安排', '资源投入与工期保障措施', '进度偏差纠偏与动态调整', '工期风险识别与应对措施'];
  if (/物资|材料/u.test(chapterTitle)) return ['主要材料设备需求分析', '材料采购与进场计划', '材料验收复试与保管', '周转材料配置与使用管理', '材料供应风险与保障措施'];
  if (/机械|设备/u.test(chapterTitle)) return ['主要机械设备配置原则', '机械设备进退场计划', '机械设备调度与运行管理', '机械设备维护保养与安全检查', '关键设备保障措施'];
  if (/劳动力/u.test(chapterTitle)) return ['劳动力配置原则', '各阶段劳动力投入计划', '专业工种与特种作业人员配置', '劳动力动态调配措施', '劳务管理与教育交底'];
  if (/文明|环保/u.test(chapterTitle)) return ['现场封闭与场容场貌管理', '环境保护与污染防治措施', '材料设备定置化管理', '职业健康与消防文明管理', '文明施工检查与整改'];
  if (/总平面|平面布置/u.test(chapterTitle)) return ['施工总平面布置原则', '临时道路与材料堆场布置', '临时用水用电及排水布置', '办公生活与加工区域布置', '总平面动态调整与管理'];
  if (/危大|专项/u.test(chapterTitle)) return ['危大工程识别与清单管理', '专项施工方案编制与审批', '专家论证与技术交底', '现场实施监测与旁站管理', '应急处置与验收销项'];
  if (/施工方法|施工方案|主要/u.test(chapterTitle)) return ['总体施工部署与流程安排', '主要分部分项施工方法', '关键工序技术控制要点', '资源配置与穿插组织', '质量安全与成品保护措施'];
  return ['总体部署与责任分工', '实施流程与关键控制', '资源配置与资料依据', '质量安全与风险控制', '检查验收与闭环管理', '资料记录与成果移交'];
}

export async function planChapterSectionsWithLlm(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; chapterIndex?: number; evidence: DocumentEvidence[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; structuralRules?: PromptChapterStructuralRule[]; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics }) {
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, input.evidence), { maxChars: evidencePromptBudgetForTarget(input.targetWords, 5000, 12000) });
  const chapterStructuralRules = structuralRulesForChapter(input.structuralRules, input.chapter, input.chapterIndex);
  const lockedSections = chapterStructuralRules.flatMap(rule => rule.requiredSections).sort((a, b) => (a.order || 0) - (b.order || 0)).map(rule => rule.title);
  const minSections = minimumSectionCount(input.chapter, input.targetWords, input.evidence, lockedSections.length);
  const maxSections = Math.max(minSections + 2, input.targetWords >= 14000 ? 10 : input.targetWords >= 8000 ? 8 : 7);
  const result = await callDocumentLlmJson<{ sections?: string[] }>([
    '你是专业文档结构规划专家。',
    '只根据用户提示词、章节标题和真实绑定资料规划本章二级小节；不得使用“目标与范围、资料依据、实施内容、质量控制”等通用占位小节凑数。',
    '施工组织、技术措施、资源配置、质量、安全、工期、材料、设备、劳动力、危大工程等核心章节必须拆成足够的专业工作面，不得只输出两个泛化小节。',
    '只返回 JSON。',
  ].join('\n'), [
    `文档模板：${input.template.name}`,
    `章节标题：${input.chapter.title}`,
    input.chapter.purpose && !isInvalidPlannedSectionTitle(input.chapter.purpose, input.chapter.title) ? `章节目的：${input.chapter.purpose}` : '',
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `上下文：\n${input.projectContext}` : '',
    input.roleContext,
    input.promptTexts ? `配置写作主控提示词：\n${input.promptTexts}` : '',
    lockedSections.length ? `系统已从提示词解析出本章强制二级小节，必须按此顺序置于本章小节最前，不得删除、改名或重排：${lockedSections.join('、')}` : '',
    evidenceText ? `真实绑定资料：\n${evidenceText}` : '',
    `请输出 ${minSections}-${maxSections} 个适合直接成稿的二级小节标题。标题必须具体、业务相关、能承载真实资料；每个小节应对应不同工作面、技术点、管理点或资料类别，避免多个小节表达同一内容。核心章节不得只输出“总体部署与责任分工、实施流程与关键控制”两个泛化小节。`,
    'JSON 格式：{"sections":["小节标题1","小节标题2"]}',
  ].filter(Boolean).join('\n\n'), { maxTokens: 1600, temperature: 0.1, signal: input.signal, diagnostics: input.diagnostics, timeoutMs: 120000 });
  const sections = Array.from(new Set(compoundSectionSeeds(input.chapter.title)));
  for (const title of (result?.sections || []).map(normalizePlannedSectionTitle).filter(title => !isInvalidPlannedSectionTitle(title, input.chapter.title))) {
    if (!sections.some(section => section.includes(title) || title.includes(section))) sections.push(title);
  }
  const fallbackSeeds = [input.chapter.title, ...(input.chapter.requiredFacts || []), ...(input.chapter.queries || [])]
    .flatMap(item => String(item || '').split(/[；;。\n]/u))
    .map(normalizePlannedSectionTitle)
    .filter(title => !isInvalidPlannedSectionTitle(title, input.chapter.title));
  const typedSeeds = fallbackSectionsForChapter(input.chapter.title)
    .filter(title => !isInvalidPlannedSectionTitle(title, input.chapter.title));
  for (const seed of [...fallbackSeeds, ...typedSeeds]) {
    if (sections.length >= minSections) break;
    if (!sections.some(section => section.includes(seed) || seed.includes(section))) sections.push(seed);
  }
  return applyPromptStructuralRules(sections, input.chapter.title, chapterStructuralRules);
}

function buildSectionFactCard(sectionTitle: string, evidence: DocumentEvidence[]) {
  const lines: string[] = [];
  const seen = new Set<string>();
  const importantLineRe = /计划工期|合同工期|合同估算价|合同估算价格|投资估算|估算价格|工程估算价|最高投标限价|招标控制价|建设地点|建设规模|质量标准|招标范围|\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年)/iu;
  for (const item of evidence) {
    for (const rawLine of stringifyFactValue(item.content).split(/\r?\n/u)) {
      const line = rawLine.replace(/\s+/gu, ' ').trim();
      if (line.length < 4 || line.length > 260 || !importantLineRe.test(line)) continue;
      if (/报价明细|综合单价|税率|增值税|利润|结算/u.test(line) && !/合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(line)) continue;
      const key = line.replace(/[\s，。,.;；:：]/gu, '');
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${line}`);
      if (lines.length >= 12) break;
    }
    if (lines.length >= 12) break;
  }
  return lines.length ? `【当前小节可直接落位的资料事实】\n${lines.join('\n')}\n上述事实均来自本小节相关绑定资料；与“${sectionTitle}”相关时必须自然写入正文，不得改写数值。` : '';
}

export async function buildLlmSectionContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; sectionTitle: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; qualityFeedback?: string; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; timeoutMs?: number }) {
  const sectionEvidence = evidenceForSection(input.sectionTitle, input.chapter, input.evidence);
  const sectionFactCard = buildSectionFactCard(input.sectionTitle, sectionEvidence);
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, sectionEvidence), { maxChars: evidencePromptBudgetForTarget(input.targetWords, 3500, 9000) });
  const prompt = [
    `文档模板：${input.template.name}`,
    `章节标题：${input.chapter.title}`,
    `当前二级小节：${input.sectionTitle}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `上下文：\n${input.projectContext}` : '',
    input.factCoverageContext || '',
    sectionFactCard,
    input.roleContext,
    input.missingFacts.length ? `需要特别补足的信息：${input.missingFacts.join('、')}` : '',
    input.qualityFeedback ? `上轮小节未通过质量检查，必须修正：${input.qualityFeedback}` : '',
    `请只生成当前二级小节正文，使用“### ${input.sectionTitle}”作为小节标题，目标约 ${input.targetWords} 字${input.maxWords ? `，最多不超过 ${input.maxWords} 字` : ''}。`,
    '本章二级小节结构已由系统按模板和提示词锁定；不得删除、重命名、合并或重排当前小节标题。',
    SECTION_GENERATION_SAFETY_RULES,
    evidenceText ? `绑定材料：\n${evidenceText}` : '',
  ].filter(Boolean).join('\n\n');
  const llmCall = () => callDocumentLlm([
    '你是专业文档的小节生成专家。',
    FORMAL_WRITING_RULES,
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), prompt, false, { maxTokens: outputTokensForChapter(input.targetWords), temperature: 0.25, signal: input.signal });
  const timedCall = () => callWithTimeout(llmCall, input.timeoutMs!, input.signal);
  const content = input.timeoutMs
    ? await (input.diagnostics
      ? measureGenerationStep(input.diagnostics, `section-draft:${input.chapter.id}:${input.sectionTitle}`, timedCall)
      : timedCall())
    : await llmCall();
  if (!content || content.length < 80) return undefined;
  const normalized = sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('### ') ? content : `### ${input.sectionTitle}\n\n${content}`, input.forbidDrawingImages));
  return normalized.replace(/^##\s+.*\n+/u, '').trim();
}

interface SectionWritingTask {
  sectionTitle: string;
  taskTitle: string;
  targetWords: number;
  index: number;
  total: number;
}

function writingTopicTitle(sectionTitle: string, index: number, total: number) {
  const lower = sectionTitle.toLowerCase();
  const generic = ['资料依据与适用范围', '对象范围与关键参数', '实施方法与组织安排', '质量安全控制要求', '检查验收与闭环管理'];
  const resource = ['资源配置依据', '材料设备规格与数量', '进场组织与保管要求', '使用调配与过程核验', '验收记录与动态调整'];
  const technical = ['施工准备与技术依据', '主要工艺流程', '材料设备与参数控制', '质量验收要点', '成品保护与问题处置'];
  const safety = ['风险识别与控制边界', '防护设施与作业条件', '人员设备安全管理', '检查频次与整改闭环', '应急响应与资料留存'];
  const quality = ['质量目标与验收依据', '过程控制点', '材料设备复核', '检验批与验收资料', '问题整改与成品保护'];
  const topics = /资源|材料|设备|人材机/u.test(sectionTitle) ? resource
    : /施工|工艺|技术|安装|土建|结构|给排水|电气/u.test(sectionTitle) || /method|technical/u.test(lower) ? technical
      : /安全|文明|危大|风险/u.test(sectionTitle) ? safety
        : /质量|验收|标准/u.test(sectionTitle) ? quality
          : generic;
  return total <= 1 ? sectionTitle : `${sectionTitle}：${topics[index % topics.length]}`;
}

function writingTasksForSection(sectionTitle: string, targetWords: number): SectionWritingTask[] {
  const maxTaskWords = Math.max(900, Math.floor(Number(process.env.DOCUMENT_WRITING_TASK_MAX_WORDS ?? 1800)));
  const taskCount = targetWords >= 1400 ? Math.max(2, Math.ceil(targetWords / maxTaskWords)) : targetWords > maxTaskWords * 1.2 ? Math.ceil(targetWords / maxTaskWords) : 1;
  const perTask = Math.max(650, Math.ceil(targetWords / taskCount));
  if (taskCount <= 1) return [{ sectionTitle, taskTitle: sectionTitle, targetWords, index: 1, total: 1 }];
  return Array.from({ length: taskCount }, (_, index) => ({
    sectionTitle,
    taskTitle: writingTopicTitle(sectionTitle, index, taskCount),
    targetWords: perTask,
    index: index + 1,
    total: taskCount,
  }));
}

function sectionContentBody(content: string) {
  return content.replace(/^#{3,4}\s+.*\n+/u, '').trim();
}

async function supplementSectionContent(input: Parameters<typeof buildLlmSectionContent>[0] & { currentContent: string; targetWords: number }) {
  const currentLength = documentTextLength(input.currentContent);
  const missing = input.targetWords - currentLength;
  if (missing <= Math.max(260, Math.floor(input.targetWords * 0.12))) return input.currentContent;
  const sectionEvidence = evidenceForSection(input.sectionTitle, input.chapter, input.evidence);
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, sectionEvidence), { maxChars: evidencePromptBudgetForTarget(Math.min(input.targetWords, 2600), 3500, 9000) });
  const patchTarget = Math.min(Math.max(500, missing), Math.max(900, Math.floor(input.targetWords * 0.45)));
  const patch = await callWithTimeout(signal => callDocumentLlm([
    '你是专业文档小节补写专家。只做补写，不重写全文。',
    FORMAL_WRITING_RULES,
    '必须保留已有正文中的事实、参数、编号和结构；只补充缺口段落，不删除、不压缩已有内容。',
    SECTION_GENERATION_SAFETY_RULES,
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `章节标题：${input.chapter.title}`,
    `当前小节：${input.sectionTitle}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.factCoverageContext || '',
    `当前小节约 ${currentLength} 字，目标约 ${input.targetWords} 字，本轮补充约 ${patchTarget} 字。`,
    '请输出可直接追加或插入到本小节的补充段落；不要重复小节标题，不要解释生成过程。',
    evidenceText ? `绑定材料：\n${evidenceText}` : '',
    `已有小节正文：\n${sectionContentBody(input.currentContent).slice(0, 12000)}`,
  ].filter(Boolean).join('\n\n'), false, { maxTokens: outputTokensForChapter(patchTarget), temperature: 0.25, signal }), Math.max(90000, Math.min(180000, timeoutMsForChapter(patchTarget))), input.signal);
  const normalizedPatch = sanitizeFormalMarkdown(removeUnwantedDrawingImages(patch || '', input.forbidDrawingImages)).replace(/^#{3,4}\s+.*\n+/u, '').trim();
  return normalizedPatch ? `${input.currentContent.trim()}\n\n${normalizedPatch}` : input.currentContent;
}

function fallbackPlannedSectionContent(sectionTitle: string) {
  return `### ${sectionTitle}\n\n${sectionTitle}应作为本章首轮成稿的独立控制单元组织实施。编制和执行过程中，应围绕已确认的项目资料、设计文件、清单信息、技术标准、施工边界、资源配置、质量安全要求和验收记录形成闭环；资料中已经明确的规格、数量、标准编号、工艺参数、检查频次和验收指标应在对应工作面中直接采用，资料未明确的工程实体参数不得擅自确定，应按审批程序复核确认后实施。`;
}

function ensureNonEmptySectionContent(content: string, sectionTitle: string) {
  const normalized = sanitizeFormalMarkdown(content || '').trim();
  const body = normalized.replace(/^#{3,4}\s+.+$/gmu, '').trim();
  if (documentTextLength(body) >= 80) return normalized;
  return fallbackPlannedSectionContent(sectionTitle);
}

async function buildTaskBasedSectionContent(input: Parameters<typeof buildLlmSectionContent>[0]) {
  const tasks = writingTasksForSection(input.sectionTitle, input.targetWords);
  const parts: string[] = [];
  for (const task of tasks) {
    throwIfAborted(input.signal);
    const taskContent = await buildLlmSectionContent({
      ...input,
      sectionTitle: task.sectionTitle,
      targetWords: task.targetWords,
      maxWords: Math.ceil(task.targetWords * 1.18),
      qualityFeedback: task.total > 1 ? `这是首轮生成的主题任务 ${task.index}/${task.total}，只聚焦“${task.taskTitle}”。不得重复同小节其他主题的通用表述；优先写入与本主题相关的资料事实、规格、数量、标准、检查要求和执行动作。` : input.qualityFeedback,
    });
    if (taskContent) parts.push(sectionContentBody(taskContent));
  }
  if (parts.length === 0) return undefined;
  let merged = `### ${input.sectionTitle}\n\n${parts.join('\n\n')}`;
  merged = await supplementSectionContent({ ...input, currentContent: merged, targetWords: input.targetWords });
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(merged, input.forbidDrawingImages));
}

export async function buildSectionParallelChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext?: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; projectRoot?: string; modelName?: string; fileRolesHash?: string; allowPartialResult?: boolean; maxSectionConcurrency?: number; onSectionProgress?: (event: { completed: number; total: number; sectionTitle?: string; phase: 'start' | 'complete' | 'retry' }) => void; diagnostics?: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  const targets = sectionTargets(input.chapter, input.targetWords);
  if (targets.length < 2) return undefined;
  const configuredConcurrency = Number(process.env.DOCUMENT_SECTION_CONCURRENCY ?? input.maxSectionConcurrency ?? 1);
  const concurrency = Math.max(1, Math.min(targets.length, 3, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : 1));
  const results: Array<string | undefined> = new Array(targets.length);
  let completedCount = 0;
  const runSection = async (item: { title: string; targetWords: number }, compact = false) => {
    input.onSectionProgress?.({ completed: completedCount, total: targets.length, sectionTitle: item.title, phase: compact ? 'retry' : 'start' });
    try {
      const sectionInput = {
        ...input,
        evidence: input.evidence,
        projectContext: input.projectContext,
        roleContext: input.roleContext || '',
        factCoverageContext: input.factCoverageContext,
        sectionTitle: item.title,
        targetWords: item.targetWords,
        maxWords: input.maxWords ? Math.max(item.targetWords, Math.ceil(input.maxWords / targets.length)) : Math.ceil(item.targetWords * 1.12),
        timeoutMs: Math.max(120000, Math.min(300000, Math.ceil(timeoutMsForChapter(item.targetWords) * 0.55))),
      };
      const content = item.targetWords >= 1400
        ? await buildTaskBasedSectionContent(sectionInput)
        : await buildQualifiedSectionSupplement(sectionInput, sectionSupplementAttempts(targets.length));
      if (content) {
        completedCount += 1;
        input.onSectionProgress?.({ completed: completedCount, total: targets.length, sectionTitle: item.title, phase: 'complete' });
      }
      return content;
    } catch (error) {
      console.warn(`[document-workflow] 小节生成失败：${input.chapter.title} / ${item.title}`, error);
      return undefined;
    }
  };
  for (let offset = 0; offset < targets.length; offset += concurrency) {
    throwIfAborted(input.signal);
    const batch = targets.slice(offset, offset + concurrency);
    const batchResults = await Promise.all(batch.map(item => runSection(item)));
    batchResults.forEach((content, index) => { results[offset + index] = content; });
  }
  let missingIndexes = results.map((content, index) => content ? -1 : index).filter(index => index >= 0);
  for (let offset = 0; offset < missingIndexes.length; offset += concurrency) {
    throwIfAborted(input.signal);
    const batchIndexes = missingIndexes.slice(offset, offset + concurrency);
    const batchResults = await Promise.all(batchIndexes.map(index => runSection(targets[index], true)));
    batchResults.forEach((content, index) => { if (content) results[batchIndexes[index]] = content; });
  }
  missingIndexes = results.map((content, index) => content ? -1 : index).filter(index => index >= 0);
  for (const index of missingIndexes) {
    throwIfAborted(input.signal);
    const target = targets[index];
    const content = await runSection({ ...target, targetWords: Math.max(target.targetWords, 900) }, true);
    if (content) results[index] = content;
  }
  const sectionContents = results.map((content, index) => ensureNonEmptySectionContent(content || fallbackPlannedSectionContent(targets[index].title), targets[index].title));
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${sectionContents.join('\n\n')}`, input.forbidDrawingImages));
}

export function outputTokensForChapter(minWords: number, targetWords?: number) {
  const words = targetWords || minWords;
  return Math.min(32000, Math.max(6000, Math.ceil(words * 1.6)));
}

export function timeoutMsForChapter(targetWords?: number) {
  const words = targetWords || 1200;
  if (words >= 8000) return 360000;
  if (words >= 5000) return 300000;
  if (words >= 3000) return 240000;
  return 180000;
}

export function expansionRoundsForDeficit(deficitChars: number) {
  if (deficitChars <= 0) return 0;
  return Math.max(1, Math.ceil(deficitChars / 4000));
}

export function acceptExpandedChapter(previous: string, next: string, chapterTitle: string, targetChars: number, maxChars = Math.ceil(targetChars * 1.12)) {
  const beforeLength = documentTextLength(previous);
  const afterLength = documentTextLength(next);
  const normalizedTitle = displayChapterTitle(chapterTitle);
  const remaining = Math.max(0, targetChars - beforeLength);
  const minimumGrowth = Math.min(300, Math.max(80, Math.floor(remaining * 0.2)));
  if (afterLength > maxChars) return false;
  if (remaining > 0 && afterLength < beforeLength + minimumGrowth) return false;
  if (afterLength < beforeLength * 0.98) return false;
  if (normalizedTitle && !next.includes(normalizedTitle)) return false;
  return true;
}

export async function expandChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; currentContent: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; maxChars?: number; forbidDrawingImages: boolean; maxTokens?: number; signal?: AbortSignal }) {
  const currentLength = documentTextLength(input.currentContent);
  const maxChars = input.maxChars ?? Math.ceil(input.targetChars * 1.12);
  const missing = input.targetChars - currentLength;
  if (currentLength >= maxChars || missing <= 300) return input.currentContent;
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, input.evidence), { maxChars: evidencePromptBudgetForTarget(Math.ceil(input.targetChars / 2), 6000, 16000) });
  const expanded = await callDocumentLlm([
    '你是章节正文扩写专家。你的任务是在保持章节结构和已有内容连续性的基础上，对当前章节进行局部扩写、补充和衔接优化。',
    FORMAL_WRITING_RULES,
    '返回扩写后的完整本章 Markdown，而不是整篇文档；必须保留本章一级标题，不得新增、删除或重命名一级章节。',
    '不得删除、压缩、总结已有正文中的有效事实和已成文内容；可以在已有二级小节内部补充段落、补充三级小节、补充表格前后说明、增强段落衔接。',
    '可以对局部语句做轻微衔接性改写，但不得改变事实含义，不得减少有效字数；不得把所有新增内容堆到章末，应优先补到对应的小节或语义位置。',
    SECTION_GENERATION_SAFETY_RULES,
    '不得输出“已满足要求”“由于信息有限”“以下是补充”等说明性话术。',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    `章节标题：${input.chapter.title}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    `当前本章有效字数约 ${currentLength} 字，目标约 ${input.targetChars} 字，最多不超过 ${maxChars} 字；本轮只补足必要缺口，不要过度展开。`,
    '扩写重点：围绕尚未充分展开的对象范围、关键事实、执行要求、资源条件、风险约束、检查确认和结果说明补充。材料没有新的精确数值时，可以扩展过程性正文，但不得编造具体数值。',
    input.roleContext,
    evidenceText ? `绑定材料：\n${evidenceText}` : '',
    '当前章节 Markdown 分片（必须保留并覆盖全部已有内容，不得只基于末尾扩写）：',
    chunkTextForReview(input.currentContent, 12000),
  ].filter(Boolean).join('\n\n'), false, { maxTokens: input.maxTokens ?? outputTokensForChapter(currentLength, input.targetChars), temperature: 0.25, signal: input.signal });
  if (!expanded || expanded.length < 120) return input.currentContent;
  const normalized = sanitizeFormalMarkdown(removeUnwantedDrawingImages(expanded.startsWith('## ') ? expanded : `## ${input.chapter.title}\n\n${expanded}`, input.forbidDrawingImages));
  return acceptExpandedChapter(input.currentContent, normalized, input.chapter.title, input.targetChars, maxChars) ? normalized : input.currentContent;
}

export function mergeSectionSupplementBody(currentBody: string, replacementBody: string) {
  const current = currentBody.trim();
  const replacement = replacementBody.trim();
  if (!replacement) return '';
  if (!current) return replacement;
  if (current.includes(replacement)) return '';
  if (replacement.includes(current)) return replacement.slice(replacement.indexOf(current) + current.length).trim();
  const currentTail = current.slice(-240);
  const overlapAt = currentTail.length >= 80 ? replacement.indexOf(currentTail) : -1;
  if (overlapAt >= 0) return replacement.slice(overlapAt + currentTail.length).trim();
  return replacement;
}

export function replaceSectionContent(markdown: string, sectionTitle: string, replacement: string) {
  const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`(^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n)([\\s\\S]*?)(?=^#{3,4}\\s+|^##\\s+|$)`, 'mu');
  const normalizedReplacement = replacement.trim().replace(/^#{3,4}\s+(?:\d+(?:\.\d+)*\s+)?[^\n]+\n+/u, '').trim();
  if (pattern.test(markdown)) {
    return markdown.replace(pattern, (_match, heading: string, body: string) => {
      const supplement = mergeSectionSupplementBody(body, normalizedReplacement);
      return supplement ? `${heading}${body.trim()}\n\n${supplement}\n\n` : `${heading}${body.trim()}\n\n`;
    });
  }
  return normalizedReplacement ? `${markdown.trim()}\n\n### ${sectionTitle}\n\n${normalizedReplacement}` : markdown;
}

function sectionSupplementQualityIssue(sectionTitle: string, content: string) {
  const body = content.replace(/^#{3,4}\s+.*\n+/u, '').split(/\r?\n/u)
    .filter(line => !/^\s*\|/u.test(line))
    .filter(line => !/^\s*\|?\s*:?-{3,}:?/u.test(line))
    .join('\n');
  const effectiveLength = documentTextLength(body);
  if (effectiveLength < 360) return `正文有效内容不足：${sectionTitle} 当前约 ${effectiveLength} 字`;
  if (/资料未提供|信息有限|无法确定|待补充|建议补充更多资料|以下是|本文档|本小节围绕/u.test(body)) return `存在空泛或说明性话术：${sectionTitle}`;
  return undefined;
}

function sectionSupplementAttempts(totalTargets: number) {
  const configured = Number(process.env.DOCUMENT_SECTION_SUPPLEMENT_ATTEMPTS ?? 1);
  return Math.max(1, Math.min(2, Number.isFinite(configured) ? Math.floor(configured) : 1, totalTargets));
}

async function buildQualifiedSectionSupplement(input: Parameters<typeof buildLlmSectionContent>[0], maxAttempts: number) {
  let feedback: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const generated = await buildLlmSectionContent({ ...input, qualityFeedback: feedback });
    if (!generated) {
      feedback = '上一轮未生成有效正文，请重新生成完整小节正文。';
      continue;
    }
    const issue = sectionSupplementQualityIssue(input.sectionTitle, generated);
    if (!issue) return generated;
    feedback = issue;
  }
  return undefined;
}

export async function supplementShortSections(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; maxSectionConcurrency?: number; forcedSections?: MarkdownSectionContentGap[]; signal?: AbortSignal }) {
  const plannedTargets = sectionTargets(input.chapter, input.targetWords);
  const targetByTitle = new Map(plannedTargets.map(target => [target.title, target]));
  const forcedTargets = (input.forcedSections || [])
    .filter(gap => gap.chapterTitle === input.chapter.title && (gap.planned || gap.reason === 'missing_planned_section' || gap.reason === 'empty'))
    .map(gap => ({ title: gap.sectionTitle, targetWords: Math.max(420, targetByTitle.get(gap.sectionTitle)?.targetWords || Math.floor(input.targetWords / Math.max(1, plannedTargets.length || input.forcedSections?.length || 1))), forced: true }));
  const targets = [...plannedTargets];
  for (const forced of forcedTargets) {
    if (!targets.some(target => target.title === forced.title)) targets.push(forced);
  }
  if (targets.length < 1) return input.content;
  let content = input.content;
  const forcedTitleSet = new Set(forcedTargets.map(target => target.title));
  const supplementTargets = targets.map(target => {
    const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = content.match(new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^#{3,4}\\s+|^##\\s+|$)`, 'mu'));
    const currentWords = documentTextLength(match?.[1] || '');
    const isEmptyOrNearlyEmpty = currentWords < 80;
    const forced = forcedTitleSet.has(target.title);
    return { ...target, currentWords, priority: forced ? 0 : isEmptyOrNearlyEmpty ? 1 : 2, forced };
  }).filter(target => target.forced || target.currentWords < Math.max(360, Math.floor(target.targetWords * 0.7)))
    .sort((a, b) => a.priority - b.priority || a.currentWords - b.currentWords);
  const supplements = new Map<string, string | undefined>();
  const configuredConcurrency = Number(process.env.DOCUMENT_SECTION_SUPPLEMENT_CONCURRENCY ?? process.env.DOCUMENT_SECTION_CONCURRENCY ?? input.maxSectionConcurrency ?? 2);
  const concurrency = Math.max(1, Math.min(supplementTargets.length || 1, 2, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : 2));
  for (let offset = 0; offset < supplementTargets.length; offset += concurrency) {
    const batch = supplementTargets.slice(offset, offset + concurrency);
    const remainingRoom = input.maxWords ? Math.max(0, input.maxWords - documentTextLength(content)) : Number.POSITIVE_INFINITY;
    const perSectionRoom = Number.isFinite(remainingRoom) && remainingRoom > 200 ? Math.max(260, Math.floor(remainingRoom / batch.length)) : undefined;
    const attempts = sectionSupplementAttempts(supplementTargets.length);
    const batchResults = await Promise.all(batch.map(async target => {
      try {
        const targetWords = Math.max(350, Math.min(target.targetWords - target.currentWords, 900));
        return await buildQualifiedSectionSupplement({
          ...input,
          evidence: input.evidence,
          sectionTitle: target.title,
          targetWords,
          maxWords: perSectionRoom ? Math.min(perSectionRoom, 1200) : 1200,
          timeoutMs: Math.max(90000, Math.min(150000, Math.ceil(timeoutMsForChapter(targetWords) * 0.45))),
        }, attempts);
      } catch {
        return undefined;
      }
    }));
    batch.forEach((target, index) => { supplements.set(target.title, batchResults[index]); });
  }
  for (const target of supplementTargets) {
    const supplement = supplements.get(target.title);
    if (supplement) content = replaceSectionContent(content, target.title, supplement);
  }
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(content, input.forbidDrawingImages));
}

export async function expandChapterToTarget(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; maxChars?: number; forbidDrawingImages: boolean; maxTokens?: number; signal?: AbortSignal; strictBudget?: boolean }) {
  let content = input.content;
  let rounds = 0;
  const maxRounds = input.strictBudget ? expansionRoundsForDeficit(input.targetChars - documentTextLength(content)) : Math.min(1, expansionRoundsForDeficit(input.targetChars - documentTextLength(content)));
  const maxChars = input.maxChars ?? Math.ceil(input.targetChars * 1.12);
  for (; rounds < maxRounds && documentTextLength(content) < input.targetChars && documentTextLength(content) < maxChars; rounds += 1) {
    throwIfAborted(input.signal);
    const before = content;
    try {
      const currentChars = documentTextLength(content);
      const incrementalTarget = Math.min(input.targetChars, currentChars + (input.strictBudget ? 5600 : 3200));
      const expanded = await callWithTimeout(
        signal => expandChapterContent({
          template: input.template,
          chapter: input.chapter,
          currentContent: content,
          evidence: input.evidence,
          promptTexts: input.promptTexts,
          requirement: input.requirement,
          roleContext: input.roleContext,
          targetChars: incrementalTarget,
          maxChars: Math.min(maxChars, currentChars + (input.strictBudget ? 7000 : 4200)),
          forbidDrawingImages: input.forbidDrawingImages,
          maxTokens: Math.min(input.maxTokens ?? outputTokensForChapter(currentChars, incrementalTarget), outputTokensForChapter(currentChars, incrementalTarget)),
          signal,
        }),
        120000,
        input.signal,
      );
      if (!expanded || expanded === before) break;
      content = expanded;
    } catch {
      break;
    }
  }
  return { content, rounds };
}


export async function expandDocumentToBudget(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; budget: DocumentBudget; promptTexts: string; requirement?: string; forbidDrawingImages: boolean; signal?: AbortSignal }) {
  if (!input.budget.minChars) return input.chapters;
  let chapters = input.chapters;
  let totalChars = documentTextLength(chapters.map(chapter => chapter.content).join('\n\n'));
  const maxDocumentRounds = Math.min(input.budget.longformStrict ? 3 : 1, expansionRoundsForDeficit(input.budget.minChars - totalChars));
  const configuredConcurrency = Number(process.env.DOCUMENT_BUDGET_EXPAND_CONCURRENCY ?? 2);
  const concurrency = Math.max(1, Math.min(input.chapters.length || 1, input.budget.longformStrict ? 3 : 2, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : 2));
  const lowGrowthChapterIds = new Set<string>();
  const documentMaxChars = input.budget.maxChars;
  for (let round = 0; round < maxDocumentRounds && totalChars < input.budget.minChars && (!documentMaxChars || totalChars < documentMaxChars); round += 1) {
    throwIfAborted(input.signal);
    const roundStartChars = totalChars;
    const deficits = chapters
      .map(chapter => {
        const target = input.budget.chapterTargets.get(chapter.id) || 0;
        const current = documentTextLength(chapter.content);
        return { chapter, target, current, deficit: target - current };
      })
      .filter(item => item.deficit > 500 && !lowGrowthChapterIds.has(item.chapter.id))
      .sort((a, b) => b.deficit - a.deficit);
    if (deficits.length === 0) break;
    for (let offset = 0; offset < deficits.length && totalChars < input.budget.minChars && (!documentMaxChars || totalChars < documentMaxChars); offset += concurrency) {
      throwIfAborted(input.signal);
      const remainingDocumentRoom = documentMaxChars ? Math.max(0, documentMaxChars - totalChars) : Number.POSITIVE_INFINITY;
      if (remainingDocumentRoom <= 300) break;
      const batchSize = documentMaxChars ? Math.max(1, Math.min(concurrency, Math.floor(remainingDocumentRoom / 800) || 1)) : concurrency;
      const batch = deficits.slice(offset, offset + batchSize);
      const perChapterRoom = Number.isFinite(remainingDocumentRoom) ? Math.max(500, Math.floor(remainingDocumentRoom / batch.length)) : undefined;
      const results = await Promise.all(batch.map(async item => {
        try {
          const incrementalTarget = Math.min(item.target, item.current + Math.max(input.budget.longformStrict ? 3600 : 1200, Math.min(item.deficit, input.budget.longformStrict ? 7600 : 3200)));
          const maxChars = perChapterRoom ? Math.min(Math.ceil(incrementalTarget * 1.12), item.current + perChapterRoom) : Math.ceil(incrementalTarget * 1.12);
          const expanded = await expandChapterToTarget({ template: input.template, chapter: { id: item.chapter.id, title: item.chapter.title, purpose: item.chapter.title, queries: [], requiredFacts: [], sections: item.chapter.sections }, content: item.chapter.content, evidence: item.chapter.evidence, promptTexts: input.promptTexts, requirement: input.requirement, roleContext: '', targetChars: incrementalTarget, maxChars, forbidDrawingImages: input.forbidDrawingImages, maxTokens: outputTokensForChapter(item.current, incrementalTarget), signal: input.signal, strictBudget: input.budget.longformStrict });
          return { id: item.chapter.id, beforeChars: item.current, content: expanded.content };
        } catch {
          return { id: item.chapter.id, beforeChars: item.current, content: item.chapter.content };
        }
      }));
      for (const result of results) {
        const afterChars = documentTextLength(result.content);
        if (afterChars <= result.beforeChars + 300) lowGrowthChapterIds.add(result.id);
        chapters = chapters.map(chapter => chapter.id === result.id ? { ...chapter, content: result.content } : chapter);
      }
      totalChars = documentTextLength(chapters.map(chapter => chapter.content).join('\n\n'));
    }
    if (totalChars <= roundStartChars + (input.budget.longformStrict ? 80 : 300)) break;
  }
  return chapters;
}


export async function reviewChapterSummaries(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; budget: DocumentBudget; promptTexts: string; requirement?: string; strategy: DocumentGenerationStrategy; diagnostics: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  const startedAt = Date.now();
  const concurrency = Math.max(1, Math.min(input.strategy.maxChapterReviewConcurrency, Number(process.env.DOCUMENT_CHAPTER_REVIEW_CONCURRENCY ?? input.strategy.maxChapterReviewConcurrency)));
  const summaries: ChapterReviewSummary[] = new Array(input.chapters.length);
  for (let offset = 0; offset < input.chapters.length; offset += concurrency) {
    throwIfAborted(input.signal);
    const batch = input.chapters.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async chapter => {
      const target = input.budget.chapterTargets.get(chapter.id) || 1200;
      const localIssues = lightweightChapterIssues({ chapter: input.template.chapters.find(item => item.id === chapter.id) || { id: chapter.id, title: chapter.title, purpose: '', queries: [], requiredFacts: [], sections: chapter.sections }, content: chapter.content, missingFacts: chapter.missingFacts, targetWords: target });
      const chapterReviewPlan = adaptiveReviewPlan({ totalChars: documentTextLength(chapter.content), chapterCount: 1, chunkChars: 12000, phase: 'chapter' });
      const chunks = splitTextForReview(chapter.content, 12000).slice(0, chapterReviewPlan.chunks);
      const chunkReviews = [] as Array<ReturnType<typeof parseReviewJson>>;
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        if (Date.now() - startedAt > chapterReviewPlan.ms) break;
        throwIfAborted(input.signal);
        const chunk = chunks[chunkIndex] || '';
        const reviewed = await callDocumentLlm([
          '你是章节质量审查员。只输出 JSON，不重写正文。',
          '检查维度：章节是否围绕标题、必需事实是否覆盖、是否有占位符/提示词泄露、是否存在重复标题、是否缺少专业闭环、是否明显低于目标深度。',
          input.promptTexts,
        ].filter(Boolean).join('\n\n'), [
          `章节：${chapter.title}`,
          `目标深度：约 ${target} 字；当前 ${documentTextLength(chapter.content)} 字。`,
          input.requirement ? `用户要求：${input.requirement}` : '',
          chapter.missingFacts.length ? `未覆盖事实：${chapter.missingFacts.join('、')}` : '',
          localIssues.length ? `本地检查问题：${localIssues.join('；')}` : '',
          `章节正文片段 ${chunkIndex + 1}/${chunks.length}（必须检查该片段，不要假设其他片段已合格）：`,
          chunkPrompt(chunk, chunkIndex, chunks.length),
          '请返回 JSON：{"status":"pass|warn|fail","issues":["..."],"suggestions":["..."]}',
        ].filter(Boolean).join('\n'), true, { maxTokens: 1200, temperature: 0, signal: input.signal, diagnostics: input.diagnostics, timeoutMs: Math.max(30_000, Number(process.env.DOCUMENT_REVIEW_LLM_CALL_TIMEOUT_MS ?? 90_000)) });
        chunkReviews.push(parseReviewJson(reviewed));
      }
      const parsedIssues = mergeUniqueStrings(chunkReviews.flatMap(item => Array.isArray(item?.issues) ? item!.issues! : [])).slice(0, chapterReviewPlan.issues);
      const parsedSuggestions = mergeUniqueStrings(chunkReviews.flatMap(item => Array.isArray(item?.suggestions) ? item!.suggestions! : [])).slice(0, chapterReviewPlan.issues);
      const hasChunkFail = chunkReviews.some(item => item?.status === 'fail');
      const hasChunkWarn = chunkReviews.some(item => item?.status === 'warn');
      const issues = mergeUniqueStrings([...localIssues, ...parsedIssues]);
      const blockingLocalIssue = localIssues.some(issue => /缺少规划小节|规划小节正文过短|空小节|只有标题|只有表格|正文篇幅明显低于目标|低于目标|缺失|占位|泄露|不足/u.test(issue));
      const status = hasChunkFail || blockingLocalIssue ? 'fail' : hasChunkWarn || issues.length > 0 ? 'warn' : 'pass';
      return { chapterId: chapter.id, title: chapter.title, status, issues, suggestions: parsedSuggestions, chars: documentTextLength(chapter.content) } as ChapterReviewSummary;
    }));
    results.forEach((summary, index) => { summaries[offset + index] = summary; });
  }
  const failCount = summaries.filter(item => item.status === 'fail').length;
  const warnCount = summaries.filter(item => item.status === 'warn').length;
  return {
    summaries,
    stage: displayStage({ type: 'llm_review' as const, roleId: 'chapter-review', status: failCount > 0 ? 'fallback' : 'success', message: elapsedMessage(`章节级质量审查完成：通过 ${summaries.length - failCount - warnCount} 章，警告 ${warnCount} 章，失败 ${failCount} 章`, startedAt) }, { subtitle: '章节级质量审查' }),
  };
}

export async function reviewGlobalConsistency(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; chapterReviews: ChapterReviewSummary[]; promptTexts: string; requirement?: string; projectContext?: string; diagnostics: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  const startedAt = Date.now();
  const totalChars = input.chapters.reduce((sum, chapter) => sum + documentTextLength(chapter.content), 0);
  const reviewPlan = adaptiveReviewPlan({ totalChars, chapterCount: input.chapters.length, chunkChars: 8000, phase: 'global' });
  const maxIssues = reviewPlan.issues;
  const outline = input.chapters.map(chapter => {
    const review = input.chapterReviews.find(item => item.chapterId === chapter.id);
    const issues = review?.issues || [];
    return `- ${chapter.title}：${documentTextLength(chapter.content)} 字；审查=${review?.status || 'unknown'}；问题数=${issues.length}；问题=${issues.join('；') || '无'}`;
  }).join('\n');
  const chapterSummaries = input.chapters.map(summarizeChapterForConsistency).join('\n\n---\n\n');
  throwIfAborted(input.signal);
  const reviewed = await callDocumentLlm([
    '你是长文档全局一致性审查专家。只基于章节摘要检查跨章节一致性，不重写正文。',
    '重点检查：章节之间信息冲突、术语不一致、重复堆砌、目录层级异常、关键要求缺失、前后矛盾、上下文衔接断裂。',
    '摘要不足以判断的问题只能标记为需复核，不得臆测正文问题。',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `上下文摘要：\n${input.projectContext}` : '',
    '章节审查摘要：',
    outline,
    '章节内容摘要（用于全文一致性审查，不是完整正文）：',
    chapterSummaries,
    `请输出不超过 ${maxIssues} 条跨章节问题清单和建议；没有明确问题则返回“无明显跨章节冲突”。不要返回全文。`,
  ].filter(Boolean).join('\n'), false, { maxTokens: Math.max(1400, Math.min(3200, maxIssues * 180)), temperature: 0, signal: input.signal, diagnostics: input.diagnostics, timeoutMs: Math.max(30_000, Number(process.env.DOCUMENT_REVIEW_LLM_CALL_TIMEOUT_MS ?? 90_000)) });
  const parsedReview = parseReviewJson(reviewed);
  const parsedIssues = parsedReview
    ? mergeUniqueStrings([...(parsedReview.issues || []), ...(parsedReview.repairInstructions || []), parsedReview.repair].map(reviewItemToString))
    : [];
  const issues = (parsedIssues.length ? parsedIssues : mergeUniqueStrings((reviewed || '')
    .replace(/```(?:json)?[\s\S]*?```/gu, '')
    .split('\n')
    .map(line => line.replace(/^[-*\d.、\s]+/u, '').trim())
    .filter(line => line.length > 6 && !/[{}[\]":,]|无明显|未发现明显|没有明确/u.test(line))))
    .slice(0, maxIssues);
  return {
    issues,
    stage: displayStage({ type: 'llm_review' as const, roleId: 'global-consistency-review', status: issues.length > 0 ? 'fallback' : 'success', message: elapsedMessage(issues.length > 0 ? `摘要化全局一致性审查发现 ${issues.length} 个需关注问题` : '摘要化全局一致性审查未发现明显跨章节冲突', startedAt) }, { subtitle: '全局一致性审查' }),
  };
}

/** 对生成的 Markdown 进行非重写式审查，只产出质量状态，不接管正文。 */
export async function reviewAndOptimizeMarkdown(input: {
  template: DocumentTemplate;
  spec?: AutoDocumentSpecPackage;
  markdown: string;
  evidence: DocumentEvidence[];
  promptTexts: string;
  projectContext: string;
  requirement?: string;
  diagnostics?: DocumentGenerationDiagnostics;
  signal?: AbortSignal;
}): Promise<{ markdown: string; stage: DocumentExecutionStage }> {
  throwIfAborted(input.signal);
  const startedAt = Date.now();
  const reviewPlan = adaptiveReviewPlan({ totalChars: documentTextLength(input.markdown), chapterCount: input.template.chapters.length || 1, chunkChars: 12000, phase: 'final' });
  const maxReviewMs = reviewPlan.ms;
  const maxIssues = reviewPlan.issues;
  const reviewBundle = buildEvidenceBundle({ id: 'review', title: '最终质量审查', purpose: '审查全文证据和资源关系', queries: [], requiredFacts: [] }, input.evidence);
  const evidenceDigest = evidenceBundlePrompt(reviewBundle, { maxChars: evidencePromptBudgetForTarget(documentTextLength(input.markdown), 8000, 18000) });
  const specDigest = input.spec ? [
    `结构化检查摘要：${input.spec.name}`,
    `关注事实：${input.spec.factFields.map(field => field.name).join('、')}`,
    `章节检查项：${input.spec.chapterRules.map(rule => `${rule.title}${rule.minWords ? `约${rule.minWords}字` : ''}`).join('、') || '以当前模板章节为准'}`,
    `通用质量提醒：${input.spec.gateRules.map(rule => `${rule.name}:${rule.type}`).join('、')}`,
    '约束：以上只用于质量检查，不得新增、删除、重排或重写用户/模板章节。',
  ].join('\n') : '未生成结构化检查摘要。';
  const chunks = splitTextForReview(input.markdown, 12000).slice(0, reviewPlan.chunks);
  const reviewedBatches: Array<{ passed?: boolean; score?: number; issues?: Array<{ type?: string; severity?: string; location?: string; message?: string }> } | null | undefined> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    throwIfAborted(input.signal);
    if (Date.now() - startedAt > maxReviewMs) break;
    const chunk = chunks[index] || '';
    reviewedBatches.push(await callDocumentLlmJson<{ passed?: boolean; score?: number; issues?: Array<{ type?: string; severity?: string; location?: string; message?: string }> }>([
      '你是文档质量审查专家。只检查问题，不重写正文，不输出完整文档。',
      '准确性优先级：用户需求/模板结构/提示词角色 > 绑定文件证据 > 上下文/历史记忆。内部优先级只用于判断事实，不得写入正文。',
      '重点检查：章节完整性、绑定材料事实使用、参数数字准确性、冲突事实、异常对象名、表格呈现、导出友好性、系统提示泄露。',
      '只返回 JSON 审查结果；不得返回优化后的完整 Markdown。',
      '返回格式：{"passed":true,"score":90,"issues":[{"type":"...","severity":"low|medium|high","location":"...","message":"..."}]}',
      input.promptTexts,
    ].filter(Boolean).join('\n\n'), [
      `模板：${input.template.name}`,
      input.requirement ? `用户要求：${input.requirement}` : '',
      input.projectContext ? `上下文/历史记忆：\n${input.projectContext}` : '',
      specDigest,
      '知识库证据摘要：',
      evidenceDigest,
      `待审查初稿片段 ${index + 1}/${chunks.length}（必须检查该片段章节完整性、空小节和事实冲突）：`,
      chunkPrompt(chunk, index, chunks.length),
      '请只返回 JSON 审查结果，不要返回全文。',
    ].filter(Boolean).join('\n'), { maxTokens: 1600, temperature: 0, signal: input.signal, diagnostics: input.diagnostics, timeoutMs: Math.max(30_000, Number(process.env.DOCUMENT_REVIEW_LLM_CALL_TIMEOUT_MS ?? 90_000)) }));
  }
  throwIfAborted(input.signal);
  const issues = reviewedBatches.flatMap(item => Array.isArray(item?.issues) ? item!.issues!.filter(issue => issue?.message) : []).slice(0, maxIssues);
  const budgetExceeded = Date.now() - startedAt > maxReviewMs;
  const severeCount = issues.filter(item => item.severity === 'high').length;
  const scores = reviewedBatches.map(item => Number(item?.score)).filter(Number.isFinite);
  const score = scores.length ? Math.round(scores.reduce((sum, item) => sum + item, 0) / scores.length) : undefined;
  const summary = stageIssueSummary(issues.map(item => `${item.severity || 'medium'}:${item.location || item.type || '全文'}-${item.message}`), '未发现明显质量问题');
  return {
    markdown: input.markdown,
    stage: {
      type: 'llm_review',
      roleId: 'llm-review',
      status: severeCount > 0 || budgetExceeded ? 'fallback' : reviewedBatches.length > 0 ? 'success' : 'skipped',
      message: reviewedBatches.length > 0 ? `已完成预算化结构化非重写式质量审查${score !== undefined ? `，评分 ${score}` : ''}${budgetExceeded ? '，已达到审查预算' : ''}：${summary}` : '无可用模型或审查结果不可用，保留生成初稿',
    },
  };
}

export function formatContextEntries(entries: ReturnType<typeof recallDocumentContexts>) {
  return entries.length > 0
    ? entries.map((entry, index) => `${index + 1}. [${entry.type}/${entry.importance}] ${entry.content}${entry.source ? `（来源：${entry.source}）` : ''}`).join('\n')
    : '';
}
