/**
 * 答疑澄清生效层（4.55.17 巢湖实测）：
 *
 * **问题**：招标文件与答疑/澄清文件对同一字段给出不同值时，生效的是**答疑后的值**——
 * 这一层此前只做对了一半：事实层有来源优先级（addendum 96 > 招标），但
 *   ① 答疑抽出来的值常是残片/指向形态（实测 canonical 里两条工期值：
 *      「见招标公告计划开工日期：2026年08月31日…」与「现澄清为如下：条款号…计划开工日期：2026年10月10日…」）
 *      ——前者虽标为 addendum，携带的却是**招标旧值**；
 *   ② 同一字段被拆成两个 key（duration / schedule_requirement）不归并，两值并存；
 *   ③ 蓝图某字段走文本正则、事实层走 canonical，两条链各取各的 → 同文档两套口径
 *      （实测：正文一处「本工程总工期为365日历天」、另一处「变更修改为330日历天」、进度表按 365 排到第 348 天）。
 *
 * **本模块**：把「变更后口径」抽成**显式 override 表**（生效值 + 被取代的旧值 + 来源），供三处消费：
 *   · 写作注入（现行口径硬约束：不得把被取代值作为现行表述）
 *   · 蓝图 contract（工期已由 resolveEffectiveTotalDays 处理，其余字段同源复用）
 *   · 终检一致性检测（supersededValueIssues：旧值以现行口径出现即 blocker）
 *
 * 判据（形态驱动，零 LLM）：变更句式（「X，现变更修改为 Y」「由 X 变更为 Y」「澄清为 Y」）优先；
 * 答疑来源中**平铺陈述**的字段值（如「计划开工日期：2026年10月10日」）视为生效值，
 * 招标来源的同类值登记为被取代值。
 */

/** 受管字段（答疑变更实际发生过的字段类型；新增字段在此登记即可全链生效） */
export const CLARIFICATION_FIELD_KEYS = ['计划工期', '开工日期', '质量标准'] as const;
export type ClarificationFieldKey = (typeof CLARIFICATION_FIELD_KEYS)[number];

export interface ClarificationOverride {
  field: ClarificationFieldKey;
  /** 生效值（答疑变更后口径；原样文本，供注入与比对） */
  effective: string;
  /** 被取代值（招标原文旧口径；正文不得再作为现行表述） */
  superseded: string[];
  /** 来源说明（人可追溯） */
  source: string;
}

/** 答疑/澄清来源判定（文件路径/来源串） */
export function isClarificationSource(source: string): boolean {
  return /补疑|补遗|答疑|澄清|更正|修改通知|question|clarif/iu.test(source || '');
}

const DURATION_RE = /(\d{1,4})\s*个?\s*日历天/gu;
const DATE_RE = /(20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/gu;

/** 变更句式：变更标记后紧跟目标值 */
const CHANGE_TO_DURATION_RE = /(?:变更修改为|变更为|澄清为|调整为|更正为|修正为|变更至|调整至)\s*[:：]?\s*(\d{1,4})\s*个?\s*日历天/u;
const CHANGE_TO_DATE_RE = /(?:变更修改为|变更为|澄清为|调整为|更正为|修正为|变更至|调整至)\s*[:：]?\s*(20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/u;

function normalizeDuration(raw: string): string {
  return `${raw.replace(/\s+/gu, '')}日历天`;
}

function normalizeDate(raw: string): string {
  return raw.replace(/\s+/gu, '');
}

/**
 * 从「资料文本 + 来源」集合抽取答疑变更覆盖表。
 * @param sources 形如 [{ text, source }]：source 为文件路径或来源串（用于答疑/招标判定）
 */
export function extractClarificationOverrides(sources: Array<{ text: string; source: string }>): ClarificationOverride[] {
  const overrides = new Map<ClarificationFieldKey, ClarificationOverride>();
  const tenderDurations = new Set<string>();
  const tenderDates = new Set<string>();
  const addendumDurations = new Set<string>();
  const addendumDates = new Set<string>();
  for (const item of sources) {
    const text = String(item.text || '');
    if (!text) continue;
    const isAddendum = isClarificationSource(item.source);
    // ① 变更句式（最强信号，不分来源）：变更后值为生效值，变更前值为被取代值
    for (const sentence of text.split(/[。；;\n]/u)) {
      const durationChange = CHANGE_TO_DURATION_RE.exec(sentence);
      if (durationChange) {
        const before = [...sentence.matchAll(DURATION_RE)].map(match => normalizeDuration(match[1]!)).filter(value => value !== normalizeDuration(durationChange[1]!));
        const effective = normalizeDuration(durationChange[1]!);
        const existing = overrides.get('计划工期');
        overrides.set('计划工期', {
          field: '计划工期',
          effective,
          superseded: [...new Set([...(existing?.superseded || []), ...before])],
          source: item.source,
        });
      }
      const dateChange = CHANGE_TO_DATE_RE.exec(sentence);
      if (dateChange) {
        const before = [...sentence.matchAll(DATE_RE)].map(match => normalizeDate(match[1]!)).filter(value => value !== normalizeDate(dateChange[1]!));
        const effective = normalizeDate(dateChange[1]!);
        const existing = overrides.get('开工日期');
        overrides.set('开工日期', {
          field: '开工日期',
          effective,
          superseded: [...new Set([...(existing?.superseded || []), ...before])],
          source: item.source,
        });
      }
    }
    // ② 平铺陈述：按来源分池（答疑池优先成为生效值，招标池登记为被取代值）
    // 关键修正（巢湖实测）：答疑文件里常**引用招标原文**（「见招标公告计划开工日期：2026年08月31日」），
    // 该值仍是**招标口径**而非答疑值——按句判定是否指向招标文本，指向者的值进招标池，否则按来源分池。
    for (const sentence of text.split(/[。；;\n]/u)) {
      const pointsToTender = /(?:见|详见)[^。；;\n]{0,12}(?:招标|公告|投标|前附表)/u.test(sentence);
      const durationPool = isAddendum && !pointsToTender ? addendumDurations : tenderDurations;
      const datePool = isAddendum && !pointsToTender ? addendumDates : tenderDates;
      for (const match of sentence.matchAll(DURATION_RE)) durationPool.add(normalizeDuration(match[1]!));
      for (const match of sentence.matchAll(DATE_RE)) datePool.add(normalizeDate(match[1]!));
    }
  }
  // 变更句式优先；无变更句式时：答疑池的值生效、招标池的值被取代（仅当两池都存在且不同）
  if (!overrides.has('计划工期') && addendumDurations.size > 0) {
    const effective = [...addendumDurations][0]!;
    overrides.set('计划工期', { field: '计划工期', effective, superseded: [...tenderDurations].filter(value => value !== effective), source: '答疑文件（平铺陈述）' });
  }
  if (!overrides.has('开工日期') && addendumDates.size > 0) {
    const effective = [...addendumDates][0]!;
    overrides.set('开工日期', { field: '开工日期', effective, superseded: [...tenderDates].filter(value => value !== effective), source: '答疑文件（平铺陈述）' });
  }
  return [...overrides.values()].filter(override => override.superseded.length > 0 || override.effective);
}

/** 现行口径注入块（写作硬约束：生效值与「不得作为现行表述」的旧值清单） */
export function renderClarificationConstraintBlock(overrides: ClarificationOverride[]): string {
  const rows = overrides.filter(override => override.superseded.length > 0);
  if (rows.length === 0) return '';
  return [
    '【答疑澄清生效口径（硬约束）】招标文件与答疑/澄清文件不一致时，以下为**现行唯一口径**，全文（含进度计划、节点、信息表、正文表述）必须一致使用；被取代的旧值仅在引用澄清原文时可出现，不得作为现行表述：',
    ...rows.map(override => `- ${override.field}：现行为「${override.effective}」；已被取代（不得再作为现行口径）：${override.superseded.join('、')}`),
  ].join('\n');
}

/**
 * 变更过程陈述语境（豁免判据单源，4.55.36 批次 2 起外引）：
 * 「原为 X，经答疑澄清变更为 Y」这类**如实说明变更过程**的句子出现旧值/修正前形态是合法的，
 * 若判残留，则每次正确叙述变更都会被判 blocker。
 * 单源消费方：
 *   · 本模块 `supersededValueIssues`（值级被取代值残留）；
 *   · clarificationAmendments（技术性修正的「被取代形态残留」——同族判据必须同措辞，
 *     两份各抄一份正则即漂移根源）。
 */
export const CHANGE_REFERENCE_CONTEXT_RE = /(?:澄清|变更|修改|调整为|更正|原(?:为|值)?|原招标|此前)/u;

/**
 * 被取代值现行表述检测（终检兜底）：正文把**已被答疑取代的旧值**当作现行口径陈述即 blocker。
 * 例外：旧值出现在「澄清/变更/原…现…」引用语境（说明变更过程）时合法——用户看到的正是
 * 「招标原文 365，现澄清为 330」这类必要说明；判据按句内是否含变更标记词豁免。
 * 与写作硬约束（renderClarificationConstraintBlock）同源：约束没被遵循时由本检测暴露。
 */
export function supersededValueIssues(markdown: string, overrides: ClarificationOverride[]): Array<{ level: 'error'; severity: 'blocker'; category: 'fact_consistency'; owner: 'llm'; repairability: 'llm_repairable'; provenance: { detectorId: string; fingerprint: string }; message: string; suggestion: string }> {
  const issues: ReturnType<typeof supersededValueIssues> = [];
  if (!markdown || overrides.length === 0) return issues;
  const CHANGE_CONTEXT_RE = CHANGE_REFERENCE_CONTEXT_RE;
  for (const override of overrides) {
    for (const value of override.superseded) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const hits = [...markdown.matchAll(new RegExp(escaped, 'gu'))];
      if (hits.length === 0) continue;
      // 句内（。；换行边界）含变更标记的引用合法；其余即旧值作现行表述
      const offending: string[] = [];
      for (const hit of hits) {
        const start = markdown.lastIndexOf('。', hit.index ?? 0) + 1;
        const endRaw = markdown.indexOf('。', (hit.index ?? 0) + value.length);
        const end = endRaw === -1 ? markdown.length : endRaw + 1;
        const sentence = markdown.slice(start, end);
        if (CHANGE_CONTEXT_RE.test(sentence)) continue;
        offending.push(sentence.trim().slice(0, 80));
      }
      if (offending.length === 0) continue;
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        provenance: { detectorId: 'superseded-value-usage', fingerprint: String(overrides.length) },
        message: `${override.field}口径错误：正文 ${offending.length} 处仍以被取代值「${value}」作为现行口径（现行为「${override.effective}」）——如「${offending[0]}」`,
        suggestion: `请把上述表述统一为现行口径「${override.effective}」（答疑澄清后生效值）；若确需说明变更过程，须写成引用形态（如「招标文件原为${value}，经答疑澄清变更为${override.effective}」），不得单独以旧值陈述现状。`,
      });
    }
  }
  return issues;
}
