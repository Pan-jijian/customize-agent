import type { DocumentDraftChapter, DocumentTemplate, GeneratedDocumentDraft, ValidationIssue } from './types';
import { CAD_ENTITY_TOKEN_RE, FILE_NAME_RE } from './constants';
import { displayChapterTitle, formalChapterTitle, normalizeGeneratedChapterTitle } from './outline';

export function removeUnwantedDrawingImages(markdown: string, forbid: boolean) {
  if (!forbid) return markdown;
  return markdown.replace(/^!\[[^\]]*(?:图纸|drawing|cad|地图|平面|剖面|立面)[^\]]*\]\([^)]*\)\s*$/gimu, '').replace(/\n{3,}/gu, '\n\n');
}

export const WORKFLOW_PHRASE_RE = /.*(?:知识库证据|文件角色|提示词角色|后台自动规范|规范包|事实字段|资料未提供|未检索到|待确认事项|证据来源|来源清单|校验结果).*(?:\n|$)/gu;
const RAW_SOURCE_LINE_RE = /^\s*(?:#{1,6}\s*)?(?:PDF\s*第\s*\d+\s*页|rule\b|文件[:：]|片段[:：]|来源[:：]).*$/gimu;
const ASCII_FLOW_LINE_RE = /^\s*(?:[│┃┆┊┌┐└┘├┤┬┴┼─━╭╮╰╯]|[↓↑→←⇒⇨➡])+\s*$/gmu;

export function normalizeProductionText(markdown: string) {
  return markdown
    .replace(/\b(m|㎡)\s*2\b/giu, '平方米')
    .replace(/\bm\s*[²2]\b/giu, '平方米')
    .replace(/\b(m|㎥)\s*3\b/giu, '立方米')
    .replace(/\bm\s*[³3]\b/giu, '立方米')
    .replace(/\bmm2\b/giu, '平方毫米')
    .replace(/\bcm2\b/giu, '平方厘米')
    .replace(/\bkm2\b/giu, '平方千米')
    .replace(/\s*×\s*/gu, '×')
    .replace(/\s*≤\s*/gu, '≤')
    .replace(/\s*≥\s*/gu, '≥')
    .replace(/\s*±\s*/gu, '±');
}

export function stripMarkdownDocumentFence(markdown: string) {
  const trimmed = markdown.trim();
  const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/iu.exec(trimmed);
  return match ? match[1].trim() : markdown;
}

export function sanitizeFormalMarkdown(markdown: string) {
  const cleaned = normalizeProductionText(stripMarkdownDocumentFence(markdown))
    .replace(WORKFLOW_PHRASE_RE, '')
    .replace(RAW_SOURCE_LINE_RE, '')
    .replace(ASCII_FLOW_LINE_RE, '')
    .replace(FILE_NAME_RE, '')
    .replace(/^#\s+/gmu, '')
    .replace(CAD_ENTITY_TOKEN_RE, '')
    .replace(/第\s*\d+\s*页\s*\/\s*共\s*\d+\s*页/gu, '');
  return cleaned.split(/\r?\n/u)
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^\s*\|/u.test(trimmed) || /^\s*\|?\s*:?-{3,}:?/u.test(trimmed)) return true;
      const plain = displayChapterTitle(trimmed.replace(/^#{1,6}\s+/u, ''));
      if (plain.length <= 1) return false;
      return !(/[，、；：和与在为对将]$/u.test(plain) || /(通过|包括|如下|主要包括)$/u.test(plain));
    })
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export const FORMAL_WRITING_RULES = [
  '你正在生成可直接交付的专业文档，不是系统调试报告。',
  '通用质量约束只用于补充用户要求、模板章节和绑定提示词；除事实安全、结构边界和导出格式要求外，不得覆盖用户明确要求。',
  '不得把“知识库、检索、文件角色、提示词角色、规范包、事实字段、动态章节、缺失项、校验结果、资料未提供、未检索到”等后台流程话术写入正文。',
  '用户提供的信息和绑定材料应内化为正文表达；除非用户要求来源追溯章节，否则不要单列系统证据清单。',
  '表格、标题和公式必须使用 Markdown/导出友好的写法，避免 ASCII 流程图和容易导致导出异常的符号组合。',
  '正文不得把原始文件条款、说明性附件或系统过程内容误作为章节标题或目录项。',
  '正文事实必须来自当前模板、用户要求、绑定提示词和绑定材料；信息不足或来源冲突时应保持审慎并提示复核口径，不得编造精确数量。',
  '语言应正式、专业、克制，适合直接导出。',
].join('\n');

export const SECTION_GENERATION_SAFETY_RULES = [
  '只生成当前小节正文，不生成其他二级小节，不重复章节一级标题。',
  '优先使用当前模板、用户要求、绑定提示词和绑定材料中的事实；缺少依据时不得编造具体数值、名称、时间、规格或责任。',
  '小节应有实质正文；除非用户或模板明确要求纯表格，否则表格只能作为辅助表达，不能整节只有表格。',
  '不得用通用兜底段落、空泛管理话术或后台缺料说明冒充正文；信息不足时只写已有事实、适用边界和待复核口径。',
].join('\n');

function hasSectionNumber(section: string) {
  const match = /^\s*(\d+)\.(\d+)[.．、]?\s+(.+)$/u.exec(section);
  if (!match) return false;
  return displayChapterTitle(match[3] || '').trim() === displayChapterTitle(section).trim();
}

function structuralTitle(value: string) {
  return displayChapterTitle(value.replace(/^#+\s*/u, '')).replace(/^(?:第)?[一二三四五六七八九十百千万\d]+章\s*/u, '').trim();
}

function structuralTitleKey(value: string) {
  return structuralTitle(value).replace(/\s+/gu, '');
}

function sameStructuralTitle(left: string, right: string) {
  const leftKey = structuralTitleKey(left);
  const rightKey = structuralTitleKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function chapterHeadingText(line: string) {
  return /^##\s+(.+)$/u.exec(line.trim())?.[1] || '';
}

export function extractGeneratedSections(markdown: string) {
  const sections = [...markdown.matchAll(/^###\s+(.+)$/gmu)]
    .map(match => displayChapterTitle(match[1] || ''))
    .filter(section => section.length >= 2 && section.length <= 80)
    .filter(section => !/^\d+(?:\.\d+){2,}\s+/u.test(section));
  return [...new Set(sections)];
}

function standaloneBoldTitle(line: string) {
  const match = /^\*\*([^*]+?)\*\*\s*[:：]?\s*$/u.exec(line.trim());
  if (!match) return '';
  const title = displayChapterTitle(match[1] || '');
  if (title.length < 2 || title.length > 40) return '';
  if (/[。；;.!！?？]$/u.test(title)) return '';
  if (/^(注|说明|备注|提示|要求)[:：]/u.test(title)) return '';
  return title;
}

export function normalizeTertiaryHeadings(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  let currentSectionNumber = '';
  let tertiaryIndex = 0;
  const normalized = lines.map(line => {
    const section = /^###\s+(\d+\.\d+)\s+.+$/u.exec(line.trim());
    if (section) {
      currentSectionNumber = section[1];
      tertiaryIndex = 0;
      return line;
    }
    if (/^##\s+/u.test(line.trim())) {
      currentSectionNumber = '';
      tertiaryIndex = 0;
      return line;
    }
    const heading = /^(#{4,5})\s+(.+)$/u.exec(line.trim());
    if (heading) {
      if (!currentSectionNumber) return heading[1] === '#####' ? line.replace(/^\s*#####/u, '####') : line;
      const rawTitle = (heading[2] || '').trim();
      const title = displayChapterTitle(rawTitle.replace(/^\d+\.\d+\.\d+\s+/u, ''));
      if (!title) return line;
      tertiaryIndex += 1;
      return `#### ${currentSectionNumber}.${tertiaryIndex} ${title}`;
    }
    return line;
  }).join('\n');
  return normalized.replace(/\n{3,}/gu, '\n\n').trim();
}

export function tertiaryHeadingIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let currentSectionNumber = '';
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const section = /^###\s+(\d+\.\d+)\s+.+$/u.exec(line);
    if (section) {
      currentSectionNumber = section[1];
      continue;
    }
    if (/^##\s+/u.test(line)) currentSectionNumber = '';
    if (!currentSectionNumber) continue;
    const heading = /^####\s+(.+)$/u.exec(line);
    if (heading) {
      const rawTitle = (heading[1] || '').trim();
      if (!new RegExp(`^${escapedRegExp(currentSectionNumber)}\\.\\d+\\s+\\S`, 'u').test(rawTitle)) {
        issues.push({ level: 'warning', message: `三级小节缺少 ${currentSectionNumber}.x 编号：${displayChapterTitle(rawTitle)}`, suggestion: '三级小节必须使用“#### 章号.节号.序号 标题”，且不纳入目录。' });
      }
    }
  }
  return issues;
}

function tocSectionTitle(chapterIndex: number, sectionIndex: number, section: string) {
  const clean = displayChapterTitle(section);
  return hasSectionNumber(section) ? clean : `${chapterIndex + 1}.${sectionIndex + 1} ${clean}`;
}

function composeTocLines(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  return chapters.flatMap((chapter, index) => {
    const sections = chapter.sections || [];
    return [
      formalChapterTitle(index, chapter.title),
      '',
      ...sections.flatMap((section, sectionIndex) => [`  ${tocSectionTitle(index, sectionIndex, section)}`, '']),
    ];
  });
}

function composeTocMarkdown(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  return ['## 目录', '', ...composeTocLines(chapters)].join('\n');
}

export function inferChapterSectionsFromMarkdown(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  const normalizedMarkdown = normalizeFormalChapterHeadings(removeDuplicateTocBlocks(markdown), chapters);
  const headingMatches = [...normalizedMarkdown.matchAll(/^##\s+(.+)$/gmu)];
  return chapters.map((chapter, index) => {
    const expected = formalChapterTitle(index, chapter.title);
    const current = headingMatches.find(match => sameStructuralTitle(match[1] || '', expected));
    if (!current || current.index === undefined) return chapter.sections || [];
    const next = headingMatches.find(match => (match.index || 0) > (current.index || 0) && chapters.some(item => sameStructuralTitle(match[1] || '', item.title)));
    const plannedSections = chapter.sections || [];
    if (plannedSections.length > 0) return plannedSections;
    const block = normalizedMarkdown.slice(current.index, next?.index ?? normalizedMarkdown.length);
    const extracted = extractGeneratedSections(block);
    return extracted.length > 0 ? extracted.slice(0, 6) : [];
  });
}

function stripDuplicateChapterHeadings(markdown: string, targetHeading: string, chapterTitle: string) {
  const lines = markdown.split(/\r?\n/u);
  let seenTarget = false;
  return lines.filter((line, index) => {
    const trimmed = line.trim();
    const headingText = chapterHeadingText(line);
    if (headingText) {
      if (sameStructuralTitle(headingText, targetHeading)) {
        if (!seenTarget) {
          seenTarget = true;
          return true;
        }
        return false;
      }
      if (index > 0 && sameStructuralTitle(headingText, chapterTitle)) return false;
    }
    if (trimmed && !/^#{1,6}\s+/u.test(trimmed) && sameStructuralTitle(trimmed, chapterTitle)) return false;
    return true;
  }).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function normalizeChapterDraftContent(chapter: Pick<DocumentDraftChapter, 'title' | 'content'>, index: number) {
  const targetHeading = `## ${formalChapterTitle(index, chapter.title)}`;
  const cleaned = sanitizeFormalMarkdown(chapter.content);
  const normalized = /^##\s+.+$/mu.test(cleaned) ? cleaned.replace(/^##\s+.+$/mu, targetHeading) : `${targetHeading}\n\n${cleaned}`;
  return stripDuplicateChapterHeadings(normalized, targetHeading, chapter.title);
}

function removeDuplicateTocBlocks(markdown: string) {
  let seenToc = false;
  return markdown.replace(/^##\s+目录\s*$[\s\S]*?(?=\n<div class="page-break"><\/div>|\n##\s+)/gmu, match => {
    if (!seenToc) {
      seenToc = true;
      return match;
    }
    return '';
  }).replace(/\n{3,}/gu, '\n\n').trim();
}

function normalizeFormalChapterHeadings(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  let result = removeDuplicateTocBlocks(markdown);
  chapters.forEach((chapter, index) => {
    const clean = displayChapterTitle(chapter.title);
    const re = new RegExp(`^##\\s+(?:第[一二三四五六七八九十百千万\\d]+章\\s*)?${escapedRegExp(clean)}\\s*$`, 'mu');
    result = re.test(result) ? result.replace(re, `## ${formalChapterTitle(index, chapter.title)}`) : result;
  });
  const lines = result.split(/\r?\n/u);
  let chapterIndex = -1;
  let sectionIndex = 0;
  let tertiaryIndex = 0;
  let activeSourceSection = '';
  let emittedSectionKeys = new Set<string>();
  const plannedSectionIndex = (title: string) => {
    const sections = chapters[chapterIndex]?.sections || [];
    const key = normalizePlannedSectionTitle(title);
    return sections.findIndex(section => normalizePlannedSectionTitle(section) === key);
  };
  const normalizeSectionHeading = (title: string, fallbackSourceSection?: string) => {
    const cleanTitle = displayChapterTitle(title);
    const plannedIndex = plannedSectionIndex(cleanTitle);
    const plannedSections = chapters[chapterIndex]?.sections || [];
    if (plannedSections.length > 0 && plannedIndex < 0) {
      if (!sectionIndex) {
        sectionIndex = 1;
        activeSourceSection = `${chapterIndex + 1}.1`;
      }
      tertiaryIndex += 1;
      return tertiaryIndex <= 4 ? `#### ${chapterIndex + 1}.${sectionIndex}.${tertiaryIndex} ${cleanTitle}` : `**${cleanTitle}**`;
    }
    const nextIndex = plannedIndex >= 0 ? plannedIndex + 1 : sectionIndex + 1;
    const sectionKey = plannedIndex >= 0 ? normalizePlannedSectionTitle(plannedSections[plannedIndex]) : normalizePlannedSectionTitle(cleanTitle);
    if (emittedSectionKeys.has(sectionKey)) {
      sectionIndex = nextIndex;
      activeSourceSection = fallbackSourceSection || `${chapterIndex + 1}.${sectionIndex}`;
      tertiaryIndex += 1;
      return `#### ${chapterIndex + 1}.${sectionIndex}.${tertiaryIndex} ${cleanTitle}`;
    }
    sectionIndex = nextIndex;
    tertiaryIndex = 0;
    activeSourceSection = fallbackSourceSection || `${chapterIndex + 1}.${sectionIndex}`;
    emittedSectionKeys.add(sectionKey);
    return `### ${chapterIndex + 1}.${sectionIndex} ${plannedIndex >= 0 ? displayChapterTitle(plannedSections[plannedIndex]) : cleanTitle}`;
  };
  return lines.map(line => {
    const trimmed = line.trim();
    if (/^##\s+第[一二三四五六七八九十百千万\d]+章\s+/u.test(trimmed)) {
      chapterIndex += 1;
      sectionIndex = 0;
      tertiaryIndex = 0;
      activeSourceSection = '';
      emittedSectionKeys = new Set<string>();
      return line;
    }
    const h2SingleNumberedSection = /^##\s+\d+[.．、]\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2SingleNumberedSection) return normalizeSectionHeading(h2SingleNumberedSection[1] || '');
    const h2NumberedSection = /^##\s+(\d+)\.(\d+)\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2NumberedSection) return normalizeSectionHeading(h2NumberedSection[3] || '', `${h2NumberedSection[1]}.${h2NumberedSection[2]}`);
    const section = /^###\s+(?:(\d+)\.(\d+)\s+)?(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && section) return normalizeSectionHeading(section[3] || '', section[1] && section[2] ? `${section[1]}.${section[2]}` : undefined);
    const h3NumberedAsSection = /^####\s+(\d+)\.(\d+)(?!\.)\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h3NumberedAsSection) return normalizeSectionHeading(h3NumberedAsSection[3] || '', `${h3NumberedAsSection[1]}.${h3NumberedAsSection[2]}`);
    const tertiary = /^####\s+(?:(\d+)\.(\d+)\.(\d+)\s+)?(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && tertiary) {
      const sourceSection = tertiary[1] && tertiary[2] ? `${tertiary[1]}.${tertiary[2]}` : activeSourceSection;
      const title = displayChapterTitle(tertiary[4] || '');
      const titleKey = normalizePlannedSectionTitle(title);
      const isPlannedUnemittedSection = plannedSectionIndex(title) >= 0 && !emittedSectionKeys.has(titleKey);
      if (!sectionIndex) return normalizeSectionHeading(title, sourceSection);
      if (sourceSection && sourceSection !== activeSourceSection && ((chapters[chapterIndex]?.sections || []).length === 0 || isPlannedUnemittedSection)) return normalizeSectionHeading(title, sourceSection);
      tertiaryIndex += 1;
      return tertiaryIndex <= 4 ? `#### ${chapterIndex + 1}.${sectionIndex}.${tertiaryIndex} ${title}` : `**${title}**`;
    }
    return line;
  }).join('\n');
}

export function ensureFormalToc(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  const normalizedMarkdown = normalizeFormalChapterHeadings(markdown, chapters);
  const toc = composeTocMarkdown(chapters);
  if (/^##\s+目录\s*$/mu.test(normalizedMarkdown)) {
    return normalizedMarkdown.replace(/^##\s+目录\s*$[\s\S]*?(?=\n<div class="page-break"><\/div>|\n##\s+)/mu, toc.trim());
  }
  const coverBreak = '<div class="page-break"></div>';
  const index = normalizedMarkdown.indexOf(coverBreak);
  if (index >= 0) {
    const insertAt = index + coverBreak.length;
    return `${normalizedMarkdown.slice(0, insertAt)}\n\n${toc}\n\n${coverBreak}\n\n${normalizedMarkdown.slice(insertAt).trimStart()}`;
  }
  return `${toc}\n\n<div class="page-break"></div>\n\n${normalizedMarkdown}`;
}

function escapedRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function findChapterBlock(markdown: string, title: string) {
  const target = normalizeGeneratedChapterTitle(title);
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gmu)].map(match => ({ index: match.index || 0, raw: match[0], title: normalizeGeneratedChapterTitle(match[1] || '') }));
  const current = headings.find(item => item.title === target);
  if (!current) return undefined;
  const next = headings.find(item => item.index > current.index && item.title !== target);
  const bodyStart = current.index + current.raw.length;
  const end = next?.index ?? markdown.length;
  return { start: current.index, end, heading: current.raw, body: markdown.slice(bodyStart, end) };
}

function hasMarkdownTable(markdown: string) {
  return /\|[^\n]+\|\s*\n\s*\|\s*:?-{3,}:?\s*\|/u.test(markdown);
}

function normalizePlannedSectionTitle(title: string) {
  return displayChapterTitle(title.replace(/^\s*\d+(?:\.\d+)*[.．、]?\s*/u, '')).replace(/[\s:：.。]+$/gu, '').trim();
}

function hasPlannedSection(body: string, section: string) {
  const target = normalizePlannedSectionTitle(section);
  return body.split(/\r?\n/u).some(line => {
    const match = /^#{2,4}\s+(.+)$/u.exec(line.trim());
    if (!match) return false;
    return normalizePlannedSectionTitle(match[1] || '') === target;
  });
}

export function plannedStructurePrompt(template: DocumentTemplate) {
  return template.chapters.map(chapter => [
    `- ${chapter.title}`,
    chapter.sections?.length ? `  规划小节：${chapter.sections.join('、')}` : '',
    chapter.tableSections?.length ? `  表格小节：${chapter.tableSections.join('、')}` : '',
    chapter.tableRequirements?.length ? `  表格内容要求：${chapter.tableRequirements.join('；')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
}

export function plannedStructureIssues(markdown: string, template: DocumentTemplate): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of template.chapters) {
    const block = findChapterBlock(markdown, chapter.title);
    if (!block) {
      issues.push({ level: 'error', message: `${chapter.title} 正文缺少章节标题`, suggestion: '请重新生成，确保模板章节完整输出。' });
      continue;
    }
    const body = block.heading + block.body;
    const missingSections = (chapter.sections || []).filter(section => !hasPlannedSection(body, section));
    if (missingSections.length > 0) issues.push({ level: 'error', message: `${chapter.title} 正文缺少规划小节：${missingSections.join('、')}`, suggestion: '请重新生成或检查审查阶段是否删除了二级小节。' });
    if (chapter.tableSections?.length && !hasMarkdownTable(body)) issues.push({ level: 'error', message: `${chapter.title} 缺少必要的正式表格`, suggestion: '请按模板 tableSections/tableRequirements 在对应小节补充正式 Markdown 表格。' });
  }
  return issues;
}

function sortChapterSectionsByNumber(markdown: string) {
  const chapterMatches = [...markdown.matchAll(/^##\s+.+$/gmu)];
  if (chapterMatches.length === 0) return markdown;
  let result = markdown.slice(0, chapterMatches[0].index || 0);
  for (let chapterIndex = 0; chapterIndex < chapterMatches.length; chapterIndex += 1) {
    const chapterStart = chapterMatches[chapterIndex].index || 0;
    const chapterEnd = chapterMatches[chapterIndex + 1]?.index ?? markdown.length;
    const block = markdown.slice(chapterStart, chapterEnd);
    const sectionMatches = [...block.matchAll(/^###\s+(\d+)\.(\d+)\s+.+$/gmu)];
    if (sectionMatches.length < 2) {
      result += block;
      continue;
    }
    const firstSectionStart = sectionMatches[0].index || 0;
    const prefix = block.slice(0, firstSectionStart);
    const sections = sectionMatches.map((match, index) => {
      const start = match.index || 0;
      const end = sectionMatches[index + 1]?.index ?? block.length;
      return { order: Number(match[2] || index + 1), content: block.slice(start, end).trim() };
    });
    result += prefix + sections.sort((left, right) => left.order - right.order).map(section => section.content).join('\n\n') + '\n\n';
  }
  return result.replace(/\n{3,}/gu, '\n\n').trim();
}

export function finalizeDocumentMarkdown<T extends Pick<DocumentDraftChapter, 'title' | 'sections'>>(markdown: string, chapters: T[], options: { forbidDrawingImages?: boolean } = {}) {
  const cleanedMarkdown = removeUnwantedDrawingImages(markdown, Boolean(options.forbidDrawingImages));
  const normalizedMarkdown = sortChapterSectionsByNumber(normalizeTertiaryHeadings(sanitizeFormalMarkdown(cleanedMarkdown)));
  const inferredSections = inferChapterSectionsFromMarkdown(normalizedMarkdown, chapters);
  const finalizedChapters = chapters.map((chapter, index) => ({
    ...chapter,
    sections: inferredSections[index]?.length ? inferredSections[index] : chapter.sections || [],
  }));
  const finalizedMarkdown = sortChapterSectionsByNumber(normalizeTertiaryHeadings(sanitizeFormalMarkdown(ensureFormalToc(normalizedMarkdown, finalizedChapters))));
  return { markdown: finalizedMarkdown, chapters: finalizedChapters };
}

export function composeDocumentMarkdown(draft: Omit<GeneratedDocumentDraft, 'markdown'>): string {
  const chapterMarkdown = draft.chapters
    .map((chapter, index) => normalizeChapterDraftContent(chapter, index))
    .filter(Boolean)
    .join('\n\n');
  const initialMarkdown = [
    `<div class="document-cover">`,
    `# ${draft.title}`,
    '',
    `</div>`,
    '',
    '<div class="page-break"></div>',
    '',
    composeTocMarkdown(draft.chapters),
    '',
    '<div class="page-break"></div>',
    '',
    chapterMarkdown,
  ].join('\n');

  return finalizeDocumentMarkdown(initialMarkdown, draft.chapters).markdown;
}
