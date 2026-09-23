/**
 * stageChapterLoop：阶段 4 —— 章节循环（证据→深召回→三路成稿→收口）。
 * P1 六阶段拆分（方案 5.1）：由 documentGenerator.generateDocumentDraft 阶段 4 代码块机械搬迁而来，
 * 变量读写经 session 子对象显式化，业务生成语义与原巨型函数逐字一致（行为保持）。
 */
import type { KbSearchResult } from '@/lib/api';
import type { DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage } from '../types';
import type { GenerationSession } from './generationSession';
import { displayChapterTitle } from '../outline';
import { evidenceMatchesFact } from '../factMatching';
import { documentTextLength, resolveChapterBudgetTarget } from '../budget';
import { sectionContentIntegrityIssues } from '../qualityValidation';
import { chapterCriteriaText } from '../constructionBidStructure';
import { buildSemanticSimilarity } from '../semanticSimilarity';
import { evidenceSafetyKey } from '../evidenceContentSafety';
import { normalizeChapterTitleLine, renderChapterRequirementSlice, renderChapterStructureSlice } from '../tenderRequirements';
import { buildChapterFactNeeds, factNeedsCoveragePrompt, factsForChapterNeeds, resolveChapterFactNeeds } from '../factsModel';
import { QUANTIFIED_FACT_RE } from '../parameterPatterns';
import { chapterSectionFactUsageIssues } from '../chapterReview';
import { retrieveWebEvidence } from '../webResearchService';
import { buildChapterReadinessPlan } from '../chapterReadiness';
import { buildCrossChapterDutyDeclaration } from '../chapterDutyDeclaration';
import { buildWriteTimeFixedBlocks, chapterFocusRule, WRITING_INTEGRITY_CONSTRAINTS } from '../documentWritingTaskBrief';
import { extractHazardBindings, renderHazardBindingBlock } from '../hazardBinding';
import { renderClarificationConstraintBlock } from '../clarificationOverrides';
import { assignClarificationAmendmentChapters, clarificationEvidenceBoost, clarificationSourceTexts, extractClarificationAmendmentLedger, renderClarificationAmendmentBlock } from '../clarificationAmendments';
import { chapterTaskPromptForPlannedStructure, planChapterTask } from '../agentPlanner';
import { throttleAgentWorkflowNodes } from '../agentWorkflow';
import { governEvidenceValues, renderScopeOverrideAnchors } from '../factGovernance';
import { applyOverridesToRetrieved } from '../valueOverride';
import { alignSectionHeadingsToPlan, runWithAdaptiveConcurrency, stableHash, throwIfAborted } from '../utils';
import { displayStage, elapsedMessage, upsertProgressStage } from '../progress';
import { measureGenerationStep } from '../rolePipeline';
import { buildRetrievalCoverageReport, resolveRolePoolRisk, retrieveDeepChapterEvidence, shouldTriggerDeepRetrieval } from '../documentEvidenceRetrieval';
import { buildBillFactLockQueries, buildBillResponsibilityMap, renderBillChapterTaskLines, renderBillFactLockText } from '../billFactLock';
import { renderDrawingFactLockText } from '../drawingFactLock';
import { renderChapterParameterLines } from '../chapterParameterFacts';
import { extractBoqDivisionCoverage, formatBoqDivisionCoverage } from '../documentFactTrace';
import { retrievePlannedMaterialEvidence, sampleProjectMaterialEvidence } from '../projectMaterialProfile';
import { assessChapterBlockDegradation, attachChapterBlockDegradation, buildChapterFactCoverageContext, buildPlannedChapterContent, capFactCoverageContext, chapterDegradationStageText, evidenceForSection, salvageChapterByOverProduceAcceptance } from '../chapterGeneration';
import { isBodyFigureForbidden, isBodyTableForbidden } from '../bidComposition';
import type { ChapterBlockDegradation, PlannedChapterContentInput, PlannedChapterContentResult } from '../chapterGeneration';
import { blockDeliveryOutcomeStatus } from '../finalize/repairRounds/repairOutcome';
import { chapterCompletionStatus, chapterGenerationTargets, compactChapterQueries, finalizeChapterContentQuality, optimizeChapterEvidence, preselectSemanticCandidates, resolveChapterPromptExecution, retrieveSectionEvidence, semanticEvidenceText, stripBidDisciplineSentencesSemantic } from '../documentGeneratorHelpers';
import { alignChapterContentToBlueprint, blueprintDataForChapterInjection, fillAuthorityPlaceholders, buildChapterStructureFromBlueprint, chapterBlueprintAuthoritiesNeeded, chapterBlueprintAuthorityGaps, findBlueprintChapter, renderBlueprintMustCiteValues } from '../integratedBlueprint';
import type { BlueprintAuthorityId, PlannedChapterStructure } from '../integratedBlueprint';
import { blueprintPhaseLaborAuthorities } from '../authorityIndex';
import { fixPhaseLaborValues } from '../documentIntegrityChecks';
import { governChapterBlockNames } from '../sectionNamingGovernance';
import { loadFingerprintPool } from '../sectionFingerprint';
import { extractGeneratedSections } from '../markdownComposer';
// 扬尘六个百分百条目名/豁免句单源：与检测侧（sixHundredPercentCoverageIssues）同源，防止写作指令与检测判定分裂
import { SIX_HUNDRED_PERCENT_DEMOLITION_EXEMPT_SENTENCE, SIX_HUNDRED_PERCENT_DEMOLITION_ITEM, SIX_HUNDRED_PERCENT_ITEMS } from '../integrity/detectors/detectors';

export async function stageChapterLoop(session: GenerationSession): Promise<void> {
  // 4.2 阶段瀑布：规划期收口 → 成稿期起点（成稿主循环含章级审查修复流水线重叠，合并记 phase:draft）
  session.planning.generationDiagnostics.metrics.push({ name: 'phase:plan', startedAt: session.planning.planPhaseStartedAt, endedAt: Date.now(), durationMs: Date.now() - session.planning.planPhaseStartedAt });
  session.chapterLoop.draftPhaseStartedAt = Date.now();
  // C-T5 行级任务清单（每行→责任章→写作证据位）：清单锁按章分配责任行，写作注入与未落位修复定位同源；
  // 全章循环只构建一次（条目×章打分一次完成，避免每章重复计算）
  const billResponsibility = buildBillResponsibilityMap(session.blueprint.billFactLock, session.planning.effectiveChapters);
  // 危大判定（写作前定死）：从清单实测参数抽「本项目参数 × 规范阈值 → 结论」，全章循环只算一次。
  // 基线实测缺陷：正文把规范阈值当本项目参数写（「开挖深度超过3m」「搭设高度超过24m」），
  // 与清单实测（挖土深度 1.0/1.5m 内、脚手架搭设高度 18.05m 以内）直接矛盾。
  const hazardBindings = extractHazardBindings(
    session.understanding.writerEvidence,
    { 基坑开挖深度: session.understanding.canonicalFacts?.byKey?.['excavation_depth']?.value },
  );
  // 4.55.36 批次 2：答疑技术性修正账本（非单值口径：改为/取消/不涉及/按…执行）。
  // 为什么在写作侧抽而不是检测侧各抽一份：
  //   ① 抽取必须在**有序全文**上做（碎片证据池按分数排序，「最近邻配对」实测正确率不足半数，配错对象比不抽更糟），
  //      有序全文只有理解期的 getCachedFileDetail 缓存可取；
  //   ② 章级循环是 Promise.all 并发批次，惰性 memo 会竞态 —— 在并发之前一次抽完；
  //   ③ 账本同时是写作注入与终检检测的**唯一输入**（session.planning.clarificationAmendments 随会话下传），
  //      杜绝「写手被告知的账本」与「检测器比对的账本」两份漂移（4.55.22 两个单一真值源的教训）。
  // 实测缺陷（巢湖补疑 11,115 字 / 54 问答）：文件已入库且被召回（草稿证据池出现 1483 次），
  // 但「雨水口连接管混凝土满包 / 304 不锈钢防滑条 30*1.5mm / 以围墙为分界线（一期已完成）」
  // 三类技术性修正终稿零落位——答疑短答与任何章节主题都无强相关，永远进不了检索窗口；
  // 值级覆盖链只覆盖合同金额/工期等单值口径，技术性修正此前无通道。
  const clarificationAmendmentLedger = extractClarificationAmendmentLedger({
    texts: clarificationSourceTexts(
      [...session.understanding.availableEvidenceScopePaths, ...session.prepare.materialFilePaths],
      filePath => session.understanding.getCachedFileDetail(filePath),
    ),
  });
  const clarificationAmendments = assignClarificationAmendmentChapters(
    clarificationAmendmentLedger.amendments,
    session.planning.effectiveChapters,
  );
  if (clarificationAmendmentLedger.sourceCount > 0 || clarificationAmendments.length > 0) {
    session.planning.clarificationAmendments = { ...clarificationAmendmentLedger, amendments: clarificationAmendments };
    // 缺口不静默（2-2 与验收「never silent」）：未解析短答 / 未覆盖平铺技术陈述逐条入日志，
    // 抽取失败（如无问答结构的平铺条款）必须可被人工复核，而不是悄悄消失
    const chaptered = clarificationAmendments.filter(item => item.chapterTitle).length;
    console.warn(`[clarification] 答疑技术性修正账本：${clarificationAmendments.length} 条（按章归属 ${chaptered} / 全文适用 ${clarificationAmendments.length - chaptered}），源 ${clarificationAmendmentLedger.sourceCount} 份、问答对 ${clarificationAmendmentLedger.pairCount}；缺口：未解析短答 ${clarificationAmendmentLedger.unparsedAnswers.length} 条、未覆盖平铺技术陈述 ${clarificationAmendmentLedger.uncoveredStatements.count} 条`);
    for (const gap of clarificationAmendmentLedger.unparsedAnswers.slice(0, 5)) console.warn(`[clarification] 未解析答句（人工复核）：Q「${gap.question}」→ A「${gap.answer}」`);
    for (const gap of clarificationAmendmentLedger.uncoveredStatements.samples.slice(0, 5)) console.warn(`[clarification] 未覆盖平铺陈述（无问答结构，判据不抽）：${gap.text}`);
  }
  // 载体档加权（2-5 变更优先）：答疑/补疑切片在章证据排序中加权（与证据排序同口径，见 evidenceRetrieval）
  const carrierBoost = (filePath: string) => clarificationEvidenceBoost(filePath);
  for (let chapterOffset = 0; chapterOffset < session.planning.effectiveChapters.length; chapterOffset += session.blueprint.chapterConcurrency) {
    const chapterBatch = session.planning.effectiveChapters.slice(chapterOffset, chapterOffset + session.blueprint.chapterConcurrency);
    const batchTasks = await Promise.all(chapterBatch.map(async (chapter, batchIndex): Promise<(() => Promise<void>) | undefined> => {
    const chapterOrder = chapterOffset + batchIndex;
    throwIfAborted(session.global.input.signal);
    // 召回覆盖风险兑底（4.22.0 修复）：阶段 1 写入失败/未执行时不再让章节生成崩溃，
    // 按零风险兑底（高风控开关关闭、深召回仍由 missingFacts/requiredMissingNeeds 触发）
    const rolePoolRisk = resolveRolePoolRisk(session.understanding.rolePoolRisk);
    // P14 蓝图分层权威阻断（源头治理）：蓝图构建失败/校验未通过时全文参数桶不注入，
    // 数值密集型章（劳动力/资源/进度）按「本章所需权威任一不可用」判定阻断（替代整体二元 passed）——
    // 部分校验失败（如覆盖校验）不再连坐权威未受损的章节；仍拒绝「按证据独立成稿」静默产出自编数值
    //（劳动力 625/42 三套口径的历史根因）
    const blueprintGaps = session.blueprint.blueprintActive
      ? { missing: [] as BlueprintAuthorityId[], failedChecks: [] as string[] }
      : chapterBlueprintAuthorityGaps(chapter.title, session.blueprint.integratedBlueprint?.validation, session.planning.chapterIntentClassifier);
    if (blueprintGaps.missing.length > 0) {
      const failedCheckText = blueprintGaps.failedChecks.length > 0 ? `蓝图校验项「${blueprintGaps.failedChecks.join('、')}」未通过` : '蓝图校验未通过或构建异常';
      const blockMessage = `${displayChapterTitle(chapter.title)} 依赖蓝图权威 [${blueprintGaps.missing.join('、')}]，${failedCheckText}，已按节点级把关阻断生成`;
      // 阻断范围=本章，不再等于整篇：本闸原在 try 之外抛错，一章缺权威会把全部已完成章节连同 finalize 一起作废。
      // 与其它章级失败同口径处理（记录失败消息 + 标记该章 failed + 其余章节照常成稿），
      // 缺章由 finalize 的 missingChapterCount blocker 经终门禁复核清单交付。
      // 「禁止无权威成稿」的口径不变——该章就是不产出，而不是降级产出。
      const blockStage = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'failed',
        message: blockMessage,
        details: ['数值密集型章所需蓝图权威不可用时禁止无权威成稿', '请检查清单解析与蓝图构建诊断后重试'],
        progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '章节阻断' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      session.global.progressStages.push(blockStage);
      session.understanding.failedChapterMessages.push(blockMessage);
      session.understanding.chapterGenerationStagesByOrder[chapterOrder] = blockStage;
      session.global.emitProgress();
      return undefined;
    }
    const chapterStartedAt = Date.now();
    const chapterProgressIndex = session.global.progressStages.length;
    let latestChapterStageForProgress: DocumentExecutionStage | undefined;
    try {
    session.global.progressStages.push(displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: session.prepare.promptPlan.writerPrompts[0]?.id,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在检索证据并准备章节内容`,
      details: [`章节序号：${chapterOrder + 1}/${session.planning.effectiveChapters.length}`, `二级小节：${chapter.sections?.length || 0} 个`, '正在生成检索查询'],
      progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '章节生成' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder }));
    session.global.emitProgress();
    const resumedChapter = session.global.input.resumeChapters?.find(item => item.id === chapter.id || item.title === chapter.title);
    const resumedContent = resumedChapter?.content?.trim();
    const rawEvidence: DocumentEvidence[] = resumedChapter?.evidence?.length ? [...resumedChapter.evidence] : [];
    const plan = session.prepare.projectUnderstanding.chapterPlans.find(item => item.chapterId === chapter.id || item.chapterTitle === chapter.title);
    const planQueries = plan ? Object.values(plan.evidenceQueries).flat().filter(Boolean) : [];
    const baseQueries = chapter.queries.length > 0 ? chapter.queries : [session.prepare.template.name, session.prepare.template.outputTitle, chapter.title];

    // ===== 图谱驱动证据注入：优先拉取图谱匹配文件的切片内容 =====
    const graphMapping = session.understanding.chapterGraphMap.get(chapter.id);
    if (session.understanding.projectGraph && graphMapping && graphMapping.graphFiles.size > 0) {
      // 图谱来源已标准化：图谱节点 sourceFiles 在提取时已换算为证据中的精确文件路径，直接使用
      const graphFileList = [...graphMapping.graphFiles];
      for (const gf of graphFileList) {
        const detail = session.understanding.getCachedFileDetail(gf);
        if (!detail?.chunks?.length) continue;
        for (const chunk of detail.chunks as Array<{ content: string; sectionTitle?: string }>) {
          rawEvidence.push({
            chapterId: chapter.id,
            filePath: detail.file?.relativePath || gf,
            score: 5 + (graphMapping.graphWorks.length + graphMapping.graphMethods.length) * 0.5,
            content: chunk.content,
            roleId: session.understanding.fileRoleByPath.get(gf),
            processingType: session.understanding.fileProcessingByPath.get(gf),
            sectionTitle: chunk.sectionTitle,
            source: 'graph-evidence',
          });
        }
      }
    }
    // ===== 图谱驱动证据注入结束 =====

    // P1-5：基础事实查询已跨章预执行缓存（basicFactSearchResults），不再并入本章查询集重复检索
    // P17 语义化：概况类章判定迁移 chapterIntentClassifier（语义优先、正则兑底）
    const usesCachedBasicFacts = session.planning.chapterIntentClassifier.needsBasicFacts(chapter.title);
    // D2 清单专用查询构造：清单事实锁按分部轮询均衡选取代表条目构造精确查询——数值型清单行在向量空间弱势，
    // 词面精确查询兑底（历史缺陷：清单条目证据竞争不过高语义匹配的招标文件切片，条目行从不被召回）；
    // 分部均衡保证章节标题与条目分部名无词面交集时条目类仍不被丢弃（旧实现硬过滤+顺序截断，
    // 亮化设计说明含太阳能参数从未被定向召回）
    const billItemQueries = session.blueprint.billFactLock
      ? buildBillFactLockQueries(session.blueprint.billFactLock, chapter.title, chapter.sections || [])
      : [];
    const queries = compactChapterQueries(chapter, [...baseQueries, ...planQueries, ...billItemQueries], []);
    const searchStartedAt = Date.now();
    session.global.progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: session.prepare.promptPlan.writerPrompts[0]?.id,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 正在执行质量优先的章节检索${graphMapping?.graphFiles.size ? `（图谱匹配 ${graphMapping.graphFiles.size} 个文件）` : ''}`,
      details: queries.map(query => `检索：${query.slice(0, 42)}`),
      progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '证据检索' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    session.global.emitProgress();
    const scopedFilePaths = resumedContent ? [] : [...session.understanding.availableEvidenceScopePaths].filter(Boolean).sort();

    const cachedIntentEvidence = resumedContent ? [] : (session.understanding.scopedIntelligence?.evidenceByChapterId?.[chapter.id] || []);
    if (cachedIntentEvidence.length > 0) {
      rawEvidence.push(...cachedIntentEvidence);
      // P2-B 双通道覆盖度观测：预分配意图证据注入条数（4.41 采集→4.42 收敛决策，不改行为）
      const channelDiag = session.planning.generationDiagnostics.evidence;
      channelDiag.intentEvidenceInjected = (channelDiag.intentEvidenceInjected ?? 0) + cachedIntentEvidence.length;
    }
    const searchResults: KbSearchResult[][] = [];
    // 优化：KB搜索并行化 — 多组查询并发执行，减少串行I/O等待
    const searchQueries = queries;
    // 模板必需事实定向查询并入首轮并行检索：提前命中缺失事实证据，降低后续深召回/补充检索触发概率，减少串行轮次
    const requiredFactSearchQueries = (chapter.requiredFacts || [])
      .filter((fact: string) => Boolean(fact) && !searchQueries.some(query => query.includes(fact) || fact.includes(query)))
      .map((fact: string) => `${chapter.title} ${fact}`);
    // 用户提示词事实线索定向查询：用户显式给出的项目专属事实（数值/规格/标准）优先召回，
    // 提高提示词事实的落实率（提示词作用小的根因治理：requirement 不进检索查询的历史缺陷）
    const requirementClueQueries = (session.prepare.requirementSemantics?.factClues || [])
      .filter(clue => !searchQueries.some(query => query.includes(clue) || clue.includes(query)) && !requiredFactSearchQueries.some(query => query.includes(clue) || clue.includes(query)))
      .map(clue => `${chapter.title} ${clue}`.trim())
      .slice(0, 8);
    const mergedSearchQueries = [...searchQueries, ...requiredFactSearchQueries, ...requirementClueQueries];
    if (scopedFilePaths.length > 0 && mergedSearchQueries.length > 0) {
      throwIfAborted(session.global.input.signal);
      const parallelResults = await runWithAdaptiveConcurrency(mergedSearchQueries, async query => session.understanding.searchWithCache(query, scopedFilePaths, Math.min(session.understanding.requestedEvidencePerChapter, 12), chapter.title, session.prepare.materialScope.selectedMaterialRoots), { kind: 'search' });
      searchResults.push(...parallelResults);
    }
    session.planning.generationDiagnostics.evidence.searchQueries += mergedSearchQueries.length;
    session.planning.generationDiagnostics.evidence.searchMs += Date.now() - searchStartedAt;
    // P4 细粒度埋点：章节检索段历史仅首尾两个事件（KB 搜索 + LLM 深召回可达 10 分钟级，中间零事件，
    // 前端长时间静止误判卡死）——关键检索节点即时更新本章 stage 消息与进度
    session.global.progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} KB 检索完成：${mergedSearchQueries.length} 组查询，准备深度召回与语义排序`,
      progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '证据检索' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    session.global.emitProgress();
    for (const results of searchResults) {
      // 检索结果范围由 searchWithCache 的 filters 双锁保证（filePaths + materialRoots），此处不再二次过滤（历史冗余已删）
      rawEvidence.push(...results.map((item: KbSearchResult) => ({
        chapterId: chapter.id,
        filePath: item.filePath,
        score: item.score,
        content: item.content,
        roleId: session.understanding.fileRoleByPath.get(item.filePath),
        processingType: session.understanding.fileProcessingByPath.get(item.filePath),
        sectionTitle: item.sectionTitle,
        source: item.source,
      })));
      // P2-B 双通道覆盖度观测：KB 检索通道注入条数
      const channelDiag = session.planning.generationDiagnostics.evidence;
      channelDiag.retrievedEvidenceInjected = (channelDiag.retrievedEvidenceInjected ?? 0) + results.length;
    }
    // P1-5：概况/质量/进度类章节直接取用跨章预执行的基础事实检索结果（resumed 章节跳过，与原检索语义一致）
    if (usesCachedBasicFacts && scopedFilePaths.length > 0 && session.blueprint.basicFactSearchResults.length > 0) {
      rawEvidence.push(...session.blueprint.basicFactSearchResults.map(item => ({
          chapterId: chapter.id,
          filePath: item.filePath,
          score: item.score,
          content: item.content,
          roleId: session.understanding.fileRoleByPath.get(item.filePath),
          processingType: session.understanding.fileProcessingByPath.get(item.filePath),
          sectionTitle: item.sectionTitle,
          source: 'basic-fact-cache',
        })));
    }
    const plannedMaterialEvidence = resumedContent ? [] : await retrievePlannedMaterialEvidence({ manager: session.understanding.manager, projectRoot: session.prepare.projectRoot, chapter, plan, profile: session.prepare.projectMaterialProfile, scopedFilePaths, scopedMaterialRoots: session.prepare.materialScope.selectedMaterialRoots, limitPerQuery: Math.min(session.understanding.requestedEvidencePerChapter, 10), signal: session.global.input.signal }).catch((error: unknown) => {
      // 降级治理：失败 ≠ 无命中（原 `.catch(() => [])` 让调用异常表现为「计划材料证据为空」）
      session.planning.generationDiagnostics.evidence.retrievalFailures = (session.planning.generationDiagnostics.evidence.retrievalFailures ?? 0) + 1;
      session.planning.generationDiagnostics.llm.lastError = `计划材料证据召回失败（${chapter.title}）：${error instanceof Error ? error.message : String(error)}`;
      console.error(`[gen] 计划材料证据召回失败（${chapter.title}）`, error);
      return [];
    });
    rawEvidence.push(...plannedMaterialEvidence);
    /**
     * 角色节点抽取事实 → 章级事实卡（`buildChapterFactCoverageContext.roleFacts`）。
     *
     * 4.55.22：此处原为 `Array<{ fact: never }> = []`——元素类型 `never`，即**结构上不可能被填充**
     * （重构中途弃用留下的类型谎），于是事实卡里「角色节点已抽取事实」那块在每次调用中恒为空。
     * 现把类型改为真实形状，使该通道可被接线；同时如实记录：**当前无调用方提供数据**，
     * 若需恢复该能力（把 agentWorkflow 节点抽取的事实并入章级事实卡），在此处接入即可。
     */
    const matchedRoleContexts: Array<{ fact: { key: string; value: unknown } }> = [];
    if (session.planning.chapterIntentClassifier.needsBasicFacts(chapter.title)) rawEvidence.push(...session.understanding.safeProjectBasicEvidence.map(item => ({ ...item, chapterId: chapter.id, source: 'pinned-evidence' })));
    // round-20 S5/W7 P6-2：招标文件/投标须知类文件整文件 pinned 注入到概况/总述类章节——
    // 要求来源文件不得被检索召回截断（招标要求未写入正文的根因是要求原文根本没进 prompt）；
    // pinned 证据在预算截断时优先级最高，招标内容优先于其他证据进入；
    // 证据内容安全分区后取放行子集（writerEvidence），评标纪律/评标办法章节不进写手输入
    const tenderFileEvidence = session.understanding.writerEvidence.filter(item => /招标|投标须知|评标办法|专用合同条款|投标人须知/u.test(`${item.filePath || ''}${item.sectionTitle || ''}`));
    if (/概况|工程|项目|总体|部署/u.test(chapter.title) && tenderFileEvidence.length > 0) rawEvidence.push(...tenderFileEvidence.map(item => ({ ...item, chapterId: chapter.id, source: 'pinned-evidence' as const })));
    // 模板 pinned 文件整文件全量注入（不再按字符预算截断，截断即要求条款丢失）：
    // pinned 值为包内相对路径（跨资料包在词法上无法表达），拼接到当前资料包根后直读 KB 详情；
    // 已存在/未索引的文件不再静默丢弃：未命中计数进诊断 + 服务端日志可见
    const pinnedPackRoot = session.prepare.materialScope.selectedMaterialRoots[0] || '';
    for (const pinnedPath of (chapter.pinnedEvidenceFilePaths || []).filter(Boolean)) {
      const cleaned = pinnedPath.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/^\/+/u, '');
      // 幂等归一化：新契约为包内相对路径；存量配置可能写作「包名/文件」全路径（旧契约），
      // 已含包前缀时不重复拼接，避免双重前缀导致静默未命中
      const relativePath = pinnedPackRoot && cleaned !== pinnedPackRoot && !cleaned.startsWith(`${pinnedPackRoot}/`) ? `${pinnedPackRoot}/${cleaned}` : cleaned;
      const detail = session.understanding.getCachedFileDetail(relativePath);
      if (!detail) {
        const diag = session.planning.generationDiagnostics?.evidence;
        if (diag) diag.pinnedEvidenceMissed = (diag.pinnedEvidenceMissed ?? 0) + 1;
        console.warn('[stage-chapter-loop] pinned 证据文件未命中知识库（配置漂移或文件未入库）', { chapter: chapter.title, pinnedPath, resolvedPath: relativePath });
        continue;
      }
      rawEvidence.push(...(detail.chunks as Array<{ content: string; sectionTitle?: string }>).map(chunk => ({
        chapterId: chapter.id,
        filePath: detail.file.relativePath,
        score: 1,
        content: chunk.content,
        roleId: session.understanding.fileRoleByPath.get(detail.file.relativePath),
        processingType: session.understanding.fileProcessingByPath.get(detail.file.relativePath),
        sectionTitle: chunk.sectionTitle,
        source: 'pinned-evidence',
      })));
    }
    // 证据范围源头化：rawEvidence 各来源（检索召回/意图缓存/基础证据/pinned 直读）均已在源头按资料范围约束
    let scopedEvidence = rawEvidence;
    if (!resumedContent && session.prepare.webAccessConfig.enabled && session.prepare.webAccessConfig.allowProjectFacts) {
      const webResult = await retrieveWebEvidence({ config: session.prepare.webAccessConfig, chapterId: chapter.id, chapterTitle: chapter.title, sectionTitles: chapter.sections || [], runtimeRules: session.prepare.runtimePromptRules, localFacts: [...session.understanding.preliminaryFactsModel.project, ...session.understanding.preliminaryFactsModel.schedule, ...session.understanding.preliminaryFactsModel.quality, ...session.understanding.preliminaryFactsModel.safety, ...session.understanding.preliminaryFactsModel.resources, ...session.understanding.preliminaryFactsModel.preciseFacts], signal: session.global.input.signal });
      session.understanding.webResearchReport.queries.push(...webResult.queries);
      // 4.55.22 修复：原实现把 `webResult.evidence.length`（**命中的公开资料条数**）计入 `filteredCount`
      // ——即把"取到的资料"统计成"被过滤掉的噪声"；且 `evidence` 本体**从未进入写作证据链**
      // （`webResult` 在此仅被取 queries/filtered/evidence.length/failedQueries）。
      // 后果：开了联网增强的每一章都白付查询改写 LLM + 检索延迟，交付报告却写「使用公开资料 0 条」
      //（`webResearchReport.evidenceCount` 全仓无任何赋值），通用规范/政策/工艺补充一条都到不了写手。
      session.understanding.webResearchReport.filteredCount += webResult.filtered;
      session.understanding.webResearchReport.evidenceCount += webResult.evidence.length;
      if (webResult.evidence.length > 0) {
        session.understanding.webResearchReport.chapters.push(chapter.title);
        // 公开资料仅作通用规范/政策/工艺补充，**不作项目事实来源**——与报告文案同口径
        scopedEvidence.push(...webResult.evidence.map(item => ({ ...item, chapterId: chapter.id })));
      }
      // 降级治理：联网检索**失败**与「被噪声过滤」分列——原实现（webResearchService）把请求异常
      // 计入 filtered，网络全挂会被读成「过滤掉了 N 条低质结果」。此处把失败计数同样上报。
      if (webResult.failedQueries > 0) {
        session.understanding.webResearchReport.failedCount = (session.understanding.webResearchReport.failedCount ?? 0) + webResult.failedQueries;
        session.planning.generationDiagnostics.llm.lastError = `联网检索失败 ${webResult.failedQueries} 次（${chapter.title}）：${webResult.failures.slice(0, 3).join('；')}`;
      }
    }
    const sampledEvidence = resumedContent ? [] : sampleProjectMaterialEvidence({ project: session.understanding.project, chapter, plan, profile: session.prepare.projectMaterialProfile, scopedFilePaths, highRisk: rolePoolRisk.highRisk });
    if (sampledEvidence.length > 0) scopedEvidence.push(...sampledEvidence);
    /**
     * 证据组装**唯一出口**（4.55.22）：现行口径覆盖 + 写作链内容安全过滤在此一并收口。
     *
     * 为什么必须在这里而不是各自的生产端：现行口径覆盖此前只加在 `searchWithCache` 出口，
     * 而**深召回**（`documentEvidenceRetrieval` 直连 `manager.search`）与**资料抽样**
     * （`sampleProjectMaterialEvidence` 直读切片）都绕过该函数——旧值（365 / 旧限价 / 旧开工日期）
     * 会经这两条通道重新进入写手输入，正是「终稿 4 处现行 365 日历天」的复发路径。
     * 覆盖表替换是幂等的（生效值不含被取代 token），与 searchWithCache 出口重复施加无副作用。
     */
    const assembleScopedEvidence = (items: DocumentEvidence[]): DocumentEvidence[] => {
      applyOverridesToRetrieved(items, session.planning.earlyOverrideList);
      return session.understanding.excludedEvidenceKeys.size > 0
        ? items.filter(item => !session.understanding.excludedEvidenceKeys.has(evidenceSafetyKey(item)))
        : items;
    };
    scopedEvidence = assembleScopedEvidence(scopedEvidence);
    // P1 语义排序：章节证据按“章查询 ↔ 证据文本”本地 bge-small 余弦排序（语义主键，证据全量保留、无预算截断）。
    // 4.12.16 候选池词面粗筛：全量 ~1.5 万条本地嵌入是检索段 CPU 瓶颈（实测 20+ 分钟），
    // 先按词面/重要性分数取 topN 候选（默认 3000），仅候选池嵌入，未入池条目语义分为 0 退回 baseScore 口径
    const semanticTopCandidates = (() => {
      const raw = Number(process.env.DOCUMENT_SEMANTIC_TOP_CANDIDATES);
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3000;
    })();
    const semanticPool = preselectSemanticCandidates(chapter, scopedEvidence, semanticTopCandidates, carrierBoost);
    const chapterSemanticSimilarity = await buildSemanticSimilarity([chapterCriteriaText(chapter)], semanticPool.map(semanticEvidenceText));
    let evidence = optimizeChapterEvidence(chapter, scopedEvidence, { preservePinned: true, carrierBoost, semantic: { similarity: chapterSemanticSimilarity, queryText: chapterCriteriaText(chapter) } }, session.planning.generationDiagnostics);
    // 源级同口径裁决前置到证据切片：资料原文（如招标正文 4645㎡）被补疑修正后，进入写作 LLM 的切片必须先改写成裁决值，
    // 否则模型看到原文旧值会照抄（历史缺陷：第 3 章 checkpoint 混用 4645/4646），只能靠事后全局审查修复
    evidence = governEvidenceValues(evidence, session.understanding.canonicalFacts.scopeConflicts);
    let missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
    let deepEvidenceCount = 0;
    // P1-4：事实需求计算提前到深召回判断之前，把 requiredMissingNeeds 并入深召回一次完成，
    // 避免缺失事实与必需事实需求两次深召回查询集高度重叠
    // 标书编制规格（阶段 1 判定）：正文禁图（暗标或招标「不得有图片」证据，bodyFigurePolicy）驱动写作侧
    // 禁图提示与清理；C1 出口错位修复——原实现误用 isBodyTableForbidden（表格口径）驱动禁图
    const forbidDrawingImages = isBodyFigureForbidden(session.understanding.bidComposition);
    const graphRoleHint = graphMapping
      ? [
          graphMapping.graphWorks.length ? `图谱识别本章工程内容：${graphMapping.graphWorks.join('、')}` : '',
          graphMapping.graphMethods.length ? `图谱识别本章施工方法：${graphMapping.graphMethods.join('、')}` : '',
          graphMapping.graphBoqItems.length ? `图谱识别本章BOQ清单项（${graphMapping.graphBoqItems.length}项）：${graphMapping.graphBoqItems.map(b => `${b.name} ${b.quantity}${b.unit}`).join('、')}` : '',
          graphMapping.gaps.length ? `图谱识别本章资料缺口：${graphMapping.gaps.join('；')}` : '',
        ].filter(Boolean).join('\n')
      : '';
    // 写作任务书不再逐章注入：其“写作目标/必须覆盖/清单目标”与 plan（项目资料理解的章节计划，源自模板+图谱、更项目专属）语义重叠，
    // 全局写作约束由文档蓝图（projectContext）统一承载；但 WRITING_INTEGRITY_CONSTRAINTS（结构/表格/数据口径/禁堆砌/工期时序五条红线，
    // 与 structureIntegrityRules 检测口径同源的写作侧单源）为逐章强约束——检测器能拦的缺陷必须在写作 prompt 前置声明，
    // 从源头不产出（重点在写时，检测与清理只作安全网），故在此逐章注入 roleContext
    const scopeOverrideAnchors = renderScopeOverrideAnchors(session.understanding.canonicalFacts.scopeConflicts);
    // 本章责任要求项（蓝图分配唯一权威源）：分配到本章的招标要求必须显性写入正文（生成侧治本，不依赖事后补写）
    const chapterRequirementContext = (() => {
      if (session.blueprint.requirementAssignments.length === 0) return '';
      const chapterTitle = normalizeChapterTitleLine(chapter.title);
      const entries = session.blueprint.requirementAssignments.filter(assignment => assignment.chapterTitle === chapterTitle).map(assignment => assignment.entry);
      return renderChapterRequirementSlice(entries);
    })();
    // A-T1 结构/呈现要求写作注入（章级）：招标明文的呈现形态（框图/图/表格/结合图表）必须在正文落实；
    // C1 双证据口径——正文禁表（显式禁表句）→ 不得出图表实体以文字承载并指向附表区；禁图允许表
    //（暗标常态）→ 表格/框图照常落实，图类以文字框图/表格式时间轴+图题行承载（无图片）
    const chapterStructureContext = (() => {
      if (session.blueprint.structureAssignments.length === 0) return '';
      const chapterTitle = normalizeChapterTitleLine(chapter.title);
      const items = session.blueprint.structureAssignments.filter(assignment => assignment.chapterTitle === chapterTitle).map(assignment => assignment.requirement);
      return renderChapterStructureSlice(items, { bodyTableForbidden: isBodyTableForbidden(session.understanding.bidComposition), bodyFigureForbidden: forbidDrawingImages });
    })();
    // 4.17.8 六个百分百写作侧前置注入：扬尘治理六项是国家规范固定封闭集，历史缺陷只在检测/修复侧
    // 逐项补写（后期修复模式），写作 LLM 凭记忆编写必漏项（4.17.7 实测缺 2 项）；写作时即注入六项
    // 原文要求逐项落实，缺项从源头消失——修复是辅助，写作是主力
    // P17 语义化：扬尘类章判定迁移 chapterIntentClassifier（章标题语义优先，标题+用途组合正则兑底保持原命中集）
    // 词表与豁免句单源引用检测器（SIX_HUNDRED_PERCENT_ITEMS/词面表/豁免句）：写作侧指令的条目名与
    // 豁免句必须就是检测侧认下的那一份，否则「照指令写了却判缺失」——三份各抄一份词表即漂移根源
    const sixHundredPercentContext = session.planning.chapterIntentClassifier.needsDustControl(chapter.title)
      || session.planning.chapterIntentClassifier.needsDustControl(`${chapter.title}${chapter.purpose || ''}`)
      ? [`【扬尘治理六个百分百——规范固定条目，必须逐项落实并写入正文，每项一句具体措施，六项不得缺项；若本项目无拆迁工程，对“${SIX_HUNDRED_PERCENT_DEMOLITION_ITEM}”必须显性写明“${SIX_HUNDRED_PERCENT_DEMOLITION_EXEMPT_SENTENCE}”，不得省略】`,
        ...SIX_HUNDRED_PERCENT_ITEMS.map(item => `- ${item.name}`)].join('\n')
      : '';
    // B5 强制规划小节注入（丰乐镇第三轮实测：主要施工方法缺「主要分部分项工程施工方案」、
    // 劳动力安排计划缺「资源配置计划」，规划小节仅混在 mustCover 里被 LLM 漏输出）：
    // 规划小节必须逐条展开为三级标题，不得因小节名与章标题相近而省略（同名也不得省略）
    const forcedPlannedSections = (chapter.sections || []).filter(section => !/^(?:施工概况|施工流程|施工方法)$/u.test(section.trim()) && !/^附录/u.test(section.trim()));
    const forcedSectionContext = forcedPlannedSections.length > 0
      ? `【必须输出以下规划小节为三级标题（### 小节名），逐个小节展开正式正文：每小节正文不少于 100 字，不得只写标题、不得空小节、不得用表格替代正文；小节名与章标题相同或相近也必须输出，不得省略或合并】${forcedPlannedSections.join('、')}`
      : '';
    // B2 清单行直读通道：清单事实锁按章节相关性渲染权威清单行，不经检索召回/注入截断直接进入写作提示词
    //（清单条目级数据零丢失：检索硬顶/向量弱势/重排惩罚都影响不到直读行）
    const billLockText = session.blueprint.billFactLock ? renderBillFactLockText(session.blueprint.billFactLock, chapter.title, { sections: chapter.sections || [] }) : '';
    // C-T5 行级任务清单（本章责任行）：责任章分配到本章的清单条目逐条列出（含建议落位小节），
    // 写作时即按任务清单驱动落位（从源头提升落位率，检测/修复只作安全网）
    const billTaskLines = session.blueprint.billFactLock ? renderBillChapterTaskLines(session.blueprint.billFactLock, billResponsibility, chapter.title) : [];
    // B-T3 图纸行直读通道：图纸事实锁按章节相关性渲染设计说明/构造做法/材料规格/设备参数事实行，
    // 不经检索召回/注入截断直接进入写作提示词（每份可用图纸保底行进入本节，支撑引用率验收 ≥1 处/份）
    const drawingLockText = session.blueprint.drawingFactLock ? renderDrawingFactLockText(session.blueprint.drawingFactLock, chapter.title, { sections: chapter.sections || [] }) : '';
    // C-T6 可靠参数按章直读通道：资料事实链参数索引（规格/参数/数量/时间/比例/标准编号）按章节相关性渲染，
    // 不经检索召回直接进入写作提示词——可靠参数使用率的写作侧主力（商务金额类已在参数池构建时排除）
    const parameterLines = renderChapterParameterLines(session.understanding.preliminaryFactsModel, chapter.title, { sections: chapter.sections || [] });
    // 组件 6 跨章写作职责分工：职责载体 = 本章标题+规划小节 / 其余各章标题+各自小节（同一份规划产物），
    // 写作端源头确保无跨章重复（写时即不复制其他章主题），不再依赖事后按分数删重复
    const dutyDeclaration = buildCrossChapterDutyDeclaration(chapter, session.planning.effectiveChapters);
    // r14 E16 清单分部覆盖义务（方法类章）：规划小节即使漏规划清单独有分项，写作正文也必须逐项覆盖
    //（丰乐镇实机：「过路涵」「青砖步道」在主要施工方法章零命中，终检 boq-division-coverage 报 blocker）；
    // 与规划层注入（stageOutlinePlanning）、链尾确定性兜底共用 extractBoqDivisionCoverage 单源
    const boqCoverageContext = /施工方法|施工方案|施工工艺|主要施工内容|分部分项/u.test(chapter.title)
      ? (() => {
          const summary = formatBoqDivisionCoverage(extractBoqDivisionCoverage(session.understanding.preliminaryFactsModel));
          return summary ? `【本章必须覆盖的清单分部分项全景（下列专有分项逐项写入正文施工方法，不得只写道路/铺装/绿化等大类而遗漏清单独有分项）】\n${summary}` : '';
        })()
      : '';
    // G 线 P1-9：恢复逐章写作任务书注入。此前整体不注入（注释称与 plan 语义重叠），但 plan 的
    // mustCover 主要来自模板 sections 与图谱匹配，**不含** REQUIREMENTS 侧最稀缺的那批要求知识。
    // 结果是：写作端看不到「危大工程辨识清单逐项完整 / 应急预案八部分结构 / 扬尘治理六个百分百
    // 逐项落位 / 四节一环保量化指标 / 农民工工资专用账户」等硬要求，必然先不写、再由检测器抓、
    // 再靠修复轮补 —— 而修复轮没有知识库通道，只能改写已有文字，补不进缺失的要求响应。
    const focusRule = chapterFocusRule(chapter.title);
    const chapterFocusContext = focusRule
      ? `【本章写作重点】${focusRule.goal}\n【本章必须覆盖（逐项落位，缺一即判未响应）】\n${focusRule.mustCover.map(item => `- ${item}`).join('\n')}`
      : '';
    // 写作前定死块（4.55.22 断链修复）：truthConstraint / 澄清口径 / B8 现行口径铁律 / B7 权威值必须写数字 /
    // 项目规模事实卡 / 危大判定。此前这些只写进 session.planning.writingTaskBrief，而该字段的全部消费点
    // 是「传递给 finalize」与「渲染一条给人看的进度节点」——**从未进入任何写作提示词**，
    // 同样 session.planning.truthConstraint 全仓零读取点。后果：写手从未被告知「只用现行值」→
    // 终稿 4 处现行「365日历天」；从未被告知「峰值必须写数字」→ 峰值全篇 0 个数字。
    const writeTimeFixedBlocks = buildWriteTimeFixedBlocks({
      truthConstraint: session.planning.truthConstraint,
      clarificationConstraint: session.planning.clarificationOverrides?.length
        ? renderClarificationConstraintBlock(session.planning.clarificationOverrides)
        : undefined,
      // 4.55.36 批次 2 答疑技术性修正（非单值口径）按章硬约束：本章归属条目 + 全文适用条目
      //（归属失败的修正并入「全文适用」段，**不丢弃**——2-2 要求不可归属时进全局写作焦点）
      amendmentConstraint: renderClarificationAmendmentBlock(clarificationAmendments, { chapterTitle: chapter.title }),
      globalWritingFocus: session.planning.writingTaskBrief?.globalWritingFocus,
      hazardBindingBlock: renderHazardBindingBlock(hazardBindings),
    });
    const roleContext = [chapterFocusContext, ...writeTimeFixedBlocks, graphRoleHint, chapterRequirementContext, chapterStructureContext, forcedSectionContext, dutyDeclaration, sixHundredPercentContext, scopeOverrideAnchors.length ? `【数据口径强制约束】${scopeOverrideAnchors.join('；')}` : '', ...WRITING_INTEGRITY_CONSTRAINTS, plan?.writingGoal, plan?.mustCover?.length ? `本章必须覆盖：${plan.mustCover.join('、')}` : '', plan?.mustUseMaterialKinds?.length ? `本章优先使用资料类型：${plan.mustUseMaterialKinds.join('、')}` : '', boqCoverageContext, ...parameterLines, ...billTaskLines, billLockText, drawingLockText].filter(Boolean).join('\n');
    const chapterPromptExecution = resolveChapterPromptExecution(session.prepare.promptPlan, chapter);
    if (session.prepare.promptPlan.writerPrompts.length > 0 && !chapterPromptExecution.primaryWriter) throw new Error(`${displayChapterTitle(chapter.title)} 写作主控提示词未进入章节生成阶段`);
    // G 线 P1-10：运行时规则并入写作提示词。`runtimeRulesText`（由用户提示词抽取的禁写项/必需表/
    // 必需关键词，含 requirement 语义解析产出的强制要求清单）此前只进审查与修复提示词
    // （reviewPromptTexts / factExtractionPromptTexts），而写作端只拿到「绑定提示词原文 + 控制提示词」——
    // 用户明确配置的禁写项与必需项在写作时**对模型不可见**，必然先违规、再由检测器抓、再靠修复改写。
    // 这与「从源头不产出」的写作侧单源原则相悖，故并入。
    const chapterPromptTexts = [chapterPromptExecution.promptTexts, session.prepare.generationControlPrompt, session.prepare.runtimeRulesText].filter(Boolean).join('\n\n');
    const chapterPromptDetails = chapterPromptExecution.promptDetails.length ? chapterPromptExecution.promptDetails : ['未绑定章节写作提示词'];
    const chapterFactNeeds = buildChapterFactNeeds({ template: session.prepare.template, chapter, spec: session.prepare.documentSpec, profile: session.prepare.domainProfile, promptTexts: chapterPromptTexts, requirement: session.global.input.requirement, plan: plan ? { requiredContents: plan.mustCover, evidenceNeeds: Object.values(plan.evidenceQueries).flat() } : undefined });
    let resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: session.understanding.preliminaryFactsModel, evidence: scopedEvidence, profile: session.prepare.domainProfile, excludedEvidenceKeys: session.understanding.excludedEvidenceKeys });
    let requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
    // 优化：图谱证据充足且多样化时才跳过深召回（文件多样性≥6 + 无缺失事实）
    const readinessPlan = buildChapterReadinessPlan({ chapter, evidence });
    const evidenceFileCount = new Set(evidence.map(item => item.filePath)).size;
    const graphEvidenceSufficient = Boolean(graphMapping)
      && (graphMapping?.graphFiles.size || 0) >= 8
      && evidenceFileCount >= 6
      && missingFacts.length === 0
      && readinessPlan.riskLevel === 'low';
    const needsDeepRetrieval = shouldTriggerDeepRetrieval({
      scopedFileCount: scopedFilePaths.length,
      evidenceCount: evidence.length,
      evidenceFileCount,
      suggestedStrategy: readinessPlan.suggestedStrategy,
      highRisk: rolePoolRisk.highRisk,
      missingFactsCount: missingFacts.length,
      requiredMissingNeedsCount: requiredMissingNeeds.length,
      riskLevel: readinessPlan.riskLevel,
    });
    if (!graphEvidenceSufficient && needsDeepRetrieval && scopedFilePaths.length > 0) {
      // P4 细粒度埋点：LLM 深召回是检索段最长 LLM 调用，开始前推送事件消除盲区
      const deepNeedCount = new Set([...missingFacts, ...requiredMissingNeeds]).size;
      if (deepNeedCount > 0) {
        session.global.progressStages[chapterProgressIndex] = displayStage({
          type: 'chapter_generation',
          roleId: 'chapter_generation',
          status: 'running',
          message: `${displayChapterTitle(chapter.title)} 正在深度召回缺失事实证据（${deepNeedCount} 项需求）`,
          progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '深度召回' },
        }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
        session.global.emitProgress();
      }
      // P1-4：缺失事实与必需事实需求并入同一次深召回（原两次调用查询集高度重叠，合并后每章深召回查询数约降 40%）
      const deepEvidence = await retrieveDeepChapterEvidence({ manager: session.understanding.manager, projectRoot: session.prepare.projectRoot, chapter, scopedFilePaths, scopedMaterialRoots: session.prepare.materialScope.selectedMaterialRoots, fileRoleByPath: session.understanding.fileRoleByPath, fileProcessingByPath: session.understanding.fileProcessingByPath, requiredNeeds: [...new Set([...missingFacts, ...requiredMissingNeeds])], extraClues: session.prepare.requirementSemantics?.factClues || [], highRisk: rolePoolRisk.highRisk || requiredMissingNeeds.length > 0, signal: session.global.input.signal }).catch((error: unknown) => {
        // 降级治理：失败 ≠ 命中 0 条。原 `.catch(() => [])` 让调用异常在 UI 上显示为「命中 0 条」，
        // 而深召回是写作证据的主来源之一——基础设施故障被读成「资料里没有」。
        session.planning.generationDiagnostics.evidence.retrievalFailures = (session.planning.generationDiagnostics.evidence.retrievalFailures ?? 0) + 1;
        session.planning.generationDiagnostics.llm.lastError = `章深度召回失败（${chapter.title}）：${error instanceof Error ? error.message : String(error)}`;
        console.error(`[gen] 章深度召回失败（${chapter.title}）`, error);
        return [];
      });
      deepEvidenceCount = deepEvidence.length;
      // P2-B 双通道覆盖度观测：深召回通道注入条数
      const channelDiag = session.planning.generationDiagnostics.evidence;
      channelDiag.retrievedEvidenceInjected = (channelDiag.retrievedEvidenceInjected ?? 0) + deepEvidence.length;
      if (deepEvidence.length > 0) {
        // 深召回增量合并：deepEvidence 由检索层 filters 双锁约束，直接合并；
        // 不再对合并集先做一次 optimizeChapterEvidence 全量重排——下方 evidence 会统一重排一次
        //（历史冗余：同一输入同一参数连续重排两遍，optimizeChapterEvidence 为纯函数，中间结果随即被覆盖）
        scopedEvidence = assembleScopedEvidence([...scopedEvidence, ...deepEvidence]);
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { preservePinned: true, carrierBoost }, session.planning.generationDiagnostics);
        evidence = governEvidenceValues(evidence, session.understanding.canonicalFacts.scopeConflicts);
        missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
      }
      // P1-4：深召回后重算事实需求，仍缺失的必需需求触发下方一次轻量补充
      resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: session.understanding.preliminaryFactsModel, evidence: scopedEvidence, profile: session.prepare.domainProfile, excludedEvidenceKeys: session.understanding.excludedEvidenceKeys });
      requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
      // P4 细粒度埋点：深召回完成即时刷新命中数（含零命中），前端可见检索推进
      session.global.progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 深度召回完成：命中 ${deepEvidenceCount} 条${requiredMissingNeeds.length > 0 ? `，仍缺 ${requiredMissingNeeds.length} 项（触发轻量补充）` : ''}`,
        progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '证据检索' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      session.global.emitProgress();
    }
    // P1-4：合并深召回后仍有必需事实缺口时做一次轻量补充（原第二次深召回，highRisk 强制；仅当新 needs 出现时触发）
    if (requiredMissingNeeds.length > 0 && scopedFilePaths.length > 0) {
      const mergedSupplementalEvidence = await retrieveDeepChapterEvidence({ manager: session.understanding.manager, projectRoot: session.prepare.projectRoot, chapter, scopedFilePaths, scopedMaterialRoots: session.prepare.materialScope.selectedMaterialRoots, fileRoleByPath: session.understanding.fileRoleByPath, fileProcessingByPath: session.understanding.fileProcessingByPath, requiredNeeds: requiredMissingNeeds, extraClues: session.prepare.requirementSemantics?.factClues || [], highRisk: true, signal: session.global.input.signal }).catch((error: unknown) => {
        session.planning.generationDiagnostics.evidence.retrievalFailures = (session.planning.generationDiagnostics.evidence.retrievalFailures ?? 0) + 1;
        session.planning.generationDiagnostics.llm.lastError = `必需事实补充召回失败（${chapter.title}）：${error instanceof Error ? error.message : String(error)}`;
        console.error(`[gen] 必需事实补充召回失败（${chapter.title}）`, error);
        return [];
      });
      // P2-B 双通道覆盖度观测：轻量补充（required-fact-evidence）注入条数
      const channelDiag = session.planning.generationDiagnostics.evidence;
      channelDiag.retrievedEvidenceInjected = (channelDiag.retrievedEvidenceInjected ?? 0) + mergedSupplementalEvidence.length;
      if (mergedSupplementalEvidence.length > 0) {
        // 补充证据由检索层 filters 双锁约束，直接合并后统一重排一次（同深召回路径，省一次全量重排）
        scopedEvidence = assembleScopedEvidence([...scopedEvidence, ...mergedSupplementalEvidence]);
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { preservePinned: true, carrierBoost }, session.planning.generationDiagnostics);
        evidence = governEvidenceValues(evidence, session.understanding.canonicalFacts.scopeConflicts);
        missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
        resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: session.understanding.preliminaryFactsModel, evidence: scopedEvidence, profile: session.prepare.domainProfile, excludedEvidenceKeys: session.understanding.excludedEvidenceKeys });
        requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
      }
    }
    // P2-B 双通道覆盖度观测：最终 evidence（语义排序+口径治理后）的两通道留存条数——
    // 与注入侧对照得出「预分配 vs 运行时召回」真实贡献占比（4.42 收敛决策数据，不改行为）
    {
      const channelDiag = session.planning.generationDiagnostics.evidence;
      const runtimeRetrievalSources = new Set(['keyword', 'vector', 'hybrid', 'deep-retrieval', 'required-fact-evidence']);
      channelDiag.intentEvidenceUsed = (channelDiag.intentEvidenceUsed ?? 0) + evidence.filter(item => item.source === 'project-intelligence').length;
      channelDiag.retrievedEvidenceUsed = (channelDiag.retrievedEvidenceUsed ?? 0) + evidence.filter(item => Boolean(item.source) && runtimeRetrievalSources.has(item.source as string)).length;
    }
    if (evidence.length === 0) session.understanding.missingItems.push(`${chapter.title}：缺少可支撑正文的项目资料证据`);
    for (const fact of missingFacts) session.understanding.missingItems.push(`${chapter.title}：事实需求未满足 ${fact}`);
    // 证据检索完成 → 持续刷新证据数量
    const knowledgeBaseStage = displayStage({ type: 'knowledge_retrieval', roleId: 'knowledge-base', status: (session.understanding.allEvidence.length > 0 ? 'success' : 'failed'), message: `已检索/绑定 ${session.understanding.allEvidence.length} 条证据` });
    if (session.understanding.knowledgeBaseStageIndex < 0) {
      session.understanding.knowledgeBaseStageIndex = upsertProgressStage(session.global.progressStages, knowledgeBaseStage);
    } else {
      session.global.progressStages[session.understanding.knowledgeBaseStageIndex] = { ...knowledgeBaseStage, order: session.global.progressStages[session.understanding.knowledgeBaseStageIndex]?.order ?? knowledgeBaseStage.order };
    }
    session.global.emitProgress();

    throwIfAborted(session.global.input.signal);

    // P0-1 小节级检索复用：跨小节/跨修复轮缓存（查询=章节+小节标题），
    // 章节级 evidence 经 evidenceForSection 过滤后 ≥4 条且含量化参数时短路跳过检索；
    // 检索的 LocalReranker 交叉编码已下沉 worker 线程（rerank-worker-thread），不阻塞主线程
    const sectionEvidenceCache = new Map<string, DocumentEvidence[]>();
    const sectionEvidenceForChapter = (sectionTitle: string): Promise<DocumentEvidence[]> => {
      const cacheKey = stableHash({ kind: 'section', query: `${chapter.title} ${sectionTitle}`.trim(), scopedFilePaths });
      const cached = sectionEvidenceCache.get(cacheKey);
      if (cached) return Promise.resolve(cached);
      const chapterSectionEvidence = evidenceForSection(sectionTitle, chapter, evidence);
      const quantifiedCount = chapterSectionEvidence.filter(item => QUANTIFIED_FACT_RE.test(item.content)).length;
      if (chapterSectionEvidence.length >= 4 && quantifiedCount >= 1) {
        // 全量使用已命中证据，不再取前 5 条捷径（截断即丢证据）
        sectionEvidenceCache.set(cacheKey, chapterSectionEvidence);
        return Promise.resolve(chapterSectionEvidence);
      }
      return retrieveSectionEvidence({ manager: session.understanding.manager, projectRoot: session.prepare.projectRoot, chapter, sectionTitle, scopedFilePaths, scopedMaterialRoots: session.prepare.materialScope.selectedMaterialRoots, fileRoleByPath: session.understanding.fileRoleByPath, fileProcessingByPath: session.understanding.fileProcessingByPath, signal: session.global.input.signal }).then(results => {
        sectionEvidenceCache.set(cacheKey, results);
        return results;
      });
    };
    const retrievalCoverageReport = buildRetrievalCoverageReport({ chapter, evidence, risk: rolePoolRisk });
    session.understanding.retrievalCoverageReports.push(retrievalCoverageReport);
    const chapterEvidenceFiles = new Set(evidence.map(item => item.filePath));
    const chapterEvidenceChars = evidence.reduce((sum, item) => sum + item.content.length, 0);
    const retrievalDetails = [
      ...(rolePoolRisk.highRisk ? [`召回覆盖风险（${rolePoolRisk.riskReason || '切片未完全预加载'}）：已加载 ${rolePoolRisk.loadedChunks}/${rolePoolRisk.totalChunks}，已启用深召回`] : []),
      `项目理解缓存证据：${cachedIntentEvidence.length} 条`,
      `深召回证据：${deepEvidenceCount} 条`,
      `事实覆盖：${retrievalCoverageReport.requiredFactCovered}/${retrievalCoverageReport.requiredFactTotal}`,
      `小节覆盖：${retrievalCoverageReport.sectionCovered}/${retrievalCoverageReport.sectionTotal}`,
    ];
    session.global.progressStages[chapterProgressIndex] = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: session.prepare.promptPlan.writerPrompts[0]?.id,
      status: 'running',
      message: `${displayChapterTitle(chapter.title)} 已选取 ${evidence.length} 条高相关证据，正在生成正文`,
      details: [`使用绑定文件：${chapterEvidenceFiles.size} 份`, `上下文字符：${chapterEvidenceChars}`, `检索查询：${queries.length} 组`, ...retrievalDetails],
      progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '正文生成' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    session.global.emitProgress();
    session.planning.generationDiagnostics.evidence.contextChars += chapterEvidenceChars;
    const indexedFacts = factsForChapterNeeds(resolvedFactNeeds);
    const projectBasicFactsForChapter = session.planning.chapterIntentClassifier.needsBasicFacts(chapter.title) ? session.understanding.earlyFactPool.projectBasicFacts : [];
    // F3：事实覆盖清单预算封顶（全量注入是块级输入 L3 爆炸主因；被截断索引仍由绑定材料证据兑底）
    // F12 规格-部位对照表：同物多规格按部位区分使用的确定性依据随事实覆盖上下文注入 Writer
    const factCoverageContext = capFactCoverageContext(buildChapterFactCoverageContext({ chapter, plan: undefined, spec: session.prepare.documentSpec, roleFacts: matchedRoleContexts, evidence, missingFacts, indexedFacts: [...projectBasicFactsForChapter, ...indexedFacts], resolvedFactNeeds, factNeedsPrompt: factNeedsCoveragePrompt(resolvedFactNeeds), specAuthorityMap: session.understanding.preliminaryFactsModel.specAuthorityMap }));
    const chapterTaskResult = planChapterTask({ plan: session.planning.plannedDocument.plan, chapter, context: session.understanding.agentWorkflow, evidence });
    session.understanding.agentWorkflow.chapterTasks = [...(session.understanding.agentWorkflow.chapterTasks || []).filter(item => item.chapterId !== chapter.id), chapterTaskResult.task];
    session.understanding.agentWorkflow.nodes.push(chapterTaskResult.node);
    throttleAgentWorkflowNodes(session.understanding.agentWorkflow);
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: `agent-chapter-task-${chapter.id}`, status: chapterTaskResult.task.ready || resumedContent ? 'success' : 'failed', message: chapterTaskResult.task.ready ? chapterTaskResult.node.outputSummary || `${displayChapterTitle(chapter.title)} 章节任务规划完成` : resumedContent ? `${displayChapterTitle(chapter.title)} 章节任务未完全就绪，已复用已有正文并交由 Reviewer/Repairer 处理` : chapterTaskResult.node.outputSummary || `${displayChapterTitle(chapter.title)} 章节任务规划完成`, details: chapterTaskResult.task.issues.map(issue => issue.message) }, { subtitle: 'Agent Chapter Task Planner', order: session.global.progressStages.length }));
    session.global.emitProgress(session.global.chapterDrafts);
    if (!chapterTaskResult.task.ready && !resumedContent) throw new Error(`${displayChapterTitle(chapter.title)} 章节任务未就绪：${chapterTaskResult.task.issues.map(issue => issue.message).join('；')}`);
    const factNeedSummary = { total: resolvedFactNeeds.length, satisfied: resolvedFactNeeds.filter(item => item.status === 'satisfied').length, missing: resolvedFactNeeds.filter(item => item.status === 'missing').length, lowConfidence: resolvedFactNeeds.filter(item => item.status === 'low_confidence').length };
    for (const fact of requiredMissingNeeds) session.understanding.missingItems.push(`${chapter.title}：事实需求未确认 ${fact}`);
    // 章预算取值单源（预算表缺失/为 0 时按权威预算折算兜底并显式上屏，不再静默落硬编码 1200——
    // 该值会成为本章 roundTarget 与超产审计分母，下游无从分辨真假预算，见 resolveChapterBudgetTarget）
    const { budgetTarget, fallbackNote: chapterBudgetFallbackNote } = resolveChapterBudgetTarget({
      chapterTargets: session.planning.documentBudget.chapterTargets,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      documentTargetChars: session.planning.documentBudget.targetChars,
      chapterCount: session.planning.effectiveChapters.length,
    });
    const chapterBudgetDetails = chapterBudgetFallbackNote ? [chapterBudgetFallbackNote] : [];
    const sectionCount = chapter.sections?.filter(Boolean).length || 0;
    const targetPlan = chapterGenerationTargets({ budgetTarget, sectionCount, title: chapter.title, longformStrict: session.planning.documentBudget.longformStrict });
    const chapterMaxChars = Math.ceil(targetPlan.maxWords * (session.planning.documentBudget.maxChars ? 1.05 : 1));
    // 二期蓝图接管：章切片对象与参数桶 data 交由块级聚焦渲染（s1-slim：参数桶按块 token 条目级筛选、切片只展开块相关工作包）；
    // P14：整体校验未通过但本章所需权威全可用（blueprintGaps 为空）时，数值密集章仍注入章切片，
    // 避免放行章节无权威数值按证据独立成稿（非数值密集章维持现状：整体未通过不注入）
    // P17 语义化：章切片注入判定与阻断判定共用同一分类器（语义优先、正则兑底）
    const chapterNeedsBlueprintAuthority = chapterBlueprintAuthoritiesNeeded(chapter.title, session.planning.chapterIntentClassifier).length > 0;
    const chapterBlueprintSlice = (session.blueprint.blueprintActive || (chapterNeedsBlueprintAuthority && blueprintGaps.missing.length === 0)) && session.blueprint.integratedBlueprint
      ? findBlueprintChapter(session.blueprint.integratedBlueprint, chapter.title)
      : undefined;
    // 本章 must_cite 数值锚点清单（本章必须引用的计划类数值聚焦强约束，写作层抑制自编数值；章切片不再章级预渲染）
    const blueprintMustCiteHint = chapterBlueprintSlice && session.blueprint.integratedBlueprint ? renderBlueprintMustCiteValues(chapterBlueprintSlice, session.blueprint.integratedBlueprint.data) : '';
    const targetWords = targetPlan.roundTarget;
    // 长文模式：目标字数以提示词预算为准（roundTarget 已含完整章预算），不再被 structureTarget 二次压制；
    // 普通模式保留「结构承载量」上限，避免小节少时下达不切实际的整章目标
    const effectiveTargetWords = sectionCount > 0
      ? (session.planning.documentBudget.longformStrict ? targetWords : Math.min(targetWords, Math.max(1800, targetPlan.structureTarget)))
      : targetWords;
    // C1 管线收敛：章节无论小节数、有无蓝图统一走主题块单管线（buildChapterStructureFromBlueprint——
    // 蓝图章切片确定性转换，无切片时语义域分组确定性兜底，永不回退逐小节碎片化）
    // 规划驱动模式状态：块级成稿后按 H3/H4 标题对齐（达标契约：不再有章级 Reviewer/Repairer 补写循环）
    let plannedStructureRef: PlannedChapterStructure | undefined;
    // 小节级 checkpoint：小节完成时把“进行中章节”（含已完成小节正文）写入 checkpoint 快照，
    // 章节生成中途失败/中止时不丢已生成小节；节流 3 秒避免高频写盘
    let lastSectionCheckpointAt = 0;
    const emitSectionCheckpoint = (partialSections: Array<string | undefined>) => {
      const nowSectionCheckpoint = Date.now();
      if (nowSectionCheckpoint - lastSectionCheckpointAt < 3000) return;
      lastSectionCheckpointAt = nowSectionCheckpoint;
      const partialContent = partialSections.filter(Boolean).join('\n\n');
      if (!partialContent.trim()) return;
      session.global.emitProgress([...session.global.chapterDrafts, { id: chapter.id, title: chapter.title, content: `## ${chapter.title}\n\n${partialContent}`, evidence, missingFacts, sections: chapter.sections || [], tablePlans: chapter.tablePlans || [], inProgress: true }]);
    };
    const onSectionProgressForCheckpoint = (event: { phase: 'start' | 'complete' | 'retry'; partialSections?: Array<string | undefined> }) => {
      if (event.phase === 'complete' && event.partialSections) emitSectionCheckpoint(event.partialSections);
    };
    let content: string;
    // C7 章级超产对冲接纳审计记录（章 stage details 追加；全分支可见——接纳仅发生在计划块管线分支）
    let overProduceAcceptanceNote: string | undefined;
    // 4.55.30 章级显式降级记录（块失守 → 章照常成稿）：挂在草稿章节上，finalize 据此产出
    // structure/blocker（导出门禁 + 交付复核清单）；同时驱动本 stage 的三档状态（partial）
    let blockDegradation: ChapterBlockDegradation | undefined;
    if (resumedContent) {
      content = finalizeChapterContentQuality(resumedContent, chapter);
      content = await stripBidDisciplineSentencesSemantic(content, session.understanding.bidProcedureJudge);
      latestChapterStageForProgress = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'success',
        message: `${displayChapterTitle(chapter.title)} 已复用已有章节正文：当前 ${documentTextLength(content)} 字，跳过 Writer，直接进入章节收口`,
        details: [`有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, ...chapterBudgetDetails, '来源：resumeChapters/checkpointChapters'],
        progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '复用章节' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      session.global.progressStages[chapterProgressIndex] = latestChapterStageForProgress;
      session.global.emitProgress(session.global.chapterDrafts);
    } else {
      session.global.progressStages[chapterProgressIndex] = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'running',
        message: `${displayChapterTitle(chapter.title)} 正在规划主题块并准备并发成稿`,
        details: [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, targetPlan.label, `生成上限约 ${chapterMaxChars} 字`, ...chapterBudgetDetails, `模板细目：${chapter.sections?.length || 0} 条`, '先由章级 Planner 聚类为主题块并语义合并，再按主题块全并发出稿，避免逐小节碎片化'],
        progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '主题块并发' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      session.global.emitProgress();
      let llmContent: string | undefined;
      // C3 块级失败隔离定向重写器（章定向重写 1 次）：失败块按同一目标字数单独成稿并插回原位置
      //（成功块不动，不整章降级重写）。整章降级是历史缺陷「整章备用=整章失败重写」与全文字数雪崩的根因——
      // 单块质检未达标即全章重写，已成功的 2/3 内容全部作废；隔离重写只补失败块，成功块内容与 token 零浪费
      // 达标契约：重写不降标（历史 0.75/0.55 紧缩预算已删除），仍失败即章阻断、文档显式失败
      const retryFailedBlocks = async (buildInput: PlannedChapterContentInput, failedBlocks: PlannedChapterContentResult['failedBlocks'], sections: Array<string | undefined>): Promise<{ merged: Array<string | undefined>; exhausted: Array<{ index: number; title?: string; lastAttempt?: string; failureKinds?: string[]; retryFeedback?: string }> }> => {
        const retried = await Promise.all(failedBlocks.map(({ block, retryFeedback }) =>
          // 定向反馈携带（initialFeedback）：失败块单块重写 attempt=0 即注入上一轮缺陷原文（缺失要点点名等）——
          // 历史缺陷：无反馈的隔离重写从零生成，极易复现同一漏点（4.44 丰乐镇工期章 2 块全失败于气候要点）
          // isolatedRetry：单块重写失败不得被表述为「规划块全部失败」（blocks 只含 1 块，长度比较恒等）
          buildPlannedChapterContent({ ...buildInput, targetWords: block.targetWords, initialFeedback: retryFeedback, isolatedRetry: true }, { blocks: [block], coveredSections: [], fallbackSections: [] })
            .catch((error: unknown) => {
              // 降级治理：原实现丢弃异常对象 ⇒ 章阻断可见但**失败原因不可定位**（LLM 异常/超时/解析失败无差别）
              session.planning.generationDiagnostics.llm.lastError = `失败块定向重写异常（${chapter.title}）：${error instanceof Error ? error.message : String(error)}`;
              console.error(`[gen] 失败块定向重写异常（${chapter.title}）`, error);
              return undefined;
            })
        ));
        const merged = [...sections];
        // C7 对冲接纳痕迹回退链：重写轮仍失败时收集失守块（重写轮末轮痕迹优先——更接近收敛的尝试；
        // 重写轮无痕迹（如异常早退）回退首轮痕迹），供章收口判定「章级超产对冲接纳」
        const exhausted: Array<{ index: number; title?: string; lastAttempt?: string; failureKinds?: string[]; retryFeedback?: string }> = [];
        failedBlocks.forEach((original, position) => {
          // 剥壳后必须仍有正文才算重写成功：单块重写失败时 markdown 仅剩章标题壳（"## 标题"），
          // 若把空串写回 merged 会在后续 every 判定中暴露为未定义缺口块（此处保持原 undefined 语义）
          const body = retried[position]?.markdown?.replace(/^##\s+.+$/mu, '').trim();
          if (body) {
            merged[original.index] = body;
            return;
          }
          const retriedFailure = retried[position]?.failedBlocks?.[0];
          // title/retryFeedback 随失守块一路带到章收口（4.55.30）：显式降级记录与终门禁 blocker 需要
          // 「丢弃了哪一块、为什么」的原文定位依据，不能只剩 index
          exhausted.push({
            index: original.index,
            title: original.block?.title,
            lastAttempt: retriedFailure?.lastAttempt || original.lastAttempt,
            failureKinds: retriedFailure?.failureKinds || original.failureKinds,
            retryFeedback: retriedFailure?.retryFeedback || original.retryFeedback,
          });
        });
        return { merged, exhausted };
      };
      // 规划驱动管线（C1 管线收敛后为章节成稿唯一路径；三期收口：蓝图章切片→块结构确定性转换，零 LLM 调用）：
      // 蓝图小节/工作包映射主题块+H4 要点，相近细目语义合并进重写标题的 H4；
      // 本章无蓝图切片时由确定性语义域分组接管（永不回退逐小节碎片化成稿）
      // 容量规划收口（规划层一次成型）：块数 × 块预算 × 点配额已在 buildChapterStructureFromBlueprint 内完成，
      // 写作层不再有任何事后拆半/归并动作（原 splitSinglePointOversizedBlocks 已删除）
      let plannedStructure = await session.global.withProgressHeartbeat(() => measureGenerationStep(session.planning.generationDiagnostics, `chapter-plan:${chapter.id}`, async () =>
        buildChapterStructureFromBlueprint({ blueprintChapter: chapterBlueprintSlice, inputSections: chapter.sections || [], chapterTitle: displayChapterTitle(chapter.title), targetWords: effectiveTargetWords, projectContext: session.planning.projectContext, evidence })
      ));
      // L2 章级定名轮：撞名（指纹池）/退化标题信号门控——无信号零 LLM 调用；改名经确定性校验后应用
      const namingReview = await session.global.withProgressHeartbeat(() => governChapterBlockNames({
        chapterTitle: displayChapterTitle(chapter.title),
        blocks: plannedStructure.blocks.map(block => ({ title: block.title, pointTitles: block.subPoints.map(point => point.title) })),
        fingerprintPool: session.planning.fingerprintPool || loadFingerprintPool(),
        excludeDocumentId: session.global.input.diversitySeed,
        profile: session.planning.diversityProfile,
        signal: session.global.input.signal,
        diagnostics: session.planning.generationDiagnostics,
      }));
      if (namingReview.renamed > 0) {
        plannedStructure = { ...plannedStructure, blocks: plannedStructure.blocks.map((block, index) => ({ ...block, title: namingReview.titles[index]! })) };
      }
      if (plannedStructure.blocks.length > 0) {
        plannedStructureRef = plannedStructure;
        const plannedPromptTexts = [chapterPromptTexts, chapterTaskPromptForPlannedStructure(chapterTaskResult.task, plannedStructure)].filter(Boolean).join('\n\n');
        const h4Count = plannedStructure.blocks.reduce((sum, block) => sum + block.subPoints.length, 0);
        const mergedCount = plannedStructure.blocks.reduce((sum, block) => sum + block.subPoints.reduce((count, point) => count + Math.max(0, point.sources.length - 1), 0), 0);
        const plannerNote = chapterBlueprintSlice
          ? (plannedStructure.fallbackSections.length > 0 ? `（蓝图章切片确定性转换：${plannedStructure.fallbackSections.length} 条细目由覆盖校验挂回主题块）` : '（蓝图章切片确定性转换：主题块来自蓝图小节/工作包）')
          : '（蓝图未覆盖本章，已按语义域确定性分组）';
        session.global.progressStages[chapterProgressIndex] = displayStage({
          type: 'chapter_generation',
          roleId: 'chapter_generation',
          promptId: chapterPromptExecution.primaryPromptId,
          status: 'running',
          message: `${displayChapterTitle(chapter.title)} 已规划 ${plannedStructure.blocks.length} 个主题块，正在按主题块并发成稿${plannerNote}`,
          details: [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `输入细目 ${sectionCount} 条 → 主题块 ${plannedStructure.blocks.length} 个（每块 2~4 个 H4 要点）`, `语义合并 ${mergedCount} 条细目，目录级 H4 合计 ${h4Count} 个`, '单块 1800~2800 字，主题块间全并发，单节深度与整体耗时双优', ...(namingReview.summary ? [namingReview.summary] : [])],
          progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '主题块并发' },
        }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
        // 同步把「Agent Chapter Task Planner」stage 更新为规划驱动视角：
        // 细目任务卡是事实/证据分配单元，最终目录按主题块+H4 成稿，避免残留「N/N 个小节任务就绪」误导
        const chapterTaskStage = session.global.progressStages.find(stage => stage.roleId === `agent-chapter-task-${chapter.id}`);
        if (chapterTaskStage) {
          chapterTaskStage.message = `${chapterTaskResult.task.sections.filter(item => item.ready).length}/${chapterTaskResult.task.sections.length} 条细目任务就绪（已规划为 ${plannedStructure.blocks.length} 个主题块）`;
        }
        session.global.emitProgress(session.global.chapterDrafts);
        const plannedBuildInput: PlannedChapterContentInput = { template: session.prepare.template, chapter, evidence, missingFacts, promptTexts: plannedPromptTexts, projectContext: session.planning.chapterScopedProjectContext(chapter), skeletonProjectContext: session.planning.projectContext, requirement: session.global.input.requirement, roleContext, targetWords: effectiveTargetWords, forbidDrawingImages, bidComposition: session.understanding.bidComposition, factCoverageContext, compactProjectContext: true, scopedProjectContext: true, // G 线 P1-5：蓝图数据**按域下发**——原为「validation.passed ? data : undefined」的全有全无：
          // 任一校验未过即整套蓝图都不注入，于是「劳动力不可用」会连带掐断进度/清单/图纸等
          // 完全可用的权威，章级损失被放大成篇级损失。现按 authorityAvailability 逐域过滤，
          // 不可用域清零、其余照常；整体 passed=false 时仍不注入（该校验失败含清单缺失等
          // 全域性缺口，见 validate.ts 的零权威骨架蓝图防护）。
          blueprintData: blueprintDataForChapterInjection(session.blueprint.integratedBlueprint),
          blueprintChapter: chapterBlueprintSlice, blueprintMustCiteHint, sectionEvidenceProvider: sectionEvidenceForChapter, onSectionProgress: onSectionProgressForCheckpoint, diagnostics: session.planning.generationDiagnostics, signal: session.global.input.signal };
        const plannedFirst = await session.global.withProgressHeartbeat(() => measureGenerationStep(session.planning.generationDiagnostics, `chapter-planned-block-draft:${chapter.id}`, () =>
          buildPlannedChapterContent(plannedBuildInput, plannedStructure)
        ));
        if (plannedFirst?.allSucceeded) {
          llmContent = plannedFirst.markdown;
        } else if (plannedFirst) {
          // C3：失败块定向重写 1 次（同一目标字数、块写作合同不降标），全部成功即拼回完整章节；
          // 仍失败即章阻断、文档显式失败（方案 2.1：块失败 → 章定向重写 1 次 → 章失败 → 文档显式失败；
          // 旧「整章备用」降级与多轮重试路径已随 C1 管线收敛删除，成功块不再被整章重写作废）
          const retryOutcome = await retryFailedBlocks(plannedBuildInput, plannedFirst.failedBlocks, plannedFirst.sections);
          if (retryOutcome.merged.every((section): section is string => Boolean(section))) {
            llmContent = `## ${chapter.title}\n\n${retryOutcome.merged.join('\n\n')}`;
          } else {
            // C7 章级超产对冲接纳（r28m 根因补链）：隔离重写耗尽后，失守块若全部为「末轮仅篇幅超产」
            // 且填回后章总量 ∈ [0.85,1.2]×块预算合计（块容差只吸收末轮抖动，累计放大由章级审计
            // 与文档级阻断线兜底），接纳末轮内容成章——消除「单块微超产 → 整块丢弃 → 整章阻断 →
            // 文档缺章」的不对称损失；非篇幅类缺陷混入/严重超产/无末轮内容一律照旧章阻断（零静默降级）
            const acceptance = salvageChapterByOverProduceAcceptance({
              sections: retryOutcome.merged,
              exhaustedBlocks: retryOutcome.exhausted,
              blockTargetWords: plannedStructure.blocks.map(block => block.targetWords),
            });
            if (acceptance) {
              llmContent = `## ${chapter.title}\n\n${acceptance.sections.join('\n\n')}`;
              overProduceAcceptanceNote = acceptance.detail;
              console.error(`[gen][chapter-audit] ${acceptance.detail}：${displayChapterTitle(chapter.title)}`);
              session.planning.generationDiagnostics.llm.lastInfo = acceptance.detail;
            } else {
              // 4.55.30 章级显式降级（C7 不适用后的第二级，判据只有「成功块 > 0」）：
              // 隔离重写耗尽、超产对冲不适用（非篇幅类失守）时，**保留全部成功块**成章，失守块不产出正文
              //（不填兜底内容——与 buildPlannedChapterContent 的达标契约同口径），缺失由记录显式承载。
              // 动机（doc-1790115927170-f00280f9）：34 块仅 1 块失守，其余 33 块已完成却被整章丢弃 →
              // 目标 5.0 万字成 3.36 万字、清单落位 52.8%、总分 85→83。全失败仍照旧章阻断（零放松）。
              const degradation = assessChapterBlockDegradation({
                sections: retryOutcome.merged,
                blockTitles: plannedStructure.blocks.map(block => block.title),
                exhaustedBlocks: retryOutcome.exhausted,
              });
              if (degradation) {
                llmContent = `## ${chapter.title}\n\n${retryOutcome.merged.filter((section): section is string => Boolean(section && section.trim())).join('\n\n')}`;
                blockDegradation = degradation;
                const { head, details } = chapterDegradationStageText(degradation);
                const audit = `${displayChapterTitle(chapter.title)} 章级显式降级：${head}（失败原因：${degradation.droppedBlocks.map(block => block.reason).join('；')}）——已保留其余块正文，失守块不产出正文，已登记 structure/blocker 进导出门禁与交付复核清单`;
                console.error(`[gen][chapter-audit] ${audit}`);
                console.error(`[gen][chapter-audit] 降级明细：${details.slice(1).join(' | ')}`);
                session.planning.generationDiagnostics.llm.lastInfo = audit;
              }
            }
          }
        }
      }
      if (!llmContent) {
        // 达标契约：LLM 未返回有效正文时不进入任何降级链（紧凑备用/失败原因重试/证据骨架已删除）——
        // 块级隔离重试（同标准）已在前置流程耗尽，残留失败直接阻断生成，拒绝低质量兜底正文静默成文
        session.planning.generationDiagnostics.llm.lastError = session.planning.generationDiagnostics.llm.lastError || '全部成稿路径未返回有效正文';
      }
      // B3 确定性对齐：章节成稿后，must_cite+strict 槽位数值与蓝图章切片不一致时按蓝图回填
      // （只替换数字本身、不动句式）；未引用缺口进观测交由跨章一致性审查兑底。
      // 对齐覆盖主题块成稿路径（C1 管线收敛后章节成稿唯一路径）；蓝图未覆盖本章时跳过
      // G 线 P2-1 占位符填充：**必须先于写后对齐**——先由权威层把 `{{AUTH:<path>}}` 填成真值，
      // 写后对齐才有值可对；顺序反了会让对齐面对占位符文本做正则替换，行为不可预期。
      // 失效模式已设计为降级：模型不写占位符 ⇒ 本步 no-op，正文与历史完全一致。
      // 未决（path 无权威值）与畸形 token 一律**保留原样**并上报——不静默删除（P2-2 口径）。
      if (llmContent && session.blueprint.integratedBlueprint) {
        const fill = fillAuthorityPlaceholders(llmContent, session.blueprint.integratedBlueprint.data);
        if (fill.filled.length > 0) llmContent = fill.markdown;
        if (fill.unresolved.length > 0 || fill.malformed.length > 0) {
          session.understanding.missingItems.push(`${chapter.title}：权威占位符未决 ${fill.unresolved.length} 处（${fill.unresolved.slice(0, 4).join('、')}）${fill.malformed.length > 0 ? `；畸形 ${fill.malformed.length} 处` : ''}`);
          session.planning.generationDiagnostics.llm.lastInfo = `权威占位符未决：${chapter.title} ${fill.unresolved.length} 处无权威值、${fill.malformed.length} 处畸形（均保留原样，不静默删除）`;
        }
      }
      if (llmContent && chapterBlueprintSlice && session.blueprint.integratedBlueprint) {
        const aligned = alignChapterContentToBlueprint(llmContent, chapterBlueprintSlice, session.blueprint.integratedBlueprint.data);
        if (aligned.fixed.length > 0) {
          llmContent = aligned.markdown;
          session.planning.generationDiagnostics.llm.lastInfo = `蓝图引用对齐：${chapter.title} 回填 ${aligned.fixed.length} 处（${aligned.fixed.map(item => `${item.anchor} ${item.from}→${item.to}`).join('、')}）${aligned.missing.length ? `；未引用缺口 ${aligned.missing.length} 项：${aligned.missing.join('、')}` : ''}`;
        } else if (aligned.missing.length > 0) {
          session.planning.generationDiagnostics.llm.lastInfo = `蓝图引用缺口观测：${chapter.title} 未在正文引用 ${aligned.missing.length} 项 must_cite 参数（${aligned.missing.slice(0, 6).join('、')}${aligned.missing.length > 6 ? ' 等' : ''}），由跨章一致性审查兑底`;
        }
      }
      // 批2-1 写时对齐（铁律：质量在写时）：阶段劳动力数值 vs 蓝图 byPhase 权威（同源扫描+降序硬替换+复检回滚），
      // 章内一次性消灭跨章多口径漂移（丰乐镇实测 216/85/216/216 四口径）；检测器/确定性修复轮为安全网兑底
      if (llmContent && session.blueprint.integratedBlueprint) {
        const phaseLaborAligned = fixPhaseLaborValues(llmContent, blueprintPhaseLaborAuthorities(session.blueprint.integratedBlueprint.data));
        if (phaseLaborAligned.fixedCount > 0) {
          llmContent = phaseLaborAligned.markdown;
          const priorInfo = session.planning.generationDiagnostics.llm.lastInfo;
          session.planning.generationDiagnostics.llm.lastInfo = `${priorInfo ? `${priorInfo}；` : ''}阶段劳动力口径对齐：${chapter.title} 回填 ${phaseLaborAligned.fixedCount} 处（${phaseLaborAligned.details.join('、')}）`;
        }
      }
      throwIfAborted(session.global.input.signal);
      if (!llmContent) {
        // 4.35 归因修正：历史消息把「块质检不达标 → 章阻断」统一表述为“大模型未返回有效正文”，
        // 把质检失守误导为模型空响应（舒城实测 9 章实为块篇幅合同失守）。此处呈现真实阻断归因
        const failureReason = session.planning.generationDiagnostics.llm.lastError || '空响应或超时';
        const message = `${displayChapterTitle(chapter.title)} 正文未达到成稿要求，已阻断生成（${failureReason.slice(0, 160)}）`;
        session.global.progressStages[chapterProgressIndex] = displayStage({
          type: 'chapter_generation',
          roleId: 'chapter_generation',
          promptId: chapterPromptExecution.primaryPromptId,
          status: 'failed',
          message,
          details: [`阻断归因：${failureReason}`, `证据条数：${evidence.length}`],
          progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '章节阻断' },
        }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
        session.global.emitProgress(session.global.chapterDrafts);
        throw new Error(message);
      }
      const chapterContent = llmContent;
      if (!chapterContent.trim()) {
        throw new Error(`${displayChapterTitle(chapter.title)} 首次生成失败，未获得可用于定稿的正文`);
      }
      // C2 标题对齐全覆盖：全部成稿路径（主题块/小节/整章/备用/重试）都把正文 H3/H4 对齐回生成前规划标题。
      // 分层对齐（H3 与 H4 分开）规避跨级误配（「施工部署」块标题把「施工部署与流水组织」H4 改写掉）；
      // 主题块管线 H3=块标题、H4=要点标题，逐小节/平铺管线 H3=规划小节
      const plannedH3Titles = plannedStructureRef && plannedStructureRef.blocks.length > 0
        ? plannedStructureRef.blocks.map(block => block.title)
        : (chapter.sections || []).filter(Boolean);
      const plannedH4Titles = plannedStructureRef && plannedStructureRef.blocks.length > 0
        ? plannedStructureRef.blocks.flatMap(block => block.subPoints.map(point => point.title))
        : [];
      let alignedContent = llmContent;
      // r11 近名兜底（丰乐镇门禁 #1 归因）：H3 层开启近名轮——模型单字改写规划标题（「分区落位→分区落实」实测）
      // 在包含口径下零命中，错字标题不进目录但缺节判定成立触发补写、补写版与错字版并存直坠 section-count-overflow；
      // H4 层不开启（块级要点标题由 alignSimilarHeadingsToPlan 另行对齐，避免跨层认领）
      if (plannedH3Titles.length > 0) alignedContent = alignSectionHeadingsToPlan(alignedContent, plannedH3Titles, 3, { nearMatch: true });
      if (plannedH4Titles.length > 0) alignedContent = alignSectionHeadingsToPlan(alignedContent, plannedH4Titles, 4);
      content = finalizeChapterContentQuality(alignedContent, chapter);
      content = await stripBidDisciplineSentencesSemantic(content, session.understanding.bidProcedureJudge);
    }
    const factUsageIssues = await chapterSectionFactUsageIssues({ chapter, content, evidence });
    const chapterChars = documentTextLength(content);
    // 4.40 章级篇幅审计：章完成率 >1.2× 本轮目标即登记超产告警——块级双向硬合同是主拦截面，
    // 章级超产是块级容差超产的累计放大面，此处为文档级阻断线（目标总额 +20%）的早发现观测点；
    // 不改变 chapterCompletionStatus 语义（字数是质量信号，不单独构成章失败）。
    // C7：章级对冲接纳（≤1.2×，见章收口分支）之后的残留超产（>1.2×）在此登记告警——
    // 接纳吸收累计抖动、告警观测文档级放大，与块容差线（1.15/1.2×）/文档阻断线同口径分层
    const chapterOverProducePercent = targetPlan.roundTarget > 0 ? Math.round(chapterChars / targetPlan.roundTarget * 100) : 0;
    const chapterOverProduce = targetPlan.roundTarget > 0 && chapterChars > Math.ceil(targetPlan.roundTarget * 1.2);
    if (chapterOverProduce) {
      console.error(`[gen][chapter-audit] 章篇幅超产 ${chapterOverProducePercent}%（${chapterChars} 字 vs 本轮目标 ${targetPlan.roundTarget} 字，终稿篇幅阻断线为目标总额 +20%）: ${displayChapterTitle(chapter.title)}`);
    }
    const generatedSectionsForReview = extractGeneratedSections(content);
    // C1 目录确定性：draft.sections 必须等于生成前规划大纲（主题块管线=块标题，其余=规划小节），
    // 不得从正文提取——正文 H3 被 LLM 改写后提取进目录是「目录污染」的直接源头；仅无任何规划来源时才提取兜底。
    // 相邻同名去重（防御性）：容量规划归并后的相邻块标题若归一化同名（章级拼接剥壳后正文只合并为一个小节），
    // sections 元数据不去重会在目录/检查器侧双写同名小节（11 章相邻重复小节根因）
    const plannedSectionTitlesRaw = plannedStructureRef && plannedStructureRef.blocks.length > 0 ? plannedStructureRef.blocks.map(block => block.title) : (chapter.sections || []).filter(Boolean);
    const plannedSectionTitles = plannedSectionTitlesRaw.filter((title, index) => title !== plannedSectionTitlesRaw[index - 1]);
    const sections = plannedSectionTitles.length > 0 ? plannedSectionTitles : (generatedSectionsForReview.length > 0 ? generatedSectionsForReview : []);
    const expandedSectionIssues = sectionContentIntegrityIssues(content, [{ title: chapter.title, content, sections }]).map(issue => issue.message);
    const factUsageWarnings = factUsageIssues.slice(0, 6).map(issue => `小节事实密度需优化：${issue}`);
    const chapterIssues = [...expandedSectionIssues, ...factUsageWarnings];
    // 4.55.30 降级章状态：块失守章不再走 chapterCompletionStatus 的 failed（失守块使「缺少规划小节」
    // 成立，但那只是「少一块」而非「章未产出」），改用三档词汇的 partial（黄灯：有净损失、章已产出，
    // 缺口由 blocker + 复核清单消费）；判据与修复轮同源（plannedBlocks → droppedBlocks）。
    const degradedStage = blockDegradation ? chapterDegradationStageText(blockDegradation) : undefined;
    const chapterStatus = blockDegradation
      ? blockDeliveryOutcomeStatus({ plannedBlocks: blockDegradation.plannedBlocks, droppedBlocks: blockDegradation.plannedBlocks - blockDegradation.deliveredBlocks })
      : chapterCompletionStatus(chapterChars, targetWords, chapterIssues);
    latestChapterStageForProgress = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: chapterPromptExecution.primaryPromptId,
      status: chapterStatus,
      message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已由大模型成稿：当前 ${chapterChars} 字${degradedStage ? `；${degradedStage.head}` : ''}；章节预算约 ${targetPlan.budgetTarget} 字，本轮目标约 ${targetPlan.roundTarget} 字${chapterIssues.length ? `；待优化：${chapterIssues.slice(0, 8).join('、')}` : ''}`, chapterStartedAt),
      details: [`本轮完成率：${chapterOverProducePercent}%`, `结构目标约 ${targetPlan.structureTarget} 字`, ...chapterPromptDetails, ...chapterBudgetDetails, `二级小节：${sections.length} 个`, ...(degradedStage ? degradedStage.details : []), ...(chapterOverProduce ? [`篇幅审计：章超产（${chapterChars} 字 vs 本轮目标 ${targetPlan.roundTarget} 字，终稿篇幅阻断线为目标总额 +20%）`] : []), ...(overProduceAcceptanceNote ? [overProduceAcceptanceNote] : [])],
      progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: blockDegradation ? '章节降级成稿' : (chapterIssues.length ? '章节已生成' : '章节达标') },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    session.understanding.chapterGenerationStagesByOrder[chapterOrder] = latestChapterStageForProgress;
    // P2：生成阶段结束，章节收口作为延迟任务返回，由审查池调度（与后续批次章节生成流水线重叠）
    return async (): Promise<void> => {
      // 达标契约收口：初稿质量由达标契约（minWords=目标、块质检 0.9×目标）保证，
      // 不再运行章级 Reviewer/Repairer 补写循环（历史缺陷：审查修复成为 token 主力军，
      // 补写落位锚点随成稿变化全部失效）。跨章一致性/数据一致性问题统一在
      // 初稿完成后的全局一致性审查阶段冻结问题清单并定向修复
      //（4.41 起章级确定性补写已删除：评分项响应责任前移至写作侧，缺口由检测器报出后走 LLM 修复/导出门禁）
      const draftChapter = blockDegradation
        // 4.55.30：降级记录随草稿章节入 finalize（buildValidationIssues 按同一对象引用读取并产出
        // structure/blocker 进导出门禁与交付复核清单）——降级必须显式，绝不静默
        ? attachChapterBlockDegradation({ id: chapter.id, title: chapter.title, content, evidence, missingFacts, sections, tablePlans: chapter.tablePlans || [] }, blockDegradation)
        : { id: chapter.id, title: chapter.title, content, evidence, missingFacts, sections, tablePlans: chapter.tablePlans || [] };
      session.understanding.chapterDraftsByOrder[chapterOrder] = draftChapter;
      session.global.chapterDrafts = session.understanding.chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
      session.global.emitProgress(session.global.chapterDrafts);
    };
    } catch (err) {
      if (session.global.input.signal?.aborted) throw err;
      // 章节失败根因观测：llm.lastError 记录最后一次 LLM 调用失败的真实原因（空响应/限流/超时/质检未达标），
      // 历史上 catch 块只保留通用阻断消息，真实根因随进度节流丢失，导致间歇性失败无法归因
      const llmLastError = session.planning.generationDiagnostics.llm.lastError;
      const llmStats = `failures=${session.planning.generationDiagnostics.llm.failures} retries=${session.planning.generationDiagnostics.llm.retries} reasoningTokens=${session.planning.generationDiagnostics.llm.reasoningTokens || 0}`;
      console.error(`[gen] chapter ${chapter.title} failed:`, err, llmLastError ? `| LLM lastError: ${llmLastError}` : '| LLM lastError: (none)', '|', llmStats);
      const failureMessage = `${chapter.title}：${err instanceof Error ? err.message : '生成失败'}`;
      session.understanding.failedChapterMessages.push(failureMessage);
      latestChapterStageForProgress = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'failed',
        message: `${displayChapterTitle(chapter.title)} 生成失败：${failureMessage}`,
        details: [`LLM 最近错误：${llmLastError || '无记录'}`, `LLM 调用失败 ${session.planning.generationDiagnostics.llm.failures} 次、重试 ${session.planning.generationDiagnostics.llm.retries} 次`],
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      session.understanding.chapterGenerationStagesByOrder[chapterOrder] = latestChapterStageForProgress;
    }
    // 章节生成完成（成功或失败）→ 汇报进度
    if (latestChapterStageForProgress) session.global.progressStages[chapterProgressIndex] = latestChapterStageForProgress;
    session.global.emitProgress(session.global.chapterDrafts);
    }));
    // P2：本批章节全部生成完毕，审查修复任务排入审查池（reviewConcurrency 限流），与下一批章节生成重叠
    for (const reviewTask of batchTasks) {
      if (!reviewTask) continue;
      session.blueprint.reviewTaskPool.push(session.blueprint.reviewSemaphore.run(reviewTask));
    }
  }
  // P2：等待全部章节审查修复完成；chapterDraftsByOrder 按章节序写入，跨章引用修复安全
  await Promise.all(session.blueprint.reviewTaskPool);
  // 4.2 阶段瀑布：成稿期（含章级审查）收口 → 全局轮起点
  session.planning.generationDiagnostics.metrics.push({ name: 'phase:draft', startedAt: session.chapterLoop.draftPhaseStartedAt, endedAt: Date.now(), durationMs: Date.now() - session.chapterLoop.draftPhaseStartedAt });
  session.chapterLoop.globalReviewPhaseStartedAt = Date.now();
  session.chapterLoop.chapterDraftsFinal = session.understanding.chapterDraftsByOrder.filter((item): item is DocumentDraftChapter => Boolean(item));
  session.understanding.chapterGenerationStages.push(...session.understanding.chapterGenerationStagesByOrder.filter((item): item is DocumentExecutionStage => Boolean(item)));
}

