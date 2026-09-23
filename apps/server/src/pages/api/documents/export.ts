import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { chromium as PlaywrightChromium } from 'playwright';

/** playwright chromium 启动器类型（4.55.18 SVG 光栅化复用；避免 import() 类型注解被 lint 禁止） */
type ChromiumLauncher = typeof PlaywrightChromium;
import { generatedRoot, getGeneratedDocument, updateGeneratedDocument, type ExportReport, type ExportRenderAuditReport, type GeneratedDocumentRecord } from '@/services/document-core/generatedDocumentService';
import { getProjectKbRoot, getProjectRoot } from '@/services/knowledge/kbService';
import type { DocumentExportSettings } from '@/services/document-workflow';
import type { BidCompositionSpec } from '@/services/document-workflow/bidComposition';
import type { ValidationIssue } from '@/services/document-workflow/types';
import type { SuspensionChecklist } from '@/services/document-workflow/suspensionChecklist';
import { buildSuspensionChecklist } from '@/services/document-workflow/suspensionChecklist';
import { NON_DELIVERABLE_HEADER, markNonDeliverableFilename } from '@/services/document-workflow/exportNaming';
import { sanitizeFormalMarkdown } from '@/services/document-workflow/markdownComposer';
// 4.56 L4-8 交付层剥离：判据**单源复用**生成链同名剥离器（materialResidue.*、documentIntegrityChecks.fixTocFromBody），
// 不在导出层复制任何一份判据（复制即口径分叉：链上收紧/放宽后导出层不再同步）
import { isMaterialResidueLine, stripClarificationNarrative, stripDrawingPointerPhrases, stripMaterialResidueLines } from '@/services/document-workflow/materialResidue';
import { fixTocFromBody } from '@/services/document-workflow/documentIntegrityChecks';
import { recordErrorLog } from '@/services/common/errorLogService';
import { withApiErrorBoundary } from '@/services/common/apiErrorBoundary';

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' }, responseLimit: false },
};

type ExportFormat = 'markdown' | 'html' | 'pdf' | 'docx';

/**
 * A1 导出纯渲染化（批 1 P0，根治方案改造域 A）：导出层不得再“造内容/改文字”兜底，三把刀语义分级——
 * 造内容（defaultTableHeaders 假表头）→ 检测 + enforce 阻断（无表头=结构性缺陷，报错回源修复）；
 * 文字改写（normalizePower 单位归一）→ 检测降级（归一治理属写时链 normalizeProductionText）；
 * 结构语法保障（补分隔线/列对齐/插空行/相邻表边界截断）→ 保留为渲染层操作并审计计数。
 * 渐进策略沿用 patchGuard 口径（DOCUMENT_QINGTIAN_PATCH_GUARD）：observe 默认只检测只计数（产物零回归，
 * 采集误报分布）→ 真实生成连续 2 轮零误报后切 enforce。开关：DOCUMENT_EXPORT_PURE_RENDER=off|observe|enforce。
 */
type ExportPureRenderMode = 'off' | 'observe' | 'enforce';

/** 导出层渲染审计：源层结构性缺陷（blockers）+ 非阻断提示（notices）+ 渲染层结构操作计数（ops） */
interface ExportRenderAudit {
  mode: ExportPureRenderMode;
  /** 源层结构性缺陷：enforce 阻断导出；observe 照常记录（误报采样，两种模式同词文案保证可比） */
  blockers: Array<{ code: 'bare-table' | 'orphan-separator' | 'content-not-conserved' | 'declared-rewrite-unregistered' | 'declared-rewrite-overreach'; line: number; message: string }>;
  /** 非阻断提示（如单位书写残留——治理在源层/写时链，不在导出层改写；声明改写与目录对账的证据链同列） */
  notices: Array<{ code: 'unit-notation' | 'declared-rewrite' | 'fabricated-header' | 'headerless-table' | 'docx-stage' | 'toc-reconcile'; message: string }>;
  /** 渲染层结构操作计数（不改变文字内容，供守恒断言与事实审计） */
  ops: {
    tableSeparatorAdded: number;
    tableCellAligned: number;
    tableBoundarySplit: number;
    inlineSeparatorStripped: number;
    paragraphBreakInserted: number;
    unitRewrite: number;
    /** 4.56 L4-8 导出链声明剥离计数（与生成链剥离器同源判据，逐处登记） */
    declaredStrip: number;
    /** 4.56 L4-7 静态目录按正文重建次数（生成链 fixTocFromBody 同一判据） */
    tocRebuilt: number;
    /** 4.56 L4-4 docx 阶段按数据行渲染的无表头表格数（不冒充表头） */
    headerlessTableRendered: number;
    /** 4.56 L4-5 docx 阶段按表题样式渲染的行数 */
    captionStyled: number;
  };
}

function exportPureRenderMode(): ExportPureRenderMode {
  const raw = (process.env.DOCUMENT_EXPORT_PURE_RENDER || 'observe').trim().toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'false') return 'off';
  if (raw === 'enforce') return 'enforce';
  return 'observe';
}

function createExportRenderAudit(mode: ExportPureRenderMode = exportPureRenderMode()): ExportRenderAudit {
  return {
    mode,
    blockers: [],
    notices: [],
    ops: {
      tableSeparatorAdded: 0, tableCellAligned: 0, tableBoundarySplit: 0, inlineSeparatorStripped: 0, paragraphBreakInserted: 0, unitRewrite: 0,
      declaredStrip: 0, tocRebuilt: 0, headerlessTableRendered: 0, captionStyled: 0,
    },
  };
}

/** 审计摘要：响应头 X-Export-Render-Audit 与 exportReports 归档共用同一形状，禁止两处口径分叉 */
function exportRenderAuditReport(audit: ExportRenderAudit): ExportRenderAuditReport {
  return {
    mode: audit.mode,
    blockerCount: audit.blockers.length,
    blockerCodes: [...new Set(audit.blockers.map(item => item.line > 0 ? `${item.code}@L${item.line}` : item.code))].slice(0, 20),
    notices: audit.notices.map(item => item.message).slice(0, 10),
    ops: { ...audit.ops },
    opsTotal: Object.values(audit.ops).reduce((sum, value) => sum + value, 0),
  };
}

/** 将文件名中的非法字符替换为连字符，限制长度 80 字符 */
function safeFileName(input: string) {
  return input.replace(/[\\/:*?"<>|]/gu, '-').slice(0, 80) || 'document';
}

/** 转义 XML 特殊字符 */
function escapeXml(input: string) {
  return input.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

const execFileAsync = promisify(execFile);
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INLINE_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

/** 根据文件扩展名获取 MIME 类型 */
function imageMime(filePath: string) {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || '';
}

/** 检查文件路径是否在指定根目录之内（防止路径穿越） */
function isInsidePath(filePath: string, root: string) {
  const relative = path.relative(root, filePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

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
  const knowledgeRoot = path.resolve(getProjectKbRoot(projectRoot));
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

function isMarkdownTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line.trim());
}

function looksLikeMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed || /^#{1,6}\s+/u.test(trimmed) || isMarkdownTableSeparator(trimmed)) return false;
  const pipeCount = (trimmed.match(/(?<!\\)\|/gu) || []).length;
  return pipeCount >= 1;
}

function splitMarkdownTableRow(line: string) {
  const trimmed = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').trim();
  return trimmed.split(/(?<!\\)\|/u).map(cell => cell.replace(/\\\|/gu, '|').trim());
}

function normalizeMarkdownTableRow(cells: string[], columns: number) {
  const normalized = cells.slice(0, columns);
  if (cells.length > columns && columns > 0) normalized[columns - 1] = [normalized[columns - 1], ...cells.slice(columns)].filter(Boolean).join(' | ');
  while (normalized.length < columns) normalized.push('');
  return `| ${normalized.map(cell => cell.replace(/\|/gu, '\\|')).join(' | ')} |`;
}

/** 列对齐（渲染层结构操作）：规整数据行到目标列数（超列合并/缺列补空，文字不丢）；仅单元格数量被调整时计审计 */
function normalizeTableRowAligned(cells: string[], columns: number, audit?: ExportRenderAudit) {
  if (audit && audit.mode !== 'off' && cells.length !== columns) audit.ops.tableCellAligned += 1;
  return normalizeMarkdownTableRow(cells, columns);
}

/** 假表头生成（observe/off 沿用历史行为；enforce 禁用——导出层不得造内容，缺表头=结构性缺陷回源修复） */
function defaultTableHeaders(columns: number) {
  if (columns === 2) return ['信息项', '内容'];
  const headers = ['控制项目', '控制内容', '执行要求', '责任主体', '检查与验收', '备注'];
  return Array.from({ length: columns }, (_item, index) => headers[index] || `补充说明${index + 1}`);
}

/**
 * 4.56 L4-3 **补造表头的可辨识记号**。
 *
 * 原缺陷：`defaultTableHeaders` 补的「信息项 | 内容」与写时链口径**逐字一致**——`chapterGeneration` 的
 * 写作规则规定项目基本信息表必须使用固定表头「| 信息项 | 内容 |」，`qualityValidation`（基础信息表识别）
 * 与 `fixers.fixDuplicateBasicInfoTables` 也以该表头为判据（grep 证据：`信息项` 命中链上 3 处）——
 * 故交付物里的一行「| 信息项 | 内容 |」**无法判断是作者写的还是导出层造的**，审计只能整份存疑。
 *
 * 现口径：公式化补造的表头行所在表格**必须自带导出层记号**——分隔线取 GFM 左对齐形态 `| :--- | :--- |`。
 * 该形态是合法分隔线（`isMarkdownTableSeparator` 命中、marked 正常渲染成表），且视觉零回归：
 * docx 渲染层不输出分隔线；HTML 侧 `th{text-align:center}`/`td{text-align:left}` 由样式表决定，
 * 与 `:---` 的左对齐声明一致。作者表格（本文件重排体）恒为 `| --- | --- |`，故记号即「造假位点」的
 * 机器可读定位；补造的**表头原文**同时登记进审计（notices.fabricated-header + blocker 文案逐字给出），
 * 与 L4-1 模板告警同一「不得静默」口径。
 */
const FABRICATED_TABLE_SEPARATOR_CELL = ':---';

/** 补造表格分隔线（与记号常量同一来源，勿私造第二份） */
function fabricatedTableSeparatorRow(columns: number) {
  return `| ${Array.from({ length: columns }, () => FABRICATED_TABLE_SEPARATOR_CELL).join(' | ')} |`;
}

/** 补造记号判定：全单元格为左对齐形态（作者表格重排体恒为 `---`，故仅补造表格命中） */
function isFabricatedTableSeparator(line: string) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every(cell => cell === FABRICATED_TABLE_SEPARATOR_CELL);
}

/** 补造表头登记（审计证据：补造了什么、补在哪一行、所在列数）——observe/off 补造时必须调用 */
function recordFabricatedHeader(tableLine: number, headers: string[], columns: number, mode: ExportPureRenderMode, audit?: ExportRenderAudit) {
  if (!audit || audit.mode === 'off') return;
  audit.notices.push({
    code: 'fabricated-header',
    message: `导出层补造表头（非作者原文，仅 ${mode} 模式补造）：第 ${tableLine} 行「${headers.join(' | ')}」（${columns} 列）——原表无表头，回源补齐后该补造行即消失`,
  });
}

function collectBareTableRows(lines: string[], start: number) {
  const rows: string[] = [];
  let index = start;
  while (index < lines.length && looksLikeMarkdownTableRow(lines[index] || '')) {
    rows.push(lines[index] || '');
    index += 1;
  }
  const columnCounts = rows.map(row => splitMarkdownTableRow(row).length);
  const columns = Math.max(...columnCounts, 0);
  if (rows.length < 2 || columns < 2) return null;
  return { rows, columns, next: index };
}

function collectLooseTableRows(lines: string[], start: number) {
  const rows: string[] = [];
  let index = start;
  while (index < lines.length && looksLikeMarkdownTableRow(lines[index] || '')) {
    rows.push(lines[index] || '');
    index += 1;
  }
  return { rows, next: index };
}

/** 相邻表格边界判定：当前行是“新表头”（下一行是分隔线，允许中间一个空行）时，
 * 说明上一张表格的数据区已经结束——丰乐镇实测：两张列数不同的表格无空行紧邻时，
 * 前表的数据区扫描会把后表表头吞成数据行，前表列数被拉大后整表补出空列，后表则因
 * 表头丢失被当成裸表补出假表头（“控制项目…补充说明7”）；这里在边界处截断。 */
function startsFollowingTable(lines: string[], at: number) {
  const next = lines[at + 1]?.trim() === '' ? lines[at + 2] : lines[at + 1];
  return isMarkdownTableSeparator((next || '').trim());
}

function normalizeLooseMarkdownTables(input: string, audit?: ExportRenderAudit) {
  const lines = input.replace(/\r?\n/gu, '\n').split('\n');
  const output: string[] = [];
  // 审计三态：off 零开销（与历史行为逐字一致）；observe/enforce 记录缺陷与结构操作
  const enforce = audit?.mode === 'enforce';
  const ops = audit && audit.mode !== 'off' ? audit.ops : null;
  const blockers = audit && audit.mode !== 'off' ? audit.blockers : null;
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    const compactLine = line.replace(/([^|\n])\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u, '$1');
    if (ops && compactLine !== line) ops.inlineSeparatorStripped += 1;
    const nextIndex = lines[index + 1]?.trim() === '' ? index + 2 : index + 1;
    const separator = lines[nextIndex];
    if (looksLikeMarkdownTableRow(line) && separator !== undefined && isMarkdownTableSeparator(separator)) {
      const header = splitMarkdownTableRow(line);
      const separatorColumns = splitMarkdownTableRow(separator).length;
      const dataRows: string[][] = [];
      let scanIndex = nextIndex + 1;
      while (scanIndex < lines.length) {
        const row = lines[scanIndex] || '';
        if (!looksLikeMarkdownTableRow(row)) break;
        if (startsFollowingTable(lines, scanIndex)) break;
        dataRows.push(splitMarkdownTableRow(row));
        scanIndex += 1;
      }
      const columns = Math.max(2, header.length, separatorColumns, ...dataRows.map(row => row.length));
      if (output.length > 0 && output[output.length - 1]?.trim()) output.push('');
      output.push(normalizeTableRowAligned(header, columns, audit));
      // L4-3 幂等：已有补造记号的表格再归一后记号仍在（否则第二次归一即丢掉「导出层造」的证据）
      output.push(isFabricatedTableSeparator(separator) ? fabricatedTableSeparatorRow(columns) : `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`);
      index = nextIndex + 1;
      while (index < lines.length) {
        const row = lines[index] || '';
        if (!looksLikeMarkdownTableRow(row)) break;
        if (startsFollowingTable(lines, index)) {
          // 相邻表边界截断（结构操作计数）：下一行是「表头+分隔线」形态的新表，当前表数据区在此结束
          if (ops) ops.tableBoundarySplit += 1;
          break;
        }
        output.push(normalizeTableRowAligned(splitMarkdownTableRow(row), columns, audit));
        index += 1;
      }
      if (index < lines.length && lines[index]?.trim()) output.push('');
      continue;
    }
    const bare = looksLikeMarkdownTableRow(line) ? collectBareTableRows(lines, index) : null;
    if (bare) {
      // 无表头裸表格=源层结构性缺陷：observe 采样记录并沿用历史补表头（产物零回归）；enforce 不造内容改阻断
      const bareHeaders = defaultTableHeaders(bare.columns);
      blockers?.push({
        code: 'bare-table',
        line: index + 1,
        message: enforce
          ? `第 ${index + 1} 行起为无表头裸表格（${bare.rows.length} 行 × ${bare.columns} 列）：导出层不补造表头，需回源补齐表头后导出`
          // L4-3：observe/off 实际会补造表头——文案必须与实际行为一致，并逐字给出补造原文
          : `第 ${index + 1} 行起为无表头裸表格（${bare.rows.length} 行 × ${bare.columns} 列）：环境为 ${audit?.mode ?? exportPureRenderMode()}，导出层补造表头「${bareHeaders.join(' | ')}」并以 ${FABRICATED_TABLE_SEPARATOR_CELL} 左对齐分隔线标注（非作者原文），需回源补齐表头后导出`,
      });
      if (enforce) {
        for (const row of bare.rows) output.push(row);
        index = bare.next;
        continue;
      }
      if (output.length > 0 && output[output.length - 1]?.trim()) output.push('');
      output.push(normalizeMarkdownTableRow(bareHeaders, bare.columns));
      output.push(fabricatedTableSeparatorRow(bare.columns));
      recordFabricatedHeader(index + 1, bareHeaders, bare.columns, audit?.mode ?? exportPureRenderMode(), audit);
      if (ops) ops.tableSeparatorAdded += 1;
      for (const row of bare.rows) output.push(normalizeTableRowAligned(splitMarkdownTableRow(row), bare.columns, audit));
      index = bare.next;
      if (index < lines.length && lines[index]?.trim()) output.push('');
      continue;
    }
    if (isMarkdownTableSeparator(line)) {
      const loose = collectLooseTableRows(lines, index + 1);
      if (loose.rows.length > 0) {
        const columns = Math.max(2, splitMarkdownTableRow(line).length, ...loose.rows.map(row => splitMarkdownTableRow(row).length));
        // 孤立分隔线（无表头）=源层结构性缺陷：与裸表同口径处置
        const looseHeaders = defaultTableHeaders(columns);
        blockers?.push({
          code: 'orphan-separator',
          line: index + 1,
          message: enforce
            ? `第 ${index + 1} 行为无表头的孤立分隔线（后续 ${loose.rows.length} 行表格数据）：导出层不补造表头，需回源补齐表头后导出`
            : `第 ${index + 1} 行为无表头的孤立分隔线（后续 ${loose.rows.length} 行表格数据）：环境为 ${audit?.mode ?? exportPureRenderMode()}，导出层补造表头「${looseHeaders.join(' | ')}」并以 ${FABRICATED_TABLE_SEPARATOR_CELL} 左对齐分隔线标注（非作者原文），需回源补齐表头后导出`,
        });
        if (enforce) {
          output.push(line);
          for (const row of loose.rows) output.push(row);
          index = loose.next;
          continue;
        }
        if (output.length > 0 && output[output.length - 1]?.trim()) output.push('');
        output.push(normalizeMarkdownTableRow(looseHeaders, columns));
        output.push(fabricatedTableSeparatorRow(columns));
        recordFabricatedHeader(index + 1, looseHeaders, columns, audit?.mode ?? exportPureRenderMode(), audit);
        if (ops) ops.tableSeparatorAdded += 1;
        for (const row of loose.rows) output.push(normalizeTableRowAligned(splitMarkdownTableRow(row), columns, audit));
        index = loose.next;
        if (index < lines.length && lines[index]?.trim()) output.push('');
        continue;
      }
    }
    output.push(compactLine);
    index += 1;
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n');
}

/**
 * 结构性行形态（标题 / 表格行 / 列表项 / 代码围栏 / HTML 块 / 分页标记）：
 * 段落规范化（本层结构操作）与导出链声明剥离（L4-8 散文区作用域）**共用同一判据**——
 * 结构行是编号化/定位化的信息载体，不得被段落拆分，也不得被剥离改写。
 */
const STRUCTURAL_LINE_RE = /^(?:#{1,6}\s|\||[-*+]\s|\d+[.、]\s|```|<div|\[\[PAGE)/u;

/** 智能段落规范化（渲染层结构操作）：单换行分隔的连续文本行转双换行段落防粘连，插入数计入审计 */
function normalizeParagraphs(input: string, audit?: ExportRenderAudit): string {
  const lines = input.split('\n');
  const out: string[] = [];
  const ops = audit && audit.mode !== 'off' ? audit.ops : null;
  let consecutiveText = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    const trimmed = line.trim();

    // 空行、标题、表格、列表、代码块 → 保持原样，重置连续文本计数
    if (!trimmed || STRUCTURAL_LINE_RE.test(trimmed)) {
      if (consecutiveText > 1) {
        if (ops) ops.paragraphBreakInserted += 1;
        out.push(''); // 在连续文本块后补一个空行
      }
      out.push(line);
      consecutiveText = 0;
      continue;
    }

    consecutiveText += 1;

    // 连续文本行之间：如果上一行以句号/分号结尾，且本行不是续句，插入空行
    if (consecutiveText > 1) {
      const prevLine = (out[out.length - 1] || '').trim();
      const PARAGRAPH_START_RE = /^(?:根据|依据|按照|针对|对于|关于|同时|此外|另外|因此|所以|但是|然而|并且|而且|以及|或者|一是|二是|三是|步骤\d|第[\d一二三四五六七八九十]+[步条])/u;
      const prevEnds = /[。；）)」』]$/u.test(prevLine);
      const thisStarts = /^[（(「『\d]/u.test(trimmed) || PARAGRAPH_START_RE.test(trimmed);
      if (prevEnds || thisStarts) {
        out.push('');
        if (ops) ops.paragraphBreakInserted += 1;
        consecutiveText = 1;
      }
    }

    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/gu, '\n\n');
}

/**
 * 单位上标化规则表（A1：与历史 normalizePower 逐条同源，检测/改写/计数共用同一份，禁止私造第二份）：
 * [匹配模式, 替换值]——顺序即替换顺序。
 */
const UNIT_REWRITE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/m\s*<sup>\s*2\s*<\/sup>/giu, 'm²'],
  [/m\s*<sup>\s*3\s*<\/sup>/giu, 'm³'],
  [/m\s*\^\s*2/giu, 'm²'],
  [/m\s*\^\s*3/giu, 'm³'],
  [/㎡/gu, 'm²'],
  [/㎥/gu, 'm³'],
  // 上标化边界：数字前缀形态（100m2）含大写 M 视为单位；裸形态仅匹配小写 m——无数字前缀的
  // 大写「M2/M3」是编号/标号（里程碑 M2 实测被换成「m²」），(?!\.\d) 排除 M2.5 砂浆标号
  [/(?<=\d)m\s*2(?![\p{L}\p{N}_])(?!\.\d)/giu, 'm²'],
  [/(?<=\d)m\s*3(?![\p{L}\p{N}_])(?!\.\d)/giu, 'm³'],
  [/(?<![\p{L}\p{N}_])m\s*2(?![\p{L}\p{N}_])(?!\.\d)/gu, 'm²'],
  [/(?<![\p{L}\p{N}_])m\s*3(?![\p{L}\p{N}_])(?!\.\d)/gu, 'm³'],
];

/** 单位书写残留计数（与 UNIT_REWRITE_RULES 逐条同源）：enforce 检测与 observe 改写计数共用 */
function countUnitRewriteOccurrences(value: string) {
  return UNIT_REWRITE_RULES.reduce((sum, [pattern]) => sum + (value.match(pattern)?.length || 0), 0);
}

function normalizeExportUnits(input: string, audit?: ExportRenderAudit) {
  const mode = audit?.mode || exportPureRenderMode();
  const ops = audit && audit.mode !== 'off' ? audit.ops : null;
  let text = stripMarkdownDocumentFence(input);
  if (mode === 'enforce') {
    // A1 纯渲染：导出层不再改写单位书写（归一治理属写时链 normalizeProductionText），仅检测告警
    const residual = countUnitRewriteOccurrences(text);
    if (residual > 0 && audit) audit.notices.push({ code: 'unit-notation', message: `正文存在 ${residual} 处未归一单位书写（m2/㎡/m^2 等）：导出纯渲染模式不改写，需在源文档或写时链修正` });
  } else {
    for (const [pattern, replacement] of UNIT_REWRITE_RULES) {
      const matches = text.match(pattern);
      if (!matches || matches.length === 0) continue;
      text = text.replace(pattern, replacement);
      if (ops) ops.unitRewrite += matches.length;
    }
  }
  return normalizeParagraphs(normalizeLooseMarkdownTables(text, audit), audit);
}

/**
 * 行内标记剥离（**纯渲染**：只去标记，不做任何归一/改写）。
 *
 * 4.56 L4-2 原缺陷：这里曾先跑一遍 `normalizeExportUnits(input)`（**未携带 audit**）——
 * 该函数的职责是「单位改写 + 裸表补造 + 段落归一」（写时链/归一阶段的口径），放在逐行渲染的
 * 取值函数里意味着：① 归一被 docx/html 阶段**重跑**（`prepareExportMarkdown` 已做过）；
 * ② 这一遍的改写与补造**不计审计**（ops 缺失 → 计数漏记），A2 守恒也只覆盖前一段；
 * ③ 单个单元格/标题文本被当成整篇文档跑段落归一，语义越界（行内文本没有段落结构）。
 * 现口径：本函数只去行内标记；归一由 `prepareExportMarkdown` 唯一入口完成，docx 阶段只渲染不改写
 * （越界改动由 `docxStageConservationDiff` 捕获为 blocker）。
 */
function stripInlineMarkdown(input: string) {
  return input
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`]/gu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .trim();
}

/** 4.33 中文字体 → docx 西文字体名映射（未收录时原样透传） */
function fontAsciiName(name: string) {
  const normalized = name.replace(/["'“”]/gu, '').trim();
  const map: Record<string, string> = {
    '宋体': 'SimSun',
    '仿宋': 'FangSong',
    '仿宋_GB2312': 'FangSong_GB2312',
    '黑体': 'SimHei',
    '楷体': 'KaiTi',
    '楷体_GB2312': 'KaiTi_GB2312',
    '微软雅黑': 'Microsoft YaHei',
  };
  return map[normalized] || normalized;
}

function pointsValue(value: string | undefined, fallback: number) {
  const match = /([\d.]+)\s*(pt|px)?/iu.exec(value || '');
  if (!match) return fallback;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return fallback;
  return match[2]?.toLowerCase() === 'px' ? number * 0.75 : number;
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
  const typography = settings?.typography || {};
  // 模板有配置就用模板的，没有就用默认值
  // 默认：正文宋体小四(12pt)、一级标题黑体二号(22pt)、二级黑体小三(15pt)、三级黑体四号(14pt)、1.5倍行距
  const bodyPt = typography.bodySize ? pointsValue(typography.bodySize, 12) : 12;
  const h1Pt = typography.titleSize ? pointsValue(typography.titleSize, 22) : 22;
  const h2Pt = 15;
  const h3Pt = 14;
  const linePt = typography.lineHeight ? pointsValue(typography.lineHeight, 18) : 18;
  const headingFont = typography.headingFont ? typography.headingFont : typography.fontFamily ? typography.fontFamily : '黑体';
  // 4.33 正文字体配置化（暗标常见要求：正文小三号仿宋_GB2312）：默认仍为宋体，模板可覆盖
  const bodyFont = typography.bodyFont ? typography.bodyFont : '宋体';
  return {
    ...raw,
    bodyPt, h1Pt, h2Pt, h3Pt, linePt,
    bodyHalfPoints: Math.round(bodyPt * 2),
    h1HalfPoints: Math.round(h1Pt * 2),
    h2HalfPoints: Math.round(h2Pt * 2),
    h3HalfPoints: Math.round(h3Pt * 2),
    lineTwips: Math.round(linePt * 20),
    fontHeading: headingFont,
    fontHeadingAscii: fontAsciiName(headingFont),
    fontBody: bodyFont,
    fontBodyAscii: fontAsciiName(bodyFont),
    bodyCss: `${bodyPt}pt`,
    h1Css: `${h1Pt}pt`,
    h2Css: `${h2Pt}pt`,
    h3Css: `${h3Pt}pt`,
    lineCss: `${linePt}pt`,
  };
}

type DocxParagraphOptions = {
  bold?: boolean;
  size?: number;
  align?: 'left' | 'center' | 'right' | 'both';
  spacingBefore?: number;
  spacingAfter?: number;
  pageBreak?: boolean;
  line?: number;
  fontEastAsia?: string;
  fontAscii?: string;
  indentLeft?: number;
  firstLine?: number;
  hanging?: number;
  keepNext?: boolean;
  styleId?: string;
  outlineLevel?: number;
};

type DocxImageItem = {
  relationshipId: string;
  fileName: string;
  buffer: Buffer;
  contentType: string;
  widthEmu: number;
  heightEmu: number;
  altText: string;
};

type DocxBuildContext = {
  projectRoot: string;
  images: DocxImageItem[];
  /** 4.55.18 SVG 图件预光栅化缓存（路径 → PNG；DOCX 不能内联 SVG） */
  rasterizedSvg?: Map<string, NonSharedBuffer>;
};

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

function docxParagraph(text: string, options: DocxParagraphOptions = {}) {
  if (options.pageBreak) return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const indent = [
    options.indentLeft ? `w:left="${options.indentLeft}"` : '',
    options.firstLine ? `w:firstLine="${options.firstLine}"` : '',
    options.hanging ? `w:hanging="${options.hanging}"` : '',
  ].filter(Boolean).join(' ');
  const pPr = [
    options.styleId ? `<w:pStyle w:val="${escapeXml(options.styleId)}"/>` : '',
    options.keepNext ? '<w:keepNext/>' : '',
    `<w:spacing w:line="${options.line ?? 440}" w:lineRule="exact" w:before="${options.spacingBefore ?? 0}" w:after="${options.spacingAfter ?? 120}"/>`,
    indent ? `<w:ind ${indent}/>` : '',
    options.align ? `<w:jc w:val="${options.align}"/>` : '',
    typeof options.outlineLevel === 'number' ? `<w:outlineLvl w:val="${options.outlineLevel}"/>` : '',
  ].filter(Boolean).join('');
  return `<w:p><w:pPr>${pPr}</w:pPr>${docxRun(text, options)}</w:p>`;
}

function imageSizePixels(buffer: Buffer, contentType: string) {
  if (contentType === 'image/png' && buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (contentType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      offset += 2 + length;
    }
  }
  return { width: 640, height: 360 };
}

function docxImageParagraph(image: DocxImageItem) {
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${image.widthEmu}" cy="${image.heightEmu}"/><wp:docPr id="${image.relationshipId.replace(/\D/gu, '') || '1'}" name="${escapeXml(image.altText || image.fileName)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${escapeXml(image.fileName)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${image.relationshipId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${image.widthEmu}" cy="${image.heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function docxImageFromMarkdown(line: string, context: DocxBuildContext) {
  const match = /!\[([^\]]*)\]\(([^)]+)\)/u.exec(line);
  if (!match) return null;
  const localPath = resolveLocalImagePath(match[2].trim(), context.projectRoot);
  if (!localPath) return null;
  let buffer = fs.readFileSync(localPath);
  let contentType = imageMime(localPath);
  // 4.55.18 SVG 图件：预光栅化结果优先（旧实现直接跳过 SVG，图位导出后只剩字符）
  if (contentType === 'image/svg+xml') {
    const rasterized = context.rasterizedSvg?.get(localPath);
    if (!rasterized) return null;
    buffer = rasterized;
    contentType = 'image/png';
  }
  if (!contentType || buffer.length > MAX_INLINE_IMAGE_BYTES) return null;
  const imageNumber = context.images.length + 1;
  const ext = contentType === 'image/png' ? '.png' : (path.extname(localPath).toLowerCase() || '.png');
  const size = imageSizePixels(buffer, contentType);
  const maxWidthPx = 620;
  const scale = Math.min(1, maxWidthPx / Math.max(size.width, 1));
  const widthEmu = Math.round(size.width * scale * 9525);
  const heightEmu = Math.round(size.height * scale * 9525);
  const image: DocxImageItem = { relationshipId: `rImage${imageNumber}`, fileName: `image${imageNumber}${ext}`, buffer, contentType, widthEmu, heightEmu, altText: match[1] || `image${imageNumber}` };
  context.images.push(image);
  return image;
}

/**
 * 4.56 L4-4 **表头行形态判据**（机制化，无内容白名单）：全单元格为**短标签**——非空、≤12 字、
 * 不含数字（表头不会用数字承载数据）、不以句读收尾。「表头行」与「数据行」的区分据此：
 * markdown 语法（分隔线上一行）只说明「哪一行被渲染成表头」，不说明该行**是不是**表头；
 * 首行本是数据行（含数值/单位/长句）时不得无条件套灰底加粗居中。
 */
const HEADER_CELL_MAX_CHARS = 12;
function looksLikeHeaderRow(cells: string[]) {
  if (cells.length === 0) return false;
  return cells.every(cell => {
    const trimmed = cell.trim();
    if (!trimmed || trimmed.length > HEADER_CELL_MAX_CHARS) return false;
    if (/\d/u.test(trimmed)) return false;
    return !/[。；;，,、.]$/u.test(trimmed);
  });
}

function parseMarkdownTable(lines: string[], start: number) {
  const separatorIndex = lines[start + 1]?.trim() === '' ? start + 2 : start + 1;
  if (separatorIndex >= lines.length || !looksLikeMarkdownTableRow(lines[start] || '') || !isMarkdownTableSeparator(lines[separatorIndex] || '')) return null;
  const header = splitMarkdownTableRow(lines[start] || '').map(cell => stripInlineMarkdown(cell));
  const separatorColumns = splitMarkdownTableRow(lines[separatorIndex] || '').length;
  const dataRows: string[][] = [];
  let index = separatorIndex + 1;
  while (index < lines.length && looksLikeMarkdownTableRow(lines[index] || '')) {
    dataRows.push(splitMarkdownTableRow(lines[index] || '').map(cell => stripInlineMarkdown(cell)));
    index += 1;
  }
  const columns = Math.max(2, header.length, separatorColumns, ...dataRows.map(row => row.length));
  const normalize = (row: string[]) => {
    const normalized = row.slice(0, columns);
    if (row.length > columns && columns > 0) normalized[columns - 1] = [normalized[columns - 1], ...row.slice(columns)].filter(Boolean).join(' | ');
    while (normalized.length < columns) normalized.push('');
    return normalized;
  };
  // L4-4：首行是否按表头渲染由形态判据裁决（原实现 rowIndex===0 无条件当表头）
  return { rows: [normalize(header), ...dataRows.map(normalize)], next: index, headerRow: looksLikeHeaderRow(header) };
}

/** docx 表格渲染：`headerRow` 显式传入（不再由行下标隐式决定是否表头） */
function docxTable(rows: string[][], style: ReturnType<typeof resolveExportStyle>, headerRow: boolean) {
  const maxColumns = Math.max(1, ...rows.map(row => row.length));
  const tableWidth = 9638;
  const baseColumnWidth = Math.floor(tableWidth / maxColumns);
  const columnWidths = Array.from({ length: maxColumns }, (_item, index) => index === maxColumns - 1 ? tableWidth - baseColumnWidth * (maxColumns - 1) : baseColumnWidth);
  const grid = `<w:tblGrid>${columnWidths.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
  const cells = (row: string[], rowIndex: number) => columnWidths.map((width, columnIndex) => {
    const cell = row[columnIndex] || '';
    const asHeader = headerRow && rowIndex === 0;
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>${asHeader ? '<w:shd w:val="clear" w:fill="F3F4F6"/>' : ''}</w:tcPr>${docxParagraph(cell, { bold: asHeader, size: style.bodyHalfPoints, line: style.lineTwips, fontEastAsia: style.fontBody, fontAscii: style.fontBodyAscii, spacingAfter: 0, align: asHeader ? 'center' : 'left' })}</w:tc>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${tableWidth}" w:type="dxa"/><w:tblLook w:firstRow="${headerRow ? 1 : 0}" w:noHBand="0"/><w:tblBorders><w:top w:val="single" w:sz="6" w:color="666666"/><w:left w:val="single" w:sz="6" w:color="666666"/><w:bottom w:val="single" w:sz="6" w:color="666666"/><w:right w:val="single" w:sz="6" w:color="666666"/><w:insideH w:val="single" w:sz="4" w:color="666666"/><w:insideV w:val="single" w:sz="4" w:color="666666"/></w:tblBorders></w:tblPr>${grid}${rows.map((row, rowIndex) => `<w:tr>${cells(row, rowIndex)}</w:tr>`).join('')}</w:tbl>`;
}

/**
 * 4.56 L4-5 **表题行样式判据**（机制化）：`表` + 编号（阿拉伯/中文序号，允许 `3-1`/`3.1` 形态）+ 标题文字，
 * 且**紧邻表格**（下一非空行即表格行，或上一块刚渲染完表格）——表题只在表格上下文成立，
 * 正文里出现的「表…」句不命中（编号形态 + 邻接双闸）。
 */
const TABLE_CAPTION_RE = /^表\s*(?:[\d一二三四五六七八九十百]+(?:[.．\-—–]\d+)*)\s*[、.．:：]?\s*\S/u;
const TABLE_CAPTION_MAX_CHARS = 60;
function isTableCaptionLine(line: string) {
  const trimmed = line.trim();
  return trimmed.length > 1 && trimmed.length <= TABLE_CAPTION_MAX_CHARS
    && TABLE_CAPTION_RE.test(trimmed)
    && !trimmed.startsWith('|') && !/^#/u.test(trimmed);
}

function isTocSectionLine(line: string) {
  return /^\s*\d+\.\d+\s+\S/u.test(line);
}

/** 目录域占位文案（域结果为空时的可见提示；TOC 域缓存非空时由静态条目充当域结果，见 L4-6） */
const DOCX_TOC_FIELD_PLACEHOLDER = '请在 Word 中右键更新目录';

/** 目录域起始段（begin + 域指令 + separate）：域结果的后续段落即「缓存目录」 */
function docxTocFieldOpen(style: ReturnType<typeof resolveExportStyle>) {
  return `<w:p><w:pPr><w:spacing w:line="${style.lineTwips}" w:lineRule="exact" w:after="120"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">TOC \\o &quot;1-3&quot; \\h \\z \\u</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>`;
}

/** 无静态条目（或目录区只有标题）时的单段域：占位文案即域结果 */
function docxTocFieldPlaceholderParagraph(style: ReturnType<typeof resolveExportStyle>) {
  return docxTocFieldOpen(style).replace('</w:p>', `<w:r><w:t>${DOCX_TOC_FIELD_PLACEHOLDER}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`);
}

/** 目录域收口：域结束标记落在最后一个缓存条目段内（Word 更新域时整段域结果被重算覆盖） */
function docxTocFieldClose(paragraphXml: string) {
  return paragraphXml.replace(/<\/w:p>$/u, '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
}

function docxTocParagraph(line: string, style: ReturnType<typeof resolveExportStyle>) {
  const sectionLine = isTocSectionLine(line);
  return docxParagraph(stripInlineMarkdown(line), { bold: !sectionLine, size: style.bodyHalfPoints, line: style.lineTwips, fontEastAsia: style.fontBody, fontAscii: style.fontBodyAscii, spacingAfter: sectionLine ? 30 : 80, indentLeft: sectionLine ? 420 : 0, align: 'left' });
}

/** 表题段（L4-5）：加粗 + 居中 + 零首行缩进 + keepNext（与随后表格同页）；
 *  不设 outline level——章节目录只收标题，表题不进目录（图表目录是另一条独立域） */
function docxTableCaptionParagraph(text: string, style: ReturnType<typeof resolveExportStyle>) {
  return docxParagraph(text, { bold: true, size: style.bodyHalfPoints, line: style.lineTwips, fontEastAsia: style.fontHeading, fontAscii: style.fontHeadingAscii, align: 'center', firstLine: 0, spacingBefore: 120, spacingAfter: 60, keepNext: true });
}

function docxHeadingParagraph(level: number, text: string, style: ReturnType<typeof resolveExportStyle>) {
  if (level === 2) return docxParagraph(text, { styleId: 'Heading1', outlineLevel: 0, bold: true, size: style.h1HalfPoints, line: style.lineTwips, fontEastAsia: style.fontHeading, fontAscii: style.fontHeadingAscii, align: 'center', spacingBefore: 260, spacingAfter: 180, keepNext: true });
  if (level === 3) return docxParagraph(text, { styleId: 'Heading2', outlineLevel: 1, bold: true, size: style.h2HalfPoints, line: style.lineTwips, fontEastAsia: style.fontHeading, fontAscii: style.fontHeadingAscii, align: 'left', spacingBefore: 180, spacingAfter: 100, keepNext: true });
  return docxParagraph(text, { styleId: 'Heading3', outlineLevel: 2, bold: true, size: style.h3HalfPoints, line: style.lineTwips, fontEastAsia: style.fontHeading, fontAscii: style.fontHeadingAscii, align: 'left', spacingBefore: 120, spacingAfter: 80, keepNext: true });
}

function orderedListMatch(line: string) {
  const match = /^\s*(\d+(?:\.\d+){0,2})([.、])\s+(.+)$/u.exec(line);
  if (!match) return null;
  const level = Math.min(match[1].split('.').length - 1, 2);
  return { level, marker: `${match[1]}${match[2]}`, text: stripInlineMarkdown(match[3]) };
}

function unorderedListMatch(line: string) {
  const match = /^\s*[-*+]\s+(.+)$/u.exec(line);
  return match ? stripInlineMarkdown(match[1]) : null;
}

/**
 * docx 渲染（**纯渲染阶段**：只做结构 → OOXML 的映射，不再改写正文）。
 *
 * 4.56 L4-2 原缺陷：本函数与 `stripInlineMarkdown` 在**未携带 audit** 的情况下又跑了一遍
 * `normalizeExportUnits` —— 于是 `prepareExportMarkdown` 完成的归一被**重跑一次**（单位改写、
 * 假表头补造/detect 全部再执行），且这一遍**不计审计**：响应头与导出报告的 ops/blockers 只反映
 * 第一遍；A2 守恒断言也只覆盖 `prepareExportMarkdown` 一段，docx 阶段改了什么看不到。
 * 现口径：docx 阶段**只渲染不改写**——
 * ① 不再二次归一（入口文本即 `prepareExportMarkdown` 产物），归一不动点与产物文本守恒双重复核：
 *    · 收支复核：入口若非归一不动点（绕过 API 直调 buildDocx）→ notice（按原样渲染，不改写）；
 *    · **产物守恒复核**：渲染产物 XML 的可见文本（`<w:t>`）去标记后必须与入口文本逐字一致
 *      —— 任何在 docx 阶段发生的正文改动（改写/注入/丢失）都在此被捕获为 blocker。
 * ② 审计贯通：docx 阶段的计数（无表头表格/表题/目录）与违规写入同一 audit（响应头 + 导出报告归档）。
 */
function markdownToDocxXml(markdown: string, settings?: DocumentExportSettings, context?: DocxBuildContext, audit?: ExportRenderAudit) {
  const style = resolveExportStyle(settings);
  const h1Size = style.h1HalfPoints;
  const bodySize = style.bodyHalfPoints;
  // L4-2：入口文本原样使用（纯渲染）；不动点仅做**检测**（不采用归一结果，避免二次改写与双重计数）
  const normalizedMarkdown = markdown;
  if (audit && audit.mode !== 'off') {
    // 探针恒用 observe：探针问的是「归一阶段会不会改动这段文本」，与当前模式无关（enforce 不改写，
    // 拿 enforce 探不出入口是否已归一）。探针 audit 是丢弃对象，计数不进真实 audit（无双计）。
    const probeAudit = createExportRenderAudit('observe');
    const probe = normalizeExportUnits(markdown, probeAudit);
    const probeDiff = probe === markdown ? null : exportConservationDiff(markdown, probe);
    // 只报**内容级**差异：纯结构差异（空行/表格对齐/目录重建后的行距）对渲染文本无影响，
    // 报出来只是噪声（目录经 fixTocFromBody 重建后本就不是 normalizeExportUnits 的不动点）。
    if (probeDiff && !probeDiff.conserved) {
      audit.notices.push({
        code: 'docx-stage',
        message: `docx 阶段入口存在未归一的内容差异（第 ${probeDiff.position} 字符附近「${probeDiff.sourceContext}」→「${probeDiff.productContext}」）：本阶段不再二次归一，按入口文本原样渲染；归一入口应为 prepareExportMarkdown 产物`,
      });
    }
  }
  const lines = normalizedMarkdown.replace(/<div class="page-break"><\/div>/gu, '\n[[PAGE_BREAK]]\n').split('\n');
  const blocks: string[] = [];
  let inToc = false;
  let inCover = false;
  // L4-6 目录区收口：目录静态条目作为 TOC 域**缓存结果**（begin/separate … 条目 … end）整体产出，
  // 使「在 Word 中更新目录」重算域结果时把条目一并替换，不再新旧两份目录并存
  let tocRegionStart = -1;
  const closeTocRegion = () => {
    if (tocRegionStart < 0) return;
    const entries = blocks.splice(tocRegionStart);
    tocRegionStart = -1;
    if (entries.length === 0) {
      blocks.push(docxTocFieldPlaceholderParagraph(style));
      return;
    }
    blocks.push(docxTocFieldOpen(style));
    entries.forEach((entry, entryIndex) => blocks.push(entryIndex === entries.length - 1 ? docxTocFieldClose(entry) : entry));
  };
  let lastBlockWasTable = false;
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    // 目录区遇到标题/分页即为目录区结束：先收口（域结果闭合），再按新区块处理
    if (inToc && (line === '[[PAGE_BREAK]]' || /^#{1,4}\s+/u.test(line))) { closeTocRegion(); inToc = false; }
    if (/<div\s+class=["']document-cover["']\s*>/iu.test(line)) { inCover = true; index += 1; continue; }
    if (inCover && /^<\/div>$/iu.test(line)) { inCover = false; index += 1; continue; }
    if (line === '[[PAGE_BREAK]]') { inToc = false; inCover = false; closeTocRegion(); blocks.push(docxParagraph('', { pageBreak: true })); index += 1; continue; }
    if (inCover) {
      const coverText = stripInlineMarkdown(line.replace(/^#\s+/u, ''));
      if (coverText) blocks.push(docxParagraph(coverText, { bold: true, size: Math.max(h1Size + 8, 44), line: Math.round(style.lineTwips * 1.15), fontEastAsia: style.fontHeading, fontAscii: style.fontHeadingAscii, align: 'center', spacingBefore: 360, spacingAfter: 220 }));
      index += 1;
      continue;
    }
    const image = context ? docxImageFromMarkdown(line, context) : null;
    if (image) { blocks.push(docxImageParagraph(image)); index += 1; continue; }
    const table = parseMarkdownTable(lines, index);
    if (table) {
      // L4-4：是否按表头渲染由形态判据（looksLikeHeaderRow）裁决，不再由行下标无条件决定
      blocks.push(docxTable(table.rows, style, table.headerRow), docxParagraph('', { spacingAfter: 80, line: style.lineTwips }));
      lastBlockWasTable = true;
      index = table.next;
      continue;
    }
    // L4-4：无表头裸表格（无分隔线）按**数据行**渲染——判据与表格归一器共用 collectBareTableRows
    //（凡裸表都已在 prepareExportMarkdown 记为结构性缺陷）；首行不得冒充表头（灰底加粗居中）
    const bare = !inToc && looksLikeMarkdownTableRow(line) ? collectBareTableRows(lines, index) : null;
    if (bare) {
      blocks.push(docxTable(bare.rows.map(row => splitMarkdownTableRow(row).map(cell => stripInlineMarkdown(cell))), style, false), docxParagraph('', { spacingAfter: 80, line: style.lineTwips }));
      if (audit && audit.mode !== 'off') {
        audit.ops.headerlessTableRendered += 1;
        audit.notices.push({ code: 'headerless-table', message: `docx 阶段按数据行渲染无表头表格 ${bare.rows.length} 行 × ${bare.columns} 列（首行不冒充表头）：该表在源文档缺表头，需回源补齐` });
      }
      lastBlockWasTable = true;
      index = bare.next;
      continue;
    }
    if (isMarkdownTableSeparator(line)) { index += 1; continue; }
    const heading = /^(#{1,4})\s+(.+)$/u.exec(line);
    if (heading) {
      const headingText = stripInlineMarkdown(heading[2]);
      blocks.push(docxHeadingParagraph(heading[1].length, headingText, style));
      if (headingText === '目录') {
        // L4-6：目录标题后的静态条目统一收进 TOC 域缓存（区起点=标题之后）
        inToc = true;
        tocRegionStart = blocks.length;
      }
      lastBlockWasTable = false;
      index += 1;
      continue;
    }
    const plainLine = stripInlineMarkdown(line);
    const orderedList = orderedListMatch(line);
    const unorderedList = unorderedListMatch(line);
    if (!inToc && orderedList) {
      const indentLeft = orderedList.level === 0 ? 720 : orderedList.level === 1 ? 1080 : 1440;
      const hanging = orderedList.level === 0 ? 360 : orderedList.level === 1 ? 420 : 480;
      // 4.55.24：不再传 Word 侧 numbering。原实现每条有序列表都用 `numId: 1`
      //（numbering.xml 全文仅一个 numId，hybridMultilevel），而字面 marker（`1.`/`1.1.`）同时也写进了
      // 段文本 → Word 侧全文共享一个编号序列，导出显示成「续号. 1. 文本」（用户实测）。
      // 字面编号已足够且可控，故去掉自动编号，仅保留缩进/悬挂以维持层级观感。
      blocks.push(docxParagraph(`${orderedList.marker} ${orderedList.text}`, { styleId: 'ListParagraph', size: bodySize, line: style.lineTwips, fontEastAsia: style.fontBody, fontAscii: style.fontBodyAscii, indentLeft, hanging, spacingAfter: 60 }));
      index += 1;
      continue;
    }
    if (!inToc && unorderedList) {
      blocks.push(docxParagraph(`• ${unorderedList}`, { styleId: 'ListParagraph', size: bodySize, line: style.lineTwips, fontEastAsia: style.fontBody, fontAscii: style.fontBodyAscii, indentLeft: 720, hanging: 360, spacingAfter: 60 }));
      index += 1;
      continue;
    }
    // L4-5：表题行走表题样式（加粗/居中/零缩进/与表同页），不再作为普通正文段落渲染；
    // 邻接闸：表题只在「下一非空行是表格行」或「上一块刚渲染完表格」时成立
    const nextNonEmpty = lines.slice(index + 1).find(candidate => candidate.trim() !== '');
    if (!inToc && isTableCaptionLine(line) && (lastBlockWasTable || Boolean(nextNonEmpty && looksLikeMarkdownTableRow(nextNonEmpty.trim())))) {
      blocks.push(docxTableCaptionParagraph(plainLine, style));
      if (audit && audit.mode !== 'off') audit.ops.captionStyled += 1;
      lastBlockWasTable = false;
      index += 1;
      continue;
    }
    // 识别伪标题（如 **项目基本信息表**、**施工范围及项目特征**），在导出中提升字号
    const pseudoHeading = /^\*\*[^*]+\*\*\s*$/u.test(line) && plainLine.length <= 40;
    const boldLine = /^\*\*[^*]+\*\*\s*[:：]?\s*$/u.test(line) || /^（[一二三四五六七八九十]+）/u.test(plainLine) || /^[一二三四五六七八九十]+、/u.test(plainLine);
    blocks.push(inToc
      ? docxTocParagraph(line, style)
      : docxParagraph(plainLine, {
          bold: boldLine || pseudoHeading,
          size: pseudoHeading ? Math.max(style.bodyHalfPoints + 2, 30) : bodySize,
          line: style.lineTwips,
          fontEastAsia: style.fontBody,
          fontAscii: style.fontBodyAscii,
          align: pseudoHeading ? 'left' : 'both',
          firstLine: (boldLine || pseudoHeading) ? 0 : 560,
          spacingBefore: pseudoHeading ? 120 : (boldLine ? 80 : 0),
          spacingAfter: pseudoHeading ? 60 : undefined,
        }));
    lastBlockWasTable = false;
    index += 1;
  }
  closeTocRegion(); // 目录区在文末结束的情形同样收口（域结果闭合，防双轨）
  const documentXml = blocks.join('');
  // L4-2 产物守恒复核：渲染产物可见文本必须与入口文本逐字一致（docx 阶段零正文改动）
  if (audit && audit.mode !== 'off') {
    const conservation = docxStageConservationDiff(normalizedMarkdown, documentXml);
    if (!conservation.conserved) {
      audit.blockers.push({
        code: 'content-not-conserved',
        line: 0,
        message: `docx 渲染阶段存在未声明的正文改动（产物文本去标记比对）：第 ${conservation.position} 字符附近分歧（入口「${conservation.sourceContext}」→ 产物「${conservation.productContext}」）`,
      });
    }
  }
  return documentXml;
}

function docxStylesXml(settings?: DocumentExportSettings) {
  const style = resolveExportStyle(settings);
  const fontAttrs = `w:ascii="${escapeXml(style.fontBodyAscii)}" w:hAnsi="${escapeXml(style.fontBodyAscii)}" w:eastAsia="${escapeXml(style.fontBody)}" w:cs="${escapeXml(style.fontBodyAscii)}"`;
  const headingStyle = (id: string, name: string, size: number, level: number, before: number, after: number, align?: string) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="${9 + level}"/><w:qFormat/><w:rPr><w:b/><w:rFonts ${fontAttrs}/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:pPr><w:keepNext/><w:keepLines/><w:outlineLvl w:val="${level}"/><w:spacing w:line="${style.lineTwips}" w:lineRule="exact" w:before="${before}" w:after="${after}"/>${align ? `<w:jc w:val="${align}"/>` : ''}</w:pPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts ${fontAttrs}/><w:sz w:val="${style.bodyHalfPoints}"/><w:szCs w:val="${style.bodyHalfPoints}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="${style.lineTwips}" w:lineRule="exact" w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts ${fontAttrs}/><w:sz w:val="${style.bodyHalfPoints}"/><w:szCs w:val="${style.bodyHalfPoints}"/></w:rPr><w:pPr><w:spacing w:line="${style.lineTwips}" w:lineRule="exact" w:after="120"/></w:pPr></w:style>${headingStyle('Heading1', 'heading 1', Math.max(style.h1HalfPoints, 24), 0, 260, 180, 'center')}${headingStyle('Heading2', 'heading 2', Math.max(style.h2HalfPoints, 24), 1, 180, 100)}${headingStyle('Heading3', 'heading 3', Math.max(style.h3HalfPoints, 22), 2, 120, 80)}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:style></w:styles>`;
}

function docxSettingsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';
}

function docxFontTableXml(settings?: DocumentExportSettings) {
  const style = resolveExportStyle(settings);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="${escapeXml(style.fontBody)}"><w:charset w:val="86"/><w:family w:val="roman"/></w:font><w:font w:name="${escapeXml(style.fontBodyAscii)}"><w:family w:val="roman"/></w:font></w:fonts>`;
}

function docxCorePropertiesXml(title: string) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>Customize Agent</dc:creator><cp:lastModifiedBy>Customize Agent</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

function docxAppPropertiesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Customize Agent</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion></Properties>';
}

async function ensureDocxPackageParts(zip: JSZip, title: string, settings?: DocumentExportSettings, images: DocxImageItem[] = []) {
  zip.folder('word')?.file('styles.xml', docxStylesXml(settings));
  zip.folder('word')?.file('settings.xml', docxSettingsXml());
  zip.folder('word')?.file('fontTable.xml', docxFontTableXml(settings));
  zip.folder('docProps')?.file('core.xml', docxCorePropertiesXml(title));
  zip.folder('docProps')?.file('app.xml', docxAppPropertiesXml());
  const mediaFolder = zip.folder('word')?.folder('media');
  for (const image of images) mediaFolder?.file(image.fileName, image.buffer);

  const relsPath = 'word/_rels/document.xml.rels';
  const relsFile = zip.file(relsPath);
  let rels = relsFile ? await relsFile.async('string') : '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const documentRelationships = [
    ['rStyle', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', 'styles.xml'],
    ['rSettings', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings', 'settings.xml'],
    ['rFontTable', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable', 'fontTable.xml'],
  ];
  for (const [id, type, target] of documentRelationships) {
    if (!rels.includes(type)) rels = rels.replace('</Relationships>', `<Relationship Id="${id}" Type="${type}" Target="${target}"/></Relationships>`);
  }
  for (const image of images) {
    if (!rels.includes(`Id="${image.relationshipId}"`)) rels = rels.replace('</Relationships>', `<Relationship Id="${image.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${image.fileName}"/></Relationships>`);
  }
  zip.folder('word')?.folder('_rels')?.file('document.xml.rels', rels);

  const packageRelsPath = '_rels/.rels';
  const packageRelsFile = zip.file(packageRelsPath);
  let packageRels = packageRelsFile ? await packageRelsFile.async('string') : '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  if (!packageRels.includes('metadata/core-properties')) packageRels = packageRels.replace('</Relationships>', '<Relationship Id="rCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
  if (!packageRels.includes('extended-properties')) packageRels = packageRels.replace('</Relationships>', '<Relationship Id="rApp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>');
  zip.folder('_rels')?.file('.rels', packageRels);

  const contentTypesFile = zip.file('[Content_Types].xml');
  let contentTypes = contentTypesFile ? await contentTypesFile.async('string') : '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const defaults = new Set(images.map(image => path.extname(image.fileName).slice(1).toLowerCase()).filter(Boolean));
  for (const extension of defaults) {
    const contentType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif' : extension === 'webp' ? 'image/webp' : undefined;
    if (contentType && !contentTypes.includes(`Extension="${extension}"`)) contentTypes = contentTypes.replace('</Types>', `<Default Extension="${extension}" ContentType="${contentType}"/></Types>`);
  }
  const overrides = [
    ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
    ['/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
    ['/word/fontTable.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml'],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
  ];
  for (const [partName, contentType] of overrides) {
    if (!contentTypes.includes(`PartName="${partName}"`)) contentTypes = contentTypes.replace('</Types>', `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`);
  }
  zip.file('[Content_Types].xml', contentTypes);
}

/**
 * SVG 图件预光栅化（4.55.18）：DOCX 不能内联 SVG（旧实现显式跳过 → 图位导出成字符）。
 * 用 playwright 以 2× 设备像素比渲染 SVG 后截图为 PNG（矢量→位图，清晰度按 2 倍冗余留足）。
 * 多候选启动（与 renderPdfBuffer 同源：bundled chromium → 系统 chrome/edge → 常见路径）；
 * 任一图失败仅跳过该图（不阻断导出）。
 */
async function buildDocx(title: string, markdown: string, settings?: DocumentExportSettings, templatePath?: string, projectRoot = process.cwd(), audit?: ExportRenderAudit): Promise<{ buffer: Buffer; templateWarning?: string }> {
  const context: DocxBuildContext = { projectRoot, images: [] };
  // 4.55.18：SVG 图件预光栅化（DOCX 不能内联 SVG；失败仅跳过该图）
  // 4.56 L4-2：审计贯通到 docx 渲染阶段（结构操作计数 + 产物文本守恒复核进同一 audit）
  const contentXml = markdownToDocxXml(markdown, settings, context, audit);
  let templateWarning: string | undefined;
  if (templatePath && fs.existsSync(templatePath)) {
    const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
    const documentFile = zip.file('word/document.xml');
    if (documentFile) {
      const xml = await documentFile.async('string');
      /**
       * 4.56 L4-1 **静默交付错误产物**根治：原实现在模板 `document.xml` 无 `{{content}}` 占位符时，
       * `String.replace` 是**空操作** → 返回的 docx 是**模板原文**、正文一字不进，
       * 且无报错、无响应头、无阶段事件——交付物与本次生成的文档完全无关却无从察觉。
       * 现口径：无占位符 → **回退到标准生成路径**（正文正确，仅不套模板样式）+ 显式告警落盘与响应头；
       * **绝不以模板原文冒充实交付物**。
       */
      if (/\{\{content\}\}/u.test(xml)) {
        zip.file('word/document.xml', xml.replace(/\{\{title\}\}/gu, escapeXml(title)).replace(/\{\{content\}\}/gu, contentXml));
        await ensureDocxPackageParts(zip, title, settings, context.images);
        return { buffer: await zip.generateAsync({ type: 'nodebuffer' }) };
      }
      console.error(`[export] 模板缺少 {{content}} 占位符，已回退标准生成路径（正文正确、未套模板样式）：${templatePath}`);
      templateWarning = `模板缺少 {{content}} 占位符，已回退标准生成路径（未套模板样式）`;
    }
  }
  const page = settings?.page || {};
  const zip = new JSZip();
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${contentXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${lengthToTwips(page.marginTop, 2.5)}" w:right="${lengthToTwips(page.marginRight, 2)}" w:bottom="${lengthToTwips(page.marginBottom, 2)}" w:left="${lengthToTwips(page.marginLeft, 2)}"${page.gutter ? ` w:gutter="${lengthToTwips(page.gutter, 0)}"` : ''}/></w:sectPr></w:body></w:document>`);
  await ensureDocxPackageParts(zip, title, settings, context.images);
  return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), templateWarning };
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
  const fontFamily = typography.fontFamily || 'SimSun, 宋体, serif';
  // 4.33 正/标题字体分离：bodyFont/headingFont 优先；旧配置仅 fontFamily 时完全兼容旧行为
  const bodyFontFamily = typography.bodyFont || typography.fontFamily || 'SimSun, 宋体, serif';
  const headingFontFamily = typography.headingFont || typography.fontFamily || 'SimSun, 宋体, serif';
  const lineHeight = typography.lineHeight || '18pt';
  const titleSize = typography.titleSize || '22pt';
  const bodySize = typography.bodySize || '12pt';
  return { paper, marginTop, marginRight, marginBottom, marginLeft, fontFamily, bodyFontFamily, headingFontFamily, lineHeight, titleSize, bodySize };
}

function enhanceTocHtml(body: string) {
  // 目录区边界判定（4.40 根治）：结构驱动——page-break div 或下一 H2 标题行；成稿 markdown 无 div
  // （装配链 fixTocFromBody/ensureFormalToc 重建目录不产 div）时旧口径不匹配 → .document-toc 包裹
  // 与分页/缩进样式整体缺失；两形态同源，导出与生成链目录区判定口径一致
  return body.replace(/(<h2[^>]*>\s*目录\s*<\/h2>)([\s\S]*?)(<div class="page-break"><\/div>|<h2[^>]*>)/u, (_match, heading: string, content: string, boundary: string) => {
    const normalized = content.replace(/<ol>\s*([\s\S]*?)\s*<\/ol>/u, (_ol, listContent: string) => listContent)
      .replace(/<li>\s*([^<]+?)\s*<\/li>/gu, '<p>$1</p>')
      .replace(/<p>(?:\s|&nbsp;|&#160;)*(\d+\.\d+\s+[^<]+)<\/p>/giu, '<p class="toc-section">$1</p>')
      .replace(/<p>(?!(?:\s|&nbsp;|&#160;)*<\/p>|(?:\s|&nbsp;|&#160;)*\d+\.\d+\s)([\s\S]*?)<\/p>/giu, '<p class="toc-chapter">$1</p>');
    return `<section class="document-toc">${heading}${normalized}</section>${boundary}`;
  });
}

function buildPrintCss(style: ReturnType<typeof resolveExportStyle>, monoColor = false) {
  return `
@page{size:${style.paper};margin:${style.marginTop} ${style.marginRight} ${style.marginBottom} ${style.marginLeft}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body,p,div,li,td,th,span,section,article{font-family:${style.bodyFontFamily};font-size:${style.bodyCss};line-height:${style.lineCss};color:#111827}
body{font-variant-east-asian:normal;text-rendering:geometricPrecision;word-break:normal;overflow-wrap:break-word}
p{margin:0 0 7pt 0;text-align:justify;text-justify:inter-ideograph;text-indent:2em;orphans:2;widows:2}
strong{font-weight:700}
ul,ol{margin:0 0 8pt 2em;padding:0}li{margin:0 0 4pt 0;text-align:justify;break-inside:avoid}
h1,h2,h3,h4{font-family:${style.headingFontFamily};line-height:${style.lineCss};font-weight:700;color:#111827;page-break-after:avoid;break-after:avoid;break-inside:avoid}
h1{text-align:center;font-size:${Math.max(style.h1Pt + 6, 22)}pt;margin:80pt 0 28pt 0}
h2{text-align:center;font-size:${style.h1Css};border:0;padding:0;margin:24pt 0 14pt 0;break-before:auto;page-break-before:auto}
h2.document-chapter-heading:not(:first-child){page-break-before:always;break-before:page}
h3{font-size:${style.h1Css};margin:16pt 0 7pt 0}
h4{font-size:${style.bodyCss};margin:10pt 0 5pt 0}
.document-toc{page-break-after:always;break-after:page}.document-toc h2{text-align:center;margin-top:0;page-break-before:auto;break-before:auto}.document-toc p{margin:0 0 4pt 0;text-align:left;text-indent:0}.document-toc .toc-chapter{font-weight:700;margin-top:8pt}.document-toc .toc-section{margin-left:2em}
.document-cover{height:calc(100vh - ${style.marginTop} - ${style.marginBottom});page-break-after:always;break-after:page;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;font-size:${Math.max(style.h1Pt + 8, 24)}pt;line-height:${Math.max(style.linePt + 10, 34)}pt;font-weight:700}.document-cover h1,.document-cover p{font-size:${Math.max(style.h1Pt + 8, 24)}pt;line-height:${Math.max(style.linePt + 10, 34)}pt;font-weight:700;text-align:center;text-indent:0;margin:0 0 18pt 0}
img{display:block;max-width:100%;max-height:500px;object-fit:contain;margin:10pt auto;page-break-inside:avoid;break-inside:avoid}
table{width:100%;border-collapse:collapse;table-layout:auto;page-break-inside:auto;break-inside:auto;margin:8pt 0 10pt 0}
thead{display:table-header-group}tfoot{display:table-footer-group}tr{page-break-inside:avoid;break-inside:avoid;page-break-after:auto}
th,td{font-family:${style.bodyFontFamily};font-size:${Math.max(style.bodyPt - 1, 9)}pt;line-height:${style.lineCss};border:1px solid #666;padding:3pt 5pt;vertical-align:top;text-indent:0;text-align:left;word-break:normal;overflow-wrap:break-word}
th{background:${monoColor ? '#fff' : '#f3f4f6'};font-weight:700;text-align:center}
pre{white-space:pre-wrap;font-family:${style.bodyFontFamily};font-size:${style.bodyCss};line-height:${style.lineCss};page-break-inside:avoid;break-inside:avoid}.page-break{page-break-after:always;break-after:page;height:0}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}a{text-decoration:none;color:#111827}}
`;
}

function htmlShell(title: string, body: string, settings?: DocumentExportSettings, monoColor = false) {
  const style = resolveExportStyle(settings);
  const enhancedBody = enhanceTocHtml(body);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeXml(title)}</title><style>${buildPrintCss(style, monoColor)}</style></head><body>${enhancedBody}</body></html>`;
}

function markdownStats(markdown: string) {
  return {
    chars: markdown.trim().length,
    h2: (markdown.match(/^##\s+/gmu) || []).length,
    h3: (markdown.match(/^###\s+/gmu) || []).length,
    tables: (markdown.match(/\n\s*\|\s*:?-{3,}/gu) || []).length,
  };
}

function markdownHeadings(markdown: string) {
  return markdown.split(/\r?\n/u)
    .map(line => /^(#{2,4})\s+(.+)$/u.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map(match => ({ level: match[1].length, title: stripInlineMarkdown(match[2]) }))
    .filter(heading => heading.title && heading.title !== '目录');
}

function normalizeHeadingTitle(title: string) {
  return title.replace(/^第[一二三四五六七八九十百]+章\s*/u, '')
    .replace(/^\d+(?:\.\d+)*\s*/u, '')
    .replace(/[\s:：.。]+$/gu, '')
    .trim();
}

function repeatedParagraphWarnings(markdown: string) {
  const seen = new Map<string, number>();
  const repeated: string[] = [];
  for (const paragraph of markdown.split(/\n{2,}/u).map(item => stripInlineMarkdown(item)).filter(item => item.length >= 45 && !/^#+\s/u.test(item))) {
    const key = paragraph.replace(/\s+/gu, '').slice(0, 90);
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count === 2) repeated.push(paragraph.slice(0, 60));
  }
  return repeated;
}

function exportTablePreflightIssues(markdown: string) {
  const issues: string[] = [];
  const lines = markdown.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || '';
    if (!looksLikeMarkdownTableRow(line)) continue;
    const separatorIndex = lines[index + 1]?.trim() === '' ? index + 2 : index + 1;
    if (separatorIndex < lines.length && isMarkdownTableSeparator(lines[separatorIndex] || '')) {
      const rows: string[] = [];
      let rowIndex = separatorIndex + 1;
      while (rowIndex < lines.length && looksLikeMarkdownTableRow(lines[rowIndex] || '')) {
        rows.push(lines[rowIndex] || '');
        rowIndex += 1;
      }
      if (rows.length === 0) issues.push(`第 ${index + 1} 行表格只有表头，没有数据行`);
      const counts = [line, ...rows].map(row => splitMarkdownTableRow(row).length);
      if (Math.max(...counts) - Math.min(...counts) > 2) issues.push(`第 ${index + 1} 行附近表格列数差异较大，导出版式可能异常`);
      index = rowIndex - 1;
      continue;
    }
    if (index + 1 < lines.length && looksLikeMarkdownTableRow(lines[index + 1] || '')) issues.push(`第 ${index + 1} 行附近疑似裸表格（缺少表头或分隔线），导出版式可能异常`);
  }
  const fenceCount = (markdown.match(/```/gu) || []).length;
  if (fenceCount % 2 === 1) issues.push('存在未闭合代码块，可能影响后续内容导出');
  return [...new Set(issues)].slice(0, 20);
}

function validateExportMarkdown(markdown: string, baseline?: string) {
  const stats = markdownStats(markdown);
  const baseStats = baseline ? markdownStats(baseline) : undefined;
  const issues: string[] = [];
  if (stats.chars < 200) issues.push('导出内容为空或过短');
  if (baseStats && baseStats.chars > 1000 && stats.chars < baseStats.chars * 0.8) issues.push('导出内容明显少于服务端生成记录');
  if (baseStats && baseStats.h3 > 0 && stats.h3 === 0) issues.push('导出内容缺少服务端生成记录中的二级小节');
  if (baseStats && baseStats.tables > 0 && stats.tables === 0) issues.push('导出内容缺少服务端生成记录中的表格');

  const headings = markdownHeadings(markdown);
  if (headings.length === 0) issues.push('正文缺少章节标题');
  if (headings.some((heading, index) => index > 0 && heading.level - headings[index - 1].level > 1)) issues.push('标题层级存在跳级，可能影响导出目录和导航');
  const duplicateHeadings = headings.map(heading => normalizeHeadingTitle(heading.title)).filter(Boolean)
    .filter((title, index, array) => array.indexOf(title) !== index);
  if (duplicateHeadings.length > 0) issues.push(`存在重复标题：${[...new Set(duplicateHeadings)].slice(0, 3).join('、')}`);

  const suspiciousLines = markdown.split(/\r?\n/u).map(line => stripInlineMarkdown(line)).filter(line => line.length > 0 && !/^#+\s/u.test(line));
  if (suspiciousLines.some(line => line.length <= 1)) issues.push('正文存在孤立字或残缺段落');
  if (suspiciousLines.some(line => /[，、；：和与在为对将]$/u.test(line) || /(通过|包括|如下|主要包括)$/u.test(line))) issues.push('正文存在疑似截断句或未完结段落');
  if (suspiciousLines.some(line => line.length > 380)) issues.push('正文存在过长段落，建议拆分以改善导出版式');

  const repeated = repeatedParagraphWarnings(markdown);
  if (repeated.length > 0) issues.push(`正文存在重复段落：${repeated.slice(0, 2).join('；')}`);
  issues.push(...exportTablePreflightIssues(markdown));
  return [...new Set(issues)];
}

function normalizeExportMarkdownHeadings(markdown: string) {
  return markdown
    .replace(/(##\s*第[一二三四五六七八九十百千万\d]+章[^\n#]*?)\s+(#{3,4}\s*\d+(?:\.\d+)+\s+)/gu, '$1\n\n$2')
    .replace(/([^\n])\s+(##\s*第[一二三四五六七八九十百千万\d]+章\s+)/gu, '$1\n\n$2')
    .replace(/([^\n])\s+(#{3,4}\s*\d+(?:\.\d+)+\s+)/gu, '$1\n\n$2')
    .replace(/(#{2,4}\s+[^\n]+?)\s+(#{2,4}\s+)/gu, '$1\n\n$2');
}

/**
 * A2 内容守恒断言（去标记 diff）：导出链只允许「结构语法操作」（补分隔线/列对齐/插空行/相邻表边界截断），
 * 不允许任何未声明的正文改写——两侧归一化（结构符/单位形态/空白全部剥离）后逐字比对；
 * 单位形态（m2/m²/㎡/m^2/m<sup>2</sup>）属已声明改写（ops.unitRewrite 单独计数），归一后互不可见。
 * 差异=导出链存在静默改文案通道：observe 采样记录，enforce 阻断（与 A1 同一门禁）。
 */
function canonicalExportText(input: string) {
  const stripped = stripMarkdownDocumentFence(input).replace(/\r?\n/gu, '\n');
  const lines = stripped.split('\n').filter(line => !isMarkdownTableSeparator(line.trim()) && !/^\s*```/u.test(line));
  return lines.join('\n')
    .replace(/m\s*<sup>\s*2\s*<\/sup>/giu, 'm2')
    .replace(/m\s*<sup>\s*3\s*<\/sup>/giu, 'm3')
    .replace(/m\s*\^\s*2/giu, 'm2')
    .replace(/m\s*\^\s*3/giu, 'm3')
    .replace(/㎡/gu, 'm2')
    .replace(/㎥/gu, 'm3')
    .replace(/m\s*²/giu, 'm2')
    .replace(/m\s*³/giu, 'm3')
    .replace(/m\s*2(?!\.\d)/giu, 'm2')
    .replace(/m\s*3(?!\.\d)/giu, 'm3')
    // A4 对称归一：数字间乘号形态与 normalizeProductionText 同口径（已声明改写——导出链
    // A4 归一后两侧同形不可见；不先归一会在下一步 `*` 剥离时产生伪分歧：400*400→400400）
    .replace(/(?<=\d)\s*[xX×*ｘＸ＊]\s*(?=\d)/gu, '×')
    .replace(/[`*_~|#\\-]/gu, '')
    .replace(/<[^>]*>/gu, '')
    .replace(/\s+/gu, '');
}

/** 归一文本分歧定位（**单一实现**：导出链 A2 断言与 docx 阶段产物复核共用，禁止两处各写一份定位口径） */
function diffCanonicalText(a: string, b: string) {
  if (a === b) return { conserved: true as const };
  let index = 0;
  const max = Math.min(a.length, b.length);
  while (index < max && a[index] === b[index]) index += 1;
  return {
    conserved: false as const,
    position: index,
    sourceContext: a.slice(Math.max(0, index - 20), index + 20),
    productContext: b.slice(Math.max(0, index - 20), index + 20),
  };
}

/** 守恒比对：返回去标记文本是否逐字一致；不一致时给出首个分歧位置与上下文（供审计回溯） */
function exportConservationDiff(source: string, product: string) {
  return diffCanonicalText(canonicalExportText(source), canonicalExportText(product));
}

/** docx 产物可见文本提取：`<w:t>` 文本节点（`<w:tbl>`/`<w:tr>`/`<w:instrText>` 不匹配），XML 实体还原 */
function docxVisibleText(documentXml: string) {
  return [...documentXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)]
    .map(match => (match[1] || '')
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&quot;/gu, '"')
      .replace(/&amp;/gu, '&'))
    .join('\n');
}

/**
 * docx 产物归一（**两侧对称**剥离渲染层标记，故只可能掩盖「标记级」差异，不可能掩盖文字改动；
 * 正文文字一字不动，任何文字差异都是内容改动）：
 * 图片（图位无文本）、链接（只输出文字）、分页标记、列表符号（源 `-`/`*` → 产物 `•`）、
 * TOC 域占位文案（无静态条目时的域结果）；其余标记（井号、星号、竖线、下划线等）与空白
 * 由 canonicalExportText 统一剥离。
 */
function canonicalDocxText(input: string) {
  return canonicalExportText(
    input
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/\[\[PAGE_BREAK\]\]/gu, '')
      .replace(/[•·]/gu, '')
      .replace(new RegExp(DOCX_TOC_FIELD_PLACEHOLDER, 'gu'), ''),
  );
}

/**
 * 4.56 L4-2 **docx 阶段产物守恒复核**（A2 覆盖 docx 阶段的扩展）：把渲染产物的可见文本与入口
 * markdown 去标记比对——docx 阶段任何静默改写/注入/丢失都必然在此暴露（含历史缺陷形态：
 * 单位二次改写 `m2→m²`、裸表假表头注入「信息项|内容」）。
 */
function docxStageConservationDiff(sourceMarkdown: string, documentXml: string) {
  return diffCanonicalText(canonicalDocxText(sourceMarkdown), canonicalDocxText(docxVisibleText(documentXml)));
}

/**
 * 4.56 L4-8 **导出链声明剥离**（素材残留行 / 澄清变更叙述 / 图纸图集指向语）。
 *
 * 原缺陷：三个剥离器**只挂在生成链上**（`stripMaterialResidueLines` 仅 `evidence.cleanEvidenceText`、
 * `stripClarificationNarrative`/`stripDrawingPointerPhrases` 仅 `tenderRequirements.fixFormalSourceResidue`），
 * 导出路径（`editedMarkdown` 用户改动、`useClientMarkdown` 前端草稿、链尾补写重新引入的段落）
 * **一处都不剥离** → 交付物仍带答疑对答/澄清过程叙述/「详见《…》20S515/29」式指向替代。
 *
 * 现口径（三条硬约束）：
 * ① **单源判据**：直接调用生成链同名函数（materialResidue.*），**不复制任何判据**——链上收紧/放宽后
 *    导出层自动同步；不在导出层写第二套正则/白名单。
 * ② **信息零丢失**：剥离**只作用于散文区**——结构性行（标题/表格行/列表项/代码围栏/HTML 块/分页标记，
 *    判据与 normalizeParagraphs 共用 STRUCTURAL_LINE_RE）逐字保留。理由：链上同名函数若被整段套到
 *    结构行上，行内「按设计图纸控制」这类小句会让**整行/整条**被删（表格记录与编号条目丢失）；
 *    故导出层收窄作用域，只可能比链上**更保守**，绝不更激进。
 * ③ **记账与守卫**：每次运行都做「登记计数 ⇔ 内容确有改动」对账（内容改动而无计数 = 未声明改写 → blocker）、
 *    结构指纹前后比对（标题集合/表格行集合逐字不变，越界即回退并 blocker），并把计数与样本写进审计
 *    （notices.declared-rewrite + ops.declaredStrip，随响应头 X-Export-Render-Audit 与导出报告归档）。
 *    幂等：三个剥离器各自幂等（已剥离文本再剥离零命中、零改动），故重复导出产物一致。
 */
type DeclaredStripOutcome = { text: string; removed: number; samples: string[] };

/** 散文区剥离（判据全部来自生成链同名函数；结构行不参与、逐字保留） */
function stripDeclaredNonDeliverable(text: string): DeclaredStripOutcome {
  if (!text) return { text, removed: 0, samples: [] };
  const out: string[] = [];
  const samples: string[] = [];
  let removed = 0;
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length === 0) return;
    const chunk = prose.join('\n');
    // 与生成链 fixFormalSourceResidue 的调用顺序一致（叙述 → 指向 → 行级残片），判据同源
    const narrative = stripClarificationNarrative(chunk);
    const pointer = stripDrawingPointerPhrases(narrative.text);
    const lineStripped = stripMaterialResidueLines(pointer.text);
    removed += narrative.removed + pointer.removed;
    // 行级残片计数用同一判据 isMaterialResidueLine（stripMaterialResidueLines 内部即此判据，勿另立口径）
    for (const line of pointer.text.split('\n')) {
      if (!isMaterialResidueLine(line)) continue;
      removed += 1;
      if (samples.length < 6) samples.push(line.trim().slice(0, 40));
    }
    // 句级剥离样本（计数由函数自报，样本取「剥离后消失的行」前 6 处，供交付审计回溯）
    const survived = new Set(lineStripped.split('\n'));
    for (const line of chunk.split('\n')) {
      if (!line.trim() || survived.has(line) || samples.length >= 6) continue;
      samples.push(line.trim().slice(0, 40));
    }
    out.push(...lineStripped.split('\n'));
    prose = [];
  };
  for (const line of text.replace(/\r?\n/gu, '\n').split('\n')) {
    // 空行与结构行：先收口散文段（判据作用于连续散文），结构行原样保留
    if (!line.trim() || STRUCTURAL_LINE_RE.test(line.trim())) {
      flushProse();
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return { text: out.join('\n'), removed, samples };
}

/** 结构指纹（信息零丢失守卫的比对基准）：标题集合 + 表格行集合（顺序与文字逐字） */
function exportStructureFingerprint(text: string) {
  const lines = text.replace(/\r?\n/gu, '\n').split('\n').map(line => line.trim());
  return {
    headings: lines.filter(line => /^#{1,6}\s/u.test(line)),
    tableRows: lines.filter(line => line.startsWith('|')),
  };
}

/** 声明剥离守卫 + 记账：结构越界即回退（blocker）；内容层面有改动却零登记 = 未声明改写（blocker） */
function applyDeclaredStrips(rawMarkdown: string, audit?: ExportRenderAudit): string {
  const outcome = stripDeclaredNonDeliverable(rawMarkdown);
  if (outcome.text === rawMarkdown) return rawMarkdown;
  const before = exportStructureFingerprint(rawMarkdown);
  const after = exportStructureFingerprint(outcome.text);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    audit?.blockers.push({
      code: 'declared-rewrite-overreach',
      line: 0,
      message: '导出链声明剥离改动越界（标题行/表格行被改写或删除）：结构行是信息载体，剥离只允许作用于散文区，已回退原文',
    });
    return rawMarkdown;
  }
  if (audit && audit.mode !== 'off') {
    // 记账守卫：内容层面（去标记/空白/标点）确有改动却没有登记计数 → 存在未声明的改写通道
    const fold = (value: string) => canonicalExportText(value).replace(/[，,、；;：:]/gu, '');
    if (fold(rawMarkdown) !== fold(outcome.text) && outcome.removed === 0) {
      audit.blockers.push({
        code: 'declared-rewrite-unregistered',
        line: 0,
        message: '导出链声明剥离存在未登记的内容改动（内容有改动但计数为零）：剥离器与实际改写不一致，需复核判据',
      });
    } else if (outcome.removed > 0) {
      audit.ops.declaredStrip += outcome.removed;
      audit.notices.push({
        code: 'declared-rewrite',
        message: `导出链声明剥离 ${outcome.removed} 处（素材残留行/澄清变更叙述/图纸图集指向语；判据与生成链 materialResidue 同名函数同源，结构行逐字保留）${outcome.samples.length > 0 ? `，样本：${outcome.samples.join('；')}` : ''}`,
      });
    }
  }
  return outcome.text;
}

/** 目录区存在性判定（锚「## 目录」段，与生成链 fixTocFromBody 的 TOC_BLOCK_LOCAL_RE 同锚点） */
const EXPORT_TOC_HEADING_RE = /^##\s+目录\s*$/mu;

/** 改动跨度（公共前后缀剥离后的差异区间）：用于证明「声明改动只落在允许区间内」 */
function changedSpan(before: string, after: string) {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { before: before.slice(start, endBefore), after: after.slice(start, endAfter) };
}

/**
 * 4.56 L4-7 **静态目录按正文对账**（同源：直接调用生成链目录重建器 `fixTocFromBody`，不另造目录判据）。
 *
 * 原缺陷：`## 目录` 后续条目行由 markdown 原文提供，导出层**不与正文编号对账**——实测一份 87 条
 * 目录里 86 条与正文章节号/标题不一致（用户改动正文后目录未同步，前端草稿更无重建环节）。
 * 现口径：目录条目一律按正文实际 H2/H3 结构重建；重建**只能改目录区**（过界守卫：改动跨度不得含
 * 章/节标题行或表格行，违者回退原文并 blocker）；重建结果再做一次同源判据复核（应当是不动点，
 * 不收敛则显式告警）。
 */
function reconcileTocFromBody(text: string, audit?: ExportRenderAudit): string {
  if (!EXPORT_TOC_HEADING_RE.test(text)) return text; // 无目录区：无从对账（同 fixTocFromBody 零成本返回）
  const result = fixTocFromBody(text);
  if (result.markdown === text) return text; // 已对账（或不含可重建结构：无 H2 章标题/H3 编号小节）
  // 同源判据的「已一致」判定：`fixTocFromBody` 的返回体不含空行（章行后直接接两空格缩进的小节行），
  // 而本链上游的段落归一会在目录条目之间插空行——若**条目文本本身**已与正文一致（去标记/空白后同形），
  // 差异只是渲染格式，属已对账：不重建、不计数、不告警（否则每份带目录的文档都会报「已重建」）。
  if (canonicalExportText(result.markdown) === canonicalExportText(text)) return text;
  const span = changedSpan(text, result.markdown);
  if (/^#{2,4}\s/mu.test(span.after) || /^\s*\|/mu.test(span.after)) {
    audit?.blockers.push({
      code: 'declared-rewrite-overreach',
      line: 0,
      message: '目录重建改动跨度越界（改动区间含正文章/节标题行或表格行），已回退原文目录：需回源核对目录与正文结构',
    });
    return text;
  }
  if (audit && audit.mode !== 'off') {
    audit.ops.tocRebuilt += 1;
    audit.notices.push({
      code: 'toc-reconcile',
      message: `静态目录与正文结构不一致，已按生成链 fixTocFromBody 同源口径重建（目录条目取正文章标题与小节编号原文）${result.details.length > 0 ? `：${result.details.join('；')}` : ''}`,
    });
    if (fixTocFromBody(result.markdown).markdown !== result.markdown) {
      audit.notices.push({ code: 'toc-reconcile', message: '目录重建结果未收敛（二次重建仍有差异）：需回源核对目录与正文结构' });
    }
  }
  return result.markdown;
}

/**
 * 导出链阶段化（声明改写 → 结构/单位归一 → 目录对账）：
 * 返回 `declared`（声明剥离后的源，A2 守恒基线）与 `product`（交付产物）。
 * off 模式 = 显式回退历史行为（不做任何声明改写）。
 */
function exportPipelineStages(text: string, audit?: ExportRenderAudit) {
  const mode = audit?.mode ?? exportPureRenderMode();
  const declared = mode === 'off' ? text : applyDeclaredStrips(text, audit);
  const normalized = normalizeExportMarkdownHeadings(normalizeExportUnits(sanitizeFormalMarkdown(declared), audit));
  const product = mode === 'off' ? normalized : reconcileTocFromBody(normalized, audit);
  return { declared, normalized, product };
}

function prepareExportMarkdown(rawMarkdown: string, baseline?: string) {
  const audit = createExportRenderAudit();
  const stages = exportPipelineStages(rawMarkdown, audit);
  // 基线（服务端生成记录）走同一阶段链，保证 validateExportMarkdown 的字数/表格/小节比对两侧同口径
  const baselineMarkdown = exportPipelineStages(baseline || '').product;
  // A2 守恒断言：以**声明剥离后**的源为基线（声明改写已在审计逐处登记，见 notices.declared-rewrite）；
  // 其余任何未声明的正文改写（含 docx 渲染阶段，见 markdownToDocxXml 的产物文本守恒复核）必须被捕获
  if (audit.mode !== 'off') {
    const conservation = exportConservationDiff(stages.declared, stages.normalized);
    if (!conservation.conserved) {
      audit.blockers.push({
        code: 'content-not-conserved',
        line: 0,
        message: `导出链存在未声明的内容改写（去标记比对）：归一文本第 ${conservation.position} 字符附近分歧（源「${conservation.sourceContext}」→ 产物「${conservation.productContext}」）`,
      });
    }
  }
  return {
    markdown: stages.product,
    baselineMarkdown,
    issues: validateExportMarkdown(stages.product, baselineMarkdown),
    audit,
  };
}

function markChapterHeadings(html: string) {
  return html.replace(/<h2([^>]*)>(第[一二三四五六七八九十百千万\d]+章\s*[\s\S]*?)<\/h2>/gu, (_match, attrs: string, title: string) => {
    if (/\bclass=/iu.test(attrs)) return `<h2${attrs.replace(/class=(['"])(.*?)\1/iu, (_classMatch, quote: string, classes: string) => `class=${quote}${classes} document-chapter-heading${quote}`)}>${title}</h2>`;
    return `<h2${attrs} class="document-chapter-heading">${title}</h2>`;
  });
}

function removeRenderedMarkdownTableSeparators(html: string) {
  return html.replace(/<p>\s*\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*<\/p>/giu, '');
}

async function buildExportHtml(title: string, markdown: string, settings: DocumentExportSettings | undefined, projectRoot: string, monoColor = false) {
  const { marked } = await import('marked');
  const body = removeRenderedMarkdownTableSeparators(markChapterHeadings(marked.parse(markdown, { async: false }) as string));
  return inlineLocalImages(htmlShell(title, body, settings, monoColor), projectRoot);
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

function pdfPageCount(buffer: Buffer) {
  const text = buffer.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page\b/gu);
  return matches?.length || undefined;
}

async function renderPdfBuffer(html: string, settings?: DocumentExportSettings, formatRules?: BidCompositionSpec['formatRules']) {
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
        // 标书编制规格：暗标「不需编制页眉、页脚、页码」→ 禁用页码页脚（招标文件 > 系统默认）
        const headerFooter = formatRules?.headersFooters === 'forbidden'
          ? { displayHeaderFooter: false as const }
          : { displayHeaderFooter: true as const, headerTemplate: '<div></div>', footerTemplate: `<div style="font-family:${style.fontFamily};font-size:10.5pt;line-height:12pt;width:100%;text-align:center;color:#666;">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>` };
        const pdf = await page.pdf({ format: style.paper as 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: style.marginTop, right: style.marginRight, bottom: style.marginBottom, left: style.marginLeft }, ...headerFooter });
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
 * B3 导出后闭环报告：导出成功后归档总用时/规则执行摘要/修复记录到记录详情，
 * 支持与历史版本对比。归档失败不影响导出结果。
 *
 * 4.55.29 L1-4：门禁清单归档。此前只归档 `gatePassed` 布尔值，**门禁到底拦了什么**随响应丢失——
 * 修复轮拿不到「检测器身份 + 定位 + 修复路径」，只能重跑检测器重新猜。现按与其他三处挂载点
 * 同一构建（suspensionChecklist）归档结构化清单，修复轮按 detectorId 直连修复器闭环。
 */
function archiveExportReport(record: GeneratedDocumentRecord | null, format: ExportFormat, projectRoot: string, renderAudit?: ExportRenderAuditReport, gateIssues: ReadonlyArray<ValidationIssue> = []) {
  if (!record) return;
  try {
    const draft = record.draft;
    const quality = draft?.reviewMetadata?.diagnostics?.quality;
    const durationMs = record.completedAt ? Math.max(0, record.completedAt - record.createdAt) : Math.max(0, Date.now() - record.createdAt);
    const gateChecklist: SuspensionChecklist | undefined = gateIssues.length > 0 ? buildSuspensionChecklist(gateIssues, draft?.chapters) : undefined;
    const report: ExportReport = {
      format,
      exportedAt: Date.now(),
      durationMs,
      ruleSummary: (draft?.promptRules?.executionSummary || []).slice(0, 12),
      repairedCount: quality?.repairedCount,
      blockingCount: quality?.blockingCount,
      gatePassed: draft?.exportGate?.passed,
      // P18/P19 归档：自动健康诊断告警 + 修复轮热力图（跨文档缺陷热力图分析数据源）
      healthAlerts: draft?.reviewMetadata?.telemetry?.healthAlerts,
      repairHeat: draft?.reviewMetadata?.telemetry?.repairHeat,
      // A1 导出纯渲染审计（dry-run 误报采样 + 守恒断言证据链）
      ...(renderAudit ? { renderAudit } : {}),
      ...(gateChecklist ? { gateIssueCount: gateIssues.length, gateChecklist } : {}),
    };
    const history = [...(record.exportReports || []), report].slice(-20);
    updateGeneratedDocument(record.id, { exportReports: history }, projectRoot);
  } catch {
    // 报告归档失败不影响导出
  }
}

/**
 * 文档导出 API 处理器
 * 支持导出为 Markdown、HTML、DOCX、PDF 四种格式
 * PDF 导出优先使用 Playwright 内置 Chromium，失败时自动尝试系统浏览器
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 仅允许 POST 请求
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body as { documentId?: string; title?: string; markdown?: string; format?: ExportFormat; allowNonDeliverable?: boolean; useClientMarkdown?: boolean; exportGate?: { passed?: boolean; blockingIssues?: Array<{ message: string }> }; wordTemplatePath?: string; projectRoot?: string };
    const projectRoot = body.projectRoot || getProjectRoot();
    const record = body.documentId ? getGeneratedDocument(body.documentId, projectRoot) : null;
    if (body.documentId && !record) return res.status(404).json({ error: 'Document not found' });
    // 标书编制规格快照（生成时落盘）：导出层格式口径承接（页码页脚/单黑色/页数上限）
    const composition = record?.draft?.bidComposition;
    const title = body.title || record?.title || 'document';
    const exportSettings = record?.draft?.exportSettings;
    const recordMarkdown = record?.editedMarkdown || record?.markdown || record?.draft?.markdown || '';
    const rawMarkdown = body.useClientMarkdown && typeof body.markdown === 'string' ? body.markdown : recordMarkdown || body.markdown || '';
    const preparedExport = prepareExportMarkdown(rawMarkdown, record?.draft?.markdown || record?.markdown || '');
    const { markdown, audit } = preparedExport;
    const format = body.format;
    if (!format || !['markdown', 'html', 'pdf', 'docx'].includes(format)) return res.status(400).json({ error: 'INVALID_EXPORT_FORMAT', message: '请选择有效的导出格式。' });
    if (preparedExport.issues.length > 0) res.setHeader('X-Export-Content-Issues', encodeURIComponent(JSON.stringify(preparedExport.issues.slice(0, 20))));
    // A1 导出纯渲染审计：模式 + 源层结构性缺陷（观测期采样）+ 渲染层结构操作计数；off 模式不输出
    const renderAuditReport = audit.mode === 'off' ? undefined : exportRenderAuditReport(audit);
    if (renderAuditReport) res.setHeader('X-Export-Render-Audit', encodeURIComponent(JSON.stringify(renderAuditReport)));
    // A1 enforce：源层结构性缺陷（裸表/孤立分隔线）阻断导出——导出层不造内容兜底，报错回源修复
    if (audit.mode === 'enforce' && audit.blockers.length > 0) {
      return res.status(422).json({
        error: 'EXPORT_SOURCE_STRUCTURAL_DEFECT',
        message: `导出源存在结构性缺陷，已按纯渲染模式阻断（不再补造表头）：${audit.blockers.slice(0, 3).map(item => item.message).join('；')}`,
        issues: audit.blockers.slice(0, 20),
      });
    }
    const exportGate = record?.draft?.exportGate || body.exportGate;
    // G 线 P0-3 交付资格判定：导出门禁恢复阻断权。
    // 此前注释为「导出门禁仅作为风险提示，不阻断用户导出」，结论只写进 X-Export-* 响应头 ——
    // 而该响应头**没有任何客户端读取**（前端只取 response.blob()），形成「有判定、无消费者」的
    // 假闭环：最后一道能拦住不合格交付的闸门实际是敞开的。
    // 4.55.29 L1-1 现口径：门禁**默认生效**，且不再有「一个布尔量静默关闸」的调用面 ——
    // 唯一的放行通道是调用方显式声明 `allowNonDeliverable: true`（语义即「我知道这是非交付物」），
    // 且放行必须是**自标注**的：响应头 NON_DELIVERABLE_HEADER 置位 + 下载文件名强制加「_非交付物_」后缀。
    // 原 `enforceGate: false` 的危险在于：它既表达「不拦」，又对产物零标记——一旦被顺手传上，
    // 69 项阻断静默出闸、产物与正式交付物外观完全一致（实测事故面）。
    //
    // 同时修掉双重过滤：此前对 blockingIssues 再滤一遍 isExportBlockingIssue（更窄的消息正则），
    // 与 buildExportGate 使用的 isHardExportBlockingIssue 不是同一口径 —— 导出层看到的阻断集
    // 会小于门禁层，形成「门禁说不通过、导出层说通过」的分裂。此处直接采用门禁结论（口径单源）。
    // 请求体（无记录时由前端草稿携带）的门禁条目只保证 message —— 进入阻断清单即按 error 级校验问题处理
    const gateBlockingIssues: ValidationIssue[] = (exportGate?.blockingIssues || []).map(item => ({ level: 'error' as const, ...item }));
    const gateFailedChecklist: ValidationIssue[] = exportGate?.passed === false && gateBlockingIssues.length === 0 ? [{ level: 'error', message: '导出门禁未通过：存在未完成的检查项' }] : [];
    const gateIssues: ValidationIssue[] = [...gateBlockingIssues, ...gateFailedChecklist];
    const nonDeliverable = gateIssues.length > 0;
    if (nonDeliverable && !body.allowNonDeliverable) {
      return res.status(422).json({
        error: 'EXPORT_GATE_BLOCKED',
        message: `导出门禁未通过（${gateIssues.length} 项阻断），文档未达交付标准，已阻止导出。请补齐后重新生成；如确需留档，可选择「仍要导出（非交付物）」——该产物文件名将强制标注「非交付物」，不得作为正式成果提交。`,
        issues: gateIssues.slice(0, 20),
      });
    }
    res.setHeader('X-Export-Gate-Passed', nonDeliverable ? 'false' : 'true');
    // 非交付物显式声明（恒置位，前端据 'true' 在文件名与界面双标注；缺失/不可解析一律按交付物处理由前端兜底）
    res.setHeader(NON_DELIVERABLE_HEADER, nonDeliverable ? 'true' : 'false');
    if (nonDeliverable) {
      res.setHeader('X-Export-Gate-Issues', encodeURIComponent(JSON.stringify(gateIssues.map(item => item.message).slice(0, 20))));
    }
    // L1-3：后缀在 safeFileName 截断之后追加，避免标记被 80 字符上限截掉
    const filename = nonDeliverable ? markNonDeliverableFilename(safeFileName(title)) : safeFileName(title);
    // Markdown 格式直接返回文本
    if (format === 'markdown') {
      archiveExportReport(record, format, projectRoot, renderAuditReport, gateIssues);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.md`)}`);
      return res.status(200).send(markdown);
    }
    // DOCX 格式
    if (format === 'docx') {
      const blockersBeforeDocx = audit.blockers.length;
      const docxBuild = await buildDocx(title, markdown, exportSettings, body.wordTemplatePath, projectRoot, audit);
      const docx = docxBuild.buffer;
      // L4-1：模板占位符缺失时的回退必须**可见**（响应头 + 导出报告），不得静默
      if (docxBuild.templateWarning) {
        res.setHeader('X-Export-Template-Warning', encodeURIComponent(docxBuild.templateWarning));
        console.error(`[export] ${docxBuild.templateWarning}`);
      }
      // 4.56 L4-2：docx 阶段的审计必须与产物同批出闸——此前 docx 阶段的操作/违规**完全不进审计**
      // （响应头与归档只反映 prepareExportMarkdown 那一段）。现以同一 audit 刷新响应头与归档。
      const docxAuditReport = audit.mode === 'off' ? undefined : exportRenderAuditReport(audit);
      if (docxAuditReport) res.setHeader('X-Export-Render-Audit', encodeURIComponent(JSON.stringify(docxAuditReport)));
      // enforce：docx 渲染阶段**新增**的正文改动/丢字同样阻断（产物已生成但不得作为交付物出闸）
      if (audit.mode === 'enforce' && audit.blockers.length > blockersBeforeDocx) {
        const docxBlockers = audit.blockers.slice(blockersBeforeDocx);
        return res.status(422).json({
          error: 'EXPORT_RENDER_NOT_PURE',
          message: `docx 渲染阶段存在未声明的正文改动，已按纯渲染模式阻断：${docxBlockers.slice(0, 3).map(item => item.message).join('；')}`,
          issues: docxBlockers.slice(0, 20),
        });
      }
      archiveExportReport(record, format, projectRoot, docxAuditReport || renderAuditReport, gateIssues);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.docx`)}`);
      return res.status(200).send(docx);
    }
    // HTML 和 PDF 需要将 Markdown 渲染为 HTML
    const html = await buildExportHtml(title, markdown, exportSettings, projectRoot, composition?.formatRules.monoColor === true);
    if (format === 'html') {
      archiveExportReport(record, format, projectRoot, renderAuditReport, gateIssues);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.html`)}`);
      return res.status(200).send(html);
    }
    try {
      const pdf = await renderPdfBuffer(html, exportSettings, composition?.formatRules);
      const pages = pdfPageCount(pdf);
      // 标书编制规格：总页数上限（超页扣分项）→ 响应头显性提示（不阻断导出，交编制人复核）
      const pageLimit = composition?.formatRules.pageLimit;
      if (pageLimit && pages && pages > pageLimit) res.setHeader('X-Export-Page-Limit', encodeURIComponent(`超出招标规定总页数上限：当前 ${pages} 页 / 上限 ${pageLimit} 页`));
      archiveExportReport(record, format, projectRoot, renderAuditReport, gateIssues);
      res.setHeader('Content-Type', 'application/pdf');
      if (pages) res.setHeader('X-PDF-Page-Count', String(pages));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${filename}.pdf`)}`);
      return res.status(200).send(pdf);
    } catch (error) {
      recordErrorLog({ level: 'error', source: 'api/documents/export', functionName: 'pdfExportChromium', error, req, meta: { fallback: 'system-browser-attempted' } });
      return res.status(500).json({ error: 'PDF_RENDER_FAILED', message: 'PDF 渲染失败：未找到或无法启动可用的 Chrome/Chromium/Edge。请安装 Chrome，或设置 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 后重试。' });
    }
}

export const __documentExportTest__ = { inlineLocalImages, resolveLocalImagePath, normalizeExportUnits, normalizeLooseMarkdownTables, normalizeParagraphs, createExportRenderAudit, exportPureRenderMode, exportRenderAuditReport, canonicalExportText, exportConservationDiff, diffCanonicalText, docxVisibleText, canonicalDocxText, docxStageConservationDiff, prepareExportMarkdown, stripInlineMarkdown, enhanceTocHtml, buildExportHtml, buildDocx, markdownToDocxXml, validateExportMarkdown, stripDeclaredNonDeliverable, applyDeclaredStrips, exportStructureFingerprint, reconcileTocFromBody, exportPipelineStages, changedSpan, isFabricatedTableSeparator, fabricatedTableSeparatorRow, looksLikeHeaderRow, isTableCaptionLine, DOCX_TOC_FIELD_PLACEHOLDER };

export default withApiErrorBoundary('api/documents/export', handler);
