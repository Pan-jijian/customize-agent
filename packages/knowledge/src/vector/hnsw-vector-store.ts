import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { VectorDocument, VectorSearchQuery, VectorSearchResult, VectorStoreInterface, VectorWriteOptions } from './types.js';

type HierarchicalNSW = {
  initIndex(maxElements: number, m?: number, efConstruction?: number, randomSeed?: number, allowReplaceDeleted?: boolean): void;
  readIndexSync(filePath: string, allowReplaceDeleted?: boolean): void;
  writeIndexSync(filePath: string): void;
  addPoint(vector: number[], id: number, replaceDeleted?: boolean): void;
  searchKnn(vector: number[], topK: number): { neighbors: number[]; distances: number[] };
  markDelete(id: number): void;
};

type HnswModule = { HierarchicalNSW: new (space: string, dimensions: number) => HierarchicalNSW };
type StoredVectorDocument = Omit<VectorDocument, 'embedding'> & { embedding?: number[] };
const require = createRequire(import.meta.url);

/** HNSW（分层可导航小世界图）向量存储，基于 hnswlib-node 实现的高效近似最近邻搜索 */
export class HNSWVectorStore implements VectorStoreInterface {
  private index?: HierarchicalNSW;
  private deletedSinceRebuild = 0;
  private dirty = false;
  private readonly documents = new Map<number, StoredVectorDocument>();

  constructor(
    readonly collectionName: string,
    private readonly indexPath: string,
    private readonly dimensions = 512,
    private readonly maxElements = 500_000,
  ) {}

  async ensureCollection(): Promise<void> {
    if (this.index) return;
    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true });
    this.loadDocuments();
    const mod = require('hnswlib-node') as HnswModule;
    this.index = new mod.HierarchicalNSW('cosine', this.dimensions);
    if (fs.existsSync(this.indexPath)) this.index.readIndexSync(this.indexPath, true);
    else this.index.initIndex(this.maxElements, 16, 200, 100, true);
  }

  async upsert(documents: VectorDocument[], options: VectorWriteOptions = {}): Promise<void> {
    await this.ensureCollection();
    for (const document of documents) {
      const rowid = Number(document.metadata.sqlite_rowid);
      if (!Number.isFinite(rowid) || rowid <= 0) throw new Error(`HNSW 向量写入缺少有效 sqlite_rowid: ${document.id}`);
      this.index!.addPoint(document.embedding, rowid, true);
      this.documents.set(rowid, this.toStoredDocument(document));
      this.dirty = true;
    }
    if (options.persist !== false) this.persist();
  }

  async clearCollection(): Promise<void> {
    if (fs.existsSync(this.indexPath)) fs.rmSync(this.indexPath, { force: true });
    if (fs.existsSync(this.metadataPath())) fs.rmSync(this.metadataPath(), { force: true });
    this.documents.clear();
    this.deletedSinceRebuild = 0;
    this.dirty = false;
    this.index = undefined;
    await this.ensureCollection();
  }

  async deleteByFilePath(filePath: string, options: VectorWriteOptions = {}): Promise<void> {
    await this.ensureCollection();
    for (const [rowid, document] of this.documents.entries()) {
      if (document.metadata.file_path === filePath) {
        try { this.index!.markDelete(rowid); this.deletedSinceRebuild += 1; } catch { /* 忽略缺失的标签 */ }
        this.documents.delete(rowid);
        this.dirty = true;
      }
    }
    if (options.persist !== false) this.persist();
  }

  async flush(): Promise<void> {
    await this.ensureCollection();
    if (this.dirty) this.persist();
  }

  needsRebuild(): boolean {
    const total = this.documents.size + this.deletedSinceRebuild;
    return total >= 1000 && this.deletedSinceRebuild / total > 0.25;
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    await this.ensureCollection();
    const hasFilter = !!query.where && Object.keys(query.where).length > 0;
    const candidateK = hasFilter ? Math.min(this.documents.size, Math.max(query.topK * 10, query.topK + 50)) : query.topK;
    const result = this.index!.searchKnn(query.queryEmbedding, candidateK);
    return result.neighbors.flatMap((rowid, index) => {
      const document = this.documents.get(rowid);
      if (!document || !this.matchesWhere(document, query.where)) return [];
      const { embedding: _embedding, ...stored } = document;
      const distance = result.distances[index] ?? 0;
      return [{ collection: this.collectionName, document: stored, score: 1 / (1 + distance) }];
    }).slice(0, query.topK);
  }

  private matchesWhere(document: StoredVectorDocument, where?: Record<string, string | number | boolean>): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => document.metadata[key] === value);
  }

  private persist(): void {
    this.index!.writeIndexSync(this.indexPath);
    fs.writeFileSync(this.metadataPath(), JSON.stringify({ deletedSinceRebuild: this.deletedSinceRebuild, documents: [...this.documents.entries()] }), 'utf8');
    this.dirty = false;
  }

  private toStoredDocument(document: VectorDocument): StoredVectorDocument {
    return {
      id: document.id,
      content: '',
      metadata: document.metadata,
    };
  }

  private loadDocuments(): void {
    const file = this.metadataPath();
    if (!fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { deletedSinceRebuild?: number; documents?: Array<[number, StoredVectorDocument]> } | Array<[number, StoredVectorDocument]>;
      const entries = Array.isArray(parsed) ? parsed : parsed.documents ?? [];
      this.deletedSinceRebuild = Array.isArray(parsed) ? 0 : Number(parsed.deletedSinceRebuild ?? 0);
      this.documents.clear();
      for (const [rowid, document] of entries) this.documents.set(Number(rowid), { id: document.id, content: document.content ?? '', metadata: document.metadata });
    } catch {
      this.documents.clear();
    }
  }

  private metadataPath(): string {
    return `${this.indexPath}.documents.json`;
  }
}
