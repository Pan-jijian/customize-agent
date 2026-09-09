/**
 * DOCUMENT_* 环境变量注册表（治理收敛 · 第 1 期）：
 * - removed：验证已完成、行为已固化默认，读取点已删除（保留登记用于审计与防复活）
 * - merged ：并入 generationBudget.tuningProfile，统一由 DOCUMENT_TUNING_PROFILE（JSON）覆盖
 * - managed：保留注册的调优/调试开关（默认值 + 用途说明）
 * 配套单测 envRegistry.leak.test.ts：断言源码中 process.env.DOCUMENT_* 全部登记，防新开关逃逸。
 */

export type DocumentEnvStatus = 'removed' | 'merged' | 'managed';

export interface DocumentEnvEntry {
  name: string;
  status: DocumentEnvStatus;
  default?: string;
  note: string;
}

export const DOCUMENT_ENV_REGISTRY: readonly DocumentEnvEntry[] = [
  // ── A 类：已固化默认行为（读取点已删除，环境变量残留将被忽略并告警）──
  { name: 'DOCUMENT_TWO_STEP_GENERATION', status: 'removed', note: '两步生成恒开；大纲失败退化单步保留为代码内安全路径' },
  { name: 'DOCUMENT_TWO_STEP_SLIM', status: 'removed', note: '两步法第二步证据预算 0.6× 瘦身恒开' },
  { name: 'DOCUMENT_CONTEXT_SLIM_CHAPTER', status: 'removed', note: '章级 scoped 上下文瘦身恒开' },
  { name: 'DOCUMENT_REQUIREMENT_CALIBRATION', status: 'removed', note: '大纲要求校准恒开（无评分项要求时天然跳过）' },
  { name: 'DOCUMENT_CROSS_CHAPTER_DEDUP', status: 'removed', note: '跨章完全重复句/语义重复检测与 strip 恒开' },
  { name: 'DOCUMENT_SECTION_FIRST_GENERATION', status: 'removed', note: '小节级成稿自动判定恒开（小节 2-8、非复合标题）' },
  { name: 'DOCUMENT_SECTION_FIRST_MAX_SECTIONS', status: 'removed', note: '小节级成稿小节数上限固化为常量 8' },
  { name: 'DOCUMENT_SECTION_PLANNING_MODE', status: 'removed', note: 'LLM 规划常态化恒开（template-locked 回退删除）' },
  { name: 'DOCUMENT_UNIFIED_SYSTEM_PREFIX', status: 'removed', note: 'L0 + FORMAL_WRITING_RULES 统一公共前缀恒开' },
  { name: 'DOCUMENT_L0_SYSTEM_PREFIX', status: 'removed', note: 'L0 统一公共段恒开（legacy 前缀回退删除）' },
  { name: 'DOCUMENT_TITLE_ALIGNMENT_CHECK', status: 'removed', note: '跨章同名小节标题检测恒开' },
  { name: 'DOCUMENT_GENERATION_RERANKER', status: 'removed', note: 'cross-encoder 语义重排（worker 线程）恒开' },
  { name: 'DOCUMENT_QUERY_EXPANSION_SEMANTIC', status: 'removed', note: '语义查询扩展恒开（正则兜底仍保留）' },
  { name: 'DOCUMENT_T0_WHITELIST', status: 'removed', note: 'T0 白名单行瘦身恒开（8000 字符硬顶保留）' },
  { name: 'DOCUMENT_SECTION_QUANT_PLAN', status: 'removed', note: '量化参数落位清单注入恒开' },
  { name: 'DOCUMENT_FACT_SANITIZE', status: 'removed', note: '事实净化门恒开' },
  { name: 'DOCUMENT_TABLE_PARSE_CACHE', status: 'removed', note: '工作簿磁盘解析进程内缓存恒开' },
  { name: 'DOCUMENT_SECTION_SUPPLEMENT_ATTEMPTS', status: 'removed', note: '补写尝试上限固化为常量 2（1~3 收敛）' },
  { name: 'DOCUMENT_BLOCK_MAX_ATTEMPTS', status: 'removed', note: '块级写作/反馈重试上限固化为常量 2' },
  // ── C 类：并入 DOCUMENT_TUNING_PROFILE（JSON 单入口覆盖）──
  { name: 'DOCUMENT_CHAPTER_CONCURRENCY', status: 'merged', note: '→ tuningProfile.chapterConcurrency' },
  { name: 'DOCUMENT_SECTION_CONCURRENCY', status: 'merged', note: '→ tuningProfile.sectionConcurrency' },
  { name: 'DOCUMENT_SECTION_GROUP_CONCURRENCY', status: 'merged', note: '→ tuningProfile.sectionGroupConcurrency' },
  { name: 'DOCUMENT_SECTION_GROUP_SIZE', status: 'merged', note: '→ tuningProfile.sectionGroupSize' },
  { name: 'DOCUMENT_SECTION_GROUP_TASK_CONCURRENCY', status: 'merged', note: '→ tuningProfile.sectionGroupTaskConcurrency' },
  { name: 'DOCUMENT_PLANNED_BLOCK_CONCURRENCY', status: 'merged', note: '→ tuningProfile.plannedBlockConcurrency' },
  { name: 'DOCUMENT_TABLE_FIX_CONCURRENCY', status: 'merged', note: '→ tuningProfile.tableFixConcurrency' },
  { name: 'DOCUMENT_LLM_MAX_CONCURRENCY', status: 'merged', note: '→ tuningProfile.llmMaxConcurrency' },
  { name: 'DOCUMENT_WRITING_TASK_CONCURRENCY', status: 'merged', note: '→ tuningProfile.writingTaskConcurrency' },
  { name: 'DOCUMENT_PROJECT_GRAPH_DOMAIN_CONCURRENCY', status: 'merged', note: '→ tuningProfile.projectGraphDomainConcurrency' },
  { name: 'DOCUMENT_WRITING_TASK_MAX_WORDS', status: 'merged', note: '→ tuningProfile.writingTaskMaxWords' },
  { name: 'DOCUMENT_BLOCK_EVIDENCE_CHARS', status: 'merged', note: '→ tuningProfile.blockEvidenceChars' },
  { name: 'DOCUMENT_CHAPTER_POOL_CHARS', status: 'merged', note: '→ tuningProfile.chapterPoolChars' },
  { name: 'DOCUMENT_EVIDENCE_BUDGET_RATIO', status: 'merged', note: '→ tuningProfile.evidenceBudgetRatio' },
  { name: 'DOCUMENT_EVIDENCE_BUDGET_CEILING', status: 'merged', note: '→ tuningProfile.evidenceBudgetCeiling' },
  { name: 'DOCUMENT_EVIDENCE_CATALOG_MAX_LINES', status: 'merged', note: '→ tuningProfile.evidenceCatalogMaxLines' },
  { name: 'DOCUMENT_FACT_COVERAGE_CAP', status: 'merged', note: '→ tuningProfile.factCoverageCap' },
  { name: 'DOCUMENT_FACT_EXTRACTION_MAX_CHARS', status: 'merged', note: '→ tuningProfile.factExtractionMaxChars' },
  { name: 'DOCUMENT_FACT_EXTRACTION_MAX_ITEMS', status: 'merged', note: '→ tuningProfile.factExtractionMaxItems' },
  { name: 'DOCUMENT_OUTLINE_EVIDENCE_CHARS', status: 'merged', note: '→ tuningProfile.outlineEvidenceChars' },
  { name: 'DOCUMENT_PERSIST_EVIDENCE_MAX_ITEMS', status: 'merged', note: '→ tuningProfile.persistEvidenceMaxItems' },
  { name: 'DOCUMENT_PERSIST_EVIDENCE_ITEM_CHARS', status: 'merged', note: '→ tuningProfile.persistEvidenceItemChars' },
  { name: 'DOCUMENT_REPAIR_EVIDENCE_CHARS', status: 'merged', note: '→ tuningProfile.repairEvidenceChars' },
  // ── B 类：保留注册的调优/调试开关 ──
  { name: 'DOCUMENT_ABANDONED_RECORD_STALE_MS', status: 'managed', default: '86400000', note: '废弃任务记录陈旧阈值' },
  { name: 'DOCUMENT_RECENT_UPDATE_GRACE_MS', status: 'managed', default: '60000', note: '任务最近更新宽限期' },
  { name: 'DOCUMENT_MAX_CONCURRENT_GENERATIONS', status: 'managed', default: '2', note: '全局并发生成上限' },
  { name: 'DOCUMENT_PROGRESS_SAVE_INTERVAL_MS', status: 'managed', default: '5000', note: '进度落盘节流间隔' },
  { name: 'DOCUMENT_PROGRESS_HEARTBEAT_SAVE_INTERVAL_MS', status: 'managed', default: '60000', note: '心跳落盘节流间隔' },
  { name: 'DOCUMENT_GENERATION_HEARTBEAT_MS', status: 'managed', default: '30000', note: '生成心跳周期' },
  { name: 'DOCUMENT_EMBED_CACHE', status: 'managed', default: '1', note: 'bge 嵌入全局 LRU 缓存开关' },
  { name: 'DOCUMENT_EMBED_CACHE_SIZE', status: 'managed', default: '40000', note: 'bge 嵌入缓存容量（检索侧/报告侧默认口径 2000/40000，均为展示口径）' },
  { name: 'DOCUMENT_EXTRACTION_CACHE', status: 'managed', default: '1', note: '事实提取缓存开关' },
  { name: 'DOCUMENT_LLM_RETRY_BACKOFF', status: 'managed', default: '1', note: 'LLM 过载退避开关' },
  { name: 'DOCUMENT_PREFIX_WARMUP', status: 'managed', default: '1', note: 'prefix cache 预热开关' },
  { name: 'DOCUMENT_PREFIX_SCHEDULE_WINDOW_MS', status: 'managed', default: '300000', note: 'prefix 预热调度窗口' },
  { name: 'DOCUMENT_GLOBAL_CONSISTENCY_REVIEW', status: 'managed', default: 'auto', note: '全局一致性审查模式（0 关/1 强制/auto 按 strict 判定）' },
  { name: 'DOCUMENT_QINGTIAN_REVIEW_ROUNDS', status: 'managed', default: '3', note: '全维度评审轮次上限' },
  { name: 'DOCUMENT_QINGTIAN_PATCH_GUARD', status: 'managed', default: 'observe', note: 'patchGuard 模式（observe/enforce），灰度完成后固化' },
  { name: 'DOCUMENT_CONSISTENCY_SAMPLE_LIMIT', status: 'managed', default: '0', note: '数据一致性复核抽样上限（0=全量）' },
  { name: 'DOCUMENT_MAX_QUERIES_PER_CHAPTER', status: 'managed', default: '12', note: '单章主检索查询数上限' },
  { name: 'DOCUMENT_SEMANTIC_TOP_CANDIDATES', status: 'managed', default: '0', note: '语义召回 Top 候选数（0=自动）' },
  { name: 'DOCUMENT_TEMPLATE_VALIDATION_CACHE_TTL_MS', status: 'managed', default: '30000', note: '模板运行验证缓存 TTL' },
  { name: 'DOCUMENT_REFERENCE_SUGGEST_MIN_SAMPLES', status: 'managed', default: '2', note: '参考建议最少样例数' },
  { name: 'DOCUMENT_WRITING_CONSTRAINTS_EVOLUTION', status: 'managed', default: '1', note: '写作硬约束自进化开关（P19，默认开启；历史缺陷热力图规避提醒注入 L1 可变段末尾，=0 关闭）' },
];

/**
 * 启动期/调用期告警：status 非 managed 的环境变量残留设置将被忽略——removed 提示行为已固化，
 * merged 提示改用 DOCUMENT_TUNING_PROFILE。防旧配置残留造成「以为已生效」的误导。
 */
export function warnDeprecatedDocumentEnv(): void {
  if (process.env.NODE_ENV === 'test') return;
  for (const entry of DOCUMENT_ENV_REGISTRY) {
    if (entry.status === 'managed') continue;
    if (process.env[entry.name] !== undefined) {
      if (entry.status === 'removed') {
        console.warn(`[envRegistry] ${entry.name} 已废弃（行为已固化默认），当前设置将被忽略。`);
      } else {
        console.warn(`[envRegistry] ${entry.name} 已并入 DOCUMENT_TUNING_PROFILE，当前设置将被忽略，请改用 ${entry.note}。`);
      }
    }
  }
}
