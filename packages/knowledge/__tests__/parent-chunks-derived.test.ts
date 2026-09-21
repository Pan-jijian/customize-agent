/**
 * 父块正文不得单独落盘（用户红线：不得出现任何重复数据）。
 *
 * 缺陷背景：`kb_parent_chunks.content` 存的是该节完整正文，而它恰好等于该节子切片按序
 * 拼接 —— 同一批字符存了两遍。全库实测 `kb_parent_chunks` 3,322,889 字符 ≈ 清洗后全文的
 * 0.97 倍，纯冗余；同一节文本还被复制进该节**首个子切片**的 metadata（`parentText`）。
 *
 * 修复：父块行不存正文，读取时由 `kb_chunks` 按 chunk_index 拼接重建
 * （读取路径本就写了这条兜底，此处把它变成唯一路径）。旧库已存正文的行直接沿用，无需迁移。
 *
 * `kb_document_chunks` 同理：曾以为「切片因裁剪并不完全覆盖全文，故全文表是必要的输入源」，
 * 实测**该说法不成立** —— 用「不含标点的 24 字符窗口」做判据（不受分块器在句读处的零宽切分
 * 影响），14 个文件 3,510 个窗口仅 1 个未命中（`35015TSSD_100_350160TSSD`，跨块边界的 CAD
 * 块名片段），缺失率 0.004%。分块对全文的覆盖是完整的，全文表属纯冗余 —— 已一并改为读取期
 * 由全部切片按 chunk_index 重建。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexStateStore } from '../src/core/index-state-store.js';
import { loadBetterSqlite3 } from '../src/core/sqlite-loader.js';

const REL = '项目/施工组织设计说明.docx';

const chunkOf = (index: number, text: string, parentId: string) => ({
  index, text, startChar: 0, endChar: text.length, tokenCount: 8,
  metadata: { chunkType: 'child', parentId, sectionTitle: '第一章 总体方案' },
});

describe('父块正文为派生数据（不落盘）', () => {
  const dirs: string[] = [];
  let currentDbPath = '';
  const dbPathOf = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kb-parent-derived-'));
    dirs.push(dir);
    currentDbPath = path.join(dir, 'kb.db');
    return currentDbPath;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** 写入两个父块（p0 两片、p1 一片）并返回 store */
  function seed(): IndexStateStore {
    const store = new IndexStateStore(dbPathOf());
    store.replaceChunks(REL, [
      chunkOf(0, '第一节 总体施工方案说明。', 'p0'),
      chunkOf(1, '第二节 主要分项工程施工方法。', 'p0'),
      chunkOf(2, '第三节 质量保证措施与验收标准。', 'p1'),
    ], { category: 'document', format: 'docx', collectionName: 'c' });
    return store;
  }

  /** 只读连接直查落盘的原始行（绕开 store 的重建逻辑） */
  function rawQuery<T>(sql: string): T[] {
    const db = new (loadBetterSqlite3())(currentDbPath, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  }

  it('kb_parent_chunks 不存正文（content 为空）', () => {
    seed();
    const rows = rawQuery<{ content: string }>('SELECT content FROM kb_parent_chunks');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.content).toBe('');
  });

  it('库内不存在与切片重复的第二份正文（父块字符数合计为 0）', () => {
    seed();
    const [row] = rawQuery<{ c: number | null }>('SELECT SUM(LENGTH(content)) AS c FROM kb_parent_chunks');
    expect(row?.c ?? 0).toBe(0);
  });

  it('listParentChunks 由子切片重建出完整父块正文', () => {
    const store = seed();
    const parents = store.listParentChunks(REL);
    expect(parents.length).toBe(2);

    const p0 = parents.find(p => p.parentId === 'p0')!;
    expect(p0.content).toContain('第一节 总体施工方案说明。');
    expect(p0.content).toContain('第二节 主要分项工程施工方法。');
    expect(p0.content).not.toContain('第三节');
    expect(p0.chunkCount).toBe(2);

    const p1 = parents.find(p => p.parentId === 'p1')!;
    expect(p1.content).toContain('第三节 质量保证措施与验收标准。');
  });

  it('getParentChunk 同样返回重建后的正文（检索期上下文展开依赖它）', () => {
    const store = seed();
    const parent = store.getParentChunk(REL, 'p0')!;
    expect(parent.content).toContain('第二节');
    expect(parent.content.length).toBeGreaterThan(0);
  });

  it('旧库已存正文的行直接沿用（无需迁移）', () => {
    seed();
    // 模拟旧库：手工写回一份正文
    const db = new (loadBetterSqlite3())(currentDbPath, { readonly: false });
    db.prepare("UPDATE kb_parent_chunks SET content = '旧库遗留正文' WHERE parent_id = 'p0'").run();
    db.close();

    const store = new IndexStateStore(currentDbPath);
    const parent = store.getParentChunk(REL, 'p0')!;
    expect(parent.content).toBe('旧库遗留正文');
  });
});

describe('文档级正文同样为派生数据（不落盘）', () => {
  const dirs: string[] = [];
  let currentDbPath = '';
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const dbPathOf = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kb-doc-derived-'));
    dirs.push(dir);
    currentDbPath = path.join(dir, 'kb.db');
    return currentDbPath;
  };

  function seed(): IndexStateStore {
    const store = new IndexStateStore(dbPathOf());
    store.replaceChunks(REL, [
      chunkOf(0, '甲段内容。', 'p0'),
      chunkOf(1, '乙段内容。', 'p0'),
      chunkOf(2, '丙段内容。', 'p1'),
    ], { category: 'document', format: 'docx', collectionName: 'c' });
    return store;
  }

  function rawQuery<T>(sql: string): T[] {
    const db = new (loadBetterSqlite3())(currentDbPath, { readonly: true, fileMustExist: true });
    try { return db.prepare(sql).all() as T[]; } finally { db.close(); }
  }

  it('kb_document_chunks 不存正文', () => {
    seed();
    const rows = rawQuery<{ content: string }>('SELECT content FROM kb_document_chunks');
    expect(rows.length).toBe(1);
    expect(rows[0]!.content).toBe('');
  });

  it('getDocumentChunk 由全部切片按 chunk_index 重建正文', () => {
    const store = seed();
    const doc = store.getDocumentChunk(REL)!;
    expect(doc.content).toContain('甲段内容。');
    expect(doc.content).toContain('乙段内容。');
    expect(doc.content).toContain('丙段内容。');
    // 顺序按 chunk_index
    expect(doc.content.indexOf('甲段')).toBeLessThan(doc.content.indexOf('乙段'));
    expect(doc.content.indexOf('乙段')).toBeLessThan(doc.content.indexOf('丙段'));
  });

  it('旧库已存正文的行直接沿用（无需迁移）', () => {
    seed();
    const db = new (loadBetterSqlite3())(currentDbPath, { readonly: false });
    db.prepare("UPDATE kb_document_chunks SET content = '旧库全文'").run();
    db.close();
    const store = new IndexStateStore(currentDbPath);
    expect(store.getDocumentChunk(REL)!.content).toBe('旧库全文');
  });
});
