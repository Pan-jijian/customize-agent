/**
 * deliveryReviewReport 单测（C6 交付报告类，c6-3 检测校准）：
 * - 正样本：三件套结构（评分报告/进度/下轮预估）、口径版本标注、六维表、专业分从属、阻断明细、
 *   修复轮次两态、下轮预估公式（与主尺同源：加权 × uniqueness 因子）与达标路径；
 * - 反样本：dimensions 缺失降级不猜数、无阻断显性行、空白 docId 拒绝、权重非正维度过滤；
 * - 防误伤守护：自引用守护（报告内容不含交付报告自身 roleId）、确定性（同输入逐字节一致）、
 *   docId 清洗防路径注入（写盘不越出 reports 目录）、原子写无 tmp 残留。
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FINALIZE_REPAIR_ROUNDS } from '@/services/document-workflow/detectorFixerRegistry';
import { SCORING_CALIBRATION_VERSION } from '@/services/document-workflow/scoringCalibration';
import { QUALITY_DIMENSION_WEIGHTS } from '@/services/document-workflow/documentQualityReport';
import {
  buildDeliveryReviewReport,
  deliveryReviewReportPath,
  estimateNextRoundTargets,
  formatDuration,
  saveDeliveryReviewReport,
  type DeliveryReviewReportInput,
} from '@/services/document-workflow/deliveryReviewReport';
import type { ProfessionalScoreReport } from '@/services/document-workflow/documentProfessionalScore';
import type { DocumentExecutionStage, DocumentQualityDimension, DocumentQualityReport, ExportGateResult } from '@/services/document-workflow/types';

// ── fixture（与主尺权重同源：维度权重直接取 QUALITY_DIMENSION_WEIGHTS）──

const DIMENSION_SCORES: Record<string, number> = { requirement: 80, structure: 90, dataAnchor: 70, professionalDepth: 60, compliance: 100, factIntegrity: 50 };
const DIMENSION_LABELS: Record<string, string> = { requirement: '要求实体响应', structure: '结构呈现落实', dataAnchor: '数据锚定', professionalDepth: '专业深度', compliance: '合规与规范', factIntegrity: '事实完整与一致性' };

function dimensions(): DocumentQualityDimension[] {
  return (Object.keys(QUALITY_DIMENSION_WEIGHTS) as Array<keyof typeof QUALITY_DIMENSION_WEIGHTS>).map(key => ({
    key,
    label: DIMENSION_LABELS[key],
    score: DIMENSION_SCORES[key],
    weight: QUALITY_DIMENSION_WEIGHTS[key],
    detail: `${DIMENSION_LABELS[key]}构成明细`,
  }));
}

function qualityReport(overrides: Partial<DocumentQualityReport> = {}): DocumentQualityReport {
  return {
    overall: 68,
    deliveryProbability: 62,
    target: 95,
    passed: false,
    scores: { completeness: 78, specificity: 70, compliance: 88, executability: 66, normalization: 82, uniqueness: 81 },
    summary: '综合 68/100：数据锚定与专业深度为短板。',
    actions: ['补强数据锚定'],
    mode: 'open',
    dimensions: dimensions(),
    ...overrides,
  };
}

function professionalScore(): ProfessionalScoreReport {
  return {
    total: 74,
    grade: '合格',
    dimensions: [{ key: 'structure', label: '结构', score: 78, detail: '结构基本完整', weight: 0.2 }],
    summary: '专业分 74（合格）',
    topIssues: ['参数落位待补'],
    caliber: { version: SCORING_CALIBRATION_VERSION, role: 'secondary', relatedTo: 'quality-report' },
  };
}

function exportGate(overrides: Partial<ExportGateResult> = {}): ExportGateResult {
  return {
    passed: false,
    blockingIssues: [{ level: 'error', severity: 'blocker', message: '图纸事实引用率 42% 低于 90%', suggestion: '补写图纸引用', chapterId: 'ch-3', sectionTitle: '施工部署' }],
    checklist: [{ key: 'drawing', label: '图纸引用', passed: false, message: '42%' }, { key: 'boq', label: '清单落位', passed: true }],
    ...overrides,
  };
}

function stages(): DocumentExecutionStage[] {
  return [
    { type: 'chapter_generation', roleId: 'chapter-1', status: 'success', subtitle: '第一章生成', message: '已生成 3 节' },
    { type: 'validation', roleId: FINALIZE_REPAIR_ROUNDS[0], status: 'success', message: '本轮命中 2 处并修复' },
  ];
}

function baseInput(overrides: Partial<DeliveryReviewReportInput> = {}): DeliveryReviewReportInput {
  return {
    documentId: 'doc-test-1',
    title: '施工组织设计',
    qualityReport: qualityReport(),
    professionalScore: professionalScore(),
    exportGate: exportGate(),
    stages: stages(),
    metrics: [
      { name: '章节生成', startedAt: 0, endedAt: 300, durationMs: 300 },
      { name: '文献检索', startedAt: 0, endedAt: 1500, durationMs: 1500 },
    ],
    generatedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
    ...overrides,
  };
}

// ── ① 三件套构建 ──

describe('buildDeliveryReviewReport（三件套构建）', () => {
  it('三件套结构齐备：评分报告/进度/下轮预估三段 + 口径版本与主从标注', () => {
    const markdown = buildDeliveryReviewReport(baseInput());
    expect(markdown).toContain('# 交付三件套报告：施工组织设计');
    expect(markdown).toContain('## 一、评分报告');
    expect(markdown).toContain('## 二、进度（阶段/耗时/修复轮次）');
    expect(markdown).toContain('## 三、下轮预估目标（按当前六维缺口）');
    // 口径版本标注（C0-7 全出口）+ 主尺/从属定位（C0-5）
    expect(markdown).toContain(SCORING_CALIBRATION_VERSION);
    expect(markdown).toContain('主尺=六维');
    expect(markdown).toContain('标书类型：明标');
  });

  it('评分报告：六维表 + 综合行 + 专业分从属标注 + 阻断明细带章节锚点与建议', () => {
    const markdown = buildDeliveryReviewReport(baseInput());
    expect(markdown).toContain('| 要求实体响应 | 80 | 30% | 要求实体响应构成明细 |');
    expect(markdown).toContain('| 数据锚定 | 70 | 20% |');
    expect(markdown).toContain('综合评分：**68**/100');
    expect(markdown).toContain('交付置信度 **62%**');
    expect(markdown).toContain('低雷同性 81');
    expect(markdown).toContain('专业度评分（从属口径，交付主尺见六维）');
    expect(markdown).toContain('总分 74/100（合格）');
    expect(markdown).toContain('[blocker] 图纸事实引用率 42% 低于 90%（章：ch-3 / 施工部署）');
    expect(markdown).toContain('建议：补写图纸引用');
    expect(markdown).toContain('门禁复核清单：通过 1/2');
    expect(markdown).toContain('未过项：图纸引用');
  });

  it('进度：阶段状态标签 + 耗时降序 + 修复轮次命中/未记录两态', () => {
    const markdown = buildDeliveryReviewReport(baseInput());
    expect(markdown).toContain('[通过] 第一章生成：已生成 3 节');
    expect(markdown).toContain(`- ${FINALIZE_REPAIR_ROUNDS[0]}：通过 — 本轮命中 2 处并修复`);
    expect(markdown).toContain('未记录（无触发或静默通过）');
    // 耗时降序：1.5s 在 300ms 之前
    const slow = markdown.indexOf('文献检索：1.5s');
    const fast = markdown.indexOf('章节生成：300ms');
    expect(slow).toBeGreaterThan(-1);
    expect(fast).toBeGreaterThan(slow);
  });

  it('下轮预估（uniqueness 因子 <1 且上限低于目标）：贡献值/加权/上限约束文案/不足路径显性化', () => {
    const markdown = buildDeliveryReviewReport(baseInput());
    // 加权 75.5 = Σ(score×weight)/Σweight；因子 0.90 = 81/90；上限 90 = round(100×0.90)
    expect(markdown).toContain('| 要求实体响应 | 80 | +20 | +5.4 |');
    expect(markdown).toContain('| 合规与规范 | 100 | 0（满分） | 0 |');
    expect(markdown).toContain('当前加权综合分：75.5/100（uniqueness 因子 0.90）');
    expect(markdown).toContain('预计总分上限：**90**/100');
    expect(markdown).toContain('低于目标 95——受低雷同性因子 0.90 约束');
    // 六维补满（+22.1）仍不足缺口 27.0：显性 ''<'' 分支而非虚报达标
    expect(markdown).toContain('合计 +22.1 < 缺口 27.0——六维补满仍不足');
  });

  it('达标路径（covered ≥ gap 分支）：贡献降序贪心链 + ≥ 缺口', () => {
    // 提高 uniqueness 至 90（因子 1.0）后：整体=加权，上限 100 ≥ 目标 95
    const markdown = buildDeliveryReviewReport(baseInput({
      qualityReport: qualityReport({ overall: 75, scores: { completeness: 78, specificity: 70, compliance: 88, executability: 66, normalization: 82, uniqueness: 90 } }),
    }));
    expect(markdown).toContain('预计总分上限：**100**/100');
    expect(markdown).toContain('达标路径（目标 95）：');
    expect(markdown).toContain('≥ 缺口 20.0。');
  });

  it('已达标：无补强路径（显性维护口径行）', () => {
    const markdown = buildDeliveryReviewReport(baseInput({
      qualityReport: qualityReport({ overall: 96, passed: true }),
    }));
    expect(markdown).toContain('当前已达目标 95，无需补强路径');
    expect(markdown).not.toContain('达标路径（目标');
  });

  it('反样本：dimensions 缺失 → 预估降级不猜数（第三节显性降级行 + 1.1 缺省提示）', () => {
    const markdown = buildDeliveryReviewReport(baseInput({ qualityReport: qualityReport({ dimensions: undefined }) }));
    expect(markdown).toContain('（六维构成明细缺失——评级输入不完整，仅综合分可用）');
    expect(markdown).toContain('六维构成明细缺失，无法计算下轮预估（降级不猜数');
    expect(markdown).not.toContain('预计总分上限');
  });

  it('反样本：无阻断 → 显性通过行（不残留阻断小节）', () => {
    const markdown = buildDeliveryReviewReport(baseInput({
      exportGate: exportGate({ passed: true, blockingIssues: [], checklist: [{ key: 'x', label: 'X', passed: true }] }),
    }));
    expect(markdown).toContain('无阻断：终检检测器全部通过');
    expect(markdown).toContain('导出门禁：通过');
  });

  it('防误伤守护：自引用守护（报告含自身 roleId 的时机在入列之前）', () => {
    const markdown = buildDeliveryReviewReport(baseInput());
    expect(markdown).not.toContain('delivery-review-report');
  });

  it('防误伤守护：确定性——同输入两次构建逐字节一致', () => {
    expect(buildDeliveryReviewReport(baseInput())).toBe(buildDeliveryReviewReport(baseInput()));
  });
});

// ── ② 下轮预估直测 ──

describe('estimateNextRoundTargets（下轮预估，与主尺同源）', () => {
  it('缺口/贡献/加权/上限 + 贪心路径不含零破口维度', () => {
    const estimate = estimateNextRoundTargets(qualityReport())!;
    expect(estimate.currentWeighted).toBeCloseTo(75.5, 1);
    expect(estimate.uniquenessFactor).toBe(0.9);
    expect(estimate.projectedOverall).toBe(90);
    // 贡献降序（合规与规范零缺口排最后）
    expect(estimate.dimensions[0].effectiveGain).toBeGreaterThanOrEqual(estimate.dimensions[1].effectiveGain);
    expect(estimate.dimensions[estimate.dimensions.length - 1].key).toBe('compliance');
    expect(estimate.dimensions[estimate.dimensions.length - 1].effectiveGain).toBe(0);
    const { picks, covered, gap, target } = estimate.pathToTarget!;
    expect(target).toBe(95);
    expect(gap).toBeCloseTo(27, 1);
    expect(picks).toHaveLength(5);
    expect(picks.every(pick => pick.effectiveGain > 0)).toBe(true);
    expect(picks.map(pick => pick.key)).not.toContain('compliance');
    expect(covered).toBeCloseTo(22.1, 1);
  });

  it('全满分：全维零缺口、无路径（不虚报补强机会）', () => {
    const report = qualityReport({
      overall: 100,
      target: 95,
      passed: true,
      scores: { completeness: 100, specificity: 100, compliance: 100, executability: 100, normalization: 100, uniqueness: 100 },
      dimensions: dimensions().map(dimension => ({ ...dimension, score: 100 })),
    });
    const estimate = estimateNextRoundTargets(report)!;
    expect(estimate.pathToTarget).toBeNull();
    expect(estimate.dimensions.every(target => target.gap === 0 && target.effectiveGain === 0)).toBe(true);
    expect(estimate.projectedOverall).toBe(100);
  });

  it('反样本：dimensions 空数组 → undefined（降级不猜数）', () => {
    expect(estimateNextRoundTargets(qualityReport({ dimensions: [] }))).toBeUndefined();
  });

  it('反样本：权重非正/分数非有限的伪维度被过滤 → 无有效维度时 undefined', () => {
    const report = qualityReport({
      dimensions: [
        { key: 'requirement', label: '零权重', score: 50, weight: 0 },
        { key: 'structure', label: 'NaN 分数', score: Number.NaN, weight: 0.15 },
      ],
    });
    expect(estimateNextRoundTargets(report)).toBeUndefined();
  });
});

// ── ③ formatDuration ──

describe('formatDuration', () => {
  it('毫秒/秒/分钟三档 + 异常值归零', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(60_000)).toBe('1.0min');
    expect(formatDuration(90_000)).toBe('1.5min');
    expect(formatDuration(Number.NaN)).toBe('0ms');
    expect(formatDuration(-5)).toBe('0ms');
  });
});

// ── ④ 写盘（路径清洗/原子性/幂等） ──

describe('saveDeliveryReviewReport（原子写盘）', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-review-report-test-'));
  const written: string[] = [];
  afterAll(() => {
    // 清理生成目录（generatedRoot 落在用户目录按 projectRoot 哈希隔离，rm 目标即本 test 专属哈希目录）
    for (const file of written) fs.rmSync(path.dirname(path.dirname(path.dirname(file))), { recursive: true, force: true });
  });

  it('路径范式：generatedRoot/reports/<docId>-review.md', () => {
    const file = deliveryReviewReportPath(tempRoot, 'doc-9');
    expect(file).toContain(path.join('generatedDocuments', 'reports', 'doc-9-review.md'));
  });

  it('防路径注入：docId 中斜杠/点号被清洗（basename 单段、无遍历残留）', () => {
    const file = deliveryReviewReportPath(tempRoot, 'doc/../x');
    expect(path.basename(file)).toBe('doc____x-review.md');
    expect(path.basename(file)).not.toContain('/');
    expect(path.dirname(file)).toContain(path.join('generatedDocuments', 'reports'));
  });

  it('反样本：空白 docId → 抛错（拒绝无命名报告）', () => {
    expect(() => deliveryReviewReportPath(tempRoot, '   ')).toThrow('交付报告文件名缺少文档 ID');
  });

  it('原子写：内容一致 + tmp 无残留 + 覆盖重写（幂等）', () => {
    const file = saveDeliveryReviewReport(tempRoot, 'doc-write', '# 第一版\n');
    written.push(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('# 第一版\n');
    const dir = path.dirname(file);
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toHaveLength(0);
    const again = saveDeliveryReviewReport(tempRoot, 'doc-write', '# 第二版\n');
    expect(again).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('# 第二版\n');
    expect(fs.readdirSync(dir).filter(name => name.startsWith('doc-write-review.md'))).toHaveLength(1);
  });
});

// ── ⑤ 接线锁定（防复发固化：documentId 注入链三文件单源回归保护） ──

describe('接线锁定（finalGate/documentGenerator/finalizeSession）', () => {
  const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');
  const readSrc = (relative: string) => fs.readFileSync(path.join(SRC_DIR, relative), 'utf8');

  it('finalGate：documentId 守卫 + 构建/写盘/双态 stage（失败不阻断）+ 构建先于自引用入列', () => {
    const source = readSrc('finalize/finalGate.ts');
    expect(source).toContain('if (session.documentId)');
    expect(source).toContain('buildDeliveryReviewReport({');
    expect(source).toContain('saveDeliveryReviewReport(session.projectRoot, session.documentId, reportMarkdown)');
    expect(source).toContain("roleId: 'delivery-review-report'");
    expect(source).toContain('交付三件套报告产出失败（不阻断交付）');
    // 构建在自身 stage 入列之前（报告内容不含自引用，离线复算可确定性重建）
    const buildIndex = source.indexOf('buildDeliveryReviewReport({');
    const pushIndex = source.indexOf("roleId: 'delivery-review-report'");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(buildIndex);
  });

  it('documentGenerator：documentId 以 diversitySeed 注入 finalizeGeneration（命名源贯通）', () => {
    expect(readSrc('documentGenerator.ts')).toContain('documentId: input.diversitySeed');
  });

  it('finalizeSession：输入字段声明 + session 携带 + createFinalizeSession 赋值', () => {
    const source = readSrc('finalize/finalizeSession.ts');
    expect(source).toContain('documentId?: string');
    expect(source).toContain('documentId: input.documentId');
  });
});
