export * from './types.js';
export * from './constants.js';

export { TextChunker, type ChunkConfig, type TextChunk } from './chunking/text-chunker.js';
export { FileClassifier } from './classification/classifier.js';
export { DedupEngine, type MinHashSignature, type SimilarityMatch } from './dedup/dedup-engine.js';
export { RelationshipDetector } from './dedup/relationship-detector.js';
export { HashEmbeddingProvider, type EmbeddingProvider } from './embedding/embedding-provider.js';
export { ContentExtractor, type ExtractionResult } from './extraction/content-extractor.js';
export { CommandExternalExtractor, ExternalExtractorRegistry, type CommandExternalExtractorOptions, type ExternalExtractionResult, type ExternalExtractor, type ExternalExtractorCapability } from './extraction/external-extractor.js';

export { ChangeTracker } from './core/change-tracker.js';
export { KnowledgeFileScanner, type DiskFileStat } from './core/file-scanner.js';
export { IndexStateStore, type ChunkSearchResult, type FileHashRecord, type FileRelationship, type StoredChunk } from './core/index-state-store.js';
export { KnowledgeBaseManager, type KnowledgeBaseManagerOptions } from './core/knowledge-base-manager.js';
export { MultiProjectManager } from './core/multi-project-manager.js';
export { computeProjectId } from './core/project-id.js';
export { ensureProjectCustomizeFile, getProjectConfigPath, getProjectKbPath, ProjectConfigManager } from './core/project-config.js';
export { ProjectRegistry } from './core/project-registry.js';

export { ChromaHttpClient, ChromaVectorStore, type ChromaClientOptions } from './vector/chroma-store.js';
export { CollectionManager, globalCollectionName, projectCollectionName } from './vector/collection-manager.js';
export type { CollectionClient, VectorCollectionInfo, VectorDocument, VectorSearchQuery, VectorSearchResult, VectorStoreInterface } from './vector/types.js';
export { VectorIndexer, type VectorIndexResult } from './vector/vector-indexer.js';
export { FederationSearch, type FederatedQuery, type FederatedResult, type FederatedSearchItem, type SearchFilters, type SearchScope } from './search/federation-search.js';
export { startKnowledgeDashboard, type DashboardServerHandle, type DashboardServerOptions } from './server/dashboard-server.js';
