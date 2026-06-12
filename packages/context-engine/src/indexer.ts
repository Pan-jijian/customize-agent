import * as ts from 'typescript';
import * as fs from 'fs/promises';
import { StorageManager } from './db.js';

export class RepositoryIndexer {
  private dbManager: StorageManager;

  constructor(dbManager: StorageManager) {
    this.dbManager = dbManager;
  }

  /**
   * 索引单个 TypeScript / JavaScript 文件
   */
  async indexFile(filePath: string) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const stats = await fs.stat(filePath);

      // 先清除旧索引
      this.dbManager.clearFileIndex(filePath);
      this.dbManager.insertFile(filePath, stats.mtimeMs);

      // 使用 TS 官方原生的解析器生成虚拟 AST 树
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true
      );

      // 定义行号转换辅助函数
      const getLineNumber = (pos: number) => {
        return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
      };

      const db = this.dbManager;

      // 深度优先遍历 AST 节点
      function walk(node: ts.Node) {
        let name = '';
        let kind = '';

        // 识别函数声明
        if (ts.isFunctionDeclaration(node) && node.name) {
          name = node.name.text;
          kind = 'Function';
        }
        // 识别类声明
        else if (ts.isClassDeclaration(node) && node.name) {
          name = node.name.text;
          kind = 'Class';
        }
        // 识别接口声明
        else if (ts.isInterfaceDeclaration(node) && node.name) {
          name = node.name.text;
          kind = 'Interface';
        }
        // 识别类里面的方法
        else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
          name = node.name.text;
          kind = 'Method';
        }

        // 如果捕捉到了核心符号，写入数据库
        if (name && kind) {
          const startLine = getLineNumber(node.getStart(sourceFile));
          const endLine = getLineNumber(node.getEnd());
          db.insertSymbol(name, kind, filePath, startLine, endLine);
        }

        // 继续向下递归遍历子节点
        ts.forEachChild(node, walk);
      }

      // 启动遍历
      walk(sourceFile);

    } catch (err) {
      console.warn(`[Indexer] 跳过文件解析 ${filePath}: ${(err as Error).message}`);
    }
  }
}