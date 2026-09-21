/**
 * repairRounds/postReviewSurface：评审后兜底链（FINALIZE_REPAIR_ROUNDS: planned-section-final / commercial-strip /
 * table-deterministic-repair / post-review-surface / terminology-strip / regulation-number-typo / toc-consistency）。
 * P2 拆分（方案 5.2）：由 finalizeGeneration 代码块机械搬迁而来，业务语义逐字一致（行为保持）。
 */
import { applySpanReplacements, applyNumericConsistencyDeterministicFixes, collapseRepeatedWords, stripCommercialDataBodyLines, fixTocFromBody, fixRegulationNumberTypos, fixTruncatedSentenceArtifacts, fixZeroLengthDayRanges, runDeterministicChainUntilConverged, scanSpecLocationMismatchHits } from '../../documentIntegrityChecks';
import { applyDeterministicConsistencyFixesToMarkdown } from '../../qualityValidation';
import { demoteUnsourcedNumericTokens, enforceBoqDivisionCoverageInMethodChapters } from '../../documentFactTrace';
import { blueprintCitationVerdict } from '../../integratedBlueprint';
import { buildAuthorityIndex } from '../../authorityIndex';
import { repairTableBlocksInMarkdownDeterministically } from '../../tableRepairHelpers';
import { stripInternalTerminologySentences } from '../../internalTerminologyAnchors';
import { fixUnsupportedTotalClaims, fixUnsourcedNameBindings } from '../../factReconciliation';
import { fixWorkInjuryInsuranceStatement } from '../../utils';
import { fixPreliminaryActionTimingDeterministically, fixEquipmentEntryTimingDeterministically } from '../../integrity/detectors/detectors';
import { fixListingJargonInCriticalPackageSections } from '../../constructionOrgQualityRules';
import { injectTableCaptions, normalizeFigureNumbering, normalizeTableNumbering, recoverTitlelessTableTitlesFromDrafts } from '../../constructionOrgTablePlan';
import { cleanFormalSourcePhrases, normalizeInlineListBreaks } from '../../markdownComposer';
import { isBodyTableForbidden } from '../../bidComposition';
import { enforcePlannedSectionCompleteness, mergeNearDuplicateSectionHeadings } from '../../globalQualityGates';
import { SURFACE_FIX_STEPS } from '../../deterministicFixChains';
import { displayStage, upsertProgressStage } from '../../progress';
import { stageAutoSpecGateRepair } from './autoSpecGateRepair';
import { stageBasisRegulationsRepair } from './basisRegulationsRepair';
import { stageBasisRegulationsCrossRepair } from './basisRegulationsCrossRepair';
import { stageDangerousApplicabilityRepair } from './dangerousApplicabilityRepair';
import { stageQuotationBalanceRepair } from './quotationBalanceRepair';
import { enforceCanonicalTermAnchorsInSections, isolateCanonicalAnchorLines } from './canonicalTermAnchors';
import { enforceFiveElementClosureBoost } from './fiveElementClosureBoost';
import { stripDuplicateParagraphs } from '../../integrity/fixers/fixers';
import { replayRequirementTailClosure, stageRequirementResponseRepair } from './requirementResponseRepair';
import type { FinalizeSession } from '../finalizeSession';

export async function stagePostReviewSurface(session: FinalizeSession): Promise<void> {
  // r11 近名小节确定性合并（丰乐镇门禁 #1 兜底）：写作期未对齐的错字标题小节（「分区落位→分区落实」
  // 单字改写）与补写轮补回的规划名小节并存时，章内 H3 超规划小节数（section-count-overflow blocker）
  // 直坠终门禁；写作期近名对齐（stageChapterLoop）只对本次成稿生效，本合并兜底既有产物与后续 LLM
  // 重写引入的变体。位于缺节补写（plannedSectionFixFinal）之前：先合并再判定缺节，补写轮不重复补。
  const nearDuplicateMerge = mergeNearDuplicateSectionHeadings(session.finalChapterDrafts);
  if (nearDuplicateMerge.mergedCount > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
    const nearDuplicateStage = displayStage({ type: 'validation', roleId: 'near-duplicate-section-merge', status: 'success', message: `近名小节确定性合并：${nearDuplicateMerge.mergedCount} 处`, details: nearDuplicateMerge.details.slice(0, 4) }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, nearDuplicateStage);
    upsertProgressStage(session.finalGateRepairStages, nearDuplicateStage);
  }
  // 缺节/空小节补写终兜底（丰乐镇第 2 轮实测）：全维度评审轮 patch 重写章节可能删除规划小节
  // （工程概况-项目管理组织机构与职责、施工总平面布置图-施工总平面布置原则与分区管理/
  // 竣工清理验收移交与保修 3 处缺节），生成期 enforcePlannedSectionCompleteness 早于评审轮覆盖不到；
  // 交付前对最终成稿再跑一次补写收口（缺节与纯表格空小节同口径，单轮失败即放弃，残留转门禁）
  const plannedSectionFixFinal = await enforcePlannedSectionCompleteness({
    chapterDraftsFinal: session.finalChapterDrafts, template: session.template, repairPromptTexts: session.repairPromptTexts,
    requirement: session.requirement, signal: session.signal, generationDiagnostics: session.generationDiagnostics, progressStages: session.progressStages, emitProgress: session.emitProgress, withProgressHeartbeat: session.withProgressHeartbeat,
    finalGateRepairStages: session.finalGateRepairStages,
    // 标书编制规格（正文表格口径）：交付前补写链与写作链同口径
    bidComposition: session.bidComposition,
  });
  if (plannedSectionFixFinal.plannedSectionFixApplied) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  // 4.17.8 交付前最终修复轮整体删除：其 12 类检测器与 blocker 修复循环 code map 全覆盖（检测侧单源），
  // 轮末重审/升级重试均属修复主力军化冗余——每缺陷 blocker 轮单次修复后失败即放弃，
  // 残留问题由导出门禁报告（不再进入 LLM 修复）；交付前确定性清洗（商务句/表格空单元格/数值定点）保留在下方。
  // r6 抽取为可重放函数（见文件尾 runSurfaceDeterministicCleans）：quotation-balance-repair 的
  // 章级 patch 成功时 rebuildFinalMarkdown() 会把本组清洗全部回退，需在其后重放一次恢复
  await runSurfaceDeterministicCleans(session);
  // 引文成对性残缺链尾修复（r4 实机归因）：同一自吞噬族系的法规列举句拼接丢失（「2017实施条例》」
  // 「第279安全生产管理条例》」）此前只有终检 punctuationArtifactIssues 报出 blocker、无修复轮
  // 消费——链尾章级定位 + LLM 定向补全 + 成对性复检（位置在文号确定性收口之后：确定性可覆盖
  // 形态零成本在前，需语义补全的形态随后；toc-consistency 之前）
  await stageQuotationBalanceRepair(session);
  // 丰乐镇实机终门禁归因 #8（编制依据法规漏列）：编制依据小节此前漏写具体法规/规范条目（法律法规/
  // 地方性法规齐全但零施工验收规范编号）只有终检 basis-regulations-coverage 报出、无修复轮消费——
  // 链尾章级定位 + LLM 定向补列缺失类目（照抄招标文件引用法规 + 按本工程分部分项选列现行规范名称
  // 及编号），位置在引文成对性收口之后（同一编制依据段族系）、toc-consistency 之前
  await stageBasisRegulationsRepair(session);
  // C5 一致性类 P6（编制依据↔正文双向对账链尾收口，r28l/s28l 实测：声明未用 8/4、引用未声明 7/15
  // 直坠终门禁）：used_not_declared 确定性补入编制依据同类目（零 LLM）+ declared_not_used 区分性
  // token 定位应用章 LLM 补引用 / 不适用确定性移除 + 全局复检（净减少/双向不上升/防删除门槛，
  // 违反即整体回滚）。位置在 basis-regulations-repair 之后（同编制依据段族系：覆盖在前、对账在后）、
  // dangerous-applicability-repair 之前
  await stageBasisRegulationsCrossRepair(session);
  // r28j 危大辨识清单漏项链尾收口（s28i 连续两轮实测）：正文出现「拆除工程」等适用前提而辨识
  // 叙述区缺别名精确词，此前只有终检 dangerous-applicability 报出、无修复轮消费——链尾定位含
  // 辨识区章 + LLM 定向补列遗漏项（补列紧邻既有辨识叙述），位置在法规收口之后、toc-consistency 之前
  await stageDangerousApplicabilityRepair(session);
  // D-T8 配置必要内容缺失链尾收口（r28f 实测 7 项术语缺失直坠终门禁）：模板命中的 autoSpecGates
  // 配置术语清单（国家法律法规/地方法规/项目特征/图纸设计说明/劳动力计划/主要施工材料/安全文明等）
  // 出现缺口时此前只有终检 planned-auto-spec-gate 报出、无修复轮消费——缺失术语 bigram 归属到章 +
  // LLM 定向补写（自然融入既有句，禁止孤立口号句），位置在编制依据法规收口之后、toc-consistency 之前
  await stageAutoSpecGateRepair(session);
  // r7 补写轮链尾重放（r6 #1/#2 残留归因）：requirement-response-repair 主链在 post-review-surface
  // 之前执行，其补写的响应内容可能被 quotation-balance-repair 的章级 LLM 整章重写吞掉（r6 实证：
  // 工程概况补写 1 条全部响应 → 引文修复重写工程概况 → 残留直坠门禁）——quotation 之后重放补写轮：
  // 消费 recompute 后的 requirements-coverage 最新 blocker 定向复补；silent 模式无残留时零成本
  // 返回（不覆盖首轮补写记录，stale 快照防御与主链同源）
  await stageRequirementResponseRepair(session, { silent: true });
  // r6 清洗重放（v11 回归收口，r5 实机归因）：stageQuotationBalanceRepair 章级 patch 成功时
  // session.rebuildFinalMarkdown() 从 finalChapterDrafts 重拼成稿，本函数上方全部字符串级清洗
  // （商务句/表格确定性/round-2 链/内部术语/法规文号）被一并回退——r5 实证：round-2 报 11 处、
  // terminology 报“已删除”、文号报 1 处均落地，其后 quotation 修工程概况 1 章 rebuild，
  // 终态骨架 4 处>2、「控制口径」「落位」4 词、文号残缺全部重现并直坠终门禁。
  // 重放同口径清洗恢复被回退的修复（含上一步补写轮 rebuild 的回退）；quotation 未 rebuild 时为
  // 幂等零成本（各块自比对无差异即静默）
  await runSurfaceDeterministicCleans(session);
  // B2 目录与正文一致性兜底：目录按最终正文 H2/H3 实际结构重建（fixTocFromBody 无改动时零成本），
  // 修复后再重算校验组，保证交付门禁与评分基于目录一致的最终成稿
  const tocConsistencyFix = fixTocFromBody(session.finalMarkdown);
  if (tocConsistencyFix.fixedCount > 0) {
    session.finalMarkdown = tocConsistencyFix.markdown;
    await session.recomputeFinalValidationBundle();
    const tocConsistencyStage = displayStage({ type: 'validation', roleId: 'toc-consistency', status: 'success', message: `目录与正文一致性兜底：按正文实际结构重建目录 ${tocConsistencyFix.fixedCount} 处` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, tocConsistencyStage);
    upsertProgressStage(session.finalGateRepairStages, tocConsistencyStage);
  }
  // r9 链尾蓝图引用数值收口重放（r9 实机 #4/#5 归因）：stage5 的蓝图引用语义判定 → 工程量冲突
  // 锚点确定性硬替换是其后 LLM 轮（requirement-response-repair / content-depth-repair）之前的清洗，
  // 后续 LLM 重写句段可再写入与蓝图口径不一致的数值（实测「塑料管铺设DN200总量7965m、DN110
  // 总量7435m」覆盖 stage5 已修口径，终检 blueprint-citation-consistency 与 fact-reconciliation 双报）
  //——链尾以同一判定+替换链重放收口（终检检测器实时重跑口径，重放后二者一致）；无蓝图或判定
  // 零锚时零成本静默（不写事件）。r15 封装为可重放函数（B1 实机归因：stageFactDistribution 的
  // rebuildFinalMarkdown 从章 drafts 重拼会回退本块替换，由 pipeline 在最后净变更点后重放）
  await replayBlueprintCitationNumericFixes(session);
  // M24c 链尾事实口径数值收口重放（961.42 回归定案）：stage5 的 scale/spec/cost 定点修复只写
  // finalMarkdown 不写章 drafts，其后任一 rebuildFinalMarkdown 都会把替换回退（s28k 实测「建设规模
  // 961.42→937.72」阶段记录成功而终稿残留）——此处以同一判定+替换链重放收口（factsModel
  // scale/spec/cost 目标），零目标/零处时零成本静默；由 pipeline 在最后净变更点后二次重放
  await replayStage5FactsModelNumericFixes(session);
  // r10 链尾要求响应终局收口（r9 实机 #1/#2 机制归因）：要求响应修复的全部轮次（主链 + 上方静默重放）
  // 都位于本函数尾部清洗之前——边缘语义条款（相似度 0.60x）在后续 content-depth 重写/确定性清洗
  // 引起的正文漂移中滑出 0.6 阈值后新报的 requirements-coverage blocker 再无任何修复轮消费，直坠
  // 终门禁。本块为本函数最后净变更点（toc-consistency / 蓝图数值重放之后、stageFinalGate 之前），
  // 以检测端完全同源口径现场重跑残留判定并循环收口（含防重复插入查重与 recompute 复验；机制与
  // 循环上限注释详见 replayRequirementTailClosure）。r24 起该函数同步由 documentPipeline 链尾重放
  //（B1-B5 实机归因：stageFactDistribution 的 rebuild 会把本块 markdown-only 插入回退）
  await replayRequirementTailClosure(session);
}

/** r15 链尾蓝图引用数值收口重放（B1 实机归因：stageFactDistribution 修改章 drafts 后的
 * rebuildFinalMarkdown 从章 drafts 重拼成稿，把本修复的字符串级替换回退——实测「金属扶手、
 * 栏杆、栏板 22m→224m」在 postReviewSurface 内替换成功（阶段记录 1 处），终态仍残留 22m
 * 且 gate 报 B1）。封装为可重放函数：由 documentPipeline 在最后一次净变更点
 * （runSurfaceDeterministicCleans 重放）之后、终门禁之前再调用一次；
 * 无蓝图/判定零锚/替换零处时零成本静默（幂等可重放）。 */
export async function replayBlueprintCitationNumericFixes(session: FinalizeSession): Promise<void> {
  if (!session.blueprintData) return;
  const citationReplayVerdict = await blueprintCitationVerdict(session.finalMarkdown, session.blueprintData, {
    diagnostics: session.generationDiagnostics,
    signal: session.signal,
  });
  if (citationReplayVerdict.anchors.length === 0) return;
  const numericReplayFix = applyNumericConsistencyDeterministicFixes(session.finalMarkdown, {
    authorityIndex: buildAuthorityIndex(session.blueprintData),
    scheduleAuthority: session.scheduleAuthority,
    assemblyRateAuthority: session.assemblyRateAuthority,
    supportAuthority: session.supportAuthority,
    quantityAnchors: citationReplayVerdict.anchors,
  });
  if (numericReplayFix.fixedCount === 0) return;
  session.finalMarkdown = numericReplayFix.markdown;
  await session.recomputeFinalValidationBundle();
  const citationReplayStage = displayStage({ type: 'validation', roleId: 'citation-numeric-replay', status: 'success', message: `链尾蓝图引用数值收口重放：${numericReplayFix.fixedCount} 处（${[...new Set(numericReplayFix.details)].slice(0, 4).join('、')}）` }, { subtitle: '评审后兜底' });
  upsertProgressStage(session.progressStages, citationReplayStage);
  upsertProgressStage(session.finalGateRepairStages, citationReplayStage);
}

/** M24c 链尾事实口径数值收口重放（961.42 回归定案：stage5 的 applyDeterministicConsistencyFixesToMarkdown
 * 只写 finalMarkdown 不写章 drafts，其后任一 rebuildFinalMarkdown 从章 drafts 重拼成稿会把 scale/spec/cost
 * 定点替换全部回退——s28k 实测 [75]「建设规模 961.42→937.72」阶段记录成功而终稿残留）。封装为可重放
 * 函数：由 documentPipeline 在最后一次净变更点（runSurfaceDeterministicCleans 重放）之后、终门禁之前
 * 再调用一次；无 factsModel/零修复时零成本静默（幂等可重放）。 */
export async function replayStage5FactsModelNumericFixes(session: FinalizeSession): Promise<void> {
  if (!session.factsModel) return;
  const stage5FactsFix = await applyDeterministicConsistencyFixesToMarkdown(session.finalMarkdown, session.factsModel, session.scopeConflicts);
  if (stage5FactsFix.fixedCount === 0) return;
  session.finalMarkdown = stage5FactsFix.markdown;
  await session.recomputeFinalValidationBundle();
  const stage5FactsReplayStage = displayStage({ type: 'validation', roleId: 'stage5-facts-replay', status: 'success', message: `链尾事实口径数值收口重放：${stage5FactsFix.fixedCount} 处（${stage5FactsFix.details.slice(0, 4).join('、')}）` }, { subtitle: '评审后兜底' });
  upsertProgressStage(session.progressStages, stage5FactsReplayStage);
  upsertProgressStage(session.finalGateRepairStages, stage5FactsReplayStage);
}

/**
 * 交付前确定性清洗组（r6 从 stagePostReviewSurface 抽取：语义逐字保持，仅增加可重放性）。
 * 处理块顺序固定：商务条款数据行清洗 → 表格空单元格确定性修复 → 无源合计句确定性删除 →
 * 无源名称绑定确定性删除 → 前期动作时限确定性改写 → 设备进场时序确定性改写 → 工伤保险表述
 * 确定性改写 → 关键小节清单口径词去词 → SURFACE_FIX_STEPS round-2 链（残行合并/叠词收敛/
 * 骨架复读/内部术语标题等）→ 内部术语句子整句删除 → 法规文号残缺收口 → 规格错位清单权威
 * 确定性收口 → 清单分部覆盖链尾兜底 → 规范术语显性落位链尾兜底 → 五要素闭合补强 →
 * 表格题注链尾收口 → 段落完全重复全文去重 → 锚句行独立化。
 * 每块只在 markdown 实际变化时重算校验组并双写进度事件；重放时无差异即全静默（幂等零成本）。
 * r14 导出（r13 实机归因）：链尾 stageFactDistribution 的 rebuildFinalMarkdown 从章 drafts
 * 重拼成稿会再次回退本组清洗（gate 报 13 条阻断与落盘 markdown 脏内容一致）——由调用方
 * 在最后一次净变更点之后、终门禁之前重放本函数，保证「终门禁所检 = 交付所存 = 清洗后成稿」。
 */
export async function runSurfaceDeterministicCleans(session: FinalizeSession): Promise<void> {
  // 商务条款数据交付前兜底清洗（round-18 E9）：blocker 修复循环结束后的 LLM patch（全维度评审轮修复等）
  // 可能引入商务句（暂列金额/综合单价等，徽光阁实测“暂列金额60万元计入其他项目清单”在修复循环后进入正文），
  // 门禁已升级硬阻断（CRITICAL_BLOCK_RE 含“商务条款”）；交付前用与检测器同口径的行级安全清洗兜底
  // （标题行/表格行不触碰，仅删含商务词的正文句），清洗后重算校验组再判定最终门禁
  const cleanedCommercialMarkdown = stripCommercialDataBodyLines(session.finalMarkdown);
  if (cleanedCommercialMarkdown !== session.finalMarkdown) {
    session.finalMarkdown = cleanedCommercialMarkdown;
    await session.recomputeFinalValidationBundle();
    // 4.36.2 复查修正（诊断可见性）：清洗器修改最终成稿后此前无任何事件，复盘不可见——补事件并双写
    const commercialStripStage = displayStage({ type: 'validation', roleId: 'commercial-strip', status: 'success', message: '商务条款数据交付前兜底清洗：正文商务条款数据句已删除' }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, commercialStripStage);
    upsertProgressStage(session.finalGateRepairStages, commercialStripStage);
  }
  // 表格确定性修复（round-19 R5；r12 扩围连写表拆分 + 同表头堆叠降维）：表格专轮之后的 LLM patch
  // （全维度评审轮修复）可能重写表格引入空单元格与连写表（无空行相接的多张表被解析器视为单块：
  // 第二张表表头/分隔行被当数据行，误报「列数不一致」与「占位符（‘---’行）」——丰乐镇实测 3 项
  // 结构阻断同源）。逐块结构归一 + 拆分子表间插引导句 + 同表头 ≥3 次组首格主题限定降维。
  // 注意：removed 只统计删除块数，其余类修复须按 markdown 变化判断是否重算
  const repairedTableMarkdown = repairTableBlocksInMarkdownDeterministically(session.finalMarkdown);
  if (repairedTableMarkdown.markdown !== session.finalMarkdown) {
    session.finalMarkdown = repairedTableMarkdown.markdown;
    await session.recomputeFinalValidationBundle();
    const tableFixParts = [
      repairedTableMarkdown.removed > 0 ? `结构归一删除 ${repairedTableMarkdown.removed} 块` : '',
      repairedTableMarkdown.splitCount > 0 ? `连写表拆分 ${repairedTableMarkdown.splitCount} 处` : '',
      repairedTableMarkdown.variantCount > 0 ? `表头主题降维 ${repairedTableMarkdown.variantCount} 处` : '',
    ].filter(Boolean).join('、');
    const tableDeterministicStage = displayStage({ type: 'validation', roleId: 'table-deterministic-repair', status: 'success', message: `表格确定性修复：${tableFixParts}（表格空单元格/列数/堆叠口径）` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, tableDeterministicStage);
    upsertProgressStage(session.finalGateRepairStages, tableDeterministicStage);
  }
  // 无源合计句确定性删除（r12 丰乐镇门禁 #1/#2 归因）：终检 fact-reconciliation 报「合计值无权威来源」
  // blocker 只报不修（清单无同值条目、无唯一权威替值可改写），全稿 LLM 修复轮后仍残留——交付前按
  // 子句边界确定性删除（检测定位=修复定位：与扫描同口径定位无源合计句 span）。须先于清单口径词
  // 去词块执行：无源合计句删除后其「合计」词一并消失，去词块只消费剩余句（顺序不可交换）。
  const unsupportedTotalFix = fixUnsupportedTotalClaims(session.finalMarkdown, {
    billFactLock: session.billFactLock,
    blueprintData: session.blueprintData,
    factsModel: session.factsModel,
  });
  if (unsupportedTotalFix.fixedCount > 0) {
    session.finalMarkdown = unsupportedTotalFix.markdown;
    await session.recomputeFinalValidationBundle();
    const unsupportedTotalStage = displayStage({ type: 'validation', roleId: 'unsupported-total-claim-clean', status: 'success', message: `无源合计值确定性删除：${unsupportedTotalFix.fixedCount} 处（${unsupportedTotalFix.details.slice(0, 4).join('、')}）` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, unsupportedTotalStage);
    upsertProgressStage(session.finalGateRepairStages, unsupportedTotalStage);
  }
  // 无源名称绑定确定性删除（r26 丰乐镇门禁归因，r26d 接线）：终检 fact-reconciliation 报「名称-数值
  // 绑定无源」blocker 只报不修（同名条目数十条、无一条同值，无唯一可裁决替值可改写），全稿 LLM
  // 修复轮后仍残留——交付前按子句边界确定性删除绑定子句（检测定位=修复定位：与名称绑定扫描
  // 同口径定位 span，边界口径与无源合计句删除共用）。重放无命中零变更（幂等零成本）。
  const unsourcedBindingFix = fixUnsourcedNameBindings(session.finalMarkdown, {
    billFactLock: session.billFactLock,
    blueprintData: session.blueprintData,
    factsModel: session.factsModel,
  });
  if (unsourcedBindingFix.fixedCount > 0) {
    session.finalMarkdown = unsourcedBindingFix.markdown;
    await session.recomputeFinalValidationBundle();
    const unsourcedBindingStage = displayStage({ type: 'validation', roleId: 'unsourced-binding-clean', status: 'success', message: `无源名称绑定确定性删除：${unsourcedBindingFix.fixedCount} 处（${unsourcedBindingFix.details.slice(0, 4).join('、')}）` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, unsourcedBindingStage);
    upsertProgressStage(session.finalGateRepairStages, unsourcedBindingStage);
  }
  // 前期动作时限矛盾确定性改写（r12 丰乐镇门禁 #5 归因）：「开工令下发后第90日完成劳动力进场登记」
  //（第 90 日 = 总工期 90 日竣工日）全稿 LLM 修复轮后仍残留——终检只报不修直坠门禁；时限表述无
  // 唯一可裁决天数可用，按检测器同名建议确定性改写为「施工准备阶段内」（不引入新事实只删矛盾时限）。
  // 总工期未知时扫描自跳过（零变更静默）。
  const preliminaryTimingFix = fixPreliminaryActionTimingDeterministically(session.finalMarkdown, session.blueprintData?.contract.totalDays);
  if (preliminaryTimingFix.fixedCount > 0) {
    session.finalMarkdown = preliminaryTimingFix.markdown;
    await session.recomputeFinalValidationBundle();
    const preliminaryTimingStage = displayStage({ type: 'validation', roleId: 'preliminary-action-timing-clean', status: 'success', message: `前期动作时限确定性改写：${preliminaryTimingFix.fixedCount} 处（${preliminaryTimingFix.details.slice(0, 4).join('、')}）` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, preliminaryTimingStage);
    upsertProgressStage(session.finalGateRepairStages, preliminaryTimingStage);
  }
  // 设备进场时序确定性改写（r26c 丰乐镇门禁归因，r26d 接线）：终检 equipment-entry-timing 报
  // 「压路机 第90日进场（=总工期）」类尾期进场/基坑阶段设备工序倒挂 blocker 只报不修（进场日无
  // 唯一可裁决天数，须重排进度计划）——交付前按同一判据（检测定位=修复定位）确定性删除矛盾日号
  // 改述为「按进度计划」。总工期/节点未知时扫描自跳过（零变更静默）；重放无命中零变更（幂等零成本）。
  const equipmentTimingFix = fixEquipmentEntryTimingDeterministically(session.finalMarkdown, session.factsModel);
  if (equipmentTimingFix.fixedCount > 0) {
    session.finalMarkdown = equipmentTimingFix.markdown;
    await session.recomputeFinalValidationBundle();
    const equipmentTimingStage = displayStage({ type: 'validation', roleId: 'equipment-entry-timing-clean', status: 'success', message: `设备进场时序确定性改写：${equipmentTimingFix.fixedCount} 处（${equipmentTimingFix.details.slice(0, 4).join('、')}）` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, equipmentTimingStage);
    upsertProgressStage(session.finalGateRepairStages, equipmentTimingStage);
  }
  // 工伤保险表述确定性改写（r14 丰乐镇 B3 归因）：终检 localAdaptationKeywordIssues 词面门控
  // （「工伤保险」邻近办理/缴纳类动词）只报不修直坠门禁——写作层写「办理意外伤害保险」时
  // 交付前确定性改写为含「办理工伤保险（按建设项目参保）」并列表述（同源判定改写后恒通过）；
  // 无可改写句时在「工伤保险」小节插入合规短句兜底。字符串级改写，本组在 pipeline 最后一次
  // 净变更点重放时自动恢复回退（与 citation-numeric-replay 重放同链）
  const workInjuryFix = fixWorkInjuryInsuranceStatement(session.finalMarkdown);
  if (workInjuryFix.fixedCount > 0) {
    session.finalMarkdown = workInjuryFix.markdown;
    await session.recomputeFinalValidationBundle();
    const workInjuryStage = displayStage({ type: 'validation', roleId: 'work-injury-statement-clean', status: 'success', message: `工伤保险表述确定性收口：${workInjuryFix.fixedCount} 处（${workInjuryFix.details.slice(0, 4).join('、')}）` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, workInjuryStage);
    upsertProgressStage(session.finalGateRepairStages, workInjuryStage);
  }
  // 关键小节清单口径词确定性去词（r12 丰乐镇门禁 #10 归因）：「1.2 主要施工内容」正文
  // 「道路硬化及修复面积合计2783㎡」的「合计」属清单计价表内部口径（weakHits 形态）——数值本身
  // 有权威口径无须改数，只确定性删除「合计/小计」口径词（与检测器同正则同源，复检恒清零）。
  const listingJargonFix = fixListingJargonInCriticalPackageSections(session.finalMarkdown);
  if (listingJargonFix.fixedCount > 0) {
    session.finalMarkdown = listingJargonFix.markdown;
    await session.recomputeFinalValidationBundle();
    const listingJargonStage = displayStage({ type: 'validation', roleId: 'listing-jargon-clean', status: 'success', message: `关键小节清单口径词去词：${listingJargonFix.fixedCount} 处（${listingJargonFix.details.slice(0, 4).join('、')}）` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, listingJargonStage);
    upsertProgressStage(session.finalGateRepairStages, listingJargonStage);
  }
  // B6 评审轮后表面修复兜底（丰乐镇第六轮实测）：全维度评审轮 patch 重写章节会再引入
  // 表格断行残片（「优先保障关键村 |」独立残行），stage5 修复链早于评审轮覆盖不到；
  // 最终导出前对全文再跑一遍残行合并+叠词收敛（与检测器同口径，零成本零误伤）。
  // 修复器清单与顺序由 SURFACE_FIX_STEPS 注册表统一定义（P10 单源，与 stage5 链同源）
  const surfaceFixRound2Result = runDeterministicChainUntilConverged(
    SURFACE_FIX_STEPS.filter(step => step.round2).map(step => (markdown: string) => step.fix(markdown, session.surfaceFixContext)),
    session.finalMarkdown,
    3,
  );
  if (surfaceFixRound2Result.markdown !== session.finalMarkdown) {
    session.finalMarkdown = surfaceFixRound2Result.markdown;
    await session.recomputeFinalValidationBundle();
    // 4.36.2 复查修正（诊断可见性）：round-2 链修改正文后此前无任何事件，复盘不可见——补事件并双写
    const postReviewSurfaceStage = displayStage({ type: 'validation', roleId: 'post-review-surface', status: 'success', message: `评审轮后表面修复兜底：确定性清洗 ${surfaceFixRound2Result.fixedCount} 处` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, postReviewSurfaceStage);
    upsertProgressStage(session.finalGateRepairStages, postReviewSurfaceStage);
  }
  // 内部术语句子确定性删除兜底（round-19 R3 已实现未接线，丰乐镇第 2 轮实测：
  // 「落位」「控制口径」「峰值口径」「数据口径」经 LLM 修复轮仍残留 4 词，检测器报 error blocker；
  // 交付前接入与检测器同源同阈值的整句删除（L1 精确词 + L3 语义锚点，标题/表格/目录行豁免），
  // 删除后重算校验组，旧 issue 快照由 recompute 内部口径剔除）
  const strippedTerminologyMarkdown = await stripInternalTerminologySentences(session.finalMarkdown);
  if (strippedTerminologyMarkdown !== session.finalMarkdown) {
    session.finalMarkdown = strippedTerminologyMarkdown;
    await session.recomputeFinalValidationBundle();
    const terminologyStripStage = displayStage({ type: 'validation', roleId: 'terminology-strip', status: 'success', message: '内部术语句子确定性删除兜底：正文残留内部术语已删除' }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, terminologyStripStage);
    upsertProgressStage(session.finalGateRepairStages, terminologyStripStage);
  }
  // 法规文号残缺确定性收口（4.44 丰乐镇实机两轮同形态复现）：stage5 全文数值链（含文号修复）之后的
  // LLM patch 轮（数值/要求定向修复、缺节补写）重写句段可再度引入「（国务院令第279订）」类自吞噬残缺，
  // 链尾此前无确定性收口点（两轮成稿编制依据段均残留）。纯正则定点（仅「第N订」紧邻右括号语境）幂等零误伤。
  const regulationNumberFix = fixRegulationNumberTypos(session.finalMarkdown);
  if (regulationNumberFix.fixedCount > 0) {
    session.finalMarkdown = regulationNumberFix.markdown;
    await session.recomputeFinalValidationBundle();
    const regulationNumberStage = displayStage({ type: 'validation', roleId: 'regulation-number-typo', status: 'success', message: `法规文号残缺确定性收口：${regulationNumberFix.fixedCount} 处（${regulationNumberFix.details.slice(0, 4).join('、')}）` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, regulationNumberStage);
    upsertProgressStage(session.finalGateRepairStages, regulationNumberStage);
  }
  // 规格错位清单权威确定性收口（r7 实机归因，r6 #4）：A2 数值裁决器在跨章一致性轮之前执行，
  // 其后 LLM 修复轮（数值核对/要求补写/引文补全）重写句段可再度写错规格部位（实测「块料踢脚线
  // 高度15mm」vs 清单权威 150mm）——终检 spec-location-mismatch 只报不修直坠门禁。交付前以
  // 同一扫描口径（检测定位=修复定位）对唯一权威错位应用确定性替换；多义权威（replacement 缺省）
  // 留终门禁照常复核；重放时无错位即全静默（幂等零成本）
  const specAuthorityMap = session.factsModel?.specAuthorityMap;
  if (specAuthorityMap) {
    let specFixTotal = 0;
    const specFixDetails: string[] = [];
    // 复扫循环：单次扫描上限 8 命中，替换后重扫直到无唯一权威错位或达上限（防替换-复检往返）
    for (let round = 1; round <= 3; round += 1) {
      const specReplacements = scanSpecLocationMismatchHits(session.finalMarkdown, specAuthorityMap)
        .flatMap(hit => (hit.replacement ? [hit.replacement] : []));
      if (specReplacements.length === 0) break;
      const specApplied = applySpanReplacements(session.finalMarkdown, specReplacements);
      if (specApplied.fixedCount === 0) break;
      session.finalMarkdown = specApplied.markdown;
      specFixTotal += specApplied.fixedCount;
      specFixDetails.push(...specApplied.details);
    }
    if (specFixTotal > 0) {
      await session.recomputeFinalValidationBundle();
      const specLocationStage = displayStage({ type: 'validation', roleId: 'spec-location-mismatch-clean', status: 'success', message: `规格错位清单权威确定性收口：${specFixTotal} 处（${[...new Set(specFixDetails)].slice(0, 4).join('、')}）` }, { subtitle: '评审后兜底' });
      upsertProgressStage(session.progressStages, specLocationStage);
      upsertProgressStage(session.finalGateRepairStages, specLocationStage);
    }
  }
  // r14 E16 清单分部覆盖链尾兜底（丰乐镇实机：过路涵/青砖步道在主要施工方法章零命中——规划层未规划
  // 专有小节、写作层未覆盖，终检 boq-division-coverage blocker 后修复循环亦无从落笔）。源头修复在
  // 规划/写作注入（stageOutlinePlanning 的 boqCoverageSummary 参数、stageChapterLoop 的
  // 覆盖义务 roleContext），本块为确定性兜底：方法章仍缺清单专有分项时在章末追加纯段落
  //（无新标题——不改 H2/H3 结构与目录），补段逐项含缺失分项名 → 检测复检恒清零；同步写回章
  // drafts 防 rebuildFinalMarkdown 重拼回退；缺口清零时零成本静默（幂等可重放）。本块为函数内
  // 净变更点（后续尚有五要素闭合补强/表格题注链尾收口等追加块，均不回改正文段）——补段自身经
  // 链尾各检测器词面排查（无商务词/内部术语/时限表述/管理套话）
  const boqDivisionFix = enforceBoqDivisionCoverageInMethodChapters({
    markdown: session.finalMarkdown,
    chapters: session.finalChapterDrafts,
    factsModel: session.factsModel,
  });
  if (boqDivisionFix) {
    session.finalMarkdown = boqDivisionFix.markdown;
    await session.recomputeFinalValidationBundle();
    const boqDivisionStage = displayStage({ type: 'validation', roleId: 'boq-division-coverage-closure', status: 'success', message: `清单分部覆盖链尾兜底：方法章补写 ${boqDivisionFix.appended.length} 个缺失分项（${boqDivisionFix.appended.slice(0, 6).join('、')}）` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, boqDivisionStage);
    upsertProgressStage(session.finalGateRepairStages, boqDivisionStage);
  }
  // r14 F 规范术语显性落位链尾兜底（丰乐镇实机：评分 19 项中 5 项规范术语未显性出现致
  // bge 相似度 0.55~0.59 MISS、7 项 0.60x 边缘 HIT——各修复轮以近义改写为优先，术语词面
  // 从不强制出现）：确定性锚定（术语/目标小节/锚句形态全部固化，无 LLM）——已在短块显性
  // 承载的项跳过，其余在目标小节标题后插入含术语原词的引导句，评分重算时块级相似度 ≥0.6
  // 命中；不改 H2/H3 结构与目录；同步章 drafts 防 rebuild 回退（幂等可重放）。本块为函数内
  // 净变更点（后续尚有五要素闭合补强等追加块，均不回改小节正文段）
  const canonicalAnchors = enforceCanonicalTermAnchorsInSections({
    markdown: session.finalMarkdown,
    chapters: session.finalChapterDrafts,
  });
  if (canonicalAnchors) {
    session.finalMarkdown = canonicalAnchors.markdown;
    await session.recomputeFinalValidationBundle();
    const canonicalAnchorStage = displayStage({ type: 'validation', roleId: 'canonical-term-anchor', status: 'success', message: `规范术语显性落位链尾兜底：插入 ${canonicalAnchors.inserted.length} 处术语锚句（${canonicalAnchors.inserted.join('、')}）` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, canonicalAnchorStage);
    upsertProgressStage(session.finalGateRepairStages, canonicalAnchorStage);
  }
  // 可落地性五要素闭合补强（r14 丰乐镇实测）：executability 按空行块五要素词面命中 ≥4 项统计
  // 闭合块密度，成稿块普遍「差一项」（r14 实测 3 项块 22 个全部缺 plan）停在 48 分；链尾对
  // 未达标非表格块确定性补一句措施句推过 4 项线（表格/目录块零触碰，句池轮换避开骨架指纹
  // 「由技术负责人组织/合格后方可/验收合格后」与闭环密度上限）；同为纯追加零删改。
  const closureBoost = enforceFiveElementClosureBoost(session.finalMarkdown);
  if (closureBoost) {
    session.finalMarkdown = closureBoost.markdown;
    await session.recomputeFinalValidationBundle();
    const closureBoostStage = displayStage({ type: 'validation', roleId: 'five-element-closure-boost', status: 'success', message: `五要素闭合补强：${closureBoost.fixedCount} 个措施块补句达标` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, closureBoostStage);
    upsertProgressStage(session.finalGateRepairStages, closureBoostStage);
  }
  // 表格题注链尾收口（r26c 丰乐镇门禁归因，r26d 接线）：链尾章级 patch 与 rebuild（事实扩散/表格
  // 补名等 draft-mutating 阶段）可能使终稿表格丢失表题行（r26c 实测：终稿风险表无题名行、草稿同表头
  // 表仍带题名——「正文 1 张表格缺少题注编号」blocker 直坠门禁）。①以章草稿表头归一键反查同表
  // 题名回填（recoverTitlelessTableTitlesFromDrafts，数据源为写作层原始草稿）；②按导出链同口径
  // 重跑题注注入+编号唯一化（injectTableCaptions 幂等跳过已带题注表、normalizeTableNumbering
  // 拆粘连/编号重排）——收口后终检所检与导出链产物一致。正文禁表（bodyTablePolicy=forbidden，
  // 招标显式禁表句）由守卫跳过（与导出链调用侧同口径）；零回填且链零变化时零成本静默（幂等可重放）。
  if (!isBodyTableForbidden(session.bidComposition)) {
    const titleRecovery = recoverTitlelessTableTitlesFromDrafts(session.finalMarkdown, session.finalChapterDrafts.map(chapter => chapter.content || ''));
    // B-T1 图题链同口径收口：章级 patch/重建可能使图题编号错位——重跑编号归一化（幂等，无图题零改动）
    const captionChainMarkdown = normalizeFigureNumbering(normalizeTableNumbering(injectTableCaptions(titleRecovery.markdown)));
    if (captionChainMarkdown !== session.finalMarkdown) {
      session.finalMarkdown = captionChainMarkdown;
      await session.recomputeFinalValidationBundle();
      const recoveredParts = [
        titleRecovery.recovered > 0 ? `题名回填 ${titleRecovery.recovered} 张（${titleRecovery.details.slice(0, 4).join('、')}）` : '',
        '题注编号链收口',
      ].filter(Boolean).join('；');
      const captionRecoveryStage = displayStage({ type: 'validation', roleId: 'table-caption-recovery', status: 'success', message: `表格题注链尾收口：${recoveredParts}` }, { subtitle: '评审后兜底' });
      upsertProgressStage(session.progressStages, captionRecoveryStage);
      upsertProgressStage(session.finalGateRepairStages, captionRecoveryStage);
    }
  }
  // r27 B2b 段落完全重复全文去重（r26d 归因：closureBoost 补句经题注链按粘连形态拆分/
  // 搬运后跨块成段，同句跨块复用致「段落完全重复」blocker）：与检测器 duplicateParagraphIssues
  // 同源分块（空行分块 + 标题/表格行不入池 + 指纹 ≥40 字）的全文级去重，保留首次出现；
  // 与源头防粘连（fiveElementClosureBoost 表题行跳过）双保险，纯结构判据零项目语义
  const duplicateParagraphFix = stripDuplicateParagraphs(session.finalMarkdown);
  if (duplicateParagraphFix.removedCount > 0) {
    session.finalMarkdown = duplicateParagraphFix.markdown;
    await session.recomputeFinalValidationBundle();
    const duplicateParagraphStage = displayStage({ type: 'validation', roleId: 'duplicate-paragraph-clean', status: 'success', message: `段落完全重复全文去重：删除 ${duplicateParagraphFix.removedCount} 处重复段` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, duplicateParagraphStage);
    upsertProgressStage(session.finalGateRepairStages, duplicateParagraphStage);
  }
  // r27 锚句行独立化（r26d 归因：章级紧凑化删空行致锚句与正文行粘连成大块、bge 相似度
  // 被稀释至 0.56~0.59 卡线）：链尾对锚句行前后确保独立空行（仅补空行不改字，幂等；
  // 此后无 rebuild，空行存活至终稿）。纯结构判据（锚表 lead 前 20 字前缀），零项目语义
  const anchorIsolation = isolateCanonicalAnchorLines(session.finalMarkdown);
  if (anchorIsolation.isolated > 0) {
    session.finalMarkdown = anchorIsolation.markdown;
    await session.recomputeFinalValidationBundle();
    const anchorIsolationStage = displayStage({ type: 'validation', roleId: 'canonical-anchor-isolation', status: 'success', message: `锚句行独立化：补 ${anchorIsolation.isolated} 个空行保障块级命中` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, anchorIsolationStage);
    upsertProgressStage(session.finalGateRepairStages, anchorIsolationStage);
  }
  // C-T2 未溯源数值链尾确定性改定性（实测归因：真未溯源数字「能改定性即改」）：
  // 前序 numeric-verification 轮交 LLM 定向修复（时间/次数/百分比类改语义），本块对残留的
  // 可删单位类（空间/数量/长度/重量）直接删除改定性；删除前保护量词/维度/约数字尾（「每座」
  // 「壁厚」「间距」字尾接数值不删，防悬空/语义反转）；检测器 numeric-traceability 与本器同源扫描
  //（删除后复检恒清零）；同步章 drafts 防 factDistribution 重建回退；无可删项时零成本静默（幂等）。
  const numericDemote = demoteUnsourcedNumericTokens({ markdown: session.finalMarkdown, factsModel: session.factsModel });
  if (numericDemote) {
    session.finalMarkdown = numericDemote.markdown;
    // 同步章 drafts（同口径逐章重跑；章内无命中即不动——markdown 与 drafts 双端一致）
    for (const chapter of session.finalChapterDrafts) {
      const chapterDemote = demoteUnsourcedNumericTokens({ markdown: chapter.content || '', factsModel: session.factsModel });
      if (chapterDemote) chapter.content = chapterDemote.markdown;
    }
    await session.recomputeFinalValidationBundle();
    const numericDemoteStage = displayStage({ type: 'validation', roleId: 'numeric-traceability-demote', status: 'success', message: `未溯源数值确定性改定性：${numericDemote.fixedCount} 处（${numericDemote.details.slice(0, 4).map(detail => detail.slice(0, 32)).join('；')}）` }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, numericDemoteStage);
    upsertProgressStage(session.finalGateRepairStages, numericDemoteStage);
  }
}

/**
 * r28h 链尾标点终局收口（r28h2/s28h2 实机归因）：交付结构收口（超长段落切分）与其后追加块
 *（未溯源数值删除改定性/术语锚句插入/要求补写）仍可能把标点叠用残留（「。。」句段拼接、
 *「、、」并列删除）带回正文，round-2 链（本文件 runSurfaceDeterministicCleans 中段）无二次
 *消费点直坠终门禁。本重放在最后一次 markdown 变更（stageDeliveryStructureClosure）之后、
 *终门禁之前以同源修复器（fixTruncatedSentenceArtifacts）收口——终门禁所检 = 交付所存 =
 *收口后成稿（幂等可重放，零残留时零成本静默）。
 *
 * r28j 扩围为链尾表面终局收口链（r28i 归因：M13/M15 六项修复器重放缺口——探针实测
 * delivery-structure-closure 之后的脏文本仍可直坠终稿：叠词「工程工程」、同日零长区间
 *「第360日至第360日」、行内列表项粘连、来源罗列话术残留、正文无题表 4 张）：按「标点→叠词→
 * 零长区间→行内列表拆行→来源清洗→题注链」序全量重放六项确定性修复器，逐块收集变化明细，
 * 全部零变化时零成本静默；题注链与 runSurfaceDeterministicCleans 链尾块同口径（暗标正文
 * 禁表由守卫跳过，recover 以章草稿表头归一键反查）。每块修复器均为幂等方式，重放不产生 churn，
 * 变化仅一次 recompute（终门禁所检 = 交付所存 = 收口后成稿）。
 */
export async function replaySurfacePunctuationClosure(session: FinalizeSession): Promise<void> {
  let markdown = session.finalMarkdown;
  const applied: string[] = [];
  const punctuation = fixTruncatedSentenceArtifacts(markdown);
  if (punctuation.fixedCount > 0) {
    markdown = punctuation.markdown;
    applied.push(`标点叠用收敛（${punctuation.details.slice(0, 3).join('；')}）`);
  }
  const repeated = collapseRepeatedWords(markdown);
  if (repeated !== markdown) {
    markdown = repeated;
    applied.push('叠词重复收敛');
  }
  const zeroRange = fixZeroLengthDayRanges(markdown);
  if (zeroRange.fixedCount > 0) {
    markdown = zeroRange.markdown;
    applied.push(`同日零长区间收敛（${zeroRange.details.slice(0, 3).join('；')}）`);
  }
  const listBreak = normalizeInlineListBreaks(markdown);
  if (listBreak !== markdown) {
    markdown = listBreak;
    applied.push('行内列表项拆行');
  }
  const sourceClean = cleanFormalSourcePhrases(markdown);
  if (sourceClean !== markdown) {
    markdown = sourceClean;
    applied.push('来源罗列话术清理');
  }
  if (!isBodyTableForbidden(session.bidComposition)) {
    const titleRecovery = recoverTitlelessTableTitlesFromDrafts(markdown, session.finalChapterDrafts.map(chapter => chapter.content || ''));
    const captionChain = normalizeFigureNumbering(normalizeTableNumbering(injectTableCaptions(titleRecovery.markdown)));
    if (captionChain !== markdown) {
      markdown = captionChain;
      applied.push(titleRecovery.recovered > 0 ? `表格题名回填 ${titleRecovery.recovered} 张` : '表格题注编号链收口');
    }
  }
  if (applied.length === 0) return;
  session.finalMarkdown = markdown;
  await session.recomputeFinalValidationBundle();
  const stage = displayStage({ type: 'validation', roleId: 'surface-punctuation-closure', status: 'success', message: `链尾表面终局收口：${applied.join('；')}` }, { subtitle: '评审后兜底' });
  upsertProgressStage(session.progressStages, stage);
  upsertProgressStage(session.finalGateRepairStages, stage);
}
