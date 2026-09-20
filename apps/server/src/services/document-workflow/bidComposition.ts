/**
 * 标书编制规格（BidCompositionSpec）——一处判定、全链消费。
 *
 * 从招标文件直读切片确定性识别标书类型（暗标/明标）与编制要求（正文口径、文末附表清单、
 * 格式要求、投标人身份禁语），逐条带招标原文证据；判定结果驱动全链：
 *   阶段2 小节规划/表格计划（暗标正文禁表 → 不产出表格需求）→
 *   阶段3 一体化蓝图（composition 段承接：附表清单与数据源绑定）→
 *   阶段4 写作（禁表/禁图注入）与门禁（正文表格反向阻断）→
 *   终稿（文末附表按清单从蓝图数据直出）与封面口径。
 *
 * 冲突裁决原则：招标文件 > 用户提示词 > 系统默认。提示词声明的必需表格与暗标正文禁表
 * 冲突时收敛（能对应附表清单的收敛入附表，其余取消表格形式转文字表述），全部记录在
 * conflicts 并显性展示，不静默丢弃。
 */
import { extractAppendixTables } from './promptRuleExtraction';

/** 勾选标记字符集（PDF 提取常见：「☑暗标」「√暗标」「■暗标」等；含填充方块变体 ▣） */
const CHECK_MARK = '[☑√✔✓■●◼☒⊠▣]';

/**
 * 标记与文字间的可选中缀（PDF 提取对勾选框的常见变形，标记识别零容忍丢失）：
 * 空格与换行、「☑️」emoji 变体选择符（U+FE0E/FE0F）、括号包裹（「☑（暗标）」「（☑）暗标」「√【暗标】」）。
 */
const MARK_GAP = '[\\uFE0E\\uFE0F\\s（）()【】\\[\\]〔〕]*';

/** 勾选标记双形态：标记在词前（「☑暗标」）与词后（「暗标（√）」——两种排版写法均存在） */
function markPatterns(word: string): RegExp[] {
  const chars = [...word];
  const inner = `${chars[0]}\\s*${chars[1]}`;
  return [
    new RegExp(`${CHECK_MARK}${MARK_GAP}${inner}`, 'u'),
    new RegExp(`${inner}${MARK_GAP}${CHECK_MARK}`, 'u'),
  ];
}
const BLIND_MARK_PATTERNS = markPatterns('暗标');
const OPEN_MARK_PATTERNS = markPatterns('明标');

/**
 * 语义判定通道（勾选标记不可见或未被提取时的兜底）：暗标/明标编制与评审规则的文本结构证据。
 * 词面为通用表述（「按暗标」「采用暗标评审」等），不含章节名/编号等位置假设；否定语境（「不按暗标」）不命中。
 */
const BLIND_SEMANTIC_SIGNALS = [
  /暗标(?:评审项目)?的?编制要求/u,
  /(?<!不)按暗标/u,
  /(?<!不)(?:采用|执行|实行)暗标(?:评审|方式|编制|形式)/u,
  /暗标(?:评审|编制)(?:方式|办法|程序)/u,
];
const OPEN_SEMANTIC_SIGNALS = [
  /明标(?:评审项目)?的?编制要求/u,
  /(?<!不)按明标/u,
  /(?<!不)(?:采用|执行|实行)明标(?:评审|方式|编制|形式)/u,
  /明标(?:评审|编制)(?:方式|办法|程序)/u,
];

/** 依序取首个命中（返回匹配原文，供证据链显性展示） */
function firstPatternHit(scope: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(scope);
    if (match) return (match[0] || '').trim();
  }
  return undefined;
}

export interface BidAppendixEntry {
  /** 附表编号（一/二/三/…） */
  no: string;
  /** 完整标题（「附表一 拟投入本标段的主要施工设备表」） */
  title: string;
  kind: 'table' | 'figure';
  /** 数据源绑定：蓝图数据路径或 manual（编制人人工补充） */
  dataSource: 'blueprint.equipment' | 'blueprint.testInstruments' | 'blueprint.labor' | 'blueprint.tempLand' | 'manual';
}

export interface BidCompositionConflict {
  rule: string;
  source: string;
  resolution: string;
}

export interface BidCompositionFormatRules {
  /** 单黑色（招标「一律单黑色」）：导出与写作禁色提示 */
  monoColor?: boolean;
  /** 内封面（暗标「不设内封面」→ forbidden：终稿移除封面块） */
  cover?: 'forbidden' | 'required';
  /** 页眉页脚页码（暗标「不需编制页眉、页脚、页码」） */
  headersFooters?: 'forbidden';
  bodyFont?: string;
  bodySize?: string;
  headingSize?: string;
  headingFont?: string;
  /** 装订线（如 0.3-0.6cm） */
  gutter?: string;
  /** 行距（如 固定值25磅） */
  lineHeight?: string;
  /** 总页数上限（超页扣分项） */
  pageLimit?: number;
}

export interface BidCompositionSpec {
  bidType: 'blind' | 'open' | 'unknown';
  bodyTablePolicy: 'forbidden' | 'allowed';
  bodyFigurePolicy: 'forbidden' | 'allowed';
  appendixPlan: BidAppendixEntry[];
  formatRules: BidCompositionFormatRules;
  /** 投标人身份标记禁语（暗标(7)：不得出现投标人名称/以往业绩/获奖） */
  identityMarksForbidden: boolean;
  /** 提示词↔招标口径冲突裁决记录（显性可审计） */
  conflicts: BidCompositionConflict[];
  /** 判定证据（招标原文句/结构证据，逐条可追溯） */
  evidence: string[];
}

/** 附表标题 → 分类与数据源绑定（附表一/二/三/六 表类绑蓝图数据；四/五 图类人工补图） */
export function appendixKindAndSource(name: string): { kind: 'table' | 'figure'; dataSource: BidAppendixEntry['dataSource'] } {
  if (/施工设备表|机械设备表|施工机械.*设备/u.test(name)) return { kind: 'table', dataSource: 'blueprint.equipment' };
  if (/试验.*仪器|检测仪器|试验仪器|仪器设备表/u.test(name)) return { kind: 'table', dataSource: 'blueprint.testInstruments' };
  if (/劳动力/u.test(name)) return { kind: 'table', dataSource: 'blueprint.labor' };
  if (/临时用地/u.test(name)) return { kind: 'table', dataSource: 'blueprint.tempLand' };
  if (/网络图|进度图|横道图|开.*竣工/u.test(name)) return { kind: 'figure', dataSource: 'manual' };
  if (/总平面/u.test(name)) return { kind: 'figure', dataSource: 'manual' };
  return { kind: 'table', dataSource: 'manual' };
}

/** 文本内取「施工组织设计采用」标记窗口（±尾随 320 字符，覆盖「□明标。☑暗标。」段） */
function adoptionWindows(text: string) {
  const windows: string[] = [];
  for (const match of text.matchAll(/施工组织设计\s*采用\s*[:：]?/gu)) {
    const start = match.index || 0;
    windows.push(text.slice(start, start + 320));
  }
  return windows;
}

function firstMatch(text: string, pattern: RegExp) {
  const match = pattern.exec(text);
  return match ? (match[0] || '').trim() : undefined;
}

/**
 * 标书编制规格提取（确定性，无 LLM）：标书类型 + 正文口径 + 附表清单 + 格式要求 + 身份禁语。
 * 输入为招标/补疑/答疑/评标文件全量切片文本（直读通道，与评分项要求提取链同源）。
 */
export function extractBidCompositionSpec(input: {
  /** 招标/补疑/答疑/评标文件切片文本（全量直读，不依赖检索命中） */
  tenderTexts: string[];
  /** 用户需求文本（补充证据：用户可直接声明标书类型与附表清单） */
  requirement?: string;
  /** 运行时提示词规则（冲突裁决输入：requiredTables） */
  requiredTables?: string[];
}): BidCompositionSpec {
  const normalized = [...input.tenderTexts, input.requirement || '']
    .filter(Boolean)
    .join('\n')
    .replace(/\\n/gu, '\n')
    .replace(/\r/gu, '');
  const evidence: string[] = [];

  // ── 1) 标书类型（F-T1 双通道加固）：勾选标记（最高证据，含字符/间距/括号/词后变体）→
  //      语义结构证据（「按暗标」「采用暗标评审」等条款兜底）→ unknown（显性展示不猜测） ──
  const windows = adoptionWindows(normalized);
  const adoptScope = windows.length > 0 ? windows.join('\n') : normalized;
  const blindMarked = firstPatternHit(adoptScope, BLIND_MARK_PATTERNS);
  const openMarked = firstPatternHit(adoptScope, OPEN_MARK_PATTERNS);
  const blindSemantic = firstPatternHit(normalized, BLIND_SEMANTIC_SIGNALS);
  const openSemantic = firstPatternHit(normalized, OPEN_SEMANTIC_SIGNALS);
  let bidType: BidCompositionSpec['bidType'] = 'unknown';
  if (blindMarked) {
    bidType = 'blind';
    evidence.push(`标书类型勾选证据：${blindMarked}`);
  } else if (openMarked) {
    bidType = 'open';
    evidence.push(`标书类型勾选证据：${openMarked}`);
  } else if (blindSemantic) {
    bidType = 'blind';
    evidence.push(`结构证据：识别到「${blindSemantic}」条款（语义判定通道——勾选标记不可见或未被提取时的兜底，招标文件为该标段设定暗标编制条款）`);
  } else if (openSemantic) {
    bidType = 'open';
    evidence.push(`结构证据：识别到「${openSemantic}」条款（语义判定通道——按明标口径编制）`);
  }

  // 正文口径：暗标双证据——「正文内不允许出现非文字需要的其他任何符号和标志」+「除文字表述外可附下列图表」
  // 容忍 PDF 分页断词（kb 切片标题标记可能插在句中：舒城「正文内不允许\n### 出现非文字…」）
  const bodyTableForbiddenSentence = firstMatch(normalized, /正文内不允许[\s\S]{0,24}?出现非文字需要的其他任何符号和标志/u);
  const appendixOnlySentence = firstMatch(normalized, /除(?:采用)?文字表述外可附下列图表|图表及格式要求附后/u);
  const noFigureSentence = firstMatch(normalized, /不得有图片和扉页|不得有图片/u);
  const bodyTablePolicy: BidCompositionSpec['bodyTablePolicy'] = bidType === 'blind' ? 'forbidden' : 'allowed';
  const bodyFigurePolicy: BidCompositionSpec['bodyFigurePolicy'] = bidType === 'blind' ? 'forbidden' : 'allowed';
  if (bidType === 'blind') {
    if (bodyTableForbiddenSentence) evidence.push(`正文口径证据：${bodyTableForbiddenSentence}`);
    if (appendixOnlySentence) evidence.push(`正文口径证据：${appendixOnlySentence}（正文=文字表述，图表=文末附表）`);
    if (noFigureSentence) evidence.push(`图片口径证据：${noFigureSentence}`);
  }

  // ── 3) 文末附表清单（复用 4.33 提取器）→ 分类与数据源绑定 ──
  const scanned = extractAppendixTables(normalized);
  const appendixPlan: BidAppendixEntry[] = scanned.titles.map(title => {
    const no = title.replace(/^附表\s*/u, '').split(/\s+/u)[0] || '';
    const name = title.replace(/^附表\s*[一二三四五六七八九十\d]{1,3}\s*/u, '').trim();
    return { no, title, ...appendixKindAndSource(name) };
  });
  if (appendixPlan.length > 0) evidence.push(`文末附表清单 ${appendixPlan.length} 项：${appendixPlan.map(item => item.title).join('、')}`);

  // ── 4) 格式要求（字体/字号/装订线/行距/页眉页脚/封面/页数上限/单黑色） ──
  const bodyType = /正文(?:部分)?(?:一律|均)?采用\s*(小?[一二三四五六七八九十]号)?\s*([\u4e00-\u9fffA-Za-z_]{2,10})/u.exec(normalized);
  const headingType = /大标题用\s*([小]?[一二三四五六七八九十]号)\s*([\u4e00-\u9fffA-Za-z_]{2,10})/u.exec(normalized);
  const gutterMatch = /装订线\s*([\d.]+\s*[-~－—]\s*[\d.]+\s*cm|[\d.]+\s*cm)/u.exec(normalized);
  const lineHeightMatch = /行间距为固定值\s*(\d+)\s*磅/u.exec(normalized);
  const pageLimitMatch = /(?:总页数上限|页数上限)\s*[:：]?\s*(\d+)|不得超过\s*(\d+)\s*页/u.exec(normalized);
  const formatRules: BidCompositionFormatRules = {
    monoColor: /一律单黑色|全部单黑色|均单黑色/u.test(normalized) ? true : undefined,
    cover: /不设内封(?:面)?/u.test(normalized) ? 'forbidden' : undefined,
    headersFooters: /不需编制页眉、页脚|不编制页眉|不需要页眉|不需编制页眉/u.test(normalized) ? 'forbidden' : undefined,
    bodyFont: bodyType?.[2] ? `${bodyType[2]}${/GB2312/iu.test(normalized) ? '（GB2312）' : ''}` : undefined,
    bodySize: bodyType?.[1] || undefined,
    headingSize: headingType?.[1] || undefined,
    headingFont: headingType?.[2] || undefined,
    gutter: gutterMatch?.[1]?.replace(/\s+/gu, '') || undefined,
    lineHeight: lineHeightMatch?.[1] ? `固定值${lineHeightMatch[1]}磅` : undefined,
    pageLimit: pageLimitMatch ? Number(pageLimitMatch[1] || pageLimitMatch[2]) || undefined : undefined,
  };
  const identityMarksForbidden = /明示或暗示具体投标人|以往的施工业绩/u.test(normalized);
  if (identityMarksForbidden) evidence.push('投标人身份禁语证据：任何部位、任何条文出现明示或暗示具体投标人的说明及标记（包括以往的施工业绩等）');

  // ── 5) 冲突裁决：提示词必需表格 vs 正文禁表（招标文件 > 用户提示词 > 系统默认） ──
  const conflicts: BidCompositionConflict[] = [];
  if (bodyTablePolicy === 'forbidden' && (input.requiredTables || []).length > 0) {
    for (const rawTitle of input.requiredTables || []) {
      const table = rawTitle.trim();
      if (!table) continue;
      const mapped = appendixPlan.find(entry => appendixNameMatchesTable(entry.title, table));
      conflicts.push({
        rule: `提示词必需表格《${table}》`,
        source: '用户提示词',
        resolution: mapped
          ? `招标暗标正文禁表：该表已收敛入文末《${mapped.title}》，正文不再输出表格`
          : '招标暗标正文禁表：该表取消表格形式，数据以对应章节文字表述呈现',
      });
    }
  }

  return {
    bidType,
    bodyTablePolicy,
    bodyFigurePolicy,
    appendixPlan,
    formatRules,
    identityMarksForbidden,
    conflicts,
    evidence,
  };
}

/** 提示词表名与附表标题匹配（去「附表N」前缀后双向包含，容忍「设备表」↔「主要施工设备表」缩略） */
function appendixNameMatchesTable(appendixTitle: string, tableTitle: string) {
  const appendixName = appendixTitle
    .replace(/^附表\s*[一二三四五六七八九十\d]{1,3}\s*/u, '')
    .replace(/\s+/gu, '')
    .replace(/表$/u, '');
  const table = tableTitle.replace(/\s+/gu, '').replace(/表$/u, '');
  if (!appendixName || !table) return false;
  return appendixName.includes(table) || table.includes(appendixName);
}

/** 正文禁表（暗标纯文字口径） */
export function isBodyTableForbidden(spec: BidCompositionSpec | undefined) {
  return spec?.bodyTablePolicy === 'forbidden';
}

/** 正文禁图（暗标纯文字口径，与禁表并列） */
export function isBodyFigureForbidden(spec: BidCompositionSpec | undefined) {
  return spec?.bodyFigurePolicy === 'forbidden';
}

/**
 * 写作约束文本（暗标口径注入写作/修复提示词；明标返回空串不注入）。
 * 含：禁表格/禁图片/禁无关标记/身份禁语 + 数据以文字表述（数值引用蓝图锚点）。
 */
export function bidCompositionWritingRules(spec: BidCompositionSpec | undefined): string {
  if (!spec || spec.bodyTablePolicy !== 'forbidden') return '';
  return [
    '【正文编制口径（招标文件暗标要求，硬性验收项）】',
    '1. 正文一律纯文字表述：不得输出任何 Markdown 表格或管道符表格结构；不得插入图片、Markdown 图片语法或图件占位；不得出现与投标内容无关的文字、字符或标记。',
    '2. 数据性内容以段落文字表述：人数、台数、工艺参数、计划节点等数值一律原样引用蓝图权威锚点，不得编造或自设。',
    '3. 结构化数据表由系统在文末附表区按招标附表清单统一生成，正文不重复列出、不预告「详见附表」之外的指引性表格。',
    spec.identityMarksForbidden ? '4. 不得出现任何明示或暗示具体投标人的说明及标记（投标人名称、以往施工业绩、获奖情况等一律不得写入正文）。' : '',
  ].filter(Boolean).join('\n');
}

/** 门禁/修复提示中的拆表指令（禁表模式修复用） */
export function bodyTableDismantleIssue(tableCount: number): string {
  return `暗标正文禁表（招标编制要求，违反即施工组织设计部分不得分）：本章正文出现 ${tableCount} 处 Markdown 表格结构。请把每处表格的承载数据改写为段落式连贯叙述（数值、口径保持不变，数据原样保留），删除表格表头与分隔线结构；不得新增或删除其它正文内容。`;
}

/**
 * 提示词规则行消解（暗标判定后调用）：从运行时规则文本中移除「必须输出以下正式 Markdown 表格」行
 * （runtimePromptRulesPrompt 编号产物），使写作/事实提取/审查/修复提示词链与招标暗标口径一致。
 * 命中该行模式时返回消解后文本，否则原样返回。
 */
export function stripRequiredTableRuleLine(text: string): string {
  if (!text) return text;
  return text.replace(/^\s*(?:\d+[.、]\s*)?必须输出以下正式\s*Markdown\s*表格[:：][^\n]*\n?/gmu, '');
}

/** 标书编制规格进度摘要（显性展示判定与裁决，可审计） */
export function bidCompositionSummary(spec: BidCompositionSpec): { status: 'success' | 'skipped'; message: string; details: string[] } {
  const typeLabel = spec.bidType === 'blind' ? '暗标' : spec.bidType === 'open' ? '明标' : '未识别（按常规口径）';
  const parts = [
    `标书类型：${typeLabel}`,
    spec.bidType === 'blind' ? '正文纯文字（禁表格/禁图片）' : spec.bidType === 'open' ? '正文可使用表格' : '正文表格策略未启用特定限制',
    spec.appendixPlan.length > 0 ? `文末附表 ${spec.appendixPlan.length} 项（表类 ${spec.appendixPlan.filter(item => item.kind === 'table').length} / 图类 ${spec.appendixPlan.filter(item => item.kind === 'figure').length}）` : '未识别文末附表清单',
    spec.formatRules.pageLimit ? `总页数上限 ${spec.formatRules.pageLimit} 页` : '',
  ].filter(Boolean);
  const details = [
    ...spec.evidence.map(item => `证据：${item}`),
    ...(spec.bidType === 'unknown' ? ['核查指引：检索招标文件「施工组织设计采用」勾选项（标记字符变体 ☑/√/■/▣ 与「按暗标/采用暗标评审」语义条款均已覆盖）或「暗标编制要求」条款，确认标书类型后重跑以切换编制口径'] : []),
    ...spec.appendixPlan.map(item => `附表${item.no}：${item.title}（${item.kind === 'figure' ? '图类·编制人补图' : `数据源 ${item.dataSource}`}）`),
    spec.formatRules.gutter ? `格式：装订线 ${spec.formatRules.gutter}${spec.formatRules.lineHeight ? `、行距${spec.formatRules.lineHeight}` : ''}` : '',
    spec.formatRules.bodyFont ? `格式：正文 ${[spec.formatRules.bodySize, spec.formatRules.bodyFont].filter(Boolean).join(' ')}${spec.formatRules.headingSize ? `、大标题 ${spec.formatRules.headingSize}` : ''}` : '',
    spec.formatRules.cover === 'forbidden' ? '格式：不设内封面（终稿移除封面块）' : '',
    spec.formatRules.monoColor ? '格式：图表一律单黑色' : '',
    spec.identityMarksForbidden ? '身份禁语：正文不得出现投标人名称/以往业绩等标记' : '',
    ...spec.conflicts.map(item => `冲突裁决：${item.rule}——${item.resolution}`),
  ].filter(Boolean);
  return {
    status: spec.bidType === 'unknown' ? 'skipped' : 'success',
    message: spec.bidType === 'unknown'
      ? '⚠ 标书类型未判定（告警）：未识别到「本项目施工组织设计采用：□明标/☑暗标」勾选标记与暗标编制要求语义证据，本次按常规（明标）口径生成——若本项目实为暗标，正文将错用明标口径（表格/图片本应禁止）导致施工组织设计部分不得分，请核对招标文件后重跑'
      : `标书编制规格：${parts.join('；')}`,
    details,
  };
}
