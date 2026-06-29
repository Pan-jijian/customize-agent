/**
 * TUI 渲染 — ANSI + Unicode 框线。Modern 256-color palette.
 *    accent #5fd7ff → 81    blue    #5f87ff → 69
 *    purple #d787ff → 177   success #87d787 → 114
 *    warn   #ffd787 → 222   error   #ff8787 → 210
 *    text   #eeeeee → 255   dim     #808080 → 244
 */
import { bannerText } from './big-text.js';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

const CSI = '\x1b[';

function c(t: string, code: number): string { return `${CSI}38;5;${code}m${t}${CSI}39m`; }
function cb(t: string, fg: number, bg: number): string { return `${CSI}38;5;${fg}m${CSI}48;5;${bg}m${t}${CSI}39;49m`; }

export const t = {
  accent:    (s: string) => c(s, 81),
  blue:      (s: string) => c(s, 69),
  purple:    (s: string) => c(s, 177),
  success:   (s: string) => c(s, 114),
  warning:   (s: string) => c(s, 222),
  error:     (s: string) => c(s, 210),
  white:     (s: string) => c(s, 255),
  text:      (s: string) => c(s, 252),
  dim:       (s: string) => c(s, 244),
  subtle:    (s: string) => c(s, 240),
  faint:     (s: string) => c(s, 236),
  selected:  (s: string) => cb(s, 255, 240),
  badge:     (s: string) => cb(s, 232, 81),
  planBadge: (s: string) => cb(s, 232, 69),
};

export const s = {
  bold:      (t: string) => `${CSI}1m${t}${CSI}22m`,
  dim:       (t: string) => `${CSI}2m${t}${CSI}22m`,
  italic:    (t: string) => `${CSI}3m${t}${CSI}23m`,
  inverse:   (t: string) => `${CSI}7m${t}${CSI}27m`,
  underline: (t: string) => `${CSI}4m${t}${CSI}24m`,
};

export function formatDuration(ms: number): string {
  const seconds = Math.max(ms / 1000, 0.1);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

// ── 框线字符 ──
const B = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

function tw(): number {
  return Math.max(60, Math.min(process.stdout.columns ?? 80, 200));
}

export type Mode = 'AGENT' | 'PLAN';

// ── 模式辅助函数 ──
export function modeAccent(mode: Mode): (s: string) => string {
  return mode === 'PLAN' ? t.blue : t.accent;
}

export function modeBadge(mode: Mode): string {
  return mode === 'PLAN' ? t.planBadge(` ${mode} `) : t.badge(` ${mode} `);
}

// ── 带标签分隔线 ──
export function divider(label: string): string {
  const w = tw();
  const side = Math.max(0, Math.floor((w - visibleLen(label) - 6) / 2));
  return '\n' + t.subtle('─'.repeat(side) + '  ' + s.bold(t.purple(label)) + '  ' + '─'.repeat(side)) + '\n';
}

// ── 统一消息样式系统 ──

/** 消息类型对应的颜色/图标 */
const MSG_BLUE    = { border: (x: string) => t.blue(x),    icon: t.blue('ℹ'),   title: (x: string) => s.bold(t.blue(x)) };
const MSG_WARN    = { border: (x: string) => t.warning(x), icon: t.warning('⚡'), title: (x: string) => s.bold(t.warning(x)) };
const MSG_ERR     = { border: (x: string) => t.error(x),   icon: t.error('✗'),  title: (x: string) => s.bold(t.error(x)) };
const MSG_SUCCESS = { border: (x: string) => t.success(x), icon: t.success('✓'), title: (x: string) => s.bold(t.success(x)) };

const MSG_MAP = { info: MSG_BLUE, warn: MSG_WARN, error: MSG_ERR, success: MSG_SUCCESS } as const;
type MsgType = keyof typeof MSG_MAP;

function _msgBox(type: MsgType, text: string, title?: string): string {
  const style = MSG_MAP[type];
  const lines = text.split('\n');
  const result: string[] = [];

  result.push('');
  if (title) {
    result.push('  ' + style.title(title));
  }
  for (const line of lines) {
    result.push('  ' + style.icon + ' ' + t.text(line));
  }
  result.push('');
  return result.join('\n');
}

/** 统一消息 API */
export const msg = {
  info:    (text: string, title?: string) => _msgBox('info', text, title),
  warn:    (text: string, title?: string) => _msgBox('warn', text, title),
  error:   (text: string, title?: string) => _msgBox('error', text, title),
  success: (text: string, title?: string) => _msgBox('success', text, title),
};

export function userMessageBlock(text: string, labelTextValue = 'User', variant: 'user' | 'queued' = 'user'): string {
  const maxInner = Math.max(12, Math.min(tw() - 6, 88));
  const labelText = ` ${labelTextValue} `;
  const renderedLabel = variant === 'queued' ? cb(labelText, 232, 220) : t.badge(labelText);
  const lines = wrapAnsi(text, maxInner, { hard: true }).split('\n');
  const inner = Math.min(maxInner, Math.max(stringWidth(labelText), ...lines.map(line => stringWidth(line))));
  const out: string[] = [''];
  out.push(`${t.subtle('╭')}${renderedLabel}${t.subtle('─'.repeat(Math.max(1, inner + 2 - stringWidth(labelText))))}${t.subtle('╮')}`);
  for (const line of lines) {
    const pad = ' '.repeat(Math.max(0, inner - stringWidth(line)));
    out.push(`${t.subtle('│')} ${t.text(line)}${pad} ${t.subtle('│')}`);
  }
  out.push(`${t.subtle('╰')}${t.subtle('─'.repeat(inner + 2))}${t.subtle('╯')}`);
  return out.join('\n') + '\n';
}

// ── 欢迎横幅 ──
export function welcomeBanner(version: string, provider: string, opts?: {
  title?: string; providerLabel?: string; startHint?: string; usageHints?: string; configHint?: string;
}): string {
  const title = opts?.title ?? 'Customize Agent';
  const providerLabel = opts?.providerLabel ?? 'Provider';
  const startHint = opts?.startHint ?? 'Type a task to begin';
  const usageHints = opts?.usageHints ?? '@ attach files   / commands   ↑↓ history';
  const configHint = opts?.configHint ?? '';
  const W = tw();
  const pad = (s: string) => '  ' + s + ' '.repeat(Math.max(0, W - 4 - visibleLen(s)));
  const center = (s: string) => {
    const vLen = visibleLen(s);
    const left = Math.floor((W - 4 - vLen) / 2);
    return '  ' + ' '.repeat(Math.max(0, left)) + s;
  };

  // ═══ top border ═══
  const topB = t.dim('╭' + '─'.repeat(W - 4) + '╮');

  const out: string[] = [];
  out.push(topB);

  // title: 4×6 pixel banner with gradient
  for (const row of bannerText(title)) {
    out.push(center(row));
  }
  out.push('');

  // version
  out.push(center(s.bold(t.faint(version))));
  out.push(pad(''));

  // provider
  out.push(center(`${t.dim(providerLabel + '  ')}${t.text(provider)}`));
  out.push(pad(''));

  if (configHint) {
    const hintLines = configHint.split('\n');
    const iconPrefix = `${t.warning('⚡')} `;
    const maxHintLen = Math.max(...hintLines.map(l => visibleLen(iconPrefix + l)));
    for (const line of hintLines) {
      const leftPad = 2 + Math.floor((W - 4 - maxHintLen) / 2);
      out.push(' '.repeat(Math.max(0, leftPad)) + iconPrefix + t.warning(line));
    }
    out.push(pad(''));
  }

  out.push(center(`${t.success('▶')}  ${s.bold(t.text(startHint))}   ${t.accent('@')} ${s.bold(t.dim(usageHints))}`));
  out.push('');

  // bottom border
  out.push(t.dim('╰' + '─'.repeat(W - 4) + '╯'));

  return '\n' + out.join('\n') + '\n';
}

// ── 文件下拉菜单 ──
export function renderFileDropdown(
  items: Array<{ label: string; detail?: string; highlighted: boolean }>,
  labels: { header: string; more: (n: number) => string },
  maxH = 8,
  w?: number,
): string[] {
  if (!items.length) return [];
  const width = Math.min((w ?? tw()) - 8, 64);
  const vis = items.slice(0, maxH);
  const out: string[] = [];

  out.push(t.subtle('╭') + t.subtle('─'.repeat(2)) + ' ' + s.bold(t.purple(labels.header)) + ' ' + t.subtle('─'.repeat(Math.max(0, width - 5 - visibleLen(labels.header)))) + t.subtle('╮'));
  for (const it of vis) {
    const mark = it.highlighted ? t.accent('▸') : ' ';
    const name = it.highlighted ? t.selected(` ${it.label} `) : t.text(` ${it.label} `);
    const extra = it.detail ? ' ' + t.faint(it.detail) : '';
    const rpad = Math.max(0, width - 4 - visibleLen(it.label) - (it.detail ? 1 + it.detail.length : 0));
    out.push(t.subtle(B.v) + ` ${mark} ${name}${extra}${' '.repeat(rpad)} ` + t.subtle(B.v));
  }
  if (items.length > maxH) {
    const more = labels.more(items.length - maxH);
    out.push(t.subtle(B.v) + ' ' + t.faint(more) + ' '.repeat(Math.max(0, width - 1 - visibleLen(more))) + ' ' + t.subtle(B.v));
  }
  out.push(t.subtle('╰' + '─'.repeat(width) + '╯'));
  return out;
}

// ── 命令下拉菜单 ──
export function renderCommandMenu(
  items: Array<{ cmd: string; desc: string; highlighted: boolean }>,
  header: string,
  w?: number,
): string[] {
  if (!items.length) return [];
  const width = Math.min((w ?? tw()) - 8, 52);
  const out: string[] = [];

  out.push(t.subtle('╭') + t.subtle('─'.repeat(2)) + ' ' + s.bold(t.purple(header)) + ' ' + t.subtle('─'.repeat(Math.max(0, width - 5 - visibleLen(header)))) + t.subtle('╮'));
  for (const it of items) {
    const mark = it.highlighted ? t.accent('▸') : ' ';
    const cmd = it.highlighted ? t.accent(it.cmd.padEnd(14)) : t.dim(it.cmd.padEnd(14));
    const desc = it.highlighted ? t.text(it.desc) : t.faint(it.desc);
    const rpad = Math.max(0, width - 18 - visibleLen(it.desc));
    out.push(t.subtle(B.v) + ` ${mark} ${cmd}${desc}${' '.repeat(rpad)} ` + t.subtle(B.v));
  }
  out.push(t.subtle('╰' + '─'.repeat(width) + '╯'));
  return out;
}

// ── 提示栏 ──
export function hintText(labels: { tab: string; navigate: string; confirm: string; dismiss: string; sep: string }): string {
  return [
    `${t.faint(labels.tab)}`,
    `${t.faint(labels.navigate)}`,
    `${t.faint(labels.confirm)}`,
    `${t.faint(labels.dismiss)}`,
  ].join(t.subtle(labels.sep));
}

// ── 工具调用 ──
function formatArgs(args?: Record<string, unknown>): string {
  if (!args) return '';
  const val = args.path ?? args.input;
  if (typeof val === 'string' && val.length > 0) {
    const short = val.length > 50 ? val.slice(0, 47) + '…' : val;
    return ` ${t.subtle('·')} ${t.dim(short)}`;
  }
  return '';
}

export function toolCallStart(toolName: string, args?: Record<string, unknown>, label?: string): string {
  return `${toolTitle(toolName, label)}${formatArgs(args)}`;
}

export function toolCallEnd(status: 'success' | 'error', detail?: string, durationMs?: number): string {
  const mark = status === 'success' ? t.success('✓') : t.error('✗');
  const extra = detail ? ` ${t.faint(detail.slice(0, 80))}` : '';
  const dur = durationMs ? ` ${t.faint(`[${formatDuration(durationMs)}]`)}` : '';
  return `${mark}${extra}${dur}`;
}

/** 同类工具折叠 — 进行中 */
export function toolCallFolding(toolName: string, count: number, latest: string, elapsedMs?: number, label?: string, toolsLabel = 'tools'): string {
  const countText = count > 1 ? ` ${t.subtle(`· ${count} ${toolsLabel}`)}` : '';
  const argsStr = latest ? ` ${t.subtle('·')} ${t.dim(latest.slice(0, 60))}` : '';
  const dur = elapsedMs ? t.subtle(` ${formatDuration(elapsedMs)}`) : '';
  return `\r\x1b[2K${toolTitle(toolName, label)}${countText}${argsStr}${dur}\r`;
}

/** 同类工具折叠 — 完成摘要，write_file 时附带 diff 预览 */
export function toolCallFold(toolName: string, count: number, args: string[], totalMs?: number, diffResult?: string, label?: string, toolsLabel = 'tools'): string {
  const valid = args.filter(a => a);
  const preview = valid.length > 0
    ? ` ${t.subtle('·')} ${valid.slice(0, 4).map(a => t.dim(a.slice(0, 40))).join(t.subtle(', '))}${valid.length > 4 ? t.subtle(` …${valid.length - 4} more`) : ''}`
    : '';
  const countText = count > 1 ? ` ${t.subtle(`· ${count} ${toolsLabel}`)}` : '';
  const dur = totalMs ? ` ${t.subtle(`[${formatDuration(totalMs)}]`)}` : '';
  let out = `${toolTitle(toolName, label)}${countText}${preview}${dur}`;
  if (diffResult) {
    out += '\n' + renderDiff(diffResult, 12);
  }
  return out;
}

/** 渲染 unified diff 预览（modify_file 专用） */
export function renderDiff(diffText: string, maxLines = 30): string {
  const lines = diffText.split('\n');
  const out: string[] = [];
  let count = 0;
  for (const raw of lines) {
        if (count >= maxLines) { out.push(t.faint(`… ${lines.length - maxLines} more lines`)); break; }
    // 跳过末尾提示语
    let line: string;
    if (raw.startsWith('+++') || raw.startsWith('---')) line = t.accent(s.bold(raw));
    else if (raw.startsWith('@@')) line = t.accent(raw);
    else if (raw.startsWith('+')) line = t.success(raw);
    else if (raw.startsWith('-')) line = t.error(raw);
    else line = t.dim(raw);
    out.push(`${t.subtle('│')} ${line}`);
    count++;
  }
  return out.join('\n');
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 基础 spinner（非思考场景使用） */
export function spinnerStart(label?: string, write: (text: string) => void = process.stdout.write.bind(process.stdout)): { stop: () => void; update: (text: string) => void; tick: () => void } {
  let text = label ?? 'Thinking…';
  let idx = 0;
  const redraw = () => {
    write('\r' + t.accent(SPIN[idx % SPIN.length]!) + ' ' + t.dim(text));
  };
  const interval = setInterval(() => { idx++; redraw(); }, 100);
  return {
    update: (t: string) => { text = t; redraw(); },
    tick: () => { redraw(); },
    stop: () => {
      clearInterval(interval);
      write('\r\x1b[2K');
    },
  };
}

// ── 思考链渲染（参考 Claude Code 三阶段模式） ──

/** Phase 1 — 思考进行中实时状态行（始终 2 行结构，保证回退覆写一致） */
export function thinkingLive(frame: string, elapsed: string, tokens: string, subtitle: string, labels?: { thinking: string; tokens: string }): string {
  const head = `${t.accent(frame)} ${t.text(labels?.thinking ?? 'Thinking…')} ${t.dim(`(${elapsed} · ↓ ${tokens} ${labels?.tokens ?? 'tokens'})`)}`;
  const sub = subtitle
    ? `\n${t.subtle('⎿')} ${t.faint(subtitle)}`
    : '';
  return head + sub;
}

/** Phase 2 — 思考完成折叠摘要 */
export function thinkingSummary(time: string, tokens: string, expandHint: string, labels?: { thoughtFor: string; tokens: string }): string {
  return `${t.success('✓')} ${t.text(labels?.thoughtFor ?? 'Thought for')} ${t.dim(time)} ${t.text('·')} ${t.dim(`↓ ${tokens} ${labels?.tokens ?? 'tokens'}`)} ${t.faint(expandHint)}`;
}

/** Phase 3 — 展开完整思考（dim 内容 + 边框） */
export function thinkingExpanded(content: string, boxTitle: string): string {
  const W = Math.min(tw() - 4, 80);
  const innerW = W - 4;
  const lines = content.split('\n');
  const out: string[] = [];

  out.push(`${t.subtle('┌─')} ${s.bold(t.purple(boxTitle))} ${t.subtle('─'.repeat(Math.max(0, W - 5 - visibleLen(boxTitle))))}${t.subtle('┐')}`);

  for (const raw of lines) {
    const wrapped = wrapAnsi(raw, innerW, { hard: true });
    for (const chunk of wrapped.split('\n')) {
      const padding = ' '.repeat(Math.max(0, innerW - stringWidth(chunk)));
      out.push(`${t.subtle('│')} ${t.dim(chunk)}${padding} ${t.subtle('│')}`);
    }
  }

  out.push(`${t.subtle('└')}${t.subtle('─'.repeat(W - 2))}${t.subtle('┘')}`);
  return out.join('\n');
}

/** 从 thinking 缓冲中提取动态 subtitle（最后一句，限长） */
export function extractThinkingSubtitle(buf: string, maxLen = 60): string {
  if (!buf) return '';
  const lines = buf.split('\n').filter(l => l.trim());
  let last = lines[lines.length - 1]?.trim() || '';
  last = last.replace(/^(I |Let me |First, |Next, |Then, |Also, |Now, |So, |We |The )/, '');
  if (last.length > maxLen) last = last.slice(0, maxLen - 3) + '...';
  return last;
}

/**
 * 思考专用 spinner（Phase 1/2）。
 * tipPool: subtitle 为空时 fallback 的提示文本池，每次 thinkStart 随机选一条。
 */
export function thinkingSpinner(tipPool: string[] = [], write: (text: string) => void = process.stdout.write.bind(process.stdout), labels?: { thinking: string; thoughtFor: string; tokens: string }): {
  stop: () => void;
  thinkStart: () => void;
  thinkTick: (elapsedMs: number, tokens: number, subtitle: string) => void;
  thinkDone: (elapsedMs: number, tokens: number, expandHint: string) => void;
} {
  let idx = 0;
  let state: { elapsedMs: number; tokens: number; subtitle: string } = { elapsedMs: 0, tokens: 0, subtitle: '' };
  let interval: ReturnType<typeof setInterval> | null = null;
  let done = false;
  let linesOnScreen = 0; // 0 或 2
  let currentTip = '';

  const pickTip = () => {
    currentTip = tipPool.length > 0 ? tipPool[Math.floor(Math.random() * tipPool.length)]! : '';
  };

  const formatTime = formatDuration;

  const formatTokens = (n: number): string => {
    if (n < 1000) return `${n}`;
    return `${(n / 1000).toFixed(1)}K`;
  };

  const redraw = () => {
    if (done || linesOnScreen === 0) return;
    const frame = SPIN[idx % SPIN.length]!;
    const elapsed = formatTime(state.elapsedMs);
    const tok = formatTokens(state.tokens);
    const sub = state.subtitle || currentTip || '';
    const line = thinkingLive(frame, elapsed, tok, sub, labels).split('\n')[0]!;
    write(`\r${line}`);
  };

  return {
    thinkStart: () => {
      idx = 0;
      state = { elapsedMs: 0, tokens: 0, subtitle: '' };
      done = false;
      pickTip();
      linesOnScreen = 1;
      redraw();
      if (!interval) interval = setInterval(() => { idx++; redraw(); }, 100);
    },
    thinkTick: (elapsedMs: number, tokens: number, subtitle: string) => {
      state = { elapsedMs, tokens, subtitle };
    },
    thinkDone: (elapsedMs: number, tokens: number, expandHint: string) => {
      if (interval) { clearInterval(interval); interval = null; }
      done = true;
      if (linesOnScreen === 0) return;
      const time = formatTime(elapsedMs);
      const tok = formatTokens(tokens);
      write(`\r${thinkingSummary(time, tok, expandHint, labels)}\n`);
      linesOnScreen = 0;
    },
    stop: () => {
      if (interval) { clearInterval(interval); interval = null; }
      done = true;
      if (linesOnScreen > 0) {
        write('\r\x1b[2K');
        linesOnScreen = 0;
      }
    },
  };
}

// ── Markdown 渲染（marked v15 自定义 Renderer，不依赖 marked-terminal） ──

import { marked, Renderer } from 'marked';

// 从 Renderer 基类方法签名提取 marked 的 token 类型，避免直接 import 的 CJS/ESM 命名空间冲突
type HeadingToken    = Parameters<Renderer['heading']>[0];
type ParagraphToken  = Parameters<Renderer['paragraph']>[0];
type BlockquoteToken = Parameters<Renderer['blockquote']>[0];
type ListToken       = Parameters<Renderer['list']>[0];
type ListItemToken   = Parameters<Renderer['listitem']>[0];
type TableToken      = Parameters<Renderer['table']>[0];
type InlineTokens    = NonNullable<Parameters<Renderer['strong']>[0]['tokens']>;

class TerminalRenderer extends Renderer {
  space(_token: { raw: string }): string { return '\n'; }

  text(token: { text: string }): string { return token.text; }

  // 行内元素 — 直接被 marked 块级渲染器调用（段落/标题内）
  strong(token: { text: string }): string { return s.bold(token.text); }
  em(token: { text: string }): string { return s.italic(token.text); }
  del(token: { text: string }): string { return t.faint(token.text); }
  codespan(token: { text: string }): string { return cb(token.text, 255, 238); }

  link(token: { href: string; text: string }): string {
    return `${token.text} ${t.faint(token.href.slice(0, 60))}`;
  }
  image(token: { href: string; text: string }): string {
    return t.faint(`[img: ${token.text || token.href}]`);
  }

  /** 渲染行内 token 数组：marked 负责解析，我们负责映射终端样式 */
  private _renderInline(tokens?: InlineTokens): string {
    if (!tokens?.length) return '';
    return this.parser.parseInline(tokens);
  }

  heading(token: HeadingToken): string {
    const content = this._renderInline(token.tokens);
    const colors: Array<(s: string) => string> = [t.purple, t.blue, t.accent, t.dim, t.dim, t.dim];
    const color = colors[Math.min(token.depth - 1, 5)]!;
    return `\n${s.bold(color(content))}\n`;
  }

  paragraph(token: ParagraphToken): string {
    return this._renderInline(token.tokens) + '\n';
  }

  hr(): string {
    const w = Math.min(tw() - 4, 80);
    const side = '─'.repeat(Math.max(0, Math.floor((w - 4) / 2)));
    return `\n${t.subtle(side + ' ◆ ' + side)}\n`;
  }

  code(token: { text: string; lang?: string }): string {
    const W = Math.min(tw() - 4, 80);
    const BAR = t.accent('│');
    const langLabel = token.lang ? ` ${token.lang} ` : '';
    // 顶框：┌─ [label] ─...─┐ → 左右 2 + 内容 W-4 + 左右 2 = W
    const topBar = t.accent('┌─') +
      (token.lang ? s.bold(t.accent(langLabel)) : '') +
      t.accent('─'.repeat(Math.max(0, W - 4 - langLabel.length)) + '─┐');

    const out = [topBar];
    const innerW = W - 4;
    const content = token.text.replace(/\n$/, '');
    const wrapped = wrapAnsi(content, innerW, { hard: true });
    for (const line of wrapped.split('\n')) {
      const padding = ' '.repeat(Math.max(0, innerW - stringWidth(line)));
      out.push(BAR + ' ' + t.faint(line) + padding + ' ' + BAR);
    }
    // 底框
    out.push(t.accent('└' + '─'.repeat(W - 2) + '┘'));
    return '\n' + out.join('\n') + '\n';
  }

  blockquote(token: BlockquoteToken): string {
    const inner = token.tokens?.length
      ? this.parser.parse(token.tokens).trimEnd()
      : token.text;
    const bar = t.accent('▎');
    return inner.split('\n').map(l => `${bar} ${t.dim(l)}`).join('\n') + '\n';
  }

  list(token: ListToken): string {
    let out = '';
    let n = typeof token.start === 'number' ? token.start : 1;
    for (const item of token.items) {
      const bullet = token.ordered
        ? t.blue(`${n}.`)
        : t.accent('•');
      let checkbox = '';
      if (item.task) {
        checkbox = item.checked ? t.success('[X] ') : t.faint('[ ] ');
      }
      // 从 item 的第一个文本块（paragraph 或 text）中提取行内 token 渲染
      const firstBlock = item.tokens?.find(
        (t): t is typeof t & { tokens: InlineTokens } => t.type === 'paragraph' || t.type === 'text',
      );
      const inlineContent = this._renderInline(firstBlock?.tokens ?? []);
      out += `${t.accent(bullet)} ${checkbox}${inlineContent}\n`;
      if (token.ordered) n++;
    }
    return out + '\n';
  }

  listitem(token: ListItemToken): string {
    return token.tokens?.length ? this.parser.parse(token.tokens).trimEnd() : token.text;
  }

  table(token: TableToken): string {
    const colCount = token.header.length;
    const totalW = Math.min(tw() - 4, 80);
    // 每列左右各 2 填充空格 + 列间 │
    const cellPad = 4;
    const overhead = colCount * (cellPad + 1) + 1;
    const usableW = Math.max(colCount * 4, totalW - overhead);

    const pad = (s: string, w: number): string => { const v = stringWidth(s); return s + ' '.repeat(Math.max(0, w - v)); };

    // ── 预渲染 cell ──
    const renderedHeader = token.header.map(c => this._renderInline(c.tokens));
    const renderedRows = token.rows.map(row => row.map(c => this._renderInline(c.tokens)));

    // ── 列宽分配：先保证每列内容测量宽度，再按比例分配剩余 ──
    const rawMaxPerCol: number[] = [];
    for (let i = 0; i < colCount; i++) {
      let maxW = stringWidth(renderedHeader[i]!);
      for (const row of renderedRows) maxW = Math.max(maxW, stringWidth(row[i]!));
      rawMaxPerCol.push(maxW);
    }
    // 每列以内容宽度为起点（不超过可用总宽）
    const colWidths: number[] = rawMaxPerCol.map(raw => Math.min(raw, usableW));
    let allocSum = colWidths.reduce((a, b) => a + b, 0);

    if (allocSum > usableW) {
      // 内容总宽超过可用 → 等比例缩放，保底 4
      const scale = usableW / allocSum;
      for (let i = 0; i < colCount; i++) {
        colWidths[i] = Math.max(4, Math.floor(colWidths[i]! * scale));
      }
      allocSum = colWidths.reduce((a, b) => a + b, 0);
      let rrr = 0;
      while (allocSum < usableW) { colWidths[rrr % colCount]!++; allocSum++; rrr++; }
      while (allocSum > usableW) {
        const mi = colWidths.indexOf(Math.max(...colWidths));
        if (colWidths[mi]! <= 4) break;
        colWidths[mi]!--; allocSum--;
      }
    } else if (allocSum < usableW) {
      // 有剩余 → 轮询分配
      let rrr = 0;
      while (allocSum < usableW) { colWidths[rrr % colCount]!++; allocSum++; rrr++; }
    }

    // ── 按列宽换行 ──
    const wrapCell = (content: string, w: number): string[] =>
      stringWidth(content) <= w ? [content] : wrapAnsi(content, w, { hard: true, trim: false }).split('\n');
    const headerWrapped = renderedHeader.map((c, i) => wrapCell(c, colWidths[i]!));
    const rowsWrapped = renderedRows.map(row => row.map((c, i) => wrapCell(c, colWidths[i]!)));

    // 行构建函数
    const buildRow = (
      cells: string[][],
      barColor: (s: string) => string,
      subColor: (s: string) => string,
      cellWrap: (c: string) => string,
    ): string[] => {
      const maxLines = Math.max(...cells.map(c => c.length), 1);
      const lines: string[] = [];
      for (let line = 0; line < maxLines; line++) {
        // 边框独立 ANSI，填充空格无色 — cell 内容保持自己的 ANSI 不被覆盖
        const joinBar = barColor('│');
        const leadingBar = line === 0 ? barColor('│') : subColor('┊');
        const content = cells.map((c, i) => {
          const text = c[line] ?? '';
          return pad(cellWrap(text), colWidths[i]!);
        }).join(`  ${joinBar}  `);
        lines.push(leadingBar + '  ' + content + '  ' + barColor('│'));
      }
      return lines;
    };

    const out: string[] = [];

    // 顶框：subtle
    out.push(t.subtle('┌' + colWidths.map(w => '─'.repeat(w + cellPad)).join('┬') + '┐'));
    // 表头：边框统一 subtle，cell 加粗
    out.push(...buildRow(headerWrapped, t.subtle, t.subtle, (c) => s.bold(c)));
    // 分隔线
    out.push(t.subtle('├' + colWidths.map(w => '─'.repeat(w + cellPad)).join('┼') + '┤'));

    // 数据行：边框统一 subtle，cell 内容不额外着色
    for (let ri = 0; ri < rowsWrapped.length; ri++) {
      const row = rowsWrapped[ri]!;
      out.push(...buildRow(row, t.subtle, t.subtle, (c) => c));
    }

    // 底框
    out.push(t.subtle('└' + colWidths.map(w => '─'.repeat(w + cellPad)).join('┴') + '┘'));
    return '\n' + out.join('\n') + '\n';
  }

  html(token: { text: string }): string { return token.text; }
}

marked.setOptions({ renderer: new TerminalRenderer() });

export function renderMarkdown(text: string): string {
  if (!text) return '';
  try {
    const pre = text.replace(/\n{3,}/g, '\n\n');
    const parsed = marked.parse(pre, { async: false }) as string;
    return parsed;
  } catch (err) {
    console.error('[renderMarkdown] parse failed:', (err as Error).message);
    return text;
  }
}

/** 行内 markdown 样式转换 — 流式输出时按行渲染，同时处理行前缀块级标记（标题/引用/列表） */
export function renderInlineMarkdown(text: string): string {
  const stash: string[] = [];
  const NUL = String.fromCharCode(0);
  let idx = 0;

  const applyInline = (line: string): string => {
    // image → 索引占位符（必须先于 link）
    let result = line.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, txt: string, href: string) => {
      stash[idx] = t.faint(`[img: ${txt || href}]`);
      return NUL + String(idx++) + NUL;
    });
    // link → 索引占位符
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt: string, href: string) => {
      stash[idx] = `${txt} ${t.faint(href.slice(0, 60))}`;
      return NUL + String(idx++) + NUL;
    });
    // 行内样式
    result = result
      .replace(/\*\*([^*]+)\*\*/g, (_m, c: string) => s.bold(c))
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_m, c: string) => s.italic(c))
      .replace(/`([^`]+)`/g, (_m, c: string) => cb(c, 255, 238))
      .replace(/~~([^~]+)~~/g, (_m, c: string) => t.faint(c));
    // 还原占位符
    const unstashRe = new RegExp(NUL + '(\\d+)' + NUL, 'g');
    return result.replace(unstashRe, (_m, i: string) => stash[+i] ?? '');
  };

  // 行前缀块级标记
  const HEADING_RE = /^(#{1,6})\s+(.*)/;
  const QUOTE_RE   = /^>\s?(.*)/;
  const UL_RE      = /^[-*]\s+(.*)/;
  const OL_RE      = /^(\d+)\.\s+(.*)/;
  const FENCE_RE   = /^(`{3,}|~{3,})\s*(.*)/;  // 代码围栏
  const PIPE_RE    = /^\|.+$/;                   // 类表格行（含 | 分隔）

  const headingMatch = text.match(HEADING_RE);
  if (headingMatch) {
    const depth = headingMatch[1]!.length;
    const colors: Array<(s: string) => string> = [t.purple, t.blue, t.accent, t.dim, t.dim, t.dim];
    return s.bold(colors[Math.min(depth - 1, 5)]!(applyInline(headingMatch[2]!))) + '\n';
  }
  const fenceMatch = text.match(FENCE_RE);
  if (fenceMatch) {
    const lang = fenceMatch[2]!;
    return t.accent(fenceMatch[1]!) + (lang ? s.bold(t.accent(' ' + lang + ' ')) : '') + '\n';
  }
  const pipeMatch = text.match(PIPE_RE);
  if (pipeMatch) {
    // 表格行：先 inline 样式，再 | 着色
    return applyInline(text).replace(/\|/g, t.subtle('│'));
  }
  const quoteMatch = text.match(QUOTE_RE);
  if (quoteMatch) {
    return `${t.accent('▎')} ${t.dim(applyInline(quoteMatch[1]!))}\n`;
  }
  const ulMatch = text.match(UL_RE);
  if (ulMatch) {
    return `${t.accent('•')} ${applyInline(ulMatch[1]!)}\n`;
  }
  const olMatch = text.match(OL_RE);
  if (olMatch) {
    return `${t.blue(olMatch[1]! + '.')} ${applyInline(olMatch[2]!)}\n`;
  }
  return applyInline(text);
}

// ── 工具颜色映射 ──

const TOOL_COLOR: Record<string, (s: string) => string> = {
  read_file: t.blue,
  list_files: t.blue,
  search: t.purple,
  lsp_definition: t.purple,
  lsp_references: t.purple,
  lsp_diagnostics: t.purple,
  write_file: t.accent,
  execute_command: t.warning,
  git_commit: t.success,
};

const TOOL_ICON: Record<string, string> = {
  read_file: '◰',
  list_files: '▤',
  search: '⌕',
  write_file: '✎',
  execute_command: '⌘',
  git_commit: '⑂',
  lsp_definition: '◇',
  lsp_references: '◇',
  lsp_diagnostics: '◇',
};

function toolColor(name: string): (s: string) => string {
  return TOOL_COLOR[name] ?? t.accent;
}

function toolIcon(name: string): string {
  return TOOL_ICON[name] ?? '▸';
}

function toolTitle(name: string, label?: string): string {
  const color = toolColor(name);
  return `${color(toolIcon(name))} ${color(s.bold(label ?? name))}`;
}

// ── 状态消息 ──
export function taskComplete(label?: string, summary?: string): string {
  const title = label ?? 'Task complete';
  const s = summary ? ` ${t.dim('— ' + summary)}` : '';
  return `\n${t.success('✓')} ${t.text(title)}${s}\n`;
}

export function taskWarning(text: string): string {
  return `\n  ${t.warning('⚠')} ${t.text(text)}\n`;
}

// ── 上下文管理显示 ──
export function contextCompacting(compactingLabel: string): string {
  return `\n${t.warning('⟳')} ${t.text(compactingLabel)}`;
}

export function contextCompacted(compactedLabel: string): string {
  return `${t.success('✓')} ${t.dim(compactedLabel)}\n`;
}

export function contextStats(currentTokens: number, limit: number, label?: string): string {
  const pct = Math.round((currentTokens / limit) * 100);
  const color = pct > 85 ? t.error : pct > 60 ? t.warning : t.success;
  const prefix = label ?? 'Context';
  return `${t.dim(prefix + ':')} ${color(`${Math.round(currentTokens / 1000)}K / ${Math.round(limit / 1000)}K token (${pct}%)`)}`;
}

// ── 审批弹框 ──
export function approvalBox(toolName: string, label: string, detail?: string, labels?: { title?: string; prompt?: string }): string {
  const title = labels?.title ?? '⚠ Approval Required';
  const prompt = labels?.prompt ?? '[y/N]';
  const w = Math.min(tw() - 4, 64);
  const bar = t.warning('│');
  const lines = [
    `\n ${t.warning('╭' + '─'.repeat(w) + '╮')}`,
    ` ${bar} ${t.warning(s.bold(' ' + title))}${' '.repeat(Math.max(0, w - 1 - visibleLen(title)))} ${bar}`,
    ` ${bar} ${t.text(label + ': ')}${t.accent(toolName)}${' '.repeat(Math.max(0, w - 3 - visibleLen(label) - visibleLen(toolName)))} ${bar}`,
  ];
  if (detail) {
    lines.push(` ${bar} ${t.dim(' ' + detail)}${' '.repeat(Math.max(0, w - 1 - visibleLen(detail)))} ${bar}`);
  }
  lines.push(` ${bar} ${t.dim(prompt)}${' '.repeat(Math.max(0, w - visibleLen(prompt)))} ${bar}`);
  lines.push(` ${t.warning('╰' + '─'.repeat(w) + '╯')}`);
  return lines.join('\n');
}

// ── 辅助函数 ──

/** 字符串可见宽度（去除 ANSI 转义序列，CJK/全角字符计为 2 列） */
function visibleLen(s: string): number {
  return stringWidth(s);
}

