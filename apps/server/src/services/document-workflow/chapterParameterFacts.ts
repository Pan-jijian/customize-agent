/**
 * chapterParameterFacts：可靠参数按章使用（C-T6）——资料事实链参数索引的按章相关性注入 /
 * 使用率归因审计 / 修复链缺失池（一个模块三处消费，口径单源）。
 *
 * 背景（B6/#38 根治）：参数池（factsModel.factIndex.parameterFacts：规格/参数/数量/时间/比例/
 * 标准编号类可靠事实）此前没有写作侧直读通道——参数只能经检索召回/事实需求间接进入提示词，
 * 实测可靠参数使用率 17%（远低于告警线 28%）。与清单直读（billFactLock）/图纸直读（drawingFactLock）
 * 同范式补齐三环：
 * - 写作侧（stageChapterLoop）：按章相关性渲染本章可用参数清单，生成时显式可见（源头提升使用率）；
 * - 审计侧（documentQualityReport.parameterUsageAudit）：按章归因——已使用 / 相关而遗漏（义务集）/
 *   不相关遗漏（仅登记），义务满足率 = used/(used+relevantMissed)（C-T6 ≥80% 验收出口）；
 * - 修复侧（contentDepthRepair）：相关而遗漏的参数按最相关章分配，随内容深度补写轮消费。
 *
 * 口径单源：章 token（标题+小节切词，含双字子词扩展）× 参数文本（键/字段名/值）词面命中计分——
 * 注入可见性、审计义务集、修复目标章三处共用同一打分（口径不分裂）。
 * 商务红线：参数池构建已排除商务金额/单价/税率/预留金类事实（factsModel.isGenerationExcludedFact），
 * 本模块消费侧再排除一次（防上游池变更泄漏）——商务数据零进入注入/义务/修复。
 */
import { chapterRelevanceTokens, expandRelevanceToken } from './billFactLock';
import { isGenerationExcludedFact } from './factsModel';
import { normalizeEngineeringTextForFactMatch } from './engineeringUnits';
import { classifyPoolNoiseText, type PoolNoiseCategory } from './poolNoise';
import { stableHash } from './utils';
import type { DocumentFact, ValidationIssue } from './types';

/** 参数池输入（factsModel 子集；factIndex 缺失时回退 preciseFacts，与检测端 collectPreciseFactTokens 同源兜底） */
export interface ParameterFactsSource {
  factIndex?: { parameterFacts?: DocumentFact[] } | null;
  preciseFacts?: DocumentFact[] | null;
}

/** 参数池噪声（OCR/识别残缺类条目不可逐字写入正文：不注入、不计义务、不修复） */
const PARAMETER_NOISE_RE = /OCR|乱码|识别错误|无法确认|语义断裂|页码/u;

/** 商务域补充排除（消费侧兜底，与商务数据检测器词面同族）：isGenerationExcludedFact 已覆盖金额/单价/
 * 税率/增值税/报价/合价类，未覆盖「预留金/暂列金额/暂估价」——C-T6 红线（预留金零进入）在此补齐 */
const PARAMETER_COMMERCIAL_EXTRA_RE = /暂列金额|暂估价|预留金/u;

/** 本章参数注入条数/字符预算（与清单直读同族量级：单章 60 行、3600 字符） */
const CHAPTER_PARAMETER_MAX_ENTRIES = 60;
const CHAPTER_PARAMETER_MAX_CHARS = 3600;

/** 参数文本（相关性计分与渲染共用口径）：键/字段名/值 */
function parameterFactText(fact: DocumentFact): string {
  return `${fact.key || ''} ${fact.fieldName || ''} ${fact.value || ''}`.trim();
}

/** 可用参数池 + 净化出池登记（D6 池净化：只出池不删档——噪声条目移出义务集但保留在审计中） */
interface UsableParameterPool {
  /** 可用参数（空值/噪声/商务/重复剔除后） */
  usable: DocumentFact[];
  /** D6 表格噪声出池登记（图签/坐标/残片/目录行/编号粘连，与要求池同源判定，可审计） */
  noiseExcluded: Array<{ fact: DocumentFact; category: PoolNoiseCategory }>;
}

/** 可用参数池：空值/噪声/商务/重复剔除（去重键 key|value，池内原始顺序保持）。
 * D6 同源净化：表格噪声（图签/坐标/残片/粘连）与要求池共用 poolNoise 判定——一处判定全链生效
 * （写作注入/义务审计/修复分配三处消费同一池，噪声零进入义务集）。 */
function usableParameterFacts(factsModel: ParameterFactsSource | undefined | null): UsableParameterPool {
  const empty: UsableParameterPool = { usable: [], noiseExcluded: [] };
  if (!factsModel) return empty;
  const pool = factsModel.factIndex?.parameterFacts?.length ? factsModel.factIndex.parameterFacts : (factsModel.preciseFacts || []);
  const seen = new Set<string>();
  const usable: DocumentFact[] = [];
  const noiseExcluded: Array<{ fact: DocumentFact; category: PoolNoiseCategory }> = [];
  for (const fact of pool) {
    if (!fact) continue;
    const value = String(fact.value || '').trim();
    if (!value) continue;
    if (PARAMETER_NOISE_RE.test(parameterFactText(fact))) continue;
    // 商务红线双保险：池构建（isGenerationExcludedFact，含合同估算价类反豁免口径）已排除大部分，
    // 消费侧再兜底排除补充词面（预留金/暂列金额/暂估价）与商务域事实
    if (isGenerationExcludedFact(fact)) continue;
    if (PARAMETER_COMMERCIAL_EXTRA_RE.test(parameterFactText(fact))) continue;
    // D6 表格噪声净化（与要求池同源判定）：图签/坐标/目录行/残片/粘连出池——不可锚定正文且误导修复。
    // 判定对象为「值」：键/字段名是分类标签（项目名称/精确参数），拼接判定会以键前缀遮蔽值首形态
    // （「项目名称 2225111舒城县…」值首编号粘连漏判），值才是最终要逐字落位的内容
    const noiseCategory = classifyPoolNoiseText(value);
    if (noiseCategory) {
      noiseExcluded.push({ fact, category: noiseCategory });
      continue;
    }
    const dedupeKey = `${fact.key}|${value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    usable.push(fact);
  }
  return { usable, noiseExcluded };
}

/** 章 token 展开集（标题+小节切词 → 双字子词展开，一次展开供全池打分复用） */
function chapterParameterTokens(chapterTitle: string, sections: string[] = []): string[] {
  const expanded = new Set<string>();
  for (const token of chapterRelevanceTokens(chapterTitle, sections)) {
    for (const item of expandRelevanceToken(token)) expanded.add(item);
  }
  return [...expanded];
}

/** 参数与章的相关性分：展开 token 命中参数文本的个数（>0 即相关；打分序用于注入排序与修复定位） */
function parameterRelevanceScore(fact: DocumentFact, expandedTokens: string[]): number {
  const text = parameterFactText(fact);
  let score = 0;
  for (const token of expandedTokens) {
    if (text.includes(token)) score += 1;
  }
  return score;
}

/** 本章相关参数选择（写作注入与义务口径共用）：仅取相关（score>0），分数降序、键值字典序兜底可复现 */
export function selectChapterParameterFacts(
  factsModel: ParameterFactsSource | undefined | null,
  chapterTitle: string,
  options: { sections?: string[]; maxEntries?: number } = {},
): DocumentFact[] {
  const { usable: pool } = usableParameterFacts(factsModel);
  if (pool.length === 0) return [];
  const tokens = chapterParameterTokens(chapterTitle, options.sections || []);
  if (tokens.length === 0) return [];
  const maxEntries = Math.max(1, options.maxEntries ?? CHAPTER_PARAMETER_MAX_ENTRIES);
  return pool
    .map(fact => ({ fact, score: parameterRelevanceScore(fact, tokens) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score
      || String(a.fact.key).localeCompare(String(b.fact.key), 'zh')
      || String(a.fact.value).localeCompare(String(b.fact.value), 'zh'))
    .slice(0, maxEntries)
    .map(item => item.fact);
}

/**
 * 本章可靠参数清单渲染（写作注入，行数组由调用侧并入 roleContext）：
 * header 声明逐项落位义务与商务禁入；条目行 `- 键（字段名）：值`（值截断 80 字符防单条超长）。
 */
export function renderChapterParameterLines(
  factsModel: ParameterFactsSource | undefined | null,
  chapterTitle: string,
  options: { sections?: string[]; maxEntries?: number; maxChars?: number } = {},
): string[] {
  const selected = selectChapterParameterFacts(factsModel, chapterTitle, options);
  if (selected.length === 0) return [];
  const maxChars = Math.max(1, options.maxChars ?? CHAPTER_PARAMETER_MAX_CHARS);
  const lines: string[] = [];
  let total = 0;
  for (const fact of selected) {
    const field = fact.fieldName && fact.fieldName !== fact.key ? `（${fact.fieldName}）` : '';
    const line = `- ${fact.key}${field}：${String(fact.value).slice(0, 80)}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  if (lines.length === 0) return [];
  return [
    `【本章可靠参数清单（资料事实链参数索引：${lines.length} 项与本章相关的规格/参数/数量/时间/比例/标准编号，须逐项在正文对应位置自然写入，保持原值原形态（数字、单位、编号中的连字符与年份不得改写、拆分或省略）；商务金额/单价/税率/预留金类数据一律不得写入正文）】`,
    ...lines,
  ];
}

/** 参数使用判定（字面口径，双端 normalizeEngineeringTextForFactMatch 归一；组合值按段片段兜底） */
function parameterValueUsedIn(normalizedMarkdown: string, value: string): boolean {
  const normalizedValue = normalizeEngineeringTextForFactMatch(value);
  if (!normalizedValue) return false;
  if (normalizedMarkdown.includes(normalizedValue)) return true;
  // 组合值兜底（表格行摘要等「甲、乙、丙」多段值）：任一段（归一后 ≥5 字符）命中即视为已使用
  const fragments = value.split(/[、，,;；/|]+/u)
    .map(item => normalizeEngineeringTextForFactMatch(item))
    .filter(item => item.length >= 5);
  return fragments.some(fragment => normalizedMarkdown.includes(fragment));
}

/** 参数使用归因结果（审计/修复/测试共用） */
export interface ParameterUsageBreakdown {
  /** 参数池规模（空值/噪声/商务/重复剔除后） */
  totalParams: number;
  /** 正文已使用的参数 */
  used: DocumentFact[];
  /** 相关而遗漏：与至少一个章的标题/小节词面相关且正文未使用（义务集，修复链补写对象） */
  relevantMissed: DocumentFact[];
  /** 不相关遗漏：与全部章均无词面相关且正文未使用（仅归因登记，不计义务） */
  irrelevantMissed: DocumentFact[];
  /** D6 表格噪声出池登记（图签/坐标/残片/粘连——移出义务集，保留审计） */
  noiseExcluded: Array<{ fact: DocumentFact; category: PoolNoiseCategory }>;
}

/** 参数使用归因（口径单源）：逐池参数做使用判定（字面命中 → used），未使用按「是否与任一章相关」二分归因；
 * D6 噪声条目在池入口已出池（noiseExcluded 登记），不计义务 */
export function classifyParameterUsage(
  markdown: string,
  factsModel: ParameterFactsSource | undefined | null,
  chapters: Array<{ title: string; sections?: string[] }> = [],
): ParameterUsageBreakdown {
  const { usable: pool, noiseExcluded } = usableParameterFacts(factsModel);
  const normalizedMarkdown = normalizeEngineeringTextForFactMatch(markdown || '');
  const tokenSets = chapters.map(chapter => chapterParameterTokens(chapter.title, chapter.sections || []));
  const used: DocumentFact[] = [];
  const relevantMissed: DocumentFact[] = [];
  const irrelevantMissed: DocumentFact[] = [];
  for (const fact of pool) {
    if (parameterValueUsedIn(normalizedMarkdown, String(fact.value))) {
      used.push(fact);
      continue;
    }
    const relevant = tokenSets.some(tokens => tokens.length > 0 && parameterRelevanceScore(fact, tokens) > 0);
    (relevant ? relevantMissed : irrelevantMissed).push(fact);
  }
  return { totalParams: pool.length, used, relevantMissed, irrelevantMissed, noiseExcluded };
}

/** 可靠参数使用审计（DocumentQualityReport.parameterUsageAudit 出口；义务口径见 rate 注释） */
export interface ParameterUsageAudit {
  /** 参数池规模（空值/噪声/商务/重复剔除后） */
  totalParams: number;
  /** 正文已使用参数数 */
  usedParams: number;
  /** 相关而遗漏数（义务集规模） */
  relevantMissedCount: number;
  /** 相关而遗漏明细（前 20 条，`键：值`，供交付审计核验） */
  relevantMissed: string[];
  /** 不相关遗漏数（归因：与全部章无词面相关，不计义务） */
  irrelevantMissedCount: number;
  /** D6 池净化出池计数（表格噪声：图签/坐标/残片/粘连——不计义务，只出池不删档可审计；旧存档报告无此字段） */
  noiseExcludedCount?: number;
  /** 出池噪声明细（前 10 条，`[类别]键：值` 截断，供交付审计核验） */
  noiseExcluded?: string[];
  /** 义务满足率 = usedParams/(usedParams+relevantMissedCount)；义务集为空或章集缺失（相关口径不可判定）时 null */
  rate: number | null;
}

/** 构建可靠参数使用审计：无参数池时返回 undefined（分量不可用显式降级，与 B-T3/C-T5 审计口径一致） */
export function buildParameterUsageAudit(input: {
  markdown: string;
  factsModel: ParameterFactsSource | undefined | null;
  chapters?: Array<{ title: string; sections?: string[] }>;
}): ParameterUsageAudit | undefined {
  const chapters = input.chapters || [];
  const breakdown = classifyParameterUsage(input.markdown, input.factsModel, chapters);
  if (breakdown.totalParams === 0) return undefined;
  const usedParams = breakdown.used.length;
  const relevantMissedCount = breakdown.relevantMissed.length;
  const obligationTotal = usedParams + relevantMissedCount;
  return {
    totalParams: breakdown.totalParams,
    usedParams,
    relevantMissedCount,
    relevantMissed: breakdown.relevantMissed.slice(0, 20).map(fact => `${fact.key}：${String(fact.value).slice(0, 60)}`),
    irrelevantMissedCount: breakdown.irrelevantMissed.length,
    noiseExcludedCount: breakdown.noiseExcluded.length,
    noiseExcluded: breakdown.noiseExcluded.slice(0, 10).map(item => `[${item.category}]${item.fact.key}：${String(item.fact.value).slice(0, 50)}`),
    rate: chapters.length > 0 && obligationTotal > 0 ? usedParams / obligationTotal : null,
  };
}

/** 相关而遗漏参数值列表（修复链消费；按池内顺序确定性截断，默认 ≤12） */
export function missingRelevantParameterTokens(
  markdown: string,
  factsModel: ParameterFactsSource | undefined | null,
  chapters: Array<{ title: string; sections?: string[] }> = [],
  options: { max?: number } = {},
): string[] {
  const max = Math.max(1, options.max ?? 12);
  return classifyParameterUsage(markdown, factsModel, chapters).relevantMissed
    .map(fact => String(fact.value).trim())
    .filter(value => value.length > 0 && value.length <= 80)
    .slice(0, max);
}

/** 参数值可注入长度上限（与 missingRelevantParameterTokens 同口径：超长值无法自然嵌入正文，不进补写指令） */
const PARAMETER_REPAIR_VALUE_MAX = 80;

/** 修复分配预算（C3-4 扩容：初版 6/24 在 s28l 净化后 74 条缺口下仅覆盖 17 条，义务满足率无法向 90% 收敛——
 * 单章/总量上限按 s28l/r28l 实机缺口量级放宽；防指令膨胀由「同章参数聚合单条补写指令 + 值长过滤」兜底） */
const PARAMETER_REPAIR_MAX_PER_CHAPTER = 16;
const PARAMETER_REPAIR_MAX_TOTAL = 96;

/** 相关而遗漏参数 → 目标章索引的修复分配（逐条按相关性降序取章，同分取大纲靠前章；
 * 首选章满额时顺位次优章——仅分数 >0 的章可承载，防单章拥塞（s28l 质量/施工方法两章集中 60+ 条）
 * 造成分配浪费；逐章/总量限额防指令膨胀） */
export function assignMissingParameterChapters(
  markdown: string,
  factsModel: ParameterFactsSource | undefined | null,
  chapters: Array<{ title: string; sections?: string[] }> = [],
  options: { maxPerChapter?: number; maxTotal?: number } = {},
): Map<number, string[]> {
  const assignment = new Map<number, string[]>();
  if (chapters.length === 0) return assignment;
  const maxPerChapter = Math.max(1, options.maxPerChapter ?? PARAMETER_REPAIR_MAX_PER_CHAPTER);
  const maxTotal = Math.max(1, options.maxTotal ?? PARAMETER_REPAIR_MAX_TOTAL);
  const missed = classifyParameterUsage(markdown, factsModel, chapters).relevantMissed;
  if (missed.length === 0) return assignment;
  const tokenSets = chapters.map(chapter => chapterParameterTokens(chapter.title, chapter.sections || []));
  let assigned = 0;
  for (const fact of missed) {
    if (assigned >= maxTotal) break;
    const value = String(fact.value).trim();
    if (value.length === 0 || value.length > PARAMETER_REPAIR_VALUE_MAX) continue;
    // 相关性降序候选章（同分取大纲靠前章；分数 >0 才入候选——与 relevantMissed 判定同尺度）
    const ranked = tokenSets
      .map((tokens, index) => ({ index, score: tokens.length === 0 ? 0 : parameterRelevanceScore(fact, tokens) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    for (const candidate of ranked) {
      const list = assignment.get(candidate.index) ?? [];
      if (list.length >= maxPerChapter) continue;
      list.push(value);
      assignment.set(candidate.index, list);
      assigned += 1;
      break;
    }
  }
  return assignment;
}

/** 可靠参数义务满足率门槛（C3-4 验收出口：可落位者全落位；义务集规模小于最小值时不判定防小样本抖动） */
export const PARAMETER_OBLIGATION_MIN_RATE = 0.9;
export const PARAMETER_OBLIGATION_MIN_TOTAL = 8;

/**
 * 可靠参数义务缺口检测（参数池净化后义务满足率 < 门槛 → error）：
 * 与报告出口 buildParameterUsageAudit.rate、修复出口 assignMissingParameterChapters 同源单源
 * （classifyParameterUsage）——检测定位=修复定位（content-depth-repair 按 provenance 消费本类 error）。
 * 义务集为空或章节缺失（相关口径不可判定）时不判定。
 */
export function parameterObligationUsageIssues(
  markdown: string,
  factsModel: ParameterFactsSource | undefined | null,
  chapters: Array<{ title: string; sections?: string[] }> = [],
): ValidationIssue[] {
  if (chapters.length === 0) return [];
  const breakdown = classifyParameterUsage(markdown, factsModel, chapters);
  const obligationTotal = breakdown.used.length + breakdown.relevantMissed.length;
  if (obligationTotal < PARAMETER_OBLIGATION_MIN_TOTAL) return [];
  const rate = breakdown.used.length / obligationTotal;
  if (rate >= PARAMETER_OBLIGATION_MIN_RATE) return [];
  const samples = breakdown.relevantMissed.slice(0, 3).map(fact => String(fact.value).slice(0, 30));
  return [{
    level: 'error',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `可靠参数义务落位不足：${breakdown.used.length}/${obligationTotal}（相关而遗漏 ${breakdown.relevantMissed.length} 项${samples.length > 0 ? `，缺失如 ${samples.join('、')}` : ''}）`,
    suggestion: '请将资料中的可靠参数（规格/型号/尺寸/强度/规范编号等）在对应章节的对应位置自然写入，保持原值原形态（数字、单位、编号中的连字符与年份不得改写、拆分或省略）；商务金额、单价、税率、预留金类数据一律不得写入正文。',
    provenance: { detectorId: 'parameter-obligation-usage', fingerprint: stableHash(markdown) },
  }];
}
