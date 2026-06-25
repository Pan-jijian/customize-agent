import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createProvider } from '@customize-agent/llm';
import { ToolRegistry, PermissionEngine, ExecutionController } from '@customize-agent/engine';
import { ToolKit } from '@customize-agent/tools';
import { StorageManager, RepositoryIndexer, TreeSitterWorkerPool, LSPManager } from '@customize-agent/codex';
import { MemoryManager } from '@customize-agent/memory';
import { ConfigStore, ModelRegistry } from '@customize-agent/runtime';
import { AgentExecutor } from './agent/executor.js';
import { Repl } from './repl/repl.js';
import { approvalBox, t } from './tui/renderer.js';
import { type Message, BINARY_EXTENSIONS } from '@customize-agent/types';
import { I18nManager } from './i18n/manager.js';
import * as readline from 'readline';
import glob from 'fast-glob';

/** 项目根目录 */
const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), '../../..');

const program = new Command();
const configStore = new ConfigStore();
const dbManager = new StorageManager();
const workerPool = new TreeSitterWorkerPool();
const indexer = new RepositoryIndexer(dbManager, { workerPool });
const toolkit = new ToolKit(PROJECT_ROOT);

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

  reg(registry, 'search_symbol', 'Search for symbols (functions, classes, interfaces) by name across the codebase.',
    { input: { type: 'string', description: 'Symbol name to search for' } },
    ['input'], ['search_symbol'], false,
    async (args) => {
      const input = String(args.input);
      const symbols = dbManager.searchSymbol(input);
      if (symbols.length === 0) return `No symbols found matching "${input}".`;
      return JSON.stringify(symbols.slice(0, 20), null, 2);
    });

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

  registry.register({
    name: 'modify_file',
    description: 'Modify a file using SEARCH/REPLACE diff blocks.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to modify' },
        input: { type: 'string', description: 'Diff content in SEARCH/REPLACE format' },
      },
      required: ['path', 'input'],
      additionalProperties: false,
    },
    requiresApproval: true,
    capabilities: ['write_code'],
    handler: async (args: Record<string, unknown>) => {
      const result = await toolkit.modifyFileWithDiff(String(args.path), String(args.input));
      return `${result.preview}\n\nPlease run the build command to validate this change.`;
    },
  });

  reg(registry, 'execute_command', 'Execute a terminal command and return stdout/stderr/exit code.',
    { input: { type: 'string', description: 'The command to execute' } },
    ['input'], ['execute_command'], true,
    async (args) => {
      const result = await toolkit.terminal.executeCommand(String(args.input));
      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout.trimEnd());
      if (result.stderr) parts.push(`[Stderr]\n${result.stderr.trimEnd()}`);
      if (result.code !== 0) parts.push(`[Exit ${result.code}]`);
      return parts.join('\n') || `[Exit ${result.code}]`;
    });

  reg(registry, 'git_status', 'Show the current git working tree status.',
    {}, [], ['git_operation'], false,
    async () => toolkit.git.getStatus());

  reg(registry, 'git_diff', 'Show the current git diff (unstaged changes).',
    {}, [], ['git_operation'], false,
    async () => toolkit.git.getDiff());

  reg(registry, 'git_commit', 'Stage all changes and create a git commit with the given message.',
    { input: { type: 'string', description: 'Commit message' } },
    ['input'], ['git_operation'], true,
    async (args) => toolkit.git.commitAll(String(args.input)));

  registry.register({
    name: 'write_file',
    description: 'Create a new file or overwrite an existing file with the given content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to create/overwrite' },
        input: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'input'],
      additionalProperties: false,
    },
    requiresApproval: true,
    capabilities: ['write_code'],
    handler: async (args: Record<string, unknown>) => {
      const filePath = String(args.path);
      const content = String(args.input);
      await toolkit.writeFileWithBackup(filePath, content);
      return `File created: ${filePath} (${content.length} chars)`;
    },
  });

  registry.register({
    name: 'web_search',
    description: 'Search the web and return results with titles and URLs.',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string', description: 'Search query' } },
      required: ['input'],
      additionalProperties: false,
    },
    requiresApproval: false,
    capabilities: ['search_symbol'],
    handler: async (args: Record<string, unknown>) => {
      const query = String(args.input);
      const { execSync } = await import('child_process');
      try {
        const html = execSync(
          `curl -sL --max-time 10 "https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}"`,
          { encoding: 'utf-8', timeout: 12000, maxBuffer: 512 * 1024 },
        );
        const results: string[] = [];
        const linkRe = /<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
        let m;
        while ((m = linkRe.exec(html)) !== null) {
          let url = m[1]!;
          const title = m[2]!.replace(/<[^>]*>/g, '').trim();
          if (!title || url.includes('duckduckgo.com') || url.startsWith('//')) continue;
          if (url.startsWith('/l/?uddg=')) {
            url = decodeURIComponent(url.slice('/l/?uddg='.length));
          }
          results.push(`- [${title}](${url})`);
          if (results.length >= 8) break;
        }
        return results.length ? `Web search results for: "${query}"\n\n${results.join('\n')}` : `[web_search] No results for "${query}".`;
      } catch (err) {
        return `[web_search] Search failed: ${(err as Error).message}`;
      }
    },
  });

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

async function scanWorkspace() {
  const files = glob.globSync(['apps/**/*.ts', 'packages/**/*.ts'], {
    cwd: PROJECT_ROOT,
    ignore: ['**/dist/**', '**/node_modules/**'],
  });
  for (const file of files) {
    await indexer.indexFile(resolve(PROJECT_ROOT, file));
  }
}

function scanAllFiles(): string[] {
  const binaryIgnores = Array.from(BINARY_EXTENSIONS).map(ext => `**/*.${ext}`);
  return glob.globSync(['**/*'], {
    cwd: PROJECT_ROOT,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/*.db', '**/*.db-*', '**/*.lock', '**/*.log', ...binaryIgnores],
    dot: false,
  });
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
function createExecutor(providerName?: string, modelName?: string, apiKey?: string, rl?: readline.Interface, lspManager?: LSPManager) {
  const provider = createProvider(providerName ?? 'deepseek', { modelName, apiKey });
  const registry = buildRegistry(lspManager);
  const permissionEngine = new PermissionEngine();
  const controller = new ExecutionController({ maxBudgetUsd: 5.0, deadLoopThreshold: 4 });
  const approvalHandler = rl ? createApprovalHandler(rl) : undefined;

  return new AgentExecutor({
    provider,
    registry,
    permissionEngine,
    controller,
    approvalHandler,
    i18n,
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

  await scanWorkspace();

  // ── 单次执行模式 ──
  if (opts.prompt) {
    const resolved = modelRegistry.resolve('action');
    if (!resolved) {
      console.log(`\n${i18n.t('cmd.no_model_configured')}`);
      console.log(i18n.t('cmd.first_config'));
      return;
    }
    const executor = createExecutor(resolved.provider, resolved.name, resolved.apiKey);

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
  const resolved = modelRegistry.resolve('action'); // action 层或回退
  const executor = resolved
    ? createExecutor(resolved.provider, resolved.name, resolved.apiKey, rl, lsp)
    : createExecutor('deepseek', undefined, undefined, rl, lsp); // 无配置时兜底

  const projectFiles = scanAllFiles();
  const memory = new MemoryManager();

  const repl = new Repl({
    executor,
    files: projectFiles,
    projectRoot: PROJECT_ROOT,
    memory,
    i18n,
    configStore,
    modelRegistry,
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
