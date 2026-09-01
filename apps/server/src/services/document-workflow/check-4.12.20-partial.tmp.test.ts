/** 4.12.20 生成中内容质量检查（5 章 checkpoint），临时脚本用完即删 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  crossSectionNumericConflictIssues,
  duplicateParagraphIssues,
  duplicateTableIssues,
  nodeScheduleConsistencyIssues,
  resourceConsistencyIssues,
  resourceTriadSectionHierarchyIssues,
} from './documentIntegrityChecks';

const md = readFileSync('/tmp/new-doc-4.12.20-partial.md', 'utf8');

describe('4.12.20 部分生成（5 章）质量检查', () => {
  it('全检测器扫描', () => {
    console.log('[tables]', duplicateTableIssues(md).map(i => i.message.slice(0, 120)).join('\n') || '零命中');
    console.log('[paras]', duplicateParagraphIssues(md).map(i => i.message.slice(0, 120)).join('\n') || '零命中');
    console.log('[devices]', crossSectionNumericConflictIssues(md).map(i => i.message.slice(0, 120)).join('\n') || '零命中');
    console.log('[labor]', resourceConsistencyIssues(md).map(i => i.message.slice(0, 120)).join('\n') || '零命中');
    console.log('[triad]', resourceTriadSectionHierarchyIssues(md).map(i => i.message.slice(0, 120)).join('\n') || '零命中');
    console.log('[schedule]', nodeScheduleConsistencyIssues(md).map(i => i.message.slice(0, 120)).join('\n') || '零命中');
    expect(true).toBe(true);
  });
});
