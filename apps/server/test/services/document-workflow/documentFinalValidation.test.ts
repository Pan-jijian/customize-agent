import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { buildStandardFinalValidationIssues, crossChapterDuplicateSectionIssues } from '@/services/document-workflow/documentFinalValidation';
import type { FactTokenScopeClassifier } from '@/services/document-workflow/factTokenClassifier';
import type * as LlmClientModule from '@/services/document-workflow/llmClient';
import type { ProfessionalDepthClassifier } from '@/services/document-workflow/professionalDepthClassifier';
import type * as SemanticSimilarityModule from '@/services/document-workflow/semanticSimilarity';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplate } from '@/services/document-workflow/types';

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

  // F14 终检兑底：规格错位在导出前最后防线拦截（修复链漏修时兑底）；权威映射缺失静默跳过
  it('终检 factsModel 带 specAuthorityMap：正文「垫层 C35」vs 权威 C15 → 报规格错位', async () => {
    const { scopeClassifier, professionalDepthClassifier } = classifierMocks();
    const issues = await buildStandardFinalValidationIssues({
      markdown: '# 第一章 工程概况\n\n垫层采用C35商品混凝土浇筑。',
      chapters: [draftChapter({ content: '垫层采用C35商品混凝土浇筑。' })],
      factsModel: {
        ...emptyFactsModel,
        specAuthorityMap: {
          混凝土强度等级: [
            { location: '垫层', spec: 'C15', quantity: '125.80m3', sourceFile: '清单.xls' },
            { location: '基础', spec: 'C30', quantity: '86.40m3', sourceFile: '清单.xls' },
          ],
        },
      },
      template,
      promptBindings: [],
      factTokenScopeClassifier: scopeClassifier,
      professionalDepthClassifier,
    });
    expect(issues.some(item => item.message.includes('规格错位') && item.message.includes('C35'))).toBe(true);
  });

  it('终检 specAuthorityMap 缺失 → 规格错位检测静默跳过不误报', async () => {
    const { scopeClassifier, professionalDepthClassifier } = classifierMocks();
    const issues = await buildStandardFinalValidationIssues({
      markdown: '# 第一章 工程概况\n\n垫层采用C35商品混凝土浇筑。',
      chapters: [draftChapter({ content: '垫层采用C35商品混凝土浇筑。' })],
      factsModel: emptyFactsModel,
      template,
      promptBindings: [],
      factTokenScopeClassifier: scopeClassifier,
      professionalDepthClassifier,
    });
    expect(issues.some(item => item.message.includes('规格错位'))).toBe(false);
  });
});

/** 1.4 形态 B：跨章同名 H3 小节检测（归属按模板计划匹配章裁决） */
describe('crossChapterDuplicateSectionIssues（1.4 跨章同名 H3 检测）', () => {
  it('实锤形态：同名小节同现 1.3 与 6.4，模板计划归属第一章 → 第六章被报串章', () => {
    const chapters = [
      draftChapter({ id: 'ch-1', title: '第一章 工程概况', content: '### 1.1 项目概况\n概况正文。\n### 1.3 周边环境、管线与既有建构筑物保护\n第一章的周边环境正文。' }),
      draftChapter({ id: 'ch-6', title: '第六章 施工安全保证措施', content: '### 6.1 安全管理体系\n安全管理正文。\n### 6.4 周边环境、管线与既有建构筑物保护\n第六章串章正文。' }),
    ];
    const templateChapters: DocumentTemplate['chapters'] = [
      { id: 't-1', title: '工程概况', purpose: '', queries: [], requiredFacts: [], sections: ['项目概况', '周边环境、管线与既有建构筑物保护'] },
      { id: 't-6', title: '施工安全保证措施', purpose: '', queries: [], requiredFacts: [], sections: ['安全管理体系'] },
    ];
    const issues = crossChapterDuplicateSectionIssues(chapters, templateChapters);
    expect(issues).toHaveLength(1);
    expect(issues[0].chapterId).toBe('ch-6');
    expect(issues[0].message).toContain('跨章同名小节');
    expect(issues[0].message).toContain('周边环境、管线与既有建构筑物保护');
    expect(issues[0].message).toContain('第一章 工程概况');
  });

  it('模板计划多章安排同名小节 = 有意分工，不报', () => {
    const chapters = [
      draftChapter({ id: 'ch-1', title: '第一章 工程概况', content: '### 1.1 绿色施工与环境保护措施\n第一章正文。' }),
      draftChapter({ id: 'ch-2', title: '第二章 施工方案', content: '### 2.1 绿色施工与环境保护措施\n第二章正文。' }),
    ];
    const templateChapters: DocumentTemplate['chapters'] = [
      { id: 't-1', title: '工程概况', purpose: '', queries: [], requiredFacts: [], sections: ['绿色施工与环境保护措施'] },
      { id: 't-2', title: '施工方案', purpose: '', queries: [], requiredFacts: [], sections: ['绿色施工与环境保护措施'] },
    ];
    expect(crossChapterDuplicateSectionIssues(chapters, templateChapters)).toEqual([]);
  });

  it('模板未安排同名小节 → 首现章保留，后续章报串章', () => {
    const chapters = [
      draftChapter({ id: 'ch-1', title: '第一章 工程概况', content: '### 1.4 竣工清理、验收移交与保修\n第一章正文。' }),
      draftChapter({ id: 'ch-6', title: '第六章 施工安全保证措施', content: '### 6.5 竣工清理、验收移交与保修\n第六章串章正文。' }),
    ];
    const issues = crossChapterDuplicateSectionIssues(chapters, []);
    expect(issues).toHaveLength(1);
    expect(issues[0].chapterId).toBe('ch-6');
  });

  it('短通用标题（去编号 <8 字符）跨章重复属正常分工，不报', () => {
    const chapters = [
      draftChapter({ id: 'ch-1', title: '第一章 工程概况', content: '### 1.1 质量控制\n第一章质量控制正文。' }),
      draftChapter({ id: 'ch-2', title: '第二章 施工方案', content: '### 2.1 质量控制\n第二章质量控制正文。' }),
    ];
    expect(crossChapterDuplicateSectionIssues(chapters, [])).toEqual([]);
  });

  it('章内同名 H3 重复不计跨章（章内重复由 duplicate-subsection 通道治理）', () => {
    const chapters = [
      draftChapter({ id: 'ch-1', title: '第一章 工程概况', content: '### 1.1 周边环境、管线与既有建构筑物保护\n甲段。\n### 1.2 周边环境、管线与既有建构筑物保护\n乙段。' }),
    ];
    expect(crossChapterDuplicateSectionIssues(chapters, [])).toEqual([]);
  });
});
