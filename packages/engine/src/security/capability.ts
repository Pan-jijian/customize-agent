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
  /** 网络访问：web_search, web_fetch, download_file */
  NETWORK = 'network',
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
  stat_file: [Capability.READ_CODE],
  tree: [Capability.READ_CODE],
  repo_map: [Capability.READ_CODE],
  glob: [Capability.READ_CODE],
  dependency_graph: [Capability.READ_CODE],
  detect_package_manager: [Capability.READ_CODE],
  doctor: [Capability.READ_CODE],
  version: [Capability.READ_CODE],
  tool_health: [Capability.READ_CODE],
  todo_write: [Capability.READ_CODE],
  inspect_file: [Capability.READ_CODE],
  extract_text: [Capability.READ_CODE],
  extract_pdf_text: [Capability.READ_CODE],
  extract_docx_text: [Capability.READ_CODE],
  extract_xlsx_data: [Capability.READ_CODE],
  ocr_image: [Capability.READ_CODE],
  transcribe_audio: [Capability.READ_CODE],
  video_metadata: [Capability.READ_CODE],
  mcp_list: [Capability.READ_CODE],
  mcp_tools: [Capability.READ_CODE],
  plugin_list: [Capability.READ_CODE],
  checkpoint_list: [Capability.READ_CODE],
  open_preview: [Capability.READ_CODE],
  check_command: [Capability.READ_CODE],

  search: [Capability.SEARCH_SYMBOL],
  symbol_search: [Capability.SEARCH_SYMBOL],

  write_file: [Capability.WRITE_CODE],
  edit_file: [Capability.WRITE_CODE],
  multi_edit: [Capability.WRITE_CODE],
  delete_file: [Capability.WRITE_CODE],
  move_file: [Capability.WRITE_CODE],
  copy_file: [Capability.WRITE_CODE],
  mkdir: [Capability.WRITE_CODE],
  export_markdown: [Capability.WRITE_CODE],
  export_json: [Capability.WRITE_CODE],
  export_html: [Capability.WRITE_CODE],
  export_pdf: [Capability.WRITE_CODE],
  export_session: [Capability.WRITE_CODE],
  zip_files: [Capability.WRITE_CODE],
  convert_file: [Capability.WRITE_CODE],
  compress_image: [Capability.WRITE_CODE],
  generate_thumbnail: [Capability.WRITE_CODE],
  mcp_add: [Capability.WRITE_CODE],
  mcp_remove: [Capability.WRITE_CODE],
  plugin_install: [Capability.WRITE_CODE],
  checkpoint_create: [Capability.WRITE_CODE],
  checkpoint_restore: [Capability.WRITE_CODE],
  checkpoint_delete: [Capability.WRITE_CODE],

  execute_command: [Capability.EXECUTE_COMMAND],
  run_background: [Capability.EXECUTE_COMMAND],
  stop_command: [Capability.EXECUTE_COMMAND],
  browser_open: [Capability.EXECUTE_COMMAND],
  run_build: [Capability.EXECUTE_COMMAND],
  run_test: [Capability.EXECUTE_COMMAND],
  run_lint: [Capability.EXECUTE_COMMAND],

  web_search: [Capability.NETWORK],
  web_fetch: [Capability.NETWORK],
  download_file: [Capability.NETWORK, Capability.WRITE_CODE],

  git_status: [Capability.GIT_OPERATION],
  git_diff: [Capability.GIT_OPERATION],
  git_log: [Capability.GIT_OPERATION],
  git_stash: [Capability.GIT_OPERATION],
  git_apply_patch: [Capability.GIT_OPERATION, Capability.WRITE_CODE],
  git_create_patch: [Capability.READ_CODE],
  export_patch: [Capability.READ_CODE],
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
    Capability.NETWORK, Capability.MCP_EXTERNAL,
  ],
  planner: [
    Capability.READ_CODE, Capability.SEARCH_SYMBOL,
    Capability.LSP_QUERY, Capability.EMBEDDING_SEARCH, Capability.MEMORY_ACCESS,
    Capability.NETWORK, Capability.MCP_EXTERNAL,
  ],
  implementer: [
    Capability.READ_CODE, Capability.WRITE_CODE,
    Capability.SEARCH_SYMBOL, Capability.EXECUTE_COMMAND,
    Capability.GIT_OPERATION, Capability.LSP_QUERY,
    Capability.EMBEDDING_SEARCH, Capability.NETWORK, Capability.MCP_EXTERNAL,
  ],
  reviewer: [
    Capability.READ_CODE, Capability.SEARCH_SYMBOL,
    Capability.LSP_QUERY, Capability.GIT_OPERATION,
  ],
  tester: [
    Capability.READ_CODE, Capability.WRITE_CODE,
    Capability.EXECUTE_COMMAND, Capability.SEARCH_SYMBOL,
    Capability.GIT_OPERATION, Capability.LSP_QUERY,
  ],
  conflict_resolver: [
    Capability.READ_CODE, Capability.WRITE_CODE, Capability.GIT_OPERATION,
    Capability.EXECUTE_COMMAND, Capability.SEARCH_SYMBOL, Capability.LSP_QUERY,
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
