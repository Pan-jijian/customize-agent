/**
 * TUI Input — uses Node.js readline.emitKeypressEvents for robust cross-platform input.
 * No manual escape parsing. Arrow keys, Enter, Tab, etc. handled via key.name.
 */
import * as fs from 'fs';
import * as readline from 'readline';
import { t, s, cur, renderFileDropdown, renderCommandMenu, hintBar } from './renderer.js';

// ── types ──

export interface DropdownItem { label: string; detail?: string; data: string; }
export interface TuiConfig {
  files: string[]; projectRoot: string;
  commands?: Array<{ name: string; desc: string }>;
  prompt?: string; mode?: string; history?: string[];
}

interface St { text: string; pos: number; dd: 'none'|'file'|'command'; items: DropdownItem[]; sel: number; fStart: number; }

const CMDS: Array<{ name: string; desc: string }> = [
  { name: '/plan', desc: '制定执行计划（只读探索）' },
  { name: '/clear', desc: '重置当前会话' },
  { name: '/sessions', desc: '查看历史会话' },
  { name: '/model', desc: '查看当前模型' },
  { name: '/help', desc: '显示帮助' },
  { name: '/exit', desc: '退出' },
];

let _kprInit = false;

// ── TuiInput ──

export class TuiInput {
  private files: string[];
  private root: string;
  private cmds: Array<{ name: string; desc: string }>;
  private prompt: string;
  private mode: string;
  private hist: string[];
  private hi: number;
  private sz = new Map<string, string>();

  constructor(cfg: TuiConfig) {
    this.files = cfg.files; this.root = cfg.projectRoot;
    this.cmds = cfg.commands ?? CMDS;
    this.prompt = cfg.prompt ?? '❯'; this.mode = cfg.mode ?? 'AGENT';
    this.hist = cfg.history ?? []; this.hi = this.hist.length;
  }

  async read(): Promise<string> {
    return new Promise<string>(resolve => {
      if (!_kprInit) { readline.emitKeypressEvents(process.stdin); _kprInit = true; }

      const st: St = { text: '', pos: 0, dd: 'none', items: [], sel: 0, fStart: -1 };
      let raw = false;
      if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); raw = true; } catch { /* */ } }

      process.stdout.write(cur.hide + '\n');
      this._draw(st);

      const onKP = (_str: string | undefined, key: readline.Key) => {
        if (!key) return;
        const nm = key.name;

        // Ctrl+C
        if (key.ctrl && nm === 'c') { done(); process.stdout.write(cur.show + '\n'); process.exit(0); }
        // Ctrl+D on empty
        if (key.ctrl && nm === 'd' && !st.text) { done(); process.stdout.write(cur.show + '\n'); resolve('/exit'); return; }

        // Enter
        if (nm === 'return' || nm === 'enter') { this._ent(st, resolve, done); return; }

        // Tab
        if (nm === 'tab') { this._tab(st); return; }

        // Escape
        if (nm === 'escape') { this._esc(st); return; }

        // Arrows
        if (nm === 'up')    { if (st.dd !== 'none') { st.sel = Math.max(0, st.sel - 1); this._draw(st); } else this._hUp(st); return; }
        if (nm === 'down')  { if (st.dd !== 'none') { st.sel = Math.min(st.items.length - 1, st.sel + 1); this._draw(st); } else this._hDn(st); return; }
        if (nm === 'left')  { st.pos = Math.max(0, st.pos - 1); this._draw(st); return; }
        if (nm === 'right') { st.pos = Math.min(st.text.length, st.pos + 1); this._draw(st); return; }

        // Backspace / Delete
        if (nm === 'backspace') { this._bs(st); return; }
        if (nm === 'delete')    { if (st.pos < st.text.length) { st.text = st.text.slice(0, st.pos) + st.text.slice(st.pos + 1); this._sync(st); } return; }

        // Ctrl+W
        if (key.ctrl && nm === 'w') { this._cW(st); return; }
        // Ctrl+A / Ctrl+E
        if (key.ctrl && nm === 'a') { st.pos = 0; return; }
        if (key.ctrl && nm === 'e') { st.pos = st.text.length; return; }

        // Printable
        if (_str && _str.length === 1 && _str.charCodeAt(0) >= 32) {
          st.text = st.text.slice(0, st.pos) + _str + st.text.slice(st.pos);
          st.pos++; this._sync(st);
        }
      };

      process.stdin.on('keypress', onKP);

      let done_ = false;
      const done = () => {
        if (done_) return; done_ = true;
        process.stdin.removeListener('keypress', onKP);
        if (raw) try { process.stdin.setRawMode(false); } catch { /* */ }
        process.stdout.write(cur.show + '\n');
      };
    });
  }

  // ── handlers ──

  private _ent(st: St, resolve: (v: string) => void, done: () => void): void {
    const sel = st.items[st.sel];
    if (st.dd !== 'none' && sel) { this._apply(st, sel); return; }
    done();
    const r = st.text.trim(); if (r) this.hist.push(r);
    resolve(r);
  }

  private _tab(st: St): void { const it = st.items[st.sel]; if (st.dd !== 'none' && it) this._apply(st, it); }
  private _esc(st: St): void { if (st.dd !== 'none') { st.dd = 'none'; st.items = []; st.fStart = -1; this._draw(st); } }

  private _bs(st: St): void {
    if (st.pos > 0) { st.text = st.text.slice(0, st.pos - 1) + st.text.slice(st.pos); st.pos--; this._sync(st); }
  }

  private _cW(st: St): void {
    const b = st.text.slice(0, st.pos); const a = st.text.slice(st.pos);
    const i = b.lastIndexOf(' '); const k = i >= 0 ? b.slice(0, i) : '';
    st.text = k + a; st.pos = k.length; this._sync(st);
  }

  private _hUp(st: St): void    { if (!this.hist.length) return; if (this.hi > 0) this.hi--; st.text = this.hist[this.hi] ?? ''; st.pos = st.text.length; this._sync(st); }
  private _hDn(st: St): void    { if (this.hi < this.hist.length - 1) { this.hi++; st.text = this.hist[this.hi] ?? ''; } else { this.hi = this.hist.length; st.text = ''; } st.pos = st.text.length; this._sync(st); }

  // ── dropdown ──

  private _apply(st: St, it: DropdownItem): void {
    // 替换 @word 部分，保留后面的文字
    const wordEnd = st.text.indexOf(' ', st.fStart + 1);
    const end = wordEnd >= 0 ? wordEnd : st.text.length;
    st.text = st.text.slice(0, st.fStart) + it.data.trimEnd() + st.text.slice(end);
    st.pos = (st.fStart + it.data.trimEnd().length);
    st.dd = 'none'; st.items = []; st.fStart = -1; st.sel = 0;
    this._draw(st);
  }

  private _sync(st: St): void { this._update(st); }

  private _update(st: St): void {
    st.dd = 'none'; st.items = []; st.fStart = -1;

    if (st.text.startsWith('/')) {
      const p = st.text.slice(1).toLowerCase();
      const m = this.cmds.filter(c => c.name.toLowerCase().includes(p)).map(c => ({ label: c.name, detail: c.desc, data: c.name + ' ' }));
      if (m.length) { st.dd = 'command'; st.items = m; st.fStart = 0; st.sel = 0; }
      this._draw(st); return;
    }

    const at = st.text.lastIndexOf('@', st.pos - 1);
    if (at < 0 || !st.text[at + 1] || st.text[at + 1] === ' ') { this._draw(st); return; }

    // @filter 只取 @ 到下一个空格（或光标位）之间的文字
    const endOfWord = st.text.indexOf(' ', at + 1);
    const wordEnd = endOfWord >= 0 && endOfWord < st.pos ? endOfWord : st.pos;
    const partial = st.text.slice(at + 1, wordEnd).toLowerCase();
    if (!partial) { this._draw(st); return; }
    const m = this.files
      .filter(f => f.toLowerCase().includes(partial))
      .sort((a, b) => { const ap = a.toLowerCase().startsWith(partial); const bp = b.toLowerCase().startsWith(partial); if (ap !== bp) return ap ? -1 : 1; return a.length - b.length; })
      .slice(0, 8);
    if (!m.length) { this._draw(st); return; }

    st.dd = 'file'; st.items = m.map(f => ({ label: f, detail: this._sz(f), data: '@' + f + ' ' })); st.fStart = at; st.sel = 0;
    this._draw(st);
  }

  // ── render ──

  private _draw(st: St): void {
    const out: string[] = [];
    const TW = process.stdout.columns ?? 80;

    const badge = t.badge(` ${this.mode} `) + ' ';
    const pr = t.green(this.prompt);
    const before = st.text.slice(0, st.pos);
    const ch = st.text[st.pos];
    const after = st.text.slice(st.pos + 1);
    const caret = ch ? s.inverse(ch) : s.inverse(' ');
    out.push(badge + pr + ' ' + before + caret + after);

    if (st.dd !== 'none' && st.items.length) {
      if (st.dd === 'command') out.push(...renderCommandMenu(st.items.map((it, i) => ({ cmd: it.label, desc: it.detail ?? '', highlighted: i === st.sel }))));
      else out.push(...renderFileDropdown(st.items.map((it, i) => ({ label: it.label, detail: it.detail, highlighted: i === st.sel }))));
      out.push(hintBar());
    }

    // ── 清除旧渲染 ──
    // 光标在输入行上，\r 回到行首，clearBelow 清除旧内容
    process.stdout.write('\r' + cur.clearBelow);
    process.stdout.write(out.join('\n'));

    // ── 光标归位 ──
    // 上移到输入行（out 的第一行）
    const afterLines = out.length - 1;
    if (afterLines > 0) process.stdout.write(cur.up(afterLines));
    process.stdout.write('\r');

    // 可见前缀: " AGENT " + "❯" + " " + before
    const badgeVis = this.mode.length + 3;  // ' AGENT ' visible chars
    const promptVis = [...this.prompt].length;
    const prefixVis = badgeVis + promptVis + 1; // +1 for space after prompt
    const targetCol = prefixVis + before.length;

    // 如果输入行太长会折行，用 readline.cursorTo 处理
    const rows = process.stdout.rows ?? 24;
    const inputRow = Math.max(0, rows - out.length);
    const col = targetCol % TW;
    const row = inputRow + Math.floor(targetCol / TW);
    readline.cursorTo(process.stdout, col, row);
  }

  private _sz(rel: string): string {
    const c = this.sz.get(rel); if (c !== undefined) return c;
    try { const st = fs.statSync(this.root + '/' + rel); const v = st.size < 1024 ? `${st.size} B` : st.size < 1048576 ? `${(st.size / 1024).toFixed(1)} KB` : `${(st.size / 1048576).toFixed(1)} MB`; this.sz.set(rel, v); return v; }
    catch { this.sz.set(rel, ''); return ''; }
  }
}
