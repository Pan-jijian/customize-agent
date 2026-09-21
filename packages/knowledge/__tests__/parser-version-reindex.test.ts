/**
 * G 线 P2-6：解析器版本戳驱动的自动重解析 + 失败路径的旧块清理。
 *
 * 缺陷背景：`change-tracker` 的重解析判据只覆盖「文件本身变了」（mtime/大小/内容哈希）
 * 与若干「明显坏掉」的形态。**解析器的改进对存量库完全不可见**——修好了图纸 MTEXT 格式码
 * 剥离（P2-7）、PDF 表格智能表头（P2-9），已入库的旧切片仍带着旧的错误内容，直到该文件
 * 本身被改动才重解析；唯一补救是人工触发全量重建，不可持续。
 *
 * 本文件锁定两件事：
 * ① 记录携带的 `parserVersion` 与当前 `PARSER_VERSION` 不一致（含缺失）即判为需重解析；
 * ② 重解析失败时**旧分块必须被清除**（记录保留标 error），否则记录声称「无内容」、
 *    实存却有一整套旧切片被继续检索到。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexStateStore } from '../src/core/index-state-store.js';
import { loadBetterSqlite3 } from '../src/core/sqlite-loader.js';
import { ChangeTracker } from '../src/core/change-tracker.js';
import { FileClassifier } from '../src/classification/classifier.js';
import { PARSER_VERSION } from '../src/extraction/parser-version.js';
import type { IndexStateRecord } from '../src/types.js';

const REL = '资料/招标文件.txt';

const recordOf = (overrides: Partial<IndexStateRecord> = {}): IndexStateRecord => ({
  relativePath: REL,
  category: 'document',
  format: 'plaintext',
  contentHash: 'hash-1',
  fileSize: 8,
  mtime: 1_700_000_000_000,
  chunkCount: 2,
  collectionName: 'proj_test_kb_document',
  indexedAt: 1_700_000_000_000,
  lastVerifiedAt: 1_700_000_000_000,
  status: 'active',
  ...overrides,
});

describe('G 线 P2-6 解析器版本戳', () => {
  const dirs: string[] = [];
  const makeKb = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kb-parserv-'));
    dirs.push(dir);
    const kbPath = path.join(dir, 'kb');
    const absolute = path.join(kbPath, REL);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, '正文内容测试', 'utf8');
    return { kbPath, absolute };
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const diffFor = async (metadataJson: string) => {
    const { kbPath, absolute } = makeKb();
    const store = new IndexStateStore(path.join(kbPath, 'kb.db'), loadBetterSqlite3());
    const stat = statSync(absolute);
    store.upsertRecord(recordOf({ fileSize: stat.size, mtime: stat.mtimeMs, metadataJson }));
    const tracker = new ChangeTracker(store);
    const diff = await tracker.computeDiff(
      new Map([[REL, { size: stat.size, mtime: stat.mtimeMs }]]),
      new FileClassifier(),
      kbPath,
    );
    store.close();
    return diff;
  };

  it('旧版本戳的记录被判为需重解析', async () => {
    const diff = await diffFor(JSON.stringify({ parserVersion: 'kb-parser-OLD' }));
    expect(diff.modifiedFiles.map(file => file.relativePath)).toContain(REL);
  });

  it('缺失版本戳的历史记录被判为需重解析（一次性全量重解析的来源）', async () => {
    const diff = await diffFor(JSON.stringify({ mimeType: 'text/plain' }));
    expect(diff.modifiedFiles.map(file => file.relativePath)).toContain(REL);
  });

  it('版本戳一致时不重解析（不在无解析器变更时空转）', async () => {
    const diff = await diffFor(JSON.stringify({ parserVersion: PARSER_VERSION }));
    expect(diff.modifiedFiles).toHaveLength(0);
    expect(diff.unchangedCount).toBe(1);
  });

  it('失败路径：deleteChunksForFile 清除旧块但保留记录', () => {
    const { kbPath } = makeKb();
    const store = new IndexStateStore(path.join(kbPath, 'kb.db'), loadBetterSqlite3());
    store.upsertRecord(recordOf({ metadataJson: JSON.stringify({ parserVersion: PARSER_VERSION }) }));
    store.replaceChunks(REL, [
      { index: 0, text: '旧切片一', startChar: 0, endChar: 4, tokenCount: 4, metadata: {} },
      { index: 1, text: '旧切片二', startChar: 4, endChar: 8, tokenCount: 4, metadata: {} },
    ], { category: 'document', format: 'plaintext', collectionName: 'proj_test_kb_document' });
    expect(store.countChunks({ relativePath: REL }), '前置：旧块确已入表').toBe(2);

    // 重解析失败：清旧块 + 落 error 记录（记录本身必须留下供变更追踪重试）
    store.deleteChunksForFile(REL);
    store.upsertRecord(recordOf({ chunkCount: 0, status: 'error', errorMessage: '未解析出可用正文', metadataJson: JSON.stringify({ parserVersion: PARSER_VERSION }) }));

    const record = store.loadActiveRecords().get(REL);
    expect(record?.status).toBe('error');
    expect(record?.chunkCount).toBe(0);
    // 旧切片必须已从分块表移除（否则「记录说无内容、实存有旧切片」被继续检索到）
    expect(store.countChunks({ relativePath: REL })).toBe(0);
    store.close();
  });
});
