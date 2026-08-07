import * as path from 'node:path';
import type { DocumentEvidence, DocumentTemplateChapter, RetrievalCoverageReport, ValidationIssue } from './types';
import { cleanEvidenceText, selectEvidenceByBudget } from './evidence';
import { evidenceMatchesFact } from './factMatching';
import { throwIfAborted } from './utils';

export interface RetrievalCoverageRisk {
  totalChunks: number;
  loadedChunks: number;
  omittedChunks: number;
  loadedRatio: number;
  highRisk: boolean;
}

type SearchManager = { search: (projectRoot: string, query: string, options: any) => Promise<{ results: Array<{ filePath: string; score: number; content: string; sectionTitle?: string; source?: string }> }> };

type DetailProject = { getFileDetail?: (relativePath: string, options?: { maxChunkContentChars?: number }) => { file: { relativePath: string }; chunks: Array<{ content: string; sectionTitle?: string }>; totalChunkCount?: number } | undefined };

function uniqueTokens(values: string[]) {
  return [...new Set(values.flatMap(value => value.split(/[\s、，,。；;：:（）()《》【】\-/]+/u)).map(value => value.trim()).filter(value => value.length >= 2))];
}

export function retrievalCoverageRisk(input: { totalChunks: number; loadedChunks: number }): RetrievalCoverageRisk {
  const totalChunks = Math.max(0, Math.ceil(input.totalChunks || 0));
  const loadedChunks = Math.max(0, Math.ceil(input.loadedChunks || 0));
  const omittedChunks = Math.max(0, totalChunks - loadedChunks);
  const loadedRatio = totalChunks > 0 ? loadedChunks / totalChunks : 1;
  return { totalChunks, loadedChunks, omittedChunks, loadedRatio, highRisk: totalChunks >= 1000 && loadedRatio < 0.35 };
}

export function buildDeepRetrievalQueries(chapter: DocumentTemplateChapter, requiredNeeds: string[] = []) {
  const sections = chapter.sections || [];
  const requiredFacts = [...chapter.requiredFacts, ...requiredNeeds];
  const base = [chapter.title, ...sections.slice(0, 12), ...requiredFacts.slice(0, 12)];
  const domainHints = /进度|工期|节点/u.test(chapter.title) ? ['合同工期', '计划工期', '日历天', '开工', '竣工', '关键线路']
    : /质量|验收/u.test(chapter.title) ? ['质量标准', '验收规范', '检验批', '复验', '合格']
      : /安全|危大|风险/u.test(chapter.title) ? ['安全措施', '风险源', '危大工程', '应急', '检查整改']
        : /资源|人|材|机|材料|设备/u.test(chapter.title) ? ['劳动力', '材料', '机械设备', '进场计划', '资源保障']
          : ['工程范围', '施工方法', '控制要点', '验收要求'];
  const tokens = uniqueTokens([...base, ...domainHints]);
  return [...new Set([
    `${chapter.title} ${sections.slice(0, 8).join(' ')}`.trim(),
    ...requiredFacts.map(fact => `${chapter.title} ${fact}`.trim()),
    ...sections.slice(0, 10).map(section => `${chapter.title} ${section} ${requiredFacts.slice(0, 4).join(' ')}`.trim()),
    `${chapter.title} ${domainHints.join(' ')}`.trim(),
    tokens.slice(0, 18).join(' '),
  ].filter(Boolean))];
}

function mapSearchResults(input: { chapter: DocumentTemplateChapter; results: Array<{ filePath: string; score: number; content: string; sectionTitle?: string; source?: string }>; fileRoleByPath: Map<string, string>; fileProcessingByPath: Map<string, string>; boost: number; source: string }): DocumentEvidence[] {
  return input.results.map(item => ({
    chapterId: input.chapter.id,
    filePath: item.filePath,
    score: item.score + input.boost,
    content: item.content,
    roleId: input.fileRoleByPath.get(item.filePath),
    processingType: input.fileProcessingByPath.get(item.filePath),
    sectionTitle: item.sectionTitle,
    source: input.source,
  }));
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
  const evidence: DocumentEvidence[] = [];
  if (input.scopedFilePaths.length === 0) return evidence;
  const queries = buildDeepRetrievalQueries(input.chapter, input.requiredNeeds).slice(0, input.highRisk ? 18 : 10);
  const limit = input.highRisk ? 24 : 14;
  for (const query of queries) {
    throwIfAborted(input.signal);
    const result = await input.manager.search(input.projectRoot, query, {
      scope: 'project',
      filters: { filePaths: input.scopedFilePaths },
      limit,
      weights: { keyword: 0.62, vector: 0.32, rewrite: 0.9, hybridBonus: 0.28 },
      generationMode: false,
    });
    evidence.push(...mapSearchResults({ chapter: input.chapter, results: result.results.filter(item => input.scopedFilePaths.includes(item.filePath)), fileRoleByPath: input.fileRoleByPath, fileProcessingByPath: input.fileProcessingByPath, boost: 2.4, source: 'deep-retrieval' }));
  }
  return selectEvidenceByBudget(evidence, { maxItems: input.highRisk ? 72 : 42, maxChars: input.highRisk ? 72000 : 42000, preservePinned: true });
}

export function sampleBoundFileEvidence(input: { project: DetailProject; chapter: DocumentTemplateChapter; scopedFilePaths: string[]; fileRoleByPath: Map<string, string>; fileProcessingByPath: Map<string, string>; highRisk?: boolean }) {
  const evidence: DocumentEvidence[] = [];
  const tokens = uniqueTokens([input.chapter.title, ...(input.chapter.sections || []), ...input.chapter.requiredFacts]);
  const budget = input.highRisk ? 24000 : 12000;
  for (const filePath of input.scopedFilePaths.slice(0, input.highRisk ? 80 : 40)) {
    const detail = input.project.getFileDetail?.(filePath, { maxChunkContentChars: budget });
    if (!detail?.chunks?.length) continue;
    const ranked = detail.chunks.map((chunk, index) => {
      const content = cleanEvidenceText(chunk.content);
      const haystack = `${chunk.sectionTitle || ''}\n${content}`;
      const hits = tokens.filter(token => haystack.includes(token)).length;
      const numericBonus = /\d+(?:\.\d+)?\s*(?:日历天|天|月|年|万元|元|㎡|m²|m³|米|mm|台|套|人|项|%|MPa|kPa)/u.test(content) ? 1 : 0;
      return { chunk, index, score: hits * 0.8 + numericBonus + (index === 0 ? 0.4 : 0) };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, input.highRisk ? 6 : 3);
    for (const item of ranked) evidence.push({
      chapterId: input.chapter.id,
      filePath: detail.file.relativePath,
      score: 1.8 + item.score,
      content: item.chunk.content,
      roleId: input.fileRoleByPath.get(detail.file.relativePath),
      processingType: input.fileProcessingByPath.get(detail.file.relativePath),
      sectionTitle: item.chunk.sectionTitle,
      source: 'bound-file-sample',
    });
  }
  return selectEvidenceByBudget(evidence, { maxItems: input.highRisk ? 60 : 30, maxChars: input.highRisk ? 60000 : 30000, preservePinned: true });
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
    message: `系统延迟切片召回覆盖需复核：${report.chapterTitle}`,
    suggestion: `知识库总切片 ${report.risk.totalChunks}，当前预加载 ${report.risk.loadedChunks}，已启用深召回；事实覆盖 ${report.requiredFactCovered}/${report.requiredFactTotal}，小节覆盖 ${report.sectionCovered}/${report.sectionTotal}。`,
  }));
}
