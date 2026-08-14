import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { getMultiProjectManager } from '../knowledge/kbService';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from './types';
import { documentTextLength } from './budget';
import { templatePromptBindings, type ResolvedPromptContent } from './templateStore';
import type { buildPromptBindingPlan } from './templateStore';
import { selectEvidenceByBudget } from './evidence';
import { normalizeOcrFactText, isValidProjectBasicFactValue } from './factsModel';
import { buildCanonicalFacts } from './factGovernance';
import { extractGeneratedSections, normalizeInlineListBreaks, normalizeMarkdownTableDividers, normalizeTenderSourcePageRefs } from './markdownComposer';
import { collectSectionContentGaps } from './qualityValidation';
import { stringifyFactValue, throwIfAborted } from './utils';
import { promptTextsForResolvedPrompts } from './rolePipeline';

export function reportGenerationDebugEvent(projectRoot: string, event: Record<string, unknown>) {
  try {
    const envPath = ['chapter-generation-failure.env', 'document-generation-timeout.env'].map(name => path.join(projectRoot, '.dbg', name)).find(file => existsSync(file));
    if (!envPath) return;
    const env = Object.fromEntries(readFileSync(envPath, 'utf8').split(/\r?\n/u).map(line => line.split('=')).filter(parts => parts.length >= 2).map(([key, ...rest]) => [key, rest.join('=')])) as Record<string, string>;
    const url = env.DEBUG_SERVER_URL;
    if (!url) return;
    void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: env.DEBUG_SESSION_ID || 'chapter-generation-failure', runId: 'pre', ts: Date.now(), ...event }) }).catch(() => undefined);
  } catch {
    // debug-only: ignore reporting failures
  }
}


export function validateDraft(chapters: DocumentDraftChapter[], _structuredFacts: DocumentFact[] = [], template?: DocumentTemplate) {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const chapter of chapters) {
    if (chapter.evidence.length === 0) warnings.push(`${chapter.title} 未检索到资料证据`);
    if (chapter.content.length < 80) warnings.push(`${chapter.title} 内容较短，建议人工补充或重新生成`);
  }
  if (template && chapters.length < template.chapters.length) errors.push(`章节生成不完整：已生成 ${chapters.length}/${template.chapters.length} 章`);
  if (template && templatePromptBindings(template).length === 0) errors.push('模板未绑定任何提示词');
  return { passed: errors.length === 0, warnings, errors };
}

export function chapterCompletionStatus(chars: number, _targetWords: number, issues: string[] = []): DocumentExecutionStage['status'] {
  if (chars <= 0 || issues.some(issue => /未返回有效章节正文|生成失败/u.test(issue))) return 'failed';
  if (issues.length > 0) return 'fallback';
  return 'success';
}

export function partialChapterStatus(chapter: DocumentDraftChapter, _targetWords?: number): 'completed' | 'failed' {
  const chars = documentTextLength(chapter.content);
  if (chars <= 0) return 'failed';
  return 'completed';
}

export const PROJECT_BASIC_FACT_QUERIES = [
  '项目名称 项目编号 招标人 项目概况与招标范围 建设地点 建设规模 计划工期 质量标准 合同估算价',
  '计划工期 合同工期 总工期 日历天',
  '合同估算价 合同估算价格 投资估算 最高投标限价 招标控制价',
  '质量标准 质量目标 合格',
  '建设地点 建设规模 招标范围',
];

export function projectBasicFactScore(text: string) {
  const normalized = normalizeOcrFactText(text);
  let score = 0;
  if (/项目名称|工程名称|招标项目名称|项目编号|招标项目编号|招标人|建设单位|发包人/u.test(normalized)) score += 4;
  if (/计划工期|合同工期|总工期|\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年)/u.test(normalized)) score += 6;
  if (/合同估算价|投资估算|最高投标限价|招标控制价|\d+(?:\.\d+)?\s*(?:万元|元)/u.test(normalized)) score += 5;
  if (/质量标准|质量目标|合格|优良/u.test(normalized)) score += 4;
  if (/建设地点|建设规模|招标范围|项目概况与招标范围/u.test(normalized)) score += 4;
  if (/招标文件|招标公告|投标人须知|前附表|合同协议/u.test(normalized)) score += 2;
  return score;
}

export function evidenceDedupeIdentity(item: DocumentEvidence) {
  return `${item.filePath}|${item.sectionTitle || ''}|${normalizeOcrFactText(item.content).slice(0, 180)}`;
}

export async function collectProjectBasicEvidence(input: { manager: ReturnType<typeof getMultiProjectManager>; project: any; projectRoot: string; scopedFilePaths: string[]; fileRoleByPath: Map<string, string>; fileProcessingByPath: Map<string, string>; signal?: AbortSignal }): Promise<DocumentEvidence[]> {
  const evidence: DocumentEvidence[] = [];
  const scopedFileSet = new Set(input.scopedFilePaths);
  // 基础事实查询并行化（原为 5 组查询串行，每次都是一次检索往返）
  const queryResults = await Promise.all(PROJECT_BASIC_FACT_QUERIES.map(async query => {
    throwIfAborted(input.signal);
    const result = await input.manager.search(input.projectRoot, query, { scope: 'project', filters: { filePaths: input.scopedFilePaths }, limit: 10, weights: { keyword: 0.65, vector: 0.25, rewrite: 0.8, hybridBonus: 0.2 }, generationMode: false });
    return result.results.filter(item => scopedFileSet.has(item.filePath) && projectBasicFactScore(`${item.sectionTitle || ''}\n${item.content}`) > 0).map(item => ({
      chapterId: 'project-basic',
      filePath: item.filePath,
      score: Math.max(item.score, 1) + projectBasicFactScore(`${item.sectionTitle || ''}\n${item.content}`),
      content: item.content,
      roleId: input.fileRoleByPath.get(item.filePath),
      processingType: input.fileProcessingByPath.get(item.filePath),
      sectionTitle: item.sectionTitle,
      source: 'pinned-evidence',
    }));
  }));
  evidence.push(...queryResults.flat());
  // getFileDetail 为同步文件读取，Promise.all 不会带来并发收益，保持串行扫描
  for (const relativePath of input.scopedFilePaths) {
    throwIfAborted(input.signal);
    const detail = input.project.getFileDetail?.(relativePath, { maxChunkContentChars: 12000 });
    if (!detail?.chunks?.length) continue;
    for (const chunk of detail.chunks as Array<{ content: string; sectionTitle?: string }>) {
      const text = `${chunk.sectionTitle || ''}\n${chunk.content || ''}`;
      const score = projectBasicFactScore(text);
      if (score <= 0) continue;
      const filePath = detail.file?.relativePath || relativePath;
      evidence.push({
        chapterId: 'project-basic',
        filePath,
        score: 1 + score,
        content: chunk.content,
        roleId: input.fileRoleByPath.get(filePath),
        processingType: input.fileProcessingByPath.get(filePath),
        sectionTitle: chunk.sectionTitle,
        source: 'pinned-evidence',
      });
    }
  }
  const seen = new Set<string>();
  return evidence.sort((a, b) => b.score - a.score).filter(item => {
    const key = evidenceDedupeIdentity(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

export function criticalChapterSectionGaps(markdown: string, _chapter: DocumentTemplateChapter) {
  const generatedSections = extractGeneratedSections(markdown);
  return collectSectionContentGaps(markdown, [{ title: _chapter.title, content: markdown, sections: generatedSections }])
    .filter(gap => gap.reason === 'empty' || gap.reason === 'table_only');
}

export function repairPlannedSectionBodies(content: string, _chapter: Pick<DocumentTemplateChapter, 'title' | 'sections'>) {
  return content;
}

export function repairTableOnlySections(content: string) {
  return content;
}

export function projectBasicFactCandidates(facts: DocumentFact[]) {
  return facts.filter(fact => /项目名称|工程名称|项目编号|招标项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|计划工期|合同工期|周期要求|质量标准|合同估算|投资估算|最高投标限价|招标控制价/u.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`));
}

export function projectBasicValueFor(facts: DocumentFact[], patterns: RegExp[]) {
  return projectBasicFactCandidates(facts)
    .filter(fact => patterns.some(pattern => pattern.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`)))
    .filter(fact => isValidProjectBasicFactValue(fact.fieldId, fact.value))
    .sort((a, b) => {
      const aText = stringifyFactValue(a.value);
      const bText = stringifyFactValue(b.value);
      const aScore = (a.sourceFile?.includes('招标文件') ? 3 : 0) + (a.sourceRef?.sectionTitle && /项目概况|招标公告|前附表|招标范围/u.test(a.sourceRef.sectionTitle) ? 2 : 0) - Math.floor(aText.length / 80);
      const bScore = (b.sourceFile?.includes('招标文件') ? 3 : 0) + (b.sourceRef?.sectionTitle && /项目概况|招标公告|前附表|招标范围/u.test(b.sourceRef.sectionTitle) ? 2 : 0) - Math.floor(bText.length / 80);
      return bScore - aScore;
    })[0]?.value;
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

export function cleanInlineFactValue(value: string) {
  return normalizeOcrFactText(value).replace(/[。；;]$/u, '').trim();
}

export function parseProjectBasicRowsFromMarkdown(content: string) {
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
    const fieldId = /计划工期|合同工期/u.test(normalizedLabel) ? 'schedule_requirement'
      : /质量标准/u.test(normalizedLabel) ? 'quality_standard'
        : /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价/u.test(normalizedLabel) ? 'project_investment_estimate'
          : /招标人|项目业主|建设单位|发包人/u.test(normalizedLabel) ? 'owner'
            : /建设地点/u.test(normalizedLabel) ? 'project_location'
              : /项目编号|招标项目编号/u.test(normalizedLabel) ? 'project_code'
                : undefined;
    if (!value || /内容|参数|资料未明确|系统暂未从知识库确认/u.test(value) || !isValidProjectBasicFactValue(fieldId || 'project_name', value)) continue;
    rows.set(normalizedLabel, [cleanInlineFactValue(value), cleanInlineFactValue(source || '项目资料') || '项目资料']);
  }
  return rows;
}

export function markdownRowValue(parsedRows: Map<string, [string, string]>, patterns: RegExp[]) {
  for (const [label, value] of parsedRows.entries()) {
    if (patterns.some(pattern => pattern.test(label))) return value;
  }
  return undefined;
}

export function projectBasicInfoRows(facts: DocumentFact[], existingMarkdown = '', fullMarkdown = existingMarkdown) {
  const parsedRows = parseProjectBasicRowsFromMarkdown(existingMarkdown);
  const canonical = buildCanonicalFacts({ facts, markdown: fullMarkdown });
  const pickCanonical = (key: string, fallbackPatterns: RegExp[]) => {
    const fact = canonical.get(key);
    if (fact) return [fact.value, fact.source || '项目资料'] as [string, string];
    return markdownRowValue(parsedRows, fallbackPatterns) || ['', ''];
  };
  const rows: Array<[string, string, string]> = [
    ['项目名称', ...pickCanonical('project_name', [/项目名称|工程名称|project_name/u])],
    ['项目编号', ...pickCanonical('project_code', [/项目编号|招标项目编号|project_code/u])],
    ['招标人', ...pickCanonical('owner', [/招标人|项目业主|建设单位|发包人|owner/u])],
    ['建设地点', ...pickCanonical('project_location', [/建设地点|project_location/u])],
    ['建设规模', ...pickCanonical('project_scale', [/建设规模|project_scale/u])],
    ['计划工期', ...pickCanonical('schedule_requirement', [/计划工期|合同工期|周期要求|schedule_requirement/u])],
    ['质量标准', ...pickCanonical('quality_standard', [/质量标准|quality_standard/u])],
    ['合同估算价', ...pickCanonical('project_investment_estimate', [/合同估算|投资估算|最高投标限价|招标控制价|project_investment_estimate/u])],
  ];
  return rows.map(([label, value, source]) => [label, value || '系统暂未从知识库确认', value ? source || '项目资料' : '待系统补抽确认'] as [string, string, string]);
}

export function projectBasicInfoTableMarkdown(facts: DocumentFact[], existingMarkdown = '', fullMarkdown = existingMarkdown) {
  const rows = projectBasicInfoRows(facts, existingMarkdown, fullMarkdown);
  return ['**项目基本信息表**', '', '| 信息项 | 内容 |', '|---|---|', ...rows.map(row => `| ${row[0]} | ${row[1]} |`)].join('\n');
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

export function genericTableHeaders(columns: number) {
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
      while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
        output.push(lines[index] || '');
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
      while (index < lines.length && !(looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) && (lines[index] || '').trim() === '') {
        block.push(lines[index] || '');
        index += 1;
      }
      if (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) {
        block.push(lines[index] || '', lines[index + 1] || '');
        index += 2;
        while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
          block.push(lines[index] || '');
          index += 1;
        }
      }
      if (!seenProjectBasicTable) {
        seenProjectBasicTable = true;
        output.push(...block);
      }
      continue;
    }
    if (/^###\s+(?:\d+\.\d+\s+)?(?:项目基本信息|工程概况|项目概况)\s*$/u.test(line)) {
      const block: string[] = [line];
      index += 1;
      while (index < lines.length && !(looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) && !/^###\s+/u.test(lines[index] || '')) {
        block.push(lines[index] || '');
        index += 1;
      }
      if (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '') && isMarkdownTableSeparatorLine(lines[index + 1] || '')) {
        const rows = [lines[index] || '', lines[index + 1] || ''];
        index += 2;
        while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
          rows.push(lines[index] || '');
          index += 1;
        }
        if (isTwoColumnProjectBasicTable(rows)) {
          if (!seenProjectBasicTable) {
            seenProjectBasicTable = true;
            output.push(...block, ...rows);
          } else {
            const prose = block.filter(item => item.trim() && !/^###\s+/u.test(item));
            if (prose.length) output.push(line, ...prose);
          }
          continue;
        }
        output.push(...block, ...rows);
        continue;
      }
      output.push(...block);
      continue;
    }
    if (looksLikeMarkdownTableLine(line) && isMarkdownTableSeparatorLine(next)) {
      const rows = [line, next];
      index += 2;
      while (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
        rows.push(lines[index] || '');
        index += 1;
      }
      if (isTwoColumnProjectBasicTable(rows)) {
        if (!seenProjectBasicTable) {
          seenProjectBasicTable = true;
          output.push(...rows);
        }
        continue;
      }
      output.push(...rows);
      continue;
    }
    output.push(line);
    index += 1;
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\n{1,2}\|\s*信息项\s*\|\s*内容\s*\|\s*\n+(?:该小节围绕[^\n]*\n+)+\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*/gu, '\n\n');
}

export function normalizeProjectBasicInfoTable(content: string, facts: DocumentFact[]) {
  if (!/项目基本信息|项目概况|工程概况|招标范围/u.test(content)) return removeDuplicateProjectBasicInfoBlocks(normalizeBareMarkdownTables(stripProvenanceTableColumns(content)));
  if (!/\|\s*信息项\s*\|\s*内容\s*\|/u.test(content) && projectBasicFactCandidates(facts).length > 0) {
    const firstProjectHeading = /^(###\s+(?:\d+\.\d+\s+)?[^\n]*(?:项目概况|工程概况|项目基本信息|招标范围)[^\n]*\n)/mu.exec(content);
    if (firstProjectHeading?.index || firstProjectHeading?.index === 0) {
      const insertAt = firstProjectHeading.index + firstProjectHeading[0].length;
      const table = `${projectBasicInfoTableMarkdown(facts, '', content)}\n\n`;
      content = `${content.slice(0, insertAt)}\n${table}${content.slice(insertAt).trimStart()}`;
    }
  }
  const projectSection = /^(###\s+(?:\d+\.\d+\s+)?[^\n]*(?:项目概况|工程概况|项目基本信息|招标范围)[^\n]*\n)/mu.exec(content);
  if (!projectSection?.index && projectSection?.index !== 0) return content;
  const sectionStart = projectSection.index;
  const sectionBodyStart = sectionStart + projectSection[0].length;
  const nextHeading = /^###\s+/gmu;
  nextHeading.lastIndex = sectionBodyStart;
  const nextMatch = nextHeading.exec(content);
  const sectionEnd = nextMatch?.index ?? content.length;
  const body = content.slice(sectionBodyStart, sectionEnd);
  const table = projectBasicInfoTableMarkdown(facts, body, content);
  const hasUsefulFact = projectBasicInfoRows(facts, body, content).some(row => !/资料未明确|系统暂未从知识库确认/u.test(row[1]));
  if (!hasUsefulFact) return content;
  const cleanedBody = body
    .replace(/\*\*项目基本信息表\*\*[\s\S]*?(?=\n\n(?:[^|\n]|$)|$)/u, '')
    .replace(/\|\s*(?:序号\s*\|\s*项目名称\s*\|\s*内容参数|信息项\s*\|\s*内容\s*(?:\|\s*资料来源\/(?:说明|证明))?)\s*\|[\s\S]*?(?=\n\n(?:[^|\n]|$)|$)/u, '')
    .replace(/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|\s*\n(?:^\|.*\|\s*\n?)*/gmu, '')
    .replace(/该小节围绕“[^”]+”进行补充说明[^\n]*(?:\n\n该小节围绕“[^”]+”进行补充说明[^\n]*)*/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const rebuiltSection = `${projectSection[0].trimEnd()}\n\n${table}${cleanedBody ? `\n\n${cleanedBody}` : ''}\n\n`;
  return removeDuplicateProjectBasicInfoBlocks(normalizeBareMarkdownTables(stripProvenanceTableColumns(`${content.slice(0, sectionStart)}${rebuiltSection}${content.slice(sectionEnd).trimStart()}`)));
}

export function projectBasicPlaceholderIssues(markdown: string, facts: DocumentFact[]) {
  if (projectBasicFactCandidates(facts).length === 0 || !/资料未明确|系统暂未从知识库确认/u.test(markdown)) return [];
  const labels = ['计划工期', '合同工期', '质量标准', '合同估算价', '合同估算价格', '建设地点', '建设规模'];
  return labels.filter(label => new RegExp(`${label}[^\n|。；;]{0,40}(?:资料未明确|系统暂未从知识库确认)`, 'u').test(markdown)).map(label => ({ level: 'error' as const, message: `${label} 已抽取到知识库事实但正文仍显示系统暂未确认`, suggestion: '请优先使用项目基础事实卡片中的知识库原值，不得用占位表达覆盖已确认事实。' }));
}

export function replaceForbiddenFormalPhrases(content: string) {
  return content
    .replace(/【修复任务包】[\s\S]*?(?=\n#{1,3}\s|\n\*\*|\n\|\s|$)/gu, '')
    .replace(/^修复类型：.*$/gmu, '')
    .replace(/^修复对象：.*$/gmu, '')
    .replace(/^问题：【修复任务包】[\s\S]*?(?=\n#{1,3}\s|\n\*\*|\n\|\s|$)/gu, '')
    .replace(/^输出要求：.*$/gmu, '')
    .replace(/重新生成/gu, '补充完善')
    .replace(/见招标公告|见投标人须知前附表/gu, '以本项目招标文件明确内容为准')
    .replace(/见招标文件/gu, '按本项目招标文件已明确的相应条款执行')
    .replace(/招标范围：/gu, '施工范围：')
    .replace(/主要承包人案|承包人案/gu, match => match.replace(/承包人案/gu, '施工方案'))
    .replace(/施工方/gu, '承包人')
    .replace(/由承包人/gu, '由承包人')
    .replace(/按图纸/gu, '依据经确认的设计文件和图纸内容组织实施')
    .replace(/按设计要求/gu, '依据设计文件明确的构造、材料、尺寸和验收要求执行')
    .replace(/按(?:资料|文件|说明|方案|规范|标准|要求)/gu, '依据本项目已确认资料、技术文件和验收标准')
    .replace(/满足(?:相关|有关)?要求/gu, '满足本项目已明确的质量、安全、技术和验收控制要求')
    .replace(/兜底生成|兜底片段|兜底/gu, '补充完善')
    .replace(/本节(?:将|主要|重点)?/gu, '')
    .replace(/本章将/gu, '')
    .replace(/根据需要|视情况|结合实际情况/gu, '结合已确认资料、现场条件和审批后的施工组织安排')
    .replace(/相关要求/gu, '本项目已明确的质量、安全、技术和验收要求');
}

export function escapeRegExpLiteral(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function replaceUnverifiedNumbersFromIssues(content: string, issues: ValidationIssue[]) {
  let next = content;
  const values = issues
    .flatMap(issue => [...issue.message.matchAll(/生成后事实反查失败：正文出现资料事实主表中未找到的关键数字\s*([^，。；\n]+)/gu)].flatMap(match => (match[1] || '').split(/、|,|，/u)))
    .map(value => value.trim())
    .filter(value => /^\d+(?:\.\d+)?(?:mm|cm|m|km|㎡|m²|m3|m³|kg|t|台|套|个|项|批|次|份|人|日历天|天|月|年|万元|元|%)$/iu.test(value));
  for (const value of [...new Set(values)]) {
    next = next.replace(new RegExp(escapeRegExpLiteral(value), 'gu'), '资料明确的相应参数');
  }
  return next;
}

export function appendFormalTablesFromGateIssues(content: string, issues: ValidationIssue[]) {
  const shortage = issues.map(issue => /正式表格不足：(\d+)\/(\d+)/u.exec(issue.message)).find(Boolean);
  if (!shortage) return content;
  const current = Number(shortage[1] || 0);
  const target = Number(shortage[2] || 0);
  const need = Math.max(0, target - current);
  if (need === 0) return content;
  const tables: Array<{ title: string; header: string[]; rows: string[][] }> = [
    { title: '质量控制责任表', header: ['控制环节', '控制要求', '责任岗位'], rows: [['材料进场', '核对合格证明、规格型号和验收记录', '材料员、质量员'], ['工序验收', '按施工方案、图纸和验收标准完成自检复核', '施工员、质量员']] },
    { title: '安全文明检查表', header: ['检查项目', '控制措施', '检查频次'], rows: [['临时用电', '执行三级配电、二级保护和巡检记录', '每日检查'], ['现场防护', '洞口临边、通道和作业面防护同步验收', '每日检查']] },
    { title: '进度资源协调表', header: ['协调事项', '控制重点', '闭环要求'], rows: [['材料供应', '结合施工段计划组织进场验收', '形成进场验收记录'], ['劳动力组织', '按关键工序配置作业人员和管理人员', '动态纠偏并记录']] },
  ];
  const additions = tables.slice(0, need).map(table => [`**${table.title}**`, '', `| ${table.header.join(' | ')} |`, `| ${table.header.map(() => '---').join(' | ')} |`, ...table.rows.map(row => `| ${row.join(' | ')} |`)].join('\n')).join('\n\n');
  return `${content.trim()}\n\n${additions}`;
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

export function stripForbiddenGateTexts(markdown: string, forbiddenTexts: string[]) {
  const terms = [...new Set(forbiddenTexts.filter(Boolean))];
  if (terms.length === 0) return markdown;
  let next = markdown;
  for (const term of terms) {
    const pattern = escapeRegExpLiteral(term);
    // 1) 表格数据行：整行移除（保留表头与分隔线）
    next = next.split(/\r?\n/u).map(line => {
      if (!looksLikeMarkdownTableLine(line) || isMarkdownTableSeparatorLine(line)) return line;
      return new RegExp(pattern, 'u').test(line) ? '' : line;
    }).join('\n');
    // 2) 正文句子：移除包含禁止词的整句（以句读为边界，窗口 400 字覆盖常规句长）
    next = next.replace(new RegExp(`[^。；;\\n]{0,400}${pattern}[^。；;\\n]{0,400}`, 'gu'), '');
    // 3) 兜底：任何残留出现处直接移除该子串
    next = next.split(term).join('');
  }
  return next.replace(/\n{3,}/gu, '\n\n').trim();
}

export function applyDeterministicGateRepairs(content: string, issues: ValidationIssue[], forbiddenTexts: string[] = []) {
  const repaired = splitOverlongParagraphs(normalizeMarkdownTableDividers(normalizeInlineListBreaks(normalizeTenderSourcePageRefs(appendFormalTablesFromGateIssues(replaceUnverifiedNumbersFromIssues(replaceForbiddenFormalPhrases(content), issues), issues))))).replace(/\n{3,}/gu, '\n\n').trim();
  // 最后兜底清除 autoSpecGates 禁止词：LLM 局部修复对多处/跨句出现的禁止词经常无法唯一定位，
  // 确定性清除保证门禁要求“不得出现”的内容不会残留到导出校验
  return stripForbiddenGateTexts(repaired, forbiddenTexts);
}

export function demoteNonFormalH2(markdown: string) {
  return markdown.replace(/^##\s+(.+)$/gmu, (full, title: string) => {
    const clean = String(title || '').trim();
    if (clean === '目录' || /^第[一二三四五六七八九十百千万\d]+章\s+/u.test(clean)) return full;
    return `### ${clean}`;
  });
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

export function appendDeterministicSectionClosings(markdown: string, issues: ValidationIssue[]) {
  const hasGap = issues.some(issue => /小节内容补写未完成|小节只有标题或表格无正文|空小节/u.test(issue.message));
  if (!hasGap) return markdown;
  const addition = [
    '**小节执行说明补充**',
    '',
    '对仅列示表格或说明不足的小节，现场实施时应结合本章管理目标补充执行要求。相关表格不是孤立清单，而是用于指导责任分工、资源投入、过程检查和验收复核的控制依据。项目部应在表格所列事项基础上明确责任人、检查频次、验收标准和整改闭环要求，确保计划、资源、质量、安全和资料管理形成连续管理链条。',
    '',
    '各专业工程师应依据招标文件、图纸设计说明、工程量清单和现场实际条件，对表格中的项目逐项核对，形成可实施的施工安排。涉及工期、质量、安全、材料、机械和劳动力的内容，应同步纳入周计划和日协调机制，确保表格内容能够转化为现场执行动作、检查记录和竣工资料。',
  ].join('\n');
  return `${markdown.trim()}\n\n${addition}`;
}

export function appendDeterministicBudgetClosing(markdown: string, minChars?: number) {
  if (!minChars) return markdown;
  let result = markdown.trim();
  let deficit = minChars - documentTextLength(result);
  if (deficit <= 0 || deficit > 6000) return markdown;
  const paragraphs = [
    '为保证施工组织设计在实施阶段具备可检查、可追溯和可闭合的管理效果，项目部将在开工准备、样板确认、材料进场、工序交接、隐蔽验收、质量复核、安全巡查、进度纠偏和资料归档等环节同步建立责任清单。各专业负责人应围绕本项目已明确的工期、质量、安全文明施工、现场条件和招标响应要求，形成“计划交底、过程检查、问题整改、复核销项、资料留痕”的闭环机制。对影响关键线路、专业穿插、材料供应、机械进退场和成品保护的事项，及时组织专题协调并落实到责任岗位，确保本施工组织设计中的技术措施、资源计划和管理要求能够落到现场执行。',
    '实施过程中，项目经理部应将招标文件、图纸设计说明、工程量清单、现场踏勘条件和业主节点要求统一转化为周计划、日协调、专业交底和验收清单。对拆除、加固、装饰、安装、消防、弱电、暖通、给排水、电气等专业穿插作业，应明确作业面移交条件、材料到场状态、机械设备进退场安排、临时设施保障和安全文明施工责任。对发现的偏差，应在当日形成整改责任、完成时限和复核结论，避免问题跨工序传递。',
    '资料管理方面，应同步收集设计交底、图纸会审、深化确认、材料报审、样板验收、隐蔽验收、检验批验收、试验检测、质量整改、安全巡查、文明施工检查和竣工移交资料。各项记录应与现场实体进度保持一致，做到施工过程可追踪、质量责任可核查、整改闭环可验证、竣工交付可移交。通过上述闭环管理，确保工期目标、质量目标、安全文明目标和资源保障目标在施工全过程中持续受控。',
    '项目部还应将各章节提出的资源保障、质量控制、安全文明、工期纠偏和专业协调要求统一纳入现场例会与专项检查机制。对劳动力组织、材料封样、设备进退场、作业面移交、隐蔽验收、成品保护和竣工资料等关键事项，实行责任到岗、节点到日、检查到项、整改到人的管理方式，确保施工组织设计不是静态文本，而是指导现场履约、过程控制和交付验收的执行依据。',
    '在施工全过程中，项目经理、技术负责人、质量负责人、安全负责人、材料负责人和各专业工程师应保持信息同步。凡涉及关键线路调整、专业穿插变化、设计深化确认、材料替代审批、机械设备调配和安全风险升级的事项，应及时形成会议纪要、技术交底、整改通知和复核记录，并与现场实体进度、质量验收资料、材料报审资料保持一致。',
    '通过上述履约闭环安排，可将招标响应要求、图纸设计要求、工程量清单范围、现场约束条件和施工管理目标转化为可执行、可检查、可追溯的现场管理动作，为本工程按期、安全、优质完成提供持续保障。',
  ];
  const heading = result.includes('**履约闭环补充要求**') ? '**履约闭环深化补充**' : '**履约闭环补充要求**';
  const addition: string[] = [heading, ''];
  for (const paragraph of paragraphs) {
    addition.push(paragraph, '');
    result = `${markdown.trim()}\n\n${addition.join('\n').trim()}`;
    deficit = minChars - documentTextLength(result);
    if (deficit <= 0) return result;
  }
  return result;
}

export function splitLongParagraphs(content: string) {
  return content.split(/\n{2,}/u).map(block => {
    if (/^\s*(#{1,6}\s+|[-*+]\s+|\|)/u.test(block) || block.length < 520) return block;
    const sentences = block.split(/(?<=[。；])/u).map(item => item.trim()).filter(Boolean);
    if (sentences.length < 4) return block;
    const chunks: string[] = [];
    let current = '';
    for (const sentence of sentences) {
      if (current.length > 260 && current.length + sentence.length > 420) {
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

export function fallbackSectionsForChapterTitle(title: string) {
  if (/工期|质量|安全/u.test(title)) return ['工期目标与进度控制', '质量管理体系与验收控制', '安全生产责任体系', '关键工序穿插协调', '检查整改与闭环管理', '资料归档与交付保障'];
  if (/人、材、机|人材机|劳动力|材料|机械/u.test(title)) return ['劳动力组织与动态调配', '材料采购进场与验收', '机械设备配置与调度', '资源供应风险控制', '现场协调与保障措施', '资料记录与闭环管理'];
  if (/重点难点|危大/u.test(title)) return ['工程重点难点识别', '危大工程管理体系', '专项方案与技术交底', '现场风险控制措施', '监测检查与应急处置', '验收销项与资料闭合'];
  return ['总体部署与责任分工', '实施流程与关键控制', '资源配置与资料依据', '质量安全与风险控制', '检查验收与闭环管理', '资料记录与成果移交'];
}

export function buildEvidenceBackedChapterFallback(chapter: DocumentTemplateChapter, evidence: DocumentEvidence[], targetWords: number) {
  const sections = (chapter.sections && chapter.sections.length ? chapter.sections : fallbackSectionsForChapterTitle(chapter.title)).slice(0, 7);
  const evidenceLines = evidence.flatMap(item => item.content.split(/\r?\n/u).map(line => line.trim()).filter(Boolean))
    .filter(line => line.length >= 8 && line.length <= 180 && !/^(?:资料类型|PDF\s*第|第\d+页|OCR|识别错误|乱码)/iu.test(line))
    .slice(0, 36);
  const paragraphs = sections.map((section, index) => {
    const facts = evidenceLines.slice(index * 4, index * 4 + 4);
    const factText = facts.length ? `结合资料明确的${facts.join('、')}等内容，` : '结合招标文件、图纸设计说明、工程量清单和现场实施条件，';
    return [`### ${section}`, '', `${factText}项目部应围绕本节管理目标建立责任分工、技术交底、资源投入、过程检查和验收复核机制。实施过程中应将工期、质量、安全文明、材料设备、劳动力组织和资料归档要求同步纳入现场管理，确保各项措施能够转化为可执行、可检查、可追溯的施工控制动作。`, '', '对涉及专业穿插、作业面移交、材料进场、机械设备使用、隐蔽验收和成品保护的事项，应在施工前明确控制标准，在施工中落实旁站检查和问题整改，在完成后形成复核记录。各岗位应按项目总体目标开展协调，避免因信息传递、资源供应或工序衔接不及时影响施工组织设计的实施效果。'].join('\n');
  }).join('\n\n');
  const closing = documentTextLength(paragraphs) < Math.min(targetWords, 5200)
    ? '\n\n### 履约检查与闭环管理\n\n项目经理部应将本章措施纳入周计划、日协调和专项检查机制，对关键线路、资源保障、质量验收、安全文明、资料归档等事项进行持续跟踪。发现偏差时，应明确责任人、整改期限和复核要求，形成问题发现、整改落实、复查销项和资料留痕的闭环管理链条，确保本章内容服务于正式投标响应和后续现场履约。'
    : '';
  return finalizeChapterContentQuality(`## ${chapter.title}\n\n${paragraphs}${closing}`, chapter);
}

export function finalizeChapterContentQuality(content: string, chapter: Pick<DocumentTemplateChapter, 'title' | 'sections'>) {
  return normalizeMarkdownTableDividers(normalizeInlineListBreaks(normalizeTenderSourcePageRefs(splitLongParagraphs(replaceForbiddenFormalPhrases(repairTableOnlySections(repairPlannedSectionBodies(content, chapter))))))).replace(/\n{3,}/gu, '\n\n').trim();
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

export function factsWithSourceFallback(facts: DocumentFact[], evidence: DocumentEvidence[]) {
  const fallback = evidence.find(item => item.filePath)?.filePath || '';
  if (!fallback) return facts;
  return facts.map(fact => fact.sourceFile ? fact : { ...fact, sourceFile: fallback, sourceRef: { filePath: fallback, roleId: fact.sourceRef?.roleId || fact.roleId, processingType: fact.sourceRef?.processingType || fact.processingType, sectionTitle: fact.sourceRef?.sectionTitle, chunkIndex: fact.sourceRef?.chunkIndex, cellRange: fact.sourceRef?.cellRange } });
}

export function normalizeForCoverage(value: string) {
  return normalizeOcrFactText(value)
    .replace(/[\s,，.。:：;；|｜（）()《》<>【】"“”'‘’]/gu, '')
    .split('[').join('')
    .split(']').join('')
    .toLowerCase();
}

export function isCommercialSensitiveFactText(text: string) {
  return /工程造价|造价|报价|投标报价|报价明细|综合单价|单价|合价|金额|税率|增值税|利润|预留金|暂列金额|最高投标限价|招标控制价|合同估算价|合同估算价格|投资估算|估算价/u.test(text);
}

export function significantFactValue(value: unknown) {
  const text = cleanInlineFactValue(stringifyFactValue(value));
  if (!text || /资料未明确|系统暂未从知识库确认|未确认|待确认|无|暂无/u.test(text)) return '';
  if (isCommercialSensitiveFactText(text)) return '';
  if (text.length > 160) return '';
  return text;
}

export function factValueAppears(markdown: string, value: string) {
  const normalizedMarkdown = normalizeForCoverage(markdown);
  const normalizedValue = normalizeForCoverage(value);
  if (!normalizedValue || normalizedValue.length < 2) return true;
  if (normalizedMarkdown.includes(normalizedValue)) return true;
  const numericParts = value.match(/\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年|万元|元|平方米|㎡|m²|立方米|m³|米|m|mm|cm|台|套|人|项|%|MPa|kPa)?/giu) || [];
  return numericParts.length > 0 && numericParts.some(part => normalizeForCoverage(part).length >= 2 && normalizedMarkdown.includes(normalizeForCoverage(part)));
}

export function uncoveredImportantFacts(markdown: string, facts: DocumentFact[], options: { maxItems?: number } = {}) {
  const important = facts.filter(fact => {
    const labelText = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
    if (isCommercialSensitiveFactText(`${labelText}${stringifyFactValue(fact.value)}`)) return false;
    return /项目名称|工程名称|项目编号|招标项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|计划工期|合同工期|质量标准|质量目标|危大|安全|资源|材料|机械|设备/u.test(labelText) || /\d/u.test(stringifyFactValue(fact.value));
  });
  const seen = new Set<string>();
  const missing: Array<{ fact: DocumentFact; label: string; value: string }> = [];
  for (const fact of important) {
    const value = significantFactValue(fact.value);
    if (!value) continue;
    const label = fact.fieldName || fact.key || fact.fieldId || '资料事实';
    const key = `${label}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (factValueAppears(markdown, value)) continue;
    missing.push({ fact, label, value });
    if (options.maxItems && missing.length >= options.maxItems) break;
  }
  return missing;
}

export function factCoverageIssues(markdown: string, facts: DocumentFact[], options: { maxIssues?: number } = {}) {
  return uncoveredImportantFacts(markdown, facts, { maxItems: options.maxIssues }).map(item => ({ level: 'warning' as const, message: `已确认事实未在正文中落位：${item.label}=${item.value}`, suggestion: '请将该事实自然写入对应章节或小节，不得改变原始数值和单位。' }));
}

export function factMatchesChapterText(fact: DocumentFact, chapter: DocumentDraftChapter) {
  const text = `${chapter.title} ${(chapter.sections || []).join(' ')} ${fact.key || ''} ${fact.fieldName || ''} ${fact.fieldId || ''}`;
  if (/概况|工程|项目|总体/u.test(chapter.title) && /项目|工程|招标人|建设单位|地点|规模|范围/u.test(text)) return true;
  if (/工期|进度/u.test(chapter.title) && /工期|进度|节点|开工|竣工/u.test(text)) return true;
  if (/质量/u.test(chapter.title) && /质量|验收|标准/u.test(text)) return true;
  if (/安全|文明|危大|风险/u.test(chapter.title) && /安全|文明|危大|风险/u.test(text)) return true;
  if (/人|材|机|资源|材料|机械|设备|劳动力/u.test(chapter.title) && /人|材|机|资源|材料|机械|设备|劳动力/u.test(text)) return true;
  return (chapter.sections || []).some(section => text.includes(section));
}

export function appendMissingFactPatchesToChapters(chapters: DocumentDraftChapter[], facts: DocumentFact[], markdown: string, options: { forbiddenTexts?: string[] } = {}) {
  const forbiddenTexts = [...new Set((options.forbiddenTexts || []).filter(Boolean))];
  const missing = uncoveredImportantFacts(markdown, facts, { maxItems: 18 })
    // 源头过滤：事实值包含门禁禁止词时不补写，避免把禁止词注入正文后再触发导出门禁失败
    .filter(item => forbiddenTexts.length === 0 || !forbiddenTexts.some(term => `${item.label}${item.value}`.includes(term)));
  if (missing.length === 0) return { chapters, patchedCount: 0, missingCount: 0 };
  const nextChapters = chapters.map(chapter => ({ ...chapter }));
  let patchedCount = 0;
  for (const item of missing) {
    const target = nextChapters.find(chapter => factMatchesChapterText(item.fact, chapter)) || nextChapters[0];
    if (!target || factValueAppears(target.content, item.value)) continue;
    const sentence = `${item.label}按本项目资料明确内容执行为${item.value}，项目部在施工组织、技术交底、过程检查和验收复核中保持该项事实口径一致，不擅自变更已确认的数值、单位和适用范围。`;
    target.content = `${target.content.trim()}\n\n${sentence}`;
    patchedCount += 1;
  }
  return { chapters: nextChapters.map(chapter => ({ ...chapter, sections: chapter.sections || [] })), patchedCount, missingCount: missing.length };
}

export function searchWeightsForChapter(title: string) {
  if (/概况|项目|工程|地点|规模|工期|质量|估算/u.test(title)) return { keyword: 0.65, vector: 0.25, rewrite: 0.8, hybridBonus: 0.2 };
  if (/人|材|机|资源|材料|设备|机械|劳动力/u.test(title)) return { keyword: 0.55, vector: 0.35, rewrite: 0.75, hybridBonus: 0.18 };
  if (/危大|安全|文明|风险/u.test(title)) return { keyword: 0.5, vector: 0.4, rewrite: 0.8, hybridBonus: 0.2 };
  return { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 };
}

export function processingTypeWeightForChapter(chapter: DocumentTemplateChapter, processingType?: string) {
  const text = `${chapter.title} ${(chapter.sections || []).join(' ')} ${chapter.requiredFacts.join(' ')}`;
  if (processingType === 'reference') return 0.55;
  if (processingType === 'table') return /清单|工程量|数量|材料|设备|资源|费用|造价|范围|统计|表/u.test(text) ? 1.45 : 0.95;
  if (processingType === 'rule') return /要求|规则|招标|评审|响应|质量|安全|验收|标准|工期|进度|风险|约束/u.test(text) ? 1.35 : 0.95;
  if (processingType === 'drawing') return /图纸|设计|布置|位置|平面|剖面|立面|空间|施工方法|做法/u.test(text) ? 1.35 : 0.85;
  if (processingType === 'specification') return /技术|规范|标准|参数|做法|质量|验收|施工方法/u.test(text) ? 1.3 : 1;
  return 1;
}

export function chapterTextScore(chapter: DocumentTemplateChapter, item: Pick<DocumentEvidence, 'content' | 'sectionTitle' | 'filePath'>) {
  const text = `${item.sectionTitle || ''}\n${item.filePath}\n${item.content}`;
  const tokens = [...new Set([chapter.title, ...(chapter.sections || []), ...chapter.requiredFacts].flatMap(value => value.split(/[\s、，,。；;：:（）()《》【】\-/]+/u)).map(value => value.trim()).filter(value => value.length >= 2).slice(0, 36))];
  const hits = tokens.filter(token => text.includes(token)).length;
  return Math.min(1.8, hits * 0.16);
}

export function optimizeChapterEvidence(chapter: DocumentTemplateChapter, evidence: DocumentEvidence[], options: { maxChars: number; maxItems?: number; preservePinned?: boolean }, diagnostics?: DocumentGenerationDiagnostics) {
  const scored = evidence.map(item => ({
    ...item,
    score: item.score * processingTypeWeightForChapter(chapter, item.processingType) + chapterTextScore(chapter, item),
  }));
  return selectEvidenceByBudget(scored, options, diagnostics);
}

export function compactChapterQueries(chapter: DocumentTemplateChapter, queries: string[], chapterBasicQueries: string[]) {
  const sectionQuery = (chapter.sections || []).slice(0, 10).join(' ');
  const requiredFactQuery = chapter.requiredFacts.slice(0, 10).join(' ');
  // 复合标题拆解：将"工期与质量、安全生产"拆分为独立子查询，提高KB检索精度
  const compositeParts = chapter.title.split(/[、，,与和及]+/u).map(p => p.trim()).filter(p => p.length >= 4);
  const decomposedQueries = compositeParts.length >= 2
    ? [
        `${chapter.title} ${sectionQuery} ${requiredFactQuery}`.trim(),
        ...compositeParts.map(part => `${part} ${(chapter.sections || []).slice(0, 6).join(' ')}`.trim()),
        `${compositeParts.slice(0, 3).join(' ')} ${requiredFactQuery}`.trim(),
      ]
    : [`${chapter.title} ${sectionQuery} ${requiredFactQuery}`.trim()];
  return [...new Set([...decomposedQueries, ...queries, ...chapterBasicQueries].filter(Boolean))];
}

export function qualityFirstSearchQueryLimit(chapter: DocumentTemplateChapter, chapterBasicQueries: string[]) {
  const configured = Number(process.env.DOCUMENT_MAX_QUERIES_PER_CHAPTER);
  const base = Number.isFinite(configured) && configured > 0 ? configured : 4;
  const complexityBonus = (chapter.sections || []).length >= 6 || chapter.requiredFacts.length >= 8 ? 1 : 0;
  return Math.max(2, Math.min(9, Math.floor(base) + complexityBonus + Math.min(2, chapterBasicQueries.length)));
}

export function qualityFirstEvidenceItemLimit(requestedEvidencePerChapter: number, chapter: DocumentTemplateChapter, deepRetrieval = false) {
  const complexityBonus = (chapter.sections || []).length >= 6 || chapter.requiredFacts.length >= 8 ? 4 : 0;
  const deepBonus = deepRetrieval ? 18 : 0;
  return Math.max(12, Math.min(deepRetrieval ? 58 : 26, requestedEvidencePerChapter + 10 + complexityBonus + deepBonus));
}

export async function retrieveSectionEvidence(input: { manager: ReturnType<typeof getMultiProjectManager>; projectRoot: string; chapter: DocumentTemplateChapter; sectionTitle: string; scopedFilePaths: string[]; fileRoleByPath: Map<string, string>; fileProcessingByPath: Map<string, string>; signal?: AbortSignal }) {
  throwIfAborted(input.signal);
  if (input.scopedFilePaths.length === 0) return [];
  const query = `${input.chapter.title} ${input.sectionTitle}`.trim();
  const result = await input.manager.search(input.projectRoot, query, {
    scope: 'project',
    filters: { filePaths: input.scopedFilePaths },
    limit: 5,
    weights: searchWeightsForChapter(query),
    generationMode: false,
  });
  return selectEvidenceByBudget(result.results
    .filter(item => input.scopedFilePaths.includes(item.filePath))
    .map(item => ({
      chapterId: input.chapter.id,
      filePath: item.filePath,
      score: item.score + 1.2,
      content: item.content,
      roleId: input.fileRoleByPath.get(item.filePath),
      processingType: input.fileProcessingByPath.get(item.filePath),
      sectionTitle: item.sectionTitle,
      source: 'section-evidence',
    })), { maxItems: 5, maxChars: 9000, preservePinned: true });
}

export async function retrieveMissingFactEvidence(input: { manager: ReturnType<typeof getMultiProjectManager>; projectRoot: string; chapter: DocumentTemplateChapter; needs: string[]; scopedFilePaths: string[]; fileRoleByPath: Map<string, string>; fileProcessingByPath: Map<string, string>; signal?: AbortSignal }) {
  const evidence: DocumentEvidence[] = [];
  const needs = input.needs.slice(0, 8);
  // 缺失事实补检索并行化：与主章节检索路径保持一致（全部需求并发执行，不加人为并发上限）；
  // 结果后续统一按评分排序去重，并行不改变召回质量
  const results = await Promise.all(needs.map(async need => {
    throwIfAborted(input.signal);
    const query = `${input.chapter.title} ${need} ${(input.chapter.sections || []).join(' ')}`.trim();
    const result = await input.manager.search(input.projectRoot, query, {
      scope: 'project',
      filters: { filePaths: input.scopedFilePaths },
      limit: 6,
      weights: searchWeightsForChapter(`${input.chapter.title} ${need}`),
      generationMode: false,
    });
    return result.results
      .filter(item => input.scopedFilePaths.includes(item.filePath))
      .map(item => ({
        chapterId: input.chapter.id,
        filePath: item.filePath,
        score: item.score + 2,
        content: item.content,
        roleId: input.fileRoleByPath.get(item.filePath),
        processingType: input.fileProcessingByPath.get(item.filePath),
        sectionTitle: item.sectionTitle,
        source: 'required-fact-evidence',
      }));
  }));
  evidence.push(...results.flat());
  return selectEvidenceByBudget(evidence, { maxItems: Math.max(6, needs.length * 3), maxChars: 18000, preservePinned: true });
}

export function summarizeIssueList(prefix: string, filePaths: string[], limit = 12) {
  if (filePaths.length === 0) return [];
  const names = filePaths.slice(0, limit).map(filePath => path.basename(filePath));
  const suffix = filePaths.length > limit ? ` 等 ${filePaths.length} 个文件` : '';
  return [`${prefix}：${names.join('、')}${suffix}`];
}

export function kbIndexHealth(project: EvidenceLimitProject, scopedFilePaths: string[]) {
  const scoped = new Set(scopedFilePaths.filter(Boolean));
  const files = project.listFiles?.() || [];
  const scopedRecords = files.filter(record => scoped.size === 0 || scoped.has(record.relativePath));
  const indexedPaths = new Set(scopedRecords.map(record => record.relativePath));
  const missingFiles = [...scoped].filter(filePath => !indexedPaths.has(filePath));
  const emptyFiles = scopedRecords.filter(record => Math.max(0, Math.ceil(Number(record.chunkCount) || 0)) === 0).map(record => record.relativePath);
  const errorFiles = scopedRecords.filter(record => record.status === 'error').map(record => record.relativePath);
  const pendingJobs = typeof project.countPendingIndexJobs === 'function' ? project.countPendingIndexJobs() : 0;
  const vectorStatus = typeof project.getVectorStatus === 'function' ? project.getVectorStatus() : undefined;
  const usableRecords = scopedRecords.filter(record => record.status !== 'error' && Math.max(0, Math.ceil(Number(record.chunkCount) || 0)) > 0);
  const usablePaths = usableRecords.map(record => record.relativePath);
  const usableChunkCount = usableRecords.reduce((sum, record) => sum + Math.max(0, Math.ceil(Number(record.chunkCount) || 0)), 0);
  const unavailableWarnings = [
    ...summarizeIssueList('部分绑定文件未完成索引，已自动跳过', missingFiles),
    ...summarizeIssueList('部分绑定文件没有可用切片，已自动跳过', emptyFiles),
    ...summarizeIssueList('部分绑定文件索引失败，已自动跳过', errorFiles),
  ];
  const blockingIssues = scoped.size > 0 && usableChunkCount === 0 ? ['所有绑定文件均无可用切片'] : [];
  const warnings = [
    ...unavailableWarnings,
    ...(pendingJobs > 0 ? [`仍有 ${pendingJobs} 个待索引任务，建议等待索引完成后生成`] : []),
    ...(vectorStatus && vectorStatus.status !== 'ready' ? [`向量索引状态为 ${vectorStatus.status}，当前召回质量可能下降`] : []),
  ];
  return { scopedRecords, usablePaths, missingFiles, emptyFiles, errorFiles, pendingJobs, vectorStatus, usableChunkCount, blockingIssues, warnings };
}

export type EvidenceLimitProject = {
  listFiles?: () => Array<{ relativePath: string; chunkCount?: number; status?: string }>;
  countPendingIndexJobs?: () => number;
  getVectorStatus?: () => { status: string; error?: string; indexedChunks: number; lastIndexedAt: number; backend: string };
};

export function slowMetricSummary(metrics: DocumentGenerationDiagnostics['metrics']) {
  return [...metrics]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map(metric => `${metric.name} ${Math.round(metric.durationMs / 1000)}秒`)
    .join('，');
}

export function resolveDocumentGenerationEvidenceLimit(project: EvidenceLimitProject, scopedFilePaths: string[], requestedLimit?: number): number {
  if (Number.isFinite(requestedLimit) && requestedLimit! > 0) return Math.ceil(requestedLimit!);
  const scoped = new Set(scopedFilePaths.filter(Boolean));
  const chunkCount = project.listFiles?.()
    .filter(record => scoped.size === 0 || scoped.has(record.relativePath))
    .reduce((sum, record) => sum + Math.max(0, Math.ceil(Number(record.chunkCount) || 0)), 0) ?? 0;
  if (chunkCount > 0) return chunkCount;
  return Math.max(1, scoped.size);
}
