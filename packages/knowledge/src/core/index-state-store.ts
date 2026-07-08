import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TextChunk } from '../chunking/text-chunker.js';
import type { FileCategory, IndexStateRecord } from '../types.js';

export type KnowledgeJobStatus = 'PENDING' | 'PARSING' | 'CHUNKING' | 'INDEXING' | 'SUCCESS' | 'ERROR';

export interface KnowledgeIndexJob {
  id: string;
  relativePath: string;
  status: KnowledgeJobStatus;
  percent: number;
  message: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredChunk {
  rowid: number;
  id: string;
  relativePath: string;
  chunkIndex: number;
  content: string;
  category: FileCategory;
  format: string;
  collectionName: string;
  tokenCount: number;
  sectionTitle?: string;
  metadataJson?: string;
  createdAt: number;
}

export interface ChunkSearchResult extends StoredChunk {
  score: number;
  scoreDetails?: {
    keywordScore?: number;
    bm25Score?: number;
    exactPhraseBoost?: number;
  };
}

export interface StoredParentChunk {
  id: string;
  relativePath: string;
  parentId: string;
  content: string;
  category: FileCategory;
  format: string;
  collectionName: string;
  sectionTitle?: string;
  chunkCount: number;
  metadataJson?: string;
  createdAt: number;
}

export interface StoredDocumentChunk {
  id: string;
  relativePath: string;
  content: string;
  category: FileCategory;
  format: string;
  collectionName: string;
  parentCount: number;
  chunkCount: number;
  metadataJson?: string;
  createdAt: number;
}

export interface FileHashRecord {
  contentHash: string;
  filePath: string;
  fileSize: number;
  category: FileCategory;
  normalizedHash?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MinHashRecord {
  filePath: string;
  signature: number[];
  shingleCount: number;
  buckets: string[];
  createdAt: number;
}

export interface FileRelationship {
  id?: number;
  sourceFile: string;
  targetFile: string;
  relationshipType: 'exact_duplicate' | 'format_variant' | 'translation' | 'near_duplicate' | 'revision' | 'version_chain' | 'derived' | 'complementary';
  confidence: number;
  detail?: string;
  userConfirmed: number;
  createdAt: number;
}

/** 索引状态存储器，使用 SQLite 管理知识库索引的持久化状态 */
export class IndexStateStore {
  private readonly db: Database.Database;
  private ftsEnabled = false;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  /** 加载所有活跃的索引记录 */
  loadActiveRecords(): Map<string, IndexStateRecord> {
    const rows = this.db.prepare(`
      SELECT * FROM kb_index_state
      WHERE status IN ('active', 'outdated', 'error')
    `).all() as Array<Record<string, unknown>>;

    return new Map(rows.map(row => {
      const record = this.rowToRecord(row);
      return [record.relativePath, record];
    }));
  }

  /** 插入或更新索引记录 */
  upsertRecord(record: IndexStateRecord): void {
    this.db.prepare(`
      INSERT INTO kb_index_state (
        relative_path, category, format, content_hash, file_size, mtime,
        chunk_count, collection_name, indexed_at, last_verified_at,
        status, error_message, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(relative_path) DO UPDATE SET
        category = excluded.category,
        format = excluded.format,
        content_hash = excluded.content_hash,
        file_size = excluded.file_size,
        mtime = excluded.mtime,
        chunk_count = excluded.chunk_count,
        collection_name = excluded.collection_name,
        last_verified_at = excluded.last_verified_at,
        status = excluded.status,
        error_message = excluded.error_message,
        metadata_json = excluded.metadata_json
    `).run(
      record.relativePath,
      record.category,
      record.format,
      record.contentHash,
      record.fileSize,
      Math.round(record.mtime),
      record.chunkCount,
      record.collectionName,
      record.indexedAt,
      record.lastVerifiedAt,
      record.status,
      record.errorMessage ?? null,
      record.metadataJson ?? null,
    );
  }

  /** 更新已验证文件的时间戳和状态 */
  updateVerified(relativePath: string, mtime: number): void {
    this.db.prepare(`
      UPDATE kb_index_state
      SET mtime = ?, last_verified_at = ?, status = 'active'
      WHERE relative_path = ?
    `).run(Math.round(mtime), Date.now(), relativePath);
  }

  listRecords(): IndexStateRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM kb_index_state
      WHERE status != 'deleted'
      ORDER BY category, relative_path
    `).all() as Array<Record<string, unknown>>;
    return rows.map(row => this.rowToRecord(row));
  }

  enqueueIndexJob(job: { id: string; relativePath: string; message?: string }): KnowledgeIndexJob {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO kb_index_jobs (id, relative_path, status, percent, message, created_at, updated_at)
      VALUES (?, ?, 'PENDING', 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = 'PENDING', percent = 0, message = excluded.message, error_message = NULL, updated_at = excluded.updated_at
    `).run(job.id, job.relativePath, job.message ?? '等待后台索引', now, now);
    return this.getIndexJob(job.id)!;
  }

  updateIndexJob(id: string, patch: { status?: KnowledgeJobStatus; percent?: number; message?: string; errorMessage?: string }): void {
    const current = this.getIndexJob(id);
    if (!current) return;
    this.db.prepare(`
      UPDATE kb_index_jobs
      SET status = ?, percent = ?, message = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(patch.status ?? current.status, patch.percent ?? current.percent, patch.message ?? current.message, patch.errorMessage ?? null, Date.now(), id);
  }

  getIndexJob(id: string): KnowledgeIndexJob | undefined {
    const row = this.db.prepare('SELECT * FROM kb_index_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToJob(row) : undefined;
  }

  listPendingIndexJobs(limit = 20): KnowledgeIndexJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM kb_index_jobs
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map(row => this.rowToJob(row));
  }

  countPendingIndexJobs(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM kb_index_jobs WHERE status = 'PENDING'").get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  listActiveIndexJobsByPath(relativePath: string): KnowledgeIndexJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM kb_index_jobs
      WHERE relative_path = ? AND status IN ('PENDING', 'PARSING', 'CHUNKING', 'INDEXING')
      ORDER BY created_at ASC
    `).all(relativePath) as Array<Record<string, unknown>>;
    return rows.map(row => this.rowToJob(row));
  }

  listIndexJobsByPrefix(prefix: string): KnowledgeIndexJob[] {
    const rows = this.db.prepare(`
      SELECT * FROM kb_index_jobs
      WHERE id LIKE ?
      ORDER BY created_at ASC
    `).all(`${prefix}%`) as Array<Record<string, unknown>>;
    return rows.map(row => this.rowToJob(row));
  }

  /**
   * 替换指定文件的切片数据（使用事务批量更新）
   * @param relativePath 文件相对路径
   * @param chunks 文本切片列表
   * @param file 文件分类信息
   */
  replaceChunks(
    relativePath: string,
    chunks: TextChunk[],
    file: { category: FileCategory; format: string; collectionName: string },
  ): void {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM kb_chunks WHERE relative_path = ?').run(relativePath);
      this.db.prepare('DELETE FROM kb_parent_chunks WHERE relative_path = ?').run(relativePath);
      this.db.prepare('DELETE FROM kb_document_chunks WHERE relative_path = ?').run(relativePath);
      if (this.ftsEnabled) this.db.prepare('DELETE FROM kb_chunks_fts WHERE relative_path = ?').run(relativePath);
      const insert = this.db.prepare(`
        INSERT INTO kb_chunks (
          id, relative_path, chunk_index, content, category, format,
          collection_name, token_count, section_title, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertFts = this.ftsEnabled ? this.db.prepare(`
        INSERT INTO kb_chunks_fts (id, relative_path, category, format, section_title, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `) : undefined;
      const insertParent = this.db.prepare(`
        INSERT INTO kb_parent_chunks (
          id, relative_path, parent_id, content, category, format,
          collection_name, section_title, chunk_count, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertDocument = this.db.prepare(`
        INSERT INTO kb_document_chunks (
          id, relative_path, content, category, format,
          collection_name, parent_count, chunk_count, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const parentGroups = new Map<string, TextChunk[]>();
      const groupedChunks = this.splitParentGroups(relativePath, chunks);
      for (const chunk of groupedChunks) {
        const parentId = this.metadataString(chunk.metadata.parentId) ?? `${relativePath}#parent-${chunk.index}`;
        const group = parentGroups.get(parentId) ?? [];
        group.push(chunk);
        parentGroups.set(parentId, group);
      }
      const parentContents: string[] = [];
      for (const [parentId, group] of parentGroups.entries()) {
        const parentContent = group.map(chunk => chunk.text).join('\n\n---\n\n');
        parentContents.push(parentContent);
        insertParent.run(
          parentId,
          relativePath,
          parentId,
          parentContent,
          file.category,
          file.format,
          file.collectionName,
          group.find(chunk => chunk.sectionTitle)?.sectionTitle ?? null,
          group.length,
          JSON.stringify({ parentId, splitStrategy: this.metadataString(group[0]?.metadata.splitStrategy), chunkKind: this.metadataString(group[0]?.metadata.chunkKind) }),
          now,
        );
      }
      insertDocument.run(
        `${relativePath}#document`,
        relativePath,
        parentContents.join('\n\n=== SECTION ===\n\n'),
        file.category,
        file.format,
        file.collectionName,
        parentGroups.size,
        groupedChunks.length,
        JSON.stringify({ parentType: 'document', splitStrategy: 'document_section_child_v1' }),
        now,
      );

      for (const chunk of groupedChunks) {
        const chunkId = `${relativePath}#${chunk.index}`;
        insert.run(
          chunkId,
          relativePath,
          chunk.index,
          chunk.text,
          file.category,
          file.format,
          file.collectionName,
          chunk.tokenCount,
          chunk.sectionTitle ?? null,
          JSON.stringify(chunk.metadata),
          now,
        );
        insertFts?.run(chunkId, relativePath, file.category, file.format, chunk.sectionTitle ?? '', chunk.text);
      }
    });
    transaction();
  }

  listChunks(options: { collectionName?: string; relativePath?: string; limit?: number } = {}): StoredChunk[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options.collectionName) {
      conditions.push('collection_name = ?');
      params.push(options.collectionName);
    }
    if (options.relativePath) {
      conditions.push('relative_path = ?');
      params.push(options.relativePath);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ? 'LIMIT ?' : '';
    if (options.limit) params.push(options.limit);

    const rows = this.db.prepare(`
      SELECT rowid, * FROM kb_chunks
      ${where}
      ORDER BY relative_path, chunk_index
      ${limit}
    `).all(...params) as Array<Record<string, unknown>>;

    return rows.map(row => this.rowToChunk(row, 0));
  }

  getChunkByRowid(rowid: number): StoredChunk | undefined {
    const row = this.db.prepare('SELECT rowid, * FROM kb_chunks WHERE rowid = ?').get(rowid) as Record<string, unknown> | undefined;
    return row ? this.rowToChunk(row, 0) : undefined;
  }

  getChunksByRowids(rowids: number[]): StoredChunk[] {
    if (rowids.length === 0) return [];
    const placeholders = rowids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT rowid, * FROM kb_chunks WHERE rowid IN (${placeholders})`).all(...rowids) as Array<Record<string, unknown>>;
    const byRowid = new Map(rows.map(row => [Number(row.rowid), this.rowToChunk(row, 0)]));
    return rowids.flatMap(rowid => byRowid.get(rowid) ?? []);
  }

  getContextChunks(relativePath: string, chunkIndex: number, window = 1): StoredChunk[] {
    const rows = this.db.prepare(`
      SELECT rowid, * FROM kb_chunks
      WHERE relative_path = ? AND chunk_index BETWEEN ? AND ?
      ORDER BY chunk_index
    `).all(relativePath, Math.max(0, chunkIndex - window), chunkIndex + window) as Array<Record<string, unknown>>;
    return rows.map(row => this.rowToChunk(row, 0));
  }

  listParentChunks(relativePath: string): StoredParentChunk[] {
    const rows = this.db.prepare(`
      SELECT * FROM kb_parent_chunks
      WHERE relative_path = ?
      ORDER BY parent_id
    `).all(relativePath) as Array<Record<string, unknown>>;
    return rows.map(row => this.rowToParentChunk(row));
  }

  getParentChunk(relativePath: string, parentId: string): StoredParentChunk | undefined {
    const row = this.db.prepare(`
      SELECT * FROM kb_parent_chunks
      WHERE relative_path = ? AND parent_id = ?
      LIMIT 1
    `).get(relativePath, parentId) as Record<string, unknown> | undefined;
    return row ? this.rowToParentChunk(row) : undefined;
  }

  getDocumentChunk(relativePath: string): StoredDocumentChunk | undefined {
    const row = this.db.prepare(`
      SELECT * FROM kb_document_chunks
      WHERE relative_path = ?
      LIMIT 1
    `).get(relativePath) as Record<string, unknown> | undefined;
    return row ? this.rowToDocumentChunk(row) : undefined;
  }

  getChunksByParent(relativePath: string, parentId: string, limit = 6): StoredChunk[] {
    const rows = this.db.prepare(`
      SELECT rowid, * FROM kb_chunks
      WHERE relative_path = ? AND metadata_json LIKE ?
      ORDER BY chunk_index
      LIMIT ?
    `).all(relativePath, `%"parentId":"${parentId.replace(/[%_]/gu, '')}"%`, limit) as Array<Record<string, unknown>>;
    return rows.map(row => this.rowToChunk(row, 0));
  }

  /**
   * 使用关键词搜索切片（支持 FTS5 全文搜索和 LIKE 模糊匹配）
   * @param query 搜索查询
   * @param limit 返回结果数量上限
   * @returns 搜索结果列表（按相关性得分排序）
   */
  searchChunks(query: string, limit = 10): ChunkSearchResult[] {
    const terms = this.expandSearchTerms(query);
    if (terms.length === 0) return [];
    const results = [
      ...(this.ftsEnabled ? this.searchChunksFts(terms, limit) : []),
      ...this.searchChunksLike(terms, limit),
    ];
    return this.mergeKeywordResults(results, limit);
  }

  private searchChunksFts(terms: string[], limit: number): ChunkSearchResult[] {
    try {
      const matchQuery = this.toFtsQuery(terms);
      if (!matchQuery) return [];
      const rows = this.db.prepare(`
        SELECT c.rowid, c.*, bm25(kb_chunks_fts, 1.2, 0.8, 0.6, 1.0, 2.0) as bm25_score
        FROM kb_chunks_fts
        INNER JOIN kb_chunks c ON c.id = kb_chunks_fts.id
        WHERE kb_chunks_fts MATCH ?
        ORDER BY bm25_score ASC
        LIMIT ?
      `).all(matchQuery, limit * 8) as Array<Record<string, unknown>>;
      return rows
        .map(row => {
          const keyword = this.scoreChunkDetailed(`${String(row.relative_path)}\n${String(row.category)}\n${String(row.format)}\n${String(row.content)}`, terms);
          const bm25Score = this.bm25ToPositiveScore(Number(row.bm25_score));
          return this.rowToChunk(row, keyword.keywordScore + bm25Score, { ...keyword, bm25Score });
        })
        .filter(row => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  private searchChunksLike(terms: string[], limit: number): ChunkSearchResult[] {
    const rows = this.db.prepare(`
      SELECT rowid, * FROM kb_chunks
      WHERE ${terms.map(() => '(LOWER(content) LIKE ? OR LOWER(relative_path) LIKE ? OR LOWER(category) LIKE ? OR LOWER(format) LIKE ?)').join(' OR ')}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...terms.flatMap(term => [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`]), limit * 6) as Array<Record<string, unknown>>;

    return rows
      .map(row => {
        const keyword = this.scoreChunkDetailed(`${String(row.relative_path)}\n${String(row.category)}\n${String(row.format)}\n${String(row.content)}`, terms);
        return this.rowToChunk(row, keyword.keywordScore, keyword);
      })
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  findExactDuplicate(contentHash: string, excludePath?: string): FileHashRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM kb_file_hashes
      WHERE content_hash = ? ${excludePath ? 'AND file_path != ?' : ''}
      LIMIT 1
    `).get(...(excludePath ? [contentHash, excludePath] : [contentHash])) as Record<string, unknown> | undefined;
    return row ? this.rowToFileHash(row) : undefined;
  }

  findNormalizedDuplicate(normalizedHash: string, excludePath?: string): FileHashRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM kb_file_hashes
      WHERE normalized_hash = ? ${excludePath ? 'AND file_path != ?' : ''}
      LIMIT 1
    `).get(...(excludePath ? [normalizedHash, excludePath] : [normalizedHash])) as Record<string, unknown> | undefined;
    return row ? this.rowToFileHash(row) : undefined;
  }

  upsertFileHash(record: Omit<FileHashRecord, 'createdAt' | 'updatedAt'>): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO kb_file_hashes (content_hash, file_path, file_size, category, normalized_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        content_hash = excluded.content_hash,
        file_size = excluded.file_size,
        category = excluded.category,
        normalized_hash = excluded.normalized_hash,
        updated_at = excluded.updated_at
    `).run(record.contentHash, record.filePath, record.fileSize, record.category, record.normalizedHash ?? null, now, now);
  }

  upsertMinHash(record: Omit<MinHashRecord, 'createdAt'>): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO kb_minhash (file_path, signature, shingle_count, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(file_path) DO UPDATE SET
          signature = excluded.signature,
          shingle_count = excluded.shingle_count,
          created_at = excluded.created_at
      `).run(record.filePath, Buffer.from(JSON.stringify(record.signature), 'utf8'), record.shingleCount, now);
      this.db.prepare('DELETE FROM kb_lsh_buckets WHERE file_path = ?').run(record.filePath);
      const insertBucket = this.db.prepare('INSERT OR IGNORE INTO kb_lsh_buckets (bucket_key, file_path, created_at) VALUES (?, ?, ?)');
      for (const bucket of record.buckets) insertBucket.run(bucket, record.filePath, now);
    });
    tx();
  }

  listMinHashes(excludePath?: string): MinHashRecord[] {
    const rows = excludePath
      ? this.db.prepare('SELECT * FROM kb_minhash WHERE file_path != ?').all(excludePath)
      : this.db.prepare('SELECT * FROM kb_minhash').all();
    return (rows as Array<Record<string, unknown>>).map(row => this.rowToMinHash(row));
  }

  listMinHashesByBuckets(buckets: string[], excludePath?: string): MinHashRecord[] {
    if (buckets.length === 0) return [];
    const placeholders = buckets.map(() => '?').join(',');
    const params: unknown[] = [...buckets];
    let sql = `
      SELECT DISTINCT m.*
      FROM kb_minhash m
      INNER JOIN kb_lsh_buckets b ON b.file_path = m.file_path
      WHERE b.bucket_key IN (${placeholders})
    `;
    if (excludePath) {
      sql += ' AND m.file_path != ?';
      params.push(excludePath);
    }
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(row => this.rowToMinHash(row));
  }

  addRelationship(relationship: Omit<FileRelationship, 'id' | 'createdAt'>): void {
    this.db.prepare(`
      INSERT INTO kb_relationships (
        source_file, target_file, relationship_type, confidence, detail, user_confirmed, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_file, target_file, relationship_type) DO UPDATE SET
        confidence = excluded.confidence,
        detail = excluded.detail,
        user_confirmed = excluded.user_confirmed
    `).run(
      relationship.sourceFile,
      relationship.targetFile,
      relationship.relationshipType,
      relationship.confidence,
      relationship.detail ?? null,
      relationship.userConfirmed,
      Date.now(),
    );
  }

  listRelationships(filePath?: string): FileRelationship[] {
    const rows = filePath
      ? this.db.prepare('SELECT * FROM kb_relationships WHERE source_file = ? OR target_file = ? ORDER BY created_at DESC').all(filePath, filePath)
      : this.db.prepare('SELECT * FROM kb_relationships ORDER BY created_at DESC').all();
    return (rows as Array<Record<string, unknown>>).map(row => this.rowToRelationship(row));
  }

  setTags(relativePath: string, tags: string[]): void {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM kb_tags WHERE file_path = ?').run(relativePath);
      const insert = this.db.prepare('INSERT OR IGNORE INTO kb_tags (file_path, tag, created_at) VALUES (?, ?, ?)');
      for (const tag of tags.map(tag => tag.trim()).filter(Boolean)) insert.run(relativePath, tag, now);
    });
    transaction();
  }

  listTags(relativePath?: string): Array<{ filePath: string; tag: string; createdAt: number }> {
    const rows = relativePath
      ? this.db.prepare('SELECT * FROM kb_tags WHERE file_path = ? ORDER BY tag').all(relativePath)
      : this.db.prepare('SELECT * FROM kb_tags ORDER BY file_path, tag').all();
    return (rows as Array<Record<string, unknown>>).map(row => ({
      filePath: String(row.file_path),
      tag: String(row.tag),
      createdAt: Number(row.created_at),
    }));
  }

  addIgnoreRule(pattern: string): void {
    this.db.prepare('INSERT OR IGNORE INTO kb_ignore_rules (pattern, enabled, created_at) VALUES (?, 1, ?)').run(pattern, Date.now());
  }

  listIgnoreRules(): Array<{ id: number; pattern: string; enabled: boolean; createdAt: number }> {
    const rows = this.db.prepare('SELECT * FROM kb_ignore_rules ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map(row => ({
      id: Number(row.id),
      pattern: String(row.pattern),
      enabled: Number(row.enabled) === 1,
      createdAt: Number(row.created_at),
    }));
  }

  /**
   * 删除指定文件的全部索引数据（含切片、哈希、MinHash、标签、关系等）
   * @param relativePath 文件相对路径
   */
  deleteRecord(relativePath: string): void {
    this.db.prepare('DELETE FROM kb_chunks WHERE relative_path = ?').run(relativePath);
    this.db.prepare('DELETE FROM kb_parent_chunks WHERE relative_path = ?').run(relativePath);
    this.db.prepare('DELETE FROM kb_document_chunks WHERE relative_path = ?').run(relativePath);
    if (this.ftsEnabled) this.db.prepare('DELETE FROM kb_chunks_fts WHERE relative_path = ?').run(relativePath);
    this.db.prepare('DELETE FROM kb_index_state WHERE relative_path = ?').run(relativePath);
    this.db.prepare('DELETE FROM kb_file_hashes WHERE file_path = ?').run(relativePath);
    this.db.prepare('DELETE FROM kb_minhash WHERE file_path = ?').run(relativePath);
    this.db.prepare('DELETE FROM kb_lsh_buckets WHERE file_path = ?').run(relativePath);
    this.db.prepare('DELETE FROM kb_tags WHERE file_path = ?').run(relativePath);
    this.db.prepare('DELETE FROM kb_relationships WHERE source_file = ? OR target_file = ?').run(relativePath, relativePath);
  }

  setMetadata(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO kb_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  getMetadata(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kb_metadata WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
  }

  getStats(): { fileCount: number; chunkCount: number; totalSizeBytes: number; lastIndexedAt: number } {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as file_count,
        (SELECT COUNT(*) FROM kb_chunks) as chunk_count,
        COALESCE(SUM(file_size), 0) as total_size_bytes,
        COALESCE(MAX(indexed_at), 0) as last_indexed_at
      FROM kb_index_state
      WHERE status != 'deleted'
    `).get() as Record<string, unknown>;

    return {
      fileCount: Number(stats.file_count ?? 0),
      chunkCount: Number(stats.chunk_count ?? 0),
      totalSizeBytes: Number(stats.total_size_bytes ?? 0),
      lastIndexedAt: Number(stats.last_indexed_at ?? 0),
    };
  }

  listContentHashes(): Array<{ contentHash: string; relativePath: string }> {
    const rows = this.db.prepare(`
      SELECT content_hash, relative_path FROM kb_index_state WHERE status = 'active'
    `).all() as Array<Record<string, unknown>>;
    return rows.map(row => ({ contentHash: String(row.content_hash), relativePath: String(row.relative_path) }));
  }

  close(): void {
    this.db.close();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_index_state (
        relative_path     TEXT PRIMARY KEY,
        category          TEXT NOT NULL,
        format            TEXT NOT NULL,
        content_hash      TEXT NOT NULL,
        file_size         INTEGER NOT NULL,
        mtime             INTEGER NOT NULL,
        chunk_count       INTEGER NOT NULL DEFAULT 0,
        collection_name   TEXT NOT NULL,
        indexed_at        INTEGER NOT NULL,
        last_verified_at  INTEGER NOT NULL,
        status            TEXT NOT NULL DEFAULT 'active',
        error_message     TEXT,
        metadata_json     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kb_state_status ON kb_index_state(status);
      CREATE INDEX IF NOT EXISTS idx_kb_state_category ON kb_index_state(category);
      CREATE INDEX IF NOT EXISTS idx_kb_state_collection ON kb_index_state(collection_name);

      CREATE TABLE IF NOT EXISTS kb_chunks (
        rowid           INTEGER PRIMARY KEY AUTOINCREMENT,
        id              TEXT NOT NULL UNIQUE,
        relative_path   TEXT NOT NULL,
        chunk_index     INTEGER NOT NULL,
        content         TEXT NOT NULL,
        category        TEXT NOT NULL,
        format          TEXT NOT NULL,
        collection_name TEXT NOT NULL,
        token_count     INTEGER NOT NULL,
        section_title   TEXT,
        metadata_json   TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_path ON kb_chunks(relative_path);
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_category ON kb_chunks(category);
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_collection ON kb_chunks(collection_name);

      CREATE TABLE IF NOT EXISTS kb_parent_chunks (
        id              TEXT PRIMARY KEY,
        relative_path   TEXT NOT NULL,
        parent_id       TEXT NOT NULL,
        content         TEXT NOT NULL,
        category        TEXT NOT NULL,
        format          TEXT NOT NULL,
        collection_name TEXT NOT NULL,
        section_title   TEXT,
        chunk_count     INTEGER NOT NULL,
        metadata_json   TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_parent_path ON kb_parent_chunks(relative_path);
      CREATE INDEX IF NOT EXISTS idx_kb_parent_id ON kb_parent_chunks(parent_id);

      CREATE TABLE IF NOT EXISTS kb_document_chunks (
        id              TEXT PRIMARY KEY,
        relative_path   TEXT NOT NULL,
        content         TEXT NOT NULL,
        category        TEXT NOT NULL,
        format          TEXT NOT NULL,
        collection_name TEXT NOT NULL,
        parent_count    INTEGER NOT NULL,
        chunk_count     INTEGER NOT NULL,
        metadata_json   TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_document_path ON kb_document_chunks(relative_path);

      CREATE TABLE IF NOT EXISTS kb_file_hashes (
        content_hash     TEXT NOT NULL,
        file_path        TEXT PRIMARY KEY,
        file_size        INTEGER NOT NULL,
        category         TEXT NOT NULL,
        normalized_hash  TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_hashes_content ON kb_file_hashes(content_hash);
      CREATE INDEX IF NOT EXISTS idx_kb_hashes_norm ON kb_file_hashes(normalized_hash);

      CREATE TABLE IF NOT EXISTS kb_minhash (
        file_path        TEXT PRIMARY KEY,
        signature        BLOB NOT NULL,
        shingle_count    INTEGER NOT NULL,
        created_at       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kb_lsh_buckets (
        bucket_key       TEXT NOT NULL,
        file_path        TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        PRIMARY KEY (bucket_key, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_lsh_bucket ON kb_lsh_buckets(bucket_key);
      CREATE INDEX IF NOT EXISTS idx_lsh_file ON kb_lsh_buckets(file_path);

      CREATE TABLE IF NOT EXISTS kb_relationships (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file       TEXT NOT NULL,
        target_file       TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        confidence        REAL NOT NULL DEFAULT 1.0,
        detail            TEXT,
        user_confirmed    INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        UNIQUE(source_file, target_file, relationship_type)
      );
      CREATE INDEX IF NOT EXISTS idx_rel_source ON kb_relationships(source_file);
      CREATE INDEX IF NOT EXISTS idx_rel_target ON kb_relationships(target_file);
      CREATE INDEX IF NOT EXISTS idx_rel_type ON kb_relationships(relationship_type);

      CREATE TABLE IF NOT EXISTS kb_tags (
        file_path   TEXT NOT NULL,
        tag         TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (file_path, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON kb_tags(tag);

      CREATE TABLE IF NOT EXISTS kb_index_jobs (
        id             TEXT PRIMARY KEY,
        relative_path  TEXT NOT NULL,
        status         TEXT NOT NULL,
        percent        INTEGER NOT NULL DEFAULT 0,
        message        TEXT NOT NULL DEFAULT '',
        error_message  TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kb_jobs_status ON kb_index_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_kb_jobs_path ON kb_index_jobs(relative_path);

      CREATE TABLE IF NOT EXISTS kb_metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kb_ignore_rules (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern     TEXT NOT NULL UNIQUE,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL
      );
    `);
    this.initFts();
    try {
      if (this.getMetadata('schema_version') !== '2') this.setMetadata('schema_version', '2');
    } catch {
      // 受限环境中已有索引库可能以只读方式挂载；运行时元数据不是必需项。
    }
  }

  private initFts(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
          id UNINDEXED,
          relative_path,
          category,
          format,
          section_title,
          content,
          tokenize = 'unicode61 remove_diacritics 2'
        );
      `);
      this.ftsEnabled = true;
      this.rebuildFtsIfNeeded();
    } catch {
      this.ftsEnabled = false;
    }
  }

  private rebuildFtsIfNeeded(): void {
    if (!this.ftsEnabled) return;
    const row = this.db.prepare('SELECT COUNT(*) as count FROM kb_chunks_fts').get() as { count?: number };
    if (Number(row.count ?? 0) > 0) return;
    this.db.prepare(`
      INSERT INTO kb_chunks_fts (id, relative_path, category, format, section_title, content)
      SELECT id, relative_path, category, format, COALESCE(section_title, ''), content FROM kb_chunks
    `).run();
  }

  private rowToMinHash(row: Record<string, unknown>): MinHashRecord {
    const raw = row.signature;
    const json = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    const filePath = String(row.file_path);
    const bucketRows = this.db.prepare('SELECT bucket_key FROM kb_lsh_buckets WHERE file_path = ?').all(filePath) as Array<{ bucket_key: string }>;
    return {
      filePath,
      signature: JSON.parse(json) as number[],
      shingleCount: Number(row.shingle_count),
      buckets: bucketRows.map(bucket => bucket.bucket_key),
      createdAt: Number(row.created_at),
    };
  }

  private rowToFileHash(row: Record<string, unknown>): FileHashRecord {
    return {
      contentHash: String(row.content_hash),
      filePath: String(row.file_path),
      fileSize: Number(row.file_size),
      category: String(row.category) as FileCategory,
      normalizedHash: row.normalized_hash == null ? undefined : String(row.normalized_hash),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private rowToRelationship(row: Record<string, unknown>): FileRelationship {
    return {
      id: Number(row.id),
      sourceFile: String(row.source_file),
      targetFile: String(row.target_file),
      relationshipType: String(row.relationship_type) as FileRelationship['relationshipType'],
      confidence: Number(row.confidence),
      detail: row.detail == null ? undefined : String(row.detail),
      userConfirmed: Number(row.user_confirmed),
      createdAt: Number(row.created_at),
    };
  }

  private rowToParentChunk(row: Record<string, unknown>): StoredParentChunk {
    return {
      id: String(row.id),
      relativePath: String(row.relative_path),
      parentId: String(row.parent_id),
      content: String(row.content),
      category: row.category as FileCategory,
      format: String(row.format),
      collectionName: String(row.collection_name),
      sectionTitle: row.section_title == null ? undefined : String(row.section_title),
      chunkCount: Number(row.chunk_count),
      metadataJson: row.metadata_json == null ? undefined : String(row.metadata_json),
      createdAt: Number(row.created_at),
    };
  }

  private rowToDocumentChunk(row: Record<string, unknown>): StoredDocumentChunk {
    return {
      id: String(row.id),
      relativePath: String(row.relative_path),
      content: String(row.content),
      category: row.category as FileCategory,
      format: String(row.format),
      collectionName: String(row.collection_name),
      parentCount: Number(row.parent_count),
      chunkCount: Number(row.chunk_count),
      metadataJson: row.metadata_json == null ? undefined : String(row.metadata_json),
      createdAt: Number(row.created_at),
    };
  }

  private splitParentGroups(_relativePath: string, chunks: TextChunk[]): TextChunk[] {
    return chunks;
  }

  private rowToJob(row: Record<string, unknown>): KnowledgeIndexJob {
    return {
      id: String(row.id),
      relativePath: String(row.relative_path),
      status: String(row.status) as KnowledgeJobStatus,
      percent: Number(row.percent),
      message: String(row.message ?? ''),
      errorMessage: row.error_message == null ? undefined : String(row.error_message),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private metadataString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private rowToChunk(row: Record<string, unknown>, score: number, scoreDetails?: ChunkSearchResult['scoreDetails']): ChunkSearchResult {
    return {
      rowid: Number(row.rowid ?? 0),
      id: String(row.id),
      relativePath: String(row.relative_path),
      chunkIndex: Number(row.chunk_index),
      content: String(row.content),
      category: String(row.category) as FileCategory,
      format: String(row.format),
      collectionName: String(row.collection_name),
      tokenCount: Number(row.token_count),
      sectionTitle: row.section_title == null ? undefined : String(row.section_title),
      metadataJson: row.metadata_json == null ? undefined : String(row.metadata_json),
      createdAt: Number(row.created_at),
      score,
      scoreDetails,
    };
  }

  private expandSearchTerms(query: string): string[] {
    const normalized = query.toLowerCase().trim();
    const terms = new Set(normalized ? [normalized] : []);
    for (const term of normalized.split(/[\s,，。；;：:、]+/u).filter(Boolean)) {
      terms.add(term);
      for (const gram of this.chineseNgrams(term)) terms.add(gram);
    }
    for (const gram of this.chineseNgrams(normalized)) terms.add(gram);
    const synonyms: Record<string, string[]> = {
      招标: ['招标', '投标', '标书', '招标文件', '投标文件', 'bid', 'tender', 'bidding'],
      投标: ['招标', '投标', '标书', '招标文件', '投标文件', 'bid', 'tender', 'bidding'],
      标书: ['招标', '投标', '标书', '招标文件', '投标文件', 'bid', 'tender', 'bidding'],
      合同: ['合同', '协议', 'contract', 'agreement'],
      pdf: ['pdf', 'document'],
      文档: ['文档', '文件', 'document', 'pdf', 'office'],
    };
    for (const [key, values] of Object.entries(synonyms)) {
      if (normalized.includes(key)) for (const value of values) terms.add(value.toLowerCase());
    }
    return [...terms].filter(term => term.length > 0).slice(0, 40);
  }

  private toFtsQuery(terms: string[]): string {
    const normalized = terms.map(term => term.replace(/["*^:(){}\]\\[]/gu, ' ').trim()).filter(term => term.length > 0);
    const exact = normalized[0];
    const weak = normalized.slice(1).filter(term => term.length >= 2).slice(0, 12);
    return [exact ? `"${exact}"` : '', ...weak.map(term => `"${term}"`)].filter(Boolean).join(' OR ');
  }

  private mergeKeywordResults(results: ChunkSearchResult[], limit: number): ChunkSearchResult[] {
    const byId = new Map<string, ChunkSearchResult>();
    for (const result of results) {
      const existing = byId.get(result.id);
      if (!existing || result.score > existing.score) byId.set(result.id, result);
    }
    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private chineseNgrams(text: string): string[] {
    const han = text.match(/[\p{Script=Han}]+/gu) ?? [];
    const grams: string[] = [];
    for (const token of han) {
      for (let size = 2; size <= 3; size++) {
        if (token.length <= size) continue;
        for (let index = 0; index <= token.length - size; index++) grams.push(token.slice(index, index + size));
      }
    }
    return grams;
  }

  private bm25ToPositiveScore(score: number): number {
    if (!Number.isFinite(score)) return 0;
    return score < 0 ? -score : 1 / (1 + score);
  }

  private scoreChunkDetailed(content: string, terms: string[]): Required<Pick<NonNullable<ChunkSearchResult['scoreDetails']>, 'keywordScore' | 'exactPhraseBoost'>> {
    const lower = content.toLowerCase();
    let raw = 0;
    let exactPhraseBoost = 0;
    const exactPhrase = terms[0] ?? '';
    const exactHits = exactPhrase ? this.countOccurrences(lower, exactPhrase) : 0;
    if (exactHits > 0) exactPhraseBoost = 1000 + exactHits * 20;
    raw += exactPhraseBoost;
    for (const term of terms) {
      if (term === exactPhrase) continue;
      raw += this.countOccurrences(lower, term) * 0.2;
    }
    return {
      keywordScore: raw / Math.max(1, content.length / 1000),
      exactPhraseBoost,
    };
  }

  private countOccurrences(content: string, term: string): number {
    let count = 0;
    let index = content.indexOf(term);
    while (index !== -1) {
      count += 1;
      index = content.indexOf(term, index + term.length);
    }
    return count;
  }

  private rowToRecord(row: Record<string, unknown>): IndexStateRecord {
    return {
      relativePath: String(row.relative_path),
      category: String(row.category) as IndexStateRecord['category'],
      format: String(row.format),
      contentHash: String(row.content_hash),
      fileSize: Number(row.file_size),
      mtime: Number(row.mtime),
      chunkCount: Number(row.chunk_count),
      collectionName: String(row.collection_name),
      indexedAt: Number(row.indexed_at),
      lastVerifiedAt: Number(row.last_verified_at),
      status: String(row.status) as IndexStateRecord['status'],
      errorMessage: row.error_message == null ? undefined : String(row.error_message),
      metadataJson: row.metadata_json == null ? undefined : String(row.metadata_json),
    };
  }
}
