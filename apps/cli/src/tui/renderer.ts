/**
 * TUI 渲染 — ANSI + Unicode 框线。Modern 256-color palette.
 *    accent #5fd7ff → 81    blue    #5f87ff → 69
 *    purple #d787ff → 177   success #87d787 → 114
 *    warn   #ffd787 → 222   error   #ff8787 → 210
 *    text   #eeeeee → 255   dim     #808080 → 244
 */
import { bannerText } from './big-text.js';

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
    return ` ${t.faint(short)}`;
  }
  return '';
}

export function toolCallStart(toolName: string, args?: Record<string, unknown>): string {
  return `  ${t.accent('▸')} ${t.accent(s.bold(toolName))}${formatArgs(args)}`;
}

export function toolCallEnd(status: 'success' | 'error', detail?: string): string {
  const mark = status === 'success' ? `  ${t.success('✓')}` : `  ${t.error('✗')}`;
  const extra = detail ? ` ${t.faint(detail.slice(0, 80))}` : '';
  return `${mark}${extra}`;
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
    out.push(`  ${t.subtle('│')} ${line}`);
    count++;
  }
  return out.join('\n');
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinnerStart(label?: string): () => void {
  const text = label ?? 'Thinking…';
  let idx = 0;
  const interval = setInterval(() => {
    process.stdout.write('\r  ' + t.accent(SPIN[idx % SPIN.length]!) + ' ' + t.dim(text));
    idx++;
  }, 100);
  return () => {
    clearInterval(interval);
    process.stdout.write('\r\x1b[2K');
  };
}

// ── 状态消息 ──
export function taskComplete(label?: string, summary?: string): string {
  const title = label ?? 'Task complete';
  const s = summary ? ` ${t.dim('— ' + summary)}` : '';
  return `\n  ${t.success('✓')} ${t.text(title)}${s}\n`;
}

export function taskWarning(text: string): string {
  return `\n  ${t.warning('⚠')} ${t.text(text)}\n`;
}

// ── 上下文管理显示 ──
export function contextCompacting(compactingLabel: string): string {
  return `\n  ${t.warning('⟳')} ${t.text(compactingLabel)}`;
}

export function contextCompacted(compactedLabel: string): string {
  return `  ${t.success('✓')} ${t.dim(compactedLabel)}\n`;
}

export function contextStats(currentTokens: number, limit: number, label?: string): string {
  const pct = Math.round((currentTokens / limit) * 100);
  const color = pct > 85 ? t.error : pct > 60 ? t.warning : t.success;
  const prefix = label ?? 'Context';
  return `  ${t.dim(prefix + ':')} ${color(`${Math.round(currentTokens / 1000)}K / ${Math.round(limit / 1000)}K token (${pct}%)`)}`;
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
  const clean = s.replace(new RegExp(`${CSI.replace(/\[/g, '\\[')}[0-9;]*m`, 'g'), '');
  let w = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2E80 && cp <= 0x9FFF) { w += 2; }          // CJK Unified
    else if (cp >= 0x3400 && cp <= 0x4DBF) { w += 2; }     // CJK Ext-A
    else if (cp >= 0xFF00 && cp <= 0xFFEF) { w += 2; }     // Fullwidth forms
    else if (cp >= 0x3000 && cp <= 0x303F) { w += 2; }     // CJK Symbols
    else if (cp >= 0x2190 && cp <= 0x21FF) { w += 2; }     // Arrows (↑↓→←)
    else if (cp >= 0x2600 && cp <= 0x27BF) { w += 2; }     // Misc Symbols (⚡◆▶★)
    else { w += 1; }
  }
  return w;
}

