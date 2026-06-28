import type { ILLMProvider, StreamChunk, FunctionDefinition } from '@customize-agent/llm';
import type { ToolRegistry, PermissionEngine, ExecutionController, ContextManager } from '@customize-agent/engine';
import { ContextManager as ContextManagerImpl } from '@customize-agent/engine';
import type { Message, ToolCall } from '@customize-agent/types';
import type { I18nManager } from '../i18n/manager.js';
import { buildSystemPrompt } from './prompt.js';
import { t, taskWarning, toolCallFold, toolCallFolding, renderMarkdown, contextCompacting, contextCompacted, contextStats, spinnerStart, thinkingSpinner, extractThinkingSubtitle } from '../tui/renderer.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/** 不截断输出的工具（完整内容保留） */
const NO_TRUNCATE_TOOLS = new Set(['read_file', 'list_files', 'search']);
const CMD_OUTPUT_LIMIT = 5000;
const OTHER_OUTPUT_LIMIT = 8000;

/** 工具审批回调 */
export type ApprovalHandler = (toolName: string, args: Record<string, unknown>) => Promise<boolean>;

export interface RunTaskOptions { readonly?: boolean; onWrite?: (text: string) => void; }

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
  /** Ink 渲染回调：替代 process.stdout.write */
  onWrite?: (text: string) => void;
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
  private onWrite?: (text: string) => void;
  /** 最近一次 thinking 完整内容（ctrl+o 展开用） */
  private _lastThinkingContent = '';
  get lastThinkingContent(): string { return this._lastThinkingContent; }

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
    this.onWrite = config.onWrite;
  }

  getSystemPrompt(): string {
    const customizePath = resolve(this.projectRoot, 'CUSTOMIZE.md');
    const content = existsSync(customizePath) ? readFileSync(customizePath, 'utf-8') : undefined;
    return buildSystemPrompt(content, this.repoMap);
  }
  get providerName(): string { return `${this.provider.name}/${this.provider.modelName}`; }

  /** 从 tool args 提取文件路径或首参数用于折叠摘要 */
  private _formatArg(args?: Record<string, unknown>): string {
    if (!args) return '';
    const val = args.path ?? args.query ?? args.pattern ?? args.filePath ?? args.command ?? args.input;
    if (typeof val !== 'string' || val.length === 0) return '';
    if (val.length <= 50) return val;
    // shell 命令不缩略
    if (args.command || args.input) return val.slice(0, 47) + '...';
    // 长文件路径：保留最后 2 层
    const parts = val.split('/');
    if (parts.length > 2) return '…/' + parts.slice(-2).join('/');
    return val.slice(0, 47) + '...';
  }

  /** 统一输出：onWrite 回调优先，否则 process.stdout */
  private _write(text: string): void {
    if (this.onWrite) { this.onWrite(text); } else { process.stdout.write(text); }
  }

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
    // 临时覆盖 onWrite（options 优先级高于 config）
    const prevOnWrite = this.onWrite;
    if (options?.onWrite) this.onWrite = options.onWrite;
    try {

    const allTools = this.registry.listAll();
    const filteredTools = readonly
      ? allTools.filter(tool => !tool.requiresApproval && !tool.capabilities.includes('write_code'))
      : allTools;

    const tools: FunctionDefinition[] = filteredTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as FunctionDefinition['parameters'],
    }));

    let totalPrompt = 0;
    let totalCompletion = 0;
    let tokenSummaryShown = false;
    let lastRound = 0;
    const taskStartMs = Date.now();
    const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}K`;

    const showTokenSummary = () => {
      if (tokenSummaryShown || totalPrompt === 0) return;
      tokenSummaryShown = true;
      const elapsed = ((Date.now() - taskStartMs) / 1000).toFixed(1);
      const pLabel = this.i18n?.t('token.prompt') ?? 'prompt';
      const oLabel = this.i18n?.t('token.output') ?? 'output';
      const rLabel = this.i18n?.t('token.rounds') ?? 'rounds';
      process.stdout.write(`  ${t.faint(`${fmt(totalPrompt)} ${pLabel} · ${fmt(totalCompletion)} ${oLabel} · ${lastRound} ${rLabel} · ${elapsed}s`)}\n`);
    };

    for (let round = 1; round <= this.maxIterations; round++) {
      lastRound = round;
      // ── 每轮主动检查上下文 ──
      await this._maybeCompact(working);

      const response = await this._callLLM(working, tools);
      // 累加 token（任务结束时统一输出一行汇总）
      if (response.usage) {
        this._lastPromptTokens = response.usage.promptTokens;
        totalPrompt += response.usage.promptTokens;
        totalCompletion += response.usage.completionTokens ?? 0;
      }

      const assistantMsg: Message = { role: 'assistant', content: response.content, toolCalls: response.toolCalls };
      working.push(assistantMsg);

      // 仅当 content 末尾有完整闭合的 <task_finish>...</task_finish> 时才视为停止信号
      const hasFinishTag = /<task_finish>[\s\S]*<\/task_finish>\s*$/.test(response.content);

      if (!response.toolCalls?.length) {
        if (hasFinishTag) {
          showTokenSummary();
          break;
        }
        // 模型返回了内容但无工具调用也无完成标签 → 自然结束
        if (!response.content?.trim()) break;
        break;
      }

      // 同类工具折叠（参考 Claude Code collapseReadSearchGroups）
      let foldType = '';
      let foldCount = 0;
      let foldArgs: string[] = [];
      let foldTotalMs = 0;
      let foldDiff = '';
      let foldStartMs = 0;

      const flushFold = () => {
        if (foldCount === 0) return;
        if (this.stream) {
          process.stdout.write('\r\x1b[2K' + toolCallFold(foldType, foldCount, foldArgs, foldTotalMs, foldDiff) + '\n');
        }
        foldType = ''; foldCount = 0; foldArgs = []; foldTotalMs = 0; foldDiff = ''; foldStartMs = 0;
      };

      for (const tc of response.toolCalls) {
        if (tc.name === foldType) {
          foldCount++;
          foldArgs.push(this._formatArg(tc.arguments));
          if (this.stream) {
            process.stdout.write(toolCallFolding(tc.name, foldCount, foldArgs[foldArgs.length - 1]!, Date.now() - foldStartMs));
          }
        } else {
          flushFold();
          foldType = tc.name;
          foldCount = 1;
          foldArgs = [this._formatArg(tc.arguments)];
          foldTotalMs = 0;
          foldStartMs = Date.now();
          if (this.stream) {
            process.stdout.write(toolCallFolding(tc.name, 1, foldArgs[0]!, 0));
          }
        }
        const { result, duration } = await this._executeTool(tc);
        foldTotalMs += duration;
        // write_file 保存 diff 结果供渲染
        if (tc.name === 'write_file' && result) foldDiff = result;
        working.push({ role: 'tool', content: result, toolCallId: tc.id });
      }
      flushFold();

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

    showTokenSummary();
    return working;
  } finally {
    this.onWrite = prevOnWrite;
  }
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
    const opts = { tools };
    if (this.stream) return this._streamChat(messages, tools);
    const spin = spinnerStart(this.i18n?.t('stream.thinking'));
    const response = await this.provider.chat(messages, { ...opts, maxTokens: 32000 });
    spin.stop();
    const displayContent = response.content.replace(/<task_finish>[\s\S]*?<\/task_finish>\n*/g, '').trim();
    if (displayContent) this._write(renderMarkdown(displayContent) + '\n');
    return { content: response.content, toolCalls: response.toolCalls, usage: response.usage };
  }

  private async _streamChat(
    messages: Message[],
    tools: FunctionDefinition[],
  ): Promise<{ content: string; toolCalls?: ToolCall[]; usage?: { promptTokens: number; completionTokens: number } }> {
    let content = '';
    const toolCalls: ToolCall[] = [];
    const spin = spinnerStart(this.i18n?.t('stream.thinking'));
    let spinnerStopped = false;

    // 思考链状态行（参考 Claude Code: 思考内容不入主流，替换为实时状态行）
    const tips = this.i18n?.tList('think.tips') ?? [];
    const think = thinkingSpinner(tips);
    let thinkActive = false;
    let thinkStartMs = 0;
    let thinkTokens = 0;

    const stopSpin = () => {
      if (!spinnerStopped) { spin.stop(); spinnerStopped = true; }
    };

    const flushThink = () => {
      if (!thinkActive) return;
      const elapsed = Date.now() - thinkStartMs;
      think.thinkDone(elapsed, thinkTokens, this.i18n?.t('think.expand_hint') ?? '(ctrl+o to expand thinking)');
      thinkActive = false;
    };

    // ── 段落级流式：完整段落直接输出，当前段落缓冲 ──
    let paraBuf = '';
    let insideTaskFinish = false;

    const response = await this.provider.chatStream(messages, (chunk: StreamChunk) => {
      switch (chunk.type) {
        case 'content':
          stopSpin();
          flushThink();
          content += chunk.text;
          paraBuf += chunk.text;

          // task_finish 状态机
          if (insideTaskFinish) {
            const ei = paraBuf.indexOf('</task_finish>');
            if (ei !== -1) {
              paraBuf = paraBuf.slice(ei + '</task_finish>'.length);
              insideTaskFinish = false;
            } else { paraBuf = ''; }
          } else if (paraBuf.includes('<task_finish>')) {
            const si = paraBuf.indexOf('<task_finish>');
            if (si > 0) process.stdout.write(renderMarkdown(paraBuf.slice(0, si)));
            paraBuf = paraBuf.slice(si + '<task_finish>'.length);
            insideTaskFinish = true;
            const ei = paraBuf.indexOf('</task_finish>');
            if (ei !== -1) {
              paraBuf = paraBuf.slice(ei + '</task_finish>'.length);
              insideTaskFinish = false;
            } else { paraBuf = ''; }
          }

          // flush 完整段落
          while (!insideTaskFinish) {
            const pb = paraBuf.indexOf('\n\n');
            if (pb === -1) break;
            const block = paraBuf.slice(0, pb + 2);
            paraBuf = paraBuf.slice(pb + 2);
            if (block.trim()) process.stdout.write(renderMarkdown(block));
          }
          break;
        case 'thinking':
          stopSpin();
          if (!thinkActive) {
            thinkActive = true;
            thinkStartMs = Date.now();
            thinkTokens = 0;
            this._lastThinkingContent = '';
            think.thinkStart();
          }
          this._lastThinkingContent += chunk.text;
          thinkTokens += Math.ceil(chunk.text.length / 4);
          think.thinkTick(Date.now() - thinkStartMs, thinkTokens, extractThinkingSubtitle(this._lastThinkingContent));
          break;
        case 'tool_call':
          toolCalls.push(chunk.call);
          break;
        case 'reset':
          if (thinkActive) { think.stop(); thinkActive = false; }
          process.stdout.write('\x1b[1G\x1b[2K');
          content = ''; toolCalls.length = 0;
          paraBuf = ''; insideTaskFinish = false;
          break;
        case 'done':
          stopSpin();
          flushThink();
          insideTaskFinish = false;
          if (paraBuf.trim()) process.stdout.write(renderMarkdown(paraBuf));
          paraBuf = '';
          if (content || toolCalls.length) process.stdout.write('\n');
          break;
        case 'error':
          stopSpin();
          if (thinkActive) { think.stop(); thinkActive = false; }
          process.stdout.write(t.error(chunk.message ?? 'Stream error') + '\n');
          break;
      }
    }, { tools, maxTokens: 32000 });

    return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage: response.usage };
  }

  private async _executeTool(tc: ToolCall): Promise<{ result: string; duration: number }> {
    const name = tc.name;
    const args = tc.arguments;
    const label = this.i18n?.toolLabel(name) ?? name;

    // 权限检查
    if (this.permissionEngine) {
      const perm = this.permissionEngine.check(name, args);
      if (perm === 'deny') {
        const msg = this.i18n?.t('executor.security_policy_deny', { label }) ?? `[Denied] ${label}`;
        return { result: msg, duration: 0 };
      }
      if (perm === 'ask') {
        if (this.approvalHandler) {
          const ok = await this.approvalHandler(name, args);
          if (!ok) {
            const msg = this.i18n?.t('executor.user_cancelled', { label }) ?? `[Cancelled] ${label}`;
            return { result: msg, duration: 0 };
          }
        } else {
          const msg = this.i18n?.t('executor.missing_approval_handler', { label }) ?? `[No approval handler] ${label}`;
          return { result: msg, duration: 0 };
        }
      }
    }

    const toolStart = Date.now();
    try {
      const result = await this.registry.dispatch(name, args);
      const duration = Date.now() - toolStart;
      this.controller?.recordToolCall(name, args, result);

      const limit = name === 'execute_command' ? CMD_OUTPUT_LIMIT : NO_TRUNCATE_TOOLS.has(name) ? Infinity : OTHER_OUTPUT_LIMIT;
      const truncated = result.length > limit
        ? result.slice(0, limit - 100) + (this.i18n?.t('executor.truncated', { count: String(result.length - limit) }) ?? `\n...[Truncated ${result.length - limit} chars]`)
        : result;
      return { result: truncated, duration };
    } catch (err) {
      const errMsg = (err as Error).message;
      const duration = Date.now() - toolStart;
      this.controller?.recordToolCall(name, args, this.i18n?.t('executor.exception', { msg: errMsg }) ?? `[Exception]: ${errMsg}`);
      return { result: `[${label}]: ${(this.i18n?.t('common.error') ?? 'Error')} - ${errMsg}`, duration };
    }
  }
}
