/**
 * 校准套件（repair-master-plan 4.4）：历史缺陷样本在诚实口径下必须扣分（防通胀回归）。
 * 素材：.dbg/gen-v5-r28e-final.json / gen-v5-r28f-final.json（明标模板 tpl-1788641517421 连续两轮成稿快照：markdown +
 * 章草稿 + 校验组 + factsModel 全量）+ .dbg/calibration/tender-requirements-snapshot.json（166 条要求池
 * 缓存精简副本，106 respond + 60 comply，两轮共用）。r28d 为中断快照（无章草稿/factsModel）不纳入。
 * 断言分两级：
 * ① 防通胀硬断言：overall < 75 且显著低于快照记录的 v2 口径综合评分（92/88——机制分虚高样本），
 *    passed=false、|overall − delivery| ≤ 10（双数收敛）；
 * ② 缺口指纹：锚点全命中计数、BOQ 落位、参数义务满足、无主数值缺口、正文题注覆盖与第 2 章缺口清单一致
 *    （所有数字为纯确定性计算，快照冻结后稳定；快照重生成时需同步刷新指纹常量）。
 *    M9（r28h 轮）口径修正：口径行豁免扩围（版式噪声/费用/分部标题）+ 首段主名判定 →
 *    boq 指纹同步刷新（1970→1238：豁免 882 行分母净化；plc 按当前口径重算）。
 * professionalDepth 分量不注入分类器（诚实降级口径）；快照/要求池资产缺失时整组跳过（.dbg 不入库场景静默）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const { buildTenderBidScoresMock, buildTenderBidTemplatingReportMock } = vi.hoisted(() => ({
  buildTenderBidScoresMock: vi.fn(),
  buildTenderBidTemplatingReportMock: vi.fn(),
}));
vi.mock('@/services/document-workflow/tenderBidScoring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/document-workflow/tenderBidScoring')>();
  return {
    ...actual,
    buildTenderBidScores: buildTenderBidScoresMock,
    buildTenderBidTemplatingReport: buildTenderBidTemplatingReportMock,
  };
});

import { buildDocumentQualityReport } from '@/services/document-workflow/documentQualityReport';
import { buildBoqRowTraces } from '@/services/document-workflow/documentFactTrace';
import { buildParameterUsageAudit } from '@/services/document-workflow/chapterParameterFacts';
import { buildKeyFactPlacementAudit } from '@/services/document-workflow/keyFactPlacement';
import type { TenderRequirementModel } from '@/services/document-workflow/types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const CALIB_DIR = join(ROOT, '.dbg');
const REQUIREMENTS_FILE = join(CALIB_DIR, 'calibration/tender-requirements-snapshot.json');

interface CalibrationCase {
  file: string;
  /** 锚点全命中计数（respond 类 106 条中的 satisfied 数） */
  anchorHit: number;
  anchorTotal: number;
  /** BOQ 有效行落位（豁免行不计入分母） */
  boqPlaced: number;
  boqEffective: number;
  /** 参数义务满足（usedParams / usedParams + relevantMissedCount） */
  paramsUsed: number;
  paramsObligation: number;
  /** 无主数值三桶缺口合计（derivation + process + unregistered） */
  authorityGaps: number;
  /** 正文题注覆盖（明标 unknown 模式结构维度单分量） */
  captioned: number;
}

const CASES: CalibrationCase[] = [
  { file: 'gen-v5-r28e-final.json', anchorHit: 41, anchorTotal: 106, boqPlaced: 1182, boqEffective: 1238, paramsUsed: 51, paramsObligation: 89, authorityGaps: 31, captioned: 40 },
  { file: 'gen-v5-r28f-final.json', anchorHit: 40, anchorTotal: 106, boqPlaced: 1154, boqEffective: 1238, paramsUsed: 47, paramsObligation: 90, authorityGaps: 38, captioned: 31 },
];

function loadCase(caseItem: CalibrationCase) {
  const snap = JSON.parse(readFileSync(join(CALIB_DIR, caseItem.file), 'utf8'));
  const doc = snap.document;
  const draft = doc.draft;
  const rm = doc.reviewMetadata;
  const requirements = JSON.parse(readFileSync(REQUIREMENTS_FILE, 'utf8')) as TenderRequirementModel;
  return { doc, draft, rm, requirements, markdown: doc.markdown as string, legacyOverall: rm.qualityReport.overall as number };
}

async function buildReport(caseItem: CalibrationCase) {
  const { draft, rm, requirements, markdown } = loadCase(caseItem);
  const boqRowTraces = buildBoqRowTraces(markdown, draft.factsModel);
  const parameterUsageAudit = buildParameterUsageAudit({ markdown, factsModel: draft.factsModel, chapters: draft.chapters });
  // 与生产调用点（rebuildAndRecompute.buildQualityReportBundle）同口径：关键事实池 = 结构化事实 + 精确事实
  const keyFactPlacementAudit = buildKeyFactPlacementAudit(markdown, [...(draft.structuredFacts || []), ...((draft.factsModel && draft.factsModel.preciseFacts) || [])]);
  buildTenderBidScoresMock.mockResolvedValue(rm.qualityReport.scores);
  buildTenderBidTemplatingReportMock.mockResolvedValue({ level: 'light' });
  const report = await buildDocumentQualityReport({
    markdown,
    chapters: draft.chapters,
    issues: draft.validationIssues,
    knowledgeCoverage: rm.knowledgeCoverage,
    factTraces: rm.factTraces || [],
    tenderRequirements: requirements,
    bidComposition: draft.bidComposition,
    boqRowTraces,
    parameterUsageAudit,
    keyFactPlacementAudit,
    authorityAuditReport: rm.authorityAudit,
  } as Parameters<typeof buildDocumentQualityReport>[0]);
  return { report, requirements };
}

function dimensionOf(report: Awaited<ReturnType<typeof buildReport>>['report'], key: string) {
  return report.dimensions?.find(dimension => dimension.key === key);
}

for (const caseItem of CASES) {
  const available = existsSync(join(CALIB_DIR, caseItem.file)) && existsSync(REQUIREMENTS_FILE);
  describe.skipIf(!available)(`校准：${caseItem.file}`, () => {
    it('防通胀：缺陷样本在诚实口径下 overall < 75、显著低于 v2 口径、passed=false 且双数收敛', async () => {
      const { report } = await buildReport(caseItem);
      // v2 口径曾给 92/88（机制分虚高）；v3 诚实口径实测 58/63——必须打回 75 以下
      expect(report.overall).toBeLessThan(75);
      expect(report.overall).toBeLessThan(loadCase(caseItem).legacyOverall);
      expect(report.passed).toBe(false);
      expect(Math.abs(report.overall - report.deliveryProbability)).toBeLessThanOrEqual(10);
      expect(report.target).toBe(95);
    });

    it('缺口指纹：锚点/BOQ/参数/无主数值/题注计数与第 2 章缺口清单一致', async () => {
      const { report, requirements } = await buildReport(caseItem);
      const complyCount = (requirements.entries || []).filter(entry => entry.policy === 'comply').length;
      const checklist = report.requirementChecklist || [];
      expect(checklist).toHaveLength(requirements.entries.length);
      // comply 类不属文本响应验收域（恒 responded），故 responded 总数 = 锚点命中 + comply 数
      expect(checklist.filter(item => item.responded)).toHaveLength(caseItem.anchorHit + complyCount);
      expect(dimensionOf(report, 'requirement')?.detail).toContain(`锚点全命中 ${caseItem.anchorHit}/${caseItem.anchorTotal}`);
      expect(report.billPlacementAudit).toMatchObject({ placedRows: caseItem.boqPlaced, effectiveRows: caseItem.boqEffective });
      expect(report.parameterUsageAudit).toMatchObject({ usedParams: caseItem.paramsUsed, relevantMissedCount: caseItem.paramsObligation - caseItem.paramsUsed });
      expect(report.keyFactPlacementAudit).toMatchObject({ specs: 8, placed: 7 });
      expect(dimensionOf(report, 'factIntegrity')?.detail).toContain('关键事实 7/8');
      expect(dimensionOf(report, 'dataAnchor')?.detail).toContain(`无主数值 缺口 ${caseItem.authorityGaps} 处`);
      // 题注全达标（明标 unknown 模式结构维度单分量），缺口集中在要求/数据/合规三域
      expect(dimensionOf(report, 'structure')).toMatchObject({ score: 100 });
      expect(dimensionOf(report, 'structure')?.detail).toContain(`题注 ${caseItem.captioned}/${caseItem.captioned}`);
    });
  });
}
