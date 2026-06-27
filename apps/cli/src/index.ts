import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { readdirSync, statSync } from 'fs';
import { createProvider } from '@customize-agent/llm';
import { ToolRegistry, PermissionEngine, ExecutionController } from '@customize-agent/engine';
import { ToolKit, SandboxExecutor } from '@customize-agent/tools';
import { LSPManager, CodeSearcher } from '@customize-agent/search';
import { MemoryManager } from '@customize-agent/memory';
import { ConfigStore, ModelRegistry } from '@customize-agent/runtime';
import { AgentExecutor } from './agent/executor.js';
import { Repl } from './repl/repl.js';
import { approvalBox, t } from './tui/renderer.js';
import { type Message, BINARY_EXTENSIONS } from '@customize-agent/types';
import { I18nManager } from './i18n/manager.js';
import * as readline from 'readline';

/** 项目根目录 */
const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), '../../..');

const program = new Command();
const configStore = new ConfigStore();
const toolkit = new ToolKit(PROJECT_ROOT);


// Repository Map — 启动时生成项目结构树
function _generateRepoMap(): string {
  const ignore = new Set(['node_modules', 'dist', '.git', '.DS_Store', '__pycache__', 'target']);
  const lines: string[] = []; let count = 0; const max = 200;
  function walk(dir: string, prefix: string): void {
    if (count >= max) return;
    let entries: string[];
    try { entries = readdirSync(dir).filter(e => !e.startsWith('.') && !ignore.has(e)).sort(); } catch { return; }
    for (let i = 0; i < entries.length && count < max; i++) {
      const e = entries[i]!; const full = join(dir, e);
      try {
        if (statSync(full).isDirectory()) { lines.push(`${prefix}${i===entries.length-1?'└── ':'├── '}${e}/`); count++; walk(full, prefix+(i===entries.length-1?'    ':'│   ')); }
      } catch { /* skip */ }
    }
  }
  const top = readdirSync(PROJECT_ROOT).filter(e => !e.startsWith('.') && !ignore.has(e)).sort();
  for (const e of top) {
    if (count >= max) break;
    try {
      const full = join(PROJECT_ROOT, e);
      if (statSync(full).isDirectory()) { lines.push(`${e}/`); count++; walk(full, '    '); }
      else { lines.push(e); count++; }
    } catch { /* skip */ }
  }
  return lines.join('\n');
}
let _repoMap: string | null = null;

// ── 国际化 ──
let i18n: I18nManager;

/** 简化的工具注册辅助：自动补全 parameters.type='object' + additionalProperties=false */
function reg(
  r: ToolRegistry,
  name: string,
  desc: string,
  props: Record<string, { type: string; description: string }>,
  required: string[],
  caps: string[],
  needsApproval: boolean,
  handler: (args: Record<string, unknown>) => Promise<string>,
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

/** 构建 ToolRegistry 并注册全部核心工具。传入 lspManager 时额外注册 LSP 工具 */
function buildRegistry(lspManager?: LSPManager): ToolRegistry {
  const registry = new ToolRegistry();


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
        const nonPrintable = head.replace(/[\x20-\x7e\n\r\t]/g, '').length;
        if (nulCount > 0 || nonPrintable > head.length * 0.3) {
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

  reg(registry, 'list_files', 'List files and directories in the project root.',
    {}, [], ['read_code'], false,
    async () => (await toolkit.listFiles()).join('\n'));

  reg(registry, 'search', 'Fast text search across all files using ripgrep. Use for finding any text, patterns, documentation, config values, or code references.',
    { pattern: { type: 'string', description: 'Text or regex pattern to search for' } },
    ['pattern'], ['read_code'], false,
    async (args) => {
      const searcher = new CodeSearcher(PROJECT_ROOT);
      const matches = await searcher.grep(String(args.pattern), { maxResults: 20 });
      return matches.length > 0
        ? matches.map(m => `${m.file}:${m.line}: ${m.content}`).join('\n')
        : `No matches found for "${args.pattern}".`;
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
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The command or code to execute.' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    requiresApproval: true,
    capabilities: ['execute_command'],
    handler: async (args: Record<string, unknown>) => {
      const cmd = String(args.input);
      const isCode = cmd.startsWith('python3 -c') || cmd.startsWith('python -c') || cmd.startsWith('node -e');
      const executor = isCode ? new SandboxExecutor('docker', PROJECT_ROOT) : null;
      const result = executor
        ? await executor.execute(cmd)
        : await toolkit.terminal.executeCommand(cmd);
      const out: string[] = [];
      if (result.stdout) out.push(result.stdout.trimEnd());
      if (result.stderr) out.push(`[Stderr]\n${result.stderr.trimEnd()}`);
      if (result.code !== 0) out.push(`[Exit ${result.code}]`);
      return out.join('\n') || `[Exit ${result.code}]`;
    },
  });

  reg(registry, 'git_commit', 'Stage all changes and create a git commit with the given message.',
    { input: { type: 'string', description: 'Commit message' } },
    ['input'], ['git_operation'], true,
    async (args) => toolkit.git.commitAll(String(args.input)));






  if (lspManager) {
    reg(registry, 'lsp_definition', 'Go to the definition of a symbol at the given file/line/column.',
      { input: { type: 'string', description: 'File path' }, line: { type: 'number', description: 'Line number (1-indexed)' }, column: { type: 'number', description: 'Column number (1-indexed)' } },
      ['input', 'line', 'column'], ['lsp_query'], false,
      async (args) => {
        const locations = await lspManager.getDefinition(String(args.input), Number(args.line), Number(args.column));
        if (!locations.length) return 'No definition found.';
        return locations.map(l => `${l.uri}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join('\n');
      });

    reg(registry, 'lsp_references', 'Find all references of a symbol at the given file/line/column.',
      { input: { type: 'string', description: 'File path' }, line: { type: 'number', description: 'Line number (1-indexed)' }, column: { type: 'number', description: 'Column number (1-indexed)' } },
      ['input', 'line', 'column'], ['lsp_query'], false,
      async (args) => {
        const locations = await lspManager.getReferences(String(args.input), Number(args.line), Number(args.column));
        if (!locations.length) return 'No references found.';
        return locations.map(l => `${l.uri}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join('\n');
      });

    reg(registry, 'lsp_diagnostics', 'Get language server diagnostics for a file.',
      { input: { type: 'string', description: 'File path' } },
      ['input'], ['lsp_query'], false,
      async (args) => {
        const diagnostics = await lspManager.getDiagnostics(String(args.input));
        if (!diagnostics.length) return 'No diagnostics.';
        return diagnostics.map(d => `${d.severity === 1 ? 'ERROR' : d.severity === 2 ? 'WARNING' : 'INFO'} L${d.range.start.line + 1}: ${d.message}`).join('\n');
      });
  }

  return registry;
}

/** 创建审批回调（使用 i18n） */
function createApprovalHandler(rl: readline.Interface) {
  return async (toolName: string, args: Record<string, unknown>) => {
    const label = i18n.toolLabel(toolName);
    const detail = args.path
      ? i18n.t('approval.file_detail', { path: String(args.path) })
      : args.input
        ? i18n.t('approval.command_detail', { cmd: String(args.input).slice(0, 120) })
        : undefined;

    process.stdout.write(approvalBox(toolName, label, detail, {
      title: i18n.t('approval.box_title'),
      prompt: '[y/N]',
    }));
    process.stdout.write('\n');

    return new Promise<boolean>(resolve => {
      rl.question(`  ${t.dim(i18n.t('approval.allow'))} `, answer => {
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  };
}

/** 创建 Executor 实例（懒加载：provider 无 API key 也能进入 REPL） */
function createExecutor(providerName?: string, modelName?: string, apiKey?: string, baseUrl?: string, rl?: readline.Interface, lspManager?: LSPManager) {
  const provider = createProvider(providerName ?? 'deepseek', { modelName, apiKey, baseUrl });
  const registry = buildRegistry(lspManager);
  const permissionEngine = new PermissionEngine();
  const controller = new ExecutionController({ maxBudgetUsd: 5.0, deadLoopThreshold: 4 });
  const approvalHandler = rl ? createApprovalHandler(rl) : undefined;

  if (_repoMap === null) _repoMap = _generateRepoMap();
  return new AgentExecutor({
    provider,
    registry,
    permissionEngine,
    controller,
    approvalHandler,
    i18n,
    projectRoot: PROJECT_ROOT,
    repoMap: _repoMap,
  });
}

// ── CLI 定义 ──
program
  .name('customize-agent')
  .description('Customize Agent v0.0.3 — interactive REPL')
  .option('-p, --prompt <text>', 'Single-shot execution mode')
  .option('--plan', 'Plan mode: read-only exploration (requires -p)');

program.action(async () => {
  const opts = program.opts();
  const modelRegistry = new ModelRegistry(configStore);
  const config = configStore.load();

  i18n = new I18nManager(config.language);

  // ── 单次执行模式 ──
  if (opts.prompt) {
    const resolved = modelRegistry.resolve('action');
    if (!resolved) {
      console.log(`\n${i18n.t('cmd.no_model_configured')}`);
      console.log(i18n.t('cmd.first_config'));
      return;
    }
    const pCfg = configStore.getProvider(resolved.provider);
    const executor = createExecutor(resolved.provider, resolved.name, pCfg?.apiKey, pCfg?.baseUrl);

    const history: Message[] = [
      { role: 'system', content: executor.getSystemPrompt() },
    ];

    if (opts.plan) {
      history.push({
        role: 'user',
        content: `Create an execution plan for the following task. Read-only exploration. Do not modify any files.\n\nTask: ${opts.prompt}\n\nOutput the plan and end with <task_finish>.`,
      });
      console.log(`\n📋 ${i18n.t('plan.banner')} [${executor.providerName}]`);
    } else {
      history.push({ role: 'user', content: opts.prompt });
      console.log(`\n🚀 Customize Agent v0.0.3 [${executor.providerName}]`);
    }
    console.log(`   Task: "${opts.prompt}"`);

    try {
      const updated = await executor.runTask(history, { readonly: opts.plan ?? false });
      const lastAssistant = [...updated].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) {
        console.log(`\n📋 Result:\n${lastAssistant.content}`);
      }
    } catch (err) {
      console.log(`\n${i18n.t('error.execution')} ${(err as Error).message}`);
    }
    return;
  }

  // ── REPL 模式 ──
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lsp = new LSPManager(PROJECT_ROOT);

  // 为 REPL 创建 executor — 用回退链解析模型
  const resolved = modelRegistry.resolve('action');
  const providerDisplay = resolved
    ? `${resolved.provider}/${resolved.name}`
    : i18n.t('welcome.no_model');
  const providerCfg = resolved ? configStore.getProvider(resolved.provider) : undefined;
  const executor = resolved
    ? createExecutor(resolved.provider, resolved.name, providerCfg?.apiKey, providerCfg?.baseUrl, rl, lsp)
    : createExecutor(undefined, undefined, undefined, undefined, rl, lsp);

  const memory = new MemoryManager();

  const repl = new Repl({
    executor,
    projectRoot: PROJECT_ROOT,
    memory,
    i18n,
    configStore,
    modelRegistry,
    providerDisplay,
  });

  await repl.start();
  rl.close();
});

program
  .command('mcp-server')
  .description('Start MCP Server (stdio JSON-RPC)')
  .action(async () => {
    const i18nMcp = new I18nManager(configStore.load().language);
    const { McpServer } = await import('@customize-agent/engine');
    console.error(i18nMcp.t('cli.mcp_server_start'));
    const registry = buildRegistry();
    const server = new McpServer(registry, 'customize-agent', '0.0.3');
    await server.start();
  });

program.parse();
