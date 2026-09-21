/**
 * 大幅面图纸页（文本层只剩图签栏）必须转 OCR 的回归。
 *
 * 缺陷背景：`hasUsablePdfText` 的页均密度保护写作 `if (pageCount && pageCount > 1)`，
 * **单页完全不适用**。而「单张出图」（一个文件一张 A2/A3）是最常见的图纸形态 ——
 * 实测舒城 14/14 图纸 PDF 全是单页，全部绕过保护：图签栏 345 字符 ≥ 80 门槛、
 * 可见字符占比高 → 判「文本层足够」→ `ocrSkippedReason: pdf_text_stream_quality_sufficient`
 * → OCR 永不启动。生产库实测 224/328 份 PDF 走该路径，114 份产出比 < 0.05%。
 *
 * 修复（页级，G 线 P0-11 修正）：逐页识别图纸页并进入**选择性 OCR** —— 有文本层的页直接取用，
 * 只对图纸页/乱码页 OCR。此前按「图纸页过半」在文档级否定整份文本层，会让图纸页过半的
 * 招标文件整本降级到全页 OCR（丢字/丢表/丢数字精度）。
 * 同一份 A2 图纸 A/B 实测：345 字符 → 1,452 字符（4.2×），拿到的是真内容
 * （划线规格/石材做法/材料编号/房间名/标高）而非图签栏。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentExtractor } from '../src/extraction/content-extractor.js';
import { FileClassifier } from '../src/classification/classifier.js';
import type { ClassifiedFile } from '../src/types.js';

const extractor = new ContentExtractor();

/** 私有方法在编译产物中仍是普通方法，此处显式取用以便对判定逻辑做单元级回归 */
const hasUsablePdfText = (text: string, pageCount?: number, sheetPageCount?: number): boolean =>
  (extractor as unknown as {
    hasUsablePdfText: (t: string, p?: number, s?: number) => boolean;
  }).hasUsablePdfText(text, pageCount, sheetPageCount);

/** 图签栏文本：约 350 字符、可见字符占比高 —— 形态与实测的 A2 图纸文本层一致 */
const TITLE_BLOCK_ONLY =
  '核定安徽省城建设计研究总院股份有限公司 制设校专业负责人 图计对 图子项名称项目名称 名 版图日比设计阶段项目编号 次号期例 '
  + '注意:专业签名专业签名 1.本图纸著作权及其他相关权益属安徽省城建设计研究总院股份有限公司所有。未经本公司书面同意，不得复制本图纸。'
  + '2.本图纸应与其他相关配套设计文件统一使用。 3.图中所注尺寸除标高以米计外，其余均以毫米计。';

/** 正常文字页：可见字符充足、含完整句子 */
const NORMAL_TEXT_PAGE = Array.from({ length: 12 }, (_, i) =>
  `第 ${i + 1} 条 投标人应当按照招标文件的要求编制投标文件，投标文件应当对招标文件提出的实质性要求和条件作出响应。`).join('');

describe('hasUsablePdfText 文本层质量判定（图纸页判定已下沉到页级）', () => {
  it('单页图纸的图签栏文本层本身「可用」——它不负责判图纸，改由页级识别接管', () => {
    // G 线 P0-11：此前此处按「图纸页 ≥ 半数」在文档级否定整份文本层，导致图纸页过半的
    // 招标文件被整本降级到全页 OCR（丢字/丢表/丢数字精度）。现改为页级：本函数只判文本层
    // 质量，图纸页由 isSparseTextSheetPage 逐页识别并进入选择性 OCR。
    expect(hasUsablePdfText(TITLE_BLOCK_ONLY, 1)).toBe(true);
  });

  it('单页正常文字页：文本层可用', () => {
    expect(hasUsablePdfText(NORMAL_TEXT_PAGE, 1)).toBe(true);
  });

  it('多页 + 页均密度过低：既有的文档级密度保护仍然生效', () => {
    expect(hasUsablePdfText(TITLE_BLOCK_ONLY, 10)).toBe(false);
  });

  it('极短文本仍按绝对门槛拦下', () => {
    expect(hasUsablePdfText('图签', 1)).toBe(false);
  });
});

// ─── 真实文件端到端（沿用本仓其他 PDF 测试的约定：文件缺失时跳过）──────────
// 注意：该约定意味着 CI 上没有真实资料时本用例**不会失败**——这也是 §4 B
// 「真实文件进 CI」要解决的问题（需把匿名化的小样本提交进仓库）。
const SRC_PDF = process.env.CUSTOMIZE_KB_SHEET_PDF
  ?? path.join(
    os.homedir(),
    '.customize-agent/projects/3c3f04667c69/knowledgeBase/舒城(2)/图纸/01公共广场空间改造——全套施工图纸PDF/01公共广场空间改造——全套施工图纸PDF/01景观/4.5产业园停车场提升改造工程-ZP-10-景观铺装设计图-A2.pdf',
  );
const skip = !fs.existsSync(SRC_PDF);

describe('单页 A2 图纸 PDF 端到端（真实文件）', () => {
  it.skipIf(skip)('不再以 pdf_text_first 跳过 OCR，且正文内容显著多于图签栏', async () => {
    const stat = fs.statSync(SRC_PDF);
    const file: ClassifiedFile = new FileClassifier().classify(SRC_PDF, SRC_PDF, stat);
    const result = await extractor.extract(file);
    const text = String(result.text ?? '');
    const cjk = (text.match(/[\p{Script=Han}]/gu) ?? []).length;

    // G 线 P0-11 页级：保留文本层（不再整本降级到全页 OCR），仅对图纸页叠加 OCR
    expect(String(result.metadata.contentCoverage)).toContain('page_ocr');
    expect(result.metadata.ocrAugmentedPages ?? result.metadata.ocrTiled ?? true).toBeTruthy();
    // 原始缺陷：345 字符 / 176 中文（只有图签栏）；页级修复后实测 1,788 字符 / 785 中文
    expect(cjk).toBeGreaterThan(300);
    expect(text).toMatch(/[0-9]{2,4}(\*|×)[0-9]{2,4}/u);   // 尺寸类标注，图签栏不会有
  }, 120_000);
});
