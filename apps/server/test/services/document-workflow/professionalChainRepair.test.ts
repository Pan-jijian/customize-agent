/**
 * repairRounds · 工序链与项目属性适配修复轮（professional-chain-repair，D-T9 / #30/#31 根治）：
 * r28f 实机归因——construction-org-professional-chain warning 无修复轮消费直坠交付，
 * 且旧判定为全文级口径误报族（法定话术/混合项目合法单位工程词跨章叠加误报、组合词死节点漏判）。
 * 本测试锁定：
 * 1. 接线：FINALIZE_REPAIR_ROUNDS 声明 + documentPipeline 调用位置（control-loop-repair
 *    与 post-review-surface 之间，由 repairRounds.order.test.ts 执行序列断言共同保证）；
 * 2. 单源契约：professionalChainScan 检测/修复/复检同判定（节级 mixed + 文档级 insufficient，
 *    r28f 误报族不命中）；
 * 3. 行为矩阵：无 warning 零成本通过 / mixed 节级错位修复落地（复检清零 + rebuild + recompute）/
 *    insufficient 归属修复 / 变差回滚 / 删除式修复回滚（汉字守卫）/ 快照过期跳过；
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
import { stageProfessionalChainRepair } from '@/services/document-workflow/finalize/repairRounds/professionalChainRepair';
import { constructionOrgProfessionalChainIssues, professionalChainScan } from '@/services/document-workflow/constructionOrgQualityRules';
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
    factsModel: { project: [], preciseFacts: [] },
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
  const drafts = chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: [] }));
  return constructionOrgProfessionalChainIssues({
    markdown: chapters.map(chapter => `## ${chapter.title}\n${chapter.content}`).join('\n\n'),
    factsModel: { project: [], preciseFacts: [] } as never,
    chapters: drafts,
  });
}

// ── fixture：节级错位（市政章节写成房建主体工序，r28f #30 真实形态）──
const MIXED_BEFORE = '### 道路工程\n本项目道路工程采用外脚手架配合塔吊完成主体结构施工。';
const MIXED_AFTER = '### 道路工程\n本项目道路工程采用测量放线定位，沟槽开挖后分层回填，水稳与沥青面层依次摊铺。';
const MIXED_WORSE = '### 道路工程\n采用外脚手架、塔吊、主体结构、二次结构、屋面防水施工。';

// ── fixture：文档级链覆盖缺口（municipal 链命中 2/9）──
const CHAIN_BEFORE = '本章为市政工程的总体部署。施工采用测量放线定位，回填采用分层压实。';
const CHAIN_AFTER = '本章为市政工程的总体部署。施工采用测量放线定位、管线探测复核，沟槽开挖后回填采用分层压实，水稳基层与沥青面层依次摊铺。';

describe('professional-chain-repair 接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE_REPAIR_ROUNDS 声明含 professional-chain-repair，位于 control-loop-repair 与 post-review-surface 之间', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const index = rounds.indexOf('professional-chain-repair');
    expect(index).toBeGreaterThan(-1);
    expect(rounds.indexOf('control-loop-repair')).toBeLessThan(index);
    expect(rounds.indexOf('post-review-surface')).toBeGreaterThan(index);
  });

  it('documentPipeline 在 control-loop-repair 与 post-review-surface 之间调用 stageProfessionalChainRepair', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const callIndex = source.indexOf('await stageProfessionalChainRepair(session);');
    expect(callIndex).toBeGreaterThan(-1);
    expect(source.indexOf('await stageControlLoopRepair(session);')).toBeLessThan(callIndex);
    expect(source.indexOf('await stagePostReviewSurface(session);')).toBeGreaterThan(callIndex);
  });
});

describe('professionalChainScan 单源判定（检测=修复=复检契约）', () => {
  it('节级 mixed：节标题「道路工程」命中市政域且节内禁配工序词 ≥2 → 错位产出（节定位）', () => {
    const chapter = { id: 'ch-x', title: '道路工程施工组织', content: MIXED_BEFORE, evidence: [], missingFacts: [], sections: [] };
    const deficits = professionalChainScan({ chapters: [chapter], documentText: `## ${chapter.title}\n${MIXED_BEFORE}` });
    const mixed = deficits.filter(deficit => deficit.kind === 'mixed');
    expect(mixed).toHaveLength(1);
    expect(mixed[0].chapter.id).toBe('ch-x');
    expect(mixed[0].sectionTitle).toBe('道路工程');
    expect(mixed[0].domain).toBe('municipal');
    expect(mixed[0].hits).toEqual(['主体结构', '塔吊', '外脚手架']);
  });

  it('r28f #30 误报族不命中：法定话术/混合项目合法单位工程词跨节分布不叠加为节级错位', () => {
    const chapters = [
      { id: 'ch-1', title: '质量保证措施', content: '### 质量承诺\n地基基础工程和主体结构工程为设计文件规定的合理使用年限。', evidence: [], missingFacts: [], sections: [] },
      { id: 'ch-2', title: '公厕装饰装修工程', content: '### 装饰装修工程\n公厕主体施工采用外脚手架配合砌体施工。', evidence: [], missingFacts: [], sections: [] },
    ];
    const deficits = professionalChainScan({ chapters, documentText: chapters.map(chapter => `## ${chapter.title}\n${chapter.content}`).join('\n\n') });
    // 质量承诺节无域标题不检查；装饰装修节属装饰域且节内零装饰禁配词（外脚手架/主体结构为房建/市政词，非装饰约束对象）
    expect(deficits.filter(deficit => deficit.kind === 'mixed')).toHaveLength(0);
  });

  it('文档级 insufficient：municipal 链命中 2/9 且标签命中 → 覆盖缺口归属到章；簇化等价（「沟槽/路基」按「沟槽」命中）', () => {
    const chapter = { id: 'ch-m', title: '道路工程概况及施工部署', content: CHAIN_BEFORE, evidence: [], missingFacts: [], sections: [] };
    const deficits = professionalChainScan({ chapters: [chapter], documentText: `## ${chapter.title}\n${CHAIN_BEFORE}` });
    const insufficient = deficits.filter(deficit => deficit.kind === 'insufficient');
    expect(insufficient).toHaveLength(1);
    expect(insufficient[0].chapter.id).toBe('ch-m');
    expect(insufficient[0].domain).toBe('municipal');
    expect(insufficient[0].hits).toEqual(['测量放线', '回填']);
    expect(insufficient[0].missing).toContain('沟槽');
    expect(insufficient[0].missing).toContain('管线探测');
  });
});

describe('professional-chain-repair 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('无域信号章：零成本通过（不调修复、写验收记录）', async () => {
    const session = makeSession([{ id: 'ch-q', title: '质量管理措施', content: '本章执行自检、交接检制度，记录同步归档。' }]);
    await stageProfessionalChainRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'professional-chain-repair');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('工序链适配验收通过');
  });

  it('mixed 节级错位修复落地：复检清零、rebuild+recompute、终态诊断', async () => {
    const chapter = { id: 'ch-x', title: '道路工程施工组织', content: MIXED_BEFORE };
    const session = makeSession([chapter], { validationIssues: issuesOf([chapter]) });
    repairMock.mockResolvedValueOnce(repairResult(MIXED_AFTER));
    await stageProfessionalChainRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const call = repairMock.mock.calls[0][0] as unknown as { promptTexts: string; issues: string[] };
    expect(call.promptTexts).toContain('【工序链与项目属性适配定向修复】');
    expect(call.promptTexts).toContain('「道路工程」');
    expect(call.promptTexts).toContain('标准工序名');
    expect(call.issues.join('\n')).toContain('内容混入不匹配工序');
    expect(session.finalChapterDrafts[0].content).toBe(MIXED_AFTER);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-professional-chain-repair-ch-x');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('工序链适配修复完成');
    expect(session.generationDiagnostics.llm.lastInfo).toContain('工序链与项目属性适配修复');
  });

  it('insufficient 归属修复落地：缺失链环节补写后覆盖达标', async () => {
    const chapter = { id: 'ch-m', title: '道路工程概况及施工部署', content: CHAIN_BEFORE };
    const session = makeSession([chapter], { validationIssues: issuesOf([chapter]) });
    repairMock.mockResolvedValueOnce(repairResult(CHAIN_AFTER));
    await stageProfessionalChainRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const call = repairMock.mock.calls[0][0] as unknown as { promptTexts: string; issues: string[] };
    expect(call.promptTexts).toContain('市政工程工序链覆盖不足');
    expect(call.promptTexts).toContain('缺：');
    expect(call.issues.join('\n')).toContain('工序链覆盖不足');
    expect(session.finalChapterDrafts[0].content).toBe(CHAIN_AFTER);
    const stage = stageOf(session.progressStages, 'agent-professional-chain-repair-ch-m');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('工序链适配修复完成');
  });

  it('变差回滚：修复后缺陷数上升即回滚保留原文（不调 rebuild）', async () => {
    const chapter = { id: 'ch-x', title: '道路工程施工组织', content: MIXED_BEFORE };
    const session = makeSession([chapter], { validationIssues: issuesOf([chapter]) });
    repairMock.mockResolvedValueOnce(repairResult(MIXED_WORSE));
    await stageProfessionalChainRepair(session);
    expect(session.finalChapterDrafts[0].content).toBe(MIXED_BEFORE);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'agent-professional-chain-repair-ch-x');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('删除式修复回滚（汉字守卫）：缺陷清零但汉字锐减即回滚保留原文', async () => {
    const base = `### 道路工程\n本项目道路工程采用外脚手架配合塔吊完成主体结构施工。${'路基填筑分层压实，压实度检测合格后进入下道工序，现场设专人指挥运输车辆。'.repeat(10)}`;
    const chapter = { id: 'ch-x', title: '道路工程施工组织', content: base };
    const session = makeSession([chapter], { validationIssues: issuesOf([chapter]) });
    // 修复轮为增量修复：模型以「删长文换短句」方式清零缺陷（残差 0 但汉字锐减）→ 守卫回滚
    repairMock.mockResolvedValueOnce(repairResult('### 道路工程\n采用测量放线定位，沟槽开挖回填。'));
    await stageProfessionalChainRepair(session);
    expect(session.finalChapterDrafts[0].content).toBe(base);
    const stage = stageOf(session.progressStages, 'agent-professional-chain-repair-ch-x');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
  });

  it('快照过期跳过：warning 在但正文已达标（实时重算零缺陷）→ 不调修复、写验收记录', async () => {
    const chapter = { id: 'ch-m', title: '道路工程概况及施工部署', content: CHAIN_AFTER };
    const session = makeSession([chapter], {
      validationIssues: [{
        level: 'warning', severity: 'warning', category: 'professional_chain',
        message: '市政工程工序链覆盖不足：仅识别到 测量放线、回填',
        chapterId: 'ch-m',
        provenance: { detectorId: 'construction-org-professional-chain', fingerprint: 'x' },
      }],
    });
    await stageProfessionalChainRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'professional-chain-repair');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('工序链适配验收通过');
  });
});
