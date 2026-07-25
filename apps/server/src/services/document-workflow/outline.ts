import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { DocumentTemplate, DocumentTemplateChapter } from './types';
import { MAX_EXPLICIT_OUTLINE_CHAPTERS, MAX_FALLBACK_CHAPTERS, CN_NUMERAL_RE } from './constants';
import { violatesConfiguredChapterTitleFilter, violatesConfiguredChapterTitleForbiddenFilter } from './templateStore';

function cleanOutlineTitle(title: string) {
  let cleaned = title.trim();
  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    cleaned = cleaned
      .replace(new RegExp(`^\\s*第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]\\s*`, 'u'), '')
      .replace(new RegExp(`^\\s*[（(]?(?:\\d{1,3}|${CN_NUMERAL_RE})[)）、.．]\\s*`, 'u'), '')
      .replace(new RegExp(`^\\s*[-*+]\\s+`, 'u'), '')
      .trim();
  }
  return cleaned.replace(/\s+/gu, ' ');
}

function isInvalidOutlineTitle(title: string) {
  // 既然用户显式在 <OUTLINE> 中提供，完全信任用户的输入，不再做语义、关键字或长度限制
  // 仅过滤掉清理后完全为空的行
  return title.trim().length === 0;
}

function outlineTitlesFromBlock(content: string) {
  const cnOrder = `${CN_NUMERAL_RE}`;
  const markers = [
    `第(?:\\d{1,3}|${cnOrder})[章节]\\s*`,
    `(?:\\d{1,3})[、)）]\\s*`,
    `(?:\\d{1,3})[.．]\\s+(?!\\d)`,
    `(?:${cnOrder})[、.．)）]\\s*`,
    `[（(](?:\\d{1,3}|${cnOrder})[)）]\\s*`,
    `[-*+]\\s+`,
  ];
  let normalized = content.replace(/\r?\n/gu, '\n');
  for (const marker of markers) {
    normalized = normalized.replace(new RegExp(`([；;。！？!?])\\s*(?=${marker})`, 'gu'), '$1\n');
    normalized = normalized.replace(new RegExp(`(?<=\\n)\\s+(?=${marker})`, 'gu'), '');
    normalized = normalized.replace(new RegExp(`(?<![\\d.．])\\s+(?=${marker})`, 'gu'), '\n');
  }
  return normalized
    .split(/\n|；|;/u)
    .map(line => cleanOutlineTitle(line))
    .filter(title => !isInvalidOutlineTitle(title));
}

const OUTLINE_TAG_NAME_RE = '(?:OUTLINE|CHAPTERS?|章节(?:大纲)?|大纲|目录)';
const OUTLINE_EXACT_RE = new RegExp(`<\\s*${OUTLINE_TAG_NAME_RE}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\s*${OUTLINE_TAG_NAME_RE}\\s*>`, 'giu');

export function hasExplicitOutlineBlock(text: string) {
  OUTLINE_EXACT_RE.lastIndex = 0;
  return OUTLINE_EXACT_RE.test(text);
}

export function isExplicitOutlineOpeningLine(text: string) {
  return new RegExp(`^\\s*<\\s*${OUTLINE_TAG_NAME_RE}(?:\\s[^>]*)?>`, 'iu').test(text);
}

export function isExplicitOutlineClosingLine(text: string) {
  return new RegExp(`^\\s*<\\/\\s*${OUTLINE_TAG_NAME_RE}\\s*>`, 'iu').test(text);
}

function extractOutlineBlocks(text: string, options?: { strict?: boolean }) {
  OUTLINE_EXACT_RE.lastIndex = 0;
  const exact = [...text.matchAll(OUTLINE_EXACT_RE)].map(match => match[1] || '');
  if (exact.length > 0 || options?.strict) return exact;
  const loose = /(?:<\s*)?(?:OUTLINE|CHAPTERS?|章节(?:大纲)?|大纲|目录)\s*>?\s*[:：]?\s*([\s\S]*?)(?:<\/\s*(?:OUTLINE|CHAPTERS?|章节(?:大纲)?|大纲|目录)\s*>|END\s+(?:OUTLINE|CHAPTERS?)|$)/iu.exec(text);
  return loose?.[1] ? [loose[1]] : [];
}

function extractExplicitOutlineFromText(text: string, source: string, options?: { strict?: boolean }): DocumentTemplateChapter[] {
  const chapters: DocumentTemplateChapter[] = [];
  const blocks = extractOutlineBlocks(text, options);
  for (const block of blocks) {
    for (const title of outlineTitlesFromBlock(block)) {
      chapters.push({
        id: `explicit-${source}-${chapters.length + 1}`,
        title,
        purpose: `按照${source}中 <OUTLINE> 块明确指定的章节生成：${title}；如需二级小节，应由大模型结合提示词、需求和资料上下文动态规划。`,
        requiredFacts: [],
        sections: [],
        queries: [title],
      });
    }
  }
  return chapters.filter(chapter => !isInvalidOutlineTitle(chapter.title)).slice(0, MAX_EXPLICIT_OUTLINE_CHAPTERS);
}

export function extractExplicitOutlineFromSources(sources: Array<{ text?: string; source: string; strict?: boolean }>) {
  for (const item of sources) {
    const chapters = extractExplicitOutlineFromText(item.text || '', item.source, { strict: item.strict });
    if (chapters.length >= 2) return chapters;
  }
  return [];
}

export function displayChapterTitle(title: string) {
  return title.replace(/^#+\s*/u, '').replace(/^第[一二三四五六七八九十百千万\d]+[章节]\s*/u, '').replace(/^\d+(?:\.\d+)*[、.．\s]*/u, '').trim();
}

export function normalizeGeneratedChapterTitle(title: string) {
  return displayChapterTitle(title.replace(/\s+/gu, ' ').trim()).replace(/^[，,、；;：:。.!！?？\-—\s]+/u, '').trim();
}

export function isValidGeneratedChapterTitle(title: string) {
  const raw = title.trim();
  const clean = normalizeGeneratedChapterTitle(raw);
  if (!clean || clean.length < 2 || clean.length > 50) return false;
  if (/^#{3,6}\s*/u.test(raw)) return false;
  if (/^\|.*\|/u.test(raw) || /\|/u.test(clean)) return false;
  if (/^[，,、；;：:。.!！?？\-—]/u.test(raw)) return false;
  if (/[{}<>]|Markdown|JSON|变量|占位符/u.test(clean)) return false;
  if (/[。；;]$/u.test(clean) || /[:：]\s*[。；;]?$/u.test(clean)) return false;
  if (/^(目录|章节|大纲|要求|说明|注意|输出|格式|示例|例如|写法|占位)$/u.test(clean)) return false;
  if (/(评标委员会|完全满足评审要求|全面梳理与响应|坚实的技术保障)/u.test(clean)) return false;
  return !isPollutedChapterTitle(clean);
}

function numberToChineseChapter(value: number) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value <= 10) return value === 10 ? '十' : digits[value];
  if (value < 20) return `十${digits[value % 10]}`;
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ''}`;
  }
  return String(value);
}

export function formalChapterTitle(index: number, title: string) {
  const clean = displayChapterTitle(title);
  return `第${numberToChineseChapter(index + 1)}章 ${clean}`;
}

function isPollutedChapterTitle(title: string) {
  return /见(?:公告|文件|资料|附件)|按(?:资料|文件|相关要求)|质量标准[:：]|范围[:：].*依据/u.test(title);
}

export function uniqueTemplateChapters(chapters: DocumentTemplateChapter[], options?: { preserveExplicitOutline?: boolean; template?: DocumentTemplate }) {
  const seen = new Set<string>();
  return chapters.filter(chapter => {
    const key = normalizeGeneratedChapterTitle(chapter.title);
    if (!key) return false;
    if (!options?.preserveExplicitOutline) {
      if (seen.has(key) || isPollutedChapterTitle(key)) return false;
      if (options?.template && violatesConfiguredChapterTitleForbiddenFilter(key, options.template)) return false;
    }
    seen.add(key);
    chapter.title = key;
    return true;
  });
}

export function effectiveTemplateChapters(template: DocumentTemplate, spec?: AutoDocumentSpecPackage, options?: { preserveExplicitOutline?: boolean }): DocumentTemplateChapter[] {
  if (!spec || options?.preserveExplicitOutline) return uniqueTemplateChapters([...template.chapters], { ...options, template });
  return uniqueTemplateChapters([...template.chapters].map(chapter => {
    const title = displayChapterTitle(chapter.title);
    const rule = spec.chapterRules.find(item => item.id === chapter.id || displayChapterTitle(item.title) === title);
    return {
      ...chapter,
      title,
      purpose: chapter.purpose,
      requiredFacts: chapter.requiredFacts || [],
      queries: [...new Set([...(chapter.queries || []), title, rule?.generationHint || '', ...(chapter.sections || [])].filter(Boolean))],
    };
  }), { ...options, template });
}
