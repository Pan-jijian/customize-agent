import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import type { CollectionClient, VectorCollectionInfo, VectorDocument, VectorSearchQuery, VectorSearchResult, VectorStoreInterface } from './types.js';

interface CollectionRecord {
  name: string;
  table_name: string;
  dimension: number;
  metadata_json: string | null;
}

interface SearchRow {
  id: string;
  content: string;
  metadata_json: string | null;
  distance: number;
}

export interface SQLiteVecClientOptions {
  dbPath: string;
}

export class SQLiteVecClient implements CollectionClient {
  readonly dbPath: string;
  private readonly db: Database.Database;

  constructor(options: SQLiteVecClientOptions) {
    this.dbPath = options.dbPath;
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    sqliteVec.load(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vector_collections (
        name TEXT PRIMARY KEY,
        table_name TEXT NOT NULL UNIQUE,
        dimension INTEGER NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vector_documents (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_name TEXT NOT NULL,
        id TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
                file_path TEXT,
                vector_rowid INTEGER,
                created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(collection_name, id)
      );
      CREATE INDEX IF NOT EXISTS idx_vector_documents_collection_file ON vector_documents(collection_name, file_path);
    `);
    try {
      this.db.exec('ALTER TABLE vector_documents ADD COLUMN vector_rowid INTEGER');
    } catch { /* column already exists */ }
  }

  async getOrCreateCollection(name: string, metadata: Record<string, unknown> = {}): Promise<VectorCollectionInfo> {
    const existing = this.getCollection(name);
    const dimension = Number(metadata.embedding_dimension ?? 384);
    if (existing) {
      if (Number(existing.dimension) === dimension) return { name: existing.name, metadata: this.parseMetadata(existing.metadata_json) };
      await this.deleteCollection(name);
    }

    const tableName = this.tableName(name);
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(embedding float[${dimension}])`);
    this.db.prepare(`
      INSERT INTO vector_collections (name, table_name, dimension, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, tableName, dimension, JSON.stringify(metadata), Date.now());
    return { name, metadata };
  }

  async listCollections(): Promise<VectorCollectionInfo[]> {
    return this.db.prepare('SELECT name, metadata_json FROM vector_collections ORDER BY name').all()
      .map(row => {
        const record = row as Pick<CollectionRecord, 'name' | 'metadata_json'>;
        return { name: record.name, metadata: this.parseMetadata(record.metadata_json) };
      });
  }

  async deleteCollection(name: string): Promise<void> {
    const collection = this.getCollection(name);
    if (!collection) return;
    this.db.exec(`DROP TABLE IF EXISTS ${collection.table_name}`);
    this.db.prepare('DELETE FROM vector_documents WHERE collection_name = ?').run(name);
    this.db.prepare('DELETE FROM vector_collections WHERE name = ?').run(name);
  }

  upsert(collectionName: string, documents: VectorDocument[]): void {
    if (documents.length === 0) return;
    const collection = this.requireCollection(collectionName);
    const deleteVec = this.db.prepare(`DELETE FROM ${collection.table_name} WHERE rowid = ?`);
    const deleteDoc = this.db.prepare('DELETE FROM vector_documents WHERE collection_name = ? AND id = ?');
    const insertDoc = this.db.prepare(`
      INSERT INTO vector_documents (collection_name, id, content, metadata_json, file_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const updateVectorRowid = this.db.prepare('UPDATE vector_documents SET vector_rowid = ? WHERE rowid = ?');
    const insertVec = this.db.prepare(`INSERT INTO ${collection.table_name} (embedding) VALUES (vec_f32(?))`);
    const existingRow = this.db.prepare('SELECT rowid, vector_rowid FROM vector_documents WHERE collection_name = ? AND id = ?');
    const transaction = this.db.transaction((items: VectorDocument[]) => {
      for (const document of items) {
        const existing = existingRow.get(collectionName, document.id) as { rowid: number; vector_rowid: number | null } | undefined;
        if (existing?.vector_rowid) deleteVec.run(existing.vector_rowid);
        deleteDoc.run(collectionName, document.id);
        const now = Date.now();
        const metadataJson = JSON.stringify(document.metadata);
        const filePath = this.metadataString(document.metadata.file_path);
        const documentResult = insertDoc.run(collectionName, document.id, document.content, metadataJson, filePath, now, now);
        const vectorResult = insertVec.run(JSON.stringify(document.embedding));
        updateVectorRowid.run(Number(vectorResult.lastInsertRowid), Number(documentResult.lastInsertRowid));
      }
    });
    transaction(documents);
  }

  deleteWhere(collectionName: string, where: Record<string, string | number | boolean>): void {
    if (typeof where.file_path !== 'string') return;
    this.deleteByFilePath(collectionName, where.file_path);
  }

  deleteByFilePath(collectionName: string, filePath: string): void {
    const collection = this.getCollection(collectionName);
    if (!collection) return;
    const rows = this.db.prepare('SELECT vector_rowid FROM vector_documents WHERE collection_name = ? AND file_path = ?').all(collectionName, filePath) as Array<{ vector_rowid: number | null }>;
    const deleteVec = this.db.prepare(`DELETE FROM ${collection.table_name} WHERE rowid = ?`);
    const deleteDocs = this.db.prepare('DELETE FROM vector_documents WHERE collection_name = ? AND file_path = ?');
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        if (row.vector_rowid) deleteVec.run(row.vector_rowid);
      }
      deleteDocs.run(collectionName, filePath);
    });
    transaction();
  }

  search(collectionName: string, query: VectorSearchQuery): SearchRow[] {
    const collection = this.getCollection(collectionName);
    if (!collection) return [];
    const filePath = query.where?.file_path;
    if (typeof filePath === 'string') {
      return this.db.prepare(`
        SELECT d.id, d.content, d.metadata_json, v.distance
        FROM (
          SELECT rowid, distance
          FROM ${collection.table_name}
          WHERE embedding MATCH vec_f32(?) AND k = ?
        ) v
        JOIN vector_documents d ON d.vector_rowid = v.rowid
        WHERE d.file_path = ?
        ORDER BY v.distance
      `).all(JSON.stringify(query.queryEmbedding), query.topK, filePath) as SearchRow[];
    }
    return this.db.prepare(`
      SELECT d.id, d.content, d.metadata_json, v.distance
      FROM (
        SELECT rowid, distance
        FROM ${collection.table_name}
        WHERE embedding MATCH vec_f32(?) AND k = ?
      ) v
      JOIN vector_documents d ON d.vector_rowid = v.rowid
      ORDER BY v.distance
    `).all(JSON.stringify(query.queryEmbedding), query.topK) as SearchRow[];
  }

  private getCollection(name: string): CollectionRecord | undefined {
    return this.db.prepare('SELECT name, table_name, dimension, metadata_json FROM vector_collections WHERE name = ?').get(name) as CollectionRecord | undefined;
  }

  private requireCollection(name: string): CollectionRecord {
    const collection = this.getCollection(name);
    if (!collection) throw new Error(`SQLite vec collection not found: ${name}`);
    return collection;
  }

  private tableName(collectionName: string): string {
    const hash = crypto.createHash('sha256').update(collectionName).digest('hex').slice(0, 16);
    return `vec_${hash}`;
  }

  private parseMetadata(metadataJson: string | null): Record<string, unknown> | undefined {
    if (!metadataJson) return undefined;
    return JSON.parse(metadataJson) as Record<string, unknown>;
  }

  private metadataString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }
}

export class SQLiteVecVectorStore implements VectorStoreInterface {
  constructor(
    private readonly client: SQLiteVecClient,
    readonly collectionName: string,
  ) {}

  async ensureCollection(metadata?: Record<string, unknown>): Promise<void> {
    await this.client.getOrCreateCollection(this.collectionName, metadata);
  }

  async upsert(documents: VectorDocument[]): Promise<void> {
    this.client.upsert(this.collectionName, documents);
  }

  async deleteByFilePath(filePath: string): Promise<void> {
    this.client.deleteByFilePath(this.collectionName, filePath);
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    return this.client.search(this.collectionName, query).map(row => ({
      collection: this.collectionName,
      score: 1 / (1 + Number(row.distance ?? 0)),
      document: {
        id: row.id,
        content: row.content,
        metadata: this.parseDocumentMetadata(row.metadata_json),
      },
    }));
  }

  private parseDocumentMetadata(metadataJson: string | null): Record<string, string | number | boolean | null> {
    if (!metadataJson) return {};
    return JSON.parse(metadataJson) as Record<string, string | number | boolean | null>;
  }
}
