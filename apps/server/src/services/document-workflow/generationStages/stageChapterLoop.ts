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
import { documentTextLength } from '../budget';
import { sectionContentIntegrityIssues } from '../qualityValidation';
import { chapterCriteriaText } from '../constructionBidStructure';
import { buildSemanticSimilarity } from '../semanticSimilarity';
import { evidenceSafetyKey } from '../evidenceContentSafety';
import { normalizeChapterTitleLine } from '../tenderRequirements';
import { buildChapterFactNeeds, factNeedsCoveragePrompt, factsForChapterNeeds, resolveChapterFactNeeds } from '../factsModel';
import { QUANTIFIED_FACT_RE } from '../parameterPatterns';
import { chapterSectionFactUsageIssues } from '../chapterReview';
import { retrieveWebEvidence } from '../webResearchService';
import { buildChapterReadinessPlan } from '../chapterReadiness';
import { chapterTaskPrompt, chapterTaskPromptForPlannedStructure, planChapterTask } from '../agentPlanner';
import { throttleAgentWorkflowNodes } from '../agentWorkflow';
import { governEvidenceValues, renderScopeOverrideAnchors } from '../factGovernance';
import { filterEvidenceByProjectScope, assertEvidenceInProjectScope } from '../projectMaterialScope';
import { alignSectionHeadingsToPlan, runWithAdaptiveConcurrency, stableHash, throwIfAborted } from '../utils';
import { displayStage, elapsedMessage, upsertProgressStage } from '../progress';
import { getActiveModelWithProvider } from '../llmClient';
import { evidenceInScope, measureGenerationStep } from '../rolePipeline';
import { buildRetrievalCoverageReport, retrieveDeepChapterEvidence, shouldTriggerDeepRetrieval } from '../documentEvidenceRetrieval';
import { chapterRelevanceTokens, renderBillFactLockText } from '../billFactLock';
import { retrievePlannedMaterialEvidence, sampleProjectMaterialEvidence } from '../projectMaterialProfile';
import { buildChapterFactCoverageContext, buildLlmChapterContent, buildPlannedChapterContent, buildSectionParallelChapterContent, capFactCoverageContext, evidenceForSection, outputTokensForChapter } from '../chapterGeneration';
import type { PlannedChapterContentInput, PlannedChapterContentResult } from '../chapterGeneration';
import { chapterCompletionStatus, chapterGenerationTargets, compactChapterQueries, finalizeChapterContentQuality, optimizeChapterEvidence, preselectSemanticCandidates, resolveChapterPromptExecution, retrieveSectionEvidence, semanticEvidenceText, stripBidDisciplineSentencesSemantic } from '../documentGeneratorHelpers';
import { alignChapterContentToBlueprint, buildChapterStructureFromBlueprint, chapterBlueprintAuthoritiesNeeded, chapterBlueprintAuthorityGaps, findBlueprintChapter, renderBlueprintChapterSlice, renderBlueprintMustCiteValues, splitSinglePointOversizedBlocks } from '../integratedBlueprint';
import type { BlueprintAuthorityId, PlannedChapterStructure } from '../integratedBlueprint';
import { extractGeneratedSections } from '../markdownComposer';

export async function stageChapterLoop(session: GenerationSession): Promise<void> {
  // 4.2 阶段瀑布：规划期收口 → 成稿期起点（成稿主循环含章级审查修复流水线重叠，合并记 phase:draft）
  session.planning.generationDiagnostics.metrics.push({ name: 'phase:plan', startedAt: session.planning.planPhaseStartedAt, endedAt: Date.now(), durationMs: Date.now() - session.planning.planPhaseStartedAt });
  session.chapterLoop.draftPhaseStartedAt = Date.now();
  for (let chapterOffset = 0; chapterOffset < session.planning.effectiveChapters.length; chapterOffset += session.blueprint.chapterConcurrency) {
    const chapterBatch = session.planning.effectiveChapters.slice(chapterOffset, chapterOffset + session.blueprint.chapterConcurrency);
    const batchTasks = await Promise.all(chapterBatch.map(async (chapter, batchIndex): Promise<(() => Promise<void>) | undefined> => {
    const chapterOrder = chapterOffset + batchIndex;
    throwIfAborted(session.global.input.signal);
    // P14 蓝图分层权威阻断（源头治理）：蓝图构建失败/校验未通过时全文参数桶不注入，
    // 数值密集型章（劳动力/资源/进度）按「本章所需权威任一不可用」判定阻断（替代整体二元 passed）——
    // 部分校验失败（如覆盖校验）不再连坐权威未受损的章节；仍拒绝「按证据独立成稿」静默产出自编数值
    //（劳动力 625/42 三套口径的历史根因）
    const blueprintGaps = session.blueprint.blueprintActive
      ? { missing: [] as BlueprintAuthorityId[], failedChecks: [] as string[] }
      : chapterBlueprintAuthorityGaps(chapter.title, session.blueprint.integratedBlueprint?.validation, session.planning.chapterIntentClassifier);
    if (blueprintGaps.missing.length > 0) {
      const failedCheckText = blueprintGaps.failedChecks.length > 0 ? `蓝图校验项「${blueprintGaps.failedChecks.join('、')}」未通过` : '蓝图校验未通过或构建异常';
      session.global.progressStages.push(displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        status: 'failed',
        message: `${displayChapterTitle(chapter.title)} 依赖蓝图权威 [${blueprintGaps.missing.join('、')}]，${failedCheckText}，已按节点级把关阻断生成`,
        details: ['数值密集型章所需蓝图权威不可用时禁止无权威成稿', '请检查清单解析与蓝图构建诊断后重试'],
        progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '章节阻断' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder }));
      session.global.emitProgress();
      throw new Error(`${displayChapterTitle(chapter.title)} 依赖蓝图权威 [${blueprintGaps.missing.join('、')}]，${failedCheckText}，已按节点级把关阻断生成`);
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
      const scopedPathList = [...session.understanding.availableEvidenceScopePaths];
      // 模糊路径解析：图谱LLM可能返回短路径（如"招标文件.pdf"），解析为KB精确路径
      const resolveExactPath = (fuzzy: string): string | undefined => {
        if (scopedPathList.includes(fuzzy)) return fuzzy;
        return scopedPathList.find(p => p.endsWith(fuzzy) || p.includes(fuzzy));
      };
      const graphFileList = [...graphMapping.graphFiles]
        .map(f => resolveExactPath(f) || f)
        .filter(f => evidenceInScope(session.prepare.projectRoot, f, session.understanding.availableEvidenceScopePaths));
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
    // D2 清单专用查询构造：清单事实锁中与本章相关的条目名/特征构造精确查询——数值型清单行在向量空间弱势，
    // 词面精确查询兑底（历史缺陷：清单条目证据竞争不过高语义匹配的招标文件切片，条目行从不被召回）
    const billItemQueries = session.blueprint.billFactLock
      ? (() => {
        const billTokens = chapterRelevanceTokens(chapter.title, chapter.sections || []);
        return session.blueprint.billFactLock.entries
          .filter(entry => entry.name && billTokens.some(token => entry.name.includes(token) || entry.description.includes(token) || entry.section.includes(token)))
          .slice(0, 6)
          .map(entry => `${entry.name} ${entry.description} ${entry.quantity}${entry.unit}`.trim().slice(0, 80));
      })()
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
    if (cachedIntentEvidence.length > 0) rawEvidence.push(...cachedIntentEvidence);
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
      const parallelResults = await runWithAdaptiveConcurrency(mergedSearchQueries, async query => session.understanding.searchWithCache(query, scopedFilePaths, Math.min(session.understanding.requestedEvidencePerChapter, 12), chapter.title), { kind: 'search' });
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
      rawEvidence.push(...results
        .filter((item: KbSearchResult) => evidenceInScope(session.prepare.projectRoot, item.filePath, session.understanding.evidenceScopePaths))
        .map((item: KbSearchResult) => ({
          chapterId: chapter.id,
          filePath: item.filePath,
          score: item.score,
          content: item.content,
          roleId: session.understanding.fileRoleByPath.get(item.filePath),
          processingType: session.understanding.fileProcessingByPath.get(item.filePath),
          sectionTitle: item.sectionTitle,
          source: item.source,
        })));
    }
    // P1-5：概况/质量/进度类章节直接取用跨章预执行的基础事实检索结果（resumed 章节跳过，与原检索语义一致）
    if (usesCachedBasicFacts && scopedFilePaths.length > 0 && session.blueprint.basicFactSearchResults.length > 0) {
      rawEvidence.push(...session.blueprint.basicFactSearchResults
        .filter(item => evidenceInScope(session.prepare.projectRoot, item.filePath, session.understanding.evidenceScopePaths))
        .map(item => ({
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
    const plannedMaterialEvidence = resumedContent ? [] : await retrievePlannedMaterialEvidence({ manager: session.understanding.manager, projectRoot: session.prepare.projectRoot, chapter, plan, profile: session.prepare.projectMaterialProfile, scopedFilePaths, limitPerQuery: Math.min(session.understanding.requestedEvidencePerChapter, 10), signal: session.global.input.signal }).catch(() => []);
    rawEvidence.push(...plannedMaterialEvidence);
    const pinnedEvidencePaths = new Set<string>((chapter.pinnedEvidenceFilePaths || []).filter(Boolean));
    const matchedRoleContexts: Array<{ fact: never }> = [];
    if (session.planning.chapterIntentClassifier.needsBasicFacts(chapter.title)) rawEvidence.push(...session.understanding.safeProjectBasicEvidence.map(item => ({ ...item, chapterId: chapter.id, source: 'pinned-evidence' })));
    // round-20 S5/W7 P6-2：招标文件/投标须知类文件整文件 pinned 注入到概况/总述类章节——
    // 要求来源文件不得被检索召回截断（招标要求未写入正文的根因是要求原文根本没进 prompt）；
    // pinned 证据在预算截断时优先级最高，招标内容优先于其他证据进入；
    // 证据内容安全分区后取放行子集（writerEvidence），评标纪律/评标办法章节不进写手输入
    const tenderFileEvidence = session.understanding.writerEvidence.filter(item => /招标|投标须知|评标办法|专用合同条款|投标人须知/u.test(`${item.filePath || ''}${item.sectionTitle || ''}`));
    if (/概况|工程|项目|总体|部署/u.test(chapter.title) && tenderFileEvidence.length > 0) rawEvidence.push(...tenderFileEvidence.map(item => ({ ...item, chapterId: chapter.id, source: 'pinned-evidence' as const })));
    const chapterPinnedPaths = new Set([...pinnedEvidencePaths]);
    // 模板 pinned 文件整文件全量注入（不再按字符预算截断，截断即要求条款丢失）
    for (const relativePath of chapterPinnedPaths) {
      if (!evidenceInScope(session.prepare.projectRoot, relativePath, session.understanding.evidenceScopePaths)) continue;
      const isPinnedEvidence = pinnedEvidencePaths.has(relativePath);
      const detail = session.understanding.getCachedFileDetail(relativePath);
      if (!detail) continue;
      rawEvidence.push(...(detail.chunks as Array<{ content: string; sectionTitle?: string }>).map(chunk => ({
        chapterId: chapter.id,
        filePath: detail.file.relativePath,
        score: 1,
        content: chunk.content,
        roleId: session.understanding.fileRoleByPath.get(detail.file.relativePath),
        processingType: session.understanding.fileProcessingByPath.get(detail.file.relativePath),
        sectionTitle: chunk.sectionTitle,
        source: isPinnedEvidence ? 'pinned-evidence' : 'bound-file',
      })));
    }
    let scopedEvidence = rawEvidence.filter(item => evidenceInScope(session.prepare.projectRoot, item.filePath, session.understanding.availableEvidenceScopePaths));
    if (!resumedContent && session.prepare.webAccessConfig.enabled && session.prepare.webAccessConfig.allowProjectFacts) {
      const webResult = await retrieveWebEvidence({ config: session.prepare.webAccessConfig, chapterId: chapter.id, chapterTitle: chapter.title, sectionTitles: chapter.sections || [], runtimeRules: session.prepare.runtimePromptRules, localFacts: [...session.understanding.preliminaryFactsModel.project, ...session.understanding.preliminaryFactsModel.schedule, ...session.understanding.preliminaryFactsModel.quality, ...session.understanding.preliminaryFactsModel.safety, ...session.understanding.preliminaryFactsModel.resources, ...session.understanding.preliminaryFactsModel.preciseFacts], signal: session.global.input.signal });
      session.understanding.webResearchReport.queries.push(...webResult.queries);
      session.understanding.webResearchReport.filteredCount += webResult.filtered + webResult.evidence.length;
    }
    const sampledEvidence = resumedContent ? [] : sampleProjectMaterialEvidence({ project: session.understanding.project, chapter, plan, profile: session.prepare.projectMaterialProfile, scopedFilePaths, highRisk: session.understanding.rolePoolRisk.highRisk });
    // 单次过滤：rawEvidence（上方仅做过路径域过滤）与 sampledEvidence 统一在此过一次项目资料口径过滤，
    // 不再对 sampled 先预过滤再随全量二次过滤（历史冗余：同一批 sampled 证据被过滤两遍）
    if (sampledEvidence.length > 0) scopedEvidence.push(...sampledEvidence);
    scopedEvidence = filterEvidenceByProjectScope(scopedEvidence, session.understanding.projectMaterialScope);
    // 写作链证据安全过滤：投标/评标纪律、评标办法、商务报价类证据（含搜索召回/深召回路径）不进写手与事实需求链
    if (session.understanding.excludedEvidenceKeys.size > 0) scopedEvidence = scopedEvidence.filter(item => !session.understanding.excludedEvidenceKeys.has(evidenceSafetyKey(item)));
    // P1 语义排序：章节证据按“章查询 ↔ 证据文本”本地 bge-small 余弦排序（语义主键，证据全量保留、无预算截断）。
    // 4.12.16 候选池词面粗筛：全量 ~1.5 万条本地嵌入是检索段 CPU 瓶颈（实测 20+ 分钟），
    // 先按词面/重要性分数取 topN 候选（默认 3000），仅候选池嵌入，未入池条目语义分为 0 退回 baseScore 口径
    const semanticTopCandidates = (() => {
      const raw = Number(process.env.DOCUMENT_SEMANTIC_TOP_CANDIDATES);
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3000;
    })();
    const semanticPool = preselectSemanticCandidates(chapter, scopedEvidence, semanticTopCandidates);
    const chapterSemanticSimilarity = await buildSemanticSimilarity([chapterCriteriaText(chapter)], semanticPool.map(semanticEvidenceText));
    let evidence = optimizeChapterEvidence(chapter, scopedEvidence, { preservePinned: true, semantic: { similarity: chapterSemanticSimilarity, queryText: chapterCriteriaText(chapter) } }, session.planning.generationDiagnostics);
    // 源级同口径裁决前置到证据切片：资料原文（如招标正文 4645㎡）被补疑修正后，进入写作 LLM 的切片必须先改写成裁决值，
    // 否则模型看到原文旧值会照抄（历史缺陷：第 3 章 checkpoint 混用 4645/4646），只能靠事后全局审查修复
    evidence = governEvidenceValues(evidence, session.understanding.canonicalFacts.scopeConflicts);
    assertEvidenceInProjectScope(evidence, session.understanding.projectMaterialScope, `chapter:${chapter.id}:initial`);
    let missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
    let deepEvidenceCount = 0;
    // P1-4：事实需求计算提前到深召回判断之前，把 requiredMissingNeeds 并入深召回一次完成，
    // 避免缺失事实与必需事实需求两次深召回查询集高度重叠
    const forbidDrawingImages = false;
    const graphRoleHint = graphMapping
      ? [
          graphMapping.graphWorks.length ? `图谱识别本章工程内容：${graphMapping.graphWorks.join('、')}` : '',
          graphMapping.graphMethods.length ? `图谱识别本章施工方法：${graphMapping.graphMethods.join('、')}` : '',
          graphMapping.graphBoqItems.length ? `图谱识别本章BOQ清单项（${graphMapping.graphBoqItems.length}项）：${graphMapping.graphBoqItems.map(b => `${b.name} ${b.quantity}${b.unit}`).join('、')}` : '',
          graphMapping.gaps.length ? `图谱识别本章资料缺口：${graphMapping.gaps.join('；')}` : '',
        ].filter(Boolean).join('\n')
      : '';
    // 写作任务书不再逐章注入：其“写作目标/必须覆盖/清单目标”与 plan（项目资料理解的章节计划，源自模板+图谱、更项目专属）语义重叠，
    // 全局写作约束由文档蓝图（projectContext）统一承载，逐章 roleContext 保留图谱提示与项目理解的章节计划即可
    const scopeOverrideAnchors = renderScopeOverrideAnchors(session.understanding.canonicalFacts.scopeConflicts);
    // W4/P3 本章责任要求项：路由到本章的评分项要求必须显性写入正文（生成侧治本，不依赖事后补写）
    const chapterRequirementContext = session.planning.requirementsRoutes.length > 0
      ? (() => {
        const chapterTitle = normalizeChapterTitleLine(chapter.title);
        const routed = session.planning.requirementsRoutes.filter(route => route.chapterTitle === chapterTitle);
        if (routed.length === 0) return '';
        return ['【本章必须显性响应的招标要求（逐条写入正文，零响应即评标失分）】', ...routed.map(route => `- ${route.kind}：${route.item.text}`)].join('\n');
      })()
      : '';
    // 4.17.8 六个百分百写作侧前置注入：扬尘治理六项是国家规范固定封闭集，历史缺陷只在检测/修复侧
    // 逐项补写（后期修复模式），写作 LLM 凭记忆编写必漏项（4.17.7 实测缺 2 项）；写作时即注入六项
    // 原文要求逐项落实，缺项从源头消失——修复是辅助，写作是主力
    // P17 语义化：扬尘类章判定迁移 chapterIntentClassifier（章标题语义优先，标题+用途组合正则兑底保持原命中集）
    const sixHundredPercentContext = session.planning.chapterIntentClassifier.needsDustControl(chapter.title)
      || session.planning.chapterIntentClassifier.needsDustControl(`${chapter.title}${chapter.purpose || ''}`)
      ? ['【扬尘治理六个百分百——规范固定条目，必须逐项落实并写入正文，每项一句具体措施，六项不得缺项；若本项目无拆迁工程，对“拆迁工地100%湿法作业”必须显性写明“本项目无拆迁工程，不涉及拆迁工地湿法作业”，不得省略】',
        '- 施工工地周边100%围挡',
        '- 物料堆放100%覆盖',
        '- 出入车辆100%冲洗',
        '- 施工现场地面100%硬化',
        '- 拆迁工地100%湿法作业',
        '- 渣土车辆100%密闭运输'].join('\n')
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
    const roleContext = [graphRoleHint, chapterRequirementContext, forcedSectionContext, sixHundredPercentContext, scopeOverrideAnchors.length ? `【数据口径强制约束】${scopeOverrideAnchors.join('；')}` : '', plan?.writingGoal, plan?.mustCover?.length ? `本章必须覆盖：${plan.mustCover.join('、')}` : '', plan?.mustUseMaterialKinds?.length ? `本章优先使用资料类型：${plan.mustUseMaterialKinds.join('、')}` : '', billLockText].filter(Boolean).join('\n');
    const chapterPromptExecution = resolveChapterPromptExecution(session.prepare.promptPlan, chapter);
    if (session.prepare.promptPlan.writerPrompts.length > 0 && !chapterPromptExecution.primaryWriter) throw new Error(`${displayChapterTitle(chapter.title)} 写作主控提示词未进入章节生成阶段`);
    const chapterPromptTexts = [chapterPromptExecution.promptTexts, session.prepare.generationControlPrompt].filter(Boolean).join('\n\n');
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
      highRisk: session.understanding.rolePoolRisk.highRisk,
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
      const deepEvidence = await retrieveDeepChapterEvidence({ manager: session.understanding.manager, projectRoot: session.prepare.projectRoot, chapter, scopedFilePaths, fileRoleByPath: session.understanding.fileRoleByPath, fileProcessingByPath: session.understanding.fileProcessingByPath, requiredNeeds: [...new Set([...missingFacts, ...requiredMissingNeeds])], extraClues: session.prepare.requirementSemantics?.factClues || [], highRisk: session.understanding.rolePoolRisk.highRisk || requiredMissingNeeds.length > 0, signal: session.global.input.signal }).catch(() => []);
      deepEvidenceCount = deepEvidence.length;
      if (deepEvidence.length > 0) {
        // 深召回增量合并：scopedEvidence 各来源均已过项目资料口径过滤，deepEvidence 此处过滤后直接合并；
        // 不再对合并集先做一次 optimizeChapterEvidence 全量重排——下方 evidence 会统一重排一次
        //（历史冗余：同一输入同一参数连续重排两遍，optimizeChapterEvidence 为纯函数，中间结果随即被覆盖）
        scopedEvidence = [...scopedEvidence, ...filterEvidenceByProjectScope(deepEvidence, session.understanding.projectMaterialScope)];
        if (session.understanding.excludedEvidenceKeys.size > 0) scopedEvidence = scopedEvidence.filter(item => !session.understanding.excludedEvidenceKeys.has(evidenceSafetyKey(item)));
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { preservePinned: true }, session.planning.generationDiagnostics);
        evidence = governEvidenceValues(evidence, session.understanding.canonicalFacts.scopeConflicts);
        assertEvidenceInProjectScope(evidence, session.understanding.projectMaterialScope, `chapter:${chapter.id}:deep`);
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
      const mergedSupplementalEvidence = filterEvidenceByProjectScope(await retrieveDeepChapterEvidence({ manager: session.understanding.manager, projectRoot: session.prepare.projectRoot, chapter, scopedFilePaths, fileRoleByPath: session.understanding.fileRoleByPath, fileProcessingByPath: session.understanding.fileProcessingByPath, requiredNeeds: requiredMissingNeeds, extraClues: session.prepare.requirementSemantics?.factClues || [], highRisk: true, signal: session.global.input.signal }).catch(() => []), session.understanding.projectMaterialScope);
      if (mergedSupplementalEvidence.length > 0) {
        // 补充证据在上方赋值时已过滤项目资料口径，直接合并后统一重排一次（同深召回路径，省一次全量重排+全量过滤）
        scopedEvidence = [...scopedEvidence, ...mergedSupplementalEvidence];
        if (session.understanding.excludedEvidenceKeys.size > 0) scopedEvidence = scopedEvidence.filter(item => !session.understanding.excludedEvidenceKeys.has(evidenceSafetyKey(item)));
        evidence = optimizeChapterEvidence(chapter, scopedEvidence, { preservePinned: true }, session.planning.generationDiagnostics);
        evidence = governEvidenceValues(evidence, session.understanding.canonicalFacts.scopeConflicts);
        assertEvidenceInProjectScope(evidence, session.understanding.projectMaterialScope, `chapter:${chapter.id}:supplemental`);
        missingFacts = chapter.requiredFacts.filter((fact: string) => !evidence.some(item => evidenceMatchesFact(item, fact)));
        resolvedFactNeeds = resolveChapterFactNeeds({ needs: chapterFactNeeds, factsModel: session.understanding.preliminaryFactsModel, evidence: scopedEvidence, profile: session.prepare.domainProfile, excludedEvidenceKeys: session.understanding.excludedEvidenceKeys });
        requiredMissingNeeds = resolvedFactNeeds.filter(item => item.need.required && item.status !== 'satisfied').map(item => item.need.label);
      }
    }
    assertEvidenceInProjectScope(evidence, session.understanding.projectMaterialScope, `chapter:${chapter.id}:writer-session.global.input`);
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
      return retrieveSectionEvidence({ manager: session.understanding.manager, projectRoot: session.prepare.projectRoot, chapter, sectionTitle, scopedFilePaths, fileRoleByPath: session.understanding.fileRoleByPath, fileProcessingByPath: session.understanding.fileProcessingByPath, signal: session.global.input.signal }).then(results => {
        sectionEvidenceCache.set(cacheKey, results);
        return results;
      });
    };
    // P4 硬回路提供器：两步生成大纲报告「材料缺失事实」时定向补检（复用小节级检索，禁用重排器，预算 9000 字符）
    const supplementEvidenceForChapter = (missingFacts: string[]): Promise<DocumentEvidence[]> => {
      if (missingFacts.length === 0 || scopedFilePaths.length === 0) return Promise.resolve([]);
      const label = missingFacts.join(' ');
      return retrieveSectionEvidence({ manager: session.understanding.manager, projectRoot: session.prepare.projectRoot, chapter, sectionTitle: label, scopedFilePaths, fileRoleByPath: session.understanding.fileRoleByPath, fileProcessingByPath: session.understanding.fileProcessingByPath, signal: session.global.input.signal }).catch(() => []);
    };
    const retrievalCoverageReport = buildRetrievalCoverageReport({ chapter, evidence, risk: session.understanding.rolePoolRisk });
    session.understanding.retrievalCoverageReports.push(retrievalCoverageReport);
    const chapterEvidenceFiles = new Set(evidence.map(item => item.filePath));
    const chapterEvidenceChars = evidence.reduce((sum, item) => sum + item.content.length, 0);
    const retrievalDetails = [
      ...(session.understanding.rolePoolRisk.highRisk ? [`召回覆盖风险（${session.understanding.rolePoolRisk.riskReason || '切片未完全预加载'}）：已加载 ${session.understanding.rolePoolRisk.loadedChunks}/${session.understanding.rolePoolRisk.totalChunks}，已启用深召回`] : []),
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
    const agentEnhancedPromptTexts = [chapterPromptTexts, chapterTaskPrompt(chapterTaskResult.task)].filter(Boolean).join('\n\n');
    const factNeedSummary = { total: resolvedFactNeeds.length, satisfied: resolvedFactNeeds.filter(item => item.status === 'satisfied').length, missing: resolvedFactNeeds.filter(item => item.status === 'missing').length, lowConfidence: resolvedFactNeeds.filter(item => item.status === 'low_confidence').length };
    for (const fact of requiredMissingNeeds) session.understanding.missingItems.push(`${chapter.title}：事实需求未确认 ${fact}`);
    const budgetTarget = session.planning.documentBudget.chapterTargets.get(chapter.id) || 1200;
    const sectionCount = chapter.sections?.filter(Boolean).length || 0;
    const compositeChapterTitle = /[、，,；;]/u.test(chapter.title);
    const targetPlan = chapterGenerationTargets({ budgetTarget, sectionCount, title: chapter.title, longformStrict: session.planning.documentBudget.longformStrict });
    const chapterMaxChars = Math.ceil(targetPlan.maxWords * (session.planning.documentBudget.maxChars ? 1.05 : 1));
    // 二期蓝图接管：本章章切片渲染文本 + 参数桶权威文本（蓝图活跃时替换主表口径）；
    // P14：整体校验未通过但本章所需权威全可用（blueprintGaps 为空）时，数值密集章仍注入章切片，
    // 避免放行章节无权威数值按证据独立成稿（非数值密集章维持现状：整体未通过不注入）
    // P17 语义化：章切片注入判定与阻断判定共用同一分类器（语义优先、正则兑底）
    const chapterNeedsBlueprintAuthority = chapterBlueprintAuthoritiesNeeded(chapter.title, session.planning.chapterIntentClassifier).length > 0;
    const chapterBlueprintSlice = (session.blueprint.blueprintActive || (chapterNeedsBlueprintAuthority && blueprintGaps.missing.length === 0)) && session.blueprint.integratedBlueprint
      ? findBlueprintChapter(session.blueprint.integratedBlueprint, chapter.title)
      : undefined;
    // 章切片尾部追加章级数值锚点卡（本章必须引用的计划类数值聚焦强约束，写作层抑制自编数值）
    const blueprintSliceText = chapterBlueprintSlice && session.blueprint.integratedBlueprint ? renderBlueprintChapterSlice(chapterBlueprintSlice, session.blueprint.integratedBlueprint.data) : '';
    const blueprintMustCiteHint = chapterBlueprintSlice && session.blueprint.integratedBlueprint ? renderBlueprintMustCiteValues(chapterBlueprintSlice, session.blueprint.integratedBlueprint.data) : '';
    const targetWords = targetPlan.roundTarget;
    // 达标契约：minWords = 目标（不打折）。0.68 折扣是历史人为降标，是"初稿不达标→补写"链的源头；
    // spec/dynamicChapterRule 最小值已被 min(rule, targetWords) 截断为不超目标，直接取目标即全局最紧口径
    const minWords = targetWords;
    const generationMaxTokens = outputTokensForChapter(minWords, targetWords);
    // 长文模式：目标字数以提示词预算为准（roundTarget 已含完整章预算），不再被 structureTarget 二次压制；
    // 普通模式保留「结构承载量」上限，避免小节少时下达不切实际的整章目标
    const effectiveTargetWords = sectionCount > 0
      ? (session.planning.documentBudget.longformStrict ? targetWords : Math.min(targetWords, Math.max(1800, targetPlan.structureTarget)))
      : targetWords;
    const maxSectionFirstSections = 8;
    // 小节级成稿：长章节（目标 ≥6000 字、小节 4-8、非复合标题）自动启用，
    // 把整章长文拆成每节 900-1400 字的小调用，根治单次长文成稿长度不稳；
    // 耗时优化 P1：阈值放宽为「小节 2-8、非复合标题」即可启用——整章单次长调用（12 分钟级）
    // 是成稿段最大浪费（章 3 实测 724.6s 失败后降级链又重生成两遍），小节并发让单次输出
    // 稳定在 600-1400 字、失败只重试单节，整章路径仅保留给无小节章（小目标）
    // （原 DOCUMENT_SECTION_FIRST_GENERATION 强制开关已固化删除：自动判定恒开）
    const sectionFirstAutoEligible = sectionCount >= 2 && sectionCount <= maxSectionFirstSections && !compositeChapterTitle;
    // P2.5 蓝图分部章路由：蓝图章切片分部名（如「主要施工方法」23 个清单分部）多于模板小节数时
    // 必须走主题块管线（块规划按蓝图 subSections 每分部一块）——小节并发只按模板 5 个泛化小节展开，
    // 蓝图分部结构整体丢失（丰乐镇第十轮实测：「主要施工方法」章仅剩 3 个 H3，23 个分部名全部丢失）
    const blueprintDivisionOverridesSections = Boolean(chapterBlueprintSlice && chapterBlueprintSlice.subSections.length > sectionCount);
    const useSectionGroup = sectionCount >= 2 && (sectionCount > maxSectionFirstSections || compositeChapterTitle || blueprintDivisionOverridesSections || (session.planning.documentBudget.longformStrict && sectionCount >= 6));
    const useSectionFirst = !useSectionGroup && sectionCount >= 2 && sectionCount <= maxSectionFirstSections && (sectionFirstAutoEligible || session.planning.documentBudget.longformStrict);
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
    if (resumedContent) {
      content = finalizeChapterContentQuality(resumedContent, chapter);
      content = await stripBidDisciplineSentencesSemantic(content, session.understanding.bidProcedureJudge);
      latestChapterStageForProgress = displayStage({
        type: 'chapter_generation',
        roleId: 'chapter_generation',
        promptId: chapterPromptExecution.primaryPromptId,
        status: 'success',
        message: `${displayChapterTitle(chapter.title)} 已复用已有章节正文：当前 ${documentTextLength(content)} 字，跳过 Writer，直接进入章节收口`,
        details: [`有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, '来源：resumeChapters/checkpointChapters'],
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
        message: useSectionGroup ? `${displayChapterTitle(chapter.title)} 正在规划主题块并准备并发成稿` : useSectionFirst ? `${displayChapterTitle(chapter.title)} 正在按小节并发成稿` : `${displayChapterTitle(chapter.title)} 正在整章一次成稿`,
        details: (useSectionGroup || useSectionFirst)
          ? [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, targetPlan.label, `生成上限约 ${chapterMaxChars} 字`, `模板细目：${chapter.sections?.length || 0} 条`, useSectionGroup ? '细目较多，先由章级 Planner 聚类为主题块并语义合并，再按主题块全并发出稿，避免逐小节碎片化' : '按章节结构拆分小节自然并发生成，章节聚合后再审查修复']
          : [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `事实需求：${factNeedSummary.satisfied}/${factNeedSummary.total} 已满足，缺失 ${factNeedSummary.missing}，低置信 ${factNeedSummary.lowConfidence}`, targetPlan.label, `生成上限约 ${chapterMaxChars} 字`, `规划小节：${sectionCount} 个`, '首次生成必须覆盖章节结构、小节和事实，篇幅目标仅作为规划参考'], 
        progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: useSectionGroup ? '主题块并发' : useSectionFirst ? '小节并发' : '整章成稿' },
      }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
      session.global.emitProgress();
      let llmContent: string | undefined;
      // C3 块级失败隔离重试器：失败块按同一目标字数单独成稿并插回原位置（成功块不动，不整章降级重写）。
      // 整章降级是历史缺陷「整章备用=整章失败重写」与全文字数雪崩的根因——单块质检未达标即全章重写，
      // 已成功的 2/3 内容全部作废；隔离重试只补失败块，成功块内容与 token 零浪费
      // 达标契约：重试不降标（历史 0.75/0.55 紧缩预算已删除）
      const retryFailedBlocks = async (buildInput: PlannedChapterContentInput, failedBlocks: PlannedChapterContentResult['failedBlocks'], sections: Array<string | undefined>): Promise<Array<string | undefined>> => {
        const retried = await Promise.all(failedBlocks.map(({ block }) =>
          buildPlannedChapterContent({ ...buildInput, targetWords: block.targetWords, maxWords: Math.ceil(block.targetWords * 1.1) }, { blocks: [block], coveredSections: [], fallbackSections: [], llmPlanned: false })
            .then(result => result?.markdown)
            .catch(() => undefined)
        ));
        const merged = [...sections];
        failedBlocks.forEach(({ index }, position) => {
          const piece = retried[position];
          if (piece) merged[index] = piece.replace(/^##\s+.+$/mu, '').trim();
        });
        return merged;
      };
      if (useSectionGroup) {
        // 规划驱动管线（三期收口：蓝图章切片→块结构确定性转换，零 LLM 调用）：蓝图小节/工作包映射主题块+H4 要点，
        // 相近细目语义合并进重写标题的 H4；本章无蓝图切片时由确定性语义域分组接管（永不回退逐小节碎片化成稿）
        const plannedStructureRaw = await session.global.withProgressHeartbeat(() => measureGenerationStep(session.planning.generationDiagnostics, `chapter-plan:${chapter.id}`, async () =>
          buildChapterStructureFromBlueprint({ blueprintChapter: chapterBlueprintSlice, inputSections: chapter.sections || [], chapterTitle: displayChapterTitle(chapter.title), targetWords: effectiveTargetWords, projectContext: session.planning.projectContext, evidence })
        ));
        // A22 单要点大块确定性拆分（丰乐镇第八轮失败实测）：规划器产出单要点 3600 字大块时
        // 模型单次输出达不到达标线且无拆半退路 → 章失败；规划层即拆为两个半块（目标减半+分工指令）
        const plannedStructure = splitSinglePointOversizedBlocks(plannedStructureRaw);
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
            details: [...chapterPromptDetails, `有效证据：${evidence.length} 条`, `输入细目 ${sectionCount} 条 → 主题块 ${plannedStructure.blocks.length} 个（每块 2~4 个 H4 要点）`, `语义合并 ${mergedCount} 条细目，目录级 H4 合计 ${h4Count} 个`, '单块 1200~2200 字，主题块间全并发，单节深度与整体耗时双优'],
            progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: '主题块并发' },
          }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
          // 同步把「Agent Chapter Task Planner」stage 更新为规划驱动视角：
          // 细目任务卡是事实/证据分配单元，最终目录按主题块+H4 成稿，避免残留「N/N 个小节任务就绪」误导
          const chapterTaskStage = session.global.progressStages.find(stage => stage.roleId === `agent-chapter-task-${chapter.id}`);
          if (chapterTaskStage) {
            chapterTaskStage.message = `${chapterTaskResult.task.sections.filter(item => item.ready).length}/${chapterTaskResult.task.sections.length} 条细目任务就绪（已规划为 ${plannedStructure.blocks.length} 个主题块）`;
          }
          session.global.emitProgress(session.global.chapterDrafts);
          const plannedBuildInput: PlannedChapterContentInput = { template: session.prepare.template, chapter, evidence, missingFacts, promptTexts: plannedPromptTexts, projectContext: session.planning.chapterScopedProjectContext(chapter), skeletonProjectContext: session.planning.projectContext, requirement: session.global.input.requirement, roleContext, targetWords: effectiveTargetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, compactProjectContext: true, scopedProjectContext: true, blueprintDataText: session.blueprint.blueprintDataText, blueprintSliceText, blueprintMustCiteHint, sectionEvidenceProvider: sectionEvidenceForChapter, onSectionProgress: onSectionProgressForCheckpoint, diagnostics: session.planning.generationDiagnostics, signal: session.global.input.signal };
          const plannedFirst = await session.global.withProgressHeartbeat(() => measureGenerationStep(session.planning.generationDiagnostics, `chapter-planned-block-draft:${chapter.id}`, () =>
            buildPlannedChapterContent(plannedBuildInput, plannedStructure)
          ));
          if (plannedFirst?.allSucceeded) {
            llmContent = plannedFirst.markdown;
          } else if (plannedFirst) {
            // C3：失败块两轮隔离重试（同一目标字数），全部成功即拼回完整章节；
            // 重试后仍失败才进入下方的整章备用路径（成功块不再被整章重写作废）
            let mergedSections = await retryFailedBlocks(plannedBuildInput, plannedFirst.failedBlocks, plannedFirst.sections);
            const stillFailed = plannedFirst.failedBlocks.filter(({ index }) => !mergedSections[index]);
            if (stillFailed.length > 0) mergedSections = await retryFailedBlocks(plannedBuildInput, stillFailed, mergedSections);
            if (mergedSections.every((section): section is string => Boolean(section))) llmContent = `## ${chapter.title}\n\n${mergedSections.join('\n\n')}`;
          }
        }
      } else if (useSectionFirst) {
        llmContent = await session.global.withProgressHeartbeat(() => measureGenerationStep(session.planning.generationDiagnostics, `chapter-section-draft:${chapter.id}`, () =>
          buildSectionParallelChapterContent({ template: session.prepare.template, chapter, evidence, missingFacts, promptTexts: agentEnhancedPromptTexts, projectContext: session.planning.chapterScopedProjectContext(chapter), skeletonProjectContext: session.planning.projectContext, requirement: session.global.input.requirement, roleContext, targetWords: effectiveTargetWords, maxWords: chapterMaxChars, forbidDrawingImages, factCoverageContext, projectRoot: session.prepare.projectRoot, modelName: getActiveModelWithProvider()?.model.name, materialContextHash: stableHash({ materialFilePaths: session.prepare.materialFilePaths, promptTexts: chapterPromptTexts }), allowPartialResult: false, compactProjectContext: true, scopedProjectContext: true, blueprintDataText: session.blueprint.blueprintDataText, blueprintSliceText, sectionEvidenceProvider: sectionEvidenceForChapter, onSectionProgress: onSectionProgressForCheckpoint, diagnostics: session.planning.generationDiagnostics, signal: session.global.input.signal })
        ));
      } else {
        llmContent = await session.global.withProgressHeartbeat(() => measureGenerationStep(session.planning.generationDiagnostics, `chapter-draft:${chapter.id}`, () =>
          buildLlmChapterContent(session.prepare.template, chapter, evidence, missingFacts, agentEnhancedPromptTexts, session.planning.chapterScopedProjectContext(chapter), session.global.input.requirement, roleContext, { forbidDrawingImages, minWords, targetWords, maxWords: chapterMaxChars, maxTokens: generationMaxTokens, factCoverageContext, blueprintDataText: session.blueprint.blueprintDataText, blueprintSliceText, signal: session.global.input.signal, diagnostics: session.planning.generationDiagnostics, supplementEvidenceProvider: supplementEvidenceForChapter, evidenceFloorChars: session.planning.generationBudget.evidenceFloorChars, evidenceCeilingChars: session.planning.generationBudget.evidenceCeilingChars })
        ));
      }
      if (!llmContent) {
        // 达标契约：LLM 未返回有效正文时不进入任何降级链（紧凑备用/失败原因重试/证据骨架已删除）——
        // 块级隔离重试（同标准）已在前置流程耗尽，残留失败直接阻断生成，拒绝低质量兜底正文静默成文
        session.planning.generationDiagnostics.llm.lastError = session.planning.generationDiagnostics.llm.lastError || '全部成稿路径未返回有效正文';
      }
      // B3 确定性对齐：章节成稿后，must_cite+strict 槽位数值与蓝图章切片不一致时按蓝图回填
      // （只替换数字本身、不动句式）；未引用缺口进观测交由跨章一致性审查兑底。
      // 对齐覆盖全部成稿路径（主题块/小节/整章）；蓝图未覆盖本章时跳过
      if (llmContent && chapterBlueprintSlice && session.blueprint.integratedBlueprint) {
        const aligned = alignChapterContentToBlueprint(llmContent, chapterBlueprintSlice, session.blueprint.integratedBlueprint.data);
        if (aligned.fixed.length > 0) {
          llmContent = aligned.markdown;
          session.planning.generationDiagnostics.llm.lastInfo = `蓝图引用对齐：${chapter.title} 回填 ${aligned.fixed.length} 处（${aligned.fixed.map(item => `${item.anchor} ${item.from}→${item.to}`).join('、')}）${aligned.missing.length ? `；未引用缺口 ${aligned.missing.length} 项：${aligned.missing.join('、')}` : ''}`;
        } else if (aligned.missing.length > 0) {
          session.planning.generationDiagnostics.llm.lastInfo = `蓝图引用缺口观测：${chapter.title} 未在正文引用 ${aligned.missing.length} 项 must_cite 参数（${aligned.missing.slice(0, 6).join('、')}${aligned.missing.length > 6 ? ' 等' : ''}），由跨章一致性审查兑底`;
        }
      }
      throwIfAborted(session.global.input.signal);
      if (!llmContent) {
        const message = `${displayChapterTitle(chapter.title)} 大模型未返回有效正文，已阻断生成`;
        session.global.progressStages[chapterProgressIndex] = displayStage({
          type: 'chapter_generation',
          roleId: 'chapter_generation',
          promptId: chapterPromptExecution.primaryPromptId,
          status: 'failed',
          message,
          details: [`LLM 最近错误：${session.planning.generationDiagnostics.llm.lastError || '空响应或超时'}`, `证据条数：${evidence.length}`],
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
      if (plannedH3Titles.length > 0) alignedContent = alignSectionHeadingsToPlan(alignedContent, plannedH3Titles, 3);
      if (plannedH4Titles.length > 0) alignedContent = alignSectionHeadingsToPlan(alignedContent, plannedH4Titles, 4);
      content = finalizeChapterContentQuality(alignedContent, chapter);
      content = await stripBidDisciplineSentencesSemantic(content, session.understanding.bidProcedureJudge);
    }
    const factUsageIssues = await chapterSectionFactUsageIssues({ chapter, content, evidence });
    const chapterChars = documentTextLength(content);
    const generatedSectionsForReview = extractGeneratedSections(content);
    // C1 目录确定性：draft.sections 必须等于生成前规划大纲（主题块管线=块标题，其余=规划小节），
    // 不得从正文提取——正文 H3 被 LLM 改写后提取进目录是「目录污染」的直接源头；仅无任何规划来源时才提取兜底
    const plannedSectionTitles = plannedStructureRef && plannedStructureRef.blocks.length > 0 ? plannedStructureRef.blocks.map(block => block.title) : (chapter.sections || []).filter(Boolean);
    const sections = plannedSectionTitles.length > 0 ? plannedSectionTitles : (generatedSectionsForReview.length > 0 ? generatedSectionsForReview : []);
    const expandedSectionIssues = sectionContentIntegrityIssues(content, [{ title: chapter.title, content, sections }]).map(issue => issue.message);
    const factUsageWarnings = factUsageIssues.slice(0, 6).map(issue => `小节事实密度需优化：${issue}`);
    const chapterIssues = [...expandedSectionIssues, ...factUsageWarnings];
    const chapterStatus = chapterCompletionStatus(chapterChars, targetWords, chapterIssues);
    latestChapterStageForProgress = displayStage({
      type: 'chapter_generation',
      roleId: 'chapter_generation',
      promptId: chapterPromptExecution.primaryPromptId,
      status: chapterStatus,
      message: elapsedMessage(`${displayChapterTitle(chapter.title)} 已由大模型成稿：当前 ${chapterChars} 字；章节预算约 ${targetPlan.budgetTarget} 字，本轮目标约 ${targetPlan.roundTarget} 字${chapterIssues.length ? `；待优化：${chapterIssues.slice(0, 8).join('、')}` : ''}`, chapterStartedAt),
      details: [`本轮完成率：${Math.round(chapterChars / Math.max(1, targetPlan.roundTarget) * 100)}%`, `结构目标约 ${targetPlan.structureTarget} 字`, ...chapterPromptDetails, `二级小节：${sections.length} 个`],
      progress: { current: chapterOrder + 1, total: session.planning.effectiveChapters.length, label: chapterIssues.length ? '章节已生成' : '章节达标' },
    }, { subtitle: displayChapterTitle(chapter.title), order: chapterOrder });
    session.understanding.chapterGenerationStagesByOrder[chapterOrder] = latestChapterStageForProgress;
    // P2：生成阶段结束，章节收口作为延迟任务返回，由审查池调度（与后续批次章节生成流水线重叠）
    return async (): Promise<void> => {
      // 达标契约收口：初稿质量由达标契约（minWords=目标、块质检 0.9×目标）保证，
      // 不再运行章级 Reviewer/Repairer 补写循环（历史缺陷：审查修复成为 token 主力军，
      // 补写落位锚点随成稿变化全部失效）。跨章一致性/数据一致性/结构问题统一在
      // 初稿完成后的全局一致性审查阶段冻结问题清单并定向修复
      const draftChapter = { id: chapter.id, title: chapter.title, content, evidence, missingFacts, sections, tablePlans: chapter.tablePlans || [] };
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

