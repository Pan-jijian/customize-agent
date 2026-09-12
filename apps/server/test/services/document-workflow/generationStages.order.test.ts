/**
 * P22 第 1 项 / P1 六阶段拆分防回归：编排器阶段调度顺序 + GenerationSession 字段传递。
 * mock 五个阶段模块与 finalizeGeneration / globalQualityGates / measureGenerationStep，
 * 断言：
 * 1. 六阶段调用顺序：stagePrepare → stageUnderstanding → stageOutlinePlanning → stageBlueprint
 *    → stageChapterLoop → finalizeGeneration（阶段 0-4 逐一 await，先于 finalize 收口）；
 * 2. 跨阶段共享状态：各阶段收到同一 session 对象（GenerationSession 显式化），
 *    stageChapterLoop 写入的 chapterDraftsFinal 原样传入 finalizeGeneration（字段传递正确）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { DocumentDraftChapter, GeneratedDocumentDraft } from '@/services/document-workflow/types';
import type { FinalizeGenerationInput } from '@/services/document-workflow/finalize/finalizeSession';
import type { GenerationSession, GenerationSessionUnderstanding } from '@/services/document-workflow/generationStages/generationSession';
import type { DocumentGenerationDiagnostics } from '@/services/document-workflow/types';

const h = vi.hoisted(() => ({
  stageOrder: [] as string[],
  sessions: [] as GenerationSession[],
  finalizeInput: null as null | FinalizeGenerationInput,
  chapterDraftsFinal: [] as DocumentDraftChapter[],
}));

vi.mock('@/services/document-workflow/generationStages/stagePrepare', () => ({
  stagePrepare: vi.fn(async (session: GenerationSession) => {
    h.stageOrder.push('stagePrepare');
    h.sessions.push(session);
  }),
}));

vi.mock('@/services/document-workflow/generationStages/stageUnderstanding', () => ({
  stageUnderstanding: vi.fn(async (session: GenerationSession) => {
    h.stageOrder.push('stageUnderstanding');
    h.sessions.push(session);
    // 编排器 L134 深层访问 canonicalFacts.scopeConflicts（finalizeGeneration 入参组装）
    session.understanding.canonicalFacts = { scopeConflicts: [] } as unknown as GenerationSessionUnderstanding['canonicalFacts'];
    session.understanding.evaluationItems = [];
  }),
}));

vi.mock('@/services/document-workflow/generationStages/stageOutlinePlanning', () => ({
  stageOutlinePlanning: vi.fn(async (session: GenerationSession) => {
    h.stageOrder.push('stageOutlinePlanning');
    h.sessions.push(session);
    // 编排器后续分支依赖 planning 子对象：balanced 画像（enableGlobalReview=false 走骨架/补节/补表确定性收口链）
    session.planning.generationStrategy = {
      mode: 'balanced',
      enableChapterReview: true,
      enableGlobalReview: false,
      enableFinalQualityReview: true,
    };
    session.planning.generationDiagnostics = { metrics: [] } as unknown as DocumentGenerationDiagnostics;
    session.planning.effectiveChapters = [];
  }),
}));

vi.mock('@/services/document-workflow/generationStages/stageBlueprint', () => ({
  stageBlueprint: vi.fn(async (session: GenerationSession) => {
    h.stageOrder.push('stageBlueprint');
    h.sessions.push(session);
  }),
}));

vi.mock('@/services/document-workflow/generationStages/stageChapterLoop', () => ({
  stageChapterLoop: vi.fn(async (session: GenerationSession) => {
    h.stageOrder.push('stageChapterLoop');
    h.sessions.push(session);
    session.chapterLoop.chapterDraftsFinal = h.chapterDraftsFinal;
    session.chapterLoop.globalReviewPhaseStartedAt = 1;
  }),
}));

vi.mock('@/services/document-workflow/documentPipeline', () => ({
  finalizeGeneration: vi.fn(async (p: FinalizeGenerationInput) => {
    h.stageOrder.push('finalizeGeneration');
    h.finalizeInput = p;
    return { templateId: 'tpl-order', chapters: [] } as unknown as GeneratedDocumentDraft;
  }),
}));

vi.mock('@/services/document-workflow/globalQualityGates', () => ({
  runGlobalConsistencyReviewLoop: vi.fn(async () => ({ issues: [] as string[], dedupRan: false })),
  enforceWorkPackageSkeletons: vi.fn(async () => undefined),
  enforcePlannedSectionCompleteness: vi.fn(async () => undefined),
  repairTableExecutionGaps: vi.fn(async () => ({ tableFixApplied: false })),
  dedupeAfterTableFix: vi.fn(async () => [] as string[]),
  reportBudgetTrimAudit: vi.fn(() => undefined),
}));

vi.mock('@/services/document-workflow/rolePipeline', () => ({
  measureGenerationStep: vi.fn(async (_diagnostics: unknown, _name: string, run: () => Promise<unknown>) => run()),
}));

import { generateDocumentDraft } from '@/services/document-workflow/documentGenerator';

describe('generateDocumentDraft 六阶段调度（P1 拆分防回归）', () => {
  it('阶段调用顺序固定：阶段 0-4 逐一 await，finalize 收口最后触发', async () => {
    h.stageOrder.length = 0;
    await generateDocumentDraft({ templateId: 'tpl-order' });
    expect(h.stageOrder).toEqual([
      'stagePrepare',
      'stageUnderstanding',
      'stageOutlinePlanning',
      'stageBlueprint',
      'stageChapterLoop',
      'finalizeGeneration',
    ]);
  });

  it('各阶段收到同一 GenerationSession 对象（跨阶段共享状态显式化）', async () => {
    h.sessions.length = 0;
    await generateDocumentDraft({ templateId: 'tpl-order' });
    expect(h.sessions).toHaveLength(5);
    expect(new Set(h.sessions).size).toBe(1);
  });

  it('stageChapterLoop 写入的 chapterDraftsFinal 原样传入 finalizeGeneration（session 字段传递）', async () => {
    const fakeChapter = { id: 'ch-1', title: '第一章', content: '正文' } as DocumentDraftChapter;
    h.chapterDraftsFinal = [fakeChapter];
    h.finalizeInput = null;
    await generateDocumentDraft({ templateId: 'tpl-order' });
    expect(h.finalizeInput).not.toBeNull();
    expect(h.finalizeInput!.chapterDrafts).toBe(h.chapterDraftsFinal);
    expect(h.finalizeInput!.chapterDrafts[0]).toBe(fakeChapter);
  });
});
