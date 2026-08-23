import type { ILLMProvider, FunctionDefinition } from '@customize-agent/llm';
import { estimateCostUsd } from '@customize-agent/llm';
import type { ToolRegistry, PermissionEngine, ExecutionController, ContextManager } from '@customize-agent/engine';
import { ContextManager as ContextManagerImpl, PlanModeManager } from '@customize-agent/engine';
import { formatToolErrorForModel, type Message, type ToolCall } from '@customize-agent/types';
import type { I18nManager } from '../i18n/manager.js';
import { buildSystemPrompt } from './prompt.js';
import { t, taskWarning, renderMarkdown, contextCompacting, contextCompacted, contextStats, spinnerStart, formatDuration } from '../tui/renderer.js';
import { streamChat } from './stream-chat.js';
import { truncateToolResult } from './tool-result.js';
import { ToolPreviewTracker, ToolFoldTracker } from './tool-tracker.js';
import { readFileSync, existsSync } from 'fs';
import { rm } from 'node:fs/promises';
import { resolve, join, normalize } from 'path';
import { homedir } from 'os';
import type { ApprovalHandler } from './approval.js';

export type AgentEvent =
  | { type: 'output'; text: string }
  | { type: 'task_start' }
  | { type: 'task_done' }
  | { type: 'llm_response'; content: string; usage?: { promptTokens: number; completionTokens: number } }
  | { type: 'user_message'; text: string }
  | { type: 'tool_call_preview'; toolName: string; args: Record<string, unknown>; elapsedMs?: number }
  | { type: 'tool_preview_end' }
  | { type: 'approval_request'; toolName: string; args: Record<string, unknown> }
  | { type: 'approval_response'; toolName: string; approved: boolean };

export interface RunTaskOptions {
  readonly?: boolean;
  plan?: boolean;
  onWrite?: (text: string) => void;
  setLiveStatus?: (lines: string | string[]) => void;
  clearLiveStatus?: () => void;
  commitStatus?: (lines: string | string[]) => void;
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
    const currentCustomizePath = resolve(this.projectRoot, 'CUSTOMIZE.md');
    const currentId = `file:${normalize(currentCustomizePath)}`;
    const promptConfigPath = join(homedir(), '.customize-agent', 'prompts.json');
    const selectedContent = (() => {
      const parts: string[] = [];
      const seen = new Set<string>();
      const addFile = (filePath: string) => {
        const normalized = normalize(filePath);
        if (seen.has(`file:${normalized}`) || !existsSync(normalized)) return;
        seen.add(`file:${normalized}`);
        parts.push(readFileSync(normalized, 'utf-8'));
      };
      try {
        const config = JSON.parse(readFileSync(promptConfigPath, 'utf-8')) as { selectedIds?: unknown; customPrompts?: Array<{ id?: string; name?: string; content?: string }> };
        const selectedIds = Array.isArray(config.selectedIds) ? config.selectedIds.map(String) : [currentId];
        const customPrompts = Array.isArray(config.customPrompts) ? config.customPrompts : [];
        for (const id of selectedIds) {
          if (id.startsWith('file:')) addFile(id.slice(5));
          else if (id.startsWith('custom:') && !seen.has(id)) {
            const custom = customPrompts.find(item => item.id === id);
            if (custom?.content?.trim()) {
              seen.add(id);
              parts.push(`# ${custom.name || '自定义提示词'}\n\n${custom.content}`);
            }
          }
        }
      } catch {
        addFile(currentCustomizePath);
      }
      return parts.join('\n\n---\n\n');
    })();
    return buildSystemPrompt(selectedContent, this.repoMap);
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

  /** 统一输出：onWrite 优先 → onEvent 其次 → process.stdout 回退 */
  private _write(text: string): void {
    if (this.onWrite) {
      this.onWrite(text);
      return;
    }
    if (this.onEvent) {
      this.onEvent({ type: 'output', text });
      return;
    }
    process.stdout.write(text);
  }

  private _emit(event: AgentEvent): void {
    this.onEvent?.(event);
  }

  private _ensureSystemPrompt(messages: Message[]): Message[] {
    const systemPrompt = this.getSystemPrompt();
    if (messages[0]?.role === 'system') {
      if (messages[0].content.includes('最高优先级项目规则')) return [{ ...messages[0], content: systemPrompt }, ...messages.slice(1)];
      return [{ ...messages[0], content: `${systemPrompt}\n\n---\n\n${messages[0].content}` }, ...messages.slice(1)];
    }
    return [{ role: 'system', content: systemPrompt }, ...messages];
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

    const working = this._ensureSystemPrompt([...messages]);
    const readonly = options?.readonly ?? false;
    // 临时覆盖 onWrite（options 优先级高于 config）
    const prevOnWrite = this.onWrite;
    const prevOnEvent = this.onEvent;
    if (options?.onWrite) this.onWrite = options.onWrite;
    if (options?.onEvent) this.onEvent = options.onEvent;
    const tempContext: { tempDir?: string; tempFiles: string[] } = { tempFiles: [] };
    const cleanupTempFiles = async () => {
      if (tempContext.tempDir) await rm(tempContext.tempDir, { recursive: true, force: true });
      else await Promise.all(tempContext.tempFiles.map(file => rm(file, { force: true })));
      tempContext.tempFiles.length = 0;
      tempContext.tempDir = undefined;
    };
    this._emit({ type: 'task_start' });
    try {

    const allTools = this.registry.listAll();
    const filteredTools = readonly
      ? allTools.filter(tool => !tool.requiresApproval && !tool.capabilities.includes('write_code'))
      : allTools;

    const allowedToolNames = new Set(filteredTools.map(tool => tool.name));
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

    const previewTracker = new ToolPreviewTracker();
    const emitToolCallPreview = (tc: ToolCall, elapsedMs = Date.now() - taskStartMs): boolean =>
      previewTracker.emit(tc, elapsedMs, e => this._emit(e));

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

      const response = await this._callLLM(working, tools, options?.signal, emitToolCallPreview, {
        setLiveStatus: options?.setLiveStatus,
        clearLiveStatus: options?.clearLiveStatus,
        commitStatus: options?.commitStatus,
      });
      if (options?.signal?.aborted) break;
      // 累加 token（任务结束时统一输出一行汇总）
      let costThisRound = 0;
      if (response.usage) {
        this._lastPromptTokens = response.usage.promptTokens;
        totalPrompt += response.usage.promptTokens;
        totalCompletion += response.usage.completionTokens ?? 0;
        costThisRound = estimateCostUsd(this.provider, response.usage);
      }

      this._emit({ type: 'llm_response', content: response.content, usage: response.usage });

      const assistantMsg: Message = { role: 'assistant', content: response.content, toolCalls: response.toolCalls };
      working.push(assistantMsg);

      if (!response.toolCalls?.length) {
        if (drainPendingUserInput()) continue;
        break;
      }

      // 同类工具折叠（参考 Claude Code collapseReadSearchGroups）
      const wasPreviewedBeforeExec = (tc: ToolCall) => previewTracker.wasPreviewed(tc);
      const foldTracker = new ToolFoldTracker(
        this.stream,
        text => this._write(text),
        name => this.i18n?.toolLabel(name) ?? name,
        this.i18n?.t('tool.count_label') ?? 'tools',
        args => this._formatArg(args),
        options?.setLiveStatus,
        options?.commitStatus,
      );

      this._emit({ type: 'tool_preview_end' });

      for (const tc of response.toolCalls) {
        if (options?.signal?.aborted) break;
        const previewElapsedMs = Date.now() - taskStartMs;
        const wasPreviewed = wasPreviewedBeforeExec(tc);
        const renderedPreview = emitToolCallPreview(tc, previewElapsedMs);
        const skipStartRender = wasPreviewed || renderedPreview;
        let preApproved = false;

        if (!allowedToolNames.has(tc.name)) {
          const msg = readonly ? `Tool "${tc.name}" is not available in readonly mode.` : `Tool "${tc.name}" is not available.`;
          working.push({ role: 'tool', content: msg, toolCallId: tc.id });
          continue;
        }

        foldTracker.push(tc, skipStartRender, previewElapsedMs);

        const permission = this.permissionEngine?.check(tc.name, tc.arguments);
        if (permission === 'ask' && !this.approvalHandler) {
          const label = this.i18n?.toolLabel(tc.name) ?? tc.name;
          const msg = this.i18n?.t('executor.security_policy_deny', { label }) ?? `[Denied] ${label}`;
          working.push({ role: 'tool', content: msg, toolCallId: tc.id });
          continue;
        }
        if (permission === 'ask' && this.approvalHandler) {
          this._emit({ type: 'approval_request', toolName: tc.name, args: tc.arguments });
          const approvalPromise = this.approvalHandler(tc.name, tc.arguments, options?.signal);
          const abortPromise = options?.signal ? new Promise<boolean>((_, reject) => {
            if (options.signal!.aborted) reject(new DOMException('Aborted', 'AbortError'));
            else options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          }) : undefined;
          const ok = await (abortPromise ? Promise.race([approvalPromise, abortPromise]) : approvalPromise);
          this._emit({ type: 'approval_response', toolName: tc.name, approved: ok });
          if (options?.signal?.aborted) break;
          if (!ok) {
            const label = this.i18n?.toolLabel(tc.name) ?? tc.name;
            const msg = this.i18n?.t('executor.user_cancelled', { label }) ?? `[Cancelled] ${label}`;
            working.push({ role: 'tool', content: msg, toolCallId: tc.id });
            continue;
          }
          preApproved = true;
        }
        let result = '';
        let duration = 0;
        ({ result, duration } = await this._executeTool(tc, options?.signal, preApproved, tempContext));
        if (options?.signal?.aborted) break;
        foldTracker.addDuration(duration);
        if (tc.name === 'write_file' && result) foldTracker.setDiff(result);
        working.push({ role: 'tool', content: result, toolCallId: tc.id });
      }
      if (!options?.signal?.aborted) foldTracker.flush();
      if (options?.signal?.aborted) break;

      if (this.controller && response.toolCalls && response.toolCalls.length > 0) {
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
    await cleanupTempFiles().catch(() => undefined);
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
        { role: 'system', content: `${this.getSystemPrompt()}\n\n---\n\n## Plan 模式额外规则\n\n${PlanModeManager.getSystemPrompt()}` },
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
          : `Plan JSON validation failed:\n${validation.errors.join('\n')}`;
        this._write('\n' + renderMarkdown('```\n' + formatted + '\n```') + '\n');
        return [...updated, { role: 'assistant', content: formatted }];
      } catch (err) {
        const msg = `Plan JSON parse failed: ${(err as Error).message}`;
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
    live?: Pick<RunTaskOptions, 'setLiveStatus' | 'clearLiveStatus' | 'commitStatus'>,
  ): Promise<{ content: string; toolCalls?: ToolCall[]; usage?: { promptTokens: number; completionTokens: number } }> {
    const opts = { tools, signal };
    if (this.stream) return this._streamChat(messages, tools, signal, onToolCall, live);
    const spin = spinnerStart(this.i18n?.t('stream.thinking'), text => (live?.setLiveStatus ?? this._write.bind(this))(text));
    const response = await this.provider.chat(messages, { ...opts });
    spin.stop();
    live?.clearLiveStatus?.();
    const displayContent = response.content.trim();
    if (displayContent) this._write(renderMarkdown(displayContent) + '\n');
    return { content: response.content, toolCalls: response.toolCalls, usage: response.usage };
  }

  private async _streamChat(
    messages: Message[],
    tools: FunctionDefinition[],
    signal?: AbortSignal,
    onToolCall?: (tc: ToolCall) => void,
    live?: Pick<RunTaskOptions, 'setLiveStatus' | 'clearLiveStatus' | 'commitStatus'>,
  ): Promise<{ content: string; toolCalls?: ToolCall[]; usage?: { promptTokens: number; completionTokens: number } }> {
    return streamChat({
      provider: this.provider,
      messages,
      tools,
      signal,
      i18n: this.i18n,
      write: text => this._write(text),
      setLiveStatus: live?.setLiveStatus,
      clearLiveStatus: live?.clearLiveStatus,
      commitStatus: live?.commitStatus,
      onToolCall,
      onThinkingContent: content => { this._lastThinkingContent = content; },
    });
  }

  private async _executeTool(tc: ToolCall, signal?: AbortSignal, preApproved = false, tempContext?: { tempDir?: string; tempFiles: string[] }): Promise<{ result: string; duration: number }> {
    const name = tc.name;
    const args = tc.arguments;
    const label = this.i18n?.toolLabel(name) ?? name;

    // deny 检查（approval 由 runTask 统一处理，此处仅处理安全策略直接拒绝）
    if (!preApproved && this.permissionEngine) {
      const perm = this.permissionEngine.check(name, args);
      if (perm === 'deny') {
        const msg = this.i18n?.t('executor.security_policy_deny', { label }) ?? `[Denied] ${label}`;
        return { result: msg, duration: 0 };
      }
      if (perm === 'ask') {
        const msg = this.i18n?.t('executor.security_policy_deny', { label }) ?? `[Denied] ${label}`;
        return { result: msg, duration: 0 };
      }
    }

    const toolStart = Date.now();
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const abortPromise = signal ? new Promise<string>((_, reject) => {
        if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
        else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }) : undefined;
      const context = { signal, tempDir: tempContext?.tempDir, tempFiles: tempContext?.tempFiles };
      const result = await (abortPromise ? Promise.race([this.registry.dispatch(name, args, context), abortPromise]) : this.registry.dispatch(name, args, context));
      if (tempContext && context.tempDir) tempContext.tempDir = context.tempDir;
      const duration = Date.now() - toolStart;
      this.controller?.recordToolCall(name, args, result);

      return { result: truncateToolResult(name, result), duration };
    } catch (err) {
      const errMsg = (err as Error).message;
      const duration = Date.now() - toolStart;
      if (signal?.aborted || (err as Error).name === 'AbortError' || /SIGINT|User interruption|CTRL-C|aborted/i.test(errMsg)) {
        return { result: this.i18n?.t('status.cancelled') ?? 'Cancelled', duration };
      }
      const formatted = formatToolErrorForModel({ toolName: name, label, args, error: err as Error });
      this.controller?.recordToolCall(name, args, formatted);
      return { result: formatted, duration };
    }
  }
}
