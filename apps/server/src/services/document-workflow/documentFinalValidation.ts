import { closedLoopDensityIssues, plannedAutoSpecGateIssues, boqPlacementIssues, crossChapterConsistencyIssues, degenerateContentIssues, drawingReferenceIssues, duplicateBasicInfoIssues, evaluationCriteriaCoverageIssues, formalContentIntegrityIssues, formalHeadingHierarchyIssues, formalPlaceholderIssues, formalStyleIssues, generatedFactVerificationIssuesAsync, genericProfessionalContentIssues, headingDuplicateIssues, innovationTechCoverageIssues, instructionLikeHeadingIssues, managementMeasureNumberIssues, markdownTableQualityIssues, minChapterSectionIssues, preciseFactUsageIssues, processSpecConflictIssues, professionalContentIssues, professionalScoreIssues, promptExampleLeakIssues, sectionContentIntegrityIssues, tableSpamIssues, tocBodyConsistencyIssues, tocHierarchyIssues } from './qualityValidation';
import type { FactTokenScopeClassifier } from './factTokenClassifier';
import type { ProfessionalDepthAnalysis, ProfessionalDepthClassifier } from './professionalDepthClassifier';
import { boqRowTraceIssues, buildBoqRowTraces } from './documentFactTrace';
import { chapterDependencyIssues, documentDeliveryScoreIssues, evidenceUsageCoverageIssues, paragraphGenericIssues } from './documentDeliveryReport';
import { plannedStructureIssues, promptDocumentRuleIssues, tertiaryHeadingIssues } from './markdownComposer';
import { webEvidenceLeakageIssues } from './webResearchService';
import { constructionOrgChapterDataCoverageIssues, constructionOrgConsistencyIssues } from './constructionOrgConsistency';
import { constructionOrgBonusModuleIssues, constructionOrgControlLoopIssues, constructionOrgDivisionSectionIssues, constructionOrgGenericLanguageIssues, constructionOrgMajorContentIssues, constructionOrgProfessionalChainIssues } from './constructionOrgQualityRules';
import { areaArithmeticIssues, closurePhraseDensityCapIssues, dangerousListConsistencyIssues, fabricatedStartDateIssues, fieldValueMismatchIssues, overviewRecapCandidates, overviewRecapIssues, paragraphOpeningRepeatIssues, resourceConsistencyIssues, selfUnderminingCandidateIssues, sixHundredPercentCoverageIssues, supportSystemConflictIssues } from './documentIntegrityChecks';
import { buildSemanticSimilarity } from './semanticSimilarity';
import { requirementsCoverageIssues } from './tenderRequirements';
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
  /** 总量口径语义分类器（round-13）：事实反查的口径归属语义复核，不可用时降级近邻窗口正则门控 */
  factTokenScopeClassifier?: FactTokenScopeClassifier;
  /** 专业深度语义分类器（round-14）：章节专业深度/缺项/套话/闭环/依赖的语义判定，不可用时静默跳过（零误伤） */
  professionalDepthClassifier?: ProfessionalDepthClassifier;
}): Promise<ValidationIssue[]> {
  const factVerification = await generatedFactVerificationIssuesAsync(input.markdown, input.factsModel, { scopeClassifier: input.factTokenScopeClassifier });
  // 预计算全部章节的专业深度语义分析（同一章节文本被多个校验器复用，只嵌入一次）；
  // 嵌入失败/空文本返回 undefined 的章节不入 Map，消费方按缺失跳过（零误伤，不得用全 false 替身）
  const analyses = input.professionalDepthClassifier
    ? new Map((await Promise.all(input.chapters.map(async chapter => [chapter.title, await input.professionalDepthClassifier!.analyze(chapter.content)] as const)))
      .filter((entry): entry is [string, ProfessionalDepthAnalysis] => Boolean(entry[1])))
    : undefined;
  // 概况复述语义兑底：结构召回“本项目为”句 + bge 余弦 vs 概况章正文；
  // 嵌入不可用时 overviewRecapIssues 静默跳过（零误伤：判定不了就不判）
  const recapCandidates = overviewRecapCandidates(input.markdown);
  const overviewSimilarity = recapCandidates.sentences.length > 0 && recapCandidates.overviewBody
    ? await buildSemanticSimilarity(recapCandidates.sentences, [recapCandidates.overviewBody])
    : undefined;
  return [
    ...(input.promptDocumentRules?.forbidToc ? [] : [...tocHierarchyIssues(input.markdown), ...tocBodyConsistencyIssues(input.markdown)]),
    ...headingDuplicateIssues(input.markdown),
    ...evaluationCriteriaCoverageIssues(input.markdown, input.evaluationCriteriaItems || [], { semanticSimilarity: input.requirementsSimilarity }),
    ...requirementsCoverageIssues(input.markdown, input.tenderRequirements, { semanticSimilarity: input.requirementsSimilarity }),
    ...fabricatedStartDateIssues(input.markdown, input.factsModel),
    ...fieldValueMismatchIssues(input.markdown, input.factsModel),
    ...areaArithmeticIssues(input.markdown),
    ...resourceConsistencyIssues(input.markdown),
    ...supportSystemConflictIssues(input.markdown),
    ...dangerousListConsistencyIssues(input.markdown),
    ...sixHundredPercentCoverageIssues(input.markdown),
    ...selfUnderminingCandidateIssues(input.markdown),
    ...paragraphOpeningRepeatIssues(input.markdown),
    ...overviewRecapIssues(input.markdown, { semanticSimilarity: overviewSimilarity }),
    ...closurePhraseDensityCapIssues(input.markdown),
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
    ...closedLoopDensityIssues(input.markdown),
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
    ...formalStyleIssues(input.markdown),
    ...tertiaryHeadingIssues(input.markdown),
    ...minChapterSectionIssues(input.chapters),
    ...preciseFactUsageIssues(input.markdown, input.factsModel, input.chapters),
    ...boqPlacementIssues(input.markdown, input.chapters, input.factsModel),
    ...boqRowTraceIssues(buildBoqRowTraces(input.markdown, input.factsModel)),
    ...drawingReferenceIssues(input.markdown, input.factsModel),
    ...webEvidenceLeakageIssues(input.markdown),
    ...formalPlaceholderIssues(input.markdown),
    ...promptExampleLeakIssues(input.markdown, input.promptBindings),
    ...degenerateContentIssues(input.markdown, input.chapters),
    ...plannedAutoSpecGateIssues(input.markdown, input.template),
    ...plannedStructureIssues(input.markdown, input.template),
    ...promptDocumentRuleIssues(input.markdown, input.promptDocumentRules),
  ];
}
