import type { DocumentDraftChapter, DocumentExecutionStage, GeneratedDocumentDraft } from './types';
import { selectEvidenceByBudget } from './evidence';
import { documentTextLength } from './budget';
import { displayStage, upsertProgressStage } from './progress';
import { applyFormatRulesToExportSettings } from './bidComposition';
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
import { stagePostReviewSurface, runSurfaceDeterministicCleans, replayBlueprintCitationNumericFixes, replayStage5FactsModelNumericFixes, replaySurfacePunctuationClosure } from './finalize/repairRounds/postReviewSurface';
import { backfillUsedNotDeclared } from './finalize/repairRounds/basisRegulationsCrossRepair';
import { stageFactDistribution } from './finalize/repairRounds/factDistribution';
import { stageNumericVerification } from './finalize/repairRounds/numericVerification';
import { replayRequirementTailClosure, stageRequirementResponseRepair } from './finalize/repairRounds/requirementResponseRepair';
import { stageRequirementVerification } from './finalize/repairRounds/requirementVerification';
import { stageContentDepthRepair } from './finalize/repairRounds/contentDepthRepair';
import { stageControlLoopRepair } from './finalize/repairRounds/controlLoopRepair';
import { stageProfessionalChainRepair } from './finalize/repairRounds/professionalChainRepair';
import { stageLengthCompressionRepair } from './finalize/repairRounds/lengthCompressionRepair';
import { stageTableCaptionRepair } from './finalize/repairRounds/tableCaptionRepair';
import { stageTableArithmeticRepair } from './finalize/repairRounds/tableArithmeticRepair';
import { stageEmptySectionSweep } from './finalize/repairRounds/emptySectionSweep';
import { stageSectionAlignmentSweep } from './finalize/repairRounds/sectionAlignmentSweep';
import { stageTemplatingSweep } from './finalize/repairRounds/templatingSweep';
import { stageDuplicateThemeMerge } from './finalize/repairRounds/duplicateThemeMerge';
import { stageDeliveryStructureClosure } from './finalize/repairRounds/deliveryStructureClosure';
import { stageSentencePatternSweep } from './finalize/repairRounds/sentencePatternSweep';
import { stageDuplicateSentenceCollapse } from './finalize/repairRounds/duplicateSentenceCollapse';
import { stageTemplatingTailReplay } from './finalize/repairRounds/templatingTailReplay';
import { stageFinalGate } from './finalize/finalGate';
import { stageHealthDiagnosis } from './finalize/healthDiagnosis';

/**
 * 交付前缺章判定：返回 null = 可继续 finalize 交付；返回字符串 = 中断原因。
 *
 * 只有「零章节」才是真正无可交付物（没有正文可组合）。**缺章不再致命**——章级失败已由
 * stageChapterLoop 的 catch 记录进 failedChapterMessages 并标记该章 failed，其余章节照常成稿；
 * finalize 内 rebuildAndRecompute 的 missingChapterCount 会把「部分章节生成失败：N 章」升级为
 * blocker，经终门禁复核清单（buildSuspensionChecklist）呈现，文档状态 completed_with_issues
 * ——可查看/可导出/可基于 checkpoint 续修（4.50「交付与修复解耦」口径）。
 *
 * 历史缺陷：此处曾对「显式大纲缺章」（hasExplicitOutline && 缺章）直接抛错，把已完成的其他章节
 * 连同 finalize 全部修复轮与导出门禁一起作废——本机历史实测 21 次中断（8 次「规划块全部失败」
 * + 13 次「大模型未返回有效正文」）；且同一缺章在模板大纲下可交付、在显式大纲下却整篇失败，
 * 口径自相矛盾。缺章的信息量已由 blocker 精确表达，不需要用「整篇作废」再表达一次。
 */
export function missingChapterAbortReason(input: { chapterDraftCount: number; failedChapterMessages: string[] }): string | null {
  if (input.chapterDraftCount === 0) {
    return `章节生成未完成：${input.failedChapterMessages.join('；') || '没有生成任何有效章节'}`;
  }
  return null;
}

export async function finalizeGeneration(p: FinalizeGenerationInput): Promise<GeneratedDocumentDraft> {
  // P23：注册表一致性检查（每次最终化前执行，开销 O(n) 字符串比对可忽略）——
  // 修复器锚定缺失/权威口径拉扯/llm-patch 缺 patchGuard 任一违反即抛错显性暴露，不静默降级
  assertRegistryConsistency();
  const {
    chapterDraftsByOrder, chapterGenerationStagesByOrder, chapterGenerationStages, effectiveChapters,
    input, failedChapterMessages,
  } = p;
  const { requirement } = input;

  // P2 拆分（方案 5.2）：跨阶段共享状态显式化为 FinalizeSession；各阶段仅消费/写回 session 字段
  const session = createFinalizeSession(p);

  const chapterDrafts = chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
  session.chapterDrafts = chapterDrafts;
  chapterGenerationStages.push(...chapterGenerationStagesByOrder.filter((item): item is DocumentExecutionStage => Boolean(item)));
  const abortReason = missingChapterAbortReason({ chapterDraftCount: chapterDrafts.length, failedChapterMessages });
  if (abortReason) throw new Error(abortReason);

  await stageRebuildFacts(session);
  await stageValidationPack(session);
  stageComposeFinal(session);
  await stageRebuildAndRecompute(session);

  // P6：修复轮顺序由 FINALIZE_REPAIR_ROUNDS（detectorFixerRegistry）单源声明，下方线性链按声明顺序逐一对应：
  // fact-landing-round → table-repair-round → semantic-choice-conflict → deterministic-stage5 → formal-source-clean
  // → planned-section-final → commercial-strip → table-deterministic-repair → numeric-verification
  // → requirement-response-repair → requirement-verification → content-depth-repair → control-loop-repair → professional-chain-repair
  // → post-review-surface → terminology-strip → regulation-number-typo → quotation-balance-repair
  // → basis-regulations-repair → basis-regulations-cross-repair → dangerous-applicability-repair → auto-spec-gate-repair → toc-consistency → length-compression-repair → fact-distribution-round
  // → table-caption-repair → table-arithmetic-repair → empty-section-sweep → section-alignment-sweep → templating-sweep → duplicate-theme-merge → delivery-structure-closure → sentence-pattern-sweep → duplicate-sentence-collapse → templating-tail-replay
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
  // D-T2 评审关注闭环链补写轮（B8 前半根治）：质量三检/进度纠偏/工资代发链“主责章全要素”判定
  //（construction-org-control-loop warning 带 chapterId+provenance）此前无修复轮消费（r28f #27-29
  // 残留）——章级实时重算定位 → LLM 定向补写缺失环节（标准词面落位）→ 复检缺失数；同族补写轮，
  // 位置与 content-depth-repair 相同约束：早于 post-review-surface（其复读剥离覆盖补写残留）
  await stageControlLoopRepair(session);
  // D-T9 工序链与项目属性适配修复轮（r28f #30/#31 根治）：construction-org-professional-chain warning
  //（检测端节级 mixed + 文档级 insufficient 判定，带 chapterId+provenance）此前无修复轮消费——章级
  // 实时重算定位 → LLM 定向改写错位工序/补写缺失链环节（标准工序名落位）→ 复检缺陷数；同族补写轮，
  // 位置与 content-depth-repair 相同约束：早于 post-review-surface（其复读剥离覆盖补写残留）
  await stageProfessionalChainRepair(session);
  // 评审后兜底链后置（丰乐镇 doc-1788954795698 实测）：用户要求补写（LLM patch）会引入句级复读，
  // 本轮（SURFACE_FIX_STEPS round-2 链，含句级复读确定性剥离）必须在其之后执行才能覆盖补写引入的复读
  await stagePostReviewSurface(session);
  // D-T3 成稿篇幅压缩轮（B8 后半根治）：成稿字数超出目标 20%（document-budget「明显超出」warning）
  // 此前无修复轮消费，超产直坠交付（验收线「目标 ±20% 内」）——章级超额定位（chapterTargets 单源）
  // + LLM 合并重复段落，信息守恒守卫（字数须降，且标题/数值不得缺失、表格行数不得减少，任一违反即回滚）；
  // 本阶段 draft-mutating + rebuild，必须位于全部 LLM 补写轮之后（post-review-surface 尾部 toc-consistency
  // 收口之后）、fact-distribution 扩散轮之前（扩散轮基准取压缩后正文）
  await stageLengthCompressionRepair(session);
  // R12 事实跨章扩散（链尾收口）：全部 LLM 补写轮之后、终门禁之前——对落位 0-1 章的高价值事实值
  // （建设地点/质量标准/合同估算价/项目编号/标段/招标范围），在语义相关章正文块尾追加自然引用句，
  // 补足跨 ≥2 章分布（方案针对性 distribution 归因：丰乐镇实测 0.087→修复后显著提升）
  await stageFactDistribution(session);
  // r24 B8 正文表格题名补全轮（实机归因）：终检 table-caption 按「表上方 8 行内可提取表名」判定，无题名
  // 形态表格（探测 kind='none'）无可注入对象直坠终门禁——确定性补名（章内无题表 × 本章计划表表头字段
  // 对账）+ LLM 补名（残留无题表章级定向）写回章 drafts；本阶段 draft-mutating + rebuild，必须位于
  // stageFactDistribution 之后（其 rebuild 会回退此前 markdown-only 修改）、链尾 markdown-only 重放之前
  await stageTableCaptionRepair(session);
  // C-T3 表内算术自洽修复轮（C4 归因）：终检 table-arithmetic-consistency 消费含显性合计标记表格的
  // 「分项和=合计」不自洽 —— 章级同源重扫 + LLM 定向修正表内数值（收敛修复：每章最多 2 轮，
  // 残留处数下降才继续）；本阶段 draft-mutating + rebuild，必须位于 table-caption-repair 之后、
  // 链尾 markdown-only 重放之前（本轮 rebuild 不得回退链尾重放成果）
  await stageTableArithmeticRepair(session);
  // D-T3 无依据空壳小节链尾清扫（r28f 终检「空小节」blocker 归因）：补写轮（enforcePlannedSectionCompleteness）
  // 把空壳 H4 的正文搬往规划名小节后无规划归属的空壳标题行残留直坠终门禁——确定性整行移除
  // （emptyUnplannedSectionSpans 与终检同判定链）+ 章内编号原子重放（renumberSectionHeadings 章片段模式）；
  // 本阶段 draft-mutating + rebuild，必须位于 table-arithmetic-repair 之后（链尾最后 draft-mutating）、
  // 链尾 markdown-only 重放之前（本轮 rebuild 不得回退链尾重放成果）
  await stageEmptySectionSweep(session);
  // D-T6 ② 小节结构对齐链尾重放（r28f 门禁 #2 归因：「漂移+补写并存」形态成稿 5 节 vs 规划
  // 4 节直坠门禁）：postReviewSurface 内的近名合并/漂移改名位于缺节补写之前，其后各
  // draft-mutating 轮 rebuild 与历史形态到链尾无第二次收口点——近名成对合并 + 单行漂移改名
  // （mergeNearDuplicateSectionHeadings）+ 非近名规划外 H3 降 H4（reconcileUnplannedSectionHeadings，
  //（与 sectionCountOverflowIssues 同源判定），确定性零 LLM；本阶段 draft-mutating + rebuild，
  // 链尾最后 draft-mutating 位置（empty-section-sweep 之后）、链尾 markdown-only 重放之前
  await stageSectionAlignmentSweep(session);
  // D-T7 ① 模板化清理链尾重放（r28f #35 归因）：零信息前缀句确定性删除（templatePrefixTargets +
  // stripZeroInfoSloganSentences，与 repairTemplatingIssues 同源判定）+ 逐章段落完全重复去重
  //（stripDuplicateParagraphs 重放）；本阶段 draft-mutating + rebuild，位于 section-alignment-sweep
  // 之后、duplicate-theme-merge 之前（链尾 markdown-only 重放之前）
  await stageTemplatingSweep(session);
  // D-T7 ② 重复主题小节合并（r28f #36/#37 归因）：同桶规划小节 ≥2 且正文均有 H3 落位时确定性
  // 合并（保留首现、后续标题行摘除正文并入、规划数组同步、章内编号原子重放）；本阶段
  // draft-mutating + rebuild，位于 templating-sweep 之后、delivery-structure-closure（目录按
  // 合并后正文结构重建）之前
  await stageDuplicateThemeMerge(session);
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
  // M24c 链尾事实口径数值收口重放二次调用（961.42 回归定案）：stage5 scale/spec/cost 定点修复只写
  // finalMarkdown，stageFactDistribution 等 draft-mutating 轮的 rebuildFinalMarkdown 会把替换回退——
  // 与 citation replay 同范式在最后一次净变更点之后、终门禁之前重放（终门禁所检 = 交付所存）
  await replayStage5FactsModelNumericFixes(session);
  // r24 B1-B5 链尾要求响应收口重放（实机归因）：需求响应终局收口是 markdown-only 插入不写章草稿，
  // 其后 stageFactDistribution 的 rebuildFinalMarkdown 从章 drafts 重拼成稿把插入全部回退——r23 实测
  // 「一级建造师」等 5 条补写阶段记录 success 而终稿零踪迹、终检重新检出直坠终门禁；在最后一次净变更
  // 点之后、终门禁之前重放（同 runSurfaceDeterministicCleans / replayBlueprintCitationNumericFixes 范式）
  await replayRequirementTailClosure(session);
  // D-T6 ①③ 交付结构收口（r28f 门禁 #1「目录 29 节 vs 正文 28 节」与 warningIssues 长段归因）：
  // ①目录按正文实际 H2/H3 结构重建（fixTocFromBody——其后各 draft-mutating 轮 rebuild 均可改变
  // 正文 H3 结构）；③>380 字符超长段落链尾切分（splitOverlengthBodyParagraphs）。两操作均为
  // markdown-only 收口，位于最后净变更点（前序 markdown-only 重放）之后、终门禁之前——
  // 终门禁所检 = 交付所存 = 收口后成稿
  await stageDeliveryStructureClosure(session);
  // C8 S3 句模复读链尾收口（F 通道：修复链覆盖断层归因——句模修复仅写作期 stage 60，finalize 链
  // 无重放；tail closure 等 markdown-only 插入物晚于全部 draft-mutating 轮，templating-sweep 扫章
  // drafts 看不到插入物 → 写作期残留 7/13/36 处至终稿反增 13/14/46 处）：链尾确定性剥离
  //「施工按以下顺序组织：」类宣告引导句（stripSentencePatternAnnouncements，与检测端
  // form-announcement 族单源判定——列表自承载全部信息，引导语删除无损）；残余承载式句由密度
  // 命中线 sentencePatternThreshold（检测/修复目标/评分/复检四端单源）放行，超线残差仍由终检
  // blocker 复核。markdown-only，位于 delivery-structure-closure 之后、标点终局收口之前——
  // 终门禁所检 = 交付所存 = 收口后成稿
  await stageSentencePatternSweep(session);
  // C8 S5 U 通道句级复读坍塌链尾收口（uniqueness 0.59 第一约束归因：重复句 excess 主体为
  //「上述/相关/有关＋泛对象词」泛化归口句复读与同章完全复读，句模链路覆盖不到）：完全重复句
  // 保首次删后续（同章复读一律坍塌、跨章复读仅首现句命中泛化归口帧者坍塌，跨章业务句保留），
  // 与 uniqueness 评分单源消费 duplicateSentenceOccurrences；markdown-only，位于
  // sentence-pattern-sweep 之后、标点终局收口之前——终门禁所检 = 交付所存 = 收口后成稿
  await stageDuplicateSentenceCollapse(session);
  // C8 S6 A' 对象错位通道（templating-sweep 扫章 drafts 而 markdown-only 插入物只写 finalMarkdown：
  // s28m' 实测插入物 6 探针 drafts 全 false / markdown 全 true——stage「无重复段落残留」为 drafts
  // 视角假通过；且链尾各 markdown-only 轮删句后可能新生重复段）：链尾 markdown 版 templating 重放
  //——finalMarkdown 按 `## ` 行级切章构造伪 chapters，复用 templating-sweep 同源三函数
  //（templatePrefixTargets → stripZeroInfoSloganSentences + 逐章 stripDuplicateParagraphs）。
  // markdown-only，位于 duplicate-sentence-collapse 之后、标点终局收口之前——
  // 终门禁所检 = 交付所存 = 收口后成稿
  await stageTemplatingTailReplay(session);
  // r28h 链尾标点终局收口（r28h2/s28h2 实机归因）：交付结构收口（超长段落切分）与前序链尾
  // 追加块（补写/删除类）仍可能带回标点叠用残留（「。。」句段拼接、「、、」并列删除），
  // round-2 链无二次消费点直坠终门禁——同源修复器在终门禁前最后收口（终门禁所检 = 交付所存）
  await replaySurfacePunctuationClosure(session);
  // 链尾编制依据回补（确定性，零 LLM）：正文引用但未列入编制依据小节的标准，按编号族补入编制依据。
  // 此处是**真正的链尾**——其后无任何改写正文的轮次，故轮次中途新增的引用（链尾要求收口的补写会带入
  // 新的《》引用）才有收口点。实测巢湖：链路中段的 basis-regulations-cross-repair 报「未记录」，
  // 而终检报 13 处「引用未声明」，即轮次之后新增的引用无人收口。
  {
    const basisBackfill = backfillUsedNotDeclared(session);
    // 4.55.22：**不再** rebuildFinalMarkdown（见 backfillUsedNotDeclared 的注释）——
    // 那是全流程最后一次从章草稿重拼全文，会静默回退其前的九个 markdown-only 链尾轮
    //（现行口径落地/要求响应补写/句级复读坍塌/标点收口…），而本分支原先不产阶段事件，
    // 交付记录仍声称那些修复生效。现改为直接写回 markdown（markdown-only），并**补产阶段事件**。
    if (basisBackfill.inserted > 0 && basisBackfill.markdown) {
      session.finalMarkdown = basisBackfill.markdown;
      await session.recomputeFinalValidationBundle();
      const message = `链尾编制依据回补：${basisBackfill.inserted} 条引用未声明的标准补入编制依据小节（${basisBackfill.labels.slice(0, 6).join('、')}）`;
      session.generationDiagnostics.llm.lastInfo = message;
      upsertProgressStage(session.finalGateRepairStages, displayStage({
        type: 'reference',
        roleId: 'basis-regulations-tail-backfill',
        status: 'success',
        message,
        details: basisBackfill.labels.slice(0, 12),
      }, { subtitle: '链尾编制依据回补' }));
    }
  }
  await stageFinalGate(session);
  // P18 自动健康诊断：finalize 末尾纯读 telemetry 产出显性告警（零 LLM 成本），
  // 告警写回 telemetry.healthAlerts 随 reviewMetadata 归档（导出时进入 exportReports 历史对比存储）
  await stageHealthDiagnosis(session);
  const compactFinalChapterDrafts = session.finalChapterDrafts.map(chapter => ({ ...chapter, evidence: selectEvidenceByBudget(chapter.evidence || [], { preservePinned: true }) }));
  session.finalChapterDrafts = compactFinalChapterDrafts;

  // 4.55.22：招标规定的排版并入导出设置（招标优先于模板）——formatRules 此前只用于进度展示，
  // 招标强制的字体/字号/行距/装订线/页数上限**从未落到导出物**上（暗标格式分项直接失分）。
  const exportSettingsMerged = applyFormatRulesToExportSettings(session.template.exportSettings, session.bidComposition?.formatRules);
  if (exportSettingsMerged.applied.length > 0) {
    // 4.55.24 落点修正：finalStages 已在 stageFinalGate（finalGate.ts:42 = executionStages 快照 + 修复轮双写）
    // 组装完毕，本行返回/落库用的是 session.finalStages → 原推 executionStages 永远进不去交付记录。
    upsertProgressStage(session.finalStages, displayStage({
      type: 'reference',
      roleId: 'tender-format-applied',
      status: 'success',
      message: `招标规定排版已应用（${exportSettingsMerged.applied.length} 项）：${exportSettingsMerged.applied.slice(0, 5).join('、')}`,
      details: [
        '来源：招标文件「格式要求」条款（正文/标题字体、字号、行距、装订线、页数上限）',
        '优先级：招标规定 > 模板导出设置（前者为强制要求）',
        ...exportSettingsMerged.applied,
      ],
    }, { subtitle: '招标排版应用' }));
  }
  return {
    templateId: session.template.id,
    templateName: session.template.name,
    title: session.template.outputTitle,
    requirement: requirement || '',
    projectRoot: session.projectRoot,
    projectId: session.projectId,
    exportSettings: exportSettingsMerged.settings,
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


