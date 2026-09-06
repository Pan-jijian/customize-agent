/**
 * globalQualityGates（v3 统一审查 + 清单冻结）单测：
 * 统一一致性审查（全局 LLM 审查 + 数据一致性数值矛盾审查并行合并为单一问题清单）、
 * 清单冻结（修复轮只消费冻结清单、不再重审全文，初检 + 末轮统一复检各一次）、
 * 单轮定向修复（每章一次 patch，失败即记录）、确定性去重（重复段落删除后重算快照）。
 * LLM/语义通道全部 mock（避免真实 LLM 与本地 bge 模型调用）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AMBIGUOUS_RESIDUE_RE, enforceWorkPackageSkeletons, repairTemplatingIssues, runGlobalConsistencyReviewLoop } from '@/services/document-workflow/globalQualityGates';
import type { DocumentDraftChapter, DocumentEvidence, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate } from '@/services/document-workflow/types';
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
    fillerDensityMock.mockResolvedValue({ totalSentences: 10, fillerSentences: 0, ratio: 0, level: 'light', vagueCandidateSentences: 0, vagueSemanticSentences: 0, fillerSentenceDetails: [] });
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

  it('套话占比超标触发锚点直连修复：套话句/缺要素条目原文进 anchorTexts，指令区分两类锚点', async () => {
    fillerDensityMock.mockResolvedValue({ totalSentences: 10, fillerSentences: 3, ratio: 0.3, level: 'medium', vagueCandidateSentences: 0, vagueSemanticSentences: 0, fillerSentenceDetails: [] });
    difficultyMock.mockResolvedValue({ countermeasures: 2, attributed: 0, quantified: 0, bothCount: 0, ratio: 0, heavyTemplated: true, entries: [{ text: '基坑降水难度大需控制。', attributed: false, quantified: false }] });
    fillerTargetsMock.mockResolvedValue([{ chapterId: 'ch-1', chapterTitle: '工程概况', section: '概况', sentence: '精心组织科学管理。' }]);
    repairMock.mockResolvedValue({ content: '本工程为办公楼项目。基坑降水需将周边沉降控制在5mm以内。', appliedCount: 1, producedCount: 2, repairType: 'quality' as never });
    const chapters = [makeChapter('ch-1', '工程概况', '本工程为办公楼项目。精心组织科学管理。基坑降水难度大需控制。')];
    const result = await repairTemplatingIssues(makeTemplatingInput(chapters));
    expect(result.templatingFixApplied).toBe(true);
    const firstCall = repairMock.mock.calls[0][0];
    expect(firstCall.anchorTexts).toEqual(['精心组织科学管理。', '基坑降水难度大需控制。']);
    expect(firstCall.issues[0]).toContain('套话句');
    expect(firstCall.issues[0]).toContain('重难点分析条目');
    expect(firstCall.issues[0]).toContain('不得改动');
  });

  it('套话占比达标且重难点双达标：不触发修复（零 LLM 成本）', async () => {
    fillerDensityMock.mockResolvedValue({ totalSentences: 10, fillerSentences: 0, ratio: 0.05, level: 'light', vagueCandidateSentences: 0, vagueSemanticSentences: 0, fillerSentenceDetails: [] });
    difficultyMock.mockResolvedValue({ countermeasures: 2, attributed: 2, quantified: 2, bothCount: 2, ratio: 1, heavyTemplated: false, entries: [] });
    const result = await repairTemplatingIssues(makeTemplatingInput([makeChapter('ch-1', '工程概况', '本工程为办公楼项目。')]));
    expect(result.templatingFixApplied).toBe(false);
    expect(repairMock).not.toHaveBeenCalled();
  });

  it('修复 patch 未落地：不进入第二轮，套话占比未收敛', async () => {
    fillerDensityMock.mockResolvedValue({ totalSentences: 10, fillerSentences: 3, ratio: 0.3, level: 'medium', vagueCandidateSentences: 0, vagueSemanticSentences: 0, fillerSentenceDetails: [] });
    difficultyMock.mockResolvedValue({ countermeasures: 0, attributed: 0, quantified: 0, bothCount: 0, ratio: 0, heavyTemplated: false, entries: [] });
    fillerTargetsMock.mockResolvedValue([{ chapterId: 'ch-1', chapterTitle: '工程概况', section: '概况', sentence: '精心组织科学管理。' }]);
    const chapters = [makeChapter('ch-1', '工程概况', '本工程为办公楼项目。精心组织科学管理。')];
    // repairChapterByQuality 返回原文（无 patch 落地）→ 本章不应用
    repairMock.mockResolvedValue({ content: chapters[0].content, appliedCount: 0, producedCount: 0, repairType: 'quality' as never });
    const result = await repairTemplatingIssues(makeTemplatingInput(chapters));
    expect(result.templatingFixApplied).toBe(false);
    expect(repairMock).toHaveBeenCalledTimes(1);
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
  function mockNoopRepair() {
    repairMock.mockImplementation(async args => ({ content: args.chapter.content, appliedCount: 0, producedCount: 0, repairType: 'quality' as never }));
  }

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
