/**
 * TUI Input — raw-mode keyboard input with fuzzy file/command completion.
 *
 * Draw strategy:
 *   1. \r to column 0 of the input line (always reachable — previous draw left us here)
 *   2. \x1b[0J (clearBelow) to wipe the previous render in one shot
 *   3. Write input line + optional dropdown
 *   4. \x1b[{n}A back to input line, \r, \x1b[{col}C to caret
 *   5. Single process.stdout.write() — zero flicker
 */
import * as fs from 'fs';
import * as readline from 'readline';
import {
  t, s, modeBadge, modeAccent,
  renderFileDropdown, renderCommandMenu, hintText,
} from './renderer.js';
import type { Mode } from './renderer.js';

// ── types ──
export interface DropdownItem { label: string; detail?: string; data: string; }
export interface TuiConfig {
  files: string[]; projectRoot: string;
  commands?: Array<{ name: string; desc: string }>;
  prompt?: string; mode?: Mode; history?: string[];
}

interface St {
  text: string; pos: number;
  dd: 'none' | 'file' | 'command';
  items: DropdownItem[]; sel: number;
  fStart: number; fEnd: number;
}

const CMDS: Array<{ name: string; desc: string }> = [
  { name: '/plan',     desc: '制定执行计划（只读探索）' },
  { name: '/clear',    desc: '重置当前会话' },
  { name: '/sessions', desc: '查看历史会话' },
  { name: '/model',    desc: '查看当前模型' },
  { name: '/help',     desc: '显示帮助' },
  { name: '/exit',     desc: '退出' },
];

let _kprInit = false;

// ── prefix visible width (for cursor column) ──
// "  AGENT  │ ➜ " → 2 + (mode+2) + 1 + 1 + 1 + 1 + 1 = mode.length + 9
function prefixVis(mode: string): number { return mode.length + 9; }

// ── display width (CJK/fullwidth = 2 columns, ASCII = 1) ──
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK Unified, Compatibility, Extensions, fullwidth forms, Hangul, etc.
    w += (cp >= 0x2E80) ? 2 : 1;
  }
  return w;
}

// ── bare ANSI escapes ──
const CSI = '\x1b[';

// ── TuiInput ──
export class TuiInput {
  private files: string[];
  private root: string;
  private cmds: Array<{ name: string; desc: string }>;
  private prompt: string;
  private mode: Mode;
  private hist: string[];
  private hi: number;
  private sz = new Map<string, string>();
  private _prevLines = 0;

  constructor(cfg: TuiConfig) {
    this.files = cfg.files;
    this.root = cfg.projectRoot;
    this.cmds = cfg.commands ?? CMDS;
    this.prompt = cfg.prompt ?? '➜';
    this.mode = cfg.mode ?? 'AGENT';
    this.hist = cfg.history ?? [];
    this.hi = this.hist.length;
  }

  // ═══════════════════════════════════════════════════
  // read
  // ═══════════════════════════════════════════════════

  async read(): Promise<string> {
    return new Promise<string>(resolve => {
      if (!_kprInit) { readline.emitKeypressEvents(process.stdin); _kprInit = true; }

      const st: St = { text: '', pos: 0, dd: 'none', items: [], sel: 0, fStart: -1, fEnd: -1 };
      let raw = false;
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(true); raw = true; } catch { /* */ }
      }

      // Start on a clean line
      process.stdout.write(CSI + '?25l\n');
      this._prevLines = 0;
      this._draw(st);

      const onKP = (_str: string | undefined, key: readline.Key) => {
        if (!key) return;
        const nm = key.name;

        // exit
        if (key.ctrl && nm === 'c') { done(); process.stdout.write(CSI + '?25h\n'); process.exit(0); }
        if (key.ctrl && nm === 'd' && !st.text)  { done(); resolve('/exit'); return; }

        // Enter
        if (nm === 'return' || nm === 'enter') {
          if (st.dd !== 'none') {
            const sel = st.items[st.sel];
            if (sel) { this._apply(st, sel); return; }
          }
          if (done_) return;
          done();
          const r = st.text.trim();
          if (r) { this.hist.push(r); this.hi = this.hist.length; }
          resolve(r);
          return;
        }

        // Tab
        if (nm === 'tab') {
          if (st.dd !== 'none') { const it = st.items[st.sel]; if (it) this._apply(st, it); }
          return;
        }

        // Escape
        if (nm === 'escape') {
          if (st.dd !== 'none') { st.dd = 'none'; st.items = []; st.fStart = -1; st.fEnd = -1; this._draw(st); }
          return;
        }

        // arrows
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
        if (nm === 'left')  { st.pos = Math.max(0, st.pos - 1); this._draw(st); return; }
        if (nm === 'right') { st.pos = Math.min(st.text.length, st.pos + 1); this._draw(st); return; }

        // backspace / delete
        if (nm === 'backspace') {
          if (st.pos > 0) { st.text = st.text.slice(0, st.pos - 1) + st.text.slice(st.pos); st.pos--; this._sync(st); }
          return;
        }
        if (nm === 'delete') {
          if (st.pos < st.text.length) { st.text = st.text.slice(0, st.pos) + st.text.slice(st.pos + 1); this._sync(st); }
          return;
        }

        // ctrl combos
        if (key.ctrl && nm === 'w') { this._cW(st); return; }
        if (key.ctrl && nm === 'a') { st.pos = 0; this._draw(st); return; }
        if (key.ctrl && nm === 'e') { st.pos = st.text.length; this._draw(st); return; }
        if (key.ctrl && nm === 'k') { st.text = st.text.slice(0, st.pos); this._sync(st); return; }
        if (key.ctrl && nm === 'u') { st.text = st.text.slice(st.pos); st.pos = 0; this._sync(st); return; }

        // printable
        if (_str && _str.length === 1 && _str.charCodeAt(0) >= 32) {
          st.text = st.text.slice(0, st.pos) + _str + st.text.slice(st.pos);
          st.pos++;
          this._sync(st);
        }
      };

      process.stdin.on('keypress', onKP);

      let done_ = false;
      const done = () => {
        if (done_) return;
        done_ = true;
        process.stdin.removeListener('keypress', onKP);
        if (raw) try { process.stdin.setRawMode(false); } catch { /* */ }
        process.stdout.write(CSI + '?25h');
      };
    });
  }

  // ═══════════════════════════════════════════════════
  // history
  // ═══════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════
  // dropdown apply
  // ═══════════════════════════════════════════════════

  private _apply(st: St, it: DropdownItem): void {
    const end = st.fEnd >= 0 ? st.fEnd : st.text.length;
    st.text = st.text.slice(0, st.fStart) + it.data + st.text.slice(end);
    st.pos = st.fStart + it.data.length;
    st.dd = 'none'; st.items = []; st.fStart = -1; st.fEnd = -1; st.sel = 0;
    this._draw(st);
  }

  // ═══════════════════════════════════════════════════
  // dropdown builder
  // ═══════════════════════════════════════════════════

  private _sync(st: St): void {
    st.dd = 'none'; st.items = []; st.fStart = -1; st.fEnd = -1;

    if (st.text.startsWith('/')) {
      const p = st.text.slice(1).toLowerCase();
      const m = this.cmds
        .filter(c => c.name.toLowerCase().includes(p))
        .map(c => ({ label: c.name, detail: c.desc, data: c.name + ' ' }));
      if (m.length) { st.dd = 'command'; st.items = m; st.fStart = 0; st.fEnd = st.text.length; st.sel = 0; }
      this._draw(st);
      return;
    }

    const at = st.text.lastIndexOf('@', st.pos - 1);
    if (at < 0 || !st.text[at + 1] || st.text[at + 1] === ' ') { this._draw(st); return; }

    const endOfWord = st.text.indexOf(' ', at + 1);
    const wordEnd = (endOfWord >= 0 && endOfWord < st.pos) ? endOfWord : st.pos;
    if (st.pos > wordEnd + 1) { this._draw(st); return; }
    const partial = st.text.slice(at + 1, wordEnd).toLowerCase();
    if (!partial) { this._draw(st); return; }

    const m = this.files
      .filter(f => f.toLowerCase().includes(partial))
      .sort((a, b) => {
        const ap = a.toLowerCase().startsWith(partial);
        if (ap !== (b.toLowerCase().startsWith(partial))) return ap ? -1 : 1;
        return a.length - b.length;
      })
      .slice(0, 8);

    if (!m.length) { this._draw(st); return; }

    st.dd = 'file';
    st.items = m.map(f => ({ label: f, detail: this._sz(f), data: '@' + f + ' ' }));
    st.fStart = at;
    st.fEnd = wordEnd;
    st.sel = 0;
    this._draw(st);
  }

  // ═══════════════════════════════════════════════════
  // draw — single write, clearBelow once, no per-line clearLine
  // ═══════════════════════════════════════════════════

  private _draw(st: St): void {
    const pad = '  ';
    const badge = modeBadge(this.mode);
    const barColor = st.dd !== 'none' ? modeAccent(this.mode) : t.subtle;
    const bar = barColor('│');
    const pr = modeAccent(this.mode)(this.prompt);

    const before = st.text.slice(0, st.pos);
    const ch = st.text[st.pos] || ' ';
    const after = st.text.slice(st.pos + 1);
    const caret = s.inverse(ch);

    // ── build lines ──
    const lines: string[] = [];
    lines.push(`${pad}${badge} ${bar} ${pr} ${before}${caret}${after}`);

    if (st.dd !== 'none' && st.items.length) {
      lines.push(`${pad}${bar}`);
      const ddPrefix = `${pad}${bar} `;
      if (st.dd === 'command') {
        for (const l of renderCommandMenu(
          st.items.map((it, i) => ({ cmd: it.label, desc: it.detail ?? '', highlighted: i === st.sel })),
        )) lines.push(ddPrefix + l);
      } else {
        for (const l of renderFileDropdown(
          st.items.map((it, i) => ({ label: it.label, detail: it.detail, highlighted: i === st.sel })),
        )) lines.push(ddPrefix + l);
      }
      lines.push(ddPrefix + t.subtle(hintText()));
    }

    const totalLines = lines.length;
    const prevLines = this._prevLines;

    // ── build single ANSI string ──
    // Use clearLine per line (not clearBelow) — more surgical, less flash.
    // Input line: \r + spaces to cover old content, then clearLine to trim extras.
    // Dropdown lines: \n + clearLine + content.
    let out = '\r' + lines[0] + CSI + 'K';  // write then clear to end of line
    for (let i = 1; i < totalLines; i++) {
      out += '\n' + CSI + 'K' + lines[i];
    }
    // clear leftover lines from taller previous render
    if (prevLines > totalLines) {
      for (let i = totalLines; i < prevLines; i++) {
        out += '\n' + CSI + 'K';
      }
    }

    // cursor back to input line, then to target column
    const lastTouched = Math.max(totalLines, prevLines);
    if (lastTouched > 1) out += `${CSI}${lastTouched - 1}A`;
    out += '\r';
    const targetCol = prefixVis(this.mode) + displayWidth(before);
    if (targetCol > 0) out += `${CSI}${targetCol}C`;

    process.stdout.write(out);
    this._prevLines = totalLines;
  }

  // ═══════════════════════════════════════════════════
  // file size cache
  // ═══════════════════════════════════════════════════

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
