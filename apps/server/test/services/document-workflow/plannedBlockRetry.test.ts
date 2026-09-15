/**
 * buildPlannedChapterContent（块写作合同）单测：
 * 字数双向硬合同（4.40）：达标区 [0.85,1.15] 直通；欠产侧接受区 [0.7,0.85) 记录放行、<0.7 仅
 * 首轮阻断（二轮放行）；超产侧 >1.15 任何轮次阻断（二轮仍超产 → 块失败，零降级）——旧 4.35
 * 「接受区 [0.7,1.4] 放行 / 二轮一律放行」是超产进入成稿的最后失守环节（舒城 14 万目标产出 22 万字）。
 * 结构硬门保留零降级（缺失/重复 H4、清单外标题）→ 标题层缺陷确定性修复通道（修复后仍超产不得
 * 放行）→ 两轮不达标返回失败块隔离清单（不整章降级）。
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

  it('接受区（0.7~0.85×，结构齐全）→ 直通成稿、不耗二轮（微缺口重写收敛期望为负）', async () => {
    // 420 字 vs 块目标 500（0.84×）：落在接受区 [350,700] 且结构齐全 → 首轮直通（旧实现 <0.85× 即阻断
    // → 重写风暴；舒城实测重写对字数不收敛，微越界重写的收敛期望为负）
    llmMock.mockResolvedValue(passingContent([H4A, H4B, H4C, H4D], 90));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(result?.markdown).toContain(H4D);
  });

  it('两轮字数均严重不足但结构齐全 → 二轮放行成稿（欠产侧不构成块失败）', async () => {
    // 160 字 vs 500（0.32×）两轮不变：首轮 <0.7× 阻断重写、二轮放行——欠产侧二轮放行（补足需新事实，
    // 不可控；与超产侧压缩的确定性收敛不同）；块成功、章不被阻断
    llmMock.mockResolvedValue(`### 测量放线\n\n${[H4A, H4B, H4C, H4D].map((title, index) => `#### ${title}\n\n${bodyLine(25, index)}`).join('\n\n')}`);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(2);
    expect(result?.markdown).toContain(H4A);
  });

  it('首轮严重超产（>1.15×）→ 二轮携压缩反馈重写；二轮仍超产 → 块失败（零降级）', async () => {
    // 860 字 vs 500（1.72×）两轮不变：超产侧任何轮次阻断——二轮仍超产 → 块失败 → 返回 undefined
    //（单块章全失败 → 上层章阻断、文档显式失败）；多块章的失败块隔离重试由 stageChapterLoop.retryFailedBlocks 处理
    llmMock.mockResolvedValue(passingContent([H4A, H4B, H4C, H4D], 200));
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result).toBeUndefined();
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
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(result?.markdown).toContain('编制说明与工程概况');
  });

  it('要点缺失两轮仍不齐 → 结构硬门阻断（单块章全失败返回 undefined → 上层章阻断）', async () => {
    // 工具链对齐：字数维度已不构成块失败（见上方分层验收用例）；短正文缺 3 个 H4 要点 → 结构硬门
    // 两轮阻断 → 块失败；单块章全部失败 → 返回 undefined（上层解释为整章阻断、文档显式失败）。
    // 不再有写作层事后拆半——半块重设预算使父块合同失效的历史机制已删除；
    // 多块章的部分失败隔离（成功块保留）见前两个用例与 stageChapterLoop.retryFailedBlocks
    llmMock.mockResolvedValue(shortContent);
    const result = await buildPlannedChapterContent(makeInput(), makeStructure());
    expect(result).toBeUndefined();
    expect(llmMock).toHaveBeenCalledTimes(2);
  });

  it('4.19.5 回归：分部章容器块走总述提示词（不锁骨架不写三段式），正文直接展开成稿', async () => {
    // 容器块（「主要分部分项工程施工方案」在「主要施工方法」章内）是全章总述小节：
    // 修复前按三段式 divisionPrompt 展开 → LLM 把本章全部分部名写成 H4（清单外）+三段标签重复 → 章阻断
    const containerBlock: PlannedChapterBlock = { title: '主要分部分项工程施工方案', subPoints: [{ title: '主要分部分项工程施工方案', sources: ['主要分部分项工程施工方案'] }], facts: [], targetWords: 3600 };
    llmMock.mockResolvedValue(`### 主要分部分项工程施工方案\n\n${bodyLine(3300, 0)}`);
    const result = await buildPlannedChapterContent(makeInput({ chapter: makeChapter({ title: '主要施工方法' }) }), makeStructure({ blocks: [containerBlock] }));
    expect(result?.allSucceeded).toBe(true);
    expect(llmMock).toHaveBeenCalledTimes(1);
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
});
