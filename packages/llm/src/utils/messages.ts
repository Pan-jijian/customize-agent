import type OpenAI from 'openai';
import type { Message, FunctionDefinition } from '@customize-agent/types';

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

/** 将内部 FunctionDefinition[] 转为 OpenAI tools 格式 */
export function toOpenAITools(
  tools: FunctionDefinition[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
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

