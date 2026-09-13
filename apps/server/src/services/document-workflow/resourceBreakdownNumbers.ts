/**
 * 资源章数值拆分一致性单源（4.27.0 · 专题 A3）：
 * 检测（qualityValidation.resourceBreakdownConsistencyIssues 薄消费本模块）与修复
 * （fixResourceBreakdownNumbers）收敛为同一扫描源，检测定位=修复定位，防「检测报 N 条/修复只处理首条」
 * 类口径漂移；修复按精确数字区间降序硬替换为蓝图权威值 + 复检，复检仍残留即整体回滚（防改坏正文）。
 *
 * 检测口径保守（宁漏报不误报），三类模式保持十一度既有口径不变，仅新增阶段部署子窗口豁免：
 * 1. 工种构成：工种词后紧邻「数字+人」+ 桥接词白名单 + 群体语境豁免；
 *    + 阶段部署子窗口豁免——块内含「阶段…N人」时以各阶段匹配为界划分子窗口，
 *    窗口内工种宣称合计恰为 N 时属阶段性部署（丰乐镇基线实测「亮化与收尾工程阶段投入43人…普工25人…
 *    混凝土工10人…管道工5人…绿化工3人」，25+10+5+3=43 恰为该阶段总人数，是退场期部署而非全项目
 *    构成漂移，硬替换会破坏真实语义；该段位于劳动力总说明混合大块的末段窗口，整块合计因混有
 *    168/85/216 阶段说明而失配，故按子窗口而非整块判定）。
 * 2. 机械台数：单条目锚定「名称后 ≤2 桥接字 + 数字+台」（禁 12 字无锚定搜索——基线实测
 *    「其中3台」「1台转入」分配语境被误采）；同名多条目按规格词语境单独比对（不互串）。
 * 3. 材料拆分：同名多规格 + 同族单位 + 合计行豁免。
 */
import type { BlueprintData, BlueprintEquipmentItem, BlueprintMaterialPlanItem } from './integratedBlueprint';

export interface ResourceBreakdownAuthority {
  /** 工种构成权威（全项目唯一口径） */
  composition: Array<{ trade: string; count: number }>;
  /** 机械权威（variantCount=同名条目数：>1 走规格语境，=1 走名称语境） */
  equipment: Array<{ name: string; spec: string; count: number; variantCount: number }>;
  /** 同名多规格材料权威（variantCount=同名条目数，恒 ≥2） */
  materials: Array<{ name: string; spec: string; quantity: number; unit: string; family: string; variantCount: number }>;
}

export interface ResourceBreakdownClaim {
  kind: 'trade' | 'equipment' | 'material';
  /** 人类可读标签（issue message 与修复 details 共用） */
  label: string;
  /** 正文数字区间 [start,end)（修复器定点替换，仅替换数字本身） */
  start: number;
  end: number;
  actual: number;
  expected: number;
  message: string;
  suggestion: string;
}

const TRADE_BRIDGE_WORD_RE = /^(?:为|达|共|约|计|配置|共计|总计|合计)$/u;
const TRADE_GROUP_CONTEXT_RE = /作业人员|施工人员|人员配置|班组|施工组|每村|分组|编组|编入|队伍/u;
/** 机械桥接词（名称后 ≤2 字内允许的过渡词；「其中/转入/保留」等分配语境词不在表内——基线误采根因） */
const EQUIPMENT_BRIDGE_WORD_RE = /^(?:为|达|共|约|计|配置|共计|总计|合计|投入|配备|启用)$/u;
/** 材料拆分数量（数字必须从规格词后紧邻位置开始，且携带同族单位后缀；异族单位/无单位数字不参与） */
const MATERIAL_SPLIT_QUANTITY_RE = /^[)）、:：,，\s]{0,2}(?:混凝土|砼)?\s*(\d+(?:\.\d+)?)\s*(m3|m³|立方米|方|m2|m²|㎡|平方米|延长米|米|m|kg|千克|公斤|t|吨|套|个|块|根|只|组|件|片|樘|扇|盏|座|台|处|项|条|副|对|株)(?![A-Za-z0-9²³])/u;
const TRADE_CLAIM_RE = /^([^0-9]{0,2}?)(\d+(?:\.\d+)?)\s*人/u;
const EQUIPMENT_CLAIM_RE = /^([^0-9]{0,2}?)(\d+(?:\.\d+)?)\s*台/u;
const STAGE_LABOR_TOTAL_RE = /阶段[^。；\n]{0,30}?(\d+(?:\.\d+)?)\s*人/u;

function materialUnitFamily(unit: string): string | null {
  const text = (unit || '').replace(/\s+/gu, '');
  if (!text) return null;
  if (/m[3³]|立方米|方/u.test(text)) return 'volume';
  if (/m[2²]|㎡|平方米/u.test(text)) return 'area';
  if (/m|米/u.test(text)) return 'length';
  if (/吨|千克|公斤|kg|^t$/u.test(text)) return 'mass';
  if (/套|个|块|根|只|组|件|片|樘|扇|盏|座|台|处|项|条|副|对|株/u.test(text)) return 'count';
  return null;
}

function equipmentCount(item: BlueprintEquipmentItem): number {
  return item.quantity && item.quantity > 0 ? item.quantity : Math.round(((item.min ?? 1) + (item.max ?? item.min ?? 1)) / 2);
}

/** 蓝图 → 权威口径（无蓝图返回 undefined，检测/修复一致静默跳过） */
export function buildResourceBreakdownAuthority(blueprintData?: BlueprintData): ResourceBreakdownAuthority | undefined {
  if (!blueprintData) return undefined;
  const composition = (blueprintData.resources?.labor?.composition ?? [])
    .filter(item => item.trade && Number.isFinite(item.count) && item.count > 0)
    .map(item => ({ trade: item.trade, count: item.count }));
  const equipmentByName = new Map<string, BlueprintEquipmentItem[]>();
  for (const item of blueprintData.resources?.equipment ?? []) {
    if (!item.name) continue;
    const group = equipmentByName.get(item.name);
    if (group) group.push(item);
    else equipmentByName.set(item.name, [item]);
  }
  const equipment: ResourceBreakdownAuthority['equipment'] = [];
  for (const [name, items] of equipmentByName) {
    for (const item of items) {
      const count = equipmentCount(item);
      if (!Number.isFinite(count) || count <= 0) continue;
      equipment.push({ name, spec: item.spec || '', count, variantCount: items.length });
    }
  }
  const materialsByName = new Map<string, BlueprintMaterialPlanItem[]>();
  for (const item of blueprintData.materialsPlan ?? []) {
    if (!item.name) continue;
    const group = materialsByName.get(item.name);
    if (group) group.push(item);
    else materialsByName.set(item.name, [item]);
  }
  const materials: ResourceBreakdownAuthority['materials'] = [];
  for (const [name, items] of materialsByName) {
    if (items.length < 2) continue;
    for (const item of items) {
      if (!item.spec || !Number.isFinite(item.quantity) || (item.quantity ?? 0) <= 0) continue;
      const family = materialUnitFamily(item.unit || '');
      if (!family) continue;
      materials.push({ name, spec: item.spec, quantity: item.quantity as number, unit: item.unit || '', family, variantCount: items.length });
    }
  }
  return { composition, equipment, materials };
}

interface TextBlock {
  start: number;
  end: number;
}

/** 段落块切分：空行/标题行/表格行/引用行为边界，连续正文行合并为一段（阶段部署豁免的判定单元） */
function splitParagraphBlocks(markdown: string): TextBlock[] {
  const lines: TextBlock[] = [];
  let from = 0;
  while (from <= markdown.length) {
    const nl = markdown.indexOf('\n', from);
    const end = nl === -1 ? markdown.length : nl;
    lines.push({ start: from, end });
    if (nl === -1) break;
    from = nl + 1;
  }
  const boundaryRe = /^\s*(?:#|\||>)/u;
  const blocks: TextBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const text = markdown.slice(line.start, line.end);
    if (text.trim() === '' || boundaryRe.test(text)) {
      index += 1;
      continue;
    }
    let last = index;
    while (last + 1 < lines.length) {
      const next = lines[last + 1];
      const nextText = markdown.slice(next.start, next.end);
      if (nextText.trim() === '' || boundaryRe.test(nextText)) break;
      last += 1;
    }
    blocks.push({ start: line.start, end: lines[last].end });
    index = last + 1;
  }
  return blocks;
}

/** 检出全部偏离处（检测与修复共用单一扫描；修复器按 start/end 定点替换） */
export function scanResourceBreakdownClaims(markdown: string, authority: ResourceBreakdownAuthority): ResourceBreakdownClaim[] {
  const claims: ResourceBreakdownClaim[] = [];
  const allTrades = new Set(authority.composition.map(item => item.trade));
  /** 无前置边界检查：「配置挖掘机」的「置」是合法动词语境 */
  const findOccurrences = (text: string, word: string): number[] => {
    const positions: number[] = [];
    if (!word) return positions;
    let from = 0;
    while (from < text.length) {
      const idx = text.indexOf(word, from);
      if (idx === -1) break;
      positions.push(idx);
      from = idx + word.length;
    }
    return positions;
  };
  /** 工种词扫描：前字为汉字时仅当「前字+词」构成词表中更长的复合词（钢筋混凝土工 ⊃ 混凝土工）才跳过 */
  const findTradeOccurrences = (text: string, word: string): number[] => {
    const positions: number[] = [];
    if (!word) return positions;
    let from = 0;
    while (from < text.length) {
      const idx = text.indexOf(word, from);
      if (idx === -1) break;
      const prev = text[idx - 1] || '';
      const extended = `${prev}${word}`;
      if (/[\u4e00-\u9fa5]/u.test(prev) && [...allTrades].some(trade => trade.length > word.length && trade.includes(extended))) {
        from = idx + word.length;
        continue;
      }
      positions.push(idx);
      from = idx + word.length;
    }
    return positions;
  };
  // 阶段部署子窗口豁免：以块内各「阶段…N人」匹配为界划分子窗口（[本阶段匹配起点, 下一阶段匹配或块尾)），
  // 窗口内工种宣称合计恰为 N → 该窗口属阶段性部署（硬替换会破坏「43 人阶段含 88 混凝土工」类语义）。
  // 基线实测 43 人部署明细位于劳动力总说明混合大块末段（块内另有 168/85/216 阶段说明），
  // 整块合计失配，故按子窗口判定。
  const blocks = splitParagraphBlocks(markdown);
  const exemptWindows: TextBlock[] = [];
  for (const block of blocks) {
    const blockText = markdown.slice(block.start, block.end);
    if (!blockText.includes('阶段')) continue;
    const stages: Array<{ start: number; total: number }> = [];
    for (const match of blockText.matchAll(new RegExp(STAGE_LABOR_TOTAL_RE.source, 'gu'))) {
      stages.push({ start: block.start + (match.index ?? 0), total: Number(match[1]) });
    }
    if (stages.length === 0) continue;
    for (const [stageIndex, stage] of stages.entries()) {
      const windowStart = stage.start;
      const windowEnd = stages[stageIndex + 1]?.start ?? block.end;
      const windowText = markdown.slice(windowStart, windowEnd);
      let sum = 0;
      for (const trade of allTrades) {
        for (const idx of findTradeOccurrences(windowText, trade)) {
          const after = windowText.slice(idx + trade.length, idx + trade.length + 12);
          const match = TRADE_CLAIM_RE.exec(after);
          if (!match) continue;
          if (match[1] && !TRADE_BRIDGE_WORD_RE.test(match[1])) continue;
          sum += Number(match[2]);
        }
      }
      if (sum > 0 && sum === stage.total) exemptWindows.push({ start: windowStart, end: windowEnd });
    }
  }
  const isExemptAt = (offset: number): boolean => exemptWindows.some(window => offset >= window.start && offset < window.end);
  // 1. 工种构成：trade 后紧邻「数字+人」≠ 权威 count → claim
  for (const item of authority.composition) {
    for (const idx of findTradeOccurrences(markdown, item.trade)) {
      if (isExemptAt(idx)) continue;
      const before = markdown.slice(0, idx);
      const sentenceStart = Math.max(before.lastIndexOf('。'), before.lastIndexOf('；'), before.lastIndexOf(';'), before.lastIndexOf('\n'));
      if (TRADE_GROUP_CONTEXT_RE.test(before.slice(sentenceStart + 1))) continue;
      const after = markdown.slice(idx + item.trade.length, idx + item.trade.length + 12);
      const match = TRADE_CLAIM_RE.exec(after);
      if (!match) continue;
      if (match[1] && !TRADE_BRIDGE_WORD_RE.test(match[1])) continue;
      const actual = Number(match[2]);
      if (actual === item.count) continue;
      const numStart = idx + item.trade.length + match[1].length;
      claims.push({
        kind: 'trade',
        label: `工种构成 ${item.trade}`,
        start: numStart,
        end: numStart + match[2].length,
        actual,
        expected: item.count,
        message: `工种构成人数与蓝图权威不一致：${item.trade} 正文 ${actual} 人，蓝图权威 ${item.count} 人`,
        suggestion: '工种构成表必须与蓝图工种构成唯一口径一致，各工种人数不得自行改写。',
      });
    }
  }
  // 2. 机械台数：单条目锚定名称语境（≤2 桥接字内紧邻 数字+台）；同名多条目按规格词语境单独比对
  for (const item of authority.equipment) {
    if (item.variantCount === 1) {
      for (const idx of findOccurrences(markdown, item.name)) {
        const after = markdown.slice(idx + item.name.length, idx + item.name.length + 12);
        const match = EQUIPMENT_CLAIM_RE.exec(after);
        if (!match) continue;
        if (match[1] && !EQUIPMENT_BRIDGE_WORD_RE.test(match[1])) continue;
        const actual = Number(match[2]);
        if (actual === item.count) continue;
        const numStart = idx + item.name.length + match[1].length;
        claims.push({
          kind: 'equipment',
          label: `机械台数 ${item.name}`,
          start: numStart,
          end: numStart + match[2].length,
          actual,
          expected: item.count,
          message: `机械台数与蓝图权威不一致：${item.name} 正文 ${actual} 台，蓝图权威 ${item.count} 台`,
          suggestion: '机械投入计划必须与蓝图机械清单一致，台数不得自行改写。',
        });
      }
    } else if (item.spec) {
      for (const specIdx of findOccurrences(markdown, item.spec)) {
        const lineStart = markdown.lastIndexOf('\n', specIdx) + 1;
        let lineEnd = markdown.indexOf('\n', specIdx);
        if (lineEnd === -1) lineEnd = markdown.length;
        const line = markdown.slice(lineStart, lineEnd);
        const lineOffset = specIdx - lineStart;
        const sentenceStart = lineStart + Math.max(line.lastIndexOf('，', lineOffset) + 1, line.lastIndexOf('。', lineOffset) + 1, line.lastIndexOf('；', lineOffset) + 1);
        if (!markdown.slice(sentenceStart, lineEnd).includes(item.name)) continue;
        const afterStart = specIdx + item.spec.length;
        const after = markdown.slice(afterStart, afterStart + 12);
        const match = /(\d+(?:\.\d+)?)\s*台/u.exec(after);
        if (!match) continue;
        const actual = Number(match[1]);
        if (actual === item.count) continue;
        const numStart = afterStart + (match.index ?? 0);
        claims.push({
          kind: 'equipment',
          label: `机械台数 ${item.name}（${item.spec}）`,
          start: numStart,
          end: numStart + match[1].length,
          actual,
          expected: item.count,
          message: `机械台数与蓝图权威不一致：${item.name}（${item.spec}） 正文 ${actual} 台，蓝图权威 ${item.count} 台`,
          suggestion: '机械投入计划必须与蓝图机械清单一致，台数不得自行改写。',
        });
      }
    }
  }
  // 3. 材料同名多规格拆分：spec 后紧邻「数字+同族单位」≠ 该规格权威数量 → claim（合计/小计行豁免）
  for (const item of authority.materials) {
    for (const specIdx of findOccurrences(markdown, item.spec)) {
      const lineStart = markdown.lastIndexOf('\n', specIdx) + 1;
      let lineEnd = markdown.indexOf('\n', specIdx);
      if (lineEnd === -1) lineEnd = markdown.length;
      const line = markdown.slice(lineStart, lineEnd);
      if (/^\s*\|?\s*(?:合计|小计|总计|累计)/u.test(line)) continue;
      if (!line.includes(item.name)) continue;
      const afterStart = specIdx + item.spec.length;
      const after = markdown.slice(afterStart, afterStart + 16);
      const match = MATERIAL_SPLIT_QUANTITY_RE.exec(after);
      if (!match) continue;
      if (materialUnitFamily(match[2]) !== item.family) continue;
      const actual = Number(match[1]);
      if (actual === item.quantity) continue;
      const numStart = afterStart + match[0].indexOf(match[1]);
      claims.push({
        kind: 'material',
        label: `材料拆分 ${item.name}（${item.spec}）`,
        start: numStart,
        end: numStart + match[1].length,
        actual,
        expected: item.quantity,
        message: `材料规格拆分数量与蓝图权威不一致：${item.name}（${item.spec}）正文 ${actual}${item.unit}，蓝图权威 ${item.quantity}${item.unit}`,
        suggestion: '同名多规格材料的拆分数量必须与清单逐项一致，不得自行分配。',
      });
    }
  }
  return claims;
}

/** 确定性修复：按数字区间降序硬替换为蓝图权威值 + 复检（复检仍残留即整体回滚，返回原文本） */
export function fixResourceBreakdownNumbers(markdown: string, authority?: ResourceBreakdownAuthority): { markdown: string; fixedCount: number; details: string[]; residualCount: number } {
  if (!authority) return { markdown, fixedCount: 0, details: [], residualCount: 0 };
  const claims = scanResourceBreakdownClaims(markdown, authority);
  if (claims.length === 0) return { markdown, fixedCount: 0, details: [], residualCount: 0 };
  const sorted = [...claims].sort((left, right) => right.start - left.start);
  let result = markdown;
  const applied: ResourceBreakdownClaim[] = [];
  let boundary = Number.POSITIVE_INFINITY;
  for (const claim of sorted) {
    if (claim.end > boundary) continue; // 区间重叠防护（理论不发生；保守跳过）
    result = `${result.slice(0, claim.start)}${claim.expected}${result.slice(claim.end)}`;
    applied.push(claim);
    boundary = claim.start;
  }
  const residual = scanResourceBreakdownClaims(result, authority);
  if (residual.length > 0) return { markdown, fixedCount: 0, details: [], residualCount: residual.length };
  return { markdown: result, fixedCount: applied.length, details: applied.map(claim => `${claim.label} ${claim.actual}→${claim.expected}`), residualCount: 0 };
}
