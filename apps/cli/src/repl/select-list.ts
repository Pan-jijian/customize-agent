import * as readline from 'readline';
import stringWidth from 'string-width';
import { t, s } from '../tui/renderer.js';
import { supportsAnsi } from '../tui/terminal-capabilities.js';

let keypressInitialized = false;

/**
 * 从列表中选择一项的交互式面板。
 * 支持 ANSI 终端用方向键选择、回车确认；非 ANSI 回退到标准输入数字选择。
 */
export async function selectList<T>(title: string, items: Array<{ label: string; detail?: string; value: T }>): Promise<T | null> {
  if (!items.length) return null;
  if (!supportsAnsi()) {
    process.stdout.write(`${title}\n`);
    items.slice(0, 12).forEach((item, index) => process.stdout.write(`${index + 1}. ${item.label}${item.detail ? ` - ${item.detail}` : ''}\n`));
    return new Promise<T | null>(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('> ', answer => {
        rl.close();
        const index = Number(answer.trim()) - 1;
        resolve(items[index]?.value ?? null);
      });
    });
  }
  if (!keypressInitialized) {
    readline.emitKeypressEvents(process.stdin);
    keypressInitialized = true;
  }
  let raw = false;
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(true); raw = true; } catch { /* 忽略 */ }
  }
  process.stdin.resume();
  let sel = 0;
  let linesOnScreen = 0;
  const clear = () => {
    if (linesOnScreen > 0) process.stdout.write(`\x1b[${linesOnScreen}A\r\x1b[0J`);
    linesOnScreen = 0;
  };
  const clip = (value: string, width: number) => {
    if (stringWidth(value) <= width) return value;
    let out = '';
    for (const ch of value) {
      if (stringWidth(out + ch) > width - 1) return out + '…';
      out += ch;
    }
    return out;
  };
  const draw = () => {
    clear();
    const width = Math.max(50, process.stdout.columns ?? 80);
    const visible = items.slice(0, 12);
    const lines = [s.bold(clip(title, width - 1)), ''];
    for (const [index, item] of visible.entries()) {
      const cursor = index === sel ? t.accent('▶') : ' ';
      const label = clip(item.label, 40);
      const detail = item.detail ? t.dim('  ' + clip(item.detail, Math.max(10, width - 48))) : '';
      lines.push(`${cursor} ${index === sel ? s.bold(label) : label}${detail}`);
    }
    lines.push('', t.dim('↑↓  Enter  Esc'));
    process.stdout.write(lines.join('\n') + '\n');
    linesOnScreen = lines.length;
  };
  draw();
  return new Promise<T | null>(resolve => {
    const finish = (value: T | null) => {
      clear();
      process.stdin.removeListener('keypress', onKey);
      if (raw) try { process.stdin.setRawMode(false); } catch { /* 忽略 */ }
      resolve(value);
    };
    const onKey = (_str: string | undefined, key: readline.Key) => {
      if (key?.ctrl && key.name === 'c') finish(null);
      else if (key?.name === 'up') { sel = Math.max(0, sel - 1); draw(); }
      else if (key?.name === 'down') { sel = Math.min(Math.min(items.length, 12) - 1, sel + 1); draw(); }
      else if (key?.name === 'return' || key?.name === 'enter') finish(items[sel]?.value ?? null);
      else if (key?.name === 'escape') finish(null);
    };
    process.stdin.on('keypress', onKey);
  });
}
