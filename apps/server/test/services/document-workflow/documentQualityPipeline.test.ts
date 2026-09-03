/**
 * documentQualityPipeline 单测：问题收集/去重（数字归一化 + 严重度保级 + 建议补全）、
 * 修复任务包构建、未解决任务追踪与 ResolutionLedger 停滞检测。全纯逻辑。
 */
import { describe, expect, it } from 'vitest';
import {
  buildRepairTaskMessage, collectMessageGroups, collectValidationIssueGroups, dedupeValidationIssues,
  repairIssueSignature, ResolutionLedger, unresolvedRepairTasks,
} from '@/services/document-workflow/documentQualityPipeline';
import type { ValidationIssue } from '@/services/document-workflow/types';

function issue(overrides: Partial<ValidationIssue>): ValidationIssue {
  return { level: 'warning', message: '问题消息', suggestion: '建议', ...overrides };
}

describe('collectValidationIssueGroups / collectMessageGroups', () => {
  it('多组扁平合并', () => {
    const a: ValidationIssue[] = [issue({ message: 'a' })];
    const b: ValidationIssue[] = [issue({ message: 'b' }), issue({ message: 'c' })];
    expect(collectValidationIssueGroups(a, [], b)).toHaveLength(3);
    expect(collectMessageGroups(['x'], ['y'], [])).toEqual(['x', 'y']);
  });
});

describe('dedupeValidationIssues', () => {
  it('数字归一化去重：同模板不同数值视为同一问题', () => {
    const result = dedupeValidationIssues([
      issue({ message: '总工期 600 日历天与 45 日历天不一致', suggestion: '' }),
      issue({ message: '总工期 300 日历天与 20 日历天不一致', suggestion: '' }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('同签名保留更高严重度', () => {
    const result = dedupeValidationIssues([
      issue({ level: 'info', message: '总工期 600 天不一致', suggestion: '' }),
      issue({ level: 'error', message: '总工期 300 天不一致', suggestion: '' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe('error');
  });

  it('同签名同级别时补齐缺失的 suggestion', () => {
    const result = dedupeValidationIssues([
      issue({ level: 'warning', message: '总工期 600 天不一致', suggestion: '' }),
      issue({ level: 'warning', message: '总工期 300 天不一致', suggestion: '统一以招标文件为准' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].suggestion).toBe('统一以招标文件为准');
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

describe('buildRepairTaskMessage', () => {
  it('修复类型分类：跨章一致性/泛化套话/专业缺口/结构/默认', () => {
    expect(buildRepairTaskMessage(issue({ message: '跨章一致性：总工期前后不一致', suggestion: '' }))).toContain('修复类型：跨章一致性修复');
    expect(buildRepairTaskMessage(issue({ message: '正文存在泛化套话', suggestion: '' }))).toContain('修复类型：泛化内容替换');
    expect(buildRepairTaskMessage(issue({ message: '质量章节缺少专业内容', suggestion: '' }))).toContain('修复类型：专业缺口补写');
    expect(buildRepairTaskMessage(issue({ message: '小节结构缺失', suggestion: '' }))).toContain('修复类型：结构完整性修复');
    expect(buildRepairTaskMessage(issue({ message: '其他问题', suggestion: '' }))).toContain('修复类型：质量问题修复');
  });

  it('修复对象取消息冒号前段，无冒号时用全文', () => {
    expect(buildRepairTaskMessage(issue({ message: '工程概况：缺少建设规模', suggestion: '' }))).toContain('修复对象：工程概况');
    expect(buildRepairTaskMessage(issue({ message: '无冒号消息', suggestion: '' }))).toContain('修复对象：全文');
  });

  it('含建议时输出要求行', () => {
    const message = buildRepairTaskMessage(issue({ message: '问题', suggestion: '补充参数' }));
    expect(message).toContain('要求：补充参数');
    expect(message).toContain('【修复任务包】');
    expect(message).toContain('输出要求：只改正文内容');
  });
});

describe('unresolvedRepairTasks', () => {
  it('仅保留修复后仍在的问题，warning 标软问题复核、error 标硬问题升级', () => {
    const before = [
      issue({ level: 'warning', message: '总工期 600 天不一致', suggestion: '' }),
      issue({ level: 'error', message: '质量目标缺失', suggestion: '' }),
      issue({ message: '已修复的问题', suggestion: '' }),
    ];
    const after = [
      issue({ level: 'warning', message: '总工期 300 天不一致', suggestion: '' }),
      issue({ level: 'error', message: '质量目标缺失', suggestion: '' }),
    ];
    const tasks = unresolvedRepairTasks(before, after);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toContain('软问题复核-小节/章节重写');
    expect(tasks[1]).toContain('硬问题升级-小节/章节重写');
  });
});

describe('ResolutionLedger', () => {
  it('标记/查询解决状态（数字归一化签名）', () => {
    const ledger = new ResolutionLedger();
    expect(ledger.isResolved('总工期 600 天不一致')).toBe(false);
    ledger.markResolved('总工期 300 天不一致');
    expect(ledger.isResolved('总工期 600 天不一致')).toBe(true);
    expect(ledger.resolvedCount()).toBe(1);
  });

  it('pending 过滤未解决问题并暴露签名集合', () => {
    const ledger = new ResolutionLedger();
    ledger.markResolved('问题A');
    const rest = ledger.pending(['问题A', '问题B', '问题C']);
    expect(rest).toEqual(['问题B', '问题C']);
    expect(ledger.pendingSignatures().has('问题A')).toBe(true);
  });

  it('连续 2 轮无进展触发停滞信号，有进展即重置', () => {
    const ledger = new ResolutionLedger();
    expect(ledger.markRound(true)).toBe(false);
    expect(ledger.markRound(false)).toBe(false);
    expect(ledger.markRound(false)).toBe(true);
    expect(ledger.markRound(true)).toBe(false);
  });
});
