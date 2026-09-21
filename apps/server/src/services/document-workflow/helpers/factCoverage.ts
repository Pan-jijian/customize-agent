/**
 * helpers/factCoverage：事实覆盖检测（P3 拆分，逐字机械搬移自 documentGeneratorHelpers.ts）。
 * 依赖 projectBasicInfo（cleanInlineFactValue）。
 */
import type { DocumentFact } from '../types';
import { normalizeOcrFactText, stripFactLabelPrefix } from '../factsModel';
import { stringifyFactValue } from '../utils';
import { cleanInlineFactValue } from './projectBasicInfo';

export function normalizeForCoverage(value: string) {
  return normalizeOcrFactText(value)
    // V5 P6 run1 实测：事实值「（一标）--公共广场…」与正文「（一标）——公共广场…」断折号族写法不一致，
    // 致项目全名整段失配误报未落位——断折号族（含 ASCII 连字符）统一剥离
    .replace(/[\s,，.。:：;；|｜（）()《》<>【】"“”'‘’\-—–―─－〜～·•]/gu, '')
    .split('[').join('')
    .split(']').join('')
    .toLowerCase();
}

export function isCommercialSensitiveFactText(text: string) {
  return /工程造价|造价|报价|投标报价|报价明细|综合单价|单价|合价|金额|税率|增值税|利润|预留金|暂列金额|最高投标限价|招标控制价|合同估算价|合同估算价格|投资估算|估算价/u.test(text);
}

export function significantFactValue(value: unknown) {
  const text = cleanInlineFactValue(stringifyFactValue(value));
  if (!text || /资料未明确|系统暂未从知识库确认|未确认|待确认|无|暂无/u.test(text)) return '';
  if (/###|第\s*\d+\s*页|共\s*\d+\s*页|新版交易系统|操作帮助|登录页面|见招标公告|未尽事宜|详见图纸|招标文件补疑|政府相关文件|规范等其它资料/u.test(text)) return '';
  if (/^\d+(?:\.\d+)?\s*(?:mm|cm|m|㎡|m²|m3|m³|%|元|万元)?$/iu.test(text)) return '';
  if (isCommercialSensitiveFactText(text)) return '';
  if (text.length > 160) return '';
  return text;
}

/** V5 P6 run1 实测垃圾候选过滤：清单表行/图纸签章 OCR 乱串/表单残片混入「项目名称」「招标人」
 *  候选（30 条未落位中近半为不可落位的坏值）——坏值不仅制造告警噪声，还会驱动事实落位
 *  补写轮把子虚乌有的“事实”写进正文，必须在候选筛选阶段拦截。 */
export function isMisExtractedFactText(labelText: string, valueText: string) {
  // 文件名残留（「招标补疑-…doc」「…图纸.pdf」被当字段值）
  if (/\.(?:docx?|pdf|xlsx?|zip|rar)$/iu.test(valueText)) return true;
  // 图纸签章 OCR 乱串（ANHUIURBANCONSTRUCTIONDESIGN…）与章体人名连续重复（魏永魏永）
  if (/[A-Z]{8,}/u.test(valueText)) return true;
  if (/([\u4e00-\u9fa5]{2,3})\1/u.test(valueText)) return true;
  // 签章/表单残片（（公章）（签章）住所：法定代表人：年月日）与以标签冒号结尾的残片
  if (/[（(](?:公章|签章|签名|盖章)[）)]|住所：|法定代表人：|委托代理人：|年月日/u.test(valueText)) return true;
  if (/[：:]$/u.test(valueText)) return true;
  if (/^见.{0,12}(?:前附表|须知|公告|文件)/u.test(valueText)) return true;
  // 纯标签词/清单口径行
  if (/^(?:项目所在地|项目名称|工程名称|标段名称|分部小计|小计|合计|总计|计量单位)$/u.test(valueText)) return true;
  // 编号指引前缀混入项目名称（「项目编号：<内容>」「标段名称：」）
  if (/^(?:项目编号|招标项目编号|标段名称|询标日期)[：:]/u.test(valueText)) return true;
  // 机构字段的句子混入（招标人=「不再承担该费用」「本公司（单位）拟参加项目的投标」）
  if (/招标人|建设单位|发包人/u.test(labelText) && /投标|参加|承担|费用|协商|贯彻|方针|为了/u.test(valueText)) return true;
  // ===== 4.27.0 A5 基线实测（agent-fact-landing-1 failed）：落位候选 7 条中 6 条为下列形态坏值，
  // 坏值令 LLM 无法落位（factPatchCount=0→未生效），必须在候选筛选阶段拦截 =====
  // CJK 扩展区乱码串（OCR 提取残渣「帉䝷搌陓笍免鬐」，含 Ext A 生僻字，工程文本不会使用）
  if (/[\u3400-\u4DBF\uE000-\uF8FF]/u.test(valueText)) return true;
  // 表格坐标残渣前缀（「R6C3COL3：上海开艺设计集团有限公司」——行列坐标粘连在真实值前）
  if (/^[A-Z]\d[A-Z]\d/u.test(valueText)) return true;
  // 模板占位符（招标文件模板空括号「（合同名称）」被当字段值）
  if (/^[（(][^）)]{1,12}[）)]$/u.test(valueText) && /名称|编号|单位|日期|签章|公章|甲方|乙方/u.test(valueText)) return true;
  // 机构/名称字段的动词引导句子碎片（「将报公共资源交易监督管理部门」）
  if (/招标人|建设单位|发包人|项目名称|工程名称/u.test(labelText) && /^(?:将报|拟报|应按|应报|须报|须按|拟按)/u.test(valueText)) return true;
  // 位置谓语残句（「本项目位于肥西县丰乐镇」——句子形态而非字段值，归一化后与表值「XX县XX镇」失配）
  if (/^(?:本项目|项目|工程)(?:位于|地处|坐落在?|选址在?)/u.test(valueText)) return true;
  // 分点长句残段（「二是水环境治理，涵盖…」——同源长句的中后段，正文生成阶段已按分项覆盖，整段落位不可行）
  if (/^[（(]?[一二三四五六七八九十]{1,3}[）)]?是/u.test(valueText)) return true;
  return false;
}

export function factValueAppears(markdown: string, value: string) {
  const normalizedMarkdown = normalizeForCoverage(markdown);
  const normalizedValue = normalizeForCoverage(value);
  if (!normalizedValue || normalizedValue.length < 2) return true;
  if (normalizedMarkdown.includes(normalizedValue)) return true;
  // V5 P6 长值 70% 前缀泛化（run1 实测：正文章节标题处常写全名简写形态，与事实原文尾部差异失配）
  if (normalizedValue.length >= 10 && normalizedMarkdown.includes(normalizedValue.slice(0, Math.floor(normalizedValue.length * 0.7)))) return true;
  const numericParts = value.match(/\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年|万元|元|平方米|㎡|m²|立方米|m³|米|m|mm|cm|台|套|人|项|%|MPa|kPa)?/giu) || [];
  if (numericParts.length > 0 && numericParts.some(part => normalizeForCoverage(part).length >= 2 && normalizedMarkdown.includes(normalizeForCoverage(part)))) return true;
  // V5 P6 短语分片兜底（run1 实测：「主要施工内容包含…」被正文以「工程内容涵盖…」改写，引导词差异
  // 致整段失配；招标人双主体被正文拆开分别引用）：值按标点切分短语（≥4 字、去尾「等」），
  // 命中短语字数合计 ≥ 值长度一半且命中 ≥2 个短语视为已使用——同一信息的引用形态差异不判未落位
  const phrases = value.split(/[、，,；;。：:\s]+/u).map(part => normalizeForCoverage(part.replace(/等$/u, ''))).filter(part => part.length >= 4);
  if (phrases.length >= 2) {
    const hitChars = phrases.filter(part => normalizedMarkdown.includes(part)).reduce((sum, part) => sum + part.length, 0);
    if (hitChars >= normalizedValue.length * 0.5 && hitChars >= 8) return true;
  }
  return false;
}

export function uncoveredImportantFacts(markdown: string, facts: DocumentFact[]): { fact: DocumentFact; label: string; value: string }[] {
  const important = facts.filter(fact => {
    const labelText = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
    const valueText = stringifyFactValue(fact.value);
    if (isCommercialSensitiveFactText(`${labelText}${valueText}`)) return false;
    if (!significantFactValue(valueText)) return false;
    if (isMisExtractedFactText(labelText, valueText)) return false;
    // 清单表「项目名称」列是清单条目名（材料/分项/费用行）而非工程全名，不可作落位候选
    if (/项目名称|工程名称/u.test(labelText)
      && (fact.processingType === 'table' || fact.processingType === 'structured_data' || /bill_of_quantities/u.test(fact.roleId || ''))) return false;
    if (/第\s*\d+\s*页|新版交易系统|操作帮助|见招标公告|未尽事宜|详见图纸|招标文件补疑|政府相关文件|规范等其它资料/u.test(`${labelText}${valueText}${fact.sourceFile || ''}`)) return false;
    return /项目名称|工程名称|项目编号|招标项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|计划工期|合同工期|质量标准|质量目标/u.test(labelText)
      || (/危大|安全|资源|材料|机械|设备/u.test(labelText) && !/^\d+(?:\.\d+)?\s*(?:mm|cm|m|㎡|m²|m3|m³|%|元|万元)?$/iu.test(valueText))
      // B5 关键精确参数落位（丰乐镇第三轮实测：可靠精确参数抽查 1/10，1.4天/103㎡/106㎡ 未落位）：
      // 高价值单位参数（面积/长度/强度/管径/天数等）与 preciseFactUsageIssues 关键参数抽查同源，纳入事实落位轮
      || (/面积|占地|建筑面积|长度|宽度|高度|厚度|深度|强度|等级|坡度|管径|直径|规格|跨度|天数|工期|周长|体积|重量/u.test(labelText) && /^\d+(?:\.\d+)?\s*(?:㎡|m²|m2|m³|m3|m|mm|cm|km|MPa|kPa|kN|天|日历天|日|级|%|台|套|座|个|t|kg)/iu.test(valueText));
  });
  const seen = new Set<string>();
  const missing: Array<{ fact: DocumentFact; label: string; value: string }> = [];
  for (const fact of important) {
    // 4.27.0 A5：标签前缀混入值清洗后参与落位判定与指令生成（清洗口径与回滚复检一致）
    const value = stripFactLabelPrefix(significantFactValue(fact.value));
    if (!value) continue;
    const label = fact.fieldName || fact.key || fact.fieldId || '资料事实';
    const key = `${label}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (factValueAppears(markdown, value)) continue;
    missing.push({ fact, label, value });
    // 上限治理：**不设遗漏上限**。原实现 `if (missing.length >= maxItems) break` 会让
    // 超出的事实永不进入补写指令——而这是「已确认事实未落位」的唯一修复通道，
    // 截断即交付缺项。指令规模由渲染层的 token 预算决定，不由「取前 N 条」决定。
  }
  return missing;
}

export function factCoverageIssues(markdown: string, facts: DocumentFact[]) {
  return uncoveredImportantFacts(markdown, facts).map(item => ({ level: 'warning' as const, message: `已确认事实未在正文中落位：${item.label}=${item.value}`, suggestion: '请将该事实自然写入对应章节或小节，不得改变原始数值和单位。' }));
}
