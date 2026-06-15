import type { ILLMProvider, StreamChunk, FunctionDefinition } from '@code-agent/llm';
import type { ToolRegistry, PermissionEngine, ExecutionController } from '@code-agent/engine';
import type { Message, ToolCall } from '@code-agent/types';
import { AUTONOMOUS_SYSTEM_PROMPT } from './prompt.js';

/** 工具中文名映射 */
const TOOL_CN: Record<string, string> = {
  search_symbol: '搜索代码符号',
  read_file: '读取文件',
  list_files: '列出目录',
  modify_file: '修改文件',
  execute_command: '执行终端命令',
  git_status: '查看 Git 状态',
  git_diff: '查看 Git 变更',
  git_commit: '提交 Git 变更',
};

function cn(toolName: string): string { return TOOL_CN[toolName] ?? toolName; }

/** 工具审批回调 */
export type ApprovalHandler = (toolName: string, args: Record<string, unknown>) => Promise<boolean>;

export interface RunTaskOptions { readonly?: boolean; }

export interface ExecutorConfig {
  provider: ILLMProvider;
  registry: ToolRegistry;
  permissionEngine?: PermissionEngine;
  controller?: ExecutionController;
  approvalHandler?: ApprovalHandler;
  maxIterations?: number;
  stream?: boolean;
}

export class AgentExecutor {
  private provider: ILLMProvider;
  private registry: ToolRegistry;
  private permissionEngine?: PermissionEngine;
  private controller?: ExecutionController;
  private approvalHandler?: ApprovalHandler;
  private maxIterations: number;
  private stream: boolean;
  private systemPrompt: string;

  constructor(config: ExecutorConfig) {
    this.provider = config.provider;
    this.registry = config.registry;
    this.permissionEngine = config.permissionEngine;
    this.controller = config.controller;
    this.approvalHandler = config.approvalHandler;
    this.maxIterations = config.maxIterations ?? 200;
    this.stream = config.stream ?? true;
    this.systemPrompt = AUTONOMOUS_SYSTEM_PROMPT;
  }

  getSystemPrompt(): string { return this.systemPrompt; }
  get providerName(): string { return `${this.provider.name}/${this.provider.modelName}`; }

  async runTask(messages: Message[], options?: RunTaskOptions): Promise<Message[]> {
    const working = [...messages];
    const readonly = options?.readonly ?? false;

    const allTools = this.registry.listAll();
    const filteredTools = readonly
      ? allTools.filter(t => !t.requiresApproval && !t.capabilities.includes('write_code'))
      : allTools;

    const tools: FunctionDefinition[] = filteredTools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as FunctionDefinition['parameters'],
    }));

    for (let round = 1; round <= this.maxIterations; round++) {
      const response = await this._callLLM(working, tools);
      const assistantMsg: Message = { role: 'assistant', content: response.content, toolCalls: response.toolCalls };
      working.push(assistantMsg);

      if (!response.toolCalls?.length) {
        if (response.content.includes('<task_finish>')) {
          process.stdout.write(`\n${'\x1b[32m'}✓ 任务完成${'\x1b[0m'}\n\n`);
          break;
        }
        continue;
      }

      for (const tc of response.toolCalls) {
        const toolResult = await this._executeTool(tc);
        working.push({ role: 'tool', content: toolResult, toolCallId: tc.id });
      }

      if (this.controller) {
        const lastTc = response.toolCalls[response.toolCalls.length - 1]!;
        const lastResult = working[working.length - 1]?.content ?? '';
        const evalResult = await this.controller.evaluate(
          round, lastTc.name, lastResult, '',
          { hasTaskFinishTag: response.content.includes('<task_finish>') },
        );
        if (evalResult.action === 'stop' || evalResult.action === 'replan') {
          process.stdout.write(`\n${'\x1b[33m'}⚠ ${evalResult.reason}${'\x1b[0m'}\n\n`);
          break;
        }
      }
    }

    return working;
  }

  private async _callLLM(
    messages: Message[],
    tools: FunctionDefinition[],
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    if (this.stream) return this._streamChat(messages, tools);
    process.stdout.write('\x1b[2m思考中...\x1b[0m');
    const response = await this.provider.chat(messages, { tools });
    process.stdout.write('\r\x1b[2K');
    // 过滤 <task_finish> 标签显示
    const displayContent = response.content.replace(/<task_finish>[\s\S]*?<\/task_finish>/g, '').trim();
    if (displayContent) process.stdout.write(displayContent + '\n');
    return { content: response.content, toolCalls: response.toolCalls };
  }

  private async _streamChat(
    messages: Message[],
    tools: FunctionDefinition[],
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    let content = '';
    let thinkingContent = '';
    const toolCalls: ToolCall[] = [];
    let firstContent = true;
    let firstThink = true;
    // 过滤 <task_finish> 标签
    let tagBuf = '';
    let inTag = false;

    const writeContent = (text: string) => {
      // 过滤 <task_finish>...</task_finish> 标签
      for (const ch of text) {
        tagBuf += ch;
        if (!inTag && tagBuf.endsWith('<task_finish>')) {
          // 回退已输出的标签部分
          const tagLen = '<task_finish>'.length;
          const clean = tagBuf.slice(0, -tagLen);
          if (clean) process.stdout.write(clean);
          tagBuf = ''; inTag = true;
        } else if (inTag && tagBuf.endsWith('</task_finish>')) {
          tagBuf = ''; inTag = false;
        } else if (!inTag && tagBuf.length > 13) {
          // 缓冲足够大且不在标签内，安全输出
          process.stdout.write(tagBuf.slice(0, -13));
          tagBuf = tagBuf.slice(-13);
        }
      }
    };

    const flushTagBuf = () => {
      if (!inTag && tagBuf) process.stdout.write(tagBuf);
      tagBuf = ''; inTag = false;
    };

    await this.provider.chatStream(messages, (chunk: StreamChunk) => {
      switch (chunk.type) {
        case 'content':
          if (firstContent) { process.stdout.write('\n'); firstContent = false; }
          writeContent(chunk.text);
          content += chunk.text;
          break;
        case 'thinking':
          if (firstThink) { process.stdout.write(`\n\x1b[90m💭 思考中...\x1b[0m\n`); firstThink = false; }
          process.stdout.write(`\x1b[90m${chunk.text}\x1b[0m`);
          thinkingContent += chunk.text;
          break;
        case 'tool_call':
          toolCalls.push(chunk.call);
          break;
        case 'reset':
          process.stdout.write('\x1b[1G\x1b[2K');
          content = ''; thinkingContent = ''; toolCalls.length = 0; firstContent = true; firstThink = true;
          tagBuf = ''; inTag = false;
          break;
        case 'done':
          flushTagBuf();
          if (content || toolCalls.length) process.stdout.write('\n');
          break;
      }
    }, { tools });

    // 清理 content 中的 <task_finish> 标签
    content = content.replace(/<task_finish>[\s\S]*?<\/task_finish>/g, '').trim();

    return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
  }

  private async _executeTool(tc: ToolCall): Promise<string> {
    const name = tc.name;
    const args = tc.arguments;
    const label = cn(name);

    // 权限检查
    if (this.permissionEngine) {
      const perm = this.permissionEngine.check(name, args);
      if (perm === 'deny') return `[安全策略禁止] ${label}`;
      if (perm === 'ask') {
        if (this.approvalHandler) {
          const ok = await this.approvalHandler(name, args);
          if (!ok) return `[用户取消] ${label}`;
        } else {
          return `[缺少审批处理器] ${label}`;
        }
      }
    }

    // 工具执行中
    if (this.stream) {
      process.stdout.write(`${'\x1b[90m'}  ${label}...${'\x1b[0m'}\n`);
    }

    try {
      const result = await this.registry.dispatch(name, args);
      if (result.length > 3000) {
        return result.slice(0, 2900) + `\n...[截断 ${result.length - 3000} 字符]`;
      }
      return result;
    } catch (err) {
      return `[${label} 异常]: ${(err as Error).message}`;
    }
  }
}
