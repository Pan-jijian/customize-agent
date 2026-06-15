import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import type { Message } from '@code-agent/types';
import type { AgentExecutor } from './engine/executor.js';
import { TuiInput } from './tui/input.js';
import { welcomeBanner, t, s, divider, errorMsg } from './tui/renderer.js';

/** REPL 配置 */
export interface ReplConfig {
  executor: AgentExecutor;
  /** 项目文件列表（相对路径，供 @ 匹配） */
  files: string[];
  /** 项目根目录（供 @file 内容读取） */
  projectRoot: string;
  /** 命令 */
  commands?: Array<{ name: string; desc: string }>;
  /** 共享 readline（供审批处理器） */
  rl: readline.Interface;
}

/** @file 引用正则 */
const RE_AT = /@([^\s@]+(?::\d+(?:-\d+)?)?)/g;

/**
 * REPL — 会话管理 + TUI 输入 + 消息格式化。
 */
export class Repl {
  private executor: AgentExecutor;
  private rl: readline.Interface;
  private tui: TuiInput;
  private history: Message[];
  private root: string;

  constructor(config: ReplConfig) {
    this.executor = config.executor;
    this.rl = config.rl;
    this.root = config.projectRoot;
    this.history = [{ role: 'system', content: this.executor.getSystemPrompt() }];
    this.tui = new TuiInput({
      files: config.files,
      projectRoot: config.projectRoot,
      commands: config.commands ?? [],
      prompt: '❯',
      mode: 'AGENT',
    });
  }

  /** 获取共享的 readline */
  getReadline(): readline.Interface { return this.rl; }

  /** 启动 REPL */
  async start(): Promise<void> {
    process.stdout.write(welcomeBanner('3.0.0', this.executor.providerName));

    while (true) {
      const input = await this.tui.read();
      if (!input) continue;

      // /command 分发
      if (input.startsWith('/')) {
        const done = await this._command(input);
        if (done) break;
        continue;
      }

      // 普通任务 — 先解析 @file 引用再执行
      const enhanced = await this._resolveAtRefs(input);
      await this._execute(enhanced);
    }

    console.log('👋 Goodbye.');
  }

  // ═══════════════════════════════════════
  // @file 解析
  // ═══════════════════════════════════════

  /** 扫描文本中的 @file 引用，读取内容并拼接到 prompt */
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
        parts.push(`[文件: ${ref.filePath}${ref.startLine ? ` L${ref.startLine}-${ref.endLine}` : ''}]\n${snippet}`);
      } catch { parts.push(`[文件未找到: ${ref.filePath}]`); }
    }

    const cleanText = text.replace(RE_AT, '').trim();
    const ctx = parts.join('\n\n');
    return cleanText ? `${cleanText}\n\n参考文件:\n${ctx}` : `请分析以下文件:\n${ctx}`;
  }

  // ═══════════════════════════════════════
  // 任务执行
  // ═══════════════════════════════════════

  private async _execute(input: string): Promise<void> {
    this.history.push({ role: 'user', content: input });
    process.stdout.write('\n');

    try {
      const updated = await this.executor.runTask(this.history);
      this.history.length = 0;
      this.history.push(...updated);

      const last = [...updated].reverse().find(m => m.role === 'assistant');
      if (last?.content) {
        const txt = last.content.replace(/<call_tool[\s\S]*?<\/call_tool>/g, '').trim();
        if (txt) process.stdout.write(`\n${txt}\n`);
      }
      process.stdout.write('\n');
    } catch (err) {
      process.stdout.write(errorMsg((err as Error).message));
      this.history.pop();
    }
  }

  // ═══════════════════════════════════════
  // /commands
  // ═══════════════════════════════════════

  private async _command(raw: string): Promise<boolean> {
    const sp = raw.indexOf(' ');
    const cmd = sp > 0 ? raw.slice(0, sp) : raw;
    const args = sp > 0 ? raw.slice(sp + 1).trim() : '';

    switch (cmd) {
      case '/exit': case '/quit': return true;
      case '/clear':
        this.history.length = 0;
        this.history.push({ role: 'system', content: this.executor.getSystemPrompt() });
        process.stdout.write(t.green('✓ Session cleared.\n\n'));
        return false;
      case '/help':
        process.stdout.write(`
${s.bold('Commands:')}
  ${t.cyan('/plan <task>')}    ${t.dim('Plan mode — read-only exploration')}
  ${t.cyan('/clear')}         ${t.dim('Reset session')}
  ${t.cyan('/sessions')}      ${t.dim('View session history')}
  ${t.cyan('/model [name]')}  ${t.dim('Show/switch model')}
  ${t.cyan('/help')}          ${t.dim('Show this help')}
  ${t.cyan('/exit')}          ${t.dim('Quit')}

${s.bold('Tips:')}
  ${t.purple('@file')}          ${t.dim('Attach file (fuzzy match + content injection)')}
  ${t.purple('@file:10-30')}    ${t.dim('Attach specific lines')}
  ${t.purple('↑↓')}            ${t.dim('Navigate history / dropdown')}
  ${t.purple('Tab')}            ${t.dim('Complete dropdown selection')}
`);
        return false;
      case '/sessions': await this._sessions(); return false;
      case '/model':
        if (!args) { process.stdout.write(`${t.dim('Model:')} ${t.text(this.executor.providerName)}\n\n`); }
        else { process.stdout.write(t.yellow('⚠ Model switching requires restart with --model flag.\n\n')); }
        return false;
      case '/plan': {
        if (!args) { process.stdout.write(t.yellow('⚠ Usage: /plan <task description>\n\n')); return false; }
        process.stdout.write(divider('Plan Mode') + '\n' + t.dim(`  ${args}\n\n`));
        const prompt = `制定执行计划（只读探索，不修改任何文件）。\n\n任务: ${args}\n\n输出执行计划并用 <task_finish> 结束。`;
        this.history.push({ role: 'user', content: prompt });
        try { const u = await this.executor.runTask(this.history, { readonly: true }); this.history.length = 0; this.history.push(...u); }
        catch (err) { process.stdout.write(errorMsg((err as Error).message)); this.history.pop(); }
        process.stdout.write(divider('Plan Complete') + '\n\n');
        return false;
      }
      default:
        process.stdout.write(t.yellow(`Unknown: ${cmd}. Type /help for commands.\n\n`));
        return false;
    }
  }

  private async _sessions(): Promise<void> {
    try {
      const { AuditLogger } = await import('@code-agent/telemetry');
      const sessions = await AuditLogger.listSessions();
      if (!sessions.length) { process.stdout.write(t.dim('No sessions.\n\n')); return; }
      process.stdout.write(t.dim(`Total: ${sessions.length}\n`));
      for (const s of sessions.slice(0, 20)) {
        process.stdout.write(`  ${t.text(s.id)}\n    ${t.dim('Date:')} ${s.date}  ${t.dim('Events:')} ${s.eventCount}\n    ${t.dim('Task:')} ${s.taskPreview}\n\n`);
      }
    } catch (err) { process.stdout.write(t.red(`Error: ${(err as Error).message}\n\n`)); }
  }
}
