/**
 * Terminal UI rendering — ANSI escapes + Unicode box drawing.
 * Design: modern terminal UI inspired by Mimo Code / Claude Code.
 */

const CSI = '\x1b[';

// ═══════════════════════════════════════════════════════
// Color palette (256-color, Tailwind-inspired)
// ═══════════════════════════════════════════════════════

function c(t: string, code: number): string { return `${CSI}38;5;${code}m${t}${CSI}39m`; }
function cb(t: string, fg: number, bg: number): string { return `${CSI}38;5;${fg}m${CSI}48;5;${bg}m${t}${CSI}39;49m`; }

export const t = {
  // Accent — purple/violet
  purple: (s: string) => c(s, 141),        // #af87d7
  purpleBold: (s: string) => c(s, 99),     // #875fff
  // Semantic
  green: (s: string) => c(s, 114),         // #87d787
  yellow: (s: string) => c(s, 222),        // #ffd787
  red: (s: string) => c(s, 210),           // #ff8787
  cyan: (s: string) => c(s, 81),           // #5fd7ff
  blue: (s: string) => c(s, 111),          // #87afff
  // Text
  white: (s: string) => c(s, 255),         // #eeeeee
  text: (s: string) => c(s, 252),          // #d0d0d0
  dim: (s: string) => c(s, 245),           // #8a8a8a
  subtle: (s: string) => c(s, 240),        // #585858
  // Special
  selected: (s: string) => cb(s, 255, 60), // white on purple bg
  badge: (s: string) => cb(s, 255, 99),    // white on deep-purple bg
};

export const s = {
  bold: (t: string) => `${CSI}1m${t}${CSI}22m`,
  dim: (t: string) => `${CSI}2m${t}${CSI}22m`,
  italic: (t: string) => `${CSI}3m${t}${CSI}23m`,
  inverse: (t: string) => `${CSI}7m${t}${CSI}27m`,
  underline: (t: string) => `${CSI}4m${t}${CSI}24m`,
};

// ═══════════════════════════════════════════════════════
// Cursor
// ═══════════════════════════════════════════════════════

export const cur = {
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  up: (n = 1) => `${CSI}${n}A`,
  down: (n = 1) => `${CSI}${n}B`,
  fwd: (n = 1) => `${CSI}${n}C`,
  clearLine: `${CSI}2K`,
  clearBelow: `${CSI}0J`,
};

// ═══════════════════════════════════════════════════════
// Box chars (rounded)
// ═══════════════════════════════════════════════════════

const B = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
const D = { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' };

export function tw(): number { return Math.max(60, Math.min(process.stdout.columns ?? 80, 200)); }

export function divider(label: string): string {
  const w = tw();
  const side = Math.floor((w - label.length - 2) / 2);
  return t.subtle(B.h.repeat(Math.max(0, side)) + ' ' + t.dim(label) + ' ' + B.h.repeat(Math.max(0, side)));
}

// ═══════════════════════════════════════════════════════
// Welcome banner
// ═══════════════════════════════════════════════════════

export function welcomeBanner(version: string, provider: string): string {
  const w = Math.min(tw() - 4, 66);
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - visibleLen(s)));

  const inner = [
    '',
    pad(`  ${t.purpleBold(s.bold('◆ Code Agent'))}  ${t.dim(version)}`, w),
    pad(`  ${t.subtle(D.h.repeat(20))}`, w),
    '',
    pad(`  ${t.text(provider)}`, w),
    '',
    pad(`  ${t.green('❯')} ${t.text('Type a task to begin')}`, w),
    pad(`  ${t.cyan('@')} ${t.dim('attach files')}   ${t.cyan('/')} ${t.dim('commands')}   ${t.dim('↑↓ history')}`, w),
    '',
  ];

  const top = t.subtle(D.tl + D.h.repeat(w + 2) + D.tr);
  const bot = t.subtle(D.bl + D.h.repeat(w + 2) + D.br);

  return '\n' + top + '\n'
    + inner.map(l => t.subtle(D.v) + ' ' + l + ' ' + t.subtle(D.v)).join('\n')
    + '\n' + bot + '\n';
}

// ═══════════════════════════════════════════════════════
// File dropdown
// ═══════════════════════════════════════════════════════

export function renderFileDropdown(
  items: Array<{ label: string; detail?: string; highlighted: boolean }>,
  maxH = 8,
  w?: number,
): string[] {
  if (!items.length) return [];
  const width = Math.min((w ?? tw()) - 6, 66);
  const vis = items.slice(0, maxH);
  const out: string[] = [];

  const boxV = t.subtle(B.v);

  out.push(t.subtle(`  ${B.tl}${B.h.repeat(2)} Files ${B.h.repeat(Math.max(0, width - 9))}${B.tr}`));
  for (const it of vis) {
    const mark = it.highlighted ? t.purple('❯') : ' ';
    const name = it.highlighted ? t.selected(' ' + it.label + ' ') : t.text(it.label);
    const extra = it.detail ? ' ' + t.subtle(it.detail) : '';
    const vlen = 3 + it.label.length + (it.detail?.length ?? 0) + (it.highlighted ? 2 : 0);
    const fill = Math.max(0, width - vlen);
    out.push(boxV + ' ' + mark + ' ' + name + extra + ' '.repeat(fill) + ' ' + boxV);
  }
  out.push(t.subtle(`  ${B.bl}${B.h.repeat(width)}${B.br}`));
  return out;
}

// ═══════════════════════════════════════════════════════
// Command dropdown
// ═══════════════════════════════════════════════════════

export function renderCommandMenu(
  items: Array<{ cmd: string; desc: string; highlighted: boolean }>,
  w?: number,
): string[] {
  if (!items.length) return [];
  const width = Math.min((w ?? tw()) - 6, 52);
  const out: string[] = [];
  const boxV = t.subtle(B.v);

  out.push(t.subtle(`  ${B.tl}${B.h.repeat(2)} Commands ${B.h.repeat(Math.max(0, width - 12))}${B.tr}`));
  for (const it of items) {
    const mark = it.highlighted ? t.purple('❯') : ' ';
    const cmd = t.cyan(it.cmd.padEnd(14));
    const desc = t.dim(it.desc);
    const fill = Math.max(0, width - 18 - it.desc.length);
    out.push(boxV + ' ' + mark + ' ' + cmd + desc + ' '.repeat(fill) + ' ' + boxV);
  }
  out.push(t.subtle(`  ${B.bl}${B.h.repeat(width)}${B.br}`));
  return out;
}

// ═══════════════════════════════════════════════════════
// Hint bar
// ═══════════════════════════════════════════════════════

export function hintBar(): string {
  const parts = [
    `Tab ${t.dim('select')}`,
    `↑↓ ${t.dim('navigate')}`,
    `Enter ${t.dim('confirm')}`,
    `Esc ${t.dim('dismiss')}`,
  ];
  return '  ' + t.subtle(parts.join('  ·  '));
}

// ═══════════════════════════════════════════════════════
// Messages
// ═══════════════════════════════════════════════════════

export function toolCallBanner(toolName: string, args: Record<string, unknown>): string {
  return `${t.cyan('🔧 ' + toolName)} ${t.subtle(JSON.stringify(args).slice(0, 140))}`;
}

export function errorMsg(msg: string): string {
  return `\n  ${t.red('✗')} ${t.text(msg)}\n`;
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
