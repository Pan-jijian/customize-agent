/**
 * 大幅面页面 OCR 切片。
 *
 * 为什么需要切片：paddleocr 的检测预处理会把整页缩放到 `maxSideLength` 以内再送检测网络。
 * v5 预设是 `limitType:'max'` + 960 —— 一张 A2 施工图（200DPI 渲染 4678×3309）会被压到
 * 960px 长边，图上 2.5mm 的标注缩完只剩约 4px，检测模型直接看不见，只有图签栏那种大字
 * 能识别（实测整页仅 450 字符，而切片后可达数千字符）。v6 预设改用 `limitType:'min'`
 * 且长边仅受 `maxSideLimit:4000` 约束，已经拿回了大部分（实测 1810 字符），
 * 但 4000px 上限对 A1/A0 与高 DPI 渲染依然会丢小字。
 *
 * 切片的关键性质：**切片边长 <= 检测输入上限时不发生任何缩放**，检测在原生分辨率上进行。
 * 因此这里默认切片 900px（v5 上限 960 之内），单块不做缩放即可识别。
 *
 * 触发条件用**物理尺寸**而不是像素：同一张实体图纸无论渲染多少 DPI，压到 960px 后的
 * 物理分辨率完全相同（960px / 页长边mm），只有物理尺寸是 DPI 无关的正确判据。
 */

import { resolveAndImport } from './module-resolver.js';
import { type OcrRegion, type OcrResult, type OcrRecognizeOptions } from './ocr-providers.js';

export interface TileRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TilePlan {
  tiles: TileRect[];
  tilePx: number;
  overlapPx: number;
  cols: number;
  rows: number;
  /** 受切片数预算限制放大了切片边长（覆盖率不变，单块分辨率下降） */
  enlargedForBudget: boolean;
}

export interface TileDecision {
  tile: boolean;
  reason: string;
  longSidePx: number;
  longSideMm?: number;
}

export interface RgbPixels {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

/** 单个切片 OCR 失败时的告警上限，避免整页告警刷屏 */
const MAX_TILE_WARNINGS = 10;

// ─── 切片网格 ───────────────────────────────────────────────────

/**
 * 计算覆盖整页的重叠网格。
 * 位置做**钳制**而不是截断尺寸：每个切片都是完整的 tilePx×tilePx（页面足够大时），
 * 既不产生贴边的细条，也保证「切片 <= 检测上限 ⇒ 不缩放」这一性质由网格本身给出。
 */
export function planTiles(
  width: number,
  height: number,
  options: { tilePx: number; overlapPx: number; maxTiles?: number },
): TilePlan {
  const maxTiles = Math.max(1, Math.floor(options.maxTiles ?? 64));
  const overlapPx = Math.max(0, Math.min(options.overlapPx, Math.floor(options.tilePx / 2)));
  let tilePx = Math.max(1, Math.floor(options.tilePx));

  let enlargedForBudget = false;
  let plan = gridFor(width, height, tilePx, overlapPx);
  if (plan.tiles.length > maxTiles) {
    // 超出预算时放大边长重算：宁可分辨率下降，也不静默跳过切片。
    // 用面积闭式估个起点，再迭代收敛 —— 重叠会让实际块数多于面积估算
    // （末段整块钳制，无法靠缩小重叠省掉），闭式一次算不准。
    const extent = Math.max(width, height, 1);
    tilePx = Math.max(tilePx, Math.ceil(Math.sqrt(Math.max(1, width * height) / maxTiles)));
    plan = gridFor(width, height, tilePx, overlapPx);
    let guard = 0;
    while (plan.tiles.length > maxTiles && tilePx < extent && guard < 32) {
      tilePx = Math.min(extent, Math.ceil(tilePx * 1.4));
      plan = gridFor(width, height, tilePx, overlapPx);
      guard++;
    }
    enlargedForBudget = true;
  }
  return { ...plan, tilePx, overlapPx, enlargedForBudget };
}

function gridFor(width: number, height: number, tilePx: number, overlapPx: number): { tiles: TileRect[]; cols: number; rows: number } {
  const tileW = Math.min(tilePx, Math.max(1, width));
  const tileH = Math.min(tilePx, Math.max(1, height));
  const stepX = Math.max(1, tileW - overlapPx);
  const stepY = Math.max(1, tileH - overlapPx);
  const lefts = positions(width, tileW, stepX);
  const tops = positions(height, tileH, stepY);
  const tiles: TileRect[] = [];
  for (const top of tops) {
    for (const left of lefts) tiles.push({ left, top, width: tileW, height: tileH });
  }
  return { tiles, cols: lefts.length, rows: tops.length };
}

/** 生成覆盖 [0, extent] 的起点列表：末段钳到 extent - tile，并去掉重复起点 */
function positions(extent: number, tile: number, step: number): number[] {
  if (tile >= extent) return [0];
  const out: number[] = [];
  const last = extent - tile;
  for (let position = 0; ; position += step) {
    const clamped = Math.min(position, last);
    if (out.length === 0 || clamped > out[out.length - 1]!) out.push(clamped);
    if (clamped >= last) break;
  }
  return out;
}

// ─── 触发判定 ───────────────────────────────────────────────────

/** 毫米 → 像素（按渲染 DPI） */
const MM_PER_INCH = 25.4;

/**
 * 是否需要切片。两个条件取或，任一命中即切片：
 *
 * 1. **页面长边物理尺寸 ≥ 阈值**（DPI 无关的判据）。同一张实体图纸无论渲染多少 DPI，
 *    被检测网络压到固定边长后的物理分辨率完全相同（缩放后每毫米像素数 = 目标边长 / 页长边mm），
 *    所以纸张尺寸才是可靠判据 —— 3mm 标注在 A4 上缩放后约 9.7px（能识别），在 A2 上只剩约 4.9px（丢失）。
 * 2. **渲染像素长边超过检测输入上限**。阈值判定用的是标称纸张尺寸，遇到自定义图幅、
 *    超长横幅或高 DPI 渲染时可能漏判，而只要渲染长边超过模型上限就一定会被缩放 ——
 *    这条兜底保证「任何情况下都不会因缩放丢字」。
 */
export function shouldTilePage(input: {
  widthPx: number;
  heightPx: number;
  widthMm?: number;
  heightMm?: number;
  dpi?: number;
  thresholdMm: number;
  maxSidePx: number;
  tilePx: number;
}): TileDecision {
  const longSidePx = Math.max(input.widthPx, input.heightPx);
  if (longSidePx <= input.tilePx) {
    return { tile: false, reason: 'page smaller than one tile', longSidePx };
  }
  const knownMm = input.widthMm !== undefined && input.heightMm !== undefined
    ? Math.max(input.widthMm, input.heightMm)
    : undefined;
  // 拿不到页面几何（pdfjs 降级渲染、栅格图片）时按 DPI 折算长边物理尺寸
  const dpi = input.dpi && input.dpi > 0 ? input.dpi : 200;
  const longSideMm = knownMm ?? (longSidePx / dpi) * MM_PER_INCH;

  if (longSidePx > input.maxSidePx) {
    return { tile: true, reason: `rendered long-side ${longSidePx}px > detection limit ${input.maxSidePx}px`, longSidePx, longSideMm };
  }
  const tile = longSideMm >= input.thresholdMm;
  return {
    tile,
    reason: tile ? `long-side ${Math.round(longSideMm)}mm >= ${input.thresholdMm}mm` : `long-side ${Math.round(longSideMm)}mm < ${input.thresholdMm}mm`,
    longSidePx,
    longSideMm,
  };
}

// ─── 像素裁剪 ───────────────────────────────────────────────────

interface SharpRawResult { data: Buffer; info: { width: number; height: number; channels: number } }
/** 只声明用到的 sharp 子集，避免把 sharp 的类型带进包的类型面 */
interface SharpPipeline {
  removeAlpha(): SharpPipeline;
  toColourspace(space: string): SharpPipeline;
  extract(region: TileRect): SharpPipeline;
  raw(): SharpPipeline;
  toBuffer(options: { resolveWithObject: boolean }): Promise<SharpRawResult>;
}

async function sharpFactory(): Promise<(input: string) => SharpPipeline> {
  const sharpMod = await resolveAndImport('sharp');
  return ((sharpMod as { default?: unknown }).default ?? sharpMod) as (input: string) => SharpPipeline;
}

function toRgbPixels(decoded: SharpRawResult): RgbPixels {
  return {
    data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    width: decoded.info.width,
    height: decoded.info.height,
    channels: decoded.info.channels,
  };
}

/** 解码为 RGB 三通道原始像素（paddleocr 的 ImageInput 恒定按 3 通道解释 data） */
export async function decodeRgbPixels(filePath: string): Promise<RgbPixels> {
  const sharp = await sharpFactory();
  return toRgbPixels(await sharp(filePath).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true }));
}

/**
 * 从整页像素中裁出一块，输出一定是 3 通道。
 * 必须**逐行**按源步长拷贝：整块连续 slice 只在整页宽度等于切片宽度时才正确。
 */
export function cropRgbTile(source: RgbPixels, tile: TileRect): RgbPixels {
  const channels = source.channels || 3;
  const left = Math.max(0, Math.min(tile.left, Math.max(0, source.width - 1)));
  const top = Math.max(0, Math.min(tile.top, Math.max(0, source.height - 1)));
  const width = Math.max(1, Math.min(tile.width, source.width - left));
  const height = Math.max(1, Math.min(tile.height, source.height - top));

  if (channels === 3) {
    const out = new Uint8Array(width * height * 3);
    const sourceStride = source.width * 3;
    for (let row = 0; row < height; row++) {
      const from = (top + row) * sourceStride + left * 3;
      out.set(source.data.subarray(from, from + width * 3), row * width * 3);
    }
    return { data: out, width, height, channels: 3 };
  }

  // 单通道（灰度扫描件）或四通道：逐像素展开/丢弃 alpha，保证输出恒为 RGB
  const out = new Uint8Array(width * height * 3);
  const sourceStride = source.width * channels;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const from = (top + row) * sourceStride + (left + col) * channels;
      const to = (row * width + col) * 3;
      if (channels === 1) {
        const value = source.data[from] ?? 0;
        out[to] = value; out[to + 1] = value; out[to + 2] = value;
      } else {
        out[to] = source.data[from] ?? 0;
        out[to + 1] = source.data[from + 1] ?? 0;
        out[to + 2] = source.data[from + 2] ?? 0;
      }
    }
  }
  return { data: out, width, height, channels: 3 };
}

// ─── 切片结果合并 ───────────────────────────────────────────────

/** 去空白与标点后比较，避免同一标注因切缝处空格/标点差异被判为两条 */
function comparableText(value: string): string {
  return value.replace(/[\s\p{P}\p{S}]/gu, '');
}

function yCenter(region: OcrRegion): number {
  return region.box.y + region.box.height / 2;
}

/**
 * 合并各切片结果：平移回整页坐标，并去掉重叠区里的重复检测。
 * 判定为同一条需要同时满足「文本一致」与「框显著重叠」——只按文本去重会把
 * 图纸上真实重复出现的标注（如两处相同的门编号）误合并。
 */
export function mergeTileRegions(
  entries: ReadonlyArray<{ tile: TileRect; regions: readonly OcrRegion[] }>,
): OcrRegion[] {
  const shifted: OcrRegion[] = [];
  for (const entry of entries) {
    for (const region of entry.regions) {
      if (!region.text || !region.text.trim()) continue;
      shifted.push({
        text: region.text.trim(),
        confidence: region.confidence,
        box: {
          x: region.box.x + entry.tile.left,
          y: region.box.y + entry.tile.top,
          width: region.box.width,
          height: region.box.height,
        },
      });
    }
  }
  if (shifted.length < 2) return shifted.sort(byPosition);

  const heights = shifted.map(region => region.box.height).filter(value => value > 0).sort((a, b) => a - b);
  const medianHeight = heights.length > 0 ? heights[Math.floor(heights.length / 2)]! : 10;
  const bucketSize = Math.max(6, Math.round(medianHeight / 2));

  // 按 y 中心分桶比较，避免两两全比（大图上 region 数可达数千）；
  // 命中判定允许 y 中心有半个桶的偏差，因此相邻桶也要比
  const buckets = new Map<number, OcrRegion[]>();
  for (const region of shifted) {
    const key = Math.round(yCenter(region) / bucketSize);
    const list = buckets.get(key);
    if (list) list.push(region);
    else buckets.set(key, [region]);
  }

  const dropped = new Set<OcrRegion>();
  for (const region of shifted) {
    if (dropped.has(region)) continue;
    const key = Math.round(yCenter(region) / bucketSize);
    for (const offset of [-1, 0, 1]) {
      for (const neighbour of buckets.get(key + offset) ?? []) {
        if (neighbour === region || dropped.has(neighbour)) continue;
        if (isSameDetection(region, neighbour)) dropped.add(prefer(region, neighbour));
      }
    }
  }
  return shifted.filter(region => !dropped.has(region)).sort(byPosition);
}

/**
 * 是否同一条标注的重复检测。
 * 文本判据有两档：「完全相同」或「一条是另一条的边界子串」—— 后者是切缝的典型形态，
 * 同一条文字在左块被截断成前半段、在右块完整识别（实测「防烟分区」+「防烟分区面积:167m²」），
 * 只比相等会把它们当成两条独立标注拼成一句。
 * 几何判据：横向重叠、或间隙小于较短者的 0.75 倍宽（截断版本通常更短也更靠边）。
 */
function isSameDetection(a: OcrRegion, b: OcrRegion): boolean {
  const aText = comparableText(a.text);
  const bText = comparableText(b.text);
  if (!aText || !bText) return false;
  const same = aText === bText;
  const contained = !same && aText.length !== bText.length
    && (aText.startsWith(bText) || aText.endsWith(bText) || bText.startsWith(aText) || bText.endsWith(aText));
  if (!same && !contained) return false;

  if (Math.abs(yCenter(a) - yCenter(b)) > 0.6 * Math.min(a.box.height, b.box.height)) return false;
  const gap = Math.max(a.box.x, b.box.x) - Math.min(a.box.x + a.box.width, b.box.x + b.box.width);
  const tolerance = 0.75 * Math.min(a.box.width, b.box.width);
  return gap <= tolerance;
}

/**
 * 重复检测丢弃哪一条：
 * - 文本是边界子串关系时丢弃较短的那条（截断版本信息更少）
 * - 否则置信度高者保留，置信度接近时保留更靠左的（同一位置重复时结果确定）
 */
function prefer(a: OcrRegion, b: OcrRegion): OcrRegion {
  const aText = comparableText(a.text);
  const bText = comparableText(b.text);
  if (aText !== bText && aText.length !== bText.length
    && (aText.startsWith(bText) || aText.endsWith(bText) || bText.startsWith(aText) || bText.endsWith(aText))) {
    return aText.length >= bText.length ? b : a;
  }
  if (Math.abs(a.confidence - b.confidence) > 0.01) return a.confidence > b.confidence ? b : a;
  return a.box.x <= b.box.x ? b : a;
}

function byPosition(a: OcrRegion, b: OcrRegion): number {
  return yCenter(a) - yCenter(b) || a.box.x - b.box.x;
}

// ─── 版面拼装 ───────────────────────────────────────────────────

/**
 * 按图纸的空间顺序拼装文本：先按 y 分行，行内按 x 连接。
 * 不走 `reflowOcrRegionsByColumns`（那是给多栏正文页设计的栏间走廊检测），
 * 图纸不是多栏正文，按栏重排会把版面顺序打乱。
 */
export function assembleTiledText(
  regions: readonly OcrRegion[],
  options: { lineToleranceRatio?: number; gapFactor?: number } = {},
): { text: string; lines: OcrRegion[][] } {
  const lineToleranceRatio = options.lineToleranceRatio ?? 0.5;
  const gapFactor = options.gapFactor ?? 2.5;
  const sorted = [...regions].filter(region => region.text.trim()).sort(byPosition);
  if (sorted.length === 0) return { text: '', lines: [] };

  const heights = sorted.map(region => region.box.height).filter(value => value > 0);
  const averageHeight = heights.length > 0 ? heights.reduce((sum, value) => sum + value, 0) / heights.length : 10;
  const lineTolerance = Math.max(4, Math.round(averageHeight * lineToleranceRatio));
  // 同一 y 上相距很远的两个标注（左边尺寸、右边房间名）不是同一行文本，
  // 超过该间距就断行，避免被拼成一句无意义的长文本
  const maxJoinGap = Math.max(30, Math.round(averageHeight * gapFactor));

  const lines: OcrRegion[][] = [];
  let current: OcrRegion[] = [];
  let anchorY = Number.NaN;
  let lastRight = Number.NaN;

  for (const region of sorted) {
    const y = yCenter(region);
    const newLine = current.length === 0
      || Math.abs(y - anchorY) > lineTolerance
      || region.box.x - lastRight > maxJoinGap;
    if (newLine) {
      if (current.length > 0) lines.push(current);
      current = [region];
      anchorY = y;
    } else {
      current.push(region);
    }
    lastRight = region.box.x + region.box.width;
  }
  if (current.length > 0) lines.push(current);

  const text = lines.map(line => line.map(region => region.text.trim()).join(' ')).join('\n');
  return { text, lines };
}

// ─── 噪声控制 ───────────────────────────────────────────────────

const GRAPHIC_SYMBOL_RE = /[|\\<>[\]{}~^`_*"]/u;

/**
 * 切片页的 region 级过滤。放宽检测阈值换召回后必然带进噪声碎片，
 * 这里只丢弃「确定无信息」的条目（纯符号、单字符非汉字且置信度低、符号占比过半），
 * 保留短数字/单字汉字/工程符号组合等真实标注形态。
 */
export function filterTiledRegions(
  regions: readonly OcrRegion[],
  options: { minConfidence?: number } = {},
): { kept: OcrRegion[]; dropped: number } {
  const minConfidence = options.minConfidence ?? 0.6;
  const kept = regions.filter(region => {
    const text = region.text.trim();
    if (!text) return false;
    const hasHan = /[\p{Script=Han}]/u.test(text);
    const hasAlnum = /[\p{L}\p{N}]/u.test(text);
    if (text.length <= 3 && !hasAlnum) return false;
    if (text.length === 1 && !hasHan && region.confidence < minConfidence) return false;
    let symbols = 0;
    let total = 0;
    for (const char of text) {
      if (char === ' ') continue;
      total++;
      if (GRAPHIC_SYMBOL_RE.test(char)) symbols++;
    }
    if (total > 0 && symbols / total >= 0.5 && !hasAlnum) return false;
    return true;
  });
  return { kept, dropped: regions.length - kept.length };
}

// ─── 编排 ───────────────────────────────────────────────────────

/** 整页原始像素的内存上限；超过时退回「逐块从文件裁剪」以避免一次性展开过大缓冲 */
const MAX_RAW_PIXEL_BYTES = 256 * 1024 * 1024;

export async function recognizeWithTiling(input: {
  source: { filePath: string } | RgbPixels;
  tiles: readonly TileRect[];
  recognize: (pixels: RgbPixels, options?: OcrRecognizeOptions) => Promise<OcrResult>;
  options?: OcrRecognizeOptions;
  /** region 级噪声过滤，默认开启 */
  filterRegions?: boolean;
}): Promise<OcrResult & { tilesAttempted: number; tilesFailed: number }> {
  const warnings: string[] = [];
  const entries: Array<{ tile: TileRect; regions: readonly OcrRegion[] }> = [];
  let tilesFailed = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;

  const inMemory = 'filePath' in input.source ? undefined : input.source;
  const filePath = inMemory ? undefined : (input.source as { filePath: string }).filePath;

  // 整页只解码一次，切片在内存里按行取；sharp 的 extract() 每次都会重新解码整图，
  // 逐块 extract 在 A2 上会带来数十次整图解码（每次数百毫秒）。
  // 只有整页原始像素超出内存上限时才退回逐块从文件裁剪。
  let page: RgbPixels | undefined = inMemory;
  if (filePath) {
    try {
      const decoded = await decodeRgbPixels(filePath);
      if (decoded.width * decoded.height * 3 <= MAX_RAW_PIXEL_BYTES) page = decoded;
    } catch (error) {
      warnings.push(`整页解码失败，改用逐块裁剪：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const tile of input.tiles) {
    try {
      const pixels = page ? cropRgbTile(page, tile) : await cropTileFromFile(filePath!, tile);
      if (pixels.width < 8 || pixels.height < 8 || pixels.width * pixels.height < 128) continue;
      // 串行执行：onnxruntime session 非并发安全，provider 内部也有串行锁，
      // 并发只会让请求在锁上排队，不会更快
      const result = await input.recognize(pixels, input.options);
      entries.push({ tile, regions: result.regions ?? [] });
      if (result.regions?.length) {
        for (const region of result.regions) {
          confidenceSum += region.confidence;
          confidenceCount++;
        }
      }
      for (const warning of result.warnings ?? []) {
        if (warnings.length < MAX_TILE_WARNINGS) warnings.push(warning);
      }
    } catch (error) {
      tilesFailed++;
      if (warnings.length < MAX_TILE_WARNINGS) {
        warnings.push(`切片 (${tile.left},${tile.top}) OCR 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const merged = mergeTileRegions(entries);
  const { kept, dropped } = input.filterRegions === false ? { kept: merged, dropped: 0 } : filterTiledRegions(merged);
  const assembled = assembleTiledText(kept);
  if (dropped > 0 && warnings.length < MAX_TILE_WARNINGS) warnings.push(`切片合并后过滤图形噪声碎片 ${dropped} 条`);

  return {
    text: assembled.text,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
    regions: kept,
    warnings,
    tilesAttempted: input.tiles.length,
    tilesFailed,
  };
}

async function cropTileFromFile(filePath: string, tile: TileRect): Promise<RgbPixels> {
  const sharp = await sharpFactory();
  return toRgbPixels(await sharp(filePath).extract(tile).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true }));
}
