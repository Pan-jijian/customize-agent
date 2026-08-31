import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chapterSectionFactUsageIssues, chunkTextForReview, reviewGlobalConsistency } from './chapterReview';
import { buildSectionFactCard } from './chapterGeneration';
import type * as LlmClientModule from './llmClient';
import type { DocumentDraftChapter, DocumentEvidence, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from './types';

const callDocumentLlmMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | undefined>>());
const callDocumentLlmJsonMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());

vi.mock('./llmClient', async (importOriginal) => {
  const actual = await importOriginal<typeof LlmClientModule>();
  return { ...actual, callDocumentLlm: callDocumentLlmMock, callDocumentLlmJson: callDocumentLlmJsonMock };
});

vi.mock('@customize-agent/knowledge', () => {
  class LocalTransformersEmbeddingProvider {}
  return { LocalTransformersEmbeddingProvider };
});

/** 商务行语义 gate 注入的确定性嵌入：商务变体词面（材料价格/商务报价）→ [1,0]；允许事实词面（合同估算价/最高投标限价）→ [0,1] */
const embedDocuments = async (texts: string[]) => texts.map(text => {
  const commercialLike = /材料价格|商务报价|报价明细|综合单价|暂列金额/u.test(text);
  const legalLike = /合同估算价|投资估算|最高投标限价|招标控制价/u.test(text);
  return [commercialLike && !legalLike ? 1 : 0, legalLike ? 1 : 0];
});

const DIAGNOSTICS = {} as DocumentGenerationDiagnostics;

function chapter(overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id: 'ch-1', title: '工程概况', purpose: '说明项目概况', queries: [], requiredFacts: ['项目名称'], ...overrides };
}

function evidenceItem(overrides: Partial<DocumentEvidence> = {}): DocumentEvidence {
  return { chapterId: 'ch-1', filePath: '/data/招标文件.txt', score: 0.9, content: '计划工期540日历天。', ...overrides };
}

function draftChapter(overrides: Partial<DocumentDraftChapter> = {}): DocumentDraftChapter {
  return { id: 'ch-1', title: '工程概况', content: '', evidence: [], missingFacts: [], ...overrides };
}

const template: DocumentTemplate = {
  id: 'tpl-1', name: '施工组织设计模板', description: '', category: 'document', outputTitle: '施工组织设计', chapters: [chapter()],
};

beforeEach(() => {
  callDocumentLlmMock.mockReset();
  callDocumentLlmMock.mockResolvedValue(undefined);
  callDocumentLlmJsonMock.mockReset();
  callDocumentLlmJsonMock.mockResolvedValue(undefined);
});

describe('chapterSectionFactUsageIssues', () => {
  it('小节正文过短时报补写问题', async () => {
    const issues = await chapterSectionFactUsageIssues({
      chapter: chapter(),
      content: '### 工程概况\n工程概况内容简述。',
      evidence: [evidenceItem()],
    }, embedDocuments);
    expect(issues).toEqual(['工程概况：小节正文过短，需补写专业做法和证据依据']);
  });

  it('正文足够长且事实落位时无问题', async () => {
    const body = '本项目计划工期540日历天，施工过程中严格按照合同要求组织各专业工序穿插作业，落实质量安全责任制度，加强现场管理与过程检查，确保工程进度满足总体工期目标要求。各分部分项工程均编制专项施工方案并经审批后实施，关键工序实行旁站监督与隐蔽验收，材料进场履行报验程序，检验批次与取样频率满足规范规定，安全文明施工措施同步落实到位，定期开展隐患排查与整改闭环管理，确保施工全过程处于受控状态。';
    expect(body.replace(/\s+/gu, '').length).toBeGreaterThanOrEqual(180);
    const issues = await chapterSectionFactUsageIssues({
      chapter: chapter(),
      content: `### 工程概况\n${body}`,
      evidence: [evidenceItem()],
    }, embedDocuments);
    expect(issues).toEqual([]);
  });

  it('无 ### 小节标题时返回空', async () => {
    const issues = await chapterSectionFactUsageIssues({
      chapter: chapter(),
      content: '普通正文无小节标题。',
      evidence: [evidenceItem()],
    }, embedDocuments);
    expect(issues).toEqual([]);
  });

  it('事实卡为空时不报问题', async () => {
    // 证据行过短无法构成事实卡条目 → sectionFactUsageIssue 返回 undefined
    const issues = await chapterSectionFactUsageIssues({
      chapter: chapter(),
      content: '### 工程概况\n工程概况内容简述。',
      evidence: [evidenceItem({ content: '其他' })],
    }, embedDocuments);
    expect(issues).toEqual([]);
  });
});

describe('chunkTextForReview', () => {
  it('按 chunkChars 分块并加序号前缀', () => {
    const text = '字'.repeat(2500);
    const chunks = chunkTextForReview(text, 1000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.startsWith('**第 1/3 部分**')).toBe(true);
    expect(chunks[1]!.startsWith('**第 2/3 部分**')).toBe(true);
    expect(chunks[2]!.startsWith('**第 3/3 部分**')).toBe(true);
  });

  it('空文本返回空数组', () => {
    expect(chunkTextForReview('', 1000)).toEqual([]);
    expect(chunkTextForReview('   ', 1000)).toEqual([]);
  });
});

describe('reviewGlobalConsistency', () => {
  const content = '总建筑面积28570.36平方米。\n计划工期540日历天。';

  it('聚合去重跨章问题并标记失败', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({ issues: ['问题A：建筑面积口径冲突', '问题A：建筑面积口径冲突', '问题B：工期冲突'] });
    const result = await reviewGlobalConsistency({
      template,
      chapters: [draftChapter({ content })],
      chapterReviews: [],
      promptTexts: '提示词',
      projectContext: '项目上下文',
      diagnostics: DIAGNOSTICS,
    });
    expect(result.issues).toEqual(['问题A：建筑面积口径冲突', '问题B：工期冲突']);
    expect(result.stage).toMatchObject({ status: 'failed' });
    expect(result.stage.message).toContain('发现 2 个跨章问题');
  });

  it('无问题标记成功且数值口径清单进入审查视野', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({ issues: [] });
    const result = await reviewGlobalConsistency({
      template,
      chapters: [draftChapter({ content })],
      chapterReviews: [],
      promptTexts: '提示词',
      projectContext: '',
      diagnostics: DIAGNOSTICS,
    });
    expect(result.issues).toEqual([]);
    expect(result.stage).toMatchObject({ status: 'success' });
    expect(result.stage.message).toBe('全局一致性审查通过');
    expect(callDocumentLlmJsonMock).toHaveBeenCalledTimes(1);
    const prompt = callDocumentLlmJsonMock.mock.calls[0]![1] as string;
    expect(prompt).toContain('数值口径清单');
    expect(prompt).toContain('总建筑面积28570.36平方米');
  });

  it('已中止信号立即抛出', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(reviewGlobalConsistency({
      template,
      chapters: [draftChapter({ content })],
      chapterReviews: [],
      promptTexts: '提示词',
      projectContext: '',
      diagnostics: DIAGNOSTICS,
      signal: controller.signal,
    })).rejects.toThrow('用户中止');
  });
});

describe('buildSectionFactCard 量化参数落位清单（4.1 两步生成第一步）', () => {
  it('默认在任务卡事实行之外注入词粒度精确参数清单', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem({ content: '计划工期540日历天。\n混凝土强度等级C35，给水管DN300，管径300mm。' })], embedDocuments);
    expect(card.prompt).toContain('【当前小节写作任务卡】');
    expect(card.prompt).toContain('【量化参数落位清单】');
    expect(card.preciseTokens).toContain('540日历天');
    expect(card.preciseTokens).toContain('C35');
    expect(card.preciseTokens).toContain('DN300');
    expect(card.preciseTokens).toContain('300mm');
    expect(card.prompt).toContain('540日历天');
  });

  it('事实行无法构成任务卡时清单仍独立注入', async () => {
    // 「工作表」行被事实卡噪声过滤，但词粒度参数仍可从证据提取
    const card = await buildSectionFactCard('工程概况', [evidenceItem({ content: '工作表 DN300 管线' })], embedDocuments);
    expect(card.items).toEqual([]);
    expect(card.preciseTokens).toContain('DN300');
    expect(card.prompt).not.toContain('【当前小节写作任务卡】');
    expect(card.prompt).toContain('【量化参数落位清单】');
  });

  it('报价明细类商务行参数不进入清单', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem({ content: '投标报价明细：综合单价450元。' })], embedDocuments);
    expect(card.preciseTokens).toEqual([]);
    expect(card.prompt).not.toContain('【量化参数落位清单】');
  });

  it('OCR 噪声行参数不进入清单', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem({ content: 'OCR识别错误：管径为DN300。' })], embedDocuments);
    expect(card.preciseTokens).toEqual([]);
  });

  it('DOCUMENT_SECTION_QUANT_PLAN=0 时回退为不注入清单', async () => {
    const previous = process.env.DOCUMENT_SECTION_QUANT_PLAN;
    process.env.DOCUMENT_SECTION_QUANT_PLAN = '0';
    try {
      const card = await buildSectionFactCard('工程概况', [evidenceItem()], embedDocuments);
      expect(card.preciseTokens).toEqual([]);
      expect(card.prompt).not.toContain('【量化参数落位清单】');
      expect(card.prompt).toContain('【当前小节写作任务卡】');
    } finally {
      if (previous === undefined) delete process.env.DOCUMENT_SECTION_QUANT_PLAN;
      else process.env.DOCUMENT_SECTION_QUANT_PLAN = previous;
    }
  });
});
