/**
 * FinalizeSession：finalizeGeneration 拆分的跨阶段共享状态对象（P2，方案 5.2）。
 *
 * 拆分原则：
 * - 阶段函数签名统一为 `(session) => Promise<void>`，读写 session 显式字段；
 * - 纯结构搬迁（行为保持）：字段名、读写时序与原 finalizeGeneration 巨型函数闭包变量逐一对应；
 * - rebuildFinalMarkdown / recomputeFinalValidationBundle 两个闭包以字段形式承载（P9 provenance 失效机制落地处）；
 * - 修复轮顺序由 FINALIZE_REPAIR_ROUNDS（detectorFixerRegistry）单源声明，顺序快照测试锁定。
 */
import type { AgentWorkflowContext } from '../agentWorkflow';
import type {
  DocumentAsset,
  DocumentDraftChapter,
  DocumentEvidence,
  DocumentExecutionStage,
  DocumentFact,
  DocumentGenerationDiagnostics,
  DocumentGenerationStrategy,
  DocumentTemplate,
  DocumentTemplateChapter,
  NumericScopeConflict,
  PromptBinding,
  RetrievalCoverageReport,
  RuntimePromptRuleSet,
  TenderRequirementModel,
  ValidationIssue,
  WritingTaskBrief,
} from '../types';
import type { FactTokenScopeClassifier } from '../factTokenClassifier';
import type { ProfessionalDepthClassifier } from '../professionalDepthClassifier';
import type { ProjectMaterialScope } from '../projectMaterialScope';
import type { ProjectMaterialProfile, ProjectUnderstanding } from '../projectMaterialProfile';
import type { DocumentBudget } from '../budget';
import type { PromptBindingPlan } from '../templateStore';
import type { AutoDocumentSpecPackage } from '../../document-core/autoDocumentSpecTypes';
import type { ProjectMaterialSummary } from '../../document-core/projectMaterialService';
import type { DocumentDomainProfile } from '../../document-core/documentDomainProfileService';
import type { DocumentGenerationReadiness } from '../../document-validation/documentReadinessService';
import type { BlueprintData, extractDecisionLockEntries } from '../integratedBlueprint';
import type { SurfaceFixerContext } from '../deterministicFixChains';
import type { BillFactLock } from '../billFactLock';
import type { RequirementSemanticPlan } from '../requirementSemantics';
import type { buildFactsModel } from '../factsModel';
import type { kbIndexHealth, validateDraft } from '../documentGeneratorHelpers';
import type { buildKnowledgeCoverageReport } from '../documentKnowledgeCoverage';
import type { buildDocumentFactTraces } from '../documentFactTrace';
import type { buildChapterCoverageReports } from '../documentChapterCoverage';
import type { buildDocumentQualityReport } from '../documentQualityReport';
import type { buildRepairStrategies } from '../documentRepairStrategies';
import type { buildExportGate } from '../qualityValidation';
import type { extractScheduleAuthority, extractAssemblyRateAuthority, extractProjectScaleSummary, extractSupportSystemAuthority, extractGreeningMaintenanceAuthority } from '../documentIntegrityChecks';
import type { buildDocumentReviewChecklist } from '../documentReviewChecklist';
import type { buildDocumentTelemetryReport } from '../documentTelemetry';
import type { buildProfessionalScoreReport } from '../documentProfessionalScore';
import type { AuthorityAuditReport } from '../authorityAudit';

/** finalizeGeneration 输入聚合（二期结构改造：匿名参数对象命名化）。字段按职责分组。 */
export interface FinalizeGenerationInput {
  // ── 章节产物 ──
  chapterDrafts: DocumentDraftChapter[];
  chapterDraftsByOrder: Array<DocumentDraftChapter | undefined>;
  chapterGenerationStagesByOrder: Array<DocumentExecutionStage | undefined>;
  chapterGenerationStages: DocumentExecutionStage[];
  effectiveChapters: DocumentTemplateChapter[];
  // ── 模板与证据 ──
  template: DocumentTemplate; allEvidence: DocumentEvidence[];
  projectMaterialScope: ProjectMaterialScope;
  // ── 进度与基础设施 ──
  progressStages: DocumentExecutionStage[];
  input: { requirement?: string; signal?: AbortSignal; onProgress?: (stages: DocumentExecutionStage[], checkpoint?: { chapters?: DocumentDraftChapter[] }) => void };
  emitProgress: (c?: DocumentDraftChapter[], s?: DocumentExecutionStage[]) => void;
  withProgressHeartbeat: <T>(w: () => Promise<T>, s?: DocumentExecutionStage[]) => Promise<T>;
  // ── 规划与画像（生成期产物，finalize 只消费）──
  documentSpec: AutoDocumentSpecPackage; projectMaterialProfile: ProjectMaterialProfile;
  projectMaterialSummary: ProjectMaterialSummary; domainProfile: DocumentDomainProfile;
  documentBudget: DocumentBudget; generationStrategy: DocumentGenerationStrategy;
  readiness: DocumentGenerationReadiness; indexHealth: ReturnType<typeof kbIndexHealth>; promptPlan: PromptBindingPlan;
  // ── 提示词与规则 ──
  promptTexts: string; reviewPromptTexts: string;
  repairPromptTexts: string;
  factExtractionPromptTexts: string;
  promptBindings: PromptBinding[]; promptDocumentRules: RuntimePromptRuleSet;
  // ── 项目上下文 ──
  projectUnderstanding: ProjectUnderstanding; projectContext: string; projectRoot: string; projectId: string;
  /** A2 章级 scoped 上下文工厂（生成器预构建）：Final Gate 补写调用按章精确裁剪蓝图；未提供时回退全量 projectContext */
  chapterScopedContext?: (chapter: DocumentTemplateChapter) => string;
  // ── 质量门禁输入（生成期审计产物）──
  generationDiagnostics: DocumentGenerationDiagnostics;
  hasExplicitOutline: boolean; missingItems: string[];
  retrievalCoverageReports: RetrievalCoverageReport[];
  failedChapterMessages: string[];
  webResearchReport: { enabled: boolean; queries: string[]; evidenceCount: number; filteredCount: number; chapters: string[] };
  agentWorkflow: AgentWorkflowContext;
  globalConsistencyIssues?: string[];
  /** 生成阶段裁决的源级同口径冲突（与 canonicalFacts.scopeConflicts 同源），用于事实主表回写，保证裁决口径全局唯一 */
  scopeConflicts?: NumericScopeConflict[];
  writingTaskBrief?: WritingTaskBrief;
  /** 招标文件评分条目标题（承接审计产物），用于最终正文承接后置校验 */
  evaluationCriteriaItems?: string[];
  /** 招标文件评分项要求（LLM 结构化提取产物）：零响应检测锚点 + 交付阻断修复轮输入 */
  tenderRequirements?: TenderRequirementModel;
  /** 评分项要求↔章节语义相似度函数（本地 bge 余弦，生成前预构建恒非空，随 p 传递复用） */
  requirementsSimilarity: (leftText: string, rightText: string) => number;
  /** 总量口径语义分类器（round-13，生成前预构建）：事实反查口径归属语义复核（本地 bge 恒可用） */
  factTokenScopeClassifier: FactTokenScopeClassifier;
  /** 专业深度语义分类器（round-14，生成前预构建）：章节专业深度/缺项/套话/闭环/依赖语义判定（本地 bge 恒可用） */
  professionalDepthClassifier: ProfessionalDepthClassifier;
  /** 一体化蓝图参数桶（生成前锁定口径）：交付前确定性清洗的节点工期/机械台数/决策锁权威（三期蓝图接管） */
  blueprintData?: BlueprintData;
  /** B1 清单事实锁（蓝图阶段确定性解析）：正文数值 vs 资料原文核对轮（numeric-verification）的清单行权威源 */
  billFactLock?: BillFactLock;
  /** A2 用户提示词语义解析计划：生成后用户要求执行核验闭环（requirement-verification）的核验依据 */
  requirementSemantics?: RequirementSemanticPlan;
}

/** factsModel 类型（buildFactsModel 返回，canonical 在 finalize 内回写） */
export type FinalizeFactsModel = Awaited<ReturnType<typeof buildFactsModel>>;

/** 质量报告组解构（knowledgeCoverage/factTraces/chapterCoverage/qualityReport/repairStrategies/finalExportGate） */
export interface FinalizeQualityBundle {
  knowledgeCoverage: ReturnType<typeof buildKnowledgeCoverageReport>;
  factTraces: ReturnType<typeof buildDocumentFactTraces>;
  chapterCoverage: ReturnType<typeof buildChapterCoverageReports>;
  qualityReport: Awaited<ReturnType<typeof buildDocumentQualityReport>>;
  repairStrategies: ReturnType<typeof buildRepairStrategies>;
  validationIssues: ValidationIssue[];
  finalExportGate: ReturnType<typeof buildExportGate>;
}

/** finalizeGeneration 跨阶段共享状态（原巨型函数闭包变量的显式化载体） */
export interface FinalizeSession {
  // ── 输入快照（从 FinalizeGenerationInput 解构，finalize 内只读；progressStages/allEvidence 引用型可变） ──
  input: FinalizeGenerationInput;
  template: DocumentTemplate;
  effectiveChapters: DocumentTemplateChapter[];
  requirement?: string;
  signal?: AbortSignal;
  projectRoot: string;
  projectId: string;
  projectMaterialSummary: ProjectMaterialSummary;
  documentSpec: AutoDocumentSpecPackage;
  documentBudget: DocumentBudget;
  promptBindings: PromptBinding[];
  promptDocumentRules: RuntimePromptRuleSet;
  domainProfile: DocumentDomainProfile;
  scopeConflicts?: NumericScopeConflict[];
  evaluationCriteriaItems?: string[];
  tenderRequirements?: TenderRequirementModel;
  requirementsSimilarity: (leftText: string, rightText: string) => number;
  factTokenScopeClassifier: FactTokenScopeClassifier;
  professionalDepthClassifier: ProfessionalDepthClassifier;
  blueprintData?: BlueprintData;
  /** B1 清单事实锁快照（numeric-verification 轮消费） */
  billFactLock?: BillFactLock;
  /** A2 用户提示词语义解析计划快照（requirement-verification 轮消费） */
  requirementSemantics?: RequirementSemanticPlan;
  generationDiagnostics: DocumentGenerationDiagnostics;
  repairPromptTexts: string;
  progressStages: DocumentExecutionStage[];
  chapterGenerationStages: DocumentExecutionStage[];
  emitProgress: (c?: DocumentDraftChapter[], s?: DocumentExecutionStage[]) => void;
  withProgressHeartbeat: <T>(w: () => Promise<T>, s?: DocumentExecutionStage[]) => Promise<T>;
  missingItems: string[];
  failedChapterMessages: string[];
  indexHealth: ReturnType<typeof kbIndexHealth>;
  webResearchReport: { enabled: boolean; queries: string[]; evidenceCount: number; filteredCount: number; chapters: string[] };
  hasExplicitOutline: boolean;
  retrievalCoverageReports: RetrievalCoverageReport[];
  projectMaterialScope: ProjectMaterialScope;
  writingTaskBrief?: WritingTaskBrief;
  globalConsistencyIssues?: string[];
  agentWorkflow: AgentWorkflowContext;
  factExtractionPromptTexts: string;
  readiness: DocumentGenerationReadiness;
  promptPlan: PromptBindingPlan;
  // ── 可变状态 ──
  allEvidence: DocumentEvidence[];
  facts: Record<string, string>;
  structuredFacts: DocumentFact[];
  /** 源级同口径冲突裁决回写后的结构化事实（rebuildFacts 产出，validationPack 校验打包消费） */
  governedStructuredFacts: DocumentFact[];
  factsModel: FinalizeFactsModel;
  chapterDrafts: DocumentDraftChapter[];
  finalChapterDrafts: DocumentDraftChapter[];
  finalMarkdown: string;
  validationIssues: ValidationIssue[];
  baseValidationIssues: ValidationIssue[];
  executionStages: DocumentExecutionStage[];
  finalGateRepairStages: DocumentExecutionStage[];
  qingtianReviewBlockingIssues: ValidationIssue[];
  sources: Array<{ filePath: string; count: number }>;
  qualityBundle: FinalizeQualityBundle;
  // ── 权威口径（rebuildFacts 抽取，确定性修复轮消费） ──
  scheduleAuthority: ReturnType<typeof extractScheduleAuthority>;
  assemblyRateAuthority: ReturnType<typeof extractAssemblyRateAuthority>;
  scaleSummary: ReturnType<typeof extractProjectScaleSummary>;
  supportAuthority: ReturnType<typeof extractSupportSystemAuthority>;
  laborPeakAuthority: number | undefined;
  greeningMaintenanceAuthority: ReturnType<typeof extractGreeningMaintenanceAuthority>;
  surfaceFixContext: SurfaceFixerContext;
  /** 决策锁实体-选择冲突比对条目（rebuildFacts 计算，semanticChoice 消费） */
  decisionLockEntries: ReturnType<typeof extractDecisionLockEntries>;
  /** finalGate 产出的最终执行阶段（返回组装消费） */
  finalStages: DocumentExecutionStage[];
  /** finalGate 产出：交付复核清单/telemetry/专业度评分/语义级模板化复核结果（返回组装消费） */
  reviewChecklist: ReturnType<typeof buildDocumentReviewChecklist>;
  telemetry: ReturnType<typeof buildDocumentTelemetryReport>;
  professionalScore: Awaited<ReturnType<typeof buildProfessionalScoreReport>>;
  templatingReview: { issues: string[]; reviewed: boolean };
  /** V5 P5 无主数值审计报告（M6）：正文数值 ↔ AuthorityIndex 三分类（一致/登记豁免/无主分流），
   * 修复轮重算校验组后刷新，随 reviewMetadata 交付归档（验收口径「0 未登记项」= unattributed 为空） */
  authorityAuditReport?: AuthorityAuditReport;
  // ── 组装产物 ──
  assets: DocumentAsset[];
  validation: ReturnType<typeof validateDraft>;
  // ── 方法（rebuildAndRecompute 闭包单点，修复轮消费） ──
  rebuildFinalMarkdown: () => string;
  recomputeFinalValidationBundle: () => Promise<void>;
}

/** 创建空 session 骨架：输入快照由编排器解构填充，可变状态与闭包由各 stage 函数填充 */
export function createFinalizeSession(input: FinalizeGenerationInput): FinalizeSession {
  const { signal, requirement } = input.input;
  return {
    input,
    template: input.template,
    effectiveChapters: input.effectiveChapters,
    requirement,
    signal,
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    projectMaterialSummary: input.projectMaterialSummary,
    documentSpec: input.documentSpec,
    documentBudget: input.documentBudget,
    promptBindings: input.promptBindings,
    promptDocumentRules: input.promptDocumentRules,
    domainProfile: input.domainProfile,
    scopeConflicts: input.scopeConflicts,
    evaluationCriteriaItems: input.evaluationCriteriaItems,
    tenderRequirements: input.tenderRequirements,
    requirementsSimilarity: input.requirementsSimilarity,
    factTokenScopeClassifier: input.factTokenScopeClassifier,
    professionalDepthClassifier: input.professionalDepthClassifier,
    blueprintData: input.blueprintData,
    billFactLock: input.billFactLock,
    requirementSemantics: input.requirementSemantics,
    generationDiagnostics: input.generationDiagnostics,
    repairPromptTexts: input.repairPromptTexts,
    progressStages: input.progressStages,
    chapterGenerationStages: input.chapterGenerationStages,
    emitProgress: input.emitProgress,
    withProgressHeartbeat: input.withProgressHeartbeat,
    missingItems: input.missingItems,
    failedChapterMessages: input.failedChapterMessages,
    indexHealth: input.indexHealth,
    webResearchReport: input.webResearchReport,
    hasExplicitOutline: input.hasExplicitOutline,
    retrievalCoverageReports: input.retrievalCoverageReports,
    projectMaterialScope: input.projectMaterialScope,
    writingTaskBrief: input.writingTaskBrief,
    globalConsistencyIssues: input.globalConsistencyIssues,
    agentWorkflow: input.agentWorkflow,
    factExtractionPromptTexts: input.factExtractionPromptTexts,
    readiness: input.readiness,
    promptPlan: input.promptPlan,
    allEvidence: input.allEvidence,
    facts: {},
    structuredFacts: [],
    governedStructuredFacts: [],
    factsModel: undefined as unknown as FinalizeFactsModel,
    chapterDrafts: [],
    finalChapterDrafts: [],
    finalMarkdown: '',
    validationIssues: [],
    baseValidationIssues: [],
    executionStages: [],
    finalGateRepairStages: [],
    qingtianReviewBlockingIssues: [],
    sources: [],
    qualityBundle: undefined as unknown as FinalizeQualityBundle,
    scheduleAuthority: undefined as unknown as FinalizeSession['scheduleAuthority'],
    assemblyRateAuthority: undefined as unknown as FinalizeSession['assemblyRateAuthority'],
    scaleSummary: undefined as unknown as FinalizeSession['scaleSummary'],
    supportAuthority: undefined as unknown as FinalizeSession['supportAuthority'],
    laborPeakAuthority: undefined as unknown as FinalizeSession['laborPeakAuthority'],
    greeningMaintenanceAuthority: undefined as unknown as FinalizeSession['greeningMaintenanceAuthority'],
    surfaceFixContext: { laborPeakAuthority: undefined as never, greeningMaintenanceAuthority: undefined as never },
    decisionLockEntries: [],
    finalStages: [],
    reviewChecklist: [],
    telemetry: undefined as unknown as FinalizeSession['telemetry'],
    professionalScore: undefined as unknown as FinalizeSession['professionalScore'],
    templatingReview: { issues: [], reviewed: false },
    assets: [],
    validation: undefined as unknown as FinalizeSession['validation'],
    rebuildFinalMarkdown: () => '',
    recomputeFinalValidationBundle: async () => undefined,
  };
}
