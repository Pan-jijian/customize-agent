/**
 * TUI 输入 — 原始模式键盘输入，支持模糊文件名/命令补全。
 *
 * 绘制策略:
 *   1. \r 回到输入行第 0 列（前一次绘制已确保光标在此行）
 *   2. \x1b[0J (clearBelow) 一次清除前次渲染
 *   3. 写入输入行 + 可选下拉菜单
 *   4. \x1b[{n}A 回到输入行，\r，\x1b[{col}C 移到光标列
 *   5. 单次 process.stdout.write() — 零闪烁
 */
import * as fs from 'fs';
import * as readline from 'readline';
import {
  t, s, modeBadge, modeAccent,
  renderFileDropdown, renderCommandMenu, hintText, userMessageBlock,
} from './renderer.js';
import type { Mode } from './renderer.js';
import { FileIndex } from './file-index.js';
import { supportsAnsi } from './terminal-capabilities.js';

// ── 类型定义 ──
export interface DropdownItem { label: string; detail?: string; data: string; }
export interface TuiLabels {
  filesHeader: string;
  commandsHeader: string;
  more: (n: number) => string;
  hintTab: string;
  hintNavigate: string;
  hintConfirm: string;
  hintDismiss: string;
  hintSep: string;
}

export interface TuiConfig {
  projectRoot: string;
  commands?: Array<{ name: string; desc: string }>;
  labels?: TuiLabels;
  prompt?: string; mode?: Mode; history?: string[];
  tokenStats?: () => { used: number; limit: number } | null;
  /** ctrl+o 回调：返回要展示的内容，或 null 表示无内容 */
  onCtrlO?: () => string | null;
  /** 空输入 Ctrl+C 回调：返回 true 表示已处理，不退出 */
  onCancel?: () => boolean;
}

interface PasteBlock {
  placeholder: string;
  content: string;
}

interface St {
  text: string; pos: number;
  dd: 'none' | 'file' | 'command';
  items: DropdownItem[]; sel: number;
  fStart: number; fEnd: number;
  pastes: PasteBlock[];
}

let _kprInit = false;

// ── 前缀可见宽度（用于光标列计算）──
// " AGENT  │ ➜ " → (mode+2) + 各分隔符(空格+│+空格+➜+空格) = mode.length + 7
function prefixVis(mode: string): number { return mode.length + 7; }

// ── 显示宽度（CJK/全角 = 2 列，ASCII = 1 列）──
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2E80 && cp <= 0x9FFF) { w += 2; }
    else if (cp >= 0x3400 && cp <= 0x4DBF) { w += 2; }
    else if (cp >= 0xFF00 && cp <= 0xFFEF) { w += 2; }
    else if (cp >= 0x3000 && cp <= 0x303F) { w += 2; }
    else if (cp >= 0x2190 && cp <= 0x21FF) { w += 2; }
    else if (cp >= 0x2600 && cp <= 0x27BF) { w += 2; }
    else { w += 1; }
  }
  return w;
}

// ── 裸 ANSI 转义序列 ──
const CSI = '\x1b[';

// ── TuiInput 类 ──
export class TuiInput {
  private fileIndex: FileIndex;
  private root: string;
  private cmds: Array<{ name: string; desc: string }>;
  private prompt: string;
  private mode: Mode;
  private hist: string[];
  private hi: number;
  private sz = new Map<string, string>();
  private _prevLines = 0;
  private _prevCursorLine = 0;
  private labels: TuiLabels;
  private _tokenStats?: () => { used: number; limit: number } | null;
  private _onCtrlO?: () => string | null;
  private _onCancel?: () => boolean;
  private _externalWrite?: (text: string) => void;
  private _activeKeypress?: (str: string | undefined, key: readline.Key) => void;
  private _activeResize?: () => void;
  private _activeRender?: () => void;
  private _activeClear?: () => void;
  private _activeRaw = false;
  private _suspendDepth = 0;
  private _pendingBlocks: Array<{ text: string; label: string; variant: 'user' | 'queued' }> = [];
  private _draft = '';

  constructor(cfg: TuiConfig) {
    this.root = cfg.projectRoot;
    this.fileIndex = new FileIndex(cfg.projectRoot);
    this.cmds = cfg.commands ?? [];
    this.prompt = cfg.prompt ?? '➜';
    this.mode = cfg.mode ?? 'AGENT';
    this.hist = cfg.history ?? [];
    this.hi = this.hist.length;
    this._tokenStats = cfg.tokenStats;
    this._onCtrlO = cfg.onCtrlO;
    this._onCancel = cfg.onCancel;
    this.labels = cfg.labels ?? {
      filesHeader: 'Files', commandsHeader: 'Commands',
      more: (n) => `… ${n} more`,
      hintTab: 'Tab select', hintNavigate: '↑↓ navigate', hintConfirm: 'Enter confirm', hintDismiss: 'Esc dismiss',
      hintSep: '  ·  ',
    };
  }

  setDraft(text: string): void {
    this._draft = text;
  }

  writeExternal(text: string): void {
    if (this._externalWrite) this._externalWrite(text);
    else process.stdout.write(text);
  }

  setPendingBlocks(blocks: Array<{ text: string; label: string; variant: 'user' | 'queued' }>, options: { redraw?: boolean } = { redraw: true }): void {
    this._pendingBlocks = blocks;
    if (options.redraw !== false) this._activeRender?.();
  }

  suspend(): void {
    this._suspendDepth++;
    if (this._suspendDepth > 1) return;
    if (this._activeKeypress) process.stdin.removeListener('keypress', this._activeKeypress);
    if (this._activeResize) process.stdout.removeListener('resize', this._activeResize);
    this._activeClear?.();
  }

  resume(options: { redraw?: boolean } = {}): void {
    if (this._suspendDepth <= 0) return;
    this._suspendDepth--;
    if (this._suspendDepth > 0) return;
    if (process.stdin.isTTY && this._activeRaw) {
      try { process.stdin.setRawMode(true); } catch { /* ignore */ }
    }
    process.stdin.resume();
    if (this._activeKeypress) {
      process.stdin.removeListener('keypress', this._activeKeypress);
      process.stdin.on('keypress', this._activeKeypress);
    }
    if (this._activeResize) {
      process.stdout.removeListener('resize', this._activeResize);
      process.stdout.on('resize', this._activeResize);
    }
    if (options.redraw) this._activeRender?.();
  }

  private async _readPlain(): Promise<string> {
    return new Promise<string>(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('> ', answer => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  // read 读取输入

  async read(): Promise<string> {
    if (!supportsAnsi()) return this._readPlain();
    return new Promise<string>(resolve => {
      if (!_kprInit) { readline.emitKeypressEvents(process.stdin); _kprInit = true; }
      if (this._activeKeypress) process.stdin.removeListener('keypress', this._activeKeypress);
      if (this._activeResize) process.stdout.removeListener('resize', this._activeResize);
      this._activeKeypress = undefined;
      this._activeResize = undefined;
      this._activeRender = undefined;
      this._activeClear = undefined;
      this._externalWrite = undefined;
      this._activeRaw = false;
      this._suspendDepth = 0;

      const initialDraft = this._draft;
      this._draft = '';
      const st: St = { text: initialDraft, pos: initialDraft.length, dd: 'none', items: [], sel: 0, fStart: -1, fEnd: -1, pastes: [] };
      let lastEmptyCtrlC = 0;
      let ctrlOOpen = false;
      let ctrlOLines = 0;
      let externalStatusActive = false;
      let raw = false;
      let bracketedPaste = false;
      let pasteBuffer = '';
      const pasteInlineLimit = 300;
      let resizeDebounce: ReturnType<typeof setTimeout> | undefined;
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(true); raw = true; this._activeRaw = true; } catch { /* */ }
      }

      process.stdout.write(CSI + '?25l' + CSI + '?2004h');
      this._draw(st);

      // 终端 resize：debounce 后用新宽度重绘，不碰上方对话历史
      const onResize = () => {
        if (resizeDebounce) clearTimeout(resizeDebounce);
        resizeDebounce = setTimeout(() => {
          resizeDebounce = undefined;
          // 向上 1 行到顶部边框（光标从输入行 → 顶部边框）
          const cursorLine = this._prevCursorLine;
          if (cursorLine > 0) process.stdout.write(`${CSI}${cursorLine}A`);
          // 从顶部边框清到屏幕底部（清除旧宽度 reflow 残骸）
          process.stdout.write('\r' + CSI + '0J');
          this._prevLines = 0;
          this._prevCursorLine = 0;
          this._draw(st);
        }, 100);
      };
      this._activeResize = onResize;
      this._activeRender = () => this._draw(st);
      process.stdout.on('resize', onResize);

      const clearRendered = () => {
        const lines = this._prevLines;
        if (lines <= 0) return;
        const cursorLine = this._prevCursorLine;
        const linesBelowCursor = Math.max(0, lines - 1 - cursorLine);
        let out = linesBelowCursor > 0 ? `${CSI}${linesBelowCursor}B` : '';
        out += '\r';
        for (let i = 0; i < lines; i++) {
          out += CSI + '2K';
          if (i < lines - 1) out += `${CSI}1A\r`;
        }
        process.stdout.write(out);
        this._prevLines = 0;
        this._prevCursorLine = 0;
      };
      this._activeClear = clearRendered;

      const cursorControlRe = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ABCDGJK]`, 'g');
      const stripCursorControls = (text: string) => text
        .replace(cursorControlRe, '')
        .replace(/^\r+/, '');

      const clearExternalStatus = () => {
        if (!externalStatusActive) return;
        clearRendered();
        process.stdout.write(`${CSI}1A\r${CSI}2K`);
        externalStatusActive = false;
      };

      this._externalWrite = (text: string) => {
        clearCtrlO();
        const isStatus = text.startsWith('\r');
        const normalized = stripCursorControls(text);
        if (isStatus) {
          clearRendered();
          if (externalStatusActive) process.stdout.write(`${CSI}1A\r${CSI}2K`);
          if (normalized.trim().length > 0) {
            process.stdout.write(normalized.endsWith('\n') ? normalized : normalized + '\n');
            externalStatusActive = true;
          } else {
            externalStatusActive = false;
          }
          this._draw(st);
          return;
        }
        clearExternalStatus();
        clearRendered();
        process.stdout.write(normalized);
        this._draw(st);
      };

      const clearCtrlO = () => {
        if (!ctrlOOpen || ctrlOLines <= 0) return;
        let out = `\x1b[${ctrlOLines}A\r`;
        for (let i = 0; i < ctrlOLines; i++) {
          out += CSI + '2K';
          if (i < ctrlOLines - 1) out += '\n';
        }
        if (ctrlOLines > 1) out += `\x1b[${ctrlOLines - 1}A\r`;
        process.stdout.write(out);
        ctrlOOpen = false;
        ctrlOLines = 0;
      };

      const insertText = (text: string) => {
        st.text = st.text.slice(0, st.pos) + text + st.text.slice(st.pos);
        st.pos += text.length;
        this._sync(st);
      };
      const commitPaste = (text: string) => {
        const normalized = text.replace(/\r\n?/g, '\n');
        if (!normalized) return;
        if (normalized.length <= pasteInlineLimit && normalized.split('\n').length <= 8) {
          insertText(normalized);
          return;
        }
        const lineCount = normalized.split('\n').length;
        const placeholder = `[Pasted text #${st.pastes.length + 1} · ${lineCount} lines · ${normalized.length} chars]`;
        st.pastes.push({ placeholder, content: normalized });
        insertText(placeholder);
      };

      const onKP = (_str: string | undefined, key: readline.Key) => {
        if (!key) return;
        const nm = key.name;
        const seq = key.sequence ?? _str ?? '';

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
        if (ctrlOOpen && !(key.ctrl && nm === 'o')) {
          clearCtrlO();
          this._draw(st);
        }

        // 退出处理
        if (key.ctrl && nm === 'c') {
          if (st.text) {
            st.text = '';
            st.pos = 0;
            st.dd = 'none';
            st.items = [];
            this._draw(st);
            lastEmptyCtrlC = 0;
            return;
          }
          if (this._onCancel?.()) {
            this._draw(st);
            return;
          }
          const now = Date.now();
          if (now - lastEmptyCtrlC < 1500) { done(); process.stdout.write(CSI + '?25h\n'); process.exit(0); }
          lastEmptyCtrlC = now;
          process.stdout.write('\x07');
          return;
        }
        if (key.ctrl && nm === 'd' && !st.text)  { done(); resolve('/exit'); return; }

        // 回车处理
        if (nm === 'return' || nm === 'enter') {
          if (st.dd !== 'none') {
            const sel = st.items[st.sel];
            if (sel) { this._apply(st, sel); return; }
          }
          if (done_) return;
          clearRendered();
          done();
          const r = this._resolvePastes(st).trim();
          if (r) { this.hist.push(r); this.hi = this.hist.length; }
          resolve(r);
          return;
        }

        // Tab 补全
        if (nm === 'tab') {
          if (st.dd !== 'none') { const it = st.items[st.sel]; if (it) this._apply(st, it); }
          return;
        }

        // Escape 取消
        if (nm === 'escape') {
          if (st.dd !== 'none') { st.dd = 'none'; st.items = []; st.fStart = -1; st.fEnd = -1; this._draw(st); }
          return;
        }

        // 方向键处理
        if (nm === 'up') {
          if (st.dd !== 'none') { st.sel = Math.max(0, st.sel - 1); this._draw(st); }
          else this._hUp(st);
          return;
        }
        if (nm === 'down') {
          if (st.dd !== 'none') { st.sel = Math.min(st.items.length - 1, st.sel + 1); this._draw(st); }
          else this._hDn(st);
          return;
        }
        if (nm === 'left')  { st.pos = this._prevCharIndex(st.text, st.pos); this._draw(st); return; }
        if (nm === 'right') { st.pos = this._nextCharIndex(st.text, st.pos); this._draw(st); return; }

        // 退格键 / 删除键
        if (nm === 'backspace') {
          if (st.pos > 0) {
            const prev = this._prevCharIndex(st.text, st.pos);
            st.text = st.text.slice(0, prev) + st.text.slice(st.pos);
            st.pos = prev;
            this._sync(st);
          }
          return;
        }
        if (nm === 'delete') {
          if (st.pos < st.text.length) {
            const next = this._nextCharIndex(st.text, st.pos);
            st.text = st.text.slice(0, st.pos) + st.text.slice(next);
            this._sync(st);
          }
          return;
        }

        // Ctrl 组合键
        if (key.ctrl && nm === 'o') {
          if (this._onCtrlO) {
            if (ctrlOOpen) {
              clearCtrlO();
              this._draw(st);
              return;
            }
            const content = this._onCtrlO();
            if (content) {
              clearRendered();
              const text = content.endsWith('\n') ? content : content + '\n';
              process.stdout.write(text);
              ctrlOLines = text.split('\n').length - 1;
              ctrlOOpen = true;
            }
          }
          return;
        }
        if (key.ctrl && nm === 'w') { this._cW(st); return; }
        if (key.ctrl && nm === 'a') { st.pos = 0; this._draw(st); return; }
        if (key.ctrl && nm === 'e') { st.pos = st.text.length; this._draw(st); return; }
        if (key.ctrl && nm === 'k') { st.text = st.text.slice(0, st.pos); this._sync(st); return; }
        if (key.ctrl && nm === 'u') { st.text = st.text.slice(st.pos); st.pos = 0; this._sync(st); return; }

        // 可打印字符（支持 BMP 外 Unicode，如 emoji）
        if (_str && _str.length >= 1 && (_str.codePointAt(0) ?? 0) >= 32) {
          insertText(_str);
        }
      };

      this._activeKeypress = onKP;
      process.stdin.resume();
      process.stdin.on('keypress', onKP);

      let done_ = false;
      const done = () => {
        if (done_) return;
        done_ = true;
        if (resizeDebounce) clearTimeout(resizeDebounce);
        process.stdin.removeListener('keypress', onKP);
        process.stdout.removeListener('resize', onResize);
        this._activeKeypress = undefined;
        this._activeResize = undefined;
        this._activeRender = undefined;
        this._activeClear = undefined;
        this._activeRaw = false;
        this._suspendDepth = 0;
        clearCtrlO();
        this._externalWrite = undefined;
        if (raw) try { process.stdin.setRawMode(false); } catch { /* */ }
        process.stdout.write(CSI + '?2004l' + CSI + '?25h');
      };
    });
  }

  // history 历史导航

  private _hUp(st: St): void {
    if (!this.hist.length) return;
    if (this.hi > 0) this.hi--;
    st.text = this.hist[this.hi] ?? '';
    st.pos = st.text.length;
    this._sync(st);
  }

  private _hDn(st: St): void {
    if (this.hi < this.hist.length - 1) { this.hi++; st.text = this.hist[this.hi] ?? ''; }
    else { this.hi = this.hist.length; st.text = ''; }
    st.pos = st.text.length;
    this._sync(st);
  }

  private _cW(st: St): void {
    const b = st.text.slice(0, st.pos);
    const a = st.text.slice(st.pos);
    const i = b.lastIndexOf(' ');
    st.text = (i >= 0 ? b.slice(0, i) : '') + a;
    st.pos = Math.max(0, i);
    this._sync(st);
  }

  // dropdown apply 下拉应用

  private _apply(st: St, it: DropdownItem): void {
    const end = st.fEnd >= 0 ? st.fEnd : st.text.length;
    st.text = st.text.slice(0, st.fStart) + it.data + st.text.slice(end);
    st.pos = st.fStart + it.data.length;
    st.dd = 'none'; st.items = []; st.fStart = -1; st.fEnd = -1; st.sel = 0;
    this._draw(st);
  }

  // dropdown builder 下拉构建

  private _sync(st: St): void {
    st.dd = 'none'; st.items = []; st.fStart = -1; st.fEnd = -1;

    if (st.text.startsWith('/')) {
      const firstSpace = st.text.indexOf(' ');
      const commandEnd = firstSpace >= 0 ? firstSpace : st.text.length;
      if (st.pos <= commandEnd) {
        const p = st.text.slice(1, commandEnd).toLowerCase();
        const m = this.cmds
          .filter(c => c.name.toLowerCase().includes(p))
          .map(c => ({ label: c.name, detail: c.desc, data: c.name + ' ' }));
        if (m.length) { st.dd = 'command'; st.items = m; st.fStart = 0; st.fEnd = commandEnd; st.sel = 0; }
        this._draw(st);
        return;
      }
    }

    const at = st.text.lastIndexOf('@', st.pos - 1);
    if (at < 0 || st.text[at + 1] === ' ') { this._draw(st); return; }

    const endOfWord = st.text.indexOf(' ', at + 1);
    if (endOfWord >= 0 && endOfWord < st.pos) { this._draw(st); return; }
    const wordEnd = st.pos;
    const partial = st.text.slice(at + 1, wordEnd).toLowerCase();

    const m = this.fileIndex.search(partial, 50);

    if (!m.length) { this._draw(st); return; }

    st.dd = 'file';
    st.items = m.map(f => ({ label: f, detail: this._sz(f), data: '@' + f + ' ' }));
    st.fStart = at;
    st.fEnd = wordEnd;
    st.sel = 0;
    this._draw(st);
  }

  // draw — 单次写入，一次 clearBelow，无逐行 clearLine

  private _draw(st: St): void {
    const badge = modeBadge(this.mode);
    const barColor = st.dd !== 'none' ? modeAccent(this.mode) : t.subtle;
    const bar = barColor('│');
    const pr = modeAccent(this.mode)(this.prompt);

    const before = st.text.slice(0, st.pos);
    const ch = st.text[st.pos] || ' ';
    const after = st.text.slice(st.pos + 1);

    // ── 构建行内容 ──
    const lines: string[] = [];
    const boxW = Math.max(40, process.stdout.columns ?? 80);
    const innerW = boxW - 2;
    const stats = this._tokenStats?.();
    let statsLabel = '';
    let statsText = '';
    if (stats) {
      const pct = Math.round((stats.used / stats.limit) * 100);
      const color = pct > 85 ? t.error : pct > 60 ? t.warning : t.faint;
      statsLabel = `[${Math.round(stats.used/1000)}K/${Math.round(stats.limit/1000)}K ${pct}%]`;
      statsText = color(` ${statsLabel} `);
    }
    for (const block of this._pendingBlocks) {
      const blockLines = userMessageBlock(block.text, block.label, block.variant).trimEnd().split('\n');
      if (blockLines[0] === '') blockLines.shift();
      lines.push(...blockLines);
    }

    const topFill = Math.max(1, innerW - (statsLabel ? displayWidth(` ${statsLabel} `) : 0));
    lines.push(t.subtle('╭' + '─'.repeat(topFill)) + statsText + t.subtle('╮'));

    const inputPrefix = `${badge} ${bar} ${pr} `;
    const inputPlainWidth = prefixVis(this.mode);
    const contentW = Math.max(1, innerW - 2 - inputPlainWidth);
    const inputText = before + ch + after;
    const wrapped = this._wrapInput(inputText, contentW);
    const caretIndex = before.length;
    const caretLoc = this._locateCursor(inputText, caretIndex, contentW);
    const inputRows: string[] = wrapped.length ? wrapped : [''];
    inputRows.forEach((row: string, i: number) => {
      const hasCaret = i === caretLoc.line;
      const caretCol = hasCaret ? caretLoc.col : -1;
      const rawLine = hasCaret ? this._renderCaret(row, caretCol) : row;
      const pad = ' '.repeat(Math.max(0, contentW - displayWidth(row)));
      const prefix = i === 0 ? inputPrefix : ' '.repeat(inputPlainWidth);
      lines.push(`${t.subtle('│')} ${prefix}${rawLine}${pad} ${t.subtle('│')}`);
    });
    lines.push(t.subtle('╰' + '─'.repeat(innerW) + '╯'));

    if (st.dd !== 'none' && st.items.length) {
      const ddPrefix = `${bar} `;
      if (st.dd === 'command') {
        for (const l of renderCommandMenu(
          st.items.map((it, i) => ({ cmd: it.label, desc: it.detail ?? '', highlighted: i === st.sel })),
          this.labels.commandsHeader,
        )) lines.push(ddPrefix + l);
      } else {
        for (const l of renderFileDropdown(
          st.items.map((it, i) => ({ label: it.label, detail: it.detail, highlighted: i === st.sel })),
          { header: this.labels.filesHeader, more: this.labels.more },
        )) lines.push(ddPrefix + l);
      }
      lines.push(ddPrefix + t.subtle(hintText({
        tab: this.labels.hintTab,
        navigate: this.labels.hintNavigate,
        confirm: this.labels.hintConfirm,
        dismiss: this.labels.hintDismiss,
        sep: this.labels.hintSep,
      })));
    }

    const totalLines = lines.length;
    const prevLines = this._prevLines;

    // ── 构建单条 ANSI 字符串 ──
    // 使用逐行 clearLine（而非 clearBelow）— 更精细，闪烁更少。
    // 输入行: \r + 空格覆盖旧内容，然后 clearLine 修剪多余。
    // 下拉行: \n + clearLine + 内容。
    let out = this._prevCursorLine > 0 ? `${CSI}${this._prevCursorLine}A` : '';
    out += '\r' + lines[0] + CSI + 'K';  // 写入后清除到行尾
    for (let i = 1; i < totalLines; i++) {
      out += '\n' + CSI + 'K' + lines[i];
    }
    // 清除前次更高渲染遗留的多余行
    if (prevLines > totalLines) {
      for (let i = totalLines; i < prevLines; i++) {
        out += '\n' + CSI + 'K';
      }
    }

    // 光标回到输入框内容行，再移到目标列
    const lastTouched = Math.max(totalLines, prevLines);
    const inputLineIndex = 1 + caretLoc.line;
    const linesBelowInput = Math.max(0, lastTouched - 1 - inputLineIndex);
    if (linesBelowInput > 0) out += `${CSI}${linesBelowInput}A`;
    out += '\r';
    const targetCol = 2 + (caretLoc.line === 0 ? prefixVis(this.mode) : inputPlainWidth) + displayWidth(inputRows[caretLoc.line]?.slice(0, caretLoc.col) ?? '');
    if (targetCol > 0) out += `${CSI}${targetCol}C`;

    process.stdout.write(out);
    this._prevLines = totalLines;
    this._prevCursorLine = inputLineIndex;
  }

  private _prevCharIndex(text: string, pos: number): number {
    if (pos <= 0) return 0;
    let index = 0;
    for (const ch of text) {
      const next = index + ch.length;
      if (next >= pos) return index;
      index = next;
    }
    return index;
  }

  private _nextCharIndex(text: string, pos: number): number {
    if (pos >= text.length) return text.length;
    for (const ch of text.slice(pos)) return pos + ch.length;
    return text.length;
  }

  private _renderCaret(row: string, col: number): string {
    const chars = [...row];
    const caretChar = chars[col] ?? ' ';
    return chars.slice(0, col).join('') + s.inverse(caretChar) + chars.slice(col + 1).join('');
  }

  private _resolvePastes(st: St): string {
    let text = st.text;
    for (const paste of st.pastes) {
      text = text.split(paste.placeholder).join(paste.content);
    }
    return text;
  }

  private _wrapInput(text: string, width: number): string[] {
    const rows: string[] = [];
    let row = '';
    let rowW = 0;
    for (const ch of text) {
      if (ch === '\n') {
        rows.push(row);
        row = '';
        rowW = 0;
        continue;
      }
      const w = displayWidth(ch);
      if (rowW > 0 && rowW + w > width) {
        rows.push(row);
        row = '';
        rowW = 0;
      }
      row += ch;
      rowW += w;
    }
    rows.push(row);
    return rows;
  }

  private _locateCursor(text: string, index: number, width: number): { line: number; col: number } {
    let line = 0;
    let col = 0;
    let rowW = 0;
    let offset = 0;
    for (const ch of text) {
      if (offset >= index) break;
      if (ch === '\n') {
        line++;
        col = 0;
        rowW = 0;
        offset += ch.length;
        continue;
      }
      const w = displayWidth(ch);
      if (rowW > 0 && rowW + w > width) {
        line++;
        col = 0;
        rowW = 0;
      }
      col++;
      rowW += w;
      offset += ch.length;
    }
    return { line, col };
  }

  // file size cache 文件大小缓存

  private _sz(rel: string): string {
    const c = this.sz.get(rel);
    if (c !== undefined) return c;
    try {
      const st = fs.statSync(this.root + '/' + rel);
      const v = st.size < 1024 ? `${st.size} B`
        : st.size < 1048576 ? `${(st.size / 1024).toFixed(1)} KB`
        : `${(st.size / 1048576).toFixed(1)} MB`;
      this.sz.set(rel, v);
      return v;
    } catch { this.sz.set(rel, ''); return ''; }
  }
}
