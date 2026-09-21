import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOcrProvider, PaddleOcrJsProvider, TesseractJsProvider, reflowOcrRegionsByColumns, resolveOcrSessionThreads, withOcrSessionThreads, type OcrRegion } from '../src/extraction/ocr-providers.js';
import { MIN_ONNX_BYTES, PADDLE_MODEL_FILES } from '../src/extraction/paddle-model-select.js';

// ─── 设置 ────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ocr-providers-'));

afterEach(() => {
  delete process.env.CUSTOMIZE_PADDLE_MODEL_DIR;
});

/**
 * 建一个模型目录。ONNX 需达到最小体积门槛（拦占位文件），字典不需要体积门槛。
 * 文件名固定为随包发布的 v6 配置。
 */
function makeModelDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const weights = Buffer.alloc(MIN_ONNX_BYTES + 1);
  fs.writeFileSync(path.join(dir, PADDLE_MODEL_FILES.detection), weights);
  fs.writeFileSync(path.join(dir, PADDLE_MODEL_FILES.recognition), weights);
  fs.writeFileSync(path.join(dir, PADDLE_MODEL_FILES.dictionary), 'x');
  return dir;
}

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

  it('按下载脚本安装的 PP-OCRv6 目录可用（曾经的静默降级缺陷）', () => {
    process.env.CUSTOMIZE_PADDLE_MODEL_DIR = makeModelDir('v6-models');
    const provider = new PaddleOcrJsProvider();
    expect(provider.available).toBe(true);
    expect(provider.availabilityNote).toBeUndefined();
  });

  it('只有旧代次（v5）模型文件时判为不可用：不再保留旧模型兼容', () => {
    const v5Dir = path.join(tmpDir, 'v5-only');
    fs.mkdirSync(v5Dir, { recursive: true });
    for (const name of ['PP-OCRv5_mobile_det_infer.onnx', 'PP-OCRv5_mobile_rec_infer.onnx', 'ppocrv5_dict.txt']) {
      fs.writeFileSync(path.join(v5Dir, name), Buffer.alloc(MIN_ONNX_BYTES + 1));
    }
    process.env.CUSTOMIZE_PADDLE_MODEL_DIR = v5Dir;
    const provider = new PaddleOcrJsProvider();
    expect(provider.available).toBe(false);
    expect(provider.availabilityNote).toContain('download-paddleocr-models.sh');
  });

  it('不可用时给出 availabilityNote 说明原因', () => {
    process.env.CUSTOMIZE_PADDLE_MODEL_DIR = path.join(tmpDir, 'missing-models');
    const provider = new PaddleOcrJsProvider();
    expect(provider.available).toBe(false);
    expect(provider.availabilityNote).toContain('模型');
  });
});

// ─── 工厂选择 ────────────────────────────────────────────────

describe('createOcrProvider 引擎选择', () => {
  it('默认优先 PaddleOCR ONNX 引擎', async () => {
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

// ─── 推理 smoke（PP-OCRv6 对清晰中文印刷体的识别） ───────────

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

// ─── ONNX session 线程分档（无损提速的注入点，见 withOcrSessionThreads 注释） ───

describe('resolveOcrSessionThreads', () => {
  it('未配置时返回实测默认分档 det=4 / rec=4 / ori=1', () => {
    expect(resolveOcrSessionThreads('')).toEqual({ det: 4, rec: 4, ori: 1 });
  });

  it('off/default/none/0 关闭分档（回到 ORT 默认线程，供排障与 A/B 对照）', () => {
    for (const raw of ['off', 'DEFAULT', ' none ', '0']) {
      expect(resolveOcrSessionThreads(raw)).toBeUndefined();
    }
  });

  it('按 det/rec/ori 覆盖，未提到的档位保留默认', () => {
    expect(resolveOcrSessionThreads('rec=8')).toEqual({ det: 4, rec: 8, ori: 1 });
    expect(resolveOcrSessionThreads('det=2, rec=2 ,ori=2')).toEqual({ det: 2, rec: 2, ori: 2 });
  });

  it('非法项逐项忽略：拼错一档不影响其余档位，也不会整体失效', () => {
    expect(resolveOcrSessionThreads('det=abc,rec=6')).toEqual({ det: 4, rec: 6, ori: 1 });
    expect(resolveOcrSessionThreads('de=3,rec=-1,ori=0')).toEqual({ det: 4, rec: 4, ori: 1 });
  });

  it('小数向下取整（传给 ORT 的必须是整数）', () => {
    expect(resolveOcrSessionThreads('det=3.9')).toEqual({ det: 3, rec: 4, ori: 1 });
  });

  it('默认读取 CUSTOMIZE_KB_OCR_THREADS 环境变量', () => {
    process.env.CUSTOMIZE_KB_OCR_THREADS = 'det=6';
    try {
      expect(resolveOcrSessionThreads()).toEqual({ det: 6, rec: 4, ori: 1 });
    } finally {
      delete process.env.CUSTOMIZE_KB_OCR_THREADS;
    }
  });
});

describe('withOcrSessionThreads', () => {
  /** 假 ort：记录每次 create 的入参与选项，不真正建 session */
  const makeOrt = () => {
    const created: Array<{ model: unknown; options: Record<string, unknown> | undefined }> = [];
    class FakeInferenceSession {
      static async create(model: unknown, options?: Record<string, unknown>) {
        created.push({ model, options });
        return { model };
      }
    }
    return { ort: { Tensor: class Tensor {}, InferenceSession: FakeInferenceSession }, created };
  };

  it('按 buffer 引用识别 session 并注入线程数，未识别的 buffer 原样创建', async () => {
    const det = new ArrayBuffer(8);
    const rec = new ArrayBuffer(8);
    const ori = new ArrayBuffer(8);
    const unknown = new ArrayBuffer(8);
    const { ort, created } = makeOrt();
    const wrapped = withOcrSessionThreads(ort as never, [
      { modelBuffer: det, intraOpNumThreads: 4 },
      { modelBuffer: rec, intraOpNumThreads: 4 },
      { modelBuffer: ori, intraOpNumThreads: 1 },
    ]);

    await (wrapped.InferenceSession as typeof FakeInferenceSession).create(det, { graphOptimizationLevel: 'all' });
    await (wrapped.InferenceSession as typeof FakeInferenceSession).create(rec);
    await (wrapped.InferenceSession as typeof FakeInferenceSession).create(ori);
    await (wrapped.InferenceSession as typeof FakeInferenceSession).create(unknown);

    // 原有选项保留，仅追加线程数
    expect(created[0]!.options).toEqual({ graphOptimizationLevel: 'all', intraOpNumThreads: 4 });
    expect(created[1]!.options).toEqual({ intraOpNumThreads: 4 });
    expect(created[2]!.options).toEqual({ intraOpNumThreads: 1 });
    // 库新增 session / 其他调用方传入的 buffer：不注入、不改动
    expect(created[3]!.options).toBeUndefined();
  });

  it('Tensor 等其余成员原样透出', () => {
    const { ort } = makeOrt();
    const wrapped = withOcrSessionThreads(ort as never, []);
    expect(wrapped.Tensor).toBe(ort.Tensor);
  });

  it('方向分类模型缺失时该档位不参与注入', async () => {
    const det = new ArrayBuffer(8);
    const { ort, created } = makeOrt();
    const wrapped = withOcrSessionThreads(ort as never, [
      { modelBuffer: det, intraOpNumThreads: 4 },
      { modelBuffer: undefined, intraOpNumThreads: 1 },
    ]);
    await (wrapped.InferenceSession as typeof ort.InferenceSession).create(det);
    expect(created[0]!.options).toEqual({ intraOpNumThreads: 4 });
  });

  it('ort 模块形状不认识时原样返回（不抛异常、不改行为）', () => {
    const odd = { Tensor: class Tensor {} } as never;
    expect(withOcrSessionThreads(odd, [])).toBe(odd);
  });
});

// ─── OCR 分栏重排（多栏正文页重排 / 表格页拦截 / 内容保全兜底） ───

const makeRegion = (text: string, x: number, y: number, width: number, height = 36): OcrRegion => ({
  text,
  confidence: 0.95,
  box: { x, y, width, height },
});

const prose = (side: string, index: number) =>
  `${side}第${String(index).padStart(2, '0')}行的正文内容示例文本，用于验证多栏交错重排逻辑是否正确可靠`;

const stripWhitespace = (value: string) => value.replace(/\s+/gu, '');

const makeTwoColumnRegions = (): OcrRegion[] => {
  const regions: OcrRegion[] = [];
  for (let i = 1; i <= 14; i++) {
    const y = 100 + (i - 1) * 60;
    regions.push(makeRegion(prose('左栏', i), 60, y, 260));
    regions.push(makeRegion(prose('右栏', i), 620, y, 260));
  }
  return regions;
};

describe('reflowOcrRegionsByColumns', () => {
  it('双栏正文页：按栏重排不交错，字符多重集与原文一致', () => {
    const regions = makeTwoColumnRegions();
    const naiveText = regions.map(region => region.text).join('\n');
    const reflowed = reflowOcrRegionsByColumns(regions, 1000, naiveText);
    expect(reflowed).not.toBeNull();
    // 重排后不存在一行同时包含左右栏内容
    for (const line of reflowed!.text.split('\n')) {
      expect(line.includes('左栏') && line.includes('右栏')).toBe(false);
    }
    // 左栏全部行先于右栏首行
    expect(reflowed!.text.indexOf(prose('左栏', 14))).toBeLessThan(reflowed!.text.indexOf(prose('右栏', 1)));
    // 区域顺序与文本顺序一致：左栏 14 个后跟右栏 14 个
    expect(reflowed!.regions).toHaveLength(28);
    expect(reflowed!.regions.slice(0, 14).every(region => region.text.startsWith('左栏'))).toBe(true);
    expect(reflowed!.regions.slice(14).every(region => region.text.startsWith('右栏'))).toBe(true);
    // 无丢字 / 重复（strip 空白后字符多重集相等）
    expect([...stripWhitespace(reflowed!.text)].sort().join('')).toBe([...stripWhitespace(naiveText)].sort().join(''));
  });

  it('同栏相邻行（行距小于宽松合并阈值）：输出保持逐行，名称与编号不跨行错配', () => {
    const regions: OcrRegion[] = [];
    for (let i = 1; i <= 14; i++) regions.push(makeRegion(prose('左栏', i), 60, 100 + (i - 1) * 60, 260, 70));
    // 右栏：每行「名称 + 编号」，行距 40px（> 0.35 × 行高 70 = 24.5，< 0.6 × 70 = 42）
    for (let i = 1; i <= 12; i++) {
      const nn = String(i).padStart(2, '0');
      const y = 100 + (i - 1) * 40;
      regions.push(makeRegion(`名称条目${nn}号规范文件`, 500, y, 120, 70));
      regions.push(makeRegion(`编号${nn}`, 660, y, 80, 70));
    }
    const naiveText = regions.map(region => region.text).join('\n');
    const reflowed = reflowOcrRegionsByColumns(regions, 1000, naiveText);
    expect(reflowed).not.toBeNull();
    const lines = reflowed!.text.split('\n');
    const lineOf = (needle: string) => lines.find(line => line.includes(needle));
    // 12 个名称条目各自成行，未被并入相邻行
    expect(lines.filter(line => /名称条目\d\d号/u.test(line))).toHaveLength(12);
    // 同一行的名称与编号正确配对，不跨行错配
    expect(lineOf('名称条目01')?.includes('编号01')).toBe(true);
    expect(lineOf('名称条目12')?.includes('编号12')).toBe(true);
    expect(lineOf('名称条目01')?.includes('名称条目02')).toBe(false);
    // 栏序：左栏全部行先于右栏首行
    expect(reflowed!.text.indexOf('左栏第14行')).toBeLessThan(reflowed!.text.indexOf('名称条目01'));
  });

  it('单栏正文页：无栏切割，返回 null 保持原序', () => {
    const regions: OcrRegion[] = [];
    for (let i = 1; i <= 26; i++) regions.push(makeRegion(prose('单栏', i), 100, 100 + (i - 1) * 60, 700));
    expect(reflowOcrRegionsByColumns(regions, 1000, regions.map(region => region.text).join('\n'))).toBeNull();
  });

  it('表格页（行片段过短）：门控拦截，返回 null', () => {
    const regions: OcrRegion[] = [];
    for (let i = 1; i <= 12; i++) {
      const y = 80 + (i - 1) * 40;
      regions.push(makeRegion(`R${i}`, 50, y, 40, 24));
      regions.push(makeRegion(`项目名称${i}`, 200, y, 90, 24));
      regions.push(makeRegion(`规格${i}`, 400, y, 80, 24));
    }
    expect(reflowOcrRegionsByColumns(regions, 1000, regions.map(region => region.text).join('\n'))).toBeNull();
  });

  it('内容多重集校验失败：返回 null 回退原文', () => {
    const regions = makeTwoColumnRegions();
    const tampered = regions.map(region => region.text).join('\n').replace('可靠', '可');
    expect(reflowOcrRegionsByColumns(regions, 1000, tampered)).toBeNull();
  });

  it('box 数不足：返回 null', () => {
    const regions: OcrRegion[] = [];
    for (let i = 1; i <= 10; i++) regions.push(makeRegion(prose('左栏', i), 60, 100 + (i - 1) * 60, 260));
    expect(reflowOcrRegionsByColumns(regions, 1000, regions.map(region => region.text).join('\n'))).toBeNull();
  });
});
