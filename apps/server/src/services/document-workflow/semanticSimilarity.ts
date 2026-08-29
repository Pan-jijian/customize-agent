import { LocalTransformersEmbeddingProvider } from '@customize-agent/knowledge';

/**
 * 本地语义相似度工具：把"文本 ↔ 文本"的相关性判断从正则/词面统计迁移到
 * 本地 bge-small-zh-v1.5 嵌入的余弦相似度（向量已 normalize，点积即余弦）。
 *
 * 使用边界：仅用于短文本语义承接判定（条目标题 ↔ 大纲章节、章节查询 ↔ 证据切片），
 * 长正文语义仍由 LLM 完成。
 * 语义模型在部署环境常驻可用（本地 ONNX 推理，无网络依赖）：提供者构造失败直接抛出，
 * 全链路不保留"不可用降级"死代码——判定语义由 bge 全权负责，失败即暴露缺陷而非静默跳过。
 */

let sharedProvider: LocalTransformersEmbeddingProvider | null = null;

/** 进程内共享本地语义模型实例（懒加载，复用 Transformers.js pipeline） */
export function getLocalSemanticProvider(): LocalTransformersEmbeddingProvider {
  if (!sharedProvider) sharedProvider = new LocalTransformersEmbeddingProvider({});
  return sharedProvider;
}

/** 语义相似度函数：leftText/rightText → [0,1] 余弦相似度（向量缓存在闭包内，同文本不重复嵌入） */
export type SemanticSimilarityFn = (leftText: string, rightText: string) => number;

/** 语义承接判定阈值：余弦 ≥0.6 视为"语义上已承接" */
export const SEMANTIC_COVERAGE_THRESHOLD = 0.6;

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += left[i] * right[i];
  return sum;
}

/**
 * 构建语义相似度函数：批量嵌入 leftTexts 与 rightTexts（一次 pipeline 批量调用），
 * 返回闭包内带向量缓存的余弦相似度函数。
 * @param embedDocuments 单测注入的嵌入实现（替代本地模型），生产环境不传
 */
export async function buildSemanticSimilarity(
  leftTexts: string[],
  rightTexts: string[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<SemanticSimilarityFn> {
  if (leftTexts.length === 0 || rightTexts.length === 0) return () => 0;
  const texts = [...leftTexts, ...rightTexts];
  // 注入 embedDocuments 时不依赖本地模型实例（单测/替换实现），否则获取共享 bge-small 实例
  const provider = embedDocuments ? null : getLocalSemanticProvider();
  const vectors = embedDocuments ? await embedDocuments(texts) : await provider!.embedDocuments(texts);
  if (vectors.length !== texts.length) {
    throw new Error(`本地语义模型嵌入数量不一致：期望 ${texts.length} 条，实际 ${vectors.length} 条`);
  }
  const cache = new Map<string, number[]>();
  for (let i = 0; i < texts.length; i++) {
    if (!cache.has(texts[i])) cache.set(texts[i], vectors[i]);
  }
  return (leftText: string, rightText: string) => {
    const leftVector = cache.get(leftText);
    const rightVector = cache.get(rightText);
    if (!leftVector || !rightVector) return 0;
    return dot(leftVector, rightVector);
  };
}
