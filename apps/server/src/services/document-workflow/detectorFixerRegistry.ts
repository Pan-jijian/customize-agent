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
  /**
   * 多锚定检测器集合（可选，r8 修复）：单轮统一消费多类检测器 blocker 时登记其余锚定目标。
   * 每一扩展锚定与 anchoredTo 同口径校验（存在性 + 权威集合一致），防「多消费轮只登记一个
   * 锚定、其余检测器锚定缺失无人校验」的哑火逃逸（content-depth-repair 六检测器统一收口场景）。
   */
  alsoAnchoredTo?: string[];
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
  // C4 句模聚类复读（sentencePatternRepeatIssues）：多段顺序词链/完成即转入/验收衔接/资料闭环式/形式宣告式
  // 同模式句全篇 ≥6 即命中（语义套话原型不覆盖的结构句式复读；修复轮 templating-repair 同源消费）
  { id: 'sentence-pattern-repeat', scope: 'full-document', category: 'style' },
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
  // C5 一致性类（P6）：编制依据↔正文双向对账（basisRegulationsCrossIssues）——声明未用/用了未声明
  // 逐条带证据；编号同族匹配年号缺省容忍（GB 55037 ↔ GB 55037-2021）、书名空白归一包含匹配；
  // 区段扫描单源（basisRegulationSectionRanges，声明侧/引用侧同范围判定）；修复轮
  // basis-regulations-cross-repair 同源消费（检测定位=修复定位）
  { id: 'basis-regulations-cross', scope: 'full-document', category: 'fact_consistency' },
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
  // C-T2 未溯源数值验收（documentFactTrace.numericTraceabilityIssues）：三分类豁免后的真未溯源
  // 数字聚合 error，扫描口径与修复器（demoteUnsourcedNumericTokens）同源单源
  { id: 'numeric-traceability', scope: 'full-document', category: 'evidence_coverage' },
  // C-T3 表内算术自洽（detectors.tableArithmeticInconsistencyIssues）：含显性合计标记（合计行/合计列）
  // 的表格「分项和=合计」确定性核对，不自洽进修复链（stageTableArithmeticRepair 同源重扫）
  { id: 'table-arithmetic-consistency', scope: 'full-document', category: 'evidence_coverage' },
  { id: 'duplicate-basic-info', scope: 'full-document', category: 'structure' },
  { id: 'formal-style', scope: 'full-document', category: 'style' },
  { id: 'tertiary-heading', scope: 'full-document', category: 'structure', deterministicSafe: true },
  { id: 'min-chapter-section', scope: 'chapter', category: 'structure' },
  { id: 'precise-fact-usage', scope: 'full-document', category: 'fact_consistency' },
  // C3-4 可靠参数义务落位验收（chapterParameterFacts.parameterObligationUsageIssues）：参数池净化后
  // 义务满足率 <90% 即 error（兑现报告出口 parameterUsageAudit / 修复出口 assignMissingParameterChapters
  // 同源单语），使参数义务缺口独立成 blocker 由 content-depth-repair 消费（挂靠缺口根治）
  { id: 'parameter-obligation-usage', scope: 'full-document', category: 'fact_consistency' },
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
  // 正文表格授权门禁（markdownComposer.bodyCompositionTableIssues，C1 章级授权口径）：
  // ① 显式禁表句（bodyTablePolicy=forbidden）：正文残留任何表格即 blocker；
  // ② 允许口径：未列入表格授权计划的章出现表格即 blocker（表格须来自系统计划，不得自设；
  //    授权章 = 有表格计划/静态表格声明/图类承载指令，提示词必需表格按表名豁免）
  { id: 'bid-composition-body-table', scope: 'full-document', category: 'structure' },
  // 正文禁图反向门禁（markdownComposer.bodyCompositionFigureIssues，bodyFigurePolicy=forbidden：
  // 暗标或招标「不得有图片」证据）：正文残留图片/图件占位即 blocker（图类内容数据化输出；确定性剥离链的终检兜底）
  { id: 'bid-composition-body-figure', scope: 'full-document', category: 'structure' },
  // F-T3 暗标身份禁语零容忍终检（detectors.identityLeakageIssues，identityMarksForbidden）：
  // 正文出现以往业绩/获奖表述或证书资质编号类自我标识即 blocker
  { id: 'identity-marks-forbidden', scope: 'full-document', category: 'format' },
  { id: 'planned-structure', scope: 'full-document', category: 'structure' },
  // R20 C3 表题注终检（markdownComposer.tableCaptionIssues）：正文区表格逐张核验「表X-Y」题注
  //（题注由成稿归一阶段确定性注入器写入，本检测为安全网；正文禁表模式豁免）
  { id: 'table-caption', scope: 'full-document', category: 'format' },
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
  // F-T4 无主数值审计失败硬门禁（authorityAudit.authorityAuditIssues）：三桶（未登记·推导/投影缺口·
  // 工艺库缺口）任一非零即 blocker——由 recordAuthorityAudit（rebuildAndRecompute）独立消费，
  // 不参与两组哑火检查；审计失败不可进交付（fact_consistency + llm_repairable 直通硬阻断）
  { id: 'authority-audit-gap', scope: 'full-document', category: 'fact_consistency' },
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
  // C3-6-4 图集引用短语检测（markdownCleanup.atlasReferencePhraseHits，与确定性删除链
  // stripAtlasReferencePhrases 同源词面 + 同行豁免）：修复器 atlas-reference 的锚定目标——
  // 历史错配：atlas-reference（删「做法执行XX图集」话术）曾锚定 drawing-reference（图纸引用率），
  // 检测定位=修复定位名不符实，补救链锚定校验形同虚设
  { id: 'atlas-reference-phrase', scope: 'full-document', category: 'format', deterministicSafe: true },
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
    // r28h 行内嵌标题拆行（s28h2 实测）：「……有缺损。## 第九章 确保文明施工的技术组织措施」章标题并进正文行致「正文缺少章节标题」（planned-structure）——拆行恢复行首标题结构
    { id: 'embedded-heading-split', kind: 'deterministic', anchoredTo: 'planned-structure', giveUpOnFailure: true },
  { id: 'repeated-words', kind: 'deterministic', anchoredTo: 'repeated-word', giveUpOnFailure: true },
  { id: 'duplicate-tables', kind: 'deterministic', anchoredTo: 'duplicate-table', giveUpOnFailure: true },
  { id: 'finish-thickness', kind: 'deterministic', anchoredTo: 'finish-thickness', giveUpOnFailure: true },
  // 4.31 埋深/覆土槽位数值错位删除（丰乐镇 v6 #3）：与检测器 fact-reconciliation D4.3 同源（blueprint 权威）
  { id: 'slot-depth-value', kind: 'deterministic', anchoredTo: 'fact-reconciliation', authorities: ['blueprint'], giveUpOnFailure: true },
  // r17 丰乐镇归因 #B1：规格-数值绑定错位（「DN110 UPVC排水管15m」无源值撞无关条目）——与检测器
  // fact-reconciliation D4.2 同源单扫描（scanSpecBindingHits），原位替换为规格组和值（组和豁免口径）
  { id: 'spec-quantity-binding', kind: 'deterministic', anchoredTo: 'fact-reconciliation', authorities: ['blueprint'], giveUpOnFailure: true },
  { id: 'labor-peak', kind: 'deterministic', anchoredTo: 'resource-consistency', authorities: ['laborPeak'], giveUpOnFailure: true },
  // V5 P4b-2 阶段劳动力确定性回写（与检测器 phase-labor-mixing 同源双通道扫描；蓝图权威）
  { id: 'phase-labor-values', kind: 'deterministic', anchoredTo: 'phase-labor-mixing', authorities: ['blueprint'], giveUpOnFailure: true },
  // A3 资源章数值拆分确定性统一（4.27.0）：与检测器 resource-breakdown-consistency 同源（blueprint 权威）
  { id: 'resource-breakdown', kind: 'deterministic', anchoredTo: 'resource-breakdown-consistency', authorities: ['blueprint'], giveUpOnFailure: true },
  // r17 丰乐镇归因 #B2/B3：机械设备分批台数矛盾（首批＋剩余之和不等于蓝图汇总）——与检测器
  // equipment-batch-conflict 同源单扫描（scanEquipmentBatchConflicts），删除 later 批「N 台」数字
  { id: 'equipment-batch-values', kind: 'deterministic', anchoredTo: 'equipment-batch-conflict', authorities: ['blueprint'], giveUpOnFailure: true },
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
  // r28j 同日零长区间修复（M15）：锚定检测器 cross-chapter-consistency 的「同日起止区间校验」（只报不修、owner=llm 交修复轮未清）
  { id: 'zero-length-date-range', kind: 'deterministic', anchoredTo: 'cross-chapter-consistency', giveUpOnFailure: true },
  { id: 'truncated-sentence', kind: 'deterministic', anchoredTo: 'truncated-sentence', giveUpOnFailure: true },
  { id: 'meta-discourse', kind: 'deterministic', anchoredTo: 'meta-discourse-declaration', giveUpOnFailure: true },
  { id: 'formula-residue', kind: 'deterministic', anchoredTo: 'formula-residue', giveUpOnFailure: true },
  { id: 'self-undermining', kind: 'deterministic', anchoredTo: 'self-undermining-candidate', giveUpOnFailure: true },
  // A4 关键设计决策两可表述唯一化（4.27.0）：与检测器 ambiguous-either-or 同源（supportSystem 权威）
  { id: 'ambiguous-either-or', kind: 'deterministic', anchoredTo: 'ambiguous-either-or', authorities: ['supportSystem'], giveUpOnFailure: true },
  // 4.27.2 招标元语言确定性清理（语气泄漏治理）：与检测器 formal-style（文风泄漏/后台话术）同源锚定——
  // 「按招标文件要求/约定」条幅与调用式元语言属正式文风失分面，检测定位=修复定位
  { id: 'tender-meta-language', kind: 'deterministic', anchoredTo: 'formal-style', giveUpOnFailure: true },
  // 4.32 配置禁用词确定性清洗（丰乐镇 v6 #59）：与门禁检测器 formal-text-gate（forbiddenTexts 阻断词）同源
  { id: 'forbidden-configuration', kind: 'deterministic', anchoredTo: 'formal-text-gate', giveUpOnFailure: true },
  // 4.27.2 条款响应重复行去重：与检测器 duplicate-paragraph 同源（整行完全重复的重复段落族）
  { id: 'duplicate-response-line', kind: 'deterministic', anchoredTo: 'duplicate-paragraph', giveUpOnFailure: true },
  // C3-6-4 锚定修正：图集话术删除链锚定 atlas-reference-phrase（同源词面检测），
  // 历史错锚 drawing-reference（图纸引用率）致锚定校验名不符实
  { id: 'atlas-reference', kind: 'deterministic', anchoredTo: 'atlas-reference-phrase', giveUpOnFailure: true },
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
 * 章草稿级独立确定性修复器声明（r11 丰乐镇门禁 #1 兜底）：不进 SURFACE_FIX_STEPS——
 * 修复对象是 finalChapterDrafts（章草稿结构与规划小节守恒），非 markdown 字符串，
 * 无法纳入同步 markdown 修复链；执行点：postReviewSurface 缺节补写之前（与 planned-section-repair 同域）。
 * anchoredTo 与检测端同源：section-count-overflow（成稿 H3 超规划小节数，同步读 drafts）。
 */
export const CHAPTER_DETERMINISTIC_FIXERS: readonly FixerEntry[] = [
  { id: 'near-duplicate-section-merge', kind: 'deterministic', anchoredTo: 'section-count-overflow', giveUpOnFailure: true },
  // D-T3 无依据空壳小节链尾清扫（补写轮搬走 H4 正文后空壳标题行残留直坠终检「空小节」）：
  // 与检测端同源（emptyUnplannedSectionSpans 与 collectSectionContentGaps 同判定链）——
  // 整行移除无规划归属严格空壳 + 章内编号原子重放；执行点：table-arithmetic-repair 之后链尾最后 draft-mutating
  { id: 'empty-section-strip', kind: 'deterministic', anchoredTo: 'section-content-integrity', giveUpOnFailure: true },
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
  // C4 扩展锚定：sentence-pattern-repeat（句模聚类复读修复目标与套话句同轮承载——检测定位=修复定位）
  { id: 'templating-repair', kind: 'llm-patch', anchoredTo: 'templating-filler', alsoAnchoredTo: ['sentence-pattern-repeat'], patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  { id: 'workpackage-skeleton-repair', kind: 'llm-patch', anchoredTo: 'workpackage-skeleton', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  { id: 'planned-section-repair', kind: 'llm-patch', anchoredTo: 'planned-section-completeness', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  { id: 'global-consistency-repair', kind: 'llm-patch', anchoredTo: 'global-consistency-review', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  // r4 实机归因：引文成对性残缺（编制依据段法规列举句自吞噬拼接丢失）此前只有终检 punctuation-artifact
  // 报出、无修复轮消费——链尾 LLM 定向补全残缺拼接句（章级定位 + 成对性复检 + 变差回滚）
  { id: 'quotation-balance-repair', kind: 'llm-patch', anchoredTo: 'punctuation-artifact', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  // r8 实机终门禁 18 项阻断归因（第二类系统性缺陷：修复链覆盖检测器集合 < 终检检测器集合）：
  // critical/emergency-section-depth、construction-org-major-content/division-section、precise-fact-usage、
  // overview-recap 六类「内容欠产」blocker 此前无任何修复轮消费，裸奔直坠终门禁——本轮统一收口：
  // 按 provenance + chapterId 章级分组，定向补写（每章 2 轮 + 外层 2 周期收敛 + 变差回滚）。
  // D-T1 扩展锚定：professional-score（报出线统一 8/12 后，<8/12 的章为 warning 级缺口，同轮消费
  // 定向补写，预算单列：每章 1 轮/单周期最多 4 章）。
  // C3-5 扩展锚定：boq-placement（清单落位不足，severity blocker，C3-5-2 已打 provenance；未落位项
  // 重算 → 责任章映射 → 逐章载荷定向补写）。历史挂靠缺口：17 轮修复无一消费直坠终门禁。
  // C3-6-4 扩展锚定：drawing-reference（图纸事实引用率 <90%，warning 级独立通道；未引用份按事实行
  // 相关性分章 → 逐章载荷定向补写图纸名与规格/做法事实）。历史缺口：96/118 份从未获注入（s28l 实测）。
  { id: 'content-depth-repair', kind: 'llm-patch', anchoredTo: 'critical-section-depth', alsoAnchoredTo: ['emergency-section-depth', 'construction-org-major-content', 'construction-org-division-section', 'precise-fact-usage', 'parameter-obligation-usage', 'overview-recap', 'professional-score', 'boq-placement', 'drawing-reference'], patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  // D-T2 评审关注闭环链补写轮（r28f B8 前半归因）：质量三检/进度纠偏/工资代发链「主责章全要素」
  // 判定（construction-org-control-loop warning）此前无修复轮消费——本轮章级实时重算定位 +
  // LLM 定向补写缺失环节（标准词面落位）+ 复检缺失数（变差回滚），与 content-depth-repair 同族链尾补写轮
  { id: 'control-loop-repair', kind: 'llm-patch', anchoredTo: 'construction-org-control-loop', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  // D-T9 工序链与项目属性适配修复轮（r28f #30/#31 归因）：construction-org-professional-chain warning
  //（检测端已升级节级 mixed + 文档级 insufficient 判定，词表簇化）此前无修复轮消费——本轮章级
  // 实时重算定位 + LLM 定向改写错位工序/补写缺失链环节（标准工序名落位）+ 复检缺陷数（变差回滚）
  { id: 'professional-chain-repair', kind: 'llm-patch', anchoredTo: 'construction-org-professional-chain', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  // 丰乐镇实机终门禁归因 #8（编制依据法规漏列）：编制依据小节此前漏写具体法规/规范条目（法律法规/
  // 地方性法规齐全但零施工验收规范编号）只有终检 basis-regulations-coverage 报出、无修复轮消费——
  // 链尾 LLM 定向补列缺失类目（照抄招标文件引用法规 + 按本工程分部分项选列现行施工验收规范名称
  // 及编号），复检缺失类目数 + 变差回滚。authorities 与锚定检测器同声明（消费蓝图法规清单权威）
  { id: 'basis-regulations-repair', kind: 'llm-patch', anchoredTo: 'basis-regulations-coverage', authorities: ['blueprint'], patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  // C5 一致性类 P6（编制依据↔正文双向对账链尾收口，r28l/s28l 实测双向缺口 8/7、4/15）：used_not_declared
  // 确定性补入编制依据同类目（零 LLM）+ declared_not_used 区分性 token 定位应用章 LLM 补引用（复检
  // 引用数 + 防删除式汉字数）/ 不适用确定性移除；链尾整体复检（双向缺口净减少且均不上升，违反即回滚）
  { id: 'basis-regulations-cross-repair', kind: 'llm-patch', anchoredTo: 'basis-regulations-cross', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  // r28j 实机归因（s28i 连续两轮）：危大工程辨识清单适用项漏列（正文拆改清运「拆除工程」适用前提
  // 真实存在而辨识叙述区缺别名精确词）此前只有终检 dangerous-applicability 报出、修复链无轮消费
  //（4.41 删除确定性补写器后裸奔）——链尾定位含危大辨识区的章 + LLM 定向补列遗漏适用项（补列
  // 紧邻既有辨识叙述、落回辨识区覆盖范围），复检遗漏项覆盖数 + 变差回滚
  { id: 'dangerous-applicability-repair', kind: 'llm-patch', anchoredTo: 'dangerous-applicability', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  // D-T8 配置必要内容缺失链尾收口（r28f 实测 7 项术语缺失）：模板命中的 autoSpecGates 配置术语清单
  //（国家法律法规/地方法规/项目特征/图纸设计说明/劳动力计划/主要施工材料/安全文明等）此前只有终检
  // planned-auto-spec-gate 报出、无修复轮消费——缺失术语 bigram 归属到章 + LLM 定向补写（自然融入），
  // 复检归属术语缺失数 + 变差回滚
  { id: 'auto-spec-gate-repair', kind: 'llm-patch', anchoredTo: 'planned-auto-spec-gate', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  // D-T3 成稿篇幅压缩轮（B8 后半归因）：成稿字数超出目标 20%（document-budget「明显超出」warning）
  // 此前无修复轮消费，超产直坠交付（验收线「目标 ±20% 内」）——章级超额定位 + LLM 合并重复段落，
  // 信息守恒守卫（字数须降，且标题/数值不得缺失、表格行数不得减少，任一违反即回滚）
  { id: 'length-compression-repair', kind: 'llm-patch', anchoredTo: 'document-budget', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  // r24 B8 实机归因：正文无题名形态表格（表上方 8 行内无可提取表名）在题注注入器/逐表对账双盲区，
  // 终检 table-caption 报出后无修复轮消费直坠终门禁——本轮消费该 blocker 章级定向补名（补写独立
  // 表题行纯增量；确定性补名先行，无计划表匹配的残留表走本 LLM 轮；回滚保护：无题表数须严格下降）
  { id: 'table-caption-repair', kind: 'llm-patch', anchoredTo: 'table-caption', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
  // C-T3 表内算术自洽修复轮（C4 归因）：含显性合计标记（合计行/合计列）的表格「分项和=合计」
  // 不自洽此前只有终检 table-arithmetic-consistency 报出、无修复轮消费——本轮消费该 blocker 章级
  // 定向重算表内数值（回滚保护：不自洽处数须严格下降；与 table-caption-repair 同族链尾 draft-mutating 轮）
  { id: 'table-arithmetic-repair', kind: 'llm-patch', anchoredTo: 'table-arithmetic-consistency', patchGuard: { detectors: [...PATCH_GUARD_DETECTOR_IDS] }, giveUpOnFailure: true },
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
  // r3 实机门禁归因：章级验收 requirements-coverage blocker 此前无任何修复轮消费（40+ 项要求未响应直坠门禁）——
  // 本轮消费该 blocker 按主责章定向补写；位置早于 post-review-surface（复读剥离覆盖本轮补写引入的重复句）
  'requirement-response-repair', // 招标要求响应定向补写轮（stageRequirementResponseRepair）
  'requirement-verification',    // C3 生成后用户要求执行核验闭环（stageRequirementVerification）
  // r8 实机终门禁归因（第二类系统性缺陷：修复链覆盖检测器集合 < 终检检测器集合）：内容深度类
  // blocker（critical/emergency-section-depth、construction-org-major-content/division-section、
  // precise-fact-usage、overview-recap）此前无修复轮消费裸奔到终门禁——本轮统一消费定向补写；
  // D-T1 扩展：专业评分不足（professional-score <8/12）同轮消费（预算单列）；
  // 位置必须早于 post-review-surface（其复读剥离/格式清洗覆盖本轮补写引入的残留）
  'content-depth-repair',        // 内容深度补写轮（stageContentDepthRepair）
  // D-T2 评审关注闭环链补写轮（B8 前半根治）：construction-org-control-loop warning 消费定向补写；
  // 同族补写轮，位置与 content-depth-repair 相同约束：早于 post-review-surface（其复读剥离
  // /格式清洗覆盖本轮补写引入的残留）
  'control-loop-repair',         // 评审关注闭环链补写轮（stageControlLoopRepair）
  // D-T9 工序链与项目属性适配修复轮（r28f #30/#31 归因）：construction-org-professional-chain warning
  // 消费定向修复（错位节改写/缺失链补写）；同族补写轮，位置与 content-depth-repair 相同约束：
  // 早于 post-review-surface（其复读剥离/格式清洗覆盖本轮补写引入的残留）
  'professional-chain-repair',   // 工序链与项目属性适配修复轮（stageProfessionalChainRepair）
  // 顺序调整理由（丰乐镇 doc-1788954795698 实测）：requirement-verification 的 LLM 补写会引入句级复读，
  // post-review-surface 若在其之前执行，补写引入的复读（17 处）无人清理 → 后置到补写轮之后兜底
  'post-review-surface',         // 评审轮后表面修复兜底（SURFACE_FIX_STEPS round-2 链，含句级复读剥离）
  'terminology-strip',           // 内部术语句子确定性删除兜底（stripInternalTerminologySentences）
  // 4.44 法规文号残缺链尾收口：stage5 全文数值链之后的 LLM patch 轮（数值/要求定向修复、缺节补写）
  // 重写可再引入「（国务院令第279订）」类自吞噬残缺，链尾此前无确定性收口点，两轮实机成稿同形态残留
  'regulation-number-typo',      // 法规文号残缺确定性收口（fixRegulationNumberTypos，仅「第N订」紧邻右括号形态）
  // r4 实机归因：同一自吞噬族系的引文成对性残缺（「2017实施条例》」「第279安全生产管理条例》」拼接
  // 丢失）此前只有终检报出、无修复轮消费——链尾 LLM 定向补全残缺拼接句（章级定位 + 成对性复检），
  // 与 regulation-number-typo 并列链尾收口点（确定性可覆盖的形态在前，需语义补全的形态在后）
  'quotation-balance-repair',    // 引文成对性残缺链尾修复（stageQuotationBalanceRepair）
  // 丰乐镇实机终门禁归因 #8（编制依据法规漏列）：编制依据小节漏写具体法规/规范条目此前无修复轮消费
  //（法律法规/地方性法规齐全但零施工验收规范编号直坠终门禁）——链尾 LLM 定向补列缺失类目（照抄
  // 招标文件引用法规 + 按本工程分部分项选列现行规范名称及编号），复检缺失类目数 + 变差回滚
  'basis-regulations-repair',    // 编制依据法规漏列链尾修复（stageBasisRegulationsRepair）
  // C5 一致性类 P6：编制依据↔正文双向对账链尾收口（used 确定性补入 + declared 应用/移除 + 全局复检）；
  // postReviewSurface 链尾调用位置：basis-regulations-repair 之后、dangerous-applicability-repair 之前
  'basis-regulations-cross-repair', // 编制依据双向对账链尾收口（stageBasisRegulationsCrossRepair）
  // r28j 危大辨识清单漏项链尾收口（s28i 连续两轮实测）：正文拆改清运「拆除工程」适用前提真实存在
  // 而辨识叙述区缺别名精确词，终检 dangerous-applicability 报出后无修复轮消费——链尾定位含危大
  // 辨识区的章 + LLM 定向补列遗漏适用项（补列紧邻既有辨识叙述），复检遗漏项覆盖数 + 变差回滚
  'dangerous-applicability-repair', // 危大辨识清单漏项链尾修复（stageDangerousApplicabilityRepair）
  // D-T8 配置必要内容缺失链尾收口（r28f 实测 7 项术语缺失）：模板命中的 autoSpecGates 配置术语清单
  //（国家法律法规/地方法规/项目特征/图纸设计说明/劳动力计划/主要施工材料/安全文明等）此前只有终检
  // planned-auto-spec-gate 报出、无修复轮消费——缺失术语 bigram 归属到章 + LLM 定向补写（自然融入），
  // 复检归属术语缺失数 + 变差回滚
  'auto-spec-gate-repair',       // 配置必要内容缺失链尾修复（stageAutoSpecGateRepair）
  'toc-consistency',             // 目录与正文一致性兜底（fixTocFromBody）
  // D-T3 成稿篇幅压缩轮（B8 后半归因）：成稿字数超出目标 20% 时章级超额定位 + LLM 合并重复段落
  //（信息守恒守卫：字数须降，且标题/数值不得缺失、表格行数不得减少）；draft-mutating + rebuild，
  // 位于全部 LLM 补写轮之后（post-review-surface 尾部 toc-consistency 之后）、扩散轮之前
  'length-compression-repair',   // 成稿篇幅压缩轮（stageLengthCompressionRepair）
  // R12 方案针对性分布归因（丰乐镇实测 distribution≈0.09）：高价值事实值仅在单一章节落位——链尾确定性
  // 扩散轮（stageFactDistribution），在语义相关章正文块尾追加自然引用句；必须在全部 LLM 补写轮之后
  // （前置轮改写正文会稀释/回退已生效的分布），stageFinalGate 之前收口（评分与门禁按扩散后正文判定）
  'fact-distribution-round',     // 关键事实跨章扩散轮（stageFactDistribution）
  // r24 B8 实机归因：正文无题名表格（探测 kind='none'）无可注入对象直坠终门禁——确定性补名（章内
  // 无题表 × 本章计划表表头字段对账）+ LLM 补名（残留表章级定向）写回章 drafts；draft-mutating +
  // rebuild，必须位于 stageFactDistribution 之后（其 rebuild 回退此前 markdown-only 修改）、链尾
  // markdown-only 重放（runSurfaceDeterministicCleans 等）之前
  'table-caption-repair',        // 正文表格题名补全轮（stageTableCaptionRepair）
  // C-T3 表内算术自洽修复轮（C4 归因：含显性合计标记的表格分项和≠合计直坠评审数据可信度判定）：
  // 章级同源重扫（tableArithmeticInconsistencyIssues）+ LLM 定向重算表内数值；draft-mutating +
  // rebuild，必须位于 table-caption-repair 之后、链尾 markdown-only 重放之前（本轮 rebuild 不得
  // 回退链尾重放成果）
  'table-arithmetic-repair',     // 表内算术自洽修复轮（stageTableArithmeticRepair）
  // D-T3 无依据空壳小节链尾清扫（r28f 终检「空小节」blocker 归因）：补写轮搬走 H4 正文后无规划
  // 归属的空壳标题行残留——确定性整行移除 + 章内编号原子重放；链尾最后 draft-mutating 位置
  //（table-arithmetic-repair 之后、链尾 markdown-only 重放之前）
  'empty-section-sweep',         // 无依据空壳小节链尾清扫（stageEmptySectionSweep）
  // D-T6 ② 小节结构对齐链尾重放（r28f 门禁 #2 归因：第 7 章成稿 5 节 vs 规划 4 节）：近名合并/漂移
  // 改名位于缺节补写之前，补写后「漂移+补写并存」历史形态与落单漂移行到链尾再无收口点——链尾重放
  // mergeNearDuplicateSectionHeadings（近名成对合并 + 单行漂移改名）+ reconcileUnplannedSectionHeadings
  //（非近名规划外 H3 降 H4，与 sectionCountOverflowIssues 同源判定）；链尾最后 draft-mutating 位置
  'section-alignment-sweep',     // 小节结构对齐链尾重放（stageSectionAlignmentSweep）
  // D-T7 ① 模板化清理链尾重放（r28f #35 归因：终检 formalStyleIssues 与修复链口径分叉，修复轮后各
  // draft-mutating 轮 rebuild 可再引入前缀导语句）：零信息前缀句确定性删除（templatePrefixTargets +
  // stripZeroInfoSloganSentences）+ 逐章段落完全重复去重（stripDuplicateParagraphs 重放）；
  // 链尾 draft-mutating，位于 section-alignment-sweep 之后
  'templating-sweep',            // 模板化清理链尾重放（stageTemplatingSweep）
  // D-T7 ② 重复主题小节合并（r28f #36/#37 归因：minChapterSectionIssues 检测恒报、修复链零消费）：
  // 同桶规划小节 ≥2（classifyThematicSectionKey 单源）且正文均有 H3 落位时确定性合并——保留首现、
  // 后续标题行摘除正文并入、规划数组同步、章内编号原子重放；位于 templating-sweep 之后、
  // delivery-structure-closure（链尾 markdown-only 收口）之前
  'duplicate-theme-merge',       // 重复主题小节链尾合并（stageDuplicateThemeMerge）
  // D-T6 ①③ 交付结构收口（r28f 门禁 #1 目录 29 vs 28 + 终检长段归因）：长段切分（>380 行切句重组，
  // 与写作期 splitLongParagraphs 同阈值）+ 目录重建（fixTocFromBody 按正文实际结构重建）——
  // 链尾 markdown-only 收口，位于全部 draft-mutating 轮之后、stageFinalGate 之前
  'delivery-structure-closure',  // 交付结构收口轮（stageDeliveryStructureClosure）
  // C8 S3 句模复读链尾收口（F 通道归因：句模修复仅写作期、finalize 链无重放 + tail closure
  // markdown-only 插入物对 drafts 消费者不可见 → 写作期残留至终稿反增）：宣告引导句确定性剥离
  //（stripSentencePatternAnnouncements，与检测端 form-announcement 族单源判定，列表自承载
  // 信息删除无损）+ 密度命中线（sentencePatternThreshold 四端单源）；链尾 markdown-only，
  // 位于 delivery-structure-closure 之后、replaySurfacePunctuationClosure（链尾标点兜底）之前
  'sentence-pattern-sweep',      // 句模复读链尾收口轮（stageSentencePatternSweep）
  // C8 S5 U 通道句级复读坍塌（uniqueness 0.59 第一约束归因：重复句 excess 主体为泛化归口句复读
  // 「上述/相关/有关＋泛对象词…纳入/编入…每日/每周」20 种 37 处 + 同章完全复读 17 处；全篇复读
  // 39 种仅 1 种命中句模族表 → 修复死角）：完全重复句保首次删后续（同章复读一律坍塌、跨章复读
  // 仅首现句命中泛化归口帧者坍塌，跨章业务句保留），出现枚举与 uniqueness 评分单源消费
  // duplicateSentenceOccurrences；链尾 markdown-only，位于 sentence-pattern-sweep 之后、
  // replaySurfacePunctuationClosure（链尾标点兜底）之前
  'duplicate-sentence-collapse', // 句级复读坍塌链尾收口轮（stageDuplicateSentenceCollapse）
  // C8 S6 A' 对象错位通道（templating-sweep 扫 drafts 而 markdown-only 插入物只写 finalMarkdown：
  // s28m' 实测插入物 6 探针 drafts 全 false / markdown 全 true，stage「无重复段落残留」为 drafts
  // 视角假通过；链尾各 markdown-only 轮删句/断句后亦可能新生重复段）：链尾 markdown 版 templating
  // 重放——finalMarkdown 按 `## ` 行级切章构造伪 chapters（头区不参与），复用与 templating-sweep
  // 完全相同的三函数（templatePrefixTargets → stripZeroInfoSloganSentences + 逐章 stripDuplicateParagraphs）；
  // 链尾 markdown-only，位于 duplicate-sentence-collapse 之后、replaySurfacePunctuationClosure（链尾标点兜底）之前
  'templating-tail-replay',      // 模板化清理链尾重放轮（markdown 版，stageTemplatingTailReplay）
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
  const fixers: FixerEntry[] = [...DETERMINISTIC_FIXER_ANCHORS, ...NUMERIC_ARBITER_FIXERS, ...CHAPTER_DETERMINISTIC_FIXERS, ...LLM_PATCH_REPAIR_ROUNDS];
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
    // 2b. 扩展锚定（alsoAnchoredTo）同口径校验：存在性 + 权威一致（多消费轮每一锚定目标均须可判定）
    for (const extraAnchorId of fixer.alsoAnchoredTo ?? []) {
      const extraAnchor = detectorEntry(extraAnchorId);
      if (!extraAnchor) {
        errors.push(`修复器 ${fixer.id} 扩展锚定检测器 ${extraAnchorId} 未在注册表声明（检测定位=修复定位强制同源）`);
      } else if (!authoritySetsEqual(fixer.authorities, extraAnchor.authorities)) {
        errors.push(`修复器 ${fixer.id}（authorities=${JSON.stringify(fixer.authorities ?? [])}）与扩展锚定检测器 ${extraAnchorId}（authorities=${JSON.stringify(extraAnchor.authorities ?? [])}）权威口径不一致`);
      }
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
  // 6b. 章草稿级独立修复器声明重复检查（同口径；与 numeric-arbiter 同模式不进 SURFACE_FIX_STEPS 键比对）
  for (const [anchorIndex, anchor] of CHAPTER_DETERMINISTIC_FIXERS.entries()) {
    if (CHAPTER_DETERMINISTIC_FIXERS.slice(0, anchorIndex).some(entry => entry.id === anchor.id)) {
      errors.push(`章草稿级修复器声明重复：${anchor.id}`);
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
