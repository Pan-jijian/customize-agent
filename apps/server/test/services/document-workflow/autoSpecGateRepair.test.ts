/**
 * repairRounds · 配置必要内容缺失链尾收口轮（auto-spec-gate-repair）：
 * D-T8 实测 r28f 终门禁 7 项术语缺失（国家法律法规/地方法规/项目特征/图纸设计说明/劳动力计划/
 * 主要施工材料/安全文明——词表来自 autoSpecGates 配置不硬编码）此前只有终检 planned-auto-spec-gate
 * 报出「配置要求缺少必要内容」、修复链无轮消费（autoSpecGateRequiredTexts 自落地零消费=哑火通道）。
 * 本测试锁定：
 * 1. 接线：FINALIZE_REPAIR_ROUNDS 声明（basis-regulations-repair 之后、toc-consistency 之前）+
 *    LLM_PATCH_REPAIR_ROUNDS 锚定 planned-auto-spec-gate + postReviewSurface 链尾调用位置
 *    （编制依据法规收口之后、补写静默重放之前）；
 * 2. 行为矩阵：全文覆盖完好零成本通过 / bigram 关联度归属到章 + LLM 补写落地（缺失清零 +
 *    rebuild+recompute + 终态清零）/ 跨章归属互不干扰 / 每轮重定位缺口两轮收敛 / 删除式修复回滚 /
 *    空稿异常无可用目标章显性记录；
 * repairChapterByQuality 全 mock（复检为确定性实现，无 LLM 网络依赖；配置经模块 mock 注入）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/rolePipeline', () => ({
  repairChapterByQuality: vi.fn(),
  repairPatchGuard: vi.fn(() => undefined),
}));

vi.mock('@/services/document-validation/engineeringDocumentConfigService', () => ({
  readEngineeringDocumentConfig: () => ({
    autoSpecGates: [{
      templateMatchers: ['施工组织设计'],
      requiredTexts: ['劳动力计划', '主要施工材料', '安全文明'],
      forbiddenTexts: [],
    }],
  }),
}));

import { repairChapterByQuality } from '@/services/document-workflow/rolePipeline';
import { FINALIZE_REPAIR_ROUNDS, LLM_PATCH_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import { stageAutoSpecGateRepair } from '@/services/document-workflow/finalize/repairRounds/autoSpecGateRepair';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const repairMock = vi.mocked(repairChapterByQuality);
const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');
/** 模板命中配置 matcher（templateMatchesAutoSpecGate 拼接 name/category/outputTitle/description 判定） */
const TEMPLATE = { name: '施工组织设计', category: '技术标', outputTitle: '施组正文', description: '施工组织设计' };

/** 全文覆盖完好版本（三术语逐字出现：零成本通过） */
const COVERED_CONTENT = '## 工程概况\n本工程明确劳动力计划、主要施工材料与安全文明施工要求。';
/** 三术语全缺版本（「劳动」「安全」等片段零出现：bigram 全零归首非空章） */
const DEFECTIVE_CONTENT = '## 工程概况\n本工程为新建给水管道工程，包含管道敷设与沟槽开挖。';
/** 补写落地版本（三术语逐字补入） */
const REPAIRED_CONTENT = '## 工程概况\n本工程为新建给水管道工程，包含管道敷设与沟槽开挖。依据施工图纸与工程量清单编制主要施工材料计划，落实劳动力计划与安全文明施工措施。';

interface StageLike { roleId?: string; status?: string; message?: string; details?: string[] }

function stageOf(stages: StageLike[], roleId: string): StageLike | undefined {
  return stages.find(stage => stage.roleId === roleId);
}

function makeSession(chapters: Array<{ id: string; title: string; content: string }>, overrides: Record<string, unknown> = {}) {
  const session = {
    template: TEMPLATE,
    requirement: '',
    bidComposition: undefined,
    signal: undefined,
    blueprintData: undefined,
    generationDiagnostics: { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, lastError: '' } },
    finalChapterDrafts: chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: [] })),
    progressStages: [] as StageLike[],
    finalGateRepairStages: [] as StageLike[],
    finalMarkdown: chapters.map(chapter => chapter.content).join('\n\n'),
    emitProgress: vi.fn(),
    withProgressHeartbeat: (fn: () => Promise<unknown>) => fn(),
    recomputeFinalValidationBundle: vi.fn(async () => {}),
    ...overrides,
  } as unknown as FinalizeSession & { finalChapterDrafts: Array<{ content: string }> };
  // rebuildFinalMarkdown 与章内容联动（落地后终态对账消费）
  Object.assign(session, { rebuildFinalMarkdown: vi.fn(() => session.finalChapterDrafts.map(chapter => chapter.content).join('\n\n')) });
  return session;
}

function repairResult(content: string) {
  return { content, appliedCount: 1, producedCount: 1, repairType: 'quality' as never };
}

describe('auto-spec-gate-repair 链尾接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE_REPAIR_ROUNDS 声明含 auto-spec-gate-repair（basis 之后、toc-consistency 之前），LLM_PATCH_REPAIR_ROUNDS 锚定 planned-auto-spec-gate', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const index = rounds.indexOf('auto-spec-gate-repair');
    expect(index).toBeGreaterThan(-1);
    expect(rounds.indexOf('basis-regulations-repair')).toBeLessThan(index);
    expect(rounds.indexOf('toc-consistency')).toBeGreaterThan(index);
    const llmRound = LLM_PATCH_REPAIR_ROUNDS.find(entry => entry.id === 'auto-spec-gate-repair');
    expect(llmRound?.anchoredTo).toBe('planned-auto-spec-gate');
    expect((llmRound?.patchGuard?.detectors ?? []).length).toBeGreaterThan(0);
  });

  it('postReviewSurface.ts 在编制依据法规收口之后、补写静默重放之前调用', () => {
    const source = readFileSync(path.join(SRC_DIR, 'finalize/repairRounds/postReviewSurface.ts'), 'utf8');
    const basisIndex = source.indexOf('await stageBasisRegulationsRepair(session);');
    const autoSpecIndex = source.indexOf('await stageAutoSpecGateRepair(session);');
    const replayIndex = source.indexOf('await stageRequirementResponseRepair(session, { silent: true });');
    expect(basisIndex).toBeGreaterThan(-1);
    expect(autoSpecIndex).toBeGreaterThan(basisIndex);
    expect(replayIndex).toBeGreaterThan(autoSpecIndex);
  });
});

describe('auto-spec-gate-repair 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('全文术语覆盖完好：零成本通过，不进修复轮', async () => {
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: COVERED_CONTENT }]);
    await stageAutoSpecGateRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    expect(session.progressStages).toHaveLength(0);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
  });

  it('缺失术语归属首章 + LLM 补写落地：缺失清零、rebuild+recompute、终态清零', async () => {
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: DEFECTIVE_CONTENT }]);
    repairMock.mockResolvedValueOnce(repairResult(REPAIRED_CONTENT));
    await stageAutoSpecGateRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('配置必要内容缺失定向补写');
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('- 劳动力计划');
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('- 主要施工材料');
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('- 安全文明');
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('禁止孤立口号句');
    expect(session.finalChapterDrafts[0].content).toBe(REPAIRED_CONTENT);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-auto-spec-gate-repair-ch1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('补写完成');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('终态残留 0 项');
  });

  it('bigram 关联度归属到章：各章只补写各自缺口，互不干扰', async () => {
    const session = makeSession([
      { id: 'ch1', title: '编制依据', content: '## 编制依据\n本工程依据现行国家标准与设计文件组织施工。' },
      { id: 'ch2', title: '资源配置', content: '## 资源配置\n项目部按进度计划配置劳动力，动态调整班组投入。' },
    ]);
    repairMock.mockImplementation(async (input) => {
      if (input.chapter.id === 'ch2') return repairResult('## 资源配置\n项目部按劳动力计划配置人员与班组，动态调整投入。');
      return repairResult('## 编制依据\n本工程依据现行国家标准与设计文件组织施工，主要施工材料按设计选型并落实安全文明要求。');
    });
    await stageAutoSpecGateRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(2);
    // Map 插入序 = 缺失术语声明序：「劳动力计划」bigram 命中 ch2（劳动/动力/计划）先派发
    expect(repairMock.mock.calls[0][0].chapter.id).toBe('ch2');
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('- 劳动力计划');
    expect(repairMock.mock.calls[1][0].chapter.id).toBe('ch1');
    expect(repairMock.mock.calls[1][0].promptTexts).toContain('- 主要施工材料');
    expect(repairMock.mock.calls[1][0].promptTexts).toContain('- 安全文明');
    expect(repairMock.mock.calls[1][0].promptTexts).not.toContain('- 劳动力计划');
    expect(session.finalChapterDrafts[0].content).toContain('主要施工材料');
    expect(session.finalChapterDrafts[1].content).toContain('劳动力计划');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('终态残留 0 项');
  });

  it('每轮重定位缺口：第一轮部分补写落地后第二轮只带残留术语（两轮收敛）', async () => {
    const original = '## 工程概况\n本工程主要施工材料按设计选型。';
    const first = '## 工程概况\n本工程主要施工材料按设计选型，劳动力计划按进度编报。';
    const second = '## 工程概况\n本工程主要施工材料按设计选型，劳动力计划按进度编报，落实现场安全文明要求。';
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: original }]);
    repairMock.mockResolvedValueOnce(repairResult(first)).mockResolvedValueOnce(repairResult(second));
    await stageAutoSpecGateRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(2);
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('- 劳动力计划');
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('- 安全文明');
    expect(repairMock.mock.calls[1][0].promptTexts).toContain('- 安全文明');
    expect(repairMock.mock.calls[1][0].promptTexts).not.toContain('- 劳动力计划');
    expect(session.finalChapterDrafts[0].content).toBe(second);
    const stage = stageOf(session.progressStages, 'agent-auto-spec-gate-repair-ch1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('2 轮补写');
  });

  it('删除式修复回滚：汉字数大幅减少即回滚保留原文', async () => {
    const filler = '本项目严格按设计图纸与工程量清单组织施工。'.repeat(12);
    const original = `## 工程概况\n本工程为给水管道工程。\n${filler}`;
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: original }]);
    repairMock.mockResolvedValueOnce(repairResult('## 工程概况\n按计划执行。'));
    await stageAutoSpecGateRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(session.finalChapterDrafts[0].content).toBe(original);
    const stage = stageOf(session.progressStages, 'agent-auto-spec-gate-repair-ch1');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
  });

  it('空稿异常：全文报缺失但无可用目标章，显性记录不猜测改写', async () => {
    const session = makeSession([], { finalMarkdown: '## 工程概况\n本工程为给水管道工程。' });
    await stageAutoSpecGateRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'auto-spec-gate-repair');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('无可用目标章');
    expect(stage?.details).toHaveLength(3);
  });
});
