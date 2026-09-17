/**
 * stageUnderstanding：阶段 1 —— 索引/证据/事实池/裁决/图谱/canonical/标书编制规格/评分项提取链。
 * P1 六阶段拆分（方案 5.1）：由 documentGenerator.generateDocumentDraft 阶段 1 代码块机械搬迁而来，
 * 变量读写经 session 子对象显式化，业务生成语义与原巨型函数逐字一致（行为保持）。
 */
import * as path from 'node:path';
import { materialRootsOfFiles } from '@customize-agent/knowledge';
import type { KbSearchResult } from '@/lib/api';
import type { DocumentEvidence, TenderRequirementModel } from '../types';
import type { GenerationSession } from './generationSession';
import { displayChapterTitle, effectiveTemplateChapters } from '../outline';
import { selectEvidenceByBudget } from '../evidence';
import { chineseTokenMatch } from '../textMatch';
import { filterBidDisciplineFacts, stableHash, throwIfAborted } from '../utils';
import { displayStage, upsertProgressStage } from '../progress';
import { buildSemanticSimilarity } from '../semanticSimilarity';
import { chapterCriteriaText, extractEvaluationCriteriaItems, validateBidStructureBeforeGeneration } from '../constructionBidStructure';
import { buildProjectUnderstanding, materialRoleId } from '../projectMaterialProfile';
import { buildProjectGraph } from '../projectGraph';
import { buildScopedProjectIntelligence, isIrrelevantProjectGap } from '../projectIntelligence';
import { createAgentWorkflowContext, agentWorkflowStages } from '../agentWorkflow';
import { planDocument } from '../agentPlanner';
import { collectProjectBasicEvidence, kbIndexHealth, resolveDocumentGenerationEvidenceLimit, searchWeightsForChapter, vectorStatusLabel } from '../documentGeneratorHelpers';
import { retrievalCoverageRisk } from '../documentEvidenceRetrieval';
import { buildBidProcedureJudge, evidenceSafetyKey, partitionEvidenceByContentSafety } from '../evidenceContentSafety';
import { buildFactsModel, extractLocalFactPool } from '../factsModel';
import { arbitrateFactPool, buildCanonicalFactModel, extractDrawingAnnotationFacts, PROJECT_BASIC_FIELD_SPECS } from '../factGovernance';
import { emptyTenderRequirements, extractTenderRequirements, hasTenderRequirements, readCachedTenderRequirements, tenderRequirementsCacheKey, tenderRequirementsSummary, writeCachedTenderRequirements } from '../tenderRequirements';
import { bidCompositionSummary, extractBidCompositionSpec, isBodyTableForbidden, stripRequiredTableRuleLine } from '../bidComposition';

export async function stageUnderstanding(session: GenerationSession): Promise<void> {
  session.understanding.evidenceScopePaths = new Set(session.prepare.materialFilePaths);
  session.understanding.fileRoleByPath = new Map([...session.prepare.kindByPath.entries()].map(([filePath, kind]) => [filePath, materialRoleId(kind)] as const));
  session.understanding.fileProcessingByPath = new Map([...session.prepare.processingByPath.entries()].map(([filePath, processing]) => [filePath, processing] as const));
  upsertProgressStage(session.global.progressStages, displayStage({
    type: 'knowledge_retrieval',
    roleId: 'knowledge-index',
    status: 'running',
    message: '正在读取项目资料包索引',
    details: ['使用上传阶段已完成的解析、切片和索引结果', '不在生成流程中重新解析或入库', '准备按资料类型召回章节证据'],
    progress: { current: 1, total: 3, label: '读取索引' },
  }, { subtitle: '知识库检索', order: session.global.progressStages.length }));
  session.global.emitProgress();
  session.understanding.project = await session.global.withProgressHeartbeat(() => session.understanding.manager.getProject(session.prepare.projectRoot));
  session.understanding.indexHealth = kbIndexHealth(session.understanding.project, [...session.understanding.evidenceScopePaths]);
  if (session.understanding.indexHealth.blockingIssues.length > 0) throw new Error(`生成前知识索引不可用：${session.understanding.indexHealth.blockingIssues.join('；')}`);
  session.understanding.availableEvidenceScopePaths = new Set(session.understanding.indexHealth.usablePaths);
  session.understanding.requestedEvidencePerChapter = resolveDocumentGenerationEvidenceLimit(session.understanding.project, [...session.understanding.availableEvidenceScopePaths], session.global.input.maxEvidencePerChapter);
  const indexHealthHasActionableWarning = session.understanding.indexHealth.pendingJobs > 0 || session.understanding.indexHealth.usableChunkCount === 0;
  // 召回覆盖风险必须写回 session（章节循环与覆盖报告在阶段 4 消费）：P1 六阶段拆分搬迁时
  // 此处仅保留局部变量导致 stageChapterLoop 读 undefined.highRisk 抛错、全部章节生成失败（4.22.0 事故）
  session.understanding.rolePoolRisk = retrievalCoverageRisk({ totalChunks: Math.min(session.understanding.indexHealth.usableChunkCount, session.prepare.materialFilePaths.length * 20), loadedChunks: Math.min(session.understanding.indexHealth.usableChunkCount, session.prepare.materialFilePaths.length * 20), vectorReady: session.understanding.indexHealth.vectorStatus ? session.understanding.indexHealth.vectorStatus.status === 'ready' : undefined });
  upsertProgressStage(session.global.progressStages, displayStage({
    type: 'knowledge_retrieval',
    roleId: 'knowledge-index',
    status: indexHealthHasActionableWarning ? 'failed' : 'success',
    message: `已读取知识索引：项目资料 ${session.understanding.indexHealth.scopedRecords.length} 份，可用切片 ${session.understanding.indexHealth.usableChunkCount} 条`,
    details: [`项目资料：${session.understanding.evidenceScopePaths.size} 份`, `可用证据文件：${session.understanding.availableEvidenceScopePaths.size} 份`, `向量状态：${vectorStatusLabel(session.understanding.indexHealth.vectorStatus?.status)}`, ...session.understanding.indexHealth.warnings, '后续将按招标正文/清单/图纸/补疑等资料类型召回'],
    progress: { current: 3, total: 3, label: '索引已就绪' },
  }, { subtitle: '知识库检索', order: session.global.progressStages.length }));
  session.global.emitProgress();
  throwIfAborted(session.global.input.signal);
  session.understanding.allEvidence = [];
  session.understanding.retrievalCoverageReports = [];
  session.understanding.webResearchReport = { enabled: session.prepare.webAccessConfig.enabled, queries: [] as string[], evidenceCount: 0, filteredCount: 0, chapters: [] as string[] };
  session.understanding.missingItems = [];
  session.understanding.failedChapterMessages = [];
  session.understanding.chapterGenerationStages = [];
  session.understanding.chapterDraftsByOrder = [];
  session.understanding.chapterGenerationStagesByOrder = [];
  session.understanding.knowledgeBaseStageIndex = -1;
  const searchCache = new Map<string, KbSearchResult[]>();
  const fileDetailCache = new Map<string, ReturnType<NonNullable<typeof session.understanding.project.getFileDetail>>>();
  session.understanding.getCachedFileDetail = (relativePath: string) => {
    const key = `${relativePath}::full`;
    if (!fileDetailCache.has(key)) {
      try {
        fileDetailCache.set(key, session.understanding.project.getFileDetail?.(relativePath));
      } catch {
        fileDetailCache.set(key, undefined);
      }
    }
    return fileDetailCache.get(key);
  };
  session.understanding.searchWithCache = async (query: string, scopedFilePaths: string[], limit: number, chapterTitle: string, scopedMaterialRoots?: string[]) => {
    const weights = searchWeightsForChapter(chapterTitle);
    // 资料包 ID 双锁：优先用调用方传入的范围包集合（生成链统一来自 materialScope.selectedMaterialRoots）；
    // 未传参时按文件白名单派生兜底，任何调用点都不会退化为全库裸检索
    const effectiveMaterialRoots = scopedMaterialRoots ?? materialRootsOfFiles(scopedFilePaths);
    // E1/E2：章节主检索为生成场景检索——generationMode:true 跳过 LLM 查询扩展（省 LLM 预算）。
    // cross-encoder 语义重排已恢复：推理下沉 worker 线程（packages/knowledge rerank-worker-thread），
    // 主线程不再被 ONNX 推理阻塞（历史：237 组查询 × 30 候选主线程推理阻塞 20-60 分钟，
    // 曾被迫 disableReranker 退化为纯 JS heuristicRerank，小节级证据相关性排序精度下降）。
    // （原 DOCUMENT_GENERATION_RERANKER 回退已固化删除：reranker 恒开；KB_RERANKER_WORKER=0 仍可回退主线程推理）
    const generationRerankerEnabled = true;
    const key = stableHash({ query, scopedFilePaths, effectiveMaterialRoots, limit, weights, generationMode: true, reranker: generationRerankerEnabled });
    const cached = searchCache.get(key);
    if (cached) return cached;
    const result = await session.understanding.manager.search(session.prepare.projectRoot, query, {
      scope: 'project',
      filters: { filePaths: scopedFilePaths, materialRoots: effectiveMaterialRoots },
      limit,
      weights,
      generationMode: true,
      disableReranker: !generationRerankerEnabled,
    }).catch(() => null);
    const results = result?.results || [];
    searchCache.set(key, results);
    return results;
  };
  const projectUnderstandingStage = { stage: displayStage({ type: 'file_understanding', roleId: 'project-understanding', status: 'running', message: `正在理解项目资料：${session.prepare.projectMaterialProfile.files.length} 份资料，${Object.values(session.prepare.projectMaterialProfile.groups).filter(files => files.length > 0).length} 类资料类型`, progress: { current: 1, total: 3, label: '资料理解' } }, { subtitle: '项目资料理解', order: session.global.progressStages.length }) };
  upsertProgressStage(session.global.progressStages, projectUnderstandingStage.stage);
  session.global.emitProgress();
  // 基础证据检索口径源头化：直接按"索引可用文件"检索（历史：按全部选定文件检索后再由事后过滤剔除不可用文件证据）
  const projectBasicEvidence = await collectProjectBasicEvidence({ manager: session.understanding.manager, project: session.understanding.project, projectRoot: session.prepare.projectRoot, scopedFilePaths: [...session.understanding.availableEvidenceScopePaths].filter(Boolean).sort(), scopedMaterialRoots: session.prepare.materialScope.selectedMaterialRoots, fileRoleByPath: session.understanding.fileRoleByPath, fileProcessingByPath: session.understanding.fileProcessingByPath, signal: session.global.input.signal });
  if (projectBasicEvidence.length > 0) {
    session.understanding.allEvidence.push(...projectBasicEvidence);
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'knowledge_retrieval', roleId: 'project-basic-evidence', status: 'success', message: `已锁定项目基础事实证据 ${projectBasicEvidence.length} 条`, details: projectBasicEvidence.slice(0, 8).map(item => `${path.basename(item.filePath)}｜${item.sectionTitle || '正文片段'}｜score=${item.score.toFixed(2)}`) }, { subtitle: '基础事实召回', order: session.global.progressStages.length }));
    session.global.emitProgress();
  }
  // 证据内容安全分区（源头断流，评分报告 P1 串章根因治理）：投标/评标纪律、评标办法、商务报价类证据
  // 从写手/图谱/事实/大纲链统一断开；系统侧消费通道（评分标准条目提取、招标要求提取）继续直读全量 allEvidence。
  // 语义模型恒可用：空候选由恒零函数承接，无降级分支（过滤失效显性暴露而非静默放行）
  const { safe, excluded: excludedEvidence } = await partitionEvidenceByContentSafety(session.understanding.allEvidence);
  session.understanding.writerEvidence = safe;
  // 生成后清洗第二道防线的语义判定器：与证据层同口径原型集（嵌入一次构建，章节循环全程复用）
  session.understanding.bidProcedureJudge = await buildBidProcedureJudge();
  if (excludedEvidence.length > 0) {
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'knowledge_retrieval', roleId: 'evidence-content-safety', status: 'success', message: `证据内容安全过滤：${excludedEvidence.length} 条投标程序/评标纪律类证据已从写作链断开（系统侧提取通道不受影响）`, details: excludedEvidence.slice(0, 6).map(item => `${path.basename(item.filePath)}｜${item.sectionTitle || '正文片段'}`) }, { subtitle: '证据内容安全', order: session.global.progressStages.length }));
    session.global.emitProgress();
  }
  session.understanding.safeProjectBasicEvidence = projectBasicEvidence.filter(item => !excludedEvidence.includes(item));
  // 排除证据内容指纹集：写作链证据（pinned/搜索召回）多为浅拷贝，按 filePath+sectionTitle 指纹比对
  session.understanding.excludedEvidenceKeys = new Set(excludedEvidence.map(evidenceSafetyKey));
  // 本地事实池统一入口（与 finalize 抽取点同源，见 factsModel.extractLocalFactPool）：
  // 四个本地抽取器单点收敛；structuredTables 经工作簿解析缓存，
  // finalize 复抽取同一批表文件时零重复磁盘 IO（行为保持，抽取语义零变化）
  session.understanding.earlyFactPool = extractLocalFactPool({ evidence: session.understanding.writerEvidence, template: session.prepare.template, spec: session.prepare.documentSpec, profile: session.prepare.domainProfile });
  const earlyLocalFacts = session.understanding.earlyFactPool.localFacts;
  const earlyProjectBasicFacts = session.understanding.earlyFactPool.projectBasicFacts;
  const earlyPreciseFacts = session.understanding.earlyFactPool.preciseFacts;
  const preliminaryFacts = [...earlyLocalFacts, ...earlyProjectBasicFacts, ...earlyPreciseFacts];
  session.understanding.scopedIntelligence = buildScopedProjectIntelligence({ projectRoot: session.prepare.projectRoot, template: session.prepare.template, requirement: session.global.input.requirement, materialScope: session.prepare.materialScope });
  // 内容安全兜底：旧版本缓存重建窗口期的残留纪律类事实在拼接点再次过滤（源头已过滤，此处双保险）
  const intelligenceFacts = filterBidDisciplineFacts(session.understanding.scopedIntelligence?.facts || []);
  // 4.19 图纸标注事实补抽：CAD 语义标注（坡底线 -5.150/钢管土钉）无字段名，LLM 动态 schema 抽取无法命中，
  // 危大判定/支护形式槽位因此无输入（真实回归实测正文深度只能 LLM 推断「约4.8m」与标注 5.15 偏差）；
  // 确定性补抽为事实进入 canonical 主表，C 模块检查器获得判定输入
  const drawingAnnotationFacts = extractDrawingAnnotationFacts(session.understanding.writerEvidence);
  const combinedPreliminaryFacts = [...intelligenceFacts, ...preliminaryFacts, ...drawingAnnotationFacts];
  // 事实池裁决收敛：三来源统一口径（与 canonical 同规则，补疑/澄清修正文件权威最高），
  // Planner 任务书与写作上下文只看到裁决后的胜选值；canonical 保持原始输入以保留冲突检测展示
  const arbitratedFacts = arbitrateFactPool(combinedPreliminaryFacts, session.prepare.projectRoot);
  session.understanding.preliminaryFactsModel = await buildFactsModel(arbitratedFacts, session.understanding.earlyFactPool.structuredTables, session.understanding.missingItems, session.prepare.documentSpec, session.prepare.domainProfile);
  session.understanding.agentWorkflow = createAgentWorkflowContext({ template: session.prepare.template, requirement: session.global.input.requirement, projectRoot: session.prepare.projectRoot, facts: arbitratedFacts, projectGraph: session.understanding.scopedIntelligence?.projectGraph, projectGraphSource: session.understanding.scopedIntelligence ? 'project-intelligence' : undefined, materialScope: session.prepare.materialScope });
  for (const stage of agentWorkflowStages(session.understanding.agentWorkflow)) upsertProgressStage(session.global.progressStages, stage);
  if (session.understanding.scopedIntelligence) upsertProgressStage(session.global.progressStages, displayStage({ type: 'file_understanding', roleId: 'project-intelligence-cache', status: 'success', message: `已复用入库后资料包理解资产：${session.understanding.scopedIntelligence.files.length} 份资料`, details: [`项目级缓存时间：${new Date(session.understanding.scopedIntelligence.cache.createdAt).toLocaleString()}`, `资料包范围指纹：${session.understanding.scopedIntelligence.scope.scopeHash.slice(0, 12)}`, `复用预计算事实：${session.understanding.scopedIntelligence.facts.length} 条`, `复用预计算项目图谱：${session.understanding.scopedIntelligence.projectGraph.works.length}工程/${session.understanding.scopedIntelligence.projectGraph.methods.length}工法/${session.understanding.scopedIntelligence.projectGraph.resources.length}资源`, `复用施工组织设计专项图谱：${session.understanding.scopedIntelligence.constructionOrganizationGraph.workPackages.length} 个工作包/${session.understanding.scopedIntelligence.constructionOrganizationGraph.controlMatrix.length} 条控制矩阵`, `图谱来源：${session.understanding.scopedIntelligence.cache.projectGraphMessage}`, `章节意图证据覆盖：${Object.keys(session.understanding.scopedIntelligence.evidenceByChapterId || {}).length}/${session.prepare.template.chapters.length} 章`, `排除正文不适用资料：${session.understanding.scopedIntelligence.files.filter(file => !file.usableForBody).length} 份`] }, { subtitle: '项目理解缓存 / 资料包' }));
  session.global.emitProgress();

  // ===== 项目资料图谱：命中 project-intelligence 时复用入库后完整项目图谱；缓存缺失时临时构建完整项目图谱 =====
  session.understanding.projectGraph = session.understanding.agentWorkflow.baseProjectGraph;
  if (!session.understanding.scopedIntelligence) {
    upsertProgressStage(session.global.progressStages, displayStage({
      type: 'file_understanding', roleId: 'project-graph', status: 'running',
      message: `正在临时构建完整项目图谱：${session.understanding.allEvidence.length} 条证据 → LLM 结构化提取`,
      details: ['缓存缺失或版本过期，建议重新构建项目理解缓存；本次生成将临时构建完整项目图谱。', '提取：工程内容、施工方法、材料设备、技术标准、重点难点'],
      progress: { current: 2, total: 3, label: '项目图谱' },
    }, { subtitle: '项目资料图谱分析', order: session.global.progressStages.length }));
    session.global.emitProgress();
    // generationDiagnostics 在此函数后半段才初始化，临时图谱构建路径不依赖诊断统计，不传 diagnostics 避免 TDZ
    const projectGraphResult = await session.global.withProgressHeartbeat(() => buildProjectGraph({ evidence: session.understanding.writerEvidence, signal: session.global.input.signal, projectRoot: session.prepare.projectRoot, requirement: session.global.input.requirement, templateId: session.prepare.template.id }), session.global.progressStages);
    if (!projectGraphResult.graph) throw new Error(`完整项目图谱构建失败：${projectGraphResult.stage.message || projectGraphResult.stage.status}`);
    session.understanding.projectGraph = projectGraphResult.graph;
    upsertProgressStage(session.global.progressStages, projectGraphResult.stage);
    session.global.emitProgress();
  }
  if (session.understanding.projectGraph) session.prepare.projectUnderstanding = buildProjectUnderstanding(session.prepare.template, session.prepare.projectMaterialProfile, session.understanding.projectGraph);
  // 项目资料理解节点：图谱增强完成后展示最终版（人读摘要，不透出内部提示词）
  upsertProgressStage(session.global.progressStages, displayStage({ type: 'file_understanding', roleId: 'project-understanding', status: 'success', message: `已完成项目资料理解：${session.prepare.projectMaterialProfile.files.length} 份资料、${Object.values(session.prepare.projectMaterialProfile.groups).filter(files => files.length > 0).length} 类资料类型${session.understanding.projectGraph ? `、图谱增强 ${session.understanding.projectGraph.works.length} 项工程内容` : ''}`, details: [...session.prepare.projectUnderstanding.chapterPlans.slice(0, 10).map(plan => `${plan.chapterTitle}：必用 ${plan.mustUseMaterialKinds.length} 类资料、必覆盖 ${plan.mustCover.length} 项`), ...(session.prepare.projectUnderstanding.profile.warnings.length ? [`资料风险：${session.prepare.projectUnderstanding.profile.warnings.slice(0, 3).join('；')}`] : [])] }, { subtitle: '项目资料理解', order: session.global.progressStages.length }));
  session.global.emitProgress();
  session.understanding.canonicalFacts = buildCanonicalFactModel({ facts: combinedPreliminaryFacts, projectGraph: session.understanding.projectGraph, requiredKeys: PROJECT_BASIC_FIELD_SPECS.map(spec => spec.key), projectRoot: session.prepare.projectRoot, requirement: session.global.input.requirement, templateId: session.prepare.template.id });
  session.understanding.preliminaryFactsModel.canonical = session.understanding.canonicalFacts;

  // 构建章节→图谱节点映射：将图谱中的 works/methods/resources 按章节标题匹配
  const rawEffectiveChapters = effectiveTemplateChapters(session.prepare.template, session.prepare.documentSpec, { preserveExplicitOutline: session.prepare.hasExplicitOutline });
  const enrichedOutlineChapters = rawEffectiveChapters;
  // 评分标准条目提取：从绑定招标材料中定位技术评审章节的编号条目（对象化，不再 slice(0,600) 词面过滤），
  // 并以本地 bge-small 嵌入构建“条目标题 ↔ 大纲章节”语义相似度函数供承接审计使用（本地 bge 恒可用，构建失败直接抛出）
  const evaluationSourceTexts = session.understanding.allEvidence
    .filter(item => /评审|评分标准|评分办法|详细评审/u.test(`${item.sectionTitle || ''}${item.content}`))
    .map(item => item.content);
  session.understanding.evaluationItems = extractEvaluationCriteriaItems(evaluationSourceTexts);
  // 空输入短路显性化（历史缺陷：评审证据存在但编号条目提取为空时，承接审计静默通过）——
  // 显性 stage 提示降级风险；黄山杯等短条目/绿色等级/禁编日期由评分项要求提取通道覆盖，不受此影响
  if (evaluationSourceTexts.length > 0 && session.understanding.evaluationItems.length === 0) {
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'bid-structure-audit', status: 'skipped', message: '评审章节证据存在但未提取到评分条目标题：评分标准编号条目提取为空，承接审计将静默通过', details: ['请检查招标文件评标办法章节编号格式；评分项要求（创优目标/绿色等级/禁编日期）由评分项要求提取通道覆盖'] }, { subtitle: '评标结构校验', order: session.global.progressStages.length }));
  }
  const criteriaSimilarity = await buildSemanticSimilarity(
    session.understanding.evaluationItems.map(item => item.title),
    enrichedOutlineChapters.map(chapterCriteriaText),
  );
  session.understanding.bidStructureAudit = validateBidStructureBeforeGeneration({ template: session.prepare.template, chapters: enrichedOutlineChapters, requirement: session.global.input.requirement, evaluationItems: session.understanding.evaluationItems, semanticSimilarity: criteriaSimilarity });
  // ── 标书编制规格判定（暗标/明标）——一处判定、全链消费 ──
  // 与评分项要求提取链同源直读（招标/补疑/答疑/评标文件全量切片，不经检索命中），确定性解析（无 LLM）：
  // 判定结果驱动阶段 2 小节规划/表格计划口径（暗标正文禁表 → 不产出表格需求）、阶段 3 蓝图 composition 承接
  // （附表清单与数据源绑定）、阶段 4 写作/门禁（禁表禁图注入 + 正文表格反向阻断）、终稿文末附表直出与封面口径；
  // 未能识别标书类型标记时显性展示（skipped，按常规口径），不静默猜测。
  const bidCompositionTexts: string[] = [];
  for (const relativePath of [...session.understanding.evidenceScopePaths].sort()) {
    if (!/招标|补疑|答疑|评标/u.test(relativePath)) continue;
    const detail = session.understanding.getCachedFileDetail(relativePath);
    if (!detail?.chunks?.length) continue;
    for (const chunk of detail.chunks as Array<{ content: string }>) bidCompositionTexts.push(chunk.content || '');
  }
  session.understanding.bidComposition = extractBidCompositionSpec({
    tenderTexts: bidCompositionTexts,
    requirement: session.global.input.requirement,
    requiredTables: session.prepare.runtimePromptRules.requiredTables,
  });
  const compositionSummary = bidCompositionSummary(session.understanding.bidComposition);
  upsertProgressStage(session.global.progressStages, displayStage({
    type: 'validation',
    roleId: 'bid-composition',
    status: compositionSummary.status,
    message: compositionSummary.message,
    details: compositionSummary.details,
  }, { subtitle: '标书编制规格', order: session.global.progressStages.length }));
  session.global.emitProgress();
  // 暗标口径消解（B6 门禁反转）：阶段 0 先于本判定拼装运行时提示词，已把「必须输出以下正式 Markdown 表格」
  // 规则行写入写作/事实提取/审查/修复四条消费链——判定为正文禁表后从这些文本中移除该行（字符串消解，
  // 不重建提示词），使阶段 2/4/终稿各轮消费的提示词与招标暗标口径一致；表格需求改由终稿文末附表区承接。
  if (isBodyTableForbidden(session.understanding.bidComposition)) {
    const dissolve = (text: string): { next: string; changed: boolean } => {
      const next = stripRequiredTableRuleLine(text || '');
      return { next, changed: next !== (text || '') };
    };
    const dissolvedFields: string[] = [];
    const runtimeRulesResult = dissolve(session.prepare.runtimeRulesText);
    session.prepare.runtimeRulesText = runtimeRulesResult.next;
    if (runtimeRulesResult.changed) dissolvedFields.push('runtimeRulesText');
    const promptTextsResult = dissolve(session.prepare.promptTexts);
    session.prepare.promptTexts = promptTextsResult.next;
    if (promptTextsResult.changed) dissolvedFields.push('promptTexts');
    const factExtractionResult = dissolve(session.prepare.factExtractionPromptTexts);
    session.prepare.factExtractionPromptTexts = factExtractionResult.next;
    if (factExtractionResult.changed) dissolvedFields.push('factExtractionPromptTexts');
    const reviewResult = dissolve(session.prepare.reviewPromptTexts);
    session.prepare.reviewPromptTexts = reviewResult.next;
    if (reviewResult.changed) dissolvedFields.push('reviewPromptTexts');
    const repairResult = dissolve(session.prepare.repairPromptTexts);
    session.prepare.repairPromptTexts = repairResult.next;
    if (repairResult.changed) dissolvedFields.push('repairPromptTexts');
    if (dissolvedFields.length > 0) {
      upsertProgressStage(session.global.progressStages, displayStage({
        type: 'validation',
        roleId: 'bid-composition-prompt-dissolve',
        status: 'success',
        message: `暗标口径消解：提示词「必须输出表格」规则行已从 ${dissolvedFields.length} 处消费文本移除（${dissolvedFields.join('、')}）`,
        details: ['正文表格需求改由终稿文末附表区按招标附表清单直出；写作/检查/修复提示词不再要求正文输出表格'],
      }, { subtitle: '标书编制规格', order: session.global.progressStages.length }));
      session.global.emitProgress();
    }
  }
  // C1 前置链并行：招标要求提取链（条款穷举切分 → 逐条判定 → 重复合并 → 对账闭合 → 缓存 v4）
  // 独立任务与大纲规划并行执行——判定 LLM 时间被规划 LLM 时间覆盖；
  // 提取失败独立降级为空模型 + skipped 显性警示（提取失败不得阻断生成）
  session.understanding.tenderRequirementsTask = (async (): Promise<TenderRequirementModel> => {
    try {
      // 招标要求条款穷举提取：LLM 对条款单元逐条判定（要求/排除/未判定），位置不限于评审章节——
      // 投标人须知前附表（如 10.9）、专用合同条款（如 5.1.1）、技术标准章节（如第七章）等均覆盖。
      // 提取失败/无绑定资料时返回空模型，章级验收自动跳过。
      // 证据来源：招标/补疑/答疑/评标文件直读全文（绕开检索与事实过滤，条款完整进入提取输入——
      // 历史缺陷：allEvidence 仅含基础事实切片，评标办法正文被整体过滤）；无直读内容时回退检索预算通道。
      const tenderFileEvidence: DocumentEvidence[] = [];
      for (const relativePath of [...session.understanding.evidenceScopePaths].sort()) {
        if (!/招标|补疑|答疑|评标/u.test(relativePath)) continue;
        const detail = session.understanding.getCachedFileDetail(relativePath);
        if (!detail?.chunks?.length) continue;
        for (const chunk of detail.chunks as Array<{ content: string; sectionTitle?: string }>) {
          tenderFileEvidence.push({
            chapterId: 'tender-requirements',
            filePath: detail.file?.relativePath || relativePath,
            score: 1,
            content: chunk.content || '',
            roleId: session.understanding.fileRoleByPath.get(relativePath),
            processingType: session.understanding.fileProcessingByPath.get(relativePath),
            sectionTitle: chunk.sectionTitle,
            source: 'pinned-evidence',
          });
        }
      }
      // 提取输入=直读全量切片（条款化层全文穷举切分，不预筛不剔除——预筛剔除即提取缺失）；
      // 无直读内容时回退检索预算通道（要求层文件优先）
      const extractionEvidence = tenderFileEvidence.length > 0
        ? tenderFileEvidence
        : selectEvidenceByBudget(
          [...session.understanding.allEvidence.filter(item => /招标|评标|投标须知|专用合同|合同条款|技术标准|技术要求/u.test(`${item.filePath || ''}${item.sectionTitle || ''}`)), ...session.understanding.allEvidence.filter(item => !/招标|评标|投标须知|专用合同|合同条款|技术标准|技术要求/u.test(`${item.filePath || ''}${item.sectionTitle || ''}`))],
          { preservePinned: true },
        );
      // 提取结果磁盘缓存 v4（对账闭合门禁 + 全内容指纹哈希）——同一项目资料未变化时跳过判定 LLM，
      // 命中时显性标注「复用上次提取」；env DOCUMENT_EXTRACTION_CACHE=0 显式关闭
      const extractionCacheEnabled = process.env.DOCUMENT_EXTRACTION_CACHE !== '0';
      const extractionCacheKey = extractionCacheEnabled ? tenderRequirementsCacheKey({ collectionEvidence: extractionEvidence }) : undefined;
      const cachedTenderRequirements = extractionCacheKey ? readCachedTenderRequirements(session.prepare.projectRoot, extractionCacheKey) : undefined;
      let tenderRequirements: TenderRequirementModel;
      if (cachedTenderRequirements) {
        tenderRequirements = cachedTenderRequirements;
        // roleId 与提取成功阶段分离：upsertProgressStage 按 type+roleId 覆盖，同 roleId 会吞掉「复用」标注
        upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'tender-requirements-cache', status: 'success', message: '复用上次提取结果（招标资料哈希命中，跳过判定 LLM）', details: tenderRequirementsSummary(tenderRequirements) }, { subtitle: '招标要求提取·缓存复用', order: session.global.progressStages.length }));
        session.global.emitProgress();
      } else {
        tenderRequirements = await session.global.withProgressHeartbeat(() => extractTenderRequirements(extractionEvidence, {
          signal: session.global.input.signal,
          diagnostics: session.planning.generationDiagnostics,
          onPhase: (message, details) => {
            upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'tender-requirements-extraction', status: 'running', message, details }, { subtitle: '招标要求提取', order: session.global.progressStages.length }));
            session.global.emitProgress();
          },
        }));
        // 写缓存（门禁：对账闭合——未判定>0/结构损坏不落盘，坏数据永不固化）
        if (extractionCacheKey) writeCachedTenderRequirements(session.prepare.projectRoot, extractionCacheKey, tenderRequirements);
      }
      if (hasTenderRequirements(tenderRequirements)) {
        upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'tender-requirements-extraction', status: 'success', message: `招标要求结构化提取完成：要求 ${tenderRequirements.reconciliation.entryCount} 条、排除 ${tenderRequirements.reconciliation.excludedCount} 条（${tenderRequirements.reconciliation.batchCount} 批判定）`, details: tenderRequirementsSummary(tenderRequirements) }, { subtitle: '招标要求提取', order: session.global.progressStages.length }));
        session.global.emitProgress();
      } else if (extractionEvidence.length > 0) {
        upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'tender-requirements-extraction', status: 'skipped', message: '招标要求提取未获得有效结果（模型不可用或资料中无要求条款），章级验收自动跳过', details: [] }, { subtitle: '招标要求提取', order: session.global.progressStages.length }));
        session.global.emitProgress();
      }
      // 未判定>0 = 对账未闭合：独立告警（不阻断生成；缓存已由写门禁拒收）
      if (tenderRequirements.extracted && tenderRequirements.reconciliation.undecidedCount > 0) {
        upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'tender-requirements-undecided', status: 'skipped', message: `对账未闭合：${tenderRequirements.reconciliation.undecidedCount} 条条款未判定（LLM 输出缺号且重试后仍缺）`, details: ['未判定条款不进入分配与验收；请检查 LLM 可用性'] }, { subtitle: '招标要求提取·对账', order: session.global.progressStages.length }));
        session.global.emitProgress();
      }
      return tenderRequirements;
    } catch (error) {
      // 提取链独立降级：LLM 异常一律走空模型 + skipped 显性警示，不阻断生成
      upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'tender-requirements-extraction', status: 'skipped', message: '招标要求提取链异常，已降级为空模型（章级验收自动跳过）', details: [`异常信息：${error instanceof Error ? error.message : String(error)}`, '请检查 LLM 可用性'] }, { subtitle: '招标要求提取', order: session.global.progressStages.length }));
      session.global.emitProgress();
      return emptyTenderRequirements(false);
    }
  })();
  session.planning.baseEffectiveChapters = session.understanding.bidStructureAudit.enrichedChapters;
  session.prepare.template = { ...session.prepare.template, chapters: session.planning.baseEffectiveChapters };
  // P4 确定性并行化：planDocument（章节任务规划，纯确定性逻辑 + 本地嵌入分类，无 LLM 调用）提前启动，
  // 与下方评审条目语义构建、招标要求提取、事实主表构建等前置链并行执行，原串行位置 await 结果；
  // 提前启动期间若拒绝，catch 占位防 unhandledRejection（错误在下方 await 处统一抛出）
  session.planning.plannedDocumentTask = planDocument({ template: session.prepare.template, context: session.understanding.agentWorkflow, title: session.prepare.template.name });
  session.planning.plannedDocumentTask.catch(() => undefined);
  session.understanding.chapterGraphMap = new Map<string, { graphFiles: Set<string>; graphBoqItems: Array<{ name: string; quantity: string; unit: string; sourceFiles: string[] }>; graphWorks: string[]; graphMethods: string[]; gaps: string[] }>();
  if (session.understanding.projectGraph) {
    const graphAllFiles = new Set<string>();
    for (const item of [...session.understanding.projectGraph.works, ...session.understanding.projectGraph.methods, ...session.understanding.projectGraph.resources, ...session.understanding.projectGraph.schedule, ...session.understanding.projectGraph.standards, ...session.understanding.projectGraph.risks, ...session.understanding.projectGraph.requirements, ...session.understanding.projectGraph.siteConditions]) (item.sourceFiles || []).forEach(f => graphAllFiles.add(f));
    for (const chapter of session.planning.baseEffectiveChapters) {
      const chapterScope = [chapter.title, chapter.purpose, ...(chapter.sections || []), ...(chapter.requiredFacts || []), ...(chapter.queries || [])].join(' ');
      const matchesText = (value: string) => value && (chineseTokenMatch(value, chapterScope, 0.18) || chineseTokenMatch(value, chapter.title, 0.12));
      const broadChapter = /概况|总体|部署|施工|进度|工期|质量|安全|资源|人材机|材料|机械|劳动力|风险|危大|绿色|环保/u.test(chapterScope);
      const matchedWorks = session.understanding.projectGraph.works.filter(w => w.name && (matchesText(w.name) || broadChapter));
      const matchedMethods = session.understanding.projectGraph.methods.filter(m => m.name && (matchesText(m.name) || (m.applicableWorks || []).some(matchesText) || broadChapter));
      const matchedResources = session.understanding.projectGraph.resources.filter(r => r.name && (matchesText(r.name) || (/资源|人材机|材料|机械|劳动力/u.test(chapterScope) && /material|equipment|labor/u.test(r.type))));
      const matchedGaps = session.understanding.projectGraph.gaps.filter(g => !isIrrelevantProjectGap(g) && (matchesText(g) || broadChapter));

      const graphFiles = new Set<string>();
      for (const w of matchedWorks) (w.sourceFiles || []).forEach(f => graphFiles.add(f));
      for (const m of matchedMethods) (m.sourceFiles || []).forEach(f => graphFiles.add(f));
      for (const r of matchedResources) (r.sourceFiles || []).forEach(f => graphFiles.add(f));
      if (graphFiles.size === 0 && broadChapter) [...graphAllFiles].forEach(f => graphFiles.add(f));

      session.understanding.chapterGraphMap.set(chapter.id, {
        graphFiles,
        graphBoqItems: matchedResources.map(r => ({ name: r.name, quantity: r.quantity, unit: r.unit, sourceFiles: r.sourceFiles || [] })),
        graphWorks: matchedWorks.map(w => w.name),
        graphMethods: matchedMethods.map(m => m.name),
        gaps: matchedGaps,
      });
    }
    if (!session.understanding.scopedIntelligence) {
      upsertProgressStage(session.global.progressStages, displayStage({
        type: 'file_understanding', roleId: 'project-graph-match',
        status: 'success',
        message: `图谱→章节映射完成：${session.understanding.projectGraph.works.length}工程 ${session.understanding.projectGraph.methods.length}工法 ${session.understanding.projectGraph.resources.length}资源 → ${session.planning.baseEffectiveChapters.length}章`,
        details: session.planning.baseEffectiveChapters.map(c => {
          const m = session.understanding.chapterGraphMap.get(c.id);
          return `${displayChapterTitle(c.title)}：匹配文件${m?.graphFiles.size || 0}个，BOQ项${m?.graphBoqItems.length || 0}个`;
        }),
      }, { subtitle: '图谱章节映射' }));
      session.global.emitProgress();
    }
  }
}
