/**
 * 蓝图引用一致性判定链（结构候选定位 + 语义判定三态裁决 + 冲突修复锚点 + 章级重定位）——S5 语义判定版，词表豁免全部废除
 *
 * S6 零行为拆分自 integratedBlueprint.ts（门面 re-export，对外导出不变）：仅机械搬迁，未改动任何语句与常量。
 */
import { buildCitationSentenceContext, defaultCitationAdjudicator } from '../semanticAdjudication';
import type { AdjudicationRecord, CitationAdjudicationCandidate, CitationAdjudicator, CitationCandidateKind } from '../semanticAdjudication';
// 单位口径单源：quantityUnitVariants 定义在权威层（检测定位=修复定位同源），本文件不再自持一份
import { flexNameOptionalPattern, flexNamePattern, quantityUnitVariants } from '../integrity/authorities/authorities';
import type { DocumentGenerationDiagnostics, ValidationIssue } from '../types';
import type { BlueprintData, BlueprintQuantity } from './types';

/**
 * 蓝图引用一致性（S5 语义判定版）：确定性结构定位 + 语义判定层三态裁决，词表豁免全部废除。
 * 结构定位（collectBlueprintCitationCandidates，零词表豁免）：工期/村数/劳动力峰值/工程量数值与
 * 蓝图权威比对，不一致即候选（值 == 权威的引用不入候选）；规格/频次/分区/村名/单体/分部/子集和
 * 等一切语义豁免均不在此层判断。
 * 唯一例外是「口径分层放行」（4.55.30，数据判定·非词表）：引用值命中该条目在蓝图权威中已登记的
 * 分层值（规格-数量拆分小计 = R20 合法值；分工程/单体明细值且被上位标题限定到该对象）时不入候选
 * ——明细口径引用不是「以项目级汇总口径陈述的错值」，且其唯一可执行的修复动作（改写成条目合计）
 * 恰是 R20 明令禁止方向 / 跨单体合计写入单体范围句的对象错位。未登记值（不在任何分层值内）照常入
 * 候选，判定层裁决与锚点修复链不变。
 * 语义判定（semanticAdjudication 判定层）：该句是否以该项目级数据口径陈述该数值——consistent 放行、
 * conflict 报 error 并产修复锚点（判定层直连修复器，修复侧无平行豁免）、uncertain 报 warning 显式暴露
 * （判定不可用不降级、不回退词表猜测）。
 * 红线事实（非金额）缺口：正文未体现即 warning（结构判定，不涉语义）。
 */

/** 修复锚点（判定层裁决为冲突的工程量引用）：全文坐标 + 冲突值 + 权威值；修复器只做坐标替换 */
export interface QuantityConflictAnchor {
  /** 清单条目名 */
  name: string;
  /** 正文中的冲突值（判定层裁决为以该项目级口径陈述的错值） */
  value: number;
  unit: string;
  /** 清单汇总权威值 */
  authorityValue: number;
  /** 冲突值原文在全文坐标中的起止（章级修复前按章重定位） */
  start: number;
  end: number;
}

interface BlueprintCitationEntry {
  subject: string;
  value: number;
  unit: string;
  authority: number;
  start: number;
  end: number;
}

export interface BlueprintCitationCollection {
  candidates: CitationAdjudicationCandidate[];
  entries: Map<string, BlueprintCitationEntry>;
  gapIssues: ValidationIssue[];
}

export interface BlueprintCitationAdjudicationSummary {
  total: number;
  conflicts: number;
  consistent: number;
  uncertain: number;
  /** 判定不可用原因（调用失败/输出不可解析；缺省即判定层正常） */
  unavailable?: string;
  /** 逐条判定记录（subject 供进度落盘审计） */
  records: Array<AdjudicationRecord & { subject: string }>;
}

export interface BlueprintCitationOptions {
  /** 单测注入判定层（生产缺省用语义模型判定） */
  adjudicate?: CitationAdjudicator;
  diagnostics?: DocumentGenerationDiagnostics;
  signal?: AbortSignal;
  /** 判定记录观测回调（进度/日志落盘；不改变检测结果） */
  onAdjudication?: (summary: BlueprintCitationAdjudicationSummary) => void;
}

export interface BlueprintCitationVerdict {
  issues: ValidationIssue[];
  /** 判定为冲突的工程量锚点（修复器直连消费；工期/村数/峰值冲突由 LLM 修复轮处理） */
  anchors: QuantityConflictAnchor[];
  summary: BlueprintCitationAdjudicationSummary;
}

/** 表格行原地掩码（同长度空格替换，全文坐标不变——锚点坐标必须与原文一致）；表内文本不入检测 */
function maskMarkdownTableLines(markdown: string): string {
  return markdown.split('\n').map(line => (/^\s*\|/u.test(line.trim()) ? ' '.repeat(line.length) : line)).join('\n');
}

/** 数值近似相等（两位小数容差，与数值对账口径一致） */
function nearlyEqualValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.01 + 1e-6 * Math.max(Math.abs(a), Math.abs(b));
}

/** 专业维度的正则片段：土建/安装/装饰/市政（「附属」不是专业维度——「室外附属工程」与
 *  「室外安装工程」同属「室外」对象，实机同节并列引用属合法：1.4.3「室外附属工程」小节列
 *  室外安装工程明细值 复合管1991.6m／电力电缆1447.55m） */
const PROFESSION_ALTERNATION = '土建|安装|装饰|市政';

/** 分组标签的专业尾缀：「1#厂房安装工程」→ 安装；「室外附属工程」/「1#厂房工程」→ 无 */
const GROUP_PROFESSION_RE = new RegExp(`(${PROFESSION_ALTERNATION})工程$`, 'u');
/** 正则元字符转义（对象名可含「（3T/D)」等括号，直接内插会构造出畸形正则） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 对象维度（结构层）：引用位置的上位标题链是否限定到「分工程明细」所属对象。
 *  标题「#### 1.25.1 1#厂房」下的「金属栏杆316.630m」是单体内合法口径；无单体限定的项目级标题链
 *  （如正文「本标段金属栏杆316.630m」）不在此列，仍入候选交判定层（防跨单体合计写进单体范围句）。
 *  标题链按层级收敛判定：向上仅接受层级更浅的标题（#### 1.25.1 的兄弟小节 #### 1.25.4 不构成
 *  上位作用域），防止同文档他处单体标题把兄弟小节内的引用误判为单体内口径。
 *  专业维度（4.55.33 实机取证）：分组名形如「1#厂房安装工程」= 对象（1#厂房）+ 专业（安装）。
 *  「最近的对象作用域标题是同一对象的**另一专业**的单位工程名」时不授权——防跨专业错位
 *  （「1#厂房土建工程」小节把 1#厂房安装工程明细值当本专业量陈述）。判定限**规范单位工程标题形态**
 *  （对象名紧跟专业词再跟「工程」，如「1#厂房土建工程」）：实机复合标题（「3#门卫土建零星装饰工程」
 *  「1#厂房土建装饰装修工程」）与混合专业小节（「1.48 3#门卫土建零星装饰工程」内列电气量、
 *  「1.4.3 室外附属工程」内列室外安装工程量）均属合法跨专业并列陈述——全量复跑实测：按「标题行
 *  含任一专业词即校专业」（专业词不必紧跟对象名）的宽口径判定会新造 10 条假候选，故按规范形态收敛。 */
function scopedToGroup(masked: string, position: number, groupLabel: string): boolean {
  // 明细行标签去尾缀取对象名：「1#厂房土建工程」→「1#厂房」、「室外附属工程」→「室外附属」
  const token = groupLabel.replace(new RegExp(`(?:${PROFESSION_ALTERNATION})?工程$`, 'u'), '').trim();
  if (token.length < 2) return false;
  const groupProfession = GROUP_PROFESSION_RE.exec(groupLabel)?.[1];
  const professionConflictRe = groupProfession
    ? new RegExp(`${escapeRegExp(token)}(${PROFESSION_ALTERNATION})工程`, 'u')
    : undefined;
  let enclosingLevel = 7;
  let lineEnd = masked.indexOf('\n', position);
  let lineStart = masked.lastIndexOf('\n', position) + 1;
  for (;;) {
    const line = masked.slice(lineStart, lineEnd < 0 ? masked.length : lineEnd);
    const heading = /^\s*(#{1,6})\s/u.exec(line);
    if (heading && heading[1]!.length < enclosingLevel) {
      enclosingLevel = heading[1]!.length;
      if (line.includes(token) || line.includes(groupLabel)) {
        // 规范单位工程形态的对象+专业限定：专业与分组专业不一致即跨专业错位（不入作用域）
        const headingProfession = professionConflictRe?.exec(line)?.[1];
        if (headingProfession && headingProfession !== groupProfession) return false;
        return true;
      }
    }
    if (lineStart === 0) return false;
    lineEnd = lineStart - 1;
    lineStart = masked.lastIndexOf('\n', lineEnd - 1) + 1;
  }
}

/** 结构定位（零语义豁免·唯一例外为口径分层放行）：不一致引用入候选；判定辅助事实只携带结构化数据投影（分工程明细/村名单） */
export function collectBlueprintCitationCandidates(markdown: string, data: BlueprintData): BlueprintCitationCollection {
  const candidates: CitationAdjudicationCandidate[] = [];
  const entries = new Map<string, BlueprintCitationEntry>();
  const gapIssues: ValidationIssue[] = [];
  const masked = maskMarkdownTableLines(markdown);
  let sequence = 0;
  const pushCandidate = (input: { kind: CitationCandidateKind; subject: string; value: number; unit: string; authority: number; start: number; end: number; sentence: string; facts?: string[] }) => {
    sequence += 1;
    const id = `c${sequence}`;
    candidates.push({ id, kind: input.kind, subject: input.subject, value: input.value, unit: input.unit, authority: input.authority, sentence: input.sentence, facts: input.facts });
    entries.set(id, { subject: input.subject, value: input.value, unit: input.unit, authority: input.authority, start: input.start, end: input.end });
  };
  // 红线事实缺口（非金额）：事实值按标点切片段，任一实质片段未在正文出现即 warning——
  // 泛化空壳片段（其他/具体详见/满足设计要求/纯编号）剔除，防误判体现
  for (const fact of data.redLineFacts.filter(item => !item.amount && item.key !== '自然村数量')) {
    const parts = String(fact.value)
      .split(/[，。；、（）()\]【】：:\s\n[]+/u)
      .map(part => part.trim())
      .filter(part => part.length >= 3
        && !/^[\d.]+$/u.test(part)
        && !/^(?:其他|具体详见|满足设计要求|设计图纸|图集|招标文件|政府相关文件|规范等|资料)$/u.test(part));
    if (parts.length === 0) continue;
    if (!parts.some(part => markdown.includes(part))) {
      gapIssues.push({ level: 'warning', severity: 'warning', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图红线事实缺口：正文未体现「${fact.key}=${fact.value}」`, suggestion: `请在对应章节补写该红线事实（数值必须与蓝图一致）` });
    }
  }
  // 劳动力峰值：不一致引用即候选（阶段峰值/工种峰值等语境交判定层）
  if (data.resources.labor.peakValue > 0) {
    const laborRe = /(?:劳动力峰值|施工高峰|高峰人数|高峰期劳动力|劳动力高峰)(?:为|约|达到|共计)?[^\n。；;]{0,20}?(\d+(?:\.\d+)?)\s*人/gu;
    for (const match of masked.matchAll(laborRe)) {
      const value = Number(match[1]);
      if (!(value > 0) || value === data.resources.labor.peakValue) continue;
      const start = (match.index ?? 0) + match[0].indexOf(match[1]);
      pushCandidate({ kind: 'labor-peak', subject: '劳动力峰值', value, unit: '人', authority: data.resources.labor.peakValue, start, end: start + match[1].length, sentence: buildCitationSentenceContext(masked, match.index ?? 0, match[0].length) });
    }
  }
  if (data.contract.totalDays > 0) {
    const dayRe = /(?:总工期|施工工期|合同工期|工期)(?:为|约|共计|控制)?[^\n。；;]{0,20}?(\d+(?:\.\d+)?)\s*(?:日历)?天/gu;
    for (const match of masked.matchAll(dayRe)) {
      const value = Number(match[1]);
      if (!(value > 0) || value === data.contract.totalDays) continue;
      // r28j M16 扩围（r28i 归因）：「…亮化与收尾工程节点用时2天，合计89天，预留机动工期1天」的
      // 「工期1天」被 dayRe 误采为总工期口径候选（89+1=90 与蓝图权威数学一致）；数字前同分句窗口含
      // 预留/机动/缓冲词时属工期分解的缓冲项，非总工期口径陈述，不入候选
      // r28m M24a F3 扩围：关键线路/首件/样板/分区/分片/阶段/单体——同分句窗口含此类子项口径词时
      // 属进度分解子项表述（「关键线路控制工期300天」），非项目总工期口径陈述
      const start = (match.index ?? 0) + match[0].indexOf(match[1]);
      const daySegStart = Math.max(masked.lastIndexOf('，', start), masked.lastIndexOf(',', start), masked.lastIndexOf('。', start), masked.lastIndexOf('；', start), masked.lastIndexOf('\n', start)) + 1;
      if (/预留|机动|缓冲|关键线路|首件|样板|分区|分片|阶段|单体/u.test(masked.slice(daySegStart, start))) continue;
      pushCandidate({ kind: 'total-days', subject: '总工期', value, unit: '日历天', authority: data.contract.totalDays, start, end: start + match[1].length, sentence: buildCitationSentenceContext(masked, match.index ?? 0, match[0].length) });
    }
  }
  // 自然村数量：不一致村数引用即候选（分区数学/分配语境交判定层）——「自然村分组/施工组」是
  // 作业组织概念（非村数陈述），不入候选（概念边界，非词表豁免）
  // r28m M24a A1：负向排除同步扩容「作业面|施工点|施工段」（与 detectors.ts orgTail 同源判据）
  const villageFact = data.redLineFacts.find(fact => fact.key === '自然村数量');
  const villageAuthority = villageFact ? Number(/(\d+)/u.exec(villageFact.value)?.[1]) : 0;
  if (villageAuthority > 0) {
    const villageRe = /(\d+)\s*个[^，。；、\s\n]{0,8}?自然村(?!分组|施工组|作业面|施工点|施工段)/gu;
    const villageFacts = data.project.scope ? [`蓝图项目范围：${data.project.scope}`] : undefined;
    for (const match of masked.matchAll(villageRe)) {
      const value = Number(match[1]);
      if (!(value > 0) || value === villageAuthority) continue;
      const start = (match.index ?? 0) + match[0].indexOf(match[1]);
      pushCandidate({ kind: 'village-count', subject: '自然村数量', value, unit: '个', authority: villageAuthority, start, end: start + match[1].length, sentence: buildCitationSentenceContext(masked, match.index ?? 0, match[0].length), facts: villageFacts });
    }
  }
  // 工程量引用：不一致即候选——规格句/检测频次/分区声明/村名语境/单体量/分部量句/子集拆分/
  // 分工程明细值等一切语义豁免交判定层裁决，此层只做结构定位
  // 名称命中两轮收集（结构定位）：严格形态（括号半/全角互配、内容必需）与省略形态（括号段
  // 整体省略，如「路床碾压检验」）全条目命中统一分配——严格优先 → 靠前优先 → 长匹配优先：
  // 防省略形态抢占其它条目全名位置（「1#生态池（2T/D)」省略形态不得占用「1#生态池（3T/D)」）；
  // 蓝图「塑料管铺设」与「塑料管」并存时，正文「塑料管铺设8205.53m」只归长条目，不被短名误绑
  const nameHits: Array<{ name: string; quantity: BlueprintQuantity; start: number; end: number; strict: boolean }> = [];
  for (const [name, quantity] of Object.entries(data.quantities)) {
    if (!quantity || quantity.value <= 0) continue;
    for (const [pattern, strict] of [[flexNamePattern(name), true], [flexNameOptionalPattern(name), false]] as const) {
      const nameRe = new RegExp(pattern, 'gu');
      for (const nameMatch of masked.matchAll(nameRe)) {
        const start = nameMatch.index ?? 0;
        nameHits.push({ name, quantity, start, end: start + nameMatch[0].length, strict });
      }
    }
  }
  nameHits.sort((left, right) => (
    (left.strict !== right.strict ? (left.strict ? -1 : 1) : 0)
    || left.start - right.start
    || (right.end - right.start) - (left.end - left.start)
    || right.name.length - left.name.length
  ));
  const quantityOccupied: Array<{ start: number; end: number }> = [];
  // 4.44 #29 根因根治：值窗口「不跨名字取数」边界——所有命中名起点有序表（含重叠/被占用命中），
  // 处理每个 hit 时右界 = min(40 字, 分隔符, 下一个名字起点)。短名被长词前缀误命中（「塑料管材」
  // 含「塑料管」）时，旧 40 字窗口跨越真正条目名「塑料管铺设」取到 8205.53 产出假候选
  // （subject=塑料管 value=8205.53 authority=7525.01），判定层合理误判 conflict 后修复器锚点直连
  // 把正确引用改成错误值（把对的改成错的）。
  const nameHitStarts = nameHits.map(hit => hit.start).sort((left, right) => left - right);
  const nextNameHitStartAfter = (position: number): number => {
    let low = 0;
    let high = nameHitStarts.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (nameHitStarts[mid]! <= position) low = mid + 1;
      else high = mid;
    }
    return low < nameHitStarts.length ? nameHitStarts[low]! : Number.POSITIVE_INFINITY;
  };
  for (const hit of nameHits) {
    const { name, quantity } = hit;
    const ns = hit.start;
    const ne = hit.end;
    // 名字出现即占位：引用位置即使清单单位与正文异构（长名清单 m3 vs 正文 m²）也由命中名占用
    // （坐标用实际匹配长度——全角/半角与省略写法下与名称字面长度不等）
    if (quantityOccupied.some(o => ns < o.end && ne > o.start)) continue;
    quantityOccupied.push({ start: ns, end: ne });
    const unit = quantity.unit || '';
    // 单位变体归一（结构定位）：清单 m2/m3/t 与正文上标写法（m²/㎡/m³）同义；
    // 右边界断言排除「直径不小于10m」类 10mm 的 m 子串误匹配
    const unitSuffix = unit ? `${quantityUnitVariants(unit)}(?![0-9A-Za-z])` : '';
    // 值窗口（结构定位）：名后 40 字、截断于列举分隔符/换行/下一个条目名起点，取第一个「数值+本单位」
    // （左边界断言排除数字串截取；不跨名字取数防短名误绑，见上方 nameHitStarts 注释）
    const rawWindow = masked.slice(ne, ne + 40);
    const windowStop = Math.min(...[rawWindow.search(/[、。；;，,\n]/u)].filter(pos => pos >= 0).concat([rawWindow.length, nextNameHitStartAfter(ne) - ne]));
    const window = rawWindow.slice(0, windowStop);
    const valueRe = new RegExp(`(?<![\\dA-Za-z])(\\d+(?:\\.\\d+)?)\\s*${unitSuffix}`, 'u');
    const match = valueRe.exec(window);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value === quantity.value) continue;
    const start = ne + (match.index ?? 0) + match[0].indexOf(match[1]);
    // 口径分层放行（结构层·数据判定，非词表豁免；4.55.30 实机归因）——引用值命中该条目在蓝图权威中
    // 已登记的分层值时属同一份清单权威的明细口径引用，不是「以项目级汇总口径陈述的错值」：
    // ① 规格层（specBreakdown，R20）：此类候选唯一可执行的修复动作是被改写成条目合计，而 R20 明令
    //    「禁将规格小计写为名称合计」（巢湖实测「直形墙100mm规格2.520m³、150mm规格128.870m³」判
    //    conflict → 锚点改写为合计 147.66 即规格错位缺陷复活）；与 numericVerification「规格拆分值
    //    入池（防反向误报）」同源。原「规格 token 邻接 + 小计和≈合计 干净切分」双门只在「列举句」
    //    形态下放行，规格 token 缺失（「金属栏杆247.990m」「防火涂料26494.190m²」）或蓝图自身口径
    //    不自洽（金属栏杆规格小计 820.58 vs 合计 410.29）时误放行出锚点——本层以「值 ∈ 已登记分层
    //    值集」直接判定，不再要求 token 邻接与干净切分。
    // ② 单体层（groups）：明细值只在所属对象作用域内合法（金属栏杆 1#厂房316.63 / 2#门卫78.7 /
    //    3#门卫14.96 → 合计410.29）——上位标题限定到该单体的范围句内引用明细值不该被改写成跨单体
    //    合计（对象错位）；无单体限定的项目级语境不在此列，仍入候选。作用域判定含专业维度
    //    （scopedToGroup）：单体+专业（单位工程）分组名在另一专业的小节内不授权（跨专业错位照报）。
    // 分层值必须与该条目权威合计异值（同值项不承载分层信息，且上方 value === quantity.value 已放行）；
    // 未登记值（单条清单行的规格量等）照常入候选 → 判定层裁决 → 锚点修复链收敛（真冲突仍报出）。
    // 4.55.33 实机取证（巢湖 doc-1790132484476 三条 blocker：工厂灯1179套／A型应急照明集中1台／
    // 等电位端子箱、测试板1套）：三条均**不是**专业（单位工程）小计，故不放行——① 该条目在
    // 「1#厂房安装工程」的分工程明细值分别是 1222／4／21，项目级合计 1222／4／27，正文值 1179／1／1
    // 与之皆不相等；② 逐条清单核对：1179 = 工厂灯「悬挂灯（深照型）」行（同工程「悬挂灯（广照型）」
    // 43 套，1179+43=1222 恰为该工程小计），1 = A型应急照明集中 4 条配电箱行（1ALE1/1ALE2/1ALE-GG1/
    // 1ALE-GG2）之一，1 = 等电位端子箱、测试板「总等电位联结箱MEB」行（同工程「局部等电位端子箱LEB」
    // 20 套）；③ 蓝图权威（grep 全量）不含 1179／深照型／广照型，即这些单条清单行值未获任何分层投影
    // （与 blueprintCitationDetailLayers 的「金属窗334.840／钢支撑182.513 无分层出处」同型）——正文以
    // 条目名口径陈述单行量，收敛方向只能是条目合计（判定层 rationale 中的「安装工程汇总口径」系模型
    // 臆测：安装工程汇总即 1222／4／21）。要真正放行此型需先由蓝图投影层登记拆分（specBreakdown 现按
    // 特征描述规格 token 聚合，「深照型／广照型」落在名称字段而同型号 LED 200W 被合并 → 拆分被剔除）。
    const splitValues = (quantity.specBreakdown ?? []).filter(item => !nearlyEqualValue(item.value, quantity.value)).map(item => item.value);
    if (splitValues.some(splitValue => nearlyEqualValue(splitValue, value))) continue;
    const groupValues = (quantity.groups ?? []).filter(group => !nearlyEqualValue(group.value, quantity.value));
    if (groupValues.some(group => nearlyEqualValue(group.value, value) && scopedToGroup(masked, ns, group.group))) continue;
    // 判定辅助事实：清单分工程明细（分工程口径/跨工程同值复制的判定依据，结构化数据投影）
    const groups = quantity.groups ?? [];
    const facts = groups.length > 0
      ? [`该条目清单分工程明细：${groups.map(group => `${group.group} ${group.value}${unit}`).join('、')}`]
      : undefined;
    pushCandidate({ kind: 'quantity', subject: name, value, unit, authority: quantity.value, start, end: start + match[1].length, sentence: buildCitationSentenceContext(masked, ns, start + match[1].length - ns), facts });
  }
  return { candidates, entries, gapIssues };
}
/**
 * 判定（S5 语义判定版）：结构候选交语义判定层三态裁决——consistent 放行；conflict 报 error，
 * 工程量冲突同产修复锚点（修复器锚点直连，无平行豁免）；uncertain 报 warning 显式暴露。
 * 判定不可用：整批按未决暴露并附 unavailable 原因（不回退词表猜测，不静默放行）。
 */
export async function blueprintCitationVerdict(markdown: string, data: BlueprintData, options: BlueprintCitationOptions = {}): Promise<BlueprintCitationVerdict> {
  const collection = collectBlueprintCitationCandidates(markdown, data);
  const issues: ValidationIssue[] = [...collection.gapIssues];
  const anchors: QuantityConflictAnchor[] = [];
  const summary: BlueprintCitationAdjudicationSummary = { total: collection.candidates.length, conflicts: 0, consistent: 0, uncertain: 0, records: [] };
  if (collection.candidates.length > 0) {
    const adjudicate = options.adjudicate ?? defaultCitationAdjudicator;
    const outcome = await adjudicate(collection.candidates, { diagnostics: options.diagnostics, signal: options.signal });
    summary.unavailable = outcome.unavailable;
    const reportedSubjects = new Set<string>();
    const reportedUncertain = new Set<string>();
    for (const candidate of collection.candidates) {
      const record = outcome.records.get(candidate.id);
      const conclusion = record?.conclusion ?? 'uncertain';
      const rationale = record?.rationale ?? outcome.unavailable ?? '判定层未返回结论';
      summary.records.push({ id: candidate.id, subject: candidate.subject, conclusion, rationale });
      if (conclusion === 'consistent') {
        summary.consistent += 1;
        continue;
      }
      if (conclusion === 'uncertain') {
        summary.uncertain += 1;
        const key = `${candidate.subject}|${candidate.value}`;
        if (!reportedUncertain.has(key)) {
          reportedUncertain.add(key);
          issues.push({ level: 'warning', severity: 'warning', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图引用未决：${candidate.subject} ${candidate.value}${candidate.unit} 与蓝图口径 ${candidate.authority}${candidate.unit} 的一致性无法判定（${rationale}）`, suggestion: `请核对后统一使用蓝图口径：${candidate.subject} ${candidate.authority}${candidate.unit}` });
        }
        continue;
      }
      summary.conflicts += 1;
      // 锚点先入（不受报错去重影响）：同名冲突跨章多处均须可修复
      if (candidate.kind === 'quantity') {
        const entry = collection.entries.get(candidate.id);
        if (entry) anchors.push({ name: candidate.subject, value: candidate.value, unit: candidate.unit, authorityValue: candidate.authority, start: entry.start, end: entry.end });
      }
      if (reportedSubjects.has(candidate.subject)) continue;
      reportedSubjects.add(candidate.subject);
      // 报错文案按数据类型分流（保留历史关键词：红线事实/劳动力峰值/工期表述/工程量，供下游归因）
      if (candidate.kind === 'village-count') {
        issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图红线事实冲突：正文出现与蓝图不一致的自然村数量 ${candidate.value} 个（判定依据：${rationale}）`, suggestion: `请统一使用蓝图口径：${candidate.subject} ${candidate.authority}${candidate.unit}` });
      } else if (candidate.kind === 'labor-peak') {
        issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图引用冲突：正文出现与蓝图不一致的劳动力峰值 ${candidate.value} 人（判定依据：${rationale}）`, suggestion: `请统一使用蓝图口径：${candidate.subject} ${candidate.authority}${candidate.unit}` });
      } else if (candidate.kind === 'total-days') {
        issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图引用冲突：正文出现与蓝图不一致的工期表述 ${candidate.value} 日历天（判定依据：${rationale}）`, suggestion: `请统一使用蓝图口径：${candidate.subject} ${candidate.authority}${candidate.unit}` });
      } else {
        issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图引用冲突：正文出现与蓝图不一致的工程量 ${candidate.subject} ${candidate.value}${candidate.unit}（判定依据：${rationale}）`, suggestion: `请统一使用蓝图工程量：${candidate.subject} ${candidate.authority}${candidate.unit}` });
      }
    }
    if (outcome.unavailable) {
      issues.push({ level: 'warning', severity: 'warning', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图引用语义判定不可用：${outcome.unavailable}（${collection.candidates.length} 条候选按未决显式暴露，未回退词表猜测）`, suggestion: '请检查语义模型可用性后重新生成；未决项不阻断定稿' });
    }
  }
  options.onAdjudication?.(summary);
  return { issues, anchors, summary };
}

/** 兼容入口：只消费问题列表的调用方（锚点消费方改用 blueprintCitationVerdict） */
export async function blueprintCitationConsistencyIssues(markdown: string, data: BlueprintData, options: BlueprintCitationOptions = {}): Promise<ValidationIssue[]> {
  return (await blueprintCitationVerdict(markdown, data, options)).issues;
}

/** 锚点章级重定位（全文坐标 → 章内坐标）：章内容以 '\n\n' 连接（与检测拼装同源）；
 * 逐章消费锚点时章内替换不跨章、坐标不漂移 */
export function rebaseCitationAnchorsForChapters(anchors: QuantityConflictAnchor[], chapterContents: string[]): QuantityConflictAnchor[][] {
  const batches: QuantityConflictAnchor[][] = chapterContents.map(() => []);
  let offset = 0;
  chapterContents.forEach((content, index) => {
    const end = offset + content.length;
    for (const anchor of anchors) {
      if (anchor.start >= offset && anchor.end <= end) {
        batches[index]!.push({ ...anchor, start: anchor.start - offset, end: anchor.end - offset });
      }
    }
    offset = end + 2;
  });
  return batches;
}
