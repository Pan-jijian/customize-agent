/** 青天全维度评审的确定性前置/后置工具（阶段四）：
 * 1. 前置：跨章数据一致性确定性扫描——分块评审天然盲区（同章跨块/跨章矛盾 LLM 看不到全文），
 *    评审前把全文关键数字（劳动力高峰/装配率/支护形式/工期/面积/质量标准）跨章比对，
 *    产出"疑似矛盾清单"注入评审 prompt，LLM 只负责确认定位与定性（评分报告漏检 180人/装配率/支护矛盾根因）；
 * 2. 后置：评审输出 location 与正文标题集合比对——LLM 幻觉定位（实测"5.4劳动力表"实为 2.3 节）
 *    不在标题集合内的定位标注"待核"，阻断错误定位进入修复定位与评分报告。
 */
import type { DocumentDraftChapter } from './types';

export interface CrossChapterDataConflict {
  field: string;
  occurrences: Array<{ value: string; chapter: string; snippet: string }>;
}

interface FieldScan {
  field: string;
  /** 提取正则（全局，捕获组 1 为取值） */
  pattern: RegExp;
  /** 提取上下文必须命中（如支护形式词必须出现在支护/基坑语境，防止误抓正文其他位置的形式词） */
  contextRequired?: RegExp;
  /** 取值归一化（剥离前导动词等，保证同口径取值可比） */
  normalize?: (value: string) => string;
  /** V5 P6 数字前窗口豁免（run1 实测）：「总工期」模式把「该阶段工期仅10天」「机动工期16天」
   *  「上表五个阶段合计工期344天」「总工期目标分解为29天」等阶段/机动/合计/分解语境全数
   *  误抓为总工期另一取值——窗口=匹配起点前 8 字 + match 内数字前文本，命中即非本字段口径。 */
  valuePrefixExempt?: RegExp;
  /** V5 P6 数字前 20 字豁免（run1 实测）：「劳动力高峰人数」模式1 把「该阶段劳动力投入
   *  238人」「按工种构成分为绿化工163人」「电工1人、管道工10人」等阶段/工种配置句
   *  误抓为高峰人数另一取值——阶段限定句与工种句均为分口径表述，非高峰单一取值。 */
  valueSubjectExempt?: RegExp;
  /** V5 P6 所在句豁免（run1 实测）：蓝图声明句「该阶段劳动力按蓝图推导统一为238人」是
   *  分阶段推导口径，非「劳动力高峰人数」字段取值，与峰值 276 构成假冲突注入评审 prompt。 */
  sentenceExempt?: RegExp;
}

/**
 * 关键字段确定性提取器：语境词限定避免把任意"X人/X%"误当关键字段取值。
 * 数字前缀窗口字符类必须排除数字（`[^。；\n]{0,18}` 贪婪回溯会把"180"拆成"0"——
 * `\d+` 只分到最后一位，实测值恒为"0"）。
 */
const FIELD_SCANS: FieldScan[] = [
  {
    field: '劳动力高峰人数',
    pattern: /(?:劳动力|用工)(?:高峰期|高峰|峰值)?[^。；\n\d]{0,18}(\d+(?:\.\d+)?)\s*人/gu,
    sentenceExempt: /按蓝图|蓝图推导|推导值|推导口径/u,
    valueSubjectExempt: /阶段|按工种|工种构成|工种配置|(?:[\u4e00-\u9fa5]{1,3}(?:工|员|长)|司机|班组|队伍?)\s*$/u,
  },
  // 评分报告 P1 盲区：「按高峰期总人数20人」「高峰期投入86人」无劳动力/用工前缀，第一条模式漏抓；
  // 高峰期/峰值语境词前置即可（配专职安全员等反向句不属于本模式，由 resourceConsistencyIssues 同池负责）
  {
    field: '劳动力高峰人数',
    pattern: /(?:高峰期|高峰|峰值)[^。；\n\d]{0,14}(\d+(?:\.\d+)?)\s*人/gu,
    sentenceExempt: /按蓝图|蓝图推导|推导值|推导口径/u,
  },
  { field: '装配率', pattern: /(?:装配率|预制率)[^。；\n\d%]{0,12}(\d+(?:\.\d+)?)\s*%/gu },
  { field: '装配率', pattern: /(\d+(?:\.\d+)?)\s*%[^。；\n]{0,6}(?:装配率|预制率)/gu },
  { field: '支护形式', pattern: /(放坡|喷锚|土钉墙|灌注桩|排桩|地下连续墙|SMW工法桩|钢板桩|复合土钉墙)/gu, contextRequired: /支护|围护|基坑/u },
  { field: '总工期', pattern: /(?:总工期|计划工期|工期)[^。；\n\d]{0,10}(\d+)\s*(?:个)?(?:日历天|天)/gu, valuePrefixExempt: /阶段|机动|合计|分解|目标|用时|仅|延误/u },
  { field: '总建筑面积', pattern: /(?:总建筑面积|单体建筑面积|建筑面积)[^。；\n\d]{0,10}(\d+(?:\.\d+)?)\s*(?:㎡|平方米|m2|m²)/gu },
  { field: '质量标准', pattern: /质量(?:目标|标准)[^。；\n]{0,14}(合格|优良|省优|国优|市优|[\u4e00-\u9fa5]{2,6}(?:杯|奖))/gu, normalize: value => value.replace(/^(?:确保|争创|争取|力争|获得|达到|争获|创建|力创|评为|荣获)/u, '') },
];

/**
 * 跨章数据一致性确定性扫描：同一关键字段在全文出现 ≥2 个不同取值且分布在 ≥2 个章节 → 疑似矛盾。
 * 扫描只产出候选（词面提取，无语义），确认与定性由青天评审 LLM 完成——误报代价低，漏报代价高。
 */
export function scanCrossChapterDataConflicts(chapters: DocumentDraftChapter[]): CrossChapterDataConflict[] {
  const byField = new Map<string, Array<{ value: string; chapter: string; snippet: string }>>();
  for (const chapter of chapters) {
    const content = chapter.content || '';
    if (!content) continue;
    for (const scan of FIELD_SCANS) {
      for (const match of content.matchAll(scan.pattern)) {
        const rawValue = (match[1] || '').replace(/\s+/gu, '');
        if (!rawValue) continue;
        const matchIndex = match.index || 0;
        const snippet = content.slice(Math.max(0, matchIndex - 12), matchIndex + 26).replace(/\s+/gu, ' ').trim();
        if (scan.contextRequired && !scan.contextRequired.test(snippet)) continue;
        // V5 P6 字段级豁免（run1 实测假冲突注入根因）：数字前窗口/所在句命中豁免词即非本字段取值
        const numberIndex = matchIndex + match[0].lastIndexOf(rawValue);
        if (scan.valuePrefixExempt && scan.valuePrefixExempt.test(content.slice(Math.max(0, matchIndex - 8), numberIndex))) continue;
        if (scan.valueSubjectExempt && scan.valueSubjectExempt.test(content.slice(Math.max(0, numberIndex - 20), numberIndex))) continue;
        if (scan.sentenceExempt) {
          const sentenceStart = Math.max(
            content.lastIndexOf('。', matchIndex),
            content.lastIndexOf('；', matchIndex),
            content.lastIndexOf(';', matchIndex),
            content.lastIndexOf('\n', matchIndex),
          ) + 1;
          let sentenceEnd = content.length;
          for (const boundary of ['。', '；', ';', '\n']) {
            const boundaryIndex = content.indexOf(boundary, matchIndex);
            if (boundaryIndex >= 0 && boundaryIndex < sentenceEnd) sentenceEnd = boundaryIndex;
          }
          if (scan.sentenceExempt.test(content.slice(sentenceStart, sentenceEnd))) continue;
        }
        const value = scan.normalize ? scan.normalize(rawValue) : rawValue;
        if (!value) continue;
        const list = byField.get(scan.field) || [];
        list.push({ value, chapter: chapter.title, snippet });
        byField.set(scan.field, list);
      }
    }
  }
  const conflicts: CrossChapterDataConflict[] = [];
  for (const [field, occurrences] of byField) {
    const distinctValues = new Set(occurrences.map(item => item.value));
    const distinctChapters = new Set(occurrences.map(item => item.chapter));
    if (distinctValues.size >= 2 && distinctChapters.size >= 2) conflicts.push({ field, occurrences });
  }
  return conflicts;
}

/** 疑似矛盾清单 → 评审 prompt 注入行（确定性扫描输出，LLM 逐项核对确认） */
export function formatKnownConflictLines(conflicts: CrossChapterDataConflict[]): string {
  if (conflicts.length === 0) return '';
  return conflicts.map(conflict => {
    const values = [...new Set(conflict.occurrences.map(item => item.value))].join(' ↔ ');
    const locations = conflict.occurrences.slice(0, 4).map(item => `${item.chapter}：“${item.snippet}”`).join('；');
    return `- ${conflict.field}：${values}（${locations}）`;
  }).join('\n');
}

/** 正文标题集合：章节标题 + 正文 H2~H4 小节标题行（评审输出 location 校验基准） */
export function collectDocumentHeadings(chapters: DocumentDraftChapter[]): string[] {
  const headings: string[] = [];
  for (const chapter of chapters) {
    headings.push(chapter.title);
    for (const line of (chapter.content || '').split('\n')) {
      const match = /^#{2,4}\s+(.+)$/u.exec(line.trim());
      if (match) headings.push(match[1].trim());
    }
  }
  return headings;
}

/**
 * 评审输出定位后置校验：location 与正文标题集合比对（相等/互含即有效），
 * 不在集合内的幻觉定位（实测"5.4劳动力表"实为 2.3 节）标注"待核"并保留原定位供人工核对，
 * 阻断错误定位进入修复定位（locateChapterByIssue 按标题反查失败已兜底）与评分报告。
 */
export function sanitizeIssueLocation(location: string, headings: string[]): string {
  const trimmed = (location || '').trim();
  if (!trimmed) return trimmed;
  const valid = headings.some(heading => heading === trimmed || heading.includes(trimmed) || trimmed.includes(heading));
  return valid ? trimmed : `待核（原定位：${trimmed.slice(0, 40)}）`;
}
