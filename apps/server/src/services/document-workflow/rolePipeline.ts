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
import { callDocumentLlmJson, isContextOverflowLlmError } from './llmClient';
import { throwIfAborted, systemConstraintLine } from './utils';

export type { QualityRepairType } from '../types';

export function selectDocumentGenerationStrategy(input: { template: DocumentTemplate; targetWords: number; requirement?: string; materialFileCount?: number; evidenceCount?: number }): DocumentGenerationStrategy {
  const chapterCount = input.template.chapters.length;
  const avgChapterTarget = chapterCount > 0 ? input.targetWords / chapterCount : input.targetWords;
  const text = `${input.template.name}\n${input.template.category || ''}\n${input.requirement || ''}`;
  // strict 触发条件明确化：风险领域关键词、超长文档（≥4 万字）、资料稀疏（证据/资料过少）三类
  const riskKeywords = /专项|安全|质量|验收|审核|合同|合规|审计|风控|风险/u.test(text);
  const veryLong = input.targetWords >= 40000;
  const sparseMaterials = (input.materialFileCount ?? 0) < 4 && (input.evidenceCount ?? 0) < 6;
  const strict = riskKeywords || veryLong || sparseMaterials;
  const longform = input.targetWords >= 30000 || chapterCount >= 8 || avgChapterTarget >= 4000;
  const compact = input.targetWords <= 6000 && chapterCount <= 4 && !strict;
  // mode 仅为文档画像标签：章节级 Reviewer/Repairer 与 Final Gate 始终执行（本地风险阈值自适应跳过无风险项，不额外付出时间成本）；
  // 全局一致性审查：strict 画像（专项/安全/质量/合同等）默认开启（全文分块审查成本可控，跨章一致性收益明显）；
  // fast 小文档全局审查降级为抽检（按 35% 章节抽样，降低额外 LLM 成本）；
  // env DOCUMENT_GLOBAL_CONSISTENCY_REVIEW=1 强制开启、=0 强制关闭
  const globalReviewEnabled = process.env.DOCUMENT_GLOBAL_CONSISTENCY_REVIEW !== '0' && (strict || compact || process.env.DOCUMENT_GLOBAL_CONSISTENCY_REVIEW === '1');
  return {
    mode: strict ? 'strict' : longform ? 'longform' : compact ? 'fast' : 'balanced',
    enableChapterReview: true,
    enableGlobalReview: globalReviewEnabled,
    enableDocumentBudgetExpansion: false,
    enableFinalQualityReview: true,
    globalReviewSamplingRate: globalReviewEnabled && compact ? 0.35 : 1,
    // 修复轮次预算不再硬编码：由 buildGenerationBudget 按章节数/篇幅/资料量动态计算，
    // 且章节修复循环内另有收敛判定（连续无进展强制切换策略），预算只作总兜底上限
  };
}

export function createGenerationDiagnostics(strategy: DocumentGenerationStrategy): DocumentGenerationDiagnostics {
  return {
    strategy,
    metrics: [],
    llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, failureStreak: 0, schemaFailures: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0, inputTokens: 0, outputTokens: 0, inputChars: 0 },
    evidence: { raw: 0, used: 0, filteredNoise: 0, budgetDropped: 0, avgNoiseScore: 0, avgFactDensity: 0, searchQueries: 0, searchMs: 0, contextChars: 0 },
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
  // 全部问题进入修复器（无数量截断，问题反馈完整保留）
  return unique;
}

export function issuesForChapter(chapter: DocumentDraftChapter, issues: string[]) {
  const actionableIssues = issues.filter(repairableQualityIssue);
  const sectionHits = new Set(chapter.sections || []);
  // 用 token 预算替代硬截断：LLM 上下文限制是真实的，但应在语义边界处截断
  const contentTruncated = truncateToTokenBudget(chapter.content, 4000, 'issue-matching').truncated;
  const text = `${chapter.title}\n${chapter.sections?.join('\n') || ''}\n${contentTruncated}`;
  return actionableIssues
    .filter(issue => issue.includes(chapter.title) || [...sectionHits].some(section => issue.includes(section)) || /图片|三级小节|目录|表格|量化|数值|单位|事实|不得出现|禁止词|禁用主体|生成后事实反查失败|跨章一致性/u.test(issue) && /!\[|####|\*\*|\||m\s*[²2]|mm2|cm2|km2|重新生成|见招标公告|招标范围|兜底|施工方|\d/u.test(text));
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
  // 唯一性判定必须排除「未找到」情况：indexOf 返回 -1 时 -1 === -1 为 true，
  // 历史 bug 会把不存在的 originalText 当作唯一定位返回 → replace 静默无效果 → applied=false
  if (originalText && content.includes(originalText) && content.indexOf(originalText) === content.lastIndexOf(originalText)) return originalText;
  const targetStart = patch.targetStart?.trim();
  const targetEnd = patch.targetEnd?.trim();
  if (!targetStart || !targetEnd) return undefined;
  const startIndex = content.indexOf(targetStart);
  if (startIndex < 0) return undefined;
  const endIndex = content.indexOf(targetEnd, startIndex + targetStart.length);
  if (endIndex < 0) return undefined;
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

export async function repairChapterByQuality(input: { template: DocumentTemplate; chapter: DocumentDraftChapter; issues: string[]; promptTexts: string; requirement?: string; forbidDrawingImages: boolean; repairType?: QualityRepairType; diagnostics?: DocumentGenerationDiagnostics; signal?: AbortSignal; contextChapters?: Array<{ title: string; content: string }>; maxTokens?: number }) {
  throwIfAborted(input.signal);
  const repairType = input.repairType || classifyQualityRepairType(input.issues);
  const contextBlock = input.contextChapters?.length
    ? `\n\n周边章节上下文（仅用于衔接，禁止改动其中内容）：\n${input.contextChapters.map(c => `【${c.title}】\n${c.content}`).join('\n\n')}`
    : '';
  // 证据注入预算：与写作侧同口径（evidencePromptBudgetForTarget）。历史缺陷：修复器全量注入每章
  // 2.8万-3.3万字符证据 → 超上下文窗口 400 失败 → 修复闭环瘫痪（真实生成 75 次失败、瞬态重试 0 次）
  const evidenceBundle = input.chapter.evidence.length
    ? buildEvidenceBundle({ id: input.chapter.id, title: input.chapter.title, purpose: input.chapter.title, queries: [], requiredFacts: [] }, input.chapter.evidence)
    : undefined;
  const systemPrompt = [
    '你是章节局部修复专家。只返回 JSON patch，不返回完整章节，不重写无问题内容。',
    repairTypeInstruction(repairType),
    FORMAL_WRITING_RULES,
    input.forbidDrawingImages ? '图片类资料只作为文本事实来源，禁止插入图片或 Markdown 图片语法。' : '',
    '每个 patch 必须能通过 originalText 或 targetStart/targetEnd 在原章节中唯一定位；replacement 只替换该局部片段。',
    '只修复列出的问题，不得整章重写，不得删除无问题小节，不得改变一级/二级章节结构。',
    '如问题涉及缺少正式表格，replacement 必须包含 Markdown 表名、表头、分隔线和至少一行数据；不得只写“见下表”或空表。',
    '如问题涉及缺失关键词/要素（缺词补写类），选取相关小节最后一个完整句子作为 originalText，replacement 为该句加补充句，保证定位唯一；不得因“原文找不到该关键词”而放弃产出 patch。',
    '如问题涉及提示词要求的关键词或禁用内容，只在相关段落自然补齐或替换，不得堆砌关键词。',
    '禁止新增证据摘要中没有的信息；无法安全定位的问题不要生成 patch。',
    '返回 JSON：{"patches":[{"originalText":"原局部文本","targetStart":"定位起始文本","targetEnd":"定位结束文本","replacement":"替换后的局部文本","reason":"修复原因"}]}',
    // A5a 前缀缓存：可变 promptTexts 已移入 user 首部，system 保持恒定（跨章共享 prefix cache）
  ].filter(Boolean).join('\n\n');
  const buildUserPrompt = (evidenceText: string) => [
    input.promptTexts ? `配置写作主控提示词：\n${input.promptTexts}` : '',
    `模板：${input.template.name}`,
    `章节：${input.chapter.title}`,
    input.requirement ? `用户要求：${input.requirement}` : '',
    `需要局部修复的问题：\n${input.issues.map(item => `- ${item}`).join('\n')}`,
    evidenceText,
    '当前章节 Markdown：',
    input.chapter.content,
    contextBlock,
  ].filter(Boolean).join('\n\n');
  const evidenceBudget = evidenceBundle
    ? evidencePromptBudgetForTarget(Math.min(documentTextLength(input.chapter.content), 10000), 6000, 14000)
    : undefined;
  const failure: { value?: string } = {};
  let result = await callDocumentLlmJson<{ patches?: ChapterMarkdownPatch[] }>(systemPrompt, buildUserPrompt(evidenceBundle && evidenceBudget ? `本章证据摘要：\n${evidenceBundlePrompt(evidenceBundle, { maxChars: evidenceBudget })}` : ''), { maxTokens: input.maxTokens ?? 8000, temperature: 0, signal: input.signal, diagnostics: input.diagnostics, outFailure: failure });
  if (!result && evidenceBundle && isContextOverflowLlmError(failure.value)) {
    // 上下文超长降级重试：证据压缩到极小预算（3000 字符），优先保住修复任务本身
    result = await callDocumentLlmJson<{ patches?: ChapterMarkdownPatch[] }>(systemPrompt, buildUserPrompt(`本章证据摘要：\n${evidenceBundlePrompt(evidenceBundle, { maxChars: 3000 })}`), { maxTokens: input.maxTokens ?? 8000, temperature: 0, signal: input.signal, diagnostics: input.diagnostics });
  }
  throwIfAborted(input.signal);
  let content = input.chapter.content;
  let appliedCount = 0;
  const patches = Array.isArray(result?.patches) ? result!.patches! : [];
  for (const patch of patches) {
    const applied = applyChapterPatch({ content, patch, title: input.chapter.title, forbidDrawingImages: input.forbidDrawingImages });
    content = applied.content;
    if (applied.applied) appliedCount += 1;
  }
  // producedCount（F4）：LLM 已产出但未应用的 patch 条数，供修复循环区分「未产出 patch」与
  // 「产出但锚点失配未应用」两种失败诊断（历史缺陷：补表类 patch 锚点失配全部落空仍报“未产出”）
  return { content, appliedCount, producedCount: patches.length, repairType };
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
  const configuredConcurrency = Number(process.env.DOCUMENT_QUALITY_REPAIR_CONCURRENCY || 4);
  const concurrency = Math.max(1, Math.min(candidates.length || 1, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : 4));
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
  const actuallyRepairedIds = new Set<string>();
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
    actuallyRepairedIds.add(chapter.id);
    return { ...chapter, content };
  });
  const message = repairedCount > 0
    ? `已应用 ${patchCount} 个局部质量 patch，修复 ${repairedCount} 个章节；拒绝 ${rejectedShrinkCount} 个明显缩水 patch；未进行整章或全文重写`
    : `已完成质量检查，未生成可唯一定位且通过校验的局部 patch：共 ${repairableIssues.length} 个，拒绝 ${rejectedShrinkCount} 个明显缩水 patch；摘要：${repairableIssues.slice(0, 5).map(summarizeRepairIssue).join('；')}`;
  // 仅标记实际被 patch 的章节对应的问题为已解决
  const patchedIssueSignatures = new Set<string>();
  if (repairedCount > 0) {
    for (const candidate of candidates) {
      if (actuallyRepairedIds.has(candidate.chapter.id)) {
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
  if (blocks.length === 0) return '';
  // 元话语泄漏根治（评分报告 N2："第一、第二、第三"及"不得出现"类约束文字曾从数据库写作主控提示词整段泄漏进正文）
  return `${blocks.join('\n\n')}\n\n${systemConstraintLine('以上提示词仅指导写作：提示词文字本身（编号"第一/第二/第三"、约束表述、格式说明等元话语）禁止复述进正文，正文只输出正式施工组织设计内容')}`;
}

export function promptOutlineTextsForExecution(promptBindings: PromptBinding[]) {
  const blocks: string[] = [];
  for (const prompt of readPromptContents(promptBindings)) {
    if (!hasExplicitOutlineBlock(prompt.content)) continue;
    blocks.push(`## [${prompt.roleId}] ${prompt.name}\n${prompt.content}`);
  }
  return blocks.join('\n\n');
}
