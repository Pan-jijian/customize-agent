/**
 * repairRounds · 成稿篇幅压缩轮（length-compression-repair）：
 * D-T3 ①（B8 后半根治）——成稿字数超出目标 20%（document-budget「明显超出」warning）此前无修复轮消费，
 * 超产直坠交付（验收线「目标 ±20% 内」）。本测试锁定：
 * 1. 接线：注册表双登记（FINALIZE 链尾声明 + LLM_PATCH 锚定 document-budget）
 *    + documentPipeline 调用位置（post-review-surface 之后、fact-distribution 之前）；
 * 2. 行为矩阵：容差内零成本通过（含 120% 边界）/ 超标章级定位 + LLM 压缩落地（rebuild + recompute）/
 *    两轮收敛（第二轮 instruction 带轮次提示）/ 信息守恒守卫三类回滚（数值缺失、标题缺失、表格行减少，
 *    保留修复前正文 + patchGuard 回滚记账）/ 模型未产生有效修改显性记录 / 仅超额章进修复；
 * repairChapterByQuality 全 mock（withPatchRollback 为真实实现，无 LLM 网络依赖）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/rolePipeline', () => ({
  repairChapterByQuality: vi.fn(),
  repairPatchGuard: vi.fn(() => undefined),
}));

import { repairChapterByQuality } from '@/services/document-workflow/rolePipeline';
import { FINALIZE_REPAIR_ROUNDS, LLM_PATCH_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import { stageLengthCompressionRepair } from '@/services/document-workflow/finalize/repairRounds/lengthCompressionRepair';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const repairMock = vi.mocked(repairChapterByQuality);
const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 章目标 1000 字：容差内形态（1006 字 ≤ 1200） */
const WITHIN_TOLERANCE_CONTENT = ['## 施工部署', '甲'.repeat(1000)].join('\n');
/** 恰在 120% 边界（1200 字 = ceil(1000×1.2)）：不触发压缩 */
const BOUNDARY_CONTENT = ['## 施工部署', '甲'.repeat(1194)].join('\n');
/** 超标形态（1606 字 > 1200；章超额 606 ≥ 200）：触发压缩 */
const OVERFLOW_CONTENT = ['## 施工部署', '甲'.repeat(1600)].join('\n');
/** 压缩落地形态（1006 字，回到容差内） */
const COMPRESSED_CONTENT = ['## 施工部署', '甲'.repeat(1000)].join('\n');
/** 两轮场景中间态（1356 字，仍 > 1200：第二轮继续） */
const PARTIAL_COMPRESSED_CONTENT = ['## 施工部署', '甲'.repeat(1350)].join('\n');
/** 含数值形态（1309 字 > 1200；'425' 为守恒基线数值） */
const NUMERIC_CONTENT = ['## 施工部署', `${'甲'.repeat(1300)}425`].join('\n');
/** 修复后删数值形态（1206 字下降但 '425' 缺失）：触发回滚 */
const NUMERIC_DROPPED_CONTENT = ['## 施工部署', '甲'.repeat(1200)].join('\n');
/** 含标题形态（1316 字 > 1200） */
const HEADING_CONTENT = ['## 施工部署', '### 1.1 工艺', '乙'.repeat(1300)].join('\n');
/** 修复后删标题形态（1206 字下降但 H3 缺失）：触发回滚 */
const HEADING_DROPPED_CONTENT = ['## 施工部署', '乙'.repeat(1200)].join('\n');
/** 含表格形态（1229 字 > 1200，表格 3 行） */
const TABLE_CONTENT = ['## 施工部署', '甲'.repeat(1200), '| 项目 | 状态 |', '| --- | --- |', '| 水泥 | 合格 |'].join('\n');
/** 修复后删表形态（1206 字下降但表格行减少）：触发回滚 */
const TABLE_DROPPED_CONTENT = ['## 施工部署', '甲'.repeat(1200)].join('\n');

interface StageLike { roleId?: string; status?: string; message?: string; details?: string[] }

function stageOf(stages: StageLike[], roleId: string): StageLike | undefined {
  return stages.find(stage => stage.roleId === roleId);
}

function makeSession(chapters: Array<{ id: string; title: string; content: string }>, overrides: Record<string, unknown> = {}) {
  const session = {
    template: {},
    requirement: '',
    bidComposition: undefined,
    signal: undefined,
    generationDiagnostics: { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, lastError: '' } },
    documentBudget: {
      targetChars: 1000,
      chapterTargets: new Map(chapters.map(chapter => [chapter.id, 1000])),
      charsPerPage: 900,
      source: 'explicit',
      mode: 'minimum',
      longformStrict: false,
    },
    finalChapterDrafts: chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: [] })),
    progressStages: [] as StageLike[],
    finalGateRepairStages: [] as StageLike[],
    finalMarkdown: chapters.map(chapter => chapter.content).join('\n\n'),
    emitProgress: vi.fn(),
    withProgressHeartbeat: (fn: () => Promise<unknown>) => fn(),
    recomputeFinalValidationBundle: vi.fn(async () => {}),
    ...overrides,
  } as unknown as FinalizeSession & { finalChapterDrafts: Array<{ content: string }> };
  Object.assign(session, { rebuildFinalMarkdown: vi.fn(() => session.finalChapterDrafts.map(chapter => chapter.content).join('\n\n')) });
  return session;
}

function repairResult(content: string) {
  return { content, appliedCount: 1, producedCount: 1, repairType: 'quality' as never };
}

describe('length-compression-repair 接线（防「修复器存在但未接线」回归）', () => {
  it('注册表双登记：FINALIZE 位于 toc-consistency 之后、fact-distribution-round 之前 + LLM_PATCH 锚定 document-budget', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const index = rounds.indexOf('length-compression-repair');
    expect(index).toBeGreaterThan(-1);
    expect(rounds.indexOf('toc-consistency')).toBeLessThan(index);
    expect(rounds.indexOf('fact-distribution-round')).toBeGreaterThan(index);
    const llmRound = LLM_PATCH_REPAIR_ROUNDS.find(entry => entry.id === 'length-compression-repair');
    expect(llmRound?.kind).toBe('llm-patch');
    expect(llmRound?.anchoredTo).toBe('document-budget');
  });

  it('documentPipeline.ts 在 post-review-surface 之后、fact-distribution 之前调用', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const postReviewIndex = source.indexOf('await stagePostReviewSurface(session);');
    const compressionIndex = source.indexOf('await stageLengthCompressionRepair(session);');
    const distributionIndex = source.indexOf('await stageFactDistribution(session);');
    expect(postReviewIndex).toBeGreaterThan(-1);
    expect(compressionIndex).toBeGreaterThan(postReviewIndex);
    expect(distributionIndex).toBeGreaterThan(compressionIndex);
  });
});

describe('length-compression-repair 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('容差内（含 120% 边界恰在线内）：零成本通过，不进修复轮', async () => {
    const withinTolerance = makeSession([{ id: 'ch1', title: '施工部署', content: WITHIN_TOLERANCE_CONTENT }]);
    await stageLengthCompressionRepair(withinTolerance);
    expect(repairMock).not.toHaveBeenCalled();
    expect(stageOf(withinTolerance.progressStages, 'length-compression-repair')?.status).toBe('success');
    expect(stageOf(withinTolerance.progressStages, 'length-compression-repair')?.message).toContain('容差内');
    const boundary = makeSession([{ id: 'ch1', title: '施工部署', content: BOUNDARY_CONTENT }]);
    await stageLengthCompressionRepair(boundary);
    expect(repairMock).not.toHaveBeenCalled();
    expect(stageOf(boundary.progressStages, 'length-compression-repair')?.message).toContain('容差内');
  });

  it('超标 + 压缩落地：章级定位、instruction 带目标区间、rebuild+recompute、回到容差内', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工部署', content: OVERFLOW_CONTENT }]);
    repairMock.mockResolvedValueOnce(repairResult(COMPRESSED_CONTENT));
    await stageLengthCompressionRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const call = repairMock.mock.calls[0][0];
    expect(call.chapter.id).toBe('ch1');
    expect(call.promptTexts).toContain('成稿篇幅压缩修复');
    expect(call.promptTexts).toContain('压缩上限约 1100 字');
    expect(call.promptTexts).toContain('严禁删除独有信息');
    expect(call.issues[0]).toContain('篇幅超出目标');
    expect(session.finalChapterDrafts[0].content).toBe(COMPRESSED_CONTENT);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-length-compression-ch1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('篇幅压缩修复完成');
    expect(stageOf(session.finalGateRepairStages, 'agent-length-compression-ch1')?.status).toBe('success');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('回到目标容差内');
  });

  it('两轮收敛：第一轮未回容差继续、第二轮回到容差（第二轮 instruction 带轮次提示）', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工部署', content: OVERFLOW_CONTENT }]);
    repairMock
      .mockResolvedValueOnce(repairResult(PARTIAL_COMPRESSED_CONTENT))
      .mockResolvedValueOnce(repairResult(COMPRESSED_CONTENT));
    await stageLengthCompressionRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(2);
    expect(repairMock.mock.calls[1][0].promptTexts).toContain('上一轮压缩后全文仍超出目标');
    expect(session.finalChapterDrafts[0].content).toBe(COMPRESSED_CONTENT);
    const stage = stageOf(session.progressStages, 'agent-length-compression-ch1');
    expect(stage?.status).toBe('success');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('回到目标容差内');
  });

  it('信息守恒守卫·数值缺失：字数下降但数值 token 缺失即回滚（保留修复前正文）', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工部署', content: NUMERIC_CONTENT }]);
    repairMock.mockResolvedValueOnce(repairResult(NUMERIC_DROPPED_CONTENT));
    await stageLengthCompressionRepair(session);
    expect(session.finalChapterDrafts[0].content).toBe(NUMERIC_CONTENT);
    const stage = stageOf(session.progressStages, 'agent-length-compression-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
    expect(session.generationDiagnostics.llm.patchGuardStats?.['length-compression-repair']?.rollbacks).toBe(1);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
  });

  it('信息守恒守卫·标题缺失 / 表格行减少：任一违反即回滚', async () => {
    const headingSession = makeSession([{ id: 'ch1', title: '施工部署', content: HEADING_CONTENT }]);
    repairMock.mockResolvedValueOnce(repairResult(HEADING_DROPPED_CONTENT));
    await stageLengthCompressionRepair(headingSession);
    expect(headingSession.finalChapterDrafts[0].content).toBe(HEADING_CONTENT);
    expect(stageOf(headingSession.progressStages, 'agent-length-compression-ch1')?.message).toContain('已回滚');
    const tableSession = makeSession([{ id: 'ch1', title: '施工部署', content: TABLE_CONTENT }]);
    repairMock.mockResolvedValueOnce(repairResult(TABLE_DROPPED_CONTENT));
    await stageLengthCompressionRepair(tableSession);
    expect(tableSession.finalChapterDrafts[0].content).toBe(TABLE_CONTENT);
    expect(stageOf(tableSession.progressStages, 'agent-length-compression-ch1')?.message).toContain('已回滚');
  });

  it('模型未产生有效修改：显性「未生效」记录，不改正文', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工部署', content: OVERFLOW_CONTENT }]);
    repairMock.mockResolvedValueOnce(repairResult(OVERFLOW_CONTENT));
    await stageLengthCompressionRepair(session);
    expect(session.finalChapterDrafts[0].content).toBe(OVERFLOW_CONTENT);
    const stage = stageOf(session.progressStages, 'agent-length-compression-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('未生效');
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
    expect(session.generationDiagnostics.llm.lastInfo).toContain('残留');
  });

  it('章级定位：仅正超额章（超额 ≥200 字）进修复，容差内章不受影响', async () => {
    const session = makeSession([
      { id: 'ch1', title: '施工部署', content: WITHIN_TOLERANCE_CONTENT },
      { id: 'ch2', title: '资源配置', content: OVERFLOW_CONTENT },
    ]);
    repairMock.mockResolvedValueOnce(repairResult(COMPRESSED_CONTENT));
    await stageLengthCompressionRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(repairMock.mock.calls[0][0].chapter.id).toBe('ch2');
    expect(session.finalChapterDrafts[0].content).toBe(WITHIN_TOLERANCE_CONTENT);
    expect(session.finalChapterDrafts[1].content).toBe(COMPRESSED_CONTENT);
  });
});
