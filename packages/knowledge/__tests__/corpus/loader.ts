/**
 * 真实语料矩阵的**共享数据加载器**（4.61）。
 *
 * 用户定的测试基本原则是「**每类各自十万加**」——实体级 / 尺寸级 / 切片级 / 句子级 / 文档级
 * 五类各自 ≥100,000 个用例，不是总量十万加。因此每类各自成文件，共享本加载器。
 *
 * ## 加载策略
 *
 * - 只读打开 kb.db（`readonly: true, fileMustExist: true`），用完即关，不持有连接。
 * - 只取本类别需要的列（不 SELECT *）：50 万级行 × 宽行会把内存吃光。
 * - 库不存在时 `available = false`，各文件用 `describe.skipIf` **显式跳过**——
 *   静默 return 会让"没跑"看起来像"跑过了"。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadBetterSqlite3 } from '../../src/core/sqlite-loader.js';
import type { CadEntity } from '../../src/index.js';

export const DB_PATH = join(homedir(), '.customize-agent', 'projects', '3c3f04667c69', 'kb.db');
export const dbAvailable = existsSync(DB_PATH);

export function readRows<T>(sql: string, map: (row: Record<string, unknown>) => T): T[] {
  if (!dbAvailable) return [];
  const db = new (loadBetterSqlite3())(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare(sql).all() as Array<Record<string, unknown>>).map(map);
  } finally {
    db.close();
  }
}

export interface EntityRow { file: string; entity: CadEntity }

/** CAD 实体行（真实库 504,002 条）；`limit` 控制用例规模 */
export function loadEntities(limit: number): EntityRow[] {
  return readRows(
    `SELECT relative_path, payload_json FROM kb_material_entities WHERE entity_kind='cad-entity' ORDER BY rowid LIMIT ${Math.max(1, Math.floor(limit))}`,
    row => ({ file: String(row.relative_path ?? ''), entity: JSON.parse(String(row.payload_json ?? '{}')) as CadEntity }),
  );
}

/** 带被标注两点的尺寸实体（真实库 60,676 条） */
export function loadDimensions(limit: number): EntityRow[] {
  return readRows(
    `SELECT relative_path, payload_json FROM kb_material_entities
     WHERE entity_kind='cad-entity' AND json_extract(payload_json,'$.entityType')='DIMENSION'
     ORDER BY rowid LIMIT ${Math.max(1, Math.floor(limit))}`,
    row => ({ file: String(row.relative_path ?? ''), entity: JSON.parse(String(row.payload_json ?? '{}')) as CadEntity }),
  );
}

export interface ChunkRow { file: string; content: string }

export function loadChunks(limit: number, minLength = 60): ChunkRow[] {
  return readRows(
    `SELECT relative_path, content FROM kb_chunks WHERE content IS NOT NULL AND length(content) >= ${Math.max(1, Math.floor(minLength))} ORDER BY rowid LIMIT ${Math.max(1, Math.floor(limit))}`,
    row => ({ file: String(row.relative_path ?? ''), content: String(row.content ?? '') }),
  );
}

/** 归档文档（`generatedDocuments/assets/*.md`）——文档级矩阵的数据源 */
export function archivedDocumentPaths(): string[] {
  const dir = join(homedir(), '.customize-agent', 'projects', '3c3f04667c69', 'generatedDocuments', 'assets');
  if (!existsSync(dir)) return [];
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  return readdirSync(dir).filter(name => name.endsWith('.md')).map(name => join(dir, name));
}
