// @customize-agent/tools — 媒体处理工具
import * as fs from 'fs/promises';
import sharp from 'sharp';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { createWorker } from 'tesseract.js';
import { execa } from 'execa';
import { resolveSafe } from '../core/path-utils.js';
import { resolveBinary } from '../core/platform/binary.js';

export class MediaTools {
  constructor(private cwd: string) {}

  async extractText(filePath: string): Promise<string> {
    const full = resolveSafe(filePath, this.cwd);
    const buffer = await fs.readFile(full);
    const text = [...buffer.toString('utf-8')].filter(ch => {
      const code = ch.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    }).join('');
    return text.slice(0, 60_000) || 'No extractable text found.';
  }

  async extractPdfText(filePath: string): Promise<string> {
    const full = resolveSafe(filePath, this.cwd);
    const mod = await import('pdf-parse');
    const pdfParse = (mod as unknown as { default?: (data: Buffer) => Promise<{ text: string }> }).default ?? (mod as unknown as (data: Buffer) => Promise<{ text: string }>);
    const result = await pdfParse(await fs.readFile(full));
    return result.text.slice(0, 60_000) || 'No text found in PDF.';
  }

  async extractDocxText(filePath: string): Promise<string> {
    const result = await mammoth.extractRawText({ path: resolveSafe(filePath, this.cwd) });
    return result.value.slice(0, 60_000) || 'No text found in DOCX.';
  }

  async extractXlsxData(filePath: string): Promise<string> {
    const workbook = XLSX.readFile(resolveSafe(filePath, this.cwd));
    const sheets: Record<string, unknown[]> = {};
    for (const name of workbook.SheetNames) sheets[name] = XLSX.utils.sheet_to_json(workbook.Sheets[name]!);
    return JSON.stringify(sheets, null, 2).slice(0, 60_000);
  }

  async ocrImage(filePath: string): Promise<string> {
    const worker = await createWorker('eng+chi_sim');
    try {
      const result = await worker.recognize(resolveSafe(filePath, this.cwd));
      return result.data.text.trim() || 'No text recognized.';
    } finally {
      await worker.terminate();
    }
  }

  async transcribeAudio(filePath: string): Promise<string> {
    const info = await this.mediaProbe(filePath);
    return `Audio transcription model is not bundled. Media metadata:\n${info}`;
  }

  async videoMetadata(filePath: string): Promise<string> {
    return this.mediaProbe(filePath);
  }

  async convertFile(input: string, output: string): Promise<string> {
    const ffmpeg = resolveBinary('ffmpeg');
    const res = await execa(ffmpeg, ['-y', '-i', resolveSafe(input, this.cwd), resolveSafe(output, this.cwd)], { reject: false });
    if (res.exitCode !== 0) throw new Error(res.stderr || 'ffmpeg conversion failed');
    return `Converted ${input} -> ${output}`;
  }

  async compressImage(input: string, output: string): Promise<string> {
    await sharp(resolveSafe(input, this.cwd)).jpeg({ quality: 80 }).toFile(resolveSafe(output, this.cwd));
    return `Compressed image ${input} -> ${output}`;
  }

  async generateThumbnail(input: string, output: string): Promise<string> {
    await sharp(resolveSafe(input, this.cwd)).resize(320, 320, { fit: 'inside' }).toFile(resolveSafe(output, this.cwd));
    return `Generated thumbnail ${input} -> ${output}`;
  }

  private async mediaProbe(filePath: string): Promise<string> {
    const full = resolveSafe(filePath, this.cwd);
    const ffprobe = resolveBinary('ffprobe');
    const res = await execa(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', full], { reject: false });
    if (res.exitCode !== 0) {
      const stat = await fs.stat(full);
      return JSON.stringify({ path: filePath, size: stat.size, isFile: stat.isFile() });
    }
    return res.stdout || '';
  }
}
