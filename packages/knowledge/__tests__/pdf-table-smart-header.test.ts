/**
 * G 线 P2-9：PDF 表格接入智能表头检测。
 *
 * 缺陷背景：PDF 表格路径 `rowsToPdfMarkdownWithTables` 无条件把 `tableRows[0]` 当表头，
 * 而 xlsx / CSV / DOCX 三条路径都已接入 `detectSmartTableHeader`。PDF 表格前常有标题行
 * （「表3-1  主要材料表」，宽间距会被 `splitLikelyTableRow` 切成两列而**并入表格**），
 * 于是标题行被当表头、真实列名全部丢失，下游按列位的行级提取与「R#C# 列名: 值」KV 全体错位
 * ——与 xlsx 路径当初的实锤（「合肥师范清单 xls」）同形。
 *
 * 私有方法在编译产物中仍是普通方法，此处按本仓既有先例（pdf-sheet-page-ocr.test.ts）
 * 显式取用，以便对判定逻辑做单元级回归。
 */
import { describe, it, expect } from 'vitest';
import { ContentExtractor } from '../src/extraction/content-extractor.js';

const extractor = new ContentExtractor();
const renderPdfTable = (rows: Array<{ text: string; height: number }>): string =>
  (extractor as unknown as {
    rowsToPdfMarkdownWithTables: (r: Array<{ text: string; height: number }>) => string;
  }).rowsToPdfMarkdownWithTables(rows);

const row = (text: string) => ({ text, height: 12 });

/** 标题行（宽间距→被切成两列并入表格）+ 真表头 + 两条数据行 */
const tableWithTitleRow = [
  row('表3-1  主要材料表'),
  row('序号  项目名称  计量单位  工程量'),
  row('1  钢筋  t  120.5'),
  row('2  混凝土  m3  860'),
];

describe('G 线 P2-9 PDF 表格智能表头检测', () => {
  it('标题行不冒充表头：真表头行被定位为表头（对照：朴素取 rows[0] 会错）', () => {
    const out = renderPdfTable(tableWithTitleRow);
    // 对照：证明缺陷真实存在——朴素行为下 rows[0] 是标题行而非表头
    expect(tableWithTitleRow[0]!.text).toContain('主要材料表');
    expect(tableWithTitleRow[0]!.text).not.toContain('项目名称');
    // 修复后：Markdown 表头行必须是真表头，而非标题行
    const lines = out.split('\n');
    const headerLine = lines.find(line => line.startsWith('|') && line.includes('项目名称'));
    expect(headerLine).toBeDefined();
    expect(headerLine).toContain('序号');
    expect(headerLine).toContain('计量单位');
    // 标题行不得作为列名出现
    expect(headerLine).not.toContain('主要材料表');
  });

  it('数据行完整保留（标题行降级为表标题注记，不吞掉任何数据行）', () => {
    const out = renderPdfTable(tableWithTitleRow);
    expect(out).toContain('钢筋');
    expect(out).toContain('混凝土');
    expect(out).toContain('120.5');
    expect(out).toContain('860');
    // 标题行以表标题注记形式保留（信息不丢）
    expect(out).toContain('表标题');
    expect(out).toContain('主要材料表');
  });

  it('无列关键词表格回退 rows[0]，保持历史行为不变', () => {
    const rows = [row('甲  乙  丙'), row('1  2  3'), row('4  5  6')];
    const out = renderPdfTable(rows);
    const headerLine = out.split('\n').find(line => line.startsWith('|'));
    expect(headerLine).toContain('甲');
    expect(headerLine).toContain('乙');
    expect(headerLine).toContain('丙');
    // 回退路径不应产生表标题注记（无标题行可降级）
    expect(out).not.toContain('表标题');
  });

  it('单列行截断表格运行：不把后续正文误并进表格', () => {
    const rows = [
      row('序号  项目名称'),
      row('1  钢筋'),
      row('此处为单列正文行（无分隔）'),
      row('2  混凝土'),
    ];
    const out = renderPdfTable(rows);
    // 单列行打断表格：它是普通正文行，不得成为表头或数据行
    const tableLines = out.split('\n').filter(line => line.startsWith('|'));
    expect(tableLines.join('\n')).not.toContain('单列正文行');
    expect(out).toContain('单列正文行');
  });
});
