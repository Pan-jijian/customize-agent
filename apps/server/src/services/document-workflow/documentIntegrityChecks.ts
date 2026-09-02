import type { DocumentDraftChapter, DocumentFactsModel, TenderRequirementModel, ValidationIssue } from './types';
import { documentTextLength } from './budget';
import { stringifyFactValue } from './utils';
import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';
import { buildSemanticGate } from './semanticGate';
import { isQualificationSectionTitle } from './evidenceContentSafety';

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

export const CALENDAR_DATE_RE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/gu;
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
      message: `字段-数值错配：“${label} ${match[2]}㎡”将总占地面积误作${label}（绑定资料${label}数值为 ${correctValues}㎡）`,
      suggestion: `总占地面积与建筑面积是两个独立字段，必须严格区分：将“${label} ${match[2]}㎡”改为资料数值“${label} ${correctValues}㎡”，总占地面积保持独立表述。`,
    });
  }
  return issues.slice(0, 3);
}

// ── 3. 面积算术一致性（R3 子项）：同一语句内 地上+地下 与 总/单体面积 必须自洽 ──

const AREA_TRIPLE_RE = /(地上[^。；;]{0,30}?([\d,]+(?:\.\d+)?)\s*(?:㎡|m2|m²|平方米)[^。；;]{0,40}?地下[^。；;]{0,30}?([\d,]+(?:\.\d+)?)\s*(?:㎡|m2|m²|平方米)[^。；;]{0,60}?(?:单体建筑面积|总建筑面积)[^。；;]{0,20}?([\d,]+(?:\.\d+)?)\s*(?:㎡|m2|m²|平方米))/gu;

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
        suggestion: `地上与地下面积之和必须等于单体建筑面积：按绑定资料统一三者数值，删除错误数值表述。`,
      });
    }
  }
  return issues.slice(0, 3);
}

// ── 4. 劳动力口径一致性（R4）：正文“高峰期 X 人”与分阶段明细表最大峰值必须同口径 ──
// h7 扩围：单模式 → 5 模式（正文峰值互查/多表峰值互查/正文vs表峰值/合计行vs明细行之和/总工日推算），
// 均为数值提取+算术比较（L2 确定性层），作为 L3.5 LLM 审查层的候选生成器同源互补

const PEAK_LABOR_RE = /(?:高峰期|高峰|峰值)[^。；;\n]{0,20}?(?:约)?\s*([\d,]+)\s*人/g;
// h14 扩围（评分报告 P2）：「主体阶段投入劳动力约110人」无「高峰」词，「劳动力高峰150～180人」
// 与明细「木工40+钢筋35+混凝土20+吊装25=120人」三口径并存时原 PEAK_LABOR_RE 漏抓 110/120 两处，
// 导致跨口径矛盾漏检——反向口径（劳动力/作业人员词在前、数字在后）并入同一提取池
const LABOR_COUNT_RE = /(?:劳动力|作业人员|施工人员)[^。；;\n]{0,16}?(?:约)?\s*([\d,]+)\s*人/g;

// 阶段限定词（长词优先避免子串混淆）：不同施工阶段的峰值天然不同（地下结构 220 vs 室外工程 90 不互斥），
// 仅同阶段或无阶段限定的峰值才参与互斥比较（真实生成「220 vs 90」误报根因）。
// A2（4.12.23）提取为模块级：检测器与确定性修复器共用同一阶段归属口径，避免双份实现漂移。
const LABOR_STAGE_LIMIT_WORDS = ['基坑与基础', '二次结构与砌体', '地下结构', '主体结构', '装饰装修', '机电安装', '室外工程', '收尾调试', '基坑', '基础'] as const;

/** 劳动力峰值数字位置 → 阶段限定词（与检测器 resourceConsistencyIssues 模式 1 同源同口径） */
function laborPeakStageOf(markdown: string, index: number): string | undefined {
  // 向前取最近句边界（。；；换行）内的片段再找阶段词——固定 30 字符窗口够不到
  // 「地下结构阶段投入钢筋工60人、木工80人、混凝土工40人、架子工20人，高峰人数约」这种长前缀
  const before = markdown.slice(0, index);
  const boundary = Math.max(before.lastIndexOf('。'), before.lastIndexOf('；'), before.lastIndexOf(';'), before.lastIndexOf('\n'));
  const segment = markdown.slice(Math.max(0, boundary + 1), index);
  let best: string | undefined;
  let bestPos = -1;
  for (const word of LABOR_STAGE_LIMIT_WORDS) {
    const pos = segment.lastIndexOf(word);
    if (pos > bestPos) { bestPos = pos; best = word; }
  }
  return best;
}

/** 单个表格块的结构解析结果（表头定位 + 人数列数据行抽取，与 qualityValidation 聚合口径一致） */
interface LaborTableBlock {
  /** 人员数量列数据行（仅该列数值） */
  countCells: number[];
  /** 合计/总计行的数值（无合计行为 undefined） */
  totalCell: number | undefined;
  /** 明细行数值之和（合计行存在时才有意义） */
  detailSum: number;
  /** 表峰值（该表人数列最大值） */
  peak: number;
  /** 表头含「高峰/峰值」列（阶段峰值口径表；无高峰列的分工种人数表不入多表峰值互查池） */
  hasPeakCol: boolean;
}

/** 从 markdown 表格中识别劳动力相关表格块（表头结构识别，非内容词判定） */
function collectLaborTableBlocks(markdown: string): LaborTableBlock[] {
  const blocks: LaborTableBlock[] = [];
  const lines = markdown.split(/\r?\n/u);
  const tableRowLineRe = /^\|.+\|$/u;
  // 表头列判定用封闭词表（结构识别）：分阶段维度列 + 人员数量列，仅匹配表头单元格，不扫表格内容
  const STAGE_COL_RE = /阶段|时期|工期|工序|进度/u;
  const COUNT_COL_RE = /人数|劳动力|作业人员|施工人员|投入人数/u;
  const separatorCellRe = /^:?-{3,}:?$/u;
  const cleanHeaderCell = (cell: string) => cell.replace(/[*_`~]/gu, '').trim();
  for (let index = 0; index < lines.length; index += 1) {
    if (!tableRowLineRe.test(lines[index].trim())) continue;
    // 逐行聚合连续表格行为同一表格块（与 qualityValidation.markdownTables 聚合口径一致）
    const rows: string[] = [];
    while (index < lines.length && tableRowLineRe.test(lines[index].trim())) {
      rows.push(lines[index].trim());
      index += 1;
    }
    index -= 1;
    if (rows.length < 3) continue;
    const cellsOf = (row: string) => row.split('|').map(item => item.trim()).slice(1, -1);
    // 表头行与数据行定位：优先分隔行（|---|---|）上一行为表头；无分隔行时仅当首行自身含双列表头词才接受
    let headerCells: string[] | undefined;
    let dataRows: string[];
    const separatorRow = rows.findIndex((row, rowIndex) => rowIndex > 0 && cellsOf(row).every(cell => separatorCellRe.test(cell)));
    if (separatorRow === 1 && rows.length >= 3) {
      headerCells = cellsOf(rows[0]).map(cleanHeaderCell);
      dataRows = rows.slice(2);
    } else if (separatorRow === -1 && rows.length >= 2) {
      const first = cellsOf(rows[0]).map(cleanHeaderCell);
      if (STAGE_COL_RE.test(first.join('|')) && COUNT_COL_RE.test(first.join('|'))) {
        headerCells = first;
        dataRows = rows.slice(1);
      } else {
        continue;
      }
    } else {
      continue;
    }
    // 列位置判定：表头中必须有人员数量列（分阶段列用于峰值表识别；合计表允许无分阶段列）
    const stageCol = headerCells.findIndex(cell => STAGE_COL_RE.test(cell));
    // 峰值口径列优先：「阶段平均人数」与「阶段高峰人数」并存时取高峰列，
    // 否则表峰值取到平均人数（190 人）而非真实高峰（230 人），与分工种人数表（60 人）形成假矛盾（真实生成误报根因）
    const peakCol = headerCells.findIndex(cell => /高峰|峰值/u.test(cell) && COUNT_COL_RE.test(cell));
    const countCol = peakCol >= 0 ? peakCol : headerCells.findIndex(cell => COUNT_COL_RE.test(cell));
    if (countCol < 0) continue;
    if (stageCol >= 0 && stageCol === countCol) continue;
    // 岗位配置表排除：表头含「岗位」且含「职责/持证/职称」的表格是项目组织岗位编制表
    // （项目经理1人、施工员3人），其人数列是岗位定员而非劳动力投入峰值；
    // 误当劳动力表会与分阶段投入表峰值（95人）形成假矛盾，LLM 修复面对两张都对的数据无从下手（历史缺陷）
    if (/岗位/u.test(headerCells.join('|')) && /职责|持证|职称/u.test(headerCells.join('|'))) continue;
    // 数字提取只看人员数量列（列位置对齐），不再全表扫描数字单元格
    const countCells: number[] = [];
    let totalCell: number | undefined;
    let detailSum = 0;
    for (const row of dataRows) {
      const cells = cellsOf(row);
      const cell = cells[countCol] || '';
      const match = /^([\d,]+)\s*人?$/u.exec(cell);
      if (!match) continue;
      const value = Number(match[1].replace(/[,，]/gu, ''));
      if (!Number.isFinite(value) || value <= 0) continue;
      // 合计/总计行：首单元格（或任一行内单元格）含封闭词表「合计/总计/小计」即视为汇总行
      const isTotalRow = cells.some((item, cellIndex) => cellIndex !== countCol && /合计|总计|小计/u.test(item));
      if (isTotalRow) {
        totalCell = value;
        continue;
      }
      countCells.push(value);
      detailSum += value;
    }
    if (countCells.length === 0 && totalCell === undefined) continue;
    const peak = Math.max(...(countCells.length > 0 ? countCells : [totalCell || 0]));
    blocks.push({ countCells, totalCell, detailSum, peak, hasPeakCol: peakCol >= 0 });
  }
  return blocks;
}

/** 从 markdown 表格中提取劳动力分阶段表格的人数峰值（兼容旧单值口径：多表取最大） */
function tablePeakLabor(markdown: string): number | undefined {
  const peaks = collectLaborTableBlocks(markdown).map(block => block.peak);
  return peaks.length > 0 ? Math.max(...peaks) : undefined;
}

export function resourceConsistencyIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bodyPeaks: Array<{ value: number; text: string; stage?: string }> = [];
  // 阶段归属判定复用模块级 laborPeakStageOf（A2：检测/修复同源同口径）
  // h14：峰值口径与反向劳动力口径同池提取（评分报告 P2 三口径并存漏检根因）
  for (const pattern of [PEAK_LABOR_RE, LABOR_COUNT_RE]) {
    for (const match of markdown.matchAll(pattern)) {
      const value = Number(match[1].replace(/[,，]/gu, ''));
      // laborPeakStageOf 定位数字位置（非模式起点）：「峰值表述统一为：地下结构阶段220人」的阶段词
      // 在模式起点之后，用起点定位会取不到阶段限定（真实生成误报根因）
      const valueIndex = match.index + match[0].indexOf(match[1]);
      if (Number.isFinite(value) && value > 0) bodyPeaks.push({ value, text: match[0].trim().slice(0, 40), stage: laborPeakStageOf(markdown, valueIndex) });
    }
  }
  const tableBlocks = collectLaborTableBlocks(markdown);
  const tablePeaks = tableBlocks.map(block => block.peak);
  const laborIssue = (message: string, suggestion: string) => issues.push({
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message,
    suggestion,
  });
  // 模式 1：正文峰值全量互查——多处「高峰期 X 人」相差 >30% 即互斥（阶段限定不同的峰值除外）
  for (let i = 0; i < bodyPeaks.length; i += 1) {
    for (let j = i + 1; j < bodyPeaks.length; j += 1) {
      const [a, b] = [bodyPeaks[i], bodyPeaks[j]];
      if (a.stage && b.stage && a.stage !== b.stage) continue;
      // 总口径（无阶段限定）vs 阶段口径：总人数 ≥ 阶段峰值属正常关系（「按施工高峰配置总人数约180人」
      // vs 室外工程阶段高峰 90 人），仅总人数低于阶段峰值 10% 以上才进入互斥比较（真实生成误报根因）
      if (!a.stage !== !b.stage) {
        const [total, staged] = a.stage ? [b, a] : [a, b];
        if (total.value >= staged.value * 0.9) continue;
      }
      const diff = Math.abs(a.value - b.value) / Math.max(a.value, b.value);
      if (diff > 0.3) {
        laborIssue(
          `劳动力数据矛盾：正文“${a.text}”（${a.value} 人）与“${b.text}”（${b.value} 人）互斥（相差 ${Math.round(diff * 100)}%）`,
          '劳动力峰值数据必须全文唯一：以分阶段投入明细表为准统一正文各处峰值表述，删除矛盾数字。',
        );
        i = bodyPeaks.length;
        break;
      }
    }
  }
  // 模式 2：多表峰值互查——仅比较表头含「高峰/峰值」列的口径表；
  // 分工种人数明细表（表头仅「人数」列，60 人为工种人数非阶段总人数）与阶段峰值表不可比（真实生成误报根因）
  const peakColTablePeaks = tableBlocks.filter(block => block.hasPeakCol).map(block => block.peak);
  if (peakColTablePeaks.length >= 2) {
    const max = Math.max(...peakColTablePeaks);
    const min = Math.min(...peakColTablePeaks);
    const diff = Math.abs(max - min) / max;
    if (diff > 0.3) {
      laborIssue(
        `劳动力数据矛盾：分阶段投入明细表峰值 ${min} 人与另一劳动力表峰值 ${max} 人互斥（相差 ${Math.round(diff * 100)}%）`,
        '劳动力峰值数据必须全文唯一：统一各劳动力表格的峰值数据，删除矛盾表格数字。',
      );
    }
  }
  // 模式 3：正文峰值 vs 表峰值（保留原口径）
  const maxBodyPeak = bodyPeaks.reduce((maxPeak, entry) => Math.max(maxPeak, entry.value), 0);
  const tablePeak = tablePeaks.length > 0 ? Math.max(...tablePeaks) : undefined;
  if (tablePeak !== undefined && maxBodyPeak > 0) {
    const threshold = tablePeak * 1.3;
    if (maxBodyPeak > threshold) {
      const maxText = bodyPeaks.find(entry => entry.value === maxBodyPeak)?.text || '';
      laborIssue(
        `劳动力数据矛盾：正文表述“${maxText}”达 ${maxBodyPeak} 人，而分阶段投入明细表最大峰值为 ${tablePeak} 人（超出 ${Math.round(((maxBodyPeak - tablePeak) / tablePeak) * 100)}%）`,
        '劳动力投入数据必须全文统一：以分阶段明细表为准复核正文峰值表述，删除与表格矛盾的“高峰期 X 人”措辞或调整表格数据。',
      );
    }
  }
  // 模式 6：总量控制上限 vs 峰值（真实生成回归：正文「高峰期总人数控制在260人」与
  // 「主体阶段高峰投入约300人/装饰阶段高峰投入约350人」并存——控制上限语义下超限即矛盾，
  // 不设差值百分比阈值；模式 1 的 30% 互斥阈值对「上限 vs 阶段峰值」场景过宽会漏报 260 vs 350）
  const controlCaps: number[] = [];
  for (const match of markdown.matchAll(/(?:高峰期|高峰|峰值)[^。；;\n]{0,16}?控制(?:在|为|到)?(?:约)?\s*([\d,]+)\s*人(?:以内|以下|之内)?/gu)) {
    const value = Number(match[1].replace(/[,，]/gu, ''));
    if (Number.isFinite(value) && value > 0) controlCaps.push(value);
  }
  if (controlCaps.length > 0) {
    const cap = Math.max(...controlCaps);
    const exceedingPeaks = [...bodyPeaks, ...(tablePeak !== undefined ? [{ value: tablePeak }] : [])].filter(entry => entry.value > cap);
    if (exceedingPeaks.length > 0) {
      const exceed = Math.max(...exceedingPeaks.map(entry => entry.value));
      laborIssue(
        `劳动力数据矛盾：正文“高峰期总人数控制在${cap}人”的上限表述与峰值表述 ${exceed} 人不自洽（阶段高峰投入超出控制上限 ${Math.round(((exceed - cap) / cap) * 100)}%）`,
        '总量控制上限与各阶段峰值必须自洽：阶段高峰人数不得超过全文宣称的高峰控制人数；以分阶段投入明细表为准修正控制目标或各阶段峰值表述。',
      );
    }
  }
  // 模式 4：合计行 vs 明细行之和——同一表内汇总行人数必须等于明细行人数之和（差 >10% 报）
  for (const block of tableBlocks) {
    if (block.totalCell === undefined || block.countCells.length < 2) continue;
    const diff = Math.abs(block.totalCell - block.detailSum) / Math.max(block.totalCell, block.detailSum);
    if (diff > 0.1) {
      laborIssue(
        `劳动力数据矛盾：劳动力表合计行 ${block.totalCell} 人与明细行之和 ${block.detailSum} 人不符（差 ${Math.round(diff * 100)}%）`,
        '劳动力表合计必须等于各明细行人数之和：统一合计行与明细行数据，删除矛盾数字。',
      );
    }
  }
  // 模式 5：总工日推算——正文「X 工日」与峰值人数×总工期天数必须有量级自洽
  // （总工日 > 峰值×工期×1.3 或 < 峰值×工期×0.1 才报，宽松边界零误伤）
  const totalWorkdays = [...markdown.matchAll(/([\d,]+)\s*(?:个)?工日/gu)]
    .map(match => Number(match[1].replace(/[,，]/gu, '')))
    .filter(value => Number.isFinite(value) && value > 0);
  const totalDays = [...markdown.matchAll(/(?:工期|总工期|计划工期)[^。；;\n]{0,16}?(\d{2,4})\s*(?:个)?(?:日历)?天/gu)]
    .map(match => Number(match[1]))
    .filter(value => Number.isFinite(value) && value >= 30 && value <= 3000);
  if (totalWorkdays.length > 0 && maxBodyPeak > 0 && totalDays.length > 0) {
    const maxWorkdays = Math.max(...totalWorkdays);
    const maxDays = Math.max(...totalDays);
    const upperBound = maxBodyPeak * maxDays * 1.3;
    const lowerBound = maxBodyPeak * maxDays * 0.1;
    if (maxWorkdays > upperBound || maxWorkdays < lowerBound) {
      laborIssue(
        `劳动力数据矛盾：总工日 ${maxWorkdays} 个与峰值 ${maxBodyPeak} 人×总工期 ${maxDays} 天不自洽（合理区间约 ${Math.round(lowerBound)}~${Math.round(upperBound)} 个）`,
        '总工日必须与劳动力峰值和总工期量级自洽：按各阶段人数×阶段工期重算总工日，或修正峰值人数/总工期表述。',
      );
    }
  }
  return issues.slice(0, 5);
}

// ── 5. 支护体系并存（R6）：放坡喷锚族与灌注桩排桩族两套体系同时成段出现属跨模板拼接断裂 ──

/** 支护两体系语义原型（bge 余弦 ≥ 阈值判定块归属；「灌注桩＋局部放坡」混合块同时命中两族不判冲突） */
const SUPPORT_SYSTEM_QUERIES = {
  slope: '基坑放坡开挖、土钉墙喷锚支护坡面',
  pile: '钻孔灌注桩、排桩、地下连续墙围护结构',
} as const;

export async function supportSystemConflictIssues(markdown: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const blocks = markdown.split(/\n{2,}/u).filter(block => block.trim().length >= 30);
  if (blocks.length === 0) return issues;
  const systemSimilarity = await buildSemanticSimilarity(blocks, Object.values(SUPPORT_SYSTEM_QUERIES));
  const hitsSlope = (block: string) => systemSimilarity(block, SUPPORT_SYSTEM_QUERIES.slope) >= SEMANTIC_COVERAGE_THRESHOLD;
  // 桩族词面预检：块内无灌注桩排桩类实义词面（钻孔灌注桩/排桩/地下连续墙/咬合桩/支护桩）不判桩族，
  // 防止「桩机2台」（施工机械）、「桩基施工」等泛化词被 bge 误判入桩支护族（合肥师范实测误报源）
  const PILE_LITERAL_RE = /钻孔灌注桩|灌注桩|排桩|地下连续墙|咬合桩|支护桩/u;
  const hitsPile = (block: string) => PILE_LITERAL_RE.test(block)
    && systemSimilarity(block, SUPPORT_SYSTEM_QUERIES.pile) >= SEMANTIC_COVERAGE_THRESHOLD;
  // 冲突 = 存在单独命中放坡喷锚族的块 且 存在单独命中灌注桩排桩族的块（两体系各自成段出现）
  const slopeOnlyBlocks = blocks.filter(block => hitsSlope(block) && !hitsPile(block));
  const pileOnlyBlocks = blocks.filter(block => hitsPile(block) && !hitsSlope(block));
  if (slopeOnlyBlocks.length === 0 || pileOnlyBlocks.length === 0) return issues;
  issues.push({
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `基坑支护方案前后不一致：放坡喷锚类支护表述与灌注桩排桩类支护表述分别成段出现（放坡喷锚类 ${slopeOnlyBlocks.length} 段、灌注桩排桩类 ${pileOnlyBlocks.length} 段），属跨模板拼接断裂`,
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

/** 扬尘六个百分百六项（招标规范固定封闭集）：每项一条语义判定 query（国家规范固定条目名）。
 * 判定口径（四层分离架构，W2/P1 改造）：纯语义判定，本地 bge 余弦 ≥0.6（本地 ONNX 推理恒可用，
 * 无不可用降级路径，判定语义全权由 bge 负责）。 */
const SIX_HUNDRED_PERCENT_ITEMS = [
  { name: '施工工地周边100%围挡', query: '施工工地周边设置围挡封闭管理' },
  { name: '物料堆放100%覆盖', query: '物料堆放覆盖防尘' },
  { name: '出入车辆100%冲洗', query: '出入车辆冲洗设施清洗出场' },
  { name: '施工现场地面100%硬化', query: '施工现场场地地面硬化' },
  // query 必须限定“拆迁工地”语义：不限定时土方开挖“湿法作业”会被误命中，
  // 掩盖真缺失（评分报告问题3：拆迁工地100%湿法作业未落实）
  { name: '拆迁工地100%湿法作业', query: '拆迁工地湿法作业洒水降尘' },
  { name: '渣土车辆100%密闭运输', query: '渣土车辆密闭运输防止遗撒' },
] as const;

/** 语义判定候选正文句：非标题/表格行，句级拆分，均匀采样上限 400 句（短句语义判定样本）。
 * 均匀采样而非头部截断：4 万字级文档 800+ 句，slice(0,160) 只取前部（历史缺陷：工伤保险/创优/
 * 四节量化表述位于文档中后部，全在采样外 → 属地适配三项「缺失」误报且修复轮死循环）。
 * 导出供 requirementsCoverageIssues（W4/P3 正文级评分项要求检测）等语义消费方复用同口径采样。 */
export function bodySentencesForSemantic(markdown: string): string[] {
  const sentences: string[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) continue;
    for (const part of trimmed.split(/(?<=[。！？!?；;])/u)) {
      const sentence = part.trim();
      if (sentence.length >= 8 && sentence.length <= 120) sentences.push(sentence);
    }
  }
  const unique = [...new Set(sentences)];
  if (unique.length <= 400) return unique;
  const stride = Math.ceil(unique.length / 400);
  return unique.filter((_, index) => index % stride === 0).slice(0, 400);
}

/** 语义覆盖判定（纯 bge）：本地语义模型恒可用（本地 ONNX 推理），判定语义全权由 bge 负责，
 * 无不可用降级路径——模型失败直接抛出暴露缺陷，而非静默跳过或换 LLM 兜底 */
async function judgeQueryCoverage(queries: Array<{ key: string; text: string }>, sentences: string[]): Promise<Map<string, boolean>> {
  if (sentences.length === 0 || queries.length === 0) return new Map();
  const similarity = await buildSemanticSimilarity(queries.map(item => item.text), sentences);
  return new Map(queries.map(item => [item.key, sentences.some(sentence => similarity(item.text, sentence) >= 0.6)] as [string, boolean]));
}

export async function sixHundredPercentCoverageIssues(markdown: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  // 文档没有任何扬尘/环保治理内容时不检测（非施组类文档不制造义务）
  if (!/扬尘|环保|文明施工|绿色施工/u.test(markdown)) return issues;
  const coverage = await judgeQueryCoverage(SIX_HUNDRED_PERCENT_ITEMS.map(item => ({ key: item.name, text: item.query })), bodySentencesForSemantic(markdown));
  // 拆迁工地豁免（D2）：新建工程无拆迁内容时，正文显式说明“本项目无拆迁工程，不涉及拆迁工地湿法作业”
  // 即视为该项闭环，不得判定缺失（评分报告问题3：六项必须逐项落实或显式豁免，不得省略）。
  // 豁免句必须带工程主语（本项目/本工程等）+ 短距否定词：任意语境出现「不涉及拆迁」类短语
  // （如“临时设施布置不涉及拆迁补偿”）不代表项目整体无拆迁工程，不得豁免
  const demolitionExempt = /(?:本项目|本工程|该工程|该项目|本标段|本施工项目)[^。；;\n]{0,30}(?:无拆迁|不涉及拆迁|无房屋拆除|无拆除)/u.test(markdown);
  const missing = SIX_HUNDRED_PERCENT_ITEMS
    .filter(item => !coverage.get(item.name))
    .filter(item => !(item.name === '拆迁工地100%湿法作业' && demolitionExempt))
    .map(item => item.name);
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

// ── 7b. 安徽省属地适配与政策合规（round-18 E11）：创优目标/四节一环保量化/工伤保险 ──
// 属地判定为省级：建设地点位于安徽省（含省内任一地级市）即触发属地适配项，
// 不再针对合肥单市（用户反馈：适配对象是安徽省工程，不是合肥本地适配）。
// W2/P1 改造：三项均为开放语义空间，纯语义判定（bge 直判），不再使用词面词表；
// 创优目标检测与建议均不注入任何具体奖项名称（庐州杯等），奖项一律以评分项要求提取结果为准。

const ANHUI_LOCATION_LABEL_RE = /建设地点|工程地点|项目地点|实施地点|服务地点|交付地点|建设地址/u;
const ANHUI_CITY_NAMES = ['安徽', '合肥', '芜湖', '蚌埠', '淮南', '马鞍山', '淮北', '铜陵', '安庆', '黄山', '滁州', '阜阳', '宿州', '六安', '亳州', '池州', '宣城'];

/** 项目是否位于安徽省（factsModel 建设地点类字段值含“安徽”或省内任一地级市） */
function isAnhuiProject(factsModel: DocumentFactsModel): boolean {
  return factsModel.project.some(fact => ANHUI_LOCATION_LABEL_RE.test(`${fact.fieldName || ''}${fact.key || ''}`) && ANHUI_CITY_NAMES.some(city => stringifyFactValue(fact.value).includes(city)));
}

export async function localAdaptationKeywordIssues(markdown: string, factsModel: DocumentFactsModel): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const anhuiProject = isAnhuiProject(factsModel);
  const queries: Array<{ key: string; text: string }> = [];
  if (anhuiProject) {
    queries.push({ key: 'award', text: '争创省市级优质工程奖、安全文明标准化工地' });
    queries.push({ key: 'greenQuant', text: '非传统水源利用率、废弃物回收率等绿色施工量化指标' });
  }
  queries.push({ key: 'workInjury', text: '按规定为作业人员办理工伤保险' });
  if (queries.length === 0) return issues;
  const coverage = await judgeQueryCoverage(queries, bodySentencesForSemantic(markdown));
  if (anhuiProject) {
    // 属地创优目标：正文无创优目标语义（检测与建议均不注入具体奖项名称——奖项以评分项要求提取结果逐字为准）
    if (!coverage.get('award')) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'structure',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: '属地创优目标缺失：正文未提及省市级优质工程/文明标准化工地等创优目标（安徽省属地适配项）',
        suggestion: '在质量目标或创优规划小节补写与项目实际规模相符的创优目标表述；奖项名称必须以评分项要求提取结果（招标文件原文）为准逐字落位，禁止自行编造或替换为其他奖项名称。',
      });
    }
    // 四节一环保量化指标：正文有绿色施工/四节一环保内容但无量化指标语义（现场：仅定性表述）
    if (/四节一环保|绿色施工|节水|节材|节能/u.test(markdown) && !coverage.get('greenQuant')) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'structure',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: '四节一环保量化指标缺失：非传统水源利用率/漏损率/土方平衡率/废弃物回收率等均未量化（附录八基准对照项）',
        suggestion: '在绿色施工章节补充量化指标（非传统水源利用率、管网漏损率、土方平衡率、可回收废弃物回收率等）与模板周转次数，数值参考行业通用水平与附录八基准，不得编造极端值。',
      });
    }
  }
  // 工伤保险：劳务/农民工内容存在时必须有工伤保险缴纳表述（政策合规类，不限地域）
  if (/劳务|农民工|工资/u.test(markdown) && !coverage.get('workInjury')) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'structure',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: '工伤保险表述缺失：正文有劳务/农民工管理内容但未提及工伤保险缴纳（政策合规漏项）',
      suggestion: '在劳务管理/农民工工资保障小节补充“按规定为作业人员办理工伤保险”表述。',
    });
  }
  return issues;
}

// 段首句提取（换行用 fromCharCode 构造，规避 no-control-regex 与字面转义问题）
const NL = String.fromCharCode(10);
const PARAGRAPH_START_RE = new RegExp(`(?:^|${NL})(?:#{1,6}\\s+[^${NL}]*${NL}+)?([^${NL}|#][^。！？!?${NL}]{18,60})[。！？!?]`, 'gu');

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
// “是否复述概况段”属语义判定，一律交 bge 余弦（候选句 vs 概况章正文 ≥0.6 才报；
// 本地语义模型恒可用，判定语义全权由 bge 负责），提示词层面另有总控约束治本。──

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
    // 概况复述开头形态封闭集：本项目为/本工程为/该项目为/该工程为（真实生成缺陷：检测只收“本项目为”，
    // “本工程为”开头复述句 3 处全部漏检，修复链与删除兜底同漏）
    const hit = /本项目为|本工程为|该项目为|该工程为/u.exec(lines[i]);
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
    message: `项目概况段跨章复述不得出现：概况章外有 ${recaps.length} 处以“本项目为/本工程为”等总述开头整段复述概况内容：${recaps.map(recap => `“${recap}…”`).join('、')}`,
    suggestion: '总述数据只在工程概况类小节集中交代一次：其他章节直接写本章内容，仅可引用所需的具体数字（如“45日历天总工期”），不得复述完整概况段。',
  });
  return issues;
}

/**
 * 概况复述句交付前行级清洗（round-19 R2）：与检测器同源同阈值（概况区外“本项目为/本工程为/该项目为/该工程为”
 * 起一句与概况章正文语义相似度 ≥0.6 判复述 → 整句删除），标题行/表格行/概况区间行不触碰；
 * 语义相似度函数由调用方构造（本地 bge 恒可用，空输入由 buildSemanticSimilarity 返回恒零函数）。
 */
export function stripOverviewRecapBodyLines(markdown: string, similarity: (left: string, right: string) => number): string {
  const { overviewBody, sentences } = overviewRecapCandidates(markdown);
  if (sentences.length === 0 || !overviewBody) return markdown;
  const lines = markdown.split(/\r?\n/u);
  // 概况区间判定与 overviewRecapCandidates 同源（标题含“概况/基本信息”的 H2~H4 小节区间）
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
  let changed = false;
  const cleaned = lines.map((line, index) => {
    if (inOverviewRange(index)) return line;
    if (/^#{1,6}\s/u.test(line.trim()) || /^\s*\|/u.test(line.trim())) return line;
    if (!/本项目为|本工程为|该项目为|该工程为/u.test(line)) return line;
    // 行内按句拆分，删除相似度达标的复述句（与 blocker 修复循环 delete 兜底同口径）
    const parts = line.split(/(?<=[。！？!?])/u);
    const kept = parts.filter(part => {
      if (!/本项目为|本工程为|该项目为|该工程为/u.test(part)) return true;
      const sentence = part.split(/[。！？!?]/u)[0];
      if (sentence.length < 12) return true;
      return similarity(sentence, overviewBody) < 0.6;
    });
    if (kept.join('') !== line) changed = true;
    return kept.join('');
  });
  return changed ? cleaned.join('\n') : markdown;
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

/** 自伤表述语义原型（bge 余弦 ≥ 阈值召回候选句，修复轮由 LLM 按上下文判定改写） */
const SELF_UNDERMINING_QUERIES = [
  '专项设计文件尚未完成，待后续补充',
  '评分指标存在缺口尚未明确',
  '依据承诺函后续跟踪完善',
] as const;

export async function selfUnderminingCandidateIssues(markdown: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const sentences = markdown
    .split(/\n+/u)
    .filter(line => line.trim() && !/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(line))
    .flatMap(line => line.split(/[。；;]/u))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 12);
  if (sentences.length === 0) return issues;
  const underminingSimilarity = await buildSemanticSimilarity(sentences, [...SELF_UNDERMINING_QUERIES]);
  const hits = [...new Set(sentences.filter(sentence =>
    SELF_UNDERMINING_QUERIES.some(query => underminingSimilarity(sentence, query) >= SEMANTIC_COVERAGE_THRESHOLD)))];
  if (hits.length === 0) return issues;
  for (const hit of hits) {
    // 语义召回仅出候选：现场条件类“不明确”是合理风险描述（如“地下水情况尚不明确”），修复轮由 LLM 按上下文判定
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

// ── 11. 叠词重复检测（Q8 前半）：同一双字词紧邻重复（“执行执行”“进行进行”），L1 封闭结构提取 + 确定性去重 ──

export const REPEATED_WORD_RE = /([\u4e00-\u9fa5]{2})\1/gu;

export function repeatedWordIssues(markdown: string): ValidationIssue[] {
  const hits = [...new Set(markdown.match(REPEATED_WORD_RE) || [])].slice(0, 3);
  if (hits.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'style',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `正文存在叠词重复表述：${hits.map(hit => `“${hit}”`).join('、')}`,
    suggestion: '删除紧邻重复字词，保持语句完整通顺（“执行执行”改为“执行”）。',
  }];
}

/** 叠词确定性去重（修复侧兜底）：仅收敛“XX XX”紧邻重复为“XX”，不触碰非重复文本 */
export function collapseRepeatedWords(content: string): string {
  return content.replace(REPEATED_WORD_RE, '$1');
}

// ── 12. 商务条款数据入正文检测（Q3）：施组正文禁止出现商务数据封闭集，出现即评审失分（徽光阁实测：暂列金额 60 万入正文） ──
// 阶段五语义升级：强词（COMMERCIAL_TERM_RE）与数字式（COMMERCIAL_RATE_RE）保留确定性判定（出现即商务数据）；
// 变体弱词（材料价格/商务报价类）仅词面召回，句级语义复核（semanticGate 统一入口）确认商务语义才计命中；
// 允许事实（合同估算价/投资估算类）作负例保护，混合句由语义裁决归属。

const COMMERCIAL_TERM_RE = /暂列金额|暂估价|报价明细|综合单价|清单合价|预留金|投标报价/u;
const COMMERCIAL_RATE_RE = /(?:税率|增值税)[^。；;\n]{0,12}\d/u;
/** 允许入正文的项目商务事实（资料落位口径）：词面负例保护，不得误报为商务条款泄漏 */
const COMMERCIAL_ALLOWED_FACT_RE = /合同估算价|合同估算价格|投资估算|估算价格|工程估算价|最高投标限价|招标控制价/u;
/** 商务变体弱召回：词面命中仅召回，语义复核确认商务语义才计命中（词面变体漏网治理） */
const COMMERCIAL_VARIANT_HINT_RE = /材料价格|商务报价|投标总价|合同总价|工程总价/u;

/** 商务条款语义原型（正例）：报价/单价类商务数据表述基准 */
const COMMERCIAL_SEMANTIC_PROTOTYPES = [
  '暂列金额与暂估价的报价明细',
  '综合单价与清单合价的商务数据',
  '投标报价与费率标准的商务条款',
] as const;
/** 允许事实语义原型（负例保护）：估算价/限价类项目公开信息与约束说明不得误报 */
const COMMERCIAL_LEGAL_PROTOTYPES = [
  '合同估算价与投资估算的项目信息',
  '最高投标限价与招标控制价的公开信息',
  '商务数据不得写入施工组织设计正文的约束说明',
] as const;

/** 构建商务语义 gate（semanticGate 统一入口）：变体/混合句语义裁决 */
async function buildCommercialGate(embedDocuments?: (texts: string[]) => Promise<number[][]>) {
  return buildSemanticGate({
    prototypes: [...COMMERCIAL_SEMANTIC_PROTOTYPES],
    negativePrototypes: [...COMMERCIAL_LEGAL_PROTOTYPES],
    embedDocuments,
  });
}

export async function commercialDataInBodyIssues(markdown: string, embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<ValidationIssue[]> {
  const hits: string[] = [];
  const gate = await buildCommercialGate(embedDocuments);
  const candidates: string[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trim();
    // 排除标题行与表格行：项目基本信息表/清单表格中的商务字段属资料落位，不在正文禁令范围
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) continue;
    if (!COMMERCIAL_TERM_RE.test(line) && !COMMERCIAL_RATE_RE.test(line) && !COMMERCIAL_VARIANT_HINT_RE.test(line)) continue;
    if (COMMERCIAL_RATE_RE.test(line)) hits.push('税率/增值税');
    for (const sentence of line.split(/(?<=[。；;])\s*/u)) {
      const terms = sentence.match(COMMERCIAL_TERM_RE) || [];
      const hasAllowed = COMMERCIAL_ALLOWED_FACT_RE.test(sentence);
      const hasVariant = COMMERCIAL_VARIANT_HINT_RE.test(sentence);
      // 强词纯句确定性杀（保留原行为）；含允许词面或变体词的混合句/变体句进入语义复核
      if (terms.length > 0 && !hasAllowed && !hasVariant) {
        hits.push(...terms);
      } else if ((terms.length > 0 && (hasAllowed || hasVariant)) || (hasVariant && terms.length === 0)) {
        candidates.push(sentence);
      }
    }
  }
  if (candidates.length > 0) {
    const flags = await gate(candidates);
    candidates.forEach((sentence, index) => {
      if (!flags[index]) return;
      const terms = sentence.match(COMMERCIAL_TERM_RE) || [];
      const variants = sentence.match(COMMERCIAL_VARIANT_HINT_RE) || [];
      hits.push(...(terms.length > 0 ? terms : variants));
    });
  }
  const unique = [...new Set(hits)].slice(0, 4);
  if (unique.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'style',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `正文出现商务条款数据：${unique.join('、')}`,
    suggestion: '商务数据（暂列金额/暂估价/综合单价/税率等）不得写入施组正文：删除该句或改写为定性表述（如“按合同约定执行”），商务口径仅保留在项目信息表中。',
  }];
}

/** 商务条款句确定性删除（修复侧兜底）：整句删除含商务词的正文句，信息表/表格行不触碰 */
export function stripCommercialDataSentences(content: string): string {
  const parts = content.split(/(?<=[。；;])\s*/u);
  const kept = parts.filter(part => {
    if (/^\s*\|/u.test(part)) return true;
    if (/^#{1,6}\s/u.test(part)) return true;
    return !(COMMERCIAL_TERM_RE.test(part) || COMMERCIAL_RATE_RE.test(part));
  });
  return kept.join('');
}

/**
 * 商务条款正文行级安全清洗（交付前兜底，round-18 E9）：
 * blocker 修复循环结束后仍可能有 LLM patch（画像修复轮等）引入商务句，交付前按行清洗——
 * 标题行/表格行不触碰（与检测器同口径），正文行命中时按行内句子拆分仅删含商务词的句子，
 * 避免 stripCommercialDataSentences 的整块 part 分割把含商务词的表格块连带删除。
 */
export function stripCommercialDataBodyLines(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const keptLines = lines.map(line => {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) return line;
    if (!COMMERCIAL_TERM_RE.test(line) && !COMMERCIAL_RATE_RE.test(line)) return line;
    const parts = line.split(/(?<=[。；;])\s*/u);
    return parts.filter(part => !(COMMERCIAL_TERM_RE.test(part) || COMMERCIAL_RATE_RE.test(part))).join('');
  });
  return keptLines.join('\n');
}

// ── 13. 节点工期口径互查（h13）：同一关键节点（基坑支护/正负零/封顶/装饰/机电/竣工）
// 在正文句与进度计划表中出现多套「第N日/天」口径即互斥。数值提取+集合比较（L2 确定性层），
// 覆盖「第N日完成X」正序式与「X完成|第N天」表格式、以及「X节点锁定在开工后第N日」倒序式。
// 合肥师范实测：基坑支护 60 vs 75、封顶 300 vs 210、装饰 450 vs 440 三处漏检（无检测器覆盖）。──

const SCHEDULE_NODE_ANCHORS = [
  { key: 'excavation', label: '基坑支护及土方外运', re: /基坑支护/u },
  { key: 'zero', label: '地下结构出正负零', re: /正负零|地下室结构/u },
  { key: 'topping', label: '主体结构封顶', re: /主体(?:结构)?封顶/u },
  { key: 'decoration', label: '装饰装修及幕墙', re: /装饰装修/u },
  { key: 'mep', label: '机电安装及智能化调试', re: /机电安装/u },
  { key: 'completion', label: '室外工程及竣工验收', re: /竣工验收/u },
] as const;

/** 提取节点日期样本：三种形态（正序完成式/倒序锁定式/表格式完成列）全部收口为 {key, day, raw} */
function extractNodeScheduleDays(markdown: string): Array<{ key: string; day: number; raw: string }> {
  const samples: Array<{ key: string; day: number; raw: string }> = [];
  const keyOf = (text: string) => SCHEDULE_NODE_ANCHORS.find(anchor => anchor.re.test(text))?.key;
  const pushIfNode = (nodeText: string, day: number, raw: string) => {
    const key = keyOf(nodeText);
    if (key !== undefined && Number.isFinite(day) && day >= 1 && day <= 3000) samples.push({ key, day, raw });
  };
  // 形态 A：第N日完成X（正序完成式），节点捕获用完整节点名——
  // 防「第15日完成场地清表、临建搭设和基坑支护施工准备」这类准备阶段句误采为基坑支护节点
  for (const match of markdown.matchAll(/第(\d{2,3})日[^。；;\n]{0,14}?完成[^。；;\n]{0,12}?(基坑支护及土方外运|装饰装修及幕墙|机电安装及智能化调试|室外工程及竣工验收|地下结构出正负零|主体结构封顶|正负零|封顶)/gu)) {
    pushIfNode(match[2], Number(match[1]), match[0].slice(0, 40));
  }
  // 形态 B：X完成|第N天（表格式完成列）：锚点后 8 字符内必须出现「完成」，
  // 中间负向前瞻排除「、/，/第N日」——防「正负零、第300日完成主体结构封顶、第450日」跨节点误采
  for (const match of markdown.matchAll(/(基坑支护|正负零|封顶|装饰装修|机电安装|竣工验收)(?:(?!(?:第\d{2,3}[日天]|，|、)).){0,8}?完成[^。；;\n]{0,10}?第(\d{2,3})[日天]/gu)) {
    pushIfNode(match[1], Number(match[2]), match[0].slice(0, 40));
  }
  // 形态 C：X节点锁定在开工后第N日（倒序锁定式）——中间负向前瞻排除「、/，/完成/第N日」，
  // 防「主体结构封顶、第450日完成装饰装修」跨节点误采（合肥师范实测误采源）
  for (const match of markdown.matchAll(/(主体(?:结构)?封顶)(?:(?!(?:第\d{2,3}[日天]|，|、|完成)).){0,20}?第(\d{2,3})日/gu)) {
    pushIfNode(match[1], Number(match[2]), match[0].slice(0, 40));
  }
  // 同节点同 raw 去重（多形态重复扫描产生的重复样本）
  const seen = new Set<string>();
  return samples.filter(sample => {
    const dedupeKey = `${sample.key}:${sample.raw}`;
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });
}

export function nodeScheduleConsistencyIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byNode = new Map<string, Array<{ key: string; day: number; raw: string }>>();
  for (const sample of extractNodeScheduleDays(markdown)) {
    const group = byNode.get(sample.key) || [];
    group.push(sample);
    byNode.set(sample.key, group);
  }
  for (const anchor of SCHEDULE_NODE_ANCHORS) {
    const group = byNode.get(anchor.key);
    if (!group || group.length < 2) continue;
    const days = [...new Set(group.map(sample => sample.day))];
    if (days.length < 2) continue;
    const maxDay = Math.max(...days);
    const minDay = Math.min(...days);
    // 同节点多套口径相差 ≥5 天即互斥（±4 天内属表述取整允许差，防零误伤）
    if (maxDay - minDay < 5) continue;
    const raws = [...new Set(group.map(sample => sample.raw))].slice(0, 4).join('、');
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `节点工期口径矛盾：“${anchor.label}”节点出现 ${days.map(day => `${day}日`).join(' 与 ')} 两套口径：${raws}`,
      suggestion: `关键节点完成时间必须全文唯一：以总进度计划表为准统一“${anchor.label}”节点日期，删除正文/其他表中矛盾的“第N日”表述。`,
    });
  }
  return issues.slice(0, 4);
}

// ── 14. 跨节数值口径冲突（h13）：确定性锚点（材料/设备名称）+ 单位收口数值集合比较。
// 与 parameterConceptConflicts（bge 概念聚类）互补：材料表 vs 正文/跨表同锚点数值多口径属
// 硬数据矛盾，无需语义聚类即可判定；覆盖单位表缺失（kVA/C标号/A强度）与表格行剔除导致的漏检。
// 合肥师范实测：XPS 30/130、垫层 C15/C20、变压器 315/800、模板周转 8/6、砌块 A5.0/A3.5、
// 灭火器 20/40、潜水泵 4/8、急救箱 3/4 八处漏检。──

const CROSS_SECTION_ANCHORS = [
  {
    key: 'xps', label: '挤塑聚苯板（XPS）厚度', unit: 'mm', kind: 'number' as const,
    // 模式 1 排除宽度/拼缝/不大于/采用等语境（防「拼缝宽度不大于2mm」「外挑楼板采用70mm厚岩棉板」误采）；
    // 模式 2 覆盖「130mm厚挤塑聚苯」数值前置形态
    patterns: [
      /(?:挤塑聚苯|XPS)(?:(?!(?:宽度|拼缝|不大于|不超过|小于|≤|采用|使用|选用|铺设|粘贴)).){0,40}?(\d+(?:\.\d+)?)\s*mm/gu,
      /(\d+(?:\.\d+)?)\s*mm[^。；;\n|]{0,10}?(?:挤塑聚苯|XPS)/gu,
    ],
  },
  {
    key: 'cushion', label: '垫层混凝土强度等级', unit: 'C标号', kind: 'code' as const,
    patterns: [/垫层[^。；;\n|]{0,20}?(C\d{2})/gu],
  },
  {
    key: 'transformer', label: '箱式变压器容量', unit: 'kVA', kind: 'number' as const,
    patterns: [
      /(\d+)\s*kVA[^。；;\n|]{0,12}?变压器/gu,
      /变压器[^。；;\n|]{0,12}?(\d+)\s*kVA/gu,
    ],
  },
  {
    key: 'formwork', label: '模板周转次数', unit: '次', kind: 'number' as const,
    patterns: [/模板周转(?:次数|使用)?[^。；;\n|]{0,15}?(\d+)\s*次/gu],
  },
  {
    key: 'block', label: '蒸压加气混凝土砌块强度等级', unit: 'A标号', kind: 'code' as const,
    patterns: [/(?:蒸压加气混凝土|加气混凝土)?砌块[^。；;\n]{0,24}?(A\d+(?:\.\d+)?)/gu],
  },
  {
    key: 'extinguisher', label: '干粉灭火器数量', unit: '具', kind: 'number' as const,
    patterns: [/灭火器[^。；;\n]{0,24}?(\d+)\s*具/gu],
  },
  {
    key: 'pump', label: '潜水泵数量', unit: '台', kind: 'number' as const,
    patterns: [/潜水泵[^。；;\n]{0,24}?(\d+)\s*台/gu],
  },
  {
    key: 'firstaid', label: '急救箱数量', unit: '套/个', kind: 'number' as const,
    patterns: [/急救箱[^。；;\n|]{0,24}?(\d+)\s*(?:套|个)/gu],
  },
  // 4.17.2 庐江实测：「45日历天」与「210日历天」两套总工期口径（45 为跨项目串染值）未被
  // 任何一致性锚点拦截。总工期语境下「X日历天」全文唯一；仅收工期锚点词（计划工期/合同工期/
  // 总工期/工期总日历天数/工期控制/工期目标）邻接的数值，防「工期相应顺延不超过30日历天」
  // 顺延口径误报；反向模式收「X日历天总工期/倒排/分解/完成」数值前置形态。
  {
    key: 'scheduleDays', label: '计划总工期', unit: '日历天', kind: 'number' as const,
    patterns: [
      /(?:计划工期|合同工期|工期总日历天数|工期控制|工期目标|总工期)[^。；;\n|]{0,12}?(\d{1,4})\s*个?\s*日历天/gu,
      /(\d{1,4})\s*个?\s*日历天[^。；;\n|]{0,8}?(?:总工期|倒排|分解|为唯一|完成)/gu,
    ],
  },
  // 4.17.2 庐江实测：基本信息表「2026ANNGZ50062」与正文「2026ANNGZ50112」两套项目编号
  // 未被任何一致性锚点拦截。项目编号全文唯一；模式收「项目编号/招标项目编号」邻接的
  // 年份+字母+编号形态（合肥公共资源 2026ANNGZ 族），不邻接标签的编号（如业绩项目编号）不采
  {
    key: 'projectCode', label: '项目编号', unit: '', kind: 'code' as const,
    patterns: [/(?:招标项目编号|项目编号)[^。；;\n|]{0,8}?(20\d{2}[A-Z]{1,8}\d{2,10})/gu],
  },
  // h15（评分报告青天高风险「核心设备型号与数量前后完全不一致」）：机械设备投入计划 vs
  // 平面布置/临时用电负荷表多处台数矛盾（塔吊 2vs1、升降机 4vs1、汽车吊 2vs1、钢筋加工设备 1vs4、圆盘锯 1vs6）。
  // 反向模式覆盖「2台TC6015塔式起重机」数值前置形态；正向模式覆盖「塔式起重机TC6015共2台」型号夹中间形态。
  // 反向模式中间仅允许型号类字符（字母数字/斜杠/短横），排除枚举标点：
  // 「施工电梯2台、汽车吊1台」的「2台、汽车吊」曾把 2 误采为汽车吊数量（真实生成误报根因）
  {
    key: 'towerCrane', label: '塔式起重机（塔吊）数量', unit: '台', kind: 'number' as const,
    patterns: [
      /(?:塔式起重机|塔吊)[^。；;\n|]{0,30}?(\d+)\s*台/gu,
      /(\d+)\s*台[A-Za-z0-9/\-–—～~]{0,16}\s{0,2}(?:塔式起重机|塔吊)/gu,
    ],
  },
  {
    // 「施工电梯」与「施工升降机」同物异名（真实生成两词并存，仅收前者漏检 L605 2台 vs L787 1台 矛盾）
    key: 'hoist', label: '施工升降机（施工电梯）数量', unit: '台', kind: 'number' as const,
    patterns: [
      /(?:施工升降机|施工电梯)[^。；;\n|]{0,30}?(\d+)\s*台/gu,
      /(\d+)\s*台[A-Za-z0-9/\-–—～~]{0,16}\s{0,2}(?:施工升降机|施工电梯)/gu,
    ],
  },
  {
    key: 'truckCrane', label: '汽车起重机（汽车吊）数量', unit: '台', kind: 'number' as const,
    patterns: [
      /(?:汽车起重机|汽车吊)[^。；;\n|]{0,30}?(\d+)\s*台/gu,
      /(\d+)\s*台[A-Za-z0-9/\-–—～~]{0,16}\s{0,2}(?:汽车起重机|汽车吊)/gu,
    ],
  },
  {
    key: 'rebarCutter', label: '钢筋切断机数量', unit: '台', kind: 'number' as const,
    patterns: [/钢筋切断机[^。；;\n|]{0,24}?(\d+)\s*台/gu],
  },
  {
    key: 'rebarBender', label: '钢筋弯曲机数量', unit: '台', kind: 'number' as const,
    patterns: [/钢筋弯曲机[^。；;\n|]{0,24}?(\d+)\s*台/gu],
  },
  {
    key: 'circularSaw', label: '圆盘锯数量', unit: '台', kind: 'number' as const,
    patterns: [/圆盘锯[^。；;\n|]{0,24}?(\d+)\s*台/gu],
  },
] as const;

const ENUMERATION_VALUE_RE = /\d+(?:\.\d+)?\s*(?:mm|kVA|次|具|台|套|个)\s*[/／]\s*\d+/u;

// 否定声明句豁免：「现场统一配置1台汽车起重机，本章及后续章节不再出现“汽车吊2台”等
// 与施工部署不一致的数量表述」属 LLM 一致性声明，句内数值是引用旧矛盾值而非事实口径，
// 曾导致汽车吊 2vs1 误报（真实生成实测）
const NEGATIVE_DECLARATION_RE = /不再出现|不得出现|严禁出现|避免出现|不采用|未采用|予以删除|已删除|取消|纠正为|更正为/u;

export function crossSectionNumericConflictIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const anchor of CROSS_SECTION_ANCHORS) {
    const values = new Set<string>();
    const raws: string[] = [];
    for (const pattern of anchor.patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const raw = match[0].slice(0, 40);
        // 并列枚举豁免：「50mm/70mm」「C30/C35」属同句多规格正常枚举，不判冲突
        if (ENUMERATION_VALUE_RE.test(raw)) continue;
        // 否定声明句豁免：match 所在行含「不再出现」等声明词时不计入口径池
        const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
        let lineEnd = markdown.indexOf('\n', match.index);
        if (lineEnd === -1) lineEnd = markdown.length;
        if (NEGATIVE_DECLARATION_RE.test(markdown.slice(lineStart, lineEnd))) continue;
        values.add(match[1]);
        raws.push(raw);
      }
    }
    if (values.size < 2) continue;
    if (anchor.kind === 'code') {
      // 标号类（C15/C20、A5.0/A3.5）：不同标号直接互斥
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `材料参数口径矛盾：“${anchor.label}”出现 ${[...values].map(value => `${value}${anchor.unit}`).join(' 与 ')} 两套口径：${[...new Set(raws)].slice(0, 3).join('、')}`,
        suggestion: `同一材料参数全文只允许一个口径：以设计图纸/工程量清单为准统一“${anchor.label}”，删除矛盾表述。`,
      });
    } else {
      const numbers = [...values].map(Number).filter(Number.isFinite);
      if (numbers.length < 2) continue;
      const maxValue = Math.max(...numbers);
      const minValue = Math.min(...numbers);
      // 数值差异 >20% 判互斥（3 vs 4、8 vs 6 这类量级差异在评审口径均属矛盾）
      if (maxValue - minValue <= maxValue * 0.2) continue;
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `材料/设备数量口径矛盾：“${anchor.label}”出现 ${numbers.map(value => `${value}${anchor.unit}`).join(' 与 ')} 两套口径：${[...new Set(raws)].slice(0, 3).join('、')}`,
        suggestion: `同一设备/材料数量全文只允许一个口径：以应急物资清单/施工部署为准统一“${anchor.label}”，删除矛盾表述。`,
      });
    }
  }
  return issues.slice(0, 8);
}

// ── 15. 桩基表述残留（h13）：地基与基础章节施工流程无桩基工序（筏板/独立基础），
// 但全文其他位置残留桩基表述（桩基施工/桩机/桩基检验批/桩基钢筋笼）属跨模板拼接断裂。
// 判定：所有「地基与基础」小节块内均无桩基工序词 → 基础形式不含桩；此时全文桩基表述 ≥2 处即报。
// 合肥师范实测：5 处桩基残留（进度计划表/关键节点表/质量验收划分表/隐蔽验收表/噪声管控段）。──

const PILE_WORKFLOW_RE = /桩基|灌注桩|钻孔桩|打桩|成桩|桩机/u;

function foundationSectionBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const matches = [...markdown.matchAll(/^#{3,4}\s+[^\n]*(?:地基与基础)[^\n]*$/gmu)];
  for (const match of matches) {
    const start = (match.index || 0) + match[0].length;
    const nextHeading = markdown.slice(start).search(/^#{2,4}\s+/mu);
    const block = markdown.slice(start, nextHeading >= 0 ? start + nextHeading : markdown.length);
    blocks.push(block);
  }
  return blocks;
}

export function foundationFormResidueIssues(markdown: string): ValidationIssue[] {
  const foundationBlocks = foundationSectionBlocks(markdown);
  if (foundationBlocks.length === 0) return [];
  // 任一「地基与基础」小节块含桩基工序词 → 本项目基础形式含桩，桩基表述合法
  if (foundationBlocks.some(block => PILE_WORKFLOW_RE.test(block))) return [];
  const hits: string[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed)) continue;
    if (PILE_WORKFLOW_RE.test(line)) hits.push(trimmed.slice(0, 48));
  }
  const unique = [...new Set(hits)].slice(0, 5);
  if (unique.length < 2) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `桩基表述残留：地基与基础章节施工流程为筏板/独立基础（无桩基工序），但全文另有 ${unique.length} 处桩基表述：${unique.join('、')}`,
    suggestion: '本项目基础形式不含桩基：删除全文所有桩基/桩机表述，进度计划表关键线路工序、质量验收划分表、隐蔽验收表均改为本项目实际基础工序（垫层/底板钢筋/混凝土）。',
  }];
}

// ── 基本信息表「计划工期」字段违约词校验（h13d）：工期行误填违约条款文字 ──
// 计划工期字段的合法值域是日历天数值表述（如「540个日历天」）；违约条款文字
// （工期延误/切除/赔偿/罚款等）出现在该行即槽位错填（合肥师范实测：该行误填
// 「工期延误56天以上发包人可切除剩余工程量」，与合同工期 540 天口径无关）。
const SCHEDULE_ROW_RE = /^\s*\|\s*计划工期\s*\|([^|\n]*)\|/u;
const SCHEDULE_VIOLATION_WORD_RE = /工期延误|延误|违约|切除|赔偿|罚款|解除|扣减/u;

export function basicInfoScheduleFieldIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const match = SCHEDULE_ROW_RE.exec(line);
    if (!match) continue;
    const value = (match[1] ?? '').trim();
    if (!value || !SCHEDULE_VIOLATION_WORD_RE.test(value)) continue;
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `基本信息表「计划工期」字段错填违约条款文字：“${value.slice(0, 40)}”`,
      suggestion: '「计划工期」字段应填日历天数值（与招标文件前附表一致，如「540个日历天」）；工期延误违约条款文字应放在工期风险管控章节，不得占用基本信息表字段。',
    });
  }
  return issues.slice(0, 2);
}

// ── 16. 关键设计决策两可表述阻断（h14）：基础/支护等关键设计决策不得以斜杠并列
// （「支护桩/放坡」）或括号悬置（「桩基（或独立基础/筏板基础按图纸实施）」）表述——
// 评分报告 P4 实测：正文以两可形态把设计决策推回图纸，属交付前必须锁定的评审硬伤。
// 判定防误伤：两可形态必须出现在设计决策语境（词族+决策动词窗口），职业枚举（木工/钢筋工）、
// 数字单位枚举（50mm/70mm、C30/C35）均不命中。──

/** 关键设计参数词族：斜杠两侧/悬置窗口须命中其一（基础/支护/结构等），排除职业枚举误伤 */
const DESIGN_PARAM_WORD_RE = /基础|支护|围护|桩|结构|开挖|放坡|喷锚|排桩|连续墙|土钉|锚杆|标高|深度|形式|体系/u;

export function ambiguousEitherOrIssues(markdown: string): ValidationIssue[] {
  const normalized = markdown.replace(/\s+/gu, '');
  const hits = new Set<string>();
  // 形态 A：关键参数斜杠并列两可（「支护桩/放坡」「桩基础/独立基础」）；
  // 数字枚举由归一化后不含数字单位判定天然豁免（50mm/70mm 两侧词 <2 汉字不入枚举）
  const slashRe = /([一-龥]{2,8})\/([一-龥]{2,8})/gu;
  for (const match of normalized.matchAll(slashRe)) {
    if (!DESIGN_PARAM_WORD_RE.test(match[1]) && !DESIGN_PARAM_WORD_RE.test(match[2])) continue;
    const start = Math.max(0, (match.index || 0) - 12);
    const end = Math.min(normalized.length, (match.index || 0) + match[0].length + 12);
    const window = normalized.slice(start, end);
    // 决策语境要求：附近有决策动词（「采用桩基础/独立基础」是决策，「主体结构木工/钢筋工」不是）
    if (!/采用|形式|方式|方案|选用|拟用|拟采用|为/u.test(window)) continue;
    hits.add(`“${match[1]}/${match[2]}”`);
  }
  // 形态 B：括号悬置决策「（或…按图纸实施）」：括号内「或」+ 悬置词（按图纸/待定/另行…），
  // 且括号前窗口命中设计参数词族（「桩基（或独立基础/筏板基础按图纸实施）」）
  const pendingRe = /[（(]\s*或[^）)]{1,48}[）)]/gu;
  for (const match of normalized.matchAll(pendingRe)) {
    const inner = match[0].slice(1, -1);
    if (!/按图纸|按实|按图|待定|另行|视[^，。；]{0,8}而定|根据实际/u.test(inner)) continue;
    const start = Math.max(0, (match.index || 0) - 20);
    const window = normalized.slice(start, (match.index || 0) + match[0].length);
    if (!DESIGN_PARAM_WORD_RE.test(window)) continue;
    hits.add(match[0].slice(0, 30));
  }
  if (hits.size === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `关键设计决策两可表述：${[...hits].join('、')} 以并列/悬置形态表述，基础形式、支护形式等关键决策必须在正文中唯一确定`,
    suggestion: '以设计图纸/勘察报告/工程量清单为准锁定唯一决策并删除两可表述：明确写出本项目基础形式与支护形式的具体做法（如「基础形式为筏板基础」「基坑支护采用放坡+喷锚」），禁止「或…按图纸实施」类悬置话术。',
  }];
}

// ── 17. 基坑深度数值锁定（h14）：评分报告 P1——正文出现基坑支护/开挖成稿内容时，
// 全文必须有「深度/标高+数值」表述（危大工程分级判定的强制依据）；资料库含 5.85m 而
// 正文 0 处即漏锁（实测：前版有 5.85m，本版退化为无深度表述）。
// 判定自洽：基坑语境 ≥3 处且全文无深度数值表述即报，修复轮从绑定资料锁定数值。──

export function excavationDepthLockIssues(markdown: string): ValidationIssue[] {
  const normalized = markdown.replace(/\s+/gu, '');
  const pitHits = normalized.match(/基坑|开挖|支护/gu) || [];
  if (pitHits.length < 3) return [];
  // 4.12.12 真实生成回归：正文「开挖深度按基坑支护设计图纸确定」实为未锁定数值，但
  // 通用危大阈值「开挖深度超过3m」「单次开挖深度不大于1.5m」「深度2倍距离」被误判为
  // 项目深度数值导致漏报——确定式窗口过滤：深度/标高后直接跟数值（约/为/达/：允许）
  // 才算锁定；比较式（超过/大于/小于/不大于…）、按图式（按/依据/详见）、倍数式（倍，
  // 数字后窗口内）全部排除
  const depthWindows = normalized.matchAll(/(?:深度|标高)[^。；，,]{0,12}-?\d+(?:\.\d+)?[^。；，,]{0,6}/gu);
  for (const match of depthWindows) {
    const window = match[0];
    if (/(?:超过|大于|小于|不[大低小]于|不低于|按|倍|依据|详见|参考|示意|每)/u.test(window)) continue;
    return [];
  }
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: '基坑深度数值未锁定：正文已有基坑支护/开挖成稿内容，但全文未出现「深度/标高+数值」的确定性表述（比较式阈值如「超过3m」不视为锁定），危大工程分级判定失去依据',
    suggestion: '从绑定资料（地质勘察报告/基坑支护设计图/基础平面图）锁定基坑开挖深度数值（如 5.85m）写入基坑支护小节；深度 ≥5m 的深基坑须同步标注危大工程分级与专家论证要求，禁止以「按图纸确定」回避深度数值。',
  }];
}

// ── 18. 奖项白名单（h14）：正文出现的具名奖项（XX杯/XX奖）必须来自招标文件评分项要求提取
// 或绑定资料质量事实；白名单外的奖项判定杜撰（实测「奖项杜撰 5 处」——写作层自行编造奖项
// 替代招标要求奖项，评标否决级硬伤）。白名单为空（提取失败）时不报：宁漏报不误报，
// 提取失败有显性 stage 警示，不得在无基准时阻断交付。──

// 4.12.13 真实生成回归：{2,10}汉字+「奖」贪婪前缀把奖惩管理/奖项申报词汇误判为具名奖项——
// 「逐笔登记奖励发放」「创优奖金」「建立与合同奖惩挂钩」「按合同约定不奖励」「奖项申报」被截断为
// 「逐笔登记奖」「创优奖」「建立与合同奖」「按合同约定不奖」「创优目标与奖」，造成 8 处假阻断与修复空转。
// 负向前瞻排除「奖」后紧跟励/金/惩/罚/项的语素续接形态；真奖项名（黄山杯/鲁班奖）不受影响
const AWARD_NAME_RE = /[\u4e00-\u9fa5]{2,10}(?:杯|奖)(?![励金惩罚项])/gu;
/** 通用目标类表述不判杜撰：省优/市优/优质工程/文明工地等非具名目标 */
const GENERIC_AWARD_RE = /优质工程|文明工地|样板|标准化|观摩|示范|精品工程|结构优质|省优|市优/u;

/**
 * 剥离奖项名前导动词/承诺词（"确保获得黄山杯"→"黄山杯"），循环剥离直至稳定。
 * 与 tenderRequirements.stripAwardLeadVerb 同口径：贪婪前缀把承诺动词吞入奖项名，
 * 白名单"确保黄山杯"与正文"确保获得黄山杯"口径分裂导致误报。
 */
function stripAwardLeadVerb(award: string): string {
  let result = award;
  for (;;) {
    const stripped = result.replace(/^(?:争创|争取|力争|争获|确保|获得|创建|力创|评为|荣获|标为|目标为|承诺|为)/u, '');
    if (stripped === result || !stripped) break;
    result = stripped;
  }
  return result;
}

// ── 19. 表格重复（h15）：同一文档内出现表头/首列高度重合的两张表属复制粘贴残留 ──
// 青天评分报告实测：「危大工程全流程闭环管控表」同一章节出现两张（第二张删减关键信息），
// 属多模板拼接未清理痕迹；全文无冗余重复是形式格式类评审硬要求。
// 判定：表头归一化完全相同，或表头相似度 ≥0.7 且首列重合 ≥60%；表格行/标题行不入段落重复池。

interface MarkdownTableBlock { startLine: number; endLine: number; header: string[]; firstCol: string[]; dataCells: string[]; bodyChars: number; raw: string[] }

const TABLE_SEPARATOR_RE = /^\s*\|[\s:|-]+\|/u;
/** 数据行与表头相似度达到该阈值时视为「无分隔行的重复粘贴表头」，在块内切分新表 */
const EMBEDDED_HEADER_SIM = 0.6;

function extractMarkdownTables(markdown: string): MarkdownTableBlock[] {
  const lines = markdown.split(/\r?\n/u);
  const tables: MarkdownTableBlock[] = [];
  const cells = (row: string) => row.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
  const isSeparator = (row: string) => TABLE_SEPARATOR_RE.test(row);
  let cursor = 0;
  while (cursor < lines.length) {
    if (!/^\s*\|/u.test(lines[cursor])) { cursor += 1; continue; }
    let end = cursor;
    while (end < lines.length && /^\s*\|/u.test(lines[end])) end += 1;
    const block = lines.slice(cursor, end);
    // 连排表切分：同一 | 行块内可能粘贴了多张表。①标准形态「表头行+分隔行」成表；
    // ②复制粘贴残留形态：表头行后缺分隔行（青天实测「主要机械设备投入计划表重复两次」
    // 第二张表无分隔行直接接数据行）——数据行与当前表头相似度 ≥0.6 时在该行切分新表。
    let currentHeader: string[] | undefined;
    let tableStart = 0;
    let dataStart = 0;
    let blockIndex = 0;
    const pushTable = (dataEnd: number) => {
      if (!currentHeader) return;
      const dataRows = block.slice(dataStart, dataEnd);
      if (dataRows.length === 0) return;
      tables.push({
        startLine: cursor + tableStart,
        endLine: cursor + dataEnd - 1,
        header: currentHeader,
        firstCol: dataRows.map(row => cells(row)[0]?.replace(/[*_`]/gu, '').trim() || '').filter(Boolean),
        dataCells: dataRows.flatMap(row => cells(row).map(cell => cell.replace(/[*_`]/gu, '').trim())).filter(Boolean),
        bodyChars: dataRows.join('').length,
        raw: block.slice(tableStart, dataEnd),
      });
    };
    while (blockIndex < block.length) {
      // ① 标准表头：当前行 + 下一行分隔行
      if (blockIndex + 1 < block.length && isSeparator(block[blockIndex + 1] || '')) {
        pushTable(blockIndex);
        currentHeader = cells(block[blockIndex]).map(cell => cell.replace(/[*_`]/gu, '').trim());
        tableStart = blockIndex;
        dataStart = blockIndex + 2;
        blockIndex += 2;
        continue;
      }
      // ② 无分隔行的重复粘贴表头（需已处于数据区且其后还有行）
      if (currentHeader && blockIndex > dataStart) {
        const rowCells = cells(block[blockIndex]).map(cell => cell.replace(/[*_`]/gu, '').trim()).filter(Boolean);
        if (jaccard(rowCells, currentHeader) >= EMBEDDED_HEADER_SIM && blockIndex + 1 < block.length && !isSeparator(block[blockIndex + 1] || '')) {
          pushTable(blockIndex);
          currentHeader = rowCells;
          tableStart = blockIndex;
          dataStart = blockIndex + 1;
          blockIndex += 1;
          continue;
        }
      }
      blockIndex += 1;
    }
    pushTable(block.length);
    cursor = end;
  }
  return tables;
}

function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter(item => rightSet.has(item)).length;
  return intersection / new Set([...leftSet, ...rightSet]).size;
}

/** 小表数据单元格在大表中的覆盖比例（多重集按出现次数计，识别「删减版子表」形态：
 * 真重复表的小表几乎完全被大表覆盖；同主题互补表（统计表 vs 投入计划表）两表各有大量独有单元格，覆盖度低） */
function cellCoverage(small: string[], large: string[]): number {
  if (small.length === 0) return 0;
  const pool = [...large];
  let covered = 0;
  for (const cell of small) {
    const index = pool.indexOf(cell);
    if (index >= 0) { pool.splice(index, 1); covered += 1; }
  }
  return covered / small.length;
}

// 纯数字单元格（含人数/台数单位）：互补表共享峰值/人数数字是「口径一致」的体现，
// 不能作为重复证据；真重复表的文本内容 cell 整列复制才是复制粘贴特征
const NUMERIC_CELL_RE = /^[\d,，.]+\s*(?:人|个|台|具|套|处|支|辆|班|组|项)?$/u;
const textCellsOf = (cells: string[]) => cells.filter(cell => !NUMERIC_CELL_RE.test(cell));

export function duplicateTableIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tables = extractMarkdownTables(markdown);
  if (tables.length < 2) return issues;
  for (let left = 0; left < tables.length; left += 1) {
    for (let right = left + 1; right < tables.length; right += 1) {
      const a = tables[left];
      const b = tables[right];
      const headerSame = a.header.length > 0 && a.header.length === b.header.length && a.header.every((cell, index) => cell === b.header[index]);
      const headerSim = jaccard(a.header, b.header);
      const firstColSim = jaccard(a.firstCol, b.firstCol);
      // 同结构不同内容的表（如表头「保护对象|位置关系|风险影响」在不同章节各列不同对象）
      // 不得仅凭表头相同判重复（旧文档实测：表头 100% 重合但首列 0%~11% 的三组被误报）。
      // 真重复形态（青天实测）：①完全一致连续表（数据行 100% 重合）②第二次缺列的高度重复表
      //（表头相似 ≥0.7 且首列重合 ≥0.6）③同主题不同表头结构（「分阶段劳动力投入计划表」出现两次，
      // 表头相似仅 0.11 但首列同批阶段重合 ≥0.6）——③改用文本 cell 双向覆盖度 ≥0.6（原数据重合 ≥0.15
      // 把「统计表 vs 投入计划表」这类同主题互补表误判为重复；文本 cell 排除纯数字 cell，
      // 互补表共享平均/高峰人数数字是口径一致的体现而非重复证据；双向 max 覆盖「删减版子表」形态——
      // 粘贴时删列的复制表（cell 数少）与带全列的原表（cell 数多）互为覆盖方向）
      const dataSim = jaccard(a.dataCells, b.dataCells);
      const dataCoverage = Math.max(
        cellCoverage(textCellsOf(a.dataCells), textCellsOf(b.dataCells)),
        cellCoverage(textCellsOf(b.dataCells), textCellsOf(a.dataCells)),
      );
      if (!(headerSame && dataSim >= 0.6) && !(headerSim >= 0.7 && firstColSim >= 0.6) && !(firstColSim >= 0.6 && dataCoverage >= 0.6)) continue;
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'style',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `表格重复：第 ${a.startLine + 1}~${a.endLine + 1} 行表格（表头：${a.header.slice(0, 3).join('|')}）与第 ${b.startLine + 1}~${b.endLine + 1} 行表格高度重复（表头重合 ${Math.round(headerSim * 100)}%、数据重合 ${Math.round(dataSim * 100)}%、首列重合 ${Math.round(firstColSim * 100)}%）`,
        suggestion: '同一文档内同主题表格只保留信息最全的一张：删除重复表格（保留字段与数据行更多的那张），删除后核对章节表格计划仍被覆盖。',
      });
    }
  }
  // 按重合度降序取前 5（真重复优先于同结构近似表，避免 slice 截断把真阳性挤出）
  return issues.sort((left, right) => {
    const sim = (message: string) => Number(message.match(/数据重合\s*(\d+)%/u)?.[1] ?? 0);
    return sim(right.message) - sim(left.message);
  }).slice(0, 5);
}

/** 表格重复确定性删除（检测定位=修复定位）：保留信息量大的那张（数据行字符多者），删除其余重复表 */
export function stripDuplicateTables(markdown: string): { markdown: string; removedCount: number } {
  const tables = extractMarkdownTables(markdown);
  if (tables.length < 2) return { markdown, removedCount: 0 };
  const lines = markdown.split(/\r?\n/u);
  const removed = new Set<number>();
  for (let left = 0; left < tables.length; left += 1) {
    for (let right = left + 1; right < tables.length; right += 1) {
      const a = tables[left];
      const b = tables[right];
      if (removed.has(a.startLine) || removed.has(b.startLine)) continue;
      const headerSame = a.header.length > 0 && a.header.length === b.header.length && a.header.every((cell, index) => cell === b.header[index]);
      const headerSim = jaccard(a.header, b.header);
      const firstColSim = jaccard(a.firstCol, b.firstCol);
      const dataSim = jaccard(a.dataCells, b.dataCells);
      // 双向覆盖（与 duplicateTableIssues 同口径）：粘贴时删列的复制表（cell 数少）与带全列的原表
      // 互为覆盖方向，单向按 cell 数选小表会把「删减版子表」漏删
      const dataCoverage = Math.max(
        cellCoverage(textCellsOf(a.dataCells), textCellsOf(b.dataCells)),
        cellCoverage(textCellsOf(b.dataCells), textCellsOf(a.dataCells)),
      );
      // 与 duplicateTableIssues 同判定口径（检测定位=修复定位）：同结构不同内容表不删
      if (!(headerSame && dataSim >= 0.6) && !(headerSim >= 0.7 && firstColSim >= 0.6) && !(firstColSim >= 0.6 && dataCoverage >= 0.6)) continue;
      // 保留 bodyChars 大者（信息更全），删除另一张
      const [keep, drop] = a.bodyChars >= b.bodyChars ? [a, b] : [b, a];
      for (let line = drop.startLine; line <= drop.endLine; line += 1) removed.add(line);
      void keep;
    }
  }
  if (removed.size === 0) return { markdown, removedCount: 0 };
  return {
    markdown: lines.filter((_, index) => !removed.has(index)).join('\n'),
    removedCount: removed.size,
  };
}

// ── 20. 段落完全重复（h15）：同一长段落（≥40 字）全文出现 ≥2 次属复制粘贴残留 ──
// 青天评分报告实测：「危险源辨识覆盖基坑支护、装配式构件吊装……」段落与表格前段落完全重复；
// 判定只收「归一化后完全相等」的段落（长度 ≥40 字），表格行/标题行不入池，零语义成本零误伤。

const DUPLICATE_PARAGRAPH_MIN_CHARS = 40;

function paragraphFingerprint(paragraph: string): string | undefined {
  const normalized = paragraph.replace(/\s+/gu, '');
  return normalized.length >= DUPLICATE_PARAGRAPH_MIN_CHARS ? normalized : undefined;
}

export function duplicateParagraphIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = markdown.split(/\r?\n/u);
  const seen = new Map<string, number>();
  let buffer: string[] = [];
  const flush = () => {
    const fingerprint = paragraphFingerprint(buffer.join(''));
    if (fingerprint) {
      const count = (seen.get(fingerprint) || 0) + 1;
      seen.set(fingerprint, count);
    }
    buffer = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    // 标题行/表格行不入池（标题重复由 headingDuplicateIssues 管，表格由 duplicateTableIssues 管）
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) { flush(); continue; }
    if (/^[-*•]\s/u.test(trimmed)) { flush(); buffer.push(trimmed); flush(); continue; }
    buffer.push(trimmed);
  }
  flush();
  const duplicates = [...seen.entries()].filter(([, count]) => count >= 2);
  for (const [fingerprint, count] of duplicates.slice(0, 3)) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'style',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `段落完全重复 ${count} 次：“${fingerprint.slice(0, 40)}…”`,
      suggestion: '同一段落正文只保留首次出现处，删除其余重复段落；确需前后呼应时改写为差异化表述并压缩篇幅。',
    });
  }
  return issues;
}

/** 段落完全重复确定性删除：保留首次出现，删除后续完全相同段落（标题行/表格行/分隔行不动） */
export function stripDuplicateParagraphs(markdown: string): { markdown: string; removedCount: number } {
  const lines = markdown.split(/\r?\n/u);
  const seen = new Set<string>();
  const drop = new Set<number>();
  let buffer: string[] = [];
  let bufferLines: number[] = [];
  const flush = () => {
    const fingerprint = paragraphFingerprint(buffer.join(''));
    if (fingerprint) {
      if (seen.has(fingerprint)) {
        bufferLines.forEach(index => drop.add(index));
      } else {
        seen.add(fingerprint);
      }
    }
    buffer = [];
    bufferLines = [];
  };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) { flush(); return; }
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) { flush(); return; }
    if (/^[-*•]\s/u.test(trimmed)) { flush(); buffer = [trimmed]; bufferLines = [index]; flush(); return; }
    buffer.push(trimmed);
    bufferLines.push(index);
  });
  flush();
  if (drop.size === 0) return { markdown, removedCount: 0 };
  return { markdown: lines.filter((_, index) => !drop.has(index)).join('\n'), removedCount: drop.size };
}

export function fabricatedAwardIssues(markdown: string, factsModel: DocumentFactsModel, tenderRequirements?: TenderRequirementModel): ValidationIssue[] {
  const whitelist = new Set<string>();
  // 白名单来源 1：绑定资料质量/项目/进度事实中的奖项表述（招标文件原文出现的奖项）
  for (const fact of [...factsModel.quality, ...factsModel.project, ...factsModel.schedule]) {
    const text = stringifyFactValue(fact.value);
    for (const match of text.matchAll(AWARD_NAME_RE)) whitelist.add(stripAwardLeadVerb(match[0]));
  }
  // 白名单来源 2：评分项要求提取的奖项类文本（创优目标/特殊质量标准/奖项条款）
  if (tenderRequirements?.extracted) {
    const items = [...(tenderRequirements.awardObjectives || []), ...(tenderRequirements.specialQualityStandards || []), ...(tenderRequirements.awardClauses || [])];
    for (const item of items) {
      for (const match of (item.text || '').matchAll(AWARD_NAME_RE)) whitelist.add(stripAwardLeadVerb(match[0]));
    }
  }
  if (whitelist.size === 0) return [];
  const fabricated = new Set<string>();
  for (const match of markdown.matchAll(AWARD_NAME_RE)) {
    const award = stripAwardLeadVerb(match[0]);
    if (whitelist.has(award)) continue;
    if (GENERIC_AWARD_RE.test(award)) continue;
    fabricated.add(award);
  }
  if (fabricated.size === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `奖项表述与招标文件白名单不符：正文出现 ${[...fabricated].join('、')}，均未出现在招标文件评分项要求或绑定资料中`,
    suggestion: '创优目标必须以招标文件原文为准逐字落位（如「确保黄山杯」），禁止自行编造或替换为其他奖项名称；白名单外的奖项表述一律删除或替换为招标原文奖项。',
  }];
}

// ── 18b. 投标人资格内容串章检测（评分报告 P1）──
// 「具备有效的营业执照」「具备有效的资质证书、具备有效的安全生产许可证」等资格审查小节
// 属招标文件资格文件内容，非施工组织设计正文。生成前大纲已有四道防线（大纲黑名单/校准验证/
// 要求条款过滤/响应性分类），生成后 Final Gate 再设同口径检测器：写手自创小节穿透生成前过滤时，
// 由交付阻断修复轮的确定性删除兜底。判定与 isQualificationSectionTitle 同源，防口径漂移。

export function bidderQualificationSectionIssues(markdown: string): ValidationIssue[] {
  const lines = markdown.split(/\r?\n/u);
  const hitTitles = new Set<string>();
  for (const line of lines) {
    const heading = /^(#{2,4})\s+(.+)$/u.exec(line.trim());
    if (!heading) continue;
    const title = heading[2].trim();
    if (isQualificationSectionTitle(title)) hitTitles.add(title);
  }
  if (hitTitles.size === 0) return [];
  const titles = [...hitTitles];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'structure',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `正文出现投标人资格内容小节：${titles.slice(0, 3).map(title => `“${title}”`).join('、')}${titles.length > 3 ? ' 等' : ''}（资格审查内容不属于施工组织设计，属资格文件/商务文件范畴）`,
    suggestion: '删除资格内容小节（标题与正文整体删除），不得以改写、合并、降级方式保留；正文如需提及安全生产许可证等证照，只能以施工管理口径表述（如“按规定持证上岗”），不得成节铺陈资格核验内容。',
  }];
}

// ── h16. 人材机三合一章结构层级检测（第五章层级错位缺陷） ──
// 「确保人、材、机的保障体系与措施」章必须拆为 人/材/机 三个二级小节；
// 材/机保障体系内容不得以三级/四级标题形式挂在「人的保障体系」小节下（真实生成缺陷：
// 任务卡仅 1 条细目走整章 compact-fallback 路径，LLM 自由拆分时把材/机保障体系降级为 H4
// 挂在“5.1 确保人的保障体系与措施”之下形成层级错位）。
// 纯结构判定（标题主语与父级主语比对），不涉内容语义判断。

const RESOURCE_TRIAD_CHAPTER_RE = /人[、,，]材[、,，]机/u;
const RESOURCE_TRIAD_SUBJECT_SECTION_RE = /(?:确保\s*)?([人材机])(?:员|力|料|械|工)?\s*的保障体系与措施/u;

/** H3/H4 标题主语提取：标准形态（“材的保障体系与措施”）优先；退化形态按语义词映射（劳动力→人、材料→材、机械/设备→机） */
function resourceTriadSubject(title: string): string | undefined {
  const standard = title.match(RESOURCE_TRIAD_SUBJECT_SECTION_RE)?.[1];
  if (standard) return standard;
  if (/劳动力|人员|作业人员|劳务/u.test(title)) return '人';
  if (/材料|物资|周转/u.test(title)) return '材';
  if (/机械|设备|机具|塔吊|起重机/u.test(title)) return '机';
  return undefined;
}

export function resourceTriadSectionHierarchyIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = markdown.split(/\r?\n/u);
  // 章区间切分（## 到下一个 ##）
  for (let chapterStart = 0; chapterStart < lines.length; chapterStart += 1) {
    const h2 = /^##\s+(.+)$/u.exec(lines[chapterStart].trim());
    if (!h2) continue;
    if (!RESOURCE_TRIAD_CHAPTER_RE.test(h2[1])) continue;
    let chapterEnd = lines.length;
    for (let next = chapterStart + 1; next < lines.length; next += 1) {
      if (/^##\s+/u.test(lines[next].trim())) { chapterEnd = next; break; }
    }
    const h3Subjects: Array<{ subject: string | undefined; title: string }> = [];
    let currentH3: { subject: string | undefined; title: string } | undefined;
    for (let index = chapterStart + 1; index < chapterEnd; index += 1) {
      const h3 = /^###\s+(.+)$/u.exec(lines[index].trim());
      const h4 = /^####\s+(.+)$/u.exec(lines[index].trim());
      if (h3) {
        currentH3 = { subject: resourceTriadSubject(h3[1]), title: h3[1].trim() };
        h3Subjects.push(currentH3);
        continue;
      }
      if (h4 && currentH3?.subject) {
        const subject = resourceTriadSubject(h4[1]);
        if (subject && subject !== currentH3.subject) {
          issues.push({
            level: 'error',
            severity: 'blocker',
            category: 'structure',
            owner: 'llm',
            repairability: 'llm_repairable',
            message: `人材机章层级错位：小节“${h4[1].trim()}”挂在“${currentH3.title}”之下（${subject === '人' ? '人' : subject === '材' ? '材' : '机'}的保障体系应独立成二级小节，不得并入${currentH3.subject === '人' ? '人' : currentH3.subject === '材' ? '材' : '机'}的保障体系）`,
            suggestion: `将“${h4[1].trim()}”提升为独立二级小节，或将其内容合并到对应主题的二级小节。`,
          });
        }
      }
    }
    const subjects = new Set(h3Subjects.map(item => item.subject).filter(Boolean) as string[]);
    const triadComplete = ['人', '材', '机'].every(subject => subjects.has(subject));
    if (h3Subjects.length < 3 || !triadComplete) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'structure',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `人材机章结构不完整：“${h2[1].trim()}”仅 ${h3Subjects.length} 个二级小节（人/材/机的保障体系未全部独立成节）`,
        suggestion: '拆分为“确保人的保障体系与措施”“确保材的保障体系与措施”“确保机的保障体系与措施”三个二级小节。',
      });
    }
  }
  return issues;
}

// ── A2（4.12.23）：跨章数值矛盾确定性修复 ──────────────────────────────────
// 「检测定位=修复定位」扩展：检测器家族（resourceConsistencyIssues /
// nodeScheduleConsistencyIssues / crossSectionNumericConflictIssues）已锁定矛盾
// 数值对与权威口径（表格优先），此处同源定点替换，不再依赖 LLM 定位能力。
// 历史缺陷：LLM 修复跨章数值矛盾时 patch 锚点常失配（260/160、60/70、300/310 等
// 矛盾残留进导出门禁形成 33 阻断），修复轮次被浪费在无效 LLM 调用上。
// 零误伤原则：只修复检测器同阈值会报的矛盾对，且权威口径（表格）存在才修复；
// 无法确定权威口径的场景（如两处正文互斥无表格）保持不动，交 LLM 修复路径。

export interface NumericConsistencyFixResult {
  markdown: string;
  fixedCount: number;
  details: string[];
}

/** 从后往前应用定点替换（避免索引偏移；detail 去重保序） */
function applySpanReplacements(markdown: string, replacements: Array<{ start: number; end: number; replacement: string; detail: string }>): { markdown: string; fixedCount: number; details: string[] } {
  if (replacements.length === 0) return { markdown, fixedCount: 0, details: [] };
  const sorted = [...replacements].sort((a, b) => b.start - a.start);
  let next = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of sorted) {
    next = next.slice(0, item.start) + item.replacement + next.slice(item.end);
    fixedCount += 1;
    details.push(item.detail);
  }
  return { markdown: next, fixedCount, details: [...new Set(details)].slice(0, 8) };
}

/** 劳动力峰值确定性修复：正文总口径峰值/控制上限与分阶段投入明细表峰值矛盾 → 正文数字改为表格峰值。
 * 与检测器同源同阈值：>30% 才矛盾、阶段限定峰值不参与（laborPeakStageOf 同源判定）。 */
function fixLaborPeakConflicts(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const tablePeak = tablePeakLabor(markdown);
  if (tablePeak === undefined) return { markdown, fixedCount: 0, details: [] };
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  const collect = (pattern: RegExp) => {
    for (const match of markdown.matchAll(pattern)) {
      const value = Number(match[1].replace(/[,，]/gu, ''));
      if (!Number.isFinite(value) || value <= 0) continue;
      const valueIndex = match.index + match[0].indexOf(match[1]);
      // 与检测器模式 3 同源：仅无阶段限定的总口径峰值与表峰值比较；差值 ≤30% 不矛盾
      if (laborPeakStageOf(markdown, valueIndex)) continue;
      if (value <= tablePeak * 1.3) continue;
      replacements.push({ start: valueIndex, end: valueIndex + match[1].length, replacement: String(tablePeak), detail: `劳动力峰值 ${value}人→${tablePeak}人（以分阶段投入明细表为准）` });
    }
  };
  collect(PEAK_LABOR_RE);
  collect(LABOR_COUNT_RE);
  // 与检测器模式 6 同源：总量控制上限低于表格峰值即不自洽 → 上限改为表格峰值
  for (const match of markdown.matchAll(/(?:高峰期|高峰|峰值)[^。；;\n]{0,16}?控制(?:在|为|到)?(?:约)?\s*([\d,]+)\s*人(?:以内|以下|之内)?/gu)) {
    const value = Number(match[1].replace(/[,，]/gu, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value >= tablePeak) continue;
    const valueIndex = match.index + match[0].indexOf(match[1]);
    replacements.push({ start: valueIndex, end: valueIndex + match[1].length, replacement: String(tablePeak), detail: `劳动力控制上限 ${value}人→${tablePeak}人（与分阶段投入明细表峰值自洽）` });
  }
  return applySpanReplacements(markdown, replacements);
}

/** 节点工期确定性修复：总进度计划表内日期为权威口径，全文其他位置同节点日期相差 ≥5 天 → 改为权威值。
 * 与检测器 nodeScheduleConsistencyIssues 同源同阈值（≥5 天才互斥）；找不到总进度计划表标题时不动。 */
function fixNodeScheduleConflicts(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  const tableRowLineRe = /^\|.+\|$/u;
  // 行字符 span（替换定位用）
  const lineSpans: Array<{ start: number; end: number }> = [];
  let lineOffset = 0;
  for (const line of lines) {
    lineSpans.push({ start: lineOffset, end: lineOffset + line.length });
    lineOffset += line.length + 1;
  }
  // 1. 定位总进度计划表（表格块上方 6 行内含「总进度计划」标题），提取块内节点日期为权威口径
  const authorityByKey = new Map<string, number>();
  const authoritySpans: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!tableRowLineRe.test(lines[index].trim())) continue;
    const blockStart = index;
    while (index < lines.length && tableRowLineRe.test(lines[index].trim())) index += 1;
    const blockEnd = index;
    const headerProbe = lines.slice(Math.max(0, blockStart - 6), blockStart).join('\n');
    if (!/总进度计划|施工总进度|总进度安排/u.test(headerProbe)) continue;
    const blockText = lines.slice(blockStart, blockEnd).join('\n');
    for (const sample of extractNodeScheduleDays(blockText)) {
      // 权威表内同节点多样本取最大日（防块内噪音样本压低权威口径）
      const existing = authorityByKey.get(sample.key);
      if (existing === undefined || sample.day > existing) authorityByKey.set(sample.key, sample.day);
    }
    authoritySpans.push({ start: lineSpans[blockStart].start, end: lineSpans[blockEnd - 1].end });
  }
  if (authorityByKey.size === 0) return { markdown, fixedCount: 0, details: [] };
  // 2. 与 extractNodeScheduleDays 同源的三个形态正则（带 index 定位），非权威表内的矛盾样本定点替换
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  const keyOf = (text: string) => SCHEDULE_NODE_ANCHORS.find(anchor => anchor.re.test(text))?.key;
  const outsideAuthority = (position: number) => !authoritySpans.some(span => position >= span.start && position <= span.end);
  const pushReplacement = (nodeText: string, day: number, dayStart: number, dayEnd: number, raw: string) => {
    const key = keyOf(nodeText);
    if (key === undefined || !Number.isFinite(day) || day < 1 || day > 3000) return;
    const authority = authorityByKey.get(key);
    if (authority === undefined) return;
    if (Math.abs(day - authority) < 5) return;
    if (!outsideAuthority(dayStart)) return;
    replacements.push({ start: dayStart, end: dayEnd, replacement: String(authority), detail: `节点“${SCHEDULE_NODE_ANCHORS.find(anchor => anchor.key === key)?.label || key}”工期 ${day}日→${authority}日（以总进度计划表为准）` });
  };
  for (const match of markdown.matchAll(/第(\d{2,3})日[^。；;\n]{0,14}?完成[^。；;\n]{0,12}?(基坑支护及土方外运|装饰装修及幕墙|机电安装及智能化调试|室外工程及竣工验收|地下结构出正负零|主体结构封顶|正负零|封顶)/gu)) {
    const dayStart = match.index + match[0].indexOf(match[1]);
    pushReplacement(match[2], Number(match[1]), dayStart, dayStart + match[1].length, match[0].slice(0, 40));
  }
  for (const match of markdown.matchAll(/(基坑支护|正负零|封顶|装饰装修|机电安装|竣工验收)(?:(?!(?:第\d{2,3}[日天]|，|、)).){0,8}?完成[^。；;\n]{0,10}?第(\d{2,3})[日天]/gu)) {
    const dayStart = match.index + match[0].indexOf(match[2]);
    pushReplacement(match[1], Number(match[2]), dayStart, dayStart + match[2].length, match[0].slice(0, 40));
  }
  for (const match of markdown.matchAll(/(主体(?:结构)?封顶)(?:(?!(?:第\d{2,3}[日天]|，|、|完成)).){0,20}?第(\d{2,3})日/gu)) {
    const dayStart = match.index + match[0].indexOf(match[2]);
    pushReplacement(match[1], Number(match[2]), dayStart, dayStart + match[2].length, match[0].slice(0, 40));
  }
  return applySpanReplacements(markdown, replacements);
}

/** 材料/设备数量确定性修复：表格行数值为权威口径，正文矛盾数值（差异 >20%）改为表格值。
 * 与检测器 crossSectionNumericConflictIssues 同源（同锚点/同豁免：并列枚举、否定声明句）；
 * 表格口径不唯一（多表互相矛盾）时不动，交 LLM 修复路径。 */
function fixCrossSectionNumericConflicts(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  for (const anchor of CROSS_SECTION_ANCHORS) {
    if (anchor.kind !== 'number') continue;
    const tableValues = new Set<number>();
    const bodyValues = new Set<number>();
    for (const pattern of anchor.patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const raw = match[0].slice(0, 40);
        if (ENUMERATION_VALUE_RE.test(raw)) continue;
        const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
        let lineEnd = markdown.indexOf('\n', match.index);
        if (lineEnd === -1) lineEnd = markdown.length;
        const line = markdown.slice(lineStart, lineEnd);
        if (NEGATIVE_DECLARATION_RE.test(line)) continue;
        const value = Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (/^\s*\|/u.test(line)) tableValues.add(value);
        else bodyValues.add(value);
      }
    }
    // 表格口径唯一才作为权威；正文存在与权威差异 >20% 的值才修复（与检测器同阈值）
    if (tableValues.size !== 1) continue;
    const authority = [...tableValues][0];
    if (![...bodyValues].some(value => Math.abs(value - authority) > authority * 0.2)) continue;
    for (const pattern of anchor.patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const raw = match[0].slice(0, 40);
        if (ENUMERATION_VALUE_RE.test(raw)) continue;
        const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
        let lineEnd = markdown.indexOf('\n', match.index);
        if (lineEnd === -1) lineEnd = markdown.length;
        const line = markdown.slice(lineStart, lineEnd);
        if (NEGATIVE_DECLARATION_RE.test(line)) continue;
        if (/^\s*\|/u.test(line)) continue;
        const value = Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) continue;
        if (Math.abs(value - authority) <= authority * 0.2) continue;
        const valueIndex = match.index + match[0].indexOf(match[1]);
        replacements.push({ start: valueIndex, end: valueIndex + match[1].length, replacement: String(authority), detail: `${anchor.label} ${value}${anchor.unit}→${authority}${anchor.unit}（以表格口径为准）` });
      }
    }
  }
  return applySpanReplacements(markdown, replacements);
}

/** A2 总入口：跨章数值矛盾确定性修复（劳动力峰值 → 节点工期 → 材料/设备数量，顺序执行互不重叠） */
export function applyNumericConsistencyDeterministicFixes(markdown: string): NumericConsistencyFixResult {
  let next = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  for (const step of [fixLaborPeakConflicts, fixNodeScheduleConflicts, fixCrossSectionNumericConflicts]) {
    const result = step(next);
    if (result.markdown !== next) {
      next = result.markdown;
      fixedCount += result.fixedCount;
      details.push(...result.details);
    }
  }
  return { markdown: next, fixedCount, details: details.slice(0, 12) };
}

// ── 22. 跨章语义重复（1.5 双补盲之语义级）：措辞不同但内容同质的跨章段落 ──
// 各章独立并发成稿 + 共享同批章级证据，不同章产出语义雷同段落（实锤：同工艺参数段在多章换措辞复现）。
// 逐字整段重复已由 duplicateParagraphIssues（≥40 字归一化相等）兜住，本检测只抓"非逐字但语义雷同"形态：
// 段落级（去空白 ≥60 字）跨章 bge 两两余弦 ≥0.82 命中；归一化相等的对跳过（避免与整段重复双报双删）。
// env DOCUMENT_CROSS_CHAPTER_DEDUP=0 整体回退（检测与 strip 同源同开关）。

const CROSS_CHAPTER_SEMANTIC_DUP_MIN_CHARS = 60;
const CROSS_CHAPTER_SEMANTIC_DUP_THRESHOLD = 0.82;

interface CrossChapterSemanticDupPair {
  /** 保留方（信息密度高者；同密度取章序靠前者） */
  keep: { chapterIndex: number; paragraphIndex: number };
  /** 删除方 */
  drop: { chapterIndex: number; paragraphIndex: number };
  similarity: number;
  paragraphPreview: string;
}

/** 段落信息密度：数值/字母/工程符号占比（密度高者承载更多事实参数，删除时保留） */
function paragraphInfoDensity(text: string): number {
  const compact = text.replace(/\s+/gu, '');
  if (!compact.length) return 0;
  const dense = (compact.match(/[0-9A-Za-z%℃°±×÷≥≤.]/gu) || []).length;
  return dense / compact.length;
}

/** 章正文段落提取：空行分块，标题行/表格行/列表行所在块不入池（结构与 duplicateParagraphIssues 同口径） */
function crossChapterDupParagraphs(chapters: DocumentDraftChapter[]) {
  const pool: Array<{ chapterIndex: number; paragraphIndex: number; text: string; normalized: string }> = [];
  chapters.forEach((chapter, chapterIndex) => {
    const blocks = (chapter.content || '').split(/\n\s*\n/u);
    blocks.forEach((block, paragraphIndex) => {
      const text = block.trim();
      if (!text) return;
      if (/^#{1,6}\s/um.test(text) || /^\s*\|/um.test(text) || /^[-*•]\s/um.test(text)) return;
      const normalized = text.replace(/\s+/gu, '');
      if (normalized.length < CROSS_CHAPTER_SEMANTIC_DUP_MIN_CHARS) return;
      pool.push({ chapterIndex, paragraphIndex, text, normalized });
    });
  });
  return pool;
}

/** 跨章语义重复对检出（检测与 strip 共用同源核心）：bge 全量段落两两比对，逐字相等对排除 */
async function findCrossChapterSemanticDupPairs(chapters: DocumentDraftChapter[]): Promise<CrossChapterSemanticDupPair[]> {
  if (process.env.DOCUMENT_CROSS_CHAPTER_DEDUP === '0') return [];
  const pool = crossChapterDupParagraphs(chapters);
  if (pool.length < 2) return [];
  const similarity = await buildSemanticSimilarity(pool.map(item => item.normalized), pool.map(item => item.normalized));
  const pairs: CrossChapterSemanticDupPair[] = [];
  const droppedKeys = new Set<string>();
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const left = pool[i];
      const right = pool[j];
      // 只跨章判定（章内语义重复由章级清洗与 LLM 评审治理）；逐字相等属整段重复通道，不双报
      if (left.chapterIndex === right.chapterIndex || left.normalized === right.normalized) continue;
      const score = similarity(left.normalized, right.normalized);
      if (score < CROSS_CHAPTER_SEMANTIC_DUP_THRESHOLD) continue;
      // 保留信息密度高者；同密度保留章序靠前者（先成稿章优先）
      const leftDensity = paragraphInfoDensity(left.text);
      const rightDensity = paragraphInfoDensity(right.text);
      const keepLeft = leftDensity > rightDensity || (leftDensity === rightDensity && left.chapterIndex <= right.chapterIndex);
      const keep = keepLeft ? left : right;
      const drop = keepLeft ? right : left;
      const dropKey = `${drop.chapterIndex}:${drop.paragraphIndex}`;
      if (droppedKeys.has(dropKey)) continue;
      droppedKeys.add(dropKey);
      pairs.push({
        keep: { chapterIndex: keep.chapterIndex, paragraphIndex: keep.paragraphIndex },
        drop: { chapterIndex: drop.chapterIndex, paragraphIndex: drop.paragraphIndex },
        similarity: score,
        paragraphPreview: drop.normalized.slice(0, 40),
      });
    }
  }
  return pairs;
}

/** 跨章语义重复检测（命中即报，进全局一致性轮修复闭环与交付校验展示） */
export async function crossChapterSemanticDuplicateIssues(chapters: DocumentDraftChapter[]): Promise<ValidationIssue[]> {
  const pairs = await findCrossChapterSemanticDupPairs(chapters);
  return pairs.map(pair => ({
    level: 'error' as const,
    severity: 'blocker' as const,
    category: 'structure' as const,
    owner: 'llm' as const,
    repairability: 'llm_repairable' as const,
    chapterId: chapters[pair.drop.chapterIndex]?.id,
    message: `跨章语义重复：「${chapters[pair.keep.chapterIndex]?.title || '?'}」与「${chapters[pair.drop.chapterIndex]?.title || '?'}」存在内容高度雷同段落（相似度 ${pair.similarity.toFixed(2)}）：“${pair.paragraphPreview}…”`,
    suggestion: '同一内容全文只保留一处（保留信息密度高者）；删除或改写本章的雷同段落，与本章主题相关的独有信息归并后，不得与他章段落语义重复。',
  }));
}

/** 跨章语义重复确定性 strip：保留信息密度高者所在段落，删除低密度方整段（原地改 chapters，返回删除段数） */
export async function stripCrossChapterSemanticDuplicateParagraphs(chapters: DocumentDraftChapter[]): Promise<number> {
  const pairs = await findCrossChapterSemanticDupPairs(chapters);
  if (pairs.length === 0) return 0;
  let removed = 0;
  for (const pair of pairs) {
    const chapter = chapters[pair.drop.chapterIndex];
    if (!chapter) continue;
    const blocks = (chapter.content || '').split(/\n\s*\n/u);
    // 段落索引与提取时同口径（空行分块）；目标块删除（整块语义重复，非删句）
    if (pair.drop.paragraphIndex >= blocks.length) continue;
    const target = blocks[pair.drop.paragraphIndex].trim().replace(/\s+/gu, '');
    if (target.length < CROSS_CHAPTER_SEMANTIC_DUP_MIN_CHARS) continue;
    blocks.splice(pair.drop.paragraphIndex, 1);
    chapter.content = blocks.join('\n\n');
    removed += 1;
  }
  return removed;
}

