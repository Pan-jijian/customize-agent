import * as fs from 'node:fs';
import * as path from 'node:path';
import JSZip from 'jszip';
import type { NextApiRequest, NextApiResponse } from 'next';
import { generatedRoot, getGeneratedDocument } from '@/services/generatedDocumentService';
import { getProjectRoot } from '@/services/kbService';
import { recordErrorLog } from '@/services/errorLogService';
import { withApiErrorBoundary } from '@/services/apiErrorBoundary';

type ExportFormat = 'markdown' | 'html' | 'pdf' | 'docx';

/** 将文件名中的非法字符替换为连字符，限制长度 80 字符 */
/** 将文件名中的非法字符替换为连字符，限制长度 80 字符 */
function safeFileName(input: string) {
  return input.replace(/[\\/:*?"<>|]/gu, '-').slice(0, 80) || 'document';
}

/** 转义 XML 特殊字符 */
/** 转义 XML 特殊字符 */
function escapeXml(input: string) {
  return input.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INLINE_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

/** 根据文件扩展名获取 MIME 类型 */
/** 根据文件扩展名获取 MIME 类型 */
function imageMime(filePath: string) {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || '';
}

/** 检查文件路径是否在指定根目录之内（防止路径穿越） */
/** 检查文件路径是否在指定根目录之内（防止路径穿越） */
function isInsidePath(filePath: string, root: string) {
  const relative = path.relative(root, filePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 安全解码 URI 路径，忽略查询参数和片段 */
/** 安全解码 URI 路径，忽略查询参数和片段 */
function safeDecodeUriPath(src: string) {
  try { return decodeURIComponent(src.split(/[?#]/u)[0] || src); }
  catch { return ''; }
}

/**
 * 解析文档中的本地图片路径
 * 仅在知识库或生成资产目录内查找，防止任意文件读取
 */
function resolveLocalImagePath(src: string, projectRoot = getProjectRoot()) {
  // 跳过远程 URL、Data URI 等非本地路径
  if (!src || /^(?:https?:|data:|file:|blob:|#)/iu.test(src)) return null;
  const clean = safeDecodeUriPath(src);
  if (!clean || path.isAbsolute(clean)) return null;
  const knowledgeRoot = path.resolve(projectRoot, 'knowledgeBase');
  const assetRoot = path.resolve(generatedRoot(projectRoot), 'assets');
  // 在知识库目录和生成资产目录中查找匹配的图片文件
  const candidates = [
    clean.startsWith('generatedDocuments/assets/') ? path.resolve(assetRoot, clean.replace(/^generatedDocuments\/assets\//u, '')) : '',
    path.resolve(knowledgeRoot, clean),
  ].filter(Boolean);
  return candidates.find(candidate => {
    const resolved = path.resolve(candidate);
    const allowed = isInsidePath(resolved, knowledgeRoot) || isInsidePath(resolved, assetRoot);
    return allowed && Boolean(imageMime(resolved)) && fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  }) || null;
}

/**
 * 将 HTML 中的本地图片转换为 Base64 Data URL（内联化）
 * 受大小限制：单图 8MB，总计 32MB
 */
function inlineLocalImages(html: string, projectRoot = getProjectRoot()) {
  const cache = new Map<string, string>();
  let totalBytes = 0;
  return html.replace(/<img\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>/giu, (match, before: string, src: string, after: string) => {
    const localPath = resolveLocalImagePath(src, projectRoot);
    if (!localPath) return match;
    const stat = fs.statSync(localPath);
    // 超过大小限制则跳过内联
    if (stat.size > MAX_INLINE_IMAGE_BYTES || totalBytes + stat.size > MAX_TOTAL_INLINE_IMAGE_BYTES) return match;
    let dataUrl = cache.get(localPath);
    if (!dataUrl) {
      dataUrl = `data:${imageMime(localPath)};base64,${fs.readFileSync(localPath).toString('base64')}`;
      cache.set(localPath, dataUrl);
      totalBytes += stat.size;
    }
    return `<img${before}src="${dataUrl}"${after}>`;
  });
}

/** 将 Markdown 文本转换为 DOCX 兼容的 XML 段落格式 */
/** 将 Markdown 文本转换为 DOCX 兼容的 XML 段落格式 */
function markdownToDocxText(markdown: string) {
  return markdown
    .replace(/<[^>]+>/gu, '')
    .split('\n')
    .map(line => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
    .join('');
}

/**
 * 构建 DOCX 文档
 * 如果提供了模板路径，则基于模板替换标题和内容占位符
 * 否则从头创建标准 DOCX 文档
 */
async function buildDocx(title: string, markdown: string, templatePath?: string) {
  if (templatePath && fs.existsSync(templatePath)) {
    // 使用 DOCX 模板：加载并替换占位符
    const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
    const documentFile = zip.file('word/document.xml');
    if (documentFile) {
      const xml = await documentFile.async('string');
      zip.file('word/document.xml', xml.replace(/\{\{title\}\}/gu, escapeXml(title)).replace(/\{\{content\}\}/gu, markdownToDocxText(markdown)));
      return zip.generateAsync({ type: 'nodebuffer' });
    }
  }
  // 从头创建 DOCX：生成内容类型、关系和文档 XML
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

/** 将字符串转为 UTF-16 BE 十六进制编码（用于 PDF 嵌入中文字体） */
/** 将字符串转为 UTF-16 BE 十六进制编码（用于 PDF 嵌入中文字体） */
function utf16Hex(input: string) {
  return Buffer.from(`\uFEFF${input}`, 'utf16le').swap16().toString('hex').toUpperCase();
}

/**
 * 备用的纯文本 PDF 生成方案（当 Playwright 不可用时使用）
 * 手动构造 PDF-1.4 格式，支持中文显示（使用 STSong-Light CID 字体）
 */
function buildFallbackPdf(title: string, markdown: string) {
  // 将文本分行并限制每行 34 字符，最多 900 行
  const lines = [title, '', ...plainText(markdown).split('\n')]
    .flatMap(line => line.length > 34 ? line.match(/.{1,34}/gu) || [] : [line])
    .slice(0, 900);
  // 每页 34 行进行分页
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 34) pages.push(lines.slice(i, i + 34));
  const objects: string[] = [];
  const add = (content: string) => { objects.push(content); return objects.length; };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>] >>');
  const pageIds: number[] = [];
  // 逐页生成 PDF 内容流和页面定义
  for (const pageLines of pages) {
    const textOps = pageLines.map((line, index) => `BT /F1 ${index === 0 ? 18 : 11} Tf 50 ${790 - index * 22} Td <${utf16Hex(line)}> Tj ET`).join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(textOps)} >>\nstream\n${textOps}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  // 组装 PDF 文件：对象定义 + 交叉引用表
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

/** 生成 HTML 文档外壳，包含 A4 打印样式和中文排版优化 */
function htmlShell(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>@page{size:A4;margin:24mm 18mm 22mm 18mm}body{font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",Arial,sans-serif;line-height:1.75;color:#111827;font-size:14px}h1{text-align:center;font-size:28px;margin-top:80px}h2{border-bottom:1px solid #d1d5db;padding-bottom:6px;margin-top:28px;page-break-after:avoid}h3{margin-top:20px}img{display:block;max-width:100%;max-height:520px;object-fit:contain;margin:12px auto;page-break-inside:avoid}table{width:100%;border-collapse:collapse;page-break-inside:auto}tr{page-break-inside:avoid;page-break-after:auto}th,td{border:1px solid #6b7280;padding:6px 8px;vertical-align:top}th{background:#f3f4f6}pre{white-space:pre-wrap}.document-cover{min-height:720px;display:flex;flex-direction:column;justify-content:center}.document-cover h1{margin-top:0}.page-break{page-break-after:always;height:0}</style></head><body>${body}</body></html>`;
}

/** 判断问题是否为阻止导出的严重问题（非警告类问题） */
function isExportBlockingIssue(issue: { message: string }) {
  const message = issue.message.trim();
  // 事实冲突和必需章节缺失属于警告，不阻止导出
  if (/^(事实冲突|必需章节缺失)：/u.test(message)) return false;
  return /出现禁用文本\s*(资料未提供|占位|TODO|TBD)|正文包含.*(资料未提供|占位)|图片、地图或附件引用路径明显无效|无效路径|表格语法错误|临时远程生成 URL|提示词全文|内部错误/iu.test(message);
}

/**
 * 文档导出 API 处理器
 * 支持导出为 Markdown、HTML、DOCX、PDF 四种格式
 * PDF 导出优先使用 Playwright，失败时回退到备用生成方案
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 仅允许 POST 请求
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body as { documentId?: string; title?: string; markdown?: string; format?: ExportFormat; enforceGate?: boolean; exportGate?: { passed?: boolean; blockingIssues?: Array<{ message: string }> }; wordTemplatePath?: string };
    const record = body.documentId ? getGeneratedDocument(body.documentId) : null;
    if (body.documentId && !record) return res.status(404).json({ error: 'Document not found' });
    const title = body.title || record?.title || 'document';
    const markdown = typeof body.markdown === 'string' ? body.markdown : record?.editedMarkdown || record?.markdown || '';
    const format = body.format || 'markdown';
    const exportGate = record?.draft?.exportGate || body.exportGate;
    // 过滤并检查导出关卡
    const blockingIssues = exportGate?.blockingIssues?.filter(isExportBlockingIssue) || [];
    if (body.enforceGate && blockingIssues.length) return res.status(422).json({ error: 'Export gate failed', issues: blockingIssues });
    const filename = safeFileName(title);
    // Markdown 格式直接返回文本
    if (format === 'markdown') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.md`)}`);
      return res.status(200).send(markdown);
    }
    // DOCX 格式
    if (format === 'docx') {
      const docx = await buildDocx(title, markdown, body.wordTemplatePath);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.docx`)}`);
      return res.status(200).send(docx);
    }
    // HTML 和 PDF 需要将 Markdown 渲染为 HTML
    const { marked } = await import('marked');
    const projectRoot = getProjectRoot();
    const html = inlineLocalImages(htmlShell(title, marked.parse(markdown, { async: false }) as string), projectRoot);
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.html`)}`);
      return res.status(200).send(html);
    }
    // PDF 导出：优先使用 Playwright 渲染
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      try {
        const page = await browser.newPage({ locale: 'zh-CN' });
        await page.setContent(html, { waitUntil: 'load' });
        // 等待所有图片加载完成
        await page.waitForFunction(() => Array.from(document.images).every(img => img.complete && img.naturalWidth > 0), undefined, { timeout: 10_000 }).catch(() => undefined);
        await page.emulateMedia({ media: 'print' });
        const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: '24mm', right: '18mm', bottom: '22mm', left: '18mm' }, displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: '<div style="font-size:9px;width:100%;text-align:center;color:#666;">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.pdf`)}`);
        return res.status(200).send(Buffer.from(pdf));
      } finally {
        await browser.close();
      }
    } catch (error) {
      // Playwright 失败时记录日志并使用备用方案
      recordErrorLog({ level: 'warn', source: 'api/documents/export', functionName: 'pdfExportChromium', error, req, meta: { fallback: 'minimal-pdf' } });
      const pdf = buildFallbackPdf(title, markdown);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.pdf`)}`);
      return res.status(200).send(pdf);
    }
}

export const __documentExportTest__ = { inlineLocalImages, resolveLocalImagePath };

export default withApiErrorBoundary('api/documents/export', handler);
