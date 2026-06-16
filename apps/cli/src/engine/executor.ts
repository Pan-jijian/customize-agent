import type { ILLMProvider, StreamChunk, FunctionDefinition } from '@code-agent/llm';
import type { ToolRegistry, PermissionEngine, ExecutionController } from '@code-agent/engine';
import type { Message, ToolCall } from '@code-agent/types';
import { AUTONOMOUS_SYSTEM_PROMPT } from './prompt.js';
import { t, taskComplete, taskWarning, toolCallStart, toolCallEnd, renderDiff, contextCompacting, contextCompacted, contextStats, spinnerStart } from '../tui/renderer.js';

/** 工具中文名映射 */
const TOOL_CN: Record<string, string> = {
  search_symbol: '搜索代码符号',
  read_file: '读取文件',
  list_files: '列出目录',
  modify_file: '修改文件',
  write_file: '创建文件',
  execute_command: '执行终端命令',
  git_status: '查看 Git 状态',
  git_diff: '查看 Git 变更',
  git_commit: '提交 Git 变更',
  web_search: '搜索网络',
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

  // 上下文水位线（占 maxContextTokens 的百分比）
  private static WARN_PCT = 0.60;    // 60%: 打印警告
  private static LIGHT_PCT = 0.75;   // 75%: 轻量裁剪旧 tool 结果
  private static FULL_PCT = 0.85;    // 85%: LLM 摘要压缩

  /** 最后一次 LLM 调用消耗的 prompt token 数 */
  private _lastPromptTokens = 0;

  getContextStats(): { tokens: number; limit: number } {
    return { tokens: this._lastPromptTokens, limit: this.provider.capabilities.maxContextTokens };
  }

  /** 手动触发压缩（/compact 命令），返回是否执行了压缩 */
  async compactContext(working: Message[]): Promise<boolean> {
    const limit = this.provider.capabilities.maxContextTokens;
    const before = this._lastPromptTokens || await this._countTokens(working);
    if (before < limit * AgentExecutor.WARN_PCT) return false;
    process.stdout.write(contextCompacting(before, limit));
    await this._llmCompact(working);
    const after = await this._countTokens(working);
    process.stdout.write(contextCompacted(after, before - after));
    this._lastPromptTokens = after;
    return true;
  }

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
      // ── 每轮主动检查上下文 ──
      await this._maybeCompact(working);

      const response = await this._callLLM(working, tools);
      // 记录真实 token 使用量
      if (response.usage) this._lastPromptTokens = response.usage.promptTokens;

      const assistantMsg: Message = { role: 'assistant', content: response.content, toolCalls: response.toolCalls };
      working.push(assistantMsg);

      const hasFinishTag = response.content.includes('<task_finish');

      if (!response.toolCalls?.length) {
        if (hasFinishTag) {
          const m = response.content.match(/<task_finish>([\s\S]*?)<\/task_finish>/);
          let summary = m?.[1]?.trim() || '';
          if (summary.length > 120) summary = summary.slice(0, 117) + '...';
          process.stdout.write(taskComplete(summary || undefined));
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
          { hasTaskFinishTag: hasFinishTag },
        );
        if (evalResult.action === 'stop' || evalResult.action === 'replan') {
          process.stdout.write(taskWarning(evalResult.reason));
          break;
        }
      }
    }

    return working;
  }

  /** 用 Provider 真实 API 计数 */
  private async _countTokens(msgs: Message[]): Promise<number> {
    try { return await this.provider.countTokens(msgs); }
    catch { return Math.ceil(msgs.reduce((s, m) => s + (m.content?.length ?? 0), 0) / 3); }
  }

  /** 每轮水位检查：60% 警告 → 75% 轻量裁剪 → 85% LLM 摘要 */
  private async _maybeCompact(working: Message[]): Promise<void> {
    const limit = this.provider.capabilities.maxContextTokens;
    const tokens = this._lastPromptTokens || await this._countTokens(working);

    if (tokens > limit * AgentExecutor.FULL_PCT) {
      process.stdout.write(contextCompacting(tokens, limit));
      await this._llmCompact(working);
      const after = await this._countTokens(working);
      this._lastPromptTokens = after;
      process.stdout.write(contextCompacted(after, tokens - after));
    } else if (tokens > limit * AgentExecutor.LIGHT_PCT) {
      process.stdout.write(contextCompacting(tokens, limit));
      this._lightCompact(working);
      const after = await this._countTokens(working);
      this._lastPromptTokens = after;
      process.stdout.write(contextCompacted(after, tokens - after));
    } else if (tokens > limit * AgentExecutor.WARN_PCT) {
      process.stdout.write(contextStats(tokens, limit) + '\n');
    }
  }

  /** 轻量压缩：截断旧 tool 结果到 200 字符，不动用户消息和 assistant 思考 */
  private _lightCompact(working: Message[]): void {
    let TAIL = 8; // 最后 4 轮完整保留
    // 保证 TAIL 从 assistant 开始
    let tailStart = working.length - TAIL;
    while (tailStart > 2 && tailStart < working.length && working[tailStart]?.role !== 'assistant') {
      tailStart++; TAIL++;
    }
    if (tailStart >= working.length) return;
    if (working.length <= TAIL) return;
    for (let i = 2; i < working.length - TAIL; i++) {
      const m = working[i]!;
      // 用户消息永不压缩
      if (m.role === 'user') continue;
      if (m.role === 'tool' && m.content && m.content.length > 200) {
        m.content = m.content.slice(0, 197) + '...';
      }
    }
  }

  /** LLM 摘要压缩：调用模型生成结构化摘要，替换旧消息 */
  private async _llmCompact(working: Message[]): Promise<void> {
    const HEAD = 2;  // system + 首条 user
    let TAIL = 8;    // 最后 4 轮

    // 保证 TAIL 从 assistant 开始（API 要求 tool 消息必须有前置 tool_calls）
    let tailStart = working.length - TAIL;
    while (tailStart > HEAD && tailStart < working.length && working[tailStart]?.role !== 'assistant') {
      tailStart++;
      TAIL++;
    }
    if (tailStart >= working.length) return;

    if (working.length <= HEAD + TAIL) return;

    // 收集中间消息（要压缩的部分），跳过 user 消息（保护）
    const compacted: Message[] = [];
    const protectedUserMsgs: Message[] = [];
    for (let i = HEAD; i < working.length - TAIL; i++) {
      const m = working[i]!;
      if (m.role === 'user') {
        protectedUserMsgs.push(m);
      } else {
        compacted.push(m);
      }
    }

    if (compacted.length === 0) return;

    // 用 LLM 生成摘要
    const compactText = compacted.map(m =>
      `[${m.role}] ${(m.content ?? '').slice(0, 500)}`
    ).join('\n---\n');

    const summaryPrompt: Message[] = [
      { role: 'system', content: '你是一个对话摘要器。将以下 Agent 对话历史压缩为一份结构化摘要，包含：1) 用户任务 2) 已完成操作（工具调用统计）3) 关键发现/决策 4) 待办事项。用中文输出，不超过 800 字。只输出摘要，不要解释。' },
      { role: 'user', content: `请压缩以下对话历史：\n\n${compactText}` },
    ];

    try {
      const res = await this.provider.chat(summaryPrompt);
      const summary = `[上下文压缩] 此前对话已自动总结：\n${res.content.trim()}`;
      const summaryMsg: Message = { role: 'user', content: summary };

      // 替换：system + 首条user + 被保护的用户消息 + 摘要 + 尾部
      const tail = working.splice(working.length - TAIL, TAIL);
      working.splice(HEAD, working.length - HEAD, ...protectedUserMsgs, summaryMsg);
      working.push(...tail);
    } catch {
      // LLM 摘要失败 → 降级到轻量压缩
      this._lightCompact(working);
    }
  }

  private async _callLLM(
    messages: Message[],
    tools: FunctionDefinition[],
  ): Promise<{ content: string; toolCalls?: ToolCall[]; usage?: { promptTokens: number; completionTokens: number } }> {
    if (this.stream) return this._streamChat(messages, tools);
    const stop = spinnerStart();
    const response = await this.provider.chat(messages, { tools });
    stop();
    const displayContent = response.content.replace(/<task_finish>[\s\S]*?<\/task_finish>/g, '').trim();
    if (displayContent) process.stdout.write(displayContent + '\n');
    return { content: response.content, toolCalls: response.toolCalls, usage: response.usage };
  }

  private async _streamChat(
    messages: Message[],
    tools: FunctionDefinition[],
  ): Promise<{ content: string; toolCalls?: ToolCall[]; usage?: { promptTokens: number; completionTokens: number } }> {
    let content = '';
    const toolCalls: ToolCall[] = [];
    // spinner 在第一个 chunk 到达时停止
    const stopSpinner = spinnerStart();
    let spinnerStopped = false;
    let firstThink = true;
    // <task_finish> 标签过滤缓冲区（仅用于展示过滤，不影响 content 累积）
    let tagBuf = '';
    let inTag = false;

    const stopSpin = () => {
      if (!spinnerStopped) { stopSpinner(); spinnerStopped = true; }
    };

    const writeContent = (text: string) => {
      for (const ch of text) {
        tagBuf += ch;
        if (!inTag && tagBuf.endsWith('<task_finish>')) {
          // 回退已输出的标签起始部分
          const tagLen = '<task_finish>'.length;
          const clean = tagBuf.slice(0, -tagLen);
          if (clean) process.stdout.write(clean);
          tagBuf = ''; inTag = true;
        } else if (inTag && tagBuf.endsWith('</task_finish>')) {
          tagBuf = ''; inTag = false;
        } else if (!inTag && tagBuf.length > 13) {
          // 缓冲足够大且确认不在标签内，安全输出前缀
          process.stdout.write(tagBuf.slice(0, -13));
          tagBuf = tagBuf.slice(-13);
        }
      }
    };

    const flushTagBuf = () => {
      if (!inTag && tagBuf) process.stdout.write(tagBuf);
      tagBuf = ''; inTag = false;
    };

    const response = await this.provider.chatStream(messages, (chunk: StreamChunk) => {
      switch (chunk.type) {
        case 'content':
          stopSpin();
          writeContent(chunk.text);
          content += chunk.text;
          break;
        case 'thinking':
          stopSpin();
          if (firstThink) { process.stdout.write('\n'); firstThink = false; }
          process.stdout.write(t.faint(chunk.text));
          break;
        case 'tool_call':
          toolCalls.push(chunk.call);
          break;
        case 'reset':
          process.stdout.write('\x1b[1G\x1b[2K');
          content = ''; toolCalls.length = 0; firstThink = true;
          tagBuf = ''; inTag = false;
          break;
        case 'done':
          stopSpin();
          flushTagBuf();
          if (content || toolCalls.length) process.stdout.write('\n');
          break;
      }
    }, { tools });

    return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage: response.usage };
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

    // 工具执行指示
    if (this.stream) {
      process.stdout.write(toolCallStart(name, args) + '\n');
    }

    try {
      const result = await this.registry.dispatch(name, args);
      // 展示 diff 预览（modify_file）或首行摘要（其他工具）
      if (this.stream && result) {
        const preview = name === 'modify_file'
          ? renderDiff(result)
          : `  ${t.subtle('│')} ${t.dim(result.split('\n')[0]?.slice(0, 100) || '')}`;
        if (preview.trim()) process.stdout.write(preview + '\n');
      }
      // 分级截断：只读/修改工具保留完整内容，命令输出限长
      const NO_TRUNCATE = new Set(['read_file', 'modify_file', 'list_files', 'search_symbol', 'web_search', 'git_status', 'git_diff']);
      const limit = name === 'execute_command' ? 5000 : NO_TRUNCATE.has(name) ? Infinity : 8000;
      const truncated = result.length > limit
        ? result.slice(0, limit - 100) + `\n...[截断 ${result.length - limit} 字符]`
        : result;
      if (this.stream) {
        process.stdout.write(toolCallEnd('success') + '\n');
      }
      return truncated;
    } catch (err) {
      if (this.stream) {
        process.stdout.write(toolCallEnd('error', (err as Error).message) + '\n');
      }
      return `[${label} 异常]: ${(err as Error).message}`;
    }
  }
}
