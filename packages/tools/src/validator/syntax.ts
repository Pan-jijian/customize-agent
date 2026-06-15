import Parser, { type SyntaxNode } from 'tree-sitter';
import { getLanguageConfig } from '@code-agent/codex';

export interface ValidationError {
  line: number;
  column: number;
  message: string;
  severity: string;
}

export interface SyntaxValidationResult {
  valid: boolean;
  language: string;
  errors?: ValidationError[];
}

/**
 * 统一语法验证器 — 用 tree-sitter 的 hasError/ERROR 节点
 * 一套 DFS 覆盖全部 tree-sitter 支持的语言，零外部编译器依赖。
 */
export class UnifiedSyntaxValidator {
  /**
   * 验证文件内容是否可被 tree-sitter 正确解析（语法级检查）
   */
  validate(filePath: string, content: string): SyntaxValidationResult {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const lang = getLanguageConfig(ext);

    if (!lang) {
      // 不支持的扩展名 → 不阻塞修改
      return { valid: true, language: ext || 'unknown' };
    }

    const parser = new Parser();
    parser.setLanguage(lang.grammar);
    const tree = parser.parse(content);

    const errors: ValidationError[] = [];

    function walk(node: SyntaxNode): void {
      if (node.type === 'ERROR' || node.isMissing) {
        errors.push({
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          message: node.isMissing
            ? `Missing element at line ${node.startPosition.row + 1}`
            : `Syntax error: unexpected '${node.text.slice(0, 60)}'`,
          severity: 'error',
        });
      }
      for (const child of node.children) {
        walk(child);
      }
    }

    walk(tree.rootNode);

    return {
      valid: errors.length === 0,
      language: lang.name,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  static formatErrors(result: SyntaxValidationResult): string {
    if (result.valid) return '';
    return (result.errors ?? [])
      .map(e => `  Line ${e.line}:${e.column} [${result.language}] ${e.message}`)
      .join('\n');
  }
}
