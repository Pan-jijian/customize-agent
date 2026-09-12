/**
 * helpers/markdownCleanup：正文清理/表格工具/章节质量线（P3 拆分，逐字机械搬移自 documentGeneratorHelpers.ts）。
 * 无域内跨依赖。
 */
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from '../types';
import type { buildPromptBindingPlan, ResolvedPromptContent } from '../templateStore';
import { mergeTableLineBreaks, normalizeInlineListBreaks, normalizeMarkdownTableDividers, normalizeTenderSourcePageRefs, removeAdjacentDuplicateHeadings, dedupeCrossLevelHeadingDuplicates, dedupeRepeatedBlocksWithinSections } from '../markdownComposer';
import { displayChapterTitle, isTenderClauseFragmentTitle } from '../outline';
import { BID_DISCIPLINE_PHRASES, dedupeCrossSectionSkeletonH4s, dedupeRepeatedSubsections, isBidDisciplineSentence, stringifyFactValue, throwIfAborted, WORK_PACKAGE_SECTION_RE } from '../utils';
import { promptTextsForResolvedPrompts } from '../rolePipeline';

export function removeSystemInjectedBoilerplate(content: string) {
  return content
    .replace(/^\s*本表依据项目图谱[^\n。]*[。.]\s*$/gmu, '')
    .replace(/^\s*本表依据(?:招标文件|工程量清单|施工区段|质量目标|计划工期|项目图谱|危险源辨识|材料设备清单|现场条件|图纸资料|图纸设计说明)[^\n。]*[。.]\s*$/gmu, '')
    .replace(/^\s*表中事项应纳入[^\n。]*[。.]\s*$/gmu, '')
    .replace(/^\s*正式输出的表格\/清单必须形成[^\n。]*[。.]\s*$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function repairPlannedSectionBodies(content: string, _chapter: Pick<DocumentTemplateChapter, 'title' | 'sections'>) {
  return content;
}

export function repairTableOnlySections(content: string) {
  return removeSystemInjectedBoilerplate(content);
}

export function isMarkdownTableSeparatorLine(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line.trim());
}

export function looksLikeMarkdownTableLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || /^#{1,6}\s+/u.test(trimmed) || isMarkdownTableSeparatorLine(trimmed)) return false;
  const pipeCount = (trimmed.match(/\|/gu) || []).length;
  return pipeCount >= 2 || pipeCount >= 1 && /^\s*\|/u.test(trimmed) || pipeCount >= 1 && /\|\s*$/u.test(trimmed);
}

/** 表格单元格不可见字符归一（全角空格 \u3000 / 不换行空格 \u00a0 / 零宽与变体空格 \u2000-\u200f\u202f\u205f / BOM \ufeff）。
 * 十度实测缺陷：LLM 输出的空表格单元格有时以全角空格等不可见字符填充，cell.trim() 无法识别，
 * 检测/修复/审计三层全部漏网；清洗层剥离后三层同口径以 cell === '' 判定空单元格。 */
export function stripTableCellInvisibleChars(text: string): string {
  return text.replace(/[\u3000\u00a0\u2000-\u200f\u202f\u205f\ufeff]/gu, '');
}

export function splitMarkdownTableLine(line: string) {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').trim().split('|').map(cell => stripTableCellInvisibleChars(cell).trim());
}

export function formatMarkdownTableLine(cells: string[], columns: number) {
  const normalized = cells.slice(0, columns);
  while (normalized.length < columns) normalized.push('');
  return `| ${normalized.join(' | ')} |`;
}

export function genericTableHeaders(columns: number) {
  if (columns === 2) return ['信息项', '内容'];
  const headers = ['控制项目', '执行要求', '责任岗位', '检查标准', '形成资料', '闭环要求', '备注'];
  return Array.from({ length: columns }, (_item, index) => headers[index] || `补充说明${index + 1}`);
}

export function normalizeBareMarkdownTables(markdown: string) {
  markdown = mergeTableLineBreaks(markdown);
  const lines = markdown.replace(/\r?\n/gu, '\n').split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    const nextIndex = lines[index + 1]?.trim() === '' ? index + 2 : index + 1;
    const separator = lines[nextIndex] || '';
    if (looksLikeMarkdownTableLine(line) && isMarkdownTableSeparatorLine(separator)) {
      const headerCells = splitMarkdownTableLine(line);
      const headerColumns = headerCells.length;
      output.push(line);
      if (nextIndex !== index + 1) output.push(lines[index + 1] || '');
      output.push(separator);
      index = nextIndex + 1;
      while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
        // E2 超列合并：数据行列数超过表头时，多余列追加进末列表头对应单元格（分号连接），
        // 避免渲染列错位或信息截断（危大工程表“同上 | 搭设高度8m及以上…”现场）
        const cells = splitMarkdownTableLine(lines[index] || '');
        if (cells.length > headerColumns) {
          const overflow = cells.slice(headerColumns - 1).join('；');
          output.push(formatMarkdownTableLine([...cells.slice(0, headerColumns - 1), overflow], headerColumns));
        } else {
          output.push(lines[index] || '');
        }
        index += 1;
      }
      continue;
    }
    if (!looksLikeMarkdownTableLine(line)) {
      output.push(line);
      index += 1;
      continue;
    }
    const rows: string[] = [];
    let cursor = index;
    while (cursor < lines.length && looksLikeMarkdownTableLine(lines[cursor] || '')) {
      rows.push(lines[cursor] || '');
      cursor += 1;
    }
    const rowCells = rows.map(row => splitMarkdownTableLine(row));
    const columnCounts = rowCells.map(cells => cells.length);
    const columns = columnCounts[0] || 0;
    const projectBasicLabels = /^(?:项目名称|工程名称|项目编号|招标人|建设单位|建设地点|建设规模|计划工期|质量标准|合同估算价|招标范围)$/u;
    if (rows.length < 2 || columns < 2 || columnCounts.some(count => count !== columns) || rowCells.some(cells => projectBasicLabels.test(cells[0] || ''))) {
      output.push(...rows);
      index = cursor;
      continue;
    }
    // 裸表格列头判定：第一行单元格若均为短词且不含数值/标点（数据行普遍含数量、日期、百分比或长句），
    // 视为 LLM 原始列头行，保留并仅补分隔行；否则无法判定列头语义，原样保留。
    // 强制套通用列头模板会把语义不符的模板列头盖在材料/设备等数据上，造成
    // “责任岗位”列填日期、“检查标准”列填管径的列头数据错位（真实生成缺陷）
    const firstRow = rowCells[0] || [];
    const dataRows = rowCells.slice(1);
    const looksLikeHeaderRow = firstRow.length >= 2 && firstRow.every(cell =>
      cell.length > 0 && cell.length <= 12 && !/\d/u.test(cell) && !/[。，；：]/u.test(cell))
      && dataRows.some(cells => cells.some(cell => /\d/u.test(cell) || cell.length > 12));
    if (!looksLikeHeaderRow) {
      output.push(...rows);
      index = cursor;
      continue;
    }
    if (output.length > 0 && output[output.length - 1]?.trim()) output.push('');
    output.push(formatMarkdownTableLine(firstRow, columns));
    output.push(formatMarkdownTableLine(Array.from({ length: columns }, () => '---'), columns));
    for (const row of dataRows) output.push(formatMarkdownTableLine(row, columns));
    index = cursor;
    if (index < lines.length && lines[index]?.trim()) output.push('');
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n');
}

export function stripProvenanceTableColumns(markdown: string) {
  const lines = markdown.replace(/\r?\n/gu, '\n').split('\n');
  const output: string[] = [];
  const splitRow = (line: string) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
  const isTableRow = (line: string) => /^\s*\|.*\|\s*$/u.test(line);
  const isSeparator = (line: string) => /^\s*\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line);
  const formatRow = (cells: string[]) => `| ${cells.join(' | ')} |`;
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    const separator = lines[index + 1] || '';
    if (!isTableRow(line) || !isSeparator(separator)) {
      output.push(line);
      index += 1;
      continue;
    }
    const headers = splitRow(line);
    const removeIndexes = headers.map((cell, cellIndex) => /^(?:资料来源|资料来源\/(?:说明|证明)|来源|证明)$/u.test(cell) ? cellIndex : -1).filter(cellIndex => cellIndex >= 0);
    if (removeIndexes.length === 0) {
      output.push(line);
      index += 1;
      continue;
    }
    const keep = (cells: string[]) => cells.filter((_cell, cellIndex) => !removeIndexes.includes(cellIndex));
    output.push(formatRow(keep(headers)));
    output.push(formatRow(keep(splitRow(separator)).map(cell => cell || '---')));
    index += 2;
    while (index < lines.length && isTableRow(lines[index] || '')) {
      output.push(formatRow(keep(splitRow(lines[index] || ''))));
      index += 1;
    }
  }
  return output.join('\n').replace(/资料来源\/(?:说明|证明)/gu, '');
}

export function replaceForbiddenFormalPhrases(content: string) {
  return content
    .replace(/【修复任务包】[\s\S]*?(?=\n#{1,3}\s|\n\*\*|\n\|\s|$)/gu, '')
    .replace(/^修复类型：.*$/gmu, '')
    .replace(/^修复对象：.*$/gmu, '')
    .replace(/^问题：【修复任务包】[\s\S]*?(?=\n#{1,3}\s|\n\*\*|\n\|\s|$)/gu, '')
    .replace(/^输出要求：.*$/gmu, '')
    .replace(/重新生成/gu, '补充完善')
    .replace(/见招标公告|见投标人须知前附表/gu, '按已确认的招标边界和施工条件执行')
    .replace(/见招标文件/gu, '按本项目招标文件已明确的相应条款执行')
    .replace(/招标范围：/gu, '施工范围：')
    .replace(/主要承包人案|承包人案/gu, match => match.replace(/承包人案/gu, '施工方案'))
    .replace(/施工方(?!案|法|式|针|向|面)/gu, '承包人')
    .replace(/按图纸/gu, '依据经确认的设计文件和图纸内容组织实施')
    .replace(/按设计要求/gu, '依据设计文件明确的构造、材料、尺寸和验收要求执行')
    // round-27 污染根治：此前的替换产物「依据本项目已确认资料、技术文件和验收标准」
    // 含系统内部话术「已确认资料」（写作硬约束第 5 条明令禁止），与内部话术检测器互相打架，
    // 丰乐镇实测直接进成品（小菜园围栏/机械设备进出场两处）；仅模糊来源词
    // 「按资料/按文件/按说明」需要替换（指向不明），「按方案/按规范/按标准/按要求」是正常施组表述不再替换
    .replace(/按(?:资料|文件|说明)/gu, '按设计文件及批准的施工方案要求')
    .replace(/满足(?:相关|有关)?要求/gu, '满足本项目已明确的质量、安全、技术和验收控制要求')
    .replace(/本节(?:将|主要|重点)?/gu, '')
    .replace(/本章将/gu, '')
    .replace(/根据需要|视情况|结合实际情况/gu, '根据现场实际情况和审批后的施工安排确定')
    .replace(/相关要求/gu, '本项目已明确的质量、安全、技术和验收要求')
    // round-27：替换产物尾部词形去重（「按文件要求」替换后与后续「要求」粘连成「要求要求」）
    .replace(/要求要求/gu, '要求')
    .replace(/确定确定/gu, '确定');
}

// 正式正文中绝无合法用途的占位/系统话术：包含此类话术的句子整句删除，
// 避免 Reviewer 报禁止话术后 Repairer patch 无法定位或修复后又残留导致不收敛；
// 占位句删除后若小节过浅，由“正文不足”检查触发 Repairer 用真实证据补写。

const FORBIDDEN_PLACEHOLDER_PHRASES = ['资料未明确', '系统暂未', '项目资料暂未', '暂未明确', '待确认', '待资料复核', '待系统', '未检索到', '资料不足', '无法确认', '建议补充', '可核验信息', '知识库', 'COL'];

export function stripForbiddenPlaceholderSentences(content: string) {
  if (!FORBIDDEN_PLACEHOLDER_PHRASES.some(phrase => content.includes(phrase))) return content;
  return content
    .split('\n')
    .map(line => {
      if (/^\s*#{1,6}\s/u.test(line) || /^\s*\|/u.test(line)) return line;
      if (!FORBIDDEN_PLACEHOLDER_PHRASES.some(phrase => line.includes(phrase))) return line;
      return line
        .split(/(?<=[。；;])/u)
        .filter(segment => !FORBIDDEN_PLACEHOLDER_PHRASES.some(phrase => segment.includes(phrase)))
        .join('');
    })
    .join('\n');
}

/** 图集/国标做法编号引用短语确定性删除（丰乐镇第 3 轮实测）：LLM 在施工方法小节编造
 * 「做法执行15D501图集」「做法参照国标11J900内墙18/H7」类引用（项目资料中无这些图集编号，
 * 属于「按图纸…图集…」式非法引用话术，不得进入正式正文）；短语连同前置逗号整体删除，
 * 保留句子其余内容，句子末尾标点不动。标题行/表格行豁免。 */

export function stripAtlasReferencePhrases(markdown: string): { markdown: string; fixedCount: number } {
  if (!/做法(?:执行|参照|详见|见|依据|按)/u.test(markdown)) return { markdown, fixedCount: 0 };
  let fixedCount = 0;
  const result = markdown
    .split('\n')
    .map(line => {
      if (/^\s*#{1,6}\s/u.test(line) || /^\s*\|/u.test(line)) return line;
      return line.replace(/(?:[，,]\s*)?(?:构造做法|节点做法|做法)(?:执行|参照|详见|见|依据|按)[^。；!！?？\n]{0,30}(?:图集|国标\s?[0-9]{1,4}[^。；!！?？\n]{0,16})(?=[。；!！?？]|$)/gu, () => {
        fixedCount += 1;
        return '';
      });
    })
    .join('\n');
  return { markdown: result, fixedCount };
}

/** 商务评标纪律承诺句确定性删除（与 FORBIDDEN_PLACEHOLDER_PHRASES 同构治理）：
 * 正式技术标中此类承诺绝无合法用途，整句删除后由商务文件另行承载。
 * 判定复用 utils 单一来源词表 + 纪律语境句级兜底（覆盖「实行严格的纪律管理，确保投标活动
 * 合法合规」类无禁词词面变体——评分报告问题2实测原文）。
 * 标题行不再豁免（评分报告 P1 实测：「### 对与评标活动有关的工作人员的纪律要求」6 个纪律小节
 * 标题曾因标题豁免整行放行）——标题命中即整行删除，正文保留并入上一小节；
 * 表格行保留豁免（表格内容由商务数据检测独立治理）。 */

export function stripBidDisciplineSentences(content: string) {
  if (!BID_DISCIPLINE_PHRASES.some(phrase => content.includes(phrase)) && !/纪律|廉洁/u.test(content)) return content;
  return content
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      const isHeading = /^#{1,6}\s/u.test(trimmed);
      if (/^\s*\|/u.test(trimmed)) return line;
      if (isHeading) {
        // 标题行命中纪律判定 → 整行删除（标题文字本身就是泄漏主体，不保留空壳标题）
        return isBidDisciplineSentence(trimmed.replace(/^#{1,6}\s+/u, '')) ? '' : line;
      }
      return line
        .split(/(?<=[。；;])/u)
        .filter(segment => !isBidDisciplineSentence(segment))
        .join('');
    })
    .join('\n');
}

/**
 * 投标程序/评标纪律句语义召回词形：评标澄清/评审争议/中标公示/清单计量报价/实质性响应类
 * 无禁词词面变体（evidenceContentSafety.ts 原型集同口径），词面命中仅触发语义复核不直接判定——
 * 判定由 buildBidProcedureJudge 语义模型完成（评分报告 P1 实测 6 个纪律小节标题无任何禁词词面）。
 */
const BID_PROCEDURE_STRIP_HINTS_RE = /评标|投标|行贿|打招呼|递条子|廉洁|串标|围标|弄虚作假|干扰评标|纪律|澄清|中标|报价|清单计量|评审|保证金|开标|递交/u;

/**
 * 投标程序/评标纪律句语义增强清洗（生成后兜底第二道防线）：词面召回（禁写词 + 无禁词词面变体
 * 语境词）→ 语义模型判定（与证据层 buildBidProcedureJudge 同口径双向比对）→ 确定性判定兜底。
 * 主生成链路（documentGenerator 章节写作）在同步确定性清洗后追加本函数；
 * 语义模型恒可用：judge 构建失败直接抛出，无"语义不可用跳过过滤"的降级分支。
 */
export async function stripBidDisciplineSentencesSemantic(content: string, judge: (texts: string[]) => Promise<boolean[]>): Promise<string> {
  if (!BID_PROCEDURE_STRIP_HINTS_RE.test(content)) return content;
  const lines = content.split('\n');
  // 候选展开：标题行整行候选（命中删整行），正文行按句拆分候选（命中只删该句，防同行施工合法句误伤）
  const candidates: Array<{ lineIndex: number; text: string; wholeLine: boolean }> = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const trimmed = lines[lineIndex].trim();
    if (!trimmed || /^\s*\|/u.test(trimmed)) continue;
    if (/^#{1,6}\s/u.test(trimmed)) {
      const text = trimmed.replace(/^#{1,6}\s+/u, '');
      if (BID_PROCEDURE_STRIP_HINTS_RE.test(text)) candidates.push({ lineIndex, text, wholeLine: true });
      continue;
    }
    for (const segment of lines[lineIndex].split(/(?<=[。；;])/u)) {
      const text = segment.trim();
      if (text && BID_PROCEDURE_STRIP_HINTS_RE.test(text)) candidates.push({ lineIndex, text, wholeLine: false });
    }
  }
  if (candidates.length === 0) return content;
  const verdicts = await judge(candidates.map(candidate => candidate.text));
  const dropWholeLines = new Set<number>();
  const dropSegmentsByLine = new Map<number, Set<string>>();
  for (let position = 0; position < candidates.length; position += 1) {
    const candidate = candidates[position];
    // 确定性判定兜底（禁写词出现本身即删除）；语义命中同样删除（无禁词词面变体靠语义捕获）
    if (!(isBidDisciplineSentence(candidate.text) || verdicts[position])) continue;
    if (candidate.wholeLine) {
      dropWholeLines.add(candidate.lineIndex);
      continue;
    }
    const segments = dropSegmentsByLine.get(candidate.lineIndex) || new Set<string>();
    segments.add(candidate.text);
    dropSegmentsByLine.set(candidate.lineIndex, segments);
  }
  if (dropWholeLines.size === 0 && dropSegmentsByLine.size === 0) return content;
  return lines.map((line, lineIndex) => {
    if (dropWholeLines.has(lineIndex)) return '';
    const dropSegments = dropSegmentsByLine.get(lineIndex);
    if (!dropSegments) return line;
    return line
      .split(/(?<=[。；;])/u)
      .filter(segment => !dropSegments.has(segment.trim()))
      .join('');
  }).join('\n');
}

export function splitOverlongParagraphs(markdown: string) {
  return markdown.split(/\n{2,}/u).map(block => {
    const text = block.trim();
    if (text.length < 420 || /^\s*(#|\||[-*]\s|\d+[.、])/u.test(text)) return block;
    const parts = text.split(/(?<=[。；])(?=.)/u);
    const chunks: string[] = [];
    let current = '';
    for (const part of parts) {
      if ((current + part).length > 260 && current) {
        chunks.push(current);
        current = part;
      } else {
        current += part;
      }
    }
    if (current) chunks.push(current);
    return chunks.join('\n\n');
  }).join('\n\n');
}

export function demoteNonFormalH2(markdown: string) {
  return markdown.replace(/^##\s+(.+)$/gmu, (full, title: string) => {
    const clean = String(title || '').trim();
    if (clean === '目录' || /^附录/u.test(clean) || /^第[一二三四五六七八九十百千万\d]+章\s+/u.test(clean)) return full;
    return `### ${clean}`;
  });
}

export function filterResolvedFinalIssues(markdown: string, issues: ValidationIssue[]) {
  const hasIllegalH2 = /^##\s+(?!目录$)(?!附录)(?!第[一二三四五六七八九十百千万\d]+章\s+)/gmu.test(markdown);
  const hasPageRefs = /(?:第?\d+页|P\.?\s*\d+)/iu.test(markdown);
  const hasForbiddenParty = /施工方/u.test(markdown);
  return issues.filter(issue => {
    if (/正文存在非正式章二级标题/u.test(issue.message)) return hasIllegalH2;
    if (/资料页码|文件页码|页码引用/u.test(issue.message)) return hasPageRefs;
    if (/禁止内容|施工方/u.test(issue.message)) return hasForbiddenParty;
    return true;
  });
}

export function splitLongParagraphs(content: string) {
  // 验证侧 formalContentIntegrityIssues 对正文行 >380 字符报 warning；
  // 生成侧以 360 字符为段落上限并留出 Markdown 加粗/链接语法字符余量，避免稳定触发该 warning
  const MAX_PARAGRAPH = 360;
  return content.split(/\n{2,}/u).map(block => {
    if (/^\s*(#{1,6}\s+|[-*+]\s+|\|)/u.test(block) || block.length <= MAX_PARAGRAPH + 20) return block;
    // 先按句号/分号拆句，单句仍超上限时再按逗号拆，避免段落被保留为超长单段
    const sentences = block
      .split(/(?<=[。；])/u)
      .flatMap(item => {
        const sentence = item.trim();
        if (!sentence) return [];
        if (sentence.length > MAX_PARAGRAPH) return sentence.split(/(?<=[，,])/u).map(part => part.trim()).filter(Boolean);
        return [sentence];
      });
    const chunks: string[] = [];
    let current = '';
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > MAX_PARAGRAPH) {
        chunks.push(current);
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current) chunks.push(current);
    return chunks.join('\n\n');
  }).join('\n\n');
}

/** 空壳小节标题清理：标题后直到下一个标题行之间没有任何非空内容，且下一标题不是更深层级的子小节
 * （子小节存在说明正文由子层展开，不算空壳）→ 删除空标题整行。
 * 覆盖 H3~H5：块成稿 LLM 偶尔输出“### 1.1.2 项目基本信息”这类无正文空壳，紧邻有正文小节时相邻去重管不到，必须整行删除。 */

function removeEmptySubSectionHeadings(content: string) {
  const lines = content.split(/\r?\n/u);
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const heading = /^(#{3,5})\s+/u.exec(trimmed);
    if (!heading) {
      result.push(line);
      continue;
    }
    const level = heading[1].length;
    let cursor = index + 1;
    let hasBody = false;
    let nextHeadingLevel = 0;
    while (cursor < lines.length) {
      const next = lines[cursor].trim();
      const nextHeading = /^(#{1,6})\s+/u.exec(next);
      if (nextHeading) {
        nextHeadingLevel = nextHeading[1].length;
        break;
      }
      if (next) {
        hasBody = true;
        break;
      }
      cursor += 1;
    }
    // 工作包型关键小节标题后紧跟同级 H4 工作包是合法结构（小节正文由工作包列表展开），不得误删；
    // 4.19.3 收紧：零正文且无子层展开的空壳标题不再豁免——容器块的 H4 分部清单被串章骨架清理
    // 整块删除后，空 H3 因无条件豁免漏网进入成品文档，被打空洞小节 warning，必须删除
    const workPackageWithPeerH4 = WORK_PACKAGE_SECTION_RE.test(trimmed) && level === 4 && nextHeadingLevel === 4;
    // 下一标题为更深层子小节时保留；零正文且无子层展开的空壳标题删除
    if (!hasBody && !(nextHeadingLevel > level) && !workPackageWithPeerH4) continue;
    result.push(line);
  }
  return result.join('\n');
}

/** 工作包标签归一化（4.17.9 兼容处理，标签非强制但 LLM 输出标签时须归正常形态）：
 * LLM 补写稿常输出畸形标签形态——“施工概况：**施工概况**：”重复标签、
 * “**施工流程**：/**施工方法**：”粗体伪标签——粗体命中分部分项验收器脏事实正则、方法段提取正则
 * 拿不到冒号后内容（九度实测缺陷：10 个分项被报脏事实+缺工序顺序表达 blocker）。归一为纯文本标签形态。 */

export function normalizeWorkPackageLabels(markdown: string): string {
  let normalized = markdown;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = normalized
      // 重复标签形态先于粗体形态处理，避免“施工概况：**施工概况**：”被粗体替换残留前缀。
      // \2 反向引用保证同名标签才合并，避免“施工方法：**施工流程：**”交叉形态被误删。
      // 冒号位置兼容四种形态：**标签**：、**标签：**、标签：**标签**：、标签：**标签：**
      // （十一度实测：Writer 输出“施工概况：**施工概况：**”冒号在 ** 内，旧正则漏归一导致 7 处重复标签、23 处粗体伪标签进入成品）
      .replace(/((施工概况|施工流程|施工方法)[:：])\s*\*\*\2(?:[:：])?\*\*[:：]?/gu, '$1')
      // 行中伪标签（正文句尾接“**施工流程：**”）：归一到标签词后紧跟冒号；无冒号的纯加粗不动。
      // 冒号在 ** 内（**标签：**）与在 ** 外（**标签**：）两种形态分别覆盖
      .replace(/(?<![\w|])\*\*(施工概况|施工流程|施工方法)(?:[:：])\*\*[:：]?/gu, '$1：')
      .replace(/(?<![\w|])\*\*(施工概况|施工流程|施工方法)\*\*[:：]/gu, '$1：');
    if (next === normalized) break;
    normalized = next;
  }
  return normalized;
}

/**
 * 表头粘连行确定性拆分（改9，十一度实测缺陷）：LLM 常把表格表头写在正文段落同一行
 * （“正文…。| 表头1 | 表头2 |”），成品渲染时表格无表头、分隔行被当首行显示为空单元格。
 * 判定严格：行不以 | 开头、行尾以 | 结尾且含 ≥2 个非空短单元格、下一行是表格行才拆分；
 * 只做换行拆分，不改写任何文字（不属于内容兜底）。
 */
export function splitGluedTableHeaderLines(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const next = (lines[index + 1] || '').trim();
    if (!trimmed || trimmed.startsWith('|') || trimmed.startsWith('#') || !next.startsWith('|')) {
      output.push(line);
      continue;
    }
    const tailMatch = /(\|\s*[^|\n]{1,40}\s*){2,}\|\s*$/u.exec(trimmed);
    if (!tailMatch) {
      output.push(line);
      continue;
    }
    const splitAt = trimmed.length - tailMatch[0].length;
    const body = trimmed.slice(0, splitAt).trim();
    if (body) output.push(body);
    output.push(tailMatch[0].trim());
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n');
}

/** 中文词中断空格清洗（改9）：LLM 行宽断字把词拆断（“形成资 料”“按清 单”），
 * 同行汉字间的空白一律移除。标题行（#）、目录编号行（1.1/第X章）的编号与标题间
 * 合法空格保留（“第一章 工程重点难点”不得被误合并）。 */

export function cleanChineseWordBreakSpaces(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  return lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s+/u.test(trimmed) || /^\d+(?:\.\d+)*\s+/u.test(trimmed) || /^第[一二三四五六七八九十百千\d]+[章节]\s+/u.test(trimmed)) return line;
    return line.replace(/([\u4e00-\u9fa5])[ \t\u00a0\u3000]+(?=[\u4e00-\u9fa5])/gu, '$1');
  }).join('\n');
}

/**
 * 后台术语确定性词形规范化（问题4根治）：正式交付文档中「工作包」是后台生成概念，任何语境均不应出现。
 * 语义改写优先由 Repairer 按上下文完成（qualityValidation 的 blocker 触发定向修复）；此处兜底词形替换
 * 保证该 blocker 必然收敛，杜绝「修复→复检仍报→再修复」死循环消耗轮次预算（历史缺陷：工作包术语多轮不收敛）。
 * 映射与 qualityValidation 的 suggestion 同口径：“X工程工作包”→“X工程”，“按工作包”→“按专业工程”。
 */
export function rewriteWorkPackageTerminology(content: string): string {
  let next = content;
  next = next.replace(/([\u4e00-\u9fa5A-Za-z]{2,16})工程工作包/gu, '$1工程');
  next = next.replace(/(按|以|按每个|每个|的)工作包/gu, '$1专业工程');
  next = next.replace(/工作包/gu, '专业工程');
  return next;
}

/**
 * 剥离写手把招标条款碎片误写成的小节标题行（如「### 3项规定」「### 56m15：…」）：
 * 写手从评标办法条款证据中照抄碎片标题，与显式 OUTLINE 提取共用同一判别器（isTenderClauseFragmentTitle）；
 * 标题行整行删除、行下正文保留并入上一小节，由 Reviewer/Repairer 承接段落归属。
 */
export function stripTenderClauseFragmentHeadings(content: string) {
  const lines = content.split(/\r?\n/u);
  const kept = lines.map(line => {
    const heading = /^#{3,4}\s+(.+)$/u.exec(line.trim());
    if (heading && isTenderClauseFragmentTitle(displayChapterTitle((heading[1] || '').trim()))) return '';
    return line;
  });
  if (kept.every((line, index) => line === lines[index])) return content;
  return kept.join('\n').replace(/\n{3,}/gu, '\n\n');
}

/**
 * 数据一致性自查/约束文字泄漏段落判定（段落级整段删除）：
 * 1. 以「上表/本表」开头且含「一致/修正为」的自查推算段——写手把表格口径推算过程写进正文
 *    （如「与 180 人不一致，故将合计行…修正为 130 人」，历史缺陷：自查注释与表格数值矛盾直接进正文）；
 * 2. 约束指令文字被写手复述进正文（评分报告 N2 实测：「全文不再出现 180 人」「正文不得出现跨章冲突」）——
 *    「全文/正文/文中 + 不再出现/不得出现」句式与「跨章冲突不得出现」类表述在正式正文中无合法用途。
 */
function isDataConsistencyLeakParagraph(singleLine: string): boolean {
  const text = singleLine.trim();
  if (/^(?:上表|本表)/u.test(text) && /(?:一致|修正为)/u.test(text)) return true;
  if (/(?:全文|正文|文中)(?:不再出现|不得出现|不得再出现|不应出现|不会再出现)/u.test(text)) return true;
  if (/不得出现跨章冲突|跨章冲突不得出现|不得与其他章节(?:矛盾|冲突)/u.test(text)) return true;
  return false;
}

/** 句子级泄漏判别（真实生成回归，合肥师范 4.12.8）：数据一致性修复轮把修复要求本身写入正文的
 * 泄漏句式，按句删除、保留同段其余正文（段落级整段删除会误伤「编制范围覆盖…」等有效内容）。 */

function isDataConsistencyLeakSentence(sentence: string): boolean {
  if (/不得出现其他[^。；\n]{0,12}口径/u.test(sentence)) return true;
  if (/[^。；\n]{0,10}口径必须(?:唯一|一致|统一)/u.test(sentence)) return true;
  return false;
}

export function stripDataConsistencyLeakSentences(content: string) {
  const paragraphs = content.split(/\n\s*\n/u);
  const kept: string[] = [];
  let changed = false;
  for (const paragraph of paragraphs) {
    const singleLine = paragraph.replace(/\n/gu, '');
    if (isDataConsistencyLeakParagraph(singleLine)) {
      changed = true;
      continue;
    }
    const sentences = paragraph.split(/(?<=[。！？!?；;])/u);
    const survived = sentences.filter(sentence => !isDataConsistencyLeakSentence(sentence.replace(/\n/gu, '').trim()));
    if (survived.length !== sentences.length) changed = true;
    kept.push(survived.join(''));
  }
  if (!changed) return content;
  return kept.filter(Boolean).join('\n\n');
}

/** 跨小节重复句合并最短字数：≥30 字长句在跨小节完全重复时合并（评分报告 N4/P3：5.1 与 5.6、68/69 行整句重复） */

const MIN_CROSS_SECTION_DUPLICATE_SENTENCE_CHARS = 30;

/**
 * 跨小节整句重复合并：清洗管道只处理小节标题级重复（dedupeRepeatedSubsections），
 * 跨小节整句重复（5.1 vs 5.6 同一长句两处出现、68/69 行相邻重复）无检测（评分报告 N4）。
 * 规则：≥30 字长句（去除空白后）首次出现的小节保留，其他小节中的完全重复句删除；
 * 同一小节内重复保留（可能为有意强调），标题行/表格行不参与。
 * 1.5 扩展（跨章完全重复句漏网实锤：同名小节字符串相等被误判"同小节保留"）——同名标题第 N 次出现
 * 序号化为不同小节（章间无标题归属感知时两章常出现同名小节，如 1.3↔6.4），确保跨章重复句被清除。
 * （原 DOCUMENT_CROSS_CHAPTER_DEDUP 回退已固化删除：跨章序号化判定恒开）
 */
export function dedupeCrossSectionDuplicateSentences(content: string): string {
  const lines = content.split('\n');
  const firstSectionBySentence = new Map<string, string>();
  const sectionOccurrences = new Map<string, number>();
  let currentSection = '';
  let changed = false;
  const result = lines.map(line => {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed)) {
      // 同名标题第 N 次出现序号化：不同位置的同名小节（跨章串章产物）视为不同小节，句级去重不被"同小节保留"豁免
      const occurrence = sectionOccurrences.get(trimmed) || 0;
      sectionOccurrences.set(trimmed, occurrence + 1);
      currentSection = occurrence === 0 ? trimmed : `${trimmed}#${occurrence}`;
      return line;
    }
    if (!trimmed || /^\s*\|/u.test(trimmed)) return line;
    const kept = line.split(/(?<=[。；;])/u).filter(segment => {
      const text = segment.replace(/\s+/gu, '');
      if (text.length < MIN_CROSS_SECTION_DUPLICATE_SENTENCE_CHARS) return true;
      const firstSection = firstSectionBySentence.get(text);
      if (firstSection === undefined) {
        firstSectionBySentence.set(text, currentSection);
        return true;
      }
      // 同一小节内重复保留；跨小节重复句删除（保留首次出现小节）
      if (firstSection === currentSection) return true;
      changed = true;
      return false;
    });
    if (kept.length !== line.split(/(?<=[。；;])/u).length) changed = true;
    return kept.join('');
  });
  if (!changed) return content;
  return result.join('\n');
}

/** 段内整句复制去重（第十六版 C15 句级复制漏网根治）：同一段内相同句（≥20 字）连写两遍属
 * 复制粘贴残迹（订单抽查句/盘点句/核查句连现两遍实测形态），保留首次出现句删除后续副本；
 * 标题行/表格行不参与。与跨小节去重（dedupeCrossSectionDuplicateSentences）互补：
 * 跨小节去重豁免「同小节重复」段内形态，本函数补上段内检测。 */
export function dedupeRepeatedSentencesWithinBlocks(content: string): string {
  const blocks = content.split(/\n{2,}/u);
  let changed = false;
  const deduped = blocks.map(block => {
    const trimmed = block.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) return block;
    const sentences = block.split(/(?<=[。；;])/u);
    const seen = new Set<string>();
    const kept = sentences.filter(sentence => {
      const text = sentence.replace(/\s+/gu, '');
      if (text.length < 20) return true;
      if (seen.has(text)) { changed = true; return false; }
      seen.add(text);
      return true;
    });
    return kept.join('');
  });
  if (!changed) return content;
  return deduped.join('\n\n');
}

/** 同章高频同句限次（第十六版 F23 套话收敛）：同一章内逐字相同句（≥12 字）出现超过 3 次属
 * 万能句机械堆叠（「项目经理每周检查不少于 1 次」「发现……当日整改并复查销项」类），
 * 保留前 2 处、删除多余副本；被删位置由小节补写链按禁写清单补新内容（P8），不破坏字数达标。 */
export function dedupeChapterFrequentSentences(content: string): string {
  const occurrences = new Map<string, number>();
  let changed = false;
  const lines = content.split('\n').map(line => {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) return line;
    const kept = line.split(/(?<=[。；;])/u).filter(segment => {
      const text = segment.replace(/\s+/gu, '');
      if (text.length < 12) return true;
      const count = occurrences.get(text) || 0;
      occurrences.set(text, count + 1);
      if (count + 1 > 2) { changed = true; return false; }
      return true;
    });
    return kept.join('');
  });
  if (!changed) return content;
  return lines.join('\n');
}

export function finalizeChapterContentQuality(content: string, chapter: Pick<DocumentTemplateChapter, 'title' | 'sections'>) {
  let cleaned = rewriteWorkPackageTerminology(content);
  cleaned = repairPlannedSectionBodies(cleaned, chapter);
  cleaned = repairTableOnlySections(cleaned);
  cleaned = replaceForbiddenFormalPhrases(cleaned);
  cleaned = stripForbiddenPlaceholderSentences(cleaned);
  cleaned = stripBidDisciplineSentences(cleaned);
  cleaned = splitLongParagraphs(cleaned);
  cleaned = normalizeTenderSourcePageRefs(cleaned);
  cleaned = normalizeInlineListBreaks(cleaned);
  cleaned = splitGluedTableHeaderLines(cleaned);
  cleaned = normalizeMarkdownTableDividers(cleaned);
  cleaned = removeAdjacentDuplicateHeadings(cleaned);
  cleaned = dedupeRepeatedSubsections(cleaned);
  cleaned = removeEmptySubSectionHeadings(cleaned);
  cleaned = cleanChineseWordBreakSpaces(cleaned);
  // 4.17.9 已移除 ensureWorkPackageOverviewLabels：其把工作包块首行自然成文强制改写为“施工概况：”标签形态，
  // 与“写法正确即可、不固定写法”口径相悖；且验收器已改为内容要素判定，无标签块不再被阻断，该清洗环节已无存在理由
  cleaned = normalizeWorkPackageLabels(cleaned);
  cleaned = dedupeCrossSectionDuplicateSentences(cleaned);
  // 第十六版：段内整句复制去重 + 同章高频同句限次（句级复制/套话堆叠根治）
  cleaned = dedupeRepeatedSentencesWithinBlocks(cleaned);
  cleaned = dedupeChapterFrequentSentences(cleaned);
  // 4.12.12：跨层级（H2/H3 同名）整块去重与同小节内相邻块重复去重（评分报告「同名小节重复」/「整段重复三遍」根因治理）
  cleaned = dedupeCrossLevelHeadingDuplicates(cleaned);
  cleaned = dedupeRepeatedBlocksWithinSections(cleaned);
  // 组件 8 章级逐字重复收口：整段完全重复（跨小节、全章范围）删除多余副本
  cleaned = dedupeChapterDuplicateParagraphs(cleaned);
  cleaned = cleaned.replace(/\n{3,}/gu, '\n\n');
  cleaned = stripTenderClauseFragmentHeadings(cleaned);
  return stripDataConsistencyLeakSentences(cleaned).trim();
}

/** 章级整段逐字重复消除（组件 8）：同一段落（去空白后 ≥24 字指纹完全相同）在本章内
 * 第二次及以后出现即删除，保留首次出现（逐字复读 = 复制粘贴残迹，删多余副本零信息损失）；
 * 标题行/表格行不入池，列表项单独成段。与 dedupeRepeatedBlocksWithinSections
 *（同小节窗口 3）互补：本函数跨小节、全章范围收口，为写作职责分工（组件 6）后的确定性兜底。 */
export function dedupeChapterDuplicateParagraphs(content: string): string {
  const lines = content.split('\n');
  const seen = new Set<string>();
  const drop = new Set<number>();
  let buffer: string[] = [];
  let bufferLines: number[] = [];
  const flush = () => {
    const normalized = buffer.join('').replace(/\s+/gu, '');
    if (normalized.length >= 24) {
      if (seen.has(normalized)) bufferLines.forEach(index => drop.add(index));
      else seen.add(normalized);
    }
    buffer = [];
    bufferLines = [];
  };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) { flush(); return; }
    if (/^[-*•]\s/u.test(trimmed)) { flush(); buffer = [trimmed]; bufferLines = [index]; flush(); return; }
    buffer.push(trimmed);
    bufferLines.push(index);
  });
  flush();
  if (drop.size === 0) return content;
  return lines.filter((_, index) => !drop.has(index)).join('\n');
}

/** 最终组装路径的重复/空壳兜底清理：rebuildFinalMarkdown 不再逐章跑 finalizeChapterContentQuality，
 * 补跑同 H3 重复 H4 去重与空壳小节删除，避免 Final Gate 补写与章节拼接残留的重复/空壳进入成品文档。 */

export function finalizeFinalMarkdownStructure(markdown: string): string {
  return stripDataConsistencyLeakSentences(stripTenderClauseFragmentHeadings(removeEmptySubSectionHeadings(dedupeRepeatedSubsections(dedupeCrossSectionSkeletonH4s(dedupeCrossLevelHeadingDuplicates(dedupeRepeatedBlocksWithinSections(normalizeWorkPackageLabels(cleanChineseWordBreakSpaces(splitGluedTableHeaderLines(rewriteWorkPackageTerminology(dedupeCrossSectionDuplicateSentences(markdown))))))))))));
}

export function promptMatchesChapter(prompt: ResolvedPromptContent, _chapter: DocumentTemplateChapter) {
  return prompt.category === 'writer' || prompt.category === 'chapter' || prompt.category === 'formatting';
}

export function resolveChapterPromptExecution(promptPlan: ReturnType<typeof buildPromptBindingPlan>, chapter: DocumentTemplateChapter) {
  const chapterPrompts = promptPlan.chapterPrompts.filter(prompt => promptMatchesChapter(prompt, chapter));
  const prompts = [...promptPlan.writerPrompts, ...chapterPrompts, ...promptPlan.formattingPrompts];
  const primaryWriter = promptPlan.writerPrompts[0];
  const promptDetails = prompts.map(prompt => `${prompt.category === 'writer' ? '写作控制提示词' : prompt.category}｜${prompt.roleId}｜${prompt.name}｜${prompt.content.length} 字符`);
  const systemPrompt = promptTextsForResolvedPrompts(promptPlan.writerPrompts);
  const scopedPrompt = promptTextsForResolvedPrompts([...chapterPrompts, ...promptPlan.formattingPrompts]);
  return {
    primaryPromptId: primaryWriter?.id,
    primaryWriter,
    prompts,
    promptTexts: [
      systemPrompt ? `【最高优先级：配置写作主控提示词】\n${systemPrompt}` : '',
      scopedPrompt ? `【章节/格式提示词】\n${scopedPrompt}` : '',
    ].filter(Boolean).join('\n\n'),
    promptDetails,
  };
}
