/**
 * TUI 渲染 — ANSI + Unicode 框线。Modern 256-color palette.
 */
import { bannerText } from './big-text.js';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
export { t, s, formatDuration, type Mode, modeAccent, modeBadge } from './colors.js';
import { t, s, formatDuration } from './colors.js';
import { normalizeTerminalText, displayWidth as terminalDisplayWidth, supportsAnsi, supportsAnimation } from './terminal-capabilities.js';

function cb(text: string, fg: number, bg: number): string {
  const value = normalizeTerminalText(text);
  if (!supportsAnsi()) return value;
  return `\x1b[38;5;${fg}m\x1b[48;5;${bg}m${value}\x1b[39;49m`;
}

// ── 框线字符 ──
const B = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

function tw(): number {
  return Math.max(60, Math.min(process.stdout.columns ?? 80, 200));
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
  maxH = 10,
  w?: number,
): string[] {
  if (!items.length) return [];
  const width = Math.min((w ?? tw()) - 8, 64);
  const selected = Math.max(0, items.findIndex(i => i.highlighted));
  const start = Math.max(0, Math.min(selected - Math.floor(maxH / 2), items.length - maxH));
  const vis = items.slice(start, start + maxH);
  const out: string[] = [];

  out.push(t.subtle('╭') + t.subtle('─'.repeat(2)) + ' ' + s.bold(t.purple(labels.header)) + ' ' + t.subtle('─'.repeat(Math.max(0, width - 5 - visibleLen(labels.header)))) + t.subtle('╮'));
  for (const it of vis) {
    const mark = it.highlighted ? t.accent('▸') : ' ';
    const detailW = it.detail ? Math.min(12, visibleLen(it.detail)) : 0;
    const labelW = Math.max(8, width - 6 - detailW);
    const clippedLabel = clipAnsiSafe(it.label, labelW);
    const clippedDetail = it.detail ? clipAnsiSafe(it.detail, detailW) : '';
    const name = it.highlighted ? t.selected(` ${clippedLabel} `) : t.text(` ${clippedLabel} `);
    const extra = clippedDetail ? ' ' + t.faint(clippedDetail) : '';
    const rpad = Math.max(0, width - 4 - visibleLen(clippedLabel) - (clippedDetail ? 1 + visibleLen(clippedDetail) : 0));
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
  maxH = 10,
): string[] {
  if (!items.length) return [];
  const width = Math.min((w ?? tw()) - 8, 52);
  const selected = Math.max(0, items.findIndex(i => i.highlighted));
  const start = Math.max(0, Math.min(selected - Math.floor(maxH / 2), items.length - maxH));
  const vis = items.slice(start, start + maxH);
  const out: string[] = [];

  out.push(t.subtle('╭') + t.subtle('─'.repeat(2)) + ' ' + s.bold(t.purple(header)) + ' ' + t.subtle('─'.repeat(Math.max(0, width - 5 - visibleLen(header)))) + t.subtle('╮'));
  for (const it of vis) {
    const mark = it.highlighted ? t.accent('▸') : ' ';
    const rawCmd = clipAnsiSafe(it.cmd, 14);
    const rawDesc = clipAnsiSafe(it.desc, Math.max(8, width - 20));
    const cmdText = rawCmd + ' '.repeat(Math.max(0, 14 - visibleLen(rawCmd)));
    const cmd = it.highlighted ? t.accent(cmdText) : t.dim(cmdText);
    const desc = it.highlighted ? t.text(rawDesc) : t.faint(rawDesc);
    const rpad = Math.max(0, width - 18 - visibleLen(rawDesc));
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
  const dur = elapsedMs !== undefined ? t.subtle(` ${formatDuration(elapsedMs)}`) : '';
  return `\r\x1b[2K${toolTitle(toolName, label)}${countText}${argsStr}${dur}\r`;
}

export function toolCallPending(toolName: string, count: number, latest: string, elapsedMs?: number, label?: string, toolsLabel = 'tools'): string {
  const countText = count > 1 ? ` ${t.subtle(`· ${count} ${toolsLabel}`)}` : '';
  const argsStr = latest ? ` ${t.subtle('·')} ${t.dim(latest.slice(0, 60))}` : '';
  const dur = elapsedMs !== undefined ? t.subtle(` ${formatDuration(elapsedMs)}`) : '';
  return `${toolTitle(toolName, label)}${countText}${argsStr}${dur}\n`;
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
  if (!supportsAnimation()) {
    let printed = false;
    return {
      update: (text: string) => { if (!printed) { write(`${normalizeTerminalText(text)}\n`); printed = true; } },
      tick: () => {},
      stop: () => {},
    };
  }
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
  if (!supportsAnimation()) {
    return {
      thinkStart: () => {},
      thinkTick: () => {},
      thinkDone: (elapsedMs: number, tokens: number, expandHint: string) => {
        write(`${normalizeTerminalText(thinkingSummary(formatDuration(elapsedMs), `${tokens}`, expandHint, labels))}\n`);
      },
      stop: () => {},
    };
  }
  let idx = 0;
  let state: { elapsedMs: number; tokens: number; subtitle: string } = { elapsedMs: 0, tokens: 0, subtitle: '' };
  let interval: ReturnType<typeof setInterval> | null = null;
  let done = false;
  let linesOnScreen = 0; // 0 或 1
  let currentTip = '';
  let startMs = 0;

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
    const elapsedMs = startMs > 0 ? Date.now() - startMs : state.elapsedMs;
    const elapsed = formatTime(elapsedMs);
    const tok = formatTokens(state.tokens);
    const sub = state.subtitle || currentTip || '';
    const line = thinkingLive(frame, elapsed, tok, sub, labels).split('\n')[0]!;
    write(`\r${line}`);
  };

  return {
    thinkStart: () => {
      idx = 0;
      startMs = Date.now();
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

// ── Markdown 渲染 — 委托给 markdown.ts ──
export { renderMarkdown, renderInlineMarkdown } from './markdown.js';

// ── 工具颜色映射 ──

const TOOL_COLOR: Record<string, (s: string) => string> = {
  read_file: t.blue,
  list_files: t.blue,
  stat_file: t.blue,
  tree: t.blue,
  glob: t.blue,
  inspect_file: t.blue,
  extract_text: t.blue,
  extract_pdf_text: t.blue,
  extract_docx_text: t.blue,
  extract_xlsx_data: t.blue,
  video_metadata: t.blue,
  repo_map: t.purple,
  symbol_search: t.purple,
  dependency_graph: t.purple,
  detect_package_manager: t.blue,
  search: t.purple,
  knowledge_search: t.purple,
  lsp_definition: t.purple,
  lsp_references: t.purple,
  lsp_diagnostics: t.purple,
  web_search: t.accent,
  web_fetch: t.accent,
  download_file: t.accent,
  browser_open: t.accent,
  write_file: t.accent,
  edit_file: t.accent,
  multi_edit: t.accent,
  delete_file: t.error,
  move_file: t.accent,
  copy_file: t.accent,
  mkdir: t.accent,
  export_markdown: t.success,
  export_json: t.success,
  export_html: t.success,
  export_pdf: t.success,
  export_session: t.success,
  export_patch: t.success,
  zip_files: t.success,
  checkpoint_create: t.success,
  checkpoint_list: t.blue,
  checkpoint_restore: t.warning,
  checkpoint_delete: t.error,
  execute_command: t.warning,
  run_background: t.warning,
  check_command: t.blue,
  stop_command: t.error,
  run_test: t.warning,
  run_build: t.warning,
  run_lint: t.warning,
  open_preview: t.accent,
  git_commit: t.success,
  git_status: t.success,
  git_diff: t.success,
  git_log: t.success,
  git_stash: t.warning,
  git_apply_patch: t.warning,
  git_create_patch: t.success,
  ocr_image: t.purple,
  transcribe_audio: t.purple,
  convert_file: t.warning,
  compress_image: t.warning,
  generate_thumbnail: t.warning,
  doctor: t.blue,
  version: t.blue,
  tool_health: t.blue,
  todo_write: t.success,
  mcp_list: t.purple,
  mcp_add: t.warning,
  mcp_remove: t.error,
  mcp_tools: t.purple,
  plugin_list: t.purple,
  plugin_install: t.warning,
};

const TOOL_ICON: Record<string, string> = {
  read_file: '◰',
  list_files: '▤',
  stat_file: 'ℹ',
  tree: '┬',
  glob: '⌁',
  inspect_file: '◉',
  extract_text: '▣',
  extract_pdf_text: '📄',
  extract_docx_text: '📃',
  extract_xlsx_data: '▦',
  video_metadata: '▶',
  repo_map: '⌂',
  symbol_search: '⌘',
  dependency_graph: '⟡',
  detect_package_manager: '◫',
  search: '⌕',
  knowledge_search: '◈',
  web_search: '🌐',
  web_fetch: '↧',
  download_file: '⇩',
  browser_open: '↗',
  write_file: '✎',
  edit_file: '✐',
  multi_edit: '✐',
  delete_file: '✕',
  move_file: '↦',
  copy_file: '⧉',
  mkdir: '⊕',
  export_markdown: '▤',
  export_json: '◈',
  export_html: '◇',
  export_pdf: '📄',
  export_session: '⇪',
  export_patch: 'Δ',
  zip_files: '▣',
  checkpoint_create: '●',
  checkpoint_list: '○',
  checkpoint_restore: '↶',
  checkpoint_delete: '⊗',
  execute_command: '⌘',
  run_background: '◷',
  check_command: '◴',
  stop_command: '■',
  run_test: '✓',
  run_build: '▲',
  run_lint: '⚑',
  open_preview: '◌',
  git_commit: '⑂',
  git_status: '⑂',
  git_diff: 'Δ',
  git_log: '⑂',
  git_stash: '⇥',
  git_apply_patch: 'Δ',
  git_create_patch: 'Δ',
  ocr_image: '◍',
  transcribe_audio: '♪',
  convert_file: '⇄',
  compress_image: '▣',
  generate_thumbnail: '▧',
  doctor: '✚',
  version: '◷',
  tool_health: '✚',
  todo_write: '☑',
  mcp_list: '◬',
  mcp_add: '⊕',
  mcp_remove: '⊖',
  mcp_tools: '◬',
  plugin_list: '◧',
  plugin_install: '⊞',
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
  const ansiRe = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
  return terminalDisplayWidth(normalizeTerminalText(s.replace(ansiRe, '')));
}

function clipAnsiSafe(text: string, maxWidth: number): string {
  if (maxWidth <= 1) return '';
  if (visibleLen(text) <= maxWidth) return text;
  let out = '';
  for (const ch of text) {
    if (visibleLen(out + ch) > maxWidth - 1) return out + '…';
    out += ch;
  }
  return out;
}

