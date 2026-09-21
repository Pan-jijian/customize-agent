/**
 * 栅格图片切片 OCR 回归。
 *
 * 缺陷背景：`shouldTilePage` / `recognizeWithTiling` 的唯一调用点是 PDF 页路径
 * （`recognizePdfPageOcr`），栅格图片（扫描件、拍照图纸）与 Office 内嵌图一律
 * **整图识别**。检测网络会把整图缩放到 `maxSideLength`（4000px）以内再送检测，
 * A2 图 200DPI 即 4678×3309 —— 图上小号标注缩完只剩几像素、检测模型直接看不见。
 * 且**零告警**：`metadata.imageWidth/imageHeight` 有值，但没有任何地方拿它跟切片阈值比较。
 *
 * 修复：栅格图与内嵌图接入同一条切片路径（`recognizeRasterImage`），
 * `shouldTilePage` 本就支持无物理几何的图片（按 200DPI 折算长边）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentExtractor } from '../src/extraction/content-extractor.js';
import { FileClassifier } from '../src/classification/classifier.js';
import { shouldTilePage } from '../src/extraction/ocr-tiling.js';
import { PADDLE_DETECTION_MAX_SIDE_PX } from '../src/extraction/paddle-model-select.js';
import type { ClassifiedFile } from '../src/types.js';

const TILE_PX = 900;
const TILE_TRIGGER_MM = 400;

describe('大幅面栅格图的切片判据', () => {
  it('长边超过检测上限（A2 @200DPI ≈ 4678×3309）→ 应切片', () => {
    const decision = shouldTilePage({
      widthPx: 4678, heightPx: 3309,
      maxSidePx: PADDLE_DETECTION_MAX_SIDE_PX, tilePx: TILE_PX, thresholdMm: TILE_TRIGGER_MM,
    });
    expect(decision.tile).toBe(true);
    expect(decision.longSidePx).toBe(4678);
  });

  it('小图（A4 扫描 @200DPI ≈ 1654×2339）→ 不切片，避免无谓开销', () => {
    const decision = shouldTilePage({
      widthPx: 1654, heightPx: 2339,
      maxSidePx: PADDLE_DETECTION_MAX_SIDE_PX, tilePx: TILE_PX, thresholdMm: TILE_TRIGGER_MM,
    });
    expect(decision.tile).toBe(false);
  });
});

describe('栅格图端到端接入切片（真实图片文件）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-raster-tile-'));
  const extractor = new ContentExtractor();
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /** 生成一张 W×H 的白底图片并在指定位置画中文标注，用于检验切片是否被触发 */
  async function makeLargeImage(width: number, height: number, name: string): Promise<ClassifiedFile | undefined> {
    let canvas: typeof import('@napi-rs/canvas');
    try {
      canvas = await import('@napi-rs/canvas');
    } catch {
      return undefined;   // canvas 不可用时跳过（CI 环境差异）
    }
    const { createCanvas } = canvas;
    const c = createCanvas(width, height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000000';
    ctx.font = '28px sans-serif';
    // 分散标注：切片才能逐块识别到；整图缩放后这些小字会糊掉
    for (let i = 0; i < 40; i += 1) {
      ctx.fillText(`标注${i + 1} DN200 管道 标高 ${(i * 0.15).toFixed(2)}`, 120 + (i % 8) * 520, 220 + Math.floor(i / 8) * 700);
    }
    const abs = path.join(tmpDir, name);
    fs.writeFileSync(abs, c.toBuffer('image/png'));
    const stat = fs.statSync(abs);
    return new FileClassifier().classify(abs, name, stat);
  }

  it('4678×3309 的大图走切片路径并记录切片元数据', async () => {
    const file = await makeLargeImage(4678, 3309, 'drawing-large.png');
    if (!file) return;   // canvas 不可用
    const result = await extractor.extract(file);

    expect(result.metadata.imageWidth).toBe(4678);
    // 修复前：整图识别，ocrTiled 不存在；修复后：判定切片并记录块数
    expect(result.metadata.ocrTiled).toBe(true);
    expect(Number(result.metadata.ocrTileCount)).toBeGreaterThan(1);
  }, 300_000);

  it('小图不切片（保持既有行为，不引入无谓开销）', async () => {
    const file = await makeLargeImage(800, 600, 'small.png');
    if (!file) return;
    const result = await extractor.extract(file);
    expect(result.metadata.ocrTiled).toBeUndefined();
  }, 120_000);
});
