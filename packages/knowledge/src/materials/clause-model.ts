/**
 * 条款块模型（4.61）：**条款边界来自文档自身的编号体系，不来自标点**。
 *
 * ## 为什么
 *
 * 现行 `splitTenderClauses` 按行/句读穷举切分（实测合工大 4472 条单元），
 * 于是没有任何条款结构的文本（图纸标注、表格碎片、DXF 元数据）也会被切成"条款"。
 * 而真实文档的条款边界是**文档自己声明**的：`第X条` / `8.13` / `(4)` / `4、` / `一、`。
 *
 * 由此得到一条硬性规则（不变式 5 的前置）：
 *
 * > **没有编号体系的地方不产生条款单元。**
 *
 * 图纸标注没有编号体系 → 不产生条款 → 它的数据走 DesignFact 通道；
 * 招标正文/答疑/设计说明有编号体系 → 产生条款 → 其中收件人为投标人的成为 BidObligation。
 *
 * ## 出口契约
 *
 * 只产出 `ClauseBlock[]`（含编号、正文、源位置），**不产出拼接字符串**；
 * 「这一段是不是义务、收件人是谁」由归一层在知道载体之后判定（原理 2）。
 */
import type { SourceAnchor } from './types.js';

/** 编号体系类型（决定层级归属与父子关系） */
export type ClauseNumberingKind =
  /** 第X条 / 第X章 / 第X节 / 第X款 */
  | 'statute'
  /** 多级阿拉伯数字：8.13 / 8.13.2 / 1.2.3.4 */
  | 'dotted'
  /** 括注序号：(4) / （4） / 4) */
  | 'parenthesized'
  /** 顿号/点号序号：4、/ 4．/ 4. */
  | 'ordinal'
  /** 中文序号：一、/ 二、 */
  | 'han';

export interface ClauseBlock {
  /** 编号原文（如「8.13」「第4.2.3条」「(4)」）；**必填**——无编号不产生条款 */
  clauseNo: string;
  numbering: ClauseNumberingKind;
  /** 编号层级深度（第X条=1，8.13=2，8.13.2=3；用于父子归属与"父条不含正文"判定） */
  depth: number;
  /** 条款正文（编号之后到下一编号之前的全部文本，保留换行） */
  body: string;
  /** 条款标题（编号后紧随的短标题行，无则空） */
  heading?: string;
  anchor: SourceAnchor;
}

/** 编号识别表：按**特异度**从高到低排列（先匹配 statute，再 dotted，避免 8.13 被 ordinal 抢走） */
const NUMBERING_PATTERNS: ReadonlyArray<{ kind: ClauseNumberingKind; re: RegExp; depthOf: (match: RegExpExecArray) => number }> = [
  {
    // 「第4.2.3条」在招标文件里是常态编号形态——编号体必须允许点分（否则整个 statute 支路失效）
    kind: 'statute',
    re: /^第\s*([一二三四五六七八九十百千零\d][\d.一二三四五六七八九十百千零]*)\s*(条|款)/u,
    depthOf: match => Math.max(1, match[1]!.split('.').length),
  },
  {
    kind: 'statute',
    re: /^第\s*([一二三四五六七八九十百千零\d][\d.一二三四五六七八九十百千零]*)\s*(章|节)/u,
    depthOf: () => 0,
  },
  {
    kind: 'dotted',
    re: /^(\d{1,2}(?:\.\d{1,2}){1,4})[.．]?(?=\s|[^\d.．])/u,
    depthOf: match => match[1]!.split('.').length,
  },
  {
    kind: 'parenthesized',
    re: /^[（(]\s*(\d{1,2})\s*[）)]/u,
    depthOf: () => 2,
  },
  {
    kind: 'han',
    re: /^([一二三四五六七八九十]{1,2})\s*[、．.]/u,
    depthOf: () => 1,
  },
  {
    kind: 'ordinal',
    re: /^(\d{1,3})\s*[、．]\s*(?=\S)/u,
    depthOf: () => 2,
  },
];

/** 单行编号识别（返回编号、体系、层级、编号后的剩余文本）；无编号返回 undefined */
export function matchClauseNumber(line: string): { clauseNo: string; kind: ClauseNumberingKind; depth: number; rest: string } | undefined {
  const text = line.replace(/^#{1,6}\s*/u, '').trimStart();
  for (const pattern of NUMBERING_PATTERNS) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    // 排除「2026年」「3.5m」「100%」这类**数值**误判为编号：
    // dotted 后必须不是「数字+单位」形态；ordinal 后必须是中文起头的正文
    const rest = text.slice(match[0].length);
    if (pattern.kind === 'dotted' && /^\s*(?:mm|cm|m|kg|t|MPa|kN|℃|%|万|亿|\d)/iu.test(rest)) continue;
    if (pattern.kind === 'ordinal' && !/^\s*\p{Script=Han}/u.test(rest)) continue;
    if (pattern.kind === 'han' && !/^\s*\p{Script=Han}/u.test(rest)) continue;
    if (rest.trim().length === 0 && pattern.kind !== 'statute') continue;
    return { clauseNo: match[1] ?? match[0].trim(), kind: pattern.kind, depth: pattern.depthOf(match as RegExpExecArray), rest };
  }
  return undefined;
}

/**
 * 行流 → 条款块序列。
 *
 * 规则：
 * 1. 只有**行首**编号才开启新条款（行内出现的 `4、` 是枚举，不是条款边界）；
 * 2. 无编号的行归入**当前条款**（这是 PDF 折行的正解——旧实现按行穷举正是把折行切碎的原因）；
 * 3. 无任何编号的行流 → 返回空数组（**该载体不产生条款**）。
 *
 * `body` 保留原换行，由消费层决定是否折成一行——**本层不做任何拼接**。
 */
export function splitClauseBlocks(input: {
  lines: string[];
  anchor: Omit<SourceAnchor, 'clauseNo'>;
  /** 行号偏移（PDF 页内行号 → 文档行号） */
  lineOffset?: number;
}): ClauseBlock[] {
  const blocks: ClauseBlock[] = [];
  let current: ClauseBlock | undefined;
  const offset = input.lineOffset ?? 0;
  input.lines.forEach((line, index) => {
    const match = matchClauseNumber(line);
    if (match) {
      if (current) blocks.push(current);
      const bodyLines = [match.rest];
      current = {
        clauseNo: match.clauseNo,
        numbering: match.kind,
        depth: match.depth,
        body: '',
        anchor: { ...input.anchor, clauseNo: match.clauseNo, position: { ...input.anchor.position, start: index + offset } },
      };
      // 编号后的短行（≤30 字且无句末标点）视为条款标题，与正文分离
      if (bodyLines[0] && bodyLines[0].trim().length > 0 && bodyLines[0].trim().length <= 30 && !/[。；;]/u.test(bodyLines[0])) {
        current.heading = bodyLines[0].trim();
        current.body = '';
      } else {
        current.body = bodyLines[0] ?? '';
      }
      return;
    }
    if (!current) return; // 编号出现前的散行不属于任何条款（封面/前言等）
    current.body = current.body ? `${current.body}\n${line}` : line;
  });
  if (current) blocks.push(current);
  return blocks.filter(block => block.body.trim().length > 0 || block.heading);
}

/** 条款块 → 供向量检索与判定用的单行文本（**渲染**，不作为源数据） */
export function renderClauseText(block: ClauseBlock): string {
  const body = block.body.replace(/\s*\n\s*/gu, ' ').trim();
  return [block.anchor.clauseNo ?? block.clauseNo, block.heading, body].filter(Boolean).join(' ');
}
