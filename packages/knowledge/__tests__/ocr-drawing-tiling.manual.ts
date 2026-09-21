/**
 * 真实文件验证：大幅面图纸的切片 OCR 与普通文字页的回归。
 *
 * 运行（不进常规门禁）：
 *   npx vitest run --config vitest.manual.config.ts packages/knowledge/__tests__/ocr-drawing-tiling.manual.ts
 *
 * 依赖本机真实项目资料；文件不存在时自动跳过（CI 上不会失败）。
 * 路径可用环境变量覆盖：
 *   CUSTOMIZE_KB_TEST_DRAWING_PDF  大幅面图纸 PDF
 *   CUSTOMIZE_KB_TEST_TEXT_PDF     普通文字页 PDF（验证不触发切片）
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { ContentExtractor } from '../src/extraction/content-extractor.js';
import { FileClassifier } from '../src/classification/classifier.js';
import { cleanExtractedText } from '../src/cleaning/text-cleaner.js';
import { TextChunker } from '../src/chunking/text-chunker.js';
import { mergeChunksToReadableText } from '../../../apps/server/src/services/knowledge/kbExportService.js';

const DEFAULT_KB = '/Users/pan/.customize-agent/projects/3c3f04667c69/knowledgeBase';
const DRAWING_PDF = process.env.CUSTOMIZE_KB_TEST_DRAWING_PDF
  ?? `${DEFAULT_KB}/舒城(2)/图纸/01公共广场空间改造——全套施工图纸PDF/01公共广场空间改造——全套施工图纸PDF/02建筑/4.5综合配套用房/4.5产业园停车场提升改造工程--综合配套用房-建筑-10-一层平面图-A2.pdf`;
const TEXT_PDF = process.env.CUSTOMIZE_KB_TEST_TEXT_PDF
  ?? `${DEFAULT_KB}/9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/2026年度丰乐镇20个美丽宜居自然村建设项目招标文件.pdf`;

const classifier = new FileClassifier();

async function extract(filePath: string) {
  const relativePath = filePath.split('/').slice(-1)[0]!;
  const file = classifier.classify(filePath, relativePath, fs.statSync(filePath));
  const extractor = new ContentExtractor();
  const started = Date.now();
  const result = await extractor.extract(file);
  return { result, elapsedMs: Date.now() - started };
}

describe('大幅面图纸切片 OCR', () => {
  const skip = !fs.existsSync(DRAWING_PDF);
  it.skipIf(skip)('A2 图纸走切片识别并恢复图纸标注', async () => {
    const { result, elapsedMs } = await extract(DRAWING_PDF);
    const strategy = JSON.stringify(result.metadata.ocrStrategies ?? []);
    console.log(`[图纸] ${elapsedMs}ms textLength=${result.text.length} tiled=${JSON.stringify(result.metadata.pdfOcrTiledPages)} tiles=${JSON.stringify(result.metadata.pdfOcrTileCounts)}`);
    console.log(`[图纸] strategy=${strategy}`);
    console.log(`[图纸] warnings=${JSON.stringify(result.warnings)}`);

    // 大幅面页应触发切片
    expect(result.metadata.pdfOcrTiledPages).toEqual([1]);
    // 修复前该页只有 514 字符（图签栏 + 资质章），切片后应显著提升
    expect(result.text.length).toBeGreaterThan(1500);
    // 修复前完全缺失的图纸本体标注
    for (const term of ['配电间', '储藏室', '门厅', 'M1624', '防烟分区']) {
      expect(result.text, `应恢复图纸标注「${term}」`).toContain(term);
    }
  }, 900_000);
});

describe('导出链路（用户可见结果）', () => {
  const skip = !fs.existsSync(DRAWING_PDF);
  it.skipIf(skip)('图纸导出的 txt 含图纸本体数据而不是只有图签栏', async () => {
    // 与「文件管理 → 选中文件夹 → 导出 txt」同一条链路：解析 → 入库清洗 → 分块 → 合并导出
    const { result } = await extract(DRAWING_PDF);
    const cleaned = cleanExtractedText({
      text: result.text, category: 'document', format: 'pdf', fileName: DRAWING_PDF.split('/').slice(-1)[0]!,
    });
    const chunks = new TextChunker().chunk(cleaned.text, classifier.classify(DRAWING_PDF, 'drawing.pdf', fs.statSync(DRAWING_PDF)), result.metadata);
    const exported = mergeChunksToReadableText(chunks.map(chunk => ({ content: chunk.text })));
    console.log(`[导出] txt 字符数=${exported.length} 分块数=${chunks.length}`);

    // 修复前这张图导出的 txt 只有 514 字符，且内容全是图签栏/资质章
    expect(exported.length).toBeGreaterThan(1500);
    expect(exported).toContain('配电间');
    expect(exported).not.toContain('中华人民共和国一级注册建筑师工程设计甲级证书编号:A134A00302 专业负责人\n'); // 图签栏不再是全部内容
  }, 900_000);
});

describe('Office 内嵌图片 OCR（此前整体丢弃）', () => {
  const OFFICE_DOC = process.env.CUSTOMIZE_KB_TEST_OFFICE_DOC
    ?? `${DEFAULT_KB}/9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/3、补疑/2026年度丰乐镇20个美丽宜居自然村建设项目.docx`;
  const skip = !fs.existsSync(OFFICE_DOC);

  it.skipIf(skip)('含整页施工图的 docx 恢复出图纸文字', async () => {
    const { result, elapsedMs } = await extract(OFFICE_DOC);
    console.log(`[Word] ${elapsedMs}ms textLength=${result.text.length} 内嵌图片=${String(result.metadata.officeEmbeddedImageCount)} 识别出文字=${String(result.metadata.officeEmbeddedImagesOcr)}`);
    console.log(`[Word] warnings=${JSON.stringify(result.warnings)}`);

    expect(Number(result.metadata.officeEmbeddedImageCount)).toBeGreaterThan(0);
    expect(result.text).toContain('内嵌图片 1（OCR）');
    // 修复前这些图纸术语在知识库里完全不存在（正文只有 1920 字，图片内容全丢）。
    // 断言用 OCR 实际能稳定识别的术语，不按人眼读图结果写
    for (const term of ['植筋', '压实度', '级配碎石', '抗折强度', '混凝土']) {
      expect(result.text, `应恢复图纸中的「${term}」`).toContain(term);
    }
  }, 900_000);
});

describe('普通文字页回归（不应触发切片）', () => {
  const skip = !fs.existsSync(TEXT_PDF);
  it.skipIf(skip)('A4 文字页保持原路径且不切片', async () => {
    const { result, elapsedMs } = await extract(TEXT_PDF);
    console.log(`[文字页] ${elapsedMs}ms textLength=${result.text.length} tiled=${JSON.stringify(result.metadata.pdfOcrTiledPages)}`);
    expect(result.metadata.pdfOcrTiledPages).toBeUndefined();
    expect(result.text.trim().length).toBeGreaterThan(0);
  }, 900_000);
});
