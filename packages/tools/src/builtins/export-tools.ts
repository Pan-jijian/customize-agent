// @customize-agent/tools — 导出工具
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveSafe } from '../core/path-utils.js';

/** HTML 转义：将 &、<、> 转为实体引用 */
function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Markdown 转 HTML 的降级实现（当 marked 库不可用时使用） */
function fallbackMarkdownToHtml(input: string): string {
  return input.split(/\n{2,}/u).map(block => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (/^#{1,6}\s/u.test(trimmed)) {
      const level = Math.min(6, trimmed.match(/^#+/u)?.[0].length ?? 1);
      return `<h${level}>${escapeHtml(trimmed.replace(/^#{1,6}\s*/u, ''))}</h${level}>`;
    }
    return `<p>${escapeHtml(trimmed).replace(/\n/gu, '<br>')}</p>`;
  }).join('\n');
}

/** 使用 marked 库将 Markdown 转为 HTML，不可用时降级为 fallback 实现 */
async function markdownToHtml(input: string): Promise<string> {
  try {
    const { marked } = await import('marked');
    return marked.parse(input, { async: false }) as string;
  } catch {
    return fallbackMarkdownToHtml(input);
  }
}

/** 构建完整 HTML 文档（含中文字体排版样式） */
function documentHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 24mm 18mm 22mm; }
    body {
      font-family: "PingFang SC", "Songti SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif;
      color: #111827;
      line-height: 1.75;
      font-size: 14px;
    }
    h1 { text-align: center; font-size: 26px; margin: 36px 0 28px; page-break-after: avoid; }
    h2 { font-size: 20px; margin-top: 30px; border-bottom: 1px solid #d1d5db; padding-bottom: 6px; page-break-after: avoid; }
    h3 { font-size: 17px; margin-top: 22px; page-break-after: avoid; }
    h4, h5, h6 { page-break-after: avoid; }
    p { margin: 8px 0; text-align: justify; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; page-break-inside: avoid; }
    th, td { border: 1px solid #9ca3af; padding: 6px 8px; font-size: 12px; vertical-align: top; }
    th { background: #f3f4f6; font-weight: 600; }
    ul, ol { padding-left: 24px; }
    li { margin: 4px 0; }
    blockquote { border-left: 4px solid #d1d5db; padding-left: 12px; color: #4b5563; }
    pre, code { font-family: "SFMono-Regular", Consolas, monospace; background: #f9fafb; }
    pre { padding: 12px; overflow-wrap: break-word; white-space: pre-wrap; }
    img { max-width: 100%; page-break-inside: avoid; }
    .document-title { page-break-after: avoid; }
  </style>
</head>
<body>
  <article>
    ${body}
  </article>
</body>
</html>`;
}

/** 使用 Playwright 将 HTML 渲染为 PDF（A4 格式，含页眉页脚） */
async function renderPdfWithPlaywright(html: string, outputPath: string): Promise<void> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '24mm', right: '18mm', bottom: '22mm', left: '18mm' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="font-size:9px;width:100%;text-align:center;color:#6b7280;">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>',
    });
  } finally {
    await browser.close();
  }
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
    const html = documentHtml(title, await markdownToHtml(body));
    const full = resolveSafe(output, this.cwd);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, html, 'utf-8');
    return `Exported HTML: ${output}`;
  }

  async exportPdf(output: string, title: string, body: string): Promise<string> {
    const full = resolveSafe(output, this.cwd);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const html = documentHtml(title, await markdownToHtml(`# ${title}\n\n${body}`));
    const htmlOutput = `${full.replace(/\.pdf$/iu, '')}.html`;
    await fs.writeFile(htmlOutput, html, 'utf-8');
    await renderPdfWithPlaywright(html, full);
    return `Exported PDF: ${output}`;
  }

  async exportSession(output: string, messages: unknown): Promise<string> {
    return this.exportJson(output, messages);
  }
}
