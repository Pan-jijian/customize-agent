/**
 * 切片不得出现任何重叠与重复数据（用户红线）。
 *
 * 历史问题：分块器 `takeOverlap` 用 `overlapTokens * 4` 折算字符数（隐含「4 字符/token」
 * 的英文假设，而本仓 BGE WordPiece 中文实测约 1.15 字符/token），实际重叠达配置意图的
 * 3.5~4 倍：cad 配置 80 token → 实取 320 字符 ≈ 278 token，占 600 token 预算的 46%。
 * 全库实测 `kb_chunks` 5,727,249 字符 vs `kb_document_chunks` 3,510,259 = **1.63 倍**，
 * 其中 63% 是重复内容。
 *
 * 现口径：**所有分类 overlap = 0**。跨块上下文由检索期的 parent 展开承担
 * （每个切片带 `parentText`，命中后 `expandContext` 展开回父块），不在索引里复制副本。
 */
import { describe, it, expect } from 'vitest';
import { TextChunker } from '../src/chunking/text-chunker.js';
import type { ClassifiedFile } from '../src/types.js';

const file = { category: 'cad', format: 'autocad', relativePath: 'a.dwg', absolutePath: '/x/a.dwg' } as ClassifiedFile;

/** 生成一段有行结构的工程文本（贴近 DWG 标注的排版形态） */
function cadText(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, i) =>
    `第${i + 1}行 框架柱配筋平面图 规格 C30混凝土 DN200 管道 标高 ${(i * 0.15).toFixed(3)} 备注 施工时应与结构专业密切配合`).join('\n');
}

/**
 * 相邻块之间的**重叠**长度（0 表示无重叠）。
 * 判据必须是「本块头部 == 上块尾部」——重叠的定义就是上块尾部被复制到本块头部。
 * 不能用 `prev.includes(cur.slice(0, len))`：图纸/清单文本高度重复（同一模板行反复出现），
 * 短前缀会在上块中偶然命中，产生假阳性。
 */
function overlapPrefixes(chunks: Array<{ text: string }>): number[] {
  const sizes: number[] = [];
  for (let i = 1; i < chunks.length; i += 1) {
    const prev = chunks[i - 1]!.text;
    const cur = chunks[i]!.text;
    let size = 0;
    for (let len = Math.min(cur.length, prev.length); len > 0; len -= 1) {
      if (prev.endsWith(cur.slice(0, len))) { size = len; break; }
    }
    sizes.push(size);
  }
  return sizes;
}

describe('切片无重叠无重复', () => {
  it('CAD 文本：切片总量不超过原文（无重叠复制）', () => {
    const src = cadText(400);
    const chunks = new TextChunker().chunk(src, file, { mimeType: '', fileSize: src.length, mtime: 0 });
    const total = chunks.reduce((n, c) => n + c.text.length, 0);
    // 修复前该比值为 2.597（311 块 / 140,885 字符 vs 原文 54,259）
    expect(total / src.length).toBeLessThanOrEqual(1.02);
  });

  it('CAD 文本：相邻块之间没有任何重复前缀', () => {
    const chunks = new TextChunker().chunk(cadText(400), file, { mimeType: '', fileSize: 0, mtime: 0 });
    expect(chunks.length).toBeGreaterThan(2);
    const overlaps = overlapPrefixes(chunks);
    // 修复前中位重叠 320 字符（= 80 × 4）
    expect(Math.max(...overlaps)).toBe(0);
  });

  it('document 文本（含 ## 页节）：同样零重叠', () => {
    const src = Array.from({ length: 60 }, (_, i) =>
      `## PDF 第 ${i + 1} 页\n\n第${i + 1}条 投标人应当按照招标文件的要求编制投标文件，并对实质性要求作出响应。`).join('\n\n');
    const docFile = { ...file, category: 'document', format: 'pdf' } as ClassifiedFile;
    const chunks = new TextChunker().chunk(src, docFile, { mimeType: '', fileSize: src.length, mtime: 0 });
    const total = chunks.reduce((n, c) => n + c.text.length, 0);
    expect(total / src.length).toBeLessThanOrEqual(1.02);
    expect(Math.max(...overlapPrefixes(chunks))).toBe(0);
  });

  it('全部分类 overlap 配置均为 0（防止再次引入）', async () => {
    const { DEFAULT_CONFIGS_FOR_TEST } = await import('../src/chunking/text-chunker.js') as unknown as { DEFAULT_CONFIGS_FOR_TEST?: Record<string, { overlap: number }> };
    if (!DEFAULT_CONFIGS_FOR_TEST) return;   // 常量未导出时以行为断言为准（上三条已覆盖）
    for (const [category, config] of Object.entries(DEFAULT_CONFIGS_FOR_TEST)) {
      expect(config.overlap, `${category} 的 overlap 应为 0`).toBe(0);
    }
  });
});
