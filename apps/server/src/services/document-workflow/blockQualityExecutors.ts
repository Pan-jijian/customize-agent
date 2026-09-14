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
 * - 归因量化：重难点类章条目须含归因链与量化目标，双达标率 <50% 阻断（assessDifficultyEntries
 *   与 difficultyCountermeasureReport 同源，同验收线 ≥50%）；
 * - 数值：正文数值 vs 证据池对账矛盾即阻断（writeBlock 内联 reconcileContentNumbers，
 *   终检同源复核 cross-section-numeric-conflict 等数值族）；
 * - 格式：后台/兜底话术硬约束（BACKSTAGE_OR_FALLBACK_TEXT_RE 与终检 formalTextGateIssues 同源）。
 */
import { documentTextLength } from './budget';
import { BACKSTAGE_OR_FALLBACK_TEXT_RE } from './markdownComposer';
import { assessDifficultyEntries, buildFillerSentencePool, judgeFillerSentences, splitDifficultyEntries } from './tenderBidChecks';

// ═══════════════════ ② 密度：事实落位比例口径（≥1.5/千字） ═══════════════════

/** 密度执行线（每千字不同量化参数个数）：提示词指令线 2/千字，验收线 1.5/千字留 25% 裕度 */
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
