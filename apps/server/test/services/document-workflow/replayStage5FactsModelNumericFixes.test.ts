/**
 * M24c 链尾事实口径数值收口重放单测（961.42 回归定案：stage5 scale/spec/cost 定点修复只写
 * finalMarkdown 不写章 drafts，其后 rebuildFinalMarkdown 把替换回退——链尾重放兜底）：
 * 真实 applyDeterministicConsistencyFixesToMarkdown 链路（败选值替换/幂等静默）+ 无 factsModel
 * 短路 + 双写 stage + 接线守护（postReviewSurface 内位于 citation replay 之后；documentPipeline
 * 内位于最后一次净变更点之后、终门禁之前）。
 * 语义 stub：mock getLocalSemanticProvider 注入确定性嵌入（与 scaleConsistency.test 同口径——
 * GAP 语义 gate 词面判定，测试环境不加载本地嵌入模型）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as SemanticSimilarityModule from '@/services/document-workflow/semanticSimilarity';
import { buildFactsModel } from '@/services/document-workflow/factsModel';
import type { DocumentFact } from '@/services/document-workflow/types';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const embedStub = vi.hoisted(() => vi.fn(async (texts: string[]) => texts.map(text => {
  const gapLike = /配套用房|附属用房|占地面积|绿化面积|分项指标|分项费用|暂列金额|人工费|材料费/u.test(text);
  const totalLike = /总建筑面积|建设规模|总体规模|总金额|合同估算价|投资估算/u.test(text);
  return [gapLike ? 1 : 0, totalLike ? 1 : 0];
})));

vi.mock('@/services/document-workflow/semanticSimilarity', async (importOriginal) => {
  const actual = await importOriginal<typeof SemanticSimilarityModule>();
  return { ...actual, getLocalSemanticProvider: () => ({ embedDocuments: embedStub }) };
});

import { replayStage5FactsModelNumericFixes } from '@/services/document-workflow/finalize/repairRounds/postReviewSurface';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

function scaleFact(value: string): DocumentFact {
  return { key: '建设规模', fieldName: '建设规模', value, sourceFile: '招标文件.pdf', roleId: 'project_basic', confidence: 90 };
}

function sessionOf(overrides: Partial<FinalizeSession>): FinalizeSession {
  return {
    factsModel: undefined,
    scopeConflicts: undefined,
    finalMarkdown: '',
    progressStages: [],
    finalGateRepairStages: [],
    recomputeFinalValidationBundle: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as FinalizeSession;
}

describe('replayStage5FactsModelNumericFixes（M24c 链尾事实口径数值收口重放）', () => {
  it('961.42 形态：markdown 败选值 → factsModel 胜选硬替换 + recompute + 双写 stage', async () => {
    const model = await buildFactsModel([scaleFact('建设规模：总建筑面积937.72平方米')]);
    const session = sessionOf({
      factsModel: model,
      finalMarkdown: '- 建设规模：总建筑面积为961.42平方米',
    });
    await replayStage5FactsModelNumericFixes(session);
    expect(session.finalMarkdown).toContain('937.72');
    expect(session.finalMarkdown).not.toContain('961.42');
    expect(session.recomputeFinalValidationBundle).toHaveBeenCalledTimes(1);
    expect(session.progressStages).toHaveLength(1);
    expect(session.finalGateRepairStages).toHaveLength(1);
    expect(session.progressStages[0]).toMatchObject({ roleId: 'stage5-facts-replay', status: 'success' });
    expect(session.progressStages[0]?.message).toContain('处');
  });

  it('幂等：二次重放零变更（fixedCount=0 静默，不追加 stage）', async () => {
    const model = await buildFactsModel([scaleFact('建设规模：总建筑面积937.72平方米')]);
    const session = sessionOf({
      factsModel: model,
      finalMarkdown: '- 建设规模：总建筑面积为937.72平方米',
    });
    await replayStage5FactsModelNumericFixes(session);
    expect(session.finalMarkdown).toContain('937.72');
    expect(session.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    expect(session.progressStages).toHaveLength(0);
    expect(session.finalGateRepairStages).toHaveLength(0);
  });

  it('无 factsModel：短路静默（零成本零事件）', async () => {
    const session = sessionOf({ finalMarkdown: '- 建设规模：总建筑面积为961.42平方米' });
    await replayStage5FactsModelNumericFixes(session);
    expect(session.recomputeFinalValidationBundle).not.toHaveBeenCalled();
    expect(session.progressStages).toHaveLength(0);
  });

  it('接线守护：postReviewSurface 内位于 citation replay 之后、requirement tail closure 之前', () => {
    const source = readFileSync(path.join(SRC_DIR, 'finalize/repairRounds/postReviewSurface.ts'), 'utf8');
    const citationIndex = source.indexOf('await replayBlueprintCitationNumericFixes(session);');
    const stage5Index = source.indexOf('await replayStage5FactsModelNumericFixes(session);');
    const tailIndex = source.indexOf('await replayRequirementTailClosure(session);');
    expect(stage5Index).toBeGreaterThan(citationIndex);
    expect(stage5Index).toBeLessThan(tailIndex);
  });

  it('接线守护：documentPipeline 内位于 citation replay 之后、终门禁之前', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    const citationIndex = source.indexOf('await replayBlueprintCitationNumericFixes(session);');
    const stage5Index = source.indexOf('await replayStage5FactsModelNumericFixes(session);');
    const gateIndex = source.indexOf('await stageFinalGate(session);');
    expect(stage5Index).toBeGreaterThan(citationIndex);
    expect(stage5Index).toBeLessThan(gateIndex);
  });
});
