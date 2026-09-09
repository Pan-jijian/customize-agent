/**
 * 交付前确定性修复链单源（治理收敛 · 第 1 期 P10）：
 * stage5 逐章链与 round-2 全文链此前各自硬编码一份修复器清单，两处清单的成员与顺序
 * 独立演化已出现漂移（round-2 缺图集引用清洗、stage5 缺表承载正文兜底等），
 * 现将两份清单收敛为一份注册表 SURFACE_FIX_STEPS：顺序即执行顺序，两条链按
 * stage5/round2 启用标志过滤消费，新修复器接入两条链只需登记一次。
 * 权威口径（劳动力峰值/绿化养护期）由调用点注入 SurfaceFixerContext，与检测器同源。
 */
import {
  collapseRepeatedWords,
  fixFinishThickness,
  fixFormulaResidues,
  fixGreeningMaintenanceMismatch,
  fixLaborPeakConflict,
  fixMetaDiscourseDeclarations,
  fixParagraphOpeningRepeats,
  fixSelfUnderminingCandidates,
  fixTableBorneContentSections,
  fixTruncatedSentenceArtifacts,
  mergeTableLineResidues,
  stripDuplicateTables,
  stripInternalDuplicateTableRows,
} from './documentIntegrityChecks';
import type { DeterministicFixOutcome } from './documentIntegrityChecks';
import { dedupeTertiaryH4Titles } from './markdownComposer';
import { fixInternalTermHeadingPhrases } from './internalTerminologyAnchors';
import { stripAtlasReferencePhrases } from './documentGeneratorHelpers';
import { fixEmptyScoringResponses } from './tenderRequirements';

/** 修复器权威口径上下文（与检测器同源：laborPeakAuthority 由蓝图决策锁定，greeningMaintenanceAuthority 由清单事实抽取） */
export interface SurfaceFixerContext {
  laborPeakAuthority?: number;
  greeningMaintenanceAuthority: number | undefined;
}

export interface SurfaceFixStep {
  /** 注册键（计数统计与审计用，唯一） */
  key: string;
  /** 进入 stage5 逐章链（交付前确定性清洗） */
  stage5: boolean;
  /** 进入 round-2 全文链（评审轮后表面修复兜底） */
  round2: boolean;
  fix: (markdown: string, ctx: SurfaceFixerContext) => DeterministicFixOutcome;
}

/**
 * 交付前确定性修复链注册表：顺序即执行顺序。
 * stage5 逐章链与 round-2 全文链的过滤结果均与原两条硬编码清单逐一对应（行为保持）。
 */
export const SURFACE_FIX_STEPS: readonly SurfaceFixStep[] = [
  { key: 'table-line-residue', stage5: true, round2: true, fix: markdown => { const r = mergeTableLineResidues(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 叠词收敛在 stage5 原实现为无条件赋值不计入重建判定（命中不触发 rebuild，修复随下次重建生效），
  // 收敛为计数形式后与 round-2 链同口径：命中即参与重建判定，避免「只有叠词命中时修复丢失」。
  { key: 'repeated-words', stage5: true, round2: true, fix: markdown => { const next = collapseRepeatedWords(markdown); return { markdown: next, fixedCount: next === markdown ? 0 : 1 }; } },
  { key: 'duplicate-tables', stage5: false, round2: true, fix: markdown => { const r = stripDuplicateTables(markdown); return { markdown: r.markdown, fixedCount: r.removedCount }; } },
  { key: 'finish-thickness', stage5: true, round2: true, fix: markdown => { const r = fixFinishThickness(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'labor-peak', stage5: true, round2: true, fix: (markdown, ctx) => { const r = fixLaborPeakConflict(markdown, ctx.laborPeakAuthority); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'internal-table-row-dup', stage5: true, round2: true, fix: markdown => { const r = stripInternalDuplicateTableRows(markdown); return { markdown: r.markdown, fixedCount: r.removedCount }; } },
  { key: 'greening-maintenance', stage5: true, round2: true, fix: (markdown, ctx) => { const r = fixGreeningMaintenanceMismatch(markdown, ctx.greeningMaintenanceAuthority); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'paragraph-opening-repeat', stage5: true, round2: true, fix: markdown => { const r = fixParagraphOpeningRepeats(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'truncated-sentence', stage5: true, round2: true, fix: markdown => { const r = fixTruncatedSentenceArtifacts(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'table-borne-prose', stage5: false, round2: true, fix: markdown => { const r = fixTableBorneContentSections(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'meta-discourse', stage5: true, round2: true, fix: markdown => { const r = fixMetaDiscourseDeclarations(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'formula-residue', stage5: true, round2: true, fix: markdown => { const r = fixFormulaResidues(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'self-undermining', stage5: true, round2: true, fix: markdown => { const r = fixSelfUnderminingCandidates(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'empty-scoring-response', stage5: true, round2: true, fix: markdown => { const r = fixEmptyScoringResponses(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'atlas-reference', stage5: true, round2: false, fix: markdown => { const r = stripAtlasReferencePhrases(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'tertiary-h4-dedupe', stage5: false, round2: true, fix: markdown => dedupeTertiaryH4Titles(markdown) },
  { key: 'internal-term-heading', stage5: false, round2: true, fix: markdown => fixInternalTermHeadingPhrases(markdown) },
];

/** stage5 逐章链修复步骤（注册表顺序过滤） */
export function stage5FixSteps(): SurfaceFixStep[] {
  return SURFACE_FIX_STEPS.filter(step => step.stage5);
}

/** round-2 全文链修复步骤（注册表顺序过滤） */
export function round2FixSteps(): SurfaceFixStep[] {
  return SURFACE_FIX_STEPS.filter(step => step.round2);
}
