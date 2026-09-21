/** 向量文档，包含文本内容、嵌入向量和元数据 */
export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, string | number | boolean | null>;
}

/** 向量搜索查询参数 */
export type VectorFilterValue = string | number | boolean | Array<string | number | boolean>;

export interface VectorSearchQuery {
  queryEmbedding: number[];
  topK: number;
  where?: Record<string, VectorFilterValue>;
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
export interface VectorWriteOptions {
  persist?: boolean;
}

export interface VectorStoreInterface {
  readonly collectionName: string;
  ensureCollection(metadata?: Record<string, unknown>): Promise<void>;
  upsert(documents: VectorDocument[], options?: VectorWriteOptions): Promise<void>;
  deleteByFilePath(filePath: string, options?: VectorWriteOptions): Promise<void>;
  deleteByFilePaths?(filePaths: string[], options?: VectorWriteOptions): Promise<void>;
  flush?(): Promise<void>;
  clearCollection?(): Promise<void>;
  needsRebuild?(): boolean;
  /** G 线 P0-9：集合内真实向量条数（用于让 vector_indexed_chunks 记录实际入库量，
   *  而非与新鲜度判据同源的切片数——后者会让一致性检查退化为同义反复）。
   *  可选：远程/其它实现可不提供，缺省按 0 计。 */
  getDocumentCount?(): number;
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;
}

/** Collection Client 接口，用于管理远程 Vector Collection */
export interface CollectionClient {
  getOrCreateCollection(name: string, metadata?: Record<string, unknown>): Promise<VectorCollectionInfo>;
  listCollections(): Promise<VectorCollectionInfo[]>;
  deleteCollection(name: string): Promise<void>;
}
