import { getLocalSemanticProvider } from './semanticSimilarity';
import { longestCommonHanSubstringSpan } from './numericalConsistency';
import { MEASURE_UNIT_ALTERNATION, collapseObjectWindowEnd, collapseObjectWindowStart, findTruncationSource, hasTruncatedBracketFragment } from './factValueNoise';
import type { BillFactLock, BillFactLockEntry } from './billFactLock';
import type { BlueprintQuantity } from './integratedBlueprint';
import type { ValidationIssue } from './types';

/**
 * 参数概念口径冲突检测（C1）：把"同一参数概念的多口径矛盾"（如围挡高度 2.5m/1.8m、试压压力 1.5MPa/1.0MPa）
 * 从枚举参数名单迁移到"概念自组织聚类 + 同簇数值冲突"检测。
 *
 * 分层：L1 正则结构提取"数值+单位+概念语境"token（封闭集单位表）→ L3 本地 bge 对概念语境自组织聚类
 * （两两余弦 ≥0.6 合并为同簇，并查集）→ L2 同簇内显著不同数值判定冲突（差异 >2%，排除并列枚举）。
 * 零误伤原则：本地 bge 恒可用（本地 ONNX 推理）；嵌入数量不一致降级为显性 warning（跳检不硬停），
 * 嵌入调用异常由末期 detSafe 兜底降级；
 * 并列枚举（"600mm/800mm/1000mm 三种规格"）不判冲突。
 * V5 P6 误报收口（run1 实测，三防线）：①簇级倍数门——同一参数口径偏差不可能达 4 倍以上，
 * 超出必是跨对象 bge 误聚类（实测误报簇 4.84/6/11/13 倍全部收口，原 20 倍门有漏网）；
 * ②单位一致性——同簇跨单位数值不可互比（「2 处] vs「22 天」误聚根因）；
 * ③概念黑名单——对象计数类概念（自然村/标段/点位等）是对象枚举计数非参数多口径。
 */

/** r18 丰乐镇 B2 归因：单位交替补 m²/m³/㎡（原表只有 m，上标 ² 不可被 suffix 字符类消费而丢失——
 * 实测「工具式脚手架76.62m²」提取为 raw="…76.62m"（²截断）→ rawUnitOf 归一回 "m"，与清单条目
 * 单位 "m2" 不兼容 → 本可精确命中清单的两值坠入无锚冲突误报）；上标单位排 m 前防「m」先匹配截断。
 * 4.58 R5 ③：单位表改由判据单源模块 `factValueNoise.MEASURE_UNIT_ALTERNATION` 提供
 *（与「连接词左侧是否已有另一处取值」的判定同源），不在本地再手抄一份。 */
const PARAM_TOKEN_RE = new RegExp(String.raw`([\u4e00-\u9fa5A-Za-z0-9（）()]{1,12}?)(\d+(?:\.\d+)?)\s*(${MEASURE_UNIT_ALTERNATION})([\u4e00-\u9fa5A-Za-z0-9（）()]{0,8})`, 'gu');

/** 纯通用量词表：概念归一化后仅为量词本身（无具体对象）时退出聚类——
 * 不同对象的「直径22mm」「直径48.3mm」（锚杆 vs 钢管）同词形不同对象，聚同簇必误报（合肥师范实测）。
 * r14 丰乐镇 B2 扩表（终栓 parameter-concept-conflict 误报阻断）：「排水管道采用塑料管材，总长8205.53m」
 * 的 concept=「总长」（逗号截断无对象前缀）与「砌筑渠道总长4800m」的 concept=「砌筑渠道总长」bge 误聚
 * 同簇——光杆总量词无从判定口径归属（不同对象各自总长），跳过；带对象的「砌筑渠道总长」仍参与聚类。 */
const GENERIC_MEASURE_WORDS = [
  '直径', '厚度', '宽度', '长度', '高度', '深度', '间距', '距离', '标高', '偏差',
  '数量', '面积', '体积', '重量', '压力', '温度', '强度', '等级', '坡度', '规格',
  '尺寸', '层数', '次数', '跨度', '半径', '总长', '全长',
] as const;

/** 纯边界虚词概念表（4.52 P3a 归因）：概念归一后仅为区间虚词（「以内」「以上」类）时退出聚类——
 * 「±」公差符号不在前缀字符类内，数字前导经 trailingDigits 并回后前缀坍缩为空，concept 只剩
 * 虚词（实测「槽底标高偏差控制在±20mm以内」×「管底垫层顶面标高偏差控制在±10mm以内」坍缩同簇
 * 误报多口径）；公差标注按对象天然多口径并存，概念信息不足时不参与互斥。 */
const BARE_RELATION_WORDS = ['以内', '以外', '以上', '以下', '之间', '左右', '以前', '以后', '之前', '之后'] as const;

/** 概念引导语剥离白名单（r15 丰乐镇 B1 归因）：正文工程量列举常用「主要作业对象为X」句式，
 * 跨对象 token 共享同一引导语形态时被 bge 误聚同簇——实测「主要作业对象为塑料管铺设」
 * ×「主要作业对象为菜园围栏」余弦 0.687 ≥0.6（同簇 8205.53 vs 2360 误报口径冲突），
 * 剥离引导语后「塑料管铺设」×「菜园围栏」余弦 0.4x 不聚簇；同对象「塑料管铺设总量」
 * ×「塑料管铺设」保持聚簇（值相同无冲突）。剥离后概念不足 2 字回退原概念（宁保留可判形态）。 */
const CONCEPT_LEAD_IN_RE = /^(?:主要|本工程|本项目|全项目)?(?:作业对象|作业内容|施工内容|工作内容|工程内容|施工对象|施工范围|工程规模|建设内容|建设规模)为/u;

/** 任务时限管理模板框架剥离（r16 丰乐镇 B2 归因；r18 扩围）：「由责任班组在7日内完成修复」与「由责任
 * 岗位在2日内完成补录或纠正」是不同责任主体/任务各自的时限，共享「由责任X在内完成」框架致 bge 误聚
 * 同簇（实测余弦 0.755 ≥0.6，7 vs 2 假口径冲突）——剥离框架后「修复」×「补录或纠正」余弦 0.583 不
 * 聚簇；同主体同任务的真冲突（「修复7日 vs 修复2日」）剥离后仍聚簇，不因此放行。
 * r18 丰乐镇 B2 扩围：「责任施工员在5日内完成修复」类句式无「由」前缀实测同样与同类框架句误聚（修复/
 * 整改/组织施工为不同任务、责任施工员/责任材料员为不同主体），「由」改可选。 */
const CONCEPT_TASK_DEADLINE_RE = /^(?:由)?责任[\u4e00-\u9fa5]{0,4}在(?:内)?完成/u;

/** 概念黑名单（run1 实测误报收口）：对象计数类概念——「13 个自然村 / 1 个标段 / 2 处踏勘点位」
 * 是对象的枚举计数而非同一参数的多口径取值，跨对象 bge 误聚簇时数字天然异构（13 vs 1）；
 * 此类数字一致性由跨章/审计通道把关，不参与参数口径互斥（「养护」类时长按对象天然多口径同）。
 * r23 扩围（r22 实况）：「马老郢组800m、夏岗组250m」类分组单元名（村组/作业组/班组等
 * 「X组」结尾）同为对象分组概念——各分组量值天然异构，同样不参与互斥。
 * r28m M24a F1 扩围（s28k/s28l 实机）：单体属性概念（「地上2层、地上1层」「门卫建筑高度3m」）——
 * 不同单体（门卫/配套用房）的层数/高度天然不同，无清单条目可裁决，参与互斥必误报。 */
const CONCEPT_BLACKLIST_RE = /自然村|村组|标段|区域|点位|养护|地上|地下|建筑高度|[\u4e00-\u9fa5]{1,4}组$/u;

/** 变体限定词（r28m M24a F2 退聚；r28k/s28k 实机「局部8cm/10cm」）：「局部/个别/少数/多数/大部分」
 * 限定的数值是子集/局部口径（「厚度10cm，局部厚度8cm」为合法子集声明），与整体口径不可互斥；
 * 带限定词的 token 不进互斥池（宁漏勿错——同限定词的多处真冲突由跨章/审计通道把关）。 */
const VARIANT_QUALIFIER_RE = /^(?:局部|个别|少数|多数|大部分)/u;

/** 动作词表（丰乐镇复测 #82 簇 A/B）：同簇各 token 原文分别含互不相同的施工/管理动作词
 * （「签订 vs 提交」「开挖 vs 封闭」）时，是不同工序各自的动作参量而非同一参数多口径——
 * bge 概念相似度会把「合同签订后…日内」与「资料提交…日内」误聚同簇，数字差异必误报。 */
const CONCEPT_ACTION_WORDS = ['开挖', '封闭', '回填', '浇筑', '铺筑', '摊铺', '供应', '编制', '提交', '签订', '安装', '养护', '试验', '拆除', '砌筑'] as const;

/** 几何维度词表（r6 实机 #6 根因）：同簇 token 命中的几何维度各不相同（树穴「直径比土球大40cm」
 * vs「深度比土球高20cm」、穴径 vs 穴深、胸径 vs 冠幅）时，是不同维度的规格并列声明而非同一参数
 * 多口径冲突——bge 概念相似度高但数值分属不同维度。仅当全部 token 均命中维度词且 ≥2 种维度时
 * 按维度隔离判定（存在无维度词 token 时维持原簇整体判定，防真冲突被误放行）。 */
const CONCEPT_DIMENSION_WORDS = ['直径', '半径', '穴径', '胸径', '地径', '冠幅', '厚度', '宽度', '长度', '高度', '深度', '穴深', '间距', '距离', '标高', '坡度', '跨度', '株距', '行距'] as const;

/** 概念归一化：去除单位词与标点后仅保留概念词面 */
function normalizeConcept(concept: string): string {
  return concept
    .replace(/(?:mm|cm|m|MPa|kN|kV|kW|℃|元|万元|人|天|日|个|层|樘|处|套|台|t|吨)/gu, '')
    .replace(/[\s,，、；;：:（）()]/gu, '');
}

/** 并列链成员是否**异名**（与 token 概念互不包含，经归一化）：异名成员各自带数值 = 分对象列举，
 *  同名成员（含互为包含，如「钢柱」vs「钢柱基础」）仍是同一参数的重复取值。 */
function enumerationMemberIsDistinct(member: string, concept: string): boolean {
  const name = normalizeConcept(member);
  const target = normalizeConcept(concept);
  if (name.length === 0 || target.length === 0) return false;
  return !name.includes(target) && !target.includes(name);
}

/** 枚举窗口内是否出现「顿号/斜杠 + 成员名 + 数值」的并列成员（成员名可省略 = 匿名成员）：
 *  匿名成员（「厚15cm、8cm」的「、8」）与**异名成员**（「钢柱1228.24t、钢梁1591.306t」的「、钢梁1591」）
 *  两形态都算——异名成员是另一个对象各自的量，不是本 token 的重复取值。 */
function enumeratedMemberIn(window: string, concept: string): boolean {
  if (/[、/](?:与)?[A-Za-z]?\d/u.test(window)) return true;
  for (const match of window.matchAll(/[、/](?:与|和|及)?([\p{Script=Han}A-Za-z]{1,8})\d/gu)) {
    if (enumerationMemberIsDistinct(match[1] || '', concept)) return true;
  }
  return false;
}

function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index];
  return sum;
}

/** 出现位所在句文本（r18 B2 总量分解句豁免）：向前/后扩至句界（。；; 换行），无边界时取到文首/文尾 */
function sentenceTextAt(markdown: string, index: number): string {
  const marks = ['。', '；', ';', '\n'] as const;
  let start = 0;
  for (const mark of marks) {
    const at = markdown.lastIndexOf(mark, index - 1);
    if (at + 1 > start) start = at + 1;
  }
  let end = markdown.length;
  for (const mark of marks) {
    const at = markdown.indexOf(mark, index);
    if (at >= 0 && at < end) end = at;
  }
  return markdown.slice(start, end);
}

interface ParamToken {
  concept: string; value: number; unit: string; raw: string;
  /** 该 token 的全部文本出现（4.27.0 A1 硬替换逐处定位）：match 绝对起址 + 值文本组内偏移 + 值原文 */
  occurrences: Array<{ matchIndex: number; valueOffset: number; valueText: string }>;
}

/** 值文本在完整匹配内的偏移定位（prefix 字符类可含数字，「3号塑料管3m」类 indexOf 会误中前缀数字）：
 * 优先从单位反向回溯（数字与单位紧邻、允许空白），失败回退首个同文本命中 */
function locateValueOffset(matchText: string, valueText: string, unitText: string): number {
  if (!unitText) return matchText.indexOf(valueText);
  const unitAt = matchText.lastIndexOf(unitText);
  if (unitAt >= 0) {
    const direct = unitAt - valueText.length;
    if (direct >= 0 && matchText.slice(direct, unitAt) === valueText) return direct;
    const loose = new RegExp(`(${valueText.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')})\\s*$`, 'u').exec(matchText.slice(0, unitAt));
    if (loose && loose.index !== undefined) return loose.index;
  }
  return matchText.indexOf(valueText);
}

function extractParamTokens(markdown: string): ParamToken[] {
  const tokenByRaw = new Map<string, ParamToken>();
  // 剔除表格行与标题行，只检正文句（表格内同概念多规格属正常枚举，不在矛盾检测范围）
  let lineStart = 0;
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    const currentLineStart = lineStart;
    lineStart += line.length + 1;
    if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) continue;
    for (const match of line.matchAll(new RegExp(PARAM_TOKEN_RE.source, 'gu'))) {
      let prefix = (match[1] || '').trim();
      let valueText = match[2];
      // r18 丰乐镇 B2 归因（15cm 截断）：前缀字符类含数字且惰性匹配，「、15cm厚C30水泥混凝土」类句首
      // 数值被拆为前缀「1」+值「5」（面层厚度 15cm 误生 5cm 假口径冲突）——前缀尾随数字与数值粘连时
      // 并回值文本，概念前缀同步回退（raw 仍为原文，locateValueOffset 按并后值文本定位）
      const trailingDigits = /\d+$/u.exec(prefix);
      if (trailingDigits) {
        prefix = prefix.slice(0, trailingDigits.index).trim();
        valueText = `${trailingDigits[0]}${valueText}`;
      }
      // C8-7（r28m' 组7 实锤）：「开工日期为2026年9月24日」被 token 化为 prefix「…2026年9月」+
      // 值 24 + 单位「日」——日期的「日值」进入工程参数口径池，经 bge 桥接与「计划工期90日历天」
      // 聚簇误报多口径冲突（月份日期是时间锚非工程参数口径，正样本零冲突被误判）。值前紧邻「月」
      // 字的 token 整体退出池；真工期/天值表述（「90日历天」「30天」）前缀不含「月」字照常参与，
      // 真冲突（90 vs 60 日历天）仍照报（零放松）。
      if (/月\s*$/u.test(prefix)) continue;
      const value = Number(valueText);
      const unit = match[3] || '';
      /**
       * 4.58 R5 ③ 对象名窗口收拢（判据单源 `factValueNoise.collapseObjectWindow*`）。
       *
       * 定宽窗口（前缀 ≤12 字、后缀 ≤8 字）在含规格编号的对象名上必然切错：实测
       * `粗粒式沥青混凝土(AC-25C)6cm厚与细粒式改性沥青混凝土面层(AC-13C)4cm厚各13898.51m²`
       * 抽成 `25C)厚与细粒式改性沥` 与 `13C)厚各13898` 两个**残片**——前者丢掉了整个对象名
       * 「粗粒式沥青混凝土」（`AC-` 的连字符不在字符类内，匹配只能从 `25C)` 起），
       * 后者把下一处的「细粒式…」粘了进来；两个不同对象（粗粒式 AC-25C 6cm / 细粒式 AC-13C 4cm）
       * 因此被当成"同一概念"，数值 6/4 自然"冲突"。
       *
       * 收拢只作用于**对象名**：`raw`、`occurrences`（值定位）仍由正则组给出，
       * 「检测定位 = 修复定位」不变量与硬替换路径（numericConflictArbiter）逐处定位均不受影响。
       */
      const matchStart = match.index || 0;
      const windowStart = collapseObjectWindowStart(line, matchStart);
      const objectWindow = line.slice(windowStart, collapseObjectWindowEnd(line, matchStart + match[0].length, windowStart));
      // 值文本在收拢窗口内的偏移：由正则组精确给出（前缀字符类不含空白，trim 不改偏移）
      const valueOffsetInWindow = matchStart - windowStart + (match[1] || '').length - (trailingDigits ? trailingDigits[0].length : 0);
      const afterValue = objectWindow.slice(valueOffsetInWindow + valueText.length);
      // 值与单位之间正则只允许空白（`\s*`），>2 字的间隔说明匹配错位，此时整段按后缀处理（宁可多留语境）
      const unitAt = afterValue.indexOf(unit);
      const windowSuffix = unitAt >= 0 && unitAt <= 2 ? afterValue.slice(unitAt + unit.length) : afterValue;
      // r28f B2 归因（r28e 实测）：「健身器材17个与石桌石凳8个基础采用…」的后缀把相邻枚举项
      // 连同其数值吞入本 token（concept=「健身器材与石桌石凳8个基」）→ bge 桥接聚类把健身器材
      // （17个）与石桌石凳（8个）误聚同簇误报多口径——后缀在「连接词（与/和/及）+数字」处截断：
      // 该段是下一枚举项（自带数值）的开头，不是本值的对象语境；连接词后无数字的语境
      // 后缀（「…与石桌石凳基础采用」）保留，避免误削概念信息。
      // 4.58 R5 ③ 跨度放宽 12→24：窗口收拢后连接词与下一个数值之间隔着完整对象名 + 规格编号
      //（「与细粒式改性沥青混凝土面层(AC-13C)4cm」= 17 字），12 字量不到便会把下一对象粘进本项。
      const embeddedItem = /[与和及][^与和及]{0,24}?\d/u.exec(windowSuffix);
      const suffix = embeddedItem ? windowSuffix.slice(0, embeddedItem.index) : windowSuffix;
      // 概念语境 = 数值前后短语去空白；语境过短（纯标点/无概念词）不参与聚类
      const rawConcept = `${objectWindow.slice(0, valueOffsetInWindow)}${suffix}`.replace(/[\s,，、；;：:]/gu, '');
      // r15 B1 归因：剥离「主要作业对象为」类引导语后再聚类（防跨对象共享引导语误聚，见 CONCEPT_LEAD_IN_RE）；
      // r16 B2 归因：同源剥离「由责任X在内完成」任务时限管理模板框架（见 CONCEPT_TASK_DEADLINE_RE）
      const strippedConcept = rawConcept.replace(CONCEPT_LEAD_IN_RE, '').replace(CONCEPT_TASK_DEADLINE_RE, '');
      const concept = strippedConcept.length >= 2 ? strippedConcept : rawConcept;
      if (concept.length < 2 || !/[\u4e00-\u9fa5A-Za-z]{2,}/u.test(concept) || !Number.isFinite(value) || value <= 0) continue;
      // 纯通用量词概念跳过：无具体对象无从判定口径，不同对象同量词聚簇必误报。
      // C8 S4-①a 归因（s28m' 实测「层数2层、层数1层」两单体误报阻断）：normalizeConcept 的单位
      // 剥离表含「层」——「层数」归一后被剥成「数」，与量词表登记形态失配恒 false；原词面直比
      // 前置消解（「层数」直比命中即跳过），其余概念仍走归一后比较。
      if (GENERIC_MEASURE_WORDS.some(word => concept === word || normalizeConcept(concept) === word)) continue;
      // 纯边界虚词概念跳过（4.52 P3a）：公差符号打断前缀致 concept 坍缩为「以内」类虚词时
      // 概念信息不足，不参与口径互斥（见 BARE_RELATION_WORDS）
      if (BARE_RELATION_WORDS.some(word => normalizeConcept(concept) === word)) continue;
      // 对象计数类概念跳过（非参数口径，见 CONCEPT_BLACKLIST_RE）
      if (CONCEPT_BLACKLIST_RE.test(concept)) continue;
      // 变体限定词退聚（r28m M24a F2）：带「局部/个别/少数/多数/大部分」限定词的子集口径不参与互斥
      if (VARIANT_QUALIFIER_RE.test(concept)) continue;
      /**
       * 4.58 R5 ③-b 残片兜底（**降级可见，不静默**）：窗口收拢**修不好**的残片——对象名里仍有
       * 未配对闭括号（如 `AC-25C)6cm`：源文本本身缺开括号），说明它仍是某个括号组被切断的尾巴
       *（`25C)` ← `(AC-25C)`）。残片没有独立对象身份，其数值与任何口径都不可互比 ⇒ 退出聚类，
       * 并由**包含关系判定**指名截断源（`findTruncationSource`：同一行里包含它的完整括号组）
       * 写进可见记录，供人工复核源文本。
       */
      if (hasTruncatedBracketFragment(objectWindow)) {
        const truncationSource = findTruncationSource(line, objectWindow);
        console.warn(`[gen] parameter-concept-conflict 残片跳过：对象名窗口「${objectWindow.trim()}」${truncationSource ? `是「${truncationSource}」的截断` : '含未配对闭括号且本行找不到截断源'}，数值 ${valueText}${unit} 不参与口径互斥`);
        continue;
      }
      // 同一表述的全部出现合并为 occurrences（4.27.0 A1）：判定仍按「同 raw 只算一个口径」去重，
      // 但硬替换须逐处定位全部出现位置——历史缺陷：同值多处出现只改首处的替换残留
      const occurrence = {
        matchIndex: currentLineStart + (match.index || 0),
        valueOffset: locateValueOffset(match[0], valueText, match[3] || ''),
        valueText,
      };
      const existing = tokenByRaw.get(match[0]);
      if (existing) {
        existing.occurrences.push(occurrence);
        continue;
      }
      tokenByRaw.set(match[0], { concept, value, unit, raw: match[0], occurrences: [occurrence] });
    }
  }
  // 去重：同 raw 合并为单 token（同一表述重复出现不算冲突），限额 60
  return [...tokenByRaw.values()].slice(0, 60);
}

/** 并查集：两两语义相似 ≥0.6 的概念合并为同簇（自组织聚类） */
function clusterConcepts(concepts: string[], similarity: (left: string, right: string) => number): Map<string, string> {
  const parent = new Map(concepts.map(concept => [concept, concept]));
  const find = (node: string): string => {
    const root = parent.get(node) || node;
    return root === node ? node : (parent.set(node, find(root)), parent.get(node) || node);
  };
  const union = (left: string, right: string) => { parent.set(find(left), find(right)); };
  for (let left = 0; left < concepts.length; left += 1) {
    for (let right = left + 1; right < concepts.length; right += 1) {
      if (similarity(concepts[left], concepts[right]) >= 0.6) union(concepts[left], concepts[right]);
    }
  }
  return parent;
}

/** 冲突组内的单一口径值（同概念同单位的全部出现记录） */
export interface ConceptConflictValue {
  concept: string;
  value: number;
  unit: string;
  raw: string;
  occurrences: Array<{ matchIndex: number; valueOffset: number; valueText: string }>;
}

/** 参数概念冲突组（同簇同单位下 ≥2 个显著不同值）：检测 message 与 A1 裁决器共用的结构化载体 */
export interface ConceptConflictGroup {
  /** 组代表概念（首个值 token 的概念，与历史 message 口径一致） */
  concept: string;
  values: ConceptConflictValue[];
}

/** 冲突组扫描结果：degraded 为嵌入降级（不 throw，调用方显性呈现） */
export interface ConceptConflictScan {
  groups: ConceptConflictGroup[];
  degraded?: ValidationIssue;
}

/**
 * 冲突组扫描（4.27.0 从 parameterConceptConflictIssues 抽出，行为保持）：
 * L1 正则提取 → bge 概念自组织聚类 → 同簇同单位显著差异判定，返回结构化冲突组。
 * 检测端（message 生成）与 A1 裁决器（三分支替换/降级）共用同一扫描口径（检测定位=修复定位）。
 */
export async function conceptConflictGroups(markdown: string): Promise<ConceptConflictScan> {
  const tokens = extractParamTokens(markdown);
  // 至少需要 3 个概念 token 才有聚类价值；不足时静默跳过（零误伤：样本不足不判）
  if (tokens.length < 3) return { groups: [] };
  const concepts = [...new Set(tokens.map(token => token.concept))];
  if (concepts.length < 2) return { groups: [] };
  const vectors = await getLocalSemanticProvider().embedDocuments(concepts);
  if (vectors.length !== concepts.length) {
    // 嵌入数量不一致降级（finalize 末期硬停治理）：检测器内部基础设施异常不再 throw 穿透任务层；
    // 以显性 warning 呈现（可观测/可复核/可重跑），本检测器本轮跳过判定（失败即暴露，不静默）
    const detail = `本地语义模型嵌入数量不一致：期望 ${concepts.length} 条，实际 ${vectors.length} 条`;
    console.warn(`[gen] parameter-concept-conflict degraded: ${detail}`);
    return {
      groups: [],
      degraded: {
        level: 'warning',
        severity: 'warning',
        category: 'format',
        owner: 'system',
        repairability: 'manual_review',
        message: `参数概念口径冲突检测已降级跳过：${detail}`,
        suggestion: '语义模型输出异常，本轮未执行该检测维度；可稍后重新生成复核。',
      },
    };
  }
  const vectorOf = new Map(concepts.map((concept, index) => [concept, vectors[index]]));
  const similarity = (left: string, right: string) => {
    const leftVector = vectorOf.get(left);
    const rightVector = vectorOf.get(right);
    if (!leftVector || !rightVector || leftVector.length === 0 || rightVector.length === 0) return 0;
    return dot(leftVector, rightVector);
  };
  const parent = clusterConcepts(concepts, similarity);
  const find = (node: string): string => {
    let current = node;
    while ((parent.get(current) || current) !== current) current = parent.get(current) || current;
    return current;
  };
  // 按簇聚合 token
  const clusters = new Map<string, ParamToken[]>();
  for (const token of tokens) {
    const root = find(token.concept);
    const group = clusters.get(root) || [];
    group.push(token);
    clusters.set(root, group);
  }
  const groups: ConceptConflictGroup[] = [];
  for (const group of clusters.values()) {
    if (group.length < 2) continue;
    // 簇级倍数门（>4 倍整簇跳过）：同一参数口径偏差不可能达 4 倍以上，超出必是跨对象 bge
    // 误聚类——run1 实测误报簇 4.84/6/11/13 倍全部收口（原 >20 倍门对「13 个自然村 vs
    // 1 个标段」类跨对象计数聚簇有漏网），整簇跳过不再细分。
    const groupMax = Math.max(...group.map(token => token.value));
    const groupMin = Math.min(...group.map(token => token.value));
    if (groupMax > groupMin * 4) continue;
    // 单位一致性（run1 实测误报收口）：同簇不同单位的数值不可互比（bge 把「踏勘点位不少于
    // 2 处」与「驻场每月不少于 22 天」误聚同簇）——按单位分组后仅同单位组内 ≥2 个显著差异值才判冲突
    const byUnit = new Map<string, ParamToken[]>();
    for (const token of group) {
      const unitGroup = byUnit.get(token.unit) || [];
      unitGroup.push(token);
      byUnit.set(token.unit, unitGroup);
    }
    for (const unitGroupAll of byUnit.values()) {
      if (unitGroupAll.length < 2) continue;
      // 几何维度隔离（r6 实机 #6 根因）：同簇 token 命中的几何维度互不相同时（树穴「直径比土球大40cm」
      // vs「深度比土球高20cm」、穴径 vs 穴深），是不同维度的规格并列声明而非同参数多口径——
      // 全部 token 均命中维度词且 ≥2 种时按维度词再分组，各维度组内独立判定（单 token 组自然跳过）；
      // 存在无维度词 token 时维持原簇整体判定（防真冲突被维度隔离误放行）
      const byDimension = new Map<string, ParamToken[]>();
      for (const token of unitGroupAll) {
        const dimension = CONCEPT_DIMENSION_WORDS.find(word => token.raw.includes(word)) || '';
        const bucket = byDimension.get(dimension) || [];
        bucket.push(token);
        byDimension.set(dimension, bucket);
      }
      const distinctDimensions = [...byDimension.keys()].filter(key => key !== '');
      const unitGroups = distinctDimensions.length >= 2 && !byDimension.has('')
        ? [...byDimension.values()]
        : [unitGroupAll];
      for (const unitGroup of unitGroups) {
        if (unitGroup.length < 2) continue;
        // 动作词差异豁免（4.32.0 丰乐镇复测 #82 簇 A/B）：同簇各 token 原文含互不相同的施工/管理
        // 动作词时（「签订 vs 提交」「开挖 vs 封闭」），是不同工序各自的参量而非同参数多口径，跳过
        const actions = unitGroup.map(token => CONCEPT_ACTION_WORDS.find(word => token.raw.includes(word)) || '');
        if (actions.length >= 2 && actions.every(action => action !== '') && new Set(actions).size === actions.length) continue;
        // 实例序号差异豁免（r16 丰乐镇 B2 归因）：「景墙一4m、景墙二12.2m」是同类构件的两个实例各自的
        // 尺寸，bge 因主干词「景墙」误聚同簇（余弦 0.866）——同组全部 token 均可拆「主干+尾序号」且
        // 主干全同、序号两两不同时属并列实例（非同参数多口径），跳过；主干 ≥2 字防过短主干误放行
        const instanceParts = unitGroup.map(token => /^([\u4e00-\u9fa5]{2,})([一二三四五六七八九十]|\d+)$/u.exec(token.concept));
        const instanceMatches = instanceParts.filter((match): match is RegExpExecArray => match !== null);
        if (instanceMatches.length === unitGroup.length && instanceMatches.length >= 2
          && new Set(instanceMatches.map(match => match[1])).size === 1
          && new Set(instanceMatches.map(match => match[2])).size === instanceMatches.length) continue;
        // 「按每」频率基数豁免（r14 丰乐镇 E14 归因）：「质检员按每100m³留样」与「闭水试验按每200m
        // 一段」是不同任务各自的频率基数，bge 因共同词「按每」误聚同簇（「质检员按每」≈「管道闭水
        // 试验按每」≈「按每」，余弦超阈）；同簇全部 token 均为「按每」类且各 token「按每」前的
        // 主体词面两两互不包含（含空主体=无主体句）时，属不同任务的频率参数（非同参数多口径），
        // 跳过；同一主体的多口径（「质检员按每100m³」vs「质检员按每200m³」或主体互为包含的
        // 「管道闭水试验」vs「闭水试验」）仍判冲突
        const perEveryBases = unitGroup.map(token => {
          const at = token.raw.indexOf('按每');
          return at >= 0 ? token.raw.slice(0, at) : null;
        });
        if (perEveryBases.every((basis): basis is string => basis !== null)) {
          const relatedSubject = perEveryBases.some((left, leftIndex) => Boolean(left) && perEveryBases.some((right, rightIndex) => leftIndex !== rightIndex && Boolean(right) && (left === right || left.includes(right) || right.includes(left))));
          if (!relatedSubject) continue;
        }
        // 合同阶梯豁免（4.31 丰乐镇 v6 #65）：同簇各值均处合同条款阶梯语境时（「逾期超过28日后…
        // 自第29日起提高至万分之五；逾期超过56日后…单方解除合同」逐档提高的违约责任阶梯），
        // 各档数值并存合法非口径冲突；窗口取出现位 -30 到 +raw.length+40，词面含违约金/解除合同/
        // 提高至/自第/逾期超过之一；every 校验——任一口径不在阶梯语境即不豁免
        const allInLadder = unitGroup.every(token => token.occurrences.some(occurrence => /违约金|解除合同|提高至|自第|逾期超过/u.test(
          markdown.slice(Math.max(0, occurrence.matchIndex - 30), occurrence.matchIndex + token.raw.length + 40),
        )));
        if (allInLadder) continue;
        const values = [...new Set(unitGroup.map(token => token.value))];
        if (values.length < 2) continue;
        const maxValue = Math.max(...values);
        const minValue = Math.min(...values);
        // 差异 >2% 才算显著冲突；同簇同值多表述不算
        if (maxValue - minValue <= maxValue * 0.02) continue;
        // 总量分解句豁免（r18 丰乐镇 B2 归因）：「仿木护栏总量333m，其中景观工程部位安装228m，
        // 环境整治工程部位安装105m」——总量与分项是相加分解关系（333=228+105，均为清单真实值），
        // 非同一参数多口径冲突。判定三条件：①组内每个值至少一处出现落在同一句；②该句同时含
        // 总量引导词（总量/合计/总计/共计）与分解标记（其中/分别为/分为）；③句内存在数值≈组内
        // 各值之和（1% 容差）——真冲突（「围挡2.5m 其中局部1.8m」类无总量词或无和值关系）不受豁免
        const valuesSum = values.reduce((sum, value) => sum + value, 0);
        const occurrenceSentences = [...new Set(unitGroup.flatMap(token => token.occurrences.map(occurrence => sentenceTextAt(markdown, occurrence.matchIndex))))];
        const inDecompositionSentence = occurrenceSentences.some(sentence =>
          /(?:总量|合计|总计|共计)/u.test(sentence) && /(?:其中|分别为|分为)/u.test(sentence)
          && unitGroup.every(token => token.occurrences.some(occurrence => sentenceTextAt(markdown, occurrence.matchIndex) === sentence))
          && [...sentence.matchAll(/\d+(?:\.\d+)?/gu)].some(match => Math.abs(Number(match[0]) - valuesSum) <= Math.max(0.5, valuesSum * 0.01)));
        if (inDecompositionSentence) continue;
        // 排除并列枚举：任一 token 的出现位前/后 12 字内含「、/ + 数字」枚举链（如「10cm、8cm」
        // 匹配「、8」；「厚15cm、C30」匹配「、C30」）≥2 个即属多规格枚举声明——修复 4.32.0：
        // 原检查针对 token.raw 而 PARAM_TOKEN_RE 字符类不含顿号/斜杠（永假死代码），改按
        // occurrence.matchIndex 取出现位上下文判定（检测定位=原文定位）；4.52 P3a 前窗对称化：
        // 尾成员枚举链的顿号在其前窗（「300×300断面3003m、500×600断面1797m」的尾 token 前有
        // 「、500×」而后窗无顿号）——仅后窗判定收集不全致真枚举误报多口径（「300断面」簇实测）
        // 4.55.32 异名成员扩围：成员自带数值且成员名与本 token 概念互不包含（「钢柱1228.24t、
        // 钢梁1591.306t、钢吊车梁623.564t」三构件分列成量；「塔式起重机（QTZ63）2台、混凝土输送泵
        // 3台配置」两设备分列成量）时同为分对象列举；同名成员（「试压压力1.5、试压压力1.0」）不豁免。
        const enumerations = unitGroup.filter(token => token.occurrences.some(occurrence => {
          const after = markdown.slice(occurrence.matchIndex, occurrence.matchIndex + token.raw.length + 12);
          const before = markdown.slice(Math.max(0, occurrence.matchIndex - 12), occurrence.matchIndex);
          return enumeratedMemberIn(after, token.concept) || enumeratedMemberIn(before, token.concept);
        }));
        if (enumerations.length >= 2) continue;
        // 对象限定词不相容豁免（r23 P3b 归因）：「工具式脚手架搭设面积76.62m²」与「外脚手架
        // 搭设面积122.36m²」是不同脚手架对象各自的参量，bge 因共享核心词「脚手架搭设面积」误聚
        // 同簇；同组全部 token 概念两两扣除最长公共连续汉字子串后，剩余限定词均非空且互不包含
        // 时，属不同对象各自参量（非同参数多口径），跳过；同概念（残留全空）或含蕴含关系的
        // 口径（「管道闭水试验」vs「闭水试验」残留「管道」vs 空）仍判冲突。置于全部既有防线后：
        // 只收口穿透到 push 前的跨对象误聚，不改变各防线责任链。
        const distinctObject = unitGroup.length >= 2 && unitGroup.every((left, leftIndex) => unitGroup.every((right, rightIndex) => {
          if (leftIndex >= rightIndex) return true;
          // r28 扩围（r27b 归因：同值异述对破坏跨对象豁免——「其中道路硬化面积约2783㎡」与
          // 「道路硬化面积约2783㎡」共享核心 LCS 后左侧残留「其中」、右侧残留空，every 被同值对打断）：
          // 同值对豁免——取值完全相同的两 token（同一数值的不同表述）不构成口径冲突，无需参与
          // 跨对象分辨；仅放宽同值对，冲突判定仍由全部异值对承载（真冲突「同概念异值」的异值对
          // 残留为空即不豁免，照常报出）
          if (left.value === right.value) return true;
          // C5 扩围（r28l/s28l 实机误报：「基础底板钢筋保护层厚度40mm、柱梁钢筋保护层厚度25mm、
          // 板钢筋保护层厚度15mm」按构件分值是规范正确取值）：一方完整概念恰好是另一方的后缀
          // 子串（「板钢筋保护层厚度」⊂「基础底板钢筋保护层厚度」——最长公共子串吞并「板」字后
          // 一侧残留为空，原互不包含判定返 false 致误报），且短方以构件语素开头、长度 ≥4（含参量
          // 词尾，独立构件的完整概念；纯构件名「板」⊂「钢筋混凝土板」的同对象简称形态短于 4 字
          // 不豁免——同对象值不同仍判冲突）。构件细分各自参量（板/梁/柱/墙/底/顶）非同一参数多口径。
          const shorterConcept = left.concept.length <= right.concept.length ? left.concept : right.concept;
          const longerConcept = left.concept.length <= right.concept.length ? right.concept : left.concept;
          if (shorterConcept.length >= 4 && shorterConcept.length < longerConcept.length && longerConcept.endsWith(shorterConcept) && /^[板梁柱墙底顶]/u.test(shorterConcept)) return true;
          const span = longestCommonHanSubstringSpan(left.concept, right.concept);
          if (span.length < 2) return false;
          const common = left.concept.slice(span.start, span.end);
          const leftRest = left.concept.replace(common, '');
          const rightRest = right.concept.replace(common, '');
          return leftRest.length > 0 && rightRest.length > 0 && !leftRest.includes(rightRest) && !rightRest.includes(leftRest);
        }));
        if (distinctObject) continue;
        groups.push({ concept: unitGroup[0].concept, values: unitGroup });
        if (groups.length >= 4) break;
      }
      if (groups.length >= 4) break;
    }
    if (groups.length >= 4) break;
  }
  return { groups };
}

/**
 * 单组裁决（4.27.0 A1 三分支，检测端降级与修复端替换共用同源裁决）：
 * ①各值分别精确命中不同清单条目（billFactLock）= 误报（不同条目口径并存合法）；
 * ②恰好一个值精确命中清单条目（且条目名与概念相关，纯村组宽松匹配不算）其余值无锚 → 取锁值硬替换；
 * ③其余（无锁/部分锚定/权威多义）→ 保留 LLM 定向修复。
 */
export type ConceptGroupArbitration =
  | { verdict: 'distinct-lock-entries'; entries: string }
  | { verdict: 'single-lock-entry'; lockValue: number; lockUnit: string; entryName: string; nonLock: ConceptConflictValue[] }
  | { verdict: 'no-anchor' };

/** 清单单位文本归一（参数 token 单位捕获对 m²/m³ 截尾，须从 raw 原文回取后归一） */
function normalizeUnitToken(unit: string): string {
  return unit.replace(/㎡/gu, 'm2').replace(/m²/giu, 'm2').replace(/m³/giu, 'm3').replace(/\s+/gu, '').toLowerCase();
}

/** token 的原文单位文本（值文本之后紧邻）：如 raw="马圩组46.7m²" → "m²" */
function rawUnitOf(value: ConceptConflictValue): string {
  const first = value.occurrences[0];
  if (!first) return value.unit;
  const at = value.raw.indexOf(first.valueText);
  if (at < 0) return value.unit;
  return value.raw.slice(at + first.valueText.length) || value.unit;
}

function normalizeLockName(text: string): string {
  return text.replace(/[（(][^）)]*[）)]/gu, '').replace(/[\s,，、；;：:]/gu, '');
}

/** 条目名与概念相关：完全相等，或较长者包含较短者（较短 ≥3 字防两字短名误配） */
function lockNameRelated(entryName: string, concept: string): boolean {
  const name = normalizeLockName(entryName);
  const target = normalizeLockName(concept);
  if (name.length < 2 || target.length < 2) return false;
  if (name === target) return true;
  const shorter = name.length <= target.length ? name : target;
  const longer = name.length <= target.length ? target : name;
  return shorter.length >= 3 && longer.includes(shorter);
}

/** 值 → 清单条目命中（数额精确相等[相对容差 0.1%] + 单位兼容 + 语境相关[条目名/村组出现在值邻近窗口]）。
 * r9：ctx.entries 可显式覆盖枚举池（蓝图伪条目与清单锁条目并池，裁决源扩展用） */
export function lockEntriesForConceptValue(value: ConceptConflictValue, ctx: { markdown: string; billFactLock?: BillFactLock; entries?: BillFactLockEntry[] }): Array<{ entry: BillFactLockEntry; nameRelated: boolean }> {
  const entries = ctx.entries ?? ctx.billFactLock?.entries ?? [];
  if (entries.length === 0) return [];
  const tolerance = Math.max(0.01, value.value * 0.001);
  const unitText = normalizeUnitToken(rawUnitOf(value));
  const windows = value.occurrences
    .map(occurrence => ctx.markdown.slice(Math.max(0, occurrence.matchIndex - 48), occurrence.matchIndex + occurrence.valueOffset + occurrence.valueText.length + 48))
    .join('\n');
  const matched: Array<{ entry: BillFactLockEntry; nameRelated: boolean }> = [];
  for (const entry of entries) {
    if (!Number.isFinite(entry.quantity) || entry.quantity <= 0) continue;
    if (Math.abs(entry.quantity - value.value) > tolerance) continue;
    const entryUnit = normalizeUnitToken(entry.unit);
    // 单位兼容：任一侧缺单位放行；否则归一后必须相等（m²/m³ 上标归一，防跨量纲误配）
    if (unitText && entryUnit && unitText !== entryUnit) continue;
    const nameRelated = lockNameRelated(entry.name, value.concept);
    const villageRelated = entry.villageGroup.trim().length >= 2 && windows.includes(entry.villageGroup.trim());
    if (!nameRelated && !villageRelated) continue;
    matched.push({ entry, nameRelated });
    if (matched.length >= 8) break;
  }
  return matched;
}

/** 蓝图参数桶 → 伪清单条目（r9 扩围：第二裁决源）。仅参与分支①（各值分属不同口径=误报降级）
 * 的命中判定，不作分支②单锚锁值来源——蓝图聚合/分组值硬替换正文风险高于收益（宁交 LLM）。
 * 伪条目 seq 在蓝图池内自增（少量重叠无影响——互斥检查为同源语义，非全局唯一性保证）。 */
function blueprintPseudoEntries(quantities?: Record<string, BlueprintQuantity>): BillFactLockEntry[] {
  if (!quantities) return [];
  const entries: BillFactLockEntry[] = [];
  let seq = 1;
  const pushEntry = (name: string, quantity: number, unit: string, sourceFile: string, villageGroup: string) => {
    entries.push({ seq, name, description: '', quantity, unit, section: '', subsection: villageGroup, villageGroup, sourceFile, specQuantityPairs: [] });
    seq += 1;
  };
  for (const [name, item] of Object.entries(quantities)) {
    const unit = item.unit || '';
    const sourceFile = item.sourceFile || '';
    if (Number.isFinite(item.value) && item.value > 0) pushEntry(name, item.value, unit, sourceFile, '');
    for (const group of item.groups || []) {
      if (!Number.isFinite(group.value) || group.value <= 0) continue;
      // 分村/分工程明细条目：名中性化剥括号后仍与概念同源（lockNameRelated 口径）、villageGroup 供语境相关判定
      pushEntry(`${name}（${group.group}）`, group.value, unit, sourceFile, group.group);
    }
  }
  return entries;
}

/** 单组三分支裁决（纯函数；两裁决源均缺失时恒无锚→分支③，与历史行为一致）。
 * r9 扩围（r9 实机 #9 归因：正文两合法口径被概念聚类误报冲突）：裁决池 = 清单锁条目（唯一
 * 锁值来源）+ 蓝图参数桶伪条目（仅分支①命中依据）——「塑料管铺设 8205.53m/7525.01m」两值
 * 各自命中蓝图 DN200/DN110 口径 → 分支①降级，不再裸坠 LLM 修复轮。 */
export function arbitrateConceptGroup(group: ConceptConflictGroup, ctx: { markdown: string; billFactLock?: BillFactLock; blueprintQuantities?: Record<string, BlueprintQuantity> }): ConceptGroupArbitration {
  if (group.values.length < 2) return { verdict: 'no-anchor' };
  const billEntries = ctx.billFactLock?.entries ?? [];
  const pseudoEntries = blueprintPseudoEntries(ctx.blueprintQuantities);
  if (billEntries.length === 0 && pseudoEntries.length === 0) return { verdict: 'no-anchor' };
  const hits = group.values.map(value => ({
    value,
    // 分支①口径：两源并池命中判定
    matches: lockEntriesForConceptValue(value, { markdown: ctx.markdown, entries: [...billEntries, ...pseudoEntries] }),
    // 分支②口径：锁值来源仅清单锁（防蓝图聚合/分组值硬替换正文）
    billMatches: lockEntriesForConceptValue(value, { markdown: ctx.markdown, entries: billEntries }),
  }));
  // ① 每个值都有精确命中，且各值命中条目互不相交 → 各值分属不同口径条目 = 误报
  if (hits.every(hit => hit.matches.length > 0)) {
    const disjoint = hits.every((left, leftIndex) =>
      hits.every((right, rightIndex) =>
        leftIndex === rightIndex || !left.matches.some(leftMatch => right.matches.some(rightMatch => rightMatch.entry.seq === leftMatch.entry.seq))));
    if (disjoint) {
      return {
        verdict: 'distinct-lock-entries',
        entries: hits.map(hit => `「${hit.matches[0].entry.name}」（${hit.value.value}${hit.value.unit}）`).join('、'),
      };
    }
  }
  // ② 恰好一个值命中清单锁（须为条目名相关）且其余值两源均无命中 → 取锁值确定性硬替换
  const anchored = hits.filter(hit => hit.billMatches.length > 0);
  const unanchored = hits.filter(hit => hit.matches.length === 0);
  if (anchored.length === 1 && unanchored.length > 0 && anchored.length + unanchored.length === hits.length) {
    const best = anchored[0].billMatches.find(match => match.nameRelated);
    if (best) {
      return {
        verdict: 'single-lock-entry',
        lockValue: best.entry.quantity,
        lockUnit: best.entry.unit,
        entryName: best.entry.name,
        nonLock: unanchored.map(hit => hit.value),
      };
    }
  }
  return { verdict: 'no-anchor' };
}

export async function parameterConceptConflictIssues(markdown: string, opts?: {
  /** 清单事实锁（4.27.0 A1 裁决）：多口径值分别精确命中不同清单条目的组判误报 → 降级 info 不阻断 */
  billFactLock?: BillFactLock;
  /** r9：蓝图参数桶（第二裁决源）——与 finalize 修复端 arbitrateConceptGroup 同源裁决 */
  blueprintQuantities?: Record<string, BlueprintQuantity>;
}): Promise<ValidationIssue[]> {
  const scan = await conceptConflictGroups(markdown);
  if (scan.degraded) return [scan.degraded];
  if (scan.groups.length === 0) return [];
  // A1 裁决分流：①误报组降级 info（正文带条目名区分即合规）；②③保留 blocker——②由前置裁决器
  // 硬替换收敛，替换失败/③无锚由 global-consistency-repair LLM 定向修复兜底
  //（历史缺陷：12 项参数口径冲突 llm-patch 不收敛空转）
  const blocking: ConceptConflictGroup[] = [];
  const acquitted: Array<{ group: ConceptConflictGroup; entries: string }> = [];
  for (const group of scan.groups) {
    const arbitration = arbitrateConceptGroup(group, { markdown, billFactLock: opts?.billFactLock, blueprintQuantities: opts?.blueprintQuantities });
    if (arbitration.verdict === 'distinct-lock-entries') acquitted.push({ group, entries: arbitration.entries });
    else blocking.push(group);
  }
  const issues: ValidationIssue[] = [];
  if (blocking.length > 0) {
    const conflicts = blocking.map(group => `“${group.concept}”出现多个口径：${[...new Set(group.values.map(value => value.raw))].slice(0, 3).join('、')}`);
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `同一参数概念出现多口径数值冲突：${conflicts.join('；')}`,
      suggestion: '以绑定资料（图纸/清单/规范）裁决口径为准统一数值表述：每个参数概念全文只保留一个口径数值，删除矛盾表述。',
    });
  }
  if (acquitted.length > 0) {
    issues.push({
      level: 'info',
      severity: 'suggestion',
      category: 'fact_consistency',
      owner: 'system',
      repairability: 'not_repair_needed',
      message: `参数概念多口径已裁决为不同清单条目口径（不构成冲突）：${acquitted.map(({ group, entries }) => `“${group.concept}”对应${entries}`).join('；')}`,
      suggestion: '各数值分别对应不同的工程量清单条目，正文已带条目名区分，无需处理。',
    });
  }
  return issues;
}
