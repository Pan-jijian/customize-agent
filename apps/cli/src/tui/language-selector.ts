import * as readline from 'readline';
import { supportsAnsi } from './terminal-capabilities.js';

const CSI = '\x1b[';

function color(s: string, code: number): string { return supportsAnsi() ? `${CSI}38;5;${code}m${s}${CSI}39m` : s; }
function bold(s: string): string { return supportsAnsi() ? `${CSI}1m${s}${CSI}22m` : s; }
const accent = (s: string) => color(s, 117);
const text = (s: string) => color(s, 146);
const dim = (s: string) => color(s, 103);
const selected = (s: string) => supportsAnsi() ? `${CSI}7m${s}${CSI}27m` : s;

export type Language = 'zh' | 'en';

interface LanguageOption {
  value: Language;
  label: string;
}

/** 语言选择器的显示文案 */
export interface SelectorTexts {
  title: string;
  prompt: string;
  zhLabel: string;
  enLabel: string;
}

/**
 * 语言选择面板。
 * 接受 SelectorTexts 参数（由调用方通过 I18nManager 提供），
 * 面板自身不包含任何硬编码文案。
 */
export function selectLanguage(texts: SelectorTexts): Promise<Language> {
  const OPTIONS: LanguageOption[] = [
    { value: 'zh', label: texts.zhLabel },
    { value: 'en', label: texts.enLabel },
  ];

  if (!supportsAnsi()) {
    return new Promise(resolve => {
      process.stdout.write(`${texts.title}\n1. ${texts.zhLabel}\n2. ${texts.enLabel}\n> `);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('', answer => {
        rl.close();
        resolve(answer.trim() === '2' ? 'en' : 'zh');
      });
    });
  }

  return new Promise(resolve => {
    let sel = 0;

    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch { /* */ }
    }
    try { readline.emitKeypressEvents(process.stdin); } catch { /* already initialized */ }
    process.stdout.write(CSI + '?25l\n');

    let firstDraw = true;
    let drawCount = 0;
    const drawAndReset = () => {
      const lines: string[] = [];
      const pad = '  ';
      const w = 40;
      lines.push('');
      lines.push(pad + accent(bold('◆')) + ' ' + text(bold('Customize Agent')) + ' ' + dim('v0.0.3'));
      lines.push('');
      lines.push(pad + bold(texts.title));
      lines.push(pad + '┌' + '─'.repeat(w - 2) + '┐');
      for (let i = 0; i < OPTIONS.length; i++) {
        const opt = OPTIONS[i]!;
        const prefix = i === sel ? accent(' ▶ ') : '   ';
        const line = prefix + opt.label;
        const padded = (line + ' '.repeat(w - 4 - visibleLen(opt.label))).slice(0, w - 4);
        lines.push(pad + '│' + (i === sel ? selected(padded) : dim(padded)) + '│');
      }
      lines.push(pad + '└' + '─'.repeat(w - 2) + '┘');
      lines.push('');
      lines.push(pad + dim(texts.prompt));

      drawCount = lines.length + 1;
      if (!firstDraw) {
        process.stdout.write(CSI + drawCount + 'A');
      }
      firstDraw = false;
      process.stdout.write(lines.join('\n') + '\n');
    };

    const onKP = (_str: string | undefined, key: readline.Key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        cleanup(); resolve('zh');
        return;
      }
      if (key.name === 'up') {
        sel = Math.max(0, sel - 1);
        drawAndReset();
        return;
      }
      if (key.name === 'down') {
        sel = Math.min(OPTIONS.length - 1, sel + 1);
        drawAndReset();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(OPTIONS[sel]!.value);
        return;
      }
    };

    let _cleaned = false;
    process.stdin.on('keypress', onKP);
    const cleanup = () => {
      if (_cleaned) return;
      _cleaned = true;
      process.stdin.removeListener('keypress', onKP);
      try { process.stdin.setRawMode(false); } catch { /* */ }
      process.stdout.write(CSI + '?25h');
      // 清除选择器区域，保留背后的 banner
      if (drawCount > 0) {
        process.stdout.write(CSI + drawCount + 'A' + CSI + '0J');
      }
    };

    drawAndReset();
  });
}

function visibleLen(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // 2-column ranges: CJK + Fullwidth + arrows + misc symbols
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
