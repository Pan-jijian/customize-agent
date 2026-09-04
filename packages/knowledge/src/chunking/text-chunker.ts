import { BgeTokenizer } from './bge-tokenizer.js';
import type { ClassifiedFile, FileCategory } from '../types.js';

/** 文本切片结果 */
export interface TextChunk {
  index: number;
  text: string;
  startChar: number;
  endChar: number;
  tokenCount: number;
  sectionTitle?: string;
  metadata: Record<string, unknown>;
}

/** 切片配置参数 */
export interface ChunkConfig {
  maxChunkSize: number;
  overlap: number;
}

type ChunkKind = 'text' | 'table' | 'data' | 'code' | 'metadata';

type ChunkCandidate = {
  text: string;
  startChar: number;
  endChar: number;
  sectionTitle?: string;
  titlePath?: string;
  kind: ChunkKind;
  parentId: string;
  parentIndex: number;
  childIndex: number;
  rowRange?: string;
  parentText?: string;
};

type CodeLanguageConfig = {
  delimiters: RegExp;
  blockStart: RegExp;
  indentSensitive: boolean;
};

const DEFAULT_CONFIGS: Record<FileCategory, ChunkConfig> = {
  document: { maxChunkSize: 800, overlap: 100 },
  spreadsheet: { maxChunkSize: 1000, overlap: 120 },
  image: { maxChunkSize: 512, overlap: 0 },
  cad: { maxChunkSize: 600, overlap: 80 },
  code: { maxChunkSize: 1000, overlap: 120 },
  data: { maxChunkSize: 600, overlap: 80 },
  web: { maxChunkSize: 800, overlap: 100 },
  diagram: { maxChunkSize: 512, overlap: 0 },
  archive: { maxChunkSize: 500, overlap: 50 },
  other: { maxChunkSize: 500, overlap: 50 },
};

const RECURSIVE_SEPARATORS = [
  /\n(?=#{1,6}\s)/u,
  /\n{2,}/u,
  /\n(?=(?:第[一二三四五六七八九十百千万\d]+[章节条]|[一二三四五六七八九十]+、|\d+[.)、]))/u,
  /(?<=[。！？；])\s+/u,
  /(?<=[，、])\s+/u,
  /\s+/u,
] as const;

const LANGUAGE_ROUTER: Record<string, CodeLanguageConfig> = {
  typescript: { delimiters: /\n(?=(?:export\s+)?(?:async\s+)?(?:class|function|interface|type|const|let)\s)/u, blockStart: /\{\s*$/u, indentSensitive: false },
  javascript: { delimiters: /\n(?=(?:export\s+)?(?:async\s+)?(?:class|function|const|let)\s)/u, blockStart: /\{\s*$/u, indentSensitive: false },
  python: { delimiters: /\n(?=(?:class|def)\s)/u, blockStart: /:\s*$/u, indentSensitive: true },
  go: { delimiters: /\n(?=(?:func|type|struct|interface)\s)/u, blockStart: /\{\s*$/u, indentSensitive: false },
  java: { delimiters: /\n(?=(?:public|protected|private|static|final|abstract|\s)*(?:class|interface|enum|(?:\w|<|>|\[|\])+\s+\w+\s*\())/u, blockStart: /\{\s*$/u, indentSensitive: false },
  csharp: { delimiters: /\n(?=(?:public|protected|private|internal|static|sealed|abstract|\s)*(?:class|interface|enum|(?:\w|<|>|\[|\])+\s+\w+\s*\())/u, blockStart: /\{\s*$/u, indentSensitive: false },
  cpp: { delimiters: /\n(?=(?:class|struct|namespace|template)\s|[\w:*&<>]+\s+\w+\s*\()/u, blockStart: /\{\s*$/u, indentSensitive: false },
  c: { delimiters: /\n(?=(?:struct|enum)\s|[\w*]+\s+\w+\s*\()/u, blockStart: /\{\s*$/u, indentSensitive: false },
};

/** 文本切片器，支持文档、表格、代码等多类型文件的递归式切片 */
export class TextChunker {
  private readonly tokenizer = new BgeTokenizer();

  /**
   * 将文本内容按类型和配置分割为切片
   * @param text 原始文本内容
   * @param file 已分类的文件信息
   * @param metadata 额外元数据
   * @returns 切片列表
   */
  chunk(text: string, file: ClassifiedFile, metadata: Record<string, unknown> = {}): TextChunk[] {
    const source = text.trim();
    if (source.length === 0) return [];

    const config = DEFAULT_CONFIGS[file.category];
    const normalized = source;
    const rawCandidates = this.createCandidates(normalized, file, config);
    const candidates = this.enforceCandidateLimit(rawCandidates, config);

    return candidates.map((candidate, index) => this.createChunk(index, candidate, file, metadata));
  }

  private createCandidates(text: string, file: ClassifiedFile, config: ChunkConfig): ChunkCandidate[] {
    if (file.category === 'spreadsheet' || this.hasMarkdownTableBlock(text)) return this.createMixedTableCandidates(text, file.category, config);
    if (file.category === 'data') return this.createDataCandidates(text, config);
    if (file.category === 'code') return this.createCodeCandidates(text, file, config);
    return this.createTextCandidates(text, file.category, config);
  }

  private createTextCandidates(text: string, category: FileCategory, config: ChunkConfig): ChunkCandidate[] {
    const sections = this.mergeSmallSections(this.splitIntoSections(text, category), config);
    const candidates: ChunkCandidate[] = [];
    const titlePaths = this.buildTitlePaths(sections);

    sections.forEach((section, parentIndex) => {
      const parentId = `p${parentIndex}`;
      const parts = this.mergeLeadingHeader(this.recursiveSplit(section.text, config.maxChunkSize));
      const merged = this.mergeParts(parts, config.maxChunkSize, config.overlap);
      // 顺序锚定定位（而非从头 indexOf）：图纸/表格类文本存在大量重复标注（如“Φ10@200”、
      // 参数行随章节重复），从头 indexOf(part 前缀) 会命中首次出现的相同文本，导致
      // start_char 大幅跳变/回退、相邻块出现虚假间隙。lookBehind 回溯窗口覆盖
      // mergeParts 的 overlap 重叠长度上限，保证重叠块命中真实起点。
      const offsets = this.chunkPartStartOffsets(section.text, merged, 4096);
      merged.forEach((part, childIndex) => {
        const startChar = section.startChar + (offsets[childIndex] ?? 0);
        candidates.push({
          text: part,
          startChar,
          endChar: startChar + part.length,
          sectionTitle: section.title,
          titlePath: titlePaths[parentIndex],
          kind: this.kindForCategory(category),
          parentId,
          parentIndex,
          childIndex,
          parentText: section.text, // <=== 记录原始完整的 Section 文本
        });
      });
    });

    return candidates;
  }

  private createMixedTableCandidates(text: string, category: FileCategory, config: ChunkConfig): ChunkCandidate[] {
    const tableBlocks = this.extractMarkdownTableBlocks(text);
    if (tableBlocks.length === 0) return this.createTextCandidates(text, category, config);

    const candidates: ChunkCandidate[] = [];
    let cursor = 0;
    tableBlocks.forEach((block, parentIndex) => {
      const beforeStart = cursor;
      const before = text.slice(beforeStart, block.startChar).trim();
      if (before) {
        candidates.push(...this.createTextCandidates(before, category, config).map(candidate => ({
          ...candidate,
          startChar: candidate.startChar + beforeStart,
          endChar: candidate.endChar + beforeStart,
        })));
      }
      const sectionTitle = this.extractSectionTitle(block.text) ?? '表格数据';
      const tableParts = this.splitMarkdownTable(block.text, config.maxChunkSize);
      const offsets = this.chunkPartStartOffsets(block.text, tableParts, 4096);
      tableParts.forEach((part, childIndex) => {
        const startChar = block.startChar + (offsets[childIndex] ?? 0);
        candidates.push({
          text: part,
          startChar,
          endChar: startChar + part.length,
          sectionTitle,
          titlePath: sectionTitle,
          kind: 'table',
          parentId: `table-${parentIndex}`,
          parentIndex,
          childIndex,
          rowRange: this.extractMarkdownTableRowRange(part),
          parentText: block.text,
        });
      });
      cursor = block.startChar + block.text.length;
    });
    const afterStart = cursor;
    const after = text.slice(afterStart).trim();
    if (after) {
      candidates.push(...this.createTextCandidates(after, category, config).map(candidate => ({
        ...candidate,
        startChar: candidate.startChar + afterStart,
        endChar: candidate.endChar + afterStart,
      })));
    }
    return candidates;
  }

  private createDataCandidates(text: string, config: ChunkConfig): ChunkCandidate[] {
    const sections = text.split(/\n(?=[\w.[\]-]+[:：]\s)|\n{2,}/u).map(part => part.trim()).filter(Boolean);
    const parts = sections.length > 1 ? sections : this.recursiveSplit(text, config.maxChunkSize);
    const merged = this.mergeParts(parts, config.maxChunkSize, config.overlap);
    const offsets = this.chunkPartStartOffsets(text, merged, 4096);
    return merged.map((part, index) => {
      const startChar = offsets[index] ?? 0;
      return {
        text: part,
        startChar,
        endChar: startChar + part.length,
        sectionTitle: this.extractSectionTitle(part),
        titlePath: this.extractSectionTitle(part),
        kind: 'data',
        parentId: `data-0`,
        parentIndex: 0,
        childIndex: index,
        parentText: text,
      };
    });
  }

  private createCodeCandidates(text: string, file: ClassifiedFile, config: ChunkConfig): ChunkCandidate[] {
    const language = this.normalizeCodeLanguage(file.format);
    const languageConfig = LANGUAGE_ROUTER[language];
    const blocks = languageConfig
      ? this.splitCodeByLanguage(text, languageConfig)
      : this.splitCodeByStructuralFallback(text);
    const parts = blocks.length > 1 ? blocks : this.recursiveSplit(text, config.maxChunkSize);
    const merged = this.mergeParts(parts, config.maxChunkSize, config.overlap);
    const offsets = this.chunkPartStartOffsets(text, merged, 4096);
    return merged.map((part, index) => {
      const startChar = offsets[index] ?? 0;
      return {
        text: part,
        startChar,
        endChar: startChar + part.length,
        sectionTitle: this.extractSectionTitle(part),
        titlePath: this.extractSectionTitle(part),
        kind: 'code',
        parentId: `code-${language}-0`,
        parentIndex: 0,
        childIndex: index,
        parentText: text,
      };
    });
  }

  private normalizeCodeLanguage(format: string): string {
    const aliases: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', typescript: 'typescript',
      js: 'javascript', jsx: 'javascript', javascript: 'javascript',
      py: 'python', python: 'python',
      golang: 'go', go: 'go',
      java: 'java', cs: 'csharp', csharp: 'csharp',
      cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
      c: 'c', h: 'c',
    };
    return aliases[format.toLowerCase()] ?? format.toLowerCase();
  }

  private splitCodeByLanguage(text: string, config: CodeLanguageConfig): string[] {
    const raw = text.split(config.delimiters).map(part => part.trim()).filter(Boolean);
    if (raw.length <= 1) return raw;
    return raw.flatMap(block => config.indentSensitive ? this.collectIndentSensitiveBlocks(block, config) : this.collectBraceBalancedBlocks(block, config));
  }

  private collectIndentSensitiveBlocks(block: string, config: CodeLanguageConfig): string[] {
    const lines = block.split(/\r?\n/u);
    const result: string[] = [];
    let current: string[] = [];
    let baseIndent: number | undefined;
    for (const line of lines) {
      const indent = line.match(/^\s*/u)?.[0].length ?? 0;
      if (current.length > 0 && baseIndent != null && indent <= baseIndent && config.blockStart.test(current[0] ?? '') && line.trim()) {
        result.push(current.join('\n').trim());
        current = [];
        baseIndent = undefined;
      }
      if (current.length === 0) baseIndent = indent;
      current.push(line);
    }
    if (current.length > 0) result.push(current.join('\n').trim());
    return result.filter(Boolean);
  }

  private collectBraceBalancedBlocks(block: string, _config: CodeLanguageConfig): string[] {
    const lines = block.split(/\r?\n/u);
    const result: string[] = [];
    let current: string[] = [];
    let depth = 0;
    for (const line of lines) {
      current.push(line);
      depth += (line.match(/\{/gu) ?? []).length;
      depth -= (line.match(/\}/gu) ?? []).length;
      if (current.length > 1 && depth <= 0) {
        result.push(current.join('\n').trim());
        current = [];
        depth = 0;
      }
    }
    if (current.length > 0) result.push(current.join('\n').trim());
    return result.filter(Boolean);
  }

  private splitCodeByStructuralFallback(text: string): string[] {
    const blocks = this.collectBraceBalancedBlocks(text, { delimiters: /\n/u, blockStart: /\{\s*$/u, indentSensitive: false });
    if (blocks.length > 1) return blocks;
    return text.split(/\n(?=\S)/u).map(part => part.trim()).filter(Boolean);
  }

  private splitIntoSections(text: string, category: FileCategory): Array<{ text: string; startChar: number; title?: string }> {
    const pattern = category === 'cad' || category === 'diagram'
      ? /\n{2,}/u
      : /\n(?=#{1,6}\s)|\n{2,}/u;
    const rawSections = this.mergeLeadingHeader(text.split(pattern).map(part => part.trim()).filter(Boolean));
    let cursor = 0;
    return rawSections.map(section => {
      const startChar = Math.max(cursor, text.indexOf(section, cursor));
      cursor = startChar + section.length;
      return { text: section, startChar, title: this.extractSectionTitle(section) };
    });
  }

  private mergeSmallSections(sections: Array<{ text: string; startChar: number; title?: string }>, config: ChunkConfig): Array<{ text: string; startChar: number; title?: string }> {
    const merged: Array<{ text: string; startChar: number; title?: string }> = [];
    let current: { text: string; startChar: number; title?: string } | undefined;
    const targetTokens = Math.max(80, Math.floor(config.maxChunkSize * 0.75));

    for (const section of sections) {
      if (!current) {
        current = { ...section };
        continue;
      }
      // 二级标题节（如 “## PDF 第 N 页（OCR）”）是文档顶级结构边界，不与前一节合并：
      // 否则页/章内容会被并入其他节，section_title 错挂到上一节首标题，用户按标题浏览时找不到该页内容
      if (/^#{2}\s/u.test(section.text.trim())) {
        merged.push(current);
        current = { ...section };
        continue;
      }
      const candidateText = `${current.text}\n\n${section.text}`;
      const currentTokens = this.estimateTokens(current.text);
      if (currentTokens < targetTokens && this.estimateTokens(candidateText) <= config.maxChunkSize) {
        current = { ...current, text: candidateText, title: current.title ?? section.title };
      } else {
        merged.push(current);
        current = { ...section };
      }
    }
    if (current) merged.push(current);
    return merged;
  }

  private mergeLeadingHeader(sections: string[]): string[] {
    if (sections.length < 2) return sections;
    const first = sections[0];
    if (!first) return sections;
    const isHeader = /^文件[:：].+\n类型[:：]/u.test(first) && this.estimateTokens(first) < 80;
    if (!isHeader) return sections;
    return [`${first}\n\n${sections[1]}`, ...sections.slice(2)];
  }

  private recursiveSplit(text: string, maxTokens: number, separatorIndex = 0): string[] {
    if (this.estimateTokens(text) <= maxTokens) return [text.trim()].filter(Boolean);
    if (this.isMarkdownTable(text)) return this.splitMarkdownTable(text, maxTokens);
    if (separatorIndex >= RECURSIVE_SEPARATORS.length) return this.splitBySentenceBoundary(text, maxTokens);

    const separator = RECURSIVE_SEPARATORS[separatorIndex];
    if (!separator) return this.splitBySentenceBoundary(text, maxTokens);
    const parts = text.split(separator).map(part => part.trim()).filter(Boolean);
    if (parts.length <= 1 || parts.some(part => part === text)) return this.recursiveSplit(text, maxTokens, separatorIndex + 1);

    return parts.flatMap(part => this.recursiveSplit(part, maxTokens, separatorIndex + 1));
  }

  private mergeParts(parts: string[], maxTokens: number, overlapTokens: number): string[] {
    const chunks: string[] = [];
    let buffer = '';

    for (const part of parts) {
      const candidate = buffer ? `${buffer}\n${part}` : part;
      if (buffer && this.estimateTokens(candidate) > maxTokens) {
        chunks.push(buffer);
        const overlap = this.takeOverlap(buffer, overlapTokens);
        buffer = overlap ? `${overlap}\n${part}` : part;
      } else {
        buffer = candidate;
      }
    }

    if (buffer.trim()) chunks.push(buffer);
    return chunks.flatMap(chunk => this.estimateTokens(chunk) > maxTokens ? this.splitByWindow(chunk, maxTokens, overlapTokens) : [chunk]);
  }

  private splitByWindow(text: string, maxTokens: number, overlapTokens = 0): string[] {
    if (this.hasLongUnbrokenSegment(text) && text.length > Math.max(2000, maxTokens * 3)) {
      const maxChars = Math.max(1, maxTokens);
      const overlapChars = Math.max(0, Math.min(Math.floor(maxChars / 2), overlapTokens));
      const step = Math.max(1, maxChars - overlapChars);
      const chunks: string[] = [];
      for (let start = 0; start < text.length; start += step) {
        chunks.push(text.slice(start, start + maxChars).trim());
        if (start + maxChars >= text.length) break;
      }
      return chunks.filter(Boolean);
    }
    const tokens = this.tokenizer.encode(text);
    if (tokens.length <= maxTokens) return [text.trim()].filter(Boolean);
    const maxChars = Math.max(200, Math.ceil(text.length * (maxTokens / Math.max(1, tokens.length))));
    const overlapChars = Math.max(0, Math.ceil(text.length * (overlapTokens / Math.max(1, tokens.length))));
    const step = Math.max(1, maxChars - overlapChars);
    const chunks: string[] = [];
    for (let start = 0; start < text.length; start += step) {
      chunks.push(text.slice(start, start + maxChars).trim());
      if (start + maxChars >= text.length) break;
    }
    return chunks.filter(Boolean);
  }

  private splitBySentenceBoundary(text: string, maxTokens: number): string[] {
    const units = text.split(/(?<=[。？！；;.!?])\s+|(?<=[。？！；;.!?])/u).map(part => part.trim()).filter(Boolean);
    if (units.length <= 1) return this.splitByWindow(text, maxTokens);
    return this.mergeParts(units, maxTokens, 0);
  }

  private isMarkdownTable(text: string): boolean {
    const lines = text.trim().split(/\r?\n/u);
    return lines.length >= 3 && lines.some(line => /^\s*\|?\s*:?-{3,}:?\s*\|/u.test(line));
  }

  private hasMarkdownTableBlock(text: string): boolean {
    return /^\s*\|?\s*:?-{3,}:?\s*\|/mu.test(text);
  }

  private extractMarkdownTableBlocks(text: string): Array<{ text: string; startChar: number }> {
    const lines = text.split(/\r?\n/u);
    const lineStarts: number[] = [];
    let cursor = 0;
    for (const line of lines) {
      lineStarts.push(cursor);
      cursor += line.length + 1;
    }

    const blocks: Array<{ text: string; startChar: number }> = [];
    let index = 0;
    while (index < lines.length) {
      const separatorIndex = lines.findIndex((line, lineIndex) => lineIndex >= index && /^\s*\|?\s*:?-{3,}:?\s*\|/u.test(line));
      if (separatorIndex <= index) break;

      const headerIndex = separatorIndex - 1;
      let startLine = headerIndex;
      const titleIndex = headerIndex - 1;
      if (titleIndex >= 0 && lines[titleIndex]?.trim() === '' && titleIndex - 1 >= 0) {
        const title = lines[titleIndex - 1]?.trim() ?? '';
        if (title && title.length <= 120 && !/^\s*\|/u.test(title)) startLine = titleIndex - 1;
      }

      let endLine = separatorIndex + 1;
      while (endLine < lines.length && /^\s*\|/u.test(lines[endLine] ?? '')) endLine += 1;

      const startChar = lineStarts[startLine] ?? 0;
      const endChar = endLine < lineStarts.length ? (lineStarts[endLine] ?? text.length) : text.length;
      const blockText = text.slice(startChar, endChar).trim();
      if (blockText) blocks.push({ text: blockText, startChar });
      index = endLine;
    }

    return blocks;
  }

  private extractMarkdownTableRowRange(text: string): string | undefined {
    const lines = text.trim().split(/\r?\n/u).filter(line => /^\s*\|/u.test(line));
    const rowCount = Math.max(0, lines.length - 2);
    return rowCount > 0 ? `1-${rowCount}` : undefined;
  }

  private splitMarkdownTable(text: string, maxTokens: number): string[] {
    const lines = text.trim().split(/\r?\n/u).filter(Boolean);
    const separatorIndex = lines.findIndex(line => /^\s*\|?\s*:?-{3,}:?\s*\|/u.test(line));
    if (separatorIndex <= 0) return this.splitBySentenceBoundary(text, maxTokens);
    const header = lines.slice(0, separatorIndex + 1);
    const rows = lines.slice(separatorIndex + 1);
    const chunks: string[] = [];
    let current: string[] = [];
    for (const row of rows) {
      const candidate = [...header, ...current, row].join('\n');
      if (current.length > 0 && this.estimateTokens(candidate) > maxTokens) {
        chunks.push([...header, ...current].join('\n'));
        current = [row];
      } else {
        current.push(row);
      }
    }
    if (current.length > 0) chunks.push([...header, ...current].join('\n'));
    // 行原子性：超出预算的表块按行边界拆分并保留表头，绝不切开数据行（旧 splitByWindow 会把行切成碎片）
    return chunks.flatMap(chunk => this.estimateTokens(chunk) > maxTokens ? this.splitTableByRowBoundary(chunk, header.length, maxTokens) : [chunk]);
  }

  /** 按行边界拆分超预算表块：表头行与数据行均保持完整；单行超预算也保持完整，不做窗口硬切 */
  private splitTableByRowBoundary(chunk: string, headerLineCount: number, maxTokens: number): string[] {
    const lines = chunk.split(/\r?\n/u).filter(Boolean);
    const header = lines.slice(0, Math.min(headerLineCount, lines.length - 1));
    const rows = lines.slice(header.length);
    if (rows.length <= 1) return [chunk];
    const mid = Math.ceil(rows.length / 2);
    const left = [...header, ...rows.slice(0, mid)].join('\n');
    const right = [...header, ...rows.slice(mid)].join('\n');
    return [left, right].flatMap(part => this.estimateTokens(part) > maxTokens ? this.splitTableByRowBoundary(part, header.length, maxTokens) : [part]);
  }

  /** 表头行数（表头行 + 分隔行），非标准表格返回 0 */
  private tableHeaderLineCount(text: string): number {
    const lines = text.trim().split(/\r?\n/u);
    const separatorIndex = lines.findIndex(line => /^\s*\|?\s*:?-{3,}:?\s*\|/u.test(line));
    return separatorIndex > 0 ? separatorIndex + 1 : 0;
  }

  /** 在 text 中从 fromIndex 起顺序定位 part：完整匹配 → 60 字符前缀 → -1。
   * 完整匹配失败源于分块拼接符（\n）与原文分隔符（\n\n 或词级切分）不一致；
   * 不做首行退化：词级首行（如“敷设方式”）在重复文本中会命中极早的相同词，
   * 导致偏移大幅回退，宁缺失该块的精确定位（由调用方单调推进兑底）。 */
  private locateInSection(text: string, part: string, fromIndex: number): number {
    let index = text.indexOf(part, fromIndex);
    if (index < 0 && part.length > 60) index = text.indexOf(part.slice(0, 60), fromIndex);
    return index;
  }
  
  /** 计算切分片段在原文本中的起始偏移（顺序扫描，避免共享表头前缀导致 indexOf 重复命中）。
   * lookBehind > 0 时从 cursor 向前回溯该窗口搜索：overlap 重叠块的起点在前一块终点之前
   * （重叠长度上限 400 字符），不回溯会导致完整匹配失败退化为前缀匹配而定位偏差。
   * 定位失败时按“紧跟上一块”推进 cursor：保证偏移单调递增，避免重复文本下
   * 所有失败块退化到同一位置（旧实现曾出现 start 全部归 0 的震荡）。 */
  private chunkPartStartOffsets(text: string, parts: string[], lookBehind = 0): number[] {
    const offsets: number[] = [];
    let cursor = 0;
    for (const part of parts) {
      const fromIndex = lookBehind > 0 ? Math.max(0, cursor - lookBehind) : cursor;
      const index = this.locateInSection(text, part, fromIndex);
      offsets.push(index >= 0 ? index : cursor);
      cursor = index >= 0 ? index + part.length : cursor + part.length;
    }
    return offsets;
  }

  private enforceCandidateLimit(candidates: ChunkCandidate[], config: ChunkConfig): ChunkCandidate[] {
    return candidates.flatMap(candidate => {
      if (this.estimateTokens(candidate.text) <= config.maxChunkSize) return [candidate];
      // 表格候选：按行边界拆分并保留表头，避免 splitByWindow 把数据行切成碎片
      if (candidate.kind === 'table') {
        const headerLineCount = this.tableHeaderLineCount(candidate.text);
        if (headerLineCount > 0) {
          const parts = this.splitTableByRowBoundary(candidate.text, headerLineCount, config.maxChunkSize);
          const offsets = this.chunkPartStartOffsets(candidate.text, parts);
          return parts.map((text, index) => ({
            ...candidate,
            text,
            childIndex: candidate.childIndex + index,
            startChar: candidate.startChar + (offsets[index] ?? 0),
            endChar: candidate.startChar + (offsets[index] ?? 0) + text.length,
            rowRange: candidate.rowRange ? `${candidate.rowRange}#${index + 1}` : undefined,
          }));
        }
      }
      const windows = this.splitByWindow(candidate.text, config.maxChunkSize, config.overlap);
      const offsets = this.chunkPartStartOffsets(candidate.text, windows, 4096);
      return windows.map((text, index) => {
        const startChar = candidate.startChar + (offsets[index] ?? 0);
        return {
          ...candidate,
          text,
          childIndex: candidate.childIndex + index,
          startChar,
          endChar: startChar + text.length,
          rowRange: candidate.rowRange ? `${candidate.rowRange}#${index + 1}` : undefined,
        };
      });
    });
  }

  private buildTitlePaths(sections: Array<{ text: string; title?: string }>): Array<string | undefined> {
    const stack: Array<{ level: number; title: string }> = [];
    return sections.map(section => {
      const firstLine = section.text.trim().split(/\r?\n/u)[0] ?? '';
      const heading = firstLine.match(/^(#{1,6})\s+(.+)$/u);
      if (heading?.[1] && heading[2]) {
        const level = heading[1].length;
        const title = heading[2].trim();
        while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
        stack.push({ level, title });
      } else if (section.title && stack.length === 0) {
        stack.push({ level: 1, title: section.title });
      }
      return stack.map(item => item.title).join(' > ') || section.title;
    });
  }

  private createChunk(index: number, candidate: ChunkCandidate, file: ClassifiedFile, metadata: Record<string, unknown>): TextChunk {
    const text = candidate.text.trim();
    // endChar 按 trim 后文本计算（原用未 trim 的 part.length，尾部换行/空白会虚增偏移 2 字符，
    // 导致相邻块 start_char/end_char 出现虚假间隙，破坏元数据精准性）
    const endChar = candidate.startChar + text.length;
    return {
      index,
      text,
      startChar: candidate.startChar,
      endChar,
      tokenCount: this.estimateTokens(text),
      sectionTitle: candidate.sectionTitle ?? this.extractSectionTitle(text),
      metadata: {
        ...metadata,
        chunkType: 'child',
        chunkKind: candidate.kind,
        parentId: `${file.relativePath}#${candidate.parentId}`,
        parentIndex: candidate.parentIndex,
        childIndex: candidate.childIndex,
        rowRange: candidate.rowRange,
        sectionTitle: candidate.sectionTitle ?? this.extractSectionTitle(text),
        titlePath: candidate.titlePath ?? candidate.sectionTitle ?? this.extractSectionTitle(text),
        startChar: candidate.startChar,
        endChar,
        splitStrategy: 'recursive_parent_child_v2',
        parentText: candidate.childIndex === 0 ? candidate.parentText : undefined,
      },
    };
  }

  private kindForCategory(category: FileCategory): ChunkKind {
    if (category === 'image' || category === 'cad' || category === 'diagram') return 'metadata';
    if (category === 'code') return 'code';
    if (category === 'data') return 'data';
    if (category === 'spreadsheet') return 'table';
    return 'text';
  }

  private extractSectionTitle(text: string): string | undefined {
    const firstLine = text.trim().split(/\r?\n/u)[0]?.trim();
    if (!firstLine) return undefined;
    if (firstLine.startsWith('#')) return firstLine.replace(/^#+\s*/u, '');
    return firstLine.length <= 80 ? firstLine : undefined;
  }

  private takeOverlap(text: string, overlapTokens: number): string {
    if (overlapTokens <= 0) return '';
    const chars = overlapTokens * 4;
    return text.slice(Math.max(0, text.length - chars));
  }

  private hasLongUnbrokenSegment(text: string): boolean {
    return /[^\s\n\r\t。？！；;.!?，、]{2001,}/u.test(text);
  }

  private estimateTokens(text: string): number {
    if (this.hasLongUnbrokenSegment(text)) return text.length;
    return Math.max(1, this.tokenizer.countTokens(text));
  }
}
