/**
 * 4.61 真实语料矩阵 · 模板化判据（句尾复读开集判据在真实文本上的稳定性）。
 *
 * 与 `packages/knowledge/__tests__/materialsRealCorpusMatrix.test.ts` 同属用户定的
 * 测试基本原则（十万加用例 / 真实业务回归）落点，只是判据在 server 包
 *（`templatingGovernance`），故矩阵也放在 server 侧——跨包导入会把包边界弄坏。
 *
 * 断言的是**判据自身的稳定性**（降序、计数与样本一致、尾长恒定），而不是"文本没有复读"：
 * 真实语料本来就有大量复读（这正是该判据存在的理由），断言"没有复读"会让用例必然失败。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBetterSqlite3 } from '@customize-agent/knowledge';
import { SENTENCE_TAIL_LENGTH, sentenceTailRepeatHits } from '@/services/document-workflow/templatingGovernance';

const DB_PATH = join(homedir(), '.customize-agent', 'projects', '3c3f04667c69', 'kb.db');
const dbAvailable = existsSync(DB_PATH);
const DOC_LIMIT = 2000;

const docs = dbAvailable
  ? (() => {
      const db = new (loadBetterSqlite3())(DB_PATH, { readonly: true, fileMustExist: true });
      try {
        return (db.prepare(`SELECT relative_path, content FROM kb_chunks WHERE length(content) > 1000 ORDER BY rowid LIMIT ${DOC_LIMIT}`).all() as Array<Record<string, unknown>>)
          .map(row => ({ file: String(row.relative_path ?? ''), content: String(row.content ?? '') }));
      } finally {
        db.close();
      }
    })()
  : [];

describe.skipIf(!dbAvailable)('4.61 真实语料矩阵 · 句尾复读判据稳定性', () => {
  it('文档级取样非空（空集会使用例全部空过）', () => {
    expect(docs.length).toBeGreaterThan(100);
  });

  it.each(docs.map((row, index) => [index, row] as const))(
    '文档切片 #%i：命中按次数降序、计数与样本一致、尾长恒定',
    (_index, row) => {
      const hits = sentenceTailRepeatHits(row.content);
      for (let position = 1; position < hits.length; position += 1) {
        expect(hits[position - 1]!.count).toBeGreaterThanOrEqual(hits[position]!.count);
      }
      for (const hit of hits) {
        expect(hit.count).toBe(hit.sentences.length);
        expect(hit.tail.length).toBe(SENTENCE_TAIL_LENGTH);
      }
    },
  );
});
