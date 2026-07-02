import { formatExecutionErrorForModel, reportNonFatalError, type Message } from '@customize-agent/types';
import type { AgentEvent, AgentExecutor } from '../agent/executor.js';
import { TuiInput } from '../tui/input.js';
import { welcomeBanner, t, s, divider, msg, contextStats, thinkingExpanded, userMessageBlock, toolCallPending } from '../tui/renderer.js';
import type { MemoryManager, MemoryType } from '@customize-agent/memory';
import { MultiProjectManager } from '@customize-agent/knowledge';
import { BuiltinTools, WorkspaceSnapshotService, type WorkspaceSnapshot } from '@customize-agent/tools';
import { AuditLogger, type ConfigStore, type ModelRegistry, type ProviderConfig } from '@customize-agent/runtime';
import type { I18nManager } from '../i18n/manager.js';
import { buildDefaultCommands, type ReplCommandInfo } from './commands.js';
import { ModelProviderCommands } from './model-provider-commands.js';
import { captureInputDuringTask } from '../tui/task-input-capture.js';
import { supportsAnimation } from '../tui/terminal-capabilities.js';
import { resolveAtRefs } from './at-file-resolver.js';
import { selectList } from './select-list.js';
import { ToolCommands } from './tool-commands.js';
import { SessionCommands } from './session-commands.js';
import { KbCommands } from './kb-commands.js';

/** REPL 配置 */
export interface ReplConfig {
  executor: AgentExecutor;
  projectRoot: string;
  commands?: ReplCommandInfo[];
  memory?: MemoryManager;
  i18n: I18nManager;
  configStore: ConfigStore;
  modelRegistry: ModelRegistry;
  providerDisplay?: string;
  createExecutor?: (providerName: string, modelName: string, providerConfig?: ProviderConfig) => Promise<AgentExecutor>;
  executorConfigKey?: string;
  kbManager?: MultiProjectManager;
  dashboardUrl?: string;
  kbStatus?: string;
}

/**
 * REPL — 会话管理 + TUI 输入 + 消息格式化 + 斜杠命令。
 */
export class Repl {
  public executor: AgentExecutor;
  private tui!: TuiInput;
  private history: Message[];
  private root: string;
  private memory?: MemoryManager;
  private i18n: I18nManager;
  private configStore: ConfigStore;
  private modelRegistry: ModelRegistry;
  private builtinTools: BuiltinTools;
  private snapshotService: WorkspaceSnapshotService;
  private providerDisplay: string | undefined;
  private createExecutor?: (providerName: string, modelName: string, providerConfig?: ProviderConfig) => Promise<AgentExecutor>;
  private executorConfigKey?: string;
  private modelProviderCommands: ModelProviderCommands;
  private toolCommands: ToolCommands;
  private sessionCommands: SessionCommands;
  private kbCommands: KbCommands;
  private kbManager?: MultiProjectManager;
  private dashboardUrl?: string;
  private kbStatus = '未初始化';
  private commands: ReplCommandInfo[] = [];
  private currentTaskAbort?: AbortController;
  private taskRunning = false;
  private pendingInputs: Array<{ content: string; display: string; rendered: boolean }> = [];
  private sessionId = `session-${Date.now()}`;
  private auditLogger = new AuditLogger(this.sessionId);
  private snapshots = new Map<number, WorkspaceSnapshot>();

  constructor(config: ReplConfig) {
    this.executor = config.executor;
    this.root = config.projectRoot;
    this.memory = config.memory;
    this.i18n = config.i18n;
    this.configStore = config.configStore;
    this.modelRegistry = config.modelRegistry;
    this.builtinTools = new BuiltinTools(config.projectRoot);
    this.snapshotService = new WorkspaceSnapshotService(config.projectRoot);
    this.providerDisplay = config.providerDisplay;
    this.createExecutor = config.createExecutor;
    this.executorConfigKey = config.executorConfigKey;
    this.kbManager = config.kbManager;
    this.dashboardUrl = config.dashboardUrl;
    this.kbStatus = config.kbStatus ?? this.kbStatus;
    this.modelProviderCommands = new ModelProviderCommands({
      configStore: this.configStore,
      modelRegistry: this.modelRegistry,
      i18n: this.i18n,
      readLine: (prompt: string) => this._readLine(prompt),
      selectList: <T>(title: string, items: Array<{ label: string; detail?: string; value: T }>) =>
        this._selectList(title, items),
    });
    this.history = [{ role: 'system', content: this.executor.getSystemPrompt() }];
    this.toolCommands = new ToolCommands(this.builtinTools, this.i18n, this.history);
    this.kbCommands = new KbCommands(this.root, this.kbManager, this.dashboardUrl, this.i18n);
    this.sessionCommands = new SessionCommands({
      history: this.history,
      executor: this.executor,
      i18n: this.i18n,
      selectList: (title, items) => this._selectList(title, items),
      getSessionId: () => this.sessionId,
      setSessionId: id => {
        this.sessionId = id;
        this.auditLogger = new AuditLogger(id);
        void this.auditLogger.init();
      },
      setDraft: text => this.tui.setDraft(text),
      findSnapshotForTurn: index => this._findSnapshotForTurn(index),
      loadSnapshot: id => this.snapshotService.loadSerialized(id),
      restoreSnapshot: snapshot => this.snapshotService.restoreSnapshot(snapshot),
    });
    this._buildTui(config.commands);
  }

  /** 启动 REPL */
  async start(): Promise<void> {
    await this.auditLogger.init();
    await this.auditLogger.logSessionMetadata({
      sessionId: this.sessionId,
      startTime: new Date().toISOString(),
      cwd: this.root,
      task: '',
      provider: this.providerDisplay ?? '',
      model: this.providerDisplay ?? '',
    });
    this._redrawBanner();

    while (true) {
      const input = await this.tui.read();
      if (!input) continue;

      if (input.startsWith('/')) {
        const done = await this._command(input);
        if (done) break;
        continue;
      }

      const enhanced = await this._resolveAtRefs(input);
      if (this.taskRunning) {
        this.pendingInputs.push({ content: enhanced, display: input, rendered: false });
        this._renderPendingInputs({ redraw: false });
        continue;
      }
      await this._runTaskQueue({ content: enhanced, display: input, rendered: false });
    }

    await this.kbManager?.shutdown();
    console.log('\n' + this.i18n.t('welcome.goodbye'));
  }

  private async _resolveAtRefs(text: string): Promise<string> {
    return resolveAtRefs(text, this.root, this.i18n);
  }

  // 任务执行

  private _fmtArg(args?: Record<string, unknown>): string {
    if (!args) return '';
    const val = args.path ?? args.query ?? args.pattern ?? args.filePath ?? args.command ?? args.input;
    if (typeof val !== 'string' || val.length === 0) return '';
    if (val.length <= 50) return val;
    if (args.command || args.input) return val.slice(0, 47) + '...';
    const parts = val.split('/');
    if (parts.length > 2) return '…/' + parts.slice(-2).join('/');
    return val.slice(0, 47) + '...';
  }

  private _renderAgentEvent(event: AgentEvent): void {
    if (event.type === 'output') {
      this.tui.writeExternal(event.text);
    } else if (event.type === 'user_message') {
      this.tui.writeExternal(userMessageBlock(event.text, this.i18n.t('message.user')).replace(/^\n/, ''));
    } else if (event.type === 'tool_call_preview') {
      this.tui.writeExternal(toolCallPending(event.toolName, 1, this._fmtArg(event.args), event.elapsedMs, this.i18n.toolLabel(event.toolName)));
    }
  }

  private _captureInputDuringTask(onCancel: () => void) {
    return captureInputDuringTask({
      projectRoot: this.root,
      commands: this.commands,
      i18n: this.i18n,
      tokenStats: () => this.executor.getContextStats(),
      onCancel,
    });
  }

  private _findSnapshotForTurn(index: number): WorkspaceSnapshot | undefined {
    let bestIndex = -1;
    let best: WorkspaceSnapshot | undefined;
    for (const [snapshotIndex, snapshot] of this.snapshots) {
      if (snapshotIndex <= index && snapshotIndex > bestIndex) {
        bestIndex = snapshotIndex;
        best = snapshot;
      }
    }
    return best;
  }

  private _renderPendingInputs(options: { redraw?: boolean } = {}): void {
    this.tui.setPendingBlocks(this.pendingInputs.map(item => ({
      text: item.display,
      label: this.i18n.t('message.queued'),
      variant: 'queued' as const,
    })), options);
  }

  private async _runTaskQueue(input: { content: string; display: string; rendered: boolean }): Promise<void> {
    this.taskRunning = true;
    let next: { content: string; display: string; rendered: boolean } | undefined = input;
    while (next) {
      await this._execute(next.content, next.display, !next.rendered);
      if (this.currentTaskAbort?.signal.aborted) {
        this.pendingInputs.length = 0;
        this.currentTaskAbort = undefined;
        break;
      }
      next = this.pendingInputs.shift();
      this._renderPendingInputs();
    }
    this.tui.setPendingBlocks([]);
    this.currentTaskAbort = undefined;
    this.taskRunning = false;
  }

  private async _injectKnowledgeContext(enhancedInput: string, query: string): Promise<string> {
    try {
      this.kbManager ??= new MultiProjectManager();
      const result = await this.kbManager.search(this.root, query, { scope: 'all', limit: 5 });
      if (result.results.length === 0) return enhancedInput;
      const lines = result.results.map((item, index) => [
        `### KB-${index + 1}: ${item.filePath}`,
        `scope=${item.scope}, score=${item.score.toFixed(3)}, collection=${item.collection}`,
        item.content.slice(0, 1200),
      ].join('\n'));
      return `${enhancedInput}\n\n--- 本地知识库相关上下文 ---\n${lines.join('\n\n')}\n--- 知识库上下文结束 ---`;
    } catch (error) {
      reportNonFatalError({ source: 'repl.knowledge', error, details: { query: query.slice(0, 120) } });
      return enhancedInput;
    }
  }

  private _modelConfigKey(provider: string, model: string, cfg?: ProviderConfig): string {
    return JSON.stringify({ provider, model, cfg: cfg ?? {} });
  }

  private async _execute(input: string, displayInput = input, renderUserMessage = true): Promise<void> {
    const resolved = this.modelRegistry.resolve('action');
    if (!resolved) {
      process.stdout.write('\n' + t.warning(this.i18n.t('cmd.no_model_configured')) + '\n');
      process.stdout.write(t.dim(this.i18n.t('cmd.first_config') + '\n\n'));
      return;
    }

    const providerConfig = this.configStore.getProvider(resolved.provider);
    const nextExecutorKey = this._modelConfigKey(resolved.provider, resolved.name, providerConfig);
    if (this.createExecutor && this.executorConfigKey !== nextExecutorKey) {
      this.executor = await this.createExecutor(resolved.provider, resolved.name, providerConfig);
      this.executorConfigKey = nextExecutorKey;
      this.history[0] = { role: 'system', content: this.executor.getSystemPrompt() };
      this.providerDisplay = this.executor.providerName;
      this._redrawBanner();
    }

    if (renderUserMessage) this.tui.writeExternal(userMessageBlock(displayInput, this.i18n.t('message.user')));

    const abortController = new AbortController();
    this.currentTaskAbort = abortController;
    const taskInput = this._captureInputDuringTask(() => {
      abortController.abort();
      this.pendingInputs.length = 0;
    });
    const drainTaskInput = () => taskInput.drain().map(text => ({ content: text, display: text }));
    let toolPreviewTimer: ReturnType<typeof setInterval> | null = null;
    let toolPreview: { toolName: string; args: Record<string, unknown>; startMs: number } | null = null;
    const renderToolPreview = () => {
      if (!toolPreview) return;
      taskInput.writeOutput('\r' + toolCallPending(
        toolPreview.toolName,
        1,
        this._fmtArg(toolPreview.args),
        Date.now() - toolPreview.startMs,
        this.i18n.toolLabel(toolPreview.toolName),
      ).trimEnd());
    };
    const stopToolPreview = () => {
      if (toolPreviewTimer) clearInterval(toolPreviewTimer);
      toolPreviewTimer = null;
      if (toolPreview) taskInput.writeOutput('\r');
      toolPreview = null;
    };
    const startToolPreview = (event: Extract<AgentEvent, { type: 'tool_call_preview' }>) => {
      const startMs = Date.now() - (event.elapsedMs ?? 0);
      toolPreview = { toolName: event.toolName, args: event.args, startMs };
      renderToolPreview();
      if (supportsAnimation() && !toolPreviewTimer) toolPreviewTimer = setInterval(renderToolPreview, 100);
    };

    let enhancedInput = input;
    if (this.memory) {
      const memories = this.memory.recall(input, 3);
      if (memories.length > 0) {
        const memoryLines = memories.map(m => {
          const label = this.i18n.t('memory.' + m.type);
          return `[${label}]: ${m.content}`;
        });
        enhancedInput = `${input}\n\n${this.i18n.t('memory.section_header')}\n${memoryLines.join('\n')}\n${this.i18n.t('memory.section_footer')}`;
      }
    }

    enhancedInput = await this._injectKnowledgeContext(enhancedInput, input);
    if (abortController.signal.aborted) {
      taskInput.stop();
      return;
    }

    const userIndex = this.history.length;
    try {
      const snapshot = await this.snapshotService.takeSnapshot();
      this.snapshots.set(userIndex, snapshot);
      await this.snapshotService.saveSerialized(this.sessionId, snapshot);
    } catch (err) {
      reportNonFatalError({ source: 'repl.snapshot', error: err, details: { sessionId: this.sessionId } });
    }
    if (abortController.signal.aborted) {
      taskInput.stop();
      return;
    }
    this.history.push({ role: 'user', content: enhancedInput });

    await this.auditLogger.logSessionMetadata({
      sessionId: this.sessionId,
      startTime: new Date().toISOString(),
      cwd: this.root,
      task: input,
      provider: this.providerDisplay ?? '',
      model: this.providerDisplay ?? '',
    });
    await this.auditLogger.logTaskStart(input);

    try {
      const updated = await this.executor.runTask(this.history, {
        onEvent: event => {
          if (abortController.signal.aborted) return;
          if (event.type === 'tool_call_preview') {
            startToolPreview(event);
            return;
          }
          if (event.type === 'approval_request') { stopToolPreview(); taskInput.pause(); return; }
          if (event.type === 'approval_response') { taskInput.resume(); return; }
          if (event.type === 'llm_response') {
            void this.auditLogger.logLLMResponse(event.content, event.usage ? { prompt: event.usage.promptTokens, completion: event.usage.completionTokens } : undefined);
          }
          if (event.type === 'output') { stopToolPreview(); taskInput.writeOutput(event.text); }
          else if (event.type === 'user_message') { stopToolPreview(); taskInput.writeOutput(userMessageBlock(event.text, this.i18n.t('message.user')).replace(/^\n/, '')); }
          else { stopToolPreview(); this._renderAgentEvent(event); }
        },
        drainUserInput: () => drainTaskInput(),
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) {
        this.history.pop();
        return;
      }
      this.history.length = 0;
      this.history.push(...updated);
      await this.auditLogger.logTaskFinish('success');

      if (this.memory) {
        const lastAssistant = [...updated].reverse().find(m => m.role === 'assistant');
        if (lastAssistant?.content) {
          this.memory.remember('project_fact', lastAssistant.content.slice(0, 500), `Task: ${input.slice(0, 200)}`);
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        this.history.pop();
      } else {
        await this.auditLogger.logError(err as Error, 'task');
        await this.auditLogger.logTaskFinish('error');
        const errorContent = formatExecutionErrorForModel({ scope: 'task', error: err as Error });
        this.history.push({ role: 'assistant', content: errorContent });
        taskInput.writeOutput(msg.error((err as Error).message));
      }
    } finally {
      stopToolPreview();
      taskInput.stop();
    }
  }

  private async _readLine(prompt: string): Promise<string> {
    this.tui.suspend();
    const { createInterface } = await import('readline');
    return new Promise<string>(resolve => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(prompt, (answer: string) => {
        rl.close();
        this.tui.resume();
        resolve(answer);
      });
    });
  }

  private async _selectList<T>(title: string, items: Array<{ label: string; detail?: string; value: T }>): Promise<T | null> {
    this.tui.suspend();
    try {
      return await selectList(title, items);
    } finally {
      this.tui.resume();
    }
  }

  // /commands 命令分发

  private async _command(raw: string): Promise<boolean> {
    const sp = raw.indexOf(' ');
    const cmd = sp > 0 ? raw.slice(0, sp) : raw;
    const args = sp > 0 ? raw.slice(sp + 1).trim() : '';

    switch (cmd) {
      case '/exit': case '/quit': return true;

      case '/language': {
        if (args === 'zh' || args === 'en') {
          this._switchLanguage(args);
          process.stdout.write(t.success(this.i18n.t('cmd.language_changed', { lang: args }) + '\n\n'));
        } else {
          await this._showLanguageSelector();
        }
        return false;
      }

      case '/memory': return this._handleMemoryCommand(args);
      case '/kb': await this.kbCommands.handle(args); return false;
      case '/model': return this.modelProviderCommands.handleModelCommand(args);
      case '/provider': return this.modelProviderCommands.handleProviderCommand(args);
      case '/rewind': await this.sessionCommands.rewind(args); return false;
      case '/resume': await this.sessionCommands.resume(args); return false;
      case '/history': case '/sessions': await this.sessionCommands.sessions(); return false;
      case '/reset': return this._command('/clear');
      case '/web': await this.toolCommands.web(args); return false;
      case '/export': await this.toolCommands.export(args); return false;
      case '/doctor': process.stdout.write(await this.builtinTools.doctor() + '\n\n'); return false;
      case '/checkpoint': await this.toolCommands.checkpoint(args); return false;
      case '/git': await this.toolCommands.git(args); return false;
      case '/test': process.stdout.write(await this.builtinTools.runScript('test') + '\n\n'); return false;
      case '/build': process.stdout.write(await this.builtinTools.runScript('build') + '\n\n'); return false;
      case '/lint': process.stdout.write(await this.builtinTools.runScript('lint') + '\n\n'); return false;
      case '/preview': await this.toolCommands.preview(args); return false;
      case '/file': await this.toolCommands.file(args); return false;
      case '/zip': await this.toolCommands.zip(args); return false;
      case '/repo': process.stdout.write(await this.builtinTools.repoMap() + '\n\n'); return false;
      case '/symbol': process.stdout.write(await this.builtinTools.symbolSearch(args) + '\n\n'); return false;
      case '/deps': process.stdout.write(await this.builtinTools.dependencyGraph() + '\n\n'); return false;
      case '/mcp': await this.toolCommands.mcp(args); return false;
      case '/plugin': await this.toolCommands.plugin(args); return false;
      case '/version': process.stdout.write(await this.builtinTools.version() + '\n\n'); return false;

      case '/compact': {
        const compacted = await this.executor.compactContext(this.history);
        if (!compacted) {
          process.stdout.write(t.dim(this.i18n.t('context.compact_none') + '\n\n'));
        }
        return false;
      }

      case '/context': {
        const ctxStats = this.executor.getContextStats();
        process.stdout.write(contextStats(ctxStats.tokens, ctxStats.limit, this.i18n.t('context.usage')) + '\n\n');
        return false;
      }

      case '/clear':
        if (this.memory && this.history.length > 2) {
          // 保存当前会话摘要到长期记忆
          const msgs = this.history.filter(m => m.role === 'user' || m.role === 'assistant');
          const summary = msgs.map(m => `[${m.role}] ${(m.content ?? '').slice(0, 200)}`).join('\n');
          this.memory.remember('pattern', summary.slice(0, 500), '会话摘要');
        }
        this.history.length = 0;
        this.history.push({ role: 'system', content: this.executor.getSystemPrompt() });
        process.stdout.write(t.success(this.i18n.t('context.session_cleared') + '\n\n'));
        return false;

      case '/help':
        process.stdout.write(`
${s.bold(this.i18n.t('help.title')) + ':'}
  ${t.accent('/plan <task>')}    ${t.dim(this.i18n.t('help.plan'))}
  ${t.accent('/rewind')}        ${t.dim(this.i18n.t('help.rewind'))}
  ${t.accent('/resume')}        ${t.dim(this.i18n.t('help.resume'))}
  ${t.accent('/clear')}         ${t.dim(this.i18n.t('help.clear'))}
  ${t.accent('/sessions')}      ${t.dim(this.i18n.t('help.sessions'))}
  ${t.accent('/language zh|en')} ${t.dim(this.i18n.t('help.language'))}
  ${t.accent('/model [name]')}  ${t.dim(this.i18n.t('help.model'))}
  ${t.accent('/provider <name>')}${t.dim(this.i18n.t('help.provider'))}
  ${t.accent('/kb status')}      ${t.dim('Knowledge base status')}
  ${t.accent('/kb search <q>')}  ${t.dim('Search knowledge base')}
  ${t.accent('/web search <q>')} ${t.dim(this.i18n.t('help.web'))}
  ${t.accent('/export pdf <file>')} ${t.dim(this.i18n.t('help.export'))}
  ${t.accent('/checkpoint')}    ${t.dim(this.i18n.t('help.checkpoint'))}
  ${t.accent('/doctor')}        ${t.dim(this.i18n.t('help.doctor'))}
  ${t.accent('/help')}          ${t.dim(this.i18n.t('help.help'))}
  ${t.accent('/exit')}          ${t.dim(this.i18n.t('help.exit'))}

${s.bold(this.i18n.t('help.tips')) + ':'}
  ${t.purple('@file')}          ${t.dim(this.i18n.t('help.file_tip'))}
  ${t.purple('@file:10-30')}    ${t.dim(this.i18n.t('help.line_tip'))}
  ${t.purple('↑↓')}            ${t.dim(this.i18n.t('help.key_tip'))}
  ${t.purple('Tab')}            ${t.dim(this.i18n.t('help.tab_tip'))}
`);
        return false;

      case '/plan': {
        if (!args) { process.stdout.write(t.warning(this.i18n.t('cmd.plan_usage') + '\n\n')); return false; }
        process.stdout.write('\n' + divider(this.i18n.t('plan.banner')) + '\n');
        process.stdout.write(msg.info(args) + '\n\n');
        const prompt = `Create an execution plan (read-only, do not modify files).\n\nTask: ${args}\n\nOutput the plan.`;
        this.history.push({ role: 'user', content: prompt });
        const abortController = new AbortController();
        const taskInput = this._captureInputDuringTask(() => abortController.abort());
        let toolPreviewTimer: ReturnType<typeof setInterval> | null = null;
        let toolPreview: { toolName: string; args: Record<string, unknown>; startMs: number } | null = null;
        let planSucceeded = false;
        const renderToolPreview = () => {
          if (!toolPreview) return;
          taskInput.writeOutput('\r' + toolCallPending(
            toolPreview.toolName,
            1,
            this._fmtArg(toolPreview.args),
            Date.now() - toolPreview.startMs,
            this.i18n.toolLabel(toolPreview.toolName),
          ).trimEnd());
        };
        const stopToolPreview = () => {
          if (toolPreviewTimer) clearInterval(toolPreviewTimer);
          toolPreviewTimer = null;
          if (toolPreview) taskInput.writeOutput('\r');
          toolPreview = null;
        };
        const startToolPreview = (event: Extract<AgentEvent, { type: 'tool_call_preview' }>) => {
          toolPreview = { toolName: event.toolName, args: event.args, startMs: Date.now() - (event.elapsedMs ?? 0) };
          renderToolPreview();
          if (supportsAnimation() && !toolPreviewTimer) toolPreviewTimer = setInterval(renderToolPreview, 100);
        };
        try {
          const u = await this.executor.runTask(this.history, {
            readonly: true,
            onEvent: event => {
              if (event.type === 'tool_call_preview') {
                startToolPreview(event);
                return;
              }
              if (event.type === 'approval_request') { stopToolPreview(); taskInput.pause(); }
              if (event.type === 'output') { stopToolPreview(); taskInput.writeOutput(event.text); }
              else if (event.type === 'user_message') { stopToolPreview(); taskInput.writeOutput(userMessageBlock(event.text, this.i18n.t('message.user'))); }
              else { stopToolPreview(); this._renderAgentEvent(event); }
              if (event.type === 'approval_response') taskInput.resume();
            },
            drainUserInput: () => taskInput.drain(),
            signal: abortController.signal,
          });
          this.history.length = 0; this.history.push(...u);
          planSucceeded = true;
        } catch (err) {
          if (abortController.signal.aborted) {
            this.history.pop();
          } else {
            const errorContent = formatExecutionErrorForModel({ scope: 'plan', error: err as Error });
            this.history.push({ role: 'assistant', content: errorContent });
            process.stdout.write(msg.error((err as Error).message));
          }
        } finally {
          stopToolPreview();
          taskInput.stop();
        }
        if (!planSucceeded) return false;
        const next = await this._selectList(this.i18n.t('plan.complete'), [
          { label: this.i18n.t('cmd.plan_execute'), detail: args, value: 'execute' as const },
          { label: this.i18n.t('cmd.plan_keep'), detail: this.i18n.t('help.plan'), value: 'keep' as const },
        ]);
        if (next === 'execute') {
          await this._execute(args);
        } else {
          process.stdout.write('\n' + divider(this.i18n.t('plan.complete')) + '\n\n');
        }
        return false;
      }

      default:
        process.stdout.write(t.warning(`${this.i18n.t('cmd.unknown')} ${cmd}. ${this.i18n.t('help.help')}: /help\n\n`));
        return false;
    }
  }

  private _handleMemoryCommand(args: string): boolean {
    if (!this.memory) { process.stdout.write(t.dim('Memory disabled.\n\n')); return false; }
    if (args.startsWith('clear')) {
      const type = args.split(/\s+/)[1] as string | undefined;
      this.memory.clear(type as MemoryType | undefined);
      process.stdout.write(t.success(this.i18n.t('memory.cleared') + '\n\n'));
      return false;
    }
    const all = this.memory.listAll(20);
    if (!all.length) { process.stdout.write(t.dim(this.i18n.t('memory.count', { count: '0' }) + '\n\n')); return false; }
    process.stdout.write('\n' + t.dim(this.i18n.t('memory.count', { count: String(all.length) })) + '\n');
    for (const m of all) {
      const label = this.i18n.t('memory.' + m.type);
      process.stdout.write(`  ${t.accent('▸')} ${t.dim(label)}  ${m.content.slice(0, 80)}\n`);
    }
    process.stdout.write(`\n  ${t.dim(this.i18n.t('memory.clear_usage'))}\n\n`);
    return false;
  }


  private async _showLanguageSelector(): Promise<void> {
    try {
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch { /* */ }
      }
      const { selectLanguage } = await import('../tui/language-selector.js');
      const lang = await selectLanguage({
        title: this.i18n.t('lang.select.title'),
        prompt: this.i18n.t('lang.select.prompt'),
        zhLabel: this.i18n.t('lang.select.zh'),
        enLabel: this.i18n.t('lang.select.en'),
      });
      this._switchLanguage(lang);
    } catch {
      // 选择器异常，保持当前语言
      this._redrawBanner();
    }
  }

  private _buildTui(cmds?: ReplCommandInfo[]): void {
    this.commands = cmds ?? buildDefaultCommands(this.i18n);
    this.tui = new TuiInput({
      projectRoot: this.root,
      commands: this.commands,
      labels: {
        filesHeader: this.i18n.t('dropdown.files_header'),
        commandsHeader: this.i18n.t('dropdown.commands_header'),
        more: (n: number) => this.i18n.t('dropdown.more', { count: String(n) }),
        hintTab: this.i18n.t('hint.tab_select'),
        hintNavigate: this.i18n.t('hint.arrow_navigate'),
        hintConfirm: this.i18n.t('hint.enter_confirm'),
        hintDismiss: this.i18n.t('hint.esc_dismiss'),
        hintSep: this.i18n.t('hint.separator'),
      },
      prompt: '➜',
      mode: 'AGENT',
      tokenStats: () => {
        const s = this.executor.getContextStats();
        return s.tokens > 0 ? { used: s.tokens, limit: s.limit } : null;
      },
      onCtrlO: () => {
        const content = this.executor.lastThinkingContent;
        if (!content) {
          return t.dim(this.i18n.t('think.no_content'));
        }
        return thinkingExpanded(content, this.i18n.t('think.box_title'));
      },
      onCancel: () => {
        if (!this.currentTaskAbort || this.currentTaskAbort.signal.aborted) return false;
        this.currentTaskAbort.abort();
        this.pendingInputs.length = 0;
        this.tui.setPendingBlocks([]);
        this.tui.writeExternal(t.warning(this.i18n.t('status.cancelled')) + '\n');
        return true;
      },
    });
  }

  private _switchLanguage(lang: 'zh' | 'en'): void {
    this.i18n.setLanguage(lang);
    this.configStore.setLanguage(lang);
    this._buildTui();
    this._redrawBanner();
  }

  private _redrawBanner(): void {
    const cfg = this.configStore.load();
    const hasModels = cfg.models.reader.list.length > 0 || cfg.models.reasoning.list.length > 0 || cfg.models.action.list.length > 0;
    process.stdout.write(welcomeBanner('0.0.3', this.providerDisplay ?? this.executor.providerName, {
      title: this.i18n.t('welcome.title'),
      providerLabel: this.i18n.t('welcome.provider_label'),
      startHint: this.i18n.t('welcome.start_hint'),
      usageHints: this.i18n.t('welcome.usage_hints'),
      configHint: [
        hasModels ? undefined : this.i18n.t('cmd.first_config'),
        this.i18n.t('welcome.kb_status', { status: this.kbStatus }),
        this.dashboardUrl ? this.i18n.t('welcome.web_dashboard', { url: this.dashboardUrl }) : this.i18n.t('welcome.web_dashboard_stopped'),
      ].filter(Boolean).join('\n'),
    }));
  }


}
