import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IndexStateStore } from '../src/core/index-state-store.js';
import { KnowledgeBaseManager } from '../src/core/knowledge-base-manager.js';
import type { IndexStateRecord } from '../src/types.js';

/**
 * 一期优化回归测试：
 * 1. listCollectionNames —— semanticSearch 集合发现由全表扫描改为 DISTINCT 索引查询
 * 2. 集合名 TTL 缓存 + noteCollectionName 即时可见（本进程写入不等 TTL）
 * 3. 孤儿向量登记（deleteVectorFile 失败）→ indexVectors 清扫重试
 */

let tmpDir: string;
let storageRoot: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-coll-cache-'));
  storageRoot = path.join(tmpDir, 'storage');
  fs.mkdirSync(storageRoot, { recursive: true });
  dbPath = path.join(storageRoot, 'test-kb.db');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

function makeRecord(overrides: Partial<IndexStateRecord> & { relativePath: string; collectionName: string }): IndexStateRecord {
  return {
    category: 'document',
    format: 'plaintext',
    contentHash: overrides.relativePath,
    fileSize: 10,
    mtime: Date.now(),
    chunkCount: 0,
    indexedAt: Date.now(),
    lastVerifiedAt: Date.now(),
    status: 'active',
    ...overrides,
  } as IndexStateRecord;
}

describe('IndexStateStore.listCollectionNames', () => {
  it('返回去重后的集合名（多文件同集合只出现一次）', () => {
    const store = new IndexStateStore(dbPath);
    try {
      store.upsertRecord(makeRecord({ relativePath: 'a.txt', collectionName: 'global-document' }));
      store.upsertRecord(makeRecord({ relativePath: 'b.txt', collectionName: 'global-document' }));
      store.upsertRecord(makeRecord({ relativePath: 'c.csv', collectionName: 'global-spreadsheet' }));
      expect(store.listCollectionNames().sort()).toEqual(['global-document', 'global-spreadsheet']);
    } finally {
      store.close();
    }
  });

  it('硬删除的记录不再贡献集合名', () => {
    const store = new IndexStateStore(dbPath);
    try {
      store.upsertRecord(makeRecord({ relativePath: 'a.txt', collectionName: 'global-document' }));
      store.upsertRecord(makeRecord({ relativePath: 'b.txt', collectionName: 'global-other' }));
      store.deleteRecord('b.txt');
      expect(store.listCollectionNames()).toEqual(['global-document']);
    } finally {
      store.close();
    }
  });
});

describe('KnowledgeBaseManager 集合名缓存', () => {
  it('TTL 窗口内不重扫库；noteCollectionName 写入即时可见', () => {
    const vectorStores = new Map();
    const manager = new KnowledgeBaseManager({ scope: 'global', storageRoot, vectorStores: vectorStores as never });
    manager.initialize();
    try {
      manager.store.upsertRecord(makeRecord({ relativePath: 'a.txt', collectionName: 'global-document' }));
      (manager as unknown as { ensureAllVectorStores(): void }).ensureAllVectorStores();
      expect(vectorStores.has('global-document')).toBe(true);

      // TTL 窗口内：库中新增集合不会立刻反映到向量存储（缓存命中，不重扫）
      manager.store.upsertRecord(makeRecord({ relativePath: 'b.csv', collectionName: 'global-spreadsheet' }));
      (manager as unknown as { ensureAllVectorStores(): void }).ensureAllVectorStores();
      expect(vectorStores.has('global-spreadsheet')).toBe(false);

      // 本进程索引写入路径会调用 noteCollectionName：同一 TTL 窗口内也立即可见
      (manager as unknown as { noteCollectionName(name: string): void }).noteCollectionName('global-spreadsheet');
      (manager as unknown as { ensureAllVectorStores(): void }).ensureAllVectorStores();
      expect(vectorStores.has('global-spreadsheet')).toBe(true);
    } finally {
      manager.close();
    }
  });
});

describe('孤儿向量清扫', () => {
  it('向量删除失败登记待清扫队列，indexVectors 重试成功后出队', async () => {
    const deleteByFilePath = vi.fn();
    const vectorStores = new Map([['global-document', { deleteByFilePath }]]);
    const manager = new KnowledgeBaseManager({ scope: 'global', storageRoot, vectorStores: vectorStores as never });
    manager.initialize();
    try {
      manager.store.upsertRecord(makeRecord({ relativePath: 'a.txt', collectionName: 'global-document' }));

      // 第一次删除失败 → 登记孤儿
      deleteByFilePath.mockRejectedValueOnce(new Error('io error'));
      await manager.removeFile('a.txt');
      const pending = manager.store.getMetadata('vector_orphan_pending');
      expect(pending).toContain('a.txt');
      expect(pending).toContain('global-document');

      // indexVectors 触发清扫：重试成功后队列清空
      deleteByFilePath.mockResolvedValue(undefined);
      await manager.indexVectors({});
      expect(deleteByFilePath).toHaveBeenCalledWith('a.txt');
      expect(manager.store.getMetadata('vector_orphan_pending') ?? '').toBe('');
    } finally {
      manager.close();
    }
  });

  it('清扫仍失败时保留在队列中等待下次重试', async () => {
    const deleteByFilePath = vi.fn().mockRejectedValue(new Error('persistent io error'));
    const vectorStores = new Map([['global-document', { deleteByFilePath }]]);
    const manager = new KnowledgeBaseManager({ scope: 'global', storageRoot, vectorStores: vectorStores as never });
    manager.initialize();
    try {
      manager.store.upsertRecord(makeRecord({ relativePath: 'a.txt', collectionName: 'global-document' }));
      await manager.removeFile('a.txt');
      await manager.indexVectors({});
      // 清扫重试仍失败 → 队列保留（不丢、不阻断索引主流程）
      expect(manager.store.getMetadata('vector_orphan_pending')).toContain('a.txt');
    } finally {
      manager.close();
    }
  });
});
