import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type TokenizerJson = { model?: { vocab?: Record<string, number>; unk_token?: string } };

/** BGE Tokenizer，使用 tokenizer.json 执行 BGE 模型的真实 Token 化 */
export class BgeTokenizer {
  private readonly vocab: Set<string>;
  private readonly unkToken: string;

  constructor(tokenizerPath = BgeTokenizer.resolveTokenizerPath()) {
    if (!tokenizerPath) throw new Error('BGE tokenizer.json 缺失，无法执行真实 Token 计数');
    const raw = JSON.parse(fs.readFileSync(tokenizerPath, 'utf8')) as TokenizerJson;
    this.vocab = new Set(Object.keys(raw.model?.vocab ?? {}));
    this.unkToken = raw.model?.unk_token ?? '[UNK]';
    if (this.vocab.size === 0) throw new Error('BGE tokenizer vocab 为空，无法执行真实 Token 计数');
  }

  /** 统计文本的 Token 数量 */
  countTokens(text: string): number {
    return this.encode(text).length;
  }

  encode(text: string): string[] {
    const tokens: string[] = [];
    for (const token of this.preTokenize(text)) tokens.push(...this.wordPiece(token));
    return tokens;
  }

  private preTokenize(text: string): string[] {
    const normalized = Array.from(text, char => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : char;
    }).join('')
      .replace(/([\p{Script=Han}])/gu, ' $1 ')
      .normalize('NFKC');
    return normalized.match(/[\p{Script=Han}]|[\p{Letter}\p{Number}_]+|[^\s\p{Letter}\p{Number}_]/gu) ?? [];
  }

  private wordPiece(token: string): string[] {
    if (this.vocab.has(token)) return [token];
    const pieces: string[] = [];
    let start = 0;
    while (start < token.length) {
      let end = token.length;
      let current: string | undefined;
      while (start < end) {
        const piece = `${start > 0 ? '##' : ''}${token.slice(start, end)}`;
        if (this.vocab.has(piece)) {
          current = piece;
          break;
        }
        end -= 1;
      }
      if (!current) return Array.from(token).map(() => this.unkToken);
      pieces.push(current);
      start = end;
    }
    return pieces;
  }

  private static resolveTokenizerPath(): string | undefined {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      process.env.CUSTOMIZE_BGE_TOKENIZER_PATH,
      process.env.KB_BGE_TOKENIZER_PATH,
      path.resolve(process.cwd(), 'packages', 'knowledge', 'models', 'bge-small-zh-v1.5', 'tokenizer.json'),
      path.resolve(process.cwd(), 'models', 'bge-small-zh-v1.5', 'tokenizer.json'),
      path.resolve(currentDir, '..', '..', 'models', 'bge-small-zh-v1.5', 'tokenizer.json'),
    ].filter(Boolean) as string[];
    return candidates.find(candidate => fs.existsSync(candidate));
  }
}
