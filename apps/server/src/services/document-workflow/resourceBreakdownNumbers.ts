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
 *
 * + C-T4 跨章机械矩阵共用抽取（scanEquipmentCountClaims / normalizeEquipmentClaimName /
 *   equipmentNameAtEndOf）：constructionOrgConsistency 机械数量型号规则（资料事实对账）与
 *   qualityValidation 跨章机械互斥（正文多值，进修复链）共用名称归一单源，避免检测口径漂移。
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

// ═══════════════════════════ C-T4 机械台数宣称抽取（跨章一致性矩阵单一扫描源） ═══════════════════════════
// 机械名从固定词表泛化为通用抽取（2~8 字、以 机/吊/泵/车/夯 结尾 + 虚词截断归一 + 量词残留/片段拦截 +
// 备用租赁辅助配置丢弃 + 否定分句豁免）：constructionOrgConsistency 机械数量型号规则与
// qualityValidation 跨章机械矩阵共用，检测定位与名称归一单源。

export interface EquipmentCountClaim {
  /** 归一化机械名（多值互斥/资料事实对账的键） */
  name: string;
  /** 原始捕获名（含被截断的上下文前缀；展示取最短者） */
  raw: string;
  count: number;
  /** 匹配起点（配套比/分组语境等位置判定使用） */
  start: number;
  /** 完整匹配文本（含名称、桥接与数字单位） */
  text: string;
}

/** 机械名后缀（含蛙夯：与既有质量门禁词表口径一致） */
const EQUIPMENT_NAME_SUFFIX_SOURCE = '机|吊|泵|车|夯';
/** 机械名前导虚词/动词截断集：贪婪捕获吞入谓语时取最后一个虚词之后的剩余部分为名。
 * 不含自/起/重/装/载/挖/掘等设备名用字；「配套/备用/其中/其余/阶段/标段」类前缀由此归位 */
const EQUIPMENT_NAME_PREFIX_STOP_RE = /[为配置备启投拟需计划增租赁购采设进出按据由从向对把被使等该此其每各和与及或在是将宜并可未非不另又还有部现中套余的用入要场阶段]/u;
/** 首字即量词的名（「台挖掘机」「组挖掘机」等每台X配套结构的截断残留）非设备名，丢弃 */
const EQUIPMENT_NAME_QUANTIFIER_PREFIX_RE = /^(?:[台辆部具个组米吨座])/u;
/** 非设备名片段（「主力机」类谓语残留）丢弃 */
const EQUIPMENT_NAME_FRAGMENT_RE = /^(?:主力|主要|常用|配套|相关|专用|通用|各类|多种|其余|剩余|上述|前者|后者)/u;
/** 辅助配置前缀（备用/租赁/租用）：与主配置台数合法并存，不参与口径对账与互斥（宁漏报不误报） */
const EQUIPMENT_AUXILIARY_PREFIX_RE = /(?:备用|租赁|租用)/u;
/** 否定语境（不使用/无需…）是合理技术决策非配置声明，所在分句不采宣称 */
const EQUIPMENT_CLAIM_NEGATION_RE = /不使用|不采用|不配置|无需|未采用|不得使用|禁止使用/u;
/** 文末机械名（资料事实短值「塔式起重机」类形态；无 /g，可安全共享） */
const EQUIPMENT_NAME_END_RE = new RegExp(`([\\p{Script=Han}A-Za-z0-9]{2,8}(?:${EQUIPMENT_NAME_SUFFIX_SOURCE}))$`, 'u');

/** 机械名归一：undefined 表示该捕获非设备名（量词残留/片段/辅助配置），调用方丢弃 */
export function normalizeEquipmentClaimName(captured: string): string | undefined {
  const cleaned = captured.replace(/\s+/gu, '');
  let name = cleaned;
  for (let index = cleaned.length - 1; index >= 0; index -= 1) {
    if (!EQUIPMENT_NAME_PREFIX_STOP_RE.test(cleaned[index])) continue;
    if (EQUIPMENT_AUXILIARY_PREFIX_RE.test(cleaned.slice(0, index + 1))) return undefined;
    name = cleaned.slice(index + 1);
    break;
  }
  if (name.length < 2) return undefined;
  if (EQUIPMENT_NAME_QUANTIFIER_PREFIX_RE.test(name)) return undefined;
  if (EQUIPMENT_NAME_FRAGMENT_RE.test(name)) return undefined;
  return name;
}

/** 机械台数宣称扫描：名称（2~8 字，机/吊/泵/车/夯 结尾）+ ≤12 桥接字（禁跨句读/顿逗/表格竖线）
 * + 数字 + 台/套/辆；名称经虚词截断归一，否定分句不采（正文与资料事实短值共用） */
export function scanEquipmentCountClaims(text: string): EquipmentCountClaim[] {
  const claims: EquipmentCountClaim[] = [];
  const pattern = new RegExp(`([\\p{Script=Han}A-Za-z0-9]{2,8}(?:${EQUIPMENT_NAME_SUFFIX_SOURCE}))[^\\d。；;\\n|、，]{0,12}(\\d+)\\s*(?:台|套|辆)`, 'gu');
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const clauseStart = Math.max(
      text.lastIndexOf('，', start), text.lastIndexOf('。', start), text.lastIndexOf('；', start),
      text.lastIndexOf(';', start), text.lastIndexOf('\n', start), text.lastIndexOf('、', start),
    );
    // 否定窗口延伸至名称捕获尾部（「无需另配发电机 1 台」的「无需」在捕获内部）
    if (EQUIPMENT_CLAIM_NEGATION_RE.test(text.slice(clauseStart + 1, start + match[1].length))) continue;
    const name = normalizeEquipmentClaimName(match[1]);
    if (!name) continue;
    const count = Number(match[2]);
    if (!Number.isFinite(count) || count <= 0) continue;
    claims.push({ name, raw: match[1], count, start, text: match[0] });
  }
  return claims;
}

/** 纯机械名集合抽取（声明句归因等语境判定使用）：与 scanEquipmentCountClaims 同一名称后缀模式
 * 与同一归一函数单源——C8-7 归因（「本组配置8台，按全项目总表调度」的设备名与计数同句但不邻接，
 * 计数不进入 claim 扫描）依赖本函数从整句文本识别设备名，不要求台数邻接。 */
export function scanEquipmentNamesIn(text: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(`([\\p{Script=Han}A-Za-z0-9]{2,8}(?:${EQUIPMENT_NAME_SUFFIX_SOURCE}))`, 'gu');
  for (const match of text.matchAll(pattern)) {
    const name = normalizeEquipmentClaimName(match[1]);
    if (name) found.add(name);
  }
  return [...found];
}

/** 文末机械名识别（资料事实短值「塔式起重机」类形态）；无匹配或非设备名返回 undefined */
export function equipmentNameAtEndOf(text: string): string | undefined {
  const match = EQUIPMENT_NAME_END_RE.exec(text);
  if (!match) return undefined;
  return normalizeEquipmentClaimName(match[1]);
}

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
      // 4.31 名称段校验（丰乐镇 v6 #72）：名称归属必须落在 spec 同句——原实现仅校验整行含名称，
      // 「给、排水附（配）件 6 个（组）；水表 DN50 1 组（个）」中水表的「DN50 1 组」被误归到
      // 同行首侧材料名下（正文 1 vs 蓝图 4 假冲突）；按句读分隔切句，spec 所在句须含名称
      const lineOffset = specIdx - lineStart;
      const prevBreak = Math.max(line.lastIndexOf('；', lineOffset), line.lastIndexOf(';', lineOffset), line.lastIndexOf('。', lineOffset));
      const sentenceStart = lineStart + prevBreak + 1;
      const nextSemicolon = line.indexOf('；', lineOffset);
      const nextHalfSemicolon = line.indexOf(';', lineOffset);
      const nextPeriod = line.indexOf('。', lineOffset);
      const nextBreak = Math.min(nextSemicolon === -1 ? line.length : nextSemicolon, nextHalfSemicolon === -1 ? line.length : nextHalfSemicolon, nextPeriod === -1 ? line.length : nextPeriod);
      if (!markdown.slice(sentenceStart, lineStart + nextBreak).includes(item.name)) continue;
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
