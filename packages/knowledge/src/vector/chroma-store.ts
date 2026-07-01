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

  constructor(options: ChromaClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'http://localhost:8000';
    this.tenant = options.tenant ?? 'default_tenant';
    this.database = options.database ?? 'default_database';
  }

  async heartbeat(): Promise<boolean> {
    try {
      await this.request('/api/v1/heartbeat');
      return true;
    } catch {
      return false;
    }
  }

  async getOrCreateCollection(name: string, metadata: Record<string, unknown> = {}): Promise<VectorCollectionInfo> {
    const response = await this.request<ChromaCollectionResponse>(this.collectionsPath(), {
      method: 'POST',
      body: JSON.stringify({ name, metadata, get_or_create: true }),
    });
    return this.toCollectionInfo(response);
  }

  async listCollections(): Promise<VectorCollectionInfo[]> {
    const response = await this.request<ChromaCollectionResponse[]>(this.collectionsPath());
    return response.map(collection => this.toCollectionInfo(collection));
  }

  async deleteCollection(name: string): Promise<void> {
    await this.request(`${this.collectionsPath()}/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  async upsert(collectionName: string, documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    await this.getOrCreateCollection(collectionName);
    await this.request(`${this.collectionsPath()}/${encodeURIComponent(collectionName)}/upsert`, {
      method: 'POST',
      body: JSON.stringify({
        ids: documents.map(document => document.id),
        embeddings: documents.map(document => document.embedding),
        documents: documents.map(document => document.content),
        metadatas: documents.map(document => document.metadata),
      }),
    });
  }

  async deleteWhere(collectionName: string, where: Record<string, string | number | boolean>): Promise<void> {
    await this.request(`${this.collectionsPath()}/${encodeURIComponent(collectionName)}/delete`, {
      method: 'POST',
      body: JSON.stringify({ where }),
    });
  }

  async query(collectionName: string, query: VectorSearchQuery): Promise<ChromaQueryResponse> {
    return this.request<ChromaQueryResponse>(`${this.collectionsPath()}/${encodeURIComponent(collectionName)}/query`, {
      method: 'POST',
      body: JSON.stringify({
        query_embeddings: [query.queryEmbedding],
        n_results: query.topK,
        where: query.where,
        include: ['documents', 'metadatas', 'distances'],
      }),
    });
  }

  private collectionsPath(): string {
    return `/api/v1/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(this.database)}/collections`;
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...init.headers,
      },
    });

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
