import type { ToolRegistry } from '../tools/registry.js';

/** MCP JSON-RPC 2.0 消息格式 */
interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

/**
 * MCP Server — 通过 stdio 将内部工具暴露为 MCP 协议。
 * 外部 AI 客户端（Claude Desktop、Cursor）可连接本 Server 使用 Code Agent 工具。
 *
 * 传输层: stdio (JSON-RPC 2.0)
 * 内部复用: ToolRegistry.listAll() + dispatch()
 */
export class McpServer {
  private registry: ToolRegistry;
  private serverName: string;
  private serverVersion: string;

  constructor(registry: ToolRegistry, name: string = 'code-agent', version: string = '1.0.0') {
    this.registry = registry;
    this.serverName = name;
    this.serverVersion = version;
  }

  /**
   * 启动 MCP Server — 监听 stdin，响应 JSON-RPC 请求。
   * 阻塞当前进程，直到 stdin 关闭。
   */
  async start(): Promise<void> {
    // 设置 stdin 读取
    const chunks: string[] = [];
    process.stdin.setEncoding('utf-8');

    for await (const chunk of process.stdin) {
      chunks.push(chunk as string);
      // 尝试解析完整的 JSON-RPC 消息（以换行分隔）
      const text = chunks.join('');
      const lines = text.split('\n');
      chunks.length = 0;
      if (lines[lines.length - 1] !== '') {
        chunks.push(lines.pop() ?? '');
      }

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const request = JSON.parse(line) as McpRequest;
          const response = await this._handleRequest(request);
          process.stdout.write(JSON.stringify(response) + '\n');
        } catch {
          // JSON 解析失败，跳过
        }
      }
    }
  }

  /** 处理单条 JSON-RPC 请求 */
  private async _handleRequest(req: McpRequest): Promise<McpResponse> {
    const respond = (result?: unknown) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      result,
    });

    const error = (code: number, message: string): McpResponse => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      error: { code, message },
    });

    switch (req.method) {
      case 'initialize':
        return respond({
          protocolVersion: '2024-11-05',
          serverInfo: { name: this.serverName, version: this.serverVersion },
          capabilities: { tools: {} },
        });

      case 'tools/list': {
        const tools: McpTool[] = this.registry.listAll().map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: {
            type: 'object' as const,
            properties: Object.fromEntries(
              Object.entries(t.parameters.properties ?? {}).map(([k, v]) => [
                k, { type: v.type, description: v.description },
              ]),
            ),
            required: t.parameters.required,
          },
        }));
        return respond({ tools });
      }

      case 'tools/call': {
        const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        if (!params?.name) return error(-32602, 'Missing tool name');

        try {
          const result = await this.registry.dispatch(params.name, params.arguments ?? {});
          return respond({ content: [{ type: 'text', text: result }] });
        } catch (err) {
          return respond({
            content: [{ type: 'text', text: `Tool error: ${(err as Error).message}` }],
            isError: true,
          });
        }
      }

      case 'ping':
        return respond({});

      default:
        return error(-32601, `Method not found: ${req.method}`);
    }
  }
}
