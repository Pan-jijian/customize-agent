import * as crypto from 'node:crypto';
import type { CollectionClient, VectorCollectionInfo, VectorDocument, VectorSearchQuery, VectorSearchResult, VectorStoreInterface } from './types.js';

interface QdrantCollectionListResponse {
  result?: { collections?: Array<{ name: string }> };
}

interface QdrantSearchPoint {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown>;
}

interface QdrantSearchResponse {
  result?: QdrantSearchPoint[];
}

export interface QdrantClientOptions {
  baseUrl?: string;
}

export class QdrantHttpClient implements CollectionClient {
  readonly baseUrl: string;

  constructor(options: QdrantClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.QDRANT_URL ?? process.env.QDRANT_BASE_URL ?? 'http://127.0.0.1:6333';
  }

  async heartbeat(): Promise<boolean> {
    try {
      await this.request('/collections', {}, 3000);
      return true;
    } catch {
      return false;
    }
  }

  async getOrCreateCollection(name: string, metadata: Record<string, unknown> = {}): Promise<VectorCollectionInfo> {
    const existing = await this.getCollection(name);
    if (existing) return existing;

    const size = Number(metadata.embedding_dimension ?? process.env.QDRANT_VECTOR_SIZE ?? 384);
    await this.request(`/collections/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({
        vectors: { size, distance: 'Cosine' },
        on_disk_payload: true,
      }),
    }, 30000);
    return { name, metadata };
  }

  async listCollections(): Promise<VectorCollectionInfo[]> {
    const response = await this.request<QdrantCollectionListResponse>('/collections', {}, 10000);
    return (response.result?.collections ?? []).map(collection => ({ name: collection.name }));
  }

  async deleteCollection(name: string): Promise<void> {
    await this.request(`/collections/${encodeURIComponent(name)}`, { method: 'DELETE' }, 30000);
  }

  async upsert(collectionName: string, documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    await this.request(`/collections/${encodeURIComponent(collectionName)}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({
        points: documents.map(document => ({
          id: this.pointId(document.id),
          vector: document.embedding,
          payload: this.toPayload({
            ...document.metadata,
            id: document.id,
            content: document.content,
          }),
        })),
      }),
    }, 60000);
  }

  async deleteWhere(collectionName: string, where: Record<string, string | number | boolean>): Promise<void> {
    await this.request(`/collections/${encodeURIComponent(collectionName)}/points/delete?wait=true`, {
      method: 'POST',
      body: JSON.stringify({
        filter: this.toFilter(where),
      }),
    }, 30000);
  }

  async search(collectionName: string, query: VectorSearchQuery): Promise<QdrantSearchPoint[]> {
    const response = await this.request<QdrantSearchResponse>(`/collections/${encodeURIComponent(collectionName)}/points/search`, {
      method: 'POST',
      body: JSON.stringify({
        vector: query.queryEmbedding,
        limit: query.topK,
        filter: query.where ? this.toFilter(query.where) : undefined,
        with_payload: true,
      }),
    }, 30000);
    return response.result ?? [];
  }

  private async getCollection(name: string): Promise<VectorCollectionInfo | undefined> {
    try {
      await this.request(`/collections/${encodeURIComponent(name)}`, {}, 10000);
      return { name };
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) return undefined;
      throw error;
    }
  }

  private toFilter(where: Record<string, string | number | boolean>): { must: Array<{ key: string; match: { value: string | number | boolean } }> } {
    return {
      must: Object.entries(where).map(([key, value]) => ({ key, match: { value } })),
    };
  }

  private pointId(id: string): string {
    const hash = crypto.createHash('sha256').update(id).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  private toPayload(payload: Record<string, unknown>): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        result[key] = value;
      }
    }
    return result;
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}, timeoutMs = 3000): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Qdrant request failed: ${response.status} ${response.statusText} ${body}`.trim());
    }

    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}

export class QdrantVectorStore implements VectorStoreInterface {
  constructor(
    private readonly client: QdrantHttpClient,
    readonly collectionName: string,
  ) {}

  async ensureCollection(metadata?: Record<string, unknown>): Promise<void> {
    await this.client.getOrCreateCollection(this.collectionName, metadata);
  }

  async upsert(documents: VectorDocument[]): Promise<void> {
    await this.client.upsert(this.collectionName, documents);
  }

  async deleteByFilePath(filePath: string): Promise<void> {
    await this.client.deleteWhere(this.collectionName, { file_path: filePath });
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const points = await this.client.search(this.collectionName, query);
    return points.map(point => ({
      collection: this.collectionName,
      score: Number(point.score ?? 0),
      document: {
        id: this.payloadString(point.payload?.id) ?? String(point.id),
        content: this.payloadString(point.payload?.content) ?? '',
        metadata: this.toMetadata(point.payload ?? {}),
      },
    }));
  }

  private payloadString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private toMetadata(payload: Record<string, unknown>): Record<string, string | number | boolean | null> {
    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'content') continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
        result[key] = value;
      }
    }
    return result;
  }
}
