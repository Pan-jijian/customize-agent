/**
 * documentQualityReport 单测：招标技术标五维加权 + 低雷同乘数修正 + 阻断扣分 +
 * 交付置信度目标与门禁、qualityReportIssues。tenderBidScoring 全 mock。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildTenderBidScoresMock, buildTenderBidTemplatingReportMock } = vi.hoisted(() => ({
  buildTenderBidScoresMock: vi.fn(),
  buildTenderBidTemplatingReportMock: vi.fn(),
}));
vi.mock('./tenderBidScoring', () => ({
  buildTenderBidScores: buildTenderBidScoresMock,
  buildTenderBidTemplatingReport: buildTenderBidTemplatingReportMock,
}));

import { buildDocumentQualityReport, qualityReportIssues } from './documentQualityReport';
import type { DocumentDraftChapter, DocumentFactTrace, DocumentKnowledgeCoverageReport, DocumentQualityReport, ValidationIssue } from './types';

function makeScores(overrides: Partial<{ completeness: number; specificity: number; compliance: number; executability: number; normalization: number; uniqueness: number }> = {}) {
  return {
    completeness: 90, specificity: 88, compliance: 85, executability: 82, normalization: 80, uniqueness: 95,
    ...overrides,
  };
}

const CHAPTERS: DocumentDraftChapter[] = [];
const TRACES: DocumentFactTrace[] = [];
const KNOWLEDGE_HIGH: DocumentKnowledgeCoverageReport = {
  score: 96, evidenceCount: 10, confirmedFiles: 3, chapterReports: [], unconfirmedDomains: [], remediation: '知识库事实覆盖已达到高置信交付要求。',
};
const KNOWLEDGE_LOW: DocumentKnowledgeCoverageReport = {
  score: 70, evidenceCount: 10, confirmedFiles: 3, chapterReports: [], unconfirmedDomains: [], remediation: '系统需扩大本地知识库检索。',
};

function reportFixture(issues: ValidationIssue[], knowledgeCoverage: DocumentKnowledgeCoverageReport, scores = makeScores()): ReturnType<typeof buildDocumentQualityReport> {
  buildTenderBidScoresMock.mockResolvedValue(scores);
  buildTenderBidTemplatingReportMock.mockResolvedValue({ level: 'light' });
  return buildDocumentQualityReport({ markdown: '# 正文', chapters: CHAPTERS, issues, knowledgeCoverage, factTraces: TRACES });
}

describe('buildDocumentQualityReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('五维加权公式与低雷同乘数修正', async () => {
    // weighted = 90*0.30+88*0.25+85*0.20+82*0.15+80*0.10 = 86.3
    // overall = round(86.3 * min(1, 95/90)) = round(86.3*1) = 86
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores());
    expect(report.overall).toBe(86);
  });

  it('低雷同性低于 90 时对加权结果做乘数修正', async () => {
    // weighted = 86.3；uniqueness=45 → 86.3 * 0.5 = 43.15 → round 43
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores({ uniqueness: 45 }));
    expect(report.overall).toBe(43);
  });

  it('阻断问题每条扣 8 分并夹取 0-99', async () => {
    const issues: ValidationIssue[] = [
      { level: 'error', message: 'e1', suggestion: '' },
      { level: 'error', message: 'e2', suggestion: '' },
      { level: 'warning', message: 'w1', suggestion: '' },
    ];
    // overall=86 - 2*8 = 70
    const report = await reportFixture(issues, KNOWLEDGE_HIGH, makeScores());
    expect(report.deliveryProbability).toBe(70);
  });

  it('知识覆盖达 95 时目标 95，否则 85', async () => {
    const high = await reportFixture([], KNOWLEDGE_HIGH, makeScores({ completeness: 100, specificity: 100, compliance: 100, executability: 100, normalization: 100, uniqueness: 100 }));
    expect(high.target).toBe(95);
    const low = await reportFixture([], KNOWLEDGE_LOW, makeScores());
    expect(low.target).toBe(85);
  });

  it('passed = 置信度达标且无阻断问题', async () => {
    const passed = await reportFixture([], KNOWLEDGE_HIGH, makeScores({ completeness: 100, specificity: 100, compliance: 100, executability: 100, normalization: 100, uniqueness: 100 }));
    expect(passed.deliveryProbability).toBe(99);
    expect(passed.passed).toBe(true);
    expect(passed.actions).toEqual(['已达到当前质量目标，建议保持事实口径和导出前复核。']);
    const failed = await reportFixture([{ level: 'error', message: 'e', suggestion: '' }], KNOWLEDGE_HIGH, makeScores({ completeness: 100, specificity: 100, compliance: 100, executability: 100, normalization: 100, uniqueness: 100 }));
    expect(failed.passed).toBe(false);
    expect(failed.actions).toHaveLength(2);
  });

  it('summary 汇总置信度/目标/综合评分与六维明细', async () => {
    const report = await reportFixture([], KNOWLEDGE_HIGH, makeScores());
    expect(report.summary).toContain('交付置信度 86% / 目标 95%');
    expect(report.summary).toContain('综合评分 86/100');
    expect(report.summary).toContain('资料完整性 90');
    expect(report.summary).toContain('低雷同性 95');
  });

  it('模板化报告透传到 templating 字段', async () => {
    buildTenderBidTemplatingReportMock.mockResolvedValue({ level: 'medium' });
    buildTenderBidScoresMock.mockResolvedValue(makeScores());
    const report = await buildDocumentQualityReport({ markdown: '# 正文', chapters: CHAPTERS, issues: [], knowledgeCoverage: KNOWLEDGE_HIGH, factTraces: TRACES });
    expect(report.templating).toEqual({ level: 'medium' });
  });
});

function makeTemplatingReport() {
  return {
    level: 'light' as const, fillerRatio: 0, fillerSentences: 0, totalSentences: 1,
    vagueHitCount: 0, vaguePhrases: [], duplicateSentenceRate: 0, crossProjectResidue: [],
    difficultyCountermeasureRatio: 1, difficultyBothCount: 1, difficultyCountermeasures: 1, difficultyHeavyTemplated: false,
  };
}

describe('qualityReportIssues', () => {
  it('已达标不产出问题', () => {
    const passedReport: DocumentQualityReport = {
      overall: 90, deliveryProbability: 96, target: 95, passed: true,
      scores: makeScores(), templating: makeTemplatingReport(),
      summary: '', actions: ['已达到当前质量目标，建议保持事实口径和导出前复核。'],
    };
    expect(qualityReportIssues(passedReport)).toEqual([]);
  });

  it('未达标产出 info 级问题（不污染缺陷计分）', () => {
    const failedReport: DocumentQualityReport = {
      overall: 60, deliveryProbability: 60, target: 85, passed: false,
      scores: makeScores(), templating: makeTemplatingReport(),
      summary: '', actions: ['补齐短板维度', '修复阻断问题'],
    };
    const issues = qualityReportIssues(failedReport);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('info');
    expect(issues[0].message).toContain('60% / 85%');
    expect(issues[0].suggestion).toContain('补齐短板维度');
  });
});
