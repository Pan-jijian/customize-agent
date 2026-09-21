/**
 * OCR 提供者 — tesseract.js 跨平台 WASM
 *
 * 使用 tesseract.js v7（WASM），bundled traineddata，
 * 真正跨平台（Windows/macOS/Linux），无需系统依赖。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAndImport, resolvePackage } from './module-resolver.js';
import { parseDictionaryLines, selectPaddleModelFiles, type PaddleModelSelection } from './paddle-model-select.js';

export interface OcrRegion {
  text: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
}

export interface OcrResult {
  text: string;
  confidence: number;
  regions: OcrRegion[];
  warnings?: string[];
}

/**
 * 逐次识别参数（可选）。形状与 paddleocr 的 RecognitionOptions 对齐：
 * `detection` 覆盖检测预处理/后处理阈值，`process` 覆盖 processRecognition 的行过滤阈值。
 * 不传时与历史行为完全一致。方向分类（textlineOrientation）不在此处，
 * 它是实例级配置，逐次传会在库内部抛错。
 */
export interface OcrRecognizeOptions {
  detection?: Record<string, unknown>;
  recognition?: Record<string, unknown>;
  process?: Record<string, unknown>;
}

export interface OcrInput {
  data: Uint8Array;
  width: number;
  height: number;
  channels?: number;
  filePath?: string;
}

export interface OcrProvider {
  readonly id: string;
  readonly available: boolean;
  /** 不可用时的原因（如模型文件缺失），供调用方写出可见告警，避免静默降级 */
  readonly availabilityNote?: string;
  recognize(input: OcrInput, options?: OcrRecognizeOptions): Promise<OcrResult>;
  getWarnings?(): string[];
  dispose(): Promise<void>;
}

// ─── 路径工具 ───────────────────────────────────────────────────

const knowledgeDir = path.dirname(fileURLToPath(import.meta.url));
/** 方向分类置信度阈值，对应 PaddleOCR 的 cls_thresh 默认值 */
const ORIENTATION_THRESHOLD = 0.9;
const OCR_NOISE_SUPPRESSION_KEY = Symbol.for('customize-agent.ocr-noise-suppression');
const OCR_NATIVE_NOISE_PATTERNS = [
  /^Image too small to scale!!(?:\s*\([^)]*\))?$/u,
  /^Line cannot be recognized!!$/u,
  /^empty image$/iu,
];
type OcrNoiseSuppressionState = {
  stdout?: typeof process.stdout.write;
  stderr?: typeof process.stderr.write;
  log?: typeof console.log;
  warn?: typeof console.warn;
  error?: typeof console.error;
  installed?: boolean;
};



function tessdataDir(): string {
  if (process.env.TESSDATA_PREFIX) return process.env.TESSDATA_PREFIX;
  const pkg = path.resolve(knowledgeDir, '..', '..', 'models', 'tessdata');
  if (fs.existsSync(pkg)) return pkg;
  return pkg;
}

function ocrNoiseSuppressionState() {
  const globalState = globalThis as typeof globalThis & { [OCR_NOISE_SUPPRESSION_KEY]?: OcrNoiseSuppressionState };
  globalState[OCR_NOISE_SUPPRESSION_KEY] ??= {};
  return globalState[OCR_NOISE_SUPPRESSION_KEY]!;
}

function textFromChunk(chunk: unknown) {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : typeof chunk === 'string' ? chunk : '';
}

function isOcrNoiseLine(line: string) {
  const text = line.trim();
  return !!text && OCR_NATIVE_NOISE_PATTERNS.some(pattern => pattern.test(text));
}

function filterNativeOcrNoiseText(text: string) {
  const hasTrailingNewline = /\r?\n$/u.test(text);
  const lines = text.split(/\r?\n/u);
  const nonEmptyLines = lines.filter(line => line.trim());
  if (nonEmptyLines.length > 0 && nonEmptyLines.every(isOcrNoiseLine)) return '';
  const kept = lines.filter(line => !isOcrNoiseLine(line));
  return kept.join('\n') + (hasTrailingNewline && kept.length > 0 ? '\n' : '');
}

function ensureOcrNoiseSuppressed() {
  const state = ocrNoiseSuppressionState();
  if (state.installed) return;
  state.installed = true;
  state.stdout = process.stdout.write;
  state.stderr = process.stderr.write;
  state.log = console.log;
  state.warn = console.warn;
  state.error = console.error;

  const filterWrite = (original: typeof process.stdout.write) => function write(this: NodeJS.WriteStream, chunk: unknown, ...args: unknown[]) {
    const text = textFromChunk(chunk);
    if (!text) return (original as any).call(this, chunk, ...args);
    const filtered = filterNativeOcrNoiseText(text);
    if (!filtered) {
      const callback = args.find((arg): arg is () => void => typeof arg === 'function');
      if (callback) process.nextTick(callback);
      return true;
    }
    const nextChunk = typeof chunk === 'string' ? filtered : Buffer.from(filtered, 'utf8');
    return (original as any).call(this, nextChunk, ...args);
  } as typeof process.stdout.write;

  const filterConsole = (original: (...args: any[]) => void) => (...args: any[]) => {
    if (args.length === 1 && typeof args[0] === 'string' && isOcrNoiseLine(args[0])) return;
    original(...args);
  };

  process.stdout.write = filterWrite(state.stdout);
  process.stderr.write = filterWrite(state.stderr);
  console.log = filterConsole(state.log);
  console.warn = filterConsole(state.warn);
  console.error = filterConsole(state.error);
}

type TesseractWorker = { recognize: (image: string) => Promise<any>; terminate: () => Promise<unknown>; setParameters?: (params: Record<string, string>) => Promise<unknown> };

export class TesseractJsProvider implements OcrProvider {
  readonly id = 'tesseract.js';
  private _available: boolean | null = null;
  private worker: TesseractWorker | null = null;
  private workerPromise: Promise<TesseractWorker> | null = null;
  private workerLock: Promise<void> = Promise.resolve();
  private warnings: string[] = [];

  get available(): boolean {
    if (this._available !== null) return this._available;
    // 检查 traineddata 和 tesseract.js 是否可用
    const td = tessdataDir();
    const hasChiSim = fs.existsSync(path.join(td, 'chi_sim.traineddata'));
    try {
      resolvePackage('tesseract.js');
      this._available = hasChiSim;
    } catch {
      this._available = false;
    }
    return this._available;
  }

  async recognize(input: { data: Uint8Array; width: number; height: number; channels?: number; filePath?: string }): Promise<OcrResult> {
    let pngPath: string;
    let tmpDir: string | null = null;
    let width = input.width;
    let height = input.height;

    // 如果传了 filePath，直接使用；否则 raw pixels → PNG
    if (input.filePath && fs.existsSync(input.filePath)) {
      pngPath = input.filePath;
      const dimensions = await this.readImageDimensions(pngPath);
      width = dimensions?.width ?? width;
      height = dimensions?.height ?? height;
    } else {
      const sharpMod = await resolveAndImport('sharp');
      const sharpFn = (sharpMod as any).default ?? sharpMod;
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
      pngPath = path.join(tmpDir, 'input.png');

      const channels = input.channels ?? 3;
      await sharpFn(Buffer.from(input.data), {
        raw: { width: input.width, height: input.height, channels },
      })
        .removeAlpha().normalize().linear(3.0, -150)
        .withMetadata({ density: 288 })
        .png().toFile(pngPath);
    }

    if (this.isTooSmallForOcr(width, height)) {
      return { text: '', confidence: 0, regions: [], warnings: [`image too small for OCR: ${width}x${height}`] };
    }

    try {
      ensureOcrNoiseSuppressed();
      let unlock!: () => void;
      const nextLock = new Promise<void>(resolve => { unlock = resolve; });
      const currentLock = this.workerLock;
      this.workerLock = currentLock.then(() => nextLock).catch(() => nextLock);
      await currentLock;
      
      let result;
      try {
        const worker = await this.getWorker();
        result = await this.recognizeWithTimeout(worker, pngPath);
      } finally {
        unlock();
      }

      const text = (result.data.text ?? '').trim();
      const lines = (result.data.lines ?? []) as Array<{
        text?: string; confidence?: number;
        bbox?: { x0: number; y0: number; x1: number; y1: number };
      }>;

      const regions: OcrRegion[] = lines
        .filter((l) => l.text?.trim())
        .map((l) => ({
          text: l.text!.trim(),
          confidence: l.confidence ?? 0,
          box: {
            x: l.bbox?.x0 ?? 0,
            y: l.bbox?.y0 ?? 0,
            width: (l.bbox?.x1 ?? 0) - (l.bbox?.x0 ?? 0),
            height: (l.bbox?.y1 ?? 0) - (l.bbox?.y0 ?? 0),
          },
        }));

      return { text, confidence: result.data.confidence ?? 0, regions, warnings: this.getWarnings() };
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  getWarnings(): string[] {
    return [...new Set(this.warnings)].slice(-20);
  }

  private pushWarning(message: string) {
    const text = message.trim();
    if (!text || isOcrNoiseLine(text)) return;
    this.warnings.push(text);
    if (this.warnings.length > 50) this.warnings = this.warnings.slice(-50);
  }

  private async recognizeWithTimeout(worker: TesseractWorker, imagePath: string) {
    const timeoutMs = 120_000;
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        worker.recognize(imagePath),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`OCR recognition timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      await this.resetWorker().catch(() => undefined);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async resetWorker() {
    const worker = this.worker;
    this.worker = null;
    this.workerPromise = null;
    if (worker) await worker.terminate();
  }

  private async readImageDimensions(filePath: string): Promise<{ width: number; height: number } | undefined> {
    try {
      const sharpMod = await resolveAndImport('sharp');
      const sharpFn = (sharpMod as any).default ?? sharpMod;
      const metadata = await sharpFn(filePath).metadata();
      const width = Number(metadata.width ?? 0);
      const height = Number(metadata.height ?? 0);
      return width > 0 && height > 0 ? { width, height } : undefined;
    } catch {
      return undefined;
    }
  }

  private isTooSmallForOcr(width: number, height: number): boolean {
    return width < 8 || height < 8 || width * height < 128;
  }

  private async getWorker(): Promise<TesseractWorker> {
    if (this.worker) return this.worker;
    if (!this.workerPromise) {
      this.workerPromise = this.createReusableWorker().catch(error => {
        this.workerPromise = null;
        throw error;
      });
    }
    this.worker = await this.workerPromise;
    return this.worker;
  }

  private async createReusableWorker(): Promise<TesseractWorker> {
    const tessMod = await resolveAndImport('tesseract.js');
    const { createWorker, OEM, setLogging } = tessMod as any;
    if (typeof setLogging === 'function') setLogging(false);
    const worker = await createWorker('chi_sim', OEM?.LSTM_ONLY ?? 1, {
      langPath: tessdataDir(),
      gzip: false,
      logger: () => undefined,
      errorHandler: (error: unknown) => {
        let message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
        if (!message) { try { message = JSON.stringify(error); } catch { message = String(error); } }
        this.pushWarning(message);
      },
    }) as TesseractWorker;
    if (typeof worker.setParameters === 'function') {
      await worker.setParameters({ preserve_interword_spaces: '0', user_defined_dpi: '300' });
    }
    return worker;
  }


  async dispose(): Promise<void> {
    let unlock!: () => void;
    const nextLock = new Promise<void>(resolve => { unlock = resolve; });
    const currentLock = this.workerLock;
    this.workerLock = currentLock.then(() => nextLock).catch(() => nextLock);
    await currentLock;
    try {
      await this.resetWorker();
    } finally {
      unlock();
    }
  }
}

// ─── OCR 分栏阅读顺序重排 ─────────────────────────────────────
//
// paddleocr.js 的 processRecognition 按朴素 y→x 顺序合并检测框，
// 分栏版面会把左右栏落在同一水平带的文本交错拼进同一行，破坏句子与条款边界；
// 表格页的「行 = 一条记录」结构反而依赖该 y 行序。这里用「竖向空白走廊检测」
// 定位分栏切割线，且只对门控确认的「多栏正文页」按栏优先重排，表格页 / 图纸
// 标注页保持原序；「表格样跨界带」保护则拒绝落在数据表格列间隙上的切割
// （该间隙会重复出现「两侧短文本同行」的模式，正文栏间隙至少一侧为长文本）；
// 重排结果再做字符多重集校验（不丢字、不重复，仅允许换序），校验失败回退
// 原始文本。参数先验自图纸 + 正文混合语料的实测定标；输出行合并阈值按
// 「同行错位上限 < 阈值 < 相邻行距下限」的实测区间取 0.35，页面判别
// （表格样跨界带计数 / 行片段长度门控）保持宽松合并（0.6）下的既有标定。

const OCR_COLUMN_REFLOW = {
  /** 行内分段阈值：max(行高中位数 × factor, 图宽 × ratio) */
  segmentGapHeightFactor: 2.2,
  segmentGapWidthRatio: 0.03,
  /** 输出行合并阈值：相邻 box y 差 ≤ max(4, 平均行高 × factor) 视为同一视觉行；
      实测同行错位 ≤14px（行高 105）、相邻行距 ≥34px（行高 69），取 0.35 分离 */
  lineMergeHeightFactor: 0.35,
  /** 判别用块合并阈值（表格样跨界带计数 / 行片段长度门控）：保持宽松合并下的既有标定 */
  blockMergeHeightFactor: 0.6,
  /** 竖向走廊判据：x 网格点「无检测框覆盖」的 y 桶占比阈值 */
  corridorClearRatio: 0.6,
  /** 走廊最小宽度（px）与相邻走廊合并间隔（px） */
  minCorridorWidth: 60,
  corridorMergeGap: 16,
  /** 最多切割数与切割间距下限 max(px, 图宽 × ratio) */
  maxCuts: 3,
  minCutDistance: 100,
  minCutDistanceRatio: 0.03,
  /** 每条切割须保证各栏 box 数下限与质量占比下限 */
  minColumnBoxes: 4,
  minColumnMassShare: 0.05,
  /** 走廊检测分辨率：y 分桶数与 x 网格步长（px） */
  yBuckets: 16,
  xGridStep: 2,
  /** 表格样跨界带判据：切割两侧贴靠 box 距离窗口（px）、短文本阈值（去空白字符数）、拒绝所需最小带数 */
  tableNearDelta: 800,
  tableShortTextLength: 16,
  minTableLikeBands: 4,
  /** 应用门控：box 数下限、行片段长度中位/均值下限（表格页 / 标注页在此被拦截） */
  minBoxes: 24,
  minMedianSegmentLength: 13,
  minAverageSegmentLength: 25,
} as const;

interface OcrTextLine {
  segments: OcrRegion[][];
}

export interface OcrColumnReflowResult {
  text: string;
  regions: OcrRegion[];
}

function stripOcrWhitespace(text: string): string {
  return text.replace(/\s+/gu, '');
}

function sameCharacterMultiset(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (a === b) return true;
  return [...a].sort().join('') === [...b].sort().join('');
}

function medianNumber(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function segmentGapForOcrBoxes(boxes: readonly OcrRegion[], imageWidth: number): number {
  const heights = boxes.map(region => region.box.height).filter(height => Number.isFinite(height) && height > 0);
  return Math.max(
    medianNumber(heights) * OCR_COLUMN_REFLOW.segmentGapHeightFactor,
    imageWidth * OCR_COLUMN_REFLOW.segmentGapWidthRatio,
  );
}

/** y 邻近归组分行（mergeHeightFactor 控制合并粒度）；行内按 x 排序，间距超过 segmentGap 的拆为独立段 */
function buildOcrTextLines(
  boxes: readonly OcrRegion[],
  segmentGap: number,
  mergeHeightFactor: number = OCR_COLUMN_REFLOW.lineMergeHeightFactor,
): OcrTextLine[] {
  if (!boxes.length) return [];
  const sorted = [...boxes].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const lines: OcrTextLine[] = [];
  let current: OcrRegion[] = [sorted[0]!];
  let averageHeight = Math.max(1, sorted[0]!.box.height);
  const flush = () => {
    const raw = [...current].sort((a, b) => a.box.x - b.box.x);
    const segments: OcrRegion[][] = [[raw[0]!]];
    for (let i = 1; i < raw.length; i++) {
      const segment = segments[segments.length - 1]!;
      const previous = segment[segment.length - 1]!;
      const gap = raw[i]!.box.x - (previous.box.x + previous.box.width);
      if (gap > segmentGap) segments.push([]);
      segments[segments.length - 1]!.push(raw[i]!);
    }
    lines.push({ segments });
  };
  for (let i = 1; i < sorted.length; i++) {
    const previous = current[current.length - 1]!;
    if (Math.abs(sorted[i]!.box.y - previous.box.y) <= Math.max(4, averageHeight * mergeHeightFactor)) {
      current.push(sorted[i]!);
      averageHeight = current.reduce((sum, region) => sum + region.box.height, 0) / current.length;
    } else {
      flush();
      current = [sorted[i]!];
      averageHeight = Math.max(1, sorted[i]!.box.height);
    }
  }
  flush();
  return lines;
}

/**
 * 表格样跨界带计数：同一 y 行带内，切割线两侧最贴靠 box 均为短文本的带数量。
 * 数据表格的列间隙会重复出现「两侧短文本同行」的模式（成行记录）；
 * 正文栏间隙 / 图签字段边界至多单发一条，不足以触发拒绝。
 */
function countTableLikeBands(bands: readonly OcrRegion[][], cut: number): number {
  let count = 0;
  for (const band of bands) {
    let leftNear: OcrRegion | null = null;
    let rightNear: OcrRegion | null = null;
    for (const region of band) {
      const rightEdge = region.box.x + region.box.width;
      if (rightEdge <= cut) {
        if (!leftNear || rightEdge > leftNear.box.x + leftNear.box.width) leftNear = region;
      } else if (region.box.x >= cut) {
        if (!rightNear || region.box.x < rightNear.box.x) rightNear = region;
      }
    }
    if (!leftNear || !rightNear) continue;
    const gapLeft = cut - (leftNear.box.x + leftNear.box.width);
    const gapRight = rightNear.box.x - cut;
    if (gapLeft > OCR_COLUMN_REFLOW.tableNearDelta || gapRight > OCR_COLUMN_REFLOW.tableNearDelta) continue;
    if (
      stripOcrWhitespace(leftNear.text).length <= OCR_COLUMN_REFLOW.tableShortTextLength &&
      stripOcrWhitespace(rightNear.text).length <= OCR_COLUMN_REFLOW.tableShortTextLength
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * 竖向空白走廊 → 栏切割位置。
 * 把页面 y 方向分成若干桶，统计每个 x 网格点「无任何检测框覆盖」的桶占比；
 * 占比超过阈值的连续 x 区间即候选走廊，取走廊中线为切割线；
 * 切割须保证各栏 box 数 / 质量占比下限、切割间距下限，最多 maxCuts 条；
 * 落在数据表格列间隙上的切割（表格样跨界带重复出现）被拒绝，保护表格行结构。
 */
function detectOcrColumnCuts(boxes: readonly OcrRegion[], imageWidth: number): number[] {
  if (boxes.length < 16) return [];
  const ys = boxes.map(region => region.box.y).filter(Number.isFinite);
  if (!ys.length) return [];
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const ySpan = Math.max(1, yMax - yMin);
  const bucketCount = OCR_COLUMN_REFLOW.yBuckets;
  const step = OCR_COLUMN_REFLOW.xGridStep;
  const gridLength = Math.ceil(imageWidth / step) + 2;
  const bucketOf = (y: number) => Math.min(bucketCount - 1, Math.max(0, Math.floor(((y - yMin) / ySpan) * bucketCount)));
  const bucketHasBoxes = new Array<boolean>(bucketCount).fill(false);
  const covered = Array.from({ length: bucketCount }, () => new Uint8Array(gridLength));
  for (const region of boxes) {
    if (!Number.isFinite(region.box.x) || !Number.isFinite(region.box.y)) continue;
    const firstBucket = bucketOf(region.box.y);
    const lastBucket = bucketOf(region.box.y + Math.max(region.box.height, 1));
    const x0 = Math.max(0, Math.floor(region.box.x / step));
    const x1 = Math.min(gridLength - 1, Math.ceil((region.box.x + Math.max(region.box.width, 1)) / step));
    for (let bucket = firstBucket; bucket <= lastBucket; bucket++) {
      bucketHasBoxes[bucket] = true;
      covered[bucket]!.fill(1, x0, x1);
    }
  }
  const clearFraction = new Float64Array(gridLength);
  for (let x = 0; x < gridLength; x++) {
    let clear = 0;
    let total = 0;
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      if (!bucketHasBoxes[bucket]) continue;
      total++;
      if (!covered[bucket]![x]) clear++;
    }
    clearFraction[x] = total ? clear / total : 0;
  }
  const corridors: Array<{ left: number; right: number; width: number }> = [];
  let start = -1;
  for (let x = 0; x <= gridLength; x++) {
    const clear = x < gridLength && clearFraction[x]! >= OCR_COLUMN_REFLOW.corridorClearRatio;
    if (clear) {
      if (start < 0) start = x;
      continue;
    }
    if (start >= 0) {
      corridors.push({ left: start * step, right: x * step, width: (x - start) * step });
      start = -1;
    }
  }
  const merged: Array<{ left: number; right: number; width: number }> = [];
  for (const corridor of corridors) {
    const last = merged[merged.length - 1];
    if (last && corridor.left - last.right <= OCR_COLUMN_REFLOW.corridorMergeGap) {
      last.right = corridor.right;
      last.width = last.right - last.left;
    } else {
      merged.push({ ...corridor });
    }
  }
  const candidates = merged
    .filter(corridor => corridor.width >= OCR_COLUMN_REFLOW.minCorridorWidth)
    .sort((a, b) => b.width - a.width);
  const minCutDistance = Math.max(OCR_COLUMN_REFLOW.minCutDistance, imageWidth * OCR_COLUMN_REFLOW.minCutDistanceRatio);
  const bands = buildOcrTextLines(boxes, segmentGapForOcrBoxes(boxes, imageWidth), OCR_COLUMN_REFLOW.blockMergeHeightFactor).map(line => line.segments.flat());
  const accepted: number[] = [];
  for (const corridor of candidates) {
    if (accepted.length >= OCR_COLUMN_REFLOW.maxCuts) break;
    const cut = (corridor.left + corridor.right) / 2;
    if (accepted.some(existing => Math.abs(existing - cut) < minCutDistance)) continue;
    if (countTableLikeBands(bands, cut) >= OCR_COLUMN_REFLOW.minTableLikeBands) continue;
    const trialCuts = [...accepted, cut].sort((a, b) => a - b);
    const bounds = [0, ...trialCuts, imageWidth];
    let viable = true;
    for (let i = 0; i + 1 < bounds.length; i++) {
      let count = 0;
      for (const region of boxes) {
        if (!Number.isFinite(region.box.x)) continue;
        const center = region.box.x + region.box.width / 2;
        if (center >= bounds[i]! && center < bounds[i + 1]!) count++;
      }
      if (count < OCR_COLUMN_REFLOW.minColumnBoxes || count / boxes.length < OCR_COLUMN_REFLOW.minColumnMassShare) {
        viable = false;
        break;
      }
    }
    if (viable) accepted.push(cut);
  }
  return accepted.sort((a, b) => a - b);
}

/** 按切割线分栏后，栏内先 y 后 x 重新装配文本与区域顺序 */
function assembleColumnMajorOcrText(boxes: readonly OcrRegion[], cuts: readonly number[], segmentGap: number): OcrColumnReflowResult {
  const bounds = [0, ...cuts, Infinity];
  const chunks: string[] = [];
  const regions: OcrRegion[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const column = boxes.filter(region => {
      if (!Number.isFinite(region.box.x)) return false;
      const center = region.box.x + region.box.width / 2;
      return center >= bounds[i]! && center < bounds[i + 1]!;
    });
    if (!column.length) continue;
    const lines = buildOcrTextLines(column, segmentGap);
    chunks.push(lines.map(line => line.segments.map(segment => segment.map(region => region.text).join(' ')).join(' ')).join('\n'));
    for (const line of lines) {
      for (const segment of line.segments) {
        for (const region of segment) regions.push(region);
      }
    }
  }
  return { text: chunks.join('\n\n'), regions };
}

/**
 * 对「多栏正文页」按栏重排 OCR 阅读顺序。
 * 不适用或校验失败时返回 null（调用方保留原始文本）：
 * - box 数不足、未检出栏切割、行片段过短（表格页 / 图纸标注页在此被拦截）；
 * - 重排后字符多重集与原文本不一致（丢字 / 重复，理论不可达，防御性兜底）。
 */
export function reflowOcrRegionsByColumns(regions: readonly OcrRegion[], imageWidth: number, originalText: string): OcrColumnReflowResult | null {
  if (!Number.isFinite(imageWidth) || imageWidth <= 0) return null;
  const boxes = regions.filter(region => region.text.trim());
  if (boxes.length < OCR_COLUMN_REFLOW.minBoxes) return null;
  const segmentGap = segmentGapForOcrBoxes(boxes, imageWidth);
  const cuts = detectOcrColumnCuts(boxes, imageWidth);
  if (!cuts.length) return null;
  const segmentLengths = buildOcrTextLines(boxes, segmentGap, OCR_COLUMN_REFLOW.blockMergeHeightFactor)
    .flatMap(line => line.segments.map(segment => stripOcrWhitespace(segment.map(region => region.text).join(' ')).length));
  const medianLength = medianNumber(segmentLengths);
  const averageLength = segmentLengths.length ? segmentLengths.reduce((sum, length) => sum + length, 0) / segmentLengths.length : 0;
  if (medianLength < OCR_COLUMN_REFLOW.minMedianSegmentLength || averageLength < OCR_COLUMN_REFLOW.minAverageSegmentLength) return null;
  const reflowed = assembleColumnMajorOcrText(boxes, cuts, segmentGap);
  if (!sameCharacterMultiset(stripOcrWhitespace(reflowed.text), stripOcrWhitespace(originalText))) return null;
  return reflowed;
}

// ─── PaddleOCR.js（ONNX Runtime PP-OCRv6，模型随 npm 包发布） ──────

function paddleModelDir(): string {
  // env 显式指定时信任用户配置（目录缺失由 available 检查暴露，不回退掩盖错误）
  if (process.env.CUSTOMIZE_PADDLE_MODEL_DIR) return process.env.CUSTOMIZE_PADDLE_MODEL_DIR;
  return path.resolve(knowledgeDir, '..', '..', 'models', 'paddleocr');
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

/**
 * ONNX Runtime session 的 intra-op 线程数分档（实测驱动的**无损**提速）。
 *
 * 三个 session（检测 / 识别 / 方向分类）的模型体量与最优线程数差异极大，而 paddleocr 不暴露
 * session 配置，走的是 ORT 默认（≈物理核数）。实测（10 核 macOS，A2 图纸切片 200DPI）：
 * 默认时进程占用 7.4 核、每片 322ms，其中大量时间消耗在线程自旋而非有效计算；
 * 分档为 det=4 / rec=4 / ori=1 后每片 254ms（**1.27×**），进程占用降到 3.9 核，
 * 且**逐切片识别文本与默认配置逐字节一致**。ori 是 1MB 的方向分类小模型，给满线程纯属浪费。
 *
 * 分档只在单路执行时有意义：实测多实例并行（2/3/4/5 路）在任意线程配比下都不优于单路
 * （0.78~1.16×），因为 ORT 的 intra-op 线程池已把有效计算吃满，再加路数只是互相争抢。
 */
const OCR_SESSION_THREADS_DEFAULT = { det: 4, rec: 4, ori: 1 } as const;

export interface OcrSessionThreads {
  det: number;
  rec: number;
  ori: number;
}

/**
 * 解析线程分档配置（`CUSTOMIZE_KB_OCR_THREADS="det=4,rec=4,ori=1"`）。
 * 非法/缺失项保留默认值：任一档位写错都不影响其余档位，也不影响识别质量。
 * `off`/`default`/`0` = 关闭分档，完全回到 ORT 默认线程（排障与 A/B 对照用）。
 */
export function resolveOcrSessionThreads(raw: string | undefined = process.env.CUSTOMIZE_KB_OCR_THREADS): OcrSessionThreads | undefined {
  if (raw && ['off', 'default', 'none', '0'].includes(raw.trim().toLowerCase())) return undefined;
  const resolved: OcrSessionThreads = { ...OCR_SESSION_THREADS_DEFAULT };
  if (!raw) return resolved;
  for (const part of raw.split(',')) {
    const [rawKey, rawValue] = part.split('=');
    const key = rawKey?.trim().toLowerCase();
    if (key !== 'det' && key !== 'rec' && key !== 'ori') continue;
    const value = Number(rawValue?.trim());
    if (Number.isFinite(value) && value > 0) resolved[key] = Math.floor(value);
  }
  return resolved;
}

/**
 * 按模型 buffer **引用**给各 session 注入 intra-op 线程数，返回包装后的 ort 模块。
 *
 * 用引用相等而非模型文件大小/调用顺序来识别模型：库的三个 create 调用原样透传我们传入的
 * ArrayBuffer（paddleocr 的 initialize() 直接 `InferenceSession.create(modelBuffer)`），
 * 因此换模型代次（v5↔v6）、换 preset 都不会失配。
 * 认不出的 buffer（库新增 session 等）按原样创建，不做任何假设。
 */
export function withOcrSessionThreads(
  ort: Record<string, unknown>,
  plan: Array<{ modelBuffer: ArrayBuffer | undefined; intraOpNumThreads: number }>,
): Record<string, unknown> {
  const InferenceSession = ort?.InferenceSession as { create?: (...args: unknown[]) => unknown } | undefined;
  if (!InferenceSession || typeof InferenceSession.create !== 'function') return ort;
  const threadsByBuffer = new Map<ArrayBuffer, number>();
  for (const item of plan) {
    if (item.modelBuffer) threadsByBuffer.set(item.modelBuffer, item.intraOpNumThreads);
  }
  const wrapped = new Proxy(InferenceSession, {
    get(target, prop, receiver) {
      if (prop !== 'create') return Reflect.get(target, prop, receiver);
      return (model: unknown, options?: Record<string, unknown>) => {
        const intraOpNumThreads = threadsByBuffer.get(model as ArrayBuffer);
        if (intraOpNumThreads === undefined) return (target as any).create(model, options);
        return (target as any).create(model, { ...(options ?? {}), intraOpNumThreads });
      };
    },
  });
  return { ...ort, InferenceSession: wrapped };
}

type PaddleOcrServiceLike = {
  recognize(input: { width: number; height: number; data: Uint8Array }, options?: unknown): Promise<unknown>;
  processRecognition(recognition: unknown, options?: unknown): { text?: string; confidence?: number; lines?: Array<Array<{ text?: string; confidence?: number; box?: unknown }>> };
  destroy(): Promise<unknown>;
};

/**
 * PP-OCR 推理引擎（paddleocr.js + onnxruntime-node）。
 * 模型二进制位于 models/paddleocr 并随 npm 包发布，下游用户零配置；
 * 对 CAD 单线矢量字、扫描图纸等 tesseract 弱项场景识别质量显著更高。
 * 识别失败时自动降级 tesseract.js（兜底不丢失解析能力）。
 *
 * 模型文件按目录内容自动选择（v6 优先），preset 必须与权重匹配 —— 见 paddle-model-select.ts。
 */
export class PaddleOcrJsProvider implements OcrProvider {
  readonly id = 'paddleocr.js';
  private _available: boolean | null = null;
  private _selection: PaddleModelSelection | null | undefined;
  private _availabilityNote: string | undefined;
  private service: PaddleOcrServiceLike | null = null;
  private servicePromise: Promise<PaddleOcrServiceLike> | null = null;
  private serviceLock: Promise<void> = Promise.resolve();
  private warnings: string[] = [];
  private tesseractFallback: TesseractJsProvider | null = null;

  get availabilityNote(): string | undefined {
    void this.available;
    return this._availabilityNote;
  }

  /** 模型目录内的三元组选择结果；不可用时为 null */
  private get selection(): PaddleModelSelection | null {
    if (this._selection === undefined) {
      let selection: PaddleModelSelection | null;
      try {
        selection = selectPaddleModelFiles(paddleModelDir());
      } catch {
        selection = null; // 目录不可读等异常按「不可用」处理，由 availabilityNote 说明原因
      }
      this._selection = selection;
      for (const warning of selection?.warnings ?? []) this.pushWarning(warning);
    }
    return this._selection;
  }

  get available(): boolean {
    if (this._available !== null) return this._available;
    try {
      resolvePackage('paddleocr');
      resolvePackage('onnxruntime-node');
    } catch (error) {
      this._available = false;
      this._availabilityNote = `paddleocr/onnxruntime-node 依赖不可用（${error instanceof Error ? error.message : String(error)}）`;
      return false;
    }
    const selection = this.selection;
    this._available = selection !== null;
    if (!selection) {
      this._availabilityNote = `模型目录 ${paddleModelDir()} 中未找到完整的「检测+识别+字典」模型文件，请执行 scripts/download-paddleocr-models.sh`;
    }
    return this._available;
  }

  getWarnings(): string[] {
    return [...new Set(this.warnings)].slice(-20);
  }

  private pushWarning(message: string) {
    const text = message.trim();
    if (!text) return;
    this.warnings.push(text);
    if (this.warnings.length > 50) this.warnings = this.warnings.slice(-50);
  }

  async recognize(input: OcrInput, options?: OcrRecognizeOptions): Promise<OcrResult> {
    try {
      return await this.recognizeWithPaddle(input, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushWarning(`paddleocr.js 推理失败（${message}），已降级 tesseract.js`);
      const fallback = this.tesseractFallback ??= new TesseractJsProvider();
      if (fallback.available) return fallback.recognize(input);
      throw error;
    }
  }

  private async recognizeWithPaddle(input: OcrInput, options?: OcrRecognizeOptions): Promise<OcrResult> {
    let width = input.width;
    let height = input.height;
    let data = input.data;

    if (input.filePath && fs.existsSync(input.filePath)) {
      const sharpMod = await resolveAndImport('sharp');
      const sharpFn = (sharpMod as any).default ?? sharpMod;
      const decoded = await sharpFn(input.filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      width = decoded.info.width;
      height = decoded.info.height;
      data = new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
    }

    if (width < 8 || height < 8 || width * height < 128) {
      return { text: '', confidence: 0, regions: [], warnings: [`image too small for OCR: ${width}x${height}`] };
    }
    if (!data || data.length === 0) {
      return { text: '', confidence: 0, regions: [], warnings: ['paddleocr.js: 无可用像素数据'] };
    }

    // onnxruntime session 并发调用不安全，与 tesseract provider 同样用串行锁
    let unlock!: () => void;
    const nextLock = new Promise<void>(resolve => { unlock = resolve; });
    const currentLock = this.serviceLock;
    this.serviceLock = currentLock.then(() => nextLock).catch(() => nextLock);
    await currentLock;
    try {
      const service = await this.getService();
      const recognition = await this.recognizeWithTimeout(service, { width, height, data }, options);
      // 行置信度过滤发生在行分组之前：不放宽这里的阈值，放宽检测阈值也拿不回低置信度的标注
      const processed = service.processRecognition(recognition, options?.process);
      const processedText = (processed.text ?? '').trim();
      const lineResults = (processed.lines ?? []).flat();
      const regions: OcrRegion[] = lineResults
        .filter(item => item?.text?.trim())
        .map(item => {
          const box = (item.box ?? {}) as Record<string, unknown>;
          const bx = Number(box.x ?? 0);
          const by = Number(box.y ?? 0);
          const bw = Number(box.width ?? 0);
          const bh = Number(box.height ?? 0);
          return {
            text: item.text!.trim(),
            confidence: Number(item.confidence ?? 0),
            box: { x: bx, y: by, width: bw, height: bh },
          };
        });
      // 多栏正文页按栏重排阅读顺序；表格页 / 图纸标注页或校验不通过时保留原始文本
      const reflowed = reflowOcrRegionsByColumns(regions, width, processedText);
      return {
        text: reflowed?.text ?? processedText,
        confidence: Number(processed.confidence ?? 0),
        regions: reflowed?.regions ?? regions,
        warnings: this.getWarnings(),
      };
    } finally {
      unlock();
    }
  }

  private async recognizeWithTimeout(
    service: PaddleOcrServiceLike,
    pixels: { width: number; height: number; data: Uint8Array },
    options?: OcrRecognizeOptions,
  ) {
    const timeoutMs = 180_000;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const recognizeOptions = options?.detection || options?.recognition
        ? { detection: options.detection, recognition: options.recognition }
        : undefined;
      return await Promise.race([
        service.recognize(pixels, recognizeOptions),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`OCR recognition timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      await this.resetService().catch(() => undefined);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async getService(): Promise<PaddleOcrServiceLike> {
    if (this.service) return this.service;
    if (!this.servicePromise) {
      this.servicePromise = this.createService().catch(error => {
        this.servicePromise = null;
        throw error;
      });
    }
    this.service = await this.servicePromise;
    return this.service;
  }

  private async createService(): Promise<PaddleOcrServiceLike> {
    const selection = this.selection;
    if (!selection) throw new Error(this.availabilityNote ?? `未找到可用的 PaddleOCR 模型文件（${paddleModelDir()}）`);

    const paddleMod = await resolveAndImport<Record<string, unknown>>('paddleocr');
    const PaddleOcrService = paddleMod?.PaddleOcrService as { createInstance?: (options: Record<string, unknown>) => Promise<PaddleOcrServiceLike> } | undefined;
    if (!PaddleOcrService || typeof PaddleOcrService.createInstance !== 'function') {
      throw new Error('paddleocr 包缺少 PaddleOcrService.createInstance');
    }
    const rawOrt = await resolveAndImport<Record<string, unknown>>('onnxruntime-node');
    const detModel = fs.readFileSync(selection.detFile);
    const recModel = fs.readFileSync(selection.recFile);
    // 字典末行是空格字符（模型把空格识别为最后一类），trimEnd 会误删；只去掉尾随空行
    const dictLines = parseDictionaryLines(fs.readFileSync(selection.dictFile, 'utf8'));
    // 字典与识别模型的类别数必须匹配：不匹配时库不会报错，只会稳定输出「看似通顺的乱码」，
    // 因此这里主动校验并把差异写进告警（模型目录里混放了不同代次的字典时最容易踩到）
    this.verifyDictionaryMatchesPreset(paddleMod, selection, dictLines.length);

    // buffer 具名持有：线程分档按**引用相等**识别 session（见 withOcrSessionThreads）
    const detBuffer = toArrayBuffer(detModel);
    const recBuffer = toArrayBuffer(recModel);
    let orientationBuffer: ArrayBuffer | undefined;
    const options: Record<string, unknown> = {
      ort: rawOrt,
      modelPreset: selection.preset,
      detection: { modelBuffer: detBuffer },
      recognition: { modelBuffer: recBuffer, charactersDictionary: dictLines },
    };
    // 方向分类（= PaddleOCR use_angle_cls）：检测裁剪与识别之间纠正 0°/180° 文本。
    // 只纠正 0°/180°，不覆盖 90° 竖排；模型缺失时整体仍然可用，只是没有这项增强。
    if (selection.orientationFile) {
      try {
        orientationBuffer = toArrayBuffer(fs.readFileSync(selection.orientationFile));
        options.textlineOrientation = {
          modelBuffer: orientationBuffer,
          threshold: ORIENTATION_THRESHOLD,
        };
      } catch (error) {
        this.pushWarning(`方向分类模型加载失败（${error instanceof Error ? error.message : String(error)}），已跳过方向纠正`);
      }
    }

    const threads = resolveOcrSessionThreads();
    if (threads) {
      options.ort = withOcrSessionThreads(rawOrt, [
        { modelBuffer: detBuffer, intraOpNumThreads: threads.det },
        { modelBuffer: recBuffer, intraOpNumThreads: threads.rec },
        { modelBuffer: orientationBuffer, intraOpNumThreads: threads.ori },
      ]);
    }
    try {
      return await PaddleOcrService.createInstance(options);
    } catch (error) {
      // 线程分档注入失败（库/运行时校验口径变化等）绝不能连坐引擎选择：provider 的 recognize
      // 兜底是降级 tesseract.js（识别质量明显更差），一个提速优化不该把主引擎弄丢。
      if (options.ort === rawOrt) throw error;
      this.pushWarning(`OCR 线程分档注入失败（${error instanceof Error ? error.message : String(error)}），已回退默认线程重建`);
      return PaddleOcrService.createInstance({ ...options, ort: rawOrt });
    }
  }

  /**
   * 校验字典行数与预设声明的输出类别数是否匹配（不匹配时识别结果会整体错位，且库要到
   * 第一次识别才报错）。库的契约是 `字典长度 >= 输出类别数 - 1`，上限即输出类别数：
   * 字典带末尾空格项时为「类别数 - 1」，不带时为「类别数」，两种都合法。
   * v5 官方字典文件含空格项（18385 ↔ 类别 18385 走上限），v6 官方字符表不含空格项
   * （18708 + 空格 = 18709 ↔ 类别 18710 走下限）—— 因此必须按区间判断，逐值比对会误报。
   */
  private verifyDictionaryMatchesPreset(paddleMod: Record<string, unknown>, selection: PaddleModelSelection, dictLineCount: number): void {
    try {
      const getModelPreset = paddleMod.getModelPreset as
        ((name: string) => { dictionary?: { recognitionOutputClasses?: number; dictionaryLength?: number } }) | undefined;
      const dictionary = getModelPreset?.(selection.preset)?.dictionary;
      const classes = dictionary?.recognitionOutputClasses;
      if (typeof classes !== 'number' || classes <= 0) return;
      if (dictLineCount < classes - 1 || dictLineCount > classes) {
        this.pushWarning(`字典行数 ${dictLineCount} 超出预设 ${selection.preset} 的输出类别数 ${classes} 允许范围（${classes - 1}~${classes}），识别结果可能错乱；请确认模型目录内检测/识别/字典属于同一代次`);
      }
    } catch {
      // 校验失败不影响识别主流程
    }
  }

  private async resetService() {
    // 只置空引用，不调 service.destroy()：paddleocr.js 的 destroy 内部调 onnxruntime
    // InferenceSession.release()，释放底层 OrtSession 后 JS 对象仍存活，GC 触发
    // InferenceSessionWrap 析构会再次释放同一指针 → double free → SIGABRT
    // （libc++abi/malloc: pointer being freed was not allocated）。
    // 正确做法是把 session 生命周期交给 GC 单次回收。
    this.service = null;
    this.servicePromise = null;
  }

  async dispose(): Promise<void> {
    let unlock!: () => void;
    const nextLock = new Promise<void>(resolve => { unlock = resolve; });
    const currentLock = this.serviceLock;
    this.serviceLock = currentLock.then(() => nextLock).catch(() => nextLock);
    await currentLock;
    try {
      await this.resetService();
      if (this.tesseractFallback) await this.tesseractFallback.dispose();
    } finally {
      unlock();
    }
  }
}

// ─── 工厂 ───────────────────────────────────────────────────────

export async function createOcrProvider(): Promise<OcrProvider> {
  // 优先 PP-OCR ONNX 引擎（质量显著优于 tesseract，模型随包发布）；不可用时回退 tesseract.js，
  // 并把降级原因挂到 availabilityNote 上，调用方据此写出可见告警（历史上这里是静默降级，
  // 模型目录放错代次会导致图纸/表格识别质量悄悄变差且无人察觉）
  const paddle = new PaddleOcrJsProvider();
  if (paddle.available) return paddle;

  const tess = new TesseractJsProvider();
  if (tess.available) {
    if (paddle.availabilityNote) {
      // tesseract provider 不可变，降级说明通过包装属性透出
      Object.defineProperty(tess, 'availabilityNote', { value: paddle.availabilityNote, enumerable: false });
    }
    return tess;
  }

  const td = tessdataDir();
  throw new Error(
    `OCR 不可用。请将 chi_sim.traineddata 和 eng.traineddata 放置到 ${td}，` +
    '并确保 tesseract.js 已安装。'
  );
}
