/**
 * 工程量单位书写变体的**唯一权威来源**（4.56 改造 3-b：判据单源化）。
 *
 * **为什么要有这个文件**：同一个概念——「米/m/延长米 是同一量纲」——此前在仓库里被**各写一份**：
 * `factReconciliation`（两张表：`normalizeUnit` 内联 map + `UNIT_ALIAS`）、
 * `numericConflictArbiter`（`BINDING_UNIT_ALIAS`）、`resourceBreakdownNumbers`（`QUANTITY_UNIT_ALIAS_GROUPS`），
 * 外加 `factReconciliation` 里 3 处**手抄的量词交替串**。靠注释互相提醒同步，
 * 改一处即静默分裂判定——本仓已多次因此出现「检测说一致、修复说冲突」的漂移。
 *
 * **口径**：别名只做**书写形归一**（同一量纲的不同写法），**不做量纲互换**
 *（座 ≠ 组 ≠ 个：计数单位之间不可互认——实测「水表 4 组」的 4 实际是井室的「4 座」，
 * 座/组互认会让这类错位被静默放行）。
 */

/** 单位书写别名 → 规范形（键统一小写去空格后匹配） */
export const UNIT_ALIAS: Readonly<Record<string, string>> = {
  '米': 'm', 'm': 'm', '延长米': 'm',
  '公里': 'km', '千米': 'km', 'km': 'km',
  '平方米': 'm2', '平方': 'm2', '㎡': 'm2', 'm²': 'm2', 'm2': 'm2',
  '立方米': 'm3', '方': 'm3', 'm³': 'm3', 'm3': 'm3',
  '吨': 't', 't': 't',
  '千克': 'kg', '公斤': 'kg', 'kg': 'kg',
};

/** 同量纲别名组（每组内任意两个视为同一单位）；用于「量纲是否一致」的双向判定 */
export const UNIT_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['m3', 'm³', '立方米', '方'],
  ['m2', 'm²', '㎡', '平方米'],
  ['m', '米', '延长米'],
  ['t', '吨'],
  ['kg', '千克', '公斤'],
  ['km', '公里', '千米'],
];

/** 单位书写形归一（未登记的单位原样返回，保持既有"符号形直接相等"语义） */
export function normalizeUnitAlias(unit: string): string {
  const key = String(unit || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(UNIT_ALIAS, key) ? UNIT_ALIAS[key]! : key;
}

/** 两单位是否同量纲（空串视为不设闸，与既有调用侧契约一致） */
export function unitsAreEquivalent(left: string, right: string): boolean {
  const a = String(left || '').trim().toLowerCase();
  const b = String(right || '').trim().toLowerCase();
  if (!a || !b) return true;
  if (a === b) return true;
  if (normalizeUnitAlias(a) === normalizeUnitAlias(b)) return true;
  return UNIT_ALIAS_GROUPS.some(group => group.includes(a) && group.includes(b));
}

/**
 * 计数/计量量词的**正则交替串**（供各扫描器的正则内联使用，替代手抄副本）。
 * 顺序有意为「多字符在前」：`平方米` 必须先于 `米`、`km` 先于 `m`，否则贪婪匹配会把
 * 「平方米」截成「平方」+「米」。
 */
export const MEASURE_UNIT_SOURCE =
  '平方米|立方米|m2|m3|m²|m³|㎡|延长米|公里|千米|kg|km|吨|座|个|套|盏|台|根|块|樘|扇|片|组|件|孔|米|m|t';
