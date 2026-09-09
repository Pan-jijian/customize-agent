/**
 * helpers/evidenceRetrieval：证据检索/评分/优化/查询（P3 拆分，逐字机械搬移自 documentGeneratorHelpers.ts）。
 * 依赖 projectBasicInfo（PROJECT_BASIC_FACT_QUERIES/projectBasicFactScore）。
 */
import type { getMultiProjectManager } from '../../knowledge/kbService';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFact, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, ValidationIssue } from '../types';
import { evidencePromptImportance, selectEvidenceByBudget } from '../evidence';
import { normalizeOcrFactText, isValidProjectBasicFactValue } from '../factsModel';
import { BID_DISCIPLINE_PHRASES, dedupeCrossSectionSkeletonH4s, dedupeRepeatedSubsections, isBidDisciplineSentence, stringifyFactValue, throwIfAborted, WORK_PACKAGE_SECTION_RE } from '../utils';
import { PROJECT_BASIC_FACT_QUERIES, projectBasicFactScore } from './projectBasicInfo';

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
