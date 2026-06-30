import * as fs from 'fs';
import * as path from 'path';
import { BINARY_EXTENSIONS } from '@customize-agent/types';
import type { I18nManager } from '../i18n/manager.js';

const RE_AT = /(?:^|\s)@([^\s@]+(?::\d+(?:-\d+)?)?)/g;
const MAX_INLINE_SIZE = 500_000;

export async function resolveAtRefs(text: string, root: string, i18n: I18nManager): Promise<string> {
  const refs: Array<{ raw: string; filePath: string; startLine?: number; endLine?: number }> = [];

  for (const m of text.matchAll(RE_AT)) {
    const raw = m[1]!;
    const ci = raw.lastIndexOf(':');
    if (ci > 0) {
      const fp = raw.slice(0, ci);
      const rng = raw.slice(ci + 1);
      const parts = rng.split('-');
      const s = parseInt(parts[0]!, 10);
      const e = parts[1] ? parseInt(parts[1], 10) : undefined;
      if (!isNaN(s)) { refs.push({ raw, filePath: fp, startLine: s, endLine: e ?? s }); continue; }
    }
    refs.push({ raw, filePath: raw });
  }

  if (!refs.length) return text;

  const parts: string[] = [];
  for (const ref of refs) {
    const full = path.resolve(root, ref.filePath);
    try {
      const stat = await fs.promises.stat(full);
      const ext = path.extname(ref.filePath).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext.slice(1)) || stat.size > MAX_INLINE_SIZE) {
        parts.push(i18n.t('file.binary', { path: ref.filePath, size: (stat.size / 1024).toFixed(1) }));
        continue;
      }
      const content = await fs.promises.readFile(full, 'utf-8');
      const lines = content.split('\n');
      let snippet: string;
      if (ref.startLine !== undefined) {
        const s = Math.max(1, ref.startLine);
        const e = Math.min(lines.length, ref.endLine ?? s);
        snippet = lines.slice(s - 1, e).map((line, i) => `${s + i}: ${line}`).join('\n');
      } else {
        snippet = content;
      }
      parts.push(`[File: ${ref.filePath}${ref.startLine ? ` L${ref.startLine}-${ref.endLine}` : ''}]\n${snippet}`);
    } catch {
      parts.push(`${i18n.t('file.not_found')} ${ref.filePath}`);
    }
  }

  const cleanText = text.replace(RE_AT, '').trim();
  const ctx = parts.join('\n\n');
  return cleanText ? `${cleanText}\n\n${i18n.t('file.reference')}\n${ctx}` : `${i18n.t('file.please_analyze')}\n${ctx}`;
}
