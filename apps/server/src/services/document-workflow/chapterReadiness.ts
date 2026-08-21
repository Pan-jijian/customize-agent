import type { ChapterReadinessPlan, DocumentTemplateChapter, DocumentEvidence } from './types';

function normalize(text: string) {
  return text.replace(/\s+/gu, '').toLowerCase();
}

export function buildChapterReadinessPlan(input: { chapter: DocumentTemplateChapter; evidence: DocumentEvidence[] }): ChapterReadinessPlan {
  const missingFacts = (input.chapter.requiredFacts || []).filter(fact => !input.evidence.some(item => normalize(`${item.sectionTitle || ''}${item.content || ''}`).includes(normalize(fact))));
  const tableFieldGaps = (input.chapter.tablePlans || []).flatMap(plan => plan.fillability?.missingProjectFactFields || []);
  const missingEvidence = input.evidence.length < 3 ? ['章节证据数量不足'] : [];
  const issueCount = missingFacts.length + tableFieldGaps.length + missingEvidence.length;
  const riskLevel: ChapterReadinessPlan['riskLevel'] = issueCount >= 5 ? 'high' : issueCount >= 2 ? 'medium' : 'low';
  const suggestedStrategy: ChapterReadinessPlan['suggestedStrategy'] = riskLevel === 'high'
    ? 'evidence_first'
    : tableFieldGaps.length > 0
      ? 'generate_with_review_notes'
      : missingFacts.length > 0
        ? 'section_first'
        : 'normal';
  return {
    chapterId: input.chapter.id,
    chapterTitle: input.chapter.title,
    canGenerate: true,
    riskLevel,
    missingFacts,
    missingEvidence,
    tableFieldGaps: [...new Set(tableFieldGaps)],
    suggestedStrategy,
    reason: issueCount === 0 ? '章节事实、证据和表格可填性满足常规生成条件。' : `识别到 ${issueCount} 项生成前缺口，按 ${suggestedStrategy} 策略生成。`,
  };
}
