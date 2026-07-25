import type { AutoDocumentSpecGateRule, GateRuleEvaluator } from '../document-core/autoDocumentSpecTypes';
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel, FileBinding, PromptBinding } from '../document-workflow/types';

/** 文档质量问题严重程度，用于导出门禁和修复优先级排序。 */
export type QualitySeverity = 'blocking' | 'important' | 'minor';

/** 文档质量问题严重程度统计结果。 */
export type QualitySeveritySummary = Record<QualitySeverity, number>;

/** Markdown 图片引用解析结果。 */
export interface MarkdownImageRef {
  alt: string;
  url: string;
  index: number;
}

/** AutoSpec 单条门禁规则执行时需要的上下文。 */
export interface SpecGateRuleContext {
  rule: AutoDocumentSpecGateRule;
  evaluator: GateRuleEvaluator;
  target: string;
  value: string;
  min: number;
  markdown: string;
  textScope: string;
  regex?: RegExp;
  chapter?: DocumentDraftChapter;
  factNames: Set<string>;
  chapterTitles: Set<string>;
  tableBlocks: string[];
  imageRefs: MarkdownImageRef[];
  estimatedPages: number;
  allFacts: DocumentFact[];
  factsModel: DocumentFactsModel;
  fileBindings: FileBinding[];
  promptBindings: PromptBinding[];
}

/** AutoSpec 门禁规则处理器，返回问题详情表示命中失败。 */
export type SpecGateRuleHandler = (context: SpecGateRuleContext) => string | undefined;
