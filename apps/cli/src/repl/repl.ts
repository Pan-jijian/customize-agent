import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message } from '@customize-agent/types';
import type { AgentEvent, AgentExecutor } from '../agent/executor.js';
import { TuiInput } from '../tui/input.js';
import { welcomeBanner, t, s, divider, msg, contextStats, thinkingExpanded, userMessageBlock, modeBadge, modeAccent } from '../tui/renderer.js';
import type { MemoryManager, MemoryType } from '@customize-agent/memory';
import { BINARY_EXTENSIONS } from '@customize-agent/types';
import type { ConfigStore, ModelRegistry, ModelTier } from '@customize-agent/runtime';
import { resolveProtocol } from '@customize-agent/runtime';
import type { I18nManager } from '../i18n/manager.js';
import * as readline from 'readline';
import stringWidth from 'string-width';

/** REPL 配置 */
export interface ReplConfig {
  executor: AgentExecutor;
  projectRoot: string;
  commands?: Array<{ name: string; desc: string }>;
  memory?: MemoryManager;
  i18n: I18nManager;
  configStore: ConfigStore;
  modelRegistry: ModelRegistry;
  providerDisplay?: string;
}

/** @file 引用正则（排除邮箱地址：前面必须为空白或行首） */
const RE_AT = /(?:^|\s)@([^\s@]+(?::\d+(?:-\d+)?)?)/g;
const MAX_INLINE_SIZE = 500_000;const SNAPSHOT_MAX_FILE_SIZE = 25_000_000;
const SNAPSHOT_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.turbo', '.cache']);
let keypressInitialized = false;

type WorkspaceSnapshot = Map<string, Buffer>;
type SerializedWorkspaceSnapshot = Array<[string, string]>;

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
  private providerDisplay: string | undefined;
  private sessionId = `session-${Date.now()}`;
  private snapshots = new Map<number, WorkspaceSnapshot>();

  constructor(config: ReplConfig) {
    this.executor = config.executor;
    this.root = config.projectRoot;
    this.memory = config.memory;
    this.i18n = config.i18n;
    this.configStore = config.configStore;
    this.modelRegistry = config.modelRegistry;
    this.providerDisplay = config.providerDisplay;
    this.history = [{ role: 'system', content: this.executor.getSystemPrompt() }];
    this._buildTui(config.commands);
  }

  /** 启动 REPL */
  async start(): Promise<void> {
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
      await this._execute(enhanced);
    }

    console.log('\n' + this.i18n.t('welcome.goodbye'));
  }

  // @file 解析

  private async _resolveAtRefs(text: string): Promise<string> {
    const refs: Array<{ raw: string; filePath: string; startLine?: number; endLine?: number }> = [];

    for (const m of text.matchAll(RE_AT)) {
      const raw = m[1]!;
      const ci = raw.lastIndexOf(':');
      if (ci > 0) {
        const fp = raw.slice(0, ci);
        const rng = raw.slice(ci + 1);
        const parts = rng.split('-');
        const s = parseInt(parts[0]!, 10);
        const e = parts[1] ? parseInt(parts[1], 10) : undefined;
        if (!isNaN(s)) { refs.push({ raw, filePath: fp, startLine: s, endLine: e ?? s }); continue; }
      }
      refs.push({ raw, filePath: raw });
    }

    if (!refs.length) return text;

    const parts: string[] = [];
    for (const ref of refs) {
      const full = path.resolve(this.root, ref.filePath);
      try {
        const stat = await fs.promises.stat(full);
        const ext = path.extname(ref.filePath).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext.slice(1)) || stat.size > MAX_INLINE_SIZE) {
          parts.push(this.i18n.t('file.binary', { path: ref.filePath, size: (stat.size / 1024).toFixed(1) }));
          continue;
        }
        const content = await fs.promises.readFile(full, 'utf-8');
        const lines = content.split('\n');
        let snippet: string;
        if (ref.startLine !== undefined) {
          const s = Math.max(1, ref.startLine);
          const e = Math.min(lines.length, ref.endLine ?? s);
          snippet = lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join('\n');
        } else {
          snippet = content;
        }
        parts.push(`[File: ${ref.filePath}${ref.startLine ? ` L${ref.startLine}-${ref.endLine}` : ''}]\n${snippet}`);
      } catch { parts.push(`${this.i18n.t('file.not_found')} ${ref.filePath}`); }
    }

    const cleanText = text.replace(RE_AT, '').trim();
    const ctx = parts.join('\n\n');
    return cleanText ? `${cleanText}\n\n${this.i18n.t('file.reference')}\n${ctx}` : `${this.i18n.t('file.please_analyze')}\n${ctx}`;
  }

  // 任务执行

  private _renderAgentEvent(event: AgentEvent): void {
    if (event.type === 'output') {
      process.stdout.write(event.text);
    } else if (event.type === 'user_message') {
      process.stdout.write(userMessageBlock(event.text, this.i18n.t('message.user')));
    }
  }

  private _captureInputDuringTask(onCancel: () => void): { stop: () => void; pause: () => void; resume: () => void; drain: () => string[]; writeOutput: (text: string) => void } {
    if (!keypressInitialized) {
      readline.emitKeypressEvents(process.stdin);
      keypressInitialized = true;
    }
    let raw = false;
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); raw = true; } catch { /* ignore */ }
    }
    process.stdin.resume();

    let buffer = '';
    let pos = 0;
    let outputLineOpen = false;
    let statusLineActive = false;
    let inputLinesOnScreen = 0;
    let inputCursorLineIndex = 0;
    const pending: string[] = [];
    const mode = 'AGENT';
    const promptSymbol = '➜';
    const clearInputLine = () => {
      if (inputLinesOnScreen > 0) {
        const up = inputCursorLineIndex;
        let out = up > 0 ? `\x1b[${up}A` : '';
        out += '\r';
        for (let i = 0; i < inputLinesOnScreen; i++) {
          out += '\x1b[2K';
          if (i < inputLinesOnScreen - 1) out += '\n';
        }
        if (inputLinesOnScreen > 1) out += `\x1b[${inputLinesOnScreen - 1}A\r`;
        process.stdout.write(out);
        inputLinesOnScreen = 0;
        inputCursorLineIndex = 0;
        return;
      }
      process.stdout.write('\r\x1b[2K');
    };
    const renderBuffer = () => {
      clearInputLine();
      if (outputLineOpen) {
        process.stdout.write('\n');
        outputLineOpen = false;
      }
      const width = Math.max(40, process.stdout.columns ?? 80);
      const inner = width - 2;
      const before = buffer.slice(0, pos);
      const ch = buffer[pos] || ' ';
      const after = buffer.slice(pos + 1);
      const caret = s.inverse(ch);
      const queuedLines = pending.flatMap(text => userMessageBlock(text, this.i18n.t('message.queued'), 'queued').trimEnd().split('\n'));
      const stats = this.executor.getContextStats();
      const pct = Math.round((stats.tokens / stats.limit) * 100);
      const statsLabel = stats.tokens > 0 ? `[${Math.round(stats.tokens / 1000)}K/${Math.round(stats.limit / 1000)}K ${pct}%]` : '';
      const statsText = statsLabel ? (pct > 85 ? t.error(` ${statsLabel} `) : pct > 60 ? t.warning(` ${statsLabel} `) : t.faint(` ${statsLabel} `)) : '';
      const topFill = Math.max(1, inner - (statsLabel ? stringWidth(` ${statsLabel} `) : 0));
      const top = t.subtle('╭' + '─'.repeat(topFill)) + statsText + t.subtle('╮');
      const badge = modeBadge(mode);
      const bar = modeAccent(mode)('│');
      const pr = modeAccent(mode)(promptSymbol);
      const inputPrefix = `${badge} ${bar} ${pr} `;
      const prefixWidth = mode.length + 7;
      const inputVisible = prefixWidth + stringWidth(before + ch + after);
      const inputPad = ' '.repeat(Math.max(0, inner - 2 - inputVisible));
      const mid = `${t.subtle('│')} ${inputPrefix}${before}${caret}${after}${inputPad} ${t.subtle('│')}`;
      const bottom = t.subtle('╰' + '─'.repeat(inner) + '╯');
      const lines = [...queuedLines, top, mid, bottom];
      const cursorCol = 2 + prefixWidth + stringWidth(before);
      process.stdout.write(`\r${lines.map((line, i) => `${i === 0 ? '' : '\n'}\x1b[2K${line}`).join('')}\x1b[1A\r\x1b[${Math.max(1, cursorCol)}C`);
      inputLinesOnScreen = lines.length;
      inputCursorLineIndex = lines.length - 2;
    };
    const clearStatusLine = () => {
      if (!statusLineActive) return;
      clearInputLine();
      process.stdout.write('\x1b[1A\r\x1b[2K');
      statusLineActive = false;
    };
    const clearBuffer = () => {
      if (outputLineOpen) {
        process.stdout.write('\n');
        outputLineOpen = false;
        return;
      }
      clearInputLine();
    };
    const CURSOR_CONTROL_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ABCDGJK]`, 'g');
    const normalizeStatusText = (text: string) => text
      .replace(CURSOR_CONTROL_RE, '')
      .replace(/^\r+/, '');
    const writeStatus = (text: string) => {
      const normalized = normalizeStatusText(text);
      const isClear = normalized.trim().length === 0;
      if (statusLineActive) {
        clearInputLine();
        process.stdout.write('\x1b[1A\r\x1b[2K');
      } else {
        clearBuffer();
      }
      if (isClear) {
        statusLineActive = false;
        renderBuffer();
        return;
      }
      process.stdout.write(normalized.endsWith('\n') ? normalized : normalized + '\n');
      statusLineActive = !normalized.endsWith('\n');
      renderBuffer();
    };
    const writeOutput = (text: string) => {
      if (text.startsWith('\r')) {
        writeStatus(text);
        return;
      }
      clearStatusLine();
      clearBuffer();
      process.stdout.write(text);
      outputLineOpen = text.length > 0 && !text.endsWith('\n');
      if (!outputLineOpen) renderBuffer();
    };
    renderBuffer();
    const onKeypress = (str: string | undefined, key: readline.Key) => {
      if (key?.ctrl && key.name === 'c') {
        if (buffer) {
          buffer = '';
          pos = 0;
          renderBuffer();
          return;
        }
        writeOutput(t.warning(this.i18n.t('status.cancelled')) + '\n');
        onCancel();
        return;
      }
      if (key?.name === 'return' || key?.name === 'enter') {
        const text = buffer.trim();
        buffer = '';
        pos = 0;
        clearStatusLine();
        clearBuffer();
        if (text) {
          pending.push(text);
        }
        renderBuffer();
        return;
      }
      if (key?.name === 'left') {
        pos = Math.max(0, pos - 1);
        renderBuffer();
        return;
      }
      if (key?.name === 'right') {
        pos = Math.min(buffer.length, pos + 1);
        renderBuffer();
        return;
      }
      if (key?.name === 'backspace') {
        if (pos > 0) {
          buffer = buffer.slice(0, pos - 1) + buffer.slice(pos);
          pos--;
        }
        renderBuffer();
        return;
      }
      if (key?.name === 'delete') {
        if (pos < buffer.length) buffer = buffer.slice(0, pos) + buffer.slice(pos + 1);
        renderBuffer();
        return;
      }
      if (key?.ctrl && key.name === 'a') {
        pos = 0;
        renderBuffer();
        return;
      }
      if (key?.ctrl && key.name === 'e') {
        pos = buffer.length;
        renderBuffer();
        return;
      }
      if (key?.ctrl && key.name === 'u') {
        buffer = '';
        pos = 0;
        renderBuffer();
        return;
      }
      if (str && str >= ' ') {
        buffer = buffer.slice(0, pos) + str + buffer.slice(pos);
        pos += str.length;
        renderBuffer();
      }
    };
    let active = true;
    process.stdin.on('keypress', onKeypress);
    return {
      drain: () => {
        const drained = pending.splice(0, pending.length);
        renderBuffer();
        return drained;
      },
      writeOutput,
      pause: () => {
        if (!active) return;
        active = false;
        process.stdin.removeListener('keypress', onKeypress);
        clearBuffer();
      },
      resume: () => {
        if (active) return;
        active = true;
        process.stdin.on('keypress', onKeypress);
        renderBuffer();
      },
      stop: () => {
        if (active) process.stdin.removeListener('keypress', onKeypress);
        active = false;
        clearStatusLine();
        clearBuffer();
        if (raw) try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      },
    };
  }

  private async _takeWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
    const snapshot: WorkspaceSnapshot = new Map();
    const walk = async (dir: string) => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory() && SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.root, full);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.promises.stat(full);
        if (stat.size > SNAPSHOT_MAX_FILE_SIZE) continue;
        try {
          snapshot.set(rel, await fs.promises.readFile(full));
        } catch { /* ignore unreadable files */ }
      }
    };
    await walk(this.root);
    return snapshot;
  }

  private _snapshotDir(): string {
    return path.join(os.homedir(), '.customize-agent', 'snapshots');
  }

  private _snapshotFile(id: string): string {
    return path.join(this._snapshotDir(), `${id}.json`);
  }

  private _serializeSnapshot(snapshot: WorkspaceSnapshot): SerializedWorkspaceSnapshot {
    return [...snapshot.entries()].map(([rel, content]) => [rel, content.toString('base64')]);
  }

  private _deserializeSnapshot(data: SerializedWorkspaceSnapshot): WorkspaceSnapshot {
    return new Map(data.map(([rel, content]) => [rel, Buffer.from(content, 'base64')]));
  }

  private async _saveWorkspaceSnapshot(id: string, snapshot: WorkspaceSnapshot): Promise<void> {
    await fs.promises.mkdir(this._snapshotDir(), { recursive: true });
    await fs.promises.writeFile(this._snapshotFile(id), JSON.stringify(this._serializeSnapshot(snapshot)), 'utf-8');
  }

  private async _loadWorkspaceSnapshot(id: string): Promise<WorkspaceSnapshot | null> {
    try {
      const raw = await fs.promises.readFile(this._snapshotFile(id), 'utf-8');
      return this._deserializeSnapshot(JSON.parse(raw) as SerializedWorkspaceSnapshot);
    } catch {
      return null;
    }
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

  private async _restoreWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    const current = await this._takeWorkspaceSnapshot();
    for (const [rel] of current) {
      if (!snapshot.has(rel)) {
        await fs.promises.rm(path.join(this.root, rel), { force: true });
      }
    }
    for (const [rel, content] of snapshot) {
      const full = path.join(this.root, rel);
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, content);
    }
  }

  private async _execute(input: string): Promise<void> {
    // 检查是否配置了模型
    const resolved = this.modelRegistry.resolve('action');
    if (!resolved) {
      process.stdout.write('\n' + t.warning(this.i18n.t('cmd.no_model_configured')) + '\n');
      process.stdout.write(t.dim(this.i18n.t('cmd.first_config') + '\n\n'));
      return;
    }

    process.stdout.write('\r\x1b[2K' + userMessageBlock(input, this.i18n.t('message.user')));

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

    const userIndex = this.history.length;
    try {
      const snapshot = await this._takeWorkspaceSnapshot();
      this.snapshots.set(userIndex, snapshot);
      await this._saveWorkspaceSnapshot(this.sessionId, snapshot);
    } catch { /* snapshot is best-effort */ }
    this.history.push({ role: 'user', content: enhancedInput });

    const abortController = new AbortController();
    const taskInput = this._captureInputDuringTask(() => abortController.abort());
    try {
      const updated = await this.executor.runTask(this.history, {
        onEvent: event => {
          if (event.type === 'approval_request') taskInput.pause();
          if (event.type === 'output') taskInput.writeOutput(event.text);
          else if (event.type === 'user_message') taskInput.writeOutput(userMessageBlock(event.text, this.i18n.t('message.user')));
          else this._renderAgentEvent(event);
          if (event.type === 'approval_response') taskInput.resume();
        },
        drainUserInput: () => taskInput.drain(),
        signal: abortController.signal,
      });
      this.history.length = 0;
      this.history.push(...updated);

      if (this.memory) {
        const lastAssistant = [...updated].reverse().find(m => m.role === 'assistant');
        if (lastAssistant?.content) {
          this.memory.remember('project_fact', lastAssistant.content.slice(0, 500), `Task: ${input.slice(0, 200)}`);
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        process.stdout.write(msg.error((err as Error).message));
      }
      this.history.pop();
    } finally {
      taskInput.stop();
    }
  }

  private async _selectList<T>(title: string, items: Array<{ label: string; detail?: string; value: T }>): Promise<T | null> {
    if (!items.length) return null;
    if (!keypressInitialized) {
      readline.emitKeypressEvents(process.stdin);
      keypressInitialized = true;
    }
    let raw = false;
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); raw = true; } catch { /* ignore */ }
    }
    process.stdin.resume();

    let sel = 0;
    let linesDrawn = 0;
    const clear = () => {
      if (linesDrawn <= 0) return;
      process.stdout.write(`\x1b[${linesDrawn}A\r\x1b[0J`);
      linesDrawn = 0;
    };
    const clip = (text: string, width: number) => {
      let out = '';
      for (const ch of text.replace(/\s+/g, ' ')) {
        if (stringWidth(out + ch) > width - 1) return out + '…';
        out += ch;
      }
      return out;
    };
    const draw = () => {
      clear();
      const width = Math.max(40, process.stdout.columns ?? 80);
      const itemWidth = width - 5;
      const lines = [
        s.bold(clip(title, width - 1)),
        ...items.map((item, i) => {
          const cursor = i === sel ? t.accent('▶') : ' ';
          const raw = `${item.label}${item.detail ? `  ${item.detail}` : ''}`;
          const label = clip(raw, itemWidth);
          return `${cursor} ${i === sel ? s.bold(label) : label}`;
        }),
        '',
        t.dim('↑↓  Enter  Esc'),
      ];
      process.stdout.write(lines.join('\n') + '\n');
      linesDrawn = lines.length;
    };

    return new Promise(resolve => {
      const cleanup = () => {
        clear();
        process.stdin.removeListener('keypress', onKey);
        if (raw) try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      };
      const onKey = (_str: string | undefined, key: readline.Key) => {
        if (key.name === 'up') { sel = Math.max(0, sel - 1); draw(); return; }
        if (key.name === 'down') { sel = Math.min(items.length - 1, sel + 1); draw(); return; }
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { cleanup(); resolve(null); return; }
        if (key.name === 'return' || key.name === 'enter') { const value = items[sel]!.value; cleanup(); resolve(value); }
      };
      process.stdin.on('keypress', onKey);
      draw();
    });
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
      case '/model': return this._handleModelCommand(args);
      case '/provider': return this._handleProviderCommand(args);
      case '/rewind': await this._rewind(args); return false;
      case '/resume': await this._resume(args); return false;
      case '/history': case '/sessions': await this._sessions(); return false;
      case '/reset': return this._command('/clear');

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
        try {
          const u = await this.executor.runTask(this.history, {
            readonly: true,
            onEvent: event => {
              if (event.type === 'approval_request') taskInput.pause();
              if (event.type === 'output') taskInput.writeOutput(event.text);
              else if (event.type === 'user_message') taskInput.writeOutput(userMessageBlock(event.text, this.i18n.t('message.user')));
              else this._renderAgentEvent(event);
              if (event.type === 'approval_response') taskInput.resume();
            },
            drainUserInput: () => taskInput.drain(),
            signal: abortController.signal,
          });
          this.history.length = 0; this.history.push(...u);
        } catch (err) {
          if (!abortController.signal.aborted) {
            process.stdout.write(msg.error((err as Error).message));
          }
          this.history.pop();
        } finally {
          taskInput.stop();
        }
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

  private async _rewind(args: string): Promise<void> {
    const userTurns = this.history
      .map((m, i) => ({ message: m, index: i }))
      .filter(x => x.message.role === 'user');
    if (!userTurns.length) {
      process.stdout.write(t.dim(this.i18n.t('cmd.no_rewind') + '\n\n'));
      return;
    }
    const selected = args
      ? userTurns[Math.max(0, userTurns.length - Number.parseInt(args, 10))]
      : await this._selectList(this.i18n.t('help.rewind'), userTurns.slice().reverse().map((turn, i) => ({
          label: `${i + 1}. ${turn.message.content.slice(0, 80).replace(/\n/g, ' ')}`,
          detail: `#${turn.index}`,
          value: turn,
        })));
    if (!selected) return;

    const scope = await this._selectList(this.i18n.t('help.rewind'), [
      { label: this.i18n.t('cmd.rewind_scope_chat'), detail: this.i18n.t('cmd.rewind_scope_chat_desc'), value: 'chat' as const },
      { label: this.i18n.t('cmd.rewind_scope_all'), detail: this.i18n.t('cmd.rewind_scope_all_desc'), value: 'all' as const },
    ]);
    if (!scope) return;

    const original = selected.message.content;
    this.history.splice(selected.index);
    if (scope === 'all') {
      const snapshot = this._findSnapshotForTurn(selected.index) ?? await this._loadWorkspaceSnapshot(this.sessionId);
      if (snapshot) {
        try {
          await this._restoreWorkspaceSnapshot(snapshot);
        } catch {
          process.stdout.write(t.warning(this.i18n.t('cmd.rewind_snapshot_failed') + '\n'));
        }
      } else {
        process.stdout.write(t.warning(this.i18n.t('cmd.rewind_snapshot_missing') + '\n'));
      }
    }
    this.tui.setDraft(original);
    process.stdout.write(t.success(this.i18n.t('cmd.rewind_done') + '\n\n'));
  }

  private async _resume(args: string): Promise<void> {
    const { AuditLogger } = await import('@customize-agent/runtime');
    const sessions = await AuditLogger.listSessions();
    if (!sessions.length) {
      process.stdout.write(t.dim(this.i18n.t('cmd.no_sessions') + '\n\n'));
      return;
    }
    const id = args.trim() && args.trim() !== 'last'
      ? args.trim()
      : await this._selectList(this.i18n.t('help.resume'), sessions.slice(0, 20).map(session => ({
          label: session.taskPreview,
          detail: `${session.id} · ${session.date}`,
          value: session.id,
        })));
    if (!id) return;
    const scope = await this._selectList(this.i18n.t('help.resume'), [
      { label: this.i18n.t('cmd.resume_scope_chat'), detail: this.i18n.t('cmd.resume_scope_chat_desc'), value: 'chat' as const },
      { label: this.i18n.t('cmd.resume_scope_all'), detail: this.i18n.t('cmd.resume_scope_all_desc'), value: 'all' as const },
    ]);
    if (!scope) return;
    const loaded = await AuditLogger.loadHistory(id);
    this.history.length = 0;
    this.history.push({ role: 'system', content: this.executor.getSystemPrompt() }, ...loaded.filter(m => m.role !== 'system'));
    this.sessionId = id;
    if (scope === 'all') {
      const snapshot = await this._loadWorkspaceSnapshot(id);
      if (snapshot) {
        try {
          await this._restoreWorkspaceSnapshot(snapshot);
        } catch {
          process.stdout.write(t.warning(this.i18n.t('cmd.rewind_snapshot_failed') + '\n'));
        }
      } else {
        process.stdout.write(t.warning(this.i18n.t('cmd.rewind_snapshot_missing') + '\n'));
      }
    }
    process.stdout.write(t.success(this.i18n.t('cmd.resume_done', { id }) + '\n\n'));
  }

  // ── /model & /provider ──

  private _handleModelCommand(args: string): boolean {
    if (!args) { this._showModelView(); return false; }
    const parts = args.split(/\s+/);
    const sub = parts[0]!; const rest = parts.slice(1);
    switch (sub) {
      case 'add': {
        if (rest.length < 3) { process.stdout.write(t.warning(this.i18n.t('model.add_usage')+'\n\n')); return false; }
        const tier = rest[0]! as ModelTier;
        if (!['reader','reasoning','action'].includes(tier)) { process.stdout.write(t.error(this.i18n.t('model.invalid_tier',{tier})+'\n\n')); return false; }
        const prov = rest[1]!; const name = rest.slice(2).join(' ');
        this.configStore.addModel(tier, { name, provider: prov });
        process.stdout.write(t.success(this.i18n.t('model.added',{name,provider:prov,tier:this.i18n.t('tier.'+tier)||tier})+'\n\n'));
        return false;
      }
      case 'set': {
        if (rest.length < 2) { process.stdout.write(t.warning(this.i18n.t('model.set_usage')+'\n\n')); return false; }
        const tier = rest[0]! as ModelTier;
        if (!['reader','reasoning','action'].includes(tier)) { process.stdout.write(t.error(this.i18n.t('model.invalid_tier',{tier})+'\n\n')); return false; }
        const name = rest.slice(1).join(' ');
        this.configStore.setActiveModel(tier, name);
        process.stdout.write(t.success(this.i18n.t('model.active_set',{tier:this.i18n.t('tier.'+tier)||tier,name})+'\n\n'));
        return false;
      }
      case 'rm': {
        if (rest.length < 2) { process.stdout.write(t.warning(this.i18n.t('model.rm_usage')+'\n\n')); return false; }
        const tier = rest[0]! as ModelTier;
        if (!['reader','reasoning','action'].includes(tier)) { process.stdout.write(t.error(this.i18n.t('model.invalid_tier',{tier})+'\n\n')); return false; }
        const name = rest.slice(1).join(' ');
        this.configStore.removeModel(tier, name);
        process.stdout.write(t.success(this.i18n.t('model.removed',{name,tier:this.i18n.t('tier.'+tier)||tier})+'\n\n'));
        return false;
      }
      case 'key': {
        if (rest.length < 2) { process.stdout.write(t.warning(this.i18n.t('model.key_usage')+'\n\n')); return false; }
        const prov = rest[0]!; const key = rest.slice(1).join(' ');
        const cleanKey = key.trim();
        this.configStore.setProviderKey(prov, cleanKey);
        const masked = cleanKey.length > 10 ? cleanKey.slice(0,6) + '****' + cleanKey.slice(-4) : '****';
        process.stdout.write(t.success(this.i18n.t('model.key_set',{provider:prov,masked})+'\n\n'));
        return false;
      }
      case 'fallback': { this._showFallbackChains(); return false; }
      default: { process.stdout.write(t.warning(this.i18n.t('model.unknown_subcmd',{sub})+'\n\n')); return false; }
    }
  }

  private _handleProviderCommand(args: string): boolean {
    if (!args) { this._showProviderList(); return false; }
    const parts = args.split(/\s+/);
    const sub = parts[0]!; const rest = parts.slice(1);
    switch (sub) {
      case 'key': {
        if (rest.length < 2) { process.stdout.write(t.warning(this.i18n.t('provider.key_usage')+'\n\n')); return false; }
        this.configStore.setProviderKey(rest[0]!, rest.slice(1).join(' ').trim());
        process.stdout.write(t.success(this.i18n.t('provider.key_set',{name:rest[0]!})+'\n\n'));
        return false;
      }
      case 'url': {
        if (rest.length < 2) { process.stdout.write(t.warning(this.i18n.t('provider.url_usage')+'\n\n')); return false; }
        this.configStore.setProviderUrl(rest[0]!, rest.slice(1).join(' '));
        process.stdout.write(t.success(this.i18n.t('provider.url_set',{name:rest[0]!})+'\n\n'));
        return false;
      }
      case 'protocol': {
        if (rest.length < 2) { process.stdout.write(t.warning(this.i18n.t('provider.protocol_usage')+'\n\n')); return false; }
        this.configStore.setProviderProtocol(rest[0]!, rest[1]!);
        process.stdout.write(t.success(this.i18n.t('provider.protocol_set',{name:rest[0]!,protocol:rest[1]!})+'\n\n'));
        return false;
      }
      default: { process.stdout.write(t.warning(this.i18n.t('provider.unknown_subcmd',{sub})+'\n\n')); return false; }
    }
  }

  private _showModelView(): void {
    const cfg = this.configStore.load();
    const tiers: ModelTier[] = ['reader','reasoning','action'];

    process.stdout.write('\n');
    for (const tier of tiers) {
      const tc = cfg.models[tier];
      const r = this.modelRegistry.resolve(tier);
      const label = this.i18n.t('tier.'+tier) || tier;
      const desc = this.i18n.t('tier.'+tier+'_desc') || '';
      const icon = tier==='reader'?t.blue('◆'):tier==='reasoning'?t.purple('◆'):t.success('◆');
      process.stdout.write(`  ${icon} ${s.bold(label)}  ${t.faint(desc)}\n`);
      if (!tc.list.length) {
        process.stdout.write(`    ${t.faint(this.i18n.t('model.empty'))}\n`);
      } else {
        for (const m of tc.list) {
          const mark = m.name===tc.active?t.accent('▶'):' ';
          const keyOk = cfg.providers[m.provider]?.apiKey ? t.success('🔑') : t.faint('🔒');
          process.stdout.write(`    ${mark} ${m.name}  ${t.dim('@'+m.provider)} ${keyOk}\n`);
        }
      }
      if (r && r.name!==tc.active) {
        process.stdout.write(`    ${t.faint('→ '+this.i18n.t('model.fallback_label')+' '+r.name)}\n`);
      }
    }
    process.stdout.write('\n');
    process.stdout.write(`  ${t.dim(this.i18n.t('model.quick_start'))}\n`);
    process.stdout.write(`  ${t.dim(this.i18n.t('model.example_add'))}\n`);
    process.stdout.write(`  ${t.dim(this.i18n.t('model.example_key'))}\n`);
    process.stdout.write(`  ${t.dim(this.i18n.t('model.example_more'))}\n`);
    process.stdout.write('\n');
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

  private _showProviderList(): void {
    const cfg = this.configStore.load();
    const names = Object.keys(cfg.providers);
    if (!names.length) { process.stdout.write(t.dim(this.i18n.t('provider.none')+'\n\n')); return; }
    process.stdout.write('\n');
    for (const name of names) {
      const p = cfg.providers[name]!;
      const proto = resolveProtocol(name, p);
      const keyIcon = p.apiKey ? t.success('🔑') : t.faint('🔒');
      process.stdout.write(`  ${s.bold(name)}  ${t.dim('protocol: '+proto)}  ${keyIcon}\n`);
    }
    process.stdout.write(`\n  ${t.dim(this.i18n.t('provider.hint'))}\n\n`);
  }

  private _showFallbackChains(): void {
    for (const tier of ['reader','reasoning','action'] as ModelTier[]) {
      const chain = this.modelRegistry.getFallbackChain(tier);
      const parts = chain.map(c => `${c.model.name} ${t.dim('('+this.i18n.t('tier.'+c.from)+')')}`);
      const sep = this.i18n.t('model.chain_separator');
      process.stdout.write(`${s.bold(this.i18n.t('tier.'+tier)||tier)}: ${parts.join(sep)}\n`);
    }
    process.stdout.write('\n');
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

  private _buildTui(cmds?: Array<{ name: string; desc: string }>): void {
    const defaults: Array<{ name: string; desc: string }> = [
      { name: '/plan',     desc: this.i18n.t('help.plan') },
      { name: '/rewind',   desc: this.i18n.t('help.rewind') },
      { name: '/resume',   desc: this.i18n.t('help.resume') },
      { name: '/clear',    desc: this.i18n.t('help.clear') },
      { name: '/reset',    desc: this.i18n.t('help.clear') },
      { name: '/sessions', desc: this.i18n.t('help.sessions') },
      { name: '/history',  desc: this.i18n.t('help.sessions') },
      { name: '/model',    desc: this.i18n.t('help.model') },
      { name: '/provider', desc: this.i18n.t('help.provider') },
      { name: '/memory',   desc: this.i18n.t('help.memory') },
      { name: '/language', desc: this.i18n.t('help.language') },
      { name: '/help',     desc: this.i18n.t('help.help') },
      { name: '/exit',     desc: this.i18n.t('help.exit') },
    ];
    this.tui = new TuiInput({
      projectRoot: this.root,
      commands: cmds ?? defaults,
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
      configHint: hasModels ? undefined : this.i18n.t('cmd.first_config'),
    }));
  }

  private async _sessions(): Promise<void> {
    try {
      const { AuditLogger } = await import('@customize-agent/runtime');
      const sessions = await AuditLogger.listSessions();
      if (!sessions.length) { process.stdout.write(t.dim(this.i18n.t('cmd.no_sessions') + '\n\n')); return; }
      process.stdout.write(t.dim(`${this.i18n.t('cmd.sessions_total')} ${sessions.length}\n`));
      for (const s of sessions.slice(0, 20)) {
        process.stdout.write(`  ${t.text(s.id)}\n    ${t.dim(this.i18n.t('session.date_label') + ':')} ${s.date}  ${t.dim(this.i18n.t('session.events_label') + ':')} ${s.eventCount}\n    ${t.dim(this.i18n.t('session.task_label') + ':')} ${s.taskPreview}\n\n`);
      }
    } catch (err) { process.stdout.write(t.error(`Error: ${(err as Error).message}\n\n`)); }
  }
}
