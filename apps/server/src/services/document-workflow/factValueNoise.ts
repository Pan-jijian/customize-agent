/**
 * 事实值噪声判据的**唯一权威来源**（4.56.3 判据单源化）。
 *
 * ## 为什么要有这个文件
 *
 * 「一个事实值是不是可比较的取值」这件事，此前在仓库里有**两份实现**：
 *
 * - `factsModel.conflictComparableFactValue`（真值层/事实模型侧）——完整：缺省声明、变更叙述、
 *   口径标签前缀、名称编号粘连、损坏文本标记全部处理；
 * - `document-validation/factConsistencyService.comparableValue`（对账终检侧）——**只做了自己那套**，
 *   上述五项一条都没用。
 *
 * 后果不是"少过滤几条噪声"，而是**两份判定对同一批数据给相反结论**：真值层已按变更连接语取生效值
 * 330，对账侧却取首个匹配 365 → 判「存在多个值」→ 事实维度触发归零悬崖（`factIntegrity` 中
 * 冲突数 ≥5 直接使 60% 分量归零）。
 *
 * 实测（`doc-1790156773687-0c18ca14`，综合 85/95）——6 条 blocker 全部来自这一族：
 *
 * | 检测器报的「多个值」 | 实际 |
 * |---|---|
 * | 计划工期：`330日历天` vs `365日历天，现变更修改为:330日历天` vs `现澄清为如下：条款号条款号…` vs `【资料未体现】` vs `见《专用合同条款数据表》` vs `未提供` | **只有一个真值 330**；其余依次是变更叙述、表格抓取残片、缺省声明、指针条款、缺省声明 |
 * | 工期关键节点：`【清单未体现】` vs `【资料未体现】` vs `未提供` vs 清单编制时间 | **零个真值**（全为缺省声明），却报多值冲突 |
 * | 项目名称：`…项目—东区…` vs `…项目一东区…` | 破折号/一字**同形变体**（见 {@link foldHomoglyphVariants}） |
 *
 * 本模块把这三类判据收敛到一处，`factsModel` 与 `factConsistencyService` 共用；
 * 任一消费方再出现第二份实现，即由 `factValueNoiseSingleSource.test.ts` 拦截。
 */
import { CHANGE_CONNECTORS } from './valueOverride';

/**
 * 损坏文本标记（替换字符/不可打印控制字符）：≥2 个替换字符，或含任何替换字符/控制字符。
 * 表格抓取与 OCR 残片几乎必带这类字符，作为值参与对账只产生噪声。
 */
export function hasCorruptTextMarkers(text: string): boolean {
  const corruptMarks = text.match(/�|￿/gu)?.length || 0;
  return corruptMarks >= 2 || Array.from(text).some(char => {
    const code = char.charCodeAt(0);
    return code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13);
  });
}

/**
 * 变更叙述取值：值含变更连接语时，**生效值在连接语之后**（连接语之前是旧值）。
 *
 * 判据单源：连接语取自 `valueOverride.CHANGE_CONNECTORS`（值级覆盖与真值层共用同一份）。
 * 本函数此前只存在于 `factsModel`，对账侧直接取正则首个匹配 → 取到旧值。
 */
export function valueAfterChangeConnector(raw: string): string {
  /**
   * **必须把交替串包进 `(?:…)`**：`CHANGE_CONNECTORS` 是裸交替串
   *（`变更修改为|变更为|…|更改为`），不分组时后缀 `\s*[:：]?\s*` 只作用于**最后一个分支**，
   * 于是 `365日历天，现变更修改为:330日历天` 只吃掉连接语、留下前导冒号 `:330日历天`。
   *（同文件 `valueOverride.ts:88` 的用法包了 `(...)` 故无此问题——判据单源后此处对齐。）
   */
  const match = new RegExp(`(?:${CHANGE_CONNECTORS})\\s*[:：]?\\s*`, 'u').exec(raw);
  if (!match) return raw;
  return raw.slice((match.index ?? 0) + match[0].length).trim();
}

/**
 * 表格/条款抓取残片判据：表头词连排（「条款号条款号条款名称条款名称编列内容编列内容」）
 * 或整段条款正文被当成单元格值。这类值长度大、含表头词，不可能是某个事实的取值。
 */
const TABLE_SCRAPE_MARKER_RE = /条款号|条款名称|编列内容|评标办法前附表|评标办法正文/u;

export function isTableScrapeFragment(text: string): boolean {
  return TABLE_SCRAPE_MARKER_RE.test(text);
}

/**
 * 同形变体折叠（**仅用于多值分组的比较键**，不改动任何展示值）。
 *
 * 输入法/OCR 会把连接号打成字形近似的汉字「一」，或把同一连接号打成全角破折号/波浪线/连字符：
 * `巢湖市光电新能源产业园项目—东区标准化厂房二标段施工` 与 `…项目一东区…` 被判「项目名称多值冲突」。
 *
 * 口径：把破折号族（`—–―─－-`）与**夹在汉字之间的**「一」一并**删除**。
 * 「删除」而非「替换为占位符」是必须的：调用侧的 `normalize` 已经先删掉了破折号，
 * 若折叠只做等长替换，`项目—东区`（→`项目东区`）与 `项目一东区`（→`项目⟨占位⟩东区`）
 * 仍然不相等（实测：这一版折法上线后该条误报照旧）。
 *
 * 为何不会吞并真实取值：折叠只会让「仅差一个连接号/字形」的两个取值相等——
 * `一标段` 与 `二标段` 折叠后分别为 `标段`/`二标段`，仍不相等；真冲突不可能由删除一个字形产生。
 */
const HOMOGLYPH_FOLD_RE = /(?<=[一-龥])[—–―─－-]|一(?=[一-龥])/gu;

export function foldHomoglyphVariants(value: string): string {
  return value.replace(HOMOGLYPH_FOLD_RE, '');
}

/**
 * 行政区划简称折叠（4.56.6，**仅用于多值分组的比较键**，不改动展示值）。
 *
 * 实测 `建设地点`：`巢湖市居巢经济开发区` 与 `巢湖市居巢经开区义成路与南外环路交口北侧`
 * 是同一地点的粗/细两级，但前者写全称、后者用简称，前缀关系因此断裂、无法吸收。
 * 统一折到**简称形**（长 → 短）后前缀关系恢复。
 *
 * 只折叠长度明确、无歧义的开发区类全称；不做「安徽→省名可选」那类推断（需地理知识，超出形态判据）。
 */
const ADMIN_ABBREVIATION_FOLDS: ReadonlyArray<[RegExp, string]> = [
  [/经济技术开发区/gu, '经开区'],
  [/高新技术产业开发区/gu, '高新区'],
  [/经济开发区/gu, '经开区'],
  [/高新技术开发区/gu, '高新区'],
  [/产业开发区/gu, '开发区'],
];

export function foldAdminNameAbbreviation(value: string): string {
  let text = value;
  for (const [pattern, replacement] of ADMIN_ABBREVIATION_FOLDS) text = text.replace(pattern, replacement);
  return text;
}

/**
 * 时间值形态分桶（D-T4 ④ 槽位对齐；4.56.4 迁入单源模块供对账侧共用）。
 *
 * 「计划工期=330日历天」与「计划开工日期：2026年10月10日」在周期要求域归并后互比，
 * **时长与日期是不同槽位**——同一条款里两句本来就同时成立，判「多值冲突」是纯误报。
 * 判定口径：仅当组内值全部可判形态且时长、日期并存时分桶各自比对（同形态多值照报，跨形态不报）；
 * 含未判形态值或单一形态时维持全量互比口径，防真冲突被静默。
 */
export const TEMPORAL_DURATION_VALUE_RE = /^\d+\s*个?\s*(?:日历天|天|个月|月|周|年)$/u;
export const TEMPORAL_DATE_VALUE_RE = /^20\d{2}\s*(?:年\s*\d{1,2}\s*月|[.\-/]\d{1,2}(?:[.\-/]|$))/u;

export function temporalValueKind(value: string): 'duration' | 'date' | 'plain' {
  if (TEMPORAL_DURATION_VALUE_RE.test(value)) return 'duration';
  if (TEMPORAL_DATE_VALUE_RE.test(value)) return 'date';
  return 'plain';
}

/**
 * 合规引用句判据（4.58 R5 ①，实测 `doc-1790168542563-ea526b1b`）。
 *
 * `计划工期` 的第三个"值"是 `符合第二章“投标人须知”第1.3.2项规定`——这是**对条款的引用陈述**，
 * 不是工期取值（真正的取值是 `330日历天`）。既有指针条款判据只覆盖
 * `/^(?:详|参见|见|依据)\s*[《【]/`（书名号/方头括号开头的指针），这类"动词 + 条款号 + 规定"的
 * 合规句整句落在网格之外，于是被判成与真值并列的"另一个值"；又因它形态为 plain，
 * 连带打掉了时长/日期的槽位分桶（见 `temporalValueKind`）。
 *
 * 判据取**形态三要素**（不穷举词表，避免"再遇到一个动词就得补一次名单"）：
 * ① 以合规动词开头（符合/满足/遵照/遵循/按照/依据/响应）；② 句内含条款编号（`第X.X条/项/款/章/节`）；
 * ③ 以「规定/要求」收尾。三者同时成立才是引用句——真实取值不可能同时具备这三条形态。
 *
 * 反例自检（不得误伤）：`330日历天`（无动词）、`2026年10月10日`（无动词/无条款号）、
 * `框架结构`（三者皆无）、`符合国家现行验收规范合格标准`（无条款编号）、`满足GB50204-2015要求`
 * （规范号不是条款号，无 `第…条`）——均不满足，照常参与对账。
 */
const COMPLIANCE_CITATION_VERB_RE = /^(?:符合|满足|遵照|遵循|按照|依据|响应)/u;
const CLAUSE_NUMBER_RE = /第\s*[\d一二三四五六七八九十.．]+\s*(?:条|项|款|章|节)/u;
const COMPLIANCE_CITATION_TAIL_RE = /(?:规定|要求)$/u;
/** 引用句长上限：真取值是短语，长到这一量级的"值"必是句子（防形态三要素在长段落上偶合） */
const COMPLIANCE_CITATION_MAX_LENGTH = 80;

export function isComplianceCitationValue(text: string): boolean {
  const value = String(text || '').trim();
  if (!value || value.length > COMPLIANCE_CITATION_MAX_LENGTH) return false;
  return COMPLIANCE_CITATION_VERB_RE.test(value)
    && CLAUSE_NUMBER_RE.test(value)
    && COMPLIANCE_CITATION_TAIL_RE.test(value);
}

/**
 * 尾随形式括注剥离（4.56.4）：`巢湖执珩建设投资有限公司（盖单位章）` 与
 * 裸名 `巢湖执珩建设投资有限公司` 是**同一实体的两种书写**——括注是签章形式说明而非名称的一部分。
 * 实测：`招标人` 因此被判「存在多个值」（另一组还并入了「安徽合肥公共资源交易中心」的真实错抽）。
 *
 * 只剥**尾部**、且单组不超过 12 字（防把实体名中的正式括注，如
 * `巢湖市中科智城（中国科大英才创新创业基地）6号楼` 的中间括注误剥——它不在尾部）。
 */
const TRAILING_FORM_ANNOTATION_RE = /[（(][^）)]{0,12}[）)]\s*$/u;

export function stripTrailingFormAnnotation(value: string): string {
  let text = value.trim();
  let previous = '';
  while (previous !== text) {
    previous = text;
    text = text.replace(TRAILING_FORM_ANNOTATION_RE, '').trim();
  }
  return text || value.trim();
}

/**
 * 口径标签前缀剥离（4.56.4 迁入单源模块；`factsModel` 再导出保持既有 5 处消费方零改动）。
 *
 * 「计划开工日期：2026年10月10日（具体开工日期以招标人出具的书面开工通知为准）」若不带这一步，
 * 取值形态判为 plain（日期形态正则锚定 `^20\d{2}`），「时长 vs 日期」的槽位分桶因 plain 混入整体失效
 * → 同一个日期与工期值被判「多值冲突」。
 *
 * 边界收紧：仅当冒号后紧跟**时间形态**（`20XX年` / 数字+时长）时才剥——避免误伤普通句式值。
 */
export function stripFactLabelPrefix(value: string): string {
  const text = String(value || '');
  const closed = text.replace(/^(?:招标人|招标单位|建设单位|发包人|项目名称|工程名称|项目编号|招标项目编号|标段名称|建设地点|建设规模|招标范围|计划工期|合同工期|质量标准|质量目标)[：:]\s*/u, '');
  if (closed !== text) return closed;
  return text.replace(/^[一-龥]{2,10}[：:]\s*(?=(?:20\d{2}\s*年|\d+\s*(?:日历天|天|个月|月|年)))/u, '');
}

/**
 * 参数取值的单位表（**判据单源**）：参数 token 提取（`parameterConceptConflicts.PARAM_TOKEN_RE`）
 * 与「连接词左侧是否已有另一处取值」的判定共用同一份，避免两处各写一张表再各自漂移。
 */
export const MEASURE_UNIT_ALTERNATION = String.raw`m²|m³|㎡|mm|cm|m|米|MPa|kN|kV|kW|℃|°C|万元|元|人|天|日|个|层|樘|处|套|台|t|吨`;

/** 数值声明（数字 + 单位）：判「这处文本已经是一个参数取值」 */
export const VALUE_DECLARATION_RE = new RegExp(String.raw`\d+(?:\.\d+)?\s*(?:${MEASURE_UNIT_ALTERNATION})`, 'u');

/** 短语续接字符：对象名/规格编号内部可能出现的字符；标点、空白、引号、括号之外的一切即边界 */
const OBJECT_WINDOW_PHRASE_CHAR_RE = /[一-龥A-Za-z0-9_\-./²³°]/u;
/** 并列连接词：两侧常是**并列的两个取值项**（区别于对象名内部的「与」，如「路面与路基」） */
const OBJECT_WINDOW_CONNECTOR_RE = /[与和及]/u;
/** 连接词左侧的取证窗口：判「连接词左侧是否已有另一处数值声明」 */
const CONNECTOR_LEFT_LOOKBACK = 30;
/** 单次收拢的步数上限：畸形长文本下不无限啃（上限内收拢不到的留给残片判定） */
const OBJECT_WINDOW_MAX_STEPS = 64;

/**
 * 参数**对象名窗口**的边界收拢（4.58 R5 ③，实测 `doc-1790168542563-ea526b1b`）。
 *
 * ## 为什么必须收拢
 *
 * 参数 token 的对象名是**定宽窗口**产物（前后缀各 ≤12/≤8 字的一次正则匹配）。实测句：
 *
 * ```
 * 粗粒式沥青混凝土(AC-25C)6cm厚与细粒式改性沥青混凝土面层(AC-13C)4cm厚各13898.51m²
 * ```
 *
 * 被抽成两个"同一概念"的残片：`25C)厚与细粒式改性沥` 与 `13C)厚各13898`——
 * 前者把对象名「粗粒式沥青混凝土」整个丢掉（`AC-` 的连字符不在前缀字符类内，匹配只能从 `25C)` 起），
 * 后者把下一处「细粒式…」粘了进来。两个**不同对象**（粗粒式 AC-25C 6cm / 细粒式 AC-13C 4cm）
 * 因此被 bge 聚成同簇，数值 6 与 4 被判「同一参数多口径」。
 *
 * ## 收拢口径（形态判据，不查名单）
 *
 * - **左端**：越过前缀字符类之外的短语字符（`-`、`.` 等规格编号成分）与**完整的括号组**，
 *   直到标点/空白/并列连接词的边界；`（AC-25C）` 不得只剩 `25C)`。
 * - **并列连接词（与/和/及）**：若连接词左侧**已有另一处数值声明**（`6cm厚与细粒式…` 的「与」），
 *   它就是两个取值项的分界——窗口不跨过，否则又把前一项的对象名粘进本项。
 *   连接词左侧没有取值时不切（`路面与路基5m` 是一个对象，窗口须含全名）。
 * - **右端**：同理向右收拢到标点/空白边界，括号组整体纳入。
 * - 括号**不成对**时（源文本被截断/OCR 残缺）不硬啃：开括号无配对闭括号则不纳入开括号，
 *   闭括号左侧无配对开括号则不含该闭括号——残留的不配对形态交给
 *   {@link hasTruncatedBracketFragment} 判残片。
 *
 * 收拢只作用于**对象名窗口**，不改数值与单位（参数 token 的 `raw`/值偏移仍由正则组精确给出），
 * 故「检测定位 = 修复定位」不变量不受影响。
 */
export function collapseObjectWindowStart(text: string, start: number): number {
  let at = Math.max(0, Math.min(start, text.length));
  for (let step = 0; step < OBJECT_WINDOW_MAX_STEPS && at > 0; step += 1) {
    const previous = text[at - 1]!;
    if (OBJECT_WINDOW_PHRASE_CHAR_RE.test(previous)) {
      // 连接词左侧已有另一处取值 ⇒ 连接词是两个取值项的分界，窗口在此开始
      const leftOfConnector = text.slice(Math.max(0, at - 1 - CONNECTOR_LEFT_LOOKBACK), at - 1);
      if (OBJECT_WINDOW_CONNECTOR_RE.test(previous) && VALUE_DECLARATION_RE.test(leftOfConnector)) break;
      at -= 1;
      continue;
    }
    if (previous === ')' || previous === '）') {
      // 起点紧贴闭括号：向左找配对开括号（含嵌套）。找不到配对 ⇒ 括号不成对，不含该闭括号
      const open = previous === ')' ? '(' : '（';
      let depth = 0;
      let scan = at - 1;
      while (scan >= 0) {
        const char = text[scan]!;
        if (char === previous) depth += 1;
        else if (char === open) {
          depth -= 1;
          if (depth === 0) break;
        }
        scan -= 1;
      }
      if (scan < 0) break;
      at = scan;
      continue;
    }
    if (previous === '(' || previous === '（') {
      // 走到括号组内部（起点右侧有配对闭括号）⇒ 整组纳入，`(AC-25C)` 不得只剩 `25C)`
      const close = previous === '(' ? ')' : '）';
      if (!text.includes(close, at)) break;
      at -= 1;
      continue;
    }
    break;
  }
  return at;
}

export function collapseObjectWindowEnd(text: string, end: number, floor = 0): number {
  let at = Math.max(0, Math.min(end, text.length));
  for (let step = 0; step < OBJECT_WINDOW_MAX_STEPS && at < text.length; step += 1) {
    const next = text[at]!;
    if (OBJECT_WINDOW_PHRASE_CHAR_RE.test(next)) {
      at += 1;
      continue;
    }
    if (next === '(' || next === '（') {
      // 开括号无配对闭括号 ⇒ 不含（不硬啃半截括号组）
      const close = next === '(' ? ')' : '）';
      if (!text.includes(close, at)) break;
      at += 1;
      continue;
    }
    if (next === ')' || next === '）') {
      // 闭括号须与本窗口内的开括号配对才纳入，否则以它为边界停下——`floor` 是窗口起点，
      // 少了它会把窗口**之外**（左侧另一处括号组）的开括号当成配对：实测
      // `粗粒式沥青混凝土(AC-25C)6cm与细粒式改性沥青混凝土AC-13C)4cm` 的第二个 token
      // （源文本自身缺开括号）会因此把裸露的 `)` 收进窗口，把一个正常 token 判成残片丢弃。
      const open = next === ')' ? '(' : '（';
      if (!text.slice(Math.max(0, floor), at).includes(open)) break;
      at += 1;
      continue;
    }
    break;
  }
  return at;
}

/**
 * 残片判定：对象名**含未配对闭括号**（闭括号多于开括号）——即其左侧原本是一个括号组、
 * 被定宽窗口从中间切断（`25C)` 是 `(AC-25C)` 的尾部截断）。
 * 这类残片没有独立对象身份，其数值与任何口径都不可互比。
 *
 * 反向不判：只多开括号（`（AC-25C` 缺闭括号）在中文正文里多为残缺排版/OCR 现象，
 * 不是"被切掉的尾部"，按普通文本照常参与（防把正常短语整批踢出互斥）。
 */
export function hasTruncatedBracketFragment(text: string): boolean {
  let depth = 0;
  for (const char of String(text || '')) {
    if (char === '(' || char === '（') depth += 1;
    else if (char === ')' || char === '）') {
      depth -= 1;
      if (depth < 0) return true;
    }
  }
  return false;
}

/**
 * 包含关系判定：`fragment` 是否为 `source` 的**截断**（去括号后是 `source` 去括号后的真子串）。
 * 判据单源：残片与其截断源同判于一处的目的是让记录能指名"这个残片原本是哪个完整形态"。
 */
export function isTruncationFragmentOf(fragment: string, source: string): boolean {
  const strip = (text: string) => String(text || '').replace(/[（()）]/gu, '');
  const short = strip(fragment);
  const long = strip(source);
  if (short.length === 0 || short.length >= long.length) return false;
  return long.includes(short);
}

/** 在**同一行**文本里为残片找截断源：哪个完整括号组与它同源（如 `25C)` ← `(AC-25C)`）。
 *  包含关系**双向都试**：残片窗口常把数值与单位一并带上（`面层(AC-13C)4cm)`），
 *  此时窗口比括号组长——单向的「残片 ⊂ 括号组」永远不成立，记录就指不出截断源了。
 *  找不到返回 undefined（源文本本身就没写全，记录里如实说明）。 */
export function findTruncationSource(text: string, fragment: string): string | undefined {
  for (const match of String(text || '').matchAll(/[（(][^（()）]{1,20}[）)]/gu)) {
    if (isTruncationFragmentOf(fragment, match[0]) || isTruncationFragmentOf(match[0], fragment)) return match[0];
  }
  return undefined;
}
