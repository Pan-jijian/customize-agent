/**
 * 新检测器对旧问题文档（4.12.18 生成、青天 73.1 分）的有效性验证（manual，不入 vitest 常规集）。
 * 运行：npx vitest run apps/server/test/verify-new-detectors.manual.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { crossSectionNumericConflictIssues, duplicateParagraphIssues, duplicateTableIssues, resourceConsistencyIssues, resourceTriadSectionHierarchyIssues } from '../src/services/document-workflow/documentIntegrityChecks';

const markdown = readFileSync('/tmp/old-doc-4.12.18.md', 'utf8');

describe('新检测器对旧问题文档的有效性（4.12.18 青天 73.1 分样本）', () => {
  it('resourceTriadSectionHierarchyIssues 命中第五章层级错位（材/机挂在 5.1 下）', () => {
    const issues = resourceTriadSectionHierarchyIssues(markdown);
    console.log('[triad]', issues.map(issue => issue.message).join('\n'));
    expect(issues.some(issue => /层级错位/u.test(issue.message))).toBe(true);
  });

  it('duplicateTableIssues 命中青天报告的重复表格（机械表/危大闭环表/劳动力表）', () => {
    const issues = duplicateTableIssues(markdown);
    console.log('[tables]', issues.map(issue => issue.message.slice(0, 110)).join('\n'));
    // 旧文档 python 分析：5 组真重复（机械表连排缺分隔行、危大闭环管控表两张、劳动力计划表两组、保护对象表 100% 重合）
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });

  it('duplicateParagraphIssues 零命中（旧文档无完全相等长段落，青天报告仅报表格重复）', () => {
    const issues = duplicateParagraphIssues(markdown);
    console.log('[paras] count=', issues.length);
    expect(issues).toEqual([]);
  });

  it('crossSectionNumericConflictIssues 命中已知设备数量矛盾（塔吊 2vs1 等）', () => {
    const issues = crossSectionNumericConflictIssues(markdown);
    console.log('[devices]', issues.map(issue => issue.message.slice(0, 120)).join('\n'));
    expect(issues.some(issue => /塔式起重机|升降机|汽车吊|切断机|弯曲机|圆盘锯/u.test(issue.message))).toBe(true);
  });

  it('resourceConsistencyIssues 命中已知劳动力 220 vs 120 矛盾', () => {
    const issues = resourceConsistencyIssues(markdown);
    console.log('[labor]', issues.map(issue => issue.message.slice(0, 120)).join('\n'));
    expect(issues.some(issue => /劳动力数据矛盾/u.test(issue.message))).toBe(true);
  });
});
