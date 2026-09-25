/**
 * 句子级真实语料矩阵（目标 **≥100,000 用例**）。
 *
 * 数据源：知识库切片与归档文档中的**真实句子**（归档 270 份文档实测 215,047 句 ≥12 字含数字）。
 * 每句一个用例，断言约束句解析（`parseClauseFacts`）在真实语料上的形态判据性质：
 * 值非空 / 值形态合法（数值或牌号或区间）/ 关系合法 / 属性名非空。
 *
 * 为什么选句子粒度：本层的值解析是**形状判据**（无词表），形状判据的失效方式恰恰是
 * 「某一种真实句式没被覆盖到」——句子粒度是能覆盖真实句式的最小单位，也是失败信息
 * 仍能自带坐标（哪句话）的最大单位。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseClauseFacts } from '../../src/index.js';
import { archivedDocumentPaths, dbAvailable, loadChunks } from './loader.js';

const SENTENCE_CASES = 215_500;   // 全量真实句子（归档 270 份实测 215,047 句）

const fromChunks = dbAvailable
  ? loadChunks(20_500, 1).flatMap(row => row.content.split(/[。；;\n]/u).map(text => text.trim()))
  : [];
const fromDocs = archivedDocumentPaths()
  .flatMap(file => readFileSync(file, 'utf8').split(/[。；;\n]/u).map(text => text.trim()));
const sentences = [...fromChunks, ...fromDocs].filter(text => text.length >= 12 && /\d/u.test(text)).slice(0, SENTENCE_CASES);

describe.skipIf(sentences.length < 1000)('4.61 句子级真实语料矩阵（≥100,000 用例）', () => {
  it('句子取样规模（空集会令下方全部用例空过）', () => {
    expect(sentences.length).toBeGreaterThan(180_000);
  });

  it.each(sentences.map((text, index) => [index, text] as const))(
    '句 #%i：约束解析产出的事实满足形态不变式',
    (_index, text) => {
      for (const item of parseClauseFacts(text)) {
        expect(item.value.length, `值不得为空：${text.slice(0, 30)}`).toBeGreaterThan(0);
        expect(
          Number.isFinite(Number(item.value)) || /^[A-Za-z]/.test(item.value) || item.value.includes('~'),
          `值应为数值/牌号/区间，实得「${item.value}」（句：${text.slice(0, 40)}）`,
        ).toBe(true);
        expect(['=', '>=', '<=', 'range', 'enum', 'text']).toContain(item.relation);
        expect(item.attribute.length).toBeGreaterThan(0);
      }
    },
  );
});
