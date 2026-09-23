/**
 * V5 P5 · 无主数值审计器（M6 闭环落地；F-T4 三源闭合 v2）：生成后扫描正文全部数值，
 * 与 AuthorityIndex 权威核 + 会话全源数值 token（资料原文/清单事实锁/蓝图/事实主表，与
 * numeric-verification 修复轮 buildNumericAuthority 单源）匹配三分类。
 *
 * 分类语义（M6 方案原文）：
 * - 一致：数值核心命中权威索引（条目值 / 分工程明细 groups / 规格-数量拆分 specBreakdown /
 *   规格与标签内嵌数值；尾零规约双侧归一）或全源 token 数值核心；
 * - 矛盾：修复+阻断——由 P4b 专项检测器承担（crossProjectValueCopyIssues / phaseLaborMixingIssues /
 *   blueprintCitationConsistencyIssues / resourceBreakdownConsistencyIssues），本审计不重复报告；
 * - 无主（权威无覆盖）按语境分流三桶：
 *   ① 推导器/投影覆盖缺口（资源·劳动力·机械·进度·物资语境）→ 进收编清单（transform/推导器扩容）；
 *   ② 工艺库缺口（工艺·构造·验收参数语境）→ 进收编清单（工艺参数登记）；
 *   ③ 其余 → 疑似编造（验收口径「0 未登记项」= 本桶为空）。
 *
 * F-T4 三源闭合 v2（数值编造根治 P0）：
 * - 提取修正：跳过表格行（与 C-T2 scanNumericTrace 同口径）、幽灵 token（严格边界无首现）、
 *   零值核心噪声（E0 类符号截断形态）；
 * - 匹配扩容：specBreakdown 值纳入权威核 + 尾零归一双侧（normalizeQuantityZeros 单源）+ 全源 token
 *   复核（extraAuthorityTokens：来源在证据/清单而蓝图未投影时不再误报缺口）；
 * - 豁免单源：无主 token 二次过 C-T2 分类器（classifyNumericTraceToken）——规范常数/管理数字
 *   计入 conventionExempt 不计缺口（与修复轮豁免口径完全一致，防两链判据漂移）；
 *   L0-7 收编（实机 doc-1790104980418 的 9 处假缺口根因）：**提取器粘连假 token** 不是项目数值——
 *   PRECISE_TOKEN_RE 型号分支贪婪吞并其后数量段（HRB4001.941t / HRB40025.851t / DN405m），
 *   数字分支吃下 Φ 后的直径数（Φ251.941t 的 251.941t）；拼接核（4001.941 / 405 / 251.941）
 *   不是正文任何数，据其报缺口即假缺口、据其进修复轮即误删正确正文。同源判定为 C-T2 新族
 *   R16 规格粘连（isSpecGluedValueToken，正则源 SPEC_GLUED_* 在 parameterPatterns 与主提取器同源）、
 *   R17 章节编号（isSectionNumberingToken：编号形态 + 语境同形邻号，目录/标题编号被吞成「1.22 周」
 *   时成立）；R13 语境词族同步扩容（板型/型材/型钢/钢种/钢号/系列——板型 HV470B 不再落缺口）。
 *   豁免是「提取形态」判定而非放宽未登记桶：真缺口（如上形态之外的 424.2m / 427.000个）照常报出，
 *   unattributed 桶口径不变；
 * - 4.55.31 B2 合计闭包（巢湖实测 doc-1790125123717 的 6403.78m² 归因）：自称合计（合计/总量/小计…）
 *   且可由**具名权威分项**闭合（名称锚定 + 单位同族 + 恰为其和，factReconciliation.namedTotalClosure
 *   单源）的数值 = 权威分项之和（合法自算合计）→ 收编 totalClaimClosed 观测桶，不落三桶缺口；
 *   未自称合计的分项/单项数值不适用（单值溯源必须逐条命中权威核）：同实测文档的 424.2m 是系统级
 *   分项值（语境「覆盖复合管350.6m、塑料管424.2m」无合计词），保持推导缺口。放宽到「任意权威值子集和」
 *   会把凭空数字成批放过（任意目标值的 2~3 值子集和命中率实测 60.77%），故不做无名称关系的凑数；
 * - 4.55.34 A 具名分项和候选（观测，**不改桶口径**）：两类覆盖缺口（推导/投影、工艺库）的 finding
 *   附 `closureCandidates`——该值恰为**语境中具名权威分项之和**（namedTotalClosure 单源，只是不要求
 *   「自称合计」词）。此前该候选只在自称合计时才被看见（B2），实机 424.2m 这类「写手自算之和」在报告
 *   里只剩一个裸 token，读者与修复轮都无法判断它是编造还是自算 → 候选把「合法观测」显性化：
 *   其正确归宿是**权威投影扩展**（transform/specBreakdown/groups 扩容，数据侧）或在正文按 D4.5
 *   还原为具名分项+合计的分解表述；**不得**改写成定性表述或删除（那会丢信息——值本身合法）。
 *   候选仅对两类覆盖缺口计算：unattributed（疑似编造）是红线，不给出任何「可闭合」暗示。
 * - 硬门禁（4.55.34 口径复核）：三桶任一非零 → authorityAuditIssues 产出 blocker（fact_consistency +
 *   llm_repairable 直通 isHardExportBlockingIssue）——审计失败不可进交付。
 *   **链尾不存在「确定性改定性/删除」收敛器，且不得恢复**：原 demoteUnsourcedNumericTokens 已按
 *   G 线 P2-2 停用（用删除通过门禁＝把「缺权威值」从交付物里抹掉，与「说清缺什么」的验收基准冲突），
 *   其调用点亦已整块移除（postReviewSurface）。本注释此前宣称的「链尾 demote 确定性改定性收敛至 0」
 *   是**已失效的承诺**（实测 doc-1790141547504 / doc-1790132484476 该 blocker 每轮残留）——现口径：
 *   两类覆盖缺口由**收编流程**（投影/分类器/登记表扩容，数据侧）收敛；正文侧唯一非破坏性收敛动作是
 *   按具名分项和还原分解（供修复轮消费，见 numericVerification 的候选提示）。unattributed 必须报出，
 *   不得以任何链尾改写「消掉」。
 *
 * 收编流程（防"以后还会遇到"的机制保证，非人肉白名单）：
 * - 无主项不被静默放过，而是每次生成系统性暴露、分类、收编；
 * - 新资源对象 → authorityIndex transform 扩容（P1 覆盖契约测试同步保护）；
 * - 新工艺参数 → 扩充 PROCESS_GAP_CONTEXT_RE（工艺库收编）或 C-T2 分类器规范常数族（R 系列）；
 * - 合法非权威值的固定形态（规范编号/法规年代等）→ 登记表 AUDIT_REGISTERED_TOKEN_RES（每条附理由）；
 * - 审计为纯确定性零 LLM，修复轮每次重算校验组后重跑（报告始终基于最新 finalMarkdown）。
 */
import { buildAuthorityIndex } from './authorityIndex';
import type { BlueprintData } from './integratedBlueprint';
import { extractNumericTokens } from './numericalConsistency';
import { classifyNumericTraceToken, normalizeQuantityZeros } from './documentFactTrace';
import { namedTotalClosure, TOTAL_CLAIM_PREFIX_RE, type NamedAuthorityValue } from './factReconciliation';
import type { ValidationIssue } from './types';

export interface AuthorityAuditFinding {
  /** 原文数值 token（与精确提取器同口径，如「58 人」「20420.39m³」） */
  token: string;
  /** 数值核心（token 首个数字串；与权威条目同口径比对） */
  value: string;
  /** 语境窗口（首现位置前后各 16 字，空白折叠）：分流判据与修复定位 */
  context: string;
  /** 全文出现次数（按 token 去重聚合；4.28.0 A6 边界严格口径，不计入更长数值内部子串） */
  occurrences: number;
  /** 合计闭包分项明细（仅 totalClaimClosed 桶：`名称 值 单位` 逐项，观测/验收定位用） */
  closure?: string[];
  /** 具名分项和候选（4.55.34 A；仅 derivation-gap / process-gap 两类覆盖缺口，**观测字段不改桶口径**）：
   * 该值恰为语境中具名权威分项之和（`名称 值 单位` 逐项）。存在候选 = 该值极可能是写手对权威分项的自算
   * 聚合（合法观测），其归宿是权威投影扩展或正文还原为具名分项+合计分解，**不是**改写/删除。
   * unattributed（疑似编造红线）不计算本字段：不得为红线值提供「可闭合」暗示。 */
  closureCandidates?: string[];
}

export type AuthorityAuditBucket = 'derivation-gap' | 'process-gap' | 'unattributed';

export interface AuthorityAuditReport {
  /** 去重后扫描到的数值 token 总数 */
  scanned: number;
  /** 命中权威索引（一致）的 token 数 */
  matched: number;
  /** 命中登记表（合法非权威值：规范编号/法规年代等）的 token 数 */
  registered: number;
  /** C-T2 分类器豁免数（规范常数/管理数字判定，与修复轮豁免口径单源）：合法数字，不计缺口不计未登记 */
  conventionExempt: number;
  /** 合计闭包收编（4.55.31 B2）：自称合计（合计/总量/小计…）且可由**具名权威分项**闭合的数值——
   * 合法自算合计（权威分项之和），不计缺口不计未登记；观测字段（分项明细见 finding.closure） */
  totalClaimClosed?: AuthorityAuditFinding[];
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
 * （胸径/地径/冠幅）；进度管理要素（工长/负责人/施工员/完成率/计划）；
 * 第四轮·4.27.0 终稿校准（A6）：路灯（套数）、苗木冠丛/蓬径、保勤人数。
 * r6 实机校准（无主数值审计 3 项）：配电箱基础高出地面（设备器材语境）收编。 */
const DERIVATION_GAP_CONTEXT_RE = /(?:劳动力|人力|用工|工人|民工|工种|普工|技工|管理人员|作业人员|人数|保勤|人员|班组|峰值|高峰|机械|机具|设备|车辆|台班|挖掘机|装载机|自卸|搅拌|塔吊|吊车|起重机|进度|工期|日历天|节点|阶段|开工|竣工|进场|退场|保养|维修|周转|材料|物资|水泥|砂石|碎石|钢筋|钢管|钢材|管材|灯具|路灯|电缆|光缆|通信|线缆|配线|配管|双绞|JDG|SC管|PC管|电源|电压|配电箱|照明|工作站|服务器|存储|工具|角磨|垫板|苗木|绿植|种植|养护期|保修|储备|堆放|供应|工程量|桩号|里程|K\d|管网|管道|胸径|地径|冠幅|冠丛|蓬径|工长|负责人|施工员|完成率|计划|拆除|人行道|侧石|缘石|杆件|砖基础|圈梁|构造柱|矩形柱|矩形梁|基础梁|过梁|有梁板|天沟|挑檐|雨篷|楼梯|散水|坡道|块料|墙面|吊顶|砌体|砖墙|多孔砖|实心砖|金属门|木质门|金属窗|百叶窗|百页窗|门窗|扶手|栏杆|桥架|管道基础|包管|压顶|独立基础|墙基|防潮层|给水|排水|空调|公厕|停车场|零星)/u;

/** ② 工艺库缺口语境（工艺·构造·验收参数）：命中即分流到收编清单·工艺库登记。
 * 收编记录（V5 P6 首轮真实文档暴露）：施工动作与构造/设备安装参数字类（开挖/敷设/距地/温度/垂直度等）归工艺语境。
 * 收编记录（第三轮·run1 三篇校准）：安全文明施工类（施工现场/场区/硬化/围挡/反光/封闭段/渣土）；
 * 专项试验与安装工艺（淋水/稳压/压力降/风速）；脚手架几何参数（纵距/横距/步距/立杆/连墙件）；
 * 第四轮·4.27.0 终稿校准（A6）：季节性作业与给水/泵送专业（降雨/雨量/PPR/冷水管/提升泵/扬程）。
 * r6 实机校准：避雷带支撑卡（防雷安装）、道路两侧预留宽度（构造几何）语境收编。 */
const PROCESS_GAP_CONTEXT_RE = /(?:混凝土|砼|砂浆|强度|等级|标号|配合比|坍落度|水灰比|掺量|养护|浇筑|振捣|模板|支架|脚手架|搭接|锚固|保护层|垫层|找平|找坡|坡度|防水|涂膜|卷材|闭水|蓄水|淋水|回填|夯实|压实|分层|虚铺|沟槽|基槽|基坑|边坡|标高|高程|厚度|间距|埋深|覆土|管径|PPR|冷水管|井室|抹灰|腻子|涂料|面层|基层|安装|提升泵|扬程|焊接|法兰|试压|冲洗|消毒|调试|接地|防雷|避雷|绝缘|电阻|验收|检验|检测|试验|取样|频率|焊缝|防腐|除锈|开挖|平整|清底|预留|土方|路床|碾压|摊铺|温度|降雨|雨量|接头|管枕|接口|承插|热熔|连接|封堵|距地|挂墙|挂装|嵌墙|暗配|明配|暗装|敷设|过桥|随桥|排管|人孔|通棒|内径|管孔|垂直度|偏差|漏风|通风|壁厚|接缝|遍数|密植|分叉|栽植|浇灌|试运转|严密性|渗水|牌号|材质|分辨率|图像|稳压|压力降|风速|纵距|横距|步距|立杆|连墙件|支撑卡|施工现场|场区|硬化|围挡|反光|封闭段|渣土)/u;

const AUDIT_CONTEXT_WINDOW = 16;

/** 语境窗口边界吸附（L0-7 收尾；doc-1790115927170 实机 blocker 根治）：按字符数截窗会把数字切半——
 * 目录行「…1.23 工伤保险与劳动保障\n 1.24 项目管理机构与岗位职责…」的 token「1.24 项」窗口左界落在
 * 「1.23」中间（截成「.23」），R17 同形邻号判据的前置数字边界断言因缺整数段不成立 → 真编号被判无主、
 * 进未登记桶直通硬门禁（假编造）。截断污染所有以 context 为输入的判据（分流桶 / R16 / R17 / C-T2 各族），
 * 故在构造处根治：左右边界各自向外吸附，直到不再紧邻数字/小数点——数字不得被切半。
 * 导出单源（4.55.34 A）：修复轮的自称合计豁免（numericVerification.selfDeclaredClosedTotalTokens）
 * 必须与本审计同窗口算法——窗口差一个字就可能让审计判「合法自算合计」而修复轮判「疑似无来源」，
 * 收敛压力随即落到删除动作上（丢信息），故窗口构造只此一处。 */
export function auditContextWindow(markdown: string, index: number, tokenLength: number, size = AUDIT_CONTEXT_WINDOW): string {
  let from = Math.max(0, index - size);
  let to = Math.min(markdown.length, index + tokenLength + size);
  while (from > 0 && /[\d.]/u.test(markdown[from - 1] ?? '')) from -= 1;
  while (to < markdown.length && /[\d.]/u.test(markdown[to] ?? '')) to += 1;
  return markdown.slice(from, to);
}

/** 合计闭包窗口（4.55.31 B2）：名称锚定需要比 16 字分流窗口更宽的语境——D4.5 合计句窗口同宽（±40 字）。
 * 实机：「防水工程按施工段划分检验批并做蓄水（淋水）试验（总量6403.78m²）」的归属名「防水」在
 * 数值前 31 字处，16 字窗口取不到，闭包分项（墙面涂膜防水/天棚涂膜防水）便无从锚定。
 * 导出单源（4.55.34）：修复轮的自称合计闭包豁免（numericVerification.selfDeclaredClosedTotalTokens）
 * 必须与本审计同窗口——窗口比本处更宽会把审计仍报缺口的数值从修复轮豁免出去（门禁残留）。 */
export const TOTAL_CLAIM_WINDOW = 40;

/** 合计闭包收编（4.55.31 B2）：自称合计（数值前紧邻合计/总量/小计…）的数值走具名分项和闭合判定
 * （factReconciliation.namedTotalClosure 单源：名称锚定 + 单位同族 + 恰为其和）。
 * 命中 = 该数值是权威分项的和（合法自算合计）→ 收编观测桶，不落三桶缺口、不计 unregistered。
 * 未自称合计的分项/单项数值不适用（单值溯源必须逐条命中权威核）——实机 424.2m 是系统级分项值
 * （语境「覆盖复合管350.6m、塑料管424.2m」无合计词），保持推导缺口不动。 */
function closureOverContext(markdown: string, index: number, token: string, value: string, values: readonly NamedAuthorityValue[]): NamedAuthorityValue[] | null {
  if (values.length === 0) return null;
  const unit = /^[\d,，.]+(.*)$/u.exec(token)?.[1]?.trim() ?? '';
  const context = auditContextWindow(markdown, index, token.length, TOTAL_CLAIM_WINDOW).replace(/\s+/gu, ' ');
  return namedTotalClosure({ total: Number(value), unit, context, values });
}

function totalClaimClosure(markdown: string, index: number, token: string, value: string, values: readonly NamedAuthorityValue[]): NamedAuthorityValue[] | null {
  const prefix = markdown.slice(Math.max(0, index - 24), index);
  if (!TOTAL_CLAIM_PREFIX_RE.test(prefix.replace(/\s+/gu, ' '))) return null;
  return closureOverContext(markdown, index, token, value, values);
}

/** 具名分项和候选（4.55.34 A；**观测/修复提示，不是豁免判据**）：与 B2 合计闭包**同判据同单源**
 * （namedTotalClosure：名称锚定 ≥2 字 + 单位同族 + 恰为其和），唯一差别是**不要求**「自称合计」前缀。
 * 为什么：不自称合计的聚合值（实机「覆盖复合管350.6m、塑料管424.2m」的 424.2m = 350.6 + 73.6）既可能
 * 是写手对权威分项的自算聚合（合法观测——其归宿是**权威投影扩展**，或正文按 D4.5 还原为具名分项+合计
 * 的分解表述），也可能是编造；报告此前只给一个裸 token，读者与修复轮都无法判断，于是修复轮唯一可执行
 * 的动作是删除（= 丢信息）。候选把「可闭合」这一事实显性化，桶口径与硬门禁**完全不改**：值仍在
 * derivation-gap/process-gap 桶内、仍进 blocker，只是多了一条可核的算术线索。
 * 只对两类**覆盖缺口**计算：unattributed（疑似编造红线）不计算——不得为红线值提供「看似可闭合」的
 * 台阶（任意权威值子集和不做名称锚定时命中率实测 60.77%，红线桶不能沾这条路径）。 */
function aggregateClosureCandidate(markdown: string, index: number, token: string, value: string, values: readonly NamedAuthorityValue[]): NamedAuthorityValue[] | null {
  return closureOverContext(markdown, index, token, value, values);
}

/** 补全提取（审计口径 = 扫描全部数值，必须比修复轮「宁漏勿错」更全）：
 * 共享提取器的 PRECISE_TOKEN_RE 以 \b 收尾，% / ℃ 等非词形单位后接标点时边界不成立而漏提
 * （「压实度 93%，」）；座/辆/根/处/盏/株/道/孔 等常用计量单位不在任何词表（「检查井 555 座」）；
 * d 龄期（「养护 7d」）与 Φ/φ 前导直径形（非 ASCII 字母不入共享提取器）同样补齐。
 * 量词单位（座/辆/…/d）限整数且前置非数字点：小数形态是目录/章节编号（「2.29 道…」），
 * 整数限位防「N.NX」拆出尾数误报；%/℃/人日/工日保留小数（率值/温度/工日口径）。
 * 层/栋/幢/户 等建筑规模单位暂不收录（「第 3 层」类相对位置形态噪声大于收益，待收编流程裁决）。 */
const AUDIT_SUPPLEMENT_TOKEN_RE = /(?:(?<![\d.])\d+\s*(?:座|辆|根|处|盏|株|道|孔|眼|樘|d(?![A-Za-z0-9]))|\d+(?:\.\d+)?\s*(?:%|℃|人日|工日)|(?:DN|Φ|φ|HRB|HPB)\s*\d+(?:\.\d+)?)/gu;

/** 边界严格首现定位（4.28.0 A6）：token 首现须落在独立数值边界上——裸 indexOf 会命中更长数值的内部子串
 * （「1.5m」首现落在「31.5mm」内、「5.5m」落在「3245.5m」内），语境窗口取到无关文本而误分流三桶；
 * 出现次数（split 计数）同口径失真。边界判据：前字符非 [\d.]、后字符非 [\dA-Za-z]，与 PRECISE_TOKEN_RE
 * 的 \b 提取口径对齐（²/³ 等上标非 ASCII 字母，仍视为合法尾界）；无严格出现时返回 -1。 */
function strictIndexOf(text: string, token: string, fromIndex = 0): number {
  for (let index = text.indexOf(token, fromIndex); index >= 0; index = text.indexOf(token, index + 1)) {
    const before = text.charAt(index - 1);
    const after = text.charAt(index + token.length);
    if (!/[\d.]/u.test(before) && !/[\dA-Za-z]/u.test(after)) return index;
  }
  return -1;
}

/** 边界严格出现次数（与 strictIndexOf 同口径；无严格出现时为 0） */
function countStrictOccurrences(text: string, token: string): number {
  let count = 0;
  for (let index = strictIndexOf(text, token); index >= 0; index = strictIndexOf(text, token, index + 1)) count += 1;
  return count;
}

/** 审计 token 提取：共享提取器 + 补全提取，严格边界首现位置随行（-1=幽灵 token，主循环过滤；
 * 提取形态与正文不一致时不得取裸 indexOf 假首现），按首现位置排序（报告可读性与测试确定性） */
function auditNumericTokens(markdown: string): Array<{ token: string; index: number }> {
  const positions = new Map<string, number>();
  const add = (raw: string) => {
    const token = raw.trim();
    if (!token || positions.has(token)) return;
    positions.set(token, strictIndexOf(markdown, token));
  };
  for (const token of extractNumericTokens(markdown)) add(token);
  for (const match of markdown.matchAll(AUDIT_SUPPLEMENT_TOKEN_RE)) add(match[0]);
  return [...positions.entries()].sort((left, right) => left[1] - right[1]).map(([token, index]) => ({ token, index }));
}

/** token 首现所在行是否为 Markdown 表格行（与 C-T2 scanNumericTrace 同判据：表格数值属计划分解数据） */
function isTableLineAt(markdown: string, index: number): boolean {
  const lineStart = markdown.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = markdown.indexOf('\n', index);
  const line = markdown.slice(lineStart, lineEnd < 0 ? markdown.length : lineEnd);
  return /^\s*\|/u.test(line.trim());
}

/** 具名值池（蓝图权威投影的「名称+值+单位」层）：合计闭包（4.55.31 B2）与 4.55.34 A 具名分项和候选
 * 共用；导出供修复轮（numericVerification 合计自称豁免）消费——两链同一份具名权威，判据不漂移。
 * 口径：条目级/明细级数值 + 名称 + 单位；**不含**规格与标签内嵌数字（C20/100W 之类不是数量口径）。 */
export function buildNamedAuthorityValues(data: BlueprintData): NamedAuthorityValue[] {
  const values: NamedAuthorityValue[] = [];
  for (const entry of buildAuthorityIndex(data).entries) {
    if (typeof entry.value === 'number' && Number.isFinite(entry.value)) {
      values.push({ name: entry.label, value: entry.value, unit: entry.unit, kind: 'entry' });
    }
    for (const group of entry.groups ?? []) {
      if (Number.isFinite(group.value)) values.push({ name: entry.label, value: group.value, unit: entry.unit, kind: 'group' });
    }
    // R20 规格-数量拆分（「100W 109套 + 120W 9套」小计）：写作层与权重链同源的合法值
    for (const split of entry.specBreakdown ?? []) {
      if (Number.isFinite(split.value)) values.push({ name: entry.label, value: split.value, unit: entry.unit, kind: 'split' });
    }
  }
  return values;
}

/** 权威投影（核匹配与合计闭包共用**一次**遍历，防两消费者口径漂移）：
 * - cores：数值核心集合——条目值 / 分工程明细 groups / 规格-数量拆分 specBreakdown / 规格与标签
 *   内嵌数字（如 C20、100W）。匹配按数值核心（忽略单位与大小写差异），尾零规约双侧归一
 *  （1.500 ↔ 1.5，与 normalizeQuantityZeros 单源）；与数值提取器的比对口径一致；
 * - values：具名值池（合计闭包输入，4.55.31 B2；4.55.34 起构造函数导出单源）。 */
function authorityProjection(data: BlueprintData): { cores: Set<string>; values: NamedAuthorityValue[] } {
  const cores = new Set<string>();
  const values = buildNamedAuthorityValues(data);
  const addCore = (raw: string) => {
    const trimmed = normalizeQuantityZeros(raw);
    if (trimmed) cores.add(trimmed);
  };
  for (const entry of buildAuthorityIndex(data).entries) {
    if (typeof entry.value === 'number' && Number.isFinite(entry.value)) addCore(String(entry.value));
    for (const text of [String(entry.value), entry.spec, entry.label]) {
      if (!text) continue;
      for (const core of text.match(/\d+(?:\.\d+)?/gu) ?? []) addCore(core);
    }
    for (const group of entry.groups ?? []) addCore(String(group.value));
    for (const split of entry.specBreakdown ?? []) addCore(String(split.value));
  }
  return { cores, values };
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

/** 生成后无主数值审计：扫描正文全部数值 token → 幽灵/表格/零值噪声过滤 → 登记表豁免 → 权威核匹配
 *（蓝图权威核 + 全源补充核，尾零规约双侧归一）→ C-T2 分类器豁免（规范常数/管理数字）→ 无主语境分流。
 * data 缺省（蓝图不可用）时全部未命中按语境分流（推导缺口语境即暴露投影层未接管）。
 * 4.28.0 A6：首现定位与出现次数按边界严格口径（防「1.5m 落在 31.5mm 内」类子串劫持语境与计数）。
 * F-T4 v2：extraAuthorityTokens 为会话全源数值 token（证据/清单锁/蓝图/事实主表；与修复轮
 * buildNumericAuthority 单源）——三桶任一非零即审计失败（authorityAuditIssues 硬门禁消费）。 */
export function auditAuthorityCoverage(markdown: string, data?: BlueprintData, extraAuthorityTokens?: ReadonlySet<string>): AuthorityAuditReport {
  // 单次权威投影：数值核集合（匹配）+ 具名值池（合计闭包，4.55.31 B2）——同一份权威，两消费者不漂移
  const projection = data ? authorityProjection(data) : undefined;
  const cores = projection?.cores ?? new Set<string>();
  const namedValues = projection?.values ?? [];
  // 全源补充核：token 级提取数值核心（尾零规约同口径）——防「来源在证据/清单而蓝图未投影」误报缺口
  if (extraAuthorityTokens) {
    for (const token of extraAuthorityTokens) {
      const core = /\d+(?:\.\d+)?/u.exec(token);
      if (core) cores.add(normalizeQuantityZeros(core[0]));
    }
  }
  const tokens = auditNumericTokens(markdown);
  const derivationGaps: AuthorityAuditFinding[] = [];
  const processGaps: AuthorityAuditFinding[] = [];
  const unattributed: AuthorityAuditFinding[] = [];
  const contextualMatches: AuthorityAuditFinding[] = [];
  const totalClaimClosed: AuthorityAuditFinding[] = [];
  let scanned = 0;
  let matched = 0;
  let registered = 0;
  let conventionExempt = 0;
  for (const { token, index } of tokens) {
    // 幽灵 token（严格边界无首现：提取形态与正文不一致）不进审计
    if (index < 0) continue;
    // 表格行数值（进度计划表/机械配置表等）属计划分解数据，不做溯源反查（与 C-T2 scanNumericTrace 同口径）
    if (isTableLineAt(markdown, index)) continue;
    // 零值核心（E0 类符号截断形态）：0 值不承载项目事实
    if (numericCore(token) === '0') continue;
    scanned += 1;
    // 登记表先于匹配：规范编号/法规年代的"数字"本就不属于项目数据（如 GB 50300-2013 的首数字串）
    if (AUDIT_REGISTERED_TOKEN_RES.some(item => item.re.test(token))) {
      registered += 1;
      continue;
    }
    const value = normalizeQuantityZeros(numericCore(token));
    const context = auditContextWindow(markdown, index, token.length).replace(/\s+/gu, ' ').trim();
    const finding: AuthorityAuditFinding = { token, value, context, occurrences: countStrictOccurrences(markdown, token) };
    if (cores.has(value)) {
      matched += 1;
      // 撞核藏值观测：值命中权威但语境属资源/工艺桶（如上例 1.5）——计入 matched 不变，单独可观测
      const matchBucket = classifyBucket(context);
      if (matchBucket !== 'unattributed') contextualMatches.push(finding);
      continue;
    }
    // 合计闭包收编（4.55.31 B2；在 C-T2 之前，使合法自算合计走具名分项观测桶而非混入规范常数豁免）
    const closure = totalClaimClosure(markdown, index, token, value, namedValues);
    if (closure) {
      totalClaimClosed.push({ ...finding, closure: closure.map(item => `${item.name} ${item.value}${item.unit}`) });
      continue;
    }
    // C-T2 分类器豁免（规范常数/管理数字：与修复轮同源判据，不落缺口不落未登记）
    if (classifyNumericTraceToken({ token, context }).kind !== 'unsourced') {
      conventionExempt += 1;
      continue;
    }
    const bucket = classifyBucket(context);
    if (bucket === 'unattributed') {
      // 疑似编造红线：不给「具名分项和候选」——见 aggregateClosureCandidate 注释（红线桶不沾凑数路径）
      unattributed.push(finding);
      continue;
    }
    // 覆盖缺口（推导/投影、工艺库）：附具名分项和候选（观测字段，不改桶与门禁口径）
    const candidates = aggregateClosureCandidate(markdown, index, token, value, namedValues);
    const gapFinding: AuthorityAuditFinding = candidates
      ? { ...finding, closureCandidates: candidates.map(item => `${item.name} ${item.value}${item.unit}`) }
      : finding;
    if (bucket === 'derivation-gap') derivationGaps.push(gapFinding);
    else processGaps.push(gapFinding);
  }
  return { scanned, matched, registered, conventionExempt, totalClaimClosed, derivationGaps, processGaps, unattributed, contextualMatches, unregisteredCount: unattributed.length };
}

/** 审计摘要单点文案（执行阶段 message 消费）。contextualMatches 为观测字段不计入摘要（matched 口径不变）；
 * totalClaimClosed（合计闭包，4.55.31 B2）同属观测口径——纳入摘要可核，但不计缺口不计未登记。
 * 覆盖缺口的处置文案是「扩权威投影/工艺库登记 + 正文可还原为具名分项分解」——**不是**「改定性」：
 * 链尾不存在删除/改定性收敛器（G 线 P2-2 停用），缺口只能由收编（数据侧）或非破坏性分解收敛。 */
export function authorityAuditSummary(report: AuthorityAuditReport): string {
  const base = `无主数值审计：扫描数值 ${report.scanned} 个（命中权威 ${report.matched}，登记豁免 ${report.registered}，规范/管理豁免 ${report.conventionExempt}，合计闭包 ${report.totalClaimClosed?.length ?? 0}，推导/投影缺口 ${report.derivationGaps.length}，工艺库缺口 ${report.processGaps.length}，未登记 ${report.unregisteredCount}）`;
  const candidateCount = [...report.derivationGaps, ...report.processGaps].filter(finding => (finding.closureCandidates?.length ?? 0) > 0).length;
  const candidateNote = candidateCount > 0 ? `（覆盖缺口中有 ${candidateCount} 项可由具名权威分项和闭合：属投影覆盖缺口，应扩投影或按分项还原，不得删除）` : '';
  if (report.unregisteredCount > 0) return `${base}；存在疑似编造数值，须核查${candidateNote}`;
  if (report.derivationGaps.length + report.processGaps.length > 0) return `${base}；存在收编缺口，须扩权威投影/工艺库登记（链尾不做删除式收敛）${candidateNote}`;
  return base;
}

/** 审计明细行（执行阶段 details 消费；未登记优先，其次两类收编缺口） */
export function authorityAuditDetails(report: AuthorityAuditReport, limit = 24): string[] {
  const rows = (label: string, findings: AuthorityAuditFinding[]) => findings.length === 0
    ? []
    : [label, ...findings.slice(0, limit).map(finding => {
      // 4.55.34 A：覆盖缺口行附具名分项和候选（「值 ＝ 分项 + 分项」）——收编/投影扩展与
      // 正文还原分解都据此进行，验收可核算术而非只看「疑似」字样
      const candidates = finding.closureCandidates ?? [];
      const candidateText = candidates.length > 0 ? `；可闭合：＝ ${candidates.join(' + ')}` : '';
      return `${finding.token}（×${finding.occurrences}）— ${finding.context}${candidateText}`;
    })];
  const lines = [
    ...rows('未登记（疑似编造，须核查或收编）：', report.unattributed),
    ...rows('推导器/投影覆盖缺口（进收编清单）：', report.derivationGaps),
    ...rows('工艺库缺口（进收编清单）：', report.processGaps),
    // 合计闭包行带分项明细（「总量6403.78m² ＝ 墙面涂膜防水 5764.81m2 + 天棚涂膜防水 638.97m2」），
    // 验收可逐项核对闭合关系而非只看计数字段
    ...(report.totalClaimClosed?.length
      ? ['合计闭包收编（权威分项和，不计缺口）：', ...report.totalClaimClosed.slice(0, limit)
        .map(finding => `${finding.token}（×${finding.occurrences}）＝ ${(finding.closure ?? []).join(' + ')} — ${finding.context}`)]
      : []),
  ];
  return lines.length > 0 ? lines : ['全部数值命中权威索引或登记表，无未登记项。'];
}

/**
 * F-T4 审计失败硬门禁检测器（AUXILIARY：由 recordAuthorityAudit 独立消费）：三桶（未登记·推导/投影
 * 缺口·工艺库缺口）任一非零即审计失败——blocker + category=fact_consistency + llm_repairable，
 * isHardExportBlockingIssue 直通硬阻断（审计失败不可进交付）。
 *
 * 收敛路径（4.55.34 A 口径复核，替换此前失效的「链尾 demote 确定性改定性」承诺）：
 * ① **覆盖缺口（推导/投影、工艺库）**——由**收编流程**收敛（新对象 → authorityIndex transform 扩容；
 *    新工艺参数 → PROCESS_GAP_CONTEXT_RE / C-T2 分类器族；合法固定形态 → AUDIT_REGISTERED_TOKEN_RES），
 *    属数据/配置侧动作；正文侧唯一非破坏性动作是按具名分项和还原为分项+合计分解（修复轮据
 *    finding.closureCandidates 提示执行）。**不得**以删除/改定性收敛（G 线 P2-2：那是把「缺权威值」
 *    从交付物里抹掉，与「要么 95+ 要么说清缺什么」的验收基准冲突）——链尾不存在该收敛器，且不恢复。
 * ② **未登记（疑似编造）**——必须报出、必须由写作侧改（回归资料原文/改为不带数值的表述），不得 demote。
 * 消息锚「无主数值审计失败」不得与既有「生成后事实反查失败」豁免规则（不硬阻断）混同。
 */
export function authorityAuditIssues(report: AuthorityAuditReport): ValidationIssue[] {
  const gapCount = report.derivationGaps.length + report.processGaps.length;
  if (report.unregisteredCount === 0 && gapCount === 0) return [];
  const tokenBrief = (findings: AuthorityAuditFinding[]) => findings.slice(0, 6).map(finding => finding.token.replace(/\s+/gu, '')).join('、');
  const sections: string[] = [];
  if (report.unregisteredCount > 0) sections.push(`疑似编造（未登记）${report.unregisteredCount} 项 ${tokenBrief(report.unattributed)}`);
  if (report.derivationGaps.length > 0) sections.push(`推导/投影缺口 ${report.derivationGaps.length} 项 ${tokenBrief(report.derivationGaps)}`);
  if (report.processGaps.length > 0) sections.push(`工艺库缺口 ${report.processGaps.length} 项 ${tokenBrief(report.processGaps)}`);
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `无主数值审计失败：${sections.join('；')}`,
    suggestion: '未登记数值（疑似编造）必须回归资料原文或改为不带具体数值的表述；推导/投影缺口数值应补权威投影（transform/specBreakdown/groups 扩容）——若该值可由具名权威分项和闭合（见审计明细「可闭合」），应在正文按分项显式还原为「分项名 值 + …，合计 值」的分解表述（还原后即由合计闭包收编）；工艺库缺口数值应补规范常数/管理数字分类（C-T2 分类器）或工艺库登记。**禁止以删除数值或改定性表述消除缺口**（链尾无删除式收敛器，理由见 authorityAudit 模块头）。修复后重跑生成复核清零。',
  }];
}
