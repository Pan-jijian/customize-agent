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

const DEFAULT_CONFIGS: Record<FileCategory, ChunkConfig> = {
  document: { maxChunkSize: 800, overlap: 100, headerInjection: true },
  spreadsheet: { maxChunkSize: 1000, overlap: 200, headerInjection: true },
  image: { maxChunkSize: 512, overlap: 0, headerInjection: true },
  cad: { maxChunkSize: 600, overlap: 100, headerInjection: true },
  code: { maxChunkSize: 1000, overlap: 200, headerInjection: true },
  data: { maxChunkSize: 600, overlap: 100, headerInjection: true },
  web: { maxChunkSize: 800, overlap: 100, headerInjection: true },
  diagram: { maxChunkSize: 512, overlap: 0, headerInjection: true },
  archive: { maxChunkSize: 500, overlap: 50, headerInjection: false },
  other: { maxChunkSize: 500, overlap: 50, headerInjection: false },
};

export class TextChunker {
  chunk(text: string, file: ClassifiedFile, metadata: Record<string, unknown> = {}): TextChunk[] {
    if (text.trim().length === 0) return [];

    const config = DEFAULT_CONFIGS[file.category];
    const normalized = this.withHeader(text, file, config);
    const paragraphs = this.splitBySemanticBoundary(normalized, file.category);
    const chunks: TextChunk[] = [];
    let buffer = '';
    let chunkStart = 0;
    let cursor = 0;

    for (const paragraph of paragraphs) {
      const candidate = buffer.length === 0 ? paragraph : `${buffer}\n\n${paragraph}`;
      if (this.estimateTokens(candidate) > config.maxChunkSize && buffer.length > 0) {
        chunks.push(this.createChunk(chunks.length, buffer, chunkStart, cursor, metadata));
        const overlapText = this.takeOverlap(buffer, config.overlap);
        buffer = overlapText.length > 0 ? `${overlapText}\n\n${paragraph}` : paragraph;
        chunkStart = Math.max(0, cursor - overlapText.length);
      } else {
        buffer = candidate;
      }
      cursor += paragraph.length + 2;
    }

    if (buffer.trim().length > 0) {
      chunks.push(this.createChunk(chunks.length, buffer, chunkStart, normalized.length, metadata));
    }

    return chunks;
  }

  private withHeader(text: string, file: ClassifiedFile, config: ChunkConfig): string {
    if (!config.headerInjection) return text;
    return `文件: ${file.relativePath}\n类型: ${file.category}/${file.format}\n\n${text}`;
  }

  private splitBySemanticBoundary(text: string, category: FileCategory): string[] {
    if (category === 'document') {
      return text.split(/\n(?=#{1,6}\s)|\n{2,}/u).map(part => part.trim()).filter(Boolean);
    }
    if (category === 'code') {
      return text.split(/\n(?=(export\s+)?(async\s+)?(function|class|interface|type|const|let|var)\s)/u).map(part => part.trim()).filter(Boolean);
    }
    if (category === 'data') {
      return text.split(/\n(?=[\w.[\]-]+:\s)|\n{2,}/u).map(part => part.trim()).filter(Boolean);
    }
    if (category === 'cad' || category === 'diagram') {
      return text.split(/\n(?=(?:CAD|STEP|IGES|Mesh|Draw\.io|Excalidraw|SVG)\b)|\n{2,}/u).map(part => part.trim()).filter(Boolean);
    }
    return text.split(/\n{2,}/u).map(part => part.trim()).filter(Boolean);
  }

  private createChunk(index: number, text: string, startChar: number, endChar: number, metadata: Record<string, unknown>): TextChunk {
    return {
      index,
      text: text.trim(),
      startChar,
      endChar,
      tokenCount: this.estimateTokens(text),
      sectionTitle: this.extractSectionTitle(text),
      metadata,
    };
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
