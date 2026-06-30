import { describe, expect, it } from 'vitest';
import type { ChatOptions, ILLMProvider } from '@customize-agent/llm';
import { DEFAULT_CAPABILITIES } from '@customize-agent/llm';
import { ToolRegistry, PermissionEngine } from '@customize-agent/engine';
import type { LLMResponse, Message, StreamChunk } from '@customize-agent/types';
import { AgentExecutor } from './executor.js';

class ToolCallingProvider implements ILLMProvider {
  readonly name = 'fake';
  readonly modelName = 'fake-model';
  readonly capabilities = DEFAULT_CAPABILITIES;
  private calls = 0;

  async chat(_messages: Message[], _options?: ChatOptions): Promise<LLMResponse> {
    this.calls++;
    if (this.calls === 1) {
      return { content: 'call tool', toolCalls: [{ id: '1', name: 'read_file', arguments: { input: 'README.md' } }], usage: { promptTokens: 10, completionTokens: 2 } };
    }
    return { content: 'done', usage: { promptTokens: 10, completionTokens: 1 } };
  }

  async chatStream(_messages: Message[], _onChunk: (chunk: StreamChunk) => void, _options?: ChatOptions): Promise<LLMResponse> {
    return this.chat(_messages, _options);
  }

  async countTokens(messages: Message[]): Promise<number> { return messages.length; }
  async healthCheck(): Promise<boolean> { return true; }
}

function createRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    name: 'read_file',
    description: 'read file',
    parameters: { type: 'object', properties: { input: { type: 'string', description: 'path' } }, required: ['input'], additionalProperties: false },
    requiresApproval: false,
    capabilities: ['read_code'],
    handler: async args => `read:${String(args.input)}`,
  });
  registry.register({
    name: 'write_file',
    description: 'write file',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } }, required: ['path'], additionalProperties: false },
    requiresApproval: true,
    capabilities: ['write_code'],
    handler: async () => 'written',
  });
  return registry;
}

describe('AgentExecutor', () => {
  it('应执行非流式工具循环并保留工具结果', async () => {
    const executor = new AgentExecutor({
      provider: new ToolCallingProvider(),
      registry: createRegistry(),
      stream: false,
      onWrite: () => undefined,
    });

    const result = await executor.runTask([{ role: 'user', content: '读取文件' }]);

    expect(result.some(message => message.role === 'tool' && message.content === 'read:README.md')).toBe(true);
    expect(result.at(-1)?.content).toBe('done');
  });

  it('只读模式应过滤需要审批的写工具', async () => {
    const executor = new AgentExecutor({
      provider: new ToolCallingProvider(),
      registry: createRegistry(),
      permissionEngine: new PermissionEngine(),
      stream: false,
      onWrite: () => undefined,
    });

    const result = await executor.runTask([{ role: 'user', content: '读取文件' }], { readonly: true });

    expect(result.some(message => message.role === 'tool')).toBe(true);
  });
});
