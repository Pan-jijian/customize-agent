import type { DocumentDraftChapter, DocumentTemplate, GeneratedDocumentDraft, PromptDocumentRuleSet, ValidationIssue } from './types';
import { CAD_ENTITY_TOKEN_RE, FILE_NAME_RE } from './constants';
import { WORK_PACKAGE_SECTION_RE } from './utils';
import { displayChapterTitle, formalChapterTitle, isTenderClauseFragmentTitle, normalizeGeneratedChapterTitle } from './outline';
import { composeEnhancedCoverMarkdown } from './composeAppendices';
import { FORBIDDEN_PROMPT_PHRASES } from './tenderBidScoring';
import { buildSemanticGate } from './semanticGate';

export function removeUnwantedDrawingImages(markdown: string, forbid: boolean) {
  if (!forbid) return markdown;
  return markdown.replace(/^!\[[^\]]*(?:图纸|drawing|cad|地图|平面|剖面|立面)[^\]]*\]\([^)]*\)\s*$/gimu, '').replace(/\n{3,}/gu, '\n\n');
}

export const WORKFLOW_PHRASE_RE = /^.*(?:知识库证据|知识库已确认事实|资料类型|提示词角色|后台自动规范|规范包|事实字段|资料未提供|未检索到|待确认事项|证据来源|来源清单|校验结果|修复任务包|修复类型|修复对象|输出要求|当前项目绑定资料|已召回证据|证据边界|可审查草稿|Reviewer|Repairer).*$(?:\s)?|^.*本节围绕.+确保各项措施与本工程实施条件相匹配。?\s*$(?:\s)?|^.*建立施工准备、过程控制、检查验收和资料归档要求.*$(?:\s)?|^.*形成责任明确、过程可控、资料完整的管理闭环。?\s*$(?:\s)?|^.*确保现场管理要求与施工进度、资源组织和验收节点同步推进。?\s*$(?:\s)?|^\s*(?:管理闭环|责任明确、过程可控、资料完整|与本工程实施条件相匹配)[。；;]?\s*$(?:\s)?/gmu;
const RAW_SOURCE_LINE_RE = /^\s*(?:#{1,6}\s*)?(?:PDF\s*第\s*\d+\s*页|rule\b|文件[:：]|片段[:：]|来源[:：]).*$/gimu;
const ASCII_FLOW_LINE_RE = /^\s*(?:[│┃┆┊┌┐└┘├┤┬┴┼─━╭╮╰╯]|[↓↑→←⇒⇨➡])+\s*$/gmu;
const INSTRUCTION_HEADING_RE = /^#{2,6}\s+(?:\d+(?:\.\d+)*\s*)?(?:[-—–]\s*)?(?:判断|判定|识别|确认)?是否(?:涉及|涉|需要|适用)|^#{2,6}\s+(?:\d+(?:\.\d+)*\s*)?(?:[-—–]\s*)?(?:如|若|如果)(?:涉及|不涉及|适用|不适用)|^#{2,6}\s+.*(?:根据|结合).{0,12}(?:实际情况|项目情况|资料情况).{0,8}(?:判断|确定|编写|生成)|^#{2,6}\s+.*(?:按需(?:生成|编写)|视情况|判断后|生成要求|编写要求|说明要求|注意事项)\s*$/gmu;
const INSTRUCTION_TITLE_RE = /^(?:\d+(?:\.\d+)*\s*)?(?:[-—–]\s*)?(?:(?:判断|判定|识别|确认)?是否(?:涉及|涉|需要|适用).*|(?:如|若|如果)(?:涉及|不涉及|适用|不适用).*|.*(?:根据|结合).{0,12}(?:实际情况|项目情况|资料情况).{0,8}(?:判断|确定|编写|生成).*|.*(?:按需(?:生成|编写)|视情况|判断后|生成要求|编写要求|说明要求|注意事项))\s*$/u;
// 阶段五语义升级：指令型标题弱词根召回（INSTRUCTION_HEADING_RE 强句式保留确定性），
// 词根命中标题由语义 gate 复核确认"指令/说明类"语义才报问题（防误杀正常小节标题）
const INSTRUCTION_WEAK_HINT_RE = /注意事项|如何|怎么写|按需|视情况|是否/u;
const INSTRUCTION_HEADING_SEMANTIC_PROTOTYPES = [
  '如何编写施工方案的写作说明标题',
  '根据项目情况判断的注意事项标题',
  '按需生成的编写要求与说明标题',
] as const;
const INSTRUCTION_HEADING_LEGAL_PROTOTYPES = [
  '危大工程专项施工方案与安全措施',
  '质量验收标准与检测要求',
  '成品保护与移交管理措施',
] as const;

async function buildInstructionHeadingGate(embedDocuments?: (texts: string[]) => Promise<number[][]>) {
  return buildSemanticGate({
    prototypes: [...INSTRUCTION_HEADING_SEMANTIC_PROTOTYPES],
    negativePrototypes: [...INSTRUCTION_HEADING_LEGAL_PROTOTYPES],
    embedDocuments,
  });
}

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
  return INSTRUCTION_TITLE_RE.test(rawTitle) || INSTRUCTION_TITLE_RE.test(displayTitle)
    // 招标条款碎片过滤与显式 OUTLINE 提取共用同一判别器（历史缺陷：写手正文 H3 提取环节漏接该过滤，
    // 导致「3项规定」「56m15：…」等条款碎片进入小节目录）
    || isTenderClauseFragmentTitle(rawTitle) || isTenderClauseFragmentTitle(displayTitle);
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
    .replace(/(\d+(?:\.\d+)?)平方(?:\d+(?:\.\d+)?)?(?=\d|[，,;；)）]|\s|$)/gu, '$1平方米')
    .replace(/原则上/gu, '')
    .replace(/\s*×\s*/gu, '×')
    .replace(/\s*≤\s*/gu, '≤')
    .replace(/\s*≥\s*/gu, '≥')
    .replace(/\s*±\s*/gu, '±');
}

export function normalizeTenderSourcePageRefs(markdown: string) {
  return markdown
    // 完整页码引用（含“第 5-8 页”范围形态）整体归一为“相关资料”，与 cleanInlineFactValue 同构：
    // 不带范围支持时范围形态会落入下方 L60 兜底只转「第 N-M 页」留下孤立的「PDF 」前缀
    .replace(/PDF\s*第\s*\d+(?:\s*[-—至到~～]\s*\d+)?\s*页/giu, '相关资料')
    // 残缺页码引用（“PDF 第”后无数字，LLM 从招标文件封面复制页码引用时截断的残片）：
    // 直接删除残片本身，保留其前文本（如“日期：2026年8月19 日”），避免污染表格单元格；
    // lookahead 允许空格/tab 后跟数字（“PDF 第 3 页”完整引用由上一替换归一），与
    // cleanInlineFactValue 同口径，不跨行（\n 后数字的跨行残片仍删除）
    .replace(/PDF\s*第(?![ \t]*[0-9０-９])/giu, '')
    .replace(/第\s*\d+\s*页\s*(?:\/|共)\s*\d+\s*页/gu, '')
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

const CR_CHAR = String.fromCharCode(13);
const LF_CHAR = String.fromCharCode(10);
const NEWLINE_SPLIT_RE = new RegExp(`${CR_CHAR}?${LF_CHAR}`, 'u');
const NEWLINE_RUN_RE = new RegExp(`${LF_CHAR}{3,}`, 'gu');

export function normalizeInlineListBreaks(markdown: string) {
  return markdown.split(NEWLINE_SPLIT_RE).map(normalizeInlineListsInLine).join(LF_CHAR).replace(NEWLINE_RUN_RE, LF_CHAR + LF_CHAR);
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

function removeEmptyMarkdownTableColumns(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isMarkdownTableRow(lines[index]) || !isMarkdownTableDivider(lines[index + 1] || '')) {
      output.push(lines[index]);
      continue;
    }
    const table: string[] = [];
    while (index < lines.length && isMarkdownTableRow(lines[index])) {
      table.push(lines[index]);
      index += 1;
    }
    index -= 1;
    const rows = table.map(line => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => cell.trim()));
    const width = Math.max(...rows.map(row => row.length));
    const keep = Array.from({ length: width }, (_, col) => rows.some((row, rowIndex) => rowIndex !== 1 && Boolean(row[col]?.trim())));
    const normalizedRows = rows.map((row, rowIndex) => {
      const cells = keep.map((enabled, col) => enabled ? (row[col] || '') : null).filter((cell): cell is string => cell !== null);
      return rowIndex === 1 ? dividerForColumns(cells.length) : `| ${cells.join(' | ')} |`;
    });
    output.push(...normalizedRows);
  }
  return output.join('\n');
}

function looksLikeTableHeader(line: string) {
  const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => cell.replace(/\*\*/gu, '').trim());
  if (cells.length < 2) return false;
  const headerCells = cells.filter(cell => /^(?:序号|信息项|内容|控制项目|控制内容|执行要求|责任主体|检查(?:与验收)?|验收标准|备注|名称|规格(?:型号)?|单位|数量|阶段|措施|风险|应急物资名称|资源类别|投入计划|管理要求)$/u.test(cell));
  return headerCells.length >= Math.min(2, cells.length);
}

function startsTableRow(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.length > 1;
}

export function normalizeMarkdownTableDividers(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  const output: string[] = [];
  let activeColumns = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isMarkdownTableDivider(line)) {
      output.push(line);
      continue;
    }
    // 表格数据行可能因模型输出截断而缺少行尾“|”，处于活跃表格内时应一并纳入规范化，补齐为表头列数。
    const isRow = isMarkdownTableRow(line) || (activeColumns > 0 && startsTableRow(line));
    if (!isRow) {
      activeColumns = 0;
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

export const SOURCE_ENUMERATION_PHRASE_RE = /(?:项目部|本项目|本工程)?(?:根据|依据|结合|按照|以)?(?:本项目|项目|[^。；;\n]{0,30}?)?(?:招标文件|补疑澄清文件|补遗澄清文件|补疑补遗|答疑(?:回复)?文件|答疑修正口径|补充答疑修正口径|澄清文件|工程量清单|设计图纸|施工图纸|图纸资料|设计修改通知单)(?:[、,，及和与\s]*(?:招标文件|补疑澄清文件|补遗澄清文件|补疑补遗|答疑(?:回复)?文件|答疑修正口径|补充答疑修正口径|澄清文件|工程量清单|设计图纸|施工图纸|图纸资料|设计修改通知单|现行规范|规范)){1,}(?:[^。；;\n]{0,80})?[，,]/u;

const BASIS_SECTION_TITLE_RE = /编制依据|编制说明|法律法规|规范标准|标准依据/u;

export function cleanFormalSourcePhrases(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  const output: string[] = [];
  let inBasisSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{2,4}\s+/u.test(trimmed)) {
      inBasisSection = BASIS_SECTION_TITLE_RE.test(trimmed.replace(/^#{2,4}\s+/u, ''));
      output.push(line);
      continue;
    }
    if (/^\s*\|/u.test(trimmed) || inBasisSection) {
      // 编制依据类小节（编制依据/编制说明/法律法规/规范标准等）允许集中罗列依据文件，不执行来源罗列清洗
      output.push(line.trimEnd());
      continue;
    }
    const cleaned = line
      .replace(SOURCE_ENUMERATION_PHRASE_RE, '')
      .replace(/(?:施工图设计说明|工程量清单项目特征|补充答疑修正口径|答疑修正口径)(?:[、,，及和与\s]*(?:施工图设计说明|工程量清单项目特征|补充答疑修正口径|答疑修正口径)){1,}/gu, '项目技术文件')
      .replace(/(?:根据|依据|以)(?:[^。；;\n]{0,30})?(?:招标文件|补疑澄清文件|补遗澄清文件|补疑补遗|答疑(?:回复)?文件|答疑修正口径|补充答疑修正口径|澄清文件|工程量清单|设计图纸|施工图纸)(?:[^。；;\n]{0,40})(?:编制|确定|要求|为编制基础)[。；;]?/gu, '')
      .replace(/(?<=\S)\s{2,}(?=\S)/gu, ' ')
      .trimEnd();
    if (!/^(?:本节|本小节|本章)?(?:内容|措施)?(?:根据|依据)(?:招标文件|补疑澄清文件|补遗澄清文件|答疑(?:回复)?文件|澄清文件|工程量清单|设计图纸|施工图纸)[^。；;\n]*[。；;]?$/u.test(cleaned.trim())) {
      output.push(cleaned);
    }
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n');
}

export function sourcePhraseIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let inBasisSection = false;
  markdown.split(/\r?\n/u).forEach((line, index) => {
    const trimmed = line.trim();
    if (/^#{2,4}\s+/u.test(trimmed)) {
      inBasisSection = BASIS_SECTION_TITLE_RE.test(trimmed.replace(/^#{2,4}\s+/u, ''));
      return;
    }
    if (/^\s*\|/u.test(trimmed)) return;
    if (SOURCE_ENUMERATION_PHRASE_RE.test(line) && !inBasisSection) issues.push({ level: 'error', severity: 'blocker', category: 'style', owner: 'system', message: `正式正文不得出现资料来源罗列话术：第 ${index + 1} 行`, suggestion: '删除“根据/依据招标文件、清单、图纸”等来源罗列，直接保留项目事实、施工内容和控制措施；编制依据类小节可集中罗列依据文件。' });
    if (/^\s*\*\*[^*]{2,40}表\*\*\s*$/u.test(line)) issues.push({ level: 'error', severity: 'blocker', category: 'format', owner: 'system', message: `正式正文不得用粗体段落充当表名：第 ${index + 1} 行`, suggestion: '表名必须转换为 #### 四级标题，避免导出后混入正文段落。' });
  });
  return issues.slice(0, 20);
}

/** H4 滑窗重复检测豁免词：高频施组结构词（「安全文明施工与安全管理」「质量保证体系与质量管理体系」
 * 等合理标题中重复出现属正常搭配），豁免后避免误伤；非豁免词重复才判定疑似粘连。 */
const H4_COMMON_SECTION_WORDS_RE = /(?:安全|管理|施工|质量|工期|进度|保障|体系|措施|控制|工程|项目|技术|方案|计划|组织|标准|规范|验收|方法|工艺|文明|绿色)/u;

/** 专业工程方案标准命名（「土方开挖与基坑支护工程施工方案」「给排水及消防水系统安装工程施工方案」）：
 * 主体为单一专业工程名（可含「与/及」并列组合），「施工方案」为固定后缀，不属于多主题拼接 */
const PROFESSIONAL_PLAN_TITLE_RE = /(?:工程施工方案|安装工程施工方案|专业工程施工方案|专项施工方案)$/u;

/** H4 小节标题治理：成稿层自由生成的 H4 可能词尾粘连（「现场踏勘施工条件现场条件」）、
 * 多主题拼接（超过 14 字）或与本章三级小节同名（重复结构）。这里只做确定性标记，
 * 标题改写归语义模型——由 Reviewer 按 suggestion 反馈重写，不在清洗层硬改。 */
export function sectionHeadingIssues(markdown: string): ValidationIssue[] {
  const lines = markdown.split(/\r?\n/u);
  const issues: ValidationIssue[] = [];
  const tertiaryTitles = new Set<string>();
  for (const line of lines) {
    const match = /^###\s+(.+)$/u.exec(line.trim());
    if (match) tertiaryTitles.add(match[1].trim().replace(/^\d+(?:\.\d+)*\s*/u, ''));
  }
  lines.forEach((line, index) => {
    const match = /^####\s+(.+)$/u.exec(line.trim());
    if (!match) return;
    const title = match[1].trim();
    const plain = title.replace(/^\d+(?:\.\d+)*\s*/u, '').trim();
    if (!plain) return;
    if (tertiaryTitles.has(plain) || tertiaryTitles.has(title)) {
      issues.push({
        level: 'warning', severity: 'warning', category: 'structure', owner: 'system', repairability: 'llm_repairable',
        message: `H4 标题与本章三级小节同名：${title}（第 ${index + 1} 行）`,
        suggestion: `删除该 H4 块或改为三级小节「${plain}」下的独立子主题标题，禁止与三级小节同名造成结构重复。`,
      });
      return;
    }
    // 非豁免 2 字滑窗重复：标题内部同一词出现两次以上 → 疑似词尾粘连/多主题拼接
    const counts = new Map<string, number>();
    for (let cursor = 0; cursor < plain.length - 1; cursor += 1) {
      const pair = plain.slice(cursor, cursor + 2);
      if (H4_COMMON_SECTION_WORDS_RE.test(pair)) continue;
      counts.set(pair, (counts.get(pair) || 0) + 1);
    }
    const dups = [...counts.entries()].filter(([, count]) => count >= 2).map(([word]) => word);
    if (dups.length > 0) {
      issues.push({
        level: 'warning', severity: 'warning', category: 'structure', owner: 'system', repairability: 'llm_repairable',
        message: `H4 标题疑似词尾粘连或多主题拼接：${title}（重复词：${dups.join('、')}，第 ${index + 1} 行）`,
        suggestion: '重写为单一主题的短标题，去掉粘连重复的尾部词语。',
      });
      return;
    }
    if (plain.length > 14 && !PROFESSIONAL_PLAN_TITLE_RE.test(plain)) {
      issues.push({
        level: 'warning', severity: 'warning', category: 'structure', owner: 'system', repairability: 'llm_repairable',
        message: `H4 标题过长疑似多主题拼接：${title}（${plain.length} 字，第 ${index + 1} 行）`,
        suggestion: '拆分为多个独立 H4 或压缩为单一主题短标题。',
      });
    }
  });
  return issues.slice(0, 20);
}

/** 句级指纹归一：去空白与标点，保留汉字/字母/数字，用于跨节重复判定（确定性判定，内容改写归 Reviewer）。 */
function sentenceFingerprint(sentence: string) {
  return sentence.replace(/[\s\p{P}]+/gu, '').toLowerCase();
}

const DEDUPE_MIN_SENTENCE_CHARS = 24;
const DEDUPE_REPEAT_RATIO = 0.3;

/** 跨小节重复检测：同一章内 ### 节（含其 #### 子节正文）两两比对，
 * 24 字以上句子去标点后重合；重合句占比超过 30% 判定重复，
 * 生成 llm_repairable 标记交由 Repairer 差异化重写（不代码删文）。 */
export function sectionDuplicateIssues(markdown: string): ValidationIssue[] {
  const lines = markdown.split(/\r?\n/u);
  const issues: ValidationIssue[] = [];
  const chapters: Array<{ title: string; sections: Array<{ title: string; sentences: string[] }> }> = [];
  let chapter: { title: string; sections: Array<{ title: string; sentences: string[] }> } | null = null;
  let section: { title: string; sentences: string[] } | null = null;
  const pushSentence = (line: string) => {
    if (!section) return;
    const cleaned = line.replace(/^#{1,6}\s+/u, '').replace(/^\|.*\|$/u, '').trim();
    for (const sentence of cleaned.split(/[。；;]/u)) {
      const trimmed = sentence.trim();
      if (trimmed.length >= DEDUPE_MIN_SENTENCE_CHARS) section.sentences.push(sentenceFingerprint(trimmed));
    }
  };
  for (const line of lines) {
    const h2 = /^##\s+(.+)$/u.exec(line.trim());
    if (h2) {
      if (chapter) chapters.push(chapter);
      chapter = { title: h2[1].trim(), sections: [] };
      section = null;
      continue;
    }
    const h3 = /^###\s+(.+)$/u.exec(line.trim());
    if (h3 && chapter) {
      section = { title: h3[1].trim(), sentences: [] };
      chapter.sections.push(section);
      continue;
    }
    if (/^####\s+/u.test(line.trim())) continue;
    pushSentence(line);
  }
  if (chapter) chapters.push(chapter);
  for (const item of chapters) {
    for (let i = 0; i < item.sections.length; i += 1) {
      for (let j = i + 1; j < item.sections.length; j += 1) {
        const left = new Set(item.sections[i].sentences);
        const right = new Set(item.sections[j].sentences);
        if (left.size === 0 || right.size === 0) continue;
        let overlap = 0;
        for (const sentence of left) if (right.has(sentence)) overlap += 1;
        const ratio = overlap / Math.min(left.size, right.size);
        if (ratio >= DEDUPE_REPEAT_RATIO && overlap >= 3) {
          issues.push({
            level: 'warning', severity: 'warning', category: 'structure', owner: 'system', repairability: 'llm_repairable',
            message: `${item.title} 内「${item.sections[i].title}」与「${item.sections[j].title}」正文重复（${overlap} 句重合，占 ${Math.round(ratio * 100)}%）`,
            suggestion: '两个小节正文出现大量重复句子：后写的小节必须围绕本小节主题差异化重写，删除复制自另一小节的内容，只保留本小节专属做法与参数。',
          });
        }
      }
    }
  }
  return issues.slice(0, 20);
}

/** 表格单元格换行断行合并：LLM 在表格单元格内输出长文本时会在单元格内换行，
 * 续行不以 | 开头，渲染引擎按独立行处理导致前列显示为空单元格（危大工程表“专项方案审批”列现场）。
 * 仅合并“含 ≥2 个竖线的断行”（首段为上一行末单元格续文、其余段为本行后续列，分号连接）；
 * 单竖线残行（整列丢失）不在本层合并，由 exportGate 表格列数检测报告修复。 */
export function mergeTableLineBreaks(markdown: string) {
  const lines = markdown.split(NEWLINE_SPLIT_RE);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || '';
    const trimmed = line.trim();
    const isBrokenRow = Boolean(trimmed)
      && !/^\|/u.test(trimmed)
      && (trimmed.match(/\|/gu) || []).length >= 2
      && !/^#{1,6}\s/u.test(trimmed)
      && !isMarkdownTableDivider(trimmed)
      && output.length > 0
      && isMarkdownTableRow(output[output.length - 1] || '');
    if (!isBrokenRow) {
      output.push(line);
      continue;
    }
    const parts = trimmed.split('|').map(cell => cell.trim()).filter(Boolean);
    if (parts.length < 2) {
      output.push(line);
      continue;
    }
    const prevRow = output[output.length - 1] || '';
    if (isMarkdownTableDivider(prevRow)) {
      // 断行紧跟分隔行（首行数据即单元格内换行/数据行首尾竖线丢失）：合并进分隔行会
      // 把分隔行改成畸形数据行，整表渲染报废且检测误报“分隔线位置不规范”；
      // 转为以 | 开头的表格行保留全部内容，列数失配由表格列数检测报出进专项修复轮
      output.push(`| ${parts.join(' | ')} |`);
      continue;
    }
    const prev = output[output.length - 1] || '';
    const mergedCell = `${prev.replace(/\s*\|\s*$/u, '')}${parts[0]}`;
    const extra = parts.slice(1).join('；');
    output[output.length - 1] = `${mergedCell}${extra ? `；${extra}` : ''} |`;
  }
  return output.join(LF_CHAR);
}

export function sanitizeFormalMarkdown(markdown: string) {
  const cleaned = removeEmptyMarkdownTableColumns(normalizeMarkdownTableDividers(mergeTableLineBreaks(normalizeInlineListBreaks(normalizeTenderSourcePageRefs(normalizeProductionText(cleanFormalSourcePhrases(stripMarkdownDocumentFence(markdown))))))))
    // H4 词尾严格重复：LLM 把两个候选标题粘连输出（如「现场条件现场条件」「要点要点」），
    // 尾部等长两段完全相同属确定性冗余，直接去重；语义级粘连（如「现场踏勘施工条件现场条件」）
    // 不做词面硬改，由 sectionHeadingIssues 标记后交 Reviewer 重写
    .replace(/^####\s+(.*?)(.{2,4})\2\s*$/gmu, '#### $1$2')
    .split(/\r?\n/u)
    .map(line => {
      // 注意：不再把表格单元格里的“不适用”清洗成空格——该清洗会把单元格洗成空字符串，
      // 制造“空单元格”硬阻断缺陷（十度实测：合计行“不适用”被洗成空格后检测器报错且修复轮无法兜底）；
      // “不适用”本身不触发占位符检测，治理由提示词禁写清单（MARKDOWN_TABLE_FORMAT_RULES）承担。
      // 行内伪标题拆行：LLM 成稿把“###/#### 标题”写成“句号+###标题”行内嵌入形态（徽光阁缺陷：
      // “复查记录留存影像资料.### 危大工程专项施工方案审批流程”），行首标题扫描（extractSectionFuzzy）不识别
      // → 小节不成节、深度检测落空、Final Gate 误判小节缺失。拆为独立标题行（前置空行保证渲染成标题）。
      // 仅句末标点（。；;）紧贴的形态拆行，“详见### 1.2”式句中引用不拆（标题前不是句末标点）。
      line = line.replace(/(?<=[。；;])(?=#{3,4}\s+\S)/gu, '\n\n');
      // 表格前导句拆行：LLM 成稿把表头行粘在前导句后（合肥师范缺陷：“具体安排如下表。| 关键节点 | 计划完成时间 | …”），
      // 同行的表头被表格解析器当作表头首列 → “表格列数不一致”误报且修复轮永不收敛；表格也无法正常渲染。
      // 仅拆“行首无管道 + 句末标点 + 以 | 开头的完整表格行收尾”的形态（$1 不含 | 保证不误拆表格数据行内句号）。
      line = line.replace(/^([^|]*[。；;])\s*(\|[^|\n]+\|\s*)$/u, '$1\n$2');
      return line;
    })
    .join('\n')
    .replace(/^\*\*([^*\n]{4,40})\*\*\s*$/gmu, (line: string, title: string) => {
      const clean = title.trim();
      // 整行加粗且带句末标点/冒号或为提示语的不属于小节标题，保留原文；其余按“禁止用粗体代替标题”规范转为 #### 标题
      if (/[:：。！!？?，,、]$/u.test(clean) || /^(?:注意|提示|备注|警告|说明)/u.test(clean)) return line;
      return `#### ${clean}`;
    })
    .replace(/承包人案/gu, '方案')
    .replace(/承包人法(?=[:：])/gu, '施工方法')
    .replace(/承包人法/gu, '方法')
    .replace(WORKFLOW_PHRASE_RE, '')
    .replace(/(^|\n)---\s*\n+(?=以上内容已依据)/gu, '$1')
    .replace(/^以上内容已依据[\s\S]*?(?=\n\s*\n)/gmu, '')
    .replace(RAW_SOURCE_LINE_RE, '')
    .replace(ASCII_FLOW_LINE_RE, '')
    .replace(INSTRUCTION_HEADING_RE, '')
    .replace(FILE_NAME_RE, '')
    .replace(/^#\s+/gmu, '')
    .replace(CAD_ENTITY_TOKEN_RE, '');
  // 内部术语不在此做正则替换：术语合法性属语义判断（如“工作包”按语境应改写为“拆除工程/专业工程”等），
  // 词面替换必然产生语义错误；治理链为 提示词禁写 → Reviewer 确定性标记（FORMAL_FORBIDDEN_PHRASES）
  // → Repairer 按上下文语义改写 → Final Gate 保险丝（internalTerminologyIssues 词面标记兜底）
  return cleaned.split(/\r?\n/u)
    .filter((line, index, lines) => {
      const previousPlain = index > 0 ? displayChapterTitle((lines[index - 1] || '').trim().replace(/^#{1,6}\s+/u, '')) : '';
      const currentPlain = displayChapterTitle(line.trim().replace(/^#{1,6}\s+/u, ''));
      if (previousPlain && isInstructionLikeTitle(previousPlain) && currentPlain.length > 0 && currentPlain.length <= 12 && !/^#{1,6}\s/u.test(line.trim())) return false;
      const trimmed = line.trim();
      if (!trimmed) return true;
      // 招标术语 H4 拦截：「补充条款」等招标文件术语不应作为正文小节标题（四级标题是成稿层自由产物，
      // 规划层三级标题的同类治理由章节顺序核验承担）
      if (/^####\s+.*(?:补充条款|评标办法|投标须知)/u.test(trimmed)) return false;
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
  '表格数据完整性硬约束：数据行每一列都必须有具体数据值，不得出现空单元格；不得用“—/若干/约/待定/暂无/不适用”等占位或模糊表达代替具体数据（合计/小计/总计/累计行的“—”不适用语义除外）。数据优先取自本项目资料，资料未直接给出时按工程量、工期与专业定额工效推算具体数值。',
  '表格名称/标题不得占用表格单元格（如“竣工清理与移交计划表”作为表头第一格导致整表错位）；表名写在表格上方的正文叙述中，表内第一行从表头列名开始。',
  '正文表格不得展示后台溯源列或系统过程列，如“资料来源/说明”“资料来源/证明”“知识库来源”等。',
  '项目名称、项目编号、招标人/业主/建设单位、建设地点、建设规模、计划工期、质量标准、合同估算价等项目基础信息，只能在项目基本信息表中集中输出一次；后续章节如需引用，应写入正文或专业表格的业务字段，不得重复生成项目基础信息键值表。',
].join('\n');

/** 招标技术标评审写作方法论（《施组设计汇总方案.md》高频评审逻辑 + 用户“青天大模型 AI 评标”提示词提炼）：
 * 内容落地五要素、负面词库禁写、评分点响应、数据表格化、数据自洽、黄金公式与低雷同 */
export const TENDER_BID_WRITING_RULES = [
  '【内容落地五要素】每项管控措施必须写全五要素：方案 + 流程 + 责任人 + 时间节点 + 验收标准；责任人落到具体岗位（项目经理/技术负责人/施工员/质检员/安全员/材料员等），检查频次量化到每日/每周/每月/不少于X次，整改落到“整改→复查→销项”闭环。禁止只写“加强、落实、确保”式无责任、无标准、无频次的空话。',
  '【闭环句式密度硬约束】全文每 1500 字至少 1 段完整闭环句式：同一自然段内必须同时出现责任岗位（项目经理/技术负责人/施工员/质检员/安全员/材料员/试验员等）+ 检查频次（每日/每周/每月/不少于X次/定期）+ 整改闭环（整改/复查/销项/复验）三要素，缺一不可；禁止措施段落只有频次数字而无责任岗位，或只有岗位口号而无量化频次。',
  `【空话禁用词】以下词语直接禁写，一律替换为“责任岗位 + 执行动作 + 量化标准 + 检查频次 + 整改闭环”句式：${FORBIDDEN_PROMPT_PHRASES.join('、')}；并避免“合理、充分、完善、切实、尽量、适时”等单字虚词作为措施句核心动词。`,
  '【评分点响应】段落首句先回应本节评分点或招标评审关键词，再展开具体措施；一段只写一个主题，避免多个得分点混在大段文字中；三级标题尽量直接放置评分关键词。',
  '【数据表格化】关键数据（建筑面积、层数、总工期、开工竣工节点、设备型号数量、管理人员配置、劳动力人数、材料批次、养护天数、检测频次、检验批划分）优先用表格呈现，不藏在正文大段文字中；正文中数据密集型内容（多组对比数值、多岗位职责分工、多阶段资源配置、多节点工期安排、多类管控指标、多工种劳动力分配）宁可多用表格，直观性优于纯文字叙述。表格前必须有 1～2 句引导叙述说明表格作用与关键结论，表格不能替代小节正文。每张表格应有说明性标题或表前引导句点名用途；同一主题同一数据不得重复堆叠凑数，但内容较多的主题可合理分组为多张表。',
  '【工艺参数密度】正文每 1000 字至少落位 6 处带单位的量化工艺参数（如 20mm、C30、0.5MPa、养护 28 天、搭接长度 500mm、压实度 95%、含水率 3%），均匀分布在各章节而非集中在个别小节；参数必须来自绑定材料或行业通用规范值，不得编造。',
  '【工序顺序表达】施工流程、施工方法、检验验收类叙述必须有清晰的工序顺序表达，形式由模型根据内容自然选择、不做统一要求：可用顺序词叙述（先…再…最后…、依次/先后/按…顺序）、编号步骤、有序/无序列表或箭头链等形式；同一章节内形式应多样化，禁止全篇同一形式（如通篇箭头链）。每个分部分项方案至少 1 处 3 环节以上的工序顺序表达，全文含工序顺序表达的段落占比不低于 8%。',
  '【数据自洽】全文核心数据（工程名称、建设地点、总工期、建筑面积、层数、人员、机械、材料批次、施工阶段划分、危大工程清单）必须前后一致，任何跨章冲突、参数矛盾即为内容缺陷；数据以绑定材料与计划推导结果为准，不得一处一改。',
  '【工艺黄金公式】工艺描述按“工艺名称 + 来源依据 + 适用范围 + 核心工序（按施工顺序 3～5 步）+ 质量控制要点（1～2 个量化指标）”展开；提及规范标准必须带编号（如 GB 50204-2015）并采用现行有效版本，不得虚构或引用已废止版本。',
  '【重难点公式】重难点 = 项目具体条件 + 难度分析 + 影响后果；工程重点 3～5 条、工程难点 3～4 条，每个重难点必须在后续对应章节给出解决措施形成跨章闭环。',
  '【低雷同】不同章节不得复制相同段落；同类措施必须通过句式重构、数据替换、流程细化差异化表达；项目概况叙述（位置＋规模＋建设内容＋工期＋质量目标的连写段）全文只允许在项目基本信息表引导段出现一次，特点分析、重难点分析等小节直接切入特点与对策，禁止再次粘贴项目概况段；不写“本工程严格执行国家有关标准规范”式通用万能句。',
].join('\n');

export const FORMAL_WRITING_RULES = [
  '以下规则仅用于保障导出格式正确和事实安全，不得覆盖用户在提示词中已明确的要求。',
  '不得把”知识库、检索、资料类型、提示词角色、规范包、事实字段、缺失项、校验结果、资料未提供、未检索到”等后台流程话术写入正文。',
  '严禁使用“根据/依据招标文件、补疑澄清文件、工程量清单及设计图纸”等资料来源罗列开头；正文必须直接写项目事实、施工内容、控制措施、验收节点。编制依据类小节除外：该小节可集中罗列编制依据文件清单。',
  '禁止模板化空话与流程套话：不同小节必须写各自专属的专业内容，逐节落位本项目工程量、设备规格、工艺参数与验收标准，不得复制相同段落，不得用泛化的流程描述代替专业内容；正文末尾不得输出自我总结或合规声明段落。',
  '项目概况只交代一次：工程地点、建设规模（总建筑面积）、计划工期、改造范围、保留商铺等总述信息，只在项目概况/工程概况类章节集中交代。其他章节不得以“本项目为……”开头整段复述项目概况；正文直接写本专业内容，确需数据支撑时只引用所需的具体数字（如“按 45 日历天总工期倒排”“针对 4368m² 改造范围”），不复述面积、商铺、工期的完整概况段。',
  TENDER_BID_WRITING_RULES,
  // 导出格式 —— DOCX/PDF 渲染器依赖以下 Markdown 规范
  '【导出格式】章标题用 ## ，节标题用 ### 加数字编号（如 1.1），小节标题用 #### 加数字编号（如 1.1.1）。禁止用数字编号或粗体代替 ###/#### 标题。',
  MARKDOWN_TABLE_FORMAT_RULES,
  // 段落格式 —— 导出渲染需要双换行才是段落
  '【段落格式】段落之间必须空行（双换行）分隔，不得用单换行连续写大段文字。列表项逐行独占。步骤描述之间加空行。',
  '事实来源分级：项目专属事实（工期、金额、工程量、建设规模、人名、公司、品牌、供应商、材料规格、日期节点）必须来自绑定材料，不得编造；公共专业知识（法律法规名称、标准规范编号 GB/JGJ/CJJ/DB 系列、通用施工工艺与行业惯例）可依据现行有效版本和专业经验直接撰写，不要求材料提供，但不得虚构编号或引用已废止版本。',
  '计划编制类字段边界：劳动力计划人数、机械设备台班、进度时间安排、材料进场时间、检验批划分等属于投标人计划编制成果，资料中不会直接给出，必须基于项目工程量、总工期、工序流水与定额工效推导出具体数值并写入正文，不得因资料未提供而留空或用“另行确定”等话术回避。',
].join('\n');

export const SECTION_GENERATION_SAFETY_RULES = [
  '只生成当前节及其节内三级小节正文，不生成其他同级节，不重复章节一级标题。',
  '优先使用当前模板、用户要求、绑定提示词和绑定材料中的事实；项目专属事实（具体数值、时间、规格、人名、品牌、责任主体）缺少依据时不得编造；法律法规名称、标准规范编号等公共专业知识可依据现行有效版本直接引用，无需材料提供。',
  '禁止编造具体日期：开工日期、竣工日期、具体某月某日只有在绑定材料明确提供时才可写入；材料未提供具体日期时，进度安排一律用相对工期表达（如"开工令下发后第7日""第1日～第7日"），不得写"2026年8月8日"等绝对日期。',
  '小节应有实质正文；除非用户或模板明确要求纯表格，否则表格只能作为辅助表达，不能整节只有表格。',
  '不得用通用兜底段落、空泛管理话术或后台缺料说明冒充正文；信息不足时只写已有事实、适用边界和待复核口径。',
  '不得以“本项目为……”开头复述项目概况段（工程地点、面积、工期、保留商铺等总述信息只在项目概况/工程概况类章节出现）；本小节直接写专业内容，需要数据时只引用所需数字。',
].join('\n');

/**
 * 3.2 文档工作流 L0 公共前缀：所有文档生成相关 LLM 调用（Writer/事实大纲/结构规划/评审/修复/
 * 规则抽取/招标提取/大纲校准/模板化复核）共享的第一段 system。内容只放跨任务通用的硬约束
 * （事实安全、后台话术禁令、输出契约），角色身份与任务规则由各调用点紧随其后追加——
 * 跨调用类型共享 prefix cache（DeepSeek 前缀缓存按 system 头部收敛）。
 * 历史缺陷：14+ 种调用类型各用独立 system 开头，跨类型前缀零命中（实测命中率仅 25%）。
 */
export const DOCUMENT_L0_COMMON_PREFIX = [
  '你是专业施工组织设计文档生成智能体，承担文档结构规划、正文写作、质量评审与局部修复任务。',
  '通用硬约束：',
  '1. 项目专属事实（工期、金额、工程量、建设规模、人名、公司、品牌、供应商、材料规格、日期节点）必须来自绑定材料，不得编造；公共专业知识（法律法规名称、标准规范编号、通用施工工艺与行业惯例）可依据现行有效版本直接引用，但不得虚构编号或引用已废止版本。',
  '2. 输出中不得出现后台流程话术（知识库、检索、资料类型、提示词角色、规范包、事实字段、缺失项、校验结果、资料未提供、未检索到等）。',
  '3. 严格遵守调用点给出的输出契约：JSON 调用只返回 JSON，正文调用遵循 Markdown 结构要求。',
].join('\n');

/**
 * 3.2 Writer 类 system 恒定前缀：公共前缀 + 写作专家身份 + 正式写作规则 + 小节安全规则，
 * 整章/小节/focused/补写四类 Writer 的 system 统一以此为前缀，任务差异段紧随其后——
 * 跨调用类型共享 prefix cache（DeepSeek 前缀缓存按 system 头部收敛）。
 * 任务差异段只描述输出形态，不重复恒定写作规则。
 */
export const L0_WRITER_SYSTEM_PREFIX = [
  DOCUMENT_L0_COMMON_PREFIX,
  '你是施工组织设计文档写作专家。',
  FORMAL_WRITING_RULES,
  SECTION_GENERATION_SAFETY_RULES,
].join('\n\n');

/**
 * 3.1 system 前缀统一：全部任务类型共用同一 L0 开头（L0 公共前缀 + FORMAL_WRITING_RULES 完整文本，
 * ≥2000 字符），角色差异句后移到 system 尾部固定位置——DeepSeek prefix cache 从 messages[0] 起
 * 逐字节匹配，公共段从 ~300 字符扩到 3000+ 字符，跨任务类型（Writer/规划/评审/修复/提取/校准）
 * 前缀命中显著上升。FORMAL_WRITING_RULES 首行自带「不得覆盖用户在提示词中已明确的要求」自限声明，
 * 对 JSON 提取/评审类调用无副作用（输出契约仍由 L0 第 3 条与调用点 prompt 约束）。
 * DOCUMENT_UNIFIED_SYSTEM_PREFIX=0 回退为仅 L0 公共前缀（3.2 旧结构）。
 */
function unifiedSystemHead(): string {
  return process.env.DOCUMENT_UNIFIED_SYSTEM_PREFIX === '0'
    ? DOCUMENT_L0_COMMON_PREFIX
    : [DOCUMENT_L0_COMMON_PREFIX, FORMAL_WRITING_RULES].join('\n\n');
}

/** 3.2 回退开关：DOCUMENT_L0_SYSTEM_PREFIX=0 时返回各调用点传入的 legacy 前缀（恢复原有 system 分布） */
export function writerSystemPrefix(legacyPrefix: string): string {
  if (process.env.DOCUMENT_L0_SYSTEM_PREFIX === '0') return legacyPrefix;
  // 3.1：统一公共段（L0 + FORMAL 完整规则）前置为开头，writer 身份句后移到规则之后固定位置
  return [unifiedSystemHead(), '你是施工组织设计文档写作专家。', SECTION_GENERATION_SAFETY_RULES].join('\n\n');
}

/** 3.2 非 Writer 调用点（规划/评审/修复/提取/校准）统一挂接公共前缀：role 为该 调用点角色身份与任务规则，
 * 与 Writer 家族共享 DOCUMENT_L0_COMMON_PREFIX 第一段，跨类型 prefix cache 从零命中变为全类型共享。
 * 3.1：公共段扩展为 L0 + FORMAL_WRITING_RULES（≥2000 字符），role 保持尾部固定位置。
 * DOCUMENT_L0_SYSTEM_PREFIX=0 时回退 legacyPrefix（缺省即 role 本身） */
export function docSystemPrefix(role: string, legacyPrefix?: string): string {
  return process.env.DOCUMENT_L0_SYSTEM_PREFIX === '0' ? (legacyPrefix ?? role) : [unifiedSystemHead(), role].join('\n\n');
}

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

/** 修复双标题叠加（“## ### 标题”同段粘连）与相邻结构重复标题：合并叠加行并删除与前一行结构一致的标题行。 */
export function removeAdjacentDuplicateHeadings(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  const output: string[] = [];
  let previousTitle = '';
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    // 双标题叠加：## ### 标题 → 降级保留 ### 标题
    const stacked = /^##\s+(#{2,5})\s+(.+)$/u.exec(trimmed);
    if (stacked) {
      const heading = stacked[1] || '';
      const title = (stacked[2] || '').trim();
      if (title && !sameStructuralTitle(title, previousTitle)) {
        output.push(`${heading} ${displayChapterTitle(title)}`);
        previousTitle = title;
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(trimmed);
    if (heading) {
      const title = (heading[2] || '').trim();
      if (title) {
        if (sameStructuralTitle(title, previousTitle)) continue;
        previousTitle = title;
      }
      output.push(rawLine);
      continue;
    }
    // 正文行隔断相邻比较，避免跨段误删
    if (trimmed) previousTitle = '';
    output.push(rawLine);
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n');
}

/** 标题归一化（去编号/括号/标点）：跨层级同名判定与 dedupeRepeatedSubsections 的 H4 归一化同口径 */
function normalizeHeadingForDedup(title: string): string {
  return title.replace(/^\d+(?:\.\d+)*\s*/u, '').replace(/[\s:：、。，,;；/|—-]/gu, '');
}

function headingBlockSentenceFingerprints(lines: string[], start: number, end: number): Set<string> {
  const fingerprints = new Set<string>();
  for (let index = start; index < end; index += 1) {
    const line = lines[index].trim();
    if (/^#{1,6}\s/u.test(line) || /^\|.*\|$/u.test(line)) continue;
    for (const sentence of line.split(/[。；;]/u)) {
      const trimmed = sentence.trim();
      if (trimmed.length >= 16) fingerprints.add(trimmed.replace(/[\s\p{P}]+/gu, ''));
    }
  }
  return fingerprints;
}

/**
 * 章节内 H2/H3 跨层级同名整块去重（4.12.12 真实生成回归，评分报告「同名小节重复」blocker 根因）：
 * Writer 把计划小节误升为 H2（「## 3.2 新技术、新工艺、新材料、新设备的应用」）后，
 * 又按计划输出同名 H3（「### 新技术、新工艺、新材料、新设备的应用」），整块内容写两遍。
 * 确定性修复：归一化同名时，两块的句子指纹重合率 ≥50% 直接删除内容较短块；
 * 重合不足时把 H2 块降级为 H3 保留独有内容（章节标题本身与任何 H3 不同名，不受影响）。
 */
export function dedupeCrossLevelHeadingDuplicates(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const blocks: Array<{ level: number; title: string; normalized: string; start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{2,3})\s+(.+)$/u.exec(lines[index].trim());
    if (!heading) continue;
    if (blocks.length > 0) blocks[blocks.length - 1].end = index;
    blocks.push({ level: heading[1].length, title: heading[2].trim(), normalized: normalizeHeadingForDedup(heading[2].trim()), start: index, end: lines.length });
  }
  if (blocks.length === 0) return markdown;
  const drops: Array<{ start: number; end: number; downgrade: boolean }> = [];
  // 4.12.12：必须从首个块开始扫描——首个标题块本身是 H2 且后跟同名 H3 时（文档以跨层级重复块
  // 开篇的真实形态），从 index=1 起扫会漏掉第一个块，重复块原样保留
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.level !== 2) continue;
    const nextH2Index = blocks.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.level === 2);
    const scopeEnd = nextH2Index >= 0 ? blocks[nextH2Index].start : lines.length;
    const twin = blocks.find(candidate => candidate !== block && candidate.level === 3 && candidate.normalized === block.normalized && candidate.start > block.start && candidate.start < scopeEnd);
    if (!twin) continue;
    const blockFingerprints = headingBlockSentenceFingerprints(lines, block.start + 1, block.end);
    const twinFingerprints = headingBlockSentenceFingerprints(lines, twin.start + 1, twin.end);
    const overlap = [...blockFingerprints].filter(fingerprint => twinFingerprints.has(fingerprint)).length;
    const minSize = Math.min(blockFingerprints.size, twinFingerprints.size);
    const ratio = minSize > 0 ? overlap / minSize : 0;
    if (ratio >= 0.5) {
      const blockChars = lines.slice(block.start + 1, block.end).join('\n').length;
      const twinChars = lines.slice(twin.start + 1, twin.end).join('\n').length;
      const drop = blockChars >= twinChars ? twin : block;
      drops.push({ start: drop.start, end: drop.end, downgrade: false });
    } else {
      drops.push({ start: block.start, end: block.start, downgrade: true });
    }
  }
  if (drops.length === 0) return markdown;
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (drops.some(drop => !drop.downgrade && index >= drop.start && index < drop.end)) continue;
    const downgrade = drops.find(drop => drop.downgrade && drop.start === index);
    output.push(downgrade ? lines[index].replace(/^##\s+/, '### ') : lines[index]);
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n');
}

/**
 * 同小节内相邻段落块重复去重（4.12.12 真实生成回归，评分报告 P3）：
 * 成稿把「施工流程：…」「施工方法：…」整段连续复制 3 遍（复制粘贴残留）。
 * 确定性修复：同一小节内，与最近 3 个非空段中某段指纹完全相同的段落（去空白标点后 ≥24 字）删除；
 * 标题行重置窗口（跨小节正当重复不误删），表格行不参与。
 */
export function dedupeRepeatedBlocksWithinSections(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const output: string[] = [];
  let recentFingerprints: string[] = [];
  let paragraphBuffer: string[] = [];
  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) return;
    const paragraph = paragraphBuffer.join('\n').trim();
    paragraphBuffer = [];
    if (!paragraph) return;
    const fingerprint = paragraph.replace(/[\s\p{P}]+/gu, '');
    if (fingerprint.length >= 24 && recentFingerprints.includes(fingerprint)) return;
    recentFingerprints = [...recentFingerprints, fingerprint].slice(-3);
    for (const line of paragraph.split(/\n/u)) output.push(line);
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed)) {
      flushParagraph();
      output.push(line);
      recentFingerprints = [];
      continue;
    }
    if (trimmed === '') {
      flushParagraph();
      output.push(line);
      continue;
    }
    paragraphBuffer.push(line);
  }
  flushParagraph();
  return output.join('\n');
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
    const boldTableTitle = /^\*\*([^*]{2,40}表)\*\*\s*$/u.exec(line.trim());
    if (boldTableTitle && currentSectionNumber) {
      tertiaryIndex += 1;
      return `#### ${currentSectionNumber}.${tertiaryIndex} ${displayChapterTitle(boldTableTitle[1] || '')}`;
    }
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
        issues.push({ level: 'warning', message: `三级小节缺少 ${currentSectionNumber}.x 编号：${displayChapterTitle(rawTitle)}`, suggestion: '三级小节必须使用“#### 章号.节号.序号 标题”。' });
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
  if (/^(?:雨季|冬季|高温|台风|大风)(?:[、，](?:雨季|冬季|高温|台风|大风))*等特殊气候$/u.test(clean)) return '';
  if (/^(?:雨季|冬季|高温|台风|大风)$/u.test(clean)) return '';
  return clean;
}

function cleanTocSections(sections: string[] = []) {
  return [...new Set(sections.map(normalizeTocSection).filter(section => section.length >= 2))];
}

/** 目录只收录章标题与二级小节；三级小节（#### X.Y.Z 标题）只存在于正文，不进入目录 */
function composeTocLines(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>) {
  return chapters.flatMap((chapter, index) => {
    const sections = cleanTocSections(chapter.sections || []);
    return [
      `${formalChapterTitle(index, chapter.title)}`,
      ...sections.map((section, sectionIndex) => `  ${tocSectionTitle(index, sectionIndex, section)}`),
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
    if (extracted.length > 0) return extracted;
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
  let activeSourceSectionTitle = '';
  let hasRealActiveSection = false;
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
    activeSourceSectionTitle = plannedIndex >= 0 ? displayChapterTitle(plannedSections[plannedIndex]) : cleanTitle;
    emittedSectionKeys.add(sectionKey);
    return `### ${chapterIndex + 1}.${sectionIndex} ${plannedIndex >= 0 ? displayChapterTitle(plannedSections[plannedIndex]) : cleanTitle}`;
  };
  /** 四级标题成稿：同一 H3 小节下前 4 个编号为 #### x.y.z，其后降级为粗体（后续 sanitize 会转回 H4 并重新编号） */
  const emitTertiary = (title: string, sourceSection: string) => {
    const titleKey = normalizePlannedSectionTitle(title);
    const isPlannedPendingSection = plannedSectionIndex(title) >= 0 && !emittedSectionKeys.has(titleKey);
    if (!sectionIndex) return normalizeSectionHeading(title, sourceSection);
    if (sourceSection && sourceSection !== activeSourceSection && ((chapters[chapterIndex]?.sections || []).length === 0 || isPlannedPendingSection)) return normalizeSectionHeading(title, sourceSection);
    tertiaryIndex += 1;
    return tertiaryIndex <= 4 ? `#### ${chapterIndex + 1}.${sectionIndex}.${tertiaryIndex} ${title}` : `**${title}**`;
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
      activeSourceSectionTitle = '';
      hasRealActiveSection = false;
      emittedSectionKeys = new Set<string>();
      return line;
    }
    const h2ChineseSection = /^##\s+第[一二三四五六七八九十百千万\d]+节\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2ChineseSection) { hasRealActiveSection = true; return normalizeSectionHeading(h2ChineseSection[1] || ''); }
    const h2SingleNumberedSection = /^##\s+\d+[.．、]\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2SingleNumberedSection) { hasRealActiveSection = true; return normalizeSectionHeading(h2SingleNumberedSection[1] || ''); }
    const h2NumberedSection = /^##\s+(\d+)\.(\d+)\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2NumberedSection) { hasRealActiveSection = true; return normalizeSectionHeading(h2NumberedSection[3] || '', `${h2NumberedSection[1]}.${h2NumberedSection[2]}`); }
    const h2PlainSection = /^##\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h2PlainSection) {
      const plainTitle = displayChapterTitle(h2PlainSection[1] || '');
      if (/^本章目录$/u.test(plainTitle)) return '';
      if (/^附录/u.test(plainTitle)) return line;
      hasRealActiveSection = true;
      return normalizeSectionHeading(plainTitle);
    }
    const section = /^###\s+(?:(\d+)\.(\d+)\s+)?(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && section) { hasRealActiveSection = true; return normalizeSectionHeading(section[3] || '', section[1] && section[2] ? `${section[1]}.${section[2]}` : undefined); }
    const h3NumberedAsSection = /^####\s+(\d+)\.(\d+)(?!\.)\s+(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && h3NumberedAsSection) {
      const candidateTitle = displayChapterTitle(h3NumberedAsSection[3] || '');
      const inWorkPackageSection = WORK_PACKAGE_SECTION_RE.test(activeSourceSectionTitle);
      const plannedSectionsEmpty = (chapters[chapterIndex]?.sections || []).length === 0;
      const isPlannedSection = plannedSectionIndex(candidateTitle) >= 0;
      // 带两位编号的 H4 升级为 H3 仅限「LLM 全程用 #### X.Y 代替 H3」的误写场景：
      // 章内出现过真实 H3（###/## 节标题）后，一律视为小节内四级标题——否则工作包型小节下的
      // 工作包 H4（4.1/9.0 等）会被升成 H3，把目录结构撑爆
      if (!hasRealActiveSection && !inWorkPackageSection && (isPlannedSection || plannedSectionsEmpty)) return normalizeSectionHeading(h3NumberedAsSection[3] || '', `${h3NumberedAsSection[1]}.${h3NumberedAsSection[2]}`);
      return emitTertiary(candidateTitle, activeSourceSection);
    }
    const tertiary = /^####\s+(?:(\d+)\.(\d+)\.(\d+)\s+)?(.+)$/u.exec(trimmed);
    if (chapterIndex >= 0 && tertiary) {
      const sourceSection = tertiary[1] && tertiary[2] ? `${tertiary[1]}.${tertiary[2]}` : activeSourceSection;
      return emitTertiary(displayChapterTitle(tertiary[4] || ''), sourceSection);
    }
    return line;
  }).filter(line => line !== '').join('\n');
}

function requiredTableMarkdown(title: string) {
  if (/项目基本信息/u.test(title)) return '';
  return [`**${title}**`, '', '| 控制项目 | 控制内容 | 执行要求 | 复核要求 |', '|---|---|---|---|', `| ${title.replace(/表$/u, '')} | 依据招标文件、施工图设计文件、工程量清单和施工组织安排填写 | 实施前完成专业复核、审批确认和交底闭环 | 不采用无依据的工程实体参数 |`].join('\n');
}

function hasProjectBasicInfoTable(markdown: string) {
  return /项目基本信息/u.test(markdown) || /\|\s*信息项\s*\|\s*内容\s*\|/u.test(markdown) || /\|\s*项目名称\s*\|[^\n|]+\|/u.test(markdown);
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
    .replace(/^\*\*([^*\n]{4,40})\*\*\s*$/gmu, (line: string, title: string) => {
      const clean = title.trim();
      // 整行加粗且带句末标点/冒号或为提示语的不属于小节标题，保留原文；其余按“禁止用粗体代替标题”规范转为 #### 标题
      if (/[:：。！!？?，,、]$/u.test(clean) || /^(?:注意|提示|备注|警告|说明)/u.test(clean)) return line;
      return `#### ${clean}`;
    })
    .replace(/承包人案/gu, '方案')
    .replace(/承包人法(?=[:：])/gu, '施工方法')
    .replace(/承包人法/gu, '方法')
    .replace(/(?:本|我)施工方/gu, '我公司')
    .replace(/(?:本|我)投标人/gu, '我公司')
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
    if (term.from.length < 2) continue;
    if (term.from === '施工方') {
      next = next.replace(/施工方(?!法|案|式|针|向|面)/gu, term.to);
      continue;
    }
    next = next.replace(new RegExp(escapedRegExp(term.from), 'gu'), term.to);
  }
  next = applyForbiddenTermReplacements(next, rules);
  return next.replace(/\n{3,}/gu, '\n\n').trim();
}

export function ensureFormalToc(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections' | 'content'>>) {
  const normalizedMarkdown = normalizeFormalChapterHeadings(markdown, chapters);
  const bodyMarkdown = removeTocBlock(normalizedMarkdown);
  const headingMatches = [...bodyMarkdown.matchAll(/^##\s+(.+)$/gmu)];
  const tocChapters = chapters.map((chapter) => {
    const current = headingMatches.find(match => sameStructuralTitle(match[1] || '', chapter.title));
    if (!current || current.index === undefined) return chapter;
    const next = headingMatches.find(match => (match.index || 0) > (current.index || 0) && chapters.some(item => sameStructuralTitle(match[1] || '', item.title)));
    // content 必须取 normalizeFormalChapterHeadings 规范化后的章节区间（H4 已带 X.Y.Z 编号），
    // 供 chapter.sections 缺失时 extractGeneratedSections 从正文提取二级小节兜底；
    // 有 sections 的章节也不能短路返回原始 chapter，否则目录章节结构对不上正文。
    const chapterRange = bodyMarkdown.slice(current.index, next?.index ?? bodyMarkdown.length);
    const sections = chapter.sections?.length ? undefined : extractGeneratedSections(chapterRange);
    return sections?.length ? { ...chapter, sections, content: chapterRange } : { ...chapter, content: chapterRange };
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
    chapter.tablePlans?.length ? `  结构化表格规划：${chapter.tablePlans.map(plan => `${plan.title}(${plan.fields.map(field => field.name).join('/')})`).join('；')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
}

export async function promptDocumentRuleIssues(markdown: string, rules?: PromptDocumentRuleSet, embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<ValidationIssue[]> {
  if (!rules) return [];
  const issues: ValidationIssue[] = [];
  // 指令型标题检测：强句式（INSTRUCTION_HEADING_RE）确定性命中 + 弱词根召回语义复核（semanticGate 统一入口），
  // 防"如何写/注意事项"类变体漏网，同时防正常小节标题误杀
  const instructionHeadings = [...markdown.matchAll(INSTRUCTION_HEADING_RE)].map(match => (match[0] || '').replace(/^#{2,6}\s+/u, '').trim()).filter(Boolean);
  // /g 正则的 test() 会累积 lastIndex，语义召回过滤用无全局标志副本
  const instructionHeadingTest = new RegExp(INSTRUCTION_HEADING_RE.source, 'mu');
  const weakCandidates = [...markdown.matchAll(/^#{2,6}\s+(.+)$/gmu)]
    .map(match => ({ raw: match[0] || '', title: match[1]?.replace(/^\d+(?:\.\d+)*[、.．\s]*\s*/u, '').trim() || '' }))
    .filter(item => item.title && !instructionHeadingTest.test(item.raw) && INSTRUCTION_WEAK_HINT_RE.test(item.title));
  if (weakCandidates.length > 0) {
    const gate = await buildInstructionHeadingGate(embedDocuments);
    const flags = await gate(weakCandidates.map(item => item.title));
    weakCandidates.forEach((item, index) => {
      if (flags[index]) instructionHeadings.push(item.title);
    });
  }
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
  const hitTerms = (rules.forbiddenTerms || []).filter(term => term && !/^(?:工程造价|造价|报价|投标报价|综合单价|单价|合价|金额|税率|增值税|利润|预留金|暂列金额|兜底)$/u.test(term) && new RegExp(escapedRegExp(term), 'u').test(markdown));
  if (hitTerms.length > 0) issues.push({ level: 'warning', message: `正文残留总控提示词禁止词：${hitTerms.join('、')}`, suggestion: '请改为正式交付语言，删除后台话术、第三人称和口号式表达。' });
  const runtimeRules = rules as PromptDocumentRuleSet & { exactHeadings?: string[]; forbidExtraHeadings?: boolean; requiredSubjects?: string[]; forbiddenSubjects?: string[]; minChars?: number };
  const exactHeadings = runtimeRules.exactHeadings || [];
  if (exactHeadings.length > 0) {
    const actualHeadings = [...markdown.matchAll(/^##\s+(.+)$/gmu)].map(match => displayChapterTitle(match[1] || '')).filter(title => !(title === '目录' && rules.tocPolicy === 'required') && !/^附录/u.test(title));
    const normalizedExactHeadings = exactHeadings.map(displayChapterTitle);
    const missingHeadings = exactHeadings.filter(title => !actualHeadings.includes(displayChapterTitle(title)));
    const extraHeadings = runtimeRules.forbidExtraHeadings ? actualHeadings.filter(title => !normalizedExactHeadings.includes(displayChapterTitle(title))) : [];
    if (missingHeadings.length > 0) issues.push({ level: 'error', message: `正文缺少提示词指定一级章节：${missingHeadings.join('、')}`, suggestion: '请严格按用户提示词 OUTLINE 输出一级章节。' });
    if (extraHeadings.length > 0) issues.push({ level: 'warning', message: `正文出现提示词未允许的一级章节：${extraHeadings.join('、')}`, suggestion: '请检查是否为正文内部层级误升；如不影响指定 OUTLINE 完整性，可在后续排版中并入所属章节。' });
  }
  const subjectHits = (runtimeRules.forbiddenSubjects || []).filter(term => term && new RegExp(escapedRegExp(term), 'u').test(markdown));
  if (subjectHits.length > 0) issues.push({ level: 'warning', message: `正文残留禁用主体表达：${subjectHits.join('、')}`, suggestion: '请统一改为用户提示词指定的表达主体。' });
  const plainLength = markdown.replace(/\s/gu, '').length;
  // 提示词字数目标是生成预算口径：95% 以上视为达标（生成波动容差），不足按 warning 提示而非阻断，
  // 与 documentBudgetIssues 的“低于目标字数”warning 口径一致
  if (runtimeRules.minChars && plainLength < Math.floor(runtimeRules.minChars * 0.95)) issues.push({ level: 'warning', message: `正文长度低于提示词要求：当前 ${plainLength} 字，要求不少于 ${runtimeRules.minChars} 字`, suggestion: '请按章节深度扩写，但不得编造资料外事实。' });
  return issues.map(issue => issue.level === 'warning' && /提示词|禁止|禁用|必含关键词|必需表格|主体表达/u.test(issue.message) ? { ...issue, level: 'error' as const, severity: issue.severity || ('blocker' as const) } : issue);
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
    if (chapter.tableSections?.length && !hasMarkdownTable(body)) issues.push({ level: 'warning', message: `${chapter.title} 缺少必要的正式表格`, suggestion: '建议按模板 tableSections/tableRequirements 在对应小节补充正式 Markdown 表格。' });
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

export function finalizeDocumentMarkdown<T extends Pick<DocumentDraftChapter, 'title' | 'sections' | 'content'>>(markdown: string, chapters: T[], options: { forbidDrawingImages?: boolean; promptRules?: PromptDocumentRuleSet } = {}) {
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
  // C1 目录确定性：目录=生成前规划大纲。正文提取的 H3（inferredSections）不再覆盖规划 sections——
  // 正文 H3 被 LLM 改写（增删修饰词/换连接词/加"（一）"后缀）后提取进目录是目录污染的直接源头；
  // 仅当章节无规划小节时才用正文提取兜底（未规划章节目录不能为空）
  const finalizedChapters = chapters.map((chapter, index) => ({
    ...chapter,
    sections: (chapter.sections || []).filter(Boolean).length > 0 ? chapter.sections : (inferredSections[index]?.length ? inferredSections[index] : []),
  }));
  // C1 目录确定性：只要未明确禁止目录，一律用确定性目录替换正文目录页（含 LLM 写的脏目录）——
  // 历史缺陷：仅 tocPolicy==='required' 时替换，unspecified 场景下 LLM 目录原样保留（目录与正文标题不一致）
  const tocAppliedMarkdown = options.promptRules?.tocPolicy !== 'forbidden' ? ensureFormalToc(normalizedMarkdown, finalizedChapters) : normalizeFormalChapterHeadings(normalizedMarkdown, finalizedChapters);
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
    const sections = extractGeneratedSections(normalizedBlock);
    return sections.length ? { ...chapter, sections: cleanTocSections(sections), content: normalizedBlock } : { ...chapter, content: normalizedBlock };
  });
  const initialMarkdown = [
    composeEnhancedCoverMarkdown(draft.title, draft.facts),
    '',
    '<div class="page-break"></div>',
    '',
    composeTocMarkdown(tocChapters),
    '',
    '<div class="page-break"></div>',
    '',
    chapterMarkdown,
  ].join('\n');

  const finalized = finalizeDocumentMarkdown(initialMarkdown, cleanChapters, options);
  // 正文末尾不再追加附录（图位索引/关键工艺参数汇总）：用户明确要求正文不需要附录内容，
  // 附录由导出环节按需生成，不进正文 markdown（历史缺陷：附录B 自动归集表格被评标视为
  // 非正文冗余内容，且归集了“本工作包”等后台话术污染正文）
  return finalized.markdown;
}
