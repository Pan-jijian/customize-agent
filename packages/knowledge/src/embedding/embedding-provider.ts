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
  return new HashEmbeddingProvider();
}
