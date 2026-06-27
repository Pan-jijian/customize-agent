/**
 * 统一 Capability 枚举 (ADR-18)。
 * 权限引擎和角色系统共享同一套 Capability 模型，
 * 不再用硬编码工具名列表做权限隔离。
 */
export enum Capability {
  /** 读取代码：read_file, list_files */
  READ_CODE = 'read_code',
  /** 写入代码：modify_file */
  WRITE_CODE = 'write_code',
  /** 符号搜索：search_symbol, fts_search, grep_search, semantic_search */
  SEARCH_SYMBOL = 'search_symbol',
  /** 执行终端命令 */
  EXECUTE_COMMAND = 'execute_command',
  /** Git 操作：git_status, git_diff, git_commit */
  GIT_OPERATION = 'git_operation',
  /** LSP 查询：lsp_definition, lsp_references, lsp_diagnostics */
  LSP_QUERY = 'lsp_query',
  /** 记忆访问：memory recall/inject/record */
  MEMORY_ACCESS = 'memory_access',
  /** 外部 MCP 工具 */
  MCP_EXTERNAL = 'mcp_external',
  /** Embedding 语义搜索 */
  EMBEDDING_SEARCH = 'embedding_search',
}

/**
 * 工具 → Capability 映射表。
 * 每个工具名绑定其所需的 Capability 列表。
 */
export const TOOL_CAPABILITY_MAP: Record<string, Capability[]> = {
  read_file: [Capability.READ_CODE],
  list_files: [Capability.READ_CODE],
  write_file: [Capability.WRITE_CODE],
  execute_command: [Capability.EXECUTE_COMMAND],
  git_commit: [Capability.GIT_OPERATION],
  lsp_definition: [Capability.LSP_QUERY],
  lsp_references: [Capability.LSP_QUERY],
  lsp_diagnostics: [Capability.LSP_QUERY],
};

/** 子智能体角色 */
export type SubagentRole = 'explorer' | 'planner' | 'implementer' | 'reviewer' | 'tester' | 'conflict_resolver';

/**
 * 角色 → Capability 绑定表。
 * 不再需要硬编码 writeToolNames = ['modify_file', ...]。
 */
export const ROLE_CAPABILITY_MAP: Record<SubagentRole, Capability[]> = {
  explorer: [
    Capability.READ_CODE, Capability.SEARCH_SYMBOL,
    Capability.LSP_QUERY, Capability.EMBEDDING_SEARCH,
  ],
  planner: [
    Capability.READ_CODE, Capability.SEARCH_SYMBOL,
    Capability.LSP_QUERY, Capability.EMBEDDING_SEARCH, Capability.MEMORY_ACCESS,
  ],
  implementer: [
    Capability.READ_CODE, Capability.WRITE_CODE,
    Capability.SEARCH_SYMBOL, Capability.EXECUTE_COMMAND,
    Capability.GIT_OPERATION, Capability.LSP_QUERY,
    Capability.EMBEDDING_SEARCH,
  ],
  reviewer: [
    Capability.READ_CODE, Capability.SEARCH_SYMBOL,
    Capability.LSP_QUERY, Capability.GIT_OPERATION,
  ],
  tester: [
    Capability.READ_CODE, Capability.WRITE_CODE,
    Capability.EXECUTE_COMMAND, Capability.SEARCH_SYMBOL,
  ],
  conflict_resolver: [
    Capability.READ_CODE, Capability.WRITE_CODE, Capability.GIT_OPERATION,
  ],
};

/** 获取工具所需的 Capability 列表 */
export function getCapabilitiesForTool(toolName: string): Capability[] {
  return TOOL_CAPABILITY_MAP[toolName] ?? [];
}

/** 检查角色是否拥有某个 Capability */
export function roleHasCapability(role: SubagentRole, capability: Capability): boolean {
  return (ROLE_CAPABILITY_MAP[role] ?? []).includes(capability);
}

/** 检查角色是否拥有所有必需 Capability */
export function roleHasCapabilities(role: SubagentRole, capabilities: Capability[]): boolean {
  return capabilities.every(c => roleHasCapability(role, c));
}
