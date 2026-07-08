/** 向量文档，包含文本内容、嵌入向量和元数据 */
export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, string | number | boolean | null>;
}

/** 向量搜索查询参数 */
export interface VectorSearchQuery {
  queryEmbedding: number[];
  topK: number;
  where?: Record<string, string | number | boolean>;
}

/** 向量搜索结果 */
export interface VectorSearchResult {
  document: Omit<VectorDocument, 'embedding'>;
  score: number;
  collection: string;
}

/** Vector Collection 信息 */
export interface VectorCollectionInfo {
  id?: string;
  name: string;
  metadata?: Record<string, unknown>;
}

/** 向量存储接口，定义所有向量存储实现必须支持的方法 */
export interface VectorStoreInterface {
  readonly collectionName: string;
  ensureCollection(metadata?: Record<string, unknown>): Promise<void>;
  upsert(documents: VectorDocument[]): Promise<void>;
  deleteByFilePath(filePath: string): Promise<void>;
  clearCollection?(): Promise<void>;
  needsRebuild?(): boolean;
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;
}

/** Collection Client 接口，用于管理远程 Vector Collection */
export interface CollectionClient {
  getOrCreateCollection(name: string, metadata?: Record<string, unknown>): Promise<VectorCollectionInfo>;
  listCollections(): Promise<VectorCollectionInfo[]>;
  deleteCollection(name: string): Promise<void>;
}
