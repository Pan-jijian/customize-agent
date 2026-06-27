import type { ILLMProvider, StreamChunk, FunctionDefinition } from '@customize-agent/llm';
import type { ToolRegistry, PermissionEngine, ExecutionController, ContextManager } from '@customize-agent/engine';
import { ContextManager as ContextManagerImpl } from '@customize-agent/engine';
import type { Message, ToolCall } from '@customize-agent/types';
import type { I18nManager } from '../i18n/manager.js';
import { buildSystemPrompt } from './prompt.js';
import { t, taskComplete, taskWarning, toolCallStart, toolCallEnd, renderDiff, contextCompacting, contextCompacted, contextStats, spinnerStart } from '../tui/renderer.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/** 不截断输出的工具（完整内容保留） */
const NO_TRUNCATE_TOOLS = new Set(['read_file', 'list_files', 'search']);
const CMD_OUTPUT_LIMIT = 5000;
const OTHER_OUTPUT_LIMIT = 8000;

/** 工具审批回调 */
export type ApprovalHandler = (toolName: string, args: Record<string, unknown>) => Promise<boolean>;

export interface RunTaskOptions { readonly?: boolean; }

export interface ExecutorConfig {
  provider: ILLMProvider;
  registry: ToolRegistry;
  permissionEngine?: PermissionEngine;
  controller?: ExecutionController;
  contextManager?: ContextManager;
  approvalHandler?: ApprovalHandler;
  i18n?: I18nManager;
  projectRoot?: string;
  repoMap?: string;
  maxIterations?: number;
  stream?: boolean;
}

export class AgentExecutor {
  private provider: ILLMProvider;
  private registry: ToolRegistry;
  private permissionEngine?: PermissionEngine;
  private controller?: ExecutionController;
  private contextManager: ContextManager;
  private approvalHandler?: ApprovalHandler;
  private i18n: I18nManager | undefined;
  private projectRoot: string;
  private repoMap: string | undefined;
  private maxIterations: number;
  private stream: boolean;

  constructor(config: ExecutorConfig) {
    this.provider = config.provider;
    this.registry = config.registry;
    this.permissionEngine = config.permissionEngine;
    this.controller = config.controller;
    this.contextManager = config.contextManager ?? new ContextManagerImpl();
    this.approvalHandler = config.approvalHandler;
    this.i18n = config.i18n;
    this.projectRoot = config.projectRoot ?? process.cwd();
    this.repoMap = config.repoMap;
    this.maxIterations = config.maxIterations ?? 200;
    this.stream = config.stream ?? true;
  }

  getSystemPrompt(): string {
    const customizePath = resolve(this.projectRoot, 'CUSTOMIZE.md');
    const content = existsSync(customizePath) ? readFileSync(customizePath, 'utf-8') : undefined;
    return buildSystemPrompt(content, this.repoMap);
  }
  get providerName(): string { return `${this.provider.name}/${this.provider.modelName}`; }

  /** 最后一次 LLM 调用消耗的 prompt token 数 */
  private _lastPromptTokens = 0;

  getContextStats(): { tokens: number; limit: number } {
    return { tokens: this._lastPromptTokens, limit: this.provider.capabilities.maxContextTokens };
  }

  /** 手动触发压缩（/compact 命令），返回是否执行了压缩 */
  async compactContext(working: Message[]): Promise<boolean> {
    const limit = this.provider.capabilities.maxContextTokens;
    const before = this._lastPromptTokens;
    if (!this.contextManager.shouldWarn(before, limit)) return false;
    process.stdout.write(contextCompacting(this.i18n?.t('context.compacting', { pct: String(Math.round(before / limit * 100)), usedK: String(Math.round(before / 1000)), limitK: String(Math.round(limit / 1000)) }) ?? '…'));
    const { newTokens } = await this.contextManager.compactMessages(working, this.provider, before);
    process.stdout.write(contextCompacted(this.i18n?.t('context.compacted', { removedK: String(Math.round((before - newTokens) / 1000)), currentK: String(Math.round(newTokens / 1000)) }) ?? '✓'));
    this._lastPromptTokens = newTokens;
    return true;
  }

  async runTask(messages: Message[], options?: RunTaskOptions): Promise<Message[]> {
    const working = [...messages];
    const readonly = options?.readonly ?? false;

    const allTools = this.registry.listAll();
    const filteredTools = readonly
      ? allTools.filter(tool => !tool.requiresApproval && !tool.capabilities.includes('write_code'))
      : allTools;

    const tools: FunctionDefinition[] = filteredTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as FunctionDefinition['parameters'],
    }));

    for (let round = 1; round <= this.maxIterations; round++) {
      // ── 每轮主动检查上下文 ──
      await this._maybeCompact(working);

      const response = await this._callLLM(working, tools);
      // 记录真实 token 使用量
      if (response.usage) this._lastPromptTokens = response.usage.promptTokens;

      const assistantMsg: Message = { role: 'assistant', content: response.content, toolCalls: response.toolCalls };
      working.push(assistantMsg);

      const hasFinishTag = response.content.includes('<task_finish>');

      if (!response.toolCalls?.length) {
        if (hasFinishTag) {
          const m = response.content.match(/<task_finish>([\s\S]*?)<\/task_finish>/);
          let summary = m?.[1]?.trim() || '';
          if (summary.length > 120) summary = summary.slice(0, 117) + '...';
          process.stdout.write(taskComplete(this.i18n?.t('status.task_complete'), summary || undefined));
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

  /** 每轮水位检查：60% 警告 → 75% 轻量裁剪 → 85% LLM 摘要（委托给 ContextManager） */
  private async _maybeCompact(working: Message[]): Promise<void> {
    const limit = this.provider.capabilities.maxContextTokens;
    const tokens = this._lastPromptTokens;
    const ctxMgr = this.contextManager;

    if (ctxMgr.shouldWarn(tokens, limit)) {
      if (tokens > limit * 0.85 || tokens > limit * 0.75) {
        process.stdout.write(contextCompacting(this.i18n?.t('context.compacting', { pct: String(Math.round(tokens / limit * 100)), usedK: String(Math.round(tokens / 1000)), limitK: String(Math.round(limit / 1000)) }) ?? '…'));
        const { didCompact, newTokens } = await ctxMgr.compactMessages(working, this.provider, tokens);
        if (didCompact) {
          this._lastPromptTokens = newTokens;
          process.stdout.write(contextCompacted(this.i18n?.t('context.compacted', { removedK: String(Math.round((tokens - newTokens) / 1000)), currentK: String(Math.round(newTokens / 1000)) }) ?? '✓'));
        }
      } else {
        process.stdout.write(contextStats(tokens, limit, this.i18n?.t('context.usage')) + '\n');
      }
    }
  }

  private async _callLLM(
    messages: Message[],
    tools: FunctionDefinition[],
  ): Promise<{ content: string; toolCalls?: ToolCall[]; usage?: { promptTokens: number; completionTokens: number } }> {
    if (this.stream) return this._streamChat(messages, tools);
    const stop = spinnerStart(this.i18n?.t('stream.thinking'));
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
    const stopSpinner = spinnerStart(this.i18n?.t('stream.thinking'));
    let spinnerStopped = false;
    let firstThink = true;
    // <task_finish> 标签过滤缓冲区（仅用于展示过滤，不影响 content 累积）
    const TAG_LEN = '<task_finish>'.length; // 13
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
          const clean = tagBuf.slice(0, -TAG_LEN);
          if (clean) process.stdout.write(clean);
          tagBuf = ''; inTag = true;
        } else if (inTag && tagBuf.endsWith('</task_finish>')) {
          tagBuf = ''; inTag = false;
        } else if (!inTag && tagBuf.length > TAG_LEN) {
          // 缓冲足够大且确认不在标签内，安全输出前缀
          process.stdout.write(tagBuf.slice(0, -TAG_LEN));
          tagBuf = tagBuf.slice(-TAG_LEN);
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
    const label = this.i18n?.toolLabel(name) ?? name;

    // 权限检查
    if (this.permissionEngine) {
      const perm = this.permissionEngine.check(name, args);
      if (perm === 'deny') return this.i18n?.t('executor.security_policy_deny', { label }) ?? `[Denied] ${label}`;
      if (perm === 'ask') {
        if (this.approvalHandler) {
          const ok = await this.approvalHandler(name, args);
          if (!ok) return this.i18n?.t('executor.user_cancelled', { label }) ?? `[Cancelled] ${label}`;
        } else {
          return this.i18n?.t('executor.missing_approval_handler', { label }) ?? `[No approval handler] ${label}`;
        }
      }
    }

    // 工具执行指示
    if (this.stream) {
      process.stdout.write(toolCallStart(name, args) + '\n');
    }

    try {
      const result = await this.registry.dispatch(name, args);
      // 记录工具调用（供死循环检测使用）
      this.controller?.recordToolCall(name, args, result);
      // 展示 diff 预览（modify_file）或首行摘要（其他工具）
      if (this.stream && result) {
        const preview = name === 'write_file'
          ? renderDiff(result)
          : `  ${t.subtle('│')} ${t.dim(result.split('\n')[0]?.slice(0, 100) || '')}`;
        if (preview.trim()) process.stdout.write(preview + '\n');
      }
      // 分级截断：只读/修改工具保留完整内容，命令输出限长
      const limit = name === 'execute_command' ? CMD_OUTPUT_LIMIT : NO_TRUNCATE_TOOLS.has(name) ? Infinity : OTHER_OUTPUT_LIMIT;
      const truncated = result.length > limit
        ? result.slice(0, limit - 100) + (this.i18n?.t('executor.truncated', { count: String(result.length - limit) }) ?? `\n...[Truncated ${result.length - limit} chars]`)
        : result;
      if (this.stream) {
        process.stdout.write(toolCallEnd('success') + '\n');
      }
      return truncated;
    } catch (err) {
      const errMsg = (err as Error).message;
      this.controller?.recordToolCall(name, args, this.i18n?.t('executor.exception', { msg: errMsg }) ?? `[Exception]: ${errMsg}`);
      if (this.stream) {
        process.stdout.write(toolCallEnd('error', errMsg) + '\n');
      }
      return `[${label}]: ${(this.i18n?.t('common.error') ?? 'Error')} - ${errMsg}`;
    }
  }
}
