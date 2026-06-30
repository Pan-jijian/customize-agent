import type { ILLMProvider } from '@customize-agent/llm';
import { estimateCostUsd } from '@customize-agent/llm';
import { formatToolErrorForModel, type FunctionDefinition, type Message, type ToolCall } from '@customize-agent/types';
import type { ToolRegistry } from '../tools/registry.js';
import type { ExecutionController } from './execution-controller.js';

export interface ToolLoopRunOptions {
  provider: ILLMProvider;
  registry: ToolRegistry;
  messages: Message[];
  tools?: FunctionDefinition[];
  maxLoops: number;
  temperature?: number;
  controller?: ExecutionController;
  signal?: AbortSignal;
  taskGoal?: string;
  truncateResult?: (toolName: string, result: string) => string;
  onResponse?: (response: { content: string; toolCalls?: ToolCall[]; usage?: { promptTokens: number; completionTokens: number } }, round: number) => void;
  onToolResult?: (toolCall: ToolCall, result: string, round: number) => void;
}

export interface ToolLoopRunResult {
  messages: Message[];
  finishReason: 'completed' | 'max_loops' | 'stopped' | 'aborted';
  summary: string;
  totalTokens: number;
  totalCostUsd: number;
  rounds: number;
}

export function buildToolDefinitions(registry: ToolRegistry): FunctionDefinition[] {
  return registry.listAll().map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as FunctionDefinition['parameters'],
  }));
}

export async function runToolLoop(options: ToolLoopRunOptions): Promise<ToolLoopRunResult> {
  const messages = options.messages;
  const tools = options.tools ?? buildToolDefinitions(options.registry);
  const controller = options.controller;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let rounds = 0;

  for (let round = 1; round <= options.maxLoops; round++) {
    if (options.signal?.aborted) return { messages, finishReason: 'aborted', summary: 'Aborted', totalTokens, totalCostUsd, rounds };
    rounds = round;

    const response = await options.provider.chat(messages, {
      temperature: options.temperature,
      tools,
      signal: options.signal,
    });
    options.onResponse?.(response, round);

    if (response.usage) {
      const roundTokens = response.usage.promptTokens + response.usage.completionTokens;
      totalTokens += roundTokens;
      const roundCost = estimateCostUsd(options.provider, response.usage);
      totalCostUsd += roundCost;
    }

    messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

    if (!response.toolCalls?.length) {
      return { messages, finishReason: 'completed', summary: response.content || 'Completed', totalTokens, totalCostUsd, rounds };
    }

    for (const toolCall of response.toolCalls) {
      if (options.signal?.aborted) return { messages, finishReason: 'aborted', summary: 'Aborted', totalTokens, totalCostUsd, rounds };
      let result: string;
      try {
        result = await options.registry.dispatch(toolCall.name, toolCall.arguments, { signal: options.signal });
        result = options.truncateResult?.(toolCall.name, result) ?? result;
      } catch (err) {
        if (options.signal?.aborted || (err as Error).name === 'AbortError') {
          return { messages, finishReason: 'aborted', summary: 'Aborted', totalTokens, totalCostUsd, rounds };
        }
        result = formatToolErrorForModel({ toolName: toolCall.name, args: toolCall.arguments, error: err as Error });
      }

      controller?.recordToolCall(toolCall.name, toolCall.arguments, result);
      options.onToolResult?.(toolCall, result, round);
      messages.push({ role: 'tool', content: result, toolCallId: toolCall.id });

      if (controller) {
        const evalResult = await controller.evaluate(round, toolCall.name, result, options.taskGoal ?? '', {
          hasTaskFinishTag: response.content.includes('<task_finish>'),
        });
        if (evalResult.action === 'stop' || evalResult.action === 'replan') {
          return { messages, finishReason: 'stopped', summary: evalResult.reason, totalTokens, totalCostUsd, rounds };
        }
      }
    }
  }

  return { messages, finishReason: 'max_loops', summary: `达到最大循环次数 (${options.maxLoops} 轮)`, totalTokens, totalCostUsd, rounds };
}
