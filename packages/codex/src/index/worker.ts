import { parentPort } from 'worker_threads';
import Parser, { type SyntaxNode } from 'tree-sitter';
import { getLanguageConfig, type LanguageConfig } from './languages.js';
import { extractSymbolName, collectAstErrors, friendlyKind } from './ast-utils.js';

/** 主线程发来的请求 */
interface WorkerRequest {
  id: number;
  filePath: string;
  code: string;
  /** index=符号提取, validate=语法错误检测 */
  mode: 'index' | 'validate';
}

/** 提取到的单个符号 */
interface SymbolEntry {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

/** Worker 返回给主线程的响应 */
interface WorkerResponse {
  id: number;
  symbols?: SymbolEntry[];
  errors?: Array<{ line: number; column: number; message: string }>;
  valid?: boolean;
  language?: string;
  skipped?: boolean;
  reason?: string;
}

/** 文件大小熔断线：1MB */
const MAX_FILE_SIZE = 1_000_000;
/** Parser 缓存：同语言复用 Parser 实例避免重复加载 WASM 语法 */
const parserCache = new Map<string, Parser>();

/** 获取或创建语言对应的 Parser（带缓存） */
function getParser(lang: LanguageConfig): Parser {
  const cached = parserCache.get(lang.name);
  if (cached) return cached;

  const parser = new Parser();
  parser.setLanguage(lang.grammar);
  parserCache.set(lang.name, parser);
  return parser;
}

/** 符号索引模式：DFS 遍历 AST，提取所有具名符号 */
function indexFile(code: string, lang: LanguageConfig): SymbolEntry[] {
  const parser = getParser(lang);
  const tree = parser.parse(code);
  const symbols: SymbolEntry[] = [];

  function walk(node: SyntaxNode): void {
    if (lang.symbolNodeTypes.includes(node.type)) {
      const name = extractSymbolName(node);
      if (name) {
        for (const singleName of name.split(', ')) {
          const trimmed = singleName.trim();
          if (trimmed) {
            symbols.push({
              name: trimmed,
              kind: friendlyKind(node.type),
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
            });
          }
        }
      }
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return symbols;
}

// Worker 线程入口：监听主线程消息，解析完成后 postMessage 回传
if (parentPort) {
  parentPort.on('message', (req: WorkerRequest) => {
    const ext = req.filePath.slice(req.filePath.lastIndexOf('.')).toLowerCase();
    const lang = getLanguageConfig(ext);

    // 不支持的语言扩展名 → 跳过
    if (!lang) {
      const response: WorkerResponse = {
        id: req.id,
        skipped: true,
        reason: `tree-sitter 不支持 "${ext}" 语言`,
        language: ext,
        valid: true,
      };
      parentPort!.postMessage(response);
      return;
    }

    // 文件大小熔断
    if (req.code.length > MAX_FILE_SIZE) {
      const response: WorkerResponse = {
        id: req.id,
        skipped: true,
        reason: `文件大小超出 ${MAX_FILE_SIZE} 字节熔断限制`,
      };
      parentPort!.postMessage(response);
      return;
    }

    if (req.mode === 'index') {
      const symbols = indexFile(req.code, lang);
      const response: WorkerResponse = { id: req.id, symbols, language: lang.name };
      parentPort!.postMessage(response);
    } else if (req.mode === 'validate') {
      const parser = getParser(lang);
      const tree = parser.parse(req.code);
      const errors = collectAstErrors(tree.rootNode);
      const response: WorkerResponse = {
        id: req.id,
        errors: errors.length > 0 ? errors : undefined,
        valid: errors.length === 0,
        language: lang.name,
      };
      parentPort!.postMessage(response);
    }
  });
}
