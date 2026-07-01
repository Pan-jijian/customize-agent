import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TextChunker } from '../chunking/text-chunker.js';
import { FileClassifier } from '../classification/classifier.js';
import { ALL_CATEGORIES, DEFAULT_CATEGORY_DIRS, GLOBAL_KNOWLEDGE_DIR, USER_DATA_DIR } from '../constants.js';
import { DedupEngine } from '../dedup/dedup-engine.js';
import { RelationshipDetector } from '../dedup/relationship-detector.js';
import { HashEmbeddingProvider, type EmbeddingProvider } from '../embedding/embedding-provider.js';
import { ContentExtractor } from '../extraction/content-extractor.js';
import type { ExternalExtractorRegistry } from '../extraction/external-extractor.js';
import { FederationSearch, type FederatedResult, type SearchFilters } from '../search/federation-search.js';
import type { DiffResult, IndexStateRecord, KBScope, KnowledgeBaseStats, ProjectConfig } from '../types.js';
import { CollectionManager } from '../vector/collection-manager.js';
import type { VectorStoreInterface } from '../vector/types.js';
import { VectorIndexer, type VectorIndexResult } from '../vector/vector-indexer.js';
import { ChangeTracker } from './change-tracker.js';
import { KnowledgeFileScanner } from './file-scanner.js';
import { IndexStateStore, type ChunkSearchResult, type FileRelationship } from './index-state-store.js';
import { getProjectKbPath, ProjectConfigManager } from './project-config.js';

export interface KnowledgeBaseManagerOptions {
  scope: Exclude<KBScope, 'session'>;
  projectRoot?: string;
  projectId?: string;
  kbPath?: string;
  storageRoot?: string;
  embeddingProvider?: EmbeddingProvider;
  vectorStores?: Map<string, VectorStoreInterface>;
  externalExtractors?: ExternalExtractorRegistry;
}

export class KnowledgeBaseManager {
  readonly scope: Exclude<KBScope, 'session'>;
  readonly projectRoot?: string;
  readonly projectId?: string;
  readonly kbPath: string;
  readonly store: IndexStateStore;

  private readonly classifier = new FileClassifier();
  private readonly scanner = new KnowledgeFileScanner();
  private readonly collections = new CollectionManager();
  private readonly extractor: ContentExtractor;
  private readonly chunker = new TextChunker();
  private readonly dedup = new DedupEngine();
  private readonly relationshipDetector = new RelationshipDetector();
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly vectorStores: Map<string, VectorStoreInterface>;
  private readonly configManager = new ProjectConfigManager();
  private projectConfig?: ProjectConfig;
  private lastSkippedFiles: DiffResult['skippedFiles'] = [];

  constructor(options: KnowledgeBaseManagerOptions) {
    this.scope = options.scope;
    this.projectRoot = options.projectRoot;
    this.projectId = options.projectId;
    this.embeddingProvider = options.embeddingProvider ?? new HashEmbeddingProvider();
    this.vectorStores = options.vectorStores ?? new Map();
    this.extractor = new ContentExtractor(options.externalExtractors);

    const storageRoot = options.storageRoot ?? path.join(os.homedir(), USER_DATA_DIR);
    if (this.scope === 'global') {
      this.kbPath = options.kbPath ?? path.join(storageRoot, GLOBAL_KNOWLEDGE_DIR);
      this.store = new IndexStateStore(path.join(storageRoot, 'global-knowledge.db'));
    } else {
      if (!options.projectRoot || !options.projectId) {
        throw new Error('project knowledge base requires projectRoot and projectId');
      }
      this.kbPath = options.kbPath ?? getProjectKbPath(options.projectRoot);
      this.store = new IndexStateStore(path.join(storageRoot, 'projects', options.projectId, 'kb.db'));
    }
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

  async incrementalIndex(): Promise<DiffResult> {
    this.initialize();

    const kbIgnore = this.scanner.loadKbIgnore(this.kbPath);
    const configIgnore = this.projectConfig?.kbignore ?? [];
    const diskFiles = await this.scanner.scan(this.kbPath, [...kbIgnore, ...configIgnore]);
    const tracker = new ChangeTracker(this.store);
    const diff = await tracker.computeDiff(diskFiles, this.classifier, this.kbPath);

    for (const deleted of diff.deletedFiles) {
      this.store.deleteRecord(deleted.relativePath);
    }

    const now = Date.now();
    const indexedBefore = [...this.store.loadActiveRecords().values()];
    for (const file of [...diff.newFiles, ...diff.modifiedFiles]) {
      const hash = tracker.hashFile(file.absolutePath);
      const duplicate = this.store.findExactDuplicate(hash, file.relativePath);
      const extraction = await this.extractor.extract(file);
      if (!this.hasUsableContent(extraction.text, extraction.metadata)) {
        diff.skippedFiles.push({ file, reason: extraction.warnings[0] ?? '未解析出可用于模型的正文内容，已跳过向量化' });
        this.store.deleteRecord(file.relativePath);
        continue;
      }
      const normalizedHash = this.dedup.normalizedHash(extraction.text);
      const normalizedDuplicate = !duplicate && normalizedHash
        ? this.store.findNormalizedDuplicate(normalizedHash, file.relativePath)
        : undefined;
      const chunks = duplicate ? [] : this.chunker.chunk(extraction.text, file, extraction.metadata);
      const collectionName = this.scope === 'global'
        ? this.collections.getCollectionName('global', file.category)
        : this.collections.getCollectionName('project', file.category, this.projectId);

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
          for (const existing of this.store.listMinHashes(file.relativePath)) {
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
    }

    const stats = this.getStats();
    this.store.setMetadata('last_incremental_index_at', String(now));
    this.store.setMetadata('total_chunks', String(stats.chunkCount));
    this.store.setMetadata('total_files_indexed', String(stats.fileCount));
    this.lastSkippedFiles = diff.skippedFiles;

    return diff;
  }

  search(query: string, limit = 10): ChunkSearchResult[] {
    return this.store.searchChunks(query, limit);
  }

  async semanticSearch(query: string, options: { limit?: number; filters?: SearchFilters; collections?: string[] } = {}): Promise<FederatedResult> {
    const queryEmbedding = await this.embeddingProvider.embedQuery(query);
    const search = new FederationSearch(this.vectorStores);
    return search.search({
      query,
      queryEmbedding,
      topK: options.limit ?? 10,
      scope: this.scope,
      projectId: this.projectId,
      collections: options.collections,
      filters: options.filters,
    });
  }

  listRelationships(filePath?: string): FileRelationship[] {
    return this.store.listRelationships(filePath);
  }

  listFiles(): IndexStateRecord[] {
    return this.store.listRecords();
  }

  async addFile(sourcePath: string, targetRelativePath?: string): Promise<DiffResult> {
    this.initialize();
    const resolvedSource = path.resolve(sourcePath);
    const relativePath = targetRelativePath ?? path.basename(resolvedSource);
    const targetPath = this.resolveKbRelativePath(relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(resolvedSource, targetPath);
    return this.incrementalIndex();
  }

  async uploadFile(fileName: string, content: Buffer, targetRelativePath?: string): Promise<DiffResult> {
    this.initialize();
    const relativePath = targetRelativePath ?? this.defaultUploadRelativePath(fileName);
    const targetPath = this.resolveKbRelativePath(relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
    return this.incrementalIndex();
  }

  listFailedFiles(): DiffResult['skippedFiles'] {
    return this.lastSkippedFiles;
  }

  async removeFile(relativePath: string): Promise<void> {
    const targetPath = this.resolveKbRelativePath(relativePath);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    this.store.deleteRecord(this.normalizeRelativePath(relativePath));
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

  async indexVectors(options: { collectionName?: string; relativePath?: string; limit?: number } = {}): Promise<VectorIndexResult[]> {
    const chunks = this.store.listChunks(options);
    const indexer = new VectorIndexer(this.embeddingProvider, this.vectorStores);
    const results = await indexer.indexChunks(chunks);
    this.store.setMetadata('embedding_model', this.embeddingProvider.model);
    this.store.setMetadata('embedding_dimension', String(this.embeddingProvider.dimensions));
    this.store.setMetadata('last_vector_index_at', String(Date.now()));
    return results;
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

  close(): void {
    this.store.close();
  }

  private hasUsableContent(text: string, metadata: Record<string, unknown>): boolean {
    const coverage = String(metadata.contentCoverage ?? '');
    if (coverage === 'metadata' || coverage === 'metadata_filename') return false;
    return text.trim().length > 0;
  }

  private defaultUploadRelativePath(fileName: string): string {
    const classification = this.classifier.classifyVirtual(fileName);
    const configDirs = this.projectConfig?.categoryDirs ?? DEFAULT_CATEGORY_DIRS;
    const dir = configDirs[classification.category] ?? DEFAULT_CATEGORY_DIRS[classification.category];
    return `${dir}/${path.basename(fileName)}`;
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
    return relativePath.split(path.sep).join('/').replace(/^\/+/, '');
  }
}
