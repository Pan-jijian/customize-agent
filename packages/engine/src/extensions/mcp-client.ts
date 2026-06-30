import { spawn, type ChildProcess } from 'child_process';
import type { ToolRegistry, RegisteredTool } from '../tools/registry.js';
import { type JsonRpcResponse, jsonRpcSerialize, splitJsonLines } from '../utils/json-rpc.js';

interface McpConnection {
  serverName: string;
  process: ChildProcess;
  requestId: number;
  pending: Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buffer: string;
  tools: RegisteredTool[];
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface McpToolSchema {
  type?: string;
  properties?: Record<string, { type: string; description: string }>;
  required?: string[];
}

interface McpToolContent {
  type: string;
  text?: string;
}

/** MCP Client — 连接外部 MCP Server，并动态注册标准 MCP 工具。 */
export class McpClient {
  private connections = new Map<string, McpConnection>();

  constructor(private registry: ToolRegistry) {
    for (const signal of ['SIGINT', 'SIGTERM', 'exit'] as const) {
      process.on(signal, () => this.disconnectAll());
    }
  }

  async connect(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.name)) throw new Error(`MCP Server "${config.name}" already connected`);

    const proc = spawn(config.command, config.args, {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
      detached: false,
    });

    const conn: McpConnection = {
      serverName: config.name,
      process: proc,
      requestId: 0,
      pending: new Map(),
      buffer: '',
      tools: [],
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      conn.buffer += chunk.toString();
      this.processBuffer(conn);
    });
    proc.on('error', () => conn.pending.forEach(p => p.reject(new Error('MCP process error'))));
    proc.on('exit', () => conn.pending.forEach(p => p.reject(new Error('MCP process exited'))));

    this.connections.set(config.name, conn);

    await this.sendRequest(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'customize-agent', version: '1.0.0' },
      capabilities: {},
    });
    this.sendNotification(conn, 'notifications/initialized', {});

    const toolsResult = await this.sendRequest(conn, 'tools/list', {});
    const tools = (toolsResult as { tools?: Array<{ name: string; description?: string; inputSchema?: McpToolSchema }> }).tools ?? [];

    for (const tool of tools) {
      const schema = tool.inputSchema ?? { type: 'object', properties: {} };
      const registered: RegisteredTool = {
        name: `mcp_${config.name}_${tool.name}`,
        description: `[MCP:${config.name}] ${tool.description ?? tool.name}`,
        parameters: {
          type: schema.type ?? 'object',
          properties: schema.properties ?? {},
          required: schema.required,
          additionalProperties: false,
        },
        requiresApproval: true,
        capabilities: ['mcp_external'],
        handler: async (args: Record<string, unknown>) => {
          const result = await this.callTool(config.name, tool.name, args);
          const content = (result as { content?: McpToolContent[] }).content;
          return content?.map(item => item.type === 'text' ? item.text ?? '' : JSON.stringify(item)).join('\n') ?? JSON.stringify(result);
        },
      };
      conn.tools.push(registered);
      this.registry.register(registered);
    }
  }

  private async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = this.connections.get(serverName);
    if (!conn) throw new Error(`MCP Server "${serverName}" not connected`);
    return this.sendRequest(conn, 'tools/call', { name: toolName, arguments: args });
  }

  private sendNotification(conn: McpConnection, method: string, params: unknown): void {
    conn.process.stdin?.write(this.frame(JSON.stringify({ jsonrpc: '2.0', method, params })));
  }

  private async sendRequest(conn: McpConnection, method: string, params: unknown): Promise<unknown> {
    const id = ++conn.requestId;
    const content = jsonRpcSerialize(method, params, id);
    return new Promise((resolve, reject) => {
      conn.pending.set(id, { resolve, reject });
      conn.process.stdin?.write(this.frame(content));
    });
  }

  private frame(content: string): string {
    return `Content-Length: ${Buffer.byteLength(content, 'utf-8')}\r\n\r\n${content}`;
  }

  private processBuffer(conn: McpConnection): void {
    while (true) {
      const headerEnd = conn.buffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const header = conn.buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) break;
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (conn.buffer.length < bodyStart + length) break;
        const body = conn.buffer.slice(bodyStart, bodyStart + length);
        conn.buffer = conn.buffer.slice(bodyStart + length);
        this.handleMessage(conn, body);
        continue;
      }

      const { lines, rest } = splitJsonLines(conn.buffer);
      if (lines.length === 0) break;
      conn.buffer = rest;
      for (const line of lines) if (line.trim()) this.handleMessage(conn, line);
      break;
    }
  }

  private handleMessage(conn: McpConnection, raw: string): void {
    try {
      const msg = JSON.parse(raw) as JsonRpcResponse;
      if (msg.id === undefined) return;
      const pending = conn.pending.get(msg.id);
      if (!pending) return;
      conn.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    } catch {
      // ignore malformed server logs
    }
  }

  disconnect(serverName: string): void {
    const conn = this.connections.get(serverName);
    if (!conn) return;
    conn.process.kill();
    this.connections.delete(serverName);
  }

  disconnectAll(): void {
    for (const name of this.connections.keys()) this.disconnect(name);
  }

  listServers(): string[] {
    return Array.from(this.connections.keys());
  }
}
