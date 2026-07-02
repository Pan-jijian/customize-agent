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
