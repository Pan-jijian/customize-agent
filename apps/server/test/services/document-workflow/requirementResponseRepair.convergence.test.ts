/**
 * repairRounds.convergence · 招标要求响应补写轮（requirement-response-repair）：
 * blocker provenance 精确反查（指纹→条目→主责章）→ 按章定向补写（voice 素材+缺口反馈）→
 * 确定性三通道复检收敛：清零即通过、未下降即停（残留交终门禁照常复核，不转 warning）、
 * 变差回滚保留原文、指纹/分配无法定位时显性 failed stage；无 blocker 时通过事件双写 parity。
 * repairChapterByQuality 全 mock（复检为确定性实现，无 LLM 网络依赖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/rolePipeline', () => ({
  repairChapterByQuality: vi.fn(),
  repairPatchGuard: vi.fn(() => undefined),
}));

import { repairChapterByQuality } from '@/services/document-workflow/rolePipeline';
import { stageRequirementResponseRepair } from '@/services/document-workflow/finalize/repairRounds/requirementResponseRepair';
import { stableHash } from '@/services/document-workflow/utils';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const repairMock = vi.mocked(repairChapterByQuality);

interface StageLike { roleId?: string; status?: string; message?: string; details?: string[] }

function stageOf(stages: StageLike[], roleId: string): StageLike | undefined {
  return stages.find(stage => stage.roleId === roleId);
}

/** 条款条目 fixture：原文分句即复检通道（正文含原文全句 = 已响应）；voice 转换对无第三人称条款为恒等 */
const ENTRY_A = { text: '工程质量保修期为两年，保修期内接到通知后24小时内派人到场维修。', coreTerms: ['保修期', '24小时'], sources: [], category: '质量保修', policy: 'respond' };
const ENTRY_B = { text: '项目经理持有注册建造师证书并常驻现场。', coreTerms: ['注册建造师'], sources: [], category: '人员管理', policy: 'respond' };

type EntryLike = typeof ENTRY_A;

/** blocker fixture：与 requirementAcceptanceIssues 落盘口径同源（detectorId + stableHash(entry.text)） */
function blockerOf(entry: EntryLike) {
  return { severity: 'blocker', message: `招标要求未响应：${entry.text}`, provenance: { detectorId: 'requirements-coverage', fingerprint: stableHash(entry.text) } };
}

function makeSession(chapters: Array<{ id: string; title: string; content: string }>, entries: EntryLike[], overrides: Record<string, unknown> = {}) {
  const progressStages: StageLike[] = [];
  const finalGateRepairStages: StageLike[] = [];
  const session = {
    template: {},
    requirement: '',
    bidComposition: undefined,
    signal: undefined,
    generationDiagnostics: { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, lastError: '' } },
    finalChapterDrafts: chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: [] })),
    progressStages,
    finalGateRepairStages,
    validationIssues: [] as unknown[],
    tenderRequirements: { extracted: true, entries, excluded: [], reconciliation: { clauseCount: entries.length, entryCount: entries.length, excludedCount: 0, undecidedCount: 0, mergedCount: 0, batchCount: 1, retriedBatches: 0 } },
    requirementAssignments: entries.map(entry => ({ entry, chapterTitle: chapters[0].title, score: 0.9, lowConfidence: false })),
    emitProgress: vi.fn(),
    withProgressHeartbeat: (fn: () => Promise<unknown>) => fn(),
    rebuildFinalMarkdown: vi.fn(() => ''),
    recomputeFinalValidationBundle: vi.fn(async () => {}),
    ...overrides,
  };
  return { session: session as unknown as FinalizeSession, progressStages, finalGateRepairStages };
}

/** repairChapterByQuality mock 返回体（收敛修复轮共用形态） */
function repairResult(content: string) {
  return { content, appliedCount: 1, producedCount: 1, repairType: 'quality' as never };
}

describe('repairRounds.convergence · 招标要求响应补写轮', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('无 blocker：通过事件双写且不进修复轮', async () => {
    const { session, progressStages, finalGateRepairStages } = makeSession(
      [{ id: 'ch1', title: '质量管理体系与保证措施', content: '本章介绍质量管理安排。' }],
      [ENTRY_A],
      { validationIssues: [{ severity: 'warning', message: '其它提示' }] },
    );
    await stageRequirementResponseRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(progressStages, 'requirement-response-repair');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('验收通过');
    expect(stageOf(finalGateRepairStages, 'requirement-response-repair')?.status).toBe('success');
  });

  it('残留下降才继续：2→1→0 两轮补写后清零通过', async () => {
    const { session, progressStages } = makeSession(
      [{ id: 'ch1', title: '质量管理体系与保证措施', content: '本章介绍质量管理安排。' }],
      [ENTRY_A, ENTRY_B],
      { validationIssues: [blockerOf(ENTRY_A), blockerOf(ENTRY_B)] },
    );
    repairMock
      .mockResolvedValueOnce(repairResult(`本章介绍质量管理安排。${ENTRY_A.text}`))
      .mockResolvedValueOnce(repairResult(`本章介绍质量管理安排。${ENTRY_A.text}${ENTRY_B.text}`));
    await stageRequirementResponseRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(2);
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('招标要求响应定向补写修复');
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('建议口径');
    expect(repairMock.mock.calls[1][0].promptTexts).toContain('第 2 轮');
    const stage = stageOf(progressStages, 'agent-requirement-response-repair-ch1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('补写完成');
    // 补写落地后重算链闭环：finalMarkdown 重建 + 终验 bundle 重算
    expect(session.rebuildFinalMarkdown).toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalled();
    expect(session.generationDiagnostics.llm.lastInfo).toContain('每章最多 2 轮收敛修复');
  });

  it('残留未下降即停：1→1 不追加第二轮，残留交终门禁照常复核（不转 warning）', async () => {
    const { session, progressStages } = makeSession(
      [{ id: 'ch1', title: '质量管理体系与保证措施', content: '本章介绍质量管理安排。' }],
      [ENTRY_A],
      { validationIssues: [blockerOf(ENTRY_A)] },
    );
    repairMock.mockResolvedValueOnce(repairResult('本章介绍质量管理安排，并强调服务响应及时。'));
    await stageRequirementResponseRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const stage = stageOf(progressStages, 'agent-requirement-response-repair-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('部分生效');
    expect(stage?.message).toContain('残留轨迹 1→1');
    expect(stage?.message).toContain('由终门禁照常复核');
  });

  it('补写变差回滚：既有满足项被误删即回滚保留修复前正文', async () => {
    const original = `本章已含承诺：${ENTRY_A.text}`;
    const { session, progressStages } = makeSession(
      [{ id: 'ch1', title: '质量管理体系与保证措施', content: original }],
      [ENTRY_A, ENTRY_B],
      { validationIssues: [blockerOf(ENTRY_A), blockerOf(ENTRY_B)] },
    );
    repairMock.mockResolvedValueOnce(repairResult('本章重新编排质量管理与人员配置。'));
    await stageRequirementResponseRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(session.finalChapterDrafts[0].content).toBe(original);
    const stage = stageOf(progressStages, 'agent-requirement-response-repair-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('指纹无法反查（快照失配）：显性 failed stage，不误写正文', async () => {
    const { session, progressStages } = makeSession(
      [{ id: 'ch1', title: '质量管理体系与保证措施', content: '本章介绍质量管理安排。' }],
      [ENTRY_A],
      { validationIssues: [{ severity: 'blocker', message: '陈旧快照', provenance: { detectorId: 'requirements-coverage', fingerprint: 'sha256:stale' } }] },
    );
    await stageRequirementResponseRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(progressStages, 'requirement-response-repair');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('无法定位责任章');
  });
});
