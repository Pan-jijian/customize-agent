/**
 * IndexStateStore material_root 专项单测（资料包 ID 一等实体化）：
 * 1) 写入派生：replaceChunks / upsertRecord 落库首段目录；
 * 2) 双锁检索：searchChunks 按 materialRoots 单锁 / filePaths+materialRoots AND 双锁；
 * 3) 老库迁移：无列老库打开即 ALTER 加列 + SQL 表达式回填 + 标记短路，回填后按包过滤直达老数据。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexStateStore } from '../src/core/index-state-store.js';
import { loadBetterSqlite3 } from '../src/core/sqlite-loader.js';
import type { IndexStateRecord } from '../src/types.js';

const chunkOf = (index: number, text: string) => ({ index, text, startChar: 0, endChar: text.length, tokenCount: 8, metadata: { chunkType: 'child' } });

const recordOf = (relativePath: string, chunkCount = 2): IndexStateRecord => ({
  relativePath,
  category: 'document',
  format: 'pdf',
  contentHash: `hash-${relativePath}`,
  fileSize: 1024,
  mtime: Date.now(),
  chunkCount,
  collectionName: 'proj_test_kb_document',
  indexedAt: Date.now(),
  lastVerifiedAt: Date.now(),
  status: 'active',
});

describe('IndexStateStore material_root 派生、双锁检索与老库迁移', () => {
  const dirs: string[] = [];
  const dbPathOf = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kb-material-root-'));
    dirs.push(dir);
    return path.join(dir, 'kb.db');
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('replaceChunks 写入派生 material_root：按包单锁与 filePaths+materialRoots 双锁过滤', () => {
    const store = new IndexStateStore(dbPathOf());
    try {
      store.replaceChunks('舒城(2)/招标文件.pdf', [chunkOf(0, '本项目招标范围包括土建与安装工程。')], { category: 'document', format: 'pdf', collectionName: 'c' });
      store.replaceChunks('丰乐镇/中标通知书.docx', [chunkOf(0, '中标通知书正文内容。')], { category: 'document', format: 'docx', collectionName: 'c' });

      const byPack = store.searchChunks('招标范围', 10, { materialRoots: ['舒城(2)'] });
      expect(byPack.map(item => item.relativePath)).toEqual(['舒城(2)/招标文件.pdf']);

      expect(store.searchChunks('招标范围', 10, { materialRoots: ['丰乐镇'] })).toHaveLength(0);
      // 双锁 AND：包命中但文件白名单不含 → 空（双锁永不放大范围）
      expect(store.searchChunks('招标范围', 10, { materialRoots: ['舒城(2)'], filePaths: ['丰乐镇/中标通知书.docx'] })).toHaveLength(0);
      expect(store.searchChunks('招标范围', 10, { filePaths: ['舒城(2)/招标文件.pdf'] })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('upsertRecord 写入派生 material_root，countIndexedChunks 支持包口径统计', () => {
    const store = new IndexStateStore(dbPathOf());
    try {
      store.upsertRecord(recordOf('舒城(2)/a.pdf', 3));
      store.upsertRecord(recordOf('丰乐镇/b.pdf', 4));
      store.upsertRecord(recordOf('顶层散文件.pdf', 5));

      expect(store.countIndexedChunks(undefined, ['舒城(2)'])).toBe(3);
      expect(store.countIndexedChunks(undefined, ['舒城(2)', '丰乐镇'])).toBe(7);
      // 顶层散文件不属任何包（material_root 为空串，非包名）
      expect(store.countIndexedChunks(undefined, ['顶层散文件.pdf'])).toBe(0);
      expect(store.countIndexedChunks()).toBe(12);
      expect(store.countIndexedChunks(['舒城(2)/a.pdf'], ['丰乐镇'])).toBe(0);
      expect(store.countIndexedChunks(['舒城(2)/a.pdf'], ['舒城(2)'])).toBe(3);
    } finally {
      store.close();
    }
  });

  it('老库升级：ALTER 加列 + SQL 表达式回填 + 标记短路；回填后按包过滤直达老数据', () => {
    const dbPath = dbPathOf();
    const seed = new IndexStateStore(dbPath);
    try {
      seed.replaceChunks('舒城(2)/招标文件.pdf', [chunkOf(0, '本项目招标范围包括土建与安装工程。')], { category: 'document', format: 'pdf', collectionName: 'c' });
      seed.replaceChunks('顶层散篇.pdf', [chunkOf(0, '顶层散篇正文。')], { category: 'document', format: 'pdf', collectionName: 'c' });
      seed.upsertRecord(recordOf('舒城(2)/招标文件.pdf', 1));
    } finally {
      seed.close();
    }

    // 模拟升级前老库形态：移除 material_root 列、索引与回填标记（数据行保留）
    const raw = new (loadBetterSqlite3())(dbPath);
    raw.exec('DROP INDEX IF EXISTS idx_kb_chunks_material_root');
    raw.exec('DROP INDEX IF EXISTS idx_kb_state_material_root');
    for (const table of ['kb_index_state', 'kb_chunks', 'kb_parent_chunks', 'kb_document_chunks']) {
      raw.exec(`ALTER TABLE ${table} DROP COLUMN material_root`);
    }
    raw.prepare('DELETE FROM kb_metadata WHERE key = ?').run('material_root_backfill_v1');
    raw.close();

    const migrated = new IndexStateStore(dbPath);
    try {
      // 按包过滤直达老数据；顶层散文件（回填空串）不入任何包
      expect(migrated.searchChunks('招标范围', 10, { materialRoots: ['舒城(2)'] }).some(item => item.relativePath === '舒城(2)/招标文件.pdf')).toBe(true);
      expect(migrated.countIndexedChunks(undefined, ['舒城(2)'])).toBe(1);
      expect(migrated.searchChunks('顶层散篇正文', 10, { materialRoots: ['舒城(2)'] })).toHaveLength(0);
      // 无过滤检索不受影响（顶层散篇仍可召回）
      expect(migrated.searchChunks('顶层散篇正文', 10).some(item => item.relativePath === '顶层散篇.pdf')).toBe(true);
    } finally {
      migrated.close();
    }

    // 回填列值与标记落库（直接读库确认）
    const check = new (loadBetterSqlite3())(dbPath);
    const columns = check.prepare('PRAGMA table_info(kb_chunks)').all() as Array<{ name?: unknown }>;
    expect(columns.some(column => String(column.name) === 'material_root')).toBe(true);
    const marker = check.prepare('SELECT value FROM kb_metadata WHERE key = ?').get('material_root_backfill_v1');
    expect(marker).toBeTruthy();
    const filled = check.prepare('SELECT material_root FROM kb_chunks WHERE relative_path = ?').get('舒城(2)/招标文件.pdf') as { material_root?: string } | undefined;
    expect(filled?.material_root).toBe('舒城(2)');
    const topLevel = check.prepare('SELECT material_root FROM kb_chunks WHERE relative_path = ?').get('顶层散篇.pdf') as { material_root?: string } | undefined;
    expect(topLevel?.material_root).toBe('');
    check.close();
  });
});
