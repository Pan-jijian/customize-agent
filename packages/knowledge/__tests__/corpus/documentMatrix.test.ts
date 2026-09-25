/**
 * 文档级真实语料矩阵（目标 **≥100,000 用例**）。
 *
 * 数据源：270 份**真实产出归档文档**（`generatedDocuments/assets/*.md`）的 31,215 个段落，
 * 每段 4 条用例（31,215 × 4 = 124,860）。
 *
 * ## 断言的是「能力」而不是「历史文档无缺陷」
 *
 * 首版把不变式直接断言在归档段落上（"每段括号必成对"），结果 257 条失败——因为**归档里本来
 * 就有带缺陷的历史产物**（括号不闭合、书名号自吞噬等，正是它们被归档研究的原因）。
 * 拿历史缺陷当测试失败，是把"数据里有缺陷"误报成"系统坏了"。
 *
 * 正确的框架是**让每条真实段落过一遍确定性修复链，断言修复器的性质**：
 * ① 幂等（重放安全——链尾会重放，不幂等会反复改写）
 * ② 单调（不得使结构成对性变差——修复器把好文本改坏是比不修更严重的事故）
 * ③ 不引入新缺陷（连续标点）
 * ④ 不丢内容（汉字数不减——删除式"修复"会静默吃掉正文）
 *
 * 这四条对**任意输入**都成立，因此既能在真实语料上跑满，又能在修复器退化时真的失败。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixTruncatedStandardCitations } from '../../../../apps/server/src/services/document-workflow/integrity/fixers/fixers.js';
import { archivedDocumentPaths } from './loader.js';

const files = archivedDocumentPaths();
const paragraphs = files.flatMap(file => {
  const markdown = readFileSync(file, 'utf8');
  return markdown.split(/\n{2,}/u).map(block => block.trim()).filter(block => block.length >= 30).map(block => ({ file, block }));
});
const available = paragraphs.length > 1000;

/** 成对性偏差：|开 - 闭|，0 为完全成对 */
const pairDeviation = (text: string, open: string, close: string) =>
  Math.abs(text.split(open).length - text.split(close).length);
const hanCount = (text: string) => (text.match(/[一-龥]/gu) || []).length;

describe.skipIf(!available)('4.61 文档级真实语料矩阵 · 确定性修复器性质（≥100,000 用例）', () => {
  it('段落取样规模（空集会令下方全部用例空过）', () => {
    expect(paragraphs.length).toBeGreaterThan(10_000);
  });

  it.each(paragraphs.map((item, index) => [index, item] as const))('段落 #%i：修复幂等（链尾重放安全）', (_i, item) => {
    const once = fixTruncatedStandardCitations(item.block).markdown;
    expect(fixTruncatedStandardCitations(once).markdown).toBe(once);
  });

  it.each(paragraphs.map((item, index) => [index, item] as const))('段落 #%i：书名号成对性不得变差（单调性）', (_i, item) => {
    const fixed = fixTruncatedStandardCitations(item.block).markdown;
    expect(pairDeviation(fixed, '《', '》')).toBeLessThanOrEqual(pairDeviation(item.block, '《', '》'));
  });

  it.each(paragraphs.map((item, index) => [index, item] as const))('段落 #%i：不得引入连续标点（新增缺陷）', (_i, item) => {
    const fixed = fixTruncatedStandardCitations(item.block).markdown;
    if (/[。；，、]{2,}/u.test(item.block)) return; // 原文本已有：非本修复器引入
    expect(fixed).not.toMatch(/[。；，、]{2,}/u);
  });

  it.each(paragraphs.map((item, index) => [index, item] as const))('段落 #%i：不得丢内容（汉字数不减）', (_i, item) => {
    const fixed = fixTruncatedStandardCitations(item.block).markdown;
    expect(hanCount(fixed), '汉字数减少＝删除了正文').toBeGreaterThanOrEqual(hanCount(item.block));
  });

  // ── 以下四条为第 5~8 组性质（各测一个独立属性） ──

  it.each(paragraphs.map((item, index) => [index, item] as const))('段落 #%i：修复只做插入（原文是修复结果的子序列＝无删除/无改写/无重排）', (_i, item) => {
    const fixed = fixTruncatedStandardCitations(item.block).markdown;
    // 子序列判定是"只插入"的精确形式：顺序保持 + 一个字符都没丢。
    // 首版写成「两边都删掉 `》（` 后应相等」——9 条失败：原文本身可能就含 `》（`（合法序列），
    // 两边同删并不等于"只插入"，这个断言从一开始就不成立。
    let cursor = 0;
    for (const char of fixed) {
      if (char === item.block[cursor]) cursor += 1;
      if (cursor === item.block.length) break;
    }
    expect(cursor, `原文未完整出现在修复结果中（删改或重排）：${item.block.slice(0, 40)}`).toBe(item.block.length);
  });

  it.each(paragraphs.map((item, index) => [index, item] as const))('段落 #%i：修复计数与明细条数一致（不虚报修复数）', (_i, item) => {
    const result = fixTruncatedStandardCitations(item.block);
    if (result.fixedCount > 0) expect(result.details.length).toBeGreaterThanOrEqual(result.fixedCount);
  });

  it.each(paragraphs.map((item, index) => [index, item] as const))('段落 #%i：括号成对性不得变差（与书名号同源的单调性）', (_i, item) => {
    const fixed = fixTruncatedStandardCitations(item.block).markdown;
    expect(pairDeviation(fixed, '（', '）')).toBeLessThanOrEqual(pairDeviation(item.block, '（', '）'));
  });

  it.each(paragraphs.map((item, index) => [index, item] as const))('段落 #%i：修复后长度不减且增幅有界（防插入失控）', (_i, item) => {
    const fixed = fixTruncatedStandardCitations(item.block).markdown;
    expect(fixed.length).toBeGreaterThanOrEqual(item.block.length);
    // 每次插入 2 字符；增幅上限 = 段落长度 + 命中数×2，这里用宽松上界防"无限膨胀"
    expect(fixed.length).toBeLessThanOrEqual(item.block.length + item.block.length);
  });
});
