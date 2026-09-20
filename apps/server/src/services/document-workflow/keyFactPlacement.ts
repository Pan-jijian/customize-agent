/**
 * keyFactPlacement：关键事实落位审计（C-T7）——「已确认关键事实须落位清单」的验收出口。
 *
 * 背景（#50 根治）：已确认关键事实（招标人/项目名称/工期/造价口径等）此前无统一落位清单——
 * fact-coverage 按「重要事实」宽口径报未落位告警（可优化类混入其中，导出不阻断），关键事实的
 * 落位率无从量化核验。本模块给出 C-T7 验收口径：须落位清单 = PROJECT_BASIC_FIELD_SPECS 前 8 项
 * 基础字段（项目名称/项目编号/招标人/建设地点/建设规模/计划工期/质量标准/合同估算价）中「有值」
 * 的字段；落位判定 = 该字段任一候选值经 factValueAppears 命中正文。
 *
 * 口径单源：候选值清洗链与基本信息表/canonical/落位检测一致——标签前缀剥离（#50）+ 名称与编号
 * 连读拆分（#4）；落位判定复用 factCoverage.factValueAppears（与 fact-coverage 检测器同一实现）。
 * 降级原则：关键事实池为空（无有值字段）时返回 undefined（分量不可用显式降级，与 C-T5/C-T6 一致）。
 */
import type { DocumentFact } from './types';
import { fieldSpecForFact, PROJECT_BASIC_FIELD_SPECS } from './factGovernance';
import { stripFactLabelPrefix, stripTrailingNameCodeBinding } from './factsModel';
import { factValueAppears, isMisExtractedFactText } from './helpers/factCoverage';
import { stringifyFactValue } from './utils';

/** C-T7 关键事实规格集（PROJECT_BASIC_FIELD_SPECS 前 8 项基础字段；P2 治理扩围字段不在基础信息口径内） */
export const KEY_FACT_PLACEMENT_SPEC_KEYS = [
  'project_name', 'project_code', 'owner', 'project_location', 'project_scale',
  'schedule_requirement', 'quality_standard', 'project_investment_estimate',
] as const;

/** 关键事实候选（清单项：规格 + 清洗后值） */
export interface KeyPlacementFact {
  key: string;
  label: string;
  value: string;
}

/** 关键事实落位审计（DocumentQualityReport.keyFactPlacementAudit 出口） */
export interface KeyFactPlacementAudit {
  /** 须落位清单规模（有值的关键事实规格数） */
  specs: number;
  /** 已落位规格数（任一候选值在正文命中） */
  placed: number;
  /** 未落位明细（`标签：值`，供落位复核定位；截前 20 条） */
  unplaced: string[];
  /** 关键事实落位率 = placed/specs（C-T7 验收判据：100% ⇔ rate===1） */
  rate: number | null;
}

/** 占位/未确认值（锚定式口径：不得作为须落位项，也不得误伤含「无」字的真实值如「无为市…」） */
const PLACEHOLDER_VALUE_RE = /资料未明确|系统暂未从知识库确认|项目资料暂未明确|^(?:无|暂无|未确认|待确认)$/u;

/**
 * 关键事实候选池收集（清单口径）：fieldSpecForFact 匹配 → 关键规格子集 → 值清洗（标签前缀剥离 +
 * 名称编号拆分）→ 占位/坏值剔除 → 按「规格|值」去重。坏值筛选与 fact-coverage 落位候选同口径
 * （清单条目名/签章残片/坐标残渣不构成须落位项，避免审计虚计未落位）。
 */
export function collectKeyPlacementFacts(facts: Array<DocumentFact | null | undefined> | undefined | null): KeyPlacementFact[] {
  const pool: KeyPlacementFact[] = [];
  if (!facts || facts.length === 0) return pool;
  const keySet = new Set<string>(KEY_FACT_PLACEMENT_SPEC_KEYS);
  const seen = new Set<string>();
  for (const fact of facts) {
    if (!fact) continue;
    const spec = fieldSpecForFact(fact);
    if (!spec || !keySet.has(spec.key)) continue;
    const labelText = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
    const value = stringifyFactValue(fact.value).trim();
    if (!value || PLACEHOLDER_VALUE_RE.test(value)) continue;
    // 清单表「项目名称」列值是清单条目名而非工程全名，不可作落位候选（与 uncoveredImportantFacts 同口径）
    if (/项目名称|工程名称/u.test(labelText)
      && (fact.processingType === 'table' || fact.processingType === 'structured_data' || /bill_of_quantities/u.test(fact.roleId || ''))) continue;
    if (isMisExtractedFactText(labelText, value)) continue;
    // C-T7 清洗链（口径单源）：标签前缀剥离（#50）→ 名称+编号连读拆分（#4）→ 空白归一
    const cleaned = stripTrailingNameCodeBinding(stripFactLabelPrefix(value)).replace(/\s+/gu, ' ').trim();
    if (!cleaned) continue;
    const dedupeKey = `${spec.key}|${cleaned}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    pool.push({ key: spec.key, label: spec.label, value: cleaned });
  }
  return pool;
}

/** 构建关键事实落位审计：无有值关键事实时返回 undefined（分量不可用显式降级，与 B-T3/C-T5/C-T6 一致） */
export function buildKeyFactPlacementAudit(
  markdown: string,
  facts: Array<DocumentFact | null | undefined> | undefined | null,
): KeyFactPlacementAudit | undefined {
  const pool = collectKeyPlacementFacts(facts);
  if (pool.length === 0) return undefined;
  const bySpec = new Map<string, { label: string; values: string[] }>();
  for (const item of pool) {
    const entry = bySpec.get(item.key) ?? { label: item.label, values: [] };
    entry.values.push(item.value);
    bySpec.set(item.key, entry);
  }
  let placed = 0;
  const unplaced: string[] = [];
  // 规格序遍历（KEY_FACT_PLACEMENT_SPEC_KEYS 声明序）：审计输出顺序确定、可复现
  for (const key of KEY_FACT_PLACEMENT_SPEC_KEYS) {
    const entry = bySpec.get(key);
    if (!entry) continue;
    if (entry.values.some(value => factValueAppears(markdown || '', value))) {
      placed += 1;
      continue;
    }
    unplaced.push(`${entry.label}：${entry.values[0]!.slice(0, 60)}`);
  }
  const specs = bySpec.size;
  return {
    specs,
    placed,
    unplaced: unplaced.slice(0, 20),
    rate: specs > 0 ? placed / specs : null,
  };
}
