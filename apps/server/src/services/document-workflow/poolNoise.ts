/**
 * poolNoise：要求池/参数池表格噪声判定（D6 池净化单源）。
 *
 * 背景（s28l/r28l 实机归因）：招标文件/图纸/清单的 PDF-Excel 解析产物中，表格结构噪声会随条款化与
 * 事实提取进入要求池与参数池——图纸标题栏图签（「…工程设计甲级证书编号：A134A00302」）、清单表
 * 行列坐标（「R6C4项目特征描述:…」）、PDF 目录页点串行（「十九、施工组织设计.......」）、OCR 表格
 * 标签残片（「CHECKE…子项名称SUBITEM…」）、编号粘连（「2225111舒城县…」）。这类条目既无法逐字
 * 锚定正文（永久拉低锚点命中率/参数义务满足率），又误导修复方向——两池必须同源净化。
 *
 * 设计（全形态判据，零项目词表；只出池不删档）：
 * - 纯函数模块零依赖（避免要求池↔参数池循环依赖），要求池与参数池共用同一判定；
 * - 图签/长值残片类判定带「无约束词」守卫：含确保/保证/须/标准/要求等实义约束词的条款一律保留
 *   （防「投标人须提供工程设计甲级资质证书」类真实要求被图签特征误伤）；
 * - 判定只返回分类标签：调用侧决定归宿（要求池 → excluded reason='noise'；参数池 → 审计登记）。
 */

/** 约束词守卫（与条款碎片形态复核同口径单源）：含任一即视为有实质语义的内容，图签/残片类判据对其不生效 */
export const POOL_CONSTRAINT_WORD_RE = /(?:确保|保证|达到|满足|符合|不低于|不超过|不得|禁止|严禁|必须|应当|须|应按|执行|遵守|落实|实施|采用|提供|提交|出具|配备|设置|建立|安装|配置|负责|完成|参加|组织|验收|检测|检验|控制|管理|保护|防止|杜绝|承诺|响应|要求|规定|标准|等级|目标|措施|方案|制度|计划|工期|质量|安全)/u;

/** 噪声分类（审计标签） */
export type PoolNoiseCategory =
  /** PDF 目录页点串行（行首编号 + 长点串/省略号结尾） */
  | 'toc_line'
  /** 图纸标题栏图签（印章/资质/证书编号特征；单特征须无约束词守卫，多特征共现直接判定） */
  | 'drawing_signature'
  /** 清单表行列坐标（CAD 转换产物 R6C4 形态） */
  | 'sheet_coordinate'
  /** OCR 表格标签/英文残片（CHECKE/SUBITEM/子项名称/项目特征描述 粘连；表单占位标记/日期时间粘连同族） */
  | 'table_fragment'
  /** 编号粘连（值首长数字紧贴汉字：2225111舒城县…；章节号打头残片/OCR 零串/表号标号同族） */
  | 'numeric_smear'
  /** 超长罗列值（规范清单/表行粘连：超长 + 无句读 + 含拉丁串，不可逐字锚定） */
  | 'listing_smear'
  /** 孤立日期值（图签/表单日期栏提取物：独立年份「2024年」/独立月份「12月」，无事件绑定不可落位） */
  | 'date_fragment';

/** 目录页行：行首编号（一、/1./1.2 等）且以 4+ 半角点或 3+ 省略号结尾，允许尾部页码（真实 PDF 目录
 * 形态「十九、施工组织设计……211」——点串在标题与页码之间，行尾是页码而非点串，C3-9 归零验证实机
 * 缺口修正；正文条款不以长点串结尾且 4+ 连续半角点不见于正文行文） */
const TOC_LINE_RE = /^[（(]?[一二三四五六七八九十百\d]{1,3}[、.．)）]\s*[^\n]{2,60}(?:\.{4,}|…{3,})\s*\d{0,4}\s*$/u;

/** 图签栏特征词模式（印章/出图/资质/证书编号形态）：单源拼装 test 版（守卫判定）与 scan 版（计数判定） */
const DRAWING_SIGNATURE_PATTERN = '专用章|出图|设计研究总院|工程设计(?:甲|乙|丙)级|资质证书|证书编号';
const DRAWING_SIGNATURE_RE = new RegExp(DRAWING_SIGNATURE_PATTERN, 'u');
const DRAWING_SIGNATURE_SCAN_RE = new RegExp(DRAWING_SIGNATURE_PATTERN, 'gu');

/** 表格行列坐标（R6C4/R162C4 形态；正常文本不含该形态） */
const SHEET_COORDINATE_RE = /R\d{1,4}C\d{1,4}/u;

/** 表格结构标签/OCR 英文残片（表格标签词粘连为人名/字段串） */
const TABLE_FRAGMENT_RE = /CHECKE|SUBITEM|子项名称/u;

/** 表格跨行粘连行结构判据：≥3 非空行 + ≥2 个 ≤8 字碎片行 + ≥1 个纯编号行（表格编号列被拆出的产物，
 * 如「3.4.4 /」「3.6.1」；正当多行条款各行均为「编号+内容」长句——「2.4招标项目标段编号：…」不命中；
 * 碎片行/编号行强信号已足够，不设约束词守卫——表格粘连条款常含「方案/计划/要求」类词，守卫会漏判） */
const TABULAR_MIN_ROWS = 3;
const TABULAR_FRAGMENT_ROW_MAX = 8;
const TABULAR_PURE_NUMBER_ROW_RE = /^[\d.．、()（）\s/／-]{1,16}$/u;

/** 行结构判定（须用原文换行，不能先做空白归一） */
function looksTabularFragmented(raw: string): boolean {
  const rows = raw.split(/\r?\n/u).map(row => row.trim()).filter(Boolean);
  if (rows.length < TABULAR_MIN_ROWS) return false;
  const fragmentRows = rows.filter(row => row.replace(/\s+/gu, '').length <= TABULAR_FRAGMENT_ROW_MAX).length;
  if (fragmentRows < 2) return false;
  return rows.some(row => TABULAR_PURE_NUMBER_ROW_RE.test(row));
}

/** 编号粘连：5+ 位连续数字紧贴汉字开头（项目编号/页码串入值首，工程量值不会该形态） */
const NUMERIC_SMEAR_RE = /^\d{5,}[\u4e00-\u9fa5]/u;

/** 章节号打头残片（三段及以上点分编号 + ≤4 字极短尾：「5.1.1特殊」「1.3.1」——章节号列被拆出的产物）：
 * 首段 ≤2 位排除日期「2026.7.10」；段长 ≤2 位纯数字排除度量值「1.5m」「0.08mm」；尾 ≤4 字排除正当引用条目 */
const SECTION_NUMBER_HEAD_RE = /^[1-9]\d?(?:\.\d{1,2}){2,}[^\d\s]{0,4}$/u;

/** OCR 零串残片（3+ 连续零打头：「000L」「000g」图纸文字识别错切；「0.08」类正当值含小数点/非零数字不命中） */
const OCR_ZERO_SMEAR_RE = /^0{3,}[A-Za-z]?$/u;

/** 章节号+短尾残片扩围（4.55.12 巢湖实测：「2.1招标」——招标文件条款编号与题名粘连，值是条款标题
 * 而非工程参数，正文无从落位且永久拉低义务满足率）。尾段限定 1-4 个汉字**且非计量单位**：
 * 「1.5米」「2.5m」类正当值尾巴是单位词（且拉丁单位不命中），不受影响。 */
const SECTION_TITLE_SMEAR_RE = /^[1-9]\d?(?:\.\d{1,2}){1,3}[一-龥]{1,4}$/u;
const MEASURE_TAIL_RE = /(?:米|厘米|毫米|公里|吨|公斤|千克|平方|立方|天|年|月|日|小时|分钟|个|项|套|台|次|份|人|元|万元|度|伏|安|瓦|帕|吨位)$/u;

/** 编号尾粘连（4.55.12 巢湖实测：「2026AFMGZ508282.3」——项目编号 + 表格序号粘连，非可落位参数） */
const ID_TAIL_SMEAR_RE = /^\d{4}[A-Za-z]{1,8}\d{4,}\.\d+$/u;

/** 页眉/页码串格（4.55.12 巢湖实测：「第页共页」——图签页码栏 OCR 串格产物） */
const PAGE_HEADER_SMEAR_RE = /第页共页|^第?\d*页共\d*页$/u;

/** 表号/索引标号残片（「H.4」「E.1」「V10.0」独立存在无落位语义；强度等级类整体豁免——
 * M/C 砂浆混凝土「M7.5」、Mb/Ms 砂浆「Mb5.0」、L/LC 轻集料混凝土「LC5.0」、A 加气块「A3.5」、
 * DP 抹灰石膏「DP5.0」均为可落位真实参数，s28l 实测 LC5.0 正文已锚定被误出池） */
const INDEX_LABEL_RE = /^(?![MC]\d)(?![Mm][BbSs]?\d)(?![Ll][Cc]?\d)(?![Aa]\d)(?![Dd][Pp]\d)[A-Za-z]{1,4}\d{0,3}\.\d{1,3}$/u;

/** 表单占位残片（表格模板标记非正文内容：「（签章）」字段标记 / 「年月日」空日期占位 / 尾部空槽「：/」——
 * 判据具足够特异性：正式条款不出现「（签章）」字段标记与「年月日」空占位） */
const FORM_PLACEHOLDER_RE = /（签章）|\(签章\)|年月日|[:：]\s*[/／]\s*$/u;

/** 孤立日期值（独立 4 位年份 / 独立月份：图签/表单日期栏提取物，无事件绑定不可锚定；「2026年9月」含月绑定放行） */
const DATE_FRAGMENT_RE = /^(?:\d{4}年|\d{1,2}月)$/u;

/** 日期时间粘连（「2026.7.1018：16」日期尾与钟点串接；第三段 3+ 位数字判——正常日期第三段 ≤2 位） */
const DATETIME_SMEAR_RE = /\d{4}\.\d{1,2}\.\d{3,}/u;

/** 长值残片判据参数：超长且无句读，且含拉丁串/表面字段标签/长数字串 */
const LONG_VALUE_MAX = 60;
const LONG_VALUE_LATIN_RE = /[A-Za-z]{3,}|[A-Za-z]{1,3}\d{2,}|\d{6,}/u;
const VALUE_PUNCTUATION_RE = /[，。；,;]/u;

/** 图签特征命中计数（含 g flag 的 match 无 lastIndex 状态污染） */
function countDrawingSignatureHits(text: string): number {
  return (text.match(DRAWING_SIGNATURE_SCAN_RE) || []).length;
}

/**
 * 池噪声判定（要求池/参数池同源单源）：命中返回分类标签，未命中返回 undefined。
 * 判据顺序：坐标（最强形态）→ 表格残片 → 图签（命中特征且无约束词）→
 * 编号粘连族（值首数字串/章节号打头/OCR 零串/表号标号）→ 表单占位 → 孤立日期 →
 * 日期时间粘连 → 目录行 → 超长罗列值。
 */
export function classifyPoolNoiseText(text: string): PoolNoiseCategory | undefined {
  const raw = String(text || '');
  const normalized = raw.replace(/\s+/gu, '');
  // 门槛 3（判据形态最短 3 字符——表号标号「H.4」/独立月份「12月」；2 字符以内无区分度直接放行）
  if (normalized.length < 3) return undefined;
  const hasConstraint = POOL_CONSTRAINT_WORD_RE.test(normalized);
  if (SHEET_COORDINATE_RE.test(normalized)) return 'sheet_coordinate';
  // 表格残片：英文残片标签无约束语义（「子项名称」类标签粘连）；有约束词时仅在英文残片/表格标签同现时判定
  if (TABLE_FRAGMENT_RE.test(normalized) && (!hasConstraint || /CHECKE|SUBITEM/u.test(normalized))) return 'table_fragment';
  // 表格跨行粘连（行结构判定）：编号列碎片 + 短碎片行拼成的条款不可作为逐条响应单元
  if (looksTabularFragmented(raw)) return 'table_fragment';
  // 图签：命中任一特征且无约束词——单特征可能是正当条款用词（「按图施工须加盖出图章」）；
  // 多特征共现也可能是真实资格要求（「投标人须提供工程设计甲级资质证书」同含「工程设计甲级」与
  // 「资质证书」），约束词守卫须对全部命中数统一生效（D6 实机误伤修正：双特征短路曾绕过守卫）
  const signatureHits = countDrawingSignatureHits(normalized);
  if (signatureHits >= 1 && !hasConstraint) return 'drawing_signature';
  // 编号粘连族（残片高置信形态，不设约束词守卫——残片条款可含「方案/计划」类词）
  if (NUMERIC_SMEAR_RE.test(normalized)) return 'numeric_smear';
  if (SECTION_TITLE_SMEAR_RE.test(normalized) && !MEASURE_TAIL_RE.test(normalized)) return 'numeric_smear';
  if (ID_TAIL_SMEAR_RE.test(normalized)) return 'numeric_smear';
  if (PAGE_HEADER_SMEAR_RE.test(normalized)) return 'table_fragment';
  if (SECTION_NUMBER_HEAD_RE.test(normalized)) return 'numeric_smear';
  if (OCR_ZERO_SMEAR_RE.test(normalized)) return 'numeric_smear';
  if (INDEX_LABEL_RE.test(normalized)) return 'numeric_smear';
  // 表单占位（模板字段标记）/ 日期时间粘连 / 孤立日期值
  if (FORM_PLACEHOLDER_RE.test(normalized)) return 'table_fragment';
  if (DATETIME_SMEAR_RE.test(normalized)) return 'table_fragment';
  if (DATE_FRAGMENT_RE.test(normalized)) return 'date_fragment';
  if (TOC_LINE_RE.test(normalized)) return 'toc_line';
  // 超长罗列值（规范清单/表行粘连）：超长 + 无句读 + 含拉丁串/长数字串——工程正文长值（项目规模描述）含句读，不误伤
  if (normalized.length > LONG_VALUE_MAX && !VALUE_PUNCTUATION_RE.test(normalized) && LONG_VALUE_LATIN_RE.test(normalized)) {
    return 'listing_smear';
  }
  return undefined;
}

/** 布尔包装（消费侧简写） */
export function isPoolNoiseText(text: string): boolean {
  return classifyPoolNoiseText(text) !== undefined;
}

/**
 * 缓存指纹源（D6 形态判据变更须失效 LLM 判定缓存）：形态正则表源码序列化——
 * 判据口径任何变更自动 invalidate（消费侧 tenderRequirements.CACHE_JUDGE_FINGERPRINT_SOURCES 入表）。
 */
export const POOL_NOISE_RULE_SOURCES: ReadonlyArray<unknown> = [
  TOC_LINE_RE,
  DRAWING_SIGNATURE_RE,
  DRAWING_SIGNATURE_SCAN_RE,
  SHEET_COORDINATE_RE,
  TABLE_FRAGMENT_RE,
  NUMERIC_SMEAR_RE,
  SECTION_NUMBER_HEAD_RE,
  SECTION_TITLE_SMEAR_RE,
  MEASURE_TAIL_RE,
  ID_TAIL_SMEAR_RE,
  PAGE_HEADER_SMEAR_RE,
  OCR_ZERO_SMEAR_RE,
  INDEX_LABEL_RE,
  FORM_PLACEHOLDER_RE,
  DATE_FRAGMENT_RE,
  DATETIME_SMEAR_RE,
  LONG_VALUE_LATIN_RE,
  VALUE_PUNCTUATION_RE,
  TABULAR_MIN_ROWS,
  TABULAR_FRAGMENT_ROW_MAX,
  TABULAR_PURE_NUMBER_ROW_RE,
];
