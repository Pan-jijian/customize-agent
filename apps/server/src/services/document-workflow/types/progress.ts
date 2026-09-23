/**
 * types/progress：执行阶段/诊断/资产生成策略（P5 类型切割，逐字机械搬移自 types.ts）。
 * 零内部依赖；validation/core 经 import type 引用。
 */

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

export interface DocumentExecutionStage {
  type: 'role_binding' | 'knowledge_retrieval' | 'file_understanding' | 'fact_extraction' | 'chapter_generation' | 'llm_review' | 'validation' | 'reference';
  roleId: string;
  promptId?: string;
  /** 4.55.27：`partial` = 修复轮**有净下降但未清零**（收敛中，非异常）；
   *  `failed` 收敛为**零净下降 / 回滚 / 定位失败**（真异常，需排查）。
   *  原实现把两者都标 failed，造成「修复节点第一次就异常」的观感，并把真正的零进展淹没。 */
  status: 'running' | 'success' | 'skipped' | 'failed' | 'partial';
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

export interface DocumentGenerationDiagnostics {
  strategy: DocumentGenerationStrategy;
  metrics: DocumentPerformanceMetric[];
    llm: { calls: number; failures: number; maxActive: number; lastError?: string; lastInfo?: string; retries: number; failureStreak?: number; schemaFailures?: number; thinkingWarning?: string; promptCacheHitTokens?: number; promptCacheMissTokens?: number; reasoningTokens?: number; inputTokens?: number; outputTokens?: number; inputChars?: number; patchGuardHits?: number; patchGuardRejects?: number; layerChars?: { l0: number; l1: number; l2: number; l3: number }; unlayeredChars?: number; emptyStormWaits?: number;
    /** 4.1 per-调用分量观测：按 prefixKey 分组累计 次数/输入字符/L3 字符/缓存命中/未命中 token（无 prefixKey 归入 '(none)'），进度页后台诊断展示 Top5 输入大头；s1-slim 增 schemaFailures：schema 校验失败按调用类型归因（仅失败时出现） */
    callBreakdown?: Record<string, { calls: number; inputChars: number; l3Chars: number; cacheHitTokens: number; cacheMissTokens: number; schemaFailures?: number }>;
    /** P25 patchGuard 按修复轮分组统计：键为修复轮 id（对齐 LLM_PATCH_REPAIR_ROUNDS），值为该轮 hits/rejects 计数（P12 扩展 rollbacks：withPatchRollback 回滚计数按轮分组） */
    patchGuardStats?: Record<string, { hits: number; rejects: number; rollbacks?: number }> };
    semantic: { embedCacheHits: number; embedCacheMisses: number };
  evidence: { raw: number; used: number; filteredNoise: number; budgetDropped: number; avgNoiseScore: number; avgFactDensity: number; searchQueries: number; searchMs: number; contextChars: number; t0Chars: number; t1Chars: number; t2Lines: number; omittedChars: number;
    /** P2-B 证据双通道覆盖度观测（可选字段：4.41 采集→4.42 收敛决策依据）：预分配意图证据（source=project-intelligence）注入/最终留存条数；运行时召回（KB keyword/vector/hybrid + 深召回 deep-retrieval/required-fact-evidence）注入/最终留存条数——实机数据用于验证「删除运行时召回是否掉质量」 */
    intentEvidenceInjected?: number;
    intentEvidenceUsed?: number;
    retrievedEvidenceInjected?: number;
    /**
     * G 线 降级治理：深召回/补充召回**失败次数**（区别于「命中 0 条」）。
     * 原实现用 `.catch(() => [])` 把调用异常压成空数组，UI 上显示「深度召回完成：命中 0 条」——
     * 基础设施故障与「资料里确实没有」同形。本字段让两者可分。
     */
    retrievalFailures?: number;
    retrievedEvidenceUsed?: number;
    /** 模板 pinned 证据整文件注入未命中计数（包内相对路径解析后 KB 无此文件）：配置漂移可见化，不再静默丢弃 */
    pinnedEvidenceMissed?: number };
  /**
   * 4.60 I1 块级篇幅账（**度量先行**）：每个块的「目标 / 实际 / 轮次 / 是否首轮通过 / 失败类别」。
   *
   * ## 为什么必须采集（4.59 的一次方法论教训）
   *
   * 4.59 曾试图用日志里的「X 字 vs 块目标 Y 字」定标块篇幅显示系数，**但那是失败样本**——
   * 只有被判欠产/超产的块才留该日志行，**干净通过的块不留痕**。据此算出的「中位数 0.70」
   * 会被失败样本拉低，用它定标等于自我实现（把门线调到恰好一半块过不了）。
   *
   * **校准块目标必须用全部块的无偏分布**，故本账无条件记录每一个块（含首轮直通者）。
   */
  blockLedger?: Array<{ chapter: string; block: string; target: number; actual: number; attempt: number; passed: boolean; firstAttempt?: boolean; failureKinds?: string[] }>;
  quality: { blockingCount: number; importantCount: number; minorCount: number; repairedCount: number };
  /** 1.1 事实净化门计数（本地事实池出口脏值截断/丢弃/编号回源补全，进度页后台诊断展示） */
  factSanitize?: { truncated: number; dropped: number; repaired: number };
}

export interface DocumentGenerationStrategy {
  mode: 'fast' | 'balanced' | 'longform' | 'strict';
  enableChapterReview: boolean;
  enableGlobalReview: boolean;
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
