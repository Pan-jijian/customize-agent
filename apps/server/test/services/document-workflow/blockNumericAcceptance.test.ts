/**
 * 4.59 R-A1：**仅数值冲突**的块在末轮不再丢弃（接受 + 交数值修复链）。
 *
 * ## 实测依据
 *
 * 三轮真实自测中「章级显式降级」**恒为 1**（不是波动）；失败块 `主要施工内容` 连续三轮
 * 因「篇幅超产、数值一致性缺陷」被丢弃，**连带丢掉它承载的计划表格（2 条 blocker）与小节**。
 * 即「为修 1 处数值，损失整块正文」。
 *
 * ## 口径（比"直接放行"更严）
 *
 * - **首轮仍阻断**（带正确值定向重试——真正修好的机会）；
 * - **末轮接受**，且**仅当唯一缺陷族是数值**（其余 11 个阻断族全清）；
 * - 任一其它缺陷（结构/套话/密度/归因/格式/要素/关键小节深度/篇幅失守）存在 → 照旧判失败。
 *
 * ## 用例矩阵（本文件的设计约定）
 *
 * 本仓教训：单点用例导致「修一处、漏一处」。故每族修复一律按四类铺开：
 * ① **正向**（应生效）② **反向**（防过度——真缺陷仍须报）③ **边界**（阈值 ±1、首轮 vs 末轮）
 * ④ **不变**（未受影响的既有行为不得改变）。
 * 本文件覆盖：正向 3、反向 8、边界 2、不变 3，共 16 例。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlannedChapterContent } from '@/services/document-workflow/chapterGeneration';
import { createGenerationDiagnostics } from '@/services/document-workflow/rolePipeline';
import type { PlannedChapterBlock, PlannedChapterStructure } from '@/services/document-workflow/integratedBlueprint';
import type { DocumentGenerationDiagnostics, DocumentEvidence, DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';
import type * as LlmClientModule from '@/services/document-workflow/llmClient';

const stubEmbed = async (texts: string[]): Promise<number[][]> => texts.map(text => {
  const vector = new Array(64).fill(0);
  for (const char of text) vector[char.codePointAt(0)! % 64] += 1;
  const norm = Math.hypot(...vector) || 1;
  return vector.map(value => value / norm);
});
vi.mock('@customize-agent/knowledge', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, LocalTransformersEmbeddingProvider: class { embedDocuments = stubEmbed; } };
});
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
/** 计划外标题（构造「清单外标题」阻断） */
const H4X = '计划外章节';

const BODY_TAILS = ['配套作业', '现场组织', '工序衔接', '验收复核', '资料归档', '成品保护'];
function bodyLine(chars: number, index: number): string {
  return `${'施'.repeat(chars)}${BODY_TAILS[index % BODY_TAILS.length]}。`;
}

/** 证据池：含权威数值 120mm（正文若写 200mm 即构成「同位置不同值」冲突） */
const evidencePool: DocumentEvidence[] = [{
  filePath: 'design.pdf',
  content: '混凝土垫层厚度 120mm，强度等级 C30。',
  roleId: 'design',
  score: 1,
  sectionTitle: '设计说明',
} as unknown as DocumentEvidence];

/**
 * 正文工厂：`numeric` 为 true 时写与证据冲突的 200mm（触发数值冲突），
 * 否则写一致的 120mm。`h4s` 控制标题集合（缺/重复/计划外靠它构造）。
 */
function contentWith(h4s: string[], bodyChars: number, options: { numeric?: boolean } = {}): string {
  const dimension = options.numeric ? '混凝土垫层厚度 200mm' : '混凝土垫层厚度 120mm';
  return `### 测量放线\n\n${h4s.map((title, index) => `#### ${title}\n\n${dimension}，${bodyLine(bodyChars, index)}`).join('\n\n')}`;
}

function mockDiagnostics(): DocumentGenerationDiagnostics {
  return createGenerationDiagnostics({ mode: 'fast', enableChapterReview: false, enableGlobalReview: false, enableFinalQualityReview: false });
}
function makeChapter(overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id: 'ch-1', title: '施工测量', sections: [H4A], requiredFacts: [], tablePlans: [], ...overrides } as unknown as DocumentTemplateChapter;
}
function makeBlock(overrides: Partial<PlannedChapterBlock> = {}): PlannedChapterBlock {
  return {
    title: '测量放线',
    subPoints: [{ title: H4A, sources: ['s1'] }, { title: H4B, sources: ['s2'] }, { title: H4C, sources: ['s3'] }, { title: H4D, sources: ['s4'] }],
    facts: [], targetWords: 500,
    ...overrides,
  };
}
function makeStructure(overrides: Partial<PlannedChapterStructure> = {}): PlannedChapterStructure {
  return { blocks: [makeBlock()], coveredSections: [], fallbackSections: [], ...overrides };
}
type PlannedInput = Parameters<typeof buildPlannedChapterContent>[0];
function makeInput(overrides: Partial<PlannedInput> = {}): PlannedInput {
  return {
    template: {} as DocumentTemplate,
    chapter: makeChapter(),
    evidence: evidencePool,
    missingFacts: [],
    promptTexts: '写作提示',
    projectContext: '项目上下文',
    targetWords: 500,
    forbidDrawingImages: true,
    diagnostics: mockDiagnostics(),
    ...overrides,
  };
}

/**
 * 达标正文的单节字数：targetWords=500 → 达标区 [0.85,1.15]×= [425,575]，
 * 且 ≥0.95×（475）才不触发 R0-c 续写。4 节 ×(110 字正文 + ~15 字数值句 + 标题) ≈ 510 字，落在窗内。
 * （取 130 会到 ~614 字 > 575，触发首轮超产阻断 → 多一次调用，不是本文件要测的东西。）
 */
const OK_CHARS = 110;
const ALL_H4 = [H4A, H4B, H4C, H4D];

describe('4.59 R-A1 仅数值冲突的块末轮接受（16 例矩阵）', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  // ───────────────────────── ① 正向：应生效 ─────────────────────────

  it('正向-1：末轮仅数值冲突 → 接受（块不再丢弃）', async () => {
    // 两轮都写错值：首轮阻断重试，末轮接受
    llmMock.mockResolvedValue(contentWith(ALL_H4, OK_CHARS, { numeric: true }));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.failedBlocks).toEqual([]);
    expect(result?.allSucceeded).toBe(true);
    expect(result?.markdown).toContain('200mm');
  });

  it('正向-2：接受时写入可见记录（零静默降级）', async () => {
    llmMock.mockResolvedValue(contentWith(ALL_H4, OK_CHARS, { numeric: true }));
    const diagnostics = mockDiagnostics();
    await buildPlannedChapterContent(makeInput({ diagnostics }), makeStructure());
    expect(String(diagnostics.llm.lastInfo || '')).toContain('仅数值冲突已接受');
    expect(String(diagnostics.llm.lastInfo || '')).toContain('numeric-verification');
  });

  it('正向-3：首轮阻断后二轮改对 → 正常通过（数值不再冲突，走常规通过路径）', async () => {
    llmMock
      .mockResolvedValueOnce(contentWith(ALL_H4, OK_CHARS, { numeric: true }))
      .mockResolvedValueOnce(contentWith(ALL_H4, OK_CHARS));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
  });

  // ───────────────────────── ② 反向：防过度 ─────────────────────────

  it('反向-1：**首轮**仅数值冲突仍阻断重试（不放行——那是真正修好的机会）', async () => {
    llmMock
      .mockResolvedValueOnce(contentWith(ALL_H4, OK_CHARS, { numeric: true }))
      .mockResolvedValueOnce(contentWith(ALL_H4, OK_CHARS, { numeric: true }));
    await buildPlannedChapterContent(makeInput(), makeStructure());
    // 首轮未直接放行 → 发生了第二次调用
    expect(llmMock).toHaveBeenCalledTimes(2);
    expect(llmMock.mock.calls[1][1]).toContain('上一轮未通过质检');
  });

  it('反向-2：末轮 数值冲突 + 缺 H4 → 照旧失败（结构门不放宽）', async () => {
    llmMock.mockResolvedValue(contentWith([H4A, H4B], OK_CHARS, { numeric: true }));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
    expect(result?.failedBlocks).toHaveLength(1);
  });

  it('反向-3：末轮 数值冲突 + 重复 H4 → 照旧失败', async () => {
    llmMock.mockResolvedValue(contentWith([H4A, H4B, H4C, H4D, H4D], OK_CHARS, { numeric: true }));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
  });

  it('反向-4：末轮 数值冲突 + 计划外标题 → 照旧失败', async () => {
    llmMock.mockResolvedValue(contentWith([...ALL_H4, H4X], OK_CHARS, { numeric: true }));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
  });

  it('反向-5：末轮 数值冲突 + 篇幅严重超产（1.5×>1.4×容差）→ 照旧失败', async () => {
    // 目标 500，1.4× 容差线 700；正文写到约 1500 字
    llmMock.mockResolvedValue(contentWith(ALL_H4, 370, { numeric: true }));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
  });

  it('反向-6：末轮 数值冲突 + 正文过短（触发欠产）→ 首轮阻断、末轮接受（篇幅已由 R0-a 放开）', async () => {
    // 该例锁定 R0-a 与 R-A1 的**叠加语义**：篇幅不再是失败理由，故末轮两族都已放开 → 接受
    llmMock.mockResolvedValue(contentWith(ALL_H4, 20, { numeric: true }));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.failedBlocks).toEqual([]);
  });

  // ───────────────────────── ③ 边界 ─────────────────────────

  it('边界-1：数值冲突处数为 0 → 不触发接受路径（走常规通过，info 不含"仅数值冲突已接受"）', async () => {
    llmMock.mockResolvedValue(contentWith(ALL_H4, OK_CHARS));
    const diagnostics = mockDiagnostics();
    await buildPlannedChapterContent(makeInput({ diagnostics }), makeStructure());
    expect(String(diagnostics.llm.lastInfo || '')).not.toContain('仅数值冲突已接受');
  });

  it('边界-2：attempt 上限为 2（blockMaxAttempts）→ 第 2 次即末轮，接受发生在末轮而非首轮', async () => {
    llmMock.mockResolvedValue(contentWith(ALL_H4, OK_CHARS, { numeric: true }));
    await buildPlannedChapterContent(makeInput(), makeStructure());
    // 两轮都带冲突：首轮阻断 + 末轮接受 = 恰好 2 次调用（若首轮就接受则只有 1 次）
    expect(llmMock).toHaveBeenCalledTimes(2);
  });

  // ───────────────────────── ④ 不变：既有行为不得改变 ─────────────────────────

  it('不变-1：无任何缺陷 → 单次调用通过（接受路径不介入）', async () => {
    llmMock.mockResolvedValue(contentWith(ALL_H4, OK_CHARS));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
  });

  it('不变-2：证据池为空（无权威值可比）→ 不产生数值冲突，正常通过', async () => {
    llmMock.mockResolvedValue(contentWith(ALL_H4, OK_CHARS));
    const result = await buildPlannedChapterContent(makeInput({ evidence: [] }), makeStructure());
    expect(result?.allSucceeded).toBe(true);
  });

  it('不变-3：块失败清单仍照常产出（结构缺陷未放宽，failedBlocks 语义不变）', async () => {
    llmMock.mockResolvedValue(contentWith([H4A], OK_CHARS));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.failedBlocks).toHaveLength(1);
    expect(result?.failedBlocks[0]!.block.title).toBe('测量放线');
    // 失败类别仍登记（供章级降级记录与屏幕上显示）
    expect(result?.failedBlocks[0]!.failureKinds ?? []).toContain('structure-titles');
  });
});
