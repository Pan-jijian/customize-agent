/**
 * basis-regulations-cross-repair 行为矩阵（C5-4 修复轮永久固化，替代 tmp-c5-cross-probe 探针）：
 * 1. 静默/零成本边界：零声明条目静默跳过；双向零缺口零成本通过（不写进度、不调 LLM）；
 * 2. Phase A 确定性补入：used_not_declared 从正文回补标准全名入编制依据（零 LLM，双向清零）；
 * 3. Phase B 不适用移除：声明未用且全章无区分性 token 应用证据 → 确定性移除（零 LLM）；
 * 4. Phase B LLM 补写：应用章定向补引用句 → 复检待落位清零；删除式修复经 recheck 回滚保留原文；
 * 5. 章外区段：编制依据区段位于章外结构 → 显性记录不猜测改写。
 * repairChapterByQuality 全 mock（审计/复检为确定性实现，无 LLM 网络依赖）；
 * 检测端与修复端同源审计（auditBasisRegulationsCross），断言均为终态审计复核。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/rolePipeline', () => ({
  repairChapterByQuality: vi.fn(),
  repairPatchGuard: vi.fn(() => undefined),
}));

import { repairChapterByQuality } from '@/services/document-workflow/rolePipeline';
import { auditBasisRegulationsCross } from '@/services/document-workflow/basisRegulationsCross';
import { stageBasisRegulationsCrossRepair } from '@/services/document-workflow/finalize/repairRounds/basisRegulationsCrossRepair';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const repairMock = vi.mocked(repairChapterByQuality);

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
  Object.assign(session, { rebuildFinalMarkdown: vi.fn(() => session.finalChapterDrafts.map(chapter => chapter.content).join('\n\n')) });
  return session;
}

function repairResult(content: string) {
  return { content, appliedCount: 1, producedCount: 1, repairType: 'quality' as never };
}

const BASIS_BALANCED = [
  '## 第1章 编制依据',
  '《混凝土结构工程施工质量验收规范》（GB 50204-2015）',
].join('\n');
const PLAN_BALANCED = [
  '## 第2章 施工方案',
  '钢筋验收执行《混凝土结构工程施工质量验收规范》（GB 50204-2015）。',
].join('\n');

describe('basis-regulations-cross-repair 边界（静默/零成本）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('零声明条目静默跳过（无编制依据区段，模板差异不误伤）', async () => {
    const session = makeSession([{ id: 'ch1', title: '施工方案', content: '## 第1章 施工方案\n钢筋验收执行《混凝土结构工程施工质量验收规范》（GB 50204-2015）。' }]);
    await stageBasisRegulationsCrossRepair(session);
    expect(session.progressStages).toHaveLength(0);
    expect(repairMock).not.toHaveBeenCalled();
  });

  it('双向零缺口零成本通过（链尾静默，不写进度事件）', async () => {
    const session = makeSession([
      { id: 'ch1', title: '编制依据', content: BASIS_BALANCED },
      { id: 'ch2', title: '施工方案', content: PLAN_BALANCED },
    ]);
    await stageBasisRegulationsCrossRepair(session);
    expect(session.progressStages).toHaveLength(0);
    expect(repairMock).not.toHaveBeenCalled();
  });
});

describe('basis-regulations-cross-repair Phase A（used_not_declared 确定性补入）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('正文引用未声明 → 确定性回补入编制依据，双向清零且零 LLM 调用', async () => {
    const session = makeSession([
      { id: 'ch1', title: '编制依据', content: BASIS_BALANCED },
      {
        id: 'ch2',
        title: '施工方案',
        content: [
          '## 第2章 施工方案',
          '钢筋验收执行《混凝土结构工程施工质量验收规范》（GB 50204-2015）。',
          '钢结构验收执行《钢结构工程施工质量验收标准》（GB 50205-2020）。',
        ].join('\n'),
      },
    ]);
    expect(auditBasisRegulationsCross(session.finalMarkdown).usedNotDeclared).toHaveLength(1);
    await stageBasisRegulationsCrossRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    expect(session.finalChapterDrafts[0].content).toContain('钢结构工程施工质量验收标准');
    const endAudit = auditBasisRegulationsCross(session.finalMarkdown);
    expect(endAudit.usedNotDeclared).toHaveLength(0);
    expect(endAudit.declaredNotUsed).toHaveLength(0);
    // 三相位共用 roleId：upsert 覆盖后终态 stage 为收口记录（含补入计数与双向清零）
    const stage = stageOf(session.progressStages, 'basis-regulations-cross-repair');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('补入 1 条');
    expect(stage?.message).toContain('双向清零');
    expect(String(session.generationDiagnostics.llm.lastInfo)).toContain('引用未声明 1→0');
  });
});

describe('basis-regulations-cross-repair Phase B（declared_not_used 分类消费）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('不适用声明：全章无区分性 token 应用证据 → 确定性移除，双向清零且零 LLM 调用', async () => {
    const session = makeSession([
      {
        id: 'ch1',
        title: '编制依据',
        content: [
          '## 第1章 编制依据',
          '《混凝土结构工程施工质量验收规范》（GB 50204-2015）',
          '《砌体结构工程施工质量验收规范》（GB 50203-2011）',
        ].join('\n'),
      },
      { id: 'ch2', title: '施工方案', content: PLAN_BALANCED },
    ]);
    expect(auditBasisRegulationsCross(session.finalMarkdown).declaredNotUsed).toHaveLength(1);
    await stageBasisRegulationsCrossRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    expect(session.finalChapterDrafts[0].content).not.toContain('砌体');
    const endAudit = auditBasisRegulationsCross(session.finalMarkdown);
    expect(endAudit.declaredNotUsed).toHaveLength(0);
    const stage = stageOf(session.progressStages, 'basis-regulations-cross-repair');
    expect(stage?.message).toContain('移除 1 条');
    expect(stage?.message).toContain('双向清零');
    expect(String(session.generationDiagnostics.llm.lastInfo)).toContain('声明未用 1→0');
  });

  it('应用章 LLM 定向补写：区分性 token 命中章补引用句 → 复检清零', async () => {
    const applicationContent = [
      '## 第2章 基础施工',
      '土方开挖完成后进行地基验槽，全断面基础垫层同步施工，地基承载力特征值经检测满足设计要求。',
    ].join('\n');
    const session = makeSession([
      {
        id: 'ch1',
        title: '编制依据',
        content: [
          '## 第1章 编制依据',
          '《建筑地基基础工程施工质量验收标准》（GB 50202-2018）',
        ].join('\n'),
      },
      { id: 'ch2', title: '基础施工', content: applicationContent },
    ]);
    repairMock.mockResolvedValueOnce(repairResult(`${applicationContent}\n地基验槽与垫层验收执行《建筑地基基础工程施工质量验收标准》（GB 50202-2018）的相关规定。`));
    await stageBasisRegulationsCrossRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    const call = repairMock.mock.calls[0][0];
    expect(call.issues.some(issue => issue.includes('建筑地基基础工程施工质量验收标准'))).toBe(true);
    expect(call.promptTexts).toContain('建筑地基基础工程施工质量验收标准');
    expect(session.finalChapterDrafts[1].content).toContain('地基验槽与垫层验收执行《建筑地基基础工程施工质量验收标准》');
    const stage = stageOf(session.progressStages, 'agent-basis-regulations-cross-repair-ch2');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toContain('待落位条目全部获正文引用');
    const endAudit = auditBasisRegulationsCross(session.finalMarkdown);
    expect(endAudit.declaredNotUsed).toHaveLength(0);
    expect(String(session.generationDiagnostics.llm.lastInfo)).toContain('声明未用 1→0');
  });

  it('删除式修复回滚：recheck 汉字数大幅下降 → 保留修复前正文（无有效变更落地）', async () => {
    const applicationContent = [
      '## 第2章 基础施工',
      '土方开挖完成后进行地基验槽，全断面基础垫层同步施工，地基承载力特征值经检测满足设计要求，验收记录由质检员按检验批逐一签认。',
    ].join('\n');
    const session = makeSession([
      {
        id: 'ch1',
        title: '编制依据',
        content: [
          '## 第1章 编制依据',
          '《建筑地基基础工程施工质量验收标准》（GB 50202-2018）',
        ].join('\n'),
      },
      { id: 'ch2', title: '基础施工', content: applicationContent },
    ]);
    // LLM 删除式「修复」：内容大幅缩短且未补引用 → 复检指标恶化 → 回滚
    repairMock.mockResolvedValueOnce(repairResult('## 第2章 基础施工\n按图施工。'));
    await stageBasisRegulationsCrossRepair(session);
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(session.finalChapterDrafts[1].content).toBe(applicationContent);
    const stage = stageOf(session.progressStages, 'agent-basis-regulations-cross-repair-ch2');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('已回滚');
    expect(String(session.generationDiagnostics.llm.lastInfo)).toContain('无有效变更落地');
  });
});

describe('basis-regulations-cross-repair 章外区段（不猜测改写）', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('编制依据区段位于章外结构 → 显性记录失败档，确定性插入/移除不执行', async () => {
    const session = makeSession(
      [{ id: 'ch1', title: '工程概况', content: '## 第1章 工程概况\n本工程新建DN200给水管道。' }],
      {
        finalMarkdown: [
          '## 第1章 编制依据',
          '《中华人民共和国建筑法》',
          '',
          '## 第2章 工程概况',
          '本工程新建DN200给水管道，管道验收执行《给水排水管道工程施工及验收规范》（GB 50268-2008）。',
        ].join('\n'),
      },
    );
    await stageBasisRegulationsCrossRepair(session);
    expect(repairMock).not.toHaveBeenCalled();
    const stage = stageOf(session.progressStages, 'basis-regulations-cross-repair');
    expect(stage?.status).toBe('failed');
    expect(stage?.message).toContain('各章均无编制依据区段');
  });
});
