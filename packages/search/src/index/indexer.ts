import * as fs from 'fs/promises';
import Parser, { type SyntaxNode } from 'tree-sitter';
import type { StorageManager } from './db.js';
import { getLanguageConfig, type LanguageConfig } from './languages.js';
import type { TreeSitterWorkerPool } from './pool.js';
import { extractSymbolName, friendlyKind } from './ast-utils.js';

/** 索引器配置选项 */
export interface IndexOptions {
  /** 可选的 Worker 线程池（大文件异步解析） */
  workerPool?: TreeSitterWorkerPool;
}

/**
 * 仓库索引器 — 使用 tree-sitter 解析源码 AST，提取符号（函数/类/接口等）写入 SQLite。
 *
 * 支持 10 种编程语言，不认识的扩展名静默跳过。
 * 小文件（< 100KB）主线程同步解析，大文件交 Worker Pool 异步解析。
 */
export class RepositoryIndexer {
  private dbManager: StorageManager;
  private workerPool?: TreeSitterWorkerPool;

  constructor(dbManager: StorageManager, options?: IndexOptions) {
    this.dbManager = dbManager;
    this.workerPool = options?.workerPool;
  }

  /** 索引单个文件：读取 → tree-sitter 解析 → 写入符号表 */
  async indexFile(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const stats = await fs.stat(filePath);

      if (content.length === 0) return;

      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      const lang = getLanguageConfig(ext);
      if (!lang) return; // 不支持的语言扩展名，静默跳过

      // 增量索引：mtime 未变则跳过
      const storedMtime = this.dbManager.getFileMtime(filePath);
      if (storedMtime !== null && storedMtime === stats.mtimeMs) return;

      // 清除旧索引，写入新文件记录
      this.dbManager.clearFileIndex(filePath);
      this.dbManager.insertFile(filePath, stats.mtimeMs);

      // 大文件 → Worker Pool 异步解析；小文件 → 主线程同步解析
      if (this.workerPool && this.workerPool.shouldUsePool(content)) {
        const result = await this.workerPool.parseFile(filePath, content, 'index');
        if (result.skipped) return;
        for (const sym of result.symbols ?? []) {
          this.dbManager.insertSymbol(sym.name, sym.kind, filePath, sym.startLine, sym.endLine);
        }
      } else {
        const parser = new Parser();
        parser.setLanguage(lang.grammar);
        const tree = parser.parse(content);

        this._extractSymbols(tree.rootNode, lang, filePath, (sym) => {
          this.dbManager.insertSymbol(sym.name, sym.kind, filePath, sym.startLine, sym.endLine);
        });
      }
    } catch (err) {
      console.warn(`[Indexer] 跳过文件 ${filePath}: ${(err as Error).message}`);
    }
  }

  /** DFS 深度优先遍历 AST，提取"具名符号"节点 */
  private _extractSymbols(
    node: SyntaxNode,
    lang: LanguageConfig,
    _filePath: string,
    onSymbol: (sym: { name: string; kind: string; startLine: number; endLine: number }) => void,
  ): void {
    if (lang.symbolNodeTypes.includes(node.type)) {
      const name = extractSymbolName(node);
      if (name) {
        for (const singleName of name.split(', ')) {
          onSymbol({
            name: singleName.trim(),
            kind: friendlyKind(node.type),
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });
        }
      }
    }

    for (const child of node.children) {
      this._extractSymbols(child, lang, _filePath, onSymbol);
    }
  }

}
