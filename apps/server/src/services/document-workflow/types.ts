export interface PromptRequiredSectionRule {
  title: string;
  aliases?: string[];
  order?: number;
  required?: boolean;
  source?: string;
}

export interface PromptChapterStructuralRule {
  chapterIndex?: number;
  chapterTitle?: string;
  requiredSections: PromptRequiredSectionRule[];
  source?: string;
}

export interface PromptDocumentRuleSet {
  coverPolicy?: 'required' | 'forbidden' | 'unspecified';
  tocPolicy?: 'required' | 'forbidden' | 'unspecified';
  forbidCover?: boolean;
  forbidToc?: boolean;
  forbiddenTerms: string[];
  preferredTerms: Array<{ from: string; to: string }>;
  requiredTables: string[];
  requiredKeywords?: string[];
  forbiddenPatterns?: string[];
}

export interface WebAccessConfig {
  enabled: boolean;
  allowProjectFacts: false;
  maxQueriesPerChapter: number;
  maxResultsPerQuery: number;
  trustedDomains: string[];
}

export interface RuntimePromptRuleSet extends PromptDocumentRuleSet {
  sourceHash: string;
  exactHeadings: string[];
  forbidExtraHeadings: boolean;
  requiredSubjects: string[];
  forbiddenSubjects: string[];
  backendTerms: string[];
  commercialTerms: string[];
  forbidFabrication: boolean;
  requireEvidenceForQuantities: boolean;
  preferProjectFacts: boolean;
  minWords?: number;
  minChars?: number;
  chapterRules: Array<{ chapterTitle: string; mustInclude: string[]; mustNotInclude: string[] }>;
  roleRules: Array<{ roleId: string; focusAreas: string[]; mustDo: string[]; mustNotDo: string[] }>;
  executionSummary: string[];
}

export interface DocumentTemplateChapter {
  id: string;
  title: string;
  purpose: string;
  queries: string[];
  requiredFacts: string[];
  sections?: string[];
  tableSections?: string[];
  tableRequirements?: string[];
  pinnedEvidenceFilePaths?: string[];
}

export interface DocumentExportSettings {
  page?: {
    paper?: string;
    marginTop?: string;
    marginRight?: string;
    marginBottom?: string;
    marginLeft?: string;
  };
  typography?: {
    fontFamily?: string;
    lineHeight?: string;
    titleSize?: string;
    bodySize?: string;
  };
  targetPages?: {
    min?: number;
    target?: number;
    max?: number;
  };
}

export interface DocumentGenerationSettings {
  targetPages?: {
    min?: number;
    target?: number;
    max?: number;
  };
}

export interface PromptBinding {
  promptId: string;
  roleId: string;
}

export interface ProjectBinding {
  materialRootPath: string;
}

export interface DocumentTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  outputTitle: string;
  chapters: DocumentTemplateChapter[];
  exportSettings?: DocumentExportSettings;
  generationSettings?: DocumentGenerationSettings;
  projectRoleConfigId?: string;
  projectBindings?: ProjectBinding[];
  promptIds?: string[];
  promptBindings?: PromptBinding[];
  builtIn?: boolean;
}

export interface DocumentEvidence {
  chapterId: string;
  filePath: string;
  score: number;
  content: string;
  roleId?: string;
  processingType?: string;
  sectionTitle?: string;
  source?: string;
}

export interface ResourceEvidence {
  filePath: string;
  kind: 'map' | 'image' | 'table' | 'document' | 'spreadsheet' | 'text' | 'attachment';
  roleId?: string;
  processingType?: string;
  score: number;
  semanticTitle: string;
  contentUse: string;
  relatedFacts: string[];
  relatedChapters: string[];
  snippets: string[];
}

export interface EvidenceBundle {
  chapterId: string;
  textEvidence: DocumentEvidence[];
  resources: ResourceEvidence[];
  byKind: Record<ResourceEvidence['kind'], ResourceEvidence[]>;
  summary: string;
}

export interface DocumentDraftChapter {
  id: string;
  title: string;
  content: string;
  evidence: DocumentEvidence[];
  missingFacts: string[];
  sections?: string[];
}

export interface FactSourceRef {
  filePath: string;
  roleId: string;
  processingType?: string;
  sectionTitle?: string;
  chunkIndex?: number;
  cellRange?: string;
}

export interface DocumentFact {
  key: string;
  value: string;
  sourceFile: string;
  roleId: string;
  processingType?: string;
  confidence: number;
  fieldId?: string;
  fieldName?: string;
  sourceRef?: FactSourceRef;
}

export interface StructuredTableFact {
  tableType: string;
  sheet?: string;
  headers: string[];
  rows: string[][];
  sourceFile: string;
  sourceRange?: string;
}

export interface EvidenceFactIndex {
  reliableFacts: DocumentFact[];
  parameterFacts: DocumentFact[];
  tableFacts: DocumentFact[];
  drawingFacts: DocumentFact[];
  billFacts: DocumentFact[];
  diagnostics: DocumentFact[];
}

export interface ChapterFactNeed {
  id: string;
  label: string;
  category: string;
  required: boolean;
  queries: string[];
  acceptablePatterns?: string[];
  forbiddenPatterns?: string[];
  source: 'template' | 'spec' | 'profile' | 'prompt' | 'chapter' | 'section' | 'plan' | 'requirement';
  fieldId?: string;
}

export interface ResolvedFactNeed {
  need: ChapterFactNeed;
  facts: DocumentFact[];
  status: 'satisfied' | 'missing' | 'low_confidence' | 'conflict';
  evidence?: DocumentEvidence[];
}

export interface DocumentFactsModel {
  project: DocumentFact[];
  schedule: DocumentFact[];
  quality: DocumentFact[];
  safety: DocumentFact[];
  resources: DocumentFact[];
  tables: StructuredTableFact[];
  drawings: DocumentFact[];
  bills: DocumentFact[];
  preciseFacts: DocumentFact[];
  rules: DocumentFact[];
  specifications: DocumentFact[];
  schemaFacts: Record<string, DocumentFact[]>;
  factIndex: EvidenceFactIndex;
  missing: string[];
  conflicts: string[];
}

export interface ValidationIssue {
  level: 'error' | 'warning' | 'info';
  message: string;
  source?: string;
  suggestion?: string;
}

export interface ExportGateResult {
  passed: boolean;
  blockingIssues: ValidationIssue[];
  checklist: Array<{ key: string; label: string; passed: boolean; message?: string }>;
}

export interface DocumentExecutionStage {
  type: 'role_binding' | 'knowledge_retrieval' | 'file_understanding' | 'fact_extraction' | 'chapter_generation' | 'asset_generation' | 'llm_review' | 'validation' | 'formatting' | 'export_ready' | 'reference';
  roleId: string;
  promptId?: string;
  status: 'running' | 'success' | 'fallback' | 'skipped' | 'failed';
  message?: string;
  details?: string[];
  progress?: { current: number; total: number; label?: string };
  title?: string;
  subtitle?: string;
  roleName?: string;
  promptName?: string;
  group?: string;
  order?: number;
  executionVersion?: 2;
}

export interface DocumentAsset {
  id: string;
  type: 'image' | 'audio' | 'video' | 'file';
  role: 'cover' | 'reference' | 'generated' | 'attachment';
  path?: string;
  url?: string;
  prompt?: string;
  modelProvider?: string;
  status: 'generated' | 'prompt_ready' | 'fallback';
  message?: string;
}


export interface ChapterReviewSummary {
  chapterId: string;
  title: string;
  status: 'pass' | 'warn' | 'fail';
  issues: string[];
  suggestions: string[];
  chars: number;
}

export interface DocumentGenerationStrategy {
  mode: 'fast' | 'balanced' | 'longform' | 'strict';
  enableChapterReview: boolean;
  enableGlobalReview: boolean;
  enableDocumentBudgetExpansion: boolean;
  enableFinalQualityReview: boolean;
}

export interface DocumentPerformanceMetric {
  name: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  meta?: Record<string, string | number | boolean>;
}

export interface DocumentGenerationDiagnostics {
  strategy: DocumentGenerationStrategy;
  metrics: DocumentPerformanceMetric[];
  llm: { calls: number; failures: number; maxActive: number; lastError?: string };
  evidence: { raw: number; used: number; filteredNoise: number; avgNoiseScore: number; avgFactDensity: number; searchQueries: number; searchMs: number; contextChars: number };
  quality: { blockingCount: number; importantCount: number; minorCount: number; repairedCount: number };
}

export interface DocumentProfileReport {
  type: string;
  dimensions: string[];
  requiredEvidencePolicy: string;
}

export interface DocumentKnowledgeCoverageReport {
  score: number;
  evidenceCount: number;
  confirmedFiles: number;
  chapterReports: Array<{ chapterId: string; title: string; requiredDomains: string[]; confirmedDomains: string[]; unconfirmedDomains: string[]; score: number }>;
  unconfirmedDomains: string[];
  remediation: string;
}

export interface DocumentFactTrace {
  label: string;
  value: string;
  sourceFile?: string;
  status: 'used' | 'unplaced';
  confidence: number;
}

export interface ChapterCoverageReport {
  chapterId: string;
  title: string;
  score: number;
  checks: Array<{ key: string; label: string; passed: boolean }>;
  action: string;
}

export interface RetrievalCoverageReport {
  chapterId: string;
  chapterTitle: string;
  risk: { totalChunks: number; loadedChunks: number; omittedChunks: number; loadedRatio: number; highRisk: boolean };
  evidenceCount: number;
  evidenceFiles: number;
  sectionCovered: number;
  sectionTotal: number;
  requiredFactCovered: number;
  requiredFactTotal: number;
}

export interface DocumentQualityReport {
  overall: number;
  deliveryProbability: number;
  target: number;
  passed: boolean;
  scores: {
    factuality: number;
    structure: number;
    professionalDepth: number;
    executable: number;
    evidenceCoverage: number;
    consistency: number;
  };
  summary: string;
  actions: string[];
}

export interface RepairStrategy {
  priority: 'high' | 'medium' | 'low';
  title: string;
  action: string;
}

export interface DocumentReviewChecklistItem {
  key: string;
  label: string;
  passed: boolean;
  message?: string;
}

export interface DocumentWorkflowVersion {
  version: string;
  rules: string[];
}

export interface DocumentTelemetryReport {
  llmCalls: number;
  llmFailures: number;
  maxParallelLlm: number;
  searchQueries: number;
  evidenceContextChars: number;
  qualityIssues: DocumentGenerationDiagnostics['quality'];
  slowMetrics: Array<{ name: string; durationMs: number }>;
  elapsedMs?: number;
}

export interface DocumentReviewMetadata {
  chapterSummaries: ChapterReviewSummary[];
  globalIssues: string[];
  diagnostics: DocumentGenerationDiagnostics;
  profile?: DocumentProfileReport;
  knowledgeCoverage?: DocumentKnowledgeCoverageReport;
  factTraces?: DocumentFactTrace[];
  chapterCoverage?: ChapterCoverageReport[];
  retrievalCoverage?: RetrievalCoverageReport[];
  qualityReport?: DocumentQualityReport;
  repairStrategies?: RepairStrategy[];
  reviewChecklist?: DocumentReviewChecklistItem[];
  workflowVersion?: DocumentWorkflowVersion;
  telemetry?: DocumentTelemetryReport;
}

export interface GeneratedDocumentDraft {
  templateId: string;
  templateName: string;
  title: string;
  requirement: string;
  projectRoot?: string;
  projectId?: string;
  markdown: string;
  exportSettings?: DocumentExportSettings;
  generationSettings?: DocumentGenerationSettings;
  facts: Record<string, string>;
  structuredFacts: DocumentFact[];
  factsModel: DocumentFactsModel;
  chapters: DocumentDraftChapter[];
  sources: Array<{ filePath: string; count: number }>;
  missingItems: string[];
  validation: { passed: boolean; warnings: string[]; errors: string[] };
  validationIssues: ValidationIssue[];
  executionStages: DocumentExecutionStage[];
  exportGate: ExportGateResult;
  assets?: DocumentAsset[];
  partialChapters?: Array<{ id: string; title: string; chars: number; status: 'completed' | 'failed'; updatedAt: number }>;
  checkpointChapters?: DocumentDraftChapter[];
  reviewMetadata?: DocumentReviewMetadata;
  generatedAt: number;
}
