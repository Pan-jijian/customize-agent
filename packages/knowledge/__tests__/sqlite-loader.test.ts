import { describe, expect, it } from 'vitest';
import { loadBetterSqlite3 } from '../src/core/sqlite-loader.js';

describe('sqlite-loader', () => {
  it('正常路径返回可用的 better-sqlite3 构造器', () => {
    const Database = loadBetterSqlite3();
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('sqlite-loader');
    const row = db.prepare('SELECT name FROM t WHERE id = 1').get() as { name: string };
    expect(row.name).toBe('sqlite-loader');
    db.close();
  });

  it('同一进程内多次调用返回同一构造器实例（探测与补位仅执行一次）', () => {
    expect(loadBetterSqlite3()).toBe(loadBetterSqlite3());
  });
});
