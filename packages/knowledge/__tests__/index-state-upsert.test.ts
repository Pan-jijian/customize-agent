/**
 * upsertRecord 重新解析语义回归：ON CONFLICT 更新必须刷新 indexed_at。
 * 此前 UPDATE 子句漏了 indexed_at，重新解析已存在的文件时只有分块/哈希/状态变化，
 * 「解析时间」仍停在首次入库时刻 —— 用户据此判断「没有重新解析」。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexStateStore } from '../src/core/index-state-store.js';
import { loadBetterSqlite3 } from '../src/core/sqlite-loader.js';
import type { IndexStateRecord } from '../src/types.js';

const recordOf = (overrides: Partial<IndexStateRecord> = {}): IndexStateRecord => ({
  relativePath: '资料/招标文件.pdf',
  category: 'document',
  format: 'pdf',
  contentHash: 'hash-1',
  fileSize: 1024,
  mtime: 1_700_000_000_000,
  chunkCount: 2,
  collectionName: 'proj_test_kb_document',
  indexedAt: 1_700_000_000_000,
  lastVerifiedAt: 1_700_000_000_000,
  status: 'active',
  ...overrides,
});

/** 读取当前全部活跃记录（store 未暴露单条 getter） */
const readRecords = (store: IndexStateStore): Map<string, IndexStateRecord> => store.loadActiveRecords();

describe('upsertRecord 重新解析后的字段刷新', () => {
  const dirs: string[] = [];
  const dbPathOf = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kb-upsert-'));
    dirs.push(dir);
    return path.join(dir, 'kb.db');
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('重新解析同一文件时 indexed_at 被刷新', () => {
    const store = new IndexStateStore(dbPathOf(), loadBetterSqlite3());
    store.upsertRecord(recordOf());
    expect(readRecords(store).get('资料/招标文件.pdf')?.indexedAt).toBe(1_700_000_000_000);

    // 重新解析：分块数、内容哈希、解析时间全部前进
    const reindexedAt = 1_800_000_000_000;
    store.upsertRecord(recordOf({ contentHash: 'hash-2', chunkCount: 5, indexedAt: reindexedAt, lastVerifiedAt: reindexedAt }));

    const record = readRecords(store).get('资料/招标文件.pdf');
    expect(record?.indexedAt, '解析时间必须反映最近一次解析').toBe(reindexedAt);
    expect(record?.chunkCount).toBe(5);
    expect(record?.contentHash).toBe('hash-2');
    store.close();
  });

  it('统计里的 lastIndexedAt 随之前进', () => {
    const store = new IndexStateStore(dbPathOf(), loadBetterSqlite3());
    store.upsertRecord(recordOf({ relativePath: '资料/a.pdf' }));
    const before = store.getStats().lastIndexedAt;
    store.upsertRecord(recordOf({ relativePath: '资料/a.pdf', indexedAt: before + 60_000 }));
    expect(store.getStats().lastIndexedAt).toBeGreaterThan(before);
    store.close();
  });

  it('首次入库仍按传入的解析时间落库', () => {
    const store = new IndexStateStore(dbPathOf(), loadBetterSqlite3());
    store.upsertRecord(recordOf({ relativePath: '资料/b.pdf', indexedAt: 1_600_000_000_000 }));
    expect(readRecords(store).get('资料/b.pdf')?.indexedAt).toBe(1_600_000_000_000);
    store.close();
  });
});
