import type { ToolRegistry } from '../tools/registry.js';
import { SchemaAdapter } from '../tools/adapter.js';
import { type JsonRpcRequest, type JsonRpcResponse, jsonRpcResult, jsonRpcError, splitJsonLines } from '../utils/json-rpc.js';

/**
 * MCP Server — 通过 stdio 将内部工具暴露为 MCP 协议。
 * 外部 AI 客户端（Claude Desktop、Cursor）可连接本 Server 使用 Customize Agent 工具。
 *
 * 传输层: stdio (JSON-RPC 2.0)
 * 内部复用: ToolRegistry.listAll() + dispatch()
 */
export class McpServer {
  private registry: ToolRegistry;
  private serverName: string;
  private serverVersion: string;

  constructor(registry: ToolRegistry, name: string = 'customize-agent', version: string = '1.0.0') {
    this.registry = registry;
    this.serverName = name;
    this.serverVersion = version;
  }

  /**
   * 启动 MCP Server — 监听 stdin，响应 JSON-RPC 请求。
   * 阻塞当前进程，直到 stdin 关闭。
   */
  async start(): Promise<void> {
    let buffer = '';
    process.stdin.setEncoding('utf-8');

    for await (const chunk of process.stdin) {
      buffer += chunk as string;
      const { lines, rest } = splitJsonLines(buffer);
      buffer = rest;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const request = JSON.parse(line) as JsonRpcRequest;
          const response = await this._handleRequest(request);
          process.stdout.write(JSON.stringify(response) + '\n');
        } catch {
          // JSON 解析失败，跳过
        }
      }
    }
  }

  /** 处理单条 JSON-RPC 请求 */
  private async _handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (req.method) {
      case 'initialize':
        return jsonRpcResult(req.id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: this.serverName, version: this.serverVersion },
          capabilities: { tools: {} },
        });

      case 'tools/list': {
        const tools = SchemaAdapter.toMcpTools(this.registry);
        return jsonRpcResult(req.id, { tools });
      }

      case 'tools/call': {
        const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        if (!params?.name) return jsonRpcError(req.id, -32602, 'Missing tool name');

        try {
          const result = await this.registry.dispatch(params.name, params.arguments ?? {});
          return jsonRpcResult(req.id, { content: [{ type: 'text', text: result }] });
        } catch (err) {
          return jsonRpcResult(req.id, {
            content: [{ type: 'text', text: `Tool error: ${(err as Error).message}` }],
            isError: true,
          });
        }
      }

      case 'ping':
        return jsonRpcResult(req.id, {});

      default:
        return jsonRpcError(req.id, -32601, `Method not found: ${req.method}`);
    }
  }
}
