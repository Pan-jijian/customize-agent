/**
 * documentQualityPipeline 单测：问题收集（修复问题签名数字归一化）。全纯逻辑。
 */
import { describe, expect, it } from 'vitest';
import {
  collectValidationIssueGroups, repairIssueSignature,
} from '@/services/document-workflow/documentQualityPipeline';
import type { ValidationIssue } from '@/services/document-workflow/types';

function issue(overrides: Partial<ValidationIssue>): ValidationIssue {
  return { level: 'warning', message: '问题消息', suggestion: '建议', ...overrides };
}

describe('collectValidationIssueGroups', () => {
  it('多组扁平合并', () => {
    const a: ValidationIssue[] = [issue({ message: 'a' })];
    const b: ValidationIssue[] = [issue({ message: 'b' }), issue({ message: 'c' })];
    expect(collectValidationIssueGroups(a, [], b)).toHaveLength(3);
  });
});

describe('repairIssueSignature', () => {
  it('提取「问题：」后的正文并归一数字', () => {
    expect(repairIssueSignature('修复任务\n问题：总工期 600 天与 45 天不一致\n其他')).toBe('总工期#天与#天不一致');
  });

  it('无「问题：」前缀时用整串，支持直接传 issue 对象', () => {
    expect(repairIssueSignature(issue({ message: '总工期 600 天不一致' }))).toBe('总工期#天不一致');
  });
});
