import { describe, expect, it } from 'vitest';
import { applyScopeConflictResolutions, detectNumericScopeConflicts } from '../src/services/document-workflow/factGovernance';
import type { DocumentFact } from '../src/services/document-workflow/types';

function fact(key: string, value: string, sourceFile: string, roleId = 'local'): DocumentFact {
  return { key, value, sourceFile, roleId, confidence: 1 };
}

describe('detectNumericScopeConflicts', () => {
  it('跨文件同口径建设规模冲突：补疑优先级最高，裁决为补疑值', () => {
    const facts = [
      fact('project_scale_1', '建设规模：总建筑面积约4645㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：总建筑面积约4646㎡', '徽光阁项目施工补疑1.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const conflict = conflicts.find(item => item.kind === 'area');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('4646㎡');
    expect(conflict!.values.map(value => `${value.value}${value.unit}`)).toContain('4645㎡');
  });

  it('同文件内不同数值不判冲突（分层口径隔离）', () => {
    const facts = [
      fact('project_scale_1', '总建筑面积4646㎡；地上建筑面积3200㎡', '招标文件.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const conflict = conflicts.find(item => item.kind === 'area');
    expect(conflict).toBeUndefined();
  });

  it('同一口径无跨文件差异时不产生裁决', () => {
    const facts = [
      fact('project_scale_1', '建设规模：总建筑面积约4646㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：总建筑面积约4646㎡', '图纸.pdf'),
    ];
    expect(detectNumericScopeConflicts(facts)).toEqual([]);
  });
});

describe('applyScopeConflictResolutions', () => {
  it('面积类事实败选值回写为裁决值', () => {
    const facts = [
      fact('project_scale_1', '建设规模：总建筑面积约4645㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：总建筑面积约4646㎡', '徽光阁项目施工补疑1.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const resolved = applyScopeConflictResolutions(facts, conflicts);
    const scale = resolved.find(item => item.key === 'project_scale_1');
    expect(scale!.value).toBe('建设规模：总建筑面积约4646㎡');
  });

  it('无裁决时原样返回', () => {
    const facts = [fact('project_scale_1', '建设规模：总建筑面积约4646㎡', '招标文件.pdf')];
    const resolved = applyScopeConflictResolutions(facts, detectNumericScopeConflicts(facts));
    expect(resolved).toBe(facts);
  });

  it('非相关字段不受裁决影响', () => {
    const facts = [
      fact('project_scale_1', '建设规模：总建筑面积约4645㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：总建筑面积约4646㎡', '徽光阁项目施工补疑1.pdf'),
      fact('schedule_1', '计划工期45日历天', '招标文件.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const resolved = applyScopeConflictResolutions(facts, conflicts);
    expect(resolved.find(item => item.key === 'schedule_1')!.value).toBe('计划工期45日历天');
  });
});

describe('补疑优先与源头裁决（回归：无“总”字前缀 + 单位保留）', () => {
  it('招标正文“建筑面积约为4645㎡”（无“总”字前缀）与补疑4646㎡冲突时裁决补疑', () => {
    const facts = [
      fact('project_scale_1', '建设规模：建筑面积约为4645㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：建筑面积约为4646㎡', '徽光阁项目施工补疑1.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const conflict = conflicts.find(item => item.kind === 'area');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('4646㎡');
    expect(conflict!.values.map(value => `${value.value}${value.unit}`)).toContain('4645㎡');
  });

  it('败选数值回写保留败选单位：4645平方米 → 4646平方米', () => {
    const facts = [
      fact('project_scale_1', '建设规模：建筑面积约4645平方米', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：建筑面积约4646㎡', '徽光阁项目施工补疑1.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const resolved = applyScopeConflictResolutions(facts, conflicts);
    expect(resolved.find(item => item.key === 'project_scale_1')!.value).toBe('建设规模：建筑面积约4646平方米');
  });
});
