import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TextChunker } from '../chunking/text-chunker.js';
import { FileClassifier } from '../classification/classifier.js';
import { ALL_CATEGORIES, DEFAULT_CATEGORY_DIRS, GLOBAL_KNOWLEDGE_DIR, USER_DATA_DIR } from '../constants.js';
import { DedupEngine } from '../dedup/dedup-engine.js';
import { RelationshipDetector } from '../dedup/relationship-detector.js';
import { createEmbeddingProviderFromEnvironment, type EmbeddingProvider } from '../embedding/embedding-provider.js';
import { LocalReranker } from '../embedding/local-reranker.js';
import { ContentExtractor } from '../extraction/content-extractor.js';
import type { LLMSearchProvider } from '../llm/llm-search-provider.js';
import { FederationSearch, type FederatedResult, type FederatedSearchItem, type RetrievalWeights, type SearchFilters } from '../search/federation-search.js';
import type { ClassifiedFile, DiffResult, IndexStateRecord, KBScope, KnowledgeBaseStats, ProjectConfig } from '../types.js';
import { CollectionManager } from '../vector/collection-manager.js';
import { HNSWVectorStore } from '../vector/hnsw-vector-store.js';
import type { VectorStoreInterface } from '../vector/types.js';
import { VectorIndexer, type VectorIndexResult } from '../vector/vector-indexer.js';
import { ChangeTracker } from './change-tracker.js';
import { KnowledgeFileScanner } from './file-scanner.js';
import { IndexStateStore, type ChunkSearchResult, type FileRelationship, type StoredChunk } from './index-state-store.js';
import { getProjectKbPath, ProjectConfigManager } from './project-config.js';

// 查询扩展（LLM）调用的约束：生成流程会高频触发查询扩展，
// TTL 缓存吸收重复扩展、信号量避免扩展请求无界并发击穿模型端点
const QUERY_EXPANSION_TTL_MS = 10 * 60 * 1000;
const QUERY_EXPANSION_CACHE_MAX = 256;
const QUERY_EXPANSION_MAX_CONCURRENCY = 2;

export type KnowledgeIndexStage = 'scanning' | 'parsing' | 'chunking' | 'vectorizing' | 'done' | 'error';

export interface KnowledgeIndexProgress {
  stage: KnowledgeIndexStage;
  percent: number;
  message: string;
  filePath?: string;
  chunkCount?: number;
  vectorStatus?: ReturnType<KnowledgeBaseManager['getVectorStatus']>;
}

export interface KnowledgeBaseManagerOptions {
  scope: Exclude<KBScope, 'session'>;
  projectRoot?: string;
  projectId?: string;
  kbPath?: string;
  storageRoot?: string;
  embeddingProvider?: EmbeddingProvider;
  vectorStores?: Map<string, VectorStoreInterface>;
  onProgress?: (progress: KnowledgeIndexProgress) => void;
  /** 可选的 LLM Provider，用于查询扩展和语义重排序 */
  llmProvider?: LLMSearchProvider;
}

export class KnowledgeBaseManager {
  readonly scope: Exclude<KBScope, 'session'>;
  readonly projectRoot?: string;
  readonly projectId?: string;
  readonly kbPath: string;
  readonly store: IndexStateStore;

  private readonly vectorRoot: string;
  private readonly classifier = new FileClassifier();
  private readonly scanner = new KnowledgeFileScanner();
  private readonly collections = new CollectionManager();
  private readonly extractor: ContentExtractor;
  private readonly chunker = new TextChunker();
  private readonly dedup = new DedupEngine();
  private readonly relationshipDetector = new RelationshipDetector();
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly vectorStores: Map<string, VectorStoreInterface>;
  private readonly configManager: ProjectConfigManager;
  private projectConfig?: ProjectConfig;
  private lastSkippedFiles: DiffResult['skippedFiles'] = [];
  private readonly llmProvider?: LLMSearchProvider;
  private readonly queryExpansionCache = new Map<string, { queries: string[]; expiresAt: number }>();
  private readonly queryExpansionInFlight = new Map<string, Promise<string[]>>();
  private queryExpansionActive = 0;
  private readonly queryExpansionWaiters: Array<() => void> = [];
  private onProgress?: (progress: KnowledgeIndexProgress) => void;

  constructor(options: KnowledgeBaseManagerOptions) {
    this.scope = options.scope;
    this.projectRoot = options.projectRoot;
    this.projectId = options.projectId;
    this.embeddingProvider = options.embeddingProvider ?? createEmbeddingProviderFromEnvironment();
    this.vectorStores = options.vectorStores ?? new Map();
    this.extractor = new ContentExtractor();
    this.llmProvider = options.llmProvider;
    this.onProgress = options.onProgress;

    const storageRoot = options.storageRoot ?? path.join(os.homedir(), USER_DATA_DIR);
    this.configManager = new ProjectConfigManager(storageRoot);
    let dbPath: string;
    if (this.scope === 'global') {
      this.kbPath = options.kbPath ?? path.join(storageRoot, GLOBAL_KNOWLEDGE_DIR);
      dbPath = path.join(storageRoot, 'global-knowledge.db');
    } else {
      if (!options.projectRoot || !options.projectId) {
        throw new Error('project knowledge base requires projectRoot and projectId');
      }
      this.kbPath = options.kbPath ?? getProjectKbPath(options.projectRoot, storageRoot);
      dbPath = path.join(storageRoot, 'projects', options.projectId, 'kb.db');
    }
    this.store = new IndexStateStore(dbPath);
    this.vectorRoot = path.join(path.dirname(dbPath), 'hnsw');
  }

  initialize(): void {
    if (this.scope === 'project' && this.projectRoot) {
      this.projectConfig = this.configManager.loadOrCreate(this.projectRoot);
      fs.mkdirSync(this.kbPath, { recursive: true });
      const dirs = this.projectConfig.categoryDirs;
      for (const category of ALL_CATEGORIES) {
        fs.mkdirSync(path.join(this.kbPath, dirs[category] ?? DEFAULT_CATEGORY_DIRS[category]), { recursive: true });
      }
    }
    if (this.scope === 'global') {
      fs.mkdirSync(this.kbPath, { recursive: true });
    }
  }

  async forceReindexAll(options: { onProgress?: (progress: KnowledgeIndexProgress) => void; vectorMode?: 'sync' | 'defer' } = {}): Promise<DiffResult> {
    this.initialize();
    const records = this.store.listRecords();
    for (const record of records) {
      await this.deleteVectorFile(record.collectionName, record.relativePath);
      this.store.deleteRecord(record.relativePath);
    }
    return this.incrementalIndex(options);
  }

  async consumePendingIndexJobs(options: { onProgress?: (progress: KnowledgeIndexProgress) => void; vectorMode?: 'sync' | 'defer'; limit?: number; waitForUploadId?: string } = {}): Promise<DiffResult> {
    this.initialize();
    const jobs = this.store.listPendingIndexJobs(options.limit ?? 500);
    if (jobs.length === 0) return this.emptyDiff();
    const lightweightJobs: typeof jobs = [];
    const heavyJobs: typeof jobs = [];
    for (const job of jobs) {
      const ext = path.extname(job.relativePath).toLowerCase();
      if (/\.(pdf|png|jpe?g|webp|gif|bmp|tiff?|xlsx?|xlsm|docx?|pptx?)$/iu.test(ext)) heavyJobs.push(job);
      else lightweightJobs.push(job);
    }
    const selectedJobs = [...lightweightJobs, ...heavyJobs].slice(0, options.limit ?? 500);
    return this.incrementalIndex({ ...options, onlyRelativePaths: selectedJobs.map(job => job.relativePath) });
  }

  async incrementalIndex(options: { onProgress?: (progress: KnowledgeIndexProgress) => void; vectorMode?: 'sync' | 'defer'; onlyRelativePaths?: string[] } = {}): Promise<DiffResult> {
    this.initialize();
    const previousOnProgress = this.onProgress;
    if (options.onProgress) this.onProgress = options.onProgress;
    try {
    this.reportProgress({ stage: 'scanning', percent: 10, message: '正在扫描知识库文件' });

    const kbIgnore = this.scanner.loadKbIgnore(this.kbPath);
    const configIgnore = this.projectConfig?.kbignore ?? [];
    const onlyRelativePaths = options.onlyRelativePaths ? new Set(options.onlyRelativePaths) : undefined;
    const diskFiles = onlyRelativePaths ? this.statRelativePaths([...onlyRelativePaths]) : await this.scanner.scan(this.kbPath, [...kbIgnore, ...configIgnore]);
    const tracker = new ChangeTracker(this.store);
    const diff = await tracker.computeDiff(diskFiles, this.classifier, this.kbPath);

    let vectorDeletesApplied = 0;
    if (onlyRelativePaths) {
      diff.newFiles = diff.newFiles.filter(file => onlyRelativePaths.has(file.relativePath));
      diff.modifiedFiles = diff.modifiedFiles.filter(file => onlyRelativePaths.has(file.relativePath));
      diff.deletedFiles = diff.deletedFiles.filter(file => onlyRelativePaths.has(file.relativePath));
      for (const relativePath of onlyRelativePaths) {
        const exists = diff.newFiles.some(file => file.relativePath === relativePath) || diff.modifiedFiles.some(file => file.relativePath === relativePath) || diff.deletedFiles.some(file => file.relativePath === relativePath);
        if (exists) continue;
        const diskStat = diskFiles.get(relativePath);
        if (!diskStat) {
          this.updateJobsForFile(relativePath, 'ERROR', 100, '待索引文件不存在', '待索引文件不存在');
          continue;
        }
        const absolutePath = this.resolveKbRelativePath(relativePath);
        const stat = fs.statSync(absolutePath);
        const classified = this.classifier.classify(absolutePath, relativePath, stat);
        const skipReason = this.classifier.shouldSkip(classified);
        if (skipReason) this.updateJobsForFile(relativePath, 'ERROR', 100, skipReason, skipReason);
        else diff.modifiedFiles.push(classified);
      }
      diff.hasChanges = diff.newFiles.length + diff.modifiedFiles.length + diff.deletedFiles.length > 0;
    }

    for (const deleted of diff.deletedFiles) {
      await this.deleteVectorFile(deleted.collectionName, deleted.relativePath);
      vectorDeletesApplied += 1;
      this.store.deleteRecord(deleted.relativePath);
      this.updateJobsForFile(deleted.relativePath, 'SUCCESS', 100, '文件已删除，索引记录和向量已清理');
    }

    const now = Date.now();
    const indexedBefore = [...this.store.loadActiveRecords().values()];
    const filesToIndex = [...diff.newFiles, ...diff.modifiedFiles];
    const vectorRelativePaths: string[] = [];
    const changedCollectionNames = new Set<string>();
    for (const [index, file] of filesToIndex.entries()) {
      const hash = await tracker.hashFile(file.absolutePath);
      const duplicate = this.store.findExactDuplicate(hash, file.relativePath);
      const collectionName = this.scope === 'global'
        ? this.collections.getCollectionName('global', file.category)
        : this.collections.getCollectionName('project', file.category, this.projectId);
      const previousRecord = indexedBefore.find(record => record.relativePath === file.relativePath);
      if (previousRecord?.collectionName) changedCollectionNames.add(previousRecord.collectionName);
      const basePercent = filesToIndex.length === 0 ? 40 : 20 + Math.round((index / filesToIndex.length) * 45);
      this.updateJobsForFile(file.relativePath, 'PARSING', basePercent, `正在解析 ${file.relativePath}`);
      this.reportProgress({ stage: 'parsing', percent: basePercent, message: `正在解析 ${file.relativePath}`, filePath: file.relativePath });
      const extraction = await this.extractor.extract(file);
      extraction.metadata.textLength = extraction.text.length;
      if (!this.hasUsableContent(extraction.text, extraction.metadata)) {
        const reason = extraction.warnings[0] ?? '未解析出可用于模型的正文内容，已跳过向量化';
        const metadataOnly = this.isMetadataOnlyNonBlocking(file, extraction.metadata);
        diff.skippedFiles.push({ file, reason });
        this.updateJobsForFile(file.relativePath, metadataOnly ? 'SUCCESS' : 'ERROR', 100, reason, metadataOnly ? undefined : reason);
        this.store.upsertRecord({
          relativePath: file.relativePath,
          category: file.category,
          format: file.format,
          contentHash: hash,
          fileSize: file.fileSize,
          mtime: file.mtime,
          chunkCount: 0,
          collectionName,
          indexedAt: now,
          lastVerifiedAt: now,
          status: metadataOnly ? 'active' : 'error',
          errorMessage: metadataOnly ? undefined : reason,
          metadataJson: JSON.stringify({ mimeType: file.mimeType, ...extraction.metadata, warnings: extraction.warnings, metadataOnly }),
        });
        continue;
      }
      const normalizedHash = this.dedup.normalizedHash(extraction.text);
      const normalizedDuplicate = !duplicate && normalizedHash
        ? this.store.findNormalizedDuplicate(normalizedHash, file.relativePath)
        : undefined;
      this.updateJobsForFile(file.relativePath, 'CHUNKING', Math.min(80, basePercent + 10), `正在切片 ${file.relativePath}`);
      this.reportProgress({ stage: 'chunking', percent: Math.min(80, basePercent + 10), message: `正在切片 ${file.relativePath}`, filePath: file.relativePath });
      const chunks = this.chunker.chunk(extraction.text, file, extraction.metadata);
      this.reportProgress({ stage: 'chunking', percent: Math.min(84, basePercent + 14), message: `切片完成：${chunks.length} 块`, filePath: file.relativePath, chunkCount: chunks.length });
      this.store.upsertFileHash({
        contentHash: hash,
        filePath: file.relativePath,
        fileSize: file.fileSize,
        category: file.category,
        normalizedHash,
      });

      if (duplicate) {
        this.store.addRelationship({
          sourceFile: file.relativePath,
          targetFile: duplicate.filePath,
          relationshipType: 'exact_duplicate',
          confidence: 1,
          detail: `SHA-256 完全相同: ${hash}`,
          userConfirmed: 0,
        });
      } else if (normalizedDuplicate && normalizedHash) {
        this.store.addRelationship({
          sourceFile: file.relativePath,
          targetFile: normalizedDuplicate.filePath,
          relationshipType: this.dedup.relationshipForFormats(file.format, normalizedDuplicate.category),
          confidence: 0.95,
          detail: `归一化内容哈希相同: ${normalizedHash}`,
          userConfirmed: 0,
        });
      }

      if (!duplicate && extraction.text.length > 1000) {
        const minHash = this.dedup.computeMinHash(extraction.text);
        if (minHash) {
          for (const existing of this.store.listMinHashesByBuckets(minHash.buckets, file.relativePath)) {
            const similarity = this.dedup.estimateSimilarity(minHash.signature, existing.signature);
            const relationshipType = this.dedup.relationshipForSimilarity(similarity);
            if (relationshipType) {
              this.store.addRelationship({
                sourceFile: file.relativePath,
                targetFile: existing.filePath,
                relationshipType,
                confidence: similarity,
                detail: `MinHash 相似度: ${similarity.toFixed(3)}`,
                userConfirmed: 0,
              });
            }
          }
          this.store.upsertMinHash({
            filePath: file.relativePath,
            signature: minHash.signature,
            shingleCount: minHash.shingleCount,
            buckets: minHash.buckets,
          });
        }
      }

      for (const relationship of this.relationshipDetector.detect(file, indexedBefore)) {
        this.store.addRelationship(relationship);
      }

      this.store.upsertRecord({
        relativePath: file.relativePath,
        category: file.category,
        format: file.format,
        contentHash: hash,
        fileSize: file.fileSize,
        mtime: file.mtime,
        chunkCount: chunks.length,
        collectionName,
        indexedAt: now,
        lastVerifiedAt: now,
        status: 'active',
        metadataJson: JSON.stringify({
          mimeType: file.mimeType,
          ...extraction.metadata,
          extraction: extraction.metadata,
          warnings: extraction.warnings,
          extractionTimeMs: extraction.extractionTimeMs,
        }),
      });
      this.store.replaceChunks(file.relativePath, chunks, {
        category: file.category,
        format: file.format,
        collectionName,
      });
      vectorRelativePaths.push(file.relativePath);
      changedCollectionNames.add(collectionName);
      this.updateJobsForFile(file.relativePath, options.vectorMode === 'defer' ? 'SUCCESS' : 'INDEXING', options.vectorMode === 'defer' ? 100 : 85, options.vectorMode === 'defer' ? '解析和切片已完成' : '等待向量入库');
    }

    const stats = this.getStats();
    this.store.setMetadata('last_incremental_index_at', String(now));
    this.store.setMetadata('total_chunks', String(stats.chunkCount));
    this.store.setMetadata('total_files_indexed', String(stats.fileCount));
    const hasIndexChanges = diff.newFiles.length + diff.modifiedFiles.length + diff.deletedFiles.length > 0;
    if (options.vectorMode === 'defer') {
      if (hasIndexChanges) {
        this.store.setMetadata('vector_index_status', 'pending');
        const pending = new Set(this.consumePendingVectorRelativePaths());
        for (const relativePath of vectorRelativePaths) pending.add(relativePath);
        this.store.setMetadata('vector_pending_relative_paths', JSON.stringify([...pending]));
      }
      this.reportProgress({ stage: 'vectorizing', percent: 85, message: '解析和切片已完成，向量入库转入后台/稍后执行', chunkCount: stats.chunkCount, vectorStatus: this.getVectorStatus() });
    } else {
      await this.ensureVectorIndexFresh(stats.chunkCount, { changedRelativePaths: vectorRelativePaths, changedCollectionNames, deletesApplied: vectorDeletesApplied });
    }
    this.lastSkippedFiles = diff.skippedFiles;

    const vectorStatus = this.getVectorStatus();
    if (options.vectorMode !== 'defer') {
      for (const file of filesToIndex) {
        if (vectorStatus.status === 'error') this.updateJobsForFile(file.relativePath, 'ERROR', 100, 'HNSWLib 向量入库失败', vectorStatus.error);
        else this.updateJobsForFile(file.relativePath, 'SUCCESS', 100, '解析、切片和向量索引完成');
      }
    }
    const vectorDeferred = options.vectorMode === 'defer';
    this.reportProgress({
      stage: vectorDeferred || vectorStatus.status !== 'error' ? 'done' : 'error',
      percent: vectorDeferred || vectorStatus.status !== 'error' ? 100 : 85,
      message: vectorDeferred
        ? '解析、切片和 SQLite 入库已完成，向量入库后台执行'
        : vectorStatus.status === 'error'
          ? '解析和切片已完成，HNSWLib 向量待入库'
          : '知识库索引完成',
      chunkCount: stats.chunkCount,
      vectorStatus,
    });
    return diff;
    } finally {
      this.onProgress = previousOnProgress;
    }
  }

  search(query: string, limit?: number, filters?: SearchFilters): ChunkSearchResult[] {
    return this.store.searchChunks(query, this.resolveSearchLimit(limit, filters), { filePaths: filters?.filePaths ?? (filters?.filePath ? [filters.filePath] : undefined) });
  }

  keywordSearchItems(query: string, limit?: number, filters?: SearchFilters): FederatedSearchItem[] {
    return this.store.searchChunks(query, this.resolveSearchLimit(limit, filters), { filePaths: filters?.filePaths ?? (filters?.filePath ? [filters.filePath] : undefined) }).map(result => this.toFederatedItem(result, 'keyword'));
  }

  private resolveSearchLimit(limit: number | undefined, filters?: SearchFilters): number {
    if (Number.isFinite(limit) && limit! > 0) return Math.ceil(limit!);
    return this.searchCorpusSize(filters);
  }

  private searchCorpusSize(filters?: SearchFilters): number {
    const paths = filters?.filePaths ?? (filters?.filePath ? [filters.filePath] : undefined);
    const pathSet = paths?.filter(Boolean) ?? [];
    // 单条 SUM 聚合，避免 listRecords 全量加载每条索引记录
    return Math.max(1, this.store.countIndexedChunks(pathSet.length > 0 ? pathSet : undefined));
  }

  expandContext(item: FederatedSearchItem): FederatedSearchItem {
    const chunkIndex = item.chunkIndex ?? this.parseChunkIndex(item.id);
    const parent = item.parentId ? this.store.getParentChunk(item.filePath, item.parentId) : undefined;
    if (parent) {
      return {
        ...item,
        content: parent.content,
        chunkIndex,
        parentId: parent.parentId,
        sectionTitle: parent.sectionTitle ?? item.sectionTitle,
        titlePath: item.titlePath ?? this.parseMetadataString(parent.metadataJson, 'titlePath'),
      };
    }
    const parentChunks = item.parentId ? this.store.getChunksByParent(item.filePath, item.parentId, 6) : [];
    const chunks = parentChunks.length > 0 ? parentChunks : this.store.getContextChunks(item.filePath, chunkIndex, 1);
    if (chunks.length === 0) {
      const document = this.store.getDocumentChunk(item.filePath);
      if (!document) return item;
      // 文档级兜底必须截断：整份文档全文（可能 10 万字级）会撑爆 LLM 上下文预算并稀释命中片段信噪比
      const MAX_DOCUMENT_CONTENT_CHARS = 6000;
      const content = document.content.length > MAX_DOCUMENT_CONTENT_CHARS
        ? `${document.content.slice(0, MAX_DOCUMENT_CONTENT_CHARS)}\n……（文档过长，已截断，完整内容请查看原文件）`
        : document.content;
      return { ...item, content, sectionTitle: item.sectionTitle ?? 'Document Parent' };
    }
    return {
      ...item,
      content: chunks.map(chunk => chunk.content).join('\n\n---\n\n'),
      chunkIndex,
      parentId: item.parentId ?? this.parseMetadataString(chunks[0]?.metadataJson, 'parentId'),
      titlePath: item.titlePath ?? chunks.map(chunk => this.parseMetadataString(chunk.metadataJson, 'titlePath')).find(Boolean),
      sectionTitle: item.sectionTitle ?? chunks.find(chunk => chunk.sectionTitle)?.sectionTitle,
    };
  }

  async hybridSearch(query: string, options: { limit?: number; filters?: SearchFilters; collections?: string[]; weights?: RetrievalWeights; generationMode?: boolean; disableReranker?: boolean } = {}): Promise<FederatedResult> {
    const requestedLimit = Number.isFinite(options.limit) && options.limit! > 0 ? Math.ceil(options.limit!) : undefined;
    // 调用方已显式指定 limit 时无需计算语料总量，避免每次搜索都做一次全量聚合
    const effectiveLimit = requestedLimit ?? this.searchCorpusSize(options.filters);
    const start = Date.now();
    const weights = this.retrievalWeights(options.weights);
    // P1-10 检索语义澄清：generationMode=true 表示"生成场景检索"（文档正文生成链路调用），
    // 该场景刻意跳过 LLM 查询重写——正文生成已占满 LLM 全局信号量，检索侧再触发 LLM 扩展会互相拖慢；
    // 命名按"调用场景"而非"是否启用 LLM 重写"，因此 true 反而跳过重写。
    const rewrittenQueries = options.generationMode ? [query.trim()].filter(Boolean) : await this.rewriteQueries(query);
    const rankedLists: Array<{ source: 'keyword' | 'vector'; items: FederatedSearchItem[]; queryIndex: number }> = [];
    const keywordMultiplier = options.generationMode ? 2 : 3;
    const vectorMultiplier = options.generationMode ? 3 : 6;
    const vectorQueryLimit = options.generationMode ? 1 : 3;
    for (const [queryIndex, rewritten] of rewrittenQueries.entries()) {
      rankedLists.push({ source: 'keyword', items: this.keywordSearchItems(rewritten, effectiveLimit * keywordMultiplier, options.filters), queryIndex });
      if (queryIndex < vectorQueryLimit) {
        try {
          const vectorLimit = effectiveLimit * vectorMultiplier;
          const keywordLimit = effectiveLimit * keywordMultiplier;
          rankedLists.push({ source: 'vector', items: (await this.semanticSearch(rewritten, { ...options, limit: vectorLimit })).results.slice(0, keywordLimit), queryIndex });
        } catch { /* 向量搜索在混合搜索中是可选的 */ }
      }
    }
    const keywordItems = rankedLists.filter(list => list.source === 'keyword').flatMap(list => list.items);
    const vectorItems = rankedLists.filter(list => list.source === 'vector').flatMap(list => list.items);
    
    // 1. 先进行初筛合并，合并相同的子块并计算混合初始分（不获取大片段，保留子块自身用于精确打分）
    const mergeLimit = effectiveLimit * 4;
    const mergedChildChunks = this.mergeContexts(this.mergeHybridRankedLists(rankedLists, mergeLimit, weights), mergeLimit);
    
    // 2. 对这些子块进行交叉编码器重排（Cross-Encoder Rerank）
    let reranked = mergedChildChunks;
    let rerankerName = 'local-heuristic-fallback';
    if (options.disableReranker) {
      reranked = this.heuristicRerank(query, mergedChildChunks);
      rerankerName = 'local-heuristic-disabled-reranker';
    } else if (mergedChildChunks.length > 0) {
      const rerankLimit = requestedLimit ? Math.min(30, mergeLimit) : mergedChildChunks.length;
      const candidates = mergedChildChunks.slice(0, rerankLimit);
      // 这里使用的是子块自身内容，通常在 500 tokens 左右，不仅相关性判断最准，而且不会超出 Reranker 的 max_length
      const textsToRerank = candidates.map(item => `${item.titlePath ?? item.sectionTitle ?? ''}\n${item.content}`);
      try {
        const scores = await LocalReranker.rerank(query, textsToRerank);
        const usableScores = scores.length === candidates.length && scores.some(score => Number.isFinite(score) && score > 0);
        if (usableScores) {
          reranked = candidates.map((item, i) => ({
            ...item,
            score: scores[i] ?? item.score,
            scoreDetails: { ...item.scoreDetails, crossEncoderScore: scores[i] ?? 0 }
          })).sort((a, b) => b.score - a.score);
          rerankerName = 'bge-reranker-base';
        } else {
          reranked = this.heuristicRerank(query, mergedChildChunks);
          rerankerName = 'local-heuristic-fallback-empty-rerank';
        }
      } catch {
        reranked = this.heuristicRerank(query, mergedChildChunks);
      }
    }

    // 3. 拿到精确打分后的结果，此时再进行 expandContext 向上追溯到完整的父块大片段
    const finalExpandedResults = this.mergeExpandedContexts(reranked.map(item => this.expandContext(item)), effectiveLimit);

    return {
      results: finalExpandedResults,
      scopesSearched: this.scope === 'global' ? ['global'] : ['project'],
      queryTimeMs: Date.now() - start,
      debug: {
        originalQuery: query,
        rewrittenQueries,
        weights,
        recallCounts: { keyword: keywordItems.length, vector: vectorItems.length, merged: mergedChildChunks.length },
        reranker: rerankerName,
      },
    };
  }

  async semanticSearch(query: string, options: { limit?: number; filters?: SearchFilters; collections?: string[] } = {}): Promise<FederatedResult> {
    for (const record of this.store.listRecords()) this.ensureVectorStore(record.collectionName);
    const queryEmbedding = await this.embeddingProvider.embedQuery(query);
    const search = new FederationSearch(this.vectorStores);
    try {
      const result = await search.search({
        query,
        queryEmbedding,
        topK: this.resolveSearchLimit(options.limit, options.filters),
        scope: this.scope,
        projectId: this.projectId,
        collections: options.collections,
        filters: options.filters,
      });
      return { ...result, results: this.hydrateVectorResultsFromSqlite(result.results) };
    } catch {
      return { results: [], scopesSearched: this.scope === 'global' ? ['global'] : ['project'], queryTimeMs: 0 };
    }
  }

  listRelationships(filePath?: string): FileRelationship[] {
    return this.store.listRelationships(filePath);
  }

  listFiles(): IndexStateRecord[] {
    return this.store.listRecords();
  }

  listChunks(options: { relativePath?: string; limit?: number } = {}) {
    return this.store.listChunks(options);
  }

  getFileDetail(relativePath: string, options: { maxChunkContentChars?: number } = {}) {
    const normalized = this.normalizeRelativePath(relativePath);
    const file = this.store.listRecords().find(record => record.relativePath === normalized);
    if (!file) return undefined;
    const absolutePath = this.resolveKbRelativePath(normalized);
    const chunks = options.maxChunkContentChars
      ? this.store.listChunksByContentBudget({ relativePath: normalized, maxContentChars: options.maxChunkContentChars })
      : this.store.listChunks({ relativePath: normalized });
    return {
      file,
      absolutePath,
      directory: path.dirname(absolutePath),
      chunks,
      totalChunkCount: this.store.countChunks({ relativePath: normalized }),
      parents: this.store.listParentChunks(normalized),
      relationships: this.store.listRelationships(normalized),
      tags: this.store.listTags(normalized),
    };
  }

  async reindexFile(relativePath: string, options: { onProgress?: (progress: KnowledgeIndexProgress) => void; vectorMode?: 'sync' | 'defer' } = {}): Promise<DiffResult> {
    const normalized = this.normalizeRelativePath(relativePath);
    const record = this.store.listRecords().find(item => item.relativePath === normalized);
    const targetPath = this.resolveKbRelativePath(normalized);
    if (!fs.existsSync(targetPath)) throw new Error('file not found');
    if (record) await this.deleteVectorFile(record.collectionName, normalized);
    this.store.deleteRecord(normalized);
    return this.incrementalIndex({ ...options, onlyRelativePaths: [normalized] });
  }

  async addFile(sourcePath: string, targetRelativePath?: string): Promise<DiffResult> {
    this.initialize();
    const resolvedSource = path.resolve(sourcePath);
    const relativePath = targetRelativePath ?? path.basename(resolvedSource);
    const targetPath = this.resolveKbRelativePath(relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(resolvedSource, targetPath);
    return this.incrementalIndex({ onlyRelativePaths: [relativePath] });
  }

  getUploadRelativePath(fileName: string, targetRelativePath?: string): string {
    return this.validateUploadRelativePath(targetRelativePath ? this.normalizeRelativePath(targetRelativePath) : this.defaultUploadRelativePath(fileName));
  }

  async uploadFile(fileName: string, content: Buffer, targetRelativePath?: string, onProgress?: (progress: KnowledgeIndexProgress) => void, options: { vectorMode?: 'sync' | 'defer' } = {}): Promise<DiffResult> {
    return this.uploadFiles([{ fileName, content, targetRelativePath }], onProgress, options);
  }

  async stageUploadedFiles(files: Array<{ fileName: string; content: Buffer; targetRelativePath?: string }>, operationId = `upload-${Date.now()}`) {
    this.initialize();
    const jobs = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      const relativePath = this.getUploadRelativePath(file.fileName, file.targetRelativePath);
      const targetPath = this.resolveKbRelativePath(relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, file.content);
      jobs.push(this.store.enqueueIndexJob({ id: `${operationId}-${index}`, relativePath, message: '文件已落盘，等待后台解析' }));
    }
    return jobs;
  }

  async stageUploadedFilePaths(files: Array<{ fileName: string; sourcePath: string; targetRelativePath?: string }>, operationId = `upload-${Date.now()}`, offset = 0, uploadComplete = true) {
    this.initialize();
    this.store.setMetadata(`upload_session:${operationId}`, uploadComplete ? 'complete' : 'open');
    const jobs = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      const relativePath = this.getUploadRelativePath(file.fileName, file.targetRelativePath);
      const targetPath = this.resolveKbRelativePath(relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      this.moveUploadedFile(file.sourcePath, targetPath);
      jobs.push(this.store.enqueueIndexJob({ id: `${operationId}-${offset + index}`, relativePath, message: '文件已落盘，等待后台解析' }));
    }
    return jobs;
  }

  async uploadFiles(files: Array<{ fileName: string; content: Buffer; targetRelativePath?: string }>, onProgress?: (progress: KnowledgeIndexProgress) => void, options: { vectorMode?: 'sync' | 'defer' } = {}): Promise<DiffResult> {
    const jobs = await this.stageUploadedFiles(files);
    return this.incrementalIndex({ onProgress, vectorMode: options.vectorMode, onlyRelativePaths: jobs.map(job => job.relativePath) });
  }

  listFailedFiles(): DiffResult['skippedFiles'] {
    return this.lastSkippedFiles;
  }

  async removeFile(relativePath: string): Promise<void> {
    const normalized = this.normalizeRelativePath(relativePath);
    const targetPath = this.resolveKbRelativePath(normalized);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    // 同步删除 HNSWLib 向量数据，避免孤儿向量污染搜索结果
    const record = this.store.listRecords().find(r => r.relativePath === normalized);
    if (record) {
      await this.deleteVectorFile(record.collectionName, normalized);
    }
    this.store.deleteRecord(normalized);
    const stats = this.getStats();
    this.store.setMetadata('total_chunks', String(stats.chunkCount));
    this.store.setMetadata('total_files_indexed', String(stats.fileCount));
    this.store.setMetadata('vector_indexed_chunks', String(stats.chunkCount));
    this.store.setMetadata('last_vector_index_at', String(Date.now()));
  }

  tagFile(relativePath: string, tags: string[]): void {
    this.store.setTags(this.normalizeRelativePath(relativePath), tags);
  }

  listTags(relativePath?: string): Array<{ filePath: string; tag: string; createdAt: number }> {
    return this.store.listTags(relativePath ? this.normalizeRelativePath(relativePath) : undefined);
  }

  addIgnoreRule(pattern: string): void {
    this.store.addIgnoreRule(pattern);
    if (this.scope === 'project' && this.projectRoot) {
      const config = this.projectConfig ?? this.configManager.loadOrCreate(this.projectRoot);
      if (!config.kbignore.includes(pattern)) {
        this.configManager.save(this.projectRoot, { ...config, kbignore: [...config.kbignore, pattern] });
      }
    }
  }

  listIgnoreRules(): Array<{ id: number; pattern: string; enabled: boolean; createdAt: number }> {
    return this.store.listIgnoreRules();
  }

  async indexVectors(options: { collectionName?: string; relativePath?: string; relativePaths?: string[]; cleanupCollectionNames?: Iterable<string>; limit?: number; rebuild?: boolean } = {}): Promise<VectorIndexResult[]> {
    const pendingRelativePaths = !options.rebuild && !options.relativePath && !options.relativePaths?.length
      ? this.consumePendingVectorRelativePaths()
      : [];
    if (pendingRelativePaths.length > 0) options = { ...options, relativePaths: pendingRelativePaths };
    const chunks = options.relativePaths?.length
      ? options.relativePaths.flatMap(relativePath => this.store.listChunks({ collectionName: options.collectionName, relativePath }))
      : this.store.listChunks(options);
    const collectionNames = new Set(chunks.map(chunk => chunk.collectionName));
    const cleanupCollectionNames = new Set([...collectionNames, ...(options.cleanupCollectionNames ?? [])]);
    for (const collectionName of cleanupCollectionNames) this.ensureVectorStore(collectionName);
    if (options.rebuild || (!options.relativePath && !options.relativePaths?.length)) {
      for (const collectionName of collectionNames) await this.vectorStores.get(collectionName)?.clearCollection?.();
    } else {
      const cleanupRelativePaths = options.relativePaths ?? ([options.relativePath].filter(Boolean) as string[]);
      for (const collectionName of cleanupCollectionNames) {
        const vectorStore = this.vectorStores.get(collectionName);
        if (vectorStore?.deleteByFilePaths) await vectorStore.deleteByFilePaths(cleanupRelativePaths, { persist: false });
        else {
          for (const relativePath of cleanupRelativePaths) await vectorStore?.deleteByFilePath(relativePath, { persist: false });
        }
      }
      if (chunks.length === 0) {
        for (const collectionName of cleanupCollectionNames) await this.vectorStores.get(collectionName)?.flush?.();
      }
    }
    this.reportProgress({ stage: 'vectorizing', percent: 85, message: `正在写入 HNSWLib 向量库，共 ${chunks.length} 个切片`, chunkCount: chunks.length });
    if (chunks.length === 0) {
      const totalChunks = this.getStats().chunkCount;
      this.store.setMetadata('vector_indexed_chunks', String(totalChunks));
      this.store.setMetadata('vector_index_status', 'ready');
      this.store.setMetadata('vector_index_error', '');
      this.store.setMetadata('last_vector_index_at', String(Date.now()));
      return [];
    }
    const indexer = new VectorIndexer(this.embeddingProvider, this.vectorStores);
    let lastVectorPercent = -1;
    try {
      const results = await indexer.indexChunks(chunks, {
        onProgress: progress => {
          const percent = 85 + Math.round((progress.processedChunks / Math.max(1, progress.totalChunks)) * 14);
          if (percent === lastVectorPercent && progress.processedChunks < progress.totalChunks) return;
          lastVectorPercent = percent;
          const message = `正在分批向量化并写入：${progress.processedChunks}/${progress.totalChunks} 个切片`;
          this.reportProgress({ stage: 'vectorizing', percent, message, chunkCount: progress.totalChunks });
          if (options.relativePath) this.updateJobsForFile(options.relativePath, 'INDEXING', percent, message);
        },
      });
      const actualModel = results[0]?.embeddingModel ?? this.embeddingProvider.model;
      const actualDimension = results[0]?.embeddingDimension ?? this.embeddingProvider.dimensions;
      const totalChunks = this.getStats().chunkCount;
      this.store.setMetadata('embedding_model', actualModel);
      this.store.setMetadata('embedding_dimension', String(actualDimension));
      this.store.setMetadata('vector_indexed_chunks', String(totalChunks));
      this.store.setMetadata('vector_index_status', 'ready');
      this.store.setMetadata('vector_index_error', '');
      this.store.setMetadata('last_vector_index_at', String(Date.now()));
      if (options.relativePath) this.updateJobsForFile(options.relativePath, 'SUCCESS', 100, '解析、切片和向量索引完成');
      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setMetadata('vector_index_status', 'error');
      this.store.setMetadata('vector_index_error', message);
      this.store.setMetadata('last_vector_index_at', String(Date.now()));
      this.reportProgress({ stage: 'error', percent: 85, message: 'HNSWLib 向量入库失败', chunkCount: chunks.length, vectorStatus: this.getVectorStatus() });
      if (options.relativePath) this.updateJobsForFile(options.relativePath, 'ERROR', 100, 'HNSWLib 向量入库失败', message);
      return [];
    }
  }

  getProjectConfig(): ProjectConfig | undefined {
    return this.projectConfig;
  }

  getStats(): KnowledgeBaseStats {
    const stats = this.store.getStats();
    return {
      scope: this.scope,
      projectId: this.projectId,
      fileCount: stats.fileCount,
      chunkCount: stats.chunkCount,
      totalSizeBytes: stats.totalSizeBytes,
      lastIndexedAt: stats.lastIndexedAt,
    };
  }

  listIndexJobsByPrefix(prefix: string) {
    return this.store.listIndexJobsByPrefix(prefix);
  }

  countPendingIndexJobs(): number {
    return this.store.countPendingIndexJobs();
  }

  failPendingIndexJobs(message: string): void {
    for (const job of this.store.listPendingIndexJobs(1_000)) this.store.updateIndexJob(job.id, { status: 'ERROR', percent: 100, message, errorMessage: message });
  }

  getVectorStatus(): { status: string; error?: string; indexedChunks: number; lastIndexedAt: number; backend: string } {
    return {
      status: this.store.getMetadata('vector_index_status') ?? 'pending',
      error: this.store.getMetadata('vector_index_error') || undefined,
      indexedChunks: Number(this.store.getMetadata('vector_indexed_chunks') ?? 0),
      lastIndexedAt: Number(this.store.getMetadata('last_vector_index_at') ?? 0),
      backend: `SQLite + HNSWLib (${this.vectorRoot})`, 
    };
  }

  private async rewriteQueries(query: string): Promise<string[]> {
    const normalized = query.trim();
    const variants = new Set<string>([normalized]);

    // LLM 查询扩展（如果可用）
    if (this.llmProvider) {
      try {
        const llmQueries = await this.llmExpandQueries(normalized);
        for (const q of llmQueries) variants.add(q);
      } catch {
        // LLM 失败不影响原始查询
      }
    }

    return [...variants].filter(Boolean).slice(0, 6);
  }

  private async llmExpandQueries(query: string): Promise<string[]> {
    if (!this.llmProvider) return [];

    // TTL 缓存 + 在途去重：生成流程会在短时间内对相近查询重复扩展，
    // 缓存避免重复 LLM 调用；同一查询并发进入时复用同一 Promise
    const cached = this.queryExpansionCache.get(query);
    if (cached && cached.expiresAt > Date.now()) return cached.queries;
    const inFlight = this.queryExpansionInFlight.get(query);
    if (inFlight) return inFlight;

    const run = (async () => {
      const release = await this.acquireQueryExpansionSlot();
      try {
        const prompt = `你是一个搜索查询优化器。用户输入了一个搜索查询，请生成 3-5 个不同的查询变体，用不同的措辞和同义词来表达相同的信息需求，以便在知识库中检索到更全面的结果。

如果查询是中文，请同时生成英文变体；如果查询是英文，请同时生成中文变体。

直接输出查询列表，每行一个，不要编号或其他文字。

原始查询：${query}`;

        const response = await this.llmProvider!.chat([
          { role: 'system', content: '你是一个精确的搜索查询扩展引擎。只输出查询列表。' },
          { role: 'user', content: prompt },
        ], { temperature: 0.3, maxTokens: 500 });

        const queries = response.content
          .split('\n')
          .map(line => line.replace(/^[-*\d.]+\s*/, '').trim())
          .filter(line => line.length > 0 && line !== query)
          .slice(0, 5);
        if (this.queryExpansionCache.size >= QUERY_EXPANSION_CACHE_MAX) this.queryExpansionCache.clear();
        this.queryExpansionCache.set(query, { queries, expiresAt: Date.now() + QUERY_EXPANSION_TTL_MS });
        return queries;
      } finally {
        release();
        this.queryExpansionInFlight.delete(query);
      }
    })();
    this.queryExpansionInFlight.set(query, run);
    return run;
  }

  /** 查询扩展 LLM 调用的简易信号量：与文档生成端的全局信号量解耦，避免扩展请求无界并发击穿模型端点 */
  private acquireQueryExpansionSlot(): Promise<() => void> {
    return new Promise(resolve => {
      if (this.queryExpansionActive < QUERY_EXPANSION_MAX_CONCURRENCY) {
        this.queryExpansionActive += 1;
        resolve(this.releaseQueryExpansionSlot);
      } else {
        this.queryExpansionWaiters.push(() => {
          this.queryExpansionActive += 1;
          resolve(this.releaseQueryExpansionSlot);
        });
      }
    });
  }

  private releaseQueryExpansionSlot = () => {
    this.queryExpansionActive = Math.max(0, this.queryExpansionActive - 1);
    this.queryExpansionWaiters.shift()?.();
  };

  private retrievalWeights(overrides: RetrievalWeights = {}): Record<string, number> {
    return {
      keyword: overrides.keyword ?? Number(process.env.KB_RETRIEVAL_KEYWORD_WEIGHT ?? 1),
      vector: overrides.vector ?? Number(process.env.KB_RETRIEVAL_VECTOR_WEIGHT ?? 0.9),
      rewrite: overrides.rewrite ?? Number(process.env.KB_RETRIEVAL_REWRITE_WEIGHT ?? 0.72),
      hybridBonus: overrides.hybridBonus ?? Number(process.env.KB_RETRIEVAL_HYBRID_BONUS ?? 0.35),
      rerankPhrase: 120,
      rerankTerm: 8,
    };
  }

  private heuristicRerank(query: string, items: FederatedSearchItem[]): FederatedSearchItem[] {
    const terms = this.queryTerms(query);
    const phrase = query.toLowerCase().trim();
    const normalizedPhrase = this.normalizeSearchText(query);
    const factLabels = this.queryFactLabels(query);
    const wantsTable = /表|行|列|金额|数量|报价|评分|清单|明细|统计|数据/u.test(query);
    const wantsDrawing = /图纸|图层|轴网|标注|块|实体|cad|dwg|dxf|step|iges|模型/u.test(query);
    const wantsData = /json|xml|yaml|字段|配置|数据|路径|price|id|name/u.test(query);
    return items.map(item => {
      const rawContent = `${item.filePath}\n${item.titlePath ?? ''}\n${item.sectionTitle ?? ''}\n${item.chunkKind ?? ''}\n${item.content}`;
      const content = rawContent.toLowerCase();
      const normalizedContent = this.normalizeSearchText(rawContent);
      let rerankBoost = 0;
      if (phrase && content.includes(phrase)) rerankBoost += 160;
      if (normalizedPhrase.length >= 4 && normalizedContent.includes(normalizedPhrase)) rerankBoost += 220;
      const titleText = `${item.titlePath ?? ''}\n${item.sectionTitle ?? ''}`.toLowerCase();
      const normalizedTitle = this.normalizeSearchText(titleText);
      let matchedTermCount = 0;
      for (const term of terms) {
        if (!term) continue;
        const normalizedTerm = this.normalizeSearchText(term);
        const matchedContent = content.includes(term) || normalizedContent.includes(normalizedTerm);
        const matchedTitle = titleText.includes(term) || normalizedTitle.includes(normalizedTerm);
        if (matchedContent) {
          matchedTermCount += 1;
          rerankBoost += 12;
        }
        if (matchedTitle) rerankBoost += 22;
      }
      if (matchedTermCount >= 2) rerankBoost += matchedTermCount * 18;
      for (const label of factLabels) {
        const normalizedLabel = this.normalizeSearchText(label);
        if (normalizedContent.includes(normalizedLabel)) rerankBoost += 80;
        if (normalizedTitle.includes(normalizedLabel)) rerankBoost += 120;
      }
      if (item.chunkKind === 'table') rerankBoost += wantsTable ? 25 : -80;
      if (item.chunkKind === 'metadata') rerankBoost += wantsDrawing ? 60 : -100;
      if (item.chunkKind === 'data') rerankBoost += wantsData ? 30 : -12;
      if (/\.(?:dwg|dxf)(?:$|[?#])/iu.test(item.filePath)) {
        rerankBoost += wantsDrawing ? 120 : -60;
        if (this.isLowQualityCadText(item.content)) rerankBoost -= wantsDrawing ? 60 : 160;
      }
      if (/工作表：|COL\d+|专业工程暂估价计价表|分部分项工程量清单计价表|材料（工程设备）暂估单价一览表/u.test(item.content)) {
        rerankBoost -= wantsTable ? 35 : 140;
      }
      if (/第\s*\d+\s*页\s*共\s*\d+\s*页|PDF\s*第\s*\d+\s*页/iu.test(item.content) && factLabels.length > 0) rerankBoost -= 12;
      const score = item.score + rerankBoost;
      return {
        ...item,
        score,
        scoreDetails: {
          ...item.scoreDetails,
          rerankBoost,
          hybridScore: score,
        },
      };
    }).sort((a, b) => b.score - a.score);
  }

  private normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/\s+/gu, '');
  }

  private isLowQualityCadText(value: string): boolean {
    const compact = value.replace(/\s+/gu, '');
    if (compact.length === 0) return true;
    const readable = compact.match(/[\u4e00-\u9fa5A-Za-z0-9（）()【】《》、，。；;：:,.\-/㎡%]/gu)?.length || 0;
    return readable / compact.length < 0.55;
  }

  private queryTerms(query: string): string[] {
    const base = query.toLowerCase().split(/[\s,，。；;：:、]+/u).filter(Boolean);
    const labels = this.queryFactLabels(query).map(label => label.toLowerCase());
    return [...new Set([...base, ...labels].filter(term => term.length > 0))];
  }

  private queryFactLabels(query: string): string[] {
    const labels: string[] = [];
    if (/建设地点|工程地点|项目地点|地点|在哪里|位于/u.test(query)) labels.push('建设地点', '工程地点', '项目地点', '项目位于', '位于');
    if (/出资比例|资金比例|资金来源|出资/u.test(query)) labels.push('项目出资比例', '出资比例', '资金来源', '资金落实情况');
    if (/项目名称|招标项目名称|工程名称/u.test(query)) labels.push('招标项目名称', '工程名称', '项目名称');
    if (/项目编号|招标编号/u.test(query)) labels.push('招标项目编号', '项目编号');
    if (/工期|日历天|计划开工|计划竣工/u.test(query)) labels.push('计划工期', '总工期', '工期', '计划开工日期', '计划竣工日期');
    if (/质量标准|质量要求|合格/u.test(query)) labels.push('质量标准', '质量要求');
    if (/招标范围|工程范围|承包范围|施工范围/u.test(query)) labels.push('招标范围', '工程承包范围', '施工范围');
    if (/建设单位|招标人|项目业主/u.test(query)) labels.push('招标人', '项目业主', '建设单位');
    if (/临水|临电|临时水电|水电接引|接驳点|挂表计量|施工水电/u.test(query)) labels.push('临水临电', '临时水电接引', '施工水电接引费', '接驳点挂表计量', '挂表计量');
    if (/场地限制|材料堆场|办公区|生活区|加工区/u.test(query)) labels.push('场地限制', '不具备材料堆场', '搭设加工区', '搭设办公区', '搭设生活区');
    if (/拆除|修补|破损处|改造维修/u.test(query)) labels.push('改造维修项目', '拆除内容比较多', '破损处进行修补');
    return [...new Set(labels)];
  }



  private hydrateVectorResultsFromSqlite(items: FederatedSearchItem[]): FederatedSearchItem[] {
    // 批量按 rowid 取切片，避免对每条向量结果单发一次 SQL（N+1）
    const rowids = [...new Set(items.filter(item => item.rowid).map(item => item.rowid as number))];
    const chunksByRowid = new Map<number, StoredChunk>();
    for (const chunk of this.store.getChunksByRowids(rowids)) chunksByRowid.set(chunk.rowid, chunk);
    return items.map(item => {
      if (!item.rowid) return item;
      const chunk = chunksByRowid.get(item.rowid);
      if (!chunk) return item;
      const hydrated = this.toFederatedItem({ ...chunk, score: item.score, scoreDetails: item.scoreDetails }, 'vector');
      return { ...hydrated, score: item.score, scoreDetails: item.scoreDetails };
    });
  }

  private toFederatedItem(result: ChunkSearchResult, source: 'keyword' | 'vector' | 'hybrid'): FederatedSearchItem {
    const metadata = this.parseMetadata(result.metadataJson);
    return {
      id: result.id,
      rowid: result.rowid,
      content: result.content,
      filePath: result.relativePath,
      scope: this.scope === 'global' ? 'global' : 'project',
      collection: result.collectionName,
      score: result.score,
      chunkIndex: result.chunkIndex,
      parentId: this.metadataString(metadata.parentId),
      source,
      sectionTitle: result.sectionTitle,
      titlePath: result.titlePath ?? this.metadataString(metadata.titlePath),
      rowRange: result.rowRange ?? this.metadataString(metadata.rowRange),
      chunkKind: result.chunkKind ?? this.metadataString(metadata.chunkKind),
      startChar: result.startChar,
      endChar: result.endChar,
      scoreDetails: result.scoreDetails,
      facets: this.metadataFacets(metadata),
    };
  }

  private mergeHybridRankedLists(lists: Array<{ source: 'keyword' | 'vector'; items: FederatedSearchItem[]; queryIndex: number }>, limit: number, weights = this.retrievalWeights()): FederatedSearchItem[] {
    const k = Number(process.env.KB_RETRIEVAL_RRF_K ?? 60);
    const byKey = new Map<string, FederatedSearchItem & { seenSources?: Set<'keyword' | 'vector'> }>();
    for (const list of lists) {
      const sourceWeight = list.source === 'vector' ? (weights.vector ?? 0.9) : (weights.keyword ?? 1);
      const rewriteWeight = list.queryIndex === 0 ? 1 : (weights.rewrite ?? 0.72);
      list.items.forEach((item, index) => {
        const key = this.contextKey(item);
        const rankScore = sourceWeight * rewriteWeight / (k + index + 1);
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, {
            ...item,
            score: rankScore,
            source: list.source,
            scoreDetails: { ...item.scoreDetails, hybridScore: rankScore },
            seenSources: new Set([list.source]),
          });
          return;
        }
        existing.score += rankScore;
        existing.seenSources?.add(list.source);
        existing.source = existing.seenSources && existing.seenSources.size > 1 ? 'hybrid' : existing.source;
        existing.scoreDetails = { ...existing.scoreDetails, ...item.scoreDetails, hybridScore: existing.score };
        if (item.score > (existing.scoreDetails?.keywordScore ?? existing.scoreDetails?.vectorScore ?? 0)) {
          existing.content = item.content;
          existing.sectionTitle = item.sectionTitle ?? existing.sectionTitle;
          existing.titlePath = item.titlePath ?? existing.titlePath;
          existing.chunkIndex = item.chunkIndex ?? existing.chunkIndex;
          existing.parentId = item.parentId ?? existing.parentId;
          existing.chunkKind = item.chunkKind ?? existing.chunkKind;
          existing.rowRange = item.rowRange ?? existing.rowRange;
        }
      });
    }
    const hybridBonus = weights.hybridBonus ?? 0.35;
    return [...byKey.values()].map(item => {
      const bonus = item.seenSources && item.seenSources.size > 1 ? item.score * hybridBonus : 0;
      const { seenSources: _seenSources, ...result } = item;
      return { ...result, score: result.score + bonus, scoreDetails: { ...result.scoreDetails, hybridScore: result.score + bonus } };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private mergeContexts(items: FederatedSearchItem[], limit: number): FederatedSearchItem[] {
    const byKey = new Map<string, FederatedSearchItem>();
    for (const item of items) {
      const key = this.contextKey(item);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, item);
        continue;
      }
      const score = Math.max(existing.score, item.score);
      byKey.set(key, {
        ...existing,
        score,
        source: existing.source === item.source ? existing.source : 'hybrid',
        content: existing.content.length >= item.content.length ? existing.content : item.content,
        scoreDetails: { ...existing.scoreDetails, ...item.scoreDetails, hybridScore: score },
      });
    }
    return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private mergeExpandedContexts(items: FederatedSearchItem[], limit: number): FederatedSearchItem[] {
    const byKey = new Map<string, FederatedSearchItem>();
    for (const item of items) {
      const key = `${item.scope}:${item.filePath}:${item.parentId ?? item.chunkIndex ?? item.id}`;
      const existing = byKey.get(key);
      if (!existing || item.score > existing.score) {
        byKey.set(key, item);
        continue;
      }
      existing.source = existing.source === item.source ? existing.source : 'hybrid';
      existing.scoreDetails = { ...existing.scoreDetails, ...item.scoreDetails, hybridScore: existing.score };
    }
    return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private contextKey(item: FederatedSearchItem): string {
    if (item.rowid) return `${item.scope}:rowid:${item.rowid}`;
    return `${item.scope}:${item.filePath}:${item.parentId ?? item.chunkIndex ?? item.id}`;
  }

  private parseChunkIndex(id: string): number {
    const match = /#(\d+)$/u.exec(id);
    return match ? Number(match[1]) : 0;
  }

  private parseMetadataString(metadataJson: string | undefined, key: string): string | undefined {
    return this.metadataString(this.parseMetadata(metadataJson)[key]);
  }

  private parseMetadata(metadataJson: string | undefined): Record<string, unknown> {
    if (!metadataJson) return {};
    try { return JSON.parse(metadataJson) as Record<string, unknown>; } catch { return {}; }
  }

  private metadataString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private metadataFacets(metadata: Record<string, unknown>): Record<string, string | number | string[]> {
    const keys = ['titlePath', 'sectionTitle', 'chunkKind', 'rowRange', 'sheetNames', 'columnNames', 'rowCount', 'columnCount', 'dataPaths', 'layerNames', 'blockNames', 'entityTypes', 'productNames', 'materialNames', 'ocrRecommended', 'ocrReason'];
    const facets: Record<string, string | number | string[]> = {};
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === 'string' || typeof value === 'number') facets[key] = value;
      if (typeof value === 'boolean') facets[key] = String(value);
      if (Array.isArray(value)) facets[key] = value.filter(item => typeof item === 'string').slice(0, 12) as string[];
    }
    return facets;
  }

  close(): void {
    this.store.close();
    for (const store of this.vectorStores.values()) {
      if ('close' in store && typeof store.close === 'function') store.close();
    }
  }

  private reportProgress(progress: KnowledgeIndexProgress): void {
    this.onProgress?.(progress);
  }

  private updateJobsForFile(relativePath: string, status: 'PARSING' | 'CHUNKING' | 'INDEXING' | 'SUCCESS' | 'ERROR', percent: number, message: string, errorMessage?: string): void {
    for (const job of this.store.listActiveIndexJobsByPath(relativePath)) {
      this.store.updateIndexJob(job.id, { status, percent, message, errorMessage });
    }
  }

  private ensureVectorStore(collectionName: string): void {
    if (this.vectorStores.has(collectionName)) return;
    const safeName = collectionName.replace(/[^a-zA-Z0-9_.-]/gu, '_');
    this.vectorStores.set(collectionName, new HNSWVectorStore(collectionName, path.join(this.vectorRoot, `${safeName}.hnsw`), this.embeddingProvider.dimensions));
  }

  private async deleteVectorFile(collectionName: string, relativePath: string): Promise<void> {
    this.ensureVectorStore(collectionName);
    try {
      await this.vectorStores.get(collectionName)?.deleteByFilePath(relativePath);
    } catch (error) {
      this.store.setMetadata('vector_index_status', 'error');
      this.store.setMetadata('vector_index_error', error instanceof Error ? error.message : String(error));
    }
  }

  private consumePendingVectorRelativePaths(): string[] {
    const raw = this.store.getMetadata('vector_pending_relative_paths');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      this.store.setMetadata('vector_pending_relative_paths', '');
      return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))];
    } catch {
      this.store.setMetadata('vector_pending_relative_paths', '');
      return [];
    }
  }

  private async ensureVectorIndexFresh(chunkCount: number, options: { changedRelativePaths?: string[]; changedCollectionNames?: Set<string>; deletesApplied?: number; rebuild?: boolean } = {}): Promise<void> {
    if (chunkCount === 0) return;
    for (const record of this.store.listRecords()) this.ensureVectorStore(record.collectionName);
    if (options.rebuild || [...this.vectorStores.values()].some(store => store.needsRebuild?.())) {
      await this.indexVectors({ rebuild: true });
      return;
    }
    const indexedChunks = Number(this.store.getMetadata('vector_indexed_chunks') ?? 0);
    const status = this.store.getMetadata('vector_index_status');
    const changedRelativePaths = [...new Set(options.changedRelativePaths ?? [])];
    if (changedRelativePaths.length === 0 && options.deletesApplied && status === 'ready') {
      this.store.setMetadata('vector_indexed_chunks', String(chunkCount));
      this.store.setMetadata('vector_index_status', 'ready');
      this.store.setMetadata('vector_index_error', '');
      this.store.setMetadata('last_vector_index_at', String(Date.now()));
      return;
    }
    if (changedRelativePaths.length > 0) {
      for (const collectionName of options.changedCollectionNames ?? []) this.ensureVectorStore(collectionName);
      await this.indexVectors({ relativePaths: changedRelativePaths, cleanupCollectionNames: options.changedCollectionNames });
      return;
    }
    if (indexedChunks === chunkCount && status === 'ready') return;
    if (status === 'pending' || status === 'partial') return;
    await this.indexVectors({ rebuild: true });
  }

  uploadSessionIsOpen(operationId: string): boolean {
    return this.store.getMetadata(`upload_session:${operationId}`) === 'open';
  }

  listOpenUploadSessions(): string[] {
    this.initialize();
    const prefix = 'upload_session:';
    return this.store.listMetadataKeys(prefix)
      .filter(key => this.store.getMetadata(key) === 'open')
      .map(key => key.slice(prefix.length));
  }

  hasOpenUploadSessions(): boolean {
    this.initialize();
    const prefix = 'upload_session:';
    return this.store.listMetadataKeys(prefix).some(key => this.store.getMetadata(key) === 'open');
  }

  private emptyDiff(): DiffResult {
    return { newFiles: [], modifiedFiles: [], deletedFiles: [], unchangedCount: 0, mtimeOnlyCount: 0, skippedFiles: [], hasChanges: false, diffTimeMs: 0 };
  }

  private statRelativePaths(relativePaths: string[]): Map<string, { size: number; mtime: number }> {
    const files = new Map<string, { size: number; mtime: number }>();
    for (const relativePath of relativePaths) {
      const normalized = this.normalizeRelativePath(relativePath);
      const absolutePath = this.resolveKbRelativePath(normalized);
      if (!fs.existsSync(absolutePath)) continue;
      const stat = fs.statSync(absolutePath);
      if (stat.isFile()) files.set(normalized, { size: stat.size, mtime: stat.mtimeMs });
    }
    return files;
  }

  private moveUploadedFile(sourcePath: string, targetPath: string): void {
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
    try {
      fs.renameSync(sourcePath, targetPath);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code !== 'EXDEV') throw error;
      fs.copyFileSync(sourcePath, targetPath);
      fs.rmSync(sourcePath, { force: true });
    }
  }

  private hasUsableContent(text: string, metadata: Record<string, unknown>): boolean {
    const coverage = String(metadata.contentCoverage ?? '');
    if (['metadata', 'metadata_filename', 'pdf_metadata_only', 'office_zip_empty_text', 'office_zip_failed'].includes(coverage)) return false;
    return text.trim().length > 0;
  }

  private isMetadataOnlyNonBlocking(file: ClassifiedFile, metadata: Record<string, unknown>): boolean {
    const coverage = String(metadata.contentCoverage ?? '');
    return file.category === 'image' && ['image_too_small_for_ocr', 'ocr_no_text'].includes(coverage);
  }

  private defaultUploadRelativePath(fileName: string): string {
    const classification = this.classifier.classifyVirtual(fileName);
    const configDirs = this.projectConfig?.categoryDirs ?? DEFAULT_CATEGORY_DIRS;
    const dir = configDirs[classification.category] ?? DEFAULT_CATEGORY_DIRS[classification.category];
    return `${dir}/${path.basename(fileName)}`;
  }

  private validateUploadRelativePath(relativePath: string): string {
    const normalized = this.normalizeRelativePath(relativePath);
    if (!normalized || normalized === '.') throw new Error('上传文件路径无效');
    if (normalized.length > 1000) throw new Error('上传文件路径过长，请缩短文件夹层级或文件名');
    if (normalized.includes('\0')) throw new Error('上传文件路径包含非法字符');
    const parts = normalized.split('/');
    if (parts.some(part => !part || part === '..')) throw new Error('上传文件路径无效');
    if (parts.some(part => part.length > 255)) throw new Error('上传文件名过长，请缩短文件名后重试');
    return normalized;
  }

  private resolveKbRelativePath(relativePath: string): string {
    const normalized = this.normalizeRelativePath(relativePath);
    const targetPath = path.resolve(this.kbPath, normalized);
    const root = path.resolve(this.kbPath);
    if (targetPath !== root && !targetPath.startsWith(`${root}${path.sep}`)) {
      throw new Error('relativePath escapes knowledge base root');
    }
    return targetPath;
  }

  private normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/\\/gu, '/').split(path.sep).join('/').replace(/^\/+/, '').replace(/\/+/gu, '/');
  }
}
