/**
 * generationBudget 单测：章节/审查/LLM 并发预算、证据预算三档、修复轮次与总池动态计算、
 * 策略触发原因记录、生成前体检预算预览（依赖 selectDocumentGenerationStrategy 纯逻辑）。
 */
import { describe, expect, it } from 'vitest';
import { buildGenerationBudget, previewGenerationBudgetForTemplate } from '@/services/document-workflow/generationBudget';
import { concurrencyForDocumentScale } from '@/services/document-workflow/llmClient';
import type { DocumentGenerationStrategy, DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';

const chapter = (title: string): DocumentTemplateChapter => ({
  id: `c-${title}`,
  title,
  purpose: `${title}写作目标`,
  queries: [`${title}资料查询`],
  requiredFacts: [`${title}事实`],
});

const template = (overrides: Partial<DocumentTemplate> = {}): DocumentTemplate => ({
  id: 't1',
  name: '施工组织设计',
  description: '',
  category: '施工组织设计',
  outputTitle: '合肥某安置房项目施工组织设计',
  chapters: [chapter('工程概况'), chapter('施工部署')],
  ...overrides,
});

const strategy = (overrides: Partial<DocumentGenerationStrategy> = {}): DocumentGenerationStrategy => ({
  mode: 'balanced',
  enableChapterReview: true,
  enableGlobalReview: true,
  enableDocumentBudgetExpansion: false,
  enableFinalQualityReview: true,
  globalReviewSamplingRate: 1,
  ...overrides,
});

const budgetInput = (overrides: Partial<Parameters<typeof buildGenerationBudget>[0]> = {}) => ({
  template: template(),
  chapters: [chapter('工程概况'), chapter('施工部署'), chapter('施工进度计划'), chapter('质量保证措施'), chapter('安全文明施工措施')],
  targetWords: 10000,
  requirement: '',
  materialFileCount: 10,
  evidenceCount: 20,
  hasVeryLargeExplicitChapter: false,
  configuredChapterConcurrency: 0,
  strategy: strategy(),
  ...overrides,
});

describe('buildGenerationBudget 并发预算', () => {
  it('章节生成并发默认全并行（等于章数）', () => {
    const budget = buildGenerationBudget(budgetInput());
    expect(budget.chapterConcurrency).toBe(5);
    expect(budget.reviewConcurrency).toBe(5);
  });

  it('configuredChapterConcurrency 显式调低并向下取整', () => {
    const budget = buildGenerationBudget(budgetInput({ configuredChapterConcurrency: 2.7 }));
    expect(budget.chapterConcurrency).toBe(2);
  });

  it('configuredChapterConcurrency 超过章数时按章数封顶', () => {
    const budget = buildGenerationBudget(budgetInput({ configuredChapterConcurrency: 99 }));
    expect(budget.chapterConcurrency).toBe(5);
  });

  it('chapters 为空时并发至少为 1', () => {
    const budget = buildGenerationBudget(budgetInput({ chapters: [] }));
    expect(budget.chapterConcurrency).toBe(1);
    expect(budget.reviewConcurrency).toBe(1);
  });

  it('fast 模式审查并发降为 1（串行审查）', () => {
    const budget = buildGenerationBudget(budgetInput({ strategy: strategy({ mode: 'fast' }) }));
    expect(budget.chapterConcurrency).toBe(5);
    expect(budget.reviewConcurrency).toBe(1);
  });

  it('llmConcurrency 与 concurrencyForDocumentScale 一致（所有规模统一）', () => {
    const budget = buildGenerationBudget(budgetInput({ targetWords: 10000 }));
    expect(budget.llmConcurrency).toBe(concurrencyForDocumentScale(10000));
  });
});

describe('buildGenerationBudget 证据预算', () => {
  it('平均章节 ≥6000 字 → 14k-40k 高档', () => {
    // 10 章 60000 字 → avg 6000
    const budget = buildGenerationBudget(budgetInput({ targetWords: 60000, chapters: Array.from({ length: 10 }, (_, i) => chapter(`第${i}章`)) }));
    expect(budget.evidenceFloorChars).toBe(14000);
    expect(budget.evidenceCeilingChars).toBe(40000);
  });

  it('平均章节 3000-5999 字 → 11k-28k 中档', () => {
    // 10 章 40000 字 → avg 4000
    const budget = buildGenerationBudget(budgetInput({ targetWords: 40000, chapters: Array.from({ length: 10 }, (_, i) => chapter(`第${i}章`)) }));
    expect(budget.evidenceFloorChars).toBe(11000);
    expect(budget.evidenceCeilingChars).toBe(28000);
  });

  it('平均章节 <3000 字 → 8k-18k 低档', () => {
    const budget = buildGenerationBudget(budgetInput({ targetWords: 10000 }));
    expect(budget.evidenceFloorChars).toBe(8000);
    expect(budget.evidenceCeilingChars).toBe(18000);
  });

  it('targetWords 为 0 时按 1200 字兜底 → 低档', () => {
    const budget = buildGenerationBudget(budgetInput({ targetWords: 0 }));
    expect(budget.evidenceFloorChars).toBe(8000);
  });
});

describe('buildGenerationBudget 修复轮次预算', () => {
  it('strategy 显式指定 repairRoundBudget 时优先采用', () => {
    const budget = buildGenerationBudget(budgetInput({ strategy: strategy({ repairRoundBudget: 6 }) }));
    expect(budget.repairRoundBudget).toBe(6);
  });

  it('常规规模默认 2 轮', () => {
    const budget = buildGenerationBudget(budgetInput());
    expect(budget.repairRoundBudget).toBe(2);
  });

  it('目标 ≥2 万字篇幅加成 1 轮', () => {
    const budget = buildGenerationBudget(budgetInput({ targetWords: 25000 }));
    expect(budget.repairRoundBudget).toBe(3);
  });

  it('资料稀疏（文件 <4 且证据 <6）加成 1 轮', () => {
    const budget = buildGenerationBudget(budgetInput({ materialFileCount: 2, evidenceCount: 3 }));
    expect(budget.repairRoundBudget).toBe(3);
  });

  it('篇幅与稀疏双加成 → 4 轮（封顶 4）', () => {
    const budget = buildGenerationBudget(budgetInput({ targetWords: 25000, materialFileCount: 2, evidenceCount: 3 }));
    expect(budget.repairRoundBudget).toBe(4);
  });

  it('文档级总池 = min(每章上限×章数, max(12, 2×章数))', () => {
    // 3 章 × 2 轮 = 6 → min(6, 12) = 6
    const small = buildGenerationBudget(budgetInput({ chapters: [chapter('工程概况'), chapter('施工部署'), chapter('施工进度计划')] }));
    expect(small.repairPoolBudget).toBe(6);
    // 12 章 × 2 轮 = 24 → min(24, max(12, 24)) = 24
    const medium = buildGenerationBudget(budgetInput({ chapters: Array.from({ length: 12 }, (_, i) => chapter(`第${i}章`)) }));
    expect(medium.repairPoolBudget).toBe(24);
    // 20 章 × 4 轮（稀疏+长文）= 80 → 封顶 max(12, 40) = 40
    const large = buildGenerationBudget(budgetInput({ targetWords: 60000, materialFileCount: 2, evidenceCount: 3, chapters: Array.from({ length: 20 }, (_, i) => chapter(`第${i}章`)) }));
    expect(large.repairPoolBudget).toBe(40);
  });
});

describe('buildGenerationBudget 触发原因', () => {
  it('strict 模式记录风险领域触发词', () => {
    const budget = buildGenerationBudget(budgetInput({ strategy: strategy({ mode: 'strict' }) }));
    expect(budget.triggers.some(trigger => trigger.startsWith('strict：风险领域关键词命中'))).toBe(true);
  });

  it('目标 ≥4 万字记录超长篇幅触发词', () => {
    const budget = buildGenerationBudget(budgetInput({ targetWords: 45000 }));
    expect(budget.triggers.some(trigger => trigger.includes('目标篇幅超长'))).toBe(true);
  });

  it('资料稀疏记录触发词', () => {
    const budget = buildGenerationBudget(budgetInput({ materialFileCount: 2, evidenceCount: 3 }));
    expect(budget.triggers.some(trigger => trigger.includes('资料稀疏'))).toBe(true);
  });

  it('fast/longform/balanced 模式各记录对应触发词', () => {
    expect(buildGenerationBudget(budgetInput({ strategy: strategy({ mode: 'fast' }) })).triggers.some(t => t.startsWith('fast：'))).toBe(true);
    expect(buildGenerationBudget(budgetInput({ strategy: strategy({ mode: 'longform' }) })).triggers.some(t => t.startsWith('longform：'))).toBe(true);
    expect(buildGenerationBudget(budgetInput({ strategy: strategy({ mode: 'balanced' }) })).triggers.some(t => t.startsWith('balanced：'))).toBe(true);
  });

  it('末条触发说明包含并发与预算汇总', () => {
    const budget = buildGenerationBudget(budgetInput());
    const last = budget.triggers.at(-1)!;
    expect(last).toContain('全章节并行生成（5/5 章同批）');
    expect(last).toContain('修复轮次预算每章 2 轮');
  });
});

describe('previewGenerationBudgetForTemplate', () => {
  it('小文档（≤6000 字 ≤4 章无风险词）→ fast 模式', () => {
    const preview = previewGenerationBudgetForTemplate({
      template: template({ name: '内部工作纪要', category: '纪要' }),
      chapters: [chapter('会议内容'), chapter('工作安排')],
      materialFileCount: 10,
      evidenceCount: 10,
      targetWords: 3000,
    });
    expect(preview.mode).toBe('fast');
    // fast 抽检率与全局审查开关联动：开启时 0.35，关闭时 1
    expect(preview.globalReviewSamplingRate).toBe(preview.enableGlobalReview ? 0.35 : 1);
  });

  it('风险领域关键词 → strict 模式', () => {
    const preview = previewGenerationBudgetForTemplate({
      template: template({ name: '深基坑安全专项方案' }),
      chapters: [chapter('专项措施')],
      requirement: '安全验收合规',
      materialFileCount: 10,
      evidenceCount: 10,
      targetWords: 8000,
    });
    expect(preview.mode).toBe('strict');
  });

  it('资料稀疏 → strict 模式', () => {
    const preview = previewGenerationBudgetForTemplate({
      template: template({ name: '内部纪要' }),
      chapters: [chapter('会议内容')],
      materialFileCount: 2,
      evidenceCount: 3,
      targetWords: 8000,
    });
    expect(preview.mode).toBe('strict');
  });

  it('targetWords 缺省时按 0 估算且章节数兜底为 1', () => {
    const preview = previewGenerationBudgetForTemplate({
      template: template({ name: '内部纪要' }),
      chapters: [],
      materialFileCount: 10,
      evidenceCount: 10,
    });
    expect(preview.targetWords).toBe(0);
    expect(preview.chapterCount).toBe(1);
  });

  it('预览字段完整映射预算结果', () => {
    const preview = previewGenerationBudgetForTemplate({
      template: template(),
      chapters: [chapter('工程概况'), chapter('施工部署'), chapter('施工进度计划')],
      materialFileCount: 10,
      evidenceCount: 10,
      targetWords: 12000,
    });
    expect(preview.chapterCount).toBe(3);
    expect(preview.chapterConcurrency).toBe(3);
    expect(preview.reviewConcurrency).toBe(3);
    expect(preview.evidenceFloorChars).toBe(11000); // avg 4000 → 中档
    expect(preview.evidenceCeilingChars).toBe(28000);
    expect(preview.repairRoundBudget).toBe(2);
    expect(preview.triggers.length).toBeGreaterThan(0);
  });
});
