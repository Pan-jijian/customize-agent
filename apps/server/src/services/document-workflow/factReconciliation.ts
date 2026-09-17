/**
 * D4 数值对账六类（批 1 事实溯源专项机制化）：正文数值句 vs 权威数据（清单事实锁 + 蓝图参数桶 +
 * 事实主表）的确定性关系型对账。事实溯源专项 8 处人工修复的模式固化：
 *
 * - D4.1 合计推导：合计句数值必须 = 权威单值，或 = 权威分项之和；与锚点条目不符且差额命中
 *   另一权威条目 → 重复计入（案例：管道总长 16344.54 误含管道基础 307m）；
 * - D4.2 规格-数值绑定：规格词 + 数值对必须命中同一清单条目（specQuantityPairs）；
 *   数值命中其他规格的权威数量 → 张冠李戴（案例：DN200 7965m 实为 PE 波纹管数量）；
 * - D4.3 数值语义槽位：埋深/覆土类槽位数值超出物理合理范围（>10m）→ 疑似与总长口径混用
 *   （案例：「埋深不小于 23.45m」实为管道总长）；
 * - D4.4 近似数值口径：「约/近 + N」「N 余」必须可从权威数据推导（精确或容差内命中权威数字池），
 *   否则删除或改可推导表述（案例：「约 309 点」无法闭合）；
 * - D4.5 分项显式：合计数值可分解为多个权威条目之和时，正文应予分解展示
 *   （案例：557 座 = 塑料检查井 555 座 + 砌筑检查井 2 座）；
 * - D4.6 名称口径：名称-数值对 / 材质-对象复合词必须命中清单权威名称，被替换的名称
 *   （案例：木门 12 樘 vs 清单金属门 12 樘）在数量对命中同对象条目时判错位。
 *
 * 与既有检测器的分工（防重复与口径分叉）：
 * - 无源数值 token 全量核对由 finalize 数值核对轮（numericVerification）与终检
 *   generated-fact-verification 承担，本模块只做「合计/绑定/槽位/近似/名称」关系型对账；
 * - 规格-部位错位（垫层 C30 vs 权威 C20）由 spec-location-mismatch 承担（D4.6 规格维度）；
 * - 跨节同锚数值冲突由 cross-section-numeric-conflict 承担；
 * - 权威数据缺失（无清单/无蓝图/无事实主表）时全部规则静默跳过（不误伤无数据项目）。
 */
import type { BlueprintData } from './integratedBlueprint';
import type { BillFactLock } from './billFactLock';
import type { DocumentFactsModel, ValidationIssue } from './types';

// ═══════════════════════════ 通用工具 ═══════════════════════════

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 数值字面量解析：去千分位逗号/空白（含全角） */
function parseNumeric(raw: string): number | undefined {
  const cleaned = raw.replace(/[,，\s]/gu, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

/** 数值近似相等：两位小数容差 + 浮点相对容差（合计对账口径） */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.01 + 1e-6 * Math.max(Math.abs(a), Math.abs(b));
}

/** 有序数值池近似查找（二分定位 + 邻位复核：容差带内的权威值命中判定） */
function poolHasApprox(sorted: number[], value: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  for (let index = Math.max(0, lo - 1); index <= Math.min(sorted.length - 1, lo + 1); index += 1) {
    if (nearlyEqual(sorted[index], value)) return true;
  }
  return false;
}

/** 单位归一：同口径单位族收敛到规范形（米→m、平方米→m2、立方米→m3、公里→km、吨→t） */
function normalizeUnit(unit: string): string {
  const u = (unit || '').trim().toLowerCase();
  const map: Record<string, string> = {
    '米': 'm', 'm': 'm', '公里': 'km', 'km': 'km', '千米': 'km',
    '平方米': 'm2', '㎡': 'm2', 'm²': 'm2', 'm2': 'm2', '平方': 'm2',
    '立方米': 'm3', 'm³': 'm3', 'm3': 'm3', '方': 'm3',
    '吨': 't', 't': 't', '千克': 'kg', 'kg': 'kg',
  };
  return map[u] ?? u;
}

/** 单位匹配正则片段（正文用字与清单单位字面差异同族收敛） */
function unitAliasPattern(unit: string): string {
  switch (normalizeUnit(unit)) {
    case 'm': return '(?:m|米)';
    case 'km': return '(?:km|公里|千米)';
    case 'm2': return '(?:m2|m²|㎡|平方米)';
    case 'm3': return '(?:m3|m³|立方米)';
    case 't': return '(?:t|吨)';
    case 'kg': return '(?:kg|千克)';
    default: return escapeRegexLiteral((unit || '').trim());
  }
}

/** 数值显示变体（千分位/去尾零）：分项显式存在性检查用 */
function numberVariants(value: number): string[] {
  const plain = `${value}`;
  const variants = new Set<string>([plain]);
  const [intPart, decimalPart] = plain.split('.');
  if (intPart.length >= 4) {
    variants.add(`${intPart.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')}${decimalPart ? `.${decimalPart}` : ''}`);
  }
  return [...variants];
}

/** 槽位/性能/频次词豁免：数字属工艺参数或物理属性（非工程量），不做绑定比对 */
const SLOT_WORD_RE = /(?:每|厚度|宽度|高度|深度|长度|直径|间距|净距|坡度|标高|偏差|误差|系数|等级|龄期|温度|含水率|压实度|密度|功率|电压|照度|色温|耐火|强度|抗渗|配合比|搭接|错缝|含水|埋深|覆土|预留|预埋|伸缩|沉降|变形|垂直度|平整度|倾角|坡度|模数|螺距|壁厚|净空|层高|埋设|位置|距离|半径|周长|坡度)/u;

// ═══════════════════════════ 权威视图 ═══════════════════════════

interface ReconciliationEntry {
  name: string;
  value: number;
  unit: string;
  description: string;
  source: 'bill' | 'blueprint';
}

interface ReconciliationAuthority {
  entries: ReconciliationEntry[];
  /** 数字池：全部权威数值（条目值 + 分村明细 + 规格-数量拆分 + 蓝图 + 事实主表），近似口径推导用 */
  numberPool: number[];
  /** 规格 → 权威值与来源条目（D4.2 绑定校验；spec=原书写形，键为归一形） */
  specValues: Map<string, Array<{ value: number; unit: string; entryName: string; spec: string }>>;
}

/** 事实主表数值收集（字符串内数字 token 化提取：maximal match 防子串误配） */
function collectFactModelNumbers(factsModel: DocumentFactsModel | undefined, out: number[]): void {
  if (!factsModel) return;
  const visit = (value: unknown): void => {
    if (typeof value === 'number') { if (Number.isFinite(value)) out.push(value); return; }
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\d+(?:\.\d+)?/gu)) out.push(Number.parseFloat(match[0]));
      return;
    }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value && typeof value === 'object') { Object.values(value).forEach(visit); }
  };
  const collections: unknown[] = [
    factsModel.project, factsModel.schedule, factsModel.quality, factsModel.safety,
    factsModel.resources, factsModel.preciseFacts, factsModel.bills, factsModel.drawings,
    factsModel.rules, factsModel.specifications, factsModel.tables,
  ];
  collections.forEach(visit);
}

/**
 * 权威视图构建：清单事实锁（条目级权威）+ 蓝图 quantities（聚合口径）+ 事实主表（数字池扩容）。
 * 清单缺失时蓝图与事实主表仍可独立支撑（无任何权威时各规则自行跳过）。
 */
function buildReconciliationAuthority(input: FactReconciliationInput): ReconciliationAuthority {
  const entries: ReconciliationEntry[] = [];
  const numberPool: number[] = [];
  const specValues = new Map<string, Array<{ value: number; unit: string; entryName: string; spec: string }>>();
  const lock = input.billFactLock;
  if (lock) {
    for (const entry of lock.entries) {
      const value = Number.isFinite(entry.quantity) ? entry.quantity : undefined;
      if (value !== undefined) {
        entries.push({ name: (entry.name || '').trim(), value, unit: (entry.unit || '').trim(), description: entry.description || '', source: 'bill' });
        numberPool.push(value);
      }
      for (const pair of entry.specQuantityPairs || []) {
        const specKey = (pair.spec || '').replace(/\s+/gu, '').toLowerCase();
        const pairMatch = /^([\d,，]+(?:\.\d+)?)\s*(.*)$/u.exec((pair.quantity || '').trim());
        const pairValue = pairMatch ? parseNumeric(pairMatch[1]) : undefined;
        if (!specKey || pairValue === undefined) continue;
        const list = specValues.get(specKey) || [];
        list.push({ value: pairValue, unit: (pairMatch?.[2] || '').trim(), entryName: entry.name, spec: (pair.spec || '').trim() });
        specValues.set(specKey, list);
        numberPool.push(pairValue);
      }
    }
  }
  const quantities = input.blueprintData?.quantities ?? {};
  for (const [name, quantity] of Object.entries(quantities)) {
    if (typeof quantity?.value !== 'number' || !Number.isFinite(quantity.value)) continue;
    entries.push({ name: name.trim(), value: quantity.value, unit: (quantity.unit || '').trim(), description: '', source: 'blueprint' });
    numberPool.push(quantity.value);
    for (const group of quantity.groups ?? []) numberPool.push(group.value);
  }
  collectFactModelNumbers(input.factsModel, numberPool);
  return { entries, numberPool, specValues };
}

export interface FactReconciliationInput {
  markdown: string;
  /** 清单事实锁（条目名称/特征/工程量 + 规格-数量拆分对）：D4.2/D4.6 权威来源 */
  billFactLock?: BillFactLock;
  /** 蓝图参数桶（quantities 聚合口径）：D4.1/D4.5 权威来源 */
  blueprintData?: BlueprintData;
  /** 事实主表（数值池扩容）：D4.4 推导兜底 */
  factsModel?: DocumentFactsModel;
}

// ═══════════════════════════ D4.1 + D4.5：合计句对账 ═══════════════════════════

/** 合计句：总量词 + 数值 + 工程单位（单位后边界断言防 mm→m / m3→m 的截断误配） */
const TOTAL_CLAIM_RE = /(?:合计|共计|总计|总共|总量|总数|总长|全长|总长度|总数量|总面积|总重量|小计)(?:为|达|约|共|计)?\s*([\d,，]+(?:\.\d+)?)\s*(立方米|m³|m3|平方米|㎡|m²|m2|公里|千米|km|kg|吨|t|座|个|套|处|盏|棵|株|樘|扇|根|块|片|组|件|孔|间|栋|幢|户|米|m)(?![a-zA-Z0-9²³])/gu;

/** 条目名与文本的类别重叠（≥2 字公共连续子串）：合计分项归因与误报收口共用 */
function nameOverlapsText(name: string, text: string, minLength = 2): boolean {
  if (!name || !text) return false;
  const max = Math.min(name.length, 8);
  for (let length = max; length >= minLength; length -= 1) {
    for (let start = 0; start + length <= name.length; start += 1) {
      if (text.includes(name.slice(start, start + length))) return true;
    }
  }
  return false;
}

/** 分项值在窗口内显式展示（数值≥100 时允许裸数；小值须与同族单位邻接，防噪声命中） */
function componentShown(window: string, entry: ReconciliationEntry): boolean {
  const unitAlt = unitAliasPattern(entry.unit);
  for (const variant of numberVariants(entry.value)) {
    const escaped = escapeRegexLiteral(variant);
    if (new RegExp(`${escaped}\\s*(?:${unitAlt})|(?:${unitAlt})\\s*${escaped}`, 'u').test(window)) return true;
    if (entry.value >= 100 && new RegExp(`(?<![\\d.])${escaped}(?![\\d])`, 'u').test(window)) return true;
  }
  return false;
}

/** 分项和查找：≥2 个与上下文类别重叠的条目，其值之和 ≈ 合计值 */
function findBreakdownComponents(candidates: ReconciliationEntry[], total: number, context: string): ReconciliationEntry[] {
  const related = candidates.filter(entry => entry.name.length >= 2 && nameOverlapsText(entry.name, context));
  if (related.length < 2 || related.length > 24) return [];
  for (let i = 0; i < related.length; i += 1) {
    for (let j = i + 1; j < related.length; j += 1) {
      const left = related[i];
      const right = related[j];
      if (left.name === right.name && nearlyEqual(left.value, right.value)) continue;
      if (nearlyEqual(left.value + right.value, total)) return [left, right];
    }
  }
  return [];
}

/**
 * 合计聚合闭包：total 可被"与合计句上下文名称相关的组和"（多村组同名聚合 / 跨类别合分项）闭合：
 * - 相关组和 1~2 项本身 ≈ total（案例：挖淤泥、流砂 21273 = 6 村组同名条目之和）；
 * - 相关组和 1~2 项 + 任一权威值池值补差 ≈ total（案例：16037.54 = 8205.53 + 7525.01 + 307）。
 * 补差项只允许单值命中（数字池 = 清单条目 + 规格拆分 + 蓝图 quantities + 事实主表）。
 */
function aggregationClosure(total: number, unit: string, context: string, authority: ReconciliationAuthority, poolSorted: number[]): boolean {
  const groupSums = new Map<string, number>();
  for (const entry of authority.entries) {
    if (!(entry.value > 0) || normalizeUnit(entry.unit) !== unit) continue;
    const key = `${entry.source}\u0000${entry.name}`;
    groupSums.set(key, (groupSums.get(key) || 0) + entry.value);
  }
  const relatedValues: number[] = [];
  for (const [key, sum] of groupSums) {
    const name = key.slice(key.indexOf('\u0000') + 1);
    if (!nameOverlapsText(name, context)) continue;
    if (!relatedValues.some(value => nearlyEqual(value, sum))) relatedValues.push(sum);
    if (relatedValues.length >= 24) break;
  }
  if (relatedValues.length === 0) return false;
  const closed = (sum: number): boolean => nearlyEqual(sum, total) || poolHasApprox(poolSorted, total - sum);
  if (relatedValues.some(sum => closed(sum))) return true;
  for (let i = 0; i < relatedValues.length; i += 1) {
    for (let j = i + 1; j < relatedValues.length; j += 1) {
      if (closed(relatedValues[i] + relatedValues[j])) return true;
    }
  }
  return false;
}

/** 合计句扫描命中（结构化）：issue 供检测端照常报告；matchStart/matchEnd 供交付前确定性删除定位 */
export interface TotalClaimFinding {
  issue: ValidationIssue;
  matchStart: number;
  matchEnd: number;
}

function scanTotalClaimFindings(markdown: string, authority: ReconciliationAuthority): TotalClaimFinding[] {
  const findings: TotalClaimFinding[] = [];
  if (authority.entries.length === 0) return findings;
  const seen = new Set<string>();
  const poolSorted = [...authority.numberPool].sort((left, right) => left - right);
  for (const match of markdown.matchAll(TOTAL_CLAIM_RE)) {
    const total = parseNumeric(match[1]);
    if (total === undefined) continue;
    const unit = normalizeUnit(match[2]);
    const index = match.index ?? 0;
    const matchEnd = index + match[0].length;
    const candidates = authority.entries.filter(entry => entry.value > 0 && normalizeUnit(entry.unit) === unit);
    if (candidates.length === 0) continue;
    const context = markdown.slice(Math.max(0, index - 40), index + match[0].length + 40);
    // 锚点：条目名（≥3 字）出现在合计值前 20 字至句尾（强归属信号）
    const anchorScope = markdown.slice(Math.max(0, index - 20), index + match[0].length);
    const anchor = candidates
      .filter(entry => entry.name.length >= 3 && anchorScope.includes(entry.name))
      .sort((left, right) => right.name.length - left.name.length)[0];
    if (anchor) {
      if (nearlyEqual(anchor.value, total)) {
        // 合计值与锚点一致：进一步检查 D4.5 分项显式（可分解但未分解）
        const breakdown = findBreakdownComponents(candidates, total, context);
        if (breakdown.length >= 2) {
          const window = markdown.slice(Math.max(0, index - 150), index + match[0].length + 150);
          const missing = breakdown.filter(entry => !componentShown(window, entry));
          if (missing.length > 0) {
            const breakdownText = breakdown.map(entry => `「${entry.name}」${entry.value}${entry.unit}`).join(' + ');
            const message = `合计数值应分项显式：「${anchor.name} ${total}${match[2]}」= ${breakdownText}，但正文未展示分项（缺 ${missing.map(entry => `${entry.name} ${entry.value}${entry.unit}`).join('、')}），无法核对合计来源`;
            if (!seen.has(message)) {
              seen.add(message);
              findings.push({
                issue: {
                  level: 'warning', severity: 'warning', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable',
                  message,
                  suggestion: `在合计值附近补充分项明细（${breakdownText}），使合计数值可逐项核对；分项值必须取自工程量清单原文，不得改动。`,
                },
                matchStart: index,
                matchEnd,
              });
            }
          }
        }
        continue;
      }
      // 合计值与锚点不符：差额命中另一权威条目 → 分项显式/重复计入判定
      // （先检查正文是否已显式列出两项分项——已列出属合法分解展示，不得误报）
      const residual = total - anchor.value;
      // 同名多村组条目排除：差额恰等于同名另一村组条目值属聚合口径（29 村同名条目），
      // 交由聚合闭包（aggregationClosure）判定，避免多村场景每村一条假「分项显式」错误
      const other = candidates.find(entry => entry !== anchor && entry.name !== anchor.name && nearlyEqual(entry.value, residual));
      if (other) {
        const window = markdown.slice(Math.max(0, index - 150), index + match[0].length + 150);
        if (componentShown(window, anchor) && componentShown(window, other)) continue;
        const message = `合计值与权威不符：「${anchor.name}」清单权威 ${anchor.value}${match[2]}；正文 ${total}${match[2]} \u2248 ${anchor.value} + ${other.value}（「${other.name}」）——若「${other.name}」应计入「${anchor.name}」合计，须在正文显式分项；若不应计入（重复计入），须改回权威值 ${anchor.value}${match[2]}`;
        if (!seen.has(message)) {
          seen.add(message);
          findings.push({
            issue: {
              level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable',
              message,
              suggestion: `核对合计口径：「${anchor.name}」合计为 ${anchor.value}${match[2]}（清单权威）。若正文需表达 ${anchor.value} + ${other.value}，则显式写成「${anchor.name} ${anchor.value}${match[2]}、${other.name} ${other.value}${match[2]}，合计 ${total}${match[2]}」；否则将合计改回 ${anchor.value}${match[2]}（差额 ${Math.round(residual * 10000) / 10000}${match[2]} 属「${other.name}」，不得并入）。`,
            },
            matchStart: index,
            matchEnd,
          });
        }
        continue;
      }
      // 差额不属任一单条目：多村组同名聚合 / 跨类别合分项口径闭包（合法聚合展示，不误报）
      if (aggregationClosure(total, unit, context, authority, poolSorted)) continue;
      const message = `合计值与权威不符：「${anchor.name}」合计为 ${anchor.value}${match[2]}（清单权威），正文写 ${total}${match[2]}，且差额不属任何清单条目，需核对合计口径`;
      if (!seen.has(message)) {
        seen.add(message);
        findings.push({
          issue: {
            level: 'warning', severity: 'warning', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable',
            message,
            suggestion: `核对「${anchor.name}」的合计口径：若为多分项之和，请写明与权威一致的分项分解；若为单一总量，改为清单权威值 ${anchor.value}${anchor.unit || match[2]}。`,
          },
          matchStart: index,
          matchEnd,
        });
      }
      continue;
    }
    // 无锚点：分项和候选（多条目聚合，如 557 = 555 + 2）
    const breakdown = findBreakdownComponents(candidates, total, context);
    if (breakdown.length >= 2) {
      const window = markdown.slice(Math.max(0, index - 150), index + match[0].length + 150);
      const missing = breakdown.filter(entry => !componentShown(window, entry));
      if (missing.length > 0) {
        const breakdownText = breakdown.map(entry => `「${entry.name}」${entry.value}${entry.unit}`).join(' + ');
        const message = `合计数值应分项显式：正文合计 ${total}${match[2]} = ${breakdownText}，但未展示分项（缺 ${missing.map(entry => `${entry.name} ${entry.value}${entry.unit}`).join('、')}），无法核对合计来源`;
        if (!seen.has(message)) {
          seen.add(message);
          findings.push({
            issue: {
              level: 'warning', severity: 'warning', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable',
              message,
              suggestion: `在合计值附近补充分项明细（${breakdownText}）；分项值必须取自工程量清单原文，不得改动。`,
            },
            matchStart: index,
            matchEnd,
          });
        }
      }
      continue;
    }
    // 同名条目组和闭合（4.31 丰乐镇 v6 「管沟开挖总量为 12599.51」= 24 条同名村组之和）：
    // 直查不依赖上下文名称重叠——「挖沟槽土方」与「管沟开挖」无 ≥2 字连续子串时
    // aggregationClosure 的相关组和收集会漏收本组（L478 漏网根因）
    {
      const nameSums = new Map<string, number>();
      for (const entry of candidates) nameSums.set(entry.name, (nameSums.get(entry.name) || 0) + entry.value);
      let nameSumHit = false;
      for (const sum of nameSums.values()) {
        if (nearlyEqual(sum, total)) { nameSumHit = true; break; }
      }
      if (nameSumHit) continue;
    }
    // 聚合闭包：多村组同名聚合 / 跨类别合分项（案例：16037.54 = 8205.53 + 7525.01 + 307）
    if (aggregationClosure(total, unit, context, authority, poolSorted)) continue;
    // 无锚点无分项和：合计句数值未命中任何权威口径 → 疑似无源合计（须有类别相关条目在场，否则无法归因不报）
    const related = candidates.filter(entry => nameOverlapsText(entry.name, context));
    const unitMatched = candidates.some(entry => nearlyEqual(entry.value, total));
    const poolHit = authority.numberPool.some(value => nearlyEqual(value, total));
    if (!unitMatched && !poolHit && related.length > 0) {
      const message = `合计值无权威来源：正文「${match[0].trim()}」在清单事实锁与蓝图参数桶中找不到同值来源，违反无据不写`;
      if (seen.has(message)) continue;
      seen.add(message);
      findings.push({
        issue: {
          level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable',
          message,
          suggestion: '删除该合计数值或改为与清单权威一致的合计值；无权威来源的合计数不得进入交付文本。',
        },
        matchStart: index,
        matchEnd,
      });
    }
  }
  return findings;
}

/** 检测端入口（行为保持）：扫描命中只取 issue */
function scanTotalClaims(markdown: string, authority: ReconciliationAuthority): ValidationIssue[] {
  return scanTotalClaimFindings(markdown, authority).map(finding => finding.issue);
}

// ═══════════ 交付前兜底：无源合计确定性删除（r12 丰乐镇门禁 #1/#2 归因） ═══════════
// 终检只报不修（blocker 直坠门禁）：「合计1757㎡」「总量209.49m³」在全稿 LLM 修复轮后仍残留——
// 数值无权威来源、又无唯一可裁决替值（清单无同值条目），不得改写只能删除。按子句边界收拢：
// 左界为分句符时连同分句符删除、右随符保留（「A合计2783㎡，B合计1757㎡，施工」删「，B合计1757㎡」）；
// 左界为句末符/换行时右随分句符一并吞掉（「开挖。弃方总量209.49m³，回填」删「弃方总量209.49m³，」）。
// 边界窗口 60 字、子句长度上限 40 字，超限放弃（保守不误删）；从后往前应用 + 重叠防护。

export interface UnsupportedTotalClaimFixResult {
  markdown: string;
  fixedCount: number;
  details: string[];
}

function unsupportedTotalClaimRemovalSpan(markdown: string, matchStart: number, matchEnd: number): { start: number; end: number; excerpt: string } | null {
  const windowStart = Math.max(0, matchStart - 60);
  const before = markdown.slice(windowStart, matchStart);
  let leftIndex = -1;
  for (let cursor = before.length - 1; cursor >= 0; cursor -= 1) {
    if (/[，、；;。！？!?\n]/u.test(before[cursor])) {
      leftIndex = windowStart + cursor;
      break;
    }
  }
  if (leftIndex === -1 || matchStart - leftIndex > 40) return null;
  const clauseBoundary = /[，、；;]/u.test(markdown[leftIndex]);
  const start = clauseBoundary ? leftIndex : leftIndex + 1;
  const end = clauseBoundary ? matchEnd : matchEnd + (/[，、；;]/u.test(markdown[matchEnd] || '') ? 1 : 0);
  if (end <= start) return null;
  return { start, end, excerpt: markdown.slice(start, end).trim() };
}

/**
 * 无源合计句确定性删除：扫描命中（检测定位=修复定位）中 message 以「合计值无权威来源」开头的
 * blocker 句，按子句边界删除。同形合计句多章复述在扫描层 message 去重（只报首处）——单遍只删
 * 一处，循环复扫至无残留（上限 4 轮防振荡；每轮 markdown 已变化，下一处浮出）。任一 span 超限
 *（边界远/无边界）即跳过该处（保守）；重放时无命中即零变更（幂等零成本）。
 */
export function fixUnsupportedTotalClaims(
  markdown: string,
  input: Pick<FactReconciliationInput, 'billFactLock' | 'blueprintData' | 'factsModel'>,
): UnsupportedTotalClaimFixResult {
  const authority = buildReconciliationAuthority({ markdown, ...input });
  if (authority.entries.length === 0) return { markdown, fixedCount: 0, details: [] };
  let result = markdown;
  const details: string[] = [];
  for (let round = 1; round <= 4; round += 1) {
    const spans: Array<{ start: number; end: number; excerpt: string }> = [];
    for (const finding of scanTotalClaimFindings(result, authority)) {
      if (!finding.issue.message.startsWith('合计值无权威来源')) continue;
      const span = unsupportedTotalClaimRemovalSpan(result, finding.matchStart, finding.matchEnd);
      if (span) spans.push(span);
    }
    if (spans.length === 0) break;
    let applied = 0;
    let lastStart = Number.POSITIVE_INFINITY;
    for (const span of [...spans].sort((left, right) => right.start - left.start)) {
      if (span.end > lastStart) continue;
      result = result.slice(0, span.start) + result.slice(span.end);
      lastStart = span.start;
      applied += 1;
      details.push(`删除无源合计「${span.excerpt.slice(0, 40)}」`);
    }
    if (applied === 0) break;
  }
  return { markdown: result, fixedCount: details.length, details };
}

// ═══════════════════════════ D4.2：规格-数值绑定 ═══════════════════════════

/** 规格候选 token（强规格形态，宁少勿误：管径/标号/钢筋牌号/尺寸年号）：正文侧抽取 */
const SPEC_CANDIDATE_RE = /(?:DN|De|Φ|φ|Ø|dn|de)\s*\d+(?:\.\d+)?|(?<![A-Za-z0-9])[CM]\d{2,3}(?![0-9])|HRB\d+|HPB\d+|(?<![A-Za-z0-9])\d{2,4}\s*[×xX*]\s*\d{2,4}(?![0-9])/gu;

/** 规格-数值绑定命中（结构化）：issue 供检测端照常报告；specToken/value/unit/valueStart/valueEnd/
 * groupSumCandidates 供修复端原位替换（检测定位=修复定位严格同源）。 */
export interface SpecBindingHit {
  issue: ValidationIssue;
  specToken: string;
  value: number;
  unit: string;
  valueStart: number;
  valueEnd: number;
  /** 修复候选：该规格同条目名分组之和（降序去重、排除与正文值近等者）——替换后通过组和/权威值豁免。
   * r17 丰乐镇归因 #B1：DN110 的 15m 无源恰撞无关条目「人行道混凝土垫层 15m³」；组和 7435m
   * （15 个村同名条目 DN110 拆分量之和）为该规格唯一聚合权威口径，替换后检测组和豁免必然通过。 */
  groupSumCandidates: number[];
}

function scanSpecBindingHits(markdown: string, authority: ReconciliationAuthority): SpecBindingHit[] {
  const hits: SpecBindingHit[] = [];
  if (authority.specValues.size === 0) return hits;
  const seen = new Set<string>();
  for (const match of markdown.matchAll(SPEC_CANDIDATE_RE)) {
    const specKey = match[0].replace(/\s+/gu, '').toLowerCase();
    const bound = authority.specValues.get(specKey);
    if (!bound) continue;
    const matchEnd = (match.index ?? 0) + match[0].length;
    const after = markdown.slice(matchEnd, matchEnd + 36);
    const valueMatch = /^([^。；;\n|]{0,16}?)([\d,，]+(?:\.\d+)?)\s*(座|个|套|米|m|km|公里|平方米|m2|㎡|m²|立方米|m3|m³|吨|t|kg)(?![a-zA-Z0-9²³])/u.exec(after);
    if (!valueMatch) continue;
    // 槽位词豁免：规格与数值之间出现埋深/厚度等属性词 → 数值是工艺参数而非该规格工程量
    if (SLOT_WORD_RE.test(valueMatch[1])) continue;
    // 工艺参数约束豁免（4.31 丰乐镇 v6 #2）：「DN25 管不大于 1.0m」的 1.0m 是支架间距的工艺
    // 约束上限（不大于/不超过类），非该规格的清单数量，不得与其他规格数量互比张冠李戴
    if (/不大于|不超过|不得大于|不得超过/.test(valueMatch[1])) continue;
    // 长度量词豁免（r14 丰乐镇 E6 归因）：「DN110 UPVC排水管总长15m」的 15m 是 DN110 管自身的
    // 长度量（生态池段局部量），间隙词含「总长」类长度量词且数值单位为长度类——数值语义上
    // 绑定该规格自身，与其清单总量（7525.01m）天然可不同值；15 恰与无关条目「人行道混凝土
    // 垫层 15m³」数值相等纯属巧合，不构成归属张冠李戴（检测语义为「像别的规格条目的数量」，
    // 长度量词句不满足）。窄化判据：仅间隙词含总长/全长/长度/管长/延米且单位 m/米/km/公里 时
    // 豁免，保「DN200 管道基础 307m」类部位词场景不放过
    if (/总长|全长|长度|管长|延米/u.test(valueMatch[1]) && /^(?:m|米|km|公里)$/u.test(valueMatch[3])) continue;
    const value = parseNumeric(valueMatch[2]);
    if (value === undefined) continue;
    if (bound.some(item => nearlyEqual(item.value, value))) continue;
    // 规格组和豁免：值 = 该规格下同条目名的子组之和（案例：DN400 90m = 混凝土管道铺设条目 DN400 全量之和）
    const entryGroupTotals = new Map<string, number>();
    for (const item of bound) entryGroupTotals.set(item.entryName, (entryGroupTotals.get(item.entryName) || 0) + item.value);
    const groupSums = [...new Set([...entryGroupTotals.values()])].sort((left, right) => right - left);
    if (bound.length >= 2 && groupSums.some(sum => nearlyEqual(sum, value))) continue;
    // 命中其他规格的权威数量 → 张冠李戴（确定性 blocker）
    let foreign: { spec: string; entryName: string } | undefined;
    for (const [otherSpec, items] of authority.specValues) {
      if (otherSpec === specKey) continue;
      const hit = items.find(item => nearlyEqual(item.value, value));
      if (hit) { foreign = { spec: hit.spec || otherSpec, entryName: hit.entryName }; break; }
    }
    if (!foreign) continue;
    // 间隙豁免：规格与数值之间显式点名了其他条目对象（如「DN200 管道基础 307m」在讲基础而非 DN200 数量）
    if (valueMatch[1] && nameOverlapsText(foreign.entryName, valueMatch[1])) continue;
    const message = `规格-数值绑定错位：正文「${match[0]} ${value}${valueMatch[3]}」中 ${value}${valueMatch[3]} 属规格「${foreign.spec}」（清单条目「${foreign.entryName}」），不属于「${match[0]}」的清单数量`;
    if (seen.has(message)) continue;
    seen.add(message);
    const valueStart = matchEnd + valueMatch[1].length;
    hits.push({
      issue: {
        level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable',
        message,
        suggestion: `「${match[0]}」的数量必须引用清单中该规格条目的原值（如 ${bound.map(item => `${item.value}${item.unit}`).join('、')}）；「${foreign.spec}」的数量不得张冠李戴至「${match[0]}」。`,
      },
      specToken: match[0],
      value,
      unit: valueMatch[3],
      valueStart,
      valueEnd: valueStart + valueMatch[2].length,
      groupSumCandidates: groupSums.filter(sum => !nearlyEqual(sum, value)),
    });
  }
  return hits;
}

function scanSpecQuantityBindings(markdown: string, authority: ReconciliationAuthority): ValidationIssue[] {
  return scanSpecBindingHits(markdown, authority).map(hit => hit.issue);
}

export interface SpecQuantityBindingFixResult {
  markdown: string;
  fixedCount: number;
  details: string[];
}

/**
 * 规格-数值绑定错位确定性修复（r17 丰乐镇归因 #B1）：命中处把正文数值原位替换为该规格的组和值
 * （同条目名分组之和降序第一候选；bound 单条目时组和即其唯一权威值——替换后检测端「权威值相等」
 * 或「组和豁免」必然通过）。逐处应用 + 逐处位置复检（同位置 ±4 字容差重扫无残留才保留：同形句
 * 在扫描层 message 去重只报首处，替换后下一处浮出，故不得用「消息集合包含」判定残留；替换只改
 * 数字部分、同位置 valueStart 不变）；上位循环上限 8 轮（同形句多处分布时逐处收敛）。
 * 权威构建不依赖 markdown（billFactLock/blueprintData/factsModel 单源），一次构建全轮复用。
 * 替换后新值又撞其他规格值类外态由复检自动回滚（保守跳过，交 LLM 修复轮）。
 */
export function fixSpecQuantityBindings(
  markdown: string,
  input: Pick<FactReconciliationInput, 'billFactLock' | 'blueprintData' | 'factsModel'>,
): SpecQuantityBindingFixResult {
  const authority = buildReconciliationAuthority({ markdown, ...input });
  if (authority.specValues.size === 0) return { markdown, fixedCount: 0, details: [] };
  let result = markdown;
  const details: string[] = [];
  for (let round = 1; round <= 8; round += 1) {
    const hits = scanSpecBindingHits(result, authority).filter(hit => hit.groupSumCandidates.length > 0);
    if (hits.length === 0) break;
    let applied = 0;
    for (const hit of [...hits].sort((left, right) => right.valueStart - left.valueStart)) {
      const replacement = `${hit.groupSumCandidates[0]}`;
      const next = result.slice(0, hit.valueStart) + replacement + result.slice(hit.valueEnd);
      // 复检：同位置（±4 字容差）重扫不得再命中（替换只改数字部分，同位置 valueStart 不变）
      const residual = scanSpecBindingHits(next, authority).some(item => {
        const offset = item.valueStart - hit.valueStart;
        return offset >= -4 && offset <= 4;
      });
      if (residual) continue;
      result = next;
      applied += 1;
      details.push(`「${hit.specToken}」绑定数值 ${hit.value}${hit.unit} → 组和值 ${replacement}${hit.unit}`);
    }
    if (applied === 0) break;
  }
  return { markdown: result, fixedCount: details.length, details };
}

// ═══════════════════════════ D4.3：数值语义槽位 ═══════════════════════════

/** 埋深/覆土槽位：物理合理范围 <10m，超出即疑似与总长/长度口径混用 */
const SLOT_DEPTH_RE = /(?:埋深|覆土(?:厚度|深度)?|管顶覆土)(?:不小于|不大于|不低于|不超过|约|为|达|控制在|一般|宜|应)?[^。；;\n|]{0,10}?([\d,，]+(?:\.\d+)?)\s*(mm|cm|米|m)(?![a-zA-Z0-9²³])/gu;

function scanSlotSemantics(markdown: string, authority: ReconciliationAuthority): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(SLOT_DEPTH_RE)) {
    const raw = parseNumeric(match[1]);
    if (raw === undefined) continue;
    const unit = match[2];
    const meters = unit === 'mm' ? raw / 1000 : unit === 'cm' ? raw / 100 : raw;
    if (meters <= 10) continue;
    // 若该数值命中权威总长类条目，点名口径来源（增强可解释性）
    const lengthEntry = authority.entries.find(entry =>
      nearlyEqual(entry.value, raw) && /总长|全长|总长度|长度|管线/u.test(entry.name));
    const message = `数值语义槽位错位：正文「${match[0].trim()}」——埋深/覆土数值 ${raw}${unit} 超出物理合理范围（管道埋深一般 <10m）${lengthEntry ? `，且该数值与权威「${lengthEntry.name}」(${lengthEntry.value}${lengthEntry.unit})一致，疑似把总长/长度口径误用作埋深` : '，疑似口径混用'}`;
    if (seen.has(message)) continue;
    seen.add(message);
    issues.push({
      level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable',
      message,
      suggestion: `核对槽位语义：埋深/覆土深度应在 0.3～10m 合理区间（以设计图纸为准）；总长/长度类数值不得用于埋深描述${lengthEntry ? `（「${lengthEntry.name}」为 ${lengthEntry.value}${lengthEntry.unit}）` : ''}。`,
    });
  }
  return issues;
}

// ═══════════════════════════ D4.4：近似数值口径 ═══════════════════════════

/** 近似句：前置「约/近」或后置「N 余」+ 可数/量纲单位（时间/人力单位不纳入：进度与人力编排属文档自述口径） */
const APPROX_PREFIX_RE = /(?:约为|大约|约计|约|将近|近)\s*([\d,，]+(?:\.\d+)?)\s*(点|处|座|个|套|盏|棵|株|樘|扇|根|块|片|组|件|孔|间|栋|幢|户|米|公里|km|m2|㎡|m²|平方米|m3|m³|立方米|kg|吨|t|l|升|kw|w)(?![a-zA-Z0-9²³³])/giu;
const APPROX_SUFFIX_RE = /([\d,，]+(?:\.\d+)?)\s*余\s*(点|处|座|个|套|盏|棵|株|樘|扇|根|块|片|组|件|孔|间|栋|幢|户|米|公里|km|m2|㎡|m²|平方米|m3|m³|立方米|kg|吨|t)(?![a-zA-Z0-9²³])/gu;
/** 前缀「约/近」构词豁免（节约/合约/履约/距离/最近/接近 等词内字符，不构成近似声明） */
const APPROX_PREFIX_EXEMPT_RE = /[节制合履签违公盟密租最接靠邻附距离]/u;

/** 近似可推导判定：精确命中或按量级容差命中权威数字池（百位±5、十位±1、千位±10/2%） */
function approximateDerivable(value: number, pool: number[]): boolean {
  const scaleTolerance = value >= 1000 ? Math.max(10, value * 0.02) : value >= 100 ? 5 : value >= 10 ? 1 : 0.5;
  return pool.some(candidate => Math.abs(candidate - value) <= scaleTolerance || Math.abs(candidate - value) <= Math.max(1e-6, Math.abs(candidate) * 0.02));
}

function scanApproximateClaims(markdown: string, authority: ReconciliationAuthority): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (authority.numberPool.length === 0) return issues;
  const seen = new Set<string>();
  const check = (raw: string, unit: string, whole: string): void => {
    const value = parseNumeric(raw);
    if (value === undefined) return;
    if (approximateDerivable(value, authority.numberPool)) return;
    const message = `近似数值不可推导：正文「${whole.trim()}」的 ${value}${unit} 在清单/蓝图/事实主表中无同值或近似来源，违反无据不写`;
    if (seen.has(message)) return;
    seen.add(message);
    issues.push({
      level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable',
      message,
      suggestion: '删除该近似表述，或改用权威数据可推导的数值（清单/蓝图同值口径）；「约/近」类近似数值必须可闭合到权威来源。',
    });
  };
  for (const match of markdown.matchAll(APPROX_PREFIX_RE)) {
    const at = match.index ?? 0;
    const prefixChar = markdown.slice(Math.max(0, at - 1), at);
    if (APPROX_PREFIX_EXEMPT_RE.test(prefixChar)) continue;
    check(match[1], match[2], match[0]);
  }
  for (const match of markdown.matchAll(APPROX_SUFFIX_RE)) {
    check(match[1], match[2], match[0]);
  }
  return issues;
}

// ═══════════════════════════ D4.6：名称口径 ═══════════════════════════

/** 泛类词黑名单：绑定锚误报面过大，不作为名称-数值绑定锚（宁漏勿错） */
const GENERIC_NAME_RE = /^(?:管道|工程|材料|项目|施工|工作|设备|设施|系统|区域|场地|道路|建筑|结构|基础|主体|管网|土建|安装|装饰|装修|土方|绿化|照明|给水|排水|电气|挖方|填方|回填|弃方|外运|运输|检测|试验|测量|清理|拆除|清淤|维护|养护|管理|服务|其他|以上|以下|其中|包括|采用|使用|型号|规格|数量|单位|合计|总计|长度|面积|体积|重量)$/u;

/** 材质-对象复合词（D4.6 名称替换检测：木门 vs 金属门） */
const MATERIAL_OBJECT_RE = /(木质|木|铝合金|铝|不锈钢|塑钢|塑料|塑|钢|铁|砼|混凝土|铸铁|铜|复合)(门|窗|井|灯|护栏|围栏|盖板|雨水口)/gu;

/** D4.6a 豁免：名称相关组和（正文以更短/更具体名引用清单组，值 = 该组全部条目之和；案例：栽植色带（生态池外围）90m² 实指清单组「栽植色带（生态池外围一圈）」） */
function relatedGroupTotalHit(value: number, name: string, localContext: string, groupTotals: Map<string, number[]>): boolean {
  for (const [groupName, sums] of groupTotals) {
    if (groupName === name) continue;
    if (!groupName.includes(name) && !name.includes(groupName) && !nameOverlapsText(groupName, localContext)) continue;
    if (sums.some(sum => nearlyEqual(sum, value))) return true;
  }
  return false;
}

/** D4.6a 豁免：正文自洽演算（窗口内两数之和/差恰等于该值；案例：总量 8205.53m、其中 7965m、未标规格 240.53m） */
function windowArithmeticHit(markdown: string, at: number, nameLength: number, value: number): boolean {
  const window = markdown.slice(Math.max(0, at - 40), at + nameLength + 40);
  const numbers: number[] = [];
  for (const numMatch of window.matchAll(/\d+(?:\.\d+)?/gu)) {
    const parsed = Number.parseFloat(numMatch[0]);
    if (Number.isFinite(parsed) && !nearlyEqual(parsed, value)) numbers.push(parsed);
  }
  for (let i = 0; i < numbers.length; i += 1) {
    for (let j = i + 1; j < numbers.length; j += 1) {
      if (nearlyEqual(numbers[i] + numbers[j], value)) return true;
      if (nearlyEqual(Math.abs(numbers[i] - numbers[j]), value)) return true;
    }
  }
  return false;
}

/** D4.6a 豁免：同名条目子集和（4.31 丰乐镇 v6 #4-61）：正文绑定值恰为一组同名清单条目（多村组分项）
 * 的子集之和时属聚合口径的正常引用（案例：挖一般土方 4040.45 = 同名 37 条全和 4187.38 − 146.93），
 * 原“同名值集（单条）/组和（整组）”豁免覆盖不到的任意子集被逐条误报「绑定无源」——
 * 丰乐镇 58 条同根因（4040.45/146.93/158.25/572.3/633 五个子集和对不同村组权威循环误报）。
 * meet-in-middle 精确 cents 判定：池上限 40 条防组合爆炸；单元素表示由同名值集豁免覆盖，此处只认
 * ≥2 元素组合（池内存在同值单条即返回 false）。
 * 4.32 扩围（丰乐镇 v6 复测「回填方 4270」44 条放大误报）：同名池超 40 条上限时原实现整体返回
 * false，44 条「回填方」池的 4270 = 3570 + 700（两值组合）失去豁免，命中的每个同名条目逐条误报
 * 「绑定无源」——超限池退化为浅组合判定（正向两值和 / 全和减单值 / 全和减两值和，O(n²) 任意池
 * 大小），深组合（≥3 元素）仍仅对 ≤40 池由 meet-in-middle 判定；浅组合不允许单元素表示。 */
function subsetSumCentsHit(poolCents: number[], targetCents: number): boolean {
  if (poolCents.length < 2 || targetCents <= 0) return false;
  const sorted = [...poolCents].sort((left, right) => left - right);
  if (sorted.some(cents => cents === targetCents)) return false;
  const total = sorted.reduce((sum, cents) => sum + cents, 0);
  if (targetCents > total) return false;
  // 浅组合（任意池大小，O(n²)）：正向两值之和 == target；反向（补集视角）target = 全和 − 单值 /
  // 全和 − 两值之和（即两值之和 == 全和 − target）。补集组合需排除单元素退化：n=2 时“全和 − 单值”
  // 只剩 1 个元素、n=2 时“全和 − 两值和”为空集，均被单值/空集语义排除，此时由同名值集豁免兜底。
  const reverseTarget = total - targetCents;
  if (reverseTarget > 0 && reverseTarget !== targetCents) {
    const ceiling = Math.max(targetCents, reverseTarget);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const pairSum = sorted[i] + sorted[j];
        if (pairSum > ceiling) break;
        if (pairSum === targetCents || pairSum === reverseTarget) return true;
      }
    }
    // 全和 − 单值 == target（n≥3 时为 ≥2 元素组合；n=2 时的单元素情形已被同名值集豁免覆盖）
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] === reverseTarget) return sorted.length >= 3;
      if (sorted[mid] < reverseTarget) lo = mid + 1;
      else hi = mid - 1;
    }
  } else {
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const pairSum = sorted[i] + sorted[j];
        if (pairSum > targetCents) break;
        if (pairSum === targetCents) return true;
      }
    }
  }
  if (sorted.length > 40) return false;
  const half = Math.ceil(sorted.length / 2);
  const first = sorted.slice(0, half);
  const second = sorted.slice(half);
  const sumsOf = (items: number[]): Set<number> => {
    let sums = new Set<number>([0]);
    for (const item of items) {
      const next = new Set<number>();
      for (const partial of sums) {
        next.add(partial);
        next.add(partial + item);
      }
      sums = next;
    }
    return sums;
  };
  const secondSums = sumsOf(second);
  for (const firstSum of sumsOf(first)) {
    if (secondSums.has(targetCents - firstSum)) return true;
  }
  return false;
}

function scanNameBindings(markdown: string, authority: ReconciliationAuthority, lock?: BillFactLock): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const authorityText = authority.entries.map(entry => `${entry.name} ${entry.description}`).join('\n');
  // 名称组和表：按来源分桶求和（D4.6a 同名多村组聚合 / 相关组引用豁免）
  const groupTotals = new Map<string, number[]>();
  {
    const keySums = new Map<string, { name: string; sum: number }>();
    for (const entry of authority.entries) {
      if (!(entry.value > 0)) continue;
      const key = `${entry.source}\u0000${entry.name}`;
      const bucket = keySums.get(key);
      if (bucket) bucket.sum += entry.value;
      else keySums.set(key, { name: entry.name, sum: entry.value });
    }
    for (const bucket of keySums.values()) {
      const list = groupTotals.get(bucket.name) || [];
      list.push(bucket.sum);
      groupTotals.set(bucket.name, list);
    }
  }
  // 同名条目子集和豁免缓存（4.31）：池按「名称|单位」缓存（once per scan），判定结果按
  // 「名称|单位|目标分值」记忆化——同一目标值被同名多条条目在同句重复触发时只算一次
  const subsetPoolCache = new Map<string, number[]>();
  const subsetHitCache = new Map<string, boolean>();
  // 组和补差豁免缓存（4.31）：判定结果按「名称|目标分值」记忆化（同一命中点重复触发只算一次）
  const groupDeltaCache = new Map<string, boolean>();
  const subsetSumExempt = (targetName: string, targetUnit: string, target: number): boolean => {
    const poolKey = `${targetName}\u0000${targetUnit}`;
    let pool = subsetPoolCache.get(poolKey);
    if (!pool) {
      pool = authority.entries
        .filter(entry => entry.name === targetName && normalizeUnit(entry.unit) === targetUnit && entry.value > 0)
        .map(entry => Math.round(entry.value * 100));
      subsetPoolCache.set(poolKey, pool);
    }
    if (pool.length < 2) return false;
    const hitKey = `${poolKey}\u0000${Math.round(target * 100)}`;
    const cached = subsetHitCache.get(hitKey);
    if (cached !== undefined) return cached;
    const hit = subsetSumCentsHit(pool, Math.round(target * 100));
    subsetHitCache.set(hitKey, hit);
    return hit;
  };
  /** D4.6a 豁免：组和补差（4.31 丰乐镇 v6 检查井 557）：正文值 = 同名条目组和 + 权威池任一值
   * （557 = 塑料检查井 25 条组和 555 + 砌筑检查井 2）——跨名称聚合口径的正常引用；
   * 与 aggregationClosure「相关组和 + 补差」同构（单值补差边界，不得放宽为任意两值拼合）。 */
  const groupDeltaExempt = (targetName: string, target: number): boolean => {
    const sums = groupTotals.get(targetName) || [];
    if (sums.length === 0) return false;
    const cacheKey = `${targetName}\u0000${Math.round(target * 100)}`;
    const cached = groupDeltaCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const hit = sums.some(sum => authority.numberPool.some(pool => nearlyEqual(sum + pool, target)));
    groupDeltaCache.set(cacheKey, hit);
    return hit;
  };
  // ── D4.6a 名称-数值绑定（清单条目名 + 紧邻数值对账）──
  if (lock) {
    for (const entry of lock.entries) {
      const name = (entry.name || '').trim();
      if (name.length < 2 || GENERIC_NAME_RE.test(name) || !Number.isFinite(entry.quantity)) continue;
      let from = 0;
      let occurrences = 0;
      while (occurrences < 6) {
        const at = markdown.indexOf(name, from);
        if (at < 0) break;
        from = at + name.length;
        occurrences += 1;
        // 名称尾部数字与后文数值粘连（正文「抹灰面油漆顶棚18.57」被切出「…顶棚1」+「8.57」）→ 该命中无效
        if (/\d$/u.test(name) && /^[\d.]/u.test(markdown.slice(at + name.length, at + name.length + 1))) {
          from = at + 1;
          continue;
        }
        // 构词延续：「回填方量」=「回填方」+「量」的复合词（回填方的方量），非清单名称引用 → 跳过
        // （丰乐镇复测「回填方量为4270m³」被 29 个同名条目逐一误报「名称-数值绑定无源」根因）
        if (markdown.slice(at + name.length, at + name.length + 1) === '量') continue;
        const window = markdown.slice(at + name.length, at + name.length + 20);
        const valueMatch = /^([^。；;\n|]{0,12}?)([\d,，]+(?:\.\d+)?)\s*(座|个|套|处|盏|棵|株|樘|扇|根|块|片|组|件|孔|间|栋|幢|户|米|m|km|公里|平方米|m2|㎡|m²|立方米|m3|m³|kg|吨|t)(?![a-zA-Z0-9²³])/u.exec(window);
        if (!valueMatch) continue;
        if (SLOT_WORD_RE.test(valueMatch[1])) continue;
        const value = parseNumeric(valueMatch[2]);
        if (value === undefined) continue;
        if (nearlyEqual(value, entry.quantity)) continue;
        const unit = normalizeUnit(valueMatch[3]);
        if (unit !== normalizeUnit(entry.unit)) continue;
        // 同名条目值集豁免：同名条目（多村组同名不同值，如 29 村「回填方」）值集中恰有本值 →
        // 正文绑定值命中同名条目的合法数量（自身 quantity 已由上方 nearlyEqual 分支排除），属名称一致的非错位引用
        if (authority.entries.some(other => other.name === name && nearlyEqual(other.value, value) && normalizeUnit(other.unit) === unit)) continue;
        // 同名组和豁免：多村组聚合口径（案例：石桌石凳 8个 = 同名清单条目 1×8 村组之和）
        if ((groupTotals.get(name) || []).some(sum => nearlyEqual(sum, value))) continue;
        // 同名条目子集和豁免（4.31 丰乐镇 v6 #4-61）：正文绑定值恰为一组同名清单条目的子集之和
        //（4040.45 = 同名 37 条全和 4187.38 − 146.93）属聚合口径正常引用，不判「绑定无源」
        if (subsetSumExempt(name, unit, value)) continue;
        // 组和补差豁免（4.31 丰乐镇 v6 检查井 557）：正文值 = 同名条目组和 + 权威池任一值
        if (groupDeltaExempt(name, value)) continue;
        // 数字命中其他条目 + 其他条目名与本地语境重叠 → 正文实际在讲别的条目（豁免）
        // 窗口 32 字：覆盖「挖基坑土方42.12m³、回填方…」型枚举引用（前项 foreign 名可能落在名称前 8 字窗外）
        const localContext = markdown.slice(Math.max(0, at - 32), at + name.length + 20);
        // 名称相关组和豁免：正文以更短/更具体名引用清单组（案例：栽植色带（生态池外围）90m² = 组「栽植色带（生态池外围一圈）」之和）
        if (relatedGroupTotalHit(value, name, localContext, groupTotals)) continue;
        const foreign = authority.entries.find(other =>
          other.name !== name && nearlyEqual(other.value, value) && normalizeUnit(other.unit) === unit);
        if (foreign && nameOverlapsText(foreign.name, localContext)) continue;
        if (foreign) {
          const message = `名称-数值绑定错位：「${name}」处数值 ${value}${valueMatch[3]} 属清单条目「${foreign.name}」（${foreign.value}${foreign.unit}），与「${name}」清单数量 ${entry.quantity}${entry.unit} 不符`;
          if (seen.has(message)) continue;
          seen.add(message);
          issues.push({
            level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable',
            message,
            suggestion: `核对「${name}」的数量口径：清单权威值为 ${entry.quantity}${entry.unit}；引用「${foreign.name}」数量时须明确对象名称，不得张冠李戴。`,
          });
          continue;
        }
        // 正文自洽演算豁免（窗口内两数之和/差恰等于该值：总量 8205.53m、其中 7965m、未标规格 240.53m）
        if (windowArithmeticHit(markdown, at, name.length, value)) continue;
        // 数值不在任何权威条目：与清单条目绑定的名称口径不符且无源 → 疑似笔误/编造
        const poolHit = authority.numberPool.some(candidate => nearlyEqual(candidate, value));
        if (poolHit) continue;
        const message = `名称-数值绑定无源：「${name}」处数值 ${value}${valueMatch[3]} 与清单权威 ${entry.quantity}${entry.unit} 不符，且在全部权威数据中找不到同值来源`;
        if (seen.has(message)) continue;
        seen.add(message);
        issues.push({
          level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable',
          message,
          suggestion: `将「${name}」的数量改为清单权威值 ${entry.quantity}${entry.unit}；无权威来源的数值不得与清单条目名称绑定出现。`,
        });
      }
    }
  }
  // ── D4.6b 材质-对象复合词对账（被替换名称：数量对命中同对象条目）──
  for (const match of markdown.matchAll(MATERIAL_OBJECT_RE)) {
    const compound = match[0];
    if (authorityText.includes(compound)) continue;
    const objectWord = match[2];
    const after = markdown.slice((match.index ?? 0) + compound.length, (match.index ?? 0) + compound.length + 16);
    const valueMatch = /^([^。；;\n|]{0,10}?)([\d,，]+(?:\.\d+)?)\s*(樘|扇|套|座|盏|个)(?![a-zA-Z0-9²³])/u.exec(after);
    if (!valueMatch) continue;
    const value = parseNumeric(valueMatch[2]);
    if (value === undefined) continue;
    const sameObject = authority.entries.find(entry => entry.name.includes(objectWord) && nearlyEqual(entry.value, value) && normalizeUnit(entry.unit) === normalizeUnit(valueMatch[3]));
    if (!sameObject) continue;
    const message = `名称口径不符：正文「${compound} ${value}${valueMatch[3]}」——${value}${valueMatch[3]} 对应清单「${sameObject.name}」条目，清单中不存在「${compound}」，名称与清单权威不符`;
    if (seen.has(message)) continue;
    seen.add(message);
    issues.push({
      level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable',
      message,
      suggestion: `名称必须与清单条目口径一致：将「${compound}」改为「${sameObject.name}」（或清单原文名称）；名称与数量绑定不得自行替换材质/类型限定词。`,
    });
  }
  return issues;
}

// ═══════════════════════════ 汇总出口 ═══════════════════════════

/** 单规则 issue 上限（防极端文档爆量；合计去重后总上限 60） */
const MAX_ISSUES = 60;

/**
 * D4 数值对账六类检测器（终检 standard-final 组）：
 * 输入 = 最终 markdown + 清单事实锁 + 蓝图参数桶 + 事实主表；权威缺失的规则自行跳过。
 */
export function factReconciliationIssues(input: FactReconciliationInput): ValidationIssue[] {
  const markdown = input.markdown || '';
  if (!markdown) return [];
  const authority = buildReconciliationAuthority(input);
  if (authority.entries.length === 0 && authority.numberPool.length === 0) return [];
  const issues: ValidationIssue[] = [
    ...scanTotalClaims(markdown, authority),
    ...scanSpecQuantityBindings(markdown, authority),
    ...scanSlotSemantics(markdown, authority),
    ...scanApproximateClaims(markdown, authority),
    ...scanNameBindings(markdown, authority, input.billFactLock),
  ];
  const deduped: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const key = `${issue.severity || issue.level}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
    if (deduped.length >= MAX_ISSUES) break;
  }
  return deduped;
}
