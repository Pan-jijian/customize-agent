import { documentTextLength } from './budget';
import type { ChapterCoverageReport, DocumentDraftChapter, DocumentFactsModel, DocumentTemplateChapter, ValidationIssue } from './types';

function requiredChecks(chapter: DocumentDraftChapter, templateChapter?: DocumentTemplateChapter) {
  const text = `${chapter.title} ${(templateChapter?.sections || chapter.sections || []).join(' ')}`;
  return [
    { key: 'structure', label: '结构完整', passed: (chapter.sections || templateChapter?.sections || []).length >= 2 || /###\s+/u.test(chapter.content) },
    { key: 'depth', label: '内容深度', passed: documentTextLength(chapter.content) >= 600 },
    { key: 'evidence', label: '证据绑定', passed: (chapter.evidence || []).length > 0 },
    { key: 'professional', label: '专业控制点', passed: /验收|复核|检查|交底|控制点|整改|闭环|台账|进场|工序/u.test(chapter.content) },
    { key: 'schedule', label: '工期支撑', passed: !/进度|工期|节点/u.test(text) || /工期|节点|计划|纠偏|资源|穿插/u.test(chapter.content) },
    { key: 'quality', label: '质量验收', passed: !/质量|验收/u.test(text) || /质量|验收|复验|隐蔽|检验批|整改/u.test(chapter.content) },
    { key: 'safety', label: '安全闭环', passed: !/安全|文明|风险|危大/u.test(text) || /风险|检查|整改|应急|培训|交底/u.test(chapter.content) },
  ];
}

export function buildChapterCoverageReports(input: { chapters: DocumentDraftChapter[]; templateChapters: DocumentTemplateChapter[]; factsModel: DocumentFactsModel }): ChapterCoverageReport[] {
  return input.chapters.map(chapter => {
    const templateChapter = input.templateChapters.find(item => item.id === chapter.id || item.title === chapter.title);
    const checks = requiredChecks(chapter, templateChapter);
    const passed = checks.filter(check => check.passed).length;
    return {
      chapterId: chapter.id,
      title: chapter.title,
      score: checks.length ? Math.round((passed / checks.length) * 100) : 100,
      checks,
      action: passed === checks.length ? '章节覆盖完整。' : '系统需补齐章节结构、证据绑定、专业控制点和跨章依赖。',
    };
  });
}

export function chapterCoverageIssues(reports: ChapterCoverageReport[]): ValidationIssue[] {
  return reports.filter(report => report.score < 80).map(report => ({
    level: 'warning' as const,
    message: `章节覆盖不足：${report.title} ${report.score}%`,
    suggestion: `${report.action} 未通过项：${report.checks.filter(check => !check.passed).map(check => check.label).join('、')}`,
  }));
}
