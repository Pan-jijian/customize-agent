/**
 * stageOutlinePlanning：阶段 2 —— 评标校验/评分项提取链消费/小节规划/校准/过滤/路由/预算诊断。
 * P1 六阶段拆分（方案 5.1）：由 documentGenerator.generateDocumentDraft 阶段 2 代码块机械搬迁而来，
 * 变量读写经 session 子对象显式化，业务生成语义与原巨型函数逐字一致（行为保持）。
 */
import type { GenerationSession } from './generationSession';
import type { DocumentTemplateChapter } from '../types';
import { displayChapterTitle } from '../outline';
import { evidenceMatchesFact } from '../factMatching';
import { selectEvidenceByBudget } from '../evidence';
import { buildDocumentBudget } from '../budget';
import { chapterCriteriaText, prioritizeOverviewSections, validateBidStructureBeforeGeneration } from '../constructionBidStructure';
import { buildSemanticSimilarity } from '../semanticSimilarity';
import { filterOffTopicSectionsForChapters } from '../evidenceContentSafety';
import { hasTenderRequirements, normalizeChapterTitleLine, routeTenderRequirementsToChapters, tenderRequirementCheckItems, tenderRequirementSemanticQuery, tenderRequirementsSummary, tenderRequirementsWritingRules } from '../tenderRequirements';
import { applyRequirementSectionAdditions, calibrateOutlineSectionsToRequirements } from '../requirementCalibration';
import { buildFactTokenScopeClassifier } from '../factTokenClassifier';
import { buildChapterIntentClassifier } from '../chapterIntentClassifier';
import { buildProfessionalDepthClassifier } from '../professionalDepthClassifier';
import { buildWritingTaskBrief } from '../documentWritingTaskBrief';
import { buildPlannedTablePlans } from '../constructionOrgTablePlan';
import { runWithAdaptiveConcurrency } from '../utils';
import { displayStage, upsertProgressStage } from '../progress';
import { raiseDocumentLlmConcurrencyForScale } from '../llmClient';
import { createGenerationDiagnostics, selectDocumentGenerationStrategy } from '../rolePipeline';
import { buildGenerationBudget } from '../generationBudget';
import { cleanSectionTitleArtifacts, extractPromptStructuralRules, normalizePlannedSections, planChapterSectionsWithLlm, sectionTitleEquivalent, type PlannedTableRequest } from '../promptRuleExtraction';
import { resolveChapterPromptExecution } from '../documentGeneratorHelpers';
import { constructionOrganizationPrompt } from '../projectIntelligence';
import { planDocument } from '../agentPlanner';
import { deriveDiversityProfile, loadDiversityHistory, recordDiversityUsage } from '../diversityProfile';
import { findFingerprintCollisions, loadFingerprintPool } from '../sectionFingerprint';
import { tuningProfile } from '../tuningProfile';

export async function stageOutlinePlanning(session: GenerationSession): Promise<void> {
  session.planning.effectiveChapters = session.planning.baseEffectiveChapters;
  session.planning.constructionOrgContext = constructionOrganizationPrompt(session.understanding.scopedIntelligence?.constructionOrganizationGraph) || session.understanding.scopedIntelligence?.constructionOrganizationContext;
  // 章节→图谱摘要文本：LLM 融合规划的显式图谱注入，
  // 让规划器知道本项目实际的专业工程/工法/资源面，而非只靠通用章节语义猜专业方向
  session.planning.chapterGraphSummaryText = (chapterId: string) => {
    const chapterGraph = session.understanding.chapterGraphMap.get(chapterId);
    if (!chapterGraph || (!chapterGraph.graphWorks.length && !chapterGraph.graphMethods.length && !chapterGraph.graphBoqItems.length)) return '';
    return [
      chapterGraph.graphWorks.length ? `专业工程：${chapterGraph.graphWorks.slice(0, 8).join('、')}` : '',
      chapterGraph.graphMethods.length ? `主要工法/工艺：${chapterGraph.graphMethods.slice(0, 8).join('、')}` : '',
      chapterGraph.graphBoqItems.length ? `关键资源：${chapterGraph.graphBoqItems.slice(0, 8).map(item => item.name).join('、')}` : '',
    ].filter(Boolean).join('；');
  };
  session.planning.baseProjectContext = [session.prepare.projectUnderstanding.prompt, session.planning.constructionOrgContext].filter(Boolean).join('\n\n');
  session.planning.projectContext = session.planning.baseProjectContext;
  const provisionalTemplate = { ...session.prepare.template, chapters: session.planning.effectiveChapters };
  session.planning.promptStructuralRules = extractPromptStructuralRules([session.prepare.promptTexts, session.global.input.requirement || ''].filter(Boolean).join('\n\n'), session.planning.effectiveChapters);
  session.planning.provisionalBudget = buildDocumentBudget({ requirement: session.global.input.requirement, promptTexts: session.prepare.promptTexts, template: provisionalTemplate, chapters: session.planning.effectiveChapters, spec: session.prepare.documentSpec });
  // 统一融合规划（组件 2）：所有章同一条路——locked（用户声明：提示词强制小节 + 模板/OUTLINE 已提供小节）
  // 置前锁定，LLM 基于提示词/资料/图谱全量规划专业工作面，融合去重后输出；小节结构只来自用户声明与
  // LLM 规划，系统不生成任何小节。规划产物同时含本章表格需求（表名+表头字段），供表格计划构建使用
  let lockedSectionTotal = 0;
  let plannedSectionTotal = 0;
  let llmSectionPlanningCount = 0;
  let plannedTableRequestCount = 0;
  const plannedTablesByChapter = new Map<string, PlannedTableRequest[]>();
  // 清单层标题清洗诊断（改8）：锁定小节路径同样做确定性清洗，脏标题不再进入写作计划
  const sectionPlanCleanupNotes: string[] = [];
  // 多文档反雷同 L1/L3：多样性画像（视角×命名风格，seed=documentId）与指纹避让缓存——
  // 指纹池规划期读一次缓存（规划避让清单/定名轮撞名检测共用同一实例，避免反复读盘）；
  // 避让对「同一 documentId 的历史条目」跳过（resume 不撞自己）
  session.planning.diversityProfile = deriveDiversityProfile(session.global.input.diversitySeed || session.global.input.templateId, loadDiversityHistory(session.global.input.templateId));
  recordDiversityUsage(session.global.input.templateId, session.planning.diversityProfile.id);
  session.planning.fingerprintPool = loadFingerprintPool();
  const fingerprintAvoidTitles = [...new Set(session.planning.fingerprintPool.entries.flatMap(entry => [...(entry.h3 || []), ...(entry.h4 || [])]))].filter(Boolean).slice(0, 60);
  const fingerprintOverlapCheck = (titles: string[]) => findFingerprintCollisions(titles, session.planning.fingerprintPool, { excludeDocumentId: session.global.input.diversitySeed }).map(item => `「${item.title}」↔历史「${item.collidedWith}」`);
  let diversityRetryChapterCount = 0;
  let diversityRemainingCollisionCount = 0;
  session.planning.plannedChapters = await runWithAdaptiveConcurrency(session.planning.effectiveChapters.map((chapter, chapterIndex) => ({ chapter, chapterIndex })), async ({ chapter, chapterIndex }) => {
    const lockedRuleSections = session.planning.promptStructuralRules
      .filter(rule => rule.chapterIndex === chapterIndex || (rule.chapterTitle && displayChapterTitle(rule.chapterTitle) === displayChapterTitle(chapter.title)))
      .flatMap(rule => rule.requiredSections.slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map(section => section.title));
    const lockedSections = normalizePlannedSections([...lockedRuleSections, ...(chapter.sections || [])], chapter.title);
    for (const raw of [...lockedRuleSections, ...(chapter.sections || [])]) {
      const cleaned = cleanSectionTitleArtifacts(String(raw).trim());
      if (cleaned && cleaned !== String(raw).trim()) sectionPlanCleanupNotes.push(`${displayChapterTitle(chapter.title)}：${raw} → ${cleaned}`);
    }
    lockedSectionTotal += lockedSections.length;
    llmSectionPlanningCount += 1;
    const chapterEvidence = selectEvidenceByBudget(session.understanding.writerEvidence.filter(item => item.chapterId === chapter.id || evidenceMatchesFact(item, chapter.title)), { preservePinned: true });
    const roleContext = session.prepare.projectUnderstanding.chapterPlans.find(plan => plan.chapterId === chapter.id)?.writingGoal || '';
    const planningPromptExecution = resolveChapterPromptExecution(session.prepare.promptPlan, chapter);
    const planned = await planChapterSectionsWithLlm({ template: provisionalTemplate, chapter, chapterIndex, evidence: chapterEvidence, promptTexts: planningPromptExecution.promptTexts, projectContext: session.planning.projectContext, requirement: session.global.input.requirement, roleContext, targetWords: session.planning.provisionalBudget.chapterTargets.get(chapter.id) || 1200, projectGraphSummary: session.planning.chapterGraphSummaryText(chapter.id), lockedSections, signal: session.global.input.signal, diversity: { directive: session.planning.diversityProfile.prompt, avoidSections: fingerprintAvoidTitles, overlapCheck: fingerprintOverlapCheck } });
    if (planned.diversity?.retried) {
      diversityRetryChapterCount += 1;
      diversityRemainingCollisionCount += planned.diversity.remainingCollisions;
    }
    plannedTablesByChapter.set(chapter.id, planned.tables);
    plannedTableRequestCount += planned.tables.length;
    plannedSectionTotal += planned.sections.length;
    const llmPlannedSections = planned.sections.filter(section => !lockedSections.some(locked => sectionTitleEquivalent(locked, section)));
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'section-planning', promptId: planningPromptExecution.primaryPromptId, status: planned.sections.length ? 'success' : 'failed', message: `${displayChapterTitle(chapter.title)} 小节规划：锁定 ${lockedSections.length} 个、LLM 规划增量 ${llmPlannedSections.length} 个${planned.tables.length ? `、表格需求 ${planned.tables.length} 项` : ''}`, details: [...planningPromptExecution.promptDetails, ...lockedSections.map(section => `锁定小节：${section}`), ...llmPlannedSections.map(section => `规划小节：${section}`), ...planned.tables.map(table => `表格需求：${table.title}${table.fields.length ? `（${table.fields.join('、')}）` : ''}`)] }, { subtitle: '小节规划' }));
    if (!planned.sections.length) throw new Error(`${displayChapterTitle(chapter.title)} 小节规划未生成可用小节`);
    return { ...chapter, sections: planned.sections };
  }, { kind: 'llmRepair', targetWords: session.planning.provisionalBudget.targetChars || 4000 });
  // C1：等待并行提取链结果（评分项要求——大纲要求校准与后续要求路由的输入）
  session.planning.tenderRequirements = await session.understanding.tenderRequirementsTask;
  // C2 大纲要求校准：规划完成后、主题过滤前——评分项要求在结构层显性承接（创优目标与奖惩/绿色等级/智慧工地等
  // 必提要求在大纲层就有承接小节，而非写章时临场发挥）；校准只输出增量小节 + 结构守恒校验（原大纲小节不可能被删），
  // 空响应/失败/校验不通过一律回退原规划（原 DOCUMENT_REQUIREMENT_CALIBRATION 回退已固化删除：校准恒开）
  let plannedWithCalibration = session.planning.plannedChapters;
  if (hasTenderRequirements(session.planning.tenderRequirements)) {
    const additions = await session.global.withProgressHeartbeat(() => calibrateOutlineSectionsToRequirements({ chapters: plannedWithCalibration, requirementSummary: tenderRequirementsSummary(session.planning.tenderRequirements), templateName: session.prepare.template.name, diversityDirective: session.planning.diversityProfile.prompt, signal: session.global.input.signal }));
    if (additions.length > 0) {
      const calibrationResult = applyRequirementSectionAdditions(plannedWithCalibration, additions);
      if (calibrationResult.applied.length > 0) {
        plannedWithCalibration = calibrationResult.chapters;
        upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'outline-requirement-calibration', status: 'success', message: `大纲要求校准：新增 ${calibrationResult.applied.reduce((sum, item) => sum + item.sections.length, 0)} 个评分项承接小节（结构守恒校验通过）`, details: calibrationResult.applied.map(item => `${displayChapterTitle(item.chapterTitle)}：${item.sections.join('、')}`) }, { subtitle: '大纲要求校准', order: session.global.progressStages.length }));
        session.global.emitProgress();
      } else {
        upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'outline-requirement-calibration', status: 'skipped', message: '大纲要求校准未通过结构守恒校验，回退原规划', details: ['校准新增小节未通过章名匹配/标题清洗校验，全部丢弃'] }, { subtitle: '大纲要求校准', order: session.global.progressStages.length }));
        session.global.emitProgress();
      }
    } else {
      upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'outline-requirement-calibration', status: 'skipped', message: '大纲要求校准未产出有效增量（章节结构已覆盖评分项要求或校准调用失败），回退原规划', details: [] }, { subtitle: '大纲要求校准', order: session.global.progressStages.length }));
      session.global.emitProgress();
    }
  }
  // 大纲小节主题约束（P1 串章根因治理）：投标/评标纪律、评标办法、商务报价类小节在大纲出口统一剔除，
  // 覆盖模板静态 sections 与 LLM 规划两条路径；下游写作/目录/预算无感知
  const plannedWithConstructionOrgRequiredSections = await filterOffTopicSectionsForChapters(plannedWithCalibration);
  const droppedSectionCount = plannedWithCalibration.reduce((count, chapter, index) => {
    const before = (chapter.sections || []).length;
    const after = (plannedWithConstructionOrgRequiredSections[index]?.sections || []).length;
    return count + Math.max(0, before - after);
  }, 0);
  // 大纲编辑单点统计（C2）：补挂回路（validateBidStructureBeforeGeneration）已在补挂生成点
  // 过同一硬剔闸（isHardBannedSectionTitle），不再有「补挂后二次过滤」补丁；本道统计即最终剔除数
  // 规划后章节文本已变化，重建语义相似度缓存（同一闭包缓存 key 不可跨阶段复用）
  const finalCriteriaSimilarity = await buildSemanticSimilarity(
    session.understanding.evaluationItems.map(item => item.title),
    plannedWithConstructionOrgRequiredSections.map(chapterCriteriaText),
  );
  session.planning.finalBidStructureAudit = validateBidStructureBeforeGeneration({ template: session.prepare.template, chapters: plannedWithConstructionOrgRequiredSections, requirement: session.global.input.requirement, evaluationItems: session.understanding.evaluationItems, semanticSimilarity: finalCriteriaSimilarity });
  // 规划表格计划构建（组件 9）：表格来源 = 提示词声明的必需表格（用户声明层，必写）+ LLM 章节规划的
  // 表格需求（规划产物，应写）；无静态目录匹配、无系统创作——规划没有的表不出现。必需表格逐表全章
  // 评分归属；无归属的显性提示，交由文档合成终验的必需表格兜底链（insertRequiredTable）插入
  const plannedTableBuild = buildPlannedTablePlans({ chapters: session.planning.finalBidStructureAudit.enrichedChapters, plannedTables: plannedTablesByChapter, requiredTables: session.prepare.runtimePromptRules.requiredTables });
  session.planning.effectiveChapters = plannedTableBuild.chapters;
  if (plannedTableBuild.unattachedRequiredTables.length > 0) {
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'required-tables-unattached', status: 'success', message: `提示词必需表格归属：${plannedTableBuild.unattachedRequiredTables.length} 张未匹配到明确章节（${plannedTableBuild.unattachedRequiredTables.join('、')}），交由文档合成终验兜底插入`, details: ['未归属必需表格不做语义错挂——防止表格落到不相关章节'] }, { subtitle: '表格计划' }));
  }
  // 改8：概况类小节置首（确定性调序，仅动小节顺序——首章以「编制说明与工程概况」类小节开篇）
  session.planning.effectiveChapters = prioritizeOverviewSections(session.planning.effectiveChapters);
  if (droppedSectionCount > 0) {
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'outline-topic-filter', status: 'success', message: `大纲小节主题过滤：剔除 ${droppedSectionCount} 个评标纪律/商务报价类离题小节`, details: ['被剔除小节不进入写作、目录与预算计划'] }, { subtitle: '大纲主题约束', order: session.global.progressStages.length }));
    session.global.emitProgress();
  }
  if (session.planning.finalBidStructureAudit.issues.length > 0 || session.understanding.bidStructureAudit.issues.length > 0) {
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'bid-structure-audit', status: session.planning.finalBidStructureAudit.issues.some(issue => issue.severity === 'blocker') ? 'failed' : 'success', message: `评标结构符合性校验：${session.planning.finalBidStructureAudit.diagnostics.length} 个结构组，${session.planning.finalBidStructureAudit.diagnostics.filter(item => item.status === 'satisfied').length} 个已满足，${session.planning.finalBidStructureAudit.diagnostics.filter(item => item.status === 'missing' && item.level === 'required').length} 个必查缺失（已自动补挂），${session.planning.finalBidStructureAudit.diagnostics.filter(item => item.status === 'fragmented').length} 个分散`, details: [...session.planning.finalBidStructureAudit.diagnostics.map(item => `${item.status === 'satisfied' ? '满足' : item.status === 'fragmented' ? '分散' : '补挂'}：${item.groupTitle}${item.status === 'missing' ? `（补挂小节：${item.missingSections.join('、')}）` : ''}`), ...session.planning.finalBidStructureAudit.issues.map(issue => `提示：${issue.message}`).slice(0, 8)] }, { subtitle: '评标结构校验' }));
  }
  session.prepare.template = { ...session.prepare.template, chapters: session.planning.effectiveChapters };
  // 评分项要求↔章节标题语义相似度（零响应检测第二道：变体表述兜底；语义模型恒可用，空输入返回恒零函数）
  // 章节标题与零响应检测侧同口径归一化（normalizeChapterTitleLine），避免闭包缓存 key 不一致静默返回 0
  session.planning.requirementsSimilarity = await buildSemanticSimilarity(
    tenderRequirementCheckItems(session.planning.tenderRequirements).map(({ item }) => tenderRequirementSemanticQuery(item)),
    session.planning.effectiveChapters.map(chapter => normalizeChapterTitleLine(chapter.title)),
  );
  // W4/P3 评分项要求章节级路由：每个要求项路由到语义最相似章节，生成时注入该章 roleContext
  // （“本章必须显性响应”），治本于生成侧——不再依赖事后零响应检测+补写
  session.planning.requirementsRoutes = await routeTenderRequirementsToChapters(session.planning.tenderRequirements, session.planning.effectiveChapters, session.planning.requirementsSimilarity);
  if (session.planning.requirementsRoutes.length > 0) {
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'tender-requirement-routing', status: 'success', message: `评分项要求章节级路由：${session.planning.requirementsRoutes.length} 条要求已路由到责任章节（生成时显性响应）`, details: session.planning.requirementsRoutes.map(route => `${route.kind}“${route.item.text}” → ${route.chapterTitle}（相似度 ${route.score.toFixed(2)}）`) }, { subtitle: '要求响应路由', order: session.global.progressStages.length }));
    session.global.emitProgress();
  }
  // 总量口径语义分类器（round-13）：事实反查的口径归属语义复核（根治跨口径误伤）；
  // 本地语义模型恒可用（本地 ONNX 推理），构建失败直接抛出，无不可用降级路径
  session.planning.factTokenScopeClassifier = await buildFactTokenScopeClassifier();
  // P17 章标题意图语义分类器（第 4 期）：蓝图数值密集章阻断/概况章基础事实注入/扬尘六项百分百注入
  // 三处标题判定统一迁移到语义优先、正则兜底（与正则并存一版本，对比命中差异后下线正则）；
  // 本地语义模型恒可用，构建失败直接抛出，无不可用降级路径
  session.planning.chapterIntentClassifier = await buildChapterIntentClassifier(session.planning.effectiveChapters.map(chapter => chapter.title));
  // 专业深度语义分类器（round-14）：章节专业深度/缺项/套话/闭环/依赖的语义判定（根治关键词正则模拟语义打分）；
  // 本地语义模型恒可用，构建失败直接抛出，无不可用降级路径
  session.planning.professionalDepthClassifier = await buildProfessionalDepthClassifier();
  session.planning.writingTaskBrief = buildWritingTaskBrief({ chapters: session.planning.effectiveChapters, factsModel: session.understanding.preliminaryFactsModel, projectGraph: session.understanding.projectGraph || undefined, requirement: session.global.input.requirement, templateName: session.prepare.template.name, tenderRequirements: session.planning.tenderRequirements });
  // 评分项要求写作规则注入：生成时显性响应招标要求（零响应即评标失分），与零响应检测共用同一份提取模型
  session.planning.tenderWritingRulesText = tenderRequirementsWritingRules(session.planning.tenderRequirements);
  session.planning.projectContext = [session.planning.baseProjectContext, session.planning.tenderWritingRulesText].filter(Boolean).join('\n\n');
  // 章级 scoped 上下文（三期收口：旧文档蓝图已删除，事实上下文由一体化蓝图参数桶+章切片接管）：
  // 章级只保留 constructionOrgContext（不在任何 promptTexts 变体中）与评分项要求规则；
  // 3.1 消除 projectUnderstanding.prompt 双份注入：promptTexts（generationControlPrompt 成分）已全链路提供
  // （原 DOCUMENT_CONTEXT_SLIM_CHAPTER 回退已固化删除：章级 scoped 上下文恒开）
  session.planning.chapterScopedProjectContext = (_chapter: DocumentTemplateChapter) => {
    return [session.planning.constructionOrgContext, session.planning.tenderWritingRulesText].filter(Boolean).join('\n\n');
  };
  session.planning.documentBudget = buildDocumentBudget({ requirement: session.global.input.requirement, promptTexts: session.prepare.promptTexts, template: session.prepare.template, chapters: session.planning.effectiveChapters, spec: session.prepare.documentSpec });
  session.planning.plannedDocument = await session.planning.plannedDocumentTask;
  session.understanding.agentWorkflow.documentPlan = session.planning.plannedDocument.plan;
  session.understanding.agentWorkflow.nodes.push(session.planning.plannedDocument.node);
  upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'agent-document-planner', status: 'success', message: session.planning.plannedDocument.node.outputSummary || 'Agent 文档规划完成', details: session.planning.plannedDocument.plan.chapters.map(chapter => `${chapter.title}：${chapter.sections.length} 条细目`) }, { subtitle: 'Agent Document Planner', order: session.global.progressStages.length }));
  session.global.checkpointChapterOrderIds = session.planning.effectiveChapters.map(chapter => chapter.id);
  // P1 全局预算模型：生成前按章节数×目标字数×资料量一次性计算并发数、证据预算、审查深度与修复轮次预算
  const budgetTargetWords = session.planning.documentBudget.targetChars || [...session.planning.documentBudget.chapterTargets.values()].reduce((sum, value) => sum + value, 0);
  session.planning.generationStrategy = selectDocumentGenerationStrategy({ template: session.prepare.template, targetWords: budgetTargetWords, requirement: session.global.input.requirement, materialFileCount: session.prepare.materialFilePaths.length, evidenceCount: session.understanding.allEvidence.length });
  session.planning.generationBudget = buildGenerationBudget({
    template: session.prepare.template,
    chapters: session.planning.effectiveChapters,
    targetWords: budgetTargetWords,
    requirement: session.global.input.requirement,
    materialFileCount: session.prepare.materialFilePaths.length,
    evidenceCount: session.understanding.allEvidence.length,
    hasVeryLargeExplicitChapter: session.planning.effectiveChapters.some(chapter => (chapter.sections || []).filter(Boolean).length >= 30),
    configuredChapterConcurrency: tuningProfile().chapterConcurrency || 0,
    strategy: session.planning.generationStrategy,
  });
  session.planning.generationDiagnostics = createGenerationDiagnostics(session.planning.generationStrategy);
    // 1.1 事实净化门计数并入诊断：extractLocalFactPool 调用点（earlyFactPool）早于本初始化（TDZ），经返回值带回
    if (session.understanding.earlyFactPool.factSanitize.truncated > 0 || session.understanding.earlyFactPool.factSanitize.dropped > 0 || session.understanding.earlyFactPool.factSanitize.repaired > 0) {
      session.planning.generationDiagnostics.factSanitize = { ...session.understanding.earlyFactPool.factSanitize };
    }
  // 4.2 阶段耗时瀑布：规划期起点（蓝图/小节规划/计划主表段；函数前半段图谱检索因 diagnostics TDZ 不计入，
  // 其耗时已有 project-graph 等 stage 展示）。手动埋点而非 measureGenerationStep 包裹：规划段横跨大量
  // 同步构建代码与外部变量声明，闭包化会引发大规模作用域变更
  session.planning.planPhaseStartedAt = Date.now();
  // 按文档规模提升全局 LLM 并发上限（8/16/24/32 档）：长文档调用量大，默认 4 并发会线性拉长总耗时；
  // 端点限流由瞬态重试与失败连击降级串行兜底
  raiseDocumentLlmConcurrencyForScale(budgetTargetWords);
  upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'document-strategy', status: 'success', message: `已自动选择 ${session.planning.generationStrategy.mode} 生成策略：章节审查 ${session.planning.generationStrategy.enableChapterReview ? '启用' : '跳过'}、全局审查 ${session.planning.generationStrategy.enableGlobalReview ? `${session.planning.generationStrategy.globalReviewSamplingRate && session.planning.generationStrategy.globalReviewSamplingRate < 1 ? `抽检 ${Math.round((session.planning.generationStrategy.globalReviewSamplingRate ?? 1) * 100)}%` : '启用'}` : '跳过'}、最终质量审查 ${session.planning.generationStrategy.enableFinalQualityReview ? '启用' : '跳过'}`, details: session.planning.generationBudget.triggers }, { subtitle: '后台自动策略' }));
  // 源级口径冲突裁决节点：向用户明示补疑修正后的统一口径，避免用户对比资料原文旧值与正文新值时误判为生成错误
  if (session.understanding.canonicalFacts.scopeConflicts.length > 0) {
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'scope-conflict-resolution', status: 'success', message: `源级数据口径冲突已裁决（补疑/澄清修正文件权威最高）：${session.understanding.canonicalFacts.scopeConflicts.map(conflict => conflict.resolution ? `${conflict.scope} → ${conflict.resolution}` : `${conflict.scope} → 待人工复核`).join('；')}`, details: session.understanding.canonicalFacts.scopeConflicts.flatMap(conflict => conflict.values.map(value => `来源「${value.sourceFile || '未知文件'}」取值 ${value.value}${value.unit}`)) }, { subtitle: '数据口径裁决' }));
  }
  const sectionPlanningSource = session.prepare.hasExplicitOutline ? 'OUTLINE 章节' : '模板章节';
  session.planning.sectionPlanningStage = displayStage({
    type: 'validation',
    roleId: 'section-planning',
    status: 'success',
    message: `小节规划：${llmSectionPlanningCount} 章统一融合规划（基于${sectionPlanningSource}、提示词强制小节与项目资料）——融合小节合计 ${plannedSectionTotal} 个（其中锁定 ${lockedSectionTotal} 个）、表格需求 ${plannedTableRequestCount} 项`,
    details: sectionPlanCleanupNotes.length ? [...sectionPlanCleanupNotes] : undefined,
  }, { subtitle: '小节规划策略' });

  // 第一个进度回调：角色绑定完成
  const outlineMessage = session.prepare.hasExplicitOutline ? `；识别到 OUTLINE 章节 ${session.prepare.explicitPromptChapters.length} 个` : '；未识别到有效 OUTLINE，将使用模板章节';
  const promptPlanDetails = [
    ...session.prepare.promptPlan.prompts.map(prompt => `${prompt.category}｜${prompt.roleId}｜${prompt.id}｜${prompt.name}｜${prompt.bindingSource}｜${prompt.content.length} 字符｜hash=${prompt.contentHash}｜${prompt.contentPreview}`),
    ...session.prepare.promptPlan.unresolvedRoles.map(roleId => `unresolved｜${roleId}｜项目角色配置中的提示词角色不存在`),
    ...session.prepare.promptPlan.missingResourceRoles.map(roleId => `missingResource｜${roleId}｜提示词角色未显式绑定资源`),
  ];
  upsertProgressStage(session.global.progressStages, displayStage({ type: 'role_binding', roleId: session.prepare.projectRoleConfigId, status: 'success', message: `已绑定项目资料 ${session.prepare.materialFilePaths.length} 份、${session.prepare.promptPlan.prompts.length} 个有效提示词；写作 ${session.prepare.promptPlan.writerPrompts.length}、章节 ${session.prepare.promptPlan.chapterPrompts.length}、抽取 ${session.prepare.promptPlan.extractionPrompts.length}；已自动抽取运行时规则 ${session.prepare.runtimePromptRules.executionSummary.length} 条${outlineMessage}`, details: [...promptPlanDetails, ...session.prepare.runtimePromptRules.executionSummary.map(item => `runtimeRule｜${item}`)] }, { subtitle: session.prepare.projectRoleConfigName, roleName: session.prepare.projectRoleConfigName }));
  upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'runtime-prompt-rules', status: 'success', message: `运行时提示词规则已抽取：${session.prepare.runtimePromptRules.executionSummary.length} 条，版本 ${session.prepare.runtimePromptRules.sourceHash}`, details: session.prepare.runtimePromptRules.executionSummary.length ? [...session.prepare.runtimePromptRules.executionSummary, `必需表格：${session.prepare.runtimePromptRules.requiredTables.join('、') || '无'}`, `必含关键词：${session.prepare.runtimePromptRules.requiredKeywords?.join('、') || '无'}`, `禁含内容：${session.prepare.runtimePromptRules.forbiddenPatterns?.join('、') || '无'}`] : ['未从提示词中识别到额外硬规则，使用系统默认质量规则'] }, { subtitle: '提示词规则执行' }));
  upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'document-readiness', status: session.prepare.readiness.ready ? 'success' : 'failed', message: '生成准备度：绑定资料已就绪', details: session.prepare.readiness.diagnostics }, { subtitle: '生成准备度检查' }));
  upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'diversity-governance', status: 'success', message: `多文档反雷同：组织视角「${session.planning.diversityProfile.perspective}」×命名风格「${session.planning.diversityProfile.style}」；历史指纹避让 ${fingerprintAvoidTitles.length} 个标题${diversityRetryChapterCount > 0 ? `，撞名重规划 ${diversityRetryChapterCount} 章${diversityRemainingCollisionCount > 0 ? `（二次核验仍近似 ${diversityRemainingCollisionCount} 处，已接受）` : ''}` : ''}`, details: [`历史指纹池 ${session.planning.fingerprintPool.entries.length} 条（仅本机历史文档标题与结构，无正文）`, `多样性画像 ${session.planning.diversityProfile.id}`] }, { subtitle: '多样性治理' }));
  upsertProgressStage(session.global.progressStages, session.planning.sectionPlanningStage);
  session.global.emitProgress();
}
