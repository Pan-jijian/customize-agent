/**
 * globalQualityGates（v3 统一审查 + 清单冻结）单测：
 * 统一一致性审查（全局 LLM 审查 + 数据一致性数值矛盾审查并行合并为单一问题清单）、
 * 清单冻结（修复轮只消费冻结清单、不再重审全文，初检 + 末轮统一复检各一次）、
 * 单轮定向修复（每章一次 patch，失败即记录）、确定性去重（重复段落删除后重算快照）。
 * LLM/语义通道全部 mock（避免真实 LLM 与本地 bge 模型调用）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AMBIGUOUS_RESIDUE_RE, enforcePlannedSectionCompleteness, enforceWorkPackageSkeletons, mergeDuplicateThematicSections, mergeNearDuplicateSectionHeadings, reconcileUnplannedSectionHeadings, repairTemplatingIssues, runGlobalConsistencyReviewLoop } from '@/services/document-workflow/globalQualityGates';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate } from '@/services/document-workflow/types';
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
// 模板化修复闭环的检测函数 mock（套话密度/重难点条目/套话句锚点），修复编排逻辑用确定性返回值验证
vi.mock('@/services/document-workflow/tenderBidChecks', async () => {
  const actual = await vi.importActual<typeof import('@/services/document-workflow/tenderBidChecks')>('@/services/document-workflow/tenderBidChecks');
  return { ...actual, fillerDensityReport: vi.fn(), difficultyCountermeasureReport: vi.fn() };
});
vi.mock('@/services/document-workflow/constructionOrgAudit', async () => {
  const actual = await vi.importActual<typeof import('@/services/document-workflow/constructionOrgAudit')>('@/services/document-workflow/constructionOrgAudit');
  return { ...actual, fillerSentenceTargets: vi.fn() };
});

import { reviewGlobalConsistency } from '@/services/document-workflow/chapterReview';
import { reviewDataConsistency } from '@/services/document-workflow/dataConsistencyReview';
import { repairChapterByQuality } from '@/services/document-workflow/rolePipeline';
import { difficultyCountermeasureReport, fillerDensityReport } from '@/services/document-workflow/tenderBidChecks';
import { fillerSentenceTargets } from '@/services/document-workflow/constructionOrgAudit';

const reviewGlobalMock = vi.mocked(reviewGlobalConsistency);
const dataReviewMock = vi.mocked(reviewDataConsistency);
const repairMock = vi.mocked(repairChapterByQuality);
const fillerDensityMock = vi.mocked(fillerDensityReport);
const difficultyMock = vi.mocked(difficultyCountermeasureReport);
const fillerTargetsMock = vi.mocked(fillerSentenceTargets);

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

// 补写修复默认返回调用时原文（无 patch 落地），聚焦断言确定性编排行为
function mockNoopRepair() {
  repairMock.mockImplementation(async args => ({ content: args.chapter.content, appliedCount: 0, producedCount: 0, repairType: 'quality' as never }));
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
    // 模板化修复闭环默认不触发（套话占比达标、重难点双达标）：既有用例不受影响
    fillerDensityMock.mockResolvedValue({ totalSentences: 10, fillerSentences: 0, ratio: 0, level: 'light', vagueCandidateSentences: 0, vagueSemanticSentences: 0, forbiddenEmptyPhraseHits: 0, fillerSentenceDetails: [] });
    difficultyMock.mockResolvedValue({ countermeasures: 0, attributed: 0, quantified: 0, bothCount: 0, ratio: 0, heavyTemplated: false, entries: [] });
    fillerTargetsMock.mockResolvedValue([]);
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

describe('repairTemplatingIssues（模板化修复闭环：套话重写 + 重难点归因量化补齐）', () => {
  function makeTemplatingInput(chapters: DocumentDraftChapter[]) {
    return {
      chapterDraftsFinal: chapters,
      template: {} as DocumentTemplate,
      repairPromptTexts: '修复提示',
      requirement: undefined,
      generationDiagnostics: mockDiagnostics(),
      progressStages: [],
      emitProgress: vi.fn(),
      withProgressHeartbeat: async <T,>(task: () => Promise<T>) => task(),
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('套话句命中触发修复：零信息口号句确定性删除（不进 anchorTexts），缺要素条目原文进锚点', async () => {
    fillerDensityMock.mockResolvedValue({ totalSentences: 10, fillerSentences: 3, ratio: 0.3, level: 'medium', vagueCandidateSentences: 0, vagueSemanticSentences: 0, forbiddenEmptyPhraseHits: 0, fillerSentenceDetails: [] });
    difficultyMock.mockResolvedValue({ countermeasures: 2, attributed: 0, quantified: 0, bothCount: 0, ratio: 0, heavyTemplated: true, entries: [{ text: '基坑降水难度大需控制。', attributed: false, quantified: false }] });
    fillerTargetsMock.mockResolvedValue([{ chapterId: 'ch-1', chapterTitle: '工程概况', section: '概况', sentence: '精心组织科学管理确保工程质量。', channel: 'semantic' }]);
    repairMock.mockResolvedValue({ content: '本工程为办公楼项目。基坑降水需将周边沉降控制在5mm以内。', appliedCount: 1, producedCount: 2, repairType: 'quality' as never });
    const chapters = [makeChapter('ch-1', '工程概况', '本工程为办公楼项目。精心组织科学管理确保工程质量。基坑降水难度大需控制。')];
    const result = await repairTemplatingIssues(makeTemplatingInput(chapters));
    expect(result.templatingFixApplied).toBe(true);
    // C2 确定性删除先行：零信息口号句物理移除（不进 LLM 锚点与指令）
    const firstCall = repairMock.mock.calls[0][0];
    expect(firstCall.chapter.content).toBe('本工程为办公楼项目。基坑降水难度大需控制。');
    expect(firstCall.anchorTexts).toEqual(['基坑降水难度大需控制。']);
    expect(firstCall.issues[0]).not.toContain('套话句');
    expect(firstCall.issues[0]).toContain('重难点分析条目');
    expect(firstCall.issues[0]).toContain('不得改动');
  });

  it('套话占比达标且重难点双达标：不触发修复（零 LLM 成本）', async () => {
    fillerDensityMock.mockResolvedValue({ totalSentences: 10, fillerSentences: 0, ratio: 0.05, level: 'light', vagueCandidateSentences: 0, vagueSemanticSentences: 0, forbiddenEmptyPhraseHits: 0, fillerSentenceDetails: [] });
    difficultyMock.mockResolvedValue({ countermeasures: 2, attributed: 2, quantified: 2, bothCount: 2, ratio: 1, heavyTemplated: false, entries: [] });
    const result = await repairTemplatingIssues(makeTemplatingInput([makeChapter('ch-1', '工程概况', '本工程为办公楼项目。')]));
    expect(result.templatingFixApplied).toBe(false);
    expect(repairMock).not.toHaveBeenCalled();
  });

  it('修复 patch 未落地：不进入第二轮，套话占比未收敛', async () => {
    fillerDensityMock.mockResolvedValue({ totalSentences: 10, fillerSentences: 3, ratio: 0.3, level: 'medium', vagueCandidateSentences: 0, vagueSemanticSentences: 0, forbiddenEmptyPhraseHits: 0, fillerSentenceDetails: [] });
    difficultyMock.mockResolvedValue({ countermeasures: 0, attributed: 0, quantified: 0, bothCount: 0, ratio: 0, heavyTemplated: false, entries: [] });
    fillerTargetsMock.mockResolvedValue([{ chapterId: 'ch-1', chapterTitle: '工程概况', section: '概况', sentence: '精心组织科学管理。', channel: 'vague' }]);
    const chapters = [makeChapter('ch-1', '工程概况', '本工程为办公楼项目。精心组织科学管理。')];
    // repairChapterByQuality 返回原文（无 patch 落地）→ 本章不应用
    repairMock.mockResolvedValue({ content: chapters[0].content, appliedCount: 0, producedCount: 0, repairType: 'quality' as never });
    const result = await repairTemplatingIssues(makeTemplatingInput(chapters));
    expect(result.templatingFixApplied).toBe(false);
    expect(repairMock).toHaveBeenCalledTimes(1);
  });

  it('F2 回滚保护：修复后套话占比上升且重难点未提升 → 回滚本轮修改', async () => {
    // 轮初检测 0.3 → 修复 → 复检 0.45（变差）→ 回滚
    fillerDensityMock.mockResolvedValueOnce({ totalSentences: 10, fillerSentences: 3, ratio: 0.3, level: 'medium', vagueCandidateSentences: 0, vagueSemanticSentences: 0, forbiddenEmptyPhraseHits: 0, fillerSentenceDetails: [] });
    fillerDensityMock.mockResolvedValueOnce({ totalSentences: 10, fillerSentences: 5, ratio: 0.45, level: 'heavy', vagueCandidateSentences: 0, vagueSemanticSentences: 0, forbiddenEmptyPhraseHits: 0, fillerSentenceDetails: [] });
    difficultyMock.mockResolvedValue({ countermeasures: 0, attributed: 0, quantified: 0, bothCount: 0, ratio: 0, heavyTemplated: false, entries: [] });
    // C2 双通道：semantic 零信息口号句确定性删除 + vague 命中句保留交 LLM 重写（保证删除后仍有 LLM 目标，走修复链）
    fillerTargetsMock.mockResolvedValue([
      { chapterId: 'ch-1', chapterTitle: '工程概况', section: '概况', sentence: '精心组织科学管理确保工程质量。', channel: 'semantic' },
      { chapterId: 'ch-1', chapterTitle: '工程概况', section: '概况', sentence: '加强过程管控确保质量水平稳步提升。', channel: 'vague' },
    ]);
    const chapters = [makeChapter('ch-1', '工程概况', '本工程为办公楼项目。精心组织科学管理确保工程质量。加强过程管控确保质量水平稳步提升。')];
    const before = chapters[0].content;
    repairMock.mockResolvedValue({ content: `${before}\n统筹兼顾全面推进各项工作落实。`, appliedCount: 1, producedCount: 1, repairType: 'quality' as never });
    const result = await repairTemplatingIssues(makeTemplatingInput(chapters));
    expect(result.templatingFixApplied).toBe(false);
    // 修复变差：回滚到删除后正文——确定性删除不参与回滚（不恢复口号句，LLM 改写丢弃）
    expect(chapters[0].content).toBe('本工程为办公楼项目。加强过程管控确保质量水平稳步提升。');
    expect(repairMock).toHaveBeenCalledTimes(1);
  });

  it('F2 回滚豁免：套话占比上升但重难点双达标提升 → 保留修复', async () => {
    fillerDensityMock.mockResolvedValueOnce({ totalSentences: 10, fillerSentences: 3, ratio: 0.3, level: 'medium', vagueCandidateSentences: 0, vagueSemanticSentences: 0, forbiddenEmptyPhraseHits: 0, fillerSentenceDetails: [] });
    fillerDensityMock.mockResolvedValueOnce({ totalSentences: 10, fillerSentences: 4, ratio: 0.35, level: 'medium', vagueCandidateSentences: 0, vagueSemanticSentences: 0, forbiddenEmptyPhraseHits: 0, fillerSentenceDetails: [] });
    // round2 轮初检测：套话与重难点双达标 → 收敛 break（序列末尾兑底值）
    fillerDensityMock.mockResolvedValue({ totalSentences: 10, fillerSentences: 0, ratio: 0.05, level: 'light', vagueCandidateSentences: 0, vagueSemanticSentences: 0, forbiddenEmptyPhraseHits: 0, fillerSentenceDetails: [] });
    difficultyMock.mockResolvedValueOnce({ countermeasures: 2, attributed: 0, quantified: 0, bothCount: 0, ratio: 0, heavyTemplated: true, entries: [{ text: '基坑降水难度大需控制。', attributed: false, quantified: false }] });
    difficultyMock.mockResolvedValue({ countermeasures: 2, attributed: 2, quantified: 2, bothCount: 2, ratio: 1, heavyTemplated: false, entries: [] });
    fillerTargetsMock.mockResolvedValue([{ chapterId: 'ch-1', chapterTitle: '工程概况', section: '概况', sentence: '精心组织科学管理确保工程质量。', channel: 'semantic' }]);
    const chapters = [makeChapter('ch-1', '工程概况', '本工程为办公楼项目。精心组织科学管理确保工程质量。基坑降水难度大需控制。')];
    const repaired = '本工程为办公楼项目。基坑降水需将周边沉降控制在5mm以内。';
    repairMock.mockResolvedValue({ content: repaired, appliedCount: 1, producedCount: 1, repairType: 'quality' as never });
    const result = await repairTemplatingIssues(makeTemplatingInput(chapters));
    expect(result.templatingFixApplied).toBe(true);
    expect(chapters[0].content).toBe(repaired);
  });

  it('零信息口号句确定性删除单独生效：无剩余 LLM 目标时零修复调用、fixApplied=true', async () => {
    fillerDensityMock.mockResolvedValue({ totalSentences: 10, fillerSentences: 1, ratio: 0.1, level: 'light', vagueCandidateSentences: 0, vagueSemanticSentences: 0, forbiddenEmptyPhraseHits: 0, fillerSentenceDetails: [] });
    difficultyMock.mockResolvedValue({ countermeasures: 0, attributed: 0, quantified: 0, bothCount: 0, ratio: 0, heavyTemplated: false, entries: [] });
    fillerTargetsMock.mockResolvedValue([{ chapterId: 'ch-1', chapterTitle: '工程概况', section: '概况', sentence: '精心组织科学管理确保工程质量。', channel: 'semantic' }]);
    const chapters = [makeChapter('ch-1', '工程概况', '本工程为办公楼项目。精心组织科学管理确保工程质量。')];
    const result = await repairTemplatingIssues(makeTemplatingInput(chapters));
    expect(result.templatingFixApplied).toBe(true);
    expect(repairMock).not.toHaveBeenCalled();
    expect(chapters[0].content).toBe('本工程为办公楼项目。');
  });
});

describe('enforceWorkPackageSkeletons（工作包骨架确定性收口：阶段 0 小节缺失补建）', () => {
  function makeSkeletonInput(overrides: Partial<Parameters<typeof enforceWorkPackageSkeletons>[0]> = {}) {
    return {
      chapterDraftsFinal: [
        makeChapter('ch-1', '工程概况', '本工程为办公楼项目，位于市中心区域，施工组织需统筹安排。'),
        makeChapter('ch-2', '施工部署', '施工部署按照总进度计划组织流水施工，各专业穿插作业。'),
      ],
      projectContext: '办公楼项目施工组织设计编制。',
      template: {} as DocumentTemplate,
      repairPromptTexts: '修复提示',
      requirement: undefined,
      signal: undefined,
      generationDiagnostics: mockDiagnostics(),
      progressStages: [],
      emitProgress: vi.fn(),
      withProgressHeartbeat: async <T,>(task: () => Promise<T>) => task(),
      ...overrides,
    };
  }

  // 招标范围清单证据（合肥师范同型）：scopeEngineeringNames 确定性提取 12 个专业工程名
  function makeScopeEvidence(): DocumentEvidence[] {
    return [{
      chapterId: 'ev-1',
      filePath: '/tmp/scope.txt',
      score: 0.9,
      content: '（一）招标范围：本工程招标范围包括施工图范围内的全部内容。招标内容包括但不限于土方外运及基坑支护工程、地基与基础工程、人防工程、主体结构工程、装饰装修工程、幕墙工程、屋面工程、电气工程、给排水工程、消防工程、通风与空调、智能化等图纸及清单范围内所有工程。',
    }];
  }

  // 补写修复默认返回调用时原文（无 patch 落地），聚焦断言阶段 0 补建确定性行为
  beforeEach(() => {
    vi.resetAllMocks();
    mockNoopRepair();
  });

  it('小节整体缺失且骨架清单可用：确定性补建带编号小节到语义宿主章末尾，同步入 sections，并触发锚点补写', async () => {
    const host = makeChapter('ch-1', '工程概况', '本工程为办公楼项目，位于市中心区域。');
    const other = makeChapter('ch-2', '施工部署', '施工部署按照总进度计划组织流水施工。');
    host.evidence = makeScopeEvidence();
    const input = makeSkeletonInput({ chapterDraftsFinal: [host, other] });
    const result = await enforceWorkPackageSkeletons(input);
    expect(result.skeletonFixApplied).toBe(true);
    expect(host.content).toContain('### 1.1 项目主要施工内容');
    expect(host.content.trimEnd().endsWith('### 1.1 项目主要施工内容')).toBe(true);
    expect(other.content).not.toContain('项目主要施工内容');
    // 稳定版：补建小节同步入章 sections 数组——目录由 sections 生成、正文节集合只收集带编号 H3，
    // 同源后 tocBodyConsistencyIssues 目录与正文节数守恒校验不报错
    expect(host.sections).toContain('项目主要施工内容');
    // 补建小节参与后续锚点直连补写：12 个工作包缺失 → 发起修复（锚点 = 补建标题行）
    expect(repairMock).toHaveBeenCalledTimes(1);
    const firstCall = repairMock.mock.calls[0][0];
    expect(firstCall.anchorTexts).toEqual([{ text: '### 1.1 项目主要施工内容', append: true }]);
    expect(firstCall.issues[0]).toContain('#### 1 土方外运及基坑支护工程');
  });

  it('补建时宿主章 sections 已含该小节：复用其序号编号，不重复入列', async () => {
    const host = makeChapter('ch-1', '工程概况', '本工程为办公楼项目，位于市中心区域。');
    host.sections = ['工程概况说明', '项目主要施工内容'];
    host.evidence = makeScopeEvidence();
    const input = makeSkeletonInput({ chapterDraftsFinal: [host] });
    const result = await enforceWorkPackageSkeletons(input);
    expect(result.skeletonFixApplied).toBe(true);
    expect(host.content).toContain('### 1.2 项目主要施工内容');
    expect(host.sections.filter(section => /项目主要施工内容/u.test(section))).toHaveLength(1);
  });

  it('空正文工作包确定性剥离后按缺失补写（轮3 实测 4 空包漏补根因）', async () => {
    const host = makeChapter('ch-1', '工程概况', [
      '本工程为办公楼项目，位于市中心区域。',
      '',
      '### 项目主要施工内容',
      '',
      '#### 1 土方外运及基坑支护工程',
      '',
      '#### 2 地基与基础工程',
      '',
      '土方开挖按分层开挖组织，先测量放线再机械开挖，随后支护结构施工，最后基坑验收。',
      '地基基础工程施工采用筏板基础，作业对象为主楼及裙房基础部位，施工范围覆盖全部基础分部工程。',
      '施工流程为先桩基施工再土方开挖，随后垫层浇筑、钢筋绑扎、模板支设、混凝土浇筑，最后养护与验收。',
      '施工方法采用商品混凝土泵送浇筑，分层振捣密实，标高与轴线按图纸复核，混凝土强度按规范取样试件检测。',
    ].join('\n'));
    host.sections = ['工程概况说明', '项目主要施工内容'];
    host.evidence = makeScopeEvidence();
    const input = makeSkeletonInput({ chapterDraftsFinal: [host] });
    await enforceWorkPackageSkeletons(input);
    // 空包「土方外运及基坑支护工程」被确定性删除（标题+空正文整块剥离），补写轮按缺失口径锚点直连补写
    expect(host.content).not.toContain('#### 1 土方外运及基坑支护工程');
    expect(host.content).toContain('#### 2 地基与基础工程');
    const firstCall = repairMock.mock.calls[0][0];
    expect(firstCall.issues[0]).toContain('土方外运及基坑支护工程');
  });

  it('骨架名统一用全卷清单：宿主章 evidence 不含招标范围时补建小节仍触发补写（单章口径会漏补）', async () => {
    const host = makeChapter('ch-1', '工程概况', '本工程为办公楼项目，位于市中心区域。');
    const other = makeChapter('ch-2', '施工部署', '施工部署按照总进度计划组织流水施工。');
    other.evidence = makeScopeEvidence();
    const input = makeSkeletonInput({ chapterDraftsFinal: [host, other] });
    const result = await enforceWorkPackageSkeletons(input);
    expect(result.skeletonFixApplied).toBe(true);
    expect(host.content).toContain('### 1.1 项目主要施工内容');
    // 补写轮用全卷骨架清单：宿主章单章 evidence 为空仍触发锚点直连补写（旧口径此处零调用 → 补建小节空置）
    expect(repairMock).toHaveBeenCalledTimes(1);
    const firstCall = repairMock.mock.calls[0][0];
    expect(firstCall.anchorTexts).toEqual([{ text: '### 1.1 项目主要施工内容', append: true }]);
    expect(firstCall.issues[0]).toContain('#### 1 土方外运及基坑支护工程');
  });

  it('第一遍确定性剥离用全卷骨架清单：关键小节所在章 evidence 无招标范围时空包仍被剥离（单章口径会漏剥）', async () => {
    const host = makeChapter('ch-1', '工程概况', [
      '本工程为办公楼项目，位于市中心区域。',
      '',
      '### 项目主要施工内容',
      '',
      '#### 1 土方外运及基坑支护工程',
      '',
      '#### 2 地基与基础工程',
      '',
      '地基基础工程采用筏板基础施工，作业对象为主楼及裙房基础部位，施工范围覆盖全部基础分部工程。',
      '施工流程为先桩基施工再土方开挖，随后垫层浇筑、钢筋绑扎、模板支设、混凝土浇筑，最后养护与验收。',
      '施工方法采用商品混凝土泵送浇筑，分层振捣密实，标高与轴线按图纸复核，强度按规范取样检测。',
    ].join('\n'));
    host.sections = ['工程概况说明', '项目主要施工内容'];
    const other = makeChapter('ch-2', '施工部署', '施工部署按照总进度计划组织流水施工。');
    other.evidence = makeScopeEvidence();
    const input = makeSkeletonInput({ chapterDraftsFinal: [host, other] });
    await enforceWorkPackageSkeletons(input);
    // 空包「土方外运及基坑支护工程」被剥离（全卷清单驱动），有正文包保留
    expect(host.content).not.toContain('#### 1 土方外运及基坑支护工程');
    expect(host.content).toContain('#### 2 地基与基础工程');
    expect(repairMock).toHaveBeenCalledTimes(1);
  });

  it('小节标题已存在：不重复补建，标题只出现一次', async () => {
    const chapter = makeChapter('ch-1', '工程概况', '本工程为办公楼项目。\n\n### 项目主要施工内容\n\n#### 1 土方外运及基坑支护工程\n\n土方开挖按分层开挖组织。');
    chapter.evidence = makeScopeEvidence();
    const input = makeSkeletonInput({ chapterDraftsFinal: [chapter] });
    const result = await enforceWorkPackageSkeletons(input);
    expect(result.skeletonFixApplied).toBe(false);
    expect(chapter.content.match(/项目主要施工内容/gu)).toHaveLength(1);
  });

  it('骨架清单不可用（招标范围提取不足 3 个）：不补建、零 LLM 调用', async () => {
    const chapter = makeChapter('ch-1', '工程概况', '本工程为办公楼项目。');
    chapter.evidence = [{ chapterId: 'ev-1', filePath: '/tmp/x.txt', score: 0.9, content: '无清单类内容。' }];
    const input = makeSkeletonInput({ chapterDraftsFinal: [chapter] });
    const result = await enforceWorkPackageSkeletons(input);
    expect(result.skeletonFixApplied).toBe(false);
    expect(chapter.content).toBe('本工程为办公楼项目。');
    expect(repairMock).not.toHaveBeenCalled();
  });

  it('无语义宿主章：fallback 补建到第一章末尾（带编号）', async () => {
    const first = makeChapter('ch-1', '施工准备', '施工准备阶段安排临时设施布置。');
    const second = makeChapter('ch-2', '质量保证措施', '质量保证体系健全，责任到人。');
    first.evidence = makeScopeEvidence();
    const input = makeSkeletonInput({ chapterDraftsFinal: [first, second] });
    const result = await enforceWorkPackageSkeletons(input);
    expect(result.skeletonFixApplied).toBe(true);
    expect(first.content).toContain('### 1.1 项目主要施工内容');
    expect(second.content).not.toContain('项目主要施工内容');
  });

  // 4.19.11 回归（丰乐镇第十二轮实测）：分部章容器小节「主要分部分项工程施工方案」被补写轮
  // 强制注入「#### 3 绿化工程」等工作包 H4 → 总述小节被骨架污染 + 补写重写截断总述正文
  const DIVISION_CONTAINER_CONTENT = [
    '本工程为办公楼项目，位于市中心区域。',
    '',
    '### 主要分部分项工程施工方案',
    '',
    '本章各分部工程按专业归并为土建、机电、装饰三大专业组：土建专业组涵盖地基与基础工程、主体结构工程，机电专业组涵盖电气工程、给排水工程、通风与空调，装饰专业组涵盖装饰装修工程、幕墙工程，各组间通过工序交接与成品保护安排衔接。',
  ].join('\n');

  it('分部章容器块（总述正文无 H4）：补写轮豁免，不注入工作包 H4，总述正文完整保留', async () => {
    const division = makeChapter('ch-2', '主要施工方法', DIVISION_CONTAINER_CONTENT);
    division.evidence = makeScopeEvidence();
    const input = makeSkeletonInput({ chapterDraftsFinal: [division] });
    const result = await enforceWorkPackageSkeletons(input);
    // 容器块是总述小节（无需 H4 骨架）：骨架清单可用也不得补写（历史缺陷：注入「#### 3 幕墙工程」等 H4）
    expect(repairMock).not.toHaveBeenCalled();
    expect(result.skeletonFixApplied).toBe(false);
    expect(division.content).toContain('本章各分部工程按专业归并为土建、机电、装饰三大专业组');
    expect(division.content.match(/^####/gmu)).toBeNull();
  });

  it('豁免只针对分部章容器块：同章「项目主要施工内容」小节仍触发骨架补写', async () => {
    const division = makeChapter('ch-2', '主要施工方法', [
      '### 项目主要施工内容',
      '',
      '本项目主要施工内容覆盖土建与机电各专业工程。',
      '',
      ...DIVISION_CONTAINER_CONTENT.split('\n'),
    ].join('\n'));
    division.evidence = makeScopeEvidence();
    const input = makeSkeletonInput({ chapterDraftsFinal: [division] });
    await enforceWorkPackageSkeletons(input);
    // 仅「项目主要施工内容」进入补写轮（容器块豁免）；锚点不含容器块标题行
    expect(repairMock).toHaveBeenCalledTimes(1);
    const firstCall = repairMock.mock.calls[0][0];
    expect(firstCall.anchorTexts).toEqual([{ text: '### 项目主要施工内容', append: true }]);
    expect(firstCall.issues[0]).toContain('#### 1 土方外运及基坑支护工程');
    expect(division.content).toContain('本章各分部工程按专业归并为土建、机电、装饰三大专业组');
  });

  it('非分部章容器小节（异常挂载）：豁免不生效，仍按关键小节补写（口径精确到分部章）', async () => {
    const host = makeChapter('ch-1', '工程概况', [
      '本工程为办公楼项目，位于市中心区域。',
      '',
      ...DIVISION_CONTAINER_CONTENT.split('\n'),
    ].join('\n'));
    host.evidence = makeScopeEvidence();
    const input = makeSkeletonInput({ chapterDraftsFinal: [host] });
    await enforceWorkPackageSkeletons(input);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const firstCall = repairMock.mock.calls[0][0];
    expect(firstCall.anchorTexts).toEqual([{ text: '### 主要分部分项工程施工方案', append: true }]);
  });

  it('分部章容器块内自由发挥 H4 不误剥（剥离轮豁免）：总述正文连同 H4 全部保留', async () => {
    const division = makeChapter('ch-2', '主要施工方法', [
      '本工程为办公楼项目，位于市中心区域。',
      '',
      '### 主要分部分项工程施工方案',
      '',
      '#### 3 幕墙工程',
      '',
      '本章各分部工程按专业归并为土建、机电、装饰三大专业组。',
    ].join('\n'));
    division.evidence = makeScopeEvidence();
    const input = makeSkeletonInput({ chapterDraftsFinal: [division] });
    await enforceWorkPackageSkeletons(input);
    // 剥离轮豁免：容器块内 H4（哪怕命中骨架名且正文不足）不得按空工作包剥离（总述小节无工作包口径）
    expect(division.content).toContain('#### 3 幕墙工程');
    expect(division.content).toContain('本章各分部工程按专业归并为土建、机电、装饰三大专业组');
  });
});

describe('enforcePlannedSectionCompleteness（缺规划小节补写收口：F1）', () => {
  function makePlannedInput(overrides: Partial<Parameters<typeof enforcePlannedSectionCompleteness>[0]> = {}) {
    return {
      chapterDraftsFinal: [
        makeChapter('ch-1', '劳动力安排计划', [
          '## 劳动力安排计划',
          '',
          '### 1.1 劳动力组织与实名制管理',
          '实名制管理覆盖全部进场人员，先入场登记再安全教育，随后考勤打卡，最后工资代发。',
          '',
          '### 1.2 分阶段劳动力投入与动态调配',
          '施工准备阶段投入施工人员约四十人，主体施工阶段高峰约一百二十人，收尾阶段逐步退场。',
          '',
          '### 1.3 劳动力保障与工资支付措施',
          '设立农民工工资专户，按月足额支付工资，保障劳动力稳定。',
        ].join('\n')),
      ],
      template: {} as DocumentTemplate,
      repairPromptTexts: '修复提示',
      requirement: undefined,
      signal: undefined,
      generationDiagnostics: mockDiagnostics(),
      progressStages: [],
      emitProgress: vi.fn(),
      withProgressHeartbeat: async <T,>(task: () => Promise<T>) => task(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mockNoopRepair();
  });

  it('规划小节缺失：以章末标题行为锚点发起补写，issues 含编号标题与专属任务卡', async () => {
    const chapter = makeChapter('ch-1', '劳动力安排计划', [
      '## 劳动力安排计划',
      '',
      '### 1.1 劳动力组织与实名制管理',
      '实名制管理覆盖全部进场人员，先入场登记再安全教育，随后考勤打卡，最后工资代发。',
      '',
      '### 1.2 分阶段劳动力投入与动态调配',
      '施工准备阶段投入施工人员约四十人，主体施工阶段高峰约一百二十人，收尾阶段逐步退场。',
      '',
      '### 1.3 劳动力保障与工资支付措施',
      '设立农民工工资专户，按月足额支付工资，保障劳动力稳定。',
    ].join('\n'));
    chapter.sections = ['资源配置计划', '劳动力组织与实名制管理', '分阶段劳动力投入与动态调配', '劳动力保障与工资支付措施'];
    const input = makePlannedInput({ chapterDraftsFinal: [chapter] });
    const result = await enforcePlannedSectionCompleteness(input);
    expect(result.plannedSectionFixApplied).toBe(false);
    // 缺「资源配置计划」触发 1 次补写调用，锚点 = 章末标题行（章末追加模式：锚点仅作存在性校验）
    expect(repairMock).toHaveBeenCalledTimes(1);
    const firstCall = repairMock.mock.calls[0][0];
    expect(firstCall.chapter.title).toBe('劳动力安排计划');
    expect(firstCall.anchorTexts).toEqual([{ text: '### 1.3 劳动力保障与工资支付措施', append: true, appendAt: 'chapter-end' }]);
    // 编号口径（r28g B）：章末追加语义下取章内现有 H3 最大小节号 +1（1.1/1.2/1.3 → 1.4），
    // 不再复用规划序位（r28f 实测：规划首节单字漂移被判缺失后补写复用 7.1 → 编号重复直坠门禁）
    expect(firstCall.issues[0]).toContain('### 1.4 资源配置计划');
    // 专属任务卡：劳动力章 × 资源配置计划 组合规则注入
    expect(firstCall.issues[0]).toContain('只写劳动力资源');
    expect(firstCall.issues[0]).toContain('工种结构与人数');
  });

  it('修复 patch 落地：章节正文被替换且返回 true', async () => {
    const chapter = makeChapter('ch-1', '劳动力安排计划', [
      '## 劳动力安排计划',
      '',
      '### 1.1 劳动力组织与实名制管理',
      '实名制管理覆盖全部进场人员，先入场登记再安全教育，随后考勤打卡，最后工资代发。',
      '',
      '### 1.2 分阶段劳动力投入与动态调配',
      '施工准备阶段投入施工人员约四十人，主体施工阶段高峰约一百二十人，收尾阶段逐步退场。',
      '',
      '### 1.3 劳动力保障与工资支付措施',
      '设立农民工工资专户，按月足额支付工资，保障劳动力稳定。',
    ].join('\n'));
    chapter.sections = ['资源配置计划', '劳动力组织与实名制管理', '分阶段劳动力投入与动态调配', '劳动力保障与工资支付措施'];
    repairMock.mockImplementation(async args => ({
      content: `${args.chapter.content}\n\n### 1.4 资源配置计划\n钢筋工十五人、木工二十人，分阶段进退场。`,
      appliedCount: 1,
      producedCount: 1,
      repairType: 'quality' as never,
    }));
    const input = makePlannedInput({ chapterDraftsFinal: [chapter] });
    const result = await enforcePlannedSectionCompleteness(input);
    expect(result.plannedSectionFixApplied).toBe(true);
    expect(chapter.content).toContain('### 1.4 资源配置计划');
  });

  it('修复轮调用（传入 finalGateRepairStages）：planned-section-repair 事件双写且 running 原位收口', async () => {
    const chapter = makeChapter('ch-1', '劳动力安排计划', [
      '## 劳动力安排计划',
      '',
      '### 1.1 劳动力组织与实名制管理',
      '实名制管理覆盖全部进场人员，先入场登记再安全教育，随后考勤打卡，最后工资代发。',
    ].join('\n'));
    chapter.sections = ['资源配置计划', '劳动力组织与实名制管理'];
    const finalGateRepairStages: DocumentExecutionStage[] = [];
    const input = makePlannedInput({ chapterDraftsFinal: [chapter], finalGateRepairStages });
    await enforcePlannedSectionCompleteness(input);
    // mockNoopRepair 返回原内容 → appliedCount=0 → 终态 failed；running/completed 同 roleId 原位替换不堆叠
    const stages = finalGateRepairStages.filter(item => item.roleId === 'planned-section-repair');
    expect(stages).toHaveLength(1);
    expect(stages[0].status).toBe('failed');
  });

  it('无缺失小节：零 LLM 调用、返回 false', async () => {
    const chapter = makeChapter('ch-1', '劳动力安排计划', [
      '## 劳动力安排计划',
      '',
      '### 1.1 资源配置计划',
      '按施工进度分阶段配置劳动力：基础阶段投入钢筋工十五人、木工二十人，主体阶段增加混凝土工与架子工共二十八人，'
      + '装饰阶段压缩至二十人以内；各工种进退场由施工员按周计划核定，进场前完成三级安全教育与技能核验，'
      + '退场时办理交接与工资结算手续，确保各阶段劳动力配置与进度计划匹配。',
      '',
      '### 1.2 劳动力组织与实名制管理',
      '施工现场实行建筑工人实名制管理，覆盖全部进场人员：入场即采集身份信息与技能证书并录入实名制管理平台，'
      + '日常考勤通过闸机与平台双重记录，考勤数据按月汇总作为工资代发依据；'
      + '农民工工资通过专用账户按月足额代发，工资支付台账留存备查，杜绝拖欠与代领。',
    ].join('\n'));
    chapter.sections = ['资源配置计划', '劳动力组织与实名制管理'];
    const input = makePlannedInput({ chapterDraftsFinal: [chapter] });
    const result = await enforcePlannedSectionCompleteness(input);
    expect(result.plannedSectionFixApplied).toBe(false);
    expect(repairMock).not.toHaveBeenCalled();
  });

  it('三要素豁免小节缺失不触发补写（与导出期检查器同口径）', async () => {
    const chapter = makeChapter('ch-1', '工程概况', [
      '## 工程概况',
      '',
      '### 1.1 项目主要施工内容',
      '本工程包括道路工程与排水工程两个专业分部：道路工程含路基清表、塘渣石垫层、水泥稳定碎石基层与沥青混凝土面层，'
      + '按分段流水组织施工；排水工程含沟槽开挖、管道敷设、检查井砌筑与沟槽回填，'
      + '各分部分项按先地下后地上、先深后浅的顺序有序组织，工序衔接处由技术负责人组织隐蔽验收后方可进入下道工序。',
    ].join('\n'));
    chapter.sections = ['施工概况', '项目主要施工内容'];
    const input = makePlannedInput({ chapterDraftsFinal: [chapter] });
    const result = await enforcePlannedSectionCompleteness(input);
    expect(result.plannedSectionFixApplied).toBe(false);
    // 「施工概况」属三要素豁免小节（collectSectionContentGaps 口径），不发起补写
    expect(repairMock).not.toHaveBeenCalled();
  });

  it('补写失败（修复返回原内容）：不阻断、返回 false', async () => {
    const chapter = makeChapter('ch-1', '劳动力安排计划', [
      '## 劳动力安排计划',
      '',
      '### 1.1 劳动力组织与实名制管理',
      '实名制管理覆盖全部进场人员，先入场登记再安全教育，随后考勤打卡，最后工资代发。',
      '',
      '### 1.2 分阶段劳动力投入与动态调配',
      '施工准备阶段投入施工人员约四十人，主体施工阶段高峰约一百二十人，收尾阶段逐步退场。',
      '',
      '### 1.3 劳动力保障与工资支付措施',
      '设立农民工工资专户，按月足额支付工资，保障劳动力稳定。',
    ].join('\n'));
    chapter.sections = ['资源配置计划', '劳动力组织与实名制管理', '分阶段劳动力投入与动态调配', '劳动力保障与工资支付措施'];
    const before = chapter.content;
    const input = makePlannedInput({ chapterDraftsFinal: [chapter] });
    const result = await enforcePlannedSectionCompleteness(input);
    expect(result.plannedSectionFixApplied).toBe(false);
    expect(chapter.content).toBe(before);
  });

  it('规划小节只有表格无正文（planned empty）：触发补写，指令为既有小节内补正文而非新增同名小节', async () => {
    const chapter = makeChapter('ch-1', '确保文明施工的技术组织措施', [
      '## 确保文明施工的技术组织措施',
      '',
      '### 1.1 扬尘治理六个百分百落实措施',
      '| 污染源 | 控制指标 |',
      '| --- | --- |',
      '| 施工扬尘 | 100%围挡 |',
      '| 物料扬尘 | 100%覆盖 |',
    ].join('\n'));
    chapter.sections = ['扬尘治理六个百分百落实措施', '环境污染物管控指标与监测'];
    const input = makePlannedInput({ chapterDraftsFinal: [chapter] });
    const result = await enforcePlannedSectionCompleteness(input);
    // 环境污染物小节连标题都没有（缺节）+ 扬尘小节纯表格（planned empty）：两类都进补写目标
    expect(repairMock).toHaveBeenCalledTimes(1);
    const firstCall = repairMock.mock.calls[0][0];
    // 纯表格小节：指令必须是既有小节内补写正文，禁止新增同名小节标题
    const emptyIssue = firstCall.issues.find(issue => issue.includes('扬尘治理六个百分百落实措施'));
    expect(emptyIssue).toBeDefined();
    expect(emptyIssue).toContain('只有标题或表格无正式正文');
    expect(emptyIssue).toContain('不得新增同名小节标题');
    // 缺节小节：指令仍是章末新增小节标题
    const missingIssue = firstCall.issues.find(issue => issue.includes('环境污染物管控指标与监测'));
    expect(missingIssue).toBeDefined();
    expect(missingIssue).toContain('新增小节标题');
    expect(result.plannedSectionFixApplied).toBe(false);
  });

  it('非规划小节（planned=false）空小节不触发补写', async () => {
    const chapter = makeChapter('ch-1', '确保文明施工的技术组织措施', [
      '## 确保文明施工的技术组织措施',
      '',
      '### 1.1 噪声控制措施',
      '| 污染源 | 控制指标 |',
      '| --- | --- |',
      '| 施工噪声 | 昼间≤70dB(A) |',
    ].join('\n'));
    // sections 未包含该小节：actual 空小节 planned=false，不入补写目标
    chapter.sections = [];
    const input = makePlannedInput({ chapterDraftsFinal: [chapter] });
    const result = await enforcePlannedSectionCompleteness(input);
    expect(result.plannedSectionFixApplied).toBe(false);
    expect(repairMock).not.toHaveBeenCalled();
  });

  it('章内无现有 H3：补写编号退回规划序位（r28g B 回退口径）', async () => {
    const chapter = makeChapter('ch-1', '资源配置计划', '## 资源配置计划');
    chapter.sections = ['资源配置计划'];
    const input = makePlannedInput({ chapterDraftsFinal: [chapter] });
    const result = await enforcePlannedSectionCompleteness(input);
    expect(result.plannedSectionFixApplied).toBe(false);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const firstCall = repairMock.mock.calls[0][0];
    // 无现有 H3 → 退回规划序位（第 1 位 → 1.1）
    expect(firstCall.issues[0]).toContain('### 1.1 资源配置计划');
  });

  it('补写回滚守卫（r28g C）：补写轮切开锚点 H4 产生空标题 → 回滚保留修复前正文', async () => {
    const original = [
      '## 安全文明施工措施',
      '本章安全措施按标准化工地要求组织。',
      '',
      '### 1.1 安全生产责任体系',
      '逐级签订安全生产责任书，明确考核标准。',
      '',
      '#### 特殊技术标准和要求',
      '执行国家现行有效版本的技术标准。',
    ].join('\n');
    const chapter = makeChapter('ch-1', '安全文明施工措施', original);
    chapter.sections = ['安全责任体系与目标落位', '安全生产责任体系'];
    repairMock.mockImplementation(async () => ({
      // 模拟 r28f 实测形态：补写轮把锚点 H4 与其正文切开（H4 变空壳直坠终检「空小节」）
      content: [
        '## 安全文明施工措施',
        '本章安全措施按标准化工地要求组织。',
        '',
        '### 1.1 安全生产责任体系',
        '逐级签订安全生产责任书，明确考核标准。',
        '',
        '#### 特殊技术标准和要求',
        '### 1.2 安全责任体系与目标落位',
        '落位补写正文（原 H4 正文被并入）。',
      ].join('\n'),
      appliedCount: 1,
      producedCount: 1,
      repairType: 'quality' as never,
    }));
    const input = makePlannedInput({ chapterDraftsFinal: [chapter] });
    const result = await enforcePlannedSectionCompleteness(input);
    // 复检指标不降反升（空标题 0→1）→ 回滚，正文保持修复前
    expect(result.plannedSectionFixApplied).toBe(false);
    expect(chapter.content).toBe(original);
  });

  it('补写后近名合并（r28g D）：补写轮引入的规划名变体与精确版收敛，正文零丢失', async () => {
    const chapter = makeChapter('ch-1', '安全生产管理', [
      '## 安全生产管理',
      '',
      '### 1.1 安全责任体系与目标落位',
      '逐级签订安全生产责任书。',
    ].join('\n'));
    chapter.sections = ['安全责任体系与目标落位', '安全生产费用保障与使用制度'];
    repairMock.mockImplementation(async args => ({
      content: `${args.chapter.content}\n\n### 1.2 安全生产费用保障与使用制度\n安全费用专款专用，按月计量支付。\n\n### 1.3 安全生产费用保障与使用规定\n规定版本补充说明正文。`,
      appliedCount: 1,
      producedCount: 1,
      repairType: 'quality' as never,
    }));
    const input = makePlannedInput({ chapterDraftsFinal: [chapter] });
    const result = await enforcePlannedSectionCompleteness(input);
    expect(result.plannedSectionFixApplied).toBe(true);
    // 1.3（规划名变体）与 1.2（精确规划名）近名 → 合并：标题行摘除、正文并入 1.2 块
    expect(chapter.content).not.toContain('### 1.3');
    expect(chapter.content).toContain('### 1.2 安全生产费用保障与使用制度');
    expect(chapter.content).toContain('规定版本补充说明正文。');
  });
});

describe('mergeNearDuplicateSectionHeadings（近名合并：r28g D 时序兜底）', () => {
  it('错字版与规划名版并存：合并为一节（保留首现、标题归规划名、正文零丢失）', () => {
    const chapter = makeChapter('ch-1', '安全生产管理', [
      '## 安全生产管理',
      '',
      '### 1.1 安全责任体系与目标落实',
      '落实版本正文段落。',
      '',
      '### 1.4 安全责任体系与目标落位',
      '落位版本正文段落。',
    ].join('\n'));
    chapter.sections = ['安全责任体系与目标落位', '安全生产费用保障'];
    const result = mergeNearDuplicateSectionHeadings([chapter]);
    expect(result.mergedCount).toBe(1);
    expect(chapter.content).toContain('### 1.1 安全责任体系与目标落位');
    expect(chapter.content).not.toContain('### 1.4');
    expect(chapter.content).toContain('落实版本正文段落。');
    expect(chapter.content).toContain('落位版本正文段落。');
  });

  it('双归属防线：规划本身即近名小节对（落位/落实同在 sections）时不合并', () => {
    const chapter = makeChapter('ch-1', '安全目标管理', [
      '## 安全目标管理',
      '',
      '### 1.1 安全责任体系与目标落位',
      '落位正文。',
      '',
      '### 1.2 安全责任体系与目标落实',
      '落实正文。',
    ].join('\n'));
    chapter.sections = ['安全责任体系与目标落位', '安全责任体系与目标落实'];
    const result = mergeNearDuplicateSectionHeadings([chapter]);
    expect(result.mergedCount).toBe(0);
  });
});

describe('mergeNearDuplicateSectionHeadings 单行漂移改名（D-T6 ② r28f 归因）', () => {
  it('单行漂移：唯一近名未覆盖漂移行就地改名回规划名（前缀编号保留、正文零丢失）', () => {
    const chapter = makeChapter('ch-1', '确保安全生产的技术组织措施', [
      '## 确保安全生产的技术组织措施',
      '',
      '### 7.1 安全责任体系与目标落实',
      '落实版本正文段落。',
    ].join('\n'));
    chapter.sections = ['安全责任体系与目标落位', '安全生产费用保障与使用制度'];
    const result = mergeNearDuplicateSectionHeadings([chapter]);
    expect(result.mergedCount).toBe(1);
    expect(chapter.content).toContain('### 7.1 安全责任体系与目标落位');
    expect(chapter.content).not.toContain('目标落实');
    expect(chapter.content).toContain('落实版本正文段落。');
    expect(result.details[0]).toContain('对齐规划名');
    // 幂等：改名后复跑零变更（已精确覆盖规划名，不再命中漂移分支）
    const again = mergeNearDuplicateSectionHeadings([chapter]);
    expect(again.mergedCount).toBe(0);
  });

  it('歧义形态保守跳过：漂移行同时近名多个未覆盖规划小节时不改名（零触碰）', () => {
    const chapter = makeChapter('ch-1', '安全生产管理', [
      '## 安全生产管理',
      '### 7.1 安全责任体系与目标落实',
      '落实版本正文段落。',
    ].join('\n'));
    chapter.sections = ['安全责任体系与目标落位', '安全责任体系与目标落地'];
    const result = mergeNearDuplicateSectionHeadings([chapter]);
    expect(result.mergedCount).toBe(0);
    expect(chapter.content).toContain('目标落实');
  });
});

describe('reconcileUnplannedSectionHeadings（规划外小节降 H4：D-T6 ②）', () => {
  const PLANNED_FOUR = ['安全生产责任体系与目标落位', '安全生产费用保障与使用制度', '安全教育培训与技术交底', '危险源辨识与风险分级管控'];

  it('r28f 形态：规划外非近名 H3 降为 H4（并入上方规划小节主题块，内容零改动）', () => {
    const chapter = makeChapter('ch-1', '确保安全生产的技术组织措施', [
      '## 确保安全生产的技术组织措施',
      '### 1.1 安全生产责任体系与目标落位',
      '落位正文。',
      '### 1.2 安全生产费用保障与使用制度',
      '费用正文。',
      '### 1.3 安全教育培训与技术交底',
      '教育正文。',
      '### 1.4 危险源辨识与风险分级管控',
      '风险正文。',
      '### 1.5 安全生产检查与隐患整改',
      '检查正文。',
    ].join('\n'));
    chapter.sections = PLANNED_FOUR;
    const result = reconcileUnplannedSectionHeadings([chapter]);
    expect(result.demotedCount).toBe(1);
    expect(chapter.content).toContain('#### 安全生产检查与隐患整改');
    expect(chapter.content).not.toContain('### 1.5');
    expect(chapter.content).toContain('检查正文。');
    expect(result.details[0]).toContain('降为 H4');
    // 幂等：降级后 H3 数不再超规划，复跑零变更
    const again = reconcileUnplannedSectionHeadings([chapter]);
    expect(again.demotedCount).toBe(0);
  });

  it('近名形态跳过：属 merge 辖区（降级会造成缺节 blocker）', () => {
    const chapter = makeChapter('ch-1', '确保安全生产的技术组织措施', [
      '## 确保安全生产的技术组织措施',
      '### 1.1 安全生产责任体系与目标落位',
      '落位正文。',
      '### 1.2 安全生产费用保障与使用制度',
      '费用正文。',
      '### 1.3 安全教育培训与技术交底',
      '教育正文。',
      '### 1.4 危险源辨识与风险分级管控',
      '风险正文。',
      '### 1.5 安全生产责任体系与目标落实',
      '落实版本正文。',
    ].join('\n'));
    chapter.sections = PLANNED_FOUR;
    const before = chapter.content;
    const result = reconcileUnplannedSectionHeadings([chapter]);
    expect(result.demotedCount).toBe(0);
    expect(chapter.content).toBe(before);
  });

  it('章首规划外跳过：上方无规划 H3 无归属可并入（保守交终检报告）', () => {
    const chapter = makeChapter('ch-1', '安全生产管理', [
      '## 安全生产管理',
      '### 1.1 安全生产检查与隐患整改',
      '检查正文。',
      '### 1.2 安全责任体系与目标落位',
      '落位正文。',
    ].join('\n'));
    chapter.sections = ['安全责任体系与目标落位'];
    const before = chapter.content;
    const result = reconcileUnplannedSectionHeadings([chapter]);
    expect(result.demotedCount).toBe(0);
    expect(chapter.content).toBe(before);
  });

  it('防撞名后缀跳过：「（1）」形态属 fixCollisionNumberedHeadings 辖区（不降级）', () => {
    const chapter = makeChapter('ch-1', '安全生产管理', [
      '## 安全生产管理',
      '### 1.1 安全责任体系与目标落位',
      '落位正文。',
      '### 1.2 安全生产检查与隐患整改（1）',
      '检查正文。',
    ].join('\n'));
    chapter.sections = ['安全责任体系与目标落位'];
    const result = reconcileUnplannedSectionHeadings([chapter]);
    expect(result.demotedCount).toBe(0);
  });

  it('成稿未超规划数时不触发（与 sectionCountOverflowIssues 同域）', () => {
    const chapter = makeChapter('ch-1', '安全生产管理', [
      '## 安全生产管理',
      '### 1.1 安全责任体系与目标落位',
      '落位正文。',
    ].join('\n'));
    chapter.sections = ['安全责任体系与目标落位'];
    const before = chapter.content;
    const result = reconcileUnplannedSectionHeadings([chapter]);
    expect(result.demotedCount).toBe(0);
    expect(chapter.content).toBe(before);
  });
});

describe('mergeDuplicateThematicSections（重复主题小节合并：D-T7 ②）', () => {
  it('同桶两节并存：保留首现、drop 标题行摘除、正文并入、规划数组同步、章内编号重排', () => {
    const chapter = makeChapter('ch-1', '施工资源配置计划', [
      '## 施工资源配置计划',
      '### 1.1 劳动力配置计划',
      '劳动力配置正文：高峰期投入充足作业人员。',
      '### 1.2 劳动力保证措施',
      '劳动力保证正文：农忙季节提前预留队伍。',
      '### 1.3 材料供应计划',
      '材料供应正文：按进度分批进场。',
    ].join('\n'));
    chapter.sections = ['劳动力配置计划', '劳动力保证措施', '材料供应计划'];
    const result = mergeDuplicateThematicSections([chapter]);
    expect(result.mergedCount).toBe(1);
    expect(chapter.sections).toEqual(['劳动力配置计划', '材料供应计划']);
    expect(chapter.content).toContain('### 1.1 劳动力配置计划');
    expect(chapter.content).not.toContain('劳动力保证措施');
    expect(chapter.content).toContain('劳动力保证正文：农忙季节提前预留队伍。');
    // 合并不消耗编号：后续小节重排为 1.2（原 1.3），编号序列无空档
    expect(chapter.content).toContain('### 1.2 材料供应计划');
    expect(result.details[0]).toContain('「劳动力保证措施」并入「劳动力配置计划」');
  });

  it('同桶三节并存：guard 循环逐对收敛至单节（规划数组逐项同步删除、编号无空档）', () => {
    const chapter = makeChapter('ch-1', '施工资源配置计划', [
      '## 施工资源配置计划',
      '### 1.1 劳动力配置计划',
      '配置正文。',
      '### 1.2 劳动力保证措施',
      '保证正文。',
      '### 1.3 劳动力动态管理',
      '动态正文。',
    ].join('\n'));
    chapter.sections = ['劳动力配置计划', '劳动力保证措施', '劳动力动态管理'];
    const result = mergeDuplicateThematicSections([chapter]);
    expect(result.mergedCount).toBe(2);
    expect(chapter.sections).toEqual(['劳动力配置计划']);
    expect((chapter.content.match(/^### /gmu) || [])).toHaveLength(1);
    expect(chapter.content).toContain('保证正文。');
    expect(chapter.content).toContain('动态正文。');
  });

  it('跨词命中同桶（机械设备计划）：施工设备管理并入机械配置计划', () => {
    const chapter = makeChapter('ch-1', '施工资源配置计划', [
      '## 施工资源配置计划',
      '### 2.1 机械配置计划',
      '机械配置正文。',
      '### 2.2 施工设备管理',
      '设备管理正文。',
    ].join('\n'));
    chapter.sections = ['机械配置计划', '施工设备管理'];
    const result = mergeDuplicateThematicSections([chapter]);
    expect(result.mergedCount).toBe(1);
    expect(chapter.sections).toEqual(['机械配置计划']);
    expect(chapter.content).not.toContain('施工设备管理');
    expect(chapter.content).toContain('设备管理正文。');
    expect(chapter.content).toContain('### 1.1 机械配置计划');
  });

  it('正文缺 H3 落位：无法定位成对 → 不合并（保守交终检报告）', () => {
    const chapter = makeChapter('ch-1', '施工资源配置计划', [
      '## 施工资源配置计划',
      '### 1.1 劳动力配置计划',
      '配置正文。',
    ].join('\n'));
    chapter.sections = ['劳动力配置计划', '劳动力保证措施'];
    const before = chapter.content;
    const result = mergeDuplicateThematicSections([chapter]);
    expect(result.mergedCount).toBe(0);
    expect(chapter.sections).toEqual(['劳动力配置计划', '劳动力保证措施']);
    expect(chapter.content).toBe(before);
  });

  it('非同桶（劳动力 + 材料）：单桶单项不触发合并', () => {
    const chapter = makeChapter('ch-1', '施工资源配置计划', [
      '## 施工资源配置计划',
      '### 1.1 劳动力配置计划',
      '配置正文。',
      '### 1.2 材料供应计划',
      '材料正文。',
    ].join('\n'));
    chapter.sections = ['劳动力配置计划', '材料供应计划'];
    const before = chapter.content;
    const result = mergeDuplicateThematicSections([chapter]);
    expect(result.mergedCount).toBe(0);
    expect(chapter.content).toBe(before);
  });

  it('幂等：合并后复跑零变化', () => {
    const chapter = makeChapter('ch-1', '施工资源配置计划', [
      '## 施工资源配置计划',
      '### 1.1 劳动力配置计划',
      '配置正文。',
      '### 1.2 劳动力保证措施',
      '保证正文。',
    ].join('\n'));
    chapter.sections = ['劳动力配置计划', '劳动力保证措施'];
    const first = mergeDuplicateThematicSections([chapter]);
    expect(first.mergedCount).toBe(1);
    const settled = chapter.content;
    const again = mergeDuplicateThematicSections([chapter]);
    expect(again.mergedCount).toBe(0);
    expect(chapter.content).toBe(settled);
  });

  it('C8 S4-② 数组并发去重：本体+（二）（三）后缀条目全命中同一 H3 行 → 保留本体、后缀删除、正文零改动', () => {
    // s28m' 机械章实锤：规划条目「道路作业机械配置与调度（二）」类后缀拆分经近名匹配（归一化后
    // 编辑距离 1，预算 2）全部命中本体同一 H3 行——旧逻辑 unique 化后仅剩首条即 break，数组残留
    // 后缀条目（正文=规划=目录三源不一致、duplicate-theme-merge 每轮重报空转）；collision 分支
    // 保留与 H3 行精确对应的本体、删除后缀条目（正文本无对应行，零内容改动）
    const chapter = makeChapter('ch-1', '道路作业机械配置与调度', [
      '## 道路作业机械配置与调度',
      '### 1.1 道路作业机械配置与调度',
      '机械配置正文。',
    ].join('\n'));
    chapter.sections = ['道路作业机械配置与调度', '道路作业机械配置与调度（二）', '道路作业机械配置与调度（三）'];
    const before = chapter.content;
    const result = mergeDuplicateThematicSections([chapter]);
    expect(result.mergedCount).toBe(1);
    expect(chapter.sections).toEqual(['道路作业机械配置与调度']);
    expect(chapter.content).toBe(before);
    expect(result.details[0]).toContain('道路作业机械配置与调度（二）、道路作业机械配置与调度（三）');
  });

  it('C8 S4-② 数组并发去重回退：无精确对应条目时保留行序首条（宁保勿删）', () => {
    const chapter = makeChapter('ch-1', '道路作业机械配置与调度', [
      '## 道路作业机械配置与调度',
      '### 1.1 道路作业机械配置与调度',
      '机械配置正文。',
    ].join('\n'));
    chapter.sections = ['道路作业机械配置与调度（二）', '道路作业机械配置与调度（三）'];
    const before = chapter.content;
    const result = mergeDuplicateThematicSections([chapter]);
    expect(result.mergedCount).toBe(1);
    expect(chapter.sections).toEqual(['道路作业机械配置与调度（二）']);
    expect(chapter.content).toBe(before);
  });

  it('C8 S4-② collision 后真重复对仍照常合并（continue 不吞后续轮次）', () => {
    const chapter = makeChapter('ch-1', '绿化工程', [
      '## 绿化工程',
      '### 1.1 道路作业机械配置与调度',
      '机械配置正文。',
      '### 1.2 苗木吊运与栽植机具',
      '吊运正文。',
    ].join('\n'));
    chapter.sections = ['道路作业机械配置与调度', '道路作业机械配置与调度（二）', '苗木吊运与栽植机具'];
    const result = mergeDuplicateThematicSections([chapter]);
    expect(result.mergedCount).toBe(2);
    expect(chapter.sections).toEqual(['道路作业机械配置与调度']);
    expect(chapter.content).toContain('吊运正文。');
    expect(chapter.content).not.toContain('苗木吊运与栽植机具');
    expect(result.details[0]).toContain('同节对齐去重');
    expect(result.details[1]).toContain('「苗木吊运与栽植机具」并入「道路作业机械配置与调度」');
  });
});

describe('AMBIGUOUS_RESIDUE_RE 残留冲突分类（F8）', () => {
  // 收口节点分类口径：命中 → 资料两可/审查提示类（benign，节点 success+warning）；
  // 不命中 → 确定性可修但残留（blocking，节点 failed 由交付门禁兑底）
  const benignSamples = [
    '基坑支护形式两可（土钉或锚杆），正文未锁定',
    '资料显示支护方案未明确，正文按资料照写',
    '设计图纸未明确支护参数，正文暂按图纸表述',
    '支护与锚杆并存，资料本身允许两种做法并存',
    '资料内容冲突：招标文件与图纸口径冲突',
  ];
  const blockingSamples = [
    '规格错位：“垫层”使用的规格 C35 与工程量清单权威（C15）不一致',
    '劳动力数据矛盾：正文“高峰期286人”与“约18人”互斥',
    '材料参数口径矛盾：“垫层混凝土强度等级”在部位「垫层」出现 C15 与 C20 两套口径',
    '计划总工期口径矛盾：正文出现 210日历天 与 45日历天 两套口径',
    '桩基表述残留：地基与基础章节施工流程为筏板/独立基础',
  ];

  it.each(benignSamples)('资料两可/审查提示类 → 匹配（benign）：%s', sample => {
    expect(AMBIGUOUS_RESIDUE_RE.test(sample)).toBe(true);
  });

  it.each(blockingSamples)('确定性可修类 → 不匹配（blocking）：%s', sample => {
    expect(AMBIGUOUS_RESIDUE_RE.test(sample)).toBe(false);
  });

  it('「两可」命中不区分语境（保守归类 benign，由交付门禁兑底）', () => {
    expect(AMBIGUOUS_RESIDUE_RE.test('材料选型两可')).toBe(true);
  });

  it('「按图纸」命中（正文写“详见设计图纸”类概括话术残留归 benign）', () => {
    expect(AMBIGUOUS_RESIDUE_RE.test('做法按图纸执行')).toBe(true);
  });

  it('正则无全局标志：连续 test 调用不交替返回 true/false', () => {
    expect(AMBIGUOUS_RESIDUE_RE.flags).not.toContain('g');
    const first = AMBIGUOUS_RESIDUE_RE.test('土钉或锚杆两可');
    const second = AMBIGUOUS_RESIDUE_RE.test('土钉或锚杆两可');
    expect(first).toBe(second);
  });
});
