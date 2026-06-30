import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import type { ILLMProvider } from '@customize-agent/llm';
import {
  ToolRegistry,
  Orchestrator,
  SafeWorktreeManager,
  McpClient,
  createBuiltinSubagentConfig,
  ROLE_CAPABILITY_MAP,
  type ToolExecutionContext,
  type CollaborationMode,
  type SubagentRole,
  type SubagentTask,
  type McpServerConfig,
} from '@customize-agent/engine';
import { ToolKit, SandboxExecutor, BuiltinTools } from '@customize-agent/tools';
import { LSPManager, CodeSearcher } from '@customize-agent/search';
import { BINARY_EXTENSIONS } from '@customize-agent/types';

type CliMcpConfig = Record<string, { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }>;

export interface BuildRegistryOptions {
  root: string;
  lspManager?: LSPManager;
  provider?: ILLMProvider;
  includeOrchestrator?: boolean;
}

function loadMcpServerConfigs(root: string): McpServerConfig[] {
  const file = join(os.homedir(), '.customize-agent', 'mcp.json');
  if (!existsSync(file)) return [];
  try {
    const config = JSON.parse(readFileSync(file, 'utf-8')) as CliMcpConfig;
    return Object.entries(config).map(([name, value]) => ({
      name,
      command: value.command,
      args: value.args ?? [],
      cwd: value.cwd ?? root,
      env: value.env,
    }));
  } catch {
    return [];
  }
}

export async function connectConfiguredMcp(registry: ToolRegistry, root: string): Promise<McpClient | undefined> {
  const configs = loadMcpServerConfigs(root);
  if (configs.length === 0) return undefined;
  const client = new McpClient(registry);
  for (const config of configs) {
    try {
      await client.connect(config);
    } catch {
      // MCP Server 不可用时跳过，避免阻塞主 Agent 启动。
    }
  }
  return client;
}

function reg(
  r: ToolRegistry,
  name: string,
  desc: string,
  props: Record<string, { type: string; description: string }>,
  required: string[],
  caps: string[],
  needsApproval: boolean,
  handler: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string>,
): void {
  r.register({
    name,
    description: desc,
    parameters: { type: 'object', properties: props, required, additionalProperties: false },
    requiresApproval: needsApproval,
    capabilities: caps,
    handler,
  });
}

const SUBAGENT_ROLES: SubagentRole[] = ['explorer', 'planner', 'implementer', 'reviewer', 'tester', 'conflict_resolver'];
const COLLABORATION_MODES: CollaborationMode[] = ['orchestrator', 'pipeline', 'swarm'];

function parseSubagentRole(value: unknown, fallback: SubagentRole): SubagentRole {
  return SUBAGENT_ROLES.includes(value as SubagentRole) ? value as SubagentRole : fallback;
}

function parseCollaborationMode(value: unknown): CollaborationMode {
  return COLLABORATION_MODES.includes(value as CollaborationMode) ? value as CollaborationMode : 'orchestrator';
}

function parseOrchestrationTasks(args: Record<string, unknown>): SubagentTask[] {
  const rawTasks = args.tasks;
  if (Array.isArray(rawTasks) && rawTasks.length > 0) {
    return rawTasks.map((item, index) => {
      if (typeof item === 'string') {
        return { id: `task-${index + 1}`, description: item, dependsOn: index === 0 ? [] : [`task-${index}`], expectedFiles: [] };
      }
      const task = item as Record<string, unknown>;
      return {
        id: String(task.id ?? `task-${index + 1}`),
        description: String(task.description ?? task.task ?? ''),
        dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
        expectedFiles: Array.isArray(task.expectedFiles) ? task.expectedFiles.map(String) : [],
      };
    }).filter(task => task.description.trim().length > 0);
  }

  const task = String(args.task ?? '').trim();
  return task ? [{ id: 'task-1', description: task, dependsOn: [], expectedFiles: [] }] : [];
}

function createSubagentToolRegistry(role: SubagentRole, provider: ILLMProvider, root: string, lspManager?: LSPManager): ToolRegistry {
  const allowed = new Set<string>(ROLE_CAPABILITY_MAP[role]);
  const baseRegistry = buildRegistry({ root, lspManager, provider, includeOrchestrator: false });
  const subRegistry = new ToolRegistry();
  for (const tool of baseRegistry.listAll()) {
    if (tool.name === 'orchestrate_agents') continue;
    if (tool.capabilities.every(cap => allowed.has(cap))) {
      subRegistry.register(tool);
    }
  }
  return subRegistry;
}

function formatOrchestrationResult(result: Awaited<ReturnType<Orchestrator['orchestrate']>>): string {
  const lines = [
    `Status: ${result.success ? 'success' : 'failed'}`,
    `Summary: ${result.summary}`,
    `Tokens: ${result.totalTokens}`,
    `Cost: $${result.totalCost.toFixed(6)}`,
    `Duration: ${result.totalDurationMs}ms`,
  ];

  for (const [index, subResult] of result.subagentResults.entries()) {
    lines.push('', `## Subagent ${index + 1}: ${subResult.role}`, `Success: ${subResult.success}`, subResult.summary);
    if (subResult.filesModified.length > 0) lines.push(`Files modified: ${subResult.filesModified.join(', ')}`);
    if (subResult.findings.length > 0) lines.push(`Findings:\n${subResult.findings.join('\n')}`);
  }

  return lines.join('\n');
}

export function buildRegistry(options: BuildRegistryOptions): ToolRegistry {
  const { root, lspManager, provider, includeOrchestrator = true } = options;
  const registry = new ToolRegistry();
  const toolkit = new ToolKit(root);
  const builtinTools = new BuiltinTools(root);

  registry.register({
    name: 'read_file',
    description: 'Read a text file. Supports offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Relative path to the file' },
        offset: { type: 'number', description: 'Start line (1-indexed)' },
        limit: { type: 'number', description: 'Max lines to read (default all)' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    requiresApproval: false,
    capabilities: ['read_code'],
    handler: async (args: Record<string, unknown>) => {
      const filePath = String(args.input).replace(/\/+$/, '');
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      if (BINARY_EXTENSIONS.has(ext)) {
        return `[Binary] ${filePath} (${ext} format), use execute_command with external tools.`;
      }
      const content = await toolkit.readFile(filePath);
      if (!BINARY_EXTENSIONS.has(ext)) {
        const head = content.slice(0, 1024);
        const nulCount = head.split('\x00').length - 1;
        const controlChars = head.replace(/[\P{Cc}\n\r\t]/gu, '').length;
        if (nulCount > 0 || controlChars > head.length * 0.1) {
          return `[Binary] ${filePath} detected as binary content.`;
        }
      }
      const offset = typeof args.offset === 'number' ? args.offset : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      if ((offset === undefined && limit === undefined) && content.length > 100_000) {
        const preview = content.slice(0, 5000);
        const totalLines = content.split('\n').length;
        return `${preview}\n\n...[Truncated: ${(content.length / 1024).toFixed(1)} KB, ${totalLines} lines total. Use offset/limit to read in chunks.]`;
      }
      if (offset === undefined && limit === undefined) return content;
      const lines = content.split('\n');
      const start = Math.max(0, (offset ?? 1) - 1);
      const end = limit ? start + limit : undefined;
      return `[lines ${start + 1}-${end ?? lines.length} of ${lines.length}]\n${lines.slice(start, end).join('\n')}`;
    },
  });

  reg(registry, 'list_files', 'List files and directories in the project root.', {}, [], ['read_code'], false, async () => (await toolkit.listFiles()).join('\n'));
  reg(registry, 'search', 'Fast text search across all files using ripgrep. Use for finding any text, patterns, documentation, config values, or code references.', { pattern: { type: 'string', description: 'Text or regex pattern to search for' } }, ['pattern'], ['read_code'], false, async (args, context) => {
    const searcher = new CodeSearcher(root);
    const matches = await searcher.grep(String(args.pattern), { maxResults: 20, signal: context?.signal });
    return matches.length > 0 ? matches.map(m => `${m.file}:${m.line}: ${m.content}`).join('\n') : `No matches found for "${args.pattern}".`;
  });

  registry.register({
    name: 'write_file',
    description: 'Create/overwrite a file, or modify using SEARCH/REPLACE blocks. If input contains `<<<<<<< SEARCH` it is treated as a diff; otherwise it is treated as the full new file content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to create or modify' },
        input: { type: 'string', description: 'Full file content or SEARCH/REPLACE diff block' },
      },
      required: ['path', 'input'],
      additionalProperties: false,
    },
    requiresApproval: true,
    capabilities: ['write_code'],
    handler: async (args: Record<string, unknown>) => {
      const filePath = String(args.path);
      const input = String(args.input);
      if (input.includes('<<<<<<< SEARCH')) {
        const result = await toolkit.modifyFileWithDiff(filePath, input);
        return `${result.preview}\n\nPlease run the build command to validate this change.`;
      }
      await toolkit.writeFileWithBackup(filePath, input);
      return `File created/updated: ${filePath} (${input.length} chars)`;
    },
  });

  registry.register({
    name: 'execute_command',
    description: 'Execute a terminal command. Supports both native shell commands and code execution (python3, node). For Python/data analysis scripts, Docker sandbox is auto-selected if available; otherwise falls back to native sandbox.',
    parameters: { type: 'object', properties: { input: { type: 'string', description: 'The command or code to execute.' } }, required: ['input'], additionalProperties: false },
    requiresApproval: true,
    capabilities: ['execute_command'],
    handler: async (args: Record<string, unknown>, context?: ToolExecutionContext) => {
      const cmd = String(args.input);
      const isCode = cmd.startsWith('python3 -c') || cmd.startsWith('python -c') || cmd.startsWith('node -e');
      const executor = isCode ? new SandboxExecutor('docker', root) : null;
      const result = executor ? await executor.execute(cmd, undefined, true, context?.signal) : await toolkit.terminal.executeCommand(cmd, true, context?.signal);
      const out: string[] = [];
      if (result.stdout) out.push(result.stdout.trimEnd());
      if (result.stderr) out.push(`[Stderr]\n${result.stderr.trimEnd()}`);
      if (!result.stdout && !result.stderr && result.code !== 0) out.push('(no output)');
      if (result.code !== 0) out.push(`[Exit ${result.code}]`);
      return out.join('\n') || `[Exit ${result.code}]`;
    },
  });

  // ── 声明式注册：从 BuiltinTools.toolDefs 读取 Schema，只需提供 Handler ──
  const S = String;
  const N = Number;
  const handlers: Record<string, (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string>> = {
    edit_file:             (a) => builtinTools.editFile(S(a.path), S(a.search), S(a.replace)),
    multi_edit:            (a) => builtinTools.multiEdit(S(a.path), a.edits as Array<{ search: string; replace: string }>),
    delete_file:           (a) => builtinTools.deleteFile(S(a.path)),
    move_file:             (a) => builtinTools.moveFile(S(a.from), S(a.to)),
    copy_file:             (a) => builtinTools.copyFile(S(a.from), S(a.to)),
    mkdir:                 (a) => builtinTools.mkdir(S(a.path)),
    stat_file:             (a) => builtinTools.statFile(S(a.path)),
    inspect_file:          (a) => builtinTools.inspectFile(S(a.path)),
    tree:                  (a) => builtinTools.tree(S(a.path ?? '.'), N(a.depth ?? 3)),
    repo_map:              () => builtinTools.repoMap(),
    symbol_search:         (a) => builtinTools.symbolSearch(S(a.query)),
    glob:                  (a) => builtinTools.glob(S(a.pattern)),
    dependency_graph:      () => builtinTools.dependencyGraph(),
    detect_package_manager:() => builtinTools.detectPackageManager(),
    web_search:            (a, c) => builtinTools.webSearch(S(a.query), c?.signal),
    web_fetch:             (a, c) => builtinTools.webFetch(S(a.url), c?.signal),
    download_file:         (a, c) => builtinTools.downloadFile(S(a.url), S(a.output), c?.signal),
    export_markdown:       (a) => builtinTools.exportMarkdown(S(a.output), S(a.content)),
    export_json:           (a) => builtinTools.exportJson(S(a.output), a.data),
    export_html:           (a) => builtinTools.exportHtml(S(a.output), S(a.title ?? 'Export'), S(a.content)),
    export_pdf:            (a) => builtinTools.exportPdf(S(a.output), S(a.title ?? 'Export'), S(a.content)),
    export_session:        (a) => builtinTools.exportSession(S(a.output), a.data),
    zip_files:             (a) => builtinTools.zipFiles(S(a.output), a.files as string[]),
    git_status:            () => builtinTools.git(['status', '--short']),
    git_diff:              () => builtinTools.git(['diff']),
    git_log:               () => builtinTools.git(['log', '--oneline', '-20']),
    git_stash:             () => builtinTools.git(['stash', 'push']),
    git_apply_patch:       (a) => builtinTools.git(['apply', S(a.path)]),
    git_create_patch:      (a) => builtinTools.exportMarkdown(S(a.output), (async () => await builtinTools.git(['diff']))() as unknown as string),
    export_patch:           (a) => builtinTools.exportMarkdown(S(a.output), (async () => await builtinTools.git(['diff']))() as unknown as string),
    run_background:        (a) => builtinTools.runBackground(S(a.command ?? a.input)),
    check_command:         (a) => builtinTools.checkCommand(S(a.id)),
    stop_command:          (a) => builtinTools.stopCommand(S(a.id)),
    open_preview:          (a) => builtinTools.openPreview(S(a.url)),
    browser_open:          (a) => builtinTools.browserOpen(S(a.url)),
    run_test:              () => builtinTools.runScript('test'),
    run_build:             () => builtinTools.runScript('build'),
    run_lint:              () => builtinTools.runScript('lint'),
    doctor:                () => builtinTools.doctor(),
    version:               () => builtinTools.version(),
    tool_health:           () => builtinTools.toolHealth(),
    todo_write:            (a) => builtinTools.todoWrite(a.items as string[]),
    check_update:          (a) => builtinTools.checkUpdate(a.package ? S(a.package) : undefined, a.current ? S(a.current) : undefined),
    update:                (a) => builtinTools.update(a.package ? S(a.package) : undefined),
    extract_text:          (a) => builtinTools.extractText(S(a.path)),
    extract_pdf_text:      (a) => builtinTools.extractPdfText(S(a.path)),
    extract_docx_text:     (a) => builtinTools.extractDocxText(S(a.path)),
    extract_xlsx_data:     (a) => builtinTools.extractXlsxData(S(a.path)),
    ocr_image:             (a) => builtinTools.ocrImage(S(a.path)),
    transcribe_audio:      (a) => builtinTools.transcribeAudio(S(a.path)),
    video_metadata:        (a) => builtinTools.videoMetadata(S(a.path)),
    convert_file:          (a) => builtinTools.convertFile(S(a.input), S(a.output)),
    compress_image:        (a) => builtinTools.compressImage(S(a.input), S(a.output)),
    generate_thumbnail:    (a) => builtinTools.generateThumbnail(S(a.input), S(a.output)),
    mcp_list:              () => builtinTools.mcpList(),
    mcp_add:               (a) => builtinTools.mcpAdd(S(a.name), S(a.command)),
    mcp_remove:            (a) => builtinTools.mcpRemove(S(a.name)),
    mcp_tools:             (a) => builtinTools.mcpTools(a.name ? S(a.name) : undefined),
    plugin_list:           () => builtinTools.pluginList(),
    plugin_install:        (a) => builtinTools.pluginInstall(S(a.name)),
    checkpoint_create:     (a) => builtinTools.checkpointCreate(S(a.name)),
    checkpoint_list:       () => builtinTools.checkpointList(),
    checkpoint_restore:    (a) => builtinTools.checkpointRestore(S(a.name)),
    checkpoint_delete:     (a) => builtinTools.checkpointDelete(S(a.name)),
  };

  for (const def of BuiltinTools.toolDefs) {
    const handler = handlers[def.name];
    if (!handler) continue; // 跳过未在 handlers 中定义的（如某些内置工具可能暂未注册）
    reg(registry, def.name, def.description, def.params, def.required, def.capabilities, def.needsApproval, handler);
  }

  // git_commit 需要 toolkit（不在 BuiltinTools 中）
  reg(registry, 'git_commit', 'Stage all changes and create a git commit with the given message.', { input: { type: 'string', description: 'Commit message' } }, ['input'], ['git_operation'], true, async args => toolkit.commitAll(String(args.input)));

  if (provider && includeOrchestrator) {
    registry.register({
      name: 'orchestrate_agents',
      description: 'Delegate a complex task to built-in subagents and aggregate their results. Supports orchestrator, pipeline, and swarm collaboration modes.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Single task description. Used when tasks is omitted.' },
          tasks: { type: 'array', description: 'Optional array of task strings or task objects with id, description, dependsOn, expectedFiles.' },
          mode: { type: 'string', description: 'Collaboration mode: orchestrator, pipeline, or swarm.' },
          role: { type: 'string', description: 'Default subagent role: explorer, planner, implementer, reviewer, tester, or conflict_resolver.' },
          roles: { type: 'array', description: 'Optional role per task, e.g. ["explorer", "implementer", "reviewer"].' },
        },
        required: [],
        additionalProperties: false,
      },
      requiresApproval: true,
      capabilities: ['read_code', 'write_code', 'execute_command', 'git_operation'],
      handler: async args => {
        const tasks = parseOrchestrationTasks(args);
        if (tasks.length === 0) return 'No subagent task provided.';
        const mode = parseCollaborationMode(args.mode);
        const defaultRole = parseSubagentRole(args.role, mode === 'swarm' ? 'implementer' : 'planner');
        const roles = Array.isArray(args.roles) ? args.roles : [];
        const orchestrator = new Orchestrator(new SafeWorktreeManager(root));
        const result = await orchestrator.orchestrate(tasks, (task, index, worktreePath) => {
          const role = parseSubagentRole(roles[index], defaultRole);
          const subRoot = worktreePath ?? root;
          const subLsp = worktreePath ? new LSPManager(worktreePath) : lspManager;
          return createBuiltinSubagentConfig(role, `${role}-${task.id}-${index + 1}`, provider, createSubagentToolRegistry(role, provider, subRoot, subLsp));
        }, mode);
        return formatOrchestrationResult(result);
      },
    });
  }

  if (lspManager) {
    reg(registry, 'lsp_definition', 'Go to the definition of a symbol at the given file/line/column.', { input: { type: 'string', description: 'File path' }, line: { type: 'number', description: 'Line number (1-indexed)' }, column: { type: 'number', description: 'Column number (1-indexed)' } }, ['input', 'line', 'column'], ['lsp_query'], false, async args => {
      const locations = await lspManager.getDefinition(String(args.input), Number(args.line), Number(args.column));
      if (!locations.length) return 'No definition found.';
      return locations.map(l => `${l.uri}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join('\n');
    });
    reg(registry, 'lsp_references', 'Find all references of a symbol at the given file/line/column.', { input: { type: 'string', description: 'File path' }, line: { type: 'number', description: 'Line number (1-indexed)' }, column: { type: 'number', description: 'Column number (1-indexed)' } }, ['input', 'line', 'column'], ['lsp_query'], false, async args => {
      const locations = await lspManager.getReferences(String(args.input), Number(args.line), Number(args.column));
      if (!locations.length) return 'No references found.';
      return locations.map(l => `${l.uri}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join('\n');
    });
    reg(registry, 'lsp_diagnostics', 'Get language server diagnostics for a file.', { input: { type: 'string', description: 'File path' } }, ['input'], ['lsp_query'], false, async args => {
      const diagnostics = await lspManager.getDiagnostics(String(args.input));
      if (!diagnostics.length) return 'No diagnostics.';
      return diagnostics.map(d => `${d.severity === 1 ? 'ERROR' : d.severity === 2 ? 'WARNING' : 'INFO'} L${d.range.start.line + 1}: ${d.message}`).join('\n');
    });
  }

  return registry;
}
