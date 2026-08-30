/**
 * chapterReadinessService 纯函数单测：
 * evaluateChapterReadiness（章节规则匹配/事实名映射/去重/覆盖与缺失划分）
 * 与 chapterReadinessIssues（无证据 error / 缺事实 warning 且最多罗列 6 个）。
 */
import { describe, expect, it } from 'vitest';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { DocumentDraftChapter, DocumentEvidence } from '../document-workflow/types';
import { chapterReadinessIssues, evaluateChapterReadiness } from './chapterReadinessService';

function makeSpec(partial: Partial<AutoDocumentSpecPackage> = {}): AutoDocumentSpecPackage {
  return {
    id: 'spec-1',
    name: '测试规范包',
    description: '',
    factFields: [
      { id: 'f-area', name: '总建筑面积', type: 'auto', required: true },
      { id: 'f-schedule', name: '周期要求', type: 'auto', required: true },
      { id: 'f-quality', name: '质量要求', type: 'auto', required: false },
    ],
    chapterMode: 'fixed',
    chapterRules: [
      { id: 'ch1', title: '工程概况', required: true, order: 0, requiredFactIds: ['f-area'] },
      { id: 'ch2', title: '施工进度计划', required: true, order: 1, requiredFactIds: ['f-schedule'] },
      { id: 'ch3', title: '质量管理措施', required: true, order: 2 },
    ],
    dynamicChapterRule: { source: 'ai_plan', minChapters: 0, maxChapters: 0 },
    gateRules: [],
    ...partial,
  };
}

function makeChapter(partial: Partial<DocumentDraftChapter>): DocumentDraftChapter {
  return {
    id: 'ch1',
    title: '工程概况',
    content: '正文内容',
    evidence: [],
    missingFacts: [],
    ...partial,
  };
}

function makeEvidence(count: number): DocumentEvidence[] {
  return Array.from({ length: count }, (_, index) => ({
    chapterId: 'ch1',
    filePath: `材料${index}.pdf`,
    score: 0.8,
    content: '',
  }));
}

describe('evaluateChapterReadiness 规则与事实映射', () => {
  it('按 chapter id 匹配规则并映射事实名', () => {
    const chapters = [makeChapter({ id: 'ch1', title: '工程概况' })];
    const result = evaluateChapterReadiness(chapters, makeSpec());
    expect(result).toHaveLength(1);
    expect(result[0]!.requiredFacts).toEqual(['总建筑面积']);
    // 章节未报告任何缺失 → missingFacts 为空、全部视为已覆盖
    expect(result[0]!.missingFacts).toEqual([]);
    expect(result[0]!.coveredFacts).toEqual(['总建筑面积']);
  });

  it('按标题匹配规则（id 不匹配时）', () => {
    const chapters = [makeChapter({ id: 'unknown', title: '施工进度计划' })];
    const result = evaluateChapterReadiness(chapters, makeSpec());
    expect(result[0]!.requiredFacts).toEqual(['周期要求']);
  });

  it('无规则命中时 requiredFacts 仅含章节自身缺失事实', () => {
    const chapters = [makeChapter({ id: 'ghost', title: '附录章节', missingFacts: ['合同条款'] })];
    const result = evaluateChapterReadiness(chapters, makeSpec());
    expect(result[0]!.requiredFacts).toEqual(['合同条款']);
  });

  it('章节 missingFacts 与规则事实合并去重', () => {
    const chapters = [makeChapter({ id: 'ch1', title: '工程概况', missingFacts: ['总建筑面积', '总建筑面积', '额外事实'] })];
    const result = evaluateChapterReadiness(chapters, makeSpec());
    expect(result[0]!.requiredFacts).toEqual(['总建筑面积', '额外事实']);
  });

  it('coveredFacts 与 missingFacts 按章节自身缺失划分', () => {
    const chapters = [makeChapter({ id: 'ch1', title: '工程概况', missingFacts: ['额外事实'] })];
    const result = evaluateChapterReadiness(chapters, makeSpec());
    // requiredFacts = [额外事实, 总建筑面积]；仅 额外事实 在 missingFacts 中
    expect(result[0]!.coveredFacts).toEqual(['总建筑面积']);
    expect(result[0]!.missingFacts).toEqual(['额外事实']);
  });

  it('evidenceCount 取章节证据数量', () => {
    const chapters = [makeChapter({ id: 'ch1', title: '工程概况', evidence: makeEvidence(3) })];
    expect(evaluateChapterReadiness(chapters, makeSpec())[0]!.evidenceCount).toBe(3);
  });

  it('规则引用了不存在的 factId 时静默忽略', () => {
    const spec = makeSpec({
      chapterRules: [{ id: 'ch1', title: '工程概况', required: true, order: 0, requiredFactIds: ['ghost-fact'] }],
    });
    const result = evaluateChapterReadiness([makeChapter({ id: 'ch1', title: '工程概况' })], spec);
    expect(result[0]!.requiredFacts).toEqual([]);
  });

  it('多章节逐一评估', () => {
    const chapters = [
      makeChapter({ id: 'ch1', title: '工程概况' }),
      makeChapter({ id: 'ch2', title: '施工进度计划' }),
    ];
    const result = evaluateChapterReadiness(chapters, makeSpec());
    expect(result).toHaveLength(2);
    expect(result[0]!.requiredFacts).toEqual(['总建筑面积']);
    expect(result[1]!.requiredFacts).toEqual(['周期要求']);
  });

  it('空章节列表安全', () => {
    expect(evaluateChapterReadiness([], makeSpec())).toEqual([]);
  });
});

describe('chapterReadinessIssues 问题分级', () => {
  it('无证据章节 → error', () => {
    const readiness = [{ chapterId: 'ch1', title: '工程概况', requiredFacts: ['总建筑面积'], coveredFacts: [], missingFacts: [], evidenceCount: 0 }];
    const issues = chapterReadinessIssues(readiness);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('error');
    expect(issues[0]!.message).toContain('工程概况');
  });

  it('有证据但缺事实 → warning', () => {
    const readiness = [{ chapterId: 'ch1', title: '工程概况', requiredFacts: ['a', 'b'], coveredFacts: [], missingFacts: ['a', 'b'], evidenceCount: 2 }];
    const issues = chapterReadinessIssues(readiness);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('warning');
    expect(issues[0]!.message).toContain('a');
    expect(issues[0]!.message).toContain('b');
  });

  it('缺失事实罗列上限 6 个', () => {
    const missing = Array.from({ length: 9 }, (_, index) => `事实${index}`);
    const readiness = [{ chapterId: 'ch1', title: '工程概况', requiredFacts: missing, coveredFacts: [], missingFacts: missing, evidenceCount: 2 }];
    const issues = chapterReadinessIssues(readiness);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).not.toContain('事实6');
    expect(issues[0]!.message).not.toContain('事实8');
    expect(issues[0]!.message).toContain('事实5');
  });

  it('证据与事实都满足 → 无 issue', () => {
    const readiness = [{ chapterId: 'ch1', title: '工程概况', requiredFacts: ['总建筑面积'], coveredFacts: ['总建筑面积'], missingFacts: [], evidenceCount: 1 }];
    expect(chapterReadinessIssues(readiness)).toEqual([]);
  });

  it('空 readiness 安全', () => {
    expect(chapterReadinessIssues([])).toEqual([]);
  });
});
