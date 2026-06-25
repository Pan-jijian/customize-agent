/** MCP JSON-RPC 2.0 共享类型与工具函数。mcp-client + mcp-server 共用。 */

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 响应 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 构建成功响应 */
export function jsonRpcResult(id: number | string, result?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** 构建错误响应 */
export function jsonRpcError(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** 序列化 JSON-RPC 请求 */
export function jsonRpcSerialize(method: string, params: unknown, id: number | string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

/**
 * 按换行分割缓冲，返回完整的 JSON 行和剩余缓冲。
 * 用于 stdin/stdout 行分隔 JSON-RPC 传输。
 */
export function splitJsonLines(buffer: string): { lines: string[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  return { lines, rest };
}
