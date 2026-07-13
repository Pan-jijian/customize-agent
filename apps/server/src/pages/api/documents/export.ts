import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import type { NextApiRequest, NextApiResponse } from 'next';
import { generatedRoot, getGeneratedDocument } from '@/services/generatedDocumentService';
import { getProjectRoot } from '@/services/kbService';
import type { DocumentExportSettings } from '@/services/documentWorkflowService';
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

const execFileAsync = promisify(execFile);
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

function stripInlineMarkdown(input: string) {
  return input
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`]/gu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .trim();
}

function pointsToHalfPoints(value: string | undefined, fallback: number) {
  const match = /([\d.]+)\s*(pt|px)?/iu.exec(value || '');
  if (!match) return fallback * 2;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return fallback * 2;
  return Math.round((match[2]?.toLowerCase() === 'px' ? number * 0.75 : number) * 2);
}

function lengthToTwips(value: string | undefined, fallbackCm: number) {
  const match = /([\d.]+)\s*(cm|mm|in|pt)?/iu.exec(value || '');
  if (!match) return Math.round(fallbackCm * 567);
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return Math.round(fallbackCm * 567);
  const unit = (match[2] || 'cm').toLowerCase();
  if (unit === 'mm') return Math.round(number * 56.7);
  if (unit === 'in') return Math.round(number * 1440);
  if (unit === 'pt') return Math.round(number * 20);
  return Math.round(number * 567);
}

function docxRun(text: string, options: { bold?: boolean; size?: number } = {}) {
  const props = [options.bold ? '<w:b/>' : '', options.size ? `<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>` : ''].filter(Boolean).join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function docxParagraph(text: string, options: { bold?: boolean; size?: number; align?: 'center'; spacingAfter?: number; pageBreak?: boolean } = {}) {
  if (options.pageBreak) return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const pPr = [options.align ? `<w:jc w:val="${options.align}"/>` : '', `<w:spacing w:line="440" w:lineRule="exact" w:after="${options.spacingAfter ?? 120}"/>`].filter(Boolean).join('');
  return `<w:p><w:pPr>${pPr}</w:pPr>${docxRun(text, options)}</w:p>`;
}

function parseMarkdownTable(lines: string[], start: number) {
  if (start + 1 >= lines.length || !/^\s*\|?.+\|\s*$/u.test(lines[start]) || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(lines[start + 1])) return null;
  const rows: string[][] = [];
  let index = start;
  while (index < lines.length && /^\s*\|?.+\|\s*$/u.test(lines[index])) {
    if (index !== start + 1) rows.push(lines[index].trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => stripInlineMarkdown(cell)));
    index += 1;
  }
  return { rows, next: index };
}

function docxTable(rows: string[][], bodySize: number) {
  const cells = (row: string[]) => row.map(cell => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${docxParagraph(cell, { size: bodySize })}</w:tc>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${rows.map(row => `<w:tr>${cells(row)}</w:tr>`).join('')}</w:tbl>`;
}

function markdownToDocxXml(markdown: string, settings?: DocumentExportSettings) {
  const style = exportStyle(settings);
  const titleSize = pointsToHalfPoints(style.titleSize, 16);
  const bodySize = pointsToHalfPoints(style.bodySize, 14);
  const lines = markdown.replace(/<div class="page-break"><\/div>/gu, '\n[[PAGE_BREAK]]\n').split('\n');
  const blocks: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    if (line === '[[PAGE_BREAK]]') { blocks.push(docxParagraph('', { pageBreak: true })); index += 1; continue; }
    const table = parseMarkdownTable(lines, index);
    if (table) { blocks.push(docxTable(table.rows, bodySize)); index = table.next; continue; }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) { blocks.push(docxParagraph(stripInlineMarkdown(heading[2]), { bold: true, size: titleSize, align: heading[1].length === 1 ? 'center' : undefined, spacingAfter: 160 })); index += 1; continue; }
    blocks.push(docxParagraph(stripInlineMarkdown(line), { size: bodySize }));
    index += 1;
  }
  return blocks.join('');
}

async function buildDocx(title: string, markdown: string, settings?: DocumentExportSettings, templatePath?: string) {
  const contentXml = markdownToDocxXml(markdown, settings);
  if (templatePath && fs.existsSync(templatePath)) {
    const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
    const documentFile = zip.file('word/document.xml');
    if (documentFile) {
      const xml = await documentFile.async('string');
      zip.file('word/document.xml', xml.replace(/\{\{title\}\}/gu, escapeXml(title)).replace(/\{\{content\}\}/gu, contentXml));
      return zip.generateAsync({ type: 'nodebuffer' });
    }
  }
  const page = settings?.page || {};
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels')?.file('.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.folder('_rels')?.file('document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${docxParagraph(title, { bold: true, size: pointsToHalfPoints(settings?.typography?.titleSize, 16), align: 'center', spacingAfter: 240 })}${contentXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${lengthToTwips(page.marginTop, 2.5)}" w:right="${lengthToTwips(page.marginRight, 2)}" w:bottom="${lengthToTwips(page.marginBottom, 2)}" w:left="${lengthToTwips(page.marginLeft, 2)}"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** 生成 HTML 文档外壳，包含可配置打印样式和中文排版优化 */
function cssValue(value: string | undefined, fallback: string) {
  return value && /^[\w\s\u4e00-\u9fa5,"'().-]+$/u.test(value) ? value : fallback;
}

function exportStyle(settings?: DocumentExportSettings) {
  const page = settings?.page || {};
  const typography = settings?.typography || {};
  const paper = cssValue(page.paper, 'A4');
  const marginTop = cssValue(page.marginTop, '24mm');
  const marginRight = cssValue(page.marginRight, '18mm');
  const marginBottom = cssValue(page.marginBottom, '22mm');
  const marginLeft = cssValue(page.marginLeft, '18mm');
  const fontFamily = cssValue(typography.fontFamily, '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",Arial,sans-serif');
  const lineHeight = cssValue(typography.lineHeight, '1.75');
  const titleSize = cssValue(typography.titleSize, '28px');
  const bodySize = cssValue(typography.bodySize, '14px');
  return { paper, marginTop, marginRight, marginBottom, marginLeft, fontFamily, lineHeight, titleSize, bodySize };
}

function htmlShell(title: string, body: string, settings?: DocumentExportSettings) {
  const style = exportStyle(settings);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>@page{size:${style.paper};margin:${style.marginTop} ${style.marginRight} ${style.marginBottom} ${style.marginLeft}}body{font-family:${style.fontFamily};line-height:${style.lineHeight};color:#111827;font-size:${style.bodySize}}h1{text-align:center;font-size:${style.titleSize};margin-top:80px}h2{font-size:${style.titleSize};border-bottom:1px solid #d1d5db;padding-bottom:6px;margin-top:28px;page-break-after:avoid}h3{font-size:${style.titleSize};margin-top:20px}img{display:block;max-width:100%;max-height:520px;object-fit:contain;margin:12px auto;page-break-inside:avoid}table{width:100%;border-collapse:collapse;page-break-inside:auto}tr{page-break-inside:avoid;page-break-after:auto}th,td{border:1px solid #6b7280;padding:6px 8px;vertical-align:top}th{background:#f3f4f6}pre{white-space:pre-wrap}.document-cover{min-height:720px;display:flex;flex-direction:column;justify-content:center}.document-cover h1{margin-top:0}.page-break{page-break-after:always;height:0}</style></head><body>${body}</body></html>`;
}

/** 判断问题是否为阻止导出的严重问题（非警告类问题） */
function isExportBlockingIssue(issue: { message: string }) {
  const message = issue.message.trim();
  // 事实冲突和必需章节缺失属于警告，不阻止导出
  if (/^(事实冲突|必需章节缺失)：/u.test(message)) return false;
  return /出现禁用文本\s*(资料未提供|占位|TODO|TBD)|正文包含.*(资料未提供|占位)|图片、地图或附件引用路径明显无效|无效路径|表格语法错误|临时远程生成 URL|提示词全文|内部错误|生成未完成|低于目标页数|缺少配置小节|缺少必要的正式表格|正文缺少章节标题/iu.test(message);
}

function markdownStats(markdown: string) {
  return {
    chars: markdown.trim().length,
    h2: (markdown.match(/^##\s+/gmu) || []).length,
    h3: (markdown.match(/^###\s+/gmu) || []).length,
    tables: (markdown.match(/\n\s*\|\s*:?-{3,}/gu) || []).length,
  };
}

function validateExportMarkdown(markdown: string, baseline?: string) {
  const stats = markdownStats(markdown);
  const baseStats = baseline ? markdownStats(baseline) : undefined;
  const issues: string[] = [];
  if (stats.chars < 200) issues.push('导出内容为空或过短');
  if (baseStats && baseStats.chars > 1000 && stats.chars < baseStats.chars * 0.8) issues.push('导出内容明显少于服务端生成记录');
  if (baseStats && baseStats.h3 > 0 && stats.h3 === 0) issues.push('导出内容缺少服务端生成记录中的二级小节');
  if (baseStats && baseStats.tables > 0 && stats.tables === 0) issues.push('导出内容缺少服务端生成记录中的表格');
  return issues;
}

function existingBrowserPaths() {
  const envPaths = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, process.env.CHROME_PATH].filter(Boolean) as string[];
  const home = os.homedir();
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    path.join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
  ] : process.platform === 'win32' ? [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
  return [...new Set([...envPaths, ...candidates].filter(file => file && fs.existsSync(file)))];
}

async function renderPdfWithBrowserCommand(html: string, browserPath: string, settings?: DocumentExportSettings) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'customize-agent-pdf-'));
  const htmlPath = path.join(tmpDir, 'document.html');
  const pdfPath = path.join(tmpDir, 'document.pdf');
  const profileDir = path.join(tmpDir, 'profile');
  fs.writeFileSync(htmlPath, html, 'utf-8');
  try {
    const style = exportStyle(settings);
    const fileUrl = pathToFileURL(htmlPath).href;
    const commonArgs = [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--user-data-dir=${profileDir}`,
      `--print-to-pdf=${pdfPath}`,
      `--print-to-pdf-page-size=${style.paper}`,
      fileUrl,
    ];
    const errors: string[] = [];
    for (const headlessArg of ['--headless=new', '--headless']) {
      try {
        await execFileAsync(browserPath, [headlessArg, ...commonArgs], { timeout: 30_000, maxBuffer: 1024 * 1024 });
        if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size >= 1024) return fs.readFileSync(pdfPath);
        errors.push(`${headlessArg}: browser command did not produce a valid PDF`);
      } catch (error) {
        errors.push(`${headlessArg}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(errors.join('\n'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function renderPdfBuffer(html: string, settings?: DocumentExportSettings) {
  const { chromium } = await import('playwright');
  const attempts: Array<{ label: string; options: Parameters<typeof chromium.launch>[0] }> = [
    { label: 'playwright-bundled-chromium', options: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] } },
    { label: 'system-chrome-channel', options: { channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] } },
    { label: 'system-msedge-channel', options: { channel: 'msedge', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] } },
    ...existingBrowserPaths().map(executablePath => ({ label: executablePath, options: { executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] } })),
  ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch(attempt.options);
      try {
        const page = await browser.newPage({ locale: 'zh-CN' });
        await page.setContent(html, { waitUntil: 'load' });
        await page.waitForFunction(() => Array.from(document.images).every(img => img.complete), undefined, { timeout: 10_000 }).catch(() => undefined);
        await page.emulateMedia({ media: 'print' });
        const style = exportStyle(settings);
        const pdf = await page.pdf({ format: style.paper as 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: style.marginTop, right: style.marginRight, bottom: style.marginBottom, left: style.marginLeft }, displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: '<div style="font-size:9px;width:100%;text-align:center;color:#666;">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>' });
        return Buffer.from(pdf);
      } finally {
        await browser.close();
      }
    } catch (error) {
      errors.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const browserPath of existingBrowserPaths()) {
    try {
      return await renderPdfWithBrowserCommand(html, browserPath, settings);
    } catch (error) {
      errors.push(`browser-command ${browserPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join('\n'));
}

/**
 * 文档导出 API 处理器
 * 支持导出为 Markdown、HTML、DOCX、PDF 四种格式
 * PDF 导出优先使用 Playwright 内置 Chromium，失败时自动尝试系统浏览器
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 仅允许 POST 请求
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body as { documentId?: string; title?: string; markdown?: string; format?: ExportFormat; enforceGate?: boolean; useClientMarkdown?: boolean; exportGate?: { passed?: boolean; blockingIssues?: Array<{ message: string }> }; wordTemplatePath?: string };
    const record = body.documentId ? getGeneratedDocument(body.documentId) : null;
    if (body.documentId && !record) return res.status(404).json({ error: 'Document not found' });
    const title = body.title || record?.title || 'document';
    const recordMarkdown = record?.editedMarkdown || record?.markdown || record?.draft?.markdown || '';
    const markdown = body.useClientMarkdown && typeof body.markdown === 'string' ? body.markdown : recordMarkdown || body.markdown || '';
    const format = body.format || 'markdown';
    const exportIssues = validateExportMarkdown(markdown, record?.draft?.markdown || record?.markdown);
    if (exportIssues.length) return res.status(422).json({ error: 'EXPORT_CONTENT_INVALID', issues: exportIssues });
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
      const docx = await buildDocx(title, markdown, record?.draft?.exportSettings, body.wordTemplatePath);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.docx`)}`);
      return res.status(200).send(docx);
    }
    // HTML 和 PDF 需要将 Markdown 渲染为 HTML
    const { marked } = await import('marked');
    const projectRoot = getProjectRoot();
    const exportSettings = record?.draft?.exportSettings;
    const html = inlineLocalImages(htmlShell(title, marked.parse(markdown, { async: false }) as string, exportSettings), projectRoot);
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.html`)}`);
      return res.status(200).send(html);
    }
    try {
      const pdf = await renderPdfBuffer(html, exportSettings);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.pdf`)}`);
      return res.status(200).send(pdf);
    } catch (error) {
      recordErrorLog({ level: 'error', source: 'api/documents/export', functionName: 'pdfExportChromium', error, req, meta: { fallback: 'system-browser-attempted' } });
      return res.status(500).json({ error: 'PDF_RENDER_FAILED', message: 'PDF 渲染失败：未找到或无法启动可用的 Chrome/Chromium/Edge。请安装 Chrome，或设置 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 后重试。' });
    }
}

export const __documentExportTest__ = { inlineLocalImages, resolveLocalImagePath };

export default withApiErrorBoundary('api/documents/export', handler);
