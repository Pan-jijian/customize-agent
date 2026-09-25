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
  fixDuplicateBasicInfoTables,
  fixEmbeddedHeadingLines,
  fixEquipmentBatchConflicts,
  fixFallbackPlaceholderRows,
  fixFinishThickness,
  fixForbiddenConfigurationTerms,
  fixFormulaResidues,
  fixGreeningMaintenanceMismatch,
  fixHeadingUncoveredItems,
  fixInvertedDateRanges,
  fixLaborPeakConflict,
  fixMetaDiscourseDeclarations,
  fixParagraphOpeningRepeats,
  fixParagraphTailRepeats,
  fixPhaseLaborValues,
  fixSelfUnderminingCandidates,
  fixSlotDepthValue,
  fixTruncatedSentenceArtifacts,
  fixTruncatedStandardCitations,
  fixZeroLengthDayRanges,
  mergeTableLineResidues,
  stripDuplicateTables,
  stripInternalDuplicateTableRows,
} from './documentIntegrityChecks';
import type { DeterministicFixOutcome } from './documentIntegrityChecks';
import { fixResourceBreakdownNumbers, type ResourceBreakdownAuthority } from './resourceBreakdownNumbers';
import { cleanStructureDefects, renumberSectionHeadings } from './structureIntegrityRules';
import { dedupeDuplicateSectionHeadings, dedupeTertiaryH4Titles } from './markdownComposer';
import { fixInternalTermHeadingPhrases } from './internalTerminologyAnchors';
import { stripAtlasReferencePhrases } from './documentGeneratorHelpers';
import { fixFormalSourceResidue, fixTenderMetaLanguage, stripDuplicateResponseLines } from './tenderRequirements';
import { fixFlowFormRepetition, fixSentenceLikeHeadingSplit, fixSkeletonFingerprintRepetition, fixTemplatedLabels, fixTruncatedTitleCompletion } from './templatingGovernance';
import { fixSpecQuantityBindings, type FactReconciliationInput } from './factReconciliation';
import type { DecisionLockEntry } from './integratedBlueprint';

/** 修复器权威口径上下文（与检测器同源：laborPeakAuthority 由蓝图决策锁定，greeningMaintenanceAuthority 由清单事实抽取，
 * resourceBreakdownAuthority 由蓝图资源清单推导，supportFormAuthority 由支护体系权威映射（放坡/钢板桩）） */
export interface SurfaceFixerContext {
  laborPeakAuthority?: number;
  greeningMaintenanceAuthority: number | undefined;
  /** A3 资源拆分权威（缺失时不执行资源数值修复，与检测器同口径静默） */
  resourceBreakdownAuthority?: ResourceBreakdownAuthority;
  /** A4 支护形式选定值（'放坡'/'钢板桩'；缺失时两可表述按正文主流侧默认归一） */
  supportFormAuthority?: string;
  /** 4.36 D3 决策锁条目（蓝图决策锁；两可表述归一按锁定值裁决——有锁归一/无锁缺口，与检测器同源） */
  decisionLockEntries?: readonly DecisionLockEntry[];
  /** 4.36 A2 章片段重放章号（stage5 逐章链按章序注入：章片段无「## 第N章」行，section-renumber
   * 按此章号整段重放；round-2 全文链不设置，走「## 第N章」行解析） */
  chapterNumber?: number;
  /** 规划小节标题全集（句化标题切分 sentence-like-heading-split 消费：标题前缀匹配还原规划标题；
   * 缺失时该步静默跳过——零配置零误伤） */
  plannedSectionTitles?: readonly string[];
  /** V5 P4b-2 阶段劳动力权威（phase-labor-values 消费：蓝图 byPhase 推导投影；缺失时该步静默） */
  phaseLaborAuthorities?: Array<{ phase: string; value: number; trace?: string }>;
  /** r17 机械设备汇总权威（equipment-batch-values 消费：blueprintEquipmentAuthorities 投影；
   * 缺失时该步静默跳过——零配置零误伤） */
  equipmentAuthorities?: Array<{ name: string; count: number }>;
  /** r17 B1 数值对账权威输入（spec-quantity-binding 消费：billFactLock/blueprintData/factsModel
   * 三源与检测器 fact-reconciliation 同源；缺失时该步静默跳过） */
  reconciliationInput?: Pick<FactReconciliationInput, 'billFactLock' | 'blueprintData' | 'factsModel'>;
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
  // r28h 行内嵌标题拆行（s28h2 实机归因）：「……有缺损。## 第九章 确保文明施工的技术组织措施」
  // 标题并进正文行致章标题不识别（「正文缺少章节标题」/小节错挂/目录缺节连锁 blockers）——
  // 紧随结构完整性清理：先恢复行首标题结构，拆出的编号由链尾 section-renumber 原子重放
  { key: 'embedded-heading-split', stage5: true, round2: true, fix: markdown => { const r = fixEmbeddedHeadingLines(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 叠词收敛在 stage5 原实现为无条件赋值不计入重建判定（命中不触发 rebuild，修复随下次重建生效），
  // 收敛为计数形式后与 round-2 链同口径：命中即参与重建判定，避免「只有叠词命中时修复丢失」。
  { key: 'repeated-words', stage5: true, round2: true, fix: markdown => { const next = collapseRepeatedWords(markdown); return { markdown: next, fixedCount: next === markdown ? 0 : 1 }; } },
  { key: 'duplicate-tables', stage5: false, round2: true, fix: markdown => { const r = stripDuplicateTables(markdown); return { markdown: r.markdown, fixedCount: r.removedCount }; } },
  { key: 'finish-thickness', stage5: true, round2: true, fix: markdown => { const r = fixFinishThickness(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.31 埋深/覆土槽位数值错位删除（丰乐镇 v6 #3「接地母线…埋深不小于 23.45m」= 长度口径
  // 误塞埋深槽）：与检测器 factReconciliation D4.3 同源正则/阈值（>10m 即删槽位短语），
  // 紧随 finish-thickness（同类数值定点修复）
  { key: 'slot-depth-value', stage5: true, round2: true, fix: markdown => { const r = fixSlotDepthValue(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // r17 丰乐镇归因 #B1：规格-数值绑定错位（「DN110 UPVC排水管15m」的 15m 无源——恰与无关条目
  // 「人行道混凝土垫层 15m³」数值相等被判张冠李戴）确定性原位替换为该规格组和值（D4.2 检测
  // 组和豁免口径，替换后必然通过；同形句逐处收敛 + 位置复检防新值撞其他规格）；紧随
  // slot-depth-value（同类数值定点修复，与检测器 fact-reconciliation 同源锚定）
  { key: 'spec-quantity-binding', stage5: true, round2: true, fix: (markdown, ctx) => { const r = fixSpecQuantityBindings(markdown, ctx.reconciliationInput ?? {}); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
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
  // r17 丰乐镇归因 #B2/B3：机械设备分批台数矛盾（「首批进场挖掘机5台…剩余挖掘机5台…」
  // 5+5 均不等于蓝图汇总 5 台）确定性删除 later 批「N 台」数字（批次表述形态保留；与检测器
  // equipment-batch-conflict 同源单扫描）；紧随 resource-breakdown（机械台数类修复同族相邻）
  { key: 'equipment-batch-values', stage5: true, round2: true, fix: (markdown, ctx) => { const r = fixEquipmentBatchConflicts(markdown, ctx.equipmentAuthorities); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'internal-table-row-dup', stage5: true, round2: true, fix: markdown => { const r = stripInternalDuplicateTableRows(markdown); return { markdown: r.markdown, fixedCount: r.removedCount }; } },
  // 4.31 基础信息表重复合并（丰乐镇 v6 #70）：多张「信息项|内容」基础表字段并集化，删除
  // 后续重复块（含「汇总成表」引导句），与检测器 markdownTableQualityIssues 同源字段词集合
  { key: 'duplicate-basic-info-tables', stage5: true, round2: true, fix: markdown => { const r = fixDuplicateBasicInfoTables(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.31 表格兜底话术行删除（丰乐镇 v6 #86/87「资料未明确」行）：与门禁 formalTextGateIssues
  // 行级扫描同词表，紧随基础表合并（合并跳过的兜底值行随块消失，孤立兜底行由本步收敛）
  { key: 'fallback-placeholder-rows', stage5: true, round2: true, fix: markdown => { const r = fixFallbackPlaceholderRows(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'greening-maintenance', stage5: true, round2: true, fix: (markdown, ctx) => { const r = fixGreeningMaintenanceMismatch(markdown, ctx.greeningMaintenanceAuthority); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'paragraph-opening-repeat', stage5: true, round2: true, fix: markdown => { const r = fixParagraphOpeningRepeats(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'paragraph-tail-repeat', stage5: true, round2: true, fix: markdown => { const r = fixParagraphTailRepeats(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'collision-numbered-heading', stage5: true, round2: true, fix: markdown => { const r = fixCollisionNumberedHeadings(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.31 小节标题工程类别未覆盖改名（丰乐镇 v6 #90「给排水、采暖、燃气工程」正文只覆盖
  // 给排水）：与检测器 headingUncoveredEngineeringItems 同源单扫描（scanUncoveredEngineeringHeadings），
  // 未覆盖词段从标题移除；目录由后续 tocConsistencyFix/fixTocFromBody 同步
  { key: 'heading-uncovered-items', stage5: true, round2: true, fix: markdown => { const r = fixHeadingUncoveredItems(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'inverted-date-range', stage5: true, round2: true, fix: markdown => { const r = fixInvertedDateRanges(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // r28j 同日零长区间修复（M15 归因：「预留开工后第360日至第360日」——检测器同日起止区间校验只报不修，
  // owner=llm 交修复轮但 LLM 未清）：紧随 inverted-date-range（时间区间族相邻、同一批扫描口径）
  { key: 'zero-length-date-range', stage5: true, round2: true, fix: markdown => { const r = fixZeroLengthDayRanges(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'truncated-sentence', stage5: true, round2: true, fix: markdown => { const r = fixTruncatedSentenceArtifacts(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'meta-discourse', stage5: true, round2: true, fix: markdown => { const r = fixMetaDiscourseDeclarations(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'formula-residue', stage5: true, round2: true, fix: markdown => { const r = fixFormulaResidues(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'self-undermining', stage5: true, round2: true, fix: markdown => { const r = fixSelfUnderminingCandidates(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // A4 关键设计决策两可表述唯一化（4.27.0）：句式表命中即按选定值/默认侧硬归一；
  // 4.36 D3：注册表裁决层——「A或B」命中决策类目时按决策锁归一（有锁）/转缺口（无锁）；
  // 与检测器 ambiguous-either-or 同源（supportForm 权威映射支护体系选定侧，残留缺口记入 details）
  { key: 'ambiguous-either-or', stage5: true, round2: true, fix: (markdown, ctx) => { const r = fixAmbiguousEitherOrCandidates(markdown, { supportForm: ctx.supportFormAuthority, decisionLock: ctx.decisionLockEntries }); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.27.2 招标元语言确定性清理（语气泄漏治理 P0）：清理「按招标文件要求/约定」条幅与
  // 「按上述条款」调用式元语言（4.41 起前置的空响应句改写已删除，本步仅做形态清理）
  { key: 'tender-meta-language', stage5: true, round2: true, fix: markdown => { const r = fixTenderMetaLanguage(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.55.12 资料载体残片清理（巢湖实测：答疑对答段 7 处 + 图纸 OCR 密集残片段 + 数值堆砌残句）：
  // 紧邻元语言清理——同属「非正文来源的语气/载体残片」家族，且要求池过滤（入池侧根治）之后仍需
  // 交付前兜底：条款尾收口补写发生在要求池判定之后，可再次把残片搬入正文
  { key: 'formal-source-residue', stage5: true, round2: true, fix: markdown => { const r = fixFormalSourceResidue(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.32 配置禁用词确定性清洗（丰乐镇 v6 #59：正文「按设计要求确定」触发模板 forbiddenTexts
  // 「配置要求不得出现：按设计要求」 blocker）：修复器 4.31 已实现但未接入两条链，注册即生效；
  // 「按设计要求/按图纸/见图纸」类责任模糊留白改写为具体出处，与门禁 containsForbiddenText 同豁免口径
  { key: 'forbidden-configuration', stage5: true, round2: true, fix: markdown => { const r = fixForbiddenConfigurationTerms(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.27.2 条款响应重复行去重（重复行治理 P0）：紧随元语言清理（条幅剥离后行形态归一，
  // 重复判定口径与清理器输出同帧——LLM 轮次间重复插入行的交付前最终兜底）
  { key: 'duplicate-response-line', stage5: true, round2: true, fix: markdown => { const r = stripDuplicateResponseLines(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.36.2 复查修正：文件头治理目标「round-2 曾缺图集引用清洗」的遗留漂移——stage5 之后的 LLM 补写轮
  // （数值/要求定向 patch）可再引入「做法参照XX图集」类非法引用，此前 round-2 链无确定性收敛点（门禁硬阻断死区）；
  // stripAtlasReferencePhrases 窄正则/标题表格豁免/短语级零丢失/幂等，补接零风险（其后的 toc-consistency 轮重同步目录）
  { key: 'atlas-reference', stage5: true, round2: true, fix: markdown => { const r = stripAtlasReferencePhrases(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  { key: 'tertiary-h4-dedupe', stage5: false, round2: true, fix: markdown => dedupeTertiaryH4Titles(markdown) },
  // 4.60 I2-c 标准引用残缺确定性兜底（编制依据长列举自吞噬，语料 13/263 命中）：在骨架/工序/标题
  // 三器之前收口——本器只插字符（《X<编号>）→《X》（<编号>）），不改变任何正文语义，越早收敛越省
  { key: 'standard-citation-truncation', stage5: false, round2: true, fix: markdown => { const r = fixTruncatedStandardCitations(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.31 内部术语替换扩展至表格行（丰乐镇 v6 #66/#88：「作业面落位」表头行 blocker 死区），
  // stage5 逐章链同样启用：替换为确定性词面安全替换，越早收敛越好
  { key: 'internal-term-heading', stage5: true, round2: true, fix: markdown => fixInternalTermHeadingPhrases(markdown) },
  // WS4 骨架指纹确定性兜底（round-2 链末尾、终检前最后一道：基准字形 + 变体形态按负载均衡同构改写清零，
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
  // 4.40 d5d 同章同名 H3 小节确定性合并：LLM 把同一主题小节写两遍（舒城实测 10.1/10.5「分区落实与临时道路流线」
  // 目录与正文重复堆叠）——后现块与首现块句指纹高重合整块删除，否则内容（去标题行）并入首现同名小节块末
  // （零标题改写/零内容丢失）；紧随其后 section-renumber 原子重放编号，toc-consistency 重建目录。
  // 与终检 headingDuplicateIssues 二级小节分支同源（sectionHeadingIdentityKey 单源）。
  { key: 'heading-duplicate-merge', stage5: true, round2: true, fix: markdown => { const r = dedupeDuplicateSectionHeadings(markdown); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
  // 4.36 A2 小节编号重放（结构事务化 · 编号不变量 INV-1）：链尾原子重放——清洗层删除重复 H3 行
  // （fixCollisionNumberedHeadings / 降级合并 / 直接删行类修复器）后编号出现空档时，按 H3 出现顺序
  // 重排「章序.节序」（章号=章标题解析值/前缀多数派，与终检 sectionNumberingIssues 同源），
  // H4 三段编号父前缀同步；「编号被分配又被删除」的历史缺陷（远端 4.35.0 缺 1.12/1.13/1.15 同签名）
  // 在此必然收敛；位于双链末尾——其后 stage5 链由 toc-consistency 重建目录消费新编号。
  // 接线（4.36 复查修正）：stage5 逐章链输入为章片段（无「## 第N章」行），经 ctx.chapterNumber
  // 注入章序走片段模式；round-2 全文链不注入（走「## 第N章」解析）
  { key: 'section-renumber', stage5: true, round2: true, fix: (markdown, ctx) => { const r = renumberSectionHeadings(markdown, { chapterNumber: ctx.chapterNumber }); return { markdown: r.markdown, fixedCount: r.fixedCount }; } },
];
