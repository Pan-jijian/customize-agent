import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectInfo, ProjectStatus } from '../types.js';

export class ProjectRegistry {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  upsert(project: ProjectInfo): void {
    this.db.prepare(`
      INSERT INTO project_registry (
        project_id, project_root, project_name, kb_path, file_count,
        chunk_count, total_size_bytes, last_indexed_at, created_at,
        last_opened_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        project_root = excluded.project_root,
        project_name = excluded.project_name,
        kb_path = excluded.kb_path,
        file_count = excluded.file_count,
        chunk_count = excluded.chunk_count,
        total_size_bytes = excluded.total_size_bytes,
        last_indexed_at = excluded.last_indexed_at,
        last_opened_at = excluded.last_opened_at,
        status = excluded.status
    `).run(
      project.projectId,
      project.projectRoot,
      project.projectName ?? null,
      project.kbPath,
      project.fileCount,
      project.chunkCount,
      project.totalSizeBytes,
      project.lastIndexedAt,
      Date.now(),
      project.lastOpenedAt,
      project.status,
    );
  }

  list(): ProjectInfo[] {
    const rows = this.db.prepare('SELECT * FROM project_registry ORDER BY last_opened_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map(row => ({
      projectId: String(row.project_id),
      projectRoot: String(row.project_root),
      projectName: row.project_name == null ? undefined : String(row.project_name),
      kbPath: String(row.kb_path),
      fileCount: Number(row.file_count ?? 0),
      chunkCount: Number(row.chunk_count ?? 0),
      totalSizeBytes: Number(row.total_size_bytes ?? 0),
      lastIndexedAt: Number(row.last_indexed_at ?? 0),
      lastOpenedAt: Number(row.last_opened_at ?? 0),
      status: String(row.status ?? 'idle') as ProjectStatus,
    }));
  }

  forget(projectId: string): void {
    this.db.prepare('DELETE FROM project_registry WHERE project_id = ?').run(projectId);
  }

  close(): void {
    this.db.close();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_registry (
        project_id      TEXT PRIMARY KEY,
        project_root    TEXT NOT NULL UNIQUE,
        project_name    TEXT,
        kb_path         TEXT NOT NULL,
        file_count      INTEGER NOT NULL DEFAULT 0,
        chunk_count     INTEGER NOT NULL DEFAULT 0,
        total_size_bytes INTEGER NOT NULL DEFAULT 0,
        last_indexed_at INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        last_opened_at  INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active'
      );
      CREATE INDEX IF NOT EXISTS idx_registry_status ON project_registry(status);
    `);
  }
}
