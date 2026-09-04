/**
 * globalQualityGates（v3 统一审查 + 清单冻结）单测：
 * 统一一致性审查（全局 LLM 审查 + 数据一致性数值矛盾审查并行合并为单一问题清单）、
 * 清单冻结（修复轮只消费冻结清单、不再重审全文，初检 + 末轮统一复检各一次）、
 * 单轮定向修复（每章一次 patch，失败即记录）、确定性去重（重复段落删除后重算快照）。
 * LLM/语义通道全部 mock（避免真实 LLM 与本地 bge 模型调用）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGlobalConsistencyReviewLoop } from '@/services/document-workflow/globalQualityGates';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate } from '@/services/document-workflow/types';
import type * as RolePipelineModule from '@/services/document-workflow/rolePipeline';

vi.mock('@/services/document-workflow/chapterReview', () => ({ reviewGlobalConsistency: vi.fn() }));
vi.mock('@/services/document-workflow/dataConsistencyReview', () => ({
  reviewDataConsistency: vi.fn(),
  dataConsistencyConflictIssue: vi.fn((conflict: { kind: string; itemA: string; itemB: string; description: string }) => ({
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `数据一致性矛盾（${conflict.kind}）：${conflict.description}（原文 A：“${conflict.itemA}” ↔ 原文 B：“${conflict.itemB}”）`,
    suggestion: '全文数据必须一致。',
  })),
}));
vi.mock('@/services/document-workflow/rolePipeline', async () => {
  const actual = await vi.importActual<typeof RolePipelineModule>('@/services/document-workflow/rolePipeline');
  return { ...actual, repairChapterByQuality: vi.fn() };
});
vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  buildSemanticSimilarity: vi.fn(async () => () => 0),
  snapshotEmbedCacheStats: vi.fn(() => ({ embedCacheHits: 0, embedCacheMisses: 0 })),
  getLocalSemanticProvider: vi.fn(() => ({ embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => [0, 0])) })),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  clearEmbedCacheForTest: vi.fn(),
}));

import { reviewGlobalConsistency } from '@/services/document-workflow/chapterReview';
import { reviewDataConsistency } from '@/services/document-workflow/dataConsistencyReview';
import { repairChapterByQuality } from '@/services/document-workflow/rolePipeline';

const reviewGlobalMock = vi.mocked(reviewGlobalConsistency);
const dataReviewMock = vi.mocked(reviewDataConsistency);
const repairMock = vi.mocked(repairChapterByQuality);

const REVIEW_STAGE = { type: 'llm_review', roleId: 'global-consistency-review', status: 'success', message: '全局一致性审查通过' } as never;

function makeChapter(id: string, title: string, content: string): DocumentDraftChapter {
  return { id, title, content, evidence: [], missingFacts: [], sections: [] } as unknown as DocumentDraftChapter;
}

function makeFactsModel(): DocumentFactsModel {
  return {
    project: [], schedule: [], quality: [], safety: [], resources: [], preciseFacts: [], bills: [], drawings: [], rules: [], specifications: [],
    tables: [], schemaFacts: {},
    factIndex: { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] },
    missing: [], conflicts: [],
  } as unknown as DocumentFactsModel;
}

function mockDiagnostics(): DocumentGenerationDiagnostics {
  return { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0 }, metrics: [] } as unknown as DocumentGenerationDiagnostics;
}

type ReviewLoopInput = Parameters<typeof runGlobalConsistencyReviewLoop>[0];

function makeInput(overrides: Partial<ReviewLoopInput> = {}): ReviewLoopInput {
  return {
    chapterDraftsFinal: [
      makeChapter('ch-1', '工程概况', '本工程为办公楼项目，位于市中心区域，施工组织需统筹安排。'),
      makeChapter('ch-2', '施工部署', '施工部署按照总进度计划组织流水施工，各专业穿插作业。'),
    ],
    template: {} as DocumentTemplate,
    reviewPromptTexts: '评审提示',
    repairPromptTexts: '修复提示',
    projectContext: '项目上下文',
    generationDiagnostics: mockDiagnostics(),
    preliminaryFactsModel: makeFactsModel(),
    scopeConflicts: [],
    progressStages: [],
    emitProgress: vi.fn(),
    withProgressHeartbeat: async <T,>(task: () => Promise<T>) => task(),
    ...overrides,
  };
}

describe('runGlobalConsistencyReviewLoop（v3 统一审查 + 清单冻结）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('统一审查合并：全局一致性冲突与数据一致性矛盾并入同一问题清单（初检各一次）', async () => {
    reviewGlobalMock.mockResolvedValue({ issues: ['跨章一致性冲突：总工期口径不一致'], stage: REVIEW_STAGE });
    dataReviewMock.mockResolvedValue([{ kind: 'labor', itemA: '高峰期80人', itemB: '高峰期120人', description: '劳动力峰值两处不一致', confidence: 0.9 }]);
    const input = makeInput();
    const result = await runGlobalConsistencyReviewLoop(input);
    expect(result.issues.some(issue => issue.includes('跨章一致性冲突：总工期口径不一致'))).toBe(true);
    expect(result.issues.some(issue => issue.includes('数据一致性矛盾（labor）'))).toBe(true);
    expect(reviewGlobalMock).toHaveBeenCalledTimes(1);
    expect(dataReviewMock).toHaveBeenCalledTimes(1);
    // 冲突无法定位任何章节（消息不含章节标题/数值/引号锚点）→ 不发起修复
    expect(repairMock).not.toHaveBeenCalled();
  });

  it('清单冻结：修复落地后仅末轮统一复检一次，修复轮不重审全文、每章只修一次', async () => {
    reviewGlobalMock.mockResolvedValue({ issues: ['工程概况：总工期与计划口径不符'], stage: REVIEW_STAGE });
    dataReviewMock.mockResolvedValue([]);
    repairMock.mockResolvedValue({ content: '修复后的工程概况正文，已按计划口径统一。', appliedCount: 1, producedCount: 1, repairType: 'quality' as never });
    const result = await runGlobalConsistencyReviewLoop(makeInput());
    // 初检 + 末轮统一复检 = 2 次；修复轮内不再重审全文
    expect(reviewGlobalMock).toHaveBeenCalledTimes(2);
    expect(dataReviewMock).toHaveBeenCalledTimes(2);
    // 单轮定向修复：冲突关联章节每章一次 patch
    expect(repairMock).toHaveBeenCalledTimes(1);
    // 复检快照与初检同源（mock 恒定返回）→ 清单被复检结果刷新
    expect(result.issues.some(issue => issue.includes('总工期与计划口径不符'))).toBe(true);
  });

  it('确定性去重：重复段落删除后重算检测快照（dedupRan=true，重复条目清零）', async () => {
    reviewGlobalMock.mockResolvedValue({ issues: [], stage: REVIEW_STAGE });
    dataReviewMock.mockResolvedValue([]);
    const repeated = '本工程按照统筹规划与科学管理的总体原则组织各项施工任务，确保工程质量安全与进度目标全面受控实现。';
    const chapter = makeChapter('ch-2', '施工部署', `${repeated}\n\n${repeated}\n\n施工部署按照总进度计划组织流水施工。`);
    const input = makeInput({ chapterDraftsFinal: [makeChapter('ch-1', '工程概况', '本工程为办公楼项目，位于市中心区域。'), chapter] });
    const result = await runGlobalConsistencyReviewLoop(input);
    expect(result.dedupRan).toBe(true);
    // 重复段落只保留首次出现处
    expect(input.chapterDraftsFinal[1].content.match(/统筹规划与科学管理/gu)).toHaveLength(1);
    // 删除后重算检测快照：重复条目不得残留在返回清单
    expect(result.issues.some(issue => issue.includes('段落完全重复'))).toBe(false);
  });

  it('零冲突直接通过：审查零检出 → 零修复、清单为空、去重照常收口', async () => {
    reviewGlobalMock.mockResolvedValue({ issues: [], stage: REVIEW_STAGE });
    dataReviewMock.mockResolvedValue([]);
    const result = await runGlobalConsistencyReviewLoop(makeInput());
    expect(result.issues).toEqual([]);
    expect(result.dedupRan).toBe(true);
    expect(reviewGlobalMock).toHaveBeenCalledTimes(1);
    expect(dataReviewMock).toHaveBeenCalledTimes(1);
    expect(repairMock).not.toHaveBeenCalled();
  });
});
