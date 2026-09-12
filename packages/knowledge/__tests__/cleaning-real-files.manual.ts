/**
 * 真实文件离线验证（manual 脚本，不参与常规测试）：
 * 丰乐镇招标文件 / 施工图 PDF / 舒城招标文件 跑「pdfjs 文本层提取 → 入库前清洗」链路，
 * 验证 F1/F2 修复效果。运行：npx vitest run packages/knowledge/__tests__/cleaning-real-files.manual.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { cleanExtractedText } from '../src/cleaning/text-cleaner.js';

const ROOT = '/Users/pan/.customize-agent/projects/3c3f04667c69/knowledgeBase';
const TENDER_PDF = `${ROOT}/9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/2026年度丰乐镇20个美丽宜居自然村建设项目招标文件.pdf`;
const DRAWING_PDF = `${ROOT}/9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/1、图纸/2026年度丰乐镇20个美丽宜居自然村建设项目施工图08.17(1).pdf`;
const SHUCHENG_PDF = `${ROOT}/舒城/招标文件.pdf`;

interface PdfItem { str: string; x: number; y: number; width: number; height: number }

/** pdfjs 文本层提取 + 行布局（复刻 ContentExtractor 的 groupPdfItemsIntoRows/joinPdfRowText 核心，输出 ## PDF 第 N 页 页面标记） */
async function extractPdfText(filePath: string): Promise<string> {
  const data = new Uint8Array(readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    // normalizeWhitespace/disableCombineTextItems 与 ContentExtractor 一致（pdfjs 类型定义未暴露该参数）
    const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: true } as any);
    const items: PdfItem[] = (content.items as Array<Record<string, unknown>>)
      .map(item => ({
        str: String(item.str ?? ''),
        x: Number((item.transform as number[])?.[4] ?? 0),
        y: Number((item.transform as number[])?.[5] ?? 0),
        width: Number(item.width ?? 0),
        height: Number(item.height ?? Math.abs(Number((item.transform as number[])?.[3] ?? 0))),
      }))
      .filter(item => item.str.trim().length > 0);
    // 行聚类：y 差 ≤ max(2, height*0.55) 归同一行
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: PdfItem[][] = [];
    for (const item of sorted) {
      const row = rows.find(candidate => Math.abs(candidate[0]!.y - item.y) <= Math.max(2, item.height * 0.55));
      if (row) row.push(item);
      else rows.push([item]);
    }
    const lines = rows.map(row => {
      const byX = [...row].sort((a, b) => a.x - b.x);
      let output = '';
      let prev: PdfItem | undefined;
      for (const item of byX) {
        if (prev) {
          const gap = item.x - (prev.x + prev.width);
          output += gap > Math.max(3, prev.height * 0.35) ? ` ${item.str.trim()}` : item.str.trim();
        } else {
          output += item.str.trim();
        }
        prev = item;
      }
      return output.replace(/\s+/gu, ' ').trim();
    }).filter(Boolean);
    pages.push(`## PDF 第 ${i} 页\n\n${lines.join('\n')}`);
  }
  await doc.destroy();
  return pages.join('\n\n');
}

describe('真实文件清洗链路验证（manual）', () => {
  it('丰乐镇招标文件：第七章技术标准保留（商品砼/预拌砂浆/另册），通用条款误删消失', async () => {
    const extracted = await extractPdfText(TENDER_PDF);
    const result = cleanExtractedText({ text: extracted, category: 'document', format: 'pdf', fileName: '2026年度丰乐镇20个美丽宜居自然村建设项目招标文件.pdf' });
    console.log('[tender] 提取字符:', extracted.length, '| 清洗后字符:', result.text.trim().length,
      '| 剩余占比:', (result.text.trim().length / extracted.trim().length * 100).toFixed(1) + '%');
    console.log('[tender] stats:', JSON.stringify({ ...result.stats, sectionDrops: result.stats }), null, 0);
    console.log('[tender] contractGeneralClauseLines:', result.stats.contractGeneralClauseLines);
    // 修复前：contractGeneralClauseLines=3812（5 个误触发点吞约 48 页），商品砼/预拌砂浆/另册 0 次命中
    expect(result.stats.contractGeneralClauseLines).toBeLessThan(100);
    expect(result.text).toContain('商品砼');
    expect(result.text).toContain('预拌砂浆');
    expect(result.text).toContain('另册');
    // 剩余占比不低于 70%（修复前丢约 37%）
    expect(result.text.trim().length / extracted.trim().length).toBeGreaterThan(0.7);
  }, 120_000);

  it('丰乐镇施工图 PDF：标高/井编号/管径数据保留且不再按页眉页脚误删（图纸内容分流）', async () => {
    const extracted = await extractPdfText(DRAWING_PDF);
    const result = cleanExtractedText({ text: extracted, category: 'document', format: 'pdf', fileName: '2026年度丰乐镇20个美丽宜居自然村建设项目施工图08.17(1).pdf' });
    console.log('[drawing] 提取字符:', extracted.length, '| 清洗后字符:', result.text.trim().length,
      '| cadNoiseLines:', result.stats.cadNoiseLines, '| headerFooterLines:', result.stats.headerFooterLines);
    // 修复前：标高离散短行（检查井标高/井编号/管径，非逗号坐标对）判为普通 document，
    // 高重复标注 4952 行被页眉页脚规则误删；修复后按短碎片行占比判为图纸内容豁免误删
    expect(result.stats.headerFooterLines).toBeLessThan(1000);
    // 标高/井编号/管径等有效标注数据保留
    expect(result.text).toContain('DN');
    expect(result.text).toContain('W-4');
    // 剩余占比显著高于修复前 76.6%（标高数据不再误删）
    expect(result.text.trim().length / extracted.trim().length).toBeGreaterThan(0.8);
  }, 180_000);

  it('舒城招标文件回归：关键内容保留', async () => {
    const extracted = await extractPdfText(SHUCHENG_PDF);
    const result = cleanExtractedText({ text: extracted, category: 'document', format: 'pdf', fileName: '招标文件.pdf' });
    console.log('[shucheng] 提取字符:', extracted.length, '| 清洗后字符:', result.text.trim().length,
      '| contractGeneralClauseLines:', result.stats.contractGeneralClauseLines);
    // 前附表 3.7.1 重点难点/危大/BIM 等关键内容保持召回（修复前已验证正常，防回归）
    expect(result.text).toContain('重点难点');
    expect(result.text).toContain('BIM');
  }, 120_000);
});
