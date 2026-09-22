/**
 * repairRounds · 危大工程辨识清单漏项链尾收口轮（dangerous-applicability-repair）：
 * r28j 实机归因（s28i 连续两轮）——正文拆改清运「拆除工程」适用前提真实存在，
 * 而危大辨识叙述区（含「危大」行±6 行）缺别名精确词 → 终检 dangerous-applicability
 * blocker 连续两轮直坠门禁（4.41 删除确定性补写器后修复链无轮消费）。本测试锁定：
 * 1. 接线：FINALIZE_REPAIR_ROUNDS 声明 + LLM_PATCH 声明（anchoredTo/patchGuard）+
 *    postReviewSurface 链尾调用位置（basis-regulations-repair 之后、auto-spec-gate-repair 之前）；
 * 2. 行为矩阵：全文覆盖完好零成本通过 / 章级定位 + LLM 补列落地（复检覆盖清零 + recompute）/
 *    删除式修复回滚（汉字数大幅减少）/ 补列不落危大辨识区（2 轮后部分生效残留显性记录）/
 *    无含危大辨识区章显性记录（不猜测改写）；
 * repairChapterByQuality 全 mock（复检为确定性实现，无 LLM 网络依赖）。
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
import { stageDangerousApplicabilityRepair } from '@/services/document-workflow/finalize/repairRounds/dangerousApplicabilityRepair';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const repairMock = vi.mocked(repairChapterByQuality);
const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 工程概况章：含「拆除工程」适用前提（拆改清运），无危大辨识区（s28i 真实形态来源章）；
 * filler 保持与安全章危大行 >6 行距离（前提句不落入辨识区，全文缺口成立） */
const PREREQ_CHAPTER = [
  '## 工程概况',
  '本工程包含道路破除及拆除工程，拆改清运作业量大，需编制专项施工方案。',
  '施工区域位于城市建成区，交通组织与环境保护要求高。',
  '项目团队按合同约定组织施工并接受建设单位全过程管理。',
  '现场管理执行标准化作业流程并服从监理单位指令。',
  '资源配置按施工进度计划动态调整并留有合理余量。',
  '质量管理实行全过程控制并留存完整过程记录。',
].join('\n');
/** 安全章缺陷版：含危大辨识区（含「危大」行±6）但辨识叙述缺「拆除工程」别名精确词 */
const DEFECTIVE_CHAPTER = [
  '## 确保安全生产的技术组织措施',
  '### 危大工程辨识清单',
  '项目部在开工前对全部施工内容进行危大工程辨识，逐项建立清单并报监理单位审核确认，清单锁定挖基坑土方深度均为5m以内。',
  '施工过程中严格按照专项施工方案组织实施，全面落实安全生产责任制。',
  '施工前对全体作业人员进行安全技术交底并签字确认。',
  '现场设置安全警示标志标牌并定期组织安全检查。',
  '专职安全员对危大作业实施旁站监督并留存影像记录。',
  '发现事故隐患立即整改并实行闭环销项管理。',
].join('\n');
/** 安全章修复版：「拆除工程」补入既有辨识叙述（危大行覆盖区内） */
const REPAIRED_CHAPTER = DEFECTIVE_CHAPTER.replace(
  '清单锁定挖基坑土方深度均为5m以内。',
  '清单锁定挖基坑土方深度均为5m以内；拆除工程按机械拆除方式同步列入危大清单并标注分级。',
);
/** 全文覆盖完好版：辨识叙述区已含「拆除工程」别名（零成本通过形态） */
const COVERED_CHAPTER = [
  '## 确保安全生产的技术组织措施',
  '### 危大工程辨识清单',
  '项目部对危大工程逐项辨识：本工程拆除工程按机械拆除方式列入清单并标注分级。',
].join('\n');

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

describe('dangerous-applicability-repair 链尾接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE_REPAIR_ROUNDS 声明含 dangerous-applicability-repair，且位于 basis-regulations-repair 与 toc-consistency 之间', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const index = rounds.indexOf('dangerous-applicability-repair');
    expect(index).toBeGreaterThan(-1);
    expect(rounds.indexOf('basis-regulations-repair')).toBeLessThan(index);
    expect(rounds.indexOf('toc-consistency')).toBeGreaterThan(index);
  });

  it('LLM_PATCH_REPAIR_ROUNDS 声明锚定 dangerous-applicability 检测器且带 patchGuard（修复定位=检测定位）', () => {
    const round = LLM_PATCH_REPAIR_ROUNDS.find(entry => entry.id === 'dangerous-applicability-repair');
    expect(round).toBeDefined();
    expect(round?.kind).toBe('llm-patch');
    expect(round?.anchoredTo).toBe('dangerous-applicability');
    expect(round?.patchGuard?.detectors.length).toBeGreaterThan(0);
    expect(round?.giveUpOnFailure).toBe(true);
  });

  it('postReviewSurface.ts 在 basis-regulations-repair 之后、auto-spec-gate-repair 之前调用（同族链尾收口）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'finalize/repairRounds/postReviewSurface.ts'), 'utf8');
    const basisIndex = source.indexOf('await stageBasisRegulationsRepair(session);');
    const dangerousIndex = source.indexOf('await stageDangerousApplicabilityRepair(session);');
    const autoSpecIndex = source.indexOf('await stageAutoSpecGateRepair(session);');
    expect(basisIndex).toBeGreaterThan(-1);
    expect(dangerousIndex).toBeGreaterThan(basisIndex);
    expect(autoSpecIndex).toBeGreaterThan(dangerousIndex);
  });
});

describe('dangerous-applicability-repair 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('全文覆盖完好：零成本通过，不进修复轮', async () => {
    const session = makeSession([{ id: 'ch5', title: '确保安全生产的技术组织措施', content: COVERED_CHAPTER }]);
    await stageDangerousApplicabilityRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    expect(session.progressStages).toHaveLength(0);
  });

  it('章级定位漏列章 + LLM 补列落地：遗漏清零、rebuild+recompute 复验、终态清零', async () => {
    const session = makeSession([
      { id: 'ch1', title: '工程概况', content: PREREQ_CHAPTER },
      { id: 'ch6', title: '确保安全生产的技术组织措施', content: DEFECTIVE_CHAPTER },
    ]);
    repairMock.mockResolvedValueOnce(repairResult(REPAIRED_CHAPTER));
    await stageDangerousApplicabilityRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('危大工程辨识清单漏项定向修复');
    expect(repairMock.mock.calls[0][0].promptTexts).toContain('拆除工程');
    expect(session.finalChapterDrafts[1].content).toBe(REPAIRED_CHAPTER);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-dangerous-applicability-repair-ch6');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('修复完成');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('终态残留 0 项缺口');
  });

  it('删除式修复回滚：汉字数大幅减少即回滚保留原文', async () => {
    const filler = Array.from({ length: 10 }, () => '本项目严格按设计图纸与工程量清单组织施工，服从监理单位管理。').join('\n');
    // 「拆除工程」适用前提句与危大辨识区距离 >6 行（区外前提：全文缺口成立且章级缺口存在）
    const original = `${DEFECTIVE_CHAPTER}\n${filler}\n本工程含道路破除及拆除工程，拆改清运作业量大，需编制专项施工方案。`;
    const session = makeSession([{ id: 'ch6', title: '确保安全生产的技术组织措施', content: original }]);
    repairMock.mockResolvedValueOnce(repairResult('## 确保安全生产的技术组织措施\n### 危大工程辨识清单\n危大工程辨识按规范逐项执行。'));
    await stageDangerousApplicabilityRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(session.finalChapterDrafts[0].content).toBe(original);
    const stage = stageOf(session.progressStages, 'agent-dangerous-applicability-repair-ch6');
    // 4.55.27 三档口径：残差有净下降但未清零 = partial（收敛中），failed 专指零净下降/回滚
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('补列不落危大辨识区：复检把住（2 轮后部分生效，残留项显性记录）', async () => {
    const filler = Array.from({ length: 8 }, () => '本项目严格按设计图纸与工程量清单组织施工，服从监理单位管理。').join('\n');
    // 「拆除工程」适用前提句与最近「危大」行距离 >6 行（区外前提；模拟补列句同落区外 → 复检不认可，防改写骗过检测）
    const initialChapter = `${DEFECTIVE_CHAPTER}\n${filler}\n本工程含道路破除及拆除工程，拆改清运作业量大，需编制专项施工方案。`;
    const farChapter = `${initialChapter}\n拆除工程专项管理要求：施工前编制专项施工方案并组织技术交底。`;
    const session = makeSession([{ id: 'ch6', title: '确保安全生产的技术组织措施', content: initialChapter }]);
    repairMock.mockResolvedValue(repairResult(farChapter));
    await stageDangerousApplicabilityRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(2);
    const stage = stageOf(session.progressStages, 'agent-dangerous-applicability-repair-ch6');
    expect(stage?.status).toBe('partial');
    expect(stage?.message).toContain('部分生效');
    expect(stage?.message).toContain('拆除工程');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('终态残留 1 项缺口');
  });

  it('无含危大辨识区章：显性记录交终门禁，不猜测改写', async () => {
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: PREREQ_CHAPTER }]);
    await stageDangerousApplicabilityRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'dangerous-applicability-repair');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('无含危大辨识区的定向修复章');
  });
});
