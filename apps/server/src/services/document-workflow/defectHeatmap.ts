/**
 * P19 跨文档缺陷热力图：消费导出闭环报告（exportReports）历史，产出两类建议：
 * 1. 候选退役提示——某修复轮连续 N 份报告中零命中（且更早历史曾命中过，说明检测器确在运行），
 *    提示该轮可能已覆盖盲区外场景，可评估退役；
 * 2. 写作硬约束建议——某修复轮连续 N 份报告中高命中且修复失败率高（坏内容被 guard 拒绝/回滚），
 *    提示该缺陷应在写作前置规避，建议加入写作硬约束（writingConstraints）条目。
 * 纯函数、零 IO 依赖（结构化最小输入，可离线单测，也可在前端展示层消费）。
 *
 * P19b 写作硬约束自进化（受限版，默认关闭）：buildWritingConstraintsReminder 把高频缺陷建议
 * 压缩为 ≤300 字符的规避提醒，注入写作硬约束 L1 可变段末尾（stagePrepare 组装处）。
 */

/** 单份导出闭环报告中的修复轮热力单元（与 ExportReport.repairHeat 结构一致） */
export interface RepairHeatCell {
  hits: number;
  repaired: number;
  failed: number;
}

/** 热力图分析输入：单份报告的投影（历史按 exportedAt 升序排列） */
export interface RepairHeatHistoryEntry {
  exportedAt: number;
  repairHeat?: Record<string, RepairHeatCell>;
}

export interface DefectHeatmapAnalysis {
  /** 候选退役的修复轮 id 列表（连续零命中） */
  retireCandidates: string[];
  /** 建议加入写作硬约束的缺陷条目（“修复轮｜失败率%｜连续次数”形态，供展示与压缩） */
  constraintSuggestions: string[];
}

/** 连续判定窗口默认值（对齐 repairRoundBudget 默认 3：连续 3 份报告同向信号才触发建议） */
export const DEFECT_HEATMAP_WINDOW = 3;

/** 高命中且修复失败的失败率判定线（failed/hits ≥ 50% 视为修复失败为主） */
export const DEFECT_HEATMAP_FAILURE_RATIO = 0.5;

/** 写作硬约束规避提醒最大字符数（受限版注入上限） */
export const WRITING_CONSTRAINTS_REMINDER_MAX_CHARS = 300;

/** 修复轮 id → 人类可读缺陷类别描述（写作提醒/前端展示用；LLM 无法理解内部轮次 id，未知轮保留原 id） */
export const REPAIR_ROUND_LABELS: Record<string, string> = {
  'fact-landing-round': '未覆盖重要事实落地',
  'table-repair-round': '表格缺失或格式错误',
  'semantic-choice-conflict': '语义矛盾数值冲突',
  'deterministic-stage5': '确定性缺陷（来源罗列/内部术语/编造日期）',
  'formal-source-clean': '资料来源罗列话术',
  'qingtian-full-review': '全维度评审缺陷',
  'planned-section-final': '规划小节内容缺失',
  'commercial-strip': '商务数据泄漏',
  'table-deterministic-repair': '表格数据不一致',
  'post-review-surface': '评审后兜底缺陷',
  'terminology-strip': '内部术语泄漏',
  'toc-consistency': '目录与正文不一致',
};

/**
 * 跨文档缺陷热力图分析：按时间升序滑动窗口统计各修复轮信号。
 * 零命中判定：最近 DEFECT_HEATMAP_WINDOW 份报告中 hits 均为 0，且更早历史中该轮曾 hits > 0。
 * 高命中失败判定：最近 DEFECT_HEATMAP_WINDOW 份报告中每份 hits > 0 且 failed/hits ≥ 50%。
 */
export function analyzeDefectHeatmap(history: RepairHeatHistoryEntry[]): DefectHeatmapAnalysis {
  const retireCandidates: string[] = [];
  const constraintSuggestions: string[] = [];
  if (history.length < DEFECT_HEATMAP_WINDOW) return { retireCandidates, constraintSuggestions };
  const sorted = [...history].sort((a, b) => a.exportedAt - b.exportedAt);
  const window = sorted.slice(-DEFECT_HEATMAP_WINDOW);
  const earlier = sorted.slice(0, -DEFECT_HEATMAP_WINDOW);
  // 窗口内出现过的全部修复轮（缺失视为该轮零观测，不参与判定）
  const roundIds = new Set<string>();
  for (const entry of [...earlier, ...window]) {
    for (const roundId of Object.keys(entry.repairHeat || {})) roundIds.add(roundId);
  }
  for (const roundId of roundIds) {
    const windowCells = window.map(entry => entry.repairHeat?.[roundId]);
    const everHitEarlier = earlier.some(entry => (entry.repairHeat?.[roundId]?.hits ?? 0) > 0);
    // 候选退役：窗口内逐份零命中（含缺失观测不视为零命中），且更早历史曾命中过
    if (everHitEarlier && windowCells.every(cell => cell !== undefined && cell.hits === 0)) {
      retireCandidates.push(roundId);
    }
    // 写作硬约束建议：窗口内逐份高命中且修复失败率高
    const failureRatioHigh = windowCells.every(cell => cell !== undefined && cell.hits > 0 && cell.failed / cell.hits >= DEFECT_HEATMAP_FAILURE_RATIO);
    if (failureRatioHigh) {
      const failedRatio = windowCells.reduce((sum, cell) => sum + (cell ? cell.failed / cell.hits : 0), 0) / windowCells.length;
      constraintSuggestions.push(`${roundId}｜${(failedRatio * 100).toFixed(0)}%｜连续${DEFECT_HEATMAP_WINDOW}次`);
    }
  }
  return { retireCandidates, constraintSuggestions };
}

/**
 * 写作硬约束自进化提醒（受限版）：把热力图建议压缩为 ≤300 字符的规避提醒文本，
 * 注入写作硬约束 L1 可变段末尾；修复轮 id 映射为人类可读缺陷类别（LLM 可执行）；
 * 超过上限时按条目截断（保留前缀，条目完整性优先）。无建议时返回空字符串（调用方不注入）。
 */
export function buildWritingConstraintsReminder(constraintSuggestions: string[]): string {
  if (constraintSuggestions.length === 0) return '';
  const head = '【缺陷热力图自进化提醒（历史高频缺陷前置规避）】';
  const body = constraintSuggestions.map(item => {
    const [roundId, failureRate = '', streak = ''] = item.split('｜');
    const label = REPAIR_ROUND_LABELS[roundId] ?? roundId;
    const rateText = failureRate ? `（历史修复失败率 ${failureRate}）` : '';
    return `${label}${rateText}${streak}内高频出现，本章写作时前置规避。`;
  }).join(' ');
  const candidate = `${head} ${body}`;
  if (candidate.length <= WRITING_CONSTRAINTS_REMINDER_MAX_CHARS) return candidate;
  const trimmed = body.slice(0, WRITING_CONSTRAINTS_REMINDER_MAX_CHARS - head.length - 4).replace(/\s+$/u, '');
  return `${head} ${trimmed}…`;
}
