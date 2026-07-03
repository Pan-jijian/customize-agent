import type { CollectionClient, VectorCollectionInfo, VectorDocument, VectorSearchQuery, VectorSearchResult, VectorStoreInterface } from './types.js';

interface ChromaCollectionResponse {
  id?: string;
  name: string;
  metadata?: Record<string, unknown>;
}

interface ChromaQueryResponse {
  ids?: string[][];
  documents?: string[][];
  metadatas?: Array<Array<Record<string, unknown>>>;
  distances?: number[][];
}

export interface ChromaClientOptions {
  baseUrl?: string;
  tenant?: string;
  database?: string;
}

export class ChromaHttpClient implements CollectionClient {
  readonly baseUrl: string;
  readonly tenant: string;
  readonly database: string;
  private readonly collectionIds = new Map<string, string>();

  constructor(options: ChromaClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.CHROMA_URL ?? process.env.CHROMA_BASE_URL ?? 'http://localhost:17322';
    this.tenant = options.tenant ?? 'default_tenant';
    this.database = options.database ?? 'default_database';
  }

  async heartbeat(): Promise<boolean> {
    try {
      await this.request('/api/v2/heartbeat');
      return true;
    } catch {
      return false;
    }
  }

  async getOrCreateCollection(name: string, metadata: Record<string, unknown> = {}): Promise<VectorCollectionInfo> {
    const body: Record<string, unknown> = { name, get_or_create: true };
    if (Object.keys(metadata).length > 0) body.metadata = metadata;
    const response = await this.request<ChromaCollectionResponse>(this.collectionsPath(), {
      method: 'POST',
      body: JSON.stringify(body),
    }, 10000);
    if (response.id) this.collectionIds.set(name, response.id);
    return this.toCollectionInfo(response);
  }

  async listCollections(): Promise<VectorCollectionInfo[]> {
    const response = await this.request<ChromaCollectionResponse[]>(this.collectionsPath(), {}, 10000);
    for (const collection of response) if (collection.id) this.collectionIds.set(collection.name, collection.id);
    return response.map(collection => this.toCollectionInfo(collection));
  }

  async deleteCollection(name: string): Promise<void> {
    await this.request(`${this.collectionsPath()}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    this.collectionIds.delete(name);
  }

  async upsert(collectionName: string, documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const collectionId = await this.getCollectionId(collectionName);
    await this.request(`${this.collectionsPath()}/${encodeURIComponent(collectionId)}/upsert`, {
      method: 'POST',
      body: JSON.stringify({
        ids: documents.map(document => document.id),
        embeddings: documents.map(document => document.embedding),
        documents: documents.map(document => document.content),
        metadatas: documents.map(document => document.metadata),
      }),
    }, 30000);
  }

  async deleteWhere(collectionName: string, where: Record<string, string | number | boolean>): Promise<void> {
    const collectionId = await this.getCollectionId(collectionName);
    await this.request(`${this.collectionsPath()}/${encodeURIComponent(collectionId)}/delete`, {
      method: 'POST',
      body: JSON.stringify({ where }),
    }, 10000);
  }

  async query(collectionName: string, query: VectorSearchQuery): Promise<ChromaQueryResponse> {
    const collectionId = await this.getCollectionId(collectionName);
    return this.request<ChromaQueryResponse>(`${this.collectionsPath()}/${encodeURIComponent(collectionId)}/query`, {
      method: 'POST',
      body: JSON.stringify({
        query_embeddings: [query.queryEmbedding],
        n_results: query.topK,
        where: query.where,
        include: ['documents', 'metadatas', 'distances'],
      }),
    }, 10000);
  }

  private async getCollectionId(name: string): Promise<string> {
    const cached = this.collectionIds.get(name);
    if (cached) return cached;
    const collection = await this.getOrCreateCollection(name);
    if (!collection.id) throw new Error(`ChromaDB collection has no id: ${name}`);
    this.collectionIds.set(name, collection.id);
    return collection.id;
  }

  private collectionsPath(): string {
    return `/api/v2/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(this.database)}/collections`;
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
      throw new Error(`ChromaDB request failed: ${response.status} ${response.statusText}`);
    }

    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private toCollectionInfo(collection: ChromaCollectionResponse): VectorCollectionInfo {
    return {
      id: collection.id,
      name: collection.name,
      metadata: collection.metadata,
    };
  }
}

export class ChromaVectorStore implements VectorStoreInterface {
  constructor(
    private readonly client: ChromaHttpClient,
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
    const response = await this.client.query(this.collectionName, query);
    const ids = response.ids?.[0] ?? [];
    const documents = response.documents?.[0] ?? [];
    const metadatas = response.metadatas?.[0] ?? [];
    const distances = response.distances?.[0] ?? [];

    return ids.map((id, index) => ({
      collection: this.collectionName,
      score: 1 - Number(distances[index] ?? 1),
      document: {
        id,
        content: documents[index] ?? '',
        metadata: this.toMetadata(metadatas[index] ?? {}),
      },
    }));
  }

  private toMetadata(metadata: Record<string, unknown>): Record<string, string | number | boolean | null> {
    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
        result[key] = value;
      }
    }
    return result;
  }
}
