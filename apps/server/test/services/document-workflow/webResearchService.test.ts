import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentFact, RuntimePromptRuleSet, WebAccessConfig } from '@/services/document-workflow/types';
import { retrieveWebEvidence, webAccessPrompt, webEvidenceLeakageIssues } from '@/services/document-workflow/webResearchService';

const configOf = (overrides: Partial<WebAccessConfig> = {}): WebAccessConfig => ({
  enabled: true,
  allowProjectFacts: false,
  maxQueriesPerChapter: 3,
  maxResultsPerQuery: 5,
  trustedDomains: [],
  ...overrides,
});

const rulesOf = (overrides: Partial<RuntimePromptRuleSet> = {}): RuntimePromptRuleSet => ({
  forbiddenTerms: [],
  preferredTerms: [],
  requiredTables: [],
  sourceHash: 'test-hash',
  exactHeadings: [],
  forbidExtraHeadings: false,
  requiredSubjects: [],
  forbiddenSubjects: [],
  backendTerms: [],
  commercialTerms: [],
  forbidFabrication: true,
  requireEvidenceForQuantities: true,
  preferProjectFacts: true,
  chapterRules: [],
  roleRules: [],
  executionSummary: [],
  ...overrides,
});

const localFact = (value: string): DocumentFact => ({
  key: '项目名称', value, sourceFile: '招标文件.pdf', roleId: 'project_basic', confidence: 0.9,
});

function duckHtml(results: Array<{ url: string; title: string; snippet: string }>) {
  return results.map(item => `<a class="result__a" href="${item.url}">${item.title}</a><a class="result__snippet">${item.snippet}</a>`).join('');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('webAccessPrompt', () => {
  it('禁用联网返回空串', () => {
    expect(webAccessPrompt(false)).toBe('');
  });

  it('启用联网渲染 5 条公开资料使用规则', () => {
    const prompt = webAccessPrompt(true);
    expect(prompt).toContain('公开资料补充使用规则：');
    expect(prompt).toContain('不得使用公开资料新增或修改项目名称');
    expect(prompt).toContain('本地项目资料与公开资料冲突时');
    expect(prompt).toContain('不得在正文中出现任何检索过程');
  });
});

describe('webEvidenceLeakageIssues', () => {
  it('联网过程性表述报警告', () => {
    const issues = webEvidenceLeakageIssues('本节内容根据网页资料与搜索结果整理。');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('联网增强过程性表述');
  });

  it('正常正文零问题', () => {
    expect(webEvidenceLeakageIssues('本工程按专项施工方案组织实施。')).toEqual([]);
  });
});

describe('retrieveWebEvidence', () => {
  it('配置未启用 → 空结果早退（不发起检索）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await retrieveWebEvidence({
      config: configOf({ enabled: false }),
      chapterId: 'ch-1',
      chapterTitle: '危大工程管理',
      sectionTitles: ['专项施工方案'],
      runtimeRules: rulesOf(),
      localFacts: [],
    });
    expect(result).toEqual({ evidence: [], queries: [], filtered: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('章节不属于联网主题（工程概况）→ 空结果早退', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await retrieveWebEvidence({
      config: configOf(),
      chapterId: 'ch-1',
      chapterTitle: '工程概况',
      sectionTitles: ['项目基本情况'],
      runtimeRules: rulesOf(),
      localFacts: [],
    });
    expect(result.evidence).toHaveLength(0);
    expect(result.queries).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('联网章节检索成功 → 生成证据并判定政策类来源', async () => {
    const html = duckHtml([
      { url: 'https://zjt.example.gov.cn/doc/1', title: '危大工程专项施工方案管理规定', snippet: '危大工程专项施工方案必须组织专家论证，超过一定规模的危大工程应当组织专家论证审查。' },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
    const result = await retrieveWebEvidence({
      config: configOf(),
      chapterId: 'ch-1',
      chapterTitle: '危大工程管理',
      sectionTitles: ['专项施工方案'],
      runtimeRules: rulesOf(),
      localFacts: [],
    });
    expect(result.queries.length).toBeGreaterThan(0);
    expect(result.queries[0]).toContain('危大工程');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.filePath).toBe('https://zjt.example.gov.cn/doc/1');
    expect(result.evidence[0]?.source).toBe('web-policy');
    expect(result.evidence[0]?.content).toContain('参考依据：危大工程专项施工方案管理规定');
    expect(result.evidence[0]?.content).toContain('专家论证');
  });

  it('本地项目事实与商务词结果被过滤，仅保留合规结果', async () => {
    const html = duckHtml([
      { url: 'https://zjt.example.gov.cn/doc/1', title: '危大工程管理规定', snippet: '危大工程专项施工方案必须组织专家论证审查后方可实施。' },
      { url: 'https://example.com/a', title: '报价说明', snippet: '本项目报价明细包含暂列金额500万元，税率按国家规定执行。' },
      { url: 'https://example.com/b', title: '项目信息', snippet: '项目名称：某市安置房项目，建设地点：某区。' },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
    const result = await retrieveWebEvidence({
      config: configOf(),
      chapterId: 'ch-1',
      chapterTitle: '危大工程管理',
      sectionTitles: [],
      runtimeRules: rulesOf(),
      localFacts: [],
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.filePath).toBe('https://zjt.example.gov.cn/doc/1');
  });

  it('提示词禁用词过滤检索结果', async () => {
    const html = duckHtml([
      { url: 'https://zjt.example.gov.cn/doc/1', title: '危大工程管理规定', snippet: '危大工程专项施工方案必须组织专家论证审查。' },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
    const result = await retrieveWebEvidence({
      config: configOf(),
      chapterId: 'ch-1',
      chapterTitle: '危大工程管理',
      sectionTitles: [],
      runtimeRules: rulesOf({ forbiddenTerms: ['专家论证'] }),
      localFacts: [],
    });
    expect(result.evidence).toHaveLength(0);
  });

  it('trustedDomains 白名单过滤域名', async () => {
    const html = duckHtml([
      { url: 'https://zjt.example.gov.cn/doc/1', title: '危大工程管理规定', snippet: '危大工程专项施工方案必须组织专家论证审查。' },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
    const result = await retrieveWebEvidence({
      config: configOf({ trustedDomains: ['trusted-domain.com'] }),
      chapterId: 'ch-1',
      chapterTitle: '危大工程管理',
      sectionTitles: [],
      runtimeRules: rulesOf(),
      localFacts: [],
    });
    expect(result.evidence).toHaveLength(0);
  });

  it('检索请求失败计入 filtered 且不产出证据', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const result = await retrieveWebEvidence({
      config: configOf(),
      chapterId: 'ch-1',
      chapterTitle: '危大工程管理',
      sectionTitles: [],
      runtimeRules: rulesOf(),
      localFacts: [],
    });
    expect(result.evidence).toHaveLength(0);
    expect(result.filtered).toBeGreaterThan(0);
  });

  it('摘要中的本地项目事实被剥离（不引入本项目商务/身份数据）', async () => {
    // snippet 不得含“项目名称/报价”等检索层过滤词（否则整条结果被丢弃，不进入剥离层）
    const html = duckHtml([
      { url: 'https://zjt.example.gov.cn/doc/1', title: '危大工程管理规定', snippet: '危大工程专项施工方案必须组织专家论证审查。本项目位于合肥市某区安置房项目地块南侧。' },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
    const result = await retrieveWebEvidence({
      config: configOf(),
      chapterId: 'ch-1',
      chapterTitle: '危大工程管理',
      sectionTitles: [],
      runtimeRules: rulesOf(),
      localFacts: [localFact('合肥市某区安置房项目')],
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.content).not.toContain('合肥市某区安置房项目');
    expect(result.evidence[0]?.content).toContain('专家论证');
  });
});
