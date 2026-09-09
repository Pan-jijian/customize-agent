/**
 * tableRepairHelpers：表格确定性修复辅助函数（表格专轮 LLM 修复失败后的兜底 + 交付前全文级兜底）。
 * P2 拆分（方案 5.2）：由 documentPipeline.ts 机械搬迁而来，函数体逐字一致（行为保持）。
 */
import { stripTableCellInvisibleChars } from './helpers/markdownCleanup';

/** 按表头第一列锚点从 markdown 中提取缺陷表格块（表头行到最后一个连续表格行；找不到返回空串） */
export function extractTableBlockByAnchor(content: string, anchor: string): string {
  if (!anchor) return '';
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*\|/u.test(lines[index]) || !lines[index].includes(anchor)) continue;
    let start = index;
    while (start > 0 && /^\s*\|/u.test(lines[start - 1])) start -= 1;
    let end = index;
    while (end + 1 < lines.length && /^\s*\|/u.test(lines[end + 1])) end += 1;
    return lines.slice(start, end + 1).join('\n');
  }
  return '';
}

/**
 * 表格空单元格/占位缺陷确定性兜底（LLM 修复失败后的最后防线，只做不引入新错误的确定性操作）：
 * 1. 合计/小计/总计/累计行的空单元格 → 填“—”（检测器按行业惯例豁免）；
 * 2. 表名占首格（表头首格以“表”结尾且数据行末列全空）→ 表头删首格、数据行删末格，列对齐归一；
 * 3. 数据行全空列 → 删除整列（含表头）；4. 零星空单元格 → 删除所在数据行；
 * 5. 删到只剩表头/分隔线时整个表格块删除（表格已无意义）。
 * 无缺陷表格原样返回。删除动作计数返回供进度留痕。
 */
export function repairTableBlockLines(rawLines: string[]): { lines: string[]; removed: number } {
  const rows = rawLines.map(line => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => stripTableCellInvisibleChars(cell.trim())));
  if (rows.length < 2) return { lines: rawLines, removed: 0 };
  const dividerIndex = rows.length > 1 && rows[1].length > 0 && rows[1].every(cell => /^:?-{2,}:?$/u.test(cell)) ? 1 : 0;
  const width = () => Math.max(...rows.map(row => row.length));
  let removed = 0;
  let changed = false;
  // 1. 合计行空单元格 → “—”
  for (let rowIndex = dividerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!/^(?:合计|小计|总计|累计)/u.test(row[0] || '')) continue;
    for (let col = 1; col < row.length; col += 1) {
      if (row[col] === '') { row[col] = '—'; changed = true; }
    }
  }
  // 2. 表名占首格归一：表头首格以“表”结尾、数据行末列全空且数据行首列非空 → 表头删首格、数据行删末格
  const header = rows[0];
  const dataRows = rows.slice(dividerIndex + 1);
  if (dataRows.length > 0 && /表$/u.test(header[0] || '') && dataRows.every(row => row.length > 0 && row[row.length - 1] === '') && dataRows.some(row => row[0] !== '')) {
    rows[0] = header.slice(1);
    for (let rowIndex = dividerIndex + 1; rowIndex < rows.length; rowIndex += 1) rows[rowIndex] = rows[rowIndex].slice(0, rows[rowIndex].length - 1);
    changed = true;
    removed += 1;
  }
  // 3. 数据行全空列 → 删除整列
  if (rows.length > dividerIndex + 1) {
    const colsToDrop: number[] = [];
    for (let col = 0; col < width(); col += 1) {
      const allEmpty = rows.slice(dividerIndex + 1).every(row => (row[col] || '') === '');
      if (allEmpty) colsToDrop.push(col);
    }
    if (colsToDrop.length > 0) {
      for (const row of rows) for (let k = colsToDrop.length - 1; k >= 0; k -= 1) row.splice(colsToDrop[k], 1);
      changed = true;
      removed += 1;
    }
  }
  // 4. 零星空单元格/占位符单元格 → 删除所在数据行（4.12.12 扩围：—/若干/约/待定/N/A 占位与
  // 空单元格同口径确定性删行，消除 LLM 修复不收敛的表格占位符残留；合计/小计/总计/累计行豁免）
  const PLACEHOLDER_CELL_RE = /^(?:—+|-+|\/|N\/A|n\/a|待定|待补充|待确认|待查|待补|若干|暂无|无数据)$/u;
  // 规格型号列的“—”为「机具无型号」不适用语义（蛙式打夯机等小型机具），与合计行同口径豁免，
  // 不删行——删行会丢失真实投入的机具信息，且与检测层/注入层豁免口径一致（三层一致化）
  const isSpecModelColumn = (col: number) => /规格型号|规格|型号/u.test(rows[0][col] || '');
  for (let rowIndex = rows.length - 1; rowIndex > dividerIndex; rowIndex -= 1) {
    if (/^(?:合计|小计|总计|累计)/u.test(rows[rowIndex][0] || '')) continue;
    if (!rows[rowIndex].some((cell, col) => {
      if (isSpecModelColumn(col) && /^(?:—+|-+)$/u.test(cell)) return false;
      return cell === '' || PLACEHOLDER_CELL_RE.test(cell);
    })) continue;
    rows.splice(rowIndex, 1);
    changed = true;
    removed += 1;
  }
  // 4.5 “约82kW”模糊前缀归一（约N 占位表述在交付口径属占位符，数值确定化后不再阻断）
  for (let rowIndex = dividerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let col = 0; col < row.length; col += 1) {
      if (!/^约\d/u.test(row[col] || '')) continue;
      row[col] = (row[col] || '').replace(/^约/u, '');
      changed = true;
    }
  }
  // 5. 删到只剩表头/分隔线时整个表格块删除
  if (rows.length <= dividerIndex + 1) {
    rows.splice(0, rows.length);
    changed = true;
    removed += 1;
  }
  if (!changed) return { lines: rawLines, removed: 0 };
  const rebuilt = rows.map((row, rowIndex) => (rowIndex === dividerIndex ? `| ${row.map(() => '---').join(' | ')} |` : `| ${row.join(' | ')} |`));
  return { lines: rebuilt, removed };
}

/** 按表头第一列锚点定位单张缺陷表格并做确定性修复（表格专轮 LLM 修复失败后的兜底） */
export function repairTableBlockDeterministically(content: string, tableAnchor: string): { content: string; removed: number } {
  const block = extractTableBlockByAnchor(content, tableAnchor);
  if (!block) return { content, removed: 0 };
  const repaired = repairTableBlockLines(block.split(/\r?\n/u));
  return repaired.removed > 0 ? { content: content.replace(block, repaired.lines.join('\n')), removed: repaired.removed } : { content, removed: 0 };
}

/**
 * markdown 全文级表格确定性修复（round-19 R5）：交付前兜底。表格专轮修复之后全维度评审轮修复
 * 可能重写表格引入空单元格（徽光阁实测危险源辨识表“高处作业坠落”行末两列空），交付前逐块
 * 做与专轮兜底同口径的确定性修复，只做不引入新错误的确定性操作。
 */
export function repairTableBlocksInMarkdownDeterministically(markdown: string): { markdown: string; removed: number } {
  const lines = markdown.split(/\r?\n/u);
  const result: string[] = [];
  let removed = 0;
  let index = 0;
  while (index < lines.length) {
    if (!/^\s*\|/u.test(lines[index])) { result.push(lines[index]); index += 1; continue; }
    let end = index;
    while (end + 1 < lines.length && /^\s*\|/u.test(lines[end + 1])) end += 1;
    const repaired = repairTableBlockLines(lines.slice(index, end + 1));
    if (repaired.removed > 0) removed += 1;
    result.push(...repaired.lines);
    index = end + 1;
  }
  return { markdown: result.join('\n'), removed };
}
