import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { KnowledgeBaseManager } from '../src/core/knowledge-base-manager.js';
import { MultiProjectManager } from '../src/core/multi-project-manager.js';
import type { TextChunk } from '../src/chunking/text-chunker.js';
import type { IndexStateRecord } from '../src/types.js';

function createChunk(index: number): TextChunk {
  return {
    index,
    text: `统一检索词 第 ${index} 条资料内容，用于验证默认检索上限不会固定为 10。`,
    startChar: index * 10,
    endChar: index * 10 + 10,
    tokenCount: 20,
    sectionTitle: `测试小节 ${index}`,
    metadata: {},
  };
}

function seedManager(manager: KnowledgeBaseManager, relativePath = 'limit-source.md', count = 15): void {
  const now = Date.now();
  const record: IndexStateRecord = {
    relativePath,
    category: 'document',
    format: 'markdown',
    contentHash: `hash-${relativePath}-${count}`,
    fileSize: count * 100,
    mtime: now,
    chunkCount: count,
    collectionName: 'documents',
    indexedAt: now,
    lastVerifiedAt: now,
    status: 'active',
  };
  manager.store.upsertRecord(record);
  manager.store.replaceChunks(relativePath, Array.from({ length: count }, (_, index) => createChunk(index)), {
    category: 'document',
    format: 'markdown',
    collectionName: 'documents',
  });
}

function seedCustom(manager: KnowledgeBaseManager, relativePath: string, texts: string[]): void {
  const now = Date.now();
  const record: IndexStateRecord = {
    relativePath,
    category: 'document',
    format: 'markdown',
    contentHash: `hash-${relativePath}-custom`,
    fileSize: texts.length * 100,
    mtime: now,
    chunkCount: texts.length,
    collectionName: 'documents',
    indexedAt: now,
    lastVerifiedAt: now,
    status: 'active',
  };
  manager.store.upsertRecord(record);
  manager.store.replaceChunks(relativePath, texts.map((text, index) => ({
    index,
    text,
    startChar: index * 10,
    endChar: index * 10 + 10,
    tokenCount: 20,
    sectionTitle: `小节 ${index}`,
    metadata: {},
  })), { category: 'document', format: 'markdown', collectionName: 'documents' });
}

describe('knowledge search limit behavior', () => {
  it('keyword search defaults to the scoped corpus size instead of a fixed top-10 limit', () => {
    const manager = new KnowledgeBaseManager({
      scope: 'project',
      projectRoot: path.join(os.tmpdir(), `kb-limit-project-${Date.now()}`),
      projectId: `kb-limit-project-${Date.now()}`,
      storageRoot: path.join(os.tmpdir(), `kb-limit-storage-${Date.now()}`),
    });
    manager.initialize();
    seedManager(manager, 'limit-source.md', 15);

    expect(manager.search('统一检索词')).toHaveLength(15);
    expect(manager.search('统一检索词', undefined)).toHaveLength(15);
    expect(manager.search('统一检索词', 0)).toHaveLength(15);
    expect(manager.search('统一检索词', -1)).toHaveLength(15);
    expect(manager.search('统一检索词', Number.NaN)).toHaveLength(15);
    expect(manager.search('统一检索词', 12)).toHaveLength(12);
    expect(manager.search('统一检索词', undefined, { filePaths: ['limit-source.md'] })).toHaveLength(15);
  });

  it('file detail returns all chunks instead of a fixed 500 chunk prefix', () => {
    const manager = new KnowledgeBaseManager({
      scope: 'project',
      projectRoot: path.join(os.tmpdir(), `kb-detail-project-${Date.now()}`),
      projectId: `kb-detail-project-${Date.now()}`,
      storageRoot: path.join(os.tmpdir(), `kb-detail-storage-${Date.now()}`),
    });
    manager.initialize();
    seedManager(manager, 'detail-source.md', 520);

    const detail = manager.getFileDetail('detail-source.md');
    expect(detail?.chunks).toHaveLength(520);
    expect(detail?.chunks.at(-1)?.chunkIndex).toBe(519);
  });

  it('hybrid search and multi-project search do not fall back to a fixed top-10 limit', async () => {
    const storageRoot = path.join(os.tmpdir(), `kb-limit-multi-${Date.now()}`);
    const projectRoot = path.join(os.tmpdir(), `kb-limit-root-${Date.now()}`);
    const multi = new MultiProjectManager(storageRoot);
    const project = await multi.getProject(projectRoot);
    seedManager(project, 'limit-source.md', 15);

    const hybridDefault = await project.hybridSearch('统一检索词', { generationMode: true });
    expect(hybridDefault.results).toHaveLength(15);

    const hybridUndefined = await project.hybridSearch('统一检索词', { limit: undefined, generationMode: true });
    expect(hybridUndefined.results).toHaveLength(15);

    const hybridInvalid = await project.hybridSearch('统一检索词', { limit: 0, generationMode: true });
    expect(hybridInvalid.results).toHaveLength(15);

    const multiDefault = await multi.search(projectRoot, '统一检索词', { scope: 'project', generationMode: true });
    expect(multiDefault.results).toHaveLength(15);

    const multiUndefined = await multi.search(projectRoot, '统一检索词', { scope: 'project', limit: undefined, generationMode: true });
    expect(multiUndefined.results).toHaveLength(15);

    const multiExplicit = await multi.search(projectRoot, '统一检索词', { scope: 'project', limit: 12, generationMode: true });
    expect(multiExplicit.results).toHaveLength(12);
  });

  it('字母数字与汉字连续查询串按边界拆词，「C35混凝土」命中清单特征块', () => {
    const manager = new KnowledgeBaseManager({
      scope: 'project',
      projectRoot: path.join(os.tmpdir(), `kb-split-project-${Date.now()}`),
      projectId: `kb-split-project-${Date.now()}`,
      storageRoot: path.join(os.tmpdir(), `kb-split-storage-${Date.now()}`),
    });
    manager.initialize();
    // 清单特征块：精确含「混凝土强度等级：C35」
    seedCustom(manager, 'bill.md', ['满堂基础 混凝土种类：商品混凝土 混凝土强度等级：C35，P8 抗渗']);
    // 干扰块：大量「混凝土」但无 C35
    seedCustom(manager, 'green.md', ['绿色建筑评价标准 GB50378-2019 设计依据 混凝土 建筑材料 节能 环保 混凝土 构件 混凝土 结构']);
    const results = manager.search('C35混凝土', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.relativePath).toContain('bill.md');
  });
});
