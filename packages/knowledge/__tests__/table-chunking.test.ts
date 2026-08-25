import { describe, expect, it } from 'vitest';
import { TextChunker } from '../src/chunking/text-chunker.js';
import type { ClassifiedFile } from '../src/types.js';

function makeFile(category: ClassifiedFile['category'], format: string, relativePath: string): ClassifiedFile {
  return {
    category,
    format,
    fileSize: 1024,
    mtime: Date.now(),
    mimeType: 'text/plain',
    absolutePath: `/tmp/${relativePath}`,
    relativePath,
  };
}

describe('TextChunker 表格行原子拆分', () => {
  const chunker = new TextChunker();

  function buildTable(rows: number, cellWidth: number): string {
    const header = `| 序号 | 项目特征 ${'x'.repeat(cellWidth)} | 规格型号 ${'y'.repeat(cellWidth)} | 数量 | 单位 |`;
    const separator = `| --- | ${'-'.repeat(cellWidth)} | ${'-'.repeat(cellWidth)} | --- | --- |`;
    const dataRows = Array.from({ length: rows }, (_, i) => `| ${i + 1} | 特征内容${'甲'.repeat(cellWidth)}${i} | 型号${'乙'.repeat(cellWidth)}${i} | ${i * 10 + 5} | 台 |`);
    return [header, separator, ...dataRows].join('\n');
  }

  it('超预算表格按行边界拆分，每个数据行完整落在单一 chunk 内', () => {
    const table = buildTable(60, 40);
    const chunks = chunker.chunk(table, makeFile('spreadsheet', 'csv', 'test-table.csv'));
    expect(chunks.length).toBeGreaterThan(1);
    const tableChunks = chunks.filter(chunk => chunk.metadata.chunkKind === 'table');
    expect(tableChunks.length).toBeGreaterThan(0);
    for (const chunk of tableChunks) {
      // chunk 首部带来源标注行（资料类型: ...），表头紧随其后
      const tableLines = chunk.text.split('\n').filter(line => line.startsWith('|'));
      // 每个表格 chunk 必须包含表头行与分隔行（数据行不丢失字段上下文）
      expect(tableLines[0]).toContain('| 序号 |');
      expect(tableLines.some(line => /^\|?\s*:?-{3,}/u.test(line))).toBe(true);
      // 数据行完整：所有 | 开头行首尾都闭合，不允许被窗口硬切
      for (const line of tableLines) {
        expect(line.trimEnd().endsWith('|')).toBe(true);
      }
    }
    // 全部 60 个数据行合计不丢失
    for (let i = 1; i <= 60; i += 1) {
      const rowPrefix = `| ${i} |`;
      expect(tableChunks.some(chunk => chunk.text.split('\n').some(line => line.startsWith(rowPrefix)))).toBe(true);
    }
  });

  it('单行超预算也保持行完整，不窗口硬切', () => {
    const wideCell = '数'.repeat(900);
    const table = [
      '| 项目特征 | 规格型号 |',
      '| --- | --- |',
      `| ${wideCell} | ${wideCell} |`,
    ].join('\n');
    const chunks = chunker.chunk(table, makeFile('spreadsheet', 'csv', 'test-wide.csv'));
    const tableChunks = chunks.filter(chunk => chunk.metadata.chunkKind === 'table');
    expect(tableChunks.length).toBeGreaterThan(0);
    for (const chunk of tableChunks) {
      const lines = chunk.text.split('\n').filter(line => line.startsWith('|'));
      for (const line of lines) expect(line.trimEnd().endsWith('|')).toBe(true);
    }
    // 完整长单元格内容不丢失
    const joined = tableChunks.map(chunk => chunk.text).join('\n');
    expect(joined).toContain(wideCell);
  });

  it('普通文档文本不受行原子拆分影响', () => {
    const text = `# 章节\n${'正文内容。'.repeat(600)}`;
    const chunks = chunker.chunk(text, makeFile('document', 'markdown', 'test-doc.md'));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map(chunk => chunk.text).join('')).toContain('正文内容');
  });
});
