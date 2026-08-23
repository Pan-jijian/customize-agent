import type { MarkdownSectionContentGap } from './qualityValidation';
import type { DocumentEvidence, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from './types';
import { documentTextLength } from './budget';
import { buildEvidenceBundle, cleanEvidenceText, evidenceBundlePrompt, evidencePromptBudgetForTarget } from './evidence';
import { callDocumentLlm } from './llmClient';
import { FORMAL_WRITING_RULES, removeUnwantedDrawingImages, sanitizeFormalMarkdown, SECTION_GENERATION_SAFETY_RULES } from './markdownComposer';
import { throwIfAborted } from './utils';
import { buildLlmSectionContent, buildQualifiedSectionSupplement, sectionSupplementAttempts, sectionTargets } from './chapterGeneration';
import { acceptExpandedChapter, outputTokensForChapter } from './chapterPostProcessing';
import { chunkTextForReview } from './chapterReview';

function isGenericFillerSentence(sentence: string) {
  return /^(?:本节围绕|本小节依据|项目实施时应|实施过程中应|当前绑定资料|当前项目绑定资料)/u.test(sentence)
    || /确保各项措施与本工程实施条件相匹配/u.test(sentence)
    || /形成责任明确、过程可控、资料完整的管理闭环/u.test(sentence)
    || /确保现场管理要求与施工进度、资源组织和验收节点同步推进/u.test(sentence)
    || /^管理闭环[。；;]?$/u.test(sentence);
}

function isNonConstructionEvidenceSentence(sentence: string) {
  return /资料参数行摘要|房建市政施工评定分离招标示范文本|我方已仔细研究|中标通知书|签订合同|履约保证金|投标函|投标人须知|招标公告|开标|评标|保证金|电子交易系统|公共资源交易|监管部门|专用账户监管协议书|资金托管专用账号/u.test(sentence)
    || /^#+\s*/u.test(sentence)
    || /^（?\d+）/u.test(sentence);
}

function evidenceSentencesForSection(sectionTitle: string, chapter: DocumentTemplateChapter, evidence: DocumentEvidence[]) {
  const sectionTokens = [sectionTitle, chapter.title, ...sectionTitle.split(/[、，,；;\s]+/u)].filter(token => token.length >= 2);
  const scored = evidence.map(item => {
    const content = cleanEvidenceText(item.content || '').replace(/\s+/gu, ' ').trim();
    const score = sectionTokens.reduce((sum, token) => sum + (content.includes(token) || (item.sectionTitle || '').includes(token) ? 1 : 0), 0) + item.score;
    return { content, score };
  }).filter(item => item.content.length >= 30).sort((a, b) => b.score - a.score);
  const sentences: string[] = [];
  for (const entry of scored.slice(0, 8)) {
    for (const sentence of entry.content.split(/[。；;\n]/u).map(part => part.trim()).filter(Boolean)) {
      if (sentence.length < 18 || sentence.length > 180) continue;
      if (/报价|单价|税率|利润|后台|知识库|提示词|OCR|文件路径/u.test(sentence)) continue;
      if (isGenericFillerSentence(sentence) || isNonConstructionEvidenceSentence(sentence)) continue;
      if (!sentences.some(existing => existing.includes(sentence) || sentence.includes(existing))) sentences.push(sentence);
      if (sentences.length >= 10) break;
    }
    if (sentences.length >= 10) break;
  }
  return sentences;
}

export function buildEvidenceOnlyChapterContent(input: { chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; targetWords: number; forbidDrawingImages: boolean }) {
  const sections = input.chapter.sections?.length ? input.chapter.sections : ['资料依据与施工对象', '主要控制措施', '检查验收与闭环管理'];
  const parts = sections.flatMap(sectionTitle => {
    const facts = evidenceSentencesForSection(sectionTitle, input.chapter, input.evidence).slice(0, 8);
    if (facts.length === 0) return [];
    return [[`### ${sectionTitle}`, '', ...facts.map(fact => `- ${fact}。`)].join('\n')];
  });
  if (parts.length === 0) return '';
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${parts.join('\n\n')}`, input.forbidDrawingImages));
}

export async function expandChapterContent(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; currentContent: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; maxChars?: number; forbidDrawingImages: boolean; maxTokens?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics }) {
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
  ].filter(Boolean).join('\n\n'), false, { maxTokens: input.maxTokens ?? outputTokensForChapter(currentLength, input.targetChars), temperature: 0.25, signal: input.signal, diagnostics: input.diagnostics });
  if (!expanded || expanded.length < 120) return input.currentContent;
  const normalized = sanitizeFormalMarkdown(removeUnwantedDrawingImages(expanded.startsWith('## ') ? expanded : `## ${input.chapter.title}\n\n${expanded}`, input.forbidDrawingImages));
  return acceptExpandedChapter(input.currentContent, normalized, input.chapter.title, input.targetChars, maxChars) ? normalized : input.currentContent;
}

export function mergeSectionSupplementBody(currentBody: string, replacementBody: string) {
  const current = currentBody.trim();
  const replacement = replacementBody.trim();
  if (!replacement) return '';
  if (/【本小节生成未达标，需重新生成】/u.test(current)) return replacement;
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
      if (/【本小节生成未达标，需重新生成】/u.test(body)) return supplement ? `${heading}${supplement}\n\n` : `${heading}${body.trim()}\n\n`;
      return supplement ? `${heading}${body.trim()}\n\n${supplement}\n\n` : `${heading}${body.trim()}\n\n`;
    });
  }
  return normalizedReplacement ? `${markdown.trim()}\n\n### ${sectionTitle}\n\n${normalizedReplacement}` : markdown;
}

export async function supplementShortSections(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; missingFacts: string[]; promptTexts: string; projectContext: string; requirement?: string; roleContext: string; targetWords: number; maxWords?: number; forbidDrawingImages: boolean; factCoverageContext?: string; forcedSections?: MarkdownSectionContentGap[]; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics }) {
  const plannedTargets = sectionTargets(input.chapter, input.targetWords);
  const targetByTitle = new Map(plannedTargets.map(target => [target.title, target]));
  const forcedTargets = (input.forcedSections || [])
    .filter(gap => gap.chapterTitle === input.chapter.title && (gap.reason === 'empty' || gap.reason === 'missing_planned_section'))
    .map(gap => ({ title: gap.sectionTitle, targetWords: Math.max(targetByTitle.get(gap.sectionTitle)?.targetWords || 0, Math.floor(input.targetWords / Math.max(1, plannedTargets.length || input.forcedSections?.length || 1))), forced: true, reason: gap.reason }));
  const targets = [...plannedTargets];
  for (const forced of forcedTargets) {
    if (!targets.some(target => target.title === forced.title)) targets.push(forced);
  }
  if (targets.length < 1) return input.content;
  let content = input.content;
  const forcedTitleSet = new Set(forcedTargets.map(target => target.title));
  const allSupplementTargets = targets.map(target => {
    const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = content.match(new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^#{3,4}\\s+|^##\\s+|$)`, 'mu'));
    const currentWords = documentTextLength(match?.[1] || '');
    const isEmptyOrNearlyEmpty = currentWords < 80;
    const forced = forcedTitleSet.has(target.title);
    return { ...target, currentWords, priority: forced ? 0 : isEmptyOrNearlyEmpty ? 1 : 2, forced, reason: forcedTargets.find(item => item.title === target.title)?.reason };
  }).filter(target => target.forced || target.currentWords < Math.max(360, Math.floor(target.targetWords * 0.7)))
    .sort((a, b) => a.priority - b.priority || a.currentWords - b.currentWords);
  const maxRepairTargets = Number(process.env.DOCUMENT_SECTION_REPAIR_MAX_TARGETS || 0);
  const supplementTargets = maxRepairTargets > 0 ? allSupplementTargets.slice(0, maxRepairTargets) : allSupplementTargets;
  const supplements = new Map<string, string | undefined>();
  const configuredConcurrency = Number(process.env.DOCUMENT_SECTION_SUPPLEMENT_CONCURRENCY || 2);
  const concurrency = Math.max(1, Math.min(supplementTargets.length || 1, Number.isFinite(configuredConcurrency) ? Math.floor(configuredConcurrency) : 2));
  for (let offset = 0; offset < supplementTargets.length; offset += concurrency) {
    const batch = supplementTargets.slice(offset, offset + concurrency);
    const attempts = sectionSupplementAttempts(supplementTargets.length);
    const batchResults = await Promise.all(batch.map(async target => {
      try {
        const gapWords = Math.max(0, target.targetWords - target.currentWords);
        const strictSection = /概况|范围|工期|质量|安全|危大|资源|材料|设备|验收|清单|图纸|设计/u.test(target.title);
        const desiredRatio = strictSection ? 0.8 : 0.65;
        const minimumRatio = strictSection ? 0.5 : 0.35;
        const desiredTotalWords = Math.max(280, Math.ceil(target.targetWords * desiredRatio));
        const minimumSupplementWords = Math.max(220, Math.ceil(target.targetWords * minimumRatio));
        const forcedTargetWords = Math.max(desiredTotalWords - target.currentWords, minimumSupplementWords);
        const targetWords = Math.max(target.forced ? forcedTargetWords : gapWords, Math.ceil(target.targetWords * 0.35));
        return await buildQualifiedSectionSupplement({
          ...input,
          evidence: input.evidence,
          sectionTitle: target.title,
          targetWords,
          maxWords: Math.ceil(targetWords * 1.25),
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

const EXPANSION_INCREMENT_CHARS = 2000;
const EXPANSION_DEGRADED_INCREMENT_CHARS = 1000;
const EXPANSION_MAX_ROUNDS = 6;

export async function expandChapterToTarget(input: { template: DocumentTemplate; chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[]; promptTexts: string; requirement?: string; roleContext: string; targetChars: number; maxChars?: number; forbidDrawingImages: boolean; signal?: AbortSignal; strictBudget?: boolean; diagnostics?: DocumentGenerationDiagnostics }) {
  let content = input.content;
  let rounds = 0;
  const targetChars = input.targetChars;
  const maxChars = input.maxChars ?? Math.ceil(input.targetChars * 1.12);
  const totalDeficit = targetChars - documentTextLength(content);
  const maxRounds = totalDeficit <= 0 ? 0 : Math.min(EXPANSION_MAX_ROUNDS, Math.max(1, Math.ceil(totalDeficit / EXPANSION_INCREMENT_CHARS)));
  let noGrowthStreak = 0;
  for (; rounds < maxRounds && documentTextLength(content) < targetChars && documentTextLength(content) < maxChars; rounds += 1) {
    throwIfAborted(input.signal);
    const beforeChars = documentTextLength(content);
    const remaining = Math.max(0, targetChars - beforeChars);
    if (remaining <= 300) break;
    let grown = false;
    // 常规增量 → 超时/被拒后降档（增量减半）再试一次；成功后不再追加
    for (const increment of [Math.min(input.strictBudget ? 2400 : EXPANSION_INCREMENT_CHARS, remaining), Math.min(EXPANSION_DEGRADED_INCREMENT_CHARS, remaining)]) {
      if (increment <= 0 || grown) continue;
      throwIfAborted(input.signal);
      const currentChars = documentTextLength(content);
      const incrementalTarget = Math.min(targetChars, currentChars + increment);
      const roundMaxChars = Math.min(maxChars, currentChars + increment + (input.strictBudget ? 2200 : 1600));
      try {
        const expanded = await expandChapterContent({
          template: input.template,
          chapter: input.chapter,
          currentContent: content,
          evidence: input.evidence,
          promptTexts: input.promptTexts,
          requirement: input.requirement,
          roleContext: input.roleContext,
          targetChars: incrementalTarget,
          maxChars: roundMaxChars,
          forbidDrawingImages: input.forbidDrawingImages,
          maxTokens: outputTokensForChapter(currentChars + increment, incrementalTarget),
          signal: input.signal,
          diagnostics: input.diagnostics,
        });
        if (expanded && expanded !== content) {
          content = expanded;
          grown = true;
          break;
        }
        // 产出为空或被 acceptExpandedChapter 拒绝 → 降档增量再试
      } catch {
        // 模型失败 → 降档增量再试；用户中止直接抛出
        if (input.signal?.aborted) throw new Error('用户中止');
      }
    }
    if (grown && documentTextLength(content) > beforeChars + 200) {
      noGrowthStreak = 0;
    } else {
      noGrowthStreak += 1;
    }
    // 连续两轮无实质增长即停，避免轮轮空烧
    if (noGrowthStreak >= 2) break;
  }
  return { content, rounds };
}
