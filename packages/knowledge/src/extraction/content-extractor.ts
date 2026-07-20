import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveAndImport, resolvePackage } from './module-resolver.js';
import { createOcrProvider, type OcrProvider } from './ocr-providers.js';
import type { ClassifiedFile } from '../types.js';

/** 文件内容提取结果 */
export interface ExtractionResult {
  text: string;
  metadata: Record<string, unknown>;
  warnings: string[];
  extractionTimeMs: number;
}

type SpreadsheetCell = { v?: unknown; w?: string; f?: string; t?: string };
type SpreadsheetRange = { s: { r: number; c: number }; e: { r: number; c: number } };
type SpreadsheetSheet = Record<string, SpreadsheetCell | unknown> & { '!ref'?: string; '!merges'?: SpreadsheetRange[] };
type PdfTextItem = { str: string; x: number; y: number; width: number; height: number; fontName?: string };
type CadAnnotation = { text: string; x?: number; y?: number; layer?: string; block?: string; entityType?: string };

const CAD_INTERNAL_TOKEN_RE = /\b(?:TDbPipe|TDbPipeValve|TDbPipeFitting|TDbWellh|AcDb\w+|Dwg\w+|ObjectId|Handle|ByLayer|Continuous|Model|Layout\d*)\b/giu;
const CAD_INTERNAL_LINE_RE = /^(?:TDb\w+|AcDb\w+|[A-F0-9]{8,}|\d+|Model|Layout\d*|ByLayer|Continuous)$/iu;

/** 文件内容提取器，支持文档、表格、图片、CAD 等多种文件格式的内容抽取 */
export class ContentExtractor {
  async extract(file: ClassifiedFile): Promise<ExtractionResult> {
    const start = Date.now();
    const warnings: string[] = [];
    let text: string;
    const metadata: Record<string, unknown> = {
      mimeType: file.mimeType,
      category: file.category,
      format: file.format,
    };

    if (file.category === 'cad') {
      const result = await this.extractCad(file);
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
    } else if (file.format === 'text_clipping') {
      const result = this.extractTextClipping(file);
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
      text: this.cleanExtractedText(text, file).trim(),
      metadata,
      warnings,
      extractionTimeMs: Date.now() - start,
    };
  }


  private extractTextClipping(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const buffer = fs.readFileSync(file.absolutePath);
    const candidates = [
      buffer.toString('utf16le'),
      this.swapUtf16Bytes(buffer).toString('utf16le'),
      buffer.toString('utf8'),
      ...this.extractBinaryStrings(file.absolutePath),
    ];
    const fragments = candidates.flatMap(candidate => this.extractReadableFragments(candidate));
    const unique = Array.from(new Set(fragments))
      .filter(fragment => fragment.length >= 2 && !/^bplist\d+/u.test(fragment))
      .sort((a, b) => this.textScore(b) - this.textScore(a))
      .slice(0, 50);
    const text = unique.join('\n');
    return {
      text: text ? [this.metadataOnlyText(file), text].join('\n') : this.metadataOnlyText(file),
      metadata: {
        extractionMode: 'builtin_text_clipping',
        vectorizable: true,
        contentCoverage: text ? 'text_clipping_payload' : 'metadata',
        fragmentCount: unique.length,
      },
      warnings: text ? [] : ['未从 textClipping 中提取到剪贴文本，仅入库元数据'],
    };
  }

  private swapUtf16Bytes(buffer: Buffer): Buffer {
    const swapped = Buffer.from(buffer);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const first = swapped[i] ?? 0;
      swapped[i] = swapped[i + 1] ?? 0;
      swapped[i + 1] = first;
    }
    return swapped;
  }

  private extractReadableFragments(value: string): string[] {
    return value
      .replace(/[^\p{L}\p{N}\p{P}\p{S}\s]/gu, '\n')
      .split(/[\r\n]+/u)
      .map(line => this.cleanCadReadableText(line))
      .filter(line => line.length >= 2 && /[\p{L}\p{N}]/u.test(line));
  }

  private cleanCadReadableText(value: string): string {
    return value
      .replace(CAD_INTERNAL_TOKEN_RE, '')
      .replace(/\b(?:LINE|LWPOLYLINE|POLYLINE|INSERT|HATCH|CIRCLE|ARC|DIMENSION|TEXT|MTEXT)\b/giu, '')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  private isReadableCadValue(value: string): boolean {
    const cleaned = this.cleanCadReadableText(value);
    return cleaned.length >= 2 && !CAD_INTERNAL_LINE_RE.test(cleaned) && /[\p{Script=Han}\p{Letter}\d]/u.test(cleaned);
  }

  private cleanExtractedText(value: string, file: ClassifiedFile): string {
    const normalized = [...value]
      .filter(char => {
        const code = char.charCodeAt(0);
        return code === 9 || code === 10 || code === 13 || code >= 32;
      })
      .join('');
    if (file.category !== 'cad') return normalized.replace(/\n{3,}/gu, '\n\n');
    return normalized
      .split(/\r?\n/u)
      .map(line => this.cleanCadReadableText(line))
      .filter(line => line && !CAD_INTERNAL_LINE_RE.test(line))
      .join('\n')
      .replace(/\n{3,}/gu, '\n\n');
  }

  private textScore(value: string): number {
    const cjk = (value.match(/[\p{Script=Han}]/gu) ?? []).length;
    const alnum = (value.match(/[\p{L}\p{N}]/gu) ?? []).length;
    return cjk * 4 + alnum + Math.min(value.length, 200) / 20;
  }

  private async extractCad(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = { extractionMode: 'builtin_cad_structural', vectorizable: true };
    const warnings: string[] = [];
    const ext = path.extname(file.absolutePath).toLowerCase();

    if (ext === '.dxf') return await this.extractDxf(file, fs.readFileSync(file.absolutePath, 'utf8'), metadata);
    if (ext === '.dwg') {
      const converted = await this.tryConvertDwgToDxf(file.absolutePath);
      if (converted?.dxfText) {
        const parsed = await this.extractDxf(file, converted.dxfText, { ...metadata, extractionMode: converted.tool, convertedFrom: 'dwg' });
        parsed.warnings.push(...converted.warnings);
        return parsed;
      }
      warnings.push(...(converted?.warnings ?? ['未检测到可用 DWG→DXF 转换器，使用内置图纸可读文本抽取']));
    }

    if (file.format === 'autocad' && ext === '.dxf') {
      const raw = fs.readFileSync(file.absolutePath, 'utf8');
      const layers = this.matchAll(raw, /\n\s*8\s*\n([^\n]+)/gu).filter(value => this.isReadableCadValue(value)).slice(0, 300);
      const textEntities = this.extractDxfTextAnnotations(raw).slice(0, 500);
      const blocks = this.matchAll(raw, /\n\s*2\s*\n([^\n]+)/gu).filter(value => this.isReadableCadValue(value)).slice(0, 300);
      const entityTypes = this.matchAll(raw, /\n\s*0\s*\n([A-Z][A-Z0-9_]+)/gu).slice(0, 1000);
      const uniqueLayers = Array.from(new Set(layers));
      const uniqueBlocks = Array.from(new Set(blocks));
      const uniqueEntityTypes = Array.from(new Set(entityTypes));
      metadata.layerCount = uniqueLayers.length;
      metadata.layerNames = uniqueLayers.slice(0, 80);
      metadata.textEntityCount = textEntities.length;
      metadata.blockCount = uniqueBlocks.length;
      metadata.blockNames = uniqueBlocks.slice(0, 80);
      metadata.entityTypeCount = uniqueEntityTypes.length;
      metadata.entityTypes = uniqueEntityTypes.slice(0, 80);
      metadata.contentCoverage = 'dxf_semantic_layer_block_annotations';
      const semanticNodes = this.buildCadSemanticNodes(file, uniqueLayers, uniqueBlocks, uniqueEntityTypes, textEntities);
      return {
        text: [
          this.metadataOnlyText(file),
          `CAD DXF 图层: ${uniqueLayers.join(', ')}`,
          `CAD DXF 块/符号: ${uniqueBlocks.join(', ')}`,
          `CAD DXF 实体类型: ${uniqueEntityTypes.join(', ')}`,
          'CAD 语义图纸节点:',
          ...semanticNodes,
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
      const uniqueStepEntities = Array.from(new Set(entities));
      metadata.productCount = products.length;
      metadata.productNames = products.slice(0, 80);
      metadata.materialCount = materials.length;
      metadata.materialNames = materials.slice(0, 80);
      metadata.entityTypeCount = uniqueStepEntities.length;
      metadata.entityTypes = uniqueStepEntities.slice(0, 80);
      metadata.contentCoverage = 'step_products_materials_entities_names';
      return {
        text: [
          this.metadataOnlyText(file),
          `STEP 产品/零件:\n${products.join('\n')}`,
          `STEP 材料: ${materials.join(', ')}`,
          `STEP 实体类型: ${uniqueStepEntities.join(', ')}`,
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
      const uniqueIgesTypes = Array.from(new Set(entityTypes));
      metadata.entityNameCount = names.length;
      metadata.entityNames = names.slice(0, 80);
      metadata.entityTypeCount = uniqueIgesTypes.length;
      metadata.entityTypes = uniqueIgesTypes.slice(0, 80);
      metadata.contentCoverage = 'iges_entity_names_types';
      return {
        text: [this.metadataOnlyText(file), `IGES 实体类型: ${uniqueIgesTypes.join(', ')}`, `IGES 实体/名称:\n${names.join('\n')}`].join('\n'),
        metadata,
        warnings,
      };
    }

    if (file.format === 'mesh') {
      const result = this.extractCadMesh(file, ext, metadata);
      if (result.text.trim()) return result;
    }

    const readable = this.extractBinaryReadableFragments(file.absolutePath).filter(value => this.isReadableCadValue(value)).slice(0, 5000);
    metadata.extractionMode = 'builtin_cad_readable_fragments';
    metadata.contentCoverage = readable.length > 0 ? 'cad_readable_text_fragments' : 'metadata';
    metadata.stringCount = readable.length;
    if (readable.length === 0) warnings.push(`${file.format} 内置 CAD 解析器未提取到可用文本，仅记录文件元数据，未生成可检索正文切片`);
    else warnings.push(`${file.format} 未检测到专业 DWG 转换器，已使用内置可读标注/标题块抽取；如需完整图纸结构，请安装 ODA File Converter 或 LibreDWG 并配置外部解析器`);
    return {
      text: readable.length > 0 ? [this.metadataOnlyText(file), `CAD 图纸可读标注/标题块/属性:\n${readable.join('\n')}`].join('\n') : this.metadataOnlyText(file),
      metadata,
      warnings,
    };
  }

  private async extractDxf(file: ClassifiedFile, raw: string, metadata: Record<string, unknown>): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const warnings: string[] = [];
    let parsed: unknown;
    try {
      const mod = await resolveAndImport('dxf-parser') as { default?: new () => { parseSync: (text: string) => unknown } } & (new () => { parseSync: (text: string) => unknown });
      const Parser = mod.default ?? mod;
      parsed = new Parser().parseSync(raw);
    } catch {
      warnings.push('dxf-parser 解析失败，已使用 DXF 文本结构抽取回退');
    }

    const layers = this.matchAll(raw, /(?:^|\r?\n)\s*8\s*\r?\n([^\r\n]+)/gu).filter(value => this.isReadableCadValue(value)).slice(0, 300);
    const textEntities = this.extractDxfTextAnnotations(raw).slice(0, 5000);
    const blocks = this.matchAll(raw, /(?:^|\r?\n)\s*2\s*\r?\n([^\r\n]+)/gu).filter(value => this.isReadableCadValue(value)).slice(0, 300);
    const entityTypes = this.matchAll(raw, /(?:^|\r?\n)\s*0\s*\r?\n([A-Z][A-Z0-9_]+)/gu).slice(0, 1200);
    const uniqueLayers = Array.from(new Set(layers));
    const uniqueBlocks = Array.from(new Set(blocks));
    const uniqueEntityTypes = Array.from(new Set(entityTypes));
    metadata.layerCount = uniqueLayers.length;
    metadata.layerNames = uniqueLayers.slice(0, 80);
    metadata.textEntityCount = textEntities.length;
    metadata.blockCount = uniqueBlocks.length;
    metadata.blockNames = uniqueBlocks.slice(0, 80);
    metadata.entityTypeCount = uniqueEntityTypes.length;
    metadata.entityTypes = uniqueEntityTypes.slice(0, 80);
    metadata.contentCoverage = 'dxf_semantic_layer_block_annotations';
    metadata.parsedByDxfParser = Boolean(parsed);
    const semanticNodes = this.buildCadSemanticNodes(file, uniqueLayers, uniqueBlocks, uniqueEntityTypes, textEntities);
    return {
      text: [
        this.metadataOnlyText(file),
        `CAD DXF 图层: ${uniqueLayers.join(', ')}`,
        `CAD DXF 块/符号: ${uniqueBlocks.join(', ')}`,
        `CAD DXF 实体类型: ${uniqueEntityTypes.join(', ')}`,
        'CAD 语义图纸节点:',
        ...semanticNodes,
      ].join('\n'),
      metadata,
      warnings,
    };
  }

  private buildCadSemanticNodes(file: ClassifiedFile, layers: string[], blocks: string[], entityTypes: string[], texts: CadAnnotation[]): string[] {
    const fileName = path.basename(file.relativePath);
    const defaultLayer = layers[0] ?? '未命名图层';
    const defaultBlock = blocks[0] ?? '全局模型空间';
    const defaultEntity = entityTypes.find(type => /DIMENSION|TEXT|MTEXT|LEADER/u.test(type)) ?? entityTypes[0] ?? 'UNKNOWN';
    const annotations = texts.length > 0 ? texts : [{ text: '未提取到文字标注', layer: defaultLayer, block: defaultBlock, entityType: defaultEntity }];
    return annotations.map((annotation, index) => {
      const nearest = this.findNearestCadAnnotation(annotation, annotations);
      const layer = annotation.layer ?? layers[index % Math.max(1, layers.length)] ?? defaultLayer;
      const block = annotation.block ?? blocks[index % Math.max(1, blocks.length)] ?? defaultBlock;
      const entity = annotation.entityType ?? this.inferCadEntityType(annotation.text, defaultEntity);
      const status = /关键|critical|尺寸|dim|mm|cm|m\b|°|φ|Φ|R\d/iu.test(annotation.text) ? '关键尺寸/约束候选' : '普通标注';
      const position = annotation.x != null && annotation.y != null ? ` | 坐标: (${annotation.x.toFixed(2)}, ${annotation.y.toFixed(2)})` : '';
      return [`图纸节点: ${fileName} | 图层: ${layer} | 块: ${block} | 实体类型: ${entity}${position}`, `└── 标注文本: ${annotation.text} | 关联对象: ${nearest ? `邻近标注 ${nearest.text}` : '空间邻近候选'} | 状态: ${status}`].join('\n');
    });
  }

  private extractDxfTextAnnotations(raw: string): CadAnnotation[] {
    const entities = raw.split(/(?:^|\r?\n)\s*0\s*\r?\n/u).filter(section => /^(?:TEXT|MTEXT|DIMENSION|LEADER)/u.test(section.trim()));
    return entities.flatMap(section => {
      const text = this.cleanCadReadableText(/(?:^|\r?\n)\s*(?:1|3)\s*\r?\n([^\r\n]+)/u.exec(section)?.[1] ?? '');
      if (!text || !this.isReadableCadValue(text)) return [];
      return [{
        text,
        layer: /(?:^|\r?\n)\s*8\s*\r?\n([^\r\n]+)/u.exec(section)?.[1]?.trim(),
        block: /(?:^|\r?\n)\s*2\s*\r?\n([^\r\n]+)/u.exec(section)?.[1]?.trim(),
        entityType: section.trim().split(/\s+/u)[0],
        x: Number(/(?:^|\r?\n)\s*10\s*\r?\n([^\r\n]+)/u.exec(section)?.[1]),
        y: Number(/(?:^|\r?\n)\s*20\s*\r?\n([^\r\n]+)/u.exec(section)?.[1]),
      }].map(item => ({ ...item, x: Number.isFinite(item.x) ? item.x : undefined, y: Number.isFinite(item.y) ? item.y : undefined }));
    });
  }

  private findNearestCadAnnotation(target: CadAnnotation, annotations: CadAnnotation[]): CadAnnotation | undefined {
    if (target.x == null || target.y == null) return undefined;
    return annotations
      .filter(item => item !== target && item.x != null && item.y != null)
      .map(item => ({ item, distance: Math.hypot((item.x ?? 0) - target.x!, (item.y ?? 0) - target.y!) }))
      .sort((a, b) => a.distance - b.distance)[0]?.item;
  }

  private inferCadEntityType(text: string, fallback: string): string {
    if (/\b\d+(?:\.\d+)?\s*(?:mm|cm|m)\b|φ|Φ|R\d/iu.test(text)) return '线性尺寸/半径尺寸';
    if (/°|angle|角度/iu.test(text)) return '角度尺寸';
    if (/note|说明|备注/iu.test(text)) return '文字说明';
    return fallback;
  }

  private async tryConvertDwgWithBundledWasm(filePath: string): Promise<{ dxfText?: string; tool: string; warnings: string[] }> {
    try {
      const mod = await resolveAndImport('dwgdxf') as { convertDwgToDxf?: (dwg: Uint8Array | ArrayBuffer, options?: { wasmBase?: string }) => Promise<Uint8Array> };
      if (!mod.convertDwgToDxf) return { tool: 'dwgdxf_wasm', warnings: ['内置 dwgdxf WASM 转换器未导出 convertDwgToDxf'] };
      const wasmBase = pathToFileURL(path.join(path.dirname(resolvePackage('dwgdxf')), 'wasm')).href;
      const dxfBytes = await mod.convertDwgToDxf(fs.readFileSync(filePath), { wasmBase });
      const dxfText = Buffer.from(dxfBytes).toString('utf8');
      return dxfText.trim()
        ? { dxfText, tool: 'dwgdxf_wasm', warnings: [] }
        : { tool: 'dwgdxf_wasm', warnings: ['内置 dwgdxf WASM 转换器未输出 DXF 文本'] };
    } catch (error) {
      return { tool: 'dwgdxf_wasm', warnings: [`内置 dwgdxf WASM 转换失败: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  private async tryConvertDwgToDxf(filePath: string): Promise<{ dxfText?: string; tool: string; warnings: string[] } | undefined> {
    const tmpDir = fs.mkdtempSync(path.join(this.getTempRoot(), 'customize-dwg-'));
    const outputPath = path.join(tmpDir, `${path.basename(filePath, path.extname(filePath))}.dxf`);
    try {
      const failures: string[] = [];
      const bundled = await this.tryConvertDwgWithBundledWasm(filePath);
      if (bundled.dxfText) return bundled;
      failures.push(...bundled.warnings);

      const customCmd = process.env.CUSTOMIZE_DWG_TO_DXF_CMD;
      if (customCmd) {
        if (/\s/u.test(customCmd)) return { tool: 'external_dwg_to_dxf', warnings: ['CUSTOMIZE_DWG_TO_DXF_CMD 只支持可执行文件路径；参数请使用 CUSTOMIZE_DWG_TO_DXF_ARGS JSON 数组配置'] };
        let argTemplate: unknown = ['{input}', '{output}'];
        try { if (process.env.CUSTOMIZE_DWG_TO_DXF_ARGS) argTemplate = JSON.parse(process.env.CUSTOMIZE_DWG_TO_DXF_ARGS) as unknown; }
        catch { return { tool: 'external_dwg_to_dxf', warnings: ['CUSTOMIZE_DWG_TO_DXF_ARGS 必须是字符串数组 JSON'] }; }
        if (!Array.isArray(argTemplate) || !argTemplate.every(arg => typeof arg === 'string')) return { tool: 'external_dwg_to_dxf', warnings: ['CUSTOMIZE_DWG_TO_DXF_ARGS 必须是字符串数组 JSON'] };
        const args = argTemplate.map(arg => arg.replace(/\{input\}/gu, filePath).replace(/\{output\}/gu, outputPath));
        const result = spawnSync(customCmd, args, { shell: false, encoding: 'utf8', timeout: 120_000 });
        if (result.status === 0 && fs.existsSync(outputPath)) return { dxfText: fs.readFileSync(outputPath, 'utf8'), tool: 'external_dwg_to_dxf', warnings: [] };
        return { tool: 'external_dwg_to_dxf', warnings: [`CUSTOMIZE_DWG_TO_DXF_CMD 转换失败: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`] };
      }

      for (const bin of ['dwgread', 'dwg2dxf']) {
        const result = spawnSync(bin, bin === 'dwgread' ? ['-O', 'DXF', '-o', outputPath, filePath] : [filePath, outputPath], { encoding: 'utf8', timeout: 120_000 });
        if (result.status === 0 && fs.existsSync(outputPath)) return { dxfText: fs.readFileSync(outputPath, 'utf8'), tool: bin, warnings: [] };
        if (result.error && 'code' in result.error && result.error.code === 'ENOENT') continue;
        failures.push(`${bin} 转换失败: ${result.stderr || result.stdout || result.error?.message || `exit ${result.status ?? 'unknown'}`}`);
      }
      return { tool: 'builtin_fallback', warnings: [...failures, failures.length ? 'DWG→DXF 转换失败，使用内置图纸可读文本抽取' : '未检测到可用 DWG→DXF 转换器（dwgread/dwg2dxf/CUSTOMIZE_DWG_TO_DXF_CMD），使用内置图纸可读文本抽取'] };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  private getTempRoot(): string {
    return process.env.CUSTOMIZE_TMPDIR || process.env.TMPDIR || tmpdir();
  }

  private extractBinaryReadableFragments(filePath: string): string[] {
    const buffer = fs.readFileSync(filePath);
    const candidates = [
      buffer.toString('utf8'),
      buffer.toString('utf16le'),
      this.swapUtf16Bytes(buffer).toString('utf16le'),
      buffer.toString('latin1'),
    ];
    return Array.from(new Set(candidates.flatMap(candidate => this.extractReadableFragments(candidate))))
      .filter(value => value.length >= 3 && !/^\d+$/u.test(value))
      .sort((a, b) => this.textScore(b) - this.textScore(a))
      .slice(0, 2_000);
  }

  private extractBinaryStrings(filePath: string): string[] {
    return this.extractBinaryReadableFragments(filePath);
  }

  private extractData(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const metadata: Record<string, unknown> = { extractionMode: 'structured_data', semanticExtractionMode: 'structured_data_semantic_paths', vectorizable: true };
    try {
      if (file.format === 'json') {
        const isJsonl = path.extname(file.absolutePath).toLowerCase() === '.jsonl';
        const records = isJsonl
          ? raw.split(/\r?\n/u).filter(Boolean).map((line, index) => ({ path: `line${index + 1}`, value: JSON.parse(line) }))
          : [{ path: '$', value: JSON.parse(raw) }];
        const lines = records.flatMap(record => this.flattenJson(record.value, record.path));
        const objects = records.flatMap(record => this.atomicJsonObjects(record.value, record.path));
        metadata.fieldCount = lines.length;
        metadata.recordCount = records.length;
        metadata.objectCount = objects.length;
        metadata.dataPaths = lines.map(line => line.split(':')[0]).slice(0, 200);
        metadata.contentCoverage = isJsonl ? 'jsonl_atomic_objects_paths_values' : 'json_atomic_objects_paths_values';
        return { text: [this.metadataOnlyText(file), '## 路径声明', ...lines, '## 原子对象', ...objects].join('\n'), metadata, warnings: [] };
      }
    } catch {
      metadata.parseError = true;
    }

    if (file.format === 'yaml') {
      const lines = this.flattenYamlByIndent(raw).slice(0, 3000);
      metadata.fieldCount = lines.length;
      metadata.dataPaths = lines.map(line => (line.split(':')[0] ?? '').trim()).slice(0, 200);
      metadata.contentCoverage = 'yaml_indented_paths_values';
      return { text: [this.metadataOnlyText(file), '## YAML 路径声明', ...lines].join('\n'), metadata, warnings: [] };
    }

    if (file.format === 'xml') {
      const elements = this.flattenXmlPaths(raw).slice(0, 3000);
      metadata.elementTextCount = elements.length;
      metadata.dataPaths = elements.map(line => (line.split(':')[0] ?? '').trim()).slice(0, 200);
      metadata.contentCoverage = 'xml_paths_values';
      return { text: [this.metadataOnlyText(file), '## XML 路径声明', ...elements].join('\n'), metadata, warnings: [] };
    }

    metadata.contentCoverage = 'plain_structured_text';
    return { text: [this.metadataOnlyText(file), raw].join('\n'), metadata, warnings: [] };
  }

  private extractDiagram(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const metadata: Record<string, unknown> = { extractionMode: 'diagram_structural', vectorizable: true };

    if (file.format === 'drawio') {
      const graph = this.extractDrawioGraph(raw);
      metadata.nodeTextCount = graph.nodes.length;
      metadata.edgeCount = graph.edges.length;
      metadata.contentCoverage = 'drawio_graph_links';
      return { text: [this.metadataOnlyText(file), 'Draw.io 图链路:', ...graph.links, 'Draw.io 节点:', ...graph.nodes.map(node => `[${node.id}] ${node.label}`)].join('\n'), metadata, warnings: [] };
    }

    if (file.format === 'excalidraw') {
      try {
        const graph = this.extractExcalidrawGraph(raw);
        metadata.elementTextCount = graph.nodes.length;
        metadata.edgeCount = graph.links.length;
        metadata.contentCoverage = 'excalidraw_graph_links';
        return { text: [this.metadataOnlyText(file), 'Excalidraw 图链路:', ...graph.links, 'Excalidraw 节点:', ...graph.nodes].join('\n'), metadata, warnings: [] };
      } catch {
        metadata.parseError = true;
      }
    }

    metadata.contentCoverage = 'diagram_source_text';
    return { text: [this.metadataOnlyText(file), raw].join('\n'), metadata, warnings: [] };
  }

  private extractDrawioGraph(raw: string): { nodes: Array<{ id: string; label: string }>; edges: string[]; links: string[] } {
    const cells = Array.from(raw.matchAll(/<mxCell\b([^>]*)>/gu), match => this.parseXmlAttributes(match[1] ?? ''));
    const nodes = cells
      .filter(cell => cell.value || cell.label || cell.id)
      .map((cell, index) => ({ id: String(cell.id ?? `node-${index + 1}`), label: this.stripXml(String(cell.value || cell.label || cell.id)) }))
      .filter(node => node.label);
    const nodeById = new Map(nodes.map(node => [node.id, node.label]));
    const edges = cells.filter(cell => cell.edge === '1' && cell.source && cell.target);
    const links = edges.map(edge => {
      const source = nodeById.get(String(edge.source)) ?? String(edge.source);
      const target = nodeById.get(String(edge.target)) ?? String(edge.target);
      const label = this.stripXml(String(edge.value || edge.label || '关系'));
      return `[${source}] ──> (${label}) ──> [${target}]`;
    });
    return { nodes, edges: edges.map(edge => String(edge.id ?? 'edge')), links };
  }

  private extractExcalidrawGraph(raw: string): { nodes: string[]; links: string[] } {
    type ExcalidrawElement = { id?: string; type?: string; text?: string; x?: number; y?: number; width?: number; height?: number; startBinding?: { elementId?: string }; endBinding?: { elementId?: string } };
    const parsed = JSON.parse(raw) as { elements?: ExcalidrawElement[] };
    const elements = parsed.elements ?? [];
    const textById = new Map(elements.filter(element => element.text).map(element => [String(element.id), String(element.text)]));
    const shapeLabels = elements
      .filter(element => element.type !== 'arrow' && element.type !== 'line')
      .map((element, index) => {
        const id = String(element.id ?? `node-${index + 1}`);
        const own = element.text ?? textById.get(id);
        const nested = elements.find(candidate => candidate.text && this.isPointInside(candidate, element));
        return { id, label: own ?? nested?.text ?? element.type ?? '节点' };
      });
    const labelById = new Map(shapeLabels.map(node => [node.id, node.label]));
    const links = elements
      .filter(element => element.type === 'arrow' && element.startBinding?.elementId && element.endBinding?.elementId)
      .map(element => `[${labelById.get(element.startBinding!.elementId!) ?? element.startBinding!.elementId}] ──> (箭头) ──> [${labelById.get(element.endBinding!.elementId!) ?? element.endBinding!.elementId}]`);
    const nodes = shapeLabels.map(node => `[${node.id}] ${node.label}`);
    return { nodes, links };
  }

  private isPointInside(point: { x?: number; y?: number }, box: { x?: number; y?: number; width?: number; height?: number }): boolean {
    if (point.x == null || point.y == null || box.x == null || box.y == null || box.width == null || box.height == null) return false;
    return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
  }

  private parseXmlAttributes(input: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const match of input.matchAll(/([\w:-]+)="([^"]*)"/gu)) attrs[match[1]!] = this.stripXml(match[2] ?? '');
    return attrs;
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

  private toMarkdownTable(header: string[], rows: string[][]): string {
    const width = Math.max(header.length, ...rows.map(row => row.length), 1);
    const normalizedHeader = Array.from({ length: width }, (_, index) => header[index] || `COL${index + 1}`);
    const escape = (value: unknown) => String(value ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ').trim();
    return [
      `| ${normalizedHeader.map(escape).join(' | ')} |`,
      `| ${normalizedHeader.map(() => '---').join(' | ')} |`,
      ...rows.map(row => `| ${Array.from({ length: width }, (_, index) => escape(row[index] ?? '')).join(' | ')} |`),
    ].join('\n');
  }

  private extractDelimitedText(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const delimiter = file.format === 'tsv' ? '\t' : ',';
    const rows = raw.split(/\r?\n/u).filter(line => line.trim().length > 0);
    const header = rows[0] ? this.parseDelimitedLine(rows[0], delimiter) : [];
    const tableRows = rows.slice(1).map(line => this.parseDelimitedLine(line, delimiter));
    const markdown = this.toMarkdownTable(header, tableRows);
    const legacyKv = tableRows.flatMap((values, rowIndex) => values.map((value, colIndex) => {
      const column = header[colIndex] || `COL${colIndex + 1}`;
      return `R${rowIndex + 2}C${colIndex + 1} ${column}: ${value}`;
    }));
    return {
      text: [this.metadataOnlyText(file), '工作表：默认', markdown, '表格路径声明', ...legacyKv].join('\n\n'),
      metadata: {
        extractionMode: 'delimited_text_structured',
        semanticExtractionMode: 'delimited_markdown_table',
        vectorizable: true,
        delimiter: file.format === 'tsv' ? 'tab' : 'comma',
        rowCount: rows.length,
        columnCount: header.length,
        columnNames: header.slice(0, 120),
        contentCoverage: 'markdown_table',
      },
      warnings: [],
    };
  }

  private async extractOfficeDocument(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const ext = path.extname(file.absolutePath).toLowerCase();
    if (ext === '.rtf') return this.extractRtf(file);
    if (ext === '.doc') return this.extractLegacyWordDocument(file);
    if (ext === '.ppt') return this.extractLegacyOfficeBinary(file);
    if (ext === '.docx') {
      try {
        const styledMarkdown = await this.extractDocxStyleTreeMarkdown(file.absolutePath);
        if (styledMarkdown.trim()) {
          return {
            text: styledMarkdown,
            metadata: { extractionMode: 'docx_xml_style_tree_markdown', vectorizable: true, contentCoverage: 'office_style_tree_markdown' },
            warnings: [],
          };
        }
        const mammoth = await resolveAndImport('mammoth') as any;
        const result = await mammoth.convertToMarkdown({ path: file.absolutePath });
        const text = String(result.value ?? '').trim();
        if (text) {
          return {
            text: this.normalizeMarkdownHeadings(text),
            metadata: { extractionMode: 'builtin_mammoth_markdown', vectorizable: true, contentCoverage: 'office_markdown_structure' },
            warnings: (result.messages as Array<{ message: string }>).map(m => m.message),
          };
        }
      } catch {
        // 降级到下方 Office ZIP 解析
      }
    }
    return this.extractOfficeZip(file);
  }

  private extractRtf(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const text = raw
      .replace(/\\'[0-9a-fA-F]{2}/gu, ' ')
      .replace(/\\[a-zA-Z]+-?\d* ?/gu, ' ')
      .replace(/[{}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return {
      text,
      metadata: { extractionMode: 'builtin_rtf_text', vectorizable: true, contentCoverage: 'rtf_text' },
      warnings: text ? [] : ['RTF 解析未提取到正文，未入库'],
    };
  }

  private async extractLegacyWordDocument(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const warnings: string[] = [];
    try {
      const mod = await resolveAndImport('word-extractor') as { default?: new () => { extract: (path: string) => Promise<{ getBody: () => string }> } } & (new () => { extract: (path: string) => Promise<{ getBody: () => string }> });
      const WordExtractor = mod.default ?? mod;
      const document = await new WordExtractor().extract(file.absolutePath);
      const text = document.getBody().trim();
      if (text) {
        return {
          text,
          metadata: { extractionMode: 'builtin_word_extractor', vectorizable: true, contentCoverage: 'legacy_word_full_text', textLength: text.length },
          warnings: [],
        };
      }
      warnings.push('word-extractor 未提取到正文，已降级为二进制可读文本抽取');
    } catch (error) {
      warnings.push(`word-extractor 解析失败，已降级为二进制可读文本抽取: ${error instanceof Error ? error.message : String(error)}`);
    }
    const fallback = this.extractLegacyOfficeBinary(file);
    fallback.warnings.unshift(...warnings);
    return fallback;
  }

  private extractLegacyOfficeBinary(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const strings = this.extractBinaryStrings(file.absolutePath).slice(0, 1_000);
    const text = strings.join('\n').trim();
    return {
      text,
      metadata: { extractionMode: 'builtin_legacy_office_binary_strings', vectorizable: true, contentCoverage: 'legacy_office_binary_strings', stringCount: strings.length },
      warnings: text ? [] : ['旧版 Office 二进制文件未提取到正文，未入库'],
    };
  }

  private findMergedCellValue(sheet: SpreadsheetSheet, merges: SpreadsheetRange[], row: number, col: number, XLSX: any): string | undefined {
    const merge = merges.find(item => row >= item.s.r && row <= item.e.r && col >= item.s.c && col <= item.e.c);
    if (!merge) return undefined;
    const originAddress = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
    const origin = sheet[originAddress] as SpreadsheetCell | undefined;
    return origin?.w ?? (origin?.v == null ? undefined : String(origin.v));
  }

  private async extractSpreadsheet(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const ext = path.extname(file.absolutePath).toLowerCase();
    try {
      const XLSX = await resolveAndImport('xlsx') as any;
      const workbook = XLSX.readFile(file.absolutePath, { cellDates: true, cellFormula: true, cellNF: true, cellStyles: true });
      const sheetTexts: string[] = [];
      let cellCount = 0;
      let formulaCount = 0;
      let mergeCount = 0;

      for (const name of workbook.SheetNames) {
        const sheet = workbook.Sheets[name] as SpreadsheetSheet | undefined;
        if (!sheet || !sheet['!ref']) continue;
        const range = XLSX.utils.decode_range(sheet['!ref']);
        const merges = sheet['!merges'] ?? [];
        mergeCount += merges.length;
        const matrix: string[][] = [];
        for (let row = range.s.r; row <= range.e.r; row++) {
          const values: string[] = [];
          for (let col = range.s.c; col <= range.e.c; col++) {
            const address = XLSX.utils.encode_cell({ r: row, c: col });
            const cell = sheet[address] as SpreadsheetCell | undefined;
            const mergedValue = cell ? undefined : this.findMergedCellValue(sheet, merges, row, col, XLSX);
            if (cell) {
              cellCount++;
              if (cell.f) formulaCount++;
            }
            const display = cell?.w ?? String(cell?.v ?? mergedValue ?? '');
            const formula = cell?.f ? ` 公式=${cell.f}` : '';
            values.push(`${display}${formula}`.trim());
          }
          if (values.some(Boolean)) matrix.push(values);
        }
        if (matrix.length > 0) {
          const header = matrix[0] ?? [];
          // 表格分页：为了防止超大 Excel 导致单块过大，将其每 500 行分为一个独立的 Markdown Table。
          const chunkSize = 500;
          for (let i = 1; i < matrix.length; i += chunkSize) {
            const rows = matrix.slice(i, i + chunkSize);
            const sheetSuffix = matrix.length > chunkSize ? ` (第 ${Math.floor(i/chunkSize) + 1} 部分)` : '';
            sheetTexts.push([`工作表：${name}${sheetSuffix}`, this.toMarkdownTable(header, rows)].join('\n\n'));
          }
        }
      }

      if (sheetTexts.length > 0) {
        return {
          text: sheetTexts.join('\n\n'),
          metadata: { extractionMode: 'builtin_xlsx_structured_cells', vectorizable: true, sheetCount: sheetTexts.length, sheetNames: workbook.SheetNames.slice(0, 120), cellCount, formulaCount, mergeCount, contentCoverage: 'spreadsheet_cells_formulas_merges' },
          warnings: [],
        };
      }
    } catch {
      if (ext === '.xls') return this.extractLegacyOfficeBinary(file);
      // 降级到下方 ZIP 文件内容提取
    }
    if (ext === '.xls') return this.extractLegacyOfficeBinary(file);
    return this.extractOfficeZip(file);
  }

  private async extractDocxStyleTreeMarkdown(filePath: string): Promise<string> {
    const jszipMod = await resolveAndImport('jszip');
    const JSZip = (jszipMod as Record<string, unknown>).default ?? jszipMod;
    const zip = await (JSZip as { loadAsync: (data: Buffer) => Promise<{ files: Record<string, { async: (type: string) => Promise<string> }> }> }).loadAsync(fs.readFileSync(filePath));
    const docXml = await zip.files['word/document.xml']?.async('string');
    if (!docXml) return '';
    
    // 我们需要按出现顺序提取 paragraph 和 table
    // 在 xml 中 w:body 的一级子节点通常是 w:p 和 w:tbl
    const elements = Array.from(docXml.matchAll(/<(w:p|w:tbl)[\s>][\s\S]*?<\/\1>/gu), match => ({ tag: match[1], xml: match[0] }));
    const lines: string[] = [];
    
    for (const { tag, xml } of elements) {
      if (tag === 'w:p') {
        const texts = Array.from(xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gu), match => this.stripXml(match[1] ?? '')).join('');
        if (!texts.trim()) continue;
        const style = /<w:pStyle\s+w:val="([^"]+)"/u.exec(xml)?.[1] ?? '';
        const bold = /<w:b\b/u.test(xml);
        const size = Number(/<w:sz\s+w:val="(\d+)"/u.exec(xml)?.[1] ?? 0);
        const level = this.docxHeadingLevel(style, bold, size, texts);
        lines.push(`${level > 0 ? `${'#'.repeat(level)} ` : ''}${texts.trim()}`);
      } else if (tag === 'w:tbl') {
        const trList = Array.from(xml.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/gu), match => match[0]);
        const rows: string[][] = [];
        for (const tr of trList) {
          const tcList = Array.from(tr.matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/gu), match => match[0]);
          const cols: string[] = [];
          for (const tc of tcList) {
            const tcText = Array.from(tc.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gu), match => this.stripXml(match[1] ?? '')).join('');
            cols.push(tcText.trim().replace(/\r?\n/gu, ' '));
          }
          rows.push(cols);
        }
        if (rows.length > 0) {
          const maxCols = Math.max(...rows.map(r => r.length));
          // 补齐列数
          rows.forEach(r => { while (r.length < maxCols) r.push(''); });
          
          const header = rows[0] || Array(maxCols).fill('');
          const mdTable = [
            `| ${header.join(' | ')} |`,
            `| ${header.map(() => '---').join(' | ')} |`,
            ...rows.slice(1).map(row => `| ${row.join(' | ')} |`)
          ].join('\n');
          lines.push(mdTable);
        }
      }
    }
    
    return lines.join('\n\n');
  }

  private docxHeadingLevel(style: string, bold: boolean, size: number, text: string): number {
    const normalized = style.toLowerCase();
    const heading = /heading(\d)|标题(\d)|h(\d)/iu.exec(normalized);
    const styleLevel = Number(heading?.[1] ?? heading?.[2] ?? heading?.[3] ?? 0);
    if (styleLevel >= 1 && styleLevel <= 6) return styleLevel;
    if (text.length <= 100 && size >= 32) return 1;
    if (text.length <= 100 && size >= 28) return 2;
    if (text.length <= 100 && (size >= 24 || bold)) return 3;
    return 0;
  }

  private async extractOfficeZip(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = { extractionMode: 'office_zip_text', vectorizable: true };
    try {
      const jszipMod = await resolveAndImport('jszip');
      const JSZip = (jszipMod as Record<string, unknown>).default ?? jszipMod;
      const zip = await (JSZip as { loadAsync: (data: Buffer) => Promise<{ files: Record<string, { dir: boolean; name: string; async: (type: string) => Promise<string> }> }> }).loadAsync(fs.readFileSync(file.absolutePath));
      const texts: string[] = [];
      const xmlEntries = Object.values(zip.files).filter(entry => !entry.dir && /\.(xml|rels)$/iu.test(entry.name)).slice(0, 80);
      for (const entry of xmlEntries) {
        const xml = await entry.async('text');
        const stripped = this.stripXml(xml).replace(/\s+/gu, ' ').trim();
        if (stripped) texts.push(`${entry.name}: ${stripped.slice(0, 8_000)}`);
      }
      metadata.entryCount = Object.keys(zip.files).length;
      metadata.contentCoverage = texts.length > 0 ? 'office_zip_xml_text' : 'office_zip_empty_text';
      return { text: texts.join('\n'), metadata, warnings: texts.length ? [] : ['Office/表格/演示文件未提取到正文，未入库'] };
    } catch (error) {
      metadata.extractionMode = 'office_zip_failed';
      metadata.parseError = error instanceof Error ? error.message : String(error);
      metadata.contentCoverage = 'office_zip_failed';
      return { text: '', metadata, warnings: [`Office/表格/演示文件解析失败: ${metadata.parseError}，未入库`] };
    }
  }


  private async extractRasterImage(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = { extractionMode: 'ocr_provider', vectorizable: true };
    const warnings: string[] = [];

    if (process.env.CUSTOMIZE_AGENT_DISABLE_OCR === '1') {
      metadata.extractionMode = 'raster_image_metadata';
      metadata.contentCoverage = 'metadata_filename';
      return { text: this.metadataOnlyText(file), metadata, warnings: ['OCR disabled; indexed image metadata only'] };
    }

    const validationError = this.validateRasterImage(file.absolutePath);
    if (validationError) {
      metadata.contentCoverage = 'invalid_image';
      metadata.parseError = validationError;
      return { text: '', metadata, warnings: [`图片文件无效或不完整：${validationError}，未入库`] };
    }

    const dimensions = await this.readImageDimensions(file.absolutePath);
    if (dimensions) {
      metadata.imageWidth = dimensions.width;
      metadata.imageHeight = dimensions.height;
      if (this.isTooSmallForOcr(dimensions.width, dimensions.height)) {
        metadata.contentCoverage = 'image_too_small_for_ocr';
        return { text: this.metadataOnlyText(file), metadata, warnings: [`图片尺寸过小（${dimensions.width}x${dimensions.height}），已跳过 OCR 并仅索引元数据`] };
      }
    }

    // 1. 尝试外部 PaddleOCR 命令（CUSTOMIZE_PADDLE_OCR_CMD）
    const paddleExternal = await this.tryPaddleOcrLayout(file.absolutePath);
    if (paddleExternal) {
      metadata.contentCoverage = 'paddleocr_layout_regions';
      metadata.ocrProvider = 'paddleocr-external';
      metadata.ocrRegionCount = paddleExternal.regionCount;
      return { text: [this.metadataOnlyText(file), paddleExternal.text].join('\n'), metadata, warnings };
    }

    // 2. 加载图片像素数据
    let imageData: { data: Uint8Array; width: number; height: number };
    try {
      imageData = await this.loadImagePixels(file.absolutePath);
      metadata.imageWidth = imageData.width;
      metadata.imageHeight = imageData.height;
      if (this.isTooSmallForOcr(imageData.width, imageData.height)) {
        metadata.contentCoverage = 'image_too_small_for_ocr';
        return { text: this.metadataOnlyText(file), metadata, warnings: [`图片尺寸过小（${imageData.width}x${imageData.height}），已跳过 OCR 并仅索引元数据`] };
      }
    } catch (e) {
      metadata.contentCoverage = 'image_decode_failed';
      metadata.parseError = (e as Error).message;
      return { text: '', metadata, warnings: [`图片解码失败：${(e as Error).message}，未入库`] };
    }

    // 3. OCR Provider（PaddleOCR ONNX → Tesseract CLI → Tesseract.js）
    let provider: OcrProvider | null = null;
    try {
      provider = await createOcrProvider();
      metadata.ocrProvider = provider.id;

      const ocrResult = await provider.recognize(imageData);
      const text = ocrResult.text.trim();

      if (text) {
        metadata.contentCoverage = 'ocr_provider_text';
        metadata.ocrTextLength = text.length;
        metadata.ocrConfidence = ocrResult.confidence;
        metadata.ocrRegionCount = ocrResult.regions.length;

        const regionLines = ocrResult.regions.map((r, i) =>
          `区域 ${i + 1} [置信度 ${r.confidence.toFixed(2)}] [bbox x0=${r.box.x}, y0=${r.box.y}, x1=${r.box.x + r.box.width}, y1=${r.box.y + r.box.height}]: ${r.text}`,
        );

        return {
          text: [this.metadataOnlyText(file), 'OCR 区域文本:', ...regionLines, `OCR 完整文本:\n${text}`].join('\n'),
          metadata,
          warnings,
        };
      }

      metadata.contentCoverage = 'ocr_no_text';
      warnings.push(`${metadata.ocrProvider} 未识别到文字，未生成可检索文本切片`);
      return { text: '', metadata, warnings };
    } catch (e) {
      metadata.contentCoverage = 'ocr_failed';
      metadata.parseError = (e as Error).message;
      warnings.push(`OCR 识别失败（${metadata.ocrProvider ?? 'unknown'}）：${(e as Error).message}，未入库`);
      return { text: '', metadata, warnings };
    } finally {
      await provider?.dispose();
    }
  }

  private async tryPaddleOcrLayout(filePath: string): Promise<{ text: string; regionCount: number } | undefined> {
    const command = process.env.CUSTOMIZE_PADDLE_OCR_CMD || process.env.PADDLE_OCR_CMD;
    if (!command) return undefined;
    const result = spawnSync(command, [filePath], { encoding: 'utf8', timeout: 0, maxBuffer: 50 * 1024 * 1024, shell: true });
    if (result.status !== 0 || !result.stdout.trim()) return undefined;
    try {
      const parsed = JSON.parse(result.stdout) as Array<{ type?: string; text?: string; bbox?: unknown }>;
      const lines = parsed.map((region, index) => `区域 ${index + 1} [${region.type ?? 'text'}] ${this.formatBoundingBox(region.bbox)}: ${region.text ?? ''}`);
      return { text: ['OCR 版面分析区域:', ...lines].join('\n'), regionCount: lines.length };
    } catch {
      const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
      return { text: ['OCR 版面分析区域:', ...lines].join('\n'), regionCount: lines.length };
    }
  }

  private formatBoundingBox(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    const x0 = record.x0 ?? record.left ?? record.x;
    const y0 = record.y0 ?? record.top ?? record.y;
    const x1 = record.x1 ?? record.right;
    const y1 = record.y1 ?? record.bottom;
    return [x0, y0, x1, y1].some(item => item != null) ? `[bbox x0=${x0 ?? ''}, y0=${y0 ?? ''}, x1=${x1 ?? ''}, y1=${y1 ?? ''}]` : '';
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
    const hybrid = await this.extractPdfHybridPages(file);
    if (hybrid.text.trim()) return hybrid;

    const metadata: Record<string, unknown> = { extractionMode: 'pdf_text', vectorizable: true };
    const warnings = [...hybrid.warnings];

    try {
      const raw = fs.readFileSync(file.absolutePath);
      const text = await this.extractPdfText(raw);
      if (text.trim()) {
        metadata.contentCoverage = 'pdf_text_streams_layout_markdown';
        metadata.pdfExtractor = 'pdfjs-dist';
        return { text: [this.metadataOnlyText(file), this.toMarkdownDocument(text)].join('\n\n'), metadata, warnings };
      }
    } catch (error) {
      warnings.push(`PDF 文本提取失败: ${error instanceof Error ? error.message : String(error)}`);
      metadata.parseError = error instanceof Error ? error.message : String(error);
    }

    metadata.extractionMode = 'pdf_metadata_only';
    metadata.contentCoverage = 'metadata_filename';
    metadata.ocrRecommended = true;
    metadata.ocrReason = hybrid.metadata.ocrReason ?? 'pdf_text_stream_empty_or_unavailable';
    metadata.pdfPageOcrSupported = true;
    return {
      text: this.metadataOnlyText(file),
      metadata,
      warnings: [...warnings, 'PDF 正文暂未提取到文本，已索引文件名、路径和类型元数据'],
    };
  }


  private async extractPdfHybridPages(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = {
      extractionMode: 'pdf_hybrid_pages',
      vectorizable: true,
      contentCoverage: 'pdf_page_text_plus_selective_ocr',
    };
    const warnings: string[] = [];

    // OCR Provider
    let ocrProvider: OcrProvider | null | undefined = null;
    const getOcrProvider = async (): Promise<OcrProvider> => {
      if (!ocrProvider) ocrProvider = await createOcrProvider();
      return ocrProvider;
    };

    const failedPages: Array<{ page: number; reason: string }> = [];
    const ocrPages: number[] = [];
    const ocrStrategies: Array<{ page: number; strategy: string; score: number }> = [];

    // 尝试 PyMuPDF 渲染（高质量）或降级到 pdfjs-dist
    let pageImages: string[] | null;
    let pageCount = 0;
    let renderer = 'unknown';
    const tmpDir = fs.mkdtempSync(path.join(this.getTempRoot(), 'kb-pdf-'));

    try {
      // ── 方法1: PyMuPDF（300 DPI 原生渲染，质量最高） ──
      pageImages = this.tryRenderWithPyMuPDF(file.absolutePath, tmpDir);
      if (pageImages && pageImages.length > 0) {
        renderer = 'PyMuPDF';
        pageCount = pageImages.length;
      } else {
        // ── 方法2: pdfjs-dist + canvas ──
        const jsImages = await this.tryRenderWithPdfJs(file, tmpDir);
        if (jsImages && jsImages.length > 0) {
          renderer = 'pdfjs-dist';
          pageCount = jsImages.length;
          pageImages = jsImages;
        }
      }
    } catch (e) {
      metadata.ocrRecommended = true;
      metadata.ocrReason = `PDF 渲染失败: ${(e as Error).message}`;
      return { text: '', metadata, warnings: [`PDF 渲染失败：${metadata.ocrReason}`] };
    }

    metadata.pdfPageCount = pageCount;
    metadata.pdfRenderer = renderer;

    if (!pageImages || pageImages.length === 0) {
      metadata.ocrRecommended = true;
      metadata.ocrReason = '无法渲染PDF页面';
      return { text: '', metadata, warnings: ['无法渲染PDF页面'] };
    }

    // 逐页 OCR
    const pageTexts: string[] = [];
    for (let i = 0; i < pageImages.length; i++) {
      const imgPath = pageImages[i]!;
      try {
        const dimensions = await this.readImageDimensions(imgPath);
        if (!dimensions) {
          failedPages.push({ page: i + 1, reason: 'image_dimensions_unavailable' });
          warnings.push(`PDF 第 ${i + 1} 页渲染图片无法读取尺寸，已跳过 OCR`);
          continue;
        }
        if (this.isTooSmallForOcr(dimensions.width, dimensions.height)) {
          failedPages.push({ page: i + 1, reason: `image_too_small_for_ocr_${dimensions.width}x${dimensions.height}` });
          warnings.push(`PDF 第 ${i + 1} 页渲染图片尺寸过小（${dimensions.width}x${dimensions.height}），已跳过 OCR`);
          continue;
        }
        const provider = await getOcrProvider();
        const ocrResult = await provider.recognize({
          data: new Uint8Array(0),
          width: dimensions.width, height: dimensions.height, channels: 0,
          filePath: imgPath,
        });

        const ocrText = this.cleanOcrText(ocrResult.text);
        if (ocrResult.warnings?.length) warnings.push(...ocrResult.warnings.map(item => `OCR 警告: ${item}`));
        if (ocrText) {
          ocrPages.push(i + 1);
          ocrStrategies.push({ page: i + 1, strategy: renderer, score: this.scoreOcrText(ocrText) });
          pageTexts.push(`## PDF 第 ${i + 1} 页（OCR）\n\n${ocrText}`);
        } else {
          failedPages.push({ page: i + 1, reason: 'empty_ocr' });
        }
      } catch (error) {
        failedPages.push({ page: i + 1, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    if (ocrProvider) await (ocrProvider as OcrProvider).dispose();

    // 清理临时文件
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { warnings.push('PDF OCR 临时文件清理失败'); }

    metadata.ocrAugmented = ocrPages.length > 0;
    metadata.ocrPages = ocrPages;
    metadata.ocrStrategies = ocrStrategies;
    metadata.failedPages = failedPages;
    metadata.ocrProvider = (ocrProvider as OcrProvider | null)?.id ?? 'unknown';

    if (failedPages.length > 0) {
      warnings.push(`PDF 部分页解析失败: ${failedPages.map((p) => `${p.page}:${p.reason}`).join('; ')}`);
    }

    const combined = pageTexts.join('\n\n').trim();
    return {
      text: combined ? [this.metadataOnlyText(file), combined].join('\n\n') : '',
      metadata,
      warnings,
    };
  }

  /** PyMuPDF 渲染（300 DPI 原生提取，质量远高于 pdfjs-dist） */
  private tryRenderWithPyMuPDF(pdfPath: string, outputDir: string): string[] | null {
    try {
      const workerScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'render_pdf_pages.py');
      spawnSync('python3', [workerScript, pdfPath, outputDir, '300'], {
        encoding: 'utf-8', timeout: 60_000, maxBuffer: 1024 * 1024,
      });
      // 检查输出文件（即使 Python 非零退出码也可能已渲染部分页面）
      const images: string[] = [];
      for (let i = 1; i <= 999; i++) {
        const p = path.join(outputDir, `page-${i}.png`);
        if (fs.existsSync(p) && fs.statSync(p).size > 100) images.push(p);
        else break;
      }
      return images.length > 0 ? images : null;
    } catch {
      return null;
    }
  }

  /** pdfjs-dist + canvas 渲染（降级方案） */
  private async tryRenderWithPdfJs(file: ClassifiedFile, outputDir: string): Promise<string[] | null> {
    try {
      const canvasMod: any = await resolveAndImport('@napi-rs/canvas');
      const pdfjsLib: any = await resolveAndImport('pdfjs-dist/legacy/build/pdf.mjs');
      const sharpMod = await resolveAndImport('sharp');
      const createCanvas = (canvasMod as any).createCanvas ?? (canvasMod as any).default?.createCanvas;
      const sharpFn = (sharpMod as any).default ?? sharpMod;
      if (!createCanvas || !sharpFn) return null;

      const raw = fs.readFileSync(file.absolutePath);
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(raw), verbosity: 0 }).promise;
      const pageCount = doc.numPages;
      const images: string[] = [];

      for (let i = 1; i <= pageCount; i++) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 4 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        const pngPath = path.join(outputDir, `page-${i}.png`);
        await sharpFn(canvas.toBuffer('image/png'))
          .removeAlpha().normalize().linear(3.0, -150)
          .withMetadata({ density: 288 }).png().toFile(pngPath);
        images.push(pngPath);
      }
      await doc.destroy();
      return images.length > 0 ? images : null;
    } catch { return null; }
  }

  private scoreOcrText(value: string): number {
    const text = String(value ?? '').trim();
    const normalizedLength = this.normalizedTextLength(text);
    const cjkCount = (text.match(/[\p{Script=Han}]/gu) ?? []).length;
    const latinCount = (text.match(/[A-Za-z]/g) ?? []).length;
    const replacementCount = (text.match(/[�□]/gu) ?? []).length;
    return cjkCount * 8 + normalizedLength - latinCount * 0.8 - replacementCount * 10;
  }

  private cleanOcrText(value: string): string {
    return String(value ?? '')
      .replace(/[ \t]+/gu, ' ')
      .replace(/([\p{Script=Han}])\s+([\p{Script=Han}])/gu, '$1$2')
      .replace(/([\p{Script=Han}])\s+([，。；：！？、）】》])/gu, '$1$2')
      .replace(/([（【《])\s+([\p{Script=Han}])/gu, '$1$2')
      .replace(/\n{3,}/gu, '\n\n')
      .trim();
  }

  /** 加载图片像素数据（依赖 sharp） */
  private async loadImagePixels(filePath: string): Promise<{ data: Uint8Array; width: number; height: number }> {
    const sharpMod: any = await resolveAndImport('sharp');
    const sharpFn = sharpMod.default ?? sharpMod;
    const { data, info } = await sharpFn(filePath).raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data as Buffer), width: info.width as number, height: info.height as number };
  }

  private async readImageDimensions(filePath: string): Promise<{ width: number; height: number } | undefined> {
    try {
      const sharpMod: any = await resolveAndImport('sharp');
      const sharpFn = sharpMod.default ?? sharpMod;
      const metadata = await sharpFn(filePath).metadata();
      const width = Number(metadata.width ?? 0);
      const height = Number(metadata.height ?? 0);
      return width > 0 && height > 0 ? { width, height } : undefined;
    } catch {
      return undefined;
    }
  }

  private isTooSmallForOcr(width: number, height: number): boolean {
    return width < 8 || height < 8 || width * height < 128;
  }

  private async extractPdfText(buffer: Buffer): Promise<string> {
    let pdfjsText = '';
    // 第一层：pdfjs-dist 文本提取（处理压缩内容流、CJK 字体、现代 PDF）
    try {
      const mod = await resolveAndImport('pdfjs-dist/legacy/build/pdf.mjs') as any;
      const loadingTask = mod.getDocument({ data: new Uint8Array(buffer), verbosity: 0 as number });
      const doc = await loadingTask.promise;
      const pages: string[] = [];
      const pageLimit = doc.numPages;
      for (let i = 1; i <= pageLimit; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: true });
        const items = content.items
          .map((item: unknown) => this.toPdfTextItem(item))
          .filter((item: PdfTextItem | undefined): item is PdfTextItem => !!item && item.str.trim().length > 0);
        const pageText = this.layoutPdfTextItems(items, i);

        if (pageText.trim()) pages.push(pageText.trim());
      }
      await doc.destroy();
      pdfjsText = pages.join('\n\n').trim();

    } catch (e) {
      if (process.env.KB_DEBUG === '1') console.warn('[kb] pdfjs-dist extraction failed:', (e as Error).message);
    }

    // 第二层：pdf-parse（兼容旧版 PDF），适配 v1.x 函数导出 和 v2.x 类导出
    try {
      const mod = await resolveAndImport('pdf-parse');
      let pdfParse: ((data: Buffer) => Promise<{ text: string }>) | undefined;

      // v1.x: module.exports = function(buffer) { ... }
      if (typeof mod === 'function') {
        pdfParse = mod as (data: Buffer) => Promise<{ text: string }>;
      }
      // v1.x ESM: { default: function(buffer) { ... } }
      else if (mod && typeof (mod as Record<string, unknown>).default === 'function') {
        pdfParse = (mod as Record<string, unknown>).default as (data: Buffer) => Promise<{ text: string }>;
      }
      // v2.x: { PDFParse: class { parse(buffer) { ... } } }
      else if (mod && typeof (mod as Record<string, unknown>).PDFParse === 'function') {
        const PDFParse = (mod as Record<string, unknown>).PDFParse as new () => { parse: (data: Buffer) => Promise<{ text: string }> };
        pdfParse = (buf: Buffer) => new PDFParse().parse(buf);
      }

      if (pdfParse) {
        const result = await pdfParse(buffer);
        const parseText = (result?.text ?? '').trim();
        if (pdfjsText && parseText && this.normalizedTextLength(parseText) > this.normalizedTextLength(pdfjsText) * 1.08) return [pdfjsText, '## PDF 备用解析文本', parseText].join('\n\n');
        if (parseText && !pdfjsText) return parseText;
      }
    } catch {
      // pdfjs 结果已可用时忽略备用解析器失败
    }

    if (pdfjsText) return pdfjsText;

    // 第三层：raw regex 回退（未压缩的古老 PDF）
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

  private normalizedTextLength(value: string): number {
    return value.replace(/\s+/gu, '').length;
  }

  private toPdfTextItem(item: unknown): PdfTextItem | undefined {
    if (!item || typeof item !== 'object' || !('str' in item)) return undefined;
    const record = item as Record<string, unknown>;
    const transform = Array.isArray(record.transform) ? record.transform as number[] : [];
    return {
      str: String(record.str ?? ''),
      x: Number(transform[4] ?? 0),
      y: Number(transform[5] ?? 0),
      width: Number(record.width ?? 0),
      height: Number(record.height ?? Math.abs(Number(transform[3] ?? 0))),
      fontName: typeof record.fontName === 'string' ? record.fontName : undefined,
    };
  }

  private layoutPdfTextItems(items: PdfTextItem[], pageNumber: number): string {
    if (items.length === 0) return '';
    const rows = this.groupPdfItemsIntoRows(items);
    const columnSplit = this.detectPdfColumnSplit(rows);
    const orderedRows = columnSplit == null
      ? rows.sort((a, b) => b.y - a.y || a.x - b.x)
      : [
          ...rows.filter(row => row.x < columnSplit).sort((a, b) => b.y - a.y || a.x - b.x),
          ...rows.filter(row => row.x >= columnSplit).sort((a, b) => b.y - a.y || a.x - b.x),
        ];
    const markdown = this.rowsToPdfMarkdownWithTables(orderedRows);
    return [`## PDF 第 ${pageNumber} 页`, markdown].join('\n\n');
  }

  private joinPdfRowText(items: PdfTextItem[]): string {
    let output = '';
    let previous: PdfTextItem | undefined;
    for (const item of items) {
      const text = item.str.trim();
      if (!text) continue;
      if (!previous) {
        output += text;
      } else {
        const gap = item.x - (previous.x + previous.width);
        const cjkJoin = /[\p{Script=Han}（(《“‘]$/u.test(output) || /^[\p{Script=Han}）)》”’、，。；：！？]/u.test(text);
        output += gap > Math.max(3, previous.height * 0.35) && !cjkJoin ? ` ${text}` : text;
      }
      previous = item;
    }
    return output.replace(/\s+/gu, ' ').trim();
  }

  private groupPdfItemsIntoRows(items: PdfTextItem[]): Array<{ text: string; x: number; y: number; height: number }> {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: Array<{ items: PdfTextItem[]; y: number }> = [];
    for (const item of sorted) {
      const row = rows.find(candidate => Math.abs(candidate.y - item.y) <= Math.max(2, item.height * 0.55));
      if (row) row.items.push(item);
      else rows.push({ y: item.y, items: [item] });
    }
    return rows.map(row => {
      const rowItems = row.items.sort((a, b) => a.x - b.x);
      return {
        text: this.joinPdfRowText(rowItems),
        x: Math.min(...rowItems.map(item => item.x)),
        y: row.y,
        height: Math.max(...rowItems.map(item => item.height || 0)),
      };
    }).filter(row => row.text);
  }

  private detectPdfColumnSplit(rows: Array<{ x: number; text: string }>): number | undefined {
    if (rows.length < 8) return undefined;
    const xs = rows.map(row => row.x).sort((a, b) => a - b);
    const gaps = xs.slice(1).map((x, index) => ({ gap: x - xs[index]!, left: xs[index]!, right: x })).sort((a, b) => b.gap - a.gap);
    const largest = gaps[0];
    if (!largest || largest.gap < 80) return undefined;
    const leftCount = rows.filter(row => row.x <= largest.left).length;
    const rightCount = rows.filter(row => row.x >= largest.right).length;
    return leftCount >= 3 && rightCount >= 3 ? (largest.left + largest.right) / 2 : undefined;
  }

  private rowsToPdfMarkdownWithTables(rows: Array<{ text: string; height: number }>): string {
    const output: string[] = [];
    let index = 0;
    while (index < rows.length) {
      const tableRows: string[][] = [];
      let cursor = index;
      while (cursor < rows.length) {
        const cells = this.splitLikelyTableRow(rows[cursor]!.text);
        if (cells.length < 2) break;
        tableRows.push(cells);
        cursor += 1;
      }
      if (tableRows.length >= 2) {
        output.push('### PDF 表格区域');
        output.push(this.toMarkdownTable(tableRows[0]!, tableRows.slice(1)));
        index = cursor;
        continue;
      }
      output.push(this.pdfRowToMarkdown(rows[index]!.text, rows[index]!.height, index));
      index += 1;
    }
    return output.join('\n');
  }

  private splitLikelyTableRow(text: string): string[] {
    const byLargeSpaces = text.split(/\s{2,}/u).map(cell => cell.trim()).filter(Boolean);
    if (byLargeSpaces.length >= 2) return byLargeSpaces;
    const byPipes = text.split('|').map(cell => cell.trim()).filter(Boolean);
    return byPipes.length >= 2 ? byPipes : [];
  }

  private pdfRowToMarkdown(text: string, height: number, index: number): string {
    if (index === 0 && text.length <= 100) return `# ${text}`;
    if (height >= 14 && text.length <= 120) return `## ${text}`;
    if (/^(第[一二三四五六七八九十\d]+[章节]|\d+(?:\.\d+)*\s+)/u.test(text) && text.length <= 120) return `### ${text}`;
    return text;
  }

  private toMarkdownDocument(text: string): string {
    const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    return lines.map((line, index) => {
      if (/^#{1,6}\s/u.test(line) || /^\|/u.test(line)) return line;
      if (line.length <= 80 && !/[。！？.!?]$/u.test(line)) {
        if (index === 0) return `# ${line}`;
        if (/^(第[一二三四五六七八九十\d]+[章节]|\d+(?:\.\d+)*\s+)/u.test(line)) return `## ${line}`;
        return `### ${line}`;
      }
      return line;
    }).join('\n\n');
  }

  private normalizeMarkdownHeadings(text: string): string {
    return text
      .split(/\r?\n/u)
      .map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        if (/^#{1,6}\s/u.test(trimmed) || /^\|/u.test(trimmed)) return trimmed;
        if (trimmed.length <= 80 && /^(第[一二三四五六七八九十\d]+[章节]|\d+(?:\.\d+)*\s+)/u.test(trimmed)) return `## ${trimmed}`;
        return trimmed;
      })
      .join('\n');
  }

  private extractSvg(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const nodes = this.extractSvgSemanticNodes(raw);
    return {
      text: [this.metadataOnlyText(file), 'SVG 层级语义节点:', ...nodes].join('\n'),
      metadata: { extractionMode: 'svg_text_nodes', semanticExtractionMode: 'svg_semantic_tree_nodes', vectorizable: true, textNodeCount: nodes.length, contentCoverage: 'svg_hierarchical_text_title_desc' },
      warnings: [],
    };
  }

  private extractSvgSemanticNodes(raw: string): string[] {
    const nodes: string[] = [];
    const stack: string[] = [];
    const tokenPattern = /<\/?([A-Za-z_][\w:.-]*)\b([^>]*)>|([^<>]+)/gu;
    for (const match of raw.matchAll(tokenPattern)) {
      const tag = match[1];
      const attrs = match[2] ?? '';
      const text = match[3]?.replace(/\s+/gu, ' ').trim();
      const token = match[0];
      if (tag && token.startsWith('</')) stack.pop();
      else if (tag && !token.endsWith('/>')) {
        const id = /\bid="([^"]+)"/u.exec(attrs)?.[1];
        stack.push(id ? `${tag}#${id}` : tag);
      } else if (text && ['text', 'title', 'desc'].includes(stack.at(-1)?.split('#')[0] ?? '')) {
        nodes.push(`${stack.join(' > ')}: ${this.stripXml(text)}`);
      }
    }
    return nodes;
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
      return value.flatMap((item, index) => this.flattenJson(item, `${prefix}[${index}]`));
    }
    if (typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => this.flattenJson(item, prefix ? `${prefix}.${key}` : key));
    }
    return [];
  }

  private atomicJsonObjects(value: unknown, prefix = '$'): string[] {
    if (value == null || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap((item, index) => this.atomicJsonObjects(item, `${prefix}[${index}]`));
    const entries = Object.entries(value as Record<string, unknown>);
    const current = `${prefix}: ${JSON.stringify(value)}`;
    const children = entries.flatMap(([key, item]) => this.atomicJsonObjects(item, `${prefix}.${key}`));
    return [current, ...children];
  }

  private flattenYamlByIndent(raw: string): string[] {
    const stack: Array<{ indent: number; key: string }> = [];
    const lines: string[] = [];
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.trim() || /^\s*#/u.test(line)) continue;
      const match = /^(\s*)([-\w.]+)\s*:\s*(.*)$/u.exec(line);
      if (!match) continue;
      const indent = match[1]!.length;
      const key = match[2]!;
      const value = match[3]!.trim();
      while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();
      const pathName = [...stack.map(item => item.key), key].join('.');
      if (value) lines.push(`${pathName}: ${value}`);
      stack.push({ indent, key });
    }
    return lines;
  }

  private flattenXmlPaths(raw: string): string[] {
    const lines: string[] = [];
    const stack: string[] = [];
    const tokenPattern = /<\/?([A-Za-z_][\w:.-]*)\b[^>]*>|([^<>]+)/gu;
    for (const match of raw.matchAll(tokenPattern)) {
      const tag = match[1];
      const text = match[2]?.replace(/\s+/gu, ' ').trim();
      const token = match[0];
      if (tag && token.startsWith('</')) stack.pop();
      else if (tag && !token.endsWith('/>')) stack.push(tag);
      else if (text && stack.length > 0) lines.push(`${stack.join('.')}: ${this.stripXml(text)}`);
    }
    return lines.filter(line => !line.endsWith(':'));
  }

  private metadataOnlyText(file: ClassifiedFile): string {
    return [
      `资料类型: ${file.category}/${file.format}`,
      `MIME: ${file.mimeType}`,
      `文件大小: ${file.fileSize} bytes`,
    ].join('\n');
  }
}
