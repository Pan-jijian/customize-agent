import type { EmbeddingProvider } from '../embedding/embedding-provider.js';
import type { StoredChunk } from '../core/index-state-store.js';
import type { VectorDocument, VectorStoreInterface } from './types.js';

/** 向量索引结果 */
export interface VectorIndexResult {
  collectionName: string;
  chunkCount: number;
  embeddingModel: string;
  embeddingDimension: number;
}

export interface VectorIndexProgress {
  collectionName: string;
  processedChunks: number;
  totalChunks: number;
  batchSize: number;
}

export interface VectorIndexOptions {
  batchSize?: number;
  persistEachBatch?: boolean;
  onProgress?: (progress: VectorIndexProgress) => void;
}

function resolveVectorIndexBatchSize(configured?: number): number {
  const raw = configured ?? Number(process.env.CUSTOMIZE_VECTOR_INDEX_BATCH_SIZE ?? process.env.KB_VECTOR_INDEX_BATCH_SIZE);
  if (!Number.isFinite(raw) || raw <= 0) return 256;
  return Math.max(1, Math.min(1024, Math.floor(raw)));
}

/** 向量索引器，负责将文本切片生成 Embedding 并写入向量存储 */
export class VectorIndexer {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly vectorStores: Map<string, VectorStoreInterface>,
  ) {}

  async indexChunks(chunks: StoredChunk[], options: VectorIndexOptions = {}): Promise<VectorIndexResult[]> {
    const byCollection = this.groupByCollection(chunks);
    const results: VectorIndexResult[] = [];
    const totalChunks = chunks.length;
    let processedTotalChunks = 0;

    for (const [collectionName, collectionChunks] of byCollection) {
      const store = this.vectorStores.get(collectionName);
      if (!store) continue;

      await store.ensureCollection({
        embedding_model: this.embeddingProvider.model,
        embedding_dimension: this.embeddingProvider.dimensions,
      });

      const batchSize = resolveVectorIndexBatchSize(options.batchSize);
      let processedChunks = 0;
      for (let offset = 0; offset < collectionChunks.length; offset += batchSize) {
        const batchChunks = collectionChunks.slice(offset, offset + batchSize);
        const texts = batchChunks.map(chunk => this.embeddingText(chunk));
        const embeddings = await this.embedDocuments(texts);
        const documents = batchChunks.map((chunk, index) => this.toVectorDocument(chunk, embeddings[index] ?? []));
        await store.upsert(documents, { persist: options.persistEachBatch === true });
        processedChunks += documents.length;
        processedTotalChunks += documents.length;
        options.onProgress?.({ collectionName, processedChunks: processedTotalChunks, totalChunks, batchSize: documents.length });
      }
      await store.flush?.();

      results.push({
        collectionName,
        chunkCount: processedChunks,
        embeddingModel: this.embeddingProvider.model,
        embeddingDimension: this.embeddingProvider.dimensions,
      });
    }

    return results;
  }

  async deleteFile(collectionName: string, filePath: string): Promise<void> {
    const store = this.vectorStores.get(collectionName);
    if (!store) return;
    await store.deleteByFilePath(filePath);
  }

  private async embedDocuments(texts: string[]): Promise<number[][]> {
    const embeddings = await this.embeddingProvider.embedDocuments(texts);
    if (!this.isValidEmbeddings(embeddings, texts.length, this.embeddingProvider.dimensions)) {
      throw new Error(`Embedding 结果异常：期望 ${texts.length} 条 ${this.embeddingProvider.dimensions} 维向量，实际返回 ${embeddings.length} 条`);
    }
    return embeddings;
  }

  private isValidEmbeddings(embeddings: number[][], count: number, dimensions: number): boolean {
    return embeddings.length === count && embeddings.every(vector => vector.length === dimensions && vector.every(value => Number.isFinite(value)));
  }

  private groupByCollection(chunks: StoredChunk[]): Map<string, StoredChunk[]> {
    const grouped = new Map<string, StoredChunk[]>();
    for (const chunk of chunks) {
      const list = grouped.get(chunk.collectionName) ?? [];
      list.push(chunk);
      grouped.set(chunk.collectionName, list);
    }
    return grouped;
  }

  private embeddingText(chunk: StoredChunk): string {
    return chunk.searchContent ?? [
      `文件路径: ${chunk.relativePath}`,
      `资料类型: ${chunk.category}/${chunk.format}`,
      chunk.titlePath ? `标题路径: ${chunk.titlePath}` : '',
      chunk.sectionTitle ? `章节标题: ${chunk.sectionTitle}` : '',
      chunk.chunkKind ? `切片类型: ${chunk.chunkKind}` : '',
      chunk.rowRange ? `表格行范围: ${chunk.rowRange}` : '',
      chunk.content,
    ].filter(Boolean).join('\n');
  }

  private toVectorDocument(chunk: StoredChunk, embedding: number[]): VectorDocument {
    const chunkMetadata = this.parseMetadata(chunk.metadataJson);
    return {
      id: chunk.id,
      content: chunk.content,
      embedding,
      metadata: {
        sqlite_rowid: chunk.rowid,
        file_path: chunk.relativePath,
        chunk_index: chunk.chunkIndex,
        category: chunk.category,
        format: chunk.format,
        token_count: chunk.tokenCount,
        section_title: chunk.sectionTitle ?? null,
        title_path: chunk.titlePath ?? this.metadataString(chunkMetadata.titlePath),
        parent_id: chunk.parentId ?? this.metadataString(chunkMetadata.parentId),
        parent_index: this.metadataNumber(chunkMetadata.parentIndex),
        child_index: this.metadataNumber(chunkMetadata.childIndex),
        chunk_kind: chunk.chunkKind ?? this.metadataString(chunkMetadata.chunkKind),
        row_range: chunk.rowRange ?? this.metadataString(chunkMetadata.rowRange),
        start_char: chunk.startChar ?? this.metadataNumber(chunkMetadata.startChar),
        end_char: chunk.endChar ?? this.metadataNumber(chunkMetadata.endChar),
        split_strategy: this.metadataString(chunkMetadata.splitStrategy),
      },
    };
  }

  private parseMetadata(metadataJson?: string): Record<string, unknown> {
    if (!metadataJson) return {};
    try { return JSON.parse(metadataJson) as Record<string, unknown>; } catch { return {}; }
  }

  private metadataString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private metadataNumber(value: unknown): number | null {
    return typeof value === 'number' ? value : null;
  }
}
