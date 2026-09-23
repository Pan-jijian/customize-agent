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
