import type { Language } from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Rust from 'tree-sitter-rust';
import Go from 'tree-sitter-go';
import Java from 'tree-sitter-java';
import C from 'tree-sitter-c';
import Cpp from 'tree-sitter-cpp';
import Ruby from 'tree-sitter-ruby';
import Php from 'tree-sitter-php';
import JavaScript from 'tree-sitter-javascript';

/** 单种语言的 tree-sitter 配置 */
export interface LanguageConfig {
  /** 语言名称 */
  name: string;
  /** 关联的文件扩展名列表 */
  extensions: string[];
  /** tree-sitter 语法对象 */
  grammar: Language;
  /** AST 中代表"具名符号"的节点类型列表 */
  symbolNodeTypes: string[];
}

/**
 * 类型适配：tree-sitter 各语法包的 Language 类型与 tree-sitter 核心的 Language 类型
 * 在 TypeScript 层面不兼容，但运行时完全一致。此函数做一次强制转换。
 */
function asLanguage(g: { language: unknown }): Language {
  return g as unknown as Language;
}

const tsx = TypeScript.tsx;

const languageConfigs: LanguageConfig[] = [
  {
    name: 'TypeScript',
    extensions: ['.ts'],
    grammar: asLanguage(tsx),
    symbolNodeTypes: [
      'function_declaration', 'class_declaration', 'interface_declaration',
      'method_definition', 'public_field_definition', 'variable_declaration',
      'lexical_declaration', 'export_statement', 'type_alias_declaration',
      'enum_declaration', 'abstract_class_declaration',
    ],
  },
  {
    name: 'TSX',
    extensions: ['.tsx'],
    grammar: asLanguage(tsx),
    symbolNodeTypes: [
      'function_declaration', 'class_declaration', 'interface_declaration',
      'method_definition', 'variable_declaration', 'lexical_declaration',
      'export_statement', 'type_alias_declaration',
    ],
  },
  {
    name: 'JavaScript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    grammar: asLanguage(JavaScript),
    symbolNodeTypes: [
      'function_declaration', 'class_declaration', 'method_definition',
      'variable_declaration', 'lexical_declaration', 'export_statement',
    ],
  },
  {
    name: 'Python',
    extensions: ['.py', '.pyw'],
    grammar: asLanguage(Python),
    symbolNodeTypes: ['function_definition', 'class_definition'],
  },
  {
    name: 'Rust',
    extensions: ['.rs'],
    grammar: asLanguage(Rust),
    symbolNodeTypes: [
      'function_item', 'struct_item', 'enum_item', 'trait_item',
      'impl_item', 'const_item', 'static_item', 'macro_definition', 'mod_item',
    ],
  },
  {
    name: 'Go',
    extensions: ['.go'],
    grammar: asLanguage(Go),
    symbolNodeTypes: [
      'function_declaration', 'type_declaration', 'method_declaration',
      'const_declaration', 'var_declaration',
    ],
  },
  {
    name: 'Java',
    extensions: ['.java'],
    grammar: asLanguage(Java),
    symbolNodeTypes: [
      'method_declaration', 'class_declaration', 'interface_declaration',
      'field_declaration', 'constructor_declaration', 'enum_declaration',
    ],
  },
  {
    name: 'C',
    extensions: ['.c', '.h'],
    grammar: asLanguage(C),
    symbolNodeTypes: [
      'function_definition', 'struct_specifier', 'enum_specifier',
      'union_specifier', 'type_definition', 'preproc_def',
    ],
  },
  {
    name: 'C++',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    grammar: asLanguage(Cpp),
    symbolNodeTypes: [
      'function_definition', 'class_specifier', 'struct_specifier',
      'enum_specifier', 'namespace_definition', 'template_declaration', 'type_definition',
    ],
  },
  {
    name: 'Ruby',
    extensions: ['.rb'],
    grammar: asLanguage(Ruby),
    symbolNodeTypes: ['method', 'class', 'module', 'singleton_method'],
  },
  {
    name: 'PHP',
    extensions: ['.php'],
    grammar: asLanguage(Php.php),
    symbolNodeTypes: [
      'function_definition', 'class_declaration', 'interface_declaration',
      'trait_declaration', 'method_declaration', 'enum_declaration',
    ],
  },
];

/** 扩展名 → 语言配置的快速查找表 */
const extToLang = new Map<string, LanguageConfig>();
for (const config of languageConfigs) {
  for (const ext of config.extensions) {
    extToLang.set(ext, config);
  }
}

/** 按文件扩展名查找对应的语言配置（找不到返回 undefined） */
export function getLanguageConfig(ext: string): LanguageConfig | undefined {
  return extToLang.get(ext.toLowerCase());
}

/** 获取所有已支持的文件扩展名列表 */
export function getSupportedExtensions(): string[] {
  return Array.from(extToLang.keys());
}
