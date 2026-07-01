import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExternalExtractorRegistry } from './external-extractor.js';
import type { ClassifiedFile } from '../types.js';

export interface ExtractionResult {
  text: string;
  metadata: Record<string, unknown>;
  warnings: string[];
  extractionTimeMs: number;
}

type SpreadsheetCell = { v?: unknown; w?: string; f?: string; t?: string };
type SpreadsheetRange = { s: { r: number; c: number }; e: { r: number; c: number } };
type SpreadsheetSheet = Record<string, SpreadsheetCell | unknown> & { '!ref'?: string; '!merges'?: SpreadsheetRange[] };

export class ContentExtractor {
  constructor(private readonly externalExtractors = ExternalExtractorRegistry.fromEnvironment()) {}

  async extract(file: ClassifiedFile): Promise<ExtractionResult> {
    const start = Date.now();
    const warnings: string[] = [];
    let text: string;
    const metadata: Record<string, unknown> = {
      mimeType: file.mimeType,
      category: file.category,
      format: file.format,
    };

    const external = this.tryExternalExtractor(file);
    if (external) {
      text = external.text;
      Object.assign(metadata, external.metadata);
      warnings.push(...external.warnings);
    } else if (file.category === 'cad') {
      const result = this.extractCad(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'data') {
      const result = this.extractData(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'diagram') {
      const result = this.extractDiagram(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'document' && file.format === 'pdf') {
      const result = await this.extractPdf(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'document' && ['office', 'presentation'].includes(file.format)) {
      const result = await this.extractOfficeDocument(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'spreadsheet' && ['csv', 'tsv'].includes(file.format)) {
      const result = this.extractDelimitedText(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'spreadsheet') {
      const result = await this.extractSpreadsheet(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'archive') {
      const result = await this.extractArchive(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'image' && file.format !== 'vector') {
      const result = await this.extractRasterImage(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'image' && file.format === 'vector') {
      const result = this.extractSvg(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (this.isTextReadable(file)) {
      text = fs.readFileSync(file.absolutePath, 'utf8');
      metadata.extractionMode = 'plain_text';
      metadata.vectorizable = true;

    } else {
      text = this.metadataOnlyText(file);
      metadata.extractionMode = 'metadata_only';
      metadata.vectorizable = true;
      metadata.contentCoverage = 'metadata';
      warnings.push(`暂不支持 ${file.category}/${file.format} 内容提取，未解析出正文，未入库`);
    }

    return {
      text: text.trim(),
      metadata,
      warnings,
      extractionTimeMs: Date.now() - start,
    };
  }

  private tryExternalExtractor(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } | undefined {
    const extractors = this.externalExtractors.findAll(file);
    if (extractors.length === 0) return undefined;

    const warnings: string[] = [];
    for (const extractor of extractors) {
      try {
        const result = extractor.extract(file);
        const text = result.text.trim();
        if (!text) {
          warnings.push(`外部解析器 ${extractor.name} 未提取到正文`);
          continue;
        }
        return {
          text,
          metadata: {
            extractionMode: 'external_advanced_plugin',
            vectorizable: true,
            contentCoverage: 'external_full_text',
            externalExtractor: extractor.id,
            ...(result.metadata ?? {}),
          },
          warnings: [...warnings, ...(result.warnings ?? [])],
        };
      } catch (error) {
        warnings.push(`外部解析器 ${extractor.name} 失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return undefined;
  }

  private extractCad(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const metadata: Record<string, unknown> = { extractionMode: 'builtin_cad_structural', vectorizable: true };
    const warnings: string[] = [];
    const ext = path.extname(file.absolutePath).toLowerCase();

    if (file.format === 'autocad' && ext === '.dxf') {
      const raw = fs.readFileSync(file.absolutePath, 'utf8');
      const layers = this.matchAll(raw, /\n\s*8\s*\n([^\n]+)/gu).slice(0, 300);
      const textEntities = this.matchAll(raw, /\n\s*(?:1|3)\s*\n([^\n]+)/gu).slice(0, 500);
      const blocks = this.matchAll(raw, /\n\s*2\s*\n([^\n]+)/gu).slice(0, 300);
      const entityTypes = this.matchAll(raw, /\n\s*0\s*\n([A-Z][A-Z0-9_]+)/gu).slice(0, 1000);
      metadata.layerCount = new Set(layers).size;
      metadata.textEntityCount = textEntities.length;
      metadata.blockCount = new Set(blocks).size;
      metadata.entityTypeCount = new Set(entityTypes).size;
      metadata.contentCoverage = 'dxf_layers_blocks_entities_text';
      return {
        text: [
          this.metadataOnlyText(file),
          `CAD DXF 图层: ${Array.from(new Set(layers)).join(', ')}`,
          `CAD DXF 块/符号: ${Array.from(new Set(blocks)).join(', ')}`,
          `CAD DXF 实体类型: ${Array.from(new Set(entityTypes)).join(', ')}`,
          `CAD DXF 标注/文本:\n${textEntities.join('\n')}`,
        ].join('\n'),
        metadata,
        warnings,
      };
    }

    if (file.format === 'step') {
      const raw = fs.readFileSync(file.absolutePath, 'utf8');
      const products = this.matchAll(raw, /PRODUCT\s*\(\s*'([^']*)'\s*,\s*'([^']*)'/giu).slice(0, 300);
      const materials = this.matchAll(raw, /MATERIAL[^']*'([^']+)'/giu).slice(0, 120);
      const entities = this.matchAll(raw, /#\d+\s*=\s*([A-Z0-9_]+)/gu).slice(0, 1000);
      const names = this.matchAll(raw, /'([^']{2,120})'/gu).slice(0, 500);
      metadata.productCount = products.length;
      metadata.materialCount = materials.length;
      metadata.entityTypeCount = new Set(entities).size;
      metadata.contentCoverage = 'step_products_materials_entities_names';
      return {
        text: [
          this.metadataOnlyText(file),
          `STEP 产品/零件:\n${products.join('\n')}`,
          `STEP 材料: ${materials.join(', ')}`,
          `STEP 实体类型: ${Array.from(new Set(entities)).join(', ')}`,
          `STEP 名称/属性:\n${names.join('\n')}`,
        ].join('\n'),
        metadata,
        warnings,
      };
    }

    if (file.format === 'iges') {
      const raw = fs.readFileSync(file.absolutePath, 'utf8');
      const names = this.matchAll(raw, /'([^']{2,120})'/gu).slice(0, 500);
      const entityTypes = this.matchAll(raw, /^\s*(\d{3,4})\s*,/gmu).slice(0, 1000);
      metadata.entityNameCount = names.length;
      metadata.entityTypeCount = new Set(entityTypes).size;
      metadata.contentCoverage = 'iges_entity_names_types';
      return {
        text: [this.metadataOnlyText(file), `IGES 实体类型: ${Array.from(new Set(entityTypes)).join(', ')}`, `IGES 实体/名称:\n${names.join('\n')}`].join('\n'),
        metadata,
        warnings,
      };
    }

    if (file.format === 'mesh') {
      const result = this.extractCadMesh(file, ext, metadata);
      if (result.text.trim()) return result;
    }

    const binaryStrings = this.extractBinaryStrings(file.absolutePath).slice(0, 500);
    metadata.extractionMode = 'builtin_cad_binary_strings';
    metadata.contentCoverage = binaryStrings.length > 0 ? 'cad_binary_strings' : 'metadata';
    metadata.stringCount = binaryStrings.length;
    if (binaryStrings.length === 0) warnings.push(`${file.format} 内置 CAD 解析器未提取到可用文本，未入库`);
    return {
      text: binaryStrings.length > 0 ? [this.metadataOnlyText(file), `CAD 二进制字符串/标题块:\n${binaryStrings.join('\n')}`].join('\n') : '',
      metadata,
      warnings,
    };
  }

  private extractCadMesh(file: ClassifiedFile, ext: string, metadata: Record<string, unknown>): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const warnings: string[] = [];
    if (['.obj', '.gltf'].includes(ext)) {
      const raw = fs.readFileSync(file.absolutePath, 'utf8');
      const objectNames = this.matchAll(raw, /^(?:o|g)\s+(.+)$/gmu).slice(0, 300);
      const nodeNames = this.matchAll(raw, /"name"\s*:\s*"([^"]+)"/gu).slice(0, 300);
      metadata.objectCount = objectNames.length + nodeNames.length;
      metadata.contentCoverage = 'mesh_object_node_names';
      return {
        text: [this.metadataOnlyText(file), `Mesh 对象/节点/分组:\n${[...objectNames, ...nodeNames].join('\n')}`].join('\n'),
        metadata,
        warnings,
      };
    }

    if (ext === '.stl') {
      const buffer = fs.readFileSync(file.absolutePath);
      const header = buffer.subarray(0, 80).toString('utf8').replace(/\0/gu, ' ').trim();
      const rawStart = buffer.subarray(0, Math.min(buffer.length, 20_000)).toString('utf8');
      const solids = this.matchAll(rawStart, /solid\s+([^\r\n]+)/giu).slice(0, 100);
      metadata.contentCoverage = 'stl_header_solids';
      metadata.solidCount = solids.length;
      return { text: [this.metadataOnlyText(file), `STL 头信息: ${header}`, `STL solid 名称:\n${solids.join('\n')}`].join('\n'), metadata, warnings };
    }

    if (ext === '.3mf') {
      const strings = this.extractBinaryStrings(file.absolutePath).slice(0, 500);
      metadata.contentCoverage = strings.length > 0 ? '3mf_model_strings' : 'metadata';
      metadata.stringCount = strings.length;
      return { text: strings.length > 0 ? [this.metadataOnlyText(file), `3MF 模型字符串/部件信息:\n${strings.join('\n')}`].join('\n') : '', metadata, warnings };
    }

    const binaryStrings = this.extractBinaryStrings(file.absolutePath).slice(0, 300);
    metadata.contentCoverage = binaryStrings.length > 0 ? 'mesh_binary_strings' : 'metadata';
    return { text: binaryStrings.length > 0 ? [this.metadataOnlyText(file), `Mesh 二进制字符串:\n${binaryStrings.join('\n')}`].join('\n') : '', metadata, warnings };
  }

  private extractBinaryStrings(filePath: string): string[] {
    const buffer = fs.readFileSync(filePath);
    const raw = buffer.toString('latin1');
    return Array.from(raw.matchAll(/[A-Za-z0-9_ .:\-/\\\u4e00-\u9fa5]{4,}/gu), match => match[0].trim())
      .filter(value => value.length >= 4 && !/^\d+$/u.test(value))
      .slice(0, 2_000);
  }

  private extractData(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const metadata: Record<string, unknown> = { extractionMode: 'structured_data', vectorizable: true };
    try {
      if (file.format === 'json') {
        const lines = path.extname(file.absolutePath).toLowerCase() === '.jsonl'
          ? raw.split(/\r?\n/u).filter(Boolean).slice(0, 200).flatMap((line, index) => this.flattenJson(JSON.parse(line), `line${index + 1}`))
          : this.flattenJson(JSON.parse(raw));
        metadata.fieldCount = lines.length;
        metadata.contentCoverage = 'json_paths_values';
        return { text: [this.metadataOnlyText(file), ...lines.slice(0, 1000)].join('\n'), metadata, warnings: [] };
      }
    } catch {
      metadata.parseError = true;
    }

    if (file.format === 'xml') {
      const elements = this.matchAll(raw, /<([A-Za-z_][\w:.-]*)\b[^>]*>([^<]{1,200})<\/\1>/gu).slice(0, 1000);
      metadata.elementTextCount = elements.length;
      metadata.contentCoverage = 'xml_element_text';
      return { text: [this.metadataOnlyText(file), ...elements].join('\n'), metadata, warnings: [] };
    }

    metadata.contentCoverage = 'plain_structured_text';
    return { text: [this.metadataOnlyText(file), raw].join('\n'), metadata, warnings: [] };
  }

  private extractDiagram(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const metadata: Record<string, unknown> = { extractionMode: 'diagram_structural', vectorizable: true };

    if (file.format === 'drawio') {
      const labels = this.matchAll(raw, /(?:value|label)="([^"]+)"/gu).map(value => this.stripXml(value)).slice(0, 300);
      metadata.nodeTextCount = labels.length;
      metadata.contentCoverage = 'drawio_labels';
      return { text: [this.metadataOnlyText(file), `Draw.io 节点/连线文本:\n${labels.join('\n')}`].join('\n'), metadata, warnings: [] };
    }

    if (file.format === 'excalidraw') {
      try {
        const parsed = JSON.parse(raw) as { elements?: Array<{ type?: string; text?: string }> };
        const texts = (parsed.elements ?? []).filter(element => element.text).map(element => `${element.type ?? 'shape'}: ${element.text}`).slice(0, 300);
        metadata.elementTextCount = texts.length;
        metadata.contentCoverage = 'excalidraw_text_elements';
        return { text: [this.metadataOnlyText(file), `Excalidraw 图形文本:\n${texts.join('\n')}`].join('\n'), metadata, warnings: [] };
      } catch {
        metadata.parseError = true;
      }
    }

    metadata.contentCoverage = 'diagram_source_text';
    return { text: [this.metadataOnlyText(file), raw].join('\n'), metadata, warnings: [] };
  }

  private parseDelimitedLine(line: string, delimiter: string): string[] {
    const values: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') {
          current += '"';
          index++;
        } else {
          quoted = !quoted;
        }
      } else if (char === delimiter && !quoted) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  }

  private extractDelimitedText(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const delimiter = file.format === 'tsv' ? '\t' : ',';
    const rows = raw.split(/\r?\n/u).filter(line => line.trim().length > 0);
    const header = rows[0] ? this.parseDelimitedLine(rows[0], delimiter) : [];
    const structured = rows.slice(1, 501).flatMap((line, rowIndex) => {
      const values = this.parseDelimitedLine(line, delimiter);
      return values.map((value, colIndex) => {
        const column = header[colIndex] || `COL${colIndex + 1}`;
        return `R${rowIndex + 2}C${colIndex + 1} ${column}: ${value}`;
      });
    });
    return {
      text: [this.metadataOnlyText(file), `表头: ${header.join(' | ')}`, ...structured, raw].join('\n'),
      metadata: {
        extractionMode: 'delimited_text_structured',
        vectorizable: true,
        delimiter: file.format === 'tsv' ? 'tab' : 'comma',
        rowCount: rows.length,
        columnCount: header.length,
        contentCoverage: 'table_headers_cells_text',
      },
      warnings: [],
    };
  }

  private async extractOfficeDocument(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    if (path.extname(file.absolutePath).toLowerCase() === '.docx') {
      try {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ path: file.absolutePath });
        const text = result.value.trim();
        if (text) {
          return {
            text,
            metadata: { extractionMode: 'builtin_mammoth', vectorizable: true, contentCoverage: 'office_full_text' },
            warnings: result.messages.map(message => message.message),
          };
        }
      } catch {
        // fallback below
      }
    }
    return this.extractOfficeZip(file);
  }

  private async extractSpreadsheet(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.readFile(file.absolutePath, { cellDates: true, cellFormula: true, cellNF: true, cellStyles: true });
      const sheetTexts: string[] = [];
      let cellCount = 0;
      let formulaCount = 0;
      let mergeCount = 0;

      for (const name of workbook.SheetNames) {
        const sheet = workbook.Sheets[name] as SpreadsheetSheet | undefined;
        if (!sheet || !sheet['!ref']) continue;
        const range = XLSX.utils.decode_range(sheet['!ref']);
        const lines: string[] = [`工作表: ${name}`, `范围: ${sheet['!ref']}`];
        const merges = sheet['!merges'] ?? [];
        mergeCount += merges.length;
        if (merges.length > 0) {
          lines.push(`合并单元格: ${merges.map(item => `${XLSX.utils.encode_cell(item.s)}:${XLSX.utils.encode_cell(item.e)}`).join(', ')}`);
        }
        for (let row = range.s.r; row <= range.e.r; row++) {
          for (let col = range.s.c; col <= range.e.c; col++) {
            const address = XLSX.utils.encode_cell({ r: row, c: col });
            const cell = sheet[address] as SpreadsheetCell | undefined;
            if (!cell || (cell.v == null && !cell.f)) continue;
            cellCount++;
            if (cell.f) formulaCount++;
            const display = cell.w ?? String(cell.v ?? '');
            const formula = cell.f ? ` 公式=${cell.f}` : '';
            lines.push(`${address}: ${display}${formula}`);
          }
        }
        if (lines.length > 2) sheetTexts.push(lines.slice(0, 5_000).join('\n'));
      }

      if (sheetTexts.length > 0) {
        return {
          text: sheetTexts.join('\n\n'),
          metadata: { extractionMode: 'builtin_xlsx_structured_cells', vectorizable: true, sheetCount: sheetTexts.length, cellCount, formulaCount, mergeCount, contentCoverage: 'spreadsheet_cells_formulas_merges' },
          warnings: [],
        };
      }
    } catch {
      // fallback below
    }
    return this.extractOfficeZip(file);
  }

  private async extractOfficeZip(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = { extractionMode: 'office_zip_text', vectorizable: true };
    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(fs.readFileSync(file.absolutePath));
      const texts: string[] = [];
      const xmlEntries = Object.values(zip.files).filter(entry => !entry.dir && /\.(xml|rels)$/iu.test(entry.name)).slice(0, 80);
      for (const entry of xmlEntries) {
        const xml = await entry.async('text');
        const stripped = this.stripXml(xml).replace(/\s+/gu, ' ').trim();
        if (stripped) texts.push(`${entry.name}: ${stripped.slice(0, 8_000)}`);
      }
      metadata.entryCount = Object.keys(zip.files).length;
      metadata.contentCoverage = texts.length > 0 ? 'office_zip_xml_text' : 'metadata_filename';
      return { text: [this.metadataOnlyText(file), ...texts].join('\n'), metadata, warnings: texts.length ? [] : ['未从 Office 压缩结构中提取到正文，已跳过入库'] };
    } catch (error) {
      metadata.extractionMode = 'office_zip_failed';
      metadata.parseError = error instanceof Error ? error.message : String(error);
      return { text: '', metadata, warnings: ['Office/表格/演示文件解析失败，内置解析器未提取到正文，未入库'] };
    }
  }

  private async extractArchive(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = { extractionMode: 'archive_manifest', vectorizable: true };
    if (path.extname(file.absolutePath).toLowerCase() !== '.zip') {
      metadata.contentCoverage = 'metadata_filename';
      return { text: this.metadataOnlyText(file), metadata, warnings: ['压缩包未提取到正文，未入库；仅 zip 可提取文件清单'] };
    }
    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(fs.readFileSync(file.absolutePath));
      const entries = Object.values(zip.files).map(entry => `${entry.dir ? '目录' : '文件'}: ${entry.name}`).slice(0, 1_000);
      metadata.entryCount = Object.keys(zip.files).length;
      metadata.contentCoverage = 'zip_manifest';
      return { text: [this.metadataOnlyText(file), '压缩包文件清单:', ...entries].join('\n'), metadata, warnings: [] };
    } catch (error) {
      metadata.parseError = error instanceof Error ? error.message : String(error);
      return { text: '', metadata, warnings: ['压缩包解析失败，内置解析器未提取到文件清单，未入库'] };
    }
  }

  private async extractRasterImage(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = { extractionMode: 'builtin_tesseract_ocr_isolated', vectorizable: true };
    const validationError = this.validateRasterImage(file.absolutePath);
    if (validationError) {
      metadata.contentCoverage = 'invalid_image';
      metadata.parseError = validationError;
      return { text: '', metadata, warnings: [`图片文件无效或不完整：${validationError}，未入库`] };
    }

    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `const { createWorker } = await import('tesseract.js');
const worker = await createWorker('chi_sim+eng');
try {
  const result = await worker.recognize(process.argv[1]);
  process.stdout.write(result.data.text || '');
} finally {
  await worker.terminate();
}`,
      file.absolutePath,
    ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });

    if (result.status !== 0 || result.error) {
      const message = result.error?.message || result.stderr.trim() || `OCR 子进程退出码 ${result.status ?? 'unknown'}`;
      metadata.contentCoverage = 'ocr_failed';
      metadata.parseError = message;
      return { text: '', metadata, warnings: [`内置 OCR 解析失败：${message}，未入库`] };
    }

    const text = result.stdout.trim();
    metadata.contentCoverage = text ? 'ocr_text' : 'metadata_filename';
    return {
      text,
      metadata,
      warnings: text ? [] : ['内置 OCR 未识别到文字，未入库'],
    };
  }

  private validateRasterImage(filePath: string): string | undefined {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 12) return '文件过小，无法识别图片头';

    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return buffer.includes(Buffer.from([0x49, 0x45, 0x4e, 0x44])) ? undefined : 'PNG 缺少 IEND 结束块';
    }

    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      return buffer.length > 4 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9 ? undefined : 'JPEG 缺少 EOI 结束标记';
    }

    const header = buffer.subarray(0, 12).toString('ascii');
    if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
      return buffer[buffer.length - 1] === 0x3b ? undefined : 'GIF 缺少 trailer 结束标记';
    }

    if (header.startsWith('RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
      const expectedSize = buffer.readUInt32LE(4) + 8;
      return buffer.length >= expectedSize ? undefined : 'WebP 文件长度小于 RIFF 声明长度';
    }

    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      const expectedSize = buffer.readUInt32LE(2);
      return buffer.length >= expectedSize ? undefined : 'BMP 文件长度小于头部声明长度';
    }

    return undefined;
  }

  private async extractPdf(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = { extractionMode: 'pdf_text', vectorizable: true };
    try {
      const raw = fs.readFileSync(file.absolutePath);
      const text = await this.extractPdfText(raw);
      if (text.trim()) {
        metadata.contentCoverage = 'pdf_text_streams';
        return { text: [this.metadataOnlyText(file), text].join('\n'), metadata, warnings: [] };
      }
    } catch (error) {
      metadata.parseError = error instanceof Error ? error.message : String(error);
    }

    metadata.extractionMode = 'pdf_metadata_only';
    metadata.contentCoverage = 'metadata_filename';
    return {
      text: '',
      metadata,
      warnings: ['PDF 正文暂未提取到文本，内置解析器未提取到正文，未入库'],
    };
  }

  private async extractPdfText(buffer: Buffer): Promise<string> {
    try {
      const mod = await import('pdf-parse');
      const PDFParse = (mod as unknown as { PDFParse?: new (options: { data: Uint8Array }) => { getText(): Promise<{ text: string }>; destroy(): Promise<void> } }).PDFParse;
      if (PDFParse) {
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        try {
          const result = await parser.getText();
          if (result.text.trim()) return result.text.slice(0, 250_000);
        } finally {
          await parser.destroy();
        }
      }
    } catch {
      // fallback to legacy API/raw stream extraction below
    }

    try {
      const mod = await import('pdf-parse');
      const pdfParse = (mod as unknown as { default?: (data: Buffer) => Promise<{ text: string }> }).default;
      if (pdfParse) {
        const result = await pdfParse(buffer);
        if (result.text.trim()) return result.text.slice(0, 250_000);
      }
    } catch {
      // fallback below
    }

    const raw = buffer.toString('latin1');
    const matches = Array.from(raw.matchAll(/\(([^()]{2,500})\)\s*T[jJ]/gu), match => match[1] ?? '')
      .concat(Array.from(raw.matchAll(/\[([^\]]{2,2000})\]\s*TJ/gu), match => match[1] ?? ''));
    return matches
      .map(value => value.replace(/\\([()\\])/gu, '$1').replace(/\\n|\\r/gu, ' '))
      .join('\n')
      .split('')
      .map(char => {
        const code = char.charCodeAt(0);
        return (code < 32 && code !== 9 && code !== 10 && code !== 13) ? ' ' : char;
      })
      .join('')
      .trim();
  }

  private extractSvg(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const texts = this.matchAll(raw, /<text\b[^>]*>([\s\S]*?)<\/text>/giu).map(value => this.stripXml(value)).slice(0, 300);
    const titles = this.matchAll(raw, /<(?:title|desc)\b[^>]*>([\s\S]*?)<\/(?:title|desc)>/giu).map(value => this.stripXml(value)).slice(0, 100);
    return {
      text: [this.metadataOnlyText(file), `SVG 标题/描述:\n${titles.join('\n')}`, `SVG 文本节点:\n${texts.join('\n')}`].join('\n'),
      metadata: { extractionMode: 'svg_text_nodes', vectorizable: true, textNodeCount: texts.length, contentCoverage: 'svg_text_title_desc' },
      warnings: [],
    };
  }

  private isTextReadable(file: ClassifiedFile): boolean {
    if (file.category === 'code' || file.category === 'web') return true;
    if (file.category === 'document') return ['markdown', 'plaintext'].includes(file.format);
    if (file.category === 'spreadsheet') return file.format === 'csv';
    if (file.category === 'image') return file.format === 'vector';
    return file.category === 'other' && this.looksTextFile(file.absolutePath);
  }

  private looksTextFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.log', '.text'].includes(ext);
  }

  private matchAll(input: string, pattern: RegExp): string[] {
    return Array.from(input.matchAll(pattern), match => match.slice(1).filter(Boolean).join(' | ').trim()).filter(Boolean);
  }

  private stripXml(value: string): string {
    return value
      .replace(/<[^>]+>/gu, ' ')
      .replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'")
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&amp;/gu, '&')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  private flattenJson(value: unknown, prefix = ''): string[] {
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return [`${prefix || 'value'}: ${String(value)}`];
    }
    if (Array.isArray(value)) {
      return value.slice(0, 50).flatMap((item, index) => this.flattenJson(item, `${prefix}[${index}]`));
    }
    if (typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => this.flattenJson(item, prefix ? `${prefix}.${key}` : key));
    }
    return [];
  }

  private metadataOnlyText(file: ClassifiedFile): string {
    const fileName = path.basename(file.relativePath);
    const directory = path.dirname(file.relativePath);
    const searchableName = fileName.replace(/[_\-.]+/gu, ' ');
    return [
      `文件名: ${fileName}`,
      `文件路径: ${file.relativePath}`,
      `所在目录: ${directory === '.' ? 'knowledgeBase' : directory}`,
      `可搜索名称: ${searchableName}`,
      `文件类型: ${file.category}/${file.format}`,
      `MIME: ${file.mimeType}`,
      `文件大小: ${file.fileSize} bytes`,
    ].join('\n');
  }
}
