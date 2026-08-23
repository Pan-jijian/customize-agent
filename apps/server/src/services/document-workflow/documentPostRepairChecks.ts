import { plannedStructureIssues } from './markdownComposer';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplate, ValidationIssue } from './types';
import { chapterDependencyIssues, documentDeliveryScoreIssues, evidenceUsageCoverageIssues, paragraphGenericIssues } from './documentDeliveryReport';
import { crossChapterConsistencyIssues, formalContentIntegrityIssues, formalPlaceholderIssues, generatedFactVerificationIssues, genericProfessionalContentIssues, managementMeasureNumberIssues, professionalContentIssues, professionalScoreIssues } from './qualityValidation';

export function buildPostRepairIssues(input: { markdown: string; chapters: DocumentDraftChapter[]; template: DocumentTemplate; factsModel: DocumentFactsModel }): ValidationIssue[] {
  return [
    ...plannedStructureIssues(input.markdown, input.template),
    ...formalPlaceholderIssues(input.markdown),
    ...formalContentIntegrityIssues(input.markdown),
    ...professionalContentIssues(input.chapters),
    ...professionalScoreIssues(input.chapters),
    ...genericProfessionalContentIssues(input.chapters),
    ...managementMeasureNumberIssues(input.chapters),
    ...crossChapterConsistencyIssues(input.markdown, input.factsModel),
    ...evidenceUsageCoverageIssues(input.markdown, input.factsModel),
    ...paragraphGenericIssues(input.markdown),
    ...chapterDependencyIssues(input.chapters),
    ...generatedFactVerificationIssues(input.markdown, input.factsModel),
  ];
}

export function buildProfessionalRepairIssues(input: { markdown: string; chapters: DocumentDraftChapter[]; factsModel: DocumentFactsModel }): ValidationIssue[] {
  return [
    ...professionalContentIssues(input.chapters),
    ...professionalScoreIssues(input.chapters),
    ...genericProfessionalContentIssues(input.chapters),
    ...managementMeasureNumberIssues(input.chapters),
    ...crossChapterConsistencyIssues(input.markdown, input.factsModel),
    ...evidenceUsageCoverageIssues(input.markdown, input.factsModel),
    ...paragraphGenericIssues(input.markdown),
    ...chapterDependencyIssues(input.chapters),
    ...generatedFactVerificationIssues(input.markdown, input.factsModel),
  ];
}

export function buildDeliveryReportIssues(input: { markdown: string; chapters: DocumentDraftChapter[]; factsModel: DocumentFactsModel }): ValidationIssue[] {
  return documentDeliveryScoreIssues(input.markdown, input.chapters, input.factsModel);
}
