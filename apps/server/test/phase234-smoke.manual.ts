import { describe, expect, it } from 'vitest';
import { previewGenerationBudgetForTemplate } from '../src/services/document-workflow/generationBudget';
import { validateDocumentTemplateRun } from '../src/services/document-workflow/templateStore';
import { getProjectRoot } from '../src/services/knowledge/kbService';
import type { DocumentTemplate, DocumentTemplateChapter } from '../src/services/document-workflow/types';

function makeTemplate(chapterCount: number, name = '冒烟模板'): { template: DocumentTemplate; chapters: DocumentTemplateChapter[] } {
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
  const template = { id: 'tpl-smoke', name, category: '自定义', description: '', outputTitle: name, chapters, promptIds: [], promptBindings: [], projectBindings: [], exportSettings: {}, generationSettings: {}, version: 1, updatedAt: Date.now(), changeLog: [] } as unknown as DocumentTemplate;
  return { template, chapters };
}

describe('三期改造冒烟', () => {
  it('U1 策略预估：fast 小文档（全局审查降级 + 章节数 + 目标字数）', () => {
    const { template, chapters } = makeTemplate(3, '小型方案');
    const preview = previewGenerationBudgetForTemplate({ template, chapters, requirement: '常规小型项目', materialFileCount: 5, evidenceCount: 20, targetWords: 4000 });
    expect(preview.mode).toBe('fast');
    expect(preview.enableGlobalReview).toBe(true);
    expect(preview.globalReviewSamplingRate).toBe(0.35);
    expect(preview.chapterCount).toBe(3);
    expect(preview.targetWords).toBe(4000);
    expect(preview.triggers).toBeInstanceOf(Array);
  });

  it('U1 策略预估：strict 风险关键词（全量审查 + 修复轮次预算）', () => {
    const { template, chapters } = makeTemplate(5);
    const preview = previewGenerationBudgetForTemplate({ template, chapters, requirement: '本项目包含危大工程专项施工方案', materialFileCount: 8, evidenceCount: 40, targetWords: 20000 });
    expect(preview.mode).toBe('strict');
    expect(preview.globalReviewSamplingRate).toBe(1);
    expect(preview.repairRoundBudget).toBeGreaterThanOrEqual(3);
  });

  it('B2/U1：validateDocumentTemplateRun 对内置模板返回 roleDiagnostics 与 strategyPreview 字段', async () => {
    const { templates } = await import('../src/services/document-workflow/templateStore').then(m => ({ templates: m.listDocumentTemplates() }));
    if (templates.length === 0) {
      console.log('SKIP: 无可用模板数据');
      return;
    }
    const projectRoot = getProjectRoot();
    const validation = await validateDocumentTemplateRun(templates[0]!.id, projectRoot);
    expect(validation.roleDiagnostics).toBeInstanceOf(Array);
    if (validation.roleDiagnostics.length > 0) {
      const first = validation.roleDiagnostics[0]!;
      expect(['ok', 'missing_prompt', 'missing_resource', 'role_missing']).toContain(first.status);
      expect(first.roleId).toBeTruthy();
      expect(first.resourceIds).toBeInstanceOf(Array);
      expect(first.boundPromptIds).toBeInstanceOf(Array);
    }
    if (validation.strategyPreview) {
      expect(['fast', 'balanced', 'longform', 'strict']).toContain(validation.strategyPreview.mode);
      expect(validation.strategyPreview.chapterCount).toBeGreaterThanOrEqual(1);
      expect(validation.strategyPreview.targetWords).toBeGreaterThan(0);
    }
    console.log('SMOKE template:', templates[0]!.name, '| roleDiagnostics:', validation.roleDiagnostics.length, '| strategyPreview mode:', validation.strategyPreview?.mode, '| issues:', validation.issues.length);
  }, 60000);
});
