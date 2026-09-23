/**
 * 4.59 R-B5 接线① 块级短语级套话（首轮阻断）+ 接线② 条款体复述（块任务卡约束）——**链路级**用例矩阵。
 *
 * 为什么必须在块写作链路上测（而不是只测扫描函数）：本批治理的对象正是"检测已就位、零调用点"——
 * `tenderBidChecks §10` 的三个扫描器此前只有单测引用，从未进入块质检/任务卡/章收口。故本文件用
 * 既有 `plannedBlockRetry` 同款 mock 通道跑真实 `buildPlannedChapterContent`，断言：
 * ① 套话命中真的在**首轮**阻断并携带"只改短语、保留实质信息"的定向反馈；
 * ② 块任务卡真的下发了 B3（题注机械生成）与 B5 ②（条款体）约束，且命中的条款材料会把约束升级为计数点名。
 *
 * 用例文本逐字取自 4.59 交付物实测缺陷（本仓硬标准：不用抽象样例）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlockQualityModule from '@/services/document-workflow/blockQualityExecutors';
import type * as LlmClientModule from '@/services/document-workflow/llmClient';

const mockState = vi.hoisted(() => ({ realScan: undefined as undefined | ((text: string) => unknown), scan: vi.fn() }));
vi.mock('@/services/document-workflow/blockQualityExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof BlockQualityModule>();
  mockState.realScan = actual.scanBlockFillerPhrases;
  mockState.scan.mockImplementation(actual.scanBlockFillerPhrases);
  return { ...actual, scanBlockFillerPhrases: mockState.scan };
});

/**
 * 本地语义模型（块级句级质检扫描器依赖）——单测环境不可用，按本仓既有约定注入确定性嵌入。
 * 这里替换的是**模型**（生产环境存在），不是把质检异常吞掉。
 */
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
import { buildPlannedChapterContent } from '@/services/document-workflow/chapterGeneration';
import { createGenerationDiagnostics } from '@/services/document-workflow/rolePipeline';
import type { PlannedChapterBlock, PlannedChapterStructure } from '@/services/document-workflow/integratedBlueprint';
import type { DocumentEvidence, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';

const llmMock = vi.mocked(callDocumentLlm);

const H4A = '控制点布设';
const H4B = '轴线引测';
const H4C = '高程传递';
const H4D = '沉降观测';

/** 正文行工厂（V2 批1 块质检兼容契约：句号结句 + 尾部唯一短语，避免复读/重复行清理干扰） */
const BODY_TAILS = ['配套作业', '现场组织', '工序衔接', '验收复核', '资料归档', '成品保护'];
function bodyLine(chars: number, index: number): string {
  return `${'施'.repeat(chars)}${BODY_TAILS[index % BODY_TAILS.length]}。`;
}

/** 达标正文（≈1.0× 块目标 500 字，H4 齐全无重复 → 不触发续写/压缩通道） */
function passingContent(bodyChars = 120): string {
  return `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(bodyChars, index)}`).join('\n\n')}`;
}

/** 达标正文字数内嵌入实测套话句（缺陷形态：句子有实质信息、只短语是套话） */
function contentWithFiller(fillers: string[], bodyChars: number): string {
  return `### 测量放线\n\n#### ${H4A}\n\n${bodyLine(bodyChars, 0)}\n\n${fillers.join('\n')}\n\n${[H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(bodyChars, index + 1)}`).join('\n\n')}`;
}

/** 缺 3 个 H4 的短正文（结构缺陷 + 套话并存，用于断言两条反馈通道互不顶掉） */
function shortContentWithFiller(fillers: string[]): string {
  return `### 测量放线\n\n#### ${H4A}\n\n${bodyLine(150, 0)}\n\n${fillers.join('\n')}`;
}

// 实测缺陷原文（4.59 交付物）
const FILLER_SENTENCE = '塘渣石垫层、水泥稳定碎（砾）石各分项施工质量验收统一以“精心组织施工”为总控目标，检验批验收逐级对照核验。';
const FILLER_SENTENCE_2 = '本工程质量标准为精心组织施工。';
const MEASURED_CLAUSE = '我方在任何时候都应采取各种合理的预防措施，防止其员工发生任何违法、违禁、暴力或妨碍治安的行为，并在施工过程中严格遵守国家和地方有关规定。';

function mockDiagnostics(): DocumentGenerationDiagnostics {
  return createGenerationDiagnostics({ mode: 'fast', enableChapterReview: false, enableGlobalReview: false, enableFinalQualityReview: false });
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
  return { blocks: [makeBlock()], coveredSections: [], fallbackSections: [], ...overrides };
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
    ...overrides,
  };
}

function evidenceItem(overrides: Partial<DocumentEvidence> = {}): DocumentEvidence {
  return { chapterId: 'ch-1', filePath: '/data/招标文件条款.txt', score: 0.9, content: MEASURED_CLAUSE, ...overrides };
}

describe('R-B5 ① 块级短语级套话：首轮阻断 + 定向反馈（只改短语、保留实质信息）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockState.scan.mockImplementation(mockState.realScan as (text: string) => never);
  });

  it('正向：首轮命中 1 处（阈值上侧）→ 阻断重写，反馈点名短语与所在句，并要求只改短语保留实质信息', async () => {
    llmMock
      .mockResolvedValueOnce(contentWithFiller([FILLER_SENTENCE], 112))
      .mockResolvedValueOnce(passingContent());
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    const retryPrompt = String(llmMock.mock.calls[1][1]);
    expect(retryPrompt).toContain('【上一轮套话短语】');
    expect(retryPrompt).toContain('“精心组织施工”');
    expect(retryPrompt).toContain('只改写这些短语');
    expect(retryPrompt).toContain('句中其余实质信息（部位、工序、参数）必须原样保留');
    // 首轮调用（无反馈）不得携带重试话术
    expect(String(llmMock.mock.calls[0][1])).not.toContain('【上一轮套话短语】');
  });

  it('正向：首轮命中 2 处 → 反馈同时点名两条命中短语（子句短语 + 整句式短语）', async () => {
    llmMock
      .mockResolvedValueOnce(contentWithFiller([FILLER_SENTENCE, FILLER_SENTENCE_2], 105))
      .mockResolvedValueOnce(passingContent());
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    const retryPrompt = String(llmMock.mock.calls[1][1]);
    expect(retryPrompt).toContain('“精心组织施工”');
    expect(retryPrompt).toContain('“本工程质量标准为精心组织施工”');
  });

  it('反向（防误伤）：实质句（含厚度/吨位/压实度）0 命中 → 首轮直通，不为新门多花一轮', async () => {
    const substantive = `${bodyLine(110, 0)}\n\n塘渣石垫层厚度为 300mm，采用 20t 振动压路机碾压不少于 4 遍，压实度不低于 96%。`;
    llmMock.mockResolvedValue(`### 测量放线\n\n#### ${H4A}\n\n${substantive}\n\n${[H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(120, index + 1)}`).join('\n\n')}`);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(String(llmMock.mock.calls[0][1])).not.toContain('上一轮未通过质检');
  });

  it('反向（防误伤规范行文）：带修饰词的「按最高标准执行」→ 不阻断（首轮直通）', async () => {
    const withModifier = `${bodyLine(110, 0)}\n\n标准之间要求不一致时按最高标准执行，由项目技术负责人组织复核后确定。`;
    llmMock.mockResolvedValue(`### 测量放线\n\n#### ${H4A}\n\n${withModifier}\n\n${[H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(120, index + 1)}`).join('\n\n')}`);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
  });

  it('边界（载体行）：表格行/列表行里的同一短语不入句池 → 首轮直通', async () => {
    const carrierContent = `### 测量放线\n\n#### ${H4A}\n\n${bodyLine(105, 0)}\n\n| 序号 | 控制目标 | 核验方式 |\n| --- | --- | --- |\n| 1 | 精心组织施工 | 逐级对照核验 |\n\n${[H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(120, index + 1)}`).join('\n\n')}`;
    llmMock.mockResolvedValue(carrierContent);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
  });

  it('边界（异常 ≠ 通过）：扫描器连续两次抛错 → 首轮按未通过处理，诊断与日志留痕（零静默降级）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockState.scan.mockImplementation(() => { throw new Error('扫描器内部错误'); });
    const diagnostics = mockDiagnostics();
    llmMock
      .mockResolvedValueOnce(passingContent())
      .mockResolvedValueOnce(passingContent());
    const result = await buildPlannedChapterContent(makeInput({ diagnostics }), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    // 末态诊断必须如实反映"扫描失败"而非"命中 1 处"（否则降级记录本身成了假信息）
    expect(String(diagnostics.llm.lastError)).toContain('短语级套话扫描失败按未通过处理');
    expect(String(diagnostics.llm.lastError)).toContain('扫描器内部错误');
    expect(errorSpy.mock.calls.some(call => String(call[0]).includes('短语级套话扫描第 2 次失败'))).toBe(true);
    errorSpy.mockRestore();
  });

  it('不变（末轮口径）：两轮都命中套话时，第二轮照旧放行（短语级阻断仅首轮生效，不在末轮丢内容）', async () => {
    const dirty = contentWithFiller([FILLER_SENTENCE, FILLER_SENTENCE_2], 105);
    llmMock.mockResolvedValue(dirty);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    expect(result?.markdown).toContain('塘渣石垫层');
    expect(String(llmMock.mock.calls[1][1])).toContain('【上一轮套话短语】');
  });

  it('不变（多通道并存）：结构缺陷与套话同时命中时，两条反馈都在同一重试提示里（互不顶掉）', async () => {
    llmMock
      .mockResolvedValueOnce(shortContentWithFiller([FILLER_SENTENCE]))
      .mockResolvedValueOnce(passingContent());
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    const retryPrompt = String(llmMock.mock.calls[1][1]);
    expect(retryPrompt).toContain('缺失 H4 要点标题');
    expect(retryPrompt).toContain(H4B);
    expect(retryPrompt).toContain('【上一轮套话短语】');
  });

  it('不变（不改写内容）：通过块返回的正文与模型输出一致，质检只判定不重写', async () => {
    llmMock.mockResolvedValue(passingContent());
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(result?.markdown).toContain(`#### ${H4D}`);
    expect(result?.markdown).toContain(BODY_TAILS[3]);
  });
});

describe('R-B5 ①② 写作期任务卡接线（块任务卡 = 真实下达通道）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockState.scan.mockImplementation(mockState.realScan as (text: string) => never);
  });

  it('正向：块任务卡下发题注机械生成约束（不写「表X-Y」编号前缀 + 引用用表名）', async () => {
    llmMock.mockResolvedValue(passingContent());
    await buildPlannedChapterContent(makeInput(), makeStructure());
    const firstPrompt = String(llmMock.mock.calls[0][1]);
    expect(firstPrompt).toContain('【表格题注】');
    expect(firstPrompt).toContain('不要写「表X-Y」编号前缀');
    expect(firstPrompt).toContain('题注编号由系统在成稿后按章内表序机械生成');
  });

  it('正向：块任务卡下发条款体复述的基线约束（写作红线，且不给可抄示例句）', async () => {
    llmMock.mockResolvedValue(passingContent());
    await buildPlannedChapterContent(makeInput(), makeStructure());
    const firstPrompt = String(llmMock.mock.calls[0][1]);
    expect(firstPrompt).toContain('【写作红线】不得整句复述规范/合同/招标文件的条款原文');
    expect(firstPrompt).toContain('改写为本项目的具体做法');
    // 无命中材料时不升级（不带计数点名）
    expect(firstPrompt).not.toContain('本节材料中含');
  });

  it('正向（约束升级）：块材料含实测条款句 → 约束升级为带计数的点名约束，且不回引条款原句', async () => {
    llmMock.mockResolvedValue(passingContent());
    await buildPlannedChapterContent(makeInput({ evidence: [evidenceItem()] }), makeStructure());
    const firstPrompt = String(llmMock.mock.calls[0][1]);
    expect(firstPrompt).toContain('本节材料中含 1 处条款体/承诺式原文');
    expect(firstPrompt).toContain('不得整句照抄');
    // 计数只报数量：约束段不得回引条款原句（原句被复读正是本族要治的形态）
    // ——材料本体仍按证据注入通道进入提示词（那是唯一的资料来源），此处只约束**约束文本**本身
    const constraintSegment = firstPrompt.split('【写作红线】')[1]?.split('绑定材料：')[0] || '';
    expect(constraintSegment).not.toContain('我方在任何时候都应采取各种合理的预防措施');
    expect(constraintSegment).toContain('本节材料中含 1 处条款体/承诺式原文');
  });

  it('反向（不误伤）：材料是常规项目事实（无条款句）→ 只下发基线约束，不无差别升级', async () => {
    llmMock.mockResolvedValue(passingContent());
    await buildPlannedChapterContent(makeInput({ evidence: [evidenceItem({ content: '塘渣石垫层厚度 300mm，压实度不低于 96%。' })] }), makeStructure());
    const firstPrompt = String(llmMock.mock.calls[0][1]);
    expect(firstPrompt).toContain('【写作红线】');
    expect(firstPrompt).not.toContain('本节材料中含');
  });

  it('边界：空证据（无块材料）→ 基线约束仍在，不因空材料丢掉写作约束', async () => {
    llmMock.mockResolvedValue(passingContent());
    await buildPlannedChapterContent(makeInput({ evidence: [] }), makeStructure());
    const firstPrompt = String(llmMock.mock.calls[0][1]);
    expect(firstPrompt).toContain('【写作红线】');
    expect(firstPrompt).toContain('【表格题注】');
    expect(firstPrompt).not.toContain('本节材料中含 0 处');
  });

  it('不变：重试轮的提示词同时携带任务卡约束与上一轮缺陷反馈（约束不因重试丢失）', async () => {
    llmMock
      .mockResolvedValueOnce(contentWithFiller([FILLER_SENTENCE], 112))
      .mockResolvedValueOnce(passingContent());
    await buildPlannedChapterContent(makeInput(), makeStructure());
    const retryPrompt = String(llmMock.mock.calls[1][1]);
    expect(retryPrompt).toContain('【表格题注】');
    expect(retryPrompt).toContain('【写作红线】');
    expect(retryPrompt).toContain('【上一轮套话短语】');
  });
});
