/**
 * repairRounds · 模板化清理链尾重放轮（templating-sweep）：
 * D-T7 ①（r28f #35 归因：终检 formalStyleIssues 报「模板化前缀」而修复链无链尾确定性收口）。
 * 本测试锁定：
 * 1. 接线：FINALIZE 声明表（section-alignment-sweep 之后、duplicate-theme-merge 之前）
 *    + documentPipeline 调用位置（stageSectionAlignmentSweep 之后、链尾 markdown-only 重放之前）；
 * 2. 行为矩阵（零 LLM 确定性）：零信息前缀句删除（信息前缀句保留交终检警告）/ 段落完全重复
 *    去重（≥40 字段落）/ 零改动核对通过 / 幂等（复跑零变化）；
 * 3. 同源一致性：formalStyleIssues（检测端）与 scanTemplatePrefixSentences（句池单源）对同一
 *    markdown 判定同源（检测定位=修复定位，r28f #35 三误报根因回归锁定）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  buildSemanticSimilarity: vi.fn(async () => () => 0),
  snapshotEmbedCacheStats: vi.fn(() => ({ embedCacheHits: 0, embedCacheMisses: 0 })),
  getLocalSemanticProvider: vi.fn(() => ({ embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => [0, 0])) })),
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  clearEmbedCacheForTest: vi.fn(),
}));

import { FINALIZE_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import { stageTemplatingSweep } from '@/services/document-workflow/finalize/repairRounds/templatingSweep';
import { formalStyleIssues } from '@/services/document-workflow/qualityValidation';
import { scanTemplatePrefixSentences } from '@/services/document-workflow/tenderBidChecks';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 零信息前缀句形态（无数字/岗位/频次/合规锚点）：判定命中且零信息 → 确定性删除 */
const PREFIX_CONTENT = [
  '## 确保工程质量的措施',
  '### 1.1 质量管理体系',
  '本章将从施工准备、资源配置与过程管控三个方面进行阐述。项目部建立三级质量检查制度。',
].join('\n');

/** 删除后：前缀句移除、信息句保留（行内无缝拼接） */
const PREFIX_STRIPPED = [
  '## 确保工程质量的措施',
  '### 1.1 质量管理体系',
  '项目部建立三级质量检查制度。',
].join('\n');

/** 信息前缀句（含岗位/数字锚点）：不得删除，交终检警告与 LLM 具体化 */
const INFO_PREFIX_CONTENT = [
  '## 确保工程质量的措施',
  '### 1.1 质量管理体系',
  '本章将配置项目经理1名负责质量管控。项目部按方案组织施工。',
].join('\n');

/** 段落完全重复形态（≥40 字同段两次）：第二段确定性删除 */
const DUP_PARA_CONTENT = [
  '## 确保工程质量的措施',
  '施工现场设置标准化围挡并配备车辆冲洗设施，出入口安排专人值守登记，车辆密闭覆盖后方可驶出作业场地。',
  '',
  '施工现场设置标准化围挡并配备车辆冲洗设施，出入口安排专人值守登记，车辆密闭覆盖后方可驶出作业场地。',
].join('\n');

interface StageLike { roleId?: string; status?: string; message?: string; details?: string[] }

function stageOf(stages: StageLike[], roleId: string): StageLike | undefined {
  return stages.find(stage => stage.roleId === roleId);
}

function makeSession(chapters: Array<{ id: string; title: string; content: string; sections?: string[] }>) {
  const session = {
    template: {},
    requirement: '',
    bidComposition: undefined,
    signal: undefined,
    generationDiagnostics: { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, lastError: '' } },
    finalChapterDrafts: chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: chapter.sections ?? [] })),
    progressStages: [] as StageLike[],
    finalGateRepairStages: [] as StageLike[],
    finalMarkdown: chapters.map(chapter => chapter.content).join('\n\n'),
    emitProgress: vi.fn(),
    withProgressHeartbeat: (fn: () => Promise<unknown>) => fn(),
    recomputeFinalValidationBundle: vi.fn(async () => {}),
  } as unknown as FinalizeSession & { finalChapterDrafts: Array<{ content: string }> };
  Object.assign(session, { rebuildFinalMarkdown: vi.fn(() => session.finalChapterDrafts.map(chapter => chapter.content).join('\n\n')) });
  return session;
}

describe('templating-sweep 接线（防「修复器存在但未接线」回归）', () => {
  it('FINALIZE 声明表：位于 section-alignment-sweep 之后、duplicate-theme-merge 之前', () => {
    const rounds = [...FINALIZE_REPAIR_ROUNDS];
    const alignIndex = rounds.indexOf('section-alignment-sweep');
    const sweepIndex = rounds.indexOf('templating-sweep');
    const mergeIndex = rounds.indexOf('duplicate-theme-merge');
    const closureIndex = rounds.indexOf('delivery-structure-closure');
    expect(alignIndex).toBeGreaterThan(-1);
    expect(sweepIndex).toBeGreaterThan(alignIndex);
    expect(mergeIndex).toBeGreaterThan(sweepIndex);
    expect(closureIndex).toBeGreaterThan(mergeIndex);
  });

  it('documentPipeline.ts 在 stageSectionAlignmentSweep 之后、链尾 markdown-only 重放之前调用', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const alignIndex = source.indexOf('await stageSectionAlignmentSweep(session);');
    const sweepIndex = source.indexOf('await stageTemplatingSweep(session);');
    const replayIndex = source.indexOf('await runSurfaceDeterministicCleans(session);');
    expect(alignIndex).toBeGreaterThan(-1);
    expect(sweepIndex).toBeGreaterThan(alignIndex);
    expect(replayIndex).toBeGreaterThan(sweepIndex);
  });
});

describe('templating-sweep 行为矩阵', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('零信息前缀句删除：原文摘除、信息句保留、rebuild/recompute + 双写 + 明细', async () => {
    const session = makeSession([{ id: 'ch1', title: '确保工程质量的措施', content: PREFIX_CONTENT }]);
    await stageTemplatingSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(PREFIX_STRIPPED);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalledTimes(1);
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    const stage = stageOf(session.progressStages, 'templating-sweep');
    expect(stage?.status).toBe('success');
    expect(stage?.message).toBe('模板化链尾清理：零信息前缀句删除 1 处、重复段落去重 0 处');
    expect(stage?.details?.[0]).toBe('前缀句删除：「本章将从施工准备、资源配置与过程管控三个方面进行阐述」');
    expect(stageOf(session.finalGateRepairStages, 'templating-sweep')?.status).toBe('success');
  });

  it('信息前缀句保留（含岗位/数字锚点）：零删除、核对通过（无 rebuild/recompute）', async () => {
    const session = makeSession([{ id: 'ch1', title: '确保工程质量的措施', content: INFO_PREFIX_CONTENT }]);
    await stageTemplatingSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(INFO_PREFIX_CONTENT);
    expect(session.rebuildFinalMarkdown).not.toHaveBeenCalled();
    expect(session.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    expect(stageOf(session.progressStages, 'templating-sweep')?.message).toBe('模板化链尾核对通过：无零信息前缀句与重复段落残留');
  });

  it('段落完全重复去重：第二段删除、首现保留、rebuild/recompute + 计数', async () => {
    const session = makeSession([{ id: 'ch1', title: '确保工程质量的措施', content: DUP_PARA_CONTENT }]);
    await stageTemplatingSweep(session);
    const content = session.finalChapterDrafts[0].content;
    expect((content.match(/施工现场设置标准化围挡/gu) || [])).toHaveLength(1);
    expect(session.rebuildFinalMarkdown).toHaveBeenCalledTimes(1);
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    expect(stageOf(session.progressStages, 'templating-sweep')?.message).toBe('模板化链尾清理：零信息前缀句删除 0 处、重复段落去重 1 处');
  });

  it('幂等：收口后再运行零变化（无 rebuild/recompute）', async () => {
    const session = makeSession([{ id: 'ch1', title: '确保工程质量的措施', content: PREFIX_CONTENT }]);
    await stageTemplatingSweep(session);
    const settled = session.finalChapterDrafts[0].content;
    const rebuildMock = vi.mocked(session.rebuildFinalMarkdown);
    const recomputeMock = vi.mocked(session.recomputeFinalValidationBundle);
    rebuildMock.mockClear();
    recomputeMock.mockClear();
    await stageTemplatingSweep(session);
    expect(session.finalChapterDrafts[0].content).toBe(settled);
    expect(rebuildMock).not.toHaveBeenCalled();
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(stageOf(session.progressStages, 'templating-sweep')?.message).toContain('核对通过');
  });
});

describe('templating-sweep 与检测端同源一致性（r28f #35 回归锁定）', () => {
  it('formalStyleIssues 报出的模板化前缀句与 scanTemplatePrefixSentences 完全同源', async () => {
    const sentences = scanTemplatePrefixSentences(PREFIX_CONTENT);
    expect(sentences).toEqual(['本章将从施工准备、资源配置与过程管控三个方面进行阐述']);
    const issues = await formalStyleIssues(PREFIX_CONTENT);
    const templateIssue = issues.find(issue => issue.message.includes('存在模板化前缀或套话'));
    expect(templateIssue?.message).toBe('存在模板化前缀或套话：本章将从施工准备、资源配置与过程管控三个方面进行阐述');
  });

  it('负例零误杀：施工描述句既不进句池也不被检测端报出（4.28 前语义原型误报回归锁定）', async () => {
    const markdown = '## 确保工程质量的措施\n\n砌筑砂浆采用预拌砂浆，铺贴前基层清理湿润，混凝土浇筑后洒水养护形成记录。';
    expect(scanTemplatePrefixSentences(markdown)).toEqual([]);
    const issues = await formalStyleIssues(markdown);
    expect(issues.some(issue => issue.message.includes('存在模板化前缀或套话'))).toBe(false);
  });
});
