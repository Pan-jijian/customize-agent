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

function stripMarkdownDocumentFence(input: string) {
  const trimmed = input.trim();
  const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/iu.exec(trimmed);
  return match ? match[1].trim() : input;
}

function normalizeExportUnits(input: string) {
  const normalizePower = (value: string) => value
    .replace(/m\s*<sup>\s*2\s*<\/sup>/giu, 'm²')
    .replace(/m\s*<sup>\s*3\s*<\/sup>/giu, 'm³')
    .replace(/m\s*\^\s*2/giu, 'm²')
    .replace(/m\s*\^\s*3/giu, 'm³')
    .replace(/㎡/gu, 'm²')
    .replace(/㎥/gu, 'm³')
    .replace(/(?<=\d)m\s*2(?![\p{L}\p{N}_])/giu, 'm²')
    .replace(/(?<=\d)m\s*3(?![\p{L}\p{N}_])/giu, 'm³')
    .replace(/(?<![\p{L}\p{N}_])m\s*2(?![\p{L}\p{N}_])/giu, 'm²')
    .replace(/(?<![\p{L}\p{N}_])m\s*3(?![\p{L}\p{N}_])/giu, 'm³');
  return normalizePower(stripMarkdownDocumentFence(input));
}

function stripInlineMarkdown(input: string) {
  return normalizeExportUnits(input)
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`]/gu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .trim();
}

function pointsValue(value: string | undefined, fallback: number) {
  const match = /([\d.]+)\s*(pt|px)?/iu.exec(value || '');
  if (!match) return fallback;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return fallback;
  return match[2]?.toLowerCase() === 'px' ? number * 0.75 : number;
}

function pointsCss(value: string | undefined, fallback: number) {
  return `${pointsValue(value, fallback)}pt`;
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

function resolveExportStyle(settings?: DocumentExportSettings) {
  const raw = exportStyle(settings);
  const bodyPt = pointsValue(raw.bodySize, 14);
  const titlePt = pointsValue(raw.titleSize, 16);
  const linePt = pointsValue(raw.lineHeight, 22);
  return {
    ...raw,
    bodyPt,
    titlePt,
    linePt,
    bodyHalfPoints: Math.round(bodyPt * 2),
    titleHalfPoints: Math.round(titlePt * 2),
    lineTwips: Math.round(linePt * 20),
    fontEastAsia: '宋体',
    fontAscii: 'SimSun',
    bodyCss: `${bodyPt}pt`,
    titleCss: `${titlePt}pt`,
    lineCss: `${linePt}pt`,
  };
}

function docxRun(text: string, options: { bold?: boolean; size?: number; fontEastAsia?: string; fontAscii?: string } = {}) {
  const fontEastAsia = options.fontEastAsia || '宋体';
  const fontAscii = options.fontAscii || 'SimSun';
  const props = [
    `<w:rFonts w:ascii="${escapeXml(fontAscii)}" w:hAnsi="${escapeXml(fontAscii)}" w:eastAsia="${escapeXml(fontEastAsia)}" w:cs="${escapeXml(fontAscii)}"/>`,
    options.bold ? '<w:b/>' : '',
    options.size ? `<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>` : '',
  ].filter(Boolean).join('');
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function docxParagraph(text: string, options: { bold?: boolean; size?: number; align?: 'left' | 'center' | 'right'; spacingBefore?: number; spacingAfter?: number; pageBreak?: boolean; line?: number; fontEastAsia?: string; fontAscii?: string; indentLeft?: number; firstLine?: number; keepNext?: boolean } = {}) {
  if (options.pageBreak) return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const indent = [options.indentLeft ? `w:left="${options.indentLeft}"` : '', options.firstLine ? `w:firstLine="${options.firstLine}"` : ''].filter(Boolean).join(' ');
  const pPr = [
    options.keepNext ? '<w:keepNext/>' : '',
    options.align ? `<w:jc w:val="${options.align}"/>` : '',
    indent ? `<w:ind ${indent}/>` : '',
    `<w:spacing w:line="${options.line ?? 440}" w:lineRule="exact" w:before="${options.spacingBefore ?? 0}" w:after="${options.spacingAfter ?? 120}"/>`,
  ].filter(Boolean).join('');
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

function docxTable(rows: string[][], style: ReturnType<typeof resolveExportStyle>) {
  const cells = (row: string[], rowIndex: number) => row.map(cell => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/><w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar>${rowIndex === 0 ? '<w:shd w:fill="F3F4F6"/>' : ''}</w:tcPr>${docxParagraph(cell, { bold: rowIndex === 0, size: style.bodyHalfPoints, line: style.lineTwips, fontEastAsia: style.fontEastAsia, fontAscii: style.fontAscii, spacingAfter: 0, align: rowIndex === 0 ? 'center' : undefined })}</w:tc>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:firstRow="1" w:noHBand="0"/><w:tblBorders><w:top w:val="single" w:sz="6" w:color="666666"/><w:left w:val="single" w:sz="6" w:color="666666"/><w:bottom w:val="single" w:sz="6" w:color="666666"/><w:right w:val="single" w:sz="6" w:color="666666"/><w:insideH w:val="single" w:sz="4" w:color="666666"/><w:insideV w:val="single" w:sz="4" w:color="666666"/></w:tblBorders></w:tblPr>${rows.map((row, rowIndex) => `<w:tr>${cells(row, rowIndex)}</w:tr>`).join('')}</w:tbl>`;
}

function isTocSectionLine(line: string) {
  return /^\s*\d+\.\d+\s+\S/u.test(line);
}

function docxTocParagraph(line: string, style: ReturnType<typeof resolveExportStyle>) {
  const sectionLine = isTocSectionLine(line);
  return docxParagraph(stripInlineMarkdown(line), { bold: !sectionLine, size: style.bodyHalfPoints, line: style.lineTwips, fontEastAsia: style.fontEastAsia, fontAscii: style.fontAscii, spacingAfter: sectionLine ? 30 : 80, indentLeft: sectionLine ? 420 : 0, align: 'left' });
}

function docxHeadingParagraph(level: number, text: string, style: ReturnType<typeof resolveExportStyle>) {
  if (level === 2) return docxParagraph(text, { bold: true, size: Math.max(style.titleHalfPoints + 4, 36), line: style.lineTwips, fontEastAsia: style.fontEastAsia, fontAscii: style.fontAscii, align: 'center', spacingBefore: 260, spacingAfter: 180, keepNext: true });
  if (level === 3) return docxParagraph(text, { bold: true, size: Math.max(style.titleHalfPoints, 32), line: style.lineTwips, fontEastAsia: style.fontEastAsia, fontAscii: style.fontAscii, spacingBefore: 180, spacingAfter: 100, keepNext: true });
  return docxParagraph(text, { bold: true, size: Math.max(style.bodyHalfPoints, 28), line: style.lineTwips, fontEastAsia: style.fontEastAsia, fontAscii: style.fontAscii, spacingBefore: 120, spacingAfter: 80, keepNext: true });
}

function markdownToDocxXml(markdown: string, settings?: DocumentExportSettings) {
  const style = resolveExportStyle(settings);
  const titleSize = style.titleHalfPoints;
  const bodySize = style.bodyHalfPoints;
  const normalizedMarkdown = normalizeExportUnits(markdown);
  const lines = normalizedMarkdown.replace(/<div class="page-break"><\/div>/gu, '\n[[PAGE_BREAK]]\n').split('\n');
  const blocks: string[] = [];
  let inToc = false;
  let inCover = false;
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    if (/<div\s+class=["']document-cover["']\s*>/iu.test(line)) { inCover = true; index += 1; continue; }
    if (inCover && /^<\/div>$/iu.test(line)) { inCover = false; index += 1; continue; }
    if (line === '[[PAGE_BREAK]]') { inToc = false; inCover = false; blocks.push(docxParagraph('', { pageBreak: true })); index += 1; continue; }
    if (inCover) {
      const coverText = stripInlineMarkdown(line.replace(/^#\s+/u, ''));
      if (coverText) blocks.push(docxParagraph(coverText, { bold: true, size: Math.max(titleSize + 8, 44), line: Math.round(style.lineTwips * 1.15), fontEastAsia: style.fontEastAsia, fontAscii: style.fontAscii, align: 'center', spacingBefore: 360, spacingAfter: 220 }));
      index += 1;
      continue;
    }
    const table = parseMarkdownTable(lines, index);
    if (table) { blocks.push(docxTable(table.rows, style), docxParagraph('', { spacingAfter: 80, line: style.lineTwips })); index = table.next; continue; }
    const heading = /^(#{1,4})\s+(.+)$/u.exec(line);
    if (heading) {
      const headingText = stripInlineMarkdown(heading[2]);
      inToc = headingText === '目录';
      blocks.push(docxHeadingParagraph(heading[1].length, headingText, style));
      index += 1;
      continue;
    }
    const plainLine = stripInlineMarkdown(line);
    const boldLine = /^\*\*[^*]+\*\*\s*[:：]?\s*$/u.test(line) || /^（[一二三四五六七八九十]+）/u.test(plainLine) || /^[一二三四五六七八九十]+、/u.test(plainLine);
    blocks.push(inToc ? docxTocParagraph(line, style) : docxParagraph(plainLine, { bold: boldLine, size: bodySize, line: style.lineTwips, fontEastAsia: style.fontEastAsia, fontAscii: style.fontAscii, firstLine: boldLine ? 0 : 560, spacingBefore: boldLine ? 80 : 0 }));
    index += 1;
  }
  return blocks.join('');
}

function docxStylesXml(settings?: DocumentExportSettings) {
  const style = resolveExportStyle(settings);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${escapeXml(style.fontAscii)}" w:hAnsi="${escapeXml(style.fontAscii)}" w:eastAsia="${escapeXml(style.fontEastAsia)}" w:cs="${escapeXml(style.fontAscii)}"/><w:sz w:val="${style.bodyHalfPoints}"/><w:szCs w:val="${style.bodyHalfPoints}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="${style.lineTwips}" w:lineRule="exact" w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="${escapeXml(style.fontAscii)}" w:hAnsi="${escapeXml(style.fontAscii)}" w:eastAsia="${escapeXml(style.fontEastAsia)}" w:cs="${escapeXml(style.fontAscii)}"/><w:sz w:val="${style.bodyHalfPoints}"/><w:szCs w:val="${style.bodyHalfPoints}"/></w:rPr><w:pPr><w:spacing w:line="${style.lineTwips}" w:lineRule="exact" w:after="120"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:rFonts w:ascii="${escapeXml(style.fontAscii)}" w:hAnsi="${escapeXml(style.fontAscii)}" w:eastAsia="${escapeXml(style.fontEastAsia)}" w:cs="${escapeXml(style.fontAscii)}"/><w:sz w:val="${style.titleHalfPoints}"/><w:szCs w:val="${style.titleHalfPoints}"/></w:rPr><w:pPr><w:spacing w:line="${style.lineTwips}" w:lineRule="exact" w:after="160"/></w:pPr></w:style></w:styles>`;
}

async function buildDocx(title: string, markdown: string, settings?: DocumentExportSettings, templatePath?: string) {
  const contentXml = markdownToDocxXml(markdown, settings);
  if (templatePath && fs.existsSync(templatePath)) {
    const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
    const documentFile = zip.file('word/document.xml');
    if (documentFile) {
      const xml = await documentFile.async('string');
      zip.file('word/document.xml', xml.replace(/\{\{title\}\}/gu, escapeXml(title)).replace(/\{\{content\}\}/gu, contentXml));
      zip.file('word/styles.xml', docxStylesXml(settings));
      const relsPath = 'word/_rels/document.xml.rels';
      const relsFile = zip.file(relsPath);
      if (relsFile) {
        const rels = await relsFile.async('string');
        if (!rels.includes('officeDocument/2006/relationships/styles')) {
          zip.file(relsPath, rels.replace('</Relationships>', '<Relationship Id="rStyle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'));
        }
      } else {
        zip.folder('word')?.folder('_rels')?.file('document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
      }
      const contentTypesFile = zip.file('[Content_Types].xml');
      if (contentTypesFile) {
        const contentTypes = await contentTypesFile.async('string');
        if (!contentTypes.includes('/word/styles.xml')) {
          zip.file('[Content_Types].xml', contentTypes.replace('</Types>', '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'));
        }
      }
      return zip.generateAsync({ type: 'nodebuffer' });
    }
  }
  const page = settings?.page || {};
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.folder('_rels')?.file('.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.folder('_rels')?.file('document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.folder('word')?.file('styles.xml', docxStylesXml(settings));
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${contentXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${lengthToTwips(page.marginTop, 2.5)}" w:right="${lengthToTwips(page.marginRight, 2)}" w:bottom="${lengthToTwips(page.marginBottom, 2)}" w:left="${lengthToTwips(page.marginLeft, 2)}"/></w:sectPr></w:body></w:document>`);
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
  const fontFamily = cssValue(typography.fontFamily, 'SimSun, 宋体, serif');
  const lineHeight = pointsCss(typography.lineHeight, 22);
  const titleSize = pointsCss(typography.titleSize, 16);
  const bodySize = pointsCss(typography.bodySize, 14);
  return { paper, marginTop, marginRight, marginBottom, marginLeft, fontFamily, lineHeight, titleSize, bodySize };
}

function enhanceTocHtml(body: string) {
  return body.replace(/(<h2[^>]*>\s*目录\s*<\/h2>)([\s\S]*?)(<div class="page-break"><\/div>)/u, (_match, heading: string, content: string, pageBreak: string) => {
    const normalized = content.replace(/<ol>\s*([\s\S]*?)\s*<\/ol>/u, (_ol, listContent: string) => listContent)
      .replace(/<li>\s*([^<]+?)\s*<\/li>/gu, '<p>$1</p>')
      .replace(/<p>(?:\s|&nbsp;|&#160;)*(\d+\.\d+\s+[^<]+)<\/p>/giu, '<p class="toc-section">$1</p>')
      .replace(/<p>(?!(?:\s|&nbsp;|&#160;)*<\/p>|(?:\s|&nbsp;|&#160;)*\d+\.\d+\s)([\s\S]*?)<\/p>/giu, '<p class="toc-chapter">$1</p>');
    return `<section class="document-toc">${heading}${normalized}</section>${pageBreak}`;
  });
}

function htmlShell(title: string, body: string, settings?: DocumentExportSettings) {
  const style = resolveExportStyle(settings);
  const enhancedBody = enhanceTocHtml(body);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>@page{size:${style.paper};margin:${style.marginTop} ${style.marginRight} ${style.marginBottom} ${style.marginLeft}}html,body{margin:0;padding:0}body,p,div,li,td,th,span,section,article{font-family:${style.fontFamily};font-size:${style.bodyCss};line-height:${style.lineCss};color:#111827}body{font-variant-east-asian:normal;text-rendering:geometricPrecision}p{margin:0 0 8pt 0;text-align:justify;text-justify:inter-ideograph;text-indent:2em}strong{font-weight:700}ul,ol{margin:0 0 8pt 2em;padding:0}li{margin:0 0 4pt 0;text-align:justify}h1,h2,h3,h4{font-family:${style.fontFamily};line-height:${style.lineCss};font-weight:700;color:#111827;page-break-after:avoid;break-after:avoid}h1{text-align:center;font-size:${Math.max(style.titlePt + 6, 22)}pt;margin:90pt 0 28pt 0}h2{text-align:center;font-size:${Math.max(style.titlePt + 2, 18)}pt;border:0;padding:0;margin:26pt 0 16pt 0}h3{font-size:${style.titleCss};margin:18pt 0 8pt 0}h4{font-size:${style.bodyCss};margin:12pt 0 6pt 0}.document-toc h2{text-align:center;margin-top:0}.document-toc p{margin:0 0 4pt 0;text-align:left;text-indent:0}.document-toc .toc-chapter{font-weight:700;margin-top:8pt}.document-toc .toc-section{margin-left:2em}.document-cover{min-height:calc(100vh - ${style.marginTop} - ${style.marginBottom});display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;font-size:${Math.max(style.titlePt + 8, 24)}pt;line-height:${Math.max(style.linePt + 10, 34)}pt;font-weight:700}.document-cover h1,.document-cover p{font-size:${Math.max(style.titlePt + 8, 24)}pt;line-height:${Math.max(style.linePt + 10, 34)}pt;font-weight:700;text-align:center;text-indent:0;margin:0 0 18pt 0}img{display:block;max-width:100%;max-height:520px;object-fit:contain;margin:12px auto;page-break-inside:avoid}table{width:100%;border-collapse:collapse;page-break-inside:auto;margin:10pt 0}tr{page-break-inside:avoid;page-break-after:auto}th,td{font-family:${style.fontFamily};font-size:${style.bodyCss};line-height:${style.lineCss};border:1px solid #666;padding:4pt 6pt;vertical-align:middle;text-indent:0;text-align:left}th{background:#f3f4f6;font-weight:700;text-align:center}pre{white-space:pre-wrap;font-family:${style.fontFamily};font-size:${style.bodyCss};line-height:${style.lineCss}}.page-break{page-break-after:always;break-after:page;height:0}</style></head><body>${enhancedBody}</body></html>`;
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
        const style = resolveExportStyle(settings);
        const pdf = await page.pdf({ format: style.paper as 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: style.marginTop, right: style.marginRight, bottom: style.marginBottom, left: style.marginLeft }, displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: `<div style="font-family:${style.fontFamily};font-size:10.5pt;line-height:12pt;width:100%;text-align:center;color:#666;">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>` });
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
    const rawMarkdown = body.useClientMarkdown && typeof body.markdown === 'string' ? body.markdown : recordMarkdown || body.markdown || '';
    const markdown = normalizeExportUnits(rawMarkdown);
    const format = body.format;
    if (!format || !['markdown', 'html', 'pdf', 'docx'].includes(format)) return res.status(400).json({ error: 'INVALID_EXPORT_FORMAT', message: '请选择有效的导出格式。' });
    const exportIssues = validateExportMarkdown(markdown, normalizeExportUnits(record?.draft?.markdown || record?.markdown || ''));
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

export const __documentExportTest__ = { inlineLocalImages, resolveLocalImagePath, normalizeExportUnits, stripInlineMarkdown, enhanceTocHtml };

export default withApiErrorBoundary('api/documents/export', handler);
