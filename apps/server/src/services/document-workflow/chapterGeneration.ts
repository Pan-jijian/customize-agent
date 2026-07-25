import * as fs from 'node:fs';
import * as path from 'node:path';
import { createProvider } from '@customize-agent/llm';
import type { recallDocumentContexts } from '../context/contextService';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { TechnicalFactAssignment } from '../document-validation/engineeringTechnicalFactService';
import type { ChapterReviewSummary, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentGenerationStrategy, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from './types';
import type { DocumentBudget } from './budget';
import { documentTextLength } from './budget';
import { buildEvidenceBundle, cleanEvidenceText, evidenceBundlePrompt } from './evidence';
import { FORMAL_WRITING_RULES, removeUnwantedDrawingImages, sanitizeFormalMarkdown } from './markdownComposer';
import { callDocumentLlm, callDocumentLlmJson, callWithTimeout, getActiveModelWithProvider, providerFactoryName } from './llmClient';
import { stringifyFactValue, throwIfAborted } from './utils';
import type { ProjectBasicFact, RoleNodeFact, TenderPlanChapter } from './rolePipeline';
import { analyzePromptIntent, lightweightChapterIssues, readSectionDraftCache, writeSectionDraftCache } from './rolePipeline';
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

export async function understandReferenceFiles(projectRoot: string, evidence: DocumentEvidence[], signal?: AbortSignal): Promise<{ notes: string[]; stage: DocumentExecutionStage }> {
  const active = getActiveModelWithProvider();
  if (!active?.provider.capabilities?.fileUnderstanding && !active?.provider.capabilities?.imageUnderstanding) {
    return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '当前模型未开启文件理解/图片理解能力' } };
  }
  throwIfAborted(signal);
  const provider = createProvider(providerFactoryName(active.model.provider, active.provider), { baseUrl: active.provider.baseUrl, apiKey: active.provider.apiKey, modelName: active.model.name, directEndpoint: active.provider.directEndpoint });
  const fileAwareProvider = provider as typeof provider & { understandFiles?: (files: Array<{ name: string; mimeType: string; data: Buffer }>, prompt: string, options?: { maxTokens?: number; signal?: AbortSignal }) => Promise<{ content: string }> };
  if (!fileAwareProvider.understandFiles) return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '当前 Provider 未实现文件理解接口' } };
  const candidates = [...new Set(evidence.map(item => item.filePath).filter(file => /\.(png|jpe?g|webp|pdf|docx|xlsx)$/iu.test(file)))].slice(0, 6);
  const files = candidates.map(filePath => {
    const absolute = path.join(projectRoot, 'knowledgeBase', filePath);
    return fs.existsSync(absolute) ? { name: path.basename(filePath), mimeType: mimeTypeFromPath(filePath), data: fs.readFileSync(absolute) } : undefined;
  }).filter(Boolean) as Array<{ name: string; mimeType: string; data: Buffer }>;
  if (files.length === 0) return { notes: [], stage: { type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '没有可发送给多模态模型的参考文件' } };
  try {
    throwIfAborted(signal);
    const response = await fileAwareProvider.understandFiles(files, '请阅读这些参考图片/文件，提炼可用于文档生成和审查的事实、视觉要点、地图信息和封面设计建议。请用中文要点输出。', { maxTokens: 1200, signal });
    throwIfAborted(signal);
    const note = response.content.trim();
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
  if (factsModel.conflicts.length > 0) issues.push(...factsModel.conflicts.map(message => ({ level: 'error' as const, message })));
  return issues;
}

export function buildChapterFactCoverageContext(input: { chapter: DocumentTemplateChapter; plan?: TenderPlanChapter; spec?: AutoDocumentSpecPackage; roleFacts: Array<{ fact: RoleNodeFact }>; technicalFactAssignment: TechnicalFactAssignment; projectBasicFacts: ProjectBasicFact[]; evidence: DocumentEvidence[]; missingFacts: string[] }) {
  const specRule = input.spec?.chapterRules.find(rule => rule.id === input.chapter.id || rule.title === input.chapter.title);
  const specFactNames = (specRule?.requiredFactIds || [])
    .map(id => input.spec?.factFields.find(field => field.id === id)?.name)
    .filter(Boolean) as string[];
  const requiredFacts = [...new Set([
    ...input.chapter.requiredFacts,
    ...specFactNames,
    ...(input.plan?.requiredContents || []),
    ...(input.plan?.evidenceNeeds || []),
  ].filter(Boolean))].slice(0, 18);
  const roleFactLines = input.roleFacts.slice(0, 10).map(({ fact }) => `- ${fact.key}：${cleanEvidenceText(stringifyFactValue(fact.value)).slice(0, 180)}`);
  const structuredFactLines = input.technicalFactAssignment.facts.slice(0, 14).map(fact => {
    const values = [...(fact.quantities || []), ...(fact.scheduleValues || []), ...(fact.resourceValues || []), ...(fact.standard || []), fact.parameter || '', fact.specification || ''].filter(Boolean).slice(0, 6).join('、');
    return `- ${[fact.discipline, fact.workItem].filter(Boolean).join('/') || fact.text.slice(0, 40)}${values ? `：${values}` : ''}`;
  });
  const projectLines = input.projectBasicFacts.slice(0, 8).map(fact => `- ${fact.key}：${fact.value}`);
  const evidenceSourceCount = new Set(input.evidence.map(item => item.filePath)).size;
  return [
    '【本章事实覆盖反馈】',
    requiredFacts.length ? `必须优先覆盖的事实/要求：\n${requiredFacts.map(item => `- ${item}`).join('\n')}` : '',
    roleFactLines.length ? `角色节点已抽取事实：\n${roleFactLines.join('\n')}` : '',
    structuredFactLines.length ? `结构化/量化事实：\n${structuredFactLines.join('\n')}` : '',
    projectLines.length ? `项目基础事实：\n${projectLines.join('\n')}` : '',
    input.missingFacts.length ? `当前检索未充分命中的事实：${input.missingFacts.join('、')}。如资料未明确提供，不得编造具体数值，应写成需要复核的条件、假设或处理措施。` : '',
    `本章可用资料来源约 ${evidenceSourceCount} 个文件，正文必须把可用事实内化到对应小节，不得单列后台资料清单。`,
  ].filter(Boolean).join('\n');
}

/** 使用 LLM 生成单章内容，基于证据包、提示词角色和用户需求 */
export async function buildLlmChapterContent(template: DocumentTemplate, chapter: DocumentTemplate['chapters'][number], evidence: DocumentEvidence[], missingFacts: string[], promptTexts: string, projectContext: string, requirement?: string, roleContext = '', options: { forbidDrawingImages?: boolean; minWords?: number; targetWords?: number; maxWords?: number; maxTokens?: number; technicalFactContext?: string; coverageMatrixContext?: string; projectBasicFactContext?: string; factCoverageContext?: string; signal?: AbortSignal } = {}) {
  const bundle = buildEvidenceBundle(chapter, evidence);
  const evidenceText = evidenceBundlePrompt(bundle);
  if (!evidenceText.trim() && !roleContext.trim()) return undefined;
  const promptIntent = analyzePromptIntent([promptTexts, requirement || ''].filter(Boolean).join('\n\n'));
  const sectionInstruction = chapter.sections?.length
    ? `本章必须完整包含以下二级小节，且每个小节都要有实质正文：\n${chapter.sections.map(section => `- ${section}`).join('\n')}`
    : (promptIntent.explicitStructure || promptIntent.explicitSections || promptIntent.lengthLimit || promptIntent.wantsConcise)
      ? '本章未预设二级小节；请优先遵循用户提示词和模板结构组织内容，不得因系统增强自行扩展小节。'
      : '本章未预设二级小节；必须根据章节主题、项目资料和专业写作需要生成 3-6 个正式二级小节，不得新增、删除或重排一级章节。';
  const sectionBudgetInstruction = buildSectionBudgetInstruction(chapter, options.targetWords || options.minWords || 0);
  const system = [
    '你是专业项目文档生成专家，必须严格使用已提供的内部资料生成正式文档章节。',
    FORMAL_WRITING_RULES,
    '准确性优先级：用户需求/模板章节 > 绑定提示词与角色节点结构化事实 > 知识库证据 > 后台内容优化建议 > 项目上下文/历史记忆。内部优先级只用于判断事实，不得写入正文。',
    '项目上下文/历史记忆只能作为用户偏好、历史纠偏和连续性参考；不得覆盖、替代或改写知识库证据中的事实。',
    '提示词角色只提供规则和格式约束；其中的示例、样例、占位项目名、编号、日期、数量和示例正文不得作为当前项目事实，不得写入正文。',
    options.forbidDrawingImages ? '图片类资料只作为文本事实依据；禁止插入图片或 Markdown 图片语法。' : '',
    '不要编造资料；可以基于证据做合理归纳；输出 Markdown；不要输出代码块。',
    promptTexts,
  ].filter(Boolean).join('\n\n');
  const prompt = [
    `文档模板：${template.name}`,
    `章节标题：${chapter.title}`,
    `章节目的：${chapter.purpose}`,
    sectionInstruction,
    sectionBudgetInstruction,
    requirement ? `用户要求：${requirement}` : '',
    projectContext ? `项目上下文/历史记忆（仅作偏好、历史纠偏和连续性参考；如与知识库证据冲突，以知识库证据为准）：\n${projectContext}` : '',
    options.projectBasicFactContext || '',
    roleContext ? roleContext : '',
    options.factCoverageContext || '',
    options.technicalFactContext || '',
    options.coverageMatrixContext || '',
    missingFacts.length ? `需要特别补足的事实：${missingFacts.join('、')}` : '',
    '请生成一个专业、充实、可直接导出的正式文档章节，要求：',
    `- 首轮生成必须尽量达到目标篇幅的 85%-95%；内容不少于 ${options.minWords || 1000} 字${options.targetWords ? `，目标约 ${options.targetWords} 字` : ''}${options.maxWords ? `，最多不超过 ${options.maxWords} 字` : ''}；不得依赖后续扩写补救，也不得过度展开。`,
    '- 保留章节标题；如模板配置了小节，必须按配置完整生成；如未配置小节且用户未限制结构，必须生成 3-6 个正式二级小节；每个二级小节必须有实质正文，不能只有标题或表格。',
    chapter.tableSections?.length ? `- 本章以下小节适合使用正式表格辅助表达：${chapter.tableSections.join('、')}；表格必须由正文归纳形成，禁止直接粘贴资料摘录。` : '',
    '- 表格只用于模板、用户要求或资料内容适合结构化表达的位置；表格前必须说明数据来源和适用范围，表格后必须说明控制措施、结论或执行要求，不能整节只有表格。',
    '- 不得使用“本节”“本章将”“以下从”“以下内容”等模板化前缀；标题后直接进入本章对象、关键事实、处理要求、控制措施和结果闭环。',
    '- 每个核心小节必须形成“对象/范围 → 依据/关键事实 → 执行或说明动作 → 控制要求 → 结果/责任闭环”的完整表达链条；具体术语以模板、用户要求和资料内容为准。',
    '- 二级小节下如需设置三级小节，必须使用“#### 章号.节号.序号 标题”，例如“#### 2.2.1 关键事项”；三级小节不纳入目录；不得使用无编号独立加粗行表示三级小节。',
    '- 必须使用模板节点提取的章节要求和输出规范；',
    '- 必须结合项目事实、表格数据、标准要求、约束条件等内部资料；',
    '- 对同一对象的事实应综合表达，优先写入准确的数量、单位、规格、参数、做法和标准；',
    '- 日期、数量、数值、规格、周期、资源、范围、对象等量化内容必须来自资料或明确推导；无依据时不得编造具体值。',
    '- 如果同一规则、方案、流程或措施适用于多个对象、区域、主体、片区或分项，必须逐项覆盖适用范围和对应依据，不得只写其中一个。',
    '- 对模板和资料中已经明确给出的关键事实、数量、时间、规格、标准、范围、对象、责任或约束，必须写入对应小节，不能只写原则性要求。',
    '- 严禁使用空泛占位表达替代资料事实；确实缺少资料时，只能写成待复核事项、约束条件或控制措施，不得编造具体数值。',
    '- 正文不得出现“知识库”“证据”“检索”“角色节点”“事实字段”“校验结果”等后台系统话术。',
    '- 存在事实冲突时，优先遵循用户要求、模板结构、绑定文件证据和提示词角色；后台内容优化建议仅作质量参考；',
    '- 默认不要引用原始文件名，不写解析器内部对象名；',
    '- 将资料要点自然融入正文，不单列系统证据或来源章节；',
    '- 小节层级保持适度，不要输出中间分析产物标题；',
    '- 组织关系、流程、职责、资源配置、风险控制等适合表格表达的内容可使用 Markdown 表格；',
    options.targetWords && options.targetWords >= 3500 ? '- 用户已提出较高篇幅目标，本章必须围绕每个二级小节充分展开对象范围、资料依据、关键事实、执行要求、风险约束、检查确认和责任闭环；不得用摘要式段落替代正文。' : '',
    '',
    evidenceText ? '内部资料：' : '',
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
  const minimum = targetWords >= sections.length * 700 ? 700 : Math.max(280, Math.floor(rawBase * 0.85));
  const base = Math.max(minimum, rawBase);
  return sections.map(section => ({ title: section, targetWords: base }));
}

export function buildSectionBudgetInstruction(chapter: DocumentTemplateChapter, targetWords: number) {
  const targets = sectionTargets(chapter, targetWords);
  if (targets.length === 0) return '';
  return [
    '本章小节篇幅计划（首轮生成应尽量一次达成，避免后续补写）：',
    ...targets.map(item => `- ${item.title}：约 ${item.targetWords} 字，至少达到 ${Math.floor(item.targetWords * 0.8)} 字，并覆盖对象/范围、依据/关键事实、处理要求、控制措施和结果闭环。`),
  ].join('\n');
}

export function tokenizeForRelevance(text: string) {
  return [...new Set((text.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9_-]{3,}/gu) || []).map(item => item.toLowerCase()))].slice(0, 40);
}

export function evidenceForSection(sectionTitle: string, chapter: DocumentTemplateChapter, evidence: DocumentEvidence[], limit = 45) {
  const tokens = tokenizeForRelevance([sectionTitle, chapter.title, ...(chapter.requiredFacts || [])].join(' '));
  const scored = evidence.map((item, index) => {
    const text = `${item.sectionTitle || ''}\n${item.content}`.toLowerCase();
    const hitScore = tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
    const sectionScore = item.sectionTitle && sectionTitle.includes(item.sectionTitle) || item.sectionTitle && item.sectionTitle.includes(sectionTitle) ? 4 : 0;
    return { item, score: hitScore + sectionScore + item.score * 0.1 - index * 0.001 };
  }).sort((a, b) => b.score - a.score);
  const selected = scored.filter(item => item.score > 0).slice(0, limit).map(item => item.item);
  return selected.length >= Math.min(12, evidence.length) ? selected : evidence.slice(0, limit);
}

export async function buildLlmSectionContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; sectionTitle: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; signal?: AbortSignal }) {
  const sectionEvidence = evidenceForSection(input.sectionTitle, input.chapter, input.evidence);
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, sectionEvidence));
  const prompt = [
    `文档模板：${input.template.name}`,
    `章节标题：${input.chapter.title}`,
    `当前二级小节：${input.sectionTitle}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `项目上下文：\n${input.projectContext}` : '',
    input.factCoverageContext || '',
    input.roleContext,
    input.missingFacts.length ? `需要特别补足的事实：${input.missingFacts.join('、')}` : '',
    `请只生成当前二级小节正文，使用“### ${input.sectionTitle}”作为小节标题，目标约 ${input.targetWords} 字${input.maxWords ? `，最多不超过 ${input.maxWords} 字` : ''}。`,
    '- 内容必须围绕当前小节，不得生成其他二级小节，不得重复章节一级标题。',
    '- 必须把资料中的关键事实、数量、时间、规格、标准、范围、对象、责任或约束写入正文；缺少依据时不得编造。',
    '- 每个小节必须包含对象/范围、依据/关键事实、处理要求、控制措施和结果闭环；具体术语以模板、用户要求和资料为准。',
    '- 表格只能作为辅助表达，表格前后必须有正文说明，不能整节只有表格。',
    evidenceText ? `内部资料：\n${evidenceText}` : '',
  ].filter(Boolean).join('\n\n');
  const content = await callDocumentLlm([
    '你是正式业务文档的小节生成专家。',
    FORMAL_WRITING_RULES,
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), prompt, false, { maxTokens: outputTokensForChapter(input.targetWords), temperature: 0.25, signal: input.signal });
  if (!content || content.length < 80) return undefined;
  const normalized = sanitizeFormalMarkdown(removeUnwantedDrawingImages(content.startsWith('### ') ? content : `### ${input.sectionTitle}\n\n${content}`, input.forbidDrawingImages));
  return normalized.replace(/^##\s+.*\n+/u, '').trim();
}

export async function buildSectionParallelChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; projectRoot?: string; modelName?: string; fileRolesHash?: string; allowPartialResult?: boolean; maxSectionConcurrency?: number; onSectionProgress?: (event: { completed: number; total: number; sectionTitle?: string; phase: 'start' | 'complete' | 'retry' }) => void; diagnostics?: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  const targets = sectionTargets(input.chapter, input.targetWords);
  if (targets.length < 2) return undefined;
  const configuredConcurrency = Number(process.env.DOCUMENT_SECTION_CONCURRENCY ?? targets.length);
  const concurrency = Math.max(1, Math.min(targets.length, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : targets.length));
  const results: Array<string | undefined> = new Array(targets.length);
  let completedCount = 0;
  const runSection = async (item: { title: string; targetWords: number }, compact = false) => {
    input.onSectionProgress?.({ completed: completedCount, total: targets.length, sectionTitle: item.title, phase: compact ? 'retry' : 'start' });
    const cacheInput = input.projectRoot && input.fileRolesHash ? { template: input.template, chapter: input.chapter, sectionTitle: item.title, evidence: compact ? input.evidence.slice(0, 80) : input.evidence, promptTexts: input.promptTexts, requirement: input.requirement, projectRoot: input.projectRoot, modelName: input.modelName, targetWords: item.targetWords, fileRolesHash: input.fileRolesHash } : undefined;
    if (!compact && cacheInput) {
      const cached = readSectionDraftCache(cacheInput, input.diagnostics);
      if (cached) {
        completedCount += 1;
        input.onSectionProgress?.({ completed: completedCount, total: targets.length, sectionTitle: item.title, phase: 'complete' });
        return cached;
      }
    }
    try {
      const content = await buildLlmSectionContent({
        ...input,
        evidence: compact ? input.evidence.slice(0, 80) : input.evidence,
        projectContext: compact ? input.projectContext.slice(0, 8000) : input.projectContext,
        roleContext: compact ? input.roleContext.slice(0, 12000) : input.roleContext,
        factCoverageContext: compact ? input.factCoverageContext?.slice(0, 8000) : input.factCoverageContext,
        sectionTitle: item.title,
        targetWords: item.targetWords,
        maxWords: input.maxWords ? Math.max(item.targetWords, Math.ceil(input.maxWords / targets.length)) : Math.ceil(item.targetWords * 1.12),
      });
      if (content && cacheInput) writeSectionDraftCache(cacheInput, content, input.diagnostics);
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
  const retryLimit = Math.max(0, Math.min(targets.length, Number(process.env.DOCUMENT_SECTION_RETRY_LIMIT ?? 4)));
  const missingIndexes = results.map((content, index) => content ? -1 : index).filter(index => index >= 0).slice(0, retryLimit);
  for (let offset = 0; offset < missingIndexes.length; offset += concurrency) {
    throwIfAborted(input.signal);
    const batchIndexes = missingIndexes.slice(offset, offset + concurrency);
    const batchResults = await Promise.all(batchIndexes.map(index => runSection(targets[index], true)));
    batchResults.forEach((content, index) => { if (content) results[batchIndexes[index]] = content; });
  }
  if (results.some(item => !item) && !input.allowPartialResult) return undefined;
  const completedSections = results.filter(Boolean);
  if (completedSections.length === 0) return undefined;
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${completedSections.join('\n\n')}`, input.forbidDrawingImages));
}

export function outputTokensForChapter(minWords: number, targetWords?: number) {
  const words = targetWords || minWords;
  return Math.min(32000, Math.max(6000, Math.ceil(words * 1.6)));
}

export function timeoutMsForChapter(targetWords?: number) {
  const words = targetWords || 1200;
  if (words >= 8000) return 900000;
  if (words >= 5000) return 600000;
  if (words >= 3000) return 420000;
  return 300000;
}

export function expansionRoundsForDeficit(deficitChars: number) {
  if (deficitChars <= 0) return 0;
  return Math.min(3, Math.max(1, Math.ceil(deficitChars / 4000)));
}

export function acceptExpandedChapter(previous: string, next: string, chapterTitle: string, targetChars: number, maxChars = Math.ceil(targetChars * 1.12)) {
  const beforeLength = documentTextLength(previous);
  const afterLength = documentTextLength(next);
  const titleToken = displayChapterTitle(chapterTitle).slice(0, 6);
  const remaining = Math.max(0, targetChars - beforeLength);
  const minimumGrowth = Math.min(300, Math.max(80, Math.floor(remaining * 0.2)));
  if (afterLength > maxChars) return false;
  if (remaining > 0 && afterLength < beforeLength + minimumGrowth) return false;
  if (afterLength < beforeLength * 0.98) return false;
  if (titleToken && !next.includes(titleToken)) return false;
  return true;
}

export async function expandChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; currentContent: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; maxChars?: number; forbidDrawingImages: boolean; maxTokens?: number; signal?: AbortSignal }) {
  const currentLength = documentTextLength(input.currentContent);
  const maxChars = input.maxChars ?? Math.ceil(input.targetChars * 1.12);
  const missing = input.targetChars - currentLength;
  if (currentLength >= maxChars || missing <= 300) return input.currentContent;
  const evidenceText = evidenceBundlePrompt(buildEvidenceBundle(input.chapter, input.evidence));
  const expanded = await callDocumentLlm([
    '你是章节正文扩写专家。你的任务是在保持章节结构和已有内容连续性的基础上，对当前章节进行局部扩写、补充和衔接优化。',
    FORMAL_WRITING_RULES,
    '返回扩写后的完整本章 Markdown，而不是整篇文档；必须保留本章一级标题，不得新增、删除或重命名一级章节。',
    '不得删除、压缩、总结已有正文中的有效事实和已成文内容；可以在已有二级小节内部补充段落、补充三级小节、补充表格前后说明、增强段落衔接。',
    '可以对局部语句做轻微衔接性改写，但不得改变事实含义，不得减少有效字数；不得把所有新增内容堆到章末，应优先补到对应的小节或语义位置。',
    '不得输出“已满足要求”“由于资料有限”“以下是补充”等说明性话术。',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    `章节标题：${input.chapter.title}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    `当前本章有效字数约 ${currentLength} 字，目标约 ${input.targetChars} 字，最多不超过 ${maxChars} 字；本轮只补足必要缺口，不要过度展开。`,
    '扩写重点：围绕尚未充分展开的对象范围、关键事实、执行要求、资源条件、风险约束、检查确认和责任闭环补充。资料没有新的精确数值时，可以扩展过程性或管理性正文，但不得编造具体数值。',
    input.roleContext,
    evidenceText ? `内部资料：\n${evidenceText}` : '',
    '当前章节 Markdown：',
    input.currentContent.slice(-24000),
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

export async function supplementShortSections(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; maxSectionConcurrency?: number; signal?: AbortSignal }) {
  const targets = sectionTargets(input.chapter, input.targetWords);
  if (targets.length < 2 || input.targetWords < 3000) return input.content;
  let content = input.content;
  if (input.maxWords && documentTextLength(content) >= input.maxWords) return content;
  const supplementTargets = targets.map(target => {
    const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = content.match(new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^#{3,4}\\s+|^##\\s+|$)`, 'mu'));
    const currentWords = documentTextLength(match?.[1] || '');
    return { ...target, currentWords };
  }).filter(target => target.currentWords < Math.floor(target.targetWords * 0.55)).slice(0, 4);
  const supplements: Array<string | undefined> = new Array(targets.length);
  const configuredConcurrency = Number(process.env.DOCUMENT_SECTION_SUPPLEMENT_CONCURRENCY ?? process.env.DOCUMENT_SECTION_CONCURRENCY ?? supplementTargets.length);
  const concurrency = Math.max(1, Math.min(supplementTargets.length || 1, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : supplementTargets.length || 1));
  for (let offset = 0; offset < supplementTargets.length; offset += concurrency) {
    const batch = supplementTargets.slice(offset, offset + concurrency);
    const remainingRoom = input.maxWords ? Math.max(0, input.maxWords - documentTextLength(content)) : Number.POSITIVE_INFINITY;
    if (remainingRoom <= 200) break;
    const perSectionRoom = Number.isFinite(remainingRoom) ? Math.max(260, Math.floor(remainingRoom / batch.length)) : undefined;
    const batchResults = await Promise.all(batch.map(target => buildLlmSectionContent({ ...input, sectionTitle: target.title, targetWords: Math.max(350, target.targetWords - target.currentWords), maxWords: perSectionRoom })));
    batch.forEach((target, index) => { supplements[targets.findIndex(item => item.title === target.title)] = batchResults[index]; });
  }
  supplements.forEach((supplement, index) => {
    if (supplement) content = replaceSectionContent(content, targets[index].title, supplement);
  });
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(content, input.forbidDrawingImages));
}

export async function expandChapterToTarget(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; maxChars?: number; forbidDrawingImages: boolean; maxTokens?: number; signal?: AbortSignal }) {
  let content = input.content;
  let rounds = 0;
  const maxRounds = expansionRoundsForDeficit(input.targetChars - documentTextLength(content));
  const maxChars = input.maxChars ?? Math.ceil(input.targetChars * 1.12);
  for (; rounds < maxRounds && documentTextLength(content) < input.targetChars && documentTextLength(content) < maxChars; rounds += 1) {
    throwIfAborted(input.signal);
    const before = content;
    const expanded = await callWithTimeout(
      signal => expandChapterContent({
        template: input.template,
        chapter: input.chapter,
        currentContent: content,
        evidence: input.evidence,
        promptTexts: input.promptTexts,
        requirement: input.requirement,
        roleContext: input.roleContext,
        targetChars: input.targetChars,
        maxChars,
        forbidDrawingImages: input.forbidDrawingImages,
        maxTokens: input.maxTokens,
        signal,
      }),
      timeoutMsForChapter(input.targetChars),
      input.signal,
    );
    if (!expanded || expanded === before) break;
    content = expanded;
  }
  return { content, rounds };
}


export async function expandDocumentToBudget(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; budget: DocumentBudget; promptTexts: string; requirement?: string; forbidDrawingImages: boolean; signal?: AbortSignal }) {
  if (!input.budget.minChars) return input.chapters;
  let chapters = input.chapters;
  let totalChars = documentTextLength(chapters.map(chapter => chapter.content).join('\n\n'));
  const maxDocumentRounds = Math.min(2, expansionRoundsForDeficit(input.budget.minChars - totalChars));
  const configuredConcurrency = Number(process.env.DOCUMENT_BUDGET_EXPAND_CONCURRENCY ?? input.chapters.length);
  const concurrency = Math.max(1, Math.min(input.chapters.length || 1, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : input.chapters.length || 1));
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
        const maxChars = perChapterRoom ? Math.min(Math.ceil(item.target * 1.12), item.current + perChapterRoom) : Math.ceil(item.target * 1.12);
        const expanded = await expandChapterToTarget({ template: input.template, chapter: { id: item.chapter.id, title: item.chapter.title, purpose: item.chapter.title, queries: [], requiredFacts: [], sections: item.chapter.sections }, content: item.chapter.content, evidence: item.chapter.evidence, promptTexts: input.promptTexts, requirement: input.requirement, roleContext: '', targetChars: item.target, maxChars, forbidDrawingImages: input.forbidDrawingImages, maxTokens: outputTokensForChapter(item.current, item.target), signal: input.signal });
        return { id: item.chapter.id, beforeChars: item.current, content: expanded.content };
      }));
      for (const result of results) {
        const afterChars = documentTextLength(result.content);
        if (afterChars <= result.beforeChars + 300) lowGrowthChapterIds.add(result.id);
        chapters = chapters.map(chapter => chapter.id === result.id ? { ...chapter, content: result.content } : chapter);
      }
      totalChars = documentTextLength(chapters.map(chapter => chapter.content).join('\n\n'));
    }
    if (totalChars <= roundStartChars + 300) break;
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
        '章节正文：',
        chapter.content.slice(0, 18000),
        '请返回 JSON：{"status":"pass|warn|fail","issues":["..."],"suggestions":["..."]}',
      ].filter(Boolean).join('\n'), true, { maxTokens: 1200, temperature: 0, signal: input.signal, diagnostics: input.diagnostics });
      let parsed: { status?: string; issues?: string[]; suggestions?: string[] } | undefined;
      try { parsed = reviewed ? JSON.parse(reviewed.replace(/^```json\s*/u, '').replace(/^```\s*/u, '').replace(/```$/u, '').trim()) as typeof parsed : undefined; } catch { parsed = undefined; }
      const issues = [...localIssues, ...(Array.isArray(parsed?.issues) ? parsed!.issues!.filter(Boolean).slice(0, 6) : [])];
      const status = parsed?.status === 'fail' || localIssues.some(issue => /缺失|占位|泄露|不足/u.test(issue)) ? 'fail' : parsed?.status === 'warn' || issues.length > 0 ? 'warn' : 'pass';
      return { chapterId: chapter.id, title: chapter.title, status, issues: [...new Set(issues)].slice(0, 8), suggestions: Array.isArray(parsed?.suggestions) ? parsed!.suggestions!.filter(Boolean).slice(0, 5) : [], chars: documentTextLength(chapter.content) } as ChapterReviewSummary;
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
  const outline = input.chapters.map(chapter => `- ${chapter.title}：${documentTextLength(chapter.content)} 字；审查=${input.chapterReviews.find(item => item.chapterId === chapter.id)?.status || 'unknown'}；问题=${(input.chapterReviews.find(item => item.chapterId === chapter.id)?.issues || []).slice(0, 3).join('；') || '无'}`).join('\n');
  const reviewed = await callDocumentLlm([
    '你是长文档全局一致性审查专家。只检查跨章节问题，不重写正文。',
    '重点检查：章节之间项目信息冲突、术语不一致、重复堆砌、目录层级异常、风险/质量/安全/进度闭环缺失、前后矛盾。',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `项目上下文摘要：\n${input.projectContext.slice(0, 8000)}` : '',
    '章节审查摘要：',
    outline,
    '章节摘录：',
    input.chapters.map(chapter => `## ${chapter.title}\n${chapter.content.slice(0, 2500)}\n...\n${chapter.content.slice(-1200)}`).join('\n\n---\n\n'),
    '请只返回跨章节问题清单和建议，不要返回全文。',
  ].filter(Boolean).join('\n'), false, { maxTokens: 1800, temperature: 0, signal: input.signal, diagnostics: input.diagnostics });
  const issues = (reviewed || '').split('\n').map(line => line.replace(/^[-*\d.、\s]+/u, '').trim()).filter(line => line.length > 6).slice(0, 10);
  return {
    issues,
    stage: displayStage({ type: 'llm_review' as const, roleId: 'global-consistency-review', status: issues.length > 0 ? 'fallback' : 'success', message: elapsedMessage(issues.length > 0 ? `全局一致性审查发现 ${issues.length} 个需关注问题` : '全局一致性审查未发现明显跨章节冲突', startedAt) }, { subtitle: '全局一致性审查' }),
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
  const reviewBundle = buildEvidenceBundle({ id: 'review', title: '最终质量审查', purpose: '审查全文证据和资源关系', queries: [], requiredFacts: [] }, input.evidence);
  const evidenceDigest = evidenceBundlePrompt(reviewBundle);
  const specDigest = input.spec ? [
    `优化建议包：${input.spec.name}`,
    `建议关注事实：${input.spec.factFields.map(field => field.name).join('、')}`,
    `章节内容建议：${input.spec.chapterRules.map(rule => `${rule.title}${rule.minWords ? `约${rule.minWords}字` : ''}`).join('、') || '以当前模板章节为准'}`,
    `质量提醒：${input.spec.gateRules.map(rule => `${rule.name}:${rule.type}`).join('、')}`,
    '约束：以上只用于质量检查，不得新增、删除、重排或重写用户/模板章节。',
  ].join('\n') : '后台优化建议未生成。';
  const reviewed = await callDocumentLlmJson<{ passed?: boolean; score?: number; issues?: Array<{ type?: string; severity?: string; location?: string; message?: string }> }>([
    '你是文档质量审查专家。只检查问题，不重写正文，不输出完整文档。',
    '准确性优先级：用户需求/模板结构 > 已绑定或人工确认的知识库证据 > 自动检索知识库证据 > 后台内容优化建议 > 项目上下文/历史记忆。内部优先级只用于判断事实，不得写入正文。',
    '重点检查：章节完整性、资料事实内化使用、参数数字准确性、冲突事实、解析器内部对象名、表格呈现、表达专业性、导出友好性、系统提示泄露。',
    '只返回 JSON 审查结果；不得返回优化后的完整 Markdown。',
    '返回格式：{"passed":true,"score":90,"issues":[{"type":"...","severity":"low|medium|high","location":"...","message":"..."}]}',
    input.promptTexts,
  ].filter(Boolean).join('\n\n'), [
    `模板：${input.template.name}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    input.projectContext ? `项目上下文/历史记忆：\n${input.projectContext}` : '',
    specDigest,
    '知识库证据摘要：',
    evidenceDigest,
    '待审查初稿：',
    input.markdown.slice(0, 24000),
    '请只返回 JSON 审查结果，不要返回全文。',
  ].filter(Boolean).join('\n'), { maxTokens: 1800, temperature: 0, signal: input.signal, diagnostics: input.diagnostics });
  throwIfAborted(input.signal);
  const issues = Array.isArray(reviewed?.issues) ? reviewed!.issues!.filter(item => item?.message).slice(0, 8) : [];
  const severeCount = issues.filter(item => item.severity === 'high').length;
  const score = Number.isFinite(reviewed?.score) ? Math.round(Number(reviewed!.score)) : undefined;
  const summary = issues.length > 0
    ? issues.map(item => `${item.severity || 'medium'}:${item.location || item.type || '全文'}-${item.message}`).join('；').slice(0, 180)
    : '未发现明显质量问题';
  return {
    markdown: input.markdown,
    stage: {
      type: 'llm_review',
      roleId: 'llm-review',
      status: severeCount > 0 ? 'fallback' : reviewed ? 'success' : 'skipped',
      message: reviewed ? `已完成结构化非重写式质量审查${score !== undefined ? `，评分 ${score}` : ''}：${summary}` : '无可用模型或审查结果不可用，保留生成初稿',
    },
  };
}

export function formatContextEntries(entries: ReturnType<typeof recallDocumentContexts>) {
  return entries.length > 0
    ? entries.map((entry, index) => `${index + 1}. [${entry.type}/${entry.importance}] ${entry.content}${entry.source ? `（来源：${entry.source}）` : ''}`).join('\n')
    : '';
}
