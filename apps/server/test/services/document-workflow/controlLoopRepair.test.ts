/**
 * repairRounds · 评审关注闭环链补写轮（control-loop-repair，D-T2 / B8 前半根治）：
 * r28f 实机归因——质量三检/进度纠偏/工资代发链 warning 无修复轮消费直坠终稿残留，
 * 且旧判定按 title+sections 宽 pattern 逐章命中（机械设备计划章被误判为进度链载体）。
 * 本测试锁定：
 * 1. 接线：FINALIZE_REPAIR_ROUNDS 声明 + documentPipeline 调用位置（content-depth-repair
 *    与 post-review-surface 之间，由 repairRounds.order.test.ts 执行序列断言共同保证）；
 * 2. 单源契约：controlLoopChainScan 检测/修复/复检同判定（主责章全要素 + 误报族不命中）；
 * 3. 行为矩阵：无 warning 零成本通过 / 定向补写落地（复检清零 + rebuild + recompute）/
 *    残差下降续轮（每章最多 2 轮）/ 变差回滚 / 删除式修复回滚（汉字守卫）/ 未生效 /
 *    快照过期跳过 / 多主责章并行；
 * repairChapterByQuality 全 mock（复检为确定性扫描，无 LLM 网络依赖）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/rolePipeline', () => ({
  repairChapterByQuality: vi.fn(),
  repairPatchGuard: vi.fn(() => undefined),
}));

import { repairChapterByQuality } from '@/services/document-workflow/rolePipeline';
import { FINALIZE_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import { stageControlLoopRepair } from '@/services/document-workflow/finalize/repairRounds/controlLoopRepair';
import { constructionOrgControlLoopIssues, controlLoopChainScan } from '@/services/document-workflow/constructionOrgQualityRules';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const repairMock = vi.mocked(repairChapterByQuality);
const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

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
    finalChapterDrafts: chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: [] })),
    progressStages: [] as StageLike[],
    finalGateRepairStages: [] as StageLike[],
    finalMarkdown: chapters.map(chapter => `## ${chapter.title}\n${chapter.content}`).join('\n\n'),
    emitProgress: vi.fn(),
    withProgressHeartbeat: (fn: () => Promise<unknown>) => fn(),
    recomputeFinalValidationBundle: vi.fn(async () => {}),
    validationIssues: [] as unknown[],
    ...overrides,
  } as unknown as FinalizeSession & { finalChapterDrafts: Array<{ content: string }> };
  Object.assign(session, { rebuildFinalMarkdown: vi.fn(() => session.finalChapterDrafts.map(chapter => chapter.content).join('\n\n')) });
  return session;
}

function repairResult(content: string) {
  return { content, appliedCount: 1, producedCount: 1, repairType: 'quality' as never };
}

/** 检测端同源产出的 warning 集（修复轮消费的真实契约） */
function issuesOf(chapters: Array<{ id: string; title: string; content: string }>) {
  return constructionOrgControlLoopIssues(chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: [] })));
}

// ── fixture：三链全要素成链（主责章判定为词面 includes，与检测端同源）──
const QUALITY_FULL = '严格执行自检、互检、交接检三检制度，发现问题及时整改，复查合格后方可进入下道工序，检查记录同步归档。';
const SCHEDULE_FULL = '按总进度计划分解至周计划，每周检查进度执行情况，识别偏差后及时纠偏，节点完成经复核确认。';
const WAGE_FULL = '劳务人员全部实名登记，逐日考勤记录，按月核算工资，公示无异议后由银行代发，台账归档备查。';

describe('control-loop-repair 接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE_REPAIR_ROUNDS 声明含 control-loop-repair，位于 content-depth-repair 与 post-review-surface 之间', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const index = rounds.indexOf('control-loop-repair');
    expect(index).toBeGreaterThan(-1);
    expect(rounds.indexOf('content-depth-repair')).toBeLessThan(index);
    expect(rounds.indexOf('post-review-surface')).toBeGreaterThan(index);
  });

  it('documentPipeline 在 content-depth-repair 与 post-review-surface 之间调用 stageControlLoopRepair', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const callIndex = source.indexOf('await stageControlLoopRepair(session);');
    expect(callIndex).toBeGreaterThan(-1);
    expect(source.indexOf('await stageContentDepthRepair(session);')).toBeLessThan(callIndex);
    expect(source.indexOf('await stagePostReviewSurface(session);')).toBeGreaterThan(callIndex);
  });
});

describe('controlLoopChainScan 单源判定（检测=修复=复检契约）', () => {
  it('主责章（首个标题命中）全要素扫描：质量章缺「互检」一条、机械设备计划章不命中进度链（r28f 误报族）', () => {
    const scans = controlLoopChainScan([
      { id: 'ch-q', title: '确保工程质量的技术组织措施', content: '执行自检、交接检制度。', evidence: [], missingFacts: [], sections: [] },
      { id: 'ch-eq', title: '拟投入的主要施工机械、设备计划', content: '正文', evidence: [], missingFacts: [], sections: [] },
      { id: 'ch-s', title: '确保工期的技术组织措施', content: SCHEDULE_FULL, evidence: [], missingFacts: [], sections: [] },
    ]);
    expect(scans).toHaveLength(1);
    expect(scans[0].chapter.id).toBe('ch-q');
    expect(scans[0].deficit.label).toBe('质量闭环');
    expect(scans[0].deficit.missing).toContain('互检');
    // 进度链主责章已成链不返回；机械设备计划章（含「计划」）非主责章不返回
    expect(scans.some(item => item.chapter.id === 'ch-eq')).toBe(false);
    expect(scans.some(item => item.deficit.label === '进度闭环')).toBe(false);
  });
});

describe('control-loop-repair 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('全链成链：零成本通过（不调修复、写验收记录）', async () => {
    const session = makeSession([{ id: 'ch-q', title: '质量保证措施', content: QUALITY_FULL }]);
    await stageControlLoopRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'control-loop-repair');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('闭环链验收通过');
  });

  it('质量链定向补写落地：复检清零、rebuild+recompute、终态诊断', async () => {
    const chapter = { id: 'ch-q', title: '确保工程质量的技术组织措施', content: '本章执行自检、互检、交接检制度。' };
    const session = makeSession([chapter], { validationIssues: issuesOf([chapter]) });
    repairMock.mockResolvedValueOnce(repairResult(QUALITY_FULL));
    await stageControlLoopRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const call = repairMock.mock.calls[0][0] as unknown as { promptTexts: string; issues: string[] };
    expect(call.promptTexts).toContain('【评审关注闭环链定向补写】');
    expect(call.promptTexts).toContain('整改、复查、归档');
    expect(call.promptTexts).toContain('标准词面');
    expect(call.issues.join('\n')).toContain('质量闭环未成链');
    expect(session.finalChapterDrafts[0].content).toBe(QUALITY_FULL);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-control-loop-repair-ch-q');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('闭环链补写完成');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('评审关注闭环链补写');
  });

  it('残差下降续轮：第 1 轮部分补写（缺 5→3）→ 第 2 轮补齐（每章最多 2 轮）', async () => {
    const chapter = { id: 'ch-q', title: '质量管理措施', content: '本章执行自检。' };
    const session = makeSession([chapter], { validationIssues: issuesOf([chapter]) });
    repairMock.mockResolvedValueOnce(repairResult('本章执行自检、互检、交接检制度。'));
    repairMock.mockResolvedValueOnce(repairResult(QUALITY_FULL));
    await stageControlLoopRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(2);
    expect(session.finalChapterDrafts[0].content).toBe(QUALITY_FULL);
    const stage = stageOf(session.progressStages, 'agent-control-loop-repair-ch-q');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('闭环链补写完成');
  });

  it('变差回滚：修复后缺失要素数上升即回滚保留原文（不调 rebuild）', async () => {
    const chapter = { id: 'ch-q', title: '质量管理措施', content: '本章执行自检、互检、交接检。' };
    const session = makeSession([chapter], { validationIssues: issuesOf([chapter]) });
    repairMock.mockResolvedValueOnce(repairResult('本章执行自检。'));
    await stageControlLoopRepair(session);
    expect(session.finalChapterDrafts[0].content).toBe('本章执行自检、互检、交接检。');
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-control-loop-repair-ch-q');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('删除式修复回滚（汉字守卫）：缺失清零但汉字锐减即回滚保留原文', async () => {
    const base = `质量管理制度：自检、互检、整改、复查、归档全部落实。${'现场各专业工长每日巡检，实测实量数据当日上墙，不合格项闭环处置。'.repeat(8)}`;
    const chapter = { id: 'ch-q', title: '质量管理制度', content: base };
    const session = makeSession([chapter], { validationIssues: issuesOf([chapter]) });
    // 补写轮为增量修复：模型以「删长文换短句」方式补齐交接检（缺失清零但汉字锐减）→ 守卫回滚
    repairMock.mockResolvedValueOnce(repairResult('执行自检、互检、交接检、整改、复查、归档制度。'));
    await stageControlLoopRepair(session);
    expect(session.finalChapterDrafts[0].content).toBe(base);
    const stage = stageOf(session.progressStages, 'agent-control-loop-repair-ch-q');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('未生效：模型未产生有效修改时显性记录（不调 rebuild/recompute）', async () => {
    const chapter = { id: 'ch-q', title: '质量管理措施', content: '本章执行自检。' };
    const session = makeSession([chapter], { validationIssues: issuesOf([chapter]) });
    repairMock.mockResolvedValueOnce(repairResult('本章执行自检。'));
    await stageControlLoopRepair(session);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-control-loop-repair-ch-q');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('未生效');
  });

  it('快照过期跳过：warning 在但正文已达标（实时重算零残差）→ 不调修复、写验收记录', async () => {
    const session = makeSession([{ id: 'ch-q', title: '质量保证措施', content: QUALITY_FULL }], {
      validationIssues: [{
        level: 'warning', severity: 'warning', category: 'control_loop',
        message: '质量保证措施 缺少质量闭环关键链条：交接检',
        chapterId: 'ch-q',
        provenance: { detectorId: 'construction-org-control-loop', fingerprint: 'x' },
      }],
    });
    await stageControlLoopRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'control-loop-repair');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('闭环链验收通过');
  });

  it('多主责章并行：质量链 + 进度链各定位一章，双链全部清零', async () => {
    const qualityChapter = { id: 'ch-q', title: '确保工程质量的技术组织措施', content: '本章执行自检、互检、交接检制度。' };
    const scheduleChapter = { id: 'ch-s', title: '确保工期的技术组织措施', content: '按总进度计划组织施工。' };
    const session = makeSession([qualityChapter, scheduleChapter], { validationIssues: issuesOf([qualityChapter, scheduleChapter]) });
    repairMock.mockResolvedValueOnce(repairResult(QUALITY_FULL));
    repairMock.mockResolvedValueOnce(repairResult(SCHEDULE_FULL));
    await stageControlLoopRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(2);
    expect(session.finalChapterDrafts[0].content).toBe(QUALITY_FULL);
    expect(session.finalChapterDrafts[1].content).toBe(SCHEDULE_FULL);
    expect(stageOf(session.progressStages, 'agent-control-loop-repair-ch-q')?.status).toBe('success');
    expect(stageOf(session.progressStages, 'agent-control-loop-repair-ch-s')?.status).toBe('success');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('2 章不成链定位');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('2 章次落地修复');
  });

  it('工资链主责章（劳动力安排计划）缺要素 → 定向补写消费（三链全覆盖）', async () => {
    const chapter = { id: 'ch-w', title: '劳动力安排计划', content: '劳务人员实名登记，考勤按月汇总。' };
    const session = makeSession([chapter], { validationIssues: issuesOf([chapter]) });
    repairMock.mockResolvedValueOnce(repairResult(WAGE_FULL));
    await stageControlLoopRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const call = repairMock.mock.calls[0][0] as unknown as { promptTexts: string; issues: string[] };
    expect(call.issues.join('\n')).toContain('工资闭环未成链');
    expect(session.finalChapterDrafts[0].content).toBe(WAGE_FULL);
    const stage = stageOf(session.progressStages, 'agent-control-loop-repair-ch-w');
    expect(stage?.status).toBe('success');
  });
});
