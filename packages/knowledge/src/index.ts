// types.ts 和 constants.ts 中的类型和常量不对外导出
// 它们仅在 knowledge 包内部使用。

export { TextChunker, type ChunkConfig, type TextChunk } from './chunking/text-chunker.js';
export { FileClassifier } from './classification/classifier.js';
export { DedupEngine, type MinHashSignature, type SimilarityMatch } from './dedup/dedup-engine.js';
export { RelationshipDetector } from './dedup/relationship-detector.js';
export { HashEmbeddingProvider, LocalTransformersEmbeddingProvider, OpenAICompatibleEmbeddingProvider, createEmbeddingProviderFromEnvironment, type EmbeddingProvider, type LocalTransformersEmbeddingOptions, type OpenAICompatibleEmbeddingOptions } from './embedding/embedding-provider.js';
export { ContentExtractor, type ExtractionResult } from './extraction/content-extractor.js';
export { CommandExternalExtractor, ExternalExtractorRegistry, type CommandExternalExtractorOptions, type ExternalExtractionResult, type ExternalExtractor, type ExternalExtractorCapability } from './extraction/external-extractor.js';

export { ChangeTracker } from './core/change-tracker.js';
export { KnowledgeFileScanner, type DiskFileStat } from './core/file-scanner.js';
export { IndexStateStore, type ChunkSearchResult, type FileHashRecord, type FileRelationship, type StoredChunk } from './core/index-state-store.js';
export { KnowledgeBaseManager, type KnowledgeBaseManagerOptions, type KnowledgeIndexProgress } from './core/knowledge-base-manager.js';
export { MultiProjectManager } from './core/multi-project-manager.js';
export { computeProjectId } from './core/project-id.js';
export { ensureProjectCustomizeFile, getProjectConfigPath, getProjectKbPath, ProjectConfigManager } from './core/project-config.js';
export { ProjectRegistry } from './core/project-registry.js';

export { HNSWVectorStore } from './vector/hnsw-vector-store.js';
export { CollectionManager, globalCollectionName, projectCollectionName } from './vector/collection-manager.js';
export type { CollectionClient, VectorCollectionInfo, VectorDocument, VectorSearchQuery, VectorSearchResult, VectorStoreInterface } from './vector/types.js';
export { VectorIndexer, type VectorIndexResult } from './vector/vector-indexer.js';
export { FederationSearch, type FederatedQuery, type FederatedResult, type FederatedSearchItem, type SearchFilters, type SearchScope } from './search/federation-search.js';
export type { LLMChatMessage, LLMChatOptions, LLMChatResponse, LLMSearchProvider } from './llm/llm-search-provider.js';
