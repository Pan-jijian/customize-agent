import { parentPort } from 'worker_threads';
import Parser, { type SyntaxNode } from 'tree-sitter';
import { getLanguageConfig, type LanguageConfig } from './languages.js';

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

/** 声明类节点类型：通过这些类型的节点需要从 declarator 子节点提取名称 */
const DECLARATOR_TYPES = new Set(['variable_declaration', 'lexical_declaration', 'field_declaration']);

/** 从 AST 节点中提取符号名（通用算法，覆盖全部 10 种语言） */
function extractName(node: SyntaxNode): string | null {
  // 策略 1：直接查找 name 字段或 identifier 子节点
  const nameNode =
    node.childForFieldName('name') ??
    node.descendantsOfType('identifier')[0] ??
    node.descendantsOfType('property_identifier')[0] ??
    node.descendantsOfType('type_identifier')[0];

  if (nameNode) return nameNode.text;

  // 策略 2：声明语句 → variable_declarator → name 字段
  if (DECLARATOR_TYPES.has(node.type)) {
    const declarators = node.descendantsOfType('variable_declarator');
    if (declarators.length > 0) {
      const names: string[] = [];
      for (const d of declarators) {
        const n = d.childForFieldName('name') ?? d.descendantsOfType('identifier')[0];
        if (n) names.push(n.text);
      }
      return names.join(', ');
    }
  }

  // 策略 3：C/C++ function_definition → declarator 字段 → identifier
  const declarator = node.childForFieldName('declarator');
  if (declarator) {
    const id = declarator.descendantsOfType('identifier')[0] ??
              declarator.descendantsOfType('field_identifier')[0];
    if (id) return id.text;
  }

  return null;
}

/** 符号索引模式：DFS 遍历 AST，提取所有具名符号 */
function indexFile(code: string, lang: LanguageConfig): SymbolEntry[] {
  const parser = getParser(lang);
  const tree = parser.parse(code);
  const symbols: SymbolEntry[] = [];

  function walk(node: SyntaxNode): void {
    if (lang.symbolNodeTypes.includes(node.type)) {
      const name = extractName(node);
      if (name) {
        for (const singleName of name.split(', ')) {
          const trimmed = singleName.trim();
          if (trimmed) {
            symbols.push({
              name: trimmed,
              kind: node.type,
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

/** 语法验证模式：DFS 遍历 AST，收集所有 ERROR 节点和缺失节点 */
function validateFile(code: string, lang: LanguageConfig): WorkerResponse['errors'] {
  const parser = getParser(lang);
  const tree = parser.parse(code);
  const result: Array<{ line: number; column: number; message: string }> = [];

  function findErrors(node: SyntaxNode): void {
    if (node.type === 'ERROR' || node.isMissing) {
      result.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        message: node.isMissing
          ? `Missing element at line ${node.startPosition.row + 1}`
          : `Syntax error: unexpected '${node.text.slice(0, 40)}'`,
      });
    }
    for (const child of node.children) {
      findErrors(child);
    }
  }

  findErrors(tree.rootNode);
  return result.length > 0 ? result : undefined;
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
      const errors = validateFile(req.code, lang);
      const response: WorkerResponse = {
        id: req.id,
        errors,
        valid: !errors || errors.length === 0,
        language: lang.name,
      };
      parentPort!.postMessage(response);
    }
  });
}
