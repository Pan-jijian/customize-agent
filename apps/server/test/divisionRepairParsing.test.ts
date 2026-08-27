import { describe, expect, it } from 'vitest';
import { isRepairedSectionIssue, parseFinalGateRepairCandidate } from '../src/services/document-workflow/documentPipeline';
import type { ValidationIssue } from '../src/services/document-workflow/types';

function issue(message: string): ValidationIssue {
  return { level: 'error', severity: 'blocker', message };
}

describe('分部分项 blocker 修复循环解析（parseFinalGateRepairCandidate）', () => {
  const CHAPTER = '第二章 确保工期与质量的保障体系与措施、确保安全生产的管理体系与措施';

  it('“分项不足”消息解析为分部分项标准小节', () => {
    const parsed = parseFinalGateRepairCandidate(issue(`${CHAPTER} 分部分项工程施工方案分项不足：当前 0 个，要求不少于 3 个`));
    expect(parsed?.sectionTitle).toBe('主要分部分项工程施工方案');
    expect(parsed?.critical).toBe(true);
    expect(parsed?.chapterTitle).toBe(CHAPTER);
  });

  it('“缺少施工概况/工艺流程/施工方法”消息同样可解析', () => {
    const parsed = parseFinalGateRepairCandidate(issue(`${CHAPTER} 分部分项工程施工方案存在 2 个分项方案缺少施工概况/工艺流程/施工方法`));
    expect(parsed?.sectionTitle).toBe('主要分部分项工程施工方案');
  });

  it('“正文过短”消息可解析进入修复循环', () => {
    const parsed = parseFinalGateRepairCandidate(issue(`${CHAPTER} 分部分项工程施工方案存在 1 个分项方案正文过短（少于 150 字）`));
    expect(parsed?.sectionTitle).toBe('主要分部分项工程施工方案');
  });

  it('isRepairedSectionIssue 识别分部分项消息形态（修复后旧快照过滤）', () => {
    expect(isRepairedSectionIssue(`${CHAPTER} 分部分项工程施工方案分项不足：当前 0 个，要求不少于 3 个`, CHAPTER, '主要分部分项工程施工方案')).toBe(true);
  });

  it('非结构缺陷消息不误解析', () => {
    expect(parseFinalGateRepairCandidate(issue('部分章节生成失败'))).toBeUndefined();
  });
});
