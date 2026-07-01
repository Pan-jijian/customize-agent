import * as crypto from 'node:crypto';

export interface MinHashSignature {
  signature: number[];
  shingleCount: number;
}

export interface SimilarityMatch {
  filePath: string;
  similarity: number;
}

export class DedupEngine {
  private readonly hashCount = 128;

  normalizeText(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFKC')
      .replace(/\b\d{4}\b/gu, 'yyyy')
      .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/gu, 'date')
      .replace(/[\p{P}\p{S}]+/gu, ' ')
      .split(/\s+/u)
      .filter(token => token.length > 0 && !this.isStopWord(token))
      .join(' ')
      .trim();
  }

  normalizedHash(text: string): string | undefined {
    const normalized = this.normalizeText(text);
    if (normalized.length === 0) return undefined;
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  relationshipForFormats(sourceFormat: string, targetFormat: string): 'format_variant' | 'translation' {
    if (this.looksTranslationFormat(sourceFormat) || this.looksTranslationFormat(targetFormat)) return 'translation';
    return 'format_variant';
  }

  computeMinHash(text: string, shingleSize = 5): MinHashSignature | undefined {
    const tokens = this.normalizeText(text).split(/\s+/u).filter(Boolean);
    if (tokens.length < shingleSize) return undefined;

    const shingles = new Set<string>();
    for (let i = 0; i <= tokens.length - shingleSize; i++) {
      shingles.add(tokens.slice(i, i + shingleSize).join(' '));
    }
    if (shingles.size === 0) return undefined;

    const signature = Array.from({ length: this.hashCount }, () => Number.MAX_SAFE_INTEGER);
    for (const shingle of shingles) {
      for (let seed = 0; seed < this.hashCount; seed++) {
        const value = this.hashToUint32(`${seed}:${shingle}`);
        if (value < signature[seed]!) signature[seed] = value;
      }
    }

    return { signature, shingleCount: shingles.size };
  }

  estimateSimilarity(a: number[], b: number[]): number {
    const length = Math.min(a.length, b.length);
    if (length === 0) return 0;

    let equal = 0;
    for (let i = 0; i < length; i++) {
      if (a[i] === b[i]) equal += 1;
    }
    return equal / length;
  }

  relationshipForSimilarity(similarity: number): 'near_duplicate' | 'revision' | undefined {
    if (similarity >= 0.95) return 'near_duplicate';
    if (similarity >= 0.8) return 'revision';
    return undefined;
  }

  private hashToUint32(input: string): number {
    return crypto.createHash('sha256').update(input).digest().readUInt32BE(0);
  }

  private looksTranslationFormat(format: string): boolean {
    return ['translation', 'bilingual'].includes(format);
  }

  private isStopWord(token: string): boolean {
    return STOP_WORDS.has(token);
  }
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'by',
  '是', '的', '了', '和', '与', '及', '或', '在', '为', '对', '中', '本文',
]);
