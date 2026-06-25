import { type SyntaxNode } from 'tree-sitter';

/** 声明类节点类型：通过这些类型的节点需要从 declarator 子节点提取名称 */
const DECLARATOR_TYPES = new Set(['variable_declaration', 'lexical_declaration', 'field_declaration']);

/**
 * 从 AST 节点中提取符号名（通用算法，覆盖全部 10 种语言）。
 *
 * 策略 1：直接查找 name 字段或 identifier 子节点
 * 策略 2：声明语句 → variable_declarator → name 字段
 * 策略 3：C/C++ function_definition → declarator 字段 → identifier
 */
export function extractSymbolName(node: SyntaxNode): string | null {
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

/** 单个语法验证错误 */
export interface AstValidationError {
  line: number;
  column: number;
  message: string;
}

/**
 * DFS 遍历 AST，收集所有 ERROR 节点和缺失节点。
 * 供 UnifiedSyntaxValidator 和 Worker 线程共用。
 */
export function collectAstErrors(
  rootNode: SyntaxNode,
  errorMessageMaxLen: number = 40,
): AstValidationError[] {
  const result: AstValidationError[] = [];

  function findErrors(node: SyntaxNode): void {
    if (node.type === 'ERROR' || node.isMissing) {
      result.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        message: node.isMissing
          ? `Missing element at line ${node.startPosition.row + 1}`
          : `Syntax error: unexpected '${node.text.slice(0, errorMessageMaxLen)}'`,
      });
    }
    for (const child of node.children) {
      findErrors(child);
    }
  }

  findErrors(rootNode);
  return result;
}

/** AST 节点类型 → 人类可读的符号分类名 */
export function friendlyKind(nodeType: string): string {
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
