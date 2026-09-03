/**
 * fullDimensionReview S4/W5 单测：
 * 分块评审→问题清单→定向修复→复评全流程、风险分流（否决级/高风险进修复，中低风险只报告）、
 * 单块评审失败显式记录降级且其余块继续、分块预算边界。
 * LLM 通道全部 mock（避免真实 LLM 调用）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { qingtianReviewValidationIssues, runFullDimensionReview, splitChaptersIntoReviewBlocks } from '@/services/document-workflow/fullDimensionReview';
import { qingtianBlockReviewPrompt } from '@/services/document-workflow/qingtianReviewSpec';
import { buildExportGate } from '@/services/document-workflow/qualityValidation';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';

vi.mock('@/services/document-workflow/llmClient', () => ({ callDocumentLlmJson: vi.fn() }));
vi.mock('@/services/document-workflow/rolePipeline', () => ({ repairChapterByQuality: vi.fn() }));
vi.mock('@/services/document-workflow/documentGeneratorHelpers', () => ({ finalizeChapterContentQuality: vi.fn((content: string) => content) }));

import { callDocumentLlmJson } from '@/services/document-workflow/llmClient';
import { repairChapterByQuality } from '@/services/document-workflow/rolePipeline';

const llmMock = vi.mocked(callDocumentLlmJson);
const repairMock = vi.mocked(repairChapterByQuality);

function makeChapter(id: string, title: string, content: string): DocumentDraftChapter {
  return { id, title, content, evidence: [], missingFacts: [], sections: [] } as unknown as DocumentDraftChapter;
}

function mockDiagnostics(): DocumentGenerationDiagnostics {
  return { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, lastError: '' } } as unknown as DocumentGenerationDiagnostics;
}

describe('splitChaptersIntoReviewBlocks', () => {
  it('小章节合并为单块', () => {
    const chapters = [makeChapter('1', '工程概况', '正文内容'.repeat(20)), makeChapter('2', '施工部署', '正文内容'.repeat(20))];
    const blocks = splitChaptersIntoReviewBlocks(chapters, 1000, 7);
    expect(blocks.length).toBe(1);
    expect(blocks[0].length).toBe(2);
  });

  it('超过单块字数上限时切块', () => {
    const chapters = [makeChapter('1', '章一', '字'.repeat(600)), makeChapter('2', '章二', '字'.repeat(600)), makeChapter('3', '章三', '字'.repeat(600))];
    const blocks = splitChaptersIntoReviewBlocks(chapters, 800, 7);
    expect(blocks.length).toBe(3);
    expect(blocks.every(block => block.length === 1)).toBe(true);
  });

  it('块数上限约束下尾部章节合并，不丢章节', () => {
    const chapters = Array.from({ length: 10 }, (_, index) => makeChapter(String(index), `章${index}`, '字'.repeat(300)));
    const blocks = splitChaptersIntoReviewBlocks(chapters, 400, 3);
    expect(blocks.length).toBeLessThanOrEqual(3);
    const total = blocks.reduce((sum, block) => sum + block.length, 0);
    expect(total).toBe(10);
  });

  it('空章节列表 → 空块列表', () => {
    expect(splitChaptersIntoReviewBlocks([])).toEqual([]);
  });

  it('超长单章按小节边界切段：不再整章单块送审', () => {
    const sections = Array.from({ length: 12 }, (_, index) => `## 小节${index + 1}\n\n${'字'.repeat(400)}`).join('\n\n');
    const chapters = [makeChapter('1', '超长章', sections)];
    const blocks = splitChaptersIntoReviewBlocks(chapters, 500, 7);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.length).toBeLessThanOrEqual(7);
    // 全文内容无遗漏：'字' 部分总量不变
    const totalChars = blocks.reduce((sum, block) => sum + block.reduce((s, chapter) => s + (chapter.content.match(/字/gu) || []).length, 0), 0);
    expect(totalChars).toBe(12 * 400);
    // 每块字数受控（≤ 自适应上限，段落不可分割时允许小幅度超出）
    for (const block of blocks) {
      const length = block.reduce((sum, chapter) => sum + chapter.content.length, 0);
      expect(length).toBeLessThanOrEqual(1200);
    }
  });

  it('超长文档块数自适应：块数收敛到上限内', () => {
    const chapters = Array.from({ length: 12 }, (_, index) => makeChapter(String(index), `章${index}`, '字'.repeat(300)));
    const blocks = splitChaptersIntoReviewBlocks(chapters, 400, 3);
    expect(blocks.length).toBeLessThanOrEqual(3);
    const total = blocks.reduce((sum, block) => sum + block.length, 0);
    expect(total).toBe(12);
  });
});

describe('runFullDimensionReview', () => {
  beforeEach(() => {
    // resetAllMocks：同时清除 mockResolvedValueOnce 一次性队列，避免前序用例遗留 Once 污染后续用例
    vi.resetAllMocks();
  });

  it('评审未检出问题 → 零修复零复评', async () => {
    llmMock.mockResolvedValue({ issues: [], templatingLevel: '无' });
    const chapters = [makeChapter('1', '工程概况', '正文'.repeat(100))];
    const stages: string[] = [];
    const result = await runFullDimensionReview({
      template: {} as DocumentTemplate,
      chapters,
      effectiveChapters: [] as DocumentTemplateChapter[],
      onStage: stage => stages.push(stage.message),
    });
    expect(result.reviewed).toBe(true);
    expect(result.issuesFound).toBe(0);
    expect(result.repairCalls).toBe(0);
    expect(result.reReviewCalls).toBe(0);
    expect(repairMock).not.toHaveBeenCalled();
    expect(stages.some(message => message.includes('未检出问题'))).toBe(true);
  });

  it('高风险问题 → 定向修复 + 同块复评，章节内容被替换', async () => {
    llmMock
      .mockResolvedValueOnce({ issues: [{ dimension: '模板化', location: '工程概况', quote: '一般来说，本项目按照常规施工组织。', riskLevel: '高风险', basis: '模板化判定', description: '通用句式残留' }], templatingLevel: '重度' })
      .mockResolvedValueOnce({ issues: [], templatingLevel: '无' });
    repairMock.mockResolvedValue({ content: '修复后正文', appliedCount: 2, producedCount: 2, repairType: 'quality' as never });
    const chapters = [makeChapter('1', '工程概况', '一般来说，本项目按照常规施工组织。'.repeat(40))];
    const result = await runFullDimensionReview({
      template: {} as DocumentTemplate,
      chapters,
      effectiveChapters: [{ id: '1', title: '工程概况' }] as unknown as DocumentTemplateChapter[],
    });
    expect(result.issuesFound).toBe(1);
    expect(result.templatingLevels).toEqual(['重度']);
    expect(result.repairCalls).toBe(1);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(result.reReviewCalls).toBe(1);
    expect(result.fixedCount).toBe(2);
    expect(result.repairedChapters).toEqual(['工程概况']);
    expect(chapters[0].content).toBe('修复后正文');
    expect(result.remainingIssues).toEqual([]);
  });

  it('中低风险问题只报告不修复', async () => {
    llmMock.mockResolvedValue({ issues: [{ dimension: '内容质量', location: '工程概况', quote: '措施比较全面完善到位。', riskLevel: '中风险', basis: '内容质量维度', description: '措施未量化' }], templatingLevel: '轻度' });
    const chapters = [makeChapter('1', '工程概况', '措施比较全面完善到位。'.repeat(30))];
    const result = await runFullDimensionReview({
      template: {} as DocumentTemplate,
      chapters,
      effectiveChapters: [] as DocumentTemplateChapter[],
    });
    expect(result.issuesFound).toBe(1);
    expect(result.repairCalls).toBe(0);
    expect(repairMock).not.toHaveBeenCalled();
    expect(result.remainingIssues.length).toBe(1);
  });

  it('单块评审失败 → 显式记录降级且其余块继续', async () => {
    const diagnostics = mockDiagnostics();
    const chapters = [makeChapter('1', '章一', '字'.repeat(5000)), makeChapter('2', '章二', '字'.repeat(5000))];
    llmMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ issues: [], templatingLevel: '无' });
    const result = await runFullDimensionReview({
      template: {} as DocumentTemplate,
      chapters,
      effectiveChapters: [] as DocumentTemplateChapter[],
      diagnostics,
    });
    expect(result.reviewed).toBe(true);
    expect(result.reviewCalls).toBe(2);
    expect(result.issuesFound).toBe(0);
    expect(diagnostics.llm.lastError).toContain('qingtian-review');
  });

  it('复评仍检出高风险 → 计入剩余清单', async () => {
    const issue = { dimension: '数据逻辑', location: '章一', quote: '总工期 300 天与节点工期 200 天矛盾。', riskLevel: '高风险', basis: '数据逻辑维度', description: '工期口径矛盾' };
    llmMock
      .mockResolvedValueOnce({ issues: [issue], templatingLevel: '无' })
      .mockResolvedValueOnce({ issues: [issue], templatingLevel: '无' });
    repairMock.mockResolvedValue({ content: '章节新内容（未真正修复工期矛盾）', appliedCount: 1, producedCount: 1, repairType: 'quality' as never });
    const chapters = [makeChapter('1', '章一', '总工期 300 天与节点工期 200 天矛盾。'.repeat(20)), makeChapter('2', '章二', '字'.repeat(3000))];
    const result = await runFullDimensionReview({
      template: {} as DocumentTemplate,
      chapters,
      effectiveChapters: [] as DocumentTemplateChapter[],
    });
    expect(result.reReviewCalls).toBe(1);
    expect(result.remainingIssues.length).toBe(1);
    expect(result.remainingIssues[0].riskLevel).toBe('高风险');
  });

  it('patchGuard 默认 observe：修复调用携带 observeOnly=true 与 diagnostics', async () => {
    const diagnostics = mockDiagnostics();
    llmMock
      .mockResolvedValueOnce({ issues: [{ dimension: '模板化', location: '工程概况', quote: '一般来说，本项目按照常规施工组织。', riskLevel: '高风险', basis: '模板化判定', description: '通用句式残留' }], templatingLevel: '无' })
      .mockResolvedValueOnce({ issues: [], templatingLevel: '无' });
    repairMock.mockResolvedValue({ content: '修复后正文', appliedCount: 1, producedCount: 1, repairType: 'quality' as never });
    const chapters = [makeChapter('1', '工程概况', '一般来说，本项目按照常规施工组织。'.repeat(40))];
    await runFullDimensionReview({ template: {} as DocumentTemplate, chapters, effectiveChapters: [{ id: '1', title: '工程概况' }] as unknown as DocumentTemplateChapter[], diagnostics });
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(repairMock.mock.calls[0][0].patchGuard).toEqual({ observeOnly: true, diagnostics });
  });

  it('DOCUMENT_QINGTIAN_PATCH_GUARD=enforce → observeOnly=false', async () => {
    process.env.DOCUMENT_QINGTIAN_PATCH_GUARD = 'enforce';
    try {
      llmMock
        .mockResolvedValueOnce({ issues: [{ dimension: '模板化', location: '工程概况', quote: '一般来说，本项目按照常规施工组织。', riskLevel: '高风险', basis: '模板化判定', description: '通用句式残留' }], templatingLevel: '无' })
        .mockResolvedValueOnce({ issues: [], templatingLevel: '无' });
      repairMock.mockResolvedValue({ content: '修复后正文', appliedCount: 1, producedCount: 1, repairType: 'quality' as never });
      const chapters = [makeChapter('1', '工程概况', '一般来说，本项目按照常规施工组织。'.repeat(40))];
      await runFullDimensionReview({ template: {} as DocumentTemplate, chapters, effectiveChapters: [{ id: '1', title: '工程概况' }] as unknown as DocumentTemplateChapter[] });
      expect(repairMock.mock.calls[0][0].patchGuard?.observeOnly).toBe(false);
    } finally {
      delete process.env.DOCUMENT_QINGTIAN_PATCH_GUARD;
    }
  });

  it('DOCUMENT_QINGTIAN_PATCH_GUARD=0 → 不传 patchGuard（完全关闭）', async () => {
    process.env.DOCUMENT_QINGTIAN_PATCH_GUARD = '0';
    try {
      llmMock
        .mockResolvedValueOnce({ issues: [{ dimension: '模板化', location: '工程概况', quote: '一般来说，本项目按照常规施工组织。', riskLevel: '高风险', basis: '模板化判定', description: '通用句式残留' }], templatingLevel: '无' })
        .mockResolvedValueOnce({ issues: [], templatingLevel: '无' });
      repairMock.mockResolvedValue({ content: '修复后正文', appliedCount: 1, producedCount: 1, repairType: 'quality' as never });
      const chapters = [makeChapter('1', '工程概况', '一般来说，本项目按照常规施工组织。'.repeat(40))];
      await runFullDimensionReview({ template: {} as DocumentTemplate, chapters, effectiveChapters: [{ id: '1', title: '工程概况' }] as unknown as DocumentTemplateChapter[] });
      expect(repairMock.mock.calls[0][0].patchGuard).toBeUndefined();
    } finally {
      delete process.env.DOCUMENT_QINGTIAN_PATCH_GUARD;
    }
  });

  it('2.2 去重 observe（默认）：命中已修签名照常修复并计数 qingtianDedupeHits', async () => {
    const diagnostics = mockDiagnostics();
    const quote = '本工程按工作包组织施工。';
    llmMock
      .mockResolvedValueOnce({ issues: [{ dimension: '内容质量', location: '工程概况', quote, riskLevel: '高风险', basis: '内容质量维度', description: '后台内部术语' }], templatingLevel: '无' })
      .mockResolvedValueOnce({ issues: [], templatingLevel: '无' });
    repairMock.mockResolvedValue({ content: '修复后正文', appliedCount: 1, producedCount: 1, repairType: 'quality' as never });
    const chapters = [makeChapter('1', '工程概况', '一般来说，本项目按照常规施工组织。'.repeat(40))];
    await runFullDimensionReview({
      template: {} as DocumentTemplate,
      chapters,
      effectiveChapters: [{ id: '1', title: '工程概况' }] as unknown as DocumentTemplateChapter[],
      // 签名 = code + 归一化原文（句读空白剥离）
      resolvedBlockerSignatures: new Set([`internal-term\u0000本工程按工作包组织施工`]),
      diagnostics,
    });
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(diagnostics.llm.qingtianDedupeHits).toBe(1);
    expect(diagnostics.llm.qingtianDedupeSkipped).toBeUndefined();
  });

  it('2.2 去重 enforce：命中已修签名的高风险 issue 跳过 LLM 修复并降级进剩余清单', async () => {
    process.env.DOCUMENT_CROSS_SYSTEM_DEDUPE = 'enforce';
    try {
      const diagnostics = mockDiagnostics();
      const quote = '本工程按工作包组织施工。';
      llmMock.mockResolvedValueOnce({ issues: [{ dimension: '内容质量', location: '工程概况', quote, riskLevel: '高风险', basis: '内容质量维度', description: '后台内部术语' }], templatingLevel: '无' });
      const chapters = [makeChapter('1', '工程概况', '一般来说，本项目按照常规施工组织。'.repeat(40))];
      const result = await runFullDimensionReview({
        template: {} as DocumentTemplate,
        chapters,
        effectiveChapters: [{ id: '1', title: '工程概况' }] as unknown as DocumentTemplateChapter[],
        resolvedBlockerSignatures: new Set([`internal-term\u0000本工程按工作包组织施工`]),
        diagnostics,
      });
      expect(repairMock).not.toHaveBeenCalled();
      expect(diagnostics.llm.qingtianDedupeSkipped).toBe(1);
      expect(diagnostics.llm.qingtianDedupeHits).toBeUndefined();
      expect(result.remainingIssues.some(issue => issue.quote === quote)).toBe(true);
    } finally {
      delete process.env.DOCUMENT_CROSS_SYSTEM_DEDUPE;
    }
  });

  it('2.2 去重：原文片段未命中签名时正常修复且不计数', async () => {
    const diagnostics = mockDiagnostics();
    llmMock
      .mockResolvedValueOnce({ issues: [{ dimension: '模板化', location: '工程概况', quote: '一般来说，本项目按照常规施工组织。', riskLevel: '高风险', basis: '模板化判定', description: '通用句式残留' }], templatingLevel: '无' })
      .mockResolvedValueOnce({ issues: [], templatingLevel: '无' });
    repairMock.mockResolvedValue({ content: '修复后正文', appliedCount: 1, producedCount: 1, repairType: 'quality' as never });
    const chapters = [makeChapter('1', '工程概况', '一般来说，本项目按照常规施工组织。'.repeat(40))];
    await runFullDimensionReview({
      template: {} as DocumentTemplate,
      chapters,
      effectiveChapters: [{ id: '1', title: '工程概况' }] as unknown as DocumentTemplateChapter[],
      resolvedBlockerSignatures: new Set(['internal-term\u0000本工程按工作包组织施工']),
      diagnostics,
    });
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(diagnostics.llm.qingtianDedupeHits).toBeUndefined();
    expect(diagnostics.llm.qingtianDedupeSkipped).toBeUndefined();
  });
});

describe('qingtianReviewValidationIssues（W8 门禁接驳）', () => {
  it('否决级/高风险 → error + blocker + category qingtian_review', () => {
    const issues = qingtianReviewValidationIssues([
      { dimension: '数据逻辑', location: '章一', quote: '工期矛盾原文片段', riskLevel: '否决级', basis: '数据逻辑维度', description: '工期口径矛盾' },
      { dimension: '模板化', location: '章二', quote: '通用句式原文片段', riskLevel: '高风险', basis: '模板化判定', description: '通用句式残留' },
    ]);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.level).toBe('error');
      expect(issue.severity).toBe('blocker');
      expect(issue.category).toBe('qingtian_review');
    }
    expect(issues[0].message).toContain('否决级');
    expect(issues[0].message).toContain('数据逻辑');
    expect(issues[0].suggestion).toBe('数据逻辑维度');
  });

  it('中低风险 → warning 仅展示不阻断', () => {
    const issues = qingtianReviewValidationIssues([
      { dimension: '内容质量', location: '章一', quote: '措施原文片段', riskLevel: '中风险', basis: '内容质量维度', description: '措施未量化' },
      { dimension: '内容质量', location: '章二', quote: '其他原文片段', riskLevel: '低风险', basis: '内容质量维度', description: '表述可优化' },
    ]);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.level).toBe('warning');
      expect(issue.severity).toBe('warning');
      expect(issue.category).toBe('qingtian_review');
    }
  });
});

describe('buildExportGate（W8 category 判定）', () => {
  const factsModel = { project: [{ id: '1', key: 'projectName', value: '某办公楼' }], schedule: [], quality: [], safety: [], preciseFacts: [] } as unknown as DocumentFactsModel;
  const bodyChapter = () => makeChapter('1', '工程概况', '本项目为某办公楼改造工程，总建筑面积约 5000 平方米，工期 45 日历天。'.repeat(12));

  it('有正文时 qingtian_review 否决级问题硬阻断', () => {
    const gate = buildExportGate(qingtianReviewValidationIssues([
      { dimension: '数据逻辑', location: '工程概况', quote: '工期矛盾原文', riskLevel: '否决级', basis: '依据', description: '工期口径矛盾' },
    ]), factsModel, [bodyChapter()]);
    expect(gate.passed).toBe(false);
    expect(gate.blockingIssues.length).toBeGreaterThan(0);
    expect(gate.blockingIssues[0].category).toBe('qingtian_review');
  });

  it('有正文时 structure 类仍硬阻断（原消息白名单行为由 category 保持）', () => {
    const gate = buildExportGate([{ level: 'error', severity: 'blocker', repairability: 'llm_repairable', category: 'structure', owner: 'system', message: '工程概况 正文不足：当前 100 字，要求不少于 300 字', suggestion: '补足' }], factsModel, [bodyChapter()]);
    expect(gate.passed).toBe(false);
    expect(gate.blockingIssues.some(issue => issue.category === 'structure')).toBe(true);
  });

  it('有正文时 style 禁止话术类仍硬阻断（商务条款回归防护）', () => {
    const gate = buildExportGate([{ level: 'error', severity: 'blocker', repairability: 'llm_repairable', category: 'style', owner: 'llm', message: '正文出现商务条款数据：暂列金额', suggestion: '' }], factsModel, [bodyChapter()]);
    expect(gate.passed).toBe(false);
  });

  it('无正文时全部 error 阻断（hasBody=false 路径不变）', () => {
    const gate = buildExportGate([{ level: 'error', severity: 'blocker', repairability: 'llm_repairable', category: 'structure', owner: 'system', message: '工程概况 正文不足：当前 100 字，要求不少于 300 字', suggestion: '补足' }], factsModel, [makeChapter('1', '工程概况', '标题')]);
    expect(gate.passed).toBe(false);
  });
});

describe('qingtianBlockReviewPrompt（round-21 S6 招标对标材料注入）', () => {
  const base = { projectName: '合肥师范学院实训基地项目', blockIndex: 1, blockTotal: 3, chapterTitles: ['工程概况'], blockContent: '正文内容' };

  it('有 tenderContext 时提示词包含【招标对标材料】区段及材料内容', () => {
    const prompt = qingtianBlockReviewPrompt({ ...base, tenderContext: '工程规模：单体建筑面积28570.36平方米\n质量目标：黄山杯' });
    expect(prompt).toContain('【招标对标材料（核对基准，不得偏离）】');
    expect(prompt).toContain('28570.36');
    expect(prompt).toContain('黄山杯');
  });

  it('无 tenderContext 但有 requirement 时回退「招标文件要求摘要」', () => {
    const prompt = qingtianBlockReviewPrompt({ ...base, requirement: '评分点：工期保证措施' });
    expect(prompt).not.toContain('【招标对标材料');
    expect(prompt).toContain('招标文件要求摘要：评分点：工期保证措施');
  });

  it('两者皆无时不产生对标材料区段', () => {
    const prompt = qingtianBlockReviewPrompt(base);
    expect(prompt).not.toContain('【招标对标材料');
    expect(prompt).not.toContain('招标文件要求摘要');
  });
});
