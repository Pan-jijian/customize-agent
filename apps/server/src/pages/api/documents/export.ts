import * as fs from 'node:fs';
import JSZip from 'jszip';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getGeneratedDocument } from '@/services/generatedDocumentService';

type ExportFormat = 'markdown' | 'html' | 'pdf' | 'docx';

function safeFileName(input: string) {
  return input.replace(/[\\/:*?"<>|]/gu, '-').slice(0, 80) || 'document';
}

function escapeXml(input: string) {
  return input.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

function markdownToDocxText(markdown: string) {
  return markdown
    .replace(/<[^>]+>/gu, '')
    .split('\n')
    .map(line => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
    .join('');
}

async function buildDocx(title: string, markdown: string, templatePath?: string) {
  if (templatePath && fs.existsSync(templatePath)) {
    const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
    const documentFile = zip.file('word/document.xml');
    if (documentFile) {
      const xml = await documentFile.async('string');
      zip.file('word/document.xml', xml.replace(/\{\{title\}\}/gu, escapeXml(title)).replace(/\{\{content\}\}/gu, markdownToDocxText(markdown)));
      return zip.generateAsync({ type: 'nodebuffer' });
    }
  }
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels')?.file('.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.folder('_rels')?.file('document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escapeXml(title)}</w:t></w:r></w:p>${markdownToDocxText(markdown)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function plainText(markdown: string) {
  return markdown
    .replace(/<[^>]+>/gu, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[#*_`>|-]/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function utf16Hex(input: string) {
  return Buffer.from(`\uFEFF${input}`, 'utf16le').swap16().toString('hex').toUpperCase();
}

function buildFallbackPdf(title: string, markdown: string) {
  const lines = [title, '', ...plainText(markdown).split('\n')]
    .flatMap(line => line.length > 34 ? line.match(/.{1,34}/gu) || [] : [line])
    .slice(0, 900);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 34) pages.push(lines.slice(i, i + 34));
  const objects: string[] = [];
  const add = (content: string) => { objects.push(content); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>] >>');
  const pageIds: number[] = [];
  for (const pageLines of pages) {
    const textOps = pageLines.map((line, index) => `BT /F1 ${index === 0 ? 18 : 11} Tf 50 ${790 - index * 22} Td <${utf16Hex(line)}> Tj ET`).join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(textOps)} >>\nstream\n${textOps}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer << /Root ${catalogId} 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}

function htmlShell(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>@page{size:A4;margin:24mm 18mm 22mm 18mm}body{font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",Arial,sans-serif;line-height:1.75;color:#111827;font-size:14px}h1{text-align:center;font-size:28px;margin-top:80px}h2{border-bottom:1px solid #d1d5db;padding-bottom:6px;margin-top:28px;page-break-after:avoid}h3{margin-top:20px}table{width:100%;border-collapse:collapse;page-break-inside:auto}tr{page-break-inside:avoid;page-break-after:auto}th,td{border:1px solid #6b7280;padding:6px 8px;vertical-align:top}th{background:#f3f4f6}pre{white-space:pre-wrap}.document-cover{min-height:720px;display:flex;flex-direction:column;justify-content:center}.document-cover h1{margin-top:0}.page-break{page-break-after:always;height:0}</style></head><body>${body}</body></html>`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body as { documentId?: string; title?: string; markdown?: string; format?: ExportFormat; enforceGate?: boolean; exportGate?: { passed?: boolean; blockingIssues?: Array<{ message: string }> }; wordTemplatePath?: string };
    const record = body.documentId ? getGeneratedDocument(body.documentId) : null;
    if (body.documentId && !record) return res.status(404).json({ error: 'Document not found' });
    const title = record?.title || body.title || 'document';
    const markdown = record?.editedMarkdown || record?.markdown || body.markdown || '';
    const format = body.format || 'markdown';
    const exportGate = record?.draft?.exportGate || body.exportGate;
    if (body.enforceGate && exportGate && !exportGate.passed) return res.status(422).json({ error: 'Export gate failed', issues: exportGate.blockingIssues ?? [] });
    const filename = safeFileName(title);
    if (format === 'markdown') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.md`)}`);
      return res.status(200).send(markdown);
    }
    if (format === 'docx') {
      const docx = await buildDocx(title, markdown, body.wordTemplatePath);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.docx`)}`);
      return res.status(200).send(docx);
    }
    const { marked } = await import('marked');
    const html = htmlShell(title, marked.parse(markdown, { async: false }) as string);
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.html`)}`);
      return res.status(200).send(html);
    }
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      try {
        const page = await browser.newPage({ locale: 'zh-CN' });
        await page.setContent(html, { waitUntil: 'load' });
        await page.emulateMedia({ media: 'print' });
        const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: '24mm', right: '18mm', bottom: '22mm', left: '18mm' }, displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: '<div style="font-size:9px;width:100%;text-align:center;color:#666;">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.pdf`)}`);
        return res.status(200).send(Buffer.from(pdf));
      } finally {
        await browser.close();
      }
    } catch {
      const pdf = buildFallbackPdf(title, markdown);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.pdf`)}`);
      return res.status(200).send(pdf);
    }
  } catch (e: unknown) {
    console.error('[api] documents/export', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
