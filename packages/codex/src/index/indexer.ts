import * as fs from 'fs/promises';
import Parser, { type SyntaxNode } from 'tree-sitter';
import type { StorageManager } from './db.js';
import { getLanguageConfig, type LanguageConfig } from './languages.js';
import type { TreeSitterWorkerPool } from './pool.js';

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
      const name = this._extractName(node, lang);
      if (name) {
        for (const singleName of name.split(', ')) {
          onSymbol({
            name: singleName.trim(),
            kind: this._friendlyKind(node.type),
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

  /** 从 AST 节点中提取符号名（name 字段 → identifier → variable_declarator → C/C++ declarator） */
  private _extractName(node: SyntaxNode, _lang: LanguageConfig): string | null {
    // 优先查找 name 字段或 identifier 子节点
    const nameNode =
      node.childForFieldName('name') ??
      node.descendantsOfType('identifier')[0] ??
      node.descendantsOfType('property_identifier')[0] ??
      node.descendantsOfType('type_identifier')[0];

    if (nameNode) return nameNode.text;

    // 变量声明 → 提取 variable_declarator 的名称
    const declarators = node.descendantsOfType('variable_declarator');
    if (declarators.length > 0) {
      return declarators
        .map(d => d.childForFieldName('name') ?? d.descendantsOfType('identifier')[0])
        .filter(Boolean)
        .map(n => n!.text)
        .join(', ');
    }

    // C/C++ function_definition → 从 function_declarator 提取 identifier
    const declarator = node.childForFieldName('declarator');
    if (declarator) {
      const id = declarator.descendantsOfType('identifier')[0] ??
                declarator.descendantsOfType('field_identifier')[0];
      if (id) return id.text;
    }

    return null;
  }

  /** AST 节点类型 → 人类可读的符号分类名 */
  private _friendlyKind(nodeType: string): string {
    const map: Record<string, string> = {
      function_declaration: 'Function',
      function_definition: 'Function',
      function_item: 'Function',
      method_definition: 'Method',
      method_declaration: 'Method',
      class_declaration: 'Class',
      class_definition: 'Class',
      class_specifier: 'Class',
      interface_declaration: 'Interface',
      struct_item: 'Struct',
      struct_specifier: 'Struct',
      enum_declaration: 'Enum',
      enum_item: 'Enum',
      enum_specifier: 'Enum',
      trait_item: 'Trait',
      trait_declaration: 'Trait',
      variable_declaration: 'Variable',
      lexical_declaration: 'Variable',
      const_declaration: 'Constant',
      const_item: 'Constant',
      static_item: 'Static',
      type_declaration: 'Type',
      type_alias_declaration: 'Type',
      type_definition: 'Type',
      namespace_definition: 'Namespace',
      module: 'Module',
      mod_item: 'Module',
      macro_definition: 'Macro',
      export_statement: 'Export',
      impl_item: 'Impl',
      field_declaration: 'Field',
      public_field_definition: 'Field',
      constructor_declaration: 'Constructor',
      preproc_def: 'Define',
      abstract_class_declaration: 'AbstractClass',
      singleton_method: 'Method',
      template_declaration: 'Template',
      union_specifier: 'Union',
    };
    return map[nodeType] ?? nodeType;
  }
}
