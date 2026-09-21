import { describe, it, expect } from 'vitest';
import {
  assembleTiledText,
  cropRgbTile,
  filterTiledRegions,
  mergeTileRegions,
  planTiles,
  recognizeWithTiling,
  shouldTilePage,
  type RgbPixels,
  type TileRect,
} from '../src/extraction/ocr-tiling.js';
import type { OcrRegion, OcrResult } from '../src/extraction/ocr-providers.js';

// ─── 切片网格 ───────────────────────────────────────────────────

describe('planTiles', () => {
  it('切片尺寸恒定、位置在界内、接缝重叠等于设定值', () => {
    const plan = planTiles(1900, 1300, { tilePx: 900, overlapPx: 120 });
    expect(plan.cols).toBe(3);
    expect(plan.rows).toBe(2);
    expect(plan.tiles).toHaveLength(6);
    for (const tile of plan.tiles) {
      expect(tile.width).toBe(900);
      expect(tile.height).toBe(900);
      expect(tile.left).toBeGreaterThanOrEqual(0);
      expect(tile.top).toBeGreaterThanOrEqual(0);
      expect(tile.left + tile.width).toBeLessThanOrEqual(1900);
      expect(tile.top + tile.height).toBeLessThanOrEqual(1300);
    }
    // 相邻列起点差 = 切片边长 - 重叠 = 780
    const lefts = [...new Set(plan.tiles.map(tile => tile.left))].sort((a, b) => a - b);
    expect(lefts).toEqual([0, 780, 1000]);
  });

  it('末段钳制到边界而不是裁短尺寸（不产生贴边细条）', () => {
    const plan = planTiles(2000, 1000, { tilePx: 900, overlapPx: 120 });
    const lefts = [...new Set(plan.tiles.map(tile => tile.left))];
    expect(lefts).toContain(1100); // 2000 - 900
    expect(plan.tiles.every(tile => tile.width === 900)).toBe(true);
  });

  it('页面小于切片时返回单块', () => {
    const plan = planTiles(400, 300, { tilePx: 900, overlapPx: 120 });
    expect(plan.tiles).toEqual([{ left: 0, top: 0, width: 400, height: 300 }]);
  });

  it('切片网格无缝覆盖整页', () => {
    const width = 1900; const height = 1300;
    const plan = planTiles(width, height, { tilePx: 900, overlapPx: 120 });
    for (let x = 0; x < width; x += 37) {
      for (let y = 0; y < height; y += 29) {
        expect(plan.tiles.some(tile => x >= tile.left && x < tile.left + tile.width && y >= tile.top && y < tile.top + tile.height)).toBe(true);
      }
    }
  });

  it('超出切片数预算时放大切片而不是静默跳过', () => {
    const plan = planTiles(10000, 10000, { tilePx: 900, overlapPx: 120, maxTiles: 4 });
    expect(plan.enlargedForBudget).toBe(true);
    expect(plan.tiles.length).toBeLessThanOrEqual(4);
    expect(plan.tilePx).toBeGreaterThan(900);
  });

  it('重叠不超过切片边长的一半（防止步进为 0）', () => {
    const plan = planTiles(1000, 1000, { tilePx: 100, overlapPx: 500 });
    expect(plan.overlapPx).toBe(50);
    expect(plan.tiles.length).toBeGreaterThan(1);
  });
});

// ─── 触发判定 ───────────────────────────────────────────────────

describe('shouldTilePage', () => {
  const base = { thresholdMm: 400, maxSidePx: 4000, tilePx: 900 };

  it('A4（297mm）不切片', () => {
    expect(shouldTilePage({ ...base, widthPx: 1654, heightPx: 2339, widthMm: 210, heightMm: 297 }).tile).toBe(false);
  });

  it('A3（420mm）切片', () => {
    expect(shouldTilePage({ ...base, widthPx: 2339, heightPx: 3307, widthMm: 297, heightMm: 420 }).tile).toBe(true);
  });

  it('A2/A1 切片', () => {
    expect(shouldTilePage({ ...base, widthPx: 4677, heightPx: 3307, widthMm: 420, heightMm: 594 }).tile).toBe(true);
    expect(shouldTilePage({ ...base, widthPx: 6614, heightPx: 4677, widthMm: 594, heightMm: 841 }).tile).toBe(true);
  });

  it('阈值边界取等号即切片', () => {
    expect(shouldTilePage({ ...base, widthPx: 1000, heightPx: 1000, widthMm: 300, heightMm: 400 }).tile).toBe(true);
  });

  it('无页面几何时按 DPI 折算（DPI 无关性：同一实体图纸不同 DPI 判定一致）', () => {
    expect(shouldTilePage({ ...base, widthPx: 4677, heightPx: 3307, dpi: 200 }).tile).toBe(true);
    expect(shouldTilePage({ ...base, widthPx: 7017, heightPx: 4963, dpi: 300 }).tile).toBe(true);
    // A4 在两种 DPI 下都不切片
    expect(shouldTilePage({ ...base, widthPx: 1654, heightPx: 2339, dpi: 200 }).tile).toBe(false);
    expect(shouldTilePage({ ...base, widthPx: 2480, heightPx: 3508, dpi: 300 }).tile).toBe(false);
  });

  it('标称尺寸未达阈值但渲染长边超过检测上限时仍然切片（兜底：只要会被缩放就不放过）', () => {
    // 自定义图幅/超长横幅：物理尺寸按 DPI 折算只有 ~300mm，但渲染后 4700px 会被压到 4000px
    const decision = shouldTilePage({ ...base, widthPx: 4700, heightPx: 1000, dpi: 400 });
    expect(decision.tile).toBe(true);
    expect(decision.reason).toContain('detection limit');
  });

  it('比单块切片还小的页面不切片', () => {
    expect(shouldTilePage({ ...base, widthPx: 400, heightPx: 300, widthMm: 2000, heightMm: 1000 }).tile).toBe(false);
  });
});

// ─── 像素裁剪 ───────────────────────────────────────────────────

/** 造一张每个像素可唯一识别的 RGB 图：像素值 = 行*10+列，三通道 = 基值 + 通道号 */
function makeRgb(width: number, height: number): RgbPixels {
  const data = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const base = row * 10 + col;
      const offset = (row * width + col) * 3;
      data[offset] = base;
      data[offset + 1] = base + 1;
      data[offset + 2] = base + 2;
    }
  }
  return { data, width, height, channels: 3 };
}

describe('cropRgbTile', () => {
  it('内部切片逐行取像素（整块 slice 会串行）', () => {
    const source = makeRgb(6, 4);
    const tile = cropRgbTile(source, { left: 2, top: 1, width: 3, height: 2 });
    expect(tile.width).toBe(3);
    expect(tile.height).toBe(2);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const expected = (1 + row) * 10 + (2 + col);
        const offset = (row * 3 + col) * 3;
        expect([tile.data[offset], tile.data[offset + 1], tile.data[offset + 2]]).toEqual([expected, expected + 1, expected + 2]);
      }
    }
  });

  it('灰度图展开为三通道', () => {
    const width = 4; const height = 2;
    const data = new Uint8Array(width * height);
    for (let index = 0; index < data.length; index++) data[index] = index * 5;
    const tile = cropRgbTile({ data, width, height, channels: 1 }, { left: 1, top: 0, width: 2, height: 2 });
    expect(tile.channels).toBe(3);
    expect([tile.data[0], tile.data[1], tile.data[2]]).toEqual([5, 5, 5]);
    expect([tile.data[3], tile.data[4], tile.data[5]]).toEqual([10, 10, 10]);
  });

  it('带 alpha 的图丢掉 alpha 只留 RGB', () => {
    const width = 2; const height = 1;
    const data = new Uint8Array([10, 11, 12, 255, 20, 21, 22, 255]);
    const tile = cropRgbTile({ data, width, height, channels: 4 }, { left: 0, top: 0, width: 2, height: 1 });
    expect(tile.channels).toBe(3);
    expect(Array.from(tile.data)).toEqual([10, 11, 12, 20, 21, 22]);
  });

  it('超出边界的切片被钳制在页内', () => {
    const source = makeRgb(10, 10);
    const tile = cropRgbTile(source, { left: 8, top: 8, width: 5, height: 5 });
    expect(tile.width).toBe(2);
    expect(tile.height).toBe(2);
  });
});

// ─── 切片结果合并 ───────────────────────────────────────────────

const region = (text: string, x: number, y: number, confidence = 0.9, width = 60, height = 20): OcrRegion =>
  ({ text, confidence, box: { x, y, width, height } });

describe('mergeTileRegions', () => {
  const leftTile: TileRect = { left: 0, top: 0, width: 900, height: 900 };
  const rightTile: TileRect = { left: 780, top: 0, width: 900, height: 900 };

  it('接缝处的重复检测被合并，保留置信度更高的', () => {
    const merged = mergeTileRegions([
      { tile: leftTile, regions: [region('M1021', 800, 100, 0.8)] },
      { tile: rightTile, regions: [region('M1021', 20, 100, 0.95)] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.confidence).toBe(0.95);
    expect(merged[0]!.box.x).toBe(800); // 平移回整页坐标
  });

  it('文本相同但位置相距很远时两条都保留（图纸上真实重复的标注）', () => {
    const merged = mergeTileRegions([
      { tile: leftTile, regions: [region('M1021', 10, 100)] },
      { tile: rightTile, regions: [region('M1021', 1000, 100)] },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('仅空白/标点差异的同位置检测视为同一条', () => {
    // 同一条标注落在左块的 x=800 与右块（偏移 780）的 x=20，整页坐标同为 800
    const merged = mergeTileRegions([
      { tile: leftTile, regions: [region('C30 混凝土', 800, 50)] },
      { tile: rightTile, regions: [region('C30混凝土', 20, 50)] },
    ]);
    expect(merged).toHaveLength(1);
  });

  it('不同文本即使框重叠也不合并', () => {
    const merged = mergeTileRegions([
      { tile: leftTile, regions: [region('配电间', 800, 100)] },
      { tile: rightTile, regions: [region('储藏室', 20, 100)] },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('切缝处「截断文本 + 完整文本」合并，保留完整的那条', () => {
    // 左块只截到「防烟分区」，右块在同一条文字上截到了完整串
    const merged = mergeTileRegions([
      { tile: leftTile, regions: [region('防烟分区', 880, 100, 0.98, 70)] },
      { tile: rightTile, regions: [region('防烟分区面积:167m²', 100, 102, 0.9, 160)] },
    ]);
    expect(merged.map(item => item.text)).toEqual(['防烟分区面积:167m²']);
  });

  it('包含关系但位置相距很远时不合并（真实的短标注与长标注）', () => {
    const merged = mergeTileRegions([
      { tile: leftTile, regions: [region('男卫', 10, 100)] },
      { tile: rightTile, regions: [region('男卫生间', 1500, 100)] },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('输出按 (y, x) 稳定排序', () => {
    // 整页坐标：'下'(10,200)、'右上'(500,50)、'左上'(100+780=880,50)
    const merged = mergeTileRegions([
      { tile: leftTile, regions: [region('下', 10, 200), region('右上', 500, 50)] },
      { tile: rightTile, regions: [region('左上', 100, 50)] },
    ]);
    expect(merged.map(item => item.text)).toEqual(['右上', '左上', '下']);
  });

  it('空文本条目被丢弃', () => {
    const merged = mergeTileRegions([{ tile: leftTile, regions: [region('   ', 10, 10), region('墙', 20, 40)] }]);
    expect(merged.map(item => item.text)).toEqual(['墙']);
  });
});

// ─── 版面拼装 ───────────────────────────────────────────────────

describe('assembleTiledText', () => {
  it('同一 y 上相距很远的标注断成两行（不拼成无意义长句）', () => {
    const { text } = assembleTiledText([region('2400', 0, 100), region('储藏室', 2000, 100)]);
    expect(text).toBe('2400\n储藏室');
  });

  it('相邻标注同行并用空格连接', () => {
    const { text } = assembleTiledText([region('厚12', 0, 100, 0.9, 40), region('C30', 45, 102, 0.9, 40)]);
    expect(text).toBe('厚12 C30');
  });

  it('不同 y 的标注分行', () => {
    const { text } = assembleTiledText([region('第一行', 0, 0), region('第二行', 0, 200)]);
    expect(text).toBe('第一行\n第二行');
  });

  it('返回行分组供调试', () => {
    const { lines } = assembleTiledText([region('A', 0, 0), region('B', 0, 200)]);
    expect(lines).toHaveLength(2);
  });

  it('空输入返回空文本', () => {
    expect(assembleTiledText([])).toEqual({ text: '', lines: [] });
  });
});

// ─── 噪声过滤 ───────────────────────────────────────────────────

describe('filterTiledRegions', () => {
  it('保留真实工程标注形态', () => {
    const { kept } = filterTiledRegions([
      region('厚12', 0, 0), region('φ25@200', 0, 0), region('C30 混凝土', 0, 0),
      region('墙', 0, 0), region('±0.000', 0, 0), region('M1021', 0, 0),
    ]);
    expect(kept).toHaveLength(6);
  });

  it('丢弃纯图形符号碎片', () => {
    const { kept, dropped } = filterTiledRegions([
      region('|', 0, 0), region('□□', 0, 0), region('...', 0, 0), region('——', 0, 0),
    ]);
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(4);
  });

  it('单字符非汉字且置信度低时丢弃，置信度高时保留（轴线号等）', () => {
    expect(filterTiledRegions([region('8', 0, 0, 0.3)]).kept).toHaveLength(0);
    expect(filterTiledRegions([region('8', 0, 0, 0.9)]).kept).toHaveLength(1);
  });

  it('空文本丢弃', () => {
    expect(filterTiledRegions([region('   ', 0, 0)]).kept).toHaveLength(0);
  });
});

// ─── 编排 ───────────────────────────────────────────────────────

/** 造一张纯色内存图，避免依赖 sharp */
function solidPixels(width: number, height: number): RgbPixels {
  return { data: new Uint8Array(width * height * 3).fill(128), width, height, channels: 3 };
}

describe('recognizeWithTiling', () => {
  it('逐块调用识别、串行执行、缓冲尺寸正确、结果平移回整页坐标', async () => {
    const source = solidPixels(200, 200);
    const tiles = planTiles(200, 200, { tilePx: 100, overlapPx: 20 }).tiles;
    const calls: Array<{ width: number; height: number; bytes: number }> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await recognizeWithTiling({
      source,
      tiles,
      recognize: async (pixels): Promise<OcrResult> => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 1));
        inFlight--;
        calls.push({ width: pixels.width, height: pixels.height, bytes: pixels.data.length });
        return {
          text: `标注${calls.length}`, confidence: 0.9,
          regions: [region(`标注${calls.length}`, 10, 10, 0.9, 40)],
        };
      },
    });

    expect(calls).toHaveLength(tiles.length);
    expect(calls.every(call => call.width === 100 && call.height === 100)).toBe(true);
    expect(calls.every(call => call.bytes === 100 * 100 * 3)).toBe(true);
    expect(maxInFlight).toBe(1); // 串行
    expect(result.tilesAttempted).toBe(tiles.length);
    expect(result.tilesFailed).toBe(0);
    expect(result.regions).toHaveLength(tiles.length);
    // 右下角切片的坐标应带上切片偏移
    const maxX = Math.max(...result.regions.map(item => item.box.x));
    expect(maxX).toBeGreaterThanOrEqual(100);
  });

  it('单块失败不中断整页，记录失败数并给出告警', async () => {
    const source = solidPixels(200, 200);
    const tiles = planTiles(200, 200, { tilePx: 100, overlapPx: 20 }).tiles;
    let index = 0;
    const result = await recognizeWithTiling({
      source,
      tiles,
      recognize: async (): Promise<OcrResult> => {
        index++;
        if (index === 2) throw new Error('boom');
        return { text: '房间', confidence: 0.9, regions: [region('房间', 10, 10)] };
      },
    });
    expect(result.tilesFailed).toBe(1);
    expect(result.tilesAttempted).toBe(tiles.length);
    expect(result.warnings.join()).toContain('OCR 失败');
    expect(result.regions.length).toBeGreaterThan(0);
  });

  it('过小的切片跳过识别', async () => {
    const source = solidPixels(10, 10);
    let called = 0;
    const result = await recognizeWithTiling({
      source,
      tiles: [{ left: 0, top: 0, width: 4, height: 4 }],
      recognize: async (): Promise<OcrResult> => { called++; return { text: '', confidence: 0, regions: [] }; },
    });
    expect(called).toBe(0);
    expect(result.tilesAttempted).toBe(1);
  });

  it('filterRegions=false 时保留原始 region 集合', async () => {
    const source = solidPixels(100, 100);
    const noisy = '|';
    const runWith = async (filterRegions: boolean) => recognizeWithTiling({
      source,
      tiles: [{ left: 0, top: 0, width: 100, height: 100 }],
      filterRegions,
      recognize: async (): Promise<OcrResult> => ({ text: noisy, confidence: 0.9, regions: [region(noisy, 10, 10)] }),
    });
    expect((await runWith(false)).regions).toHaveLength(1);
    expect((await runWith(true)).regions).toHaveLength(0);
  });
});
