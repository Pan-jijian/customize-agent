/**
 * TUI 渲染 — ANSI 转义序列 + Unicode 框线绘制。
 *
 * Tokyo Night 调色板 (256 色):
 *   accent cyan:  #7dcfff → 117    blue:     #7aa2f7 → 111
 *   purple:       #9d7cd8 → 140    success:  #9ece6a → 114
 *   warning gold: #e0af68 → 180    error:    #f7768e → 211
 *   text:         #a9b1d6 → 146    dim:      #565f89 → 103
 *
 * 布局: 2 空格左边距，竖线 (│) 连接输入行与下拉菜单。
 */
const CSI = '\x1b[';

// ── 256 色辅助函数 ──
function c(t: string, code: number): string { return `${CSI}38;5;${code}m${t}${CSI}39m`; }
function cb(t: string, fg: number, bg: number): string { return `${CSI}38;5;${fg}m${CSI}48;5;${bg}m${t}${CSI}39;49m`; }

export const t = {
  accent:    (s: string) => c(s, 117),
  blue:      (s: string) => c(s, 111),
  purple:    (s: string) => c(s, 140),
  success:   (s: string) => c(s, 114),
  warning:   (s: string) => c(s, 180),
  error:     (s: string) => c(s, 211),
  white:     (s: string) => c(s, 255),
  text:      (s: string) => c(s, 146),
  dim:       (s: string) => c(s, 103),
  subtle:    (s: string) => c(s, 60),
  faint:     (s: string) => c(s, 59),
  selected:  (s: string) => cb(s, 255, 60),
  badge:     (s: string) => cb(s, 0, 117),
  planBadge: (s: string) => cb(s, 0, 111),
};

export const s = {
  bold:      (t: string) => `${CSI}1m${t}${CSI}22m`,
  dim:       (t: string) => `${CSI}2m${t}${CSI}22m`,
  italic:    (t: string) => `${CSI}3m${t}${CSI}23m`,
  inverse:   (t: string) => `${CSI}7m${t}${CSI}27m`,
  underline: (t: string) => `${CSI}4m${t}${CSI}24m`,
};

export const cur = {
  hide:       `${CSI}?25l`,
  show:       `${CSI}?25h`,
  up:         (n = 1) => `${CSI}${n}A`,
  down:       (n = 1) => `${CSI}${n}B`,
  fwd:        (n = 1) => `${CSI}${n}C`,
  clearLine:  `${CSI}2K`,
  clearBelow: `${CSI}0J`,
  save:       `${CSI}s`,
  restore:    `${CSI}u`,
};

// ── 框线字符 ──
const B = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
const D = { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' };

export function tw(): number {
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
  const side = Math.max(0, Math.floor((w - visibleLen(label) - 4) / 2));
  return t.subtle(B.h.repeat(side) + '  ' + t.dim(label) + '  ' + B.h.repeat(side));
}

// ── 欢迎横幅 ──
export function welcomeBanner(version: string, provider: string): string {
  const w = Math.min(tw() - 6, 72);
  const pd = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - visibleLen(s)));
  const v = t.subtle(D.v);
  const inner = [
    '',
    pd(`  ${t.accent(s.bold('◆'))} ${t.white(s.bold('Customize Agent'))}  ${t.subtle('v' + version)}`, w),
    pd(`  ${t.subtle(B.h.repeat(28))}`, w),
    '',
    pd(`  ${t.dim('Provider')}  ${t.text(provider)}`, w),
    '',
    pd(`  ${t.success('▶')}  ${t.text('Type a task to begin')}`, w),
    pd(`  ${t.accent('@')} ${t.dim('attach files')}   ${t.purple('/')} ${t.dim('commands')}   ${t.dim('↑↓ history')}`, w),
    '',
  ];
  const top = t.subtle(D.tl + D.h.repeat(w + 2) + D.tr);
  const bot = t.subtle(D.bl + D.h.repeat(w + 2) + D.br);
  return '\n' + top + '\n' + inner.map(l => v + ' ' + l + ' ' + v).join('\n') + '\n' + bot + '\n';
}

// ── 文件下拉菜单（前缀感知：调用方提供 "  │ " 前缀）──
export function renderFileDropdown(
  items: Array<{ label: string; detail?: string; highlighted: boolean }>,
  maxH = 8,
  w?: number,
): string[] {
  if (!items.length) return [];
  const width = Math.min((w ?? tw()) - 8, 64);
  const vis = items.slice(0, maxH);
  const out: string[] = [];

  out.push(`╭${B.h.repeat(2)} ${t.dim('Files')} ${B.h.repeat(Math.max(0, width - 10))}╮`);
  for (const it of vis) {
    const mark = it.highlighted ? t.accent('❯') : ' ';
    const name = it.highlighted ? t.selected(` ${it.label} `) : t.text(` ${it.label} `);
    const extra = it.detail ? ' ' + t.subtle(it.detail) : '';
    const rpad = Math.max(0, width - 4 - visibleLen(it.label) - (it.detail ? 1 + it.detail.length : 0));
    out.push(`${B.v} ${mark} ${name}${extra}${' '.repeat(rpad)} ${B.v}`);
  }
  if (items.length > maxH) {
    const more = `… ${items.length - maxH} more`;
    out.push(`${B.v} ${t.subtle(more)}${' '.repeat(Math.max(0, width - 1 - visibleLen(more)))} ${B.v}`);
  }
  out.push(`╰${B.h.repeat(width)}╯`);
  return out;
}

// ── 命令下拉菜单 ──
export function renderCommandMenu(
  items: Array<{ cmd: string; desc: string; highlighted: boolean }>,
  w?: number,
): string[] {
  if (!items.length) return [];
  const width = Math.min((w ?? tw()) - 8, 52);
  const out: string[] = [];

  out.push(`╭${B.h.repeat(2)} ${t.dim('Commands')} ${B.h.repeat(Math.max(0, width - 13))}╮`);
  for (const it of items) {
    const mark = it.highlighted ? t.accent('❯') : ' ';
    const cmd = it.highlighted ? t.accent(it.cmd.padEnd(14)) : t.dim(it.cmd.padEnd(14));
    const desc = t.subtle(it.desc);
    const rpad = Math.max(0, width - 18 - visibleLen(it.desc));
    out.push(`${B.v} ${mark} ${cmd}${desc}${' '.repeat(rpad)} ${B.v}`);
  }
  out.push(`╰${B.h.repeat(width)}╯`);
  return out;
}

// ── 提示栏（单行，无前缀）──
export function hintText(): string {
  return [
    `${t.dim('Tab')} select`,
    `${t.dim('↑↓')} navigate`,
    `${t.dim('Enter')} confirm`,
    `${t.dim('Esc')} dismiss`,
  ].join('  ·  ');
}

// ── 工具调用 ──
function formatArgs(args?: Record<string, unknown>): string {
  if (!args) return '';
  const val = args.path ?? args.input;
  if (typeof val === 'string' && val.length > 0) {
    const short = val.length > 50 ? val.slice(0, 47) + '...' : val;
    return ` (${short})`;
  }
  return '';
}

export function toolCallStart(toolName: string, args?: Record<string, unknown>): string {
  return `  ${t.accent('┌')} ${t.accent(s.bold(toolName))}${t.dim(formatArgs(args))}`;
}

export function toolCallEnd(status: 'success' | 'error', detail?: string): string {
  const icon = status === 'success' ? t.success('└ ✓') : t.error('└ ✗');
  const extra = detail ? ` ${t.subtle(detail.slice(0, 80))}` : '';
  return `  ${icon}${extra}`;
}

/** 渲染 unified diff 预览（modify_file 专用） */
export function renderDiff(diffText: string, maxLines = 30): string {
  const lines = diffText.split('\n');
  const out: string[] = [];
  let count = 0;
  for (const raw of lines) {
    if (count >= maxLines) break;
    // 跳过末尾提示语
    if (raw.startsWith('请运行编译命令')) continue;
    let line: string;
    if (raw.startsWith('+++') || raw.startsWith('---')) line = t.accent(s.bold(raw));
    else if (raw.startsWith('@@')) line = t.accent(raw);
    else if (raw.startsWith('+')) line = t.success(raw);
    else if (raw.startsWith('-')) line = t.error(raw);
    else line = t.dim(raw);
    out.push(`  ${t.subtle('│')} ${line}`);
    count++;
  }
  if (lines.length > maxLines) {
    out.push(`  ${t.subtle('│')} ${t.dim(`… ${lines.length - maxLines} more lines`)}`);
  }
  return out.join('\n');
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 启动持续旋转的 spinner，返回停止函数 */
export function spinnerStart(): () => void {
  let idx = 0;
  const interval = setInterval(() => {
    process.stdout.write('\r  ' + t.accent(SPIN[idx % SPIN.length]!) + ' ' + t.subtle('Thinking…'));
    idx++;
  }, 100);
  return () => {
    clearInterval(interval);
    process.stdout.write('\r\x1b[2K'); // 清除 spinner 行
  };
}

// ── 状态消息 ──
export function taskComplete(summary?: string): string {
  const s = summary ? ` ${t.dim('— ' + summary)}` : '';
  return `\n  ${t.success('✓')} ${t.text('Task complete')}${s}\n`;
}

export function taskWarning(msg: string): string {
  return `\n  ${t.warning('⚠')} ${t.text(msg)}\n`;
}

export function errorMsg(msg: string): string {
  return `\n  ${t.error('✗')} ${t.text(msg)}\n`;
}

export function infoMsg(msg: string): string {
  return `  ${t.accent('ℹ')} ${t.dim(msg)}`;
}

// ── 上下文管理显示 ──
export function contextCompacting(beforeTokens: number, limit: number): string {
  const pct = Math.round((beforeTokens / limit) * 100);
  return `\n  ${t.warning('⚠')} ${t.text(`上下文使用 ${pct}%（${Math.round(beforeTokens / 1000)}K / ${Math.round(limit / 1000)}K token），正在压缩…`)}`;
}

export function contextCompacted(afterTokens: number, removedTokens: number): string {
  return `  ${t.success('✓')} ${t.dim(`压缩完成，释放约 ${Math.round(removedTokens / 1000)}K token → 当前 ${Math.round(afterTokens / 1000)}K token`)}\n`;
}

export function contextStats(currentTokens: number, limit: number): string {
  const pct = Math.round((currentTokens / limit) * 100);
  const color = pct > 85 ? t.error : pct > 60 ? t.warning : t.success;
  return `  ${t.dim('上下文:')} ${color(`${Math.round(currentTokens / 1000)}K / ${Math.round(limit / 1000)}K token (${pct}%)`)}`;
}

// ── 审批弹框 ──
export function approvalBox(toolName: string, label: string, detail?: string): string {
  const w = Math.min(tw() - 4, 64);
  const bar = t.warning('│');
  const lines = [
    `\n ${t.warning('╭' + '─'.repeat(w) + '╮')}`,
    ` ${bar} ${t.warning(s.bold(' ⚠ Approval Required'))}${' '.repeat(Math.max(0, w - 22))} ${bar}`,
    ` ${bar} ${t.text(label + ': ')}${t.accent(toolName)}${' '.repeat(Math.max(0, w - 3 - visibleLen(label) - visibleLen(toolName)))} ${bar}`,
  ];
  if (detail) {
    lines.push(` ${bar} ${t.dim(' ' + detail)}${' '.repeat(Math.max(0, w - 1 - visibleLen(detail)))} ${bar}`);
  }
  lines.push(` ${bar} ${t.dim('[y/N]')}${' '.repeat(Math.max(0, w - 6))} ${bar}`);
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
    w += (cp >= 0x2E80) ? 2 : 1;
  }
  return w;
}

export { visibleLen };
