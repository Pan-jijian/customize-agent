/**
 * stageOutlinePlanning：阶段 2 —— 评标校验/招标要求消费/小节规划/校准/过滤/预算诊断。
 * P1 六阶段拆分（方案 5.1）：由 documentGenerator.generateDocumentDraft 阶段 2 代码块机械搬迁而来，
 * 变量读写经 session 子对象显式化，业务生成语义与原巨型函数逐字一致（行为保持）。
 */
import type { GenerationSession } from './generationSession';
import type { DocumentEvidence, DocumentTemplateChapter } from '../types';
import { displayChapterTitle } from '../outline';
import { evidenceMatchesFact } from '../factMatching';
import { selectEvidenceByBudget } from '../evidence';
import { assessEvidenceDensity, buildDocumentBudget, countEvidenceDensityFacts, stripExplicitLengthLines } from '../budget';
import { chapterCriteriaText, prioritizeOverviewSections, validateBidStructureBeforeGeneration } from '../constructionBidStructure';
import { buildSemanticSimilarity } from '../semanticSimilarity';
import { filterOffTopicSectionsForChapters } from '../evidenceContentSafety';
import { assignStructureRequirementsToChapters, hasTenderRequirements, normalizeChapterTitleLine, structureRequirementSemanticQuery, tenderRequirementCheckItems, tenderRequirementSemanticQuery, tenderRequirementsSummary, tenderRequirementsWritingRules } from '../tenderRequirements';
import { applyRequirementSectionAdditions, calibrateOutlineSectionsToRequirements } from '../requirementCalibration';
import { injectReviewModuleSections, injectStructureOrgSections } from '../reviewModuleSections';
import { buildFactTokenScopeClassifier } from '../factTokenClassifier';
import { buildChapterIntentClassifier } from '../chapterIntentClassifier';
import { buildProfessionalDepthClassifier } from '../professionalDepthClassifier';
import { buildWritingTaskBrief } from '../documentWritingTaskBrief';
import { extractClarificationOverrides, renderClarificationConstraintBlock } from '../clarificationOverrides';
import { buildAuthoritativeValues, renderCaliberLedger, renderTruthConstraintBlock } from '../authoritativeValues';
import { collapseOverrideChains, extractLabeledAuthorityValues, extractValueOverrides } from '../valueOverride';
import { buildPlannedTablePlans, attachDiagramArtifacts, extractDiagramArtifacts, mergeStructureDiagramArtifacts } from '../constructionOrgTablePlan';
import { auditPlannedTableScope, type PlannedTableScopeEntry } from '../tableScopeAudit';
import { isBodyTableForbidden } from '../bidComposition';
import { runWithAdaptiveConcurrency } from '../utils';
import { displayStage, upsertProgressStage } from '../progress';
import { raiseDocumentLlmConcurrencyForScale } from '../llmClient';
import { createGenerationDiagnostics, selectDocumentGenerationStrategy } from '../rolePipeline';
import { buildGenerationBudget } from '../generationBudget';
import { cleanSectionTitleArtifacts, extractPromptStructuralRules, normalizePlannedSections, planChapterSectionsWithLlm, sectionTitleEquivalent, type PlannedTableRequest } from '../promptRuleExtraction';
import { extractBoqDivisionCoverage, formatBoqDivisionCoverage } from '../documentFactTrace';
import { resolveChapterPromptExecution } from '../documentGeneratorHelpers';
import { constructionOrganizationPrompt } from '../projectIntelligence';
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
  // 4.40 篇幅指令分层编译（文本侧消解）：文档级字数指令仅作为预算层输入——provisional/final 两次
  // buildDocumentBudget 都从原始文本识别全文目标并编译为章预算（Σ=T 守恒）与块目标（写作层下发）；
  // 此处先捕获识别源（消解会剥离其中数字），随后把原始篇幅语句从用户需求原文、写作/规划/事实/审查/
  // 修复提示词链与用户提示词内容中剥离。消解必须晚于临时预算、早于小节规划——LLM 提示词（规划/写作）
  // 不得再看到原始全文篇幅语句（块级「目标 X 字」+ 全文级「不少于 14 万字」双通道指令是块级系统性
  // 超产的根因），全文级目标只以编译产物（章预算/块目标）形态进入 LLM。
  const budgetLengthSource = { requirement: session.global.input.requirement, promptTexts: session.prepare.promptTexts };
  const dissolvedLengthFields: string[] = [];
  const dissolveLength = (field: string, value: string): string => {
    const next = stripExplicitLengthLines(value || '');
    if (next !== (value || '')) dissolvedLengthFields.push(field);
    return next;
  };
  // 用户需求原文（requirement）：章写作经「用户要求：${requirement}」与事实需求构建直通块提示词
  if (session.global.input.requirement) {
    const nextRequirement = dissolveLength('requirement', session.global.input.requirement);
    session.global.input.requirement = nextRequirement || undefined;
  }
  session.prepare.runtimeRulesText = dissolveLength('runtimeRulesText', session.prepare.runtimeRulesText);
  session.prepare.promptTexts = dissolveLength('promptTexts', session.prepare.promptTexts);
  session.prepare.factExtractionPromptTexts = dissolveLength('factExtractionPromptTexts', session.prepare.factExtractionPromptTexts);
  session.prepare.reviewPromptTexts = dissolveLength('reviewPromptTexts', session.prepare.reviewPromptTexts);
  session.prepare.repairPromptTexts = dissolveLength('repairPromptTexts', session.prepare.repairPromptTexts);
  // 项目上下文（LLM 理解产物可能复述需求原文的篇幅语句）：规划提示词与块写作「上下文/历史记忆」行消费
  session.planning.baseProjectContext = dissolveLength('baseProjectContext', session.planning.baseProjectContext);
  session.planning.projectContext = session.planning.baseProjectContext;
  // 用户提示词原文（promptPlan 解析产物）：章级写作链经 resolveChapterPromptExecution 直接渲染其内容
  //（不经过 prepare.promptTexts 快照）——不消解则「全文正文要求14万字」仍随章提示词进入块写作提示词
  const dissolvedPromptIds = new Set<string>();
  const dissolvedPromptContents = new Set<object>();
  for (const prompt of [...session.prepare.promptPlan.prompts, ...session.prepare.promptPlan.writerPrompts, ...session.prepare.promptPlan.chapterPrompts, ...session.prepare.promptPlan.formattingPrompts, ...session.prepare.promptPlan.extractionPrompts, ...session.prepare.promptPlan.referencePrompts]) {
    if (dissolvedPromptContents.has(prompt)) continue;
    dissolvedPromptContents.add(prompt);
    const next = stripExplicitLengthLines(prompt.content || '');
    if (next !== (prompt.content || '')) {
      prompt.content = next;
      dissolvedPromptIds.add(prompt.id);
    }
  }
  if (dissolvedLengthFields.length > 0 || dissolvedPromptIds.size > 0) {
    upsertProgressStage(session.global.progressStages, displayStage({
      type: 'validation',
      roleId: 'length-instruction-dissolve',
      status: 'success',
      message: `篇幅指令分层编译：全文级字数指令已消解（提示词链 ${dissolvedLengthFields.length} 处、用户提示词 ${dissolvedPromptIds.size} 个），篇幅目标由章预算/块目标统一下达`,
      details: [
        ...dissolvedLengthFields.map(field => `消解字段：${field}`),
        ...(dissolvedPromptIds.size > 0 ? [`消解用户提示词：${[...dissolvedPromptIds].join('、')}`] : []),
        session.planning.provisionalBudget.targetChars ? `识别口径：全文目标 ${session.planning.provisionalBudget.targetChars} 字（已编译为 ${session.planning.effectiveChapters.length} 章预算，Σ=目标守恒）` : '未识别到显式全文目标，按模板/spec 默认预算下达',
        '写作链不再携带原始全文篇幅语句（双通道指令 → 单通道编译下发）',
      ],
    }, { subtitle: '篇幅预算', order: session.global.progressStages.length }));
    session.global.emitProgress();
  }
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
  const fingerprintOverlapCheck = (titles: string[]) => findFingerprintCollisions(titles, session.planning.fingerprintPool, { excludeDocumentId: session.global.input.diversitySeed }).map(item => ({ title: item.title, collidedWith: item.collidedWith }));
  let diversityRenameChapterCount = 0;
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
    // r14 E16 清单分部全景（方法类章）：规划期 LLM 此前无清单分部分项输入，「过路涵」「青砖步道」类
    // 专有分项零规划零写作（丰乐镇实机）；注入分部全景（分部名+代表性清单条目）驱动小节覆盖，
    // 与写作层 roleContext 注入、链尾确定性兜底同源（extractBoqDivisionCoverage 单源）
    const chapterBoqCoverageSummary = /施工方法|施工方案|施工工艺|主要施工内容|分部分项/u.test(chapter.title)
      ? formatBoqDivisionCoverage(extractBoqDivisionCoverage(session.understanding.preliminaryFactsModel))
      : '';
    const planned = await planChapterSectionsWithLlm({ template: provisionalTemplate, chapter, chapterIndex, evidence: chapterEvidence, promptTexts: planningPromptExecution.promptTexts, projectContext: session.planning.projectContext, requirement: session.global.input.requirement, roleContext, targetWords: session.planning.provisionalBudget.chapterTargets.get(chapter.id) || 1200, projectGraphSummary: session.planning.chapterGraphSummaryText(chapter.id), boqCoverageSummary: chapterBoqCoverageSummary || undefined, lockedSections, bodyTablePolicy: session.understanding.bidComposition.bodyTablePolicy, signal: session.global.input.signal, diversity: { directive: session.planning.diversityProfile.prompt, avoidSections: fingerprintAvoidTitles, overlapCheck: fingerprintOverlapCheck } });
    if (planned.diversity?.retried) {
      diversityRenameChapterCount += 1;
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
  // 评审模块承接小节（丰乐镇 R12 评分归因）：6 强制模块与劳务保障制度在规划层显性承接——小节标题即
  // 评审查询原词（bge 实测越阈 0.64-0.93），弱承接标题规范化、缺失注入；写入后随规划结构直通写作/目录/预算
  const reviewModuleResult = injectReviewModuleSections(plannedWithConstructionOrgRequiredSections);
  const plannedWithReviewModules = reviewModuleResult.chapters;
  if (reviewModuleResult.changes.length > 0) {
    const addedCount = reviewModuleResult.changes.reduce((sum, item) => sum + item.added.length, 0);
    const renamedCount = reviewModuleResult.changes.reduce((sum, item) => sum + item.renamed.length, 0);
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'review-module-sections', status: 'success', message: `评审模块承接：补入 ${addedCount} 个评审模块小节、规范化 ${renamedCount} 个承接标题`, details: reviewModuleResult.changes.map(item => `${displayChapterTitle(item.chapterTitle)}：${[...item.added.map(section => `补入「${section}」`), ...item.renamed.map(entry => `「${entry.from}」→「${entry.to}」`)].join('；')}`) }, { subtitle: '评审模块承接', order: session.global.progressStages.length }));
    session.global.emitProgress();
  }
  // B-T2 组织机构承接小节：招标结构要求含组织机构类（org_chart 或机构要素）时，规划层显性承接
  // 「项目管理机构与岗位职责」——写作链按小节展开，规划无承接则组织机构内容无承载位置。
  // 目标章与写作注入同路由口径（同一路由函数、同一章标题归一化；章节标题集与蓝图分配一致，
  // 防「小节在此章、指令挂彼章」错位）；低置信不挂章不注入，防错挂。
  let plannedWithStructureSections = plannedWithReviewModules;
  {
    const structureRequirements = session.planning.tenderRequirements?.structureRequirements || [];
    if (structureRequirements.length > 0) {
      const structureSimilarity = await buildSemanticSimilarity(
        structureRequirements.map(structureRequirementSemanticQuery),
        plannedWithReviewModules.map(chapter => normalizeChapterTitleLine(chapter.title)),
      );
      const structureRoute = assignStructureRequirementsToChapters(structureRequirements, plannedWithReviewModules, structureSimilarity);
      const structureSectionResult = injectStructureOrgSections(plannedWithReviewModules, structureRoute.assignments);
      plannedWithStructureSections = structureSectionResult.chapters;
      if (structureSectionResult.changes.length > 0) {
        const addedCount = structureSectionResult.changes.reduce((sum, item) => sum + item.added.length, 0);
        const renamedCount = structureSectionResult.changes.reduce((sum, item) => sum + item.renamed.length, 0);
        upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'structure-org-sections', status: 'success', message: `组织机构承接：${addedCount > 0 ? `补入 ${addedCount} 个「项目管理机构与岗位职责」小节` : ''}${addedCount > 0 && renamedCount > 0 ? '、' : ''}${renamedCount > 0 ? `规范化 ${renamedCount} 个承接标题` : ''}`, details: structureSectionResult.changes.map(item => `${displayChapterTitle(item.chapterTitle)}：${[...item.added.map(section => `补入「${section}」`), ...item.renamed.map(entry => `「${entry.from}」→「${entry.to}」`)].join('；')}`) }, { subtitle: '组织机构承接', order: session.global.progressStages.length }));
        session.global.emitProgress();
      }
    }
  }
  // 大纲编辑单点统计（C2）：补挂回路（validateBidStructureBeforeGeneration）已在补挂生成点
  // 过同一硬剔闸（isHardBannedSectionTitle），不再有「补挂后二次过滤」补丁；本道统计即最终剔除数
  // 规划后章节文本已变化，重建语义相似度缓存（同一闭包缓存 key 不可跨阶段复用）
  const finalCriteriaSimilarity = await buildSemanticSimilarity(
    session.understanding.evaluationItems.map(item => item.title),
    plannedWithStructureSections.map(chapterCriteriaText),
  );
  session.planning.finalBidStructureAudit = validateBidStructureBeforeGeneration({ template: session.prepare.template, chapters: plannedWithStructureSections, requirement: session.global.input.requirement, evaluationItems: session.understanding.evaluationItems, semanticSimilarity: finalCriteriaSimilarity });
  // R20 C4 规划污染过滤（明标）：LLM 小节规划可能把资料中非本标段范围的内容（其他专业工程领域实体，
  // 如图纸通用说明条款）规划成表格——单次 LLM 范围核对（判据 = 招标要求摘要 + 清单分部全景），
  // 超范围表从规划中剔除（防虚假缺失对账扣分 + 防补表轮写入超范围内容）；剔除超 1/3 或调用失败
  // 保留原规划不阻断。正文禁表（显式禁表句）下规划表为空自动跳过；无清单知识库时判据退化为招标摘要仍可用。
  let filteredPlannedTables = plannedTablesByChapter;
  if (!isBodyTableForbidden(session.understanding.bidComposition) && plannedTablesByChapter.size > 0) {
    const chapterTitleOf = (chapterId: string) => displayChapterTitle(session.planning.finalBidStructureAudit.enrichedChapters.find(chapter => chapter.id === chapterId)?.title || chapterId);
    const scopeEntries: PlannedTableScopeEntry[] = [...plannedTablesByChapter.entries()].flatMap(([chapterId, chapterTables]) => chapterTables.map(table => ({ chapterTitle: chapterTitleOf(chapterId), title: table.title, fields: table.fields })));
    if (scopeEntries.length > 0) {
      const scopeAudit = await auditPlannedTableScope({
        tables: scopeEntries,
        requirementSummary: tenderRequirementsSummary(session.planning.tenderRequirements),
        boqCoverageSummary: formatBoqDivisionCoverage(extractBoqDivisionCoverage(session.understanding.preliminaryFactsModel)),
        templateName: session.prepare.template.name,
        signal: session.global.input.signal,
      });
      if (scopeAudit.removed.length > 0) {
        const removedKeys = new Set(scopeAudit.removed.map(item => `${item.chapterTitle}\n${item.title}`));
        filteredPlannedTables = new Map([...plannedTablesByChapter.entries()].map(([chapterId, chapterTables]) => [chapterId, chapterTables.filter(table => !removedKeys.has(`${chapterTitleOf(chapterId)}\n${table.title}`))]));
        upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'table-scope-audit', status: 'success', message: `表格范围核对：剔除 ${scopeAudit.removed.length} 项超范围规划表（非本标段工程实体）`, details: scopeAudit.removed.map(item => `${item.chapterTitle}：${item.title}（${item.reason}）`) }, { subtitle: '表格范围核对', order: session.global.progressStages.length }));
        session.global.emitProgress();
      } else if (scopeAudit.skipped) {
        upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'table-scope-audit', status: 'skipped', message: `表格范围核对跳过：${scopeAudit.skipped}`, details: [] }, { subtitle: '表格范围核对', order: session.global.progressStages.length }));
        session.global.emitProgress();
      }
    }
  }
  // 规划表格计划构建（组件 9）：表格来源 = 提示词声明的必需表格（用户声明层，必写）+ LLM 章节规划的
  // 表格需求（规划产物，应写）；无静态目录匹配、无系统创作——规划没有的表不出现。必需表格逐表全章
  // 评分归属；无归属的显性提示，交由文档合成终验的必需表格兜底链（insertRequiredTable）插入。
  // 标书编制规格为 forbidden（招标显式禁表句）时短路：正文不生成任何表格计划（含提示词必需表格——
  // 已由阶段 1 编制规格逐一裁决：能对应招标附表的收敛入终稿附表区，其余取消表格形式转文字表述）；
  // 允许口径（暗标/明标/未识别且无禁表证据）正常构建（C1 证据驱动三态判定）。
  // 防御：判定缺失（非常规 session）时 bodyTablePolicy 为空，buildPlannedTablePlans 按常规口径放开
  const plannedTableBuild = buildPlannedTablePlans({ chapters: session.planning.finalBidStructureAudit.enrichedChapters, plannedTables: filteredPlannedTables, requiredTables: session.prepare.runtimePromptRules.requiredTables, bodyTablePolicy: session.understanding.bidComposition?.bodyTablePolicy });
  // R20 C1 图类呈现元件（明标）：招标要求条目识别出的图类元件（横道图/网络图/布置图等）语义归属后注入
  // 章级文字框图/时间轴承载指令（diagramRequirements）；相似度低于阈值不注入（防错挂），未归属显性展示。
  // 正文禁表（显式禁表句）：图类由终稿附表区（appendixPlan）承载，正文不注入；允许口径正常注入
  // （写作侧禁图由 bodyFigurePolicy 独立驱动——图类以表格化数据/文字框图表达，不插入图片）
  let chaptersWithDiagramPlans = plannedTableBuild.chapters;
  if (!isBodyTableForbidden(session.understanding.bidComposition) && hasTenderRequirements(session.planning.tenderRequirements)) {
    // B-T1：图类元件数据源 = 要求池 entries（R20 C1）∪ A-T1 结构/呈现要求（含被排除条款的图类信号，不随排除丢失），
    // 按图名核心词去重——图类承载指令与终稿图位链消费同一图类集合
    const diagramArtifacts = mergeStructureDiagramArtifacts(
      extractDiagramArtifacts(session.planning.tenderRequirements?.entries || []),
      session.planning.tenderRequirements?.structureRequirements || [],
    );
    if (diagramArtifacts.length > 0) {
      const diagramSimilarity = await buildSemanticSimilarity(diagramArtifacts.map(artifact => artifact.source), chaptersWithDiagramPlans.map(chapter => chapter.title));
      const diagramAttach = attachDiagramArtifacts(chaptersWithDiagramPlans, diagramArtifacts, diagramSimilarity);
      chaptersWithDiagramPlans = diagramAttach.chapters;
      const attachedEntries: string[] = [];
      for (const chapter of chaptersWithDiagramPlans) {
        for (const item of chapter.diagramRequirements || []) attachedEntries.push(`${displayChapterTitle(chapter.title)}：${item.split('（招标要求原文')[0]}`);
      }
      upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'diagram-artifacts', status: 'success', message: `图类呈现计划：识别 ${diagramArtifacts.length} 项图类要求（${diagramArtifacts.map(artifact => artifact.name).join('、')}），注入 ${attachedEntries.length} 项${diagramAttach.unattached.length > 0 ? `，未归属 ${diagramAttach.unattached.length} 项（相似度不足不注入，防错挂）` : ''}`, details: attachedEntries }, { subtitle: '图表呈现计划', order: session.global.progressStages.length }));
      session.global.emitProgress();
    }
  }
  session.planning.effectiveChapters = chaptersWithDiagramPlans;
  if (isBodyTableForbidden(session.understanding.bidComposition)) {
    const composition = session.understanding.bidComposition;
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'bid-composition-table-policy', status: 'success', message: `编制规格消费：正文禁表（显式禁表句）——小节规划 ${plannedTableRequestCount} 项表格需求与提示词必需表格 ${session.prepare.runtimePromptRules.requiredTables.length} 张均不进入正文，图表由终稿附表区 ${composition.appendixPlan.length} 项附表承接`, details: [...composition.conflicts.map(conflict => `${conflict.rule} → ${conflict.resolution}`), ...composition.appendixPlan.map(entry => `附表${entry.no}：${entry.title}${entry.kind === 'figure' ? '（图类，图件说明承载）' : `（数据源：${entry.dataSource}）`}`)] }, { subtitle: '表格计划' }));
    session.global.emitProgress();
  } else if (session.understanding.bidComposition?.bidType === 'blind') {
    // C1 显性展示：暗标但正文表格口径按证据判定为允许（不得按标书类型硬推禁表——真实招标存在
    // 暗标明确允许正文表格/图表的实例：「采用文字并结合图表形式」「图表编制软件自行确定」）
    const plannedTableCount = plannedTableBuild.chapters.reduce((count, chapter) => count + (chapter.tablePlans?.length || 0), 0);
    upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'bid-composition-table-policy', status: 'success', message: `暗标编制规格消费：招标正文表格口径按证据判定为允许——表格计划 ${plannedTableCount} 项正常构建进入正文（原「暗标一律禁表」硬推已删除）；正文图片仍禁（图类以表格化数据/文字框图表达）${plannedTableBuild.unattachedRequiredTables.length > 0 ? `；提示词必需表格 ${plannedTableBuild.unattachedRequiredTables.length} 张未归属，交由终验兜底插入` : ''}`, details: [...session.understanding.bidComposition.conflicts.map(conflict => `${conflict.rule} → ${conflict.resolution}`), ...session.understanding.bidComposition.appendixPlan.map(entry => `附表${entry.no}：${entry.title}${entry.kind === 'figure' ? '（图类，图件说明承载）' : `（数据源：${entry.dataSource}）`}`)] }, { subtitle: '表格计划' }));
    session.global.emitProgress();
  } else if (plannedTableBuild.unattachedRequiredTables.length > 0) {
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
  // 章节标题与零响应检测侧同口径归一化（normalizeChapterTitleLine），避免闭包缓存 key 不一致静默返回 0；
  // 池必须覆盖结构要求查询文本（structureRequirementSemanticQuery 单源）——闭包对未预嵌入文本静默返回 0，
  // 缺失将使结构要求路由（写作注入）与终稿图位规格全量判定 0 分而空转
  session.planning.requirementsSimilarity = await buildSemanticSimilarity(
    [
      ...tenderRequirementCheckItems(session.planning.tenderRequirements).map(({ item }) => tenderRequirementSemanticQuery(item)),
      ...(session.planning.tenderRequirements?.structureRequirements || []).map(structureRequirementSemanticQuery),
    ],
    session.planning.effectiveChapters.map(chapter => normalizeChapterTitleLine(chapter.title)),
  );
  // 评分项要求分配下沉阶段 3 蓝图构建（assignTenderRequirementsToChapters 随蓝图落盘：唯一权威分配 + 分配对账）
  // 总量口径语义分类器（round-13）：事实反查的口径归属语义复核（根治跨口径误伤）；
  // 本地语义模型恒可用（本地 ONNX 推理），构建失败直接抛出，无不可用降级路径
  session.planning.factTokenScopeClassifier = await buildFactTokenScopeClassifier();
  // P17 章标题意图语义分类器（第 4 期）：蓝图数值密集章阻断/概况章基础事实注入/扬尘六项百分百注入
  // 三处标题判定统一迁移到语义优先、正则兜底（与正则并存一版本，对比命中差异后下线正则）；
  // 本地语义模型恒可用，构建失败直接抛出，无不可用降级路径
  // 4.55.22：声明**全部**查询键——章写作链除章标题外还会传「标题+用途」（扬尘六项判定），
  // 原先只登记标题 → 该次查询静默落空、语义通道形同不存在（详见 buildChapterIntentClassifier 注释）
  session.planning.chapterIntentClassifier = await buildChapterIntentClassifier(session.planning.effectiveChapters.map(chapter => ({
    key: chapter.title,
    aliases: chapter.purpose ? [`${chapter.title}${chapter.purpose}`] : [],
  })));
  // 专业深度语义分类器（round-14）：章节专业深度/缺项/套话/闭环/依赖的语义判定（根治关键词正则模拟语义打分）；
  // 本地语义模型恒可用，构建失败直接抛出，无不可用降级路径
  session.planning.professionalDepthClassifier = await buildProfessionalDepthClassifier();
  // 4.55.17 答疑澄清生效口径（招标与答疑不一致时以答疑为准）：从证据（文本 + 来源）抽取 override，
  // 渲染为全文硬约束注入写作简报——实测缺陷：正文一处「总工期为365日历天」、另一处「变更修改为330日历天」、
  // 进度表按 365 排到第 348 天（三套口径并存）
  session.planning.clarificationOverrides = extractClarificationOverrides(
    (session.understanding.allEvidence || []).map((item: DocumentEvidence) => ({ text: String(item.content || ''), source: `${item.filePath || ''} ${item.sectionTitle || ''}` })),
  );
  // 4.55.19 切写侧：写作约束由**真值层**出口（覆盖全部发生变更的属性，不限工期/开工日期）
  //
  // 4.55.22 单源修复：本处原先**自行重算**一份审计，且输入比阶段 1 更窄——
  // 事实池只取 preciseFacts/project/schedule/quality/safety（漏 resources/bills/rules/
  // specifications/drawings 五个池），证据源用**未过滤**的 allEvidence（含已被内容安全
  // 从写作链断开的商务/纪律证据）。而阶段 1 应用覆盖表的依据是 `arbitratedFacts`（全池）+
  // `writerEvidence`（已过滤）。两份审计因此可以算出**不同的生效值**——
  // 写手被告知的口径与实际替换进其输入的值不一致（"两个单一真值源"）。
  // 现直接消费阶段 1 的无条件产物 `earlyTruthAudit`；仅在缺失时（如复跑路径）回退重算。
  {
    const truthAudit = session.planning.earlyTruthAudit ?? (() => {
      const truthFacts = [
        ...(session.understanding.preliminaryFactsModel?.preciseFacts || []),
        ...(session.understanding.preliminaryFactsModel?.project || []),
        ...(session.understanding.preliminaryFactsModel?.schedule || []),
        ...(session.understanding.preliminaryFactsModel?.quality || []),
        ...(session.understanding.preliminaryFactsModel?.safety || []),
      ].map((fact: { key?: string; fieldName?: string; value?: unknown; sourceFile?: string }) => ({ key: fact.key, label: fact.fieldName, value: fact.value, sourceFile: fact.sourceFile }));
      const truthSources = [
        ...(session.understanding.allEvidence || []).map((item: DocumentEvidence) => ({ text: String(item.content || ''), source: `${item.filePath || ''} ${item.sectionTitle || ''}` })),
        ...truthFacts.map((fact: { value?: unknown; sourceFile?: string }) => ({ text: String(fact.value ?? ''), source: String(fact.sourceFile || '') })),
      ];
      return buildAuthoritativeValues({
        facts: truthFacts,
        overrides: collapseOverrideChains(extractValueOverrides(truthSources)),
        // 带口径标签的权威值（答疑「最高投标限价现调整为:157166591.34元」→ 写作前即定死生效金额；
        // 1 号答疑的 172460314.52 元已被 5 号取代，不得作为示例值）
        labeledValues: extractLabeledAuthorityValues(truthSources),
      });
    })();
    session.planning.caliberLedger = renderCaliberLedger(truthAudit as Parameters<typeof renderCaliberLedger>[0]);
    session.planning.truthConstraint = renderTruthConstraintBlock(truthAudit as Parameters<typeof renderTruthConstraintBlock>[0]);
  }
  session.planning.writingTaskBrief = buildWritingTaskBrief({ chapters: session.planning.effectiveChapters, factsModel: session.understanding.preliminaryFactsModel, projectGraph: session.understanding.projectGraph || undefined, requirement: session.global.input.requirement, templateName: session.prepare.template.name, clarificationConstraint: [session.planning.truthConstraint, renderClarificationConstraintBlock(session.planning.clarificationOverrides || [])].filter(Boolean).join('\n\n') });
  // 评分项要求写作规则注入：生成时显性响应招标要求（零响应即评标失分），与零响应检测共用同一份提取模型；
  // 全文级篇幅语句同样消解（规则文本随章级 scoped 上下文直通块写作提示词）
  session.planning.tenderWritingRulesText = dissolveLength('tenderWritingRulesText', tenderRequirementsWritingRules(session.planning.tenderRequirements));
  session.planning.projectContext = [session.planning.baseProjectContext, session.planning.tenderWritingRulesText].filter(Boolean).join('\n\n');
  // 章级 scoped 上下文（三期收口：旧文档蓝图已删除，事实上下文由一体化蓝图参数桶+章切片接管）：
  // 章级只保留 constructionOrgContext（不在任何 promptTexts 变体中）与评分项要求规则；
  // 3.1 消除 projectUnderstanding.prompt 双份注入：promptTexts（generationControlPrompt 成分）已全链路提供
  // （原 DOCUMENT_CONTEXT_SLIM_CHAPTER 回退已固化删除：章级 scoped 上下文恒开）
  session.planning.chapterScopedProjectContext = (_chapter: DocumentTemplateChapter) => {
    return [session.planning.constructionOrgContext, session.planning.tenderWritingRulesText].filter(Boolean).join('\n\n');
  };
  // 4.40 篇幅指令分层编译：最终预算与临时预算同源（budgetLengthSource 为消解前捕获的原始文本——
  // 篇幅数字所在），chapters 用规划后 effectiveChapters 重分配
  session.planning.documentBudget = buildDocumentBudget({ requirement: budgetLengthSource.requirement, promptTexts: budgetLengthSource.promptTexts, template: session.prepare.template, chapters: session.planning.effectiveChapters, spec: session.prepare.documentSpec });
  session.planning.plannedDocument = await session.planning.plannedDocumentTask;
  session.understanding.agentWorkflow.documentPlan = session.planning.plannedDocument.plan;
  session.understanding.agentWorkflow.nodes.push(session.planning.plannedDocument.node);
  upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'agent-document-planner', status: 'success', message: session.planning.plannedDocument.node.outputSummary || 'Agent 文档规划完成', details: session.planning.plannedDocument.plan.chapters.map(chapter => `${chapter.title}：${chapter.sections.length} 条细目`) }, { subtitle: 'Agent Document Planner', order: session.global.progressStages.length }));
  session.global.checkpointChapterOrderIds = session.planning.effectiveChapters.map(chapter => chapter.id);
  // P1 全局预算模型：生成前按章节数×目标字数×资料量一次性计算并发数、证据预算、审查深度与修复轮次预算
  const budgetTargetWords = session.planning.documentBudget.targetChars || [...session.planning.documentBudget.chapterTargets.values()].reduce((sum, value) => sum + value, 0);
  // G 线 P1-14 生成前「证据密度体检」：**资料能支撑的字数下界低于目标即明确失败**，
  // 并给出差额与可操作的补料清单——这是「不接受降级交付」的落点。
  // 前置在这里（而非更早）是因为目标字数由 documentBudget 解出；仍早于任何章节写作，属「生成前」。
  // 数据源与质检同源（preliminaryFactsModel：量化参数 + 结构化表行 + 其余基础事实）；
  // 图纸事实以 CAD 证据切片数为代理——图纸标注已并入事实池，单独计数会与基础事实重复。
  // 基础事实计数按**稳定身份去重**（countEvidenceDensityFacts）：五池与 schemaFacts 同源于一个 facts
  // 数组且一条事实可命多池/多字段，重复计数会让 supportableWords 虚高、前置密度门形同不触发。
  const densityModel = session.understanding.preliminaryFactsModel;
  const densityCounts = countEvidenceDensityFacts({
    pools: densityModel
      ? [densityModel.project, densityModel.schedule, densityModel.quality, densityModel.safety, densityModel.resources, ...Object.values(densityModel.schemaFacts ?? {})]
      : [],
    preciseFacts: densityModel?.preciseFacts,
  });
  const densityParameters = densityCounts.parameters;
  const densityBoqRows = (densityModel?.tables ?? []).reduce((sum, table) => sum + (table.rows?.length ?? 0), 0);
  const densityBasicFacts = densityCounts.basicFacts;
  // CAD 证据切片的识别口径与全仓一致：来源路径以图纸扩展名结尾
  const densityDrawingFacts = (session.understanding.writerEvidence ?? []).filter(item => /[.](?:dwg|dxf)$/iu.test(String((item as { filePath?: string }).filePath ?? ''))).length;
  const density = assessEvidenceDensity({
    targetWords: budgetTargetWords,
    parameters: densityParameters,
    boqRows: densityBoqRows,
    drawingFacts: densityDrawingFacts,
    basicFacts: densityBasicFacts,
  });
  session.planning.evidenceDensity = density;
  upsertProgressStage(session.global.progressStages, displayStage({
    type: 'validation',
    roleId: 'evidence-density-check',
    status: density.sufficient ? 'success' : 'failed',
    message: density.sufficient
      ? `证据密度体检通过：资料可支撑约 ${density.supportableWords} 字（目标 ${density.targetWords} 字）`
      : `证据密度不足：资料可支撑约 ${density.supportableWords} 字，低于目标 ${density.targetWords} 字（差额约 ${Math.round(density.shortfall)} 字）`,
    details: density.remediation,
  }, { subtitle: '生成准备', order: session.global.progressStages.length }));
  if (!density.sufficient) throw new Error(`证据密度不足，无法支撑目标篇幅：${density.remediation.join(' ')}`);
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
  upsertProgressStage(session.global.progressStages, displayStage({ type: 'validation', roleId: 'diversity-governance', status: 'success', message: `多文档反雷同：组织视角「${session.planning.diversityProfile.perspective}」×命名风格「${session.planning.diversityProfile.style}」；历史指纹避让 ${fingerprintAvoidTitles.length} 个标题${diversityRenameChapterCount > 0 ? `，撞名局部改名 ${diversityRenameChapterCount} 章${diversityRemainingCollisionCount > 0 ? `（局部改名后仍近似 ${diversityRemainingCollisionCount} 处，已接受）` : ''}` : ''}`, details: [`历史指纹池 ${session.planning.fingerprintPool.entries.length} 条（仅本机历史文档标题与结构，无正文）`, `多样性画像 ${session.planning.diversityProfile.id}`] }, { subtitle: '多样性治理' }));
  upsertProgressStage(session.global.progressStages, session.planning.sectionPlanningStage);
  session.global.emitProgress();
}
