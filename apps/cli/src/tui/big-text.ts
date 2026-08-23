/**
 * 4×6 像素标题字 — 可自定义渐变色。
 *
 * 用法:
 *   bannerText('HELLO')           → 返回带 ANSI 渐变色的 6 行字符串数组
 *   printBanner('HELLO')          → 直接写入 stdout
 *   printBanner('HELLO', grad)    → 自定义渐变
 */

import { normalizeTerminalText, supportsAnsi } from './terminal-capabilities.js';

/** 4 列 × 6 行像素字形，仅用 █ 和空格 */
const BANNER: Record<string, readonly string[]> = {
  A: [' ██ ','█  █','█  █','████','█  █','█  █'],
  B: ['███ ','█  █','███ ','█  █','█  █','███ '],
  C: [' ███','█   ','█   ','█   ','█   ',' ███'],
  D: ['███ ','█  █','█  █','█  █','█  █','███ '],
  E: ['████','█   ','███ ','█   ','█   ','████'],
  F: ['████','█   ','███ ','█   ','█   ','█   '],
  G: [' ███','█   ','█ ██','█  █','█  █',' ███'],
  H: ['█  █','█  █','████','█  █','█  █','█  █'],
  I: [' ██ ',' █  ',' █  ',' █  ',' █  ',' ██ '],
  J: ['  ██','   █','   █','█  █','█  █',' ██ '],
  K: ['█  █','█ █ ','██  ','█ █ ','█ █ ','█  █'],
  L: ['█   ','█   ','█   ','█   ','█   ','████'],
  M: ['█  █','████','█ ██','█  █','█  █','█  █'],
  N: ['█  █','██ █','█ ██','█  █','█  █','█  █'],
  O: [' ██ ','█  █','█  █','█  █','█  █',' ██ '],
  P: ['███ ','█  █','███ ','█   ','█   ','█   '],
  Q: [' ██ ','█  █','█  █','█ ██',' ██ ','   █'],
  R: ['███ ','█  █','███ ','█ █ ','█  █','█  █'],
  S: [' ███','█   ',' ██ ','   █','   █','███ '],
  T: ['████',' █  ',' █  ',' █  ',' █  ',' █  '],
  U: ['█  █','█  █','█  █','█  █','█  █',' ██ '],
  V: ['█  █','█  █','█  █',' ██ ',' ██ ','  █ '],
  W: ['█  █','█  █','█ ██','████','█  █','█  █'],
  X: ['█  █',' ██ ',' █  ',' ██ ',' ██ ','█  █'],
  Y: ['█  █',' ██ ','  █ ','  █ ','  █ ','  █ '],
  Z: ['████','  █ ',' █  ','█   ','█   ','████'],
  ' ': ['    ','    ','    ','    ','    ','    '],
} as const;

/** 默认渐变色: 天蓝 → 紫 */
const DEFAULT_GRAD = [
  (s: string) => supportsAnsi() ? `\x1b[38;5;81m${normalizeTerminalText(s)}\x1b[39m` : normalizeTerminalText(s),
  (s: string) => supportsAnsi() ? `\x1b[38;5;75m${normalizeTerminalText(s)}\x1b[39m` : normalizeTerminalText(s),
  (s: string) => supportsAnsi() ? `\x1b[38;5;69m${normalizeTerminalText(s)}\x1b[39m` : normalizeTerminalText(s),
  (s: string) => supportsAnsi() ? `\x1b[38;5;111m${normalizeTerminalText(s)}\x1b[39m` : normalizeTerminalText(s),
  (s: string) => supportsAnsi() ? `\x1b[38;5;177m${normalizeTerminalText(s)}\x1b[39m` : normalizeTerminalText(s),
  (s: string) => supportsAnsi() ? `\x1b[38;5;183m${normalizeTerminalText(s)}\x1b[39m` : normalizeTerminalText(s),
] as const;

/**
 * 将 ASCII 字符串渲染为 6 行像素字，每行由对应渐变函数着色。
 * @param str     输入字符串（非 ASCII 字符自动替换为空格）
 * @param spacing 字母间距，默认 1 空格
 * @param grad    6 元素渐变函数数组，默认天蓝→紫
 * @returns 6 行 ANSI 着色后的像素字
 */
export function bannerText(
  str: string,
  spacing = ' ',
  grad: readonly ((s: string) => string)[] = DEFAULT_GRAD,
): string[] {
  const chars = [...str.toUpperCase()];
  const rows = Array.from({ length: 6 }, (_, row) =>
    chars.map(ch => (BANNER[ch] ?? BANNER[' '])![row]!).join(spacing),
  );
  return rows.map((row, i) => grad[i]!(row));
}

/** 渲染像素字并直接写入 stdout */
export function printBanner(str: string, spacing?: string): void {
  console.log(bannerText(str, spacing).join('\n'));
}
