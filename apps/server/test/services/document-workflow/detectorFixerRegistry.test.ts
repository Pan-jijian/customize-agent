import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDetectorUsageCoverage, assertRegistryConsistency, AUTHORITY_REGISTRY, DETERMINISTIC_FIXER_ANCHORS, det, detectorEntry, FINALIZE_REPAIR_ROUNDS, FULL_VALIDATION_DETECTORS, LLM_PATCH_REPAIR_ROUNDS, resetDetectorUsage, STANDARD_FINAL_DETECTORS } from '@/services/document-workflow/detectorFixerRegistry';
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

  it('确定性修复器锚定声明与 SURFACE_FIX_STEPS 键一一对应（顺序快照）', () => {
    const stepKeys = SURFACE_FIX_STEPS.map(step => step.key);
    const anchorIds = DETERMINISTIC_FIXER_ANCHORS.map(entry => entry.id);
    expect(anchorIds).toEqual(stepKeys);
    for (const entry of DETERMINISTIC_FIXER_ANCHORS) {
      expect(entry.kind).toBe('deterministic');
      expect(detectorEntry(entry.anchoredTo)).toBeDefined();
    }
  });

  it('LLM patch 修复轮 8 轮全部带 patchGuard 且锚定检测器存在、guard 检测器全部 deterministicSafe', () => {
    expect(LLM_PATCH_REPAIR_ROUNDS).toHaveLength(8);
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

  it('LLM patch 修复轮 8 轮 id 顺序快照（P11 全链接入登记，变更必须显式改快照并附理由）', () => {
    expect(LLM_PATCH_REPAIR_ROUNDS.map(entry => entry.id)).toEqual([
      'fact-landing',
      'table-repair',
      'table-execution-repair',
      'templating-repair',
      'workpackage-skeleton-repair',
      'planned-section-repair',
      'global-consistency-repair',
      'qingtian-review-repair',
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

  it('FINALIZE_REPAIR_ROUNDS 顺序快照（14 轮锁死，变更必须显式改快照并附理由）', () => {
    expect([...FINALIZE_REPAIR_ROUNDS]).toEqual([
      'fact-landing-round',
      'table-repair-round',
      'semantic-choice-conflict',
      'deterministic-stage5',
      'formal-source-clean',
      'qingtian-full-review',
      'planned-section-final',
      'commercial-strip',
      'table-deterministic-repair',
      'numeric-verification',
      'requirement-verification',
      'post-review-surface',
      'terminology-strip',
      'toc-consistency',
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
