import { loadBetterSqlite3 } from '@customize-agent/knowledge';
import type Database from 'better-sqlite3';

/**
 * 清单解析器（蓝图阶段 0 数据源，确定性零 LLM）：
 * 解析 kb.db 中分部分项工程量清单计价表的 chunks → 清单条目库 + 完整性校验。
 *
 * kb.db 中同一张 E.1 分部分项表存在两套 chunk 形态（实测丰乐镇 739 chunks）：
 * 1. markdown 表格 chunks（section_title 为「表格数据」/「表标题：E.1…」/「第 N 部分」）——
 *    完整表格行：| 序号 | 项目编码 | COL3 | 项目名称 | 项目特征描述 | 计量单位 | COL7 | 工程量 | …；
 *    chunk 边界可能把表格行从中间截断（下一 chunk 以行后半段开头，无前导 |）；
 * 2. 「表格路径声明」chunks（section_title 含「表格路径声明」）——单元格级 R{n}C{m} 声明，
 *    只可靠保留序号/特征描述/单位/工程量，项目编码与名称常为空声明。
 * 解析策略：markdown 为主源（编码/名称完整），声明格式按序号补缺（兜底缺失页），
 * 两源合并后按序号连续性 + 页码覆盖做完整性校验，实现「条目零丢失」。
 */

/** 清单条目（合并两源后的最终口径） */
export interface BoqEntry {
  /** 清单内序号（各村从 1 起） */
  seq: number;
  /** 项目编码（声明格式补缺条目可能为空） */
  code: string;
  /** 项目名称（声明格式补缺条目可能为空） */
  name: string;
  /** 项目特征描述原文 */
  description: string;
  /** 计量单位 */
  unit: string;
  /** 工程量 */
  quantity: number;
  /** 所属分部（如「道路工程」） */
  section: string;
  /** 所属分节（如「新建混凝土道路」） */
  subsection: string;
  /** 分部类型：unit-project=单位工程（如清单「2.3 公厕」，其内部子分部聚合为小节下工作包要点）；plain=普通分部 */
  sectionKind?: 'unit-project' | 'plain';
  /** 所属自然村分组（清单表头「工程名称」） */
  villageGroup: string;
  /** 所在页码（markdown 源可回溯） */
  page?: number;
  /** 来源文件（kb.db relative_path） */
  sourceFile: string;
  /** 来源 chunk 序号 */
  chunkIndex: number;
  /** 来源格式 */
  sourceKind: 'markdown' | 'declaration';
}

/** 单个自然村分组（工作表）的解析与完整性诊断 */
export interface BoqVillageReport {
  villageGroup: string;
  sheetId: string;
  /** 表头声明的总页数（第1页 共M页） */
  totalPagesDeclared?: number;
  /** markdown chunks 覆盖的页码集合 */
  pagesCovered: number[];
  /** 缺失页码（markdown 无覆盖，条目由声明格式补缺） */
  pagesMissing: number[];
  entryCount: number;
  /** 序号缺口（条目零丢失判定依据） */
  entrySeqMissing: number[];
  /** 来自声明格式补缺的条目数 */
  entriesFromDeclaration: number;
  /** 缺项目编码的条目数 */
  entriesWithoutCode: number;
  /** 缺项目名称的条目数 */
  entriesWithoutName: number;
  /** 编码格式不合规的条目数（12 位数字 / ZB+12 / WB+12） */
  entriesWithInvalidCode: number;
  /** 完整性判定：序号连续无缺 */
  complete: boolean;
}

/** 解析结果 */
export interface BillOfQuantitiesResult {
  entries: BoqEntry[];
  villages: BoqVillageReport[];
  totalEntries: number;
  sourceFile: string;
  /** 整体完整性：全部村庄 complete 且至少解析到条目 */
  complete: boolean;
  diagnostics: {
    totalChunks: number;
    markdownChunks: number;
    declarationChunks: number;
    skippedChunks: number;
    /** 解析中被丢弃的不完整行（跨 chunk 截断拼接失败） */
    droppedIncompleteRows: number;
  };
}

/** 解析输入：kb.db 中该文件的 chunks（由 loadBoqChunksFromKb 读取） */
export interface BoqChunkRow {
  chunkIndex: number;
  content: string;
  sectionTitle: string;
}

/** 表格列位（表头驱动动态识别）：清单表格存在多种列序——丰乐镇 9 列带空列（项目名称在第 4 列）、
 * 舒城 6 列紧凑形态（项目名称在第 3 列）；固定列位假设使舒城整表字段错位（特征当名称、单位当特征、
 * 工程量数字当单位、数量列落空），须按表头行解析列索引后逐行取值 */
interface BoqTableLayout {
  seq: number;
  code: number;
  name: number;
  description: number;
  unit: number;
  quantity: number;
}

/** 默认列位（丰乐镇形态）：无表头行的续页 chunk 沿用最近一次识别结果 */
const DEFAULT_BOQ_TABLE_LAYOUT: BoqTableLayout = { seq: 1, code: 2, name: 4, description: 5, unit: 6, quantity: 8 };

/** 表头行判定：含「序号」+「项目编码」两列名 */
function isBoqHeaderRow(cells: string[]): boolean {
  const normalized = cells.map(cell => cell.replace(/\s+/gu, ''));
  return normalized.includes('序号') && normalized.includes('项目编码');
}

/** 表头行 → 列位（缺任一必需列名返回 undefined，保持上一布局） */
function resolveBoqTableLayout(cells: string[]): BoqTableLayout | undefined {
  const normalized = cells.map(cell => cell.replace(/\s+/gu, ''));
  const indexOf = (names: string[]) => normalized.findIndex(cell => names.includes(cell));
  const seq = indexOf(['序号']);
  const code = indexOf(['项目编码']);
  const name = indexOf(['项目名称']);
  const unit = indexOf(['计量单位', '单位']);
  const quantity = indexOf(['工程量']);
  if (seq < 0 || code < 0 || name < 0 || unit < 0 || quantity < 0) return undefined;
  return { seq, code, name, description: indexOf(['项目特征描述']), unit, quantity };
}

/** 分部/分节行编码形态：中文数字 / 数字（可带 x.y 子级）——12 位项目编码除外 */
function isSectionCode(value: string): boolean {
  return /^[一二三四五六七八九十\d]+(?:\.\d+)?$/u.test(value.trim()) && !CODE_PATTERN.test(value.trim());
}

const CODE_PATTERN = /^(?:\d{12}|(?:ZB|WB)\d{12})$/u;
// 工作表编号：x.y（丰乐镇）与纯数字（舒城多单位工程清单分册）两种形态
const SHEET_ID_PATTERN = /工作表：(\d+(?:\.\d+)?)/u;
const TOTAL_PAGES_PATTERN = /第1页\s*共(\d+)页/u;
const VILLAGE_PATTERN = /工程名称：(.+?)\s*标段/u;
// 工程名称行尾形态（无「标段」后缀）：舒城清单每文件表头「工程名称：{单位工程名}」
const VILLAGE_NAME_PATTERN = /工程名称：([^\n|｜]{2,40}?)\s*$/mu;
const PAGE_PATTERN = /第(\d+)页\s*共\d+页/gu;

/** 读取 kb.db 中指定文件的全部 chunks（按 chunk_index 排序）；文件不存在返回空数组 */
export function loadBoqChunksFromKb(dbPath: string, filePath: string): BoqChunkRow[] {
  const Sqlite = loadBetterSqlite3();
  const db: Database.Database = new Sqlite(dbPath, { readonly: true });
  try {
    db.pragma('busy_timeout = 10000');
    const rows = db.prepare(
      'SELECT chunk_index, content, section_title FROM kb_chunks WHERE relative_path = ? ORDER BY chunk_index',
    ).all(filePath) as Array<{ chunk_index: number; content: string; section_title: string }>;
    return rows.map(row => ({ chunkIndex: row.chunk_index, content: row.content, sectionTitle: row.section_title || '' }));
  } finally {
    db.close();
  }
}

/** 从绑定资料相对路径中识别清单文件（含「工程量清单」且为 .xls，封面/编制说明只按文件名排除，不误杀目录名） */
export function pickBillOfQuantityFiles(boundFilePaths: string[]): string[] {
  return boundFilePaths
    .filter(filePath => /工程量清单/u.test(filePath) && filePath.toLowerCase().endsWith('.xls'))
    .filter(filePath => {
      const baseName = filePath.split('/').pop() || filePath;
      return !/封面|编制说明/u.test(baseName);
    });
}

/** 解析清单 chunks（纯函数，不依赖 db，便于单测） */
export function parseBillOfQuantities(input: { chunks: BoqChunkRow[]; sourceFile?: string }): BillOfQuantitiesResult {
  const sourceFile = input.sourceFile || '';
  const diagnostics = { totalChunks: input.chunks.length, markdownChunks: 0, declarationChunks: 0, skippedChunks: 0, droppedIncompleteRows: 0 };
  const markdownChunks: BoqChunkRow[] = [];
  const declarationChunks: BoqChunkRow[] = [];
  for (const chunk of input.chunks) {
    const title = chunk.sectionTitle;
    const isDeclaration = title.includes('表格路径声明');
    const isAppendix = title.includes('附录');
    if (isAppendix) {
      diagnostics.skippedChunks++;
      continue;
    }
    if (isDeclaration) {
      declarationChunks.push(chunk);
      diagnostics.declarationChunks++;
    } else if (title === '表格数据' || title.includes('表标题') || title.includes('第') || title.includes('工作表：')) {
      markdownChunks.push(chunk);
      diagnostics.markdownChunks++;
    } else {
      diagnostics.skippedChunks++;
    }
  }

  // 1. 建立 工作表编号 → 村庄分组/总页数 映射（表标题类 section_title 与内容首行中提取，单行无换行）
  const sheetMeta = new Map<string, { villageGroup: string; totalPages?: number }>();
  const registerSheetMeta = (text: string) => {
    const sheetMatch = SHEET_ID_PATTERN.exec(text);
    if (!sheetMatch) return;
    const sheetId = sheetMatch[1];
    const existing = sheetMeta.get(sheetId);
    const villageMatch = VILLAGE_PATTERN.exec(text) || VILLAGE_NAME_PATTERN.exec(text);
    const totalMatch = TOTAL_PAGES_PATTERN.exec(text);
    if (existing) {
      if (!existing.villageGroup && villageMatch) existing.villageGroup = villageMatch[1].trim();
      if (existing.totalPages === undefined && totalMatch) existing.totalPages = Number(totalMatch[1]);
    } else {
      sheetMeta.set(sheetId, {
        villageGroup: villageMatch ? villageMatch[1].trim() : '',
        totalPages: totalMatch ? Number(totalMatch[1]) : undefined,
      });
    }
  };
  for (const chunk of markdownChunks) {
    registerSheetMeta(chunk.sectionTitle);
    registerSheetMeta(chunk.content.split('\n')[0] || '');
  }

  // 2. markdown 主源解析：状态机处理表格行 + 跨 chunk 截断拼接 + 分部/分节标题跟踪
  const markdownEntries: BoqEntry[] = [];
  let carryover = '';
  let section = '';
  let subsection = '';
  let sectionKind: 'unit-project' | 'plain' = 'plain';
  // 清单三层结构识别（丰乐镇实测：清单分部分节编码存在三种层级——中文数字=顶层分部（一、道路工程）、
  // x.y=子目或单位工程（1.1 新建混凝土道路 / 2.3 公厕）、纯数字=单位工程内部子分部（0101 土石方工程）。
  // 历史缺陷：状态机把「2.3 公厕」当 subsection 丢弃层级，把「0101 土石方工程」等子分部升级为顶层
  // section → 蓝图大纲把公厕 15 个子分部平铺成 15 个独立小节（门窗工程/幕墙工程等房建通用分部名）。
  // 预扫描分节行序列做前瞻判定：x.y 行后跟纯数字行 → 单位工程（section=单位工程名），其内部纯数字
  // 行降级为 subsection；主循环按同一行序对齐分类结果
  const sectionRowKinds = classifySectionRows(collectSectionRowCodes(markdownChunks));
  let sectionRowIndex = -1;
  // 当前表格列位（表头行刷新）：清单表格列序随来源变化，固定列位假设会造成整表字段错位
  let tableLayout = DEFAULT_BOQ_TABLE_LAYOUT;
  // 工作表编号继承：无编号的续页 chunk 归属上一 chunk 的工作表（同 sheet 的 chunk 按序相邻）
  let lastSheetId = '';
  for (const chunk of markdownChunks) {
    const resolved = resolveChunkSheetId(chunk);
    const sheetId = resolved || lastSheetId;
    if (resolved) lastSheetId = resolved;
    const meta = sheetMeta.get(sheetId);
    const villageGroup = meta?.villageGroup || sheetId || '';
    const lines = chunk.content.split('\n');
    // 跨 chunk 截断：上一 chunk 未闭合行 + 本 chunk 首行（无前导 |）拼接
    let buffer = carryover;
    carryover = '';
    const chunkStartPage = extractChunkStartPage(chunk.content);
    let page = chunkStartPage;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      if (line.startsWith('|')) {
        if (buffer.trim()) {
          // 上一行未闭合而新行以 | 开头：上一行实为截断残段，丢弃并记录
          diagnostics.droppedIncompleteRows++;
        }
        buffer = line;
      } else if (buffer) {
        // 表格行内嵌换行延续（特征描述跨行/跨 chunk 后半段）
        buffer += line;
      } else {
        // 非表格行（工作表声明/footer 续行等），可能携带页码信息
        const pageMatch = PAGE_PATTERN.exec(line);
        if (pageMatch) page = Number(pageMatch[1]);
        PAGE_PATTERN.lastIndex = 0;
        continue;
      }
      if (buffer.endsWith('|')) {
        const cells = buffer.split('|').map(cell => cell.trim());
        buffer = '';
        // 表头行刷新列位：清单表格列序随来源变化（丰乐镇 9 列/舒城 6 列），逐表头重新识别
        if (isBoqHeaderRow(cells)) {
          tableLayout = resolveBoqTableLayout(cells) ?? tableLayout;
        }
        const seqCell = cells[tableLayout.seq] ?? '';
        const codeCell = cells[tableLayout.code] ?? '';
        const nameCell = cells[tableLayout.name] ?? '';
        // footer 页码行（第N页 共M页）先更新 page，后续条目行归属新页
        const rowPage = page;
        const pageInRow = rowPageMatch(cells);
        if (pageInRow) page = pageInRow;
        if (/^\d+$/u.test(seqCell) && CODE_PATTERN.test(codeCell)) {
          // 条目行：序号 + 合法项目编码
          const quantity = Number((cells[tableLayout.quantity] ?? '').trim());
          const entry: BoqEntry = {
            seq: Number(seqCell),
            code: codeCell,
            name: nameCell,
            description: tableLayout.description >= 0 ? (cells[tableLayout.description] ?? '') : '',
            unit: cells[tableLayout.unit] ?? '',
            quantity: Number.isFinite(quantity) ? quantity : 0,
            section,
            subsection,
            sectionKind,
            villageGroup,
            page: rowPage,
            sourceFile,
            chunkIndex: chunk.chunkIndex,
            sourceKind: 'markdown',
          };
          if (entry.seq > 0) markdownEntries.push(entry);
        } else if (!seqCell && isSectionCode(codeCell) && nameCell && nameCell !== '分部小计') {
          // 分部/分节标题行（序号列空、编码列「一/二/…/6/1.1」）：按预扫描层级判定分类赋值，
          // 后续条目归属该分部分节
          sectionRowIndex += 1;
          const kind = sectionRowKinds[sectionRowIndex] ?? (codeCell.includes('.') ? 'subsection' : 'section');
          if (kind === 'unit-project') {
            // 单位工程（如「2.3 公厕」）：作为独立顶层分部，其内部子分部降级为分节
            section = nameCell;
            subsection = '';
            sectionKind = 'unit-project';
          } else if (kind === 'section') {
            section = nameCell;
            subsection = '';
            sectionKind = 'plain';
          } else {
            subsection = nameCell;
          }
        }
      }
    }
    if (buffer.trim()) carryover = buffer; // 未闭合 → 传给下一 chunk
  }
  if (carryover.trim()) diagnostics.droppedIncompleteRows++;

  // 3. 声明格式兜底解析：R{n}C{m} 单元格声明 → 条目骨架（按序号补缺）
  const declarationEntries: BoqEntry[] = [];
  lastSheetId = '';
  for (const chunk of declarationChunks) {
    const resolved = resolveChunkSheetId(chunk);
    const sheetId = resolved || lastSheetId;
    if (resolved) lastSheetId = resolved;
    const meta = sheetMeta.get(sheetId);
    const villageGroup = meta?.villageGroup || sheetId || '';
    declarationEntries.push(...parseDeclarationChunk(chunk.content, { villageGroup, sourceFile, chunkIndex: chunk.chunkIndex }));
  }

  // 4. 合并：markdown 优先，声明按 (villageGroup, seq) 补缺
  const byKey = new Map<string, BoqEntry>();
  for (const entry of markdownEntries) byKey.set(`${entry.villageGroup}|${entry.seq}`, entry);
  let entriesFromDeclaration = 0;
  for (const entry of declarationEntries) {
    const key = `${entry.villageGroup}|${entry.seq}`;
    if (byKey.has(key)) continue;
    byKey.set(key, entry);
    entriesFromDeclaration++;
  }
  const entries = [...byKey.values()].sort((left, right) => left.villageGroup.localeCompare(right.villageGroup, 'zh-CN') || left.seq - right.seq);

  // 5. 分部/分节归属回填（按序号落在最近的分部/分节标题行之后）
  assignSections(entries, markdownEntries);

  // 5.1 单位工程归属兜底：整文件无分部分节结构（表格无结构行）时，表头「工程名称：X」即单位工程名，
  // 作为全部条目 section（清单文件 = 单位工程清单的常态；缺此归属时条目在蓝图侧落入内部占位桶）
  const fileVillageGroup = [...sheetMeta.values()].map(meta => meta.villageGroup).find(Boolean);
  if (fileVillageGroup && entries.every(entry => !entry.section)) {
    for (const entry of entries) {
      entry.section = fileVillageGroup;
      entry.sectionKind = 'unit-project';
    }
  }

  // 6. 完整性校验（每村）
  const villages: BoqVillageReport[] = [];
  for (const [villageGroup, groupEntries] of groupByVillage(entries)) {
    const seqs = groupEntries.map(entry => entry.seq).sort((a, b) => a - b);
    const maxSeq = seqs[seqs.length - 1] || 0;
    const seqMissing: number[] = [];
    for (let seq = 1; seq <= maxSeq; seq++) {
      if (!seqs.includes(seq)) seqMissing.push(seq);
    }
    const meta = findSheetMetaByVillage(sheetMeta, villageGroup);
    const totalPages = meta?.totalPages;
    const pagesCovered = collectPagesCovered(markdownChunks, villageGroup, meta?.sheetId);
    const pagesMissing = totalPages ? Array.from({ length: totalPages }, (_, i) => i + 1).filter(page => !pagesCovered.includes(page)) : [];
    const fromDeclaration = groupEntries.filter(entry => entry.sourceKind === 'declaration').length;
    const withoutCode = groupEntries.filter(entry => !entry.code).length;
    const withoutName = groupEntries.filter(entry => !entry.name).length;
    const invalidCode = groupEntries.filter(entry => entry.code && !CODE_PATTERN.test(entry.code)).length;
    villages.push({
      villageGroup,
      sheetId: meta?.sheetId || '',
      totalPagesDeclared: totalPages,
      pagesCovered: pagesCovered.sort((a, b) => a - b),
      pagesMissing,
      entryCount: groupEntries.length,
      entrySeqMissing: seqMissing,
      entriesFromDeclaration: fromDeclaration,
      entriesWithoutCode: withoutCode,
      entriesWithoutName: withoutName,
      entriesWithInvalidCode: invalidCode,
      complete: seqMissing.length === 0 && groupEntries.length > 0,
    });
  }
  villages.sort((left, right) => left.villageGroup.localeCompare(right.villageGroup, 'zh-CN'));

  return {
    entries,
    villages,
    totalEntries: entries.length,
    sourceFile,
    complete: villages.length > 0 && villages.every(village => village.complete),
    diagnostics,
  };
}

/** 解析声明格式 chunk：R{n}C{m} 标签 + 字段名行 + 值行（值可多行） */
function parseDeclarationChunk(
  content: string,
  context: { villageGroup: string; sourceFile: string; chunkIndex: number },
): BoqEntry[] {
  const entries: BoqEntry[] = [];
  const lines = content.split('\n');
  let current: Partial<BoqEntry> | undefined;
  let field: 'seq' | 'code' | 'name' | 'description' | 'unit' | 'quantity' | undefined;
  const flush = () => {
    if (current && typeof current.seq === 'number' && current.seq > 0) {
      entries.push({
        seq: current.seq,
        code: current.code || '',
        name: current.name || '',
        description: (current.description || '').trim(),
        unit: current.unit || '',
        quantity: typeof current.quantity === 'number' ? current.quantity : 0,
        section: '',
        subsection: '',
        villageGroup: context.villageGroup,
        sourceFile: context.sourceFile,
        chunkIndex: context.chunkIndex,
        sourceKind: 'declaration',
      });
    }
    current = undefined;
    field = undefined;
  };
  const appendValue = (text: string) => {
    if (!current || !field) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (field === 'seq') {
      const seq = Number(trimmed);
      if (Number.isFinite(seq) && seq > 0) current.seq = seq;
    } else if (field === 'code') {
      current.code = (current.code || '') + trimmed;
    } else if (field === 'name') {
      current.name = (current.name || '') + trimmed;
    } else if (field === 'description') {
      current.description = (current.description || '') + (current.description ? ' ' : '') + trimmed;
    } else if (field === 'unit') {
      current.unit = trimmed;
    } else if (field === 'quantity') {
      const qty = Number(trimmed);
      if (Number.isFinite(qty)) current.quantity = qty;
    }
  };
  for (const line of lines) {
    if (/^R\d+C\d+$/u.test(line)) {
      if (/^R\d+C1$/u.test(line)) {
        // 序号单元格：新条目开始
        flush();
        current = {};
        field = 'seq';
      } else {
        // 其他单元格声明：结束上一字段（条目保持累积，直到下一个序号单元格）
        field = undefined;
      }
      continue;
    }
    if (/^序号:$/u.test(line)) { field = 'seq'; continue; }
    if (/^项目编码:$/u.test(line)) { field = 'code'; continue; }
    if (/^项目名称:$/u.test(line)) { field = 'name'; continue; }
    if (/^项目特征描述:$/u.test(line)) { field = 'description'; continue; }
    if (/^单位:$/u.test(line)) { field = 'unit'; continue; }
    if (/^工程量:$/u.test(line)) { field = 'quantity'; continue; }
    if (/^(?:人工费|机械费|暂估价|合价|金额.*)$/u.test(line)) { field = undefined; continue; }
    appendValue(line);
  }
  flush();
  return entries;
}

/** 从 chunk 的 section_title 或内容首行解析工作表编号 */
function resolveChunkSheetId(chunk: BoqChunkRow): string {
  const fromTitle = SHEET_ID_PATTERN.exec(chunk.sectionTitle);
  if (fromTitle) return fromTitle[1];
  const firstLine = chunk.content.split('\n')[0] || '';
  const fromContent = SHEET_ID_PATTERN.exec(firstLine);
  return fromContent ? fromContent[1] : '';
}

/** 提取 chunk 起始页（表头「第1页」或首个 footer 页码）；无则 undefined */
function extractChunkStartPage(content: string): number | undefined {
  const totalMatch = TOTAL_PAGES_PATTERN.exec(content);
  if (totalMatch) return 1;
  PAGE_PATTERN.lastIndex = 0;
  const first = PAGE_PATTERN.exec(content);
  PAGE_PATTERN.lastIndex = 0;
  return first ? Number(first[1]) : undefined;
}

/** 表格行内的页码标记（footer 行「…第N页 共M页…」） */
function rowPageMatch(cells: string[]): number | undefined {
  const joined = cells.join(' ');
  const match = /第(\d+)页\s*共\d+页/u.exec(joined);
  return match ? Number(match[1]) : undefined;
}

/** 分部/分节归属回填：声明格式补缺条目按同村最近（seq ≤ 自身）的 markdown 条目继承分部分节 */
function assignSections(entries: BoqEntry[], markdownEntries: BoqEntry[]): void {
  const markdownByVillage = groupByVillage(markdownEntries);
  for (const entry of entries) {
    if (entry.sourceKind !== 'declaration' || entry.section) continue;
    const siblings = markdownByVillage.get(entry.villageGroup) || [];
    let nearest: BoqEntry | undefined;
    for (const candidate of siblings) {
      if (candidate.seq > entry.seq) break;
      nearest = candidate;
    }
    if (nearest) {
      entry.section = nearest.section;
      entry.subsection = nearest.subsection;
      entry.sectionKind = nearest.sectionKind;
    }
  }
}

/** 预扫描：按 chunk 顺序收集分节行编码序列（与主循环同源行解析，仅做层级前瞻判定用） */
function collectSectionRowCodes(markdownChunks: BoqChunkRow[]): string[] {
  const codes: string[] = [];
  let carryover = '';
  let tableLayout = DEFAULT_BOQ_TABLE_LAYOUT;
  for (const chunk of markdownChunks) {
    const lines = chunk.content.split('\n');
    let buffer = carryover;
    carryover = '';
    for (const line of lines) {
      if (line.startsWith('|')) {
        if (buffer.trim()) buffer = line; // 上一行未闭合截断残段，丢弃
        else buffer = line;
      } else if (buffer) {
        buffer += line;
      } else {
        continue;
      }
      if (!buffer.endsWith('|')) continue;
      const cells = buffer.split('|').map(cell => cell.trim());
      buffer = '';
      // 与主循环同源的表头列位识别：结构行判定同样按动态列位
      if (isBoqHeaderRow(cells)) {
        tableLayout = resolveBoqTableLayout(cells) ?? tableLayout;
        continue;
      }
      if (!(cells[tableLayout.seq] ?? '') && isSectionCode(cells[tableLayout.code] ?? '') && (cells[tableLayout.name] ?? '') && cells[tableLayout.name] !== '分部小计') {
        codes.push(cells[tableLayout.code] ?? '');
      }
    }
    if (buffer.trim()) carryover = buffer;
  }
  return codes;
}

/** 分节行层级分类：中文数字=顶层分部；x.y 行前瞻下一分节行是否纯数字（单位工程子分部编码形态）
 * ——是则当前行为单位工程，否则为普通子目；纯数字行在单位工程内部为子分部（subsection），否则为顶层分部 */
function classifySectionRows(codes: string[]): Array<'section' | 'subsection' | 'unit-project'> {
  const kinds: Array<'section' | 'subsection' | 'unit-project'> = [];
  let inUnitProject = false;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? '';
    if (code.includes('.')) {
      const next = i + 1 < codes.length ? codes[i + 1] ?? '' : '';
      const isUnitProject = /^\d+$/u.test(next) && next.length >= 2;
      kinds.push(isUnitProject ? 'unit-project' : 'subsection');
      inUnitProject = isUnitProject;
    } else if (/^\d+$/u.test(code)) {
      kinds.push(inUnitProject ? 'subsection' : 'section');
    } else {
      kinds.push('section');
      inUnitProject = false;
    }
  }
  return kinds;
}

/** 按村庄分组（保持插入序） */
function groupByVillage(entries: BoqEntry[]): Map<string, BoqEntry[]> {
  const groups = new Map<string, BoqEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.villageGroup) || [];
    list.push(entry);
    groups.set(entry.villageGroup, list);
  }
  return groups;
}

/** 由村庄名反查工作表元信息 */
function findSheetMetaByVillage(sheetMeta: Map<string, { villageGroup: string; totalPages?: number }>, villageGroup: string) {
  for (const [sheetId, meta] of sheetMeta) {
    if (meta.villageGroup === villageGroup) return { sheetId, ...meta };
  }
  return undefined;
}

/** 清单文件 → 单位工程名（招标实务：一标段多单位工程，每文件一个单位工程，文件名即单位工程名） */
export function unitProjectNameFromFile(filePath: string): string {
  const baseName = (filePath.split('/').pop() || filePath).replace(/\.xls$/iu, '');
  return baseName.replace(/[\s\u00a0]+/gu, '') || '单位工程';
}

/** 多清单文件合并（阶段 0）：一个标段的多个单位工程清单文件全部并入一份解析结果——
 * 文件即单位工程：条目 section 归一为单位工程名，文件内识别到的分节降级为 subsection（保留工作包粒度）；
 * villageGroup 同步归一（条目键 `${villageGroup}|${seq}` 跨文件唯一化，各文件 seq 独立从 1 起）；
 * 文件按父目录编号前缀排序（清单分册阅读顺序），无编号保持绑定顺序。
 * 历史缺陷：旧实现取首个解析成功文件返回，一标段 13 份单位工程清单只用了 1 份（数据范围 4.9%） */
export function mergeBillOfQuantitiesResults(parts: Array<{ filePath: string; boq: BillOfQuantitiesResult }>): BillOfQuantitiesResult {
  const orderKey = (filePath: string) => {
    const parent = filePath.split('/').slice(-2)[0] || '';
    const match = /^(\d+)/u.exec(parent);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };
  const ordered = [...parts].sort((left, right) => orderKey(left.filePath) - orderKey(right.filePath));
  const entries: BoqEntry[] = [];
  const villages: BoqVillageReport[] = [];
  const diagnostics = { totalChunks: 0, markdownChunks: 0, declarationChunks: 0, skippedChunks: 0, droppedIncompleteRows: 0 };
  const unitNames = new Set<string>();
  for (const part of ordered) {
    let unitName = unitProjectNameFromFile(part.filePath);
    if (unitNames.has(unitName)) {
      let suffix = 2;
      while (unitNames.has(`${unitName}（${suffix}）`)) suffix += 1;
      unitName = `${unitName}（${suffix}）`;
    }
    unitNames.add(unitName);
    for (const entry of part.boq.entries) {
      // 单位工程内分节降级保留（梅河东路/高清监控系统），作为单位工程小节的工作包粒度
      entry.subsection = entry.subsection || entry.section;
      entry.section = unitName;
      entry.sectionKind = 'unit-project';
      entry.villageGroup = unitName;
      entries.push(entry);
    }
    for (const [index, village] of part.boq.villages.entries()) {
      villages.push({ ...village, villageGroup: part.boq.villages.length === 1 ? unitName : `${unitName}·${village.villageGroup || `工作表${index + 1}`}` });
    }
    diagnostics.totalChunks += part.boq.diagnostics.totalChunks;
    diagnostics.markdownChunks += part.boq.diagnostics.markdownChunks;
    diagnostics.declarationChunks += part.boq.diagnostics.declarationChunks;
    diagnostics.skippedChunks += part.boq.diagnostics.skippedChunks;
    diagnostics.droppedIncompleteRows += part.boq.diagnostics.droppedIncompleteRows;
  }
  return {
    entries,
    villages,
    totalEntries: entries.length,
    sourceFile: ordered.map(part => part.filePath).join('；'),
    complete: villages.length > 0 && villages.every(village => village.complete),
    diagnostics,
  };
}

/** 收集某村庄 markdown chunks 覆盖的页码集合（表头第 1 页 ∪ footer 页码 ∪ footer 页码-1） */
function collectPagesCovered(markdownChunks: BoqChunkRow[], villageGroup: string, sheetId: string | undefined): number[] {
  const pages = new Set<number>();
  let lastSheetId = '';
  for (const chunk of markdownChunks) {
    const resolved = resolveChunkSheetId(chunk);
    const chunkSheetId = resolved || lastSheetId;
    if (resolved) lastSheetId = resolved;
    if (sheetId && chunkSheetId !== sheetId) continue;
    if (!sheetId) {
      // 无工作表编号匹配时用内容首行工程名称判断归属
      const firstLine = chunk.content.split('\n')[0] || '';
      if (!firstLine.includes(villageGroup)) continue;
    }
    if (TOTAL_PAGES_PATTERN.test(chunk.content)) pages.add(1);
    PAGE_PATTERN.lastIndex = 0;
    for (const match of chunk.content.matchAll(PAGE_PATTERN)) {
      const page = Number(match[1]);
      pages.add(page);
      if (page > 1) pages.add(page - 1);
    }
    PAGE_PATTERN.lastIndex = 0;
  }
  return [...pages];
}
