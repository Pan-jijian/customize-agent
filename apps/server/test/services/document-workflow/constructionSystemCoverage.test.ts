/**
 * constructionSystemCoverage 单测（C3）：招标范围工程系统零覆盖检测——
 * 义务仅来自章节标题，正文词面零命中即报零覆盖。
 */
import { describe, expect, it } from 'vitest';
import { constructionSystemCoverageIssues } from '@/services/document-workflow/constructionSystemCoverage';
import type { DocumentDraftChapter } from '@/services/document-workflow/types';

function makeChapter(overrides: Partial<DocumentDraftChapter> = {}): DocumentDraftChapter {
  return { id: 'c1', title: '施工部署', content: '', evidence: [], missingFacts: [], ...overrides };
}

describe('constructionSystemCoverageIssues', () => {
  it('章节标题无工程系统名 → 不制造义务', () => {
    expect(constructionSystemCoverageIssues([makeChapter({ title: '工程概况' })])).toEqual([]);
    expect(constructionSystemCoverageIssues([])).toEqual([]);
  });

  it('标题含系统名且正文覆盖 → 不告警', () => {
    const chapters = [makeChapter({ title: '电梯工程施工方案', content: '本工程电梯安装施工流程如下，电梯井道防护先行。' })];
    expect(constructionSystemCoverageIssues(chapters)).toEqual([]);
  });

  it('标题含系统名但正文零覆盖 → error + F2 章节锚点', () => {
    const chapters = [
      makeChapter({ id: 'c1', title: '电梯工程施工方案', content: '本章仅描述总体部署，无系统细节。' }),
      makeChapter({ id: 'c2', title: '幕墙工程概况', content: '幕墙龙骨采用铝合金型材。' }),
    ];
    const issues = constructionSystemCoverageIssues(chapters);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('error');
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].category).toBe('structure');
    expect(issues[0].repairability).toBe('llm_repairable');
    expect(issues[0].message).toContain('电梯');
    expect(issues[0].message).not.toContain('幕墙');
    expect(issues[0].chapterId).toBe('c1');
  });

  it('跨章正文命中亦算覆盖（覆盖判定不限定义务章）', () => {
    const chapters = [
      makeChapter({ id: 'c1', title: '电梯工程施工方案', content: '' }),
      makeChapter({ id: 'c2', title: '其他章节', content: '电梯井道安装与调试详见专项方案。' }),
    ];
    expect(constructionSystemCoverageIssues(chapters)).toEqual([]);
  });

  it('多系统义务只报零覆盖项并去重', () => {
    const chapters = [
      makeChapter({ id: 'c1', title: '消防工程与给排水工程施工方案', content: '消防工程包含消火栓系统与喷淋系统。' }),
    ];
    const issues = constructionSystemCoverageIssues(chapters);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('给排水');
    expect(issues[0].message).not.toContain('消防');
  });
});
