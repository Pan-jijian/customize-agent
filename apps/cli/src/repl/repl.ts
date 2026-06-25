import * as fs from 'fs';
import * as path from 'path';
import type { Message } from '@customize-agent/types';
import type { AgentExecutor } from '../agent/executor.js';
import { TuiInput } from '../tui/input.js';
import { welcomeBanner, t, s, divider, errorMsg, infoMsg, contextStats } from '../tui/renderer.js';
import type { MemoryManager } from '@customize-agent/memory';
import { BINARY_EXTENSIONS } from '@customize-agent/types';
import type { ConfigStore, ModelRegistry, ModelTier } from '@customize-agent/runtime';
import type { I18nManager } from '../i18n/manager.js';

const TIER_LABELS: Record<ModelTier, string> = {
  reader: 'Reader',
  reasoning: 'Reasoning',
  action: 'Action',
};

/** REPL 配置 */
export interface ReplConfig {
  executor: AgentExecutor;
  files: string[];
  projectRoot: string;
  commands?: Array<{ name: string; desc: string }>;
  memory?: MemoryManager;
  i18n: I18nManager;
  configStore: ConfigStore;
  modelRegistry: ModelRegistry;
}

/** @file 引用正则（排除邮箱地址：前面必须为空白或行首） */
const RE_AT = /(?:^|\s)@([^\s@]+(?::\d+(?:-\d+)?)?)/g;
const MAX_INLINE_SIZE = 500_000;

/**
 * REPL — 会话管理 + TUI 输入 + 消息格式化 + 斜杠命令。
 */
export class Repl {
  public executor: AgentExecutor;
  private tui: TuiInput;
  private history: Message[];
  private root: string;
  private memory?: MemoryManager;
  private i18n: I18nManager;
  private configStore: ConfigStore;
  private modelRegistry: ModelRegistry;

  constructor(config: ReplConfig) {
    this.executor = config.executor;
    this.root = config.projectRoot;
    this.memory = config.memory;
    this.i18n = config.i18n;
    this.configStore = config.configStore;
    this.modelRegistry = config.modelRegistry;
    this.history = [{ role: 'system', content: this.executor.getSystemPrompt() }];
    const cmds = config.commands ?? [
      { name: '/plan',     desc: this.i18n.t('help.plan') },
      { name: '/clear',    desc: this.i18n.t('help.clear') },
      { name: '/sessions', desc: this.i18n.t('help.sessions') },
      { name: '/model',    desc: this.i18n.t('help.model') },
      { name: '/language', desc: this.i18n.t('help.language') },
      { name: '/help',     desc: this.i18n.t('help.help') },
      { name: '/exit',     desc: this.i18n.t('help.exit') },
    ];
    this.tui = new TuiInput({
      files: config.files,
      projectRoot: config.projectRoot,
      commands: cmds,
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
    });
  }

  /** 启动 REPL */
  async start(): Promise<void> {
    // 首次进入提示配置
    const config = this.configStore.load();
    const hasModels = config.models.reader.list.length > 0
                   || config.models.reasoning.list.length > 0
                   || config.models.action.list.length > 0;
    process.stdout.write(welcomeBanner('0.0.3', this.executor.providerName, {
      title: this.i18n.t('welcome.title'),
      providerLabel: this.i18n.t('welcome.provider_label'),
      startHint: this.i18n.t('welcome.start_hint'),
      usageHints: this.i18n.t('welcome.usage_hints'),
      configHint: hasModels ? undefined : this.i18n.t('cmd.first_config'),
    }));

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

  private async _execute(input: string): Promise<void> {
    // 检查是否配置了模型
    const resolved = this.modelRegistry.resolve('action');
    if (!resolved) {
      process.stdout.write('\n' + t.warning(this.i18n.t('cmd.no_model_configured')) + '\n');
      process.stdout.write(t.dim(this.i18n.t('cmd.first_config') + '\n\n'));
      return;
    }

    let enhancedInput = input;
    if (this.memory) {
      const memories = this.memory.recall(input, 3);
      if (memories.length > 0) {
        const memoryLines = memories.map((m: { type: string; content: string }) => {
          const label = m.type === 'feedback' ? this.i18n.t('memory.feedback') : m.type === 'user_preference' ? this.i18n.t('memory.user_preference') : this.i18n.t('memory.project_knowledge');
          return `[Memory·${label}]: ${m.content}`;
        });
        enhancedInput = `${input}\n\n${this.i18n.t('memory.section_header')}\n${memoryLines.join('\n')}\n${this.i18n.t('memory.section_footer')}`;
      }
    }

    this.history.push({ role: 'user', content: enhancedInput });
    process.stdout.write('\n');

    try {
      const updated = await this.executor.runTask(this.history);
      this.history.length = 0;
      this.history.push(...updated);

      if (this.memory) {
        const lastAssistant = [...updated].reverse().find(m => m.role === 'assistant');
        if (lastAssistant?.content) {
          this.memory.remember('project_fact', lastAssistant.content.slice(0, 500), `Task: ${input.slice(0, 200)}`);
        }
      }

      const last = [...updated].reverse().find(m => m.role === 'assistant');
      if (last?.content) {
        const txt = last.content.replace(/<task_finish>[\s\S]*?<\/task_finish>/g, '').trim();
        if (txt) process.stdout.write(`\n${t.text(txt)}\n`);
      }
      process.stdout.write('\n');
    } catch (err) {
      process.stdout.write(errorMsg((err as Error).message));
      this.history.pop();
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
          this.i18n.setLanguage(args);
          this.configStore.set('language', args);
          process.stdout.write(t.success(`${this.i18n.t('cmd.language_changed')} ${args}\n\n`));
        } else {
          // 无参数或无效 → 弹出语言选择面板
          this._showLanguageSelector();
        }
        return false;
      }

      case '/model': {
        return this._handleModelCommand(args);
      }

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
        this.history.length = 0;
        this.history.push({ role: 'system', content: this.executor.getSystemPrompt() });
        process.stdout.write(t.success(this.i18n.t('context.session_cleared') + '\n\n'));
        return false;

      case '/help':
        process.stdout.write(`
${s.bold(this.i18n.t('help.title')) + ':'}
  ${t.accent('/plan <task>')}    ${t.dim(this.i18n.t('help.plan'))}
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

      case '/sessions': await this._sessions(); return false;

      case '/plan': {
        if (!args) { process.stdout.write(t.warning(this.i18n.t('cmd.plan_usage') + '\n\n')); return false; }
        process.stdout.write('\n' + divider(this.i18n.t('plan.banner')) + '\n');
        process.stdout.write(infoMsg(args) + '\n\n');
        const prompt = `Create an execution plan (read-only, do not modify files).\n\nTask: ${args}\n\nOutput the plan and end with <task_finish>.`;
        this.history.push({ role: 'user', content: prompt });
        try {
          const u = await this.executor.runTask(this.history, { readonly: true });
          this.history.length = 0; this.history.push(...u);
        } catch (err) {
          process.stdout.write(errorMsg((err as Error).message));
          this.history.pop();
        }
        process.stdout.write('\n' + divider(this.i18n.t('plan.complete')) + '\n\n');
        return false;
      }

      default:
        process.stdout.write(t.warning(`${this.i18n.t('cmd.unknown')} ${cmd}. ${this.i18n.t('help.help')}: /help\n\n`));
        return false;
    }
  }

  /**
   * /model 命令处理器。
   *
   * /model list                          — 显示所有层模型配置
   * /model add <tier> <provider> <name>  — 添加模型到指定层
   * /model set <tier> <name>             — 切换该层激活模型
   * /model rm <tier> <name>              — 移除模型
   * /model fallback                      — 查看回退路径
   */
  private _handleModelCommand(args: string): boolean {
    if (!args) {
      this._showModelList();
      return false;
    }

    const parts = args.split(/\s+/);
    const sub = parts[0]!;
    const rest = parts.slice(1);

    switch (sub) {
      case 'list': this._showModelList(); return false;

      case 'add': {
        if (rest.length < 3) {
          process.stdout.write(t.warning(this.i18n.t('model.add_usage') + '\n\n'));
          return false;
        }
        const tier = rest[0]! as ModelTier;
        if (!TIER_LABELS[tier]) {
          process.stdout.write(t.error(this.i18n.t('model.invalid_tier', { tier }) + '\n\n'));
          return false;
        }
        const provider = rest[1]!;
        const name = rest.slice(2).join(' ');
        this.configStore.addModel(tier, { name, provider });
        process.stdout.write(t.success(this.i18n.t('model.added', { name, provider, tier: TIER_LABELS[tier]! }) + '\n\n'));
        return false;
      }

      case 'set': {
        if (rest.length < 2) {
          process.stdout.write(t.warning(this.i18n.t('model.set_usage') + '\n\n'));
          return false;
        }
        const tier = rest[0]! as ModelTier;
        if (!TIER_LABELS[tier]) {
          process.stdout.write(t.error(this.i18n.t('model.invalid_tier', { tier }) + '\n\n'));
          return false;
        }
        const name = rest.slice(1).join(' ');
        this.configStore.setActiveModel(tier, name);
        process.stdout.write(t.success(this.i18n.t('model.active_set', { tier: TIER_LABELS[tier]!, name }) + '\n\n'));
        return false;
      }

      case 'rm': {
        if (rest.length < 2) {
          process.stdout.write(t.warning(this.i18n.t('model.rm_usage') + '\n\n'));
          return false;
        }
        const tier = rest[0]! as ModelTier;
        if (!TIER_LABELS[tier]) {
          process.stdout.write(t.error(this.i18n.t('model.invalid_tier', { tier }) + '\n\n'));
          return false;
        }
        const name = rest.slice(1).join(' ');
        this.configStore.removeModel(tier, name);
        process.stdout.write(t.success(this.i18n.t('model.removed', { name, tier: TIER_LABELS[tier]! }) + '\n\n'));
        return false;
      }

      case 'key': {
        if (rest.length < 3) {
          process.stdout.write(t.warning(this.i18n.t('model.key_usage') + '\n\n'));
          return false;
        }
        const tier = rest[0]! as ModelTier;
        if (!TIER_LABELS[tier]) {
          process.stdout.write(t.error(this.i18n.t('model.invalid_tier', { tier }) + '\n\n'));
          return false;
        }
        const name = rest[1]!;
        const apiKey = rest.slice(2).join(' ');
        try {
          this.configStore.setModelKey(tier, name, apiKey);
          const masked = apiKey.slice(0, 8) + '...' + apiKey.slice(-4);
          process.stdout.write(t.success(this.i18n.t('model.key_set', { name, masked }) + '\n\n'));
        } catch (err) {
          process.stdout.write(t.error((err as Error).message + '\n\n'));
        }
        return false;
      }

      case 'fallback': {
        this._showFallbackChains();
        return false;
      }

      default:
        process.stdout.write(t.warning(this.i18n.t('model.unknown_subcmd', { sub }) + '\n\n'));
        return false;
    }
  }

  private _showModelList(): void {
    const config = this.configStore.load();
    const tiers: ModelTier[] = ['reader', 'reasoning', 'action'];

    for (const tier of tiers) {
      const tc = config.models[tier];
      const resolved = this.modelRegistry.resolve(tier);
      const activeName = tc.active || this.i18n.t('model.no_active');
      process.stdout.write(s.bold(`${TIER_LABELS[tier]}`) + `  active: ${t.accent(activeName)}`);
      if (resolved && resolved.name !== tc.active) {
        process.stdout.write(t.dim(`  ${this.i18n.t('model.fallback_label')} ${resolved.name}`));
      }
      process.stdout.write('\n');
      if (tc.list.length === 0) {
        process.stdout.write(t.dim('  ' + this.i18n.t('model.empty') + '\n'));
      } else {
        for (const m of tc.list) {
          const marker = m.name === tc.active ? t.accent(' ▶') : '  ';
          const keyStatus = m.apiKey ? t.success(' 🔑') : '';
          process.stdout.write(`${marker} ${m.name}  ${t.dim('@' + m.provider)}${keyStatus}\n`);
        }
      }
    }
    process.stdout.write('\n');
    process.stdout.write(t.dim(this.i18n.t('model.commands_hint') + '\n\n'));
  }

  private _showFallbackChains(): void {
    const tiers: ModelTier[] = ['reader', 'reasoning', 'action'];
    for (const tier of tiers) {
      const chain = this.modelRegistry.getFallbackChain(tier);
      const parts = chain.map(c => `${c.model.name} ${t.dim(`(${TIER_LABELS[c.from]})`)}`);
      const sep = this.i18n.t('model.chain_separator');
      process.stdout.write(`${s.bold(TIER_LABELS[tier])}: ${parts.join(sep)}\n`);
    }
    process.stdout.write('\n');
  }

  /** 弹出语言选择面板（TUI raw-mode） */
  private async _showLanguageSelector(): Promise<void> {
    // 暂停 TuiInput raw mode，临时切换到 language selector 的 raw mode
    process.stdin.pause();
    process.stdin.removeAllListeners('keypress');
    try { process.stdin.setRawMode(false); } catch { /* */ }

    const { selectLanguage } = await import('../tui/language-selector.js');
    const lang = await selectLanguage({
      title: this.i18n.t('lang.select.title'),
      prompt: this.i18n.t('lang.select.prompt'),
      zhLabel: this.i18n.t('lang.select.zh'),
      enLabel: this.i18n.t('lang.select.en'),
    });
    this.i18n.setLanguage(lang);
    this.configStore.set('language', lang);

    process.stdout.write(t.success(`${this.i18n.t('cmd.language_changed')} ${lang}\n\n`));
  }

  private async _sessions(): Promise<void> {
    try {
      const { AuditLogger } = await import('@customize-agent/runtime');
      const sessions = await AuditLogger.listSessions();
      if (!sessions.length) { process.stdout.write(t.dim(this.i18n.t('cmd.no_sessions') + '\n\n')); return; }
      process.stdout.write(t.dim(`${this.i18n.t('context.sessions_total')} ${sessions.length}\n`));
      for (const s of sessions.slice(0, 20)) {
        process.stdout.write(`  ${t.text(s.id)}\n    ${t.dim(this.i18n.t('session.date_label') + ':')} ${s.date}  ${t.dim(this.i18n.t('session.events_label') + ':')} ${s.eventCount}\n    ${t.dim(this.i18n.t('session.task_label') + ':')} ${s.taskPreview}\n\n`);
      }
    } catch (err) { process.stdout.write(t.error(`Error: ${(err as Error).message}\n\n`)); }
  }
}
