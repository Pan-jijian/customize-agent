import { Command } from 'commander';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createProvider } from '@customize-agent/llm';
import { ToolRegistry, PermissionEngine, ExecutionController } from '@customize-agent/engine';
import { ToolKit } from '@customize-agent/tools';
import { StorageManager, RepositoryIndexer, TreeSitterWorkerPool, LSPManager } from '@customize-agent/codex';
import { MemoryManager } from '@customize-agent/memory';
import { AgentExecutor, TOOL_CN } from './agent/executor.js';
import { Repl } from './repl/repl.js';
import { approvalBox, t } from './tui/renderer.js';
import { type Message, BINARY_EXTENSIONS } from '@customize-agent/types';
import * as readline from 'readline';
import glob from 'fast-glob';

/** 入口：加载 .env 环境变量 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = resolve(__dirname, '../../../.env');
// dotenv v17+ 会打印注入信息，静默处理
{ const _c = console.log; try { console.log = () => {}; dotenv.config({ path: envPath }); } finally { console.log = _c; } }

/** 项目根目录 — 所有文件操作的锚点 */
const PROJECT_ROOT = resolve(__dirname, '../../..');

const program = new Command();
const dbManager = new StorageManager();
const workerPool = new TreeSitterWorkerPool();
const indexer = new RepositoryIndexer(dbManager, { workerPool });
const toolkit = new ToolKit(PROJECT_ROOT);

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
      if (symbols.length === 0) return `No symbols found matching "${input}".\n\nsearch_symbol 只搜索代码符号（函数/类/接口/变量），不能搜索文件名或路径。搜索文件请用 list_files，查看文件内容请用 read_file。`;
      return JSON.stringify(symbols.slice(0, 20), null, 2);
    });

  registry.register({
    name: 'read_file',
    description: 'Read a text file. Supports offset/limit for large files. For binary files (PDF, images, docx, etc.), use execute_command with external tools (pdftotext, python, etc.).',
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
      // 路径归一化：去尾部 /，防止扩展名检查绕过
      const filePath = String(args.input).replace(/\/+$/, '');
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      if (BINARY_EXTENSIONS.has(ext)) {
        return `[二进制文件] ${filePath} 是 ${ext} 格式，read_file 不支持。请用 execute_command 调用外部工具处理。`;
      }

      const content = await toolkit.readFile(filePath);

      // 扩展名不明确时，检查内容是否为二进制（含大量不可打印字符或 NUL 字节）
      if (!BINARY_EXTENSIONS.has(ext)) {
        const head = content.slice(0, 1024);
        const nulCount = head.split('\x00').length - 1;
        const nonPrintable = head.replace(/[\x20-\x7e\n\r\t]/g, '').length;
        if (nulCount > 0 || nonPrintable > head.length * 0.3) {
          return `[二进制文件] ${filePath} 被检测为二进制内容（NUL=${nulCount}, 不可打印比例=${(nonPrintable / head.length * 100).toFixed(0)}%），请用 execute_command 调用外部工具处理。`;
        }
      }
      const offset = typeof args.offset === 'number' ? args.offset : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;

      // 大文件无分页 → 自动截断 + 引导
      if ((offset === undefined && limit === undefined) && content.length > 100_000) {
        const preview = content.slice(0, 5000);
        const totalLines = content.split('\n').length;
        return `${preview}\n\n...[文件过大，已截断。完整文件共 ${(content.length / 1024).toFixed(1)} KB, ${totalLines} 行。请用 offset/limit 分段读取。]`;
      }

      if (offset === undefined && limit === undefined) return content;
      const lines = content.split('\n');
      const start = Math.max(0, (offset ?? 1) - 1);
      const end = limit ? start + limit : undefined;
      const slice = lines.slice(start, end);
      return `[lines ${start + 1}-${end ?? lines.length} of ${lines.length}]\n${slice.join('\n')}`;
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
      return `${result.preview}\n\n请运行编译命令验证此修改。`;
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
      if (!result.stdout && !result.stderr && result.code !== 0) {
        parts.push(`[诊断] 命令无任何输出且退出码非零。可能原因: 1) 命令不存在 2) 缺少依赖 3) 权限不足。请检查 stderr 或尝试其他方式。`);
      }
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
      return `文件已创建: ${filePath} (${content.length} 字符)`;
    },
  });

  registry.register({
    name: 'web_search',
    description: 'Search the web and return results with titles and URLs. Use for finding documentation, troubleshooting errors, or researching libraries.',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string', description: 'Search query' } },
      required: ['input'],
      additionalProperties: false,
    },
    requiresApproval: false,
    capabilities: ['search_symbol'], // 复用只读 capability
    handler: async (args: Record<string, unknown>) => {
      const query = String(args.input);
      const { execSync } = await import('child_process');
      try {
        const html = execSync(
          `curl -sL --max-time 10 "https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}"`,
          { encoding: 'utf-8', timeout: 12000, maxBuffer: 512 * 1024 },
        );
        // 解析 DuckDuckGo Lite 结果
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
        if (!results.length) {
          return `[web_search] "${query}" 无结果。请尝试更具体的关键词，或用英文搜索（如 "${query.replace(/[一-鿿]/g, '')}" 部分）。`;
        }
        return `Web search results for query: "${query}"\n\n${results.join('\n')}\n\nSources: 以上链接`;
      } catch (err) {
        return `[web_search] "${query}" 搜索失败: ${(err as Error).message}。请检查网络连接。`;
      }
    },
  });

  // LSP 工具 — 仅在 LSPManager 可用时注册
  if (lspManager) {
    reg(registry, 'lsp_definition', 'Go to the definition of a symbol at the given file/line/column.',
      {
        input: { type: 'string', description: 'Relative file path' },
        line: { type: 'number', description: '1-indexed line number' },
        column: { type: 'number', description: '1-indexed column number' },
      },
      ['input', 'line', 'column'], ['lsp_query'], false,
      async (args) => {
        const locations = await lspManager.getDefinition(String(args.input), Number(args.line), Number(args.column));
        if (!locations.length) return '未找到定义。';
        return locations.map(l => `${l.uri}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join('\n');
      });

    reg(registry, 'lsp_references', 'Find all references of a symbol at the given file/line/column.',
      {
        input: { type: 'string', description: 'Relative file path' },
        line: { type: 'number', description: '1-indexed line number' },
        column: { type: 'number', description: '1-indexed column number' },
      },
      ['input', 'line', 'column'], ['lsp_query'], false,
      async (args) => {
        const locations = await lspManager.getReferences(String(args.input), Number(args.line), Number(args.column));
        if (!locations.length) return '未找到引用。';
        return locations.map(l => `${l.uri}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join('\n');
      });

    reg(registry, 'lsp_diagnostics', 'Get language server diagnostics (errors/warnings/hints) for a file.',
      { input: { type: 'string', description: 'Relative file path' } },
      ['input'], ['lsp_query'], false,
      async (args) => {
        const diagnostics = await lspManager.getDiagnostics(String(args.input));
        if (!diagnostics.length) return '该文件无诊断问题。';
        return diagnostics.map(d =>
          `${d.severity === 1 ? 'ERROR' : d.severity === 2 ? 'WARNING' : 'INFO'} L${d.range.start.line + 1}: ${d.message}`
        ).join('\n');
      });
  }

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
  // 从共享常量推导需要忽略的二进制/构建产物扩展名
  const binaryIgnores = Array.from(BINARY_EXTENSIONS).map(ext => `**/*.${ext}`);
  return glob.globSync(['**/*'], {
    cwd: PROJECT_ROOT,
    ignore: [
      '**/node_modules/**', '**/dist/**', '**/.git/**',
      '**/*.db', '**/*.db-*', '**/*.lock', '**/*.log',
      ...binaryIgnores,
    ],
    dot: false,
  });
}

/** 创建审批回调 */
function createApprovalHandler(rl: readline.Interface) {
  return async (toolName: string, args: Record<string, unknown>) => {
    const label = TOOL_CN[toolName] ?? toolName;
    const detail = args.path
      ? `File: ${args.path}`
      : args.input
        ? `Command: ${String(args.input).slice(0, 120)}`
        : undefined;

    process.stdout.write(approvalBox(toolName, label, detail));
    process.stdout.write('\n');

    return new Promise<boolean>(resolve => {
      rl.question(`  ${t.dim('Allow execution? [y/N]')} `, answer => {
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });
  };
}

/** 创建 Executor 实例 */
function createExecutor(providerName?: string, modelName?: string, rl?: readline.Interface, lspManager?: LSPManager) {
  const provider = createProvider(providerName ?? 'deepseek', { modelName });
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
  });
}

// CLI 定义
program
  .name('customize-agent')
  .description('企业级开源 Customize Agent v3.0 — 启动进入交互式 REPL')
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
    const executor = createExecutor(opts.provider, opts.model);

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
      console.log(`\n🚀 Customize Agent v3.0 [${executor.providerName}]`);
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

    return;
  }

  // ── REPL 模式 ──
  // terminal: false 阻止 Interface 在 raw mode 下回显/处理 keypress，避免与 TuiInput 冲突
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lsp = new LSPManager(PROJECT_ROOT);
  const executor = createExecutor(opts.provider, opts.model, rl, lsp);
  const projectFiles = scanAllFiles();
  const memory = new MemoryManager();
  const repl = new Repl({ executor, files: projectFiles, projectRoot: PROJECT_ROOT, memory });

  await repl.start();
  rl.close();
});

// 子命令: mcp-server
program
  .command('mcp-server')
  .description('启动 MCP Server (stdio JSON-RPC)，供 Claude Desktop/Cursor 等外部客户端连接')
  .action(async () => {
    const { McpServer } = await import('@customize-agent/engine');
    console.error('[MCP Server] 启动 stdio JSON-RPC 2.0 服务...');
    const registry = buildRegistry();
    const server = new McpServer(registry, 'customize-agent', '3.0.0');
    await server.start();
  });

program.parse();
