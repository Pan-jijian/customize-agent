/**
 * billFactLock：清单事实锁——清单条目级数据的确定性保护（B1）。
 *
 * 背景（清单数据编造/偏差的根因治理）：canonical 裁决（PROJECT_BASIC_FIELD_SPECS）只覆盖 14 个
 * 项目基本字段，清单几千条目行的「条目名→特征→工程量」数据没有确定性保护：检索注入受
 * 8000 字符硬顶截断、写作温度漂移、模型自行分配规格拆分（丰乐镇实测：路灯 100W 109+120W 9
 * 被写成 111+7）——条目级数据错误零拦截。
 *
 * 本模块把清单解析结果（billOfQuantitiesParser，蓝图阶段 0 同源、确定性零 LLM）固化为行级事实锁：
 * - 锁记录：条目名 + 特征描述 + 工程量 + 单位 + 分部 + 规格-数量拆分对（逐项照抄原值）；
 * - 写作侧直读：renderBillFactLockText 按章节相关性全量渲染清单行注入写作提示词（清单行直读通道，
 *   数据不经检索召回/注入截断，模型直接看到权威原文行）；
 * - 生成后核对：正文数值 vs 锁数值的确定性核对轮（见 numericVerification.ts）消费同一锁。
 */
import type { BillOfQuantitiesResult } from './billOfQuantitiesParser';

export interface BillFactLockEntry {
  seq: number;
  name: string;
  description: string;
  quantity: number;
  unit: string;
  section: string;
  subsection: string;
  villageGroup: string;
  sourceFile: string;
  /** 特征描述中的规格 token（如 100W、C30、DN100、HRB400）与数量拆分对：逐项照抄锁 */
  specQuantityPairs: Array<{ spec: string; quantity: string }>;
}

export interface BillFactLock {
  entries: BillFactLockEntry[];
  totalEntries: number;
  sourceFile: string;
  complete: boolean;
}

/** 规格 token：功率/长度/强度/管径/钢筋等级/直径/尺寸等，用于规格-数量拆分对提取 */
const SPEC_TOKEN_RE = /(?:\d+(?:\.\d+)?\s*(?:W|kW|kV|V|A|Hz|mm|cm|m|km|kg|g|t|K|MPa|kN|℃|%|L|mL|s|h|min)\b|C\d{2,}|HRB\d+|HPB\d+|DN\s*\d+|Φ\s*\d+(?:\.\d+)?|φ\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*[×x*]\s*\d+(?:\.\d+)?)/giu;

/** 从条目特征描述中提取规格 token（去重、保持原样） */
export function extractSpecTokens(text: string): string[] {
  return [...new Set((text.match(SPEC_TOKEN_RE) || []).map(item => item.replace(/\s+/gu, '').trim()))].filter(Boolean).slice(0, 8);
}

/** 构建清单事实锁：清单解析结果 → 行级确定性锁；无清单/解析为空返回 undefined */
export function buildBillFactLock(input: { boq?: BillOfQuantitiesResult | null }): BillFactLock | undefined {
  const boq = input.boq;
  if (!boq || boq.totalEntries === 0) return undefined;
  return {
    entries: boq.entries.map(entry => ({
      seq: entry.seq,
      name: String(entry.name || '').trim(),
      description: String(entry.description || '').trim(),
      quantity: entry.quantity,
      unit: String(entry.unit || '').trim(),
      section: String(entry.section || '').trim(),
      subsection: String(entry.subsection || '').trim(),
      villageGroup: String(entry.villageGroup || '').trim(),
      sourceFile: entry.sourceFile,
      specQuantityPairs: extractSpecTokens(entry.description).map(spec => ({ spec, quantity: `${entry.quantity}${entry.unit}` })),
    })),
    totalEntries: boq.totalEntries,
    sourceFile: boq.sourceFile,
    complete: boq.complete,
  };
}

/** 章节相关性 token：章节标题/小节标题切词，用于清单条目筛选 */
export function chapterRelevanceTokens(chapterTitle: string, sections: string[] = []): string[] {
  return [...new Set(`${chapterTitle} ${sections.join(' ')}`.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9_-]{3,}/gu) || [])].filter(token => token.length >= 2);
}

/** 条目与章节的相关性分：名称/特征/分部命中章节 token 越多越相关 */
function entryRelevanceScore(entry: BillFactLockEntry, tokens: string[]): number {
  const text = `${entry.name} ${entry.description} ${entry.section} ${entry.subsection}`;
  return tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
}

/** D2 条目查询条数上限：第一轮保底覆盖 12 个分部，组数超出时最多取 18 组 */
const BILL_QUERY_MIN_LIMIT = 12;
const BILL_QUERY_MAX_LIMIT = 18;

/**
 * D2 清单条目精确检索查询构造（纯函数）：清单条目 → 条目级检索 query，
 * 用于数值型清单行在向量空间弱势时的词面精确召回。
 * 历史缺陷：按「章 token ⊂ 条目字段」硬过滤 + 顺序截断取前 6 条——
 * (a) 分部章的章标题是抽象主题（如「主要施工方法」），分部名只存在于清单自身数据结构中，
 * 章 token 与条目分部名无词面交集时整类条目被静默丢弃；
 * (b) 命中条目按清单顺序截断，排序靠前的单一分部占满全部名额——实测路灯条目两条全中却零 query 生成，
 * 亮化设计说明（含太阳能参数）从未被定向召回。
 * 设计（纯数据驱动，零领域词表）：分组键=清单自身分部字段（section 缺省回退 subsection），
 * 组内代表=章 token 相关命中 → 规格-数量对（信息量）→ 工程量 → 稳定序；
 * 组间=组代表相关命中降序 → 清单自然序（与施工组织顺序同源）；
 * 轮询=第一轮每分部一条（覆盖优先）、名额有余再按分部轮补位。
 */
export function buildBillFactLockQueries(lock: BillFactLock, chapterTitle: string, sections: string[] = [], options: { maxQueries?: number } = {}): string[] {
  if (!lock || lock.entries.length === 0) return [];
  const tokens = chapterRelevanceTokens(chapterTitle, sections);
  const scoreOf = (entry: BillFactLockEntry) => entryRelevanceScore(entry, tokens);
  const groups = new Map<string, BillFactLockEntry[]>();
  for (const entry of lock.entries) {
    if (!entry.name) continue;
    const key = entry.section || entry.subsection || '';
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => scoreOf(b) - scoreOf(a)
      || (b.specQuantityPairs?.length || 0) - (a.specQuantityPairs?.length || 0)
      || b.quantity - a.quantity
      || a.seq - b.seq);
  }
  const ordered = [...groups.values()].sort((a, b) => scoreOf(b[0]) - scoreOf(a[0]) || (a[0]?.seq || 0) - (b[0]?.seq || 0));
  const configured = Number.isFinite(options.maxQueries) && options.maxQueries! > 0 ? Math.floor(options.maxQueries!) : BILL_QUERY_MAX_LIMIT;
  // 名额：覆盖优先——组数不超过配置上限时一组一条全覆盖（保底 12 组）
  const maxQueries = Math.max(BILL_QUERY_MIN_LIMIT, Math.min(configured, ordered.length));
  const picked: BillFactLockEntry[] = [];
  for (let round = 0; picked.length < maxQueries; round += 1) {
    let added = false;
    for (const list of ordered) {
      if (picked.length >= maxQueries) break;
      const entry = list[round];
      if (!entry) continue;
      picked.push(entry);
      added = true;
    }
    if (!added) break;
  }
  return picked
    .map(entry => `${entry.name} ${entry.description} ${entry.quantity}${entry.unit}`.trim().slice(0, 80))
    .filter(Boolean);
}

/**
 * 渲染清单事实锁注入文本（B2 清单行直读通道）：按章节相关性筛选条目后全量渲染权威清单行，
 * 数据不经检索召回与注入截断直接进入写作提示词。
 * 清单/施工内容/施工方法类章节放宽预算（条目级数据是这类章节的核心正文素材）。
 */
export function renderBillFactLockText(lock: BillFactLock, chapterTitle: string, opts: { sections?: string[]; maxEntries?: number; maxChars?: number; maxSpecChars?: number } = {}): string {
  if (!lock || lock.entries.length === 0) return '';
  const isQuantityHeavy = /清单|工程量|主要施工内容|主要施工方法|主要分部分项|资源配置|材料|物资/u.test(chapterTitle);
  const defaultMaxEntries = isQuantityHeavy ? 120 : 60;
  const defaultMaxChars = isQuantityHeavy ? 9000 : 6000;
  const maxEntries = Math.max(1, opts.maxEntries ?? defaultMaxEntries);
  const maxChars = Math.max(1, opts.maxChars ?? defaultMaxChars);
  const tokens = chapterRelevanceTokens(chapterTitle, opts.sections || []);
  const scored = lock.entries
    .map(entry => ({ entry, score: entryRelevanceScore(entry, tokens) }))
    .sort((a, b) => b.score - a.score || a.entry.seq - b.entry.seq);
  const selected = scored.map(item => item.entry).slice(0, maxEntries);
  const lines: string[] = [];
  let total = 0;
  for (const entry of selected) {
    const specText = entry.specQuantityPairs.length > 0 ? ` [${entry.specQuantityPairs.map(pair => `${pair.spec} ${pair.quantity}`).join('；')}]` : '';
    const line = `${entry.seq}. ${entry.name}${entry.description ? `（${entry.description}）` : ''}：${entry.quantity}${entry.unit}${entry.section ? `｜${entry.section}` : ''}${specText}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  if (lines.length === 0) return '';
  return [
    '【工程量清单事实锁——确定性权威数据（逐项照抄，不得改动或重新分配）】',
    `清单来源：${lock.sourceFile.split('/').pop()}（${lock.totalEntries} 条目，本节锁定 ${lines.length} 条）`,
    '清单给出规格-数量拆分的必须逐项照抄原值（如 100W 109套、120W 9套），不得自行拆分或重新分配；清单只给总量的不得自行拆分；同一规格-数量拆分在全文各章必须一致。',
    ...lines,
  ].join('\n');
}

// ═══════ C-T5 清单落位口径（豁免登记 / 责任章映射 / 显性说明）═══════

/** 清单落位口径豁免：汇总口径行（分部小计/合计/规费/税金等计价汇总行）不是清单明细项，
 * 无法落位也无须落位——boqPlacementIssues 与 buildBoqRowTraces 共用同一口径（历史缺陷：
 * boqRowTraceIssues 未排除口径行导致分母虚高、落位率被系统性压低），豁免行保留在行级追踪中登记可审计；
 * r28h M9 扩围：版式噪声行/费用组成行/分部标题行（见下方 NOISE/FEE/section-title 判据）纳入同一口径 */
export const BILL_PLACEMENT_EXEMPT_NAME_RE = /^(?:分部小计|本页小计|小计|合计|总计|总价|合价|按实计算|按实结算|暂估|暂列金额|计日工|规费|税金)$/u;

/** C-T5 豁免扩围（r28h M9 实机归因）：版式噪声行——清单表页眉（分部分项工程量清单/工程名称/页码）
 * 与表标题行（措施项目）不是清单明细项，属抽取噪声，无法落位也不该落位（r28h2 实测页眉名空行
 * 占未落位 65%）；作用于名称槽，也作用于编码槽（页眉串入编码格的形态：名空+码为页眉文本） */
export const BILL_PLACEMENT_EXEMPT_NOISE_RE = /分部分项工程量清单|^工程名称[：:]|^第\s*\d+\s*页|^共\s*\d+\s*页|^措施项目$/u;

/** C-T5 豁免扩围（r28h M9 实机归因）：费用组成行（措施费/税金/暂估价/暂列金额尾缀）是报价行，
 * 技术标正文不逐项落位（r28h2 实测 153 行、s28h2 228 行）；长度上限防长句「…费」误判 */
export const BILL_PLACEMENT_EXEMPT_FEE_RE = /(?:费|税|暂估价|暂列金额)$/u;
const BILL_PLACEMENT_EXEMPT_FEE_MAX_LEN = 24;

/** C3-5 豁免扩围（s28l 实机形态实证）：五类结构/版式/泛词行——
 * ① 空名行（费用组成表「人工费小计/说明：…」串入名/码格，s28l 实测 52 行；无名行无法构成落位义务）；
 * ② 版式说明行（「说明：此表项目名称、数量由招标人填写…」其他项目表填写说明）；
 * ③ 编号结构行（点分编号 code + 无工程量：4.7.1 分部标题/2.16.4 子分部，s28l 实测 15 行）；
 * ④ 序号分类行（中文数字/短序号 + 费用分类名：「一 人工」「二 材料」「三 施工机械」「5 其他」）；
 * ⑤ 泛词短名行（C3-5-8 归零实证扩围：名称归一后为泛词名单词——字面三通道全不可达，见名单注释）。 */
/** 点分编号形态（分部/子分部编号：4.7.1/2.16.4——非清单编码，清单编码为 10-12 位纯数字或字母前缀） */
const BILL_DOTTED_NUMBER_RE = /^\d{1,3}(?:[.．]\d{1,3}){1,4}$/u;
/** 序号形态（费用组成表分类行序号：中文数字「一二三」或短阿拉伯数字「5」） */
const BILL_ORDINAL_CODE_RE = /^(?:[一二三四五六七八九十]{1,3}|\d{1,2})$/u;
/** 费用组成分类名（人材机/其他）：序号格 + 分类名 = 报价构成行（非施工内容项） */
const BILL_FEE_CATEGORY_NAME_RE = /^(?:人工|材料|机械|施工机械|设备|人工费|材料费|机械费|施工机械费|其他|其它)$/u;
/** 版式说明行开头（填写说明/计量说明——非清单明细项） */
export const BILL_PLACEMENT_EXEMPT_NOTE_RE = /^说明[：:]/u;

/** 泛词短名共源名单（C3-5-8 由 documentFactTrace 迁移共源）：r28h M9 实机复核——s28h2「材料」
 * 「人工」「软件」等费用子行/占位行与「其他」类汇总行，泛词在正文必然出现但不构成清单项的落位
 * 证据（2 字工程实义词如「圈梁」「垫层」「压膜」不在表内，照常判定）；2 字泛词名的字面三通道
 * （首段主名/整名 12 字符 + 编码 8 字符）因长度门槛全不可达，计入分母即永不可达的隐形分母
 * （s28l 实测「软件」4 行含真实编码/工程量仍永不落位）——boqItemCarriedInText 首段保护与
 * classifyBillPlacementExemption 泛词行豁免复用同一名单 */
export const BOQ_GENERIC_NAME_STOPWORDS: ReadonlySet<string> = new Set([
  '其他', '材料', '人工', '软件', '硬件', '机械', '设备', '建筑', '安装', '拆除',
  '服务', '费用', '项目', '工程', '施工', '内容', '其中', '以上', '以下', '临时', '措施', '合计', '小计',
]);

export type BillPlacementExemptionKind = 'summary-row' | 'noise-row' | 'fee-row' | 'section-title-row' | 'no-name-row' | 'note-row' | 'numbered-heading-row' | 'ordinal-category-row' | 'generic-name-row';

/** 判定清单行名是否为落位口径豁免（非落位必要行）；返回豁免类别供审计登记。
 * 行上下文（code/quantity）用于分部标题行判据（无编码且无工程量 + 「XX工程」结尾，
 * r28h2 实测 57 行、s28h2 96 行分部标题重复行——分部名不是施工内容项） */
export function classifyBillPlacementExemption(name: string, context?: { code?: string; quantity?: string }): BillPlacementExemptionKind | undefined {
  const normalized = String(name || '').replace(/\s+/gu, '');
  const normalizedCode = String(context?.code || '').replace(/\s+/gu, '');
  const hasQuantity = Boolean(String(context?.quantity || '').trim());
  // ① 空名行（C3-5 扩围）：名槽为空——费用组成表等版式行（「人工费小计/说明：…」串入码格）；
  // 无名行无法构成落位义务（名称是判定基准），一律豁免（汇总/噪声/说明形态保留既有细分归类）
  if (!normalized) {
    if (/^合\s*计$/u.test(normalizedCode)) return 'summary-row';
    if (BILL_PLACEMENT_EXEMPT_NOISE_RE.test(normalizedCode)) return 'noise-row';
    if (BILL_PLACEMENT_EXEMPT_NOTE_RE.test(normalizedCode)) return 'note-row';
    return 'no-name-row';
  }
  // 整名锚定词表优先（规费/税金/暂列金额同时形似费用尾缀，归 summary-row 保持既有 C-T5 归类稳定）
  if (BILL_PLACEMENT_EXEMPT_NAME_RE.test(normalized)) return 'summary-row';
  if (BILL_PLACEMENT_EXEMPT_NOISE_RE.test(normalized)) return 'noise-row';
  // ② 版式说明行（C3-5 扩围）：其他项目表/费用组成表填写说明（「说明：此表项目名称、数量由招标人填写…」）
  if (BILL_PLACEMENT_EXEMPT_NOTE_RE.test(normalized) || BILL_PLACEMENT_EXEMPT_NOTE_RE.test(normalizedCode)) return 'note-row';
  // 费用组成行判 fee-row：费用尾缀 + 「费小计/费合计」形态（「人工费小计/材料费小计/施工机械费小计」）
  if (normalized.length <= BILL_PLACEMENT_EXEMPT_FEE_MAX_LEN
    && (BILL_PLACEMENT_EXEMPT_FEE_RE.test(normalized) || /(?:费|税)(?:小计|合计)$/u.test(normalized))) return 'fee-row';
  // ③ 编号结构行（C3-5 扩围）：点分编号 code（4.7.1/2.16.4）+ 无工程量——分部/子分部结构标题行
  if (!hasQuantity && BILL_DOTTED_NUMBER_RE.test(normalizedCode)) return 'numbered-heading-row';
  // ④ 序号分类行（C3-5 扩围）：中文数字/短序号 + 费用分类名（「一 人工」「二 材料」「三 施工机械」「5 其他」）
  if (BILL_ORDINAL_CODE_RE.test(normalizedCode) && BILL_FEE_CATEGORY_NAME_RE.test(normalized)) return 'ordinal-category-row';
  if (/工程$/u.test(normalized) && !normalizedCode && !hasQuantity) return 'section-title-row';
  // ⑤ 泛词短名行（C3-5-8 归零实证）：名称归一后为泛词名单词（「软件」类 2 字泛词行，s28l 实测
  // 4 行含真实编码/工程量仍永不落位）——泛词不构成落位证据（r28h M9 判定设计），字面三通道
  // 全不可达，计入分母即永不可达的隐形分母；判据纯名称锚定（与编码/工程量形态无关），
  // 排序在既有类别之后保证审计归类稳定（「一 人工」仍归 ordinal-category-row）
  if (BOQ_GENERIC_NAME_STOPWORDS.has(normalized)) return 'generic-name-row';
  return undefined;
}

/** 显性说明处置句式（C-T5）：正文句指名清单条目 + 显式说明处置方式（利旧/甲供/不涉及/不另列等），
 * 视为「显性说明」处置——未落位行的两种合法处置之一（补写落位或显性说明，方案 C-T5③） */
export const BILL_DISPOSITION_RE = /不(?:另|单|再)列|不涉及|不在(?:本次|本工程|本标段)?(?:施工)?范围|已包含(?:在|于)|利旧|甲供|由(?:业主|甲方|建设单位|厂家|供应商|设备厂家)配套|无(?:需|须)(?:单独|另行)?(?:施工|安装|实施)/u;

/** 扫描正文中的显性说明句：条目名 → 说明句（句子长度 6~200，须同含条目名（归一后连续出现）与处置语气） */
export function scanBillExplicitDispositions(markdown: string, itemNames: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const names = [...new Set(itemNames.map(name => String(name || '').replace(/\s+/gu, '')).filter(name => name.length >= 3))];
  if (!markdown || names.length === 0) return result;
  // 处置句预过滤：先筛含处置语气的句子（规模远小于全句集），再逐名做包含判定——避免名称数×全句集的矩阵扫描
  const sentences = markdown
    .split(/[。；;|]/u)
    .map(sentence => sentence.replace(/\s+/gu, ''))
    .filter(sentence => sentence.length >= 6 && sentence.length <= 200 && BILL_DISPOSITION_RE.test(sentence));
  if (sentences.length === 0) return result;
  for (const name of names) {
    const hit = sentences.find(sentence => sentence.includes(name));
    if (hit) result.set(name, hit.slice(0, 120));
  }
  return result;
}

/** 相关性 token 扩展：多字中文词补双字子词（「排水工程」→「排水」「水工」「工程」），
 * 覆盖清单条目名与章标题词面粒度不一致的形态（条目「混凝土排水沟」只含「排水」子词）；
 * 导出供 chapterParameterFacts（C-T6 参数按章相关性）复用同一词面口径 */
export function expandRelevanceToken(token: string): string[] {
  if (token.length < 3 || !/[\p{Script=Han}]{2,}/u.test(token)) return [token];
  const expanded = new Set<string>([token]);
  for (let index = 0; index + 2 <= token.length; index += 1) expanded.add(token.slice(index, index + 2));
  return [...expanded];
}

/** C3-5-4 清单特征标准尾句（招标清单通用样板段）：指向图纸/图集/招标文件等资料的兜底句，
 * 责任章评分前剥离——否则「验收」「资料」等通用词污染章归属（s28l 实测 963 条绿化种植/养护
 * 条目的「满足验收要求」命中小节「验收闭环与资料同步」而错归「工程施工的重点和难点及保证措施」章） */
export const BILL_DESC_BOILERPLATE_RE = /(?:详见|参见)[^。；;]{0,24}?(?:图纸|图集|答疑|招标文件|政府相关文件|规范)[^。；;]{0,160}/gu;

/** C3-5-4 子词评分停用词（仅作用于双字扩展子词，切片原词保留）：通用功能语素/高频泛化词
 * 在任何章小节都可能命中（s28l「施工」出现于方法章 18 个小节），不构成章归属证据；
 * 「钢筋/材料/管理」为清单描述高频复现词（「钢筋混凝土」「材料品种」「管理系统」），
 * 命中小节属字面碰撞（钢筋→加工场、材料→堆场、管理→搭接管理），同样不构成归属证据 */
const BILL_SUBWORD_STOPWORDS = new Set([
  '施工', '现场', '工程', '其他', '其它', '内容', '主要', '相关', '要求', '方法', '措施',
  '工作', '进行', '采用', '包括', '以及', '根据', '按照', '满足', '符合', '达到', '组织', '安排', '计划', '实施', '说明', '事项', '情况',
  '钢筋', '材料', '管理',
]);

/** 剥离清单特征标准尾句（多段并列时逐段剥离）；责任章映射与单测共用 */
export function stripBillDescriptionBoilerplate(text: string): string {
  if (!text) return text;
  let result = text;
  for (let round = 0; round < 4; round += 1) {
    const next = result.replace(BILL_DESC_BOILERPLATE_RE, ' ');
    if (next === result) break;
    result = next;
  }
  return result.replace(/\s+/gu, ' ').trim();
}

/** C3-5-4 词面命中判定（责任章/建议小节评分单源）：切片原词直接命中；双字子词仅当位于切片
 * 首/尾（词边界概率高）且不在停用词表时命中——中段子词多为跨词碰撞碎片（「三级配电两级保护」
 * 中段切出「级配」误命中「级配碎石」；「验收闭环与资料同步」中段「资料」） */
function relevanceTokenMatches(token: string, text: string): boolean {
  if (!text || !token) return false;
  if (token.length < 3 || !/[\p{Script=Han}]{2,}/u.test(token)) return text.includes(token);
  if (text.includes(token)) return true;
  for (let index = 0; index + 2 <= token.length; index += 1) {
    if (index !== 0 && index + 2 !== token.length) continue;
    const sub = token.slice(index, index + 2);
    if (BILL_SUBWORD_STOPWORDS.has(sub)) continue;
    if (text.includes(sub)) return true;
  }
  return false;
}

/** 清单条目在章内的建议落位小节（写作证据位）：规划小节中与条目文本词面最相关者 */
function pickBillSection(text: string, sections: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = 0;
  for (const raw of sections) {
    const section = String(raw || '').trim();
    if (section.length < 2) continue;
    let score = 0;
    for (const token of chapterRelevanceTokens(section)) {
      if (relevanceTokenMatches(token, text)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = section;
    }
  }
  return best;
}

/** 责任章分配结果：chapterTitle=责任章标题；section=建议落位小节（写作证据位，无法判定时缺省） */
export interface BillChapterAssignment {
  chapterTitle: string;
  section?: string;
}

/** 施工方法类章回退口径（与写作侧 boqCoverageContext 方法章判定同源） */
const BILL_METHOD_CHAPTER_RE = /施工方法|施工方案|施工工艺|主要施工内容|分部分项/u;

/**
 * 行级任务清单驱动（每行→责任章→写作证据位，方案 C-T5②）：为清单条目分配责任章。
 * 判定：各章 token（标题+规划小节切词）与条目（名称/特征/分部/子分部）词面相关分取最高正分章；
 * 同分取大纲顺序靠前章。全部零分回退施工方法类章（此类章承载分项施工叙述）；无章上下文时返回 undefined。
 * C3-5-4 加固：评分前剥离清单特征标准尾句（boilerplate 通用词不构成归属证据）；双字子词命中限
 * 切片首/尾且非停用词（中段碎片不命中）——修历史缺陷：s28l 963 条绿化条目因尾句「验收」「资料」
 * 被错归「工程施工的重点和难点及保证措施」章。
 */
export function assignBillRowChapter(
  entry: { name?: string; description?: string; section?: string; subsection?: string },
  chapters: Array<{ title: string; sections?: string[] }> = [],
): BillChapterAssignment | undefined {
  if (chapters.length === 0) return undefined;
  const text = stripBillDescriptionBoilerplate([entry.name, entry.description, entry.section, entry.subsection].filter(Boolean).join(' '));
  if (!text) return undefined;
  let bestTitle = '';
  let bestScore = 0;
  let bestSection: string | undefined;
  for (const chapter of chapters) {
    let score = 0;
    for (const token of chapterRelevanceTokens(chapter.title, chapter.sections || [])) {
      if (relevanceTokenMatches(token, text)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTitle = chapter.title;
      bestSection = pickBillSection(text, chapter.sections || []);
    }
  }
  if (bestScore > 0) return { chapterTitle: bestTitle, section: bestSection };
  const fallback = chapters.find(chapter => BILL_METHOD_CHAPTER_RE.test(chapter.title));
  return fallback ? { chapterTitle: fallback.title } : undefined;
}

/** 全量责任章映射（写作任务清单与未落位修复定位单源）：一次构建全章循环复用；无清单/无章时返回空表 */
export function buildBillResponsibilityMap(
  lock: BillFactLock | undefined,
  chapters: Array<{ title: string; sections?: string[] }> = [],
): Map<BillFactLockEntry, BillChapterAssignment> {
  const map = new Map<BillFactLockEntry, BillChapterAssignment>();
  if (!lock || lock.entries.length === 0 || chapters.length === 0) return map;
  for (const entry of lock.entries) {
    if (!entry.name) continue;
    const assignment = assignBillRowChapter(entry, chapters);
    if (assignment) map.set(entry, assignment);
  }
  return map;
}

/** 本章责任清单行渲染（写作注入，行级任务清单，方案 C-T5②）：
 * 责任行逐条渲染（含建议落位小节），超出上限的仅列名并给出总数（返回行数组，由调用侧并入 roleContext） */
export function renderBillChapterTaskLines(
  lock: BillFactLock | undefined,
  responsibility: Map<BillFactLockEntry, BillChapterAssignment>,
  chapterTitle: string,
  options: { maxEntries?: number } = {},
): string[] {
  if (!lock || lock.entries.length === 0 || responsibility.size === 0) return [];
  const maxEntries = Math.max(1, options.maxEntries ?? 60);
  const owned = lock.entries.flatMap(entry => {
    if (!entry.name) return [];
    const assignment = responsibility.get(entry);
    return assignment && assignment.chapterTitle === chapterTitle ? [{ entry, assignment }] : [];
  });
  if (owned.length === 0) return [];
  const lines = ['【本章责任清单行（行级任务：下列清单条目按责任章分配到本章，必须在正文对应专业小节逐项写入条目名称与工程量，不得遗漏）】'];
  for (const { entry, assignment } of owned.slice(0, maxEntries)) {
    const sectionHint = assignment.section ? `｜建议写入小节「${assignment.section}」` : '';
    lines.push(`- ${entry.name}${entry.description ? `（${entry.description.slice(0, 60)}）` : ''}：${entry.quantity}${entry.unit}${sectionHint}`);
  }
  const overflow = owned.slice(maxEntries);
  if (overflow.length > 0) {
    lines.push(`- 另需覆盖（仅列名，共${overflow.length}条）：${overflow.slice(0, 40).map(item => item.entry.name).join('、')}${overflow.length > 40 ? ' 等' : ''}`);
  }
  return lines;
}
