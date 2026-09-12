/**
 * types/validation：校验问题/门禁/报告/复核清单/telemetry（P5 类型切割，逐字机械搬移自 types.ts）。
 * 依赖 progress 的 diagnostics；DocumentReviewMetadata 引用 core 的 WritingTaskBrief（type-only 循环，运行时无依赖）。
 */
import type { DocumentGenerationDiagnostics } from './progress';
import type { WritingTaskBrief } from './core';
import type { TenderBidTemplatingReport } from '../tenderBidScoring';
import type { QualityBenchmarkResult } from '../benchmarkQuality';
import type { AuthorityAuditReport } from '../authorityAudit';

export interface ChapterCoverageReport {
  chapterId: string;
  title: string;
  score: number;
  checks: Array<{ key: string; label: string; passed: boolean }>;
  action: string;
}

export interface ChapterReviewSummary {
  chapterId: string;
  title: string;
  status: 'pass' | 'warn' | 'fail';
  issues: string[];
  suggestions: string[];
  chars: number;
}

export interface DocumentFactTrace {
  label: string;
  value: string;
  sourceFile?: string;
  status: 'used' | 'unplaced';
  confidence: number;
}

export interface DocumentKnowledgeCoverageReport {
  score: number;
  evidenceCount: number;
  confirmedFiles: number;
  chapterReports: Array<{ chapterId: string; title: string; requiredDomains: string[]; confirmedDomains: string[]; unconfirmedDomains: string[]; score: number }>;
  unconfirmedDomains: string[];
  remediation: string;
}

export interface DocumentProfileReport {
  type: string;
  dimensions: string[];
  requiredEvidencePolicy: string;
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
  /** 模板化套用专项检测报告（docx 第十类核心降档判定，重难点重度模板化→直接降档） */
  templating?: TenderBidTemplatingReport;
}

export interface DocumentReviewChecklistItem {
  key: string;
  label: string;
  passed: boolean;
  message?: string;
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
  /** A2 语义级模板化复核改进建议（仅风险信号命中时产出） */
  templatingReviewIssues?: string[];
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
  /** V5 P5 无主数值审计报告（M6）：正文数值 ↔ AuthorityIndex 三分类（0 未登记项为验收口径） */
  authorityAudit?: AuthorityAuditReport;
  /** 质量对标：与模板参考库同工程类型基准的对比结果 */
  qualityBenchmark?: QualityBenchmarkResult;
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
  /** P18 自动健康诊断告警（finalize 末尾零 LLM 成本判定，随导出闭环报告归档） */
  healthAlerts?: string[];
  /** P19 修复轮热力图：键为修复轮 id（对齐 LLM_PATCH_REPAIR_ROUNDS/patchGuardStats），值为命中/修复成功/失败计数（跨文档缺陷热力图数据源） */
  repairHeat?: Record<string, { hits: number; repaired: number; failed: number }>;
}

export interface DocumentWorkflowVersion {
  version: string;
  rules: string[];
}

export interface ExportGateResult {
  passed: boolean;
  blockingIssues: ValidationIssue[];
  checklist: Array<{ key: string; label: string; passed: boolean; message?: string }>;
}

export interface RepairStrategy {
  priority: 'high' | 'medium' | 'low';
  title: string;
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

export interface ValidationIssue {
  level: 'error' | 'warning' | 'info';
  message: string;
  source?: string;
  suggestion?: string;
  severity?: 'blocker' | 'warning' | 'suggestion';
  repairability?: 'local_deterministic' | 'llm_repairable' | 'manual_review' | 'not_repair_needed';
  category?: 'structure' | 'table' | 'fact_consistency' | 'evidence_coverage' | 'professional_chain' | 'control_loop' | 'format' | 'style' | 'scope' | 'qingtian_review';
  owner?: 'system' | 'llm' | 'user';
  /** 章节锚点（F2）：校验器已知缺陷所在章节时附带，修复循环定位优先直连，不再依赖消息关键字反查 */
  chapterId?: string;
  /** 小节锚点（F2）：缺陷所在小节标题，用于跨章定位兜底（章节 id 缺失或已变更时） */
  sectionTitle?: string;
  /** P9 issue 快照 provenance：产生检测器身份与全文指纹（重算校验组按 detectorId 无条件剔除旧快照并实时重跑，替代脆弱正则） */
  provenance?: { detectorId: string; fingerprint: string };
}
