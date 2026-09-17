/**
 * repairRounds · 内容深度补写轮（content-depth-repair，r8 第二类系统性缺陷根治）：
 * r8 实机终门禁 18 项阻断归因——六类内容深度检测器（critical/emergency-section-depth、
 * construction-org-major-content/division-section、precise-fact-usage、overview-recap）产出
 * blocker 后修复链无轮消费直坠终门禁。本测试锁定：
 * 1. 接线：FINALIZE_REPAIR_ROUNDS 声明 + documentPipeline 调用位置（requirement-verification
 *    与 post-review-surface 之间，由 repairRounds.order.test.ts 的执行序列断言共同保证）；
 * 2. 检测器元数据：critical-section-depth / overview-recap 的 blocker 带 chapterId / provenance
 *    （章级定位锚点，修复轮按 provenance 精确过滤消费）；
 * 3. 行为矩阵：无 blocker 零成本通过 / 章级定位 + 定向补写落地（复检 + rebuild + recompute）/
 *    变差回滚 / 未生效 / 无法定位显性记录；
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
import { FINALIZE_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import { stageContentDepthRepair } from '@/services/document-workflow/finalize/repairRounds/contentDepthRepair';
import { criticalSectionDepthIssues, criticalSectionDeficitTotal } from '@/services/document-workflow/finalize/rebuildAndRecompute';
import { overviewRecapIssues } from '@/services/document-workflow/integrity/detectors/detectors';
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
    factsModel: { preciseFacts: [] },
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

// ── overview-recap 场景 fixture（概况章 + 跨章复述句）──
const OVERVIEW_BODY = '本项目位于XX县，建设内容包括道路工程、排水工程、照明工程等项目，计划工期100日历天。';
const RECAP_SENTENCE = '本项目为XX县乡村振兴基础设施建设项目，建设内容包括道路工程、排水工程、照明工程等项目。';
const RECAP_CHAPTER_CONTENT = `本节说明施工总体安排。\n${RECAP_SENTENCE}`;
const RECAP_MARKDOWN = `## 工程概况\n${OVERVIEW_BODY}\n\n## 施工部署\n${RECAP_CHAPTER_CONTENT}`;

// ── critical-section-depth 场景 fixture（危大工程审批小节 < 250 字阻断线）──
const CRITICAL_SHORT = '### 危大工程专项施工方案审批流程\n本工程危大工程按程序报审后实施。';
/** 部分补写形态（r16c 实机 1191→1749 字缩影）：残差下降但未过 250 字阻断线，聚合 blocker 条数不变 */
const CRITICAL_PARTIAL = '### 危大工程专项施工方案审批流程\n危大工程范围包括基坑支护与降水工程、土方开挖工程、模板工程、起重吊装工程及脚手架工程，专项方案经施工单位技术负责人审批后报监理审查。';
const CRITICAL_LONG = `### 危大工程专项施工方案审批流程\n${'危大工程范围包括基坑支护与降水工程、土方开挖工程、模板工程、起重吊装工程及脚手架工程，专项方案经施工单位技术负责人审批后报监理审查，超过一定规模的须组织专家论证。'.repeat(6)}`;

describe('content-depth-repair 接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE_REPAIR_ROUNDS 声明含 content-depth-repair，位于 requirement-verification 与 post-review-surface 之间', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const index = rounds.indexOf('content-depth-repair');
    expect(index).toBeGreaterThan(-1);
    expect(rounds.indexOf('requirement-verification')).toBeLessThan(index);
    expect(rounds.indexOf('post-review-surface')).toBeGreaterThan(index);
  });

  it('documentPipeline 在 requirement-verification 与 post-review-surface 之间调用 stageContentDepthRepair', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const callIndex = source.indexOf('await stageContentDepthRepair(session);');
    expect(callIndex).toBeGreaterThan(-1);
    expect(source.indexOf('await stageRequirementVerification(session);')).toBeLessThan(callIndex);
    expect(source.indexOf('await stagePostReviewSurface(session);')).toBeGreaterThan(callIndex);
  });
});

describe('内容深度类检测器 metadata（修复轮定位锚点契约）', () => {
  it('critical-section-depth blocker 带 chapterId / sectionTitle / provenance（r8 #18 归因锚点）', () => {
    const issues = criticalSectionDepthIssues([{ id: 'ch-9', title: '施工组织设计', content: CRITICAL_SHORT, evidence: [], missingFacts: [], sections: [] }]);
    const blocker = issues.find(issue => issue.severity === 'blocker');
    expect(blocker).toBeDefined();
    expect(blocker!.chapterId).toBe('ch-9');
    expect(blocker!.sectionTitle).toBe('危大工程专项施工方案审批流程');
    expect(blocker!.provenance?.detectorId).toBe('critical-section-depth');
  });

  it('overview-recap blocker 带 provenance（复述句定位由修复轮按候选重算反查）', () => {
    const issues = overviewRecapIssues(RECAP_MARKDOWN);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('blocker');
    expect(issues[0]!.provenance?.detectorId).toBe('overview-recap');
  });
});

describe('content-depth-repair 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('无深度类 blocker：零成本通过（不调修复、写通过记录）', async () => {
    const session = makeSession([{ id: 'ch1', title: '工程概况', content: '本项目位于XX县。' }]);
    await stageContentDepthRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'content-depth-repair');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('内容深度验收通过');
  });

  it('critical-section-depth 章级定位 + 定向补写落地：复检清零、rebuild+recompute、终态诊断', async () => {
    const chapter = { id: 'ch-1', title: '施工组织设计', content: CRITICAL_SHORT };
    const blockers = criticalSectionDepthIssues([{ ...chapter, evidence: [], missingFacts: [], sections: [] }]);
    const session = makeSession([chapter], { validationIssues: blockers });
    repairMock.mockResolvedValueOnce(repairResult(CRITICAL_LONG));
    await stageContentDepthRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const call = repairMock.mock.calls[0][0] as unknown as { promptTexts: string; issues: string[] };
    expect(call.promptTexts).toContain('内容深度定向补写修复');
    expect(call.promptTexts).toContain('危大工程专项施工方案审批流程');
    expect(call.issues.join('\n')).toContain('正文不足');
    expect(session.finalChapterDrafts[0].content).toBe(CRITICAL_LONG);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-content-depth-repair-ch-1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('内容深度补写完成');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('内容深度定向补写');
  });

  it('r16c 残差细分：第 1 轮部分补写残差下降 → 继续第 2 轮补齐（聚合条数口径下误停）', async () => {
    // r16c 丰乐镇实机归因：1191→1749 字真实补写因聚合 blocker 条数不变（1→1）被判「未下降」提前停止；
    // 字数缺口细分后残差严格下降（234→164→0），修复轮修复至清零
    const chapter = { id: 'ch-1', title: '施工组织设计', content: CRITICAL_SHORT };
    const blockers = criticalSectionDepthIssues([{ ...chapter, evidence: [], missingFacts: [], sections: [] }]);
    const session = makeSession([chapter], { validationIssues: blockers });
    repairMock.mockResolvedValueOnce(repairResult(CRITICAL_PARTIAL));
    repairMock.mockResolvedValueOnce(repairResult(CRITICAL_LONG));
    await stageContentDepthRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(2);
    expect(session.finalChapterDrafts[0].content).toBe(CRITICAL_LONG);
    const stage = stageOf(session.progressStages, 'agent-content-depth-repair-ch-1');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('内容深度补写完成');
  });

  it('overview-recap 复述句定位改写：复述清零落地', async () => {
    const session = makeSession([
      { id: 'ch-1', title: '工程概况', content: OVERVIEW_BODY },
      { id: 'ch-2', title: '施工部署', content: RECAP_CHAPTER_CONTENT },
    ], { validationIssues: overviewRecapIssues(RECAP_MARKDOWN) });
    const repaired = '本节说明施工总体安排。施工部署按流水段划分作业面，先地下后地上组织专业工程穿插施工。';
    repairMock.mockResolvedValueOnce(repairResult(repaired));
    await stageContentDepthRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(session.finalChapterDrafts[1].content).toBe(repaired);
    const stage = stageOf(session.progressStages, 'agent-content-depth-repair-ch-2');
    expect(stage?.status).toBe('success');
  });

  it('变差回滚：修复后复述句数上升即回滚保留原文', async () => {
    const session = makeSession([
      { id: 'ch-1', title: '工程概况', content: OVERVIEW_BODY },
      { id: 'ch-2', title: '施工部署', content: RECAP_CHAPTER_CONTENT },
    ], { validationIssues: overviewRecapIssues(RECAP_MARKDOWN) });
    const worse = `${RECAP_SENTENCE}\n${RECAP_SENTENCE}`;
    repairMock.mockResolvedValueOnce(repairResult(worse));
    await stageContentDepthRepair(session);
    expect(session.finalChapterDrafts[1].content).toBe(RECAP_CHAPTER_CONTENT);
    const stage = stageOf(session.progressStages, 'agent-content-depth-repair-ch-2');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('未生效：模型未产生有效修改时显性记录（不调 rebuild/recompute）', async () => {
    const session = makeSession([
      { id: 'ch-1', title: '工程概况', content: OVERVIEW_BODY },
      { id: 'ch-2', title: '施工部署', content: RECAP_CHAPTER_CONTENT },
    ], { validationIssues: overviewRecapIssues(RECAP_MARKDOWN) });
    repairMock.mockResolvedValueOnce(repairResult(RECAP_CHAPTER_CONTENT));
    await stageContentDepthRepair(session);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-content-depth-repair-ch-2');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('未生效');
  });

  it('无法定位：blocker 与正文不同源（复述句不存在）时显性记录，不猜测改写', async () => {
    const session = makeSession([{ id: 'ch-1', title: '工程概况', content: OVERVIEW_BODY }], {
      validationIssues: [{ level: 'error', severity: 'blocker', category: 'style', message: '项目概况段跨章复述不得出现', provenance: { detectorId: 'overview-recap', fingerprint: 'x' } }],
    });
    await stageContentDepthRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'content-depth-repair');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('无法定位');
  });
});

// ── 4.49 r9 #12 根治：precise-fact-usage 无匹配章回退（规范编号类 token 零归属） ──

// ── r16c 丰乐镇 B4 归因：critical-section-depth 残差细分为字数缺口量化 ──

describe('critical-section-depth 残差细分（r16c 聚合口径误停根治）', () => {
  const probeOf = (content: string) => ({ id: 'ch-1', title: '施工组织设计', content, evidence: [], missingFacts: [], sections: [] });
  const blockerCountOf = (issues: Array<{ severity?: string }>) => issues.filter(issue => issue.severity === 'blocker').length;

  it('聚合条数不变时细分残差可见部分修复（字数缺口下降）', () => {
    const before = probeOf(CRITICAL_SHORT);
    const partial = probeOf(CRITICAL_PARTIAL);
    const beforeDeficit = criticalSectionDeficitTotal([before]);
    const afterDeficit = criticalSectionDeficitTotal([partial]);
    expect(beforeDeficit).toBeGreaterThan(afterDeficit);
    expect(afterDeficit).toBeGreaterThan(0);
    // 聚合口径不可见：两侧均报 1 条 blocker（旧口径残差 1→1 恒判「未下降」）
    expect(blockerCountOf(criticalSectionDepthIssues([before]))).toBe(1);
    expect(blockerCountOf(criticalSectionDepthIssues([partial]))).toBe(1);
  });

  it('补齐过 blocker 线（250 字）后细分残差清零', () => {
    expect(criticalSectionDeficitTotal([probeOf(CRITICAL_LONG)])).toBe(0);
  });

  it('达标小节 / 空章零残差', () => {
    expect(criticalSectionDeficitTotal([])).toBe(0);
    expect(criticalSectionDeficitTotal([probeOf('## 普通章节\n本节内容与关键小节无关。')])).toBe(0);
  });
});

describe('precise-fact-usage 参数分配回退（r9 #12 零归属根治）', () => {
  // 资料证据窗口（≥20 token 池，含规范编号 GB51192-2016）
  const EVIDENCE_CONTENT = '素混凝土密度约2.4t/cm3，管径DN1000，混凝土强度15.50kPa，总建筑面积28570.36㎡，设计工期90天，道路铺装面积4646㎡，水稳层厚度200mm，压实度98%，沥青摊铺温度160℃，排水管DN400，检查井直径1250mm，沟槽深度3m，回填分层300mm，闭水试验压力0.1MPa，路灯间距30m，缆线规格YJV-4x25，人行道宽2m，标线宽150mm，路面厚度4cm，管线埋深1.2m，执行GB51192-2016与GB13693-2005等现行规范。';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('章集无「依据/规范/标准」类标题：规范编号类 token 回退分配到概况章，指令含逐字保留约束', async () => {
    // r9 实机章集结构：无任何匹配 /依据|规范|标准|编制/ 的章标题 → GB 编号此前零归属零消费
    const chapters = [
      { id: 'ch1', title: '工程概况', content: '本项目位于XX县，建设内容包括道路与排水工程。' },
      { id: 'ch2', title: '确保工期的技术组织措施', content: '按施工总进度组织流水作业，每周检查进度偏差并纠偏。' },
    ];
    const session = makeSession(chapters);
    for (const draft of session.finalChapterDrafts) {
      draft.evidence = [{ chapterId: draft.id, filePath: '资料.pdf', score: 1, roleId: 'spec', content: EVIDENCE_CONTENT }];
    }
    session.validationIssues = [{ level: 'error', severity: 'blocker', message: '可靠精确参数使用不足：关键参数抽查 4/10（缺失如 GB51192-2016、DN1000）', suggestion: '请将资料中的关键工程参数写入正文对应章节。', provenance: { detectorId: 'precise-fact-usage', fingerprint: 'x' } }];
    const repaired = '本项目位于XX县，建设内容包括道路与排水工程，执行GB51192-2016与GB13693-2005等现行国家标准，总建筑面积28570.36㎡。';
    repairMock.mockResolvedValue(repairResult(repaired));
    await stageContentDepthRepair(session);
    // GB 编号回退分配到概况章（无「依据/规范/标准」章）：修复轮实际拿到可定向补写的指令
    expect(repairMock).toHaveBeenCalled();
    const call = repairMock.mock.calls[0][0] as unknown as { promptTexts: string; chapter: { title: string } };
    expect(call.chapter.title).toBe('工程概况');
    expect(call.promptTexts).toContain('GB51192-2016');
    expect(call.promptTexts).toContain('逐字保留原文形态');
    // 部分修复落地：GB 编号写入后内容保留（不再因零归属被丢弃）
    expect(session.finalChapterDrafts[0].content).toContain('GB51192-2016');
  });
});
