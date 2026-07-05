import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import stringWidth from 'string-width';
import { FileIndex } from './file-index.js';
import { t, s, modeBadge, modeAccent, renderCommandMenu, renderFileDropdown, hintText, userMessageBlock } from './renderer.js';
import type { I18nManager } from '../i18n/manager.js';
import type { ReplCommandInfo } from '../repl/commands.js';
import { normalizeTerminalText, supportsAnsi } from './terminal-capabilities.js';

export interface CapturedTaskInput {
  drain: () => string[];
  writeOutput: (text: string) => void;
  setLiveStatus: (lines: string | string[]) => void;
  clearLiveStatus: () => void;
  commitStatus: (lines: string | string[]) => void;
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
  onCtrlO?: () => string | null;
}

let keypressInitialized = false;

export function captureInputDuringTask(options: CaptureTaskInputOptions): CapturedTaskInput {
  if (!supportsAnsi()) {
    return {
      drain: () => [],
      writeOutput: (text: string) => { process.stdout.write(normalizeTerminalText(text)); },
      setLiveStatus: (lines: string | string[]) => { process.stdout.write(normalizeTerminalText(Array.isArray(lines) ? lines.join('\n') : lines) + '\n'); },
      clearLiveStatus: () => {},
      commitStatus: (lines: string | string[]) => { process.stdout.write(normalizeTerminalText(Array.isArray(lines) ? lines.join('\n') : lines) + '\n'); },
      pause: () => {},
      resume: () => {},
      stop: () => {},
    };
  }
  if (!keypressInitialized) {
    readline.emitKeypressEvents(process.stdin);
    keypressInitialized = true;
  }
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(true); } catch { /* ignore */ }
  }
  process.stdin.resume();
  process.stdout.write('\x1b[?2004h');

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
  let statusLineCount = 0;
  let outputLineOpen = false;
  let ctrlOOpen = false;
  let ctrlOLines = 0;
  let bracketedPaste = false;
  let pasteBuffer = '';
  const pasteInlineLimit = 300;
  const pasteBlocks: Array<{ placeholder: string; content: string }> = [];
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
  const insertText = (text: string) => {
    buffer = buffer.slice(0, pos) + text + buffer.slice(pos);
    pos += text.length;
    syncDropdown();
    renderBuffer();
  };
  const commitPaste = (text: string) => {
    const normalized = text.replace(/\r\n?/g, '\n');
    if (!normalized) return;
    if (normalized.length <= pasteInlineLimit && normalized.split('\n').length <= 8) {
      insertText(normalized);
      return;
    }
    const lineCount = normalized.split('\n').length;
    const placeholder = `[Pasted text #${pasteBlocks.length + 1} · ${lineCount} lines · ${normalized.length} chars]`;
    pasteBlocks.push({ placeholder, content: normalized });
    insertText(placeholder);
  };
  const resolvePastes = (text: string) => {
    let resolved = text;
    for (const paste of pasteBlocks) {
      resolved = resolved.split(paste.placeholder).join(paste.content);
    }
    return resolved;
  };

  const wrapInput = (text: string, width: number): string[] => {
    const rows: string[] = [];
    let row = '';
    let rowW = 0;
    for (const ch of text) {
      if (ch === '\n') { rows.push(row); row = ''; rowW = 0; continue; }
      const w = stringWidth(ch);
      if (rowW > 0 && rowW + w > width) { rows.push(row); row = ''; rowW = 0; }
      row += ch;
      rowW += w;
    }
    rows.push(row);
    return rows;
  };
  const locateCursor = (text: string, index: number, width: number): { line: number; col: number } => {
    let line = 0;
    let col = 0;
    let rowW = 0;
    let offset = 0;
    for (const ch of text) {
      if (offset >= index) break;
      if (ch === '\n') { line++; col = 0; rowW = 0; offset += ch.length; continue; }
      const w = stringWidth(ch);
      if (rowW > 0 && rowW + w > width) { line++; col = 0; rowW = 0; }
      col++;
      rowW += w;
      offset += ch.length;
    }
    return { line, col };
  };
  const prevCharIndex = (text: string, current: number): number => {
    if (current <= 0) return 0;
    let index = 0;
    for (const ch of text) {
      const next = index + ch.length;
      if (next >= current) return index;
      index = next;
    }
    return index;
  };
  const nextCharIndex = (text: string, current: number): number => {
    if (current >= text.length) return text.length;
    for (const ch of text.slice(current)) return current + ch.length;
    return text.length;
  };
  const renderCaret = (row: string, col: number): string => {
    const chars = [...row];
    const caretChar = chars[col] ?? ' ';
    return chars.slice(0, col).join('') + s.inverse(caretChar) + chars.slice(col + 1).join('');
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
    const contentW = Math.max(1, inner - 2 - prefixWidth);
    const inputText = before + ch + after;
    const wrapped = wrapInput(inputText, contentW);
    const caretLoc = locateCursor(inputText, before.length, contentW);
    const inputRows: string[] = wrapped.length ? wrapped : [''];
    const lines = [...queuedLines, top];
    inputRows.forEach((row: string, i: number) => {
      const hasCaret = i === caretLoc.line;
      const caretCol = hasCaret ? caretLoc.col : -1;
      const rawLine = hasCaret ? renderCaret(row, caretCol) : row;
      const pad = ' '.repeat(Math.max(0, contentW - stringWidth(row)));
      const prefix = i === 0 ? inputPrefix : ' '.repeat(prefixWidth);
      lines.push(`${t.subtle('│')} ${prefix}${rawLine}${pad} ${t.subtle('│')}`);
    });
    const bottom = t.subtle('╰' + '─'.repeat(inner) + '╯');
    lines.push(bottom);
    const midIndex = queuedLines.length + 1 + caretLoc.line;
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
        tab: options.i18n.t('hint.tab_select'),
        navigate: options.i18n.t('hint.arrow_navigate'),
        confirm: options.i18n.t('hint.enter_confirm'),
        dismiss: options.i18n.t('hint.esc_dismiss'),
        sep: options.i18n.t('hint.separator'),
      })));
    }
    const cursorCol = 2 + prefixWidth + stringWidth(inputRows[caretLoc.line]?.slice(0, caretLoc.col) ?? '');
    process.stdout.write(`\r${lines.map((line, i) => `${i === 0 ? '' : '\n'}\x1b[2K${line}`).join('')}\x1b[${Math.max(0, lines.length - 1 - midIndex)}A\r\x1b[${Math.max(1, cursorCol)}C`);
    inputLinesOnScreen = lines.length;
    inputCursorLineIndex = midIndex;
  };

  const clearCtrlO = () => {
    if (!ctrlOOpen || ctrlOLines <= 0) return;
    clearInputLine();
    process.stdout.write(`\x1b[${ctrlOLines}A\r`);
    for (let i = 0; i < ctrlOLines; i++) {
      process.stdout.write('\x1b[2K');
      if (i < ctrlOLines - 1) process.stdout.write('\x1b[1B\r');
    }
    if (ctrlOLines > 1) process.stdout.write(`\x1b[${ctrlOLines - 1}A\r`);
    ctrlOOpen = false;
    ctrlOLines = 0;
  };

  const toStatusLines = (lines: string | string[]) => {
    const text = Array.isArray(lines) ? lines.join('\n') : lines;
    return normalizeStatusText(text).replace(/\n+$/g, '').split('\n').filter((line, index, arr) => line.length > 0 || arr.length > 1 || index === 0);
  };

  const clearStatusLine = () => {
    if (!statusLineActive || statusLineCount <= 0) return;
    clearCtrlO();
    clearInputLine();
    const lines = statusLineCount;
    process.stdout.write(`\x1b[${lines}A\r`);
    for (let i = 0; i < lines; i++) {
      process.stdout.write('\x1b[2K');
      if (i < lines - 1) process.stdout.write('\x1b[1B\r');
    }
    if (lines > 1) process.stdout.write(`\x1b[${lines - 1}A\r`);
    statusLineActive = false;
    statusLineCount = 0;
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
  const setLiveStatus = (lines: string | string[]) => {
    const statusLines = toStatusLines(lines);
    if (statusLines.length === 0 || statusLines.every(line => line.trim().length === 0)) {
      clearLiveStatus();
      return;
    }
    if (statusLineActive) clearStatusLine();
    else clearBuffer();
    process.stdout.write(statusLines.join('\n') + '\n');
    statusLineActive = true;
    statusLineCount = statusLines.length;
    renderBuffer();
  };

  const clearLiveStatus = () => {
    if (statusLineActive) clearStatusLine();
    renderBuffer();
  };

  const commitStatus = (lines: string | string[]) => {
    const statusLines = toStatusLines(lines);
    if (statusLineActive) clearStatusLine();
    else clearBuffer();
    if (statusLines.length > 0 && statusLines.some(line => line.trim().length > 0)) {
      process.stdout.write(statusLines.join('\n') + '\n');
    }
    renderBuffer();
  };

  const writeStatus = (text: string) => {
    const normalized = normalizeStatusText(text);
    if (normalized.trim().length === 0) clearLiveStatus();
    else setLiveStatus(normalized);
  };
  const writeOutput = (text: string) => {
    clearCtrlO();
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
    const seq = key?.sequence ?? str ?? '';
    if (bracketedPaste) {
      const end = seq.indexOf('\x1b[201~');
      if (end >= 0) {
        pasteBuffer += seq.slice(0, end);
        bracketedPaste = false;
        commitPaste(pasteBuffer);
        pasteBuffer = '';
        const rest = seq.slice(end + 6);
        if (rest) commitPaste(rest);
      } else {
        pasteBuffer += seq;
      }
      return;
    }
    const pasteStart = seq.indexOf('\x1b[200~');
    if (pasteStart >= 0) {
      const afterStart = seq.slice(pasteStart + 6);
      const pasteEnd = afterStart.indexOf('\x1b[201~');
      if (pasteEnd >= 0) {
        commitPaste(afterStart.slice(0, pasteEnd));
        const rest = afterStart.slice(pasteEnd + 6);
        if (rest) commitPaste(rest);
      } else {
        bracketedPaste = true;
        pasteBuffer = afterStart;
      }
      return;
    }

    if (key?.ctrl && key.name === 'o') {
      if (!options.onCtrlO) return;
      if (ctrlOOpen) {
        clearCtrlO();
        renderBuffer();
        return;
      }
      const content = options.onCtrlO();
      if (!content) return;
      clearStatusLine();
      clearBuffer();
      const text = content.endsWith('\n') ? content : content + '\n';
      process.stdout.write(text);
      ctrlOLines = text.split('\n').length - 1;
      ctrlOOpen = true;
      renderBuffer();
      return;
    }

    if (ctrlOOpen) {
      clearCtrlO();
      renderBuffer();
    }

    if (key?.ctrl && key.name === 'c') {
      buffer = '';
      pos = 0;
      pasteBlocks.length = 0;
      resetDropdown();
      renderBuffer();
      options.onCancel();
      return;
    }
    if (key?.name === 'return' || key?.name === 'enter') {
      if (dd !== 'none' && applyDropdown()) return;
      const text = resolvePastes(buffer).trim();
      buffer = '';
      pos = 0;
      pasteBlocks.length = 0;
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
      pos = prevCharIndex(buffer, pos);
      syncDropdown();
      renderBuffer();
      return;
    }
    if (key?.name === 'right') {
      pos = nextCharIndex(buffer, pos);
      renderBuffer();
      return;
    }
    if (key?.name === 'backspace') {
      if (pos > 0) {
        const prev = prevCharIndex(buffer, pos);
        buffer = buffer.slice(0, prev) + buffer.slice(pos);
        pos = prev;
      }
      syncDropdown();
      renderBuffer();
      return;
    }
    if (key?.name === 'delete') {
      if (pos < buffer.length) {
        const next = nextCharIndex(buffer, pos);
        buffer = buffer.slice(0, pos) + buffer.slice(next);
      }
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
      insertText(str);
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
    setLiveStatus,
    clearLiveStatus,
    commitStatus,
    pause: () => {
      if (!active) return;
      active = false;
      process.stdin.removeListener('keypress', onKeypress);
      clearStatusLine();
      clearBuffer();
    },
    resume: () => {
      if (active) return;
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(true); } catch { /* ignore */ }
      }
      process.stdin.resume();
      active = true;
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.on('keypress', onKeypress);
      renderBuffer();
    },
    stop: () => {
      if (active) process.stdin.removeListener('keypress', onKeypress);
      active = false;
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch { /* ignore */ }
      }
      process.stdout.write('\x1b[?2004l');
      clearCtrlO();
      clearStatusLine();
      // 清理 task-input-capture 渲染的行，让主 TuiInput 干净接管
      if (inputLinesOnScreen > 0) {
        const down = Math.max(0, inputLinesOnScreen - 1 - inputCursorLineIndex);
        if (down > 0) process.stdout.write(`\x1b[${down}B`);
        process.stdout.write('\r');
        for (let i = 0; i < inputLinesOnScreen; i++) {
          process.stdout.write('\x1b[2K');
          if (i < inputLinesOnScreen - 1) process.stdout.write('\x1b[1A\r');
        }
        inputLinesOnScreen = 0;
        inputCursorLineIndex = 0;
      }
    },
  };
}
