import { BgeTokenizer } from './bge-tokenizer.js';
import type { ClassifiedFile, FileCategory } from '../types.js';

export interface TextChunk {
  index: number;
  text: string;
  startChar: number;
  endChar: number;
  tokenCount: number;
  sectionTitle?: string;
  metadata: Record<string, unknown>;
}

export interface ChunkConfig {
  maxChunkSize: number;
  overlap: number;
  headerInjection: boolean;
}

type ChunkKind = 'text' | 'table' | 'data' | 'code' | 'metadata';

type ChunkCandidate = {
  text: string;
  startChar: number;
  endChar: number;
  sectionTitle?: string;
  kind: ChunkKind;
  parentId: string;
  parentIndex: number;
  childIndex: number;
  rowRange?: string;
};

type CodeLanguageConfig = {
  delimiters: RegExp;
  blockStart: RegExp;
  indentSensitive: boolean;
};

const DEFAULT_CONFIGS: Record<FileCategory, ChunkConfig> = {
  document: { maxChunkSize: 800, overlap: 100, headerInjection: true },
  spreadsheet: { maxChunkSize: 1000, overlap: 120, headerInjection: true },
  image: { maxChunkSize: 512, overlap: 0, headerInjection: true },
  cad: { maxChunkSize: 600, overlap: 80, headerInjection: true },
  code: { maxChunkSize: 1000, overlap: 120, headerInjection: true },
  data: { maxChunkSize: 600, overlap: 80, headerInjection: true },
  web: { maxChunkSize: 800, overlap: 100, headerInjection: true },
  diagram: { maxChunkSize: 512, overlap: 0, headerInjection: true },
  archive: { maxChunkSize: 500, overlap: 50, headerInjection: false },
  other: { maxChunkSize: 500, overlap: 50, headerInjection: false },
};

const RECURSIVE_SEPARATORS = [
  /\n(?=#{1,6}\s)/u,
  /\n{2,}/u,
  /\n(?=(?:第[一二三四五六七八九十百千万\d]+[章节条]|[一二三四五六七八九十]+、|\d+[.)、]))/u,
  /(?<=[。！？；])\s*/u,
  /(?<=[，、])\s*/u,
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

export class TextChunker {
  private readonly tokenizer = new BgeTokenizer();

  chunk(text: string, file: ClassifiedFile, metadata: Record<string, unknown> = {}): TextChunk[] {
    const source = text.trim();
    if (source.length === 0) return [];

    const config = DEFAULT_CONFIGS[file.category];
    const normalized = this.withHeader(source, file, config);
    const candidates = this.enforceCandidateLimit(this.createCandidates(normalized, file, config), config);

    return candidates.map((candidate, index) => this.createChunk(index, candidate, file, metadata));
  }

  private createCandidates(text: string, file: ClassifiedFile, config: ChunkConfig): ChunkCandidate[] {
    if (file.category === 'spreadsheet') return this.createTableCandidates(text, config);
    if (file.category === 'data') return this.createDataCandidates(text, config);
    if (file.category === 'code') return this.createCodeCandidates(text, file, config);
    return this.createTextCandidates(text, file.category, config);
  }

  private createTextCandidates(text: string, category: FileCategory, config: ChunkConfig): ChunkCandidate[] {
    const sections = this.splitIntoSections(text, category);
    const candidates: ChunkCandidate[] = [];

    sections.forEach((section, parentIndex) => {
      const parentId = `p${parentIndex}`;
      const parts = this.mergeLeadingHeader(this.recursiveSplit(section.text, config.maxChunkSize));
      const merged = this.mergeParts(parts, config.maxChunkSize, config.overlap);
      merged.forEach((part, childIndex) => {
        const localStart = section.text.indexOf(part.replace(/^\s+/u, '').slice(0, 40));
        const startChar = section.startChar + Math.max(0, localStart);
        candidates.push({
          text: part,
          startChar,
          endChar: startChar + part.length,
          sectionTitle: section.title,
          kind: this.kindForCategory(category),
          parentId,
          parentIndex,
          childIndex,
        });
      });
    });

    return candidates;
  }

  private createTableCandidates(text: string, config: ChunkConfig): ChunkCandidate[] {
    if (this.isMarkdownTable(text)) {
      return this.splitMarkdownTable(text, config.maxChunkSize).map((part, index) => {
        const startChar = Math.max(0, text.indexOf(part.slice(0, 40)));
        return {
          text: part,
          startChar,
          endChar: startChar + part.length,
          sectionTitle: this.extractSectionTitle(part) ?? '表格数据',
          kind: 'table',
          parentId: `table-${index}`,
          parentIndex: index,
          childIndex: 0,
          rowRange: this.extractMarkdownTableRowRange(part),
        };
      });
    }
    return this.createTextCandidates(text, 'spreadsheet', config);
  }

  private createDataCandidates(text: string, config: ChunkConfig): ChunkCandidate[] {
    const sections = text.split(/\n(?=[\w.[\]-]+[:：]\s)|\n{2,}/u).map(part => part.trim()).filter(Boolean);
    const parts = sections.length > 1 ? sections : this.recursiveSplit(text, config.maxChunkSize);
    return this.mergeParts(parts, config.maxChunkSize, config.overlap).map((part, index) => ({
      text: part,
      startChar: Math.max(0, text.indexOf(part.slice(0, 40))),
      endChar: Math.max(0, text.indexOf(part.slice(0, 40))) + part.length,
      sectionTitle: this.extractSectionTitle(part),
      kind: 'data',
      parentId: `data-${index}`,
      parentIndex: index,
      childIndex: 0,
    }));
  }

  private createCodeCandidates(text: string, file: ClassifiedFile, config: ChunkConfig): ChunkCandidate[] {
    const language = this.normalizeCodeLanguage(file.format);
    const languageConfig = LANGUAGE_ROUTER[language];
    const blocks = languageConfig
      ? this.splitCodeByLanguage(text, languageConfig)
      : this.splitCodeByStructuralFallback(text);
    const parts = blocks.length > 1 ? blocks : this.recursiveSplit(text, config.maxChunkSize);
    return this.mergeParts(parts, config.maxChunkSize, config.overlap).map((part, index) => {
      const startChar = Math.max(0, text.indexOf(part.slice(0, 40)));
      return {
        text: part,
        startChar,
        endChar: startChar + part.length,
        sectionTitle: this.extractSectionTitle(part),
        kind: 'code',
        parentId: `code-${language}-${index}`,
        parentIndex: index,
        childIndex: 0,
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
    if (parts.length <= 1) return this.recursiveSplit(text, maxTokens, separatorIndex + 1);

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
    return chunks.flatMap(chunk => this.estimateTokens(chunk) > maxTokens ? this.splitByWindow(chunk, maxTokens) : [chunk]);
  }

  private enforceCandidateLimit(candidates: ChunkCandidate[], config: ChunkConfig): ChunkCandidate[] {
    return candidates.flatMap(candidate => {
      if (this.estimateTokens(candidate.text) <= config.maxChunkSize) return [candidate];
      return this.splitByWindow(candidate.text, config.maxChunkSize, config.overlap).map((text, index) => ({
        ...candidate,
        text,
        childIndex: candidate.childIndex + index,
        startChar: candidate.startChar + Math.max(0, candidate.text.indexOf(text.slice(0, 40))),
        endChar: candidate.startChar + Math.max(0, candidate.text.indexOf(text.slice(0, 40))) + text.length,
        rowRange: candidate.rowRange ? `${candidate.rowRange}#${index + 1}` : undefined,
      }));
    });
  }

  private withHeader(text: string, file: ClassifiedFile, config: ChunkConfig): string {
    if (!config.headerInjection) return text;
    return `文件: ${file.relativePath}\n类型: ${file.category}/${file.format}\n\n${text}`;
  }

  private createChunk(index: number, candidate: ChunkCandidate, file: ClassifiedFile, metadata: Record<string, unknown>): TextChunk {
    const text = candidate.text.trim();
    return {
      index,
      text,
      startChar: candidate.startChar,
      endChar: candidate.endChar,
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
        startChar: candidate.startChar,
        endChar: candidate.endChar,
        splitStrategy: 'recursive_parent_child_v1',
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

  private estimateTokens(text: string): number {
    return Math.max(1, this.tokenizer.countTokens(text));
  }
}
