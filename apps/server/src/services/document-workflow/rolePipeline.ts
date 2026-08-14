import * as fs from 'node:fs';
import * as path from 'node:path';
import { BLOCKING_CHAPTER_ISSUE_RE, QUALITY_REPAIR_INSTRUCTIONS, QUALITY_REPAIR_TYPE_RULES, REPAIRABLE_QUALITY_ISSUE_RE } from '../constants';
import { listDocumentRoles } from '../document-core/documentRoleService';
import type { QualityRepairType } from '../types';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentGenerationDiagnostics, DocumentGenerationStrategy, DocumentTemplate, DocumentTemplateChapter, PromptBinding } from './types';
import { readPromptContents, type ResolvedPromptContent } from './templateStore';
import { buildEvidenceBundle, evidenceBundlePrompt, evidencePromptBudgetForTarget } from './evidence';
import { hasExplicitOutlineBlock, isExplicitOutlineClosingLine, isExplicitOutlineOpeningLine } from './outline';
import { FORMAL_WRITING_RULES, WORKFLOW_PHRASE_RE, removeUnwantedDrawingImages, sanitizeFormalMarkdown } from './markdownComposer';
import { documentTextLength } from './budget';
import { estimateTokens, truncateToTokenBudget } from './tokenBudget';
import { classifyQualitySeverity, degenerateContentIssues } from './qualityValidation';
import { repairIssueSignature } from './documentQualityPipeline';
import { callDocumentLlmJson } from './llmClient';
import { throwIfAborted } from './utils';

export type { QualityRepairType } from '../types';

export function selectDocumentGenerationStrategy(input: { template: DocumentTemplate; targetWords: number; requirement?: string }): DocumentGenerationStrategy {
  const chapterCount = input.template.chapters.length;
  const avgChapterTarget = chapterCount > 0 ? input.targetWords / chapterCount : input.targetWords;
  const text = `${input.template.name}\n${input.template.category || ''}\n${input.requirement || ''}`;
  const strict = /专项|安全|质量|验收|审核|合同|合规|审计|风控|风险/u.test(text);
  const longform = input.targetWords >= 30000 || chapterCount >= 8 || avgChapterTarget >= 4000;
  const compact = input.targetWords <= 6000 && chapterCount <= 4 && !strict;
  // mode 仅为文档画像标签：LLM 审查开关保持全开，实际是否执行由本地风险阈值自适应决定
  // （无风险自动跳过，不额外付出时间成本；不通过关闭审查来换取速度，避免质量下降）
  return {
    mode: strict ? 'strict' : longform ? 'longform' : compact ? 'fast' : 'balanced',
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
    llm: { calls: 0, failures: 0, maxActive: 0, retries: 0 },
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

export function blockingChapterIssues(issues: string[]) {
  const blocking: string[] = [];
  for (const issue of issues) {
    BLOCKING_CHAPTER_ISSUE_RE.lastIndex = 0;
    if (BLOCKING_CHAPTER_ISSUE_RE.test(issue)) blocking.push(issue);
  }
  return blocking;
}

export function repairableQualityIssue(issue: string) {
  REPAIRABLE_QUALITY_ISSUE_RE.lastIndex = 0;
  return REPAIRABLE_QUALITY_ISSUE_RE.test(issue);
}

export function lightweightChapterIssues(input: { chapter: DocumentTemplateChapter; content: string; missingFacts: string[]; targetWords: number }) {
  const issues: string[] = [];
  if (!new RegExp(`^##\\s+(?:第[一二三四五六七八九十百千万\\d]+章\\s*)?${input.chapter.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'mu').test(input.content)) issues.push('正文缺少章节标题');
  for (const degenerateIssue of degenerateContentIssues(input.content, [{ id: input.chapter.id, title: input.chapter.title, content: input.content, evidence: [], sections: input.chapter.sections || [], missingFacts: [] }])) {
    issues.push(degenerateIssue.message);
  }
  if (documentTextLength(input.content) < Math.floor(input.targetWords * 0.85)) issues.push('正文篇幅明显低于目标');
  WORKFLOW_PHRASE_RE.lastIndex = 0;
  if (WORKFLOW_PHRASE_RE.test(input.content) || /知识库|检索|事实字段|校验结果/u.test(input.content)) issues.push('正文包含后台流程话术');
  if (/资料未提供|满足相关要求|结合实际情况|根据实际情况|视情况|待明确|待确认/u.test(input.content)) issues.push('正文存在空泛占位表达');
  // 检查所有缺失事实（而非仅前 8 个），但按重要性评分排序后限制报告数量
  const uncheckedFacts = input.missingFacts.filter(fact => fact && !input.content.includes(fact));
  for (const fact of uncheckedFacts) {
    issues.push(`requiredFacts 未明显覆盖：${fact}`);
  }
  const unique = [...new Set(issues)];
  // 报告所有问题但限制数量避免 LLM prompt 过大（issue 详情通过 validationIssues 完整保留）
  return unique.length <= 16 ? unique : [...unique.slice(0, 16), `（及其他 ${unique.length - 16} 个问题，详见校验报告）`];
}

export function issuesForChapter(chapter: DocumentDraftChapter, issues: string[]) {
  const actionableIssues = issues.filter(repairableQualityIssue);
  const sectionHits = new Set(chapter.sections || []);
  // 用 token 预算替代硬截断：LLM 上下文限制是真实的，但应在语义边界处截断
  const contentTruncated = truncateToTokenBudget(chapter.content, 4000, 'issue-matching').truncated;
  const text = `${chapter.title}\n${chapter.sections?.join('\n') || ''}\n${contentTruncated}`;
  return actionableIssues
    .filter(issue => issue.includes(chapter.title) || [...sectionHits].some(section => issue.includes(section)) || /图片|三级小节|目录|表格|量化|数值|单位|事实|不得出现|禁止词|禁用主体|生成后事实反查失败|跨章一致性/u.test(issue) && /!\[|####|\*\*|\||m\s*[²2]|mm2|cm2|km2|重新生成|见招标公告|招标范围|兜底|施工方|\d/u.test(text))
    .slice(0, 8);
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

export async function repairChapterByQuality(input: { template: DocumentTemplate; chapter: DocumentDraftChapter; issues: string[]; promptTexts: string; requirement?: string; forbidDrawingImages: boolean; repairType?: QualityRepairType; diagnostics?: DocumentGenerationDiagnostics; signal?: AbortSignal; contextChapters?: Array<{ title: string; content: string }> }) {
  throwIfAborted(input.signal);
  const repairType = input.repairType || classifyQualityRepairType(input.issues);
  const contextBlock = input.contextChapters?.length
    ? `\n\n周边章节上下文（仅用于衔接，禁止改动其中内容）：\n${input.contextChapters.map(c => `【${c.title}】\n${c.content.slice(0, 2500)}`).join('\n\n')}`
    : '';
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
    contextBlock,
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

function summarizeRepairIssue(issue: string) {
  return issue
    .replace(/【修复任务包】/gu, '')
    .split(/\r?\n/u)
    .map(line => line.replace(/^(?:修复类型|修复对象|问题|要求|输出要求)：/u, '').trim())
    .filter(Boolean)[0]
    ?.slice(0, 80) || '质量问题';
}

export async function repairMarkdownByQuality(input: { markdown: string; template: DocumentTemplate; chapters: DocumentDraftChapter[]; promptTexts: string; requirement?: string; issues: string[]; forbidDrawingImages: boolean; strategy?: DocumentGenerationStrategy; diagnostics?: DocumentGenerationDiagnostics; signal?: AbortSignal; resolvedSignatures?: Set<string>; neighborContext?: Map<string, Array<{ title: string; content: string }>> }) {
  let repairableIssues = input.issues.filter(issue => classifyQualitySeverity(issue) !== 'minor').filter(repairableQualityIssue);
  const resolvedSigs = input.resolvedSignatures;
  if (resolvedSigs) repairableIssues = repairableIssues.filter(issue => !resolvedSigs.has(repairIssueSignature(issue)));
  if (repairableIssues.length === 0) return { markdown: input.markdown, chapters: input.chapters, stage: undefined as DocumentExecutionStage | undefined, resolvedSignatures: [] as string[] };
  const candidates = input.chapters
    .map(chapter => ({ chapter, issues: issuesForChapter(chapter, repairableIssues) }))
    .filter(item => item.issues.length > 0);
  if (candidates.length === 0) {
    return {
      markdown: input.markdown,
      chapters: input.chapters,
      stage: { type: 'llm_review' as const, roleId: 'quality-repair', status: 'success' as const, message: `已完成质量检查，未定位到可安全局部修复的阻断问题：共 ${repairableIssues.length} 个；摘要：${repairableIssues.slice(0, 5).map(summarizeRepairIssue).join('；')}` },
      resolvedSignatures: [] as string[],
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
  let rejectedShrinkCount = 0;
  const repairedChapters = input.chapters.map(chapter => {
    const content = repairedById.get(chapter.id);
    if (!content || content === chapter.content) return chapter;
    const beforeChars = documentTextLength(chapter.content);
    const afterChars = documentTextLength(content);
    if (afterChars < Math.max(1200, Math.floor(beforeChars * 0.92))) {
      rejectedShrinkCount += 1;
      return chapter;
    }
    repairedCount += 1;
    return { ...chapter, content };
  });
  const message = repairedCount > 0
    ? `已应用 ${patchCount} 个局部质量 patch，修复 ${repairedCount} 个章节；拒绝 ${rejectedShrinkCount} 个明显缩水 patch；未进行整章或全文重写`
    : `已完成质量检查，未生成可唯一定位且通过校验的局部 patch：共 ${repairableIssues.length} 个，拒绝 ${rejectedShrinkCount} 个明显缩水 patch；摘要：${repairableIssues.slice(0, 5).map(summarizeRepairIssue).join('；')}`;
  // 仅标记实际被 patch 的章节对应的问题为已解决
  const patchedIssueSignatures = new Set<string>();
  if (repairedCount > 0) {
    for (const candidate of candidates) {
      if (repairedById.has(candidate.chapter.id)) {
        for (const issue of candidate.issues) {
          patchedIssueSignatures.add(repairIssueSignature(issue));
        }
      }
    }
  }
  const resolvedSignatures = [...patchedIssueSignatures];
  return {
    markdown: input.markdown,
    chapters: repairedChapters,
    stage: { type: 'llm_review' as const, roleId: 'quality-repair', status: 'success' as const, message },
    resolvedSignatures,
  };
}

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
