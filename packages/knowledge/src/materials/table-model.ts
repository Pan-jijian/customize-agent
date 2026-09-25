/**
 * 表格块模型（4.61）：表格**还原为行列**，不再拍平成文本。
 *
 * ## 为什么
 *
 * 现行路径把 xls/PDF/DWG 表格序列化成 Markdown 文本行。清单的「项目特征描述」是多行文本，
 * 拍平后与相邻列串行错位（实测终稿出现「1．土壤类别：现场现状土 2．其他要求：…」被截进
 * 相邻列的行）；表头行与数据行、合计行与明细行的区分也在拍平后丢失，导致
 * 「合计行与阶段明细之和不符」这类检测只能靠猜。
 *
 * ## 出口契约
 *
 * 本模块只产出 `TableBlock`（含表头层级、行列、合并跨度、源行号），
 * **不产出拼接字符串**。渲染成文本是消费层的事。
 */
import type { SourceAnchor } from './types.js';

/** 表格行：单元格文本 + 源行号 + 合并跨度 */
export interface TableRow {
  /** 源文件中的行号（1 基；PDF 为页内行号，XLS 为工作表行号，DWG 为表内序号） */
  rowNumber: number;
  cells: string[];
  /** 各格横向合并跨度（缺省 1）；用于把跨列标题还原到正确列位 */
  spans?: number[];
}

/** 表格块：一次表格解析的完整产物 */
export interface TableBlock {
  /** 工作表名（XLS）/ 图框或表名（DWG）/ 页号（PDF） */
  sheet?: string;
  /** 表标题（表名行，如「E.1 分部分项工程量清单计价表 工程名称：1#厂房土建工程」） */
  caption?: string;
  /** 多级表头的层级路径（外层 → 内层），用于把「金额（元）→ 综合单价」还原成两级列名 */
  headerPath: string[][];
  /** 展开后的叶子表头（与 `TableRow.cells` 等长） */
  header: string[];
  rows: TableRow[];
  /** 附录：本表在源文件中的位置 */
  anchor: Omit<SourceAnchor, 'entityType'> & { entityType?: string };
}

/**
 * 表头行识别：连续从首行起、**不含数值**且与数据行形态明显不同的行视为表头。
 *
 * 判据（形状，无词表）：
 * - 该行所有非空格不含「数值+单位」形态（表头是列名，不会是工程量）；
 * - 该行非空单元格数与数据行主频宽度一致或更宽；
 * - 该行不含句末标点（表头不是句子）。
 */
export function detectHeaderRows(rows: TableRow[]): number {
  let count = 0;
  for (const row of rows) {
    const nonEmpty = row.cells.filter(cell => cell.trim());
    if (nonEmpty.length === 0) break;
    const numericLike = nonEmpty.filter(cell => /^\d+(?:[.,]\d+)*\s*(?:[a-zA-Z℃Ω%²³]+|\p{Script=Han}{0,4})?$/u.test(cell.trim())).length;
    const sentenceLike = nonEmpty.some(cell => /[。；;]/u.test(cell));
    if (numericLike / nonEmpty.length > 0.3) break;
    if (sentenceLike) break;
    count += 1;
    if (count >= 4) break; // 防御：表头不可能超过 4 级
  }
  return count;
}

/**
 * 合并单元格展开：跨 `n` 列的单元格占据 `n` 个列位（值 + `n-1` 个空位），
 * **并跳过被吸收的源单元格**（源数组里那些以空串占位的列不再各自输出一格）。
 *
 * 计数错误会直接改变列数 → 列角色索引随之错位（`项目特征` 被当成 `工程量`）。
 * 纵向合并不展开：留给消费层按"上下同值即继承"处理，因为纵向语义随表而异。
 */
export function expandColumnSpans(row: TableRow): string[] {
  if (!row.spans || row.spans.every(span => span <= 1)) return row.cells;
  const expanded: string[] = [];
  for (let index = 0; index < row.cells.length;) {
    const span = Math.max(1, row.spans[index] ?? 1);
    expanded.push(row.cells[index] ?? '');
    for (let i = 1; i < span; i += 1) expanded.push('');
    index += span;
  }
  return expanded;
}

/**
 * 多级表头合成叶子列名：`[[金额（元）, '', ''], [综合单价, 合价, 其中]]`
 * → `['金额（元）·综合单价', '金额（元）·合价', '金额（元）·其中']`。
 *
 * 空格位是**横向合并**的展开产物（`金额（元）` 跨 3 列），因此上级标签要**向左继承**
 *（横向 carry），而不是只记住"本列上一次的非空值"——后者会让被跨的列丢失上级前缀，
 * 产出 `合价` 而不是 `金额（元）·合价`。
 */
export function flattenHeaderPath(headerPath: string[][]): string[] {
  if (headerPath.length === 0) return [];
  const width = Math.max(...headerPath.map(row => row.length), 0);
  const carried: string[] = new Array(width).fill('');
  for (let level = 0; level < headerPath.length - 1; level += 1) {
    const row = headerPath[level]!;
    let leftward = '';
    for (let col = 0; col < width; col += 1) {
      const raw = (row[col] ?? '').trim();
      const label = raw || leftward; // 空格位继承左侧标签（横向合并展开产物）
      if (raw) leftward = raw;
      if (!label) continue;
      carried[col] = carried[col] ? `${carried[col]}·${label}` : label;
    }
  }
  const last = headerPath[headerPath.length - 1]!;
  const leaf: string[] = [];
  let leftward = '';
  for (let col = 0; col < width; col += 1) {
    const raw = (last[col] ?? '').trim();
    const label = raw || leftward;
    if (raw) leftward = raw;
    leaf.push([carried[col], label].filter(Boolean).join('·'));
  }
  return leaf;
}

/** 表格块的规整化：识别表头层级、展开合并、裁掉全空列 */
export function normalizeTableBlock(block: TableBlock): TableBlock {
  const headerRowCount = detectHeaderRows(block.rows);
  const headerRows = block.rows.slice(0, headerRowCount).map(row => expandColumnSpans(row));
  const bodyRows = block.rows.slice(headerRowCount).map(row => ({ ...row, cells: expandColumnSpans(row) }));
  const header = headerRows.length > 0 ? flattenHeaderPath(headerRows) : block.header;
  // 全空列裁剪（表尾的空列在源文件里常见）
  const width = Math.max(header.length, ...bodyRows.map(row => row.cells.length), 0);
  const keep: number[] = [];
  for (let col = 0; col < width; col += 1) {
    const hasHeader = Boolean((header[col] ?? '').trim());
    const hasData = bodyRows.some(row => Boolean((row.cells[col] ?? '').trim()));
    if (hasHeader || hasData) keep.push(col);
  }
  return {
    ...block,
    headerPath: headerRows.length > 0 ? headerRows : block.headerPath,
    header: keep.map(col => header[col] ?? ''),
    rows: bodyRows.map(row => ({ ...row, cells: keep.map(col => row.cells[col] ?? '') })),
  };
}

/**
 * 列角色解析：按**表头语义**给出列索引（不写死列序——不同清单模板列序不同）。
 *
 * 返回 undefined 表示该表没有这一列；调用方据此决定走哪条事实抽取路径。
 */
export interface TableColumnRoles {
  code?: number;
  name?: number;
  feature?: number;
  unit?: number;
  quantity?: number;
  /** 「项目特征描述」的列别名（不同模板写法不同） */
  detail?: number;
}

const COLUMN_ROLE_PATTERNS: ReadonlyArray<[keyof TableColumnRoles, RegExp]> = [
  ['code', /项目编码|编码|清单编码/u],
  ['name', /项目名称|名称|材料\/?设备名称|设备名称|材料名称/u],
  ['feature', /项目特征|特征描述/u],
  ['unit', /计量单位|单位/u],
  ['quantity', /工程量|数量/u],
];

export function resolveTableColumnRoles(header: string[]): TableColumnRoles {
  const roles: TableColumnRoles = {};
  header.forEach((cell, index) => {
    for (const [role, pattern] of COLUMN_ROLE_PATTERNS) {
      if (roles[role] !== undefined) continue;
      if (pattern.test(cell)) roles[role] = index;
    }
  });
  return roles;
}

/**
 * 「项目特征」单元格 → 属性键值对。
 *
 * 清单特征用「1．… 2．… 3．…」分项书写（实测巢湖清单：`1．土壤类别：现场现状土
 * 2．其他要求：… 3．未尽事宜：详见施工图纸…`），分项内是「键：值」。
 * 这是**清单里唯一的结构化事实来源**——拍平成一行就再也取不出来。
 */
export function parseFeatureCell(cell: string): Array<{ key: string; value: string }> {
  const parts = cell
    .split(/(?:^|\s)(?=\d{1,2}\s*[．.、)）])/u)
    .map(part => part.replace(/^\s*\d{1,2}\s*[．.、)）]\s*/u, '').trim())
    .filter(Boolean);
  const pairs: Array<{ key: string; value: string }> = [];
  for (const part of parts) {
    const match = /^([^：:]{1,12})[：:]\s*(.+)$/su.exec(part);
    if (match) pairs.push({ key: match[1]!.trim(), value: match[2]!.trim() });
  }
  return pairs;
}
