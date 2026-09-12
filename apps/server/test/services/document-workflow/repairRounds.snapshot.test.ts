/**
 * P22 第 3 项 / P6 修复轮顺序快照：锁定 FINALIZE_REPAIR_ROUNDS 与
 * LLM_PATCH_REPAIR_ROUNDS 的声明顺序。
 * 顺序变更必须显式修改本快照并附理由（修复轮先后影响正文改写语义，无意识调整即回归）。
 */
import { describe, expect, it } from 'vitest';
import { FINALIZE_REPAIR_ROUNDS, LLM_PATCH_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';

describe('修复轮顺序快照（变更必须显式改快照并附理由）', () => {
  it('FINALIZE_REPAIR_ROUNDS 14 轮顺序快照', () => {
    expect([...FINALIZE_REPAIR_ROUNDS]).toEqual([
      'fact-landing-round',          // 重要事实落位补写轮（uncoveredImportantFacts 触发）
      'table-repair-round',          // 表格数据完整性修复轮（markdownTableQualityIssues error 触发）
      'semantic-choice-conflict',    // 决策锁语义矛盾检测（semanticChoiceConflicts，无修复）
      'deterministic-stage5',        // 交付前确定性清洗（章级数值/SURFACE_FIX_STEPS/全文数值/表承载正文）
      'formal-source-clean',         // 来源罗列话术确定性清洗兜底（cleanFormalSourcePhrases）
      'qingtian-full-review',        // 全维度评审轮（runFullDimensionReview）
      'planned-section-final',       // 缺节/空小节补写终兜底（enforcePlannedSectionCompleteness）
      'commercial-strip',            // 商务条款数据交付前兜底清洗（stripCommercialDataBodyLines）
      'table-deterministic-repair',  // 表格空单元格交付前确定性修复（repairTableBlocksInMarkdownDeterministically）
      'numeric-verification',        // C2 正文数值 vs 资料原文确定性核对轮（stageNumericVerification）
      'requirement-verification',    // C3 生成后用户要求执行核验闭环（stageRequirementVerification）
      'post-review-surface',         // 评审轮后表面修复兜底（SURFACE_FIX_STEPS round-2 链，含句级复读剥离；后置覆盖用户要求补写引入的复读）
      'terminology-strip',           // 内部术语句子确定性删除兜底（stripInternalTerminologySentences）
      'toc-consistency',             // 目录与正文一致性兜底（fixTocFromBody）
    ]);
  });

  it('LLM_PATCH_REPAIR_ROUNDS 8 轮顺序快照（P11 全链接入的登记载体）', () => {
    expect(LLM_PATCH_REPAIR_ROUNDS.map(round => round.id)).toEqual([
      'fact-landing',
      'table-repair',
      'table-execution-repair',
      'templating-repair',
      'workpackage-skeleton-repair',
      'planned-section-repair',
      'global-consistency-repair',
      'qingtian-review-repair',
    ]);
  });

  it('LLM 修复轮 anchoredTo 检测器锚定不变（修复定位=检测定位契约）', () => {
    expect(LLM_PATCH_REPAIR_ROUNDS.map(round => ({ id: round.id, anchoredTo: round.anchoredTo }))).toEqual([
      { id: 'fact-landing', anchoredTo: 'important-unplaced-facts' },
      { id: 'table-repair', anchoredTo: 'table-quality' },
      { id: 'table-execution-repair', anchoredTo: 'table-plan-execution' },
      { id: 'templating-repair', anchoredTo: 'templating-filler' },
      { id: 'workpackage-skeleton-repair', anchoredTo: 'workpackage-skeleton' },
      { id: 'planned-section-repair', anchoredTo: 'planned-section-completeness' },
      { id: 'global-consistency-repair', anchoredTo: 'global-consistency-review' },
      { id: 'qingtian-review-repair', anchoredTo: 'qingtian-review' },
    ]);
  });
});
