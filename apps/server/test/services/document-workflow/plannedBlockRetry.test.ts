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
import type { PlannedChapterBlock, PlannedChapterStructure } from '@/services/document-workflow/integratedBlueprint';
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

function makeChapter(overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id: 'ch-1', title: '施工测量', sections: [H4A], requiredFacts: [], tablePlans: [], ...overrides } as unknown as DocumentTemplateChapter;
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
    // A22 缺口数字反馈：重试轮带「当前 N 字…还缺 K 字」与 0.9×目标达标线数字
    expect(retryPrompt).toContain('距目标 500 字还缺');
    expect(retryPrompt).toContain('必须逐点展开到不少于 450 字');
  });

  it('两轮不达标 → 返回失败块隔离清单（成功块保留，不整章降级重写）', async () => {
    const failingBlock: PlannedChapterBlock = { title: '沉降观测专项', subPoints: [{ title: '观测点布设', sources: ['s5'] }], facts: [], targetWords: 500 };
    llmMock.mockImplementation(async (_system: string, prompt: string) => {
      // 用 coverageList 格式特征（#### 观测点布设）区分块：禁词清单（forbiddenTitlesLine）会把其他块
      // 标题作为裸词注入每个块的 prompt，按块标题字符串判断会误匹配（4.19 串章防线引入后）
      if (prompt.includes('#### 观测点布设')) return shortContent;
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

  it('重复 H4 但字数达标 → 确定性去重兜底成稿（首轮即兜底，结构性重复不整块作废）', async () => {
    const duplicated = `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map(title => `#### ${title}\n\n${'施'.repeat(130)}`).join('\n\n')}\n\n#### ${H4A}\n\n${'施'.repeat(130)}`;
    llmMock.mockResolvedValue(duplicated);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    // 首轮 duplicates 不达标 → 确定性去重兜底（删第二次 H4A）后字数达标 → 成稿（不再耗二轮）
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    const dedupedCount = (result?.markdown.match(/控制点布设/gu) || []).length;
    expect(dedupedCount).toBe(1);
  });
  
  it('清单外 H4 但字数达标 → 确定性修复（删标题留正文）成稿（第五次回归：4083 字块因清单外标题失败）', async () => {
    // 字数充足、要点齐全，但多了 1 个清单外 H4（模型自由发挥/标题微调）
    const extraneousContent = `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map(title => `#### ${title}\n\n${'施'.repeat(130)}`).join('\n\n')}\n\n#### 沉降观测智能化\n\n${'施'.repeat(130)}`;
    llmMock.mockResolvedValue(extraneousContent);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    // 清单外 H4 标题被删，其余保留
    expect(result?.markdown).not.toContain('沉降观测智能化');
    expect(result?.markdown).toContain(H4D);
  });
  
  it('清单外 H4 删标题留正文 → 正文零丢失，字数不减首轮通过（第七次回归：1084 字块不浪费）', async () => {
    // 单要点块写错形态：4 个要点各 120 字 + 1 个清单外 H4 200 字，总字数充足
    const content = `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map(title => `#### ${title}\n\n${'施'.repeat(120)}`).join('\n\n')}\n\n#### 自由发挥一\n\n${'施'.repeat(200)}`;
    llmMock.mockResolvedValue(content);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(result?.markdown).not.toContain('#### 自由发挥一');
    // 自由发挥正文保留（确定性修复不浪费内容）
    const chars = (result?.markdown.match(/施/gu) || []).length;
    expect(chars).toBeGreaterThanOrEqual(4 * 120 + 200);
  });
  
  it('清单外 H4 删标题留正文后字数仍不足 → 二轮反馈重试（真实缺口才重试）', async () => {
    // 要点正文薄（各 25 字）+ 两个自由发挥各 100 字：删标题后总字数仍 <0.9×500=450 → 二轮
    const thinContent = `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map(title => `#### ${title}\n\n${'施'.repeat(25)}`).join('\n\n')}\n\n#### 自由发挥一\n\n${'施'.repeat(100)}\n\n#### 自由发挥二\n\n${'施'.repeat(100)}`;
    llmMock
      .mockResolvedValueOnce(thinContent)
      .mockResolvedValueOnce(passingContent([H4A, H4B, H4C, H4D], 150));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    // 二轮反馈点名清单外标题
    expect(llmMock.mock.calls[1][1]).toContain('自由发挥一');
  });

  it('单要点块写评分细目原标题 H4 → sources 白名单豁免，首轮通过（第七次回归：项目理解与编制边界块）', async () => {
    // 要点标题=块标题（H3 直接承担），模型按证据写出细目原标题「编制说明与工程概况」→
    // sources 白名单豁免 extraneous 判定，1084 字达标直接成稿（修复前：误杀 → 整块作废 → 章失败）
    const singlePointBlock: PlannedChapterBlock = { title: '项目理解与编制边界', subPoints: [{ title: '项目理解与编制边界', sources: ['编制说明与工程概况'] }], facts: [], targetWords: 1200 };
    const content = `### 项目理解与编制边界\n\n#### 编制说明与工程概况\n\n${'施'.repeat(1084)}`;
    llmMock.mockResolvedValue(content);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure({ blocks: [singlePointBlock] }));
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(result?.markdown).toContain('编制说明与工程概况');
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

  it('4.19.5 回归：分部章容器块走总述提示词（不锁骨架不写三段式），正文直接展开成稿', async () => {
    // 容器块（「主要分部分项工程施工方案」在「主要施工方法」章内）是全章总述小节：
    // 修复前按三段式 divisionPrompt 展开 → LLM 把本章全部分部名写成 H4（清单外）+三段标签重复 → 章阻断
    const containerBlock: PlannedChapterBlock = { title: '主要分部分项工程施工方案', subPoints: [{ title: '主要分部分项工程施工方案', sources: ['主要分部分项工程施工方案'] }], facts: [], targetWords: 3600 };
    llmMock.mockResolvedValue(`### 主要分部分项工程施工方案\n\n${'施'.repeat(3300)}`);
    const result = await buildPlannedChapterContent(makeInput({ chapter: makeChapter({ title: '主要施工方法' }) }), makeStructure({ blocks: [containerBlock] }));
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    const prompt = llmMock.mock.calls[0][1];
    // 总述提示词下发（四部分组织），不注入单分部三段式提示
    expect(prompt).toContain('分部分项工程施工方案总述');
    expect(prompt).toContain('四、质量、安全与进度接口');
    expect(prompt).not.toContain('【分部分项施工方案三段式】');
  });

  it('4.19.5 回归：分部章容器块输出清单外 H4 → 标题剥离正文保留，字数达标成稿', async () => {
    // 总述块模型仍写出分部名 H4（历史习惯）时：块质检确定性修复删标题行保留正文，字数达标即通过
    const containerBlock: PlannedChapterBlock = { title: '主要分部分项工程施工方案', subPoints: [{ title: '主要分部分项工程施工方案', sources: ['主要分部分项工程施工方案'] }], facts: [], targetWords: 3600 };
    const strayH4s = `### 主要分部分项工程施工方案\n\n#### 道路工程\n\n${'施'.repeat(500)}\n\n#### 排水工程\n\n${'施'.repeat(500)}\n\n${'施'.repeat(2400)}`;
    llmMock.mockResolvedValue(strayH4s);
    const result = await buildPlannedChapterContent(makeInput({ chapter: makeChapter({ title: '主要施工方法' }) }), makeStructure({ blocks: [containerBlock] }));
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    // 清单外 H4 标题行删除，正文全部保留
    expect(result?.markdown).not.toContain('#### 道路工程');
    expect(result?.markdown).not.toContain('#### 排水工程');
    expect((result?.markdown.match(/施/gu) || []).length).toBeGreaterThanOrEqual(3400);
  });
});
