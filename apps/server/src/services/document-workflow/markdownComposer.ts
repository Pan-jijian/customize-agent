import type { DocumentDraftChapter, DocumentTemplate, GeneratedDocumentDraft, PromptDocumentRuleSet, ValidationIssue } from './types';
import { CAD_ENTITY_TOKEN_RE, FILE_NAME_RE } from './constants';
import { displayChapterTitle, formalChapterTitle, normalizeGeneratedChapterTitle } from './outline';

export function removeUnwantedDrawingImages(markdown: string, forbid: boolean) {
  if (!forbid) return markdown;
  return markdown.replace(/^!\[[^\]]*(?:图纸|drawing|cad|地图|平面|剖面|立面)[^\]]*\]\([^)]*\)\s*$/gimu, '').replace(/\n{3,}/gu, '\n\n');
}

export const WORKFLOW_PHRASE_RE = /.*(?:知识库证据|知识库已确认事实|资料类型|提示词角色|后台自动规范|规范包|事实字段|资料未提供|未检索到|待确认事项|证据来源|来源清单|校验结果|修复任务包|修复类型|修复对象|输出要求).*(?:\n|$)/gu;
const RAW_SOURCE_LINE_RE = /^\s*(?:#{1,6}\s*)?(?:PDF\s*第\s*\d+\s*页|rule\b|文件[:：]|片段[:：]|来源[:：]).*$/gimu;
const ASCII_FLOW_LINE_RE = /^\s*(?:[│┃┆┊┌┐└┘├┤┬┴┼─━╭╮╰╯]|[↓↑→←⇒⇨➡])+\s*$/gmu;
const INSTRUCTION_HEADING_RE = /^#{2,6}\s+(?:\d+(?:\.\d+)*\s*)?(?:[-—–]\s*)?(?:判断|判定|识别|确认)?是否(?:涉及|涉|需要|适用)|^#{2,6}\s+(?:\d+(?:\.\d+)*\s*)?(?:[-—–]\s*)?(?:如|若|如果)(?:涉及|不涉及|适用|不适用)|^#{2,6}\s+.*(?:根据|结合).{0,12}(?:实际情况|项目情况|资料情况).{0,8}(?:判断|确定|编写|生成)|^#{2,6}\s+.*(?:按需(?:生成|编写)|视情况|判断后|生成要求|编写要求|说明要求|注意事项)\s*$/gmu;
const INSTRUCTION_TITLE_RE = /^(?:\d+(?:\.\d+)*\s*)?(?:[-—–]\s*)?(?:(?:判断|判定|识别|确认)?是否(?:涉及|涉|需要|适用).*|(?:如|若|如果)(?:涉及|不涉及|适用|不适用).*|.*(?:根据|结合).{0,12}(?:实际情况|项目情况|资料情况).{0,8}(?:判断|确定|编写|生成).*|.*(?:按需(?:生成|编写)|视情况|判断后|生成要求|编写要求|说明要求|注意事项))\s*$/u;

function instructionTitleCandidate(value: string) {
  return value
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^\s*\d+(?:\.\d+)*(?:[.．、]|\s)+/u, '')
    .replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分]\s*/u, '')
    .trim();
}

function isInstructionLikeTitle(value: string) {
  const rawTitle = instructionTitleCandidate(value);
  const displayTitle = displayChapterTitle(rawTitle);
  return INSTRUCTION_TITLE_RE.test(rawTitle) || INSTRUCTION_TITLE_RE.test(displayTitle);
}

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

export function normalizeTenderSourcePageRefs(markdown: string) {
  return markdown
    .replace(/PDF\s*第\s*\d+\s*页/giu, '相关资料')
    .replace(/第\s*\d+\s*页\s*\/\s*共\s*\d+\s*页/gu, '')
    .replace(/第\s*\d+\s*(?:[-—至到~～]\s*\d+)?\s*页/gu, '相关资料')
    .replace(/(装饰工程|土建工程|加固工程|给排水工程|电气工程|智能化工程|消防工程|弱电智能化工程|室外道排工程|建筑结构加固工程)\s*(?:(?:施工)?图纸|资料|文件)?\s*[（(]?\s*(?:(?:共|多达|约|合计)\s*)?\d+\s*页\s*[）)]?/gu, '$1施工图纸')
    .replace(/\d+\s*页\s*(装饰|土建|加固|给排水|电气|智能化|消防|弱电智能化|室外道排|建筑结构加固)\s*(?:专业)?\s*(?:(?:施工)?图纸)?/gu, '$1专业图纸')
    .replace(/(装饰|土建|加固|给排水|电气|智能化|消防|弱电智能化|室外道排|建筑结构加固)\s*(?:专业)?\s*(?:[（(]\s*)?\d+\s*页\s*(?:(?:施工)?图纸)?\s*[）)]?/gu, '$1专业图纸')
    .replace(/([\u4e00-\u9fa5A-Za-z0-9、及与和]{2,24})\s*(?:共|多达|约|合计)\s*\d+\s*页/gu, '$1相关专业图纸')
    .replace(/([\u4e00-\u9fa5A-Za-z0-9（）()、·-]{2,24}工程)\s*(?:图纸|资料|文件)?\s*[（(]?\s*(?:(?:共|多达|约|合计)\s*)?\d+\s*页\s*[）)]?/gu, '$1施工图纸')
    .replace(/([\u4e00-\u9fa5A-Za-z0-9（）()、·-]{2,24})(?<!施工)\s*(?:施工)?图纸\s*[（(]?\s*(?:(?:共|多达|约|合计)\s*)?\d+\s*页\s*[）)]?/gu, '$1施工图纸')
    .replace(/(给排水|电气|智能化|消防|暖通|人防)\s*[（(]\s*\d+\s*页\s*[）)]/gu, '$1专业图纸')
    .replace(/(?:依据|按照|结合)?\s*图纸\s*[（(]\s*\d+\s*页\s*[）)]/gu, '依据相关专业图纸')
    .replace(/(?:依据|按照|结合)?\s*清单\s*[（(]?\s*\d+\s*页\s*[）)]?/gu, '依据工程量清单')
    .replace(/资料\s*[（(]?\s*\d+\s*页\s*[）)]?/gu, '项目资料')
    .replace(/[（(]?[\u4e00-\u9fa5A-Za-z0-9、及与和]*(?:图纸|清单|资料|文件|工程)?[\u4e00-\u9fa5A-Za-z0-9、及与和]*(?:(?:共|多达|约|合计)\s*)?\d+\s*页[\u4e00-\u9fa5A-Za-z0-9、及与和]*(?:图纸|清单|资料|文件)?[）)]?/gu, match => /图纸|工程|装饰|土建|加固|给排水|电气|智能化|消防/u.test(match) ? '相关专业图纸' : /清单/u.test(match) ? '工程量清单' : '相关资料')
    .replace(/(?:位于|详见|见|参见|依据|按照|结合)?\s*相关资料(?:\s*相关资料)+/gu, '相关资料');
}

const INLINE_LIST_MARKER_RE = String.raw`(?:\d+[.、](?=\s|\*\*)\s*|[（(]\d+[）)]\s*|[-*+]\s+)`;
const INLINE_LIST_PAIR_RE = new RegExp(String.raw`\S.+(?:\s|[。；;])${INLINE_LIST_MARKER_RE}\S.+(?:\s|[。；;])${INLINE_LIST_MARKER_RE}\S`, 'u');

export function hasInlineListCollision(line: string) {
  return INLINE_LIST_PAIR_RE.test(line) && !/\b\d+\.\d+\s*(?:mm|cm|m|㎡|m2|kg|t|MPa|kPa|V|KV|kV|A)\b/iu.test(line);
}

function normalizeInlineListsInLine(line: string) {
  if (/^\s*\|/u.test(line) || /^\s*\|?\s*:?-{3,}:?/u.test(line)) return line;
  return line
    .replace(/([。；;])\s*(?=(?:\d+[.、](?=\s|\*\*)\s*|[（(]\d+[）)]\s*|[-*+]\s+)\S)/gu, '$1\n')
    .replace(/([^\n])\s+(?=(?:\d+[.、](?=\s|\*\*)\s*|[（(]\d+[）)]\s*|[-*+]\s+)\*\*)/gu, '$1\n');
}

export function normalizeInlineListBreaks(markdown: string) {
  return markdown.split(/\r?\n/u).map(normalizeInlineListsInLine).join('\n').replace(/\n{3,}/gu, '\n\n');
}

function isMarkdownTableDivider(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line);
}

function isMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  return /^\|.*\|$/u.test(trimmed) && trimmed.split('|').length >= 3;
}

function tableColumnCount(line: string) {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).length;
}

function dividerForColumns(columns: number) {
  return `| ${Array.from({ length: Math.max(2, columns) }, () => '---').join(' | ')} |`;
}

function normalizeTableRowColumns(line: string, columns: number) {
  const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => cell.trim());
  while (cells.length < columns) cells.push('');
  return `| ${cells.slice(0, columns).join(' | ')} |`;
}

function looksLikeTableHeader(line: string) {
  const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => cell.replace(/\*\*/gu, '').trim());
  if (cells.length < 2) return false;
  const headerCells = cells.filter(cell => /^(?:序号|信息项|内容|控制项目|控制内容|执行要求|责任主体|检查(?:与验收)?|验收标准|备注|名称|规格(?:型号)?|单位|数量|阶段|措施|风险|应急物资名称|资源类别|投入计划|管理要求)$/u.test(cell));
  return headerCells.length >= Math.min(2, cells.length);
}

export function normalizeMarkdownTableDividers(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  const output: string[] = [];
  let activeColumns = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isMarkdownTableRow(line) || isMarkdownTableDivider(line)) {
      if (!isMarkdownTableDivider(line)) activeColumns = 0;
      output.push(line);
      continue;
    }
    const next = lines[index + 1] || '';
    const columns = activeColumns || tableColumnCount(line);
    output.push(normalizeTableRowColumns(line, columns));
    if (isMarkdownTableDivider(next)) {
      output.push(dividerForColumns(columns));
      activeColumns = columns;
      index += 1;
      continue;
    }
    if (!activeColumns && isMarkdownTableRow(next) && looksLikeTableHeader(line)) {
      output.push(dividerForColumns(columns));
      activeColumns = columns;
    }
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n');
}

export function stripMarkdownDocumentFence(markdown: string) {
  const trimmed = markdown.trim();
  const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/iu.exec(trimmed);
  return match ? match[1].trim() : markdown;
}

export function sanitizeFormalMarkdown(markdown: string) {
  const cleaned = normalizeMarkdownTableDividers(normalizeInlineListBreaks(normalizeTenderSourcePageRefs(normalizeProductionText(stripMarkdownDocumentFence(markdown)))))
    .replace(WORKFLOW_PHRASE_RE, '')
    .replace(RAW_SOURCE_LINE_RE, '')
    .replace(ASCII_FLOW_LINE_RE, '')
    .replace(INSTRUCTION_HEADING_RE, '')
    .replace(FILE_NAME_RE, '')
    .replace(/^#\s+/gmu, '')
    .replace(CAD_ENTITY_TOKEN_RE, '');
  return cleaned.split(/\r?\n/u)
    .filter((line, index, lines) => {
      const previousPlain = index > 0 ? displayChapterTitle((lines[index - 1] || '').trim().replace(/^#{1,6}\s+/u, '')) : '';
      const currentPlain = displayChapterTitle(line.trim().replace(/^#{1,6}\s+/u, ''));
      if (previousPlain && isInstructionLikeTitle(previousPlain) && currentPlain.length > 0 && currentPlain.length <= 12 && !/^#{1,6}\s/u.test(line.trim())) return false;
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/该小节围绕.+进行补充说明/u.test(trimmed)) return false;
      if (/仅作为内部事实提取依据|正式正文不得引用文件名|后台事实|内部事实/u.test(trimmed)) return false;
      if (/^\s*\|/u.test(trimmed) || /^\s*\|?\s*:?-{3,}:?/u.test(trimmed)) return true;
      const plain = displayChapterTitle(trimmed.replace(/^#{1,6}\s+/u, ''));
      if (/^(?:雨季|冬季|高温|台风|大风等特殊气候|雨季、冬季、高温、台风、大风等特殊气候)$/u.test(plain)) return false;
      if (plain.length <= 1) return false;
      if (isInstructionLikeTitle(plain)) return false;
      return !(/[，、；：和与在为对将]$/u.test(plain) || /(通过|包括|如下|主要包括)$/u.test(plain));
    })
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export const MARKDOWN_TABLE_FORMAT_RULES = [
  'Markdown 表格格式硬约束：凡是输出 Markdown 表格，必须使用标准 GFM 表格格式。',
  '表格必须包含表头行、分隔线和数据行；表头下一行必须是分隔线，例如 |---|---|。',
  '禁止只输出连续的“| 字段 | 值 |”裸表格行；两列键值信息表默认使用表头 | 信息项 | 内容 |。',
  '表头、分隔线和数据行必须连续，中间不得插入正文、说明、空行或补充段落。',
  '正文表格不得展示后台溯源列或系统过程列，如“资料来源/说明”“资料来源/证明”“知识库来源”等。',
  '项目名称、项目编号、招标人/业主/建设单位、建设地点、建设规模、计划工期、质量标准、合同估算价等项目基础信息，只能在项目基本信息表中集中输出一次；后续章节如需引用，应写入正文或专业表格的业务字段，不得重复生成项目基础信息键值表。',
].join('\n');

export const FORMAL_WRITING_RULES = [
  '以下规则仅用于保障导出格式正确和事实安全，不得覆盖用户在提示词中已明确的要求。',
  '不得把”知识库、检索、资料类型、提示词角色、规范包、事实字段、缺失项、校验结果、资料未提供、未检索到”等后台流程话术写入正文。',
  // 导出格式 —— DOCX/PDF 渲染器依赖以下 Markdown 规范
  '【导出格式】章标题用 ## ，节标题用 ### 加数字编号（如 1.1），小节标题用 #### 加数字编号（如 1.1.1）。禁止用数字编号或粗体代替 ###/#### 标题。',
  MARKDOWN_TABLE_FORMAT_RULES,
  // 段落格式 —— 导出渲染需要双换行才是段落
  '【段落格式】段落之间必须空行（双换行）分隔，不得用单换行连续写大段文字。列表项逐行独占。步骤描述之间加空行。',
  '正文事实必须来自绑定材料；信息不足时保持审慎，不得编造精确数量。',
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
    .filter(section => !isInstructionLikeTitle(section))
    .filter(section => !/^\d+(?:\.\d+){2,}\s+/u.test(section));
  return [...new Set(sections)];
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

function normalizeTocSection(section: string) {
  const raw = section.replace(/\*+/gu, '').trim();
  if (isInstructionLikeTitle(raw)) return '';
  const clean = displayChapterTitle(raw).replace(/^[-—–]\s*/u, '').trim();
  if (isInstructionLikeTitle(clean)) return '';
  if (/^(?:雨季|冬季|高温|台风|大风等特殊气候)$/u.test(clean)) return '';
  return clean;
}

function cleanTocSections(sections: string[] = []) {
  return [...new Set(sections.map(normalizeTocSection).filter(section => section.length >= 2))];
}

function composeTocLines(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  return chapters.flatMap((chapter, index) => {
    const sections = cleanTocSections(chapter.sections || []);
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

function removeCoverBlock(markdown: string) {
  return markdown.replace(/<div class="document-cover">[\s\S]*?<\/div>\s*(?:<div class="page-break"><\/div>\s*)?/giu, '').replace(/^#\s+.+\n{1,2}/u, '');
}

function removeTocBlock(markdown: string) {
  return markdown
    .replace(/^##\s+目录\s*$[\s\S]*?(?=\n<div class="page-break"><\/div>|\n##\s+第[一二三四五六七八九十百千万\d]+章|\n##\s+)/gmu, '')
    .replace(/^<div class="page-break"><\/div>\s*(?=##\s+第[一二三四五六七八九十百千万\d]+章)/gmu, '');
}

export function inferChapterSectionsFromMarkdown(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  const bodyMarkdown = removeTocBlock(markdown);
  const normalizedMarkdown = normalizeFormalChapterHeadings(removeDuplicateTocBlocks(bodyMarkdown), chapters);
  const headingMatches = [...normalizedMarkdown.matchAll(/^##\s+(.+)$/gmu)];
  return chapters.map((chapter, index) => {
    const expected = formalChapterTitle(index, chapter.title);
    const current = headingMatches.find(match => sameStructuralTitle(match[1] || '', chapter.title) || sameStructuralTitle(match[1] || '', expected));
    if (!current || current.index === undefined) return chapter.sections || [];
    const next = headingMatches.find(match => (match.index || 0) > (current.index || 0) && chapters.some(item => sameStructuralTitle(match[1] || '', item.title)));
    const block = normalizedMarkdown.slice(current.index, next?.index ?? normalizedMarkdown.length);
    const extracted = extractGeneratedSections(block);
    if (extracted.length > 0) return extracted.slice(0, 12);
    return chapter.sections || [];
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
    const cleanTitle = normalizeTocSection(title);
    if (!cleanTitle || isInstructionLikeTitle(title) || isInstructionLikeTitle(cleanTitle)) return '';
    const plannedIndex = plannedSectionIndex(cleanTitle);
    const plannedSections = chapters[chapterIndex]?.sections || [];
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
  let inTocBlock = false;
  return lines.map(line => {
    const trimmed = line.trim();
    if (/^##\s+目录\s*$/u.test(trimmed)) {
      inTocBlock = true;
      return line;
    }
    if (inTocBlock && /^<div class="page-break"><\/div>$/u.test(trimmed)) {
      inTocBlock = false;
      return line;
    }
    if (inTocBlock) return line;
    if (/^##\s+第[一二三四五六七八九十百千万\d]+章\s+/u.test(trimmed)) {
      chapterIndex += 1;
      sectionIndex = 0;
      tertiaryIndex = 0;
      activeSourceSection = '';
      emittedSectionKeys = new Set<string>();
      return line;
    }
    const h2ChineseSection = /^##\s+第[一二三四五六七八九十百千万\d]+节\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2ChineseSection) return normalizeSectionHeading(h2ChineseSection[1] || '');
    const h2SingleNumberedSection = /^##\s+\d+[.．、]\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2SingleNumberedSection) return normalizeSectionHeading(h2SingleNumberedSection[1] || '');
    const h2NumberedSection = /^##\s+(\d+)\.(\d+)\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2NumberedSection) return normalizeSectionHeading(h2NumberedSection[3] || '', `${h2NumberedSection[1]}.${h2NumberedSection[2]}`);
    const h2PlainSection = /^##\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2PlainSection) {
      const plainTitle = displayChapterTitle(h2PlainSection[1] || '');
      if (/^本章目录$/u.test(plainTitle)) return '';
      return normalizeSectionHeading(plainTitle);
    }
    const section = /^###\s+(?:(\d+)\.(\d+)\s+)?(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && section) return normalizeSectionHeading(section[3] || '', section[1] && section[2] ? `${section[1]}.${section[2]}` : undefined);
    const h3NumberedAsSection = /^####\s+(\d+)\.(\d+)(?!\.)\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h3NumberedAsSection) return normalizeSectionHeading(h3NumberedAsSection[3] || '', `${h3NumberedAsSection[1]}.${h3NumberedAsSection[2]}`);
    const tertiary = /^####\s+(?:(\d+)\.(\d+)\.(\d+)\s+)?(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && tertiary) {
      const sourceSection = tertiary[1] && tertiary[2] ? `${tertiary[1]}.${tertiary[2]}` : activeSourceSection;
      const title = displayChapterTitle(tertiary[4] || '');
      const titleKey = normalizePlannedSectionTitle(title);
      const isPlannedPendingSection = plannedSectionIndex(title) >= 0 && !emittedSectionKeys.has(titleKey);
      if (!sectionIndex) return normalizeSectionHeading(title, sourceSection);
      if (sourceSection && sourceSection !== activeSourceSection && ((chapters[chapterIndex]?.sections || []).length === 0 || isPlannedPendingSection)) return normalizeSectionHeading(title, sourceSection);
      tertiaryIndex += 1;
      return tertiaryIndex <= 4 ? `#### ${chapterIndex + 1}.${sectionIndex}.${tertiaryIndex} ${title}` : `**${title}**`;
    }
    return line;
  }).filter(line => line !== '').join('\n');
}

function requiredTableMarkdown(title: string) {
  if (/项目基本信息/u.test(title)) return '';
  return [`**${title}**`, '', '| 控制项目 | 控制内容 | 执行要求 | 复核要求 |', '|---|---|---|---|', `| ${title.replace(/表$/u, '')} | 依据招标文件、施工图设计文件、工程量清单和施工组织安排填写 | 实施前完成专业复核、审批确认和交底闭环 | 不采用无依据的工程实体参数 |`].join('\n');
}

function hasProjectBasicInfoTable(markdown: string) {
  return /项目基本信息/u.test(markdown) || /\|\s*信息项\s*\|\s*内容\s*\|/u.test(markdown) || /\|\s*项目名称\s*\|[^\n]*(?:徽光阁|项目施工|工程)/u.test(markdown);
}

function targetChapterTitleForTable(title: string) {
  if (/项目基本信息|概况/u.test(title)) return /工程概况|项目概况/u;
  if (/应急/u.test(title)) return /主要施工方法|应急|安全/u;
  if (/材料|物资/u.test(title)) return /物资|材料/u;
  if (/机械|设备/u.test(title) && !/检测|试验/u.test(title)) return /机械|设备/u;
  if (/检测|试验/u.test(title)) return /质量|检测|试验/u;
  if (/劳动力/u.test(title)) return /劳动力/u;
  if (/进度|工期/u.test(title)) return /工期|进度/u;
  return undefined;
}

function insertRequiredTable(markdown: string, title: string) {
  if (/项目基本信息/u.test(title) && hasProjectBasicInfoTable(markdown)) return markdown;
  if (new RegExp(escapedRegExp(title), 'u').test(markdown)) return markdown;
  const table = requiredTableMarkdown(title);
  if (!table) return markdown;
  const chapterPattern = targetChapterTitleForTable(title);
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gmu)];
  const target = headings.find(match => chapterPattern?.test(match[1] || '')) || headings[0];
  if (!target?.index && target?.index !== 0) return `${markdown.trim()}\n\n${table}`;
  const next = headings.find(match => (match.index || 0) > (target.index || 0));
  const insertAt = next?.index ?? markdown.length;
  return `${markdown.slice(0, insertAt).trimEnd()}\n\n${table}\n\n${markdown.slice(insertAt).trimStart()}`;
}

function ensureRequiredTables(markdown: string, rules?: PromptDocumentRuleSet) {
  let next = markdown;
  for (const title of rules?.requiredTables || []) next = insertRequiredTable(next, title);
  return next;
}

function applyForbiddenTermReplacements(markdown: string, rules?: PromptDocumentRuleSet) {
  let next = markdown
    .replace(/知识库|提示词|绑定片段|后台|资料库|OCR|联网增强|联网检索|网页资料|搜索结果|根据网页|互联网资料|在线资料|浏览器|搜索引擎/giu, '项目资料')
    .replace(/建议补充/gu, '需完善')
    .replace(/\b兜底\b|兜底生成|兜底片段/gu, '补充完善')
    .replace(/施工方(?!法|案|式|针|向)/gu, '我公司')
    .replace(/投标人/gu, '我公司')
    .replace(/高度重视/gu, '严格落实')
    .replace(/重中之重/gu, '关键控制事项');
  for (const term of rules?.forbiddenTerms || []) {
    if (!term) continue;
    if (/^(?:报价明细表|最高投标限价|招标控制价)$/u.test(term)) {
      next = next.split(/\r?\n/u).filter(line => !new RegExp(escapedRegExp(term), 'u').test(line)).join('\n');
    }
  }
  return next;
}

export function applyPromptDocumentRules(markdown: string, rules?: PromptDocumentRuleSet) {
  if (!rules) return applyForbiddenTermReplacements(markdown);
  let next = ensureRequiredTables(markdown, rules);
  if (rules.forbidCover) {
    next = removeCoverBlock(next);
  }
  if (rules.forbidToc) {
    next = removeTocBlock(next);
  }
  for (const term of rules.preferredTerms || []) {
    if (!term.from || term.from === term.to) continue;
    if (term.from === '施工方') {
      next = next.replace(/施工方(?!法|案|式|针|向)/gu, term.to);
      continue;
    }
    next = next.replace(new RegExp(escapedRegExp(term.from), 'gu'), term.to);
  }
  next = applyForbiddenTermReplacements(next, rules);
  return next.replace(/\n{3,}/gu, '\n\n').trim();
}

export function ensureFormalToc(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  const normalizedMarkdown = normalizeFormalChapterHeadings(markdown, chapters);
  const bodyMarkdown = removeTocBlock(normalizedMarkdown);
  const headingMatches = [...bodyMarkdown.matchAll(/^##\s+(.+)$/gmu)];
  const tocChapters = chapters.map((chapter) => {
    if (chapter.sections?.length) return chapter;
    const current = headingMatches.find(match => sameStructuralTitle(match[1] || '', chapter.title));
    if (!current || current.index === undefined) return chapter;
    const next = headingMatches.find(match => (match.index || 0) > (current.index || 0) && chapters.some(item => sameStructuralTitle(match[1] || '', item.title)));
    const sections = extractGeneratedSections(bodyMarkdown.slice(current.index, next?.index ?? bodyMarkdown.length)).slice(0, 8);
    return sections.length ? { ...chapter, sections } : chapter;
  });
  const toc = composeTocMarkdown(tocChapters);
  const tocMatch = /^##\s+目录\s*$/mu.exec(normalizedMarkdown);
  if (tocMatch?.index !== undefined) {
    const afterToc = tocMatch.index + tocMatch[0].length;
    const nextChapter = normalizedMarkdown.slice(afterToc).search(/\n##\s+第[一二三四五六七八九十百千万\d]+章/u);
    const pageBreaks = [...normalizedMarkdown.slice(afterToc).matchAll(/\n<div class="page-break"><\/div>/gu)];
    const relativeEnd = pageBreaks[0]?.index ?? (nextChapter >= 0 ? nextChapter : normalizedMarkdown.length - afterToc);
    const end = afterToc + relativeEnd;
    return `${normalizedMarkdown.slice(0, tocMatch.index)}${toc.trim()}${normalizedMarkdown.slice(end)}`.replace(/\n{3,}/gu, '\n\n');
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

function tableNearTitle(markdown: string, title: string) {
  const titleIndex = markdown.search(new RegExp(escapedRegExp(title), 'u'));
  if (titleIndex < 0) return false;
  return hasMarkdownTable(markdown.slice(titleIndex, Math.min(markdown.length, titleIndex + 1600)));
}

function normalizePlannedSectionTitle(title: string) {
  return displayChapterTitle(title.replace(/^\s*\d+(?:\.\d+)*(?:[.．、]|\s)+/u, ''))
    .replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分]\s*/u, '')
    .replace(/[（）]/gu, match => match === '（' ? '(' : ')')
    .replace(/[\s:：.。；;,，、]+$/gu, '')
    .replace(/的(?=保障体系|管理体系|控制体系|措施|方案|计划|要求)/gu, '')
    .replace(/[\s()（）:：.。；;,，、-]/gu, '')
    .trim();
}

export function plannedStructurePrompt(template: DocumentTemplate) {
  return template.chapters.map(chapter => [
    `- ${chapter.title}`,
    chapter.sections?.length ? `  规划小节：${chapter.sections.join('、')}` : '',
    chapter.tableSections?.length ? `  表格小节：${chapter.tableSections.join('、')}` : '',
    chapter.tableRequirements?.length ? `  表格内容要求：${chapter.tableRequirements.join('；')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
}

export function promptDocumentRuleIssues(markdown: string, rules?: PromptDocumentRuleSet): ValidationIssue[] {
  if (!rules) return [];
  const issues: ValidationIssue[] = [];
  const instructionHeadings = [...markdown.matchAll(INSTRUCTION_HEADING_RE)].map(match => (match[0] || '').replace(/^#{2,6}\s+/u, '').trim()).filter(Boolean);
  if (instructionHeadings.length > 0) issues.push({ level: 'error', message: `正文存在疑似提示词指令标题：${instructionHeadings.slice(0, 5).join('、')}`, suggestion: '请删除或改写为正式施工组织设计小节标题。' });
  const hasCover = /document-cover|^#\s+/mu.test(markdown);
  const hasToc = /^##\s+目录\s*$/mu.test(markdown);
  if (rules.coverPolicy === 'required' && !hasCover) issues.push({ level: 'error', message: '正文缺少提示词要求的封面', suggestion: '用户明确要求封面时，应保留封面内容。' });
  if (rules.tocPolicy === 'required' && !hasToc) issues.push({ level: 'error', message: '正文缺少提示词要求的目录', suggestion: '用户明确要求目录时，应基于最终合法正文标题生成目录。' });
  if (rules.forbidCover && hasCover) issues.push({ level: 'error', message: '正文残留封面内容', suggestion: '总控提示词禁止封面时，正式正文必须直接进入第一章。' });
  if (rules.forbidToc && hasToc) issues.push({ level: 'error', message: '正文残留目录内容', suggestion: '总控提示词禁止目录时，正式正文不得生成目录或导航页。' });
  const missingTables = (rules.requiredTables || []).filter(title => !new RegExp(escapedRegExp(title), 'u').test(markdown) || !tableNearTitle(markdown, title));
  if (missingTables.length > 0) issues.push({ level: 'error', message: `正文缺少总控提示词要求的正式表格：${missingTables.join('、')}`, suggestion: '请在对应章节补齐表名、表头、分隔线和数据行，不得只写表名或空表。' });
  const missingKeywords = (rules.requiredKeywords || []).filter(keyword => keyword && !new RegExp(escapedRegExp(keyword), 'u').test(markdown));
  if (missingKeywords.length > 0) issues.push({ level: 'warning', message: `正文缺少提示词要求覆盖的关键词：${missingKeywords.join('、')}`, suggestion: '请在相关章节自然补齐这些要点，避免堆砌关键词。' });
  const forbiddenPatternHits = (rules.forbiddenPatterns || []).filter(term => term && new RegExp(escapedRegExp(term), 'u').test(markdown));
  if (forbiddenPatternHits.length > 0) issues.push({ level: 'warning', message: `正文出现提示词禁止内容：${forbiddenPatternHits.join('、')}`, suggestion: '请删除或替换为正式交付表述。' });
  const hitTerms = (rules.forbiddenTerms || []).filter(term => term && !/^(?:工程造价|造价|报价|投标报价|综合单价|单价|合价|金额|税率|增值税|利润|预留金|暂列金额)$/u.test(term) && new RegExp(escapedRegExp(term), 'u').test(markdown));
  if (hitTerms.length > 0) issues.push({ level: 'warning', message: `正文残留总控提示词禁止词：${hitTerms.join('、')}`, suggestion: '请改为正式交付语言，删除后台话术、第三人称和口号式表达。' });
  const runtimeRules = rules as PromptDocumentRuleSet & { exactHeadings?: string[]; forbidExtraHeadings?: boolean; requiredSubjects?: string[]; forbiddenSubjects?: string[]; minChars?: number };
  const exactHeadings = runtimeRules.exactHeadings || [];
  if (exactHeadings.length > 0) {
    const actualHeadings = [...markdown.matchAll(/^##\s+(.+)$/gmu)].map(match => displayChapterTitle(match[1] || '')).filter(title => !(title === '目录' && rules.tocPolicy === 'required'));
    const normalizedExactHeadings = exactHeadings.map(displayChapterTitle);
    const missingHeadings = exactHeadings.filter(title => !actualHeadings.includes(displayChapterTitle(title)));
    const extraHeadings = runtimeRules.forbidExtraHeadings ? actualHeadings.filter(title => !normalizedExactHeadings.includes(displayChapterTitle(title))) : [];
    if (missingHeadings.length > 0) issues.push({ level: 'error', message: `正文缺少提示词指定一级章节：${missingHeadings.join('、')}`, suggestion: '请严格按用户提示词 OUTLINE 输出一级章节。' });
    if (extraHeadings.length > 0) issues.push({ level: 'warning', message: `正文出现提示词未允许的一级章节：${extraHeadings.join('、')}`, suggestion: '请检查是否为正文内部层级误升；如不影响指定 OUTLINE 完整性，可在后续排版中并入所属章节。' });
  }
  const subjectHits = (runtimeRules.forbiddenSubjects || []).filter(term => term && new RegExp(escapedRegExp(term), 'u').test(markdown));
  if (subjectHits.length > 0) issues.push({ level: 'warning', message: `正文残留禁用主体表达：${subjectHits.join('、')}`, suggestion: '请统一改为用户提示词指定的表达主体。' });
  const plainLength = markdown.replace(/\s/gu, '').length;
  if (runtimeRules.minChars && plainLength < runtimeRules.minChars) issues.push({ level: 'warning', message: `正文长度低于提示词要求：当前 ${plainLength} 字，要求不少于 ${runtimeRules.minChars} 字`, suggestion: '请按章节深度扩写，但不得编造资料外事实。' });
  return issues;
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
    if (chapter.tableSections?.length && !hasMarkdownTable(body)) issues.push({ level: 'error', message: `${chapter.title} 缺少必要的正式表格`, suggestion: '请按模板 tableSections/tableRequirements 在对应小节补充正式 Markdown 表格。' });
  }
  return issues;
}

function promoteSameTitleWrapperSections(markdown: string) {
  const chapterMatches = [...markdown.matchAll(/^##\s+(.+)$/gmu)].filter(match => /^第[一二三四五六七八九十百千万\d]+章\s+/u.test(match[1] || ''));
  if (chapterMatches.length === 0) return markdown;
  let result = markdown.slice(0, chapterMatches[0].index || 0);
  for (let chapterIndex = 0; chapterIndex < chapterMatches.length; chapterIndex += 1) {
    const chapterStart = chapterMatches[chapterIndex].index || 0;
    const chapterEnd = chapterMatches[chapterIndex + 1]?.index ?? markdown.length;
    const block = markdown.slice(chapterStart, chapterEnd);
    const sectionMatches = [...block.matchAll(/^###\s+(\d+)\.(\d+)\s+(.+)$/gmu)];
    if (sectionMatches.length !== 1) {
      result += block;
      continue;
    }
    const sectionMatch = sectionMatches[0];
    const chapterTitle = displayChapterTitle((chapterMatches[chapterIndex][1] || '').replace(/^第[一二三四五六七八九十百千万\d]+章\s*/u, ''));
    const sectionTitle = displayChapterTitle(sectionMatch[3] || '');
    const wrapperStart = sectionMatch.index || 0;
    const tertiaryMatches = [...block.slice(wrapperStart).matchAll(/^####\s+\d+\.\d+\.\d+\s+(.+)$/gmu)];
    if (tertiaryMatches.length < 2 || !sameStructuralTitle(sectionTitle, chapterTitle)) {
      result += block;
      continue;
    }
    const prefix = block.slice(0, wrapperStart).trimEnd();
    const wrapper = block.slice(wrapperStart);
    const firstTertiary = wrapper.search(/^####\s+/mu);
    const intro = firstTertiary > 0 ? wrapper.slice(sectionMatch[0].length, firstTertiary).trim() : '';
    const rebuiltSections = tertiaryMatches.map((match, index) => {
      const start = match.index || 0;
      const end = tertiaryMatches[index + 1]?.index ?? wrapper.length;
      const title = displayChapterTitle(match[1] || '');
      const body = wrapper.slice(start + match[0].length, end).trim();
      const heading = `### ${chapterIndex + 1}.${index + 1} ${title}`;
      return `${heading}\n\n${index === 0 && intro ? `${intro}\n\n` : ''}${body}`.trim();
    }).join('\n\n');
    result += `${prefix}\n\n${rebuiltSections}\n\n`;
  }
  return result.replace(/\n{3,}/gu, '\n\n').trim();
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

export function finalizeDocumentMarkdown<T extends Pick<DocumentDraftChapter, 'title' | 'sections'>>(markdown: string, chapters: T[], options: { forbidDrawingImages?: boolean; promptRules?: PromptDocumentRuleSet } = {}) {
  const cleanedMarkdown = applyPromptDocumentRules(removeUnwantedDrawingImages(markdown, Boolean(options.forbidDrawingImages)), options.promptRules);
  const policyMarkdown = options.promptRules
    ? options.promptRules.coverPolicy === 'required'
      ? options.promptRules.tocPolicy === 'required'
        ? cleanedMarkdown
        : removeTocBlock(cleanedMarkdown)
      : options.promptRules.tocPolicy === 'required'
        ? removeCoverBlock(cleanedMarkdown)
        : removeCoverBlock(removeTocBlock(cleanedMarkdown))
    : cleanedMarkdown;
  const normalizedMarkdown = sortChapterSectionsByNumber(promoteSameTitleWrapperSections(normalizeTertiaryHeadings(sanitizeFormalMarkdown(policyMarkdown))));
  const inferredSections = inferChapterSectionsFromMarkdown(normalizedMarkdown, chapters);
  const finalizedChapters = chapters.map((chapter, index) => ({
    ...chapter,
    sections: inferredSections[index]?.length ? inferredSections[index] : chapter.sections || [],
  }));
  const tocAppliedMarkdown = options.promptRules?.tocPolicy === 'required' ? ensureFormalToc(normalizedMarkdown, finalizedChapters) : normalizeFormalChapterHeadings(normalizedMarkdown, finalizedChapters);
  const finalizedMarkdown = applyPromptDocumentRules(sortChapterSectionsByNumber(normalizeTertiaryHeadings(sanitizeFormalMarkdown(tocAppliedMarkdown))), options.promptRules);
  return { markdown: finalizedMarkdown, chapters: finalizedChapters };
}

export function composeDocumentMarkdown(draft: Omit<GeneratedDocumentDraft, 'markdown'>, options: { forbidDrawingImages?: boolean; promptRules?: PromptDocumentRuleSet } = {}): string {
  const cleanChapters = draft.chapters.map(chapter => ({ ...chapter, sections: cleanTocSections(chapter.sections || []) }));
  const normalizedChapterBlocks = cleanChapters.map((chapter, index) => normalizeChapterDraftContent(chapter, index));
  const chapterMarkdown = normalizedChapterBlocks
    .filter(Boolean)
    .join('\n\n');
  const tocChapters = cleanChapters.map((chapter, index) => {
    if (chapter.sections?.length) return chapter;
    const normalizedBlock = normalizeFormalChapterHeadings(normalizedChapterBlocks[index] || '', [chapter]);
    const sections = extractGeneratedSections(normalizedBlock).slice(0, 8);
    return sections.length ? { ...chapter, sections: cleanTocSections(sections) } : chapter;
  });
  const initialMarkdown = [
    `<div class="document-cover">`,
    `# ${draft.title}`,
    '',
    `</div>`,
    '',
    '<div class="page-break"></div>',
    '',
    composeTocMarkdown(tocChapters),
    '',
    '<div class="page-break"></div>',
    '',
    chapterMarkdown,
  ].join('\n');

  return finalizeDocumentMarkdown(initialMarkdown, cleanChapters, options).markdown;
}
