import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { DocumentDraftChapter, ValidationIssue } from '../document-workflow/types';

export interface ChapterReadiness {
  chapterId: string;
  title: string;
  requiredFacts: string[];
  coveredFacts: string[];
  missingFacts: string[];
  evidenceCount: number;
}

function unique(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}

export function evaluateChapterReadiness(chapters: DocumentDraftChapter[], spec: AutoDocumentSpecPackage): ChapterReadiness[] {
  return chapters.map(chapter => {
    const rule = spec.chapterRules.find(item => item.id === chapter.id || item.title === chapter.title);
    const specFacts = (rule?.requiredFactIds || [])
      .map(id => spec.factFields.find(field => field.id === id)?.name)
      .filter(Boolean) as string[];
    const requiredFacts = unique([...(chapter.missingFacts || []), ...specFacts]);
    const coveredFacts = requiredFacts.filter(fact => !chapter.missingFacts.includes(fact));
    const missingFacts = requiredFacts.filter(fact => chapter.missingFacts.includes(fact));
    return {
      chapterId: chapter.id,
      title: chapter.title,
      requiredFacts,
      coveredFacts,
      missingFacts,
      evidenceCount: chapter.evidence.length,
    };
  });
}

export function chapterReadinessIssues(readiness: ChapterReadiness[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const item of readiness) {
    if (item.evidenceCount === 0) issues.push({ level: 'error', message: `章节缺少证据：${item.title}`, suggestion: '请补充对应绑定材料或调整模板章节检索词。' });
    else if (item.missingFacts.length > 0) issues.push({ level: 'warning', message: `章节事实覆盖不足：${item.title}，缺失 ${item.missingFacts.slice(0, 6).join('、')}`, suggestion: '建议补充章节 requiredFacts 或绑定材料证据。' });
  }
  return issues;
}
