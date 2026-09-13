/**
 * C1 挂起清单（批 1 收敛责任制收尾）：门禁未通过时把未收敛 blocker 转为结构化「精准人工清单」。
 *
 * 铁律三（失败响亮）：任何 failed/blocker 不允许静默收尾——要么修复收敛，要么显式挂起+精准未解决清单。
 * 修复侧已为每个 blocker 提供自动路径（单锚→确定性硬替换[数值裁决器]、多义→LLM 定向修复[带锚点+证据]、
 * 表格/结构类→确定性修复器），全部修复轮执行完仍残留的阻断项 = 无进一步自动收敛路径 → 显式挂起
 * （status=failed，不放行交付）并给出人工处理清单：分类 / 定位 / 问题 / 建议动作 / 修复路径追溯 / 检测器身份。
 *
 * 三挂载点（同源单一构建，保证三处内容一致）：
 * - 交付记录 warningIssues 首条（formatSuspensionBanner）：failed 后用户可见的挂起声明 + 摘要；
 * - 执行阶段 agent-final-gate details（formatSuspensionDetails）：逐条全量落盘（不截断），生成后审查/复盘；
 * - reviewMetadata.suspensionChecklist：结构化归档，支持基于 checkpoint 的续修定位与工具消费。
 */
import type { ValidationIssue } from './types';

/** 缺陷分类中文标签（与 ValidationIssue.category 封闭集一一对应；无 category 归「其他」） */
const CATEGORY_LABELS: Record<NonNullable<ValidationIssue['category']>, string> = {
  structure: '结构完整性',
  table: '表格质量',
  fact_consistency: '数值/事实一致性',
  evidence_coverage: '证据覆盖',
  professional_chain: '专业链条',
  control_loop: '控制闭环',
  format: '格式规范',
  style: '文风与模板化',
  scope: '范围与商务边界',
  qingtian_review: '全维度评审',
};

/** 修复路径追溯文案（repairability → 该类缺陷的自动修复路径与当前状态） */
const REPAIR_PATH_LABELS: Record<NonNullable<ValidationIssue['repairability']>, string> = {
  local_deterministic: '确定性修复器（已执行未收敛：核对该检测器与修复器口径是否同源）',
  llm_repairable: 'LLM 定向修复（自动轮次已耗尽：按定位与建议人工修订，或补齐锚点证据后续修重试）',
  manual_review: '人工复核（自动修复链不消费该类缺陷）',
  not_repair_needed: '系统判定无需修复（若仍阻断：复核检测器是否误报）',
};

const DEFAULT_ACTION = '人工核对后修订正文；修订必须同步导出源（doc.json.markdown）并复核守恒，或基于检查点续修重试。';

export interface SuspensionChecklistItem {
  /** 序号（1 起，与阻断计数一致） */
  index: number;
  /** 缺陷分类（category 中文标签；无 category 为「其他」） */
  category: string;
  /** 定位（章节标题/小节标题/message 编号前缀/全文） */
  location: string;
  /** 问题描述（issue.message 原文，不截断——人工清单必须可精准定位） */
  problem: string;
  /** 建议动作（suggestion；缺失时给通用修订动作） */
  action: string;
  /** 修复路径追溯：该类缺陷的自动修复路径与未收敛原因 */
  repairPath: string;
  /** 检测器身份（provenance.detectorId） */
  detectorId?: string;
}

export interface SuspensionChecklist {
  /** 挂起终态标记（恒 true；blocker 清零时不构建清单，交付为 completed） */
  suspended: true;
  generatedAt: number;
  /** 未收敛阻断总数 */
  total: number;
  /** 自动修复链状态说明（支撑「3 轮不收敛→挂起」的升级语义） */
  repairChainSummary: string;
  items: SuspensionChecklistItem[];
}

/** 定位解析：章节锚点（chapterId→标题，F2 字段优先）→ 小节锚点 → message 编号前缀 → 全文 */
function resolveLocation(issue: ValidationIssue, chapters?: ReadonlyArray<{ id: string; title: string }>): string {
  if (issue.chapterId) {
    const chapter = chapters?.find(item => item.id === issue.chapterId);
    if (chapter?.title) return issue.sectionTitle ? `${chapter.title} / ${issue.sectionTitle}` : chapter.title;
  }
  if (issue.sectionTitle) return issue.sectionTitle;
  // 检测器 message 常带编号定位前缀（「5.2 施工准备 正文不足：…」）：取编号+紧邻短语作定位，
  // 冒号前的缺陷概述（「正文不足」）不并入；无编号形态的前缀（「跨章一致性复核」）不作位置
  const numbered = issue.message.match(/^(\d{1,2}(?:\.\d{1,2}){1,3}[\s\u00a0]*[^\s：:]{2,24})[^：:]{0,24}[：:]/u);
  if (numbered) return numbered[1].trim();
  return '全文';
}

/**
 * 挂起清单构建（单一来源）：blockingIssues 全量转结构化条目，不截断、不聚合——
 * 精准人工清单要求每条可独立定位与复核；数量上界由检测器侧限幅保证（同 agent-final-gate 全量持久化口径）。
 */
export function buildSuspensionChecklist(
  blockingIssues: ReadonlyArray<ValidationIssue>,
  chapters?: ReadonlyArray<{ id: string; title: string }>,
): SuspensionChecklist {
  const items: SuspensionChecklistItem[] = blockingIssues.map((issue, position) => ({
    index: position + 1,
    category: issue.category ? CATEGORY_LABELS[issue.category] : '其他',
    location: resolveLocation(issue, chapters),
    problem: issue.message,
    action: issue.suggestion || DEFAULT_ACTION,
    repairPath: issue.repairability ? REPAIR_PATH_LABELS[issue.repairability] : '自动修复链已执行（残留待人工定位）',
    detectorId: issue.provenance?.detectorId,
  }));
  return {
    suspended: true,
    generatedAt: Date.now(),
    total: items.length,
    repairChainSummary: '全部自动修复轮已执行（确定性替换与定向 LLM 修复），残留阻断项无进一步自动收敛路径，已显式挂起（宁缺毋假：带病文档不作为交付件）',
    items,
  };
}

/** 单条摘要裁剪：banner 为可读概览，完整内容以 details/结构化清单为准 */
function clip(text: string, max = 80): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/**
 * 挂起声明横幅（warningIssues 置顶条）：显式挂起语义 + 阻断计数 + 前 N 条精准条目 + 完整清单指引。
 * failed 终态下用户第一眼可见「为什么不可交付、谁能修、去哪看完整清单」。
 */
export function formatSuspensionBanner(checklist: SuspensionChecklist, limit = 8): string {
  const head = checklist.items.slice(0, limit).map(item => `${item.index}.【${item.category}】${clip(item.location, 24)}：${clip(item.problem)}`);
  const more = checklist.total > limit ? `；…另 ${checklist.total - limit} 项` : '';
  return `导出门禁未通过：存在 ${checklist.total} 项未收敛阻断，已显式挂起——${checklist.repairChainSummary}。人工处理清单：${head.join('；')}${more}（完整清单见执行阶段「Agent 最终门禁」与交付复核清单）`;
}

/**
 * 挂起清单明细行（agent-final-gate stage details）：逐条全量，含问题原文与修复路径追溯，
 * 生成后审查可直接按行复盘每一条阻断的检测器身份与建议动作。
 */
export function formatSuspensionDetails(checklist: SuspensionChecklist): string[] {
  return checklist.items.map(item => {
    const detector = item.detectorId ? `｜检测器：${item.detectorId}` : '';
    return `${item.index}.【${item.category}】${item.location}｜${item.problem}｜修复路径：${item.repairPath}｜建议：${item.action}${detector}`;
  });
}
