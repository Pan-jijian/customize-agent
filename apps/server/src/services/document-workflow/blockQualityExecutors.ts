/**
 * 块级质量执行器（方案 2.2 六类：结构/密度/模板化/归因量化/数值/格式）：
 * 写作时阻断（chapterGeneration.writeBlock 块质检，经 det() 登记）与 finalize 同源复核共享
 * 同一实现与判定常量——检测⊆写作：终检不得存在写作未承接的判定口径。
 * - 结构：契约小节全覆盖、禁发明编号（writeBlock 内联判定 + structureIntegrityRules 单源扫描，
 *   终检同源复核 section-content-integrity / structure-integrity / section-numbering）；
 * - 密度：事实落位比例口径 ≥1.5/千字（本模块 factDensityVerdict/assessBlockFactDensity，
 *   终检同源复核 chapter-fact-density），与预算天然自洽（不用绝对数量，避免「预算小要求多」的矛盾）；
 * - 模板化：套话句占比 >10% 或模糊句式 ≥3 处/块（本模块 scanBlockTemplating，句池与判定器与
 *   fillerDensityReport 同源，占比线即终检达标线 ≤10%）；
 * - 短语级套话（4.59 R-B5 ①，同一家族的**粒度下沉**通道）：≥1 处/块（本模块 scanBlockFillerPhrases，
 *   判据与 tenderBidChecks.scanZeroInfoFillerPhrases 同源）；句级占比通道对本族**天然不开火**
 *   （实测：套话嵌在实质句中，整句占比恒低于 10%），故必须独立成器；
 * - 归因量化：重难点类章条目须含归因链与量化目标，双达标率 <50% 阻断（assessDifficultyEntries
 *   与 difficultyCountermeasureReport 同源，同验收线 ≥50%）；
 * - 数值：正文数值 vs 证据池对账矛盾即阻断（writeBlock 内联 reconcileContentNumbers，
 *   终检同源复核 cross-section-numeric-conflict 等数值族）；
 * - 格式：后台/兜底话术硬约束（BACKSTAGE_OR_FALLBACK_TEXT_RE 与终检 formalTextGateIssues 同源）。
 */
import { documentTextLength } from './budget';
import { BACKSTAGE_OR_FALLBACK_TEXT_RE } from './markdownComposer';
import { assessDifficultyEntries, buildFillerSentencePool, judgeFillerSentences, scanZeroInfoFillerPhrases, splitDifficultyEntries } from './tenderBidChecks';

// ═══════════════════ ② 密度：事实落位比例口径（≥1.5/千字） ═══════════════════

/** 密度执行线（每千字不同量化参数个数）：提示词指令线 2/千字，验收线 1.5/千字留 25% 裕度。
 * **唯一权威来源**：本常量同时是块质检（factDensityVerdict/assessBlockFactDensity）、蓝图章级
 * 供给核算（integratedBlueprint/capacity.assessChapterSupplyDemand）与施工组织审计工艺参数密度
 * （constructionOrgAudit.processParameterDensityIssues，新建工程档）的验收线——三处必须一起动。
 * 历史上三处各自声明一份（容量侧名 CHAPTER_PARAMETER_DENSITY_PER_1000，审计侧为 inline 字面量），
 * 数值巧合相等，改一处即静默分裂判定，现统一为本常量（capacity/constructionOrgAudit 直接 import）。 */
export const BLOCK_FACT_DENSITY_PER1000 = 1.5;

/** 量化参数提取（数字+计量单位/计数单位封闭词表，与 criticalSectionFactDensityIssues 同口径风格） */
const QUANTIFIED_PARAM_RE = /\d+(?:\.\d+)?\s*(?:m²|㎡|平方米|m³|m3|立方米|km|mm|cm|m|kg|t|吨|层|栋|日历天|天|%|台|套|根|处|个|kV|kW|MPa|kN|℃|次|遍|道|户|座|米|小时|min|分钟)/giu;

/** 不同量化参数计数（去重计数，防同一参数反复堆砌凑数） */
export function quantifiedParamCount(text: string): number {
  return new Set(text.match(QUANTIFIED_PARAM_RE) || []).size;
}

export interface FactDensityVerdict {
  chars: number;
  /** 正文内不同量化参数个数 */
  params: number;
  /** 每千字量化参数密度 */
  per1000: number;
  /** 比例口径要求数（ceil(字数/1000×1.5)） */
  required: number;
  /** 密度缺口（params < required） */
  gap: boolean;
}

export function factDensityVerdict(text: string): FactDensityVerdict {
  const chars = documentTextLength(text);
  const params = quantifiedParamCount(text);
  const required = chars > 0 ? Math.ceil((chars / 1000) * BLOCK_FACT_DENSITY_PER1000) : 0;
  const per1000 = chars > 0 ? Math.round((params / chars) * 1000 * 100) / 100 : 0;
  return { chars, params, per1000, required, gap: chars > 0 && params < required };
}

export interface BlockDensityAssessment {
  verdict: FactDensityVerdict;
  /** 本节相关材料（块级证据+专属事实）中的可落位量化参数个数 */
  materialParams: number;
  /** 阻断判定：密度缺口 且 材料存在足量可落位参数——「材料中仍有未落位参数」才构成打回理由
   * （与提示词语义一致：材料参数不足时以材料全部参数落位为准，不得借参数凑数） */
  blocking: boolean;
}

export function assessBlockFactDensity(text: string, materialText: string): BlockDensityAssessment {
  const verdict = factDensityVerdict(text);
  const materialParams = quantifiedParamCount(materialText);
  return { verdict, materialParams, blocking: verdict.gap && materialParams >= verdict.required };
}

// ═══════════════════ ③ 模板化：套话句占比 >10% 或模糊句式 ≥3 处/块 ═══════════════════

/** 套话句占比阻断线（与终检 fillerDensityReport 达标线 ≤10% 同源） */
export const BLOCK_TEMPLATING_RATIO_LIMIT = 0.1;
/** 模糊句式阻断线（块内模糊应答语义确认句数上限） */
export const BLOCK_TEMPLATING_VAGUE_LIMIT = 3;

export interface BlockTemplatingVerdict {
  totalSentences: number;
  /** 套话句数（semantic 原型命中 + vague 模糊应答复核命中，同 fillerDensityReport 口径） */
  fillerSentences: number;
  fillerRatio: number;
  /** 模糊应答语义确认句数（模糊句式单独留痕） */
  vagueCount: number;
  /** 命中句原文明细（去重，供阻断反馈定向重写） */
  fillerDetails: string[];
}

/** 块级模板化扫描（句池与判定器与终检 fillerDensityReport 同源；扫描失败由调用方容错放行） */
export async function scanBlockTemplating(text: string): Promise<BlockTemplatingVerdict> {
  const sentences = buildFillerSentencePool(text);
  if (sentences.length === 0) return { totalSentences: 0, fillerSentences: 0, fillerRatio: 0, vagueCount: 0, fillerDetails: [] };
  const judgements = await judgeFillerSentences(sentences);
  const fillerFlags = judgements.map(item => item.filler);
  const fillerSentences = fillerFlags.filter(Boolean).length;
  return {
    totalSentences: sentences.length,
    fillerSentences,
    fillerRatio: fillerSentences / sentences.length,
    vagueCount: judgements.filter(item => item.vague).length,
    fillerDetails: [...new Set(sentences.filter((_, index) => fillerFlags[index]))].slice(0, 12),
  };
}

export function templatingBlockingOf(verdict: BlockTemplatingVerdict): boolean {
  return verdict.fillerRatio > BLOCK_TEMPLATING_RATIO_LIMIT || verdict.vagueCount >= BLOCK_TEMPLATING_VAGUE_LIMIT;
}

// ═══════════ ③-b 短语级套话（R9-a 粒度下沉；4.59 R-B5 ① 接线：块成稿后 self-check） ═══════════

/**
 * 短语级套话阻断线（处/块）。
 *
 * 为什么不用占比/句数比例：本族判定粒度是**子句**，命中句几乎都是**有实质内容**的句子——
 * 实测缺陷「塘渣石垫层、水泥稳定碎（砾）石各分项施工质量验收统一以“精心组织施工”为总控目标，
 * 检验批验收逐级对照核验」整句有部位/工序/参数，只是**短语**是套话：句级占比门（套话句/句池 >10%）
 * 在这种形态下分母大、命中少而恒不开火；若改用"该句 1/1 是套话"的整句口径，修复动作就变成删整句
 *（连带丢掉句内实质信息），与缺陷实际不符。故本族用**计数**口径（处理单位是短语，不是句子）。
 *
 * 为什么是 1：零信息短语通道在真实成稿 878 句/3906 子句里命中 **2 处，人工复核 2/2 全为真套话**
 *（词表子串误伤「最高标准」由程度修饰保护拦截归零，见 tenderBidChecks.hitsForbiddenEmptyPhrase），
 * 即**命中即缺陷**，"成片"门槛不是精度需要；代价侧，首轮阻断 = 该块一次**定向重写**（二轮放行，
 * 与句级模板化门同属"首轮模式"），且反馈只要求改写该短语、保留句中实质信息（不删整句）。
 */
export const BLOCK_FILLER_PHRASE_LIMIT = 1;

export interface BlockFillerPhraseVerdict {
  /** 命中处数（子句粒度，非句子数） */
  count: number;
  /** 命中短语原文（去重，改写锚点：只改这一处，不删整句） */
  phrases: string[];
  /** 命中短语所属整句（去重，供定向重写提供上下文；上限 8 条防反馈超长） */
  sentences: string[];
  /** 句子总数（与终检句池同源，留痕用于观测命中率） */
  totalSentences: number;
}

/** 块级短语级套话扫描（判据与 tenderBidChecks.scanZeroInfoFillerPhrases 同源：同一份句池/子句切分 +
 * 空话词表 + 零信息判据；本模块不另造词表或阈值） */
export function scanBlockFillerPhrases(text: string): BlockFillerPhraseVerdict {
  const hits = scanZeroInfoFillerPhrases(text);
  return {
    count: hits.length,
    phrases: [...new Set(hits.map(hit => hit.phrase))].slice(0, 8),
    sentences: [...new Set(hits.map(hit => hit.sentence))].slice(0, 8),
    totalSentences: buildFillerSentencePool(text).length,
  };
}

export function fillerPhraseBlockingOf(verdict: BlockFillerPhraseVerdict): boolean {
  return verdict.count >= BLOCK_FILLER_PHRASE_LIMIT;
}

// ═══════════════════ ④ 归因量化：重难点类章条目双达标率 <50% 阻断 ═══════════════════

/** 归因量化适用章（重难点类）：章/块标题任一命中即启用；
 * 质量/安全章的专属执行器按 S3「2.2 剩余执行器」依据生成数据扩展（缺口=注册表补项） */
export const ATTRIBUTION_QUANTIFICATION_SCOPE_RE = /重难点|重点难点|难点分析|难点|工程特点|施工特点|项目特点/u;

export function requiresAttributionQuantification(titleText: string): boolean {
  return ATTRIBUTION_QUANTIFICATION_SCOPE_RE.test(titleText);
}

export interface AttributionQuantificationVerdict {
  /** 条目总数（空行分段 ≥20 字，剥标题行后） */
  entries: number;
  /** 归因+量化双达标占比（与 difficultyCountermeasureReport.ratio 同源） */
  bothRatio: number;
  /** 未达标条目（供阻断反馈定向补齐） */
  missing: Array<{ text: string; attributed: boolean; quantified: boolean }>;
}

/** 块级归因量化扫描：条目切分/评估与终检 difficultyCountermeasureReport 完全同源 */
export async function scanAttributionQuantification(text: string): Promise<AttributionQuantificationVerdict> {
  const body = text.split('\n').filter(line => !/^\s*#{1,6}\s/u.test(line)).join('\n');
  const entries = splitDifficultyEntries(body);
  if (entries.length === 0) return { entries: 0, bothRatio: 1, missing: [] };
  const assessment = await assessDifficultyEntries(entries);
  return {
    entries: entries.length,
    bothRatio: assessment.ratio,
    missing: assessment.details.filter(item => !item.attributed || !item.quantified).slice(0, 8),
  };
}

/** 阻断判定：条目存在且双达标率低于验收线（50%，与 heavyTemplated 判定同源） */
export function attributionBlockingOf(verdict: AttributionQuantificationVerdict): boolean {
  return verdict.entries > 0 && verdict.bothRatio < 0.5;
}

// ═══════════════════ ⑥ 格式：后台/兜底话术硬约束 ═══════════════════

/** 后台/兜底话术命中行（≤5 行原文，供阻断反馈定向重写；词表与终检 formalTextGateIssues 同源） */
export function backstageFallbackHits(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && BACKSTAGE_OR_FALLBACK_TEXT_RE.test(line))
    .slice(0, 5);
}
