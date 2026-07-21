// @customize-agent/tools — 媒体处理工具
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import sharp from 'sharp';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import * as Tesseract from 'tesseract.js';
import { execa } from 'execa';
import { resolveSafe } from '../core/path-utils.js';
import { resolveBinary } from '../core/platform/binary.js';

const OCR_NATIVE_NOISE_PATTERNS = [/^Image too small to scale!!/u, /^Line cannot be recognized!!$/u];
const OCR_NOISE_SUPPRESSION_KEY = Symbol.for('customize-agent.ocr-noise-suppression');
type OcrNoiseSuppressionState = { depth: number; stdout?: typeof process.stdout.write; stderr?: typeof process.stderr.write };

function ocrNoiseSuppressionState() {
  const globalState = globalThis as typeof globalThis & { [OCR_NOISE_SUPPRESSION_KEY]?: OcrNoiseSuppressionState };
  globalState[OCR_NOISE_SUPPRESSION_KEY] ??= { depth: 0 };
  return globalState[OCR_NOISE_SUPPRESSION_KEY];
}

function isNativeOcrNoise(chunk: unknown): boolean {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : typeof chunk === 'string' ? chunk : '';
  if (!text) return false;
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(line => OCR_NATIVE_NOISE_PATTERNS.some(pattern => pattern.test(line)));
}

async function suppressNativeOcrNoise<T>(operation: () => Promise<T>): Promise<T> {
  const state = ocrNoiseSuppressionState();
  if (state.depth === 0) {
    state.stdout = process.stdout.write;
    state.stderr = process.stderr.write;
    const filter = (original: typeof process.stdout.write) => function write(this: NodeJS.WriteStream, chunk: unknown, ...args: unknown[]) {
      if (isNativeOcrNoise(chunk)) {
        const callback = args.find((arg): arg is () => void => typeof arg === 'function');
        if (callback) process.nextTick(callback);
        return true;
      }
      return (original as any).call(this, chunk, ...args);
    } as typeof process.stdout.write;
    process.stdout.write = filter(state.stdout);
    process.stderr.write = filter(state.stderr);
  }
  state.depth += 1;
  try {
    return await operation();
  } finally {
    state.depth -= 1;
    if (state.depth === 0 && state.stdout && state.stderr) {
      process.stdout.write = state.stdout;
      process.stderr.write = state.stderr;
      state.stdout = undefined;
      state.stderr = undefined;
    }
  }
}

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
    if (typeof Tesseract.setLogging === 'function') Tesseract.setLogging(false);
    const worker = await Tesseract.createWorker('eng+chi_sim', undefined, { logger: () => undefined });
    try {
      const result = await suppressNativeOcrNoise(() => worker.recognize(resolveSafe(filePath, this.cwd)));
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
