/**
 * V5 P4c 收敛修复边界矩阵（C2/C3 修复轮）：
 * stageNumericVerification——单轮失败即放弃 → ≤2 轮收敛：残留数下降才继续下一轮、
 * 清零即通过、不降即停、修复变差回滚保留原文、全合法零修复且不进修复轮；
 * stageRequirementVerification——修复落地后复验、复验通过即闭环、复验残留下降才进第 2 轮、
 * 未落地（空修复/回滚）不追加复验直接转 warning、达 2 轮上限停止且末次复验残留转 warning。
 * LLM 与 repairChapterByQuality 全 mock（确定性判定，无网络依赖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/llmClient', () => ({ callDocumentLlmJson: vi.fn() }));
vi.mock('@/services/document-workflow/rolePipeline', () => ({
  repairChapterByQuality: vi.fn(),
  repairPatchGuard: vi.fn(() => undefined),
}));

import { callDocumentLlmJson } from '@/services/document-workflow/llmClient';
import { repairChapterByQuality } from '@/services/document-workflow/rolePipeline';
import { stageNumericVerification } from '@/services/document-workflow/finalize/repairRounds/numericVerification';
import { stageRequirementVerification } from '@/services/document-workflow/finalize/repairRounds/requirementVerification';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const llmMock = vi.mocked(callDocumentLlmJson);
const repairMock = vi.mocked(repairChapterByQuality);

interface StageLike { roleId?: string; status?: string; message?: string; details?: string[] }

function stageOf(stages: StageLike[], roleId: string): StageLike | undefined {
  return stages.find(stage => stage.roleId === roleId);
}

/** 精简 FinalizeSession fixture：证据仅含合法 token（DN300 / 7d）供数值权威库；
 * 疑似句 fixture 使用 75kW / HRB400（正则实证可解析的 token 形态）。 */
function makeSession(chapters: Array<{ id: string; title: string; content: string }>, overrides: Record<string, unknown> = {}) {
  const progressStages: StageLike[] = [];
  const finalGateRepairStages: StageLike[] = [];
  const session = {
    template: {},
    requirement: '',
    generationDiagnostics: { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, lastError: '' } },
    finalChapterDrafts: chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: [] })),
    progressStages,
    finalGateRepairStages,
    allEvidence: [{ content: '合同工期240日历天，最大管径DN300，养护龄期7d。' }],
    input: {},
    structuredFacts: [],
    emitProgress: vi.fn(),
    withProgressHeartbeat: (fn: () => Promise<unknown>) => fn(),
    rebuildFinalMarkdown: vi.fn(() => ''),
    recomputeFinalValidationBundle: vi.fn(async () => {}),
    ...overrides,
  };
  return { session: session as unknown as FinalizeSession, progressStages, finalGateRepairStages };
}

/** repairChapterByQuality mock 返回体（与 fullDimensionReview 测试同形） */
function repairResult(content: string) {
  return { content, appliedCount: 1, producedCount: 1, repairType: 'quality' as never };
}

describe('repairRounds.convergence · C2 数值核对收敛修复', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('残留下降才继续：2→1→0 两轮修复后闭环通过', async () => {
    const { session, progressStages, finalGateRepairStages } = makeSession([{ id: 'ch1', title: '施工组织', content: '本工程配置发电机75kW。钢筋采用HRB400。' }]);
    repairMock
      .mockResolvedValueOnce(repairResult('本工程配置发电机75kW。'))
      .mockResolvedValueOnce(repairResult('本工程按计划配置发电机。'));
    await stageNumericVerification(session);
    expect(repairMock).toHaveBeenCalledTimes(2);
    expect(repairMock.mock.calls[1][0].promptTexts).toContain('第 2 轮');
    expect(session.finalChapterDrafts[0].content).toBe('本工程按计划配置发电机。');
    const stage = stageOf(progressStages, 'agent-numeric-verification-ch1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('修复完成');
    expect(stage?.message).toContain('残留轨迹 2→1→0');
    // 多轮 running/completed stage 按 roleId 原位替换，不堆叠
    expect(progressStages.filter(item => item.roleId === 'agent-numeric-verification-ch1')).toHaveLength(1);
    expect(stageOf(finalGateRepairStages, 'agent-numeric-verification-ch1')?.status).toBe('success');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('每章最多 2 轮收敛修复');
  });

  it('残留未下降即停止：2→2 不追加第二轮，残留转 warning', async () => {
    const { session, progressStages } = makeSession([{ id: 'ch1', title: '施工组织', content: '本工程配置发电机75kW。钢筋采用HRB400。' }]);
    repairMock.mockResolvedValueOnce(repairResult('本工程配置发电机75kW。现场另配钢筋HRB400。'));
    await stageNumericVerification(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const stage = stageOf(progressStages, 'agent-numeric-verification-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('部分生效');
    expect(stage?.message).toContain('残留轨迹 2→2');
    expect(stage?.message).toContain('warning');
  });

  it('修复变差回滚：保留修复前正文，不再追加轮次', async () => {
    const original = '本工程配置发电机75kW。';
    const { session, progressStages } = makeSession([{ id: 'ch1', title: '施工组织', content: original }]);
    repairMock.mockResolvedValueOnce(repairResult('本工程配置发电机75kW。钢筋采用HRB400。最大管径DN300。'));
    await stageNumericVerification(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(session.finalChapterDrafts[0].content).toBe(original);
    const stage = stageOf(progressStages, 'agent-numeric-verification-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('全部数值均有来源：零修复且不进入修复轮', async () => {
    const { session, progressStages } = makeSession([{ id: 'ch1', title: '工程概况', content: '最大管径DN300，养护龄期7d。' }]);
    await stageNumericVerification(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(progressStages, 'numeric-verification');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('核对通过');
  });
});

describe('repairRounds.convergence · C3 用户要求核验收敛修复', () => {
  const requirementPlan = { parsed: true, globalRequirements: ['工期横道图展示'], chapterRequirements: [], styleRequirements: [] };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('修复落地后复验通过：核验闭环通过', async () => {
    llmMock
      .mockResolvedValueOnce({ satisfied: false, unmet: ['工期横道图展示'] })
      .mockResolvedValueOnce({ satisfied: true });
    repairMock.mockResolvedValueOnce(repairResult('本章按工期横道图展示安排施工。'));
    const { session, progressStages, finalGateRepairStages } = makeSession([{ id: 'ch1', title: '施工部署', content: '本章介绍施工组织安排。' }], { requirementSemantics: requirementPlan });
    await stageRequirementVerification(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(llmMock).toHaveBeenCalledTimes(2);
    const stage = stageOf(progressStages, 'agent-requirement-verification-ch1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('核验闭环通过');
    expect(stageOf(finalGateRepairStages, 'agent-requirement-verification-ch1')?.status).toBe('success');
  });

  it('复验残留下降才进第 2 轮：达轮次上限停止且末次复验残留转 warning', async () => {
    llmMock
      .mockResolvedValueOnce({ satisfied: false, unmet: ['工期横道图展示', '安全文明措施齐全'] })
      .mockResolvedValueOnce({ satisfied: false, unmet: ['安全文明措施齐全'] });
    repairMock
      .mockResolvedValueOnce(repairResult('本章按工期横道图展示安排施工。'))
      .mockResolvedValueOnce(repairResult('本章按工期横道图展示安排施工，并落实安全文明措施齐全要求。'));
    const { session, progressStages } = makeSession([{ id: 'ch1', title: '施工部署', content: '本章介绍施工组织安排。' }], { requirementSemantics: requirementPlan });
    await stageRequirementVerification(session);
    expect(repairMock).toHaveBeenCalledTimes(2);
    expect(repairMock.mock.calls[1][0].promptTexts).toContain('第 2 轮');
    // 第 2 轮落地后不再追加复验调用（≤2 轮硬上限）
    expect(llmMock).toHaveBeenCalledTimes(2);
    const stage = stageOf(progressStages, 'agent-requirement-verification-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('达最多 2 轮上限');
    expect(stage?.details?.some(line => line.includes('残留未落实 1 条'))).toBe(true);
    expect(session.generationDiagnostics.llm.lastInfo).toContain('每章最多 2 轮收敛修复');
  });

  it('补写未落地（内容未变）：不追加复验，直接转 warning', async () => {
    llmMock.mockResolvedValueOnce({ satisfied: false, unmet: ['工期横道图展示'] });
    repairMock.mockResolvedValueOnce(repairResult('本章介绍施工组织安排。'));
    const { session, progressStages } = makeSession([{ id: 'ch1', title: '施工部署', content: '本章介绍施工组织安排。' }], { requirementSemantics: requirementPlan });
    await stageRequirementVerification(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(llmMock).toHaveBeenCalledTimes(1);
    const stage = stageOf(progressStages, 'agent-requirement-verification-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('补写未生效');
  });

  it('补写变差回滚：保留修复前正文，不追加复验', async () => {
    const original = '本章已包含工期横道图展示要求。';
    llmMock.mockResolvedValueOnce({ satisfied: false, unmet: ['工期横道图展示'] });
    repairMock.mockResolvedValueOnce(repairResult('本章介绍施工组织安排。'));
    const { session, progressStages } = makeSession([{ id: 'ch1', title: '施工部署', content: original }], { requirementSemantics: requirementPlan });
    await stageRequirementVerification(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(session.finalChapterDrafts[0].content).toBe(original);
    const stage = stageOf(progressStages, 'agent-requirement-verification-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });
});
