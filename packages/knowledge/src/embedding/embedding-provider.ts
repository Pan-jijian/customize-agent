import * as crypto from 'node:crypto';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'hash-embedding-local';

  constructor(readonly dimensions = 384) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.embed(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  private embed(text: string): number[] {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const tokens = text.toLowerCase().normalize('NFKC').split(/\s+/u).filter(Boolean);

    for (const token of tokens) {
      const hash = crypto.createHash('sha256').update(token).digest();
      const index = hash.readUInt32BE(0) % this.dimensions;
      const sign = hash.readUInt8(4) % 2 === 0 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign;
    }

    return this.normalize(vector);
  }

  private normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) return vector;
    return vector.map(value => value / norm);
  }
}
