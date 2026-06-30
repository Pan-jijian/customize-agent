import type { ILLMProvider, FunctionDefinition } from '@customize-agent/llm';
import { estimateCostUsd } from '@customize-agent/llm';
import type { ToolRegistry, PermissionEngine, ExecutionController, ContextManager } from '@customize-agent/engine';
import { ContextManager as ContextManagerImpl, PlanModeManager } from '@customize-agent/engine';
import type { Message, ToolCall } from '@customize-agent/types';
import type { I18nManager } from '../i18n/manager.js';
import { buildSystemPrompt } from './prompt.js';
import { t, taskWarning, toolCallFold, toolCallFolding, renderMarkdown, contextCompacting, contextCompacted, contextStats, spinnerStart, formatDuration } from '../tui/renderer.js';
import { streamChat } from './stream-chat.js';
import { truncateToolResult } from './tool-result.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';


/** 工具审批回调 */
export type ApprovalHandler = (toolName: string, args: Record<string, unknown>) => Promise<boolean>;

export type AgentEvent =
  | { type: 'output'; text: string }
  | { type: 'task_start' }
  | { type: 'task_done' }
  | { type: 'user_message'; text: string }
  | { type: 'tool_call_preview'; toolName: string; args: Record<string, unknown>; elapsedMs?: number }
  | { type: 'approval_request'; toolName: string; args: Record<string, unknown> }
  | { type: 'approval_response'; toolName: string; approved: boolean };

export interface RunTaskOptions {
  readonly?: boolean;
  plan?: boolean;
  onWrite?: (text: string) => void;
  onEvent?: (event: AgentEvent) => void;
  drainUserInput?: () => Array<string | { content: string; display: string }>;
  signal?: AbortSignal;
}

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
  onEvent?: (event: AgentEvent) => void;
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
  private onEvent?: (event: AgentEvent) => void;
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
    this.onEvent = config.onEvent;
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

  /** 统一输出：事件回调优先，否则 process.stdout */
  private _write(text: string): void {
    this.onEvent?.({ type: 'output', text });
    if (this.onWrite) { this.onWrite(text); }
    else if (!this.onEvent) { process.stdout.write(text); }
  }

  private _emit(event: AgentEvent): void {
    this.onEvent?.(event);
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
    this._write(contextCompacting(this.i18n?.t('context.compacting', { pct: String(Math.round(before / limit * 100)), usedK: String(Math.round(before / 1000)), limitK: String(Math.round(limit / 1000)) }) ?? '…'));
    const { newTokens } = await this.contextManager.compactMessages(working, this.provider, before);
    this._write(contextCompacted(this.i18n?.t('context.compacted', { removedK: String(Math.round((before - newTokens) / 1000)), currentK: String(Math.round(newTokens / 1000)) }) ?? '✓'));
    this._lastPromptTokens = newTokens;
    return true;
  }

  async runTask(messages: Message[], options?: RunTaskOptions): Promise<Message[]> {
    if (options?.plan) return this._runPlanTask(messages, options);

    const working = [...messages];
    const readonly = options?.readonly ?? false;
    // 临时覆盖 onWrite（options 优先级高于 config）
    const prevOnWrite = this.onWrite;
    const prevOnEvent = this.onEvent;
    if (options?.onWrite) this.onWrite = options.onWrite;
    if (options?.onEvent) this.onEvent = options.onEvent;
    this._emit({ type: 'task_start' });
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
    const taskGoal = [...working].reverse().find(message => message.role === 'user')?.content ?? '';
    const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}K`;

    const showTokenSummary = () => {
      if (tokenSummaryShown || totalPrompt === 0) return;
      tokenSummaryShown = true;
      const elapsed = formatDuration(Date.now() - taskStartMs);
      const pLabel = this.i18n?.t('token.prompt') ?? 'prompt';
      const oLabel = this.i18n?.t('token.output') ?? 'output';
      const rLabel = this.i18n?.t('token.rounds') ?? 'rounds';
      this._write(`${t.faint(`[${fmt(totalPrompt)} ${pLabel} · ${fmt(totalCompletion)} ${oLabel} · ${lastRound} ${rLabel} · ${elapsed}]`)}\n`);
    };

    const previewedToolCalls = new Set<string>();
    const toolPreviewKeys = (tc: ToolCall) => [tc.name, tc.id].filter(Boolean);
    const wasToolPreviewed = (tc: ToolCall) => toolPreviewKeys(tc).some(key => previewedToolCalls.has(key));
    const markToolPreviewed = (tc: ToolCall) => {
      for (const key of toolPreviewKeys(tc)) previewedToolCalls.add(key);
    };
    const emitToolCallPreview = (tc: ToolCall, elapsedMs = Date.now() - taskStartMs): boolean => {
      if (wasToolPreviewed(tc)) return false;
      markToolPreviewed(tc);
      this._emit({ type: 'tool_call_preview', toolName: tc.name, args: tc.arguments, elapsedMs });
      return true;
    };

    const drainPendingUserInput = () => {
      const injectedInputs = options?.drainUserInput?.() ?? [];
      for (const injected of injectedInputs) {
        const content = typeof injected === 'string' ? injected : injected.content;
        const display = typeof injected === 'string' ? injected : injected.display;
        this._emit({ type: 'user_message', text: display });
        working.push({ role: 'user', content });
      }
      return injectedInputs.length > 0;
    };

    for (let round = 1; round <= this.maxIterations; round++) {
      if (options?.signal?.aborted) break;
      lastRound = round;
      drainPendingUserInput();
      // ── 每轮主动检查上下文 ──
      await this._maybeCompact(working);

      const response = await this._callLLM(working, tools, options?.signal, emitToolCallPreview);
      if (options?.signal?.aborted) break;
      // 累加 token（任务结束时统一输出一行汇总）
      let costThisRound = 0;
      if (response.usage) {
        this._lastPromptTokens = response.usage.promptTokens;
        totalPrompt += response.usage.promptTokens;
        totalCompletion += response.usage.completionTokens ?? 0;
        costThisRound = estimateCostUsd(this.provider, response.usage);
      }

      const assistantMsg: Message = { role: 'assistant', content: response.content, toolCalls: response.toolCalls };
      working.push(assistantMsg);

      if (!response.toolCalls?.length) {
        if (drainPendingUserInput()) continue;
        break;
      }

      // 同类工具折叠（参考 Claude Code collapseReadSearchGroups）
      const previewedBeforeExecution = new Set(previewedToolCalls);
      const wasPreviewedBeforeExecution = (tc: ToolCall) => toolPreviewKeys(tc).some(key => previewedBeforeExecution.has(key));
      let foldType = '';
      let foldCount = 0;
      let foldArgs: string[] = [];
      let foldTotalMs = 0;
      let foldDiff = '';
      let foldStartMs = 0;

      const toolsLabel = this.i18n?.t('tool.count_label') ?? 'tools';
      const toolLabel = (name: string) => this.i18n?.toolLabel(name) ?? name;
      const flushFold = () => {
        if (foldCount === 0) return;
        if (this.stream) {
          this._write('\r\x1b[2K' + toolCallFold(foldType, foldCount, foldArgs, foldTotalMs, foldDiff, toolLabel(foldType), toolsLabel) + '\n');
        }
        foldType = ''; foldCount = 0; foldArgs = []; foldTotalMs = 0; foldDiff = ''; foldStartMs = 0;
      };

      for (const tc of response.toolCalls) {
        if (options?.signal?.aborted) break;
        const previewElapsedMs = Date.now() - taskStartMs;
        const wasPreviewed = wasPreviewedBeforeExecution(tc);
        const renderedPreview = emitToolCallPreview(tc, previewElapsedMs);
        const skipStartRender = wasPreviewed || renderedPreview;
        let preApproved = false;
        if (tc.name === foldType) {
          foldCount++;
          foldArgs.push(this._formatArg(tc.arguments));
          if (this.stream && !skipStartRender) {
            this._write(toolCallFolding(tc.name, foldCount, foldArgs[foldArgs.length - 1]!, Date.now() - foldStartMs, toolLabel(tc.name), toolsLabel));
          }
        } else {
          flushFold();
          foldType = tc.name;
          foldCount = 1;
          foldArgs = [this._formatArg(tc.arguments)];
          foldTotalMs = 0;
          foldStartMs = Date.now();
          if (this.stream && !skipStartRender) {
            this._write(toolCallFolding(tc.name, 1, foldArgs[0]!, previewElapsedMs, toolLabel(tc.name), toolsLabel));
          }
        }
        if (this.permissionEngine?.check(tc.name, tc.arguments) === 'ask' && this.approvalHandler) {
          this._emit({ type: 'approval_request', toolName: tc.name, args: tc.arguments });
          const ok = await this.approvalHandler(tc.name, tc.arguments);
          this._emit({ type: 'approval_response', toolName: tc.name, approved: ok });
          if (options?.signal?.aborted) break;
          if (!ok) {
            const label = toolLabel(tc.name);
            const msg = this.i18n?.t('executor.user_cancelled', { label }) ?? `[Cancelled] ${label}`;
            working.push({ role: 'tool', content: msg, toolCallId: tc.id });
            continue;
          }
          preApproved = true;
        }
        let result = '';
        let duration = 0;
        ({ result, duration } = await this._executeTool(tc, options?.signal, preApproved));
        if (options?.signal?.aborted) break;
        if (this.stream && !skipStartRender) {
          this._write(toolCallFolding(tc.name, foldCount, foldArgs[foldArgs.length - 1]!, Date.now() - foldStartMs, toolLabel(tc.name), toolsLabel));
        }
        foldTotalMs += duration;
        // write_file 保存 diff 结果供渲染
        if (tc.name === 'write_file' && result) foldDiff = result;
        working.push({ role: 'tool', content: result, toolCallId: tc.id });
      }
      if (!options?.signal?.aborted) flushFold();
      if (options?.signal?.aborted) break;

      if (this.controller) {
        const lastTc = response.toolCalls[response.toolCalls.length - 1]!;
        const lastResult = working[working.length - 1]?.content ?? '';
        const evalResult = await this.controller.evaluate(
          round,
          lastTc.name,
          lastResult,
          taskGoal,
          { hasTaskFinishTag: response.content.includes('<task_finish>'), costThisRound },
        );
        if (evalResult.action === 'stop' || evalResult.action === 'replan') {
          this._write(taskWarning(evalResult.reason));
          break;
        }
      }
    }

    if (!options?.signal?.aborted) showTokenSummary();
    return working;
  } finally {
    this._emit({ type: 'task_done' });
    this.onWrite = prevOnWrite;
    this.onEvent = prevOnEvent;
  }
  }

  private async _runPlanTask(messages: Message[], options?: RunTaskOptions): Promise<Message[]> {
    const prevOnWrite = this.onWrite;
    const prevOnEvent = this.onEvent;
    if (options?.onWrite) this.onWrite = options.onWrite;
    if (options?.onEvent) this.onEvent = options.onEvent;
    this._emit({ type: 'task_start' });
    try {
      const task = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
      const working: Message[] = [
        { role: 'system', content: PlanModeManager.getSystemPrompt() },
        { role: 'user', content: task },
      ];

      const updated = await this.runTask(working, { ...options, plan: false, readonly: true });
      const lastAssistant = [...updated].reverse().find(m => m.role === 'assistant');
      if (!lastAssistant) return updated;

      const jsonText = lastAssistant.content.match(/\{[\s\S]*\}/)?.[0] ?? lastAssistant.content;
      try {
        const validation = PlanModeManager.validatePlan(JSON.parse(jsonText));
        const formatted = validation.valid && validation.plan
          ? PlanModeManager.formatPlan(validation.plan)
          : `计划 JSON 校验失败:\n${validation.errors.join('\n')}`;
        this._write('\n' + renderMarkdown('```\n' + formatted + '\n```') + '\n');
        return [...updated, { role: 'assistant', content: formatted }];
      } catch (err) {
        const msg = `计划 JSON 解析失败: ${(err as Error).message}`;
        this._write(taskWarning(msg));
        return [...updated, { role: 'assistant', content: msg }];
      }
    } finally {
      this._emit({ type: 'task_done' });
      this.onWrite = prevOnWrite;
      this.onEvent = prevOnEvent;
    }
  }

  /** 每轮水位检查：60% 警告 → 75% 轻量裁剪 → 85% LLM 摘要（委托给 ContextManager） */
  private async _maybeCompact(working: Message[]): Promise<void> {
    const limit = this.provider.capabilities.maxContextTokens;
    const tokens = this._lastPromptTokens;
    const ctxMgr = this.contextManager;

    if (ctxMgr.shouldWarn(tokens, limit)) {
      if (tokens > limit * 0.85 || tokens > limit * 0.75) {
        this._write(contextCompacting(this.i18n?.t('context.compacting', { pct: String(Math.round(tokens / limit * 100)), usedK: String(Math.round(tokens / 1000)), limitK: String(Math.round(limit / 1000)) }) ?? '…'));
        const { didCompact, newTokens } = await ctxMgr.compactMessages(working, this.provider, tokens);
        if (didCompact) {
          this._lastPromptTokens = newTokens;
          this._write(contextCompacted(this.i18n?.t('context.compacted', { removedK: String(Math.round((tokens - newTokens) / 1000)), currentK: String(Math.round(newTokens / 1000)) }) ?? '✓'));
        }
      } else {
        this._write(contextStats(tokens, limit, this.i18n?.t('context.usage')) + '\n');
      }
    }
  }

  private async _callLLM(
    messages: Message[],
    tools: FunctionDefinition[],
    signal?: AbortSignal,
    onToolCall?: (tc: ToolCall) => void,
  ): Promise<{ content: string; toolCalls?: ToolCall[]; usage?: { promptTokens: number; completionTokens: number } }> {
    const opts = { tools, signal };
    if (this.stream) return this._streamChat(messages, tools, signal, onToolCall);
    const spin = spinnerStart(this.i18n?.t('stream.thinking'), text => this._write(text));
    const response = await this.provider.chat(messages, { ...opts });
    spin.stop();
    const displayContent = response.content.trim();
    if (displayContent) this._write(renderMarkdown(displayContent) + '\n');
    return { content: response.content, toolCalls: response.toolCalls, usage: response.usage };
  }

  private async _streamChat(
    messages: Message[],
    tools: FunctionDefinition[],
    signal?: AbortSignal,
    onToolCall?: (tc: ToolCall) => void,
  ): Promise<{ content: string; toolCalls?: ToolCall[]; usage?: { promptTokens: number; completionTokens: number } }> {
    return streamChat({
      provider: this.provider,
      messages,
      tools,
      signal,
      i18n: this.i18n,
      write: text => this._write(text),
      onToolCall,
      onThinkingContent: content => { this._lastThinkingContent = content; },
    });
  }

  private async _executeTool(tc: ToolCall, signal?: AbortSignal, preApproved = false): Promise<{ result: string; duration: number }> {
    const name = tc.name;
    const args = tc.arguments;
    const label = this.i18n?.toolLabel(name) ?? name;

    // 权限检查
    if (!preApproved && this.permissionEngine) {
      const perm = this.permissionEngine.check(name, args);
      if (perm === 'deny') {
        const msg = this.i18n?.t('executor.security_policy_deny', { label }) ?? `[Denied] ${label}`;
        return { result: msg, duration: 0 };
      }
      if (perm === 'ask') {
        if (this.approvalHandler) {
          this._emit({ type: 'approval_request', toolName: name, args });
          const ok = await this.approvalHandler(name, args);
          this._emit({ type: 'approval_response', toolName: name, approved: ok });
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
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const abortPromise = signal ? new Promise<string>((_, reject) => {
        if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
        else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }) : undefined;
      const result = await (abortPromise ? Promise.race([this.registry.dispatch(name, args, { signal }), abortPromise]) : this.registry.dispatch(name, args, { signal }));
      const duration = Date.now() - toolStart;
      this.controller?.recordToolCall(name, args, result);

      return { result: truncateToolResult(name, result), duration };
    } catch (err) {
      const errMsg = (err as Error).message;
      const duration = Date.now() - toolStart;
      if (signal?.aborted || (err as Error).name === 'AbortError' || /SIGINT|User interruption|CTRL-C|aborted/i.test(errMsg)) {
        return { result: this.i18n?.t('status.cancelled') ?? 'Cancelled', duration };
      }
      this.controller?.recordToolCall(name, args, this.i18n?.t('executor.exception', { msg: errMsg }) ?? `[Exception]: ${errMsg}`);
      return { result: `[${label}]: ${(this.i18n?.t('common.error') ?? 'Error')} - ${errMsg}`, duration };
    }
  }
}
