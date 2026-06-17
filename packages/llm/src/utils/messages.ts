import type OpenAI from 'openai';
import type { Message } from '@code-agent/types';

/** 将内部 Message 数组转为 OpenAI SDK 兼容的消息格式 */
export function toOpenAIMessages(
  messages: Message[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map(m => {
    // tool 角色 + tool_call_id → tool 消息
    if (m.role === 'tool' && m.toolCallId) {
      return { role: 'tool' as const, tool_call_id: m.toolCallId, content: m.content };
    }
    // assistant 角色 + toolCalls → 带 function call 历史的 assistant 消息
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant' as const,
        content: m.content || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role as 'system' | 'user' | 'assistant', content: m.content };
  });
}

/** OpenAI SDK 通用健康检查：调用 models.list 验证 API 连通性 */
export async function openAIHealthCheck(client: OpenAI): Promise<boolean> {
  try {
    const result = await client.models.list();
    return result.data.length > 0;
  } catch {
    return false;
  }
}

/** 已知二进制文件扩展名（read_file 不可读取） */
export const BINARY_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg',
  'woff', 'woff2', 'ttf', 'eot',
  'db', 'db-shm', 'db-wal', 'lock', 'log', 'map',
  'min.js', 'min.css',
  'docx', 'xlsx', 'pptx',
  'zip', 'tar', 'gz', 'bz2', '7z',
  'mp3', 'mp4', 'avi', 'mov', 'webm', 'webp',
  'wasm',
]);
