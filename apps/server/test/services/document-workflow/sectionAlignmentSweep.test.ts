/**
 * repairRounds · 小节结构对齐链尾重放轮（section-alignment-sweep）：
 * D-T6 ②（r28f 门禁 #2 归因：第 7 章成稿 5 节 vs 规划 4 节）——近名合并/漂移改名
 * （mergeNearDuplicateSectionHeadings）位于缺节补写（enforcePlannedSectionCompleteness）之前，
 * 补写后「漂移+补写并存」历史形态与落单漂移行到链尾再无收口点。本测试锁定：
 * 1. 接线：FINALIZE 声明表（empty-section-sweep 之后）+ documentPipeline 调用位置
 *    （stageEmptySectionSweep 之后、链尾 markdown-only 重放之前）；
 * 2. 行为矩阵（零 LLM 确定性）：漂移改名（r28f 落单形态）/ 规划外非近名 H3 降 H4 /
 *    零改动核对通过 / 幂等（refill 同一轮复跑零变化）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  buildSemanticSimilarity: vi.fn(async () => () => 0),
  snapshotEmbedCacheStats: vi.fn(() => ({ embedCacheHits: 0, embedCacheMisses: 0 })),
  getLocalSemanticProvider: vi.fn(() => ({ embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => [0, 0])) })),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  clearEmbedCacheForTest: vi.fn(),
}));

import { FINALIZE_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import { stageSectionAlignmentSweep } from '@/services/document-workflow/finalize/repairRounds/sectionAlignmentSweep';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 落单漂移形态：规划名「…目标落位」单字漂移为「…目标落实」，无精确规划名版并存的单行 */
const DRIFT_CONTENT = [
  '## 确保安全生产的技术组织措施',
  '### 7.1 安全责任体系与目标落实',
  '落实版本正文段落。',
].join('\n');

/** 改名后：标题回规划名，编号经章片段原子重放规范为「章序.节序」（7.1 为陈旧写作侧章号，本 session 单章=第 1 章 → 1.1） */
const DRIFT_RENAMED = [
  '## 确保安全生产的技术组织措施',
  '### 1.1 安全责任体系与目标落位',
  '落实版本正文段落。',
].join('\n');

/** 规划外非近名 H3（1.5）形态：成稿 5 节 vs 规划 4 节（r28f 门禁 #2 同域） */
const OVERFLOW_CONTENT = [
  '## 确保安全生产的技术组织措施',
  '### 1.1 安全生产责任体系与目标落位',
  '落位正文。',
  '### 1.2 安全生产费用保障与使用制度',
  '费用正文。',
  '### 1.3 安全教育培训与技术交底',
  '教育正文。',
  '### 1.4 危险源辨识与风险分级管控',
  '风险正文。',
  '### 1.5 安全生产检查与隐患整改',
  '检查正文。',
].join('\n');

/** 降级后：1.5 整行降 H4（并入 1.4 主题块），H3 编号序列无空档 */
const OVERFLOW_DEMOTED = [
  '## 确保安全生产的技术组织措施',
  '### 1.1 安全生产责任体系与目标落位',
  '落位正文。',
  '### 1.2 安全生产费用保障与使用制度',
  '费用正文。',
  '### 1.3 安全教育培训与技术交底',
  '教育正文。',
  '### 1.4 危险源辨识与风险分级管控',
  '风险正文。',
  '#### 安全生产检查与隐患整改',
  '检查正文。',
].join('\n');

/** 已对齐形态：成稿小节与规划一一对应（核对通过） */
const ALIGNED_CONTENT = [
  '## 确保安全生产的技术组织措施',
  '### 1.1 安全生产责任体系与目标落位',
  '落位正文。',
].join('\n');

/** r28h2 实机形态：无编号 H3（路结构层主材投入）+ 编号缺号（1.2 独存缺 1.1） */
const UNNUMBERED_CONTENT = [
  '## 拟投入的主要物资计划',
  '### 路结构层主材投入',
  '路结构层正文。',
  '### 1.2 生态池构筑物材料投入',
  '生态池正文。',
].join('\n');

/** 重放后：无编号 H3 补为 1.1，原 1.2 保持，编号连续 */
const UNNUMBERED_RENUMBERED = [
  '## 拟投入的主要物资计划',
  '### 1.1 路结构层主材投入',
  '路结构层正文。',
  '### 1.2 生态池构筑物材料投入',
  '生态池正文。',
].join('\n');

/** s28h2 实机形态：章号错位（第 2 章内出现 9.x，写作侧陈旧章号） */
const MISNUMBERED_CONTENT = [
  '## 施工总平面布置图',
  '### 9.2 保洁标准与完工交接条件',
  '保洁正文。',
].join('\n');

/** 重放后：9.2 → 2.1（章号=章序，编号从 1 起连续） */
const MISNUMBERED_RENUMBERED = [
  '## 施工总平面布置图',
  '### 2.1 保洁标准与完工交接条件',
  '保洁正文。',
].join('\n');

interface StageLike { roleId?: string; status?: string; message?: string; details?: string[] }

function stageOf(stages: StageLike[], roleId: string): StageLike | undefined {
  return stages.find(stage => stage.roleId === roleId);
}

function makeSession(chapters: Array<{ id: string; title: string; content: string; sections?: string[] }>) {
  const session = {
    template: {},
    requirement: '',
    bidComposition: undefined,
    signal: undefined,
    generationDiagnostics: { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, lastError: '' } },
    finalChapterDrafts: chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: chapter.sections ?? [] })),
    progressStages: [] as StageLike[],
    finalGateRepairStages: [] as StageLike[],
    finalMarkdown: chapters.map(chapter => chapter.content).join('\n\n'),
    emitProgress: vi.fn(),
    withProgressHeartbeat: (fn: () => Promise<unknown>) => fn(),
    recomputeFinalValidationBundle: vi.fn(async () => {}),
  } as unknown as FinalizeSession & { finalChapterDrafts: Array<{ content: string }> };
  Object.assign(session, { rebuildFinalMarkdown: vi.fn(() => session.finalChapterDrafts.map(chapter => chapter.content).join('\n\n')) });
  return session;
}

describe('section-alignment-sweep 接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE 声明表：位于 empty-section-sweep 之后、delivery-structure-closure 之前', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const sweepIndex = rounds.indexOf('empty-section-sweep');
    const alignIndex = rounds.indexOf('section-alignment-sweep');
    const closureIndex = rounds.indexOf('delivery-structure-closure');
    expect(sweepIndex).toBeGreaterThan(-1);
    expect(alignIndex).toBeGreaterThan(sweepIndex);
    expect(closureIndex).toBeGreaterThan(alignIndex);
  });

  it('documentPipeline.ts 在 stageEmptySectionSweep 之后、链尾 markdown-only 重放之前调用', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const sweepIndex = source.indexOf('await stageEmptySectionSweep(session);');
    const alignIndex = source.indexOf('await stageSectionAlignmentSweep(session);');
    const replayIndex = source.indexOf('await runSurfaceDeterministicCleans(session);');
    expect(sweepIndex).toBeGreaterThan(-1);
    expect(alignIndex).toBeGreaterThan(sweepIndex);
    expect(replayIndex).toBeGreaterThan(alignIndex);
  });
});

describe('section-alignment-sweep 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('漂移改名（r28f 落单形态）：标题回规划名 + rebuild/recompute + 双写 + 明细', async () => {
    const session = makeSession([{ id: 'ch1', title: '确保安全生产的技术组织措施', content: DRIFT_CONTENT, sections: ['安全责任体系与目标落位', '安全生产费用保障与使用制度'] }]);
    await stageSectionAlignmentSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(DRIFT_RENAMED);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalledTimes(1);
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'section-alignment-sweep');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toBe('小节结构对齐收口：近名对齐/合并 1 处、规划外小节降级 0 处、编号重放 1 章');
    expect(stage?.details?.[0]).toContain('对齐规划名');
    expect(stageOf(session.finalGateRepairStages, 'section-alignment-sweep')?.status).toBe('success');
  });

  it('规划外非近名 H3 降 H4：1.5 整行降级并入上方主题块（编号序列无空档）', async () => {
    const session = makeSession([{ id: 'ch1', title: '确保安全生产的技术组织措施', content: OVERFLOW_CONTENT, sections: ['安全生产责任体系与目标落位', '安全生产费用保障与使用制度', '安全教育培训与技术交底', '危险源辨识与风险分级管控'] }]);
    await stageSectionAlignmentSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(OVERFLOW_DEMOTED);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalledTimes(1);
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'section-alignment-sweep');
    expect(stage?.message).toBe('小节结构对齐收口：近名对齐/合并 0 处、规划外小节降级 1 处、编号重放 0 章');
    expect(stage?.details?.[0]).toContain('降为 H4');
  });

  it('已对齐形态：零改动核对通过（无 rebuild/recompute）', async () => {
    const session = makeSession([{ id: 'ch1', title: '确保安全生产的技术组织措施', content: ALIGNED_CONTENT, sections: ['安全生产责任体系与目标落位'] }]);
    await stageSectionAlignmentSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(ALIGNED_CONTENT);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'section-alignment-sweep');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toBe('小节结构对齐核对通过：成稿小节与规划主题块一一对应');
  });

  it('幂等：收口后再运行零变化（无 rebuild/recompute）', async () => {
    const session = makeSession([{ id: 'ch1', title: '确保安全生产的技术组织措施', content: DRIFT_CONTENT, sections: ['安全责任体系与目标落位', '安全生产费用保障与使用制度'] }]);
    await stageSectionAlignmentSweep(session);
    const settled = session.finalChapterDrafts[0].content;
    const rebuildMock = vi.mocked(session.rebuildFinalMarkdown);
    const recomputeMock = vi.mocked(session.recomputeFinalValidationBundle);
    rebuildMock.mockClear();
    recomputeMock.mockClear();
    await stageSectionAlignmentSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(settled);
    expect(rebuildMock).not.toHaveBeenCalled();
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(stageOf(session.progressStages, 'section-alignment-sweep')?.message).toContain('核对通过');
  });

  it('r28h2 形态：无编号 H3 补号 + 缺号重排（编号连续化，编号缺陷链尾收口）', async () => {
    const session = makeSession([{ id: 'ch1', title: '拟投入的主要物资计划', content: UNNUMBERED_CONTENT, sections: [] }]);
    await stageSectionAlignmentSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(UNNUMBERED_RENUMBERED);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalledTimes(1);
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'section-alignment-sweep');
    expect(stage?.message).toBe('小节结构对齐收口：近名对齐/合并 0 处、规划外小节降级 0 处、编号重放 1 章');
  });

  it('s28h2 形态：章号错位纠正（第 2 章内 9.x → 2.x，章号=章序同终检口径）', async () => {
    const session = makeSession([
      { id: 'ch1', title: '工程概况', content: '## 工程概况\n### 1.1 编制依据\n依据正文。', sections: [] },
      { id: 'ch2', title: '施工总平面布置图', content: MISNUMBERED_CONTENT, sections: [] },
    ]);
    await stageSectionAlignmentSweep(session);
    expect(session.finalChapterDrafts[1].content).toBe(MISNUMBERED_RENUMBERED);
    const stage = stageOf(session.progressStages, 'section-alignment-sweep');
    expect(stage?.message).toContain('编号重放 1 章');
  });
});
