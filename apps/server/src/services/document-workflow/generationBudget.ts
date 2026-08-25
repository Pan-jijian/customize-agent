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
  /** Repairer 修复轮次预算上限（P3：超过后转标记问题+门禁阻断） */
  repairRoundBudget: number;
  /** 策略触发原因说明（供进度节点与前端体检报告展示） */
  triggers: string[];
}

/** 按平均章节目标字数确定每章证据预算区间 */
function evidenceBudgetRange(avgChapterTarget: number): { floorChars: number; ceilingChars: number } {
  if (avgChapterTarget >= 6000) return { floorChars: 7000, ceilingChars: 26000 };
  if (avgChapterTarget >= 3000) return { floorChars: 6000, ceilingChars: 18000 };
  return { floorChars: 4000, ceilingChars: 12000 };
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
  // 并发预算：长章保守、短章提速；资料稀疏保守。
  // 超大显式小节章经规划驱动管线（Planner→块级并发写手）后调用数从数十次降到 10 次左右，
  // 不再需要独占槽位压到 2，放宽到 3 允许大章与中小章并行（中小章先完成先入审查流水线，消除长尾）
  const hasVeryLargeExplicitChapter = input.hasVeryLargeExplicitChapter;
  const sparse = input.materialFileCount < 4 && input.evidenceCount < 6;
  const autoChapterConcurrency = (() => {
    if (chapterCount <= 1) return 1;
    if (hasVeryLargeExplicitChapter) return Math.min(3, chapterCount);
    if (sparse) return Math.min(2, chapterCount);
    if (avgChapterTargetSafe >= 9000) return 2;
    if (avgChapterTargetSafe >= 6500) return Math.min(3, chapterCount);
    return Math.min(4, chapterCount);
  })();
  const configured = Number.isFinite(input.configuredChapterConcurrency) && input.configuredChapterConcurrency > 0 ? Math.floor(input.configuredChapterConcurrency) : undefined;
  const chapterConcurrency = Math.max(1, Math.min(chapterCount, configured ?? autoChapterConcurrency));
  // 全局 LLM 并发档位：按文档目标字数自适应（8/16/24/32），供生成开始前提升全局信号量
  const llmConcurrency = concurrencyForDocumentScale(input.targetWords);
  // 审查流水线并发自适应：fast 串行；其余按全局 LLM 并发档位缩放（8→2、16→3、24→4、32→5），
  // 同时受「章节数」与「全局档位 − 生成并发」余量约束——长文档积压用更多路数消化，
  // 但生成+审查在飞调用总数始终低于全局信号量上限，不与章节生成争抢模型
  const reviewConcurrency = (() => {
    if (strategy.mode === 'fast') return 1;
    const scaled = llmConcurrency >= 32 ? 5 : llmConcurrency >= 24 ? 4 : llmConcurrency >= 16 ? 3 : 2;
    const headroom = Math.max(1, llmConcurrency - chapterConcurrency);
    return Math.max(1, Math.min(scaled, chapterCount, headroom));
  })();
  const { floorChars, ceilingChars } = evidenceBudgetRange(avgChapterTargetSafe);
  const repairRoundBudget = strategy.repairRoundBudget ?? 3;

  // 触发原因记录（进度节点与前端体检报告共用）
  if (strategy.mode === 'strict') {
    triggers.push('strict：风险领域关键词命中' + '（专项/安全/质量/验收/合同/合规等）');
  }
  if (input.targetWords >= 40000) triggers.push('strict：目标篇幅超长（≥4 万字）');
  if (sparse) triggers.push('strict：资料稀疏（资料包文件 <4 且可用证据 <6 条）');
  if (strategy.mode === 'fast') triggers.push('fast：小文档（≤6000 字且 ≤4 章）全局审查降级为 35% 抽检');
  if (strategy.mode === 'longform') triggers.push('longform：长文档（≥3 万字或 ≥8 章）');
  if (strategy.mode === 'balanced') triggers.push('balanced：常规篇幅文档，标准审查深度');
  triggers.push(`章节并发 ${chapterConcurrency}/${chapterCount}，审查流水线并发 ${reviewConcurrency}，全局 LLM 并发 ${llmConcurrency}，每章证据预算 ${Math.round(floorChars / 1000)}k-${Math.round(ceilingChars / 1000)}k 字符，修复轮次预算 ${repairRoundBudget}`);
  return { strategy, chapterConcurrency, reviewConcurrency, llmConcurrency, evidenceFloorChars: floorChars, evidenceCeilingChars: ceilingChars, repairRoundBudget, triggers };
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
