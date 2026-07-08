import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { VectorDocument, VectorSearchQuery, VectorSearchResult, VectorStoreInterface } from './types.js';

type HierarchicalNSW = {
  initIndex(maxElements: number, m?: number, efConstruction?: number, randomSeed?: number, allowReplaceDeleted?: boolean): void;
  readIndexSync(filePath: string, allowReplaceDeleted?: boolean): void;
  writeIndexSync(filePath: string): void;
  addPoint(vector: number[], id: number, replaceDeleted?: boolean): void;
  searchKnn(vector: number[], topK: number): { neighbors: number[]; distances: number[] };
  markDelete(id: number): void;
};

type HnswModule = { HierarchicalNSW: new (space: string, dimensions: number) => HierarchicalNSW };
const require = createRequire(import.meta.url);

export class HNSWVectorStore implements VectorStoreInterface {
  private index?: HierarchicalNSW;
  private deletedSinceRebuild = 0;
  private readonly documents = new Map<number, VectorDocument>();

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

  async upsert(documents: VectorDocument[]): Promise<void> {
    await this.ensureCollection();
    for (const document of documents) {
      const rowid = Number(document.metadata.sqlite_rowid);
      if (!Number.isFinite(rowid) || rowid <= 0) throw new Error(`HNSW 向量写入缺少有效 sqlite_rowid: ${document.id}`);
      this.index!.addPoint(document.embedding, rowid, true);
      this.documents.set(rowid, document);
    }
    this.persist();
  }

  async clearCollection(): Promise<void> {
    if (fs.existsSync(this.indexPath)) fs.rmSync(this.indexPath, { force: true });
    if (fs.existsSync(this.metadataPath())) fs.rmSync(this.metadataPath(), { force: true });
    this.documents.clear();
    this.deletedSinceRebuild = 0;
    this.index = undefined;
    await this.ensureCollection();
  }

  async deleteByFilePath(filePath: string): Promise<void> {
    await this.ensureCollection();
    for (const [rowid, document] of this.documents.entries()) {
      if (document.metadata.file_path === filePath) {
        try { this.index!.markDelete(rowid); this.deletedSinceRebuild += 1; } catch { /* ignore missing labels */ }
        this.documents.delete(rowid);
      }
    }
    this.persist();
  }

  needsRebuild(): boolean {
    const total = this.documents.size + this.deletedSinceRebuild;
    return total >= 1000 && this.deletedSinceRebuild / total > 0.25;
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    await this.ensureCollection();
    const result = this.index!.searchKnn(query.queryEmbedding, query.topK);
    return result.neighbors.flatMap((rowid, index) => {
      const document = this.documents.get(rowid);
      if (!document) return [];
      if (typeof query.where?.file_path === 'string' && document.metadata.file_path !== query.where.file_path) return [];
      const { embedding: _embedding, ...stored } = document;
      const distance = result.distances[index] ?? 0;
      return [{ collection: this.collectionName, document: stored, score: 1 / (1 + distance) }];
    });
  }

  private persist(): void {
    this.index!.writeIndexSync(this.indexPath);
    fs.writeFileSync(this.metadataPath(), JSON.stringify({ deletedSinceRebuild: this.deletedSinceRebuild, documents: [...this.documents.entries()] }), 'utf8');
  }

  private loadDocuments(): void {
    const file = this.metadataPath();
    if (!fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { deletedSinceRebuild?: number; documents?: Array<[number, VectorDocument]> } | Array<[number, VectorDocument]>;
      const entries = Array.isArray(parsed) ? parsed : parsed.documents ?? [];
      this.deletedSinceRebuild = Array.isArray(parsed) ? 0 : Number(parsed.deletedSinceRebuild ?? 0);
      this.documents.clear();
      for (const [rowid, document] of entries) this.documents.set(Number(rowid), document);
    } catch {
      this.documents.clear();
    }
  }

  private metadataPath(): string {
    return `${this.indexPath}.documents.json`;
  }
}
