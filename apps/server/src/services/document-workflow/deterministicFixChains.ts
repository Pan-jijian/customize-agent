/**
 * 交付前确定性修复链单源（治理收敛 · 第 1 期 P10）：
 * stage5 逐章链与 round-2 全文链此前各自硬编码一份修复器清单，两处清单的成员与顺序
 * 独立演化已出现漂移（round-2 曾缺图集引用清洗等），
 * 现将两份清单收敛为一份注册表 SURFACE_FIX_STEPS：顺序即执行顺序，两条链按
 * stage5/round2 启用标志过滤消费，新修复器接入两条链只需登记一次。
 * 权威口径（劳动力峰值/绿化养护期）由调用点注入 SurfaceFixerContext，与检测器同源。
 */
import {
  collapseRepeatedWords,
  fixAmbiguousEitherOrCandidates,
  fixCollisionNumberedHeadings,
  fixFinishThickness,
  fixFormulaResidues,
  fixGreeningMaintenanceMismatch,
  fixInvertedDateRanges,
  fixLaborPeakConflict,
  fixMetaDiscourseDeclarations,
  fixParagraphOpeningRepeats,
  fixParagraphTailRepeats,
  fixPhaseLaborValues,
  fixSelfUnderminingCandidates,
  fixTruncatedSentenceArtifacts,
  mergeTableLineResidues,
  stripDuplicateTables,
  stripInternalDuplicateTableRows,
} from './documentIntegrityChecks';
import type { DeterministicFixOutcome } from './documentIntegrityChecks';
import { fixResourceBreakdownNumbers, type ResourceBreakdownAuthority } from './resourceBreakdownNumbers';
import { cleanStructureDefects } from './structureIntegrityRules';
import { dedupeTertiaryH4Titles } from './markdownComposer';
import { fixInternalTermHeadingPhrases } from './internalTerminologyAnchors';
import { stripAtlasReferencePhrases } from './documentGeneratorHelpers';
import { fixEmptyScoringResponses, fixTenderMetaLanguage, stripDuplicateResponseLines } from './tenderRequirements';
import { fixFlowFormRepetition, fixSentenceLikeHeadingSplit, fixSkeletonFingerprintRepetition, fixTemplatedLabels, fixTruncatedTitleCompletion } from './templatingGovernance';

/** 修复器权威口径上下文（与检测器同源：laborPeakAuthority 由蓝图决策锁定，greeningMaintenanceAuthority 由清单事实抽取，
 * resourceBreakdownAuthority 由蓝图资源清单推导，supportFormAuthority 由支护体系权威映射（放坡/钢板桩）） */
export interface SurfaceFixerContext {
  laborPeakAuthority?: number;
  greeningMaintenanceAuthority: number | undefined;
  /** A3 资源拆分权威（缺失时不执行资源数值修复，与检测器同口径静默） */
  resourceBreakdownAuthority?: ResourceBreakdownAuthority;
  /** A4 支护形式选定值（'放坡'/'钢板桩'；缺失时两可表述按正文主流侧默认归一） */
  supportFormAuthority?: string;
  /** 规划小节标题全集（句化标题切分 sentence-like-heading-split 消费：标题前缀匹配还原规划标题；
   * 缺失时该步静默跳过——零配置零误伤） */
  plannedSectionTitles?: readonly string[];
  /** V5 P4b-2 阶段劳动力权威（phase-labor-values 消费：蓝图 byPhase 推导投影；缺失时该步静默） */
  phaseLaborAuthorities?: Array<{ phase: string; value: number; trace?: string }>;
}

export interface SurfaceFixStep {
  /** 注册键（计数统计与审计用，唯一） */
  key: string;
  /** 进入 stage5 逐章链（交付前确定性清洗） */
  stage5: boolean;
  /** 进入 round-2 全文链（评审轮后表面修复兜底） */
  round2: boolean;
  fix: (markdown: string, ctx: SurfaceFixerContext) => DeterministicFixOutcome;
}

/**
 * 交付前确定性修复链注册表：顺序即执行顺序。
 * stage5 逐章链与 round-2 全文链的过滤结果均与原两条硬编码清单逐一对应（行为保持）。
 */
export const SURFACE_FIX_STEPS: readonly SurfaceFixStep[] = [
  { key: 'table-line-residue', stage5: true, round2: true, fix: markdown => { const r = mergeTableLineResidues(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // WS1 结构标签残留清洗（标签标题行删除/段首标签前缀剥离，正文零丢失）：先于其他内容修复执行——
  // 标签是结构层残留，先清结构再修内容（历史缺陷：分部分项章「施工概况/施工流程/施工方法」标签链残留）；
  // 放第 2 位与表残渣合并同属 markdown 完整性先行修复
  { key: 'templated-labels', stage5: true, round2: true, fix: markdown => { const r = fixTemplatedLabels(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // V2 批1 结构完整性确定性清理（只清不写：孤立编号去号/编号重排/孤立单项列表去号/删重复表头行/
  // 删表内重复行/删完全重复行/相邻重复句去重；内部幂等收敛）——结构层先行，与终检检测器
  // structure-integrity 同源单扫描（检测定位=清理定位）；blocking 类缺陷（截断/空节/表名混入表头/
  // 空表/标点断裂）不在此步处理（须重写，由修复轮/门禁负责，宁缺毋假）
  { key: 'structure-integrity', stage5: true, round2: true, fix: markdown => { const r = cleanStructureDefects(markdown); return { markdown: r.markdown, fixedCount: r.cleaned.length }; } },
  // 叠词收敛在 stage5 原实现为无条件赋值不计入重建判定（命中不触发 rebuild，修复随下次重建生效），
  // 收敛为计数形式后与 round-2 链同口径：命中即参与重建判定，避免「只有叠词命中时修复丢失」。
  { key: 'repeated-words', stage5: true, round2: true, fix: markdown => { const next = collapseRepeatedWords(markdown); return { markdown: next, fixedCount: next === markdown ? 0 : 1 }; } },
  { key: 'duplicate-tables', stage5: false, round2: true, fix: markdown => { const r = stripDuplicateTables(markdown); return { markdown: r.markdown, fixedCount: r.removedCount }; } },
  { key: 'finish-thickness', stage5: true, round2: true, fix: markdown => { const r = fixFinishThickness(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'labor-peak', stage5: true, round2: true, fix: (markdown, ctx) => { const r = fixLaborPeakConflict(markdown, ctx.laborPeakAuthority); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // V5 P4b-2 阶段劳动力确定性回写（12:33 评审 P0-1）：与检测器 phase-labor-mixing 同源双通道
  // 扫描（scanPhaseLaborClaims 单源）——正文阶段人数与蓝图分阶段推导不符即定点硬替换
  // （复检残留自动回滚）；紧随 labor-peak（总峰值权威先行、分阶段明细为后）；阶段名拼接
  // 歧义不在此步处理（无法确定性拆分，留 LLM 修复轮改述）
  { key: 'phase-labor-values', stage5: true, round2: true, fix: (markdown, ctx) => { const r = fixPhaseLaborValues(markdown, ctx.phaseLaborAuthorities); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // A3 资源章数值拆分确定性统一（4.27.0）：工种构成/机械台数/同名多规格材料拆分与蓝图权威漂移
  // 定点硬替换 + 复检（复检残留自动回滚）；紧随 labor-peak（峰值权威先行、组成为后），
  // 与检测器 resource-breakdown-consistency 同源同扫描（resourceBreakdownNumbers 单源）
  { key: 'resource-breakdown', stage5: true, round2: true, fix: (markdown, ctx) => { const r = fixResourceBreakdownNumbers(markdown, ctx.resourceBreakdownAuthority); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'internal-table-row-dup', stage5: true, round2: true, fix: markdown => { const r = stripInternalDuplicateTableRows(markdown); return { markdown: r.markdown, fixedCount: r.removedCount }; } },
  { key: 'greening-maintenance', stage5: true, round2: true, fix: (markdown, ctx) => { const r = fixGreeningMaintenanceMismatch(markdown, ctx.greeningMaintenanceAuthority); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'paragraph-opening-repeat', stage5: true, round2: true, fix: markdown => { const r = fixParagraphOpeningRepeats(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'paragraph-tail-repeat', stage5: true, round2: true, fix: markdown => { const r = fixParagraphTailRepeats(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'collision-numbered-heading', stage5: true, round2: true, fix: markdown => { const r = fixCollisionNumberedHeadings(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'inverted-date-range', stage5: true, round2: true, fix: markdown => { const r = fixInvertedDateRanges(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'truncated-sentence', stage5: true, round2: true, fix: markdown => { const r = fixTruncatedSentenceArtifacts(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'meta-discourse', stage5: true, round2: true, fix: markdown => { const r = fixMetaDiscourseDeclarations(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'formula-residue', stage5: true, round2: true, fix: markdown => { const r = fixFormulaResidues(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'self-undermining', stage5: true, round2: true, fix: markdown => { const r = fixSelfUnderminingCandidates(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // A4 关键设计决策两可表述唯一化（4.27.0）：句式表命中即按选定值/默认侧硬归一；
  // 与检测器 ambiguous-either-or 同源（supportForm 权威映射支护体系选定侧，残留缺口记入 details）
  { key: 'ambiguous-either-or', stage5: true, round2: true, fix: (markdown, ctx) => { const r = fixAmbiguousEitherOrCandidates(markdown, { supportForm: ctx.supportFormAuthority }); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'empty-scoring-response', stage5: true, round2: true, fix: markdown => { const r = fixEmptyScoringResponses(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.27.2 招标元语言确定性清理（语气泄漏治理 P0）：紧随 empty-scoring-response（空响应句先按
  // 条款语义改写为实义句，本步再清理其余「按招标文件要求/约定」条幅与「按上述条款」调用式元语言）
  { key: 'tender-meta-language', stage5: true, round2: true, fix: markdown => { const r = fixTenderMetaLanguage(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.27.2 条款响应重复行去重（重复补写治理 P0）：紧随元语言清理（条幅剥离后行形态归一，
  // 重复判定口径与清理器输出同帧——两补写器历史重复插入的交付前最终兜底）
  { key: 'duplicate-response-line', stage5: true, round2: true, fix: markdown => { const r = stripDuplicateResponseLines(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'atlas-reference', stage5: true, round2: false, fix: markdown => { const r = stripAtlasReferencePhrases(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'tertiary-h4-dedupe', stage5: false, round2: true, fix: markdown => dedupeTertiaryH4Titles(markdown) },
  { key: 'internal-term-heading', stage5: false, round2: true, fix: markdown => fixInternalTermHeadingPhrases(markdown) },
  // WS4 骨架指纹确定性兜底（round-2 链末尾、终检前最后一道：超量指纹轮换变体清零，
  // 保证终检 skeletonFingerprintIssues 达标；stage5 不启用——只在评审后全文链做最终收敛）
  { key: 'skeleton-fingerprint-variants', stage5: false, round2: true, fix: markdown => { const r = fixSkeletonFingerprintRepetition(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // WS3 工序形式确定性兜底（round-2 链、终检前最后一道：相邻同形式轮换转换清零，
  // 保证终检 flowFormRepeatIssues 达标；评审轮 LLM 改写复发由本步兜底收敛）
  { key: 'flow-form-variants', stage5: false, round2: true, fix: markdown => { const r = fixFlowFormRepetition(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // WS1 残缺标题确定性补全（round-2 链、终检前最后一道：从正文取证 core+工程后缀补全 <4 字残缺标题，
  // 保证终检 titleIntegrityIssues 达标；补全后标题被后续 toc-consistency 轮重同步目录）
  { key: 'truncated-title-completion', stage5: false, round2: true, fix: markdown => { const r = fixTruncatedTitleCompletion(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.27.2 句化标题切分（标题合并治理 P0 · round-2 链最后）：LLM 写作/评审轮把规划小节标题与正文
  // 首句并写为一行标题（「### 2.11 公厕机电安装工程集中在…」）的交付前兜底——标题还原为规划标题，
  // 续写句已被正文覆盖则丢弃、未覆盖部分转正文行（内容零丢失）；装配层 markdownComposer 同源前缀
  // 匹配在更早环节收敛；切分后标题结构变化由后续 toc-consistency 轮重同步目录
  { key: 'sentence-like-heading-split', stage5: false, round2: true, fix: (markdown, ctx) => { const r = fixSentenceLikeHeadingSplit(markdown, ctx.plannedSectionTitles); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
];

/** stage5 逐章链修复步骤（注册表顺序过滤） */
export function stage5FixSteps(): SurfaceFixStep[] {
  return SURFACE_FIX_STEPS.filter(step => step.stage5);
}

/** round-2 全文链修复步骤（注册表顺序过滤） */
export function round2FixSteps(): SurfaceFixStep[] {
  return SURFACE_FIX_STEPS.filter(step => step.round2);
}
