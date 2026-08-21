import { plannedAutoSpecGateIssues, boqPlacementIssues, crossChapterConsistencyIssues, degenerateContentIssues, drawingReferenceIssues, duplicateBasicInfoIssues, formalContentIntegrityIssues, formalHeadingHierarchyIssues, formalPlaceholderIssues, formalStyleIssues, generatedFactVerificationIssues, genericProfessionalContentIssues, instructionLikeHeadingIssues, managementMeasureNumberIssues, markdownTableQualityIssues, minChapterSectionIssues, preciseFactUsageIssues, professionalContentIssues, professionalScoreIssues, promptExampleLeakIssues, sectionContentIntegrityIssues, tocBodyConsistencyIssues, tocHierarchyIssues } from './qualityValidation';
import { boqRowTraceIssues, buildBoqRowTraces } from './documentFactTrace';
import { chapterDependencyIssues, documentDeliveryScoreIssues, evidenceUsageCoverageIssues, paragraphGenericIssues } from './documentDeliveryReport';
import { plannedStructureIssues, promptDocumentRuleIssues, tertiaryHeadingIssues } from './markdownComposer';
import { webEvidenceLeakageIssues } from './webResearchService';
import { constructionOrgChapterDataCoverageIssues, constructionOrgConsistencyIssues } from './constructionOrgConsistency';
import { constructionOrgBonusModuleIssues, constructionOrgControlLoopIssues, constructionOrgGenericLanguageIssues, constructionOrgMajorContentIssues, constructionOrgProfessionalChainIssues } from './constructionOrgQualityRules';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplate, PromptBinding, PromptDocumentRuleSet, ValidationIssue } from './types';

export function buildStandardFinalValidationIssues(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
  factsModel: DocumentFactsModel;
  template: DocumentTemplate;
  promptBindings: PromptBinding[];
  promptDocumentRules?: PromptDocumentRuleSet;
}): ValidationIssue[] {
  return [
    ...(input.promptDocumentRules?.forbidToc ? [] : [...tocHierarchyIssues(input.markdown), ...tocBodyConsistencyIssues(input.markdown)]),
    ...instructionLikeHeadingIssues(input.markdown),
    ...formalHeadingHierarchyIssues(input.markdown),
    ...formalContentIntegrityIssues(input.markdown),
    ...markdownTableQualityIssues(input.markdown),
    ...sectionContentIntegrityIssues(input.markdown, input.chapters),
    ...professionalContentIssues(input.chapters),
    ...professionalScoreIssues(input.chapters),
    ...genericProfessionalContentIssues(input.chapters),
    ...managementMeasureNumberIssues(input.chapters),
    ...crossChapterConsistencyIssues(input.markdown, input.factsModel),
    ...evidenceUsageCoverageIssues(input.markdown, input.factsModel),
    ...paragraphGenericIssues(input.markdown),
    ...constructionOrgGenericLanguageIssues(input.chapters),
    ...constructionOrgControlLoopIssues(input.chapters),
    ...constructionOrgProfessionalChainIssues({ markdown: input.markdown, factsModel: input.factsModel, chapters: input.chapters }),
    ...constructionOrgConsistencyIssues(input.markdown, input.factsModel),
    ...constructionOrgChapterDataCoverageIssues(input.chapters, input.factsModel),
    ...constructionOrgMajorContentIssues(input.chapters, input.markdown),
    ...constructionOrgBonusModuleIssues(input.chapters),
    ...chapterDependencyIssues(input.chapters),
    ...documentDeliveryScoreIssues(input.markdown, input.chapters, input.factsModel),
    ...generatedFactVerificationIssues(input.markdown, input.factsModel),
    ...duplicateBasicInfoIssues(input.markdown),
    ...formalStyleIssues(input.markdown),
    ...tertiaryHeadingIssues(input.markdown),
    ...minChapterSectionIssues(input.chapters),
    ...preciseFactUsageIssues(input.markdown, input.factsModel),
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
