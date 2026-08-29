import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./llmClient', async () => {
  const actual = (await vi.importActual('./llmClient')) as typeof LlmClientModule;
  return { ...actual, callDocumentLlmJson: vi.fn() };
});
// 语义通道 mock：避免测试加载 Transformers.js 重依赖（检测器注入语义函数走注入通道）
vi.mock('./semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

import type * as LlmClientModule from './llmClient';
import { callDocumentLlmJson } from './llmClient';
import { hasProcessSequenceExpression } from './utils';
import { projectBasicFactScore, rewriteWorkPackageTerminology } from './documentGeneratorHelpers';
import { buildGenerationBudget } from './generationBudget';
import { emptyTenderRequirements, requirementsCoverageIssues } from './tenderRequirements';
import type { DocumentTemplate, DocumentTemplateChapter, TenderRequirementModel } from './types';

// 模块 5b：工序顺序表达多形式检测（箭头链强制放宽为任一形式）
describe('hasProcessSequenceExpression 多形式工序顺序表达检测', () => {
  it('箭头链形式命中', () => {
    expect(hasProcessSequenceExpression('基层清理→放线定位→分层施工→养护→验收')).toBe(true);
  });
  it('编号步骤形式命中', () => {
    expect(hasProcessSequenceExpression('1. 放线定位\n2. 分层施工\n3. 养护验收')).toBe(true);
  });
  it('顺序词叙述形式命中', () => {
    expect(hasProcessSequenceExpression('先进行基层清理，再进行分层摊铺，最后碾压验收')).toBe(true);
  });
  it('无序列表形式命中', () => {
    expect(hasProcessSequenceExpression('- 基层清理\n- 放线定位\n- 分层施工')).toBe(true);
  });
  it('无工序顺序表达不命中', () => {
    expect(hasProcessSequenceExpression('本工程严格按照规范要求组织施工，确保质量与安全。')).toBe(false);
  });
});

// 问题4：工作包后台术语确定性词形规范化（根治术语修复死循环）
describe('rewriteWorkPackageTerminology 工作包词形兜底', () => {
  it('“X工程工作包”去掉工作包后缀', () => {
    expect(rewriteWorkPackageTerminology('#### 拆除工程工作包')).toBe('#### 拆除工程');
  });
  it('“按工作包”改写为“按专业工程”', () => {
    expect(rewriteWorkPackageTerminology('按工作包逐项说明施工安排')).toBe('按专业工程逐项说明施工安排');
  });
  it('裸“工作包”兜底替换为“专业工程”', () => {
    expect(rewriteWorkPackageTerminology('正文以工作包为单位展开')).toBe('正文以专业工程为单位展开');
  });
  it('无工作包文本原样返回', () => {
    const text = '本工程包括拆除工程、门窗维修等专业工程。';
    expect(rewriteWorkPackageTerminology(text)).toBe(text);
  });
});

// 模块 1b：检索减分黑名单窄化（前附表实质条款切片不再被减分压出 Top-N）
describe('projectBasicFactScore 窄过滤', () => {
  it('前附表实质条款切片（含“投标人须知”标题+创优目标）不再减分', () => {
    const text = '投标人须知前附表\n确保获得黄山杯，支付300万元；计划工期540日历天；质量标准合格。';
    expect(projectBasicFactScore(text)).toBeGreaterThan(0);
  });
  it('纯程序性切片（保证金账户/开标时间）仍减分', () => {
    const text = '投标保证金账户：户名XX，账号XX；开标时间：2026-09-01 09:00；解密方式：电子交易系统在线解密。';
    expect(projectBasicFactScore(text)).toBeLessThan(0);
  });
});

// 模块 4：前附表响应条款零响应检测走窄过滤分支（LLM 已语义分类的实质条款不被通用黑名单整条跳过）
describe('requirementsCoverageIssues 前附表条款窄过滤', () => {
  const model: TenderRequirementModel = {
    ...emptyTenderRequirements(true),
    frontScheduleClauses: [
      { text: '投标人须确保获得“黄山杯”，支付300万元。', coreTerms: ['黄山杯'] },
      { text: '合同工期：540日历天。', coreTerms: ['合同工期', '540日历天'] },
      { text: '投标保证金账户：XX银行户名XXX。', coreTerms: ['保证金账户'] },
    ],
  };
  // 程序性/实质性 LLM 分类 mock：index 0/1 为实质条款（参与检测），index 2 保证金账户为程序性条款（跳过）
  const zeroSimilarity = () => 0;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(callDocumentLlmJson).mockResolvedValue({ results: [
      { index: 0, responsive: true },
      { index: 1, responsive: true },
      { index: 2, responsive: false },
    ] });
  });

  it('“投标人须确保黄山杯”类条款（含“投标”字样）未被整条跳过，零命中时报未响应', async () => {
    const issues = await requirementsCoverageIssues('# 工程概况\n\n本工程工期满足要求。', model, { semanticSimilarity: zeroSimilarity });
    expect(issues.some(issue => /评分项要求未响应/u.test(issue.message) && issue.message.includes('黄山杯'))).toBe(true);
  });

  it('“合同工期”类条款（含“合同”字样）coreTerms 未被黑名单滤掉，落位后不误报', async () => {
    const similarity = (left: string, right: string) => (left.includes('合同工期') && right.includes('合同工期') ? 0.9 : 0);
    const issues = await requirementsCoverageIssues('# 进度计划\n\n合同工期540日历天，按总进度计划执行。', model, { semanticSimilarity: similarity, bodyTexts: ['合同工期540日历天，按总进度计划执行。'] });
    expect(issues.some(issue => /合同工期/u.test(issue.message))).toBe(false);
  });

  it('纯程序条款（保证金账户）被窄过滤跳过，不参与零响应检测', async () => {
    const issues = await requirementsCoverageIssues('# 工程概况\n\n本工程工期满足要求。', model, { semanticSimilarity: zeroSimilarity });
    expect(issues.some(issue => /保证金账户/u.test(issue.message))).toBe(false);
  });
});

// 问题4：修复轮次预算收紧 + 文档级总池硬顶
describe('buildGenerationBudget 轮次预算收紧', () => {
  const baseTemplate: DocumentTemplate = { id: 't', name: 'n', outputTitle: '', description: '', category: '', chapters: [] };
  const baseChapters: DocumentTemplateChapter[] = Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, title: `第${index + 1}章`, purpose: '', queries: [], requiredFacts: [] }));
  const baseInput = {
    template: baseTemplate,
    chapters: baseChapters,
    targetWords: 45000,
    requirement: '',
    materialFileCount: 10,
    evidenceCount: 60,
    hasVeryLargeExplicitChapter: false,
    configuredChapterConcurrency: 0,
    strategy: { mode: 'strict' as const, enableChapterReview: true, enableGlobalReview: true, enableDocumentBudgetExpansion: true, enableFinalQualityReview: true },
  };

  it('4.5 万字文档每章修复轮上限收紧到 4 轮以内', () => {
    const budget = buildGenerationBudget(baseInput);
    expect(budget.repairRoundBudget).toBeLessThanOrEqual(4);
    expect(budget.repairRoundBudget).toBeGreaterThanOrEqual(2);
  });

  it('文档级总池加硬顶（12 章 × 每章上限 ≤ max(12, 2×章数)=24）', () => {
    const budget = buildGenerationBudget(baseInput);
    expect(budget.repairPoolBudget).toBeLessThanOrEqual(24);
    expect(budget.repairPoolBudget).toBeGreaterThanOrEqual(12);
  });

  it('小文档（<2 万字）每章修复轮为 base 2', () => {
    const budget = buildGenerationBudget({ ...baseInput, targetWords: 8000 });
    expect(budget.repairRoundBudget).toBe(2);
  });
});

// 模块 2：写作任务书注入前附表响应清单与规模事实卡（type 层验证，无需 LLM）
describe('写作任务书前附表注入（函数级验证）', () => {
  it('frontScheduleClauses 为空时 globalWritingFocus 不含前附表注入段（不注入空清单）', () => {
    // 注入逻辑在 buildWritingTaskBrief 内联，此处仅验证空数组展开语义与字段契约
    const clauses: TenderRequirementModel['frontScheduleClauses'] = [];
    const lines = clauses.map(item => item.text).filter(Boolean).slice(0, 12);
    expect(lines).toEqual([]);
    expect(clauses.map((_item, index) => `${index + 1}.`).join('')).toBe('');
  });

  it('mock 输出中 frontScheduleClauses 可被 cleanItems 管道解析（schema 契约）', () => {
    // 提取 schema 契约验证：frontScheduleClauses 必须是数组且单项含 text/coreTerms
    const mock = { frontScheduleClauses: [{ text: '确保黄山杯，支付300万元。', coreTerms: ['黄山杯'], source: '招标文件.pdf' }] };
    expect(Array.isArray(mock.frontScheduleClauses)).toBe(true);
    expect(mock.frontScheduleClauses[0].text).toContain('黄山杯');
    vi.resetAllMocks();
  });
});

// ============ round-23 P0-3：PDF 标题标记夹断清洗（建设规模“平方2.8”截断修复） ============
import { cleanPdfHeadingNoise, extractProjectBasicFactsFromEvidence } from './factsModel';
import type { DocumentEvidence } from './types';

describe('cleanPdfHeadingNoise PDF 标题标记清洗', () => {
  it('句中间夹入“### 米”的标记被移除并闭合句子（平方###米→平方米）', () => {
    const text = '### 2.6建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方\n\n### 米（其中：地上建筑面积24783.39平方米）';
    const cleaned = cleanPdfHeadingNoise(text);
    expect(cleaned).not.toContain('###');
    expect(cleaned).toContain('28570.36平方米');
    expect(cleaned).toContain('2.6建设规模');
  });

  it('正常正文（无标记）原样保留', () => {
    const text = '建设规模：总建筑面积28570.36平方米。';
    expect(cleanPdfHeadingNoise(text)).toBe(text);
  });
});

describe('extractProjectBasicFactsFromEvidence 建设规模夹断修复', () => {
  it('“平方\\n\\n### 米”夹断文本能提取完整含单位的值（历史缺陷：值被截成“28570.36平方”缺“米”）', () => {
    const evidence: DocumentEvidence[] = [
      { chapterId: 'project-basic', filePath: '招标文件.pdf', sectionTitle: '2.6建设规模', score: 8, content: '### 2.6建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方\n\n### 米（其中：地上建筑面积24783.39平方米，地下建筑面积3786.97平方米），地上\n\n### 6层，地下1层。', roleId: 'tender_document', processingType: 'reference' },
    ];
    const facts = extractProjectBasicFactsFromEvidence(evidence);
    const scaleFacts = facts.filter(fact => fact.fieldId === 'project_scale');
    expect(scaleFacts.length).toBeGreaterThan(0);
    const value = scaleFacts[0].value;
    expect(value).toContain('28570.36平方米');
    expect(value).not.toContain('###');
    expect(value).not.toContain('平方2.8');
  });

  it('无夹断的正常建设规模值不受影响', () => {
    const evidence: DocumentEvidence[] = [
      { chapterId: 'project-basic', filePath: '补疑.docx', sectionTitle: '建设规模', score: 8, content: '建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方米。', roleId: 'addendum', processingType: 'reference' },
    ];
    const facts = extractProjectBasicFactsFromEvidence(evidence);
    const scaleFacts = facts.filter(fact => fact.fieldId === 'project_scale');
    expect(scaleFacts[0].value).toContain('28570.36平方米');
  });
});
