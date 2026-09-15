/**
 * 4.35 容量密度可行性闭环（阶段挂载防回归）：stageBlueprint 在「蓝图落盘且校验通过 + longformStrict +
 * 开关未关闭」三重门控下按真实要点密度重校准章预算（写作前），其余情形零影响跳过。
 * mock：integratedBlueprint 重函数（构建/落盘/基础事实渲染/清单解析）与 billFactLock；
 * 真实链路：estimateChapterMinFeasibleWords / findBlueprintChapter / reanchorChapterTargetsByFeasibility /
 * displayStage / upsertProgressStage（挂载块的真实算法与进度写入全链路）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { DocumentTemplateChapter } from '@/services/document-workflow/types';
import type { GenerationSession } from '@/services/document-workflow/generationStages/generationSession';

const h = vi.hoisted(() => ({
  blueprint: undefined as unknown,
  throwBlueprint: false,
  capacityRecalibration: undefined as number | undefined,
}));

vi.mock('@/services/document-workflow/integratedBlueprint', async () => {
  const actual = await vi.importActual<typeof import('@/services/document-workflow/integratedBlueprint')>('@/services/document-workflow/integratedBlueprint');
  return {
    ...actual,
    buildIntegratedBlueprint: vi.fn(() => {
      if (h.throwBlueprint) throw new Error('蓝图构建失败（测试桩）');
      return h.blueprint;
    }),
    saveBlueprintAsset: vi.fn(() => '/tmp/blueprint.json'),
    renderBasicFactsForBlueprint: vi.fn(() => 'facts'),
    resolveBillOfQuantities: vi.fn(() => ({ boq: undefined })),
  };
});

vi.mock('@/services/document-workflow/billFactLock', () => ({ buildBillFactLock: vi.fn(() => undefined) }));

vi.mock('@/services/document-workflow/tuningProfile', async () => {
  const actual = await vi.importActual<typeof import('@/services/document-workflow/tuningProfile')>('@/services/document-workflow/tuningProfile');
  return {
    ...actual,
    tuningProfile: vi.fn(() => {
      const base = actual.tuningProfile();
      return h.capacityRecalibration === undefined ? base : { ...base, capacityFeasibilityRecalibration: h.capacityRecalibration };
    }),
  };
});

import { stageBlueprint } from '@/services/document-workflow/generationStages/stageBlueprint';

/** 舒城形态蓝图桩：13 小节共 96 工作包（要点数 = 96 工作包 + 7 未覆盖模板小节 = 103 → 密度下限 32400） */
const makeBlueprint = (passed = true) => ({
  validation: { passed, checks: passed ? [] : [{ name: '章节一致性', passed: false }] },
  outline: {
    chapters: [
      {
        id: '2',
        title: '主要施工方法',
        isActive: true,
        requiredParams: [],
        subSections: [12, 6, 7, 4, 8, 12, 11, 11, 12, 5, 3, 3, 2].map((count, sectionIndex) => ({
          id: `2.${sectionIndex + 1}`,
          title: `分部工程${sectionIndex + 1}`,
          requiredParams: [],
          tablePlans: [],
          workPackages: Array.from({ length: count }, (_, packageIndex) => ({ name: `工作包${sectionIndex + 1}-${packageIndex + 1}` })),
        })),
      },
    ],
  },
  diagnostics: { boq: undefined, warnings: [] },
});

const templateSections = ['拆除改造与清运施工方法', '填方压实与场平作业工序', '雨水污水管线敷设方法', '检查井与防坠网施工', '道路提升与破路恢复工艺', '公厕及门卫土建施工方法', '安装工程与设备调试方法'];

const chapter = (id: string, title: string, sections: string[]): DocumentTemplateChapter => ({ id, title, purpose: '', queries: [], requiredFacts: [], sections });

const makeSession = (options: { longformStrict: boolean; bidCompositionMissing?: boolean }) => {
  const chapters: DocumentTemplateChapter[] = [
    chapter('main', '主要施工方法', templateSections),
    ...Array.from({ length: 10 }, (_, index) => chapter(`c${index + 1}`, `第${index + 2}章 质量保证措施`, ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'])),
  ];
  const chapterTargets = new Map<string, number>([['main', 15600], ...chapters.slice(1).map(item => [item.id, 12440] as [string, number])]);
  const session = {
    prepare: { projectRoot: '/tmp/stage-blueprint-test', materialFilePaths: [], template: { name: '测试模板' }, documentSpec: undefined },
    understanding: {
      availableEvidenceScopePaths: [],
      requestedEvidencePerChapter: 8,
      canonicalFacts: {},
      writerEvidence: [],
      earlyFactPool: { localFacts: [], projectBasicFacts: [], preciseFacts: [] },
      searchWithCache: vi.fn(async () => []),
      // 标书编制规格（阶段 1 产物）：常规口径桩；bidCompositionMissing 时显式缺失，覆盖展示行防御分支
      bidComposition: options.bidCompositionMissing ? undefined : { bidType: 'unknown', bodyTablePolicy: 'allowed', bodyFigurePolicy: 'allowed', appendixPlan: [], formatRules: {}, identityMarksForbidden: false, conflicts: [], evidence: [] },
    },
    planning: {
      effectiveChapters: chapters,
      documentBudget: { chapterTargets, targetChars: 140000, longformStrict: options.longformStrict },
      generationBudget: { chapterConcurrency: 4, reviewConcurrency: 2 },
      generationDiagnostics: { evidence: { searchQueries: 0, searchMs: 0 }, llm: { lastInfo: '' } },
    },
    blueprint: {} as Record<string, unknown>,
    global: { progressStages: [] as Array<{ roleId?: string; status?: string; message?: string; details?: string[] }>, emitProgress: vi.fn(), input: { signal: undefined } },
  };
  return session;
};

const calibrationStageOf = (session: ReturnType<typeof makeSession>) => session.global.progressStages.find(stage => stage.roleId === 'chapter-budget-feasibility');

describe('stageBlueprint 章预算可行性重校准挂载（4.35 密度闭环）', () => {
  it('正向：蓝图校验通过 + longformStrict → 主要施工方法锚定密度下限 32400（Σ=140000 精确守恒），进度行落库', async () => {
    h.blueprint = makeBlueprint();
    h.throwBlueprint = false;
    h.capacityRecalibration = undefined;
    const session = makeSession({ longformStrict: true });
    const targetsRef = session.planning.documentBudget.chapterTargets;

    await stageBlueprint(session as unknown as GenerationSession);

    // 原位更新语义：Map 对象引用不变（session.planning 下所有别名同一 Map），内容为新预算
    expect(session.planning.documentBudget.chapterTargets).toBe(targetsRef);
    expect(targetsRef.get('main')).toBe(32400);
    expect([...targetsRef.values()].reduce((sum, value) => sum + value, 0)).toBe(140000);
    // 其余 10 章按需求归一化缩减：10760 = (140000-32400)/10，且不低于最低可写预算
    for (let index = 1; index <= 10; index += 1) expect(targetsRef.get(`c${index}`)).toBe(10760);
    // 进度行：11 章重锚 + 主要施工方法细节（要点 103 个）
    const stage = calibrationStageOf(session);
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('11 章按真实要点密度重锚');
    expect(stage?.details).toContain('主要施工方法：15600 → 32400 字（要点 103 个 × 密度下限 1800 字/块）');
    // 收尾：蓝图接管标记
    expect(session.blueprint.blueprintActive).toBe(true);
    // 规格展示消费：阶段 1 判定读入并落入蓝图进度行（常规口径桩）
    expect(session.global.progressStages.find(stage => stage.roleId === 'integrated-blueprint')?.details).toContain('标书编制规格：未识别勾选标记（按常规口径）');
  });

  it('非长文（longformStrict=false）跳过：章预算原样、无校准进度行', async () => {
    h.blueprint = makeBlueprint();
    h.throwBlueprint = false;
    h.capacityRecalibration = undefined;
    const session = makeSession({ longformStrict: false });

    await stageBlueprint(session as unknown as GenerationSession);

    expect(session.planning.documentBudget.chapterTargets.get('main')).toBe(15600);
    expect([...session.planning.documentBudget.chapterTargets.values()].reduce((sum, value) => sum + value, 0)).toBe(140000);
    expect(calibrationStageOf(session)).toBeUndefined();
  });

  it('蓝图校验未通过跳过：章预算原样、无校准进度行', async () => {
    h.blueprint = makeBlueprint(false);
    h.throwBlueprint = false;
    h.capacityRecalibration = undefined;
    const session = makeSession({ longformStrict: true });

    await stageBlueprint(session as unknown as GenerationSession);

    expect(session.planning.documentBudget.chapterTargets.get('main')).toBe(15600);
    expect(calibrationStageOf(session)).toBeUndefined();
  });

  it('蓝图构建异常（无蓝图）跳过：章预算原样、无校准进度行、不阻断', async () => {
    h.blueprint = undefined;
    h.throwBlueprint = true;
    h.capacityRecalibration = undefined;
    const session = makeSession({ longformStrict: true });

    await stageBlueprint(session as unknown as GenerationSession);

    expect(session.planning.documentBudget.chapterTargets.get('main')).toBe(15600);
    expect(calibrationStageOf(session)).toBeUndefined();
    expect(session.blueprint.blueprintActive).toBe(false);
  });

  it('应急开关关闭（capacityFeasibilityRecalibration=0）跳过：章预算原样、无校准进度行', async () => {
    h.blueprint = makeBlueprint();
    h.throwBlueprint = false;
    h.capacityRecalibration = 0;
    const session = makeSession({ longformStrict: true });

    await stageBlueprint(session as unknown as GenerationSession);

    expect(session.planning.documentBudget.chapterTargets.get('main')).toBe(15600);
    expect(calibrationStageOf(session)).toBeUndefined();
  });

  it('标书编制规格判定缺失（防御）：展示行降级不阻断蓝图挂载，重校准正常执行', async () => {
    h.blueprint = makeBlueprint();
    h.throwBlueprint = false;
    h.capacityRecalibration = undefined;
    const session = makeSession({ longformStrict: true, bidCompositionMissing: true });

    await stageBlueprint(session as unknown as GenerationSession);

    // 缺规格不影响蓝图挂载与重校准（展示行降级为「未识别（阶段 1 判定缺失，按常规口径）」）
    expect(session.blueprint.integratedBlueprint).toBeDefined();
    expect(session.blueprint.blueprintActive).toBe(true);
    expect(session.planning.documentBudget.chapterTargets.get('main')).toBe(32400);
    expect(session.global.progressStages.find(stage => stage.roleId === 'integrated-blueprint')?.details).toContain('标书编制规格：未识别（阶段 1 判定缺失，按常规口径）');
  });
});
