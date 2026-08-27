import type { AgentWorkflowContext } from './agentWorkflow';
import type { QualityBenchmarkResult } from './benchmarkQuality';

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
  allowProjectFacts: boolean;
  maxQueriesPerChapter: number;
  maxResultsPerQuery: number;
  trustedDomains: string[];
}

/** 单条运行时规则的抽取溯源信息 */
export interface RuleExtractionTrace {
  rule: string;
  source: { promptId: string; roleId: string; pattern: string };
  matchedText: string;
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
  /** 按规则类别分组的来源归属 */
  ruleSources?: Record<string, Array<{ promptId: string; roleId: string; pattern: string; matchedText: string }>>;
  /** 扁平化的规则抽取追溯列表 */
  extractionTrace?: RuleExtractionTrace[];
}

export interface ProjectGraphTableFieldPlan {
  name: string;
  required: boolean;
  sourceDomain: 'project' | 'works' | 'methods' | 'resources' | 'schedule' | 'standards' | 'risks' | 'requirements' | 'siteConditions' | 'factsModel' | 'standard';
  sourceHint: string;
  /** projectFactOnly:资料没有不得填写；standardAllowed:按行业标准做法填写；deriveFromContext:结合图谱与上下文推导；deriveFromProject:基于项目事实（工程量/工期/工序）推导的投标人编制类字段 */
  fallbackPolicy: 'projectFactOnly' | 'standardAllowed' | 'deriveFromContext' | 'deriveFromProject';
}

export type GovernedTableNecessity = 'must' | 'should' | 'conditional' | 'reference';
export type GovernedTableOutputType = 'markdown_table' | 'checklist' | 'paragraph' | 'merged_into_existing_table' | 'skip';
export type GovernedTableFallbackPolicy = 'generate_with_confirmed_facts' | 'generate_with_review_notes' | 'convert_to_text' | 'skip_with_reason';

export interface GovernedTableFieldPlan extends ProjectGraphTableFieldPlan {
  confirmed: boolean;
  missingReason?: string;
}

export interface ProjectGraphTablePlan {
  id: string;
  title: string;
  chapterTitle: string;
  moduleTitle: string;
  required: boolean;
  reason: string;
  fields: ProjectGraphTableFieldPlan[];
  sourceDomains: ProjectGraphTableFieldPlan['sourceDomain'][];
  necessity?: GovernedTableNecessity;
  belongsToChapter?: boolean;
  scopeExplanation?: string;
  triggerFacts?: string[];
  triggerGraphNodes?: string[];
  fillability?: {
    requiredFieldCount: number;
    confirmedFieldCount: number;
    missingProjectFactFields: string[];
    canGenerate: boolean;
    fallbackPolicy: GovernedTableFallbackPolicy;
  };
  outputDecision?: {
    shouldOutput: boolean;
    outputType: GovernedTableOutputType;
    decisionReason: string;
  };
  narrativeRequirements?: {
    beforeTable: string[];
    afterTable: string[];
    controlLoop?: string[];
  };
  rowSeeds?: Array<{
    rowLabel: string;
    source: 'canonicalFact' | 'projectGraph' | 'boq' | 'standard';
    confirmedFields: string[];
    missingFields: string[];
    sourceRef?: string;
  }>;
}

export interface ChapterReadinessPlan {
  chapterId: string;
  chapterTitle: string;
  canGenerate: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  missingFacts: string[];
  missingEvidence: string[];
  tableFieldGaps: string[];
  suggestedStrategy: 'normal' | 'section_first' | 'evidence_first' | 'generate_with_review_notes';
  reason: string;
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
  tablePlans?: ProjectGraphTablePlan[];
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
  /** 模版版本号，每次内容变更时自动递增，从 1 开始 */
  version?: number;
  /** 模版最后更新时间戳 */
  updatedAt?: number;
  /** 模版变更日志，记录每次版本变更的摘要 */
  changeLog?: Array<{ version: number; timestamp: number; summary: string }>;
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
  tablePlans?: ProjectGraphTablePlan[];
  /** 章节生成是否超时 */
  timedOut?: boolean;
  /** 章节生成实际耗时（毫秒） */
  elapsedMs?: number;
  /** 章节生成中（仅有部分小节正文的 checkpoint 快照，不可作为 resume 复用） */
  inProgress?: boolean;
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

export interface CanonicalFact {
  key: string;
  label: string;
  value: string;
  normalizedValue: string;
  sourceType: 'user' | 'addendum' | 'tender' | 'contract' | 'boq' | 'drawing' | 'standard' | 'projectGraph' | 'derived' | 'structured_fact' | 'generated_markdown' | 'evidence' | 'unknown';
  sourceFile?: string;
  sourceRef?: string;
  confidence: number;
  priority: number;
  locked: boolean;
  selectedReason?: string;
}

export interface CanonicalFactConflict {
  key: string;
  label: string;
  values: Array<{ value: string; sourceFile?: string; priority: number; confidence: number }>;
  decision: 'highest_priority_selected' | 'manual_review_required';
}

export interface CanonicalFactGap {
  key: string;
  label: string;
  reason: string;
}

/** 源级同口径数值冲突：不同资料文件对同一总量口径（建设规模/估算价/工期/层数/车位数）给出不同数值 */
export interface NumericScopeConflict {
  kind: 'area' | 'cost' | 'duration' | 'floors' | 'parkingSpaces';
  scope: string;
  values: Array<{ value: string; unit: string; sourceFile?: string; priority: number }>;
  /** 裁决后的统一口径（按资料来源优先级与数值语境裁决）；为空表示同优先级下无法自动裁决，需人工复核 */
  resolution?: string;
  /**
   * 裁决置信度（数值语境分类驱动，决定下游改写的强度）：
   * high=修正型语境（补疑/答疑类文件的正式修正语）明确胜出，可确定性改写证据与正文并注入强制锚点；
   * medium=本体口径一致胜出（含补疑复述型），确定性改写保留但锚点措辞降级；
   * low=锚定弱或语境模糊，不参与确定性改写，仅作为人工复核提示报告。
   */
  confidence?: 'high' | 'medium' | 'low';
}

export interface CanonicalFactModel {
  projectIdentity: Record<string, CanonicalFact | undefined>;
  projectScope: Record<string, CanonicalFact | CanonicalFact[] | undefined>;
  schedule: Record<string, CanonicalFact | CanonicalFact[] | undefined>;
  quality: Record<string, CanonicalFact | CanonicalFact[] | undefined>;
  safety: Record<string, CanonicalFact | CanonicalFact[] | undefined>;
  resources: Record<string, CanonicalFact[]>;
  environment: Record<string, CanonicalFact | undefined>;
  constraints: Record<string, CanonicalFact[]>;
  byKey: Record<string, CanonicalFact>;
  conflicts: CanonicalFactConflict[];
  gaps: CanonicalFactGap[];
  /** 跨资料文件的同口径数值冲突及裁决结果（生成注入用） */
  scopeConflicts: NumericScopeConflict[];
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
  canonical?: CanonicalFactModel;
}

export interface ValidationIssue {
  level: 'error' | 'warning' | 'info';
  message: string;
  source?: string;
  suggestion?: string;
  severity?: 'blocker' | 'warning' | 'suggestion';
  repairability?: 'local_deterministic' | 'llm_repairable' | 'manual_review' | 'not_repair_needed';
  category?: 'structure' | 'table' | 'fact_consistency' | 'evidence_coverage' | 'professional_chain' | 'control_loop' | 'format' | 'style' | 'scope';
  owner?: 'system' | 'llm' | 'user';
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
  status: 'running' | 'success' | 'skipped' | 'failed';
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
  /** 章节生成是否超时 */
  chapterTimedOut?: boolean;
}

export interface DocumentAsset {
  id: string;
  type: 'image' | 'audio' | 'video' | 'file';
  role: 'cover' | 'reference' | 'generated' | 'attachment';
  path?: string;
  url?: string;
  prompt?: string;
  modelProvider?: string;
  status: 'generated' | 'prompt_ready' | 'failed';
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
  /** fast 模式全局一致性审查抽检率（0-1，1=全量审查） */
  globalReviewSamplingRate?: number;
  /** Repairer 修复轮次预算上限（超过后转标记问题+门禁阻断，默认 3） */
  repairRoundBudget?: number;
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
  llm: { calls: number; failures: number; maxActive: number; lastError?: string; retries: number; failureStreak?: number; schemaFailures?: number; thinkingWarning?: string };
  evidence: { raw: number; used: number; filteredNoise: number; budgetDropped: number; avgNoiseScore: number; avgFactDensity: number; searchQueries: number; searchMs: number; contextChars: number };
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
  risk: { totalChunks: number; loadedChunks: number; omittedChunks: number; loadedRatio: number; highRisk: boolean; riskReason?: string };
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
    /** 资料完整性 */
    completeness: number;
    /** 方案针对性 */
    specificity: number;
    /** 合规性 */
    compliance: number;
    /** 可落地性 */
    executability: number;
    /** 编制规范性 */
    normalization: number;
    /** 低雷同性 */
    uniqueness: number;
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
  professionalScore?: {
    total: number;
    grade: '专业' | '良好' | '合格' | '待提升';
    dimensions: Array<{ key: string; label: string; score: number; detail: string; weight: number }>;
    summary: string;
    topIssues: string[];
  };
  writingTaskBrief?: WritingTaskBrief;
  workflowVersion?: DocumentWorkflowVersion;
  telemetry?: DocumentTelemetryReport;
  /** 质量对标：与模板参考库同工程类型基准的对比结果 */
  qualityBenchmark?: QualityBenchmarkResult;
}

export interface GeneratedDocumentDraft {
  templateId: string;
  templateName: string;
  templateVersion?: number;
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
  partialChapters?: Array<{ id: string; title: string; chars: number; status: 'completed' | 'failed' | 'in_progress'; updatedAt: number; timedOut?: boolean; elapsedMs?: number }>;
  checkpointChapters?: DocumentDraftChapter[];
  reviewMetadata?: DocumentReviewMetadata;
  /** 提示词绑定溯源：记录每个提示词的完整绑定链路 */
  promptProvenance?: Array<{ promptId: string; roleId: string; configId: string; roleName: string; contentHash: string; order: number }>;
  /** 运行时提示词规则：生成时从提示词中抽取的硬性规则及溯源（用于生效报告展示） */
  promptRules?: RuntimePromptRuleSet;
  /** Agent 工作流上下文：资料范围、资料快照、基础图谱、节点状态 */
  agentWorkflow?: AgentWorkflowContext;
  /** 项目资料图谱：从招标文件+清单+图纸中提取的结构化项目理解 */
  projectGraph?: ProjectGraph;
  /** 施工组织设计写作任务书：每章的写作指导 */
  writingTaskBrief?: WritingTaskBrief;
  generatedAt: number;
}

/** 项目资料图谱：跨文件的结构化项目理解 */
export interface ProjectGraph {
  works: Array<{ name: string; scope: string; sourceFiles: string[]; relatedItems: string[] }>;
  methods: Array<{ name: string; steps: string[]; applicableWorks: string[]; sourceFiles: string[] }>;
  resources: Array<{ name: string; type: 'material' | 'equipment' | 'labor'; spec: string; quantity: string; unit: string; sourceFiles: string[] }>;
  schedule: Array<{ milestone: string; duration: string; startDate: string; endDate: string; sourceFiles: string[] }>;
  standards: Array<{ code: string; description: string; sourceFiles: string[] }>;
  risks: Array<{ risk: string; level: 'high' | 'medium' | 'low'; mitigation: string; sourceFiles: string[] }>;
  requirements: Array<{ category: string; detail: string; sourceFiles: string[] }>;
  siteConditions: Array<{ condition: string; impact: string; sourceFiles: string[] }>;
  addendumChanges: Array<{ originalPath: string; original: string; revised: string; sourceFile: string }>;
  gaps: string[];
  generatedAt: number;
}

/** 施工组织设计写作任务书 */
export interface WritingTaskBrief {
  documentType: string;
  globalWritingFocus: string[];
  chapters: WritingTaskBriefChapter[];
}

/** 单章写作任务卡 */
export interface WritingTaskBriefChapter {
  chapterId: string;
  chapterTitle: string;
  writingGoal: string;
  mustCover: string[];
  factDomains: string[];
  evidenceRefs: Array<{ filePath: string; kind: string; priority: 'must' | 'should' | 'may' }>;
  boqTargets: Array<{ itemCode: string; itemName: string; quantity: string; unit: string }>;
  drawingTargets: string[];
  gaps: string[];
}

/** BOQ 行级落位追踪 */
export interface BoqRowTrace {
  itemCode: string;
  itemName: string;
  quantity: string;
  unit: string;
  sourceFile: string;
  placed: boolean;
  placedInChapter?: string;
  placedInSection?: string;
}
