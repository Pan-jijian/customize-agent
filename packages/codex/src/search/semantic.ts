import type { ILLMProvider } from '@code-agent/llm';
import { getLanguageConfig } from '../index/languages.js';
import type { StorageManager } from '../index/db.js';
import Parser, { type SyntaxNode } from 'tree-sitter';

/** Embedding 搜索结果项 */
export interface EmbeddingSearchResult {
  /** 匹配的代码片段 */
  text: string;
  /** 文件路径 */
  file: string;
  /** 起始行号 */
  line: number;
  /** 余弦相似度 (0~1) */
  similarity: number;
}

interface CodeChunk {
  text: string;
  file: string;
  startLine: number;
  endLine: number;
  embedding: number[];
}

/**
 * 层级代码切块器 — 按函数/类边界切分，每块 50-500 行。
 * 优先使用 tree-sitter AST 识别边界，不可用时回退为固定行数切分。
 */
class CodeChunker {
  private splitTypes = new Set([
    'function_declaration', 'function_definition', 'function_item',
    'class_declaration', 'class_definition', 'class_specifier',
    'interface_declaration', 'struct_item', 'enum_item', 'trait_item',
    'method_definition', 'method_declaration',
  ]);

  chunk(filePath: string, content: string): Array<{ text: string; startLine: number; endLine: number }> {
    const lines = content.split('\n');
    const chunks: Array<{ text: string; startLine: number; endLine: number }> = [];
    const MAX_CHUNK = 500;
    const MIN_LINE = 5;

    const boundaries = this._findBoundaries(filePath, content, lines.length);

    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i]!;
      const end = boundaries[i + 1]!;
      const chunkLines = lines.slice(start - 1, end - 1);

      if (chunkLines.length > MAX_CHUNK) {
        // 大块 → 按行数等分
        for (let j = 0; j < chunkLines.length; j += MAX_CHUNK) {
          const sub = chunkLines.slice(j, j + MAX_CHUNK);
          if (sub.length >= MIN_LINE) {
            chunks.push({ text: sub.join('\n'), startLine: start + j, endLine: start + j + sub.length });
          }
        }
      } else if (chunkLines.length >= MIN_LINE) {
        const text = chunkLines.join('\n');
        if (text.trim()) {
          chunks.push({ text, startLine: start, endLine: end });
        }
      }
    }

    return chunks;
  }

  private _findBoundaries(filePath: string, content: string, totalLines: number): number[] {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const lang = getLanguageConfig(ext);
    if (!lang) return [1, totalLines + 1];

    try {
      const parser = new Parser();
      parser.setLanguage(lang.grammar);
      const tree = parser.parse(content);

      const boundaries: number[] = [1];
      const seen = new Set<number>();

      const walk = (node: SyntaxNode): void => {
        if (this.splitTypes.has(node.type)) {
          const line = node.startPosition.row + 1;
          if (!seen.has(line)) {
            seen.add(line);
            boundaries.push(line);
          }
        }
        for (const child of node.children) walk(child);
      };

      walk(tree.rootNode);
      boundaries.push(totalLines + 1);
      boundaries.sort((a, b) => a - b);
      return boundaries;
    } catch {
      return [1, totalLines + 1];
    }
  }
}

const chunker = new CodeChunker();

/**
 * 构建代码块的 Header Injection (ADR-10)。
 * 注入文件路径和外层类/函数签名，提升语义检索精确度。
 */
function buildHeaderInjection(filePath: string, content: string, startLine: number): string {
  const header = [`// File: ${filePath}`];

  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const lang = getLanguageConfig(ext);
  if (lang) {
    try {
      const parser = new Parser();
      parser.setLanguage(lang.grammar);
      const tree = parser.parse(content);

      const enclosingTypes = new Set([
        'class_declaration', 'class_definition', 'class_specifier',
        'function_declaration', 'function_definition', 'function_item',
        'interface_declaration', 'struct_item', 'enum_item', 'trait_item',
        'module', 'mod_item', 'namespace_definition',
      ]);

      const enclosing = findEnclosingScope(tree.rootNode, startLine, enclosingTypes);
      if (enclosing) {
        header.push(`// Enclosing: ${enclosing}`);
      }
    } catch { /* best-effort */ }
  }

  header.push('// ' + '='.repeat(60));
  return header.join('\n');
}

/** DFS 查找目标行所在的最内层作用域 */
function findEnclosingScope(
  node: SyntaxNode,
  targetLine: number,
  types: Set<string>,
): string | null {
  let result: string | null = null;

  if (types.has(node.type)) {
    const nodeStart = node.startPosition.row + 1;
    const nodeEnd = node.endPosition.row + 1;
    if (nodeStart <= targetLine && nodeEnd >= targetLine) {
      const nameNode = node.childForFieldName('name') ??
                       node.descendantsOfType('identifier')[0] ??
                       node.descendantsOfType('type_identifier')[0];
      if (nameNode) {
        result = `${node.type} ${nameNode.text}`;
      }
    }
  }

  // 继续搜索子节点（可能找到更内层的作用域）
  for (const child of node.children) {
    const childResult = findEnclosingScope(child, targetLine, types);
    if (childResult) result = childResult; // 最内层的会覆盖外层
  }

  return result;
}

/**
 * Embedding 语义搜索 (L3)。
 *
 * 搜索需求层次:
 *   L1 (FTS5 符号搜索) → "找到名为 authenticate 的函数"
 *   L2 (ripgrep 文本搜索) → "找到所有调用 authenticate 的地方"
 *   L3 (Embedding 语义搜索) → "找到处理用户登录认证的代码"
 *
 * L3 解决的核心问题：用户描述的"意图"和代码中的"实现"使用不同词汇。
 * "用户登录认证" ↔ login(), signIn(), auth middleware, verifyCredentials()
 * Embedding 向量通过余弦相似度跨越词汇鸿沟。
 */
export class EmbeddingSearch {
  private provider: ILLMProvider;
  private chunks: CodeChunk[] = [];
  /** 会话级脏文件集：被 modify_file 修改过的文件，跳过旧向量 */
  private dirtyFiles = new Set<string>();
  private db?: StorageManager;

  constructor(provider: ILLMProvider, db?: StorageManager) {
    this.provider = provider;
    this.db = db;
    // 从 DB 恢复持久化向量，避免重复调用昂贵的 embedding API
    if (db) this._loadFromDB();
  }

  /**
   * 索引项目文件：切块 → 注入 Header → 向量化 → 持久化到 DB。
   * embedding API 不可用时跳过（后续搜索降级 FTS5）。
   */
  async indexFiles(files: Array<{ path: string; content: string }>): Promise<void> {
    if (!this.provider.embed) {
      console.warn('[EmbeddingSearch] Provider 不支持 Embedding API，语义搜索不可用。将降级为 FTS5。');
      return;
    }

    // 跳过 DB 中已有向量的文件（增量索引）
    const pending = this.db
      ? files.filter(f => !this.chunks.some(c => c.file === f.path))
      : files;

    const texts: string[] = [];
    const meta: Array<{ file: string; startLine: number; endLine: number }> = [];

    for (const file of pending) {
      const chunks = chunker.chunk(file.path, file.content);
      for (const chunk of chunks) {
        const header = buildHeaderInjection(file.path, file.content, chunk.startLine);
        texts.push(`${header}\n${chunk.text}`);
        meta.push({ file: file.path, startLine: chunk.startLine, endLine: chunk.endLine });
      }
    }

    if (texts.length === 0) return;

    try {
      const embeddings = await this.provider.embed(texts);
      for (let i = 0; i < embeddings.length; i++) {
        const m = meta[i]!;
        const embedding = embeddings[i]!;
        this.chunks.push({
          text: texts[i]!,
          file: m.file,
          startLine: m.startLine,
          endLine: m.endLine,
          embedding,
        });
        // 持久化到 DB
        if (this.db) {
          this.db.saveEmbedding(m.file, i, embedding, texts[i]!);
        }
      }
    } catch {
      console.warn('[EmbeddingSearch] 向量化失败，语义搜索不可用。');
    }
  }

  /**
   * 语义搜索：query 生成向量 → 与所有代码块计算余弦相似度 → 返回 topK。
   * 自动跳过脏文件中的旧向量。
   */
  async search(query: string, topK: number = 5): Promise<EmbeddingSearchResult[]> {
    if (!this.provider.embedQuery || this.chunks.length === 0) {
      return [];
    }

    try {
      const queryVector = await this.provider.embedQuery(query);

      return this.chunks
        .filter(c => !this.dirtyFiles.has(c.file))
        .map(c => ({
          text: c.text,
          file: c.file,
          line: c.startLine,
          similarity: cosineSimilarity(queryVector, c.embedding),
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topK);
    } catch {
      return [];
    }
  }

  /** 标记文件为脏（modify_file 修改后调用，跳过旧向量） */
  /** 从 DB 恢复持久化的 embedding 向量 */
  private _loadFromDB(): void {
    if (!this.db) return;
    try {
      const stored = this.db.loadEmbeddings();
      for (const row of stored) {
        this.chunks.push({
          text: row.content,
          file: row.filePath,
          startLine: 0,
          endLine: 0,
          embedding: row.vector,
        });
      }
      if (stored.length > 0) {
        console.warn(`[EmbeddingSearch] 从 DB 恢复 ${stored.length} 个向量缓存`);
      }
    } catch { /* DB 为空或损坏，静默跳过 */ }
  }

  markDirty(filePath: string): void { this.dirtyFiles.add(filePath); }

  /** 获取已索引文件数 */
  get indexedCount(): number { return new Set(this.chunks.map(c => c.file)).size; }

  /** 获取切块总数 */
  get chunkCount(): number { return this.chunks.length; }
}

/** 余弦相似度计算 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
