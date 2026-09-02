import * as path from 'node:path';
import type { getMultiProjectManager } from '../knowledge/kbService';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from './types';
import { documentTextLength } from './budget';
import { templatePromptBindings, type ResolvedPromptContent } from './templateStore';
import type { buildPromptBindingPlan } from './templateStore';
import { evidencePromptImportance, selectEvidenceByBudget } from './evidence';
import { normalizeOcrFactText, isValidProjectBasicFactValue } from './factsModel';
import { buildCanonicalFacts } from './factGovernance';
import { mergeTableLineBreaks, normalizeInlineListBreaks, normalizeMarkdownTableDividers, normalizeTenderSourcePageRefs, removeAdjacentDuplicateHeadings, dedupeCrossLevelHeadingDuplicates, dedupeRepeatedBlocksWithinSections } from './markdownComposer';
import { displayChapterTitle, isTenderClauseFragmentTitle } from './outline';
import { collectSectionContentGaps } from './qualityValidation';
import { BID_DISCIPLINE_PHRASES, dedupeRepeatedSubsections, isBidDisciplineSentence, stringifyFactValue, throwIfAborted, WORK_PACKAGE_SECTION_RE } from './utils';
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
  // 长文模式（提示词有明确篇幅要求如「不少于5万字」）：提示词预算必须完整下达，不得被
  // upper 硬顶（7200~9800）与 structureTarget（节均 720~900 字的结构估算）双重压制，
  // 否则章预算 16667 字被压至 5200~9200 字，5 万字要求永远达不到（历史缺陷：字数卡 3.8 万）。
  // 单次 LLM 调用的输出安全由块/节级预算（chapterPlanner/写作任务拆分）独立保证，不在章级截断目标。
  const roundTarget = longformStrict
    ? Math.max(lower, budgetTarget)
    : Math.max(lower, Math.min(budgetTarget, structureTarget, upper));
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
  // 窄过滤（模块1b）：只减分纯程序性短语（账户/开标评标程序/交易系统），放行前附表实质条款。
  // 历史缺陷：宽词「投标人须知」把整个前附表章节切片减分（实质条款如创优目标/绿色建筑等级被压出
  // 检索 Top-N）；「保证金」误伤履约/质量保证金；「违约金」误伤工期延误赔偿条款（施组必须响应）。
  if (/保证金账户|开户行|开户名称|收款账户|汇款|转账账户|电子交易系统|公共资源交易|开标时间|开标地点|评标委员会|评标办法/u.test(normalized)) score -= 4;
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
    const result = await input.manager.search(input.projectRoot, query, { scope: 'project', filters: { filePaths: input.scopedFilePaths }, limit: 10, weights: { keyword: 0.65, vector: 0.25, rewrite: 0.8, hybridBonus: 0.2 }, generationMode: true, disableReranker: true });
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
  // getFileDetail 为同步文件读取，Promise.all 不会带来并发收益，保持串行扫描；整文件全量读取（无字符截断）
  for (const relativePath of input.scopedFilePaths) {
    throwIfAborted(input.signal);
    const detail = input.project.getFileDetail?.(relativePath);
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
  });
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
  return normalizeOcrFactText(value)
    // 完整页码引用（“PDF 第N页”含“第 5-8 页”范围形态）与正文侧 normalizeTenderSourcePageRefs
    // 同口径归一为“相关资料”，避免落入下方残片删除分支被误删成“ N 页”（空格+数字形态误删现场）
    .replace(/PDF\s*第\s*\d+(?:\s*[-—至到~～]\s*\d+)?\s*页/giu, '相关资料')
    // 残缺页码引用残片（“PDF 第”后无数字）：fact 抽取复制招标文件封面页码引用时截断，
    // 直接删除残片保留其前文本；lookahead 允许空格/tab 后跟数字（“PDF 第 3 页”属完整引用，由上一条归一），
    // 不跨行（\n 后数字的跨行残片仍删除）；数字与“日”间多余空格一并归一（“2026年8月19 日”）
    .replace(/PDF\s*第(?![ \t]*[0-9０-９])/giu, '')
    .replace(/(\d)\s+(日)/gu, '$1$2')
    .replace(/[。；;]$/u, '')
    .trim();
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

/** P5（评分报告合肥师范4）：基本信息表“质量标准”只写“合格”而创优目标（确保黄山杯）落在
 * 创优目标事实/正文中——质量标准行补全创优目标短语，与正文创优响应同口径。
 * 仅在明确“确保X杯/奖/优质工程”表述存在且质量值未含创优词时附加，无创优目标项目零变化。 */
const AWARD_OBJECTIVE_IN_TEXT_RE = /(?:黄山杯|鲁班奖|白玉兰杯|钱江杯|扬子杯|安济杯|长安杯|汾水杯|省优|市优|国优|优质工程|确保[^。；;|，,\n]{0,10}(?:杯|奖))/u;

function awardObjectivePhrase(facts: DocumentFact[], fullMarkdown: string): string | undefined {
  const texts: string[] = [];
  for (const fact of facts) {
    const fieldText = `${fact.fieldId || ''}${fact.key || ''}${fact.fieldName || ''}`;
    if (/创优|优质优价|奖项|奖惩|award/u.test(fieldText)) texts.push(cleanInlineFactValue(stringifyFactValue(fact.value || '')));
  }
  texts.push(fullMarkdown);
  for (const text of texts) {
    const match = /(?:确保|争创|力争|确保获得)[^。；;|，,\n]{0,12}(?:杯|奖|优质工程)/u.exec(text);
    if (!match) continue;
    const phrase = match[0].trim();
    if (phrase.length >= 5 && phrase.length <= 24) return phrase;
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
  // P5（评分报告合肥师范4）：质量标准行补全创优目标（正文写“确保黄山杯”而汇总表只写“合格”）
  const qualityRow = rows.find(([label]) => label === '质量标准');
  if (qualityRow && qualityRow[1] && !AWARD_OBJECTIVE_IN_TEXT_RE.test(qualityRow[1])) {
    const objective = awardObjectivePhrase(facts, fullMarkdown);
    if (objective && !qualityRow[1].includes(objective)) qualityRow[1] = `${qualityRow[1]}，${objective}`;
  }
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

const PROJECT_BASIC_LABELS = [/^项目名称$/u, /^工程名称$/u, /^项目编号$/u, /^招标项目编号$/u, /^招标人$/u, /^项目业主$/u, /^建设单位$/u, /^发包人$/u, /^建设地点$/u, /^实施地点$/u, /^建设规模$/u, /^工程规模$/u, /^计划工期$/u, /^合同工期$/u, /^总工期$/u, /^质量标准$/u, /^质量目标$/u, /^合同估算价$/u, /^投资估算$/u, /^最高投标限价$/u, /^招标控制价$/u];

function isProjectBasicLabel(label: string) {
  return PROJECT_BASIC_LABELS.some(pattern => pattern.test(label));
}

export function removeDuplicateProjectBasicInfoBlocks(markdown: string) {
  const lines = markdown.replace(/\r?\n/gu, '\n').split('\n');
  const output: string[] = [];
  let seenProjectBasicTable = false;
  const splitRow = (line: string) => splitMarkdownTableLine(line).map(cell => cell.replace(/\*\*/gu, '').trim());
  const isTwoColumnProjectBasicTable = (rows: string[]) => {
    const dataRows = rows.slice(2).map(splitRow).filter(cells => cells.length >= 2);
    const labels = dataRows.map(cells => cells[0] || '');
    const matched = labels.filter(isProjectBasicLabel).length;
    return matched >= 3 && matched >= Math.ceil(labels.length * 0.45);
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    const next = lines[index + 1] || '';
    // eslint-disable-next-line no-control-regex -- [^\u000A] 与原始 [^\n] 语义等价（编辑工具会破坏字面换行转义，改用 unicode 转义）
    const namedProjectBasicTitle = /(?:\*\*[^\u000A]*项目基本信息表[^\u000A]*\*\*|####\s+[^\u000A]*项目基本信息表[^\u000A]*|###\s+[^\u000A]*项目基本信息表[^\u000A]*)/u.test(line);
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

/** 旧项目基础信息表块删除（收窄版）：只删除「项目基础信息类」表格块——两列信息项表
 * （项目名称/招标人等标签行占比达标）或三列序号表（序号|项目名称|内容参数）。
 * 编制依据表（依据类别|主要文件及标准）、工程概况信息表等专业表格不在标签集内天然豁免，
 * 消除旧正则跨空行贪婪连坐删除聚合块（H4 子小节）内其他表格的缺陷。 */
function removeProjectBasicInfoTableBlocks(content: string) {
  const lines = content.split('\n');
  const output: string[] = [];
  const isBasicTable = (rows: string[]) => {
    const firstCells = splitMarkdownTableLine(rows[0] || '').map(cell => cell.replace(/\*\*/gu, '').trim());
    if (firstCells[0] === '序号' && /项目名称/u.test(firstCells[1] || '')) return true;
    const dataRows = rows.slice(2).map(splitMarkdownTableLine).filter(cells => cells.length >= 2);
    if (dataRows.length === 0) return false;
    const labels = dataRows.map(cells => (cells[0] || '').replace(/\*\*/gu, '').trim());
    const matched = labels.filter(isProjectBasicLabel).length;
    return matched >= 3 && matched >= Math.ceil(labels.length * 0.45);
  };
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    // 「**项目基本信息表**」加粗标题行（或 H3-H5 同名标题）及其紧随的表格块整体删除
    if (/^\s*\*\*[^\n]*项目基本信息表[^\n]*\*\*\s*$/u.test(line) || /^\s*#{3,5}\s+[^\n]*项目基本信息表\s*$/u.test(line)) {
      index += 1;
      while (index < lines.length && (lines[index] || '').trim() === '') index += 1;
      if (index < lines.length && looksLikeMarkdownTableLine(lines[index] || '')) {
        index += 1;
        while (index < lines.length && (looksLikeMarkdownTableLine(lines[index] || '') || isMarkdownTableSeparatorLine(lines[index] || ''))) index += 1;
      }
      continue;
    }
    // 裸表格块（表头+分隔行+连续数据行）：仅项目基础信息类删除，其他表格完整保留
    if (looksLikeMarkdownTableLine(line) && index + 1 < lines.length && isMarkdownTableSeparatorLine(lines[index + 1] || '')) {
      const rows: string[] = [line, lines[index + 1] || ''];
      let cursor = index + 2;
      while (cursor < lines.length && looksLikeMarkdownTableLine(lines[cursor] || '')) {
        rows.push(lines[cursor] || '');
        cursor += 1;
      }
      if (isBasicTable(rows)) {
        index = cursor;
        continue;
      }
    }
    output.push(line);
    index += 1;
  }
  return output.join('\n');
}

export function normalizeProjectBasicInfoTable(content: string, facts: DocumentFact[]) {
  content = removeRedundantFormalTables(content);
  if (!/项目基本信息|项目概况|工程概况|招标范围/u.test(content)) return removeDuplicateProjectBasicInfoBlocks(normalizeBareMarkdownTables(stripProvenanceTableColumns(content)));
  if (!/\|\s*信息项\s*\|\s*内容\s*\|/u.test(content) && projectBasicFactCandidates(facts).length > 0) {
    const firstProjectHeading = /^(#{3,4}\s+(?:\d+\.\d+\s+)?[^\n]*(?:项目概况|工程概况|项目基本信息|招标范围)[^\n]*\n)/mu.exec(content);
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
  // 小节边界必须停在下一个 H2/H3/H4（取更早者）：H4 边界缺失时聚合块（### 1.1 编制说明与工程概况
  // 下挂 #### 1.1.1/1.1.2/1.1.3 小节）的正文被整块吞入 body，旧表删除正则连坐删除
  // 编制依据表与工程概况信息表（真实生成缺陷：两张表数据行全部丢失）
  const nextHeading = /^#{2,4}\s+/gmu;
  nextHeading.lastIndex = sectionBodyStart;
  const nextMatch = nextHeading.exec(content);
  const sectionEnd = nextMatch?.index ?? content.length;
  const body = content.slice(sectionBodyStart, sectionEnd);
  const table = projectBasicInfoTableMarkdown(facts, body, content);
  const hasUsefulFact = projectBasicInfoRows(facts, body, content).some(row => !/资料未明确|系统暂未从知识库确认|项目资料暂未明确/u.test(row[1]));
  if (!hasUsefulFact) return content;
  // 旧基本信息表删除只作用于项目基础信息类表格块（标签集判定），
  // 编制依据表、工程概况信息表等专业表格完整保留（详见 removeProjectBasicInfoTableBlocks）
  const cleanedBody = removeProjectBasicInfoTableBlocks(body)
    // eslint-disable-next-line no-control-regex -- [^\u000A] 与原始 [^\n] 语义等价（编辑工具会破坏字面换行转义，改用 unicode 转义）
    .replace(/该小节围绕“[^”]+”进行补充说明[^\u000A]*(?:\u000A\u000A该小节围绕“[^”]+”进行补充说明[^\u000A]*)*/gu, '')
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
    // 工作包型关键小节标题后紧跟同级 H4 工作包是合法结构（小节正文由工作包列表展开），不得误删
    if (WORK_PACKAGE_SECTION_RE.test(trimmed)) {
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
    // 下一标题为更深层子小节时保留；零正文且无子层展开的空壳标题删除
    if (!hasBody && !(nextHeadingLevel > level)) continue;
    result.push(line);
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
      // 工作包型关键小节（主要施工内容/分部分项方案/主要施工方法）统一启用首行标签规范化：
      // 历史缺陷：八度实测“主要分部分项工程施工方案”补写稿无“施工概况”标签被专项验收器阻断（同小节只覆盖“项目主要施工内容”）
      inMainContent = WORK_PACKAGE_SECTION_RE.test(trimmed);
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

/** 工作包三段式标签归一化：LLM 补写稿常输出畸形标签形态——“施工概况：**施工概况**：”重复标签、
 * “**施工流程**：/**施工方法**：”粗体伪标签——粗体命中分部分项验收器脏事实正则、方法段提取正则
 * 拿不到冒号后内容（九度实测缺陷：10 个分项被报脏事实+缺箭头链 blocker）。归一为纯文本标签形态。 */
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
 */
export function dedupeCrossSectionDuplicateSentences(content: string): string {
  const lines = content.split('\n');
  const firstSectionBySentence = new Map<string, string>();
  let currentSection = '';
  let changed = false;
  const result = lines.map(line => {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed)) {
      currentSection = trimmed;
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
  cleaned = normalizeWorkPackageLabels(cleaned);
  cleaned = ensureWorkPackageOverviewLabels(cleaned);
  cleaned = dedupeCrossSectionDuplicateSentences(cleaned);
  // 4.12.12：跨层级（H2/H3 同名）整块去重与同小节内相邻块重复去重（评分报告「同名小节重复」/「整段重复三遍」根因治理）
  cleaned = dedupeCrossLevelHeadingDuplicates(cleaned);
  cleaned = dedupeRepeatedBlocksWithinSections(cleaned);
  cleaned = cleaned.replace(/\n{3,}/gu, '\n\n');
  cleaned = stripTenderClauseFragmentHeadings(cleaned);
  return stripDataConsistencyLeakSentences(cleaned).trim();
}

/** 最终组装路径的重复/空壳兜底清理：rebuildFinalMarkdown 不再逐章跑 finalizeChapterContentQuality，
 * 补跑同 H3 重复 H4 去重与空壳小节删除，避免 Final Gate 补写与章节拼接残留的重复/空壳进入成品文档。 */
export function finalizeFinalMarkdownStructure(markdown: string): string {
  return stripDataConsistencyLeakSentences(stripTenderClauseFragmentHeadings(removeEmptySubSectionHeadings(dedupeRepeatedSubsections(dedupeCrossLevelHeadingDuplicates(dedupeRepeatedBlocksWithinSections(normalizeWorkPackageLabels(cleanChineseWordBreakSpaces(splitGluedTableHeaderLines(rewriteWorkPackageTerminology(dedupeCrossSectionDuplicateSentences(markdown)))))))))));
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
  const tokens = [...new Set([chapter.title, ...(chapter.sections || []), ...chapter.requiredFacts].flatMap(value => value.split(/[\s、，,。；;：:（）()《》【】-]+/u)).map(value => value.trim()).filter(value => value.length >= 2).slice(0, 36))];
  const hits = tokens.filter(token => text.includes(token)).length;
  return Math.min(1.8, hits * 0.16);
}

/** 证据语义排序用的规范文本（与语义相似度闭包缓存 key 一致，调用方构建闭包时必须用同一函数取 rightTexts） */
export function semanticEvidenceText(item: Pick<DocumentEvidence, 'sectionTitle' | 'content'>): string {
  return `${item.sectionTitle || ''}${item.content}`.slice(0, 600);
}

export function optimizeChapterEvidence(chapter: DocumentTemplateChapter, evidence: DocumentEvidence[], options: { maxChars?: number; maxItems?: number; preservePinned?: boolean; semantic?: { similarity: (leftText: string, rightText: string) => number; queryText: string } }, diagnostics?: DocumentGenerationDiagnostics) {
  const scored = evidence.map(item => {
    // 注入排序统一为 evidencePromptImportance 口径（量化值 +8 / 项目基础事实 +10 / requiredFacts +6 / 标准编号 +3），
    // 证据全量保留（无预算截断），重要性/语义分数只决定注入顺序，不决定去留
    const baseScore = evidencePromptImportance(item, chapter.requiredFacts) * processingTypeWeightForChapter(chapter, item.processingType) + chapterTextScore(chapter, item);
    // 语义相关性（本地 bge-small 余弦）作排序主键（×10 压过词面/重要性分数），词面与重要性分数保留作第二键；
    // 闭包缓存未命中的条目（候选池外）语义分为 0，退回 baseScore 口径
    const semanticScore = options.semantic ? options.semantic.similarity(options.semantic.queryText, semanticEvidenceText(item)) : 0;
    return { ...item, score: baseScore * 0.5 + semanticScore * 10 };
  });
  return selectEvidenceByBudget(scored, options, diagnostics);
}

/**
 * 4.12.16 语义排序前置词面粗筛：章节证据全量本地 bge 嵌入是检索段 CPU 瓶颈
 * （6 章全并发 × 每章 ~1.5 万条 ≈ 9 万条推理，真实生成实测 20+ 分钟、61 分钟仅 3/6 章成稿）。
 * 先按词面/重要性分数（与 optimizeChapterEvidence baseScore 同口径）取 topN 候选，
 * 仅候选池进入嵌入；未入池条目语义分为 0 退回 baseScore 口径，证据全量保留不丢。
 * 默认 3000（注入预算上限 ~300 条切片的 10 倍冗余），env DOCUMENT_SEMANTIC_TOP_CANDIDATES 可调。
 */
export function preselectSemanticCandidates(chapter: DocumentTemplateChapter, evidence: DocumentEvidence[], topN: number): DocumentEvidence[] {
  if (topN <= 0 || evidence.length <= topN) return evidence;
  const scored = evidence.map(item => ({
    item,
    lexical: evidencePromptImportance(item, chapter.requiredFacts) * processingTypeWeightForChapter(chapter, item.processingType) + chapterTextScore(chapter, item),
  }));
  scored.sort((left, right) => right.lexical - left.lexical);
  return scored.slice(0, topN).map(entry => entry.item);
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
    limit: 20,
    weights: searchWeightsForChapter(query),
    // E1：生成场景检索跳过 LLM 查询扩展（省 LLM 预算，正文生成已占满 LLM 信号量）；
    // 保留 LocalReranker 交叉编码（历史缺陷：disableReranker 跳过交叉编码后，召回主键退化为
    // 关键词/向量混合分，小节级 top-5 证据相关性下降，承接/证据取舍被迫依赖正则词面），
    // rerank 后分数作为小节证据排序主键——小节证据按需逐组检索，单组 30 候选重排为短时阻塞可容忍
    generationMode: true,
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
    })), { preservePinned: true });
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
