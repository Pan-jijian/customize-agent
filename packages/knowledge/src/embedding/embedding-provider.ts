import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

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
}

type FeatureExtractionPipeline = (input: string | string[], options?: Record<string, unknown>) => Promise<unknown>;

export class LocalTransformersEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private static pipelines = new Map<string, Promise<FeatureExtractionPipeline>>();

  constructor(options: LocalTransformersEmbeddingOptions = {}) {
    this.model = options.model?.trim() || 'BAAI/bge-small-zh-v1.5';
    this.dimensions = options.dimensions ?? 512;
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
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ pipeline?: (task: string, model: string) => Promise<FeatureExtractionPipeline> }>;
    const mod = await dynamicImport('@huggingface/transformers').catch(async () => dynamicImport('@xenova/transformers'));
    if (!mod.pipeline) throw new Error('Transformers.js pipeline is unavailable');
    return mod.pipeline('feature-extraction', this.model);
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

export function createEmbeddingProviderFromEnvironment(): EmbeddingProvider {
  const stored = readStoredEmbeddingConfig();
  const provider = process.env.CUSTOMIZE_EMBEDDING_PROVIDER ?? process.env.KB_EMBEDDING_PROVIDER ?? stored?.provider;
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
  if (provider === 'transformers-local') {
    const rawDimensions = process.env.CUSTOMIZE_EMBEDDING_DIMENSIONS ?? process.env.KB_EMBEDDING_DIMENSIONS;
    const dimensions = Number(rawDimensions ?? stored?.dimensions ?? 512);
    return new LocalTransformersEmbeddingProvider({
      model: process.env.CUSTOMIZE_EMBEDDING_MODEL ?? process.env.KB_EMBEDDING_MODEL ?? stored?.model,
      dimensions: Number.isFinite(dimensions) ? dimensions : 512,
    });
  }
  return new HashEmbeddingProvider();
}
