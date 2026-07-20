import { pipeline } from '@huggingface/transformers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class LocalReranker {
  private static instance: any = null;
  private static loadingPromise: Promise<any> | null = null;
  private static disabledUntil = 0;
  private static modelName = process.env.KB_RERANKER_MODEL || 'Xenova/bge-reranker-base';

  public static async getInstance() {
    if (this.instance) return this.instance;
    if (Date.now() < this.disabledUntil) throw new Error('Local reranker is temporarily disabled after load failure');
    if (process.env.KB_ENABLE_LOCAL_RERANKER === 'false') throw new Error('Local reranker is disabled');

    // 使用 loadingPromise 防止高并发下的重复加载
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      const cacheDir = process.env.TRANSFORMERS_CACHE || path.join(os.homedir(), '.customize-agent', 'models');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      process.env.TRANSFORMERS_CACHE = cacheDir;

      const pipe = await pipeline('text-classification', this.modelName, {
        dtype: 'q8',
      } as any);

      this.instance = pipe;
      return pipe;
    })().catch(error => {
      this.loadingPromise = null;
      this.disabledUntil = Date.now() + 60_000;
      throw error;
    });

    return this.loadingPromise;
  }

  /**
   * 对多条文本和查询进行相关性重排
   */
  public static async rerank(query: string, texts: string[]): Promise<number[]> {
    if (!texts.length) return [];

    const ranker = await this.getInstance();
    const scores: number[] = [];
    const safeQuery = this.takeHeadTail(query, 240);

    for (const text of texts) {
      try {
        const safeText = this.takeHeadTail(text, 1400);
        const out = await ranker({ text: safeQuery, text_pair: safeText });
        scores.push(this.extractScore(out));
      } catch {
        scores.push(0);
      }
    }

    return scores;
  }

  private static takeHeadTail(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    const headLength = Math.ceil(maxLength * 0.65);
    const tailLength = maxLength - headLength;
    return `${text.slice(0, headLength)}\n...\n${text.slice(-tailLength)}`;
  }

  private static extractScore(output: any): number {
    const first = Array.isArray(output) ? output[0] : output;
    if (Array.isArray(first)) return this.extractScore(first);
    const score = Number(first?.score ?? 0);
    return Number.isFinite(score) ? score : 0;
  }
}
