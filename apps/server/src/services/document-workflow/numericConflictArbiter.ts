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
import { flexNameOptionalPattern, flexNamePattern } from './integrity/authorities/authorities';
import { GENERIC_NAME_RE, SLOT_WORD_RE } from './factReconciliation';
import type { BillFactLock, BillFactLockEntry } from './billFactLock';
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
  /** A3 名称-数值绑定条目名归组键 */
  binding?: string;
}

// ═══════════════════════════ A3 名称-数值绑定（M24b） ═══════════════════════════
// 检测端同源：factReconciliation D4.6a（scanNameBindingFindings）——清单条目名 + 邻近数值对，
// 数值属他条目即「名称-数值绑定错位」blocker（r28k DN 三处 / s28k 过梁、有梁板、灭火器实机形态）。
// 名称匹配复用 citation 两轮机制（flexNamePattern 严格 + flexNameOptionalPattern 省略，严格优先 →
// 靠前优先 → 长匹配优先 + 出现即占位防重叠）；值窗口/单位清单/槽位词豁免与 D4.6a 同源。
// 零静态词表：条目名全部来自运行时 billFactLock。

/** 数值近似相等（与 factReconciliation.nearlyEqual 同口径） */
function nearlyEqualBinding(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.01 + 1e-6 * Math.max(Math.abs(a), Math.abs(b));
}

/** 转写宽容相等（与 factReconciliation.transcribedEqual 同口径：正文整数 = 权威小数截断/舍入） */
function transcribedEqualBinding(textValue: number, authorityValue: number): boolean {
  if (nearlyEqualBinding(textValue, authorityValue)) return true;
  return Number.isInteger(textValue)
    && (Math.trunc(authorityValue) === textValue || Math.round(authorityValue) === textValue);
}

/** 单位书写变体归一（与 factReconciliation.normalizeUnitText 同口径：米/m、㎡/m2/平方米、m³/m3/立方米、吨/t） */
const BINDING_UNIT_ALIAS: Record<string, string> = { '米': 'm', 'm': 'm', '公里': 'km', 'km': 'km', '平方米': 'm2', '㎡': 'm2', 'm²': 'm2', 'm2': 'm2', '立方米': 'm3', 'm³': 'm3', 'm3': 'm3', '吨': 't', 't': 't' };
function normalizeBindingUnit(unit: string): string {
  const u = (unit || '').trim().toLowerCase();
  return BINDING_UNIT_ALIAS[u] ?? u;
}

/** A3 名称-数值绑定命中（与检测端 D4.6a 同源定位） */
interface BillBindingHit {
  name: string;
  value: number;
  unit: string;
  valueText: string;
  valueStart: number;
  sameNameEntries: BillFactLockEntry[];
  sameNameQuantities: number[];
  foreignEntry?: BillFactLockEntry;
}

/** 名后首「数值+单位」匹配（与 D4.6a 值正则/窗口同源：名后 20 字、间隙 ≤12 字） */
const BILL_BINDING_VALUE_RE = /^([^。；;\n|]{0,12}?)([\d,，]+(?:\.\d+)?)\s*(座|个|套|处|盏|棵|株|樘|扇|根|块|片|组|件|孔|间|栋|幢|户|米|m|km|公里|平方米|m2|㎡|m²|立方米|m3|m³|kg|吨|t)(?![a-zA-Z0-9²³])/u;

/** A3 扫描：billFactLock 全条目为锚，正文「条目名+邻近数值」对定位（与检测端 D4.6a 同源） */
function scanBillEntryBindingHits(markdown: string, lock?: BillFactLock): BillBindingHit[] {
  const hits: BillBindingHit[] = [];
  if (!lock || lock.entries.length === 0) return hits;
  const usable = lock.entries
    .map(entry => ({ ...entry, name: (entry.name || '').trim() }))
    .filter(entry => entry.name.length >= 2 && !GENERIC_NAME_RE.test(entry.name) && Number.isFinite(entry.quantity) && entry.quantity > 0);
  if (usable.length === 0) return hits;
  // 同名条目组（本条目权威量集与唯一性判定源）
  const byName = new Map<string, BillFactLockEntry[]>();
  for (const entry of usable) {
    const group = byName.get(entry.name);
    if (group) group.push(entry);
    else byName.set(entry.name, [entry]);
  }
  // 名称两轮收集（严格优先 → 靠前优先 → 长匹配优先；同名条目只匹配一次，出现即占位防重叠）
  const nameHits: Array<{ name: string; start: number; end: number; strict: boolean }> = [];
  for (const name of byName.keys()) {
    for (const [pattern, strict] of [[flexNamePattern(name), true], [flexNameOptionalPattern(name), false]] as const) {
      const nameRe = new RegExp(pattern, 'gu');
      for (const nameMatch of markdown.matchAll(nameRe)) {
        const start = nameMatch.index ?? 0;
        nameHits.push({ name, start, end: start + nameMatch[0].length, strict });
      }
    }
  }
  nameHits.sort((left, right) => (
    (left.strict !== right.strict ? (left.strict ? -1 : 1) : 0)
    || left.start - right.start
    || (right.end - right.start) - (left.end - left.start)
    || right.name.length - left.name.length
  ));
  const occupied: Array<{ start: number; end: number }> = [];
  for (const hit of nameHits) {
    const ns = hit.start;
    const ne = hit.end;
    if (occupied.some(o => ns < o.end && ne > o.start)) continue;
    occupied.push({ start: ns, end: ne });
    // 名称尾部数字粘连守卫（同 D4.6a：「顶棚1」+「8.57」形态该命中无效）
    if (/\d$/u.test(hit.name) && /^[\d.]/u.test(markdown.slice(ne, ne + 1))) continue;
    // 构词延续守卫（同 D4.6a：「回填方量」非「回填方」引用）
    if (markdown.slice(ne, ne + 1) === '量') continue;
    const window = markdown.slice(ne, ne + 20);
    const valueMatch = BILL_BINDING_VALUE_RE.exec(window);
    if (!valueMatch) continue;
    // 槽位词豁免（同 D4.6a：厚度/埋深类工艺参数不参与绑定比对）
    if (SLOT_WORD_RE.test(valueMatch[1])) continue;
    const value = Number.parseFloat(valueMatch[2].replace(/[,，]/gu, ''));
    if (!Number.isFinite(value)) continue;
    const unit = normalizeBindingUnit(valueMatch[3]);
    const sameNameEntries = byName.get(hit.name) ?? [];
    const sameNameQuantities = sameNameEntries.map(entry => entry.quantity);
    const foreignEntry = usable.find(entry =>
      entry.name !== hit.name && nearlyEqualBinding(entry.quantity, value) && normalizeBindingUnit(entry.unit) === unit);
    const valueOffset = valueMatch[1].length;
    hits.push({
      name: hit.name,
      value,
      unit,
      valueText: valueMatch[2],
      valueStart: ne + valueOffset,
      sameNameEntries,
      sameNameQuantities,
      foreignEntry,
    });
  }
  return hits;
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

  // ── A3 名称-数值绑定裁决（M24b：billFactLock 全条目为锚；三分支同 D4.6a 检测端） ──
  // ① 值 ∈ 本条目同名量集（含转写宽容）→ 一致（跳过）；
  // ② 值 ∈ 他条目权威量集 且 ∉ 本条目 + 本条目权威唯一 + 单位兼容 → 硬替换（单锚）；
  // ③ 无锚/多候选（同名多条无法裁决替换目标 / 值不在任何条目量集）→ 不动（no-anchor 留 LLM）。
  const billBindingHits = scanBillEntryBindingHits(markdown, ctx.billFactLock);
  for (const hit of billBindingHits) {
    if (hit.sameNameQuantities.some(quantity => transcribedEqualBinding(hit.value, quantity))) continue;
    if (!hit.foreignEntry) continue;
    if (hit.sameNameEntries.length !== 1) {
      const samples = [...new Set(hit.sameNameEntries.map(entry => `${entry.quantity}${entry.unit}`))].slice(0, 3).join('、');
      noAnchorGroups.push(`“${hit.name}”同名清单条目 ${hit.sameNameEntries.length} 条（如 ${samples} 等），正文 ${hit.value}${hit.unit} 无法确定性替换，交 LLM 定向修复`);
      continue;
    }
    const anchor = hit.sameNameEntries[0]!;
    if (normalizeBindingUnit(hit.unit) !== normalizeBindingUnit(anchor.unit)) continue;
    replacements.push({
      start: hit.valueStart,
      end: hit.valueStart + hit.valueText.length,
      replacement: String(anchor.quantity),
      detail: `名称-数值绑定「${hit.name}」 ${hit.value}${hit.unit}→${anchor.quantity}${anchor.unit}（清单条目「${hit.name}」权威口径）`,
      binding: hit.name,
    });
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
  // A3 复检：条目名替换后同源扫描仍残留可裁决错位 → 该名全部替换回滚（giveUpOnFailure 同 A1/A2）
  // 可裁决判定与 A3 候选条件完全同源（含值 ∉ 本条目量集）：替换后值=本条目权威即已收敛，
  // 即便同时撞他条目量集也不得误判残留回滚
  const billRecheckHits = scanBillEntryBindingHits(candidate, ctx.billFactLock);
  const residualBillBindings = new Set(billRecheckHits
    .filter(hit => hit.sameNameEntries.length === 1
      && hit.foreignEntry
      && normalizeBindingUnit(hit.unit) === normalizeBindingUnit(hit.sameNameEntries[0]!.unit)
      && !hit.sameNameQuantities.some(quantity => transcribedEqualBinding(hit.value, quantity)))
    .map(hit => hit.name));
  for (const name of new Set(replacements.filter(item => item.binding).map(item => item.binding as string))) {
    if (!residualBillBindings.has(name)) continue;
    replacements.forEach((item, index) => { if (item.binding === name) dropIndexes.add(index); });
    noAnchorGroups.push(`“${name}”名称-数值绑定替换复检未清零，已回滚交 LLM 定向修复`);
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
