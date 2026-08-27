import { describe, expect, it, vi } from 'vitest';
import { selectEvidenceByBudget } from '../src/services/document-workflow/evidence';
import { optimizeChapterEvidence, retrieveSectionEvidence, semanticEvidenceText } from '../src/services/document-workflow/documentGeneratorHelpers';
import { buildSemanticSimilarity } from '../src/services/document-workflow/semanticSimilarity';
import { createGenerationDiagnostics } from '../src/services/document-workflow/rolePipeline';
import type { DocumentTemplateChapter } from '../src/services/document-workflow/types';

function diagnosticsFixture() {
  return createGenerationDiagnostics({ id: 'test', label: '测试策略', evidenceItemsPerChapter: 30, concurrency: 2 } as never);
}

describe('selectEvidenceByBudget 预算裁剪可观测', () => {
  it('records items dropped by budget into diagnostics.evidence.budgetDropped', () => {
    const diagnostics = diagnosticsFixture();
    const items = Array.from({ length: 10 }, (_, index) => ({
      filePath: `evidence-${index}.md`,
      chapterId: 'c1',
      content: `第${index}份证据内容：本项目施工按规范组织。`,
      sectionTitle: `小节${index}`,
      score: 10 - index,
      source: undefined,
    })) as never;
    const selected = selectEvidenceByBudget(items as never[], { maxItems: 3 }, diagnostics);
    expect(selected.length).toBeLessThanOrEqual(3);
    expect(diagnostics.evidence.budgetDropped).toBeGreaterThan(0);
  });
});

describe('optimizeChapterEvidence 语义排序主键', () => {
  const chapter = { id: 'c1', title: '新技术新工艺应用', purpose: '', queries: [], requiredFacts: [], sections: ['新技术应用'] } as unknown as DocumentTemplateChapter;

  it('keeps semantically relevant evidence within budget even with equal base scores', () => {
    const evidence = [
      { filePath: 'unrelated.md', chapterId: 'c1', content: '本章内容与新技术无关，仅记录常规工序安排。'.repeat(6), sectionTitle: '其他内容', score: 5, source: undefined },
      { filePath: 'relevant.md', chapterId: 'c1', content: '本项目采用新技术新工艺组织施工应用。'.repeat(6), sectionTitle: '四新技术', score: 5, source: undefined },
    ] as never[];
    const similarity = (leftText: string, rightText: string) => (rightText.includes('新技术') ? 0.9 : 0.1);
    const selected = optimizeChapterEvidence(chapter, evidence as never[], { maxItems: 1, maxChars: 100000, semantic: { similarity, queryText: semanticEvidenceText({ sectionTitle: '', content: '新技术新工艺应用' }) } });
    expect(selected[0]!.filePath).toBe('relevant.md');
  });

  it('falls back to base score ordering when semantic option is absent', () => {
    const evidence = [
      { filePath: 'low.md', chapterId: 'c1', content: '低分常规内容。'.repeat(10), sectionTitle: '其他', score: 1, source: undefined },
      { filePath: 'high.md', chapterId: 'c1', content: '高分量化内容，含 100㎡ 与 30 日历天参数。'.repeat(6), sectionTitle: '量化', score: 9, source: undefined },
    ] as never[];
    const selected = optimizeChapterEvidence(chapter, evidence as never[], { maxItems: 1, maxChars: 100000 });
    expect(selected[0]!.filePath).toBe('high.md');
  });
});

describe('buildSemanticSimilarity 闭包缓存', () => {
  it('computes cosine over injected embeddings and caches vectors per text', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(text => {
      const vector = [0, 0];
      if (text.includes('新技术')) vector[0] = 1;
      if (text.includes('施工')) vector[1] = 1;
      return vector;
    }));
    const similarity = await buildSemanticSimilarity(['新技术施工'], ['新技术与新工艺'], embed);
    expect(similarity).toBeDefined();
    expect(embed).toHaveBeenCalledTimes(1);
    expect(similarity!('新技术施工', '新技术与新工艺')).toBe(1);
  });

  it('returns undefined for empty inputs and for unknown cache keys returns 0', async () => {
    expect(await buildSemanticSimilarity([], ['x'])).toBeUndefined();
    const similarity = await buildSemanticSimilarity(['a'], ['b'], async (texts: string[]) => texts.map(() => [1, 0]));
    expect(similarity!('a', 'unknown')).toBe(0);
  });
});

describe('retrieveSectionEvidence 小节检索打开 reranker', () => {
  it('does not disable the LocalReranker cross encoder', async () => {
    const search = vi.fn(async (_root: string, _query: string, options: Record<string, unknown>) => {
      expect(options.disableReranker).not.toBe(true);
      return { results: [] };
    });
    const chapter = { id: 'c1', title: '质量保证体系', sections: ['质量检查'], requiredFacts: [] } as unknown as DocumentTemplateChapter;
    const evidence = await retrieveSectionEvidence({
      manager: { search } as never,
      projectRoot: '/tmp/project',
      chapter,
      sectionTitle: '质量检查',
      scopedFilePaths: ['a.md'],
      fileRoleByPath: new Map(),
      fileProcessingByPath: new Map(),
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(evidence).toEqual([]);
  });
});
