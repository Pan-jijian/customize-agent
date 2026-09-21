/**
 * 编制依据↔正文双向对账（C5 一致性类 P6）：检测/评分/修复三端单源。
 *
 * 背景（r28l/s28l 实测）：编制依据小节「声明未用」与「用了未声明」双向失衡——r28l 声明编号
 * 12 个中 7 个正文零引用、正文 6 个编号引用未声明；s28l 声明编号 11 个中 7 个零引用、正文
 * 15 个编号引用未声明；书名号条目同态。现有 basisRegulationsCoverageIssues 只查条目存在性
 * （五类各自 ≥1），声明与正文的双向引用一致性无任何检测：编制依据列了不用的规范（凑数）、
 * 正文用了不列的规范（漏列）双双盲区。
 *
 * 口径单源：区段扫描复用 qualityValidation.basisRegulationSectionRanges（与文本提取同源）；
 * 编号/书名提取、归一化、同族匹配原语在本模块单源导出（检测端与修复轮
 * basisRegulationsCrossRepair 共用同一判定——检测定位=修复定位）。
 *
 * 匹配口径（防误伤优先）：
 * - 编号：归一（去空白/零宽、破折号统一、大写）后精确相等，或较长者 = 较短者 +「-4 位年号」
 *   后缀（年号缺省容忍 GB 55037 ↔ GB 55037-2021；年度差异不判缺口——同一标准新旧版本引用
 *   保守视为同族，不触发重复补写）；
 * - 书名：归一（去书名号/括号注释/空白零宽）后精确相等或互为包含（短于 4 字只允许精确相等，
 *   防 2 字碎片误配）；
 * - 方向过滤：used_not_declared 书名只报「规范/标准/规程」结尾的技术标准类（《劳动法》
 *   《监理月报》等正文其他语境书名不参与）；declared_not_used 书名同尾部词过滤（编制依据
 *   列法规是合规要求，法/条例/办法类不要求正文逐条引用）；
 * - 配对容忍：声明/正文行内「《名》（编号）」成对时，编号未出现但配对书名命中 = 视为已用
 *   （正文以规范名引用而省略编号合法；反向同理——配对编号命中即视为该书名的引用已成立）；
 * - 输出合并：编号与书名同向缺口合并为 pair 一条（避免同一标准双报）；同族多写法（JGJ 130
 *   与 JGJ 130-2011）按同族去重，pair 信息最全优先保留。
 */
import { basisRegulationSectionRanges, extractBasisRegulationSection } from './qualityValidation';
import type { ValidationIssue } from './types';

// ═══════════════════════ 提取与归一化原语（检测/修复共用） ═══════════════════════

/** 标准编号族（GB/JGJ/CJJ/JTG/SL/DB/DL/YS/HG/DBJ；含 GB/T、DB34/T 省标带省号、
 * GB50011 连写、-年号段形态——s28l 实测《智慧工地建设标准》（DB34/T5175-2025）需捕获）；
 * 导出供修复轮 basisRegulationsCrossRepair 定位条目 span（检测定位=修复定位） */
export const REGULATION_CODE_RE = /(?:GB|JGJ|CJJ|JTG|SL|DB|DL|YS|HG|DBJ)[\s/T]*\d{1,2}[\s/-]?(?:T[\s/]*)?\d{2,4}(?:[\s/-]\d{1,4})?/gu;
/** 书名号条目（2~60 字；行内空白/零宽裂缝在归一化阶段剔除）；导出供修复轮定位条目 span */
export const REGULATION_BOOK_RE = /《[^《》\r\n]{2,60}?》/gu;
/** 技术标准类尾部词（双向对账只覆盖施工技术标准；法/条例/办法/其他文档类不参与缺口判定） */
const TECHNICAL_STANDARD_TAIL_RE = /(?:规范|标准|规程)$/u;
/** 书名短于该长度不参与包含匹配（防碎片误配；精确相等不受限） */
const NAME_CONTAINS_MIN_LENGTH = 4;

/** 标准编号提取（顺序保留，供证据片段定位） */
export function extractRegulationCodes(text: string): string[] {
  return [...text.matchAll(REGULATION_CODE_RE)].map(match => match[0]);
}

/** 书名号条目提取（去书名号，保留名称本体） */
export function extractRegulationBookNames(text: string): string[] {
  return [...text.matchAll(REGULATION_BOOK_RE)].map(match => match[0].replace(/《|》/gu, ''));
}

/** 编号归一：去空白与零宽字符、破折号统一为连字符、大写（/ 与 - 保留结构语义供年号判定） */
export function normalizeRegulationCode(raw: string): string {
  return raw.replace(/[\s\u200b\u200c\u200d\ufeff]/gu, '').replace(/[—–－]/gu, '-').toUpperCase();
}

/** 书名归一：去书名号、括号注释（如「（2011年版）」）、空白与零宽字符（保留汉字本体供包含匹配） */
export function normalizeRegulationName(raw: string): string {
  return raw
    .replace(/《|》/gu, '')
    .replace(/[（(][^）)]{0,40}[）)]/gu, '')
    .replace(/[\s\u200b\u200c\u200d\ufeff]/gu, '');
}

/** 技术标准类书名判定（归一后以 规范/标准/规程 结尾） */
export function isTechnicalStandardName(name: string): boolean {
  return TECHNICAL_STANDARD_TAIL_RE.test(normalizeRegulationName(name));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 编号同族匹配（年号缺省容忍；见模块头注释口径） */
export function sameRegulationCodeFamily(left: string, right: string): boolean {
  const normalizedLeft = normalizeRegulationCode(left);
  const normalizedRight = normalizeRegulationCode(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = normalizedLeft.length <= normalizedRight.length ? normalizedRight : normalizedLeft;
  return new RegExp(`^${escapeRegExp(shorter)}-\\d{4}$`, 'u').test(longer);
}

/** 书名同族匹配（精确相等或互为包含；短名只允许精确相等） */
export function regulationNameMatches(left: string, right: string): boolean {
  const normalizedLeft = normalizeRegulationName(left);
  const normalizedRight = normalizeRegulationName(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.length < NAME_CONTAINS_MIN_LENGTH || normalizedRight.length < NAME_CONTAINS_MIN_LENGTH) return false;
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

// ═══════════════════════ 双向对账审计 ═══════════════════════

/** 声明/引用条目（行内配对：同行的编号与书名号按出现顺序成对） */
interface CrossEntry {
  code?: string;
  name?: string;
}

/** 双向缺口条目（编号与书名同向缺口时合并为 pair 一条，避免同一标准双报） */
export interface BasisRegulationCrossGap {
  kind: 'code' | 'name' | 'pair';
  /** 主值：code→编号；name/pair→名称（去书名号） */
  value: string;
  /** 编号字段（kind=code/pair 时存在；同族去重与修复端落位消费） */
  code?: string;
  /** 名称字段（kind=name/pair 时存在） */
  name?: string;
  /** 配对信息（保留对方形态，供修复端组装条目） */
  counterpart?: string;
  /** 引用侧缺口的正文证据片段（令牌首现处 ±24 字，空白折叠单行） */
  context?: string;
}

export interface BasisRegulationCrossAudit {
  /** 声明未用：编制依据列了、正文（排除编制依据区段）零引用 */
  declaredNotUsed: BasisRegulationCrossGap[];
  /** 用了未声明：正文引用、编制依据未列 */
  usedNotDeclared: BasisRegulationCrossGap[];
  /** 观测计数（报告出口） */
  stats: { declaredCodes: number; declaredNames: number; usedCodes: number; usedNames: number };
}

/** 连接符白名单（编号与书名之间的合法连接文本；含实质文本说明非同一条目引用对） */
const PAIR_CONNECTOR_RE = /^[\s（）()【】\[\]、,，;；:：·.及和与]*$/u;

/** 行内邻近配对解析：每个编号与最近的未配对书名成对（先左后右；间隔仅连接符/空白）——
 * 顺序配对在多书名单编号行会错位（s28l 实测「《建质规〔2025〕5号》及《智慧工地建设标准》
 * （DB34/T5175-2025）」需配到第二本书名），故按位置邻近判定。 */
function pairLineEntries(text: string): CrossEntry[] {
  const entries: CrossEntry[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const tokens: Array<{ type: 'code' | 'name'; value: string; index: number; end: number }> = [];
    for (const match of line.matchAll(REGULATION_CODE_RE)) {
      const index = match.index ?? 0;
      tokens.push({ type: 'code', value: match[0], index, end: index + match[0].length });
    }
    for (const match of line.matchAll(REGULATION_BOOK_RE)) {
      const index = match.index ?? 0;
      tokens.push({ type: 'name', value: match[0].replace(/《|》/gu, ''), index, end: index + match[0].length });
    }
    if (tokens.length === 0) continue;
    tokens.sort((left, right) => left.index - right.index);
    const pairedName = new Map<number, number>();
    const pairedNameIndexes = new Set<number>();
    tokens.forEach((token, tokenIndex) => {
      if (token.type !== 'code') return;
      const findName = (direction: 'left' | 'right'): number => {
        const candidates = direction === 'left'
          ? tokens.slice(0, tokenIndex).map((_, offset) => tokenIndex - 1 - offset)
          : tokens.slice(tokenIndex + 1).map((_, offset) => tokenIndex + 1 + offset);
        for (const candidateIndex of candidates) {
          const candidate = tokens[candidateIndex];
          if (candidate.type !== 'name' || pairedNameIndexes.has(candidateIndex)) continue;
          const between = direction === 'left' ? line.slice(candidate.end, token.index) : line.slice(token.end, candidate.index);
          if (!PAIR_CONNECTOR_RE.test(between)) return -1;
          return candidateIndex;
        }
        return -1;
      };
      const leftIndex = findName('left');
      const nameIndex = leftIndex >= 0 ? leftIndex : findName('right');
      if (nameIndex >= 0) {
        pairedName.set(tokenIndex, nameIndex);
        pairedNameIndexes.add(nameIndex);
      }
    });
    const emitted = new Set<number>();
    tokens.forEach((token, tokenIndex) => {
      if (emitted.has(tokenIndex)) return;
      if (token.type === 'code') {
        const nameIndex = pairedName.get(tokenIndex);
        if (nameIndex !== undefined) {
          entries.push({ code: token.value, name: tokens[nameIndex].value });
          emitted.add(nameIndex);
        } else {
          entries.push({ code: token.value });
        }
        emitted.add(tokenIndex);
      } else if (!pairedNameIndexes.has(tokenIndex)) {
        entries.push({ name: token.value });
        emitted.add(tokenIndex);
      }
    });
  }
  return entries;
}

/** 正文证据片段（令牌首现处 ±24 字，空白折叠单行） */
function evidenceContext(text: string, token: string): string {
  const index = text.indexOf(token);
  if (index < 0) return '';
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + token.length + 24);
  return text.slice(start, end).replace(/\s+/gu, ' ').trim();
}

/** 缺口同族判定（编号族或名称族任一命中即同族；用于输出去重——同标准多写法只报一条） */
function gapSameFamily(left: BasisRegulationCrossGap, right: BasisRegulationCrossGap): boolean {
  if (left.code && right.code && sameRegulationCodeFamily(left.code, right.code)) return true;
  if (left.name && right.name && regulationNameMatches(left.name, right.name)) return true;
  return false;
}

/** 同族去重（序号遍历保持出现顺序；pair 信息最全，同族已有非 pair 条目时以 pair 替换） */
function mergeFamilyGaps(gaps: BasisRegulationCrossGap[]): BasisRegulationCrossGap[] {
  const merged: BasisRegulationCrossGap[] = [];
  for (const gap of gaps) {
    const existingIndex = merged.findIndex(existing => gapSameFamily(existing, gap));
    if (existingIndex < 0) {
      merged.push(gap);
      continue;
    }
    if (gap.kind === 'pair' && merged[existingIndex].kind !== 'pair') merged[existingIndex] = gap;
  }
  return merged;
}

/** 编制依据↔正文双向对账审计（检测/评分/修复共用单源）：
 * 声明侧条目 = 编制依据区段行内配对解析；引用侧条目 = 正文（排除区段）行内配对解析；
 * 双向缺口 = 同族匹配（编号年号缺省容忍 / 书名包含匹配）后无任何命中的声明/引用条目。
 * 配对容忍：编号与配对书名任一在对方侧命中即该条目视为已引用/已声明（对称判定）；两侧均
 * 零命中且书名为技术标准类时合并为 pair 一条，否则按编号/书名单独报出。 */
export function auditBasisRegulationsCross(markdown: string): BasisRegulationCrossAudit {
  const ranges = basisRegulationSectionRanges(markdown);
  const sectionText = extractBasisRegulationSection(markdown);
  const lines = markdown.split(/\r?\n/u);
  const excluded = new Set<number>();
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) excluded.add(index);
  }
  const bodyText = lines.filter((_, index) => !excluded.has(index)).join('\n');

  const declaredEntries = pairLineEntries(sectionText);
  const bodyEntries = pairLineEntries(bodyText);
  const declaredCodes = declaredEntries.filter(entry => entry.code).map(entry => entry.code!);
  const declaredNames = declaredEntries.filter(entry => entry.name).map(entry => entry.name!);
  const bodyCodes = bodyEntries.filter(entry => entry.code).map(entry => entry.code!);
  const bodyNames = bodyEntries.filter(entry => entry.name).map(entry => entry.name!);
  const codeUsedInBody = (code: string) => bodyCodes.some(bodyCode => sameRegulationCodeFamily(code, bodyCode));
  const nameUsedInBody = (name: string) => bodyNames.some(bodyName => regulationNameMatches(name, bodyName));
  const codeDeclared = (code: string) => declaredCodes.some(declared => sameRegulationCodeFamily(declared, code));
  const nameDeclared = (name: string) => declaredNames.some(declared => regulationNameMatches(declared, name));

  // ── 声明 → 正文（declared_not_used）：声明条目在正文零引用即缺口 ──
  const declaredRaw: BasisRegulationCrossGap[] = [];
  for (const entry of declaredEntries) {
    const codeHit = entry.code ? codeUsedInBody(entry.code) || (entry.name ? nameUsedInBody(entry.name) : false) : true;
    const nameHit = entry.name ? nameUsedInBody(entry.name) || (entry.code ? codeUsedInBody(entry.code) : false) : true;
    if (entry.code && !codeHit && entry.name && isTechnicalStandardName(entry.name)) {
      declaredRaw.push({ kind: 'pair', value: entry.name, code: entry.code, name: entry.name, counterpart: entry.code });
    } else if (entry.code && !codeHit) {
      declaredRaw.push({ kind: 'code', value: entry.code, code: entry.code, counterpart: entry.name });
    } else if (entry.name && isTechnicalStandardName(entry.name) && !nameHit) {
      declaredRaw.push({ kind: 'name', value: entry.name, name: entry.name, counterpart: entry.code });
    }
  }

  // ── 正文 → 声明（used_not_declared）：正文引用条目未进声明即缺口 ──
  const usedRaw: BasisRegulationCrossGap[] = [];
  for (const entry of bodyEntries) {
    const codeHit = entry.code ? codeDeclared(entry.code) || (entry.name ? nameDeclared(entry.name) : false) : true;
    const nameHit = entry.name ? nameDeclared(entry.name) || (entry.code ? codeDeclared(entry.code) : false) : true;
    if (entry.code && !codeHit && entry.name && isTechnicalStandardName(entry.name)) {
      usedRaw.push({ kind: 'pair', value: entry.name, code: entry.code, name: entry.name, context: evidenceContext(bodyText, entry.code) });
    } else if (entry.code && !codeHit) {
      usedRaw.push({ kind: 'code', value: entry.code, code: entry.code, context: evidenceContext(bodyText, entry.code) });
    } else if (entry.name && isTechnicalStandardName(entry.name) && !nameHit) {
      usedRaw.push({ kind: 'name', value: entry.name, name: entry.name, context: evidenceContext(bodyText, `《${entry.name}》`) });
    }
  }

  return {
    declaredNotUsed: mergeFamilyGaps(declaredRaw),
    usedNotDeclared: mergeFamilyGaps(usedRaw),
    stats: {
      declaredCodes: declaredCodes.length,
      declaredNames: declaredNames.length,
      usedCodes: bodyCodes.length,
      usedNames: bodyNames.length,
    },
  };
}

// ═══════════════════════ 检测器出口 ═══════════════════════

/** 每方向逐条报出的缺口上限（超出聚合一条，防报告淹没） */
const MAX_CROSS_ISSUES_PER_DIRECTION = 12;

/** 缺口条目标签渲染（检测器消息与修复轮指令/记录共用单源） */
export function renderGapLabel(gap: BasisRegulationCrossGap): string {
  if (gap.kind === 'pair') return `《${gap.name}》（${gap.code}）`;
  return gap.kind === 'code' ? `标准编号「${gap.value}」` : `《${gap.value}》`;
}

/** 编制依据↔正文双向对账检测器（standard-final 组）：
 * - used_not_declared：正文引用标准未列入编制依据小节 → error/blocker（编号正交形态误报率低；
 *   书名侧已按技术标准类尾部词过滤）；
 * - declared_not_used：编制依据列了、正文零引用 → warning（评标对照性缺口，修复轮消费清零）；
 * - 无编制依据区段或零声明条目时静默跳过（模板结构差异不误伤）。 */
export function basisRegulationsCrossIssues(markdown: string): ValidationIssue[] {
  const audit = auditBasisRegulationsCross(markdown);
  if (audit.stats.declaredCodes + audit.stats.declaredNames === 0) return [];
  const issues: ValidationIssue[] = [];
  const usedGaps = audit.usedNotDeclared;
  const declaredGaps = audit.declaredNotUsed;
  for (const gap of usedGaps.slice(0, MAX_CROSS_ISSUES_PER_DIRECTION)) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `编制依据对账缺口：正文引用${renderGapLabel(gap)}未列入编制依据小节${gap.context ? `（证据：…${gap.context}…）` : ''}`,
      suggestion: '请将该标准名称及编号按编号族补入编制依据小节同类目（与正文引用形态一致），不得改动正文既有引用。',
    });
  }
  if (usedGaps.length > MAX_CROSS_ISSUES_PER_DIRECTION) {
    const rest = usedGaps.slice(MAX_CROSS_ISSUES_PER_DIRECTION);
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `编制依据对账缺口：正文另有 ${rest.length} 处引用标准未列入编制依据小节（${rest.slice(0, 6).map(renderGapLabel).join('、')} 等）`,
      suggestion: '请统一核对编制依据小节与正文引用清单，补齐全部未声明标准条目。',
    });
  }
  for (const gap of declaredGaps.slice(0, MAX_CROSS_ISSUES_PER_DIRECTION)) {
    issues.push({
      level: 'warning',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `编制依据对账缺口：编制依据小节的${renderGapLabel(gap)}在正文无引用`,
      suggestion: '请在对应施工章节的工序/验收要求中落位该标准（或从未使用的编制依据中移除），保持编制依据与正文一一对应。',
    });
  }
  if (declaredGaps.length > MAX_CROSS_ISSUES_PER_DIRECTION) {
    const rest = declaredGaps.slice(MAX_CROSS_ISSUES_PER_DIRECTION);
    issues.push({
      level: 'warning',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `编制依据对账缺口：编制依据小节另有 ${rest.length} 条声明在正文无引用（${rest.slice(0, 6).map(renderGapLabel).join('、')} 等）`,
      suggestion: '请统一核对编制依据与正文引用清单，未使用条目在正文落位或从编制依据移除。',
    });
  }
  return issues;
}
