import type { EmbeddingProvider } from '../embedding/embedding-provider.js';
import type { StoredChunk } from '../core/index-state-store.js';
import type { VectorDocument, VectorStoreInterface } from './types.js';

export interface VectorIndexResult {
  collectionName: string;
  chunkCount: number;
  embeddingModel: string;
  embeddingDimension: number;
}

export class VectorIndexer {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly vectorStores: Map<string, VectorStoreInterface>,
  ) {}

  async indexChunks(chunks: StoredChunk[]): Promise<VectorIndexResult[]> {
    const byCollection = this.groupByCollection(chunks);
    const results: VectorIndexResult[] = [];

    for (const [collectionName, collectionChunks] of byCollection) {
      const store = this.vectorStores.get(collectionName);
      if (!store) continue;

      await store.ensureCollection({
        embedding_model: this.embeddingProvider.model,
        embedding_dimension: this.embeddingProvider.dimensions,
      });

      const embeddings = await this.embeddingProvider.embedDocuments(collectionChunks.map(chunk => chunk.content));
      const documents = collectionChunks.map((chunk, index) => this.toVectorDocument(chunk, embeddings[index] ?? []));
      await store.upsert(documents);

      results.push({
        collectionName,
        chunkCount: documents.length,
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

  private groupByCollection(chunks: StoredChunk[]): Map<string, StoredChunk[]> {
    const grouped = new Map<string, StoredChunk[]>();
    for (const chunk of chunks) {
      const list = grouped.get(chunk.collectionName) ?? [];
      list.push(chunk);
      grouped.set(chunk.collectionName, list);
    }
    return grouped;
  }

  private toVectorDocument(chunk: StoredChunk, embedding: number[]): VectorDocument {
    return {
      id: chunk.id,
      content: chunk.content,
      embedding,
      metadata: {
        file_path: chunk.relativePath,
        chunk_index: chunk.chunkIndex,
        category: chunk.category,
        format: chunk.format,
        token_count: chunk.tokenCount,
        section_title: chunk.sectionTitle ?? null,
      },
    };
  }
}
