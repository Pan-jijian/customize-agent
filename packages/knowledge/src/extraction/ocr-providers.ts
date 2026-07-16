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
}

export interface OcrProvider {
  readonly id: string;
  readonly available: boolean;
  recognize(input: { data: Uint8Array; width: number; height: number; channels?: number; filePath?: string }): Promise<OcrResult>;
  dispose(): Promise<void>;
}

// ─── 路径工具 ───────────────────────────────────────────────────

const knowledgeDir = path.dirname(fileURLToPath(import.meta.url));

function tessdataDir(): string {
  if (process.env.TESSDATA_PREFIX) return process.env.TESSDATA_PREFIX;
  const pkg = path.resolve(knowledgeDir, '..', '..', 'models', 'tessdata');
  if (fs.existsSync(pkg)) return pkg;
  return pkg;
}

// ─── Tesseract.js Provider（主 OCR 引擎，跨平台） ──────────────

export class TesseractJsProvider implements OcrProvider {
  readonly id = 'tesseract.js';
  private _available: boolean | null = null;

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
    const tessMod = await resolveAndImport('tesseract.js');
    const { createWorker } = tessMod as any;

    let pngPath: string;
    let tmpDir: string | null = null;

    // 如果传了 filePath，直接使用；否则 raw pixels → PNG
    if (input.filePath && fs.existsSync(input.filePath)) {
      pngPath = input.filePath;
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

    try {
      // tesseract.js worker（数组形式 languages）
      const worker = await createWorker(['chi_sim', 'eng'], 1, {
        langPath: tessdataDir(),
        gzip: false,
      });

      try {
        const result = await worker.recognize(pngPath);
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

        return { text, confidence: result.data.confidence ?? 0, regions };
      } finally {
        await worker.terminate();
      }
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  async dispose(): Promise<void> {}
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
