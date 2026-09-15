/**
 * types/core：模板/证据/事实/草稿/图谱/任务书（P5 类型切割，逐字机械搬移自 types.ts）。
 * 依赖 validation（Issue/Gate/ReviewMetadata）与 progress（Stage/Asset）的 import type（type-only 引用，运行时无依赖）。
 */
import type { AgentWorkflowContext } from '../agentWorkflow';
import type { BidCompositionSpec } from '../bidComposition';
import type { ExportGateResult, ValidationIssue, DocumentReviewMetadata } from './validation';
import type { DocumentExecutionStage, DocumentAsset } from './progress';

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
  /** 4.33 招标文件附表清单（「除文字表述外可附下列图表」场景）：表类附表生成到正文文末附表区，图类附表由编制人人工补充 */
  appendixTableTitles?: string[];
  appendixAttachedAtEnd?: boolean;
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

/** 规划表格字段：表头列名（来自 LLM 章节规划的表格需求，字段可为空——写作时按表名与所在小节内容确定） */
export interface PlannedTableField {
  name: string;
}

/** 规划表格计划：来自提示词声明的必需表格与 LLM 章节规划的表格需求（统一规划产物，无静态目录匹配） */
export interface PlannedTablePlan {
  id: string;
  title: string;
  chapterTitle: string;
  /** 归属小节（规划产物，可空——空时按表名与小节标题语义匹配分配） */
  section: string;
  /** 提示词声明的必需表格（必写）；LLM 规划产出的为应写 */
  required: boolean;
  reason: string;
  fields: PlannedTableField[];
}

export interface ChapterReadinessPlan {
  chapterId: string;
  chapterTitle: string;
  canGenerate: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  missingFacts: string[];
  missingEvidence: string[];
  suggestedStrategy: 'normal' | 'section_first' | 'evidence_first';
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
  tablePlans?: PlannedTablePlan[];
  pinnedEvidenceFilePaths?: string[];
}

export interface DocumentExportSettings {
  page?: {
    paper?: string;
    marginTop?: string;
    marginRight?: string;
    marginBottom?: string;
    marginLeft?: string;
    /** 4.33 装订线宽度（如 0.5cm；暗标格式常见要求 0.3~0.6cm），导出 docx 时写入 w:gutter */
    gutter?: string;
  };
  typography?: {
    fontFamily?: string;
    lineHeight?: string;
    titleSize?: string;
    bodySize?: string;
    /** 4.33 正文字体（如 仿宋_GB2312；缺省宋体） */
    bodyFont?: string;
    /** 4.33 标题字体（如 仿宋_GB2312；缺省沿用 fontFamily 或黑体） */
    headingFont?: string;
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
  tablePlans?: PlannedTablePlan[];
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

/** 规格-部位权威映射条目：同一规格维度（如混凝土强度等级）在不同部位的不同规格，
 *  是「同物多规格按分部分项区分使用」的确定性权威依据（来源：清单行级条目→特征描述） */

export interface SpecPlacement {
  location: string;
  spec: string;
  quantity?: string;
  sourceFile: string;
}

/** 规格维度标签（混凝土强度等级/砂浆强度等级/…） → 部位-规格列表 */

export type SpecAuthorityMap = Record<string, SpecPlacement[]>;

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
  /** 清单行级条目事实（条目名[部位]→特征描述[规格]→工程量），行级提取直接产物 */
  billItemFacts?: DocumentFact[];
  /** 规格-部位权威映射：同物多规格按部位区分使用的确定性依据 */
  specAuthorityMap?: SpecAuthorityMap;
  missing: string[];
  conflicts: string[];
  canonical?: CanonicalFactModel;
}

/** 招标要求响应方式两态：respond=正文显性响应（创优/等级/技术条款）；comply=遵守类（工期基准/禁编日期等，
 * 不逐条抄写但不得违背）。商务域条款（付款/保证金/结算/报价/税金等）在判定层排除（reason=commercial_scope），
 * 技术标正文零商务句——相关响应属商务标内容。 */
export type TenderRequirementPolicy = 'respond' | 'comply';

/** 单条实质要求（条款穷举+逐条判定产物）：text 为条款原文（忠实引用），coreTerms 为正文命中检测核心词，
 * sources 为多来源聚合（同一要求在招标/补疑重复出现时合并，不丢来源） */
export interface TenderRequirementEntry {
  text: string;
  coreTerms: string[];
  sources: Array<{ file?: string; location?: string }>;
  /** LLM 按招标语义自命名的类别（质量创优/工期进度/安全文明等），仅展示分组与消息用 */
  category: string;
  policy: TenderRequirementPolicy;
  /** 全文档性约束（如「以开工令为准」的禁编日期）：除章节分配外同时进入全局写作口径区 */
  global?: boolean;
}

/** 被排除条款记录（reason：non_requirement=目录/导语/说明；out_of_scope=投标程序/资格/评标规则/纪律；
 * no_value=条款值为「无」；duplicate=重复文本合并；commercial_scope=商务与造价条款（付款/保证金/结算/
 * 报价/税金等，技术标正文零商务句，响应由商务标承接））——仅对账与审计用，不注入写作 */
export interface TenderRequirementExclusion {
  text: string;
  source?: string;
  reason: 'non_requirement' | 'out_of_scope' | 'no_value' | 'duplicate' | 'commercial_scope';
}

/** 提取对账：条款总数 = entries 覆盖 + excluded + 重复合并 + undecidedCount（必须为 0 才对账闭合） */
export interface TenderRequirementsReconciliation {
  clauseCount: number;
  entryCount: number;
  excludedCount: number;
  /** 未判定条款数（LLM 输出缺号且重试后仍缺）：>0 即对账未闭合，缓存不落盘并显式告警 */
  undecidedCount: number;
  /** 重复文本合并计数（并入 entries 的 sources 聚合） */
  mergedCount: number;
  batchCount: number;
  retriedBatches: number;
}

/**
 * 招标要求模型（全量条款穷举范式）：绑定资料 → 条款化（确定性结构切分）→ 逐条判定（每条必出判定）
 * → 三态归宿（entries/excluded/合并）→ 对账闭合。取代旧 10 字段「必提清单」归纳式提取。
 * 下游出口：① 蓝图统一分配（每章责任分片注入写作）；② 章级验收（收口前核验本章责任要求）。
 */
export interface TenderRequirementModel {
  /** 全量实质要求（要写/要遵守的） */
  entries: TenderRequirementEntry[];
  /** 排除记录（不要的，带原因，对账/审计用） */
  excluded: TenderRequirementExclusion[];
  reconciliation: TenderRequirementsReconciliation;
  /** 判定链是否实际执行（LLM 不可用/资料为空时为 false，下游不得据此阻断） */
  extracted: boolean;
  /** 提取源文本哈希（判定可复现溯源用） */
  sourceHash?: string;
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
  /** 标书编制规格（阶段 1 判定快照）：导出层格式口径（页眉页脚/封面/页数上限/单黑色）承接消费 */
  bidComposition?: BidCompositionSpec;
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
