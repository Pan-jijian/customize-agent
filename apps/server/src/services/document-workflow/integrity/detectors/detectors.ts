/**
 * integrity/detectors：确定性检测器组（P4 拆分，逐字机械搬移自 documentIntegrityChecks.ts）。
 * 依赖 authorities（权威口径）；被 fixers 依赖（修复器锚定检测器）。
 */
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel, SpecAuthorityMap, TenderRequirementModel, ValidationIssue } from '../../types';
import { documentTextLength } from '../../budget';
import { BOOK_TITLE_CITATION_RE, stableHash, stringifyFactValue } from '../../utils';
import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from '../../semanticSimilarity';
import { buildSemanticGate } from '../../semanticGate';
import { isQualificationSectionTitle } from '../../evidenceContentSafety';
import { LABOR_STAGE_LIMIT_WORDS, PEAK_LABOR_RE, PILE_SUPPORT_LITERAL_RE, TRADE_WORKER_WORD_RE, cnNumberToArabic, collectLaborTableBlocks, excavationDepthFromFacts, extractGreeningMaintenanceAuthority, extractStreetLightAuthority, flexNamePattern, laborPeakStageOf, quantityUnitVariants } from '../authorities/authorities';
import type { SupportSystemAuthorityKind } from '../authorities/authorities';
import { longestCommonHanSubstring } from '../../numericalConsistency';

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
    if (sum !== total) {
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

const STAGE_LABOR_RE = /(?:阶段|期间)[^。；;\n]{0,12}?(?:约)?\s*([\d,]+)\s*人/g;
// h14 扩围（评分报告 P2）：「主体阶段投入劳动力约110人」无「高峰」词，「劳动力高峰150～180人」
// 与明细「木工40+钢筋35+混凝土20+吊装25=120人」三口径并存时原 PEAK_LABOR_RE 漏抓 110/120 两处，
// 导致跨口径矛盾漏检——反向口径（劳动力/作业人员词在前、数字在后）并入同一提取池

export const LABOR_COUNT_RE = /(?:劳动力|作业人员|施工人员)[^。；;\n]{0,16}?(?:约)?\s*([\d,]+)\s*人/g;

/**
 * V5 P6 阶段短语提取（检测器家族共用）：数字前「X阶段」短语的阶段名归属——
 * 修复声明回指句「…该阶段劳动力按蓝图推导统一为238人」中「该阶段」是回指不作阶段名，
 * 需回溯实义阶段。限定在本值所在句的末逗号段内搜索（与 laborPeakStageOf 的 boundary/cut
 * 同源，防跨句/跨列举段继承假阶段——N1-7「分阶段投入。高峰期20人」不得从「分阶段」
 * 取到阶段名）；段内从右往左取第一个非指代候选：候选为词表词（LABOR_STAGE_LIMIT_WORDS）
 * 缩写（「主体阶段」「装饰阶段」是「主体结构」「装饰装修」简称）不作限定（h14 契约）；
 * 完整词表词返回本体（与 laborPeakStageOf 零漂移：P1 多链同行互查、N1-13 依赖两者
 * 字符串相等）；自造阶段返回「X阶段」形态（N1-11/N1-12 契约）。
 */
function extractStagePhrase(markdown: string, lineStart: number, valueIndex: number): string | undefined {
  const boundary = Math.max(
    markdown.lastIndexOf('。', valueIndex),
    markdown.lastIndexOf('；', valueIndex),
    markdown.lastIndexOf(';', valueIndex),
    markdown.lastIndexOf('\n', valueIndex),
  );
  let segment = markdown.slice(Math.max(lineStart, boundary + 1), valueIndex);
  const cut = Math.max(segment.lastIndexOf('，'), segment.lastIndexOf(','), segment.lastIndexOf('、'));
  if (cut >= 0) segment = segment.slice(cut + 1);
  const candidates = [...segment.matchAll(/([^，,。；;、\n]{1,14})阶段/gu)].map(match => match[1]);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const name = candidates[index];
    if (!name || /^(?:该|本|此|上述|这|其|相应|各)$/u.test(name)) continue;
    const exact = LABOR_STAGE_LIMIT_WORDS.find(word => word === name);
    if (exact) return exact;
    if (LABOR_STAGE_LIMIT_WORDS.some(word => word.startsWith(name))) continue;
    return `${name}阶段`;
  }
  return undefined;
}

// 阶段限定词（长词优先避免子串混淆）：不同施工阶段的峰值天然不同（地下结构 220 vs 室外工程 90 不互斥），
// 仅同阶段或无阶段限定的峰值才参与互斥比较（真实生成「220 vs 90」误报根因）。
// A2（4.12.23）提取为模块级：检测器与确定性修复器共用同一阶段归属口径，避免双份实现漂移。
// h17：补齐「施工准备/土方/临时设施/拆除」等前置阶段词——分阶段明细表行「施工准备阶段劳动力62人」
// 因阶段词缺失被误判为总口径峰值与 186 互斥（第九次回归门禁误报根因）

const MANAGEMENT_PERSONNEL_WORD_RE = /项目经理|技术负责人|项目班子|管理人员|管理层|施工员|质量员|质检员|安全员|材料员|资料员|测量员|试验员|造价员|预算员/u;

export function laborGroupOf(markdown: string, valueIndex: number, lineStart: number): { group: 'management' | 'trade' | 'peak'; trade?: string } {
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
      // V5 P6 修复声明句豁免（run1 实测根因）：以蓝图为准的统一声明确认值（「该阶段劳动力按蓝图
      // 推导统一为238人」生成器/修复器产物）不属正文口径宣称，不参与互斥池——否则 238/242/269
      // 同批声明值两两假互斥（去阈值后差 1.7% 也报）；声明值本身与蓝图的吻合性由蓝图引用
      // 检测器（blueprintCitationConsistencyIssues）把关，此处跳过不放行数据错误
      if (/按蓝图[^。；;\n]{0,16}?(?:统一|调整|修正|核定)\s*(?:为|至)\s*$/u.test(markdown.slice(Math.max(0, valueIndex - 40), valueIndex))) continue;
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
        // V5 P6：阶段提取走 extractStagePhrase（回指/词表缩写/末段限定同源），STAGE 模式保持
        // 「X阶段」后缀形态（N1-13b 契约：STAGE 形态与词表本体的字符串不等属跨形态隔离一部分）
        const stagePhrase = extractStagePhrase(markdown, lineStart, valueIndex);
        const stage = pattern === STAGE_LABOR_RE
          ? (stagePhrase === undefined ? '' : stagePhrase.endsWith('阶段') ? stagePhrase : `${stagePhrase}阶段`)
          : (stagePhrase ?? laborPeakStageOf(markdown, valueIndex) ?? '');
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
  // 模式 1：正文峰值全量互查——多处「高峰期 X 人」不同数值即互斥（阶段限定不同的峰值除外）。
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
      // vs 室外工程阶段高峰 90 人），总人数低于阶段峰值即矛盾进入互斥比较（真实生成误报根因）
      if (!a.stage !== !b.stage) {
        const [total, staged] = a.stage ? [b, a] : [a, b];
        if (total.value >= staged.value) continue;
      }
      const diff = Math.abs(a.value - b.value) / Math.max(a.value, b.value);
      if (a.value !== b.value) {
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
    if (max !== min) {
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
    // D1 蓝图权威豁免：正文峰值已对齐蓝图劳动力峰值时不与表峰值互查——蓝图是造价锚定最高权威，
    // 表峰值与蓝图的差异属表格口径问题（确定性修复器以蓝图值为准统一正文），
    // 若继续互查会把已对齐的正文再拉回表峰值，与蓝图引用检测形成修复循环
    const alignedToBlueprint = laborPeakAuthority !== undefined && laborPeakAuthority > 0 && maxBodyPeak === laborPeakAuthority;
    if (maxBodyPeak > tablePeak && !alignedToBlueprint) {
      const maxText = peakGroupPeaks.find(entry => entry.value === maxBodyPeak)?.text || '';
      laborIssue(
        `劳动力数据矛盾：正文表述“${maxText}”达 ${maxBodyPeak} 人，而分阶段投入明细表最大峰值为 ${tablePeak} 人（超出 ${Math.round(((maxBodyPeak - tablePeak) / tablePeak) * 100)}%）`,
        '劳动力投入数据必须全文统一：以分阶段明细表为准复核正文峰值表述，删除与表格矛盾的“高峰期 X 人”措辞或调整表格数据。',
      );
    }
  }
  // 模式 6：总量控制上限 vs 峰值（真实生成回归：正文「高峰期总人数控制在260人」与
  // 「主体阶段高峰投入约300人/装饰阶段高峰投入约350人」并存——控制上限语义下超限即矛盾，
  // 不设差值阈值，任何超出即互斥（260 vs 350 相邻数值矛盾也必须拦截）
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
  // 不等即报；算式左侧求和 ≠ 右侧结果也报（同一解析两条通道）。「约/近/余/左右」近似措辞
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
      if (sum !== total) {
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
        if (Number.isFinite(claimValue) && claimValue > 0 && !isApprox && claimValue !== total) {
          laborIssue(
            `劳动力数据矛盾：正文宣称总人数 ${claimValue} 人与班组加总算式结果 ${total} 人自相矛盾（相差 ${Math.round((Math.abs(claimValue - total) / Math.max(claimValue, total)) * 100)}%）`,
            '宣称总人数必须与班组加总一致：统一总人数与各班组人数，删除矛盾数字。',
          );
        }
      }
    }
  }
  // 模式 4：合计行 vs 明细行之和——同一表内汇总行人数必须等于明细行人数之和（不一致即报）
  for (const block of tableBlocks) {
    if (block.totalCell === undefined || block.countCells.length < 2) continue;
    const diff = Math.abs(block.totalCell - block.detailSum) / Math.max(block.totalCell, block.detailSum);
    if (block.totalCell !== block.detailSum) {
      laborIssue(
        `劳动力数据矛盾：劳动力表合计行 ${block.totalCell} 人与明细行之和 ${block.detailSum} 人不符（差 ${Math.round(diff * 100)}%）`,
        '劳动力表合计必须等于各明细行人数之和：统一合计行与明细行数据，删除矛盾数字。',
      );
    }
  }
  // 模式 5：总工日推算——正文「X 工日」不得超过峰值人数×总工期天数的算术上限
  // （每天最多峰值人数参与，总工日 > 峰值×工期即算术不可能，必报）
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
    const arithmeticCeiling = maxBodyPeak * maxDays;
    if (maxWorkdays > arithmeticCeiling) {
      laborIssue(
        `劳动力数据矛盾：总工日 ${maxWorkdays} 个超过峰值 ${maxBodyPeak} 人×总工期 ${maxDays} 天的算术上限 ${arithmeticCeiling} 个，不可能成立`,
        '总工日不得超过劳动力峰值×总工期的算术上限：按各阶段人数×阶段工期重算总工日，或修正峰值人数/总工期表述。',
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

// ── 危大排除声明 vs 危大清单表格矛盾（R12，舒城第二轮实测）──
// 实测缺陷：同一节先声明「无落地式钢管脚手架搭设高度24m及以上的危大脚手架工程」
// 「无采用非常规起重设备且单件起吊重量10kN及以上的起重吊装工程」，随后的危大清单表格
// 却把 24m 脚手架、10kN 吊装列为危大工程——排除声明与清单自相矛盾，评标专家可直接质疑辨识可靠性。
// 判定口径：排除子句（无/未涉及…阈值及以上）与清单表格行按「危大类别词交集 + 参数数值单位全等」
// 三元组比对（类别、数值、单位同时相等才判矛盾），重复排除声明按三元组去重。

/** 排除声明子句（无/未涉及/不涉及/不存在 … 及以上/以上；贯穿逗号、止于句号分号换行） */
const HAZARD_EXCLUSION_CLAUSE_RE = /(?:无|未涉及|不涉及|不存在)[^。；\n]{2,120}?(?:及以上|以上)[^。；\n]{0,80}/gu;

/** 危大类别词表（住建部令第37号/建办质〔2018〕31号附件类别核心词；具体词在前保证最长匹配） */
const HAZARD_CATEGORY_TERMS = [
  '落地式钢管脚手架', '悬挑式脚手架', '附着式升降脚手架', '脚手架',
  '模板支撑', '模板工程', '起重吊装', '吊装', '幕墙', '钢结构',
  '人工挖孔', '拆除', '暗挖', '爆破', '基坑', '降排水', '降水',
] as const;
const HAZARD_CATEGORY_RE = new RegExp(HAZARD_CATEGORY_TERMS.join('|'), 'gu');

/** 阈值参数（数值+单位；排除 mm/cm/m²/m³ 类单位误匹配，单位归一 m/kN） */
const HAZARD_PARAM_RE = /(\d+(?:\.\d+)?)\s*(kN|千牛|米|m(?![m²³23/]))/gu;

function collectHazardCategories(text: string): Set<string> {
  HAZARD_CATEGORY_RE.lastIndex = 0;
  const categories = new Set<string>();
  for (const match of text.matchAll(HAZARD_CATEGORY_RE)) categories.add(match[0]);
  return categories;
}

function extractHazardParams(text: string): Array<{ value: number; unit: string }> {
  HAZARD_PARAM_RE.lastIndex = 0;
  const params: Array<{ value: number; unit: string }> = [];
  for (const match of text.matchAll(HAZARD_PARAM_RE)) {
    params.push({ value: Number(match[1]), unit: match[2] === '米' ? 'm' : match[2] === '千牛' ? 'kN' : match[2] });
  }
  return params;
}

export function hazardExclusionContradictionIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const clauses: Array<{ text: string; categories: Set<string>; params: Array<{ value: number; unit: string }> }> = [];
  HAZARD_EXCLUSION_CLAUSE_RE.lastIndex = 0;
  for (const match of markdown.matchAll(HAZARD_EXCLUSION_CLAUSE_RE)) {
    const categories = collectHazardCategories(match[0]);
    const params = extractHazardParams(match[0]);
    if (categories.size > 0 && params.length > 0) clauses.push({ text: match[0], categories, params });
  }
  if (clauses.length === 0) return issues;
  const reported = new Set<string>();
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!/^\|.+\|$/u.test(line) || !/危大/u.test(line)) continue;
    // 清单行声明「不属于危大/不构成危大」时与排除声明同向，不判矛盾
    if (/不属于危大|不构成危大|非危大|未达到危大|不是危大/u.test(line)) continue;
    const rowCategories = collectHazardCategories(line);
    if (rowCategories.size === 0) continue;
    const rowParams = extractHazardParams(line);
    if (rowParams.length === 0) continue;
    for (const clause of clauses) {
      const category = HAZARD_CATEGORY_TERMS.find(term => rowCategories.has(term) && clause.categories.has(term));
      if (!category) continue;
      const hit = rowParams.find(param => clause.params.some(other => other.unit === param.unit && Math.abs(other.value - param.value) < 1e-9));
      if (!hit) continue;
      const key = `${category}|${hit.unit}|${hit.value}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const cells = line.split('|').map(cell => cell.trim()).filter(Boolean);
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `危大清单与排除声明矛盾：正文声明「${clause.text.replace(/\s+/gu, '').slice(0, 36)}」，危大清单表格却将「${category} ${hit.value}${hit.unit}」列为危大工程（清单行「${cells.slice(0, 2).join('：').slice(0, 40)}」）`,
        suggestion: '排除声明与危大清单必须同口径二选一（以资料参数为准）：若资料证实存在该类别且达到判定阈值，删除正文排除声明、保留清单行并按危大工程管控；若资料不能证实，删除清单中该行及其下游专项方案/验收表述，不得两处自相矛盾。',
      });
    }
  }
  return issues.slice(0, 3);
}

// ── 7. 六个百分百逐项覆盖（R8）：扬尘治理六项要求逐项命中，零散措施不等于体系响应 ──

/** 扬尘六个百分百六项（招标规范固定封闭集）：每项一条语义判定 query（国家规范固定条目名）。
 * 判定口径（四层分离架构，W2/P1 改造）：纯语义判定，本地 bge 余弦 ≥0.6（本地 ONNX 推理恒可用，
 * 无不可用降级路径，判定语义全权由 bge 负责）。 */

export const SIX_HUNDRED_PERCENT_ITEMS = [
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

export async function judgeQueryCoverage(queries: Array<{ key: string; text: string }>, sentences: string[]): Promise<Map<string, boolean>> {
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

export function sixHundredPercentLexicalHit(name: string, sentences: string[]): boolean {
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
  // 工伤保险：劳务/农民工内容存在时必须有工伤保险缴纳表述（政策合规类，不限地域）。
  // 词面门控先剥离书名号引用：编制依据类别清单引用《保障农民工工资支付条例》等法规名，
  // 引用法规名称不构成「正文存在劳资管理内容」，剥离后纯引用文档不误报
  const laborContentText = markdown.replace(BOOK_TITLE_CITATION_RE, '');
  if (/(?:劳务|农民工|工资)/u.test(laborContentText) && !coverage.get('workInjury')) {
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

export const PARAGRAPH_START_RE = new RegExp(`(?:^|${NL})(?:#{1,6}\\s+[^${NL}]*${NL}+)?([^${NL}|#][^。！？!?${NL}]{18,60})[。！？!?]`, 'gu');

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

/** 概况复述判定：与概况章正文连续重合的汉字数下限。
 * 项目名逐字搬用实测连续重合 16 字以上；“施工组织设计/专项施工方案”等通用词最长 6 字，
 * 8 字界线把项目名级复述与通用词区分开（工程文档不接受语义相似度分数判定）。 */
const RECAP_VERBATIM_HAN_RUN_MIN = 8;
/** 概况复述判定：范围项最少汉字数（“人行道”3 字起；“道路/排水”等二字通用词不计数） */
const RECAP_SCOPE_ITEM_MIN_HAN = 3;

/** 概况复述的字符级确定性判定（替代语义相似度分数）：
 * ① 复述句与概况章正文连续 ≥8 个汉字完全相同——项目名称/整句被逐字搬用；
 * ② 复述句摘抄 ≥2 个顿号分隔的范围项且各项在概况正文逐字出现
 *    （如“公共广场、停车场、人行道、慢行步道”清单被搬用）。 */
function overviewRecapHit(sentence: string, overviewHan: string) {
  if (longestCommonHanSubstring(sentence, overviewHan) >= RECAP_VERBATIM_HAN_RUN_MIN) return true;
  const scopeItems = sentence.split('、')
    .map(item => (item.match(/[\p{Script=Han}]/gu) || []).join(''))
    .filter(item => item.length >= RECAP_SCOPE_ITEM_MIN_HAN);
  return scopeItems.filter(item => overviewHan.includes(item)).length >= 2;
}

export function overviewRecapIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { overviewBody, sentences } = overviewRecapCandidates(markdown);
  if (sentences.length === 0 || !overviewBody) return issues;
  const overviewHan = (overviewBody.match(/[\p{Script=Han}]/gu) || []).join('');
  if (!overviewHan) return issues;
  const recaps: string[] = [];
  for (const sentence of sentences) {
    if (overviewRecapHit(sentence, overviewHan)) recaps.push(sentence.slice(0, 36));
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
    // P9 provenance：快照 issue 携带检测器身份与指纹，重算校验组时按 detectorId 剔除旧快照，
    // 由 documentFinalValidation 注册表（overview-recap）对最新 finalMarkdown 实时重跑重新生成
    provenance: { detectorId: 'overview-recap', fingerprint: stableHash(markdown) },
  });
  return issues;
}

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
  // 第十六版漏网扩展：四新小节自曝「未采用行业认定的新技术」属明确自伤（评分含四新应用条目）
  '本项目未采用行业认定的新技术、新工艺、新设备、新材料',
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
  // V5 P6 确定性负向词前置过滤（run1 实测 3/3 假召回：界面处理巡查句、隔断垂直度句、卫生器具
  // 调试记录句均被 bge 余弦误召回）——自伤表述必然含负向词（尚未/未完成/存在缺口/待补充…），
  // 负向词未命中的句子不进入候选（「语义仅出候选」定位不变，召回前置一道确定性闸，防误报进修复轮）。
  // R9 契约（分包否定式自述必须召回）：「本工程不进行分包」类负面自述无通用负向词面，由
  // 「不进行分包|不再分包|不转包」形态覆盖（fixSelfUnderminingCandidates 同源配套改写：
  // 检测召回 ↔ 确定性修复通道一一对应，不得单向失配）
  const UNDERMINING_NEGATIVE_RE = /尚未|未完成|未明确|未采用|未落实|未确定|未闭合|存在缺口|有待|待补充|待完善|跟踪完善|不够|不明确|缺失|缺少|缺乏|风险较大|难以保证|无法保证|正在办理|暂未|未能|需进一步|不进行分包|不再分包|不转包/u;
  const underminingSimilarity = await buildSemanticSimilarity(sentences, [...SELF_UNDERMINING_QUERIES]);
  const hits = [...new Set(sentences.filter(sentence =>
    UNDERMINING_NEGATIVE_RE.test(sentence)
    && !POSITIVE_SELF_REFERENCE_RE.test(sentence)
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

export const FINISH_THICKNESS_CONTEXT_WORD = '抹面|打底|找平|坐浆|结合层|粘结层|罩面|批嵌|腻子';

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

export function laborPeakConflictIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const totalValues = [...markdown.matchAll(/高峰期总人数(\d+)人|劳动力总人数(\d+)人|总人数(\d+)人/gu)].map(match => Number(match[1] || match[2] || match[3])).filter(value => value > 0);
  const peakValues = [...markdown.matchAll(/高峰(?:期)?人数(\d+)人|峰值(?:需求|人数)?[为约]?(\d+)人/gu)].map(match => Number(match[1] || match[2])).filter(value => value > 0);
  const totalSet = [...new Set(totalValues)];
  const peakSet = [...new Set(peakValues)];
  const conflicts = totalSet.filter(total => peakSet.some(peak => peak !== total));
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
  // F15 同工种跨表高峰人数比对：每表每工种取表内最大值（分阶段表内多行合法），跨表同工种不同数值 → error
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
  const tradeConflicts = [...tradePeaksByTable.entries()].filter(([, values]) => values.length >= 2 && new Set(values).size >= 2);
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

// eslint-disable-next-line no-control-regex -- [^\u000A] 与原始 [^\n] 语义等价（编辑工具会破坏字面换行转义，改用 unicode 转义）
export const META_DECLARATION_RE = /不再另行(?:出现|统计|编制|设置|单列|重复)[^。；;\u000A]{0,40}|以[^。；;\u000A]{0,16}为唯一[^。；;\u000A]{0,24}不再[^。；;\u000A]{0,20}|不再另行[^。；;\u000A]{0,24}/gu;

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

export const COMMERCIAL_TERM_RE = /暂列金额|暂估价|报价明细|综合单价|清单合价|预留金|投标报价|异常低价|评标基准价/u;

export const COMMERCIAL_RATE_RE = /(?:税率|增值税)[^。；;\n]{0,12}\d/u;
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

export const SCHEDULE_NODE_ANCHORS = [
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

export const CROSS_SECTION_ANCHORS = [
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
  // 十五版评分报告实测：市政机械配置四套互相矛盾的数字（挖掘机 5/4/9/1、自卸 5/6/1、压路机 5/9/1、
  // 蛙夯 5/6/1、搅拌车 2/3、洒水车 5/2/9、高空车 3/2）未被任何一致性锚点拦截。表格行内的机械台数
  // 是权威配置表数值，窗口允许竖线（与 scheduleDays 排除竖线的理由相反——机械总表本身就是权威源）；
  // 窗口 40 字覆盖「挖掘机 | 斗容量… | 5台」跨列形态；正向模式排除顿号/逗号防跨枚举项误采。
  {
    key: 'excavator', label: '挖掘机数量', unit: '台', kind: 'number' as const,
    patterns: [
      /(?:履带式)?挖掘机[^。；;\n、，]{0,40}?(\d+)\s*台/gu,
      /(\d+)\s*台[^、，。；\n|]{0,12}?(?:履带式)?挖掘机/gu,
    ],
  },
  {
    key: 'dumpTruck', label: '自卸汽车数量', unit: '台/辆', kind: 'number' as const,
    patterns: [
      /自卸汽车[^。；;\n、，]{0,40}?(\d+)\s*(?:台|辆)/gu,
      /(\d+)\s*(?:台|辆)[^、，。；\n|]{0,12}?自卸汽车/gu,
    ],
  },
  {
    key: 'roller', label: '压路机数量', unit: '台', kind: 'number' as const,
    patterns: [
      /(?:振动)?压路机[^。；;\n、，]{0,40}?(\d+)\s*台/gu,
      /(\d+)\s*台[^、，。；\n|]{0,12}?(?:振动)?压路机/gu,
    ],
  },
  {
    key: 'rammer', label: '蛙式打夯机数量', unit: '台', kind: 'number' as const,
    patterns: [
      /蛙式打夯机[^。；;\n、，]{0,40}?(\d+)\s*台/gu,
      /(\d+)\s*台[^、，。；\n|]{0,12}?蛙式打夯机/gu,
    ],
  },
  {
    key: 'mixerTruck', label: '混凝土搅拌运输车数量', unit: '台', kind: 'number' as const,
    patterns: [
      /混凝土搅拌运输车[^。；;\n、，]{0,40}?(\d+)\s*台/gu,
      /(\d+)\s*台[^、，。；\n|]{0,12}?混凝土搅拌运输车/gu,
    ],
  },
  {
    // 「混凝土搅拌运输车」是独立设备（mixerTruck 锚点），「搅拌机」不含「运输车」词不串锚
    key: 'concreteMixer', label: '混凝土搅拌机数量', unit: '台', kind: 'number' as const,
    patterns: [
      /混凝土搅拌机[^。；;\n、，]{0,40}?(\d+)\s*台/gu,
      /(\d+)\s*台[^、，。；\n|]{0,12}?混凝土搅拌机/gu,
    ],
  },
  {
    key: 'sprinkler', label: '洒水车数量', unit: '台/辆', kind: 'number' as const,
    patterns: [
      /洒水车[^。；;\n、，]{0,40}?(\d+)\s*(?:台|辆)/gu,
      /(\d+)\s*(?:台|辆)[^、，。；\n|]{0,12}?洒水车/gu,
    ],
  },
  {
    key: 'aerialLift', label: '高空作业车数量', unit: '台', kind: 'number' as const,
    patterns: [
      /高空作业车[^。；;\n、，]{0,40}?(\d+)\s*台/gu,
      /(\d+)\s*台[^、，。；\n|]{0,12}?高空作业车/gu,
    ],
  },
  // 十五版评分报告实测：沟塘小节「回填方 4270m³」与「回填方总量 15481.48m³」双口径（同节互斥）；
  // V5 P6 误报收口（run1 实测）：原 pattern 无塘语境约束，把各子工程的通用回填方量（930.52/
  // 335.45/425.99/77.25…）全收集混池致跨节误报（run1 报 8 值冲突而正文无任何塘语境）——
  // 值池强制水塘/水渠语境（沟塘/水塘/池塘/河塘/鱼塘/塘内 + 渠道/淤泥/流砂/清淤）：
  // ① 语境词 → 回填方（可含「总量」）→ 值；② 语境词 → 显式「回填方总量」→ 值（窗口允许
  // 句号，抓「回填方4270m³。回填方总量15481.48m³」双口径形态）；③ 值在前、语境词在后
  // （语序反转）。run1 实测「渠道/淤泥」与任一「回填方」窗口零交集（池为空不误报）；
  // 「XX工程回填方总量Y」类分工程总量不携带水渠语境不入池（排水工程回填方总量17258.99m3
  // 等合法独立量不参与互斥）。
  {
    key: 'pondBackfill', label: '沟塘回填方量', unit: 'm³', kind: 'number' as const,
    patterns: [
      /(?:沟塘|水塘|池塘|河塘|鱼塘|塘内|渠道|淤泥|流砂|清淤)[^。；;\n|]{0,30}?回填方(?:总量)?[^。；;\n|]{0,16}?(\d+(?:\.\d+)?)\s*m[3³]/gu,
      /(?:沟塘|水塘|池塘|河塘|鱼塘|塘内|渠道|淤泥|流砂|清淤)[^；;\n|]{0,30}?回填方总量[^。；;\n|]{0,16}?(\d+(?:\.\d+)?)\s*m[3³]/gu,
      /回填方(?:总量)?[^。；;\n|]{0,16}?(\d+(?:\.\d+)?)\s*m[3³][^。；;\n|]{0,30}?(?:沟塘|水塘|池塘|河塘|鱼塘|塘内|渠道|淤泥|流砂|清淤)/gu,
    ],
  },
  // 十五版评分报告实测：同章「槽底预留200mm人工清底」vs「槽底预留300mm人工清底」矛盾
  // （机械开挖至距设计槽底标高Xmm处停止的作业范围表述不含「预留…清底」句式，不串锚）
  {
    key: 'trenchClearing', label: '沟槽槽底人工清底预留厚度', unit: 'mm', kind: 'number' as const,
    patterns: [/槽底预留(\d+)mm人工清底/gu],
  },
  // 十五版评分报告实测：房屋保护距离「距房屋3m内采用人工开挖」vs「距房屋2m范围内采用人工开挖」双口径
  // （「沟槽开挖边线外1.5m范围内」是边线距离非房屋距离，不匹配「距房屋」句式不串锚）
  {
    key: 'houseExcavation', label: '距房屋人工开挖保护距离', unit: 'm', kind: 'number' as const,
    patterns: [/距房屋(\d+(?:\.\d+)?)m(?:内|范围内)[^。；;\n|]{0,10}?人工开挖/gu],
  },
] as const;

/** 锚点实体词（V5 P4 机制对接）：设备/数量类锚点 → 蓝图权威条目匹配模式。
 * 权威派生（deriveRepairAuthorities）用本表将 equipment/quantity 域条目自动对接到 CROSS_SECTION_ANCHORS
 * 锚点 key——新增设备入蓝图即自动获得权威通道（替代人工 key 白名单）；
 * 新增设备锚点时在此登记实体词即完成权威对接（仅登记实体类，工期/村数/机动等非实体锚点从对应域直取）。 */
export const CROSS_SECTION_ANCHOR_ENTITY_RE: Record<string, RegExp> = {
  pump: /潜水泵|提升泵/u,
  towerCrane: /塔式起重机|塔吊/u,
  hoist: /施工升降机|施工电梯/u,
  truckCrane: /汽车起重机|汽车吊/u,
  rebarCutter: /钢筋切断机/u,
  rebarBender: /钢筋弯曲机/u,
  circularSaw: /圆盘锯/u,
  excavator: /挖掘机/u,
  dumpTruck: /自卸汽车|自卸车/u,
  roller: /压路机/u,
  rammer: /蛙式打夯机|打夯机/u,
  mixerTruck: /混凝土搅拌运输车|搅拌车/u,
  concreteMixer: /混凝土搅拌机/u,
  sprinkler: /洒水车/u,
  aerialLift: /高空作业车/u,
  // 器具数量类实体（清单/设备域）：灭火器/急救箱数量从数量域自动对接（旧链无此通道）
  extinguisher: /灭火器/u,
  firstaid: /急救箱/u,
};

// ── 4.18.10 清单红线权威比对（丰乐镇实测）：绿化养护期/路灯数量 ──
// 评分报告 P1：清单「喷播植草（灌木）籽：养护期二级养护，养护两年」vs 正文多处「二级养护一年」
// ——养护期是清单实质性条款，正文必须回退为清单口径；报告 P3：路灯总数存疑（正文 20 套 vs 第四版
// 约 118 套），数量以清单核定。两者均属「清单权威 → 正文比对」单向判定，不作正文互查
// （分型号明细 17+3 与总数是合法口径关系，互查会误报），也不进确定性修复
// （分型号 vs 总数替换必错，交 LLM 修复轮）。

/** 中文数字 → 阿拉伯数字（养护期常见「一年/两年」；支持「十」「十X」「X十」简单形态） */

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
  const mismatched = [...values].filter(value => value !== authority);
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

/** 路灯数量清单红线检测（评分报告 P3）：正文路灯套数与清单权威口径不一致 → blocker。
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
  if (bodyTotal === authority) return [];
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

export const ENUMERATION_VALUE_RE = /\d+(?:\.\d+)?\s*(?:mm|kVA|次|具|台|套|个)\s*[/／]\s*\d+/u;

// 否定声明句豁免：「现场统一配置1台汽车起重机，本章及后续章节不再出现“汽车吊2台”等
// 与施工部署不一致的数量表述」属 LLM 一致性声明，句内数值是引用旧矛盾值而非事实口径，
// 曾导致汽车吊 2vs1 误报（真实生成实测）

export const NEGATIVE_DECLARATION_RE = /不再出现|不得出现|严禁出现|避免出现|不采用|未采用|予以删除|已删除|取消|纠正为|更正为/u;

// F14c 跨工序切换词豁免（丰乐镇第三轮实测）：「垫层，再浇筑C30」的 C30 是垫层之上构件
// 的混凝土，20 字窗口无法区分工序，被误绑为垫层口径与 C20 互斥；匹配窗口内含工序切换词
// （再浇筑/然后浇筑/上层/上部/面层等）时该 token 属后续工序，不参与互斥池

const PROCESS_SWITCH_WORD_RE = /再浇筑|再浇|后浇筑|后浇|然后浇筑|然后再浇|上层|上部|面层浇筑|其上浇筑|浇筑完成后再/u;

// F14d 工艺参数前置词豁免（丰乐镇第三轮实测）：「浇筑时分层厚度不大于500mm」的 500mm 是
// 浇筑分层厚度工艺参数、「焊缝高度不小于4mm」的 4mm 是焊缝高度——均非该部位的构件厚度
// 规格，与权威厚度规格不可比对，40 字窗口误绑必须豁免；V5 P6 补充（run1 实测）：
// 「内厚15mm」井壁抹面工艺、「垫高不少于200mm」堆场存放工艺、「架空/离地/支垫」仓储工艺
// ——window 含此类工艺词即豁免（均属作业/存放参数，与本部位构件规格不可比对）

const PROCESS_PARAM_RE = /分层厚度|分层浇筑|分层振捣|焊缝高度|焊缝厚度|焊脚尺寸|锚固深度|保护层厚度|搭接长度|锚固长度|预留|踏步高度|踏步宽度|踏步高|踏步宽|台阶高度|台阶宽度|内厚|外厚|抹面|抹灰|粉刷|垫高|架空|离地|支垫/u;

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

export function locationGroupForMatch(markdown: string, matchIndex: number, raw: string, lineStart: number): string {
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
        // 阶段细分豁免（与蓝图引用检测器 dayRe 同源，零漂移实测）：「道路施工集中在
        // 第71日至第80日共10日历天内完成」是阶段工期细分，不参与总工期互斥池
        if (anchor.key === 'scheduleDays') {
          const digitAt = raw.indexOf(String(match[1]));
          if (digitAt >= 0 && /(?:阶段|第\d+日|至第|共|集中)/u.test(markdown.slice(Math.max(0, (match.index || 0) + digitAt - 16), (match.index || 0) + digitAt))) continue;
        }
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
        // 任何不同数值即互斥：同一设备/材料同一部位出现两套数量即口径矛盾，不设差异阈值
        //（阈值豁免会漏报相邻数值矛盾——十五版机械四套数字「挖掘机 5台 vs 4台」形态）
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
  // 上限 16：十五版真实文档机械四套数字 7 条 + 土方/清底/房屋锚点 3 条超 8 条被截断漏报；
  // 跨节冲突上限提高到 16 防截断（确定性检测零误伤，数量增加不放大修复风险）
  return issues.slice(0, 16);
}

/** 规格 token 类型推断：从权威规格值推导正则，只校验同类型规格（避免「垫层…HRB400 钢筋」误比对混凝土标号） */

function specTokenPattern(spec: string): RegExp | null {
  if (/^C\d{2,3}$/.test(spec)) return /C\d{2,3}/u;
  if (/^M\d/.test(spec)) return /M\d+(?:\.\d+)?/u;
  // V5 P6 误报收口（run1 实测）：「AP42」「IP55」中的 P42/P55 是型号/防护等级代号子串，
  // 非独立 P 规格 token——左边界排除拉丁字母前缀，只匹配独立 P 规格（「配电箱P65」仍命中）
  if (/^P\d{1,2}$/.test(spec)) return /(?<![A-Za-z])P\d{1,2}/u;
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
  // V5 P6 更长复合条目名碰撞豁免（run1 重建实测）备查表：全维度条目名集合
  const allLocations = [...new Set(Object.values(specAuthorityMap).flat().map(item => item.location).filter(Boolean))];
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
      // 权威集合同类型过滤：只有与本 placement 同 pattern 类型的 spec 才可互相比较；
      // V5 P6 宽松 token 抽取（run1 重建实测）：特征串携尾文（「C20商品砼\n2、厚度：15cm…」——
      // 白鸥观澜人行道混凝土垫层 WB040204009001 原文 C20/15cm/424.6m²）只取前缀 token——
      // 整串精确匹配会把合规规格整条排除出权威集致误报（白鸥 C20 正文被公共广场 C25 权威判错位）
      const authoritySpecs = new Set(placements
        .filter(item => item.location === location)
        .map(item => {
          const exact = specTokenPattern(item.spec);
          if (exact && exact.source === pattern.source) return item.spec;
          const loose = new RegExp(`^(?:${pattern.source})`, 'u').exec(item.spec);
          return loose ? loose[0] : null;
        })
        .filter((token): token is string => token !== null));
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
        // V5 P6 误报收口（run1 实测）：「圈梁按C20或C30分别对应不同单体」的 found C20 后紧随
        // 「或C30」同型规格——枚举声明词（分别对应）在 match 窗口之外前文豁免不覆盖，需后置
        // 枚举链判：found 后紧跟「或/[、,，/] + 同型规格」即属多规格枚举，不判错位
        if (new RegExp(`^(?:或|[、,，/])\\s*(?:${pattern.source})`, 'u').test(afterFound)) continue;
        // B6 偏差值豁免（丰乐镇第五轮实测）：「槽底预留200mm人工清底，槽底标高偏差不超过±200mm」
        // 的 ±200mm 是标高偏差值，被 40 字窗口误绑为清底预留厚度（偏差与规格属不同概念）
        const contextBefore = markdown.slice(Math.max(0, (match.index || 0)), (match.index || 0) + match[0].length);
        if (/(?:标高|高程|平整度|轴线|垂直度)[^。；;\n|]{0,10}(?:偏差|误差|不超过|不得大于|不大于)/u.test(contextBefore.slice(-28))) continue;
        // F14h 跨部位截断豁免（零漂移实测）：「C20定型混凝土管道基础307m，…涵头采用C25
      // 混凝土浇筑」的 C25 紧邻后文「涵头」部位词，属涵头规格（清单条目 18 特征原文
      // 「涵头混凝土 C25」），不是管道基础错位——窗口内 found 前 14 字出现其它部位词即跳过
      const foundAt = match[0].indexOf(found);
      // F14h 跨部位截断豁免（零漂移实测）：「C20定型混凝土管道基础307m，…涵头采用C25
      // 混凝土浇筑」的 C25 紧邻后文「涵头」部位词，属涵头规格（清单条目 18 特征原文
      // 「涵头混凝土 C25」），不是管道基础错位——found 前窗口去掉 location 自身后仍含
      // 其它部位词即跳过（含 location 自身会让正常错位恒豁免：「垫层C20」的「垫层」在词表）
      if (foundAt > location.length && /(?:涵头|面层|基层|垫层|管基|基础|梁|板|柱|墙|地坪|路面)/u.test(match[0].slice(location.length, foundAt))) continue;
      // V5 P6 更长复合条目名碰撞豁免（run1 重建实测）：「人行道混凝土垫层（C25）」的 location
      // 「垫层」是更长条目名「人行道混凝土垫层」（表内条目，权威 C25）的子串——短名扫描把长名
      // 条目的合规规格判为短名错位；仅当「前方紧邻文字+短名」构成表内更长条目且 found ∈ 该长名
      // 自身规格集时豁免（长名不匹配或其规格不一致时仍报，真错位不受影响）
      const locationStart = match.index || 0;
      const collisionLocation = allLocations.find(candidate =>
        candidate.length > location.length && candidate.endsWith(location)
        && markdown.slice(locationStart + location.length - candidate.length, locationStart + location.length) === candidate);
      if (collisionLocation) {
        const collisionSpecs = new Set(placements.filter(item => item.location === collisionLocation && specTokenPattern(item.spec)?.source === pattern.source).map(item => item.spec));
        if (collisionSpecs.has(found)) continue;
      }
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
// ①进场日达到/超过总工期属尾期进场荒谬（工程结束时设备尚未进场，绝对矛盾，不设比例阈值线）；
// ②基坑阶段设备（挖掘机/支护类）进场日晚于基坑支护完成节点日属工序倒挂（基坑做完了设备才进场）。
// 数值提取+确定性比较（L2 确定性层），设备名限定封闭词表防误采。──

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
  // ①尾期进场：进场日达到/超过总工期（设备未进场工程已结束，绝对矛盾）
  if (total !== undefined) {
    const late = entries.filter(entry => entry.day >= total);
    if (late.length > 0) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `设备进场时间荒谬：${late.slice(0, 3).map(entry => `「${entry.equipment} 第${entry.day}日进场」`).join('、')} 已达/超过总工期（${total}日历天），工程结束时设备尚未进场`,
        suggestion: `以总进度计划为准核对设备进场计划：大型施工设备必须在总工期结束前进场并完成使用，${late.map(entry => entry.equipment).join('、')} 的进场日应提前至工程开始阶段，删除矛盾的尾期进场表述。`,
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

export function extractMarkdownTables(markdown: string): MarkdownTableBlock[] {
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

export function jaccard(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter(item => rightSet.has(item)).length;
  return intersection / new Set([...leftSet, ...rightSet]).size;
}

/** 小表数据单元格在大表中的覆盖比例（多重集按出现次数计，识别「删减版子表」形态：
 * 真重复表的小表几乎完全被大表覆盖；同主题互补表（统计表 vs 投入计划表）两表各有大量独有单元格，覆盖度低） */

export function cellCoverage(small: string[], large: string[]): number {
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

export const textCellsOf = (cells: string[]) => cells.filter(cell => !NUMERIC_CELL_RE.test(cell));

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

const DUPLICATE_PARAGRAPH_MIN_CHARS = 40;

export function paragraphFingerprint(paragraph: string): string | undefined {
  const normalized = paragraph.replace(/\s+/gu, '');
  return normalized.length >= DUPLICATE_PARAGRAPH_MIN_CHARS ? normalized : undefined;
}

// ── 段落内句级复读（十五版评分报告实测 7 处）：段落结尾复读本段前 1~3 句 ──
// 各章 LLM 写作/模板化修复环节在段尾复读段内已有句子；duplicateParagraphIssues 只抓跨位置
// 整段重复，抓不到段内句级复读。本扫描按空行分块切段、按句号切句，句（去空白 ≥15 字）在
// 段内出现 ≥2 次即命中；检测器与确定性修复器同源复用（检测定位=修复定位）。

export const PARAGRAPH_TAIL_REPEAT_MIN_CHARS = 15;

/** 段落内句级复读扫描（检测器与修复器同源口径）：返回重复句及其出现次数 */
export function scanParagraphTailRepeats(markdown: string): Array<{ sentence: string; count: number }> {
  const results: Array<{ sentence: string; count: number }> = [];
  const blocks = markdown.split(/\n\s*\n/u);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // 剥除标题行/表格行后 join 切句（真实文件标题/表格与正文常无空行分隔，block 级过滤会漏掉整段；
    // 且段尾复读句可能丢前缀「为此，项目部在丰乐镇域内设置…」vs「在丰乐镇域内设置…」，需后缀包含匹配）
    const prose = trimmed
      .split(/\n/u)
      .filter(line => {
        const t = line.trim();
        return t && !/^#{1,6}\s/u.test(t) && !t.startsWith('|');
      })
      .join('\n');
    const seen: Array<{ sentence: string; count: number }> = [];
    for (const rawSentence of prose.split(/[。！？!?]/u)) {
      const sentence = rawSentence.trim().replace(/\s+/gu, '');
      if (sentence.length < PARAGRAPH_TAIL_REPEAT_MIN_CHARS) continue;
      const dupIndex = seen.findIndex(entry =>
        entry.sentence === sentence ||
        (entry.sentence.length > sentence.length &&
          entry.sentence.length - sentence.length <= PARAGRAPH_TAIL_REPEAT_MIN_CHARS &&
          entry.sentence.endsWith(sentence)),
      );
      if (dupIndex >= 0) seen[dupIndex]!.count += 1;
      else seen.push({ sentence, count: 1 });
    }
    for (const entry of seen) {
      if (entry.count >= 2) results.push({ sentence: entry.sentence, count: entry.count });
    }
  }
  return results;
}

export function paragraphTailRepeatIssues(markdown: string): ValidationIssue[] {
  const repeats = scanParagraphTailRepeats(markdown);
  if (repeats.length === 0) return [];
  // 检测级别升为 error/blocker（丰乐镇 doc-1788954795698 实测 17 处句级复读带病交付）：
  // 投标专业文档不允许同一段落内句子复读，确定性修复器（fixParagraphTailRepeats）与检测器
  // 同源（检测定位=修复定位），post-review-surface 轮在 requirement-verification 补写后兜底剥离
  return repeats.slice(0, 3).map(({ sentence, count }) => ({
    level: 'error',
    severity: 'blocker',
    category: 'style',
    owner: 'llm',
    repairability: 'local_deterministic',
    message: `段落内句子复读 ${count} 次：“${sentence.slice(0, 30)}…”`,
    suggestion: '同一段落内相同句子只保留首次出现，删除段尾复读的重复句（确定性修复器已接入自动剥离）。',
  }));
}

// ── H3 防撞名标题残留（丰乐镇 doc-1788954795698 实测「公厕（1）」「公厕（1）（二）」）──
// 主题块切分/拆半的编号后缀防撞名泄漏进目录：正式投标目录不允许「（1）（2）」编号后缀小节；
// 与确定性修复器 fixCollisionNumberedHeadings 同源（检测定位=修复定位）。

export const COLLISION_NUMBERED_HEADING_RE = /^(.+?)(?:（(?:\d+|[一二三四五六七八九十]+)）)+$/u;

/** H3 防撞名标题扫描（检测器与修复器同源口径）：返回编号后缀结尾的 H3 标题行与其行首偏移 */
export function scanCollisionNumberedHeadings(markdown: string): Array<{ raw: string; index: number }> {
  const results: Array<{ raw: string; index: number }> = [];
  for (const match of markdown.matchAll(/^###\s+(.+)$/gmu)) {
    const raw = match[1]!.trim();
    if (!COLLISION_NUMBERED_HEADING_RE.test(raw)) continue;
    results.push({ raw, index: markdown.lastIndexOf('\n', match.index ?? 0) + 1 });
  }
  return results;
}

export function collisionNumberedHeadingIssues(markdown: string): ValidationIssue[] {
  const hits = scanCollisionNumberedHeadings(markdown);
  if (hits.length === 0) return [];
  return hits.slice(0, 3).map(({ raw }) => ({
    level: 'error',
    severity: 'blocker',
    category: 'structure',
    owner: 'llm',
    repairability: 'local_deterministic',
    message: `目录小节标题含防撞名编号后缀：“${raw}”`,
    suggestion: '正式投标文件目录不允许「（1）（2）」编号后缀小节：确定性修复器已接入（按主题域重命名为语义化标题或合并同基线拆半小节）。',
  }));
}

// ── 时间区间倒挂（十五版评分报告实测「开工令下发后第90日至第3日完成」）──
// 「第X日至第Y日」X>Y 必为时间拼接病句（两个时间点错序拼接）；删除倒挂起点保留终点
// 即恢复有效时间点表述，确定性可判可修。

export const INVERTED_DATE_RANGE_RE = /第(\d{1,3})日(?:至|到|～|~|—|－)第(\d{1,3})日/gu;

/** 倒挂时间区间扫描（检测器与修复器同源口径）：返回命中位置与原文 */
export function scanInvertedDateRanges(markdown: string): Array<{ start: number; end: number; raw: string }> {
  const hits: Array<{ start: number; end: number; raw: string }> = [];
  for (const match of markdown.matchAll(INVERTED_DATE_RANGE_RE)) {
    const startDay = Number(match[1]);
    const endDay = Number(match[2]);
    if (startDay <= endDay) continue;
    hits.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, raw: match[0] });
  }
  return hits;
}

export function invertedDateRangeIssues(markdown: string): ValidationIssue[] {
  const hits = scanInvertedDateRanges(markdown);
  if (hits.length === 0) return [];
  return hits.slice(0, 3).map(({ raw }) => ({
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `时间区间倒挂：“${raw}”起点大于终点，属时间拼接病句`,
    suggestion: '删除倒挂区间起点，仅保留终点日期表述（确定性修复器已接入自动剥离）。',
  }));
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

// ── V5 P4b. 跨工程同值复制 / 阶段人数混用检测（groups 同源，替代村名特征字启发式）──

/** 跨工程同值复制检测（V5 P4b，P3.2 原设计）：多村/多标段合并项目清单条目携带分工程明细
 * （groups=villageGroup∥section 原值），正文把 A 工程的明细值写到 B 工程语境（复制粘贴同值）
 * 是 LLM 写作高频错误——修复器 fixQuantityAuthorityConflicts 对「值 ∈ 分组值集」精确豁免
 * （分村分表合法量不归一），该豁免放过的同值复制错误由本检测器接手（与修复器同源 groups）。
 *
 * 确定性判定（零误伤，两条）：
 * A. 同一条目的同一数值出现在 ≥2 个工程对象（组）语境，且这些组在清单中明细值不全相同——
 *    数值不可能同时等于两个不同的明细值，至少一处是复制错误（P3.2 原设计字面判定）；
 * B. 单组语境中，数值恰等于「其他组」的明细值（≠本组明细值）——直接复制了他家工程的数值。
 * 组语境由名称前窗口（到句边界且 ≤24 字）内分工程明细名「唯一命中」确定——多组/无组语境
 * 跳过（总述句合计值/跨工程列举句不建立配对）；表格行（分村分表合法承载）跳过；
 * 名称/单位匹配复用修复器同源 helper（检测定位=修复定位）；每条目只报一条防刷屏。 */
export function crossProjectValueCopyIssues(
  markdown: string,
  quantityAuthorities: Array<{ name: string; value: number; unit: string; groups?: Array<{ group: string; value: number }> }>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const matchesValue = (left: number, right: number) => Math.abs(left - right) < 1e-6;
  for (const authority of quantityAuthorities) {
    const detail = authority.groups ?? [];
    if (detail.length < 2) continue;
    // 明细值全同（各工程本来同值）：复制同值不构成跨工程错误，整体跳过
    if (new Set(detail.map(item => Math.round(item.value * 100))).size < 2) continue;
    const nameRe = new RegExp(flexNamePattern(authority.name), 'gu');
    const unitRe = new RegExp(`(?<![\\dA-Za-z])(\\d(?:[\\d,]*(?:\\.\\d+)?))\\s*${quantityUnitVariants(authority.unit)}(?![0-9a-zA-Z])`, 'gui');
    const pairings: Array<{ group: string; value: number; excerpt: string }> = [];
    for (const nameMatch of markdown.matchAll(nameRe)) {
      const ns = nameMatch.index ?? 0;
      const ne = ns + nameMatch[0].length;
      // 表格行：分村分表/分规格明细表的合法承载，不检测（与修复器同口径）
      const lineStart = markdown.lastIndexOf('\n', ns) + 1;
      let lineEnd = markdown.indexOf('\n', ns);
      if (lineEnd === -1) lineEnd = markdown.length;
      if (/^\s*\|/u.test(markdown.slice(lineStart, lineEnd))) continue;
      // 语境组：名称前到句边界且 ≤24 字的窗口内，分工程明细名唯一命中才建立配对
      const windowStart = Math.max(lineStart, ns - 24);
      const before = markdown.slice(windowStart, ns);
      const cut = Math.max(before.lastIndexOf('。'), before.lastIndexOf('；'), before.lastIndexOf(';'));
      const subjectWindow = cut >= 0 ? before.slice(cut + 1) : before;
      const contextGroups = detail.filter(item => item.group && subjectWindow.includes(item.group));
      if (contextGroups.length !== 1) continue;
      const contextGroup = contextGroups[0]!;
      // 数值窗口（与修复器同口径）：名称后 24 字符、列举分隔符（、。；，与换行）截断，
      // 取与合计值差异最小的「数值+单位」候选
      const rawWindow = markdown.slice(ne, ne + 24);
      const splitAt = Math.min(...[rawWindow.search(/[、。；，]/u), rawWindow.search(/\n/u)].filter(pos => pos >= 0).concat([rawWindow.length]));
      const window = rawWindow.slice(0, splitAt);
      let best: { offset: number; value: number; raw: string } | null = null;
      for (const valueMatch of window.matchAll(unitRe)) {
        // 规格句豁免（与修复器同源）：规格限定词紧邻尾随的数值是规格非工程量
        if (/(?:间距|不大于|不小于|≥|≤|宽度|厚度|高度|深度|坡度)[^0-9]*$/u.test(window.slice(0, valueMatch.index ?? 0))) continue;
        const raw = valueMatch[1];
        const value = Number(raw.replace(/,/gu, ''));
        if (!Number.isFinite(value) || value <= 0) continue;
        if (best === null || Math.abs(value - authority.value) < Math.abs(best.value - authority.value)) {
          best = { offset: ne + (valueMatch.index ?? 0) + valueMatch[0].indexOf(raw), value, raw };
        }
      }
      if (!best) continue;
      // V5 P6 误报收口（run1 实测）：「综合配套用房-安装工程投入配电箱AF 1台、照明配电箱AL1 1台、
      // 照明配电箱AL2 1台」的名称与数值之间是子型号代号（AF/AL1/AL2）——数值属该对象子型号枚举量
      // （1+1+1 恰为该工程条目明细值 3），非条目总量口径，与分工程明细不可比；正常量词为汉字
      // （「共42台」的「共」）不被豁免，真复制形态（名称紧邻数值）不受影响
      const between = markdown.slice(ne, best.offset);
      if (/[A-Za-z]/u.test(between) && !/[\u4e00-\u9fa5]/u.test(between)) continue;
      pairings.push({ group: contextGroup.group, value: best.value, excerpt: markdown.slice(ns, best.offset + best.raw.length) });
    }
    if (pairings.length === 0) continue;
    let issuePushed = false;
    // 判定 B：单组语境中值恰为其他组明细值（该值 ≠ 本组明细值）——直接复制了他家数值
    for (const pairing of pairings) {
      const own = detail.find(item => item.group === pairing.group);
      if (!own || matchesValue(own.value, pairing.value)) continue;
      const other = detail.find(item => item.group !== pairing.group && matchesValue(item.value, pairing.value));
      if (!other) continue;
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `跨工程同值复制：“${pairing.excerpt.slice(0, 40)}”在“${pairing.group}”语境处取值 ${pairing.value}${authority.unit}，该值是“${other.group}”的清单明细值（${pairing.group} 的清单明细值为 ${own.value}${authority.unit}）`,
        suggestion: `以工程量清单分工程明细为准修正“${pairing.group}”语境：应为 ${own.value}${authority.unit}，不得沿用“${other.group}”的明细值 ${pairing.value}${authority.unit}；修复后全文该条目分工程取值必须与清单明细逐一对应。`,
      });
      issuePushed = true;
      break;
    }
    if (issuePushed) continue;
    // 判定 A：同值出现在 ≥2 组语境且这些组明细值不同（数值不可能同时等于两个不同明细值）
    const groupsByValue = new Map<string, Set<string>>();
    for (const pairing of pairings) {
      const key = pairing.value.toFixed(2);
      const set = groupsByValue.get(key) ?? new Set<string>();
      set.add(pairing.group);
      groupsByValue.set(key, set);
    }
    for (const [key, groupSet] of groupsByValue) {
      if (groupSet.size < 2) continue;
      // P3.2 判定 A 语义（K3 契约）：同值出现在 ≥2 工程对象语境且这些对象的明细值互不相同
      // → 至少一处是复制错误，不要求值本身 ∈ 某工程明细（999 双组同写须报；run1「AL共42台」
      // 同值跨公厕/公共广场且明细 1/4/…互异，正文多处与明细矛盾属真缺陷，保留报告由 LLM 修复轮处理）
      const hitDetail = detail.filter(item => groupSet.has(item.group));
      if (new Set(hitDetail.map(item => Math.round(item.value * 100))).size < 2) continue;
      const sample = pairings.find(pairing => pairing.value.toFixed(2) === key)!;
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `跨工程同值复制：“${sample.excerpt.slice(0, 40)}”数值 ${key}${authority.unit} 同时出现在“${[...groupSet].join('”“')}”等 ${groupSet.size} 个工程对象语境，而清单明细值互不相同（${hitDetail.map(item => `${item.group} ${item.value}${authority.unit}`).join('、')}）——至少一处属跨工程同值复制`,
        suggestion: `逐工程对象按清单明细值修正取值（${hitDetail.map(item => `${item.group} ${item.value}${authority.unit}`).join('、')}），不得多工程共用同一数值。`,
      });
      break;
    }
  }
  // 上限 8：多村项目同值复制可能成簇出现，防刷屏（确定性检测零误伤，数量增加不放大修复风险）
  return issues.slice(0, 8);
}

/** 阶段人数混用检测（V5 P4b，P3.3 原设计）：正文「XX阶段 + N 人」与蓝图分阶段劳动力推导
 * （phaseAuthorities = byPhase 的 midValue 权威投影）比对——阶段名唯一命中且数值不符即 error。
 * 阶段名存在但值不符 = 跨口径数字被复制/改编（确定性可判）；阶段名不存在时不判
 * （合法细分表述与异策略阶段词无法确定性裁决，交 LLM 评审层）。
 * 阶段名匹配用最长公共汉字子串（≥4 字）：「施工准备」↔「施工准备与清杂拆除」、
 * 「污水管网工程」精确命中；表格行（分阶段投入明细表的合法承载，byPhase 推导源）跳过；
 * 负向声明句（修复声明引用旧值）豁免；阶段提取与 resourceConsistencyIssues 同窗口。 */
export function phaseLaborMixingIssues(
  markdown: string,
  phaseAuthorities: Array<{ phase: string; value: number; trace?: string }>,
): ValidationIssue[] {
  if (phaseAuthorities.length === 0) return [];
  const issues: ValidationIssue[] = [];
  for (const match of markdown.matchAll(STAGE_LABOR_RE)) {
    const lineStart = markdown.lastIndexOf('\n', match.index) + 1;
    let lineEnd = markdown.indexOf('\n', match.index);
    if (lineEnd === -1) lineEnd = markdown.length;
    const line = markdown.slice(lineStart, lineEnd);
    // 表格行：分阶段投入明细表的合法承载，不检测（与 resourceConsistencyIssues 同口径）
    if (/^\s*\|.*\|\s*$/u.test(line)) continue;
    // 负向声明句豁免：「不再出现“XX阶段35人”」是修复声明引用旧值（与检测器家族同源）
    if (NEGATIVE_DECLARATION_RE.test(line)) continue;
    // V5 P6 误报豁免（run1 实测）：①最低配置声明「阶段不少于2人」（安全员配置）——数字前文含
    // 不少于/不低于/至少/最低/不小于；②工种配置句「道路铺装阶段即安排管道工10人」——数字紧邻
    // 前文以工种/职务词结尾（工/员/长/司机/班组）。两类均非阶段劳动力总量口径。
    const valueIndex = (match.index ?? 0) + match[0].indexOf(match[1]);
    const beforeNumber = markdown.slice(Math.max(lineStart, valueIndex - 12), valueIndex);
    if (/不少于|不低于|至少|最低|不小于|≥/u.test(beforeNumber)) continue;
    if (/(?:[\u4e00-\u9fa5]{1,3}(?:工|员|长)|司机|班组|队伍?)\s*$/u.test(beforeNumber)) continue;
    // 阶段名提取（V5 P6 两步法）：回指句（「该阶段…统一为238人」）解析到行内最近实义阶段名
    const stagePhrase = extractStagePhrase(markdown, lineStart, valueIndex);
    if (!stagePhrase) continue;
    const stagePrefix = stagePhrase.replace(/阶段$/u, '');
    const value = Number(match[1].replace(/[,，]/gu, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    // 阶段名匹配：最长公共汉字子串 ≥4 字，取最长命中（多命中时最具体阶段胜出）
    let best: { phase: string; value: number; trace?: string; score: number } | null = null;
    for (const entry of phaseAuthorities) {
      const score = longestCommonHanSubstring(stagePrefix, entry.phase);
      if (score >= 4 && (best === null || score > best.score)) best = { ...entry, score };
    }
    if (!best) continue;
    if (value === best.value) continue;
    // 引号原文切片：数字前 24 字到数值/人结束（正文真实片段，供修复轮章节定位）——
    // 两步法下阶段短语可能不在数字紧邻前文，切片锚定数字位置而非 match 起点
    const excerpt = markdown.slice(Math.max(lineStart, valueIndex - 24), (match.index ?? 0) + match[0].length).trim();
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `阶段劳动力数据矛盾：正文“${excerpt.slice(0, 60)}”取值 ${value} 人，与蓝图分阶段劳动力推导不符（“${best.phase}”阶段应为 ${best.value} 人）`,
      suggestion: `分阶段劳动力人数必须以蓝图推导为准：将“${best.phase}”阶段人数统一为 ${best.value} 人${best.trace ? `（依据：${best.trace}）` : ''}，删除其他口径数字。`,
    });
    if (issues.length >= 8) break;
  }
  return issues;
}

