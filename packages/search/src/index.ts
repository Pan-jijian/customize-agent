// @customize-agent/search — 代码智能

// 索引层
export { StorageManager, type SearchResult } from './index/db.js';
export { RepositoryIndexer, type IndexOptions } from './index/indexer.js';
export { TreeSitterWorkerPool } from './index/pool.js';

// 搜索层
export { CodeSearcher, type SearchMatch, type SearchOptions } from './search/grep.js';
export { EmbeddingSearch, type EmbeddingSearchResult } from './search/semantic.js';

// LSP
export { LSPManager } from './lsp/lsp-manager.js';

// 语言支持（从 indexing 层重新导出）
export { getLanguageConfig, getSupportedExtensions, type LanguageConfig } from './index/languages.js';
export { extractSymbolName, collectAstErrors, friendlyKind, type AstValidationError } from './index/ast-utils.js';
