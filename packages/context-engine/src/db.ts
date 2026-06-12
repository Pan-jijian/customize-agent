import Database from 'better-sqlite3';
import * as path from 'path';

export class StorageManager {
  private db: Database.Database;
  constructor(storagePath: string = '.agent-content.db') {
    this.db = new Database(storagePath);
    this.initTables();
  }
  private initTables() {
    //创建文件索引表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        mtime INTEGER NOT NULL
      );
      `);
    //创建代码符号
    this.db.exec(
      `
        CREATE TABLE IF NOT EXISTS symbols(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
        )
        `
    )
  }
  /**
 * 清空并重置某个文件的符号索引
 */
  clearFileIndex(filePath: string) {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
    this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
  }
  /**
   * 记录文件信息
   */
  insertFile(filePath: string, mtime: number) {
    this.db.prepare('INSERT INTO files (path, mtime) VALUES (?, ?)').run(filePath, mtime);
  }
  /**
   * 批量插入解析出来的符号
   */
  insertSymbol(name: string, kind: string, filePath: string, startLine: number, endLine: number) {
    this.db.prepare(
      'INSERT INTO symbols (name, kind, file_path, start_line, end_line) VALUES (?, ?, ?, ?, ?)'
    ).run(name, kind, filePath, startLine, endLine);
  }
  /**
   * 核心全局搜索：根据函数/类名，秒级定位它在哪个文件的第几行
   */
  searchSymbol(name: string) {
    const stmt = this.db.prepare(`
      SELECT * FROM symbols WHERE name LIKE ? LIMIT 10
    `);
    return stmt.all(`%${name}%`) as Array<{
      name: string;
      kind: string;
      file_path: string;
      start_line: string;
      end_line: string;
    }>;
  }
}