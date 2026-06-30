import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import stringWidth from 'string-width';
import { FileIndex } from './file-index.js';
import { t, s, modeBadge, modeAccent, renderCommandMenu, renderFileDropdown, hintText, userMessageBlock } from './renderer.js';
import type { I18nManager } from '../i18n/manager.js';
import type { ReplCommandInfo } from '../repl/commands.js';

export interface CapturedTaskInput {
  drain: () => string[];
  writeOutput: (text: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

export interface CaptureTaskInputOptions {
  projectRoot: string;
  commands: ReplCommandInfo[];
  i18n: I18nManager;
  tokenStats: () => { tokens: number; limit: number };
  onCancel: () => void;
}

let keypressInitialized = false;

export function captureInputDuringTask(options: CaptureTaskInputOptions): CapturedTaskInput {
  if (!keypressInitialized) {
    readline.emitKeypressEvents(process.stdin);
    keypressInitialized = true;
  }
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(true); } catch { /* ignore */ }
  }
  process.stdin.resume();

  const pending: string[] = [];
  const fileIndex = new FileIndex(options.projectRoot);
  let buffer = '';
  let pos = 0;
  let dd: 'none' | 'file' | 'command' = 'none';
  let items: Array<{ label: string; detail?: string; data: string }> = [];
  let sel = 0;
  let fStart = -1;
  let fEnd = -1;
  let inputLinesOnScreen = 0;
  let inputCursorLineIndex = 0;
  let statusLineActive = false;
  let outputLineOpen = false;
  const promptSymbol = '›';
  const mode = 'AGENT';

  const sizeOf = (rel: string) => {
    try {
      const st = fs.statSync(path.join(options.projectRoot, rel));
      return st.isDirectory() ? 'dir' : `${Math.ceil(st.size / 1024)} KB`;
    } catch { return ''; }
  };

  const clearInputLine = () => {
    if (inputLinesOnScreen > 0) {
      const down = Math.max(0, inputLinesOnScreen - 1 - inputCursorLineIndex);
      if (down) process.stdout.write(`\x1b[${down}B`);
      process.stdout.write(`\r\x1b[2K${'\x1b[1A\r\x1b[2K'.repeat(inputLinesOnScreen - 1)}`);
      inputLinesOnScreen = 0;
      inputCursorLineIndex = 0;
      return;
    }
    process.stdout.write('\r\x1b[2K');
  };

  const resetDropdown = () => { dd = 'none'; items = []; sel = 0; fStart = -1; fEnd = -1; };
  const syncDropdown = () => {
    resetDropdown();
    if (buffer.startsWith('/')) {
      const firstSpace = buffer.indexOf(' ');
      const commandEnd = firstSpace >= 0 ? firstSpace : buffer.length;
      if (pos <= commandEnd) {
        const p = buffer.slice(1, commandEnd).toLowerCase();
        const m = options.commands
          .filter(c => c.name.toLowerCase().includes(p))
          .map(c => ({ label: c.name, detail: c.desc, data: c.name + ' ' }));
        if (m.length) { dd = 'command'; items = m; fStart = 0; fEnd = commandEnd; }
      }
      return;
    }
    const at = buffer.lastIndexOf('@', pos - 1);
    if (at < 0 || buffer[at + 1] === ' ') return;
    const endOfWord = buffer.indexOf(' ', at + 1);
    if (endOfWord >= 0 && endOfWord < pos) return;
    const partial = buffer.slice(at + 1, pos).toLowerCase();
    const matches = fileIndex.search(partial, 50);
    if (matches.length) {
      dd = 'file';
      items = matches.map(f => ({ label: f, detail: sizeOf(f), data: '@' + f + ' ' }));
      fStart = at;
      fEnd = pos;
    }
  };

  const applyDropdown = () => {
    const item = items[sel];
    if (!item) return false;
    const end = fEnd >= 0 ? fEnd : buffer.length;
    buffer = buffer.slice(0, fStart) + item.data + buffer.slice(end);
    pos = fStart + item.data.length;
    resetDropdown();
    renderBuffer();
    return true;
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
    const queuedLines = pending.flatMap(text => {
      const lines = userMessageBlock(text, options.i18n.t('message.queued'), 'queued').trimEnd().split('\n');
      if (lines[0] === '') lines.shift();
      return lines;
    });
    const stats = options.tokenStats();
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
    const midIndex = queuedLines.length + 1;
    if (dd !== 'none' && items.length) {
      const ddPrefix = `${bar} `;
      if (dd === 'command') {
        for (const line of renderCommandMenu(
          items.map((it, i) => ({ cmd: it.label, desc: it.detail ?? '', highlighted: i === sel })),
          options.i18n.t('dropdown.commands_header'),
        )) lines.push(ddPrefix + line);
      } else {
        for (const line of renderFileDropdown(
          items.map((it, i) => ({ label: it.label, detail: it.detail, highlighted: i === sel })),
          { header: options.i18n.t('dropdown.files_header'), more: (n: number) => options.i18n.t('dropdown.more', { count: String(n) }) },
        )) lines.push(ddPrefix + line);
      }
      lines.push(ddPrefix + t.subtle(hintText({
        tab: options.i18n.t('hint.tab'),
        navigate: options.i18n.t('hint.navigate'),
        confirm: options.i18n.t('hint.confirm'),
        dismiss: options.i18n.t('hint.dismiss'),
        sep: options.i18n.t('hint.sep'),
      })));
    }
    const cursorCol = 2 + prefixWidth + stringWidth(before);
    process.stdout.write(`\r${lines.map((line, i) => `${i === 0 ? '' : '\n'}\x1b[2K${line}`).join('')}\x1b[${Math.max(0, lines.length - 1 - midIndex)}A\r\x1b[${Math.max(1, cursorCol)}C`);
    inputLinesOnScreen = lines.length;
    inputCursorLineIndex = midIndex;
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
  const cursorControlRe = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ABCDGJK]`, 'g');
  const normalizeStatusText = (text: string) => text.replace(cursorControlRe, '').replace(/^\r+/, '');
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
    if (outputLineOpen) {
      process.stdout.write(text);
      outputLineOpen = text.length > 0 && !text.endsWith('\n');
      if (!outputLineOpen) renderBuffer();
      return;
    }
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
        resetDropdown();
        renderBuffer();
        return;
      }
      writeOutput(t.warning(options.i18n.t('status.cancelled')) + '\n');
      active = false;
      process.stdin.removeListener('keypress', onKeypress);
      options.onCancel();
      return;
    }
    if (key?.name === 'return' || key?.name === 'enter') {
      if (dd !== 'none' && applyDropdown()) return;
      const text = buffer.trim();
      buffer = '';
      pos = 0;
      resetDropdown();
      clearStatusLine();
      clearBuffer();
      if (text) pending.push(text);
      renderBuffer();
      return;
    }
    if (key?.name === 'tab') {
      if (dd !== 'none' && applyDropdown()) return;
    }
    if (key?.name === 'escape') {
      if (dd !== 'none') { resetDropdown(); renderBuffer(); return; }
    }
    if (key?.name === 'up') {
      if (dd !== 'none') { sel = Math.max(0, sel - 1); renderBuffer(); return; }
    }
    if (key?.name === 'down') {
      if (dd !== 'none') { sel = Math.min(items.length - 1, sel + 1); renderBuffer(); return; }
    }
    if (key?.name === 'left') {
      pos = Math.max(0, pos - 1);
      syncDropdown();
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
      syncDropdown();
      renderBuffer();
      return;
    }
    if (key?.name === 'delete') {
      if (pos < buffer.length) buffer = buffer.slice(0, pos) + buffer.slice(pos + 1);
      syncDropdown();
      renderBuffer();
      return;
    }
    if (key?.ctrl && key.name === 'a') {
      pos = 0;
      syncDropdown();
      renderBuffer();
      return;
    }
    if (key?.ctrl && key.name === 'e') {
      pos = buffer.length;
      syncDropdown();
      renderBuffer();
      return;
    }
    if (key?.ctrl && key.name === 'u') {
      buffer = '';
      pos = 0;
      resetDropdown();
      renderBuffer();
      return;
    }
    if (str && str >= ' ') {
      buffer = buffer.slice(0, pos) + str + buffer.slice(pos);
      pos += str.length;
      syncDropdown();
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
      // 清理 task-input-capture 渲染的行，让主 TuiInput 干净接管
      if (inputLinesOnScreen > 0) {
        const up = inputLinesOnScreen - 1 - inputCursorLineIndex;
        if (up > 0) process.stdout.write(`\x1b[${up}B`);
        for (let i = 0; i < inputLinesOnScreen; i++) {
          process.stdout.write('\x1b[2K');
          if (i < inputLinesOnScreen - 1) process.stdout.write('\x1b[1A');
        }
        process.stdout.write('\r');
        inputLinesOnScreen = 0;
      }
    },
  };
}
