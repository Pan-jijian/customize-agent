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

export interface OcrProvider {
  readonly id: string;
  readonly available: boolean;
  recognize(input: { data: Uint8Array; width: number; height: number; channels?: number; filePath?: string }): Promise<OcrResult>;
  getWarnings?(): string[];
  dispose(): Promise<void>;
}

// ─── 路径工具 ───────────────────────────────────────────────────

const knowledgeDir = path.dirname(fileURLToPath(import.meta.url));
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

// ─── 工厂 ───────────────────────────────────────────────────────

export async function createOcrProvider(): Promise<OcrProvider> {
  const tess = new TesseractJsProvider();
  if (tess.available) return tess;

  const td = tessdataDir();
  throw new Error(
    `OCR 不可用。请将 chi_sim.traineddata 和 eng.traineddata 放置到 ${td}，` +
    '并确保 tesseract.js 已安装。'
  );
}
