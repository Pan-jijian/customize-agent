import type { DocumentDraftChapter, DocumentExecutionStage, GeneratedDocumentDraft } from './types';
import { selectEvidenceByBudget } from './evidence';
import { documentTextLength } from './budget';
import { buildDocumentProfileReport } from './documentProfiles';
import { buildSuspensionChecklist } from './suspensionChecklist';
import { DOCUMENT_WORKFLOW_VERSION } from './documentWorkflowVersion';
import { partialChapterStatus } from './documentGeneratorHelpers';
import { assertRegistryConsistency } from './detectorFixerRegistry';
import { createFinalizeSession, type FinalizeGenerationInput } from './finalize/finalizeSession';
import { stageRebuildFacts } from './finalize/rebuildFacts';
import { stageComposeFinal, stageRebuildAndRecompute, stageValidationPack } from './finalize/rebuildAndRecompute';

import { stageFactLanding } from './finalize/repairRounds/factLanding';
import { stageTableRepair } from './finalize/repairRounds/tableRepair';

import { stageSemanticChoice } from './finalize/repairRounds/semanticChoice';
import { stageDeterministicStage5 } from './finalize/repairRounds/deterministicStage5';
import { stagePostReviewSurface, runSurfaceDeterministicCleans, replayBlueprintCitationNumericFixes } from './finalize/repairRounds/postReviewSurface';
import { stageFactDistribution } from './finalize/repairRounds/factDistribution';
import { stageNumericVerification } from './finalize/repairRounds/numericVerification';
import { stageRequirementResponseRepair } from './finalize/repairRounds/requirementResponseRepair';
import { stageRequirementVerification } from './finalize/repairRounds/requirementVerification';
import { stageContentDepthRepair } from './finalize/repairRounds/contentDepthRepair';
import { stageFinalGate } from './finalize/finalGate';
import { stageHealthDiagnosis } from './finalize/healthDiagnosis';

export async function finalizeGeneration(p: FinalizeGenerationInput): Promise<GeneratedDocumentDraft> {
  // P23：注册表一致性检查（每次最终化前执行，开销 O(n) 字符串比对可忽略）——
  // 修复器锚定缺失/权威口径拉扯/llm-patch 缺 patchGuard 任一违反即抛错显性暴露，不静默降级
  assertRegistryConsistency();
  const {
    chapterDraftsByOrder, chapterGenerationStagesByOrder, chapterGenerationStages, effectiveChapters,
    input, hasExplicitOutline, failedChapterMessages,
  } = p;
  const { requirement } = input;

  // P2 拆分（方案 5.2）：跨阶段共享状态显式化为 FinalizeSession；各阶段仅消费/写回 session 字段
  const session = createFinalizeSession(p);

  const chapterDrafts = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
  session.chapterDrafts = chapterDrafts;
  chapterGenerationStages.push(...chapterGenerationStagesByOrder.filter((item): item is DocumentExecutionStage => Boolean(item)));
  if (chapterDrafts.length === 0) throw new Error(`章节生成未完成：${failedChapterMessages.join('；') || '没有生成任何有效章节'}`);
  if (hasExplicitOutline && chapterDrafts.length < effectiveChapters.length) throw new Error(`OUTLINE 指定 ${effectiveChapters.length} 章，实际只生成 ${chapterDrafts.length} 章：${failedChapterMessages.join('；') || '部分章节未生成'}`);

  await stageRebuildFacts(session);
  await stageValidationPack(session);
  stageComposeFinal(session);
  await stageRebuildAndRecompute(session);

  // P6：修复轮顺序由 FINALIZE_REPAIR_ROUNDS（detectorFixerRegistry）单源声明，下方线性链按声明顺序逐一对应：
  // fact-landing-round → table-repair-round → semantic-choice-conflict → deterministic-stage5 → formal-source-clean
  // → planned-section-final → commercial-strip → table-deterministic-repair
  // → numeric-verification → requirement-response-repair → requirement-verification → content-depth-repair → post-review-surface →
  // → terminology-strip → regulation-number-typo → quotation-balance-repair → basis-regulations-repair → toc-consistency
  // → fact-distribution-round
  //（顺序快照测试锁定；新增修复轮必须同时更新声明表）
  // 方案 2.3：全维度评审轮（qingtian-full-review）已删除——九维检出全部由注册表检测器/写作执行器覆盖
  // （含 S1 块级六类执行器），该轮历史实测检出 12 处/修复 0 处，无独有检出项
  await stageFactLanding(session);
  await stageTableRepair(session);
  // P2 拆分（方案 5.2）：语义矛盾检测轮/阶段5确定性清洗/评审后兜底链/门禁收口已提取至 finalize/。
  await stageSemanticChoice(session);
  await stageDeterministicStage5(session);
  // C2 正文数值 vs 资料原文确定性核对轮：零 LLM 确定性提取疑似无来源数值，未匹配项定向 LLM 修复（收敛修复：每章最多 2 轮，残留数下降才继续下一轮，未收敛残留以 warning 兜底）；
  // 置于评审后兜底链之后，核对覆盖全部修复轮成果，作为交付前数值兜底
  await stageNumericVerification(session);
  // 招标要求响应定向补写轮（r3 终门禁 50 项阻断归因）：章级验收 requirements-coverage blocker 此前无任何
  // 修复轮消费（40+ 项要求未响应直坠终门禁复核清单）——消费 blocker 按主责章（requirementAssignments）定向
  // 补写（收敛修复：每章最多 2 轮，残留数下降才继续下一轮；残留不转 warning，由终门禁照常复核）；
  // 位置必须早于 post-review-surface（其复读剥离覆盖本轮补写引入的重复句）
  await stageRequirementResponseRepair(session);
  // C3 生成后用户要求执行核验闭环：逐条核验 requirementSemantics 要求落实，未满足项定向补写（收敛修复：每章最多 2 轮，修复落地后复验，复验残留数下降才继续下一轮）
  await stageRequirementVerification(session);
  // r8 实机终门禁 18 项阻断归因（第二类系统性缺陷：修复链覆盖检测器集合 < 终检检测器集合）：六类内容
  // 深度 blocker（critical/emergency-section-depth、construction-org-major-content/division-section、
  // precise-fact-usage、overview-recap）此前无修复轮消费裸奔到终门禁——按 provenance + 章锚点
  // 定向补写（收敛修复：每章最多 2 轮，残留数下降才继续下一轮；外层 2 收敛周期）；
  // 位置必须早于 post-review-surface（其复读剥离/格式清洗覆盖本轮补写引入的残留）
  await stageContentDepthRepair(session);
  // 评审后兜底链后置（丰乐镇 doc-1788954795698 实测）：用户要求补写（LLM patch）会引入句级复读，
  // 本轮（SURFACE_FIX_STEPS round-2 链，含句级复读确定性剥离）必须在其之后执行才能覆盖补写引入的复读
  await stagePostReviewSurface(session);
  // R12 事实跨章扩散（链尾收口）：全部 LLM 补写轮之后、终门禁之前——对落位 0-1 章的高价值事实值
  // （建设地点/质量标准/合同估算价/项目编号/标段/招标范围），在语义相关章正文块尾追加自然引用句，
  // 补足跨 ≥2 章分布（方案针对性 distribution 归因：丰乐镇实测 0.087→修复后显著提升）
  await stageFactDistribution(session);
  // r14 链尾终局清洗重放（r13 实机归因）：stageFactDistribution 修改章 drafts 后的
  // rebuildFinalMarkdown 会从章 drafts 重拼成稿，把 postReviewSurface 第二遍重放之后的全部
  // 字符串级清洗（规格错位收口/内部术语替换/round-2 链：段落复读/骨架复读/工序形式回退）
  // 再次回退——r13 实机 gate 报 13 条阻断（踢脚线 15mm/落位/峰值口径/复读句均为 drafts 原样），
  // 与落盘 markdown 脏内容完全一致。gate 检测与落盘 markdown 同源（session.finalMarkdown），
  // 在最后一次净变更点之后、终门禁之前重放同口径清洗：无回退时各块自比对静默（幂等零成本），
  // 有回退时恢复修复后再 recompute，保证「终门禁所检 = 交付所存 = 清洗后成稿」
  await runSurfaceDeterministicCleans(session);
  // r15 链尾蓝图引用数值收口重放（r14 B1 实机归因）：citation-numeric-replay 在 postReviewSurface 内
  // 替换成功（阶段记录 1 处「金属扶手、栏杆、栏板 22m→224m」），但其后 stageFactDistribution 的
  // rebuildFinalMarkdown 从章 drafts 重拼成稿把替换回退，终态残留 22m 且 gate 报 B1——上一步
  // runSurfaceDeterministicCleans 重放不含 citation 块，此处补重放（同一判定+替换链，零锚/零处
  // 时零成本静默，幂等可重放；位置在最后一次净变更点之后、终门禁之前）
  await replayBlueprintCitationNumericFixes(session);
  await stageFinalGate(session);
  // P18 自动健康诊断：finalize 末尾纯读 telemetry 产出显性告警（零 LLM 成本），
  // 告警写回 telemetry.healthAlerts 随 reviewMetadata 归档（导出时进入 exportReports 历史对比存储）
  await stageHealthDiagnosis(session);
  const compactFinalChapterDrafts = session.finalChapterDrafts.map(chapter => ({ ...chapter, evidence: selectEvidenceByBudget(chapter.evidence || [], { preservePinned: true }) }));
  session.finalChapterDrafts = compactFinalChapterDrafts;

  return {
    templateId: session.template.id,
    templateName: session.template.name,
    title: session.template.outputTitle,
    requirement: requirement || '',
    projectRoot: session.projectRoot,
    projectId: session.projectId,
    exportSettings: session.template.exportSettings,
    generationSettings: session.template.generationSettings,
    facts: session.facts,
    structuredFacts: session.structuredFacts,
    factsModel: session.factsModel,
    chapters: compactFinalChapterDrafts,
    sources: session.sources,
    missingItems: [...new Set(session.missingItems)],
    validation: session.validation,
    validationIssues: session.validationIssues,
    exportGate: session.qualityBundle.finalExportGate,
    executionStages: session.finalStages,
    assets: session.assets,
    partialChapters: session.finalChapterDrafts.map(chapter => ({ id: chapter.id, title: chapter.title, chars: documentTextLength(chapter.content), status: partialChapterStatus(chapter, session.documentBudget.chapterTargets.get(chapter.id)), updatedAt: Date.now() })),
    checkpointChapters: compactFinalChapterDrafts,
    promptRules: session.promptDocumentRules,
    agentWorkflow: session.agentWorkflow,
    reviewMetadata: {
      chapterSummaries: [],
      globalIssues: [],
      diagnostics: session.generationDiagnostics,
      profile: buildDocumentProfileReport({ template: session.template, chapters: effectiveChapters, requirement }),
      knowledgeCoverage: session.qualityBundle.knowledgeCoverage,
      factTraces: session.qualityBundle.factTraces,
      chapterCoverage: session.qualityBundle.chapterCoverage,
      retrievalCoverage: session.retrievalCoverageReports,
      qualityReport: session.qualityBundle.qualityReport,
      repairStrategies: session.qualityBundle.repairStrategies,
      reviewChecklist: session.reviewChecklist,
      professionalScore: session.professionalScore,
      templatingReviewIssues: session.templatingReview.issues,
      /** V5 P5 无主数值审计报告（M6）：验收口径「0 未登记项」= unregisteredCount 为 0 */
      authorityAudit: session.authorityAuditReport,
      /** C1 复核清单（批 1）：finalGate 构建（门禁失败时）；兜底路径（session 未过 finalGate）按同一单源就地构建，保证归档与 warningIssues 置顶条同源 */
      suspensionChecklist: session.suspensionChecklist ?? (session.qualityBundle.finalExportGate.passed ? undefined : buildSuspensionChecklist(session.qualityBundle.finalExportGate.blockingIssues, session.finalChapterDrafts)),
      writingTaskBrief: session.writingTaskBrief,
      workflowVersion: DOCUMENT_WORKFLOW_VERSION,
      telemetry: session.telemetry,
    },
    generatedAt: Date.now(),
    markdown: session.finalMarkdown,
    // 标书编制规格快照落盘（导出层格式口径承接：页码页脚/封面/页数上限）
    bidComposition: session.bidComposition,
  };
}


