// @customize-agent/cli — Terminal Markdown 渲染（marked v15 自定义 Renderer）
import { marked, Renderer } from 'marked';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { t, s } from './colors.js';
import { normalizeTerminalText, supportsAnsi } from './terminal-capabilities.js';

function tw(): number {
  return Math.max(60, Math.min(process.stdout.columns ?? 80, 200));
}

function cb(text: string, fg: number, bg: number): string {
  const value = normalizeTerminalText(text);
  return supportsAnsi() ? `\x1b[38;5;${fg}m\x1b[48;5;${bg}m${value}\x1b[39;49m` : value;
}

function visibleLen(text: string): number {
  const ansiRe = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
  return stringWidth(text.replace(ansiRe, ''));
}

type HeadingToken    = Parameters<Renderer['heading']>[0];
type ParagraphToken  = Parameters<Renderer['paragraph']>[0];
type BlockquoteToken = Parameters<Renderer['blockquote']>[0];
type ListToken       = Parameters<Renderer['list']>[0];
type ListItemToken   = Parameters<Renderer['listitem']>[0];
type TableToken      = Parameters<Renderer['table']>[0];
type InlineTokens    = NonNullable<Parameters<Renderer['strong']>[0]['tokens']>;

class TerminalRenderer extends Renderer {
  space(_token: { raw: string }): string { return '\n'; }

  text(token: { text: string }): string { return token.text; }

  strong(token: { text: string }): string { return s.bold(token.text); }
  em(token: { text: string }): string { return s.italic(token.text); }
  del(token: { text: string }): string { return t.faint(token.text); }
  codespan(token: { text: string }): string { return cb(token.text, 255, 238); }

  link(token: { href: string; text: string }): string {
    return `${token.text} ${t.faint(token.href.slice(0, 60))}`;
  }
  image(token: { href: string; text: string }): string {
    return t.faint(`[img: ${token.text || token.href}]`);
  }

  private _renderInline(tokens?: InlineTokens): string {
    if (!tokens?.length) return '';
    return this.parser.parseInline(tokens);
  }

  heading(token: HeadingToken): string {
    const content = this._renderInline(token.tokens);
    const colors: Array<(s: string) => string> = [t.purple, t.blue, t.accent, t.dim, t.dim, t.dim];
    const color = colors[Math.min(token.depth - 1, 5)]!;
    return `\n${s.bold(color(content))}\n`;
  }

  paragraph(token: ParagraphToken): string {
    return this._renderInline(token.tokens) + '\n';
  }

  hr(): string {
    const w = Math.min(tw() - 4, 80);
    const side = '─'.repeat(Math.max(0, Math.floor((w - 4) / 2)));
    return `\n${t.subtle(side + ' ◆ ' + side)}\n`;
  }

  code(token: { text: string; lang?: string }): string {
    const W = Math.min(tw() - 4, 80);
    const BAR = t.accent('│');
    const langLabel = token.lang ? ` ${token.lang} ` : '';
    const topBar = t.accent('┌─') +
      (token.lang ? s.bold(t.accent(langLabel)) : '') +
      t.accent('─'.repeat(Math.max(0, W - 4 - langLabel.length)) + '─┐');
    const out = [topBar];
    const innerW = W - 4;
    const content = token.text.replace(/\n$/, '');
    const wrapped = wrapAnsi(content, innerW, { hard: true });
    for (const line of wrapped.split('\n')) {
      const padding = ' '.repeat(Math.max(0, innerW - stringWidth(line)));
      out.push(BAR + ' ' + t.faint(line) + padding + ' ' + BAR);
    }
    out.push(t.accent('└' + '─'.repeat(W - 2) + '┘'));
    return '\n' + out.join('\n') + '\n';
  }

  blockquote(token: BlockquoteToken): string {
    const inner = token.tokens?.length
      ? this.parser.parse(token.tokens).trimEnd()
      : token.text;
    const bar = t.accent('▎');
    return inner.split('\n').map(l => `${bar} ${t.dim(l)}`).join('\n') + '\n';
  }

  list(token: ListToken): string {
    let out = '';
    let n = typeof token.start === 'number' ? token.start : 1;
    for (const item of token.items) {
      const bullet = token.ordered ? t.blue(`${n}.`) : t.accent('•');
      let checkbox = '';
      if (item.task) {
        checkbox = item.checked ? t.success('[X] ') : t.faint('[ ] ');
      }
      const firstBlock = item.tokens?.find(
        (t): t is typeof t & { tokens: InlineTokens } => t.type === 'paragraph' || t.type === 'text',
      );
      const inlineContent = this._renderInline(firstBlock?.tokens ?? []);
      out += `${t.accent(bullet)} ${checkbox}${inlineContent}\n`;
      if (token.ordered) n++;
    }
    return out + '\n';
  }

  listitem(token: ListItemToken): string {
    return token.tokens?.length ? this.parser.parse(token.tokens).trimEnd() : token.text;
  }

  table(token: TableToken): string {
    const colCount = token.header.length;
    const totalW = Math.min(tw() - 4, 80);
    const cellPad = 4;
    const overhead = colCount * (cellPad + 1) + 1;
    const usableW = Math.max(colCount * 4, totalW - overhead);

    const pad = (s: string, w: number): string => { const v = visibleLen(s); return s + ' '.repeat(Math.max(0, w - v)); };
    const renderedHeader = token.header.map(c => this._renderInline(c.tokens));
    const renderedRows = token.rows.map(row => row.map(c => this._renderInline(c.tokens)));

    const rawMaxPerCol: number[] = [];
    for (let i = 0; i < colCount; i++) {
      let maxW = visibleLen(renderedHeader[i]!);
      for (const row of renderedRows) maxW = Math.max(maxW, visibleLen(row[i]!));
      rawMaxPerCol.push(maxW);
    }
    const colWidths: number[] = rawMaxPerCol.map(raw => Math.min(raw, usableW));
    let allocSum = colWidths.reduce((a, b) => a + b, 0);

    if (allocSum > usableW) {
      const scale = usableW / allocSum;
      for (let i = 0; i < colCount; i++) colWidths[i] = Math.max(4, Math.floor(colWidths[i]! * scale));
      allocSum = colWidths.reduce((a, b) => a + b, 0);
      let rrr = 0;
      while (allocSum < usableW) { colWidths[rrr % colCount]!++; allocSum++; rrr++; }
      while (allocSum > usableW) {
        const mi = colWidths.indexOf(Math.max(...colWidths));
        if (colWidths[mi]! <= 4) break;
        colWidths[mi]!--; allocSum--;
      }
    } else if (allocSum < usableW) {
      let rrr = 0;
      while (allocSum < usableW) { colWidths[rrr % colCount]!++; allocSum++; rrr++; }
    }

    const wrapCell = (content: string, w: number): string[] =>
      visibleLen(content) <= w ? [content] : wrapAnsi(content, w, { hard: true, trim: false }).split('\n');
    const headerWrapped = renderedHeader.map((c, i) => wrapCell(c, colWidths[i]!));
    const rowsWrapped = renderedRows.map(row => row.map((c, i) => wrapCell(c, colWidths[i]!)));

    const buildRow = (
      cells: string[][], barColor: (s: string) => string, subColor: (s: string) => string, cellWrap: (c: string) => string,
    ): string[] => {
      const maxLines = Math.max(...cells.map(c => c.length), 1);
      const lines: string[] = [];
      for (let line = 0; line < maxLines; line++) {
        const joinBar = barColor('│');
        const leadingBar = line === 0 ? barColor('│') : subColor('┊');
        const content = cells.map((c, i) => {
          const text = c[line] ?? '';
          return pad(cellWrap(text), colWidths[i]!);
        }).join(`  ${joinBar}  `);
        lines.push(leadingBar + '  ' + content + '  ' + barColor('│'));
      }
      return lines;
    };

    const out: string[] = [];
    out.push(t.subtle('┌' + colWidths.map(w => '─'.repeat(w + cellPad)).join('┬') + '┐'));
    out.push(...buildRow(headerWrapped, t.subtle, t.subtle, (c) => s.bold(c)));
    out.push(t.subtle('├' + colWidths.map(w => '─'.repeat(w + cellPad)).join('┼') + '┤'));
    for (let ri = 0; ri < rowsWrapped.length; ri++) {
      out.push(...buildRow(rowsWrapped[ri]!, t.subtle, t.subtle, (c) => c));
    }
    out.push(t.subtle('└' + colWidths.map(w => '─'.repeat(w + cellPad)).join('┴') + '┘'));
    return '\n' + out.join('\n') + '\n';
  }

  html(token: { text: string }): string { return token.text; }
}

marked.setOptions({ renderer: new TerminalRenderer() });

export function renderMarkdown(text: string): string {
  if (!text) return '';
  try {
    const pre = text.replace(/\n{3,}/g, '\n\n');
    return marked.parse(pre, { async: false }) as string;
  } catch (err) {
    console.error('[renderMarkdown] parse failed:', (err as Error).message);
    return text;
  }
}

export function renderInlineMarkdown(text: string): string {
  const stash: string[] = [];
  const NUL = String.fromCharCode(0);
  let idx = 0;

  const applyInline = (line: string): string => {
    let result = line.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, txt: string, href: string) => {
      stash[idx] = t.faint(`[img: ${txt || href}]`);
      return NUL + String(idx++) + NUL;
    });
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt: string, href: string) => {
      stash[idx] = `${txt} ${t.faint(href.slice(0, 60))}`;
      return NUL + String(idx++) + NUL;
    });
    result = result
      .replace(/\*\*([^*]+)\*\*/g, (_m, c: string) => s.bold(c))
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_m, c: string) => s.italic(c))
      .replace(/`([^`]+)`/g, (_m, c: string) => cb(c, 255, 238))
      .replace(/~~([^~]+)~~/g, (_m, c: string) => t.faint(c));
    const unstashRe = new RegExp(NUL + '(\\d+)' + NUL, 'g');
    return result.replace(unstashRe, (_m, i: string) => stash[+i] ?? '');
  };

  const HEADING_RE = /^(#{1,6})\s+(.*)/;
  const QUOTE_RE   = /^>\s?(.*)/;
  const FENCE_RE   = /^(`{3,}|~{3,})\s*(.*)/;
  const PIPE_RE    = /^\|.+$/;

  const headingMatch = text.match(HEADING_RE);
  if (headingMatch) {
    const depth = headingMatch[1]!.length;
    const colors: Array<(s: string) => string> = [t.purple, t.blue, t.accent, t.dim, t.dim, t.dim];
    return s.bold(colors[Math.min(depth - 1, 5)]!(applyInline(headingMatch[2]!))) + '\n';
  }
  const fenceMatch = text.match(FENCE_RE);
  if (fenceMatch) {
    const lang = fenceMatch[2]!;
    return t.accent(fenceMatch[1]!) + (lang ? s.bold(t.accent(' ' + lang + ' ')) : '') + '\n';
  }
  const pipeMatch = text.match(PIPE_RE);
  if (pipeMatch) {
    return applyInline(text).replace(/\|/g, t.subtle('│'));
  }
  const quoteMatch = text.match(QUOTE_RE);
  if (quoteMatch) {
    return `${t.accent('▎')} ${t.dim(applyInline(quoteMatch[1]!))}\n`;
  }
  const ulMatch = text.match(/^[-*]\s+(.*)/);
  if (ulMatch) {
    return `${t.accent('•')} ${applyInline(ulMatch[1]!)}\n`;
  }
  const olMatch = text.match(/^(\d+)\.\s+(.*)/);
  if (olMatch) {
    return `${t.blue(olMatch[1]! + '.')} ${applyInline(olMatch[2]!)}\n`;
  }
  return applyInline(text);
}
