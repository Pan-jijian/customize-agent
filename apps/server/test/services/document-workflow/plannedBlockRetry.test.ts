/**
 * buildPlannedChapterContent（达标契约）单测：
 * 块质检阈值 0.9×块目标（minWords 不打折）→ 达标重试 ≤2 次（二轮带缺失/重复 H4 针对性反馈）→
 * 二轮仍重复 H4 时确定性去重兜底 → 两轮不达标返回失败块隔离清单（不整章降级）→
 * 要点 ≥4 的块拆半自愈（子块同标准成稿，不降级逐小节）。
 * LLM 通道 mock（callDocumentLlm 按 prompt 特征返回受控内容）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlannedChapterContent } from '@/services/document-workflow/chapterGeneration';
import { createGenerationDiagnostics } from '@/services/document-workflow/rolePipeline';
import type { PlannedChapterBlock, PlannedChapterStructure } from '@/services/document-workflow/chapterPlanner';
import type { DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';
import type * as LlmClientModule from '@/services/document-workflow/llmClient';

vi.mock('@/services/document-workflow/llmClient', async () => {
  const actual = await vi.importActual<typeof LlmClientModule>('@/services/document-workflow/llmClient');
  return { ...actual, callDocumentLlm: vi.fn(), callDocumentLlmJson: vi.fn() };
});

import { callDocumentLlm } from '@/services/document-workflow/llmClient';

const llmMock = vi.mocked(callDocumentLlm);

const H4A = '控制点布设';
const H4B = '轴线引测';
const H4C = '高程传递';
const H4D = '沉降观测';

/** 达标正文（≥0.9×targetWords 且 H4 齐全无重复） */
function passingContent(h4s: string[], bodyChars: number): string {
  return `### 测量放线\n\n${h4s.map(title => `#### ${title}\n\n${'施'.repeat(bodyChars)}`).join('\n\n')}`;
}

/** 字数不足的不达标正文（≥120 字符避免走 undefined 分支，但 <0.9×targetWords） */
const shortContent = `### 测量放线\n\n#### ${H4A}\n\n${'施'.repeat(150)}`;

function mockDiagnostics(): DocumentGenerationDiagnostics {
  return createGenerationDiagnostics({ mode: 'fast', enableChapterReview: false, enableGlobalReview: false, enableDocumentBudgetExpansion: false, enableFinalQualityReview: false });
}

function makeChapter(): DocumentTemplateChapter {
  return { id: 'ch-1', title: '施工测量', sections: [H4A], requiredFacts: [], tablePlans: [] } as unknown as DocumentTemplateChapter;
}

function makeBlock(overrides: Partial<PlannedChapterBlock> = {}): PlannedChapterBlock {
  return {
    title: '测量放线',
    subPoints: [
      { title: H4A, sources: ['s1'] },
      { title: H4B, sources: ['s2'] },
      { title: H4C, sources: ['s3'] },
      { title: H4D, sources: ['s4'] },
    ],
    facts: [],
    targetWords: 500,
    ...overrides,
  };
}

function makeStructure(overrides: Partial<PlannedChapterStructure> = {}): PlannedChapterStructure {
  return { blocks: [makeBlock()], coveredSections: [], fallbackSections: [], llmPlanned: false, ...overrides };
}

type PlannedInput = Parameters<typeof buildPlannedChapterContent>[0];

function makeInput(overrides: Partial<PlannedInput> = {}): PlannedInput {
  return {
    template: {} as DocumentTemplate,
    chapter: makeChapter(),
    evidence: [],
    missingFacts: [],
    promptTexts: '写作提示',
    projectContext: '项目上下文',
    targetWords: 500,
    forbidDrawingImages: true,
    diagnostics: mockDiagnostics(),
    ...overrides,
  };
}

describe('buildPlannedChapterContent（达标契约：0.9 阈值 + 重试 ≤2 次）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('首轮达标（≥0.9×目标且 H4 齐全）→ 直接成稿，LLM 只调一次', async () => {
    llmMock.mockResolvedValue(passingContent([H4A, H4B, H4C, H4D], 150));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(result?.failedBlocks).toEqual([]);
    expect(llmMock).toHaveBeenCalledTimes(1);
  });

  it('首轮不达标 → 二轮带缺失 H4 反馈重试达标（重试不降标，LLM 两次）', async () => {
    llmMock
      .mockResolvedValueOnce(shortContent)
      .mockResolvedValueOnce(passingContent([H4A, H4B, H4C, H4D], 150));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    // 二轮反馈针对首轮质检缺口：缺失 H4 标题点名 + 字数要求
    const retryPrompt = llmMock.mock.calls[1][1];
    expect(retryPrompt).toContain('上一轮未通过质检');
    expect(retryPrompt).toContain(H4B);
    expect(retryPrompt).toContain('总字数不少于目标字数');
  });

  it('两轮不达标 → 返回失败块隔离清单（成功块保留，不整章降级重写）', async () => {
    const failingBlock: PlannedChapterBlock = { title: '沉降观测专项', subPoints: [{ title: '观测点布设', sources: ['s5'] }], facts: [], targetWords: 500 };
    llmMock.mockImplementation(async (_system: string, prompt: string) => {
      if (prompt.includes('沉降观测专项')) return shortContent;
      return passingContent([H4A, H4B, H4C, H4D], 150);
    });
    const diag = mockDiagnostics();
    const result = await buildPlannedChapterContent(makeInput({ diagnostics: diag }), makeStructure({ blocks: [makeBlock(), failingBlock] }));
    expect(result?.allSucceeded).toBe(false);
    expect(result?.failedBlocks).toHaveLength(1);
    expect(result?.failedBlocks[0].block.title).toBe('沉降观测专项');
    // 成功块成稿保留（块级隔离，不整章作废）
    expect(result?.sections[0]).toContain(H4D);
    expect(result?.markdown).toContain(H4A);
  });

  it('二轮仍重复 H4 但字数达标 → 确定性去重兜底成稿（结构性重复不整块作废）', async () => {
    const duplicated = `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map(title => `#### ${title}\n\n${'施'.repeat(130)}`).join('\n\n')}\n\n#### ${H4A}\n\n${'施'.repeat(130)}`;
    llmMock.mockResolvedValue(duplicated);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    // 首轮 duplicates 不达标 → 二轮仍重复 → 确定性去重后字数达标 → 成稿
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    const dedupedCount = (result?.markdown.match(/控制点布设/gu) || []).length;
    expect(dedupedCount).toBe(1);
  });

  it('要点 ≥4 两轮不达标 → 拆半自愈：两个子块同标准成稿拼接', async () => {
    llmMock.mockImplementation(async (_system: string, prompt: string) => {
      if (prompt.includes('（一）')) return `### 测量放线（一）\n\n#### ${H4A}\n\n${'施'.repeat(400)}\n\n#### ${H4B}\n\n${'施'.repeat(400)}`;
      if (prompt.includes('（二）')) return `### 测量放线（二）\n\n#### ${H4C}\n\n${'施'.repeat(400)}\n\n#### ${H4D}\n\n${'施'.repeat(400)}`;
      return shortContent;
    });
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    // 原块两轮 + 两个子块各一次 = 4 次
    expect(llmMock).toHaveBeenCalledTimes(4);
    expect(result?.markdown).toContain(H4A);
    expect(result?.markdown).toContain(H4D);
  });
});
