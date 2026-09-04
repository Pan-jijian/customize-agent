import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { ContentExtractor } from '../src/extraction/content-extractor.js';
import { TextChunker } from '../src/chunking/text-chunker.js';
import { FileClassifier } from '../src/classification/classifier.js';
import type { ClassifiedFile } from '../src/types.js';

// ─── 回归用例：空文本层图形页（CAD 矢量图/扫描图页）不得整页丢失 ─────────
// 背景：舒城项目「01梅河东路龙津大道交通信控工程.pdf」中第 77/79/80 页（手井大样图、
// 信号机基础大样图、危险性较大分部分项工程专项设计说明）文本层为空但页面有真实内容，
// 旧版提取管线直接跳过空文本层页，导致整页信息（含危大工程表单大量重要文本）完全丢失。
// 修复：空文本层页若存在绘制内容（图片/矢量描边）则进入选择性 OCR 候选。

const SRC_PDF = process.env.CUSTOMIZE_KB_EMPTY_GRAPHIC_PDF
  ?? '/Users/pan/.customize-agent/projects/3c3f04667c69/knowledgeBase/舒城/图纸/08梅河东路与龙津大道信号灯工程（正式图纸）/08梅河东路与龙津大道信号灯工程/01梅河东路龙津大道交通信控工程.pdf';

// 物理页码（1-based）：用户阅读器页码 ≈ 物理页码 - 2（封面/目录偏移）
const EMPTY_GRAPHIC_PAGES = [77, 79, 80];

const skip = !fs.existsSync(SRC_PDF);

describe('PDF 空文本层图形页 OCR 兜底（真实图纸 PDF）', () => {
  it.skipIf(skip)(`空图形页 ${EMPTY_GRAPHIC_PAGES.join('/')} 进入 OCR 候选且危大表单内容入库`, async () => {
    const stat = fs.statSync(SRC_PDF);
    const file: ClassifiedFile = new FileClassifier().classify(SRC_PDF, SRC_PDF, stat);
    const extractor = new ContentExtractor();

    const result = await extractor.extract(file);
    const emptyPages = (result.metadata.emptyTextLayerPages as number[]) ?? [];

    // 1. 空文本层图形页被检出
    for (const page of EMPTY_GRAPHIC_PAGES) {
      expect(emptyPages, `物理第 ${page} 页应被识别为空文本层图形页`).toContain(page);
    }

    // 2. 这些页确实走了 OCR 补提（ocrAugmentedPages 应包含它们）
    const augmented = (result.metadata.ocrAugmentedPages as number[]) ?? [];
    for (const page of EMPTY_GRAPHIC_PAGES) {
      expect(augmented, `物理第 ${page} 页应有 OCR 补提结果`).toContain(page);
    }

    // 3. 危大工程表单（物理第 80 页）核心内容出现在最终文本中
    expect(result.text, '危大表单标题应入库').toContain('危险性较大分部分项工程专项设计说明');
    // 表单正文关键数据（宽松匹配，容忍 OCR 识别误差）
    expect(result.text, '危大表单正文关键内容应入库').toContain('开挖深度');
    expect(result.text, '基坑工程范围说明应入库').toContain('基坑');

    // 4. 切分后危大表单节独立成 parent，section_title 不再错挂
    const chunker = new TextChunker();
    const candidates = chunker.chunk(result.text, file, result.metadata);
    const target = candidates.find(candidate => candidate.text.includes('危险性较大分部分项工程专项设计说明'));
    expect(target, '应存在包含危大表单内容的 chunk').toBeDefined();
    expect(target?.sectionTitle, '危大表单节标题应为本页 OCR 标题').toContain('PDF 第 80 页');
  }, 300_000);
});
