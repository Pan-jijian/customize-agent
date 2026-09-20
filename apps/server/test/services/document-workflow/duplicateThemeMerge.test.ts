/**
 * repairRounds · 重复主题小节链尾合并轮（duplicate-theme-merge）：
 * D-T7 ②（r28f #36/#37 归因：minChapterSectionIssues 检测恒报、修复链零消费）。
 * 本测试锁定：
 * 1. 接线：FINALIZE 声明表（templating-sweep 之后、delivery-structure-closure 之前）
 *    + documentPipeline 调用位置（stageTemplatingSweep 之后、链尾 markdown-only 重放之前）；
 * 2. 行为矩阵（零 LLM 确定性，经 mergeDuplicateThematicSections 单源）：同桶两节并存（保留首现、
 *    drop 标题行摘除、正文并入、规划数组同步、章内编号重排）/ 同桶三节 guard 收敛 / 正文缺 H3
 *    落位不合并（保守跳过）/ 非同桶不合并 / 幂等（复跑零变化）。
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
import { stageDuplicateThemeMerge } from '@/services/document-workflow/finalize/repairRounds/duplicateThemeMerge';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 同桶两节并存形态（劳动力×2）：drop「劳动力保证措施」并入首现「劳动力配置计划」 */
const MERGE_CONTENT = [
  '## 施工资源配置计划',
  '### 1.1 劳动力配置计划',
  '劳动力配置正文：高峰期投入充足作业人员。',
  '### 1.2 劳动力保证措施',
  '劳动力保证正文：农忙季节提前预留队伍。',
  '### 1.3 材料供应计划',
  '材料供应正文：按进度分批进场。',
].join('\n');

/** 同桶三节并存形态（劳动力×3）：guard 循环逐对收敛至单节 */
const TRIPLE_CONTENT = [
  '## 施工资源配置计划',
  '### 1.1 劳动力配置计划',
  '配置正文。',
  '### 1.2 劳动力保证措施',
  '保证正文。',
  '### 1.3 劳动力动态管理',
  '动态正文。',
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
  } as unknown as FinalizeSession & { finalChapterDrafts: Array<{ content: string; sections: string[] }> };
  Object.assign(session, { rebuildFinalMarkdown: vi.fn(() => session.finalChapterDrafts.map(chapter => chapter.content).join('\n\n')) });
  return session;
}

describe('duplicate-theme-merge 接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE 声明表：位于 templating-sweep 之后、delivery-structure-closure 之前', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const sweepIndex = rounds.indexOf('templating-sweep');
    const mergeIndex = rounds.indexOf('duplicate-theme-merge');
    const closureIndex = rounds.indexOf('delivery-structure-closure');
    expect(sweepIndex).toBeGreaterThan(-1);
    expect(mergeIndex).toBeGreaterThan(sweepIndex);
    expect(closureIndex).toBeGreaterThan(mergeIndex);
  });

  it('documentPipeline.ts 在 stageTemplatingSweep 之后、链尾 markdown-only 重放之前调用', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const sweepIndex = source.indexOf('await stageTemplatingSweep(session);');
    const mergeIndex = source.indexOf('await stageDuplicateThemeMerge(session);');
    const replayIndex = source.indexOf('await runSurfaceDeterministicCleans(session);');
    expect(sweepIndex).toBeGreaterThan(-1);
    expect(mergeIndex).toBeGreaterThan(sweepIndex);
    expect(replayIndex).toBeGreaterThan(mergeIndex);
  });
});

describe('duplicate-theme-merge 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('同桶两节并存：保留首现、drop 标题行摘除、正文并入、规划数组同步、章内编号重排', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工资源配置计划', content: MERGE_CONTENT, sections: ['劳动力配置计划', '劳动力保证措施', '材料供应计划'] }]);
    await stageDuplicateThemeMerge(session);
    const chapter = session.finalChapterDrafts[0];
    expect(chapter.sections).toEqual(['劳动力配置计划', '材料供应计划']);
    expect(chapter.content).toContain('### 1.1 劳动力配置计划');
    expect(chapter.content).not.toContain('劳动力保证措施');
    expect(chapter.content).toContain('劳动力配置正文：高峰期投入充足作业人员。');
    expect(chapter.content).toContain('劳动力保证正文：农忙季节提前预留队伍。');
    // 合并不消耗编号：后续小节重排为 1.2（原 1.3），编号序列无空档
    expect(chapter.content).toContain('### 1.2 材料供应计划');
    expect(session.rebuildFinalMarkdown).toHaveBeenCalledTimes(1);
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'duplicate-theme-merge');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toBe('重复主题小节合并：1 处（保留首现小节，后续标题行摘除、正文并入，规划数组同步）');
    expect(stage?.details?.[0]).toContain('「劳动力保证措施」并入「劳动力配置计划」');
    expect(stageOf(session.finalGateRepairStages, 'duplicate-theme-merge')?.status).toBe('success');
  });

  it('同桶三节并存：guard 循环逐对收敛至单节，规划数组同步逐项删除', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工资源配置计划', content: TRIPLE_CONTENT, sections: ['劳动力配置计划', '劳动力保证措施', '劳动力动态管理'] }]);
    await stageDuplicateThemeMerge(session);
    const chapter = session.finalChapterDrafts[0];
    expect(chapter.sections).toEqual(['劳动力配置计划']);
    expect((chapter.content.match(/^### /gmu) || [])).toHaveLength(1);
    expect(chapter.content).toContain('保证正文。');
    expect(chapter.content).toContain('动态正文。');
    expect(stageOf(session.progressStages, 'duplicate-theme-merge')?.message).toBe('重复主题小节合并：2 处（保留首现小节，后续标题行摘除、正文并入，规划数组同步）');
  });

  it('正文缺 H3 落位：同桶规划项无法定位成对 → 不合并（保守交终检报告）', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工资源配置计划', content: '## 施工资源配置计划\n### 1.1 劳动力配置计划\n配置正文。', sections: ['劳动力配置计划', '劳动力保证措施'] }]);
    const before = session.finalChapterDrafts[0].content;
    await stageDuplicateThemeMerge(session);
    expect(session.finalChapterDrafts[0].sections).toEqual(['劳动力配置计划', '劳动力保证措施']);
    expect(session.finalChapterDrafts[0].content).toBe(before);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
    expect(stageOf(session.progressStages, 'duplicate-theme-merge')?.message).toBe('重复主题小节核对通过：同桶小节无并存');
  });

  it('非同桶（劳动力 + 材料）：单桶单项不触发合并', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工资源配置计划', content: MERGE_CONTENT, sections: ['劳动力配置计划', '材料供应计划'] }]);
    await stageDuplicateThemeMerge(session);
    expect(session.finalChapterDrafts[0].content).toBe(MERGE_CONTENT);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
    expect(stageOf(session.progressStages, 'duplicate-theme-merge')?.message).toBe('重复主题小节核对通过：同桶小节无并存');
  });

  it('幂等：合并后复跑零变化（无 rebuild/recompute）', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工资源配置计划', content: MERGE_CONTENT, sections: ['劳动力配置计划', '劳动力保证措施', '材料供应计划'] }]);
    await stageDuplicateThemeMerge(session);
    const settledContent = session.finalChapterDrafts[0].content;
    const settledSections = [...session.finalChapterDrafts[0].sections];
    const rebuildMock = vi.mocked(session.rebuildFinalMarkdown);
    const recomputeMock = vi.mocked(session.recomputeFinalValidationBundle);
    rebuildMock.mockClear();
    recomputeMock.mockClear();
    await stageDuplicateThemeMerge(session);
    expect(session.finalChapterDrafts[0].content).toBe(settledContent);
    expect(session.finalChapterDrafts[0].sections).toEqual(settledSections);
    expect(rebuildMock).not.toHaveBeenCalled();
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(stageOf(session.progressStages, 'duplicate-theme-merge')?.message).toContain('核对通过');
  });
});
