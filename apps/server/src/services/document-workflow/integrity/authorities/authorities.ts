/**
 * integrity/authorities：权威口径抽取（P4 拆分，逐字机械搬移自 documentIntegrityChecks.ts）。
 * 层序最底层（零域间出边）：工期/装配率/支护/劳动力峰值/绿化养护/路灯/开挖深度/项目规模等权威口径
 * 单源抽取 + 共享数值辅助（PEAK_LABOR_RE 等跨域常量归此）。
 */
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel, SpecAuthorityMap, TenderRequirementModel, ValidationIssue } from '../../types';
import { stableHash, stringifyFactValue } from '../../utils';

export const PEAK_LABOR_RE = /(?:高峰期|高峰|峰值)[^。；;\n]{0,20}?(?:约)?\s*([\d,]+)\s*人/g;
// 阶段劳动力形态盲区（P1 扩围）：「装饰装修阶段投入20人」「主体结构阶段约300人」无高峰/劳动力前缀词，
// PEAK_LABOR_RE/LABOR_COUNT_RE 均不覆盖；阶段词自身即劳动力语境（LABOR_STAGE_LIMIT_WORDS 同族），
// 提取值经 laborPeakStageOf 带阶段限定参与同阶段互查，不影响跨阶段隔离

const LABOR_STAGE_LIMIT_WORDS = ['基坑与基础', '二次结构与砌体', '施工准备', '地下结构', '主体结构', '装饰装修', '机电安装', '室外工程', '收尾调试', '临时设施', '土方', '基坑', '基础'] as const;

// F6 口径隔离词表：管理口径与工种口径的劳动力数值不与总峰值互查/替换——
// 「管理人员18人 vs 施工高峰期286人」「钢筋工60人 vs 木工80人」属不同口径正常配置（真实生成误报根因）；
// 长词优先列前防子串截断（电焊工→焊工、质量员→质量员）

export const TRADE_WORKER_WORD_RE = /铺装工|钢筋工|混凝土工|架子工|砌筑工|抹灰工|防水工|油漆工|水暖工|水电工|管道工|电焊工|起重工|机械工|司索工|信号工|塔吊司机|测量工|试验工|绿化工|管网工|装修工|装饰工|安装工|养护工|保温工|幕墙工|防腐工|操作工|市政工|模板工|木工|瓦工|焊工|电工|普工/u;

/** 劳动力数值语境分组（F6）：management=管理口径、trade=工种口径（含工种名）、peak=总峰值口径。
 *  数字前 30 字符窗口内判定，窗口从最近分隔符（，、，;；:：）后截断——
 *  防「主体结构阶段投入钢筋工60人、木工80人，高峰人数约220人」的 220 被前句工种词串染；
 *  检测器 resourceConsistencyIssues 与确定性修复器 fixLaborPeakConflicts 共用同一分组口径
 *  （检测/修复同源，避免双份实现漂移）
 *  P1 修复（评分报告「按高峰期总人数20人配置专职安全员2名」的 20 被误划管理组根因）：
 *  只判数字前窗口（主语）——数字后 12 字符是谓语（「配置专职安全员2名」的「安全员」属后一个数字），
 *  原 before+after 联合窗口把总人数误划入 management 组，与 peak 组失去互查资格 → 20 vs 86 漏检 */

export function laborPeakStageOf(markdown: string, index: number): string | undefined {
  // 向前取最近片段边界（。；；换行）内的片段再找阶段词——固定 30 字符窗口不够到
  // 「地下结构阶段投入钢筋工60人、木工80人、混凝土工40人、架子工20人，高峰人数约180人」的
  // 180 是地下结构阶段的峰值汇总，跨列举分隔符继承前段阶段词（前段是投入明细无峰值词）；
  // 而「管网阶段高峰35人，高峰人数86人」的 86 是总口径，前段已是完整峰值条目时不再继承阶段词
  const before = markdown.slice(0, index);
  const boundary = Math.max(before.lastIndexOf('。'), before.lastIndexOf('；'), before.lastIndexOf(';'), before.lastIndexOf('\n'));
  let segment = markdown.slice(Math.max(0, boundary + 1), index);
  // 列举分隔符条件截断：前段含峰值语境词（已绑定独立峰值口径）则后条目是总口径不继承；
  // 前段是工种加总明细（含工种词）则后条目属该阶段峰值汇总，跨分隔符继承阶段词；
  // 前段是纯「投入N人」数值明细（无工种词）不继承——「施工准备阶段投入22人，高峰期199人」
  // 的 199 是总口径峰值（高峰期是总工期高峰），继承会漏修 199 vs 176（D2 零豁免实测根因）
  const cut = Math.max(segment.lastIndexOf('，'), segment.lastIndexOf('、'));
  if (cut >= 0 && (/(?:高峰期|高峰|峰值)/u.test(segment.slice(0, cut)) || !TRADE_WORKER_WORD_RE.test(segment.slice(0, cut)))) segment = segment.slice(cut + 1);
  let best: string | undefined;
  let bestPos = -1;
  for (const word of LABOR_STAGE_LIMIT_WORDS) {
    const pos = segment.lastIndexOf(word);
    if (pos > bestPos) { bestPos = pos; best = word; }
  }
  // A8 通用「XX阶段」短语限定词（丰乐镇实测）：道路/管网类项目阶段词与房建封闭词表不重叠，
  // 「第一阶段为施工准备与清杂清表……投入劳动力22人」的 22 与「道路面层及人行道施工阶段达到峰值68人」
  // 的 68 都被词表 lastIndexOf 错标为同一个「施工准备」，同 stage 互查报假矛盾。
  // 规则：取 segment 内最后一个非泛化「XX阶段」短语（阶段字前 1-14 个非分隔字符）；
  // 泛化前缀（各/每个/不同/相应）、数量形态（「五个施工阶段」）与词表词前缀缩写（「主体阶段」
  // 是「主体结构」简称、「装饰阶段」是「装饰装修」简称——h14 跨口径互查依赖这些形态无 stage 限定）
  // 不算具体阶段限定
  const genericMatches = [...segment.matchAll(/[^，,。；;：:\n]{1,14}阶段/gu)];
  const generic = genericMatches
    .filter(match => {
      const phrase = match[0].slice(0, -2);
      return !/^(?:各|每个|不同|相应)/u.test(phrase)
        && !/^[一二三四五六七八九十\d]{1,3}个/u.test(phrase)
        && !LABOR_STAGE_LIMIT_WORDS.some(word => word.startsWith(phrase));
    })
    .pop();
  if (generic && (generic.index ?? 0) > bestPos) {
    best = generic[0];
  }
  return best;
}

/** 单个表格块的结构解析结果（表头定位 + 人数列数据行抽取，与 qualityValidation 聚合口径一致） */

interface LaborTableBlock {
  /** 人员数量列数据行（仅该列数值） */
  countCells: number[];
  /** 合计/总计行的数值（无合计行为 undefined） */
  totalCell: number | undefined;
  /** 明细行数值之和（合计行存在时才有意义） */
  detailSum: number;
  /** 表峰值（该表人数列最大值） */
  peak: number;
  /** 表头含「高峰/峰值」列（阶段峰值口径表；无高峰列的分工种人数表不入多表峰值互查池 ） */
  hasPeakCol: boolean;
  /** 表头含工种/岗位类列（分工种明细表——「道路硬化与排水施工|普工|34人」的 34 是单工种
   * 峰值非全员峰值，不得入 tablePeakLabor 全员峰值池与正文「高峰期 86 人」互查（丰乐镇实测）） */
  hasTradeCol: boolean;
  /** 表头是否含分阶段维度列（分阶段投入明细表：同一表内同工种多行分阶段配置属合法动态值） */
  hasStageCol: boolean;
  /** 分工种明细行（工种名 → 该行人数），仅 hasTradeCol 表提取；
   * F15 同工种跨表高峰人数比对的数据源（电工 40 vs 4 类跨表互斥——丰乐镇第 3 轮实测） */
  tradeCells: Array<{ trade: string; value: number }>;
}

/** 从 markdown 表格中识别劳动力相关表格块（表头结构识别，非内容词判定） */

export function collectLaborTableBlocks(markdown: string): LaborTableBlock[] {
  const blocks: LaborTableBlock[] = [];
  const lines = markdown.split(/\r?\n/u);
  const tableRowLineRe = /^\|.+\|$/u;
  // 表头列判定用封闭词表（结构识别）：分阶段维度列 + 人员数量列，仅匹配表头单元格，不扫表格内容
  const STAGE_COL_RE = /阶段|时期|工期|工序|进度/u;
  const COUNT_COL_RE = /人数|劳动力|作业人员|施工人员|投入人数/u;
  const separatorCellRe = /^:?-{3,}:?$/u;
  const cleanHeaderCell = (cell: string) => cell.replace(/[*_`~]/gu, '').trim();
  for (let index = 0; index < lines.length; index += 1) {
    if (!tableRowLineRe.test(lines[index].trim())) continue;
    // 逐行聚合连续表格行为同一表格块（与 qualityValidation.markdownTables 聚合口径一致）
    const rows: string[] = [];
    while (index < lines.length && tableRowLineRe.test(lines[index].trim())) {
      rows.push(lines[index].trim());
      index += 1;
    }
    index -= 1;
    if (rows.length < 3) continue;
    const cellsOf = (row: string) => row.split('|').map(item => item.trim()).slice(1, -1);
    // 表头行与数据行定位：优先分隔行（|---|---|）上一行为表头；无分隔行时仅当首行自身含双列表头词才接受
    let headerCells: string[] | undefined;
    let dataRows: string[];
    const separatorRow = rows.findIndex((row, rowIndex) => rowIndex > 0 && cellsOf(row).every(cell => separatorCellRe.test(cell)));
    if (separatorRow === 1 && rows.length >= 3) {
      headerCells = cellsOf(rows[0]).map(cleanHeaderCell);
      dataRows = rows.slice(2);
    } else if (separatorRow === -1 && rows.length >= 2) {
      const first = cellsOf(rows[0]).map(cleanHeaderCell);
      if (STAGE_COL_RE.test(first.join('|')) && COUNT_COL_RE.test(first.join('|'))) {
        headerCells = first;
        dataRows = rows.slice(1);
      } else {
        continue;
      }
    } else {
      continue;
    }
    // 列位置判定：表头中必须有人员数量列（分阶段列用于峰值表识别；合计表允许无分阶段列）
    const stageCol = headerCells.findIndex(cell => STAGE_COL_RE.test(cell));
    // 峰值口径列优先：「阶段平均人数」与「阶段高峰人数」并存时取高峰列，
    // 否则表峰值取到平均人数（190 人）而非真实高峰（230 人），与分工种人数表（60 人）形成假矛盾（真实生成误报根因）
    const peakCol = headerCells.findIndex(cell => /高峰|峰值/u.test(cell) && COUNT_COL_RE.test(cell));
    const countCol = peakCol >= 0 ? peakCol : headerCells.findIndex(cell => COUNT_COL_RE.test(cell));
    if (countCol < 0) continue;
    if (stageCol >= 0 && stageCol === countCol) continue;
    // 岗位配置表排除：表头含「岗位」且含「职责/持证/职称」的表格是项目组织岗位编制表
    // （项目经理1人、施工员3人），其人数列是岗位定员而非劳动力投入峰值；
    // 误当劳动力表会与分阶段投入表峰值（95人）形成假矛盾，LLM 修复面对两张都对的数据无从下手（历史缺陷）
    if (/岗位/u.test(headerCells.join('|')) && /职责|持证|职称/u.test(headerCells.join('|'))) continue;
    // 工种列识别：表头含工种/岗位/班组/人员类别列（不含高峰期列）即分工种明细表
    const hasTradeCol = headerCells.some(cell => /工种|岗位|班组|人员类别|管理人员/u.test(cell));
    const tradeCol = hasTradeCol ? headerCells.findIndex(cell => /工种|岗位|班组|人员类别|管理人员/u.test(cell)) : -1;
    // 数字提取只看人员数量列（列位置对齐），不再全表扫描数字单元格
    const countCells: number[] = [];
    let totalCell: number | undefined;
    let detailSum = 0;
    const tradeCells: Array<{ trade: string; value: number }> = [];
    for (const row of dataRows) {
      const cells = cellsOf(row);
      const cell = cells[countCol] || '';
      const match = /^([\d,]+)\s*人?$/u.exec(cell);
      if (!match) continue;
      const value = Number(match[1].replace(/[,，]/gu, ''));
      if (!Number.isFinite(value) || value <= 0) continue;
      // 合计/总计行：首单元格（或任一行内单元格）含封闭词表「合计/总计/小计」即视为汇总行
      const isTotalRow = cells.some((item, cellIndex) => cellIndex !== countCol && /合计|总计|小计/u.test(item));
      if (isTotalRow) {
        totalCell = value;
        continue;
      }
      countCells.push(value);
      detailSum += value;
      // F15 工种明细行提取（tradeCol 列单元格取工种词；单元格含「工种+规格」组合时取工种词部分）
      if (tradeCol >= 0) {
        const tradeRaw = (cells[tradeCol] || '').replace(/[*_`~]/gu, '').trim();
        const tradeName = TRADE_WORKER_WORD_RE.exec(tradeRaw)?.[0];
        if (tradeName) tradeCells.push({ trade: tradeName, value });
      }
    }
    if (countCells.length === 0 && totalCell === undefined) continue;
    const peak = Math.max(...(countCells.length > 0 ? countCells : [totalCell || 0]));
    blocks.push({ countCells, totalCell, detailSum, peak, hasPeakCol: peakCol >= 0, hasTradeCol, hasStageCol: stageCol >= 0, tradeCells });
  }
  return blocks;
}

/** 从 markdown 表格中提取劳动力分阶段表格的人数峰值（兼容旧单值口径：多表取最大）。
 * A10：分工种明细表（表头含工种/岗位/班组/人员类别列）的峰值是单工种峰值，
 * 不得入全员峰值池（「普工 34 人」被当全员峰值与正文「高峰期 86 人」互查——丰乐镇实测假矛盾） */

export function tablePeakLabor(markdown: string): number | undefined {
  const peaks = collectLaborTableBlocks(markdown).filter(block => !block.hasTradeCol).map(block => block.peak);
  return peaks.length > 0 ? Math.max(...peaks) : undefined;
}

/** 阶段链峰值提取（正文「22人→35人→45人→68人→30人」箭头链形态）：取链内最大值作跨章劳动力权威候选。
 * 与 resourceConsistencyIssues 的 chainPeaksOf 同源判定：语境词之后、句边界之内。
 * 分阶段明细表缺失时（丰乐镇实测：5.3.4 表体为空），「高峰/峰值…N人」总口径表述最大值为唯一正文内部权威。
 * 口径隔离：只取 PEAK_LABOR_RE（高峰/峰值前缀）命中值——工种口径（管道工12人）与
 * 阶段限定峰值（管网阶段35人）不进入权威池（laborPeakStageOf 过滤）。 */

export function tablePeakLaborWithChainFallback(markdown: string): number | undefined {
  const tablePeak = tablePeakLabor(markdown);
  if (tablePeak !== undefined) return tablePeak;
  let chainMax: number | undefined;
  for (const match of markdown.matchAll(PEAK_LABOR_RE)) {
    const value = Number(match[1].replace(/[,，]/gu, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    const valueIndex = match.index + match[0].indexOf(match[1]);
    if (laborPeakStageOf(markdown, valueIndex)) continue;
    if (chainMax === undefined || value > chainMax) chainMax = value;
  }
  return chainMax;
}

export type SupportSystemAuthorityKind = 'slope' | 'pile';

/** 桩族词面（检测/修复同源，B1 模块级提升）：无灌注桩排桩类实义词面（钻孔灌注桩/排桩/地下连续墙/咬合桩/支护桩）不判桩族，
 * 防止「桩机2台」（施工机械）、「桩基施工」等泛化词被 bge 误判入桩支护族（合肥师范实测误报源） */

export const PILE_SUPPORT_LITERAL_RE = /钻孔灌注桩|高压旋喷桩|旋喷桩|搅拌桩|灌注桩|排桩|地下连续墙|咬合桩|支护桩/u;

/** 坡喷锚族词面（检测/修复同源）：土钉墙锚杆支护体系实义词 */

export const SLOPE_SUPPORT_LITERAL_RE = /土钉|放坡|喷锚|挂网|锚杆|护坡/u;

/** 支护体系权威提取（B1）：factsModel 基坑支护形式槽位值判定权威体系族；
 * 两族词并存（如「灌注桩+局部放坡」混合体系）不裁决（混合体系合法，交语义检测器） */

export function extractSupportSystemAuthority(factsModel?: DocumentFactsModel | null): SupportSystemAuthorityKind | undefined {
  const value = factsModel?.canonical?.byKey.foundation_support_form?.value;
  const text = stringifyFactValue(value);
  if (!text) return undefined;
  const slopeHit = SLOPE_SUPPORT_LITERAL_RE.test(text);
  const pileHit = PILE_SUPPORT_LITERAL_RE.test(text);
  if (slopeHit && !pileHit) return 'slope';
  if (pileHit && !slopeHit) return 'pile';
  return undefined;
}

const CN_NUMBER_MAP: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function cnNumberToArabic(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === '十') return 10;
  if (raw.startsWith('十') && raw.length === 2) return 10 + (CN_NUMBER_MAP[raw[1] ?? ''] ?? 0);
  if (raw.endsWith('十') && raw.length === 2) return (CN_NUMBER_MAP[raw[0] ?? ''] ?? 0) * 10;
  if (raw.length === 1 && CN_NUMBER_MAP[raw] !== undefined) return CN_NUMBER_MAP[raw];
  return undefined;
}

/** 绿化养护期权威口径：清单条目（喷播植草籽等）特征描述「养护两年」——label 或 value 含
 * 「养护」且邻接「X年」（含中文数字）时提取；「混凝土养护 14 天」类天单位不采。
 * 数据源：billItemFacts（清单行级条目，value=特征｜工程量）优先、bills/preciseFacts 散装事实兜底、
 * project 招标范围类事实卡最后——首命中即返回，多源重复无副作用。 */
/** 绿化养护期确定性修复（检测定位=修复定位）：正文「养护…X年」与清单权威年数不一致时
 * 统一替换为权威值（只替换数字/中文数字本身、不动句式）。
 * 养护期属清单实质性条款——丰乐镇实测「养护期按一年执行」残留因修复全靠 LLM 轮而漏改，
 * 确定性替换覆盖正文与表格行两种形态（字符类排除竖线保持表格行值不被吞）。 */

export function extractGreeningMaintenanceAuthority(factsModel?: DocumentFactsModel | null): number | undefined {
  // 清单养护期可能混合口径（丰乐镇实测：红花酢浆草条目「养护一年」22 处 vs 其他苗木/草籽条目
  // 「养护两年」82 处）。首个命中即返回会把个别条目的口径（一年）升格为全文权威，修复器随后把
  // 主体条目（两年）全部改错。改为频率投票取众数：多数条目口径才是工程权威；并列时取大值
  // （养护期长在投标口径更安全）。
  const yearRe = /养护[^。；;|]{0,10}?([一二两三四五六七八九十]+|\d{1,2})\s*年/gu;
  // 跨源保持原优先级（bills > billItemFacts > preciseFacts > project）：首个有命中的源即权威域；
  // 源内频率投票取众数（丰乐镇实测：清单条目混合口径 82 处「养护两年」vs 22 处「养护一年」，
  // 首命中即返回会把个别条目的口径升格为全文权威），并列时取大值（养护期长在投标口径更安全）
  const sourceGroups = [factsModel?.bills ?? [], factsModel?.billItemFacts ?? [], factsModel?.preciseFacts ?? [], factsModel?.project ?? []];
  const collectInto = (text: string, votes: Map<number, number>) => {
    for (const match of text.matchAll(yearRe)) {
      const years = cnNumberToArabic(match[1] ?? '');
      if (years !== undefined && years > 0 && years <= 20) votes.set(years, (votes.get(years) || 0) + 1);
    }
  };
  const bestOf = (votes: Map<number, number>): number | undefined => {
    let best: number | undefined;
    let bestCount = 0;
    for (const [years, count] of votes) {
      if (count > bestCount || (count === bestCount && best !== undefined && years > best)) {
        best = years;
        bestCount = count;
      }
    }
    return best;
  };
  for (const group of sourceGroups) {
    const votes = new Map<number, number>();
    for (const fact of group) {
      const label = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
      collectInto(stringifyFactValue(fact.value), votes);
      collectInto(label, votes);
    }
    if (votes.size > 0) return bestOf(votes);
  }
  return undefined;
}

/** 路灯数量权威口径：清单路灯条目（分型号多行）「N套/N盏」数值求和（103+15=118 形态）。
 * 数据源分层：billItemFacts（清单行级条目，从「｜工程量：」段取数量防特征描述「套」字误采）优先；
 * 无行级条目时 bills+preciseFacts 兑底（同对象引用去重，防同源多数组重复计数——重复求和会令
 * 权威翻倍，正文正确值被误报 blocker）。 */

export function extractStreetLightAuthority(factsModel?: DocumentFactsModel | null): number | undefined {
  const labelHit = (fact: DocumentFact) => /路灯/u.test(`${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`);
  const billItemFacts = (factsModel?.billItemFacts ?? []).filter(labelHit);
  const facts = billItemFacts.length > 0
    ? billItemFacts
    : [...(factsModel?.bills ?? []), ...(factsModel?.preciseFacts ?? [])].filter(labelHit);
  const seen = new Set<DocumentFact>();
  let total = 0;
  for (const fact of facts) {
    if (seen.has(fact)) continue;
    seen.add(fact);
    const raw = stringifyFactValue(fact.value);
    // 行级条目取「｜工程量：」段（特征描述含「套」字样时不被误采为数量）
    const quantityText = raw.split('｜工程量：')[1] ?? raw;
    for (const match of quantityText.matchAll(/(\d+)\s*(?:套|盏|杆)/gu)) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) total += value;
    }
  }
  return total > 0 ? total : undefined;
}

/** 绿化养护期清单红线检测（评分报告 P1）：正文「养护/养护期 X年」与清单养护期权威口径
 * 差异 >20% → blocker（正文必须回退为清单口径）；无清单养护期事实不检测（不误伤无清单项目）。
 * 否定声明句豁免（与 crossSectionNumericConflictIssues 同口径）：match 所在行含「不再出现/纠正为」
 * 等声明词时不计入口径池——修复轮输出「统一为两年，不再出现养护一年」时「一年」是引用旧值，
 * 误报会导致修复死循环。 */

export function excavationDepthFromFacts(factsModel: DocumentFactsModel): number | undefined {
  const canonical = factsModel.canonical?.byKey.excavation_depth?.value;
  // 子数组空值防御：部分调用方传入裁剪版 factsModel（仅 canonical/单类事实），缺失数组按空处理
  const factTexts = [
    ...(factsModel.drawings || []).map(fact => `${fact.fieldName || fact.key || ''} ${stringifyFactValue(fact.value)}`),
    ...(factsModel.project || []).map(fact => `${fact.fieldName || fact.key || ''} ${stringifyFactValue(fact.value)}`),
    ...(factsModel.preciseFacts || []).map(fact => `${fact.fieldName || fact.key || ''} ${stringifyFactValue(fact.value)}`),
  ].filter(Boolean);
  // canonical 槽位独立提取（不得依赖数组下标——canonical 为 undefined 时下标 0 会滑到图纸文本绕开关键词门）
  // 4.19.3 比较式条文防御：37 号令目录条文「开挖深度16m及以上」曾被误采为项目深度（真实回归：
  // 压过坡底线标注 5.15m 使 canonical 污染），提取时数字前后窗口含比较式词（超过/不小于/
  // 及以上/以上…）的数值排除，防条文阈值压过真实标注值
  const extractDepthValues = (text: string) => [...text.matchAll(/-?(\d+(?:\.\d+)?)\s*(?:m|米)/gu)]
    .filter(match => {
      const start = Math.max(0, (match.index ?? 0) - 6);
      const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 6);
      return !/(?:超过|大于|小于|不[大低小]于|不低于|及以上|及以下|以上|以下)/u.test(text.slice(start, end));
    })
    .map(match => Math.abs(Number(match[1])));
  const canonicalValues = canonical ? extractDepthValues(canonical) : [];
  const factValues = factTexts.flatMap(text => /基坑开挖深度|基坑深度|开挖深度|坡底线|坑底标高/u.test(text)
    ? extractDepthValues(text)
    : []);
  const filtered = [...canonicalValues, ...factValues].filter(value => Number.isFinite(value) && value >= 1 && value < 50);
  return filtered.length > 0 ? Math.max(...filtered) : undefined;
}

export function extractScheduleAuthority(factsModel?: DocumentFactsModel | null): number | undefined {
  const extract = (raw: string): number | undefined => {
    const match = raw.match(/(\d{1,4})\s*个?\s*日历天/u);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  for (const fact of factsModel?.schedule ?? []) {
    const label = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
    if (!/工期|周期/u.test(label)) continue;
    const found = extract(stringifyFactValue(fact.value));
    if (found !== undefined) return found;
  }
  const canonicalSchedule = factsModel?.canonical?.schedule ?? {};
  for (const entry of Object.values(canonicalSchedule)) {
    const item = Array.isArray(entry) ? entry[0] : entry;
    if (!item || !/工期|周期/u.test(item.label)) continue;
    const found = extract(item.value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** 装配率权威口径提取：factsModel 装配率事实卡（fieldId=assembly_rate / key=装配率）
 * 或招标要求模型（tenderRequirements.assemblyRate）中的百分比数值。
 * 4.17.4 合肥师范实测：正文 38.4% vs 招标锁定 30%，正文计算值必须回退为招标锁定值。 */

export function extractAssemblyRateAuthority(factsModel?: DocumentFactsModel | null): number | undefined {
  const extract = (raw: string): number | undefined => {
    const match = raw.match(/(\d+(?:\.\d+)?)\s*%/u);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 && value <= 100 ? value : undefined;
  };
  const facts = [...(factsModel?.project ?? []), ...(factsModel?.bills ?? []), ...(factsModel?.preciseFacts ?? [])];
  for (const fact of facts) {
    const label = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
    if (!/装配率|assembly/u.test(label)) continue;
    const found = extract(stringifyFactValue(fact.value));
    if (found !== undefined) return found;
  }
  const tenderText = factsModel?.tenderRequirements?.assemblyRate?.text;
  if (tenderText) return extract(tenderText);
  return undefined;
}

/** 工程规模摘要提取（6.1 工程概况一览表套话填充用）：单体建筑面积（招标口径卡优先）+
 * 地上/地下层数，组合为「建筑面积N平方米，地上N层、地下N层」形态；缺失项自动省略。 */

export function extractProjectScaleSummary(factsModel?: DocumentFactsModel | null): string | undefined {
  const parts: string[] = [];
  const project = factsModel?.project ?? [];
  let area: number | undefined;
  for (const fact of project) {
    const label = `${fact.key || ''}${fact.fieldName || ''}`;
    if (!/单体建筑面积|建设规模/u.test(label)) continue;
    const match = stringifyFactValue(fact.value).match(/(\d+(?:\.\d+)?)\s*(?:平方(?:米)?|㎡|m²)/u);
    if (match && Number.isFinite(Number(match[1]))) { area = Number(match[1]); break; }
  }
  if (area !== undefined) parts.push(`建筑面积${area}平方米`);
  // 层数从事实卡全量文本中提取首处「地上N层/地下N层」
  const allText = JSON.stringify({ project, drawings: factsModel?.drawings ?? [], tables: factsModel?.tables ?? [] });
  const floorsAbove = allText.match(/地上\s*(\d+)\s*层/u)?.[1];
  const floorsBelow = allText.match(/地下\s*(\d+)\s*层/u)?.[1];
  if (floorsAbove !== undefined) parts.push(`地上${floorsAbove}层`);
  if (floorsBelow !== undefined) parts.push(`地下${floorsBelow}层`);
  return parts.length > 0 ? parts.join('、') : undefined;
}

/** A2 总入口：跨章数值/支护体系矛盾确定性修复（劳动力峰值 → 节点工期 → 材料/设备数量 → 支护体系，顺序执行互不重叠） */
