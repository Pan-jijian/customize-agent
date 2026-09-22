/**
 * 真实语义模型在 vitest 下的可运行替身（.manual 诊断专用）。
 *
 * 生产实现（packages/knowledge `LocalTransformersEmbeddingProvider`）用 `new Function('s','return import(s)')`
 * 做动态导入——vitest 的 vm 运行时不提供 dynamic-import 回调，该写法在测试环境恒抛
 * 「A dynamic import callback was not specified」。本替身用 vitest 自己编译的静态 `import()` 加载同一个
 * `@huggingface/transformers`，**同模型、同 dtype、同归一化口径**，只替换载入方式，
 * 使离线复算与生产评分同源可比。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type FeatureExtractionPipeline = (texts: string[], options: Record<string, unknown>) => Promise<unknown>;

/** transformers 只装在 packages/knowledge（pnpm 不提升），Vite 解析不到裸包名 —— 按包内 exports 直取文件 */
const TRANSFORMERS_ENTRY = path.resolve(
  process.cwd(), 'packages', 'knowledge', 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs',
);

function modelDir(): string {
  if (process.env.CUSTOMIZE_BGE_MODEL_PATH) return process.env.CUSTOMIZE_BGE_MODEL_PATH;
  return path.resolve(process.cwd(), 'packages', 'knowledge', 'models', 'bge-small-zh-v1.5');
}

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const mod = await import(/* @vite-ignore */ pathToFileURL(TRANSFORMERS_ENTRY).href);
      const env = (mod as { env?: { allowRemoteModels?: boolean; allowLocalModels?: boolean; localModelPath?: string } }).env;
      const dir = modelDir();
      if (env) {
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.localModelPath = path.dirname(dir);
      }
      return (await mod.pipeline('feature-extraction', dir, { dtype: 'q8' })) as unknown as FeatureExtractionPipeline;
    })();
  }
  return pipelinePromise;
}

function toVectors(output: unknown, count: number): number[][] {
  const tensor = output as { dims?: number[]; data?: ArrayLike<number> };
  const dims = tensor.dims ?? [];
  const data = Array.from(tensor.data ?? [], Number);
  const width = dims.length === 3 ? (dims[2] ?? 0) : (dims[1] ?? 0);
  const rows = dims.length === 3 ? (dims[0] ?? count) : count;
  const vectors: number[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const vector = new Array<number>(width).fill(0);
    const tokens = dims.length === 3 ? (dims[1] ?? 1) : 1;
    for (let token = 0; token < tokens; token += 1) {
      const offset = (row * tokens + token) * width;
      for (let i = 0; i < width; i += 1) vector[i] = (vector[i] ?? 0) + (data[offset + i] ?? 0);
    }
    // 与生产实现同口径：多 token 取均值后归一（向量已 normalize 则点积即余弦）
    if (tokens > 1) for (let i = 0; i < width; i += 1) vector[i] = (vector[i] ?? 0) / tokens;
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    vectors.push(vector.map(value => value / norm));
  }
  return vectors;
}

export class RealLocalEmbeddingProvider {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipeline = await getPipeline();
    const output = await pipeline(texts, { pooling: 'mean', normalize: true });
    return toVectors(output, texts.length);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedDocuments([text]);
    return vector ?? [];
  }
}
