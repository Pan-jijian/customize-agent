export type FactFieldType = 'auto';
export type ChapterRuleMode = 'fixed' | 'dynamic';

export interface DynamicChapterRule {
  source: 'file_outline' | 'file_role' | 'fact_group' | 'table_rows' | 'ai_plan';
  sourceRoleIds?: string[];
  minChapters?: number;
  maxChapters?: number;
  titleStrategy?: 'source_title' | 'field_value' | 'ai_summary' | 'template';
  titleTemplate?: string;
  minWordsPerChapter?: number;
  requiredFactIds?: string[];
  requiredFileRoleIds?: string[];
  requiredPromptRoleIds?: string[];
  generationHint?: string;
}

export type GateRuleType = string;
export type GateRuleLevel = 'error' | 'warning' | 'info';
export type GateRuleSubject = 'document' | 'chapter' | 'fact' | 'file_role' | 'prompt_role' | 'table' | 'image' | 'source';
export type GateRuleOperator = 'exists' | 'contains' | 'not_contains' | 'regex_match' | 'regex_not_match' | 'min_count' | 'min_length' | 'all_have_source' | 'image_caption_required' | 'table_explanation_required';

export interface GateRuleEvaluator {
  subject: GateRuleSubject;
  operator: GateRuleOperator;
  target?: string;
  value?: string;
  min?: number;
}

export interface AutoDocumentSpecFactField {
  id: string;
  name: string;
  type: FactFieldType;
  required: boolean;
  sourceRoleIds?: string[];
  extractionHint?: string;
  validationHint?: string;
}

export interface AutoDocumentSpecChapterRule {
  id: string;
  title: string;
  required: boolean;
  order: number;
  minWords?: number;
  requiredFactIds?: string[];
  requiredFileRoleIds?: string[];
  requiredPromptRoleIds?: string[];
  generationHint?: string;
}

export interface AutoDocumentSpecGateRule {
  id: string;
  name: string;
  type: GateRuleType;
  level: GateRuleLevel;
  target?: string;
  value?: string;
  evaluator?: GateRuleEvaluator;
}

export interface AutoDocumentSpecPackage {
  id: string;
  name: string;
  description: string;
  factFields: AutoDocumentSpecFactField[];
  chapterMode: ChapterRuleMode;
  chapterRules: AutoDocumentSpecChapterRule[];
  dynamicChapterRule: DynamicChapterRule;
  gateRules: AutoDocumentSpecGateRule[];
  builtIn?: boolean;
}
