/**
 * Office 文档内嵌图片提取。
 *
 * 背景（缺陷修复）：此前 Office 文档只解析 XML 正文，`word/media` 之类的内嵌图片被整体丢弃。
 * 实测真实资料里这类图片承载着关键内容 —— 一份 445KB 的招标补疑 docx 里 421KB 是两张图片，
 * 其中一张是完整的施工图（道路横断面、钢筋网布置、剖面详图加整套技术说明）；另一份
 * 2.7MB 的清单补疑 docx 有 47 张图；一份 10.2MB 的旧版 .doc 补疑有 98 张有效图片、9.7MB。
 * 这些内容在知识库里完全不存在（检索不到、生成文档时用不上、导出拿不到）。
 *
 * 两条提取路径：
 * - **OpenXML（.docx/.xlsx/.pptx）**：本质是 ZIP，图片在 `word|xl|ppt/media/` 下，精确取用。
 * - **旧版 OLE/CFB（.doc/.xls/.ppt）**：图片以原始 PNG/JPEG 字节存放在 `Data` 流里，
 *   但索引结构（OfficeArt BSE/Blip）在 WPS 等非微软实现里并不规范 —— 实测同一份文件
 *   按标准 BSE 遍历一记录都匹配不上，而按图片签名定位能完整取回。因此这里走
 *   「签名定位 + 结构走查（PNG 走 chunk 到 IEND、JPEG 走段到 EOI）+ 解码校验」，
 *   校验不通过的一律丢弃，宁可漏也不要塞进坏图。
 */

import * as fs from 'node:fs';
import { resolveAndImport } from './module-resolver.js';

export interface ExtractedImage {
  /** 来源标识（ZIP 内路径或 Data 流偏移），用于写入溯源信息 */
  source: string;
  data: Buffer;
  width: number;
  height: number;
}

/** 单文件最多 OCR 的内嵌图片数：防止超大文档把索引任务拖成小时级 */
export const MAX_EMBEDDED_IMAGES = 120;
/** 小于该体积的图片视为图标/装饰，不做 OCR */
export const MIN_EMBEDDED_IMAGE_BYTES = 4096;
/** 解码后任一边小于该值视为图标/装饰 */
export const MIN_EMBEDDED_IMAGE_SIDE = 60;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 只取位图：EMF/WMF 等矢量图元文件 OCR 引擎不支持，取了也没用 */
const ZIP_MEDIA_RE = /^(?:word|xl|ppt)\/media\/[^/]+\.(?:png|jpe?g|gif|bmp|tiff?|webp)$/iu;

/** PNG：从签名处按 chunk 走到 IEND，返回完整图片字节；结构不完整返回 null */
export function carvePng(buffer: Buffer, start: number): Buffer | null {
  let offset = start + 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > 50_000_000 || offset + 12 + length > buffer.length) return null;
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'IEND') return buffer.subarray(start, offset + 12);
    offset += 12 + length;
  }
  return null;
}

/** JPEG：从签名处按段长度走到 EOI，返回完整图片字节；结构不完整返回 null */
export function carveJpeg(buffer: Buffer, start: number): Buffer | null {
  let offset = start + 2;
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1]!;
    if (marker === 0xd9) return buffer.subarray(start, offset + 2);
    if (marker === 0xff) { offset += 1; continue; } // 填充字节
    if (marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; } // RSTn 无长度字段
    if (offset + 4 > buffer.length) return null;
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return null;
}

/** 在字节流里按签名定位所有候选图片并走查结构，返回完整字节块（未做解码校验） */
export function carveImageCandidates(buffer: Buffer): Array<{ offset: number; data: Buffer }> {
  const out: Array<{ offset: number; data: Buffer }> = [];
  for (let i = 0; i + 3 < buffer.length; i++) {
    // 先做逐字节首字符判断再比对签名：Data 流可达数十 MB，避免每个偏移都分配 subarray
    let carved: Buffer | null = null;
    if (buffer[i] === 0x89 && buffer[i + 1] === 0x50 && buffer[i + 2] === 0x4e && buffer[i + 3] === 0x47) {
      if (buffer.subarray(i, i + 8).equals(PNG_SIGNATURE)) carved = carvePng(buffer, i);
    } else if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) {
      carved = carveJpeg(buffer, i);
    }
    if (!carved || carved.length < MIN_EMBEDDED_IMAGE_BYTES) continue;
    out.push({ offset: i, data: carved });
    i += carved.length - 1; // 跳过本图，避免在图片数据内部重复命中
  }
  return out;
}

/** sharp 解码校验：拿不到尺寸或尺寸过小即判定为噪声/图标，丢弃 */
async function decodeValidated(data: Buffer, source: string): Promise<ExtractedImage | undefined> {
  try {
    const sharpMod = await resolveAndImport('sharp');
    const sharpFn = (sharpMod as { default?: unknown }).default ?? sharpMod;
    const metadata = await (sharpFn as (input: Buffer) => { metadata: () => Promise<{ width?: number; height?: number }> })(data).metadata();
    const width = Number(metadata.width ?? 0);
    const height = Number(metadata.height ?? 0);
    if (width < MIN_EMBEDDED_IMAGE_SIDE || height < MIN_EMBEDDED_IMAGE_SIDE) return undefined;
    return { source, data, width, height };
  } catch {
    return undefined;
  }
}

/** OpenXML ZIP：取 word|xl|ppt/media 下的位图 */
async function extractFromZip(filePath: string): Promise<Buffer[]> {
  const jszipMod = await resolveAndImport('jszip');
  const JSZip = (jszipMod as Record<string, unknown>).default ?? jszipMod;
  const zip = await (JSZip as {
    loadAsync: (data: Buffer) => Promise<{ files: Record<string, { dir: boolean; name: string; async: (type: 'nodebuffer') => Promise<Buffer> }> }>;
  }).loadAsync(fs.readFileSync(filePath));
  const names = Object.keys(zip.files)
    .filter(name => ZIP_MEDIA_RE.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })); // media/image10 排在 image2 之后
  const out: Buffer[] = [];
  for (const name of names) {
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    try {
      out.push(await entry.async('nodebuffer'));
    } catch {
      // 单个条目读取失败不影响其余图片
    }
  }
  return out;
}

/** 旧版 OLE/CFB：从 Data 流（无则整文件）抠图 */
async function extractFromCompoundFile(filePath: string): Promise<Buffer[]> {
  const raw = fs.readFileSync(filePath);
  let streams: Buffer[] = [];
  try {
    // xlsx 复用其内置的 CFB 解析器，不额外引入依赖（本包为 ESM，须走 resolveAndImport 而非 require）
    const xlsxMod = await resolveAndImport<Record<string, unknown>>('xlsx');
    const CFB = xlsxMod?.CFB as {
      read: (data: Buffer, opts: { type: string }) => unknown;
      find: (cfb: unknown, path: string) => { content?: Buffer } | undefined;
    } | undefined;
    if (CFB) {
      const cfb = CFB.read(raw, { type: 'buffer' });
      // 图片存放在 Data 流；个别实现也可能写进 WordDocument/Workbook 流，一并纳入
      for (const stream of ['/Data', '/WordDocument', '/Workbook']) {
        const entry = CFB.find(cfb, stream);
        if (entry?.content) streams.push(Buffer.from(entry.content));
      }
    }
  } catch {
    // CFB 解析失败时退化为整文件扫描
  }
  if (streams.length === 0) streams = [raw];
  return streams.flatMap(stream => carveImageCandidates(stream).map(item => item.data));
}

/**
 * 提取 Office 文档里的内嵌位图并做解码校验。
 * @param limit 最多返回多少张（按文件内出现顺序）
 */
export async function extractEmbeddedOfficeImages(filePath: string, limit = MAX_EMBEDDED_IMAGES): Promise<ExtractedImage[]> {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const isOpenXml = ['.docx', '.xlsx', '.pptx'].includes(ext);
  let raw: Buffer[];
  try {
    raw = isOpenXml ? await extractFromZip(filePath) : await extractFromCompoundFile(filePath);
  } catch {
    return [];
  }

  const images: ExtractedImage[] = [];
  for (const [index, data] of raw.entries()) {
    if (images.length >= limit) break;
    if (data.length < MIN_EMBEDDED_IMAGE_BYTES) continue;
    // ZIP 路径已按位图扩展名过滤；CFB 抠出来的只可能是 PNG/JPEG
    const decoded = await decodeValidated(data, `${isOpenXml ? 'media' : 'ole-data'}#${index}`);
    if (decoded) images.push(decoded);
  }
  return images;
}
