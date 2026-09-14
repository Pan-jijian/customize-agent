import { getLocalSemanticProvider } from './semanticSimilarity';
import type { BillFactLock, BillFactLockEntry } from './billFactLock';
import type { ValidationIssue } from './types';

/**
 * 参数概念口径冲突检测（C1）：把"同一参数概念的多口径矛盾"（如围挡高度 2.5m/1.8m、试压压力 1.5MPa/1.0MPa）
 * 从枚举参数名单迁移到"概念自组织聚类 + 同簇数值冲突"检测。
 *
 * 分层：L1 正则结构提取"数值+单位+概念语境"token（封闭集单位表）→ L3 本地 bge 对概念语境自组织聚类
 * （两两余弦 ≥0.6 合并为同簇，并查集）→ L2 同簇内显著不同数值判定冲突（差异 >2%，排除并列枚举）。
 * 零误伤原则：本地 bge 恒可用（本地 ONNX 推理）；嵌入数量不一致降级为显性 warning（跳检不硬停），
 * 嵌入调用异常由末期 detSafe 兜底降级；
 * 并列枚举（"600mm/800mm/1000mm 三种规格"）不判冲突。
 * V5 P6 误报收口（run1 实测，三防线）：①簇级倍数门——同一参数口径偏差不可能达 4 倍以上，
 * 超出必是跨对象 bge 误聚类（实测误报簇 4.84/6/11/13 倍全部收口，原 20 倍门有漏网）；
 * ②单位一致性——同簇跨单位数值不可互比（「2 处] vs「22 天」误聚根因）；
 * ③概念黑名单——对象计数类概念（自然村/标段/点位等）是对象枚举计数非参数多口径。
 */

const PARAM_TOKEN_RE = /([\u4e00-\u9fa5A-Za-z0-9（）()]{1,12}?)(\d+(?:\.\d+)?)\s*(mm|cm|m|米|MPa|kN|kV|kW|℃|°C|万元|元|人|天|日|个|层|樘|处|套|台|t|吨)([\u4e00-\u9fa5A-Za-z0-9（）()]{0,8})/gu;

/** 纯通用量词表：概念归一化后仅为量词本身（无具体对象）时退出聚类——
 * 不同对象的「直径22mm」「直径48.3mm」（锚杆 vs 钢管）同词形不同对象，聚同簇必误报（合肥师范实测）。 */
const GENERIC_MEASURE_WORDS = [
  '直径', '厚度', '宽度', '长度', '高度', '深度', '间距', '距离', '标高', '偏差',
  '数量', '面积', '体积', '重量', '压力', '温度', '强度', '等级', '坡度', '规格',
  '尺寸', '层数', '次数', '跨度', '半径',
] as const;

/** 概念黑名单（run1 实测误报收口）：对象计数类概念——「13 个自然村 / 1 个标段 / 2 处踏勘点位」
 * 是对象的枚举计数而非同一参数的多口径取值，跨对象 bge 误聚簇时数字天然异构（13 vs 1）；
 * 此类数字一致性由跨章/审计通道把关，不参与参数口径互斥（「养护」类时长按对象天然多口径同）。 */
const CONCEPT_BLACKLIST_RE = /自然村|村组|标段|区域|点位|养护/u;

/** 动作词表（丰乐镇复测 #82 簇 A/B）：同簇各 token 原文分别含互不相同的施工/管理动作词
 * （「签订 vs 提交」「开挖 vs 封闭」）时，是不同工序各自的动作参量而非同一参数多口径——
 * bge 概念相似度会把「合同签订后…日内」与「资料提交…日内」误聚同簇，数字差异必误报。 */
const CONCEPT_ACTION_WORDS = ['开挖', '封闭', '回填', '浇筑', '铺筑', '摊铺', '供应', '编制', '提交', '签订', '安装', '养护', '试验', '拆除', '砌筑'] as const;

/** 概念归一化：去除单位词与标点后仅保留概念词面 */
function normalizeConcept(concept: string): string {
  return concept
    .replace(/(?:mm|cm|m|MPa|kN|kV|kW|℃|元|万元|人|天|日|个|层|樘|处|套|台|t|吨)/gu, '')
    .replace(/[\s,，、；;：:（）()]/gu, '');
}

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index];
  return sum;
}

interface ParamToken {
  concept: string; value: number; unit: string; raw: string;
  /** 该 token 的全部文本出现（4.27.0 A1 硬替换逐处定位）：match 绝对起址 + 值文本组内偏移 + 值原文 */
  occurrences: Array<{ matchIndex: number; valueOffset: number; valueText: string }>;
}

/** 值文本在完整匹配内的偏移定位（prefix 字符类可含数字，「3号塑料管3m」类 indexOf 会误中前缀数字）：
 * 优先从单位反向回溯（数字与单位紧邻、允许空白），失败回退首个同文本命中 */
function locateValueOffset(matchText: string, valueText: string, unitText: string): number {
  if (!unitText) return matchText.indexOf(valueText);
  const unitAt = matchText.lastIndexOf(unitText);
  if (unitAt >= 0) {
    const direct = unitAt - valueText.length;
    if (direct >= 0 && matchText.slice(direct, unitAt) === valueText) return direct;
    const loose = new RegExp(`(${valueText.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')})\\s*$`, 'u').exec(matchText.slice(0, unitAt));
    if (loose && loose.index !== undefined) return loose.index;
  }
  return matchText.indexOf(valueText);
}

function extractParamTokens(markdown: string): ParamToken[] {
  const tokenByRaw = new Map<string, ParamToken>();
  // 剔除表格行与标题行，只检正文句（表格内同概念多规格属正常枚举，不在矛盾检测范围）
  let lineStart = 0;
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    const currentLineStart = lineStart;
    lineStart += line.length + 1;
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) continue;
    for (const match of line.matchAll(new RegExp(PARAM_TOKEN_RE.source, 'gu'))) {
      const prefix = (match[1] || '').trim();
      const value = Number(match[2]);
      const unit = match[3] || '';
      const suffix = (match[4] || '').trim();
      // 概念语境 = 数值前后短语去空白；语境过短（纯标点/无概念词）不参与聚类
      const concept = `${prefix}${suffix}`.replace(/[\s,，、；;：:]/gu, '');
      if (concept.length < 2 || !/[\u4e00-\u9fa5A-Za-z]{2,}/u.test(concept) || !Number.isFinite(value) || value <= 0) continue;
      // 纯通用量词概念跳过：无具体对象无从判定口径，不同对象同量词聚簇必误报
      if (GENERIC_MEASURE_WORDS.some(word => normalizeConcept(concept) === word)) continue;
      // 对象计数类概念跳过（非参数口径，见 CONCEPT_BLACKLIST_RE）
      if (CONCEPT_BLACKLIST_RE.test(concept)) continue;
      // 同一表述的全部出现合并为 occurrences（4.27.0 A1）：判定仍按「同 raw 只算一个口径」去重，
      // 但硬替换须逐处定位全部出现位置——历史缺陷：同值多处出现只改首处的替换残留
      const occurrence = {
        matchIndex: currentLineStart + (match.index || 0),
        valueOffset: locateValueOffset(match[0], match[2], match[3] || ''),
        valueText: match[2],
      };
      const existing = tokenByRaw.get(match[0]);
      if (existing) {
        existing.occurrences.push(occurrence);
        continue;
      }
      tokenByRaw.set(match[0], { concept, value, unit, raw: match[0], occurrences: [occurrence] });
    }
  }
  // 去重：同 raw 合并为单 token（同一表述重复出现不算冲突），限额 60
  return [...tokenByRaw.values()].slice(0, 60);
}

/** 并查集：两两语义相似 ≥0.6 的概念合并为同簇（自组织聚类） */
function clusterConcepts(concepts: string[], similarity: (left: string, right: string) => number): Map<string, string> {
  const parent = new Map(concepts.map(concept => [concept, concept]));
  const find = (node: string): string => {
    const root = parent.get(node) || node;
    return root === node ? node : (parent.set(node, find(root)), parent.get(node) || node);
  };
  const union = (left: string, right: string) => { parent.set(find(left), find(right)); };
  for (let left = 0; left < concepts.length; left += 1) {
    for (let right = left + 1; right < concepts.length; right += 1) {
      if (similarity(concepts[left], concepts[right]) >= 0.6) union(concepts[left], concepts[right]);
    }
  }
  return parent;
}

/** 冲突组内的单一口径值（同概念同单位的全部出现记录） */
export interface ConceptConflictValue {
  concept: string;
  value: number;
  unit: string;
  raw: string;
  occurrences: Array<{ matchIndex: number; valueOffset: number; valueText: string }>;
}

/** 参数概念冲突组（同簇同单位下 ≥2 个显著不同值）：检测 message 与 A1 裁决器共用的结构化载体 */
export interface ConceptConflictGroup {
  /** 组代表概念（首个值 token 的概念，与历史 message 口径一致） */
  concept: string;
  values: ConceptConflictValue[];
}

/** 冲突组扫描结果：degraded 为嵌入降级（不 throw，调用方显性呈现） */
export interface ConceptConflictScan {
  groups: ConceptConflictGroup[];
  degraded?: ValidationIssue;
}

/**
 * 冲突组扫描（4.27.0 从 parameterConceptConflictIssues 抽出，行为保持）：
 * L1 正则提取 → bge 概念自组织聚类 → 同簇同单位显著差异判定，返回结构化冲突组。
 * 检测端（message 生成）与 A1 裁决器（三分支替换/降级）共用同一扫描口径（检测定位=修复定位）。
 */
export async function conceptConflictGroups(markdown: string): Promise<ConceptConflictScan> {
  const tokens = extractParamTokens(markdown);
  // 至少需要 3 个概念 token 才有聚类价值；不足时静默跳过（零误伤：样本不足不判）
  if (tokens.length < 3) return { groups: [] };
  const concepts = [...new Set(tokens.map(token => token.concept))];
  if (concepts.length < 2) return { groups: [] };
  const vectors = await getLocalSemanticProvider().embedDocuments(concepts);
  if (vectors.length !== concepts.length) {
    // 嵌入数量不一致降级（finalize 末期硬停治理）：检测器内部基础设施异常不再 throw 穿透任务层；
    // 以显性 warning 呈现（可观测/可复核/可重跑），本检测器本轮跳过判定（失败即暴露，不静默）
    const detail = `本地语义模型嵌入数量不一致：期望 ${concepts.length} 条，实际 ${vectors.length} 条`;
    console.warn(`[gen] parameter-concept-conflict degraded: ${detail}`);
    return {
      groups: [],
      degraded: {
        level: 'warning',
        severity: 'warning',
        category: 'format',
        owner: 'system',
        repairability: 'manual_review',
        message: `参数概念口径冲突检测已降级跳过：${detail}`,
        suggestion: '语义模型输出异常，本轮未执行该检测维度；可稍后重新生成复核。',
      },
    };
  }
  const vectorOf = new Map(concepts.map((concept, index) => [concept, vectors[index]]));
  const similarity = (left: string, right: string) => {
    const leftVector = vectorOf.get(left);
    const rightVector = vectorOf.get(right);
    if (!leftVector || !rightVector || leftVector.length === 0 || rightVector.length === 0) return 0;
    return dot(leftVector, rightVector);
  };
  const parent = clusterConcepts(concepts, similarity);
  const find = (node: string): string => {
    let current = node;
    while ((parent.get(current) || current) !== current) current = parent.get(current) || current;
    return current;
  };
  // 按簇聚合 token
  const clusters = new Map<string, ParamToken[]>();
  for (const token of tokens) {
    const root = find(token.concept);
    const group = clusters.get(root) || [];
    group.push(token);
    clusters.set(root, group);
  }
  const groups: ConceptConflictGroup[] = [];
  for (const group of clusters.values()) {
    if (group.length < 2) continue;
    // 簇级倍数门（>4 倍整簇跳过）：同一参数口径偏差不可能达 4 倍以上，超出必是跨对象 bge
    // 误聚类——run1 实测误报簇 4.84/6/11/13 倍全部收口（原 >20 倍门对「13 个自然村 vs
    // 1 个标段」类跨对象计数聚簇有漏网），整簇跳过不再细分。
    const groupMax = Math.max(...group.map(token => token.value));
    const groupMin = Math.min(...group.map(token => token.value));
    if (groupMax > groupMin * 4) continue;
    // 单位一致性（run1 实测误报收口）：同簇不同单位的数值不可互比（bge 把「踏勘点位不少于
    // 2 处」与「驻场每月不少于 22 天」误聚同簇）——按单位分组后仅同单位组内 ≥2 个显著差异值才判冲突
    const byUnit = new Map<string, ParamToken[]>();
    for (const token of group) {
      const unitGroup = byUnit.get(token.unit) || [];
      unitGroup.push(token);
      byUnit.set(token.unit, unitGroup);
    }
    for (const unitGroup of byUnit.values()) {
      if (unitGroup.length < 2) continue;
      // 动作词差异豁免（4.32.0 丰乐镇复测 #82 簇 A/B）：同簇各 token 原文含互不相同的施工/管理
      // 动作词时（「签订 vs 提交」「开挖 vs 封闭」），是不同工序各自的参量而非同参数多口径，跳过
      const actions = unitGroup.map(token => CONCEPT_ACTION_WORDS.find(word => token.raw.includes(word)) || '');
      if (actions.length >= 2 && actions.every(action => action !== '') && new Set(actions).size === actions.length) continue;
      // 合同阶梯豁免（4.31 丰乐镇 v6 #65）：同簇各值均处合同条款阶梯语境时（「逾期超过28日后…
      // 自第29日起提高至万分之五；逾期超过56日后…单方解除合同」逐档提高的违约责任阶梯），
      // 各档数值并存合法非口径冲突；窗口取出现位 -30 到 +raw.length+40，词面含违约金/解除合同/
      // 提高至/自第/逾期超过之一；every 校验——任一口径不在阶梯语境即不豁免
      const allInLadder = unitGroup.every(token => token.occurrences.some(occurrence => /违约金|解除合同|提高至|自第|逾期超过/u.test(
        markdown.slice(Math.max(0, occurrence.matchIndex - 30), occurrence.matchIndex + token.raw.length + 40),
      )));
      if (allInLadder) continue;
      const values = [...new Set(unitGroup.map(token => token.value))];
      if (values.length < 2) continue;
      const maxValue = Math.max(...values);
      const minValue = Math.min(...values);
      // 差异 >2% 才算显著冲突；同簇同值多表述不算
      if (maxValue - minValue <= maxValue * 0.02) continue;
      // 排除并列枚举：任一 token 的出现位后 12 字内含「、/ + 数字」枚举链（如「10cm、8cm」
      // 匹配「、8」；「厚15cm、C30」匹配「、C30」）≥2 个即属多规格枚举声明——修复 4.32.0：
      // 原检查针对 token.raw 而 PARAM_TOKEN_RE 字符类不含顿号/斜杠（永假死代码），改按
      // occurrence.matchIndex 取出现位上下文判定（检测定位=原文定位）
      const enumerations = unitGroup.filter(token => token.occurrences.some(occurrence => /[、/](?:与)?[A-Za-z]?\d/u.test(markdown.slice(occurrence.matchIndex, occurrence.matchIndex + token.raw.length + 12))));
      if (enumerations.length >= 2) continue;
      groups.push({ concept: unitGroup[0].concept, values: unitGroup });
      if (groups.length >= 4) break;
    }
    if (groups.length >= 4) break;
  }
  return { groups };
}

/**
 * 单组裁决（4.27.0 A1 三分支，检测端降级与修复端替换共用同源裁决）：
 * ①各值分别精确命中不同清单条目（billFactLock）= 误报（不同条目口径并存合法）；
 * ②恰好一个值精确命中清单条目（且条目名与概念相关，纯村组宽松匹配不算）其余值无锚 → 取锁值硬替换；
 * ③其余（无锁/部分锚定/权威多义）→ 保留 LLM 定向修复。
 */
export type ConceptGroupArbitration =
  | { verdict: 'distinct-lock-entries'; entries: string }
  | { verdict: 'single-lock-entry'; lockValue: number; lockUnit: string; entryName: string; nonLock: ConceptConflictValue[] }
  | { verdict: 'no-anchor' };

/** 清单单位文本归一（参数 token 单位捕获对 m²/m³ 截尾，须从 raw 原文回取后归一） */
function normalizeUnitToken(unit: string): string {
  return unit.replace(/㎡/gu, 'm2').replace(/m²/giu, 'm2').replace(/m³/giu, 'm3').replace(/\s+/gu, '').toLowerCase();
}

/** token 的原文单位文本（值文本之后紧邻）：如 raw="马圩组46.7m²" → "m²" */
function rawUnitOf(value: ConceptConflictValue): string {
  const first = value.occurrences[0];
  if (!first) return value.unit;
  const at = value.raw.indexOf(first.valueText);
  if (at < 0) return value.unit;
  return value.raw.slice(at + first.valueText.length) || value.unit;
}

function normalizeLockName(text: string): string {
  return text.replace(/[（(][^）)]*[）)]/gu, '').replace(/[\s,，、；;：:]/gu, '');
}

/** 条目名与概念相关：完全相等，或较长者包含较短者（较短 ≥3 字防两字短名误配） */
function lockNameRelated(entryName: string, concept: string): boolean {
  const name = normalizeLockName(entryName);
  const target = normalizeLockName(concept);
  if (name.length < 2 || target.length < 2) return false;
  if (name === target) return true;
  const shorter = name.length <= target.length ? name : target;
  const longer = name.length <= target.length ? target : name;
  return shorter.length >= 3 && longer.includes(shorter);
}

/** 值 → 清单条目命中（数额精确相等[相对容差 0.1%] + 单位兼容 + 语境相关[条目名/村组出现在值邻近窗口]） */
export function lockEntriesForConceptValue(value: ConceptConflictValue, ctx: { markdown: string; billFactLock?: BillFactLock }): Array<{ entry: BillFactLockEntry; nameRelated: boolean }> {
  const lock = ctx.billFactLock;
  if (!lock || lock.entries.length === 0) return [];
  const tolerance = Math.max(0.01, value.value * 0.001);
  const unitText = normalizeUnitToken(rawUnitOf(value));
  const windows = value.occurrences
    .map(occurrence => ctx.markdown.slice(Math.max(0, occurrence.matchIndex - 48), occurrence.matchIndex + occurrence.valueOffset + occurrence.valueText.length + 48))
    .join('\n');
  const matched: Array<{ entry: BillFactLockEntry; nameRelated: boolean }> = [];
  for (const entry of lock.entries) {
    if (!Number.isFinite(entry.quantity) || entry.quantity <= 0) continue;
    if (Math.abs(entry.quantity - value.value) > tolerance) continue;
    const entryUnit = normalizeUnitToken(entry.unit);
    // 单位兼容：任一侧缺单位放行；否则归一后必须相等（m²/m³ 上标归一，防跨量纲误配）
    if (unitText && entryUnit && unitText !== entryUnit) continue;
    const nameRelated = lockNameRelated(entry.name, value.concept);
    const villageRelated = entry.villageGroup.trim().length >= 2 && windows.includes(entry.villageGroup.trim());
    if (!nameRelated && !villageRelated) continue;
    matched.push({ entry, nameRelated });
    if (matched.length >= 8) break;
  }
  return matched;
}

/** 单组三分支裁决（纯函数；billFactLock 缺失时恒无锚→分支③，与历史行为一致） */
export function arbitrateConceptGroup(group: ConceptConflictGroup, ctx: { markdown: string; billFactLock?: BillFactLock }): ConceptGroupArbitration {
  if (!ctx.billFactLock || group.values.length < 2) return { verdict: 'no-anchor' };
  const hits = group.values.map(value => ({ value, matches: lockEntriesForConceptValue(value, ctx) }));
  // ① 每个值都有精确命中，且各值命中条目互不相交 → 各值分属不同清单条目（正文带条目名区分）= 误报
  if (hits.every(hit => hit.matches.length > 0)) {
    const disjoint = hits.every((left, leftIndex) =>
      hits.every((right, rightIndex) =>
        leftIndex === rightIndex || !left.matches.some(leftMatch => right.matches.some(rightMatch => rightMatch.entry.seq === leftMatch.entry.seq))));
    if (disjoint) {
      return {
        verdict: 'distinct-lock-entries',
        entries: hits.map(hit => `「${hit.matches[0].entry.name}」（${hit.value.value}${hit.value.unit}）`).join('、'),
      };
    }
  }
  // ② 恰好一个值命中（须为条目名相关）且其余值全部无锚 → 取锁值确定性硬替换
  const anchored = hits.filter(hit => hit.matches.length > 0);
  const unanchored = hits.filter(hit => hit.matches.length === 0);
  if (anchored.length === 1 && unanchored.length > 0) {
    const best = anchored[0].matches.find(match => match.nameRelated);
    if (best) {
      return {
        verdict: 'single-lock-entry',
        lockValue: best.entry.quantity,
        lockUnit: best.entry.unit,
        entryName: best.entry.name,
        nonLock: unanchored.map(hit => hit.value),
      };
    }
  }
  return { verdict: 'no-anchor' };
}

export async function parameterConceptConflictIssues(markdown: string, opts?: {
  /** 清单事实锁（4.27.0 A1 裁决）：多口径值分别精确命中不同清单条目的组判误报 → 降级 info 不阻断 */
  billFactLock?: BillFactLock;
}): Promise<ValidationIssue[]> {
  const scan = await conceptConflictGroups(markdown);
  if (scan.degraded) return [scan.degraded];
  if (scan.groups.length === 0) return [];
  // A1 裁决分流：①误报组降级 info（正文带条目名区分即合规）；②③保留 blocker——②由前置裁决器
  // 硬替换收敛，替换失败/③无锚由 global-consistency-repair LLM 定向修复兜底
  //（历史缺陷：12 项参数口径冲突 llm-patch 不收敛空转）
  const blocking: ConceptConflictGroup[] = [];
  const acquitted: Array<{ group: ConceptConflictGroup; entries: string }> = [];
  for (const group of scan.groups) {
    const arbitration = arbitrateConceptGroup(group, { markdown, billFactLock: opts?.billFactLock });
    if (arbitration.verdict === 'distinct-lock-entries') acquitted.push({ group, entries: arbitration.entries });
    else blocking.push(group);
  }
  const issues: ValidationIssue[] = [];
  if (blocking.length > 0) {
    const conflicts = blocking.map(group => `“${group.concept}”出现多个口径：${[...new Set(group.values.map(value => value.raw))].slice(0, 3).join('、')}`);
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `同一参数概念出现多口径数值冲突：${conflicts.join('；')}`,
      suggestion: '以绑定资料（图纸/清单/规范）裁决口径为准统一数值表述：每个参数概念全文只保留一个口径数值，删除矛盾表述。',
    });
  }
  if (acquitted.length > 0) {
    issues.push({
      level: 'info',
      severity: 'suggestion',
      category: 'fact_consistency',
      owner: 'system',
      repairability: 'not_repair_needed',
      message: `参数概念多口径已裁决为不同清单条目口径（不构成冲突）：${acquitted.map(({ group, entries }) => `“${group.concept}”对应${entries}`).join('；')}`,
      suggestion: '各数值分别对应不同的工程量清单条目，正文已带条目名区分，无需处理。',
    });
  }
  return issues;
}
