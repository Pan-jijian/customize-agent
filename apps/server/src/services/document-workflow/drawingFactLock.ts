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
import { stableHash } from './utils';
// 4.61 结构化实体：图纸事实的来源从「拍平文本」升级为「实体绑定」
import { annotationFacts, dimensionFacts, type CadEntity, type SourceAnchor } from '@customize-agent/knowledge';
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
/** 图纸衍生文档（目录/清单类，C3-6-2 分母治理）：内容为图纸名称列表而非设计事实，
 * 其 token（表格框架/列名残片）正文永不可能引用——计入分母即永不可达的隐形分母
 * （r28l 实测「图纸目录.xls」token 全为 col2..col10，引用率恒 50% 卡死）。
 * 判据锚定 basename 的文档类型词（跨项目通用，非项目专有名词）；仅按文件名判定不按全路径
 * （目录路径段可能含「图纸」目录名，不得误伤真实图纸） */
const DRAWING_DERIVED_FILE_RE = /图纸目录|设计目录|图纸清单|目录表/u;

function isDrawingEvidence(item: DocumentEvidence, fileProcessingByPath?: Map<string, string>): boolean {
  const basename = item.filePath.split('/').pop() || item.filePath;
  if (DRAWING_DERIVED_FILE_RE.test(basename)) return false;
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

/** 表格列名残片 token（Excel 解析产物 col2/COL10 形态，C3-6-2 提纯）：表格框架非设计事实，
 * 正文写作永不含此形态——入池即判定噪音（r28l 图纸目录实测 9 个 token 全为 colN 形态） */
const TABLE_COLUMN_TOKEN_RE = /^col\d+$/u;
/** 尺寸对拆分残片 token（「18x18x3」榨出 x18，「420x594」榨出 x594，C3-6-2 提纯）：
 * 正文写作引用完整尺寸对（18x18），不引用拆分残片——残片命中判定无意义
 * （注意：完整尺寸对 ^\d+x\d+$ 如 18x18/390x190 为真实规格 token，不在提纯范围） */
const DIMENSION_FRAGMENT_TOKEN_RE = /^x\d+$/u;

/**
 * 事实行 token 提取（正文落位验收锚点）：规格 token（单位数值/C30/DN100/Φ150/尺寸对）+
 * 规格代号 + 配比 + 图集编号；归一化后长度 ≥3 且非纯数字（短通用 token 如「4m」不参与判定）；
 * C3-6-2 提纯：表格列名残片（colN）与尺寸对拆分残片（xNNN）滤除——两类形态无设计事实语义，
 * 入池只会稀释判定质量或制造永不可达 token。
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
    .filter(token => token.length >= 3 && !/^\d+$/u.test(token)
      && !TABLE_COLUMN_TOKEN_RE.test(token) && !DIMENSION_FRAGMENT_TOKEN_RE.test(token)))];
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
  /**
   * 4.61 结构化实体读取（**有则优先**）：返回该文件的 CAD 实体图。
   *
   * 提供时，图纸事实从**结构化实体**推导（对象-属性-值-单位的绑定来自尺寸实体的被标注两点、
   * 图层语义、就近文字），而不是对拍平文本做结构恢复式正则。
   * 未提供或无实体时回退既有行级提取（行为不变，兼容旧库）。
   */
  loadCadEntities?: (filePath: string) => CadEntity[];
}): DrawingFactLock | undefined {
  const contentByFile = new Map<string, string[]>();
  const drawingFiles = new Set<string>();
  for (const item of input.evidence || []) {
    if (!item?.content || !isDrawingEvidence(item, input.fileProcessingByPath)) continue;
    drawingFiles.add(item.filePath);
    const list = contentByFile.get(item.filePath);
    if (list) list.push(item.content);
    else contentByFile.set(item.filePath, [item.content]);
  }
  if (drawingFiles.size === 0) return undefined;
  const groups: DrawingFactLockGroup[] = [];
  let unusableDrawings = 0;
  for (const sourceFile of drawingFiles) {
    const seen = new Set<string>();
    const factLines: string[] = [];
    const structuredLines = structuredFactLines(sourceFile, input.loadCadEntities);
    if (structuredLines.length > 0) {
      // 结构化路径：事实行由实体绑定直接给出（含尺寸的对象绑定），无需再猜
      for (const line of structuredLines) {
        if (line.length < FACT_LINE_MIN_CHARS || line.length > FACT_LINE_MAX_CHARS) continue;
        if (seen.has(line)) continue;
        seen.add(line);
        factLines.push(line);
        if (factLines.length >= PER_DRAWING_MAX_LINES) break;
      }
    } else {
      const contents = contentByFile.get(sourceFile) ?? [];
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

/**
 * 结构化事实行（4.61）：从 CAD 实体图推导「对象 属性 值 单位」。
 *
 * 与旧路径的本质差别是**绑定来源**：
 * - 尺寸实体：值取自组码 42/1，对象取自**被标注两点 + 就近文字实体 + 图层语义**（结构可判定）
 * - 文字实体：属性/值/关系由 `parseClauseFacts` 从**该实体自身的文本**解析（不跨实体串值）
 *
 * 渲染成行是为了复用既有的注入与验收通道（`renderDrawingFactLockText` / `drawingFactPlacement`）；
 * 渲染是消费层的事，**源数据仍是实体的对象绑定**。
 */
function structuredFactLines(sourceFile: string, loadCadEntities?: (filePath: string) => CadEntity[]): string[] {
  if (!loadCadEntities) return [];
  let entities: CadEntity[];
  try {
    entities = loadCadEntities(sourceFile) ?? [];
  } catch {
    return [];
  }
  if (entities.length === 0) return [];
  const anchorOf = (entity: CadEntity): SourceAnchor => ({
    filePath: sourceFile,
    carrier: entity.layer && /说明|总说明/u.test(entity.layer) ? 'drawing-note' : 'drawing-annotation',
    sheet: entity.sheet,
    layer: entity.layer,
    entityType: entity.entityType,
    position: entity.position,
  });
  const lines: string[] = [];
  for (const { facts } of [annotationFacts({ entities, anchorOf }), dimensionFacts({ entities, anchorOf })]) {
    for (const fact of facts) {
      const relation = fact.relation === '>=' ? '不小于' : fact.relation === '<=' ? '不大于' : fact.relation === 'range' ? '' : '';
      const value = fact.unit ? `${fact.value}${fact.unit}` : fact.value;
      const line = `${fact.subject} ${fact.attribute}${relation ? ` ${relation}` : ' '} ${value}`.replace(/\s+/gu, ' ').trim();
      if (line.length >= FACT_LINE_MIN_CHARS) lines.push(line);
    }
  }
  return lines;
}

/** 事实行与章节的相关性分：行命中章节 token（标题/小节切词）越多越相关 */
function lineRelevanceScore(line: string, tokens: string[]): number {
  return tokens.reduce((sum, token) => sum + (line.includes(token) ? 1 : 0), 0);
}

/** 深注入图纸数（C3-6-3 注入扩容）：相关性 top-N 份按 perDrawingMinLines 行深注入（保做法细节），
 * 其余份进入单行保底层——图纸数超出预算容量时，首段深注入只覆盖头部，中尾部靠覆盖段散列保底 */
const DEEP_INJECTION_GROUPS = 6;
/**
 * 相关性段预算份额（C3-6-3：含深段；余量分配给旋转覆盖段）。
 * 历史缺陷：保底循环按相关性序逐份 push，预算被前 ~22 份（每份 3 行）耗尽——118 份图纸仅 22 份
 * 获注入（s28l 实测 96 份从未注入，29 条未引用中 20 条从未获注入）；预算 8000 字符 vs 全份保底
 * 1 行需 17470 字符（均值 148 字符/行），无法全量保底——改为「相关性段 + 跨章旋转覆盖段」双段：
 * 每章相关性档吃到 55% 预算，其余 45% 按「稳定序 × 章节 hash 旋转」逐份 1 行散列注入，
 * 各章旋转起点不同使全量图纸跨章获得注入机会（目标 90% 引用率的分母覆盖前提）。
 */
const RELEVANCE_STAGE_SHARE = 0.55;

/**
 * 渲染图纸事实锁注入文本（B-T3 图纸行直读通道，C3-6-3 三段式扩容）：按章节相关性排序事实行后渲染，
 * 每份图纸保底行保证各图纸均有进入正文的机会（引用率验收 ≥1 处/份的前提），
 * 数据不经检索召回与注入截断直接进入写作提示词。三段结构：
 * ① 深段：相关性 top-DEEP_INJECTION_GROUPS 份 × perDrawingMinLines 行（本章核心图纸深注入）；
 * ② 相关性段：其余份 × 1 行（该份本章相关性首行），两段合计至 RELEVANCE_STAGE_SHARE 预算；
 * ③ 旋转覆盖段：全份按稳定序（sourceFile 字典序）以章节标题 hash 旋转起点逐份 1 行，至预算尽
 *   （每章起点不同 → 各份图纸跨章获得注入机会，图纸总数超出预算容量时的覆盖率保障）；
 * ④ 全局补足：两段后仍有预算（小池场景）时按「章节相关性 → 图纸序 → 行序」填满。
 */
export function renderDrawingFactLockText(lock: DrawingFactLock, chapterTitle: string, opts: { sections?: string[]; maxChars?: number; perDrawingMinLines?: number } = {}): string {
  if (!lock || lock.groups.length === 0) return '';
  const isDrawingHeavy = /设计|说明|构造|做法|材料|规格|施工方法|施工工艺|技术|结构|设备|安装|布置|质量|安全/u.test(chapterTitle);
  const defaultMaxChars = isDrawingHeavy ? 8000 : 6000;
  const maxChars = Math.max(1, opts.maxChars ?? defaultMaxChars);
  const perDrawingMinLines = Math.max(1, opts.perDrawingMinLines ?? 3);
  const tokens = chapterRelevanceTokens(chapterTitle, opts.sections || []);
  // 每图纸内部按相关性降序（同分保持原序）
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
  // ① 深段 + ② 相关性段（合计预算 = RELEVANCE_STAGE_SHARE）
  const relevanceBudget = Math.max(1, Math.floor(maxChars * RELEVANCE_STAGE_SHARE));
  for (const { group, ranked } of scoredGroups.slice(0, DEEP_INJECTION_GROUPS)) {
    for (const item of ranked.slice(0, perDrawingMinLines)) pushLine(item.line, group.sourceFile);
  }
  for (const { group, ranked } of scoredGroups.slice(DEEP_INJECTION_GROUPS)) {
    if (total >= relevanceBudget) break;
    if (ranked[0]) pushLine(ranked[0].line, group.sourceFile);
  }
  // ③ 旋转覆盖段：稳定序 × 章节 hash 旋转起点（起点随章确定且可复现；各章旋转覆盖互补）
  const stable = [...scoredGroups].sort((left, right) => (left.group.sourceFile < right.group.sourceFile ? -1 : left.group.sourceFile > right.group.sourceFile ? 1 : 0));
  const offset = stable.length > 0 ? parseInt(stableHash(`drawing-coverage:${chapterTitle}`).slice(0, 8), 16) % stable.length : 0;
  for (let step = 0; step < stable.length; step += 1) {
    if (total >= maxChars) break;
    const { group, ranked } = stable[(offset + step) % stable.length]!;
    if (ranked[0]) pushLine(ranked[0].line, group.sourceFile);
  }
  // ④ 全局补足：所有行按「章节相关性 → 图纸序 → 行序」排序填入剩余预算（小池两段后有余量时生效）
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

/** 正文归一化（与 token 同口径：去全部空白 + 全角冒号转半角 + 小写；C3-6-4 起导出供修复轮复检共源） */
export function normalizeDrawingMatchText(markdown: string) {
  return markdown.replace(/\s+/gu, '').replace(/：/gu, ':').toLowerCase();
}

/**
 * 图纸事实落位判定（引用率验收核心）：正文归一化文本命中该图纸任一 token → 该图纸已引用。
 * 可用图纸（有可判定 token）为分母；无可用图纸时 rate 记 1（不适用，无缺陷可判）。
 */
export function drawingFactPlacement(lock: DrawingFactLock, markdown: string): { referenced: DrawingFactLockGroup[]; unreferenced: DrawingFactLockGroup[]; rate: number } {
  if (!lock || lock.groups.length === 0) return { referenced: [], unreferenced: [], rate: 1 };
  const normalized = normalizeDrawingMatchText(markdown);
  const referenced: DrawingFactLockGroup[] = [];
  const unreferenced: DrawingFactLockGroup[] = [];
  for (const group of lock.groups) {
    if (group.tokens.some(token => normalized.includes(token))) referenced.push(group);
    else unreferenced.push(group);
  }
  return { referenced, unreferenced, rate: referenced.length / lock.groups.length };
}
