/**
 * P22 第 2 项 / P6 修复轮单源声明防回归：
 * 1. finalizeGeneration 执行侧的 stage 调用序列锁定（顺序变更必须显式改本测试）；
 * 2. FINALIZE_REPAIR_ROUNDS 声明表 12 轮顺序与执行侧注释映射逐一对应（单源声明不漂移）；
 * 3. 每轮"修复落地后必触发 recompute"——含修复逻辑的轮文件必须调用
 *    session.recomputeFinalValidationBundle()（纯检测轮 semanticChoice 无修复落地，豁免）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FINALIZE_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 执行侧线性链（documentPipeline.finalizeGeneration 内 await stageXxx(session) 的调用序列） */
const EXECUTION_STAGE_ORDER = [
  'stageRebuildFacts',
  'stageValidationPack',
  'stageComposeFinal',
  'stageRebuildAndRecompute',
  'stageFactLanding',
  'stageTableRepair',
  'stageSemanticChoice',
  'stageDeterministicStage5',
  'stageQingtianReview',
  'stagePostReviewSurface',
  'stageNumericVerification',
  'stageRequirementVerification',
  'stageFinalGate',
  // P18 自动健康诊断：finalize 末尾零 LLM 成本告警（纯读 telemetry，不参与修复轮）
  'stageHealthDiagnosis',
] as const;

/** 修复轮文件 → 声明表轮 id 映射（轮文件名与声明 id 的对应关系，P2 拆分约定） */
const REPAIR_ROUND_FILES = {
  'finalize/repairRounds/factLanding.ts': ['fact-landing-round'],
  'finalize/repairRounds/tableRepair.ts': ['table-repair-round'],
  'finalize/repairRounds/semanticChoice.ts': ['semantic-choice-conflict'],
  'finalize/repairRounds/deterministicStage5.ts': ['deterministic-stage5', 'formal-source-clean'],
  'finalize/repairRounds/qingtianReview.ts': ['qingtian-full-review'],
  'finalize/repairRounds/postReviewSurface.ts': ['planned-section-final', 'commercial-strip', 'table-deterministic-repair', 'post-review-surface', 'terminology-strip', 'toc-consistency'],
  'finalize/repairRounds/numericVerification.ts': ['numeric-verification'],
  'finalize/repairRounds/requirementVerification.ts': ['requirement-verification'],
} as const;

/** 纯检测轮（无修复落地，不需要 recompute 触发） */
const DETECTION_ONLY_ROUNDS = new Set(['semantic-choice-conflict']);

describe('finalize 修复轮调度（P6 单源声明防回归）', () => {
  it('执行侧 stage 调用序列锁定（documentPipeline.finalizeGeneration）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    // stageComposeFinal 为同步调用（无 await），单独断言其位置在 rebuildAndRecompute 之前
    const composeIndex = source.indexOf('stageComposeFinal(session)');
    const rebuildIndex = source.indexOf('await stageRebuildAndRecompute(session)');
    expect(composeIndex).toBeGreaterThan(-1);
    expect(rebuildIndex).toBeGreaterThan(-1);
    expect(composeIndex).toBeLessThan(rebuildIndex);
    const stages = [...source.matchAll(/await (stage\w+)\(session\)/gu)].map(match => match[1]);
    expect(stages).toEqual(EXECUTION_STAGE_ORDER.filter(stage => stage !== 'stageComposeFinal'));
  });

  it('FINALIZE_REPAIR_ROUNDS 14 轮顺序与执行侧注释映射逐一对应（顺序无漂移）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'documentPipeline.ts'), 'utf8');
    // 提取执行侧注释块（P6 注释按声明顺序逐一罗列轮 id）
    const commentBlock = source.match(/P6：修复轮顺序[^\n]*\n(?:\s*\/\/[^\n]*\n){0,6}/u)?.[0] ?? '';
    expect(FINALIZE_REPAIR_ROUNDS).toHaveLength(14);
    let lastIndex = -1;
    for (const round of FINALIZE_REPAIR_ROUNDS) {
      const index = commentBlock.indexOf(round);
      expect(index, `轮 ${round} 未按声明顺序出现在执行侧注释映射中`).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it('每轮修复落地后必触发 recompute（含修复逻辑轮文件均调用 recomputeFinalValidationBundle）', () => {
    for (const [file, rounds] of Object.entries(REPAIR_ROUND_FILES)) {
      const source = readFileSync(path.join(SRC_DIR, file), 'utf8');
      const hasRepair = rounds.some(round => !DETECTION_ONLY_ROUNDS.has(round));
      const recomputeCalls = (source.match(/session\.recomputeFinalValidationBundle\(\)/gu) ?? []).length;
      if (hasRepair) {
        expect(recomputeCalls, `${file}（${rounds.join('+')}）修复落地后必须重算校验组`).toBeGreaterThan(0);
      } else {
        // 纯检测轮：不写正文，无需 recompute（声明语义一致性）
        expect(recomputeCalls, `${file} 为纯检测轮，不应触发 recompute`).toBe(0);
      }
    }
  });

  it('修复轮文件与声明表轮 id 完整覆盖（14 轮均有落点，无哑火轮）', () => {
    const mapped = Object.values(REPAIR_ROUND_FILES).flat();
    expect(mapped.sort()).toEqual([...FINALIZE_REPAIR_ROUNDS].sort());
  });
});
