/**
 * 量化参数/精确值识别正则的统一口径（唯一权威来源）。
 * 各文件禁止再内联定义 mm/cm/m³/MPa 类单位正则：
 * - 数值+单位、标准编号、尺寸乘式的提取统一走 PRECISE_TOKEN_RE；
 * - 事实行是否量化走 QUANTIFIED_FACT_RE；
 * - 事实值是否含数值/单位/型号走 HAS_QUANTIFIED_VALUE_RE；
 * - 证据行是否含量化参数走 EVIDENCE_PARAMETER_RE；
 * - 工艺参数（kN/坡度/压实度等）与设备规格走本文件 PROCESS_PARAMETER_RE / DEVICE_SPEC_RE。
 */

/** 精确参数/编号提取：数值+单位、尺寸乘式、标准规范编号（GB/JGJ/ISO 等） */
export const PRECISE_TOKEN_RE = /(?:\b[A-Z]{1,8}[\w./-]*\d[\w./-]*\b|\b\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年|万元|元)\b|\b\d+\s*[×xX]\s*\d+(?:\s*[×xX]\s*\d+)?\b|\b(?:GB|GB\/T|ISO|IEC|IEEE|RFC|API|DB\d*|T\/[A-Z]+)\s*[\w.-]+\b)/giu;

/** 事实行量化判断：数值+单位、管径/直径 DN/φ/Φ、标准编号 GB/JGJ */
export const QUANTIFIED_FACT_RE = /\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年)|DN\s*\d+|φ\s*\d+|Φ\s*\d+|GB\s*\d+|JGJ\s*\d+/iu;

/** 事实值是否含数值/单位/型号（事实值筛选与参数事实判定共用同一口径） */
export const HAS_QUANTIFIED_VALUE_RE = /\d|DN|φ|Φ|mm|cm|m²|m3|m³|MPa|kPa|℃|%|GB|JGJ|ISO|IEC|台|套|个|项|批|次|份|人|㎡|日历天|万元|元|型号|规格|数量|单位/iu;

/** 证据行是否含可量化参数：数值+单位、管径、混凝土/钢筋牌号、标准编号、尺寸乘式 */
export const EVIDENCE_PARAMETER_RE = /\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年)|DN\s*\d+|Φ\s*\d+|φ\s*\d+|C\d{2,}|HRB\d+|GB\/?T?\s*[\w.-]+|JGJ\s*[\w.-]+|\d+\s*[×xX]\s*\d+/iu;

/** 工艺参数（强度等级/尺寸/时间/绝缘电阻/坡度/压实度/试验类等）：分部分项施工方案小节的参数密度校验与专业评分共用口径。
 * 多字符单位（m³/m²/㎡/m/s）必须先于单字符 m 参与交替，避免贪婪截断误配。 */
export const PROCESS_PARAMETER_RE = /\d+(?:\.\d+)?\s*(?:m³|m3|m²|㎡|mm|cm|m\/s|m|km|MPa|kN|kN\/m²|kPa|℃|%|d|h|min|MΩ|t|次\/天)|[MC]\d{1,3}(?:\.\d+)?|[<>≤≥]\s*\d+(?:\.\d+)?\s*(?:mm|MPa|%|d)|间距[≤<]?\s*\d+|偏差[≤<]?\s*\d+|坡度\s*\d+(?:\.\d+)?(?::\d+|%)|压实度\s*[≥>]?\s*\d+|坍落度|闭水试验|静载试验|拉拔试验|拉拔检测|探伤|试验压力|锚固长度|搭接长度|保护层厚度|养护时间|饱满度|垂直度|平整度|含水率|(?:防护挑网|安全网|防护网|围挡|警戒(?:区|线|距离)|防护栏杆).{0,12}(?:宽度|高度|距离|范围)[^，。；;]{0,8}\d+(?:\.\d+)?\s*m|(?:宽度|高度|距离|范围)[^，。；;]{0,8}\d+(?:\.\d+)?\s*m.{0,12}(?:防护挑网|安全网|防护网|围挡|警戒|防护栏杆)/giu;

// 设备配置参数（配电箱/控制箱型号、容量、IP 等级等）：设备清单型小节以型号规格为参数载体
export const DEVICE_SPEC_RE = /\d[A-Z][A-Z0-9a-z]*\b|[A-Z]{1,2}\d{2,3}\b|\d+(?:\.\d+)?\s*(?:kW|kVA|KVA|KW)\b|IP\d{2}/gu;

/** 正文量化参数（专业评分"事实落位率"与参数密度检查共用口径）：数值+常用单位 */
export const QUANTIFIED_BODY_PARAM_RE = /\d+(?:\.\d+)?\s*(?:m²|㎡|m3|m³|mm|cm|m|km|kg|t|MPa|kPa|℃|%|日历天|天|层|台|套|个|项|次|份|人|小时)/giu;
