import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { ClassifiedFile, FileCategory } from '../types.js';

/** 外部解析器提取结果 */
export interface ExternalExtractionResult {
  text: string;
  metadata?: Record<string, unknown>;
  warnings?: string[];
}

/** 外部解析器接口 */
export interface ExternalExtractor {
  readonly id: string;
  readonly name: string;
  readonly category?: FileCategory;
  readonly formats?: string[];
  readonly extensions?: string[];
  readonly available: boolean;
  supports(file: ClassifiedFile): boolean;
  extract(file: ClassifiedFile): ExternalExtractionResult;
  describe(): ExternalExtractorCapability;
}

/** 外部解析器能力描述 */
export interface ExternalExtractorCapability {
  id: string;
  name: string;
  category?: FileCategory;
  formats?: string[];
  extensions?: string[];
  available: boolean;
  kind: 'command';
}

/** 命令行外部解析器配置选项 */
export interface CommandExternalExtractorOptions {
  id: string;
  name: string;
  command: string;
  args?: string[];
  category?: FileCategory;
  formats?: string[];
  extensions?: string[];
  timeoutMs?: number;
}

/** 命令行外部解析器，通过调用外部命令提取文件内容 */
export class CommandExternalExtractor implements ExternalExtractor {
  readonly id: string;
  readonly name: string;
  readonly category?: FileCategory;
  readonly formats?: string[];
  readonly extensions?: string[];
  readonly available: boolean;

  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;

  constructor(options: CommandExternalExtractorOptions) {
    this.id = options.id;
    this.name = options.name;
    this.command = options.command;
    this.args = options.args ?? ['{file}'];
    this.category = options.category;
    this.formats = options.formats;
    this.extensions = options.extensions?.map(ext => ext.toLowerCase());
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.available = this.checkAvailable();
  }

  supports(file: ClassifiedFile): boolean {
    if (this.category && file.category !== this.category) return false;
    if (this.formats && !this.formats.includes(file.format)) return false;
    if (this.extensions && !this.extensions.includes(path.extname(file.absolutePath).toLowerCase())) return false;
    return true;
  }

  extract(file: ClassifiedFile): ExternalExtractionResult {
    const args = this.args.map(arg => this.interpolate(arg, file));
    const result = spawnSync(this.command, args, {
      encoding: 'utf8',
      timeout: this.timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${this.name} exited with ${result.status}: ${result.stderr}`);
    }

    const stdout = result.stdout.trim();
    if (!stdout) return { text: '', metadata: { externalExtractor: this.id } };

    try {
      const parsed = JSON.parse(stdout) as ExternalExtractionResult;
      return {
        text: parsed.text ?? stdout,
        metadata: { externalExtractor: this.id, ...(parsed.metadata ?? {}) },
        warnings: parsed.warnings,
      };
    } catch {
      return {
        text: stdout,
        metadata: { externalExtractor: this.id, externalOutput: 'text' },
      };
    }
  }

  describe(): ExternalExtractorCapability {
    return {
      id: this.id,
      name: this.name,
      category: this.category,
      formats: this.formats,
      extensions: this.extensions,
      available: this.available,
      kind: 'command',
    };
  }

  private interpolate(value: string, file: ClassifiedFile): string {
    return value
      .replaceAll('{file}', file.absolutePath)
      .replaceAll('{relativePath}', file.relativePath)
      .replaceAll('{category}', file.category)
      .replaceAll('{format}', file.format);
  }

  private checkAvailable(): boolean {
    const result = spawnSync(this.command, ['--version'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: 'ignore',
    });
    return !result.error;
  }
}

type CommandCandidate = string | { command: string; args?: string[] };

/** 外部解析器注册表，管理所有已注册的外部解析器 */
export class ExternalExtractorRegistry {
  private readonly extractors: ExternalExtractor[] = [];

  /**
   * 根据环境变量自动注册可用解析器
   * @param env 环境变量（默认 process.env）
   */
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): ExternalExtractorRegistry {
    const registry = new ExternalExtractorRegistry();
    registry.registerConfiguredOrAuto('cad-dwg', 'DWG Advanced Parser', env.CUSTOMIZE_AGENT_DWG_PARSER, [{ command: 'dwg-parser' }, { command: 'oda-dwg-parser' }], { category: 'cad', formats: ['autocad'], extensions: ['.dwg', '.dwt'] });
    registry.registerConfiguredOrAuto('cad-solidworks', 'SolidWorks Advanced Parser', env.CUSTOMIZE_AGENT_SOLIDWORKS_PARSER, [{ command: 'solidworks-parser' }, { command: 'sldworks-parser' }], { category: 'cad', formats: ['solidworks'] });
    registry.registerConfiguredOrAuto('diagram-visio', 'Visio Advanced Parser', env.CUSTOMIZE_AGENT_VISIO_PARSER, [{ command: 'visio-parser' }, { command: 'vsdx-parser' }], { category: 'diagram', formats: ['visio'] });
    registry.registerConfiguredOrAuto('ocr-image', 'OCR Image Parser', env.CUSTOMIZE_AGENT_OCR_PARSER, [{ command: 'tesseract', args: ['{file}', 'stdout', '-l', 'chi_sim+eng'] }], { category: 'image', formats: ['raster', 'raw'] });
    registry.registerConfiguredOrAuto('vision-image', 'Vision Image Parser', env.CUSTOMIZE_AGENT_VISION_PARSER, [{ command: 'vision-parser' }, { command: 'llava-parser' }], { category: 'image', formats: ['raster', 'raw'] });
    registry.registerConfiguredOrAuto('pdf-advanced', 'PDF Advanced Parser', env.CUSTOMIZE_AGENT_PDF_PARSER, [{ command: 'pdftotext', args: ['{file}', '-'] }, { command: 'pdf-parser' }], { category: 'document', formats: ['pdf'] });
    registry.registerConfiguredOrAuto('ocr-pdf', 'OCR PDF Parser', env.CUSTOMIZE_AGENT_OCR_PARSER, [{ command: 'ocrmypdf-text' }, { command: 'tesseract', args: ['{file}', 'stdout', '-l', 'chi_sim+eng'] }], { category: 'document', formats: ['pdf'] });
    registry.registerConfiguredOrAuto('vision-pdf', 'Vision PDF Parser', env.CUSTOMIZE_AGENT_VISION_PARSER, [{ command: 'vision-parser' }, { command: 'llava-parser' }], { category: 'document', formats: ['pdf'] });
    registry.registerConfiguredOrAuto('office-advanced', 'Office Advanced Parser', env.CUSTOMIZE_AGENT_OFFICE_PARSER, [{ command: 'pandoc', args: ['-t', 'plain', '{file}'] }, { command: 'textutil', args: ['-convert', 'txt', '-stdout', '{file}'] }, { command: 'mammoth', args: ['{file}'] }], { category: 'document', formats: ['office', 'presentation'] });
    registry.registerConfiguredOrAuto('spreadsheet-advanced', 'Spreadsheet Advanced Parser', env.CUSTOMIZE_AGENT_SPREADSHEET_PARSER, [{ command: 'xlsx2csv' }, { command: 'in2csv' }], { category: 'spreadsheet', formats: ['excel', 'opendoc'] });
    return registry;
  }

  register(extractor: ExternalExtractor): void {
    this.extractors.push(extractor);
  }

  findAll(file: ClassifiedFile): ExternalExtractor[] {
    return this.extractors.filter(extractor => extractor.available && extractor.supports(file));
  }

  find(file: ClassifiedFile): ExternalExtractor | undefined {
    return this.findAll(file)[0];
  }

  listCapabilities(): ExternalExtractorCapability[] {
    return this.extractors.map(extractor => extractor.describe());
  }

  private registerConfiguredOrAuto(
    id: string,
    name: string,
    configuredCommand: string | undefined,
    candidates: CommandCandidate[],
    supports: Pick<CommandExternalExtractorOptions, 'category' | 'formats' | 'extensions'>,
  ): void {
    const configured: CommandCandidate | undefined = configuredCommand ? { command: configuredCommand } : undefined;
    const candidate = configured
      ?? candidates.find(item => this.commandExists(typeof item === 'string' ? item : item.command))
      ?? candidates[0];
    if (!candidate) return;
    const command = typeof candidate === 'string' ? candidate : candidate.command;
    const args = typeof candidate === 'string' ? undefined : candidate.args;
    this.register(new CommandExternalExtractor({
      id,
      name,
      command,
      args,
      ...supports,
    }));
  }

  private commandExists(command: string): boolean {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 2_000 });
    return !result.error;
  }
}
