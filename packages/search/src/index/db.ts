import Database from 'better-sqlite3';

/** 符号搜索结果 */
export interface SearchResult {
  /** 符号名 */
  name: string;
  /** 符号类型（Function/Class/Interface 等） */
  kind: string;
  /** 所在文件路径 */
  filePath: string;
  /** 起始行号 */
  startLine: number;
  /** 结束行号 */
  endLine: number;
  /** FTS5 全文搜索专用：匹配片段（高亮） */
  snippet?: string;
}

/**
 * 存储管理器 — SQLite 文件索引 + FTS5 全文搜索
 */
export class StorageManager {
  private db: Database.Database;

  constructor(storagePath: string = '.agent-content.db') {
    this.db = new Database(storagePath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  private initTables(): void {
    // 文件索引表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        mtime INTEGER NOT NULL
      );
    `);

    // 符号表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      );
    `);

    // FTS5 全文索引虚拟表（索引符号名 + 类型 + 路径）
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name,
        kind,
        file_path,
        content='symbols',
        content_rowid='id'
      );
    `);

    // FTS5 同步触发器: INSERT
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
        INSERT INTO symbols_fts(rowid, name, kind, file_path)
        VALUES (new.id, new.name, new.kind, new.file_path);
      END;
    `);

    // FTS5 同步触发器: DELETE
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
        INSERT INTO symbols_fts(symbols_fts, rowid, name, kind, file_path)
        VALUES ('delete', old.id, old.name, old.kind, old.file_path);
      END;
    `);

    // FTS5 同步触发器: UPDATE
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
        INSERT INTO symbols_fts(symbols_fts, rowid, name, kind, file_path)
        VALUES ('delete', old.id, old.name, old.kind, old.file_path);
        INSERT INTO symbols_fts(rowid, name, kind, file_path)
        VALUES (new.id, new.name, new.kind, new.file_path);
      END;
    `);

    // Embedding 向量持久化表（重启后恢复语义搜索缓存）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        file_path TEXT PRIMARY KEY,
        chunk_index INTEGER NOT NULL,
        vector BLOB NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** 保存文件 chunk 的 embedding 向量 */
  saveEmbedding(filePath: string, chunkIndex: number, vector: number[], content: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (file_path, chunk_index, vector, content, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(filePath, chunkIndex, Buffer.from(new Float32Array(vector).buffer), content, Date.now());
  }

  /** 加载所有持久化的 embedding 向量 */
  loadEmbeddings(): Array<{ filePath: string; chunkIndex: number; vector: number[]; content: string }> {
    const rows = this.db.prepare('SELECT * FROM embeddings ORDER BY file_path, chunk_index').all() as Array<{
      file_path: string; chunk_index: number; vector: Buffer; content: string;
    }>;
    return rows.map(r => ({
      filePath: r.file_path,
      chunkIndex: r.chunk_index,
      vector: Array.from(new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.length / 4)),
      content: r.content,
    }));
  }

  /** 清除所有 embedding 缓存 */
  clearEmbeddings(): void {
    this.db.prepare('DELETE FROM embeddings').run();
  }

  /** 清除指定文件的所有索引数据 */
  clearFileIndex(filePath: string): void {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
    this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
  }

  /** 记录文件信息（路径 + 修改时间） */
  insertFile(filePath: string, mtime: number): void {
    this.db.prepare('INSERT OR REPLACE INTO files (path, mtime) VALUES (?, ?)').run(filePath, mtime);
  }

  /** 查询已存储的文件 mtime，用于增量索引判断。无记录返回 null */
  getFileMtime(filePath: string): number | null {
    const row = this.db.prepare('SELECT mtime FROM files WHERE path = ?').get(filePath) as { mtime: number } | undefined;
    return row?.mtime ?? null;
  }

  /** 插入一条符号记录（自动同步到 FTS5 虚拟表） */
  insertSymbol(name: string, kind: string, filePath: string, startLine: number, endLine: number): void {
    this.db.prepare(
      'INSERT INTO symbols (name, kind, file_path, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
    ).run(name, kind, filePath, startLine, endLine);
  }

  /** 按符号名 LIKE 搜索（简单场景保留） */
  searchSymbol(name: string): SearchResult[] {
    const stmt = this.db.prepare(`
      SELECT name, kind, file_path as filePath, start_line as startLine, end_line as endLine
      FROM symbols
      WHERE name LIKE ?
      LIMIT 20
    `);
    return stmt.all(`%${name}%`) as SearchResult[];
  }

  /** FTS5 全文搜索 — O(log n)，返回高亮片段 */
  searchFts(query: string, limit: number = 20): SearchResult[] {
    const stmt = this.db.prepare(`
      SELECT
        s.name,
        s.kind,
        s.file_path as filePath,
        s.start_line as startLine,
        s.end_line as endLine,
        snippet(symbols_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet
      FROM symbols_fts fts
      JOIN symbols s ON s.rowid = fts.rowid
      WHERE symbols_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(query, limit) as SearchResult[];
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }
}
