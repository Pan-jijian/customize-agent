import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IndexStateStore } from '../src/core/index-state-store.js';
import { KnowledgeBaseManager } from '../src/core/knowledge-base-manager.js';
import type { TextChunk } from '../src/chunking/text-chunker.js';
import type { FileCategory } from '../src/types.js';

/**
 * B1 跨项目目录守卫回归测试：
 * 1. IndexStateStore.deleteChunksOutsideGroups —— 绑定资料组外的 chunk 整体清除，组内与根目录直放文件保留
 * 2. KnowledgeBaseManager.syncIndexWithBoundGroups —— 绑定组持久化到 metadata + 清理统计
 * 3. 空 keepGroups 零清理（无权威范围不误删）；损坏 metadata 容错返回空
 */

let tmpDir: string;
let storageRoot: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bound-group-'));
  storageRoot = path.join(tmpDir, 'storage');
  fs.mkdirSync(storageRoot, { recursive: true });
  dbPath = path.join(storageRoot, 'test-kb.db');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

function makeChunk(index: number, text = '测试切片内容'): TextChunk {
  return { index, text, startChar: 0, endChar: text.length, tokenCount: 4, metadata: {} };
}

function seedChunks(store: IndexStateStore, relativePaths: string[]) {
  for (const relativePath of relativePaths) {
    store.replaceChunks(relativePath, [makeChunk(0), makeChunk(1)], {
      category: 'document' as FileCategory,
      format: 'txt',
      collectionName: 'proj-doc',
    });
    // 生产写入路径中 index_state 与 chunks 同步（manager 层清理依赖 listRecords）
    store.upsertRecord({
      category: 'document' as FileCategory,
      format: 'txt',
      contentHash: relativePath,
      fileSize: 10,
      mtime: Date.now(),
      chunkCount: 2,
      indexedAt: Date.now(),
      lastVerifiedAt: Date.now(),
      status: 'active',
      collectionName: 'proj-doc',
      relativePath,
    });
  }
}

describe('IndexStateStore.deleteChunksOutsideGroups', () => {
  it('清除跨项目资料组 chunk，保留绑定组与根目录直放文件', () => {
    const store = new IndexStateStore(dbPath);
    try {
      seedChunks(store, [
        '9.14--2026年度丰乐镇项目/1、图纸/施工图.pdf',
        '9.14--2026年度丰乐镇项目/4、工程量清单/清单.xls',
        '9.4合肥师范学院项目/图纸/图纸.pdf',
        '舒城/资料/招标文件.docx',
        '根目录直放文件.txt',
      ]);
      expect(store.countChunks({ relativePath: '9.4合肥师范学院项目/图纸/图纸.pdf' })).toBe(2);
      const result = store.deleteChunksOutsideGroups(['9.14--2026年度丰乐镇项目']);
      expect(result).toEqual({ deletedChunks: 4, deletedFiles: 2 });
      expect(store.countChunks({ relativePath: '9.4合肥师范学院项目/图纸/图纸.pdf' })).toBe(0);
      expect(store.countChunks({ relativePath: '舒城/资料/招标文件.docx' })).toBe(0);
      expect(store.countChunks({ relativePath: '9.14--2026年度丰乐镇项目/1、图纸/施工图.pdf' })).toBe(2);
      expect(store.countChunks({ relativePath: '根目录直放文件.txt' })).toBe(2);
    } finally {
      store.close();
    }
  });

  it('keepGroups 为空 → 零清理（无权威范围不误删）', () => {
    const store = new IndexStateStore(dbPath);
    try {
      seedChunks(store, ['9.4合肥师范学院项目/图纸/图纸.pdf']);
      const result = store.deleteChunksOutsideGroups([]);
      expect(result).toEqual({ deletedChunks: 0, deletedFiles: 0 });
      expect(store.countChunks({ relativePath: '9.4合肥师范学院项目/图纸/图纸.pdf' })).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe('KnowledgeBaseManager.syncIndexWithBoundGroups', () => {
  it('绑定组持久化到 metadata、组外数据清除并返回统计', async () => {
    const manager = new KnowledgeBaseManager({ scope: 'global', storageRoot });
    manager.initialize();
    try {
      seedChunks(manager.store, [
        '9.14--2026年度丰乐镇项目/清单.xls',
        '9.4合肥师范学院项目/图纸.pdf',
      ]);
      const result = await manager.syncIndexWithBoundGroups(['9.14--2026年度丰乐镇项目']);
      expect(result.deletedFiles).toBe(1);
      expect(result.deletedChunks).toBe(2);
      expect(manager.store.getMetadata('bound_groups')).toBe('["9.14--2026年度丰乐镇项目"]');
      expect(manager.store.countChunks({ relativePath: '9.4合肥师范学院项目/图纸.pdf' })).toBe(0);
      expect(manager.store.countChunks({ relativePath: '9.14--2026年度丰乐镇项目/清单.xls' })).toBe(2);
    } finally {
      manager.close();
    }
  });

  it('空 keepGroups 持久化为空数组且零清理', async () => {
    const manager = new KnowledgeBaseManager({ scope: 'global', storageRoot });
    manager.initialize();
    try {
      seedChunks(manager.store, ['9.4合肥师范学院项目/图纸.pdf']);
      const result = await manager.syncIndexWithBoundGroups([]);
      expect(result).toEqual({ deletedChunks: 0, deletedFiles: 0 });
      expect(manager.store.getMetadata('bound_groups')).toBe('[]');
      expect(manager.store.countChunks({ relativePath: '9.4合肥师范学院项目/图纸.pdf' })).toBe(2);
    } finally {
      manager.close();
    }
  });

  it('bound_groups metadata 损坏 → getBoundGroups 容错返回空（不设限不报错）', async () => {
    const manager = new KnowledgeBaseManager({ scope: 'global', storageRoot });
    manager.initialize();
    try {
      manager.store.setMetadata('bound_groups', '{not-json');
      seedChunks(manager.store, ['9.4合肥师范学院项目/图纸.pdf']);
      const result = await manager.syncIndexWithBoundGroups([]);
      expect(result).toEqual({ deletedChunks: 0, deletedFiles: 0 });
    } finally {
      manager.close();
    }
  });
});
