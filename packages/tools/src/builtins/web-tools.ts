// @customize-agent/tools — Web 工具
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveSafe } from '../core/path-utils.js';

function decodeHtml(input: string): string {
  return input.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export class WebTools {
  constructor(private cwd: string) {}

  async webSearch(query: string, signal?: AbortSignal): Promise<string> {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal, headers: { 'user-agent': 'customize-agent/1.0' } });
    const html = await res.text();
    const matches = [...html.matchAll(/<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.*?)<\/a>/g)].slice(0, 8);
    if (!matches.length) return `No web results for ${query}`;
    return matches.map((m, i) => `${i + 1}. ${decodeHtml(m[2] ?? '')}\n${decodeHtml(m[1] ?? '')}`).join('\n\n');
  }

  async webFetch(url: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(url, { signal, headers: { 'user-agent': 'customize-agent/1.0' } });
    const text = await res.text();
    return text.slice(0, 60_000);
  }

  async downloadFile(url: string, output: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(url, { signal, headers: { 'user-agent': 'customize-agent/1.0' } });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const full = resolveSafe(output, this.cwd);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    return `Downloaded ${url} -> ${output} (${buffer.length} bytes)`;
  }
}
