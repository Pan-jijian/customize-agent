/**
 * 标书编制规格（BidCompositionSpec）——一处判定、全链消费。
 *
 * 从招标文件直读切片确定性识别标书类型（暗标/明标）与编制要求（正文表格/图片口径、文末附表清单、
 * 格式要求、投标人身份禁语），逐条带招标原文证据；正文表格口径为证据驱动三态判定（C1：显式禁表句→
 * forbidden；允许句或无证据→allowed；「禁无关系符号句」属排版条款不构成禁表——不得按标书类型硬推，
 * 暗标招标明确允许正文图表的实例真实存在）。判定结果驱动全链：
 *   阶段2 小节规划/表格计划（正文禁表 → 不产出表格需求；允许 → 表格计划正常构建）→
 *   阶段3 一体化蓝图（composition 段承接：附表清单与数据源绑定）→
 *   阶段4 写作（表格计划口径/禁表/禁图/单黑色注入）与门禁（无计划表格章级授权阻断）→
 *   终稿（文末附表按清单从蓝图数据直出）与封面口径。
 *
 * 冲突裁决原则：招标文件 > 用户提示词 > 系统默认。提示词声明的必需表格与招标正文禁表（显式禁表句）
 * 冲突时收敛（能对应附表清单的收敛入附表，其余取消表格形式转文字表述），全部记录在
 * conflicts 并显性展示，不静默丢弃。
 */
import type { DocumentExportSettings } from './types';
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
  /** 数据源绑定：蓝图数据路径或 manual（编制人人工补充）；C2 起图类附表（进度/总平面）亦绑定蓝图数据源表格化落位 */
  dataSource: 'blueprint.equipment' | 'blueprint.testInstruments' | 'blueprint.labor' | 'blueprint.tempLand' | 'blueprint.schedule' | 'manual';
}

export interface BidCompositionConflict {
  rule: string;
  source: string;
  resolution: string;
}

/**
 * 招标规定排版 → 导出设置（4.55.22）。
 *
 * ## 为什么必须做
 *
 * `formatRules` 从招标文件确定性抽取（正文字体/字号/行距/装订线/页数上限…），但此前**只用于进度展示**，
 * 导出走的是模板自己的 `exportSettings.typography`——**招标强制的排版没有落到交付物上，且无任何提示**。
 * 暗标/格式分项项目里，字体或行距不符即直接失分。
 *
 * ## 为什么不能直接赋值
 *
 * 抽取值是**中文排版惯用写法**，直接塞进 CSS/导出参数会产出非法样式：
 * - 字号是「小四/三号」这类号数名，而导出端按 CSS 字号消费（`12pt`）→ 必须换算为磅值；
 * - 字体名带括注（`仿宋_GB2312（GB2312）`）→ 必须取正名并给出回退族；
 * - 行距是「固定值28磅」→ 导出端按 pt 解析，需归一为 `28pt`。
 * 故此处做**显式换算**，而不是照抄字符串。
 */
const CN_FONT_SIZE_PT: Record<string, number> = {
  初号: 42, 小初: 36, 一号: 26, 小一: 24, 二号: 22, 小二: 18,
  三号: 16, 小三: 15, 四号: 14, 小四: 12, 五号: 10.5, 小五: 9, 六号: 7.5, 小六: 6.5,
};

/** 字体正名 + 常见中文印刷字体的回退族（导出端按 CSS font-family 消费） */
function exportFontFamily(raw: string | undefined): string | undefined {
  const name = String(raw || '').replace(/[（(][^）)]*[）)]/gu, '').trim();
  if (!name) return undefined;
  const fallbacks: Record<string, string> = {
    仿宋_GB2312: '"仿宋_GB2312", "FangSong_GB2312", "仿宋", FangSong, serif',
    仿宋: '"仿宋", FangSong, serif',
    楷体_GB2312: '"楷体_GB2312", "KaiTi_GB2312", "楷体", KaiTi, serif',
    楷体: '"楷体", KaiTi, serif',
    宋体: '"宋体", SimSun, serif',
    黑体: '"黑体", SimHei, sans-serif',
  };
  return fallbacks[name] || `"${name}", serif`;
}

/** 「小四」→ `12pt`；已是磅值写法（`12pt`/`12磅`）则归一为 `Npt` */
function exportFontSizePt(raw: string | undefined): string | undefined {
  const text = String(raw || '').replace(/\s+/gu, '');
  if (!text) return undefined;
  const named = CN_FONT_SIZE_PT[text];
  if (named !== undefined) return `${named}pt`;
  const numeric = /([\d.]+)\s*(?:pt|磅)?/iu.exec(text);
  return numeric && Number.isFinite(Number(numeric[1])) ? `${Number(numeric[1])}pt` : undefined;
}

/** 「固定值28磅」/「28磅」/「28pt」→ `28pt` */
function exportLineHeight(raw: string | undefined): string | undefined {
  const numeric = /([\d.]+)/u.exec(String(raw || ''));
  return numeric && Number.isFinite(Number(numeric[1])) ? `${Number(numeric[1])}pt` : undefined;
}

/**
 * 把招标规定的排版并入导出设置（**招标优先于模板**：前者是强制要求，后者是默认值）。
 * @returns 生效项描述（供进度/报告显性展示「招标排版已应用」），无生效项时为空数组
 */
export function applyFormatRulesToExportSettings(
  settings: DocumentExportSettings | undefined,
  rules: BidCompositionFormatRules | undefined,
): { settings: DocumentExportSettings | undefined; applied: string[] } {
  if (!rules) return { settings, applied: [] };
  const applied: string[] = [];
  const next: DocumentExportSettings = { ...(settings || {}) };
  const page = { ...(next.page || {}) };
  const typography = { ...(next.typography || {}) };
  const targetPages = { ...(next.targetPages || {}) };

  const bodyFont = exportFontFamily(rules.bodyFont);
  if (bodyFont) { typography.bodyFont = bodyFont; applied.push(`正文字体=${bodyFont}`); }
  const headingFont = exportFontFamily(rules.headingFont);
  if (headingFont) { typography.headingFont = headingFont; applied.push(`标题字体=${headingFont}`); }
  const bodySize = exportFontSizePt(rules.bodySize);
  if (bodySize) { typography.bodySize = bodySize; applied.push(`正文字号=${bodySize}`); }
  const headingSize = exportFontSizePt(rules.headingSize);
  if (headingSize) { typography.titleSize = headingSize; applied.push(`标题字号=${headingSize}`); }
  const lineHeight = exportLineHeight(rules.lineHeight);
  if (lineHeight) { typography.lineHeight = lineHeight; applied.push(`行距=${lineHeight}`); }
  if (rules.gutter) { page.gutter = rules.gutter; applied.push(`装订线=${rules.gutter}`); }
  if (typeof rules.pageLimit === 'number' && rules.pageLimit > 0) {
    targetPages.max = rules.pageLimit;
    applied.push(`页数上限=${rules.pageLimit}`);
  }

  next.page = page;
  next.typography = typography;
  if (Object.keys(targetPages).length > 0) next.targetPages = targetPages;
  return { settings: next, applied };
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

/** 附表标题 → 分类与数据源绑定（附表一/二/三/六 表类绑蓝图数据；C2 起 四/五 图类亦绑蓝图数据源，附表区以
 * 图件说明 + 数据表承接（表格化落位），图件由编制人按表绘制） */
export function appendixKindAndSource(name: string): { kind: 'table' | 'figure'; dataSource: BidAppendixEntry['dataSource'] } {
  if (/施工设备表|机械设备表|施工机械.*设备/u.test(name)) return { kind: 'table', dataSource: 'blueprint.equipment' };
  if (/试验.*仪器|检测仪器|试验仪器|仪器设备表/u.test(name)) return { kind: 'table', dataSource: 'blueprint.testInstruments' };
  if (/劳动力/u.test(name)) return { kind: 'table', dataSource: 'blueprint.labor' };
  if (/临时用地/u.test(name)) return { kind: 'table', dataSource: 'blueprint.tempLand' };
  // C2：图类附表绑蓝图数据源（进度网络图/横道图 → 进度工序表；总平面图 → 设施数据表）
  if (/网络图|进度图|横道图|开.*竣工/u.test(name)) return { kind: 'figure', dataSource: 'blueprint.schedule' };
  if (/总平面/u.test(name)) return { kind: 'figure', dataSource: 'blueprint.tempLand' };
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
 * 正文显式禁表句（C1 证据驱动三态判定）：仅此类证据判 bodyTablePolicy=forbidden——
 * 动作词限定在「表格/图表/框图」之前且窗口受限，避免三类误命中：
 *   ①「不得有其他颜色的文字和图表出现」类颜色格式句（动作词在后 → 天然不命中 + 颜色豁免双保险）；
 *   ②「不得出现与投标内容无关的表格」类范围条款（无关内容豁免；「非文字需要符号」类排版句同豁免）；
 *   ③「正文及各类型图表，框图一律单黑色」类距离超窗的格式句（「正文↔不得」距离 17 字 > 窗口 16 → 不命中）。
 * 三种中文语序全覆盖（C1-5 检测校准）：正文在前（「正文…不得…表格」）/ 否定词在前（「禁止在正文中…表格」）/
 * 表格在前（「表格…不得…正文」）。
 * 跨句窗口容忍 PDF 分页断词（kb 切片标题标记可能插在句中：「正文内不允许\n### 出现…」）。
 */
const TABLE_FORBID_PATTERNS: RegExp[] = [
  /正文(?:部分)?[\s\S]{0,16}?(?:不得|不允许|禁止|严禁)[\s\S]{0,16}?(?:使用|出现|插入|包含|采用|列入|设置|添加|附带|有|存在)[\s\S]{0,8}?(?:任何|所有|全部|其它|其他)?(?:表格|图表|框图)/u,
  /(?:不得|不允许|禁止|严禁)[\s\S]{0,10}?(?:在)?正文(?:部分|中|内|里)?[\s\S]{0,10}?(?:使用|出现|插入|包含|采用|列入|设置|添加|附带|有|存在)[\s\S]{0,8}?(?:任何|所有|全部|其它|其他)?(?:表格|图表|框图)/u,
  /(?:任何|所有|全部|其它|其他)?(?:表格|图表|框图)[\s\S]{0,16}?(?:一律|均|全部|都)?(?:不得|不允许|禁止|严禁)[\s\S]{0,12}?(?:出现|写入|进入|列入|使用|用于|插入)[\s\S]{0,12}?正文/u,
  /正文(?:部分)?[\s\S]{0,12}?(?:一律|均|只能|仅)[\s\S]{0,8}?(?:纯文字|文字表述|文字叙述|文字描述)(?![\s\S]{0,2}?(?:结合|及|与|和))/u,
];
/** 禁表句豁免修饰（格式/范围条款不构成禁表）：「颜色/彩色/单色/黑白」为排版格式句；「无关/非文字需要」为范围条款 */
const TABLE_FORBID_EXEMPT = /颜色|彩色|单色|黑白|无关|不相干|非文字需要/u;

/**
 * 正文表格允许句（C1 证据驱动三态判定）：招标明确或隐含正文可含表格/图表（格式与编制方式条款反证）。
 *   ① 明确允许型：「采用文字并结合图表形式」「除采用文字表述外可附下列图表」；
 *   ② 图表存在性型（格式/编制方式条款——图表存在且只限格式，等价于允许）：
 *      「横道图、网络图及一些表格和框图采用何种软件编制自行确定」「表格可采用A3幅面」
 *      「施工进度表可采用网络图或横道图」「图表、框图一律单黑色」。
 * 窗口容忍 PDF 断词（「横道图表\n示」）。
 */
const TABLE_ALLOW_PATTERNS: RegExp[] = [
  /文字(?:表述|叙述|说明|描述)?[\s\S]{0,4}?(?:结合|相结合)[\s\S]{0,4}?(?:图表|表格|框图)/u,
  /除(?:采用)?文字(?:表述|叙述)?外[\s\S]{0,4}?(?:可|可以)?附[\s\S]{0,4}?(?:下列|如下|相关|相应)?(?:图表|表格|框图)/u,
  /(?:横道图|网络图|进度(?:表|图)|平面布置图|框图|表格|图表)[\s\S]{0,26}?(?:自行确定|由投标人自定|不作规定|不作限制|不做要求)/u,
  /(?:表格|图表|框图)[\s\S]{0,16}?(?:可采用|可用|可以使用|应采用)[\s\S]{0,6}?A3/u,
  /(?:施工进度(?:表|图)?|总进度(?:表|图|计划)?|进度计划)[\s\S]{0,8}?(?:可|应)?采用[\s\S]{0,6}?(?:网络图|横道图)/u,
  /(?:图表|框图|表格)[\s\S]{0,10}?(?:一律|均|全部)[\s\S]{0,6}?单(?:黑色|色)/u,
  /图表及格式要求附后/u,
];

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

  // ── 2) 正文口径：证据驱动三态判定（C1 修复——原「暗标→正文禁表」硬推删除）──
  // 招标正文表格口径按证据强度判定，不得按标书类型猜测（舒城暗标实证：招标明确允许正文图表——
  // 「采用文字并结合图表形式」「横道图、网络图及一些表格和框图采用何种软件编制自行确定」「可采用A3幅面」）：
  //   ① 显式禁表句（「正文不得出现表格/图表」类）→ forbidden（记证据；颜色/无关修饰的格式句不构成禁表）
  //   ② 允许句（文字结合图表/图表自行确定/可采用A3/一律单黑色等）→ allowed（记证据）
  //   ③ 禁无关系符号句（「正文内不允许出现非文字需要的其他任何符号和标志」）→ 排版格式条款，不构成禁表（记证据）
  //   ④ 无证据 → allowed（默认）
  // 容忍 PDF 分页断词（kb 切片标题标记可能插在句中：「正文内不允许\n### 出现非文字…」）
  const bodySymbolOnlySentence = firstMatch(normalized, /正文内不允许[\s\S]{0,24}?出现非文字需要的其他任何符号和标志/u);
  const noFigureSentence = firstMatch(normalized, /不得有图片和扉页|不得有图片/u);
  const tableForbidHit = firstPatternHit(normalized, TABLE_FORBID_PATTERNS);
  const tableAllowHit = firstPatternHit(normalized, TABLE_ALLOW_PATTERNS);
  const tableForbidEvidence = tableForbidHit && !TABLE_FORBID_EXEMPT.test(tableForbidHit) ? tableForbidHit : undefined;
  const bodyTablePolicy: BidCompositionSpec['bodyTablePolicy'] = tableForbidEvidence ? 'forbidden' : 'allowed';
  if (tableForbidEvidence) evidence.push(`正文禁表证据：${tableForbidEvidence}`);
  else {
    if (tableAllowHit) evidence.push(`正文表格允许证据：${tableAllowHit}`);
    // 排版格式证据独立记录（解释「禁符号句不构成禁表」的证据链，与允许证据可并存）
    if (bodySymbolOnlySentence) evidence.push(`排版格式证据：${bodySymbolOnlySentence}（禁与投标内容无关符号标记的排版条款，不构成正文禁表）`);
  }
  // 正文图片口径：暗标（防图片身份泄露）或招标明示「不得有图片」→ forbidden；图类数据以表格化输出承接（C2）
  const bodyFigurePolicy: BidCompositionSpec['bodyFigurePolicy'] = bidType === 'blind' || noFigureSentence ? 'forbidden' : 'allowed';
  if (noFigureSentence) evidence.push(`图片口径证据：${noFigureSentence}`);

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

  // ── 5) 冲突裁决：提示词必需表格 vs 正文禁表（以招标显式禁表句为准；招标文件 > 用户提示词 > 系统默认） ──
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
          ? `招标正文禁表（显式禁表句）：该表已收敛入文末《${mapped.title}》，正文不再输出表格`
          : '招标正文禁表（显式禁表句）：该表取消表格形式，数据以对应章节文字表述呈现',
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

/** 正文禁表（bodyTablePolicy=forbidden：招标显式禁表句；允许/无证据时 allowed） */
export function isBodyTableForbidden(spec: BidCompositionSpec | undefined) {
  return spec?.bodyTablePolicy === 'forbidden';
}

/** 正文禁图（bodyFigurePolicy=forbidden：暗标或招标禁图片证据；与正文表格口径并列） */
export function isBodyFigureForbidden(spec: BidCompositionSpec | undefined) {
  return spec?.bodyFigurePolicy === 'forbidden';
}

/**
 * 写作约束文本（招标编制口径注入写作/修复提示词）。
 * 双分支（C1）：正文允许表格时注入「表格按系统表格计划输出 + 图类数据表格化 + 禁图片」口径；
 * 正文禁表（显式禁表句）时注入纯文字口径；无口径差异（明标无特殊要求）返回空串不注入。
 */
export function bidCompositionWritingRules(spec: BidCompositionSpec | undefined): string {
  if (!spec) return '';
  const tableForbidden = spec.bodyTablePolicy === 'forbidden';
  const figureForbidden = spec.bodyFigurePolicy === 'forbidden';
  if (!tableForbidden && !figureForbidden && !spec.formatRules.monoColor && !spec.identityMarksForbidden) return '';
  const lines: string[] = ['【正文编制口径（招标文件要求，硬性验收项）】'];
  if (tableForbidden) {
    lines.push('1. 正文一律纯文字表述：不得输出任何 Markdown 表格或管道符表格结构；数据性内容以段落文字表述（人数、台数、工艺参数、计划节点等数值一律原样引用蓝图权威锚点，不得编造或自设）。');
    lines.push('2. 结构化数据表由系统在文末附表区按招标附表清单统一生成，正文不重复列出表格。');
  } else {
    lines.push('1. 正文表格按系统表格计划输出：只输出任务中明确列出的表格（表格计划），不得自行新增、改名或改变列结构；数据一律原样引用蓝图权威锚点，不得编造或自设。');
    lines.push('2. 图类数据（进度/网络/横道/平面布置等）以表格化数据表达，不绘制图片；表格与图类数据位置服从任务中给定的表格计划。');
  }
  if (figureForbidden) lines.push(`${lines.length}. 不得插入图片、Markdown 图片语法或图件占位；图类内容由系统统一数据化处理。`);
  if (spec.formatRules.monoColor) lines.push(`${lines.length}. 表格与文字一律单黑色（黑白）表述，不得出现彩色标注、高亮或颜色说明。`);
  if (spec.identityMarksForbidden) lines.push(`${lines.length}. 不得出现任何明示或暗示具体投标人的说明及标记（投标人名称、以往施工业绩、获奖情况等一律不得写入正文）。`);
  return lines.join('\n');
}

/** 门禁/修复提示中的拆表指令（正文禁表口径修复用：显式禁表句场景） */
export function bodyTableDismantleIssue(tableCount: number): string {
  return `招标正文禁表（显式禁表句，违反即施工组织设计部分不得分）：本章正文出现 ${tableCount} 处 Markdown 表格结构。请把每处表格的承载数据改写为段落式连贯叙述（数值、口径保持不变，数据原样保留），删除表格表头与分隔线结构；不得新增或删除其它正文内容。`;
}

/**
 * 门禁/修复提示中的无计划表格指令（C1 章级授权门禁：正文表格须来自系统表格计划）。
 * 用于允许表格口径下、未列入表格计划的章节出现表格的修复（表格需求统一由表格计划裁决）。
 */
export function unplannedBodyTableIssue(tableCount: number): string {
  return `本章正文出现 ${tableCount} 处 Markdown 表格结构，但本章未列入系统表格计划（正文表格须由招标附表清单与评分要求统一规划，不得自设）。请将表格承载数据改写为段落式连贯叙述（数值、口径保持不变），删除表格表头与分隔线结构；确属必要的表格由系统在表格计划中补齐，不得新增其它正文内容。`;
}

/** 标书编制规格进度摘要（显性展示判定与裁决，可审计） */
export function bidCompositionSummary(spec: BidCompositionSpec): { status: 'success' | 'skipped'; message: string; details: string[] } {
  const typeLabel = spec.bidType === 'blind' ? '暗标' : spec.bidType === 'open' ? '明标' : '未识别（按常规口径）';
  const parts = [
    `标书类型：${typeLabel}`,
    `正文表格：${spec.bodyTablePolicy === 'forbidden' ? '禁表格（招标显式禁表句）' : '允许（表格按系统表格计划输出）'}`,
    `正文图片：${spec.bodyFigurePolicy === 'forbidden' ? '禁图片（图类数据化输出）' : '允许'}`,
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
      ? '⚠ 标书类型未判定（告警）：未识别到「本项目施工组织设计采用：□明标/☑暗标」勾选标记与暗标编制要求语义证据，本次按常规口径生成（正文表格策略按招标证据判定、正文图片允许）——若本项目实为暗标，正文图片与投标人标记可能未被禁止（暗标通常不得出现），请核对招标文件后重跑'
      : `标书编制规格：${parts.join('；')}`,
    details,
  };
}
