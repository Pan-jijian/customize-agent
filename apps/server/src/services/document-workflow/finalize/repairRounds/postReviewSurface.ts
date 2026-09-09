/**
 * repairRounds/postReviewSurface：评审后兜底链（FINALIZE_REPAIR_ROUNDS: planned-section-final / commercial-strip /
 * table-deterministic-repair / post-review-surface / terminology-strip / toc-consistency）。
 * P2 拆分（方案 5.2）：由 finalizeGeneration 代码块机械搬迁而来，业务语义逐字一致（行为保持）。
 */
import { stripCommercialDataBodyLines, fixTocFromBody, runDeterministicChainUntilConverged } from '../../documentIntegrityChecks';
import { repairTableBlocksInMarkdownDeterministically } from '../../tableRepairHelpers';
import { stripInternalTerminologySentences } from '../../internalTerminologyAnchors';
import { enforcePlannedSectionCompleteness } from '../../globalQualityGates';
import { SURFACE_FIX_STEPS } from '../../deterministicFixChains';
import type { FinalizeSession } from '../finalizeSession';

export async function stagePostReviewSurface(session: FinalizeSession): Promise<void> {
  // 缺节/空小节补写终兜底（丰乐镇第 2 轮实测）：全维度评审轮 patch 重写章节可能删除规划小节
  // （工程概况-项目管理组织机构与职责、施工总平面布置图-施工总平面布置原则与分区管理/
  // 竣工清理验收移交与保修 3 处缺节），生成期 enforcePlannedSectionCompleteness 早于评审轮覆盖不到；
  // 交付前对最终成稿再跑一次补写收口（缺节与纯表格空小节同口径，单轮失败即放弃，残留转门禁）
  const plannedSectionFixFinal = await enforcePlannedSectionCompleteness({
    chapterDraftsFinal: session.finalChapterDrafts, template: session.template, repairPromptTexts: session.repairPromptTexts,
    requirement: session.requirement, signal: session.signal, generationDiagnostics: session.generationDiagnostics, progressStages: session.progressStages, emitProgress: session.emitProgress, withProgressHeartbeat: session.withProgressHeartbeat,
  });
  if (plannedSectionFixFinal.plannedSectionFixApplied) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  // 4.17.8 交付前最终修复轮整体删除：其 12 类检测器与 blocker 修复循环 code map 全覆盖（检测侧单源），
  // 轮末重审/升级重试均属修复主力军化冗余——每缺陷 blocker 轮单次修复后失败即放弃，
  // 残留问题由导出门禁报告（不再进入 LLM 修复）；交付前确定性清洗（商务句/表格空单元格/数值定点）保留在下方。
  // 商务条款数据交付前兜底清洗（round-18 E9）：blocker 修复循环结束后的 LLM patch（全维度评审轮修复等）
  // 可能引入商务句（暂列金额/综合单价等，徽光阁实测“暂列金额60万元计入其他项目清单”在修复循环后进入正文），
  // 门禁已升级硬阻断（CRITICAL_BLOCK_RE 含“商务条款”）；交付前用与检测器同口径的行级安全清洗兜底
  // （标题行/表格行不触碰，仅删含商务词的正文句），清洗后重算校验组再判定最终门禁
  const cleanedCommercialMarkdown = stripCommercialDataBodyLines(session.finalMarkdown);
  if (cleanedCommercialMarkdown !== session.finalMarkdown) {
    session.finalMarkdown = cleanedCommercialMarkdown;
    await session.recomputeFinalValidationBundle();
  }
  // 表格空单元格交付前确定性修复（round-19 R5）：表格专轮之后的 LLM patch（全维度评审轮修复）可能重写表格
  // 引入空单元格（徽光阁实测危险源辨识表“高处作业坠落”行末两列空且最终校验持续报 error），
  // 交付前逐块做与专轮兜底同口径的确定性修复（合计行空填“—”、全空列删列、零星空单元格删行）。
  // 注意：removed 只统计删除块数，合计行填“—”类修复不计入，须按 markdown 变化判断是否重算
  const repairedTableMarkdown = repairTableBlocksInMarkdownDeterministically(session.finalMarkdown);
  if (repairedTableMarkdown.markdown !== session.finalMarkdown) {
    session.finalMarkdown = repairedTableMarkdown.markdown;
    await session.recomputeFinalValidationBundle();
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
  }
  // 内部术语句子确定性删除兜底（round-19 R3 已实现未接线，丰乐镇第 2 轮实测：
  // 「落位」「控制口径」「峰值口径」「数据口径」经 LLM 修复轮仍残留 4 词，检测器报 error blocker；
  // 交付前接入与检测器同源同阈值的整句删除（L1 精确词 + L3 语义锚点，标题/表格/目录行豁免），
  // 删除后重算校验组，旧 issue 快照由 recompute 内部口径剔除）
  const strippedTerminologyMarkdown = await stripInternalTerminologySentences(session.finalMarkdown);
  if (strippedTerminologyMarkdown !== session.finalMarkdown) {
    session.finalMarkdown = strippedTerminologyMarkdown;
    await session.recomputeFinalValidationBundle();
  }
  // B2 目录与正文一致性兜底：目录按最终正文 H2/H3 实际结构重建（fixTocFromBody 无改动时零成本），
  // 修复后再重算校验组，保证交付门禁与评分基于目录一致的最终成稿
  const tocConsistencyFix = fixTocFromBody(session.finalMarkdown);
  if (tocConsistencyFix.fixedCount > 0) {
    session.finalMarkdown = tocConsistencyFix.markdown;
    await session.recomputeFinalValidationBundle();
  }
}
