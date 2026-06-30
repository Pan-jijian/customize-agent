import { describe, expect, it } from 'vitest';
import type { ChatOptions, ILLMProvider } from '@customize-agent/llm';
import { DEFAULT_CAPABILITIES } from '@customize-agent/llm';
import type { LLMResponse, Message, StreamChunk } from '@customize-agent/types';
import { ToolRegistry } from '../src/tools/registry.js';
import { runToolLoop } from '../src/core/tool-loop-runner.js';

class FakeProvider implements ILLMProvider {
  readonly name = 'fake';
  readonly modelName = 'fake-model';
  readonly capabilities = DEFAULT_CAPABILITIES;
  private calls = 0;

  async chat(_messages: Message[], _options?: ChatOptions): Promise<LLMResponse> {
    this.calls++;
    if (this.calls === 1) {
      return {
        content: '需要调用工具',
        toolCalls: [{ id: '1', name: 'echo', arguments: { text: 'hello' } }],
        usage: { promptTokens: 10, completionTokens: 2 },
      };
    }
    return { content: '完成', usage: { promptTokens: 12, completionTokens: 3 } };
  }

  async chatStream(_messages: Message[], _onChunk: (chunk: StreamChunk) => void, _options?: ChatOptions): Promise<LLMResponse> {
    return this.chat(_messages, _options);
  }

  async countTokens(messages: Message[]): Promise<number> {
    return messages.length;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

describe('runToolLoop', () => {
  it('应执行 LLM 工具循环并把工具结果写回消息', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'echo text',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'text' } }, required: ['text'], additionalProperties: false },
      requiresApproval: false,
      capabilities: ['read_code'],
      handler: async args => `echo:${String(args.text)}`,
    });

    const messages: Message[] = [{ role: 'user', content: 'run echo' }];
    const result = await runToolLoop({ provider: new FakeProvider(), registry, messages, maxLoops: 3 });

    expect(result.finishReason).toBe('completed');
    expect(result.totalTokens).toBe(27);
    expect(result.messages.some(message => message.role === 'tool' && message.content === 'echo:hello')).toBe(true);
  });
});
