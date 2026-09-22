/**
 * deliveryReviewReport：交付三件套报告（C6 交付报告类，v3 P5/D5 机制化）。
 *
 * 背景（repair-master-plan-v3 P5 item 16）：finalGate 收口此前只产内存态（最终阶段/评分对象/
 * telemetry）——「评分报告 / 进度 / 下轮预估目标」无文件产出，用户要报告需自行翻查或再提要求。
 * 本模块在终门禁收口时确定性聚合三件套并落盘 generatedDocuments/reports/<docId>-review.md：
 * ① 评分报告（六维主尺 + 专业分从属口径 + 阻断明细）② 进度（阶段/耗时/修复轮次）
 * ③ 下轮预估目标（按当前六维缺口计算各维提升空间、达标路径与预计总分上限）。
 *
 * 口径单源：数据全部来自 finalGate 收口时点的既有产物（六维报告/专业分/导出门禁/执行阶段/
 * 性能指标），零新增判定；下轮预估与主尺公式同源（加权平均 × uniqueness 因子，见
 * documentQualityReport 的 overall 计算）；修复轮次清单取自 detectorFixerRegistry 的
 * FINALIZE_REPAIR_ROUNDS 声明表（不另立轮次清单）。写盘为原子写（tmp + rename），
 * 失败由调用方降级记录，不阻断交付。
 */
import fs from 'node:fs';
import path from 'node:path';
import { generatedRoot } from '../document-core/generatedDocumentService';
import { FINALIZE_REPAIR_ROUNDS } from './detectorFixerRegistry';
import { SCORING_CALIBRATION_VERSION } from './scoringCalibration';
import type { ProfessionalScoreReport } from './documentProfessionalScore';
import type { DocumentExecutionStage, DocumentPerformanceMetric, DocumentQualityReport, ExportGateResult } from './types';

export interface DeliveryReviewReportInput {
  /** 文档 ID（报告文件命名 `<docId>-review.md`；未提供时由调用方跳过写盘） */
  documentId?: string;
  title: string;
  qualityReport: DocumentQualityReport;
  professionalScore: ProfessionalScoreReport;
  exportGate: ExportGateResult;
  stages: DocumentExecutionStage[];
  metrics: DocumentPerformanceMetric[];
  generatedAt?: number;
}

/** 单维下轮预估：缺口 → 对综合分的理论贡献（effectiveGain 口径，与主尺 overall 同源） */
export interface NextRoundDimensionTarget {
  key: string;
  label: string;
  score: number;
  /** 提升空间（维度分 → 100 的缺口） */
  gap: number;
  /** 补至满分对综合分的理论贡献 = 缺口 × 权重/权重和 × uniqueness 因子（1 位小数） */
  effectiveGain: number;
  detail?: string;
}

export interface NextRoundEstimate {
  dimensions: NextRoundDimensionTarget[];
  /** 当前加权综合分（dimensions 加权平均，1 位小数） */
  currentWeighted: number;
  uniquenessFactor: number;
  /** 预计总分上限（全维补满、uniqueness 不变的理论口径） */
  projectedOverall: number;
  /** 达标路径：按贡献降序贪心累计达标的维度集（已达标时为 null） */
  pathToTarget: { target: number; gap: number; picks: NextRoundDimensionTarget[]; covered: number } | null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 耗时格式化（<1s 毫秒 / <60s 秒 / 其余分钟，1 位小数） */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

const STAGE_STATUS_LABEL: Record<DocumentExecutionStage['status'], string> = {
  success: '通过',
  failed: '失败',
  skipped: '跳过',
  running: '进行中',
};

const MODE_LABEL: Record<NonNullable<DocumentQualityReport['mode']>, string> = {
  blind: '暗标',
  open: '明标',
  unknown: '未判定（按明标口径）',
};

/**
 * 下轮预估目标（确定性，与主尺公式同源）：dimensions 缺失时返回 undefined（降级不猜数）。
 * - 提升空间 gap = 100 − 维度分；理论贡献 effectiveGain = gap × weight/Σweight × uniqueness 因子；
 * - 预计总分上限 = round((加权综合分 + Σ贡献) × uniqueness 因子) = round(100 × 因子)（全维补满口径）；
 * - 达标路径：按贡献降序贪心累计至缺口（gap = target − overall）。
 */
export function estimateNextRoundTargets(report: Pick<DocumentQualityReport, 'overall' | 'target' | 'scores' | 'dimensions'>): NextRoundEstimate | undefined {
  const dimensions = (report.dimensions || []).filter(dimension => Number.isFinite(dimension.score) && Number.isFinite(dimension.weight) && dimension.weight > 0);
  if (dimensions.length === 0) return undefined;
  const weightSum = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const currentWeighted = round1(dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0) / weightSum);
  const uniquenessFactor = Math.min(1, (report.scores?.uniqueness ?? 90) / 90);
  const targets: NextRoundDimensionTarget[] = dimensions
    .map(dimension => ({
      key: dimension.key,
      label: dimension.label,
      score: dimension.score,
      gap: Math.max(0, 100 - dimension.score),
      effectiveGain: round1(Math.max(0, 100 - dimension.score) * (dimension.weight / weightSum) * uniquenessFactor),
      detail: dimension.detail,
    }))
    .sort((left, right) => right.effectiveGain - left.effectiveGain || left.label.localeCompare(right.label, 'zh-Hans-CN'));
  const gap = round1(report.target - report.overall);
  let pathToTarget: NextRoundEstimate['pathToTarget'] = null;
  if (gap > 0) {
    const picks: NextRoundDimensionTarget[] = [];
    let covered = 0;
    for (const target of targets) {
      if (target.effectiveGain <= 0) break;
      picks.push(target);
      covered = round1(covered + target.effectiveGain);
      if (covered >= gap) break;
    }
    pathToTarget = { target: report.target, gap, picks, covered };
  }
  return {
    dimensions: targets,
    currentWeighted,
    uniquenessFactor,
    projectedOverall: Math.min(100, Math.round(100 * uniquenessFactor)),
    pathToTarget,
  };
}

/** 三件套报告 markdown 构建（纯函数：零 I/O，便于单测与离线复算） */
export function buildDeliveryReviewReport(input: DeliveryReviewReportInput): string {
  const report = input.qualityReport;
  const gate = input.exportGate;
  const generatedAt = new Date(input.generatedAt ?? Date.now());
  const modeNote = report.mode ? MODE_LABEL[report.mode] : '未判定（按明标口径）';
  const lines: string[] = [];
  lines.push(`# 交付三件套报告：${input.title}`);
  lines.push('');
  lines.push(`> 文档 ID：${input.documentId ?? '未提供'}；生成时间：${generatedAt.toISOString()}`);
  lines.push(`> 评分口径：${SCORING_CALIBRATION_VERSION}（主尺=六维；招标六项/专业分为从属展示口径）`);
  lines.push(`> 导出门禁：${gate.passed ? '通过' : `未通过（${gate.blockingIssues.length} 项阻断，文档照常可导出，人工复核清单见下）`}；标书类型：${modeNote}`);
  lines.push('');

  // ═══ ① 评分报告 ═══
  lines.push('## 一、评分报告');
  lines.push('');
  lines.push('### 1.1 六维质量评分（主尺）');
  const dimensions = report.dimensions || [];
  if (dimensions.length > 0) {
    lines.push('| 维度 | 得分 | 权重 | 构成明细 |');
    lines.push('|---|---|---|---|');
    for (const dimension of dimensions) {
      lines.push(`| ${dimension.label} | ${dimension.score} | ${Math.round(dimension.weight * 100)}% | ${dimension.detail ?? '—'} |`);
    }
  } else {
    lines.push('- （六维构成明细缺失——评级输入不完整，仅综合分可用）');
  }
  lines.push(`- 综合评分：**${report.overall}**/100；交付置信度 **${report.deliveryProbability}%** / 目标 ${report.target}%；低雷同性 ${report.scores?.uniqueness ?? '—'}${report.passed ? '；已达当前质量目标' : '；未达目标（按第三节预估路径补强）'}`);
  lines.push('');
  lines.push('### 1.2 专业度评分（从属口径，交付主尺见六维）');
  lines.push(`- 总分 ${input.professionalScore.total}/100（${input.professionalScore.grade}）：${input.professionalScore.summary}`);
  if (input.professionalScore.dimensions.length > 0) {
    lines.push('');
    lines.push('| 维度 | 得分 | 权重 | 明细 |');
    lines.push('|---|---|---|---|');
    for (const dimension of input.professionalScore.dimensions) {
      lines.push(`| ${dimension.label} | ${dimension.score} | ${Math.round(dimension.weight * 100)}% | ${dimension.detail} |`);
    }
  }
  if (input.professionalScore.topIssues.length > 0) {
    lines.push('');
    lines.push('待修复：');
    for (const issue of input.professionalScore.topIssues.slice(0, 12)) lines.push(`- ${truncate(issue, 220)}`);
  }
  lines.push('');
  lines.push('### 1.3 阻断明细（终门禁）');
  if (gate.blockingIssues.length === 0) {
    lines.push('- 无阻断：终检检测器全部通过。');
  } else {
    for (const issue of gate.blockingIssues) {
      const tag = issue.severity ? `[${issue.severity}]` : `[${issue.level}]`;
      const anchor = issue.chapterId ? `（章：${issue.chapterId}${issue.sectionTitle ? ` / ${issue.sectionTitle}` : ''}）` : '';
      lines.push(`- ${tag} ${truncate(issue.message, 320)}${anchor}`);
      if (issue.suggestion) lines.push(`  - 建议：${truncate(issue.suggestion, 260)}`);
    }
  }
  // 4.55.22：人工复核清单（检测器声明 fixerDisposition='manual'：无自动修复路径）。
  // 注册表承诺「转人工复核」，但这类发现多为 warning 级、阻断明细只收 error —— 声明与可见性脱节。
  // 此节即该承诺的**实际载体**（不阻断导出，供人工跟进）。
  const manualReview = gate.manualReviewIssues || [];
  if (manualReview.length > 0) {
    lines.push('');
    lines.push(`### 1.4 人工复核清单（${manualReview.length} 项，不阻断导出）`);
    lines.push('');
    lines.push('> 下列发现由声明「无自动修复路径」的检测器产出，需人工判断后处理；系统不会自动改写。');
    for (const issue of manualReview.slice(0, 30)) {
      const detectorId = issue.provenance?.detectorId ? `[${issue.provenance.detectorId}]` : '';
      lines.push(`- ${detectorId} ${truncate(issue.message, 320)}`);
      if (issue.suggestion) lines.push(`  - 建议：${truncate(issue.suggestion, 260)}`);
    }
    if (manualReview.length > 30) lines.push(`- …另有 ${manualReview.length - 30} 项未展开`);
  }
  if (gate.checklist.length > 0) {
    const failed = gate.checklist.filter(item => !item.passed);
    lines.push('');
    lines.push(`- 门禁复核清单：通过 ${gate.checklist.length - failed.length}/${gate.checklist.length}${failed.length > 0 ? `；未过项：${failed.slice(0, 10).map(item => item.label).join('、')}${failed.length > 10 ? ` 等 ${failed.length} 项` : ''}` : ''}`);
  }
  lines.push('');

  // ═══ ② 进度（阶段/耗时/修复轮次） ═══
  lines.push('## 二、进度（阶段/耗时/修复轮次）');
  lines.push('');
  lines.push(`### 2.1 阶段执行（共 ${input.stages.length} 个阶段）`);
  for (const stage of input.stages) {
    const subtitle = stage.subtitle || stage.roleId;
    const message = stage.message ? `：${truncate(stage.message, 240)}` : '';
    lines.push(`- [${STAGE_STATUS_LABEL[stage.status]}] ${subtitle}${message}`);
  }
  lines.push('');
  lines.push('### 2.2 耗时（按耗时降序）');
  const metrics = [...input.metrics].sort((left, right) => right.durationMs - left.durationMs);
  if (metrics.length === 0) {
    lines.push('- （无性能指标记录）');
  } else {
    for (const metric of metrics) lines.push(`- ${metric.name}：${formatDuration(metric.durationMs)}`);
  }
  lines.push('');
  lines.push('### 2.3 修复轮次（detectorFixerRegistry 轮序声明表口径）');
  for (const roundId of FINALIZE_REPAIR_ROUNDS) {
    const stage = [...input.stages].reverse().find(item => item.roleId === roundId);
    if (stage) {
      const message = stage.message ? ` — ${truncate(stage.message, 200)}` : '';
      lines.push(`- ${roundId}：${STAGE_STATUS_LABEL[stage.status]}${message}`);
    } else {
      lines.push(`- ${roundId}：未记录（无触发或静默通过）`);
    }
  }
  lines.push('');

  // ═══ ③ 下轮预估目标 ═══
  lines.push('## 三、下轮预估目标（按当前六维缺口）');
  lines.push('');
  const estimate = estimateNextRoundTargets(report);
  if (!estimate) {
    lines.push('- 六维构成明细缺失，无法计算下轮预估（降级不猜数；补全评级输入后自动生成）。');
  } else {
    lines.push('| 维度 | 当前分 | 提升空间 | 对综合分贡献 | 补强方向 |');
    lines.push('|---|---|---|---|---|');
    for (const target of estimate.dimensions) {
      lines.push(`| ${target.label} | ${target.score} | ${target.gap > 0 ? `+${target.gap}` : '0（满分）'} | ${target.effectiveGain > 0 ? `+${target.effectiveGain.toFixed(1)}` : '0'} | ${target.detail ? truncate(target.detail, 120) : '—'} |`);
    }
    lines.push(`- 当前加权综合分：${estimate.currentWeighted.toFixed(1)}/100（uniqueness 因子 ${estimate.uniquenessFactor.toFixed(2)}）`);
    const upperBelowTarget = estimate.projectedOverall < report.target;
    lines.push(`- 预计总分上限：**${estimate.projectedOverall}**/100（全维补满、uniqueness 不变的理论口径${upperBelowTarget ? `；低于目标 ${report.target}——受低雷同性因子 ${estimate.uniquenessFactor.toFixed(2)} 约束，需同步提升 uniqueness` : ''}；实际以重生成/续修产物复评）`);
    if (estimate.pathToTarget) {
      const { target, gap, picks, covered } = estimate.pathToTarget;
      const chain = picks.map(pick => `${pick.label}（+${pick.effectiveGain.toFixed(1)}）`).join(' → ');
      if (covered >= gap) {
        lines.push(`- 达标路径（目标 ${target}）：补强 ${chain}，合计 +${covered.toFixed(1)} ≥ 缺口 ${gap.toFixed(1)}。`);
      } else {
        lines.push(`- 达标路径（目标 ${target}）：补强 ${chain}，合计 +${covered.toFixed(1)} < 缺口 ${gap.toFixed(1)}——六维补满仍不足，须按上限提示先提升低雷同性（uniqueness）再复评。`);
      }
    } else {
      lines.push(`- 当前已达目标 ${report.target}，无需补强路径（维持口径与阻断清零即可）。`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** 报告文件绝对路径（reports/<docId>-review.md；docId 清洗防路径注入） */
export function deliveryReviewReportPath(projectRoot: string, documentId: string): string {
  const safeId = documentId.trim().replace(/[^A-Za-z0-9_-]/gu, '_');
  if (!safeId) throw new Error('交付报告文件名缺少文档 ID');
  return path.join(generatedRoot(projectRoot), 'reports', `${safeId}-review.md`);
}

/** 原子写报告（tmp + rename，同 writeJson 范式）：返回报告文件绝对路径 */
export function saveDeliveryReviewReport(projectRoot: string, documentId: string, markdown: string): string {
  const file = deliveryReviewReportPath(projectRoot, documentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, markdown, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}
