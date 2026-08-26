import * as path from 'node:path';
import type { getMultiProjectManager } from '../knowledge/kbService';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from './types';
import { documentTextLength } from './budget';
import { templatePromptBindings, type ResolvedPromptContent } from './templateStore';
import type { buildPromptBindingPlan } from './templateStore';
import { evidencePromptImportance, selectEvidenceByBudget } from './evidence';
import { normalizeOcrFactText, isValidProjectBasicFactValue } from './factsModel';
import { buildCanonicalFacts } from './factGovernance';
import { normalizeInlineListBreaks, normalizeMarkdownTableDividers, normalizeTenderSourcePageRefs, removeAdjacentDuplicateHeadings } from './markdownComposer';
import { collectSectionContentGaps } from './qualityValidation';
import { stringifyFactValue, throwIfAborted, WORK_PACKAGE_SECTION_RE } from './utils';
import { promptTextsForResolvedPrompts } from './rolePipeline';
import { criticalSectionBlockerMinChars } from './chapterPostProcessing';


export function chapterGenerationTargets(input: { budgetTarget: number; sectionCount: number; title: string; longformStrict: boolean }) {
  const { budgetTarget, sectionCount, title, longformStrict } = input;
  const composite = /[、，,；;]/u.test(title);
  const isCritical = /工期|进度|质量|安全|危大|资源|人材机|保障|措施|重难点/u.test(title);
  const isLight = /概况|结语|附录|说明/u.test(title);
  const structureTarget = sectionCount > 0
    ? sectionCount * (composite ? 720 : isCritical ? 900 : 780)
    : isCritical ? 5200 : 3600;
  const lower = longformStrict ? (isLight ? 2600 : isCritical ? 5200 : 3600) : Math.min(1200, budgetTarget);
  const upper = longformStrict
    ? Math.min(Math.max(4200, budgetTarget), sectionCount >= 30 ? 9800 : composite ? 8800 : isCritical ? 9200 : 7200)
    : budgetTarget;
  const roundTarget = Math.max(lower, Math.min(budgetTarget, structureTarget, upper));
  return {
    budgetTarget,
    roundTarget,
    structureTarget,
    maxWords: Math.ceil(roundTarget * (input.longformStrict ? 1.12 : 1.18)),
    label: `章节预算约 ${budgetTarget} 字，本轮生成约 ${roundTarget} 字，结构目标约 ${structureTarget} 字`,
  };
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
  return 'success';
}

/**
 * Repairer 补写目标字数：对齐 Reviewer 深度通过线（承接小节组内最大 minChars × 0.8）。
 * 目标 = ceil(anchorMinChars / 0.8)，使 Repairer 验收线 0.7×目标 ≈ 0.875×anchorMinChars ≥ Reviewer 0.8×anchorMinChars，
 * 一次补写即可复审通过；否则补写达标却被复审驳回，同一小节反复修（历史缺陷：补写 793 字过 Repairer 验收线仍被复审驳回）。
 */
export function repairTargetWordsForSection(sectionTitle: string, taskMinChars?: number, anchorMinChars?: number) {
  return Math.max(
    taskMinChars || 0,
    anchorMinChars && anchorMinChars > 0 ? Math.ceil(anchorMinChars / 0.8) : 0,
    /项目主要施工内容/u.test(sectionTitle) ? 2200
      : /主要分部分项工程施工方案|主要施工方法/u.test(sectionTitle) ? 1800
        : /项目特点.*重点.*难点|重点.*难点.*分析/u.test(sectionTitle) ? 1500
          : /原材料进场复试|见证取样|危大工程专项施工方案审批流程/u.test(sectionTitle) ? 900 : 760,
  );
}

/**
 * warning 级"正文不足"问题检测：Reviewer 只把关键小节的"正文不足"标为 blocker，普通小节是 warning 级；
 * 修复循环若不处理 warning 级深度缺口，修复多轮问题数纹丝不动（历史缺陷：47 个 warning 修复两轮后仍 49 个问题）。
 */
export function hasDepthWarningIssues(issues: Array<{ level?: string; severity?: string; message: string }>) {
  return issues.some(issue => issue.level !== 'error' && issue.severity !== 'blocker' && /正文不足，未达到任务最小深度/u.test(issue.message));
}

/**
 * Final Gate 关键小节深度阻断线：min(规则表 blocker 线, Writer/Repairer/Final Gate 修复验收线)。
 * 阻断线不得超过修复验收线（criticalSectionBlockerMinChars），否则补写达标替换后重算仍不足，同一小节永不自愈。
 * 历史缺陷："主要施工方法"修复验收线 1200 但阻断线 1760（规则表 2200×0.8），补写 1715 字达标替换后仍被判不足，整篇生成失败。
 */
export function criticalSectionBlockerLine(title: string) {
  const rules: Array<{ title: string; minChars: number; blockerMinChars?: number }> = [
    { title: '项目特点、重点、难点分析', minChars: 1800 },
    { title: '项目主要施工内容', minChars: 2200 },
    { title: '主要分部分项工程施工方案', minChars: 1200, blockerMinChars: 800 },
    { title: '主要施工方法', minChars: 2200 },
    { title: '危大工程专项施工方案审批流程', minChars: 500, blockerMinChars: 250 },
    { title: '原材料进场复试与见证取样', minChars: 600, blockerMinChars: 300 },
  ];
  const rule = rules.find(item => item.title === title);
  if (!rule) return 0;
  const ruleBlocker = rule.blockerMinChars || Math.floor(rule.minChars * 0.8);
  const repairAcceptLine = criticalSectionBlockerMinChars(title);
  return Math.min(ruleBlocker, repairAcceptLine > 0 ? repairAcceptLine : ruleBlocker);
}

/**
 * 小节标题 → 承接锚点标题：plannedCoverage 映射存在时用首个承接 H4 标题（标题可能被语义重写），
 * 否则用规划标题本身。Repairer 补写目标必须按锚点查深度表，按规划标题查会 miss（历史缺陷：1:1 标题重写小节查表得 0，补写达标仍被复审驳回）。
 */
export function anchorTitleForSection(plannedCoverage: Record<string, string[]> | undefined, sectionTitle: string) {
  const anchors = plannedCoverage?.[sectionTitle];
  return anchors && anchors.length > 0 ? anchors[0] : sectionTitle;
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
  if (/工程量|清单|图纸|设计说明|施工范围|施工内容|材料|设备|工艺|验收|复试|检测/u.test(normalized)) score += 3;
  if (/投标人须知|保证金|付款|违约金|电子交易|公共资源|开标|评标|合同协议书/u.test(normalized)) score -= 4;
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
    next = next.replace(new RegExp(`(${item.label.source})(\\s*[|：:]\\s*)(?:资料未明确|系统暂未从知识库确认|项目资料暂未明确)[^|\\n。；;]*`, 'gu'), `$1$2${value}`);
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
    if (!value || /内容|参数|资料未明确|系统暂未从知识库确认|项目资料暂未明确/u.test(value) || !isValidProjectBasicFactValue(fieldId || 'project_name', value)) continue;
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
  const cleanProjectBasicCell = (value: unknown) => cleanInlineFactValue(stringifyFactValue(value || ''))
    .replace(/\|/gu, '')
    .replace(/\bCOL\d+\b/gu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  const fallbackProjectName = () => {
    const candidates = [
      /([\u4e00-\u9fa5A-Za-z0-9（）()\-—_\s·]+?(?:施工总承包项目|一期项目|学生宿舍一期|学生宿舍项目))/u.exec(fullMarkdown)?.[1],
      /项目名称[：:\s|]+([^|\n。；;]{6,80})/u.exec(fullMarkdown)?.[1],
    ].map(cleanProjectBasicCell).filter(value => value && isValidProjectBasicFactValue('project_name', value));
    return candidates[0] ? [candidates[0], '项目资料'] as [string, string] : undefined;
  };
  const pickCanonical = (key: string, fallbackPatterns: RegExp[]) => {
    const fact = canonical.get(key);
    if (fact) {
      const value = cleanProjectBasicCell(fact.value);
      if (value && isValidProjectBasicFactValue(key, value)) return [value, fact.source || '项目资料'] as [string, string];
    }
    return markdownRowValue(parsedRows, fallbackPatterns) || (key === 'project_name' ? fallbackProjectName() : undefined) || ['', ''];
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
  return rows.filter(([, value]) => Boolean(value)).map(([label, value, source]) => [label, value, source || '项目资料'] as [string, string, string]);
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
  const headers = ['控制项目', '执行要求', '责任岗位', '检查标准', '形成资料', '闭环要求', '备注'];
  return Array.from({ length: columns }, (_item, index) => headers[index] || `补充说明${index + 1}`);
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

function removeRedundantFormalTables(content: string) {
  const removeSectionByTitle = (markdown: string, titles: RegExp[]) => {
    const lines = markdown.split('\n');
    const output: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] || '';
      const heading = /^(#{3,5})\s+(.+)$/u.exec(line.trim());
      const normalizedTitle = heading?.[2]?.replace(/^\d+(?:\.\d+)*\s+/u, '').trim() || '';
      if (heading && titles.some(title => title.test(normalizedTitle))) {
        index += 1;
        while (index < lines.length && !/^#{2,5}\s+/u.test((lines[index] || '').trim())) index += 1;
        index -= 1;
        continue;
      }
      output.push(line);
    }
    return output.join('\n');
  };
  return removeSectionByTitle(content, [/^工程概况一览表$/u, /^招标文件?评分.*响应索引表$/u, /^招标评分项响应索引表$/u])
    .replace(/\*\*(?:工程概况一览表|招标文件?评分.*响应索引表|招标评分项响应索引表)\*\*[\s\S]*?(?=\n{2,}#{2,5}\s+|\n{2,}(?:[^|\n#]|$)|$)/gu, '')
    .replace(/\n{3,}/gu, '\n\n');
}

export function normalizeProjectBasicInfoTable(content: string, facts: DocumentFact[]) {
  content = removeRedundantFormalTables(content);
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
  const hasUsefulFact = projectBasicInfoRows(facts, body, content).some(row => !/资料未明确|系统暂未从知识库确认|项目资料暂未明确/u.test(row[1]));
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
  if (projectBasicFactCandidates(facts).length === 0 || !/资料未明确|系统暂未从知识库确认|项目资料暂未明确/u.test(markdown)) return [];
  const labels = ['计划工期', '合同工期', '质量标准', '合同估算价', '合同估算价格', '建设地点', '建设规模'];
  return labels.filter(label => new RegExp(`${label}[^\n|。；;]{0,40}(?:资料未明确|系统暂未从知识库确认|项目资料暂未明确)`, 'u').test(markdown)).map(label => ({ level: 'error' as const, message: `${label} 已抽取到项目资料事实但正文仍显示暂未明确`, suggestion: '请优先使用项目基础事实卡片中的资料原值，不得用占位表达覆盖已确认事实。' }));
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
    .replace(/按(?:资料|文件|说明|方案|规范|标准|要求)/gu, '依据本项目已确认资料、技术文件和验收标准')
    .replace(/满足(?:相关|有关)?要求/gu, '满足本项目已明确的质量、安全、技术和验收控制要求')
    .replace(/本节(?:将|主要|重点)?/gu, '')
    .replace(/本章将/gu, '')
    .replace(/根据需要|视情况|结合实际情况/gu, '结合已确认资料、现场条件和审批后的施工组织安排')
    .replace(/相关要求/gu, '本项目已明确的质量、安全、技术和验收要求');
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

function removeEmptySubSectionHeadings(content: string) {
  const lines = content.split(/\r?\n/u);
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!/^(#{4,5})\s+/u.test(trimmed)) {
      result.push(line);
      continue;
    }
    // 工作包型关键小节标题后紧跟同级 H4 工作包是合法结构（小节正文由工作包列表展开），不得误删
    if (WORK_PACKAGE_SECTION_RE.test(trimmed)) {
      result.push(line);
      continue;
    }
    let cursor = index + 1;
    let hasBody = false;
    while (cursor < lines.length) {
      const next = lines[cursor].trim();
      if (/^#{1,6}\s+/u.test(next)) break;
      if (next) {
        hasBody = true;
        break;
      }
      cursor += 1;
    }
    if (hasBody) result.push(line);
  }
  return result.join('\n');
}

function ensureWorkPackageOverviewLabels(content: string) {
  const lines = content.split(/\r?\n/u);
  const result: string[] = [];
  const labelPattern = /^(施工概况|施工流程|施工方法)[:：]/u;
  let inMainContent = false;
  let atPackageStart = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^###\s+/u.test(trimmed)) {
      inMainContent = /项目主要施工内容/u.test(trimmed);
      atPackageStart = false;
      result.push(line);
      continue;
    }
    if (/^##\s+/u.test(trimmed)) {
      inMainContent = false;
      atPackageStart = false;
      result.push(line);
      continue;
    }
    if (!inMainContent) {
      result.push(line);
      continue;
    }
    if (/^####\s+/u.test(trimmed)) {
      atPackageStart = true;
      result.push(line);
      continue;
    }
    if (/^#{1,6}\s+/u.test(trimmed)) {
      atPackageStart = false;
      result.push(line);
      continue;
    }
    if (atPackageStart && trimmed) {
      result.push(labelPattern.test(trimmed) ? line : `施工概况：${trimmed}`);
      atPackageStart = false;
      continue;
    }
    result.push(line);
  }
  return result.join('\n');
}

export function finalizeChapterContentQuality(content: string, chapter: Pick<DocumentTemplateChapter, 'title' | 'sections'>) {
  return ensureWorkPackageOverviewLabels(removeEmptySubSectionHeadings(removeAdjacentDuplicateHeadings(normalizeMarkdownTableDividers(normalizeInlineListBreaks(normalizeTenderSourcePageRefs(splitLongParagraphs(stripForbiddenPlaceholderSentences(replaceForbiddenFormalPhrases(repairTableOnlySections(repairPlannedSectionBodies(content, chapter))))))))))).replace(/\n{3,}/gu, '\n\n').trim();
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

export function factsWithEvidenceSource(facts: DocumentFact[], evidence: DocumentEvidence[]) {
  void evidence;
  return facts.filter(fact => Boolean(fact.sourceFile));
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
  if (/###|第\s*\d+\s*页|共\s*\d+\s*页|新版交易系统|操作帮助|登录页面|见招标公告|未尽事宜|详见图纸|招标文件补疑|政府相关文件|规范等其它资料/u.test(text)) return '';
  if (/^\d+(?:\.\d+)?\s*(?:mm|cm|m|㎡|m²|m3|m³|%|元|万元)?$/iu.test(text)) return '';
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
    const valueText = stringifyFactValue(fact.value);
    if (isCommercialSensitiveFactText(`${labelText}${valueText}`)) return false;
    if (!significantFactValue(valueText)) return false;
    if (/第\s*\d+\s*页|新版交易系统|操作帮助|见招标公告|未尽事宜|详见图纸|招标文件补疑|政府相关文件|规范等其它资料/u.test(`${labelText}${valueText}${fact.sourceFile || ''}`)) return false;
    return /项目名称|工程名称|项目编号|招标项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|计划工期|合同工期|质量标准|质量目标/u.test(labelText)
      || (/危大|安全|资源|材料|机械|设备/u.test(labelText) && !/^\d+(?:\.\d+)?\s*(?:mm|cm|m|㎡|m²|m3|m³|%|元|万元)?$/iu.test(valueText));
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
    // 池截断排序与注入排序统一为 evidencePromptImportance 口径（量化值 +8 / 项目基础事实 +10 / requiredFacts +6 / 标准编号 +3），
    // 避免量化关键事实与模板要求事实在 maxItems 截断时被高分泛化块挤出证据池
    score: evidencePromptImportance(item, chapter.requiredFacts) * processingTypeWeightForChapter(chapter, item.processingType) + chapterTextScore(chapter, item),
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
    // 小节级检索跳过 LocalReranker 交叉编码：每小节一次全链路检索是本链路最大耗时点，
    // 后续还有 evidenceForSection/selectEvidenceByBudget 双层本地重排兜底，交叉编码收益低
    disableReranker: true,
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
