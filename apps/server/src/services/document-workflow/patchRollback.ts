import type { DocumentGenerationDiagnostics } from './types';

/**
 * P12 回滚保护泛化：把 F2 模板化修复先例（修复前快照 + 同源复检 + 变差即回滚）提取为通用工具，
 * 供全部 LLM patch 修复轮复用。默认判定 = 任一指标严格上升即回滚（指标语义：越大越差，
 * 如检测器命中数/占比）；调用方可用 shouldRollback 自定义组合判定（如 F2 双指标抵偿语义：
 * 重难点达标提升可抵偿套话占比小幅上升）。
 * 回滚计数按 repairRound 写入 diagnostics.llm.patchGuardStats[repairRound].rollbacks（P25 统计扩展），
 * 供交付报告 stage 展示与后续 observe→enforce 灰度决策；回滚不影响 patchGuard 命中统计（两者独立记账）。
 */
export interface PatchRollbackInput {
  /** 修复前正文内容（快照基准，回滚时原样返回） */
  originalContent: string;
  /** 执行修复：内部更新内容，返回修复后正文（与 originalContent 相同表示 patch 未落地，跳过复检） */
  apply: () => Promise<string>;
  /**
   * 同源复检：对给定内容计算指标向量（与修复轮触发检测器同源，越大越差）。
   * before/after 指标长度必须一致且同序（由调用方保证）。
   */
  recheck: (content: string) => Promise<number[]> | number[];
  /** 回滚判定（可选）：默认任一指标严格上升即回滚 */
  shouldRollback?: (before: number[], after: number[]) => boolean;
  /** 修复轮 id（对齐 LLM_PATCH_REPAIR_ROUNDS），回滚计数按轮分组 */
  repairRound: string;
  diagnostics?: DocumentGenerationDiagnostics;
  /** 预设修复前指标（调用方已在修复前算过同源复检时传入，避免重复计算；与 originalContent 同源由调用方保证） */
  beforeMetrics?: number[];
}

export interface PatchRollbackResult {
  /** 最终内容：回滚时等于 originalContent */
  content: string;
  rolledBack: boolean;
  beforeMetrics: number[];
  afterMetrics: number[];
}

/** 默认回滚判定：任一指标严格上升（修复引入的新缺陷比修复前多）即回滚 */
function defaultShouldRollback(before: number[], after: number[]): boolean {
  return after.some((value, index) => value > before[index]);
}

/** P12 回滚计数：按修复轮分组写入 patchGuardStats（bucket 增加 rollbacks 字段，P25 统计扩展） */
function recordPatchRollback(diagnostics: DocumentGenerationDiagnostics | undefined, repairRound: string): void {
  if (!diagnostics) return;
  const stats = diagnostics.llm.patchGuardStats ?? (diagnostics.llm.patchGuardStats = {});
  const bucket = stats[repairRound] ?? (stats[repairRound] = { hits: 0, rejects: 0, rollbacks: 0 });
  bucket.rollbacks = (bucket.rollbacks ?? 0) + 1;
}

export async function withPatchRollback(input: PatchRollbackInput): Promise<PatchRollbackResult> {
  const beforeMetrics = input.beforeMetrics?.map(Number) ?? (await input.recheck(input.originalContent)).map(Number);
  const nextContent = await input.apply();
  if (nextContent === input.originalContent) {
    // 修复无产出（patch 未落地）：内容未变即无变差风险，跳过复检（默认判定相等不触发回滚，语义一致）
    return { content: input.originalContent, rolledBack: false, beforeMetrics, afterMetrics: beforeMetrics };
  }
  const afterMetrics = (await input.recheck(nextContent)).map(Number);
  const rollback = (input.shouldRollback ?? defaultShouldRollback)(beforeMetrics, afterMetrics);
  if (!rollback) return { content: nextContent, rolledBack: false, beforeMetrics, afterMetrics };
  recordPatchRollback(input.diagnostics, input.repairRound);
  return { content: input.originalContent, rolledBack: true, beforeMetrics, afterMetrics };
}
