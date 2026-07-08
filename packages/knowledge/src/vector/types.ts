export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, string | number | boolean | null>;
}

export interface VectorSearchQuery {
  queryEmbedding: number[];
  topK: number;
  where?: Record<string, string | number | boolean>;
}

export interface VectorSearchResult {
  document: Omit<VectorDocument, 'embedding'>;
  score: number;
  collection: string;
}

export interface VectorCollectionInfo {
  id?: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface VectorStoreInterface {
  readonly collectionName: string;
  ensureCollection(metadata?: Record<string, unknown>): Promise<void>;
  upsert(documents: VectorDocument[]): Promise<void>;
  deleteByFilePath(filePath: string): Promise<void>;
  clearCollection?(): Promise<void>;
  needsRebuild?(): boolean;
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;
}

export interface CollectionClient {
  getOrCreateCollection(name: string, metadata?: Record<string, unknown>): Promise<VectorCollectionInfo>;
  listCollections(): Promise<VectorCollectionInfo[]>;
  deleteCollection(name: string): Promise<void>;
}
