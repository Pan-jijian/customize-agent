/**
 * 资料载体残片判定（单源，4.55.12 巢湖实测）：
 *
 * 「残片」= 资料**载体的原文形态**（答疑对答、图纸 OCR 表格串、纯参数堆砌行），不是可交付正文。
 * 两类消费方共用本判据，避免口径分叉：
 * ① **源头侧**（evidence.cleanEvidenceText）：残片行在进入证据池前剔除 → 写作模型看不到、不会引用；
 * ② **兜底侧**（tenderRequirements.fixFormalSourceResidue）：MISS 掉源头（如链尾补写重新引入）时的
 *    交付前整行删除。
 *
 * **判据形态（勿改宽）**：初版按「整行数字符号占比 ≥0.45」判定，实测把 CAD 标注行
 * （`└── 标注文本: 15.65(基坑底标高) | 关联对象: 邻近标注 坡率 1:1.0 | 状态: 普通标注`）整行删掉——
 * 那正是图纸真实事实（基坑底标高）的载体。故改按**无标点长串**判定：图纸/正文的正常行都有标点与
 * 字段分隔（最长无标点串 ≤ 约 20 字符），OCR 表格串则是数百字符的连续密集串。
 */
/** 无标点长串长度门槛（正常行最长无标点串实测 ≤20；OCR 表格串 40+） */
const RESIDUE_RUN_MIN_LENGTH = 25;
/** 长串内数字+符号占比门槛 */
const RESIDUE_RUN_DENSITY_MIN = 0.45;
/** 长串内汉字占比上限：正文正常串（「其中800×800地砖与600×600地砖按设计划分」）由汉字词承载语义，
 * 占比 ≥0.3；OCR 表格串（「J01B1-1…钢筋表18080型式…」）汉字占比 <0.25。此为防误伤主闸 */
const RESIDUE_RUN_CJK_MAX = 0.3;
/** 标点/分隔符（切开连续串的字符：含字段分隔符｜/、CAD 层级符与括号） */
const RUN_BREAKER_RE = /[，。；：、·|｜,;:（）()【】《》[\]{}<>「」'"“”\s]/gu;

/** 纯参数堆砌行：≥N 个顿号分隔段且 ≥80% 段是裸数值（无成句语义的填充行；
 * 巢湖实测该行是「无主数值审计：疑似编造 JC-07/JC-08/JC-09」的唯一来源） */
const FILLER_MIN_SEGMENTS = 15;
const FILLER_BARE_RATIO = 0.6;
const BARE_VALUE_SEGMENT_RE = /^\s*[\d.]+\s*(?:[A-Za-z%℃²³]+|平方米|立方米|平方|立方|米|天|年|月|日|周|小时|分钟|元|万元|台|套|个|项|批|次|人|份|页|处|座|根|块|组|件|孔|盏|樘|扇|片)*\s*$/u;

export function isMaterialResidueLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#{1,6}\s/u.test(trimmed) || /^\|/u.test(trimmed)) return false;
  // ① 答疑对答行（无长度门槛：短答案行同属残片）
  if (/^(?:答|答复|回复|答疑)\s*[:：]/u.test(trimmed)) return true;
  if (trimmed.length < 30) return false;
  // ② OCR 表格串：存在「无标点密集长串」（数字符号占比 ≥0.45）
  for (const run of trimmed.split(RUN_BREAKER_RE)) {
    if (run.length < RESIDUE_RUN_MIN_LENGTH) continue;
    const digits = (run.match(/[0-9]/gu) || []).length;
    const symbols = (run.match(/[+\-*/×@%·．.,≤≥~～$]/gu) || []).length;
    const cjk = (run.match(/[一-龥]/gu) || []).length;
    if (cjk / run.length > RESIDUE_RUN_CJK_MAX) continue;
    if ((digits + symbols) / run.length >= RESIDUE_RUN_DENSITY_MIN) return true;
  }
  // ③ 纯参数堆砌行
  const segments = trimmed.split(/[、，,；;]/u).map(segment => segment.trim()).filter(Boolean);
  if (segments.length >= FILLER_MIN_SEGMENTS) {
    const bare = segments.filter(segment => BARE_VALUE_SEGMENT_RE.test(segment)).length;
    if (bare / segments.length >= FILLER_BARE_RATIO) return true;
  }
  return false;
}

/** 剔除残片行（残片行替换为空行，避免把相邻段落粘成一行；连续空行收敛为一段） */
export function stripMaterialResidueLines(text: string): string {
  if (!text) return text;
  return text
    .split(/\r?\n/u)
    .map(line => (isMaterialResidueLine(line) ? '' : line))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n');
}

/** 句中形态资料残片（4.55.19 实测漏网形态）：
 * 「现澄清为如下：条款号条款号条款名称条款名称编列内容编列内容1.3.2计划工期…」——
 * 以**句子成分**出现（不在独立行），行级判据（isMaterialResidueLine）看不见。
 * 判据：澄清表导语 + 表头字段复写（条款号/条款名称/编列内容任一连续复写 ≥2 次）→ 该小句为
 * 澄清表残片，整句移除（保留其后的正常正文）。 */
const CLARIFICATION_TABLE_DUMP_RE = /(?:现澄清为如下|澄清为如下|澄清如下)[：:][^。；\n]*/gu;

export function stripSentenceLevelResidue(text: string): { text: string; removed: number } {
  if (!text) return { text, removed: 0 };
  let removed = 0;
  let result = text.replace(CLARIFICATION_TABLE_DUMP_RE, () => {
    removed += 1;
    return '';
  });
  // 表头字段复写（条款号条款号…）：单处复写即判残片（正常行文不会连续复写字段名）
  result = result.replace(/(?:条款号条款号|条款名称条款名称|编列内容编列内容)/gu, () => {
    removed += 1;
    return '';
  });
  // 清理空壳标点（「：。」「，。」等）
  result = result.replace(/[：:，,；;]\s*(?=[。；;])/gu, '');
  return { text: result, removed };
}
