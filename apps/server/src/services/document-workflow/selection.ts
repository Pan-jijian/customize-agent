/**
 * 智能选择工具 — 替代所有 slice(0, N) 静默截断
 *
 * 核心原则：
 * 1. 永远不静默丢弃数据 — 必须通过评分函数选择最重要的
 * 2. 记录丢弃日志 — 让用户知道什么被跳过了
 * 3. 全量处理优先 — 只在真正受限于 LLM 上下文窗口时才截断
 */

/** 评分选择结果 */
export interface SelectionResult<T> {
  /** 选中的项（按分数降序） */
  selected: T[];
  /** 因预算不足被丢弃的项 */
  dropped: T[];
  /** 丢弃日志（用于诊断） */
  droppedLog: string[];
}

/**
 * 按分数排序后选择，记录丢弃日志
 *
 * @param items 候选项
 * @param scoreFn 评分函数（返回数字，越高越重要）
 * @param budget 预算（最大项数或最大总字符数）
 * @param label 标签（用于日志）
 */
export function selectByScore<T>(
  items: T[],
  scoreFn: (item: T) => number,
  budget: { maxItems?: number; maxChars?: number; charFn?: (item: T) => number },
  label = 'items',
): SelectionResult<T> {
  const maxItems = budget.maxItems ?? Number.MAX_SAFE_INTEGER;
  const maxChars = budget.maxChars ?? Number.MAX_SAFE_INTEGER;
  const charFn = budget.charFn ?? ((item: T) => JSON.stringify(item).length);

  const scored = items.map(item => ({ item, score: scoreFn(item) }));
  scored.sort((a, b) => b.score - a.score);

  const selected: T[] = [];
  const dropped: T[] = [];
  let totalChars = 0;

  for (const { item } of scored) {
    const chars = charFn(item);
    if (selected.length < maxItems && totalChars + chars <= maxChars) {
      selected.push(item);
      totalChars += chars;
    } else {
      dropped.push(item);
    }
  }

  const droppedLog: string[] = [];
  if (dropped.length > 0) {
    droppedLog.push(
      `[selection] ${label}: 预算 ${maxItems}项/${maxChars}字符 → 选中 ${selected.length}项(${totalChars}字符)，丢弃 ${dropped.length}项`,
    );
    // 列出丢弃的前 10 项摘要
    for (const item of dropped.slice(0, 10)) {
      const summary = typeof item === 'string' ? item.slice(0, 80) : JSON.stringify(item).slice(0, 80);
      droppedLog.push(`  - 丢弃: ${summary}`);
    }
    if (dropped.length > 10) droppedLog.push(`  ... 及其他 ${dropped.length - 10} 项`);
  }

  return { selected, dropped, droppedLog };
}

/**
 * 文本重要性评分：优先保留包含数字/参数/关键词的文本
 */
export function textImportanceScore(text: string): number {
  let score = 0;
  const len = text.length;
  if (len === 0) return 0;

  // 含数值（参数/数量/规格）→ 高重要
  const numberCount = (text.match(/\d+(?:\.\d+)?/gu) || []).length;
  score += numberCount * 3;

  // 含单位 → 中重要
  if (/m[23²³]?|mm|cm|km|t|kg|台|套|个|项|批|次|份|人|日历天|天|月|万元|元|%|MPa|kPa|kN|℃/iu.test(text)) score += 2;

  // 含标准编号 → 高重要
  if (/GB|JGJ|ISO|CJJ|CECS|DL|YB|SH|HG|SY|NB/iu.test(text)) score += 3;

  // 含关键工程术语 → 中重要
  if (/验收|质量|安全|工期|进度|成本|风险|危大|重点|难点|关键|控制|标准|规范|设计|施工|材料|设备/u.test(text)) score += 1;

  // 太短（<20字符）→ 低重要
  if (len < 20) score -= 1;

  // 来源标题 → 稍重要
  if (/项目名称|工程名称|招标人|建设地点|计划工期|质量标准|合同估算/u.test(text)) score += 2;

  return score;
}

/**
 * 事实重要性评分：优先保留数值型、项目基础型、必需型事实
 */
export function factImportanceScore(fact: { key?: string; fieldName?: string; fieldId?: string; value?: unknown; required?: boolean }): number {
  let score = 0;
  const label = `${fact.key || ''}${fact.fieldName || ''}${fact.fieldId || ''}`;
  const value = typeof fact.value === 'string' ? fact.value : typeof fact.value === 'number' ? String(fact.value) : '';

  // 必需事实 → 最高优先级
  if (fact.required) score += 10;

  // 含数值 → 高优先级
  if (/\d/u.test(value)) score += 5;

  // 项目基础事实
  if (/项目名称|工程名称|项目编号|招标人|建设单位|发包人|建设地点|建设规模|招标范围|施工范围|计划工期|合同工期|质量标准|合同估算|投资估算|最高投标限价/u.test(label)) score += 4;

  // 有单位的值
  if (/m[23²³]?|mm|cm|km|t|kg|台|套|个|万元|元|%|MPa|日历天/u.test(value)) score += 3;

  // 来源来自招标文件
  if (/招标文件|招标公告|投标人须知|前附表/u.test(fact.fieldId || '')) score += 2;

  return score;
}
