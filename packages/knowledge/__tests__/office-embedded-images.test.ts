import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MIN_EMBEDDED_IMAGE_BYTES,
  carveImageCandidates,
  carveJpeg,
  carvePng,
  extractEmbeddedOfficeImages,
} from '../src/extraction/office-embedded-images.js';
import { resolveAndImport } from '../src/extraction/module-resolver.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-office-images-'));

/**
 * 生成一张真实可解码、且体积超过最小阈值的 PNG。
 * 用噪声填充：纯色图会被 PNG 压到 1KB 以下，直接命中「图标/装饰」过滤，测不出真实场景。
 */
async function makePng(width: number, height: number, seed = 1): Promise<Buffer> {
  const sharpMod = await resolveAndImport('sharp');
  const sharpFn = (sharpMod as { default?: unknown }).default ?? sharpMod;
  const raw = Buffer.alloc(width * height * 3);
  let state = seed >>> 0;
  for (let i = 0; i < raw.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    raw[i] = state >>> 24;
  }
  return await (sharpFn as (input: Buffer, opts: unknown) => { png: () => { toBuffer: () => Promise<Buffer> } })(
    raw, { raw: { width, height, channels: 3 } },
  ).png().toBuffer();
}

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理 */ }
});

// ─── 结构走查 ────────────────────────────────────────────────

describe('carvePng / carveJpeg', () => {
  it('PNG 走到 IEND 取完整字节', async () => {
    const png = await makePng(120, 80);
    const stream = Buffer.concat([Buffer.from('前缀噪声'), png, Buffer.from('后缀噪声')]);
    const carved = carvePng(stream, stream.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    expect(carved?.equals(png)).toBe(true);
  });

  it('PNG 结构不完整时返回 null（不会切出半个文件）', async () => {
    const png = await makePng(120, 80);
    const truncated = png.subarray(0, Math.floor(png.length * 0.6));
    expect(carvePng(truncated, 0)).toBeNull();
  });

  it('JPEG 走到 EOI 取完整字节', () => {
    // 最小 JPEG 骨架：SOI + APP0 段 + EOI
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xff, 0xd9,
    ]);
    expect(carveJpeg(jpeg, 0)?.equals(jpeg)).toBe(true);
  });
});

describe('carveImageCandidates', () => {
  it('从混杂字节流中定位图片并在图片内部不重复命中', async () => {
    const a = await makePng(120, 80, 1);
    const b = await makePng(90, 90, 2);
    const stream = Buffer.concat([Buffer.alloc(64, 0x11), a, Buffer.alloc(32, 0x22), b, Buffer.alloc(16, 0x33)]);
    const found = carveImageCandidates(stream);
    expect(found).toHaveLength(2);
    expect(found[0]!.data.equals(a)).toBe(true);
    expect(found[1]!.data.equals(b)).toBe(true);
  });

  it('小于阈值的碎片被丢弃', async () => {
    const tiny = await makePng(8, 8, 3);
    expect(tiny.length).toBeLessThan(MIN_EMBEDDED_IMAGE_BYTES);
    expect(carveImageCandidates(Buffer.concat([Buffer.alloc(32, 0x11), tiny]))).toHaveLength(0);
  });
});

// ─── 整文件提取 ──────────────────────────────────────────────

describe('extractEmbeddedOfficeImages', () => {
  it('docx 取 word/media 下的位图；矢量图与图标跳过', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const big = await makePng(300, 200, 4);
    const icon = await makePng(24, 24, 5);
    zip.file('word/document.xml', '<w:document/>');
    zip.file('word/media/image1.png', big);
    zip.file('word/media/icon.png', icon);
    zip.file('word/media/vector.emf', Buffer.alloc(50_000, 0x7f)); // 矢量图元文件：不取
    const target = path.join(tmpDir, 'with-media.docx');
    fs.writeFileSync(target, await zip.generateAsync({ type: 'nodebuffer' }));

    const images = await extractEmbeddedOfficeImages(target);
    expect(images).toHaveLength(1);
    expect(images[0]!.width).toBe(300);
    expect(images[0]!.height).toBe(200);
  });

  it('无内嵌图片的文档返回空数组', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    const target = path.join(tmpDir, 'no-media.docx');
    fs.writeFileSync(target, await zip.generateAsync({ type: 'nodebuffer' }));
    expect(await extractEmbeddedOfficeImages(target)).toEqual([]);
  });

  it('非 ZIP 非 OLE 的文件返回空数组而不抛异常', async () => {
    const target = path.join(tmpDir, 'garbage.docx');
    fs.writeFileSync(target, Buffer.alloc(20_000, 0x5a));
    expect(await extractEmbeddedOfficeImages(target)).toEqual([]);
  });

  it('体积不足的图片被跳过', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('word/media/small.png', Buffer.alloc(100, 0x00));
    const target = path.join(tmpDir, 'small.docx');
    fs.writeFileSync(target, await zip.generateAsync({ type: 'nodebuffer' }));
    expect(await extractEmbeddedOfficeImages(target)).toEqual([]);
  });
});
