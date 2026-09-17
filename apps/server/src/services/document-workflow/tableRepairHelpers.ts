/**
 * tableRepairHelpers：表格确定性修复辅助函数（表格专轮 LLM 修复失败后的兜底 + 交付前全文级兜底）。
 * P2 拆分（方案 5.2）：由 documentPipeline.ts 机械搬迁而来，函数体逐字一致（行为保持）。
 */
import { stripTableCellInvisibleChars } from './helpers/markdownCleanup';
import { TABLE_TITLE_MIN_HAN } from './structureIntegrityRules';
import type { PlannedTablePlan } from './types';

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
 * 表格结构缺陷确定性归一（只做不引入新错误、不伪造内容的确定性操作；V2 批1-4 零兜底写入：
 * 合计行填空「—」与零星空单元格确定性删行等伪造/丢失内容的兜底已删除，占位符交检测器阻断 +
 * LLM 定向修复；r18 丰乐镇 B3 归因：空单元格残留直坠交付门禁，改为按列就近非空值确定性填充）：
 * 1. 表名占首格（表头首格以“表”结尾且数据行末列全空）→ 表头删首格、数据行删末格，列对齐归一；
 * 2. 数据行全空列 → 删除整列（含表头）；3. “约82kW”类模糊前缀归一（数值确定化）；
 * 4. 数据行空单元格 → 同列最近非空值填充（合计行除外）；5. 删到只剩表头/分隔线时整个表格块删除。
 * 无缺陷表格原样返回。修复动作计数（删除/填充）返回供进度留痕。
 */
export function repairTableBlockLines(rawLines: string[]): { lines: string[]; removed: number } {
  const rows = rawLines.map(line => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => stripTableCellInvisibleChars(cell.trim())));
  if (rows.length < 2) return { lines: rawLines, removed: 0 };
  const dividerIndex = rows.length > 1 && rows[1].length > 0 && rows[1].every(cell => /^:?-{2,}:?$/u.test(cell)) ? 1 : 0;
  const width = () => Math.max(...rows.map(row => row.length));
  let removed = 0;
  let changed = false;
  // 1. 表名占首格归一：表头首格以“表”结尾、数据行末列全空且数据行首列非空 → 表头删首格、数据行删末格
  const header = rows[0];
  const dataRows = rows.slice(dividerIndex + 1);
  if (dataRows.length > 0 && /表$/u.test(header[0] || '') && dataRows.every(row => row.length > 0 && row[row.length - 1] === '') && dataRows.some(row => row[0] !== '')) {
    rows[0] = header.slice(1);
    for (let rowIndex = dividerIndex + 1; rowIndex < rows.length; rowIndex += 1) rows[rowIndex] = rows[rowIndex].slice(0, rows[rowIndex].length - 1);
    changed = true;
    removed += 1;
  }
  // 2. 数据行全空列 → 删除整列
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
  // 3. “约82kW”模糊前缀归一（约N 占位表述在交付口径属占位符，数值确定化后不再阻断）
  for (let rowIndex = dividerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    for (let col = 0; col < row.length; col += 1) {
      if (!/^约\d/u.test(row[col] || '')) continue;
      row[col] = (row[col] || '').replace(/^约/u, '');
      changed = true;
    }
  }
  // 4. 数据行空单元格按列就近非空值填充（r18 丰乐镇 B3 归因）：危险作业管控清单表 5 列中第 5 列
  // 仅首行有值、其余行为空——正式交付不得出现空单元格（qualityValidation 空单元格检测无豁免），
  // 交付前确定性补齐：向上取同列最近非空值，找不到再向下；缺列行（数组短于列宽）不补，
  // 全空列由规则 2 删除；合计/小计/总计/累计行不填充（汇总行空格属结构性空位，填充会伪造汇总值）
  if (rows.length > dividerIndex + 1) {
    const total = width();
    let filledCount = 0;
    for (let col = 0; col < total; col += 1) {
      for (let rowIndex = dividerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        if (col >= row.length || (row[col] || '') !== '') continue;
        if (/^(?:合计|小计|总计|累计)/u.test(row[0] || '')) continue;
        let filled = '';
        for (let up = rowIndex - 1; up >= dividerIndex + 1; up -= 1) {
          if (col < rows[up].length && (rows[up][col] || '') !== '') { filled = rows[up][col]; break; }
        }
        if (!filled) {
          for (let down = rowIndex + 1; down < rows.length; down += 1) {
            if (col < rows[down].length && (rows[down][col] || '') !== '') { filled = rows[down][col]; break; }
          }
        }
        if (filled) { row[col] = filled; filledCount += 1; }
      }
    }
    if (filledCount > 0) { changed = true; removed += 1; }
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

/** 相邻表格间引导句池（连写表拆分后插于两表之间；表格凑数判定「表格连续堆叠」要求表间有正文分隔）。
 * 定稿措辞规避三类链尾清洗：不以「上表/本表」起头（数据口径自查泄漏段整段删除判定前缀）、不含
 * 「一致/修正为」、无数字与负向词；去空白后 24~27 字（低于段落复读 40 字阈值） */
const TABLE_BRIDGE_SENTENCES = [
  '上述要求与后续安排配套执行，执行情况由责任岗位登记归档。',
  '下列要求应在上述安排基础上逐项落实，相关记录经复核后留存备查。',
  '各项安排与上述要求同步执行，执行结果纳入日常台账统一管理。',
] as const;

/** 同表头堆叠降维变体池（tableSpamIssues：同一表头全文 ≥3 次即模板化凑数阻断）——第 2 张起
 * 首格替换为主题限定变体，表头键即分组维度任一变体即降维；首张保留原文（规划表名的自然落位点） */
const FIRST_CELL_VARIANTS: Record<string, readonly string[]> = {
  '管控点位': ['检查项目', '管控事项', '检查要点'],
  '检查项目': ['检查内容', '检查要点', '管控事项'],
  '序号': ['项次', '编号', '序次'],
};

/** 表格块行单元格切分（去首尾竖线、未转义竖线分隔、去不可见字符与首尾空白） */
function tableBlockCells(line: string): string[] {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => stripTableCellInvisibleChars(cell.trim()));
}

/** 分隔行判定（与 repairTableBlockLines 同源；单格行不判分隔，防单列表误拆） */
function isTableDividerRow(line: string): boolean {
  const cells = tableBlockCells(line);
  return cells.length >= 2 && cells.every(cell => /^:?-{2,}:?$/u.test(cell));
}

/** 表头键（与 tableSpamIssues 完全同口径：去首尾竖线、去 ** 、trim、滤空单元格后 join('|')） */
function tableSpamHeaderKey(line: string): string {
  const rawHeader = line.trim();
  const body = rawHeader.startsWith('|') ? rawHeader.slice(1) : rawHeader;
  const core = body.endsWith('|') ? body.slice(0, -1) : body;
  return core.split('|').map(cell => cell.split('**').join('').trim()).filter(cell => cell.length > 0).join('|');
}

/** 表头首个非空单元格文本（去 ** 与首尾空白，与 tableSpamHeaderKey 同口径） */
function firstHeaderCellText(line: string): string {
  const rawHeader = line.trim();
  const body = rawHeader.startsWith('|') ? rawHeader.slice(1) : rawHeader;
  const core = body.endsWith('|') ? body.slice(0, -1) : body;
  for (const cell of core.split('|')) {
    const text = cell.split('**').join('').trim();
    if (text.length > 0) return text;
  }
  return '';
}

/** 表头目标单元格替换为变体（保留原单元格强调符形态；行列结构不变） */
function withVariantHeaderCell(headerLine: string, variant: string): string {
  const trimmed = headerLine.trim();
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const core = body.endsWith('|') ? body.slice(0, -1) : body;
  const cells = core.split('|');
  const target = cells.findIndex(cell => cell.trim().length > 0);
  if (target < 0) return headerLine;
  cells[target] = ` ${cells[target].includes('**') ? `**${variant}**` : variant} `;
  return `|${cells.join('|')}|`;
}

/** 连写表拆分（链尾收口）：无空行相接的多张 markdown 表被表格解析器视为单块（块内首条之外的分隔行
 * 即新表边界，其上一行即新表表头行）——按边界拆为独立子块；拆分产物由调用侧在子块间插引导句 */
function splitConcatenatedTableBlock(rawLines: string[]): string[][] {
  const bounds: number[] = [];
  for (let index = 2; index < rawLines.length; index += 1) {
    if (!isTableDividerRow(rawLines[index]) || isTableDividerRow(rawLines[index - 1])) continue;
    const headerCells = tableBlockCells(rawLines[index - 1]);
    if (!headerCells[0] || headerCells.every(cell => cell === '')) continue;
    bounds.push(index - 1);
  }
  if (bounds.length === 0) return [rawLines];
  const blocks: string[][] = [];
  let start = 0;
  for (const bound of bounds) {
    blocks.push(rawLines.slice(start, bound));
    start = bound;
  }
  blocks.push(rawLines.slice(start));
  return blocks;
}

/**
 * markdown 全文级表格确定性修复（round-19 R5）：交付前兜底。表格专轮修复之后全维度评审轮修复
 * 可能重写表格引入空单元格（徽光阁实测危险源辨识表“高处作业坠落”行末两列空），交付前逐块
 * 做与专轮兜底同口径的确定性修复，只做不引入新错误的确定性操作。
 * r12 扩围（丰乐镇实测门禁 3 项表格阻断归因，表格缺陷源头根治）：
 * 5. 连写表拆分：块内第 2 条起分隔行即新表边界——拆为独立子表并在表间插引导句（「表格连续堆叠」
 *    判定要求表间有正文分隔；同块连写还会让第二张表表头/分隔行被当数据行，误报「列数不一致」
 *    与「占位符单元格（‘---’行）」）；
 * 6. 同表头堆叠降维：同一表头全文 ≥3 次（tableSpamIssues 同源判定）时第 2 张起首格替换为
 *    主题限定变体——表头键即分组维度，任一变体即降维，首张保留原文（规划表名落位点）。
 */
export function repairTableBlocksInMarkdownDeterministically(markdown: string): { markdown: string; removed: number; splitCount: number; variantCount: number } {
  const lines = markdown.split(/\r?\n/u);
  // 令牌化（正文行与表格块保持相对顺序；连写表就地拆分并保留子块分组，供表间插引导句）
  const tokens: Array<{ kind: 'text'; line: string } | { kind: 'table'; parts: string[][] }> = [];
  let index = 0;
  while (index < lines.length) {
    if (!/^\s*\|/u.test(lines[index])) {
      tokens.push({ kind: 'text', line: lines[index] });
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < lines.length && /^\s*\|/u.test(lines[end + 1])) end += 1;
    tokens.push({ kind: 'table', parts: splitConcatenatedTableBlock(lines.slice(index, end + 1)) });
    index = end + 1;
  }
  // 同表头分组（tableSpamIssues 同源口径；无分隔行的伪表不参与）：≥3 次组第 2 张起首格降维
  const headerGroups = new Map<string, string[][]>();
  for (const token of tokens) {
    if (token.kind !== 'table') continue;
    for (const part of token.parts) {
      if (!part.some(line => isTableDividerRow(line))) continue;
      const key = tableSpamHeaderKey(part[0] || '');
      if (!key) continue;
      const bucket = headerGroups.get(key);
      if (bucket) bucket.push(part);
      else headerGroups.set(key, [part]);
    }
  }
  let variantCount = 0;
  for (const bucket of headerGroups.values()) {
    if (bucket.length < 3) continue;
    for (let occurrence = 1; occurrence < bucket.length; occurrence += 1) {
      const variants = FIRST_CELL_VARIANTS[firstHeaderCellText(bucket[occurrence][0] || '')];
      if (!variants || variants.length === 0) continue;
      bucket[occurrence][0] = withVariantHeaderCell(bucket[occurrence][0] || '', variants[(occurrence - 1) % variants.length]);
      variantCount += 1;
    }
  }
  // 逐子块结构修复 + 拆分子块间插引导句（空行包裹成独立段落；引导句按池轮换；空表删除不留孤句）
  const result: string[] = [];
  let removed = 0;
  let splitCount = 0;
  let bridgeIndex = 0;
  for (const token of tokens) {
    if (token.kind === 'text') {
      result.push(token.line);
      continue;
    }
    if (token.parts.length > 1) splitCount += token.parts.length - 1;
    let emitted = false;
    for (const part of token.parts) {
      const repaired = repairTableBlockLines(part);
      if (repaired.removed > 0) removed += 1;
      if (repaired.lines.length === 0) continue;
      if (emitted) {
        result.push('', TABLE_BRIDGE_SENTENCES[bridgeIndex % TABLE_BRIDGE_SENTENCES.length], '');
        bridgeIndex += 1;
      }
      result.push(...repaired.lines);
      emitted = true;
    }
  }
  return { markdown: result.join('\n'), removed, splitCount, variantCount };
}

/** 汉字计数（与结构扫描 table-title-in-header 阈值同口径） */
function tableTitleHanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fa5]/gu) || []).length;
}

/** 表名比较键：去空白（含折行空格/全角空格）与不可见字符、强调符（规划表名与产出首格同预处理） */
function tableTitleKey(text: string): string {
  return stripTableCellInvisibleChars(text).replace(/[\s*_`<>#]/gu, '');
}

/**
 * 写时表名混表头确定性归一（4.44 门禁链源头根治；4.43 实测「文明施工管控要点与检查频次表」混入
 * 表头首格在块写时被静默放行、终检阻断）。在结构扫描/清理之前调用，把两类形态就地归一为交付
 * 规范形态（表题独立成行 + 空行 + 表格，与文档表格惯例一致；零内容生成、幂等）：
 * 1. 表名顶替首列名（表头首格与表格计划表名归一相等）——表名挪出为独立表题行，首格恢复规划
 *    字段名（plan.fields[0] 为写作指令「表头必须为」的权威值，属归一非新增语义）；
 * 2. 表名占首格偏移（判据与 repairTableBlockLines 规则 1 同源：数据行末格全空）——表名挪出为
 *    独立表题行，删除首格/末格偏移列恢复列对齐。
 * 无表格计划且非偏移形态时不动作（列名无权威来源，交结构扫描阻断重写，不得猜测列名）。
 */
export function normalizeTableTitleInHeaders(markdown: string, plans?: PlannedTablePlan[]): { markdown: string; normalized: number } {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const out: string[] = [];
  let normalized = 0;
  let index = 0;
  while (index < lines.length) {
    if (!/^\s*\|/u.test(lines[index])) {
      out.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < lines.length && /^\s*\|/u.test(lines[end + 1])) end += 1;
    const normalizedBlock = normalizeTableBlockTitle(lines.slice(index, end + 1), plans, out);
    if (normalizedBlock) {
      out.push(...normalizedBlock);
      normalized += 1;
    } else {
      out.push(...lines.slice(index, end + 1));
    }
    index = end + 1;
  }
  return { markdown: out.join('\n'), normalized };
}

function normalizeTableBlockTitle(block: string[], plans: PlannedTablePlan[] | undefined, emitted: string[]): string[] | undefined {
  const rows = block.map(line => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => stripTableCellInvisibleChars(cell.trim())));
  if (rows.length < 2) return undefined;
  const divider = rows[1];
  if (!(divider.length > 0 && divider.every(cell => /^:?-{2,}:?$/u.test(cell)))) return undefined;
  const header = rows[0];
  // 触发判据与结构扫描 scanTables 表名混表头判定同源（列数 ≥3、首格以「表」结尾、长名词短语）
  const firstCell = (header[0] || '').replace(/[\s*_]/gu, '');
  if (header.length < 3 || !/表$/u.test(firstCell) || tableTitleHanCount(firstCell) < TABLE_TITLE_MIN_HAN) return undefined;
  const titleLine = (header[0] || '').trim();
  // 幂等护栏：表格上一非空行已是同名表题（已归一侧）不再动作
  const priorLine = [...emitted].reverse().find(line => line.trim());
  if (priorLine && tableTitleKey(priorLine.replace(/^#{1,6}\s+/u, '')) === tableTitleKey(titleLine)) return undefined;
  const bodyRows = rows.slice(2);
  // 形态 2：表名占首格偏移（数据行末格全空）→ 表题独立成行 + 删首格/末格偏移列
  if (bodyRows.length > 0 && bodyRows.every(row => row.length > 0 && (row[row.length - 1] || '').trim() === '') && bodyRows.some(row => (row[0] || '').trim() !== '')) {
    const headerCells = header.slice(1);
    return [
      titleLine,
      '',
      `| ${headerCells.join(' | ')} |`,
      `| ${headerCells.map(() => '---').join(' | ')} |`,
      ...bodyRows.map(row => `| ${row.slice(0, -1).join(' | ')} |`),
    ];
  }
  // 形态 1：表名顶替首列名 → 按表格计划恢复规划首列名（schema 权威，非推测）
  const plan = (plans || []).find(candidate => candidate.title && tableTitleKey(candidate.title) === tableTitleKey(titleLine));
  const plannedFirstField = plan?.fields?.[0]?.name ? stripTableCellInvisibleChars(plan.fields[0].name).replace(/[\s\u3000]/gu, '') : '';
  if (!plannedFirstField) return undefined;
  return [titleLine, '', `| ${[plannedFirstField, ...header.slice(1)].join(' | ')} |`, ...block.slice(1)];
}
