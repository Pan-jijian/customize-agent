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

  it('大段表格 KV 声明行按行边界拆分，行结构不被拆碎（多 sheet 清单场景）', () => {
    // 实清单场景（丰乐镇）：91 个 sheet 的「R#C# 列名: 值」行级参数行连续排列，
    // 超过 maxChunkSize(1000) 后曾降级到 /\s+/ 分隔符，被拆成 "R151C4"/"项目名称:" 碎片，
    // 导致向量检索无法按列名召回参数。修复后应优先按 KV 行边界拆分。
    const columns = ['序号', '项目编码', '项目名称', '计量单位'];
    const values = ['1', '040101001001', '挖一般土方', 'm3'];
    const kvRows = Array.from({ length: 400 }, (_, i) => `R${Math.floor(i / 4) + 2}C${(i % 4) + 1} ${columns[i % 4]}: ${values[i % 4]}`);
    const text = `# 清单数据\n${kvRows.join('\n')}`;
    const chunks = chunker.chunk(text, makeFile('spreadsheet', 'xlsx', '清单.xlsx'));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // 不允许 "R5C2\n项目名称:" 形态：R#C# 与列名被换行拆开（KV 结构破坏）
      expect(chunk.text).not.toMatch(/R\d+C\d+\n/u);
    }
    // 首行、中段、末段 KV 行必须完整保留在某个 chunk 中
    for (const probe of [kvRows[0], kvRows[1], kvRows[200], kvRows[399]]) {
      expect(chunks.some(chunk => chunk.text.includes(probe!))).toBe(true);
    }
  });

  it('chunk 重叠块以完整行开始（overlap 切点对齐行边界，不产生行首残缺）', () => {
    // 场景：大量 KV 行连续（触发多 chunk + overlap），字符级 overlap 切分曾产生
    // 「238C13 COL13: 」行首残缺（丰乐镇清单实锤：行首 R 被切掉）
    const kvRows = Array.from({ length: 400 }, (_, i) => `R${Math.floor(i / 6) + 2}C${(i % 6) + 1} 项目特征描述: 特征描述内容${i}，含说明文字。`);
    const text = `# 清单\n${kvRows.join('\n')}`;
    const chunks = chunker.chunk(text, makeFile('spreadsheet', 'xlsx', '清单.xlsx'));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      for (const line of chunk.text.split('\n')) {
        // 不允许「数字C数字 …」形态的残缺行首——完整的 KV 行必须从 R#C# 开始
        expect(line).not.toMatch(/^\d+C\d+\s/u);
      }
    }
  });

  it('无数据行的表格块（表头行+分隔行两行结构）整块保留，内容不丢失', () => {
    // 场景：docx 单行表格（唯一数据行被表头检测回退当作表头）的提取产物为
    // 「表头行+分隔行」两行块；splitMarkdownTable 曾因 rows 为空返回空数组，
    // 整块内容（含超长条文单元格与审查结论）从 chunks 中消失（20250920 审查要点 docx 实锤）。
    const longCell = '5.2.10 优化建筑空间和平面布局，改善自然通风效果，评价总分值为 8分，并按下列规则评分：1 住宅建筑：通风开口面积与房间地板面积的比例在夏热冬暖地区达到 12%，得5分。';
    const text = [
      '表5.R4C6 符合□ / 不符合□: 符合□ / 不符合□',
      '',
      'DOCX 表格 6',
      `| COL1 | ${longCell} | 8 | 0 | COL5 | 符合□ / 不符合□ |`,
      '| --- | --- | --- | --- | --- | --- |',
      '',
      'DOCX 表格 7',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    const chunks = chunker.chunk(text, makeFile('document', 'markdown', 'n.docx'));
    const joined = chunks.map(chunk => chunk.text).join('\n');
    expect(joined).toContain('5.2.10 优化建筑空间');
    expect(joined).toContain('符合□ / 不符合□');
    expect(joined).toContain('| a | b |');
  });
});
