import { documentTextLength } from './budget';
import type { ChapterCoverageReport, DocumentDraftChapter, DocumentFactTrace, DocumentKnowledgeCoverageReport, DocumentQualityReport, ValidationIssue } from './types';

function scoreFromIssues(issues: ValidationIssue[]) {
  const penalty = issues.reduce((sum, issue) => sum + (issue.level === 'error' ? 10 : issue.level === 'warning' ? 4 : 1), 0);
  return Math.max(0, 100 - penalty);
}

function average(values: number[]) {
  if (values.length === 0) return 100;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function buildDocumentQualityReport(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
  issues: ValidationIssue[];
  knowledgeCoverage: DocumentKnowledgeCoverageReport;
  factTraces: DocumentFactTrace[];
  chapterCoverage: ChapterCoverageReport[];
}): DocumentQualityReport {
  const issueScore = scoreFromIssues(input.issues);
  const chapterScore = average(input.chapterCoverage.map(item => item.score));
  const usedFacts = input.factTraces.filter(trace => trace.status === 'used').length;
  const factScore = input.factTraces.length ? Math.round((usedFacts / input.factTraces.length) * 100) : 100;
  const structureScore = input.chapters.length > 0 && input.chapters.every(chapter => input.markdown.includes(chapter.title) && documentTextLength(chapter.content) >= 600) ? 95 : 78;
  const scores = {
    factuality: Math.min(100, Math.round((factScore * 0.65) + (issueScore * 0.35))),
    structure: Math.min(100, Math.round((structureScore * 0.7) + (chapterScore * 0.3))),
    professionalDepth: chapterScore,
    executable: average(input.chapterCoverage.map(item => item.checks.some(check => check.key === 'professional' && check.passed) ? 95 : 75)),
    evidenceCoverage: input.knowledgeCoverage.score,
    consistency: issueScore,
  };
  const overall = Math.round(scores.factuality * 0.22 + scores.structure * 0.16 + scores.professionalDepth * 0.18 + scores.executable * 0.16 + scores.evidenceCoverage * 0.18 + scores.consistency * 0.1);
  const blockingIssues = input.issues.filter(issue => issue.level === 'error').length;
  const deliveryProbability = Math.max(0, Math.min(99, Math.round(overall - blockingIssues * 8)));
  const target = input.knowledgeCoverage.score >= 95 ? 95 : 85;
  return {
    overall,
    deliveryProbability,
    target,
    passed: deliveryProbability >= target && blockingIssues === 0,
    scores,
    summary: `交付置信度 ${deliveryProbability}% / 目标 ${target}%，综合评分 ${overall}/100`,
    actions: deliveryProbability >= target && blockingIssues === 0
      ? ['已达到当前质量目标，建议保持事实口径和导出前复核。']
      : [
          '系统需优先修复阻断问题、扩大本地知识库检索、补抽结构化事实，并将未落位事实写入对应章节。',
          '对低分章节执行结构补齐、专业控制点补写、跨章一致性复核和证据引用覆盖修复。',
        ],
  };
}

export function qualityReportIssues(report: DocumentQualityReport): ValidationIssue[] {
  if (report.passed) return [];
  return [{
    level: 'warning',
    message: `交付置信度未达目标：${report.deliveryProbability}% / ${report.target}%`,
    suggestion: report.actions.join(' '),
  }];
}
