// @customize-agent/tools — 媒体处理工具
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
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
    this.ensureNotKnowledgeBase(filePath);
    const full = resolveSafe(filePath, this.cwd);
    const buffer = await fs.readFile(full);
    const text = [...buffer.toString('utf-8')].filter(ch => {
      const code = ch.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    }).join('');
    return text.slice(0, 60_000) || 'No extractable text found.';
  }

  async extractPdfText(filePath: string): Promise<string> {
    this.ensureNotKnowledgeBase(filePath);
    const full = resolveSafe(filePath, this.cwd);
    const mod = await import('pdf-parse');
    const pdfParse = (mod as unknown as { default?: (data: Buffer) => Promise<{ text: string }> }).default ?? (mod as unknown as (data: Buffer) => Promise<{ text: string }>);
    const result = await pdfParse(await fs.readFile(full));
    return result.text.slice(0, 60_000) || 'No text found in PDF.';
  }

  async extractDocxText(filePath: string): Promise<string> {
    this.ensureNotKnowledgeBase(filePath);
    const result = await mammoth.extractRawText({ path: resolveSafe(filePath, this.cwd) });
    return result.value.slice(0, 60_000) || 'No text found in DOCX.';
  }

  async extractXlsxData(filePath: string): Promise<string> {
    this.ensureNotKnowledgeBase(filePath);
    const workbook = XLSX.readFile(resolveSafe(filePath, this.cwd));
    const sheets: Record<string, unknown[]> = {};
    for (const name of workbook.SheetNames) sheets[name] = XLSX.utils.sheet_to_json(workbook.Sheets[name]!);
    return JSON.stringify(sheets, null, 2).slice(0, 60_000);
  }

  async ocrImage(filePath: string): Promise<string> {
    this.ensureNotKnowledgeBase(filePath);
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
    this.ensureNotKnowledgeBase(input);
    this.ensureNotKnowledgeBase(output);
    const ffmpeg = resolveBinary('ffmpeg');
    const finalOutput = resolveSafe(output, this.cwd);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'customize-agent-convert-'));
    const tmpOutput = path.join(tmpDir, path.basename(finalOutput));
    try {
      const res = await execa(ffmpeg, ['-y', '-i', resolveSafe(input, this.cwd), tmpOutput], { reject: false });
      if (res.exitCode !== 0) throw new Error(res.stderr || 'ffmpeg conversion failed');
      await fs.mkdir(path.dirname(finalOutput), { recursive: true });
      await fs.copyFile(tmpOutput, finalOutput);
      return `Converted ${input} -> ${output}`;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async compressImage(input: string, output: string): Promise<string> {
    this.ensureNotKnowledgeBase(input);
    this.ensureNotKnowledgeBase(output);
    const finalOutput = resolveSafe(output, this.cwd);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'customize-agent-image-'));
    const tmpOutput = path.join(tmpDir, path.basename(finalOutput));
    try {
      await sharp(resolveSafe(input, this.cwd)).jpeg({ quality: 80 }).toFile(tmpOutput);
      await fs.mkdir(path.dirname(finalOutput), { recursive: true });
      await fs.copyFile(tmpOutput, finalOutput);
      return `Compressed image ${input} -> ${output}`;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async generateThumbnail(input: string, output: string): Promise<string> {
    this.ensureNotKnowledgeBase(input);
    this.ensureNotKnowledgeBase(output);
    const finalOutput = resolveSafe(output, this.cwd);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'customize-agent-thumb-'));
    const tmpOutput = path.join(tmpDir, path.basename(finalOutput));
    try {
      await sharp(resolveSafe(input, this.cwd)).resize(320, 320, { fit: 'inside' }).toFile(tmpOutput);
      await fs.mkdir(path.dirname(finalOutput), { recursive: true });
      await fs.copyFile(tmpOutput, finalOutput);
      return `Generated thumbnail ${input} -> ${output}`;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async mediaProbe(filePath: string): Promise<string> {
    this.ensureNotKnowledgeBase(filePath);
    const full = resolveSafe(filePath, this.cwd);
    const ffprobe = resolveBinary('ffprobe');
    const res = await execa(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', full], { reject: false });
    if (res.exitCode !== 0) {
      const stat = await fs.stat(full);
      return JSON.stringify({ path: filePath, size: stat.size, isFile: stat.isFile() });
    }
    return res.stdout || '';
  }

  private ensureNotKnowledgeBase(filePath: string): void {
    if (filePath.split(/[\\/]+/u).includes('knowledgeBase')) {
      throw new Error('knowledgeBase 是知识库原始文件投放目录，智能体工具不能直接读取；请通过知识库检索或 Web Dashboard 管理');
    }
  }
}
