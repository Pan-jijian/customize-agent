/**
 * GenerationSession：generateDocumentDraft 六阶段拆分的跨阶段共享状态对象。
 *
 * P1 拆分原则（方案 5.1）：
 * - 阶段函数签名统一为 `(session) => Promise<void>`，只读写自己的命名子对象 + global 共享段；
 * - 按"阶段产物"分 6 个命名子对象：global / prepare / understanding / planning / blueprint / chapterLoop；
 * - 纯结构搬迁（行为保持）：字段名、读写时序与原巨型函数闭包变量逐一对应，业务生成语义零变化。
 *
 * 阶段边界：
 * - 阶段 0 stagePrepare：角色绑定/资料锁定/索引同步/准备度/硬约束提示词
 * - 阶段 1 stageUnderstanding：基础事实/内容安全/事实池/裁决/图谱/canonical
 * - 阶段 2 stageOutlinePlanning：评标校验/评分项提取链/小节规划/校准/过滤/路由
 * - 阶段 3 stageBlueprint：蓝图构建/分部校准/参数桶
 * - 阶段 4 stageChapterLoop：章节循环（证据→深召回→三路成稿→收口）
 * - 全局轮与 finalizeGeneration 保留在编排器（documentGenerator.ts）中
 */
import type { KbSearchResult } from '@/lib/api';
import type { MultiProjectManager } from '@customize-agent/knowledge';
import type {
  DocumentDraftChapter,
  DocumentEvidence,
  DocumentExecutionStage,
  DocumentFactsModel,
  DocumentGenerationDiagnostics,
  DocumentTemplate,
  DocumentTemplateChapter,
  ProjectGraph,
  CanonicalFactModel,
  DocumentGenerationStrategy,
  PromptChapterStructuralRule,
  RetrievalCoverageReport,
  RuntimePromptRuleSet,
  TenderRequirementModel,
  WebAccessConfig,
} from '../types';
import type { AgentMaterialScope, AgentWorkflowContext } from '../agentWorkflow';
import type { PromptBindingPlan } from '../templateStore';
import type { ProjectMaterialProfile, ProjectUnderstanding, MaterialKind } from '../projectMaterialProfile';
import type { ProjectMaterialScope } from '../projectMaterialScope';
import type { ProjectMaterialSummary } from '../../document-core/projectMaterialService';
import type { DocumentDomainProfile } from '../../document-core/documentDomainProfileService';
import type { AutoDocumentSpecResult } from '../../document-core/autoDocumentSpecService';
import type { DocumentGenerationReadiness } from '../../document-validation/documentReadinessService';
import type { RetrievalCoverageRisk } from '../documentEvidenceRetrieval';
import type { EvaluationCriteriaItem } from '../constructionBidStructure';
import type { DocumentBudget } from '../budget';
import type { GenerationBudget } from '../generationBudget';
import type { IntegratedBlueprint } from '../integratedBlueprint';
import type { BillFactLock } from '../billFactLock';
import type { RequirementSemanticPlan } from '../requirementSemantics';
import type { Semaphore } from '../utils';

/** 生成入口输入（原 generateDocumentDraft 函数签名参数） */
export interface GenerateDocumentDraftInput {
  templateId: string;
  requirement?: string;
  maxEvidencePerChapter?: number;
  projectRoot?: string;
  resumeChapters?: DocumentDraftChapter[];
  signal?: AbortSignal;
  onProgress?: (stages: DocumentExecutionStage[], checkpoint?: { chapters?: DocumentDraftChapter[] }) => void;
}

/** 阶段 1 图谱→章节映射条目（原 chapterGraphMap 值结构） */
export interface ChapterGraphMapping {
  graphFiles: Set<string>;
  graphBoqItems: Array<{ name: string; quantity: string; unit: string; sourceFiles: string[] }>;
  graphWorks: string[];
  graphMethods: string[];
  gaps: string[];
}

/** 项目句柄（manager.getProject 返回值） */
export type ProjectHandle = Awaited<ReturnType<MultiProjectManager['getProject']>>;

/** 文件详情缓存条目（getCachedFileDetail 返回，chunks 取内容与节标题） */
export type CachedFileDetail =
  | { file: { relativePath: string }; chunks: Array<{ content: string; sectionTitle?: string }> }
  | undefined;

/** global：跨阶段共享基础设施（进度/心跳/章节草稿游标） */
export interface GenerationSessionGlobal {
  input: GenerateDocumentDraftInput;
  emitProgress: (checkpointChapters?: DocumentDraftChapter[], stages?: DocumentExecutionStage[]) => void;
  withProgressHeartbeat: <T>(work: () => Promise<T>, stages?: DocumentExecutionStage[]) => Promise<T>;
  progressStages: DocumentExecutionStage[];
  /** 可变：章节收口后按 checkpointChapterOrderIds 排序的进行中章节列表 */
  chapterDrafts: DocumentDraftChapter[];
  checkpointChapterOrderIds: string[];
}

/** prepare：阶段 0 产物（角色/资料/提示词/准备度） */
export interface GenerationSessionPrepare {
  template: DocumentTemplate;
  projectRoot: string;
  projectId: string;
  materialScope: AgentMaterialScope;
  materialFilePaths: string[];
  promptPlan: PromptBindingPlan;
  promptBindings: PromptBindingPlan['bindings'];
  projectRoleConfigId: string;
  projectRoleConfigName: string;
  projectMaterialProfile: ProjectMaterialProfile;
  projectUnderstanding: ProjectUnderstanding;
  kindByPath: Map<string, MaterialKind>;
  processingByPath: Map<string, string>;
  explicitPromptChapters: DocumentTemplateChapter[];
  hasExplicitOutline: boolean;
  projectMaterialSummary: ProjectMaterialSummary;
  documentSpec: AutoDocumentSpecResult['spec'];
  domainProfile: DocumentDomainProfile;
  readiness: DocumentGenerationReadiness;
  generationWritingConstraintsPrompt: string;
  generationControlPrompt: string;
  diagnosticControlPrompt: string;
  promptTexts: string;
  promptDocumentRules: RuntimePromptRuleSet;
  factExtractionPromptTexts: string;
  reviewPromptTexts: string;
  repairPromptTexts: string;
  runtimePromptRules: RuntimePromptRuleSet;
  runtimeRulesText: string;
  /** 用户提示词语义解析计划（阶段 0 解析一次，写作注入/检索线索/生成后核验三处消费） */
  requirementSemantics: RequirementSemanticPlan;
  webAccessConfig: WebAccessConfig;
}

/** understanding：阶段 1 产物（索引/证据/事实池/图谱/canonical） */
export interface GenerationSessionUnderstanding {
  manager: MultiProjectManager;
  evidenceScopePaths: Set<string>;
  fileRoleByPath: Map<string, string>;
  fileProcessingByPath: Map<string, string>;
  project: ProjectHandle;
  indexHealth: ReturnType<typeof import('../documentGeneratorHelpers').kbIndexHealth>;
  availableEvidenceScopePaths: Set<string>;
  projectMaterialScope: ProjectMaterialScope;
  requestedEvidencePerChapter: number;
  rolePoolRisk: RetrievalCoverageRisk;
  allEvidence: DocumentEvidence[];
  retrievalCoverageReports: RetrievalCoverageReport[];
  webResearchReport: { enabled: boolean; queries: string[]; evidenceCount: number; filteredCount: number; chapters: string[] };
  missingItems: string[];
  failedChapterMessages: string[];
  chapterGenerationStages: DocumentExecutionStage[];
  chapterDraftsByOrder: Array<DocumentDraftChapter | undefined>;
  chapterGenerationStagesByOrder: Array<DocumentExecutionStage | undefined>;
  knowledgeBaseStageIndex: number;
  getCachedFileDetail: (relativePath: string) => CachedFileDetail;
  searchWithCache: (query: string, scopedFilePaths: string[], limit: number, chapterTitle: string) => Promise<KbSearchResult[]>;
  writerEvidence: DocumentEvidence[];
  bidProcedureJudge: Awaited<ReturnType<typeof import('../evidenceContentSafety').buildBidProcedureJudge>>;
  safeProjectBasicEvidence: DocumentEvidence[];
  excludedEvidenceKeys: Set<string>;
  earlyFactPool: ReturnType<typeof import('../factsModel').extractLocalFactPool>;
  scopedIntelligence: ReturnType<typeof import('../projectIntelligence').buildScopedProjectIntelligence> | undefined;
  preliminaryFactsModel: DocumentFactsModel;
  agentWorkflow: AgentWorkflowContext;
  projectGraph: ProjectGraph | undefined;
  canonicalFacts: CanonicalFactModel;
  chapterGraphMap: Map<string, ChapterGraphMapping>;
  evaluationItems: EvaluationCriteriaItem[];
  bidStructureAudit: ReturnType<typeof import('../constructionBidStructure').validateBidStructureBeforeGeneration>;
  /** 阶段 1 尾部启动的招标要求提取链任务（阶段 2 消费） */
  tenderRequirementsTask: Promise<TenderRequirementModel>;
}

/** planning：阶段 2 产物（大纲规划/评分项路由/预算/诊断） */
export interface GenerationSessionPlanning {
  baseEffectiveChapters: DocumentTemplateChapter[];
  plannedDocumentTask: ReturnType<typeof import('../agentPlanner').planDocument>;
  constructionOrgContext: string | undefined;
  chapterGraphSummaryText: (chapterId: string) => string;
  baseProjectContext: string;
  projectContext: string;
  promptStructuralRules: PromptChapterStructuralRule[];
  provisionalBudget: DocumentBudget;
  plannedChapters: DocumentTemplateChapter[];
  tenderRequirements: TenderRequirementModel;
  effectiveChapters: DocumentTemplateChapter[];
  finalBidStructureAudit: ReturnType<typeof import('../constructionBidStructure').validateBidStructureBeforeGeneration>;
  requirementsSimilarity: Awaited<ReturnType<typeof import('../semanticSimilarity').buildSemanticSimilarity>>;
  requirementsRoutes: Awaited<ReturnType<typeof import('../tenderRequirements').routeTenderRequirementsToChapters>>;
  factTokenScopeClassifier: Awaited<ReturnType<typeof import('../factTokenClassifier').buildFactTokenScopeClassifier>>;
  /** P17 章标题意图语义分类器（阶段 4 蓝图阻断/基础事实/扬尘注入三处判定共用同一实例） */
  chapterIntentClassifier: Awaited<ReturnType<typeof import('../chapterIntentClassifier').buildChapterIntentClassifier>>;
  professionalDepthClassifier: Awaited<ReturnType<typeof import('../professionalDepthClassifier').buildProfessionalDepthClassifier>>;
  writingTaskBrief: ReturnType<typeof import('../documentWritingTaskBrief').buildWritingTaskBrief>;
  tenderWritingRulesText: string;
  chapterScopedProjectContext: (chapter: DocumentTemplateChapter) => string;
  documentBudget: DocumentBudget;
  plannedDocument: Awaited<ReturnType<typeof import('../agentPlanner').planDocument>>;
  generationStrategy: DocumentGenerationStrategy;
  generationBudget: GenerationBudget;
  generationDiagnostics: DocumentGenerationDiagnostics;
  planPhaseStartedAt: number;
  sectionPlanningStage: DocumentExecutionStage;
}

/** blueprint：阶段 3 产物（蓝图/并发池/跨章基础事实缓存） */
export interface GenerationSessionBlueprint {
  chapterConcurrency: number;
  reviewConcurrency: number;
  reviewSemaphore: Semaphore;
  reviewTaskPool: Promise<void>[];
  basicFactSearchResults: KbSearchResult[];
  integratedBlueprint: IntegratedBlueprint | undefined;
  blueprintActive: boolean;
  blueprintDataText: string;
  /** 清单事实锁（阶段 3 构建：条目→特征→工程量行级确定性锁，写作直读 + 生成后数值核对共用） */
  billFactLock: BillFactLock | undefined;
}

/** chapterLoop：阶段 4 产物（成稿期起点与终态） */
export interface GenerationSessionChapterLoop {
  draftPhaseStartedAt: number;
  chapterDraftsFinal: DocumentDraftChapter[];
  globalReviewPhaseStartedAt: number;
}

/** 六阶段共享状态：按"阶段产物"分 6 个命名子对象 */
export interface GenerationSession {
  global: GenerationSessionGlobal;
  prepare: GenerationSessionPrepare;
  understanding: GenerationSessionUnderstanding;
  planning: GenerationSessionPlanning;
  blueprint: GenerationSessionBlueprint;
  chapterLoop: GenerationSessionChapterLoop;
}

/** 创建空 session 骨架（阶段 0 负责填充 global 与 prepare） */
export function createEmptyGenerationSession(input: GenerateDocumentDraftInput): GenerationSession {
  return {
    global: {
      input,
      emitProgress: () => undefined,
      withProgressHeartbeat: async <T>(work: () => Promise<T>) => work(),
      progressStages: [],
      chapterDrafts: [],
      checkpointChapterOrderIds: [],
    },
    prepare: {} as GenerationSessionPrepare,
    understanding: {} as GenerationSessionUnderstanding,
    planning: {} as GenerationSessionPlanning,
    blueprint: {} as GenerationSessionBlueprint,
    chapterLoop: {} as GenerationSessionChapterLoop,
  };
}
