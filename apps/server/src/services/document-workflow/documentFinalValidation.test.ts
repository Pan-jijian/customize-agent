import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStandardFinalValidationIssues } from './documentFinalValidation';
import type { FactTokenScopeClassifier } from './factTokenClassifier';
import type * as LlmClientModule from './llmClient';
import type { ProfessionalDepthClassifier } from './professionalDepthClassifier';
import type * as SemanticSimilarityModule from './semanticSimilarity';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplate } from './types';

const buildSemanticSimilarityMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<(leftText: string, rightText: string) => number>>());
const embedDocumentsMock = vi.hoisted(() => vi.fn<(texts: string[]) => Promise<number[][]>>());
const callDocumentLlmMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | undefined>>());
const callDocumentLlmJsonMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());

vi.mock('./semanticSimilarity', async (importOriginal) => {
  const actual = await importOriginal<typeof SemanticSimilarityModule>();
  return {
    ...actual,
    buildSemanticSimilarity: buildSemanticSimilarityMock,
    getLocalSemanticProvider: () => ({ embedDocuments: embedDocumentsMock }),
  };
});

vi.mock('./llmClient', async (importOriginal) => {
  const actual = await importOriginal<typeof LlmClientModule>();
  return { ...actual, callDocumentLlm: callDocumentLlmMock, callDocumentLlmJson: callDocumentLlmJsonMock };
});

const analyzeMock = vi.hoisted(() => vi.fn<(text: string) => Promise<unknown>>());

const emptyFactsModel: DocumentFactsModel = {
  project: [], schedule: [], quality: [], safety: [], resources: [], tables: [], drawings: [], bills: [], preciseFacts: [], rules: [], specifications: [],
  schemaFacts: {}, factIndex: { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] }, missing: [], conflicts: [],
};

const template: DocumentTemplate = {
  id: 'tpl-1', name: '施工组织设计模板', description: '', category: 'document', outputTitle: '施工组织设计', chapters: [],
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
});

describe('buildStandardFinalValidationIssues', () => {
  it('空输入不抛错并返回校验问题数组', async () => {
    const { scopeClassifier, professionalDepthClassifier } = classifierMocks();
    const issues = await buildStandardFinalValidationIssues({
      markdown: '',
      chapters: [],
      factsModel: emptyFactsModel,
      template,
      promptBindings: [],
      factTokenScopeClassifier: scopeClassifier,
      professionalDepthClassifier,
    });
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.every(item => typeof item.message === 'string')).toBe(true);
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  it('专业深度分析按章节数透传调用且空分析被过滤', async () => {
    const { scopeClassifier, professionalDepthClassifier } = classifierMocks();
    const issues = await buildStandardFinalValidationIssues({
      markdown: '',
      chapters: [draftChapter(), draftChapter({ id: 'ch-2', title: '施工方案' })],
      factsModel: emptyFactsModel,
      template,
      promptBindings: [],
      factTokenScopeClassifier: scopeClassifier,
      professionalDepthClassifier,
    });
    expect(analyzeMock).toHaveBeenCalledTimes(2);
    expect(Array.isArray(issues)).toBe(true);
  });

  it('内部术语精确词触发 C2 blocker 聚合', async () => {
    const { scopeClassifier, professionalDepthClassifier } = classifierMocks();
    const issues = await buildStandardFinalValidationIssues({
      markdown: '# 第一章 工程概况\n\n本工程按工作包组织施工内容。',
      chapters: [draftChapter({ content: '工程概况内容。' })],
      factsModel: emptyFactsModel,
      template,
      promptBindings: [],
      factTokenScopeClassifier: scopeClassifier,
      professionalDepthClassifier,
    });
    expect(issues.some(item => item.message.includes('后台内部术语'))).toBe(true);
  });

  it('缺少目录页触发 tocHierarchyIssues 错误', async () => {
    const { scopeClassifier, professionalDepthClassifier } = classifierMocks();
    const issues = await buildStandardFinalValidationIssues({
      markdown: '# 第一章 工程概况\n\n工程概况正文内容。',
      chapters: [draftChapter({ content: '工程概况内容。' })],
      factsModel: emptyFactsModel,
      template,
      promptBindings: [],
      factTokenScopeClassifier: scopeClassifier,
      professionalDepthClassifier,
    });
    expect(issues.some(item => item.message.includes('缺少目录页'))).toBe(true);
  });

  it('生成未达标占位标记触发 formalPlaceholderIssues', async () => {
    const { scopeClassifier, professionalDepthClassifier } = classifierMocks();
    const issues = await buildStandardFinalValidationIssues({
      markdown: '【本小节生成未达标，需重新生成】',
      chapters: [],
      factsModel: emptyFactsModel,
      template,
      promptBindings: [],
      factTokenScopeClassifier: scopeClassifier,
      professionalDepthClassifier,
    });
    expect(issues.some(item => item.message.includes('生成未完成'))).toBe(true);
  });

  it('semanticSimilarity 恒零与 LLM 空响应下全链路不抛错', async () => {
    const { scopeClassifier, professionalDepthClassifier } = classifierMocks();
    const markdown = '# 第一章 工程概况\n\n工程概况正文内容，包含总建筑面积28570.36平方米等关键信息。\n\n## 目录\n\n- 第一章 工程概况';
    const issues = await buildStandardFinalValidationIssues({
      markdown,
      chapters: [draftChapter({ content: '工程概况正文内容。' })],
      factsModel: emptyFactsModel,
      template,
      promptBindings: [{ promptId: 'p-1', roleId: 'r-1' }],
      factTokenScopeClassifier: scopeClassifier,
      professionalDepthClassifier,
    });
    expect(Array.isArray(issues)).toBe(true);
    expect(buildSemanticSimilarityMock).toHaveBeenCalled();
  });
});
