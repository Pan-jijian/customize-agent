/**
 * documentChapterCoverage 单测：章节覆盖报告 7 项检查（结构/深度/证据/专业控制点/工期/质量/安全）
 * 与覆盖不足告警提取。
 */
import { describe, expect, it } from 'vitest';
import { buildChapterCoverageReports, chapterCoverageIssues } from './documentChapterCoverage';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplateChapter } from './types';

function makeChapter(overrides: Partial<DocumentDraftChapter> = {}): DocumentDraftChapter {
  return { id: 'c1', title: '施工部署', content: '', evidence: [], missingFacts: [], ...overrides };
}

const EMPTY_FACTS_MODEL: DocumentFactsModel = {
  project: [], schedule: [], quality: [], safety: [], resources: [], preciseFacts: [], bills: [], drawings: [], rules: [], specifications: [],
  tables: [], schemaFacts: {},
  factIndex: { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] },
  missing: [], conflicts: [],
};

describe('buildChapterCoverageReports', () => {
  it('全面达标章节 → 100 分与完整动作', () => {
    const content = `${'正文内容。'.repeat(120)}\n### 小节\n验收、复核、检查、交底、控制点、整改、闭环、台账、进场、工序全部具备，工期节点计划与资源穿插完备。`;
    const report = buildChapterCoverageReports({
      chapters: [makeChapter({ sections: ['1.1', '1.2'], evidence: [{ chapterId: 'c1', filePath: '/f.pdf', score: 1, content: '' }], content })],
      templateChapters: [],
      factsModel: EMPTY_FACTS_MODEL,
    })[0];
    expect(report.score).toBe(100);
    expect(report.action).toBe('章节覆盖完整。');
    expect(report.checks).toHaveLength(7);
  });

  it('章节标题含进度/质量义务但正文无支撑 → 对应项未通过', () => {
    const content = 'x'.repeat(1200);
    const report = buildChapterCoverageReports({
      chapters: [makeChapter({ title: '施工进度计划', content })],
      templateChapters: [{ id: 'c1', title: '施工进度计划', purpose: '', queries: [], requiredFacts: [] }],
      factsModel: EMPTY_FACTS_MODEL,
    })[0];
    const schedule = report.checks.find(check => check.key === 'schedule');
    const quality = report.checks.find(check => check.key === 'quality');
    expect(schedule?.passed).toBe(false);
    expect(quality?.passed).toBe(true);
  });

  it('sections 缺失但正文含三级标题 → 结构通过', () => {
    const report = buildChapterCoverageReports({
      chapters: [makeChapter({ sections: [], content: '### 1.1 小节\n正文'.repeat(60) })],
      templateChapters: [],
      factsModel: EMPTY_FACTS_MODEL,
    })[0];
    expect(report.checks.find(check => check.key === 'structure')?.passed).toBe(true);
  });

  it('templateChapter.sections 回退与证据绑定检查', () => {
    const report = buildChapterCoverageReports({
      chapters: [makeChapter({ content: 'x'.repeat(1200) })],
      templateChapters: [{ id: 'c1', title: '施工部署', purpose: '', queries: [], requiredFacts: [], sections: ['1.1', '1.2'] }],
      factsModel: EMPTY_FACTS_MODEL,
    })[0];
    expect(report.checks.find(check => check.key === 'structure')?.passed).toBe(true);
    expect(report.checks.find(check => check.key === 'evidence')?.passed).toBe(false);
  });

  it('无 checks 时满分兜底（chapters 为空）', () => {
    expect(buildChapterCoverageReports({ chapters: [], templateChapters: [], factsModel: EMPTY_FACTS_MODEL })).toEqual([]);
  });
});

describe('chapterCoverageIssues', () => {
  it('score < 80 的章节产出 warning 并列出未通过项', () => {
    const reports = [
      { chapterId: 'c1', title: '施工部署', score: 71, action: '补齐。', checks: [{ key: 'depth', label: '内容深度', passed: false }, { key: 'structure', label: '结构完整', passed: true }] },
      { chapterId: 'c2', title: '工程概况', score: 86, action: '', checks: [] },
    ];
    const issues = chapterCoverageIssues(reports);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].message).toContain('施工部署 71%');
    expect(issues[0].suggestion).toContain('内容深度');
    expect(issues[0].suggestion).not.toContain('结构完整');
  });
});
