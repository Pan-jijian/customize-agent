import type { NextApiRequest, NextApiResponse } from 'next';

type ExportFormat = 'markdown' | 'html' | 'pdf';

function safeFileName(input: string) {
  return input.replace(/[\\/:*?"<>|]/gu, '-').slice(0, 80) || 'document';
}

function htmlShell(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>@page{size:A4;margin:24mm 18mm 22mm 18mm}body{font-family:"PingFang SC","Songti SC","Microsoft YaHei",sans-serif;line-height:1.75;color:#111827;font-size:14px}h1{text-align:center;font-size:28px;margin-top:120px}h2{border-bottom:1px solid #d1d5db;padding-bottom:6px;margin-top:28px;page-break-after:avoid}h3{margin-top:20px}table{width:100%;border-collapse:collapse;page-break-inside:auto}tr{page-break-inside:avoid;page-break-after:auto}th,td{border:1px solid #6b7280;padding:6px 8px;vertical-align:top}th{background:#f3f4f6}pre{white-space:pre-wrap}.document-cover{min-height:720px;display:flex;flex-direction:column;justify-content:center}.document-cover h1{margin-top:0}.page-break{page-break-after:always;height:0}</style></head><body>${body}</body></html>`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { title = 'document', markdown = '', format = 'markdown', enforceGate = false, exportGate } = req.body as { title?: string; markdown?: string; format?: ExportFormat; enforceGate?: boolean; exportGate?: { passed?: boolean; blockingIssues?: Array<{ message: string }> } };
    if (enforceGate && exportGate && !exportGate.passed) return res.status(422).json({ error: 'Export gate failed', issues: exportGate.blockingIssues ?? [] });
    const filename = safeFileName(title);
    if (format === 'markdown') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.md`)}`);
      return res.status(200).send(markdown);
    }
    const { marked } = await import('marked');
    const html = htmlShell(title, marked.parse(markdown, { async: false }) as string);
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.html`)}`);
      return res.status(200).send(html);
    }
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '24mm', right: '18mm', bottom: '22mm', left: '18mm' }, displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: '<div style="font-size:9px;width:100%;text-align:center;color:#666;">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.pdf`)}`);
      return res.status(200).send(Buffer.from(pdf));
    } finally {
      await browser.close();
    }
  } catch (e: unknown) {
    console.error('[api] documents/export', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
