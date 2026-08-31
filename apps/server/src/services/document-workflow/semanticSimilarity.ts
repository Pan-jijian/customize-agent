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

// ── 3.3 全局嵌入 LRU 缓存：流程中 ≥7 个构建点（章标题/评分条目/证据文本/复检查询）跨调用重复嵌入，
// 模块级缓存后仅 miss 子集一次批量嵌入。插入序 LRU：Map 迭代序即插入序，命中时 delete+set 移到尾部，
// 容量满删首。Node 单线程 + Map 同步操作，无并发问题；默认容量 2000 约 4MB（768 维 float32 约 3KB/条）。──
const embedCache = new Map<string, number[]>();
let embedCacheHits = 0;
let embedCacheMisses = 0;

function embedCacheEnabled() {
  return process.env.DOCUMENT_EMBED_CACHE !== '0';
}

function embedCacheMaxSize() {
  const size = Number(process.env.DOCUMENT_EMBED_CACHE_SIZE || 2000);
  return Number.isFinite(size) && size > 0 ? size : 2000;
}

/** 单测隔离：清空缓存与计数器（模块级状态跨测试共享，必须显式清理） */
export function clearEmbedCacheForTest() {
  embedCache.clear();
  embedCacheHits = 0;
  embedCacheMisses = 0;
}

/** 命中率统计快照（供诊断报告与验收：命中率 = hits / (hits + misses)） */
export function snapshotEmbedCacheStats() {
  return { embedCacheHits, embedCacheMisses };
}

async function embedBatch(texts: string[], embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<number[][]> {
  const embedded = embedDocuments ? await embedDocuments(texts) : await getLocalSemanticProvider().embedDocuments(texts);
  if (embedded.length !== texts.length) {
    throw new Error(`本地语义模型嵌入数量不一致：期望 ${texts.length} 条，实际 ${embedded.length} 条`);
  }
  return embedded;
}

/** 批量嵌入（带全局 LRU 缓存）：命中直接复用向量，miss 文本去重后一次批量嵌入并回填缓存 */
async function embedWithGlobalCache(texts: string[], embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<number[][]> {
  if (!embedCacheEnabled()) return embedBatch(texts, embedDocuments);
  const vectors = new Array<number[]>(texts.length);
  const missTexts: string[] = [];
  const missIndicesByText = new Map<string, number[]>();
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    const cached = embedCache.get(text);
    if (cached) {
      vectors[index] = cached;
      embedCacheHits += 1;
      // LRU 命中：删除后重插移到尾部，保持插入序淘汰最久未用
      embedCache.delete(text);
      embedCache.set(text, cached);
      continue;
    }
    const indices = missIndicesByText.get(text);
    if (indices) {
      indices.push(index);
    } else {
      missIndicesByText.set(text, [index]);
      missTexts.push(text);
    }
  }
  if (missTexts.length === 0) return vectors;
  const embedded = await embedBatch(missTexts, embedDocuments);
  const maxSize = embedCacheMaxSize();
  for (let missIndex = 0; missIndex < missTexts.length; missIndex += 1) {
    const text = missTexts[missIndex];
    const vector = embedded[missIndex];
    for (const index of missIndicesByText.get(text)!) vectors[index] = vector;
    embedCacheMisses += missIndicesByText.get(text)!.length;
    embedCache.set(text, vector);
    if (embedCache.size > maxSize) {
      const oldest = embedCache.keys().next().value;
      if (oldest !== undefined) embedCache.delete(oldest);
    }
  }
  return vectors;
}

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += left[i] * right[i];
  return sum;
}

/**
 * 构建语义相似度函数：批量嵌入 leftTexts 与 rightTexts（miss 子集一次 pipeline 批量调用，
 * 命中走全局 LRU 缓存），返回闭包内带向量缓存的余弦相似度函数。
 * @param embedDocuments 单测注入的嵌入实现（替代本地模型），生产环境不传
 */
export async function buildSemanticSimilarity(
  leftTexts: string[],
  rightTexts: string[],
  embedDocuments?: (texts: string[]) => Promise<number[][]>,
): Promise<SemanticSimilarityFn> {
  if (leftTexts.length === 0 || rightTexts.length === 0) return () => 0;
  const texts = [...leftTexts, ...rightTexts];
  const vectors = await embedWithGlobalCache(texts, embedDocuments);
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
