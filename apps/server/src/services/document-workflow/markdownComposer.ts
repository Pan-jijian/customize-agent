import type { DocumentDraftChapter, DocumentTemplate, GeneratedDocumentDraft, ValidationIssue } from './types';
import { CAD_ENTITY_TOKEN_RE, FILE_NAME_RE } from './constants';
import { displayChapterTitle, formalChapterTitle } from './outline';

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
  return normalizeProductionText(stripMarkdownDocumentFence(markdown))
    .replace(WORKFLOW_PHRASE_RE, '')
    .replace(RAW_SOURCE_LINE_RE, '')
    .replace(ASCII_FLOW_LINE_RE, '')
    .replace(FILE_NAME_RE, '')
    .replace(/^#\s+/gmu, '')
    .replace(CAD_ENTITY_TOKEN_RE, '')
    .replace(/第\s*\d+\s*页\s*\/\s*共\s*\d+\s*页/gu, '')
    .replace(/\|\s*(?:[/—-]|无|暂无|待定|待补充|N\/?A)\s*(?=\|)/giu, '| 结合项目资料及现场深化确认 ')
    .replace(/见(?:公告|文件|资料|附件|相关文件)/gu, '依据已提供资料')
    .replace(/按(?:资料|文件|设计要求|相关规范|有关规范|标准|要求)/gu, '依据已提供资料和适用标准')
    .replace(/满足(?:相关|有关)?要求/gu, '满足资料约束、适用标准和正式交付要求')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export const FORMAL_WRITING_RULES = [
  '你正在生成可直接交付的正式业务文档，不是分析报告、证据报告或系统调试报告。',
  '不得把“知识库、检索、文件角色、提示词角色、规范包、事实字段、项目基础事实候选、动态章节、缺失项、校验结果、资料未提供、未检索到”等后台流程话术写入正文。',
  '文档结构优先遵循用户需求、模板章节和绑定提示词；后台内容优化建议只用于提升事实覆盖和表达质量，不得新增、删除或重排章节。',
  '资料信息应内化为正式正文表达；除非用户要求来源追溯章节，否则不要单列系统证据清单。',
  '表格、标题和公式必须使用 Markdown/导出友好的写法，避免 ASCII 流程图和容易导致导出异常的符号组合。',
  '正式正文不得把原始公告、规则条款、说明性附件或系统过程内容误作为章节标题或目录项。',
  '如绑定资料中存在项目基础事实，应在相关章节自然吸收；如模板或用户要求表格化呈现，表格前只保留必要引导语，不得逐项重复叙述同一批字段。',
  '正文必须以当前模板、用户要求和绑定资料中的真实对象、范围、数量、时间、规格、标准、责任和约束为依据，不得自由发挥。',
  '同一规则、方案、流程或措施适用于多个对象、区域、主体、片区或分项时，必须逐项覆盖适用范围和对应依据，不得只写一个代表性对象后泛化到全部范围。',
  '不得使用“本节”“本章将”“以下从”“以下内容”等模板化前缀；标题后直接进入本章对象、关键事实、处理要求、控制措施和结果闭环。',
  '正文二级小节下如需设置三级小节，必须使用“#### 章号.节号.序号 标题”，例如“#### 2.2.1 关键事项”；不得用无编号独立加粗行表示三级小节；三级小节不纳入目录。',
  '资料不足或不同来源数值冲突时，应保持审慎并提示复核口径，不得编造精确数量。',
  '语言应正式、专业、克制，适合直接导出交付。',
].join('\n');

function hasSectionNumber(section: string) {
  return /^\s*\d+(?:\.\d+)+\s+/.test(section);
}

export function extractGeneratedSections(markdown: string) {
  const sections = [...markdown.matchAll(/^#{3,4}\s+(.+)$/gmu)]
    .map(match => displayChapterTitle(match[1] || ''))
    .filter(section => section.length >= 2 && section.length <= 80)
    .filter(section => !/^\d+(?:\.\d+){2,}\s+/u.test(section));
  return [...new Set(sections)].slice(0, 12);
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
    if (!currentSectionNumber) return line;
    const boldTitle = standaloneBoldTitle(line);
    if (boldTitle) {
      tertiaryIndex += 1;
      return `#### ${currentSectionNumber}.${tertiaryIndex} ${boldTitle}`;
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
    const boldTitle = standaloneBoldTitle(line);
    if (boldTitle) issues.push({ level: 'warning', message: `独立加粗行疑似未编号三级小节：${boldTitle}`, suggestion: '请改为“#### 章号.节号.序号 标题”，不要用无编号加粗行表示三级小节。' });
  }
  return issues.slice(0, 20);
}

function tocSectionTitle(chapterIndex: number, sectionIndex: number, section: string) {
  return hasSectionNumber(section) ? section : `${chapterIndex + 1}.${sectionIndex + 1} ${section}`;
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
  return chapters.map((chapter, index) => {
    const start = normalizedMarkdown.search(new RegExp(`^##\\s+${escapedRegExp(formalChapterTitle(index, chapter.title))}\\s*$`, 'mu'));
    if (start < 0) return chapter.sections || [];
    const rest = normalizedMarkdown.slice(start);
    const next = rest.slice(1).search(/^##\s+/mu);
    const block = next >= 0 ? rest.slice(0, next + 1) : rest;
    const extracted = extractGeneratedSections(block);
    return extracted.length > 0 ? extracted : chapter.sections || [];
  });
}

function normalizeChapterDraftContent(chapter: Pick<DocumentDraftChapter, 'title' | 'content'>, index: number) {
  const targetHeading = `## ${formalChapterTitle(index, chapter.title)}`;
  const cleaned = sanitizeFormalMarkdown(chapter.content);
  return /^##\s+.+$/mu.test(cleaned) ? cleaned.replace(/^##\s+.+$/mu, targetHeading) : `${targetHeading}\n\n${cleaned}`;
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
  return lines.map(line => {
    const trimmed = line.trim();
    if (/^##\s+第[一二三四五六七八九十百千万\d]+章\s+/u.test(trimmed)) {
      chapterIndex += 1;
      sectionIndex = 0;
      return line;
    }
    const h2NumberedSection = /^##\s+(\d+)\.(\d+)\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2NumberedSection) {
      sectionIndex = Number(h2NumberedSection[2]) || sectionIndex + 1;
      return `### ${chapterIndex + 1}.${sectionIndex} ${displayChapterTitle(h2NumberedSection[3] || '')}`;
    }
    const section = /^###\s+(?:(\d+)\.(\d+)\s+)?(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && section) {
      sectionIndex += 1;
      return `### ${chapterIndex + 1}.${sectionIndex} ${displayChapterTitle(section[3] || '')}`;
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
  const clean = displayChapterTitle(title);
  const re = new RegExp(`(^##\\s+(?:第[一二三四五六七八九十百千万\\d]+章\\s*)?${escapedRegExp(clean)}\\s*$)([\\s\\S]*?)(?=\\n##\\s+|(?![\\s\\S]))`, 'mu');
  const match = re.exec(markdown);
  if (!match || match.index === undefined) return undefined;
  return { start: match.index, end: match.index + match[0].length, heading: match[1] || `## ${title}`, body: match[2] || '' };
}

function hasMarkdownTable(markdown: string) {
  return /\|[^\n]+\|\s*\n\s*\|\s*:?-{3,}:?\s*\|/u.test(markdown);
}

function sectionPattern(section: string) {
  const plain = section.replace(/^\s*\d+(?:\.\d+)+\s+/u, '').trim();
  return new RegExp(`^###\\s+(?:${escapedRegExp(section)}|(?:\\d+(?:\\.\\d+)+\\s+)?${escapedRegExp(plain)})\\s*$`, 'mu');
}

export function configuredStructurePrompt(template: DocumentTemplate) {
  return template.chapters.map(chapter => [
    `- ${chapter.title}`,
    chapter.sections?.length ? `  二级小节：${chapter.sections.join('、')}` : '',
    chapter.tableSections?.length ? `  表格小节：${chapter.tableSections.join('、')}` : '',
    chapter.tableRequirements?.length ? `  表格内容要求：${chapter.tableRequirements.join('；')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
}

export function configuredStructureIssues(markdown: string, template: DocumentTemplate): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of template.chapters) {
    const block = findChapterBlock(markdown, chapter.title);
    if (!block) {
      issues.push({ level: 'error', message: `${chapter.title} 正文缺少章节标题`, suggestion: '请重新生成，确保模板章节完整输出。' });
      continue;
    }
    const body = block.heading + block.body;
    const missingSections = (chapter.sections || []).filter(section => !sectionPattern(section).test(body));
    if (missingSections.length > 0) issues.push({ level: 'error', message: `${chapter.title} 正文缺少配置小节：${missingSections.join('、')}`, suggestion: '请重新生成或检查审查阶段是否删除了二级小节。' });
    if (chapter.tableSections?.length && !hasMarkdownTable(body)) issues.push({ level: 'error', message: `${chapter.title} 缺少必要的正式表格`, suggestion: '请按模板 tableSections/tableRequirements 在对应小节补充正式 Markdown 表格。' });
  }
  return issues;
}

export function composeDocumentMarkdown(draft: Omit<GeneratedDocumentDraft, 'markdown'>): string {
  const chapterMarkdown = draft.chapters
    .map((chapter, index) => normalizeChapterDraftContent(chapter, index))
    .filter(Boolean)
    .join('\n\n');
  const tocMarkdown = composeTocMarkdown(draft.chapters);

  return sanitizeFormalMarkdown([
    `<div class="document-cover">`,
    `# ${draft.title}`,
    '',
    `</div>`,
    '',
    '<div class="page-break"></div>',
    '',
    tocMarkdown,
    '',
    '<div class="page-break"></div>',
    '',
    chapterMarkdown,
  ].join('\n'));
}
