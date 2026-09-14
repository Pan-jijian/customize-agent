/**
 * 结构完整性统一规则（V2 方案 · 批1 核心模块）：写时质检（chapterGeneration 小节成稿）、
 * 终检检测器（documentFinalValidation 安全网）、确定性清理器（deterministicFixChains 只清不写）
 * 三处共用同一扫描源——检测定位=清理定位，防「检测报 N 条 / 修复只处理首条」类口径漂移
 * （与 resourceBreakdownNumbers 单源模式同构）。
 *
 * 铁律（方案总纲）：
 * 1. 零兜底写入——本模块只做「删除 / 归一 / 去号」等零内容生成操作，不产生任何新语义；
 * 2. 处置粒度=问题粒度——行级问题行级清理，内容级问题（截断/空节/标点断裂）就地拦截重写；
 * 3. 误报控制——写时拦截只对高置信缺陷生效，格式类缺陷写时直接确定性清理不拦截。
 *
 * 族覆盖（丰乐镇 12 度实测形态）：
 * - 有序列表编号跳号/重复（2.6 缺「4.」）/孤立编号（2.10.1「6.」跨节继承）
 * - 孤立「- 」单项列表块（1.3.x / 2.11.x 共 9 处）
 * - 表头重复行（5.2）、表名混入表头（8.1.2 / 8.2 / 9.2）、表内数据行重复（8.3）、空表
 * - 句尾截断（2.10.2「短边搭」/ 2.11.1 / 3.1「9套按」）
 * - 空小节（2.11.2）
 * - 完全重复行（≥40 字，L186/L192 工程量清单条款）与相邻同句连发（2.10.4 质检句 ×2）
 * - 标点断裂漂移句（7.1.1「报验。、公厕砌筑」）
 */

export type StructureDefectKind =
  | 'orphan-list-number'
  | 'list-numbering'
  | 'orphan-list-item'
  | 'table-header-duplicate'
  | 'table-row-duplicate'
  | 'table-title-in-header'
  | 'table-empty'
  | 'table-number-orphan-reference'
  | 'table-number-duplicate'
  | 'duplicate-line'
  | 'duplicate-sentence-adjacent'
  | 'truncated-line'
  | 'empty-subsection'
  | 'sentence-fracture';

export interface StructureDefect {
  kind: StructureDefectKind;
  /** 1-based 行号（清理/反馈定位锚点） */
  line: number;
  /** 证据片段（≤80 字符） */
  excerpt: string;
  /** 人类可读问题描述 */
  message: string;
}

export interface StructureScanResult {
  /** 确定性可清理（零内容生成：删重复/去号/重排）——写时直接清理，终检由清理器收口 */
  cleanable: StructureDefect[];
  /** 需阻断重写（内容缺失或语义断裂，无法确定性修复）——写时拦截反馈，终检硬阻断 */
  blocking: StructureDefect[];
}

export interface StructureIntegrityIssue {
  level: 'error';
  severity: 'blocker';
  category: 'structure';
  message: string;
  suggestion: string;
}

const HAN_RE = /[\u4e00-\u9fa5]/gu;
const ORDERED_ITEM_RE = /^([ \u3000]*)(\d{1,3})\.\s+\S/u;
const BULLET_ITEM_RE = /^([ \u3000]*)([-*+])\s+\S/u;
const HEADING_RE = /^(#{1,6})\s+\S/u;
const TOC_DOT_LEADER_RE = /(?:\.{2,}|…{2,})\s*\d+\s*$/u;
const FRACTURE_RE = /。、|，、|；、|。，|，。|。。/u;
const SENTENCE_SPLIT_RE = /(?<=[。；！？])/u;
/** 悬挂虚词/连接词结尾（正常句子不以它们收尾）：强截断信号，无需后续边界证据（3.1 实测「…含基础9套按」） */
const DANGLING_TAIL_RE = /[的与和及或在于是对从向把被将按并而则如若等共约达须应需可要能以由使让]/u;

/** 完全重复行最小汉字数（低于此长度的重复句在工程语境可能合法） */
export const DUPLICATE_LINE_MIN_HAN = 40;
/** 相邻同句连发最小汉字数（2.10.4 实测形态 38 字） */
export const ADJACENT_SENTENCE_MIN_HAN = 16;
/** 表名混入表头：首格以「表」结尾的最小汉字数（防「报表/图表」类短词误判） */
export const TABLE_TITLE_MIN_HAN = 8;

function hanCount(text: string): number {
  return (text.match(HAN_RE) || []).length;
}

function excerptOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

function isHeading(line: string): boolean {
  return HEADING_RE.test(line.trim());
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith('|');
}

function isTableDivider(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && /^[\s|:-]+$/u.test(trimmed) && /-{3,}/u.test(trimmed);
}

function isOrderedItem(line: string): boolean {
  const match = ORDERED_ITEM_RE.exec(line);
  if (!match) return false;
  return Number.parseInt(match[2], 10) <= 300;
}

function isBulletItem(line: string): boolean {
  return BULLET_ITEM_RE.test(line);
}

function isStructuralLine(line: string): boolean {
  return isHeading(line) || isTableRow(line);
}

function normalizeCell(cell: string): string {
  return cell.replace(/[|`*_<>#\s\u3000]/gu, '').replace(/^:?-{2,}:?$/u, '');
}

function splitTableRow(row: string): string[] {
  const inner = row.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return inner.split('|').map(cell => cell.trim());
}

function normalizeTableRow(row: string): string {
  return splitTableRow(row).map(normalizeCell).join('|');
}

function previousContentLine(lines: string[], index: number): number {
  for (let k = index - 1; k >= 0; k -= 1) if (lines[k].trim()) return k;
  return -1;
}

function nextContentLine(lines: string[], index: number): number {
  for (let k = index + 1; k < lines.length; k += 1) if (lines[k].trim()) return k;
  return -1;
}

interface OrderedListBlock {
  indent: number;
  items: Array<{ index: number; number: number }>;
}

/** 有序列表分块：连续同缩进列表项（允许中间夹空行）；遇非空非列表行断块 */
export function collectOrderedListBlocks(lines: string[]): OrderedListBlock[] {
  const blocks: OrderedListBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = ORDERED_ITEM_RE.exec(lines[i]);
    const number = match ? Number.parseInt(match[2], 10) : 0;
    if (!match || number > 300) {
      i += 1;
      continue;
    }
    const indent = match[1].length;
    const items = [{ index: i, number }];
    let j = i + 1;
    while (j < lines.length) {
      const text = lines[j].trim();
      if (!text) {
        let k = j;
        while (k < lines.length && !lines[k].trim()) k += 1;
        const next = k < lines.length ? ORDERED_ITEM_RE.exec(lines[k]) : null;
        if (next && next[1].length === indent && Number.parseInt(next[2], 10) <= 300) {
          j = k;
          continue;
        }
        break;
      }
      const next = ORDERED_ITEM_RE.exec(lines[j]);
      if (next && next[1].length === indent && Number.parseInt(next[2], 10) <= 300) {
        items.push({ index: j, number: Number.parseInt(next[2], 10) });
        j += 1;
        continue;
      }
      break;
    }
    blocks.push({ indent, items });
    i = j > i ? j : i + 1;
  }
  return blocks;
}

function scanOrderedLists(lines: string[], result: StructureScanResult): void {
  for (const block of collectOrderedListBlocks(lines)) {
    const numbers = block.items.map(item => item.number);
    if (block.items.length === 1) {
      if (numbers[0] > 1) {
        result.cleanable.push({
          kind: 'orphan-list-number',
          line: block.items[0].index + 1,
          excerpt: excerptOf(lines[block.items[0].index]),
          message: `孤立有序编号「${numbers[0]}.」（无前序 1.~${numbers[0] - 1}.，疑似跨节继承编号）`,
        });
      }
      continue;
    }
    const sequential = numbers.every((value, index) => value === index + 1);
    if (!sequential) {
      result.cleanable.push({
        kind: 'list-numbering',
        line: block.items[0].index + 1,
        excerpt: `编号序列 ${numbers.join(',')}`,
        message: `有序列表编号不连续（第 ${block.items[0].index + 1}~${block.items[block.items.length - 1].index + 1} 行编号：${numbers.join(',')}）`,
      });
    }
  }
}

function scanOrphanBullets(lines: string[], result: StructureScanResult): void {
  let i = 0;
  while (i < lines.length) {
    if (!isBulletItem(lines[i])) {
      i += 1;
      continue;
    }
    const blockIndices: number[] = [i];
    let j = i + 1;
    while (j < lines.length) {
      const text = lines[j].trim();
      if (!text) {
        let k = j;
        while (k < lines.length && !lines[k].trim()) k += 1;
        if (k < lines.length && isBulletItem(lines[k])) {
          j = k;
          continue;
        }
        break;
      }
      if (isBulletItem(lines[j])) {
        blockIndices.push(j);
        j += 1;
        continue;
      }
      break;
    }
    if (blockIndices.length === 1) {
      const index = blockIndices[0];
      const prev = previousContentLine(lines, index);
      const next = nextContentLine(lines, index);
      const prevText = prev >= 0 ? lines[prev].trim() : '';
      const guideExempt = /[:：]$/u.test(prevText) || /(?:包括|如下|以下|例如|分别是)[:：]?$/u.test(prevText);
      const prevOk = prev >= 0
        && !isBulletItem(lines[prev])
        && !isHeading(lines[prev])
        && !isTableRow(lines[prev])
        && !isOrderedItem(lines[prev])
        && !guideExempt;
      const nextOk = next >= 0 && !isBulletItem(lines[next]) && !isTableRow(lines[next]);
      if (prevOk && nextOk) {
        result.cleanable.push({
          kind: 'orphan-list-item',
          line: index + 1,
          excerpt: excerptOf(lines[index]),
          message: '孤立单项列表（前后均为正文语境，无列表上下文）',
        });
      }
    }
    i = j > i ? j : i + 1;
  }
}

interface TableBlock {
  start: number;
  rows: number[];
}

function collectTableBlocks(lines: string[]): TableBlock[] {
  const blocks: TableBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isTableRow(lines[i])) {
      i += 1;
      continue;
    }
    const rows: number[] = [i];
    let j = i + 1;
    while (j < lines.length && isTableRow(lines[j])) {
      rows.push(j);
      j += 1;
    }
    blocks.push({ start: i, rows });
    i = j;
  }
  return blocks;
}

function scanTables(lines: string[], result: StructureScanResult): void {
  for (const block of collectTableBlocks(lines)) {
    const rows = block.rows;
    if (rows.length < 2) continue;
    if (!isTableDivider(lines[rows[1]])) continue;
    const headerCells = splitTableRow(lines[rows[0]]);
    const headerNorm = normalizeTableRow(lines[rows[0]]);
    // 表名混入表头：首格以「表」结尾且为长名词短语、总列数 ≥3（列语义错位，内容级缺陷→重写）
    const firstCell = headerCells[0]?.replace(/[\s*_]/gu, '') ?? '';
    if (headerCells.length >= 3 && /表$/u.test(firstCell) && hanCount(firstCell) >= TABLE_TITLE_MIN_HAN) {
      result.blocking.push({
        kind: 'table-title-in-header',
        line: rows[0] + 1,
        excerpt: firstCell,
        message: `表格表头首格为表名（「${firstCell}」），列语义错位（表名应独立成行，表头首格必须填列名）`,
      });
    }
    const dataRows = rows.slice(2);
    if (dataRows.length === 0) {
      result.blocking.push({
        kind: 'table-empty',
        line: rows[0] + 1,
        excerpt: excerptOf(lines[rows[0]]),
        message: '空表（仅表头与分隔线，无任何数据行）',
      });
      continue;
    }
    // 表头重复：分隔线后首个数据行内容 = 表头（5.2 实测形态）——该行按重复表头处理，
    // 不再重复报 table-row-duplicate（同一行只报一个缺陷，防检测器双报）
    const headerDuplicated = normalizeTableRow(lines[dataRows[0]]) === headerNorm;
    if (headerDuplicated) {
      result.cleanable.push({
        kind: 'table-header-duplicate',
        line: dataRows[0] + 1,
        excerpt: excerptOf(lines[dataRows[0]]),
        message: '重复表头行（分隔线后数据行与表头内容一致）',
      });
    }
    // 表内数据行完全重复（8.3 实测形态：相邻同内容行）
    const seen = new Set<string>();
    if (headerDuplicated) seen.add(headerNorm);
    for (const rowIndex of dataRows) {
      if (headerDuplicated && rowIndex === dataRows[0]) continue;
      const key = normalizeTableRow(lines[rowIndex]);
      if (!key || key.split('|').every(cell => !cell)) continue;
      if (seen.has(key)) {
        result.cleanable.push({
          kind: 'table-row-duplicate',
          line: rowIndex + 1,
          excerpt: excerptOf(lines[rowIndex]),
          message: '表内数据行完全重复',
        });
        continue;
      }
      seen.add(key);
    }
  }
}

/**
 * A5b 表编号体系检查（批 1，全文档级专属）：正文「表N」引用必须命中同编号表实体（引用↔实体一一对应），
 * 实体编号不得重复。纯结构判定；仅挂终检（structureIntegrityIssues）——小节级扫描不启用，避免跨节引用误报。
 * 引用锤=动词前缀形态（按/如/见+双字动词白名单）；「据/照」等歧义单字不收录（防「数据表1/对照表1」误报），
 * 「见」限定词首（防「意见表1份」量词形态）；实体判据=行首「表N 标题」且下一非空行为表格行（防「表1中规定…」句误判）。
 */
export function scanTableNumberingDefects(markdown: string): StructureDefect[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const defects: StructureDefect[] = [];
  const entities = new Map<number, number[]>();
  const entityRe = /^表\s*(\d+)\s+\S/u;
  for (let index = 0; index < lines.length; index += 1) {
    const match = entityRe.exec((lines[index] || '').trim());
    if (!match) continue;
    // 实体判据：下一非空行为表格行（表标题紧贴表格，允许中间一个空行）
    let next = index + 1;
    while (next < lines.length && !(lines[next] || '').trim()) next += 1;
    if (next >= lines.length || !/^\s*\|/u.test(lines[next] || '')) continue;
    const number = Number.parseInt(match[1], 10);
    entities.set(number, [...(entities.get(number) || []), index + 1]);
  }
  for (const [number, at] of entities) {
    if (at.length <= 1) continue;
    defects.push({
      kind: 'table-number-duplicate',
      line: at[1],
      excerpt: excerptOf((lines[at[1] - 1] || '').trim()),
      message: `表编号重复（「表${number}」实体出现 ${at.length} 次：第 ${at.join('、')} 行）：表编号必须全篇唯一`,
    });
  }
  const REFERENCE_RULES = [
    /[按如]\s*表\s*(\d+)/gu,
    /(?<![\u4e00-\u9fa5])见\s*表\s*(\d+)/gu,
    /(?:参见|详见|根据|依据|按照|参照|比照|遵照|结合)\s*表\s*(\d+)/gu,
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || '';
    if (!line.includes('表')) continue;
    const reported = new Set<number>();
    for (const rule of REFERENCE_RULES) {
      rule.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.exec(line))) {
        const number = Number.parseInt(match[1], 10);
        if (reported.has(number) || entities.has(number)) continue;
        reported.add(number);
        defects.push({
          kind: 'table-number-orphan-reference',
          line: index + 1,
          excerpt: excerptOf(line.trim()),
          message: `引用了「表${number}」但正文无该编号表实体（引用与实体必须一一对应）`,
        });
      }
    }
  }
  return defects;
}

function scanTruncatedLines(lines: string[], result: StructureScanResult): void {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (isStructuralLine(line) || isOrderedItem(line) || isBulletItem(line)) continue;
    if (TOC_DOT_LEADER_RE.test(line)) continue;
    if (/\d$/u.test(line)) continue;
    if (hanCount(line) < 15) continue;
    const last = line[line.length - 1];
    if (!/[\u4e00-\u9fa5]/u.test(last)) continue;
    // 引导句（以冒号结尾）/ 表题图题（以表/图结尾）不判截断
    if (/[:：、]$/u.test(line) || /[表图]$/u.test(line)) continue;
    const next = nextContentLine(lines, i);
    // 4.31 列表引导句豁免：行尾为「…完成后/完毕后/结束后/如下/以下」类引导语且后续行为列表项时，
    // 属“引导句+列表”正常结构（丰乐镇 v6 实测：工序叙述“……摊铺完成后”+有序列表被误判句尾截断）
    if (next >= 0
      && (isOrderedItem(lines[next]) || isBulletItem(lines[next]))
      && /(?:完成后|完毕后|结束后|如下|以下)$/u.test(line)) continue;
    const nextIsBoundary = next === -1
      || isHeading(lines[next])
      || isTableRow(lines[next])
      || isOrderedItem(lines[next])
      || isBulletItem(lines[next]);
    if (!nextIsBoundary) {
      // 悬挂虚词结尾是强截断信号（与前文边界证据独立）：正常句子不会以「按/的/与/并」等虚词收尾
      const danglingTail = DANGLING_TAIL_RE.test(last);
      if (!danglingTail) continue;
    }
    // 前行保护：排除「前后均为软换行正文段中行」——前行为标题/表格/列表/句末标点结尾正文均可
    const prev = previousContentLine(lines, i);
    const prevText = prev >= 0 ? lines[prev].trim() : '';
    const prevOk = prev < 0
      || isHeading(prevText)
      || isTableRow(prevText)
      || isOrderedItem(prevText)
      || isBulletItem(prevText)
      || /[。；！？""」』）\]】…]$/u.test(prevText);
    if (!prevOk) continue;
    result.blocking.push({
      kind: 'truncated-line',
      line: i + 1,
      excerpt: excerptOf(lines[i]),
      message: '句尾截断（行尾无终止标点且后续为标题/表格/列表/文末，疑似生成截断）',
    });
  }
}

function scanEmptySubsections(lines: string[], result: StructureScanResult): void {
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{3,6})\s+(\S.*)$/u.exec(lines[i].trim());
    if (!match) continue;
    const level = match[1].length;
    const next = nextContentLine(lines, i);
    // 空节判定：文末直落，或下一非空行为「同级或更高级」标题（H3 后跟 H4 属容器+子节合法结构，不判空）
    if (next === -1) {
      result.blocking.push({
        kind: 'empty-subsection',
        line: i + 1,
        excerpt: excerptOf(lines[i]),
        message: `空小节「${match[2].trim().slice(0, 40)}」（小节标题后无任何内容）`,
      });
      continue;
    }
    const nextHeading = /^(#{1,6})\s+\S/u.exec(lines[next].trim());
    if (nextHeading && nextHeading[1].length <= level) {
      result.blocking.push({
        kind: 'empty-subsection',
        line: i + 1,
        excerpt: excerptOf(lines[i]),
        message: `空小节「${match[2].trim().slice(0, 40)}」（小节标题后无任何内容）`,
      });
    }
  }
}

function scanDuplicateLines(lines: string[], result: StructureScanResult): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || isStructuralLine(line) || isOrderedItem(line) || isBulletItem(line)) continue;
    const normalized = line.replace(/\s+/gu, '');
    if (hanCount(normalized) < DUPLICATE_LINE_MIN_HAN) continue;
    const first = seen.get(normalized);
    if (first === undefined) {
      seen.set(normalized, i);
      continue;
    }
    result.cleanable.push({
      kind: 'duplicate-line',
      line: i + 1,
      excerpt: excerptOf(lines[i]),
      message: `与第 ${first + 1} 行完全重复（≥${DUPLICATE_LINE_MIN_HAN} 字）`,
    });
  }
}

function scanAdjacentDuplicateSentences(lines: string[], result: StructureScanResult): void {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || isStructuralLine(line) || isOrderedItem(line) || isBulletItem(line)) continue;
    const sentences = line.split(SENTENCE_SPLIT_RE).map(sentence => sentence.trim()).filter(Boolean);
    for (let s = 0; s + 1 < sentences.length; s += 1) {
      if (sentences[s] === sentences[s + 1] && hanCount(sentences[s]) >= ADJACENT_SENTENCE_MIN_HAN) {
        result.cleanable.push({
          kind: 'duplicate-sentence-adjacent',
          line: i + 1,
          excerpt: sentences[s].slice(0, 60),
          message: `相邻句子重复（「${sentences[s].slice(0, 24)}…」连续两遍）`,
        });
        break;
      }
    }
  }
}

function scanSentenceFractures(lines: string[], result: StructureScanResult): void {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || isStructuralLine(line)) continue;
    const match = FRACTURE_RE.exec(line);
    if (!match) continue;
    result.blocking.push({
      kind: 'sentence-fracture',
      line: i + 1,
      excerpt: excerptOf(line),
      message: `标点断裂（「${match[0]}」句读错乱，疑似句段拼接残留/漂移句）`,
    });
  }
}

/** 全量扫描：cleanable（确定性清理域）+ blocking（阻断重写域） */
export function scanStructureDefects(markdown: string): StructureScanResult {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const result: StructureScanResult = { cleanable: [], blocking: [] };
  scanOrderedLists(lines, result);
  scanOrphanBullets(lines, result);
  scanTables(lines, result);
  scanTruncatedLines(lines, result);
  scanEmptySubsections(lines, result);
  scanDuplicateLines(lines, result);
  scanAdjacentDuplicateSentences(lines, result);
  scanSentenceFractures(lines, result);
  return result;
}

function dedupeAdjacentSentences(line: string): string {
  const sentences = line.split(SENTENCE_SPLIT_RE);
  const out: string[] = [];
  for (const sentence of sentences) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev === sentence && hanCount(sentence.trim()) >= ADJACENT_SENTENCE_MIN_HAN) continue;
    out.push(sentence);
  }
  return out.join('');
}

/** 确定性清理（只清不写：删除重复/去号/重排/去重句，零内容生成）；幂等收敛，最多 4 轮 */
export function cleanStructureDefects(markdown: string): { markdown: string; cleaned: string[] } {
  let current = markdown.replace(/\r\n?/gu, '\n');
  const cleaned: string[] = [];
  for (let round = 0; round < 4; round += 1) {
    const lines = current.split('\n');
    const scan = scanStructureDefects(current);
    if (scan.cleanable.length === 0) break;
    const deletions = new Set<number>();
    const replacements = new Map<number, string>();
    // 有序列表：孤立编号去号 / 块内重排（一次处理全部块，防逐缺陷相互干扰）
    for (const block of collectOrderedListBlocks(lines)) {
      const numbers = block.items.map(item => item.number);
      if (block.items.length === 1 && numbers[0] > 1) {
        const index = block.items[0].index;
        const stripped = lines[index].replace(/^([ \u3000]*)\d{1,3}\.\s+/u, '$1');
        if (stripped !== lines[index]) {
          replacements.set(index, stripped);
          cleaned.push(`孤立编号去号：第 ${index + 1} 行（「${numbers[0]}.」）`);
        }
        continue;
      }
      if (block.items.length > 1 && !numbers.every((value, index) => value === index + 1)) {
        block.items.forEach((item, position) => {
          const replaced = lines[item.index].replace(/^([ \u3000]*)\d{1,3}\.\s+/u, `$1${position + 1}. `);
          if (replaced !== lines[item.index]) replacements.set(item.index, replaced);
        });
        cleaned.push(`有序列表重排：第 ${block.items[0].index + 1}~${block.items[block.items.length - 1].index + 1} 行（${numbers.join(',')} → 1..${numbers.length}）`);
      }
    }
    for (const defect of scan.cleanable) {
      const index = defect.line - 1;
      if (defect.kind === 'orphan-list-item') {
        const stripped = lines[index].replace(/^([ \u3000]*)[-*+]\s+/u, '$1');
        if (stripped !== lines[index]) {
          replacements.set(index, stripped);
          cleaned.push(`孤立列表项去号：第 ${index + 1} 行`);
        }
      } else if (defect.kind === 'table-header-duplicate') {
        deletions.add(index);
        cleaned.push(`重复表头行删除：第 ${index + 1} 行`);
      } else if (defect.kind === 'table-row-duplicate') {
        deletions.add(index);
        cleaned.push(`表内重复数据行删除：第 ${index + 1} 行`);
      } else if (defect.kind === 'duplicate-line') {
        deletions.add(index);
        cleaned.push(`完全重复行删除：第 ${index + 1} 行`);
      } else if (defect.kind === 'duplicate-sentence-adjacent') {
        const deduped = dedupeAdjacentSentences(lines[index]);
        if (deduped !== lines[index]) {
          replacements.set(index, deduped);
          cleaned.push(`相邻重复句去重：第 ${index + 1} 行`);
        }
      }
    }
    const next = lines
      .map((line, index) => (deletions.has(index) ? undefined : (replacements.get(index) ?? line)))
      .filter((line): line is string => line !== undefined);
    const nextText = next.join('\n');
    if (nextText === current) break;
    current = nextText;
  }
  return { markdown: current, cleaned };
}

/** 写时拦截反馈文本（chapterGeneration 小节成稿质检用；仅 blocking 类触发拦截） */
export function structureIntegrityFeedback(result: StructureScanResult, scopeLabel?: string): string | undefined {
  if (result.blocking.length === 0) return undefined;
  const details = result.blocking
    .slice(0, 4)
    .map(defect => `${defect.message}（第 ${defect.line} 行）`)
    .join('；');
  return `${scopeLabel ? `${scopeLabel} ` : ''}结构完整性未通过（${result.blocking.length} 处）：${details}。请保留已正确内容，仅修正上述问题后重新输出完整小节。`;
}

const KIND_SUGGESTIONS: Record<StructureDefectKind, string> = {
  'orphan-list-number': '孤立编号由确定性清理去号转正文；写时按小节独立起编，不得继承父级编号。',
  'list-numbering': '编号重排为 1..n 连续；写时编号必须从 1 起连续。',
  'orphan-list-item': '孤立单项列表去除列表符并入正文；单项内容不使用列表格式。',
  'table-header-duplicate': '删除重复表头行；表格必须只有一个表头块。',
  'table-row-duplicate': '删除重复数据行；同一数据不得在表内出现两次。',
  'table-title-in-header': '表名必须独立成行（表题），表头首格必须为列名；须定向重写该表格。',
  'table-empty': '空表须补充数据行或删除；不得交付仅表头的空表。',
  'table-number-orphan-reference': '补建被引用的表实体或修正引用编号；表编号引用必须与实体一一对应。',
  'table-number-duplicate': '表编号重排为全篇唯一；同一表编号不得出现两个实体。',
  'duplicate-line': '删除后出现的重复行；该段内容只能出现一次。',
  'duplicate-sentence-adjacent': '相邻重复句去重；不得同句连发两遍。',
  'truncated-line': '句尾截断须补全该句后重写；不得交付截断内容。',
  'empty-subsection': '空小节必须补写与该小节相关的正文内容，不得只留标题。',
  'sentence-fracture': '句读断裂须重写该句；不得交付句段拼接残留。',
};

/** 终检检测器包装：cleanable 默认也报（若残留说明清理器未收敛，暴露问题不静默） */
export function structureIntegrityIssues(markdown: string, options?: { includeCleanable?: boolean }): StructureIntegrityIssue[] {
  const includeCleanable = options?.includeCleanable ?? true;
  const result = scanStructureDefects(markdown);
  // A5b 表编号体系（全文档级专属：小节级/清理器不启用，防跨节引用误报）
  const numberingDefects = scanTableNumberingDefects(markdown);
  const defects = includeCleanable
    ? [...result.blocking, ...numberingDefects, ...result.cleanable]
    : [...result.blocking, ...numberingDefects];
  return defects.map(defect => ({
    level: 'error' as const,
    severity: 'blocker' as const,
    category: 'structure' as const,
    message: `结构完整性缺陷：${defect.message}（第 ${defect.line} 行）`,
    suggestion: KIND_SUGGESTIONS[defect.kind],
  }));
}
