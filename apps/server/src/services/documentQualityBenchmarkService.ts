import type { DocumentTemplate, DocumentDraftChapter, ValidationIssue } from './documentWorkflowService';
import { readEngineeringDocumentConfig, type QualityBenchmarkConfig, type QualityBenchmarkRule } from './engineeringDocumentConfigService';

export interface QualityBenchmarkResult {
  benchmarkId: string;
  benchmarkName: string;
  score: number;
  pass: boolean;
  blocked: boolean;
  issues: ValidationIssue[];
}

function textOf(chapters: DocumentDraftChapter[], markdown?: string) {
  return markdown || chapters.map(chapter => `${chapter.title}\n${chapter.content}`).join('\n\n');
}

function matchTemplate(template: DocumentTemplate, benchmark: QualityBenchmarkConfig) {
  const text = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  return benchmark.templateMatchers.some(pattern => new RegExp(pattern, 'iu').test(text));
}

function countMatches(text: string, keywords: string[] = []) {
  return keywords.filter(keyword => keyword && text.includes(keyword)).length;
}

function titleMatches(chapters: DocumentDraftChapter[], patterns: string[] = []) {
  return patterns.filter(pattern => chapters.some(chapter => new RegExp(pattern, 'iu').test(chapter.title))).length;
}

function hasTable(text: string) {
  return /\n\s*\|[^\n]+\|\s*\n\s*\|\s*[-:| ]+\|/u.test(text);
}

function evaluateRule(rule: QualityBenchmarkRule, chapters: DocumentDraftChapter[], markdown?: string) {
  const text = textOf(chapters, markdown);
  const keywordCount = countMatches(text, rule.keywords);
  const titleCount = titleMatches(chapters, rule.titlePatterns);
  const requiredCounts = [
    rule.keywords?.length ? keywordCount / rule.keywords.length : undefined,
    rule.titlePatterns?.length ? titleCount / rule.titlePatterns.length : undefined,
    rule.tableRequired ? (hasTable(text) ? 1 : 0) : undefined,
  ].filter((value): value is number => typeof value === 'number');
  const ratio = requiredCounts.length ? requiredCounts.reduce((sum, value) => sum + value, 0) / requiredCounts.length : 1;
  const minRatioPassed = rule.minRatio == null || ratio >= rule.minRatio;
  const minCountPassed = rule.minCount == null || keywordCount + titleCount >= rule.minCount;
  const passed = minRatioPassed && minCountPassed;
  return { passed, ratio, keywordCount, titleCount };
}

export function validateDocumentQualityBenchmark(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; markdown?: string }): QualityBenchmarkResult[] {
  const benchmarks = readEngineeringDocumentConfig().qualityBenchmarks.filter(benchmark => matchTemplate(input.template, benchmark));
  return benchmarks.map(benchmark => {
    let earned = 0;
    let total = 0;
    const issues: ValidationIssue[] = [];
    for (const rule of benchmark.rules) {
      const weight = Math.max(0, rule.weight || 0);
      total += weight;
      const result = evaluateRule(rule, input.chapters, input.markdown);
      if (result.passed) earned += weight;
      else issues.push({ level: rule.level || 'warning', message: `质量基准未达标：${rule.name}`, suggestion: rule.suggestion || '请补充专业细节、表格或对应章节内容。' });
    }
    const score = total > 0 ? Math.round((earned / total) * 100) : 100;
    const blocked = score < benchmark.blockBelowScore || issues.some(issue => issue.level === 'error');
    return {
      benchmarkId: benchmark.id,
      benchmarkName: benchmark.name,
      score,
      pass: score >= benchmark.passScore,
      blocked,
      issues: blocked ? [{ level: 'error', message: `文档质量基准评分未达标：${benchmark.name} ${score}分`, suggestion: '请重新生成或补充模板、资料、章节内容后再导出。' }, ...issues] : issues,
    };
  });
}
