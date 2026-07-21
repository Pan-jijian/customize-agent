import { createHash } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { getConfigStore } from '@/services/configService';

export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } },
};

type LlmMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };
type MarkdownBlock = { level: number; title: string; start: number; end: number; content: string; ordinal?: number };
type RefineAction = 'polish' | 'expand' | 'summarize' | 'replace' | 'delete' | 'add' | 'restructure' | 'table';
type RefineScope = 'selection' | 'section' | 'chapter' | 'document';
type RefineSelection = { start: number; end: number; text?: string };
type RefinePlan = { scope: RefineScope; action: RefineAction; targetTitle?: string; targetRange?: { start: number; end: number }; baseMarkdownHash?: string; targetTextHash?: string; confidence: number; summary: string; needsConfirmation: boolean };
type ChatProvider = ReturnType<typeof createProvider>;

function providerFactoryName(providerName: string, providerConfig?: { protocol?: string }) {
  const protocol = resolveProtocol(providerName, providerConfig);
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'google') return 'google';
  if (protocol === 'ollama') return 'ollama';
  if (protocol === 'openrouter') return 'openrouter';
  return 'openai';
}

function getActiveModelWithProvider() {
  const config = getConfigStore().load();
  const activeModel = config.models.reasoning.active || config.models.action.active || config.models.reader.active;
  const selected = [...config.models.reasoning.list, ...config.models.action.list, ...config.models.reader.list].find(model => model.name === activeModel);
  if (!selected) return undefined;
  const providerConfig = config.providers[selected.provider];
  if (!providerConfig) return undefined;
  return { model: selected, provider: providerConfig };
}

const DEFAULT_MAX_MARKDOWN_CHARS = 300_000;
const DEFAULT_MAX_INSTRUCTION_CHARS = 12_000;
const MAX_LOCAL_BLOCK_CHARS = 60_000;

function getPositiveIntEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function cleanMarkdown(value: string) {
  return value.trim().replace(/^```(?:markdown|md)?\s*/iu, '').replace(/```$/u, '').trim();
}

function cleanJson(value: string) {
  const text = value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[\s#*_`~，。、“”"'：:；;,.!?！？（）()[\]【】《》<>\-—_]+/gu, '');
}

function parseOrdinal(value: string) {
  const arabic = value.match(/(?:第\s*)?(\d{1,3})\s*(?:章|节|[、.．])/u)?.[1];
  if (arabic) return Number(arabic);
  const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const chinese = value.match(/第\s*([一二三四五六七八九十]{1,3})\s*[章节]/u)?.[1];
  if (!chinese) return undefined;
  if (chinese === '十') return 10;
  if (chinese.startsWith('十')) return 10 + (map[chinese.slice(1)] ?? 0);
  if (chinese.endsWith('十')) return (map[chinese[0]] ?? 1) * 10;
  if (chinese.includes('十')) return (map[chinese[0]] ?? 1) * 10 + (map[chinese.slice(-1)] ?? 0);
  return map[chinese];
}

function fencedCodeRanges(markdown: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const fencePattern = /^(```|~~~).*$/gmu;
  let start: number | undefined;
  let fence: string | undefined;
  for (const match of markdown.matchAll(fencePattern)) {
    const marker = match[1];
    const index = match.index ?? 0;
    if (start === undefined) {
      start = index;
      fence = marker;
    } else if (marker === fence) {
      ranges.push({ start, end: index + match[0].length });
      start = undefined;
      fence = undefined;
    }
  }
  if (start !== undefined) ranges.push({ start, end: markdown.length });
  return ranges;
}

function inRanges(index: number, ranges: Array<{ start: number; end: number }>) {
  return ranges.some(range => index >= range.start && index <= range.end);
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const codeRanges = fencedCodeRanges(markdown);
  const matches = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gmu)].filter(match => !inRanges(match.index ?? 0, codeRanges));
  return matches.map((match, index) => {
    const level = match[1].length;
    const start = match.index ?? 0;
    const nextPeerOrParent = matches.slice(index + 1).find(item => item[1].length <= level);
    const end = nextPeerOrParent?.index ?? markdown.length;
    const title = match[2].trim();
    return {
      level,
      title,
      start,
      end,
      content: markdown.slice(start, end).trim(),
      ordinal: parseOrdinal(title),
    };
  });
}

function scoreBlock(block: MarkdownBlock, instruction: string) {
  const normalizedInstruction = normalizeText(instruction);
  const normalizedTitle = normalizeText(block.title);
  let score = 0;
  if (block.ordinal && block.ordinal === parseOrdinal(instruction)) score += 100;
  if (normalizedTitle && normalizedInstruction.includes(normalizedTitle)) score += 80;
  const meaningfulParts = normalizedTitle.split(/第?\d{0,3}[章节]?/u).filter(part => part.length >= 2);
  for (const part of meaningfulParts) {
    if (normalizedInstruction.includes(part)) score += Math.min(60, part.length * 3);
  }
  for (let size = Math.min(8, normalizedTitle.length); size >= 2; size -= 1) {
    for (let index = 0; index + size <= normalizedTitle.length; index += 1) {
      if (normalizedInstruction.includes(normalizedTitle.slice(index, index + size))) score += size;
    }
  }
  return score;
}

function findTargetBlock(blocks: MarkdownBlock[], instruction: string) {
  const ranked = blocks.map(block => ({ block, score: scoreBlock(block, instruction) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  return ranked[0]?.block;
}

function getChapterBlocks(blocks: MarkdownBlock[]) {
  const level2 = blocks.filter(block => block.level === 2);
  if (level2.length > 0) return level2;
  return blocks.filter(block => block.level === Math.min(...blocks.map(item => item.level)));
}

function replaceBlock(markdown: string, block: MarkdownBlock, nextContent: string) {
  const prefix = markdown.slice(0, block.start);
  const suffix = markdown.slice(block.end);
  const content = cleanMarkdown(nextContent);
  const separator = suffix && !content.endsWith('\n') ? '\n\n' : '';
  return `${prefix}${content}${separator}${suffix.replace(/^\n{3,}/u, '\n\n')}`;
}

function changedOnlyTarget(previous: string, next: string, block: MarkdownBlock) {
  const prefix = previous.slice(0, block.start);
  const suffix = previous.slice(block.end).replace(/^\n{3,}/u, '\n\n');
  return next.startsWith(prefix) && next.endsWith(suffix);
}

function clampRange(markdown: string, range?: { start: number; end: number }) {
  if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) return undefined;
  const start = Math.max(0, Math.min(markdown.length, Math.floor(range.start)));
  const end = Math.max(start, Math.min(markdown.length, Math.floor(range.end)));
  return end > start ? { start, end } : undefined;
}

function blockFromRange(markdown: string, range: { start: number; end: number }, title = '选中内容'): MarkdownBlock {
  return { level: 0, title, start: range.start, end: range.end, content: markdown.slice(range.start, range.end).trim() };
}

function blockContainingOffset(blocks: MarkdownBlock[], offset: number, predicate: (block: MarkdownBlock) => boolean) {
  return blocks.filter(block => predicate(block) && offset >= block.start && offset <= block.end).sort((a, b) => b.level - a.level || (a.end - a.start) - (b.end - b.start))[0];
}

function inferAction(instruction: string): RefineAction {
  if (/表格|列表|清单/u.test(instruction)) return 'table';
  if (/删除|去掉|移除/u.test(instruction)) return 'delete';
  if (/压缩|简短|精简|缩短/u.test(instruction)) return 'summarize';
  if (/结构|层次|重组|调整/u.test(instruction)) return 'restructure';
  if (/改成|替换|修改为|换成/u.test(instruction)) return 'replace';
  if (/补充|增加|新增|加入/u.test(instruction)) return 'add';
  if (/细|详细|丰富|展开|加强|强化/u.test(instruction)) return 'expand';
  return 'polish';
}

function attachPlanHashes(markdown: string, plan: RefinePlan): RefinePlan {
  const range = clampRange(markdown, plan.targetRange);
  return {
    ...plan,
    targetRange: range ?? plan.targetRange,
    baseMarkdownHash: sha256(markdown),
    targetTextHash: range ? sha256(markdown.slice(range.start, range.end)) : undefined,
  };
}

function validatePlanAgainstMarkdown(markdown: string, plan: RefinePlan) {
  if (plan.baseMarkdownHash && plan.baseMarkdownHash !== sha256(markdown)) return false;
  const range = clampRange(markdown, plan.targetRange);
  if (plan.targetTextHash && (!range || plan.targetTextHash !== sha256(markdown.slice(range.start, range.end)))) return false;
  return true;
}

function localPlan(markdown: string, instruction: string, blocks: MarkdownBlock[], selection?: RefineSelection, cursorOffset?: number): RefinePlan {
  const action = inferAction(instruction);
  const selectedRange = clampRange(markdown, selection && selection.end > selection.start ? selection : undefined);
  if (selectedRange) {
    return { scope: 'selection', action, targetTitle: '选中内容', targetRange: selectedRange, confidence: 0.98, summary: '将只修改你选中的文本范围。', needsConfirmation: true };
  }
  if (typeof cursorOffset === 'number' && Number.isFinite(cursorOffset)) {
    const offset = Math.max(0, Math.min(markdown.length, Math.floor(cursorOffset)));
    const section = blockContainingOffset(blocks, offset, block => block.level >= 3);
    if (section) return { scope: 'section', action, targetTitle: section.title, targetRange: { start: section.start, end: section.end }, confidence: 0.9, summary: `将修改当前光标所在小节「${section.title}」。`, needsConfirmation: true };
    const chapter = blockContainingOffset(blocks, offset, block => getChapterBlocks(blocks).includes(block));
    if (chapter) return { scope: 'chapter', action, targetTitle: chapter.title, targetRange: { start: chapter.start, end: chapter.end }, confidence: 0.86, summary: `将修改当前光标所在章节「${chapter.title}」。`, needsConfirmation: true };
  }
  const section = findTargetBlock(blocks.filter(block => block.level >= 3), instruction);
  if (section) return { scope: 'section', action, targetTitle: section.title, targetRange: { start: section.start, end: section.end }, confidence: 0.78, summary: `根据提示词匹配到小节「${section.title}」。`, needsConfirmation: true };
  const chapter = findTargetBlock(getChapterBlocks(blocks), instruction);
  if (chapter) return { scope: 'chapter', action, targetTitle: chapter.title, targetRange: { start: chapter.start, end: chapter.end }, confidence: 0.74, summary: `根据提示词匹配到章节「${chapter.title}」。`, needsConfirmation: true };
  return { scope: 'document', action, confidence: 0.45, summary: '未能可靠定位具体章节，将以全文为上下文谨慎修改。', needsConfirmation: true };
}

async function llmRefinePlan(provider: ChatProvider, input: { title: string; markdown: string; instruction: string; facts: string[]; chapters: string[]; local: RefinePlan }) {
  if (input.local.confidence >= 0.74) return input.local;
  const outline = parseMarkdownBlocks(input.markdown).map(block => ({ title: block.title, level: block.level, start: block.start, end: block.end })).slice(0, 80);
  const response = await provider.chat([
    { role: 'system', content: '你是文档编辑计划助手。只返回 JSON。根据用户短提示词，判断最合适的修改范围和编辑动作。优先选择章节或小节，不要轻易选择全文。' },
    { role: 'user', content: `文档标题：${input.title}\n用户要求：${input.instruction}\n章节索引：${JSON.stringify(outline)}\n事实：${input.facts.slice(0, 20).join('；')}\n返回格式：{"scope":"section|chapter|document","action":"polish|expand|summarize|replace|delete|add|restructure|table","targetTitle":"标题","targetRange":{"start":0,"end":1},"confidence":0.8,"summary":"计划摘要"}` },
  ], { temperature: 0.1 });
  try {
    const parsed = JSON.parse(cleanJson(response.content)) as Partial<RefinePlan>;
    const range = clampRange(input.markdown, parsed.targetRange);
    return {
      scope: parsed.scope === 'section' || parsed.scope === 'chapter' || parsed.scope === 'document' ? parsed.scope : input.local.scope,
      action: parsed.action && ['polish', 'expand', 'summarize', 'replace', 'delete', 'add', 'restructure', 'table'].includes(parsed.action) ? parsed.action : input.local.action,
      targetTitle: typeof parsed.targetTitle === 'string' ? parsed.targetTitle : input.local.targetTitle,
      targetRange: range ?? input.local.targetRange,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : input.local.confidence,
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : input.local.summary,
      needsConfirmation: true,
    } satisfies RefinePlan;
  } catch {
    return input.local;
  }
}

async function refineBlock(provider: ChatProvider, input: { title: string; instruction: string; block: MarkdownBlock; facts: string[]; chapters: string[] }) {
  const response = await provider.chat([
    {
      role: 'system',
      content: '你是文档编辑助手。严格执行用户的原始修改要求，不要替用户扩写或改变意图。只返回修改后的目标片段 Markdown，不要解释，不要代码围栏。',
    },
    {
      role: 'user',
      content: [
        `文档标题：${input.title}`,
        input.chapters.length > 0 ? `全文章节目录：\n${input.chapters.map(item => `- ${item}`).join('\n')}` : '',
        input.facts.length > 0 ? `结构化事实：\n${input.facts.map(item => `- ${item}`).join('\n')}` : '',
        `修改要求：\n${input.instruction}`,
        `当前片段：\n${input.block.content}`,
      ].filter(Boolean).join('\n\n'),
    },
  ], { temperature: 0.2 });
  const content = cleanMarkdown(response.content);
  return content !== input.block.content ? content : undefined;
}

async function applyRefinePlan(provider: ChatProvider, input: { title: string; markdown: string; instruction: string; plan: RefinePlan; facts: string[]; chapters: string[] }) {
  const range = clampRange(input.markdown, input.plan.targetRange);
  if (input.plan.scope !== 'document') {
    if (!range) throw new Error('未找到可修改的目标范围，请重新识别修改范围');
    const target = blockFromRange(input.markdown, range, input.plan.targetTitle || '目标片段');
    if (target.content.length > MAX_LOCAL_BLOCK_CHARS) throw new Error('目标范围过大，请选中更小范围后重试');
    const refined = await refineBlock(provider, { title: input.title, instruction: input.instruction, block: target, facts: input.facts, chapters: input.chapters });
    if (refined === undefined) throw new Error('AI 未对目标范围产生有效修改，请调整提示词后重试');
    const markdown = replaceBlock(input.markdown, target, refined);
    if (!changedOnlyTarget(input.markdown, markdown, target)) throw new Error('修改范围校验失败，请重新识别修改范围');
    return { markdown, beforeSnippet: target.content, afterSnippet: cleanMarkdown(refined), summary: input.plan.summary, changedChars: markdown.length - input.markdown.length };
  }
  const markdown = await refineFullDocument(provider, { title: input.title, markdown: input.markdown, instruction: input.instruction, facts: input.facts, chapters: input.chapters });
  return { markdown, beforeSnippet: input.markdown.slice(0, 1600), afterSnippet: markdown.slice(0, 1600), summary: input.plan.summary, changedChars: markdown.length - input.markdown.length };
}

async function refineFullDocument(provider: ChatProvider, input: { title: string; markdown: string; instruction: string; facts: string[]; chapters: string[] }) {
  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: '你是文档编辑助手。严格执行用户的原始修改要求，不要替用户扩写或改变意图。输出可以直接替换编辑框的完整 Markdown。不要解释，不要代码围栏。',
    },
    {
      role: 'user',
      content: [
        `文档标题：${input.title}`,
        input.chapters.length > 0 ? `章节目录：\n${input.chapters.map(item => `- ${item}`).join('\n')}` : '',
        input.facts.length > 0 ? `结构化事实：\n${input.facts.map(item => `- ${item}`).join('\n')}` : '',
        `修改要求：\n${input.instruction}`,
        `当前 Markdown：\n${input.markdown}`,
      ].filter(Boolean).join('\n\n'),
    },
  ];
  const response = await provider.chat(messages, { temperature: 0.25 });
  return cleanMarkdown(response.content);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { mode, title, markdown, instruction, facts, chapters, selection, cursorOffset, plan } = req.body as { mode?: unknown; title?: unknown; markdown?: unknown; instruction?: unknown; facts?: unknown; chapters?: unknown; selection?: unknown; cursorOffset?: unknown; plan?: unknown };
  const currentMarkdown = typeof markdown === 'string' ? markdown : '';
  const userInstruction = typeof instruction === 'string' ? instruction.trim() : '';
  if (!currentMarkdown.trim() || !userInstruction) return res.status(400).json({ error: '当前内容和修改要求不能为空' });
  const maxMarkdownChars = getPositiveIntEnv('DOCUMENT_REFINE_MAX_MARKDOWN_CHARS', DEFAULT_MAX_MARKDOWN_CHARS);
  const maxInstructionChars = getPositiveIntEnv('DOCUMENT_REFINE_MAX_INSTRUCTION_CHARS', DEFAULT_MAX_INSTRUCTION_CHARS);
  if (currentMarkdown.length > maxMarkdownChars) return res.status(400).json({ error: `当前文档过长，请先缩小修改范围或压缩到 ${maxMarkdownChars} 字以内` });
  if (userInstruction.length > maxInstructionChars) return res.status(400).json({ error: `修改要求过长，请压缩到 ${maxInstructionChars} 字以内` });

  const active = getActiveModelWithProvider();
  if (!active) return res.status(400).json({ error: '未配置可用模型，请先在模型配置中启用模型' });

  const factList = Array.isArray(facts) ? facts.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 80) : [];
  const chapterList = Array.isArray(chapters) ? chapters.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 40) : [];
  const documentTitle = typeof title === 'string' && title.trim() ? title.trim() : '未命名文档';

  try {
    const { model, provider: providerConfig } = active;
    const provider = createProvider(providerFactoryName(model.provider, providerConfig), {
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      modelName: model.name,
      directEndpoint: providerConfig.directEndpoint,
    });
    const blocks = parseMarkdownBlocks(currentMarkdown);
    const selected = typeof selection === 'object' && selection !== null ? selection as Partial<RefineSelection> : undefined;
    const refineSelection = selected && typeof selected.start === 'number' && typeof selected.end === 'number' ? { start: selected.start, end: selected.end, text: typeof selected.text === 'string' ? selected.text : undefined } : undefined;
    const local = localPlan(currentMarkdown, userInstruction, blocks, refineSelection, typeof cursorOffset === 'number' ? cursorOffset : undefined);

    if (mode === 'plan') {
      const refinePlan = await llmRefinePlan(provider, { title: documentTitle, markdown: currentMarkdown, instruction: userInstruction, facts: factList, chapters: chapterList, local });
      return res.status(200).json({ plan: attachPlanHashes(currentMarkdown, refinePlan) });
    }

    const inputPlan = typeof plan === 'object' && plan !== null ? plan as Partial<RefinePlan> : undefined;
    const refinePlan: RefinePlan = inputPlan?.summary ? {
      scope: inputPlan.scope === 'selection' || inputPlan.scope === 'section' || inputPlan.scope === 'chapter' || inputPlan.scope === 'document' ? inputPlan.scope : local.scope,
      action: inputPlan.action && ['polish', 'expand', 'summarize', 'replace', 'delete', 'add', 'restructure', 'table'].includes(inputPlan.action) ? inputPlan.action : local.action,
      targetTitle: typeof inputPlan.targetTitle === 'string' ? inputPlan.targetTitle : local.targetTitle,
      targetRange: clampRange(currentMarkdown, inputPlan.targetRange) ?? local.targetRange,
      baseMarkdownHash: typeof inputPlan.baseMarkdownHash === 'string' ? inputPlan.baseMarkdownHash : undefined,
      targetTextHash: typeof inputPlan.targetTextHash === 'string' ? inputPlan.targetTextHash : undefined,
      confidence: typeof inputPlan.confidence === 'number' ? inputPlan.confidence : local.confidence,
      summary: inputPlan.summary,
      needsConfirmation: true,
    } : attachPlanHashes(currentMarkdown, local);
    if (!validatePlanAgainstMarkdown(currentMarkdown, refinePlan)) return res.status(409).json({ error: '文档内容已变化，请重新识别修改范围后再执行' });

    const applied = await applyRefinePlan(provider, { title: documentTitle, markdown: currentMarkdown, instruction: userInstruction, plan: refinePlan, facts: factList, chapters: chapterList });
    if (!applied.markdown) return res.status(500).json({ error: 'AI 未返回有效文档内容' });
    res.status(200).json({ ...applied, plan: refinePlan });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '文档精准修改失败' });
  }
}
