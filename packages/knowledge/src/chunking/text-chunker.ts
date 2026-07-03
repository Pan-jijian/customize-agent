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

export class TextChunker {
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
    if (file.category === 'code') return this.createCodeCandidates(text, config);
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
    const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    const headerLines = lines.filter(line => /^(文件|类型|Sheet|表格|列|Columns?)[:：]/iu.test(line));
    const dataLines = lines.filter(line => !headerLines.includes(line));
    if (dataLines.length === 0) return this.createTextCandidates(text, 'spreadsheet', config);

    const header = headerLines.join('\n');
    const candidates: ChunkCandidate[] = [];
    let rowStart = 0;
    let parentIndex = 0;

    while (rowStart < dataLines.length) {
      const rows: string[] = [];
      while (rowStart + rows.length < dataLines.length) {
        const nextLine = dataLines[rowStart + rows.length];
        if (!nextLine) break;
        const nextRows = [...rows, nextLine];
        const candidate = [header, `行范围: ${rowStart + 1}-${rowStart + nextRows.length}`, ...nextRows].filter(Boolean).join('\n');
        if (rows.length > 0 && this.estimateTokens(candidate) > config.maxChunkSize) break;
        rows.push(nextLine);
      }

      const textChunk = [header, `行范围: ${rowStart + 1}-${rowStart + rows.length}`, ...rows].filter(Boolean).join('\n');
      candidates.push({
        text: textChunk,
        startChar: text.indexOf(rows[0] ?? ''),
        endChar: text.indexOf(rows.at(-1) ?? '') + (rows.at(-1)?.length ?? 0),
        sectionTitle: '表格数据',
        kind: 'table',
        parentId: `table-${parentIndex}`,
        parentIndex,
        childIndex: 0,
        rowRange: `${rowStart + 1}-${rowStart + rows.length}`,
      });
      rowStart += Math.max(1, rows.length);
      parentIndex += 1;
    }

    return candidates;
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

  private createCodeCandidates(text: string, config: ChunkConfig): ChunkCandidate[] {
    const blocks = text.split(/\n(?=(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s)/u).map(part => part.trim()).filter(Boolean);
    const parts = blocks.length > 1 ? blocks : this.recursiveSplit(text, config.maxChunkSize);
    return this.mergeParts(parts, config.maxChunkSize, config.overlap).map((part, index) => ({
      text: part,
      startChar: Math.max(0, text.indexOf(part.slice(0, 40))),
      endChar: Math.max(0, text.indexOf(part.slice(0, 40))) + part.length,
      sectionTitle: this.extractSectionTitle(part),
      kind: 'code',
      parentId: `code-${index}`,
      parentIndex: index,
      childIndex: 0,
    }));
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
    if (separatorIndex >= RECURSIVE_SEPARATORS.length) return this.splitByWindow(text, maxTokens);

    const separator = RECURSIVE_SEPARATORS[separatorIndex];
    if (!separator) return this.splitByWindow(text, maxTokens);
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
    const maxChars = Math.max(200, maxTokens * 4);
    const overlapChars = Math.max(0, overlapTokens * 4);
    const step = Math.max(1, maxChars - overlapChars);
    const chunks: string[] = [];
    for (let start = 0; start < text.length; start += step) {
      chunks.push(text.slice(start, start + maxChars).trim());
      if (start + maxChars >= text.length) break;
    }
    return chunks.filter(Boolean);
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
    return Math.max(1, Math.ceil(text.length / 4));
  }
}
