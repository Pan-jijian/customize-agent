import type { AutoDocumentSpecPackage } from './autoDocumentSpecTypes';
import type { DocumentDraftChapter, ValidationIssue } from './documentWorkflowService';

export interface ChapterReadiness {
  chapterId: string;
  title: string;
  requiredFacts: string[];
  coveredFacts: string[];
  missingFacts: string[];
  evidenceCount: number;
  readinessRate: number;
}

function unique(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}

export function evaluateChapterReadiness(chapters: DocumentDraftChapter[], spec: AutoDocumentSpecPackage): ChapterReadiness[] {
  return chapters.map(chapter => {
    const rule = spec.chapterRules.find(item => item.id === chapter.id || item.title === chapter.title);
    const requiredFacts = unique([...(chapter.missingFacts || []), ...(rule?.requiredFactIds || [])]);
    const coveredFacts = requiredFacts.filter(fact => !chapter.missingFacts.includes(fact));
    const missingFacts = requiredFacts.filter(fact => chapter.missingFacts.includes(fact));
    const evidenceScore = chapter.evidence.length > 0 ? 1 : 0;
    const factScore = requiredFacts.length ? coveredFacts.length / requiredFacts.length : 1;
    return {
      chapterId: chapter.id,
      title: chapter.title,
      requiredFacts,
      coveredFacts,
      missingFacts,
      evidenceCount: chapter.evidence.length,
      readinessRate: Math.min(1, (factScore * 0.7) + (evidenceScore * 0.3)),
    };
  });
}

export function chapterReadinessIssues(readiness: ChapterReadiness[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const item of readiness) {
    if (item.evidenceCount === 0) issues.push({ level: 'error', message: `章节缺少证据：${item.title}`, suggestion: '请补充对应项目资料或调整模板章节检索词。' });
    else if (item.readinessRate < 0.5) issues.push({ level: 'warning', message: `章节事实覆盖率较低：${item.title} ${Math.round(item.readinessRate * 100)}%`, suggestion: '建议补充章节 requiredFacts 或项目资料证据。' });
  }
  return issues;
}

export function chapterReadinessPrompt(readiness: ChapterReadiness[]) {
  return [
    '## 章节级事实覆盖率',
    ...readiness.map(item => `${item.title}：${Math.round(item.readinessRate * 100)}%，证据 ${item.evidenceCount} 条${item.missingFacts.length ? `，缺失 ${item.missingFacts.join('、')}` : ''}`),
  ].join('\n');
}
