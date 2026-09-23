/**
 * §L3-11 接线检测器的正/负例单测（4.55.36 批次 1）。
 *
 * 覆盖 6 个「登记却零 det() 调用点」检测器接线后的端到端行为：走 `buildStandardFinalValidationIssues`
 * 聚合出口断言，而不是直接调检测函数——接线本身（det(id, …) 真的被调用、结果真的进最终问题流）也在断言范围内。
 *
 * 正例 = 真实缺陷形态必须被检出（漏检即回到 4.55.36 的漏网状态）；
 * 负例 = 合法形态（规范/法规引用、单一来源表述、正常厚度、正常数据句、正常列表/表格）不得误伤
 * （误伤会经修复链删除正文 → 原文信息零丢失红线）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStandardFinalValidationIssues } from '@/services/document-workflow/documentFinalValidation';
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
  const scopeClassifier: FactTokenScopeClassifier = { batchClassify: async queries => queries.map(() => 'other' as const) };
  const professionalDepthClassifier: ProfessionalDepthClassifier = { analyze: analyzeMock as ProfessionalDepthClassifier['analyze'] };
  return { scopeClassifier, professionalDepthClassifier };
}

async function messagesFor(markdown: string): Promise<string[]> {
  const { scopeClassifier, professionalDepthClassifier } = classifierMocks();
  const issues = await buildStandardFinalValidationIssues({
    markdown,
    chapters: [draftChapter({ content: markdown })],
    factsModel: emptyFactsModel,
    template,
    promptBindings: [],
    factTokenScopeClassifier: scopeClassifier,
    professionalDepthClassifier,
  });
  return issues.map(issue => issue.message);
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

describe('§L3-11 检测器接线：正例（真缺陷必报）', () => {
  it('truncated-sentence：段末无终止标点（尾段可读正文）报 blocker，且不从 structure-integrity 重复报出', async () => {
    const markdown = '# 1 工程概况\n\n本工程位于合肥市包河区，施工范围含道路、排水与绿化附属设施，具体内容以经批准的施工图设计文件为准\n\n# 2 施工部署\n\n按合同工期组织施工。\n';
    const messages = await messagesFor(markdown);
    expect(messages.filter(message => message.startsWith('句尾截断：'))).toHaveLength(1);
    // 族分工：truncated-line 已从 structure-integrity 的 kinds 中排除（同一行不得两条 blocker 重复占修复预算）
    expect(messages.filter(message => message.includes('结构完整性缺陷：段末截断'))).toHaveLength(0);
  });

  it('atlas-reference-phrase：ASCII 尖括号 + 图集号（实测漏网形态）报 blocker', async () => {
    const markdown = '# 3 排水工程\n\n雨水口按皖2015S209/93~94页设置加固，做法详见<混凝土排水管道基础及接口>23S5166/21页。\n';
    const messages = await messagesFor(markdown);
    expect(messages.filter(message => message.includes('图集/标准图指向替代做法'))).toHaveLength(1);
  });

  it('source-enumeration：正文来源罗列话术报 blocker', async () => {
    const markdown = '# 4 施工方案\n\n本工程根据招标文件、工程量清单、施工图纸，确定施工方案。\n';
    const messages = await messagesFor(markdown);
    expect(messages.filter(message => message.includes('资料来源罗列话术'))).toHaveLength(1);
  });

  it('meta-discourse-declaration：自我声明句报 blocker', async () => {
    const markdown = '# 5 资源配置\n\n劳动力峰值 71 人，不再另行出现其他口径。\n';
    const messages = await messagesFor(markdown);
    expect(messages.filter(message => message.includes('元话语声明句'))).toHaveLength(1);
  });

  it('finish-thickness：装饰层厚度数量级异常报 blocker', async () => {
    const markdown = '# 6 装修工程\n\n内墙抹面厚度200mm，分两遍成活。\n';
    const messages = await messagesFor(markdown);
    expect(messages.filter(message => message.includes('装饰层工艺参数异常'))).toHaveLength(1);
  });

  it('formula-residue：正文公式形态残留报 blocker', async () => {
    const markdown = '# 7 临时用电\n\n用电负荷按 P = K1 Σ P 计算，用电负荷约 48kW。\n';
    const messages = await messagesFor(markdown);
    expect(messages.filter(message => message.includes('公式形态残留'))).toHaveLength(1);
  });
});

describe('§L3-11 检测器接线：负例（合法形态不得误伤）', () => {
  it('规范/法规引用（书名号 + 标准代号）不判图集指向（§L3-10 历史事故形态）', async () => {
    const markdown = '# 8 编制依据\n\n建筑节能工程按《绿色建筑评价标准》（GB/T 50378-2019）执行，验收按《建筑工程施工质量验收统一标准》GB 50300-2013 执行。\n';
    const messages = await messagesFor(markdown);
    expect(messages.filter(message => message.includes('图集/标准图指向替代做法'))).toHaveLength(0);
  });

  it('单一来源表述（无罗列）不判来源罗列话术；编制依据小节内罗列豁免', async () => {
    const body = '# 9 施工方案\n\n施工时按设计图纸要求控制管道标高与坡度，验收前完成闭水试验。\n';
    expect((await messagesFor(body)).filter(message => message.includes('资料来源罗列话术'))).toHaveLength(0);
    const basis = '# 10 编制依据\n\n## 10.1 编制依据\n\n本工程根据招标文件、工程量清单、施工图纸，确定施工方案。\n';
    expect((await messagesFor(basis)).filter(message => message.includes('资料来源罗列话术'))).toHaveLength(0);
  });

  it('正常数据句与正常装饰厚度不误报', async () => {
    const markdown = '# 11 装修工程\n\n劳动力峰值 71 人。内墙抹面厚度20mm。用电负荷约 48kW，由箱变经总配电箱分配。\n';
    const messages = await messagesFor(markdown);
    expect(messages.filter(message => message.includes('元话语声明句'))).toHaveLength(0);
    expect(messages.filter(message => message.includes('装饰层工艺参数异常'))).toHaveLength(0);
    expect(messages.filter(message => message.includes('公式形态残留'))).toHaveLength(0);
  });

  it('列表项/表格行/引导句/表题等结构行不判句尾截断', async () => {
    const markdown = [
      '# 12 进度计划',
      '',
      '- 工序衔接按流水段划分',
      '- 主体结构分段验收',
      '',
      '| 工序 | 工期 |',
      '| --- | --- |',
      '| 基础施工 | 30 天 |',
      '',
      '主要工序安排如下：',
      '',
      '表12-1 施工进度计划',
      '',
      '| 阶段 | 内容 |',
      '| --- | --- |',
      '| 准备 | 场地平整 |',
      '',
      '各阶段完成后按验收标准报验。',
      '',
    ].join('\n');
    const messages = await messagesFor(markdown);
    expect(messages.filter(message => message.startsWith('句尾截断：'))).toHaveLength(0);
  });

  it('数量收尾的正常句（行尾数字 + 后续为标题）不判句尾截断', async () => {
    const markdown = '# 14 资源配置\n\n本工程共投入主要施工机械 12\n\n## 14.1 机械配置\n\n按台班计划进场。\n';
    const messages = await messagesFor(markdown);
    expect(messages.filter(message => message.startsWith('句尾截断：'))).toHaveLength(0);
  });

  it('规范代号收尾的罗列句被截断（§L3-11 实测漏网形态）判句尾截断', async () => {
    // 行尾裸代号是「规范罗列被截断」的强信号：正常句不会以 `GB 55037-2022` 收尾而无终止标点
    const markdown = '# 15 编制依据\n\n本工程执行《混凝土结构工程施工质量验收规范》（GB 50204-2015）、（JGJ 18-2012）、GB 55037-2022\n\n## 15.1 其他\n\n按上述依据执行。\n';
    const messages = await messagesFor(markdown);
    expect(messages.filter(message => message.startsWith('句尾截断：'))).toHaveLength(1);
  });
});
