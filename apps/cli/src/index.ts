import { Command } from 'commander';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createProvider } from '@code-agent/llm';
import { ToolRegistry, PermissionEngine, ExecutionController } from '@code-agent/engine';
import { ToolKit } from '@code-agent/tools';
import { StorageManager, RepositoryIndexer } from '@code-agent/codex';
import { AgentExecutor } from './engine/executor.js';
import { Repl } from './repl.js';
import type { Message } from '@code-agent/types';
import glob from 'fast-glob';
import * as readline from 'readline';

/** 入口：加载 .env 环境变量 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = resolve(__dirname, '../../../.env');
// dotenv v17+ 会打印注入信息，先静默
{ const _c = console.log; console.log = () => {}; dotenv.config({ path: envPath }); console.log = _c; }

/** 项目根目录 — 所有文件操作的锚点 */
const PROJECT_ROOT = resolve(__dirname, '../../..');

const program = new Command();
const dbManager = new StorageManager();
const indexer = new RepositoryIndexer(dbManager);
const toolkit = new ToolKit(PROJECT_ROOT);

/** 构建 ToolRegistry 并注册全部核心工具 */
function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: 'search_symbol',
    description: 'Search for symbols (functions, classes, interfaces) by name across the codebase.',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string', description: 'Symbol name to search for' } },
      required: ['input'],
      additionalProperties: false,
    },
    requiresApproval: false,
    capabilities: ['search_symbol'],
    handler: async (args: Record<string, unknown>) => {
      const symbols = dbManager.searchSymbol(String(args.input));
      if (symbols.length === 0) return `No symbols found matching "${String(args.input)}"`;
      return JSON.stringify(symbols, null, 2);
    },
  });

  registry.register({
    name: 'read_file',
    description: 'Read the contents of a file at the given relative path.',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string', description: 'Relative path to the file' } },
      required: ['input'],
      additionalProperties: false,
    },
    requiresApproval: false,
    capabilities: ['read_code'],
    handler: async (args: Record<string, unknown>) => toolkit.readFile(String(args.input)),
  });

  registry.register({
    name: 'list_files',
    description: 'List files and directories in the project root.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    requiresApproval: false,
    capabilities: ['read_code'],
    handler: async (): Promise<string> => {
      const files = await toolkit.listFiles();
      return files.join('\n');
    },
  });

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
      return `${result.preview}\n\n请运行编译命令验证此修改。`;
    },
  });

  registry.register({
    name: 'execute_command',
    description: 'Execute a terminal command and return stdout/stderr/exit code.',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string', description: 'The command to execute' } },
      required: ['input'],
      additionalProperties: false,
    },
    requiresApproval: true,
    capabilities: ['execute_command'],
    handler: async (args: Record<string, unknown>) => {
      const result = await toolkit.terminal.executeCommand(String(args.input));
      return `[Exit Code]: ${result.code}\n[Stdout]:\n${result.stdout}\n[Stderr]:\n${result.stderr}`;
    },
  });

  registry.register({
    name: 'git_status',
    description: 'Show the current git working tree status.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    requiresApproval: false,
    capabilities: ['git_operation'],
    handler: async (): Promise<string> => toolkit.git.getStatus(),
  });

  registry.register({
    name: 'git_diff',
    description: 'Show the current git diff (unstaged changes).',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    requiresApproval: false,
    capabilities: ['git_operation'],
    handler: async (): Promise<string> => toolkit.git.getDiff(),
  });

  registry.register({
    name: 'git_commit',
    description: 'Stage all changes and create a git commit with the given message.',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string', description: 'Commit message' } },
      required: ['input'],
      additionalProperties: false,
    },
    requiresApproval: true,
    capabilities: ['git_operation'],
    handler: async (args: Record<string, unknown>) => toolkit.git.commitAll(String(args.input)),
  });

  return registry;
}

/** 扫描工作区 TypeScript 文件并构建 tree-sitter AST 符号索引 */
async function scanWorkspace() {
  const files = glob.globSync(['apps/**/*.ts', 'packages/**/*.ts'], {
    cwd: PROJECT_ROOT,
    ignore: ['**/dist/**', '**/node_modules/**'],
  });
  for (const file of files) {
    await indexer.indexFile(resolve(PROJECT_ROOT, file));
  }
}

/** 扫描全部项目文件（供 @file 模糊匹配） */
function scanAllFiles(): string[] {
  return glob.globSync(['**/*'], {
    cwd: PROJECT_ROOT,
    ignore: [
      '**/node_modules/**', '**/dist/**', '**/.git/**',
      '**/*.db', '**/*.db-*', '**/*.lock', '**/*.log',
      '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.ico', '**/*.svg',
      '**/*.woff', '**/*.woff2', '**/*.ttf', '**/*.eot',
      '**/*.map', '**/*.min.js', '**/*.min.css',
    ],
    dot: false,
  });
}

/** 工具中文名 */
const TOOL_LABELS: Record<string, string> = {
  search_symbol: '搜索符号',
  read_file: '读取文件',
  list_files: '列出目录',
  modify_file: '修改文件',
  execute_command: '执行命令',
  git_status: 'Git 状态',
  git_diff: 'Git 差异',
  git_commit: 'Git 提交',
};

function toolLabel(name: string): string { return TOOL_LABELS[name] ?? name; }

/** 创建审批回调 */
function createApprovalHandler(rl: readline.Interface) {
  return async (toolName: string, args: Record<string, unknown>) => {
    const label = toolLabel(toolName);
    const path = args.path ? `\n   文件: ${args.path}` : '';
    const cmd = args.input ? `\n   命令: ${String(args.input).slice(0, 120)}` : '';

    process.stdout.write(`\n\x1b[93m⚠ 需要确认:\x1b[0m \x1b[96m${label}\x1b[0m${path}${cmd}\n`);

    return new Promise<boolean>(resolve => {
      rl.question('  \x1b[2m允许执行? [y/N]\x1b[0m ', answer => {
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  };
}

/** 创建 Executor 实例 */
function createExecutor(
  providerName?: string,
  modelName?: string,
  rl?: readline.Interface,
) {
  const provider = createProvider(providerName ?? 'deepseek', { modelName });
  const registry = buildRegistry();
  const permissionEngine = new PermissionEngine();
  const controller = new ExecutionController({ maxBudgetUsd: 5.0, deadLoopThreshold: 4 });
  const approvalHandler = rl ? createApprovalHandler(rl) : undefined;

  return new AgentExecutor({
    provider,
    registry,
    permissionEngine,
    controller,
    approvalHandler,
  });
}

// ══════════════════════════════════════════════════════════
// CLI 定义
// ══════════════════════════════════════════════════════════
program
  .name('code-agent')
  .description('企业级开源 Code Agent v3.0 — 启动进入交互式 REPL')
  .option('-p, --prompt <text>', '单次执行模式，直接完成任务后退出')
  .option('--plan', 'Plan 模式：只读探索，生成执行计划（需配合 -p 使用）')
  .option('--provider <name>', '模型提供商 (deepseek, openai, anthropic, google, openrouter, ollama)', 'deepseek')
  .option('--model <name>', '指定模型名称（覆盖默认值）');

// 默认行为：无子命令时进入 REPL（或 -p 单次执行）
program.action(async () => {
  const opts = program.opts();
  await scanWorkspace();
  if (!opts.prompt) console.log('✅ Ready.');

  if (opts.prompt) {
    // ── 单次执行模式 ──
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const executor = createExecutor(opts.provider, opts.model, rl);

    const history: Message[] = [
      { role: 'system', content: executor.getSystemPrompt() },
    ];

    if (opts.plan) {
      history.push({
        role: 'user',
        content: `请为以下任务制定执行计划。只读探索代码库，不要修改任何文件。\n\n任务: ${opts.prompt}\n\n完成后输出执行计划并用 <task_finish> 结束。`,
      });
      console.log(`\n📋 Plan Mode [${executor.providerName}]`);
    } else {
      history.push({ role: 'user', content: opts.prompt });
      console.log(`\n🚀 Code Agent v3.0 [${executor.providerName}]`);
    }

    console.log(`   任务: "${opts.prompt}"`);

    try {
      const updated = await executor.runTask(history, { readonly: opts.plan ?? false });
      const lastAssistant = [...updated].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) {
        console.log(`\n📋 最终结果:\n${lastAssistant.content}`);
      }
    } catch (err) {
      console.log(`\n❌ 执行异常: ${(err as Error).message}`);
    }

    rl.close();
    return;
  }

  // ── REPL 模式 ──
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const executor = createExecutor(opts.provider, opts.model, rl);
  const projectFiles = scanAllFiles();
  const repl = new Repl({ executor, files: projectFiles, projectRoot: PROJECT_ROOT, rl });

  await repl.start();
  rl.close();
});

// ══════════════════════════════════════════════════════════
// 子命令: mcp-server
// ══════════════════════════════════════════════════════════
program
  .command('mcp-server')
  .description('启动 MCP Server (stdio JSON-RPC)，供 Claude Desktop/Cursor 等外部客户端连接')
  .action(async () => {
    const { McpServer } = await import('@code-agent/engine');
    console.error('[MCP Server] 启动 stdio JSON-RPC 2.0 服务...');
    const registry = buildRegistry();
    const server = new McpServer(registry, 'code-agent', '3.0.0');
    await server.start();
  });

program.parse();
