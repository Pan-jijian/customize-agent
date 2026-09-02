import * as path from 'node:path';
import JSZip from 'jszip';
import type { StoredChunk } from '@customize-agent/knowledge';

/** 导出容量上限：防止一次导出过多文件或超大文本拖垮服务 */
export const EXPORT_LIMITS = {
  maxFiles: 500,
  maxTotalChars: 60_000_000,
} as const;

/** 相邻块重叠查找窗口上限（chunker 最大 overlap 120 token ≈ 480 字符，留余量） */
const MAX_OVERLAP_CHARS = 600;
/** 重叠长度低于该阈值不裁剪，避免误伤自然重复的短句 */
const MIN_OVERLAP_CHARS = 16;

/** Z 函数：返回字符串每个位置与其自身前缀的最长公共前缀长度 */
function zArray(s: string): number[] {
  const z = new Array<number>(s.length).fill(0);
  let left = 0;
  let right = 0;
  for (let i = 1; i < s.length; i++) {
    if (i <= right) z[i] = Math.min(right - i + 1, z[i - left] ?? 0);
    while (i + (z[i] ?? 0) < s.length && s[i + (z[i] ?? 0)] === s[z[i] ?? 0]) {
      z[i] = (z[i] ?? 0) + 1;
    }
    if (i + (z[i] ?? 0) - 1 > right) {
      left = i;
      right = i + (z[i] ?? 0) - 1;
    }
  }
  return z;
}

/**
 * 消除相邻分块之间的重复重叠：分块器会把前一块末尾的一小段文本带到下一块开头，
 * 直接拼接会让同一段落出现两次。这里寻找"既是下一块前缀、又是上一块后缀"的
 * 最长公共串并裁掉，纯字符串匹配，不涉及语义判断。
 */
export function trimChunkOverlap(prev: string, next: string): string {
  const tail = prev.slice(-MAX_OVERLAP_CHARS);
  const head = next.slice(0, MAX_OVERLAP_CHARS);
  if (!tail || !head) return next;
  const joined = `${head}\u0000${tail}`;
  const z = zArray(joined);
  const tailStart = head.length + 1;
  let overlap = 0;
  for (let i = tailStart; i < joined.length; i++) {
    if (i + z[i] === joined.length && z[i] > overlap) overlap = z[i];
  }
  if (overlap >= MIN_OVERLAP_CHARS) {
    return next.slice(overlap).replace(/^[\r\n]+/u, '');
  }
  return next;
}

/**
 * 将已解析分块按顺序拼接为可正常阅读的完整文本：
 * 保留块内原有段落结构，块间用空行过渡，相邻块重叠去重。
 */
export function mergeChunksToReadableText(chunks: Array<Pick<StoredChunk, 'content'>>): string {
  const texts = chunks.map(chunk => String(chunk.content ?? '').trim()).filter(Boolean);
  const merged: string[] = [];
  for (const text of texts) {
    const prev = merged[merged.length - 1];
    merged.push(prev ? trimChunkOverlap(prev, text) : text);
  }
  return merged.join('\n\n').trim();
}

/** 由源文件相对路径生成 zip 内 txt 条目路径：保留目录结构，扩展名替换为 .txt，重名时追加序号 */
export function txtEntryNameFor(relativePath: string, usedNames: Set<string>): string {
  const dir = path.posix.dirname(relativePath);
  const base = path.posix.basename(relativePath);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  let name = `${stem}.txt`;
  let suffix = 2;
  while (usedNames.has(dir === '.' ? name : `${dir}/${name}`)) name = `${stem}-${suffix++}.txt`;
  const entry = dir === '.' ? name : `${dir}/${name}`;
  usedNames.add(entry);
  return entry;
}

/** 单文件下载用的纯文件名（不带目录） */
export function txtFileNameFor(relativePath: string): string {
  return txtEntryNameFor(relativePath, new Set()).split('/').pop() ?? 'export.txt';
}

/** 将多个文件的解析文本打包为 zip（内部每个源文件一个 .txt，保留相对目录结构） */
export async function buildExportZip(entries: Array<{ relativePath: string; text: string }>): Promise<Buffer> {
  const zip = new JSZip();
  const used = new Set<string>();
  for (const entry of entries) {
    zip.file(txtEntryNameFor(entry.relativePath, used), entry.text);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** 生成导出压缩包文件名：知识库解析内容-YYYYMMDD-HHmmss.zip */
export function exportZipFileName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `知识库解析内容-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;
}
