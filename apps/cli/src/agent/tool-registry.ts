import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import type { ILLMProvider } from '@customize-agent/llm';
import {
  ToolRegistry,
  Orchestrator,
  McpClient,
  createBuiltinSubagentConfig,
  ROLE_CAPABILITY_MAP,
  createIsolationManager,
  type ToolExecutionContext,
  type CollaborationMode,
  type SubagentRole,
  type SubagentTask,
  type McpServerConfig,
} from '@customize-agent/engine';
import { ToolKit, SandboxExecutor, BuiltinTools } from '@customize-agent/tools';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { LSPManager, CodeSearcher } from '@customize-agent/search';
import { BINARY_EXTENSIONS } from '@customize-agent/types';
import { MultiProjectManager, type LLMSearchProvider } from '@customize-agent/knowledge';

type CliMcpConfig = Record<string, { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }>;

export interface BuildRegistryOptions {
  root: string;
  knowledgeRoot?: string;
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

async function writeTempCodeFile(command: string, context?: ToolExecutionContext): Promise<string | undefined> {
  const match = command.match(/^(python3?|node)\s+-[ce]\s+(["'])([\s\S]*)\2\s*$/u);
  if (!match) return undefined;
  const runtime = match[1] ?? 'node';
  const code = match[3] ?? '';
  const ctx = context as (ToolExecutionContext & { tempDir?: string; tempFiles?: string[] }) | undefined;
  const dir = ctx?.tempDir ?? await fs.mkdtemp(nodePath.join(os.tmpdir(), 'customize-agent-task-'));
  if (ctx) ctx.tempDir = dir;
  await fs.mkdir(dir, { recursive: true });
  const ext = runtime.startsWith('python') ? 'py' : 'mjs';
  const filePath = nodePath.join(dir, `inline-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  await fs.writeFile(filePath, code, 'utf8');
  ctx?.tempFiles?.push(filePath);
  return runtime.startsWith('python') ? `python3 ${JSON.stringify(filePath)}` : `node ${JSON.stringify(filePath)}`;
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

function createSubagentToolRegistry(role: SubagentRole, provider: ILLMProvider, root: string, knowledgeRoot: string, lspManager?: LSPManager): ToolRegistry {
  const allowed = new Set<string>(ROLE_CAPABILITY_MAP[role]);
  const baseRegistry = buildRegistry({ root, knowledgeRoot, lspManager, provider, includeOrchestrator: false });
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

function parseJsonObject(input?: string): Record<string, unknown> {
  if (!input) return {};
  try { return JSON.parse(input) as Record<string, unknown>; } catch { return {}; }
}

function metadataValue(metadata: Record<string, unknown>, key: string): string | number | undefined {
  const extraction = typeof metadata.extraction === 'object' && metadata.extraction ? metadata.extraction as Record<string, unknown> : metadata;
  const value = extraction[key] ?? metadata[key];
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function kbInventoryMarkdown(files: Array<{ relativePath: string; category: string; format: string; chunkCount: number; status: string; errorMessage?: string; metadataJson?: string }>): string {
  const rows = files.map(file => {
    const metadata = parseJsonObject(file.metadataJson);
    return {
      file: file.relativePath,
      category: file.category,
      format: file.format,
      chunks: file.chunkCount,
      status: file.status,
      extractionMode: String(metadataValue(metadata, 'extractionMode') ?? 'unknown'),
      textLength: Number(metadataValue(metadata, 'textLength') ?? 0),
      warning: file.errorMessage || (Array.isArray(metadata.warnings) ? metadata.warnings.join('; ') : ''),
    };
  });
  const failed = rows.filter(row => row.status !== 'active' || row.chunks === 0);
  const metadataOnly = rows.filter(row => row.extractionMode.includes('metadata'));
  const lines = [
    '# 知识库资料盘点',
    '',
    `- 文件总数：${rows.length}`,
    `- 有效入库文件：${rows.length - failed.length}`,
    `- 解析失败/无切片文件：${failed.length}`,
    `- 仅元数据文件：${metadataOnly.length}`,
    '',
    '| 文件 | 类型 | 格式 | 切片 | 状态 | 解析方式 | 正文字数 | 备注 |',
    '|---|---|---:|---:|---|---|---:|---|',
    ...rows.map(row => `| ${row.file} | ${row.category} | ${row.format} | ${row.chunks} | ${row.status} | ${row.extractionMode} | ${row.textLength} | ${row.warning.replace(/\|/gu, ' ')} |`),
  ];
  return lines.join('\n');
}

const CONSTRUCTION_OUTLINE = [
  ['basis', '第一章 编制依据', ['招标文件 编制依据 技术规范 标准 图纸 合同', '规范 标准 图纸 招标文件']],
  ['overview', '第二章 工程概况', ['工程名称 工程地点 建设单位 工程规模 建筑面积 结构类型', '工程概况 招标范围 项目规模']],
  ['deployment', '第三章 施工部署', ['施工部署 项目组织机构 施工段划分 总体安排', '施工组织 施工顺序 施工流水']],
  ['schedule', '第四章 施工进度计划及保证措施', ['工期要求 开工 竣工 进度计划 节点工期', '工期 进度 保证措施']],
  ['preparation', '第五章 施工准备', ['施工准备 技术准备 现场准备 材料准备 机械准备', '临设 水电 进场 准备']],
  ['methods', '第六章 主要分部分项工程施工方案', ['土方 基础 主体 砌体 装饰 安装 道路 管线 主要施工方法', '分部分项 施工工艺 技术措施']],
  ['quality', '第七章 质量保证体系及措施', ['质量目标 质量标准 验收规范 质量保证措施', '质量管理 检验 试验']],
  ['safety', '第八章 安全生产管理体系及措施', ['安全目标 安全文明施工 安全管理 危险源 应急预案', '安全生产 风险 防护']],
  ['civilized', '第九章 文明施工及环境保护措施', ['文明施工 环境保护 扬尘 噪声 污水 固废', '绿色施工 环保 控制措施']],
  ['resources', '第十章 劳动力、材料、机械设备投入计划', ['劳动力计划 材料计划 机械设备计划 主要设备 表格', '资源投入 机械 劳动力 材料']],
  ['layout', '第十一章 施工总平面布置', ['施工平面布置 临时设施 道路 水电 堆场', '总平面布置 临时用地']],
  ['season', '第十二章 季节性施工措施', ['雨季施工 冬季施工 高温施工 台风 防汛', '季节性施工 措施']],
  ['emergency', '第十三章 应急预案', ['应急预案 风险 应急组织 救援措施', '事故 应急 响应']],
  ['appendix', '第十四章 附表及附件', ['附表 计划表 机械表 劳动力表 进度表', '附件 表格 清单 图纸']],
] as const;

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function sourceLine(item: { filePath: string; score: number; content: string }): string {
  return `- ${item.filePath}（score=${item.score.toFixed(3)}）：${item.content.replace(/\s+/gu, ' ').slice(0, 220)}`;
}

async function generateConstructionDesignMarkdown(args: { requirement: string; projectRoot: string; manager: MultiProjectManager; provider?: ILLMProvider; maxEvidencePerChapter: number }): Promise<string> {
  const project = await args.manager.getProject(args.projectRoot);
  await project.incrementalIndex();
  const inventory = kbInventoryMarkdown(project.listFiles());
  const chapterBlocks: string[] = [];
  const usedSources = new Map<string, number>();
  const missing: string[] = [];

  for (const [, title, queries] of CONSTRUCTION_OUTLINE) {
    const evidence = [] as Array<{ filePath: string; score: number; content: string }>;
    for (const query of queries) {
      const result = await args.manager.search(args.projectRoot, query, { scope: 'project', limit: args.maxEvidencePerChapter });
      evidence.push(...result.results.map(item => ({ filePath: item.filePath, score: item.score, content: item.content })));
    }
    const selected = uniqueBy(evidence.sort((a, b) => b.score - a.score), item => `${item.filePath}:${item.content.slice(0, 80)}`).slice(0, args.maxEvidencePerChapter);
    for (const item of selected) usedSources.set(item.filePath, (usedSources.get(item.filePath) ?? 0) + 1);
    if (selected.length === 0) missing.push(`${title}：未检索到明确资料依据`);

    let content: string;
    if (args.provider && selected.length > 0) {
      const response = await args.provider.chat([
        { role: 'system', content: '你是施工组织设计编制专家。只能根据用户提供的知识库证据编写，不得编造具体工程数据；缺失内容必须写“资料未提供，需进一步确认”。输出 Markdown。' },
        { role: 'user', content: `用户要求：${args.requirement}\n\n章节：${title}\n\n证据：\n${selected.map(sourceLine).join('\n')}\n\n请编写本章内容，关键数据后标注来源文件名。` },
      ], { temperature: 0.2, maxTokens: 2400 });
      content = response.content.trim();
    } else {
      content = [`## ${title}`, '', selected.length > 0 ? '本章依据知识库检索到的资料整理如下：' : '资料未提供，需进一步确认。', '', ...selected.map(sourceLine)].join('\n');
    }
    chapterBlocks.push(content.startsWith('## ') ? content : `## ${title}\n\n${content}`);
  }

  return [
    `# 施工组织设计`,
    '',
    `> 生成要求：${args.requirement}`,
    '',
    '## 资料盘点',
    '',
    inventory.replace(/^# 知识库资料盘点\n\n/u, ''),
    '',
    ...chapterBlocks,
    '',
    '## 资料来源清单',
    '',
    '| 文件 | 引用次数 |',
    '|---|---:|',
    ...[...usedSources.entries()].sort((a, b) => b[1] - a[1]).map(([file, count]) => `| ${file} | ${count} |`),
    '',
    '## 资料缺失项与需确认事项',
    '',
    ...(missing.length > 0 ? missing.map(item => `- ${item}`) : ['- 暂未发现章节级资料完全缺失项；仍建议人工复核工期、质量目标、清单工程量、图纸说明等关键数据。']),
  ].join('\n');
}

export function buildRegistry(options: BuildRegistryOptions): ToolRegistry {
  const { root, knowledgeRoot = root, lspManager, provider, includeOrchestrator = true } = options;
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
    const warnings = [...new Set(matches.map(m => m.warning).filter((warning): warning is string => Boolean(warning)))];
    const lines = matches.filter(m => m.file).map(m => `${m.file}:${m.line}: ${m.content}`);
    const body = lines.length > 0 ? lines.join('\n') : `No matches found for "${args.pattern}".`;
    return [...warnings, body].join(warnings.length ? '\n\n' : '');
  });

  reg(registry, 'knowledge_search', 'Search the local knowledge base. Use this for business documents, uploaded files, PDFs, spreadsheets, CAD drawings, and knowledgeBase content instead of reading raw knowledgeBase files. For formal document generation, use limit 20-50 and run multiple chapter-specific searches.', {
    query: { type: 'string', description: 'Natural language query or keywords to search in the local knowledge base' },
    scope: { type: 'string', description: 'Search scope: project, global, or all. Default: all' },
    limit: { type: 'number', description: 'Maximum number of results. Default: 10' },
  }, ['query'], ['search_symbol'], false, async args => {
    // 将 ILLMProvider 作为 LLMSearchProvider 传入（结构兼容）
    const manager = new MultiProjectManager(undefined, provider as LLMSearchProvider);
    try {
      const result = await manager.search(knowledgeRoot, String(args.query), {
        scope: args.scope === 'project' || args.scope === 'global' || args.scope === 'all' ? args.scope : 'all',
        limit: typeof args.limit === 'number' ? args.limit : 10,
        weights: { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
      });
      if (result.results.length === 0) return `No knowledge base results for "${String(args.query)}".`;
      return result.results.map((item, index) => [
        `## KB-${index + 1}: ${item.filePath}`,
        `scope=${item.scope}, score=${item.score.toFixed(3)}, collection=${item.collection}, source=${item.source ?? 'unknown'}`,
        item.sectionTitle ? `section=${item.sectionTitle}` : '',
        item.content,
      ].filter(Boolean).join('\n')).join('\n\n');
    } finally {
      await manager.shutdown();
    }
  });

  reg(registry, 'knowledge_inventory', 'Inventory the local knowledge base files, extraction status, chunk counts, parsing modes, warnings, and failed files. Use before generating formal documents from uploaded materials.', {}, [], ['search_symbol'], false, async () => {
    const manager = new MultiProjectManager(undefined, provider as LLMSearchProvider);
    try {
      const project = await manager.getProject(knowledgeRoot);
      await project.incrementalIndex();
      return kbInventoryMarkdown(project.listFiles());
    } finally {
      await manager.shutdown();
    }
  });

  reg(registry, 'knowledge_file_detail', 'Read parsed chunks and metadata for a specific knowledge base file after knowledge_search finds a relevant source.', {
    relativePath: { type: 'string', description: 'Knowledge base relative file path' },
    maxChunks: { type: 'number', description: 'Maximum chunks to return. Default: 30' },
  }, ['relativePath'], ['search_symbol'], false, async args => {
    const manager = new MultiProjectManager(undefined, provider as LLMSearchProvider);
    try {
      const project = await manager.getProject(knowledgeRoot);
      await project.incrementalIndex();
      const detail = project.getFileDetail(String(args.relativePath));
      if (!detail) return `No knowledge base file detail found for ${String(args.relativePath)}.`;
      const maxChunks = typeof args.maxChunks === 'number' ? Math.max(1, Math.min(200, args.maxChunks)) : 30;
      const metadata = parseJsonObject(detail.file.metadataJson);
      return [
        `# ${detail.file.relativePath}`,
        '',
        `- category: ${detail.file.category}`,
        `- format: ${detail.file.format}`,
        `- status: ${detail.file.status}`,
        `- chunks: ${detail.file.chunkCount}`,
        `- extractionMode: ${metadataValue(metadata, 'extractionMode') ?? 'unknown'}`,
        `- textLength: ${metadataValue(metadata, 'textLength') ?? 0}`,
        detail.file.errorMessage ? `- error: ${detail.file.errorMessage}` : '',
        '',
        '## Parsed chunks',
        ...detail.chunks.slice(0, maxChunks).map(chunk => `\n### Chunk ${chunk.chunkIndex}${chunk.sectionTitle ? ` — ${chunk.sectionTitle}` : ''}\n${chunk.content}`),
      ].filter(Boolean).join('\n');
    } finally {
      await manager.shutdown();
    }
  });

  reg(registry, 'generate_construction_organization_design', 'Generate a construction organization design Markdown draft from the local knowledge base using inventory, chapter-level retrieval, source citations, and missing-item reporting. Export to PDF separately with export_pdf after reviewing the Markdown.', {
    requirement: { type: 'string', description: 'User requirement and project generation instruction' },
    output: { type: 'string', description: 'Markdown output file path' },
    maxEvidencePerChapter: { type: 'number', description: 'Evidence count per chapter. Default: 12' },
  }, ['requirement', 'output'], ['search_symbol', 'write_code'], true, async args => {
    const manager = new MultiProjectManager(undefined, provider as LLMSearchProvider);
    try {
      const markdown = await generateConstructionDesignMarkdown({
        requirement: String(args.requirement),
        projectRoot: knowledgeRoot,
        manager,
        provider,
        maxEvidencePerChapter: typeof args.maxEvidencePerChapter === 'number' ? Math.max(5, Math.min(30, args.maxEvidencePerChapter)) : 12,
      });
      await toolkit.writeFileWithBackup(String(args.output), markdown);
      return `Construction organization design draft exported: ${String(args.output)}\n\n${markdown.slice(0, 4000)}`;
    } finally {
      await manager.shutdown();
    }
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
    handler: async (args: Record<string, unknown>, context?: ToolExecutionContext) => {
      throwIfAborted(context?.signal);
      const filePath = String(args.path);
      const input = String(args.input);
      if (input.includes('<<<<<<< SEARCH')) {
        throwIfAborted(context?.signal);
        const result = await toolkit.modifyFileWithDiff(filePath, input);
        throwIfAborted(context?.signal);
        return `${result.preview}\n\nPlease run the build command to validate this change.`;
      }
      throwIfAborted(context?.signal);
      await toolkit.writeFileWithBackup(filePath, input);
      throwIfAborted(context?.signal);
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
      const tempCommand = await writeTempCodeFile(cmd, context);
      const commandToRun = tempCommand ?? cmd;
      const isCode = tempCommand !== undefined;
      const executor = isCode ? new SandboxExecutor('docker', root) : null;
      const result = executor ? await executor.execute(commandToRun, undefined, true, context?.signal) : await toolkit.terminal.executeCommand(commandToRun, true, context?.signal);
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
    edit_file:             async (a, c) => { throwIfAborted(c?.signal); return builtinTools.editFile(S(a.path), S(a.search), S(a.replace)); },
    multi_edit:            async (a, c) => { throwIfAborted(c?.signal); return builtinTools.multiEdit(S(a.path), a.edits as Array<{ search: string; replace: string }>); },
    delete_file:           async (a, c) => { throwIfAborted(c?.signal); return builtinTools.deleteFile(S(a.path)); },
    move_file:             async (a, c) => { throwIfAborted(c?.signal); return builtinTools.moveFile(S(a.from), S(a.to)); },
    copy_file:             async (a, c) => { throwIfAborted(c?.signal); return builtinTools.copyFile(S(a.from), S(a.to)); },
    mkdir:                 async (a, c) => { throwIfAborted(c?.signal); return builtinTools.mkdir(S(a.path)); },
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
    export_markdown:       async (a, c) => { throwIfAborted(c?.signal); return builtinTools.exportMarkdown(S(a.output), S(a.content)); },
    export_json:           async (a, c) => { throwIfAborted(c?.signal); return builtinTools.exportJson(S(a.output), a.data); },
    export_html:           async (a, c) => { throwIfAborted(c?.signal); return builtinTools.exportHtml(S(a.output), S(a.title ?? 'Export'), S(a.content)); },
    export_pdf:            async (a, c) => { throwIfAborted(c?.signal); return builtinTools.exportPdf(S(a.output), S(a.title ?? 'Export'), S(a.content)); },
    export_session:        async (a, c) => { throwIfAborted(c?.signal); return builtinTools.exportSession(S(a.output), a.data); },
    zip_files:             async (a, c) => { throwIfAborted(c?.signal); return builtinTools.zipFiles(S(a.output), a.files as string[]); },
    git_status:            () => builtinTools.git(['status', '--short']),
    git_diff:              () => builtinTools.git(['diff']),
    git_log:               () => builtinTools.git(['log', '--oneline', '-20']),
    git_stash:             () => builtinTools.git(['stash', 'push']),
    git_apply_patch:       (a) => builtinTools.git(['apply', S(a.path)]),
    git_create_patch:      async (a) => builtinTools.exportMarkdown(S(a.output), await builtinTools.git(['diff'])),
    export_patch:           async (a) => builtinTools.exportMarkdown(S(a.output), await builtinTools.git(['diff'])),
    run_background:        (a) => builtinTools.runBackground(S(a.command ?? a.input)),
    check_command:         (a) => builtinTools.checkCommand(S(a.id)),
    stop_command:          (a) => builtinTools.stopCommand(S(a.id)),
    open_preview:          (a) => builtinTools.openPreview(S(a.url)),
    browser_open:          (a) => builtinTools.browserOpen(S(a.url)),
    run_test:              (_a, c) => builtinTools.runScript('test', c?.signal),
    run_build:             (_a, c) => builtinTools.runScript('build', c?.signal),
    run_lint:              (_a, c) => builtinTools.runScript('lint', c?.signal),
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
      handler: async (args) => {
        const tasks = parseOrchestrationTasks(args);
        if (tasks.length === 0) return 'No subagent task provided.';
        const mode = parseCollaborationMode(args.mode);
        const defaultRole = parseSubagentRole(args.role, mode === 'swarm' ? 'implementer' : 'planner');
        const roles = Array.isArray(args.roles) ? args.roles : [];
        const isolation = await createIsolationManager(root);
        const orchestrator = new Orchestrator(isolation);
        const result = await orchestrator.orchestrate(tasks, (task, index, worktreePath) => {
          const role = parseSubagentRole(roles[index], defaultRole);
          const subRoot = worktreePath ?? root;
          const subLsp = worktreePath ? new LSPManager(worktreePath) : lspManager;
          return createBuiltinSubagentConfig(role, `${role}-${task.id}-${index + 1}`, provider, createSubagentToolRegistry(role, provider, subRoot, knowledgeRoot, subLsp));
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
