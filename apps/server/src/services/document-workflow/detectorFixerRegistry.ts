/**
 * 检测器/修复器/权威口径三元组注册表（第 2 期 P6/P7/P8/P13/P23）：
 * - 权威口径（AuthorityEntry）：工期/装配率/支护体系/劳动力峰值/绿化养护期/蓝图/已决策事实七类权威
 *   单源登记，检测器与修复器声明引用同一 AuthorityId，禁止私造第二份抽取口径；
 * - 检测器（DetectorEntry）：buildFullValidationIssues（full-validation 组）与
 *   buildStandardFinalValidationIssues（standard-final 组）的全部检测器在此登记元数据
 *   （id / 权威依赖 / deterministicSafe / scope / category），执行侧经 det() 包装登记引用；
 * - 修复器（FixerEntry）：确定性修复器（SURFACE_FIX_STEPS 锚定声明）与 LLM patch 修复轮
 *   （LLM_PATCH_REPAIR_ROUNDS 七调用点声明）强制 anchoredTo 锚定检测器——检测定位=修复定位；
 * - assertRegistryConsistency：启动与单测执行的结构一致性检查（锚定存在性 / 权威集合相等 /
 *   llm-patch 必带 patchGuard / patchGuard 引用检测器必须 deterministicSafe / category 合法性）。
 *
 * 全部声明为纯元数据：检测与修复执行仍走原函数路径（行为保持），注册表只承载口径声明与一致性约束。
 */
import { buildCanonicalFacts } from './factGovernance';
import {
  extractAssemblyRateAuthority,
  extractGreeningMaintenanceAuthority,
  extractScheduleAuthority,
  extractSupportSystemAuthority,
} from './documentIntegrityChecks';
import { blueprintLaborPeakAuthority } from './authorityIndex';
import type { BlueprintData } from './integratedBlueprint';
import { SURFACE_FIX_STEPS } from './deterministicFixChains';
import type { DocumentFact, DocumentFactsModel, ValidationIssue } from './types';

export type AuthorityId =
  | 'schedule'
  | 'assemblyRate'
  | 'supportSystem'
  | 'laborPeak'
  | 'greeningMaintenance'
  | 'blueprint'
  | 'canonicalFacts';

/** 权威口径抽取上下文（AuthorityEntry.extract 统一输入，与消费点同源同口径） */
export interface AuthorityExtractionContext {
  factsModel: DocumentFactsModel;
  blueprint?: BlueprintData;
  markdown?: string;
  structuredFacts?: DocumentFact[];
}

/** 权威口径条目：检测器与修复器共用同一抽取函数，防「修复用蓝图、检测用表峰值」类口径拉扯 */
export interface AuthorityEntry<T = unknown> {
  id: AuthorityId;
  /** 权威口径抽取函数（与检测器/修复器消费端同源；返回 undefined 表示该权威不可用） */
  extract: (ctx: AuthorityExtractionContext) => T | undefined;
}

/** 权威口径注册表：顺序无执行语义，仅作单源声明 */
export const AUTHORITY_REGISTRY: readonly AuthorityEntry[] = [
  { id: 'schedule', extract: ctx => extractScheduleAuthority(ctx.factsModel) },
  { id: 'assemblyRate', extract: ctx => extractAssemblyRateAuthority(ctx.factsModel) },
  { id: 'supportSystem', extract: ctx => extractSupportSystemAuthority(ctx.factsModel) },
  { id: 'laborPeak', extract: ctx => blueprintLaborPeakAuthority(ctx.blueprint) },
  { id: 'greeningMaintenance', extract: ctx => extractGreeningMaintenanceAuthority(ctx.factsModel) },
  { id: 'blueprint', extract: ctx => ctx.blueprint },
  { id: 'canonicalFacts', extract: ctx => buildCanonicalFacts({ facts: ctx.structuredFacts ?? [], markdown: ctx.markdown ?? '' }) },
];

/** 检测器条目：检测定位声明（执行侧 det() 引用登记，元数据单源于此） */
export interface DetectorEntry {
  id: string;
  /** 检测依赖的权威口径（与锚定修复器的 authorities 一致性检查比对） */
  authorities?: AuthorityId[];
  /** 纯词表/正则确定性检测器（单字符串输入、零误伤），可进 patchGuard 预检集 */
  deterministicSafe?: boolean;
  scope: 'chapter' | 'full-document';
  /** 对齐 ValidationIssue.category */
  category: string;
}

/**
 * 检测器 category 合法值全集（V2 批3 门禁升级 L3）：与 ValidationIssue.category 联合类型单源对齐。
 * 门禁硬阻断按 category 判定（buildExportGate 黑名单式全量阻断），缺卡/错卡的声明会使检测器
 * 静默逃逸硬阻断——「新检测器上线不生效」陷阱的根因之一，故纳入注册表一致性强制校验。
 */
export const VALID_DETECTOR_CATEGORIES: ReadonlySet<string> = new Set([
  'structure', 'table', 'fact_consistency', 'evidence_coverage', 'professional_chain', 'control_loop', 'format', 'style', 'scope',
] satisfies NonNullable<ValidationIssue['category']>[]);

/** 修复器条目：修复定位声明（anchoredTo 强制锚定检测器，防修复无检测哑火） */
export interface FixerEntry {
  id: string;
  kind: 'deterministic' | 'llm-patch';
  /** 锚定检测器 id（检测定位=修复定位强制声明） */
  anchoredTo: string;
  /** 修复依赖的权威口径（必须与锚定检测器集合相等） */
  authorities?: AuthorityId[];
  /** llm-patch 必填：patch 应用前预检的检测器集（全部 deterministicSafe） */
  patchGuard?: { detectors: string[] };
  /** 对齐「单轮失败即放弃」语义（既有修复器全部单轮语义） */
  giveUpOnFailure: true;
}

// ═══════════════════════════ 检测器声明表 ═══════════════════════════

/** buildFullValidationIssues 核心校验组（documentPipeline.ts，按调用顺序） */
export const FULL_VALIDATION_DETECTORS: readonly DetectorEntry[] = [
  { id: 'spec-gate-rules', scope: 'full-document', category: 'structure' },
  { id: 'auto-spec-validation', scope: 'full-document', category: 'structure' },
  { id: 'fact-consistency', scope: 'full-document', category: 'fact_consistency' },
  { id: 'project-contamination', scope: 'full-document', category: 'scope' },
  { id: 'project-basic-placeholder', scope: 'full-document', category: 'format' },
  { id: 'standard-final', scope: 'full-document', category: 'structure' },
  { id: 'fact-coverage', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'page-target', scope: 'full-document', category: 'structure' },
  { id: 'document-budget', scope: 'full-document', category: 'structure' },
  { id: 'formal-text-gate', scope: 'full-document', category: 'format' },
  { id: 'heading-uncovered-engineering-items', scope: 'full-document', category: 'structure' },
  { id: 'writer-missing-section', scope: 'full-document', category: 'structure', deterministicSafe: true },
  { id: 'critical-section-depth', scope: 'chapter', category: 'structure' },
  { id: 'critical-section-fact-density', scope: 'chapter', category: 'evidence_coverage' },
  // 方案 2.2 密度执行器终检同源复核（chapterFactDensityIssues）：写作侧 block-fact-density 的
  // finalize 复核函数（同 factDensityVerdict 比例口径 1.5/千字），检测⊆写作
  { id: 'chapter-fact-density', scope: 'chapter', category: 'evidence_coverage' },
  { id: 'construction-org-professional-audit', scope: 'chapter', category: 'professional_chain' },
];

/** buildStandardFinalValidationIssues 终检组（documentFinalValidation.ts，按调用顺序；与 full-validation 重复的条目见下方注释） */
export const STANDARD_FINAL_DETECTORS: readonly DetectorEntry[] = [
  { id: 'toc-consistency', scope: 'full-document', category: 'structure', deterministicSafe: true },
  // L5 结构完整性门禁（sectionNumberingIssues）：正文 H3 编号连续性（章号=章序、节号 1..N 无跳号无重复），缺号=blocker
  { id: 'section-numbering', scope: 'full-document', category: 'structure', deterministicSafe: true },
  // L5 结构完整性门禁（sectionCountOverflowIssues）：成稿 H3 数不得超过主题块数（多节方向；缺节由 section-content-integrity 覆盖）
  { id: 'section-count-overflow', scope: 'chapter', category: 'structure' },
  { id: 'heading-duplicate', scope: 'full-document', category: 'structure', deterministicSafe: true },
  // V2 批1 结构完整性（structureIntegrityIssues）：编号跳号/孤立编号/孤立单项列表/重复表头/表内重复行/
  // 重复行/相邻重复句（cleanable）+ 截断/空节/表名混入表头/空表/标点断裂（blocking）；确定性修复器 structure-integrity 收口
  { id: 'structure-integrity', scope: 'full-document', category: 'structure', deterministicSafe: true },
  // WS1 结构标签残留（templatedLabelIssues）：标签标题/段首标签前缀，确定性修复器 templated-labels 兜底
  { id: 'templated-label', scope: 'full-document', category: 'structure', deterministicSafe: true },
  // WS1 标题完整性（titleIntegrityIssues）：残缺标题（<4 汉字）/句化标题（含逗号）/悬挂连接词结尾
  { id: 'title-integrity', scope: 'full-document', category: 'structure' },
  { id: 'evaluation-criteria-coverage', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'requirements-coverage', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'fabricated-start-date', scope: 'full-document', category: 'fact_consistency', deterministicSafe: true },
  { id: 'field-value-mismatch', scope: 'full-document', category: 'fact_consistency', deterministicSafe: true },
  { id: 'area-arithmetic', scope: 'full-document', category: 'fact_consistency', deterministicSafe: true },
  { id: 'resource-consistency', scope: 'full-document', category: 'fact_consistency', authorities: ['laborPeak'] },
  { id: 'node-schedule-consistency', scope: 'full-document', category: 'fact_consistency' },
  { id: 'cross-section-numeric-conflict', scope: 'full-document', category: 'fact_consistency' },
  // D4 数值对账六类（批 1 事实溯源专项）：正文数值 vs 清单事实锁+蓝图参数桶的确定性关系型对账
  //（合计推导/规格-数值绑定/语义槽位/近似口径/分项显式/名称口径；权威缺失的规则自行跳过）
  { id: 'fact-reconciliation', scope: 'full-document', category: 'fact_consistency', authorities: ['blueprint'] },
  { id: 'greening-maintenance-mismatch', scope: 'full-document', category: 'fact_consistency', authorities: ['greeningMaintenance'] },
  { id: 'street-light-count-mismatch', scope: 'full-document', category: 'fact_consistency' },
  { id: 'spec-location-mismatch', scope: 'full-document', category: 'fact_consistency' },
  { id: 'blueprint-citation-consistency', scope: 'full-document', category: 'fact_consistency', authorities: ['blueprint'] },
  // V5 P4b 跨工程同值复制（清单分组明细 groups 与正文分工程语境比对；依赖蓝图数据）
  { id: 'cross-project-value-copy', scope: 'full-document', category: 'fact_consistency', authorities: ['blueprint'] },
  // V5 P4b 阶段人数混用（正文「XX阶段 + N 人」 vs byPhase 推导权威）
  { id: 'phase-labor-mixing', scope: 'full-document', category: 'fact_consistency', authorities: ['blueprint'] },
  // V5 P4b-2 机械设备分批台数矛盾（「首批N台…剩余M台」之和 ≠ 蓝图汇总台数，12:33 评审 P0-2）
  { id: 'equipment-batch-conflict', scope: 'full-document', category: 'fact_consistency', authorities: ['blueprint'] },
  // V5 P4b-2 前期动作时限矛盾（「开工后第N日」N ≥ 总工期：竣工日安排开工前准备动作，12:33 评审 P0-3）
  { id: 'preliminary-action-timing', scope: 'full-document', category: 'fact_consistency', authorities: ['blueprint'] },
  { id: 'foundation-form-residue', scope: 'full-document', category: 'fact_consistency' },
  { id: 'ambiguous-either-or', scope: 'full-document', category: 'fact_consistency', authorities: ['supportSystem'] },
  { id: 'excavation-depth-lock', scope: 'full-document', category: 'fact_consistency' },
  { id: 'excavation-hazard-classification', scope: 'full-document', category: 'fact_consistency' },
  { id: 'support-form-fact-consistency', scope: 'full-document', category: 'fact_consistency', authorities: ['supportSystem'] },
  { id: 'equipment-entry-timing', scope: 'full-document', category: 'fact_consistency' },
  { id: 'fabricated-award', scope: 'full-document', category: 'fact_consistency' },
  { id: 'bidder-qualification-section', scope: 'full-document', category: 'scope' },
  { id: 'cross-chapter-duplicate-section', scope: 'chapter', category: 'structure' },
  { id: 'basic-info-schedule-field', scope: 'full-document', category: 'fact_consistency' },
  { id: 'duplicate-table', scope: 'full-document', category: 'table' },
  { id: 'duplicate-paragraph', scope: 'full-document', category: 'structure' },
  { id: 'paragraph-tail-repeat', scope: 'full-document', category: 'style', deterministicSafe: true },
  { id: 'collision-numbered-heading', scope: 'full-document', category: 'structure', deterministicSafe: true },
  { id: 'inverted-date-range', scope: 'full-document', category: 'fact_consistency', deterministicSafe: true },
  { id: 'resource-triad-section-hierarchy', scope: 'full-document', category: 'structure' },
  { id: 'support-system-conflict', scope: 'full-document', category: 'fact_consistency', authorities: ['supportSystem'] },
  { id: 'dangerous-list-consistency', scope: 'full-document', category: 'fact_consistency' },
  // R12 危大排除声明 vs 危大清单表格矛盾（舒城第二轮实测：声明无24m脚手架/无10kN吊装，清单表格却列为危大工程）
  { id: 'hazard-exclusion-contradiction', scope: 'full-document', category: 'fact_consistency' },
  { id: 'six-hundred-percent-coverage', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'self-undermining-candidate', scope: 'full-document', category: 'style' },
  { id: 'paragraph-opening-repeat', scope: 'full-document', category: 'style', deterministicSafe: true },
  // WS3 工序表达形式轮换（flowFormRepeatIssues）：分部分项章相邻块同形式即违规
  { id: 'flow-form-repeat', scope: 'full-document', category: 'style' },
  // WS4 骨架指纹复读（skeletonFingerprintIssues）：由技术负责人组织/合格后方可/验收合格后 各全文 ≤2 次；
  // 4.40 d5e 扩展变体形态：同义替换单形态全篇 ≤8 次（示例变体被 LLM 集中抄写 37/28/17 次实锤）
  { id: 'skeleton-fingerprint', scope: 'full-document', category: 'style' },
  { id: 'repeated-word', scope: 'full-document', category: 'style', deterministicSafe: true },
  { id: 'commercial-data-in-body', scope: 'full-document', category: 'scope' },
  { id: 'overview-recap', scope: 'full-document', category: 'style' },
  { id: 'closure-phrase-density-cap', scope: 'full-document', category: 'style' },
  { id: 'parameter-concept-conflict', scope: 'full-document', category: 'fact_consistency' },
  { id: 'internal-terminology-anchor', scope: 'full-document', category: 'style', deterministicSafe: true },
  { id: 'construction-system-coverage', scope: 'chapter', category: 'evidence_coverage' },
  { id: 'dangerous-applicability', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'innovation-tech-coverage', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'instruction-like-heading', scope: 'full-document', category: 'structure' },
  { id: 'formal-heading-hierarchy', scope: 'full-document', category: 'structure', deterministicSafe: true },
  { id: 'formal-content-integrity', scope: 'full-document', category: 'format', deterministicSafe: true },
  { id: 'punctuation-artifact', scope: 'full-document', category: 'format', deterministicSafe: true },
  { id: 'table-quality', scope: 'full-document', category: 'table', deterministicSafe: true },
  { id: 'table-spam', scope: 'full-document', category: 'table', deterministicSafe: true },
  { id: 'basis-regulations-coverage', scope: 'full-document', category: 'fact_consistency', authorities: ['blueprint'] },
  { id: 'resource-breakdown-consistency', scope: 'full-document', category: 'fact_consistency', authorities: ['blueprint'] },
  { id: 'section-content-integrity', scope: 'chapter', category: 'structure' },
  { id: 'professional-content', scope: 'chapter', category: 'professional_chain' },
  { id: 'professional-score', scope: 'chapter', category: 'professional_chain' },
  { id: 'generic-professional-content', scope: 'chapter', category: 'professional_chain' },
  { id: 'management-measure-number', scope: 'chapter', category: 'professional_chain' },
  { id: 'closed-loop-density', scope: 'full-document', category: 'control_loop' },
  { id: 'cross-chapter-consistency', scope: 'full-document', category: 'fact_consistency' },
  { id: 'process-spec-conflict', scope: 'full-document', category: 'fact_consistency' },
  { id: 'evidence-usage-coverage', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'paragraph-generic', scope: 'full-document', category: 'style' },
  { id: 'construction-org-generic-language', scope: 'chapter', category: 'style' },
  { id: 'construction-org-control-loop', scope: 'chapter', category: 'control_loop' },
  { id: 'construction-org-professional-chain', scope: 'chapter', category: 'professional_chain' },
  { id: 'construction-org-consistency', scope: 'full-document', category: 'fact_consistency' },
  { id: 'construction-org-chapter-data-coverage', scope: 'chapter', category: 'evidence_coverage' },
  { id: 'construction-org-major-content', scope: 'chapter', category: 'professional_chain' },
  { id: 'construction-org-division-section', scope: 'chapter', category: 'structure' },
  { id: 'major-content-governance', scope: 'full-document', category: 'structure' },
  { id: 'construction-org-bonus-module', scope: 'chapter', category: 'professional_chain' },
  { id: 'chapter-dependency', scope: 'chapter', category: 'professional_chain' },
  { id: 'document-delivery-score', scope: 'full-document', category: 'professional_chain' },
  { id: 'generated-fact-verification', scope: 'full-document', category: 'fact_consistency' },
  { id: 'duplicate-basic-info', scope: 'full-document', category: 'structure' },
  { id: 'formal-style', scope: 'full-document', category: 'style' },
  { id: 'tertiary-heading', scope: 'full-document', category: 'structure', deterministicSafe: true },
  { id: 'min-chapter-section', scope: 'chapter', category: 'structure' },
  { id: 'precise-fact-usage', scope: 'full-document', category: 'fact_consistency' },
  { id: 'boq-placement', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'stage-phrasing', scope: 'full-document', category: 'fact_consistency' },
  { id: 'emergency-section-depth', scope: 'full-document', category: 'structure' },
  { id: 'boq-row-trace', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'drawing-reference', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'web-evidence-leakage', scope: 'full-document', category: 'scope' },
  { id: 'formal-placeholder', scope: 'full-document', category: 'format', deterministicSafe: true },
  { id: 'prompt-example-leak', scope: 'full-document', category: 'format' },
  { id: 'degenerate-content', scope: 'chapter', category: 'style' },
  { id: 'planned-auto-spec-gate', scope: 'full-document', category: 'structure' },
  // 暗标正文禁表反向门禁（markdownComposer.bodyCompositionTableIssues，标书编制规格 bodyTablePolicy=forbidden）：
  // 正文残留 Markdown 表格即 blocker（招标暗标要求正文纯文字，结构化数据由文末附表区承载）
  { id: 'bid-composition-body-table', scope: 'full-document', category: 'structure' },
  { id: 'planned-structure', scope: 'full-document', category: 'structure' },
  { id: 'prompt-document-rule', scope: 'full-document', category: 'format' },
  { id: 'local-adaptation-keyword', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'boq-division-coverage', scope: 'full-document', category: 'evidence_coverage' },
];

/**
 * 修复轮锚定检测器（不属上述两组标准数组、由修复轮/门禁独立消费的检测器）：
 * 全部为 FixerEntry.anchoredTo 或 patchGuard.detectors 的引用目标，保证锚定存在性检查可判定；
 * 另含块级质量执行器组（方案 2.2）：chapterGeneration.writeBlock 经 det() 登记消费，
 * 不参与 full-validation/standard-final 组哑火检查（写作时阻断与终检复核双职，注册单源于此）。
 */
export const AUXILIARY_DETECTORS: readonly DetectorEntry[] = [
  { id: 'important-unplaced-facts', scope: 'chapter', category: 'evidence_coverage' },
  { id: 'table-plan-execution', scope: 'chapter', category: 'table' },
  { id: 'templating-filler', scope: 'full-document', category: 'style' },
  { id: 'templating-difficulty', scope: 'full-document', category: 'professional_chain' },
  { id: 'workpackage-skeleton', scope: 'chapter', category: 'structure' },
  { id: 'planned-section-completeness', scope: 'chapter', category: 'structure' },
  { id: 'global-consistency-review', scope: 'full-document', category: 'fact_consistency' },
  { id: 'source-enumeration', scope: 'full-document', category: 'style', deterministicSafe: true },
  { id: 'meta-discourse-declaration', scope: 'full-document', category: 'style', deterministicSafe: true },
  { id: 'finish-thickness', scope: 'full-document', category: 'fact_consistency', deterministicSafe: true },
  { id: 'formula-residue', scope: 'full-document', category: 'format', deterministicSafe: true },
  { id: 'truncated-sentence', scope: 'full-document', category: 'format', deterministicSafe: true },
  // ── 块级质量执行器（方案 2.2 六类，写作时阻断 + finalize 同源复核双职；实现单源 blockQualityExecutors）──
  // ① 结构（契约小节全覆盖/禁发明编号：writeBlock 内联判定，终检复核 section-content-integrity 族）
  { id: 'block-structure-contract', scope: 'chapter', category: 'structure' },
  // ② 密度（事实落位 ≥1.5/千字比例口径：assessBlockFactDensity，终检复核 chapter-fact-density）
  { id: 'block-fact-density', scope: 'chapter', category: 'evidence_coverage' },
  // ③ 模板化（套话句占比 >10% 或模糊句式 ≥3 处/块：scanBlockTemplating，终检复核 templating-filler）
  { id: 'block-templating', scope: 'chapter', category: 'style' },
  // ④ 归因量化（重难点类章条目双达标率 <50%：scanAttributionQuantification，终检复核 templating-difficulty）
  { id: 'block-attribution-quantification', scope: 'chapter', category: 'professional_chain' },
  // ⑤ 数值（正文数值 vs 证据池对账矛盾即阻断：writeBlock 内联 reconcileContentNumbers，终检复核数值族）
  { id: 'block-numeric-reconciliation', scope: 'chapter', category: 'fact_consistency' },
  // ⑥ 格式（后台/兜底话术硬约束：backstageFallbackHits，终检复核 formal-text-gate）
  { id: 'block-format-constraints', scope: 'chapter', category: 'format' },
];

// ═══════════════════════════ 修复器声明表 ═══════════════════════════

/** 确定性修复器锚定声明（与 SURFACE_FIX_STEPS 一一对应；id 即注册键；顺序与 SURFACE_FIX_STEPS 严格一致） */
export const DETERMINISTIC_FIXER_ANCHORS: readonly FixerEntry[] = [
  { id: 'table-line-residue', kind: 'deterministic', anchoredTo: 'table-quality', giveUpOnFailure: true },
  // WS1 结构标签残留清洗（标签标题行删除/段首前缀剥离，正文零丢失）
  { id: 'templated-labels', kind: 'deterministic', anchoredTo: 'templated-label', giveUpOnFailure: true },
  // V2 批1 结构完整性确定性清理（与检测器 structure-integrity 同源单扫描：检测定位=清理定位）
  { id: 'structure-integrity', kind: 'deterministic', anchoredTo: 'structure-integrity', giveUpOnFailure: true },
  { id: 'repeated-words', kind: 'deterministic', anchoredTo: 'repeated-word', giveUpOnFailure: true },
  { id: 'duplicate-tables', kind: 'deterministic', anchoredTo: 'duplicate-table', giveUpOnFailure: true },
  { id: 'finish-thickness', kind: 'deterministic', anchoredTo: 'finish-thickness', giveUpOnFailure: true },
  // 4.31 埋深/覆土槽位数值错位删除（丰乐镇 v6 #3）：与检测器 fact-reconciliation D4.3 同源（blueprint 权威）
  { id: 'slot-depth-value', kind: 'deterministic', anchoredTo: 'fact-reconciliation', authorities: ['blueprint'], giveUpOnFailure: true },
  { id: 'labor-peak', kind: 'deterministic', anchoredTo: 'resource-consistency', authorities: ['laborPeak'], giveUpOnFailure: true },
  // V5 P4b-2 阶段劳动力确定性回写（与检测器 phase-labor-mixing 同源双通道扫描；蓝图权威）
  { id: 'phase-labor-values', kind: 'deterministic', anchoredTo: 'phase-labor-mixing', authorities: ['blueprint'], giveUpOnFailure: true },
  // A3 资源章数值拆分确定性统一（4.27.0）：与检测器 resource-breakdown-consistency 同源（blueprint 权威）
  { id: 'resource-breakdown', kind: 'deterministic', anchoredTo: 'resource-breakdown-consistency', authorities: ['blueprint'], giveUpOnFailure: true },
  { id: 'internal-table-row-dup', kind: 'deterministic', anchoredTo: 'table-spam', giveUpOnFailure: true },
  // 4.31 基础信息表重复合并（丰乐镇 v6 #70）：与检测器 table-quality（markdownTableQualityIssues）同源
  { id: 'duplicate-basic-info-tables', kind: 'deterministic', anchoredTo: 'table-quality', giveUpOnFailure: true },
  // 4.31 表格兜底话术行删除（丰乐镇 v6 #86/87）：与门禁检测器 formal-placeholder 同词表
  { id: 'fallback-placeholder-rows', kind: 'deterministic', anchoredTo: 'formal-placeholder', giveUpOnFailure: true },
  { id: 'greening-maintenance', kind: 'deterministic', anchoredTo: 'greening-maintenance-mismatch', authorities: ['greeningMaintenance'], giveUpOnFailure: true },
  { id: 'paragraph-opening-repeat', kind: 'deterministic', anchoredTo: 'paragraph-opening-repeat', giveUpOnFailure: true },
  { id: 'paragraph-tail-repeat', kind: 'deterministic', anchoredTo: 'paragraph-tail-repeat', giveUpOnFailure: true },
  { id: 'collision-numbered-heading', kind: 'deterministic', anchoredTo: 'collision-numbered-heading', giveUpOnFailure: true },
  // 4.31 小节标题工程类别未覆盖改名（丰乐镇 v6 #90）：与检测器 heading-uncovered-engineering-items 同源单扫描
  { id: 'heading-uncovered-items', kind: 'deterministic', anchoredTo: 'heading-uncovered-engineering-items', giveUpOnFailure: true },
  { id: 'inverted-date-range', kind: 'deterministic', anchoredTo: 'inverted-date-range', giveUpOnFailure: true },
  { id: 'truncated-sentence', kind: 'deterministic', anchoredTo: 'truncated-sentence', giveUpOnFailure: true },
  { id: 'meta-discourse', kind: 'deterministic', anchoredTo: 'meta-discourse-declaration', giveUpOnFailure: true },
  { id: 'formula-residue', kind: 'deterministic', anchoredTo: 'formula-residue', giveUpOnFailure: true },
  { id: 'self-undermining', kind: 'deterministic', anchoredTo: 'self-undermining-candidate', giveUpOnFailure: true },
  // A4 关键设计决策两可表述唯一化（4.27.0）：与检测器 ambiguous-either-or 同源（supportSystem 权威）
  { id: 'ambiguous-either-or', kind: 'deterministic', anchoredTo: 'ambiguous-either-or', authorities: ['supportSystem'], giveUpOnFailure: true },
  { id: 'empty-scoring-response', kind: 'deterministic', anchoredTo: 'requirements-coverage', giveUpOnFailure: true },
  // 4.27.2 招标元语言确定性清理（语气泄漏治理）：与检测器 formal-style（文风泄漏/后台话术）同源锚定——
  // 「按招标文件要求/约定」条幅与调用式元语言属正式文风失分面，检测定位=修复定位
  { id: 'tender-meta-language', kind: 'deterministic', anchoredTo: 'formal-style', giveUpOnFailure: true },
  // 4.32 配置禁用词确定性清洗（丰乐镇 v6 #59）：与门禁检测器 formal-text-gate（forbiddenTexts 阻断词）同源
  { id: 'forbidden-configuration', kind: 'deterministic', anchoredTo: 'formal-text-gate', giveUpOnFailure: true },
  // 4.31 编制依据地方性法规补写（丰乐镇 v6 #71）：与检测器 basis-regulations-coverage 同源（blueprint 权威）
  { id: 'basis-regulation-region', kind: 'deterministic', anchoredTo: 'basis-regulations-coverage', authorities: ['blueprint'], giveUpOnFailure: true },
  // 4.32 工伤保险缴纳表述补写（丰乐镇 v6 #60）：与检测器 local-adaptation-keyword（workInjury 语义查询）同源
  { id: 'work-injury-insurance', kind: 'deterministic', anchoredTo: 'local-adaptation-keyword', giveUpOnFailure: true },
  // 4.27.2 条款响应重复行去重：与检测器 duplicate-paragraph 同源（整行完全重复的重复段落族）
  { id: 'duplicate-response-line', kind: 'deterministic', anchoredTo: 'duplicate-paragraph', giveUpOnFailure: true },
  { id: 'atlas-reference', kind: 'deterministic', anchoredTo: 'drawing-reference', giveUpOnFailure: true },
  { id: 'tertiary-h4-dedupe', kind: 'deterministic', anchoredTo: 'tertiary-heading', giveUpOnFailure: true },
  { id: 'internal-term-heading', kind: 'deterministic', anchoredTo: 'internal-terminology-anchor', giveUpOnFailure: true },
  // WS4 骨架指纹确定性兜底（round-2 链末尾 / 终检前最后一道：基准字形 + 变体形态按形态池负载均衡同构改写清零）
  { id: 'skeleton-fingerprint-variants', kind: 'deterministic', anchoredTo: 'skeleton-fingerprint', giveUpOnFailure: true },
  // WS3 工序形式确定性兜底（round-2 链、终检前最后一道：相邻同形式轮换转换清零）
  { id: 'flow-form-variants', kind: 'deterministic', anchoredTo: 'flow-form-repeat', giveUpOnFailure: true },
  // WS1 残缺标题确定性补全（round-2 链、终检前最后一道：正文取证 core+工程后缀补全 <4 字残缺标题）
  { id: 'truncated-title-completion', kind: 'deterministic', anchoredTo: 'title-integrity', giveUpOnFailure: true },
  // 4.27.2 句化标题切分（标题合并治理）：与检测器 title-integrity（句化标题「含逗号」判定）同源锚定
  { id: 'sentence-like-heading-split', kind: 'deterministic', anchoredTo: 'title-integrity', giveUpOnFailure: true },
  // 4.40 d5d 同章同名 H3 小节确定性合并：与检测器 heading-duplicate（headingDuplicateIssues 二级小节同名分支）
  // 同源锚定——同名检测命中后确定性合并（高重合整块删除/否则内容并入首现块），检测定位=修复定位
  { id: 'heading-duplicate-merge', kind: 'deterministic', anchoredTo: 'heading-duplicate', giveUpOnFailure: true },
  // 4.36 A2 小节编号重放（结构事务化）：与检测器 section-numbering（编号连续性 blocker）同源锚定——
  // 删行类修复器造成编号空档时链尾原子重排，检测定位=修复定位
  { id: 'section-renumber', kind: 'deterministic', anchoredTo: 'section-numbering', giveUpOnFailure: true },
];

/**
 * 数值冲突裁决器修复器声明（4.27.0 A1/A2）：确定性裁决但不进 SURFACE_FIX_STEPS——
 * 裁决依赖全文语义聚类（bge 异步）与清单事实锁上下文，无法纳入同步章级修复链；
 * 执行点：finalize 跨章一致性阶段 global-consistency-repair LLM 定向修复轮之前
 * （runGlobalConsistencyReviewLoop 前置段）——检测端 llm-patch 不收敛的参数口径冲突必须先经确定性分流。
 * anchoredTo 与检测端同源：numeric-arbiter-concept 同步 conceptConflictGroups 扫描，
 * numeric-arbiter-spec 同步 scanSpecLocationMismatchHits 扫描（检测定位=修复定位）。
 */
export const NUMERIC_ARBITER_FIXERS: readonly FixerEntry[] = [
  { id: 'numeric-arbiter-concept', kind: 'deterministic', anchoredTo: 'parameter-concept-conflict', giveUpOnFailure: true },
  { id: 'numeric-arbiter-spec', kind: 'deterministic', anchoredTo: 'spec-location-mismatch', giveUpOnFailure: true },
];

/**
 * LLM patch 修复轮 patchGuard 预检集（P11 扩展，与 patchGuard.deterministicDefectPrecheck 十类同源）：
 * 全部为零误伤确定性检测器（deterministicSafe），词表/正则引用检测层同源常量或直接复用同源检测函数；
 * 渐进策略：先全链 observe 采集 patchGuardStats 按轮次分布，零误伤类别再切 enforce。
 */
const PATCH_GUARD_DETECTOR_IDS = [
  'source-enumeration',
  'internal-terminology-anchor',
  'fabricated-start-date',
  'repeated-word',
  'writer-missing-section',
  'meta-discourse-declaration',
  'formula-residue',
  'finish-thickness',
  'formal-placeholder',
  'truncated-sentence',
] as const;

/**
 * LLM patch 修复轮声明（repairChapterByQuality 七调用点，P11 全链接入的登记载体）：
 * - anchoredTo = 该轮触发检测器（修复定位=检测定位）；
 * - patchGuard.detectors = patch 应用前预检集（十类零误伤确定性检测器，P11 全链 observe 后
 *   按命中分布渐进扩展，见 rolePipeline.deterministicDefectPrecheck）。
 */
export const LLM_PATCH_REPAIR_ROUNDS: readonly FixerEntry[] = [
  { id: 'fact-landing', kind: 'llm-patch', anchoredTo: 'important-unplaced-facts', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  { id: 'table-repair', kind: 'llm-patch', anchoredTo: 'table-quality', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  { id: 'table-execution-repair', kind: 'llm-patch', anchoredTo: 'table-plan-execution', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  { id: 'templating-repair', kind: 'llm-patch', anchoredTo: 'templating-filler', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  { id: 'workpackage-skeleton-repair', kind: 'llm-patch', anchoredTo: 'workpackage-skeleton', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  { id: 'planned-section-repair', kind: 'llm-patch', anchoredTo: 'planned-section-completeness', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  { id: 'global-consistency-repair', kind: 'llm-patch', anchoredTo: 'global-consistency-review', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
];

/**
 * finalize 主流程修复轮顺序（P6 单源声明，与 documentPipeline.finalizeGeneration 的线性代码逐一对应；
 * 顺序变更必须同步改执行侧并附理由——顺序快照测试锁定，防无意识调整）。
 */
export const FINALIZE_REPAIR_ROUNDS = [
  'fact-landing-round',          // 重要事实落位补写轮（uncoveredImportantFacts 触发）
  'table-repair-round',          // 表格数据完整性修复轮（markdownTableQualityIssues error 触发）
  'semantic-choice-conflict',    // 决策锁语义矛盾检测（semanticChoiceConflicts，无修复）
  'deterministic-stage5',        // 交付前确定性清洗（章级数值/SURFACE_FIX_STEPS/全文数值/表承载正文）
  'formal-source-clean',         // 来源罗列话术确定性清洗兜底（cleanFormalSourcePhrases）
  'planned-section-final',       // 缺节/空小节补写终兜底（enforcePlannedSectionCompleteness）
  'commercial-strip',            // 商务条款数据交付前兜底清洗（stripCommercialDataBodyLines）
  'table-deterministic-repair',  // 表格空单元格交付前确定性修复（repairTableBlocksInMarkdownDeterministically）
  'numeric-verification',        // C2 正文数值 vs 资料原文确定性核对轮（stageNumericVerification）
  'requirement-verification',    // C3 生成后用户要求执行核验闭环（stageRequirementVerification）
  // 顺序调整理由（丰乐镇 doc-1788954795698 实测）：requirement-verification 的 LLM 补写会引入句级复读，
  // post-review-surface 若在其之前执行，补写引入的复读（17 处）无人清理 → 后置到补写轮之后兜底
  'post-review-surface',         // 评审轮后表面修复兜底（SURFACE_FIX_STEPS round-2 链，含句级复读剥离）
  'terminology-strip',           // 内部术语句子确定性删除兜底（stripInternalTerminologySentences）
  'toc-consistency',             // 目录与正文一致性兜底（fixTocFromBody）
] as const;

export type FinalizeRepairRound = (typeof FINALIZE_REPAIR_ROUNDS)[number];

// ═══════════════════════════ 执行侧登记与一致性检查 ═══════════════════════════

/** 执行侧已引用的检测器 id（det() 登记；usage 检查断言与声明表双向一致） */
const usedDetectorIds = new Set<string>();

/**
 * 检测器执行包装：登记 id 引用后执行原检测逻辑（返回类型透传，行为保持）。
 * 声明表是元数据单源——执行侧不重复携带 authorities/category 等口径信息。
 */
export function det<T>(id: string, run: () => T): T {
  usedDetectorIds.add(id);
  return run();
}

/**
 * 末期语义类检测器安全包装（生成中止韧性 P0：finalize 末期硬停治理）：
 * await 包裹 + try/catch + 引用登记（覆盖断言不因降级逃逸）；失败不穿透 finalize 主链硬停整篇任务，
 * 而是返回显性 warning 降级 issue（可观测/可复核/可重跑）——静默降级违反失败即暴露规范，
 * 炸整篇让已产出的全部进度作废且恢复必复现（死循环）。降级 issue 为基础设施异常而非内容缺陷：
 * severity=warning 不阻断导出，repairability=manual_review 不引 LLM 修复轮空转。
 * 仅用于交付前末期语义类调用点；生成链路前段保持 fail-loud（继续用 det）。
 */
export async function detSafe(id: string, run: () => ValidationIssue[] | Promise<ValidationIssue[]>): Promise<ValidationIssue[]> {
  usedDetectorIds.add(id);
  try {
    return await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[gen] detector degraded: ${id} failed, fallback to warning issue:`, error);
    return [{
      level: 'warning',
      severity: 'warning',
      category: 'format',
      owner: 'system',
      repairability: 'manual_review',
      message: `交付前检测器「${id}」执行失败，已降级为待复核：${detail}`,
      suggestion: '此为检测器基础设施异常，非正文内容缺陷；其余交付前检查已照常完成。可稍后重新生成复核，或人工复核该检测维度。',
    }];
  }
}

/** 单测专用：清空执行侧引用登记（断言前重置，避免跨用例污染） */
export function resetDetectorUsage(): void {
  usedDetectorIds.clear();
}

const ALL_DETECTORS: readonly DetectorEntry[] = [
  ...FULL_VALIDATION_DETECTORS,
  ...STANDARD_FINAL_DETECTORS,
  ...AUXILIARY_DETECTORS,
];

/** 按 id 查检测器声明（合并三组声明表，standard-final 与 full-validation 重复 id 取先声明者） */
export function detectorEntry(id: string): DetectorEntry | undefined {
  return ALL_DETECTORS.find(entry => entry.id === id);
}

function authoritySetsEqual(left?: AuthorityId[], right?: AuthorityId[]): boolean {
  const leftSet = new Set(left ?? []);
  const rightSet = new Set(right ?? []);
  if (leftSet.size !== rightSet.size) return false;
  for (const id of leftSet) if (!rightSet.has(id)) return false;
  return true;
}

/**
 * 注册表结构一致性检查（P23）：finalizeGeneration 入口与单测执行。
 * 全部通过则静默返回；任一违反抛错（修复链哑火/口径拉扯是数据一致性红线，显性暴露不静默）。
 */
export function assertRegistryConsistency(): void {
  const errors: string[] = [];
  const fixers: FixerEntry[] = [...DETERMINISTIC_FIXER_ANCHORS, ...NUMERIC_ARBITER_FIXERS, ...LLM_PATCH_REPAIR_ROUNDS];
  for (const fixer of fixers) {
    const anchored = detectorEntry(fixer.anchoredTo);
    // 1. 锚定检测器必须存在（防修复无检测哑火）
    if (!anchored) {
      errors.push(`修复器 ${fixer.id} 锚定检测器 ${fixer.anchoredTo} 未在注册表声明（检测定位=修复定位强制同源）`);
      continue;
    }
    // 2. 权威集合必须相等（防「修复用蓝图、检测用表峰值」类口径拉扯）
    if (!authoritySetsEqual(fixer.authorities, anchored.authorities)) {
      errors.push(`修复器 ${fixer.id}（authorities=${JSON.stringify(fixer.authorities ?? [])}）与锚定检测器 ${fixer.anchoredTo}（authorities=${JSON.stringify(anchored.authorities ?? [])}）权威口径不一致`);
    }
    // 3. llm-patch 必带 patchGuard
    if (fixer.kind === 'llm-patch' && !fixer.patchGuard) {
      errors.push(`LLM patch 修复器 ${fixer.id} 未声明 patchGuard（修复过程会重新引入已知坏内容，必须预检）`);
      continue;
    }
    // 4. patchGuard 引用的检测器必须全部登记且 deterministicSafe
    for (const guardDetectorId of fixer.patchGuard?.detectors ?? []) {
      const guardDetector = detectorEntry(guardDetectorId);
      if (!guardDetector) {
        errors.push(`修复器 ${fixer.id} patchGuard 引用检测器 ${guardDetectorId} 未在注册表声明`);
      } else if (!guardDetector.deterministicSafe) {
        errors.push(`修复器 ${fixer.id} patchGuard 引用检测器 ${guardDetectorId} 未标记 deterministicSafe（patchGuard 只收录零误伤确定性检测器）`);
      }
    }
  }
  // 5. 确定性修复器锚定声明必须覆盖 SURFACE_FIX_STEPS 全部键且一一对应（防修复器接入链但未声明锚定/声明多余）
  for (const [anchorIndex, anchor] of DETERMINISTIC_FIXER_ANCHORS.entries()) {
    if (DETERMINISTIC_FIXER_ANCHORS.slice(0, anchorIndex).some(entry => entry.id === anchor.id)) {
      errors.push(`确定性修复器锚定声明重复：${anchor.id}`);
    }
  }
  const surfaceStepKeys = new Set(SURFACE_FIX_STEPS.map(step => step.key));
  for (const stepKey of surfaceStepKeys) {
    if (!DETERMINISTIC_FIXER_ANCHORS.some(entry => entry.id === stepKey)) {
      errors.push(`确定性修复器 ${stepKey} 已接入 SURFACE_FIX_STEPS 但未在 DETERMINISTIC_FIXER_ANCHORS 声明锚定检测器`);
    }
  }
  for (const entry of DETERMINISTIC_FIXER_ANCHORS) {
    if (!surfaceStepKeys.has(entry.id)) {
      errors.push(`确定性修复器锚定声明 ${entry.id} 无对应 SURFACE_FIX_STEPS 键（声明多余或键已改名）`);
    }
  }
  // 6. 数值裁决器修复器声明重复检查（与 DETERMINISTIC_FIXER_ANCHORS 同口径；不进 SURFACE_FIX_STEPS 键比对）
  for (const [anchorIndex, anchor] of NUMERIC_ARBITER_FIXERS.entries()) {
    if (NUMERIC_ARBITER_FIXERS.slice(0, anchorIndex).some(entry => entry.id === anchor.id)) {
      errors.push(`数值裁决器修复器声明重复：${anchor.id}`);
    }
  }
  // 7. category 强制校验（V2 批3 门禁升级 L3）：门禁硬阻断按 category 判定，缺卡/错卡会使检测器
  //    静默逃逸硬阻断——声明必须携带 ValidationIssue.category 合法值（新检测器上线漏标即报错暴露）
  for (const detector of ALL_DETECTORS) {
    if (!detector.category || !VALID_DETECTOR_CATEGORIES.has(detector.category)) {
      errors.push(`检测器 ${detector.id} 声明了非法 category（当前=${detector.category || '缺失'}；合法值：${[...VALID_DETECTOR_CATEGORIES].join('、')}）`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`检测器/修复器注册表一致性校验失败（${errors.length} 项）：\n${errors.map(error => `- ${error}`).join('\n')}`);
  }
}

/**
 * 执行侧引用覆盖检查（单测用，须在跑完对应检测器组后调用）：
 * 1. 逃逸检查（全局）：执行侧 det() 引用的 id 必须已在声明表登记；
 * 2. 哑火检查（按组）：给定组声明的 id 必须经 det() 消费（防声明后从未接入执行侧）。
 *    两组由不同执行函数消费（buildFullValidationIssues / buildStandardFinalValidationIssues），
 *    必须成对检查：跑哪个函数就检查哪个组。
 * AUXILIARY_DETECTORS 由修复轮/门禁独立消费点调用（非 det() 数组聚合），不参与哑火检查。
 */
export function assertDetectorUsageCoverage(group: 'full-validation' | 'standard-final'): void {
  const declaredIds = new Set(ALL_DETECTORS.map(entry => entry.id));
  const unregistered = [...usedDetectorIds].filter(id => !declaredIds.has(id));
  if (unregistered.length > 0) {
    throw new Error(`执行侧引用了未登记的检测器：${unregistered.join('、')}（det() 包装必须先在声明表登记）`);
  }
  const groupDetectors = group === 'full-validation' ? FULL_VALIDATION_DETECTORS : STANDARD_FINAL_DETECTORS;
  const unused = groupDetectors.filter(entry => !usedDetectorIds.has(entry.id));
  if (unused.length > 0) {
    throw new Error(`注册表 ${group} 组存在执行侧未引用的哑火条目：${unused.map(entry => entry.id).join('、')}（声明后必须经 det() 消费或从声明表删除）`);
  }
}
