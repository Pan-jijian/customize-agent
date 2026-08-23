import { describe, expect, it } from 'vitest';
import { buildGenerationBudget } from '../src/services/document-workflow/generationBudget';
import { selectDocumentGenerationStrategy } from '../src/services/document-workflow/rolePipeline';
import type { DocumentTemplate, DocumentTemplateChapter } from '../src/services/document-workflow/types';

function makeTemplate(chapterCount: number, name = '测试模板'): { template: DocumentTemplate; chapters: DocumentTemplateChapter[] } {
  const chapters: DocumentTemplateChapter[] = Array.from({ length: chapterCount }, (_, index) => ({
    id: `ch-${index}`,
    title: `第${index + 1}章 测试章节`,
    purpose: '',
    sections: [],
    queries: [],
    requiredFacts: [],
    tablePlans: [],
    pinnedEvidenceFilePaths: [],
  }));
  const template = { id: 'tpl-test', name, category: '自定义', description: '', outputTitle: name, chapters, promptIds: [], promptBindings: [], projectBindings: [], exportSettings: {}, generationSettings: {}, version: 1, updatedAt: Date.now(), changeLog: [] } as unknown as DocumentTemplate;
  return { template, chapters };
}

describe('selectDocumentGenerationStrategy', () => {
  it('风险领域关键词触发 strict', () => {
    const { template } = makeTemplate(5);
    const strategy = selectDocumentGenerationStrategy({ template, targetWords: 20000, requirement: '本项目包含危大工程专项施工方案', materialFileCount: 8, evidenceCount: 40 });
    expect(strategy.mode).toBe('strict');
    expect(strategy.enableGlobalReview).toBe(true);
    expect(strategy.globalReviewSamplingRate).toBe(1);
  });

  it('超长文档触发 strict（≥4 万字）', () => {
    const { template } = makeTemplate(5, '常规房建模板');
    const strategy = selectDocumentGenerationStrategy({ template, targetWords: 50000, materialFileCount: 8, evidenceCount: 40 });
    expect(strategy.mode).toBe('strict');
  });

  it('资料稀疏触发 strict', () => {
    const { template } = makeTemplate(5, '常规房建模板');
    const strategy = selectDocumentGenerationStrategy({ template, targetWords: 20000, materialFileCount: 2, evidenceCount: 3 });
    expect(strategy.mode).toBe('strict');
  });

  it('小文档 fast：全局审查降级为抽检', () => {
    const { template } = makeTemplate(3, '小型方案');
    const strategy = selectDocumentGenerationStrategy({ template, targetWords: 4000, materialFileCount: 5, evidenceCount: 20 });
    expect(strategy.mode).toBe('fast');
    expect(strategy.globalReviewSamplingRate).toBe(0.35);
  });

  it('长文档 longform', () => {
    const { template } = makeTemplate(9, '常规房建模板');
    const strategy = selectDocumentGenerationStrategy({ template, targetWords: 35000, materialFileCount: 8, evidenceCount: 40 });
    expect(strategy.mode).toBe('longform');
  });

  it('常规文档 balanced，修复轮次预算默认 3', () => {
    const { template } = makeTemplate(6, '常规房建模板');
    const strategy = selectDocumentGenerationStrategy({ template, targetWords: 15000, materialFileCount: 8, evidenceCount: 40 });
    expect(strategy.mode).toBe('balanced');
    expect(strategy.repairRoundBudget).toBe(3);
  });
});

describe('buildGenerationBudget', () => {
  const strategy = selectDocumentGenerationStrategy({ template: makeTemplate(6, '常规房建模板').template, targetWords: 15000, materialFileCount: 8, evidenceCount: 40 });

  it('按章节数与篇幅计算并发', () => {
    const { template, chapters } = makeTemplate(10);
    const budget = buildGenerationBudget({ template, chapters, targetWords: 15000, materialFileCount: 8, evidenceCount: 40, hasVeryLargeExplicitChapter: false, configuredChapterConcurrency: 0, strategy });
    expect(budget.chapterConcurrency).toBeGreaterThanOrEqual(2);
    expect(budget.chapterConcurrency).toBeLessThanOrEqual(4);
    expect(budget.reviewConcurrency).toBe(2);
  });

  it('超长显式小节章降为单章并发', () => {
    const { template, chapters } = makeTemplate(5);
    const budget = buildGenerationBudget({ template, chapters, targetWords: 12000, materialFileCount: 8, evidenceCount: 40, hasVeryLargeExplicitChapter: true, configuredChapterConcurrency: 0, strategy });
    expect(budget.chapterConcurrency).toBe(1);
  });

  it('显式环境变量覆盖章节并发', () => {
    const { template, chapters } = makeTemplate(8);
    const budget = buildGenerationBudget({ template, chapters, targetWords: 20000, materialFileCount: 8, evidenceCount: 40, hasVeryLargeExplicitChapter: false, configuredChapterConcurrency: 3, strategy });
    expect(budget.chapterConcurrency).toBe(3);
  });

  it('fast 策略审查流水线串行', () => {
    const fastStrategy = selectDocumentGenerationStrategy({ template: makeTemplate(3, '小型方案').template, targetWords: 4000, materialFileCount: 5, evidenceCount: 20 });
    const { template, chapters } = makeTemplate(3, '小型方案');
    const budget = buildGenerationBudget({ template, chapters, targetWords: 4000, materialFileCount: 5, evidenceCount: 20, hasVeryLargeExplicitChapter: false, configuredChapterConcurrency: 0, strategy: fastStrategy });
    expect(budget.reviewConcurrency).toBe(1);
  });

  it('证据预算区间随篇幅收缩', () => {
    const shortStrategy = selectDocumentGenerationStrategy({ template: makeTemplate(3, '小型方案').template, targetWords: 4000, materialFileCount: 5, evidenceCount: 20 });
    const { template, chapters } = makeTemplate(3, '小型方案');
    const shortBudget = buildGenerationBudget({ template, chapters, targetWords: 4000, materialFileCount: 5, evidenceCount: 20, hasVeryLargeExplicitChapter: false, configuredChapterConcurrency: 0, strategy: shortStrategy });
    expect(shortBudget.evidenceCeilingChars).toBeLessThanOrEqual(12000);
    expect(shortBudget.repairRoundBudget).toBe(3);
    expect(shortBudget.triggers.some(trigger => trigger.includes('章节并发'))).toBe(true);
  });
});
