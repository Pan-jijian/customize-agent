/**
 * chapterReadiness 单测：章节生成准备度计划（事实缺失/表格缺口/证据不足/风险分级/策略建议）。
 */
import { describe, expect, it } from 'vitest';
import { buildChapterReadinessPlan } from './chapterReadiness';
import type { DocumentTemplateChapter, DocumentEvidence, ProjectGraphTablePlan } from './types';

function makeChapter(overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id: 'c1', title: '施工部署', purpose: '', queries: [], requiredFacts: [], ...overrides };
}

function makeEvidence(overrides: Partial<DocumentEvidence> = {}): DocumentEvidence {
  return { chapterId: 'c1', filePath: '/f.pdf', score: 1, sectionTitle: '', content: '', ...overrides };
}

function makeTablePlan(missingProjectFactFields: string[]): ProjectGraphTablePlan {
  return {
    id: 't1',
    title: '计划表',
    chapterTitle: '施工部署',
    moduleTitle: '模块',
    required: true,
    reason: '测试',
    fields: [],
    sourceDomains: [],
    fillability: {
      requiredFieldCount: 4,
      confirmedFieldCount: 2,
      missingProjectFactFields,
      canGenerate: false,
      fallbackPolicy: 'generate_with_review_notes',
    },
  };
}

describe('buildChapterReadinessPlan', () => {
  it('全满足 → low 风险 + normal 策略', () => {
    const plan = buildChapterReadinessPlan({
      chapter: makeChapter({ requiredFacts: ['计划工期'] }),
      evidence: [
        makeEvidence({ content: '计划工期为300日历天' }),
        makeEvidence({ content: '质量目标合格' }),
        makeEvidence({ content: '安全目标零事故' }),
      ],
    });
    expect(plan.canGenerate).toBe(true);
    expect(plan.riskLevel).toBe('low');
    expect(plan.suggestedStrategy).toBe('normal');
    expect(plan.missingFacts).toEqual([]);
    expect(plan.missingEvidence).toEqual([]);
    expect(plan.reason).toContain('满足常规生成条件');
  });

  it('事实缺失（含空白归一）→ section_first 策略', () => {
    const plan = buildChapterReadinessPlan({
      chapter: makeChapter({ requiredFacts: ['计划工期', '质量标准'] }),
      evidence: [
        makeEvidence({ content: '计 划 工期为300天' }),
        makeEvidence({ content: '证据二' }),
        makeEvidence({ content: '证据三' }),
      ],
    });
    expect(plan.missingFacts).toEqual(['质量标准']);
    expect(plan.suggestedStrategy).toBe('section_first');
    expect(plan.riskLevel).toBe('low');
  });

  it('表格缺口 → generate_with_review_notes 策略并去重', () => {
    const plan = buildChapterReadinessPlan({
      chapter: makeChapter({
        tablePlans: [makeTablePlan(['a', 'b', 'a'])],
      }),
      evidence: [makeEvidence(), makeEvidence(), makeEvidence()],
    });
    expect(plan.tableFieldGaps).toEqual(['a', 'b']);
    expect(plan.suggestedStrategy).toBe('generate_with_review_notes');
  });

  it('证据不足 → 记入缺口', () => {
    const plan = buildChapterReadinessPlan({
      chapter: makeChapter(),
      evidence: [makeEvidence()],
    });
    expect(plan.missingEvidence).toEqual(['章节证据数量不足']);
    expect(plan.riskLevel).toBe('low');
  });

  it('缺口 ≥5 → high 风险 + evidence_first 策略', () => {
    const plan = buildChapterReadinessPlan({
      chapter: makeChapter({
        requiredFacts: ['f1', 'f2', 'f3'],
        tablePlans: [makeTablePlan(['g1', 'g2'])],
      }),
      evidence: [makeEvidence()],
    });
    expect(plan.riskLevel).toBe('high');
    expect(plan.suggestedStrategy).toBe('evidence_first');
    expect(plan.reason).toContain('6 项生成前缺口');
  });
});
