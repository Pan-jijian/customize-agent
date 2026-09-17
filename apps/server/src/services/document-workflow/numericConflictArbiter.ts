/**
 * 数值冲突裁决器（4.27.0 A1/A2）：把「同一概念多口径数值冲突」与「规格错位」从
 * LLM patch 定向修复（global-consistency-repair）前置分流到确定性裁决——以工程量清单
 * 事实锁（billFactLock）/规格-部位权威映射（specAuthorityMap）为唯一裁决依据：
 * ① 各口径值分别精确命中不同清单条目 → 误报（不同条目口径并存合法、正文带条目名区分），
 *    检测端降级 info 不阻断；
 * ② 单一值精确命中清单条目且其余值无锚 → 取锁值确定性硬替换（逐处替换 + 替换后复检，
 *    复检未清零即整组回滚交 LLM——giveUpOnFailure 语义，不做半吊子替换）；
 * ③ 无清单锚点 → 不动，保留 LLM 定向修复。
 * A2 规格错位同源裁决：位置+同型规格命中清单权威值集之外的规格且权威唯一时硬替换。
 *
 * 执行点：finalize 跨章一致性阶段 LLM 定向修复轮之前（runGlobalConsistencyReviewLoop
 * 前置段）——历史缺陷：参数口径冲突 12 项 llm-patch 不收敛空转，确定性可裁者必须先分流。
 * 与检测端同源扫描（conceptConflictGroups / scanSpecLocationMismatchHits）保证检测定位=修复定位。
 */
import { applySpanReplacements, scanSpecLocationMismatchHits } from './documentIntegrityChecks';
import { arbitrateConceptGroup, conceptConflictGroups } from './parameterConceptConflicts';
import type { BillFactLock } from './billFactLock';
import type { BlueprintQuantity } from './integratedBlueprint';
import type { SpecAuthorityMap } from './types';

/** 确定性替换 span（全文坐标系）：调用方按章切片应用 */
export interface NumericArbiterReplacement {
  start: number;
  end: number;
  replacement: string;
  detail: string;
}

export interface NumericArbiterResult {
  replacements: NumericArbiterReplacement[];
  /** 分支①误报组（不同清单条目口径并存，检测端据此降级 info；可观测） */
  falsePositiveGroups: string[];
  /** 分支③与复检回滚组（无确定性裁决依据，保留 LLM 定向修复） */
  noAnchorGroups: string[];
  details: string[];
}

/** 带出处追踪的替换（复检回滚按组/部位剔除） */
interface TrackedReplacement extends NumericArbiterReplacement {
  /** A1 锁值组归组键（组代表概念） */
  concept?: string;
  /** A2 规格替换部位 */
  location?: string;
}

export async function arbitrateNumericConflicts(markdown: string, ctx: {
  billFactLock?: BillFactLock;
  specAuthorityMap?: SpecAuthorityMap;
  /** r9：蓝图参数桶（参数概念裁决第二源，与检测端 parameterConceptConflictIssues 同源） */
  blueprintQuantities?: Record<string, BlueprintQuantity>;
}): Promise<NumericArbiterResult> {
  const replacements: TrackedReplacement[] = [];
  const falsePositiveGroups: string[] = [];
  const noAnchorGroups: string[] = [];

  // ── A1 参数概念多口径（三分支裁决，与检测端同源扫描） ──
  const scan = await conceptConflictGroups(markdown);
  if (!scan.degraded) {
    for (const group of scan.groups) {
      const arbitration = arbitrateConceptGroup(group, { markdown, billFactLock: ctx.billFactLock, blueprintQuantities: ctx.blueprintQuantities });
      if (arbitration.verdict === 'distinct-lock-entries') {
        falsePositiveGroups.push(`“${group.concept}”对应${arbitration.entries}`);
        continue;
      }
      if (arbitration.verdict === 'no-anchor') {
        noAnchorGroups.push(`“${group.concept}”：${[...new Set(group.values.map(value => value.raw))].slice(0, 3).join('、')}`);
        continue;
      }
      // ② 单锚锁值：非锚值逐处替换（occurrences 全量定位——同值多处出现逐处替换）
      for (const value of arbitration.nonLock) {
        for (const occurrence of value.occurrences) {
          const start = occurrence.matchIndex + occurrence.valueOffset;
          replacements.push({
            start,
            end: start + occurrence.valueText.length,
            replacement: String(arbitration.lockValue),
            detail: `参数口径“${value.concept}” ${value.raw}→${arbitration.lockValue}${arbitration.lockUnit}（以工程量清单条目「${arbitration.entryName}」锁定口径为准）`,
            concept: group.concept,
          });
        }
      }
    }
  }

  // ── A2 规格错位（位置权威唯一才硬替换；多义权威留 LLM） ──
  const specHits = scanSpecLocationMismatchHits(markdown, ctx.specAuthorityMap);
  for (const hit of specHits) {
    if (!hit.replacement) continue;
    replacements.push({ ...hit.replacement, location: hit.location });
  }

  if (replacements.length === 0) return { replacements: [], falsePositiveGroups, noAnchorGroups, details: [] };

  // ── 复检（giveUpOnFailure 语义）：候选替换全量应用后重跑同源检测，未清零的组/部位回滚交 LLM ──
  const candidate = applySpanReplacements(markdown, replacements).markdown;
  const dropIndexes = new Set<number>();
  // A1 复检：锁值组替换后仍在冲突列表 → 该组全部替换回滚（宁可交 LLM，不做半吊子替换）
  const recheck = await conceptConflictGroups(candidate);
  if (!recheck.degraded) {
    const residualConcepts = new Set(recheck.groups.map(group => group.concept));
    for (const concept of new Set(replacements.filter(item => item.concept).map(item => item.concept as string))) {
      if (!residualConcepts.has(concept)) continue;
      replacements.forEach((item, index) => { if (item.concept === concept) dropIndexes.add(index); });
      noAnchorGroups.push(`“${concept}”锁值替换复检未清零，已回滚交 LLM 定向修复`);
    }
  }
  // A2 复检：同部位替换后错位命中数未减少 → 该部位替换全部回滚（替换值口径未被检测端认可）
  const specOriginalMiss = new Map<string, number>();
  for (const item of replacements) {
    if (!item.location) continue;
    specOriginalMiss.set(item.location, (specOriginalMiss.get(item.location) || 0) + 1);
  }
  if (specOriginalMiss.size > 0) {
    const specRecheck = scanSpecLocationMismatchHits(candidate, ctx.specAuthorityMap);
    const specResidualMiss = new Map<string, number>();
    for (const hit of specRecheck) {
      if (!hit.replacement) continue;
      specResidualMiss.set(hit.location, (specResidualMiss.get(hit.location) || 0) + 1);
    }
    for (const [location, originalCount] of specOriginalMiss) {
      if ((specResidualMiss.get(location) || 0) >= originalCount) {
        replacements.forEach((item, index) => { if (item.location === location) dropIndexes.add(index); });
        noAnchorGroups.push(`“${location}”规格替换复检未减数，已回滚交 LLM 定向修复`);
      }
    }
  }
  const details = [...new Set(replacements.filter((_, index) => !dropIndexes.has(index)).map(item => item.detail))].slice(0, 12);
  return {
    replacements: replacements
      .filter((_, index) => !dropIndexes.has(index))
      .map(item => ({ start: item.start, end: item.end, replacement: item.replacement, detail: item.detail })),
    falsePositiveGroups,
    noAnchorGroups,
    details,
  };
}
