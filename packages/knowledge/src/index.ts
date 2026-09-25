// types.ts 和 constants.ts 中的类型和常量不对外导出
// 它们仅在 knowledge 包内部使用。

export { TextChunker, type ChunkConfig, type TextChunk } from './chunking/text-chunker.js';
export { FileClassifier } from './classification/classifier.js';
export { cleanExtractedText, type TextCleaningInput, type TextCleaningResult, type TextCleanStats } from './cleaning/text-cleaner.js';
export { DedupEngine, type MinHashSignature, type SimilarityMatch } from './dedup/dedup-engine.js';
export { RelationshipDetector } from './dedup/relationship-detector.js';
export { HashEmbeddingProvider, LocalTransformersEmbeddingProvider, OpenAICompatibleEmbeddingProvider, createEmbeddingProviderFromEnvironment, type EmbeddingProvider, type LocalTransformersEmbeddingOptions, type OpenAICompatibleEmbeddingOptions } from './embedding/embedding-provider.js';
export { ContentExtractor, type ExtractionResult } from './extraction/content-extractor.js';
export { detectSmartTableHeader, locateTableColumns, scoreTableHeaderRow, type SmartTableHeader } from './extraction/table-header-detect.js';
export { CommandExternalExtractor, ExternalExtractorRegistry, type CommandExternalExtractorOptions, type ExternalExtractionResult, type ExternalExtractor, type ExternalExtractorCapability } from './extraction/external-extractor.js';

// 4.61 资料知识层：结构化对象一等公民（见 materials/types.ts 的三条第一性原理）
export type { FactDomain, AuthorityCarrier, FactRelation, SourceAnchor, DesignFact, BidObligation } from './materials/types.js';
export { AUTHORITY_LATTICE, authorityRank } from './materials/types.js';
export type { CadEntity, CadEntityType, CadDimensionGeometry, CadBindingQuality, CadPoint } from './materials/cad-entities.js';
export { assignCadSheets, buildCadEntities, cadBindingQuality, parseDxfPairEntities } from './materials/cad-entities.js';
export type { TableBlock, TableRow, TableColumnRoles } from './materials/table-model.js';
export { detectHeaderRows, expandColumnSpans, flattenHeaderPath, normalizeTableBlock, parseFeatureCell, resolveTableColumnRoles } from './materials/table-model.js';
export type { ClauseBlock, ClauseNumberingKind } from './materials/clause-model.js';
export { matchClauseNumber, renderClauseText, splitClauseBlocks } from './materials/clause-model.js';
export type { NormalizeResult, BindingFailure, ParsedValue } from './materials/normalize.js';
export { parseClauseFacts, clauseToObjects, dimensionFacts, annotationFacts, tableToFacts, factKey } from './materials/normalize.js';
export type { MaterialKindLike } from './materials/authority.js';
export { carrierOfSource, carrierStrength, compareAuthority, compareCarrierStrength, describeLattice, domainForAttribute, domainOfAttribute, legacyPriorityOf, refineEvaluationCarrier, resolveCarrier, sourcePriorityOf } from './materials/authority.js';

export { ChangeTracker } from './core/change-tracker.js';
export { loadBetterSqlite3, type SqliteDatabase } from './core/sqlite-loader.js';
export { KnowledgeFileScanner, type DiskFileStat } from './core/file-scanner.js';
export { IndexStateStore, type ChunkSearchResult, type FileHashRecord, type FileRelationship, type StoredChunk } from './core/index-state-store.js';
export { KnowledgeBaseManager, type KnowledgeBaseManagerOptions, type KnowledgeIndexProgress } from './core/knowledge-base-manager.js';
export { runIndexLoop, type IndexRunJob, type IndexRunOutcome } from './core/index-runner.js';
export { MultiProjectManager } from './core/multi-project-manager.js';
export { computeProjectId } from './core/project-id.js';
export { ensureProjectCustomizeFile, getProjectConfigPath, getProjectKbPath, ProjectConfigManager } from './core/project-config.js';
export { ProjectRegistry } from './core/project-registry.js';
export { MATERIAL_ROOT_NONE, materialRootOf, materialRootsOfFiles, materialRootFromScopeRoot, materialRootsOfScopeRoots } from './core/material-pack.js';

export { HNSWVectorStore } from './vector/hnsw-vector-store.js';
export { CollectionManager, globalCollectionName, projectCollectionName } from './vector/collection-manager.js';
export type { CollectionClient, VectorCollectionInfo, VectorDocument, VectorSearchQuery, VectorSearchResult, VectorStoreInterface, VectorWriteOptions } from './vector/types.js';
export { VectorIndexer, type VectorIndexResult } from './vector/vector-indexer.js';
export { FederationSearch, type FederatedQuery, type FederatedResult, type FederatedSearchItem, type RetrievalWeights, type SearchFilters, type SearchScope } from './search/federation-search.js';
export type { LLMChatMessage, LLMChatOptions, LLMChatResponse, LLMSearchProvider } from './llm/llm-search-provider.js';
