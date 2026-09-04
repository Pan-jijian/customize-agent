import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOcrProvider, PaddleOcrJsProvider, TesseractJsProvider } from '../src/extraction/ocr-providers.js';

// ─── 设置 ────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ocr-providers-'));

afterEach(() => {
  delete process.env.CUSTOMIZE_PADDLE_MODEL_DIR;
});

// ─── PaddleOcrJsProvider 可用性 ─────────────────────────────

describe('PaddleOcrJsProvider availability', () => {
  it('模型与依赖齐全时 available = true', () => {
    const provider = new PaddleOcrJsProvider();
    expect(provider.available).toBe(true);
  });

  it('模型目录缺失时 available = false 且不抛异常', () => {
    process.env.CUSTOMIZE_PADDLE_MODEL_DIR = path.join(tmpDir, 'missing-models');
    const provider = new PaddleOcrJsProvider();
    expect(provider.available).toBe(false);
  });

  it('模型文件不全时 available = false', () => {
    const partial = path.join(tmpDir, 'partial-models');
    fs.mkdirSync(partial, { recursive: true });
    fs.writeFileSync(path.join(partial, 'PP-OCRv5_mobile_det_infer.onnx'), 'x');
    process.env.CUSTOMIZE_PADDLE_MODEL_DIR = partial;
    const provider = new PaddleOcrJsProvider();
    expect(provider.available).toBe(false);
  });
});

// ─── 工厂选择 ────────────────────────────────────────────────

describe('createOcrProvider 引擎选择', () => {
  it('默认优先 PP-OCRv5 ONNX 引擎', async () => {
    const provider = await createOcrProvider();
    expect(provider.id).toBe('paddleocr.js');
    await provider.dispose();
  });

  it('paddle 模型缺失时回退 tesseract.js', async () => {
    process.env.CUSTOMIZE_PADDLE_MODEL_DIR = path.join(tmpDir, 'missing-models');
    const provider = await createOcrProvider();
    expect(provider.id).toBe('tesseract.js');
    await provider.dispose();
  });
});

// ─── TesseractJsProvider 回归 ────────────────────────────────

describe('TesseractJsProvider 回归', () => {
  it('available 且可正常 dispose', async () => {
    const provider = new TesseractJsProvider();
    expect(provider.available).toBe(true);
    await provider.dispose();
  });
});

// ─── 推理 smoke（PP-OCRv5 对清晰中文印刷体的识别） ───────────

describe('PaddleOcrJsProvider 推理 smoke', () => {
  it('识别清晰中文印刷体图片', async () => {
    const { default: sharp } = await import('sharp');
    const sample = '通信排管工程设计说明';
    const svg = `<svg width="800" height="120" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="120" fill="white"/>
      <text x="20" y="80" font-family="PingFang SC, Heiti SC, sans-serif" font-size="48" fill="black">${sample}</text>
    </svg>`;
    const imgPath = path.join(tmpDir, 'sample.png');
    await sharp(Buffer.from(svg)).png().toFile(imgPath);

    const provider = new PaddleOcrJsProvider();
    const result = await provider.recognize({ data: new Uint8Array(0), width: 0, height: 0, filePath: imgPath });
    await provider.dispose();

    expect(result.text).toContain('通信排管工程设计说明');
    expect(result.confidence).toBeGreaterThan(0.8);
  }, 120_000);
});
