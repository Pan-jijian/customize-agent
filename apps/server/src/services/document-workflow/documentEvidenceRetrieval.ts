import type { DocumentEvidence, DocumentTemplateChapter, RetrievalCoverageReport, ValidationIssue } from './types';
import { selectEvidenceByBudget } from './evidence';
import { evidenceMatchesFact } from './factMatching';
import { runWithAdaptiveConcurrency, throwIfAborted } from './utils';
import { selectByScore, textImportanceScore } from './selection';

export interface RetrievalCoverageRisk {
  totalChunks: number;
  loadedChunks: number;
  omittedChunks: number;
  loadedRatio: number;
  highRisk: boolean;
  riskReason?: string;
}

type SearchManager = { search: (projectRoot: string, query: string, options: any) => Promise<{ results: Array<{ filePath: string; score: number; content: string; sectionTitle?: string; source?: string }> }> };

function uniqueTokens(values: string[]) {
  return [...new Set(values.flatMap(value => value.split(/[\s、，,。；;：:（）()《》【】\-/]+/u)).map(value => value.trim()).filter(value => value.length >= 2))];
}

export function retrievalCoverageRisk(input: { totalChunks: number; loadedChunks: number; vectorReady?: boolean }): RetrievalCoverageRisk {
  const totalChunks = Math.max(0, Math.ceil(input.totalChunks || 0));
  const loadedChunks = Math.max(0, Math.ceil(input.loadedChunks || 0));
  const omittedChunks = Math.max(0, totalChunks - loadedChunks);
  const loadedRatio = totalChunks > 0 ? loadedChunks / totalChunks : 1;
  // 风险判定只使用可验证的事实信号，不引入任意规模阈值：
  // 1) 切片未完全预加载（沿用原有的懒加载预留逻辑）；2) 向量索引未就绪（与索引健康检查的告警口径一致，召回质量确实下降）
  const lazyLoadRisk = totalChunks >= 1000 && loadedRatio < 0.35;
  const vectorRisk = input.vectorReady === false;
  const riskReasons = [
    ...(lazyLoadRisk ? ['切片未完全预加载'] : []),
    ...(vectorRisk ? ['向量索引未就绪'] : []),
  ];
  return { totalChunks, loadedChunks, omittedChunks, loadedRatio, highRisk: riskReasons.length > 0, riskReason: riskReasons.join('、') || undefined };
}

export function buildDeepRetrievalQueries(chapter: DocumentTemplateChapter, requiredNeeds: string[] = []) {
  const allSections = chapter.sections || [];
  const allFacts = [...chapter.requiredFacts, ...requiredNeeds];
  // 用评分选择最重要的 sections 和 facts（而非硬截断前 N 个）
  const topSections = selectByScore(allSections, s => textImportanceScore(s), { maxItems: 16, maxChars: 1200 }, 'retrieval-sections').selected;
  const topFacts = selectByScore(allFacts, f => textImportanceScore(f), { maxItems: 16, maxChars: 1200 }, 'retrieval-facts').selected;
  const isCompositeTitle = /[、，,与和及]/.test(chapter.title);
  const isResourceChapter = /资源|人|材|机|材料|设备|清单|工程量|BOQ|报价/u.test(chapter.title);
  const domainHints = /进度|工期|节点/u.test(chapter.title) ? ['合同工期', '计划工期', '日历天', '开工', '竣工', '关键线路', '进度计划', '施工进度']
    : /质量|验收/u.test(chapter.title) ? ['质量标准', '验收规范', '检验批', '复验', '合格', '质量保证', '隐蔽验收']
      : /安全|危大|风险/u.test(chapter.title) ? ['安全措施', '风险源', '危大工程', '应急', '检查整改', '安全防护', '应急预案']
        : isResourceChapter ? ['工程量清单', '项目特征', '材料设备', '规格型号', '数量单位', '劳动力', '机械设备', '进场计划', '资源保障', '主要材料', '施工机具', '材料供应', '设备配置']
          : /施工|方案|方法|技术|工艺/u.test(chapter.title) ? ['施工方法', '工艺流程', '技术标准', '构造做法', '控制要点', '施工准备']
            : ['工程范围', '施工方法', '控制要点', '验收要求'];
  // 复合标题章节：扩充领域提示，覆盖标题各部分的语义空间
  const expandedHints = isCompositeTitle
    ? [...domainHints, ...chapter.title.split(/[、，,与和及]+/u).map(p => p.trim()).filter(p => p.length >= 4)]
    : domainHints;
  const allTokens = uniqueTokens([chapter.title, ...topSections, ...topFacts, ...expandedHints]);
  // 查询构造：按 token 重要性评分选择最关键的（而非前 18 个）
  const topTokens = selectByScore(allTokens, t => textImportanceScore(t), { maxItems: 36, maxChars: 1200 }, 'retrieval-tokens').selected;
  const compositePartQueries = isCompositeTitle
    ? chapter.title.split(/[、，,与和及]+/u).map(p => p.trim()).filter(p => p.length >= 4).map(part => `${part} ${topSections.slice(0, 6).join(' ')} ${topFacts.slice(0, 4).join(' ')}`.trim())
    : [];
  return [...new Set([
    `${chapter.title} ${topSections.join(' ')}`.trim(),
    ...topFacts.map(fact => `${chapter.title} ${fact}`.trim()),
    ...topSections.map(section => `${chapter.title} ${section} ${topFacts.slice(0, 6).join(' ')}`.trim()),
    `${chapter.title} ${expandedHints.join(' ')}`.trim(),
    ...compositePartQueries,
    topTokens.join(' '),
  ].filter(Boolean))];
}

function boqProcessingBoost(processingType?: string): number {
  // BOQ/清单/表格类型材料在深召回中获得更高权重，优先作为可量化事实来源
  if (processingType === 'table') return 3.0;
  if (processingType === 'structured_data') return 2.6;
  if (processingType === 'bill_of_quantities') return 3.2;
  return 0;
}

function mapSearchResults(input: { chapter: DocumentTemplateChapter; results: Array<{ filePath: string; score: number; content: string; sectionTitle?: string; source?: string }>; fileRoleByPath: Map<string, string>; fileProcessingByPath: Map<string, string>; boost: number; source: string }): DocumentEvidence[] {
  return input.results.map(item => {
    const processingType = input.fileProcessingByPath.get(item.filePath);
    const typeBoost = boqProcessingBoost(processingType);
    return {
      chapterId: input.chapter.id,
      filePath: item.filePath,
      score: item.score + input.boost + typeBoost,
      content: item.content,
      roleId: input.fileRoleByPath.get(item.filePath),
      processingType,
      sectionTitle: item.sectionTitle,
      source: input.source,
    };
  });
}

export async function retrieveDeepChapterEvidence(input: {
  manager: SearchManager;
  projectRoot: string;
  chapter: DocumentTemplateChapter;
  scopedFilePaths: string[];
  fileRoleByPath: Map<string, string>;
  fileProcessingByPath: Map<string, string>;
  requiredNeeds?: string[];
  highRisk?: boolean;
  signal?: AbortSignal;
}) {
  throwIfAborted(input.signal);
  const evidence: DocumentEvidence[] = [];
  if (input.scopedFilePaths.length === 0) return evidence;
  // 资源/材料/清单类章节 + 复合标题章节：扩大深召回查询数量，覆盖更多BOQ和清单材料
  const isResourceHeavy = /资源|人|材|机|材料|设备|清单|工程量|BOQ|报价/u.test(input.chapter.title);
  const isCompositeTitle = /[、，,与和及]/.test(input.chapter.title);
  const budgetMultiplier = (isResourceHeavy ? 1.6 : 1) * (isCompositeTitle ? 1.4 : 1);
  const maxQueries = Math.ceil((input.highRisk ? 18 : 10) * budgetMultiplier);
  const queries = buildDeepRetrievalQueries(input.chapter, input.requiredNeeds).slice(0, maxQueries);
  const limit = Math.ceil((input.highRisk ? 24 : 14) * (isResourceHeavy ? 1.4 : 1));
  const maxEvidence = Math.ceil((input.highRisk ? 72 : 42) * budgetMultiplier);
  const maxChars = Math.ceil((input.highRisk ? 72000 : 42000) * budgetMultiplier);
  // 深召回按工作流自适应并发执行：保持吞吐，但避免多章节叠加时形成检索洪峰。
  const searchResults = await runWithAdaptiveConcurrency(queries, async query => {
    throwIfAborted(input.signal);
    const result = await input.manager.search(input.projectRoot, query, {
      scope: 'project',
      filters: { filePaths: input.scopedFilePaths },
      limit,
      weights: { keyword: 0.62, vector: 0.32, rewrite: 0.9, hybridBonus: 0.28 },
      generationMode: false,
    });
    return mapSearchResults({ chapter: input.chapter, results: result.results.filter(item => input.scopedFilePaths.includes(item.filePath)), fileRoleByPath: input.fileRoleByPath, fileProcessingByPath: input.fileProcessingByPath, boost: 2.4, source: 'deep-retrieval' });
  }, { kind: 'deepRetrieval', highRisk: input.highRisk });
  evidence.push(...searchResults.flat());
  return selectEvidenceByBudget(evidence, { maxItems: maxEvidence, maxChars, preservePinned: true });
}

export function buildRetrievalCoverageReport(input: { chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; risk: RetrievalCoverageRisk }): RetrievalCoverageReport {
  const sectionTotal = input.chapter.sections?.length || 0;
  const sectionCovered = (input.chapter.sections || []).filter(section => input.evidence.some(item => evidenceMatchesFact(item, section) || `${item.sectionTitle || ''} ${item.content}`.includes(section))).length;
  const requiredFactTotal = input.chapter.requiredFacts.length;
  const requiredFactCovered = input.chapter.requiredFacts.filter(fact => input.evidence.some(item => evidenceMatchesFact(item, fact))).length;
  return {
    chapterId: input.chapter.id,
    chapterTitle: input.chapter.title,
    risk: input.risk,
    evidenceCount: input.evidence.length,
    evidenceFiles: new Set(input.evidence.map(item => item.filePath)).size,
    sectionCovered,
    sectionTotal,
    requiredFactCovered,
    requiredFactTotal,
  };
}

export function retrievalCoverageIssues(reports: RetrievalCoverageReport[]): ValidationIssue[] {
  return reports.filter(report => report.risk.highRisk && (report.requiredFactTotal === 0 ? report.evidenceCount < 8 : report.requiredFactCovered < report.requiredFactTotal)).map(report => ({
    level: 'warning' as const,
    message: `系统知识库召回覆盖需复核：${report.chapterTitle}`,
    suggestion: `知识库总切片 ${report.risk.totalChunks}，当前预加载 ${report.risk.loadedChunks}${report.risk.riskReason ? `（${report.risk.riskReason}）` : ''}，已启用深召回；事实覆盖 ${report.requiredFactCovered}/${report.requiredFactTotal}，小节覆盖 ${report.sectionCovered}/${report.sectionTotal}。`,
  }));
}
