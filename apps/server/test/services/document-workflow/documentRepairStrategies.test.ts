/**
 * documentRepairStrategies 单测：修复策略汇总（阻断/落位/知识覆盖/弱章节/交付置信度）与策略告警。
 */
import { describe, expect, it } from 'vitest';
import { buildRepairStrategies, repairStrategyIssues } from '@/services/document-workflow/documentRepairStrategies';
import type { DocumentFactTrace, DocumentKnowledgeCoverageReport, DocumentQualityReport, ValidationIssue } from '@/services/document-workflow/types';

function makeKnowledgeCoverage(score: number): DocumentKnowledgeCoverageReport {
  return {
    score,
    evidenceCount: 10,
    confirmedFiles: 5,
    chapterReports: [],
    unconfirmedDomains: [],
    remediation: '',
  };
}

function makeQualityReport(passed: boolean): DocumentQualityReport {
  return {
    overall: 80,
    deliveryProbability: passed ? 90 : 60,
    target: 85,
    passed,
    scores: { completeness: 90, specificity: 90, compliance: 85, executability: 90, normalization: 90, uniqueness: 90 },
    summary: '',
    actions: ['提升针对性'],
  };
}

function makeTrace(label: string, value: string): DocumentFactTrace {
  return { label, value, status: 'unplaced', confidence: 1 };
}

describe('buildRepairStrategies', () => {
  it('空输入 → 无策略', () => {
    expect(buildRepairStrategies({ issues: [] })).toEqual([]);
  });

  it('阻断问题 → high 优先策略', () => {
    const issues: ValidationIssue[] = [{ level: 'error', message: 'x' }, { level: 'error', message: 'y' }, { level: 'warning', message: 'z' }];
    const strategies = buildRepairStrategies({ issues });
    expect(strategies).toHaveLength(1);
    expect(strategies[0].priority).toBe('high');
    expect(strategies[0].title).toBe('阻断问题修复');
    expect(strategies[0].action).toContain('2 个');
  });

  it('未落位事实（可执行口径）→ 落位策略', () => {
    const strategies = buildRepairStrategies({
      issues: [],
      factTraces: [makeTrace('计划工期', '300日历天')],
    });
    expect(strategies).toHaveLength(1);
    expect(strategies[0].title).toBe('事实落位修复');
    expect(strategies[0].action).toContain('计划工期');
  });

  it('技术参数标签不参与落位（参数池豁免）', () => {
    const strategies = buildRepairStrategies({
      issues: [],
      factTraces: [makeTrace('技术参数', '500x300')],
    });
    expect(strategies).toEqual([]);
  });

  it('指向性值不参与落位（见招标文件）', () => {
    const strategies = buildRepairStrategies({
      issues: [],
      factTraces: [makeTrace('质量标准', '见招标文件')],
    });
    expect(strategies).toEqual([]);
  });

  it('落位事实 >12 项时摘要截断', () => {
    const traces = Array.from({ length: 15 }, (_, index) => makeTrace(`事实${index}`, `${index}万元`));
    const strategies = buildRepairStrategies({ issues: [], factTraces: traces });
    expect(strategies[0].action).toContain('15 项');
    expect(strategies[0].action).toContain('等）');
  });

  it('知识覆盖 <95 → medium 策略', () => {
    const strategies = buildRepairStrategies({ issues: [], knowledgeCoverage: makeKnowledgeCoverage(80) });
    expect(strategies).toHaveLength(1);
    expect(strategies[0].priority).toBe('medium');
    expect(strategies[0].title).toBe('知识库确认覆盖修复');
  });

  it('低覆盖章节 → medium 策略（>10 章摘要截断）', () => {
    const weak = Array.from({ length: 12 }, (_, index) => ({ chapterId: `c${index}`, title: `章${index}`, score: 60, action: '', checks: [] }));
    const strategies = buildRepairStrategies({ issues: [], chapterCoverage: [...weak, { chapterId: 'ok', title: '完整章', score: 90, action: '', checks: [] }] });
    const chapter = strategies.find(strategy => strategy.title === '章节覆盖修复');
    expect(chapter?.priority).toBe('medium');
    expect(chapter?.action).toContain('12章');
    expect(chapter?.action).toContain('及其他4章');
  });

  it('交付置信度未达标 → medium 策略', () => {
    const strategies = buildRepairStrategies({ issues: [], qualityReport: makeQualityReport(false) });
    const quality = strategies.find(strategy => strategy.title === '交付置信度修复');
    expect(quality?.action).toBe('提升针对性');
  });
});

describe('repairStrategyIssues', () => {
  it('仅 high 策略计入 info 告警', () => {
    const strategies = [
      { priority: 'high' as const, title: '阻断问题修复', action: 'a' },
      { priority: 'medium' as const, title: '章节覆盖修复', action: 'b' },
    ];
    const issues = repairStrategyIssues(strategies);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('info');
    expect(issues[0].message).toContain('阻断问题修复');
    expect(issues[0].suggestion).toBe('a');
  });
});
