import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDetectorUsageCoverage, assertRegistryConsistency, AUXILIARY_DETECTORS, AUTHORITY_REGISTRY, DETERMINISTIC_FIXER_ANCHORS, det, detSafe, detectorEntry, FINALIZE_REPAIR_ROUNDS, FULL_VALIDATION_DETECTORS, LLM_PATCH_REPAIR_ROUNDS, NUMERIC_ARBITER_FIXERS, resetDetectorUsage, STANDARD_FINAL_DETECTORS, VALID_DETECTOR_CATEGORIES } from '@/services/document-workflow/detectorFixerRegistry';
import { SURFACE_FIX_STEPS } from '@/services/document-workflow/deterministicFixChains';
import { buildStandardFinalValidationIssues } from '@/services/document-workflow/documentFinalValidation';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplate } from '@/services/document-workflow/types';
import type { FactTokenScopeClassifier } from '@/services/document-workflow/factTokenClassifier';
import type { ProfessionalDepthClassifier } from '@/services/document-workflow/professionalDepthClassifier';
import type * as LlmClientModule from '@/services/document-workflow/llmClient';
import type * as SemanticSimilarityModule from '@/services/document-workflow/semanticSimilarity';

const buildSemanticSimilarityMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<(leftText: string, rightText: string) => number>>());
const embedDocumentsMock = vi.hoisted(() => vi.fn<(texts: string[]) => Promise<number[][]>>());
const callDocumentLlmMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | undefined>>());
const callDocumentLlmJsonMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());

vi.mock('@/services/document-workflow/semanticSimilarity', async (importOriginal) => {
  const actual = await importOriginal<typeof SemanticSimilarityModule>();
  return {
    ...actual,
    buildSemanticSimilarity: buildSemanticSimilarityMock,
    getLocalSemanticProvider: () => ({ embedDocuments: embedDocumentsMock }),
  };
});

vi.mock('@/services/document-workflow/llmClient', async (importOriginal) => {
  const actual = await importOriginal<typeof LlmClientModule>();
  return { ...actual, callDocumentLlm: callDocumentLlmMock, callDocumentLlmJson: callDocumentLlmJsonMock };
});

const analyzeMock = vi.hoisted(() => vi.fn<(text: string) => Promise<unknown>>());

const template: DocumentTemplate = {
  id: 'tpl-1', name: '施工组织设计模板', description: '', category: 'document', outputTitle: '施工组织设计', chapters: [],
};
const emptyFactsModel: DocumentFactsModel = {
  project: [], schedule: [], quality: [], safety: [], resources: [], tables: [], drawings: [], bills: [], preciseFacts: [], rules: [], specifications: [],
  schemaFacts: {}, factIndex: { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] }, missing: [], conflicts: [],
};

function draftChapter(overrides: Partial<DocumentDraftChapter> = {}): DocumentDraftChapter {
  return { id: 'ch-1', title: '工程概况', content: '', evidence: [], missingFacts: [], ...overrides };
}

function classifierMocks() {
  const scopeClassifier: FactTokenScopeClassifier = {
    batchClassify: async queries => queries.map(() => 'other' as const),
  };
  const professionalDepthClassifier: ProfessionalDepthClassifier = {
    analyze: analyzeMock as ProfessionalDepthClassifier['analyze'],
  };
  return { scopeClassifier, professionalDepthClassifier };
}

beforeEach(() => {
  buildSemanticSimilarityMock.mockReset();
  buildSemanticSimilarityMock.mockResolvedValue(() => 0);
  embedDocumentsMock.mockReset();
  embedDocumentsMock.mockImplementation(async (texts: string[]) => texts.map(() => [0, 0]));
  callDocumentLlmMock.mockReset();
  callDocumentLlmMock.mockResolvedValue(undefined);
  callDocumentLlmJsonMock.mockReset();
  callDocumentLlmJsonMock.mockResolvedValue(undefined);
  analyzeMock.mockReset();
  analyzeMock.mockResolvedValue(undefined);
  resetDetectorUsage();
});

describe('detectorFixerRegistry 结构一致性（P23）', () => {
  it('assertRegistryConsistency 静默通过（锚定存在/权威相等/llm-patch 带 patchGuard）', () => {
    expect(() => assertRegistryConsistency()).not.toThrow();
  });

  it('权威注册表 7 项且 id 唯一，覆盖全部 AuthorityId', () => {
    expect(AUTHORITY_REGISTRY).toHaveLength(7);
    const ids = AUTHORITY_REGISTRY.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(['schedule', 'assemblyRate', 'supportSystem', 'laborPeak', 'greeningMaintenance', 'blueprint', 'canonicalFacts']));
    for (const entry of AUTHORITY_REGISTRY) {
      expect(typeof entry.extract).toBe('function');
    }
  });

  it('检测器声明表 id 唯一（三组合并无重复键）', () => {
    const all = [...FULL_VALIDATION_DETECTORS, ...STANDARD_FINAL_DETECTORS];
    const ids = all.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of all) {
      expect(['chapter', 'full-document']).toContain(entry.scope);
      expect(typeof entry.category).toBe('string');
    }
  });

  it('检测器 category 全部落在合法集（V2 批3：门禁硬阻断按 category 判定，非法值静默逃逸即缺陷）', () => {
    const all = [...FULL_VALIDATION_DETECTORS, ...STANDARD_FINAL_DETECTORS, ...AUXILIARY_DETECTORS];
    expect(VALID_DETECTOR_CATEGORIES.size).toBe(9);
    for (const entry of all) {
      expect(VALID_DETECTOR_CATEGORIES.has(entry.category)).toBe(true);
    }
  });

  it('确定性修复器锚定声明与 SURFACE_FIX_STEPS 键一一对应（顺序快照）', () => {
    const stepKeys = SURFACE_FIX_STEPS.map(step => step.key);
    const anchorIds = DETERMINISTIC_FIXER_ANCHORS.map(entry => entry.id);
    expect(anchorIds).toEqual(stepKeys);
    for (const entry of DETERMINISTIC_FIXER_ANCHORS) {
      expect(entry.kind).toBe('deterministic');
      expect(detectorEntry(entry.anchoredTo)).toBeDefined();
    }
  });

  it('数值裁决器修复器 2 项（4.27.0 A1/A2）：kind deterministic、锚定检测器存在、不进 SURFACE_FIX_STEPS 键集', () => {
    expect(NUMERIC_ARBITER_FIXERS).toHaveLength(2);
    expect(NUMERIC_ARBITER_FIXERS.map(entry => entry.anchoredTo)).toEqual(['parameter-concept-conflict', 'spec-location-mismatch']);
    const stepKeys = new Set(SURFACE_FIX_STEPS.map(step => step.key));
    for (const entry of NUMERIC_ARBITER_FIXERS) {
      expect(entry.kind).toBe('deterministic');
      expect(entry.giveUpOnFailure).toBe(true);
      expect(detectorEntry(entry.anchoredTo)).toBeDefined();
      expect(stepKeys.has(entry.id)).toBe(false);
    }
  });

  it('LLM patch 修复轮 18 轮全部带 patchGuard 且锚定检测器存在、guard 检测器 全部 deterministicSafe', () => {
    expect(LLM_PATCH_REPAIR_ROUNDS).toHaveLength(18);
    for (const entry of LLM_PATCH_REPAIR_ROUNDS) {
      expect(entry.kind).toBe('llm-patch');
      expect(entry.patchGuard).toBeDefined();
      expect(entry.patchGuard!.detectors.length).toBeGreaterThan(0);
      expect(detectorEntry(entry.anchoredTo)).toBeDefined();
      for (const guardId of entry.patchGuard!.detectors) {
        expect(detectorEntry(guardId)?.deterministicSafe).toBe(true);
      }
    }
  });

  it('content-depth-repair 多锚定声明（alsoAnchoredTo 九项均登记，r8 六检测器统一收口 + D-T1 专业评分 + C3-4 参数义务 + C3-5 清单落位 + C3-6-4 图纸引用）', () => {
    const round = LLM_PATCH_REPAIR_ROUNDS.find(entry => entry.id === 'content-depth-repair');
    expect(round?.anchoredTo).toBe('critical-section-depth');
    // C3-4 扩展：parameter-obligation-usage（可靠参数义务落位 <90% 独立门禁）加入扩展锚定——
    // 此前参数义务缺口挂靠 precise-fact-usage blocker 消费（关键池达标即零消费，s28l 94 条义务零消费实锤）
    // C3-5 扩展：boq-placement（清单落位不足 blocker）加入扩展锚定——此前 17 轮修复无一消费直坠终门禁
    // C3-6-4 扩展：drawing-reference（图纸事实引用率 <90% warning）加入扩展锚定——96/118 份从未获注入（s28l 实测）
    expect(round?.alsoAnchoredTo).toEqual(['emergency-section-depth', 'construction-org-major-content', 'construction-org-division-section', 'precise-fact-usage', 'parameter-obligation-usage', 'overview-recap', 'professional-score', 'boq-placement', 'drawing-reference']);
    for (const anchorId of round?.alsoAnchoredTo ?? []) {
      expect(detectorEntry(anchorId)).toBeDefined();
    }
  });

  it('LLM patch 修复轮 18 轮 id 顺序快照（P11 全链接入登记，变更必须显式改快照并附理由）', () => {
    expect(LLM_PATCH_REPAIR_ROUNDS.map(entry => entry.id)).toEqual([
      'fact-landing',
      'table-repair',
      'table-execution-repair',
      'templating-repair',
      'workpackage-skeleton-repair',
      'planned-section-repair',
      'global-consistency-repair',
      'quotation-balance-repair',
      'content-depth-repair',
      'control-loop-repair',
      'professional-chain-repair',
      'basis-regulations-repair',
      'basis-regulations-cross-repair',
      'dangerous-applicability-repair',
      'auto-spec-gate-repair',
      'length-compression-repair',
      'table-caption-repair',
      'table-arithmetic-repair',
    ]);
  });

  it('patchGuard 预检集十类快照（与 patchGuard.deterministicDefectPrecheck 同源扩展）', () => {
    for (const entry of LLM_PATCH_REPAIR_ROUNDS) {
      expect([...entry.patchGuard!.detectors].sort()).toEqual([
        'fabricated-start-date',
        'finish-thickness',
        'formal-placeholder',
        'formula-residue',
        'internal-terminology-anchor',
        'meta-discourse-declaration',
        'repeated-word',
        'source-enumeration',
        'truncated-sentence',
        'writer-missing-section',
      ]);
    }
  });

  it('FINALIZE_REPAIR_ROUNDS 顺序快照（32 轮锁死，变更必须显式改快照并附理由）', () => {
    expect([...FINALIZE_REPAIR_ROUNDS]).toEqual([
      'fact-landing-round',
      'table-repair-round',
      'semantic-choice-conflict',
      'deterministic-stage5',
      'formal-source-clean',
      'planned-section-final',
      'commercial-strip',
      'table-deterministic-repair',
      'numeric-verification',
      'requirement-response-repair',
      'requirement-verification',
      'content-depth-repair',
      'control-loop-repair',
      'professional-chain-repair',
      'post-review-surface',
      'terminology-strip',
      'regulation-number-typo',
      'quotation-balance-repair',
      'basis-regulations-repair',
      'basis-regulations-cross-repair',
      'dangerous-applicability-repair',
      'auto-spec-gate-repair',
      'toc-consistency',
      'length-compression-repair',
      'fact-distribution-round',
      'table-caption-repair',
      'table-arithmetic-repair',
      'empty-section-sweep',
      'section-alignment-sweep',
      'templating-sweep',
      'duplicate-theme-merge',
      'delivery-structure-closure',
      'sentence-pattern-sweep',
      'duplicate-sentence-collapse',
      'templating-tail-replay',
    ]);
  });
});

describe('detectorFixerRegistry 执行侧登记（P7/P8）', () => {
  it('det() 透传返回值并登记 id；未登记 id 触发逃逸检查', () => {
    expect(det('fact-consistency', () => 42)).toBe(42);
    det('undeclared-detector-id', () => 0);
    expect(() => assertDetectorUsageCoverage('standard-final')).toThrow(/未登记的检测器/);
    resetDetectorUsage();
  });

  it('跑 buildStandardFinalValidationIssues 后 standard-final 组无哑火条目、无逃逸登记', async () => {
    const { scopeClassifier, professionalDepthClassifier } = classifierMocks();
    await buildStandardFinalValidationIssues({
      markdown: '',
      chapters: [draftChapter()],
      factsModel: emptyFactsModel,
      template,
      promptBindings: [],
      factTokenScopeClassifier: scopeClassifier,
      professionalDepthClassifier,
    });
    expect(() => assertDetectorUsageCoverage('standard-final')).not.toThrow();
  });
});

describe('detSafe 末期安全包装（finalize 硬停治理）', () => {
  it('run 成功：透传返回值且登记 id 与 det 契约一致', async () => {
    const issues = await detSafe('fact-consistency', async () => [{ level: 'warning' as const, message: 'x' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toBe('x');
  });

  it('run 抛错：返回显性 warning 降级 issue（不抛出、不静默）', async () => {
    const issues = await detSafe('fact-consistency', () => { throw new Error('嵌入服务不可用'); });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'warning', severity: 'warning', category: 'format', owner: 'system', repairability: 'manual_review' });
    expect(issues[0]!.message).toContain('fact-consistency');
    expect(issues[0]!.message).toContain('嵌入服务不可用');
    expect(issues[0]!.message).toContain('已降级');
  });

  it('run 异步抛错同样降级（await 包裹）', async () => {
    const issues = await detSafe('fact-consistency', async () => { throw new Error('异步失败'); });
    expect(issues[0]!.level).toBe('warning');
    expect(issues[0]!.message).toContain('异步失败');
  });

  it('id 登记契约与 det 一致：未声明 id 触发逃逸检查', async () => {
    await detSafe('undeclared-detector-id', async () => []);
    expect(() => assertDetectorUsageCoverage('standard-final')).toThrow(/未登记的检测器/);
  });
});
