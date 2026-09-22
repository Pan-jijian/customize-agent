/**
 * 零图口径守卫（4.55.25 用户口径）：
 * 正文**只出表**——不得出现图题、图号、图片引用；原文里"要求出图"的条目一律按数据表落实，
 * 无对应数据即该项要求落空（报出，不用裸图题/占位撑着）。
 */
import { describe, expect, it } from 'vitest';
import { figureSubstituteTableIssues } from '@/services/document-workflow/documentIntegrityChecks';

describe('figureSubstituteTableIssues（零图口径）', () => {
  it('编号图题残留 → blocker（正文不得出现图题/图号）', () => {
    const md = ['## 第十章 施工总平面布置图', '', '图10-1 施工总平面布置图', '', '| 设施 | 面积（平方米） | 位置 |', '| --- | --- | --- |', '| 钢筋加工区 | 800 | 场地东侧 |'].join('\n');
    const issues = figureSubstituteTableIssues(md, []);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('零图口径违规'))).toBe(true);
  });

  it('裸图题残留 → blocker', () => {
    const md = '## 第十章 施工总平面布置图\n\n图 施工总平面布置图\n\n正文说明。';
    expect(figureSubstituteTableIssues(md, []).some(issue => issue.severity === 'blocker')).toBe(true);
  });

  it('图片引用残留 → blocker', () => {
    const md = '## 第十章 施工总平面布置图\n\n![施工总平面布置图](generatedDocuments/assets/fig-x.svg)\n\n正文说明。';
    expect(figureSubstituteTableIssues(md, []).some(issue => issue.severity === 'blocker')).toBe(true);
  });

  it('以「图」开头的正文词不误伤（图纸设计说明等）', () => {
    const md = '## 第一章 工程概况\n\n图纸设计说明如下：基础采用独立基础，垫层C15混凝土。';
    expect(figureSubstituteTableIssues(md, [])).toEqual([]);
  });

  it('图类要求已由数据表落实 → 不报；未落实 → warning（该项要求落空）', () => {
    const withTable = ['## 第八章 确保工期的技术组织措施', '', '| 施工阶段 | 起止天数 | 关键节点 |', '| --- | --- | --- |', '| 基础 | 1-30 | 验槽 |'].join('\n');
    expect(figureSubstituteTableIssues(withTable, [{ chapterTitle: '确保工期的技术组织措施', name: '施工进度计划横道图' }])).toEqual([]);
    const withoutTable = '## 第八章 确保工期的技术组织措施\n\n本节按总工期倒排各阶段工序，确保节点兑现。';
    const issues = figureSubstituteTableIssues(withoutTable, [{ chapterTitle: '确保工期的技术组织措施', name: '施工进度计划横道图' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('未以数据表落实');
    expect(issues[0]!.message).toContain('进度计划横道图');
    expect(issues[0]!.suggestion).toContain('进度计划表');
  });

  it('无图类要求 → 不参与判定', () => {
    expect(figureSubstituteTableIssues('任意正文', [])).toHaveLength(0);
  });
});
