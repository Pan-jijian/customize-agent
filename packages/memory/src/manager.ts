import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/** 记忆类型 */
export type MemoryType = 'project_fact' | 'user_preference' | 'feedback' | 'pattern';

/** 记忆条目 */
export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  context: string;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 带相关性评分的检索结果 */
export interface ScoredMemory {
  entry: MemoryEntry;
  relevance: number; // 0~1, 越高越相关
}

/**
 * 跨会话记忆管理器。
 * 存储: ~/.customize-agent/memory.db (SQLite + FTS5)
 *
 * 4 种记忆类型:
 *   - project_fact:    项目架构、模块依存、构建系统
 *   - user_preference: 编码风格、命名约定、工具偏好
 *   - feedback:        用户纠正记录（"不要改 package-lock.json"等）
 *   - pattern:         常见问题解决模式
 */
export class MemoryManager {
  private db: Database.Database;

  constructor(storagePath?: string) {
    const dbPath = storagePath ?? path.join(os.homedir(), '.customize-agent', 'memory.db');
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._initTables();
  }

  private _initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('project_fact', 'user_preference', 'feedback', 'pattern')),
        content TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // FTS5 全文索引
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        context,
        content='memories',
        content_rowid='rowid'
      );
    `);

    // FTS5 同步触发器
    for (const trigger of ['ai', 'ad', 'au']) {
      const when = trigger === 'ai' ? 'INSERT' : trigger === 'ad' ? 'DELETE' : 'UPDATE';
      const [oldNew, rowid] = trigger === 'ad' ? ['old', 'old.rowid'] : ['new', 'new.rowid'];

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_${trigger} AFTER ${when} ON memories BEGIN
          ${trigger === 'ad'
            ? `INSERT INTO memories_fts(memories_fts, rowid, content, context) VALUES ('delete', ${rowid}, ${oldNew}.content, ${oldNew}.context);`
            : trigger === 'au'
              ? `INSERT INTO memories_fts(memories_fts, rowid, content, context) VALUES ('delete', old.rowid, old.content, old.context);
                 INSERT INTO memories_fts(rowid, content, context) VALUES (${rowid}, ${oldNew}.content, ${oldNew}.context);`
              : `INSERT INTO memories_fts(rowid, content, context) VALUES (${rowid}, ${oldNew}.content, ${oldNew}.context);`
          }
        END;
      `);
    }
  }

  /**
   * 记录一条记忆。同 content hash 的记忆会去重（更新 updated_at + access_count）。
   */
  remember(type: MemoryType, content: string, context: string = ''): string {
    const id = this._hash(content.slice(0, 200));

    const existing = this.db.prepare('SELECT id FROM memories WHERE id = ?').get(id) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE memories
        SET access_count = access_count + 1, updated_at = datetime('now'), context = ?
        WHERE id = ?
      `).run(context, id);
    } else {
      this.db.prepare(`
        INSERT INTO memories (id, type, content, context) VALUES (?, ?, ?, ?)
      `).run(id, type, content, context);
    }

    return id;
  }

  /**
   * 检索相关记忆，返回带相关性评分的列表。
   * FTS5 全文搜索 → 无结果则 LIKE 回退。
   * 评分 = FTS5 rank 倒数 × log(1+access_count) 热度加权
   */
  recallScored(query: string, limit: number = 10): ScoredMemory[] {
    const ftsResults = this.db.prepare(`
      SELECT m.*, rank FROM memories m
      JOIN memories_fts fts ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Array<Record<string, unknown>>;

    if (ftsResults.length > 0) {
      return ftsResults.map(r => ({
        entry: this._rowToEntry(r),
        relevance: (1 / (1 + Number(r.rank ?? 0))) * Math.log(1 + Number(r.access_count ?? 0) + 1),
      })).sort((a, b) => b.relevance - a.relevance);
    }

    // LIKE 回退：相关性 = 0.1 × log(1+access_count)
    const likeResults = this.db.prepare(`
      SELECT * FROM memories
      WHERE content LIKE ? OR context LIKE ?
      ORDER BY access_count DESC LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit) as Array<Record<string, unknown>>;

    return likeResults.map(r => ({
      entry: this._rowToEntry(r),
      relevance: 0.1 * Math.log(1 + Number(r.access_count ?? 0) + 1),
    }));
  }

  /** 简单检索（向后兼容） */
  recall(query: string, limit: number = 10): MemoryEntry[] {
    return this.recallScored(query, limit).map(s => s.entry);
  }

  /**
   * 将相关记忆注入 System Prompt 前缀。
   * 检索时使用任务描述作为 query，找到最相关的记忆追加到 Prompt。
   */
  injectMemories(systemPrompt: string, task: string): string {
    const memories = this.recall(task, 5);
    if (memories.length === 0) return systemPrompt;

    const memoryLines = memories.map(m =>
      `[记忆·${this.typeLabel(m.type)}]: ${m.content}`
    );

    return `${systemPrompt}\n\n--- 相关历史记忆 ---\n${memoryLines.join('\n')}\n--- 记忆结束 ---`;
  }

  /**
   * 记录用户反馈（纠正 Agent 的错误行为）。
   * 反馈类记忆权重最高，检索时优先展示。
   */
  async recordFeedback(incorrectBehavior: string, correction: string): Promise<void> {
    // 先找是否已有类似反馈
    const existing = this.recall(incorrectBehavior, 3);
    const similar = existing.find(e => e.type === 'feedback' && e.content.includes(incorrectBehavior.slice(0, 50)));

    if (similar) {
      // 更新已有反馈
      this.db.prepare(`
        UPDATE memories SET content = ?, context = ?, updated_at = datetime('now'), access_count = access_count + 1
        WHERE id = ?
      `).run(`纠正: ${correction}`, incorrectBehavior, similar.id);
    } else {
      this.remember('feedback', `纠正: ${correction}`, incorrectBehavior);
    }
  }

  /** 清除某类全部记忆 */
  clear(type?: MemoryType): void {
    if (type) {
      this.db.prepare('DELETE FROM memories WHERE type = ?').run(type);
    } else {
      this.db.prepare('DELETE FROM memories').run();
    }
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }

  // === 内部工具方法 ===

  private _rowToEntry(row: Record<string, unknown>): MemoryEntry {
    return {
      id: String(row.id),
      type: String(row.type) as MemoryType,
      content: String(row.content),
      context: String(row.context ?? ''),
      accessCount: Number(row.access_count ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** 记忆类型的中文标签（供外部 i18n 覆盖） */
  typeLabel(type: MemoryType): string {
    const labels: Record<MemoryType, string> = {
      project_fact: '项目知识',
      user_preference: '用户偏好',
      feedback: '历史纠偏',
      pattern: '解决方案',
    };
    return labels[type] ?? type;
  }

  /** 获取记忆总数 */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
  }

  /** 列出所有记忆（按更新时间倒序） */
  listAll(limit = 20): MemoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => this._rowToEntry(r));
  }

  /** 简单字符串哈希 (FNV-1a) */
  private _hash(str: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }
}
