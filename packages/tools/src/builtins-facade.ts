// @customize-agent/tools — BuiltinTools 向后兼容外观类 + 声明式工具定义

import { FileTools } from './builtins/file-tools.js';
import { SearchTools } from './builtins/search-tools.js';
import { ShellTools } from './builtins/shell-tools.js';
import { WebTools } from './builtins/web-tools.js';
import { ExportTools } from './builtins/export-tools.js';
import { MediaTools } from './builtins/media-tools.js';
import { McpTools } from './builtins/mcp-tools.js';
import type { ToolDef } from './tool-def.js';
import { CheckpointTools } from './builtins/checkpoint-tools.js';
import { WorkspaceFs } from './core/workspace-fs.js';

export class BuiltinTools {
  private _file: FileTools;
  private _search: SearchTools;
  private _shell: ShellTools;
  private _web: WebTools;
  private _export: ExportTools;
  private _media: MediaTools;
  private _mcp: McpTools;
  private _checkpoint: CheckpointTools;
  private workspaceFs: WorkspaceFs;

  constructor(cwd: string = process.cwd()) {
    this.workspaceFs = new WorkspaceFs(cwd);
    this._file = new FileTools(cwd, this.workspaceFs);
    this._search = new SearchTools(cwd);
    this._shell = new ShellTools(cwd);
    this._web = new WebTools(cwd);
    this._export = new ExportTools(cwd);
    this._media = new MediaTools(cwd);
    this._mcp = new McpTools(cwd);
    this._checkpoint = new CheckpointTools(cwd);
  }

  // 文件操作
  editFile = (filePath: string, search: string, replace: string) => this._file.editFile(filePath, search, replace);
  multiEdit = (filePath: string, edits: Array<{ search: string; replace: string }>) => this._file.multiEdit(filePath, edits);
  deleteFile = (filePath: string) => this._file.deleteFile(filePath);
  moveFile = (from: string, to: string) => this._file.moveFile(from, to);
  copyFile = (from: string, to: string) => this._file.copyFile(from, to);
  mkdir = (dir: string) => this._file.mkdir(dir);
  statFile = (filePath: string) => this._file.statFile(filePath);
  inspectFile = (filePath: string) => this._file.inspectFile(filePath);

  // 搜索 & 项目分析
  tree = (dir = '.', depth = 3) => this._search.tree(dir, depth);
  repoMap = () => this._search.repoMap();
  symbolSearch = (query: string) => this._search.symbolSearch(query);
  glob = (pattern: string) => this._search.glob(pattern);
  dependencyGraph = () => this._search.dependencyGraph();
  detectPackageManager = () => this._search.detectPackageManager();

  // Shell 和 Git 工具
  git = (args: string[]) => this._shell.git(args);
  runBackground = (command: string) => this._shell.runBackground(command);
  checkCommand = (id: string) => this._shell.checkCommand(id);
  stopCommand = (id: string) => this._shell.stopCommand(id);
  runScript = (kind: 'test' | 'build' | 'lint', signal?: AbortSignal) => this._shell.runScript(kind, signal);
  openPreview = (url: string) => this._shell.openPreview(url);
  browserOpen = (url: string) => this._shell.browserOpen(url);
  zipFiles = (output: string, files: string[]) => this._shell.zipFiles(output, files);
  doctor = () => this._shell.doctor();
  version = () => this._shell.version();
  toolHealth = () => this._shell.toolHealth();
  todoWrite = (items: string[]) => this._shell.todoWrite(items);
  checkUpdate = (packageName?: string, currentVersion?: string) => this._shell.checkUpdate(packageName, currentVersion);
  update = (packageName?: string) => this._shell.update(packageName);

  // Web 工具
  webSearch = (query: string, signal?: AbortSignal) => this._web.webSearch(query, signal);
  webFetch = (url: string, signal?: AbortSignal) => this._web.webFetch(url, signal);
  downloadFile = (url: string, output: string, signal?: AbortSignal) => this._web.downloadFile(url, output, signal);

  // 导出工具
  exportMarkdown = (output: string, content: string) => this._export.exportMarkdown(output, content);
  exportJson = (output: string, data: unknown) => this._export.exportJson(output, data);
  exportHtml = (output: string, title: string, body: string) => this._export.exportHtml(output, title, body);
  exportPdf = (output: string, title: string, body: string) => this._export.exportPdf(output, title, body);
  exportSession = (output: string, messages: unknown) => this._export.exportSession(output, messages);

  // 媒体工具
  extractText = (filePath: string) => this._media.extractText(filePath);
  extractPdfText = (filePath: string) => this._media.extractPdfText(filePath);
  extractDocxText = (filePath: string) => this._media.extractDocxText(filePath);
  extractXlsxData = (filePath: string) => this._media.extractXlsxData(filePath);
  ocrImage = (filePath: string) => this._media.ocrImage(filePath);
  transcribeAudio = (filePath: string) => this._media.transcribeAudio(filePath);
  videoMetadata = (filePath: string) => this._media.videoMetadata(filePath);
  convertFile = (input: string, output: string) => this._media.convertFile(input, output);
  compressImage = (input: string, output: string) => this._media.compressImage(input, output);
  generateThumbnail = (input: string, output: string) => this._media.generateThumbnail(input, output);

  // MCP 工具
  mcpList = () => this._mcp.mcpList();
  mcpAdd = (name: string, command: string) => this._mcp.mcpAdd(name, command);
  mcpRemove = (name: string) => this._mcp.mcpRemove(name);
  mcpTools = (name?: string) => this._mcp.mcpTools(name);

  // 插件工具
  pluginList = () => this._shell.pluginList();
  pluginInstall = (name: string) => this._shell.pluginInstall(name);

  // 检查点工具
  checkpointCreate = (name: string) => this._checkpoint.checkpointCreate(name);
  checkpointList = () => this._checkpoint.checkpointList();
  checkpointRestore = (name: string) => this._checkpoint.checkpointRestore(name);
  checkpointDelete = (name: string) => this._checkpoint.checkpointDelete(name);

  // ── 声明式工具定义（供 tool-registry 消费，消除手动 Schema 重复）──

  /** 所有内置工具的声明式元数据 */
  static readonly toolDefs: ToolDef[] = [
    // 文件操作
    { name: 'edit_file', description: 'Replace exact text in a file.', params: { path: { type: 'string', description: 'File path' }, search: { type: 'string', description: 'Text to replace' }, replace: { type: 'string', description: 'Replacement text' } }, required: ['path', 'search', 'replace'], capabilities: ['write_code'], needsApproval: true },
    { name: 'multi_edit', description: 'Apply multiple exact replacements to a file.', params: { path: { type: 'string', description: 'File path' }, edits: { type: 'array', description: 'Array of {search, replace}' } }, required: ['path', 'edits'], capabilities: ['write_code'], needsApproval: true },
    { name: 'delete_file', description: 'Delete a file or directory.', params: { path: { type: 'string', description: 'Path to delete' } }, required: ['path'], capabilities: ['write_code'], needsApproval: true },
    { name: 'move_file', description: 'Move or rename a file or directory.', params: { from: { type: 'string', description: 'Source path' }, to: { type: 'string', description: 'Destination path' } }, required: ['from', 'to'], capabilities: ['write_code'], needsApproval: true },
    { name: 'copy_file', description: 'Copy a file or directory.', params: { from: { type: 'string', description: 'Source path' }, to: { type: 'string', description: 'Destination path' } }, required: ['from', 'to'], capabilities: ['write_code'], needsApproval: true },
    { name: 'mkdir', description: 'Create a directory recursively.', params: { path: { type: 'string', description: 'Directory path' } }, required: ['path'], capabilities: ['write_code'], needsApproval: true },
    { name: 'stat_file', description: 'Return file metadata (size, type, modified time).', params: { path: { type: 'string', description: 'Path to inspect' } }, required: ['path'], capabilities: ['read_code'], needsApproval: false },
    { name: 'inspect_file', description: 'Full file inspection with SHA256 hash.', params: { path: { type: 'string', description: 'Path to inspect' } }, required: ['path'], capabilities: ['read_code'], needsApproval: false },
    // 搜索
    { name: 'tree', description: 'Show a directory tree.', params: { path: { type: 'string', description: 'Directory path' }, depth: { type: 'number', description: 'Max depth (default 3)' } }, required: [], capabilities: ['read_code'], needsApproval: false },
    { name: 'repo_map', description: 'Show a high-level repository map.', params: {}, required: [], capabilities: ['read_code'], needsApproval: false },
    { name: 'symbol_search', description: 'Search code symbols by name.', params: { query: { type: 'string', description: 'Symbol name query' } }, required: ['query'], capabilities: ['read_code'], needsApproval: false },
    { name: 'glob', description: 'Find files matching a glob pattern.', params: { pattern: { type: 'string', description: 'Glob pattern (supports * and **)' } }, required: ['pattern'], capabilities: ['read_code'], needsApproval: false },
    { name: 'dependency_graph', description: 'Show dependency graph from package.json.', params: {}, required: [], capabilities: ['read_code'], needsApproval: false },
    { name: 'detect_package_manager', description: 'Detect the package manager used in the project.', params: {}, required: [], capabilities: ['read_code'], needsApproval: false },
    // Web 工具
    { name: 'web_search', description: 'Search the web using DuckDuckGo.', params: { query: { type: 'string', description: 'Search query' } }, required: ['query'], capabilities: ['network'], needsApproval: false },
    { name: 'web_fetch', description: 'Fetch content from a URL.', params: { url: { type: 'string', description: 'URL to fetch' }, max_length: { type: 'number', description: 'Max response length' } }, required: ['url'], capabilities: ['network'], needsApproval: false },
    { name: 'download_file', description: 'Download a file from a URL.', params: { url: { type: 'string', description: 'Download URL' }, output: { type: 'string', description: 'Output file path' } }, required: ['url', 'output'], capabilities: ['network', 'write_code'], needsApproval: true },
    // 导出工具
    { name: 'export_markdown', description: 'Export content as a markdown file.', params: { output: { type: 'string', description: 'Output file path' }, content: { type: 'string', description: 'Markdown content' } }, required: ['output', 'content'], capabilities: ['write_code'], needsApproval: true },
    { name: 'export_json', description: 'Export data as a JSON file.', params: { output: { type: 'string', description: 'Output file path' }, data: { type: 'string', description: 'JSON content' } }, required: ['output', 'data'], capabilities: ['write_code'], needsApproval: true },
    { name: 'export_html', description: 'Export content as an HTML file.', params: { output: { type: 'string', description: 'Output file path' }, title: { type: 'string', description: 'Page title' }, body: { type: 'string', description: 'HTML body content' } }, required: ['output', 'title', 'body'], capabilities: ['write_code'], needsApproval: true },
    { name: 'export_pdf', description: 'Export text content as a PDF file.', params: { output: { type: 'string', description: 'Output file path' }, title: { type: 'string', description: 'Document title' }, body: { type: 'string', description: 'Document body' } }, required: ['output', 'title', 'body'], capabilities: ['write_code'], needsApproval: true },
    { name: 'export_session', description: 'Export the current session as JSON.', params: { output: { type: 'string', description: 'Output file path' } }, required: ['output'], capabilities: ['write_code'], needsApproval: true },
    // Shell 和 Git 工具
    { name: 'zip_files', description: 'Create a tar archive of files.', params: { output: { type: 'string', description: 'Output archive path' }, files: { type: 'array', description: 'File paths to include' } }, required: ['output', 'files'], capabilities: ['write_code', 'execute_command'], needsApproval: true },
    { name: 'git_status', description: 'Show git working tree status.', params: {}, required: [], capabilities: ['git_operation'], needsApproval: false },
    { name: 'git_diff', description: 'Show git diff of changes.', params: {}, required: [], capabilities: ['git_operation'], needsApproval: false },
    { name: 'git_log', description: 'Show recent git commit log.', params: {}, required: [], capabilities: ['git_operation'], needsApproval: false },
    { name: 'git_stash', description: 'Stash current changes.', params: {}, required: [], capabilities: ['git_operation'], needsApproval: true },
    { name: 'git_apply_patch', description: 'Apply a git patch from a file.', params: { path: { type: 'string', description: 'Patch file path' } }, required: ['path'], capabilities: ['git_operation'], needsApproval: true },
    { name: 'git_create_patch', description: 'Create a git patch file.', params: { output: { type: 'string', description: 'Output file path' } }, required: ['output'], capabilities: ['git_operation', 'write_code'], needsApproval: true },
    { name: 'export_patch', description: 'Export the current git diff as a patch file.', params: { output: { type: 'string', description: 'Output file path' } }, required: ['output'], capabilities: ['git_operation', 'write_code'], needsApproval: true },
    { name: 'run_background', description: 'Run a command in the background.', params: { input: { type: 'string', description: 'Command to run' } }, required: ['input'], capabilities: ['execute_command'], needsApproval: true },
    { name: 'check_command', description: 'Check status of a background command.', params: { id: { type: 'string', description: 'Command ID' } }, required: ['id'], capabilities: ['execute_command'], needsApproval: false },
    { name: 'stop_command', description: 'Stop a running background command.', params: { id: { type: 'string', description: 'Command ID' } }, required: ['id'], capabilities: ['execute_command'], needsApproval: true },
    { name: 'run_test', description: 'Run the test script.', params: {}, required: [], capabilities: ['execute_command'], needsApproval: true },
    { name: 'run_build', description: 'Run the build script.', params: {}, required: [], capabilities: ['execute_command'], needsApproval: true },
    { name: 'run_lint', description: 'Run the lint script.', params: {}, required: [], capabilities: ['execute_command'], needsApproval: true },
    { name: 'open_preview', description: 'Open a preview URL.', params: { url: { type: 'string', description: 'URL to preview' } }, required: ['url'], capabilities: ['network'], needsApproval: false },
    { name: 'browser_open', description: 'Open a URL in the system browser.', params: { url: { type: 'string', description: 'URL to open' } }, required: ['url'], capabilities: ['network'], needsApproval: false },
    // 系统
    { name: 'doctor', description: 'Run system diagnostics.', params: {}, required: [], capabilities: ['execute_command'], needsApproval: false },
    { name: 'version', description: 'Show project version.', params: {}, required: [], capabilities: ['read_code'], needsApproval: false },
    { name: 'tool_health', description: 'Check tool health status.', params: {}, required: [], capabilities: ['read_code'], needsApproval: false },
    { name: 'todo_write', description: 'Write a todo list.', params: { items: { type: 'array', description: 'Array of task strings' } }, required: ['items'], capabilities: ['write_code'], needsApproval: false },
    { name: 'check_update', description: 'Check for package updates on npm.', params: { package: { type: 'string', description: 'Package name' }, current: { type: 'string', description: 'Current version' } }, required: [], capabilities: ['network'], needsApproval: false },
    { name: 'update', description: 'Update a global npm package.', params: { package: { type: 'string', description: 'Package name to update' } }, required: [], capabilities: ['execute_command'], needsApproval: true },
    // 媒体
    { name: 'extract_text', description: 'Extract readable text from a binary file.', params: { path: { type: 'string', description: 'File path' } }, required: ['path'], capabilities: ['read_code'], needsApproval: false },
    { name: 'extract_pdf_text', description: 'Extract text from a PDF file.', params: { path: { type: 'string', description: 'PDF file path' } }, required: ['path'], capabilities: ['read_code'], needsApproval: false },
    { name: 'extract_docx_text', description: 'Extract text from a DOCX file.', params: { path: { type: 'string', description: 'DOCX file path' } }, required: ['path'], capabilities: ['read_code'], needsApproval: false },
    { name: 'extract_xlsx_data', description: 'Extract data from an XLSX file.', params: { path: { type: 'string', description: 'XLSX file path' } }, required: ['path'], capabilities: ['read_code'], needsApproval: false },
    { name: 'ocr_image', description: 'Extract text from an image using OCR.', params: { path: { type: 'string', description: 'Image file path' } }, required: ['path'], capabilities: ['read_code'], needsApproval: false },
    { name: 'transcribe_audio', description: 'Extract text from an audio file.', params: { path: { type: 'string', description: 'Audio file path' } }, required: ['path'], capabilities: ['read_code'], needsApproval: false },
    { name: 'video_metadata', description: 'Show video file metadata.', params: { path: { type: 'string', description: 'Video file path' } }, required: ['path'], capabilities: ['read_code'], needsApproval: false },
    { name: 'convert_file', description: 'Convert media file format using ffmpeg.', params: { input: { type: 'string', description: 'Input file path' }, output: { type: 'string', description: 'Output file path' } }, required: ['input', 'output'], capabilities: ['execute_command', 'write_code'], needsApproval: true },
    { name: 'compress_image', description: 'Compress an image to JPEG.', params: { input: { type: 'string', description: 'Input image path' }, output: { type: 'string', description: 'Output image path' } }, required: ['input', 'output'], capabilities: ['write_code'], needsApproval: true },
    { name: 'generate_thumbnail', description: 'Generate a thumbnail from an image.', params: { input: { type: 'string', description: 'Input image path' }, output: { type: 'string', description: 'Output thumbnail path' } }, required: ['input', 'output'], capabilities: ['write_code'], needsApproval: true },
    // MCP 工具
    { name: 'mcp_list', description: 'List configured MCP servers.', params: {}, required: [], capabilities: ['mcp_external'], needsApproval: false },
    { name: 'mcp_add', description: 'Add a new MCP server.', params: { name: { type: 'string', description: 'Server name' }, command: { type: 'string', description: 'Launch command' } }, required: ['name', 'command'], capabilities: ['mcp_external'], needsApproval: true },
    { name: 'mcp_remove', description: 'Remove an MCP server.', params: { name: { type: 'string', description: 'Server name' } }, required: ['name'], capabilities: ['mcp_external'], needsApproval: true },
    { name: 'mcp_tools', description: 'List tools from MCP servers.', params: { name: { type: 'string', description: 'Specific server name (optional)' } }, required: [], capabilities: ['mcp_external'], needsApproval: false },
    { name: 'plugin_list', description: 'List installed plugins.', params: {}, required: [], capabilities: ['read_code'], needsApproval: false },
    { name: 'plugin_install', description: 'Install a plugin.', params: { name: { type: 'string', description: 'Plugin name' } }, required: ['name'], capabilities: ['execute_command'], needsApproval: true },
    // 检查点
    { name: 'checkpoint_create', description: 'Create a workspace checkpoint.', params: { name: { type: 'string', description: 'Checkpoint name' } }, required: ['name'], capabilities: ['write_code'], needsApproval: true },
    { name: 'checkpoint_list', description: 'List all checkpoints.', params: {}, required: [], capabilities: ['read_code'], needsApproval: false },
    { name: 'checkpoint_restore', description: 'Restore a workspace checkpoint.', params: { name: { type: 'string', description: 'Checkpoint name' } }, required: ['name'], capabilities: ['write_code'], needsApproval: true },
    { name: 'checkpoint_delete', description: 'Delete a workspace checkpoint.', params: { name: { type: 'string', description: 'Checkpoint name' } }, required: ['name'], capabilities: ['write_code'], needsApproval: true },
  ];
}
