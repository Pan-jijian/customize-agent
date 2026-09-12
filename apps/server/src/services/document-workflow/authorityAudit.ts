/**
 * V5 P5 · 无主数值审计器（M6 闭环落地）：生成后扫描正文全部数值，与 AuthorityIndex 匹配三分类。
 *
 * 分类语义（M6 方案原文）：
 * - 一致：数值核心命中权威索引（条目值 / 分工程明细 groups / 规格与标签内嵌数值）；
 * - 矛盾：修复+阻断——由 P4b 专项检测器承担（crossProjectValueCopyIssues / phaseLaborMixingIssues /
 *   blueprintCitationConsistencyIssues / resourceBreakdownConsistencyIssues），本审计不重复报告；
 * - 无主（权威无覆盖）按语境分流三桶：
 *   ① 推导器/投影覆盖缺口（资源·劳动力·机械·进度·物资语境）→ 进收编清单（transform/推导器扩容）；
 *   ② 工艺库缺口（工艺·构造·验收参数语境）→ 进收编清单（工艺参数登记）；
 *   ③ 其余 → 疑似编造（验收口径「0 未登记项」= 本桶为空）。
 *
 * 收编流程（防"以后还会遇到"的机制保证，非人肉白名单）：
 * - 无主项不被静默放过，而是每次生成系统性暴露、分类、收编；
 * - 新资源对象 → authorityIndex transform 扩容（P1 覆盖契约测试同步保护）；
 * - 新工艺参数 → 扩充 PROCESS_GAP_CONTEXT_RE（工艺库收编）；
 * - 合法非权威值的固定形态（规范编号/法规年代等）→ 登记表 AUDIT_REGISTERED_TOKEN_RES（每条附理由）；
 * - 审计为纯确定性零 LLM，修复轮每次重算校验组后重跑（报告始终基于最新 finalMarkdown）。
 */
import { buildAuthorityIndex } from './authorityIndex';
import type { BlueprintData } from './integratedBlueprint';
import { extractNumericTokens } from './numericalConsistency';

export interface AuthorityAuditFinding {
  /** 原文数值 token（与精确提取器同口径，如「58 人」「20420.39m³」） */
  token: string;
  /** 数值核心（token 首个数字串；与权威条目同口径比对） */
  value: string;
  /** 语境窗口（首现位置前后各 16 字，空白折叠）：分流判据与修复定位 */
  context: string;
  /** 全文出现次数（按 token 去重聚合） */
  occurrences: number;
}

export type AuthorityAuditBucket = 'derivation-gap' | 'process-gap' | 'unattributed';

export interface AuthorityAuditReport {
  /** 去重后扫描到的数值 token 总数 */
  scanned: number;
  /** 命中权威索引（一致）的 token 数 */
  matched: number;
  /** 命中登记表（合法非权威值：规范编号/法规年代等）的 token 数 */
  registered: number;
  /** ① 推导器/投影覆盖缺口：资源·劳动力·机械·进度·物资语境未命中——进收编清单 */
  derivationGaps: AuthorityAuditFinding[];
  /** ② 工艺库缺口：工艺·构造·验收参数语境未命中——进收编清单 */
  processGaps: AuthorityAuditFinding[];
  /** ③ 未登记项：其余语境未命中（疑似编造）——验收口径「0 未登记项」 */
  unattributed: AuthorityAuditFinding[];
  /** 值命中权威核心、但语境命中资源/工艺分类桶的 token（撞核藏值观测：如「余方弃置1.5m³」
   *  的 1.5 撞上无关条目「厚度1.5mm」规格核）。计入 matched 口径不变，单独列出供验收豁免/修复定位。 */
  contextualMatches: AuthorityAuditFinding[];
  /** = unattributed.length（验收口径显式字段，便于验收脚本直读） */
  unregisteredCount: number;
}

/** 合法非权威值的登记表（固定形态豁免；新增必须注明理由）。
 * 不是业务白名单：只登记"数值形态本身不属于项目数据"的类别（规范编号/法规年代），
 * 项目数值一律走 AuthorityIndex 匹配或进入无主分流。 */
const AUDIT_REGISTERED_TOKEN_RES: Array<{ re: RegExp; reason: string }> = [
  // 规范/标准编号形态（GB 50300-2013 / JGJ/T 98-2010 / DB34/T / T/CECS / ISO 等）：P 源公共规范编号
  { re: /^(?:GB|JGJ|CJJ|CJ|JG|JT|TB|SL|DL|HG|SH|YB|SY|GA|QB|WS|JC|NB|CECS|ISO|IEC|IEEE|API|RFC|DB\d*|T\/[A-Z]+)[/T]{0,2}\s?\d/iu, reason: '规范编号' },
  // 法规/标准年代引用（2019年 / 2020年）：版本时间而非项目数值
  { re: /^(?:19|20)\d{2}\s*年$/u, reason: '法规年代' },
  // 招标项目编号形态（E+12 位以上数字，如 E341523001005057001）：招标文件外部标识符，非项目数值（run1 收编）
  { re: /^E\d{12,}$/u, reason: '招标项目编号' },
];

/** ① 推导器/投影覆盖缺口语境（资源·劳动力·机械·进度·物资）：命中即分流到收编清单·推导器扩容。
 * 刻意不收录纯工艺词（混凝土/砂浆等）——工艺类走 PROCESS_GAP_CONTEXT_RE 单桶，防双表判据漂移。
 * 收编记录（V5 P6 首轮真实文档暴露）：设备电气/存储/通信类词汇（电源/电压/工作站/光缆等）归物资语境；
 * 清单构件工程量词汇（砖基础/圈梁/管道基础等）归投影覆盖缺口——权威投影应含清单明细行值。
 * 收编记录（第三轮·run1 三篇校准）：桩号里程（桩号/里程/K\d）与管网属性（管网/管道）；安装专业器材
 * （线缆/配线/配管/JDG/SC管/PC管/双绞）；拆除与人行道类工程量（拆除/人行道/侧石/缘石）；苗木规格
 * （胸径/地径/冠幅）；进度管理要素（工长/负责人/施工员/完成率/计划）。 */
const DERIVATION_GAP_CONTEXT_RE = /(?:劳动力|人力|用工|工人|民工|工种|普工|技工|管理人员|作业人员|人员|班组|峰值|高峰|机械|机具|设备|车辆|台班|挖掘机|装载机|自卸|搅拌|塔吊|吊车|起重机|进度|工期|日历天|节点|阶段|开工|竣工|进场|退场|保养|维修|周转|材料|物资|水泥|砂石|碎石|钢筋|钢管|钢材|管材|灯具|电缆|光缆|通信|线缆|配线|配管|双绞|JDG|SC管|PC管|电源|电压|照明|工作站|服务器|存储|工具|角磨|垫板|苗木|绿植|种植|养护期|保修|储备|堆放|供应|工程量|桩号|里程|K\d|管网|管道|胸径|地径|冠幅|工长|负责人|施工员|完成率|计划|拆除|人行道|侧石|缘石|杆件|砖基础|圈梁|构造柱|矩形柱|矩形梁|基础梁|过梁|有梁板|天沟|挑檐|雨篷|楼梯|散水|坡道|块料|墙面|吊顶|砌体|砖墙|多孔砖|实心砖|金属门|木质门|金属窗|百叶窗|百页窗|门窗|扶手|栏杆|桥架|管道基础|包管|压顶|独立基础|墙基|防潮层|给水|排水|空调|公厕|停车场|零星)/u;

/** ② 工艺库缺口语境（工艺·构造·验收参数）：命中即分流到收编清单·工艺库登记。
 * 收编记录（V5 P6 首轮真实文档暴露）：施工动作与构造/设备安装参数字类（开挖/敷设/距地/温度/垂直度等）归工艺语境。
 * 收编记录（第三轮·run1 三篇校准）：安全文明施工类（施工现场/场区/硬化/围挡/反光/封闭段/渣土）；
 * 专项试验与安装工艺（淋水/稳压/压力降/风速）；脚手架几何参数（纵距/横距/步距/立杆/连墙件）。 */
const PROCESS_GAP_CONTEXT_RE = /(?:混凝土|砼|砂浆|强度|等级|标号|配合比|坍落度|水灰比|掺量|养护|浇筑|振捣|模板|支架|脚手架|搭接|锚固|保护层|垫层|找平|找坡|坡度|防水|涂膜|卷材|闭水|蓄水|淋水|回填|夯实|压实|分层|虚铺|沟槽|基槽|基坑|边坡|标高|高程|厚度|间距|埋深|覆土|管径|井室|抹灰|腻子|涂料|面层|基层|安装|焊接|法兰|试压|冲洗|消毒|调试|接地|防雷|绝缘|电阻|验收|检验|检测|试验|取样|频率|焊缝|防腐|除锈|开挖|平整|清底|土方|路床|碾压|摊铺|温度|接头|管枕|接口|承插|热熔|连接|封堵|距地|挂墙|挂装|嵌墙|暗配|明配|暗装|敷设|过桥|随桥|排管|人孔|通棒|内径|管孔|垂直度|偏差|漏风|通风|壁厚|接缝|遍数|密植|分叉|栽植|浇灌|试运转|严密性|渗水|牌号|材质|分辨率|图像|稳压|压力降|风速|纵距|横距|步距|立杆|连墙件|施工现场|场区|硬化|围挡|反光|封闭段|渣土)/u;

const AUDIT_CONTEXT_WINDOW = 16;

/** 补全提取（审计口径 = 扫描全部数值，必须比修复轮「宁漏勿错」更全）：
 * 共享提取器的 PRECISE_TOKEN_RE 以 \b 收尾，% / ℃ 等非词形单位后接标点时边界不成立而漏提
 * （「压实度 93%，」）；座/辆/根/处/盏/株/道/孔 等常用计量单位不在任何词表（「检查井 555 座」）；
 * d 龄期（「养护 7d」）与 Φ/φ 前导直径形（非 ASCII 字母不入共享提取器）同样补齐。
 * 量词单位（座/辆/…/d）限整数且前置非数字点：小数形态是目录/章节编号（「2.29 道…」），
 * 整数限位防「N.NX」拆出尾数误报；%/℃/人日/工日保留小数（率值/温度/工日口径）。
 * 层/栋/幢/户 等建筑规模单位暂不收录（「第 3 层」类相对位置形态噪声大于收益，待收编流程裁决）。 */
const AUDIT_SUPPLEMENT_TOKEN_RE = /(?:(?<![\d.])\d+\s*(?:座|辆|根|处|盏|株|道|孔|眼|樘|d(?![A-Za-z0-9]))|\d+(?:\.\d+)?\s*(?:%|℃|人日|工日)|(?:DN|Φ|φ|HRB|HPB)\s*\d+(?:\.\d+)?)/gu;

/** 审计 token 提取：共享提取器 + 补全提取，按首现位置排序（报告可读性与测试确定性） */
function auditNumericTokens(markdown: string): string[] {
  const positions = new Map<string, number>();
  const add = (raw: string) => {
    const token = raw.trim();
    if (!token || positions.has(token)) return;
    positions.set(token, markdown.indexOf(token));
  };
  for (const token of extractNumericTokens(markdown)) add(token);
  for (const match of markdown.matchAll(AUDIT_SUPPLEMENT_TOKEN_RE)) add(match[0]);
  return [...positions.entries()].sort((left, right) => left[1] - right[1]).map(([token]) => token);
}

/** 权威索引的数值核心集合：条目值 / 分工程明细 groups / 规格与标签内嵌数字（如 C20、100W）。
 * 匹配按数值核心（忽略单位与大小写差异），与数值提取器的比对口径一致。 */
function authorityNumericCores(data: BlueprintData): Set<string> {
  const cores = new Set<string>();
  for (const entry of buildAuthorityIndex(data).entries) {
    if (typeof entry.value === 'number') cores.add(String(entry.value));
    for (const text of [String(entry.value), entry.spec, entry.label]) {
      if (!text) continue;
      for (const core of text.match(/\d+(?:\.\d+)?/gu) ?? []) cores.add(core);
    }
    for (const group of entry.groups ?? []) cores.add(String(group.value));
  }
  return cores;
}

/** 数值 token 的数值核心（首个数字串）："58 人" → "58"，"C30" → "30"（与数值核对轮同口径） */
function numericCore(token: string): string {
  const match = token.match(/\d+(?:\.\d+)?/u);
  return match ? match[0] : token.trim();
}

/** 无主项语境分流（①资源类 → ②工艺类 → ③其余），顺序即判据优先级 */
function classifyBucket(context: string): AuthorityAuditBucket {
  if (DERIVATION_GAP_CONTEXT_RE.test(context)) return 'derivation-gap';
  if (PROCESS_GAP_CONTEXT_RE.test(context)) return 'process-gap';
  return 'unattributed';
}

/** 生成后无主数值审计：扫描正文全部数值 token → 登记表豁免 → 权威核心匹配 → 无主语境分流。
 * data 缺省（蓝图不可用）时全部未命中按语境分流（推导缺口语境即暴露投影层未接管）。 */
export function auditAuthorityCoverage(markdown: string, data?: BlueprintData): AuthorityAuditReport {
  const cores = data ? authorityNumericCores(data) : new Set<string>();
  const tokens = auditNumericTokens(markdown);
  const derivationGaps: AuthorityAuditFinding[] = [];
  const processGaps: AuthorityAuditFinding[] = [];
  const unattributed: AuthorityAuditFinding[] = [];
  const contextualMatches: AuthorityAuditFinding[] = [];
  let matched = 0;
  let registered = 0;
  for (const token of tokens) {
    // 登记表先于匹配：规范编号/法规年代的"数字"本就不属于项目数据（如 GB 50300-2013 的首数字串）
    if (AUDIT_REGISTERED_TOKEN_RES.some(item => item.re.test(token))) {
      registered += 1;
      continue;
    }
    const value = numericCore(token);
    const index = markdown.indexOf(token);
    const context = (index >= 0 ? markdown.slice(Math.max(0, index - AUDIT_CONTEXT_WINDOW), index + token.length + AUDIT_CONTEXT_WINDOW) : token).replace(/\s+/gu, ' ').trim();
    const finding: AuthorityAuditFinding = { token, value, context, occurrences: markdown.split(token).length - 1 };
    if (cores.has(value)) {
      matched += 1;
      // 撞核藏值观测：值命中权威但语境属资源/工艺桶（如上例 1.5）——计入 matched 不变，单独可观测
      const matchBucket = classifyBucket(context);
      if (matchBucket !== 'unattributed') contextualMatches.push(finding);
      continue;
    }
    const bucket = classifyBucket(context);
    if (bucket === 'derivation-gap') derivationGaps.push(finding);
    else if (bucket === 'process-gap') processGaps.push(finding);
    else unattributed.push(finding);
  }
  return { scanned: tokens.length, matched, registered, derivationGaps, processGaps, unattributed, contextualMatches, unregisteredCount: unattributed.length };
}

/** 审计摘要单点文案（执行阶段 message 消费）。contextualMatches 为观测字段不计入摘要（matched 口径不变） */
export function authorityAuditSummary(report: AuthorityAuditReport): string {
  const base = `无主数值审计：扫描数值 ${report.scanned} 个（命中权威 ${report.matched}，登记豁免 ${report.registered}，推导/投影缺口 ${report.derivationGaps.length}，工艺库缺口 ${report.processGaps.length}，未登记 ${report.unregisteredCount}）`;
  return report.unregisteredCount > 0 ? `${base}；存在疑似编造数值，须核查` : base;
}

/** 审计明细行（执行阶段 details 消费；未登记优先，其次两类收编缺口） */
export function authorityAuditDetails(report: AuthorityAuditReport, limit = 24): string[] {
  const rows = (label: string, findings: AuthorityAuditFinding[]) => findings.length === 0
    ? []
    : [label, ...findings.slice(0, limit).map(finding => `${finding.token}（×${finding.occurrences}）— ${finding.context}`)];
  const lines = [
    ...rows('未登记（疑似编造，须核查或收编）：', report.unattributed),
    ...rows('推导器/投影覆盖缺口（进收编清单）：', report.derivationGaps),
    ...rows('工艺库缺口（进收编清单）：', report.processGaps),
  ];
  return lines.length > 0 ? lines : ['全部数值命中权威索引或登记表，无未登记项。'];
}
