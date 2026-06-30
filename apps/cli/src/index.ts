import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { readdirSync, statSync } from 'fs';
import { createProvider } from '@customize-agent/llm';
import { ToolRegistry, PermissionEngine, ExecutionController, type ToolExecutionContext } from '@customize-agent/engine';
import { ToolKit, SandboxExecutor, BuiltinTools } from '@customize-agent/tools';
import { LSPManager, CodeSearcher } from '@customize-agent/search';
import { MemoryManager } from '@customize-agent/memory';
import { ConfigStore, ModelRegistry } from '@customize-agent/runtime';
import { AgentExecutor } from './agent/executor.js';
import { Repl } from './repl/repl.js';
import { t, s, renderMarkdown } from './tui/renderer.js';
import { type Message, BINARY_EXTENSIONS } from '@customize-agent/types';
import { I18nManager } from './i18n/manager.js';
import * as readline from 'readline';

/** 项目根目录 */
const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), '../../..');

const program = new Command();
const configStore = new ConfigStore();
const toolkit = new ToolKit(PROJECT_ROOT);
const builtinTools = new BuiltinTools(PROJECT_ROOT);


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
    async (args, context) => {
      const searcher = new CodeSearcher(PROJECT_ROOT);
      const matches = await searcher.grep(String(args.pattern), { maxResults: 20, signal: context?.signal });
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
    handler: async (args: Record<string, unknown>, context?: ToolExecutionContext) => {
      const cmd = String(args.input);
      const isCode = cmd.startsWith('python3 -c') || cmd.startsWith('python -c') || cmd.startsWith('node -e');
      const executor = isCode ? new SandboxExecutor('docker', PROJECT_ROOT) : null;
      // approved: true — 该工具 requiresApproval=true，用户已在上层审批通过
      const result = executor
        ? await executor.execute(cmd, undefined, true, context?.signal)
        : await toolkit.terminal.executeCommand(cmd, true, context?.signal);

      const out: string[] = [];
      if (result.stdout) out.push(result.stdout.trimEnd());
      if (result.stderr) out.push(`[Stderr]\n${result.stderr.trimEnd()}`);
      if (!result.stdout && !result.stderr && result.code !== 0) out.push('(no output)');
      if (result.code !== 0) out.push(`[Exit ${result.code}]`);
      return out.join('\n') || `[Exit ${result.code}]`;
    },
  });

  reg(registry, 'git_commit', 'Stage all changes and create a git commit with the given message.',
    { input: { type: 'string', description: 'Commit message' } },
    ['input'], ['git_operation'], true,
    async (args) => toolkit.commitAll(String(args.input)));

  reg(registry, 'edit_file', 'Replace exact text in a file.', { path: { type: 'string', description: 'File path' }, search: { type: 'string', description: 'Text to replace' }, replace: { type: 'string', description: 'Replacement text' } }, ['path', 'search', 'replace'], ['write_code'], true, async args => builtinTools.editFile(String(args.path), String(args.search), String(args.replace)));
  reg(registry, 'multi_edit', 'Apply multiple exact replacements to a file.', { path: { type: 'string', description: 'File path' }, edits: { type: 'array', description: 'Array of {search, replace}' } }, ['path', 'edits'], ['write_code'], true, async args => builtinTools.multiEdit(String(args.path), args.edits as Array<{ search: string; replace: string }>));
  reg(registry, 'delete_file', 'Delete a file or directory.', { path: { type: 'string', description: 'Path to delete' } }, ['path'], ['write_code'], true, async args => builtinTools.deleteFile(String(args.path)));
  reg(registry, 'move_file', 'Move or rename a file or directory.', { from: { type: 'string', description: 'Source path' }, to: { type: 'string', description: 'Destination path' } }, ['from', 'to'], ['write_code'], true, async args => builtinTools.moveFile(String(args.from), String(args.to)));
  reg(registry, 'copy_file', 'Copy a file or directory.', { from: { type: 'string', description: 'Source path' }, to: { type: 'string', description: 'Destination path' } }, ['from', 'to'], ['write_code'], true, async args => builtinTools.copyFile(String(args.from), String(args.to)));
  reg(registry, 'mkdir', 'Create a directory recursively.', { path: { type: 'string', description: 'Directory path' } }, ['path'], ['write_code'], true, async args => builtinTools.mkdir(String(args.path)));
  reg(registry, 'stat_file', 'Return file metadata.', { path: { type: 'string', description: 'Path to inspect' } }, ['path'], ['read_code'], false, async args => builtinTools.statFile(String(args.path)));
  reg(registry, 'tree', 'Show a directory tree.', { path: { type: 'string', description: 'Directory path' }, depth: { type: 'number', description: 'Max depth' } }, [], ['read_code'], false, async args => builtinTools.tree(String(args.path ?? '.'), Number(args.depth ?? 3)));
  reg(registry, 'repo_map', 'Show a repository map.', {}, [], ['read_code'], false, async () => builtinTools.repoMap());
  reg(registry, 'symbol_search', 'Search symbols by name.', { query: { type: 'string', description: 'Symbol query' } }, ['query'], ['read_code'], false, async args => builtinTools.symbolSearch(String(args.query)));
  reg(registry, 'dependency_graph', 'Show dependency graph summary.', {}, [], ['read_code'], false, async () => builtinTools.dependencyGraph());
  reg(registry, 'detect_package_manager', 'Detect package manager.', {}, [], ['read_code'], false, async () => builtinTools.detectPackageManager());
  reg(registry, 'glob', 'Find files by simple name pattern.', { pattern: { type: 'string', description: 'Pattern or substring' } }, ['pattern'], ['read_code'], false, async args => builtinTools.glob(String(args.pattern)));
  reg(registry, 'web_search', 'Search the web. No approval required.', { query: { type: 'string', description: 'Search query' } }, ['query'], ['network'], false, async (args, context) => builtinTools.webSearch(String(args.query), context?.signal));
  reg(registry, 'web_fetch', 'Fetch URL content.', { url: { type: 'string', description: 'URL to fetch' } }, ['url'], ['network'], false, async (args, context) => builtinTools.webFetch(String(args.url), context?.signal));
  reg(registry, 'download_file', 'Download a URL to a local file.', { url: { type: 'string', description: 'URL' }, output: { type: 'string', description: 'Output path' } }, ['url', 'output'], ['network', 'write_code'], true, async (args, context) => builtinTools.downloadFile(String(args.url), String(args.output), context?.signal));
  reg(registry, 'export_markdown', 'Export markdown content to a file.', { output: { type: 'string', description: 'Output .md path' }, content: { type: 'string', description: 'Markdown content' } }, ['output', 'content'], ['write_code'], true, async args => builtinTools.exportMarkdown(String(args.output), String(args.content)));
  reg(registry, 'export_json', 'Export JSON data to a file.', { output: { type: 'string', description: 'Output .json path' }, data: { type: 'object', description: 'JSON data' } }, ['output', 'data'], ['write_code'], true, async args => builtinTools.exportJson(String(args.output), args.data));
  reg(registry, 'export_html', 'Export text content as HTML.', { output: { type: 'string', description: 'Output .html path' }, title: { type: 'string', description: 'Title' }, content: { type: 'string', description: 'Content' } }, ['output', 'content'], ['write_code'], true, async args => builtinTools.exportHtml(String(args.output), String(args.title ?? 'Export'), String(args.content)));
  reg(registry, 'export_pdf', 'Export text content as a simple PDF.', { output: { type: 'string', description: 'Output .pdf path' }, title: { type: 'string', description: 'Title' }, content: { type: 'string', description: 'Content' } }, ['output', 'content'], ['write_code'], true, async args => builtinTools.exportPdf(String(args.output), String(args.title ?? 'Export'), String(args.content)));
  reg(registry, 'export_session', 'Export session data as JSON.', { output: { type: 'string', description: 'Output path' }, data: { type: 'object', description: 'Session data' } }, ['output', 'data'], ['write_code'], true, async args => builtinTools.exportSession(String(args.output), args.data));
  reg(registry, 'zip_files', 'Create a tar archive from files.', { output: { type: 'string', description: 'Archive output' }, files: { type: 'array', description: 'Files to include' } }, ['output', 'files'], ['write_code'], true, async args => builtinTools.zipFiles(String(args.output), args.files as string[]));
  reg(registry, 'git_status', 'Run git status.', {}, [], ['git_operation'], false, async () => builtinTools.git(['status', '--short']));
  reg(registry, 'git_diff', 'Run git diff.', {}, [], ['git_operation'], false, async () => builtinTools.git(['diff']));
  reg(registry, 'git_log', 'Run git log.', {}, [], ['git_operation'], false, async () => builtinTools.git(['log', '--oneline', '-20']));
  reg(registry, 'git_stash', 'Run git stash push.', {}, [], ['git_operation'], true, async () => builtinTools.git(['stash', 'push']));
  reg(registry, 'git_apply_patch', 'Apply a patch file.', { path: { type: 'string', description: 'Patch path' } }, ['path'], ['git_operation', 'write_code'], true, async args => builtinTools.git(['apply', String(args.path)]));
  reg(registry, 'git_create_patch', 'Create a patch from current diff.', { output: { type: 'string', description: 'Output patch path' } }, ['output'], ['read_code'], false, async args => builtinTools.exportMarkdown(String(args.output), await builtinTools.git(['diff'])));
  reg(registry, 'export_patch', 'Export current git diff as a patch.', { output: { type: 'string', description: 'Output patch path' } }, ['output'], ['read_code'], false, async args => builtinTools.exportMarkdown(String(args.output), await builtinTools.git(['diff'])));
  reg(registry, 'run_background', 'Run a shell command in the background.', { command: { type: 'string', description: 'Command to run' } }, ['command'], ['execute_command'], true, async args => builtinTools.runBackground(String(args.command)));
  reg(registry, 'check_command', 'Check a background command status.', { id: { type: 'string', description: 'Command id' } }, ['id'], ['read_code'], false, async args => builtinTools.checkCommand(String(args.id)));
  reg(registry, 'stop_command', 'Stop a background command.', { id: { type: 'string', description: 'Command id' } }, ['id'], ['execute_command'], true, async args => builtinTools.stopCommand(String(args.id)));
  reg(registry, 'open_preview', 'Return a local preview URL.', { url: { type: 'string', description: 'Preview URL' } }, ['url'], ['read_code'], false, async args => builtinTools.openPreview(String(args.url)));
  reg(registry, 'browser_open', 'Open a URL in the system browser.', { url: { type: 'string', description: 'URL to open' } }, ['url'], ['execute_command'], true, async args => builtinTools.browserOpen(String(args.url)));
  reg(registry, 'run_test', 'Run package test script.', {}, [], ['execute_command'], true, async () => builtinTools.runScript('test'));
  reg(registry, 'run_build', 'Run package build script.', {}, [], ['execute_command'], true, async () => builtinTools.runScript('build'));
  reg(registry, 'run_lint', 'Run package lint script.', {}, [], ['execute_command'], true, async () => builtinTools.runScript('lint'));
  reg(registry, 'doctor', 'Check local toolchain health.', {}, [], ['read_code'], false, async () => builtinTools.doctor());
  reg(registry, 'inspect_file', 'Inspect any file including media/binary files.', { path: { type: 'string', description: 'File path' } }, ['path'], ['read_code'], false, async args => builtinTools.inspectFile(String(args.path)));
  reg(registry, 'extract_text', 'Best-effort text extraction from a file.', { path: { type: 'string', description: 'File path' } }, ['path'], ['read_code'], false, async args => builtinTools.extractText(String(args.path)));
  reg(registry, 'extract_pdf_text', 'Best-effort PDF text extraction.', { path: { type: 'string', description: 'PDF path' } }, ['path'], ['read_code'], false, async args => builtinTools.extractPdfText(String(args.path)));
  reg(registry, 'extract_docx_text', 'Best-effort DOCX text extraction.', { path: { type: 'string', description: 'DOCX path' } }, ['path'], ['read_code'], false, async args => builtinTools.extractDocxText(String(args.path)));
  reg(registry, 'extract_xlsx_data', 'Best-effort XLSX data extraction.', { path: { type: 'string', description: 'XLSX path' } }, ['path'], ['read_code'], false, async args => builtinTools.extractXlsxData(String(args.path)));
  reg(registry, 'ocr_image', 'OCR an image if OCR engine is available.', { path: { type: 'string', description: 'Image path' } }, ['path'], ['read_code'], false, async args => builtinTools.ocrImage(String(args.path)));
  reg(registry, 'transcribe_audio', 'Transcribe audio if transcription engine is available.', { path: { type: 'string', description: 'Audio path' } }, ['path'], ['read_code'], false, async args => builtinTools.transcribeAudio(String(args.path)));
  reg(registry, 'video_metadata', 'Inspect video metadata.', { path: { type: 'string', description: 'Video path' } }, ['path'], ['read_code'], false, async args => builtinTools.videoMetadata(String(args.path)));
  reg(registry, 'convert_file', 'Convert file using fallback copy when no converter is available.', { input: { type: 'string', description: 'Input path' }, output: { type: 'string', description: 'Output path' } }, ['input', 'output'], ['write_code'], true, async args => builtinTools.convertFile(String(args.input), String(args.output)));
  reg(registry, 'compress_image', 'Compress image using fallback copy when no compressor is available.', { input: { type: 'string', description: 'Input path' }, output: { type: 'string', description: 'Output path' } }, ['input', 'output'], ['write_code'], true, async args => builtinTools.compressImage(String(args.input), String(args.output)));
  reg(registry, 'generate_thumbnail', 'Generate thumbnail using fallback copy when no generator is available.', { input: { type: 'string', description: 'Input path' }, output: { type: 'string', description: 'Output path' } }, ['input', 'output'], ['write_code'], true, async args => builtinTools.generateThumbnail(String(args.input), String(args.output)));
  reg(registry, 'version', 'Show project version.', {}, [], ['read_code'], false, async () => builtinTools.version());
  reg(registry, 'tool_health', 'Check built-in tool health.', {}, [], ['read_code'], false, async () => builtinTools.toolHealth());
  reg(registry, 'todo_write', 'Create a todo checklist.', { items: { type: 'array', description: 'Todo items' } }, ['items'], ['read_code'], false, async args => builtinTools.todoWrite(args.items as string[]));
  reg(registry, 'mcp_list', 'List MCP servers.', {}, [], ['read_code'], false, async () => builtinTools.mcpList());
  reg(registry, 'mcp_add', 'Add MCP server placeholder.', { name: { type: 'string', description: 'Server name' }, command: { type: 'string', description: 'Server command' } }, ['name', 'command'], ['write_code'], true, async args => builtinTools.mcpAdd(String(args.name), String(args.command)));
  reg(registry, 'mcp_remove', 'Remove MCP server placeholder.', { name: { type: 'string', description: 'Server name' } }, ['name'], ['write_code'], true, async args => builtinTools.mcpRemove(String(args.name)));
  reg(registry, 'mcp_tools', 'List MCP tools.', { name: { type: 'string', description: 'Server name' } }, [], ['read_code'], false, async args => builtinTools.mcpTools(args.name ? String(args.name) : undefined));
  reg(registry, 'plugin_list', 'List plugins.', {}, [], ['read_code'], false, async () => builtinTools.pluginList());
  reg(registry, 'plugin_install', 'Install plugin placeholder.', { name: { type: 'string', description: 'Plugin name' } }, ['name'], ['write_code'], true, async args => builtinTools.pluginInstall(String(args.name)));
  reg(registry, 'checkpoint_create', 'Create an internal workspace checkpoint.', { name: { type: 'string', description: 'Checkpoint name' } }, ['name'], ['write_code'], true, async args => builtinTools.checkpointCreate(String(args.name)));
  reg(registry, 'checkpoint_list', 'List internal workspace checkpoints.', {}, [], ['read_code'], false, async () => builtinTools.checkpointList());
  reg(registry, 'checkpoint_restore', 'Restore an internal workspace checkpoint.', { name: { type: 'string', description: 'Checkpoint name' } }, ['name'], ['write_code'], true, async args => builtinTools.checkpointRestore(String(args.name)));
  reg(registry, 'checkpoint_delete', 'Delete an internal workspace checkpoint.', { name: { type: 'string', description: 'Checkpoint name' } }, ['name'], ['write_code'], true, async args => builtinTools.checkpointDelete(String(args.name)));

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

let keypressInitialized = false;

/** 创建审批回调（使用 i18n） */
function createApprovalHandler() {
  return async (toolName: string, args: Record<string, unknown>) => {
    const label = i18n.toolLabel(toolName);
    const detail = args.path
      ? i18n.t('approval.file_detail', { path: String(args.path) })
      : args.input
        ? i18n.t('approval.command_detail', { cmd: String(args.input).slice(0, 120) })
        : undefined;

    const approvalLines = [
      t.warning(s.bold(i18n.t('approval.box_title'))),
      `${t.text(label + ':')} ${t.accent(toolName)}`,
      ...(detail ? [t.dim(detail)] : []),
    ];
    process.stdout.write(approvalLines.join('\n') + '\n');

    if (!keypressInitialized) {
      readline.emitKeypressEvents(process.stdin);
      keypressInitialized = true;
    }

    return new Promise<boolean>(resolve => {
      let raw = false;
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(true); raw = true; } catch { /* ignore */ }
      }
      process.stdin.resume();
      const choices = [
        { label: i18n.t('approval.run'), value: true },
        { label: i18n.t('approval.cancel'), value: false },
      ];
      let sel = 0;
      let linesDrawn = 0;
      const clear = () => {
        if (linesDrawn > 0) process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[0J`);
        linesDrawn = 0;
      };
      const draw = () => {
        clear();
        const lines = choices.map((choice, i) => `${i === sel ? t.accent('▶') : ' '} ${i === sel ? s.bold(choice.label) : choice.label}`);
        lines.push('', t.dim('↑↓  Enter  Esc'));
        process.stdout.write(lines.join('\n') + '\n');
        linesDrawn = lines.length;
      };
      let done = false;
      const cleanup = () => {
        clear();
        process.stdout.write(`\x1b[${approvalLines.length}A\r\x1b[0J`);
        process.stdin.removeListener('keypress', onKeypress);
        if (raw) try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      };
      const finish = (approved: boolean) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(approved);
      };
      const onKeypress = (_str: string | undefined, key: readline.Key) => {
        if (key?.ctrl && key.name === 'c') finish(false);
        else if (key?.name === 'up' || key?.name === 'down') { sel = sel === 0 ? 1 : 0; draw(); }
        else if (key?.name === 'return' || key?.name === 'enter') finish(choices[sel]!.value);
        else if (key?.name === 'escape') finish(false);
      };

      process.stdin.on('keypress', onKeypress);
      draw();
    });
  };
}

/** 创建 Executor 实例（懒加载：provider 无 API key 也能进入 REPL） */
function createExecutor(providerName?: string, modelName?: string, apiKey?: string, baseUrl?: string, lspManager?: LSPManager) {
  const provider = createProvider(providerName ?? 'deepseek', { modelName, apiKey, baseUrl });
  const registry = buildRegistry(lspManager);
  const permissionEngine = new PermissionEngine();
  const controller = new ExecutionController({ maxBudgetUsd: 5.0, deadLoopThreshold: 4 });
  const approvalHandler = createApprovalHandler();

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
        content: `Create an execution plan for the following task. Read-only exploration. Do not modify any files.\n\nTask: ${opts.prompt}\n\nOutput the plan.`,
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
        const cleanContent = lastAssistant.content.trim();
        process.stdout.write('\n' + t.purple('📋 Result:') + '\n');
        process.stdout.write(renderMarkdown(cleanContent) + '\n');
      }
    } catch (err) {
      console.log(`\n${i18n.t('error.execution')} ${(err as Error).message}`);
    }
    return;
  }

  // ── REPL 模式 ──
  const lsp = new LSPManager(PROJECT_ROOT);

  // 为 REPL 创建 executor — 用回退链解析模型
  const resolved = modelRegistry.resolve('action');
  const providerDisplay = resolved
    ? `${resolved.provider}/${resolved.name}`
    : i18n.t('welcome.no_model');
  const providerCfg = resolved ? configStore.getProvider(resolved.provider) : undefined;
  const executor = resolved
    ? createExecutor(resolved.provider, resolved.name, providerCfg?.apiKey, providerCfg?.baseUrl, lsp)
    : createExecutor(undefined, undefined, undefined, undefined, lsp);

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
