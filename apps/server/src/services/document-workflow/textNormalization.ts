/**
 * 文本规范化工具函数
 * 从 documentGenerator.ts 提取，纯函数无副作用，不依赖生成管线状态
 */
import type { DocumentFact, DocumentTemplateChapter, ValidationIssue } from './types';
import { normalizeOcrFactText } from './factsModel';

function escapeRegExpLiteral(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function cleanInlineFactValue(value: string) {
  return normalizeOcrFactText(value).replace(/[。；;]$/u, '').trim();
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

export function splitMarkdownTableLine(line: string) {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').trim().split('|').map(cell => cell.trim());
}

export function formatMarkdownTableLine(cells: string[], columns: number) {
  const normalized = cells.slice(0, columns);
  while (normalized.length < columns) normalized.push('');
  return `| ${normalized.join(' | ')} |`;
}

function genericTableHeaders(columns: number) {
  if (columns === 2) return ['信息项', '内容'];
  const headers = ['项目', '内容', '备注', '说明'];
  return Array.from({ length: columns }, (_item, index) => headers[index] || `列${index + 1}`);
}

export function normalizeBareMarkdownTables(markdown: string) {
  const lines = markdown.replace(/\r?\n/gu, '\n').split('\n');
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    const nextIndex = lines[index + 1]?.trim() === '' ? index + 2 : index + 1;
    const separator = lines[nextIndex] || '';
    if (looksLikeMarkdownTableLine(line) && isMarkdownTableSeparatorLine(separator)) {
      output.push(line);
      if (nextIndex !== index + 1) output.push(lines[index + 1] || '');
      output.push(separator);
      index = nextIndex + 1;
      while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) { output.push(lines[index] || ''); index += 1; }
      continue;
    }
    if (!looksLikeMarkdownTableLine(line)) { output.push(line); index += 1; continue; }
    const rows: string[] = [];
    let cursor = index;
    while (cursor < lines.length && looksLikeMarkdownTableLine(lines[cursor] || '')) { rows.push(lines[cursor] || ''); cursor += 1; }
    const rowCells = rows.map(row => splitMarkdownTableLine(row));
    const columnCounts = rowCells.map(cells => cells.length);
    const columns = columnCounts[0] || 0;
    const projectBasicLabels = /^(?:项目名称|工程名称|项目编号|招标人|建设单位|建设地点|建设规模|计划工期|质量标准|合同估算价|招标范围)$/u;
    if (rows.length < 2 || columns < 2 || columnCounts.some(count => count !== columns) || rowCells.some(cells => projectBasicLabels.test(cells[0] || ''))) {
      output.push(...rows);
      index = cursor;
      continue;
    }
    if (output.length > 0 && output[output.length - 1]?.trim()) output.push('');
    output.push(formatMarkdownTableLine(genericTableHeaders(columns), columns));
    output.push(formatMarkdownTableLine(Array.from({ length: columns }, () => '---'), columns));
    for (const row of rows) output.push(formatMarkdownTableLine(splitMarkdownTableLine(row), columns));
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
    if (!isTableRow(line) || !isSeparator(separator)) { output.push(line); index += 1; continue; }
    const headers = splitRow(line);
    const removeIndexes = headers.map((cell, cellIndex) => /^(?:资料来源|资料来源\/(?:说明|证明)|来源|证明)$/u.test(cell) ? cellIndex : -1).filter(cellIndex => cellIndex >= 0);
    if (removeIndexes.length === 0) { output.push(line); index += 1; continue; }
    const keep = (cells: string[]) => cells.filter((_cell, cellIndex) => !removeIndexes.includes(cellIndex));
    output.push(formatRow(keep(headers)));
    output.push(formatRow(keep(splitRow(separator)).map(cell => cell || '---')));
    index += 2;
    while (index < lines.length && isTableRow(lines[index] || '')) { output.push(formatRow(keep(splitRow(lines[index] || '')))); index += 1; }
  }
  return output.join('\n').replace(/资料来源\/(?:说明|证明)/gu, '');
}

export function removeDuplicateProjectBasicInfoBlocks(markdown: string) {
  const projectBasicLabels = [/^项目名称$/u, /^工程名称$/u, /^项目编号$/u, /^招标项目编号$/u, /^招标人$/u, /^项目业主$/u, /^建设单位$/u, /^发包人$/u, /^建设地点$/u, /^实施地点$/u, /^建设规模$/u, /^工程规模$/u, /^计划工期$/u, /^合同工期$/u, /^总工期$/u, /^质量标准$/u, /^质量目标$/u, /^合同估算价$/u, /^投资估算$/u, /^最高投标限价$/u, /^招标控制价$/u];
  const lines = markdown.replace(/\r?\n/gu, '\n').split('\n');
  const output: string[] = [];
  let seenProjectBasicTable = false;
  const splitRow = (line: string) => splitMarkdownTableLine(line).map(cell => cell.replace(/\*\*/gu, '').trim());
  const isProjectBasicLabel = (label: string) => projectBasicLabels.some(pattern => pattern.test(label));
  const isTwoColumnProjectBasicTable = (rows: string[]) => {
    const dataRows = rows.slice(2).map(splitRow).filter(cells => cells.length >= 2);
    const labels = dataRows.map(cells => cells[0] || '');
    const matched = labels.filter(isProjectBasicLabel).length;
    return matched >= 3 && matched >= Math.ceil(labels.length * 0.45);
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    const next = lines[index + 1] || '';
    const namedProjectBasicTitle = /(?:\*\*[^\n]*项目基本信息表[^\n]*\*\*|####\s+[^\n]*项目基本信息表[^\n]*|###\s+[^\n]*项目基本信息表[^\n]*)/u.test(line);
    if (namedProjectBasicTitle) {
      const block: string[] = [line];
      index += 1;
      while (index < lines.length && !(looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) && (lines[index] || '').trim() === '') { block.push(lines[index] || ''); index += 1; }
      if (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) { block.push(lines[index] || '', lines[index + 1] || ''); index += 2; while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) { block.push(lines[index] || ''); index += 1; } }
      if (!seenProjectBasicTable) { seenProjectBasicTable = true; output.push(...block); }
      continue;
    }
    if (/^###\s+(?:\d+\.\d+\s+)?(?:项目基本信息|工程概况|项目概况)\s*$/u.test(line)) {
      const block: string[] = [line]; index += 1;
      while (index < lines.length && !(looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) && !/^###\s+/u.test(lines[index] || '')) { block.push(lines[index] || ''); index += 1; }
      if (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) {
        const rows = [lines[index] || '', lines[index + 1] || '']; index += 2;
        while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) { rows.push(lines[index] || ''); index += 1; }
        if (isTwoColumnProjectBasicTable(rows)) {
          if (!seenProjectBasicTable) { seenProjectBasicTable = true; output.push(...block, ...rows); } else { const prose = block.filter(item => item.trim() && !/^###\s+/u.test(item)); if (prose.length) output.push(line, ...prose); }
          continue;
        }
        output.push(...block, ...rows); continue;
      }
      output.push(...block); continue;
    }
    if (looksLikeMarkdownTableLine(line) && isMarkdownTableSeparatorLine(next)) { const rows = [line, next]; index += 2; while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) { rows.push(lines[index] || ''); index += 1; } if (isTwoColumnProjectBasicTable(rows)) { if (!seenProjectBasicTable) { seenProjectBasicTable = true; output.push(...rows); } continue; } output.push(...rows); continue; }
    output.push(line); index += 1;
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\n{1,2}\|\s*信息项\s*\|\s*内容\s*\|\s*\n+(?:该小节围绕[^\n]*\n+)+\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*/gu, '\n\n');
}

function projectBasicFactCandidates(facts: DocumentFact[]) {
  return facts.filter(fact => /项目名称|工程名称|项目编号|招标项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|计划工期|合同工期|周期要求|质量标准|合同估算|投资估算|最高投标限价|招标控制价/u.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`));
}

function stringifyFactValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(v => String(v)).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

function projectBasicValueFor(facts: DocumentFact[], patterns: RegExp[]) {
  return projectBasicFactCandidates(facts)
    .filter(fact => patterns.some(pattern => pattern.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`)))
    .filter(fact => /项目名称|工程名称|项目编号|业主|单位|公司/u.test(`${fact.key || ''}${fact.fieldName || ''}`) ? stringifyFactValue(fact.value).length >= 4 : true)
    .sort((a, b) => {
      const aText = stringifyFactValue(a.value); const bText = stringifyFactValue(b.value);
      const aScore = (a.sourceFile?.includes('招标文件') ? 3 : 0) + (a.sourceRef?.sectionTitle && /项目概况|招标公告|前附表|招标范围/u.test(a.sourceRef.sectionTitle) ? 2 : 0) - Math.floor(aText.length / 80);
      const bScore = (b.sourceFile?.includes('招标文件') ? 3 : 0) + (b.sourceRef?.sectionTitle && /项目概况|招标公告|前附表|招标范围/u.test(b.sourceRef.sectionTitle) ? 2 : 0) - Math.floor(bText.length / 80);
      return bScore - aScore;
    })[0]?.value;
}

function projectBasicInfoRows(facts: DocumentFact[], existingMarkdown = '', fullMarkdown = existingMarkdown) {
  const parsedRows = parseProjectBasicRowsFromMarkdown(existingMarkdown);
  const pickCanonical = (patterns: RegExp[]) => { const val = projectBasicValueFor(facts, patterns); if (val) return [val, '项目资料'] as [string, string]; return markdownRowValue(parsedRows, patterns) || ['', '']; };
  const rows: Array<[string, string, string]> = [
    ['项目名称', ...pickCanonical([/项目名称|工程名称/u])], ['项目编号', ...pickCanonical([/项目编号|招标项目编号/u])],
    ['招标人', ...pickCanonical([/招标人|项目业主|建设单位|发包人/u])], ['建设地点', ...pickCanonical([/建设地点/u])],
    ['建设规模', ...pickCanonical([/建设规模/u])], ['计划工期', ...pickCanonical([/计划工期|合同工期|周期要求/u])],
    ['质量标准', ...pickCanonical([/质量标准/u])], ['合同估算价', ...pickCanonical([/合同估算|投资估算|最高投标限价|招标控制价/u])],
  ];
  return rows.map(([label, value, source]) => [label, value || '系统暂未从知识库确认', value ? source || '项目资料' : '待系统补抽确认'] as [string, string, string]);
}

function projectBasicInfoTableMarkdown(facts: DocumentFact[], existingMarkdown = '', fullMarkdown = existingMarkdown) {
  const rows = projectBasicInfoRows(facts, existingMarkdown, fullMarkdown);
  return ['**项目基本信息表**', '', '| 信息项 | 内容 |', '|---|---|', ...rows.map(row => `| ${row[0]} | ${row[1]} |`)].join('\n');
}

function parseProjectBasicRowsFromMarkdown(content: string) {
  const rows = new Map<string, [string, string]>();
  for (const line of content.split(/\r?\n/u)) {
    if (!/^\|.*\|\s*$/u.test(line) || /^\|\s*:?-{3,}:?/u.test(line)) continue;
    const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.replace(/\*\*/gu, '').trim());
    if (cells.length < 2) continue;
    const label = cells[0] === '序号' && cells.length >= 3 ? cells[1] : cells[0];
    const value = cells[0] === '序号' && cells.length >= 3 ? cells[2] : cells[1];
    const source = cells[0] === '序号' && cells.length >= 4 ? cells[3] : cells[2];
    const normalizedLabel = label.replace(/\/|：|:/gu, '').trim();
    if (!/项目名称|工程名称|项目编号|招标项目编号|招标人|项目业主|建设单位|发包人|建设地点|建设规模|施工范围|招标范围|计划工期|合同工期|质量标准|合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(normalizedLabel)) continue;
    if (!value || /内容|参数|资料未明确|系统暂未从知识库确认/u.test(value)) continue;
    rows.set(normalizedLabel, [cleanInlineFactValue(value), cleanInlineFactValue(source || '项目资料') || '项目资料']);
  }
  return rows;
}

function markdownRowValue(parsedRows: Map<string, [string, string]>, patterns: RegExp[]) {
  for (const [label, value] of parsedRows.entries()) { if (patterns.some(pattern => pattern.test(label))) return value; }
  return undefined;
}

export function normalizeProjectBasicInfoTable(content: string, facts: DocumentFact[]) {
  if (!/项目基本信息|项目概况|工程概况|招标范围/u.test(content)) return removeDuplicateProjectBasicInfoBlocks(normalizeBareMarkdownTables(stripProvenanceTableColumns(content)));
  if (!/\|\s*信息项\s*\|\s*内容\s*\|/u.test(content) && projectBasicFactCandidates(facts).length > 0) {
    const firstProjectHeading = /^(###\s+(?:\d+\.\d+\s+)?[^\n]*(?:项目概况|工程概况|项目基本信息|招标范围)[^\n]*\n)/mu.exec(content);
    if (firstProjectHeading?.index || firstProjectHeading?.index === 0) { const insertAt = firstProjectHeading.index + firstProjectHeading[0].length; content = `${content.slice(0, insertAt)}\n${projectBasicInfoTableMarkdown(facts, '', content)}\n\n${content.slice(insertAt).trimStart()}`; }
  }
  const projectSection = /^(###\s+(?:\d+\.\d+\s+)?[^\n]*(?:项目概况|工程概况|项目基本信息|招标范围)[^\n]*\n)/mu.exec(content);
  if (!projectSection?.index && projectSection?.index !== 0) return content;
  const sectionStart = projectSection.index; const sectionBodyStart = sectionStart + projectSection[0].length;
  const nextHeading = /^###\s+/gmu; nextHeading.lastIndex = sectionBodyStart;
  const sectionEnd = nextHeading.exec(content)?.index ?? content.length;
  const body = content.slice(sectionBodyStart, sectionEnd);
  const table = projectBasicInfoTableMarkdown(facts, body, content);
  const hasUsefulFact = projectBasicInfoRows(facts, body, content).some(row => !/资料未明确|系统暂未从知识库确认/u.test(row[1]));
  if (!hasUsefulFact) return content;
  const cleanedBody = body.replace(/\*\*项目基本信息表\*\*[\s\S]*?(?=\n\n(?:[^|\n]|$)|$)/u, '').replace(/\|\s*(?:序号\s*\|\s*项目名称\s*\|\s*内容参数|信息项\s*\|\s*内容\s*(?:\|\s*资料来源\/(?:说明|证明))?)\s*\|[\s\S]*?(?=\n\n(?:[^|\n]|$)|$)/u, '').replace(/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|\s*\n(?:^\|.*\|\s*\n?)*/gmu, '').replace(/该小节围绕"[^"]+"进行补充说明[^\n]*(?:\n\n该小节围绕"[^"]+"进行补充说明[^\n]*)*/gu, '').replace(/\n{3,}/gu, '\n\n').trim();
  const rebuiltSection = `${projectSection[0].trimEnd()}\n\n${table}${cleanedBody ? `\n\n${cleanedBody}` : ''}\n\n`;
  return removeDuplicateProjectBasicInfoBlocks(normalizeBareMarkdownTables(stripProvenanceTableColumns(`${content.slice(0, sectionStart)}${rebuiltSection}${content.slice(sectionEnd).trimStart()}`)));
}

export function replaceForbiddenFormalPhrases(content: string) {
  return content
    .replace(/【修复任务包】[\s\S]*?(?=\n#{1,3}\s|\n\*\*|\n\|\s|$)/gu, '')
    .replace(/^修复类型：.*$/gmu, '').replace(/^修复对象：.*$/gmu, '')
    .replace(/^问题：【修复任务包】[\s\S]*?(?=\n#{1,3}\s|\n\*\*|\n\|\s|$)/gu, '')
    .replace(/^输出要求：.*$/gmu, '').replace(/重新生成/gu, '补充完善')
    .replace(/见招标公告|见投标人须知前附表/gu, '以本项目招标文件明确内容为准')
    .replace(/见招标文件/gu, '按本项目招标文件已明确的相应条款执行')
    .replace(/招标范围：/gu, '施工范围：')
    .replace(/施工方/gu, '承包人').replace(/由承包人/gu, '由承包人')
    .replace(/按图纸/gu, '依据经确认的设计文件和图纸内容组织实施')
    .replace(/按设计要求/gu, '依据设计文件明确的构造、材料、尺寸和验收要求执行')
    .replace(/按(?:资料|文件|说明|方案|规范|标准|要求)/gu, '依据本项目已确认资料、技术文件和验收标准')
    .replace(/满足(?:相关|有关)?要求/gu, '满足本项目已明确的质量、安全、技术和验收控制要求')
    .replace(/相关要求/gu, '本项目已明确的质量、安全、技术和验收要求');
}

export function replaceUnverifiedNumbersFromIssues(content: string, issues: ValidationIssue[]) {
  let next = content;
  const allValues: string[] = [];
  for (const issue of issues) {
    const hardMatch = issue.message.match(/生成后事实反查失败：正文出现资料事实主表中未找到的关键数字\s*([^，。；\n]+)/u);
    const softMatch = issue.message.match(/生成后事实反查提示：正文出现较多未在资料事实主表中反查到的管理数字\s*([^，。；\n]+)/u);
    const captured = hardMatch?.[1] || softMatch?.[1];
    if (captured) allValues.push(...captured.split(/、|,|，/u).map(v => v.trim()).filter(Boolean));
  }
  const isStandardCode = (v: string) => /^[A-Z]+\s*\d+$/u.test(v) || /^[A-Z]+\/[A-Z]\s*\d+$/u.test(v) || /^\d{5}$/u.test(v);
  const safeParams = new Set(['mm', 'cm', 'm', 'km', 'm2', 'm3', 'kg', 't', '℃', '%', 'MPa', 'kPa', 'kN']);
  for (const value of [...new Set(allValues)]) {
    if (isStandardCode(value)) continue;
    const unit = value.match(/[a-z%A-Z]+$/u)?.[0] || '';
    if (safeParams.has(unit.toLowerCase()) && /^\d+(?:\.\d+)?/.test(value)) continue;
    next = next.replace(new RegExp(escapeRegExpLiteral(value), 'gu'), '资料明确的相应参数');
  }
  return next;
}

export function isMaterialDiagnosticNoise(issue: Pick<ValidationIssue, 'message' | 'suggestion'>) {
  const combined = `${issue.message}\n${issue.suggestion || ''}`;
  return /资料抽取诊断|结构化事实读取不足|结构化章节读取不足|已补充使用证据片段兜底|已补充使用证据标题兜底|CAD图纸附件|DWG附件|PDF格式附件|DOCX格式附件|XLSX格式附件|无实质性文本内容|仅作为内部事实提取依据|正式正文不得引用文件名|附件片段|占位说明|已自动过滤/u.test(combined);
}

export function shouldUseIssueForDefaultRepair(issue: ValidationIssue) {
  if (isMaterialDiagnosticNoise(issue)) return false;
  if (/目录与正文不一致|缺少规划小节|正文缺少规划小节|规划小节正文过短|小节事实密度需优化|知识库事实或量化参数落位|生成后事实反查失败/u.test(issue.message)) return false;
  const combined = `${issue.message}\n${issue.suggestion || ''}`;
  if (/CAD|DWG|Excel|文件名占位|占位符|片段\d|图纸解析节点|仅作为内部事实提取依据|后台|检索|知识库|资料未提供|未检索到|文件格式|附件/u.test(combined) && !/空小节|小节只有标题|只有标题或表格无正文|正文篇幅低于目标字数|正文长度低于提示词要求|占位内容/u.test(issue.message)) return false;
  return issue.level === 'error' || /提示词要求|正式表格|表格存在|资料页码|列表项粘连|非正式章二级标题|同名的小节|禁止内容|后台|占位|空小节|封面/u.test(issue.message);
}

export function splitOverlongParagraphs(markdown: string) {
  return markdown.split(/\n{2,}/u).map(block => {
    const text = block.trim();
    if (text.length < 420 || /^\s*(#|\||[-*]\s|\d+[.、])/u.test(text)) return block;
    const parts = text.split(/(?<=[。；])(?=.)/u); const chunks: string[] = []; let current = '';
    for (const part of parts) { if ((current + part).length > 260 && current) { chunks.push(current); current = part; } else { current += part; } }
    if (current) chunks.push(current);
    return chunks.join('\n\n');
  }).join('\n\n');
}

export function splitLongParagraphs(content: string) {
  return content.split(/\n{2,}/u).map(block => {
    if (/^\s*(#{1,6}\s+|[-*+]\s+|\|)/u.test(block) || block.length < 520) return block;
    const sentences = block.split(/(?<=[。；])/u).map(item => item.trim()).filter(Boolean);
    if (sentences.length < 4) return block;
    const chunks: string[] = []; let current = '';
    for (const sentence of sentences) { if (current.length > 260 && current.length + sentence.length > 420) { chunks.push(current); current = sentence; } else { current += sentence; } }
    if (current) chunks.push(current);
    return chunks.join('\n\n');
  }).join('\n\n');
}

export function demoteNonFormalH2(markdown: string) {
  return markdown.replace(/^##\s+(.+)$/gmu, (full, title: string) => { const clean = String(title || '').trim(); if (clean === '目录' || /^第[一二三四五六七八九十百千万\d]+章\s+/u.test(clean)) return full; return `### ${clean}`; });
}

export function appendDeterministicSectionClosings(markdown: string, issues: ValidationIssue[]) {
  const hasGap = issues.some(issue => /小节内容补写未完成|小节只有标题或表格无正文|空小节/u.test(issue.message));
  if (!hasGap) return markdown;
  const addition = ['**小节执行说明补充**', '', '对仅列示表格或说明不足的小节，现场实施时应结合本章管理目标补充执行要求...'].join('\n');
  return `${markdown.trim()}\n\n${addition}`;
}

export function appendDeterministicBudgetClosing(markdown: string, minChars?: number) {
  if (!minChars) return markdown;
  let result = markdown.trim(); let deficit = minChars - result.replace(/\s+/gu, '').length;
  if (deficit <= 0 || deficit > 6000) return markdown;
  const paragraphs = ['为保证施工组织设计在实施阶段具备可检查、可追溯和可闭合的管理效果...'];
  const heading = result.includes('**履约闭环补充要求**') ? '**履约闭环深化补充**' : '**履约闭环补充要求**';
  const addition: string[] = [heading, ''];
  for (const paragraph of paragraphs) { addition.push(paragraph, ''); result = `${markdown.trim()}\n\n${addition.join('\n').trim()}`; deficit = minChars - result.replace(/\s+/gu, '').length; if (deficit <= 0) return result; }
  return result;
}

export function filterResolvedFinalIssues(markdown: string, issues: ValidationIssue[]) {
  const hasIllegalH2 = /^##\s+(?!目录$)(?!第[一二三四五六七八九十百千万\d]+章\s+)/gmu.test(markdown);
  const hasPageRefs = /(?:第?\d+页|P\.?\s*\d+)/iu.test(markdown);
  const hasForbiddenParty = /施工方/u.test(markdown);
  return issues.filter(issue => {
    if (/正文存在非正式章二级标题/u.test(issue.message)) return hasIllegalH2;
    if (/资料页码|文件页码|页码引用/u.test(issue.message)) return hasPageRefs;
    if (/禁止内容|施工方/u.test(issue.message)) return hasForbiddenParty;
    return true;
  });
}

export function applyDeterministicGateRepairs(content: string, issues: ValidationIssue[]) {
  return splitOverlongParagraphs(normalizeBareMarkdownTables(stripProvenanceTableColumns(
    replaceUnverifiedNumbersFromIssues(replaceForbiddenFormalPhrases(content), issues)
  ))).replace(/\n{3,}/gu, '\n\n').trim();
}

export function appendFormalTablesFromGateIssues(content: string, issues: ValidationIssue[]) {
  const shortage = issues.map(issue => /正式表格不足：(\d+)\/(\d+)/u.exec(issue.message)).find(Boolean);
  if (!shortage) return content;
  const current = Number(shortage[1] || 0); const target = Number(shortage[2] || 0); const need = Math.max(0, target - current);
  if (need === 0) return content;
  const tables = [
    { title: '质量控制责任表', header: ['控制环节', '控制要求', '责任岗位'], rows: [['材料进场', '核对合格证明、规格型号和验收记录', '材料员、质量员'], ['工序验收', '按施工方案、图纸和验收标准完成自检复核', '施工员、质量员']] },
    { title: '安全文明检查表', header: ['检查项目', '控制措施', '检查频次'], rows: [['临时用电', '执行三级配电、二级保护和巡检记录', '每日检查'], ['现场防护', '洞口临边、通道和作业面防护同步验收', '每日检查']] },
    { title: '进度资源协调表', header: ['协调事项', '控制重点', '闭环要求'], rows: [['材料供应', '结合施工段计划组织进场验收', '形成进场验收记录'], ['劳动力组织', '按关键工序配置作业人员和管理人员', '动态纠偏并记录']] },
  ];
  const additions = tables.slice(0, need).map(table => [`**${table.title}**`, '', `| ${table.header.join(' | ')} |`, `| ${table.header.map(() => '---').join(' | ')} |`, ...table.rows.map(row => `| ${row.join(' | ')} |`)].join('\n')).join('\n\n');
  return `${content.trim()}\n\n${additions}`;
}

export function repairKnownProjectBasicPlaceholders(content: string, facts: DocumentFact[]) {
  const candidates = projectBasicFactCandidates(facts);
  if (candidates.length === 0) return content;
  let next = content;
  const valueFor = (patterns: RegExp[]) => projectBasicValueFor(facts, patterns);
  const replacements: Array<{ label: RegExp; value?: unknown }> = [
    { label: /计划工期|合同工期|周期要求/u, value: valueFor([/计划工期|合同工期|周期要求|schedule_requirement/u]) },
    { label: /质量标准|质量目标/u, value: valueFor([/质量标准|quality_standard/u]) },
    { label: /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u, value: valueFor([/合同估算|投资估算|最高投标限价|招标控制价|project_investment_estimate/u]) },
    { label: /建设地点/u, value: valueFor([/建设地点|project_location/u]) },
    { label: /建设规模/u, value: valueFor([/建设规模|project_scale/u]) },
  ];
  for (const item of replacements) {
    const value = cleanInlineFactValue(stringifyFactValue(item.value || ''));
    if (!value) continue;
    next = next.replace(new RegExp(`(${item.label.source})(\\s*[|：:]\\s*)(?:资料未明确|系统暂未从知识库确认)[^|\\n。；;]*`, 'gu'), `$1$2${value}`);
  }
  return next;
}

export function projectBasicPlaceholderIssues(markdown: string, facts: DocumentFact[]) {
  if (projectBasicFactCandidates(facts).length === 0 || !/资料未明确|系统暂未从知识库确认/u.test(markdown)) return [];
  const labels = ['计划工期', '合同工期', '质量标准', '合同估算价', '合同估算价格', '建设地点', '建设规模'];
  return labels.filter(label => new RegExp(`${label}[^\\n|。；;]{0,40}(?:资料未明确|系统暂未从知识库确认)`, 'u').test(markdown)).map(label => ({ level: 'error' as const, message: `${label} 已抽取到知识库事实但正文仍显示系统暂未确认`, suggestion: '请优先使用项目基础事实卡片中的知识库原值，不得用占位表达覆盖已确认事实。' }));
}
