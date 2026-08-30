/**
 * documentReviewChecklist 单测：成稿审查清单 6 项口径。
 */
import { describe, expect, it } from 'vitest';
import { buildDocumentReviewChecklist } from './documentReviewChecklist';
import type { DocumentQualityReport, ExportGateResult } from './types';

function makeQualityReport(overrides: Partial<DocumentQualityReport> = {}): DocumentQualityReport {
  return {
    overall: 90,
    deliveryProbability: 90,
    target: 85,
    passed: true,
    scores: { completeness: 90, specificity: 90, compliance: 85, executability: 90, normalization: 90, uniqueness: 90 },
    summary: '',
    actions: [],
    ...overrides,
  };
}

describe('buildDocumentReviewChecklist', () => {
  it('门禁通过时 6 项全绿', () => {
    const checklist = buildDocumentReviewChecklist({
      exportGate: { passed: true, blockingIssues: [], checklist: [] },
      qualityReport: makeQualityReport(),
      repairStrategies: [],
    });
    expect(checklist).toHaveLength(6);
    expect(checklist.every(item => item.passed)).toBe(true);
    expect(checklist[0].message).toBe('导出门禁通过');
  });

  it('门禁阻断时提示阻断数量', () => {
    const exportGate: ExportGateResult = { passed: false, blockingIssues: [{ level: 'error', message: 'x' }, { level: 'error', message: 'y' }], checklist: [] };
    const checklist = buildDocumentReviewChecklist({
      exportGate,
      qualityReport: makeQualityReport(),
      repairStrategies: [],
    });
    expect(checklist[0].passed).toBe(false);
    expect(checklist[0].message).toContain('2 个阻断问题');
  });

  it('质量分低于阈值时对应项未通过', () => {
    const checklist = buildDocumentReviewChecklist({
      exportGate: { passed: true, blockingIssues: [], checklist: [] },
      qualityReport: makeQualityReport({ passed: false, deliveryProbability: 60, scores: { completeness: 80, specificity: 70, compliance: 75, executability: 70, normalization: 70, uniqueness: 70 } }),
      repairStrategies: [],
    });
    expect(checklist[1].passed).toBe(false);
    expect(checklist[1].message).toBe('60% / 85%');
    expect(checklist[2].passed).toBe(false);
    expect(checklist[3].passed).toBe(false);
    expect(checklist[4].passed).toBe(false);
  });

  it('高优先级修复策略残留 → 修复策略项未通过', () => {
    const checklist = buildDocumentReviewChecklist({
      exportGate: { passed: true, blockingIssues: [], checklist: [] },
      qualityReport: makeQualityReport(),
      repairStrategies: [{ priority: 'high', title: '事实落位修复', action: '补齐' }],
    });
    expect(checklist[5].passed).toBe(false);
    expect(checklist[5].message).toBe('事实落位修复');
  });

  it('无修复策略时提示语兜底', () => {
    const checklist = buildDocumentReviewChecklist({
      exportGate: { passed: true, blockingIssues: [], checklist: [] },
      qualityReport: makeQualityReport(),
      repairStrategies: [],
    });
    expect(checklist[5].passed).toBe(true);
    expect(checklist[5].message).toBe('无高优先级修复策略');
  });
});
