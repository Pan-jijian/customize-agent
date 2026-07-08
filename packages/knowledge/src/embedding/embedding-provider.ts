import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Embedding Provider 接口，负责将文本转换为向量 */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

/** 基于哈希的本地 Embedding Provider（无需模型，使用哈希算法生成特征向量） */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'hash-embedding-local';

  constructor(readonly dimensions = 384) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.embed(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  private embed(text: string): number[] {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const tokens = this.tokenize(text);

    for (const token of tokens) {
      const hash = crypto.createHash('sha256').update(token).digest();
      const index = hash.readUInt32BE(0) % this.dimensions;
      const sign = hash.readUInt8(4) % 2 === 0 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign;
    }

    return this.normalize(vector);
  }

  private tokenize(text: string): string[] {
    const normalized = text.toLowerCase().normalize('NFKC');
    const tokens = normalized.match(/[\p{Script=Han}]{1,4}|[\p{Letter}\p{Number}_-]+/gu) ?? [];
    const grams: string[] = [];
    for (const token of tokens) {
      grams.push(token);
      if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 1) {
        for (let i = 0; i < token.length - 1; i++) grams.push(token.slice(i, i + 2));
        for (let i = 0; i < token.length - 2; i++) grams.push(token.slice(i, i + 3));
      }
    }
    return grams.filter(Boolean);
  }

  private normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) return vector;
    return vector.map(value => value / norm);
  }
}

export interface OpenAICompatibleEmbeddingOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  dimensions?: number;
}

/** OpenAI 兼容的 Embedding Provider，支持任何兼容 OpenAI API 的嵌入服务 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: OpenAICompatibleEmbeddingOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions ?? 1024;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.embed([text]))[0] ?? [];
  }

  private async embed(input: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input }),
    });
    if (!response.ok) throw new Error(`Embedding request failed: HTTP ${response.status} ${await response.text()}`);
    const payload = await response.json() as { data?: Array<{ embedding?: number[] }> };
    return (payload.data ?? []).map(item => item.embedding ?? []);
  }
}

export interface LocalTransformersEmbeddingOptions {
  model?: string;
  dimensions?: number;
  modelPath?: string;
}

type FeatureExtractionPipeline = (input: string | string[], options?: Record<string, unknown>) => Promise<unknown>;

function resolveBundledBgeModelPath(): string | undefined {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CUSTOMIZE_BGE_MODEL_PATH,
    process.env.KB_BGE_MODEL_PATH,
    path.resolve(process.cwd(), 'models', 'bge-small-zh-v1.5'),
    path.resolve(process.cwd(), 'packages', 'knowledge', 'models', 'bge-small-zh-v1.5'),
    path.resolve(currentDir, '..', '..', 'models', 'bge-small-zh-v1.5'),
  ].filter(Boolean) as string[];
  return candidates.find(candidate => fs.existsSync(path.join(candidate, 'config.json')) && fs.existsSync(path.join(candidate, 'tokenizer.json')));
}

/** 本地 Transformers.js 模型 Embedding Provider，使用 BGE 小模型生成向量 */
export class LocalTransformersEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly modelPath?: string;
  private static pipelines = new Map<string, Promise<FeatureExtractionPipeline>>();

  constructor(options: LocalTransformersEmbeddingOptions = {}) {
    this.model = options.model?.trim() || 'BAAI/bge-small-zh-v1.5';
    this.dimensions = options.dimensions ?? 512;
    this.modelPath = options.modelPath || resolveBundledBgeModelPath();
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.embed([text]))[0] ?? [];
  }

  private async embed(input: string[]): Promise<number[][]> {
    const extractor = await this.getPipeline();
    const output = await extractor(input, { pooling: 'mean', normalize: true });
    const vectors = this.parseVectors(output, input.length);
    return vectors.map(vector => this.resizeVector(vector));
  }

  private getPipeline(): Promise<FeatureExtractionPipeline> {
    const existing = LocalTransformersEmbeddingProvider.pipelines.get(this.model);
    if (existing) return existing;
    const created = this.createPipeline();
    LocalTransformersEmbeddingProvider.pipelines.set(this.model, created);
    return created;
  }

  private async createPipeline(): Promise<FeatureExtractionPipeline> {
    const modelPath = this.modelPath;
    if (!modelPath) {
      throw new Error('本地 bge-small-zh-v1.5 模型资源缺失：请将模型文件放到 packages/knowledge/models/bge-small-zh-v1.5，或通过 CUSTOMIZE_BGE_MODEL_PATH 指定本地模型目录。');
    }
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ pipeline?: (task: string, model: string, options?: Record<string, unknown>) => Promise<FeatureExtractionPipeline>; env?: { allowRemoteModels?: boolean; allowLocalModels?: boolean; localModelPath?: string } }>;
    const mod = await dynamicImport('@huggingface/transformers').catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`本地语义模型运行依赖 @huggingface/transformers 未安装或无法解析：${message}`);
    });
    if (!mod.pipeline) throw new Error('Transformers.js pipeline is unavailable');
    if (mod.env) {
      mod.env.allowRemoteModels = false;
      mod.env.allowLocalModels = true;
      mod.env.localModelPath = path.dirname(modelPath);
    }
    return mod.pipeline('feature-extraction', modelPath, { dtype: 'q8' });
  }

  private parseVectors(output: unknown, count: number): number[][] {
    if (this.isTensorLike(output)) {
      const dims = output.dims;
      const data = Array.from(output.data, Number);
      if (dims.length === 2) return this.splitFlatVectors(data, dims[0] ?? count, dims[1] ?? this.dimensions);
      if (dims.length === 3) {
        const batch = dims[0] ?? count;
        const tokens = dims[1] ?? 1;
        const width = dims[2] ?? this.dimensions;
        return Array.from({ length: batch }, (_, batchIndex) => {
          const vector = Array.from({ length: width }, () => 0);
          for (let tokenIndex = 0; tokenIndex < tokens; tokenIndex++) {
            const offset = batchIndex * tokens * width + tokenIndex * width;
            for (let i = 0; i < width; i++) vector[i] = (vector[i] ?? 0) + (data[offset + i] ?? 0);
          }
          return this.normalize(vector.map(value => value / Math.max(1, tokens)));
        });
      }
    }
    if (Array.isArray(output)) {
      const first = output[0];
      if (Array.isArray(first) && typeof first[0] === 'number') return output as number[][];
      if (typeof first === 'number') return [output as number[]];
    }
    throw new Error('Unsupported Transformers embedding output');
  }

  private isTensorLike(value: unknown): value is { data: Iterable<number>; dims: number[] } {
    return typeof value === 'object' && value !== null && 'data' in value && 'dims' in value && Array.isArray((value as { dims?: unknown }).dims);
  }

  private splitFlatVectors(data: number[], count: number, width: number): number[][] {
    return Array.from({ length: count }, (_, index) => this.normalize(data.slice(index * width, (index + 1) * width)));
  }

  private resizeVector(vector: number[]): number[] {
    if (vector.length === this.dimensions) return vector;
    if (vector.length > this.dimensions) return this.normalize(vector.slice(0, this.dimensions));
    return this.normalize([...vector, ...Array.from({ length: this.dimensions - vector.length }, () => 0)]);
  }

  private normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? vector.map(value => value / norm) : vector;
  }
}

interface StoredEmbeddingConfig {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
}

function readStoredEmbeddingConfig(): StoredEmbeddingConfig | undefined {
  try {
    const configPath = path.join(os.homedir(), '.customize-agent', 'config.json');
    if (!fs.existsSync(configPath)) return undefined;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { embedding?: StoredEmbeddingConfig };
    return raw.embedding;
  } catch {
    return undefined;
  }
}

/**
 * 根据环境变量或配置文件自动创建 Embedding Provider
 * 优先级：环境变量 > 配置文件 > 本地 Transformers.js 默认
 */
export function createEmbeddingProviderFromEnvironment(): EmbeddingProvider {
  const stored = readStoredEmbeddingConfig();
  const provider = process.env.CUSTOMIZE_EMBEDDING_PROVIDER ?? process.env.KB_EMBEDDING_PROVIDER ?? stored?.provider ?? 'transformers-local';
  if (provider === 'openai-compatible') {
    const baseUrl = process.env.CUSTOMIZE_EMBEDDING_BASE_URL ?? process.env.KB_EMBEDDING_BASE_URL ?? stored?.baseUrl;
    const model = process.env.CUSTOMIZE_EMBEDDING_MODEL ?? process.env.KB_EMBEDDING_MODEL ?? stored?.model;
    if (baseUrl && model) {
      const rawDimensions = process.env.CUSTOMIZE_EMBEDDING_DIMENSIONS ?? process.env.KB_EMBEDDING_DIMENSIONS;
      const dimensions = Number(rawDimensions ?? stored?.dimensions ?? 1024);
      return new OpenAICompatibleEmbeddingProvider({
        baseUrl,
        model,
        apiKey: process.env.CUSTOMIZE_EMBEDDING_API_KEY ?? process.env.KB_EMBEDDING_API_KEY ?? stored?.apiKey,
        dimensions: Number.isFinite(dimensions) ? dimensions : 1024,
      });
    }
  }
  const rawDimensions = process.env.CUSTOMIZE_EMBEDDING_DIMENSIONS ?? process.env.KB_EMBEDDING_DIMENSIONS;
  const dimensions = Number(rawDimensions ?? (stored?.provider === 'transformers-local' ? stored.dimensions : undefined) ?? 512);
  return new LocalTransformersEmbeddingProvider({
    model: process.env.CUSTOMIZE_EMBEDDING_MODEL ?? process.env.KB_EMBEDDING_MODEL ?? (stored?.provider === 'transformers-local' ? stored.model : undefined) ?? 'BAAI/bge-small-zh-v1.5',
    dimensions: Number.isFinite(dimensions) ? dimensions : 512,
  });
}
