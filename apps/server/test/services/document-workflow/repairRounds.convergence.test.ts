/**
 * V5 P4c 收敛修复边界矩阵（C2/C3 修复轮）：
 * stageNumericVerification——单轮失败即放弃 → ≤2 轮收敛：残留数下降才继续下一轮、
 * 清零即通过、不降即停、修复变差回滚保留原文、全合法零修复且不进修复轮（通过事件双写 parity）；
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
import { auditGapClosureHints, selfDeclaredClosedTotalTokens, stageNumericVerification } from '@/services/document-workflow/finalize/repairRounds/numericVerification';
import { stageRequirementVerification } from '@/services/document-workflow/finalize/repairRounds/requirementVerification';
import type { AuthorityAuditReport } from '@/services/document-workflow/authorityAudit';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';
import type { NamedAuthorityValue } from '@/services/document-workflow/factReconciliation';
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

/** repairChapterByQuality mock 返回体（收敛修复轮共用形态） */
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
    const { session, progressStages, finalGateRepairStages } = makeSession([{ id: 'ch1', title: '工程概况', content: '最大管径DN300，养护龄期7d。' }]);
    await stageNumericVerification(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(progressStages, 'numeric-verification');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('核对通过');
    // 4.36.2 双写 parity：核对通过事件必须同入 finalGateRepairStages
    // （finalStages=executionStages 快照(早于修复轮)+finalGateRepairStages，单写事件在持久化 executionStages 中不可见）
    expect(stageOf(finalGateRepairStages, 'numeric-verification')?.status).toBe('success');
  });
});

/** 4.55.34 A：审计↔修复轮两链判据单源（自称合计闭包豁免 / 覆盖缺口候选提示）。
 * 实机归因：审计已收编的合法自算合计被本修复轮当「疑似无来源」删除（既与 G 线 P2-2 冲突又丢信息），
 * 而覆盖缺口（值恰为具名分项之和）在指令里只是裸 token，可选动作只剩删除。 */
describe('repairRounds.convergence · 4.55.34 A 两链判据单源（合计闭包豁免 / 缺口候选提示）', () => {
  /** 最小蓝图 fixture（结构同 batch1 的 citationBlueprintOf：仅 quantities 参与具名值池与权威核） */
  function blueprintOf(quantities: Record<string, { value: number; unit: string }>): BlueprintData {
    return {
      redLineFacts: [],
      resources: { labor: { peakValue: 0 } },
      contract: { totalDays: 0 },
      project: { scope: '' },
      quantities,
    } as unknown as BlueprintData;
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('自称合计闭包单源豁免：句内「总量6403.78m²」＝具名分项之和 → 不进修复轮（审计所检=修复轮所见）', async () => {
    const named: NamedAuthorityValue[] = [
      { name: '墙面涂膜防水', value: 5764.81, unit: 'm2' },
      { name: '天棚涂膜防水', value: 638.97, unit: 'm2' },
    ];
    const closed = selfDeclaredClosedTotalTokens('防水工程按施工段划分检验批并做蓄水（淋水）试验（总量6403.78m²）', ['6403.78m²'], named);
    expect([...closed]).toEqual(['6403.78m²']);
    // 未自称合计（分项值列举）→ 不收编（与审计 totalClaimClosure 同判据，不得比审计更宽）
    expect([...selfDeclaredClosedTotalTokens('覆盖复合管350.6m、塑料管424.2m', ['424.2m'], named)]).toEqual([]);
    // 名称锚定超出合计闭包窗口（±40 字）→ 不闭合（窗口口径与审计同宽）
    const far = '本次防水工程依据设计图纸及相关规范要求组织施工并按检验批划分完成蓄水试验，累计验收总量6403.78m²';
    expect([...selfDeclaredClosedTotalTokens(far, ['6403.78m²'], named)]).toEqual([]);

    const { session, progressStages } = makeSession(
      [{ id: 'ch1', title: '防水工程', content: '防水工程按施工段划分检验批并做蓄水（淋水）试验（总量6403.78m²）。' }],
      { input: { blueprintData: blueprintOf({ 墙面涂膜防水: { value: 5764.81, unit: 'm2' }, 天棚涂膜防水: { value: 638.97, unit: 'm2' } }) }, blueprintData: blueprintOf({ 墙面涂膜防水: { value: 5764.81, unit: 'm2' }, 天棚涂膜防水: { value: 638.97, unit: 'm2' } }) },
    );
    await stageNumericVerification(session);
    expect(repairMock).not.toHaveBeenCalled();
    expect(stageOf(progressStages, 'numeric-verification')?.message).toContain('核对通过');
  });

  it('缺口候选进指令：424.2m＝复合管350.6m＋塑料管73.6m → 指令给非破坏性还原动作且明示不得删除', async () => {
    const quantities = { 复合管: { value: 350.6, unit: 'm' }, 塑料管: { value: 73.6, unit: 'm' } };
    const content = '作业对象为1#厂房室内给水系统，覆盖复合管350.6m、塑料管424.2m。';
    const auditReport = {
      derivationGaps: [{ token: '424.2m', value: '424.2', context: '覆盖复合管350.6m、塑料管424.2m', occurrences: 1, closureCandidates: ['复合管 350.6m', '塑料管 73.6m'] }],
      processGaps: [],
      unattributed: [],
    } as unknown as AuthorityAuditReport;
    const { session, progressStages } = makeSession([{ id: 'ch1', title: '给水系统', content }], {
      input: { blueprintData: blueprintOf(quantities) },
      blueprintData: blueprintOf(quantities),
      authorityAuditReport: auditReport,
    });
    repairMock.mockResolvedValueOnce(repairResult('作业对象为1#厂房室内给水系统，给水管道按分项计量。'));
    await stageNumericVerification(session);
    const instruction = String(repairMock.mock.calls[0][0].promptTexts);
    expect(instruction).toContain('具名分项和候选');
    expect(instruction).toContain('复合管 350.6m + 塑料管 73.6m ＝ 424.2m');
    expect(instruction).toContain('不得删除');
    // 还原动作（第 3 条）在删除动作（第 4 条）之前：合法自算合计优先走非破坏性收敛
    expect(instruction.indexOf('按分项显式还原')).toBeLessThan(instruction.indexOf('必须删除该数值'));
    expect(stageOf(progressStages, 'agent-numeric-verification-ch1')?.message).toContain('残留轨迹 1→0');
  });

  it('无候选时不追加候选条与候选行（指令与历史逐字一致，不给 LLM 新的改写自由度）', async () => {
    const { session } = makeSession([{ id: 'ch1', title: '施工组织', content: '本工程配置发电机75kW。' }]);
    repairMock.mockResolvedValueOnce(repairResult('本工程按计划配置发电机。'));
    await stageNumericVerification(session);
    const instruction = String(repairMock.mock.calls[0][0].promptTexts);
    expect(instruction).not.toContain('具名分项和候选');
    expect(instruction).toContain('3. 其余情况必须删除该数值');
  });

  it('候选提示映射：审计缺口 token → 「分项 + 分项 ＝ 值」；无候选/无报告不给提示', () => {
    const report = {
      derivationGaps: [
        { token: '424.2 m', closureCandidates: ['复合管 350.6m', '塑料管 73.6m'] },
        { token: '773.8m', closureCandidates: [] },
      ],
      processGaps: [{ token: '0.529t', closureCandidates: ['钢筋 0.4t', '型钢 0.129t'] }],
      unattributed: [{ token: '2.4m', closureCandidates: ['甲 1.5m', '乙 0.9m'] }],
    } as unknown as AuthorityAuditReport;
    const hints = auditGapClosureHints(report);
    // token 去空白归一（与提取器 normToken 同口径）
    expect(hints.get('424.2m')).toBe('复合管 350.6m + 塑料管 73.6m ＝ 424.2m');
    expect(hints.get('0.529t')).toBe('钢筋 0.4t + 型钢 0.129t ＝ 0.529t');
    expect(hints.has('773.8m')).toBe(false);
    // 未登记（疑似编造红线）不是缺口候选的来源：不得为红线值提供「可闭合」台阶
    expect(hints.has('2.4m')).toBe(false);
    expect(auditGapClosureHints(undefined).size).toBe(0);
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
