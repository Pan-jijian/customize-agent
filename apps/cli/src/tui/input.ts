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
  renderFileDropdown, renderCommandMenu, hintText,
} from './renderer.js';
import type { Mode } from './renderer.js';

// ── 类型定义 ──
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

// ── 前缀可见宽度（用于光标列计算）──
// "  AGENT  │ ➜ " → 2 + (mode+2) + 各分隔符(空格+│+空格+➜+空格) = mode.length + 9
function prefixVis(mode: string): number { return mode.length + 9; }

// ── 显示宽度（CJK/全角 = 2 列，ASCII = 1 列）──
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK 统一表意文字、兼容区、扩展区、全角形式、谚文等
    w += (cp >= 0x2E80) ? 2 : 1;
  }
  return w;
}

// ── 裸 ANSI 转义序列 ──
const CSI = '\x1b[';

// ── TuiInput 类 ──
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
  // read 读取输入
  // ═══════════════════════════════════════════════════

  async read(): Promise<string> {
    return new Promise<string>(resolve => {
      if (!_kprInit) { readline.emitKeypressEvents(process.stdin); _kprInit = true; }

      const st: St = { text: '', pos: 0, dd: 'none', items: [], sel: 0, fStart: -1, fEnd: -1 };
      let raw = false;
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(true); raw = true; } catch { /* */ }
      }

      // 从空白行开始
      process.stdout.write(CSI + '?25l\n');
      this._prevLines = 0;
      this._draw(st);

      const onKP = (_str: string | undefined, key: readline.Key) => {
        if (!key) return;
        const nm = key.name;

        // 退出处理
        if (key.ctrl && nm === 'c') { done(); process.stdout.write(CSI + '?25h\n'); process.exit(0); }
        if (key.ctrl && nm === 'd' && !st.text)  { done(); resolve('/exit'); return; }

        // 回车处理
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
        if (nm === 'left')  { st.pos = Math.max(0, st.pos - 1); this._draw(st); return; }
        if (nm === 'right') { st.pos = Math.min(st.text.length, st.pos + 1); this._draw(st); return; }

        // 退格键 / 删除键
        if (nm === 'backspace') {
          if (st.pos > 0) { st.text = st.text.slice(0, st.pos - 1) + st.text.slice(st.pos); st.pos--; this._sync(st); }
          return;
        }
        if (nm === 'delete') {
          if (st.pos < st.text.length) { st.text = st.text.slice(0, st.pos) + st.text.slice(st.pos + 1); this._sync(st); }
          return;
        }

        // Ctrl 组合键
        if (key.ctrl && nm === 'w') { this._cW(st); return; }
        if (key.ctrl && nm === 'a') { st.pos = 0; this._draw(st); return; }
        if (key.ctrl && nm === 'e') { st.pos = st.text.length; this._draw(st); return; }
        if (key.ctrl && nm === 'k') { st.text = st.text.slice(0, st.pos); this._sync(st); return; }
        if (key.ctrl && nm === 'u') { st.text = st.text.slice(st.pos); st.pos = 0; this._sync(st); return; }

        // 可打印字符
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
  // history 历史导航
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
  // dropdown apply 下拉应用
  // ═══════════════════════════════════════════════════

  private _apply(st: St, it: DropdownItem): void {
    const end = st.fEnd >= 0 ? st.fEnd : st.text.length;
    st.text = st.text.slice(0, st.fStart) + it.data + st.text.slice(end);
    st.pos = st.fStart + it.data.length;
    st.dd = 'none'; st.items = []; st.fStart = -1; st.fEnd = -1; st.sel = 0;
    this._draw(st);
  }

  // ═══════════════════════════════════════════════════
  // dropdown builder 下拉构建
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
  // draw — 单次写入，一次 clearBelow，无逐行 clearLine
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

    // ── 构建行内容 ──
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

    // ── 构建单条 ANSI 字符串 ──
    // 使用逐行 clearLine（而非 clearBelow）— 更精细，闪烁更少。
    // 输入行: \r + 空格覆盖旧内容，然后 clearLine 修剪多余。
    // 下拉行: \n + clearLine + 内容。
    let out = '\r' + lines[0] + CSI + 'K';  // 写入后清除到行尾
    for (let i = 1; i < totalLines; i++) {
      out += '\n' + CSI + 'K' + lines[i];
    }
    // 清除前次更高渲染遗留的多余行
    if (prevLines > totalLines) {
      for (let i = totalLines; i < prevLines; i++) {
        out += '\n' + CSI + 'K';
      }
    }

    // 光标回到输入行，再移到目标列
    const lastTouched = Math.max(totalLines, prevLines);
    if (lastTouched > 1) out += `${CSI}${lastTouched - 1}A`;
    out += '\r';
    const targetCol = prefixVis(this.mode) + displayWidth(before);
    if (targetCol > 0) out += `${CSI}${targetCol}C`;

    process.stdout.write(out);
    this._prevLines = totalLines;
  }

  // ═══════════════════════════════════════════════════
  // file size cache 文件大小缓存
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
