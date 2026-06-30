// @customize-agent/tools — 导出工具
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveSafe } from '../core/path-utils.js';

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function simplePdf(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, '\\$&').split('\n').slice(0, 80);
  const content = `BT /F1 12 Tf 50 780 Td ${safe.map((line, i) => `${i ? '0 -16 Td ' : ''}(${line}) Tj`).join(' ')} ET`;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${Buffer.byteLength(content)} >> stream\n${content}\nendstream endobj`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) { offsets.push(Buffer.byteLength(pdf)); pdf += obj + '\n'; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n ').join('\n')}\n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

export class ExportTools {
  constructor(private cwd: string) {}

  async exportMarkdown(output: string, content: string): Promise<string> {
    const full = resolveSafe(output, this.cwd);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
    return `Exported markdown: ${output}`;
  }

  async exportJson(output: string, data: unknown): Promise<string> {
    const full = resolveSafe(output, this.cwd);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, JSON.stringify(data, null, 2), 'utf-8');
    return `Exported JSON: ${output}`;
  }

  async exportHtml(output: string, title: string, body: string): Promise<string> {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><pre>${escapeHtml(body)}</pre></body></html>`;
    const full = resolveSafe(output, this.cwd);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, html, 'utf-8');
    return `Exported HTML: ${output}`;
  }

  async exportPdf(output: string, title: string, body: string): Promise<string> {
    const pdf = simplePdf(`${title}\n\n${body}`);
    const full = resolveSafe(output, this.cwd);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, pdf);
    return `Exported PDF: ${output}`;
  }

  async exportSession(output: string, messages: unknown): Promise<string> {
    return this.exportJson(output, messages);
  }
}
