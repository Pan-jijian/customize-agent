import { closedLoopDensityIssues, plannedAutoSpecGateIssues, boqPlacementIssues, crossChapterConsistencyIssues, degenerateContentIssues, drawingReferenceIssues, duplicateBasicInfoIssues, evaluationCriteriaCoverageIssues, formalContentIntegrityIssues, formalHeadingHierarchyIssues, formalPlaceholderIssues, formalStyleIssues, generatedFactVerificationIssuesAsync, genericProfessionalContentIssues, headingDuplicateIssues, innovationTechCoverageIssues, instructionLikeHeadingIssues, managementMeasureNumberIssues, markdownTableQualityIssues, minChapterSectionIssues, preciseFactUsageIssues, processSpecConflictIssues, professionalContentIssues, professionalScoreIssues, promptExampleLeakIssues, sectionContentIntegrityIssues, tableSpamIssues, tocBodyConsistencyIssues, tocHierarchyIssues } from './qualityValidation';
import type { FactTokenScopeClassifier } from './factTokenClassifier';
import type { ProfessionalDepthAnalysis, ProfessionalDepthClassifier } from './professionalDepthClassifier';
import { boqRowTraceIssues, buildBoqRowTraces } from './documentFactTrace';
import { chapterDependencyIssues, documentDeliveryScoreIssues, evidenceUsageCoverageIssues, paragraphGenericIssues } from './documentDeliveryReport';
import { plannedStructureIssues, promptDocumentRuleIssues, tertiaryHeadingIssues } from './markdownComposer';
import { webEvidenceLeakageIssues } from './webResearchService';
import { constructionOrgChapterDataCoverageIssues, constructionOrgConsistencyIssues } from './constructionOrgConsistency';
import { constructionOrgBonusModuleIssues, constructionOrgControlLoopIssues, constructionOrgDivisionSectionIssues, constructionOrgGenericLanguageIssues, constructionOrgMajorContentIssues, constructionOrgProfessionalChainIssues } from './constructionOrgQualityRules';
import { areaArithmeticIssues, basicInfoScheduleFieldIssues, bodySentencesForSemantic, closurePhraseDensityCapIssues, collapseRepeatedWords, commercialDataInBodyIssues, crossSectionNumericConflictIssues, dangerousListConsistencyIssues, fabricatedStartDateIssues, fieldValueMismatchIssues, foundationFormResidueIssues, localAdaptationKeywordIssues, nodeScheduleConsistencyIssues, overviewRecapCandidates, overviewRecapIssues, paragraphOpeningRepeatIssues, repeatedWordIssues, resourceConsistencyIssues, selfUnderminingCandidateIssues, sixHundredPercentCoverageIssues, stripCommercialDataSentences, supportSystemConflictIssues } from './documentIntegrityChecks';
import { buildSemanticSimilarity } from './semanticSimilarity';
import { normalizeChapterTitleLine, requirementsCoverageIssues, tenderRequirementCheckItems, tenderRequirementSemanticQuery } from './tenderRequirements';
import { internalTerminologyAnchorIssues } from './internalTerminologyAnchors';
import { parameterConceptConflictIssues } from './parameterConceptConflicts';
import { constructionSystemCoverageIssues } from './constructionSystemCoverage';
import { dangerousApplicabilityIssues } from './dangerousApplicability';
import { stagePhrasingIssues } from './stagePhrasing';
import { emergencySectionDepthIssues } from './emergencySectionDepth';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplate, DocumentTemplateChapter, NumericScopeConflict, PromptBinding, PromptDocumentRuleSet, TenderRequirementModel, ValidationIssue } from './types';

export async function buildStandardFinalValidationIssues(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
  factsModel: DocumentFactsModel;
  template: DocumentTemplate;
  promptBindings: PromptBinding[];
  promptDocumentRules?: PromptDocumentRuleSet;
  /** 源级同口径冲突裁决（校验基准与生成裁决同源） */
  scopeConflicts?: NumericScopeConflict[];
  /** 招标文件评分条目标题（承接审计产物），用于后置正文命中检查 */
  evaluationCriteriaItems?: string[];
  /** 模块挂靠后的大纲（含四新等承诺小节）：承诺承接检查的基准，缺省回退 template.chapters */
  effectiveChapters?: DocumentTemplateChapter[];
  /** 招标文件文本性评分项要求（LLM 结构化提取产物），零响应检测锚点 */
  tenderRequirements?: TenderRequirementModel;
  /** 评分项要求↔章节语义相似度函数（本地 bge 余弦），变体表述响应兜底 */
  requirementsSimilarity?: (leftText: string, rightText: string) => number;
  /** 总量口径语义分类器（round-13）：事实反查的口径归属语义复核（本地 bge 恒可用） */
  factTokenScopeClassifier: FactTokenScopeClassifier;
  /** 专业深度语义分类器（round-14）：章节专业深度/缺项/套话/闭环/依赖的语义判定（本地 bge 恒可用） */
  professionalDepthClassifier: ProfessionalDepthClassifier;
}): Promise<ValidationIssue[]> {
  const factVerification = await generatedFactVerificationIssuesAsync(input.markdown, input.factsModel, { scopeClassifier: input.factTokenScopeClassifier });
  // W4/P3 评分项要求正文级语义检测：要求项 ↔（章节标题 + 正文句）同闭包 embedding，
  // 正文句采样与 documentIntegrityChecks.bodySentencesForSemantic 同口径（历史缺陷：只查章节标题，
  // 正文未落位而标题语义接近即误判为已响应）；语义模型恒可用，空输入由 buildSemanticSimilarity 返回恒零函数
  const requirementQueries = tenderRequirementCheckItems(input.tenderRequirements).map(({ item }) => tenderRequirementSemanticQuery(item));
  const requirementChapterLines = input.markdown.split(/\n/u).filter(line => /^#{2,4}\s/u.test(line.trim())).map(line => normalizeChapterTitleLine(line)).filter(Boolean).slice(0, 80);
  const requirementBodySentences = bodySentencesForSemantic(input.markdown);
  const requirementsSimilarityForCoverage = await buildSemanticSimilarity(requirementQueries, [...requirementChapterLines, ...requirementBodySentences]);
  // 评分条目标题语义兑底专用闭包：evaluationCriteriaCoverageIssues 以条目标题原文为查询 key，
  // 必须与构建侧同口径（历史缺陷：误传 requirementsSimilarity——前附表条款闭包缓存 key 与条目标题不一致，语义兑底恒 0）
  const evaluationCriteriaSimilarity = await buildSemanticSimilarity(input.evaluationCriteriaItems || [], requirementChapterLines);
  // 预计算全部章节的专业深度语义分析（同一章节文本被多个校验器复用，只嵌入一次）；
  // 空文本章节返回 undefined 不入 Map（输入边界：无内容可分析，消费方按缺失跳过，不得用全 false 替身）
  const analyses = new Map((await Promise.all(input.chapters.map(async chapter => [chapter.title, await input.professionalDepthClassifier.analyze(chapter.content)] as const)))
    .filter((entry): entry is [string, ProfessionalDepthAnalysis] => Boolean(entry[1])));
  // 概况复述语义兑底：结构召回“本项目为”句 + bge 余弦 vs 概况章正文；空输入由恒零函数承接
  const recapCandidates = overviewRecapCandidates(input.markdown);
  const overviewSimilarity = await buildSemanticSimilarity(recapCandidates.sentences, recapCandidates.overviewBody ? [recapCandidates.overviewBody] : []);
  return [
    ...(input.promptDocumentRules?.forbidToc ? [] : [...tocHierarchyIssues(input.markdown), ...tocBodyConsistencyIssues(input.markdown)]),
    ...headingDuplicateIssues(input.markdown),
    ...evaluationCriteriaCoverageIssues(input.markdown, input.evaluationCriteriaItems || [], { semanticSimilarity: evaluationCriteriaSimilarity }),
    ...await requirementsCoverageIssues(input.markdown, input.tenderRequirements, { semanticSimilarity: requirementsSimilarityForCoverage, bodyTexts: requirementBodySentences }),
    ...fabricatedStartDateIssues(input.markdown, input.factsModel),
    ...fieldValueMismatchIssues(input.markdown, input.factsModel),
    ...areaArithmeticIssues(input.markdown),
    ...resourceConsistencyIssues(input.markdown),
    // h13：节点工期口径互查（基坑支护/封顶/装饰多套第N日口径）
    ...nodeScheduleConsistencyIssues(input.markdown),
    // h13：跨节数值口径冲突（XPS/垫层/变压器/模板周转/砌块/灭火器/潜水泵/急救箱确定性锚点）
    ...crossSectionNumericConflictIssues(input.markdown),
    // h13：桩基表述残留（地基与基础无桩基工序但全文残留桩基表述）
    ...foundationFormResidueIssues(input.markdown),
    // h13d：基本信息表「计划工期」字段违约词校验（工期行误填违约条款文字）
    ...basicInfoScheduleFieldIssues(input.markdown),
    ...await supportSystemConflictIssues(input.markdown),
    ...dangerousListConsistencyIssues(input.markdown),
    ...await sixHundredPercentCoverageIssues(input.markdown),
    ...await selfUnderminingCandidateIssues(input.markdown),
    ...paragraphOpeningRepeatIssues(input.markdown),
    // Q8 叠词重复表述（L1 封闭结构提取 + 确定性去重）
    ...repeatedWordIssues(input.markdown),
    // Q3 商务条款数据入正文（商务词封闭集，徽光阁实测暂列金额 60 万入正文）
    ...commercialDataInBodyIssues(input.markdown),
    ...overviewRecapIssues(input.markdown, { semanticSimilarity: overviewSimilarity }),
    ...closurePhraseDensityCapIssues(input.markdown),
    // C1 参数概念多口径冲突（bge 概念自组织聚类 + 同簇数值冲突）
    ...await parameterConceptConflictIssues(input.markdown),
    // C2 内部话术语义锚点泄漏（bge 句子级锚点匹配 + 精确词兜底）
    ...await internalTerminologyAnchorIssues(input.markdown),
    // C3 招标范围工程系统零覆盖（章节标题义务提取 + 正文词面覆盖，确定性判定）
    ...constructionSystemCoverageIssues(input.chapters),
    // C4 危大工程兜底适用性（前提参数阈值判定 + 辨识区别名覆盖，确定性判定）
    ...dangerousApplicabilityIssues(input.markdown),
    ...innovationTechCoverageIssues(input.markdown, input.effectiveChapters || input.template.chapters || []),
    ...instructionLikeHeadingIssues(input.markdown),
    ...formalHeadingHierarchyIssues(input.markdown),
    ...formalContentIntegrityIssues(input.markdown),
    ...markdownTableQualityIssues(input.markdown),
    ...tableSpamIssues(input.markdown),
    ...sectionContentIntegrityIssues(input.markdown, input.chapters),
    ...professionalContentIssues(input.chapters, analyses),
    ...professionalScoreIssues(input.chapters, analyses),
    ...genericProfessionalContentIssues(input.chapters, analyses),
    ...managementMeasureNumberIssues(input.chapters, analyses),
    ...await closedLoopDensityIssues(input.markdown),
    ...crossChapterConsistencyIssues(input.markdown, input.factsModel, input.scopeConflicts, analyses),
    ...processSpecConflictIssues(input.markdown, input.factsModel),
    ...evidenceUsageCoverageIssues(input.markdown, input.factsModel),
    ...await paragraphGenericIssues(input.markdown, input.professionalDepthClassifier),
    ...constructionOrgGenericLanguageIssues(input.chapters),
    ...constructionOrgControlLoopIssues(input.chapters),
    ...constructionOrgProfessionalChainIssues({ markdown: input.markdown, factsModel: input.factsModel, chapters: input.chapters }),
    ...constructionOrgConsistencyIssues(input.markdown, input.factsModel),
    ...constructionOrgChapterDataCoverageIssues(input.chapters, input.factsModel),
    ...constructionOrgMajorContentIssues(input.chapters, input.markdown),
    ...constructionOrgDivisionSectionIssues(input.chapters, input.markdown),
    ...constructionOrgBonusModuleIssues(input.chapters),
    ...chapterDependencyIssues(input.chapters, analyses),
    ...documentDeliveryScoreIssues(input.markdown, input.chapters, input.factsModel, analyses),
    ...factVerification,
    ...duplicateBasicInfoIssues(input.markdown),
    ...await formalStyleIssues(input.markdown),
    ...tertiaryHeadingIssues(input.markdown),
    ...minChapterSectionIssues(input.chapters),
    // Q11 事实落位（关键参数抽查）：字面匹配 + 本地 bge 语义兜底
    ...await preciseFactUsageIssues(input.markdown, input.factsModel, input.chapters),
    // Q1 清单落位：字面匹配 + 本地 bge 语义兜底，落位率 <60% 升 error 进修复循环
    ...await boqPlacementIssues(input.markdown, input.chapters, input.factsModel),
    // Q5 施工阶段划分口径（L1 提取阶段划分句 + bge 语义聚类互异簇 → error）
    ...await stagePhrasingIssues(input.markdown),
    // C5 应急预案小节深度门槛（≥300 字 + 组织/流程/物资三要素，标题召回 + bge 语义判定）
    ...await emergencySectionDepthIssues(input.markdown),
    ...boqRowTraceIssues(buildBoqRowTraces(input.markdown, input.factsModel)),
    ...drawingReferenceIssues(input.markdown, input.factsModel),
    ...webEvidenceLeakageIssues(input.markdown),
    ...formalPlaceholderIssues(input.markdown),
    ...promptExampleLeakIssues(input.markdown, input.promptBindings),
    ...degenerateContentIssues(input.markdown, input.chapters),
    ...plannedAutoSpecGateIssues(input.markdown, input.template),
    ...plannedStructureIssues(input.markdown, input.template),
    ...promptDocumentRuleIssues(input.markdown, input.promptDocumentRules),
    // round-18 E11：安徽省属地适配与政策合规（创优目标/四节一环保量化/工伤保险），
    // 排在末尾使修复循环 slice 截断时让位高优先级 blocker；round-20 S1 已加语义判定（async）
    ...await localAdaptationKeywordIssues(input.markdown, input.factsModel),
  ];
}
