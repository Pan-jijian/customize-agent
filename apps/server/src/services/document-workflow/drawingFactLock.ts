/**
 * drawingFactLock：图纸事实锁——图纸「设计说明/构造做法/材料规格/设备参数」的确定性直读（B-T3）。
 *
 * 背景（B4 诊断：图纸引用 0% 的根因）：施工图纸经既有解析链（OCR/PDF 提取）进入证据池，但写作侧
 * 受检索召回竞争与注入硬顶影响——图纸切片（数百 KB 级）在向量空间弱势、注入窗口被短文本切片挤占，
 * 「设计说明/构造做法/材料规格/设备参数」从未进入正文；事实池的图纸结构化事实仅零星参数残片
 * （真实数据实测 15 条），不构成可用事实源。
 *
 * 本模块把图纸类证据（解析链产物）固化为行级事实锁：
 * - 提取：图纸类证据文本 → extractKeyFactLines 关键事实行（数值参数/规范编号/做法描述行），
 *   按来源图纸文件分组（来源标记=图纸文件名，仅锁内标注数据出处，正文不引用文件名）；
 * - 直读：renderDrawingFactLockText 按章节相关性渲染事实行注入写作提示词
 *   （与清单事实锁同范式：不经检索召回/注入截断）；
 * - 验收：drawingFactPlacement 判定「可用图纸引用率（图纸事实在正文落位 ≥1 处/份）」，
 *   由 drawingReferenceIssues（终检）与质量报告媒介分量消费同一判定。
 */
import { extractKeyFactLines } from './evidence';
import { chapterRelevanceTokens, extractSpecTokens } from './billFactLock';
import type { DocumentEvidence } from './types';

export interface DrawingFactLockGroup {
  /** 来源图纸文件（相对路径；渲染/展示时取 basename） */
  sourceFile: string;
  /** 关键事实行（extractKeyFactLines 提取，行级原文） */
  factLines: string[];
  /** 可判定 token（规格/参数/配比/规范/图集编号；正文落位验收锚点，已归一化小写去空白） */
  tokens: string[];
}

export interface DrawingFactLock {
  /** 可用图纸分组（含 ≥1 可判定 token 的图纸；不可用图纸不纳入引用率验收分母） */
  groups: DrawingFactLockGroup[];
  /** 可用图纸数 */
  usableDrawings: number;
  /** 识别到但无可用事实行的图纸数（解析质量不足，诊断展示用） */
  unusableDrawings: number;
  /** 全部可用事实行数 */
  totalFacts: number;
}

/** 图纸类证据判定：processingType 标注（图纸 kind 映射）或文件名/小节题含图纸类词 */
const DRAWING_FILE_RE = /dwg|dxf|图纸|施工图|设计图|总平面|平面图|立面图|剖面图|大样图|详图|cad/iu;

function isDrawingEvidence(item: DocumentEvidence, fileProcessingByPath?: Map<string, string>): boolean {
  const processing = item.processingType || fileProcessingByPath?.get(item.filePath) || '';
  if (processing === 'drawing') return true;
  return DRAWING_FILE_RE.test(`${item.filePath} ${item.sectionTitle || ''}`);
}

/** 规格代号 token（通用形态：字母代号+数字，如 C30/MU10/M7.5/Q235/DN100；非领域词表） */
const SPEC_CODE_TOKEN_RE = /[A-Za-z]{1,5}\s*[-/]?\s*\d{1,5}(?:\.\d+)?/gu;
/** 配比 token（1:2、1:2.5 防水砂浆类配比） */
const RATIO_TOKEN_RE = /\d+\s*[:：]\s*\d+(?:\.\d+)?/gu;
/** 图集/标准图编号 token（02S515、11G101-1、12J003 形态）；前置边界（非数字/小数点）：
 * 防止从「i=1.83 D258」「0.87D258」类坡度/尺寸标注中段榨出「83d258」类跨字段误配 token */
const ATLAS_CODE_TOKEN_RE = /(?<![\d.])\d{2}\s*[A-Za-z]{1,3}\s*\d{2,4}(?:\s*[-—]\s*\d{1,3})?/gu;

/** 事实行归一化：去全部空白 + 全角冒号转半角 + 小写（正文落位判定同口径） */
function normalizeToken(value: string) {
  return value.replace(/\s+/gu, '').replace(/：/gu, ':').toLowerCase();
}

/**
 * 事实行 token 提取（正文落位验收锚点）：规格 token（单位数值/C30/DN100/Φ150/尺寸对）+
 * 规格代号 + 配比 + 图集编号；归一化后长度 ≥3 且非纯数字（短通用 token 如「4m」不参与判定）。
 */
export function extractDrawingFactTokens(line: string): string[] {
  const rawTokens = [
    ...extractSpecTokens(line),
    ...(line.match(SPEC_CODE_TOKEN_RE) || []),
    ...(line.match(RATIO_TOKEN_RE) || []),
    ...(line.match(ATLAS_CODE_TOKEN_RE) || []),
  ];
  return [...new Set(rawTokens
    .map(normalizeToken)
    .filter(token => token.length >= 3 && !/^\d+$/u.test(token)))];
}

/** 每图纸事实行上限（防单份超大图纸占满锁内存；行按重要性已排序，截断保头部） */
const PER_DRAWING_MAX_LINES = 400;
/** 事实行有效长度区间（过短无信息量、过长叙述段不入锁） */
const FACT_LINE_MIN_CHARS = 8;
const FACT_LINE_MAX_CHARS = 300;

/** 行语义密度信号：中文（语义载体）与数字（标注碎片主成分）字符 */
const CJK_CHAR_RE = /[\u4e00-\u9fff]/gu;
const DIGIT_CHAR_RE = /\d/gu;
/**
 * 行级语义过滤（图纸解析文本定标：真实施工图 corpus 实测）。
 * 图纸解析产物含大量坐标表/标高串/坡度串等标注碎片行（数字与分隔符主导、几乎无中文），
 * 入锁既无写作价值又稀释提示词预算。保留判据（双通道）：
 * - 中文占比达标（语义叙述行）；或
 * - 数字占比低（数值规格叙述行，如水质标准/设备参数说明——中文占比不高但数字亦非主导）。
 */
const SEMANTIC_CJK_MIN = 2;
const SEMANTIC_CJK_RATIO = 0.15;
const FRAGMENT_DIGIT_RATIO_MAX = 0.25;

function isSemanticFactLine(line: string): boolean {
  const cjk = (line.match(CJK_CHAR_RE) || []).length;
  if (cjk < SEMANTIC_CJK_MIN) return false;
  if (cjk / line.length >= SEMANTIC_CJK_RATIO) return true;
  const digits = (line.match(DIGIT_CHAR_RE) || []).length;
  return digits / line.length <= FRAGMENT_DIGIT_RATIO_MAX;
}

/**
 * 构建图纸事实锁：图纸类证据 → 按来源文件分组 → 关键事实行提取 + token 判定锚点。
 * 无图纸类证据返回 undefined；有图纸但事实行/token 为空的分组计入 unusableDrawings（不纳入验收分母）。
 */
export function buildDrawingFactLock(input: {
  evidence: DocumentEvidence[];
  fileProcessingByPath?: Map<string, string>;
}): DrawingFactLock | undefined {
  const contentByFile = new Map<string, string[]>();
  for (const item of input.evidence || []) {
    if (!item?.content || !isDrawingEvidence(item, input.fileProcessingByPath)) continue;
    const list = contentByFile.get(item.filePath);
    if (list) list.push(item.content);
    else contentByFile.set(item.filePath, [item.content]);
  }
  if (contentByFile.size === 0) return undefined;
  const groups: DrawingFactLockGroup[] = [];
  let unusableDrawings = 0;
  for (const [sourceFile, contents] of contentByFile) {
    const seen = new Set<string>();
    const factLines: string[] = [];
    // 文件内多切片合并后整体提取：切片单独看上下文残缺（页眉/跨页行），合并后 extractKeyFactLines 行级筛选更稳
    for (const line of extractKeyFactLines(contents.join('\n')).split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length < FACT_LINE_MIN_CHARS || trimmed.length > FACT_LINE_MAX_CHARS) continue;
      if (!isSemanticFactLine(trimmed)) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      factLines.push(trimmed);
      if (factLines.length >= PER_DRAWING_MAX_LINES) break;
    }
    const tokens = [...new Set(factLines.flatMap(line => extractDrawingFactTokens(line)))];
    if (tokens.length === 0) {
      unusableDrawings += 1;
      continue;
    }
    groups.push({ sourceFile, factLines, tokens });
  }
  return {
    groups,
    usableDrawings: groups.length,
    unusableDrawings,
    totalFacts: groups.reduce((sum, group) => sum + group.factLines.length, 0),
  };
}

/** 事实行与章节的相关性分：行命中章节 token（标题/小节切词）越多越相关 */
function lineRelevanceScore(line: string, tokens: string[]): number {
  return tokens.reduce((sum, token) => sum + (line.includes(token) ? 1 : 0), 0);
}

/**
 * 渲染图纸事实锁注入文本（B-T3 图纸行直读通道）：按章节相关性排序事实行后渲染，
 * 每份图纸保底行保证各图纸均有进入正文的机会（引用率验收 ≥1 处/份的前提），
 * 数据不经检索召回与注入截断直接进入写作提示词。
 */
export function renderDrawingFactLockText(lock: DrawingFactLock, chapterTitle: string, opts: { sections?: string[]; maxChars?: number; perDrawingMinLines?: number } = {}): string {
  if (!lock || lock.groups.length === 0) return '';
  const isDrawingHeavy = /设计|说明|构造|做法|材料|规格|施工方法|施工工艺|技术|结构|设备|安装|布置|质量|安全/u.test(chapterTitle);
  const defaultMaxChars = isDrawingHeavy ? 8000 : 6000;
  const maxChars = Math.max(1, opts.maxChars ?? defaultMaxChars);
  const perDrawingMinLines = Math.max(1, opts.perDrawingMinLines ?? 3);
  const tokens = chapterRelevanceTokens(chapterTitle, opts.sections || []);
  // 每图纸内部按相关性降序（同分保持原序）；保底行 = 每图纸前 N 行，其余行进入全局补足池
  const scoredGroups = lock.groups.map(group => ({
    group,
    ranked: group.factLines
      .map((line, index) => ({ line, index, score: lineRelevanceScore(line, tokens) }))
      .sort((a, b) => b.score - a.score || a.index - b.index),
  }));
  const picked = new Set<string>();
  const lines: string[] = [];
  let total = 0;
  const pushLine = (line: string, sourceFile: string) => {
    const key = `${sourceFile}\u0000${line}`;
    if (picked.has(key)) return;
    const rendered = `${sourceFile.split('/').pop() || sourceFile}｜${line}`;
    if (total + rendered.length + 1 > maxChars) return;
    picked.add(key);
    lines.push(rendered);
    total += rendered.length + 1;
  };
  for (const { group, ranked } of scoredGroups) {
    for (const item of ranked.slice(0, perDrawingMinLines)) pushLine(item.line, group.sourceFile);
  }
  // 全局补足：所有行按「章节相关性 → 图纸序 → 行序」排序填入剩余预算
  const remaining = scoredGroups
    .flatMap(({ group, ranked }) => ranked.map(item => ({ ...item, sourceFile: group.sourceFile })))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  for (const item of remaining) {
    if (total >= maxChars) break;
    pushLine(item.line, item.sourceFile);
  }
  if (lines.length === 0) return '';
  const sourceNames = lock.groups.map(group => group.sourceFile.split('/').pop() || group.sourceFile);
  return [
    '【图纸事实锁——图纸资料确定性事实（数据来自施工图纸解析，逐项照抄，不得编造或改动）】',
    `图纸来源：${sourceNames.slice(0, 6).join('、')}${sourceNames.length > 6 ? ` 等 ${sourceNames.length} 份` : ''}；本节锁定 ${lines.length} 行（行首为来源图纸名）。`,
    '图纸设计说明、构造做法、材料规格与设备参数是施工依据：给出的规格/配比/做法必须逐项照抄原值；图纸未给的不得自行假设或编造。',
    ...lines,
  ].join('\n');
}

/** 正文归一化（与 token 同口径：去全部空白 + 全角冒号转半角 + 小写） */
function normalizeBody(markdown: string) {
  return markdown.replace(/\s+/gu, '').replace(/：/gu, ':').toLowerCase();
}

/**
 * 图纸事实落位判定（引用率验收核心）：正文归一化文本命中该图纸任一 token → 该图纸已引用。
 * 可用图纸（有可判定 token）为分母；无可用图纸时 rate 记 1（不适用，无缺陷可判）。
 */
export function drawingFactPlacement(lock: DrawingFactLock, markdown: string): { referenced: DrawingFactLockGroup[]; unreferenced: DrawingFactLockGroup[]; rate: number } {
  if (!lock || lock.groups.length === 0) return { referenced: [], unreferenced: [], rate: 1 };
  const normalized = normalizeBody(markdown);
  const referenced: DrawingFactLockGroup[] = [];
  const unreferenced: DrawingFactLockGroup[] = [];
  for (const group of lock.groups) {
    if (group.tokens.some(token => normalized.includes(token))) referenced.push(group);
    else unreferenced.push(group);
  }
  return { referenced, unreferenced, rate: referenced.length / lock.groups.length };
}
