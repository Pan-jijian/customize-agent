import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StorageManager } from '../src/index/db.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('StorageManager', () => {
  let db: StorageManager;
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = path.join(os.tmpdir(), `test-agent-${Date.now()}.db`);
    db = new StorageManager(tmpPath);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  });

  it('应正确插入和查询符号', () => {
    db.insertFile('src/test.ts', Date.now());
    db.insertSymbol('hello', 'Function', 'src/test.ts', 10, 15);

    const results = db.searchSymbol('hello');
    expect(results).toHaveLength(1);
    const sym = results[0]!;
    expect(sym.name).toBe('hello');
    expect(sym.kind).toBe('Function');
    expect(sym.file_path).toBe('src/test.ts');
    expect(sym.start_line).toBe(10);
  });

  it('不应返回不匹配的符号', () => {
    db.insertFile('src/test.ts', Date.now());
    db.insertSymbol('foo', 'Function', 'src/test.ts', 1, 3);

    const results = db.searchSymbol('nonexistent');
    expect(results).toHaveLength(0);
  });

  it('FTS5 全文搜索应返回带高亮片段的结果', () => {
    db.insertFile('src/auth.ts', Date.now());
    db.insertSymbol('authenticate', 'Function', 'src/auth.ts', 10, 20);
    db.insertSymbol('login', 'Function', 'src/auth.ts', 25, 30);

    const results = db.searchFts('authenticate');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('authenticate');
    expect(results[0]!.snippet).toBeTruthy();
  });

  it('LIKE 模糊搜索应返回部分匹配的结果', () => {
    db.insertFile('src/test.ts', Date.now());
    db.insertSymbol('authenticateUser', 'Function', 'src/test.ts', 5, 10);

    const results = db.searchSymbol('auth');
    expect(results).toHaveLength(1);
  });

  it('clearFileIndex 应清除指定文件的所有数据', () => {
    db.insertFile('src/to-delete.ts', Date.now());
    db.insertSymbol('fn', 'Function', 'src/to-delete.ts', 1, 3);

    db.clearFileIndex('src/to-delete.ts');
    expect(db.searchSymbol('fn')).toHaveLength(0);
  });
});
