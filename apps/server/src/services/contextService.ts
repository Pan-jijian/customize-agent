import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export type Importance = 'high' | 'medium' | 'low';

export interface ContextEntry {
  id: string;
  title: string;
  content: string;
  type: string;
  importance: Importance;
  tags: string[];
  source: string;
  created_at: number;
  updated_at: number;
}

const TYPE_LABELS: Record<string, string> = {
  project_fact: '项目知识', user_preference: '用户偏好',
  feedback: '历史纠偏', pattern: '解决方案',
};

function importanceFromCount(n: number): Importance {
  if (n >= 5) return 'high';
  if (n >= 2) return 'medium';
  return 'low';
}

function openMemoryDb(): Database.Database | null {
  const dbPath = path.join(os.homedir(), '.customize-agent', 'memory.db');
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

function rowToEntry(r: Record<string, unknown>): ContextEntry {
  const accessCount = Number(r.access_count ?? 0);
  return {
    id: String(r.id),
    title: String(r.content || '').slice(0, 80),
    content: String(r.content || ''),
    type: String(r.type || 'project_fact'),
    importance: importanceFromCount(accessCount),
    tags: [TYPE_LABELS[String(r.type)] || String(r.type)],
    source: String(r.context || '').slice(0, 100),
    created_at: new Date(String(r.created_at)).getTime(),
    updated_at: new Date(String(r.updated_at)).getTime(),
  };
}

// ── 长期上下文: 高重要性 + 高访问次数（持久化核心记忆） ──

export function listLongTermContexts(search?: string): ContextEntry[] {
  const db = openMemoryDb();
  if (!db) return [];
  try {
    let sql = 'SELECT * FROM memories WHERE access_count >= 2';
    const params: unknown[] = [];
    if (search) { sql += ' AND (content LIKE ? OR context LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY access_count DESC, updated_at DESC LIMIT 200';
    return (db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map(rowToEntry);
  } finally { db.close(); }
}

// ── 短期上下文: 最近创建/更新的记忆（当前工作上下文） ──

export function listShortTermContexts(search?: string): ContextEntry[] {
  const db = openMemoryDb();
  if (!db) return [];
  try {
    let sql = 'SELECT * FROM memories WHERE access_count < 2';
    const params: unknown[] = [];
    if (search) { sql += ' AND (content LIKE ? OR context LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY updated_at DESC LIMIT 200';
    return (db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map(rowToEntry);
  } finally { db.close(); }
}

export function recallDocumentContexts(query: string, limit = 8, projectRoot?: string): ContextEntry[] {
  const db = openMemoryDb();
  if (!db) return [];
  try {
    const terms = query.split(/[\s,，。；;:：、/\\|]+/u).map(item => item.trim()).filter(item => item.length >= 2).slice(0, 8);
    const projectLike = projectRoot ? `%Project: ${path.resolve(projectRoot)}%` : undefined;
    if (terms.length === 0) {
      const rows = projectLike
        ? db.prepare(`SELECT * FROM memories WHERE context LIKE ? ORDER BY access_count DESC, updated_at DESC LIMIT ?`).all(projectLike, limit)
        : db.prepare(`SELECT * FROM memories ORDER BY access_count DESC, updated_at DESC LIMIT ?`).all(limit);
      return (rows as Array<Record<string, unknown>>).map(rowToEntry);
    }
    const clauses = terms.map(() => '(content LIKE ? OR context LIKE ?)').join(' OR ');
    const params = terms.flatMap(term => [`%${term}%`, `%${term}%`]);
    const rows = projectLike
      ? db.prepare(`
        SELECT * FROM memories
        WHERE context LIKE ? AND (${clauses})
        ORDER BY access_count DESC, updated_at DESC
        LIMIT ?
      `).all(projectLike, ...params, limit)
      : db.prepare(`
        SELECT * FROM memories
        WHERE ${clauses}
        ORDER BY access_count DESC, updated_at DESC
        LIMIT ?
      `).all(...params, limit);
    return (rows as Array<Record<string, unknown>>).map(rowToEntry);
  } finally { db.close(); }
}

function hashMemory(content: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function ensureMemorySchema(db: Database.Database) {
  db.exec(`
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
}

export function rememberDocumentContext(type: 'project_fact' | 'user_preference' | 'feedback' | 'pattern', content: string, context = ''): string | null {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  if (!normalized) return null;
  const dbPath = path.join(os.homedir(), '.customize-agent', 'memory.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    ensureMemorySchema(db);
    const id = hashMemory(`${context}\n${normalized.slice(0, 200)}`);
    db.prepare(`
      INSERT INTO memories (id, type, content, context) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET access_count = access_count + 1, updated_at = datetime('now'), context = ?
    `).run(id, type, normalized, context, context);
    return id;
  } finally { db.close(); }
}

// ── 删除记忆 ──

export function deleteMemory(id: string): boolean {
  const dbPath = path.join(os.homedir(), '.customize-agent', 'memory.db');
  if (!fs.existsSync(dbPath)) return false;
  const db = new Database(dbPath);
  try {
    const r = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return r.changes > 0;
  } finally { db.close(); }
}

// ── 编辑记忆 ──

export function updateMemory(id: string, data: { content: string; context?: string }): boolean {
  const dbPath = path.join(os.homedir(), '.customize-agent', 'memory.db');
  if (!fs.existsSync(dbPath)) return false;
  const db = new Database(dbPath);
  try {
    const r = db.prepare("UPDATE memories SET content = ?, context = ?, updated_at = datetime('now') WHERE id = ?")
      .run(data.content, data.context || '', id);
    return r.changes > 0;
  } finally { db.close(); }
}

function whereForType(type: string): string {
  return type === 'long_term' ? 'access_count >= 2' : 'access_count < 2';
}

export function getContextStats(type: string): { count: number; totalBytes: number } {
  const db = openMemoryDb();
  if (!db) return { count: 0, totalBytes: 0 };
  try {
    const row = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(LENGTH(content) + LENGTH(context)), 0) as totalBytes FROM memories WHERE ${whereForType(type)}`).get() as { count: number; totalBytes: number };
    return { count: Number(row.count ?? 0), totalBytes: Number(row.totalBytes ?? 0) };
  } finally { db.close(); }
}

export function clearContexts(type: string): number {
  const dbPath = path.join(os.homedir(), '.customize-agent', 'memory.db');
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath);
  try {
    const rows = db.prepare(`SELECT rowid FROM memories WHERE ${whereForType(type)}`).all() as Array<{ rowid: number }>;
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM memories WHERE ${whereForType(type)}`).run();
    });
    tx();
    return rows.length;
  } finally { db.close(); }
}

/** 对指定类型的上下文记忆进行长度压缩，将超过 1200 字符的内容截断为前后摘要，减少存储空间 */
export function compressContexts(type: string): { changed: number; beforeBytes: number; afterBytes: number } {
  const dbPath = path.join(os.homedir(), '.customize-agent', 'memory.db');
  if (!fs.existsSync(dbPath)) return { changed: 0, beforeBytes: 0, afterBytes: 0 };
  const db = new Database(dbPath);
  try {
    const rows = db.prepare(`SELECT id, content, context FROM memories WHERE ${whereForType(type)}`).all() as Array<{ id: string; content: string; context: string }>;
    let changed = 0;
    let beforeBytes = 0;
    let afterBytes = 0;
    const compact = (text: string) => {
      const normalized = String(text || '').replace(/\s+/gu, ' ').trim();
      return normalized.length > 1200 ? `${normalized.slice(0, 1000)} … ${normalized.slice(-160)}` : normalized;
    };
    const update = db.prepare("UPDATE memories SET content = ?, context = ?, updated_at = datetime('now') WHERE id = ?");
    const tx = db.transaction(() => {
      for (const row of rows) {
        beforeBytes += Buffer.byteLength(`${row.content}${row.context}`);
        const content = compact(row.content);
        const context = compact(row.context);
        afterBytes += Buffer.byteLength(`${content}${context}`);
        if (content !== row.content || context !== row.context) {
          update.run(content, context, row.id);
          changed++;
        }
      }
    });
    tx();
    return { changed, beforeBytes, afterBytes };
  } finally { db.close(); }
}
