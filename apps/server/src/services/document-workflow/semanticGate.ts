import { getLocalSemanticProvider, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';

/**
 * 语义判定统一入口（阶段五：正则词表模拟语义判断全域治理）。
 *
 * 治理统一原则：词面/正则只做召回（短路优化），语义模型（bge 余弦 ≥ 阈值）做判定——
 * 与 tenderBidChecks.ts FILLER_SEMANTIC_QUERIES、factsModel.ts PROCEDURAL_VALUE_PROTOTYPES
 * 两个既有正确模式同口径。全模块"文本是否属于某语义类"的判定一律经本入口构建 gate，
 * 禁止各处自行实现嵌入逻辑。
 *
 * 与 buildSemanticSimilarity 的分工：后者适合"判定对象构建时已知"的批量比对（预嵌入缓存），
 * 本入口面向"判定对象是构建时未知文本"（LLM 生成正文、运行时召回内容）——构建时只嵌入原型，
 * 判定时对输入批量嵌入后现场计算余弦，避免预嵌入缓存未命中恒 0 的静默漏判。
 * 语义模型在部署环境常驻可用：提供者构造失败直接抛出，无"语义不可用跳过判定"的降级分支。
 */

export interface SemanticGateOptions {
  /** 正例语义原型：文本与任一原型余弦 ≥ threshold 判定命中 */
  prototypes: string[];
  /** 负例语义原型（放行保护）：正例最高分必须严格大于全部负例分才判定命中（如"劳动纪律"合法句 vs 投标纪律原型） */
  negativePrototypes?: string[];
  /** 判定阈值（默认 SEMANTIC_COVERAGE_THRESHOLD） */
  threshold?: number;
  /** 词面召回（短路优化）：仅命中词面的文本进入语义判定，未命中直接 false；不传则全部文本语义判定 */
  lexicalHints?: RegExp;
  /** 单测注入的嵌入实现（替代本地模型），生产环境不传 */
  embedDocuments?: (texts: string[]) => Promise<number[][]>;
}

/** 语义判定函数：批量输入 → 逐项布尔结果（与输入顺序一致） */
export type SemanticGateFn = (texts: string[]) => Promise<boolean[]>;

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += left[i] * right[i];
  return sum;
}

/**
 * 构建语义判定 gate：构建时一次性嵌入全部原型（正例+负例），判定时对输入批量嵌入后计算余弦。
 * 每个升级点配置一个 gate 实例（章节/文档循环复用），避免每句一次 pipeline 调用。
 */
export async function buildSemanticGate(options: SemanticGateOptions): Promise<SemanticGateFn> {
  // 空原型恒 false 承接（与输入等长，保证调用方逐项对齐），无"语义不可用跳过判定"的降级分支
  if (options.prototypes.length === 0) return async (texts: string[]) => texts.map(() => false);
  const threshold = options.threshold ?? SEMANTIC_COVERAGE_THRESHOLD;
  const negatives = options.negativePrototypes ?? [];
  const prototypes = [...options.prototypes, ...negatives];
  const positiveCount = options.prototypes.length;
  const provider = options.embedDocuments ? null : getLocalSemanticProvider();
  const prototypeVectors = options.embedDocuments ? await options.embedDocuments(prototypes) : await provider!.embedDocuments(prototypes);
  if (prototypeVectors.length !== prototypes.length) {
    throw new Error(`本地语义模型嵌入数量不一致：期望 ${prototypes.length} 条，实际 ${prototypeVectors.length} 条`);
  }
  return async (texts: string[]): Promise<boolean[]> => {
    if (texts.length === 0) return [];
    const result = texts.map(() => false);
    // 词面召回短路：未命中词面的文本不进入语义判定（候选为空则整体恒 false，无降级分支）
    const indices = texts
      .map((text, index) => (options.lexicalHints && !options.lexicalHints.test(text) ? -1 : index))
      .filter(index => index >= 0);
    if (indices.length === 0) return result;
    const candidates = indices.map(index => texts[index]);
    const vectors = options.embedDocuments ? await options.embedDocuments(candidates) : await provider!.embedDocuments(candidates);
    indices.forEach((textIndex, vectorIndex) => {
      const vector = vectors[vectorIndex];
      if (!vector) return;
      const positiveScore = Math.max(...prototypeVectors.slice(0, positiveCount).map(prototype => dot(vector, prototype)));
      const negativeScore = negatives.length ? Math.max(...prototypeVectors.slice(positiveCount).map(prototype => dot(vector, prototype))) : 0;
      if (positiveScore >= threshold && (negatives.length === 0 || positiveScore > negativeScore)) result[textIndex] = true;
    });
    return result;
  };
}
