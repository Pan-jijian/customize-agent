import type { DocumentFactsModel, ValidationIssue } from './types';
import { documentTextLength } from './budget';
import { stringifyFactValue } from './utils';

/**
 * 文档数据与逻辑一致性校验器组（外部验收报告 8 风险点对应的确定性防线）：
 * 编造开工日期 / 字段-数值错配 / 面积算术矛盾 / 劳动力口径矛盾 / 支护体系并存 /
 * 危大清单不一致 / 六个百分百逐项覆盖 / 段首机械重复 / 闭环句式密度上限 / 自伤表述候选。
 *
 * 分层定位（四层分离架构）：
 * - 数值类检测（错配/算术/劳动力）= L2 算术层：确定性数值比较，与正则精判无关，零误伤；
 * - 格式封闭类（日期格式/编号清单）= L1 结构提取：格式有限确定，正则合适；
 * - 语义类（自伤表述）= L1 字面召回 + 修复轮 LLM 判定改写（语义判断归 LLM，不在校验器内用正则定性）。
 */

// ── 1. 编造开工日期检测（R5）：招标以开工令为准时，正文不得自设具体日历日期 ──

const CALENDAR_DATE_RE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/gu;
const RESOURCE_DATE_LIKE_ANCHOR_RE = /进度计划|里程碑|节点安排|验收时间|完成日期|竣工日期|移交日期|合同签订/u;

/** 收集 factsModel 中出现的全部具体日历日期（绑定资料中明确给出的日期才是合法日期） */
function knownCalendarDates(factsModel: DocumentFactsModel): Set<string> {
  const dates = new Set<string>();
  const texts = [
    ...factsModel.project,
    ...factsModel.schedule,
    ...factsModel.quality,
    ...factsModel.resources,
    ...factsModel.preciseFacts,
  ].map(fact => `${fact.key || ''}${fact.fieldName || ''}${stringifyFactValue(fact.value)}`);
  for (const text of texts) {
    for (const match of text.matchAll(CALENDAR_DATE_RE)) {
      dates.add(`${match[1]}年${match[2]}月${match[3]}日`);
    }
  }
  return dates;
}

export function fabricatedStartDateIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const knownDates = knownCalendarDates(factsModel);
  // 绑定资料已给出具体日期时，正文使用资料日期合法；此时不做编造检测
  const scheduleTexts = [...factsModel.schedule, ...factsModel.project].map(fact => `${fact.key || ''}${stringifyFactValue(fact.value)}`).join(' ');
  const hasMaterialDates = CALENDAR_DATE_RE.test(scheduleTexts);
  CALENDAR_DATE_RE.lastIndex = 0;
  for (const match of markdown.matchAll(CALENDAR_DATE_RE)) {
    const date = `${match[1]}年${match[2]}月${match[3]}日`;
    if (knownDates.has(date)) continue;
    const start = Math.max(0, (match.index || 0) - 40);
    const context = markdown.slice(start, (match.index || 0) + date.length + 40);
    if (hasMaterialDates) {
      // 资料已有其他日期但正文出现资料外日期：仍属编造；仅进度计划类节点日期可由工期推导（合法，跳过）
      if (RESOURCE_DATE_LIKE_ANCHOR_RE.test(context)) continue;
    }
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `正文编造开工日期“${date}”：绑定资料未提供该具体日历日期（招标文件以开工令时间为准）`,
      suggestion: `删除自行设定的具体日期，统一改写为“以开工令时间为准”；如为进度计划节点日期，必须标注为计划推算节点并保持与总工期一致。`,
    });
  }
  return issues.slice(0, 3);
}

// ── 2. 字段-数值错配检测（R3）：总占地面积值被误标为单体建筑面积等相近槽位 ──

/** 提取事实文本中的“标签+数值”对（建设规模域） */
function scopeValuePairs(factsModel: DocumentFactsModel): Array<{ label: string; value: number }> {
  const pairs: Array<{ label: string; value: number }> = [];
  const texts = [...factsModel.project, ...factsModel.preciseFacts].map(fact => `${fact.fieldName || fact.key || ''}：${stringifyFactValue(fact.value)}`);
  for (const text of texts) {
    const label = /(总占地面积|占地面积|单体建筑面积|总建筑面积|建筑面积|地上建筑面积|地下建筑面积|总用地面积)/u.exec(text)?.[1];
    const valueMatch = /([\d,]+(?:\.\d+)?)\s*(?:㎡|m2|m²|平方米)/u.exec(text);
    if (!label || !valueMatch) continue;
    const value = Number(valueMatch[1].replace(/[,，]/gu, ''));
    if (Number.isFinite(value) && value > 0) pairs.push({ label, value });
  }
  return pairs;
}

const BODY_LABEL_VALUE_RE = /(单体建筑面积|总建筑面积|建筑面积)[^。；;\n]{0,30}?([\d,]+(?:\.\d+)?)\s*(?:㎡|m2|m²|平方米)/gu;

export function fieldValueMismatchIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const pairs = scopeValuePairs(factsModel);
  const siteAreaValues = new Set(pairs.filter(pair => /占地面积/u.test(pair.label)).map(pair => pair.value));
  const buildingAreaValues = new Set(pairs.filter(pair => /建筑面积/u.test(pair.label) && !/地上|地下/u.test(pair.label)).map(pair => pair.value));
  if (siteAreaValues.size === 0 || buildingAreaValues.size === 0) return issues;
  // 正文中“单体建筑面积/总建筑面积 X㎡”的 X 恰等于“总占地面积”值且不等于任一“建筑面积”值时：槽位混淆
  for (const match of markdown.matchAll(BODY_LABEL_VALUE_RE)) {
    const value = Number(match[2].replace(/[,，]/gu, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    if (!siteAreaValues.has(value)) continue;
    if (buildingAreaValues.has(value)) continue;
    const label = match[1];
    const correctValues = [...buildingAreaValues].join('、');
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `字段-数值错配：“${label} ${match[2]}㎡”将总占地面积误作${label}（绑定资料${label}口径为 ${correctValues}㎡）`,
      suggestion: `总占地面积与建筑面积是两个独立字段，必须严格区分：将“${label} ${match[2]}㎡”改为资料口径“${label} ${correctValues}㎡”，总占地面积保持独立表述。`,
    });
  }
  return issues.slice(0, 3);
}

// ── 3. 面积算术一致性（R3 子项）：同一语句内 地上+地下 与 总/单体面积 必须自洽 ──

const AREA_TRIPLE_RE = /(地上[^。；;\n]{0,30}?([\d,]+(?:\.\d+)?)\s*(?:㎡|m2|m²|平方米)[^。；;\n]{0,40}?地下[^。；;\n]{0,30}?([\d,]+(?:\.\d+)?)\s*(?:㎡|m2|m²|平方米)[^。；;\n]{0,60}?(?:单体建筑面积|总建筑面积)[^。；;\n]{0,20}?([\d,]+(?:\.\d+)?)\s*(?:㎡|m2|m²|平方米))/gu;

export function areaArithmeticIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const match of markdown.matchAll(AREA_TRIPLE_RE)) {
    const above = Number(match[2].replace(/[,，]/gu, ''));
    const underground = Number(match[3].replace(/[,，]/gu, ''));
    const total = Number(match[4].replace(/[,，]/gu, ''));
    if (![above, underground, total].every(Number.isFinite)) continue;
    const sum = above + underground;
    const tolerance = Math.max(1, total * 0.001);
    if (Math.abs(sum - total) > tolerance) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `面积算术矛盾：地上 ${above}㎡ + 地下 ${underground}㎡ = ${sum}㎡，与同句“单体建筑面积 ${total}㎡”不符（差 ${Math.abs(sum - total).toFixed(2)}㎡）`,
        suggestion: `地上与地下面积之和必须等于单体建筑面积：按绑定资料口径统一三者数值，删除错误数值表述。`,
      });
    }
  }
  return issues.slice(0, 3);
}

// ── 4. 劳动力口径一致性（R4）：正文“高峰期 X 人”与分阶段明细表最大峰值必须同口径 ──

const PEAK_LABOR_RE = /(?:高峰期|高峰|峰值)[^。；;\n]{0,20}?(?:约)?\s*([\d,]+)\s*人/g;

/** 从 markdown 表格中提取劳动力分阶段表格的人数单元格（表格含“阶段+人数”两列时） */
function tablePeakLabor(markdown: string): number | undefined {
  let peak: number | undefined;
  const lines = markdown.split(/\r?\n/u);
  const tableRowLineRe = /^\|.+\|$/u;
  for (let index = 0; index < lines.length; index += 1) {
    if (!tableRowLineRe.test(lines[index].trim())) continue;
    // 逐行聚合连续表格行为同一表格块：按“| 前换行”切块会把每个表格行切成独立块（每块 1 行），
    // 峰值提取整体失效——历史缺陷；聚合口径与 qualityValidation.markdownTables 保持一致
    const rows: string[] = [];
    while (index < lines.length && tableRowLineRe.test(lines[index].trim())) {
      rows.push(lines[index].trim());
      index += 1;
    }
    index -= 1;
    if (rows.length < 2) continue;
    // 劳动力阶段表特征：必须含“阶段/工种”语境且任一行含“高峰/人数”；
    // “岗位 | 人数”式岗位配置表（施工员 3 人等）不是分阶段投入明细表，排除
    const joined = rows.join('\n');
    if (!/阶段|工种/u.test(joined)) continue;
    if (!/高峰|峰值|人数/u.test(joined)) continue;
    if (/岗位/u.test(joined)) continue;
    for (const row of rows) {
      for (const cell of row.split('|').map(item => item.trim())) {
        const match = /^([\d,]+)\s*人?$/u.exec(cell);
        if (!match) continue;
        const value = Number(match[1].replace(/[,，]/gu, ''));
        if (Number.isFinite(value) && value > 0 && (peak === undefined || value > peak)) peak = value;
      }
    }
  }
  return peak;
}

export function resourceConsistencyIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tablePeak = tablePeakLabor(markdown);
  if (tablePeak === undefined) return issues;
  let maxPeak = 0;
  let maxPeakText = '';
  for (const match of markdown.matchAll(PEAK_LABOR_RE)) {
    const value = Number(match[1].replace(/[,，]/gu, ''));
    if (Number.isFinite(value) && value > maxPeak) {
      maxPeak = value;
      maxPeakText = match[0].trim().slice(0, 40);
    }
  }
  if (maxPeak === 0) return issues;
  const threshold = tablePeak * 1.3;
  if (maxPeak > threshold) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `劳动力数据矛盾：正文表述“${maxPeakText}”达 ${maxPeak} 人，而分阶段投入明细表最大峰值为 ${tablePeak} 人（超出 ${Math.round(((maxPeak - tablePeak) / tablePeak) * 100)}%）`,
      suggestion: `劳动力投入口径必须全文统一：以分阶段明细表为准复核正文峰值表述，删除与表格矛盾的“高峰期 X 人”措辞或调整表格数据。`,
    });
  }
  return issues.slice(0, 3);
}

// ── 5. 支护体系并存（R6）：放坡喷锚族与灌注桩排桩族两套体系同时成段出现属跨模板拼接断裂 ──

const SLOPE_ANCHOR_RE = /放坡|喷锚|土钉|挂网喷浆|坡面喷射混凝土|分层分段开挖/gu;
const PILE_WALL_RE = /灌注桩|排桩|咬合桩|地下连续墙|支护桩/gu;

export function supportSystemConflictIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const slopeHits = markdown.match(SLOPE_ANCHOR_RE) || [];
  const pileHits = markdown.match(PILE_WALL_RE) || [];
  if (slopeHits.length === 0 || pileHits.length === 0) return issues;
  if (slopeHits.length + pileHits.length < 3) return issues;
  issues.push({
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `基坑支护方案前后不一致：放坡喷锚类表述 ${slopeHits.length} 处（如“${slopeHits[0]}”）与灌注桩排桩类表述 ${pileHits.length} 处（如“${pileHits[0]}”）并存，属跨模板拼接断裂`,
    suggestion: '支护形式必须全文统一为一种体系（以图纸/地质条件为准）：确定采用放坡喷锚或灌注桩排桩后，删除另一种体系的表述，并补充基坑开挖深度数值支撑危大分级判定。',
  });
  return issues;
}

// ── 6. 危大工程辨识清单一致性（R7）：多处清单项名/数量必须一致 ──

const DANGEROUS_LIST_HEADING_RE = /^#{2,4}\s+(?:\d+(?:\.\d+)*\s+)?[^\n]*(?:危大工程(?:辨识)?(?:清单|识别)|危大(?:工程)?(?:及超危大)?(?:清单|识别|辨识))[^\n]*$/gmu;

/** 归一化危大清单条目：去编号、去括号标注、去“及”连接、去“施工”尾缀，便于集合比较 */
function normalizeDangerousItem(item: string) {
  return item
    .replace(/^[\s\d.、()（）【】-]+/u, '')
    .replace(/[（(【][^)）】]*[)）】]/gu, '')
    .replace(/施工$/u, '')
    .replace(/作业$/u, '')
    .replace(/\s+/gu, '')
    .trim();
}

/** 提取“危大工程清单”标题块下的编号列表项 */
function extractDangerousLists(markdown: string): Array<{ title: string; items: string[] }> {
  const lines = markdown.split(/\r?\n/u);
  const lists: Array<{ title: string; items: string[] }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!DANGEROUS_LIST_HEADING_RE.test(lines[index].trim())) continue;
    const items: string[] = [];
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 30); cursor += 1) {
      const line = lines[cursor].trim();
      if (/^#{1,6}\s/u.test(line)) break;
      const item = /^(?:\d+[.、．)]|[-*•])?\s*([^。；;|]{2,40})$/u.exec(line)?.[1];
      if (item) items.push(normalizeDangerousItem(item));
    }
    if (items.length >= 2) lists.push({ title: lines[index].trim(), items: [...new Set(items)] });
  }
  return lists;
}

export function dangerousListConsistencyIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lists = extractDangerousLists(markdown);
  if (lists.length < 2) return issues;
  for (let left = 0; left < lists.length; left += 1) {
    for (let right = left + 1; right < lists.length; right += 1) {
      const a = lists[left];
      const b = lists[right];
      const onlyInA = a.items.filter(item => !b.items.includes(item));
      const onlyInB = b.items.filter(item => !a.items.includes(item));
      if (onlyInA.length === 0 && onlyInB.length === 0) continue;
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `危大工程辨识清单不一致：“${a.title.slice(0, 30)}”（${a.items.length} 项）与“${b.title.slice(0, 30)}”（${b.items.length} 项）存在差异：前者独有【${onlyInA.join('、') || '无'}】，后者独有【${onlyInB.join('、') || '无'}】`,
        suggestion: '全文危大工程辨识清单必须唯一且一致：合并两处清单，统一项名、数量与分级表述，避免评标专家以清单矛盾质疑辨识深度。',
      });
    }
  }
  return issues.slice(0, 3);
}

// ── 7. 六个百分百逐项覆盖（R8）：扬尘治理六项要求逐项命中，零散措施不等于体系响应 ──

/** 扬尘六个百分百六项（招标规范固定封闭集）：每项多组同义表述，词面覆盖检测属结构合规检查 */
const SIX_HUNDRED_PERCENT_ITEMS = [
  { name: '施工工地周边100%围挡', patterns: [/围挡.{0,8}100\s*%|100\s*%.{0,8}围挡|周边.{0,4}围挡|全封闭围挡/u] },
  { name: '物料堆放100%覆盖', patterns: [/物料.{0,8}100\s*%|100\s*%.{0,8}覆盖|物料.{0,6}覆盖|裸土覆盖|堆放.{0,6}覆盖/u] },
  { name: '出入车辆100%冲洗', patterns: [/车辆.{0,8}100\s*%|100\s*%.{0,8}冲洗|冲洗(?:台|平台|槽)|洗车台|出场.{0,4}冲洗/u] },
  { name: '施工现场地面100%硬化', patterns: [/地面.{0,8}100\s*%|100\s*%.{0,8}硬化|场地硬化|路面硬化|地面硬化/u] },
  { name: '拆迁工地100%湿法作业', patterns: [/湿法.{0,8}100\s*%|100\s*%.{0,8}湿法|湿法作业|洒水(?:降尘|抑尘)|雾炮/u] },
  { name: '渣土车辆100%密闭运输', patterns: [/密闭.{0,8}100\s*%|100\s*%.{0,8}密闭|密闭运输|篷布覆盖|渣土.{0,4}密闭/u] },
] as const;

export function sixHundredPercentCoverageIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // 文档没有任何扬尘/环保治理内容时不检测（非施组类文档不制造义务）
  if (!/扬尘|环保|文明施工|绿色施工/u.test(markdown)) return issues;
  const missing = SIX_HUNDRED_PERCENT_ITEMS.filter(item => !item.patterns.some(pattern => pattern.test(markdown))).map(item => item.name);
  if (missing.length === 0) return issues;
  issues.push({
    level: 'error',
    severity: 'blocker',
    category: 'structure',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `“扬尘治理六个百分百”未逐项落实：缺少【${missing.join('、')}】（${SIX_HUNDRED_PERCENT_ITEMS.length - missing.length}/${SIX_HUNDRED_PERCENT_ITEMS.length} 项命中）`,
    suggestion: '按检查规范第七部分要求逐条表述六项措施：工地周边100%围挡、物料堆放100%覆盖、出入车辆100%冲洗、施工现场地面100%硬化、拆迁工地100%湿法作业、渣土车辆100%密闭运输。',
  });
  return issues;
}

// ── 8. 段首机械重复（模板化）：同一固定开场在全文多处机械复制 ──

const PARAGRAPH_START_RE = /(?:^|\n)(?:#{1,6}\s+[^\n]*\n+)?([^\n|#][^。！？!?\n]{18,60})[。！？!?]/gu;

export function paragraphOpeningRepeatIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const counts = new Map<string, { count: number; sample: string }>();
  for (const match of markdown.matchAll(PARAGRAPH_START_RE)) {
    const sentence = match[1].trim();
    // 归一化：去数字与标点后取前 16 字作为前缀指纹（数字替换避免面积/日期差异掩盖同构句式）
    const fingerprint = sentence.replace(/[\d,，.。%％㎡m2²]/gu, '').slice(0, 16);
    if (fingerprint.length < 10) continue;
    const entry = counts.get(fingerprint) || { count: 0, sample: sentence };
    entry.count += 1;
    counts.set(fingerprint, entry);
  }
  for (const { count, sample } of counts.values()) {
    if (count < 3) continue;
    issues.push({
      level: 'warning',
      severity: 'warning',
      category: 'style',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `段首固定开场机械重复 ${count} 次：“${sample.slice(0, 30)}…”`,
      suggestion: '同一段首句式只保留首次出现处，其余处按所在章节语境改写为差异化开场，避免模板化套话观感。',
    });
  }
  return issues.slice(0, 3);
}

// ── 8b. 项目概况段跨章复述（L1 结构召回 + L3 语义判定，两段式）：
// 总述数据（总建筑面积/建设规模/计划工期/改造范围等）只在工程概况类小节集中交代，
// 其他小节不得以“本项目为……”整段复述（十四/十五度实测：正文 11 处“本项目为”复述概况段）。
// 判定口径遵循四层分离架构：正则只做结构召回（概况章区间 + “本项目为”句定位，字面封闭），
// “是否复述概况段”属语义判定，一律交 bge 余弦（候选句 vs 概况章正文 ≥0.6 才报）；
// 嵌入不可用时静默跳过（零误伤：判定不了就不判），提示词层面另有总控约束治本。──

export function overviewRecapCandidates(markdown: string): { overviewBody: string; sentences: string[] } {
  const lines = markdown.split('\n');
  // 概况区锚点：标题含“概况/基本信息”的 H2~H4 小节，区间到下一个同级或更高级标题
  const overviewRanges: Array<[number, number]> = [];
  let anchor: { index: number; level: number } | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^(#{2,4})\s+(.+)$/u.exec(lines[i].trim());
    if (heading) {
      const level = heading[1].length;
      if (/(?:工程概况|项目概况|基本信息)/u.test(heading[2])) {
        anchor = { index: i, level };
      } else if (anchor && level <= anchor.level) {
        overviewRanges.push([anchor.index, i]);
        anchor = undefined;
      }
    }
  }
  if (anchor) overviewRanges.push([anchor.index, lines.length]);
  const inOverviewRange = (i: number) => overviewRanges.some(([start, end]) => i >= start && i < end);
  const overviewBody = lines.filter((_, i) => inOverviewRange(i)).join('\n');
  const sentences: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (inOverviewRange(i)) continue;
    const hit = /本项目为/u.exec(lines[i]);
    if (!hit) continue;
    // 只取“本项目为”起始的一句（到句号为止），避免行内后续句子干扰判定
    const sentence = lines[i].slice(hit.index).split(/[。！？!?]/u)[0];
    if (sentence && sentence.length >= 12) sentences.push(sentence);
  }
  return { overviewBody, sentences };
}

export function overviewRecapIssues(markdown: string, options: { semanticSimilarity?: (left: string, right: string) => number } = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { overviewBody, sentences } = overviewRecapCandidates(markdown);
  if (sentences.length === 0 || !overviewBody || !options.semanticSimilarity) return issues;
  const recaps: string[] = [];
  for (const sentence of sentences) {
    const similarity = options.semanticSimilarity(sentence, overviewBody);
    if (similarity >= 0.6) recaps.push(sentence.slice(0, 36));
    if (recaps.length >= 3) break;
  }
  if (recaps.length === 0) return issues;
  issues.push({
    level: 'error',
    severity: 'blocker',
    category: 'style',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `项目概况段跨章复述不得出现：概况章外有 ${recaps.length} 处以“本项目为”开头整段复述概况内容：${recaps.map(recap => `“${recap}…”`).join('、')}`,
    suggestion: '总述数据只在工程概况类小节集中交代一次：其他章节直接写本章内容，仅可引用所需的具体数字（如“45日历天总工期”），不得复述完整概况段。',
  });
  return issues;
}

// ── 9. 闭环句式密度上限（模板化）：闭环四词过度密集削弱语言精练度 ──

const CLOSURE_DENSITY_WORDS = ['销项', '复查', '整改', '闭环'] as const;

export function closurePhraseDensityCapIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const totalChars = documentTextLength(markdown);
  if (totalChars < 3000) return issues;
  const perThousand: number[] = [];
  for (const word of CLOSURE_DENSITY_WORDS) {
    const count = markdown.split(word).length - 1;
    perThousand.push((count / totalChars) * 1000);
  }
  const maxDensity = Math.max(...perThousand);
  const maxWord = CLOSURE_DENSITY_WORDS[perThousand.indexOf(maxDensity)];
  // 外部验收基准：11.8 万字文档“销项/复查/整改/闭环”单词最高约 2 次/千字被评模板化密集；
  // 阈值取 3 次/千字（留出正常执行措施密度空间，仅拦截明显机械复制）
  if (maxDensity >= 3) {
    issues.push({
      level: 'warning',
      severity: 'warning',
      category: 'style',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `闭环句式模板化密集：“${maxWord}”达 ${maxDensity.toFixed(1)} 次/千字（销项/复查/整改/闭环统一结尾高度重复）`,
      suggestion: '保留关键控制环节的闭环表述，其余改为差异化的过程控制语言（检验批验收、实测实量、旁站记录等），提升语言精练度。',
    });
  }
  return issues;
}

// ── 10. 自伤表述候选（R2 后半）：投标文件中主动暴露短板的表述，修复轮由 LLM 判定并改写 ──

const SELF_UNDERMINING_RE = /专项设计文件(?:尚)?未完成|专项设计尚未完成|设计文件(?:尚)?未完成|指标(?:证明)?存在缺口|指标尚未明确|评分项(?:尚)?不明确|依据承诺函跟踪/gu;

export function selfUnderminingCandidateIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const hits = [...new Set(markdown.match(SELF_UNDERMINING_RE) || [])];
  if (hits.length === 0) return issues;
  for (const hit of hits) {
    // 白名单：现场条件类“不明确”是合理风险描述（如“地下水情况尚不明确”），非自伤——修复轮由 LLM 按上下文判定
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'style',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `自伤表述候选：“${hit}”暴露投标短板，需按上下文判定后改写`,
      suggestion: '投标文件不得主动暴露“专项设计未完成/指标存在缺口”等短板：改写为正向落实表述（如“按施工图绿色建筑专篇编制专项方案，逐项落实评分项并跟踪验收”）；如属现场条件合理风险描述（地质/管线尚不明确），保留但需配套勘查与应对措施。',
    });
  }
  return issues.slice(0, 3);
}

