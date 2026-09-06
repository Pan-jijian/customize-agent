/**
 * 智能表头行检测 + 语义列定位（通用机制修复）。
 *
 * 工程表格（工程量清单/材料表/进度表等）常见「标题行（E.1 分部分项工程量清单计价表）
 * → 多级表头（序号|项目编码|项目名称|项目特征描述|计量单位|工程量）→ 数据行」结构。
 * 历史实现直接取 matrix[0] 当表头：标题行被当表头后，真实列名全部退化为 COL2~COL15
 * （合肥师范清单 xls 实锤），下游按 body[N] 列位硬编码的行级提取与向量检索
 * 「R#C# 列名: 值」KV 全部错位，LLM 写作拿不到规格参数只能编造。
 *
 * 本模块按列关键词打分定位真实表头行，标题行降级为注释，多级表头拼接，
 * 并输出语义列索引（seq/name/feature/unit/quantity/code），供行级提取按列名而非列位取值。
 * 无列关键词的表格回退 matrix[0]，保持历史行为不变。
 */

export interface SmartTableHeader {
  /** 表头行在 matrix 中的行号（0 起） */
  headerIndex: number;
  /** 表头列名（多级表头已拼接为「主列_子列」） */
  headers: string[];
  /** 表头行之前的非空行（标题行，降级为注释） */
  titleLines: string[];
  /** 语义列定位：seq/name/feature/unit/quantity/code → 列索引（无该列时 -1） */
  columnMap: Record<string, number>;
}

/** 清单类列组关键词：按组打分，不同组各 +2，同组重复命中不累加 */
const HEADER_COLUMN_GROUPS = [
  { id: 'seq', keywords: ['序号'] },
  { id: 'code', keywords: ['项目编码', '清单编码'] },
  { id: 'name', keywords: ['项目名称', '工程名称', '名称'] },
  { id: 'feature', keywords: ['项目特征描述', '项目特征', '特征描述'] },
  { id: 'unit', keywords: ['计量单位'] },
  { id: 'quantity', keywords: ['工程量', '数量'] },
] as const;

/** 表头行打分：标题行「E.1 分部分项工程量清单计价表」仅命中「工程量」+2，
 *  真实表头行（序号|项目编码|…|工程量）命中多组 ≥8，取最高分行即可区分 */
export function scoreTableHeaderRow(row: string[]): number {
  let score = 0;
  for (const group of HEADER_COLUMN_GROUPS) {
    if (row.some(cell => group.keywords.some(keyword => String(cell ?? '').includes(keyword)))) score += 2;
  }
  return score;
}

/** 子表头行（多级表头第二级，如「人工费|材料费|机械费|管理费|利润」）：主表头下一行，
 *  序号列非纯整数且命中子列关键词（或无数字单元格且列覆盖充分）即视为子表头，与主表头拼接 */
const SUB_HEADER_KEYWORD_RE = /人工费|材料费|机械费|管理费|利润|综合单价|合价|其中|金额/u;

function isSubHeaderRow(row: string[], header: string[], seqColumn: number): boolean {
  if (seqColumn >= 0 && /^\d+$/.test(String(row[seqColumn] || '').trim())) return false;
  // 列关键词组得分 ≥4 的行是另一个表头行（同分并列场景），不是子表头
  if (scoreTableHeaderRow(row) >= 4) return false;
  const hasSubKeyword = row.some(cell => SUB_HEADER_KEYWORD_RE.test(String(cell ?? '')));
  if (hasSubKeyword) return true;
  const filled = row.filter(cell => String(cell ?? '').trim()).length;
  const headerFilled = header.filter(Boolean).length;
  if (filled < Math.max(2, headerFilled - 1)) return false;
  return !row.some(cell => /^\d+$/.test(String(cell ?? '').trim()));
}

/** 列名→语义列索引：关键词越长越优先（「项目特征描述」优于「特征」），无命中返回 -1 */
export function locateTableColumns(headers: string[]): Record<string, number> {
  const map: Record<string, number> = { seq: -1, code: -1, name: -1, feature: -1, unit: -1, quantity: -1 };
  for (const group of HEADER_COLUMN_GROUPS) {
    let bestIndex = -1;
    let bestLength = 0;
    for (let index = 0; index < headers.length; index += 1) {
      const cell = String(headers[index] || '').trim();
      for (const keyword of group.keywords) {
        if (cell.includes(keyword) && keyword.length > bestLength) {
          bestIndex = index;
          bestLength = keyword.length;
        }
      }
    }
    map[group.id] = bestIndex;
  }
  return map;
}

/** 智能表头行检测：在 matrix 前 maxScanRows 行内取列关键词组得分最高行为真实表头；
 *  最高分 < 4（不足两组列关键词）时回退 matrix[0]，保持无列关键词表格的历史行为 */
export function detectSmartTableHeader(matrix: string[][], maxScanRows = 40): SmartTableHeader {
  const scan = Math.min(matrix.length, maxScanRows);
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < scan; index += 1) {
    const score = scoreTableHeaderRow(matrix[index] || []);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  const headerIndex = bestScore >= 4 ? bestIndex : 0;
  const header = (matrix[headerIndex] || []).map(cell => String(cell ?? '').trim());
  const titleLines = matrix.slice(0, headerIndex).map(row => row.filter(Boolean).join(' ').trim()).filter(Boolean);
  const columnMap = locateTableColumns(header);
  // 多级表头拼接：仅确认真表头（bestScore ≥4）时才检查下一行是否为子表头——
  // 回退 matrix[0] 的无关键词表格不做拼接检查（否则首数据行会被误判为子表头吞掉）
  if (bestScore >= 4 && headerIndex + 1 < matrix.length && isSubHeaderRow(matrix[headerIndex + 1] || [], header, columnMap.seq ?? -1)) {
    const subRow = matrix[headerIndex + 1] || [];
    const merged = header.map((cell, index) => {
      const sub = String(subRow[index] || '').trim();
      if (!sub) return cell;
      return cell ? `${cell}_${sub}` : sub;
    });
    return { headerIndex: headerIndex + 1, headers: merged, titleLines, columnMap: locateTableColumns(merged) };
  }
  return { headerIndex, headers: header, titleLines, columnMap };
}
