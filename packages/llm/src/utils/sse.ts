// @customize-agent/llm — 共享 SSE 流式读取工具

/**
 * 异步生成器：从 Response body 中逐行读取 SSE (Server-Sent Events) 行。
 * 处理 ReadableStream 的缓冲和按行拆分。
 */
export async function* streamSSELines(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          yield trimmed.slice(6);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 从 SSE 流中读取完整的 LLM 响应事件。
 * 返回 textContent, thinkingContent, toolCalls, usage 信息。
 */
export interface SSEStreamResult {
  textContent: string;
  thinkingContent: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  promptTokens: number;
  completionTokens: number;
}

/**
 * HTTP 错误处理辅助函数：非 2xx 响应时抛出格式化错误。
 */
export async function assertOk(response: Response, providerName: string): Promise<void> {
  if (!response.ok) {
    const text = await response.text().catch(() => '[unable to read error body]');
    throw new Error(`${providerName} API error (${response.status}): ${text}`);
  }
}
