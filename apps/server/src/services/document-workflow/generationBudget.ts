/**
 * 全局预算模型：生成前按 章节数 × 目标字数 × 资料量 一次性计算
 * 并发数、证据预算、审查深度与修复轮次预算，策略触发条件集中在此明确化。
 * 纯计算，无 LLM、无 IO。
 */
import { selectDocumentGenerationStrategy } from './rolePipeline';
import { concurrencyForDocumentScale } from './llmClient';
import type { DocumentGenerationStrategy, DocumentTemplate, DocumentTemplateChapter } from './types';

export interface GenerationBudget {
  strategy: DocumentGenerationStrategy;
  /** 章节生成并发数（同批同时生成的章节数） */
  chapterConcurrency: number;
  /** 章节审查/修复流水线并发数（生成与审查重叠时同时审查的章节数） */
  reviewConcurrency: number;
  /** 全局 LLM 并发档位（按文档目标字数自适应，供生成前提升全局信号量上限） */
  llmConcurrency: number;
  /** 每章证据预算下限（字符） */
  evidenceFloorChars: number;
  /** 每章证据预算上限（字符，高风险/深召回时使用） */
  evidenceCeilingChars: number;
  /** Repairer 每章修复轮次兜底上限（动态计算：base 2 + 篇幅/资料稀疏加成；收敛判定优先于预算截断） */
  repairRoundBudget: number;
  /** Repairer 文档级总轮次池：各章按需消耗，收敛快的章节让渡预算给问题多的章节（池耗尽或全体收敛才终止修复） */
  repairPoolBudget: number;
  /** 策略触发原因说明（供进度节点与前端体检报告展示） */
  triggers: string[];
}

/** 按平均章节目标字数确定每章证据预算区间 */
function evidenceBudgetRange(avgChapterTarget: number): { floorChars: number; ceilingChars: number } {
  // round-20 S5/W7 P6-1：证据预算三档放开——证据不足是空话灌水的直接原因，完整信息注入优先；
  // 上限按 env DOCUMENT_EVIDENCE_BUDGET_CEILING 可覆盖（evidencePromptBudgetForTarget 内生效）
  if (avgChapterTarget >= 6000) return { floorChars: 14000, ceilingChars: 52000 };
  if (avgChapterTarget >= 3000) return { floorChars: 11000, ceilingChars: 36000 };
  return { floorChars: 8000, ceilingChars: 24000 };
}

export function buildGenerationBudget(input: {
  template: DocumentTemplate;
  chapters: DocumentTemplateChapter[];
  targetWords: number;
  requirement?: string;
  materialFileCount: number;
  evidenceCount: number;
  hasVeryLargeExplicitChapter: boolean;
  configuredChapterConcurrency: number;
  strategy: DocumentGenerationStrategy;
}): GenerationBudget {
  const chapterCount = Math.max(1, input.chapters.length);
  const avgChapterTargetSafe = input.targetWords > 0 ? Math.round(input.targetWords / chapterCount) : 1200;
  const strategy = input.strategy;
  const triggers: string[] = [];
  // 并发预算：章节生成并发不设档位上限——全部章节同批启动（用户明确端点不会因章节并发限流），
  // 在飞调用总量由全局 LLM 信号量（默认 64，DOCUMENT_LLM_MAX_CONCURRENCY 可覆盖）统一约束；DOCUMENT_CHAPTER_CONCURRENCY 可显式调低
  const sparse = input.materialFileCount < 4 && input.evidenceCount < 6;
  const autoChapterConcurrency = chapterCount;
  const configured = Number.isFinite(input.configuredChapterConcurrency) && input.configuredChapterConcurrency > 0 ? Math.floor(input.configuredChapterConcurrency) : undefined;
  const chapterConcurrency = Math.max(1, Math.min(chapterCount, configured ?? autoChapterConcurrency));
  // 全局 LLM 并发上限：所有文档规模统一（默认 64），供生成开始前设置全局信号量
  const llmConcurrency = concurrencyForDocumentScale(input.targetWords);
  // 审查流水线并发自适应：fast 串行；其余按全局 LLM 并发上限缩放（≥32→5、≥16→3、其余 2），
  // 章节全并发后不再从“上限 − 生成并发”余量扣减（余量会退化到 1），生成+审查共享全局信号量自然调度
  const reviewConcurrency = (() => {
    if (strategy.mode === 'fast') return 1;
    const scaled = llmConcurrency >= 32 ? 5 : llmConcurrency >= 16 ? 3 : 2;
    return Math.max(1, Math.min(scaled, chapterCount));
  })();
  const { floorChars, ceilingChars } = evidenceBudgetRange(avgChapterTargetSafe);
  // 修复轮次预算动态计算（收敛驱动兜底上限）：每章上限 = base 2 + 篇幅加成 + 资料稀疏加成。
  // 问题4收紧：篇幅加成封顶 1（历史 4 万字文档每章 5-6 轮 + 12 章总池 60+ 轮，空转消耗生成时长）；
  // 收敛判定与硬止损（连续 4 轮不降即停）优先于预算截断，预算只做空转兜底。
  // 文档级总池加硬顶：min(每章上限×章数, 2×章数 且 ≥12)——收敛快的章让渡预算，但总量封顶防极端空转
  const repairRoundBudget = (() => {
    if (strategy.repairRoundBudget) return strategy.repairRoundBudget;
    const base = 2;
    const scaleBoost = input.targetWords >= 20000 ? 1 : 0;
    const sparseBoost = sparse ? 1 : 0;
    return Math.max(2, Math.min(4, base + scaleBoost + sparseBoost));
  })();
  const repairPoolBudget = Math.min(repairRoundBudget * chapterCount, Math.max(12, chapterCount * 2));

  // 触发原因记录（进度节点与前端体检报告共用）
  if (strategy.mode === 'strict') {
    triggers.push('strict：风险领域关键词命中' + '（专项/安全/质量/验收/合同/合规等）');
  }
  if (input.targetWords >= 40000) triggers.push('strict：目标篇幅超长（≥4 万字）');
  if (sparse) triggers.push('strict：资料稀疏（资料包文件 <4 且可用证据 <6 条）');
  if (strategy.mode === 'fast') triggers.push('fast：小文档（≤6000 字且 ≤4 章）全局审查降级为 35% 抽检');
  if (strategy.mode === 'longform') triggers.push('longform：长文档（≥3 万字或 ≥8 章）');
  if (strategy.mode === 'balanced') triggers.push('balanced：常规篇幅文档，标准审查深度');
  triggers.push(`全章节并行生成（${chapterConcurrency}/${chapterCount} 章同批），审查流水线 ${reviewConcurrency} 路，全局 LLM 并发档位 ${llmConcurrency}，每章证据预算 ${Math.round(floorChars / 1000)}k-${Math.round(ceilingChars / 1000)}k 字符，修复轮次预算每章 ${repairRoundBudget} 轮（文档级总池 ${repairPoolBudget} 轮，收敛判定优先）`);
  return { strategy, chapterConcurrency, reviewConcurrency, llmConcurrency, evidenceFloorChars: floorChars, evidenceCeilingChars: ceilingChars, repairRoundBudget, repairPoolBudget, triggers };
}

export interface GenerationBudgetPreview {
  mode: DocumentGenerationStrategy['mode'];
  enableGlobalReview: boolean;
  /** fast 模式下全局审查抽检率（1=全量审查） */
  globalReviewSamplingRate: number;
  repairRoundBudget: number;
  chapterConcurrency: number;
  reviewConcurrency: number;
  evidenceFloorChars: number;
  evidenceCeilingChars: number;
  /** 参与估算的目标字数（校验阶段为近似值） */
  targetWords: number;
  chapterCount: number;
  /** 策略触发原因（供前端体检报告展示） */
  triggers: string[];
}

/**
 * U1 生成前体检：运行前校验阶段预估生成策略与预算（目标字数为近似估算）。
 * 供 validateDocumentTemplateRun 调用，注意该模块与 rolePipeline 存在依赖链，
 * 引用方（templateStore）需动态 import 以避免模块环。
 */
export function previewGenerationBudgetForTemplate(input: {
  template: DocumentTemplate;
  chapters: DocumentTemplateChapter[];
  requirement?: string;
  materialFileCount: number;
  evidenceCount: number;
  targetWords?: number;
  hasVeryLargeExplicitChapter?: boolean;
  configuredChapterConcurrency?: number;
}): GenerationBudgetPreview {
  const chapterCount = Math.max(1, input.chapters.length);
  const targetWords = Math.max(0, Math.round(input.targetWords ?? 0));
  const strategy = selectDocumentGenerationStrategy({
    template: input.template,
    targetWords,
    requirement: input.requirement,
    materialFileCount: input.materialFileCount,
    evidenceCount: input.evidenceCount,
  });
  const budget = buildGenerationBudget({
    template: input.template,
    chapters: input.chapters,
    targetWords,
    requirement: input.requirement,
    materialFileCount: input.materialFileCount,
    evidenceCount: input.evidenceCount,
    hasVeryLargeExplicitChapter: input.hasVeryLargeExplicitChapter ?? false,
    configuredChapterConcurrency: input.configuredChapterConcurrency ?? 0,
    strategy,
  });
  return {
    mode: strategy.mode,
    enableGlobalReview: strategy.enableGlobalReview,
    globalReviewSamplingRate: strategy.globalReviewSamplingRate ?? 1,
    repairRoundBudget: budget.repairRoundBudget,
    chapterConcurrency: budget.chapterConcurrency,
    reviewConcurrency: budget.reviewConcurrency,
    evidenceFloorChars: budget.evidenceFloorChars,
    evidenceCeilingChars: budget.evidenceCeilingChars,
    targetWords,
    chapterCount,
    triggers: budget.triggers,
  };
}
