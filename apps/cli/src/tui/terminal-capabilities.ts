export function supportsAnsi(): boolean {
  if (process.env.NO_COLOR || process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY || process.env.FORCE_COLOR);
}

export function supportsUnicode(): boolean {
  return process.env.CUSTOMIZE_AGENT_ASCII !== '1';
}

export function normalizeTerminalText(text: string): string {
  if (supportsUnicode()) return text;
  return text
    .replace(/[╭┌]/gu, '+')
    .replace(/[╮┐]/gu, '+')
    .replace(/[╰└]/gu, '+')
    .replace(/[╯┘]/gu, '+')
    .replace(/[├┤┬┴┼]/gu, '+')
    .replace(/[─═]/gu, '-')
    .replace(/[│┃┊▎]/gu, '|')
    .replace(/[▶▸]/gu, '>')
    .replace(/◆/gu, '*')
    .replace(/✓/gu, 'OK')
    .replace(/✗/gu, 'X')
    .replace(/⚡/gu, '!')
    .replace(/•/gu, '-')
    .replace(/…/gu, '...');
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    width += cp >= 0x2E80 && cp <= 0xFFEF ? 2 : 1;
  }
  return width;
}
