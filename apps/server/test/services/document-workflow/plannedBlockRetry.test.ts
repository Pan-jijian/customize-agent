/**
 * buildPlannedChapterContent（块写作合同）单测：
 * 字数双向硬合同（4.40/4.51；**4.56 R0-a 对称化**）：达标区 [0.85,1.15] 直通；欠产侧门线 = 反馈下限
 * 0.85×（原 0.7× 且末轮不设门 → 欠产被系统性放行，写作完成率长期 79%、债转修复链补成 +66%）；
 * 欠产块的出路是 **R0-b 续写**（保留已写内容 + 增量补足，≤2 轮、须严格增长、达门线才交回）；
 * 超产侧前轮 >1.15 一律阻断（携压缩指令），4.51 末轮容差线 1.2× 内微超产
 * 接受（r28 实机：末轮 1.19× / 仅超合同线 1 字仍判块失败 → 单块章整章阻断、文档缺章，损失远大于
 * 微超产本身）；末轮仍 >1.2× → 块失败（严重超产零降级）——旧 4.35
 * 「接受区 [0.7,1.4] 放行 / 二轮一律放行」是超产进入成稿的最后失守环节（舒城 14 万目标产出 22 万字）。
 * 结构硬门保留零降级（缺失/重复 H4、清单外标题）→ 标题层缺陷确定性修复通道（修复后仍超产不得
 * 放行）→ 两轮不达标返回失败块隔离清单（不整章降级）。
 * LLM 通道 mock（callDocumentLlm 按 prompt 特征返回受控内容）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildPlannedChapterContent } from '@/services/document-workflow/chapterGeneration';
import { createGenerationDiagnostics } from '@/services/document-workflow/rolePipeline';
import type { PlannedChapterBlock, PlannedChapterStructure } from '@/services/document-workflow/integratedBlueprint';
import type { DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';
import type * as LlmClientModule from '@/services/document-workflow/llmClient';

/**
 * 本地语义模型（块级质检扫描器依赖）——单测环境不可用，按本仓既有约定注入确定性嵌入。
 *
 * 注意：本 mock **不是**在「让失败的质检通过」。块级模板化/归因量化扫描器若抛错，
 * chapterGeneration 现已按「质检未完成 ⇒ 不放行」处理（原实现是静默放行），
 * 故测试环境缺模型会让所有块被正确判为未通过。这里替换的是**模型**（生产环境存在），
 * 使质检真正跑起来——而不是把异常重新吞掉。
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

const llmMock = vi.mocked(callDocumentLlm);

const H4A = '控制点布设';
const H4B = '轴线引测';
const H4C = '高程传递';
const H4D = '沉降观测';

/**
 * 正文行工厂（V2 批1 块质检兼容契约）：句号结句（避免「句尾截断」阻断判定）+ 尾部唯一短语
 * （避免「完全重复行 ≥40 字」确定性清理把同度数各节正文误删为空小节——同长度重复内容是
 * 测试夹具产物，真实生成各节正文不同）。'施' 字数与旧用例断言口径保持一致。
 */
const BODY_TAILS = ['配套作业', '现场组织', '工序衔接', '验收复核', '资料归档', '成品保护'];
function bodyLine(chars: number, index: number): string {
  return `${'施'.repeat(chars)}${BODY_TAILS[index % BODY_TAILS.length]}。`;
}

/** 达标正文（≥0.9×targetWords 且 H4 齐全无重复） */
function passingContent(h4s: string[], bodyChars: number): string {
  return `### 测量放线\n\n${h4s.map((title, index) => `#### ${title}\n\n${bodyLine(bodyChars, index)}`).join('\n\n')}`;
}

/** 字数严重不足且缺 3 个 H4 的短正文（≥120 字符避免走 undefined 分支，<0.7×targetWords 属越界区） */
const shortContent = `### 测量放线\n\n#### ${H4A}\n\n${bodyLine(150, 0)}`;

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
    diagnostics: mockDiagnostics(),
    ...overrides,
  };
}

describe('buildPlannedChapterContent（块字数分层验收 + 结构硬门 + 重试 ≤2 次）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('首轮达标（合同区间 [0.85,1.15] 且 H4 齐全）→ 直接成稿，LLM 只调一次', async () => {
    llmMock.mockResolvedValue(passingContent([H4A, H4B, H4C, H4D], 120));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(result?.failedBlocks).toEqual([]);
    expect(llmMock).toHaveBeenCalledTimes(1);
  });

  it('首轮不达标 → 二轮带缺失 H4 反馈重试达标（重试不降标，LLM 两次）', async () => {
    llmMock
      .mockResolvedValueOnce(shortContent)
      .mockResolvedValueOnce(passingContent([H4A, H4B, H4C, H4D], 120));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    // 二轮反馈针对首轮质检缺口：缺失 H4 标题点名 + 字数要求
    const retryPrompt = llmMock.mock.calls[1][1];
    expect(retryPrompt).toContain('上一轮未通过质检');
    expect(retryPrompt).toContain(H4B);
    // A22 缺口数字反馈（块合同区间化）：重试轮带「距篇幅下限 425 字还缺 K 字」与补足指令
    expect(retryPrompt).toContain('距篇幅下限 425 字还缺');
    expect(retryPrompt).toContain('必须逐点展开补足');
  });

  it('4.56 R0-a：0.84× 不再直通（门线=反馈下限 0.85），续写无增长 → 块失败（不降标）', async () => {
    // 420 字 vs 块目标 500（0.84×）：**旧口径**落在接受区 [350,425) 直通放行——而该区间的
    // 下发反馈下限一直是 0.85×（"要求写 0.85、只验收 0.7"）。R0-a 把门线与反馈对齐后：
    // 两轮均欠产 → R0-b 续写（第 3 次调用）→ 模型未增长 → 续写不收敛 → 块失败（维持原"块失败"语义）。
    llmMock.mockResolvedValue(passingContent([H4A, H4B, H4C, H4D], 60));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
    // 2 次写作尝试 + ≥1 次续写尝试（续写无增长即停，轮次有界）
    expect(llmMock.mock.calls.length).toBeGreaterThan(2);
  });

  it('4.56 R0-b：欠产块续写补足后成稿（保留已写内容 + 增量，不整块重写）', async () => {
    // 首两轮各 0.32×（160 字）→ 门线未达；第 3 次调用（续写）返回增量 → 合并后达标 → 块成功。
    // 这是欠产的**正当出路**：不判死丢弃、也不放行给修复链（后者会把"欠"补成"过"）。
    const short = `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(25, index)}`).join('\n\n')}`;
    llmMock.mockResolvedValueOnce(short).mockResolvedValueOnce(short)
      .mockResolvedValueOnce([H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(90, index)}`).join('\n\n'));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(3);
    // 续写口令：只输出续写、不得重复已写正文
    expect(String(llmMock.mock.calls[2][1])).toContain('只输出续写部分');
    expect(result?.markdown).toContain(H4D);
  });

  it('4.56 R0-a：两轮严重欠产（0.32×）且续写无增长 → 块失败（欠产不再放行）', async () => {
    // 160 字 vs 500（0.32×）三轮不变：**旧口径**二轮放行（"欠产侧不构成块失败"）——这正是
    // 写作完成率长期停在 79% 的来源。R0-a 对称化后欠产与超产同权：不达标即块失败，
    // 由上层块失守处置（4.55.30 显式降级：保留成功块 + 点名失守块）承接。
    llmMock.mockResolvedValue(`### 测量放线\n\n${[H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(25, index)}`).join('\n\n')}`);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
    expect(result?.failedBlocks.length).toBeGreaterThan(0);
  });

  it('首轮严重超产（>1.15×）→ 二轮携压缩反馈重写；二轮仍超产 → 块失败（零降级）', async () => {
    // 860 字 vs 500（1.72×）两轮不变：超产侧任何轮次阻断——二轮仍超产 → 块失败 → 返回失败块隔离清单
    //（单块章全失败同样返回清单，由上层 C3 隔离重写或章阻断；历史缺陷：全失败早退返回 undefined
    // 使 C3 被跳过，4.44 实机工期章 2 块全失败实证）
    llmMock.mockResolvedValue(passingContent([H4A, H4B, H4C, H4D], 200));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
    expect(result?.failedBlocks).toHaveLength(1);
    expect(result?.sections[0]).toBeUndefined();
    expect(llmMock).toHaveBeenCalledTimes(2);
    expect(llmMock.mock.calls[1][1]).toContain('【上一轮篇幅超限】');
  });

  it('首轮超产（>1.15×）→ 二轮携压缩反馈压缩达标 → 成稿（压缩是确定性收敛方向）', async () => {
    // 860 字 vs 500（1.72×）：首轮超产阻断并携带压缩指令；二轮压缩到 540 字（1.08×）进达标区成稿
    llmMock
      .mockResolvedValueOnce(passingContent([H4A, H4B, H4C, H4D], 200))
      .mockResolvedValueOnce(passingContent([H4A, H4B, H4C, H4D], 120));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    expect(llmMock.mock.calls[1][1]).toContain('【上一轮篇幅超限】');
  });

  it('4.51 末轮容差：首轮超产 → 二轮微超合同线（1.15~1.2×）→ 容差放行成稿（r28 实证：末轮微超不判块失败）', async () => {
    // 块目标 500：合同超产线 575 / 末轮容差线 600。首轮 861 字（1.72×）阻断；二轮 581 字
    //（1.16× 微超合同线）——r28 实机形态（2141 字=1.19×、1496 字仅超 1 字）由末轮容差吸收
    llmMock
      .mockResolvedValueOnce(passingContent([H4A, H4B, H4C, H4D], 200))
      .mockResolvedValueOnce(passingContent([H4A, H4B, H4C, H4D], 130));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(result?.failedBlocks).toEqual([]);
    expect(llmMock).toHaveBeenCalledTimes(2);
    // 首轮仍走压缩阻断路径（容差不提前到首轮）
    expect(llmMock.mock.calls[1][1]).toContain('【上一轮篇幅超限】');
  });

  it('4.51 容差不提前：首轮即微超合同线（1.15~1.2×）→ 仍压缩阻断重写，二轮容差放行', async () => {
    // 581 字（1.16×）两轮不变：首轮不因末轮容差而放行（仍携压缩指令重写）；二轮同一产出落在
    // 容差线内 → 接受成稿（不判块失败、不进隔离重写）
    llmMock.mockResolvedValue(passingContent([H4A, H4B, H4C, H4D], 130));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    expect(llmMock.mock.calls[1][1]).toContain('【上一轮篇幅超限】');
  });

  it('4.51 容差不越界：末轮仍越容差线（>1.2×）→ 块失败（严重超产零降级不变）', async () => {
    // 605 字（1.21×）两轮不变：> 容差线 600 → 块失败、隔离清单返回；容差只吸收微超产，
    // 不改变「严重超产零降级」的硬合同
    llmMock.mockResolvedValue(passingContent([H4A, H4B, H4C, H4D], 136));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
    expect(result?.failedBlocks).toHaveLength(1);
    expect(result?.sections[0]).toBeUndefined();
    expect(llmMock).toHaveBeenCalledTimes(2);
  });

  it('4.55.22 关键小节绝对深度门槛：首轮 0.94×块目标（比例线内）仍阻断，二轮携深度反馈放行', async () => {
    // 关键小节块（危大工程专项施工方案审批流程，blockerMinChars.emergency=650）目标 500：绝对门槛
    // = min(650, max(500, 500)) = 500，与比例线并行取严（欠产线 350 → 500）。首轮 470 字（0.94×，
    // 旧口径 ∈[0.85,1.15] 达标区直通）现被首轮阻断并携深度缺口反馈定向重写；
    // 二轮同一产出放行（末轮不设欠产/深度门，交终检 critical-section-depth + content-depth-repair 兜底）
    const criticalBlock = makeBlock({ title: '危大工程专项施工方案审批流程', targetWords: 500 });
    llmMock.mockResolvedValue(`### 危大工程专项施工方案审批流程\n\n${[H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(100, index)}`).join('\n\n')}`);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure({ blocks: [criticalBlock] }));
    // 首轮阻断 → 二轮携深度反馈重写；二轮通过后（470/500 = 0.94 < 0.95）再触发 R0-c 续写
    expect(llmMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const retryPrompt = llmMock.mock.calls[1][1];
    expect(retryPrompt).toContain('【上一轮关键小节深度不足】');
    expect(retryPrompt).toContain('绝对深度门槛 500 字');
    // 末轮放行（不新增终局失败面）：块成稿、章不阻断
    expect(result?.allSucceeded).toBe(true);
    expect(result?.markdown).toContain(H4A);
  });

  it('4.55.22 工作包要素门禁：首轮三要素不全（篇幅达标）→ 阻断携缺陷原文，二轮放行', async () => {
    // 块标题命中「项目主要施工内容」且 H4 要点 ≥3 → 门禁适用；首轮 524 字（1.05×块目标：篇幅在
    // [0.85,1.15] 达标区、关键小节深度门槛 500 亦达标）但工作包三要素不全 → 唯一阻断项是要素门禁；
    // 二轮同一产出放行（末轮放行，交终检 construction-org-major-content + content-depth-repair 兜底）
    const majorBlock = makeBlock({ title: '项目主要施工内容', targetWords: 500 });
    llmMock.mockResolvedValue(`### 项目主要施工内容\n\n${[H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(115, index)}`).join('\n\n')}`);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure({ blocks: [majorBlock] }));
    expect(llmMock).toHaveBeenCalledTimes(2);
    const retryPrompt = llmMock.mock.calls[1][1];
    expect(retryPrompt).toContain('【上一轮工作包结构/要素未达门禁】');
    expect(retryPrompt).toContain('项目主要施工内容 未按施工工作包展开');
    // 篇幅/深度均达标 → 不混报篇幅反馈（阻断项只有要素门禁）
    expect(retryPrompt).not.toContain('【上一轮关键小节深度不足】');
    expect(result?.allSucceeded).toBe(true);
    expect(result?.markdown).toContain(H4A);
  });

  it('清单外 H4 修复后仍超产（>1.15×）→ 修复通道不放行，二轮重写达标成稿', async () => {
    // ≈974 字（1.95×）且含清单外 H4：标题层修复（删标题留正文）只减 9 字，修复后仍 >1.15×（575）
    // → 不得经修复通道放行（超产侧无豁免轮次）→ 二轮重写；二轮压缩到 540 字成稿
    const oversizeWithExtraneous = `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(200, index)}`).join('\n\n')}\n\n#### 自由发挥一\n\n${bodyLine(100, 4)}`;
    llmMock
      .mockResolvedValueOnce(oversizeWithExtraneous)
      .mockResolvedValueOnce(passingContent([H4A, H4B, H4C, H4D], 120));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    expect(llmMock.mock.calls[1][1]).toContain('【上一轮篇幅超限】');
  });

  it('两轮不达标 → 返回失败块隔离清单（成功块保留，不整章降级重写）', async () => {
    const failingBlock: PlannedChapterBlock = { title: '沉降观测专项', subPoints: [{ title: '观测点布设', sources: ['s5'] }], facts: [], targetWords: 500 };
    llmMock.mockImplementation(async (_system: string, prompt: string) => {
      // 用 coverageList 格式特征（#### 观测点布设）区分块：禁词清单（forbiddenTitlesLine）会把其他块
      // 标题作为裸词注入每个块的 prompt，按块标题字符串判断会误匹配（4.19 串章防线引入后）
      if (prompt.includes('#### 观测点布设')) return shortContent;
      return passingContent([H4A, H4B, H4C, H4D], 120);
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
    const duplicated = `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(110, index)}`).join('\n\n')}\n\n#### ${H4A}\n\n${bodyLine(110, 4)}`;
    llmMock.mockResolvedValue(duplicated);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    // 首轮 duplicates 不达标 → 确定性去重兜底（删第二次 H4A）后字数达标 → 成稿（不再耗二轮）
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    const dedupedCount = (result?.markdown.match(/控制点布设/gu) || []).length;
    expect(dedupedCount).toBe(1);
  });
  
  it('清单外 H4 但字数达标 → 确定性修复（删标题留正文）成稿（第五次回归：4083 字块因清单外标题失败）', async () => {
    // 字数充足（修复前 554 字、删标题留正文后 543 字，均落在合同区间 [425,575]）、要点齐全，
    // 但多了 1 个清单外 H4（模型自由发挥/标题微调）
    const extraneousContent = `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(95, index)}`).join('\n\n')}\n\n#### 沉降观测智能化\n\n${bodyLine(95, 4)}`;
    llmMock.mockResolvedValue(extraneousContent);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    // 清单外 H4 标题被删，其余保留
    expect(result?.markdown).not.toContain('沉降观测智能化');
    expect(result?.markdown).toContain(H4D);
  });
  
  it('清单外 H4 删标题留正文 → 正文零丢失，首轮修复通过（第七次回归：1084 字块不浪费）', async () => {
    // 单要点块写错形态：4 个要点各 120 字 + 1 个清单外 H4 200 字，总字数充足
    const content = `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(120, index)}`).join('\n\n')}\n\n#### 自由发挥一\n\n${bodyLine(200, 4)}`;
    llmMock.mockResolvedValue(content);
    // 块合同目标 700：修复后 744 字（4×120 正文 + 200 字自由发挥正文全保留）落在 [595,805] 区间
    const result = await buildPlannedChapterContent(makeInput({ targetWords: 700 }), makeStructure({ blocks: [{ ...makeBlock(), targetWords: 700 }] }));
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(result?.markdown).not.toContain('#### 自由发挥一');
    // 自由发挥正文保留（确定性修复不浪费内容）
    const chars = (result?.markdown.match(/施/gu) || []).length;
    expect(chars).toBeGreaterThanOrEqual(4 * 120 + 200);
  });
  
  it('清单外 H4 删标题留正文后字数仍低于接受区下限 → 二轮反馈重试（真实缺口才重试）', async () => {
    // 要点正文薄（各 15 字）+ 两个自由发挥各 80 字：删标题后总字数 290 仍 <0.7×500=350（越界区）
    // 且原始 308 字同属越界区 → 首轮阻断二轮；接受区以内的微缺口由「接受区直通」用例覆盖
    const thinContent = `### 测量放线\n\n${[H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(15, index)}`).join('\n\n')}\n\n#### 自由发挥一\n\n${bodyLine(80, 4)}\n\n#### 自由发挥二\n\n${bodyLine(80, 5)}`;
    llmMock
      .mockResolvedValueOnce(thinContent)
      .mockResolvedValueOnce(passingContent([H4A, H4B, H4C, H4D], 120));
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
    const content = `### 项目理解与编制边界\n\n#### 编制说明与工程概况\n\n${bodyLine(1084, 0)}`;
    llmMock.mockResolvedValue(content);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure({ blocks: [singlePointBlock] }));
    expect(result?.allSucceeded).toBe(true);
    // 4.56 R0-c：1084/1200 = 0.90 < 0.95×块目标 → 首轮通过后再做一次**续写**（非重试）；
    // 断言"无重试"的语义改为：第二次调用（若有）必须是续写，且返回内容仍含细目标题。
    expect(String(llmMock.mock.calls[0][1])).not.toContain('上一轮未通过质检');
    expect(llmMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    if (llmMock.mock.calls.length > 1) expect(String(llmMock.mock.calls[1][1])).toContain('只输出续写部分');
    expect(result?.markdown).toContain('编制说明与工程概况');
  });

  it('r7 回归：要点标题单字近义变体（季候→气候）→ 确定性对齐回规划标题，首轮直通（不再误杀缺失）', async () => {
    // r7 实机根因：规划层产出书面词「季候条件影响与工期应对」，写层模型 4 次改写为「气候条件影响与工期应对」
    // → 行级精确包含匹配判缺失 → 重试 + 隔离重写全部耗尽 → 整章阻断；写层质检前的近似对齐把标题
    // 回写为规划原文（内容零改动），缺失判定「完全一致」口径不放松 → 首轮直通
    const planH4 = '季候条件影响与工期应对';
    const variantH4 = '气候条件影响与工期应对';
    const block: PlannedChapterBlock = { title: '工期目标与关键线路控制', subPoints: [{ title: planH4, sources: ['s1'] }], facts: [], targetWords: 500 };
    llmMock.mockResolvedValue(`### 工期目标与关键线路控制\n\n#### ${variantH4}\n\n${bodyLine(440, 0)}`);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure({ blocks: [block] }));
    expect(result?.allSucceeded).toBe(true);
    // 4.56 R0-c：低于 0.95×块目标 → 通过后再续写一次（非重试；断言首轮无重试反馈）
    expect(String(llmMock.mock.calls[0][1])).not.toContain('上一轮未通过质检');
    expect(result?.markdown).toContain(`#### ${planH4}`);
    expect(result?.markdown).not.toContain(variantH4);
  });

  it('要点缺失两轮仍不齐 → 结构硬门阻断（返回失败块隔离清单，不再早退 undefined）', async () => {
    // 工具链对齐：字数维度已不构成块失败（见上方分层验收用例）；短正文缺 3 个 H4 要点 → 结构硬门
    // 两轮阻断 → 块失败清单返回（修复前：全失败早退 undefined → 上层 C3 被跳过直接章阻断）；
    // 不再有写作层事后拆半——半块重设预算使父块合同失效的历史机制已删除；
    // 多块章的部分/全部失败隔离（成功块保留）见前两个用例与 stageChapterLoop.retryFailedBlocks
    llmMock.mockResolvedValue(shortContent);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
    expect(result?.failedBlocks).toHaveLength(1);
    expect(result?.sections[0]).toBeUndefined();
    expect(llmMock).toHaveBeenCalledTimes(2);
  });

  it('C3 隔离重写反馈携带：失败块 retryFeedback 点名缺失要点（供上层单块重写定向反馈注入）', async () => {
    // 4.44 丰乐镇工期章实证：块两轮漏写要点后失败；无反馈的隔离重写从零生成易复现同一漏点——
    // 失败块清单携带缺陷反馈原文（缺失 H4 点名），由 stageChapterLoop.retryFailedBlocks 注入 initialFeedback
    llmMock.mockResolvedValue(shortContent);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
    expect(result?.failedBlocks[0]?.retryFeedback).toContain('缺失 H4 要点标题');
    expect(result?.failedBlocks[0]?.retryFeedback).toContain(H4B);
    // 隔离重写反馈不带字数反馈（全新调用无上一轮字数锚点）
    expect(result?.failedBlocks[0]?.retryFeedback).not.toContain('距篇幅下限');
  });

  it('initialFeedback 注入（隔离重写路径）：首轮 prompt 即携带上一轮缺陷反馈而非空反馈', async () => {
    llmMock.mockResolvedValue(passingContent([H4A, H4B, H4C, H4D], 120));
    const result = await buildPlannedChapterContent(
      makeInput({ initialFeedback: '【上一轮未通过质检】缺失 H4 要点标题：沉降观测。必须逐点补齐以上 H4 标题并展开正式正文，H4 标题与给定标题完全一致。' }),
      makeStructure(),
    );
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(llmMock.mock.calls[0][1]).toContain('缺失 H4 要点标题：沉降观测');
  });

  it('4.19.5 回归：分部章容器块走总述提示词（不锁骨架不写三段式），正文直接展开成稿', async () => {
    // 容器块（「主要分部分项工程施工方案」在「主要施工方法」章内）是全章总述小节：
    // 修复前按三段式 divisionPrompt 展开 → LLM 把本章全部分部名写成 H4（清单外）+三段标签重复 → 章阻断
    const containerBlock: PlannedChapterBlock = { title: '主要分部分项工程施工方案', subPoints: [{ title: '主要分部分项工程施工方案', sources: ['主要分部分项工程施工方案'] }], facts: [], targetWords: 3600 };
    llmMock.mockResolvedValue(`### 主要分部分项工程施工方案\n\n${bodyLine(3300, 0)}`);
    const result = await buildPlannedChapterContent(makeInput({ chapter: makeChapter({ title: '主要施工方法' }) }), makeStructure({ blocks: [containerBlock] }));
    expect(result?.allSucceeded).toBe(true);
    // 4.56 R0-c：3300/3600 = 0.92 < 0.95 → 通过后续写一次；首轮提示词断言不变
    expect(String(llmMock.mock.calls[0][1])).not.toContain('上一轮未通过质检');
    const prompt = llmMock.mock.calls[0][1];
    // 总述提示词下发（四部分组织），不注入单分部三段式提示
    expect(prompt).toContain('分部分项工程施工方案总述');
    expect(prompt).toContain('四、质量、安全与进度接口');
    expect(prompt).not.toContain('【分部分项施工方案三段式】');
  }, 120_000);

  it('4.19.5 回归：分部章容器块输出清单外 H4 → 标题剥离正文保留，字数达标成稿', async () => {
    // 总述块模型仍写出分部名 H4（历史习惯）时：块质检确定性修复删标题行保留正文，字数达标即通过
    const containerBlock: PlannedChapterBlock = { title: '主要分部分项工程施工方案', subPoints: [{ title: '主要分部分项工程施工方案', sources: ['主要分部分项工程施工方案'] }], facts: [], targetWords: 3600 };
    const strayH4s = `### 主要分部分项工程施工方案\n\n#### 道路工程\n\n${bodyLine(500, 0)}\n\n#### 排水工程\n\n${bodyLine(500, 1)}\n\n${bodyLine(2400, 2)}`;
    llmMock.mockResolvedValue(strayH4s);
    const result = await buildPlannedChapterContent(makeInput({ chapter: makeChapter({ title: '主要施工方法' }) }), makeStructure({ blocks: [containerBlock] }));
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    // 清单外 H4 标题行删除，正文全部保留
    expect(result?.markdown).not.toContain('#### 道路工程');
    expect(result?.markdown).not.toContain('#### 排水工程');
    expect((result?.markdown.match(/施/gu) || []).length).toBeGreaterThanOrEqual(3400);
  });

  it('4.44 写时表名混表头归一：#1 表名顶替首列名按表计划归位（表题独立成行），首轮成稿无重试', async () => {
    // 4.43 实测形态：Writer 把表名并入表头首格顶替首列名 → 写时确定性归一（表题独立成行 +
    // plan.fields[0] 归位）在结构扫描前消灭缺陷，块首轮直通（修复前：首轮阻断→末轮静默放行，
    // 带病进终检挂起）
    const chapter = makeChapter({
      tablePlans: [{
        id: 'planned-table-ch-1-1',
        title: '文明施工管控要点与检查频次表',
        chapterTitle: '施工测量',
        section: '',
        required: false,
        reason: '',
        fields: [{ name: '管 控分项' }, { name: '具体标准' }, { name: '责任岗位' }, { name: '检查频次' }, { name: '整改闭环要求' }],
      }],
    });
    const table = [
      '| 文明施工管控要点与检查频次表 | 检查内容 | 责任岗位 | 检查频次 | 整改闭环 |',
      '| --- | --- | --- | --- | --- |',
      '| 围挡与警示设施 | 围挡稳固、警示标识齐全 | 安全员 | 每日1次 | 当日整改，复查销项 |',
      '| 道路保洁与洒水 | 施工便道无积尘、无遗撒 | 施工员 | 每日2次 | 2小时内清理复验 |',
    ].join('\n');
    const content = `### 测量放线\n\n#### ${H4A}\n\n${bodyLine(80, 0)}\n\n${table}\n\n#### ${H4B}\n\n${bodyLine(80, 1)}\n\n#### ${H4C}\n\n${bodyLine(80, 2)}\n\n#### ${H4D}\n\n${bodyLine(80, 3)}`;
    llmMock.mockResolvedValue(content);
    const result = await buildPlannedChapterContent(makeInput({ chapter }), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(result?.markdown).toContain('文明施工管控要点与检查频次表\n\n| 管控分项 | 检查内容 | 责任岗位 | 检查频次 | 整改闭环 |');
    expect(result?.markdown).not.toContain('| 文明施工管控要点与检查频次表 |');
  });

  it('4.44 末轮结构阻断：#2 两轮均含句尾截断 → 不再静默放行（末轮同样阻断，块失败交上层隔离重试）', async () => {
    // 4.43 实测形态：段落末句无终止标点且后接标题（截断类内容级缺陷，确定性不可修复）——
    // 修复前 attempt 1 的 structureBlocking 恒为 false，直通/修复通道均静默放行带病成稿；
    // 修复后任何轮次一律阻断：二轮反馈携缺陷原文，末轮仍残留 → 块失败隔离清单返回（上层章阻断或隔离重试）
    const truncated = `### 测量放线\n\n#### ${H4A}\n\n${bodyLine(60, 0)}\n\n垂直度偏差用靠尺实测不超过3mm，并核查门窗性能检测报告\n\n#### ${H4B}\n\n${bodyLine(60, 1)}\n\n#### ${H4C}\n\n${bodyLine(60, 2)}\n\n#### ${H4D}\n\n${bodyLine(60, 3)}`;
    llmMock.mockResolvedValue(truncated);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
    expect(result?.failedBlocks).toHaveLength(1);
    expect(llmMock).toHaveBeenCalledTimes(2);
    expect(llmMock.mock.calls[1][1]).toContain('结构完整性未通过');
    expect(llmMock.mock.calls[1][1]).toContain('句尾截断');
  });

  it('4.44 回归：多块全部失败 → 仍返回完整失败块隔离清单（全失败早退缺陷修复，C3 不再被跳过）', async () => {
    // 4.44 丰乐镇实机：工期章 2 块两轮均缺 H4 → 全部失败 → 旧实现 `results.every(!content) → undefined`
    // 早退，stageChapterLoop 的 `else if (plannedFirst)` 为 falsy → C3 块级隔离重试被整体跳过 → 章直接阻断；
    // 修复后：全失败同样返回 failedBlocks 清单（携带全部失败块与各自 index），由上层 C3 隔离重写闭环
    const secondBlock: PlannedChapterBlock = { title: '沉降观测专项', subPoints: [{ title: '观测点布设', sources: ['s5'] }], facts: [], targetWords: 500 };
    llmMock.mockResolvedValue(shortContent);
    const diag = mockDiagnostics();
    const result = await buildPlannedChapterContent(makeInput({ diagnostics: diag }), makeStructure({ blocks: [makeBlock(), secondBlock] }));
    expect(result?.allSucceeded).toBe(false);
    expect(result?.failedBlocks).toHaveLength(2);
    expect(result?.failedBlocks.map(entry => entry.block.title)).toEqual(['测量放线', '沉降观测专项']);
    expect(result?.sections).toEqual([undefined, undefined]);
    // 诊断文案区分全失败/部分失败（供章阻断归因展示）
    expect(diag.llm.lastError).toContain('规划块全部失败');
  });

  it('C7 对冲接纳痕迹收集：两轮超产（末轮 >1.2× 容差线）→ failedBlocks 携带 lastAttempt 与 failureKinds=[over-produce]', async () => {
    // r28m 形态：块两轮均超产 → 块失败；失败清单须携带「最近一次有效尝试原文 + 失败类别」，
    // 供上层（stageChapterLoop）在隔离重写耗尽后判定章级超产对冲接纳（仅篇幅超产才可接纳）
    llmMock.mockResolvedValue(passingContent([H4A, H4B, H4C, H4D], 200));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(false);
    const failed = result?.failedBlocks[0];
    expect(failed?.failureKinds).toEqual(['over-produce']);
    expect(failed?.lastAttempt).toContain(H4A);
    expect(failed?.lastAttempt).toContain('施');
  });

  it('C7 痕迹末轮覆盖：两轮内容不同 → lastAttempt 为末轮原文（最近一次有效尝试）', async () => {
    const round1 = passingContent([H4A, H4B, H4C, H4D], 200);
    const round2 = passingContent([H4A, H4B, H4C, H4D], 200).replace(BODY_TAILS[3]!, `${BODY_TAILS[3]}二轮标记`);
    llmMock.mockResolvedValueOnce(round1).mockResolvedValueOnce(round2);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.failedBlocks[0]?.failureKinds).toEqual(['over-produce']);
    expect(result?.failedBlocks[0]?.lastAttempt).toContain('二轮标记');
  });

  it('C7 反样本守护：结构类失守（缺 H4）→ failureKinds 含 structure-titles（非篇幅类不进入对冲接纳）', async () => {
    llmMock.mockResolvedValue(shortContent);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.failedBlocks[0]?.failureKinds).toContain('structure-titles');
    expect(result?.failedBlocks[0]?.failureKinds).not.toEqual(['over-produce']);
  });

  it('C7 反样本守护：句尾截断（结构完整性，确定性不可修复）→ failureKinds 含 structure-integrity', async () => {
    const truncated = `### 测量放线\n\n#### ${H4A}\n\n${bodyLine(60, 0)}\n\n垂直度偏差用靠尺实测不超过3mm，并核查门窗性能检测报告\n\n#### ${H4B}\n\n${bodyLine(60, 1)}\n\n#### ${H4C}\n\n${bodyLine(60, 2)}\n\n#### ${H4D}\n\n${bodyLine(60, 3)}`;
    llmMock.mockResolvedValue(truncated);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.failedBlocks[0]?.failureKinds).toContain('structure-integrity');
  });
});

/** C7 章级超产对冲接纳接线锁定（源文本静态断言，防重构静默删除对冲接纳链；行为语义由上方用例与本文件 C7 段覆盖） */
describe('C7 章级超产对冲接纳源文本锁定（防静默回归）', () => {
  const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');
  const chapterGenerationSrc = readFileSync(path.join(SRC_DIR, 'chapterGeneration.ts'), 'utf8');
  const stageChapterLoopSrc = readFileSync(path.join(SRC_DIR, 'generationStages', 'stageChapterLoop.ts'), 'utf8');

  it('写作层：失败块痕迹收集 + 接纳纯函数与常数导出不缺失', () => {
    expect(chapterGenerationSrc).toContain('blockLastAttempts.set(index, withBlockShell)');
    expect(chapterGenerationSrc).toContain('blockFailureKinds.set(index, [');
    expect(chapterGenerationSrc).toContain('export function salvageChapterByOverProduceAcceptance');
    expect(chapterGenerationSrc).toContain('export const CHAPTER_OVER_PRODUCE_ACCEPTANCE_MAX_RATIO = 1.2');
    expect(chapterGenerationSrc).toContain('export const CHAPTER_OVER_PRODUCE_ACCEPTANCE_MIN_RATIO = 0.85');
  });

  it('章收口：对冲接纳分支 + 审计记录 + stage details 追加不缺失', () => {
    expect(stageChapterLoopSrc).toContain('salvageChapterByOverProduceAcceptance({');
    expect(stageChapterLoopSrc).toContain('overProduceAcceptanceNote = acceptance.detail');
    expect(stageChapterLoopSrc).toContain('...(overProduceAcceptanceNote ? [overProduceAcceptanceNote] : [])');
  });

  it('零静默降级守护：接纳失败路径仍走章阻断（显式 throw 分支不消失）', () => {
    expect(stageChapterLoopSrc).toContain('已阻断生成（${failureReason.slice(0, 160)}）');
    expect(stageChapterLoopSrc).toContain('throw new Error(message)');
  });
});
