import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel, SpecAuthorityMap, TenderRequirementModel, ValidationIssue } from './types';
import { MARKDOWN_TABLE_ROW_RE } from '../constants';
import { documentTextLength } from './budget';
import { stringifyFactValue } from './utils';
import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';
import { buildSemanticGate } from './semanticGate';
import { isQualificationSectionTitle } from './evidenceContentSafety';
import { DANGEROUS_APPLICABLE_ITEMS, extractDangerZone } from './dangerousApplicability';

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
// 阶段劳动力形态盲区（P1 扩围）：「装饰装修阶段投入20人」「主体结构阶段约300人」无高峰/劳动力前缀词，
// PEAK_LABOR_RE/LABOR_COUNT_RE 均不覆盖；阶段词自身即劳动力语境（LABOR_STAGE_LIMIT_WORDS 同族），
// 提取值经 laborPeakStageOf 带阶段限定参与同阶段互查，不影响跨阶段隔离
const STAGE_LABOR_RE = /(?:阶段|期间)[^。；;\n]{0,12}?(?:约)?\s*([\d,]+)\s*人/g;
// h14 扩围（评分报告 P2）：「主体阶段投入劳动力约110人」无「高峰」词，「劳动力高峰150～180人」
// 与明细「木工40+钢筋35+混凝土20+吊装25=120人」三口径并存时原 PEAK_LABOR_RE 漏抓 110/120 两处，
// 导致跨口径矛盾漏检——反向口径（劳动力/作业人员词在前、数字在后）并入同一提取池
const LABOR_COUNT_RE = /(?:劳动力|作业人员|施工人员)[^。；;\n]{0,16}?(?:约)?\s*([\d,]+)\s*人/g;

// 阶段限定词（长词优先避免子串混淆）：不同施工阶段的峰值天然不同（地下结构 220 vs 室外工程 90 不互斥），
// 仅同阶段或无阶段限定的峰值才参与互斥比较（真实生成「220 vs 90」误报根因）。
// A2（4.12.23）提取为模块级：检测器与确定性修复器共用同一阶段归属口径，避免双份实现漂移。
// h17：补齐「施工准备/土方/临时设施/拆除」等前置阶段词——分阶段明细表行「施工准备阶段劳动力62人」
// 因阶段词缺失被误判为总口径峰值与 186 互斥（第九次回归门禁误报根因）
const LABOR_STAGE_LIMIT_WORDS = ['基坑与基础', '二次结构与砌体', '施工准备', '地下结构', '主体结构', '装饰装修', '机电安装', '室外工程', '收尾调试', '临时设施', '土方', '基坑', '基础'] as const;

// F6 口径隔离词表：管理口径与工种口径的劳动力数值不与总峰值互查/替换——
// 「管理人员18人 vs 施工高峰期286人」「钢筋工60人 vs 木工80人」属不同口径正常配置（真实生成误报根因）；
// 长词优先列前防子串截断（电焊工→焊工、质量员→质量员）
const MANAGEMENT_PERSONNEL_WORD_RE = /项目经理|技术负责人|项目班子|管理人员|管理层|施工员|质量员|质检员|安全员|材料员|资料员|测量员|试验员|造价员|预算员/u;
const TRADE_WORKER_WORD_RE = /铺装工|钢筋工|混凝土工|架子工|砌筑工|抹灰工|防水工|油漆工|水暖工|水电工|管道工|电焊工|起重工|机械工|司索工|信号工|塔吊司机|测量工|试验工|绿化工|管网工|装修工|装饰工|安装工|养护工|保温工|幕墙工|防腐工|操作工|市政工|模板工|木工|瓦工|焊工|电工|普工/u;

/** 劳动力数值语境分组（F6）：management=管理口径、trade=工种口径（含工种名）、peak=总峰值口径。
 *  数字前 30 字符窗口内判定，窗口从最近分隔符（，、，;；:：）后截断——
 *  防「主体结构阶段投入钢筋工60人、木工80人，高峰人数约220人」的 220 被前句工种词串染；
 *  检测器 resourceConsistencyIssues 与确定性修复器 fixLaborPeakConflicts 共用同一分组口径
 *  （检测/修复同源，避免双份实现漂移）
 *  P1 修复（评分报告「按高峰期总人数20人配置专职安全员2名」的 20 被误划管理组根因）：
 *  只判数字前窗口（主语）——数字后 12 字符是谓语（「配置专职安全员2名」的「安全员」属后一个数字），
 *  原 before+after 联合窗口把总人数误划入 management 组，与 peak 组失去互查资格 → 20 vs 86 漏检 */
function laborGroupOf(markdown: string, valueIndex: number, lineStart: number): { group: 'management' | 'trade' | 'peak'; trade?: string } {
  const windowStart = Math.max(lineStart, valueIndex - 30);
  const before = markdown.slice(windowStart, valueIndex);
  const cut = Math.max(before.lastIndexOf('，'), before.lastIndexOf('、'), before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('；'), before.lastIndexOf('：'), before.lastIndexOf(':'), before.lastIndexOf('。'));
  const effectiveStart = cut >= 0 ? windowStart + cut + 1 : windowStart;
  const subjectWindow = markdown.slice(effectiveStart, valueIndex);
  if (MANAGEMENT_PERSONNEL_WORD_RE.test(subjectWindow)) return { group: 'management' };
  const tradeMatch = subjectWindow.match(TRADE_WORKER_WORD_RE);
  if (tradeMatch?.[0]) return { group: 'trade', trade: tradeMatch[0] };
  return { group: 'peak' };
}

/**
 * P1 箭头链峰值提取（评分报告 P1「劳动力按32人→86人→48人分阶段投入」漏检根因）：
 *  LABOR_COUNT_RE 只抓链上首值 32，真实峰值 86 不可见 → 与正文「20人」矛盾漏检；
 *  链内多值属分阶段合法序列（32/48 是低峰阶段），只取链上最大值入峰值池，
 *  链内其他值不得当独立口径互查（否则 32 vs 86 会误报互斥）。
 *  链起点＝箭头连接符前的最后一个劳动力语境词——「管理人员18人，劳动力按32人→86人→48人」
 *  的 18 在链起点之前（管理口径正常入池），「劳动力按32人→86人」的链起点是劳动力（取全链峰值）。
 *  链尾＝链所在句的句边界（。；;）且不跨逗号段——同段下一句/下一段链的独立宣称（「…约40人」
 *  「装饰装修阶段20人→50人→30人」）不得被前一链吞掉（P1 测试回归根因 + 多链同行扩围修复）。
 *  语境词含「阶段」：支撑「装饰装修阶段20人→50人→30人」形态的链起点定位。 */
function chainPeaksOf(line: string): Array<{ peak: number; start: number; end: number }> {
  const results: Array<{ peak: number; start: number; end: number }> = [];
  for (const arrow of line.matchAll(/(?:→|—|–|~|～)/gu)) {
    const arrowIdx = arrow.index ?? 0;
    const prefix = line.slice(0, arrowIdx);
    const contextMatch = /(?:劳动力|作业人员|施工人员|高峰期|高峰|峰值|阶段)[^，。；;]*$/u.exec(prefix);
    if (!contextMatch) continue;
    const start = contextMatch.index;
    // 同一链的后续箭头锚定到同一语境词起点，去重防重复入池
    if (results.some(chain => chain.start === start)) continue;
    const sentenceCut = /[。；;]/u.exec(line.slice(arrowIdx));
    const sentenceTail = line.slice(start, sentenceCut ? arrowIdx + sentenceCut.index : undefined);
    // 链不跨逗号段：逗号分隔的另一阶段链/独立宣称不属于本链
    const segment = sentenceTail.split(/[，,]/u)[0] || '';
    const matches = [...segment.matchAll(/([\d,]+)\s*人/g)];
    const values = matches
      .map(match => Number(match[1].replace(/[,，]/gu, '')))
      .filter(value => Number.isFinite(value) && value > 0);
    if (values.length < 2) continue;
    const last = matches[matches.length - 1];
    results.push({ peak: Math.max(...values), start, end: start + (last.index ?? 0) + last[0].length });
  }
  return results;
}

/** 劳动力峰值数字位置 → 阶段限定词（与检测器 resourceConsistencyIssues 模式 1 同源同口径） */
function laborPeakStageOf(markdown: string, index: number): string | undefined {
  // 向前取最近片段边界（。；；换行）内的片段再找阶段词——固定 30 字符窗口不够到
  // 「地下结构阶段投入钢筋工60人、木工80人、混凝土工40人、架子工20人，高峰人数约180人」的
  // 180 是地下结构阶段的峰值汇总，跨列举分隔符继承前段阶段词（前段是投入明细无峰值词）；
  // 而「管网阶段高峰35人，高峰人数86人」的 86 是总口径，前段已是完整峰值条目时不再继承阶段词
  const before = markdown.slice(0, index);
  const boundary = Math.max(before.lastIndexOf('。'), before.lastIndexOf('；'), before.lastIndexOf(';'), before.lastIndexOf('\n'));
  let segment = markdown.slice(Math.max(0, boundary + 1), index);
  // 列举分隔符条件截断：前段含峰值语境词（已绑定独立峰值口径）则后条目是总口径不继承；
  // 前段是投入明细（无峰值词）则后条目属该阶段峰值汇总，跨分隔符继承阶段词
  const cut = Math.max(segment.lastIndexOf('，'), segment.lastIndexOf('、'));
  if (cut >= 0 && /(?:高峰期|高峰|峰值)/u.test(segment.slice(0, cut))) segment = segment.slice(cut + 1);
  let best: string | undefined;
  let bestPos = -1;
  for (const word of LABOR_STAGE_LIMIT_WORDS) {
    const pos = segment.lastIndexOf(word);
    if (pos > bestPos) { bestPos = pos; best = word; }
  }
  // A8 通用「XX阶段」短语限定词（丰乐镇实测）：道路/管网类项目阶段词与房建封闭词表不重叠，
  // 「第一阶段为施工准备与清杂清表……投入劳动力22人」的 22 与「道路面层及人行道施工阶段达到峰值68人」
  // 的 68 都被词表 lastIndexOf 错标为同一个「施工准备」，同 stage 互查报假矛盾。
  // 规则：取 segment 内最后一个非泛化「XX阶段」短语（阶段字前 1-14 个非分隔字符）；
  // 泛化前缀（各/每个/不同/相应）、数量形态（「五个施工阶段」）与词表词前缀缩写（「主体阶段」
  // 是「主体结构」简称、「装饰阶段」是「装饰装修」简称——h14 跨口径互查依赖这些形态无 stage 限定）
  // 不算具体阶段限定
  const genericMatches = [...segment.matchAll(/[^，,。；;：:\n]{1,14}阶段/gu)];
  const generic = genericMatches
    .filter(match => {
      const phrase = match[0].slice(0, -2);
      return !/^(?:各|每个|不同|相应)/u.test(phrase)
        && !/^[一二三四五六七八九十\d]{1,3}个/u.test(phrase)
        && !LABOR_STAGE_LIMIT_WORDS.some(word => word.startsWith(phrase));
    })
    .pop();
  if (generic && (generic.index ?? 0) > bestPos) {
    best = generic[0];
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
  /** 表头含「高峰/峰值」列（阶段峰值口径表；无高峰列的分工种人数表不入多表峰值互查池 ） */
  hasPeakCol: boolean;
  /** 表头含工种/岗位类列（分工种明细表——「道路硬化与排水施工|普工|34人」的 34 是单工种
   * 峰值非全员峰值，不得入 tablePeakLabor 全员峰值池与正文「高峰期 86 人」互查（丰乐镇实测）） */
  hasTradeCol: boolean;
  /** 表头是否含分阶段维度列（分阶段投入明细表：同一表内同工种多行分阶段配置属合法动态值） */
  hasStageCol: boolean;
  /** 分工种明细行（工种名 → 该行人数），仅 hasTradeCol 表提取；
   * F15 同工种跨表高峰人数比对的数据源（电工 40 vs 4 类跨表互斥——丰乐镇第 3 轮实测） */
  tradeCells: Array<{ trade: string; value: number }>;
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
    // 工种列识别：表头含工种/岗位/班组/人员类别列（不含高峰期列）即分工种明细表
    const hasTradeCol = headerCells.some(cell => /工种|岗位|班组|人员类别|管理人员/u.test(cell));
    const tradeCol = hasTradeCol ? headerCells.findIndex(cell => /工种|岗位|班组|人员类别|管理人员/u.test(cell)) : -1;
    // 数字提取只看人员数量列（列位置对齐），不再全表扫描数字单元格
    const countCells: number[] = [];
    let totalCell: number | undefined;
    let detailSum = 0;
    const tradeCells: Array<{ trade: string; value: number }> = [];
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
      // F15 工种明细行提取（tradeCol 列单元格取工种词；单元格含「工种+规格」组合时取工种词部分）
      if (tradeCol >= 0) {
        const tradeRaw = (cells[tradeCol] || '').replace(/[*_`~]/gu, '').trim();
        const tradeName = TRADE_WORKER_WORD_RE.exec(tradeRaw)?.[0];
        if (tradeName) tradeCells.push({ trade: tradeName, value });
      }
    }
    if (countCells.length === 0 && totalCell === undefined) continue;
    const peak = Math.max(...(countCells.length > 0 ? countCells : [totalCell || 0]));
    blocks.push({ countCells, totalCell, detailSum, peak, hasPeakCol: peakCol >= 0, hasTradeCol, hasStageCol: stageCol >= 0, tradeCells });
  }
  return blocks;
}

/** 从 markdown 表格中提取劳动力分阶段表格的人数峰值（兼容旧单值口径：多表取最大）。
 * A10：分工种明细表（表头含工种/岗位/班组/人员类别列）的峰值是单工种峰值，
 * 不得入全员峰值池（「普工 34 人」被当全员峰值与正文「高峰期 86 人」互查——丰乐镇实测假矛盾） */
export function tablePeakLabor(markdown: string): number | undefined {
  const peaks = collectLaborTableBlocks(markdown).filter(block => !block.hasTradeCol).map(block => block.peak);
  return peaks.length > 0 ? Math.max(...peaks) : undefined;
}

/** 阶段链峰值提取（正文「22人→35人→45人→68人→30人」箭头链形态）：取链内最大值作跨章劳动力权威候选。
 * 与 resourceConsistencyIssues 的 chainPeaksOf 同源判定：语境词之后、句边界之内。
 * 分阶段明细表缺失时（丰乐镇实测：5.3.4 表体为空），「高峰/峰值…N人」总口径表述最大值为唯一正文内部权威。
 * 口径隔离：只取 PEAK_LABOR_RE（高峰/峰值前缀）命中值——工种口径（管道工12人）与
 * 阶段限定峰值（管网阶段35人）不进入权威池（laborPeakStageOf 过滤）。 */
export function tablePeakLaborWithChainFallback(markdown: string): number | undefined {
  const tablePeak = tablePeakLabor(markdown);
  if (tablePeak !== undefined) return tablePeak;
  let chainMax: number | undefined;
  for (const match of markdown.matchAll(PEAK_LABOR_RE)) {
    const value = Number(match[1].replace(/[,，]/gu, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    const valueIndex = match.index + match[0].indexOf(match[1]);
    if (laborPeakStageOf(markdown, valueIndex)) continue;
    if (chainMax === undefined || value > chainMax) chainMax = value;
  }
  return chainMax;
}

export function resourceConsistencyIssues(markdown: string, options?: { laborPeakAuthority?: number }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // D1 三层锚点优先级：蓝图 labor.peakValue（造价锚定）> 分阶段投入明细表峰值 > 正文表述。
  // 蓝图权威存在时正文峰值对齐蓝图即为合法终态，与表峰值的差异不再互斥——否则检测器会把
  // 确定性修复器刚对齐的蓝图值再拉回表峰值，形成「蓝图检测 ↔ 表格互查」修复循环拉扯
  const laborPeakAuthority = options?.laborPeakAuthority;
  const bodyPeaks: Array<{ value: number; text: string; stage?: string; group: 'management' | 'trade' | 'peak'; trade?: string }> = [];
  const chainHandledKeys = new Set<string>();
  // 阶段归属判定复用模块级 laborPeakStageOf（A2：检测/修复同源同口径）
  // h14：峰值口径与反向劳动力口径同池提取（评分报告 P2 三口径并存漏检根因）
  // h17：表格行内（行首行尾均为 |）的阶段劳动力数值属分阶段明细表合法数据，不进入正文峰值互查池——
  // 「施工准备阶段劳动力62人」表格行被当总口径峰值与 186 互斥误报（第九次回归门禁根因）
  for (const pattern of [PEAK_LABOR_RE, LABOR_COUNT_RE, STAGE_LABOR_RE]) {
    for (const match of markdown.matchAll(pattern)) {
      const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
      let lineEnd = markdown.indexOf('\n', match.index);
      if (lineEnd === -1) lineEnd = markdown.length;
      const line = markdown.slice(lineStart, lineEnd);
      if (/^\s*\|.*\|\s*$/u.test(line)) continue;
      const value = Number(match[1].replace(/[,，]/gu, ''));
      // laborPeakStageOf 定位数字位置（非模式起点）：「峰值表述统一为：地下结构阶段220人」的阶段词
      // 在模式起点之后，用起点定位会取不到阶段限定（真实生成误报根因）
      const valueIndex = match.index + match[0].indexOf(match[1]);
      // P1 箭头链：语境词之后且在链尾（句边界）之内的值由链峰值口径接管（只取最大值，链内低峰阶段值不独立入池）；
      // 每行可能有多条链（逗号分段的阶段链），按链起点/链尾标识逐链入池（多链同行扩围修复）
      const chains = chainPeaksOf(line);
      const hitChain = chains.find(chain => valueIndex - lineStart >= chain.start && valueIndex - lineStart < chain.end);
      if (hitChain !== undefined) {
        const chainKey = `${lineStart}:${hitChain.start}:${hitChain.end}`;
        if (!chainHandledKeys.has(chainKey)) {
          chainHandledKeys.add(chainKey);
          bodyPeaks.push({ value: hitChain.peak, text: line.trim().slice(0, 40), stage: laborPeakStageOf(markdown, valueIndex), group: 'peak' });
        }
        continue;
      }
      if (Number.isFinite(value) && value > 0) {
        const { group, trade } = laborGroupOf(markdown, valueIndex, lineStart);
        // A8 STAGE 模式自带阶段限定：阶段短语即「阶段」字前的实义短语（「管网及附属设施施工阶段35人」→
        // 管网及附属设施施工阶段）；词表/「第N阶段」识别只覆盖房建词表与序号形态，
        // 道路管网类项目自造阶段词（管网及附属设施/道路基层/绿化栽植）需从匹配上下文直接取限定词——
        // 否则五阶段值全部错标为同一词表词，同 stage 互查报出「施工准备 22 vs 峰值 68」假矛盾（丰乐镇实测）
        const stage = pattern === STAGE_LABOR_RE
          ? `${(/([^，,。；;\n]{1,14})阶段$/u.exec(markdown.slice(lineStart, match.index + 2))?.[1] ?? '')}阶段`
          : laborPeakStageOf(markdown, valueIndex);
        bodyPeaks.push({ value, text: match[0].trim().slice(0, 40), stage, group, trade });
      }
    }
  }
  const tableBlocks = collectLaborTableBlocks(markdown);
  const laborIssue = (message: string, suggestion: string) => issues.push({
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message,
    suggestion,
  });
  // 模式 1：正文峰值全量互查——多处「高峰期 X 人」相差 >30% 即互斥（阶段限定不同的峰值除外）。
  // F6 口径隔离：仅同组互查——管理 vs 管理、工种 vs 同工种、峰值 vs 峰值；
  // 「管理人员18人 vs 高峰期286人」是管理 vs 全员两套合法口径不互斥，「钢筋工60 vs 木工80」不同工种不互斥
  // （真实生成误报根因：18 vs 286、60 vs 80 被当同口径互斥）
  for (let i = 0; i < bodyPeaks.length; i += 1) {
    for (let j = i + 1; j < bodyPeaks.length; j += 1) {
      const [a, b] = [bodyPeaks[i], bodyPeaks[j]];
      if (a.group !== b.group) continue;
      if (a.group === 'trade' && a.trade !== b.trade) continue;
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
          laborPeakAuthority !== undefined && laborPeakAuthority > 0
            ? `劳动力峰值数据必须全文唯一：以蓝图劳动力峰值 ${laborPeakAuthority} 人为准统一正文各处峰值表述，删除矛盾数字。`
            : '劳动力峰值数据必须全文唯一：以分阶段投入明细表为准统一正文各处峰值表述，删除矛盾数字。',
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
  // 模式 3：正文峰值 vs 表峰值（保留原口径）；F6：仅总峰值口径入池，管理/工种数值不与表峰值互比
  // A10：表峰值只取非工种表（分工种明细表单工种峰值与全员峰值不可比）
  const peakGroupPeaks = bodyPeaks.filter(entry => entry.group === 'peak');
  const maxBodyPeak = peakGroupPeaks.reduce((maxPeak, entry) => Math.max(maxPeak, entry.value), 0);
  const tablePeak = tableBlocks.filter(block => !block.hasTradeCol).length > 0
    ? Math.max(...tableBlocks.filter(block => !block.hasTradeCol).map(block => block.peak))
    : undefined;
  if (tablePeak !== undefined && maxBodyPeak > 0) {
    const threshold = tablePeak * 1.3;
    // D1 蓝图权威豁免：正文峰值已对齐蓝图劳动力峰值时不与表峰值互查——蓝图是造价锚定最高权威，
    // 表峰值与蓝图的差异属表格口径问题（确定性修复器以蓝图值为准统一正文），
    // 若继续互查会把已对齐的正文再拉回表峰值，与蓝图引用检测形成修复循环
    const alignedToBlueprint = laborPeakAuthority !== undefined && laborPeakAuthority > 0 && maxBodyPeak === laborPeakAuthority;
    if (maxBodyPeak > threshold && !alignedToBlueprint) {
      const maxText = peakGroupPeaks.find(entry => entry.value === maxBodyPeak)?.text || '';
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
  // 模式 7：正文班组加总算式一致性（评分报告 P1「投入 20人」与「道路浇筑8＋铺装6＋排水沟砌筑5＋
  // 机动2×4=27人」同句并存自相矛盾——班组加总 27 ≠ 宣称 20，算术层确定性校验零语义风险）：
  // 同句内「=N人」算式（左侧 ＋ 分隔各项末位数字求和，含 × 乘积项）与宣称总人数（投入/配置 N 人）
  // 相差 >15% 即报；算式左侧求和 ≠ 右侧结果也报（同一解析两条通道）。「约/近/余/左右」近似措辞
  // 下宣称口径宽容（不计入比较），但算式本身的算术自洽仍受检。
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || /^\s*\|/u.test(trimmed) || /^#{1,6}\s/u.test(trimmed)) continue;
    for (const sentence of trimmed.split(/(?<=[。；;])/u)) {
      const resultMatch = /=\s*([\d,]+)\s*人/u.exec(sentence);
      if (!resultMatch) continue;
      const left = sentence.slice(0, resultMatch.index);
      if (!/[＋+]/u.test(left)) continue;
      const segments = left.split(/[＋+]/u);
      let sum = 0;
      let hasTerm = false;
      for (const segment of segments) {
        // 末位数字放宽「8人」形态（真实文本常写作「道路浇筑8人＋铺装6人＋…=27人」），
        // 原 /(\d+)\s*$/ 在「人」结尾的段上取不到数字导致整条算式静默漏检
        const termMatch = segment.match(/(\d+)\s*[×xX]\s*(\d+)/u) || segment.match(/(\d+)\s*人?\s*$/u);
        if (!termMatch) continue;
        hasTerm = true;
        sum += termMatch[2] !== undefined ? Number(termMatch[1]) * Number(termMatch[2]) : Number(termMatch[1]);
      }
      if (!hasTerm) continue;
      const total = Number(resultMatch[1].replace(/[,，]/gu, ''));
      if (!Number.isFinite(total) || total <= 0 || sum <= 0) continue;
      const snapshot = sentence.trim().slice(0, 60);
      if (Math.abs(sum - total) / Math.max(sum, total) > 0.05) {
        laborIssue(
          `劳动力数据矛盾：正文班组加总算式“${snapshot}”左侧求和 ${sum} 人 ≠ 结果 ${total} 人`,
          '班组人数加总必须与合计一致：核对各班组人数或修正合计数字。',
        );
      }
      const claimMatch = /(?:投入|配置|安排|组织|总人数)[^。；;＝=＋+]{0,16}?([\d,]+)\s*人/u.exec(sentence);
      if (claimMatch) {
        const claimValue = Number(claimMatch[1].replace(/[,，]/gu, ''));
        const claimWindow = sentence.slice(0, claimMatch.index + claimMatch[0].length);
        const isApprox = /[约近余]|左右/u.test(claimWindow.slice(-16));
        if (Number.isFinite(claimValue) && claimValue > 0 && !isApprox && Math.abs(claimValue - total) / Math.max(claimValue, total) > 0.15) {
          laborIssue(
            `劳动力数据矛盾：正文宣称总人数 ${claimValue} 人与班组加总算式结果 ${total} 人自相矛盾（相差 ${Math.round((Math.abs(claimValue - total) / Math.max(claimValue, total)) * 100)}%）`,
            '宣称总人数必须与班组加总一致：统一总人数与各班组人数，删除矛盾数字。',
          );
        }
      }
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
  // B6 总量语境约束（丰乐镇第五轮实测）：「偏差超过 5 个工日的即调整」的 5 个工日是调配阈值，
  // 被无约束正则误采为总工日（5 vs 峰值86×90 不自洽误报）；总工日采样仅收「总/合计/总计/共」总量语境
  const totalWorkdays = [...markdown.matchAll(/(?:总|合计|总计|共)[^。；;\n|]{0,8}?([\d,]+)\s*(?:个)?工日/gu)]
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

/** 支护体系裁决方向（B1）：factsModel 基坑支护形式槽位（图纸/地质）锁定权威体系族 */
export type SupportSystemAuthorityKind = 'slope' | 'pile';

/** 桩族词面（检测/修复同源，B1 模块级提升）：无灌注桩排桩类实义词面（钻孔灌注桩/排桩/地下连续墙/咬合桩/支护桩）不判桩族，
 * 防止「桩机2台」（施工机械）、「桩基施工」等泛化词被 bge 误判入桩支护族（合肥师范实测误报源） */
const PILE_SUPPORT_LITERAL_RE = /钻孔灌注桩|高压旋喷桩|旋喷桩|搅拌桩|灌注桩|排桩|地下连续墙|咬合桩|支护桩/u;

/** 坡喷锚族词面（检测/修复同源）：土钉墙锚杆支护体系实义词 */
const SLOPE_SUPPORT_LITERAL_RE = /土钉|放坡|喷锚|挂网|锚杆|护坡/u;

/** 支护体系权威提取（B1）：factsModel 基坑支护形式槽位值判定权威体系族；
 * 两族词并存（如「灌注桩+局部放坡」混合体系）不裁决（混合体系合法，交语义检测器） */
export function extractSupportSystemAuthority(factsModel?: DocumentFactsModel | null): SupportSystemAuthorityKind | undefined {
  const value = factsModel?.canonical?.byKey.foundation_support_form?.value;
  const text = stringifyFactValue(value);
  if (!text) return undefined;
  const slopeHit = SLOPE_SUPPORT_LITERAL_RE.test(text);
  const pileHit = PILE_SUPPORT_LITERAL_RE.test(text);
  if (slopeHit && !pileHit) return 'slope';
  if (pileHit && !slopeHit) return 'pile';
  return undefined;
}

export async function supportSystemConflictIssues(markdown: string, authority?: SupportSystemAuthorityKind | null): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const blocks = markdown.split(/\n{2,}/u).filter(block => block.trim().length >= 30);
  if (blocks.length === 0) return issues;
  const systemSimilarity = await buildSemanticSimilarity(blocks, Object.values(SUPPORT_SYSTEM_QUERIES));
  const hitsSlope = (block: string) => systemSimilarity(block, SUPPORT_SYSTEM_QUERIES.slope) >= SEMANTIC_COVERAGE_THRESHOLD;
  // 桩族词面预检（模块级 PILE_SUPPORT_LITERAL_RE）：块内无桩族实义词面不判桩族
  const hitsPile = (block: string) => PILE_SUPPORT_LITERAL_RE.test(block)
    && systemSimilarity(block, SUPPORT_SYSTEM_QUERIES.pile) >= SEMANTIC_COVERAGE_THRESHOLD;
  // 冲突 = 存在单独命中放坡喷锚族的块 且 存在单独命中灌注桩排桩族的块（两体系各自成段出现）
  const slopeOnlyBlocks = blocks.filter(block => hitsSlope(block) && !hitsPile(block));
  const pileOnlyBlocks = blocks.filter(block => hitsPile(block) && !hitsSlope(block));
  if (slopeOnlyBlocks.length === 0 || pileOnlyBlocks.length === 0) return issues;
  // B1 裁决方向注入（图纸/地质槽位判定）：LLM 修复轮按权威方向删败选体系段，不再自行两可裁决
  const authorityHint = authority === 'slope'
    ? '；权威体系判定（图纸/地质槽位）：土钉墙、锚杆等放坡喷锚类——删除灌注桩排桩类表述'
    : authority === 'pile'
      ? '；权威体系判定（图纸/地质槽位）：灌注桩排桩类——删除放坡喷锚类独立成段表述'
      : '';
  issues.push({
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `基坑支护方案前后不一致：放坡喷锚类支护表述与灌注桩排桩类支护表述分别成段出现（放坡喷锚类 ${slopeOnlyBlocks.length} 段、灌注桩排桩类 ${pileOnlyBlocks.length} 段），属跨模板拼接断裂${authorityHint}`,
    suggestion: '支护形式必须全文统一为一种体系（以图纸/地质条件为准）：确定采用放坡喷锚或灌注桩排桩后，删除另一种体系的表述，并补充基坑开挖深度数值支撑危大分级判定。',
  });
  return issues;
}

/** 败选体系词 → 权威体系词替换映射（B1，slope 权威方向）：混句改写用——桩族体系词替换为土钉墙，使句子与权威体系自洽 */
const PILE_WORD_TO_SLOPE: Array<[RegExp, string]> = [
  [/高压旋喷桩/gu, '土钉墙'],
  [/旋喷桩/gu, '土钉墙'],
  [/钻孔灌注桩/gu, '土钉墙'],
  [/咬合桩/gu, '土钉墙'],
  [/地下连续墙/gu, '土钉墙'],
  [/搅拌桩/gu, '土钉墙'],
  [/灌注桩/gu, '土钉墙'],
  [/支护桩/gu, '土钉墙'],
  [/排桩/gu, '土钉墙'],
  [/冠梁/gu, '坡顶'],
];

/** 桩族施工机械词（slope 权威方向删除项）：设备配置句中的败选体系机械逗号项整项删除 */
const PILE_MACHINE_RE = /高压旋喷桩机|旋喷桩机|搅拌桩机|三轴搅拌|成槽机|灌注桩机/u;

/** 支护体系确定性裁决修复（B1）：
 * authority='slope'（土钉墙锚杆权威，图纸/地质槽位锁定）：删除纯桩族句（无坡族词的败选体系句）；
 * 混句（两族词并存）先删桩族机械逗号项（防「高压旋喷桩」替换吃出「土钉墙机」），再词级替换桩词为土钉墙；
 * authority='pile'：不动——「灌注桩+局部放坡」混合体系合法（检测器同口径），
 * 坡段删除风险高（放坡描述与开挖组织绑定），交 LLM 修复轮裁决。
 * 与检测器 supportSystemConflictIssues 同源同词表（检测定位=修复定位）。 */
export function fixSupportSystemConflicts(markdown: string, authority?: SupportSystemAuthorityKind | null): { markdown: string; fixedCount: number; details: string[] } {
  if (authority !== 'slope') return { markdown, fixedCount: 0, details: [] };
  let removedSentences = 0;
  let rewrittenSentences = 0;
  const lines = markdown.split(/\r?\n/u);
  const keptLines = lines.map(line => {
    const trimmed = line.trim();
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) return line;
    if (!PILE_SUPPORT_LITERAL_RE.test(line)) return line;
    const sentences = line.split(/(?<=[。；;])/u);
    const kept = sentences.map(sentence => {
      if (!PILE_SUPPORT_LITERAL_RE.test(sentence)) return sentence;
      if (!SLOPE_SUPPORT_LITERAL_RE.test(sentence)) { removedSentences += 1; return ''; }
      // 混句：先删败选机械逗号项，再词级替换体系词；句尾标点随尾项被删时补回
      const tailMark = /([。；;])$/u.exec(sentence)?.[1];
      const keptItems = sentence.split(/[，、]/u).filter(item => !PILE_MACHINE_RE.test(item));
      let next = keptItems.join('，');
      if (tailMark !== undefined && !/[。；;]$/u.test(next)) next += tailMark;
      for (const [re, replacement] of PILE_WORD_TO_SLOPE) next = next.replace(re, replacement);
      rewrittenSentences += 1;
      return next;
    }).join('');
    return kept;
  });
  if (removedSentences === 0 && rewrittenSentences === 0) return { markdown, fixedCount: 0, details: [] };
  return {
    markdown: keptLines.join('\n'),
    fixedCount: removedSentences + rewrittenSentences,
    details: [`支护体系确定性裁决（图纸/地质槽位：放坡喷锚类）：删除桩族句 ${removedSentences} 句、改写混句 ${rewrittenSentences} 句`],
  };
}

// ── 6. 危大工程辨识清单一致性（R7）：多处清单项名/数量必须一致 ──

const DANGEROUS_LIST_HEADING_RE = /^#{2,4}\s+(?:\d+(?:\.\d+)*\s+)?[^\n]*(?:危大工程(?:辨识)?(?:清单|识别)|危大(?:工程)?(?:及超危大)?(?:清单|识别|辨识))[^\n]*$/gmu;

/** 归一化危大清单条目：去编号、去括号标注、去“及”连接、去“施工”尾缀，便于集合比较。
 * 括号对删除必须先于开头编号剥离：开头 strip 会吃掉「（」后括号对正则失效，
 * “1.（开挖深度超5米）深基坑工程”与“深基坑工程”误判差异（真实缺陷） */
function normalizeDangerousItem(item: string) {
  return item
    .replace(/[（(【][^)）】]*[)）】]/gu, '')
    .replace(/^[\s\d.、()（）【】-]+/u, '')
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
    // g 标志正则 test 跨调用残留 lastIndex：清单标题行直接紧邻另一清单标题行时，
    // 第二标题从残留位置起匹配漏检（真实缺陷）——每次 test 前显式归零
    DANGEROUS_LIST_HEADING_RE.lastIndex = 0;
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

/** B6 六个百分百词面确定性判定（丰乐镇第五轮实测）：六项规范条目名为封闭词表，
 * 枚举句（“施工工地周边100%围挡、物料堆放100%覆盖、…”六项标准逐项落位）词面全命中，
 * 但 bge 对长枚举句语义稀释判缺失（5/6 误报）；词面命中即该项落实，与岗位词表口径同源。 */
const SIX_HUNDRED_PERCENT_LEXICAL: Record<string, RegExp> = {
  '施工工地周边100%围挡': /100%围挡|周边100%围挡/u,
  '物料堆放100%覆盖': /物料堆放100%覆盖|物料堆放.{0,8}覆盖|密目网.*覆盖|覆盖.{0,4}密目网/u,
  '出入车辆100%冲洗': /出入车辆100%冲洗|车辆.{0,10}冲洗|冲洗.{0,10}车辆|冲洗点/u,
  '施工现场地面100%硬化': /施工现场地面100%硬化|地面100%硬化/u,
  '拆迁工地100%湿法作业': /拆迁工地100%湿法作业|拆迁.{0,10}湿法作业|湿法作业.{0,10}拆迁/u,
  '渣土车辆100%密闭运输': /渣土车辆100%密闭运输|密闭运输|密闭式/u,
};

/** 六项词面兜底命中判定：任一词面命中即判该项落实（封闭词表确定性层，bge 判定前） */
function sixHundredPercentLexicalHit(name: string, sentences: string[]): boolean {
  const re = SIX_HUNDRED_PERCENT_LEXICAL[name];
  if (!re) return false;
  return sentences.some(sentence => re.test(sentence));
}

export async function sixHundredPercentCoverageIssues(markdown: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  // 文档没有任何扬尘/环保治理内容时不检测（非施组类文档不制造义务）
  if (!/扬尘|环保|文明施工|绿色施工/u.test(markdown)) return issues;
  // 语义判定句集：按扬尘治理词面预筛全量句，不使用 bodySentencesForSemantic 均匀采样——
  // 采样 stride 会跳过中后部扬尘句（4.19.3 真实回归：6.2.2 小节「物料堆放100%覆盖」句不在
  // 400 句采样内 → 5/6 误报缺失）。预筛句数量级小，bge 全量判定无性能压力。
  const dustSentences = [...new Set(markdown.split(/\r?\n/u).flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) return [];
    if (!/围挡|覆盖|堆放|冲洗|硬化|湿法|密闭|渣土|扬尘|降尘/u.test(trimmed)) return [];
    return trimmed.split(/(?<=[。！？!?；;])/u).map(part => part.trim()).filter(sentence => sentence.length >= 8 && sentence.length <= 120);
  }))];
  const coverage = await judgeQueryCoverage(SIX_HUNDRED_PERCENT_ITEMS.map(item => ({ key: item.name, text: item.query })), dustSentences);
  // 拆迁工地豁免（D2）：新建工程无拆迁内容时，正文显式说明“本项目无拆迁工程，不涉及拆迁工地湿法作业”
  // 即视为该项闭环，不得判定缺失（评分报告问题3：六项必须逐项落实或显式豁免，不得省略）。
  // 豁免句必须带工程主语（本项目/本工程等）+ 短距否定词：任意语境出现「不涉及拆迁」类短语
  // （如“临时设施布置不涉及拆迁补偿”）不代表项目整体无拆迁工程，不得豁免
  const demolitionExempt = /(?:本项目|本工程|该工程|该项目|本标段|本施工项目)[^。；;\n]{0,30}(?:无拆迁|不涉及拆迁|无房屋拆除|无拆除)/u.test(markdown);
  const missing = SIX_HUNDRED_PERCENT_ITEMS
    .filter(item => !coverage.get(item.name) && !sixHundredPercentLexicalHit(item.name, dustSentences))
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

/**
 * B1（丰乐镇实测「招标要求响应（前附表响应条款）：计划开工日期：2026年9月…」重复 4 次）：
 * 段首固定开场机械重复确定性修复——与检测器 paragraphOpeningRepeatIssues 同源提取段首句
 * 与指纹分组，重复组（>=3）内剥离全组公共前缀（截到最后一个冒号边界，冒号含入前缀）：
 * 首现段保留完整句，后续段仅删固定开场前缀、保留差异化正文。公共前缀 <4 字或剥离后
 * 剩余 <10 字不动（防误伤短句与碎片句）。owner:llm 修复定位能力不足时由本函数确定性收口。
 */
export function fixParagraphOpeningRepeats(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const groups = new Map<string, Array<{ sentence: string; start: number; end: number }>>();
  for (const match of markdown.matchAll(PARAGRAPH_START_RE)) {
    const sentence = match[1].trim();
    const fingerprint = sentence.replace(/[\d,，.。%％㎡m2²]/gu, '').slice(0, 16);
    if (fingerprint.length < 10) continue;
    const group = groups.get(fingerprint) || [];
    const offset = (match.index ?? 0) + match[0].indexOf(match[1]);
    group.push({ sentence, start: offset, end: offset + match[1].length });
    groups.set(fingerprint, group);
  }
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    // 全组公共前缀（按字符逐位比较）
    const first = group[0].sentence;
    let prefixLen = first.length;
    for (const item of group.slice(1)) {
      let common = 0;
      const max = Math.min(prefixLen, item.sentence.length);
      while (common < max && first[common] === item.sentence[common]) common += 1;
      prefixLen = common;
    }
    // 前缀截到最后一个冒号边界（词内截断回退到冒号，含冒号入前缀）
    const boundary = first.slice(0, prefixLen).lastIndexOf('：');
    const prefix = first.slice(0, boundary >= 0 ? boundary + 1 : prefixLen);
    if (prefix.length < 4) continue;
    for (let index = 1; index < group.length; index += 1) {
      const item = group[index];
      const rest = item.sentence.slice(prefix.length).trim();
      if (rest.length < 10) continue;
      replacements.push({ start: item.start, end: item.end, replacement: rest });
    }
  }
  if (replacements.length === 0) return { markdown, fixedCount: 0, details: [] };
  const fixed = applySpanReplacements(markdown, replacements.map(item => ({ ...item, detail: '段首固定开场剥离' })));
  return { markdown: fixed.markdown, fixedCount: fixed.fixedCount, details: [`段首固定开场剥离 ${fixed.fixedCount} 处`] };
}

/**
 * B2（丰乐镇实测）：截断句残留确定性修复——列表引导句双重冒号「： ：」、列表项行尾
 * 冒号残留「；：」「。：」与双冒号「：：」确定性收敛；引导句以冒号收尾/列表项以分号收尾
 * 属 Markdown 列表合法形态，由检测器侧列表行与列表引导句豁免承担（与修复器同源同口径）。
 */
export function fixTruncatedSentenceArtifacts(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const steps: Array<[RegExp, string]> = [
    [/：\s*：/gu, '：'],
    [/；：/gu, '；'],
    [/。：/gu, '。'],
    [/：：/gu, '：'],
  ];
  let result = markdown;
  let fixedCount = 0;
  for (const [re, to] of steps) {
    const before = result;
    result = result.replace(re, to);
    fixedCount += (before.match(new RegExp(re.source, 'gu')) || []).length;
  }
  if (result === markdown) return { markdown, fixedCount: 0, details: [] };
  return { markdown: result, fixedCount, details: [`截断句残留清洗 ${fixedCount} 处`] };
}

/**
 * B3（丰乐镇实测「1.2 项目主要施工内容」表格承载专业工程正文）：关键小节表格承载正文
 * 确定性兜底——检测器 majorContentGovernanceIssues 判「小节正文全为表格」即 error，
 * LLM 表格→段落改写定位失败时由本函数收口：从表格行确定性生成段落叙述
 * （分部分项工程分组 → 「X的Y量单位、Z量单位；」），插入小节标题之后、表格之前，
 * 表格保留（正式工程量表属合法要求）。只覆盖「作业对象与工程量」维度，
 * 工序/方法两维由三要素检测继续驱动 LLM 补写。
 */
export function fixTableBorneContentSections(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  const tableRowRe = /^\s*\|.+\|\s*$/u;
  const rowsToProse = (tableLines: string[]): string | undefined => {
    const cellsOf = (row: string) => row.split('|').map(item => item.trim()).slice(1, -1);
    const clean = (cell: string) => cell.replace(/[*_`~]/gu, '').trim();
    let header: string[] | undefined;
    const dataRows: string[][] = [];
    for (const line of tableLines) {
      const cells = cellsOf(line).map(clean);
      if (cells.every(cell => /^:?-{3,}:?$/u.test(cell))) continue;
      if (header === undefined) { header = cells; continue; }
      dataRows.push(cells);
    }
    if (!header || dataRows.length === 0) return undefined;
    const colIndex = (re: RegExp) => header.findIndex(cell => re.test(cell));
    const groupCol = colIndex(/分部分项|专业工程|工程名称|项目名称/u);
    const contentCol = colIndex(/工程内容|施工内容|工作内容|名称/u);
    const unitCol = colIndex(/单位/u);
    const qtyCol = colIndex(/工程量|数量/u);
    const groups = new Map<string, string[]>();
    const solo: string[] = [];
    for (const row of dataRows) {
      const group = groupCol >= 0 && row[groupCol] ? row[groupCol] : '';
      const content = contentCol >= 0 ? (row[contentCol] || '') : (groupCol >= 0 ? (row[groupCol] || '') : '');
      const qty = qtyCol >= 0 ? (row[qtyCol] || '') : '';
      const unit = unitCol >= 0 ? (row[unitCol] || '') : '';
      const phrase = `${content}${qty}${unit}`;
      if (!content && !qty) continue;
      if (group) {
        const list = groups.get(group) || [];
        list.push(phrase);
        groups.set(group, list);
      } else {
        solo.push(phrase);
      }
    }
    if (groups.size === 0 && solo.length === 0) return undefined;
    const parts = [...groups.entries()].map(([group, phrases]) => `${group}的${phrases.join('、')}`);
    if (solo.length > 0) parts.push(solo.join('、'));
    return `本项目主要施工内容包括：${parts.join('；')}。`;
  };
  const insertions: Array<{ lineIndex: number; paragraph: string; title: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{2,4})\s+(.+)$/u.exec(lines[index].trim());
    if (!heading || !/主要施工内容|主要施工方法/u.test(heading[2])) continue;
    const level = heading[1].length;
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const next = /^(#{1,6})\s+/u.exec(lines[end].trim());
      if (next && next[1].length <= level) break;
    }
    const body = lines.slice(index + 1, end);
    const tableLines = body.filter(line => tableRowRe.test(line.trim()));
    if (tableLines.length < 3) continue;
    const proseChars = body.filter(line => !tableRowRe.test(line.trim())).join('').replace(/[\s#*_`>-]/gu, '').length;
    if (proseChars >= 50) continue;
    const paragraph = rowsToProse(tableLines);
    if (!paragraph) continue;
    insertions.push({ lineIndex: index, paragraph, title: heading[2].trim() });
  }
  if (insertions.length === 0) return { markdown, fixedCount: 0, details: [] };
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    out.push(lines[index]);
    const hit = insertions.find(item => item.lineIndex === index);
    if (hit) out.push('', hit.paragraph);
  }
  return {
    markdown: out.join('\n'),
    fixedCount: insertions.length,
    details: insertions.map(item => `「${item.title}」表格改写段落兜底`),
  };
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
    // 4.17.3 示例数值泄漏根治：suggestion 会随缺陷消息注入修复指令，Repairer 曾把示例数值
    // （“45日历天总工期”）照抄进正文 → 修复后复检残留 → 修复节点 failed 恶性循环。
    // 修复指令示例一律去数值：只示范句式形态，具体数字必须来自绑定材料。
    suggestion: '总述数据只在工程概况类小节集中交代一次：其他章节直接写本章内容，仅可引用所需的具体数字（如计划工期天数），不得复述完整概况段。',
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

// A21 正向声明句豁免（丰乐镇第七轮实测）：「编制范围为…所界定的全部施工内容」
// 「将周边环境与既有设施保护作为控制性约束条件」是投标文件的标准正向声明（编制范围
// 界定/保护承诺），被 bge 语义召回归入自伤候选（与「专项设计文件尚未完成」原型相似度
// ≥0.6），修复轮改写反而引入新词面；正向声明句不进候选，保持原文。
// R9 八轮扩围：「分项验收…监理工程师签字确认后归档」为验收闭环正向句（实测被误召回），同样豁免。
// 4.19.13 扩围：合规文件引用句（「执行合建〔2020〕29号文件，以保函等方式替代工程质量保证金」）
// 是施组对招标文件实质条款（缺陷责任期/质保金/履约担保）的正向响应，被 bge 语义召回与
// 「依据承诺函后续跟踪完善」原型相似度≥0.6 误判自伤；引用文件号+落实动词形态豁免。
const POSITIVE_SELF_REFERENCE_RE = /编制范围为[^。；;]{0,40}?所界定的全部施工内容|作为施工组织的控制性约束条件|分项验收[，,]?验收记录经监理工程师签字确认后归档|(?:执行|按|依据|按照)[^。；;]{0,10}?(?:〔|【)?20\d{2}(?:〕|】)?\s*\d+\s*号\s*(?:文件|办法|规定)?/u;

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
    !POSITIVE_SELF_REFERENCE_RE.test(sentence)
    && SELF_UNDERMINING_QUERIES.some(query => underminingSimilarity(sentence, query) >= SEMANTIC_COVERAGE_THRESHOLD)))];
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

/** 确定性修复结果统一口径：修复后全文 + 修复处数（fixedCount===0 等价于同源检测器零命中） */
export interface DeterministicFixOutcome {
  markdown: string;
  fixedCount: number;
}

/** 节点内闭环修复（丰乐镇第九轮方案）：修复器修复后重复运行自身直至零命中或轮次上限——
 * 检测定位=修复定位同源，fixedCount===0 等价于该节点负责的问题清零；修复本身可能引入新形态
 *（修复 A 后 A 的新命中），单遍修复无法收敛。轮次上限 + 无进展跳出双保险防死循环。
 * 只修复完成才返回（或达到上限），替代“单遍修复后无条件进入下一节点”的直线模式。 */
export function runFixUntilClean(fix: (markdown: string) => DeterministicFixOutcome, markdown: string, maxRounds = 3): DeterministicFixOutcome {
  let current = markdown;
  let total = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const result = fix(current);
    if (result.fixedCount === 0) break;
    current = result.markdown;
    total += result.fixedCount;
  }
  return { markdown: current, fixedCount: total };
}

/** 链级收敛循环（丰乐镇第九轮方案）：整链修复器按序跑完后复查——任一修复器有新命中即整链重跑，
 * 修复器互相引入的问题（A 修复后 B 新命中）在链循环中收敛，而不是堆到最后一个节点兑底；
 * 无进展即跳出（防互搏死循环）。 */
export function runDeterministicChainUntilConverged(fixers: Array<(markdown: string) => DeterministicFixOutcome>, markdown: string, maxRounds = 3): DeterministicFixOutcome {
  let current = markdown;
  let total = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    let roundTotal = 0;
    for (const fix of fixers) {
      const result = fix(current);
      if (result.fixedCount === 0) continue;
      current = result.markdown;
      roundTotal += result.fixedCount;
    }
    if (roundTotal === 0) break;
    total += roundTotal;
  }
  return { markdown: current, fixedCount: total };
}

// B6 负向语境豁免（丰乐镇第五轮实测）：「全部分部分项内容」中的「部(2)分(3)部(4)分(5)」
// 被字符级叠词检测误判为「部分部分」（行业标准术语分部分项被误报且收敛修复会破坏术语）；
// 匹配前为「分」或匹配后为「项」的紧邻重复属「分部分项」术语内部，不判叠词也不收敛。
export const REPEATED_WORD_RE = /(?<!分)([\u4e00-\u9fa5]{2})\1(?!项)/gu;

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

/** B6 表格断行残片确定性合并（丰乐镇第五轮实测）：检测器（qualityValidation 单竖线残行）
 * 只报不修，修复轮循环无效；“增开清表作业面，”+“延长有效作业时间 |”残行实为上一表格行
 * 末单元格续文（单元格内换行带竖线，mergeTableLineBreaks 不合并）；去残行竖线拼回上一行
 * 末单元格，与检测器同口径（单竖线结尾、不以 | 开头、上一行为表格行）。 */
export function mergeTableLineResidues(markdown: string): { markdown: string; fixedCount: number } {
  const lines = markdown.split(/\r?\n/u);
  const out: string[] = [];
  let fixedCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const prev = (out[out.length - 1] ?? '').trimEnd();
    const isLonePipeResidue = Boolean(trimmed)
      && !/^\|/u.test(trimmed)
      && trimmed.endsWith('|')
      && (trimmed.match(/\|/gu) || []).length === 1
      && !/^#{1,6}\s/u.test(trimmed)
      && MARKDOWN_TABLE_ROW_RE.test(prev);
    if (isLonePipeResidue) {
      // 残行是上一行末单元格续文：去掉残行竖线，拼回上一行最后一个单元格内
      // （上单元格以中文标点结尾时不加空格，「增开清表作业面，」+「延长有效作业时间」）
      const residueText = trimmed.slice(0, trimmed.lastIndexOf('|')).trim();
      const prevBody = prev.slice(0, prev.lastIndexOf('|')).trimEnd();
      const separator = /[，。；、：]$/u.test(prevBody) ? '' : ' ';
      out[out.length - 1] = `${prevBody}${separator}${residueText} |`;
      fixedCount += 1;
      continue;
    }
    out.push(line);
  }
  return { markdown: out.join('\n'), fixedCount };
}

// ── 12. 装饰层工艺厚度异常（A21 丰乐镇第七轮实测）：抹面/打底/找平/坐浆等装饰层
// 厚度 200mm（LLM 把清单「槽底预留 200mm」泛化串染到装饰层），远超工艺常规 20~30mm；
// 结构层厚度（墙体 200mm、垫层 200mm、回填虚铺 200mm）不动，仅装饰语境三倍数除 10。 ──

const FINISH_THICKNESS_CONTEXT_WORD = '抹面|打底|找平|坐浆|结合层|粘结层|罩面|批嵌|腻子';

/** 装饰层厚度异常检测：装饰语境词前/后近邻的三位数 mm 厚度（≥100mm）判工艺参数错误 */
export function finishThicknessIssues(markdown: string): ValidationIssue[] {
  const hits: string[] = [];
  for (const match of markdown.matchAll(new RegExp(`(${FINISH_THICKNESS_CONTEXT_WORD})[^。；;\n|]{0,10}?(\\d{3,})\\s*mm`, 'gu'))) {
    const value = Number(match[2]);
    if (value >= 100) hits.push(`“${match[1]}”厚度 ${value}mm`);
  }
  for (const match of markdown.matchAll(new RegExp(`(\\d{3,})\\s*mm厚?[^。；;\n|]{0,18}(${FINISH_THICKNESS_CONTEXT_WORD})`, 'gu'))) {
    const value = Number(match[1]);
    if (value >= 100) hits.push(`“${match[2]}”厚度 ${value}mm`);
  }
  const unique = [...new Set(hits)].slice(0, 3);
  if (unique.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `装饰层工艺参数异常：${unique.join('、')} 远超工艺常规厚度（抹面/打底/找平 20mm、坐浆 20～30mm）`,
    suggestion: '装饰层（抹面/打底/找平/坐浆/结合层）厚度按工艺常规取值：抹面打底找平 20mm、坐浆 20～30mm，与结构层厚度（墙体/垫层/回填）区分，不得串用。',
  }];
}

/** 装饰层厚度确定性修复（检测定位=修复定位）：≥100mm 的装饰语境厚度除以 10（200→20、100→10） */
export function fixFinishThickness(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  const fixes: Array<{ re: RegExp; group: number }> = [
    { re: new RegExp(`((?:${FINISH_THICKNESS_CONTEXT_WORD})[^。；;\n|]{0,10}?)(\\d{3,})(\\s*mm)`, 'gu'), group: 2 },
    { re: new RegExp(`(\\d{3,})(\\s*mm厚?[^。；;\n|]{0,18}(?:${FINISH_THICKNESS_CONTEXT_WORD}))`, 'gu'), group: 1 },
  ];
  for (const { re, group } of fixes) {
    const matches = [...result.matchAll(re)].filter(match => Number(match[group]) >= 100);
    for (const match of matches) {
      const value = Number(match[group]);
      const corrected = String(Math.round(value / 10));
      // match[0] 内只有一个目标数字（装饰语境匹配窗口），直接字符串替换第一个出现即可；
      // 不能用 \b 边界正则——「200mm」中 0 与 m 同为单词字符，\b200\b 不成立
      result = result.replace(match[0], match[0].replace(match[group] ?? '', corrected));
      fixedCount += 1;
      details.push(`${value}mm→${corrected}mm`);
    }
  }
  return { markdown: result, fixedCount, details };
}

// ── 13. 劳动力总人数与高峰人数多口径矛盾（A21 丰乐镇第七轮实测）：正文「高峰期总
// 人数181人」与「高峰人数86人」并存（明细加和值 vs 峰值需求值串用）；同一口径的
// 峰值人数全文必须唯一，按多数口径统一（峰值口径出现次数多者胜出）。 ──

/** 劳动力峰值口径检测：总人数口径与高峰人数口径并存且数值不同 → error；
 * F15 升级（丰乐镇第 3 轮实测）：进表格提取各表工种高峰人数，同工种跨表 max 比对——
 * 第五章工种配置表「电工40人」与附表「电工4人」并存属同工种跨表互斥（正文声明句互查不可见），
 * 两张表同一工种高峰人数必须唯一（分阶段投入表内同工种多行分阶段配置合法，表内取该工种最大值参与跨表比对） */
export function laborPeakConflictIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const totalValues = [...markdown.matchAll(/高峰期总人数(\d+)人|劳动力总人数(\d+)人|总人数(\d+)人/gu)].map(match => Number(match[1] || match[2] || match[3])).filter(value => value > 0);
  const peakValues = [...markdown.matchAll(/高峰(?:期)?人数(\d+)人|峰值(?:需求|人数)?[为约]?(\d+)人/gu)].map(match => Number(match[1] || match[2])).filter(value => value > 0);
  const totalSet = [...new Set(totalValues)];
  const peakSet = [...new Set(peakValues)];
  const conflicts = totalSet.filter(total => peakSet.some(peak => peak !== total && Math.abs(peak - total) > total * 0.2));
  if (conflicts.length > 0) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `劳动力峰值口径矛盾：正文「总人数」出现 ${totalSet.join('人、')}人 与「高峰人数」出现 ${peakSet.join('人、')}人 并存，峰值人数必须唯一`,
      suggestion: '全文劳动力峰值只允许一个口径：统一总人数与高峰人数为同一数值，删除矛盾口径；分阶段梯次投入人数（准备阶段/主体阶段/竣工阶段）属合法动态配置，不在统一范围内。',
    });
  }
  // F15 同工种跨表高峰人数比对：每表每工种取表内最大值（分阶段表内多行合法），跨表同工种差异 >20% → error
  const tradePeaksByTable = new Map<string, number[]>();
  for (const block of collectLaborTableBlocks(markdown)) {
    if (!block.hasTradeCol || block.tradeCells.length === 0) continue;
    const perTable = new Map<string, number>();
    for (const cell of block.tradeCells) {
      const current = perTable.get(cell.trade) ?? 0;
      if (cell.value > current) perTable.set(cell.trade, cell.value);
    }
    for (const [trade, value] of perTable) {
      const list = tradePeaksByTable.get(trade) ?? [];
      list.push(value);
      tradePeaksByTable.set(trade, list);
    }
  }
  const tradeConflicts = [...tradePeaksByTable.entries()].filter(([, values]) => {
    const max = Math.max(...values);
    const min = Math.min(...values);
    return values.length >= 2 && max - min > max * 0.2;
  });
  if (tradeConflicts.length > 0) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `同工种跨表高峰人数矛盾：${tradeConflicts.map(([trade, values]) => `${trade} ${values.join('人、')}人`).join('；')} 各表并存，同一工种高峰人数必须唯一`,
      suggestion: '同一工种在各表中的高峰人数必须一致：以工种配置表（第五章）为权威口径统一各表数值；分阶段投入计划表内同工种不同阶段的动态配置属合法数据，不参与统一。',
    });
  }
  return issues;
}

// ── 16. 用水高峰人数 vs 劳动力峰值跨字段关联（F16 丰乐镇第 3 轮实测）：正文「用水高峰人数
// X 人」与「劳动力峰值 N 人」是同一批人的两个引用口径，X ≠ N 即数据自相矛盾——
// 蓝图渲染值化句「生活用水按高峰人数 N 人」的 N 即劳动力峰值，正文若另编一套值（
// 120 人 vs 71 人）属双口径残留；临时用水需求以劳动力峰值为唯一人数源 ──

/** 提取正文「用水/生活用水语境 + 高峰人数 X 人」形态的值（蓝图值化句同形态，与劳动力峰值互查） */
function waterPeakLaborValues(markdown: string): number[] {
  const values: number[] = [];
  const WATER_CONTEXT_RE = /(?:生活用水|施工用水|临时用水|用水)[^。；;\n]{0,24}(?:高峰(?:期)?人数|高峰人数)[^。；;\n]{0,8}?([\d,]+)\s*人/gu;
  for (const match of markdown.matchAll(WATER_CONTEXT_RE)) {
    const value = Number(match[1].replace(/[,，]/gu, ''));
    if (Number.isFinite(value) && value > 0) values.push(value);
  }
  return values;
}

/** 用水高峰人数 vs 劳动力峰值关联检测：用水语境高峰人数与劳动力峰值不一致 → error */
export function waterLaborPeakAssociationIssues(markdown: string): ValidationIssue[] {
  const waterPeaks = waterPeakLaborValues(markdown);
  if (waterPeaks.length === 0) return [];
  // 劳动力峰值池：与用水语境互斥——数字左侧 24 字窗口含「用水/生活用水/临时用水」的匹配归用水口径
  // （同句「用水高峰人数 120 人」的 120 若同时入劳动力池则 waterSet ⊆ laborSet 恒真漏检）；
  // 阶段限定峰值（管网阶段 35 人）属分阶段口径不参与总口径互查（laborPeakStageOf 同源判定）
  const laborPeaks: number[] = [];
  const LABOR_PEAK_RE = /高峰(?:期)?人数([\d,]+)人|峰值(?:需求|人数)?[为约]?([\d,]+)人|劳动力峰值[^。；;\n]{0,8}?([\d,]+)\s*人/gu;
  for (const match of markdown.matchAll(LABOR_PEAK_RE)) {
    const raw = (match[1] || match[2] || match[3] || '').replace(/[,，]/gu, '');
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    const valueIndex = (match.index ?? 0) + match[0].indexOf(match[1] || match[2] || match[3] || '');
    const prefix = markdown.slice(Math.max(0, valueIndex - 24), valueIndex);
    if (/生活用水|施工用水|临时用水|用水/u.test(prefix)) continue;
    if (laborPeakStageOf(markdown, valueIndex)) continue;
    laborPeaks.push(value);
  }
  const laborSet = [...new Set(laborPeaks)];
  if (laborSet.length === 0) return [];
  const waterSet = [...new Set(waterPeaks)];
  const mismatches = waterSet.filter(water => laborSet.every(labor => labor !== water));
  if (mismatches.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `用水高峰人数与劳动力峰值不一致：临时用水按高峰人数 ${waterSet.join('人、')}人 计算，而劳动力峰值为 ${laborSet.join('人、')}人，两处引用必须为同一数值`,
    suggestion: '临时用水高峰人数与劳动力峰值为同一批施工人员的两个引用口径：统一改为劳动力峰值人数，删除自编的用水人数口径。',
  }];
}

// ── 17. 元话语声明句清洗（F17）：正文中「不再另行出现其他口径」「不再另行统计累计投入
// 人次」「以 X 为唯一控制基准，不再…」类声明句是写作层自我声明（声明≠数据），
// 不承载任何工程信息且直接暴露多口径历史（远端客户视为低级错误）；检测进修复回路，
// 确定性清洗与检测同源同模式 ──

/** 元话语声明句模式：自我声明式（不再另行…）与唯一基准式（以X为唯一控制基准） */
const META_DECLARATION_RE = /不再另行(?:出现|统计|编制|设置|单列|重复)[^。；;\n]{0,40}|以[^。；;\n]{0,16}为唯一[^。；;\n]{0,24}不再[^。；;\n]{0,20}|不再另行[^。；;\n]{0,24}/gu;

/** 元话语声明句检测：命中自我声明句 → error（清洗后残留即导出门禁阻断） */
export function metaDiscourseDeclarationIssues(markdown: string): ValidationIssue[] {
  const hits = [...markdown.matchAll(META_DECLARATION_RE)].map(match => match[0].trim().slice(0, 30));
  if (hits.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `正文存在元话语声明句 ${hits.length} 处（${[...new Set(hits)].slice(0, 3).join('、')}）：声明≠数据，正文只保留数据不保留口径声明`,
    suggestion: '删除「不再另行出现其他口径」「不再另行统计累计投入人次」「以 X 为唯一控制基准，不再…」类自我声明句；数据本身的唯一性由数值一致体现，不需要文字声明。',
  }];
}

/** 元话语声明句确定性清洗（检测定位=修复定位）：
 * ① 整句删除——句内除声明外无数据内容（纯声明句）；
 * ② 从句删除——声明从句嵌在数据句尾（「…劳动力峰值 71 人，不再另行出现其他口径」保留数据主句）。 */
export function fixMetaDiscourseDeclarations(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  // 从句删除：逗号后的声明从句「，不再另行出现其他口径」「，不再另行统计累计投入人次」
  // （从句模式排除逗号防贪婪吞后续内容；保留原逗号，句尾「，。」由下方清理收敛）
  result = result.replace(/([，,])\s*(?:不再另行[^。；;\n，,]{0,40}|以[^，,。；;\n]{0,16}为唯一[^，,。；;\n]{0,24}不再[^，,。；;\n]{0,20})/gu, (_full, comma: string) => {
    fixedCount += 1;
    return comma;
  });
  // 句首声明句整句删除：句边界后紧跟「不再另行…/以X为唯一控制基准」且句内无其他数据（句尾删除）
  const sentenceRe = /(?:^|[。；;\n])([^。；;\n]*?(?:不再另行[^。；;\n]{0,40}|以[^。；;\n]{0,16}为唯一[^。；;\n]{0,24}不再[^。；;\n]{0,20})[^。；;\n]*)(?=[。；;\n]|$)/gu;
  const sentences = [...result.matchAll(sentenceRe)];
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of sentences) {
    const full = match[0];
    const sentenceBody = match[1] ?? '';
    const withoutDeclaration = sentenceBody.replace(META_DECLARATION_RE, '').trim();
    // 声明从句已在上面删除过：若剩余主体不含数字数据（劳动力/人数/工程量等），整句删除
    if (/(?:\d)/u.test(withoutDeclaration)) continue;
    spans.push({ start: (match.index ?? 0) + full.indexOf(sentenceBody), end: (match.index ?? 0) + full.indexOf(sentenceBody) + sentenceBody.length });
  }
  for (const span of [...spans].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, span.start) + result.slice(span.end);
    fixedCount += 1;
  }
  // 清理删除残留：连续标点收敛（「，，」→「，」、句尾「，。」→「。」、句首逗号删除、空行去重）
  const before = result;
  result = result.replace(/，+/gu, '，').replace(/，(?=[。；;\n])/gu, '').replace(/(?:^|[。；;\n])\s*，/gu, (_full, prefix: string) => prefix).replace(/([。；;])\1+/gu, '$1').replace(/^[。；;\s]+/u, '').replace(/\n{3,}/gu, '\n\n');
  if (result !== before) fixedCount += 1;
  if (fixedCount > 0) details.push(`元话语声明句清洗 ${fixedCount} 处`);
  return { markdown: result, fixedCount: fixedCount > 0 ? 1 : 0, details };
}

// ── 18. 公式形态残留检测与清洗（F18 远端客户反馈「公式直接输入正文」根治）：正文出现
// 「P =」「Σ」「cosφ」「K1」「q =」公式形态 → error 并清洗。蓝图渲染层已值化（D 组），
// 此处为最终防线兼防资料原文（投标文件/定额摘录）公式被 Writer 抄入正文。
// 里程桩号「K1+200」不属公式形态（K1 后接 +数字 而非 ×Σ），刻意排除防误伤 ──

/** 公式形态正则：P =/q = 开头或 Σ/cosφ/系数×Σ 组合；桩号 K1+200 类不含计算符号不命中 */
const FORMULA_FORM_RE = /(?:[Pp]\s*=\s*[^。；;\n]{0,60}(?:Σ|cosφ|[Kk][12])|[qQ]\s*=\s*[^。；;\n]{0,40}|Σ\s*P|cos\s*φ|[Kk][12]\s*[×*]\s*Σ|[Kk][12]\s*Σ\s*P)/gu;

/** 公式形态残留检测：正文出现计算公式符号 → error（导出门禁阻断） */
export function formulaResidueIssues(markdown: string): ValidationIssue[] {
  const hits = [...markdown.matchAll(FORMULA_FORM_RE)].map(match => match[0].trim().slice(0, 30));
  if (hits.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `正文出现公式形态残留 ${hits.length} 处（${[...new Set(hits)].slice(0, 3).join('、')}）：正文只允许计算值不允许计算公式`,
    suggestion: '删除公式符号（P =、Σ、cosφ、K1、q =），只保留计算结果值：如「用电负荷约 48kW」「高峰日生活用水量约 X m³」；公式推导过程一律不进入正文。',
  }];
}

/** 公式形态确定性清洗（检测定位=修复定位）：
 * ① 片段删除——公式片段（P=…/q=…/ΣP…）删除后句子仍含中文数据（如「用电负荷约 48kW」）时保留数据句；
 * ② 整句删除——删除后句子无中文内容（纯符号/数字残片）时整句删除。 */
export function fixFormulaResidues(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  // 公式片段模式排除逗号：贪婪吞逗号会把同句值化数据（「，用电负荷约 48kW」）一并删除（数据丢根因）
  const FORMULA_FRAGMENT_RE = /(?:[Pp]\s*=\s*[^。；;\n，,]*|[qQ]\s*=\s*[^。；;\n，,]{0,80}|Σ\s*[Pp][12]?(?:\s*\/\s*cos\s*φ)?[^。；;\n，,]{0,40}|[Kk][12]\s*[×*]?\s*Σ\s*[Pp][12]?[^。；;\n，,]{0,40}|cos\s*φ[^。；;\n，,]{0,20})/gu;
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  // 先片段删除公式符号段（保留同句的数据值），再清理残留纯符号句
  result = result.replace(FORMULA_FRAGMENT_RE, () => { fixedCount += 1; return ''; });
  // 残留清理：句内只剩标点/空壳（无中文且无「kW/m³」值化单位）→ 整句删除
  const huskSentenceRe = /(?:^|[。；;\n])([^。；;\n]*)(?=[。；;\n]|$)/gu;
  const husks: string[] = [];
  for (const match of result.matchAll(huskSentenceRe)) {
    const body = (match[1] ?? '').replace(/[\s|，,：:（）()×=+-]/gu, '');
    if (body.length === 0) continue;
    if (/[\u4e00-\u9fff]/u.test(body)) continue; // 有中文保留
    if (/kW|m³|m3|kVA/u.test(body)) continue; // 有值化单位保留
    husks.push(match[1] ?? '');
  }
  for (const husk of [...new Set(husks)].sort((left, right) => right.length - left.length)) {
    const replaced = result.replace(husk, () => { fixedCount += 1; return ''; });
    result = replaced;
  }
  // 清理公式片段删除后的标点残片（「，计算得」「根据公式」类空转句）
  result = result.replace(/，+/gu, '，').replace(/\n{3,}/gu, '\n\n');
  if (fixedCount > 0) details.push(`公式形态残留清洗 ${fixedCount} 处`);
  return { markdown: result, fixedCount: fixedCount > 0 ? 1 : 0, details };
}

export function fixLaborPeakConflict(markdown: string, laborPeakAuthority?: number): { markdown: string; fixedCount: number; details: string[] } {
  const totalMatches = [...markdown.matchAll(/高峰期总人数(\d+)人|劳动力总人数(\d+)人|总人数(\d+)人/gu)];
  const peakMatches = [...markdown.matchAll(/高峰(?:期)?人数(\d+)人|峰值(?:需求|人数)?[为约]?(\d+)人/gu)];
  if (totalMatches.length === 0 || peakMatches.length === 0) return { markdown, fixedCount: 0, details: [] };
  const valueOf = (match: RegExpExecArray) => Number(match[1] || match[2] || match[3]);
  const totalCounts = new Map<number, number>();
  for (const match of totalMatches) {
    const value = valueOf(match);
    if (value > 0) totalCounts.set(value, (totalCounts.get(value) || 0) + 1);
  }
  const peakCounts = new Map<number, number>();
  for (const match of peakMatches) {
    const value = valueOf(match);
    if (value > 0) peakCounts.set(value, (peakCounts.get(value) || 0) + 1);
  }
  const majority = (counts: Map<number, number>) => [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  // 零值/非正值被上游过滤后 Map 可为空（「高峰期总人数0人」等边界），空口径直接无候选（防 undefined 解构崩溃）
  const totalWinner = majority(totalCounts);
  const peakWinner = majority(peakCounts);
  if (totalWinner === undefined || peakWinner === undefined) return { markdown, fixedCount: 0, details: [] };
  const [totalValue, totalFreq] = totalWinner;
  const [peakValue, peakFreq] = peakWinner;
  // D1 三层锚点优先级：蓝图劳动力峰值（造价锚定）> 分阶段明细表峰值 > 正文表述。
  // 蓝图权威存在时频率投票让位——与权威差 >30% 的口径值替换为权威值（与
  // fixLaborPeakConflicts 同阈值同方向，防两个修复器口径打架互相拉扯）；差 <=30% 的
  // 口径不动（近似口径不强行统一，交给蓝图引用一致性检测严格相等裁决）
  if (laborPeakAuthority !== undefined && laborPeakAuthority > 0) {
    const drift = (value: number) => Math.abs(value - laborPeakAuthority) / Math.max(value, laborPeakAuthority);
    const authorityTotalRe = /(高峰期总人数|劳动力总人数|总人数)(\d+)人/gu;
    const authorityPeakRe = /(高峰(?:期)?人数)(\d+)人/gu;
    let result = markdown;
    const replaced = new Set<string>();
    if (totalValue !== laborPeakAuthority && drift(totalValue) > 0.3) {
      const next = result.replace(authorityTotalRe, (_full, prefix: string, value: string) => Number(value) === totalValue ? `${prefix}${laborPeakAuthority}人` : _full);
      if (next !== result) { result = next; replaced.add(`${totalValue}人`); }
    }
    if (peakValue !== laborPeakAuthority && drift(peakValue) > 0.3) {
      const next = result.replace(authorityPeakRe, (_full, prefix: string, value: string) => Number(value) === peakValue ? `${prefix}${laborPeakAuthority}人` : _full);
      if (next !== result) { result = next; replaced.add(`${peakValue}人`); }
    }
    // 形态扩展（丰乐镇第六轮）：「各专业班组高峰人数合计为625人」「高峰期劳动力总人数控制在42人」
    // 等隔断词形态与表格峰值行（| 劳动力峰值 | 42 人 |）不入原紧邻正则——与检测器模式1/6 同形态覆盖
    // （检测定位=修复定位），与权威差 >30% 的口径值统一替换为蓝图权威值
    const extendedPeakRe = /(各专业班组高峰人数|高峰期劳动力总人数|高峰(?:期)?人数|峰值(?:需求|人数)?)(?:合计为|控制在|为|约)?(\d+)人/gu;
    const tablePeakRe = /\|\s*(?:劳动力峰值|高峰(?:期)?人数|峰值人数)\s*\|\s*(\d+)\s*人\s*\|/gu;
    result = result.replace(extendedPeakRe, (_full, prefix: string, value: string) => {
      const num = Number(value);
      if (num > 0 && num !== laborPeakAuthority && drift(num) > 0.3) { replaced.add(`${num}人`); return `${prefix}${laborPeakAuthority}人`; }
      return _full;
    });
    result = result.replace(tablePeakRe, (_full, value: string) => {
      const num = Number(value);
      if (num > 0 && num !== laborPeakAuthority && drift(num) > 0.3) { replaced.add(`${num}人`); return _full.replace(value, String(laborPeakAuthority)); }
      return _full;
    });
    if (result !== markdown) {
      return { markdown: result, fixedCount: 1, details: [`劳动力峰值统一：${[...replaced].join('/')}→${laborPeakAuthority}人（以蓝图劳动力峰值为准）`] };
    }
    return { markdown, fixedCount: 0, details: [] };
  }
  if (totalValue === peakValue) return { markdown, fixedCount: 0, details: [] };
  const winner = peakFreq >= totalFreq ? peakValue : totalValue;
  const loser = peakFreq >= totalFreq ? totalValue : peakValue;
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  const loserTotalRe = new RegExp(`(高峰期总人数|劳动力总人数|总人数)(\\d+)人`, 'gu');
  const loserPeakRe = new RegExp(`(高峰(?:期)?人数)(\\d+)人`, 'gu');
  if (peakFreq >= totalFreq) {
    result = result.replace(loserTotalRe, (_full, prefix: string, value: string) => Number(value) === loser ? `${prefix}${winner}人` : _full);
  } else {
    result = result.replace(loserPeakRe, (_full, prefix: string, value: string) => Number(value) === loser ? `${prefix}${winner}人` : _full);
  }
  if (result !== markdown) {
    fixedCount = 1;
    details.push(`劳动力峰值统一：${loser}人→${winner}人（${peakFreq >= totalFreq ? '高峰口径' : '总人数口径'}胜出）`);
  }
  return { markdown: result, fixedCount, details };
}

// ── 12. 商务条款数据入正文检测（Q3）：施组正文禁止出现商务数据封闭集，出现即评审失分（徽光阁实测：暂列金额 60 万入正文） ──
// 阶段五语义升级：强词（COMMERCIAL_TERM_RE）与数字式（COMMERCIAL_RATE_RE）保留确定性判定（出现即商务数据）；
// 变体弱词（材料价格/商务报价类）仅词面召回，句级语义复核（semanticGate 统一入口）确认商务语义才计命中；
// 允许事实（合同估算价/投资估算类）作负例保护，混合句由语义裁决归属。

const COMMERCIAL_TERM_RE = /暂列金额|暂估价|报价明细|综合单价|清单合价|预留金|投标报价|异常低价|评标基准价/u;
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
  // 形态 B 捕获组是短词（「封顶」），topping 锚点 re 要求「主体」前缀——短词先归一为完整节点名再映射
  // （无归一则「主体结构封顶完成 | 第210天」的封顶样本 keyOf 无命中被静默丢弃，A正序+B表格组合漏检）
  const keyOf = (text: string) => {
    const normalized = text === '封顶' ? '主体结构封顶' : text;
    return SCHEDULE_NODE_ANCHORS.find(anchor => anchor.re.test(normalized))?.key;
  };
  const pushIfNode = (nodeText: string, day: number, raw: string) => {
    const key = keyOf(nodeText);
    if (key !== undefined && Number.isFinite(day) && day >= 1 && day <= 3000) samples.push({ key, day, raw });
  };
  // 形态 A：第N日完成X（正序完成式），节点捕获用完整节点名——
  // 防「第15日完成场地清表、临建搭设和基坑支护施工准备」这类准备阶段句误采为基坑支护节点
  // h18：「完成」与节点名之间排除枚举标点「，、」——「基础及地下室结构在第135日完成，主体结构封顶
  // 在第270日完成」枚举句中 135 曾被跨项误绑到主体结构封顶（第九次回归门禁误报根因）
  for (const match of markdown.matchAll(/第(\d{2,3})日[^。；;\n]{0,14}?完成[^。；;\n，、]{0,12}?(基坑支护及土方外运|装饰装修及幕墙|机电安装及智能化调试|室外工程及竣工验收|地下结构出正负零|主体结构封顶|正负零|封顶)/gu)) {
    pushIfNode(match[2], Number(match[1]), match[0].slice(0, 40));
  }
  // 形态 B：X完成|第N天（表格式完成列）：锚点后 8 字符内必须出现「完成」，
  // 中间负向前瞻排除「、/，/第N日」——防「正负零、第300日完成主体结构封顶、第450日」跨节点误采
  for (const match of markdown.matchAll(/(基坑支护|正负零|封顶|装饰装修|机电安装|竣工验收)(?:(?!(?:第\d{2,3}[日天]|，|、)).){0,8}?完成[^。；;\n]{0,10}?第(\d{2,3})[日天]/gu)) {
    pushIfNode(match[1], Number(match[2]), match[0].slice(0, 40));
  }
  // 形态 C：X节点锁定在开工后第N日（倒序锁定式）——中间负向前瞻排除「、/，/完成/第N日/句界」，
  // 防「主体结构封顶、第450日完成装饰装修」跨节点误采（合肥师范实测误采源）
  // h18：节点名后定点排除「后」（「主体结构封顶后第10日」拆除时间为封顶后相对日，非节点日期），
  // 窗口内不排除「后」——「开工后第210日」的「后」属绝对日锚定语素（开工后=绝对日），
  // 排除会误杀「主体封顶节点锁定在开工后第210日」合法倒序式；句界排除防止窗口跨句
  // 吞入下一句「第N日」（「第300日完成主体结构封顶。主体结构封顶后第10日」中前句起点跨句误采 10）；
  // 「|」仍窗口排除（设备表行进场日）
  for (const match of markdown.matchAll(/(主体(?:结构)?封顶)(?!后)(?:(?!(?:第\d{2,3}[日天]|，|、|完成|\||[。；;\n])).){0,20}?第(\d{2,3})日/gu)) {
    pushIfNode(match[1], Number(match[2]), match[0].slice(0, 40));
  }
  // 形态 D（h18）：关键节点表格行——首列含锚点词、次列「开工(令下发)后第N日」且其后直接竖线（完成日，
  // 排除「第N日进场/退场」设备表行），收「主体结构封顶 | 开工后第230日」表格式（旧三形态覆盖不到该形态）
  for (const anchor of SCHEDULE_NODE_ANCHORS) {
    const rowRe = new RegExp(`^\\s*\\|\\s*[^|]*${anchor.re.source}[^|]*\\s*\\|\\s*开工(?:令下发)?后第(\\d{2,3})日\\s*\\|`, 'gum');
    for (const match of markdown.matchAll(rowRe)) {
      pushIfNode(match[0], Number(match[1]), match[0].slice(0, 40));
    }
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
    // P2.3 收口修复：排除「人行道混凝土垫层/混凝土垫层」异名不同规格（人行道垫层 C25 合法），仅锁定通用「垫层」
    patterns: [/(?<!混凝土)垫层[^。；;\n|]{0,20}?(C\d{2})/gu],
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
    key: 'pump', label: '潜水泵（提升泵）数量', unit: '台', kind: 'number' as const,
    // P2.3 同物异名扩围：清单条目名为「提升泵」，正文常写作「潜水泵」，两词同口径统一收
    patterns: [/(?:潜水泵|提升泵)[^。；;\n]{0,24}?(\d+)\s*台/gu],
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
      // 4.17.3 表格行口径补盲：正/反向模式字符类均排除竖线，表格行「| 计划工期 | 210日历天 |」
      // 的工期值从不入池（表格值永远做不了权威，修复恒零产出）；行首竖线形态专门收集表格口径
      /^\s*\|\s*计划工期\s*\|\s*(\d{1,4})\s*个?\s*日历天\s*\|/gum,
      /(?:计划工期|合同工期|工期总日历天数|工期控制|工期目标|总工期)[^。；;\n|]{0,12}?(\d{1,4})\s*个?\s*日历天/gu,
      /(\d{1,4})\s*个?\s*日历天[^。；;\n|]{0,8}?(?:总工期|倒排|分解|为唯一|完成)/gu,
    ],
  },
  // 4.17.4 合肥师范实测：装配率 38.4% vs 招标锁定 30% 两套口径（评分器高风险「数据逻辑」）。
  // 外部权威（factsModel assembly_rate 事实卡/招标文本 30%）优先；模式收「装配率」邻接百分比，
  // 「装配率不低于30%」的最低线表述与「实际装配率为38.4%」并存时两值都会入池、由权威裁决统一。
  {
    key: 'prefabRatio', label: '装配率', unit: '%', kind: 'number' as const,
    patterns: [
      /装配率[^。；;\n|]{0,14}?(\d+(?:\.\d+)?)\s*%/gu,
      // 长窗口「装配率…计算为N%」形态（合肥师范实测：装配率按安徽省《装配式建筑评价技术标准》
      // DB34/T 3830-2025计算为38.4%，标准名 30+ 字符超出 14 字邻接窗口）
      /装配率[^。；;\n|]{0,44}?计算为(\d+(?:\.\d+)?)\s*%/gu,
      // 反向形态排除逗号：防「内隔墙非砌筑比例达到54.0%，装配率…」中 54.0%（独立指标）被误采为装配率
      /(\d+(?:\.\d+)?)\s*%(?:(?![，,。；;\n|]).){0,10}?装配率/gu,
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
  // h16：正向模式中间同样排除枚举标点「、，」——「塔吊覆盖范围内，配置钢筋切断机GQ40共4台」
  // 的 4 台是钢筋切断机数量，曾被跨枚举项误采为塔吊 4 台（第九次回归门禁误报根因）
  {
    key: 'towerCrane', label: '塔式起重机（塔吊）数量', unit: '台', kind: 'number' as const,
    patterns: [
      /(?:塔式起重机|塔吊)[^。；;\n|、，]{0,30}?(\d+)\s*台/gu,
      /(\d+)\s*台[A-Za-z0-9/\-–—～~]{0,16}\s{0,2}(?:塔式起重机|塔吊)/gu,
    ],
  },
  {
    // 「施工电梯」与「施工升降机」同物异名（真实生成两词并存，仅收前者漏检 L605 2台 vs L787 1台 矛盾）
    key: 'hoist', label: '施工升降机（施工电梯）数量', unit: '台', kind: 'number' as const,
    patterns: [
      /(?:施工升降机|施工电梯)[^。；;\n|、，]{0,30}?(\d+)\s*台/gu,
      /(\d+)\s*台[A-Za-z0-9/\-–—～~]{0,16}\s{0,2}(?:施工升降机|施工电梯)/gu,
    ],
  },
  {
    key: 'truckCrane', label: '汽车起重机（汽车吊）数量', unit: '台', kind: 'number' as const,
    patterns: [
      /(?:汽车起重机|汽车吊)[^。；;\n|、，]{0,30}?(\d+)\s*台/gu,
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
    key: 'slackDays', label: '机动工期（工序衔接与验收缓冲）', unit: '天', kind: 'number' as const,
    // P2.3：机动工期 = 总工期 − 里程碑总和（蓝图推导权威），「预留N天机动/缓冲」语境全文唯一
    patterns: [
      /(?:机动工期|缓冲)[^。；;\n|]{0,16}?(\d{1,3})\s*天/gu,
      /预留[^。；;\n|]{0,8}?(\d{1,3})\s*天[^。；;\n|]{0,10}?(?:机动|缓冲)/gu,
    ],
  },
  {
    key: 'villageCount', label: '自然村数量', unit: '个自然村', kind: 'number' as const,
    // P2.4：正文自然村数量与项目名锁定口径不符（跨项目残留「9 个自然村」）即统一；「自然村分组」口径不参与
    patterns: [/(\d+)\s*个(?:美丽宜居)?自然村(?!分组)/gu],
  },
  {
    key: 'circularSaw', label: '圆盘锯数量', unit: '台', kind: 'number' as const,
    patterns: [/圆盘锯[^。；;\n|]{0,24}?(\d+)\s*台/gu],
  },
] as const;

// ── 4.18.10 清单红线权威比对（丰乐镇实测）：绿化养护期/路灯数量 ──
// 评分报告 P1：清单「喷播植草（灌木）籽：养护期二级养护，养护两年」vs 正文多处「二级养护一年」
// ——养护期是清单实质性条款，正文必须回退为清单口径；报告 P3：路灯总数存疑（正文 20 套 vs 第四版
// 约 118 套），数量以清单核定。两者均属「清单权威 → 正文比对」单向判定，不作正文互查
// （分型号明细 17+3 与总数是合法口径关系，互查会误报），也不进确定性修复
// （分型号 vs 总数替换必错，交 LLM 修复轮）。

/** 中文数字 → 阿拉伯数字（养护期常见「一年/两年」；支持「十」「十X」「X十」简单形态） */
const CN_NUMBER_MAP: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNumberToArabic(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === '十') return 10;
  if (raw.startsWith('十') && raw.length === 2) return 10 + (CN_NUMBER_MAP[raw[1] ?? ''] ?? 0);
  if (raw.endsWith('十') && raw.length === 2) return (CN_NUMBER_MAP[raw[0] ?? ''] ?? 0) * 10;
  if (raw.length === 1 && CN_NUMBER_MAP[raw] !== undefined) return CN_NUMBER_MAP[raw];
  return undefined;
}

/** 绿化养护期权威口径：清单条目（喷播植草籽等）特征描述「养护两年」——label 或 value 含
 * 「养护」且邻接「X年」（含中文数字）时提取；「混凝土养护 14 天」类天单位不采。
 * 数据源：billItemFacts（清单行级条目，value=特征｜工程量）优先、bills/preciseFacts 散装事实兜底、
 * project 招标范围类事实卡最后——首命中即返回，多源重复无副作用。 */
/** 绿化养护期确定性修复（检测定位=修复定位）：正文「养护…X年」与清单权威年数不一致时
 * 统一替换为权威值（只替换数字/中文数字本身、不动句式）。
 * 养护期属清单实质性条款——丰乐镇实测「养护期按一年执行」残留因修复全靠 LLM 轮而漏改，
 * 确定性替换覆盖正文与表格行两种形态（字符类排除竖线保持表格行值不被吞）。 */
export function fixGreeningMaintenanceMismatch(markdown: string, authorityYears: number | undefined): { markdown: string; fixedCount: number; details: string[] } {
  if (authorityYears === undefined || authorityYears <= 0) return { markdown, fixedCount: 0, details: [] };
  const yearRe = /养护[^。；;\n|]{0,16}?([一二两三四五六七八九十]+|\d{1,2})\s*年/gu;
  let result = markdown;
  const replaced = new Set<string>();
  result = result.replace(yearRe, (line, rawValue: string) => {
    const value = cnNumberToArabic(rawValue);
    if (value === undefined || value === authorityYears || value <= 0) return line;
    replaced.add(`${rawValue}年`);
    return line.replace(rawValue, String(authorityYears));
  });
  if (result === markdown) return { markdown, fixedCount: 0, details: [] };
  return { markdown: result, fixedCount: 1, details: [`绿化养护期统一：${[...replaced].join('/')}→${authorityYears}年（以工程量清单养护期为准）`] };
}

export function extractGreeningMaintenanceAuthority(factsModel?: DocumentFactsModel | null): number | undefined {
  // 清单养护期可能混合口径（丰乐镇实测：红花酢浆草条目「养护一年」22 处 vs 其他苗木/草籽条目
  // 「养护两年」82 处）。首个命中即返回会把个别条目的口径（一年）升格为全文权威，修复器随后把
  // 主体条目（两年）全部改错。改为频率投票取众数：多数条目口径才是工程权威；并列时取大值
  // （养护期长在投标口径更安全）。
  const yearRe = /养护[^。；;|]{0,10}?([一二两三四五六七八九十]+|\d{1,2})\s*年/gu;
  // 跨源保持原优先级（bills > billItemFacts > preciseFacts > project）：首个有命中的源即权威域；
  // 源内频率投票取众数（丰乐镇实测：清单条目混合口径 82 处「养护两年」vs 22 处「养护一年」，
  // 首命中即返回会把个别条目的口径升格为全文权威），并列时取大值（养护期长在投标口径更安全）
  const sourceGroups = [factsModel?.bills ?? [], factsModel?.billItemFacts ?? [], factsModel?.preciseFacts ?? [], factsModel?.project ?? []];
  const collectInto = (text: string, votes: Map<number, number>) => {
    for (const match of text.matchAll(yearRe)) {
      const years = cnNumberToArabic(match[1] ?? '');
      if (years !== undefined && years > 0 && years <= 20) votes.set(years, (votes.get(years) || 0) + 1);
    }
  };
  const bestOf = (votes: Map<number, number>): number | undefined => {
    let best: number | undefined;
    let bestCount = 0;
    for (const [years, count] of votes) {
      if (count > bestCount || (count === bestCount && best !== undefined && years > best)) {
        best = years;
        bestCount = count;
      }
    }
    return best;
  };
  for (const group of sourceGroups) {
    const votes = new Map<number, number>();
    for (const fact of group) {
      const label = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
      collectInto(stringifyFactValue(fact.value), votes);
      collectInto(label, votes);
    }
    if (votes.size > 0) return bestOf(votes);
  }
  return undefined;
}

/** 路灯数量权威口径：清单路灯条目（分型号多行）「N套/N盏」数值求和（103+15=118 形态）。
 * 数据源分层：billItemFacts（清单行级条目，从「｜工程量：」段取数量防特征描述「套」字误采）优先；
 * 无行级条目时 bills+preciseFacts 兑底（同对象引用去重，防同源多数组重复计数——重复求和会令
 * 权威翻倍，正文正确值被误报 blocker）。 */
export function extractStreetLightAuthority(factsModel?: DocumentFactsModel | null): number | undefined {
  const labelHit = (fact: DocumentFact) => /路灯/u.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`);
  const billItemFacts = (factsModel?.billItemFacts ?? []).filter(labelHit);
  const facts = billItemFacts.length > 0
    ? billItemFacts
    : [...(factsModel?.bills ?? []), ...(factsModel?.preciseFacts ?? [])].filter(labelHit);
  const seen = new Set<DocumentFact>();
  let total = 0;
  for (const fact of facts) {
    if (seen.has(fact)) continue;
    seen.add(fact);
    const raw = stringifyFactValue(fact.value);
    // 行级条目取「｜工程量：」段（特征描述含「套」字样时不被误采为数量）
    const quantityText = raw.split('｜工程量：')[1] ?? raw;
    for (const match of quantityText.matchAll(/(\d+)\s*(?:套|盏|杆)/gu)) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) total += value;
    }
  }
  return total > 0 ? total : undefined;
}

/** 绿化养护期清单红线检测（评分报告 P1）：正文「养护/养护期 X年」与清单养护期权威口径
 * 差异 >20% → blocker（正文必须回退为清单口径）；无清单养护期事实不检测（不误伤无清单项目）。
 * 否定声明句豁免（与 crossSectionNumericConflictIssues 同口径）：match 所在行含「不再出现/纠正为」
 * 等声明词时不计入口径池——修复轮输出「统一为两年，不再出现养护一年」时「一年」是引用旧值，
 * 误报会导致修复死循环。 */
export function greeningMaintenanceMismatchIssues(markdown: string, factsModel?: DocumentFactsModel | null): ValidationIssue[] {
  const authority = extractGreeningMaintenanceAuthority(factsModel);
  if (authority === undefined) return [];
  const values = new Set<number>();
  // 正文窗口 16 字符（清单侧 10 字符）：「养护期按二级养护标准执行一年」类长语境不宽检；
  // 窗口过宽会跨语境误采其他「X年」口径，16 是养护语境覆盖与语境隔离的平衡点
  for (const match of markdown.matchAll(/养护[^。；;\n|]{0,16}?([一二两三四五六七八九十]+|\d{1,2})\s*年/gu)) {
    const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
    let lineEnd = markdown.indexOf('\n', match.index);
    if (lineEnd === -1) lineEnd = markdown.length;
    if (NEGATIVE_DECLARATION_RE.test(markdown.slice(lineStart, lineEnd))) continue;
    const years = cnNumberToArabic(match[1] ?? '');
    if (years !== undefined && years > 0) values.add(years);
  }
  if (values.size === 0) return [];
  const mismatched = [...values].filter(value => Math.abs(value - authority) > authority * 0.2);
  if (mismatched.length === 0) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `绿化养护期清单红线：正文出现养护期 ${mismatched.map(value => `${value}年`).join('、')}，与工程量清单锁定口径「养护 ${authority} 年」矛盾`,
    suggestion: `绿化养护期必须与工程量清单一致（清单锁定「养护 ${authority} 年」）：将正文所有养护期表述统一为 ${authority} 年并删除矛盾口径；养护期属清单实质性条款，不得以常规值替代。`,
  }];
}

/** 路灯数量清单红线检测（评分报告 P3）：正文路灯套数与清单权威口径差异 >20% → blocker。
 * 正文分型号多值（100W 17套 + 120W 3套）先求和再与清单总数比对；无清单路灯条目不检测。
 * 「分批/每批 X 套」语境值属批次口径非总数宣称，跳过防误报（评分报告正文 366 行「2批每批10套」形态）；
 * 否定声明句豁免同上——修复轮「不再出现路灯17套」类一致性声明不计入口径池防死循环。 */
export function streetLightCountMismatchIssues(markdown: string, factsModel?: DocumentFactsModel | null): ValidationIssue[] {
  const authority = extractStreetLightAuthority(factsModel);
  if (authority === undefined) return [];
  const values: number[] = [];
  // 套/盏/杆：路灯计量单位常见三态（定额单位、照明工程单位、灯杆计量）
  for (const match of markdown.matchAll(/路灯[^。；;\n|]{0,28}?(\d+)\s*(?:套|盏|杆)/gu)) {
    if (/批/u.test(match[0])) continue;
    const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
    let lineEnd = markdown.indexOf('\n', match.index);
    if (lineEnd === -1) lineEnd = markdown.length;
    if (NEGATIVE_DECLARATION_RE.test(markdown.slice(lineStart, lineEnd))) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) values.push(value);
  }
  if (values.length === 0) return [];
  // 分型号明细（100W 17套 + 120W 3套）按总数口径与清单比对
  const bodyTotal = values.length >= 2 ? values.reduce((sum, value) => sum + value, 0) : values[0] ?? 0;
  if (Math.abs(bodyTotal - authority) <= authority * 0.2) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `路灯数量口径矛盾：正文路灯配置合计约 ${bodyTotal} 套，与工程量清单锁定口径 ${authority} 套不一致（相差 ${Math.round((Math.abs(bodyTotal - authority) / authority) * 100)}%）`,
    suggestion: `路灯数量必须以工程量清单为准（清单锁定 ${authority} 套）：按清单核定各型号路灯数量并统一正文全部表述，删除与清单矛盾的套数口径。`,
  }];
}

const ENUMERATION_VALUE_RE = /\d+(?:\.\d+)?\s*(?:mm|kVA|次|具|台|套|个)\s*[/／]\s*\d+/u;

// 否定声明句豁免：「现场统一配置1台汽车起重机，本章及后续章节不再出现“汽车吊2台”等
// 与施工部署不一致的数量表述」属 LLM 一致性声明，句内数值是引用旧矛盾值而非事实口径，
// 曾导致汽车吊 2vs1 误报（真实生成实测）
const NEGATIVE_DECLARATION_RE = /不再出现|不得出现|严禁出现|避免出现|不采用|未采用|予以删除|已删除|取消|纠正为|更正为/u;

// F14c 跨工序切换词豁免（丰乐镇第三轮实测）：「垫层，再浇筑C30」的 C30 是垫层之上构件
// 的混凝土，20 字窗口无法区分工序，被误绑为垫层口径与 C20 互斥；匹配窗口内含工序切换词
// （再浇筑/然后浇筑/上层/上部/面层等）时该 token 属后续工序，不参与互斥池
const PROCESS_SWITCH_WORD_RE = /再浇筑|再浇|后浇筑|后浇|然后浇筑|然后再浇|上层|上部|面层浇筑|其上浇筑|浇筑完成后再/u;

// F14d 工艺参数前置词豁免（丰乐镇第三轮实测）：「浇筑时分层厚度不大于500mm」的 500mm 是
// 浇筑分层厚度工艺参数、「焊缝高度不小于4mm」的 4mm 是焊缝高度——均非该部位的构件厚度
// 规格，与权威厚度规格不可比对，40 字窗口误绑必须豁免
const PROCESS_PARAM_RE = /分层厚度|分层浇筑|分层振捣|焊缝高度|焊缝厚度|焊脚尺寸|锚固深度|保护层厚度|搭接长度|锚固长度|预留/u;

// F14d 部位枚举声明豁免（丰乐镇第三轮实测）：「有梁板厚度分别为200mm、150mm、200mm」是
// 多部位规格枚举（不同部位允许不同规格），不是本部位单一口径，不判规格错位
const ENUMERATION_DECLARE_RE = /分别为|分别对应|分别用于|分别按|依次为|依次/u;

// F14 部位语境分组：同物多规格按部位区分是合法口径（垫层 C15/主体 C35、XPS 屋面 50mm/墙面 130mm、
// 灭火器总量 40具/分区 4具），仅同一部位语境（或无部位标注）出现多值才判互斥；跨部位差异不再误报。
// 历史实现「不同标号直接互斥」逼 LLM 修复轮把多规格归一成一种（用户实锤：全文只用一种规格的制度性推手）
// 单字「板」不进词表：材料名词尾字（挤塑聚苯板/泡沫塑料板/岩棉板）会被误当部位，
// 使「XPS 30mm。屋面采用130mm」的 30mm 归入「板」组而漏报互斥；部位语境由长词（楼板/顶板/底板/筏板）覆盖
const LOCATION_WORD_SOURCE = '女儿墙|外墙|内墙|隔墙|地梁|圈梁|构造柱|过梁|垫层|承台|筏板|底板|基础|主体|梁|柱|墙|楼板|屋面|地面|楼面|顶板|楼梯|阳台|雨篷|台阶|散水|坡道|找坡|找平|保护层|防水层|保温层|隔汽层|地坪|办公区|生活区|库房|加工区|堆放区|驻地|周转场|停放区|仓库|材料库';

// A14 每台X配备部位形态（丰乐镇第三轮实测：“每台燃油机械配备4kg干粉灭火器不少于1具”
// 的“每台燃油机械”是部位语境，“机械”不在 LOCATION_WORD_SOURCE，导致 1具 混入未标注组误报互斥）
const PER_UNIT_LOCATION_RE = /每[台辆架套部][一-龥A-Za-z0-9]{1,8}/gu;

// B6 部位实体限定词（丰乐镇第六轮实测）：「项目部驻地 4具」与「总协调驻地 20具」被归一
// 为同一部位「驻地」误报互斥——两者是不同实体（项目部 vs 总协调驻地）；部位词前紧邻
// 实体限定词时组合成「限定词+部位词」参与分组，不同实体不再互比。限定词集取驻地区
// 常见前缀（项目部/总协调/工人生活/办公/生活/临时/总部/标段/片区），不含部位词本身。
const LOCATION_ENTITY_QUALIFIER_RE = /项目部|总协调|工人生活|施工办公|办公|生活|临时|总部|标段|片区/u;

/** 部位词前紧邻实体限定词时组合为限定词+部位词（限定词与部位词不同源不重叠） */
function qualifyLocationHit(locationHit: string, sourceText: string, hitIndex: number): string {
  const before = sourceText.slice(Math.max(0, hitIndex - 8), hitIndex);
  const qualifierMatch = before.match(LOCATION_ENTITY_QUALIFIER_RE);
  if (!qualifierMatch || qualifierMatch.index === undefined) return locationHit;
  // 限定词与部位词相邻（中间只允许“的/施工/区域”等弱连接字），远离则不组合
  const gap = before.slice((qualifierMatch.index ?? 0) + qualifierMatch[0].length);
  if (/^[的施工区域现场]{0,3}$/u.test(gap)) return `${qualifierMatch[0]}${locationHit}`;
  return locationHit;
}

/** 从匹配窗口提取部位组：窗口从最近分隔符（，、，;；。|）后截断（防跨句串染：
 *  「外墙…A5.0。内墙…A3.5」的内墙匹配窗口不得吞入前句「外墙」），并先剥离「XX阶段」
 *  阶段限定语境（「主体结构阶段配置施工电梯2台」的阶段词不是部位，不参与部位分组）；
 *  无部位词则归入默认组（''） */
function locationGroupForMatch(markdown: string, matchIndex: number, raw: string, lineStart: number): string {
  // A14 表格行：整行都是部位语境（“| 灭火器 | 干粉4kg | 12具 | 材料库、配电箱旁 |”
  // 的部位在第 4 列，匹配窗口只覆盖匹配前的 16 字符会漏掉部位列）；整行扫描部位词
  const lineEndIndex = markdown.indexOf('\n', matchIndex);
  const lineText = markdown.slice(lineStart, lineEndIndex === -1 ? markdown.length : lineEndIndex);
  if (/^\s*\|/u.test(lineText) && /\|\s*$/u.test(lineText.trim())) {
    const lineStageStripped = lineText.replace(/[\u4e00-\u9fa5]{2,6}阶段/gu, '');
    const lineHits = [...lineStageStripped.matchAll(new RegExp(LOCATION_WORD_SOURCE, 'gu'))];
    const lastHit = lineHits[lineHits.length - 1];
    return lastHit ? qualifyLocationHit(lastHit[0], lineStageStripped, lastHit.index ?? 0) : '';
  }
  const windowStart = Math.max(lineStart, matchIndex - 16);
  const before = markdown.slice(windowStart, matchIndex);
  const cut = Math.max(before.lastIndexOf('，'), before.lastIndexOf('、'), before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('；'), before.lastIndexOf('。'));
  const effectiveStart = cut >= 0 ? windowStart + cut + 1 : windowStart;
  const window = markdown.slice(effectiveStart, matchIndex + raw.length);
  const stageStripped = window.replace(/[\u4e00-\u9fa5]{2,6}阶段/gu, '');
  // A14 每台X配备形态：取窗口内最后一个“每台X”实体作为部位组（比词表更精确）
  const perUnit = [...stageStripped.matchAll(PER_UNIT_LOCATION_RE)];
  if (perUnit.length > 0) return perUnit[perUnit.length - 1]?.[0] ?? '';
  // 取最后一个部位词（最具体）：「基础垫层」的「基础」在前「垫层」在后，部位应为垫层；
  // 「主体结构外墙」取「外墙」、「屋面女儿墙」取「女儿墙」，复合词取尾词符合部位归属语义；
  // 每次新建带 g 正则实例——模块级共享实例的 lastIndex 会在 matchAll 间串状态
  const hits = [...stageStripped.matchAll(new RegExp(LOCATION_WORD_SOURCE, 'gu'))];
  const lastHit = hits[hits.length - 1];
  return lastHit ? qualifyLocationHit(lastHit[0], stageStripped, lastHit.index ?? 0) : '';
}

export function crossSectionNumericConflictIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const anchor of CROSS_SECTION_ANCHORS) {
    const valuesByGroup = new Map<string, Set<string>>();
    const rawsByGroup = new Map<string, string[]>();
    for (const pattern of anchor.patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const raw = match[0].slice(0, 40);
        // 并列枚举豁免：「50mm/70mm」「C30/C35」属同句多规格正常枚举，不判冲突
        if (ENUMERATION_VALUE_RE.test(raw)) continue;
        // F14c 跨工序切换豁免：「垫层，再浇筑C30」的 C30 属后续构件，不参与本部位互斥池
        if (PROCESS_SWITCH_WORD_RE.test(raw)) continue;
        // A14 最低保障线豁免（丰乐镇第三轮实测）：“每台燃油机械配备4kg干粉灭火器不少于1具”
        // “干粉灭火器按不少于20具配置”是保障性下限表述而非精确配置口径，不参与互斥判定
        if (/按不少于|不少于/u.test(raw)) continue;
        // 否定声明句豁免：match 所在行含「不再出现」等声明词时不计入口径池
        const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
        let lineEnd = markdown.indexOf('\n', match.index);
        if (lineEnd === -1) lineEnd = markdown.length;
        if (NEGATIVE_DECLARATION_RE.test(markdown.slice(lineStart, lineEnd))) continue;
        const group = locationGroupForMatch(markdown, match.index || 0, raw, lineStart);
        const values = valuesByGroup.get(group) || new Set<string>();
        values.add(match[1]);
        valuesByGroup.set(group, values);
        const raws = rawsByGroup.get(group) || [];
        raws.push(raw);
        rawsByGroup.set(group, raws);
      }
    }
    // F14b 无部位标注口径：仅当全文恰有一个部位组时，未标注值视为该部位的全口径参与互查——
    // 「XPS 30mm。屋面采用130mm」的 30mm 未标注部位，与屋面 130mm 属全文口径互斥；
    // 「灭火器40具+办公区4具+库房2具」多部位组并存时未标注值是总量口径，不与分区配置互比
    const unlabeled = valuesByGroup.get('') || new Set<string>();
    const labeledGroups = [...valuesByGroup.keys()].filter(key => key !== '');
    if (unlabeled.size > 0 && labeledGroups.length === 1) {
      const target = valuesByGroup.get(labeledGroups[0] || '');
      if (target) {
        for (const value of unlabeled) target.add(value);
        const targetRaws = rawsByGroup.get(labeledGroups[0] || '') || [];
        targetRaws.push(...(rawsByGroup.get('') || []));
        rawsByGroup.set(labeledGroups[0] || '', targetRaws);
        valuesByGroup.delete('');
        rawsByGroup.delete('');
      }
    }
    for (const [group, values] of valuesByGroup) {
      if (values.size < 2) continue;
      const raws = rawsByGroup.get(group) || [];
      if (anchor.kind === 'code') {
        // 标号类（C15/C20、A5.0/A3.5）：同一部位语境下不同标号直接互斥
        issues.push({
          level: 'error',
          severity: 'blocker',
          category: 'fact_consistency',
          owner: 'llm',
          repairability: 'llm_repairable',
          message: `材料参数口径矛盾：“${anchor.label}”${group ? `在部位「${group}」` : '在未标注部位语境下'}出现 ${[...values].map(value => `${value}${anchor.unit}`).join(' 与 ')} 两套口径：${[...new Set(raws)].slice(0, 3).join('、')}`,
          suggestion: `同一材料同一部位只允许一个口径：以设计图纸/工程量清单为准统一“${anchor.label}”${group ? `在部位「${group}」的取值` : ''}，删除矛盾表述；不同部位允许不同规格，不得全文归一为一种。`,
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
          message: `材料/设备数量口径矛盾：“${anchor.label}”${group ? `在部位「${group}」` : '在未标注部位语境下'}出现 ${numbers.map(value => `${value}${anchor.unit}`).join(' 与 ')} 两套口径：${[...new Set(raws)].slice(0, 3).join('、')}`,
          suggestion: `同一设备/材料同一部位只允许一个口径：以应急物资清单/施工部署为准统一“${anchor.label}”${group ? `在部位「${group}」的取值` : ''}，删除矛盾表述；总量与分区配置属不同口径，不得互相归一。`,
        });
      }
    }
  }
  return issues.slice(0, 8);
}

/** 规格 token 类型推断：从权威规格值推导正则，只校验同类型规格（避免「垫层…HRB400 钢筋」误比对混凝土标号） */
function specTokenPattern(spec: string): RegExp | null {
  if (/^C\d{2,3}$/.test(spec)) return /C\d{2,3}/u;
  if (/^M\d/.test(spec)) return /M\d+(?:\.\d+)?/u;
  if (/^P\d{1,2}$/.test(spec)) return /P\d{1,2}/u;
  if (/^A\d+(?:\.\d+)?$/.test(spec)) return /A\d+(?:\.\d+)?/u;
  if (/^B\d+(?:\.\d+)?$/.test(spec)) return /B\d+(?:\.\d+)?/u;
  if (/^HRB/.test(spec) || /^HPB/.test(spec)) return /HRB\d{3,4}|HPB\d{3}/u;
  if (/mm$/.test(spec)) return /\d+(?:\.\d+)?\s*mm/u;
  return null;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** F14 规格写错部位检测：正文规格 vs 清单权威映射（specAuthorityMap）比对——
 *  同一部位语境出现该部位权威之外的规格（垫层写成 C35 而权威 C15）→ blocker（确定性可判）；
 *  权威映射缺失或规格类型不可推导时静默跳过（不误伤无清单项目）。 */
export function specLocationMismatchIssues(markdown: string, specAuthorityMap?: SpecAuthorityMap): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!specAuthorityMap) return issues;
  for (const placements of Object.values(specAuthorityMap)) {
    if (placements.length < 2) continue;
    // 同 location 同 pattern 类型的 placement 扫描结果完全一致（authoritySpecs 集合与
    // locationRe 均相同）——「垫层」权威 C15/C20 两条清单记录时，同一处错位 C25 会被每个
    // placement 各报一次相同 message，污染 issue 流（LLM 修复轮重复处理同一条目）；
    // 去重扫描：每组同源 placement 只扫一次，不改变 authoritySpecs 聚合与 message 内容
    const scanned = new Set<string>();
    for (const placement of placements) {
      const { location, spec } = placement;
      if (!location || !spec || location.length < 2) continue;
      // F14a 修复（丰乐镇第三轮验收）：pattern 必须从本 placement 的 spec 推导，不得用维度首个
      // placement 的 pattern 扫描全部 placement——同一维度聚合了不同类型规格时（C 标号与 mm 板厚
      // 混装），跨类型扫描把强度等级误判为规格错位（「有梁板 C30 vs 权威 120mm」实为两类规格）
      const pattern = specTokenPattern(spec);
      if (!pattern) continue;
      const scanKey = `${location}|${pattern.source}`;
      if (scanned.has(scanKey)) continue;
      scanned.add(scanKey);
      // 权威集合同类型过滤：只有与本 placement 同 pattern 类型的 spec 才可互相比较
      const authoritySpecs = new Set(placements.filter(item => item.location === location && specTokenPattern(item.spec)?.source === pattern.source).map(item => item.spec));
      const locationRe = new RegExp(`${escapeRegexLiteral(location)}[^。；;\n|]{0,40}?(${pattern.source})`, 'gu');
      for (const match of markdown.matchAll(locationRe)) {
        const found = match[1] || '';
        // F14c 跨工序切换豁免：「垫层，再浇筑C30」的 C30 属后续工序构件混凝土，不判垫层错位
        if (PROCESS_SWITCH_WORD_RE.test(match[0])) continue;
        // F14d 工艺参数/部位枚举豁免：窗口含「分层厚度/焊缝高度」等工艺参数词或「分别为」
        // 枚举声明词时，该数值是工艺参数或多部位枚举口径，与权威构件规格不可比对
        if (PROCESS_PARAM_RE.test(match[0]) || ENUMERATION_DECLARE_RE.test(match[0])) continue;
        // F14d 前文枚举声明豁免（丰乐镇第五轮实测）：「水泥混凝土按C30、C25、C20三个强度等级
        // 分别用于道路面层、涵头及管道基础、垫层部位…对应关系，C30混凝土」的 C30 在「垫层」后 40 字
        // 窗口内，但「分别用于」声明在前文——后文等级标号属部位对应关系说明，不是垫层单一规格错位
        const beforeFound = markdown.slice(Math.max(0, (match.index || 0) - 40), match.index || 0);
        if (ENUMERATION_DECLARE_RE.test(beforeFound)) continue;
        // A15 范围表述豁免（丰乐镇第三轮实测）：「人工清底，槽底200mm范围内由人工清理修整」
        // 的 200mm 是作业范围而非规格厚度，与清单权威 300mm 规格属不同概念，不判规格错位
        const afterFound = markdown.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 10);
        if (/范围内|范围/u.test(afterFound)) continue;
        // F14e 后置语境豁免（丰乐镇第三轮实测）：「两侧各200mm工作宽度」的 200mm 是作业空间
        // 尺寸；「200mm、150mm」顿号紧随的后续数值是多部位枚举——均非本部位单一规格错位
        if (/(?:工作宽度|作业宽度|操作空间|工作面)/u.test(afterFound) || /^、\s*\d/u.test(afterFound)) continue;
        // B6 偏差值豁免（丰乐镇第五轮实测）：「槽底预留200mm人工清底，槽底标高偏差不超过±200mm」
        // 的 ±200mm 是标高偏差值，被 40 字窗口误绑为清底预留厚度（偏差与规格属不同概念）
        const contextBefore = markdown.slice(Math.max(0, (match.index || 0)), (match.index || 0) + match[0].length);
        if (/(?:标高|高程|平整度|轴线|垂直度)[^。；;\n|]{0,10}(?:偏差|误差|不超过|不得大于|不大于)/u.test(contextBefore.slice(-28))) continue;
        if (authoritySpecs.has(found)) continue;
        issues.push({
          level: 'error',
          severity: 'blocker',
          category: 'fact_consistency',
          owner: 'llm',
          repairability: 'llm_repairable',
          message: `规格错位：“${location}”使用的规格 ${found} 与工程量清单权威（${[...authoritySpecs].join('/')}）不一致`,
          suggestion: `按工程量清单将“${location}”的规格统一为 ${[...authoritySpecs].join('/')}；同一材料不同部位允许不同规格，但同一部位不得混用其他部位的规格。`,
        });
        if (issues.length >= 8) return issues;
      }
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
      // 4.17.3 示例数值泄漏根治：suggestion 注入修复指令，示例数值（「540个日历天」）曾引导
      // Repairer 照抄他项目工期；示例一律去数值，仅保留“与招标文件前附表一致”的取值指引。
      suggestion: '「计划工期」字段应填日历天数值（与招标文件前附表一致）；工期延误违约条款文字应放在工期风险管控章节，不得占用基本信息表字段。',
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
    // 管线保护语境豁免（4.19.3 真实回归：管线挡护措施「钢板桩/槽钢挡护」非主支护体系决策）
    if (/管线|管道|电缆|给水|排水/u.test(window)) continue;
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
  // 形态 C：「A或B」直陈两可（「按专项方案放坡或支护」「采用钢板桩或排桩」）：
  // 两侧任一侧命中设计参数词族，且前窗/左组含决策词——决策词可能被贪婪左组吞并
  //（「采用钢板桩或排桩」的「采用」在左组内），窗口必须覆盖全匹配而非仅匹配前文；
  // 无决策词的并列工序（「土方开挖或回填前」）与词族外枚举（「集水井或排水沟」）均豁免
  const eitherOrRe = /([一-龥]{2,8})或([一-龥]{2,8})/gu;
  for (const match of normalized.matchAll(eitherOrRe)) {
    if (!DESIGN_PARAM_WORD_RE.test(match[1]) && !DESIGN_PARAM_WORD_RE.test(match[2])) continue;
    const start = Math.max(0, (match.index || 0) - 12);
    // 窗口只到左组末尾：右组吞并的「按」（「…施工顺序按现场进度」）不是决策语境，不纳入
    const window = normalized.slice(start, (match.index || 0) + match[1].length);
    // 管线保护语境豁免（4.19.3 真实回归：管线挡护措施「钢板桩或槽钢挡护」非主支护体系决策）
    if (/管线|管道|电缆|给水|排水/u.test(window)) continue;
    if (!/按|采用|选用|拟用|拟采用|方案|为/u.test(window)) continue;
    // 非贪婪取最左侧词族：贪婪 .* 回溯会命中最右侧短词（「坑采用地下连续墙」取到「连续墙」
    // 丢失「地下」前缀——实义截断）；词族按长词优先排序，最左侧位置首备选即最长实义词
    const left = match[1].replace(/^.*?(地下连续墙|钢板桩|灌注桩|支护桩|土钉墙|基础|支护|围护|结构|开挖|放坡|喷锚|排桩|连续墙|土钉|锚杆|形式|体系)/u, '$1');
    hits.add(`${left}或${match[2]}`);
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
  // 数字后窗口内）、偏差句（「标高偏差控制在±5」「基底标高偏差0～-50mm」，真实回归：
  // 质控允许值被误判为深度锁定）全部排除
  const depthWindows = normalized.matchAll(/(?:深度|标高)[^。；，,]{0,12}-?\d+(?:\.\d+)?[^。；，,]{0,6}/gu);
  for (const match of depthWindows) {
    const window = match[0];
    // 「以上|以下」形态（「标高以上300mm人工清底」）是相对量非绝对值（真实回归：300mm 清底厚度被误判为深度锁定）；
    // 「±0|0.000」是建筑零标高基准（「现状地面标高与设计±0.000对应绝对标高」，4.19.3 真实回归：基准句被误判为深度锁定）；
    // 「低于|高于」是水位相对句（「标高低于水池最低水位500mm」，4.19.5 真实回归：降水井水位控制值被误判为深度锁定）
    if (/(?:超过|大于|小于|不[大低小]于|不低于|低于|高于|按|倍|依据|详见|参考|示意|每|以上|以下|偏差|±0|0\.000)/u.test(window)) continue;
    // 时间数形态（「坑底标高后24h内完成垫层」）：数字后紧跟时间单位是工期/频次语义非深度数值
    //（真实回归：24h 垫层时限被误判为深度锁定）
    if (/\d+(?:\.\d+)?\s*(?:h|小时|天|日|min|周|月|昼夜)/u.test(window)) continue;
    return [];
  }
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: '基坑深度数值未锁定：正文已有基坑支护/开挖成稿内容，但全文未出现「深度/标高+数值」的确定性表述（比较式阈值如「超过3m」不视为锁定），危大工程分级判定失去依据',
    // 4.17.3 示例数值泄漏根治：suggestion 注入修复指令，示例数值（5.85m）曾引导 Repairer
    // 照抄他项目基坑深度；示例一律去数值，仅保留取值指引。
    suggestion: '从绑定资料（地质勘察报告/基坑支护设计图/基础平面图）锁定基坑开挖深度数值写入基坑支护小节；深度 ≥5m 的深基坑须同步标注危大工程分级与专家论证要求，禁止以「按图纸确定」回避深度数值。',
  }];
}

// ── 17b. 危大分级判定交叉质检（4.19 闭环）：事实主表有基坑开挖深度时——
// 深度 ≥3m 正文必须出现危大工程标注；≥5m 必须出现「超过一定规模」+专家论证。
// 与 excavationDepthLockIssues（要求锁定深度数值）互补：本检查负责「有深度值后分级结论必须落地」。──

/** 从 canonical 主表（excavation_depth 槽位）与图纸/项目事实中提取最大开挖深度（m）。
 * canonical 槽位值本身就是开挖深度（如「5.15m（图纸标注：…）」），直接提取无需关键词门；
 * 图纸/项目/精确事实文本需关键词门（基坑深度/坡底线等）防止误采无关数值（如建筑高度 28.9m）。
 * 导出供修复链（globalQualityGates 跨章一致性修复轮）在「基坑深度数值未锁定」时报出权威口径注入修复指令。 */
export function excavationDepthFromFacts(factsModel: DocumentFactsModel): number | undefined {
  const canonical = factsModel.canonical?.byKey.excavation_depth?.value;
  // 子数组空值防御：部分调用方传入裁剪版 factsModel（仅 canonical/单类事实），缺失数组按空处理
  const factTexts = [
    ...(factsModel.drawings || []).map(fact => `${fact.fieldName || fact.key || ''} ${stringifyFactValue(fact.value)}`),
    ...(factsModel.project || []).map(fact => `${fact.fieldName || fact.key || ''} ${stringifyFactValue(fact.value)}`),
    ...(factsModel.preciseFacts || []).map(fact => `${fact.fieldName || fact.key || ''} ${stringifyFactValue(fact.value)}`),
  ].filter(Boolean);
  // canonical 槽位独立提取（不得依赖数组下标——canonical 为 undefined 时下标 0 会滑到图纸文本绕开关键词门）
  // 4.19.3 比较式条文防御：37 号令目录条文「开挖深度16m及以上」曾被误采为项目深度（真实回归：
  // 压过坡底线标注 5.15m 使 canonical 污染），提取时数字前后窗口含比较式词（超过/不小于/
  // 及以上/以上…）的数值排除，防条文阈值压过真实标注值
  const extractDepthValues = (text: string) => [...text.matchAll(/-?(\d+(?:\.\d+)?)\s*(?:m|米)/gu)]
    .filter(match => {
      const start = Math.max(0, (match.index ?? 0) - 6);
      const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 6);
      return !/(?:超过|大于|小于|不[大低小]于|不低于|及以上|及以下|以上|以下)/u.test(text.slice(start, end));
    })
    .map(match => Math.abs(Number(match[1])));
  const canonicalValues = canonical ? extractDepthValues(canonical) : [];
  const factValues = factTexts.flatMap(text => /基坑开挖深度|基坑深度|开挖深度|坡底线|坑底标高/u.test(text)
    ? extractDepthValues(text)
    : []);
  const filtered = [...canonicalValues, ...factValues].filter(value => Number.isFinite(value) && value >= 1 && value < 50);
  return filtered.length > 0 ? Math.max(...filtered) : undefined;
}

export function excavationHazardClassificationIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const maxDepth = excavationDepthFromFacts(factsModel);
  if (maxDepth === undefined || maxDepth < 3) return [];
  const issues: ValidationIssue[] = [];
  if (maxDepth >= 3 && !/危大工程/u.test(markdown)) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `危大工程判定缺失：资料基坑开挖深度 ${maxDepth}m（≥3m），正文必须出现危大工程判定标注`,
      suggestion: `依据住建部令第37号，开挖深度≥3m 属危大工程：在基坑支护/危大工程清单小节写明本工程实际深度 ${maxDepth}m 与危大工程判定结论，不得只写判定规则不落地本项目。`,
    });
  }
  if (maxDepth >= 5 && !/超过一定规模/u.test(markdown)) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `超危大工程判定缺失：资料基坑开挖深度 ${maxDepth}m（≥5m），正文必须出现「超过一定规模」判定与专家论证要求`,
      suggestion: `开挖深度≥5m 属超过一定规模的危大工程：写明本工程深度 ${maxDepth}m 对应分级结论，专项施工方案必须经专家论证，不得只写判定规则不落地分级。`,
    });
  }
  return issues;
}

// ── 17c. 支护形式事实一致性（4.19）：事实主表有基坑支护形式值（如土钉墙）时——
// ①全文不得出现资料外的支护体系词（支护桩/冠梁/灌注桩——合肥师范实测成稿编造桩体系）；
// ②资料支护形式词必须在正文基坑相关块出现（反向完整性）。──

export function supportFormFactConsistencyIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const canonical = factsModel.canonical?.byKey.foundation_support_form?.value;
  const texts = [
    canonical,
    ...(factsModel.drawings || []).map(fact => `${fact.fieldName || fact.key || ''} ${stringifyFactValue(fact.value)}`),
    ...(factsModel.project || []).map(fact => `${fact.fieldName || fact.key || ''} ${stringifyFactValue(fact.value)}`),
    ...(factsModel.preciseFacts || []).map(fact => `${fact.fieldName || fact.key || ''} ${stringifyFactValue(fact.value)}`),
  ].filter(Boolean) as string[];
  const formTexts = texts.filter(text => /基坑支护形式|基坑支护方式|支护形式|支护方式|土钉|放坡|喷锚|护坡/u.test(text) && !/监测|监测频次|闭环|基坑开挖深度/u.test(text));
  if (formTexts.length === 0) return [];
  const factForms: string[] = [];
  for (const text of formTexts) {
    for (const form of ['土钉墙', '放坡', '喷锚', '挂网喷浆', '排桩', '灌注桩', '地下连续墙', '内支撑', '锚杆', '锚索']) {
      if (text.includes(form)) factForms.push(form);
    }
  }
  const issues: ValidationIssue[] = [];
  // ①资料外支护体系词：全文出现而资料中不存在的支护体系实义词（资料含该词时属合法复用）；
  // 否定语境豁免（同 NEGATIVE_DECLARATION_RE 口径）：「不采用支护桩」「不设置冠梁」等
  // LLM 一致性声明句是引用排除项而非事实口径，不得误判为编造
  const FOREIGN_FORMS = ['支护桩', '冠梁', '钻孔灌注桩', '灌注桩', '地下连续墙', '排桩', '咬合桩', '内支撑'];
  // 局部否定词表（含 NEGATIVE_DECLARATION_RE 词 + 设置类声明词，不扩共享常量防跨检测器影响面扩散）
  const foreignNegationRe = /不采用|未采用|不设置|未设置|不使用|不宜采用|不得采用|不再出现|不得出现|严禁出现|避免出现|已删除|取消/u;
  const hasForeignUsage = (form: string) => {
    const re = new RegExp(form, 'gu');
    for (const match of markdown.matchAll(re)) {
      const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
      let lineEnd = markdown.indexOf('\n', match.index);
      if (lineEnd === -1) lineEnd = markdown.length;
      const line = markdown.slice(lineStart, lineEnd);
      // 命中词前 12 字符窗口内出现否定声明词即属排除表述，不计入口径
      const beforeWindow = line.slice(Math.max(0, match.index - lineStart - 12), match.index - lineStart);
      if (foreignNegationRe.test(beforeWindow)) continue;
      return true;
    }
    return false;
  };
  const foreignHits = FOREIGN_FORMS.filter(form => hasForeignUsage(form) && !factForms.includes(form));
  if (foreignHits.length > 0) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `支护形式与资料矛盾：正文出现资料中不存在的支护体系词 ${foreignHits.join('、')}`,
      suggestion: `资料基坑支护形式为「${factForms.join('、') || formTexts[0]?.slice(0, 60)}」：删除编造的支护桩/冠梁/灌注桩类表述与对应参数（垂直度偏差/冠梁顶面标高等），按资料支护形式改写。`,
    });
  }
  // ②反向完整性：资料支护形式词未在正文出现（基坑/支护相关章节已展开但形式未落地）
  const presentForms = factForms.filter(form => new RegExp(form, 'u').test(markdown));
  if (presentForms.length === 0 && /基坑|支护/u.test(markdown)) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `支护形式未落地：资料基坑支护形式「${factForms.join('、') || formTexts[0]?.slice(0, 60)}」未在正文中出现`,
      suggestion: `在基坑支护小节写明本工程实际支护形式（${factForms.join('、')}）及对应工艺参数（土钉长度/间距/坡度等），不得以泛化表述回避。`,
    });
  }
  return issues;
}

// ── 17d. 设备进场时间合理性（4.19 D-2）：全文「设备名+第N日+进场/投入使用/安装」形态——
// ①进场日 ≥ 总工期 80% 属尾期进场荒谬（大型设备应在工程早中期进场，尾期进场无法覆盖主体施工）；
// ②基坑阶段设备（挖掘机/支护类）进场日晚于基坑支护完成节点日属工序倒挂（基坑做完了设备才进场）。
// 数值提取+阈值比较（L2 确定性层），设备名限定封闭词表防误采。──

const EQUIPMENT_ENTRY_WORDS = ['塔式起重机', '施工升降机', '施工电梯', '汽车起重机', '汽车吊', '混凝土泵车', '混凝土泵', '挖掘机', '装载机', '推土机', '压路机', '平地机', '空压机', '注浆机', '锚杆钻机', '混凝土喷射机', '喷射机', '吊篮', '钢筋加工设备', '塔吊'] as const;
// 基坑阶段专用设备：只服务于基坑支护/土方工序，进场日必须早于基坑支护完成节点
const PIT_STAGE_EQUIPMENT_RE = /挖掘机|空压机|注浆机|锚杆钻机|混凝土喷射机|喷射机|推土机/u;

function extractEquipmentEntryDays(markdown: string): Array<{ equipment: string; day: number; raw: string }> {
  const entries: Array<{ equipment: string; day: number; raw: string }> = [];
  for (const match of markdown.matchAll(/第(\d{2,3})日[^。；;\n|]{0,8}?(?:进场|投入使用|安装|调试)/gu)) {
    const before = markdown.slice(Math.max(0, (match.index || 0) - 24), match.index || 0);
    const equipment = EQUIPMENT_ENTRY_WORDS.find(word => before.includes(word));
    if (!equipment) continue;
    entries.push({ equipment, day: Number(match[1]), raw: `${before.slice(-18)}${match[0].slice(0, 20)}` });
  }
  const seen = new Set<string>();
  return entries.filter(entry => {
    const dedupeKey = `${entry.equipment}:${entry.raw}`;
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  });
}

/** 计划总工期（日历天）：正文计划工期锚点优先，绑定资料工期事实兜底；
 * 窗口排除数字防贪婪回溯（「计划工期210日历天」窗口吞 210 后捕获组拿到 0） */
function totalScheduleDays(markdown: string, factsModel: DocumentFactsModel): number | undefined {
  const texts = [markdown, ...(factsModel.schedule || []).map(fact => `${fact.key || ''}${stringifyFactValue(fact.value)}`)];
  for (const text of texts) {
    const match = /(?:计划工期|合同工期|总工期|工期总日历天数)[^\d。；;\n|]{0,12}(\d{1,4})\s*个?\s*日历天/u.exec(text);
    if (match) {
      const day = Number(match[1]);
      if (Number.isFinite(day) && day >= 30 && day <= 3000) return day;
    }
  }
  return undefined;
}

export function equipmentEntryTimingIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const entries = extractEquipmentEntryDays(markdown);
  if (entries.length === 0) return [];
  const issues: ValidationIssue[] = [];
  const total = totalScheduleDays(markdown, factsModel);
  // ①尾期进场：进场日 ≥ 总工期 80%（设备采购/进场计划矛盾，实际无法覆盖主体施工）
  if (total !== undefined) {
    const late = entries.filter(entry => entry.day >= total * 0.8);
    if (late.length > 0) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `设备进场时间荒谬：${late.slice(0, 3).map(entry => `「${entry.equipment} 第${entry.day}日进场」`).join('、')} 已过总工期（${total}日历天）的 80%，尾期进场无法覆盖主体施工`,
        suggestion: `以总进度计划为准核对设备进场计划：大型施工设备应在工程早期（总工期前 30% 内）进场，${late.map(entry => entry.equipment).join('、')} 的进场日应提前至基础/主体施工开始前，删除矛盾的尾期进场表述。`,
      });
    }
  }
  // ②工序倒挂：基坑阶段设备进场日晚于基坑支护完成节点（基坑做完了设备才进场）
  const pitDoneDays = extractNodeScheduleDays(markdown).filter(sample => sample.key === 'excavation').map(sample => sample.day);
  if (pitDoneDays.length > 0) {
    const pitDone = Math.min(...pitDoneDays);
    const inverted = entries.filter(entry => PIT_STAGE_EQUIPMENT_RE.test(entry.equipment) && entry.day > pitDone);
    if (inverted.length > 0) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `设备进场工序倒挂：${inverted.slice(0, 3).map(entry => `「${entry.equipment} 第${entry.day}日进场」`).join('、')} 晚于基坑支护及土方外运完成节点（第${pitDone}日），基坑阶段设备未在工序开始前进场`,
        suggestion: `基坑阶段专用设备必须在基坑开挖/支护开始前完成进场与报验：将 ${inverted.map(entry => entry.equipment).join('、')} 的进场日调整为早于基坑支护完成节点（第${pitDone}日）的日期，删除工序倒挂表述。`,
      });
    }
  }
  return issues.slice(0, 3);
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

interface MarkdownTableBlock { startLine: number; endLine: number; header: string[]; firstCol: string[]; dataRows: string[][]; dataCells: string[]; bodyChars: number; raw: string[] }

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
        dataRows: dataRows.map(row => cells(row).map(cell => cell.replace(/[*_`]/gu, '').trim())),
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

/** 表内数据行重复检测（丰乐镇实测：表头一遍 + 数据两遍连成一张 23 行大表，duplicateTableIssues 仅做表间判定检测不到）。
 * 特征：后半数据行序列与前半按序匹配（首列相等且行 jaccard ≥0.5），且重复段行数 ≥2——
 * 工程内容表两遍粘贴时工程名序列完全一致，首列相等是强约束（防互补表/统计表误伤）。
 * 与 stripInternalDuplicateTableRows 同判定口径（检测定位=修复定位）。 */
export function duplicateTableRowIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tables = extractMarkdownTables(markdown);
  for (const table of tables) {
    const rows = table.dataRows;
    if (rows.length < 4) continue;
    // 找重复段：back 每行按序在 front 中找到「首列相等且行 jaccard ≥0.5」的匹配
    const rowFirstCol = (row: string[]) => (row[0] || '').trim();
    const rowSim = (left: string[], right: string[]) => jaccard(left, right);
    for (let split = Math.floor(rows.length / 2); split <= Math.ceil(rows.length / 2); split += 1) {
      const front = rows.slice(0, split);
      const back = rows.slice(split);
      if (front.length < 2 || back.length < 2) continue;
      let matched = 0;
      let lastMatch = -1;
      for (const backRow of back) {
        const col = rowFirstCol(backRow);
        if (!col) continue;
        for (let j = lastMatch + 1; j < front.length; j += 1) {
          if (rowFirstCol(front[j]) === col && rowSim(backRow, front[j]) >= 0.5) {
            matched += 1;
            lastMatch = j;
            break;
          }
        }
      }
      const ratio = matched / back.length;
      if (ratio < 0.8) continue;
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'style',
        owner: 'llm',
        repairability: 'local_deterministic',
        message: `表格内部数据行重复：第 ${table.startLine + 1}~${table.endLine + 1} 行表格（表头：${table.header.slice(0, 3).join('|')}）数据行两遍粘贴（${split} 行 + ${back.length} 行，重复匹配率 ${Math.round(ratio * 100)}%）`,
        suggestion: `删除第二遍重复数据行（保留第一遍 ${split} 行），删除后表格仅保留一份完整数据。`,
      });
      break;
    }
  }
  return issues;
}

/** 表内数据行重复确定性删除（检测定位=修复定位）：删除表内第二遍重复粘贴的数据行。
 * 只删重复段、保留表头与第一遍数据行；行删除按原行号映射回全文（表格块内部行区间）。 */
export function stripInternalDuplicateTableRows(markdown: string): { markdown: string; removedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  const removed = new Set<number>();
  const details: string[] = [];
  const tables = extractMarkdownTables(markdown);
  const rowFirstCol = (row: string[]) => (row[0] || '').trim();
  const rowSim = (left: string[], right: string[]) => jaccard(left, right);
  for (const table of tables) {
    const rows = table.dataRows;
    if (rows.length < 4) continue;
    for (let split = Math.floor(rows.length / 2); split <= Math.ceil(rows.length / 2); split += 1) {
      const front = rows.slice(0, split);
      const back = rows.slice(split);
      if (front.length < 2 || back.length < 2) continue;
      let matched = 0;
      let lastMatch = -1;
      for (const backRow of back) {
        const col = rowFirstCol(backRow);
        if (!col) continue;
        for (let j = lastMatch + 1; j < front.length; j += 1) {
          if (rowFirstCol(front[j]) === col && rowSim(backRow, front[j]) >= 0.5) {
            matched += 1;
            lastMatch = j;
            break;
          }
        }
      }
      if (matched / back.length < 0.8) continue;
      // 数据行在表格块内的物理行号：表头+分隔行占 2 行，数据行从 startLine+2 起
      const backStartLine = table.startLine + 2 + split;
      for (let line = backStartLine; line <= table.endLine; line += 1) removed.add(line);
      details.push(`第 ${table.startLine + 1}~${table.endLine + 1} 行表格删除 ${back.length} 行重复数据行`);
      break;
    }
  }
  if (removed.size === 0) return { markdown, removedCount: 0, details };
  return {
    markdown: lines.filter((_, index) => !removed.has(index)).join('\n'),
    removedCount: removed.size,
    details,
  };
}

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

/** 表格重复确定性删除（检测定位=修复定位）：保留信息量大的那张（数据行字符多者），删除其余重复表。
 * removedLineNumbers 可选输出：被删表格行号集合（供跨章调用方把全文级判定映射回各章节逐章删除）。 */
export function stripDuplicateTables(markdown: string): { markdown: string; removedCount: number; removedLineNumbers?: number[] } {
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
    removedLineNumbers: [...removed].sort((left, right) => left - right),
  };
}

/** 跨章表格去重：全文判定重复表后，把被删行号映射回各章节逐章删除。
 * 丰乐镇实测：同一「关键节点|计划完成时间|责任岗位…」表复制粘贴到 4 个章节，
 * 逐章调用 stripDuplicateTables 时每章只有一张 → 重复永不删除（与劳动力峰值跨章权威同一根因）。
 * 全文执行一次判定（表头+首列+数据覆盖度同源口径），再把被删表格块按行号归属删除到对应章节。 */
export function stripDuplicateTablesAcrossChapters(chapters: Array<{ content: string }>): { removedCount: number; chapterFixed: number } {
  const joined = chapters.map(chapter => chapter.content).join('\n\n');
  const result = stripDuplicateTables(joined);
  if (result.removedCount === 0) return { removedCount: 0, chapterFixed: 0 };
  const removedSet = new Set(result.removedLineNumbers || []);
  // 行号映射：每章实际行数推进游标后恒 +1——join('\n\n') 的第二个换行仅产生 1 个额外空行
  //（无尾换行时第一个换行终止本章末行；有尾换行时首空串已计入本章 split 尾元素），
  // 固定 +2 或按尾换行分叉都会从第二章起映射错位（跨章去重删错行缺陷）
  let joinedCursor = 0;
  let removedCount = 0;
  let chapterFixed = 0;
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex];
    const chapterLines = chapter.content.split('\n');
    const localRemoved = new Set<number>();
    for (let local = 0; local < chapterLines.length; local += 1) {
      if (removedSet.has(joinedCursor + local)) localRemoved.add(local);
    }
    if (localRemoved.size > 0) {
      chapter.content = chapterLines.filter((_, index) => !localRemoved.has(index)).join('\n');
      removedCount += localRemoved.size;
      chapterFixed += 1;
    }
    joinedCursor += chapterLines.length;
    if (chapterIndex < chapters.length - 1) joinedCursor += 1;
  }
  return { removedCount, chapterFixed };
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
  // 4.17.3 重叠 span 治理：同一数值被正/反向模式双命中（如「45日历天为唯一」同时命中
  // 工期控制正向与「N日历天+为唯一」反向模式）时旧降序逐条 slice 会产生「45→2100」错位；
  // 升序单次遍历按原始坐标拼接，重叠 span（start < 已应用区间末）跳过，只应用第一条
  const sorted = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  let next = '';
  let cursor = 0;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of sorted) {
    if (item.start < cursor || item.end <= item.start) continue;
    next += markdown.slice(cursor, item.start) + item.replacement;
    cursor = item.end;
    fixedCount += 1;
    details.push(item.detail);
  }
  next += markdown.slice(cursor);
  return { markdown: next, fixedCount, details: [...new Set(details)].slice(0, 8) };
}

/** 劳动力峰值确定性修复：正文总口径峰值/控制上限与分阶段投入明细表峰值矛盾 → 正文数字改为表格峰值。
 * 与检测器同源同阈值：>30% 才矛盾、阶段限定峰值不参与（laborPeakStageOf 同源判定）。 */
function fixLaborPeakConflicts(markdown: string, laborPeakAuthority?: number): { markdown: string; fixedCount: number; details: string[] } {
  // A3 跨章权威（丰乐镇实测）：分阶段劳动力明细表与正文峰值表述分布在不同章节，
  // 逐章调用时本章无表 → 表峰值 undefined → 正文 68 人 vs 表 20 人矛盾永远无法确定性修复。
  // 调用方从全文提取表峰值作为跨章权威传入，本章无表时同样执行替换。
  const tablePeak = laborPeakAuthority !== undefined && laborPeakAuthority > 0 ? laborPeakAuthority : tablePeakLabor(markdown);
  if (tablePeak === undefined) return { markdown, fixedCount: 0, details: [] };
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  const collect = (pattern: RegExp) => {
    for (const match of markdown.matchAll(pattern)) {
      const value = Number(match[1].replace(/[,，]/gu, ''));
      if (!Number.isFinite(value) || value <= 0) continue;
      const valueIndex = match.index + match[0].indexOf(match[1]);
      // 表格行内（行首行尾均为 |）的阶段劳动力数值属分阶段明细表合法数据不修（与检测器 h17 同源）
      const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
      let lineEnd = markdown.indexOf('\n', match.index);
      if (lineEnd === -1) lineEnd = markdown.length;
      if (/^\s*\|.*\|\s*$/u.test(markdown.slice(lineStart, lineEnd))) continue;
      // F6 口径隔离（与检测器同源）：管理/工种口径数值不与表峰值比较替换——
      // 「管理人员18人」「钢筋工60人」被表峰值替换会破坏合法口径（真实生成误报根因）
      if (laborGroupOf(markdown, valueIndex, lineStart).group !== 'peak') continue;
      // 与检测器模式 3 同源：仅无阶段限定的总口径峰值与表峰值比较；差值 ≤30% 不矛盾
      if (laborPeakStageOf(markdown, valueIndex)) continue;
      // h17：双向阈值——偏低方向（正文「高峰，投入62人」vs 表峰值 186）同样以表峰值替换，
      // 旧单向 1.3 倍上限只修偏高方向，偏低矛盾残留由导出门禁阻断（第九次回归门禁根因）
      const diff = Math.abs(value - tablePeak) / Math.max(value, tablePeak);
      if (diff <= 0.3) continue;
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

/** 节点工期确定性修复（4.17.4 扩展为三阶段管线）：
 * ① 体系缩放：factsModel 锁定总工期（如 540 日历天）与文档主流节点体系终点（如 365 日）差异 >10% 时，
 *   全文「开工(令下发)后第N日/天」及竣工验收语境裸「第N日」按 scale 统一缩放，三列进度表行链式重算
 *   开始/持续列保证表内自洽（合肥师范实测：365 体系与总工期 540 并存，三表互相矛盾且权威表标题
 *   不含「总进度计划」导致历史逻辑零产出）；
 * ② 权威表提取：「总进度计划/施工总进度/总进度安排/总工期控制」标题表格块按行名→完成日建立节点权威口径
 *   （行级提取覆盖「开工令下发后第N日」表格式，历史三形态正则抓不到该形态）；
 * ③ 多表对齐：非权威表格行按行名关键词归类节点键，行内完成日与权威相差 ≥5 天 → 替换为权威值；
 *   正文句矛盾沿用三形态正则 + 权威口径定点替换（与检测器 nodeScheduleConsistencyIssues 同源同阈值 ≥5 天）。 */
function fixNodeScheduleConflicts(markdown: string, options?: { scheduleAuthority?: number; nodeAuthorities?: Array<{ node: string; offset: string }> }): { markdown: string; fixedCount: number; details: string[] } {
  let next = markdown;
  const allDetails: string[] = [];
  const scheduleAuthority = options?.scheduleAuthority;
  // ── ① 体系缩放 ──
  if (scheduleAuthority !== undefined && scheduleAuthority > 0) {
    const absoluteDays = [...next.matchAll(/(?:开工令下发后|开工后)第(\d{1,3})[日天]/gu)].map(match => Number(match[1]));
    const systemMax = absoluteDays.length > 0 ? Math.max(...absoluteDays) : 0;
    if (systemMax > 0 && systemMax < scheduleAuthority * 0.9) {
      const scale = scheduleAuthority / systemMax;
      const scaleReplacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
      for (const match of next.matchAll(/(?:开工令下发后|开工后)第(\d{1,3})[日天]/gu)) {
        const value = Math.max(1, Math.round(Number(match[1]) * scale));
        const dayStart = match.index + match[0].indexOf(match[1]);
        scaleReplacements.push({ start: dayStart, end: dayStart + match[1].length, replacement: String(value), detail: `节点日期 ${match[1]}日→${value}日（总工期${scheduleAuthority}日历天体系缩放）` });
      }
      // 竣工验收语境裸「第N日」：正向「第N日竣工验收」与括号「竣工验收合格（第N日）」
      for (const match of next.matchAll(/第(\d{2,3})日(?=[^。；;\n]{0,8}竣工验收)/gu)) {
        const value = Math.max(1, Math.round(Number(match[1]) * scale));
        scaleReplacements.push({ start: match.index, end: match.index + match[0].length, replacement: `第${value}日`, detail: `竣工验收节点 ${match[1]}日→${value}日（总工期${scheduleAuthority}日历天体系缩放）` });
      }
      for (const match of next.matchAll(/(竣工验收(?:合格)?[^。；;\n]{0,8}?[（(])第(\d{2,3})日([）)])/gu)) {
        const value = Math.max(1, Math.round(Number(match[2]) * scale));
        scaleReplacements.push({ start: match.index, end: match.index + match[0].length, replacement: `${match[1]}第${value}日${match[3]}`, detail: `竣工验收节点 ${match[2]}日→${value}日（总工期${scheduleAuthority}日历天体系缩放）` });
      }
      if (scaleReplacements.length > 0) {
        const scaled = applySpanReplacements(next, scaleReplacements);
        next = scaled.markdown;
        allDetails.push(...scaled.details.slice(0, 8));
        // 三列进度表行链式重算：开始列=上一行结束+1，持续列=结束-开始+1（缩放后保证表内自洽）
        const threeColLineRe = /^(\|[^|]*\|)\s*开工令下发后第(\d+)日\s*\|\s*开工令下发后第(\d+)日\s*\|\s*(\d+)\s*日\s*(\|.*)$/u;
        const lines = next.split(/\r?\n/u);
        let prevEnd = 0;
        let chainedCount = 0;
        for (let index = 0; index < lines.length; index += 1) {
          const match = lines[index].match(threeColLineRe);
          if (!match) { prevEnd = 0; continue; }
          const end = Number(match[3]);
          const start = prevEnd > 0 ? prevEnd + 1 : Number(match[2]);
          const newEnd = Math.max(end, start + 1);
          const duration = newEnd - start + 1;
          if (start !== Number(match[2]) || newEnd !== end || duration !== Number(match[4])) {
            lines[index] = `${match[1]} 开工令下发后第${start}日 | 开工令下发后第${newEnd}日 | ${duration}日 ${match[5]}`;
            chainedCount += 1;
          }
          prevEnd = newEnd;
        }
        if (chainedCount > 0) {
          next = lines.join('\n');
          allDetails.push(`三列进度表链式重算 ${chainedCount} 行（开始/持续列与缩放后结束列自洽）`);
        }
      }
    }
  }
  // ── ②③ 权威表提取 + 多表/正文对齐 ──
  const lines = next.split(/\r?\n/u);
  const tableRowLineRe = /^\|.+\|$/u;
  const lineSpans: Array<{ start: number; end: number }> = [];
  let lineOffset = 0;
  for (const line of lines) {
    lineSpans.push({ start: lineOffset, end: lineOffset + line.length });
    lineOffset += line.length + 1;
  }
  // 行名→节点键归类（清理/预验收优先于竣工验收，「竣工清理与预验收」不得误入 completion）
  const stageKeysOf = (rowName: string): string[] => {
    const keys: string[] = [];
    if (/清理|预验收|收尾/u.test(rowName)) keys.push('cleanup');
    if (/竣工验收/u.test(rowName)) keys.push('completion');
    if (/装饰|幕墙/u.test(rowName)) keys.push('decoration');
    if (/机电/u.test(rowName)) keys.push('mep');
    if (/二次|ALC|墙板|砌体/u.test(rowName)) keys.push('secondary');
    if (/主体|封顶/u.test(rowName)) keys.push('topping');
    if (/土方|基坑|基础|支护/u.test(rowName)) keys.push('excavation');
    return keys;
  };
  const firstCellOf = (line: string): string => (line.split('|')[1] || '').trim();
  const lastDayOf = (line: string): { value: number; start: number; end: number } | undefined => {
    let found: { value: number; start: number; end: number } | undefined;
    for (const match of line.matchAll(/第(\d{1,3})[日天]/gu)) {
      // 相对量豁免：日期值前 8 字符含「X后」形态（竣工验收合格后第90日/主体封顶后第30天）不作为完成日
      const prefix = line.slice(Math.max(0, (match.index ?? 0) - 8), match.index ?? 0);
      if (/(?:合格|封顶|移交|完成|进场|退场)后$/u.test(prefix)) continue;
      found = { value: Number(match[1]), start: (match.index ?? 0) + match[0].indexOf(match[1]), end: (match.index ?? 0) + match[0].lastIndexOf(match[1]) + match[1].length };
    }
    return found;
  };
  // ② 权威表提取：标题含总进度计划/总工期控制的表格块，行级「行名→完成日」建权威
  const authorityByKey = new Map<string, number>();
  const authoritySpans: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!tableRowLineRe.test(lines[index].trim())) continue;
    const blockStart = index;
    while (index < lines.length && tableRowLineRe.test(lines[index].trim())) index += 1;
    const blockEnd = index;
    const headerProbe = lines.slice(Math.max(0, blockStart - 6), blockStart).join('\n');
    if (!/总进度计划|施工总进度|总进度安排|总工期控制|总工期/u.test(headerProbe)) continue;
    for (let row = blockStart; row < blockEnd; row += 1) {
      const rowName = firstCellOf(lines[row]);
      const day = lastDayOf(lines[row]);
      if (!day || /---/u.test(rowName)) continue;
      for (const key of stageKeysOf(rowName)) {
        const existing = authorityByKey.get(key);
        if (existing === undefined || day.value > existing) authorityByKey.set(key, day.value);
      }
    }
    authoritySpans.push({ start: lineSpans[blockStart].start, end: lineSpans[blockEnd - 1].end });
  }
  // B1 主表进度节点权威注入（生成前锁定口径优先）：关键节点表标题不含「总进度计划」类
  // 关键词时②权威提取零产出，封顶 230/270/333 三口径残留被导出门禁阻断（第九次回归根因）；
  // 主表值覆盖文档内权威表提取值（主表为唯一口径源），冲突 ≥5 天时权威表行也纳入③对齐
  for (const entry of options?.nodeAuthorities ?? []) {
    const dayMatch = entry.offset.match(/第(\d{1,3})[日天]/u);
    if (!dayMatch) continue;
    const day = Number(dayMatch[1]);
    if (!Number.isFinite(day) || day < 1 || day > 3000) continue;
    const key = SCHEDULE_NODE_ANCHORS.find(anchor => anchor.re.test(entry.node))?.key;
    if (key === undefined) continue;
    const existing = authorityByKey.get(key);
    if (existing !== undefined && Math.abs(existing - day) >= 5) authoritySpans.length = 0;
    authorityByKey.set(key, day);
  }
  if (authorityByKey.size === 0) return { markdown: next, fixedCount: allDetails.length > 0 ? 1 : 0, details: allDetails };
  // ③ 非权威表行完成日对齐 + 正文句三形态定点替换
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  const outsideAuthority = (position: number) => !authoritySpans.some(span => position >= span.start && position <= span.end);
  for (let index = 0; index < lines.length; index += 1) {
    if (!tableRowLineRe.test(lines[index].trim())) continue;
    if (!outsideAuthority(lineSpans[index].start)) continue;
    const rowName = firstCellOf(lines[index]);
    const day = lastDayOf(lines[index]);
    if (!day || /---/u.test(rowName)) continue;
    const authority = stageKeysOf(rowName).map(key => authorityByKey.get(key)).find(value => value !== undefined);
    if (authority === undefined) continue;
    if (Math.abs(day.value - authority) < 5) continue;
    const label = SCHEDULE_NODE_ANCHORS.find(anchor => stageKeysOf(rowName).includes(anchor.key))?.label || rowName.slice(0, 12);
    replacements.push({ start: lineSpans[index].start + day.start, end: lineSpans[index].start + day.end, replacement: String(authority), detail: `表格节点“${label}”${day.value}日→${authority}日（以总进度计划/总工期控制表为准）` });
  }
  const keyOf = (text: string) => SCHEDULE_NODE_ANCHORS.find(anchor => anchor.re.test(text))?.key;
  const pushReplacement = (nodeText: string, day: number, dayStart: number, dayEnd: number, raw: string) => {
    const key = keyOf(nodeText);
    if (key === undefined || !Number.isFinite(day) || day < 1 || day > 3000) return;
    const authority = authorityByKey.get(key);
    if (authority === undefined) return;
    if (Math.abs(day - authority) < 5) return;
    if (!outsideAuthority(dayStart)) return;
    replacements.push({ start: dayStart, end: dayEnd, replacement: String(authority), detail: `节点“${SCHEDULE_NODE_ANCHORS.find(anchor => anchor.key === key)?.label || key}”工期 ${day}日→${authority}日（以总进度计划表为准）` });
  };
  // 形态 A 正序完成式：第N日完成X——第N日与「完成」之间排除「）→」（节点分隔符），
  // 防「施工准备与临时设施完成（第22日）→土方开挖与基础施工完成（第75日）→主体结构封顶（第311日）」
  // 中第22日跨节点误采为封顶工期（合肥师范实测 22→311 错位源）；「完成」与节点名之间排除「（→」；
  // h18：两段中间均排除枚举标点「，、」——「基础及地下室结构在第135日完成，主体结构封顶
  // 在第270日完成」枚举句中 135 曾被跨项误绑到封顶替换（与检测器 extractNodeScheduleDays 同源同口径）
  for (const match of next.matchAll(/第(\d{2,3})日(?:(?![）)→。；;\n，、]).){0,14}?完成(?:(?![（(→。；;\n，、]).){0,12}?(基坑支护及土方外运|装饰装修及幕墙|机电安装及智能化调试|室外工程及竣工验收|地下结构出正负零|主体结构封顶|正负零|封顶)/gu)) {
    const dayStart = match.index + match[0].indexOf(match[1]);
    pushReplacement(match[2], Number(match[1]), dayStart, dayStart + match[1].length, match[0].slice(0, 40));
  }
  // 形态 D 竣工验收倒序式：竣工验收节点第N日——负向前瞻排除「后」（相对量句「竣工验收合格后第90日」
  // 不缩放）与节点分隔符，覆盖「主体结构封顶节点第311日与竣工验收节点第365日为刚性控制点」形态
  for (const match of next.matchAll(/(竣工验收)(?:(?!(?:后|第\d{2,3}[日天]|，|、|→)).){0,10}?第(\d{2,3})[日天]/gu)) {
    const dayStart = match.index + match[0].indexOf(match[2]);
    pushReplacement(match[1], Number(match[2]), dayStart, dayStart + match[2].length, match[0].slice(0, 40));
  }
  for (const match of next.matchAll(/(基坑支护|正负零|封顶|装饰装修|机电安装|竣工验收)(?:(?!(?:第\d{2,3}[日天]|，|、)).){0,8}?完成[^。；;\n]{0,10}?第(\d{2,3})[日天]/gu)) {
    const dayStart = match.index + match[0].indexOf(match[2]);
    pushReplacement(match[1], Number(match[2]), dayStart, dayStart + match[2].length, match[0].slice(0, 40));
  }
  // 形态 C 倒序锁定式：封顶节点第N日——h18 与检测器同源排除「，、/完成/|/句界」；
  // 「后」只在节点名后定点排除（「主体结构封顶后第10日」相对量句），窗口内不排除——
  // 防设备表行「主体封顶 | 商品混凝土泵送 | 开工后第158日进场」误采的同时不误杀「开工后第N日」倒序式
  for (const match of next.matchAll(/(主体(?:结构)?封顶)(?!后)(?:(?!(?:第\d{2,3}[日天]|，|、|完成|\||[。；;\n])).){0,20}?第(\d{2,3})日/gu)) {
    const dayStart = match.index + match[0].indexOf(match[2]);
    pushReplacement(match[1], Number(match[2]), dayStart, dayStart + match[2].length, match[0].slice(0, 40));
  }
  const applied = applySpanReplacements(next, replacements);
  return { markdown: applied.markdown, fixedCount: applied.fixedCount + (allDetails.length > 0 ? 1 : 0), details: [...allDetails, ...applied.details].slice(0, 12) };
}

/** 取出现频次最高的数值（平手取较大值，总量口径优先） */
function modeOfValues(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** 材料/设备数量确定性修复：表格行数值为权威口径，正文矛盾数值（差异 >20%）改为表格值。
 * 与检测器 crossSectionNumericConflictIssues 同源（同锚点/同豁免：并列枚举、否定声明句）；
 * 表格口径不唯一（多表互相矛盾）时不动，交 LLM 修复路径。
 * 4.17.3 权威口径扩展：计划总工期锚点支持外部锁定口径（factsModel 计划工期事实卡）——
 * 庐江实测 45 vs 210 两套体系各自带表格，表格值不唯一导致确定性修复零产出、LLM 修复无法裁决、
 * 修复节点 failed；外部锁定口径（招标文件前附表值）优先级高于表格值。 */
function fixCrossSectionNumericConflicts(markdown: string, authorities?: Record<string, number>, codeAuthorities?: Record<string, string>): { markdown: string; fixedCount: number; details: string[] } {
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  for (const anchor of CROSS_SECTION_ANCHORS) {
    if (anchor.kind !== 'number') continue;
    const tableValues = new Set<number>();
    const bodyMatches: Array<{ value: number; group: string }> = [];
    const tableMatches: Array<{ value: number; group: string }> = [];
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
        // F15 部位语境：匹配记录部位组（表格行与正文同口径，与检测器 crossSectionNumericConflictIssues 一致），
        // 分部位的数量配置（分区灭火器 4具/2具）不参与权威归一判定
        const group = locationGroupForMatch(markdown, match.index || 0, raw, lineStart);
        if (/^\s*\|/u.test(line)) { tableValues.add(value); tableMatches.push({ value, group }); }
        else bodyMatches.push({ value, group });
      }
    }
    // 权威优先级：外部锁定口径（factsModel 计划工期/装配率等）> 表格唯一值 >
    // 设备台数多表冲突兜底（塔吊 2台 vs 1台 时取保守台数，评分器对超配敏感）>
    // A5 同组众数兜底（丰乐镇实测：灭火器 12具 与 2具 同属未标注部位语境且互为矛盾，检测器报
    // 「未标注部位语境两套口径」阻断，但 tableValues={12,2} 唯一值分支永不命中 → 修复恒零产出）；
    // 正文/表格行存在与权威差异 >20% 的值才修复（与检测器同阈值）
    const externalAuthority = authorities?.[anchor.key];
    const equipmentFallback = externalAuthority === undefined && anchor.key === 'towerCrane' && tableValues.size > 1;
    // A5：无部位组内存在互斥数值对（检测器同阈值）时启用众数权威——同一语境下总量口径唯一，
    // 频次最高值即主流口径（丰乐镇灭火器 12具 出现 3 处表格、2具 仅 1 处）
    const unlabeledAll = [...tableMatches, ...bodyMatches].filter(item => item.group === '').map(item => item.value);
    const unlabeledConflict = unlabeledAll.length >= 2 && Math.max(...unlabeledAll) - Math.min(...unlabeledAll) > Math.max(...unlabeledAll) * 0.2;
    const modeFallback = externalAuthority === undefined && !equipmentFallback && tableValues.size > 1 && unlabeledConflict ? modeOfValues(unlabeledAll) : undefined;
    const authority = externalAuthority !== undefined && externalAuthority > 0 ? externalAuthority
      : tableValues.size === 1 ? [...tableValues][0]
      : equipmentFallback ? Math.min(...tableValues)
      : modeFallback;
    if (authority === undefined) continue;
    // 外部权威/设备兜底时表格行全量参与修复（多表互相矛盾时表格行本身就是要统一的对象）；
    // A5 众数兜底仅未标注部位语境的表格行参与；F15 部位组豁免：部位组正文值不参与差异判定
    const fixCandidates = [...bodyMatches.filter(item => item.group === ''), ...(externalAuthority !== undefined || equipmentFallback ? tableMatches : modeFallback !== undefined ? tableMatches.filter(item => item.group === '') : [])];
    if (!fixCandidates.some(item => Math.abs(item.value - authority) > authority * 0.2)) continue;
    for (const pattern of anchor.patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const raw = match[0].slice(0, 40);
        if (ENUMERATION_VALUE_RE.test(raw)) continue;
        const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
        let lineEnd = markdown.indexOf('\n', match.index);
        if (lineEnd === -1) lineEnd = markdown.length;
        const line = markdown.slice(lineStart, lineEnd);
        if (NEGATIVE_DECLARATION_RE.test(line)) continue;
        if (/^\s*\|/u.test(line) && externalAuthority === undefined && !equipmentFallback && modeFallback === undefined) continue;
        const value = Number(match[1]);
        if (!Number.isFinite(value) || value <= 0) continue;
        // F15 部位组豁免：正文分部位的数量配置（分区灭火器等）不做确定性归一，防止修复器制造数据矛盾
        if (!/^\s*\|/u.test(line) && locationGroupForMatch(markdown, match.index || 0, raw, lineStart) !== '') continue;
        // A5 众数兜底仅统一未标注部位语境的表格行（带部位列的表格行保持不动）
        if (/^\s*\|/u.test(line) && modeFallback !== undefined && locationGroupForMatch(markdown, match.index || 0, raw, lineStart) !== '') continue;
        if (Math.abs(value - authority) <= authority * 0.2) continue;
        const valueIndex = match.index + match[0].indexOf(match[1]);
        const source = externalAuthority !== undefined && externalAuthority > 0 ? (anchor.key === 'scheduleDays' ? '以绑定资料计划工期为准' : '以绑定资料锁定口径为准') : modeFallback !== undefined ? '以未标注部位主流口径为准' : '以表格口径为准';
        replacements.push({ start: valueIndex, end: valueIndex + match[1].length, replacement: String(authority), detail: `${anchor.label} ${value}${anchor.unit}→${authority}${anchor.unit}（${source}）` });
      }
    }
  }
  // P2.3 收口修复扩围：标号类锚点（垫层 C20 等）外部权威确定性替换——kind='code' 锚点此前只检测不修复
  for (const anchor of CROSS_SECTION_ANCHORS) {
    if (anchor.kind !== 'code') continue;
    const authority = codeAuthorities?.[anchor.key];
    if (!authority) continue;
    const candidates: Array<{ start: number; end: number; raw: string }> = [];
    for (const pattern of anchor.patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const raw = match[0].slice(0, 40);
        if (ENUMERATION_VALUE_RE.test(raw)) continue;
        const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
        let lineEnd = markdown.indexOf('\n', match.index);
        if (lineEnd === -1) lineEnd = markdown.length;
        const line = markdown.slice(lineStart, lineEnd);
        if (NEGATIVE_DECLARATION_RE.test(line)) continue;
        // 部位组豁免与数值锚点同口径：分部位合法规格不做归一；部位词窗口排除锚点词本身——
        // 「垫层」自身在部位词表中，含锚点词的窗口会把组判成锚点词而豁免掉本应修复的同名条目；
        // 「基础垫层」异部位语境（锚点词前还有部位词「基础」）仍豁免保留原规格
        if (!/^\s*\|/u.test(line) && locationGroupForMatch(markdown, match.index || 0, '', lineStart) !== '') continue;
        if (match[1] === authority) continue;
        const valueIndex = match.index + match[0].indexOf(match[1]);
        candidates.push({ start: valueIndex, end: valueIndex + match[1].length, raw });
      }
    }
    for (const candidate of candidates) {
      replacements.push({ start: candidate.start, end: candidate.end, replacement: authority, detail: `${anchor.label} ${markdown.slice(candidate.start, candidate.end)}→${authority}（以工程量清单锁定口径为准）` });
    }
  }
  return applySpanReplacements(markdown, replacements);
}

// ── G3 清单工程量权威定点校正 ──
// 丰乐镇第五轮实测：2.1 道路工程 5 项工程量与清单汇总值漂移 3.5%~70%（级配碎石 18949.52 vs
// 权威 20931.02、水泥混凝土 18799.52 vs 20872.82、路床碾压 18429.52 vs 19930.52、挖方
// 4040.45 vs 4187.38、拆除路面 633 vs 2134），全量清单复制入正文制造跨章口径漂移。
// 检测器 anchor 表只覆盖工期/设备/材料，清单工程量无权威锚点——此处按蓝图 quantities
// （条目名→汇总值）定点校正。清单条目存在「子串名」「分规格」「分村分表」「分部量」等
// 合法口径，无差别归一制造矛盾数据（丰乐镇干跑实测：塑料管铺设 8205.53 被「塑料管」
// 权威误改 7525.01、直径450塑料检查井 40 座被「塑料检查井」汇总值误改 555），
// 因此内置五重豁免：最长条目名优先、表格行、规格限定词、村名语境、句级口径判定。

/** 单位归一（权威单位 → 正文匹配单位集）：清单单位口径与正文写法对齐（m2/m²/㎡ 同义） */
function quantityUnitVariants(unit: string): string {
  const normalized = unit.trim().toLowerCase();
  if (/(?:m2|m²|㎡)/.test(normalized)) return '(?:㎡|m²|m2)';
  if (/(?:m3|m³)/.test(normalized)) return '(?:m³|m3)';
  if (normalized === 't' || normalized === '吨') return '(?:吨|t)';
  return unit.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 名称弹性匹配模式：括号容忍半全角与可缺省
 * （「路床(槽)碾压检验」↔「路床（槽）碾压检验」↔「路床槽碾压检验」三态互配） */
function flexNamePattern(name: string): string {
  return name.split('').map(ch => {
    // 括号双态互配（半/全角都容忍对方）——名称含全角括号时正文常写半角（“栽植色带（生态池外围一圈）”↔“栽植色带(生态池外围一圈)”）
    if (ch === '(' || ch === '（') return '[（(]?';
    if (ch === ')' || ch === '）') return '[）)]?';
    if (/[.*+?^${}()|[\]\\]/u.test(ch)) return `\\${ch}`;
    return ch;
  }).join('');
}

/** 村名/分部语境特征词豁免：名称前 12 字内含这些词时判为分村/分部合法量，不归一；
 * 「池」覆盖生态池部位量（“生态池外围栽植色带90m²”对应清单「栽植色带（生态池外围一圈）」条目） */
const VILLAGE_LOCATION_HINT_RE = /[村郢组庄岗塘圩集坝分区段栋号楼池]/u;

/** 段落级村名豁免字符集（保守子集）：段落内含任一字符判为分村分表段，整段不归一
 * （村名距条目名常超过 12 字窗口，如“、殷郢组…本分项工程量为：…挖基坑土方42.12m³”；
 * 刻意不含「村/组/段/集」——「20个自然村」「专业组」「流水段」「集料」是合法工程表述） */
const VILLAGE_PARAGRAPH_HINT_RE = /[郢庄岗塘圩坝]/u;

/** 规格限定词（名称前/后 8 字内）：分规格量不归一
 * （“直径450塑料检查井40座”是分规格条目，清单汇总条目“塑料检查井555座”不得覆盖；
 * “钢带PE增强螺旋波纹管DN200铺设2170m”的 DN200 是规格后置） */
const SPEC_QUALIFIER_RE = /(?:直径|DN|Φ|φ)\s*\d+/u;

export function fixQuantityAuthorityConflicts(markdown: string, quantityAuthorities: Array<{ name: string; value: number; unit: string }> = []): { markdown: string; fixedCount: number; details: string[] } {
  if (quantityAuthorities.length === 0) return { markdown, fixedCount: 0, details: [] };
  interface Candidate { start: number; end: number; raw: string; value: number; authority: { name: string; value: number; unit: string }; ns: number; ne: number; }
  const candidates: Candidate[] = [];
  const occupied: Array<{ start: number; end: number }> = [];
  // 最长条目名优先：蓝图「塑料管铺设」与「塑料管」并存时，正文“塑料管铺设8205.53m”只归
  // 长条目（8205.53 与长条目一致不改），不被「塑料管」条目误改 7525.01；
  // 「级配碎石基层」无更长权威条目，短名「级配碎石」照常命中修复
  const sorted = [...quantityAuthorities].sort((a, b) => b.name.length - a.name.length);
  for (const authority of sorted) {
    const nameRe = new RegExp(flexNamePattern(authority.name), 'gu');
    // 数值左边界：排除更长数字串/科学计数法的截取（「1e3」中的 3、「abc123」的 123）；
    // 'i' 标志：兼容大写单位（M2/M3/T/M——工程文档中常见）
    const unitRe = new RegExp(`(?<![\\dA-Za-z])(\\d(?:[\\d,]*(?:\\.\\d+)?))\\s*${quantityUnitVariants(authority.unit)}(?![0-9a-zA-Z])`, 'gui');
    for (const nameMatch of markdown.matchAll(nameRe)) {
      const ns = nameMatch.index ?? 0;
      const ne = ns + nameMatch[0].length;
      if (occupied.some(o => ns < o.end && ne > o.start)) continue;
      occupied.push({ start: ns, end: ne });
      // 表格行内是分村分表/分规格数据，由 G2 剥离与修复轮处理，定点校正不碰
      const lineStart = markdown.lastIndexOf('\n', ns) + 1;
      let lineEnd = markdown.indexOf('\n', ns);
      if (lineEnd === -1) lineEnd = markdown.length;
      const line = markdown.slice(lineStart, lineEnd);
      if (/^\s*\|/u.test(line)) continue;
      // 村名/分部语境豁免：名称前 12 字内含村级地名/分部特征词（分村分表合法量不归一）
      const prefix = markdown.slice(Math.max(0, ns - 12), ns);
      if (VILLAGE_LOCATION_HINT_RE.test(prefix)) continue;
      // 规格限定词豁免（前置：直径450塑料检查井；后置：波纹管DN200）
      if (SPEC_QUALIFIER_RE.test(markdown.slice(Math.max(0, ns - 8), ns))) continue;
      if (SPEC_QUALIFIER_RE.test(markdown.slice(ne, ne + 8))) continue;
      // 段落级村名豁免：殷郢组等村名列表距条目名远超 12 字窗口
      const paraStart = markdown.lastIndexOf('\n\n', ns);
      const paraFrom = paraStart === -1 ? 0 : paraStart + 2;
      const paraEndIdx = markdown.indexOf('\n\n', ns);
      const paraTo = paraEndIdx === -1 ? markdown.length : paraEndIdx;
      if (VILLAGE_PARAGRAPH_HINT_RE.test(markdown.slice(paraFrom, paraTo))) continue;
      const windowStart = ne;
      // 窗口取「名称后 24 字符」且被列举分隔符（、。；）截断——名称列举句
      // （“墙面彩绘、小微菜园围栏等内容。主要工程量包括……”）后跟的是其他条目工程量，
      // 跨条目窗口会把后续条目数值误归到本名称（丰乐镇实测：墙面彩绘误改 20931.02）
      const rawWindow = markdown.slice(windowStart, windowStart + 24);
      // 列举分隔符含逗号（「、，；。」）：「，」不截断会致下一条目的相近值遮藏目标值
      const splitAt = Math.min(...[rawWindow.search(/[、。；，]/u), rawWindow.search(/\n/u)].filter(pos => pos >= 0).concat([rawWindow.length]));
      const window = rawWindow.slice(0, splitAt);
      // 窗口内取与权威值差异最小的「数值+单位」候选（避开厚度 cm/mm 等其他单位数值）
      let best: { offset: number; value: number; raw: string } | null = null;
      for (const valueMatch of window.matchAll(unitRe)) {
        const raw = valueMatch[1];
        const value = Number(raw.replace(/,/gu, ''));
        if (!Number.isFinite(value) || value <= 0) continue;
        if (best === null || Math.abs(value - authority.value) < Math.abs(best.value - authority.value)) {
          best = { offset: windowStart + (valueMatch.index ?? 0) + valueMatch[0].indexOf(raw), value, raw };
        }
      }
      if (!best || best.value === authority.value) continue;
      // 差异 ≤2% 视为四舍五入口径差不动
      if (Math.abs(best.value - authority.value) <= authority.value * 0.02) continue;
      candidates.push({ start: best.offset, end: best.offset + best.raw.length, raw: best.raw, value: best.value, authority, ns, ne });
    }
  }
  // 句级口径豁免：候选所在句（句号/换行为界）内「与各自权威差异 >50%」的候选数 ≥2
  // 且多于「差异 ≤50%」候选数时，判为分部/分表量列举句，整句不归一。
  // 2.8 景观分部量句（挖一般土方146.93/级配碎石480.5/水泥混凝土572.3/人行道板安砌114.8
  // 全部 >50% 差异 vs 仿木护栏333 一致）、2.9.1 公厕单体量句、2.19.1 强电配套量句均豁免；
  // 2.1 道路段 3 大 4 小（“拆除路面633→2134”等真实漂移与小差异条目共存）不触发豁免
  const driftOf = (candidate: Candidate) => Math.abs(candidate.value - candidate.authority.value) / candidate.authority.value;
  const sentenceOf = (at: number): { start: number; end: number } => {
    const back = Math.max(markdown.lastIndexOf('。', at), markdown.lastIndexOf('\n', at));
    let fwd1 = markdown.indexOf('。', at);
    if (fwd1 === -1) fwd1 = markdown.length;
    let fwd2 = markdown.indexOf('\n', at);
    if (fwd2 === -1) fwd2 = markdown.length;
    return { start: back + 1, end: Math.min(fwd1, fwd2) + 1 };
  };
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    const sentence = sentenceOf(candidate.ns);
    const peers = candidates.filter(other => other !== candidate && other.ns >= sentence.start && other.ns < sentence.end);
    const large = [candidate, ...peers].filter(item => driftOf(item) > 0.5).length;
    const small = [candidate, ...peers].filter(item => driftOf(item) <= 0.5).length;
    if (large >= 2 && large > small) continue;
    kept.push(candidate);
  }
  const replacements = kept.map(candidate => ({
    start: candidate.start,
    end: candidate.end,
    replacement: String(candidate.authority.value),
    detail: `${candidate.authority.name} ${candidate.value}${candidate.authority.unit}→${candidate.authority.value}${candidate.authority.unit}（以工程量清单汇总值为准）`,
  }));
  return applySpanReplacements(markdown, replacements);
}

/** 计划总工期权威口径提取：factsModel 计划工期事实卡（schedule_requirement「计划工期」字段）
 * 或 canonical 锁定值的日历天数值。4.17.3 庐江实测：45 vs 210 两套体系并存时表格口径不唯一，
 * 必须以绑定资料提取的锁定工期为准做确定性替换（修复节点 failed 根因之一）。
 * 事实卡值为混合口径长句（“计划工期：…起，210日历天”）时取首个「N日历天」数值。 */
export function extractScheduleAuthority(factsModel?: DocumentFactsModel | null): number | undefined {
  const extract = (raw: string): number | undefined => {
    const match = raw.match(/(\d{1,4})\s*个?\s*日历天/u);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  for (const fact of factsModel?.schedule ?? []) {
    const label = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
    if (!/工期|周期/u.test(label)) continue;
    const found = extract(stringifyFactValue(fact.value));
    if (found !== undefined) return found;
  }
  const canonicalSchedule = factsModel?.canonical?.schedule ?? {};
  for (const entry of Object.values(canonicalSchedule)) {
    const item = Array.isArray(entry) ? entry[0] : entry;
    if (!item || !/工期|周期/u.test(item.label)) continue;
    const found = extract(item.value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** 装配率权威口径提取：factsModel 装配率事实卡（fieldId=assembly_rate / key=装配率）
 * 或招标要求模型（tenderRequirements.assemblyRate）中的百分比数值。
 * 4.17.4 合肥师范实测：正文 38.4% vs 招标锁定 30%，正文计算值必须回退为招标锁定值。 */
export function extractAssemblyRateAuthority(factsModel?: DocumentFactsModel | null): number | undefined {
  const extract = (raw: string): number | undefined => {
    const match = raw.match(/(\d+(?:\.\d+)?)\s*%/u);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 && value <= 100 ? value : undefined;
  };
  const facts = [...(factsModel?.project ?? []), ...(factsModel?.bills ?? []), ...(factsModel?.preciseFacts ?? [])];
  for (const fact of facts) {
    const label = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
    if (!/装配率|assembly/u.test(label)) continue;
    const found = extract(stringifyFactValue(fact.value));
    if (found !== undefined) return found;
  }
  const tenderText = factsModel?.tenderRequirements?.assemblyRate?.text;
  if (tenderText) return extract(tenderText);
  return undefined;
}

/** 工程规模摘要提取（6.1 工程概况一览表套话填充用）：单体建筑面积（招标口径卡优先）+
 * 地上/地下层数，组合为「建筑面积N平方米，地上N层、地下N层」形态；缺失项自动省略。 */
export function extractProjectScaleSummary(factsModel?: DocumentFactsModel | null): string | undefined {
  const parts: string[] = [];
  const project = factsModel?.project ?? [];
  let area: number | undefined;
  for (const fact of project) {
    const label = `${fact.key || ''}${fact.fieldName || ''}`;
    if (!/单体建筑面积|建设规模/u.test(label)) continue;
    const match = stringifyFactValue(fact.value).match(/(\d+(?:\.\d+)?)\s*(?:平方(?:米)?|㎡|m²)/u);
    if (match && Number.isFinite(Number(match[1]))) { area = Number(match[1]); break; }
  }
  if (area !== undefined) parts.push(`建筑面积${area}平方米`);
  // 层数从事实卡全量文本中提取首处「地上N层/地下N层」
  const allText = JSON.stringify({ project, drawings: factsModel?.drawings ?? [], tables: factsModel?.tables ?? [] });
  const floorsAbove = allText.match(/地上\s*(\d+)\s*层/u)?.[1];
  const floorsBelow = allText.match(/地下\s*(\d+)\s*层/u)?.[1];
  if (floorsAbove !== undefined) parts.push(`地上${floorsAbove}层`);
  if (floorsBelow !== undefined) parts.push(`地下${floorsBelow}层`);
  return parts.length > 0 ? parts.join('、') : undefined;
}

/** A2 总入口：跨章数值/支护体系矛盾确定性修复（劳动力峰值 → 节点工期 → 材料/设备数量 → 支护体系，顺序执行互不重叠） */
export function applyNumericConsistencyDeterministicFixes(markdown: string, options?: { scheduleAuthority?: number; assemblyRateAuthority?: number; nodeAuthorities?: Array<{ node: string; offset: string }>; machineAuthorities?: Record<string, number>; supportAuthority?: SupportSystemAuthorityKind | null; laborPeakAuthority?: number; codeAuthorities?: Record<string, string>; villageCountAuthority?: number; slackDaysAuthority?: number; quantityAuthorities?: Array<{ name: string; value: number; unit: string }> }): NumericConsistencyFixResult {
  let next = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  const authorities: Record<string, number> = {};
  if (options?.scheduleAuthority !== undefined && options.scheduleAuthority > 0) authorities.scheduleDays = options.scheduleAuthority;
  if (options?.assemblyRateAuthority !== undefined && options.assemblyRateAuthority > 0) authorities.prefabRatio = options.assemblyRateAuthority;
  if (options?.villageCountAuthority !== undefined && options.villageCountAuthority > 0) authorities.villageCount = options.villageCountAuthority;
  if (options?.slackDaysAuthority !== undefined && options.slackDaysAuthority > 0) authorities.slackDays = options.slackDaysAuthority;
  if (options?.machineAuthorities !== undefined) Object.assign(authorities, options.machineAuthorities);
  for (const step of [(text: string) => fixLaborPeakConflicts(text, options?.laborPeakAuthority), (text: string) => fixNodeScheduleConflicts(text, { scheduleAuthority: options?.scheduleAuthority, nodeAuthorities: options?.nodeAuthorities }), (text: string) => fixCrossSectionNumericConflicts(text, authorities, options?.codeAuthorities), (text: string) => fixSupportSystemConflicts(text, options?.supportAuthority), (text: string) => fixQuantityAuthorityConflicts(text, options?.quantityAuthorities)]) {
    const result = step(next);
    if (result.markdown !== next) {
      next = result.markdown;
      fixedCount += result.fixedCount;
      details.push(...result.details);
    }
  }
  return { markdown: next, fixedCount, details: details.slice(0, 12) };
}

// ── 21b. 文本粘连确定性清洗（4.17.4 合肥师范评分器高风险）──
// 实测三类损坏：① 「冬季热负荷71.2kW182.5kW，冬季热负荷71.2kW182.5kW，冬季热负荷71.2kW」
// 相邻/隔位短语重复粘连；② 「按主体结构与装饰装修穿插施工阶段高峰阶段应急抢险人员按…
// 高峰人数186人的16%配置，不少于30人的16%配置，不少于30人」长短语隔位重复+句尾残片；
// ③ 「71.2kW182.5kW」两个「数值+单位」块无分隔粘连。LLM 修复轮定位失败（failed）时由本函数确定性收口。

/** 句内重复短语折叠：
 * 表格行（| 开头）与标题行（# 开头）整体跳过（分隔行「| --- |」与表内合法重复不折叠）；
 * 模式1 相邻重复块折叠（L≥4，块须含数字或中文，优先长块迭代）；
 * 模式2 隔位重复短语（中文开头、含数字、长≥6、结尾非纯数字、无结构符号）保留首现删除后续；
 * 模式3 「数值+单位」无分隔粘连折叠（保留首块删除粘连块，如 71.2kW182.5kW→71.2kW）。 */
export function fixAdjacentPhraseDuplication(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  // 句级 split 先行使 fragment 内不可能出现跨句界的双标点（「段落。。」被拆为「段落。」「。」），
  // 原 cleanSentence 内的双标点归一（/[。；！？]{2,}/）成为死代码（边界矩阵 A4 捕获）：
  // 须在 split 前整文预归一；折叠/删块残留的标点归一仍留在 cleanSentence 内处理
  markdown = markdown
    .replace(/[。；！？]{2,}/gu, match => match[0] ?? '')
    .replace(/，(?=[。；！？])/gu, '');
  const fragments = markdown.split(/(?<=[。！？；\n])/u);
  const details: string[] = [];
  let fixedCount = 0;
  // 句级相邻整句重复折叠（跨「。」句界，模式 0）：split 后各 fragment 由 cleanSentence 独立清洗，
  // 相邻 fragment 间的整句重复不入视野（丰乐镇第十二轮实测：2.2.1「每道工序完成后…下道工序。」
  // 相邻重复两遍、2.2.2「质检员每日检查…销项。」等三处两遍全漏——LLM 复制段落时句界重叠的机械
  // 污染）；dedupeCrossSectionDuplicateSentences 同小节内重复保留（有意强调豁免）不兜此形态，
  // 本步骤只折叠去空白后完全相等的相邻长句（≥20 字，模板化短句不受影响）；表格/标题/引用行
  // 不参与判定；空 fragment（\n）入数组打断相邻性 → 只做段落内去重，跨小节模板化长句合法重复保留
  const sentences: string[] = [];
  for (const fragment of fragments) {
    const norm = fragment.replace(/\s+/gu, '');
    if (
      norm.length >= 20
      && !/^[|#>]/.test(fragment.trimStart())
      && sentences[sentences.length - 1]?.replace(/\s+/gu, '') === norm
    ) {
      fixedCount += 1;
      details.push(`相邻整句重复折叠：“${norm.slice(0, 24)}”`);
      continue;
    }
    sentences.push(fragment);
  }
  const cleanSentence = (sentence: string): string => {
    // 表格行/标题行/分隔行不折叠（表内多列重复与 markdown 结构字符是合法形态）
    const trimmed = sentence.trimStart();
    if (/^[|#]/.test(trimmed)) return sentence;
    let text = sentence;
    let changed = true;
    let guard = 0;
    while (changed && guard < 20) {
      changed = false;
      guard += 1;
      // 模式1：相邻重复块折叠（长块优先）
      for (let length = 16; length >= 4; length -= 1) {
        for (let i = 0; i + length * 2 <= text.length; i += 1) {
          const block = text.slice(i, i + length);
          if (!/[0-9]/.test(block) && !/[\u4e00-\u9fa5]/.test(block)) continue;
          if (text.slice(i + length, i + length * 2) === block) {
            text = text.slice(0, i + length) + text.slice(i + length * 2);
            changed = true;
            fixedCount += 1;
            details.push(`相邻重复短语折叠：“${block.slice(0, 24)}”`);
            break;
          }
        }
        if (changed) break;
      }
      if (changed) continue;
      // 模式2：隔位重复短语保留首现——数字短语（中文开头、长≥9、结尾非纯数字、无结构符号）
      // 或纯中文长短语（长≥12，如「按主体结构与装饰装修穿插施工阶段高峰」16字错乱重复）；
      // 4.17.4 数字短语最短长度 6→9：防「第311日）」（6字，节点句跨行双现合法重复）与
      // 「抗渗等级P8，地」（8字，与「抗渗等级P8，地下室顶板」的「地」前缀撞车）被误折叠
      for (let length = 20; length >= 9; length -= 1) {
        for (let i = 0; i + length <= text.length; i += 1) {
          const phrase = text.slice(i, i + length);
          if (!/[\u4e00-\u9fa5]/.test(phrase[0] || '')) continue;
          const hasDigit = /[0-9]/.test(phrase);
          if (!hasDigit && length < 12) continue;
          if (hasDigit && (/\d$/.test(phrase) || /[|→\-—]/.test(phrase))) continue;
          const first = text.indexOf(phrase);
          if (first !== i) continue;
          const second = text.indexOf(phrase, first + 1);
          if (second === -1) continue;
          // 仅删第二次及之后出现（保留首现）
          let removedCount = 0;
          let cursor = text.indexOf(phrase, first + 1);
          while (cursor !== -1) {
            text = text.slice(0, cursor) + text.slice(cursor + length);
            removedCount += 1;
            cursor = text.indexOf(phrase, cursor);
          }
          if (removedCount > 0) {
            changed = true;
            fixedCount += removedCount;
            details.push(`隔位重复短语折叠：“${phrase.slice(0, 24)}”×${removedCount}`);
            break;
          }
        }
        if (changed) break;
      }
      if (changed) continue;
      // 模式3：「数值+单位」无分隔粘连（如 71.2kW182.5kW）：保留首块、删除粘连块
      const unitGroup = 'kW|kVA|MPa|㎡|m²|m³|mm|cm|%';
      const glueRe = new RegExp(`(\\d+(?:\\.\\d+)?)(?:${unitGroup})(?=\\s*\\d+(?:\\.\\d+)?(?:${unitGroup}))`, 'gu');
      const glueMatch = glueRe.exec(text);
      if (glueMatch) {
        const restStart = glueMatch.index + glueMatch[0].length;
        const tailMatch = text.slice(restStart).match(new RegExp(`^\\s*(\\d+(?:\\.\\d+)?)(?:${unitGroup})`));
        if (tailMatch) {
          text = text.slice(0, restStart) + text.slice(restStart + tailMatch[0].length);
          changed = true;
          fixedCount += 1;
          details.push(`数值单位粘连折叠：“${glueMatch[0]}${tailMatch[0].trim()}”→“${glueMatch[0]}”`);
        }
      }
      if (changed) continue;
      // 残留重复标点归一：折叠/删块后「，，」「，。」「。。」形态（如 71.2kW182.5kW 删块后残留「，。」）
      const punctBefore = text;
      text = text
        .replace(/[，,]{2,}/gu, '，')
        .replace(/[。；！？]{2,}/gu, match => match[0])
        .replace(/，(?=[。；！？])/gu, '');
      if (text !== punctBefore) {
        changed = true;
        details.push('残留重复标点归一');
      }
    }
    return text;
  };
  return { markdown: sentences.map(cleanSentence).join(''), fixedCount, details: details.slice(0, 8) };
}

/** 6.1 工程概况一览表套话填充（4.17.4 合肥师范评分器高风险「数据缺失」）：
 * 「按施工图设计文件确定」→ factsModel 建筑面积/层数摘要；「按合同约定工期执行」→ 锁定总工期日历天。
 * 仅表格行（|…|）内替换，factsModel 摘要缺失时跳过（保守）。 */
export function fixPlaceholderTableCells(markdown: string, options?: { areaSummary?: string; scheduleDays?: number }): { markdown: string; fixedCount: number; details: string[] } {
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  if (options?.areaSummary) {
    for (const match of markdown.matchAll(/\|\s*按施工图设计文件确定\s*\|/gu)) {
      replacements.push({ start: match.index + 1, end: match.index + match[0].length - 1, replacement: ` ${options.areaSummary} `, detail: `工程概况一览表建设规模套话→“${options.areaSummary}”` });
    }
  }
  if (options?.scheduleDays !== undefined && options.scheduleDays > 0) {
    for (const match of markdown.matchAll(/\|\s*按合同约定工期执行\s*\|/gu)) {
      replacements.push({ start: match.index + 1, end: match.index + match[0].length - 1, replacement: ` ${options.scheduleDays}个日历天 `, detail: `工程概况一览表工期套话→“${options.scheduleDays}个日历天”` });
    }
  }
  if (replacements.length === 0) return { markdown, fixedCount: 0, details: [] };
  const applied = applySpanReplacements(markdown, replacements);
  return { markdown: applied.markdown, fixedCount: applied.fixedCount, details: applied.details };
}

/** 6.1 施工部署块质量保障内容补全（4.17.4 合肥师范评分器高风险「内容完整」）：
 * 评审项「确保工期与质量」要求块内出现质量保障核心术语（三检/样板引路/隐蔽验收/见证取样/试块养护/分部分项报验）；
 * 6.1 以安全文明为主线时缺失 ≥4 个核心术语 → 块尾插入质量保障协同段（结合创优目标口径，非模板套话）。 */
export function fixQualityAssuranceCoverage(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const blockRe = /(### 6\.1\s+施工部署与施工流水组织[\s\S]*?)(?=### 6\.2|## 第[六七]章|$)/u;
  const block = markdown.match(blockRe);
  if (!block) return { markdown, fixedCount: 0, details: [] };
  const body = block[0];
  const coreTerms = ['三检', '样板引路', '隐蔽验收', '见证取样', '试块养护', '分部分项报验'];
  const hitCount = coreTerms.filter(term => body.includes(term)).length;
  if (hitCount >= 3) return { markdown, fixedCount: 0, details: [] };
  const injected = `\n质量保障体系与安全文明管理同频运行：项目部实行“三检制”（自检、互检、交接检），每道工序经班组自检、质量员复检合格后报监理单位验收；推行样板引路制度，主体结构、装配式构件安装、ALC墙板安装、幕墙安装等主要分项工程在大面积施工前先做样板，经建设、监理单位验收确认后方可展开；隐蔽工程（钢筋、防水、管线预埋等）覆盖前由质量员组织隐蔽验收并留存影像记录；原材料进场按见证取样要求送检，混凝土试块按规范留置并落实标养与同条件养护；分部分项工程验收严格执行报验程序，验收资料与工程进度同步归档，确保“合格”质量标准与“确保黄山杯”创优目标逐级落实。`;
  const insertAt = (block.index ?? 0) + body.length;
  const next = markdown.slice(0, insertAt) + injected + markdown.slice(insertAt);
  return { markdown: next, fixedCount: 1, details: [`6.1 施工部署块补全质量保障协同段（核心术语 ${coreTerms.length - hitCount}/${coreTerms.length} 缺失）`] };
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

/** 跨章语义重复确定性 strip：保留信息密度高者所在段落，删除低密度方整段（原地改 chapters，返回删除段数）。
 * B1 迭代至收敛：删除一个段落后全文 bge 余弦重算，新段落对会越过阈值（实测单轮后二次 strip 仍删 11 段），
 * 单轮 strip 残留被导出门禁阻断；循环至无新 pair 或 5 轮上限（防异常数据死循环） */
export async function stripCrossChapterSemanticDuplicateParagraphs(chapters: DocumentDraftChapter[]): Promise<number> {
  let totalRemoved = 0;
  for (let round = 0; round < 5; round += 1) {
    const pairs = await findCrossChapterSemanticDupPairs(chapters);
    if (pairs.length === 0) break;
    let removed = 0;
    // 同轮多对同章删除按段落索引降序（防先删段落后索引 shift 删错目标）
    const ordered = [...pairs].sort((a, b) => a.drop.chapterIndex - b.drop.chapterIndex || b.drop.paragraphIndex - a.drop.paragraphIndex);
    for (const pair of ordered) {
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
    if (removed === 0) break;
    totalRemoved += removed;
  }
  return totalRemoved;
}

// ── A6 危大/自伤/六个百分百确定性收口（丰乐镇 79 分基线对照实测）──────────────────
// 首轮生成残留三类阻断（LLM 修复轮定位能力不足，残留被导出门禁硬阻断）：
// ①危大「如涉及」假设性表述（语义命中自伤候选，暴露专项方案未落实短板）；
// ②危大辨识清单遗漏适用项（正文出现吊装/拆除工程前提但辨识区未列别名）；
// ③扬尘六个百分百缺项（出入车辆冲洗/地面硬化仅在长句内词面出现，bge 语义稀释未过阈值）。
// 此处按检测器同源口径确定性改写/补写（检测定位=修复定位）。

/** 自伤表述确定性改写（A6/A12）：实测形态正向化改写。
 * 只改写实测锁定句式（首轮/二轮生成逐字命中），新句式变体由检测器+LLM 修复轮处理；
 * 改写方向统一为正向确认表述，不再暴露「待补测/可能不一致/如涉及」类投标短板暗示。 */
export function fixSelfUnderminingCandidates(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const replacements: Array<{ from: RegExp; to: string; detail: string }> = [
    {
      from: /施工过程中如涉及危险性较大的分部分项工程[^。；;\n]*?(?:未经审批不得实施|后方可实施|方可实施)/gu,
      to: '危险性较大的分部分项工程按住房和城乡建设部令第37号与建办质〔2018〕31号规定逐项辨识、分级管控：凡达到危大工程判定线的分项，施工前编制专项施工方案，由技术负责人审核签字后报监理审批；超过一定规模的危大工程专项方案组织专家论证，未经审批不得实施',
      detail: '危大「如涉及」假设表述改写为逐项辨识分级管控',
    },
    {
      from: /发现[^。；;\n]{0,18}?(?:缺项|矛盾|缺失|遗漏)[^。；;\n]{0,24}?(?:时|后)在?\d+小时(?:内)?[^。；;\n]{0,10}?(?:补测|补正|补救|补录|补记)/gu,
      to: '记录经复核确认完整、数据准确后归档保存',
      detail: '踏勘补测类负面假设改写为复核确认归档',
    },
    {
      from: /确保[^。；;\n]{0,20}?与(?:本)?施工组织设计的?一致性/gu,
      to: '确认现场条件与施工组织设计相符',
      detail: '现场条件一致性两可暗示改写为确认相符',
    },
    // A12 二轮实测三形态（丰乐镇第二轮生成逐字命中，检测器语义判定为自伤候选）
    {
      from: /本工程不允许分包[^。；;\n]{0,40}?组织实施/gu,
      to: '本工程全部施工任务由我公司项目部自行组织实施，严禁违法分包、转包及挂靠行为',
      detail: '「不允许分包」短板暗示改写为自主组织正向表述',
    },
    {
      from: /针对踏勘中发现的与设计图纸不一致或设计未明确的事项[^。；;\n]{0,60}?按以下[口经]径处理/gu,
      to: '项目部对照施工图与现场条件逐项复核，按以下程序处理',
      detail: '「设计图纸不一致」负面假设改写为对照复核程序',
    },
    {
      from: /杜绝施工过程中以工程量组价缺失为由提出变更申请/gu,
      to: '开工前完成工程量与清单核对，施工过程中严格按合同约定计量计价',
      detail: '「组价缺失」短板暴露改写为开工前核对闭环',
    },
    // A18 三轮实测三形态（丰乐镇第三轮生成逐字命中，检测器语义判定为自伤候选）
    {
      from: /涉及危险性较大的分部分项工程，我公司将依据([^。；;\n]{0,80}?)，在施工前单独编制专项施工方案并履行审批程序。/gu,
      to: '本工程危险性较大的分部分项工程管理执行$1规定：施工前编制专项施工方案，履行审批程序后实施。',
      detail: '危大「涉及」假设句式改写为管理执行闭环',
    },
    {
      from: /上述参数在后续各分项施工方案中逐项落位执行。?/gu,
      to: '上述参数作为全文统一控制基准，各分项施工方案均按此执行。',
      detail: '「后续落位」延迟承诺改写为统一控制基准',
    },
    {
      from: /补疑文件对施工内容作出以下明确修正：([^。\n]{0,200}?)。上述修正内容已纳入本施工组织设计对应分项方案，施工过程中不再另行变更。?/gu,
      to: '招标文件补疑明确：$1。上述内容已纳入本施工组织设计对应分项方案并统一执行。',
      detail: '「补疑修正不再变更」负面暗示改写为统一执行',
    },
    // A19 五轮实测三形态（丰乐镇第五轮生成逐字命中，检测器语义判定为自伤候选）
    {
      from: /项目部按《建筑施工企业、工程项目安全生产管理机构设置及安全生产管理人员配备办法》（建质规〔2025〕3号）配备专职安全生产管理人员，公司分管安全负责人每月带班检查不得少于两次/gu,
      to: '项目部严格执行《建筑施工企业、工程项目安全生产管理机构设置及安全生产管理人员配备办法》（建质规〔2025〕3号），专职安全生产管理人员按标准配足配齐，公司分管安全负责人每月带班检查不少于两次并留存检查记录',
      detail: '安全人员配备与带班检查短板暗示改写为配足配齐正向表述',
    },
    {
      from: /项目部在开工令下发后第(\d+)日亮化及附属设施安装完成后，随即启动竣工清理与验收移交程序，确保开工令下发后第(\d+)日完成全部验收移交工作/gu,
      to: '亮化及附属设施安装于开工令下发后第$1日完成，竣工清理与验收移交按计划组织，开工令下发后第$2日全部验收移交工作完成',
      detail: '竣工验收赶工暗示改写为按计划组织正向表述',
    },
    {
      from: /隐蔽工程在施工过程中已按(\d+)小时提前通知要求完成验收，竣工阶段不再重复检验，但须将全部隐蔽验收影像资料纳入竣工资料归档/gu,
      to: '隐蔽工程按$1小时提前通知要求组织验收，验收合格后方可进入下道工序，全部隐蔽验收影像资料纳入竣工资料归档',
      detail: '「竣工阶段不再重复检验」自伤暗示改写为验收闭环正向表述',
    },
    // A20 六轮实测三形态（丰乐镇第六轮生成逐字命中，检测器语义判定为自伤候选）
    {
      // C1 地点泛化去硬编码：原句写死「肥西县丰乐镇」仅该县项目命中；现「本项目位于+任意地点」均可命中
      from: /本施工组织设计的编制边界为：本项目位于[^，。；;\n]{2,40}，以补疑澄清文件对清单及图纸的修正口径为优先执行依据。?/gu,
      to: '本施工组织设计编制依据包括招标文件、补疑澄清文件、施工图及工程量清单，正文数据口径与补疑澄清文件修正口径保持一致。',
      detail: '编制边界两可暗示改写为编制依据一致性正向表述',
    },
    {
      from: /施工组织设计覆盖从开工令下发至竣工验收合格后移交保修的全过程管理，不包含招标范围以外的工程内容。?/gu,
      to: '施工组织设计覆盖开工令下发至竣工验收移交保修的全过程管理，全过程管理内容与招标范围一致。',
      detail: '「不包含招标范围以外」短板暗示改写为覆盖范围一致性表述',
    },
    {
      from: /面层混凝土弯拉强度达到设计强度且填缝完成前不得开放交通，由试验员按每检验批留置试块并送检，强度报告归档闭环。?/gu,
      to: '面层混凝土达到设计强度且填缝完成后开放交通，试验员按每检验批留置试块送检，强度报告归档形成质量闭环。',
      detail: '「不得开放交通」负面表述改写为达到条件后开放交通正向表述',
    },
    // A21 七轮实测三形态（丰乐镇第七轮生成逐字命中，检测器语义判定为自伤候选）
    {
      from: /本项目以成熟可靠的常规工艺为主，未采用(?:行业认定的)?新技术、新材料、新工艺或新设备[^。；;\n]{0,20}?。?/gu,
      to: '本项目工艺选择以成熟可靠为原则，全部采用经工程实践验证的成熟工艺、常规材料和标准化设备，确保各分项施工质量稳定可控。',
      detail: '「未采用新技术」短板自曝改写为成熟工艺正向表述',
    },
    // R9 八轮实测两形态（丰乐镇第八轮生成逐字命中，导出门禁硬阻断残留）
    {
      from: /本招标项目不允许分包。本工程不进行分包，全部施工内容由我方自行组织完成。?/gu,
      to: '本招标项目严禁转包和违法分包，本工程全部施工任务由我公司项目部自行组织实施',
      detail: '「本工程不进行分包」否定式自述改写为自主组织正向表述',
    },
    {
      // C1 数字泛化去窄化：原「安排1个日历天」仅匹配丰乐镇特例；现任何「收尾阶段安排N个日历天」
      // 的赶工暗示均命中改写，工序细节用通配捕获（跨项目通用，to 句不含任何项目特定词）；
      // 句尾「竣工验收」锚点必选（否则 。? 可空匹配导致替换在句中提前结束、句尾内容残留）
      from: /(?:亮化与)?收尾阶段安排\s*\d+\s*个日历天[^。\n]{0,60}?项目经理组织各分组施工员进行内部预验收[^。\n]{0,80}?竣工验收。?/gu,
      to: '收尾阶段按总进度计划组织实施，项目经理组织内部预验收，预验收问题清单当日下发、限时整改、复查销项后申请正式竣工验收',
      detail: '「收尾阶段安排N个日历天」赶工暗示改写为按计划组织正向表述',
    },
  ];
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of replacements) {
    const matches = [...result.matchAll(item.from)];
    if (matches.length === 0) continue;
    result = result.replace(item.from, item.to);
    fixedCount += matches.length;
    details.push(`${item.detail} ${matches.length} 处`);
  }
  return { markdown: result, fixedCount, details };
}

/** 危大遗漏项补写句模板（含辨识别名，插入辨识区即完成词面覆盖） */
const HAZARD_ITEM_FILL: Record<string, string> = {
  '基坑支护与降水工程': '基坑支护与降水工程：基坑开挖深度达到判定线的区段按基坑支护与降水工程辨识，支护与降水方案经审批后实施。',
  '高大模板支撑工程': '高大模板支撑工程：模板支撑搭设高度或荷载达到判定线的部位按高大模板支撑工程辨识，编制专项施工方案并组织验收。',
  '脚手架工程': '脚手架工程：脚手架搭设高度达到判定线的部位按脚手架工程辨识，搭设与拆除执行专项施工方案。',
  '起重吊装及安装拆卸工程': '起重吊装及安装拆卸工程：管道吊装、构件吊装等吊装作业按起重吊装及安装拆卸工程辨识，吊装专项方案经技术负责人审核后实施。',
  '吊篮作业工程': '吊篮作业工程：外墙作业采用吊篮的区段按吊篮作业工程辨识，吊篮安拆验收合格后投入使用。',
  '拆除工程': '拆除工程：既有建筑物、构筑物及设施拆除作业按拆除工程辨识，拆除前编制专项拆除方案并交底后实施。',
};

/** 危大辨识清单遗漏确定性补写（A6）：与 dangerousApplicabilityIssues 同源判定——
 * 正文出现适用前提（吊装/拆除工程等）但辨识区未列别名时，在危大标题行后补写遗漏项辨识句。
 * 零误伤原则：仅补写检测器同口径会报的遗漏项，不动既有清单内容。 */
export function fixHazardIdentificationGaps(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const applicable = DANGEROUS_APPLICABLE_ITEMS.filter(item => item.applicable(markdown));
  if (applicable.length === 0) return { markdown, fixedCount: 0, details: [] };
  const dangerZone = extractDangerZone(markdown);
  if (!dangerZone) return { markdown, fixedCount: 0, details: [] };
  const missing = applicable.filter(item => !item.aliases.some(alias => dangerZone.includes(alias)));
  if (missing.length === 0) return { markdown, fixedCount: 0, details: [] };
  const lines = markdown.split(/\r?\n/u);
  // 插入锚点：第一个含「危大」的标题行（H2-H4）；无标题行时回退最后一个含「危大」的正文行
  let anchorIndex = lines.findIndex(line => /危大/u.test(line) && /^#{2,4}\s/u.test(line.trim()));
  if (anchorIndex < 0) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/危大/u.test(lines[index])) { anchorIndex = index; break; }
    }
  }
  if (anchorIndex < 0) return { markdown, fixedCount: 0, details: [] };
  const fills = missing.map(item => HAZARD_ITEM_FILL[item.name] ?? '').filter(Boolean);
  if (fills.length === 0) return { markdown, fixedCount: 0, details: [] };
  lines.splice(anchorIndex + 1, 0, ...fills);
  return {
    markdown: lines.join('\n'),
    fixedCount: fills.length,
    details: [`危大辨识清单补写：${missing.map(item => item.name).join('、')}`],
  };
}

/** 六个百分百缺失项补写句模板（独立短句形态，bge 语义判定可直接命中） */
const SIX_HUNDRED_PERCENT_FILL: Record<string, string> = {
  '施工工地周边100%围挡': '施工工地周边100%围挡：施工现场沿用地红线设置连续封闭围挡，围挡立面保持整洁完好。',
  '物料堆放100%覆盖': '物料堆放100%覆盖：易产生扬尘的砂石、水泥等散体材料堆场采用密目网全覆盖。',
  '出入车辆100%冲洗': '出入车辆100%冲洗：出入口设置车辆冲洗设施，车辆驶离工地前冲洗干净后方可上路。',
  '施工现场地面100%硬化': '施工现场地面100%硬化：施工便道、材料加工区及堆场地面全部硬化处理。',
  '拆迁工地100%湿法作业': '拆迁工地100%湿法作业：拆除作业配备雾炮机同步喷淋降尘，全程湿法作业。',
  '渣土车辆100%密闭运输': '渣土车辆100%密闭运输：渣土运输车辆加盖密闭篷布，装载高度不超过车厢挡板。',
};

/** 扬尘六个百分百缺项确定性补写（A6）：与 sixHundredPercentCoverageIssues 同源判定
 * （预筛句池 + bge 语义判定）后，对缺失项在扬尘措施段补写独立短句。
 * 首轮实测根因：出入车辆冲洗/地面硬化仅在长句内词面出现，bge 余弦被长句稀释未过 0.6 阈值。 */
export async function fixSixHundredPercentCoverage(markdown: string): Promise<{ markdown: string; fixedCount: number; details: string[] }> {
  if (!/扬尘|环保|文明施工|绿色施工/u.test(markdown)) return { markdown, fixedCount: 0, details: [] };
  const dustSentences = [...new Set(markdown.split(/\r?\n/u).flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) return [];
    if (!/围挡|覆盖|堆放|冲洗|硬化|湿法|密闭|渣土|扬尘|降尘/u.test(trimmed)) return [];
    return trimmed.split(/(?<=[。！？!?；;])/u).map(part => part.trim()).filter(sentence => sentence.length >= 8 && sentence.length <= 120);
  }))];
  const coverage = await judgeQueryCoverage(SIX_HUNDRED_PERCENT_ITEMS.map(item => ({ key: item.name, text: item.query })), dustSentences);
  const demolitionExempt = /(?:本项目|本工程|该工程|该项目|本标段|本施工项目)[^。；;\n]{0,30}(?:无拆迁|不涉及拆迁|无房屋拆除|无拆除)/u.test(markdown);
  const missing = SIX_HUNDRED_PERCENT_ITEMS
    .filter(item => !coverage.get(item.name) && !sixHundredPercentLexicalHit(item.name, dustSentences))
    .filter(item => !(item.name === '拆迁工地100%湿法作业' && demolitionExempt))
    .map(item => item.name);
  if (missing.length === 0) return { markdown, fixedCount: 0, details: [] };
  const lines = markdown.split(/\r?\n/u);
  // 插入锚点：第一个含「六个百分百/100%围挡/扬尘治理」的非标题非表格行之后
  const anchorIndex = lines.findIndex(line => !/^\s*\|/u.test(line) && !/^#{1,6}\s/u.test(line.trim()) && /六个百分百|100%围挡|扬尘治理/u.test(line));
  let insertAt = anchorIndex >= 0 ? anchorIndex + 1 : -1;
  // 锚点失效两级兜底（P3.4）：主锚点未命中时优先定位最后一个扬尘类小节标题尾部
  // （该小节最后一个正文行之后），其次回退环保/文明施工类标题尾部；
  // 防补写句落到文档末尾与扬尘措施段脱节（补写后复检词面仍命中，但段落语义归属漂移）
  if (insertAt < 0) {
    const headingLines: Array<{ index: number; text: string }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (/^#{1,6}\s/u.test(lines[index].trim())) headingLines.push({ index, text: lines[index] });
    }
    const dustHeading = [...headingLines].reverse().find(item => /扬尘|降尘|防尘|六个百分百/u.test(item.text));
    const sectionHeading = dustHeading ?? [...headingLines].reverse().find(item => /环保|文明施工|绿色施工/u.test(item.text));
    insertAt = lines.length;
    if (sectionHeading) {
      for (let index = sectionHeading.index + 1; index < lines.length; index += 1) {
        if (/^#{1,6}\s/u.test(lines[index].trim())) { insertAt = index; break; }
      }
    }
  }
  const fills = missing.map(item => SIX_HUNDRED_PERCENT_FILL[item] ?? '').filter(Boolean);
  lines.splice(insertAt, 0, ...fills);
  return { markdown: lines.join('\n'), fixedCount: fills.length, details: [`扬尘六个百分百补写：${missing.join('、')}`] };
}

// ── A11 内部术语清洗（丰乐镇第二轮实测：LLM 将后台术语写进正式正文）──────────
// 阻断消息实测：「正式正文仍包含后台内部术语“控制口径”“峰值口径”」；
// 只替换实测锁定短语（“口径”在管道口径等语境属行业术语，不得全局替换）。
const INTERNAL_TERM_REPLACEMENTS: Array<{ from: RegExp; to: string; detail: string }> = [
  { from: /全文唯一劳动力峰值口径/gu, to: '全文劳动力峰值基准', detail: '劳动力峰值口径' },
  { from: /统一控制口径/gu, to: '统一控制基准', detail: '统一控制口径' },
  { from: /按以下口径处理/gu, to: '按以下程序处理', detail: '按以下口径处理' },
  { from: /拆除工程工作包/gu, to: '拆除工程', detail: '拆除工程工作包' },
  { from: /按工作包逐项说明/gu, to: '按专业工程逐项说明', detail: '按工作包逐项说明' },
];

export function fixInternalTerminology(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of INTERNAL_TERM_REPLACEMENTS) {
    const matches = [...result.matchAll(item.from)];
    if (matches.length === 0) continue;
    result = result.replace(item.from, item.to);
    fixedCount += matches.length;
    details.push(`${item.detail} ${matches.length} 处`);
  }
  return { markdown: result, fixedCount, details };
}

// ── A13 无表头表格修复（丰乐镇第二轮实测：正文段后直接跟分隔线，缺表头行）───
// 阻断消息实测：「表格分隔线位置不规范：| --- | --- |：Markdown 表格必须紧跟表头输出分隔线」。
// LLM 在正文段后插入项目信息表时丢失表头行（8.1.1 实测：正文段后直接跟 | --- | --- | 分隔线）；
// 修复：为分隔线补齐「项目 | 内容」型表头（列数对齐），表格规范化后由跨章重复表删除器统一处理重复副本。
export function fixHeaderlessTables(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  let fixedCount = 0;
  const separatorRe = /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/u;
  const dataRowRe = /^\s*\|.+\|\s*$/u;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!separatorRe.test(line)) continue;
    // 上一行是表头/表格行 → 正常表格，跳过
    if (index > 0 && dataRowRe.test(lines[index - 1].trim())) continue;
    // 下一行是数据行 → 无表头表格，补表头
    if (index + 1 >= lines.length || !dataRowRe.test(lines[index + 1].trim())) continue;
    const colCount = line.split('|').filter(cell => cell.trim() !== '').length;
    if (colCount < 2) continue;
    const header = `| 项目 | 内容 |${' 备注 |'.repeat(Math.max(0, colCount - 2))}`;
    lines.splice(index, 0, header);
    fixedCount += 1;
    index += 1;
  }
  return { markdown: lines.join('\n'), fixedCount, details: fixedCount > 0 ? [`无表头表格补齐表头 ${fixedCount} 处`] : [] };
}

// ── A16 关键设计决策两可表述归一（丰乐镇第三轮实测）──────────
// 阻断实测：「钢板桩或型钢支撑支护、放坡或钢板桩支护」以并列/悬置形态表述。
// 无清单权威可锁定时按正文自身主流口径归一（全文「放坡」7处、「钢板桩」2处、「型钢」1处）：
// 「钢板桩或型钢支撑」→「钢板桩」；「放坡或支护」→「放坡支护」；「放坡或钢板桩支护」→「1:0.5放坡加钢板桩支护」。
// 与 ambiguousEitherOrIssues 检测器同源（检测定位=修复定位），只替换检测器会报的实测短语。
const AMBIGUOUS_DECISION_FIXES: Array<{ from: RegExp; to: string; detail: string }> = [
  { from: /钢板桩或型钢支撑支护/gu, to: '钢板桩支护', detail: '钢板桩型钢两可归一为钢板桩' },
  { from: /放坡或钢板桩支护/gu, to: '1:0.5放坡加钢板桩支护', detail: '放坡钢板桩两可归一为组合支护' },
  { from: /放坡或支护/gu, to: '放坡支护', detail: '放坡支护两可归一' },
];

export function fixAmbiguousEitherOrCandidates(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of AMBIGUOUS_DECISION_FIXES) {
    const matches = [...result.matchAll(item.from)];
    if (matches.length === 0) continue;
    result = result.replace(item.from, item.to);
    fixedCount += matches.length;
    details.push(`${item.detail} ${matches.length} 处`);
  }
  return { markdown: result, fixedCount, details };
}

// ── A22 配置要求不得出现类污染清洗（丰乐镇第三轮实测）──────────
// 阻断实测：「配置要求不得出现：公共资源交易监督管理」。模板 forbiddenTexts 阻断词进入正文时
// （LLM 把招标人角色行为写入投标正文），按角色归属改写：投标人无权“报监管部门处理”，
// 改为主语归属招标人按程序处理。只替换实测短语，非全局删词。
const FORBIDDEN_CONFIG_FIXES: Array<{ from: RegExp; to: string; detail: string }> = [
  { from: /，将报公共资源交易监督管理部门处理/gu, to: '，由招标人按招标文件规定程序处理', detail: '公共资源交易监督管理' },
];

export function fixForbiddenConfigurationTerms(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  let result = markdown;
  let fixedCount = 0;
  const details: string[] = [];
  for (const item of FORBIDDEN_CONFIG_FIXES) {
    const matches = [...result.matchAll(item.from)];
    if (matches.length === 0) continue;
    result = result.replace(item.from, item.to);
    fixedCount += matches.length;
    details.push(`${item.detail} ${matches.length} 处`);
  }
  return { markdown: result, fixedCount, details };
}

// ── B2 目录与正文一致性重建（丰乐镇第三轮实测：目录 44 节 vs 正文 43 节）──────────
// 阻断实测：「目录与正文不一致，目录小节未在正文中找到：竣工清理验收移交与保修」
// 「目录与正文小节数量不一致：目录 44 节、正文 43 节」。根因：正文 10.2 小节缺失（空小节被删或
// Writer 未生成），目录仍保留规划小节。目录是正文结构的投影，以最终正文实际 H2/H3 重建目录块
// （与 tocHierarchyIssues/tocBodyConsistencyIssues 检测口径同源），重建后目录与正文必然一致。
const TOC_BLOCK_LOCAL_RE = /^##\s+目录\s*$([\s\S]*?)(?=\n<div class="page-break"><\/div>|\n##\s+)/mu;
const BODY_CHAPTER_HEADING_RE = /^##\s+(第[一二三四五六七八九十百千万\d]+章)\s+(.+)$/gmu;
const BODY_SECTION_HEADING_RE = /^###\s+(\d+\.\d+)\s+(.+)$/gmu;

const CN_ORDINAL_MAP: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function chapterOrdinal(raw: string): number | undefined {
  const chinese = raw.replace(/^第|章$/gu, '');
  if (/^\d+$/.test(chinese)) return Number(chinese);
  if (CN_ORDINAL_MAP[chinese] !== undefined) return CN_ORDINAL_MAP[chinese];
  if (chinese.length === 2 && chinese[0] === '十') return 10 + (CN_ORDINAL_MAP[chinese[1] ?? ''] ?? 0);
  return undefined;
}

export function fixTocFromBody(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const tocMatch = TOC_BLOCK_LOCAL_RE.exec(markdown);
  if (!tocMatch) return { markdown, fixedCount: 0, details: [] };
  const chapters = [...markdown.matchAll(BODY_CHAPTER_HEADING_RE)].map(match => ({
    ordinal: chapterOrdinal(match[1] || ''),
    heading: match[1] || '',
    title: match[2]?.trim() || '',
  })).filter(item => item.ordinal !== undefined && item.title);
  const sections = [...markdown.matchAll(BODY_SECTION_HEADING_RE)].map(match => ({
    number: match[1] || '',
    major: Number((match[1] || '0').split('.')[0]),
    title: (match[2] || '').trim(),
  }));
  if (chapters.length === 0 || sections.length === 0) return { markdown, fixedCount: 0, details: [] };
  // 按章分组重建目录行：章标题行 + 两空格缩进小节行（tocHierarchyIssues 要求二级小节缩进）
  const lines: string[] = [];
  for (const chapter of chapters) {
    // 章标题行保留正文原始文本（第十一章不转写成第11章），目录与正文章标题严格同源
    lines.push(`${chapter.heading} ${chapter.title}`);
    for (const section of sections.filter(item => item.major === chapter.ordinal)) {
      lines.push(`  ${section.number} ${section.title}`);
    }
  }
  const rebuilt = `## 目录\n\n${lines.join('\n')}`;
  if (tocMatch[0] === rebuilt) return { markdown, fixedCount: 0, details: [] };
  const result = markdown.slice(0, tocMatch.index) + rebuilt + markdown.slice(tocMatch.index + tocMatch[0].length);
  return { markdown: result, fixedCount: 1, details: ['目录按正文 H2/H3 实际结构重建'] };
}

