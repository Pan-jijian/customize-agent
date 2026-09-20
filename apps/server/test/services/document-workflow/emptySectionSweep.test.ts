/**
 * repairRounds · 空节链尾清扫轮（empty-section-sweep）：
 * D-T3 ②（r28f 终检「空小节」blocker 归因）——补写轮把无规划归属空壳 H4（「特殊技术标准和要求」形态）
 * 的正文搬往规划名小节后，空壳标题行残留直坠终检 section-content-integrity。本测试锁定：
 * 1. 接线：注册表双登记（CHAPTER_DETERMINISTIC_FIXERS 锚定 section-content-integrity
 *    + FINALIZE 链尾声明）+ documentPipeline 调用位置（table-arithmetic-repair 之后、
 *    链尾 markdown-only 重放之前）；
 * 2. 行为矩阵（零 LLM 确定性）：r28f 形态空壳 H4 整行移除 + rebuild/recompute /
 *    规划近名归属空壳跳过（补写辖区）/ 非空壳（正文、表格承载）不删 /
 *    H3 空壳删除后编号原子重放（1.4→1.3 补空档）/ 空壳 H3 内嵌空壳 H4 逐轮收敛 / 幂等。
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

import { CHAPTER_DETERMINISTIC_FIXERS, FINALIZE_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import { stageEmptySectionSweep } from '@/services/document-workflow/finalize/repairRounds/emptySectionSweep';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** r28f 形态：无规划归属空壳 H4（「特殊技术标准和要求」）挂在有正文 H3 与后续 H3 之间 */
const R28F_CONTENT = [
  '## 施工组织设计',
  '本章为施工组织设计总述。',
  '### 1.1 施工部署',
  '部署安排正文。',
  '#### 特殊技术标准和要求',
  '### 1.2 资源配置',
  '资源配置正文。',
].join('\n');

/** 清扫后：H4 行整行移除；'### 1.x' 编号已连续 → 无需重排 */
const R28F_CLEANED = [
  '## 施工组织设计',
  '本章为施工组织设计总述。',
  '### 1.1 施工部署',
  '部署安排正文。',
  '### 1.2 资源配置',
  '资源配置正文。',
].join('\n');

/** 规划近名归属：空壳但小节名命中章规划 → 补写辖区不删（r28g 语义） */
const PLANNED_GAP_CONTENT = [
  '## 安全文明施工',
  '### 1.1 安全责任体系与目标落实',
].join('\n');

/** 非空壳：H3 带正文 / H3 带表格承载（保守零信息风险） */
const NON_EMPTY_CONTENT = [
  '## 施工组织设计',
  '### 1.1 施工部署',
  '部署正文。',
  '### 1.2 资源配置',
  '| 项目 | 状态 |',
  '| --- | --- |',
  '| 水泥 | 合格 |',
].join('\n');

/** H3 空壳（1.3）夹在编号序列中：删除后 1.4 → 1.3 编号原子重放 */
const NUMBERED_GAP_CONTENT = [
  '## 施工组织设计',
  '### 1.1 施工部署',
  '部署正文。',
  '### 1.2 资源配置',
  '配置正文。',
  '### 1.3 临时设施',
  '### 1.4 进度安排',
  '进度正文。',
].join('\n');

const NUMBERED_GAP_CLEANED = [
  '## 施工组织设计',
  '### 1.1 施工部署',
  '部署正文。',
  '### 1.2 资源配置',
  '配置正文。',
  '### 1.3 进度安排',
  '进度正文。',
].join('\n');

/** 空壳 H3（1.2）内嵌空壳 H4（1.2.1）：单轮只清 H4，guard 逐轮收敛再清 H3 */
const NESTED_GAP_CONTENT = [
  '## 施工组织设计',
  '### 1.1 施工部署',
  '部署正文。',
  '### 1.2 临时设施',
  '#### 1.2.1 临时用电',
  '### 1.3 进度安排',
  '进度正文。',
].join('\n');

const NESTED_GAP_CLEANED = [
  '## 施工组织设计',
  '### 1.1 施工部署',
  '部署正文。',
  '### 1.2 进度安排',
  '进度正文。',
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

describe('empty-section-sweep 接线（防「修复器存在但未接线」回归）', () => {
  it('注册表双登记：CHAPTER 表锚定 section-content-integrity + FINALIZE 链尾声明', () => {
    const entry = CHAPTER_DETERMINISTIC_FIXERS.find(fixer => fixer.id === 'empty-section-strip');
    expect(entry?.kind).toBe('deterministic');
    expect(entry?.anchoredTo).toBe('section-content-integrity');
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    // D-T7 后链尾：... → table-arithmetic-repair → empty-section-sweep → section-alignment-sweep
    // → templating-sweep → duplicate-theme-merge → delivery-structure-closure（本清扫轮为链尾 draft-mutating 序列首环）
    const sweepIndex = rounds.indexOf('empty-section-sweep');
    expect(sweepIndex).toBe(rounds.indexOf('table-arithmetic-repair') + 1);
    expect(rounds.indexOf('section-alignment-sweep')).toBe(sweepIndex + 1);
  });

  it('documentPipeline.ts 在 table-arithmetic-repair 之后、链尾 markdown-only 重放之前调用', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const arithmeticIndex = source.indexOf('await stageTableArithmeticRepair(session);');
    const sweepIndex = source.indexOf('await stageEmptySectionSweep(session);');
    const replayIndex = source.indexOf('await runSurfaceDeterministicCleans(session);');
    expect(arithmeticIndex).toBeGreaterThan(-1);
    expect(sweepIndex).toBeGreaterThan(arithmeticIndex);
    expect(replayIndex).toBeGreaterThan(sweepIndex);
  });
});

describe('empty-section-sweep 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('r28f 形态：无规划归属空壳 H4 整行移除（编号已连续不重排）+ rebuild/recompute + 双写', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工组织设计', content: R28F_CONTENT }]);
    await stageEmptySectionSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(R28F_CLEANED);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalledTimes(1);
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'empty-section-sweep');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('移除无依据空壳小节标题 1 处（0 章重排编号）');
    expect(stage?.details?.[0]).toContain('第 1 章移除空壳标题「特殊技术标准和要求」');
    expect(stageOf(session.finalGateRepairStages, 'empty-section-sweep')?.status).toBe('success');
  });

  it('规划近名归属空壳：跳过（补写辖区），核对通过零改动', async () => {
    const session = makeSession([{ id: 'ch1', title: '安全文明施工', content: PLANNED_GAP_CONTENT, sections: ['安全责任体系与目标落实'] }]);
    await stageEmptySectionSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(PLANNED_GAP_CONTENT);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'empty-section-sweep');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('核对通过');
  });

  it('非空壳（正文、表格承载）不删：保守零信息风险', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工组织设计', content: NON_EMPTY_CONTENT }]);
    await stageEmptySectionSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(NON_EMPTY_CONTENT);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
    expect(stageOf(session.progressStages, 'empty-section-sweep')?.message).toContain('核对通过');
  });

  it('H3 空壳删除后编号原子重放：1.4 → 1.3 补空档', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工组织设计', content: NUMBERED_GAP_CONTENT }]);
    await stageEmptySectionSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(NUMBERED_GAP_CLEANED);
    const stage = stageOf(session.progressStages, 'empty-section-sweep');
    expect(stage?.message).toContain('移除无依据空壳小节标题 1 处（1 章重排编号）');
  });

  it('空壳 H3 内嵌空壳 H4：guard 逐轮收敛（先清 H4 再清 H3）', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工组织设计', content: NESTED_GAP_CONTENT }]);
    await stageEmptySectionSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(NESTED_GAP_CLEANED);
    const stage = stageOf(session.progressStages, 'empty-section-sweep');
    expect(stage?.message).toContain('移除无依据空壳小节标题 2 处（1 章重排编号）');
  });

  it('幂等：清扫后再运行零变化（无 rebuild/recompute）', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工组织设计', content: R28F_CONTENT }]);
    await stageEmptySectionSweep(session);
    const cleaned = session.finalChapterDrafts[0].content;
    const rebuildMock = vi.mocked(session.rebuildFinalMarkdown);
    const recomputeMock = vi.mocked(session.recomputeFinalValidationBundle);
    rebuildMock.mockClear();
    recomputeMock.mockClear();
    await stageEmptySectionSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(cleaned);
    expect(rebuildMock).not.toHaveBeenCalled();
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(stageOf(session.progressStages, 'empty-section-sweep')?.message).toContain('核对通过');
  });
});
