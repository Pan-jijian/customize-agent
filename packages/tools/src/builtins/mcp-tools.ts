// @customize-agent/tools — MCP 管理工具
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type McpConfig = Record<string, { command: string; args: string[] }>;

export class McpTools {
  constructor(private cwd: string) {}

  private configDir(): string {
    return path.join(os.homedir(), '.customize-agent');
  }

  private mcpConfigFile(): string {
    return path.join(this.configDir(), 'mcp.json');
  }

  private async loadMcpConfig(): Promise<McpConfig> {
    try { return JSON.parse(await fs.readFile(this.mcpConfigFile(), 'utf-8')) as McpConfig; }
    catch { return {}; }
  }

  private async saveMcpConfig(config: McpConfig): Promise<void> {
    await fs.mkdir(this.configDir(), { recursive: true });
    await fs.writeFile(this.mcpConfigFile(), JSON.stringify(config, null, 2), 'utf-8');
  }

  async mcpList(): Promise<string> {
    const config = await this.loadMcpConfig();
    const entries = Object.entries(config);
    return entries.length ? entries.map(([name, server]) => `${name}: ${server.command} ${server.args.join(' ')}`.trim()).join('\n') : 'No MCP servers configured.';
  }

  async mcpAdd(name: string, command: string): Promise<string> {
    const [cmd, ...args] = command.split(/\s+/).filter(Boolean);
    if (!cmd) throw new Error('MCP command is required');
    const config = await this.loadMcpConfig();
    config[name] = { command: cmd, args };
    await this.saveMcpConfig(config);
    return `MCP server added: ${name}`;
  }

  async mcpRemove(name: string): Promise<string> {
    const config = await this.loadMcpConfig();
    delete config[name];
    await this.saveMcpConfig(config);
    return `MCP server removed: ${name}`;
  }

  async mcpTools(name?: string): Promise<string> {
    const config = await this.loadMcpConfig();
    const names = name ? [name] : Object.keys(config);
    if (!names.length) return 'No MCP servers configured.';
    const output: string[] = [];
    for (const serverName of names) {
      const server = config[serverName];
      if (!server) { output.push(`${serverName}: not configured`); continue; }
      const transport = new StdioClientTransport({ command: server.command, args: server.args, cwd: this.cwd, stderr: 'pipe' });
      const client = new Client({ name: 'customize-agent', version: '1.0.0' }, { capabilities: {} });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        output.push(`${serverName}:\n${tools.tools.map(tool => `- ${tool.name}: ${tool.description ?? ''}`).join('\n') || 'No tools.'}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    }
    return output.join('\n\n');
  }
}
