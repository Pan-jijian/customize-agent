import { spawn, type ChildProcess } from 'child_process';
import type { ToolRegistry, RegisteredTool } from '../tools/registry.js';
import { type JsonRpcResponse, jsonRpcSerialize, splitJsonLines } from './json-rpc.js';

/** MCP Server 连接信息 */
interface McpConnection {
  serverName: string;
  process: ChildProcess;
  requestId: number;
  pending: Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buffer: string;
  tools: RegisteredTool[];
}

export interface McpServerConfig {
  /** 唯一服务器名称（工具前缀 mcp_{name}_） */
  name: string;
  /** 启动命令 */
  command: string;
  /** 命令参数 */
  args: string[];
  /** 环境变量 */
  env?: Record<string, string>;
}

/**
 * MCP Client — 连接外部 MCP Server 子进程，动态注册其工具到本地 ToolRegistry。
 *
 * 工具命名: mcp_{serverName}_{toolName}
 * 默认 requiresApproval: true（外部工具需用户批准）
 * 支持 disconnect 全部连接 + 进程生命周期管理 (ADR-8)
 */
export class McpClient {
  private connections = new Map<string, McpConnection>();
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
    // 退出时清理所有 MCP 进程
    for (const signal of ['SIGINT', 'SIGTERM', 'exit'] as const) {
      process.on(signal, () => this.disconnectAll());
    }
  }

  /**
   * 连接外部 MCP Server，获取其工具列表并注册到本地 ToolRegistry。
   * 工具名自动添加 mcp_{serverName}_ 前缀。
   */
  async connect(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      throw new Error(`MCP Server "${config.name}" already connected`);
    }

    const proc = spawn(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
      detached: false, // 绑定父进程生命周期 (ADR-8)
    });

    const conn: McpConnection = {
      serverName: config.name,
      process: proc,
      requestId: 0,
      pending: new Map(),
      buffer: '',
      tools: [],
    };

    // stdout — JSON-RPC 响应
    proc.stdout?.on('data', (chunk: Buffer) => {
      conn.buffer += chunk.toString();
      this._processBuffer(conn);
    });

    proc.stderr?.on('data', (_chunk: Buffer) => { /* 日志忽略 */ });
    proc.on('error', () => { conn.pending.forEach(p => p.reject(new Error('MCP process error'))); });
    proc.on('exit', () => { conn.pending.forEach(p => p.reject(new Error('MCP process exited'))); });

    this.connections.set(config.name, conn);

    // 初始化握手
    await this._sendRequest(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'customize-agent', version: '1.0.0' },
      capabilities: {},
    });

    // 获取工具列表
    const toolsResult = await this._sendRequest(conn, 'tools/list', {});
    const tools = (toolsResult as { tools?: Array<{ name: string; description: string; inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] } }> })?.tools ?? [];

    // 注册到本地 ToolRegistry（添加 mcp_ 前缀）
    for (const tool of tools) {
      const prefixedName = `mcp_${config.name}_${tool.name}`;
      const registered: RegisteredTool = {
        name: prefixedName,
        description: `[MCP:${config.name}] ${tool.description}`,
        parameters: {
          type: 'object',
          properties: (tool.inputSchema.properties as Record<string, { type: string; description: string }>) ?? {},
          required: tool.inputSchema.required,
          additionalProperties: false,
        },
        requiresApproval: true, // 外部 MCP 工具默认需审批
        capabilities: ['mcp_external'],
        handler: async (args: Record<string, unknown>) => {
          const result = await this._callTool(config.name, tool.name, args);
          return result;
        },
      };
      conn.tools.push(registered);
      this.registry.register(registered);
    }
  }

  /** 调用指定 MCP Server 的工具 */
  private async _callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const conn = this.connections.get(serverName);
    if (!conn) throw new Error(`MCP Server "${serverName}" not connected`);

    const result = await this._sendRequest(conn, 'tools/call', { name: toolName, arguments: args });
    const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
    return content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(result);
  }

  /** 发送 JSON-RPC 请求 */
  private async _sendRequest(conn: McpConnection, method: string, params: unknown): Promise<unknown> {
    const id = ++conn.requestId;
    const content = jsonRpcSerialize(method, params, id);

    return new Promise((resolve, reject) => {
      conn.pending.set(id, { resolve, reject });
      conn.process.stdin?.write(content + '\n');
    });
  }

  /** 处理 stdout 缓冲中的 JSON-RPC 响应 */
  private _processBuffer(conn: McpConnection): void {
    const { lines, rest } = splitJsonLines(conn.buffer);
    conn.buffer = rest;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined) {
          const pending = conn.pending.get(msg.id);
          if (pending) {
            conn.pending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
      } catch { /* 跳过 */ }
    }
  }

  /** 断开指定 MCP Server 连接 */
  disconnect(serverName: string): void {
    const conn = this.connections.get(serverName);
    if (!conn) return;

    // 清理连接
    conn.process.kill();
    this.connections.delete(serverName);
  }

  /** 断开全部 MCP Server 连接 */
  disconnectAll(): void {
    for (const name of this.connections.keys()) {
      this.disconnect(name);
    }
  }

  /** 列出已连接的 MCP Server */
  listServers(): string[] {
    return Array.from(this.connections.keys());
  }
}
